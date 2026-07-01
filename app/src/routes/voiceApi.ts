// Voice Phase 1 dashboard-facing API routes (spec §5/§7). Two routers, both
// behind requireAuth (via the /api mount):
//
//   POST /api/contacts/:contactId/call            → originate a masked call
//   GET  /api/users/me                            → self view (cell + verify state)
//   POST /api/users/me/cell/verify-start   { cell }
//   POST /api/users/me/cell/verify-confirm { code }
//
// The originate route delegates to the originate SERVICE (services/originateCall)
// — the route only maps its typed refusals to the LOCKED HTTP contracts.
//
// PII (spec §9): NEVER a raw cell/target in a log line — IDs + reason codes only;
// the verification CODE is never logged (it is hashed on the user item).
import { Router } from 'express';
import type { MessagingAdapter } from '../adapters/messaging.js';
import { createMessagingAdapter } from '../adapters/messaging.js';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { mergeContext } from '../lib/context.js';
import { isE164 } from '../lib/phone.js';
import {
  CELL_VERIFY_TTL_MS,
  generateCellVerifyCode,
  hashCellVerifyCode,
  renderCellVerifySms,
} from '../lib/cellVerification.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { createUsersRepo, type UserItem, type UsersRepo } from '../repos/usersRepo.js';
import { type ContactsRepo } from '../repos/contactsRepo.js';
import { type ConversationsRepo } from '../repos/conversationsRepo.js';
import { type MessagesRepo } from '../repos/messagesRepo.js';
import { type EventBus } from '../lib/events.js';
import {
  createOriginateCallService,
  OriginateRefusedError,
  type OriginateCallService,
} from '../services/originateCall.js';

/** OriginateRefusedError.code → { status, body } (contract 1). */
const ORIGINATE_STATUS: Record<OriginateRefusedError['code'], number> = {
  cell_not_verified: 409,
  contact_not_found: 404,
  invalid_phone: 400,
  contact_voice_opted_out: 409,
  voice_not_configured: 503,
};

/**
 * The SELF view of a user (contract 3): userId/email/name/role + the Voice
 * Phase 1 cell fields. NEVER any secret (google_sub, push subs, the code hash).
 *
 * `inbound_voice_line` is DERIVED from the single authoritative holder pointer:
 * the caller passes the current holder's id and the flag appears only when this
 * user IS that holder. The repo no longer stores the boolean; the JSON contract
 * is unchanged.
 */
export function toSelfUserView(u: UserItem, holderUserId?: string): Record<string, unknown> {
  return {
    userId: u.userId,
    email: u.email,
    ...(typeof u.name === 'string' && u.name.length > 0 ? { name: u.name } : { name: u.email }),
    role: u.role,
    ...(typeof u.cell === 'string' && u.cell.length > 0 && { cell: u.cell }),
    ...(typeof u.cell_verified_at === 'string' &&
      u.cell_verified_at.length > 0 && { cell_verified_at: u.cell_verified_at }),
    ...(u.userId === holderUserId && { inbound_voice_line: true }),
  };
}

// ---------------------------------------------------------------------------
// Originate router — mounted at /api/contacts.
// ---------------------------------------------------------------------------
export interface VoiceCallRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  usersRepo?: UsersRepo;
  contactsRepo?: ContactsRepo;
  conversationsRepo?: ConversationsRepo;
  messagesRepo?: MessagesRepo;
  adapter?: MessagingAdapter;
  events?: EventBus;
  /** Test seam: inject the originate service directly (no repos/adapter). */
  originateCallService?: OriginateCallService;
}

