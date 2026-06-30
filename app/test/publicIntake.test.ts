// M1.5 unit tests: the PUBLIC, UNAUTHENTICATED surface (/public) —
//   POST /public/housing-fair   (intake → auto welcome text, idempotent)
//   GET  /public/units/:unitId/flyer   (shareable fields only, 404 otherwise)
// Plus the abuse fence: the per-IP rate limiter trips with 429, and NO PII
// (name/phone) ever appears in a log line.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { WELCOME_TEXT_TEMPLATE } from '../src/routes/public.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  ORIGIN_SECRET,
} from './helpers/twilioWebhookHarness.js';

const SECRET = ORIGIN_SECRET;
const FAIR = '/public/housing-fair';

// A representative signup body. The phone is unformatted on purpose — the route
// must normalize it.
function signupBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { firstName: 'Keisha', lastName: 'Jones', phone: '(555) 010-2000', ...overrides };
}

describe('POST /public/housing-fair — intake + auto welcome text', () => {
  it('captures a tenant (needs_review), sends ONE welcome text, returns only { ok: true }', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app).post(FAIR).set('x-origin-verify', SECRET).send(signupBody());

    expect(res.status).toBe(200);
    // No internal IDs / PII leak — exactly { ok: true }.
    expect(res.body).toEqual({ ok: true });

    // A tenant contact was captured for the normalized phone, to the triage queue.
    const contact = world.contacts.find((c) => c.phone === '+15550102000');
    expect(contact).toMatchObject({
      type: 'tenant',
      status: 'needs_review',
      firstName: 'Keisha',
      capture_source: 'housing_fair',
    });

    // Exactly one welcome text went out, to that phone, with the rendered body.
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]?.to).toBe('+15550102000');
    expect(world.sent[0]?.body).toBe(
      WELCOME_TEXT_TEMPLATE.replace('{firstName}', 'Keisha'),
    );

    // Audited (marker, never the phone/name).
    expect(world.auditEvents).toContainEqual(
      expect.objectContaining({ event_type: 'housing_fair_signup' }),
    );
  });

  it('is idempotent on a repeat phone: NO second contact, NO second welcome text (no SMS spam)', async () => {
    const { app, world } = makeWebhookHarness();
    await request(app).post(FAIR).set('x-origin-verify', SECRET).send(signupBody());
    expect(world.sent).toHaveLength(1);
    const contactCount = world.contacts.length;

    // Same phone signs up again (different formatting) — must be a no-op send.
    const again = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ phone: '555.010.2000', firstName: 'Keisha' }));
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true });

    expect(world.sent).toHaveLength(1); // still exactly one welcome text ever
    expect(world.contacts.length).toBe(contactCount); // no duplicate contact
  });

  it('rejects an invalid phone and missing names with a generic 400 (no send, no capture)', async () => {
    // High cap so this test measures VALIDATION, not the rate limiter (it fires
    // more requests than the default 5/min cap).
    const { app, world } = makeWebhookHarness({ env: { PUBLIC_RATE_LIMIT_MAX: '100' } });
    for (const body of [
      signupBody({ phone: 'not-a-phone' }),
      signupBody({ phone: '12345' }),
      { lastName: 'Jones', phone: '5550102000' }, // no firstName
      { firstName: 'Keisha', phone: '5550102000' }, // no lastName
      { firstName: 'Keisha', lastName: 'Jones' }, // no phone
      signupBody({ voucherSize: 99 }), // out of range
    ]) {
      const res = await request(app).post(FAIR).set('x-origin-verify', SECRET).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toEqual({ error: 'invalid request' }); // generic message
    }
    expect(world.sent).toHaveLength(0);
    expect(world.contacts).toHaveLength(0);
  });

  it('NEVER logs PII: no log line contains the phone or the name', async () => {
    const { app, capture } = makeWebhookHarness();
    await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send({ firstName: 'Unique1stName', lastName: 'Unique2ndName', phone: '+15550103333' });

    const serialized = JSON.stringify(capture.lines);
    expect(serialized).not.toContain('Unique1stName');
    expect(serialized).not.toContain('Unique2ndName');
    expect(serialized).not.toContain('+15550103333');
    expect(serialized).not.toContain('5550103333');
    // The signup WAS logged (the marker line exists) — just without PII.
    expect(capture.lines.some((l) => l['msg'] === 'housing-fair signup captured')).toBe(true);
  });

  it('renders the operator welcomeText override (with {firstName}) when set', async () => {
    const { app, world } = makeWebhookHarness();
    // Operator has overridden the welcome copy via the settings record.
    world.settings.welcomeText = 'Welcome {firstName}! Reply STOP to opt out.';

    const res = await request(app).post(FAIR).set('x-origin-verify', SECRET).send(signupBody());
    expect(res.status).toBe(200);

    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]?.body).toBe('Welcome Keisha! Reply STOP to opt out.');
    // NOT the constant — the override won.
    expect(world.sent[0]?.body).not.toBe(
      WELCOME_TEXT_TEMPLATE.replace('{firstName}', 'Keisha'),
    );
  });

  it('falls back to the WELCOME_TEXT_TEMPLATE constant when welcomeText is unset', async () => {
    const { app, world } = makeWebhookHarness();
    // No override on a fresh stack — welcomeText is absent.
    expect(world.settings.welcomeText).toBeUndefined();

    const res = await request(app).post(FAIR).set('x-origin-verify', SECRET).send(signupBody());
    expect(res.status).toBe(200);

    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]?.body).toBe(WELCOME_TEXT_TEMPLATE.replace('{firstName}', 'Keisha'));
  });

  it('falls back to the constant (and intake STILL succeeds) when the settings read throws', async () => {
    const { app, world } = makeWebhookHarness();
    // A settings-read failure must NOT break intake — the welcome send is
    // best-effort. Override the world settings repo to throw.
    world.settingsRepo.getOrgSettings = async () => {
      throw new Error('settings store unavailable');
    };

    const res = await request(app).post(FAIR).set('x-origin-verify', SECRET).send(signupBody());
    expect(res.status).toBe(200); // intake never breaks
    expect(res.body).toEqual({ ok: true });

    // The welcome still went out, using the bulletproof constant.
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]?.body).toBe(WELCOME_TEXT_TEMPLATE.replace('{firstName}', 'Keisha'));
  });

  it('does not fail the public request when the welcome send is refused (opted-out phone)', async () => {
    const { app, world } = makeWebhookHarness();
    // Pre-seed a contact that has opted out — the send wrapper refuses.
    world.contacts.push({
      contactId: 'c-optout',
      type: 'tenant',
      status: 'active',
      phone: '+15550104000',
      sms_opt_out: true,
    } as ContactItem);

    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ phone: '+15550104000' }));

    expect(res.status).toBe(200); // signup still succeeds
    expect(res.body).toEqual({ ok: true });
    expect(world.sent).toHaveLength(0); // refused — no text sent
  });
});

