// Deploy driver (M0.5). Powers:
//   npm run deploy:dev                  build ARM64 image -> push ECR -> roll EC2
//   npm run deploy:dev -- --tag <t>     re-deploy an EXISTING ECR tag (rollback path)
//   npm run deploy:dev -- --list        list recent ECR tags + current DEPLOYED_TAG
//   npm run deploy:prod ...             same, prod (refuses until the stack exists, M0.6)
//
// Flow (no --tag):
//   1. account guard (assertHousingChoiceAccount) + terraform outputs for the env
//   2. tag = <env>-<git short sha>-<UTC yyyyMMddHHmmss>; dirty tree = warn only
//   3. docker buildx build --platform linux/arm64 --provenance=false --push
//   4. SSM Run Command on the instance (payload base64-encoded to dodge
//      PowerShell->JSON->bash quoting): ECR login, hydrate /opt/hc/.env from
//      Parameter Store (+ computed HC_IMAGE / HC_LOG_GROUP_*), write the
//      repo's docker-compose.yml, compose pull+up, localhost health-check
//      gate, image prune ONLY on success
//   5. operator-side verification: CloudFront /health must return 200
//   6. record the released tag in SSM /hc/<env>/app/DEPLOYED_TAG
//
// Rollback = `npm run deploy:<env> -- --tag <previous tag>` (skips build/push).

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertHousingChoiceAccount,
  HC_PROFILE,
  HC_REGION,
  STACK_ENVS,
} from './lib/hcAws.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `usage: node scripts/deploy.mjs <dev|prod> [--tag <existing-ecr-tag>] [--list]
  (via npm: npm run deploy:dev, npm run deploy:dev -- --tag dev-abc1234-20260611120000, npm run deploy:dev -- --list)`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

// --- argv --------------------------------------------------------------------
const args = process.argv.slice(2);
const env = args.shift();
if (!STACK_ENVS.includes(env ?? '')) fail(USAGE);

let requestedTag;
let listOnly = false;
while (args.length > 0) {
  const arg = args.shift();
  if (arg === '--list') listOnly = true;
  else if (arg === '--tag') {
    requestedTag = args.shift();
    if (!requestedTag) fail(`--tag requires a value.\n${USAGE}`);
  } else fail(`Unknown argument "${arg}".\n${USAGE}`);
}

// --- child-process helpers ----------------------------------------------------
// AWS_PROFILE forced into every child (belt + braces with the account guard);
// AWS_PAGER disabled so aws-cli v2 never blocks on a pager.
const childEnv = { ...process.env, AWS_PROFILE: HC_PROFILE, AWS_PAGER: '' };

/** Run a command streaming output; die on non-zero exit. */
function run(cmd, cmdArgs, opts = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
    env: childEnv,
    ...opts,
  });
  if (result.error) fail(`Failed to run ${cmd}: ${result.error.message}`);
  if (result.status !== 0) fail(`${cmd} ${cmdArgs[0] ?? ''} exited with code ${result.status}.`);
  return result;
}

/** Run a command capturing stdout; returns { status, stdout, stderr }. */
function capture(cmd, cmdArgs, opts = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    env: childEnv,
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  if (result.error) fail(`Failed to run ${cmd}: ${result.error.message}`);
  return result;
}

/** capture() that dies on non-zero exit and returns trimmed stdout. */
function captureOrDie(cmd, cmdArgs, what, opts = {}) {
  const result = capture(cmd, cmdArgs, opts);
  if (result.status !== 0) {
    fail(`${what} failed (exit ${result.status}):\n${result.stderr ?? ''}${result.stdout ?? ''}`);
  }
  return result.stdout.trim();
}

function aws(cliArgs, what) {
  return captureOrDie('aws', [...cliArgs, '--region', HC_REGION, '--output', 'json'], what);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- 1. account guard + stack outputs -----------------------------------------
const identity = await assertHousingChoiceAccount();
console.error(`[deploy] account guard OK: ${identity.Arn} (${identity.Account})`);

const envDir = path.join(repoRoot, 'infra', 'envs', env);
const tfOut = capture('terraform', [`-chdir=${envDir}`, 'output', '-json']);
let outputs = {};
if (tfOut.status === 0) {
  try {
    outputs = JSON.parse(tfOut.stdout);
  } catch {
    outputs = {};
  }
}
const required = ['ecr_repository_url', 'instance_id', 'cloudfront_domain_name'];
if (tfOut.status !== 0 || required.some((k) => !outputs[k]?.value)) {
  if (env === 'prod') {
    fail('[deploy] prod stack not applied yet (M0.6) — nothing to deploy to.');
  }
  fail(
    `[deploy] could not read terraform outputs for hc-${env} ` +
      `(need ${required.join(', ')}). Run \`npm run plan -- ${env}\` / apply first.\n` +
      (tfOut.stderr ?? ''),
  );
}

