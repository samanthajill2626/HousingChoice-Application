// unit-photos direct-upload route tests: POST /api/units/:unitId/photos/presign
// (mint presigned-POST grants), POST /api/units/:unitId/photos/confirm (record
// the keys the browser uploaded directly to S3), DELETE /api/units/:unitId/photos,
// PUT /api/units/:unitId/photos/cover, and the mediaDisplay same-origin
// resolution on GET /api/units/:unitId. Drives the real routers through
// makeWebhookHarness with the world's fake MediaStore (which records each minted
// grant into world.presignPosts and reads back stored objects via head()).
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import sharp from 'sharp';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { isSafeUnitMediaSegment, UNIT_MEDIA_MAX } from '../src/lib/unitMedia.js';
import { UNIT_PHOTO_PASSTHROUGH_MAX_BYTES, UNIT_PHOTO_SOURCE_MAX_BYTES } from '../src/lib/unitPhotoLimits.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

const SECRET = ORIGIN_SECRET;

function seedUnit(
  world: ReturnType<typeof createFakeWorld>,
  unitId: string,
  overrides: Partial<UnitItem> = {},
): UnitItem {
  const item: UnitItem = {
    unitId,
    landlordId: 'contact-ll-1',
    status: 'available',
    created_at: '2026-06-12T09:00:00.000Z',
    updated_at: '2026-06-12T09:00:00.000Z',
    ...overrides,
  };
  world.units.set(unitId, item);
  return item;
}

/** Seed a stored object into the fake store so confirm's HeadObject re-check sees it. */
function storeObject(
  world: ReturnType<typeof createFakeWorld>,
  key: string,
  opts: { contentType?: string; size?: number } = {},
): void {
  const size = opts.size ?? 64;
  world.mediaObjects.set(key, {
    body: Buffer.alloc(size, 0x61),
    ...(opts.contentType !== undefined && { contentType: opts.contentType }),
  });
}

function presign(app: ReturnType<typeof makeWebhookHarness>['app'], unitId: string) {
  return request(app)
    .post(`/api/units/${unitId}/photos/presign`)
    .set('x-origin-verify', SECRET)
    .set('cookie', TEST_SESSION_COOKIE);
}

function confirm(app: ReturnType<typeof makeWebhookHarness>['app'], unitId: string) {
  return request(app)
    .post(`/api/units/${unitId}/photos/confirm`)
    .set('x-origin-verify', SECRET)
    .set('cookie', TEST_SESSION_COOKIE);
}

function del(app: ReturnType<typeof makeWebhookHarness>['app'], unitId: string) {
  return request(app)
    .delete(`/api/units/${unitId}/photos`)
    .set('x-origin-verify', SECRET)
    .set('cookie', TEST_SESSION_COOKIE);
}

function patchUnit(app: ReturnType<typeof makeWebhookHarness>['app'], unitId: string) {
  return request(app)
    .patch(`/api/units/${unitId}`)
    .set('x-origin-verify', SECRET)
    .set('cookie', TEST_SESSION_COOKIE);
}

/** Best-effort deletes are fire-and-forget - drain the immediate queue before asserting. */
const drainDeletes = () => new Promise((resolve) => setImmediate(resolve));

const KEY_RE = /^unit-media\/unit-1\/[0-9a-f-]+$/;