describe('POST /public/housing-fair — rate limiting (the abuse fence)', () => {
  it('trips with 429 after the per-IP cap is exhausted', async () => {
    // Tight window so the cap is reachable in-test: 2 requests / 60s / IP.
    const { app } = makeWebhookHarness({
      env: { PUBLIC_RATE_LIMIT_MAX: '2', PUBLIC_RATE_LIMIT_WINDOW_MS: '60000' },
    });
    // Use bad bodies so we measure the LIMITER, not the dedupe (each request
    // still consumes a token before the handler runs).
    const bad = { firstName: 'A', lastName: 'B' }; // 400 at the handler

    const r1 = await request(app).post(FAIR).set('x-origin-verify', SECRET).send(bad);
    const r2 = await request(app).post(FAIR).set('x-origin-verify', SECRET).send(bad);
    const r3 = await request(app).post(FAIR).set('x-origin-verify', SECRET).send(bad);

    expect(r1.status).toBe(400); // within cap (reaches the handler)
    expect(r2.status).toBe(400); // within cap
    expect(r3.status).toBe(429); // cap exhausted — limiter rejects
    expect(r3.body).toEqual({ error: 'rate_limited' });
    expect(r3.headers['retry-after']).toBeDefined();
  });

  it('applies to the flyer route too', async () => {
    const { app, world } = makeWebhookHarness({
      env: { PUBLIC_RATE_LIMIT_MAX: '1', PUBLIC_RATE_LIMIT_WINDOW_MS: '60000' },
    });
    world.units.set('unit-flyer', {
      unitId: 'unit-flyer',
      landlordId: 'll-1',
      status: 'available',
      beds: 2,
    });
    const ok = await request(app).get('/public/units/unit-flyer/flyer').set('x-origin-verify', SECRET);
    expect(ok.status).toBe(200);
    const limited = await request(app)
      .get('/public/units/unit-flyer/flyer')
      .set('x-origin-verify', SECRET);
    expect(limited.status).toBe(429);
  });
});

