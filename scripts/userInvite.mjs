// User invites (M1.3, INVITE-FIRST — README deviations 2026-06-12). Powers:
//   npm run user:invite -- <dev|prod> <email> <admin|va>
//
// Auth is invite-gated: a Google login succeeds ONLY if a user record already
// exists for that email (the login path never auto-creates a user). THIS script
// pre-creates ("invites") that record. The very first admin is bootstrapped
// with `npm run user:invite -- <env> <email> admin`.
//
// Rules (the secrets.mjs / userRole.mjs conventions):
//   - account guard FIRST (assertHousingChoiceAccount) and AWS_PROFILE forced
//     into every aws CLI child — exactly like deploy.mjs/secrets.mjs.
//   - direct DynamoDB against the hc-<env>- tables: a conditional put at the
//     deterministic userId (attribute_not_exists(userId)) so a re-invite is a
//     no-op, then a user_invited audit event (entityKey users#<userId>).
//   - IDEMPOTENT: if the user already exists, report "already exists, role
//     unchanged" and exit 0 WITHOUT modifying role/status/epoch.
//   - the invited record has email + role + status 'invited' + session_epoch 1
//     and NO google_sub — google_sub + status 'active' are written by the app
//     on the user's first successful login.
//
// TODO(admin-user-management-ui): an in-app dashboard UI will offer invite/list/
// role-change (the /api/users surface exists); this script remains the bootstrap path.
//
// Pure logic (argv validation, item shapes) lives in
// scripts/lib/userInviteCore.mjs and is unit-tested offline.

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertHousingChoiceAccount, HC_PROFILE, HC_REGION } from './lib/hcAws.mjs';
import {
  buildInvitedAuditItem,
  buildInvitedUserItem,
  parseUserInviteArgs,
  userIdForEmail,
} from './lib/userInviteCore.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `usage: node scripts/userInvite.mjs <dev|prod> <email> <admin|va>
  (via npm: npm run user:invite -- dev someone@housingchoice.org admin)
  Pre-creates ("invites") a user so they can log in. Auth is invite-gated:
  a Google login is refused unless an invite already exists for that email.
  Idempotent — re-inviting an existing user is a no-op (role left unchanged).
  Bootstrap the first admin: npm run user:invite -- <env> <you@domain> admin`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

// --- argv ----------------------------------------------------------------------
let parsed;
try {
  parsed = parseUserInviteArgs(process.argv.slice(2));
} catch (err) {
  fail(`${err.message}\n${USAGE}`);
}
const { env, email, role } = parsed;

// --- child-process helpers (same shape as secrets.mjs / userRole.mjs) -------------
const childEnv = { ...process.env, AWS_PROFILE: HC_PROFILE, AWS_PAGER: '' };

/** aws CLI call; returns { status, stdout, stderr } (caller decides on errors). */
function awsTry(cliArgs) {
  const result = spawnSync('aws', [...cliArgs, '--region', HC_REGION, '--output', 'json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    env: childEnv,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`Failed to run aws: ${result.error.message}`);
  return result;
}

/** aws CLI call that dies on non-zero exit; returns trimmed stdout (JSON). */
function aws(cliArgs, what) {
  const result = awsTry(cliArgs);
  if (result.status !== 0) {
    fail(`${what} failed (exit ${result.status}):\n${result.stderr ?? ''}`);
  }
  return result.stdout.trim();
}

// --- 1. account guard FIRST ------------------------------------------------------
const identity = await assertHousingChoiceAccount();
console.error(`[user:invite] account guard OK: ${identity.Arn} (${identity.Account})`);

const usersTable = `hc-${env}-users`;
const auditTable = `hc-${env}-audit_events`;
const userId = userIdForEmail(email);
const nowIso = new Date().toISOString();

// --- 2. conditional put: invite ONLY if the user does not exist -------------------
// attribute_not_exists(userId) makes this idempotent — a re-invite trips the
// condition and we exit 0 below WITHOUT touching role/status/epoch.
const item = buildInvitedUserItem({ userId, email, role, nowIso });
const put = awsTry([
  'dynamodb', 'put-item',
  '--table-name', usersTable,
  '--item', JSON.stringify(item),
  '--condition-expression', 'attribute_not_exists(userId)',
]);

if (put.status !== 0) {
  // ConditionalCheckFailed = already invited/active: idempotent no-op.
  if (/ConditionalCheckFailed/i.test(put.stderr ?? '')) {
    console.log(
      `[user:invite] ${email} (${userId}) already exists on ${env} — role unchanged, nothing to do.`,
    );
    process.exit(0);
  }
  fail(`dynamodb put-item ${usersTable} failed (exit ${put.status}):\n${put.stderr ?? ''}`);
}

// --- 3. user_invited audit event (auditRepo conventions) --------------------------
const auditItem = buildInvitedAuditItem({
  userId,
  email,
  role,
  invitedBy: identity.Arn,
  nowIso,
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
          email: { S: auditItem.payload.email },
          role: { S: auditItem.payload.role },
          invited_by: { S: auditItem.payload.invited_by },
        },
      },
    }),
  ],
  `dynamodb put-item ${auditTable}`,
);

console.log(
  `[user:invite] invited ${email} (${userId}) as '${role}' on ${env}.\n` +
    `They can now sign in with Google; the FIRST login activates the account\n` +
    `(writes google_sub, flips status invited -> active). Promote/demote later\n` +
    `with: npm run user:role -- ${env} ${email} <admin|va>`,
);
