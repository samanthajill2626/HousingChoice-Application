# Unit Photos via CloudFront Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve unit photo GETs same-origin through CloudFront (S3+OAC origin, `/unit-media/*` behavior), replace presign-per-read with stable relative URLs, add a streaming app fallback route, best-effort-delete removed photos, return CSP img-src to `'self' data: blob:`, and wire live-mode local dev to the real dev media bucket.

**Architecture:** The dashboard/flyer render `<img src="/unit-media/<unitId>/<uuid>">`. In deployed envs CloudFront matches a new ordered behavior and serves the object straight from the private media bucket via Origin Access Control with 7-day caching; everywhere else (local MinIO, hermetic e2e, live-mode :5174) a new unauthenticated app route streams the object from the media store. Uploads are untouched (browser-to-S3 presigned POST; connect-src keeps the bucket origin).

**Tech Stack:** Express 4 app (TypeScript, Vitest), React dashboard, Terraform (AWS provider ~> 6.0), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-07-21-unit-media-cloudfront-design.md` (approved 2026-07-21). Read it first; decisions D1-D6 are binding.

## Global Constraints

- ASCII-only in every added line (specs, comments, tests, log strings): `tr -d '\11\12\15\40-\176' < FILE | wc -c` -> 0.
- NEVER rewrite source files with PowerShell Get-Content/-replace/Set-Content; use the Edit tool.
- Commit discipline: bare `git status` read before EVERY commit; stage explicit paths only; Co-Authored-By trailer naming the authoring model.
- NO terraform plan/apply, NO secrets:push, NO deploys (repo law). `terraform init -backend=false` + `terraform validate` + `terraform fmt -check` ARE allowed (no state/cloud access) and are this plan's only terraform verification.
- Gates: `npm run typecheck` AND `npm test` AND `timeout 1500 npm run e2e` (bare, from the worktree, real exit codes; never pipe).
- Domain copy: the entity is `unit` in code, "property" in landlord/staff copy, "home" in tenant copy.
- New user-facing automated copy only via the message catalog (none expected here).

## Invariant watch items (enumerated per the pipeline invariant rule)

The protected state is `unit.media` and the reachable object namespace `unit-media/*`.

MUTATION SURFACES of `unit.media` (all in `app/src/routes/units.ts` unless noted):
1. `POST /:unitId/photos/confirm` (~line 520) -> `unitsRepo.appendMedia` - APPEND only; never removes; NO delete hook needed.
2. `DELETE /:unitId/photos` (~line 657) -> `unitsRepo.removeMedia` - removes ONE entry; PRIMARY delete-on-removal site (Task 4). Its comment at ~652-653 documents the old accepted-orphan posture and MUST be updated.
3. `PUT /:unitId/photos/cover` (~line 694) -> `unitsRepo.makeCover` - REORDER, set unchanged; NO delete hook.
4. `PATCH /:unitId` (~line 1057) -> `unitsRepo.update` - the E5 raw seam; can wholesale REPLACE or null-out `media`; MUST diff prev-vs-next and delete removed stored keys (Task 4). NOTE: this route does NOT currently load prior state - Task 4 adds a getById.
5. `unitsRepo.create` - initial media on create; no removal; no hook.
6. Seeds write NO `unit.media` (verified 2026-07-21); no dev-seam writer exists.

READERS/RENDERERS of `unit.media` / consumers of its display URLs:
- `app/src/lib/unitMedia.ts` resolveUnitMedia (Task 2 rewrites it).
- `app/src/routes/units.ts` GET /:unitId (~418) + the mediaDisplay echoes at ~605, ~648, ~686, ~721 (Task 2 updates call sites).
- `app/src/routes/public.ts` ~213 resolvePublicMedia -> flyer.media (Task 2).
- `app/src/lib/unitFields.ts` toUnitFlyer (~246) - copies raw `media` list into the flyer projection; NO change (raw keys, not URLs).
- `app/src/repos/unitsRepo.ts` removeMedia/makeCover read-modify-write - NO change.
- Dashboard: `ListingDetail.tsx` ~776 `<img src={m.url}>`, `FlyerPage.tsx` ~223 `<img src>` - relative-safe, NO change expected (verify only).
- e2e `listing-photos.spec.ts` helper `srcKeyPath` uses `new URL(src, NEXT)` - relative-safe (Task 8 extends the spec).
- Tests that pin the OLD presigned shape and MUST be rewritten: `app/test/unitsApiPhotos.test.ts` (:188, :470-525 "presign-per-read" block), `app/test/publicIntake.test.ts` (:301-303, :592-595 asserts X-Amz-Signature), `app/test/staticSmoke.test.ts` (:135, :147 img-src bucket origin).

---

### Task 1: MediaStore.deleteObject

**Files:**
- Modify: `app/src/adapters/mediaStore.ts` (import line 8; interface ~line 88; S3MediaStore class after head())
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (~line 2323 fully-typed fake MediaStore - compile-breaks without this)
- Test: `app/test/mediaStore.deleteObject.test.ts` (new; or fold into an existing adapter test file if one covers S3MediaStore with an injected client)

**Interfaces:**
- Produces: `MediaStore.deleteObject(key: string): Promise<void>` - idempotent (S3 DeleteObject succeeds on absent keys); throws only on transport/access errors. Task 4 consumes it.
- The harness fake must implement it (remove from its object map) AND record deleted keys so Task 4's tests can assert deletions (add e.g. a `deletedMediaKeys: string[]` the fake pushes to; follow the harness's existing exposure pattern for observability arrays).

- [ ] **Step 1: Write the failing test** - with the adapter's existing injected-client seam (`CreateMediaStoreDeps.client`), assert `deleteObject('unit-media/u1/k1')` sends a `DeleteObjectCommand` with `{ Bucket: <bucket>, Key: 'unit-media/u1/k1' }` and resolves void; assert a client rejection propagates (caller handles WARN).

```ts
import { describe, expect, it, vi } from 'vitest';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createMediaStore } from '../src/adapters/mediaStore.js';

function harness(sendImpl: (cmd: unknown) => Promise<unknown>) {
  const send = vi.fn(sendImpl);
  const store = createMediaStore({
    config: { mediaBucket: 'test-bucket', awsRegion: 'us-east-1' } as never,
    client: { send } as never,
  });
  return { store: store!, send };
}

describe('MediaStore.deleteObject', () => {
  it('sends DeleteObjectCommand for the exact bucket/key and resolves', async () => {
    const { store, send } = harness(async () => ({}));
    await store.deleteObject('unit-media/u1/k1');
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0]![0] as DeleteObjectCommand;
    expect(cmd).toBeInstanceOf(DeleteObjectCommand);
    expect(cmd.input).toEqual({ Bucket: 'test-bucket', Key: 'unit-media/u1/k1' });
  });

  it('propagates transport errors to the caller', async () => {
    const { store } = harness(async () => { throw new Error('s3 down'); });
    await expect(store.deleteObject('unit-media/u1/k1')).rejects.toThrow('s3 down');
  });
});
```

(Adapt the `config as never` shim to however existing adapter tests build a minimal config - copy their pattern.)

- [ ] **Step 2: Run it to verify it fails** - `npm test --workspace app -- mediaStore.deleteObject` (or the repo's per-file invocation pattern). Expected: FAIL - deleteObject is not a function / not in interface.

- [ ] **Step 3: Implement** - in `app/src/adapters/mediaStore.ts`: add `DeleteObjectCommand` to the line-8 import; add to the `MediaStore` interface after `createPresignedPost`:

```ts
  /**
   * Best-effort object removal (unit-photo removal, design spec 2026-07-21
   * D1). S3 DeleteObject is idempotent - deleting an absent key succeeds -
   * so callers need no absent-object handling. Throws only on transport /
   * access errors; callers degrade failures to a WARN, never a 500.
   */
  deleteObject(key: string): Promise<void>;