describe('POST /api/units/:unitId/photos/presign', () => {
  it('mints ONE grant per file, each under the unit prefix with its content-type policy', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const res = await presign(app, 'unit-1').send({
      count: 2,
      contentTypes: ['image/png', 'image/jpeg'],
    });
    expect(res.status).toBe(200);
    const uploads: { key: string; post: { url: string; fields: Record<string, string> } }[] =
      res.body.uploads;
    expect(uploads).toHaveLength(2);
    for (const u of uploads) {
      expect(u.key).toMatch(KEY_RE);
      expect(u.post.url).toBeTruthy();
      expect(u.post.fields['key']).toBe(u.key);
    }
    // The two keys are distinct (server-minted uuids).
    expect(uploads[0]!.key).not.toBe(uploads[1]!.key);
    // The policy content-type is surfaced per file (via the fake's record).
    expect(uploads[0]!.post.fields['Content-Type']).toBe('image/png');
    expect(uploads[1]!.post.fields['Content-Type']).toBe('image/jpeg');
    // Exactly two grants minted, each pinned to its file's key + content type.
    expect(world.presignPosts).toHaveLength(2);
    expect(world.presignPosts.map((p) => p.contentType)).toEqual(['image/png', 'image/jpeg']);
    expect(world.presignPosts[0]!.key).toMatch(KEY_RE);
    // No bytes touched the app: nothing was put through the store.
    expect(world.mediaPuts).toHaveLength(0);
  });

  it('503s when the media store is unconfigured', async () => {
    const { app, world } = makeWebhookHarness({ withoutMediaStore: true });
    seedUnit(world, 'unit-1');
    const res = await presign(app, 'unit-1').send({ count: 1, contentTypes: ['image/png'] });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'media_storage_unavailable' });
  });

  it('404s an unknown unit and a soft-deleted unit (nothing minted)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-del', { deleted_at: '2026-07-01T00:00:00.000Z' });
    const missing = await presign(app, 'nope').send({ count: 1, contentTypes: ['image/png'] });
    expect(missing.status).toBe(404);
    const deleted = await presign(app, 'unit-del').send({ count: 1, contentTypes: ['image/png'] });
    expect(deleted.status).toBe(404);
    expect(world.presignPosts).toHaveLength(0);
  });

  it('400s a non-image content type BEFORE any mint', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const res = await presign(app, 'unit-1').send({
      count: 2,
      contentTypes: ['image/png', 'application/pdf'],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unsupported_media_type' });
    expect(world.presignPosts).toHaveLength(0);
  });

  it('400s a count over the per-request batch max (20)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const res = await presign(app, 'unit-1').send({
      count: 21,
      contentTypes: Array.from({ length: 21 }, () => 'image/png'),
    });
    expect(res.status).toBe(400);
    expect(world.presignPosts).toHaveLength(0);
  });

  it('400s when count is not a positive integer or contentTypes length mismatches', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const zero = await presign(app, 'unit-1').send({ count: 0, contentTypes: [] });
    expect(zero.status).toBe(400);
    const mismatch = await presign(app, 'unit-1').send({ count: 2, contentTypes: ['image/png'] });
    expect(mismatch.status).toBe(400);
    expect(world.presignPosts).toHaveLength(0);
  });

  it('400s photo_cap_exceeded when existing + count would exceed the 100 cap', async () => {
    const { app, world } = makeWebhookHarness();
    const full = Array.from({ length: UNIT_MEDIA_MAX - 1 }, (_v, i) => `unit-media/unit-1/k${i}`);
    seedUnit(world, 'unit-1', { media: full });
    const res = await presign(app, 'unit-1').send({
      count: 5,
      contentTypes: Array.from({ length: 5 }, () => 'image/png'),
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'photo_cap_exceeded' });
    expect(world.presignPosts).toHaveLength(0);
  });

  it('meters the per-user presign limiter: 429 past 30 mints in a minute', async () => {
    const { app } = makeWebhookHarness();
    // All to a ghost unit: the limiter runs BEFORE the handler, so the first 30
    // are admitted (each 404s at the handler) and the 31st is limited.
    for (let i = 0; i < 30; i += 1) {
      const res = await presign(app, 'ghost').send({ count: 1, contentTypes: ['image/png'] });
      expect(res.status).toBe(404);
    }
    const limited = await presign(app, 'ghost').send({ count: 1, contentTypes: ['image/png'] });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('mints each grant with the 20MB source policy cap (transcode design 2026-07-21)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const res = await presign(app, 'unit-1').send({ count: 1, contentTypes: ['image/jpeg'] });
    expect(res.status).toBe(200);
    expect(world.presignPosts).toHaveLength(1);
    expect(world.presignPosts[0]!.maxBytes).toBe(UNIT_PHOTO_SOURCE_MAX_BYTES);
  });
});

