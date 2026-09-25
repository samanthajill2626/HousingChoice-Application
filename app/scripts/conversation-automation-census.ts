// conversation-automation-census - READ-ONLY census of the per-conversation
// `ai_mode` switch (share-skip-fix spec D1). Counts only: no names, phones or
// bodies are ever logged or reported. Conversation ids ARE reported (the
// breaker list is for the operator to review one by one).
//
// It answers, for one stage:
//   - every conversation row by type and switch state (pointer items excluded,
//     rows with no type reported as their own group);
//   - switched-off rows by cause, in this precedence: group thread (off by
//     design), breaker trip (a `mode_changed` audit event with reason
//     `breaker_trip`, OR the breaker's send counter on the manual row - see
//     hasBreakerSendCounter), imported (the import stamp), other;
//   - the breaker-tripped rows, individually, each with its evidence
//     (`audit_event`, or `send_counter` for a trip whose event is missing);
//   - pending tour-reminder rungs, routed the way the reminder job routes them
//     (jobs/tourReminders.ts resolveReminderTarget): discontinued kinds, tours
//     already started and superseded ladders retire without sending; a
//     non-self_guided tour with a USABLE group goes to the group; everything
//     else goes to the tenant's one-to-one conversation, reported by that
//     conversation's switch state - `oneToOneSwitchedOff` is what the bulk
//     fix script RELEASES (an UPPER BOUND: the job's later gates are not
//     replayed - the quiet-hours deferral, the conversion-claim deferral and
//     stall retire, the pending open-group wait, the tenant-roster retire, and
//     the wrapper's own opt-out / deleted refusals after the claim - each of
//     which can still hold or retire a rung this count includes),
//     `oneToOneBreakerTripped` is what the bulk run leaves alone;
//   - pending placement nudges, reported separately: they are held manual-only
//     today and the fix script releases none of them;
//   - imported one-to-one rows whose phone claim points at a DIFFERENT row (a
//     missing claim is the normal state for an imported row).
//
// TARGET: `--env local|dev|prod` (required) resolves the tables and the
// credentials through scripts/lib/stageClient.ts; dev/prod run the account
// guard first and never touch the default credential chain. An agent runs
// this ONLY with `--env local --lane <L>` against a hermetic e2e lane it
// started; a bare `--env local` is the human's live local stack. NO AGENT
// RUNS THIS AGAINST A REAL ENVIRONMENT; the human does.
//
// Run: npx tsx app/scripts/conversation-automation-census.ts --env dev
import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  DISCONTINUED_REMINDER_KINDS,
  resolveUsableGroup,
  retiredByTourStart,
  type RunDueTourRemindersDeps,
} from '../src/jobs/tourReminders.js';
import { tableName } from '../src/lib/config.js';
import { queryAll } from '../src/lib/dynamoPaging.js';
import { isSupersededRung } from '../src/lib/ladderPointer.js';
import { createLogger, logger, type Logger } from '../src/lib/logger.js';
import { isOneToOneBucket, POINTER_PARTITION_PREFIXES } from '../src/lib/unreadFeed.js';
import type { AuditEvent } from '../src/repos/auditRepo.js';
import { createContactsRepo } from '../src/repos/contactsRepo.js';
import { createConversationsRepo, type ConversationItem } from '../src/repos/conversationsRepo.js';
import { createPlacementNudgesRepo } from '../src/repos/placementNudgesRepo.js';
import { createTourRemindersRepo } from '../src/repos/tourRemindersRepo.js';
import { createToursRepo, type TourItem } from '../src/repos/toursRepo.js';
import { parseStageArgs, resolveStageClient, type StageClient } from './lib/stageClient.js';

/** A dueAt bound past every real rung: listDue(FAR_FUTURE) = every pending row. */
const FAR_FUTURE = '9999-12-31T00:00:00.000Z';

export type SwitchState = 'auto' | 'manual' | 'unset';

/** How a trip is known: its `mode_changed` audit event, or - when that event is
 *  missing - the breaker's send counter on the manual row (hasBreakerSendCounter). */
export type TripEvidence = 'audit_event' | 'send_counter';

export interface BreakerTrippedRow {
  conversationId: string;
  type: string;
  /** audit_event: the event's ISO instant. send_counter: the counter's minute
   *  bucket (`YYYY-MM-DDTHH:mm`, UTC) - the last counted minute, the trip's
   *  best available time. */
  trippedAt: string;
  evidence: TripEvidence;
}

