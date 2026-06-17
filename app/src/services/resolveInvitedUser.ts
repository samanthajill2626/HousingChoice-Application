// Invite-gated login resolution (M1.3, operator decision 2026-06-12: auth is
// INVITE-FIRST — see README deviations). A verified, allowlisted identity is
// looked up by email; a login succeeds ONLY if an admin already invited that
// email (a user record exists). No record → AccessDeniedError → the callback
// returns a distinct 403. There is no auto-provision: the login path can
// neither create a user nor mint a role.
//
// On the first successful login of an invited user we ACTIVATE the record:
// write google_sub, flip status → 'active', stamp last_login_at (one update;
// the google_sub write is conditional-safe so two racing first logins don't
// clobber). Subsequent logins just touch last_login_at.
//
// Audit (doc §5 — payloads in DynamoDB, never in logs): 'user_invited' is
// emitted by the invite path (the ops script / future admin UI), 'user_
// activated' on first login, 'role_changed' by the role script. The old
// 'user_provisioned' auto-create semantics are gone.
import type { AuthIdentity } from '../adapters/auth.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import type { UserItem, UsersRepo } from '../repos/usersRepo.js';

export interface ResolveInvitedUserDeps {
  usersRepo: UsersRepo;
  auditRepo: AuditRepo;
  logger?: Logger;
}

/**
 * Thrown when a verified, allowlisted identity has no invite (no user record).
 * The callback maps this to a distinct 403 ("not invited") — separate from the
 * domain-allowlist 403.
 */
export class AccessDeniedError extends Error {
  constructor(
    message: string,
    /** Stable machine-readable reason code (logged; never the email). */
    readonly reason: 'not_invited',
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export interface ResolveInvitedUserResult {
  user: UserItem;
  /** True when THIS login activated an invited record (audited user_activated). */
  activated: boolean;
}

/**
 * Resolve the user for a verified identity that already cleared the domain
 * allowlist (kept as defense-in-depth in routes/auth.ts). Throws
 * AccessDeniedError when the email has no invite; otherwise activates the
 * record on first login and returns it.
 */
export async function resolveInvitedUser(
  deps: ResolveInvitedUserDeps,
  identity: AuthIdentity,
): Promise<ResolveInvitedUserResult> {
  const log = deps.logger ?? defaultLogger;
  const now = new Date().toISOString();

  const existing = await deps.usersRepo.findByEmail(identity.email);
  if (!existing) {
    // No invite — access denied. The email is PII and the userId does not
    // exist for a non-invited identity, so the throw carries no identity; the
    // callback logs the email DOMAIN + reason code only.
    throw new AccessDeniedError('login refused: no invite for this email', 'not_invited');
  }

  // First login of an invited record: activate it.
  if (existing.status === 'invited' || existing.google_sub === undefined) {
    // name wiring is Task 2 (identity.name not yet threaded in); pass undefined so
    // the signature change compiles — name refresh will be added in the next task.
    await deps.usersRepo.activateOnLogin(existing.userId, identity.sub, undefined, now);
    // §5 mandate: activation is an audit-trail event. Payload (email) lives in
    // DynamoDB, never in logs.
    await deps.auditRepo.append(`users#${existing.userId}`, 'user_activated', {
      email: existing.email,
      role: existing.role,
      google_sub: identity.sub,
    });
    log.info({ userId: existing.userId, role: existing.role }, 'invited user activated on first login');
    return {
      user: { ...existing, google_sub: identity.sub, status: 'active', last_login_at: now },
      activated: true,
    };
  }

  // Already active. Anchor stays the Workspace-admin-controlled email: a
  // changed google_sub (deleted-and-recreated account) is flagged, not blocked.
  if (existing.google_sub !== identity.sub) {
    log.warn(
      { userId: existing.userId },
      'login google_sub differs from the activated google_sub (account recreated?)',
    );
  }
  // name wiring is Task 2; pass undefined for now.
  await deps.usersRepo.touchLastLogin(existing.userId, undefined, now);
  return { user: { ...existing, last_login_at: now }, activated: false };
}