describe('GET /public/units/:unitId/flyer — shareable view only', () => {
  function seedFullUnit(world: ReturnType<typeof createFakeWorld>, overrides: Partial<UnitItem> = {}) {
    const unit: UnitItem = {
      unitId: 'unit-1',
      landlordId: 'contact-ll-secret',
      status: 'available',
      jurisdiction: 'DCA',
      address: { line1: '123 Private St', city: 'Atlanta', state: 'GA', zip: '30303' },
      beds: 2,
      baths: 1,
      area: 'Westside',
      subzone: 'Zone 4',
      accepted_programs: ['GHV'],
      rent_min: 1400,
      rent_max: 1600,
      payment_standard: 1700,
      deposit: 1400,
      lif: 500,
      media: ['s3://photo1.jpg', 's3://photo2.jpg'],
      listing_link: 'https://example.com/listing/1',
      tour_process: 'SECRET lockbox 9999',
      application_process: 'SECRET portal',
      primary_voice_contact: 'contact-ll-agent',
      ...overrides,
    };
    world.units.set(unit.unitId, unit);
    return unit;
  }

  it('returns ONLY the allowlisted flyer fields (internal fields absent)', async () => {
    const { app, world } = makeWebhookHarness();
    seedFullUnit(world);

    const res = await request(app).get('/public/units/unit-1/flyer').set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    const { flyer } = res.body;

    // The shareable set is present and correct (voucher_size derived from beds).
    expect(flyer).toEqual({
      unitId: 'unit-1',
      media: ['s3://photo1.jpg', 's3://photo2.jpg'],
      beds: 2,
      baths: 1,
      area: 'Westside',
      subzone: 'Zone 4',
      voucher_size: 2,
      accepted_programs: ['GHV'],
      listing_link: 'https://example.com/listing/1',
      rent_min: 1400,
      rent_max: 1600,
    });

    // INTERNAL fields must never appear in the response.
    const serialized = JSON.stringify(res.body);
    for (const secret of [
      'tour_process',
      'application_process',
      'primary_voice_contact',
      'landlordId',
      'contact-ll-secret',
      'payment_standard',
      'deposit',
      'lif',
      'address',
      '123 Private St',
      'SECRET',
    ]) {
      expect(serialized, secret).not.toContain(secret);
    }
  });

  it('404s a missing unit and a non-shareable (placed/inactive) unit — no existence oracle', async () => {
    const { app, world } = makeWebhookHarness();
    seedFullUnit(world, { status: 'placed' });

    const missing = await request(app)
      .get('/public/units/nope/flyer')
      .set('x-origin-verify', SECRET);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found' });

    const placed = await request(app)
      .get('/public/units/unit-1/flyer')
      .set('x-origin-verify', SECRET);
    expect(placed.status).toBe(404);
    expect(placed.body).toEqual({ error: 'not_found' });
  });

  it('404s a soft-deleted unit even while its status is still shareable — no existence oracle', async () => {
    const { app, world } = makeWebhookHarness();
    // status stays 'available' so the ONLY thing hiding it is the deleted_at
    // stamp — proves the soft-delete guard, not the status gate.
    seedFullUnit(world, { deleted_at: '2026-06-30T00:00:00.000Z' });

    const res = await request(app)
      .get('/public/units/unit-1/flyer')
      .set('x-origin-verify', SECRET);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});

describe('POST /public/housing-fair — flyer attribution (optional unitId)', () => {
  it('stamps capture_source:flyer + unit_of_interest for a shareable unit', async () => {
    const { app, world } = makeWebhookHarness();
    world.units.set('unit-flyer', {
      unitId: 'unit-flyer',
      landlordId: 'll-1',
      status: 'available',
      beds: 2,
    });

    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ unitId: 'unit-flyer' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true }); // still leaks nothing

    const contact = world.contacts.find((c) => c.phone === '+15550102000');
    expect(contact).toMatchObject({
      capture_source: 'flyer',
      unit_of_interest: 'unit-flyer',
    });
  });

  it('falls back to housing_fair (no unit_of_interest) when the unitId is missing', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ unitId: 'no-such-unit' }));
    expect(res.status).toBe(200);

    const contact = world.contacts.find((c) => c.phone === '+15550102000');
    expect(contact?.capture_source).toBe('housing_fair');
    expect(contact?.['unit_of_interest']).toBeUndefined();
  });

  it('falls back to housing_fair when the unit exists but is NOT shareable', async () => {
    const { app, world } = makeWebhookHarness();
    world.units.set('unit-placed', {
      unitId: 'unit-placed',
      landlordId: 'll-1',
      status: 'placed', // not shareable
      beds: 2,
    });

    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ unitId: 'unit-placed' }));
    expect(res.status).toBe(200);

    const contact = world.contacts.find((c) => c.phone === '+15550102000');
    expect(contact?.capture_source).toBe('housing_fair');
    expect(contact?.['unit_of_interest']).toBeUndefined();
  });

  it('falls back to housing_fair when the unit is soft-deleted (even if still shareable status)', async () => {
    const { app, world } = makeWebhookHarness();
    world.units.set('unit-deleted', {
      unitId: 'unit-deleted',
      landlordId: 'll-1',
      status: 'available', // shareable status, but…
      deleted_at: '2026-06-30T00:00:00.000Z', // …soft-deleted → no attribution
      beds: 2,
    });

    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ unitId: 'unit-deleted' }));
    expect(res.status).toBe(200);

    const contact = world.contacts.find((c) => c.phone === '+15550102000');
    expect(contact?.capture_source).toBe('housing_fair');
    expect(contact?.['unit_of_interest']).toBeUndefined();
  });

  it('rejects a present-but-non-string unitId with the generic 400', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ unitId: 12345 }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid request' });
    expect(world.contacts).toHaveLength(0);
  });

  it('keeps housing_fair when no unitId is supplied (today’s behavior)', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app).post(FAIR).set('x-origin-verify', SECRET).send(signupBody());
    expect(res.status).toBe(200);

    const contact = world.contacts.find((c) => c.phone === '+15550102000');
    expect(contact?.capture_source).toBe('housing_fair');
    expect(contact?.['unit_of_interest']).toBeUndefined();
  });
});

