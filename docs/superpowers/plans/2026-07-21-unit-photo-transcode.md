# Unit Photo Transcode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Photo uploads accept 20MB sources; anything over 5MB is transcoded at confirm into a 2560px/q85 jpeg rendition (reusing the MMS sharp pipeline via parameterized profiles); the dashboard pre-checks >20MB files with a named message and chunks confirms so big files never brush the CloudFront 30s origin timeout.

**Architecture:** Parameterize the existing `mediaTranscode.ts` image pipeline with a `TranscodeProfile` (MMS outputs stay byte-identical); extract the per-router transcode semaphore into one shared process gate; the photos confirm route classifies each key by HeadObject size (<=5MB passthrough unchanged, >5MB download+transcode+rendition-put); the dashboard splits confirm calls by file size. Spec: `docs/superpowers/specs/2026-07-21-unit-photo-transcode-design.md`.

**Tech Stack:** TypeScript, Express 5, sharp (existing dep), Vitest + supertest, React + RTL, Playwright e2e (MinIO).

## Global Constraints

- Build in an isolated worktree: `git worktree add w:\tmp\photo-transcode -b feat/unit-photo-transcode` (never move HEAD in the shared checkout). All commands below run from that worktree root.
- Photo targets (spec D2, verbatim): source cap 20MB; passthrough <=5MB byte-identical; max edge 2560; quality ladder [85, 78, 70]; soft target 3MB; photo pixel cap 50,000,000; MMS keeps 24,000,000 and its outputs stay byte-identical.
- ONE shared 2-slot transcode gate process-wide (MMS + photos), `MMS_TRANSCODE_MAX_CONCURRENT`.
- Error codes: `transcode_busy` (503), `transcode_failed` (400) - reuse MMS copy shapes.
- Staff copy says "photo(s)" / "property"; plain ASCII in all strings and docs.
- Never log photo keys/filenames in the units routes (existing PII posture: unitId + counts + byte counts only).
- Gates before handback: `npm run typecheck` AND `npm test` AND `npm run e2e`, bare, green, after ONE `git merge main`.

---

### Task 1: Photo limits + TranscodeProfile refactor (adapter)

**Files:**
- Create: `app/src/lib/unitPhotoLimits.ts`
- Modify: `app/src/adapters/mediaTranscode.ts`
- Test: `app/test/mediaTranscode.test.ts` (extend)

**Interfaces:**
- Consumes: existing MMS constants from `app/src/lib/outboundMediaLimits.ts`.
- Produces: `UNIT_PHOTO_SOURCE_MAX_BYTES`, `UNIT_PHOTO_PASSTHROUGH_MAX_BYTES`, `UNIT_PHOTO_TRANSCODE_MAX_EDGE`, `UNIT_PHOTO_TRANSCODE_QUALITY_LADDER`, `UNIT_PHOTO_TRANSCODE_TARGET_BYTES`, `UNIT_PHOTO_SHARP_MAX_INPUT_PIXELS` (lib/unitPhotoLimits.js); `transcodeForUnitPhoto(bytes: Buffer, sourceType: string): Promise<TranscodeResult>` (adapters/mediaTranscode.js). `transcodeForMms` signature and behavior unchanged.

- [ ] **Step 1: Write the failing tests** - append to `app/test/mediaTranscode.test.ts`:

```ts
import { transcodeForUnitPhoto } from '../src/adapters/mediaTranscode.js';
import {
  UNIT_PHOTO_TRANSCODE_MAX_EDGE,
  UNIT_PHOTO_TRANSCODE_TARGET_BYTES,
} from '../src/lib/unitPhotoLimits.js';

describe('transcodeForUnitPhoto (photo profile - gentler than MMS)', () => {
  it('downscales an oversized photo to the 2560 max edge as jpeg under the soft target', async () => {
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 40, g: 90, b: 200 } } }).png().toBuffer();
    const out = await transcodeForUnitPhoto(big, 'image/png');
    expect(out.contentType).toBe('image/jpeg');
    const meta = await sharp(out.bytes).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(UNIT_PHOTO_TRANSCODE_MAX_EDGE);
    expect(out.bytes.length).toBeLessThanOrEqual(UNIT_PHOTO_TRANSCODE_TARGET_BYTES);
  });

  it('never enlarges a small source', async () => {
    const small = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 10, g: 10, b: 10 } } }).webp().toBuffer();
    const out = await transcodeForUnitPhoto(small, 'image/webp');
    const meta = await sharp(out.bytes).metadata();
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(480);
  });

  it('accepts a 27MP source the MMS 24MP cap rejects (per-profile pixel caps)', async () => {
    // 6000x4500 = 27,000,000 px: over SHARP_MAX_INPUT_PIXELS (24MP), under the
    // photo profile's 50MP.
    const huge = await sharp({ create: { width: 6000, height: 4500, channels: 3, background: { r: 128, g: 128, b: 128 } } }).png().toBuffer();
    await expect(transcodeForMms(huge, 'image/png')).rejects.toThrow();
    const out = await transcodeForUnitPhoto(huge, 'image/png');
    expect(out.contentType).toBe('image/jpeg');
  });

  it('corrupt photo input throws (confirm route maps it to 400)', async () => {
    await expect(transcodeForUnitPhoto(Buffer.from('not an image'), 'image/jpeg')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app; npx vitest run test/mediaTranscode.test.ts`
Expected: FAIL - `unitPhotoLimits` module not found / `transcodeForUnitPhoto` not exported.

- [ ] **Step 3: Create `app/src/lib/unitPhotoLimits.ts`**

