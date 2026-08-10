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
import { createMessagesRepo, type MessageItem, type MessagesRepo } from '../repos/messagesRepo.js';
import { DECISION_TARGETS } from '../services/extraction/runTypes.js';
import { capUtterances, toUtterances } from '../jobs/extraction.js';
import { hashRenderedMessage } from '../services/extraction/runWindow.js';

export interface AiRunsRouterDeps {
  logger?: Logger;
  aiRunsRepo?: AiRunsRepo;
  messagesRepo?: Pick<MessagesRepo, 'getManyByTsMsgIds'>;
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

/**
 * Parse + clamp ?limit= into 1..MAX_PAGE_SIZE; default DEFAULT_PAGE_SIZE.
 * Clamping (not rejecting) preserves this route's shipped contract, where an
 * oversized limit answers 200 capped at MAX_PAGE_SIZE. The floor of 1 is the
 * load-bearing half: a fractional or non-positive limit used to floor to 0,
 * and the repo's `opts.limit ?? DEFAULT` does not replace 0, so DynamoDB got
 * Limit: 0 and answered a ValidationException. Modeled on inbox.ts parseLimit.
 */
function parseLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_PAGE_SIZE;
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isInteger(n)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, n));
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

/** Shape check AND real-date check: 2026-13-45 passes the regex, not Date.parse. */
function isCalendarDate(value: string): boolean {
  return DATE_PATTERN.test(value) && Number.isFinite(Date.parse(value));
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
  const router = Router();

  router.use(requireRole('admin'));

  router.get('/', async (req, res) => {
    const scope = String(req.query['scope'] ?? 'global');
    if (!SCOPE_PATTERN.test(scope)) {
      res.status(400).json({ error: 'invalid_scope' });
      return;
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
    res.json({ runs, ...(page.nextBefore !== undefined && { nextBefore: page.nextBefore }) });
  });

  router.get('/:runId', async (req, res) => {
    const runId = String(req.params['runId'] ?? '');
    const run = await aiRuns.getRun(runId);
    if (run === undefined) {
      res.status(404).json({ error: 'run_not_found' });
      return;
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
    res.json({ run, window: { messages: rehydrated } });
  });

  return router;
}
