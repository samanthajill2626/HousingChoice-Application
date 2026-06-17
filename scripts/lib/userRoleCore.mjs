// Pure core of the user-role ops script (scripts/userRole.mjs): argv
// validation, email normalization, and audit-item construction. NOTHING here
// touches AWS — every export is unit-tested offline in
// app/test/userRoleCore.test.ts (the secretsCore.mjs pattern).

/** The two roles, admin|va (renamed from the doc's role names; README deviations). */
export const USER_ROLES = Object.freeze(['admin', 'va']);

export const STACK_ENVS = Object.freeze(['dev', 'prod']);

/**
 * Lowercase + trim — MUST match the app's normalization (usersRepo stores
 * lowercased emails; the byEmail GSI is queried with this exact value).
 *
 * @param {string} email
 * @returns {string}
 */
export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

/**
 * Validate `<env> <email> <admin|va>`. Returns { env, email, role } (email
 * normalized) or throws with a message naming the bad argument.
 *
 * @param {string[]} argv positional args after the script name
 * @returns {{ env: string, email: string, role: string }}
 */
export function parseUserRoleArgs(argv) {
  const [env, rawEmail, role, ...rest] = argv;
  if (!STACK_ENVS.includes(env ?? '')) {
    throw new Error(`first argument must be one of: ${STACK_ENVS.join(', ')} (got "${env ?? ''}")`);
  }
  const email = normalizeEmail(rawEmail ?? '');
  // Light shape check only — the real gate is "does this user exist".
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
 * The single conditional update that flips the role AND bumps session_epoch
 * atomically (DynamoDB-JSON values for the aws CLI). The epoch bump revokes
 * the user's active sessions within the app's ~60s epoch-cache TTL, so the
 * new role applies at their next sign-in — not at the 24h cookie refresh.
 * if_not_exists(…, 1) + 1, NOT ADD: legacy items lacking session_epoch read
 * as epoch 1 in the app (usersRepo.sessionEpochOf), so the first bump must
 * land on 2 — mirrors usersRepo.bumpSessionEpoch exactly.
 *
 * @param {string} role the new role ('admin' | 'va')
 * @returns {{ updateExpression: string, conditionExpression: string,
 *             expressionAttributeNames: Record<string, string>,
 *             expressionAttributeValues: Record<string, unknown> }}
 */
export function buildRoleUpdate(role) {
  return {
    updateExpression:
      'SET #role = :role, session_epoch = if_not_exists(session_epoch, :base) + :one',
    conditionExpression: 'attribute_exists(userId)',
    expressionAttributeNames: { '#role': 'role' },
    expressionAttributeValues: { ':role': { S: role }, ':base': { N: '1' }, ':one': { N: '1' } },
  };
}

/**
 * The role_changed audit event item (plain JS values — the caller marshals).
 * Follows the auditRepo conventions exactly: entityKey `users#<userId>`,
 * SK ts `<ISO ts>#<suffix>` (suffix keeps same-millisecond events from
 * colliding while preserving chronological string sort).
 *
 * @param {{ userId: string, email: string, from: string, to: string,
 *           changedBy: string, nowIso: string, suffix: string }} input
 * @returns {Record<string, unknown>}
 */
export function buildRoleChangedAuditItem({ userId, email, from, to, changedBy, nowIso, suffix }) {
  return {
    entityKey: `users#${userId}`,
    ts: `${nowIso}#${suffix}`,
    event_type: 'role_changed',
    payload: { from, to, email, changed_by: changedBy },
  };
}
