// Deploy driver (M0.5/M0.6). Powers:
//   npm run deploy:dev                    build ARM64 image -> push ECR -> roll EC2
//   npm run deploy:dev -- --tag <t>       re-deploy an EXISTING ECR tag (rollback path)
//   npm run deploy:dev -- --list          list recent ECR tags + current DEPLOYED_TAG
//   npm run deploy:prod -- --promote <t>  PROD ONLY: copy tag <t> from hc-dev-app to
//                                         hc-prod-app (ECR manifest copy — no docker
//                                         pull/push, same bytes), then deploy it
//   npm run deploy:prod -- --tag/--list   same as dev, against the prod stack
//
// Flow (no --tag):
//   1. account guard (assertHousingChoiceAccount) + terraform outputs for the env
//   1b. SECRETS GATE: abort unless .env.<env> matches /hc/<env>/app/* (read-only
//      `secrets:check` — never mutates SSM). The instance hydrates SSM into
//      /opt/hc/.env on every roll (step 4), so a key left in .env but never
//      pushed would silently ship missing (the FOUNDER_CELL-not-ringing bug).
//      The gate refuses the deploy on drift; --skip-secrets bypasses it.
//   2. tag = <env>-<git short sha>-<UTC yyyyMMddHHmmss>; dirty tree = warn only
//   3. docker buildx build --platform linux/arm64 --provenance=false --push
//   4. SSM Run Command on the instance (payload base64-encoded to dodge
//      PowerShell->JSON->bash quoting): ECR login, hydrate /opt/hc/.env from
//      Parameter Store (+ computed HC_IMAGE / HC_LOG_GROUP_*), write the
//      repo's docker-compose.yml, compose pull+up, localhost health-check
//      gate, image prune ONLY on success
//   5. operator-side verification: CloudFront /health 200 (the reliable gate),
//      then the CANONICAL custom-domain /health (PUBLIC_BASE_URL) once cut over —
//      proves the real front door (DNS + ACM cert + alias + app) is reachable
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

const USAGE = `usage: node scripts/deploy.mjs <dev|prod> [--tag <existing-ecr-tag>] [--promote <dev-ecr-tag>] [--list] [--skip-secrets]
  (via npm: npm run deploy:dev, npm run deploy:dev -- --tag dev-abc1234-20260611120000,
   npm run deploy:prod -- --promote dev-abc1234-20260611120000, npm run deploy:prod -- --list)
  --promote is prod-only: it copies the tag's manifest from hc-dev-app into hc-prod-app
  (same digest, no rebuild) and then deploys it — the M0.6 promote-don't-rebuild path.
  --skip-secrets bypasses the pre-roll .env<->SSM drift gate (emergencies / when
  .env.<env> isn't on this machine; SSM must already be correct).`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

// --- argv --------------------------------------------------------------------
const args = process.argv.slice(2);
const env = args.shift();
if (!STACK_ENVS.includes(env ?? '')) fail(USAGE);

let requestedTag;
let promoteTag;
let listOnly = false;
let skipSecrets = false;
while (args.length > 0) {
  const arg = args.shift();
  if (arg === '--list') listOnly = true;
  else if (arg === '--skip-secrets') skipSecrets = true;
  else if (arg === '--tag') {
    requestedTag = args.shift();
    if (!requestedTag) fail(`--tag requires a value.\n${USAGE}`);
  } else if (arg === '--promote') {
    promoteTag = args.shift();
    if (!promoteTag) fail(`--promote requires a value.\n${USAGE}`);
  } else fail(`Unknown argument "${arg}".\n${USAGE}`);
}