export function createVoiceCallRouter(deps: VoiceCallRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const adapter = deps.adapter ?? createMessagingAdapter({ config, logger: deps.logger });
  const originate =
    deps.originateCallService ??
    createOriginateCallService({
      config,
      logger: deps.logger,
      adapter,
      ...(deps.usersRepo !== undefined && { usersRepo: deps.usersRepo }),
      ...(deps.contactsRepo !== undefined && { contactsRepo: deps.contactsRepo }),
      ...(deps.conversationsRepo !== undefined && { conversationsRepo: deps.conversationsRepo }),
      ...(deps.messagesRepo !== undefined && { messagesRepo: deps.messagesRepo }),
      ...(deps.events !== undefined && { events: deps.events }),
    });

  const router = Router();

  // POST /api/contacts/:contactId/call { phone? } → 200 { callSid } (contract 1).
  router.post('/:contactId/call', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    const userId = req.user?.userId;
    if (userId === undefined) {
      // requireAuth already guarantees a user; belt-and-braces.
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const body = (req.body ?? {}) as { phone?: unknown };
    let phone: string | undefined;
    if (body.phone !== undefined && body.phone !== null && body.phone !== '') {
      if (typeof body.phone !== 'string' || !isE164(body.phone)) {
        res.status(400).json({ error: 'invalid_phone' });
        return;
      }
      phone = body.phone;
    }

    try {
      const { callSid } = await originate({
        navigatorUserId: userId,
        contactId,
        ...(phone !== undefined && { phone }),
      });
      res.status(200).json({ callSid });
    } catch (err) {
      if (err instanceof OriginateRefusedError) {
        res.status(ORIGINATE_STATUS[err.code]).json({ error: err.code });
        return;
      }
      throw err; // Express 5 forwards async throws to the error handler.
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Self users router — mounted at /api/users (BEFORE the admin router so the
// literal `me` segment is not captured as a :userId by the admin routes).
// ---------------------------------------------------------------------------
export interface UsersMeRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  usersRepo?: UsersRepo;
  /**
   * The messaging ADAPTER (spec §7): verify-start sends the code DIRECTLY via the
   * adapter — this is INTERNAL staff-line verification, NOT the consumer
   * opt-out/A2P-gated sendMessage service.
   */
  adapter?: MessagingAdapter;
}

export function createUsersMeRouter(deps: UsersMeRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const users = deps.usersRepo ?? createUsersRepo({ logger: deps.logger });
  const adapter = deps.adapter ?? createMessagingAdapter({ config, logger: deps.logger });

  const router = Router();

  // GET /api/users/me → the self view (contract 3).
  router.get('/me', async (req: AuthedRequest, res) => {
    const userId = req.user?.userId;
    if (userId === undefined) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const user = await users.findById(userId);
    if (!user) {
      // The session survived but the user is gone — treat as unauthenticated.
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    // Derive the badge from the single holder pointer (fetch the holder id once).
    const holderId = (await users.getInboundVoiceLineHolder())?.userId;
    res.json({ user: toSelfUserView(user, holderId) });
  });

  // POST /api/users/me/cell/verify-start { cell } → 200 { ok:true } (contract 2).
  router.post('/me/cell/verify-start', async (req: AuthedRequest, res) => {
    const userId = req.user?.userId;
    if (userId === undefined) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const body = (req.body ?? {}) as { cell?: unknown };
    if (typeof body.cell !== 'string' || !isE164(body.cell)) {
      res.status(400).json({ error: 'invalid_cell' });
      return;
    }
    const cell = body.cell;

    // Generate + store the HASHED code with a TTL; RESET attempts (repo).
    const code = generateCellVerifyCode();
    const expiresAt = new Date(Date.now() + CELL_VERIFY_TTL_MS).toISOString();
    await users.startCellVerification(userId, cell, hashCellVerifyCode(code), expiresAt);

    // Send the code via the messaging ADAPTER directly (internal staff line — NOT
    // the consumer opt-out-gated sendMessage service). Best-effort: an adapter
    // throw (e.g. SMS disabled) → 503 so the UI can explain. NEVER log the code
    // or the cell (PII/secret, §9).
    try {
      await adapter.sendMessage({ to: cell, body: renderCellVerifySms(code) });
    } catch (err) {
      log.error({ err, userId }, 'cell verify-start: sending the code failed — adapter unavailable');
      res.status(503).json({ error: 'sms_unavailable' });
      return;
    }
    log.info({ userId }, 'cell verify-start: code sent');
    res.status(200).json({ ok: true });
  });

  // POST /api/users/me/cell/verify-confirm { code } → 200 { ok, cell_verified_at }.
  router.post('/me/cell/verify-confirm', async (req: AuthedRequest, res) => {
    const userId = req.user?.userId;
    if (userId === undefined) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const body = (req.body ?? {}) as { code?: unknown };
    if (typeof body.code !== 'string' || body.code.length === 0) {
      res.status(400).json({ error: 'invalid_code' });
      return;
    }

    const result = await users.confirmCellVerification(
      userId,
      hashCellVerifyCode(body.code),
      new Date().toISOString(),
    );
    if (result.ok) {
      log.info({ userId }, 'cell verify-confirm: cell verified');
      res.status(200).json({ ok: true, cell_verified_at: result.cell_verified_at });
      return;
    }
    switch (result.reason) {
      case 'expired':
        res.status(410).json({ error: 'code_expired' });
        return;
      case 'too_many_attempts':
        res.status(429).json({ error: 'too_many_attempts' });
        return;
      // mismatch / no_pending both surface as a generic invalid_code (never
      // reveal whether a pending code exists).
      default:
        res.status(400).json({ error: 'invalid_code' });
        return;
    }
  });

  return router;
}