```ts
// Unit-photo upload limits (design 2026-07-21-unit-photo-transcode). Gentler
// than the carrier-tight MMS targets in outboundMediaLimits.ts: photos are
// DISPLAY assets (staff gallery + public flyer), so the rendition targets
// full-screen quality - and only sources OVER the old 5MB cap are touched at
// all. Shared by the photo presign/confirm routes and the transcode adapter.

/** Presign policy cap on the ORIGINAL upload (S3-enforced content-length-range). */
export const UNIT_PHOTO_SOURCE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * At/under this a source is stored byte-identical (every previously-working
 * upload keeps today's behavior); only sources OVER it are transcoded. Also
 * the size invariant every STORED photo must satisfy (renditions re-checked).
 */
export const UNIT_PHOTO_PASSTHROUGH_MAX_BYTES = 5 * 1024 * 1024;

/** Longest-edge cap (px) for a transcoded photo rendition. */
export const UNIT_PHOTO_TRANSCODE_MAX_EDGE = 2560;

/** JPEG qualities tried in order until the encode is <= the soft target. */
export const UNIT_PHOTO_TRANSCODE_QUALITY_LADDER = [85, 78, 70] as const;

/** Soft byte target the ladder aims under (lowest-quality result kept if none
 *  qualifies, then re-checked against the 5MB stored-photo invariant). */
export const UNIT_PHOTO_TRANSCODE_TARGET_BYTES = 3 * 1024 * 1024;

/** sharp input-pixel cap for photo sources: 48MP-class phone photos decode
 *  (~200MB peak RGBA raster per gate slot, bounded by the SHARED 2-slot gate
 *  on the 2GB box). MMS keeps its tighter 24MP cap. */
export const UNIT_PHOTO_SHARP_MAX_INPUT_PIXELS = 50_000_000;
```

- [ ] **Step 4: Refactor `app/src/adapters/mediaTranscode.ts` to profiles**

Replace the whole file's pipeline plumbing (keep the header comment, sharp.concurrency(1), pdfium block, and `pdfRenderScale` exactly as they are):

```ts
import {
  TRANSCODE_TARGET_MAX_EDGE,
  TRANSCODE_TARGET_MAX_BYTES,
  TRANSCODE_JPEG_QUALITY_LADDER,
  SHARP_MAX_INPUT_PIXELS,
} from '../lib/outboundMediaLimits.js';
import {
  UNIT_PHOTO_TRANSCODE_MAX_EDGE,
  UNIT_PHOTO_TRANSCODE_QUALITY_LADDER,
  UNIT_PHOTO_TRANSCODE_TARGET_BYTES,
  UNIT_PHOTO_SHARP_MAX_INPUT_PIXELS,
} from '../lib/unitPhotoLimits.js';

/** The per-consumer knobs of the shared image pipeline. MMS outputs must stay
 *  byte-identical, so its profile is built verbatim from the MMS constants. */
export interface TranscodeProfile {
  maxEdge: number;
  qualityLadder: readonly number[];
  targetMaxBytes: number;
  maxInputPixels: number;
}

const MMS_PROFILE: TranscodeProfile = {
  maxEdge: TRANSCODE_TARGET_MAX_EDGE,
  qualityLadder: TRANSCODE_JPEG_QUALITY_LADDER,
  targetMaxBytes: TRANSCODE_TARGET_MAX_BYTES,
  maxInputPixels: SHARP_MAX_INPUT_PIXELS,
};

const UNIT_PHOTO_PROFILE: TranscodeProfile = {
  maxEdge: UNIT_PHOTO_TRANSCODE_MAX_EDGE,
  qualityLadder: UNIT_PHOTO_TRANSCODE_QUALITY_LADDER,
  targetMaxBytes: UNIT_PHOTO_TRANSCODE_TARGET_BYTES,
  maxInputPixels: UNIT_PHOTO_SHARP_MAX_INPUT_PIXELS,
};
```

`encodeJpeg` takes the profile:

```ts
async function encodeJpeg(pipeline: Sharp, profile: TranscodeProfile): Promise<Buffer> {
  const base = pipeline
    .rotate() // honor EXIF orientation before metadata is stripped
    .resize({ width: profile.maxEdge, height: profile.maxEdge, fit: 'inside', withoutEnlargement: true });
  let last: Buffer | undefined;
  for (const quality of profile.qualityLadder) {
    last = await base.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
    if (last.length <= profile.targetMaxBytes) return last;
  }
  return last as Buffer;
}
```

`transcodeImage` takes the profile; `transcodePdf` passes `MMS_PROFILE` to its `encodeJpeg` call and keeps `limitInputPixels: SHARP_MAX_INPUT_PIXELS` (pdf is MMS-only):

```ts
async function transcodeImage(bytes: Buffer, transcodedFrom: string, profile: TranscodeProfile): Promise<TranscodeResult> {
  const pipeline = sharp(bytes, { limitInputPixels: profile.maxInputPixels });
  await pipeline.metadata(); // throws on a non-image / over-limit input
  return { bytes: await encodeJpeg(pipeline, profile), contentType: 'image/jpeg', transcodedFrom };
}
```

Public API - `transcodeForMms` unchanged in signature and behavior, plus the new photo entry:

```ts
/** Convert an uploaded source to a Twilio-deliverable JPEG. Caller decides WHICH
 *  sources reach here (planMmsMedia); this handles image vs pdf by content-type. */
export async function transcodeForMms(bytes: Buffer, sourceType: string): Promise<TranscodeResult> {
  const t = sourceType.trim().toLowerCase();
  if (t === 'application/pdf') return transcodePdf(bytes);
  return transcodeImage(bytes, t, MMS_PROFILE);
}

/** Convert a >5MB unit-photo source into the display rendition (2560/q-ladder
 *  jpeg). Images only - the photo allowlist has no pdf. */
export async function transcodeForUnitPhoto(bytes: Buffer, sourceType: string): Promise<TranscodeResult> {
  return transcodeImage(bytes, sourceType.trim().toLowerCase(), UNIT_PHOTO_PROFILE);
}
```

- [ ] **Step 5: Run the adapter suite**

Run: `cd app; npx vitest run test/mediaTranscode.test.ts`
Expected: PASS - all pre-existing MMS cases (byte-identical behavior) plus the four new photo cases.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/unitPhotoLimits.ts app/src/adapters/mediaTranscode.ts app/test/mediaTranscode.test.ts
git commit -m "feat(photos): unit-photo transcode profile (2560/q85 ladder) via parameterized media pipeline"
```

---

### Task 2: One shared process-wide transcode gate

**Files:**
- Create: `app/src/lib/transcodeGate.ts`
- Modify: `app/src/routes/mmsMedia.ts` (drop the per-router semaphore)
- Test: `app/test/mmsMediaRoutes.test.ts` (existing suite is the regression net; one new assertion file section not needed)

**Interfaces:**
- Produces: `sharedTranscodeGate: Semaphore` (lib/transcodeGate.js) - Task 4 injects it as the units router default.

- [ ] **Step 1: Create `app/src/lib/transcodeGate.ts`**

```ts
// The process-wide transcode concurrency gate - ONE instance shared by every
// confirm-time transcoder (MMS attachments + unit photos). The bound exists to
// cap PEAK PROCESS MEMORY from concurrent sharp rasters; two routers each
// holding their own 2-slot gate would silently double it to 4 rasters.
import { createSemaphore, type Semaphore } from './semaphore.js';
import { MMS_TRANSCODE_MAX_CONCURRENT } from './outboundMediaLimits.js';

export const sharedTranscodeGate: Semaphore = createSemaphore(MMS_TRANSCODE_MAX_CONCURRENT);
```

- [ ] **Step 2: Switch `app/src/routes/mmsMedia.ts` to it**

Remove `import { createSemaphore } from '../lib/semaphore.js';` and the line
`const transcodeGate = createSemaphore(MMS_TRANSCODE_MAX_CONCURRENT);` (line 45);
drop `MMS_TRANSCODE_MAX_CONCURRENT` from the outboundMediaLimits import (now unused
here); add:

```ts
import { sharedTranscodeGate } from '../lib/transcodeGate.js';
```

and in `createMmsMediaRouter`:

```ts
const transcodeGate = sharedTranscodeGate;
```

(Keeping the local name means zero edits at the acquire site.)

- [ ] **Step 3: Run the MMS routes suite**

Run: `cd app; npx vitest run test/mmsMediaRoutes.test.ts`
Expected: PASS unchanged (same 2-slot behavior; the gate is just no longer router-local).

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/transcodeGate.ts app/src/routes/mmsMedia.ts
git commit -m "refactor(media): one shared process-wide transcode gate (MMS + photos share the memory bound)"
```

---

### Task 3: Presign policy cap 20MB

**Files:**
- Modify: `app/src/routes/units.ts` (photos/presign, ~line 486)
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (fake records maxBytes)
- Test: `app/test/unitsApiPhotos.test.ts` (extend)