```

and to `S3MediaStore`:

```ts
  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
```

Update the fully-typed fake in `app/test/helpers/twilioWebhookHarness.ts` (~2323): implement `deleteObject` against the fake's internal object map and push the key onto a new observable array (e.g. `deletedMediaKeys`), exposed the same way the harness exposes its other observability state.

- [ ] **Step 4: Run the test + typecheck** - the new test passes; `npm run typecheck` green (this catches any other fully-typed fake; research found only the harness one - `mmsSendGuard.test.ts` and the `apiRoutes.test.ts` fakes are casts and safe).

- [ ] **Step 5: Commit** - `git status` (bare, read it), then stage exactly the three files; message `feat(media): MediaStore.deleteObject (idempotent S3 delete for unit-photo removal)` + Co-Authored-By trailer.

---

### Task 2: resolveUnitMedia emits same-origin relative URLs

**Files:**
- Modify: `app/src/lib/unitMedia.ts` (rewrite resolveUnitMedia; delete UNIT_MEDIA_PRESIGN_TTL_SECONDS; update header comments)
- Modify: `app/src/routes/units.ts` (call sites ~418, ~605, ~648, ~686, ~721)
- Modify: `app/src/routes/public.ts` (resolvePublicMedia ~213; drop the router's mediaStore dep IF flyer resolution was its only use - verify by reading the router)
- Modify: `app/src/app.ts` (only if createPublicRouter's deps change; KEEP the `createMediaStore` instance at ~121 - Task 3 mounts it)
- Test: rewrite `app/test/unitsApiPhotos.test.ts` presigned-shape assertions (:188, :470-525) and `app/test/publicIntake.test.ts` (:301-303, :592-595)

**Interfaces:**
- Produces: `resolveUnitMedia(unit: Pick<UnitItem, 'unitId' | 'media'>, opts?: { logger?: Logger }): UnitMediaDisplay[]` - now SYNC, no mediaStore param. `UnitMediaDisplay` unchanged (`{ entry, url? }`). A namespace-valid stored key yields `url: '/' + entry`; legacy absolute http(s) URLs pass through; foreign/out-of-namespace keys degrade to url-absent with the existing WARN. Deterministic - works with no media store configured.
- Keeps: `UNIT_MEDIA_MAX`, `unitMediaPrefix` exactly as-is.

- [ ] **Step 1: Write/adjust failing tests first.** In `unitsApiPhotos.test.ts`, retitle the ":470 presign-per-read (D5)" describe to "mediaDisplay same-origin URLs (design 2026-07-21)" and assert: (a) a stored key resolves to exactly `'/' + key` (starts with `/unit-media/<unitId>/`); (b) two consecutive GETs return the SAME url (stable - replaces the old url1 !== url2 presign assertion); (c) a cross-unit key still yields no url; (d) a legacy absolute URL still passes through. In `publicIntake.test.ts` replace the `^https://fake-s3.local/` + `X-Amz-Signature=` assertions (:592-595) with `expect(url).toBe('/' + key)`. Example of the core new assertion:

```ts
    const res1 = await api.get(`/api/units/${unitId}`);
    const res2 = await api.get(`/api/units/${unitId}`);
    const url1 = res1.body.unit.mediaDisplay[0].url as string;
    expect(url1).toBe(`/${storedKey}`);
    expect(url1).toMatch(/^\/unit-media\//);
    expect(res2.body.unit.mediaDisplay[0].url).toBe(url1); // stable, not per-read
```

- [ ] **Step 2: Run to verify the new assertions fail** against current presigning behavior.

- [ ] **Step 3: Implement.** Rewrite `resolveUnitMedia` (sync; remove the MediaStore import ONLY if Task 4's helper does not live here - see Task 4, which adds a MediaStore-consuming helper to this same file, so keep the import):

```ts
export function resolveUnitMedia(
  unit: Pick<UnitItem, 'unitId' | 'media'>,
  opts: { logger?: Logger } = {},
): UnitMediaDisplay[] {
  const log = opts.logger ?? defaultLogger;
  const media = Array.isArray(unit.media)
    ? unit.media.filter((e): e is string => typeof e === 'string' && e.length > 0)
    : [];
  const ownPrefix = unitMediaPrefix(unit.unitId);
  return media.map((entry): UnitMediaDisplay => {
    if (isAbsoluteUrl(entry)) return { entry, url: entry };
    // NAMESPACE SCOPING (unchanged guard, 2026-07-15 hardening): only keys
    // under THIS unit's own prefix become URLs - a foreign key (an MMS
    // uploads/<uuid> attachment, or another unit's photo) pasted into the
    // PATCH-writable media list degrades to url-absent, never a served URL.
    if (!entry.startsWith(ownPrefix)) {
      log.warn(
        { unitId: unit.unitId },
        'unit media: entry outside the unit media namespace - no display URL',
      );
      return { entry };
    }
    // SAME-ORIGIN URL (design 2026-07-21): the path IS the S3 key. Served by
    // CloudFront's /unit-media/* behavior in deployed envs and by the app's
    // fallback route everywhere else. Stable and cache-friendly - never a
    // presigned, expiring URL.
    return { entry, url: `/${entry}` };
  });
}
```

Delete `UNIT_MEDIA_PRESIGN_TTL_SECONDS` (verified: no consumer outside the old presign call). Rewrite the file-header PRESIGN-PER-READ comment block to describe the same-origin scheme, citing the new spec date. Update the six call sites to the new signature (drop the mediaStore arg and, where trivially clean, the now-unneeded await). In `public.ts`, if resolvePublicMedia was the router's only mediaStore use, remove mediaStore from its deps and from the `createPublicRouter` wiring in app.ts - but LEAVE the `createMediaStore({ config })` instance in app.ts alive (rename to `mediaServeStore` if clearer); Task 3 needs it.

- [ ] **Step 4: Run** the two rewritten test files + `npm run typecheck`. All green.

- [ ] **Step 5: Commit** - `feat(units): resolveUnitMedia emits stable same-origin /unit-media URLs (presign-per-read retired)`.

---

### Task 3: GET /unit-media/* streaming fallback route

**Files:**
- Create: `app/src/routes/unitMediaServe.ts`
- Modify: `app/src/app.ts` (mount after the `/public` mount ~line 139, BEFORE the dashboardDistDir block; add `'/unit-media'` to the SPA-fallback reserved-prefix array ~line 220)
- Test: `app/test/unitMediaServe.test.ts` (new)

**Interfaces:**
- Consumes: `MediaStore.getStream(key)` (existing), `isImageMediaType` from `app/src/lib/mediaTypes.ts`, `createRateLimit` from `app/src/middleware/rateLimit.ts`.
- Produces: `createUnitMediaServeRouter(deps: { mediaStore?: MediaStore; logger: Logger }): Router` serving `GET /:unitId/:object`.

- [ ] **Step 1: Write failing tests** (follow the app-level supertest pattern the repo's route tests use; a minimal express app with the router mounted at `/unit-media` is fine):
  - 200: image object streams with `Content-Type: image/jpeg`, `X-Content-Type-Options: nosniff`, `Cache-Control: public, max-age=604800`, body bytes intact.
  - 404: absent object; 503: no media store configured.
  - 404 shape rejection: `/unit-media/u1/a/b` (extra segment - express won't match; assert via the full-app harness that the SPA fallback does NOT serve index.html for it once `'/unit-media'` is reserved), `/unit-media/..%2Fuploads/x` and any decoded segment containing a non-`[A-Za-z0-9._-]` char, and bare `.` / `..` segments.
  - Non-image stored Content-Type (e.g. `text/html` planted directly in the fake store) is served as `application/octet-stream` attachment, never inline.
  - Stream error mid-flight destroys the response (copy the existing `mmsMediaRoutes`-style test if one exists; otherwise emit `error` on the fake Readable).

- [ ] **Step 2: Run to verify failure** (module does not exist).

- [ ] **Step 3: Implement** `app/src/routes/unitMediaServe.ts`:

```ts
// GET /unit-media/<unitId>/<object> - same-origin unit-photo serving
// (design docs/superpowers/specs/2026-07-21-unit-media-cloudfront-design.md).
// In deployed envs CloudFront's /unit-media/* behavior (S3 origin + OAC)
// serves these objects WITHOUT reaching the app - this route is the fallback
// that makes every non-CloudFront environment work (local MinIO, hermetic
// e2e, live-mode local dev) and covers a deploy-before-apply window.
//
// PUBLIC READ POSTURE - KNOWN AND DESIGNED (spec D5, Cameron 2026-07-21):
// unauthenticated by design. Unit photos are public-flyer content; keys are
// unguessable server-minted uuids. Namespace scoping is enforced by SHAPE
// (exactly two safe segments after /unit-media/), so the PII namespaces
// (media/, recordings/, uploads/) can never be addressed through this route,
// matching CloudFront, whose behavior+OAC grant cover unit-media/* only.
import { Router } from 'express';
import type { MediaStore } from '../adapters/mediaStore.js';
import type { Logger } from '../lib/logger.js';
import { isImageMediaType } from '../lib/mediaTypes.js';

/** Parity with the CloudFront response-headers policy (7 days, immutable keys). */
const UNIT_MEDIA_CACHE_CONTROL = 'public, max-age=604800';

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
/** One path segment: safe charset, never a dot-navigation token. */
function isSafeSegment(seg: string): boolean {
  return SEGMENT_RE.test(seg) && seg !== '.' && seg !== '..';
}

export function createUnitMediaServeRouter(deps: {
  mediaStore?: MediaStore;
  logger: Logger;
}): Router {
  const { mediaStore, logger: log } = deps;
  const router = Router();

  router.get('/:unitId/:object', async (req, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const object = String(req.params['object'] ?? '');
    if (!isSafeSegment(unitId) || !isSafeSegment(object)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!mediaStore) {
      // Same posture as photos/presign: storage is not configured here.
      res.status(503).json({ error: 'media_storage_unavailable' });
      return;
    }
    const key = `unit-media/${unitId}/${object}`;
    const object_ = await mediaStore.getStream(key);
    if (!object_) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Content-Type is trusted-by-construction (pinned to the image allowlist
    // by the presigned-POST policy at upload) - the non-image branch is
    // belt-and-suspenders, mirroring the MMS media route's XSS hardening.
    const stored = object_.contentType;
    const inline = isImageMediaType(stored);
    res.setHeader('Content-Type', inline ? stored! : 'application/octet-stream');
    if (!inline) {
      res.setHeader('Content-Disposition', 'attachment; filename="unit-media"');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', UNIT_MEDIA_CACHE_CONTROL);
    if (object_.contentLength !== undefined) {
      res.setHeader('Content-Length', String(object_.contentLength));
    }
    object_.body.on('error', (err) => {
      log.error({ err, unitId }, 'unit media: stream errored mid-flight');
      res.destroy(err);
    });
    object_.body.pipe(res);
  });

  return router;
}
```

Mount in `app/src/app.ts` right after the `/public` mount (reusing the media store instance created at ~121), with a DEDICATED generous limiter - the /public limiter's 5/min default would break a single gallery load:

```ts
  // Same-origin unit-photo serving (design 2026-07-21). Unauthenticated BY
  // DESIGN (spec D5) - public-flyer content on unguessable uuid keys; in
  // deployed envs CloudFront serves this path from S3 before it ever reaches
  // the app. Generous per-IP limiter: a gallery load is up to ~100 images,
  // so the /public limiter's config (5/min default) cannot be reused here.
  app.use(
    '/unit-media',
    createRateLimit({ max: 1000, windowMs: 60_000, logger: log }),
    createUnitMediaServeRouter({ mediaStore: mediaServeStore, logger: log }),
  );
```

Add `'/unit-media'` to the reserved-prefix array in the SPA fallback (~line 220) so unmatched shapes 404 instead of serving index.html.

- [ ] **Step 4: Run** the new test file + `npm run typecheck`. Green.

- [ ] **Step 5: Commit** - `feat(app): GET /unit-media streaming route (same-origin photo serving fallback)`.

---

### Task 4: Best-effort delete on photo removal (D1)

**Files:**
- Modify: `app/src/lib/unitMedia.ts` (add deleteRemovedUnitMedia helper)
- Modify: `app/src/routes/units.ts` (DELETE /:unitId/photos ~657 incl. its ~652 comment; PATCH /:unitId ~1057)
- Test: extend `app/test/unitsApiPhotos.test.ts` (uses the harness fake's new `deletedMediaKeys` from Task 1)

**Interfaces:**
- Consumes: `MediaStore.deleteObject` (Task 1), `unitsRepo.getById` / `update` / `removeMedia` (existing).
- Produces: `deleteRemovedUnitMedia(mediaStore: MediaStore | undefined, unitId: string, removedEntries: string[], logger?: Logger): void` in `app/src/lib/unitMedia.ts` - fire-and-forget, own-namespace keys only.

- [ ] **Step 1: Write failing tests:**
  - DELETE /photos on a stored key -> 200 AND the harness records that key deleted.
  - DELETE /photos on a legacy absolute-URL entry -> 200, NO delete recorded.
  - Fake deleteObject made to reject -> DELETE /photos still 200 (WARN path, response unaffected).
  - PATCH /:unitId replacing media `[k1, k2] -> [k2]` -> k1 deleted, k2 not.
  - PATCH media `null` (attribute removal) -> all prior own-namespace stored keys deleted; a legacy URL entry in the prior list NOT deleted.
  - PATCH that keeps media identical -> no deletes.
  - A prior-list entry OUTSIDE the unit's namespace (foreign key planted via the raw seam) -> never deleted.

- [ ] **Step 2: Run to verify failures.**

- [ ] **Step 3: Implement.** Helper in `unitMedia.ts`:

```ts
/**
 * Best-effort S3 cleanup for entries REMOVED from unit.media (design
 * 2026-07-21, D1). Deletes ONLY stored keys inside THIS unit's own
 * namespace - legacy absolute URLs and foreign keys are never deleted.
 * Fire-and-forget: every failure is a WARN and the caller's response is
 * never affected. A removed photo may keep serving from CloudFront edge
 * caches up to the 7-day TTL (accepted; manual invalidation is the
 * operator escape hatch).
 */
export function deleteRemovedUnitMedia(
  mediaStore: MediaStore | undefined,
  unitId: string,
  removedEntries: string[],
  logger?: Logger,
): void {
  const log = logger ?? defaultLogger;
  if (!mediaStore) return;
  const ownPrefix = unitMediaPrefix(unitId);
  for (const entry of removedEntries) {
    if (isAbsoluteUrl(entry) || !entry.startsWith(ownPrefix)) continue;
    void mediaStore.deleteObject(entry).catch((err: unknown) => {
      log.warn({ err, unitId }, 'unit media: best-effort object delete failed (orphan remains)');
    });
  }
}
```

DELETE /photos route: after `removeMedia` succeeds, `deleteRemovedUnitMedia(mediaStore, unitId, [entry], log);` and REWRITE the ~652-653 comment (old text says "NO S3 object deletion; the object decays as an accepted orphan" - now cite D1 best-effort delete + 7-day cache lag).

PATCH route (~1057): only when the validated fields include `media`, load prior state and diff AFTER the write commits:

```ts
    const hasMediaPatch = Object.prototype.hasOwnProperty.call(validation.fields, 'media');
    const prev = hasMediaPatch ? await units.getById(unitId) : undefined;
    const updated = await units.update(unitId, validation.fields);
    if (hasMediaPatch && prev) {
      // D1: best-effort-delete stored keys the raw-seam write removed.
      // Read-then-write is not atomic: an append racing between getById and
      // update can orphan its object (the wholesale replace drops it from the
      // list without it appearing in prev) - the same accepted orphan class
      // that existed before this feature.
      const next = new Set(Array.isArray(updated.media) ? updated.media : []);
      const removed = (Array.isArray(prev.media) ? prev.media : []).filter(
        (e): e is string => typeof e === 'string' && !next.has(e),
      );
      deleteRemovedUnitMedia(mediaStore, unitId, removed, log);
    }
```

(Adapt variable names to the route's actual locals; keep its existing 404/validation flow untouched. If the PATCH handler lacks a mediaStore in scope, thread it from the router deps - the router already receives one for presign/confirm.)

- [ ] **Step 4: Run** the extended tests + `npm run typecheck`. Green. Because deletes are fire-and-forget, tests may need a tick (`await new Promise(setImmediate)`) before asserting `deletedMediaKeys` - follow the harness's existing async-drain idiom if it has one.

- [ ] **Step 5: Commit** - `feat(units): best-effort S3 delete of removed unit photos (D1; raw PATCH seam included)`.

---

### Task 5: CSP img-src back to 'self' (+ staticSmoke)

**Files:**
- Modify: `app/src/app.ts` (~lines 188-211: the CSP block)
- Test: `app/test/staticSmoke.test.ts` (:128-149)

**Interfaces:** none new. connect-src MUST keep the bucket origin (uploads); ONLY img-src drops it.

- [ ] **Step 1: Update assertions first** (failing): media-store-configured blocks assert `img-src 'self' data: blob:` appears WITHOUT the bucket origin appended (both AWS and MinIO shapes), e.g. `expect(csp).toContain("img-src 'self' data: blob:; connect-src")` or an explicit `not.toContain(\`img-src 'self' data: blob: ${origin}\`)` pair; connect-src assertions (`connect-src 'self' ${origin}`) stay as-is. No-store block (:60-81) is already correct - leave it.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** - in the `spaCsp` array change `withMedia("img-src 'self' data: blob:")` to `"img-src 'self' data: blob:"` and rewrite the comment above `mediaOrigin` (~188-195): the bucket origin now serves ONLY the upload path (connect-src); reads are same-origin via /unit-media (CloudFront or the app route), citing the 2026-07-21 design.
- [ ] **Step 4: Run** staticSmoke + typecheck. Green.
- [ ] **Step 5: Commit** - `feat(csp): img-src back to 'self' data: blob: (photo reads are same-origin; uploads keep connect-src)`.

---

### Task 6: Live-mode local dev MEDIA_BUCKET (D4)

**Files:**
- Modify: `scripts/dev.mjs` (live branch ~305-336, AFTER `assertHousingChoiceAccount()` returns `identity` ~line 330)

**Interfaces:**
- Consumes: `identity.Account` already in scope from the account guard; bucket name pattern `hc-dev-media-<accountId>` (matches `infra/modules/s3_media/main.tf` and the `scripts/wipe-dev-data.mjs:344` precedent).
- Produces: `childEnv.MEDIA_BUCKET` set for app+worker in live mode when not already set. NEVER sets `MEDIA_S3_ENDPOINT` in live mode (that is the MinIO-only override and is prod-guarded in config).

- [ ] **Step 1: Implement** (scripts have no unit-test harness - verification is Step 2). In the live-mode branch, immediately after the account guard:

```js
    // Live mode targets the REAL dev media bucket (design 2026-07-21, D4 -
    // closes live-mode-local-dev-has-no-media-store): photo display flows
    // through the app's /unit-media route, uploads go browser->S3 via the
    // presigned POST + the dev CORS localhost origin. MEDIA_S3_ENDPOINT is
    // deliberately NOT set - that is the MinIO override; unset means real S3
    // via the housingchoice profile credentials.
    if (!childEnv.MEDIA_BUCKET) {
      childEnv.MEDIA_BUCKET = `hc-dev-media-${identity.Account}`;
      console.log(`[dev] live mode media store: ${childEnv.MEDIA_BUCKET}`);
    }
```

(Confirm `childEnv` is assembled before this point and mutated in place elsewhere - lines ~170-233 do exactly that; match the file's logging style.)

- [ ] **Step 2: Verify** - `node --check scripts/dev.mjs` passes; do NOT run the live stack (it is Cameron's :5174 and needs his creds). State in the task report that live-mode verification is deferred to Cameron's post-merge QA (listed in rollout).
- [ ] **Step 3: Commit** - `feat(dev): live mode wires MEDIA_BUCKET to the real dev media bucket (D4)`.

---

### Task 7: Terraform - OAC origin, /unit-media/* behavior, bucket policy, dev CORS origin

**Files:**
- Modify: `infra/modules/s3_media/variables.tf`, `main.tf`, `outputs.tf`
- Modify: `infra/modules/cloudfront/variables.tf`, `main.tf`
- Modify: `infra/envs/dev/stack.tf` AND `infra/envs/prod/stack.tf` (byte-identical today - keep them byte-identical after the edit)
- Modify: `infra/envs/dev/main.tf` (:68 dashboard_origins only)

**Interfaces:**
- s3_media produces output `bucket_regional_domain_name`; consumes new var `cloudfront_distribution_arn` (string, default null - policy skipped when null, matching the dashboard_origins count-guard pattern).
- cloudfront consumes new var `media_origin_domain_name` (string, default null - origin/behavior/policies skipped when null); its existing `distribution_arn` output feeds s3_media. This bidirectional module reference is NOT a cycle (resource-granular graph; same pattern as params<->cloudfront, documented at stack.tf:74-81).

- [ ] **Step 1: s3_media.** variables.tf:

```hcl
variable "cloudfront_distribution_arn" {
  description = "ARN of the CloudFront distribution allowed to read unit-media/* via OAC (unit-media-cloudfront design 2026-07-21). null = no bucket policy created."
  type        = string
  default     = null
}
```

outputs.tf:

```hcl
output "bucket_regional_domain_name" {
  description = "Regional S3 domain (<bucket>.s3.<region>.amazonaws.com) - the CloudFront media-origin domain."
  value       = aws_s3_bucket.media.bucket_regional_domain_name
}
```

main.tf (append; mirrors the inbound_mail bucket-policy precedent):

```hcl
# CloudFront OAC read access to the PUBLIC unit-photo namespace ONLY
# (unit-media-cloudfront design 2026-07-21). unit-media/* is public-flyer
# content served on stable same-origin URLs; the PII namespaces (media/,
# recordings/, uploads/) are deliberately NOT granted - no CloudFront
# behavior routes to them, and this policy must never widen past
# unit-media/*. A service-principal grant conditioned on one distribution
# ARN is NOT a public policy, so block_public_policy above does not reject
# it. This is the bucket's FIRST policy document (nothing to merge).
data "aws_iam_policy_document" "media_cloudfront_read" {
  count = var.cloudfront_distribution_arn == null ? 0 : 1

  statement {
    sid       = "AllowCloudFrontOACReadUnitMedia"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.media.arn}/unit-media/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [var.cloudfront_distribution_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "media" {
  count = var.cloudfront_distribution_arn == null ? 0 : 1

  bucket = aws_s3_bucket.media.id
  policy = data.aws_iam_policy_document.media_cloudfront_read[0].json
}
```

- [ ] **Step 2: cloudfront module.** variables.tf:

```hcl
variable "media_origin_domain_name" {
  description = "Regional domain of the media bucket, served as the /unit-media/* S3 origin via OAC (unit-media-cloudfront design 2026-07-21). null = no media origin/behavior."
  type        = string
  default     = null
}
```

main.tf - extend locals:

```hcl
locals {
  origin_id       = "${var.name_prefix}app-origin"
  media_origin_id = "${var.name_prefix}media-origin"
  media_enabled   = var.media_origin_domain_name != null
}
```

New resources (these are the module's FIRST non-managed CloudFront policies - a deliberate departure from the "AWS-managed policies" header note, because no managed policy has a 7-day TTL; extend that header comment to say so):

```hcl
resource "aws_cloudfront_origin_access_control" "media" {
  count = local.media_enabled ? 1 : 0

  name                              = "${var.name_prefix}media-oac"
  description                       = "OAC signing for the media-bucket /unit-media/* behavior"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# 7-day cache policy for immutable unit photos (keys are server-minted uuids
# whose bytes never change; removal accepts <=7d edge staleness - design D2).
# S3 sends no Cache-Control, so default_ttl governs the edge.
resource "aws_cloudfront_cache_policy" "unit_media" {
  count = local.media_enabled ? 1 : 0

  name        = "${var.name_prefix}unit-media-7d"
  comment     = "unit-media/* immutable photos - 7d TTL, path-only cache key"
  min_ttl     = 1
  default_ttl = 604800
  max_ttl     = 604800

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true
  }
}

# Browsers cache too (S3 sends no Cache-Control of its own) + nosniff parity
# with the app's fallback route.
resource "aws_cloudfront_response_headers_policy" "unit_media" {
  count = local.media_enabled ? 1 : 0

  name    = "${var.name_prefix}unit-media-headers"
  comment = "Cache-Control + nosniff for unit photos"

  custom_headers_config {
    items {
      header   = "Cache-Control"
      value    = "public, max-age=604800"
      override = true
    }
  }

  security_headers_config {
    content_type_options {
      override = true
    }
  }
}
```

Inside `aws_cloudfront_distribution.this`, after the existing origin block:

```hcl
  # Media bucket origin (unit-media-cloudfront design 2026-07-21): private
  # bucket read via OAC sigv4 signing - no custom_origin_config and no
  # x-origin-verify header (that is an app-origin concern).
  dynamic "origin" {
    for_each = local.media_enabled ? [1] : []
    content {
      origin_id                = local.media_origin_id
      domain_name              = var.media_origin_domain_name
      origin_access_control_id = aws_cloudfront_origin_access_control.media[0].id
    }
  }
```

after the existing dynamic ordered_cache_behavior block:

```hcl
  # Unit photos straight from S3, cached 7 days. Path == object key, so ONLY
  # the public unit-media/* namespace is exposed; the PII namespaces have no
  # behavior and stay unreachable. The app's own GET /unit-media route is the
  # non-CloudFront fallback and never sees this traffic in a deployed env.
  dynamic "ordered_cache_behavior" {
    for_each = local.media_enabled ? ["/unit-media/*"] : []
    content {
      path_pattern               = ordered_cache_behavior.value
      target_origin_id           = local.media_origin_id
      viewer_protocol_policy     = "redirect-to-https"
      allowed_methods            = ["GET", "HEAD"]
      cached_methods             = ["GET", "HEAD"]
      compress                   = true
      cache_policy_id            = aws_cloudfront_cache_policy.unit_media[0].id
      response_headers_policy_id = aws_cloudfront_response_headers_policy.unit_media[0].id
    }
  }
```

- [ ] **Step 3: env stacks.** In BOTH `infra/envs/dev/stack.tf` and `infra/envs/prod/stack.tf` (identical edits - verify byte-identity afterwards with `diff`):
  - `module "s3_media"` gains: `cloudfront_distribution_arn = module.cloudfront.distribution_arn` (comment: NOT a cycle - resource-granular graph, same pattern as params<->cloudfront above).
  - `module "cloudfront"` gains: `media_origin_domain_name = module.s3_media.bucket_regional_domain_name`.

  In `infra/envs/dev/main.tf` line ~68 ONLY (prod untouched):

```hcl
  # + localhost:5174 (unit-media-cloudfront design 2026-07-21, D4): live-mode
  # local dev uploads direct to the real dev bucket from the local dashboard.
  dashboard_origins = ["https://${local.custom_domain}", "http://localhost:5174"]
```

- [ ] **Step 4: Verify syntax only** (allowed; no state/cloud access): from each of `infra/envs/dev` and `infra/envs/prod` run `terraform init -backend=false` then `terraform validate`; run `terraform fmt -check -recursive infra/`. NO `npm run plan`, NO apply - repo law; Cameron applies (rollout section).
- [ ] **Step 5: Commit** - `feat(infra): CloudFront media origin + /unit-media/* behavior (OAC, 7d cache) + bucket policy + dev localhost CORS origin`.

---

### Task 8: E2e + issue/doc closeout

**Files:**
- Modify: `e2e/tests/dashboard-next/listing-photos.spec.ts`
- Modify: `docs/issues/unit-photo-removal-never-deletes-s3-objects.md`, `docs/issues/live-mode-local-dev-has-no-media-store.md`
- Modify: `RUNBOOK.md` (owed-ops entry)

**Interfaces:** consumes everything prior; produces the pinned architectural claims.

- [ ] **Step 1: Extend the e2e spec** (it already survives relative URLs - its `srcKeyPath` helper resolves against the base URL):
  - Pin the same-origin architecture: assert every gallery/flyer photo `src` PATHNAME matches `^/unit-media/<unitId>/` (no `X-Amz`, no bucket host) - this is the permanent regression pin for the feature's core claim.
  - Pin delete-on-removal: capture a photo's URL, remove the photo in the UI, then `page.request.get(oldUrl)` and expect 404 (MinIO object gone via the app route).
  - Update the spec's stale "presign-per-read" comments.
- [ ] **Step 2: Run the e2e suite** from the worktree: `timeout 1500 npm run e2e` (bare; warm containers first with `npm run db:start` / `npm run s3:start` if needed). Known flakes to honor before blaming the change: tour-reminders-panel-e2e-flake, conversationdetail-members-mock-suite-flake (re-run; report both runs).
- [ ] **Step 3: Issues + RUNBOOK.**
  - `unit-photo-removal-never-deletes-s3-objects.md`: record that the removed-photo class is FIXED by this branch (D1 best-effort delete; <=7d edge-cache lag accepted; manual invalidation escape hatch). The oversize-original class stays open - keep `status: open`, rewrite the prose to scope it to that remaining class (follow the issue-file conventions in docs/issues/README.md).
  - `live-mode-local-dev-has-no-media-store.md`: mark resolved per the file conventions (fixed by D4: dev.mjs live-mode MEDIA_BUCKET + dev CORS localhost origin; note the CORS half needs Cameron's dev apply to be live).
  - `RUNBOOK.md`: add the owed operator steps (see Rollout below) to the appropriate section - operational content only.
- [ ] **Step 4: Commit** - `test(e2e)+docs: pin same-origin photo serving + delete-on-removal; close out issues; RUNBOOK owed ops`.

---

### Task 9: Full gates + main sync (orchestrator-level)

- [ ] `git merge main` ONCE (one-main-sync rule) resolving both sides' intent, then bare gates from the worktree, quoted exit codes:
  - `npm run typecheck` -> 0
  - `npm test` -> 0
  - `timeout 1500 npm run e2e` -> 0 (honor the two known flakes: re-run full suite, report both runs)
- [ ] ASCII sweep of the branch diff's added lines.
- [ ] Live self-QA per the profile harness (e2e:session + Playwright MCP): gallery + flyer render photos; the network panel shows same-origin `/unit-media/...` image requests (the architectural claim); zero CSP violations in the console; upload still works end-to-end; remove a photo and confirm its old URL now 404s. Screenshots prefixed `.playwright-mcp/`.

---

## Rollout (Cameron only - single-line PowerShell; record in handback + RUNBOOK)

1. Merge gate: human approval; never agent-merged.
2. Dev infra: `npm run plan -- dev` then `npm run apply -- dev` (no --reconfigure needed - no new module directory). Expected adds: OAC, cache policy, response-headers policy, media origin + behavior (distribution update), bucket policy, CORS origin addition, new output.
3. Dev deploy (app image): the usual deploy flow.
4. Verify on dev: photo renders on dashboard + flyer; `/unit-media/...` response shows an `x-cache` CloudFront header + `Cache-Control: public, max-age=604800`; CSP header has img-src WITHOUT the bucket origin and connect-src WITH it; a `/media/...` or `/recordings/...` URL does NOT serve; upload still works; removing a photo deletes the S3 object (console spot-check).
5. Live-mode local dev QA: `npm run dev` (live) now logs the media bucket; photo upload + display work at :5174 (needs step 2's CORS first).
6. Prod: rides the M1.11 cutover (`npm run plan -- prod` / `npm run apply -- prod` + deploy), matching how the upload CORS was staged.

## Self-review notes (plan-level)

- Spec coverage: D1 -> Task 4; D2 -> Tasks 3+7; D3 -> Task 3; D4 -> Tasks 6+7; D5 -> Tasks 3 comment + 8 issues; D6 -> no task needed (behaviors phase-independent; stated in Task 7 comments). CSP -> Task 5. resolveUnitMedia -> Task 2. deleteObject -> Task 1. Readers/renderers sweep -> "Invariant watch items" + Task 2 verify steps.
- The PATCH raw seam (the easiest surface to forget) is an explicit Task 4 step with its race note.
- Type consistency: `deleteObject(key: string): Promise<void>` (Tasks 1/4); `resolveUnitMedia(unit, opts)` sync (Task 2; Task 3 does not consume it); `createUnitMediaServeRouter({ mediaStore?, logger })` (Task 3); tf var names `cloudfront_distribution_arn` / `media_origin_domain_name` consistent across Tasks 7 steps.
