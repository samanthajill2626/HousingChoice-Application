// First-login auto-provisioning (M1.3): a verified, allowlisted identity is
// looked up by email and created on first sight with role 'va'. Promotion to
// 'admin' happens ONLY via the operator script (npm run user:role) — the
// login path can never mint an admin.
//
// Race safety: userIdForEmail() is deterministic, so two concurrent first
// logins target the SAME key and usersRepo.createIfAbsent's conditional
// write lets exactly one create through; the loser re-reads the winner's
// item by id (base-table Get — no eventually-consistent GSI read).
import type { AuthIdentity } from '../adapters/auth.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import { userIdForEmail, type UserItem, type UsersRepo } from '../repos/usersRepo.js';

export interface UserProvisioningDeps {
  usersRepo: UsersRepo;
  auditRepo: AuditRepo;
  logger?: Logger;
}

export interface FindOrCreateResult {
  user: UserItem;
  /** True when THIS login created the user (audited as user_provisioned). */
  created: boolean;
}

export async function findOrCreateUser(
  deps: UserProvisioningDeps,
  identity: AuthIdentity,
): Promise<FindOrCreateResult> {
  const log = deps.logger ?? defaultLogger;
  const email = identity.email.trim().toLowerCase();
  const now = new Date().toISOString();

  const existing = await deps.usersRepo.findByEmail(email);
  if (existing) {
    if (existing.google_sub !== identity.sub) {
      // Same Workspace email, different Google account id — a deleted-and-
      // recreated account. Email (Workspace-admin controlled) stays the
      // anchor; flag it, don't block it.
      log.warn(
        { userId: existing.userId },
        'login google_sub differs from the provisioned google_sub (account recreated?)',
      );
    }
    await deps.usersRepo.touchLastLogin(existing.userId, now);
    return { user: { ...existing, last_login_at: now }, created: false };
  }

  const candidate: UserItem = {
    userId: userIdForEmail(email),
    email,
    google_sub: identity.sub,
    role: 'va', // first login is ALWAYS a va; npm run user:role promotes
    created_at: now,
    last_login_at: now,
  };
  const created = await deps.usersRepo.createIfAbsent(candidate);
  if (!created) {
    // Lost the provisioning race — the deterministic id makes the winner's
    // item directly readable.
    const winner = await deps.usersRepo.findById(candidate.userId);
    if (!winner) {
      throw new Error(`user ${candidate.userId} vanished between conditional create and re-read`);
    }
    await deps.usersRepo.touchLastLogin(winner.userId, now);
    return { user: { ...winner, last_login_at: now }, created: false };
  }

  // §5 mandate: provisioning is an audit-trail event. Payload (email) lives
  // in DynamoDB, never in logs.
  await deps.auditRepo.append(`users#${candidate.userId}`, 'user_provisioned', {
    email,
    role: candidate.role,
    google_sub: identity.sub,
  });
  return { user: candidate, created: true };
}