export interface AutomationCensus {
  scannedRows: number;
  pointerRows: number;
  byType: Record<string, Record<SwitchState, number>>;
  /** breakerTrip counts BOTH evidence kinds (breakerTripped lists which). */
  manualByCause: { groupThread: number; breakerTrip: number; imported: number; other: number };
  breakerTripped: BreakerTrippedRow[];
  pendingTourRungs: {
    /** Would send once the bulk fix script runs. */
    oneToOneSwitchedOff: number;
    /** Held by a breaker-tripped conversation; the bulk run leaves these off. */
    oneToOneBreakerTripped: number;
    oneToOneSwitchedOn: number;
    /** Routed to a usable relay group; the switch never applies. */
    groupRouted: number;
    tourPast: number;
    superseded: number;
    discontinued: number;
    unresolvable: number;
  };
  pendingNudgesHeldManualOnly: number;
  importedOneToOneRows: number;
  importClaimMismatches: number;
}

export function switchStateOf(row: Pick<ConversationItem, 'ai_mode'>): SwitchState {
  if (row.ai_mode === 'manual') return 'manual';
  if (row.ai_mode === 'auto') return 'auto';
  return 'unset';
}

/** A pointer item in the conversations table (a phone/email claim or a reply
 *  token): a key and a ref, never a conversation. The prefix list is
 *  lib/unreadFeed.ts's own, imported so the two can never drift. */
export function isPointerRow(conversationId: string): boolean {
  return POINTER_PARTITION_PREFIXES.some((p) => conversationId.startsWith(p));
}

/**
 * THE BREAKER'S SEND COUNTER IS TRIP EVIDENCE on a `manual` one-to-one row,
 * whether or not the trip's audit event exists. Why it is proof:
 *   - `outbound_minute_bucket` is written ONLY by
 *     conversationsRepo.incrementAutomatedSendCount, which sendMessage.ts
 *     reaches only for an AUTOMATED send on a row that is NOT manual (the
 *     manual refusal precedes the counter), and nothing ever removes it;
 *   - the ONLY runtime writer of `manual` is the breaker (setMode, called from
 *     sendMessage.ts): runtime creation writes one-to-one rows `auto`, and the
 *     import sets a switch only when it creates the row (`if_not_exists`;
 *     every import-created row has carried one since the importer's first
 *     commit), so it never switches off a row that has counted a send.
 * So `manual` + counter = the breaker switched it off. The breaker writes
 * setMode FIRST and its audit event SECOND, so the event can be unreadable
 * for a moment - or missing for good if that append failed; the counter
 * covers both.
 *
 * INVARIANT this rests on: the breaker is the sole writer of `manual` on a
 * row that can count a send. A future writer of `manual` - Work Package 2's
 * per-conversation switch (docs/issues/ai-mode-switch-gates-all-automation.md)
 * - MUST revisit this rule: a staff switch-off on a row with an old counter
 * would read as a trip here, and in enable-conversation-automation.ts.
 */
export function hasBreakerSendCounter(row: Pick<ConversationItem, 'outbound_minute_bucket'>): boolean {
  return typeof row.outbound_minute_bucket === 'string';
}

/** The breaker trip on record for a conversation, newest first, or undefined.
 *  A PAGED, FILTERED query: the audit partition also holds one `message_sent`
 *  per send, so an old trip can sit behind many newer events and
 *  auditRepo.listByEntity's single page would miss it. */
export async function findBreakerTrip(
  doc: DynamoDBDocumentClient,
  env: NodeJS.ProcessEnv,
  conversationId: string,
): Promise<AuditEvent | undefined> {
  const events = await queryAll<AuditEvent>(doc, {
    TableName: tableName('audit_events', env),
    KeyConditionExpression: '#e = :e',
    FilterExpression: '#t = :t',
    ExpressionAttributeNames: { '#e': 'entityKey', '#t': 'event_type' },
    ExpressionAttributeValues: { ':e': `conversations#${conversationId}`, ':t': 'mode_changed' },
    ScanIndexForward: false,
  });
  return events.find((e) => (e.payload as { reason?: unknown } | undefined)?.reason === 'breaker_trip');
}

export interface CensusOpts {
  doc: DynamoDBDocumentClient;
  env: NodeJS.ProcessEnv;
  /** The instant "tour already started" is judged against. Defaults to now. */
  now?: string;
  /** Scan page bound (tests exercise the paging loop with it). */
  scanLimit?: number;
}

