<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-07-16).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Outbound MMS Media Transcoding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee every attachment sent over MMS is a Twilio-deliverable type (jpeg/png/gif), by transcoding webp/pdf and auto-fitting oversized images at upload time -- fixing Twilio error 12300.

**Architecture:** Migrate the MMS composer upload from the busboy through-EC2 endpoint to a direct-to-S3 presign/confirm flow (mirroring unit photos). Confirm decides per file (on HeadObject alone) whether to flow the original through (small jpeg/png/gif) or download+transcode (webp/pdf/oversized) via a new `mediaTranscode.ts` adapter (`sharp` + `@hyzyla/pdfium`), bounded by a concurrency semaphore. The original is always retained; attachments are modeled as `original + mms rendition` behind a `renditionFor` seam so RCS is additive later.

**Tech Stack:** TypeScript, Node 24, Express, `sharp` (Apache-2.0), `@hyzyla/pdfium` (MIT, WASM), `pdf-lib` (test fixtures), Vitest, Playwright, S3/MinIO via the existing `MediaStore` adapter.

**Spec:** `docs/superpowers/specs/2026-07-16-outbound-mms-transcoding-design.md`

## Global Constraints

- New RUNTIME deps go in **`app/package.json`** (never root): `sharp`, `@hyzyla/pdfium`. The Dockerfile runtime stage runs `npm ci --workspace app --omit=dev` which omits root; a root-level runtime dep boot-crashes prod.
- `pdf-lib` is a **devDependency** of `app` (test-fixture generation only).
- **ASCII only** in all source, comments, and test strings. Verify with `tr -d '\11\12\15\40-\176' < FILE | wc -c` == 0.
- App tests run with **Vitest**: from `app/`, a single file is `npx vitest run <path>`; the whole suite is `npm test --workspace app`.
- Typecheck is a REQUIRED gate: `npm run typecheck` (runs `tsc` per workspace). `npm test` does NOT type-check.
- Twilio-deliverable MMS types: **`image/jpeg, image/png, image/gif`** (exact set).
- Constants (exact values): `PASSTHROUGH_MAX_BYTES = 1_000_000`; `TRANSCODE_TARGET_MAX_EDGE = 1600`; `TRANSCODE_TARGET_MAX_BYTES = 1_500_000`; `TRANSCODE_JPEG_QUALITY_LADDER = [82, 72, 62, 52, 42]`; `MMS_UPLOAD_SOURCE_MAX_BYTES = 20 * 1024 * 1024`; `MMS_TRANSCODE_MAX_CONCURRENT = 2`; `MMS_TRANSCODE_WAIT_TIMEOUT_MS = 20_000`; `SHARP_MAX_INPUT_PIXELS = 24_000_000`.
- pdfium render pipeline (spike-verified; the pdfium.js.org docs are WRONG): `page.render({ scale, render: 'bitmap' })` returns raw **RGBA** `{ data, width, height }`; feed to `sharp(Buffer.from(data), { raw: { width, height, channels: 4 } })`. Do NOT use `render: 'sharp'` (does not exist in 2.1.13). Assert color-accuracy in tests.
- Presigned URLs are bearer tokens: never log them. Log `s3Key` + byte counts + `transcodedFrom` only, never filenames or file bytes.
- Commit after every task. Do not merge to main.

## File Structure

New files:
- `app/src/adapters/mediaTranscode.ts` -- sharp + pdfium adapter (only importer of both).
- `app/test/mediaTranscode.test.ts` -- adapter tests (real bytes).
- `app/src/lib/semaphore.ts` -- tiny async concurrency gate.
- `app/test/semaphore.test.ts`.
- `app/src/routes/mmsMedia.ts` -- `POST /api/media/presign` + `POST /api/media/confirm` (replaces `mediaUploads.ts`).
- `app/test/mmsMedia.test.ts` -- route integration tests.
- `app/src/lib/mmsRenditions.ts` -- `renditionFor(channel, attachment)` seam.
- `e2e/tests/mms-transcode.spec.ts` -- e2e.

Modified files:
- `app/src/lib/mediaTypes.ts` -- add `TWILIO_DELIVERABLE_MMS_TYPES`, `isTwilioDeliverableType`, `planMmsMedia`.
- `app/src/lib/outboundMediaLimits.ts` -- add the transcode constants.
- `app/src/adapters/mediaStore.ts` -- add `getBytes(key)`.
- `app/src/repos/messagesRepo.ts` -- add `originalKey?` to `MediaAttachment`.
- `app/src/routes/api.ts` -- mount `mmsMedia` router (drop `mediaUploads`); tighten `resolveAttachmentKeys` (deliverable-type guard + `attachmentOriginalKeys`); route send media through `renditionFor`.
- `dashboard/src/api/endpoints.ts` + `dashboard/src/api/types.ts` -- add `presignMmsMedia`, `confirmMmsMedia`; retire `uploadMedia`.
- `dashboard/src/routes/contact/Timeline.tsx` -- composer upload flow + pdf warning + error detail.

Deleted files:
- `app/src/routes/mediaUploads.ts` + `app/test/mediaUploads.test.ts` (replaced by mmsMedia).

---

### Task 1: Add + prove runtime dependencies

**Files:**
- Modify: `app/package.json` (dependencies + devDependencies)
- Create: `app/test/deps-smoke.test.ts`

**Interfaces:**
- Produces: `sharp` and `@hyzyla/pdfium` importable in `app`; `pdf-lib` importable in tests.

- [x] **Step 1: Install the deps into the app workspace**

Run (from repo root):
```bash
npm install --workspace app sharp @hyzyla/pdfium
npm install --workspace app --save-dev pdf-lib
```

- [x] **Step 2: Ensure the lockfile carries the linux-arm64 sharp binary**

sharp's platform binary is an OPTIONAL dep; the lockfile must contain `@img/sharp-linux-arm64` or the arm64 runtime `npm ci` skips it (boot crash). Populate it:
```bash
npm install --workspace app --cpu=arm64 --os=linux --include=optional sharp
grep -q "@img/sharp-linux-arm64" package-lock.json && echo "arm64 sharp present in lockfile" || echo "MISSING - do not proceed"
```
Expected: `arm64 sharp present in lockfile`.

- [x] **Step 3: Write a smoke test that imports both libs**

```typescript
// app/test/deps-smoke.test.ts
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { PDFiumLibrary } from '@hyzyla/pdfium';

describe('transcode deps load', () => {
  it('sharp encodes a jpeg', async () => {
    const jpg = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .toBuffer();
    const meta = await sharp(jpg).metadata();
    expect(meta.format).toBe('jpeg');
  });

  it('pdfium WASM initializes', async () => {
    const lib = await PDFiumLibrary.init();
    expect(typeof lib.loadDocument).toBe('function');
    lib.destroy();
  });
});
```

- [x] **Step 4: Run the smoke test**

Run: `cd app && npx vitest run test/deps-smoke.test.ts`
Expected: PASS (2 tests).

- [x] **Step 5: Prove the arm64 runtime install (the boot-crash gate)**

Run (from repo root; requires Docker):
```bash
docker run --rm --platform linux/arm64 -v "$PWD":/w -w /w node:24-slim \
  bash -c "npm ci --workspace app --omit=dev >/dev/null 2>&1 && node -e \"require('sharp'); require('@hyzyla/pdfium'); console.log('arm64 runtime deps OK')\""
```
Expected: `arm64 runtime deps OK`. If it fails with "Could not load the sharp module", the lockfile is missing the arm64 variant -- redo Step 2.

- [x] **Step 6: Commit**

```bash
git add app/package.json package-lock.json app/test/deps-smoke.test.ts
git commit -m "build(mms): add sharp + @hyzyla/pdfium (arm64-proven) for MMS transcoding"
```

---

### Task 2: Deliverable-type registry + plan() + constants

**Files:**
- Modify: `app/src/lib/outboundMediaLimits.ts`
- Modify: `app/src/lib/mediaTypes.ts`
- Test: `app/test/mediaTypes.plan.test.ts`

**Interfaces:**
- Produces:
  - `TWILIO_DELIVERABLE_MMS_TYPES: ReadonlySet<string>`
  - `isTwilioDeliverableType(type: string | undefined): boolean`
  - `type MmsMediaPlan = 'deliver' | 'transcode-image' | 'transcode-pdf' | 'reject'`
  - `planMmsMedia(sourceType: string, sizeBytes: number): MmsMediaPlan`
  - Constants from Global Constraints in `outboundMediaLimits.ts`.

- [x] **Step 1: Add the constants**

