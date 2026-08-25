// The sanctioned daily abandoned-journal sweep (log-hygiene spec section 9;
// operator decision 2026-08-24). Finds ACTIVE resolve# journals whose lease
// expired and whose claim is older than 24h, and drives them through the
// EXISTING recoverAbandoned machinery - which COMMITS the abandoned human
// decision (contact/phone writes, permanent dism# tombstones, audit rows
// backdated to claimedAt) and then scrubs the PII snapshot. Enumeration is
// a cursor-resumed bounded Scan: resolve# rows are deliberately in NO GSI
// (indexing them would copy their PII snapshot into a projection-ALL index),
// so a Scan is the only enumeration - once daily, pages bounded, cursor
// persisted so caps DEFER work rather than orphaning it.
//
// CURSOR POLICY: the cursor ALWAYS advances past pages the run has read; it
// never rewinds (a rewind livelocks on a page of persistently-failing
// contacts). Qualifying rows dropped because the contact cap filled mid-page
// are re-found when the cursor WRAPS - it is cleared on exhaustion, so the
// next cycle rescans from the start - a bounded delay of at most one full
// cursor cycle, never a livelock and never permanent orphaning; persistently
// failing contacts are separately alarmed by the truth check's ERROR.
//
// DRAIN MODEL, stated: DynamoDB `Limit` bounds rows EVALUATED per page (RCU),
// not matches - a page of 200 mostly-tombstone rows can contribute zero
// journals - so the 25-contacts-per-day rate of spec 9.1 is a CAP, and the
// real drain rate is min(cap, qualifying rows the cursor passes per run). One
// run examines at most MAX_SCAN_PAGES * SCAN_PAGE_LIMIT = 4,000 rows, so a
// full cursor cycle takes ceil(tableRows/4000) daily runs - and "never
// permanent orphaning" holds only while the table grows slower than 4,000
// rows/day (comfortably true at this product's scale; if ai_extraction is ever
// 100k+ rows the caps need raising).
//
// TWO ACCEPTED RESIDUALS: (a) the cursor is persisted BEFORE the recovery
// loop, so a mid-run crash advances past contacts this run never recovered -
// they remain ACTIVE rows and the wrap revisits them (same bounded delay);
// (b) a PERMANENTLY failing cadence claim (missing settings table, IAM
// regression) leaves the duty parked at one WARN per 30s poll with no ERROR -
// loud in the logs, not in the alarm; acceptable because a broken settings
// table alarms through every other consumer of it.
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { appEvents, type EventBus } from '../lib/events.js';
import {
  createSettingsRepo,
  JOURNAL_SWEEP_LAST_RUN_AT_ID,
  type SettingsRepo,
} from '../repos/settingsRepo.js';
import {
  createSuggestionResolutionRepo,
  type SuggestionResolutionRepo,
} from '../repos/suggestionResolutionRepo.js';
import { createContactsRepo } from '../repos/contactsRepo.js';
import { createExtractionRepo } from '../repos/extractionRepo.js';
import { createAiRunsRepo } from '../repos/aiRunsRepo.js';
import {
  createSuggestionResolutionService,
  type SuggestionResolutionService,
} from '../services/suggestionResolution.js';

export const JOURNAL_SWEEP_PERIOD_MS = 24 * 60 * 60 * 1000;
export const JOURNAL_SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_CONTACTS_PER_RUN = 25;
export const MAX_RECOVERY_CALLS_PER_RUN = 100;
export const MAX_SCAN_PAGES = 20;
export const SCAN_PAGE_LIMIT = 200;
/** The closed DECISION_TARGETS key-set size - one recovery call can attempt
 *  every target, so a poison pair cannot starve the rest. */
export const SWEEP_MAX_ATTEMPTS_PER_CALL = 12;

export interface JournalSweepDeps {
  settingsRepo?: Pick<SettingsRepo, 'claimGroupPeriod' | 'getJournalSweepCursor' | 'putJournalSweepCursor'>;
  resolutionRepo?: Pick<SuggestionResolutionRepo, 'listActiveResolutionRows' | 'listJournals'>;
  resolutionService?: Pick<SuggestionResolutionService, 'recoverAbandoned'>;
  events?: EventBus;
  logger?: Logger;
}

export interface JournalSweepOutcome {
  ran: boolean;
  contactsVisited: number;
  recovered: number;
  deferred: boolean;
  persistentContacts: number;
}

function buildDefaultService(log: Logger): SuggestionResolutionService {
  // The exact construction routes/suggestions.ts uses (its factory needs
  // all four repos; the seams default). NOTE createContactsRepo comes from
  // a C1-mission file - IMPORTING is fine (edits are what is forbidden);
  // at the Task 14 merge reconcile, verify its factory signature survived
  // the C1 merge unchanged.
  return createSuggestionResolutionService({
    contactsRepo: createContactsRepo({ logger: log }),
    extractionRepo: createExtractionRepo({ logger: log }),
    aiRunsRepo: createAiRunsRepo({ logger: log }),
    resolutionRepo: createSuggestionResolutionRepo({ logger: log }),
    logger: log,
  });
}