describe('POST /api/units/:unitId/photos/confirm', () => {
  it('appends the surviving keys, audits count-only, returns mediaDisplay', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const k1 = 'unit-media/unit-1/aaa';
    const k2 = 'unit-media/unit-1/bbb';
    storeObject(world, k1, { contentType: 'image/png' });
    storeObject(world, k2, { contentType: 'image/jpeg' });
    const res = await confirm(app, 'unit-1').send({ keys: [k1, k2] });
    expect(res.status).toBe(200);
    expect(res.body.unit.media).toEqual([k1, k2]);
    // mediaDisplay resolves each stored key to a same-origin /unit-media URL alongside the raw entry.
    expect(res.body.unit.mediaDisplay).toHaveLength(2);
    expect(res.body.unit.mediaDisplay[0].entry).toBe(k1);
    expect(res.body.unit.mediaDisplay[0].url).toBe('/' + k1);
    // The audit carries COUNT only (no key/filename).
    const added = world.auditEvents.find((e) => e.event_type === 'unit_photos_added');
    expect(added?.payload).toMatchObject({ count: 2 });
    expect(JSON.stringify(added?.payload)).not.toContain('unit-media/');
  });

  it('503s when the media store is unconfigured', async () => {
    const { app, world } = makeWebhookHarness({ withoutMediaStore: true });
    seedUnit(world, 'unit-1');
    const res = await confirm(app, 'unit-1').send({ keys: ['unit-media/unit-1/aaa'] });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'media_storage_unavailable' });
  });

  it('drops a foreign / cross-unit / uploads key (prefix scope), keeping only own-namespace keys', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const own = 'unit-media/unit-1/own';
    storeObject(world, own, { contentType: 'image/png' });
    // These three would each resolve to a real object, but the prefix scope
    // rejects them before any head() so a crafted body cannot append a foreign key.
    storeObject(world, 'uploads/mms-attachment', { contentType: 'image/png' });
    storeObject(world, 'unit-media/unit-OTHER/theirs', { contentType: 'image/png' });
    const res = await confirm(app, 'unit-1').send({
      keys: ['uploads/mms-attachment', 'unit-media/unit-OTHER/theirs', own],
    });
    expect(res.status).toBe(200);
    expect(res.body.unit.media).toEqual([own]);
  });

  it('drops a key whose object is missing (never uploaded)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const good = 'unit-media/unit-1/good';
    storeObject(world, good, { contentType: 'image/png' });
    // 'ghost' is under the prefix but was never uploaded -> head() undefined -> dropped.
    const res = await confirm(app, 'unit-1').send({
      keys: ['unit-media/unit-1/ghost', good],
    });
    expect(res.status).toBe(200);
    expect(res.body.unit.media).toEqual([good]);
  });

  it('drops a key that failed the stored type / size re-check', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const good = 'unit-media/unit-1/good';
    const badType = 'unit-media/unit-1/badtype';
    const tooBig = 'unit-media/unit-1/toobig';
    storeObject(world, good, { contentType: 'image/png' });
    storeObject(world, badType, { contentType: 'application/pdf' });
    storeObject(world, tooBig, { contentType: 'image/png', size: UNIT_PHOTO_SOURCE_MAX_BYTES + 1 });
    const res = await confirm(app, 'unit-1').send({ keys: [good, badType, tooBig] });
    expect(res.status).toBe(200);
    expect(res.body.unit.media).toEqual([good]);
  });

  it('400s when NO key survives the drops', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    // A foreign key + a missing key: both dropped, nothing to append.
    storeObject(world, 'uploads/mms', { contentType: 'image/png' });
    const res = await confirm(app, 'unit-1').send({
      keys: ['uploads/mms', 'unit-media/unit-1/never-uploaded'],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'no_valid_photos' });
    expect(world.units.get('unit-1')?.media).toBeUndefined();
  });

  it('400s an empty / missing keys array', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const empty = await confirm(app, 'unit-1').send({ keys: [] });
    expect(empty.status).toBe(400);
    const missing = await confirm(app, 'unit-1').send({});
    expect(missing.status).toBe(400);
  });

  it('404s an unknown unit and a soft-deleted unit (mirrors presign; nothing appended)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-del', { deleted_at: '2026-07-01T00:00:00.000Z' });
    const key = 'unit-media/unit-del/aaa';
    storeObject(world, key, { contentType: 'image/png' });
    const missing = await confirm(app, 'ghost').send({ keys: ['unit-media/ghost/aaa'] });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'unit_not_found' });
    const deleted = await confirm(app, 'unit-del').send({ keys: [key] });
    expect(deleted.status).toBe(404);
    expect(deleted.body).toEqual({ error: 'unit_not_found' });
    expect(world.units.get('unit-del')?.media).toBeUndefined();
  });

  it('MF1: 400s photo_cap_exceeded UP FRONT when the body carries more keys than the whole-unit cap', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    // 200 keys on a FRESH (media-absent) unit: rejected before any HeadObject,
    // so none of the keys need stored objects - the 100-cap backstop holds even
    // on the first append.
    const keys = Array.from({ length: 200 }, (_v, i) => `unit-media/unit-1/k${i}`);
    const res = await confirm(app, 'unit-1').send({ keys });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'photo_cap_exceeded' });
    expect(world.units.get('unit-1')?.media).toBeUndefined();
  });

  it('MF1: 400s photo_cap_exceeded when existing + survivors would exceed the cap', async () => {
    const { app, world } = makeWebhookHarness();
    const existing = Array.from({ length: UNIT_MEDIA_MAX - 4 }, (_v, i) => `unit-media/unit-1/old${i}`);
    seedUnit(world, 'unit-1', { media: existing });
    // 5 valid new uploads against 4 remaining slots -> the route pre-check
    // rejects before appendMedia; the array is untouched.
    const keys = Array.from({ length: 5 }, (_v, i) => `unit-media/unit-1/new${i}`);
    for (const k of keys) storeObject(world, k, { contentType: 'image/png' });
    const res = await confirm(app, 'unit-1').send({ keys });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'photo_cap_exceeded' });
    expect(world.units.get('unit-1')?.media).toHaveLength(UNIT_MEDIA_MAX - 4);
  });

  it('SF2: a key repeated within the body appends ONCE', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const k = 'unit-media/unit-1/dup';
    storeObject(world, k, { contentType: 'image/png' });
    const res = await confirm(app, 'unit-1').send({ keys: [k, k] });
    expect(res.status).toBe(200);
    expect(res.body.unit.media).toEqual([k]);
    const added = world.auditEvents.find((e) => e.event_type === 'unit_photos_added');
    expect(added?.payload).toMatchObject({ count: 1 });
  });

  it('SF2: re-confirming already-present keys is an idempotent 200 (no dup, no second audit)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const k = 'unit-media/unit-1/once';
    storeObject(world, k, { contentType: 'image/png' });
    const first = await confirm(app, 'unit-1').send({ keys: [k] });
    expect(first.status).toBe(200);
    expect(first.body.unit.media).toEqual([k]);
    // The replay (client retry after a lost response): success with the
    // CURRENT unit, media unchanged, no duplicate append, no second audit.
    const replay = await confirm(app, 'unit-1').send({ keys: [k] });
    expect(replay.status).toBe(200);
    expect(replay.body.unit.media).toEqual([k]);
    expect(replay.body.unit.mediaDisplay).toHaveLength(1);
    expect(world.units.get('unit-1')?.media).toEqual([k]);
    const audits = world.auditEvents.filter((e) => e.event_type === 'unit_photos_added');
    expect(audits).toHaveLength(1);
  });

  it('SF2: a mixed body appends only the NEW key (already-present key skipped)', async () => {
    const { app, world } = makeWebhookHarness();
    const present = 'unit-media/unit-1/present';
    seedUnit(world, 'unit-1', { media: [present] });
    const fresh = 'unit-media/unit-1/fresh';
    storeObject(world, fresh, { contentType: 'image/png' });
    const res = await confirm(app, 'unit-1').send({ keys: [present, fresh] });
    expect(res.status).toBe(200);
    expect(res.body.unit.media).toEqual([present, fresh]);
    const added = world.auditEvents.find((e) => e.event_type === 'unit_photos_added');
    expect(added?.payload).toMatchObject({ count: 1 });
  });

  it('SF3: a rejecting audit is best-effort - photos stored, request still 200', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const k = 'unit-media/unit-1/audited';
    storeObject(world, k, { contentType: 'image/png' });
    world.auditRepo.append = async () => {
      throw new Error('audit outage');
    };
    const res = await confirm(app, 'unit-1').send({ keys: [k] });
    expect(res.status).toBe(200);
    expect(res.body.unit.media).toEqual([k]);
    expect(world.units.get('unit-1')?.media).toEqual([k]);
  });

  it('maps an appendMedia cap-race (ConditionalCheckFailed) to the 400 cap shape', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const good = 'unit-media/unit-1/good';
    storeObject(world, good, { contentType: 'image/png' });
    // A concurrent confirm filled the unit past the cap after the survivors were
    // validated: the atomic re-guard throws ConditionalCheckFailed -> same 400.
    world.unitsRepo.appendMedia = async () => {
      throw new ConditionalCheckFailedException({ message: 'cap race', $metadata: {} });
    };
    const res = await confirm(app, 'unit-1').send({ keys: [good] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'photo_cap_exceeded' });
    expect(world.auditEvents.some((e) => e.event_type === 'unit_photos_added')).toBe(false);
  });

  it('MF-2a: meters the per-user confirm limiter: 429 past 60 confirms in a minute', async () => {
    const { app } = makeWebhookHarness();
    // Confirm is now the EXPENSIVE endpoint (it downloads + transcodes >5MB
    // sources behind the SHARED gate), so it carries a per-user fence. 60/min
    // (raised from 30 per the 2026-07-21 review - a 35+ big-photo drop could
    // legitimately exceed 30 requests in a 60s window): 2x headroom over the
    // fastest real dashboard pace, while scripted tight loops still 429. All
    // to a ghost unit: the limiter runs BEFORE the handler, so the first 60
    // are admitted (each 404s) and the 61st is limited.
    for (let i = 0; i < 60; i += 1) {
      const res = await confirm(app, 'ghost').send({ keys: ['unit-media/ghost/aaa'] });
      expect(res.status).toBe(404);
    }
    const limited = await confirm(app, 'ghost').send({ keys: ['unit-media/ghost/aaa'] });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });
});

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

  it('MF-2b: at the 100-photo cap, a decodable >5MB key is rejected BEFORE the transcode (no orphan put)', async () => {
    const { app, world } = makeWebhookHarness();
    const full = Array.from({ length: UNIT_MEDIA_MAX }, (_v, i) => `unit-media/unit-1/old${i}`);
    seedUnit(world, 'unit-1', { media: full });
    const key = 'unit-media/unit-1/aaaaaaaa-0000-0000-0000-000000000008';
    // A REAL decodable >5MB png: without the early cap pre-check the route would
    // pay the download + transcode and PUT an orphan rendition before the 400.
    world.mediaObjects.set(key, { body: await bigNoisePng(), contentType: 'image/png' });
    const res = await confirm(app, 'unit-1').send({ keys: [key] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'photo_cap_exceeded' });
    // Proof the transcode was SKIPPED, not merely failed: nothing was put to S3.
    expect(world.mediaPuts).toHaveLength(0);
    expect(world.units.get('unit-1')?.media).toHaveLength(UNIT_MEDIA_MAX);
  });

  it('P-2: rejects too_many_large_photos when a body carries more >5MB keys than the per-request bound (no put)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    // 5 oversize keys in ONE body exceeds UNIT_PHOTO_TRANSCODE_MAX_PER_REQUEST (4).
    // Garbage bytes suffice: the bound rejects BEFORE any getBytes/sharp.
    const keys = Array.from({ length: 5 }, (_v, i) => `unit-media/unit-1/big${i}`);
    for (const k of keys) storeObject(world, k, { contentType: 'image/jpeg', size: 6 * 1024 * 1024 });
    const res = await confirm(app, 'unit-1').send({ keys });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'too_many_large_photos' });
    expect(world.mediaPuts).toHaveLength(0);
    expect(world.units.get('unit-1')?.media).toBeUndefined();
  });
});