**Interfaces:**
- Consumes: `UNIT_PHOTO_SOURCE_MAX_BYTES` (Task 1).
- Produces: presign grants whose policy allows 1..20MB (Task 4 relies on >5MB objects existing; Task 5's dashboard mirrors the same 20MB number).

- [ ] **Step 1: Extend the fake world to record the policy cap** - in `app/test/helpers/twilioWebhookHarness.ts`, change the `presignPosts` type (line ~170) to:

```ts
  /** Presigned-POST grants minted via mediaStore.createPresignedPost, in order. */
  presignPosts: { key: string; contentType: string; maxBytes?: number }[];
```

and the fake `createPresignedPost` push (line ~2375) to:

```ts
      presignPosts.push({
        key,
        contentType: opts.contentType,
        ...(opts.maxBytes !== undefined && { maxBytes: opts.maxBytes }),
      });
```

- [ ] **Step 2: Write the failing test** - append inside the presign describe in `app/test/unitsApiPhotos.test.ts`:

```ts
  it('mints each grant with the 20MB source policy cap (transcode design 2026-07-21)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const res = await presign(app, 'unit-1').send({ count: 1, contentTypes: ['image/jpeg'] });
    expect(res.status).toBe(200);
    expect(world.presignPosts).toHaveLength(1);
    expect(world.presignPosts[0]!.maxBytes).toBe(UNIT_PHOTO_SOURCE_MAX_BYTES);
  });
```

with the import added at the top of the file:

```ts
import { UNIT_PHOTO_SOURCE_MAX_BYTES } from '../src/lib/unitPhotoLimits.js';
```

- [ ] **Step 3: Run to verify failure**

Run: `cd app; npx vitest run test/unitsApiPhotos.test.ts`
Expected: the new case FAILS with `maxBytes` undefined (route passes none today).

- [ ] **Step 4: Pass the cap in the route** - `app/src/routes/units.ts` presign mint (line ~486):

```ts
        const key = `${unitMediaPrefix(unitId)}${randomUUID()}`;
        const post = await mediaStore.createPresignedPost(key, {
          contentType,
          maxBytes: UNIT_PHOTO_SOURCE_MAX_BYTES,
        });
```

adding to the units.ts imports:

```ts
import { UNIT_PHOTO_SOURCE_MAX_BYTES } from '../lib/unitPhotoLimits.js';
```

- [ ] **Step 5: Run to verify pass**

Run: `cd app; npx vitest run test/unitsApiPhotos.test.ts`
Expected: PASS (all existing cases + the new one).

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/units.ts app/test/helpers/twilioWebhookHarness.ts app/test/unitsApiPhotos.test.ts
git commit -m "feat(photos): presign grants allow 20MB sources (policy cap; confirm fits >5MB next)"
```

---

### Task 4: Confirm route - transcode branch

**Files:**
- Modify: `app/src/routes/units.ts` (photos/confirm, lines ~495-650; deps interface ~line 78)
- Test: `app/test/unitsApiPhotos.test.ts` (extend)

**Interfaces:**
- Consumes: `transcodeForUnitPhoto` (Task 1), `sharedTranscodeGate` (Task 2), `UNIT_PHOTO_PASSTHROUGH_MAX_BYTES` / `UNIT_PHOTO_SOURCE_MAX_BYTES` (Task 1), existing `MMS_TRANSCODE_WAIT_TIMEOUT_MS`, `MediaStore.getBytes/put`.
- Produces: confirm accepts >5MB uploaded keys and appends fresh-uuid jpeg RENDITION keys instead; new error codes `transcode_busy` (503) and `transcode_failed` (400) that Task 5 maps to staff copy. `UnitsRouterDeps` gains `transcodeGate?: Semaphore` (test seam; default `sharedTranscodeGate`).

- [ ] **Step 1: Write the failing tests** - append a new describe to `app/test/unitsApiPhotos.test.ts`:

```ts
import sharp from 'sharp';
import { UNIT_PHOTO_PASSTHROUGH_MAX_BYTES } from '../src/lib/unitPhotoLimits.js';

/** A REAL >5MB png (gaussian noise defeats compression) so the transcode branch
 *  has decodable bytes. Built once - sharp runs ~1-2s for this size. */
async function bigNoisePng(): Promise<Buffer> {
  const buf = await sharp({
    create: {
      width: 1800,
      height: 1800,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
      noise: { type: 'gaussian', mean: 128, sigma: 30 },
    },
  })
    .png()
    .toBuffer();
  expect(buf.length).toBeGreaterThan(UNIT_PHOTO_PASSTHROUGH_MAX_BYTES);
  return buf;
}

describe('POST /api/units/:unitId/photos/confirm - >5MB transcode branch', () => {
  it('transcodes an oversize source: appends a FRESH jpeg rendition key, not the original', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const key = 'unit-media/unit-1/aaaaaaaa-0000-0000-0000-000000000001';
    world.mediaObjects.set(key, { body: await bigNoisePng(), contentType: 'image/png' });
    const res = await confirm(app, 'unit-1').send({ keys: [key] });
    expect(res.status).toBe(200);
    const media: string[] = res.body.unit.media;
    expect(media).toHaveLength(1);
    expect(media[0]).toMatch(KEY_RE);
    expect(media[0]).not.toBe(key); // rendition, not the original
    // The rendition was PUT under the unit prefix as a jpeg within the invariant.
    expect(world.mediaPuts).toHaveLength(1);
    expect(world.mediaPuts[0]!.key).toBe(media[0]);
    expect(world.mediaPuts[0]!.contentType).toBe('image/jpeg');
    expect(world.mediaPuts[0]!.bytes).toBeLessThanOrEqual(UNIT_PHOTO_PASSTHROUGH_MAX_BYTES);
  });

  it('passthrough (<=5MB) stays byte-identical: no download, no put, original key appended', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const key = 'unit-media/unit-1/aaaaaaaa-0000-0000-0000-000000000002';
    storeObject(world, key, { contentType: 'image/png', size: 64 });
    const res = await confirm(app, 'unit-1').send({ keys: [key] });
    expect(res.status).toBe(200);
    expect(res.body.unit.media).toEqual([key]);
    expect(world.mediaPuts).toHaveLength(0);
  });

  it('503 transcode_busy when the gate cannot be acquired (nothing appended)', async () => {
    const { app, world } = makeWebhookHarness({
      transcodeGate: { acquire: () => Promise.reject(new Error('semaphore_timeout')) },
    });
    seedUnit(world, 'unit-1');
    const key = 'unit-media/unit-1/aaaaaaaa-0000-0000-0000-000000000003';
    world.mediaObjects.set(key, { body: await bigNoisePng(), contentType: 'image/png' });
    const res = await confirm(app, 'unit-1').send({ keys: [key] });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'transcode_busy' });
    expect(world.units.get('unit-1')!.media ?? []).toEqual([]);
  });

  it('400 transcode_failed when an oversize object is not decodable', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const key = 'unit-media/unit-1/aaaaaaaa-0000-0000-0000-000000000004';
    // 6MB of garbage: passes the size classifier, fails sharp.
    storeObject(world, key, { contentType: 'image/jpeg', size: 6 * 1024 * 1024 });
    const res = await confirm(app, 'unit-1').send({ keys: [key] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('transcode_failed');
  });

  it('mixed body: small key passthrough + corrupt big key dropped -> 200 with the survivor only', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const good = 'unit-media/unit-1/aaaaaaaa-0000-0000-0000-000000000005';
    const bad = 'unit-media/unit-1/aaaaaaaa-0000-0000-0000-000000000006';
    storeObject(world, good, { contentType: 'image/png', size: 64 });
    storeObject(world, bad, { contentType: 'image/jpeg', size: 6 * 1024 * 1024 });
    const res = await confirm(app, 'unit-1').send({ keys: [good, bad] });
    expect(res.status).toBe(200);
    expect(res.body.unit.media).toEqual([good]);
  });

  it('drops a stored object over the 20MB source cap (defense in depth)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const key = 'unit-media/unit-1/aaaaaaaa-0000-0000-0000-000000000007';
    storeObject(world, key, { contentType: 'image/jpeg', size: 21 * 1024 * 1024 });
    const res = await confirm(app, 'unit-1').send({ keys: [key] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no_valid_photos');
  });
});
```

NOTE: the harness call `makeWebhookHarness({ transcodeGate: ... })` requires the
harness to thread that option into `createUnitsRouter` deps - add it in Step 3.

ALSO update the EXISTING test at `app/test/unitsApiPhotos.test.ts:232`
("drops a key that failed the stored type / size re-check"): its `tooBig` object
is `OUTBOUND_MMS_MAX_FILE_BYTES + 1` (5MB+1) of garbage, which under the new
semantics enters the TRANSCODE branch and gets dropped as corrupt - the test
would keep passing for the wrong reason. Change that line to pin the real size
guard (and swap the import to the photo constant):

```ts
    storeObject(world, tooBig, { contentType: 'image/png', size: UNIT_PHOTO_SOURCE_MAX_BYTES + 1 });
