// Pure core of the user-invite ops script (scripts/userInvite.mjs): argv
// validation, email normalization, the deterministic userId, the invited-user
// item shape, and the user_invited audit-item shape. NOTHING here touches AWS —
// every export is unit-tested offline in app/test/userInviteCore.test.ts (the
// secretsCore.mjs / userRoleCore.mjs pattern).

import { createHash } from 'node:crypto';

/** The two roles, admin|va (renamed from the doc's role names; README deviations). */
export const USER_ROLES = Object.freeze(['admin', 'va']);

export const STACK_ENVS = Object.freeze(['dev', 'prod']);

/**
 * Lowercase + trim — MUST match the app's normalization byte-for-byte
 * (usersRepo.normalizeEmail; the byEmail GSI key and the userId hash both
 * depend on it).
 *
 * @param {string} email
 * @returns {string}
 */
export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

/**
 * Deterministic userId for an email: `usr_<sha256(normalized email) hex/24>`.
 * MUST match app/src/repos/usersRepo.ts userIdForEmail exactly — the invite
 * targets the same key the login lookup derives, so a re-invite is idempotent
 * and the login can find the record.
 *
 * @param {string} email
 * @returns {string}
 */
export function userIdForEmail(email) {
  return `usr_${createHash('sha256').update(normalizeEmail(email), 'utf8').digest('hex').slice(0, 24)}`;
}

/**
 * Validate `<env> <email> <admin|va>`. Returns { env, email, role } (email
 * normalized) or throws with a message naming the bad argument.
 *
 * @param {string[]} argv positional args after the script name
 * @returns {{ env: string, email: string, role: string }}
 */
export function parseUserInviteArgs(argv) {
  const [env, rawEmail, role, ...rest] = argv;
  if (!STACK_ENVS.includes(env ?? '')) {
    throw new Error(`first argument must be one of: ${STACK_ENVS.join(', ')} (got "${env ?? ''}")`);
  }
  const email = normalizeEmail(rawEmail ?? '');
  // Light shape check only — DynamoDB's conditional write is the real guard.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`second argument must be an email address (got "${rawEmail ?? ''}")`);
  }
  if (!USER_ROLES.includes(role ?? '')) {
    throw new Error(`third argument must be one of: ${USER_ROLES.join(', ')} (got "${role ?? ''}")`);
  }
  if (rest.length > 0) {
    throw new Error(`unexpected extra argument "${rest[0]}"`);
  }
  return { env, email, role };
}

/**
 * The invited-user item (DynamoDB-JSON, for `aws dynamodb put-item`). Mirrors
 * usersRepo.invite exactly: status 'invited', session_epoch 1, NO google_sub
 * (written on first login), created_at. The caller adds the
 * attribute_not_exists(userId) condition so a re-invite is a no-op.
 *
 * @param {{ userId: string, email: string, role: string, nowIso: string }} input
 * @returns {Record<string, unknown>}
 */
export function buildInvitedUserItem({ userId, email, role, nowIso }) {
  return {
    userId: { S: userId },
    email: { S: email },
    role: { S: role },
    status: { S: 'invited' },
    session_epoch: { N: '1' },
    created_at: { S: nowIso },
  };
}

/**
 * The user_invited audit event item (plain JS values — the caller marshals).
 * Follows the auditRepo conventions: entityKey `users#<userId>`, SK ts
 * `<ISO ts>#<suffix>` (suffix keeps same-millisecond events from colliding
 * while preserving chronological string sort). The actor is the invoking
 * IAM principal (the admin performing the invite). The email is an
 * audit-relevant operator action — recorded in the audit trail, never in
 * steady-state logs.
 *
 * @param {{ userId: string, email: string, role: string, invitedBy: string,
 *           nowIso: string, suffix: string }} input
 * @returns {Record<string, unknown>}
 */
export function buildInvitedAuditItem({ userId, email, role, invitedBy, nowIso, suffix }) {
  return {
    entityKey: `users#${userId}`,
    ts: `${nowIso}#${suffix}`,
    event_type: 'user_invited',
    payload: { email, role, invited_by: invitedBy },
  };
}