describe('DELETE /api/units/:unitId/photos', () => {
  it('drops the entry, audits entry-hash only, returns the updated unit', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1', { media: ['k1', 'k2'] });
    const res = await request(app)
      .delete('/api/units/unit-1/photos')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ entry: 'k1' });
    expect(res.status).toBe(200);
    expect(res.body.unit.media).toEqual(['k2']);
    const removed = world.auditEvents.find((e) => e.event_type === 'unit_photo_removed');
    expect(removed).toBeDefined();
    expect(removed?.payload).toMatchObject({ remaining: 1 });
    // The raw key never lands in the audit payload (entry-hash only).
    expect(JSON.stringify(removed?.payload)).not.toContain('k1');
  });

  it('404s an unknown entry and an unknown unit; 400 a missing entry', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1', { media: ['k1'] });
    const unknownEntry = await request(app)
      .delete('/api/units/unit-1/photos')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ entry: 'nope' });
    expect(unknownEntry.status).toBe(404);
    const unknownUnit = await request(app)
      .delete('/api/units/ghost/photos')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ entry: 'k1' });
    expect(unknownUnit.status).toBe(404);
    const noEntry = await request(app)
      .delete('/api/units/unit-1/photos')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(noEntry.status).toBe(400);
  });
});

describe('PUT /api/units/:unitId/photos/cover', () => {
  it('moves the entry to the front (new cover) and audits unit_photo_cover_set', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1', { media: ['k1', 'k2', 'k3'] });
    const res = await request(app)
      .put('/api/units/unit-1/photos/cover')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ entry: 'k3' });
    expect(res.status).toBe(200);
    expect(res.body.unit.media).toEqual(['k3', 'k1', 'k2']);
    expect(world.auditEvents.some((e) => e.event_type === 'unit_photo_cover_set')).toBe(true);
  });

  it('is a no-op success when the entry is already the cover', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1', { media: ['k1', 'k2'] });
    const res = await request(app)
      .put('/api/units/unit-1/photos/cover')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ entry: 'k1' });
    expect(res.status).toBe(200);
    expect(res.body.unit.media).toEqual(['k1', 'k2']);
  });

  it('404s an unknown entry / unknown unit', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1', { media: ['k1'] });
    const unknownEntry = await request(app)
      .put('/api/units/unit-1/photos/cover')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ entry: 'nope' });
    expect(unknownEntry.status).toBe(404);
    const unknownUnit = await request(app)
      .put('/api/units/ghost/photos/cover')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ entry: 'k1' });
    expect(unknownUnit.status).toBe(404);
  });
});