export async function runConversationAutomationCensus(opts: CensusOpts): Promise<AutomationCensus> {
  const { doc, env } = opts;
  const now = opts.now ?? new Date().toISOString();
  const census: AutomationCensus = {
    scannedRows: 0,
    pointerRows: 0,
    byType: {},
    manualByCause: { groupThread: 0, breakerTrip: 0, imported: 0, other: 0 },
    breakerTripped: [],
    pendingTourRungs: {
      oneToOneSwitchedOff: 0,
      oneToOneBreakerTripped: 0,
      oneToOneSwitchedOn: 0,
      groupRouted: 0,
      tourPast: 0,
      superseded: 0,
      discontinued: 0,
      unresolvable: 0,
    },
    pendingNudgesHeldManualOnly: 0,
    importedOneToOneRows: 0,
    importClaimMismatches: 0,
  };

  // ---- Conversations: one Scan, every row classified; claims collected ------
  const phoneClaims = new Map<string, string>();
  const importedOneToOne: Array<{ conversationId: string; phone: string }> = [];
  const breakerTrippedIds = new Set<string>();
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: tableName('conversations', env),
        ...(opts.scanLimit !== undefined && { Limit: opts.scanLimit }),
        ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );
    for (const raw of (page.Items ?? []) as ConversationItem[]) {
      census.scannedRows += 1;
      if (isPointerRow(raw.conversationId)) {
        census.pointerRows += 1;
        if (raw.conversationId.startsWith('phone#') && typeof raw.ref_conversationId === 'string') {
          phoneClaims.set(raw.conversationId.slice('phone#'.length), raw.ref_conversationId);
        }
        continue;
      }
      const typeKey = typeof raw.type === 'string' ? raw.type : '(none)';
      const bucket = (census.byType[typeKey] ??= { auto: 0, manual: 0, unset: 0 });
      const state = switchStateOf(raw);
      bucket[state] += 1;
      const imported = typeof raw.imported_from === 'string';
      if (isOneToOneBucket(raw) && imported && typeof raw.participant_phone === 'string') {
        importedOneToOne.push({ conversationId: raw.conversationId, phone: raw.participant_phone });
      }
      if (state !== 'manual') continue;
      if (!isOneToOneBucket(raw)) {
        census.manualByCause.groupThread += 1;
        continue;
      }
      // A trip on record (its audit event) is preferred for its exact time; a
      // manual row with the breaker's send counter and NO event is a trip too
      // (hasBreakerSendCounter), listed so the operator sees the missing event.
      const trip = await findBreakerTrip(doc, env, raw.conversationId);
      if (trip !== undefined || hasBreakerSendCounter(raw)) {
        census.manualByCause.breakerTrip += 1;
        breakerTrippedIds.add(raw.conversationId);
        census.breakerTripped.push(
          trip !== undefined
            ? { conversationId: raw.conversationId, type: typeKey, trippedAt: trip.ts.split('#')[0] ?? trip.ts, evidence: 'audit_event' }
            : { conversationId: raw.conversationId, type: typeKey, trippedAt: String(raw.outbound_minute_bucket), evidence: 'send_counter' },
        );
        continue;
      }
      if (imported) census.manualByCause.imported += 1;
      else census.manualByCause.other += 1;
    }
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  census.importedOneToOneRows = importedOneToOne.length;
  for (const row of importedOneToOne) {
    const claim = phoneClaims.get(row.phone);
    if (claim !== undefined && claim !== row.conversationId) census.importClaimMismatches += 1;
  }

  // ---- Pending tour rungs: replay the job's target resolution -------------
  const tours = createToursRepo({ doc, env });
  const reminders = createTourRemindersRepo({ doc, env });
  const contacts = createContactsRepo({ doc, env });
  const conversations = createConversationsRepo({ doc, env });
  // resolveUsableGroup reads only deps.conversationsRepo (tourReminders.ts:1496-1530);
  // the cast hands it that one dependency rather than a whole job wiring. It
  // also logs the JOB's "falling back to tenant 1:1" WARN on an unusable group,
  // which would read as an action in a read-only report - so it gets a silent
  // logger; the census reports the outcome in its own counts.
  const usabilityDeps = { conversationsRepo: conversations } as unknown as RunDueTourRemindersDeps;
  const silent = createLogger({ level: 'silent' });
  const tourCache = new Map<string, TourItem | undefined>();
  const tourFor = async (tourId: string): Promise<TourItem | undefined> => {
    if (tourCache.has(tourId)) return tourCache.get(tourId);
    const tour = await tours.get(tourId);
    tourCache.set(tourId, tour);
    return tour;
  };
  for (const rung of await reminders.listDue(FAR_FUTURE)) {
    const r = census.pendingTourRungs;
    if (DISCONTINUED_REMINDER_KINDS.has(rung.kind)) {
      r.discontinued += 1;
      continue;
    }
    const tour = await tourFor(rung.tourId);
    if (!tour) {
      r.unresolvable += 1;
      continue;
    }
    if (retiredByTourStart(rung, tour.scheduledAt, now)) {
      r.tourPast += 1;
      continue;
    }
    if (isSupersededRung(rung, tour)) {
      r.superseded += 1;
      continue;
    }
    if (tour.tourType !== 'self_guided') {
      const group = await resolveUsableGroup(tour, rung, usabilityDeps, silent);
      if (group !== undefined) {
        r.groupRouted += 1;
        continue;
      }
      // Unusable group: the job falls back to the tenant 1:1 - so does this.
    }
    const contact = await contacts.getById(tour.tenantId);
    const phone = contact?.phone;
    if (typeof phone !== 'string' || phone.length === 0) {
      r.unresolvable += 1;
      continue;
    }
    const convs = await conversations.findByParticipantPhone(phone);
    const conv = convs.find((c) => c.type === 'tenant_1to1' || c.type === 'unknown_1to1');
    if (!conv) {
      r.unresolvable += 1;
      continue;
    }
    if (conv.ai_mode !== 'manual') r.oneToOneSwitchedOn += 1;
    else if (breakerTrippedIds.has(conv.conversationId)) r.oneToOneBreakerTripped += 1;
    else r.oneToOneSwitchedOff += 1;
  }

  // ---- Pending nudges: held manual-only, unaffected by the fix script ------
  const nudges = createPlacementNudgesRepo({ doc, env });
  census.pendingNudgesHeldManualOnly = (await nudges.listDue(FAR_FUTURE)).length;

  return census;
}