if (promoteTag && requestedTag) fail(`--promote and --tag are mutually exclusive.\n${USAGE}`);
if (promoteTag && listOnly) fail(`--promote and --list are mutually exclusive.\n${USAGE}`);
if (promoteTag && env !== 'prod') {
  fail(
    `[deploy] --promote is prod-only: it copies an image from hc-dev-app into hc-prod-app.\n` +
      `For dev, re-deploy an existing tag with: npm run deploy:dev -- --tag <tag>`,
  );
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

/** Poll <url> up to `attempts` times (5s apart). Returns "200 <body>" or "FAILED".
 *  An HTTPS fetch also validates the TLS chain, so a 200 here proves the cert too. */
async function verifyHealth(url, attempts = 8) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const body = await res.text();
      if (res.status === 200) return `200 ${body}`;
      console.error(`  attempt ${attempt}/${attempts}: HTTP ${res.status}`);
    } catch (err) {
      console.error(`  attempt ${attempt}/${attempts}: ${err.message}`);
    }
    if (attempt < attempts) await sleep(5000);
  }
  return 'FAILED';
}

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

// --- 1b. secrets gate: SSM must match .env.<env> before we roll the instance ----
// Step 4 hydrates /hc/<env>/app/* into /opt/hc/.env on the box, so a key that's
// in .env.<env> but never `secrets:push`-ed to SSM ships SILENTLY MISSING (the
// FOUNDER_CELL-not-ringing class of bug). `secrets:check` is READ-ONLY — it
// never writes SSM — but it exits 2 on drift, so we gate the whole deploy on it
// here, before spending a build. This runs for fresh builds AND --tag/--promote
// rolls (every roll re-hydrates SSM). --skip-secrets bypasses (emergencies, or
// when .env.<env> isn't on this machine and SSM is already known-correct).
if (skipSecrets) {
  console.error('[deploy] --skip-secrets: skipping the .env<->SSM drift gate (SSM assumed correct)');
} else {
  console.error(`[deploy] secrets gate: checking .env.${env} matches /hc/${env}/app/* (read-only)...`);
  const check = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'secrets.mjs'), 'check', env], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
    env: childEnv,
  });
  if (check.error) fail(`[deploy] could not run the secrets check: ${check.error.message}`);
  if (check.status === 2) {
    fail(
      `[deploy] ABORTED: .env.${env} and /hc/${env}/app/* are out of sync (drift table above).\n` +
        `  Reconcile SSM first:  npm run secrets:push -- ${env}\n` +
        `  Then re-deploy:       npm run deploy:${env}\n` +
        `  (Or bypass with --skip-secrets if you know SSM is already correct.)`,
    );
  }
  if (check.status !== 0) {
    fail(`[deploy] secrets check failed (exit ${check.status}) — see output above. Deploy aborted.`);
  }
  console.error(`[deploy] secrets gate OK: .env.${env} matches /hc/${env}/app/*`);
}

// --- 2a. --promote: ECR manifest copy hc-dev-app -> hc-prod-app (same tag) ------
// No docker pull/push: batch-get-image hands us the manifest dev runs, put-image
// registers the IDENTICAL manifest (same digest) in the prod repo. ECR's PutImage
// refuses unless every referenced blob already exists in the TARGET repo
// (LayersNotFoundException), so each blob is first cross-repo MOUNTED via the
// registry API (POST /v2/<dest>/blobs/uploads/?mount=<digest>&from=<source>) —
// a server-side, zero-byte-transfer operation ECR supports natively. With
// --provenance=false builds this is a single manifest; manifest lists / OCI
// indexes are handled anyway by copying each referenced child manifest first.
const ECR_MANIFEST_MEDIA_TYPES = [
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
];

/** batch-get-image for one imageId (e.g. "imageTag=x" / "imageDigest=sha256:..."). */
function ecrGetManifest(repository, imageId, what) {
  const json = aws(
    ['ecr', 'batch-get-image', '--repository-name', repository,
      '--image-ids', imageId,
      '--accepted-media-types', ...ECR_MANIFEST_MEDIA_TYPES],
    what,
  );
  const parsed = JSON.parse(json);
  const image = parsed.images?.[0];
  if (!image?.imageManifest) {
    fail(`${what}: no manifest returned for ${imageId} in ${repository}:\n` +
      JSON.stringify(parsed.failures ?? parsed, null, 2));
  }
  return image; // { imageManifest, imageManifestMediaType, imageId: { imageDigest, imageTag? } }
}