describe('GET /api/units/:unitId - mediaDisplay same-origin URLs (design 2026-07-21)', () => {
  it('emits a STABLE same-origin url on each read and NEVER persists a url', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1', { media: ['unit-media/unit-1/k1'] });
    const get = () =>
      request(app).get('/api/units/unit-1').set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
    const first = await get();
    const second = await get();
    expect(first.status).toBe(200);
    const url1: string = first.body.unit.mediaDisplay[0].url;
    const url2: string = second.body.unit.mediaDisplay[0].url;
    expect(url1).toBe('/unit-media/unit-1/k1');
    expect(url1).toMatch(/^\/unit-media\//);
    expect(url2).toBe(url1); // stable same-origin URL, not a per-read presign
    // The durable field still holds the raw key - no URL persisted.
    expect(world.units.get('unit-1')?.media).toEqual(['unit-media/unit-1/k1']);
  });

  it('passes a legacy absolute-URL entry through unchanged (E2)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1', { media: ['https://legacy.example/photo.jpg'] });
    const res = await request(app)
      .get('/api/units/unit-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.unit.mediaDisplay[0]).toEqual({
      entry: 'https://legacy.example/photo.jpg',
      url: 'https://legacy.example/photo.jpg',
    });
  });

  it('review F2: emits URLs ONLY for keys under this unit\'s own namespace (foreign keys degrade)', async () => {
    // `media` stays PATCH-writable (E5) and the bucket is shared with the MMS
    // namespaces - a foreign key pasted into media (an uploads/ MMS attachment,
    // or ANOTHER unit's photo) must NEVER get a display URL (else the public
    // flyer would expose a private object). Legacy URLs still pass through.
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1', {
      media: [
        'unit-media/unit-1/own-photo',
        'uploads/some-mms-attachment',
        'unit-media/unit-OTHER/their-photo',
        'https://legacy.example/photo.jpg',
      ],
    });
    const res = await request(app)
      .get('/api/units/unit-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    const display: { entry: string; url?: string }[] = res.body.unit.mediaDisplay;
    expect(display).toHaveLength(4);
    expect(display[0]!.url).toBe('/unit-media/unit-1/own-photo'); // own key: same-origin URL
    expect(display[1]!).toEqual({ entry: 'uploads/some-mms-attachment' }); // foreign: NO url
    expect(display[2]!).toEqual({ entry: 'unit-media/unit-OTHER/their-photo' }); // cross-unit: NO url
    expect(display[3]!.url).toBe('https://legacy.example/photo.jpg'); // legacy URL: pass-through
  });

  it('review C1: a crafted own-namespace key with an unsafe SHAPE yields NO url (guard shared with the serve route)', async () => {
    // The raw PATCH seam (E5) can plant an own-PREFIX key whose remainder is not
    // a single safe segment. resolveUnitMedia shares the GET /unit-media serve
    // route's per-segment guard, so such a key degrades to url-absent instead of
    // emitting a display URL the route would ALWAYS 404 (traversal / embedded
    // slash / space). The real uuid key still resolves to its same-origin URL.
    const { app, world } = makeWebhookHarness();
    const REAL = 'unit-media/unit-1/11111111-2222-3333-4444-555555555555';
    const TRAVERSAL = 'unit-media/unit-1/../../recordings/secret';
    const EXTRA_SEG = 'unit-media/unit-1/a/b';
    const SPACE = 'unit-media/unit-1/has space';
    seedUnit(world, 'unit-1', { media: [REAL, TRAVERSAL, EXTRA_SEG, SPACE] });
    const res = await request(app)
      .get('/api/units/unit-1')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    const display: { entry: string; url?: string }[] = res.body.unit.mediaDisplay;
    expect(display).toHaveLength(4);
    expect(display[0]!.url).toBe('/' + REAL); // real uuid key: same-origin URL
    expect(display[1]!).toEqual({ entry: TRAVERSAL }); // '..' traversal: NO url
    expect(display[2]!).toEqual({ entry: EXTRA_SEG }); // embedded slash: NO url
    expect(display[3]!).toEqual({ entry: SPACE }); // space in segment: NO url
  });
});

