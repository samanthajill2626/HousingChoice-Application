// User role changes (M1.3). Powers:
//   npm run user:role -- <dev|prod> <email> <admin|va>
//
// First login auto-provisions every allowlisted user as 'va' (the login path
// can never mint an admin) — THIS script is the only promotion/demotion
// path. The operator promotes the first admin with it.
//
// Rules (the secrets.mjs conventions):
//   - account guard FIRST (assertHousingChoiceAccount) and AWS_PROFILE forced
//     into every aws CLI child — exactly like deploy.mjs/secrets.mjs.
//   - direct DynamoDB against the hc-<env>- tables: users via the byEmail
//     GSI, then a conditional update, then a role_changed audit event
//     (entityKey users#<userId> — the auditRepo convention).
//   - the user must already exist: they log in once (auto-provisioned 'va'),
//     then get promoted. This script never creates users.
//   - role changes take effect on the user's next login or session refresh
//     (sessions re-validate against the users table daily — middleware/auth).
//
// Pure logic (argv validation, audit-item shape) lives in
// scripts/lib/userRoleCore.mjs and is unit-tested offline.

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertHousingChoiceAccount, HC_PROFILE, HC_REGION } from './lib/hcAws.mjs';
import { buildRoleChangedAuditItem, parseUserRoleArgs } from './lib/userRoleCore.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `usage: node scripts/userRole.mjs <dev|prod> <email> <admin|va>
  (via npm: npm run user:role -- dev someone@housingchoice.org admin)
  Sets an EXISTING user's role. Users are auto-provisioned as 'va' on their
  first allowlisted Google login — have them log in once, then run this.`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

// --- argv ----------------------------------------------------------------------
let parsed;
try {
  parsed = parseUserRoleArgs(process.argv.slice(2));
} catch (err) {
  fail(`${err.message}\n${USAGE}`);
}
const { env, email, role } = parsed;

// --- child-process helpers (same shape as secrets.mjs) ----------------------------
const childEnv = { ...process.env, AWS_PROFILE: HC_PROFILE, AWS_PAGER: '' };

/** aws CLI call that dies on non-zero exit; returns trimmed stdout (JSON). */
function aws(cliArgs, what) {
  const result = spawnSync('aws', [...cliArgs, '--region', HC_REGION, '--output', 'json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    env: childEnv,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`Failed to run aws: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${what} failed (exit ${result.status}):\n${result.stderr ?? ''}`);
  }
  return result.stdout.trim();
}

// --- 1. account guard FIRST ------------------------------------------------------
const identity = await assertHousingChoiceAccount();
console.error(`[user:role] account guard OK: ${identity.Arn} (${identity.Account})`);

const usersTable = `hc-${env}-users`;
const auditTable = `hc-${env}-audit_events`;

// --- 2. find the user via the byEmail GSI -----------------------------------------
const queryJson = aws(
  [
    'dynamodb', 'query',
    '--table-name', usersTable,
    '--index-name', 'byEmail',
    '--key-condition-expression', 'email = :e',
    '--expression-attribute-values', JSON.stringify({ ':e': { S: email } }),
  ],
  `dynamodb query ${usersTable}/byEmail`,
);
const items = JSON.parse(queryJson).Items ?? [];
if (items.length === 0) {
  fail(
    `[user:role] no user with email ${email} in ${usersTable}.\n` +
      `Users are created on their FIRST allowlisted Google login (auto-provisioned as 'va').\n` +
      `Have them sign in once at the ${env} dashboard, then re-run this.`,
  );
}
const userId = items[0]?.userId?.S;
const currentRole = items[0]?.role?.S;
if (!userId) fail(`[user:role] byEmail item for ${email} carries no userId — refusing to continue.`);

if (currentRole === role) {
  console.log(`[user:role] ${email} (${userId}) already has role '${role}' — nothing to do.`);
  process.exit(0);
}

// --- 3. conditional role update ----------------------------------------------------
aws(
  [
    'dynamodb', 'update-item',
    '--table-name', usersTable,
    '--key', JSON.stringify({ userId: { S: userId } }),
    '--update-expression', 'SET #role = :role',
    '--condition-expression', 'attribute_exists(userId)',
    '--expression-attribute-names', JSON.stringify({ '#role': 'role' }),
    '--expression-attribute-values', JSON.stringify({ ':role': { S: role } }),
  ],
  `dynamodb update-item ${usersTable}`,
);

// --- 4. role_changed audit event (auditRepo conventions) ---------------------------
const auditItem = buildRoleChangedAuditItem({
  userId,
  email,
  from: currentRole ?? '(unset)',
  to: role,
  changedBy: identity.Arn,
  nowIso: new Date().toISOString(),
  suffix: randomUUID().slice(0, 8),
});
aws(
  [
    'dynamodb', 'put-item',
    '--table-name', auditTable,
    '--item', JSON.stringify({
      entityKey: { S: auditItem.entityKey },
      ts: { S: auditItem.ts },
      event_type: { S: auditItem.event_type },
      payload: {
        M: {
          from: { S: auditItem.payload.from },
          to: { S: auditItem.payload.to },
          email: { S: auditItem.payload.email },
          changed_by: { S: auditItem.payload.changed_by },
        },
      },
    }),
  ],
  `dynamodb put-item ${auditTable}`,
);

console.log(
  `[user:role] ${email} (${userId}): ${currentRole ?? '(unset)'} -> ${role} on ${env}.\n` +
    `Takes effect on their next login or daily session refresh (active sessions re-validate within 24h).`,
);
