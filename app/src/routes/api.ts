// /api router — dashboard-facing REST (M1.1 outbound send; M1.2 conversation
// hub: inbox, thread, unread, assignment, SSE live updates).
//
// TODO(M1.3): AUTH — this router currently trusts anything that clears the
// CloudFront origin-secret middleware. Google OAuth + RBAC land in M1.3 and
// must gate every /api route (including the SSE stream); until then the
// dashboard API is origin-secret protected only.
//
// PII (doc §9): responses carry bodies/previews to the authenticated client;
// LOG LINES never do — logs are IDs/counts only, correlated via the pino mixin.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { Router } from 'express';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { getContext, mergeContext, runWithContext } from '../lib/context.js';
import {
  appEvents,
  type ConversationUpdatedEvent,
  type EventBus,
  type MessagePersistedEvent,
} from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import {
  createConversationsRepo,
  type ConversationItem,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import { createMessagesRepo, type MessagesRepo } from '../repos/messagesRepo.js';
import {
  createSendMessageService,
  SendRefusedError,
  type SendMessageService,
} from '../services/sendMessage.js';

/** Refusal code → HTTP status for the send endpoint. */
const REFUSAL_STATUS: Record<SendRefusedError['code'], number> = {
  conversation_not_found: 404,
  contact_opted_out: 409,
  manual_mode: 409,
  breaker_open: 429,
};

/** Page-size bounds shared by the inbox and thread endpoints. */
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

/**
 * The statuses conversations actually use (conversationsRepo: `open` is the
 * only value any code path writes — create, touchLastActivity). ?status= is
 * the byLastActivity partition key, so anything else is allowlisted here
 * before it reaches DynamoDB; extend this set when a close/archive flow
 * lands.
 */
const CONVERSATION_STATUSES = new Set(['open']);

/**
 * SSE heartbeat period. CloudFront severs idle origin reads at 30s by
 * default — 25s comment frames keep the stream alive through it.
 */
const SSE_HEARTBEAT_MS = 25_000;

export interface ApiRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  /** Test seam: injected service (no DynamoDB/provider). */
  sendMessageService?: SendMessageService;
  conversationsRepo?: ConversationsRepo;
  messagesRepo?: MessagesRepo;
  auditRepo?: AuditRepo;
  /** SSE live-update bus (M1.2); the process singleton by default. */
  events?: EventBus;
  /** Test seam: shrink the 25s SSE heartbeat. */
  sseHeartbeatMs?: number;
}

// --- Inbox cursor (opaque to clients) ---------------------------------------
// base64url(JSON) of the Query's LastEvaluatedKey. Clients echo it back via
// ?cursor= — it is never constructed by hand.

function encodeCursor(lastEvaluatedKey: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(lastEvaluatedKey), 'utf8').toString('base64url');
}

/**
 * Decode + validate a cursor against the EXACT ExclusiveStartKey shape for
 * byLastActivity: { conversationId, status, last_activity_at }, all strings,
 * nothing else. Anything off-shape is a 400 upstream — a client-tampered
 * cursor must never reach DynamoDB as a malformed key.
 */
function decodeCursor(cursor: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const key = parsed as Record<string, unknown>;
      const expected = ['conversationId', 'status', 'last_activity_at'];
      if (
        Object.keys(key).length === expected.length &&
        expected.every((field) => typeof key[field] === 'string')
      ) {
        return key;
      }
    }
  } catch {
    // fall through — malformed cursors are a 400, not a crash
  }
  return undefined;
}

/**
 * Parse an optional ?limit= into 1..MAX_PAGE_LIMIT. Returns undefined when
 * the value is invalid (caller responds 400).
 */
function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined) return DEFAULT_PAGE_LIMIT;
  if (typeof raw !== 'string') return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) return undefined;
  return limit;
}

/** The shared conversation.updated payload (lib/events.ts shape) for a fresh item. */
function toConversationUpdatedEvent(item: ConversationItem): ConversationUpdatedEvent {
  return {
    conversationId: item.conversationId,
    last_activity_at: item.last_activity_at,
    unread_count: item.unread_count ?? 0,
    ...(item.last_message_preview !== undefined && { preview: item.last_message_preview }),
  };
}

/** The denormalized summary the hub's inbox list renders (doc §5). */
function toConversationSummary(item: ConversationItem): Record<string, unknown> {
  return {
    conversationId: item.conversationId,
    type: item.type,
    participant_phone: item.participant_phone,
    participants: item.participants ?? [],
    preview: item.last_message_preview ?? null,
    last_activity_at: item.last_activity_at,
    unread_count: item.unread_count ?? 0,
    assignment: item.assignment ?? null,
    sms_opt_out: item.sms_opt_out === true,
  };
}

