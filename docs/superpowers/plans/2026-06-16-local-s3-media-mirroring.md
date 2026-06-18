<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-06-18).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted on 2026-06-18. **This file is NOT
> current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# Local S3 Media Mirroring + Inline Image/PDF Rendering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror inbound MMS media to a local MinIO (gated on `--local`), store a cohesive per-attachment `{s3Key, contentType}` record, and render images inline + PDFs as a preview in the dashboard — preserving deny-by-default content-type security.

**Architecture:** A `hc-s3-local` MinIO container (lifecycle mirrors DynamoDB Local). The app's `S3MediaStore` gains an endpoint override (local-only, prod-guarded). The message item replaces `media_s3_keys: string[]` with `media_attachments: {s3Key, contentType}[]` (with a read-time compat shim for legacy data). `application/pdf` joins the inline allowlist; the dashboard renders each attachment by its stored type.

**Tech Stack:** Node 24 / TypeScript, Express, AWS SDK v3 (`@aws-sdk/client-s3`, `lib-storage`), DynamoDB, React (dashboard + fake-twilio web), vitest, Playwright, Docker (MinIO).

**Spec:** `docs/superpowers/specs/2026-06-16-local-s3-media-mirroring-design.md`

**Conventions:** vitest in every package (`npm test -w <pkg>` → `vitest run`). DynamoDB item fields are snake_case. Commit after each task. The worktree is `W:/tmp/hc-local-s3-worktree` on branch `local-s3-media`.

**Shared constants (used across tasks):**
- MinIO container: `hc-s3-local`; API `http://localhost:9000`; console `:9001`.
- Local creds: access key `local`, secret `locallocal` (also the MinIO root user/pass).
- Local bucket: `hc-local-media`.

---

## Phase A — Content-type policy

### Task A1: Add `application/pdf` to the inline allowlist

**Files:**
- Modify: `app/src/lib/mediaTypes.ts`
- Test: `app/test/mediaTypes.test.ts`

- [ ] **Step 1: Write/extend the failing test**

Add to `app/test/mediaTypes.test.ts`:
```ts
import { INLINE_MEDIA_TYPES, isInlineMediaType, normalizeStoredMediaType } from '../src/lib/mediaTypes.js';

it('treats application/pdf as inline-renderable', () => {
  expect(isInlineMediaType('application/pdf')).toBe(true);
  expect(isInlineMediaType('APPLICATION/PDF')).toBe(true);
  expect(normalizeStoredMediaType('application/pdf')).toBe('application/pdf');
});

it('still excludes script-capable types', () => {
  for (const t of ['image/svg+xml', 'text/html', 'application/xhtml+xml']) {
    expect(isInlineMediaType(t)).toBe(false);
    expect(normalizeStoredMediaType(t)).toBe('application/octet-stream');
  }
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -w app -- mediaTypes`
Expected: FAIL (`application/pdf` not in set).

- [ ] **Step 3: Implement**

In `app/src/lib/mediaTypes.ts`, add `'application/pdf'` to `INLINE_MEDIA_TYPES` and update the header comment (it currently says "Raster images only. SVG is DELIBERATELY EXCLUDED"). New comment must note PDF is allowed because browser viewers sandbox embedded JS, while SVG/HTML stay excluded:
```ts
// Types served INLINE in the dashboard. Raster images + PDF: browser PDF
// viewers sandbox any embedded JS (it cannot touch the serving origin), so PDF
// is safe to render inline with nosniff. SVG/HTML/XHTML stay EXCLUDED — they can
// run script on top-level navigation. Everything off this list is an opaque
// download. MMS MediaContentType is attacker-controlled (stored-XSS guard).
export const INLINE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
]);
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm test -w app -- mediaTypes` → PASS

- [ ] **Step 5: Commit**
```bash
git add app/src/lib/mediaTypes.ts app/test/mediaTypes.test.ts
git commit -m "feat(media): allow application/pdf inline (deny-by-default preserved)"
```

---

### Task A2: Fake infers `application/pdf` from `.pdf`

**Files:**
- Modify: `fake-twilio/src/engine/signer.ts`
- Test: `fake-twilio/test/` (add `signer.contentType.test.ts` if no existing signer test; otherwise extend it)

- [ ] **Step 1: Failing test**

Create `fake-twilio/test/signer.contentType.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildInboundSmsParams } from '../src/engine/signer.js';

describe('inferred MediaContentType', () => {
  it('maps .pdf → application/pdf and .png → image/png', () => {
    const params = buildInboundSmsParams({
      messageSid: 'MM1', from: '+15550100001', to: '+15550009999',
      mediaUrls: ['http://h/canned/lease-doc.pdf', 'http://h/canned/room.png'],
    });
    expect(params['MediaContentType0']).toBe('application/pdf');
    expect(params['MediaContentType1']).toBe('image/png');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npm test -w @housingchoice/fake-twilio -- signer`
Expected: FAIL (`MediaContentType0` is `application/octet-stream`).