Append to `app/src/lib/outboundMediaLimits.ts`:
```typescript
/** A deliverable jpeg/png at or under this flows through untouched; over it, auto-fit. */
export const PASSTHROUGH_MAX_BYTES = 1_000_000;

/** Longest-edge cap (px) for a transcoded MMS rendition. */
export const TRANSCODE_TARGET_MAX_EDGE = 1600;

/** Per-file soft target the JPEG quality ladder aims to get under. */
export const TRANSCODE_TARGET_MAX_BYTES = 1_500_000;

/** JPEG qualities tried in order until the encoded result is <= TRANSCODE_TARGET_MAX_BYTES. */
export const TRANSCODE_JPEG_QUALITY_LADDER = [82, 72, 62, 52, 42] as const;

/** Presign cap on the ORIGINAL upload (MMS-era ceiling; RCS may raise it). */
export const MMS_UPLOAD_SOURCE_MAX_BYTES = 20 * 1024 * 1024;

/** Max concurrent confirm-time transcodes process-wide (memory bound). */
export const MMS_TRANSCODE_MAX_CONCURRENT = 2;

/** How long a queued confirm waits for a transcode slot before 503. */
export const MMS_TRANSCODE_WAIT_TIMEOUT_MS = 20_000;

/** sharp input-pixel cap: reject absurd dimensions before a full raster decode. */
export const SHARP_MAX_INPUT_PIXELS = 24_000_000;
```

- [x] **Step 2: Write the failing registry/plan test**

```typescript
// app/test/mediaTypes.plan.test.ts
import { describe, it, expect } from 'vitest';
import {
  TWILIO_DELIVERABLE_MMS_TYPES,
  isTwilioDeliverableType,
  planMmsMedia,
  INLINE_MEDIA_TYPES,
} from '../src/lib/mediaTypes.js';
import { PASSTHROUGH_MAX_BYTES } from '../src/lib/outboundMediaLimits.js';

describe('Twilio deliverable registry', () => {
  it('is exactly jpeg/png/gif', () => {
    expect([...TWILIO_DELIVERABLE_MMS_TYPES].sort()).toEqual(['image/gif', 'image/jpeg', 'image/png']);
  });
  it('isTwilioDeliverableType is case-insensitive and rejects webp/pdf', () => {
    expect(isTwilioDeliverableType('IMAGE/JPEG')).toBe(true);
    expect(isTwilioDeliverableType('image/webp')).toBe(false);
    expect(isTwilioDeliverableType('application/pdf')).toBe(false);
    expect(isTwilioDeliverableType(undefined)).toBe(false);
  });
});

describe('planMmsMedia', () => {
  const small = PASSTHROUGH_MAX_BYTES - 1;
  const big = PASSTHROUGH_MAX_BYTES + 1;
  it('pdf -> transcode-pdf', () => expect(planMmsMedia('application/pdf', small)).toBe('transcode-pdf'));
  it('gif -> deliver at any size', () => {
    expect(planMmsMedia('image/gif', small)).toBe('deliver');
    expect(planMmsMedia('image/gif', big)).toBe('deliver');
  });
  it('small jpeg/png -> deliver', () => {
    expect(planMmsMedia('image/jpeg', small)).toBe('deliver');
    expect(planMmsMedia('image/png', small)).toBe('deliver');
  });
  it('oversized jpeg/png -> transcode-image', () => {
    expect(planMmsMedia('image/jpeg', big)).toBe('transcode-image');
    expect(planMmsMedia('image/png', big)).toBe('transcode-image');
  });
  it('webp -> transcode-image at any size', () => {
    expect(planMmsMedia('image/webp', small)).toBe('transcode-image');
    expect(planMmsMedia('image/webp', big)).toBe('transcode-image');
  });
  it('GUARDRAIL: every uploadable type maps to a non-reject plan', () => {
    for (const t of INLINE_MEDIA_TYPES) {
      expect(planMmsMedia(t, small)).not.toBe('reject');
    }
  });
});
```

- [x] **Step 3: Run it (fails: not exported)**

Run: `cd app && npx vitest run test/mediaTypes.plan.test.ts`
Expected: FAIL (imports undefined).

- [x] **Step 4: Implement in `app/src/lib/mediaTypes.ts`**

Append (after the existing exports):
```typescript
import {
  PASSTHROUGH_MAX_BYTES,
} from './outboundMediaLimits.js';

/**
 * The Twilio-carrier-deliverable MMS image types. Narrower than IMAGE_MEDIA_TYPES
 * (which includes webp): Twilio rejects a non-deliverable Content-Type with error
 * 12300. Everything sent to Twilio must be in THIS set.
 */
export const TWILIO_DELIVERABLE_MMS_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
]);

/** True when `type` is a Twilio-deliverable MMS type (case-insensitive). */
export function isTwilioDeliverableType(type: string | undefined): boolean {
  return typeof type === 'string' && TWILIO_DELIVERABLE_MMS_TYPES.has(type.trim().toLowerCase());
}

/** What confirm must do with an uploaded source file to make it MMS-deliverable. */
export type MmsMediaPlan = 'deliver' | 'transcode-image' | 'transcode-pdf' | 'reject';

/**
 * Decide an uploaded file's fate from its Content-Type + size ALONE (no download):
 *  - pdf                      -> rasterize page 1 (transcode-pdf)
 *  - gif                      -> pass through (preserves animation; gif is deliverable)
 *  - small jpeg/png           -> pass through (no needless re-encode)
 *  - webp / oversized jpeg-png-> transcode-image (auto-fit to a deliverable jpeg)
 *  - anything else            -> reject (unreachable; the upload allowlist gates first)
 * The GUARDRAIL test pins that every uploadable type maps to a non-reject plan, so a
 * future uploadable type that Twilio cannot carry fails CI until given a branch.
 */
export function planMmsMedia(sourceType: string, sizeBytes: number): MmsMediaPlan {
  const t = sourceType.trim().toLowerCase();
  if (t === 'application/pdf') return 'transcode-pdf';
  if (t === 'image/gif') return 'deliver';
  if (t === 'image/webp') return 'transcode-image';
  if (t === 'image/jpeg' || t === 'image/png') {
    return sizeBytes <= PASSTHROUGH_MAX_BYTES ? 'deliver' : 'transcode-image';
  }
  return 'reject';
}
```

- [x] **Step 5: Run tests to verify pass + typecheck**

Run: `cd app && npx vitest run test/mediaTypes.plan.test.ts && cd .. && npm run typecheck`
Expected: PASS; typecheck clean.

- [x] **Step 6: Commit**

```bash
git add app/src/lib/mediaTypes.ts app/src/lib/outboundMediaLimits.ts app/test/mediaTypes.plan.test.ts
git commit -m "feat(mms): Twilio-deliverable registry + planMmsMedia + transcode constants"
```

---

### Task 3: Concurrency semaphore

**Files:**
- Create: `app/src/lib/semaphore.ts`
- Test: `app/test/semaphore.test.ts`

**Interfaces:**
- Produces: `createSemaphore(max: number)` -> `{ acquire(timeoutMs: number): Promise<() => void> }`. `acquire` resolves with a release function when a slot is free; rejects with `Error('semaphore_timeout')` if none frees within `timeoutMs`.

- [x] **Step 1: Write the failing test**

```typescript
// app/test/semaphore.test.ts
import { describe, it, expect } from 'vitest';
import { createSemaphore } from '../src/lib/semaphore.js';

describe('createSemaphore', () => {
  it('bounds concurrency to max', async () => {
    const sem = createSemaphore(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      const release = await sem.acquire(1000);
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--; release();
    };
    await Promise.all(Array.from({ length: 6 }, task));
    expect(peak).toBe(2);
  });

  it('times out when no slot frees in time', async () => {
    const sem = createSemaphore(1);
    const held = await sem.acquire(1000); // hold the only slot
    await expect(sem.acquire(30)).rejects.toThrow('semaphore_timeout');
    held();
  });

  it('a released slot lets a waiter proceed', async () => {
    const sem = createSemaphore(1);
    const first = await sem.acquire(1000);
    const p = sem.acquire(1000);
    setTimeout(() => first(), 10);
    const second = await p;
    expect(typeof second).toBe('function');
    second();
  });
});
```

- [x] **Step 2: Run it (fails)**

Run: `cd app && npx vitest run test/semaphore.test.ts`
Expected: FAIL (module not found).

- [x] **Step 3: Implement `app/src/lib/semaphore.ts`**

```typescript
// A tiny in-process async concurrency gate. acquire() resolves with a release fn
// when a slot is free; if none frees within timeoutMs it rejects with
// 'semaphore_timeout'. FIFO among waiters. No external deps.

export interface Semaphore {
  acquire(timeoutMs: number): Promise<() => void>;
}

export function createSemaphore(max: number): Semaphore {
  let inUse = 0;
  const waiters: Array<{ resolve: (release: () => void) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  const release = (): void => {
    inUse--;
    const next = waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      inUse++;
      next.resolve(release);
    }
  };

  return {
    acquire(timeoutMs: number): Promise<() => void> {
      if (inUse < max) {
        inUse++;
        return Promise.resolve(release);
      }
      return new Promise<() => void>((resolve, reject) => {
        const entry = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const i = waiters.indexOf(entry);
            if (i >= 0) waiters.splice(i, 1);
            reject(new Error('semaphore_timeout'));
          }, timeoutMs),
        };
        waiters.push(entry);
      });
    },
  };
}
```

- [x] **Step 4: Run tests to verify pass**