export function createApiRouter(deps: ApiRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const events = deps.events ?? appEvents;
  const sseHeartbeatMs = deps.sseHeartbeatMs ?? SSE_HEARTBEAT_MS;
  const sendMessage =
    deps.sendMessageService ??
    createSendMessageService({
      config,
      logger: deps.logger,
      conversationsRepo: conversations,
      messagesRepo: messages,
      auditRepo: audit,
      events,
    });

  const router = Router();

  // POST /api/conversations/:conversationId/messages  { body?, mediaUrls? }
  // A manual human send (automated sends come from jobs, not this route).
  router.post('/conversations/:conversationId/messages', async (req, res) => {
    const { conversationId } = req.params;
    const payload = (req.body ?? {}) as { body?: unknown; mediaUrls?: unknown };

    const body = typeof payload.body === 'string' && payload.body.length > 0 ? payload.body : undefined;
    const mediaUrls =
      Array.isArray(payload.mediaUrls) &&
      payload.mediaUrls.length > 0 &&
      payload.mediaUrls.every((u): u is string => typeof u === 'string')
        ? payload.mediaUrls
        : undefined;
    if (body === undefined && mediaUrls === undefined) {
      res.status(400).json({ error: 'body (non-empty string) or mediaUrls (string[]) is required' });
      return;
    }

    try {
      const outcome = await sendMessage({
        conversationId,
        ...(body !== undefined && { body }),
        ...(mediaUrls !== undefined && { mediaUrls }),
        automated: false,
      });
      res.status(201).json(outcome);
    } catch (err) {
      if (err instanceof SendRefusedError) {
        res.status(REFUSAL_STATUS[err.code]).json({ error: err.code });
        return;
      }
      throw err; // Express 5 forwards async throws to the error handler.
    }
  });

  // GET /api/conversations?status=open&limit=50&cursor=...
  // THE inbox (M1.2): ONE DynamoDB Query on the byLastActivity GSI,
  // descending by last_activity_at — never a Scan (listByLastActivity).
  router.get('/conversations', async (req, res) => {
    const rawStatus = req.query['status'];
    const status =
      typeof rawStatus === 'string' && rawStatus.length > 0 ? rawStatus : 'open';
    if (!CONVERSATION_STATUSES.has(status)) {
      res.status(400).json({
        error: `status must be one of: ${[...CONVERSATION_STATUSES].join(', ')}`,
      });
      return;
    }

    const limit = parseLimit(req.query['limit']);
    if (limit === undefined) {
      res.status(400).json({ error: `limit must be an integer 1..${MAX_PAGE_LIMIT}` });
      return;
    }

    let exclusiveStartKey: Record<string, unknown> | undefined;
    const rawCursor = req.query['cursor'];
    if (rawCursor !== undefined) {
      exclusiveStartKey = typeof rawCursor === 'string' ? decodeCursor(rawCursor) : undefined;
      if (exclusiveStartKey === undefined) {
        res.status(400).json({ error: 'invalid cursor' });
        return;
      }
    }

    const page = await conversations.listByLastActivity({
      status,
      limit,
      ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
    });
    res.json({
      conversations: page.items.map(toConversationSummary),
      nextCursor:
        page.lastEvaluatedKey !== undefined ? encodeCursor(page.lastEvaluatedKey) : null,
    });
  });

  // GET /api/conversations/:conversationId — one thread header.
  router.get('/conversations/:conversationId', async (req, res) => {
    const { conversationId } = req.params;
    mergeContext({ conversationId });
    const conversation = await conversations.getById(conversationId);
    if (!conversation) {
      res.status(404).json({ error: 'conversation_not_found' });
      return;
    }
    res.json({ conversation });
  });

  // GET /api/conversations/:conversationId/messages?limit=50&before=...
  // Newest-first page of the timeline; ?before= pages backwards (exclusive
  // tsMsgId bound, from the oldest item the client has).
  router.get('/conversations/:conversationId/messages', async (req, res) => {
    const { conversationId } = req.params;
    mergeContext({ conversationId });

    const limit = parseLimit(req.query['limit']);
    if (limit === undefined) {
      res.status(400).json({ error: `limit must be an integer 1..${MAX_PAGE_LIMIT}` });
      return;
    }
    const rawBefore = req.query['before'];
    const before = typeof rawBefore === 'string' && rawBefore.length > 0 ? rawBefore : undefined;

    const page = await messages.listByConversation(conversationId, {
      limit,
      ...(before !== undefined && { before }),
    });
    res.json({ messages: page });
  });

  // POST /api/conversations/:conversationId/read — zero the unread counter
  // (the operator opened the thread). Returns the updated conversation.
  router.post('/conversations/:conversationId/read', async (req, res) => {
    const { conversationId } = req.params;
    mergeContext({ conversationId });
    try {
      const conversation = await conversations.resetUnread(conversationId);
      // SSE (M1.2): other connected dashboards drop their unread badge for
      // this thread live (same event shape as every inbox-row change).
      events.emit('conversation.updated', toConversationUpdatedEvent(conversation));
      res.json({ conversation });
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'conversation_not_found' });
        return;
      }
      throw err;
    }
  });

  // PATCH /api/conversations/:conversationId/assignment { assigneeUserId }
  // string = assign, null = unassign. Audited as assignment_changed old → new.
  router.patch('/conversations/:conversationId/assignment', async (req, res) => {
    const { conversationId } = req.params;
    mergeContext({ conversationId });
    const payload = (req.body ?? {}) as { assigneeUserId?: unknown };
    const assigneeUserId = payload.assigneeUserId;
    // TODO(M1.3): validate assigneeUserId against the users table once
    // auth/users land — until then any non-empty string is accepted.
    if (
      !(assigneeUserId === null || (typeof assigneeUserId === 'string' && assigneeUserId.length > 0))
    ) {
      res.status(400).json({ error: 'assigneeUserId must be a non-empty string or null' });
      return;
    }

    try {
      const { conversation, previousAssigneeUserId } = await conversations.setAssignment(
        conversationId,
        assigneeUserId,
      );
      // §5 mandate: assignment flips are audit-trail events (old → new).
      await audit.append(`conversations#${conversationId}`, 'assignment_changed', {
        from: previousAssigneeUserId,
        to: assigneeUserId,
      });
      // SSE (M1.2): assignment changes refresh the inbox row live (clients
      // re-read the summary; the event shape stays the shared one).
      events.emit('conversation.updated', toConversationUpdatedEvent(conversation));
      res.json({ conversation });
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'conversation_not_found' });
        return;
      }
      throw err;
    }
  });

  // GET /api/events — the live-update SSE stream (M1.2).
  //
  // SINGLE-INSTANCE ASSUMPTION: this stream is fed by the in-process bus in
  // lib/events.ts — valid because the one app process serves both the
  // mutation paths and this stream. The DynamoDB-streams upgrade path lives
  // there if that ever changes.
  //
  // Streaming safety: the locked middleware chain (app.ts) has NO
  // compression or response-buffering middleware — correlation → request
  // logger → origin secret → body parsers all pass the response through
  // untouched, so res.write() flushes straight to the socket. The headers
  // below keep CloudFront (and any future proxy) from buffering or
  // transforming the stream; heartbeat comments keep it from idling out.
  //
  // Connection cap (SSE_MAX_CONNECTIONS, default 50): each stream holds a
  // socket + heartbeat timer + bus listener pair forever — unbounded
  // accepts would let one misbehaving client exhaust the single t4g.small.
  // Beyond the cap → 503 (clients retry/poll); a close frees its slot.
  let sseConnections = 0;
  router.get('/events', (req, res) => {
    if (sseConnections >= config.sseMaxConnections) {
      log.warn(
        { sseConnections, sseMaxConnections: config.sseMaxConnections },
        'sse connection cap reached — rejecting new stream with 503',
      );
      res.status(503).json({ error: 'too many event streams' });
      return;
    }
    sseConnections += 1;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Immediate comment frame: confirms the stream to the client and pushes
    // the headers through any intermediary right away.
    res.write(': connected\n\n');

    const writeEvent = (event: string, payload: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const onConversationUpdated = (payload: ConversationUpdatedEvent): void => {
      writeEvent('conversation.updated', payload);
    };
    const onMessagePersisted = (payload: MessagePersistedEvent): void => {
      writeEvent('message.persisted', payload);
    };
    events.on('conversation.updated', onConversationUpdated);
    events.on('message.persisted', onMessagePersisted);

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, sseHeartbeatMs);
    // Never keep the process alive for an idle stream.
    heartbeat.unref();

    log.info({ sse: 'connected' }, 'sse client connected');

    // Disconnect cleanup. The close event fires outside this request's
    // AsyncLocalStorage context (socket teardown), so re-enter the captured
    // context — otherwise the disconnect line would be an orphan log and
    // trip the orphan-log alarm.
    const ctx = getContext() ?? {};
    res.on('close', () => {
      sseConnections -= 1; // free the cap slot ('close' fires exactly once)
      clearInterval(heartbeat);
      events.off('conversation.updated', onConversationUpdated);
      events.off('message.persisted', onMessagePersisted);
      runWithContext(ctx, () => {
        log.info({ sse: 'disconnected' }, 'sse client disconnected');
      });
      res.end();
    });
  });

  return router;
}