- [ ] **Step 3: Implement**

In `fake-twilio/src/engine/signer.ts` `inferMediaContentType`, add before the final return:
```ts
  if (path.endsWith('.pdf')) return 'application/pdf';
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test -w @housingchoice/fake-twilio -- signer` → PASS

- [ ] **Step 5: Commit**
```bash
git add fake-twilio/src/engine/signer.ts fake-twilio/test/signer.contentType.test.ts
git commit -m "feat(fake-twilio): infer application/pdf for .pdf media URLs"
```

---

## Phase B — Data model: `media_attachments`

> Replaces `media_s3_keys: string[]` with `media_attachments: {s3Key, contentType}[]`. A read-time compat shim keeps legacy `media_s3_keys` working. Define the shape once and reuse.

### Task B1: Repo types + `annotateMessage` + compat helper

**Files:**
- Modify: `app/src/repos/messagesRepo.ts`
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (fake repo)
- Test: `app/test/repos.test.ts` (or a focused new test for the helper)

- [ ] **Step 1: Failing test for the compat helper**

Add a unit test (new file `app/test/mediaAttachments.test.ts`):
```ts
import { describe, it, expect } from 'vitest';
import { mediaAttachmentsOf } from '../src/repos/messagesRepo.js';

describe('mediaAttachmentsOf', () => {
  it('returns media_attachments when present', () => {
    expect(mediaAttachmentsOf({ media_attachments: [{ s3Key: 'k', contentType: 'image/png' }] } as any))
      .toEqual([{ s3Key: 'k', contentType: 'image/png' }]);
  });
  it('falls back to legacy media_s3_keys as octet-stream', () => {
    expect(mediaAttachmentsOf({ media_s3_keys: ['k0', 'k1'] } as any)).toEqual([
      { s3Key: 'k0', contentType: 'application/octet-stream' },
      { s3Key: 'k1', contentType: 'application/octet-stream' },
    ]);
  });
  it('returns [] when neither present', () => {
    expect(mediaAttachmentsOf({} as any)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npm test -w app -- mediaAttachments` → FAIL (no export).

- [ ] **Step 3: Implement in `app/src/repos/messagesRepo.ts`**

(a) Add the attachment type + update `MessageItem` (keep legacy field for back-compat reads):
```ts
/** One mirrored MMS attachment: its S3 key and the (normalized) stored type. */
export interface MediaAttachment {
  s3Key: string;
  contentType: string;
}
```
In `MessageItem`, replace the `media_s3_keys?: string[]` line's role: add
```ts
  /** Mirrored MMS attachments (key+type together). Supersedes media_s3_keys. */
  media_attachments?: MediaAttachment[];
  /** @deprecated legacy parallel array; read via mediaAttachmentsOf() for compat. */
  media_s3_keys?: string[];
```

(b) Update `MessageAnnotations`:
```ts
export interface MessageAnnotations {
  mediaAttachments?: MediaAttachment[];
  retryOf?: string;
  retryAttempt?: number;
}
```

(c) In `annotateMessage`, replace the `mediaS3Keys` branch:
```ts
  if (annotations.mediaAttachments !== undefined) {
    sets.push('media_attachments = :mediaAttachments');
    values[':mediaAttachments'] = annotations.mediaAttachments;
  }
```
and update the log field `mediaKeyCount: annotations.mediaAttachments?.length`.

(d) Add the exported compat helper at module scope:
```ts
/**
 * Normalized attachment list for a stored message. Prefers media_attachments;
 * falls back to legacy media_s3_keys (type unknown → octet-stream → renders as a
 * safe download). The serve endpoint and the dashboard both read through this.
 */
export function mediaAttachmentsOf(item: Pick<MessageItem, 'media_attachments' | 'media_s3_keys'>): MediaAttachment[] {
  if (Array.isArray(item.media_attachments)) return item.media_attachments;
  if (Array.isArray(item.media_s3_keys)) {
    return item.media_s3_keys.map((s3Key) => ({ s3Key, contentType: 'application/octet-stream' }));
  }
  return [];
}
```

(e) Update the fake repo in `app/test/helpers/twilioWebhookHarness.ts` `annotateMessage`:
```ts
  if (annotations.mediaAttachments !== undefined) item.media_attachments = annotations.mediaAttachments;
```
(remove the `mediaS3Keys` line).

- [ ] **Step 4: Run, verify pass** — `npm test -w app -- mediaAttachments` → PASS

- [ ] **Step 5: Commit**
```bash
git add app/src/repos/messagesRepo.ts app/test/helpers/twilioWebhookHarness.ts app/test/mediaAttachments.test.ts
git commit -m "feat(messages): media_attachments record + compat helper for legacy keys"
```

---

### Task B2: Webhook mirror writes `media_attachments`

**Files:**
- Modify: `app/src/routes/webhooks/twilio.ts`
- Test: `app/test/mmsMedia.test.ts`, `app/test/twilioSmsWebhook.test.ts`