Run: `cd app && npx vitest run test/semaphore.test.ts`
Expected: PASS (3 tests).

- [x] **Step 5: Commit**

```bash
git add app/src/lib/semaphore.ts app/test/semaphore.test.ts
git commit -m "feat(lib): in-process concurrency semaphore with acquire timeout"
```

---

### Task 4: MediaStore.getBytes(key)

**Files:**
- Modify: `app/src/adapters/mediaStore.ts` (interface + `S3MediaStore`)
- Test: `app/test/mediaStore.getBytes.test.ts`

**Interfaces:**
- Consumes: existing `S3MediaStore.getStream` (returns `{ body: Readable } | undefined`).
- Produces: `MediaStore.getBytes(key: string): Promise<Buffer | undefined>` -- the whole object as a Buffer, or undefined if absent.

- [x] **Step 1: Write the failing test (fake client via getStream)**

```typescript
// app/test/mediaStore.getBytes.test.ts
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { S3MediaStore } from '../src/adapters/mediaStore.js';

function fakeClient(bytes: Buffer | null) {
  return {
    send: async () => {
      if (bytes === null) { const e = new Error('missing'); (e as { name?: string }).name = 'NoSuchKey'; throw e; }
      return { Body: Readable.from([bytes]) };
    },
  } as unknown as ConstructorParameters<typeof S3MediaStore>[1];
}

describe('S3MediaStore.getBytes', () => {
  it('reads the whole object into a Buffer', async () => {
    const store = new S3MediaStore('bucket', fakeClient(Buffer.from('hello world')));
    const out = await store.getBytes('uploads/x');
    expect(out?.toString()).toBe('hello world');
  });
  it('returns undefined for an absent key', async () => {
    const store = new S3MediaStore('bucket', fakeClient(null));
    expect(await store.getBytes('uploads/missing')).toBeUndefined();
  });
});
```

- [x] **Step 2: Run it (fails: getBytes undefined)**

Run: `cd app && npx vitest run test/mediaStore.getBytes.test.ts`
Expected: FAIL.

- [x] **Step 3: Add `getBytes` to the interface and `S3MediaStore`**

In `app/src/adapters/mediaStore.ts`, add to the `MediaStore` interface (after `getStream`):
```typescript
  /**
   * Read an object fully into a Buffer (outbound MMS transcode: confirm needs the
   * bytes to decode). Bounded by the presign source cap upstream. Returns undefined
   * when the key does not exist (same absent-object contract as getStream).
   */
  getBytes(key: string): Promise<Buffer | undefined>;
```
Add to `S3MediaStore` (after `getStream`):
```typescript
  async getBytes(key: string): Promise<Buffer | undefined> {
    const obj = await this.getStream(key);
    if (obj === undefined) return undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of obj.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }
```

- [x] **Step 4: Run tests + typecheck**

Run: `cd app && npx vitest run test/mediaStore.getBytes.test.ts && cd .. && npm run typecheck`
Expected: PASS; typecheck clean.

- [x] **Step 5: Commit**

```bash
git add app/src/adapters/mediaStore.ts app/test/mediaStore.getBytes.test.ts
git commit -m "feat(media): MediaStore.getBytes(key) to buffer an object for transcoding"
```

---

### Task 5: mediaTranscode adapter (sharp + pdfium)

**Files:**
- Create: `app/src/adapters/mediaTranscode.ts`
- Test: `app/test/mediaTranscode.test.ts`

**Interfaces:**
- Consumes: constants from Task 2; `sharp`, `@hyzyla/pdfium` from Task 1.
- Produces: `transcodeForMms(bytes: Buffer, sourceType: string): Promise<{ bytes: Buffer; contentType: 'image/jpeg'; pdfPageCount?: number; transcodedFrom: string }>`. Throws on a corrupt/undecodable input.

- [x] **Step 1: Write the failing test (real bytes, ported from the spike)**

```typescript
// app/test/mediaTranscode.test.ts
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { PDFDocument, rgb } from 'pdf-lib';
import { transcodeForMms } from '../src/adapters/mediaTranscode.js';
import { TRANSCODE_TARGET_MAX_EDGE, TRANSCODE_TARGET_MAX_BYTES } from '../src/lib/outboundMediaLimits.js';

async function makePdf(nPages: number, fill?: { r: number; g: number; b: number }): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < nPages; i++) {
    const p = doc.addPage([200, 200]);
    if (fill) p.drawRectangle({ x: 0, y: 0, width: 200, height: 200, color: rgb(fill.r, fill.g, fill.b) });
  }
  return Buffer.from(await doc.save());
}

describe('transcodeForMms', () => {
  it('webp -> valid jpeg, dims preserved', async () => {
    const webp = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 200, g: 30, b: 30 } } }).webp().toBuffer();
    const out = await transcodeForMms(webp, 'image/webp');
    expect(out.contentType).toBe('image/jpeg');
    expect(out.transcodedFrom).toBe('image/webp');
    const meta = await sharp(out.bytes).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(480);
  });

  it('oversized image is downscaled to the max edge', async () => {
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toBuffer();
    const out = await transcodeForMms(big, 'image/png');
    const meta = await sharp(out.bytes).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(TRANSCODE_TARGET_MAX_EDGE);
    expect(out.bytes.length).toBeLessThanOrEqual(TRANSCODE_TARGET_MAX_BYTES);
  });

  it('pdf -> page count + page 1 rasterized to a COLOR-ACCURATE jpeg', async () => {
    const out = await transcodeForMms(await makePdf(3, { r: 1, g: 0, b: 0 }), 'application/pdf');
    expect(out.contentType).toBe('image/jpeg');
    expect(out.pdfPageCount).toBe(3);
    const { data, info } = await sharp(out.bytes).raw().toBuffer({ resolveWithObject: true });
    const mid = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
    expect(data[mid]).toBeGreaterThan(200);      // red channel high
    expect(data[mid + 2]).toBeLessThan(60);       // blue channel low -> not BGRA-swapped
  });

  it('single-page pdf reports pageCount 1', async () => {
    const out = await transcodeForMms(await makePdf(1), 'application/pdf');
    expect(out.pdfPageCount).toBe(1);
  });

  it('corrupt pdf throws', async () => {
    await expect(transcodeForMms(Buffer.from('NOT A PDF'), 'application/pdf')).rejects.toThrow();
  });

  it('non-image bytes throw', async () => {
    await expect(transcodeForMms(Buffer.from('NOT AN IMAGE'), 'image/webp')).rejects.toThrow();
  });
});
```

- [x] **Step 2: Run it (fails: module missing)**

Run: `cd app && npx vitest run test/mediaTranscode.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement `app/src/adapters/mediaTranscode.ts`**

```typescript
// MediaTranscode -- the ONLY place sharp and @hyzyla/pdfium are imported (adapter
// rule). Converts an uploaded source (webp / oversized jpeg-png / pdf) into a
// Twilio-deliverable JPEG. Verified pipeline (spike 2026-07-16): pdfium renders a
// page to a RAW RGBA buffer via render:'bitmap' (NOT 'sharp' -- that string does
// not exist in 2.1.13), then sharp encodes with explicit raw geometry. Throws on
// a corrupt / undecodable input so the confirm route can return 400.
import sharp from 'sharp';
import { PDFiumLibrary } from '@hyzyla/pdfium';
import {
  TRANSCODE_TARGET_MAX_EDGE,
  TRANSCODE_TARGET_MAX_BYTES,
  TRANSCODE_JPEG_QUALITY_LADDER,
  SHARP_MAX_INPUT_PIXELS,
} from '../lib/outboundMediaLimits.js';

// Configure sharp ONCE at module load: single libvips thread (no per-op thread
// pool each holding buffers) so the semaphore is the only concurrency knob.
sharp.concurrency(1);

export interface TranscodeResult {
  bytes: Buffer;
  contentType: 'image/jpeg';
  pdfPageCount?: number;
  transcodedFrom: string;
}

// pdfium is a heavy WASM init; keep one library instance for the process.
let pdfiumLib: Awaited<ReturnType<typeof PDFiumLibrary.init>> | undefined;
async function getPdfium(): Promise<Awaited<ReturnType<typeof PDFiumLibrary.init>>> {
  if (pdfiumLib === undefined) pdfiumLib = await PDFiumLibrary.init();
  return pdfiumLib;
}

/** Resize (never enlarge) to the max edge, then walk the quality ladder to land
 *  under the target bytes; if none qualifies, keep the lowest-quality result. */
async function encodeJpeg(pipeline: sharp.Sharp): Promise<Buffer> {
  const base = pipeline
    .rotate() // honor EXIF orientation before metadata is stripped
    .resize({ width: TRANSCODE_TARGET_MAX_EDGE, height: TRANSCODE_TARGET_MAX_EDGE, fit: 'inside', withoutEnlargement: true });
  let last: Buffer | undefined;
  for (const quality of TRANSCODE_JPEG_QUALITY_LADDER) {
    last = await base.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
    if (last.length <= TRANSCODE_TARGET_MAX_BYTES) return last;
  }
  return last as Buffer;
}