describe('isSafeUnitMediaSegment (shared serve-route + URL-emission guard, review C1)', () => {
  it('accepts a uuid-shaped segment + the safe charset; rejects slashes, dot-nav, spaces, empty', () => {
    // Real key segments: the unitId and the server-minted uuid object.
    expect(isSafeUnitMediaSegment('11111111-2222-3333-4444-555555555555')).toBe(true);
    expect(isSafeUnitMediaSegment('unit-1')).toBe(true);
    expect(isSafeUnitMediaSegment('a.b_c-1')).toBe(true);
    // Dot-navigation + out-of-charset bytes: rejected. These are exactly the
    // shapes GET /unit-media 404s, so the resolver must not emit URLs for them.
    expect(isSafeUnitMediaSegment('.')).toBe(false);
    expect(isSafeUnitMediaSegment('..')).toBe(false);
    expect(isSafeUnitMediaSegment('a/b')).toBe(false);
    expect(isSafeUnitMediaSegment('../x')).toBe(false);
    expect(isSafeUnitMediaSegment('has space')).toBe(false);
    expect(isSafeUnitMediaSegment('a$b')).toBe(false);
    expect(isSafeUnitMediaSegment('')).toBe(false);
  });
});

describe('delete-on-removal (D1) - best-effort S3 cleanup of removed unit photos', () => {
  const K1 = 'unit-media/unit-1/k1';
  const K2 = 'unit-media/unit-1/k2';
  const LEGACY = 'https://legacy.example/photo.jpg';

  // --- DELETE /api/units/:unitId/photos ---

  it('DELETE: best-effort-deletes the removed own-namespace object', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1', { media: [K1, K2] });
    storeObject(world, K1, { contentType: 'image/png' });
    storeObject(world, K2, { contentType: 'image/png' });
    const res = await del(app, 'unit-1').send({ entry: K1 });
    expect(res.status).toBe(200);
    expect(res.body.unit.media).toEqual([K2]);
    await drainDeletes();
    expect(world.deletedMediaKeys).toEqual([K1]);
    expect(world.mediaObjects.has(K1)).toBe(false); // object gone
    expect(world.mediaObjects.has(K2)).toBe(true); // survivor untouched
  });

  it('DELETE: never deletes a removed legacy absolute-URL entry (own-namespace keys only)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1', { media: [LEGACY, K2] });
    const res = await del(app, 'unit-1').send({ entry: LEGACY });
    expect(res.status).toBe(200);
    expect(res.body.unit.media).toEqual([K2]);
    await drainDeletes();
    expect(world.deletedMediaKeys).toEqual([]);
  });

  it('DELETE: a rejecting deleteObject stays best-effort - still 200 (WARN, not 500); key not recorded', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1', { media: [K1] });
    storeObject(world, K1, { contentType: 'image/png' });
    world.failMediaDeletes.add(K1); // force the fake deleteObject to reject
    const res = await del(app, 'unit-1').send({ entry: K1 });
    expect(res.status).toBe(200);
    expect(res.body.unit.media).toEqual([]);
    await drainDeletes();
    // The delete threw (WARN path): the key never lands in deletedMediaKeys.
    expect(world.deletedMediaKeys).toEqual([]);
  });

  // --- PATCH /api/units/:unitId (the raw E5 seam) ---

  it('PATCH: replacing media [k1,k2] -> [k2] deletes ONLY the removed k1', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1', { media: [K1, K2] });
    storeObject(world, K1, { contentType: 'image/png' });
    storeObject(world, K2, { contentType: 'image/png' });
    const res = await patchUnit(app, 'unit-1').send({ media: [K2] });
    expect(res.status).toBe(200);
    expect(res.body.unit.media).toEqual([K2]);
    await drainDeletes();
    expect(world.deletedMediaKeys).toEqual([K1]);
    expect(world.mediaObjects.has(K2)).toBe(true);
  });

  it('PATCH: clearing media to [] deletes every prior own-namespace key, never the legacy URL', async () => {
    // NOTE: `media: null` (the plan's literal "attribute removal") is rejected by
    // validateUnitBody (kind string[]; isStringArray(null) is false -> 400), so the
    // route-reachable "remove all photos" is `media: []`. It drives the same helper
    // path: an empty next-set means every prior stored key counts as removed.
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1', { media: [K1, K2, LEGACY] });
    storeObject(world, K1, { contentType: 'image/png' });
    storeObject(world, K2, { contentType: 'image/png' });
    const res = await patchUnit(app, 'unit-1').send({ media: [] });
    expect(res.status).toBe(200);
    await drainDeletes();
    expect([...world.deletedMediaKeys].sort()).toEqual([K1, K2].sort());
    expect(world.deletedMediaKeys).not.toContain(LEGACY);
  });

  it('PATCH: keeping media identical deletes nothing', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1', { media: [K1, K2] });
    storeObject(world, K1, { contentType: 'image/png' });
    storeObject(world, K2, { contentType: 'image/png' });
    const res = await patchUnit(app, 'unit-1').send({ media: [K1, K2] });
    expect(res.status).toBe(200);
    await drainDeletes();
    expect(world.deletedMediaKeys).toEqual([]);
  });

  it('PATCH: a removed FOREIGN-namespace key (planted in the prior list) is never deleted', async () => {
    // The raw seam can leave a foreign key on unit.media; removing it must NOT
    // delete a cross-unit / uploads object (own-namespace guard in the helper).
    const OWN = 'unit-media/unit-1/own';
    const FOREIGN = 'unit-media/unit-OTHER/theirs';
    const UPLOAD = 'uploads/mms-attachment';
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1', { media: [OWN, FOREIGN, UPLOAD] });
    storeObject(world, OWN, { contentType: 'image/png' });
    storeObject(world, FOREIGN, { contentType: 'image/png' });
    storeObject(world, UPLOAD, { contentType: 'image/png' });
    const res = await patchUnit(app, 'unit-1').send({ media: [] });
    expect(res.status).toBe(200);
    await drainDeletes();
    expect(world.deletedMediaKeys).toEqual([OWN]); // only the own-namespace key
    expect(world.mediaObjects.has(FOREIGN)).toBe(true);
    expect(world.mediaObjects.has(UPLOAD)).toBe(true);
  });
});