- [ ] **Step 1: Update the failing tests**

In `app/test/mmsMedia.test.ts`, replace `media_s3_keys` assertions with `media_attachments`. Example (1:1 MMS, image/jpeg):
```ts
expect(msg?.media_attachments).toEqual([
  { s3Key: world.mediaPuts[0]!.key, contentType: 'image/jpeg' },
]);
```
For the relay test (image/png):
```ts
expect(msg?.media_attachments).toEqual([
  { s3Key: world.mediaPuts[0]!.key, contentType: 'image/png' },
]);
```
In `app/test/twilioSmsWebhook.test.ts`, update the dedupe + multi-attachment assertions to `media_attachments` (each `{ s3Key, contentType }`; the crash-redelivery one stays `toBeUndefined()` for the un-mirrored first delivery, then `media_attachments` after).

- [ ] **Step 2: Run, verify fail** — `npm test -w app -- mmsMedia twilioSmsWebhook` → FAIL.

- [ ] **Step 3: Implement in `mirrorInboundMedia`**

Replace the `keys` accumulation + annotate call:
```ts
  const attachments: { s3Key: string; contentType: string }[] = [];
  for (const [i, url] of mediaUrls.entries()) {
    const key = `media/${conversationId}/${messageSid}/${i}`;
    try {
      const stream = await adapter.getMediaStream(url);
      const contentType = normalizeStoredMediaType(params[`MediaContentType${i}`]);
      await mediaStore.put(key, stream, contentType);
      attachments.push({ s3Key: key, contentType });
    } catch (err) {
      log.error({ err, providerSid: messageSid, mediaIndex: i }, 'media mirror failed — message record keeps the provider URL');
    }
  }
  if (attachments.length > 0) {
    try {
      await messages.annotateMessage(conversationId, tsMsgId, { mediaAttachments: attachments });
    } catch (err) {
      log.error({ err, providerSid: messageSid }, 'failed to record mirrored media keys on the message');
    }
  }
```

Update the dedupe check (line ~475) to use the compat helper (import `mediaAttachmentsOf`):
```ts
mediaAlreadyMirrored = mediaAttachmentsOf(persisted).length > 0;
```

- [ ] **Step 4: Run, verify pass** — `npm test -w app -- mmsMedia twilioSmsWebhook` → PASS

- [ ] **Step 5: Commit**
```bash
git add app/src/routes/webhooks/twilio.ts app/test/mmsMedia.test.ts app/test/twilioSmsWebhook.test.ts
git commit -m "feat(webhook): mirror records media_attachments {s3Key,contentType}"
```

---

### Task B3: Serve endpoint reads via the attachment record

**Files:**
- Modify: `app/src/routes/api.ts`
- Test: `app/test/apiRoutes.test.ts` (extend; add a media-serve case if absent)

- [ ] **Step 1: Failing test**

Add a test that a message with `media_attachments` serves the correct key/stream, and that a legacy `media_s3_keys`-only message still serves (octet-stream → attachment). Use the existing apiRoutes harness pattern (inject a fake `messagesRepo.getByProviderSid` + a fake `mediaStore`). Assert:
- `media_attachments: [{s3Key:'k0', contentType:'image/png'}]` → 200, `Content-Type: image/png`, no `Content-Disposition`.
- legacy `media_s3_keys:['k0']` (store returns octet-stream) → 200, `Content-Disposition: attachment`.

- [ ] **Step 2: Run, verify fail** — `npm test -w app -- apiRoutes` → FAIL.

- [ ] **Step 3: Implement** in the `GET /messages/:providerSid/media/:idx` handler

Replace the key lookup (line ~656) — import `mediaAttachmentsOf`:
```ts
    const attachments = mediaAttachmentsOf(message);
    const key = attachments[idx]?.s3Key;
    if (typeof key !== 'string' || key.length === 0) {
      res.status(404).json({ error: 'media_not_found' });
      return;
    }
```
The inline/attachment decision below is UNCHANGED — it keeps reading `object.contentType` live from `getStream` (authoritative).

- [ ] **Step 4: Run, verify pass** — `npm test -w app -- apiRoutes` → PASS

- [ ] **Step 5: Commit**
```bash
git add app/src/routes/api.ts app/test/apiRoutes.test.ts
git commit -m "feat(api): media-serve reads media_attachments (legacy keys compat)"
```

---

## Phase C — Local S3 infrastructure (MinIO)

### Task C1: Config — `mediaS3Endpoint` + prod guard

**Files:**
- Modify: `app/src/lib/config.ts`
- Test: `app/test/` config test (find the existing config test; else `app/test/config.mediaS3.test.ts`)

