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
    const rawLimit = Number(req.query['limit']);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), MAX_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE;
    const before = typeof req.query['before'] === 'string' ? req.query['before'] : undefined;
    const from = typeof req.query['from'] === 'string' ? req.query['from'] : undefined;
    const to = typeof req.query['to'] === 'string' ? req.query['to'] : undefined;
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
        run.window?.detail === 'full' && message.capChars !== undefined && row !== undefined
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