/**
 * Ensure every blob a (non-index) manifest references exists in destRepo.
 * Tries the registry-API cross-repo mount first (zero-byte, 201 on success);
 * ECR currently declines mounts (202 = plain upload session), so the fallback
 * streams the blob registry->registry through this machine with the sha256
 * verified before commit. Either way the digests are bit-identical — this is
 * a copy of what dev runs, never a rebuild. Idempotent (HEAD skips existing).
 */
async function ecrEnsureBlobs(sourceRepo, destRepo, manifestJson, registryHost, authHeader) {
  const { createHash } = await import('node:crypto');
  const blobs = [
    ...(manifestJson.config ? [manifestJson.config] : []),
    ...(manifestJson.layers ?? []),
  ];
  for (const { digest, size } of blobs) {
    const head = await fetch(`https://${registryHost}/v2/${destRepo}/blobs/${digest}`, {
      method: 'HEAD',
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(30_000),
    });
    if (head.status === 200) continue; // already there

    // Open an upload session, asking for a cross-repo mount.
    const open = await fetch(
      `https://${registryHost}/v2/${destRepo}/blobs/uploads/` +
        `?mount=${encodeURIComponent(digest)}&from=${encodeURIComponent(sourceRepo)}`,
      { method: 'POST', headers: { Authorization: authHeader }, signal: AbortSignal.timeout(60_000) },
    );
    if (open.status === 201) {
      console.error(`[promote]   mounted blob ${digest} (server-side)`);
      continue;
    }
    if (open.status !== 202) {
      fail(`[promote] could not open upload session for ${digest} -> ${destRepo}: ` +
        `HTTP ${open.status}\n${await open.text()}`);
    }
    const uploadUrl = new URL(open.headers.get('location'), `https://${registryHost}`);

    // Mount declined (ECR does not support cross-repo mounts) — copy the blob.
    console.error(`[promote]   copying blob ${digest} (${((size ?? 0) / 1024 / 1024).toFixed(1)} MB)...`);
    const get = await fetch(`https://${registryHost}/v2/${sourceRepo}/blobs/${digest}`, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(300_000),
    });
    if (get.status !== 200) {
      fail(`[promote] blob download ${sourceRepo}@${digest} failed: HTTP ${get.status}`);
    }
    const body = Buffer.from(await get.arrayBuffer());
    const actual = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    if (actual !== digest) {
      fail(`[promote] blob ${digest} digest mismatch after download (got ${actual}) — aborting.`);
    }

    const patch = await fetch(uploadUrl, {
      method: 'PATCH',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/octet-stream',
        'Content-Range': `0-${body.length - 1}`,
      },
      body,
      signal: AbortSignal.timeout(300_000),
    });
    // Spec says PATCH -> 202 then PUT?digest= -> 201, but ECR returns 201
    // straight from the PATCH for uploads it commits in one chunk. Accept
    // both, then confirm the blob is registered (HEAD) and PUT only if not.
    if (patch.status !== 202 && patch.status !== 201) {
      fail(`[promote] blob upload (PATCH) for ${digest} failed: HTTP ${patch.status}\n${await patch.text()}`);
    }
    const registered = await fetch(`https://${registryHost}/v2/${destRepo}/blobs/${digest}`, {
      method: 'HEAD',
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(30_000),
    });
    if (registered.status !== 200) {
      const commitUrl = new URL(patch.headers.get('location') ?? uploadUrl, `https://${registryHost}`);
      commitUrl.searchParams.set('digest', digest);
      const put = await fetch(commitUrl, {
        method: 'PUT',
        headers: { Authorization: authHeader },
        signal: AbortSignal.timeout(60_000),
      });
      if (put.status !== 201) {
        fail(`[promote] blob commit (PUT) for ${digest} failed: HTTP ${put.status}\n${await put.text()}`);
      }
    }
    console.error(`[promote]   copied blob ${digest}`);
  }
}

