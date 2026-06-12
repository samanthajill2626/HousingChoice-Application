// Secrets sync (.env files -> Parameter Store). Powers:
//   npm run secrets:push  -- <dev|prod>  parse .env.<env> at the repo root and
//                                        write each key as SecureString
//                                        /hc/<env>/app/<KEY> (overwrite);
//                                        unchanged values are skipped
//   npm run secrets:check -- <dev|prod>  READ-ONLY diff of .env.<env> vs
//                                        Parameter Store: exit 0 all match,
//                                        2 on drift (missing/differing), 1 error
//
// Rules:
//   - account guard FIRST (assertHousingChoiceAccount) and AWS_PROFILE forced
//     into every aws CLI child — exactly like deploy.mjs/tf.mjs.
//   - Terraform/deploy-managed params (MANAGED_BY_OTHERS in
//     scripts/lib/secretsCore.mjs) are refused in the .env files, so this
//     script can never stomp CF_ORIGIN_SECRET, DEPLOYED_TAG, etc.
//   - secret values are NEVER printed — every display goes through maskValue().
//   - .env.dev/.env.prod are gitignored; the committed templates are
//     .env.dev.example / .env.prod.example.
//
// The next deploy hydrates /hc/<env>/app/* into /opt/hc/.env on the instance —
// pushing alone changes nothing on a running box.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertHousingChoiceAccount,
  HC_PROFILE,
  HC_REGION,
  STACK_ENVS,
} from './lib/hcAws.mjs';
import {
  MANAGED_BY_OTHERS,
  findDenylistedKeys,
  maskValue,
  parseDotenv,
} from './lib/secretsCore.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `usage: node scripts/secrets.mjs <push|check> <dev|prod>
  (via npm: npm run secrets:push -- dev, npm run secrets:check -- prod)
  push   write every key in .env.<env> to SSM /hc/<env>/app/<KEY> as SecureString (overwrite)
  check  read-only diff of .env.<env> vs Parameter Store — exit 0 all match, 2 drift, 1 error`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

// --- argv ----------------------------------------------------------------------
const args = process.argv.slice(2);
const mode = args.shift();
if (!['push', 'check'].includes(mode ?? '')) fail(USAGE);
const env = args.shift();
if (!STACK_ENVS.includes(env ?? '')) fail(USAGE);
if (args.length > 0) fail(`Unknown argument "${args[0]}".\n${USAGE}`);

// --- child-process helpers (same shape as deploy.mjs) ----------------------------
// AWS_PROFILE forced into every child (belt + braces with the account guard);
// AWS_PAGER disabled so aws-cli v2 never blocks on a pager.
const childEnv = { ...process.env, AWS_PROFILE: HC_PROFILE, AWS_PAGER: '' };

/** Run a command capturing stdout; returns { status, stdout, stderr }. */
function capture(cmd, cmdArgs) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    env: childEnv,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`Failed to run ${cmd}: ${result.error.message}`);
  return result;
}

/** aws CLI call that dies on non-zero exit; returns trimmed stdout (JSON). */
function aws(cliArgs, what) {
  const result = capture('aws', [...cliArgs, '--region', HC_REGION, '--output', 'json']);
  if (result.status !== 0) {
    fail(`${what} failed (exit ${result.status}):\n${result.stderr ?? ''}`);
  }
  return result.stdout.trim();
}

// --- 1. account guard FIRST ------------------------------------------------------
const identity = await assertHousingChoiceAccount();
console.error(`[secrets] account guard OK: ${identity.Arn} (${identity.Account})`);

// --- 2. read + validate .env.<env> (hard-fails BEFORE any write) -------------------
const envFileName = `.env.${env}`;
const envFile = path.join(repoRoot, envFileName);
if (!existsSync(envFile)) {
  fail(
    `[secrets] ${envFileName} not found at the repo root.\n` +
      `Copy ${envFileName}.example to ${envFileName}, fill in real values, then re-run.\n` +
      `The file is gitignored — never commit it.`,
  );
}

let entries;
try {
  entries = parseDotenv(readFileSync(envFile, 'utf8'));
} catch (err) {
  fail(`[secrets] ${envFileName} is not valid dotenv — ${err.message}`);
}
const keys = Object.keys(entries).sort();
if (keys.length === 0) fail(`[secrets] ${envFileName} contains no keys — nothing to ${mode}.`);

const denylisted = findDenylistedKeys(keys);
if (denylisted.length > 0) {
  fail(
    `[secrets] ${envFileName} contains Terraform/deploy-managed key(s): ${denylisted.join(', ')}.\n` +
      `Those params are owned by \`npm run plan\`/\`apply\` (DEPLOYED_TAG by the deploy script)\n` +
      `and must never be set via the .env files. Remove them and re-run — nothing was written.`,
  );
}

