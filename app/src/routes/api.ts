// /api router — dashboard-facing REST (M1.1 outbound send; M1.2 conversation
// hub: inbox, thread, unread, assignment, SSE live updates).
//
// AUTH (M1.3): every route in this router — the SSE stream included — sits
// behind sessionMiddleware + requireAuth, mounted ahead of it in app.ts.
// Role gates are deliberately MINIMAL: VAs run the day-to-day (assignment
// included), so nothing here uses requireRole('admin') until a genuinely
// admin-only surface exists (see middleware/auth.ts).
//
// PII (doc §9): responses carry bodies/previews to the authenticated client;
// LOG LINES never do — logs are IDs/counts only, correlated via the pino mixin.
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { Router } from 'express';
import { createMediaStore, type MediaStore } from '../adapters/mediaStore.js';
import { isInlineMediaType } from '../lib/mediaTypes.js';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { getContext, mergeContext, runWithContext } from '../lib/context.js';
import {
  appEvents,
  toConversationUpdatedEvent,
  type BroadcastUpdatedEvent,
  type CaseUpdatedEvent,
  type ConversationUpdatedEvent,
  type EventBus,
  type MessagePersistedEvent,
} from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import {
  createConversationsRepo,
  type ConversationItem,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import {
  createMessagesRepo,
  relayMemberKey,
  type MessagesRepo,
  type RelayRecipientDelivery,
} from '../repos/messagesRepo.js';
import { type ContactsRepo } from '../repos/contactsRepo.js';
import { type SettingsRepo } from '../repos/settingsRepo.js';
import { type UnitsRepo } from '../repos/unitsRepo.js';
import { type CasesRepo } from '../repos/casesRepo.js';
import { type UsersRepo } from '../repos/usersRepo.js';
import {
  createSendMessageService,
  SendRefusedError,
  type SendMessageService,
} from '../services/sendMessage.js';
import { type PushService } from '../services/pushService.js';
import { type PoolNumbersService } from '../services/poolNumbers.js';
import { enqueueImmediate } from '../jobs/jobs.js';
import {
  RELAY_FANOUT_JOB,
  TEAM_SENDER_KEY,
  TEAM_SENDER_LABEL,
} from '../jobs/relayFanOut.js';
import { type BroadcastsRepo } from '../repos/broadcastsRepo.js';
import { type AudienceResolutionService } from '../services/audienceResolution.js';
import { createAdminUsersRouter } from './adminUsers.js';
import { createBroadcastsRouter } from './broadcasts.js';
import { createCasesRouter } from './cases.js';
import { createContactsRouter } from './contacts.js';
import { createPushRouter } from './push.js';
import { createRelayGroupsRouter } from './relayGroups.js';
import { createSettingsRouter } from './settings.js';
import { createUnitsRouter } from './units.js';

/** Refusal code → HTTP status for the send endpoint. */
const REFUSAL_STATUS: Record<SendRefusedError['code'], number> = {
  conversation_not_found: 404,
  contact_opted_out: 409,
  manual_mode: 409,
  breaker_open: 429,
  relay_not_supported: 409,
  // A2P kill-switch (pre-A2P): SMS sending disabled → 503 (matches the relay
  // provisioning kill-switch's 503 posture).
  sms_sending_disabled: 503,
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
  /**
   * S3 media store (M1.9c: serve the founder-bridge recording back to the authed
   * dashboard). Undefined when MEDIA_BUCKET is unset — the recording endpoint
   * then answers 404 (nothing is stored locally).
   */
  mediaStore?: MediaStore;
  /** M1.4 surfaces — injected in tests; default to the real repos/services. */
  contactsRepo?: ContactsRepo;
  settingsRepo?: SettingsRepo;
  usersRepo?: UsersRepo;
  pushService?: PushService;
  /** M1.5 records & intake — injected in tests; default to the real repo. */
  unitsRepo?: UnitsRepo;
  /** M1.10 boards/cases — injected in tests; default to the real repo. */
  casesRepo?: CasesRepo;
  /** M1.7 relay groups — injected in tests; defaults to the real service. */
  poolNumbersService?: PoolNumbersService;
  contactsRepoForRelay?: ContactsRepo;
  /** M1.8a share-broadcast — injected in tests; default to the real repo/service. */
  broadcastsRepo?: BroadcastsRepo;
  audienceResolutionService?: AudienceResolutionService;
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

/** The denormalized summary the hub's inbox list renders (doc §5). */
function toConversationSummary(item: ConversationItem): Record<string, unknown> {
  return {
    conversationId: item.conversationId,
    type: item.type,
    participant_phone: item.participant_phone,
    participants: item.participants ?? [],
    preview: item.last_message_preview ?? null,
    participant_display_name: item.participant_display_name ?? null,
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
  // M1.9c recording serving: undefined when MEDIA_BUCKET is unset (404 then).
  const mediaStore = deps.mediaStore ?? createMediaStore({ config });
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

  // --- M1.4 sub-routers (all behind requireAuth via the /api mount; the
  // admin-only gate lives inside adminUsers + the settings PUT) ---
  // Push (web push subscriptions, vapid key, test send).
  router.use(
    '/push',
    createPushRouter({
      config,
      logger: deps.logger,
      ...(deps.usersRepo !== undefined && { usersRepo: deps.usersRepo }),
      ...(deps.pushService !== undefined && { pushService: deps.pushService }),
    }),
  );
  // Founder settings (GET requireAuth, PUT requireRole admin).
  router.use(
    '/settings',
    createSettingsRouter({
      logger: deps.logger,
      ...(deps.settingsRepo !== undefined && { settingsRepo: deps.settingsRepo }),
      auditRepo: audit,
    }),
  );
  // Admin user-management (requireRole admin on every route).
  router.use(
    '/users',
    createAdminUsersRouter({
      logger: deps.logger,
      ...(deps.usersRepo !== undefined && { usersRepo: deps.usersRepo }),
      auditRepo: audit,
    }),
  );
  // Contact triage + CRUD (requireAuth — VAs triage; propagates conversation
  // type and emits conversation.updated so connected inboxes update live).
  router.use(
    '/contacts',
    createContactsRouter({
      logger: deps.logger,
      ...(deps.contactsRepo !== undefined && { contactsRepo: deps.contactsRepo }),
      conversationsRepo: conversations,
      auditRepo: audit,
      events,
    }),
  );
  // Units CRUD (M1.5; requireAuth — VAs maintain listings, no admin gate).
  router.use(
    '/units',
    createUnitsRouter({
      logger: deps.logger,
      ...(deps.unitsRepo !== undefined && { unitsRepo: deps.unitsRepo }),
      auditRepo: audit,
    }),
  );
  // Relay groups (M1.7; requireAuth — VAs run relay threads, no admin gate).
  // Mounted at '/' so it owns /relay-groups AND the relay sub-routes on
  // /conversations/:id (/members, /close). The relay router's
  // /conversations/:id/* paths are DISTINCT segments from the 1:1 thread
  // routes below, so there is no collision; relay routes are matched first.
  router.use(
    '/',
    createRelayGroupsRouter({
      config,
      logger: deps.logger,
      conversationsRepo: conversations,
      ...(deps.contactsRepoForRelay !== undefined && { contactsRepo: deps.contactsRepoForRelay }),
      ...(deps.contactsRepo !== undefined &&
        deps.contactsRepoForRelay === undefined && { contactsRepo: deps.contactsRepo }),
      auditRepo: audit,
      ...(deps.poolNumbersService !== undefined && { poolNumbersService: deps.poolNumbersService }),
      events,
    }),
  );
  // Share-broadcasts (M1.8a; requireAuth — VAs run share broadcasts, no admin
  // gate). Mounted at '/' so it owns /broadcasts + the /broadcasts/:id sub-paths.
  router.use(
    '/',
    createBroadcastsRouter({
      config,
      logger: deps.logger,
      ...(deps.broadcastsRepo !== undefined && { broadcastsRepo: deps.broadcastsRepo }),
      ...(deps.unitsRepo !== undefined && { unitsRepo: deps.unitsRepo }),
      ...(deps.audienceResolutionService !== undefined && {
        audienceResolutionService: deps.audienceResolutionService,
      }),
      auditRepo: audit,
      events,
    }),
  );
  // Cases + boards (M1.10; requireAuth — VAs run the boards, no admin gate).
  // Gets the relay-provisioning deps too (M1.10c: POST /cases/:id/relay derives
  // the roster from the case + reuses the shared provisioning primitive).
  router.use(
    '/cases',
    createCasesRouter({
      config,
      logger: deps.logger,
      ...(deps.casesRepo !== undefined && { casesRepo: deps.casesRepo }),
      conversationsRepo: conversations,
      ...(deps.unitsRepo !== undefined && { unitsRepo: deps.unitsRepo }),
      ...(deps.contactsRepo !== undefined && { contactsRepo: deps.contactsRepo }),
      ...(deps.poolNumbersService !== undefined && { poolNumbersService: deps.poolNumbersService }),
      auditRepo: audit,
      events,
    }),
  );

  // POST /api/conversations/:conversationId/messages  { body?, mediaUrls? }
  // A manual human send (automated sends come from jobs, not this route).
  //
  // FIX 2: a relay_group thread is NOT a 1:1 send — the 1:1 wrapper would text
  // participant_phone (the pool number). The team-send branch below persists
  // ONE outbound message and fans it out to ALL members FROM the pool number
  // via relay.fanOut, returning the same outcome shape as the 1:1 path.
  router.post('/conversations/:conversationId/messages', async (req, res) => {
    const { conversationId } = req.params;
    mergeContext({ conversationId });
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

    // Relay branch: fetch the conversation to decide. A miss falls through to
    // the 1:1 path (sendMessage throws ConversationNotFoundError → 404), so the
    // existing behavior for unknown ids is unchanged.
    const conversation = await conversations.getById(conversationId);
    if (conversation?.type === 'relay_group') {
      await sendRelayTeamMessage(req, res, conversation, body, mediaUrls);
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

  /**
   * FIX 2 — team send into a relay group. Persists the outbound message ONCE on
   * the relay thread (author 'teammate'), seeds delivery_recipients to 'queued'
   * for ALL current members, then enqueues relay.fanOut to send to every member
   * FROM the pool number (no member is the sender → none is excluded; the
   * per-recipient prefix is the neutral team label, never a phone). Returns the
   * same { conversationId, providerSid, tsMsgId, status } shape as the 1:1 send.
   */
  async function sendRelayTeamMessage(
    req: import('express').Request,
    res: import('express').Response,
    conversation: ConversationItem,
    bodyText: string | undefined,
    mediaUrlList: string[] | undefined,
  ): Promise<void> {
    const conversationId = conversation.conversationId;
    if (conversation.status !== 'open') {
      res.status(409).json({ error: 'relay_closed' });
      return;
    }
    const poolNumber = conversation.pool_number;
    if (typeof poolNumber !== 'string' || poolNumber.length === 0) {
      // An open relay always carries a pool number; missing one is an anomaly.
      log.error({ conversationId }, 'relay team send: open relay has no pool number — refusing');
      res.status(409).json({ error: 'relay_closed' });
      return;
    }

    // Seed every current member's delivery slot to 'queued' (member key =
    // contactId else phone#<E164>, the shared convention) directly on the
    // SOURCE message at append time. The fan-out's setRecipientDelivery is a
    // CHILD-ONLY SET (DynamoDB forbids seeding a map and a child in one
    // expression), so the parent delivery_recipients map must exist before the
    // first per-recipient write — appending it whole here guarantees that.
    const roster = conversation.participants ?? [];
    const deliveryRecipients: Record<string, RelayRecipientDelivery> = {};
    for (const member of roster) {
      deliveryRecipients[relayMemberKey(member)] = { status: 'queued' };
    }

    // Persist the source message ONCE (the relayed message is stored once;
    // fan-out only updates delivery_recipients). No provider send happens here —
    // the per-recipient sends are the fan-out's job — so the SID/ts are
    // synthesized for the source item's key. A team message has no member
    // sender, so relay_sender_key is the TEAM sentinel.
    const providerTs = new Date().toISOString();
    const providerSid = `team-${randomUUID()}`;
    const appended = await messages.append({
      conversationId,
      providerSid,
      providerTs,
      type: mediaUrlList !== undefined && mediaUrlList.length > 0 ? 'mms' : 'sms',
      direction: 'outbound',
      author: 'teammate',
      deliveryStatus: 'queued',
      relaySenderKey: TEAM_SENDER_KEY,
      deliveryRecipients,
      ...(bodyText !== undefined && { body: bodyText }),
      ...(mediaUrlList !== undefined && { mediaUrls: mediaUrlList }),
    });

    // Fan out to ALL members FROM the pool number. TEAM_SENDER_KEY matches no
    // member, so none is excluded; the neutral team label is the prefix.
    try {
      await enqueueImmediate(RELAY_FANOUT_JOB, {
        relayConversationId: conversationId,
        sourceTsMsgId: appended.tsMsgId,
        senderKey: TEAM_SENDER_KEY,
        senderNameOverride: TEAM_SENDER_LABEL,
      });
    } catch (err) {
      log.error({ err, conversationId }, 'relay team send: fan-out enqueue failed — message persisted, not relayed');
    }

    // Inbox touch + audit + SSE — mirror the 1:1 send's tail (FIX 5: attribute
    // the audit to the acting user).
    let touched: ConversationItem | undefined;
    try {
      touched = await conversations.touchLastActivity(conversationId, bodyText, providerTs);
    } catch (err) {
      log.error({ err, conversationId }, 'relay team send: touchLastActivity failed — inbox stale');
    }
    await audit.append(`conversations#${conversationId}`, 'message_sent', {
      actor: (req as AuthedRequest).user?.userId,
      author: 'teammate',
      relay: true,
      memberCount: roster.length,
    });

    events.emit('message.persisted', {
      conversationId,
      tsMsgId: appended.tsMsgId,
      direction: 'outbound',
      deliveryStatus: 'queued',
    });
    if (touched) events.emit('conversation.updated', toConversationUpdatedEvent(touched));

    log.info(
      { conversationId, memberCount: roster.length, actor: (req as AuthedRequest).user?.userId },
      'relay team message persisted + fanned out',
    );
    res.status(201).json({
      conversationId,
      providerSid,
      tsMsgId: appended.tsMsgId,
      status: 'queued',
    });
  }

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

  // GET /api/calls/:callId — resolve a call (M1.9a). `callId` is the Twilio
  // CallSid (== the call message's provider_sid); getByProviderSid resolves it
  // via the SID pointer, exactly like the status-callback path. Returns
  // { call, conversation } so the dashboard /quick-reply/:callId seam can map a
  // callId → its conversation (and render the masked call entry). PII (doc §9):
  // the call carries call_party_label (a role/name) — never a raw counterpart
  // phone beyond what the conversation already exposes; logs stay IDs-only.
  router.get('/calls/:callId', async (req, res) => {
    const { callId } = req.params;
    const call = await messages.getByProviderSid(callId);
    if (!call || call.type !== 'call') {
      res.status(404).json({ error: 'call_not_found' });
      return;
    }
    mergeContext({ conversationId: call.conversationId });
    const conversation = await conversations.getById(call.conversationId);
    if (!conversation) {
      // The call entry points at a conversation that no longer exists — surface
      // the call alone rather than a hard 404 (the timeline item is still real).
      log.warn({ callSid: callId }, 'GET /api/calls: call found but its conversation is missing');
      res.json({ call, conversation: null });
      return;
    }
    res.json({ call, conversation });
  });

  // GET /api/calls/:callId/recording — stream the founder-bridge recording back
  // to the dashboard for playback (M1.9c). AUTH-ONLY (this router sits behind
  // requireAuth + session) — recordings are PII (doc §9) and NEVER public.
  // Resolve the call by CallSid (== provider_sid); if it carries a
  // recording_s3_key, STREAM the S3 object through (streams-only, no whole-body
  // buffering) so the audio never transits a public/presigned URL — the bytes
  // stay behind the session gate. 404 when the call/recording does not exist (or
  // MEDIA_BUCKET is unconfigured). PII: no recording content in any log line.
  router.get('/calls/:callId/recording', async (req, res) => {
    const { callId } = req.params;
    const call = await messages.getByProviderSid(callId);
    if (!call || call.type !== 'call') {
      res.status(404).json({ error: 'call_not_found' });
      return;
    }
    mergeContext({ conversationId: call.conversationId });
    const key = call.recording_s3_key;
    if (typeof key !== 'string' || key.length === 0) {
      res.status(404).json({ error: 'recording_not_found' });
      return;
    }
    if (!mediaStore) {
      // No store configured (MEDIA_BUCKET unset) — the key cannot be served.
      log.warn({ callSid: callId }, 'recording requested but no media store configured');
      res.status(404).json({ error: 'recording_not_found' });
      return;
    }
    const object = await mediaStore.getStream(key);
    if (!object) {
      // The key is recorded on the call but the object is gone (lifecycle/
      // deletion) — 404 rather than a hanging stream.
      log.warn({ callSid: callId }, 'recording key present but object not found in the media store');
      res.status(404).json({ error: 'recording_not_found' });
      return;
    }
    res.setHeader('Content-Type', object.contentType ?? 'audio/mpeg');
    if (object.contentLength !== undefined) {
      res.setHeader('Content-Length', String(object.contentLength));
    }
    // nosniff is already set app-wide; the recording is audio, never executable.
    log.info({ callSid: callId }, 'streaming founder-bridge recording to the dashboard');
    object.body.on('error', (err) => {
      log.error({ err, callSid: callId }, 'recording stream errored mid-flight');
      res.destroy(err);
    });
    object.body.pipe(res);
  });

  // GET /api/messages/:providerSid/media/:idx — stream a mirrored inbound MMS
  // attachment back to the dashboard for inline <img> display. AUTH-ONLY (this
  // router is behind requireAuth) — MMS media is PII (IDs, personal photos/docs),
  // so it is NEVER public/presigned; the bytes stay behind the session gate, the
  // same posture as the call-recording endpoint above. The S3 key is read from
  // the message's STORED media_s3_keys[idx] (never client input → no path
  // traversal); :idx only selects which attachment. 404 for a missing message /
  // out-of-range idx / unmirrored media (MEDIA_BUCKET unset) / absent object.
  router.get('/messages/:providerSid/media/:idx', async (req, res) => {
    const { providerSid } = req.params;
    const idx = Number(req.params['idx']);
    if (!Number.isInteger(idx) || idx < 0) {
      res.status(400).json({ error: 'invalid_media_index' });
      return;
    }
    const message = await messages.getByProviderSid(providerSid);
    if (!message) {
      res.status(404).json({ error: 'message_not_found' });
      return;
    }
    mergeContext({ conversationId: message.conversationId });
    const keys = Array.isArray(message.media_s3_keys) ? message.media_s3_keys : [];
    const key = keys[idx];
    if (typeof key !== 'string' || key.length === 0) {
      res.status(404).json({ error: 'media_not_found' });
      return;
    }
    if (!mediaStore) {
      log.warn({ providerSid }, 'media requested but no media store configured');
      res.status(404).json({ error: 'media_not_found' });
      return;
    }
    const object = await mediaStore.getStream(key);
    if (!object) {
      log.warn({ providerSid, mediaIndex: idx }, 'media key present but object not found in the store');
      res.status(404).json({ error: 'media_not_found' });
      return;
    }
    // XSS HARDENING (the stored Content-Type is the MMS sender's, attacker-
    // controlled): serve INLINE only for allowlisted raster images; anything
    // else (text/html, image/svg+xml, application/*, absent) is forced to an
    // octet-stream ATTACHMENT so the browser downloads rather than renders it —
    // a malicious type/body can't run script same-origin when the attachment
    // link is opened top-level. Belt-and-braces: a restrictive CSP (no script,
    // sandboxed) + nosniff on THIS response neuter execution even if a renderer
    // is reached. nosniff also stops the browser sniffing octet-stream → html.
    const stored = object.contentType;
    const inline = isInlineMediaType(stored);
    res.setHeader('Content-Type', inline ? stored! : 'application/octet-stream');
    if (!inline) {
      res.setHeader('Content-Disposition', `attachment; filename="attachment-${idx}"`);
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (object.contentLength !== undefined) {
      res.setHeader('Content-Length', String(object.contentLength));
    }
    // Immutable per (MessageSid, idx); private so only this session's browser caches it.
    res.setHeader('Cache-Control', 'private, max-age=3600');
    log.info({ providerSid, mediaIndex: idx, inline }, 'streaming inbound MMS media to the dashboard');
    object.body.on('error', (err) => {
      log.error({ err, providerSid, mediaIndex: idx }, 'media stream errored mid-flight');
      res.destroy(err);
    });
    object.body.pipe(res);
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
    // TODO(M1.4): validate assigneeUserId against the users table (users
    // exist since M1.3) — until then any non-empty string is accepted.
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
    const onBroadcastUpdated = (payload: BroadcastUpdatedEvent): void => {
      writeEvent('broadcast.updated', payload);
    };
    const onCaseUpdated = (payload: CaseUpdatedEvent): void => {
      writeEvent('case.updated', payload);
    };
    events.on('conversation.updated', onConversationUpdated);
    events.on('message.persisted', onMessagePersisted);
    events.on('broadcast.updated', onBroadcastUpdated);
    events.on('case.updated', onCaseUpdated);

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
      events.off('broadcast.updated', onBroadcastUpdated);
      events.off('case.updated', onCaseUpdated);
      runWithContext(ctx, () => {
        log.info({ sse: 'disconnected' }, 'sse client disconnected');
      });
      res.end();
    });
  });

  return router;
}
