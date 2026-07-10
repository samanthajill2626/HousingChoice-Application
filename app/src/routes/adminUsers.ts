// Admin user-management routes (M1.4) — the FIRST requireRole('admin')
// surface. Mounted under /api/users (behind requireAuth); every route here
// also requires the admin role. These wrap the SAME usersRepo functions the
// `npm run user:invite` / `user:role` ops scripts use — the scripts remain
// the CLI path; this is the in-app path.
//
//   GET   /api/users               → { users: [...] }   (list — secrets stripped)
//   POST  /api/users   { email, role } → 201 { user }    (invite; idempotent)
//   PATCH /api/users/:userId/role { role } → { user }    (promote/demote + epoch bump)
//
// GUARDS on PATCH role (lockout prevention): an admin cannot demote
// THEMSELVES, and the LAST remaining admin cannot be demoted.
import { Router } from 'express';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { requireRole, type AuthedRequest } from '../middleware/auth.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import {
  createUsersRepo,
  displayNameOf,
  isUserRole,
  normalizeEmail,
  USER_ROLES,
  type UserItem,
  type UsersRepo,
} from '../repos/usersRepo.js';

export interface AdminUsersRouterDeps {
  logger?: Logger;
  usersRepo?: UsersRepo;
  auditRepo?: AuditRepo;
}

/** Light email shape check (the real gate is invite idempotency); mirrors the ops script. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The admin-list projection of a user: NO google_sub, NO push_subscriptions
 * (a device's push endpoints are not admin-relevant and are not someone
 * else's business). Exactly the fields the brief names.
 *
 * The `inbound_voice_line` badge is DERIVED from the single authoritative holder
 * pointer (usersRepo): the caller passes `holderUserId` (the current holder's
 * id, fetched once) and this view emits `inbound_voice_line: true` only for that
 * user. The repo never stores the boolean anymore — the JSON contract is
 * unchanged (the flag still appears on the holder's view; absent otherwise).
 */
function toAdminUserView(u: UserItem, holderUserId?: string): Record<string, unknown> {
  return {
    userId: u.userId,
    email: u.email,
    name: displayNameOf(u),
    role: u.role,
    status: u.status ?? null,
    created_at: u.created_at,
    last_login_at: u.last_login_at ?? null,
    // Voice Phase 1 (spec §6/§7): the team page shows each user's cell +
    // verification state + the single inbound-voice-line badge. The verification
    // CODE HASH / pending fields are NEVER projected (secret).
    ...(typeof u.cell === 'string' && u.cell.length > 0 && { cell: u.cell }),
    ...(typeof u.cell_verified_at === 'string' &&
      u.cell_verified_at.length > 0 && { cell_verified_at: u.cell_verified_at }),
    ...(u.userId === holderUserId && { inbound_voice_line: true }),
  };
}

