// AI run log API (design 2026-08-06 section 9). This router is admin-only on
// the server; the dashboard's client-side route guard is not authorization.
import { Router } from 'express';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { requireRole } from '../middleware/auth.js';
import {
  createAiRunsRepo,
  DEFAULT_PAGE_SIZE,
  type AiRunRecord,
  type AiRunsRepo,
} from '../repos/aiRunsRepo.js';
import {
  createContactsRepo,
  type ContactDisplayItem,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import { createMessagesRepo, type MessageItem, type MessagesRepo } from '../repos/messagesRepo.js';
import { DECISION_TARGETS } from '../services/extraction/runTypes.js';
import { capUtterances, toUtterances } from '../jobs/extraction.js';
import { hashRenderedMessage } from '../services/extraction/runWindow.js';

export interface AiRunsRouterDeps {
  logger?: Logger;
  aiRunsRepo?: AiRunsRepo;
  messagesRepo?: Pick<MessagesRepo, 'getManyByTsMsgIds'>;
  contactsRepo?: Pick<ContactsRepo, 'getDisplayById' | 'getDisplaysByIds'>;
}

const MAX_PAGE_SIZE = 100;
const SCOPE_PATTERN =
  /^(global|outcome#(applied|no_op|skipped|failed)|conversations#[\w.-]+|contacts#[\w.-]+)$/;

function decisionCounts(run: AiRunRecord): Record<string, number> {
  const counts = { wrote: 0, suggested: 0, dropped: 0, no_finding: 0, not_addressed: 0, pending: 0 };
  for (const target of DECISION_TARGETS) {
    const decision = run.decisions[target];
    if (decision === undefined) continue;
    counts[decision.outcome] += 1;
    if (decision.verdict === 'pending') counts.pending += 1;
  }
  return counts;
}

interface AiRunContactDisplay {
  firstName?: string;
  lastName?: string;
  phone?: string;
}

function contactDisplay(contact: ContactDisplayItem): AiRunContactDisplay {
  return {
    ...(typeof contact.firstName === 'string' && contact.firstName.trim() !== '' && { firstName: contact.firstName }),
    ...(typeof contact.lastName === 'string' && contact.lastName.trim() !== '' && { lastName: contact.lastName }),
    ...(typeof contact.phone === 'string' && contact.phone !== '' && { phone: contact.phone }),
  };
}

/**
 * Parse + clamp ?limit= into 1..MAX_PAGE_SIZE; default DEFAULT_PAGE_SIZE.
 * Clamping (not rejecting) preserves this route's shipped contract, where an
 * oversized limit answers 200 capped at MAX_PAGE_SIZE. The floor of 1 is the
 * load-bearing half: a fractional or non-positive limit used to floor to 0,
 * and the repo's `opts.limit ?? DEFAULT` does not replace 0, so DynamoDB got
 * Limit: 0 and answered a ValidationException. Modeled on inbox.ts parseLimit,
 * then hardened: inbox's copy still parses `?limit=` to a ONE-row page
 * (docs/issues/inbox-parselimit-empty-one-row.md) - do not "re-sync" this
 * function back to it.
 *
 * An EMPTY or whitespace value is ABSENT, exactly as `optionalParam` reads
 * before/from/to: `Number('')` and `Number(' ')` are both 0, which IS an
 * integer, so the floor of 1 silently served a ONE-row page (conf P2-3). A
 * value of another shape entirely - a repeated `?limit=` arrives as an array -
 * keeps the clamp philosophy and falls back to the default rather than 400ing;
 * a page size is a preference, while a date filter changes WHICH rows answer.
 */
function parseLimit(raw: unknown): number {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_PAGE_SIZE;
  const n = Number(raw);
  // A non-positive limit falls back to the DEFAULT, it does not floor to 1.
  // `Math.max(1, n)` served `?limit=0` and `?limit=-5` a ONE-row page - the
  // same defect this function's own comment describes catching for the empty
  // string, left behind for the explicit values. Flooring is wrong here for the
  // reason stated above: a page size is a preference, so an unusable one falls
  // back rather than being honored at its nearest legal value.
  if (!Number.isInteger(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, n);
}

// `from`/`to` are the dashboard's two <input type="date"> values (AiRunList.tsx),
// so their wire shape is exactly YYYY-MM-DD. They are compared LEXICOGRAPHICALLY
// against the byEntity sort key, so a Date.parse-only check is too loose: it
// accepts "August 1, 2026", which parses fine and then sorts nowhere near a
// 2026-08-... sort key - i.e. it would still answer a silent empty page.
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// `before` is the opaque paging cursor - a sort key `<ISO>#<runId>`
// (aiRunsRepo.runSortKey), NEVER a bare timestamp. Date.parse() on it is NaN,
// so an ISO validator applied here would 400 every "Load more" click.
const BEFORE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#[\w.-]+$/;

/**
 * Shape check AND real-date check, by CANONICAL ROUND TRIP.
 *
 * `Date.parse` alone is not calendar validation: it rejects an out-of-range
 * MONTH (2026-13-01 is NaN) but silently ROLLS OVER an out-of-range DAY -
 * 2026-02-30 parses to 2026-03-02, and 2026-02-29 to 2026-03-01 because 2026 is
 * not a leap year. The impossible bound then reached DynamoDB and answered a
 * plausible-looking page for a range nobody asked for, which is exactly the
 * silent-wrongness these 400s exist to prevent on a forensic surface.
 *
 * Round-tripping the parsed date back to YYYY-MM-DD catches every rollover: a
 * date survives only if the calendar agrees it exists. A real leap day
 * (2024-02-29) round-trips unchanged and still passes.
 */
function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return new Date(parsed).toISOString().slice(0, 10) === value;
}

/**
 * An absent filter and an EMPTY one mean the same thing: no filter. The
 * dashboard already deletes a cleared control's search param rather than
 * sending it empty, and an empty bound was a harmless no-op before these
 * params were validated - so an empty value must not become a 400.
 */
function optionalParam(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

export function createAiRunsRouter(deps: AiRunsRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const aiRuns = deps.aiRunsRepo ?? createAiRunsRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const router = Router();

  router.use(requireRole('admin'));

  router.get('/', async (req, res) => {
    const scope = String(req.query['scope'] ?? 'global');
    if (!SCOPE_PATTERN.test(scope)) {
      res.status(400).json({ error: 'invalid_scope' });
      return;
    }
    // A REPEATED filter (?from=a&from=b) arrives as an ARRAY, and every shape
    // check below reads a non-string as absent - so the filter used to vanish
    // and this route answered 200 with the WHOLE table under a heading that
    // claims a date range. An over-broad forensic page misleads at least as
    // badly as the empty one the per-parameter 400s exist to prevent, so say
    // WHICH parameter cannot be read (adv P2).
    for (const name of ['before', 'from', 'to'] as const) {
      const raw = req.query[name];
      if (raw !== undefined && typeof raw !== 'string') {
        res.status(400).json({ error: `invalid_${name}` });
        return;
      }
    }
    const limit = parseLimit(req.query['limit']);
    const before = optionalParam(req.query['before']);
    const from = optionalParam(req.query['from']);
    const to = optionalParam(req.query['to']);
    // This is a forensic surface: a malformed filter must say WHICH parameter
    // is wrong, not render a silent empty page that reads as "no runs".
    for (const [name, value] of [['from', from], ['to', to]] as const) {
      if (value !== undefined && !isCalendarDate(value)) {
        res.status(400).json({ error: `invalid_${name}` });
        return;
      }
    }
    if (before !== undefined && !BEFORE_PATTERN.test(before)) {
      res.status(400).json({ error: 'invalid_before' });
      return;
    }
    const page = await aiRuns.listByEntity(scope, {
      limit,
      ...(before !== undefined && { before }),
      ...(from !== undefined && { from }),
      ...(to !== undefined && { to }),
    });
    const contactIds = new Set<string>();
    for (const entry of page.entries) {
      if (!entry.expired && entry.run.contactId !== undefined) contactIds.add(entry.run.contactId);
    }
    const scopeContactId = scope.startsWith('contacts#') ? scope.slice('contacts#'.length) : undefined;
    if (scopeContactId !== undefined) contactIds.add(scopeContactId);
    let contactsById = new Map<string, ContactDisplayItem>();
    if (contactIds.size > 0) {
      try {
        contactsById = await contacts.getDisplaysByIds([...contactIds]);
      } catch (err) {
        log.warn({ count: contactIds.size, err }, 'ai run log contact display batch failed');
      }
    }
    const runs = page.entries.map((entry) =>
      entry.expired
        ? { runId: entry.runId, sortKey: entry.sortKey, expired: true as const }
        : {
            runId: entry.runId,
            sortKey: entry.sortKey,
            expired: false as const,
            startedAt: entry.run.startedAt,
            durationMs: entry.run.durationMs,
            conversationId: entry.run.conversationId,
            ...(entry.run.contactId !== undefined && { contactId: entry.run.contactId }),
            ...(entry.run.contactId !== undefined && contactsById.has(entry.run.contactId) && {
              contact: contactDisplay(contactsById.get(entry.run.contactId)!),
            }),
            trigger: entry.run.trigger,
            outcome: entry.run.outcome,
            ...(entry.run.skipReason !== undefined && { skipReason: entry.run.skipReason }),
            ...(entry.run.error !== undefined && { errorKind: entry.run.error.kind }),
            driver: entry.run.driver,
            ...(entry.run.model !== undefined && { model: entry.run.model }),
            decisionCounts: decisionCounts(entry.run),
            notedLines: entry.run.notedLines,
          },
    );
    log.debug({ scope, count: runs.length }, 'ai run log listed');
    const scopeContact = scopeContactId === undefined ? undefined : contactsById.get(scopeContactId);
    res.json({
      runs,
      ...(scopeContact !== undefined && { scopeContact: contactDisplay(scopeContact) }),
      ...(page.nextBefore !== undefined && { nextBefore: page.nextBefore }),
    });
  });

  router.get('/:runId', async (req, res) => {
    const runId = String(req.params['runId'] ?? '');
    const run = await aiRuns.getRun(runId);
    if (run === undefined) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    let contact: AiRunContactDisplay | undefined;
    if (run.contactId !== undefined) {
      try {
        const storedContact = await contacts.getDisplayById(run.contactId);
        if (storedContact !== undefined) contact = contactDisplay(storedContact);
      } catch (err) {
        log.warn({ runId, err }, 'ai run log contact display read failed');
      }
    }
    const stored = run.window?.messages ?? [];
    let byId = new Map<string, MessageItem>();
    if (stored.length > 0) {
      try {
        byId = await messages.getManyByTsMsgIds(run.conversationId, stored.map((message) => message.tsMsgId));
      } catch {
        // Rehydration is a convenience view; a repository failure never hides an audit record.
        log.warn({ runId }, 'ai run log window rehydration failed');
      }
    }
    const rehydrated = stored.map((message) => {
      const row = byId.get(message.tsMsgId);
      const text = row === undefined ? undefined : row.type === 'call' ? row.transcript : row.body;
      const hashStatus =
        run.window?.detail === 'full' && message.hash !== undefined && message.capChars !== undefined && row !== undefined
          ? hashRenderedMessage(capUtterances(toUtterances(row), message.capChars)) === message.hash
            ? 'match' as const
            : 'mismatch' as const
          : run.window?.detail === 'full'
            ? 'unavailable' as const
            : undefined;
      return {
        ...message,
        available: row !== undefined,
        ...(text !== undefined && { text }),
        ...(hashStatus !== undefined && { hashStatus }),
      };
    });
    res.json({ run, ...(contact !== undefined && { contact }), window: { messages: rehydrated } });
  });

  return router;
}