const ecrUrl = outputs.ecr_repository_url.value; // <acct>.dkr.ecr.<region>.amazonaws.com/hc-<env>-app
const registry = ecrUrl.split('/')[0];
const repoName = ecrUrl.split('/').slice(1).join('/');
const instanceId = outputs.instance_id.value;
const cfDomain = outputs.cloudfront_domain_name.value;
const deployedTagParam = `/hc/${env}/app/DEPLOYED_TAG`;

// --- --list: recent ECR tags + current DEPLOYED_TAG ----------------------------
if (listOnly) {
  const imagesJson = aws(
    ['ecr', 'describe-images', '--repository-name', repoName,
      '--query', 'sort_by(imageDetails,&imagePushedAt)'],
    'ecr describe-images',
  );
  const images = JSON.parse(imagesJson).slice(-10).reverse();
  let deployedTag = '(not set)';
  const cur = capture('aws', ['ssm', 'get-parameter', '--name', deployedTagParam,
    '--query', 'Parameter.Value', '--output', 'text', '--region', HC_REGION]);
  if (cur.status === 0) deployedTag = cur.stdout.trim();

  console.log(`Current DEPLOYED_TAG (${deployedTagParam}): ${deployedTag}\n`);
  console.log(`Last ${images.length} images in ${repoName} (newest first):`);
  for (const img of images) {
    const tags = (img.imageTags ?? ['<untagged>']).join(', ');
    const mb = (img.imageSizeInBytes / 1024 / 1024).toFixed(1);
    const marker = (img.imageTags ?? []).includes(deployedTag) ? '  <== DEPLOYED' : '';
    console.log(`  ${img.imagePushedAt}  ${mb.padStart(7)} MB  ${tags}${marker}`);
  }
  console.log(`\nRollback: npm run deploy:${env} -- --tag <tag>`);
  process.exit(0);
}

// --- 2/3. resolve tag: build+push, or verify an existing one (rollback) --------
const startedAt = Date.now();
let tag;