export async function runJournalSweep(
  nowIso: string,
  deps: JournalSweepDeps = {},
  opts: { force?: boolean } = {},
): Promise<JournalSweepOutcome> {
  const log = deps.logger ?? defaultLogger;
  const outcome: JournalSweepOutcome = { ran: false, contactsVisited: 0, recovered: 0, deferred: false, persistentContacts: 0 };
  const settings = deps.settingsRepo ?? createSettingsRepo({ logger: log });
  const now = new Date(nowIso).toISOString();
  const nowMs = Date.parse(now);
  // The claim gets its OWN catch at WARN: a DynamoDB blip on the claim is
  // transient (the next 30s poll retries) and must not feed the error
  // alarm - the poll loop would otherwise log the rejection at error level
  // every tick. The loud ERROR below is reserved for a claimed-then-failed
  // run, whose retry really is a day away.
  const notBefore = opts.force === true ? now : new Date(nowMs - JOURNAL_SWEEP_PERIOD_MS).toISOString();
  try {
    if (!(await settings.claimGroupPeriod(JOURNAL_SWEEP_LAST_RUN_AT_ID, now, notBefore))) return outcome;
  } catch (err) {
    log.warn({ err }, 'journal sweep: cadence claim failed (transient) - next poll retries');
    return outcome;
  }
  outcome.ran = true;
  try {
    const repo = deps.resolutionRepo ?? createSuggestionResolutionRepo({ logger: log });
    const service = deps.resolutionService ?? buildDefaultService(log);
    const events = deps.events ?? appEvents;

    // Enumerate: cursor-resumed pages, APP-SIDE age gate (a server-side
    // FilterExpression could never see an excluded row, so fail-toward-scrub
    // would be unimplementable, and a non-ISO claimedAt would be decided by
    // ASCII ordering).
    const qualifies = (row: { leaseExpiresAt: string; claimedAt: string }): boolean => {
      if (Date.parse(row.leaseExpiresAt) > nowMs) return false; // live lease
      const claimedMs = Date.parse(row.claimedAt);
      // Unparseable -> NaN -> comparison false -> QUALIFIES (fail-toward-scrub).
      return !(Number.isFinite(claimedMs) && nowMs - claimedMs < JOURNAL_SWEEP_MIN_AGE_MS);
    };
    const contacts: string[] = [];
    const seen = new Set<string>();
    let cursor = await settings.getJournalSweepCursor();
    let pages = 0;
    let exhausted = false;
    let droppedQualifying = false;
    // The cursor ALWAYS advances past pages this run has read - never a
    // rewind (a rewind livelocks on a page of persistently-failing
    // contacts). Rows dropped because the cap filled are re-found when the
    // cursor wraps: bounded delay, no orphaning. Stop reading once the cap
    // fills - no read capacity burned collecting nothing.
    while (pages < MAX_SCAN_PAGES && contacts.length < MAX_CONTACTS_PER_RUN) {
      const page = await repo.listActiveResolutionRows({ ...(cursor !== undefined && { cursor }), limit: SCAN_PAGE_LIMIT });
      pages += 1;
      for (const row of page.rows) {
        if (!qualifies(row)) continue;
        if (seen.has(row.contactId)) continue;
        if (contacts.length >= MAX_CONTACTS_PER_RUN) { droppedQualifying = true; continue; }
        seen.add(row.contactId);
        contacts.push(row.contactId);
      }
      cursor = page.nextCursor;
      if (cursor === undefined) { exhausted = true; break; }
    }
    await settings.putJournalSweepCursor(exhausted ? undefined : cursor);

    let calls = 0;
    let budgetExhausted = false;
    for (const contactId of contacts) {
      if (calls >= MAX_RECOVERY_CALLS_PER_RUN) { budgetExhausted = true; break; }
      outcome.contactsVisited += 1;
      let stateChanged = false;
      let completedCleanly = false;
      for (;;) {
        if (calls >= MAX_RECOVERY_CALLS_PER_RUN) { budgetExhausted = true; break; }
        calls += 1;
        const result = await service.recoverAbandoned(contactId, { maxAttempts: SWEEP_MAX_ATTEMPTS_PER_CALL });
        outcome.recovered += result.recovered;
        stateChanged = stateChanged || result.stateChanged;
        if (result.recovered === 0) { completedCleanly = true; break; }
      }
      if (stateChanged) events.emit('suggestion.updated', { contactId });
      if (!completedCleanly) continue; // budget cut - deferral, not poison
      // POST-LOOP TRUTH CHECK on the contact's closed 12-key journal set.
      // Persistent actives past the gate = poison journals nothing will
      // scrub without attention -> ERROR (alarm). A failed READ here is
      // WARN - loud, not silent, not a false poison alarm.
      try {
        const journals = await repo.listJournals(contactId);
        const remaining = journals.filter(
          (j) => j.state === 'active' && qualifies({ leaseExpiresAt: j.leaseExpiresAt, claimedAt: j.claimedAt }),
        );
        if (remaining.length > 0) {
          outcome.persistentContacts += 1;
          log.error(
            { contactId, remaining: remaining.length },
            'journal sweep: journals still active after recovery - persistent failure, will retry tomorrow',
          );
        }
      } catch (err) {
        log.warn({ err, contactId }, 'journal sweep: truth-check read failed (best-effort)');
      }
    }

    outcome.deferred = !exhausted || budgetExhausted || droppedQualifying;
    if (outcome.deferred) {
      // Routine rate limiting - the cursor carries the progress. INFO, never
      // ERROR: a standing daily alarm nothing can clear is the exact noise
      // class this mission removes.
      log.info(
        { contactsVisited: outcome.contactsVisited, pages, exhausted, budgetExhausted, droppedQualifying },
        'journal sweep: work deferred to the next run (caps/pages)',
      );
    }
    log.info(
      { contactsVisited: outcome.contactsVisited, recovered: outcome.recovered, persistentContacts: outcome.persistentContacts },
      'journal sweep: run complete',
    );
    return outcome;
  } catch (err) {
    // The cadence record is already stamped (claim-first IS the cross-process
    // dedup) - a failure here waits until tomorrow or a force tick. Accepted
    // ON CONDITION it is loud (alarm-feeding).
    log.error({ err }, 'journal sweep: run failed - next natural retry is tomorrow (or a force tick)');
    return outcome;
  }
}
