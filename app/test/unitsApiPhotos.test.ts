// unit-photos direct-upload route tests: POST /api/units/:unitId/photos/presign
// (mint presigned-POST grants), POST /api/units/:unitId/photos/confirm (record
// the keys the browser uploaded directly to S3), DELETE /api/units/:unitId/photos,
// PUT /api/units/:unitId/photos/cover, and the mediaDisplay presign-per-read
// resolution on GET /api/units/:unitId. Drives the real routers through
// makeWebhookHarness with the world's fake MediaStore (which records each minted
// grant into world.presignPosts and reads back stored objects via head()).
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { UNIT_MEDIA_MAX } from '../src/lib/unitMedia.js';
import { UNIT_PHOTO_SOURCE_MAX_BYTES } from '../src/lib/unitPhotoLimits.js';
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
    // mediaDisplay resolves each stored key to a presigned URL alongside the raw entry.
    expect(res.body.unit.mediaDisplay).toHaveLength(2);
    expect(res.body.unit.mediaDisplay[0].entry).toBe(k1);
    expect(res.body.unit.mediaDisplay[0].url).toMatch(/^https:\/\/fake-s3\.local\//);
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

describe('GET /api/units/:unitId - mediaDisplay presign-per-read (D5)', () => {
  it('mints a DIFFERENT url on each read and NEVER persists a presigned url', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1', { media: ['unit-media/unit-1/k1'] });
    const get = () =>
      request(app).get('/api/units/unit-1').set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
    const first = await get();
    const second = await get();
    expect(first.status).toBe(200);
    const url1: string = first.body.unit.mediaDisplay[0].url;
    const url2: string = second.body.unit.mediaDisplay[0].url;
    expect(url1).toMatch(/^https:\/\/fake-s3\.local\//);
    expect(url1).not.toBe(url2); // fresh signature each read
    // The durable field still holds the raw key - no presigned URL persisted.
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

  it('review F2: presigns ONLY keys under this unit\'s own namespace (foreign keys degrade)', async () => {
    // `media` stays PATCH-writable (E5) and the bucket is shared with the MMS
    // namespaces - a foreign key pasted into media (an uploads/ MMS attachment,
    // or ANOTHER unit's photo) must NEVER presign (else the public flyer would
    // expose a private object). Legacy URLs still pass through.
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
    expect(display[0]!.url).toMatch(/^https:\/\/fake-s3\.local\//); // own key: presigned
    expect(display[1]!).toEqual({ entry: 'uploads/some-mms-attachment' }); // foreign: NO url
    expect(display[2]!).toEqual({ entry: 'unit-media/unit-OTHER/their-photo' }); // cross-unit: NO url
    expect(display[3]!.url).toBe('https://legacy.example/photo.jpg'); // legacy URL: pass-through
  });
});