```

(`UNIT_PHOTO_SOURCE_MAX_BYTES` is already imported by the Task 3 test; the
`OUTBOUND_MMS_MAX_FILE_BYTES` import at line 13 becomes unused - remove it.)

- [ ] **Step 2: Run to verify failure**

Run: `cd app; npx vitest run test/unitsApiPhotos.test.ts`
Expected: new describe FAILS (oversize keys are dropped by today's 5MB re-check; no transcode branch, no `transcodeGate` harness option).

- [ ] **Step 3: Implement the confirm transcode branch** - in `app/src/routes/units.ts`:

Imports: add

```ts
import { Readable } from 'node:stream';
import { transcodeForUnitPhoto } from '../adapters/mediaTranscode.js';
import { sharedTranscodeGate } from '../lib/transcodeGate.js';
import type { Semaphore } from '../lib/semaphore.js';
import { MMS_TRANSCODE_WAIT_TIMEOUT_MS } from '../lib/outboundMediaLimits.js';
import { UNIT_PHOTO_SOURCE_MAX_BYTES, UNIT_PHOTO_PASSTHROUGH_MAX_BYTES } from '../lib/unitPhotoLimits.js';
```

and REMOVE the now-unused `OUTBOUND_MMS_MAX_FILE_BYTES` import (its only use was the confirm size re-check being replaced; verify with a grep before deleting).

Deps interface (after `mediaStore?` ~line 78):

```ts
  /**
   * unit-photo-transcode: the process-wide transcode gate (shared with MMS
   * confirm - ONE memory bound). Injectable for tests; defaults to the shared
   * instance.
   */
  transcodeGate?: Semaphore;
```

and in the router factory body: `const transcodeGate = deps.transcodeGate ?? sharedTranscodeGate;`
plus a local helper above the routes (copied from mmsMedia.ts):

```ts
// MediaStore.put wants a Readable; wrap the finished transcode buffer.
function bufferToStream(buf: Buffer): Readable {
  return Readable.from([buf]);
}
```

In the confirm handler, replace the type/size re-check (line ~592) and collect
transcode work instead of dropping oversize keys. Replace:

```ts
      if (!isImageMediaType(head.contentType) || (head.size ?? Infinity) > OUTBOUND_MMS_MAX_FILE_BYTES) {
        log.warn({ unitId }, 'unit photos confirm: stored type/size re-check failed - key dropped');
        continue;
      }
      survivors.push(key);
```

with (and declare `const transcodePending: { key: string; sourceType: string }[] = [];` beside `const survivors`):

```ts
      if (!isImageMediaType(head.contentType)) {
        log.warn({ unitId }, 'unit photos confirm: stored type re-check failed - key dropped');
        continue;
      }
      const size = head.size ?? Infinity;
      if (size > UNIT_PHOTO_SOURCE_MAX_BYTES) {
        // The presign policy already forbids this; defense in depth.
        log.warn({ unitId }, 'unit photos confirm: stored size over the source cap - key dropped');
        continue;
      }
      if (size <= UNIT_PHOTO_PASSTHROUGH_MAX_BYTES) {
        // <=5MB: stored byte-identical - the pre-transcode behavior, unchanged.
        survivors.push(key);
        continue;
      }
      // >5MB: fit at confirm (design 2026-07-21) - transcoded below, behind the gate.
      transcodePending.push({ key, sourceType: head.contentType!.trim().toLowerCase() });