async function transcodeImage(bytes: Buffer, transcodedFrom: string): Promise<TranscodeResult> {
  const pipeline = sharp(bytes, { limitInputPixels: SHARP_MAX_INPUT_PIXELS });
  await pipeline.metadata(); // throws on a non-image / over-limit input
  return { bytes: await encodeJpeg(pipeline), contentType: 'image/jpeg', transcodedFrom };
}

async function transcodePdf(bytes: Buffer): Promise<TranscodeResult> {
  const lib = await getPdfium();
  const doc = await lib.loadDocument(bytes); // throws on a corrupt pdf
  try {
    const pdfPageCount = doc.getPageCount();
    const page = doc.getPage(0);
    // Render page 1 near the target edge; clamp the scale to [1, 3].
    const size = page.getSize?.() ?? { width: 612, height: 792 };
    const longest = Math.max(size.width ?? 612, size.height ?? 792);
    const scale = Math.min(3, Math.max(1, TRANSCODE_TARGET_MAX_EDGE / longest));
    const r = await page.render({ scale, render: 'bitmap' });
    const pipeline = sharp(Buffer.from(r.data), { raw: { width: r.width, height: r.height, channels: 4 }, limitInputPixels: SHARP_MAX_INPUT_PIXELS });
    return { bytes: await encodeJpeg(pipeline), contentType: 'image/jpeg', pdfPageCount, transcodedFrom: 'application/pdf' };
  } finally {
    doc.destroy();
  }
}

/** Convert an uploaded source to a Twilio-deliverable JPEG. Caller decides WHICH
 *  sources reach here (planMmsMedia); this handles image vs pdf by content-type. */
export async function transcodeForMms(bytes: Buffer, sourceType: string): Promise<TranscodeResult> {
  const t = sourceType.trim().toLowerCase();
  if (t === 'application/pdf') return transcodePdf(bytes);
  return transcodeImage(bytes, t);
}
```

Note: if `page.getSize` is unavailable in the installed pdfium version, the `?? { width: 612, height: 792 }` fallback keeps a sane Letter-sized scale; the sharp resize caps the edge regardless.

- [x] **Step 4: Run tests + typecheck**

Run: `cd app && npx vitest run test/mediaTranscode.test.ts && cd .. && npm run typecheck`
Expected: PASS (6 tests); typecheck clean.

- [x] **Step 5: Commit**

```bash
git add app/src/adapters/mediaTranscode.ts app/test/mediaTranscode.test.ts
git commit -m "feat(mms): mediaTranscode adapter (sharp images + pdfium pdf page 1 -> jpeg)"
```

---

### Task 6: MediaAttachment.originalKey + renditionFor seam

**Files:**
- Modify: `app/src/repos/messagesRepo.ts` (`MediaAttachment` interface)
- Create: `app/src/lib/mmsRenditions.ts`
- Test: `app/test/mmsRenditions.test.ts`

**Interfaces:**
- Produces:
  - `MediaAttachment` gains `originalKey?: string` (the pristine asset; `s3Key` is the deliverable MMS rendition).
  - `renditionFor(channel: 'mms', attachment: MediaAttachment): { s3Key: string }`.

- [x] **Step 1: Add `originalKey?` to `MediaAttachment`**

In `app/src/repos/messagesRepo.ts`, extend the interface (around line 225):
```typescript
export interface MediaAttachment {
  s3Key: string;
  contentType: string;
  /**
   * The pristine uploaded original (RCS-forward, spec Sec 5). `s3Key` is the
   * MMS-deliverable rendition actually sent; `originalKey` is the full-fidelity
   * asset a future RCS channel can send instead. Absent on inbound-mirrored and
   * legacy attachments (they carry only the delivered key).
   */
  originalKey?: string;
}
```

- [x] **Step 2: Write the failing renditionFor test**

```typescript
// app/test/mmsRenditions.test.ts
import { describe, it, expect } from 'vitest';
import { renditionFor } from '../src/lib/mmsRenditions.js';

describe('renditionFor', () => {
  it('mms returns the delivered rendition key (s3Key)', () => {
    expect(renditionFor('mms', { s3Key: 'uploads/deliv', contentType: 'image/jpeg', originalKey: 'uploads/orig' }))
      .toEqual({ s3Key: 'uploads/deliv' });
  });
  it('mms works when there is no separate original (flow-through)', () => {
    expect(renditionFor('mms', { s3Key: 'uploads/gif', contentType: 'image/gif' }))
      .toEqual({ s3Key: 'uploads/gif' });
  });
});
```

- [x] **Step 3: Run it (fails)**

Run: `cd app && npx vitest run test/mmsRenditions.test.ts`
Expected: FAIL.

- [x] **Step 4: Implement `app/src/lib/mmsRenditions.ts`**

```typescript
// renditionFor -- the seam that picks which stored key to send for a channel
// (spec Sec 5, RCS-forward). Today the only channel is 'mms', which sends the
// deliverable rendition (s3Key). When RCS ships it adds a branch here that returns
// the originalKey (or an rcs rendition) -- an additive change, not a rewrite.
import type { MediaAttachment } from '../repos/messagesRepo.js';

export type SendChannel = 'mms';

export function renditionFor(channel: SendChannel, attachment: MediaAttachment): { s3Key: string } {
  switch (channel) {
    case 'mms':
      return { s3Key: attachment.s3Key };
    default: {
      const exhaustive: never = channel;
      return exhaustive;
    }
  }
}
```

- [x] **Step 5: Run tests + typecheck**

Run: `cd app && npx vitest run test/mmsRenditions.test.ts && cd .. && npm run typecheck`
Expected: PASS; typecheck clean.

- [x] **Step 6: Commit**

```bash
git add app/src/repos/messagesRepo.ts app/src/lib/mmsRenditions.ts app/test/mmsRenditions.test.ts
git commit -m "feat(mms): originalKey on MediaAttachment + renditionFor channel seam (RCS-forward)"
```

---

### Task 7: mmsMedia router -- presign + confirm

**Files:**
- Create: `app/src/routes/mmsMedia.ts`
- Test: `app/test/mmsMedia.test.ts`

**Interfaces:**
- Consumes: `MediaStore` (`createPresignedPost`, `head`, `getBytes`, `put`), `planMmsMedia`, `transcodeForMms`, `createSemaphore`, constants.
- Produces: an Express `Router` with:
  - `POST /presign` body `{ contentType: string }` -> `{ key: string, post: { url, fields } }` (mints one grant for `uploads/<uuid>`).
  - `POST /confirm` body `{ key: string }` -> `{ attachment: { s3Key, contentType, size, originalKey?, transcodedFrom?, pdfPageCount? } }`.
- Factory: `createMmsMediaRouter(deps?: { config?; logger?; mediaStore? }): Router`.

- [x] **Step 1: Write the failing route tests (fake MediaStore)**

```typescript
// app/test/mmsMedia.test.ts
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import sharp from 'sharp';
import { createMmsMediaRouter } from '../src/routes/mmsMedia.js';
import type { MediaStore } from '../src/adapters/mediaStore.js';

function harness(store: Partial<MediaStore>) {
  const app = express();
  app.use(express.json());
  app.use('/api/media', createMmsMediaRouter({ mediaStore: store as MediaStore }));
  return app;
}

