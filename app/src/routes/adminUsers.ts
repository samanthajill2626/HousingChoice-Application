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
 */
function toAdminUserView(u: UserItem): Record<string, unknown> {
  return {
    userId: u.userId,
    email: u.email,
    role: u.role,
    status: u.status ?? null,
    created_at: u.created_at,
    last_login_at: u.last_login_at ?? null,
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
    res.json({ users: all.map(toAdminUserView) });
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

    await users.setRole(userId, role);
    // Bump the session epoch so the new role takes effect ≤60s (matching
    // `npm run user:role`) — the user's active sessions re-read at their next
    // request within the epoch-cache TTL.
    await users.bumpSessionEpoch(userId);
    await audit.append(`users#${userId}`, 'role_changed', {
      from,
      to: role,
      actor: req.user?.userId,
    });
    log.info({ userId, from, to: role, actor: req.user?.userId }, 'user role changed via API');

    const updated = await users.findById(userId);
    res.json({ user: toAdminUserView(updated ?? { ...target, role }), changed: true });
  });

  return router;
}