```

Then AFTER the for-loop and BEFORE the `if (survivors.length === 0)` block, insert
the transcode pass:

```ts
    // >5MB sources: download + fit to the photo rendition profile, behind the
    // SHARED process-wide gate (one raster memory bound with MMS confirm). The
    // rendition is appended under a FRESH uuid key - indistinguishable from a
    // direct upload, so display/flyer/namespace-guard need no changes. The
    // oversize ORIGINAL stays as an accepted orphan (issue
    // unit-photo-removal-never-deletes-s3-objects). A per-key transcode failure
    // drops THAT key (confirm's per-key posture); gate starvation is a
    // request-level 503 (memory pressure, not this key's fault). PII: byte
    // counts + unitId only - never keys/filenames.
    let transcodeFailed = 0;
    for (const pending of transcodePending) {
      let release: (() => void) | undefined;
      try {
        release = await transcodeGate.acquire(MMS_TRANSCODE_WAIT_TIMEOUT_MS);
      } catch {
        res.status(503).json({ error: 'transcode_busy' });
        return;
      }
      try {
        const bytes = await mediaStore.getBytes(pending.key);
        if (!bytes) {
          transcodeFailed += 1;
          log.warn({ unitId }, 'unit photo transcode: source vanished - key dropped');
          continue;
        }
        const result = await transcodeForUnitPhoto(bytes, pending.sourceType);
        if (result.bytes.length > UNIT_PHOTO_PASSTHROUGH_MAX_BYTES) {
          // Practically unreachable at 2560px, but the stored-photo invariant holds.
          transcodeFailed += 1;
          log.warn({ unitId, byteCount: result.bytes.length }, 'unit photo transcode: rendition over the stored cap - key dropped');
          continue;
        }
        const renditionKey = `${ownPrefix}${randomUUID()}`;
        await mediaStore.put(renditionKey, bufferToStream(result.bytes), result.contentType);
        log.info(
          { unitId, sourceBytes: bytes.length, renditionBytes: result.bytes.length, transcodedFrom: result.transcodedFrom },
          'unit photo transcoded',
        );
        survivors.push(renditionKey);
      } catch (err) {
        transcodeFailed += 1;
        log.warn({ err, unitId }, 'unit photo transcode failed - key dropped');
      } finally {
        release();
      }
    }
```

Finally, extend the no-survivors branch (line ~599): after the `alreadyPresent > 0`
replay return, replace `res.status(400).json({ error: 'no_valid_photos' });` with:

```ts
      res.status(400).json({ error: transcodeFailed > 0 ? 'transcode_failed' : 'no_valid_photos' });
```

Update the confirm route's header comment (lines ~495-519) to document the new
(d') size classifier + transcode pass in the same style.

- [ ] **Step 4: Thread `transcodeGate` through the harness** - in
`app/test/helpers/twilioWebhookHarness.ts`, add to the harness options type (the
same object that carries `withoutMediaStore`) a `transcodeGate?: Semaphore`
(import `type { Semaphore } from '../../src/lib/semaphore.js';`) and pass it into
`createUnitsRouter({ ... , ...(opts.transcodeGate !== undefined && { transcodeGate: opts.transcodeGate }) })`.

- [ ] **Step 5: Run to verify pass**

Run: `cd app; npx vitest run test/unitsApiPhotos.test.ts`
Expected: PASS - all existing photo cases (passthrough semantics untouched) + the six new transcode cases.

- [ ] **Step 6: Run the app suite for fallout**

Run: `cd app; npx vitest run`
Expected: PASS (the removed `OUTBOUND_MMS_MAX_FILE_BYTES` import in units.ts had no other use; nothing else changed).

- [ ] **Step 7: Commit**

```bash
git add app/src/routes/units.ts app/test/unitsApiPhotos.test.ts app/test/helpers/twilioWebhookHarness.ts
git commit -m "feat(photos): confirm transcodes >5MB sources into 2560/q85 jpeg renditions behind the shared gate"
```

---

### Task 5: Dashboard - 20MB pre-check + size-chunked confirms + new error copy

**Files:**
- Modify: `dashboard/src/routes/listing/ListingDetail.tsx` (constants ~96-127, upload flow ~276-334)
- Test: `dashboard/src/routes/listing/ListingDetail.test.tsx` (extend)

**Interfaces:**
- Consumes: server codes `transcode_busy` / `transcode_failed` (Task 4); existing `presignUnitPhotos(unitId, files)` / `uploadToPresignedPost(post, file)` / `confirmUnitPhotos(unitId, keys)` clients.
- Produces: nothing downstream; this is the leaf.

- [ ] **Step 1: Write the failing tests** - append to `dashboard/src/routes/listing/ListingDetail.test.tsx` inside the photo-upload describe, using the file's REAL helpers (`renderAt()`, the `READY` listing state, `grantsFor(files)` at line ~531, `document.querySelector('input[type="file"]')` - the exact pattern of the "+ Add flow" test at line ~538):

```tsx
  /** jsdom File.size derives from content; override it so a 1-byte body can
   *  stand in for a 26MB photo. */
  function photoOfSize(name: string, bytes: number): File {
    const f = new File(['x'], name, { type: 'image/jpeg' });
    Object.defineProperty(f, 'size', { value: bytes });
    return f;
  }

  it('drops a >20MB file with a NAMED message and uploads the rest', async () => {
    const setUnit = vi.fn();
    useListing.mockReturnValue({ ...READY, setUnit });
    presignUnitPhotos.mockImplementation((_id: string, files: File[]) => Promise.resolve(grantsFor(files)));
    uploadToPresignedPost.mockResolvedValue(undefined);
    confirmUnitPhotos.mockResolvedValue(READY.unit!);
    renderAt();

    const ok = photoOfSize('ok.jpg', 1 * 1024 * 1024);
    const huge = photoOfSize('backyard.jpg', 27262976); // 26.0MB
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [ok, huge] } });

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'backyard.jpg is 26.0MB - the limit is 20MB per photo.',
      ),
    );
    // Only the in-limit file was presigned + uploaded.
    expect(presignUnitPhotos).toHaveBeenCalledTimes(1);
    expect((presignUnitPhotos.mock.calls[0]![1] as File[]).map((f) => f.name)).toEqual(['ok.jpg']);
    await waitFor(() => expect(uploadToPresignedPost).toHaveBeenCalledTimes(1));
  });

  it('confirms >5MB files in their OWN requests (one transcode per request) and small files as a batch', async () => {
    const setUnit = vi.fn();
    useListing.mockReturnValue({ ...READY, setUnit });
    presignUnitPhotos.mockImplementation((_id: string, files: File[]) => Promise.resolve(grantsFor(files)));
    uploadToPresignedPost.mockResolvedValue(undefined);
    confirmUnitPhotos.mockResolvedValue(READY.unit!);
    renderAt();

    const files = [
      photoOfSize('a.jpg', 1 * 1024 * 1024),
      photoOfSize('b.jpg', 8 * 1024 * 1024), // > 5MB -> its own confirm
      photoOfSize('c.jpg', 2 * 1024 * 1024),
    ];
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files } });

    await waitFor(() => expect(uploadToPresignedPost).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(confirmUnitPhotos).toHaveBeenCalledTimes(2));
    const batches = confirmUnitPhotos.mock.calls.map((c) => (c[1] as string[]).slice().sort());
    // One batch with BOTH small keys (indexes 0 + 2), one singleton with the big key (index 1).
    expect(batches).toContainEqual(['unit-media/u1/key-0', 'unit-media/u1/key-2']);
    expect(batches).toContainEqual(['unit-media/u1/key-1']);
    // Unit state applied after EACH confirm (progressive rendering).
    expect(setUnit).toHaveBeenCalledTimes(2);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd dashboard; npx vitest run src/routes/listing/ListingDetail.test.tsx`
Expected: both new cases FAIL (no pre-check; single confirm per wave today).

- [ ] **Step 3: Implement** - in `dashboard/src/routes/listing/ListingDetail.tsx`:

Constants (after `PHOTO_UPLOAD_CONCURRENCY`):

```tsx
/** Mirror of the server's UNIT_PHOTO_SOURCE_MAX_BYTES presign policy cap - a
 *  file over this is rejected by S3 itself, so drop it client-side with an
 *  honest, NAMED message instead of a doomed upload. Server re-enforces. */