export function createAdminUsersRouter(deps: AdminUsersRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const users = deps.usersRepo ?? createUsersRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });

  const router = Router();

  // Every route here is admin-only.
  router.use(requireRole('admin'));

  // GET /api/users — list the team. SCAN of a tiny, bounded table (the repo
  // comments the tradeoff); secrets are stripped in the projection.
  router.get('/', async (_req, res) => {
    const all = await users.listAll();
    // Fetch the single holder ONCE, then derive each user's badge from it.
    const holderId = (await users.getInboundVoiceLineHolder())?.userId;
    res.json({ users: all.map((u) => toAdminUserView(u, holderId)) });
  });

  // POST /api/users { email, role } — invite (idempotent).
  router.post('/', async (req: AuthedRequest, res) => {
    const payload = (req.body ?? {}) as { email?: unknown; role?: unknown };
    const rawEmail = payload.email;
    if (typeof rawEmail !== 'string' || !EMAIL_RE.test(rawEmail.trim().toLowerCase())) {
      res.status(400).json({ error: 'email must be a valid email address' });
      return;
    }
    if (!isUserRole(payload.role)) {
      res.status(400).json({ error: `role must be one of: ${USER_ROLES.join(', ')}` });
      return;
    }
    const email = normalizeEmail(rawEmail);
    const { created, user } = await users.invite({ email, role: payload.role });
    if (created) {
      // The audit event records the email (an audit-relevant operator action,
      // mirroring scripts/userInvite.mjs); actor = the inviting admin.
      await audit.append(`users#${user.userId}`, 'user_invited', {
        email,
        role: payload.role,
        actor: req.user?.userId,
      });
    }
    log.info({ userId: user.userId, role: user.role, created, actor: req.user?.userId }, 'user invited via API');
    // 201 whether or not THIS call minted it — POST is idempotent (invite()).
    res.status(201).json({ user: toAdminUserView(user), created });
  });

  // PATCH /api/users/:userId/role { role } — promote/demote.
  router.patch('/:userId/role', async (req: AuthedRequest, res) => {
    const userId = String(req.params['userId'] ?? '');
    const payload = (req.body ?? {}) as { role?: unknown };
    if (!isUserRole(payload.role)) {
      res.status(400).json({ error: `role must be one of: ${USER_ROLES.join(', ')}` });
      return;
    }
    const role = payload.role;

    const target = await users.findById(userId);
    if (!target) {
      res.status(404).json({ error: 'user_not_found' });
      return;
    }
    const from = target.role;
    const isDemotion = from === 'admin' && role !== 'admin';

    // LOCKOUT GUARDS (order matters): both prevent the team locking itself out
    // of admin. The LAST-ADMIN guard is the more fundamental invariant (the
    // table must never reach zero admins), so it is checked FIRST — a sole
    // admin demoting themselves is refused for THAT reason. The SELF guard
    // then catches a non-last admin trying to demote themselves (a foot-gun
    // even when others remain). Counting admins via the list scan is
    // acceptable — the users table is tiny and bounded (the team), the same
    // tradeoff the list endpoint takes.
    if (isDemotion) {
      const admins = (await users.listAll()).filter((u) => u.role === 'admin');
      if (admins.length <= 1) {
        res.status(409).json({ error: 'cannot_demote_last_admin' });
        return;
      }
    }
    if (req.user?.userId === userId && role !== 'admin') {
      res.status(409).json({ error: 'cannot_demote_self' });
      return;
    }

    if (from === role) {
      // No change — return the user unchanged, no epoch bump (the ops script
      // short-circuits the same way).
      res.json({ user: toAdminUserView(target), changed: false });
      return;
    }

    // ATOMIC role change + session revocation (H1): ONE write flips the role
    // and bumps the session epoch, so the new role can never land without
    // revoking the user's sessions (the new role takes effect ≤60s, matching
    // `npm run user:role`). Replaces the old setRole-then-bumpSessionEpoch pair.
    await users.setRoleAndRevoke(userId, role);

    // ZERO-ADMIN LOCKOUT — verify-after-write-and-rollback (C2). The pre-write
    // last-admin guard above is the fast path, but two admins demoting each
    // other CONCURRENTLY can both pass it (each sees the other still admin) and
    // race to zero admins. So after a demotion, RE-LIST admins; if none remain,
    // the write we just made was the one that emptied the table — roll it back
    // (re-promote, atomic) and 409. Each concurrent demoter runs this check, so
    // whichever lands last heals the table: the end state always has ≥1 admin.
    if (isDemotion) {
      const adminsNow = (await users.listAll()).filter((u) => u.role === 'admin');
      if (adminsNow.length === 0) {
        await users.setRoleAndRevoke(userId, 'admin'); // undo — re-promote
        log.warn(
          { userId, actor: req.user?.userId },
          'demotion would leave zero admins — rolled back (verify-after-write)',
        );
        res.status(409).json({ error: 'cannot_demote_last_admin' });
        return;
      }
    }

    await audit.append(`users#${userId}`, 'role_changed', {
      from,
      to: role,
      actor: req.user?.userId,
    });
    log.info({ userId, from, to: role, actor: req.user?.userId }, 'user role changed via API');

    const updated = await users.findById(userId);
    res.json({ user: toAdminUserView(updated ?? { ...target, role }), changed: true });
  });

  // DELETE /api/users/:userId -- remove a team member (HARD delete). GUARDS
  // (lockout + routing safety), each 409 with a stable code, in this order:
  //   1. cannot_remove_last_admin -- the table must never reach zero admins.
  //      (Every caller is an admin, so this fires when the sole admin removes
  //      themselves -- the more fundamental invariant, checked first, exactly
  //      like the PATCH-role path.)
  //   2. cannot_remove_self       -- a non-last admin can't remove their own
  //      account (a foot-gun even when other admins remain).
  //   3. voice_line_assigned      -- the target holds the single inbound voice
  //      line; it must be reassigned before removal (removal must not silently
  //      drop inbound call routing).
  // On success the row is deleted; sessionMiddleware revokes the removed user's
  // sessions within the epoch-cache TTL (<=60s). Re-inviting the same email
  // later lands on the same deterministic key cleanly.
  router.delete('/:userId', async (req: AuthedRequest, res) => {
    const userId = String(req.params['userId'] ?? '');

    const target = await users.findById(userId);
    if (!target) {
      res.status(404).json({ error: 'user_not_found' });
      return;
    }

    // 1. LAST-ADMIN guard (checked first -- the fundamental invariant).
    if (target.role === 'admin') {
      const admins = (await users.listAll()).filter((u) => u.role === 'admin');
      if (admins.length <= 1) {
        res.status(409).json({ error: 'cannot_remove_last_admin' });
        return;
      }
    }

    // 2. SELF guard.
    if (req.user?.userId === userId) {
      res.status(409).json({ error: 'cannot_remove_self' });
      return;
    }

    // 3. VOICE-LINE guard -- the single inbound-voice-line holder must be
    // reassigned first (removal doesn't silently drop inbound routing).
    const holder = await users.getInboundVoiceLineHolder();
    if (holder?.userId === userId) {
      res.status(409).json({ error: 'voice_line_assigned' });
      return;
    }

    await users.remove(userId);
    // Audit records the removed user's email + role (an audit-relevant operator
    // action, like user_invited); actor = the acting admin.
    await audit.append(`users#${userId}`, 'user_removed', {
      email: target.email,
      role: target.role,
      actor: req.user?.userId,
    });
    log.info({ userId, actor: req.user?.userId }, 'user removed via API');
    res.json({ removed: true });
  });

  // POST /api/users/:userId/inbound-voice-line — assign the SINGLE inbound-voice-
  // line holder (spec §6). PRECONDITION: the target has a verified cell (else 409
  // cell_not_verified — an unverified cell must never be dialed by inbound). The
  // repo enforces single-holder (clears the prior holder). 200 { user }.
  router.post('/:userId/inbound-voice-line', async (req: AuthedRequest, res) => {
    const userId = String(req.params['userId'] ?? '');
    const target = await users.findById(userId);
    if (!target) {
      res.status(404).json({ error: 'user_not_found' });
      return;
    }
    if (typeof target.cell_verified_at !== 'string' || target.cell_verified_at.length === 0) {
      res.status(409).json({ error: 'cell_not_verified' });
      return;
    }
    await users.assignInboundVoiceLine(userId);
    await audit.append(`users#${userId}`, 'inbound_voice_line_assigned', {
      actor: req.user?.userId,
    });
    log.info({ userId, actor: req.user?.userId }, 'inbound voice line assigned via API');
    const updated = await users.findById(userId);
    // This user is now the holder — derive the badge with holderId = userId.
    res.json({ user: toAdminUserView(updated ?? target, userId) });
  });

  // DELETE /api/users/:userId/inbound-voice-line — unassign (spec §6). 200 { user }.
  router.delete('/:userId/inbound-voice-line', async (req: AuthedRequest, res) => {
    const userId = String(req.params['userId'] ?? '');
    const target = await users.findById(userId);
    if (!target) {
      res.status(404).json({ error: 'user_not_found' });
      return;
    }
    await users.clearInboundVoiceLine(userId);
    await audit.append(`users#${userId}`, 'inbound_voice_line_cleared', {
      actor: req.user?.userId,
    });
    log.info({ userId, actor: req.user?.userId }, 'inbound voice line cleared via API');
    const updated = await users.findById(userId);
    // Just cleared — this user is no longer the holder (holderId undefined ⇒ no badge).
    res.json({ user: toAdminUserView(updated ?? target) });
  });

  return router;
}