if (requestedTag) {
  // Rollback / re-deploy path: tag must already exist in ECR.
  const check = capture('aws', ['ecr', 'describe-images', '--repository-name', repoName,
    '--image-ids', `imageTag=${requestedTag}`, '--region', HC_REGION, '--output', 'json']);
  if (check.status !== 0) {
    fail(
      `[deploy] tag "${requestedTag}" not found in ${repoName} — refusing.\n` +
        `List candidates with: npm run deploy:${env} -- --list`,
    );
  }
  tag = requestedTag;
  console.error(`[deploy] using EXISTING image tag ${tag} (build/push skipped)`);
} else {
  // Dirty tree is a warning only (solo dev), but the sha goes in the tag, so flag it.
  const dirty = capture('git', ['status', '--porcelain']).stdout.trim();
  if (dirty) {
    console.error(
      `[deploy] WARNING: git working tree is dirty — the image will NOT match ` +
        `the tagged commit:\n${dirty}`,
    );
  }
  const sha = capture('git', ['rev-parse', '--short', 'HEAD']).stdout.trim() || 'nogit';
  const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14); // UTC yyyyMMddHHmmss
  tag = `${env}-${sha}-${ts}`;

  console.error(`[deploy] building ${ecrUrl}:${tag} (linux/arm64)`);
  const password = captureOrDie(
    'aws', ['ecr', 'get-login-password', '--region', HC_REGION], 'ecr get-login-password');
  const login = capture('docker', ['login', '--username', 'AWS', '--password-stdin', registry],
    { input: password });
  if (login.status !== 0) fail(`docker login to ${registry} failed:\n${login.stderr}`);

  // --provenance=false => single-manifest image (no attestation manifests),
  // which keeps ECR lifecycle counting and tag listing sane.
  run('docker', ['buildx', 'build', '--platform', 'linux/arm64',
    '-t', `${ecrUrl}:${tag}`, '--provenance=false', '--push', '.']);
  console.error(`[deploy] build+push done in ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

const imageRef = `${ecrUrl}:${tag}`;

// --- 4. roll the instance via SSM Run Command ----------------------------------
// The remote payload is base64-encoded (single safe-charset token survives
// PowerShell -> JSON -> SSM -> bash unmangled). The repo's docker-compose.yml
// is embedded the same way — the repo file stays the single source of truth.
const composeB64 = readFileSync(path.join(repoRoot, 'docker-compose.yml')).toString('base64');

const remoteScript = `#!/bin/bash
# Generated by scripts/deploy.mjs — runs on the instance via SSM Run Command.
set -euo pipefail
ENV="${env}"
REGION="${HC_REGION}"
IMAGE_REF="${imageRef}"
REGISTRY="${registry}"
cd /opt/hc

echo "== ecr login (instance role)"
aws ecr get-login-password --region "$REGION" \\
  | docker login --username AWS --password-stdin "$REGISTRY"

# Record what was running BEFORE this deploy (operator's rollback pointer).
PREVIOUS_IMAGE=""
if [ -f .env ]; then
  PREVIOUS_IMAGE="$(grep -E '^HC_IMAGE=' .env | head -n1 | cut -d= -f2- || true)"
fi
echo "HC_PREVIOUS_IMAGE=$PREVIOUS_IMAGE"

echo "== hydrate /opt/hc/.env from parameter store (/hc/$ENV/app)"
umask 077
TMP_ENV="$(mktemp /opt/hc/.env.XXXXXX)"
aws ssm get-parameters-by-path --path "/hc/$ENV/app" --with-decryption \\
  --region "$REGION" --query 'Parameters[].[Name,Value]' --output text \\
  | while IFS=$'\\t' read -r name value; do
      printf '%s=%s\\n' "$(basename "$name")" "$value" >> "$TMP_ENV"
    done
{
  printf 'AWS_REGION=%s\\n' "$REGION"
  printf 'HC_IMAGE=%s\\n' "$IMAGE_REF"
  printf 'HC_LOG_GROUP_APP=/hc/%s/app\\n' "$ENV"
  printf 'HC_LOG_GROUP_WORKER=/hc/%s/worker\\n' "$ENV"
} >> "$TMP_ENV"
chmod 600 "$TMP_ENV"
mv "$TMP_ENV" /opt/hc/.env

echo "== write /opt/hc/docker-compose.yml (from the repo copy)"
echo "${composeB64}" | base64 -d > /opt/hc/docker-compose.yml

echo "== docker compose pull + up"
docker compose pull -q
docker compose up -d --remove-orphans

echo "== health-check gate: curl localhost:8080/health (up to 12 x 5s)"
ok=""
for attempt in $(seq 1 12); do
  if curl -fsS -m 5 http://localhost:8080/health > /tmp/hc-health.json 2>/dev/null; then
    ok=1; break
  fi
  echo "  attempt $attempt/12: not healthy yet"
  sleep 5
done
if [ -z "$ok" ]; then
  echo "HEALTH CHECK FAILED — compose state + last 50 log lines follow"
  docker compose ps || true
  docker compose logs --no-color --tail 50 || true
  echo "HC_DEPLOY_RESULT=FAILED"
  exit 1
fi
echo "health: $(cat /tmp/hc-health.json)"

echo "== confirm BOTH services are running"
app_state="$(docker inspect -f '{{.State.Status}}' "$(docker compose ps -q app)" 2>/dev/null || echo missing)"
worker_state="$(docker inspect -f '{{.State.Status}}' "$(docker compose ps -q worker)" 2>/dev/null || echo missing)"
echo "container states: app=$app_state worker=$worker_state"
if [ "$app_state" != "running" ] || [ "$worker_state" != "running" ]; then
  docker compose ps || true
  docker compose logs --no-color --tail 50 || true
  echo "HC_DEPLOY_RESULT=FAILED"
  exit 1
fi
# Worker has no health endpoint: require its boot log line (docker's dual-
# logging cache keeps 'compose logs' readable despite the awslogs driver).
if docker compose logs --no-color --tail 20 worker | grep -q 'worker ready'; then
  echo "worker boot line found"
else
  echo "WORKER BOOT LINE MISSING — last 50 worker log lines follow"
  docker compose logs --no-color --tail 50 worker || true
  echo "HC_DEPLOY_RESULT=FAILED"
  exit 1
fi

echo "== prune old images (only after health-check success; 10GB root volume)"
docker image prune -af | tail -n 1 || true
df -h / | tail -n 1
echo "HC_DEPLOY_RESULT=OK"
`;

const scriptB64 = Buffer.from(remoteScript, 'utf8').toString('base64');
console.error(`[deploy] sending SSM Run Command to ${instanceId} (${env})...`);
const sendJson = aws(
  ['ssm', 'send-command',
    '--instance-ids', instanceId,
    '--document-name', 'AWS-RunShellScript',
    '--comment', `hc deploy ${tag}`,
    '--parameters', JSON.stringify({
      commands: [`echo ${scriptB64} | base64 -d > /tmp/hc-deploy.sh`, 'bash /tmp/hc-deploy.sh'],
      executionTimeout: ['1800'],
    })],
  'ssm send-command',
);
const commandId = JSON.parse(sendJson).Command.CommandId;
console.error(`[deploy] command ${commandId} — polling...`);

let invocation;
for (;;) {
  await sleep(5000);
  const inv = capture('aws', ['ssm', 'get-command-invocation',
    '--command-id', commandId, '--instance-id', instanceId,
    '--region', HC_REGION, '--output', 'json']);
  if (inv.status !== 0) {
    // InvocationDoesNotExist for a few seconds right after send is normal.
    if ((inv.stderr ?? '').includes('InvocationDoesNotExist')) continue;
    fail(`ssm get-command-invocation failed:\n${inv.stderr}`);
  }
  invocation = JSON.parse(inv.stdout);
  if (!['Pending', 'InProgress', 'Delayed'].includes(invocation.Status)) break;
  console.error(`[deploy]   ${invocation.Status}...`);
}

console.error(`\n--- instance output ---------------------------------------------`);
if (invocation.StandardOutputContent) console.log(invocation.StandardOutputContent);
if (invocation.StandardErrorContent) console.error(invocation.StandardErrorContent);
console.error(`--- end instance output ------------------------------------------\n`);

const previousImage =
  invocation.StandardOutputContent?.match(/^HC_PREVIOUS_IMAGE=(.*)$/m)?.[1]?.trim() ?? '';
const previousTag = previousImage.includes(':') ? previousImage.split(':').pop() : '';

if (invocation.Status !== 'Success') {
  fail(
    `[deploy] SSM Run Command finished with status ${invocation.Status} — the new image did ` +
      `NOT pass the on-instance health check (see logs above).\n` +
      (previousTag
        ? `Roll back with: npm run deploy:${env} -- --tag ${previousTag}`
        : `No previous image recorded; pick a tag via: npm run deploy:${env} -- --list`),
  );
}

// --- 5. operator-side verification through CloudFront ---------------------------
const healthUrl = `https://${cfDomain}/health`;
console.error(`[deploy] verifying ${healthUrl} ...`);
let cfStatus = 'FAILED';
for (let attempt = 1; attempt <= 8; attempt++) {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) });
    const body = await res.text();
    if (res.status === 200) {
      cfStatus = `200 ${body}`;
      break;
    }
    console.error(`  attempt ${attempt}/8: HTTP ${res.status}`);
  } catch (err) {
    console.error(`  attempt ${attempt}/8: ${err.message}`);
  }
  await sleep(5000);
}
if (cfStatus === 'FAILED') {
  fail(
    `[deploy] CloudFront /health did not return 200 (instance-side health check DID pass — ` +
      `suspect CloudFront/origin config). DEPLOYED_TAG was NOT updated.\n` +
      (previousTag ? `Roll back with: npm run deploy:${env} -- --tag ${previousTag}` : ''),
  );
}

// --- 6. record the released tag (rollback pointer for future deploys) -----------
aws(['ssm', 'put-parameter', '--name', deployedTagParam, '--type', 'String',
  '--value', tag, '--overwrite'], 'ssm put-parameter DEPLOYED_TAG');

// --- 7. summary -----------------------------------------------------------------
const totalS = Math.round((Date.now() - startedAt) / 1000);
console.log(`
========================= deploy summary =========================
  env:           ${env}
  deployed tag:  ${tag}${requestedTag ? '  (existing image — rollback/redeploy)' : ''}
  previous tag:  ${previousTag || '(none — first deploy)'}
  cloudfront:    ${cfStatus}
  DEPLOYED_TAG:  ${deployedTagParam} = ${tag}
  duration:      ${totalS}s
  rollback:      npm run deploy:${env} -- --tag ${previousTag || '<tag>'}
==================================================================`);