const PHOTO_MAX_SOURCE_BYTES = 20 * 1024 * 1024;

/** Mirror of UNIT_PHOTO_PASSTHROUGH_MAX_BYTES: a file over this transcodes at
 *  confirm (one sharp run behind a 2-slot server gate), so each such file is
 *  confirmed in its OWN request - a batch of transcodes serialized in one
 *  request could brush CloudFront's 30s origin timeout. */
const PHOTO_TRANSCODE_THRESHOLD_BYTES = 5 * 1024 * 1024;
```

Extend `photoUploadMessage` with the two new codes (before `default`):

```tsx
    case 'transcode_busy':
      return 'The server is busy fitting large photos - please try again in a moment.';
    case 'transcode_failed':
      return "A large photo couldn't be processed - it may be corrupted. Re-export it and try again.";
```

Rework `onFilesChosen`:

```tsx
  const onFilesChosen = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const input = e.currentTarget;
    const picked = input.files ? Array.from(input.files) : [];
    input.value = '';
    if (picked.length === 0 || photoBusy) return;
    // 20MB pre-check: a file over the presign policy cap would 400 at S3 -
    // drop it here with a NAMED message and upload the rest.
    const tooBig = picked.filter((f) => f.size > PHOTO_MAX_SOURCE_BYTES);
    const chosen = picked.filter((f) => f.size <= PHOTO_MAX_SOURCE_BYTES);
    const oversizeMsg =
      tooBig.length > 0
        ? `${tooBig
            .map((f) => `${f.name} is ${(f.size / (1024 * 1024)).toFixed(1)}MB`)
            .join(', ')} - the limit is 20MB per photo.`
        : null;
    if (chosen.length === 0) {
      setPhotoError(oversizeMsg);
      return;
    }
    setPhotoBusy(true);
    setPhotoError(null);
    void (async () => {
      const total = chosen.length;
      let uploaded = 0;
      try {
        // Sequential 20-file waves keep each presign request within the server's
        // per-request batch max; the direct POSTs inside a wave run in parallel.
        for (let w = 0; w < chosen.length; w += PHOTO_PRESIGN_WAVE_SIZE) {
          const wave = chosen.slice(w, w + PHOTO_PRESIGN_WAVE_SIZE);
          const grants = await presignUnitPhotos(unit.unitId, wave);
          // Simple concurrency pool: at most PHOTO_UPLOAD_CONCURRENCY direct
          // POSTs in flight; each worker pulls the next index until the wave is
          // drained. grants[i] pairs with wave[i] (the server keeps order).
          const okSmallKeys: string[] = [];
          const okBigKeys: string[] = [];
          let next = 0;
          const worker = async (): Promise<void> => {
            while (next < wave.length) {
              const i = next++;
              const grant = grants[i];
              const file = wave[i];
              if (grant === undefined || file === undefined) continue;
              try {
                await uploadToPresignedPost(grant.post, file);
                if (file.size > PHOTO_TRANSCODE_THRESHOLD_BYTES) okBigKeys.push(grant.key);
                else okSmallKeys.push(grant.key);
              } catch {
                // A single file failed to reach S3 - drop it (honest partial).
              }
            }
          };
          await Promise.all(
            Array.from({ length: Math.min(PHOTO_UPLOAD_CONCURRENCY, wave.length) }, () => worker()),
          );
          // Confirm small files as one batch; each >5MB file in its OWN request
          // (one server-side transcode per request - see the threshold const).
          const confirmBatches = [
            ...(okSmallKeys.length > 0 ? [okSmallKeys] : []),
            ...okBigKeys.map((k) => [k]),
          ];
          for (const batch of confirmBatches) {
            const updated = await confirmUnitPhotos(unit.unitId, batch);
            uploaded += batch.length;
            setUnit(updated);
          }
        }
        if (uploaded < total) {
          setPhotoError(
            `Uploaded ${uploaded} of ${total} photos - some photos couldn't be uploaded. Please try again.`,
          );
        } else if (oversizeMsg) {
          setPhotoError(oversizeMsg);
        }
      } catch (err) {
        const base = photoUploadMessage(err);
        setPhotoError(
          uploaded > 0 ? `Uploaded ${uploaded} of ${total} photos - ${base}` : base,
        );
      } finally {
        setPhotoBusy(false);
      }
    })();
  };