- [ ] **Step 1: Failing test**
```ts
import { loadConfig } from '../src/lib/config.js';
it('reads MEDIA_S3_ENDPOINT in non-prod', () => {
  const c = loadConfig({ ...baseEnv, NODE_ENV: 'development', MEDIA_S3_ENDPOINT: 'http://localhost:9000' });
  expect(c.mediaS3Endpoint).toBe('http://localhost:9000');
});
it('refuses MEDIA_S3_ENDPOINT in production', () => {
  expect(() => loadConfig({ ...prodEnv, MEDIA_S3_ENDPOINT: 'http://localhost:9000' }))
    .toThrow(/MEDIA_S3_ENDPOINT is set while NODE_ENV=production/);
});
```
(Match how the existing config tests pass env — `loadConfig` takes an env arg or reads `process.env`; mirror the existing TWILIO_API_BASE_URL guard test if one exists.)

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement**
- Add to `AppConfig`: `mediaS3Endpoint?: string;` (near `mediaBucket`).
- Add the prod guard next to the `TWILIO_API_BASE_URL` guard:
```ts
const mediaS3Endpoint = env.MEDIA_S3_ENDPOINT?.trim();
if (mediaS3Endpoint !== undefined && mediaS3Endpoint.length > 0 && nodeEnv === 'production') {
  throw new Error(
    'MEDIA_S3_ENDPOINT is set while NODE_ENV=production — refusing to start. It is a dev-only ' +
    'override for local S3-compatible storage (MinIO); production must use the real AWS S3 endpoint.',
  );
}
```
- Add to the returned config object: `mediaS3Endpoint: env.MEDIA_S3_ENDPOINT,` (near `mediaBucket: env.MEDIA_BUCKET,`).

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit**
```bash
git add app/src/lib/config.ts app/test/*.test.ts
git commit -m "feat(config): MEDIA_S3_ENDPOINT local override with production guard"
```

---

### Task C2: `S3MediaStore` endpoint override

**Files:**
- Modify: `app/src/adapters/mediaStore.ts`
- Test: `app/test/` (extend an existing mediaStore test or add `mediaStore.endpoint.test.ts`)

- [ ] **Step 1: Failing test**

