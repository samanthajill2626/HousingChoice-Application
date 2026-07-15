// unit-photos S2/S3/S4 route tests: POST /api/units/:unitId/photos (multipart
// image upload), DELETE /api/units/:unitId/photos, PUT /api/units/:unitId/photos/cover,
// and the mediaDisplay presign-per-read resolution on GET /api/units/:unitId.
// Drives the real routers through makeWebhookHarness with the world's fake
// MediaStore (which consumes the streamed body and mints a UNIQUE presigned URL
// per call, so the presign-per-read pin is exercised for real).
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { UNIT_MEDIA_MAX } from '../src/lib/unitMedia.js';
import { OUTBOUND_MMS_MAX_FILE_BYTES } from '../src/lib/outboundMediaLimits.js';
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

function photoPost(app: ReturnType<typeof makeWebhookHarness>['app'], unitId: string) {
  return request(app)
    .post(`/api/units/${unitId}/photos`)
    .set('x-origin-verify', SECRET)
    .set('cookie', TEST_SESSION_COOKIE);
}

const png = (name = 'a.png') => ({ buf: Buffer.from(`pretend-${name}`), name });

describe('POST /api/units/:unitId/photos - upload', () => {
  it('stores a single image, appends ONE key, audits count-only, returns mediaDisplay', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const res = await photoPost(app, 'unit-1').attach('file', png().buf, {
      filename: 'a.png',
      contentType: 'image/png',
    });
    expect(res.status).toBe(200);
    const media: string[] = res.body.unit.media;
    expect(media).toHaveLength(1);
    expect(media[0]).toMatch(/^unit-media\/unit-1\/[0-9a-f-]+$/);
    // mediaDisplay resolves the stored key to a presigned URL alongside the raw entry.
    expect(res.body.unit.mediaDisplay).toHaveLength(1);
    expect(res.body.unit.mediaDisplay[0].entry).toBe(media[0]);
    expect(res.body.unit.mediaDisplay[0].url).toMatch(/^https:\/\/fake-s3\.local\//);
    // Exactly one object stored; the audit carries COUNT only (no filename/key).
    expect(world.mediaPuts).toHaveLength(1);
    const added = world.auditEvents.find((e) => e.event_type === 'unit_photos_added');
    expect(added).toBeDefined();
    expect(added?.payload).toMatchObject({ count: 1 });
    expect(JSON.stringify(added?.payload)).not.toContain('unit-media/');
  });

  it('stores MANY images in one request via ONE atomic append (order preserved; first = cover)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1', { media: ['unit-media/unit-1/existing'] });
    const res = await photoPost(app, 'unit-1')
      .attach('file', png('one').buf, { filename: 'one.png', contentType: 'image/png' })
      .attach('file', png('two').buf, { filename: 'two.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
    const media: string[] = res.body.unit.media;
    expect(media).toHaveLength(3);
    // The pre-existing cover stays first; the two new keys append after it.
    expect(media[0]).toBe('unit-media/unit-1/existing');
    expect(world.mediaPuts).toHaveLength(2);
  });

  it('503s when the media store is unconfigured', async () => {
    const { app, world } = makeWebhookHarness({ withoutMediaStore: true });
    seedUnit(world, 'unit-1');
    const res = await photoPost(app, 'unit-1').attach('file', png().buf, {
      filename: 'a.png',
      contentType: 'image/png',
    });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'media_storage_unavailable' });
  });

  it('rejects a non-image type (400) BEFORE any put - E3 validate-then-store (half 1)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    // A valid image FIRST then an invalid one: NOTHING is stored and NOTHING appended.
    const res = await photoPost(app, 'unit-1')
      .attach('file', png().buf, { filename: 'ok.png', contentType: 'image/png' })
      .attach('file', Buffer.from('%PDF-'), { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unsupported_media_type' });
    expect(world.mediaPuts).toHaveLength(0);
    expect(world.units.get('unit-1')?.media).toBeUndefined();
  });

  it('rejects a file past the 5MB cap (413) and stores/appends nothing', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    const tooBig = Buffer.alloc(OUTBOUND_MMS_MAX_FILE_BYTES + 1024, 0x61);
    const res = await photoPost(app, 'unit-1').attach('file', tooBig, {
      filename: 'big.png',
      contentType: 'image/png',
    });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'file_too_large' });
    expect(world.mediaPuts).toHaveLength(0);
    expect(world.units.get('unit-1')?.media).toBeUndefined();
  });

  it('a mid-batch PUT failure appends NOTHING (5xx) - E3 (half 2)', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    // Fail the SECOND put: the first object is stored (an orphan), but the single
    // appendMedia never runs, so unit.media stays unchanged.
    let putCalls = 0;
    const origPut = world.mediaStore.put.bind(world.mediaStore);
    world.mediaStore.put = async (key, body, contentType) => {
      putCalls += 1;
      if (putCalls === 2) throw new Error('boom');
      return origPut(key, body, contentType);
    };
    const res = await photoPost(app, 'unit-1')
      .attach('file', png('one').buf, { filename: 'one.png', contentType: 'image/png' })
      .attach('file', png('two').buf, { filename: 'two.png', contentType: 'image/png' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'upload_failed' });
    expect(world.units.get('unit-1')?.media).toBeUndefined(); // no partial append
    expect(world.auditEvents.some((e) => e.event_type === 'unit_photos_added')).toBe(false);
  });

  it('rejects the request when existing + incoming would exceed the 100 cap (400)', async () => {
    const { app, world } = makeWebhookHarness();
    const full = Array.from({ length: UNIT_MEDIA_MAX }, (_v, i) => `unit-media/unit-1/k${i}`);
    seedUnit(world, 'unit-1', { media: full });
    const res = await photoPost(app, 'unit-1').attach('file', png().buf, {
      filename: 'a.png',
      contentType: 'image/png',
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'photo_cap_exceeded' });
    expect(world.mediaPuts).toHaveLength(0);
  });

  it('SF1: a transient appendMedia rejection returns 500 (no hang), no partial state', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    // The success tail runs from bb.on('close') - OUTSIDE Express async-error
    // capture. A rejecting append MUST be mapped to a response, not hang the
    // request (supertest would time out on a hang).
    world.unitsRepo.appendMedia = async () => {
      throw new Error('dynamo throttled');
    };
    const res = await photoPost(app, 'unit-1').attach('file', png().buf, {
      filename: 'a.png',
      contentType: 'image/png',
    });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal server error' });
    // Object stored (orphan), but no append committed and no audit trail.
    expect(world.units.get('unit-1')?.media).toBeUndefined();
    expect(world.auditEvents.some((e) => e.event_type === 'unit_photos_added')).toBe(false);
  });

  it('SF1: an appendMedia cap-race (ConditionalCheckFailed) maps to the 400 cap shape', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    // A concurrent append filled the unit past the cap after our pre-check: the
    // atomic re-guard throws ConditionalCheckFailedException -> same 400 shape.
    world.unitsRepo.appendMedia = async () => {
      throw new ConditionalCheckFailedException({ message: 'cap race', $metadata: {} });
    };
    const res = await photoPost(app, 'unit-1').attach('file', png().buf, {
      filename: 'a.png',
      contentType: 'image/png',
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'photo_cap_exceeded' });
    expect(world.units.get('unit-1')?.media).toBeUndefined();
  });

  it('SF1: a rejecting audit is best-effort - photos stored, request still 200', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    // The append commits; the trail write blips. The photos are stored, so the
    // request must NOT hang or 500 (which would tempt a duplicate-append retry).
    world.auditRepo.append = async () => {
      throw new Error('audit table throttled');
    };
    const res = await photoPost(app, 'unit-1').attach('file', png().buf, {
      filename: 'a.png',
      contentType: 'image/png',
    });
    expect(res.status).toBe(200);
    expect(res.body.unit.media).toHaveLength(1);
    expect(res.body.unit.mediaDisplay[0].url).toMatch(/^https:\/\/fake-s3\.local\//);
    // The append DID commit despite the missing audit event.
    expect(world.units.get('unit-1')?.media).toHaveLength(1);
    expect(world.auditEvents.some((e) => e.event_type === 'unit_photos_added')).toBe(false);
  });

  it('review F3: a rejecting pre-store getById returns 500 (no hang) and stores nothing', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-1');
    // finish() runs from bb.on('close') OUTSIDE Express async-error capture.
    // The SF1 fix guarded the success tail; this pins the PRE-STORE read too
    // (the conformance-review deviation): a rejecting getById must map to a
    // 500 via the finish() catch-all, never an unhandled rejection + hang.
    world.unitsRepo.getById = async () => {
      throw new Error('dynamo throttled');
    };
    const res = await photoPost(app, 'unit-1').attach('file', png().buf, {
      filename: 'a.png',
      contentType: 'image/png',
    });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal server error' });
    expect(world.mediaPuts).toHaveLength(0);
  });

  it('review F1: the per-request aggregate byte fence 413s the whole batch (nothing stored)', async () => {
    // Inject a tiny fence so two ordinary files overflow it: total buffered
    // bytes across the REQUEST is what the fence bounds (each file is well
    // under the per-file cap).
    const { app, world } = makeWebhookHarness({ photoUploadLimits: { maxRequestBytes: 10 } });
    seedUnit(world, 'unit-1');
    const res = await photoPost(app, 'unit-1')
      .attach('file', Buffer.alloc(8, 1), { filename: 'a.png', contentType: 'image/png' })
      .attach('file', Buffer.alloc(8, 2), { filename: 'b.png', contentType: 'image/png' });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'request_too_large' });
    expect(world.mediaPuts).toHaveLength(0);
    expect(world.units.get('unit-1')?.media).toBeUndefined();
  });

  it('review F1: the concurrency gate 429s past the in-flight cap and RELEASES per request', async () => {
    // maxConcurrent 0: every upload is rejected before any body buffers.
    const zero = makeWebhookHarness({ photoUploadLimits: { maxConcurrent: 0 } });
    seedUnit(zero.world, 'unit-1');
    const rejected = await photoPost(zero.app, 'unit-1').attach('file', png().buf, {
      filename: 'a.png',
      contentType: 'image/png',
    });
    expect(rejected.status).toBe(429);
    expect(rejected.body).toEqual({ error: 'too_many_concurrent_uploads' });
    expect(zero.world.mediaPuts).toHaveLength(0);

    // maxConcurrent 1: two SEQUENTIAL uploads both succeed - the slot releases
    // when the response closes (res 'close'), so the gate never leaks.
    const one = makeWebhookHarness({ photoUploadLimits: { maxConcurrent: 1 } });
    seedUnit(one.world, 'unit-1');
    for (const name of ['a.png', 'b.png']) {
      const ok = await photoPost(one.app, 'unit-1').attach('file', png(name).buf, {
        filename: name,
        contentType: 'image/png',
      });
      expect(ok.status).toBe(200);
    }
    expect(one.world.units.get('unit-1')?.media).toHaveLength(2);
  });

  it('404s an unknown unit and a soft-deleted unit', async () => {
    const { app, world } = makeWebhookHarness();
    seedUnit(world, 'unit-del', { deleted_at: '2026-07-01T00:00:00.000Z' });
    const missing = await photoPost(app, 'nope').attach('file', png().buf, {
      filename: 'a.png',
      contentType: 'image/png',
    });
    expect(missing.status).toBe(404);
    const deleted = await photoPost(app, 'unit-del').attach('file', png().buf, {
      filename: 'a.png',
      contentType: 'image/png',
    });
    expect(deleted.status).toBe(404);
    expect(world.mediaPuts).toHaveLength(0);
  });

  it('meters the D4 per-user limiter: 429 past 30 uploads in a minute', async () => {
    const { app } = makeWebhookHarness();
    // All to a ghost unit: the limiter runs BEFORE the handler, so the first 30
    // are admitted (each 404s at the handler) and the 31st is limited.
    for (let i = 0; i < 30; i += 1) {
      const res = await photoPost(app, 'ghost').attach('file', png().buf, {
        filename: 'a.png',
        contentType: 'image/png',
      });
      expect(res.status).toBe(404);
    }
    const limited = await photoPost(app, 'ghost').attach('file', png().buf, {
      filename: 'a.png',
      contentType: 'image/png',
    });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
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