describe('POST /api/media/presign', () => {
  it('mints a grant for an uploadable type', async () => {
    const store = { createPresignedPost: vi.fn().mockResolvedValue({ url: 'http://s3/local', fields: { key: 'uploads/x' } }) };
    const res = await request(harness(store)).post('/api/media/presign').send({ contentType: 'image/webp' });
    expect(res.status).toBe(200);
    expect(res.body.key).toMatch(/^uploads\/[0-9a-f-]+$/);
    expect(res.body.post.url).toBe('http://s3/local');
  });
  it('rejects a non-uploadable type', async () => {
    const res = await request(harness({})).post('/api/media/presign').send({ contentType: 'image/svg+xml' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_media_type');
  });
});

describe('POST /api/media/confirm', () => {
  it('flows a small png through untouched (no download, no rewrite)', async () => {
    const put = vi.fn();
    const store = {
      head: vi.fn().mockResolvedValue({ contentType: 'image/png', size: 5000 }),
      getBytes: vi.fn(),
      put,
    };
    const res = await request(harness(store)).post('/api/media/confirm').send({ key: 'uploads/aaaaaaaa-0000-0000-0000-000000000000' });
    expect(res.status).toBe(200);
    expect(res.body.attachment).toMatchObject({ s3Key: 'uploads/aaaaaaaa-0000-0000-0000-000000000000', contentType: 'image/png' });
    expect(res.body.attachment.originalKey).toBe('uploads/aaaaaaaa-0000-0000-0000-000000000000');
    expect(store.getBytes).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('transcodes a webp: downloads, puts a jpeg derivative, keeps the original', async () => {
    const webp = await sharp({ create: { width: 100, height: 80, channels: 3, background: { r: 5, g: 5, b: 5 } } }).webp().toBuffer();
    const put = vi.fn().mockResolvedValue(undefined);
    const store = {
      head: vi.fn().mockResolvedValue({ contentType: 'image/webp', size: webp.length }),
      getBytes: vi.fn().mockResolvedValue(webp),
      put,
    };
    const res = await request(harness(store)).post('/api/media/confirm').send({ key: 'uploads/bbbbbbbb-0000-0000-0000-000000000000' });
    expect(res.status).toBe(200);
    expect(res.body.attachment.contentType).toBe('image/jpeg');
    expect(res.body.attachment.originalKey).toBe('uploads/bbbbbbbb-0000-0000-0000-000000000000');
    expect(res.body.attachment.s3Key).toMatch(/^uploads\/[0-9a-f-]+$/);
    expect(res.body.attachment.s3Key).not.toBe('uploads/bbbbbbbb-0000-0000-0000-000000000000');
    expect(res.body.attachment.transcodedFrom).toBe('image/webp');
    expect(put).toHaveBeenCalledTimes(1); // derivative only; original already in S3
  });

  it('rejects a foreign key (not own uploads/ prefix)', async () => {
    const res = await request(harness({})).post('/api/media/confirm').send({ key: 'unit-media/u/x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_attachment_key');
  });

  it('404s an absent object', async () => {
    const store = { head: vi.fn().mockResolvedValue(undefined) };
    const res = await request(harness(store)).post('/api/media/confirm').send({ key: 'uploads/cccccccc-0000-0000-0000-000000000000' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown_attachment');
  });

  it('400 transcode_failed with detail on a corrupt file', async () => {
    const store = {
      head: vi.fn().mockResolvedValue({ contentType: 'image/webp', size: 12 }),
      getBytes: vi.fn().mockResolvedValue(Buffer.from('not an image')),
      put: vi.fn(),
    };
    const res = await request(harness(store)).post('/api/media/confirm').send({ key: 'uploads/dddddddd-0000-0000-0000-000000000000' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('transcode_failed');
    expect(typeof res.body.detail).toBe('string');
  });
});
```

Note: `supertest` -- if not already an app devDependency, install it: `npm install --workspace app --save-dev supertest @types/supertest`. Check `app/package.json` first; many suites here use it.

- [x] **Step 2: Run it (fails: module missing)**

Run: `cd app && npx vitest run test/mmsMedia.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement `app/src/routes/mmsMedia.ts`**

```typescript
// Outbound MMS media: direct-to-S3 presign + confirm-transcode (spec 2026-07-16).
// Replaces the busboy through-EC2 /uploads endpoint. Presign mints a grant so the
// BROWSER uploads the original straight to S3 (EC2 byte-free). Confirm decides on
// HeadObject alone whether to flow the original through (gif / small jpeg-png) or
// download + transcode (webp / oversized jpeg-png / pdf) into a deliverable JPEG,
// bounded by a process-wide semaphore. The original is always retained.
//
// PII (doc Sec 9): log s3Key + byte counts + transcodedFrom only; never filenames
// or bytes; presigned URLs are bearer tokens (never logged).
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { isInlineMediaType, planMmsMedia } from '../lib/mediaTypes.js';
import {
  MMS_UPLOAD_SOURCE_MAX_BYTES,
  MMS_TRANSCODE_MAX_CONCURRENT,
  MMS_TRANSCODE_WAIT_TIMEOUT_MS,
  OUTBOUND_MMS_MAX_FILE_BYTES,
} from '../lib/outboundMediaLimits.js';
import { createMediaStore, type MediaStore } from '../adapters/mediaStore.js';
import { transcodeForMms } from '../adapters/mediaTranscode.js';
import { createSemaphore } from '../lib/semaphore.js';

const UPLOAD_KEY_RE = /^uploads\/[0-9a-f-]+$/;

export interface MmsMediaRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  mediaStore?: MediaStore;
}

export function createMmsMediaRouter(deps: MmsMediaRouterDeps = {}): Router {
  const config = deps.config ?? loadConfig();
  const log = deps.logger ?? defaultLogger;
  const mediaStore = deps.mediaStore ?? createMediaStore({ config });
  const transcodeGate = createSemaphore(MMS_TRANSCODE_MAX_CONCURRENT);

  const router = Router();

  // POST /api/media/presign { contentType } -> { key, post }
  router.post('/presign', async (req, res) => {
    if (!mediaStore) {
      res.status(503).json({ error: 'media_storage_unavailable' });
      return;
    }
    const body = (req.body ?? {}) as { contentType?: unknown };
    const contentType = typeof body.contentType === 'string' ? body.contentType.trim().toLowerCase() : '';
    if (!isInlineMediaType(contentType)) {
      res.status(400).json({ error: 'unsupported_media_type' });
      return;
    }
    const key = `uploads/${randomUUID()}`;
    const post = await mediaStore.createPresignedPost(key, {
      contentType,
      maxBytes: MMS_UPLOAD_SOURCE_MAX_BYTES,
    });
    log.info({ key, contentType }, 'mms media presign minted');
    res.json({ key, post });
  });

  // POST /api/media/confirm { key } -> { attachment }
  router.post('/confirm', async (req, res) => {
    if (!mediaStore) {
      res.status(503).json({ error: 'media_storage_unavailable' });
      return;
    }
    const body = (req.body ?? {}) as { key?: unknown };
    const key = typeof body.key === 'string' ? body.key : '';
    if (!UPLOAD_KEY_RE.test(key)) {
      res.status(400).json({ error: 'invalid_attachment_key' });
      return;
    }
    const meta = await mediaStore.head(key);
    if (!meta) {
      res.status(400).json({ error: 'unknown_attachment' });
      return;
    }
    const sourceType = (meta.contentType ?? '').trim().toLowerCase();
    const size = meta.size ?? 0;
    const plan = planMmsMedia(sourceType, size);

    if (plan === 'reject') {
      res.status(400).json({ error: 'unsupported_media_type' });
      return;
    }

    if (plan === 'deliver') {
      // gif / small jpeg-png: the original IS the deliverable rendition.
      res.json({ attachment: { s3Key: key, contentType: sourceType, size, originalKey: key } });
      return;
    }

    // transcode-image / transcode-pdf: bounded download + transcode + derivative put.
    let release: (() => void) | undefined;
    try {
      release = await transcodeGate.acquire(MMS_TRANSCODE_WAIT_TIMEOUT_MS);
    } catch {
      res.status(503).json({ error: 'transcode_busy' });
      return;
    }
    try {
      const bytes = await mediaStore.getBytes(key);
      if (!bytes) {
        res.status(400).json({ error: 'unknown_attachment' });
        return;
      }
      const result = await transcodeForMms(bytes, sourceType);
      if (result.bytes.length > OUTBOUND_MMS_MAX_FILE_BYTES) {
        res.status(400).json({ error: 'file_too_large_after_fit' });
        return;
      }
      const deliverableKey = `uploads/${randomUUID()}`;
      await mediaStore.put(deliverableKey, bufferToStream(result.bytes), result.contentType);
      log.info(
        { originalKey: key, deliverableKey, transcodedFrom: result.transcodedFrom, byteCount: result.bytes.length, pdfPageCount: result.pdfPageCount },
        'mms media transcoded',
      );
      res.json({
        attachment: {
          s3Key: deliverableKey,
          contentType: result.contentType,
          size: result.bytes.length,
          originalKey: key,
          transcodedFrom: result.transcodedFrom,
          ...(result.pdfPageCount !== undefined && { pdfPageCount: result.pdfPageCount }),
        },
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.error({ err, s3Key: key }, 'mms media transcode failed');
      res.status(400).json({ error: 'transcode_failed', detail });
    } finally {
      release();
    }
  });

  return router;
}

// MediaStore.put wants a Readable; wrap the finished transcode buffer.
import { Readable } from 'node:stream';
function bufferToStream(buf: Buffer): Readable {
  return Readable.from([buf]);
}
```

Note: `createPresignedPost` currently takes only `{ contentType }` with a hard-coded 5MB range. Task 8 widens it to accept an optional `maxBytes`. If you build this task first, temporarily call `createPresignedPost(key, { contentType })` and wire `maxBytes` in Task 8; otherwise do Task 8's signature change first. Move the `import { Readable }` to the top of the file per lint; shown inline only for locality.

- [x] **Step 4: Run tests**

Run: `cd app && npx vitest run test/mmsMedia.test.ts`
Expected: PASS (all cases).

- [x] **Step 5: Commit**

```bash
git add app/src/routes/mmsMedia.ts app/test/mmsMedia.test.ts
git commit -m "feat(mms): presign + confirm-transcode router (direct-to-S3, semaphore-bounded)"
```

---

### Task 8: Widen createPresignedPost to accept maxBytes

**Files:**
- Modify: `app/src/adapters/mediaStore.ts` (`createPresignedPost` signature + `PresignedPost` callers)
- Test: `app/test/mediaStore.presignPost.test.ts`

**Interfaces:**
- Changes: `createPresignedPost(key, opts: { contentType: string; maxBytes?: number }): Promise<PresignedPost>` -- `maxBytes` defaults to `OUTBOUND_MMS_MAX_FILE_BYTES` (preserves the unit-photo 5MB behavior when omitted).

- [x] **Step 1: Write the failing test**

```typescript
// app/test/mediaStore.presignPost.test.ts
import { describe, it, expect, vi } from 'vitest';
import { S3MediaStore } from '../src/adapters/mediaStore.js';
import { OUTBOUND_MMS_MAX_FILE_BYTES, MMS_UPLOAD_SOURCE_MAX_BYTES } from '../src/lib/outboundMediaLimits.js';

// createPresignedPost uses the module fn from @aws-sdk/s3-presigned-post; assert the
// content-length-range condition uses the requested max (default vs explicit).
vi.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: vi.fn(async (_client, params) => ({ url: 'u', fields: {}, _conditions: params.Conditions })),
}));

describe('createPresignedPost maxBytes', () => {
  it('defaults to the 5MB per-file cap when omitted', async () => {
    const store = new S3MediaStore('b', {} as never);
    const post = await store.createPresignedPost('k', { contentType: 'image/jpeg' }) as unknown as { _conditions: unknown[] };
    expect(post._conditions).toContainEqual(['content-length-range', 1, OUTBOUND_MMS_MAX_FILE_BYTES]);
  });
  it('honors an explicit larger maxBytes (MMS source cap)', async () => {
    const store = new S3MediaStore('b', {} as never);
    const post = await store.createPresignedPost('k', { contentType: 'image/webp', maxBytes: MMS_UPLOAD_SOURCE_MAX_BYTES }) as unknown as { _conditions: unknown[] };
    expect(post._conditions).toContainEqual(['content-length-range', 1, MMS_UPLOAD_SOURCE_MAX_BYTES]);
  });
});
```

- [x] **Step 2: Run it (fails: maxBytes ignored)**

Run: `cd app && npx vitest run test/mediaStore.presignPost.test.ts`
Expected: FAIL.

- [x] **Step 3: Update `createPresignedPost` in `app/src/adapters/mediaStore.ts`**

Replace the method body's `Conditions` line and signature:
```typescript
  async createPresignedPost(
    key: string,
    opts: { contentType: string; maxBytes?: number },
  ): Promise<PresignedPost> {
    const maxBytes = opts.maxBytes ?? OUTBOUND_MMS_MAX_FILE_BYTES;
    const { url, fields } = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [['content-length-range', 1, maxBytes]],
      Fields: { 'Content-Type': opts.contentType },
      Expires: UNIT_PHOTO_PRESIGN_POST_TTL_SECONDS,
    });
    return { url, fields };
  }
```
Update the `MediaStore` interface method signature to match (`opts: { contentType: string; maxBytes?: number }`). Ensure `OUTBOUND_MMS_MAX_FILE_BYTES` is imported (it already is).

- [x] **Step 4: Run the new test + the existing mediaStore tests + typecheck**

Run: `cd app && npx vitest run test/mediaStore.presignPost.test.ts test/mediaStore.test.ts && cd .. && npm run typecheck`
Expected: PASS; unit-photo presign callers still compile (maxBytes optional).

- [x] **Step 5: Commit**

```bash
git add app/src/adapters/mediaStore.ts app/test/mediaStore.presignPost.test.ts
git commit -m "feat(media): createPresignedPost accepts maxBytes (MMS 20MB source cap; default 5MB)"
```

---

### Task 9: Send route -- deliverable-type guard + originalKey passthrough + renditionFor

**Files:**
- Modify: `app/src/routes/api.ts` (`resolveAttachmentKeys`, the send handler, router mount)
- Test: `app/test/mmsSendGuard.test.ts` (or extend an existing send-route test)

**Interfaces:**
- Consumes: `isTwilioDeliverableType`, `renditionFor`, `MediaAttachment.originalKey`.
- Changes:
  - `resolveAttachmentKeys` rejects any key whose stored Content-Type is not `isTwilioDeliverableType` (returns `{ ok:false, status:400, error:'unsupported_attachment_type' }`).
  - The send handler accepts an optional `attachmentOriginalKeys?: string[]` (index-aligned to `attachmentKeys`) and sets `originalKey` on each resolved `MediaAttachment`.
  - Presign loop uses `renditionFor('mms', a).s3Key` instead of `a.s3Key` directly.
  - Mount `createMmsMediaRouter` at `/media` (replacing `createMediaUploadsRouter`).

- [x] **Step 1: Write the failing guard test**

```typescript
// app/test/mmsSendGuard.test.ts
import { describe, it, expect, vi } from 'vitest';
import { resolveAttachmentKeys } from '../src/routes/api.js'; // export it (see Step 3)
import type { MediaStore } from '../src/adapters/mediaStore.js';

function store(byKey: Record<string, { contentType: string; size: number }>): MediaStore {
  return { head: vi.fn(async (k: string) => byKey[k]) } as unknown as MediaStore;
}

describe('resolveAttachmentKeys deliverable guard', () => {
  it('rejects a non-deliverable stored type (webp reaching send)', async () => {
    const s = store({ 'uploads/aaaaaaaa-0000-0000-0000-000000000000': { contentType: 'image/webp', size: 100 } });
    const out = await resolveAttachmentKeys(['uploads/aaaaaaaa-0000-0000-0000-000000000000'], undefined, s);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('unsupported_attachment_type');
  });
  it('accepts a jpeg and carries originalKey', async () => {
    const s = store({ 'uploads/bbbbbbbb-0000-0000-0000-000000000000': { contentType: 'image/jpeg', size: 100 } });
    const out = await resolveAttachmentKeys(
      ['uploads/bbbbbbbb-0000-0000-0000-000000000000'],
      ['uploads/orig-0000-0000-0000-000000000000'],
      s,
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.attachments[0]).toMatchObject({ s3Key: 'uploads/bbbbbbbb-0000-0000-0000-000000000000', contentType: 'image/jpeg', originalKey: 'uploads/orig-0000-0000-0000-000000000000' });
  });
});
```

- [x] **Step 2: Run it (fails: not exported / signature differs)**

Run: `cd app && npx vitest run test/mmsSendGuard.test.ts`
Expected: FAIL.

- [x] **Step 3: Refactor `resolveAttachmentKeys` in `app/src/routes/api.ts`**

Extract it to a module-level exported function (currently an inner closure) taking the store + optional originalKeys, and swap the content-type check. Replace the inner function with:
```typescript
export async function resolveAttachmentKeys(
  keys: string[],
  originalKeys: string[] | undefined,
  mediaStore: MediaStore | undefined,
): Promise<{ ok: true; attachments: MediaAttachment[] } | { ok: false; status: number; error: string }> {
  if (keys.length > OUTBOUND_MMS_MAX_MEDIA) {
    return { ok: false, status: 400, error: 'too_many_attachments' };
  }
  if (!keys.every((k) => UPLOAD_KEY_PATTERN.test(k))) {
    return { ok: false, status: 400, error: 'invalid_attachment_key' };
  }
  if (!mediaStore) {
    return { ok: false, status: 503, error: 'media_storage_unavailable' };
  }
  const attachments: MediaAttachment[] = [];
  let totalBytes = 0;
  for (let i = 0; i < keys.length; i++) {
    const s3Key = keys[i]!;
    const meta = await mediaStore.head(s3Key);
    if (!meta) {
      return { ok: false, status: 400, error: 'unknown_attachment' };
    }
    const contentType = (meta.contentType ?? '').trim().toLowerCase();
    // Deliverable-type guard: only jpeg/png/gif may reach Twilio (12300 fix).
    if (!isTwilioDeliverableType(contentType)) {
      return { ok: false, status: 400, error: 'unsupported_attachment_type' };
    }
    totalBytes += meta.size ?? 0;
    const originalKey = originalKeys?.[i];
    attachments.push({ s3Key, contentType, ...(originalKey !== undefined && { originalKey }) });
  }
  if (totalBytes > OUTBOUND_MMS_MAX_TOTAL_BYTES) {
    return { ok: false, status: 400, error: 'attachments_too_large' };
  }
  return { ok: true, attachments };
}
```
Add the import `import { isTwilioDeliverableType, ... } from '../lib/mediaTypes.js';` (extend the existing mediaTypes import) and `import { renditionFor } from '../lib/mmsRenditions.js';`. In the send handler, parse `attachmentOriginalKeys` the same way `attachmentKeys` is parsed, and call `resolveAttachmentKeys(attachmentKeys, attachmentOriginalKeys, mediaStore)`.

- [x] **Step 4: Route the presign loop through renditionFor**

In the 1:1 send branch, change the presign map (api.ts ~798) to:
```typescript
      const presigned = await Promise.all(
        attachments.map((a) => mediaStore.presign(renditionFor('mms', a).s3Key, PRESIGN_TTL_SECONDS)),
      );
```

- [x] **Step 5: Swap the router mount**

At api.ts ~343, replace `createMediaUploadsRouter(...)` with `createMmsMediaRouter({ logger: deps.logger, ...(mediaStore configured as before) })` and update the import at the top (`import { createMmsMediaRouter } from './mmsMedia.js';`, remove the `createMediaUploadsRouter` import).

- [x] **Step 6: Run the guard test + typecheck + the api route suite**

Run: `cd app && npx vitest run test/mmsSendGuard.test.ts test/apiRoutes.test.ts && cd .. && npm run typecheck`
Expected: PASS. If `apiRoutes.test.ts` asserted the old `/media/uploads` busboy behavior, update those assertions to the presign/confirm shape (or move them to `mmsMedia.test.ts`).

- [x] **Step 7: Commit**

```bash
git add app/src/routes/api.ts app/test/mmsSendGuard.test.ts
git commit -m "feat(mms): send-route deliverable-type guard + originalKey passthrough + renditionFor"
```

---

### Task 10: Remove the busboy upload endpoint

**Files:**
- Delete: `app/src/routes/mediaUploads.ts`, `app/test/mediaUploads.test.ts`
- Verify: no remaining importers.

- [x] **Step 1: Confirm nothing else imports it**

Run: `cd .. && grep -rn "mediaUploads\|/media/uploads\|createMediaUploadsRouter" app/src e2e --include=*.ts | grep -v "mmsMedia"`
Expected: no matches (Task 9 already swapped the mount). If any remain, update them to presign/confirm.

- [x] **Step 2: Delete the files**

```bash
git rm app/src/routes/mediaUploads.ts app/test/mediaUploads.test.ts
```

- [x] **Step 3: Typecheck + full app suite**

Run: `npm run typecheck && npm test --workspace app`
Expected: green (0 tsc errors; app suite passes).

- [x] **Step 4: Commit**

```bash
git commit -m "refactor(mms): remove busboy /media/uploads endpoint (superseded by presign/confirm)"
```

---

### Task 11: Dashboard API client -- presign + confirm

**Files:**
- Modify: `dashboard/src/api/types.ts` (add `MmsMediaAttachment`; drop/retire `UploadMediaResult` usage)
- Modify: `dashboard/src/api/endpoints.ts` (add `presignMmsMedia`, `confirmMmsMedia`; retire `uploadMedia`)
- Test: `dashboard/src/api/mmsMedia.client.test.ts`

**Interfaces:**
- Produces:
  - `interface MmsMediaAttachment { s3Key: string; contentType: string; size: number; originalKey?: string; transcodedFrom?: string; pdfPageCount?: number }`
  - `presignMmsMedia(contentType: string): Promise<{ key: string; post: { url: string; fields: Record<string,string> } }>`
  - `confirmMmsMedia(key: string): Promise<MmsMediaAttachment>`
  - reuse existing `uploadToPresignedPost(post, file)`.

- [x] **Step 1: Write the failing client test**

```typescript
// dashboard/src/api/mmsMedia.client.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { presignMmsMedia, confirmMmsMedia } from './endpoints.js';

const okJson = (body: unknown) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body }) as unknown as Response;

afterEach(() => vi.restoreAllMocks());

describe('mms media client', () => {
  it('presignMmsMedia posts contentType and returns key + post', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ key: 'uploads/x', post: { url: 'u', fields: {} } }));
    const out = await presignMmsMedia('image/webp');
    expect(out.key).toBe('uploads/x');
    expect(fetchMock).toHaveBeenCalledWith('/api/media/presign', expect.objectContaining({ method: 'POST' }));
  });
  it('confirmMmsMedia returns the attachment', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ attachment: { s3Key: 'uploads/d', contentType: 'image/jpeg', size: 10, originalKey: 'uploads/o', pdfPageCount: 3 } }));
    const out = await confirmMmsMedia('uploads/o');
    expect(out).toMatchObject({ s3Key: 'uploads/d', contentType: 'image/jpeg', originalKey: 'uploads/o', pdfPageCount: 3 });
  });
});
```

Note: match the exact `request()` helper convention in `endpoints.ts` (it wraps `{ method, body }` and unwraps JSON). Adjust the mock if `request()` sets extra headers; mirror `confirmUnitPhotos` which uses `request(...)`.

- [x] **Step 2: Run it (fails)**

Run: `cd dashboard && npx vitest run src/api/mmsMedia.client.test.ts`
Expected: FAIL.

- [x] **Step 3: Add types + client fns**

In `dashboard/src/api/types.ts`:
```typescript
/** One outbound MMS attachment after presign+confirm (server transcoded/validated). */
export interface MmsMediaAttachment {
  s3Key: string;        // the deliverable rendition (jpeg/png/gif) the send route receives
  contentType: string;
  size: number;
  originalKey?: string; // pristine upload (RCS-forward)
  transcodedFrom?: string;
  pdfPageCount?: number;
}
```
In `dashboard/src/api/endpoints.ts` (near `presignUnitPhotos`/`confirmUnitPhotos`):
```typescript
/** POST /api/media/presign { contentType } - mint a direct-to-S3 grant for one MMS
 *  attachment. The browser then uploadToPresignedPost()s the file, then confirms. */
export async function presignMmsMedia(
  contentType: string,
): Promise<{ key: string; post: { url: string; fields: Record<string, string> } }> {
  return request<{ key: string; post: { url: string; fields: Record<string, string> } }>(
    '/api/media/presign',
    { method: 'POST', body: { contentType } },
  );
}

/** POST /api/media/confirm { key } - server validates/transcodes the uploaded
 *  original and returns the deliverable MMS attachment (jpeg for webp/pdf/oversized;
 *  the original for gif/small jpeg-png). Throws ApiError (400 transcode_failed with
 *  a `detail`, unknown_attachment, file_too_large_after_fit; 503 transcode_busy). */
export async function confirmMmsMedia(key: string): Promise<MmsMediaAttachment> {
  const res = await request<{ attachment: MmsMediaAttachment }>(
    '/api/media/confirm',
    { method: 'POST', body: { key } },
  );
  return res.attachment;
}
```
Remove `uploadMedia` and `UploadMediaResult` (retire the busboy client). If `request()` does not surface the server's `detail` field into `ApiError`, extend the shared `request()`/`ApiError` construction to carry `detail` (mirror the raw-fetch `detail` handling already in `uploadMedia`), so the composer can show it.

- [x] **Step 4: Run tests + typecheck**

Run: `cd dashboard && npx vitest run src/api/mmsMedia.client.test.ts && cd .. && npm run typecheck`
Expected: PASS; typecheck clean (fix any now-dangling `uploadMedia` importers -- Task 12 covers the composer).

- [x] **Step 5: Commit**

```bash
git add dashboard/src/api/types.ts dashboard/src/api/endpoints.ts dashboard/src/api/mmsMedia.client.test.ts
git commit -m "feat(mms): dashboard presignMmsMedia + confirmMmsMedia client (retire uploadMedia)"
```

---

### Task 12: Composer upload flow + PDF warning + error detail

**Files:**
- Modify: `dashboard/src/routes/contact/Timeline.tsx` (`ComposerAttachment`, `uploadOne`, chip render)
- Test: `dashboard/src/routes/contact/Timeline.mms.test.tsx` (extend the existing MMS composer test)

**Interfaces:**
- Consumes: `presignMmsMedia`, `uploadToPresignedPost`, `confirmMmsMedia`, `MmsMediaAttachment`.
- Changes: `ComposerAttachment` gains `originalKey?`, `pdfPageCount?`; `uploadOne` runs presign -> S3 POST -> confirm; the chip shows a "page 1 only" note when `pdfPageCount > 1` and the error detail on failure; the send passes `attachmentKeys` (rendition keys) + `attachmentOriginalKeys`.

- [x] **Step 1: Write/extend the failing composer test**

```typescript
// dashboard/src/routes/contact/Timeline.mms.test.tsx  (add cases)
import { describe, it, expect, vi } from 'vitest';
// Mock the three client fns:
vi.mock('../../api/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/index.js')>();
  return { ...actual, presignMmsMedia: vi.fn(), uploadToPresignedPost: vi.fn(), confirmMmsMedia: vi.fn() };
});
import { presignMmsMedia, uploadToPresignedPost, confirmMmsMedia } from '../../api/index.js';
// ... existing render helpers ...

it('multi-page pdf shows the page-1-only note and stays sendable', async () => {
  vi.mocked(presignMmsMedia).mockResolvedValue({ key: 'uploads/o', post: { url: 'u', fields: {} } });
  vi.mocked(uploadToPresignedPost).mockResolvedValue();
  vi.mocked(confirmMmsMedia).mockResolvedValue({ s3Key: 'uploads/d', contentType: 'image/jpeg', size: 10, originalKey: 'uploads/o', pdfPageCount: 3 });
  // ... pick a pdf file via the file input, await the chip ...
  // expect(screen.getByText(/only the first page/i)).toBeInTheDocument();
  // expect(send button enabled)
});

it('shows the transcode_failed detail on the chip', async () => {
  vi.mocked(presignMmsMedia).mockResolvedValue({ key: 'uploads/o', post: { url: 'u', fields: {} } });
  vi.mocked(uploadToPresignedPost).mockResolvedValue();
  vi.mocked(confirmMmsMedia).mockRejectedValue(Object.assign(new Error('x'), { code: 'transcode_failed', detail: 'Input buffer contains unsupported image format' }));
  // ... pick a file ...
  // expect(screen.getByText(/Couldn't process this file: Input buffer/i)).toBeInTheDocument();
});
```
Adapt selectors to the existing Timeline.mms.test.tsx helpers (file input, chip query). Keep the existing passing cases.

- [x] **Step 2: Run it (fails)**

Run: `cd dashboard && npx vitest run src/routes/contact/Timeline.mms.test.tsx`
Expected: FAIL on the new cases.

- [x] **Step 3: Update `ComposerAttachment` + `uploadOne`**

Extend the interface (Timeline.tsx ~82):
```typescript
interface ComposerAttachment {
  localId: string;
  name: string;
  size: number;
  contentType: string;
  status: 'uploading' | 'done' | 'error';
  error?: string;
  previewUrl?: string;
  key?: string;          // deliverable rendition key sent to the server
  originalKey?: string;  // pristine original (RCS-forward)
  pdfPageCount?: number; // set when a pdf was rasterized
}
```
Replace `uploadOne` (Timeline.tsx ~591) with the presign/confirm flow:
```typescript
  const uploadOne = async (localId: string, file: File): Promise<void> => {
    try {
      const { key, post } = await presignMmsMedia(file.type);
      await uploadToPresignedPost(post, file);
      const att = await confirmMmsMedia(key);
      setAttachments((prev) =>
        prev.map((a) =>
          a.localId === localId
            ? {
                ...a,
                status: 'done',
                key: att.s3Key,
                contentType: att.contentType,
                size: att.size,
                ...(att.originalKey !== undefined && { originalKey: att.originalKey }),
                ...(att.pdfPageCount !== undefined && { pdfPageCount: att.pdfPageCount }),
              }
            : a,
        ),
      );
    } catch (err) {
      setAttachments((prev) =>
        prev.map((a) =>
          a.localId === localId ? { ...a, status: 'error', error: uploadFailureMessage(err) } : a,
        ),
      );
    }
  };
```
Ensure `uploadFailureMessage` surfaces the `detail` for `transcode_failed` (return `Couldn't process this file: ${detail}` when `err.code === 'transcode_failed'` and `err.detail` is present).

- [x] **Step 4: Render the page-1 note + pass both key arrays on send**

In the chip render, when `a.status === 'done' && (a.pdfPageCount ?? 0) > 1`, show a small note: `PDF - only the first page will be sent as an image.` In the send call (`onSend`/wherever `attachmentKeys` is assembled), build:
```typescript
    const done = attachments.filter((a) => a.status === 'done' && a.key !== undefined);
    const attachmentKeys = done.map((a) => a.key!);
    const attachmentOriginalKeys = done.map((a) => a.originalKey ?? a.key!);
```
and include `attachmentOriginalKeys` in the POST body (the api client `sendMessage`/`postMessage` call gains the optional field; thread it through the same way `attachmentKeys` is threaded).

- [x] **Step 5: Run tests + typecheck**

Run: `cd dashboard && npx vitest run src/routes/contact/Timeline.mms.test.tsx && cd .. && npm run typecheck`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/Timeline.mms.test.tsx dashboard/src/api
git commit -m "feat(mms): composer presign/confirm upload + page-1 pdf note + transcode error detail"
```

---

### Task 13: e2e -- the real 12300 path, proven green

**Files:**
- Create: `e2e/tests/mms-transcode.spec.ts`
- Reference: `e2e/support/selectors.md`, the existing MMS/no-multipart e2e assertions.

**Interfaces:**
- Consumes: the hermetic stack (`npm run e2e`), `POST /auth/dev-login`, `GET /__dev/outbox`.

- [x] **Step 1: Write the e2e spec**

```typescript
// e2e/tests/mms-transcode.spec.ts
import { test, expect } from '@playwright/test';
import { devLogin, openConversationComposer, attachFile, sendAndGetOutbox } from '../support/steps.js';
// Use/extend the shared steps vocabulary; if a helper is missing, add it in support/steps.ts.

test('webp attachment is sent to Twilio as image/jpeg (no 12300), bytes never hit the app', async ({ page, request }) => {
  await devLogin(page);
  await openConversationComposer(page);
  const netMultipart: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && (r.headers()['content-type'] ?? '').startsWith('multipart/form-data') && r.url().includes('/api/')) {
      netMultipart.push(r.url());
    }
  });
  await attachFile(page, 'fixtures/red.webp');       // add a small real webp fixture
  const outbox = await sendAndGetOutbox(page, request, 'here is a photo');
  const media = outbox.at(-1)?.media ?? [];
  expect(media.length).toBe(1);
  expect(media[0].contentType).toBe('image/jpeg');   // webp was transcoded
  expect(netMultipart).toEqual([]);                  // direct-to-S3; no multipart to the app
});

test('small png flows through unchanged; multi-page pdf warns and sends one jpeg', async ({ page, request }) => {
  await devLogin(page);
  await openConversationComposer(page);
  await attachFile(page, 'fixtures/small.png');
  await expect(page.getByText(/only the first page/i)).toHaveCount(0);
  await attachFile(page, 'fixtures/three-page.pdf');
  await expect(page.getByText(/only the first page/i)).toBeVisible();
  const outbox = await sendAndGetOutbox(page, request, 'docs');
  const media = outbox.at(-1)?.media ?? [];
  expect(media.map((m) => m.contentType).sort()).toEqual(['image/jpeg', 'image/png']); // png passthrough + pdf->jpeg
});
```
Create the fixtures: a small real `.webp`, a small `.png` (< 1MB), a 3-page `.pdf` (generate with pdf-lib in a one-off script or check them in under `e2e/fixtures/`). Align the outbox media shape with what `GET /__dev/outbox` returns (extend the mock/outbox to expose per-media contentType if it does not already).

- [x] **Step 2: Run the e2e suite (hermetic; from the e2e workspace)**

Run (from repo root; Docker required): `timeout 1500 npm run e2e`
Expected: the new spec passes; the existing suite stays green. NEVER run playwright from the repo root outside `npm run e2e` (it would hit the live :5174 stack).

- [x] **Step 3: Commit**

```bash
git add e2e/tests/mms-transcode.spec.ts e2e/fixtures e2e/support
git commit -m "test(e2e): webp->jpeg, png passthrough, multi-page pdf warning; no-multipart-to-app"
```

---

### Task 14: Full-gate green + RUNBOOK note

**Files:**
- Modify: `RUNBOOK.md` (operator note)

- [x] **Step 1: Sync main once (branch hygiene) and re-run all gates**

```bash
git fetch origin && git merge origin/main   # resolve conflicts keeping both intents
npm run typecheck
npm test
timeout 1500 npm run e2e
```
Expected: all green on the synced base. (Run e2e from the repo root via `npm run e2e` only.)

- [x] **Step 2: Add the RUNBOOK operator note**

Under the deploy/post-merge section, add: on merge, `npm install` is owed (new deps `sharp` + `@hyzyla/pdfium`); the `s3_media` CORS is already applied on dev and needs no new dev apply; prod CORS rides the unit-photos cutover apply. No new IAM/terraform for this feature.

- [x] **Step 3: Commit**

```bash
git add RUNBOOK.md
git commit -m "docs(runbook): MMS transcoding post-merge note (npm install owed; no new infra)"
```

---

## Self-Review Notes (author checks, already reconciled)

- **Spec coverage:** registry+plan (T2), transcode incl. spike gotchas (T5), presign/confirm direct-to-S3 (T7/T8), semaphore memory bound (T3/T7), auto-fit ladder (T5), flow-through (T2/T7), send guard (T9), originalKey+renditionFor RCS seam (T6/T9), dashboard flow + pdf warning + error detail (T11/T12), busboy removal (T10), deps+arm64 proof (T1), e2e 12300 path (T13), infra/runbook (T14). All spec sections map to a task.
- **originalKey wire path:** confirm returns `originalKey`; composer sends index-aligned `attachmentOriginalKeys`; `resolveAttachmentKeys` writes it onto `MediaAttachment`. `s3Key` is always the deliverable rendition; `renditionFor('mms')` returns it.
- **Type consistency:** `MmsMediaAttachment.s3Key` (dashboard) == server `attachment.s3Key` == `MediaAttachment.s3Key`. `planMmsMedia`/`MmsMediaPlan` names consistent across T2/T5/T7. `createPresignedPost(key,{contentType,maxBytes?})` consistent T7/T8.
- **Watch item for the builder:** confirm createPresignedPost `maxBytes` (T7) depends on T8's signature -- do T8 before wiring T7's `maxBytes`, or land them together. `supertest` and pdfium `page.getSize()` availability are noted inline with fallbacks.