const emptyKeys = keys.filter((key) => entries[key] === '');
if (emptyKeys.length > 0) {
  fail(
    `[secrets] empty value(s) in ${envFileName}: ${emptyKeys.join(', ')} — SSM cannot store\n` +
      `an empty parameter. Fill them in (or delete the lines) and re-run.`,
  );
}

// --- 3. current state of /hc/<env>/app/ (decrypted, for comparison only) -----------
const paramPath = `/hc/${env}/app`;
console.error(`[secrets] ${mode}: ${envFileName} (${keys.length} key(s)) vs ${paramPath}/ ...`);
const pathJson = aws(
  ['ssm', 'get-parameters-by-path', '--path', paramPath, '--with-decryption'],
  'ssm get-parameters-by-path',
);
const ssmParams = new Map(); // KEY -> { value, type }
for (const p of JSON.parse(pathJson).Parameters ?? []) {
  ssmParams.set(p.Name.split('/').pop(), { value: p.Value, type: p.Type });
}

const keyWidth = Math.max(...keys.map((k) => k.length), 'KEY'.length);

// --- 4a. push ----------------------------------------------------------------------
if (mode === 'push') {
  const rows = [];
  const counts = { created: 0, updated: 0, unchanged: 0 };
  for (const key of keys) {
    const current = ssmParams.get(key);
    let status;
    if (current && current.value === entries[key] && current.type === 'SecureString') {
      status = 'unchanged'; // skip the write — no pointless SSM version churn
    } else {
      // `--value=<v>` (one token) so a value starting with `-` can't be
      // mistaken for a CLI option; shell:false means no quoting hazards.
      aws(
        ['ssm', 'put-parameter', '--name', `${paramPath}/${key}`,
          '--type', 'SecureString', `--value=${entries[key]}`, '--overwrite'],
        `ssm put-parameter ${paramPath}/${key}`,
      );
      status = current ? 'updated' : 'created';
    }
    counts[status] += 1;
    rows.push(`  ${key.padEnd(keyWidth)}  ${status.padEnd(9)}  ${maskValue(entries[key])}`);
  }

  console.log(`
==================== secrets push summary (${env}) ====================
  ${'KEY'.padEnd(keyWidth)}  ${'STATUS'.padEnd(9)}  VALUE (masked)
${rows.join('\n')}

  ${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged — ${keys.length} key(s) from ${envFileName}
  next deploy hydrates ${paramPath}/* into /opt/hc/.env on the ${env} instance
======================================================================`);
  process.exit(0);
}

// --- 4b. check (read-only) -----------------------------------------------------------
const rows = [];
const counts = { matches: 0, differs: 0, missing: 0 };
for (const key of keys) {
  const current = ssmParams.get(key);
  let status;
  let ssmShown;
  if (!current) {
    status = 'missing';
    ssmShown = '(not set)';
  } else if (current.value !== entries[key]) {
    status = 'differs';
    ssmShown = maskValue(current.value);
  } else if (current.type !== 'SecureString') {
    status = 'differs'; // right value, wrong type — push rewrites it as SecureString
    ssmShown = `${maskValue(current.value)} (type ${current.type}, want SecureString)`;
  } else {
    status = 'matches';
    ssmShown = maskValue(current.value);
  }
  counts[status] += 1;
  rows.push(`  ${key.padEnd(keyWidth)}  ${status.padEnd(8)}  ${maskValue(entries[key]).padEnd(14)}  ${ssmShown}`);
}

console.log(`
==================== secrets check (${env}, read-only) ====================
  ${'KEY'.padEnd(keyWidth)}  ${'STATUS'.padEnd(8)}  ${'FILE (masked)'.padEnd(14)}  SSM (masked)
${rows.join('\n')}

  ${counts.matches} match, ${counts.differs} differ, ${counts.missing} missing — ${keys.length} key(s) in ${envFileName}`);

// Extra params under the path that are neither in the file nor managed by
// Terraform/deploy — report-only (they never affect the exit code).
const extras = [...ssmParams.keys()]
  .filter((key) => !Object.hasOwn(entries, key) && !MANAGED_BY_OTHERS.includes(key))
  .sort();
if (extras.length > 0) {
  console.log(`\n  extra params under ${paramPath}/ (not in ${envFileName}, not Terraform/deploy-managed):`);
  for (const key of extras) {
    console.log(`    ${key} = ${maskValue(ssmParams.get(key).value)}`);
  }
}
console.log(`==========================================================================`);

if (counts.differs + counts.missing > 0) {
  console.error(`[secrets] DRIFT — fix with: npm run secrets:push -- ${env}`);
  process.exit(2);
}
console.error(`[secrets] in sync: all ${counts.matches} key(s) in ${envFileName} match ${paramPath}/.`);
process.exit(0);