/** Log the census (counts + the breaker list) and return the exit code. */
export function reportCensus(census: AutomationCensus, log: Logger = logger): 0 {
  log.info({ ...census, breakerTripped: undefined }, 'conversation-automation-census - counts');
  for (const trip of census.breakerTripped) {
    log.info(trip, 'conversation-automation-census - breaker-tripped conversation (review before enabling)');
  }
  log.info(
    {
      breakerTripped: census.breakerTripped.length,
      // Trips known only by the send counter: the breaker's audit event is
      // missing (or not yet readable) for these - see hasBreakerSendCounter.
      breakerTrippedUnaudited: census.breakerTripped.filter((t) => t.evidence === 'send_counter').length,
      rungsReleasedByBulkEnable: census.pendingTourRungs.oneToOneSwitchedOff,
      rungsHeldByBreakerTrips: census.pendingTourRungs.oneToOneBreakerTripped,
      pendingNudgesHeldManualOnly: census.pendingNudgesHeldManualOnly,
    },
    'conversation-automation-census - done (read-only; nothing written). rungsReleasedByBulkEnable is an UPPER BOUND on what starts sending after the bulk apply (the job\'s later gates - quiet hours, conversion claims, open-group waits, roster, opt-out/deleted - are not replayed); breaker-held rungs move only after a single-conversation resume. Pending nudges are held manual-only today and are NOT released by the fix script.',
  );
  return 0;
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('conversation-automation-census.ts');
if (invokedDirectly) {
  const parsed = parseStageArgs(process.argv.slice(2), { values: [], flags: [] });
  if ('usage' in parsed) {
    console.error(
      'Usage: npx tsx app/scripts/conversation-automation-census.ts --env local|dev|prod [--lane <L>]\n' +
        '  --lane selects a hermetic e2e lane (local only; the only local target an agent may use).',
    );
    process.exit(2);
  }
  void (async () => {
    // STEP 1 - resolve the target on its own: a refusal here (account guard,
    // STS, an ambient AWS_ENDPOINT_URL*) happens before any table is read.
    let stage: StageClient;
    try {
      stage = await resolveStageClient(parsed.target, {}, parsed.lane !== undefined ? { lane: parsed.lane } : {});
    } catch (err) {
      logger.error({ err }, 'conversation-automation-census - FAILED before the run started (no table was read)');
      process.exitCode = 1;
      return;
    }
    // STEP 2 - the census (read-only: a failure here wrote nothing either).
    try {
      logger.info(
        { target: parsed.target, endpoint: stage.describe, prefix: stage.prefix },
        'conversation-automation-census - target resolved (read-only)',
      );
      const census = await runConversationAutomationCensus({ doc: stage.doc, env: stage.env });
      process.exitCode = reportCensus(census);
    } catch (err) {
      logger.error({ err }, 'conversation-automation-census - FAILED (read-only: nothing was written)');
      process.exitCode = 1;
    } finally {
      stage.doc.destroy();
    }
  })();
}