describe('GET /public/units/:unitId/details — the post-intake reveal', () => {
  function seedFullUnit(world: ReturnType<typeof createFakeWorld>, overrides: Partial<UnitItem> = {}) {
    const unit: UnitItem = {
      unitId: 'unit-1',
      landlordId: 'contact-ll-secret',
      status: 'available',
      jurisdiction: 'DCA',
      address: { line1: '123 Private St', city: 'Atlanta', state: 'GA', zip: '30303' },
      beds: 2,
      baths: 1,
      area: 'Westside',
      subzone: 'Zone 4',
      accepted_programs: ['GHV'],
      rent_min: 1400,
      rent_max: 1600,
      payment_standard: 1700,
      deposit: 1400,
      lif: 500,
      media: ['s3://photo1.jpg'],
      listing_link: 'https://example.com/listing/1',
      utilities: 'Tenant-paid',
      video_url: 'https://v.example/tour1',
      application_fee: 50,
      same_day_rta: true,
      tour_process: 'SECRET lockbox 9999',
      application_process: 'SECRET portal',
      primary_voice_contact: 'contact-ll-agent',
      ...overrides,
    };
    world.units.set(unit.unitId, unit);
    return unit;
  }

  it('returns the richer reveal set (address/video/utilities/fee/RTA) for a shareable unit', async () => {
    const { app, world } = makeWebhookHarness();
    seedFullUnit(world);

    const res = await request(app)
      .get('/public/units/unit-1/details')
      .set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    expect(res.body.details).toMatchObject({
      unitId: 'unit-1',
      address: { line1: '123 Private St', city: 'Atlanta', state: 'GA', zip: '30303' },
      utilities: 'Tenant-paid',
      video_url: 'https://v.example/tour1',
      application_fee: 50,
      same_day_rta: true,
    });

    // INTERNAL fields must never appear in the response.
    const serialized = JSON.stringify(res.body);
    for (const secret of [
      'tour_process',
      'application_process',
      'primary_voice_contact',
      'landlordId',
      'contact-ll-secret',
      'payment_standard',
      'deposit',
      'lif',
      'SECRET',
    ]) {
      expect(serialized, secret).not.toContain(secret);
    }
  });

  it('404s a missing unit and a non-shareable (placed) unit — no existence oracle', async () => {
    const { app, world } = makeWebhookHarness();
    seedFullUnit(world, { status: 'placed' });

    const missing = await request(app)
      .get('/public/units/nope/details')
      .set('x-origin-verify', SECRET);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found' });

    const placed = await request(app)
      .get('/public/units/unit-1/details')
      .set('x-origin-verify', SECRET);
    expect(placed.status).toBe(404);
    expect(placed.body).toEqual({ error: 'not_found' });
  });

  it('404s a soft-deleted unit even while its status is still shareable — no existence oracle', async () => {
    const { app, world } = makeWebhookHarness();
    seedFullUnit(world, { deleted_at: '2026-06-30T00:00:00.000Z' });

    const res = await request(app)
      .get('/public/units/unit-1/details')
      .set('x-origin-verify', SECRET);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});

describe('/public sits behind the origin-secret validator (locked chain stage 2)', () => {
  it('403s without the origin secret (chain intact — public means no requireAuth, not no origin secret)', async () => {
    const { app } = makeWebhookHarness();
    expect((await request(app).post(FAIR).send(signupBody())).status).toBe(403);
  });
});