Assert `createMediaStore` builds a store when both bucket + endpoint are set, and that with endpoint set it does not throw / is defined. (We can't easily introspect S3Client internals; assert behavior: store is defined, and a no-endpoint config still yields a store.)
```ts
it('returns a store with a local endpoint configured', () => {
  const store = createMediaStore({ config: { ...cfg, mediaBucket: 'b', mediaS3Endpoint: 'http://localhost:9000', awsRegion: 'us-east-1' } as any });
  expect(store).toBeDefined();
});
it('returns undefined when no bucket', () => {
  expect(createMediaStore({ config: { ...cfg, mediaBucket: undefined } as any })).toBeUndefined();
});
```

- [ ] **Step 2: Run, verify fail** (if `mediaS3Endpoint` not yet honored, this passes trivially — so make the meaningful assertion the endpoint wiring via a constructed-client spy if the test harness allows; otherwise keep as a guard test and rely on e2e for the real wiring).

- [ ] **Step 3: Implement** in `createMediaStore`:
```ts
export const LOCAL_S3_ACCESS_KEY = 'local';
export const LOCAL_S3_SECRET_KEY = 'locallocal';

export function createMediaStore(deps: CreateMediaStoreDeps = {}): MediaStore | undefined {
  const config = deps.config ?? loadConfig();
  if (!config.mediaBucket) return undefined;
  const client =
    deps.client ??
    new S3Client({
      region: config.awsRegion,
      // Local S3-compatible store (MinIO): path-style + FIXED creds matching the
      // container. MinIO VALIDATES creds (unlike DynamoDB Local), so we must NOT
      // fall back to ambient AWS_* env here. Unset endpoint → real AWS (default
      // chain + instance role), exactly as before.
      ...(config.mediaS3Endpoint
        ? {
            endpoint: config.mediaS3Endpoint,
            forcePathStyle: true,
            credentials: { accessKeyId: LOCAL_S3_ACCESS_KEY, secretAccessKey: LOCAL_S3_SECRET_KEY },
          }
        : {}),
    });
  return new S3MediaStore(config.mediaBucket, client);
}
```

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit**
```bash
git add app/src/adapters/mediaStore.ts app/test/*.test.ts
git commit -m "feat(mediaStore): local S3 endpoint override (MinIO path-style + fixed creds)"
```

---

### Task C3: `scripts/s3.mjs` — MinIO lifecycle

**Files:**
- Create: `scripts/s3.mjs`
- Modify: `package.json` (root) — add `s3:start`, `s3:stop` scripts

- [ ] **Step 1: Create `scripts/s3.mjs`** (mirror `scripts/db.mjs`)
```js
// MinIO (local S3-compatible) container lifecycle — mirrors scripts/db.mjs.
//   npm run s3:start -> ensure the container exists + is running, wait for port
//   npm run s3:stop  -> stop it (container kept; s3:start restarts it)
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const CONTAINER_NAME = 'hc-s3-local';
export const LOCAL_S3_ENDPOINT = 'http://localhost:9000';
export const MINIO_ROOT_USER = 'local';
export const MINIO_ROOT_PASSWORD = 'locallocal';

async function docker(...args) {
  return execFileAsync('docker', args);
}
async function assertDaemonUp() {
  try { await docker('version', '--format', '{{.Server.Version}}'); }
  catch { console.error('Docker daemon is not reachable. Start Docker Desktop and retry.'); process.exit(1); }
}
async function containerState() {
  try {
    const { stdout } = await docker('inspect', '--format', '{{.State.Running}}', CONTAINER_NAME);
    return stdout.trim() === 'true' ? 'running' : 'stopped';
  } catch { return 'absent'; }
}
async function waitForReady(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  // MinIO liveness probe (no auth, 200 when up).
  const url = `${LOCAL_S3_ENDPOINT}/minio/health/live`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`MinIO did not become healthy at ${url} within ${timeoutMs}ms`);
}

export async function ensureS3Started() {
  await assertDaemonUp();
  const state = await containerState();
  if (state === 'running') {
    console.log(`s3:start — ${CONTAINER_NAME} already running`);
  } else if (state === 'stopped') {
    console.log(`s3:start — starting existing container ${CONTAINER_NAME}`);
    await docker('start', CONTAINER_NAME);
  } else {
    console.log(`s3:start — creating container ${CONTAINER_NAME} (ephemeral; data lost on rm)`);
    await docker(
      'run', '-d', '--name', CONTAINER_NAME,
      '-p', '9000:9000', '-p', '9001:9001',
      '-e', `MINIO_ROOT_USER=${MINIO_ROOT_USER}`,
      '-e', `MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}`,
      'minio/minio', 'server', '/data', '--console-address', ':9001',
    );
  }
  await waitForReady();
  console.log(`s3:start — MinIO ready at ${LOCAL_S3_ENDPOINT} (console :9001)`);
}

export async function stopS3() {
  await assertDaemonUp();
  const state = await containerState();
  if (state !== 'running') { console.log(`s3:stop — ${CONTAINER_NAME} is not running (${state})`); return; }
  await docker('stop', CONTAINER_NAME);
  console.log(`s3:stop — ${CONTAINER_NAME} stopped`);
}

// CLI: `node scripts/s3.mjs start|stop`
const cmd = process.argv[2];
if (cmd === 'start') await ensureS3Started();
else if (cmd === 'stop') await stopS3();
else if (cmd) { console.error(`s3 — unknown command ${cmd} (use start|stop)`); process.exit(1); }
```
(Match db.mjs's exact CLI dispatch convention — if db.mjs uses a different entry guard, copy it.)

- [ ] **Step 2: Add npm scripts** to root `package.json`:
```json
"s3:start": "node scripts/s3.mjs start",
"s3:stop": "node scripts/s3.mjs stop",
```

- [ ] **Step 3: Commit**
```bash
git add scripts/s3.mjs package.json
git commit -m "feat(dev): MinIO local-S3 container lifecycle (s3:start/s3:stop)"
```
(Runtime verification deferred to Phase G — needs Docker.)

---

### Task C4: `app/scripts/s3-create.ts` — bucket creation

**Files:**
- Create: `app/scripts/s3-create.ts`

- [ ] **Step 1: Implement** (mirror `db-create.ts`)
```ts
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { LOCAL_S3_ACCESS_KEY, LOCAL_S3_SECRET_KEY } from '../src/adapters/mediaStore.js';

const endpoint = process.env.MEDIA_S3_ENDPOINT ?? 'http://localhost:9000';
const bucket = process.env.MEDIA_BUCKET ?? 'hc-local-media';

export async function ensureBucket(ep: string, name: string): Promise<void> {
  const client = new S3Client({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: ep,
    forcePathStyle: true,
    credentials: { accessKeyId: LOCAL_S3_ACCESS_KEY, secretAccessKey: LOCAL_S3_SECRET_KEY },
  });
  try {
    try {
      await client.send(new HeadBucketCommand({ Bucket: name }));
      console.log(`  exists   ${name} — skipped`);
      return;
    } catch { /* not found → create */ }
    await client.send(new CreateBucketCommand({ Bucket: name }));
    console.log(`  created  ${name}`);
  } finally {
    client.destroy();
  }
}

console.log(`s3:create — ensuring bucket ${bucket} at ${endpoint}`);
try {
  await ensureBucket(endpoint, bucket);
  console.log('s3:create — done');
} catch (err) {
  console.error('s3:create failed — is MinIO up? (npm run s3:start)');
  console.error(err);
  process.exit(1);
}
```

- [ ] **Step 2: Commit**
```bash
git add app/scripts/s3-create.ts
git commit -m "feat(dev): idempotent local media bucket creation (s3-create)"
```

---

### Task C5: Wire `--local` in `scripts/dev.mjs`

**Files:**
- Modify: `scripts/dev.mjs`

- [ ] **Step 1: Implement**
- Import: `import { ensureS3Started, LOCAL_S3_ENDPOINT } from './s3.mjs';`
- In the `mode === 'local'` block (the DynamoDB Local setup, ~line 219), add MinIO + bucket BEFORE tables:
```js
  console.log('dev — step: MinIO local S3 container');
  await ensureS3Started();
  await runTsx('app/scripts/s3-create.ts');
```
(Renumber the existing `step N/4` log labels to reflect the added step.)
- In `childEnv`, when local, add the media env. Since `overlay` comes from `resolveDevEnv`, add alongside it conditionally:
```js
const localMediaEnv = mode === 'local'
  ? { MEDIA_BUCKET: 'hc-local-media', MEDIA_S3_ENDPOINT: LOCAL_S3_ENDPOINT }
  : {};
const childEnv = {
  ...process.env,
  ...overlay,
  ...localMediaEnv,
  PATH: `${path.join(repoRoot, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH ?? ''}`,
};
```
- Add a startup note near the other URLs: `console.log('  ▶ MinIO console: http://localhost:9001/ (user local / pass locallocal)');`

- [ ] **Step 2: Commit**
```bash
git add scripts/dev.mjs
git commit -m "feat(dev): --local starts MinIO + creates bucket + sets MEDIA_* env"
```

---

### Task C6: Wire `scripts/e2e-session.mjs` + teardown

**Files:**
- Modify: `scripts/e2e-session.mjs`
- Modify: `scripts/e2e-stop.mjs` (or document that the container persists like DynamoDB)

- [ ] **Step 1: Implement in `e2e-session.mjs`**
- Import: `import { ensureS3Started, stopS3, LOCAL_S3_ENDPOINT } from './s3.mjs';`
- In `childEnv`, add:
```js
  MEDIA_BUCKET: process.env.MEDIA_BUCKET ?? 'hc-local-media',
  MEDIA_S3_ENDPOINT: process.env.MEDIA_S3_ENDPOINT ?? LOCAL_S3_ENDPOINT,
```
- In `main()`, before `ensureDbStarted()`:
```js
  log('ensuring MinIO S3…');
  await ensureS3Started();
```
- After `db-create`/`db-seed`, create the bucket:
```js
  await runOnce('s3-create', ['--import', 'tsx', path.join('app', 'scripts', 's3-create.ts')]);
```

- [ ] **Step 2: Teardown** — match the DynamoDB posture (container left running). Add a one-line log in `shutdown()` noting MinIO (like DynamoDB) is left running. Optionally add a `stopS3()` call to `e2e-stop.mjs` only if db is also stopped there (it is not — keep symmetry: leave running).

- [ ] **Step 3: Commit**
```bash
git add scripts/e2e-session.mjs scripts/e2e-stop.mjs
git commit -m "feat(e2e): start MinIO + create bucket + MEDIA_* env in the hermetic stack"
```

---

## Phase D — Canned assets (PNG + PDF)

### Task D1: Replace SVGs with PNG + PDF fixtures

**Files:**
- Delete: `fake-twilio/web/public/canned/{room,kitchen,lease-doc}.svg`
- Create: `fake-twilio/web/public/canned/{room,kitchen}.png`, `fake-twilio/web/public/canned/lease-doc.pdf`
- Modify: `fake-twilio/web/src/assets/canned/index.ts`
- Modify: `fake-twilio/web/src/assets/canned/index.test.ts`
- Modify: `fake-twilio/web/src/ui/Composer.tsx` (picker thumbnail for non-image)
- Modify: `fake-twilio/web/src/ui/MessageBubble.tsx` (render non-image as a doc link)

- [ ] **Step 1: Generate the fixtures** (small, committed). PNGs: simple labeled raster (≈160×120). PDF: a minimal valid one-page PDF. (Delegate generation to a subagent; verify each file's magic bytes: PNG `89 50 4E 47`, PDF `25 50 44 46`.)

- [ ] **Step 2: Update `canned/index.ts`** — change entries:
```ts
export const cannedAssets: readonly CannedAsset[] = [
  { id: 'room', url: cannedUrl('room.png'), label: 'Room' },
  { id: 'kitchen', url: cannedUrl('kitchen.png'), label: 'Kitchen' },
  { id: 'lease-doc', url: cannedUrl('lease-doc.pdf'), label: 'Lease doc' },
];
```

- [ ] **Step 3: Update `canned/index.test.ts`** — the pathname assertion now expects the new extensions:
```ts
const ext = asset.id === 'lease-doc' ? 'pdf' : 'png';
expect(u.pathname).toBe(`/canned/${asset.id}.${ext}`);
```
(Keep the http(s)/no-`data:` assertions.)

- [ ] **Step 4: Composer picker thumbnail** — render a doc icon for non-image assets instead of `<img>`:
```tsx
{/^image\//.test(/* infer */ a.url.endsWith('.pdf') ? 'application/pdf' : 'image/*')
  ? <img className={styles.assetThumb} src={a.url} alt="" aria-hidden="true" />
  : <span className={styles.assetThumb} aria-hidden="true">📄</span>}
```
(Simplify: a helper `isImageAsset(url) = !url.endsWith('.pdf')`.)

- [ ] **Step 5: fake-twilio `MessageBubble.tsx`** — for a non-image mediaUrl render a labeled link instead of `<img>`:
```tsx
{message.mediaUrls?.map((url) =>
  url.endsWith('.pdf')
    ? <a key={url} className={styles.thumb} href={url} target="_blank" rel="noopener noreferrer">📄 {cannedLabelFor(url)}</a>
    : <img key={url} className={styles.thumb} src={url} alt={cannedLabelFor(url)} loading="lazy" />,
)}
```

- [ ] **Step 6: Run fake-twilio web tests** — `npm test -w @housingchoice/fake-twilio-web`. Fix any snapshot/text assertions. Expected: PASS.

- [ ] **Step 7: Commit**
```bash
git add fake-twilio/web/public/canned fake-twilio/web/src/assets/canned fake-twilio/web/src/ui/Composer.tsx fake-twilio/web/src/ui/MessageBubble.tsx
git commit -m "feat(fake-twilio): canned assets as PNG + PDF (render inline / as doc)"
```

---

## Phase E — Dashboard rendering by type

### Task E1: Dashboard `Message` type carries `media_attachments`

**Files:**
- Modify: `dashboard/src/api/types.ts`

- [ ] **Step 1: Implement** — add to the `Message` interface (keep `media_s3_keys` for back-compat):
```ts
  /** Mirrored MMS attachments (key+type). Supersedes media_s3_keys. */
  media_attachments?: { s3Key: string; contentType: string }[];
```

- [ ] **Step 2: Commit**
```bash
git add dashboard/src/api/types.ts
git commit -m "feat(dashboard): Message.media_attachments type"
```

---

### Task E2: `MessageBubble` renders by attachment type

**Files:**
- Modify: `dashboard/src/routes/thread/MessageBubble.tsx`
- Test: `dashboard/src/routes/thread/Thread.test.tsx`

- [ ] **Step 1: Update/extend the failing tests**

Keep the existing inline-`<img>` test but switch the fixture to `media_attachments`:
```ts
makeMessage({ tsMsgId: 't1#SM1', provider_sid: 'SM1', type: 'mms', body: '',
  media_attachments: [
    { s3Key: 'k0', contentType: 'image/png' },
    { s3Key: 'k1', contentType: 'image/png' },
  ] }),
```
Add two cases:
- PDF: `media_attachments: [{ s3Key: 'k0', contentType: 'application/pdf' }]` → a link (role link) to `/api/messages/SM1/media/0`, label contains "PDF"; NOT an `<img>`.
- Other: `media_attachments: [{ s3Key: 'k0', contentType: 'application/octet-stream' }]` → a download link to `/api/messages/SM1/media/0`; NOT an `<img>`.
- Legacy compat: `media_s3_keys: ['k0']` (no media_attachments) → a download link (octet-stream).

- [ ] **Step 2: Run, verify fail** — `npm test -w dashboard -- Thread` → FAIL.

- [ ] **Step 3: Implement** — replace `mediaCount` + the media block.

Helper:
```ts
function attachmentsOf(message: TimelineMessage): { s3Key: string; contentType: string }[] {
  if (Array.isArray(message.media_attachments)) return message.media_attachments;
  if (Array.isArray(message.media_s3_keys)) {
    return message.media_s3_keys.map((s3Key) => ({ s3Key, contentType: 'application/octet-stream' }));
  }
  return [];
}
```
Render block (replaces the `s3Keys.length > 0 ? … : …` JSX):
```tsx
{attachments.length > 0 ? (
  <div className={styles.mediaGallery}>
    {attachments.map((att, i) => {
      const src = `/api/messages/${encodeURIComponent(message.provider_sid)}/media/${i}`;
      if (att.contentType.startsWith('image/')) {
        return (
          <a key={i} className={styles.mediaLink} href={src} target="_blank" rel="noopener noreferrer">
            <img className={styles.mediaImg} src={src} alt={`Attachment ${i + 1}`} loading="lazy" />
          </a>
        );
      }
      const isPdf = att.contentType === 'application/pdf';
      return (
        <a key={i} className={styles.mediaFile} href={src} target="_blank" rel="noopener noreferrer">
          {isPdf ? `📄 PDF attachment ${i + 1}` : `📎 Attachment ${i + 1}`}
        </a>
      );
    })}
  </div>
) : (
  mediaCountFromUrls > 0 && (
    <span className={styles.media} title="Media attachment (not yet viewable)">
      📎 Media attachment
    </span>
  )
)}
```
Where `mediaCountFromUrls = message.mediaUrls?.length ?? 0` (the no-mirror fallback). Add a `.mediaFile` style in `MessageBubble.module.css` (link styling consistent with `.mediaLink`).

- [ ] **Step 4: Run, verify pass** — `npm test -w dashboard -- Thread` → PASS

- [ ] **Step 5: Commit**
```bash
git add dashboard/src/routes/thread/MessageBubble.tsx dashboard/src/routes/thread/MessageBubble.module.css dashboard/src/routes/thread/Thread.test.tsx
git commit -m "feat(dashboard): render MMS by type (image inline, PDF/doc as link)"
```

---

## Phase F — E2E

### Task F1: E2E covers inline image + PDF (requires MinIO in the stack)

**Files:**
- Modify: `e2e/tests/flows/fake-twilio-sms.spec.ts`
- Modify: `e2e/fixtures/fakeTwilio.ts` (thread type already has `mediaUrls`; add `media_attachments?` for assertions if needed)

- [ ] **Step 1: Update the existing canned-MMS test** — after sending the PNG canned image via the UI and confirming it in the staff thread, assert the dashboard renders an inline `<img>` whose media request returns 200 + an image content-type:
```ts
const img = vaPage.getByRole('img', { name: /attachment/i });
await expect(img.first()).toBeVisible();
const src = await img.first().getAttribute('src');
const resp = await vaPage.request.get(src!);
expect(resp.status()).toBe(200);
expect(resp.headers()['content-type']).toMatch(/^image\//);
```

- [ ] **Step 2: Add a PDF case** — send the `lease-doc.pdf` canned asset; assert a PDF link in the thread and that its media request returns 200 `application/pdf`:
```ts
const pdfLink = vaPage.getByRole('link', { name: /pdf attachment/i });
await expect(pdfLink.first()).toBeVisible();
const pdfSrc = await pdfLink.first().getAttribute('href');
const pdfResp = await vaPage.request.get(pdfSrc!);
expect(pdfResp.status()).toBe(200);
expect(pdfResp.headers()['content-type']).toBe('application/pdf');
```
(Selecting the PDF in the picker: `page.getByRole('button', { name: /Lease doc/i }).click()`.)

- [ ] **Step 3: Commit**
```bash
git add e2e/tests/flows/fake-twilio-sms.spec.ts e2e/fixtures/fakeTwilio.ts
git commit -m "test(e2e): inbound MMS renders inline image + PDF preview via local S3"
```

- [ ] **Step 4: Verification (Phase G — coordinate ports/Docker first).**

---

## Phase G — Verification & adversarial review

### Task G1: Full per-package unit suites (no ports)
- [ ] `npm test -w app`, `npm test -w dashboard`, `npm test -w @housingchoice/fake-twilio-web`, `npm test -w @housingchoice/fake-twilio` — all green. Typecheck each (`npm run typecheck -w <pkg>` where defined). Fix fallout.

### Task G2: Adversarial review (parallel subagents, broad scope)
- [ ] Dispatch independent review subagents (full tools), each a distinct lens, then triage:
  - **Architecture/data-model:** `media_attachments` migration soundness; compat shim correctness; serialization path; no orphaned `media_s3_keys` readers.
  - **Concurrency/idempotency:** mirror dedupe (`mediaAlreadyMirrored`), redelivery, partial-failure (some attachments put, some fail), annotate race.
  - **Security:** XSS (allowlist vs PDF inline + CSP/sandbox), SSRF in mirror fetch (`adapter.getMediaStream(url)`), path traversal (idx/key), auth gate on serve, MinIO creds never reachable in prod (guard), no creds/secrets logged.
- [ ] Triage findings → fix real issues, record rejected minutiae with reasons.

### Task G3: Live verification (needs Docker + ports — coordinate with the user first)
- [ ] Confirm the user's local stack is stopped (port/Docker coordination). Then `npm run e2e` (boots MinIO + DynamoDB + app + fake-twilio) and confirm F1 passes.
- [ ] Manual smoke (optional): `npm run dev --local --mock`, send a canned PNG + the PDF from the fake-phones UI, confirm inline image + PDF preview in the dashboard.

---

## Self-review (coverage vs. spec)

- Spec §1 MinIO → C3/C4/C5/C6. §2 gating on `--local` → C5 (dev), C6 (e2e always-on). §3 config+mediaStore → C1/C2. §4 PNG+PDF assets → D1. §5 content-type policy (pdf allowlist + fake infer + CSP verify) → A1/A2, CSP verify in G2/G3. §6 `media_attachments` + compat → B1/B2/B3, E1/E2. §7 dashboard rendering → E2. §8 tests → A/B/E unit + F1 e2e. §9 risks (CSP/PDF, Docker, compat) → G2/G3.
- **Open risk carried into execution:** the `Content-Security-Policy: default-src 'none'; sandbox` on the serve response may block the inline PDF viewer on top-level open. If G3 shows the PDF downloads/blank instead of rendering, relax minimally for `application/pdf` responses only (e.g. drop `sandbox` for pdf while keeping `default-src 'none'` + nosniff, or add the narrowest token that lets the viewer run) — and add/adjust a serve-endpoint test. Does not affect the image path.