/** put-image, tolerating ImageAlreadyExistsException (identical manifest = done). */
function ecrPutManifest(repository, image, imageTag) {
  const putArgs = ['ecr', 'put-image', '--repository-name', repository,
    '--image-manifest', image.imageManifest,
    '--region', HC_REGION, '--output', 'json'];
  if (image.imageManifestMediaType) {
    putArgs.push('--image-manifest-media-type', image.imageManifestMediaType);
  }
  if (imageTag) putArgs.push('--image-tag', imageTag);
  const put = capture('aws', putArgs);
  if (put.status !== 0) {
    if ((put.stderr ?? '').includes('ImageAlreadyExistsException')) {
      console.error(`[promote]   ${repository}: manifest already present — OK (idempotent)`);
      return;
    }
    fail(`[promote] ecr put-image to ${repository} failed:\n${put.stderr ?? ''}${put.stdout ?? ''}`);
  }
}

if (promoteTag) {
  const sourceRepo = 'hc-dev-app';
  console.error(`[promote] copying ${sourceRepo}:${promoteTag} -> ${repoName}:${promoteTag} (manifest copy, no rebuild)`);

  // The tag must exist in the DEV repo — that is the thing being promoted.
  const src = capture('aws', ['ecr', 'describe-images', '--repository-name', sourceRepo,
    '--image-ids', `imageTag=${promoteTag}`, '--region', HC_REGION, '--output', 'json']);
  if (src.status !== 0) {
    fail(
      `[promote] tag "${promoteTag}" not found in ${sourceRepo} — refusing.\n` +
        `List candidates with: npm run deploy:dev -- --list`,
    );
  }
  const srcDigest = JSON.parse(src.stdout).imageDetails[0].imageDigest;

  const dst = capture('aws', ['ecr', 'describe-images', '--repository-name', repoName,
    '--image-ids', `imageTag=${promoteTag}`, '--region', HC_REGION, '--output', 'json']);
  if (dst.status === 0) {
    const dstDigest = JSON.parse(dst.stdout).imageDetails[0].imageDigest;
    if (dstDigest !== srcDigest) {
      fail(
        `[promote] tag "${promoteTag}" already exists in ${repoName} with a DIFFERENT digest\n` +
          `  ${sourceRepo}: ${srcDigest}\n  ${repoName}: ${dstDigest}\n` +
          `Refusing to overwrite — investigate before promoting.`,
      );
    }
    console.error(`[promote] already promoted (digest ${srcDigest}) — skipping copy`);
  } else {
    const topImage = ecrGetManifest(sourceRepo, `imageTag=${promoteTag}`, 'ecr batch-get-image (dev)');
    const mediaType = topImage.imageManifestMediaType ?? '';

    // Registry-API auth for the blob mounts (same token docker login would use).
    const ecrPassword = captureOrDie(
      'aws', ['ecr', 'get-login-password', '--region', HC_REGION], 'ecr get-login-password');
    const authHeader = `Basic ${Buffer.from(`AWS:${ecrPassword}`).toString('base64')}`;

    // Manifest list / OCI index: register every referenced child manifest in the
    // prod repo FIRST (by digest, untagged), or putting the index would fail.
    if (mediaType.includes('manifest.list') || mediaType.includes('image.index')) {
      const children = (JSON.parse(topImage.imageManifest).manifests ?? []);
      console.error(`[promote] manifest list/index with ${children.length} child manifest(s)`);
      for (const child of children) {
        console.error(`[promote]   copying child ${child.digest} (${child.mediaType ?? 'unknown'})`);
        const childImage = ecrGetManifest(sourceRepo, `imageDigest=${child.digest}`,
          `ecr batch-get-image (dev child ${child.digest})`);
        await ecrEnsureBlobs(sourceRepo, repoName, JSON.parse(childImage.imageManifest),
          registry, authHeader);
        ecrPutManifest(repoName, childImage);
      }
    } else {
      await ecrEnsureBlobs(sourceRepo, repoName, JSON.parse(topImage.imageManifest),
        registry, authHeader);
    }
    ecrPutManifest(repoName, topImage, promoteTag);

    // Hard verification: the promoted tag in prod must resolve to the SAME digest.
    const verify = aws(['ecr', 'describe-images', '--repository-name', repoName,
      '--image-ids', `imageTag=${promoteTag}`], 'ecr describe-images (prod, post-promote)');
    const promotedDigest = JSON.parse(verify).imageDetails[0].imageDigest;
    if (promotedDigest !== srcDigest) {
      fail(`[promote] digest mismatch after copy:\n  dev:  ${srcDigest}\n  prod: ${promotedDigest}`);
    }
    console.error(`[promote] done — ${repoName}:${promoteTag} digest ${promotedDigest} (matches dev)`);
  }

  // From here on this is exactly an existing-tag deploy against prod.
  requestedTag = promoteTag;
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

// --- 5. operator-side verification through CloudFront (the reliable GATE) -------
// The distribution's own *.cloudfront.net name always resolves — no dependency
// on the custom DNS/cert — so it stays the deploy's health gate. The canonical
// custom-domain check (step 6b) additionally proves the real front door works.
console.error(`[deploy] verifying https://${cfDomain}/health ...`);
const cfStatus = await verifyHealth(`https://${cfDomain}/health`, 8);
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

// --- 6b. verify the CANONICAL public URL (the custom domain, once cut over) -----
// PUBLIC_BASE_URL is the app's canonical entry point; after the Change Order 3
// cutover it's the custom domain. Hitting it proves DNS + ACM cert + CloudFront
// alias + app all work end-to-end — i.e. the app is reachable through the REAL
// front door, not just the default name. Before cutover PUBLIC_BASE_URL == the
// CloudFront host, so there's nothing new to check and it's skipped (this is also
// why a not-yet-cut-over stack like prod never false-fails here).
let canonicalStatus = 'skipped';
let canonicalBase = '';
let canonicalHost = '';
const pbu = capture('aws', ['ssm', 'get-parameter', '--name', `/hc/${env}/app/PUBLIC_BASE_URL`,
  '--region', HC_REGION, '--query', 'Parameter.Value', '--output', 'text']);
if (pbu.status === 0) {
  canonicalBase = pbu.stdout.trim();
  try { canonicalHost = new URL(canonicalBase).host; } catch { canonicalHost = ''; }
}
if (canonicalHost && canonicalHost !== cfDomain) {
  console.error(`[deploy] verifying canonical https://${canonicalHost}/health ...`);
  canonicalStatus = await verifyHealth(`${canonicalBase.replace(/\/+$/, '')}/health`, 6);
} else if (!canonicalHost) {
  canonicalStatus = 'skipped (could not read PUBLIC_BASE_URL)';
} else {
  canonicalStatus = 'skipped (PUBLIC_BASE_URL = CloudFront host — not cut over)';
}

// --- 7. summary -----------------------------------------------------------------
const totalS = Math.round((Date.now() - startedAt) / 1000);
console.log(`
========================= deploy summary =========================
  env:           ${env}
  deployed tag:  ${tag}${promoteTag ? '  (promoted from hc-dev-app — same digest)' : requestedTag ? '  (existing image — rollback/redeploy)' : ''}
  previous tag:  ${previousTag || '(none — first deploy)'}
  cloudfront:    ${cfStatus}
  canonical:     ${canonicalHost && canonicalHost !== cfDomain ? `https://${canonicalHost}/health -> ${canonicalStatus}` : canonicalStatus}
  DEPLOYED_TAG:  ${deployedTagParam} = ${tag}
  duration:      ${totalS}s
  rollback:      npm run deploy:${env} -- --tag ${previousTag || '<tag>'}
==================================================================`);

// The app IS deployed & healthy (CloudFront gate passed, DEPLOYED_TAG written),
// but if the canonical custom domain is unreachable, exit non-zero so a broken
// DNS / ACM cert / CloudFront alias can't pass silently — the deployment stands.
if (canonicalStatus === 'FAILED') {
  fail(
    `[deploy] DEPLOYED OK via CloudFront, but the CANONICAL domain ${canonicalBase} did NOT ` +
      `return 200 — users on the custom domain are affected. Check the Namecheap CNAME, the ` +
      `ACM cert, and the CloudFront alias for ${canonicalHost} (see RUNBOOK "Custom domain & TLS").`,
  );
}