```

(Every pre-existing line of the flow is preserved except the confirm call, the
per-file key split, and the oversize handling - keep the surrounding comments.)

- [ ] **Step 4: Run to verify pass**

Run: `cd dashboard; npx vitest run src/routes/listing/ListingDetail.test.tsx`
Expected: PASS - the two new cases plus every existing photo test (the single-batch
cases still produce exactly one confirm call because all their files are small).

- [ ] **Step 5: Run the dashboard suite**

Run: `cd dashboard; npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/routes/listing/ListingDetail.tsx dashboard/src/routes/listing/ListingDetail.test.tsx
git commit -m "feat(photos): 20MB named-file pre-check + size-chunked confirms + transcode error copy"
```

---

### Task 6: e2e - a real >5MB photo through the MinIO policy edge

**Files:**
- Modify: `e2e/tests/dashboard-next/listing-photos.spec.ts` (extend)

**Interfaces:**
- Consumes: the deployed-shape stack (MinIO enforces the presigned-POST policy exactly like S3 - proven by the unit-photos spike); the dashboard flow from Task 5.

- [ ] **Step 1: Read the existing spec** - open `e2e/tests/dashboard-next/listing-photos.spec.ts`. It already has everything to reuse verbatim: the dev-login flow (line ~37), the `photoInput(page)` locator helper (line ~70, the file input scoped under the `Photos` heading), the "upload done" wait (the `+ Add` button re-enabled, line ~81), and gallery assertions via `getByRole('img', { name: 'Property photo N' })` (line ~153). Copy the navigation lines the existing upload test (line ~139) uses to reach a unit's listing detail.

- [ ] **Step 2: Add the big-photo case** - the >5MB source must be REAL decodable image bytes (the server sharp-decodes it), generated in the BROWSER so the e2e workspace needs no image dependency:

```ts
test('a >5MB photo uploads, transcodes at confirm, and renders in the gallery', async ({ page }) => {
  // Dev-login + navigate to a unit's listing detail: copy the exact lines the
  // upload test at line ~139 uses (same seeded unit, same waits).

  // Generate a genuinely-decodable >5MB png IN THE BROWSER: random noise defeats
  // png compression, so 1800x1800 noise comfortably exceeds 5MB.
  const bigPngBase64 = await page.evaluate(async () => {
    const side = 1800;
    const canvas = document.createElement('canvas');
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(side, side);
    for (let i = 0; i < img.data.length; i += 1) img.data[i] = (Math.random() * 256) | 0;
    ctx.putImageData(img, 0, 0);
    const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), 'image/png'));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  const bigPng = Buffer.from(bigPngBase64, 'base64');
  expect(bigPng.length).toBeGreaterThan(5 * 1024 * 1024);

  await photoInput(page).setInputFiles({ name: 'huge-noise.png', mimeType: 'image/png', buffer: bigPng });
  // Upload + its own confirm complete when "+ Add" re-enables (the sibling
  // tests' done-signal, line ~81); the transcode adds a few seconds.
  await expect(page.getByRole('button', { name: '+ Add' })).toBeEnabled({ timeout: 30_000 });

  // The gallery gained the photo (a transcoded RENDITION - the browser POSTed
  // 5MB+ straight to MinIO, which the OLD 5MB policy would have 400'd) and no
  // error alert is showing.
  await expect(page.getByRole('img', { name: 'Property photo 1' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
```

(If the seeded unit already carries photos, bump the `Property photo N` index to
the new count exactly as the sibling multi-photo test at line ~163 does.)

- [ ] **Step 3: Run the spec file against the harness stack**

Run: `cd e2e; npx playwright test tests/dashboard-next/listing-photos.spec.ts`
(NEVER from the repo root - a root run targets the live :5174 stack.)
Expected: PASS including the new case.

- [ ] **Step 4: Commit**

```bash
git add e2e/tests/dashboard-next/listing-photos.spec.ts
git commit -m "test(e2e): >5MB photo uploads through the MinIO policy edge and renders transcoded"
```

---

### Task 7: Full gates + handback

- [ ] **Step 1: Sync main ONCE**

```bash
git fetch; git merge main
```

Resolve any conflicts keeping BOTH sides' intent (units.ts and app.ts move fast).

- [ ] **Step 2: Run all three gates BARE from the worktree root**

```bash
npm run typecheck
npm test
npm run e2e
```

Expected: all exit 0. `npm run typecheck` is REQUIRED - the runtime suites strip
types without checking them.

- [ ] **Step 3: Verify the live flow (superpowers:verification-before-completion + the repo verify lane)** - `npm run e2e:session`, dev-login, upload a real >5MB photo via the browser, confirm the gallery renders it and the network log shows browser->MinIO POST + per-big-file confirm requests.

- [ ] **Step 4: Hand back** - report gate outputs + the branch name. Do NOT merge into main (human gate).
