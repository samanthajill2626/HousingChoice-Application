// M1.5 unit tests: the PUBLIC, UNAUTHENTICATED surface (/public) —
//   POST /public/housing-fair   (intake → auto welcome text, idempotent)
//   GET  /public/units/:unitId/flyer   (public fields only; every status but setup, 404 otherwise)
// Plus the abuse fence: the per-IP rate limiter trips with 429, and NO PII
// (name/phone) ever appears in a log line.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { OrgEntry, OrgKind } from '../src/lib/orgNames.js';
import { LISTING_STATUS_LABELS } from '../src/lib/statusModel.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { WELCOME_TEXT_TEMPLATE } from '../src/routes/public.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  ORIGIN_SECRET,
  OUR_NUMBER,
} from './helpers/twilioWebhookHarness.js';

const SECRET = ORIGIN_SECRET;
const FAIR = '/public/housing-fair';

// A representative signup body. The phone is unformatted on purpose — the route
// must normalize it. smsConsent:true satisfies the A2P server-side consent gate
// (spec §3.1) — the consent-gate tests below drop it explicitly.
function signupBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { firstName: 'Keisha', lastName: 'Jones', phone: '(555) 010-2000', smsConsent: true, ...overrides };
}

describe('POST /public/housing-fair — intake + auto welcome text', () => {
  it('captures a tenant (onboarding, with the v2 marker), sends ONE welcome text, returns only { ok: true }', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app).post(FAIR).set('x-origin-verify', SECRET).send(signupBody());

    expect(res.status).toBe(200);
    // No internal IDs / PII leak — exactly { ok: true }.
    expect(res.body).toEqual({ ok: true });

    // A tenant contact was captured for the normalized phone, as Onboarding with the
    // v2 marker (join-housing-authority D5) and no housing authority (none was sent),
    // stamped with the web_form consent (spec §3.1) + the disclosure version.
    const contact = world.contacts.find((c) => c.phone === '+15550102000');
    expect(contact).toMatchObject({
      type: 'tenant',
      status: 'onboarding',
      housing_fair_signup_v2: true,
      firstName: 'Keisha',
      capture_source: 'housing_fair',
      consent_method: 'web_form',
      consent_version: 'ctia-2026-06',
    });
    expect(typeof contact?.consent_at).toBe('string');
    expect(Object.keys(contact ?? {})).not.toContain('housingAuthority');

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

  it('today-checklist spec 7.2: the welcome text never stamps last_reached_out_at (automated)', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app).post(FAIR).set('x-origin-verify', SECRET).send(signupBody());
    expect(res.status).toBe(200);
    expect(world.sent).toHaveLength(1);
    expect(world.reachedOutTouches).toEqual([]);
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
    // flyer-leads D6: the repeat falls inside the 24-hour window of the first
    // sign-up's pin (the same /join source), so it adds no second pin or bump.
    expect(world.activityEvents.filter((e) => e.type === 'signed_up')).toHaveLength(1);
    expect(world.unreadIncrements).toHaveLength(1);
  });

  it('rejects an invalid phone and missing names with a generic 400 (no send, no capture)', async () => {
    // High cap so this test measures VALIDATION, not the rate limiter (it fires
    // more requests than the default 5/min cap).
    const { app, world } = makeWebhookHarness({ env: { PUBLIC_RATE_LIMIT_MAX: '100' } });
    for (const body of [
      signupBody({ phone: 'not-a-phone' }),
      signupBody({ phone: '12345' }),
      { lastName: 'Jones', phone: '5550102000', smsConsent: true }, // no firstName
      { firstName: 'Keisha', phone: '5550102000', smsConsent: true }, // no lastName
      { firstName: 'Keisha', lastName: 'Jones', smsConsent: true }, // no phone
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
      .send({ firstName: 'Unique1stName', lastName: 'Unique2ndName', phone: '+15550103333', smsConsent: true });

    const serialized = JSON.stringify(capture.lines);
    expect(serialized).not.toContain('Unique1stName');
    expect(serialized).not.toContain('Unique2ndName');
    expect(serialized).not.toContain('+15550103333');
    expect(serialized).not.toContain('5550103333');
    // The signup WAS logged (the marker line exists) — just without PII.
    expect(capture.lines.some((l) => l['msg'] === 'housing-fair signup captured')).toBe(true);
  });

  it('(PIN) NEVER logs PII on the existing-contact path either: the pin, the unread mark, the ledger and every failed step', async () => {
    const { app, world, capture } = makeWebhookHarness({ env: { PUBLIC_RATE_LIMIT_MAX: '100' } });
    world.units.set('unit-pii', {
      unitId: 'unit-pii',
      landlordId: 'll-1',
      status: 'available',
      address: { line1: '77 Unique Ave', city: 'Atlanta', state: 'GA' },
    });
    world.contacts.push({
      contactId: 'c-pii',
      type: 'tenant',
      status: 'searching',
      phone: '+15550103334',
      firstName: 'Stored1st',
      lastName: 'Stored2nd',
    } as ContactItem);
    const body = { firstName: 'Unique1stName', lastName: 'Unique2ndName', phone: '+15550103334', smsConsent: true, unitId: 'unit-pii' };
    const send = () => request(app).post(FAIR).set('x-origin-verify', SECRET).send(body);

    // A clean pass: the pin, the mark and the flyer entry are all written.
    expect((await send()).status).toBe(200);
    // Then every best-effort step fails, across two passes (a failed touch skips the increment);
    // the audit is one since planner review C-F1.
    vi.spyOn(world.activityEventsRepo, 'hasEventSince').mockRejectedValue(new Error('repeat read down'));
    vi.spyOn(world.activityEventsRepo, 'record').mockRejectedValue(new Error('pin write down'));
    vi.spyOn(world.conversationsRepo, 'incrementUnread').mockRejectedValue(new Error('increment down'));
    vi.spyOn(world.listingSendsRepo, 'getByKeyConsistent').mockRejectedValue(new Error('ledger read down'));
    world.failAuditAppendFor.add('housing_fair_signup');
    expect((await send()).status).toBe(200);
    vi.spyOn(world.conversationsRepo, 'touchLastActivity').mockRejectedValue(new Error('touch down'));
    expect((await send()).status).toBe(200);

    const steps = capture.lines.filter((l) => l['msg'] === 'housing-fair signup step failed').map((l) => l['step']);
    expect(new Set(steps)).toEqual(new Set(['repeat_check', 'pin', 'touch', 'increment', 'ledger', 'audit']));
    const serialized = JSON.stringify(capture.lines);
    for (const pii of ['Unique1stName', 'Unique2ndName', 'Stored1st', 'Stored2nd', '+15550103334', '5550103334', 'Signed up from', '77 Unique Ave']) {
      expect(serialized, pii).not.toContain(pii);
    }
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

  it('an EXISTING opted-out contact gets no welcome attempt at all (flyer-leads D5): nothing refused, nothing sent', async () => {
    const { app, world, capture } = makeWebhookHarness();
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

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(world.sent).toHaveLength(0);
    // Not refused - never attempted: only a contact this request created is welcomed.
    expect(capture.lines.some((l) => l['msg'] === 'housing-fair welcome text refused')).toBe(false);
  });

  it('does not fail the public request when the welcome send to a NEW contact is refused (the SMS kill switch)', async () => {
    const { app, world, capture } = makeWebhookHarness({ env: { SMS_SENDING_ENABLED: 'false' } });

    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ phone: '+15550104001' }));

    expect(res.status).toBe(200); // signup still succeeds
    expect(res.body).toEqual({ ok: true });
    expect(world.sent).toHaveLength(0); // refused - no text sent
    expect(world.contacts.find((c) => c.phone === '+15550104001')?.housing_fair_welcomed).toBe(false);
    expect(
      capture.lines.some((l) => l['msg'] === 'housing-fair welcome text refused' && l['code'] === 'sms_sending_disabled'),
    ).toBe(true);
  });
});

describe('POST /public/housing-fair — A2P/CTIA consent gate (server-side)', () => {
  it('rejects a submit MISSING smsConsent with 400 consent_required (no capture, no send)', async () => {
    const { app, world } = makeWebhookHarness({ env: { PUBLIC_RATE_LIMIT_MAX: '100' } });
    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send({ firstName: 'Keisha', lastName: 'Jones', phone: '(555) 010-2000' }); // no smsConsent
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'consent_required' });
    expect(world.contacts).toHaveLength(0);
    expect(world.sent).toHaveLength(0);
  });

  it('rejects smsConsent that is not exactly `true` (false / "true" string) with consent_required', async () => {
    const { app, world } = makeWebhookHarness({ env: { PUBLIC_RATE_LIMIT_MAX: '100' } });
    for (const bad of [false, 'true', 1, null]) {
      const res = await request(app)
        .post(FAIR)
        .set('x-origin-verify', SECRET)
        .send(signupBody({ smsConsent: bad }));
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body).toEqual({ error: 'consent_required' });
    }
    expect(world.contacts).toHaveLength(0);
    expect(world.sent).toHaveLength(0);
  });

  it('on success stamps web_form consent + version on the created contact', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app).post(FAIR).set('x-origin-verify', SECRET).send(signupBody());
    expect(res.status).toBe(200);
    const contact = world.contacts.find((c) => c.phone === '+15550102000');
    expect(contact?.consent_method).toBe('web_form');
    expect(contact?.consent_version).toBe('ctia-2026-06');
    expect(typeof contact?.consent_at).toBe('string');
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

describe('GET /public/units/:unitId/flyer - public fields only', () => {
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
      rent_min: 1400,
      rent_max: 1600,
      payment_standard: 1700,
      deposit: 1400,
      lif: 500,
      // flyer-leads D1 (2026-10-21): the rest of the ten trimmed keys, so the
      // allowlist test below proves a FULLY filled property publishes none.
      lease_terms: 'TRIMMED 12-month minimum',
      accessibility: 'TRIMMED ground floor',
      pets: 'TRIMMED cats ok',
      no_pets: true,
      pet_fee: 'TRIMMED $300',
      deposit_one_month: true,
      deposit_flexible: true,
      // Own-namespace keys (review F2: only `unit-media/<thisUnit>/` presigns).
      media: ['unit-media/unit-1/photo1', 'unit-media/unit-1/photo2'],
      listing_link: 'https://example.com/listing/1',
      tour_process: 'SECRET lockbox 9999',
      application_process: 'SECRET portal',
      primary_contact: 'contact-ll-agent',
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

    // The public set is present and correct (voucher_size falls back to beds:
    // the fixture records no voucher size).
    // unit-photos: media is now the RESOLVED same-origin URL list (each stored
    // key becomes its stable /unit-media path), not a raw key pass-through.
    expect(flyer).toMatchObject({
      unitId: 'unit-1',
      beds: 2,
      baths: 1,
      area: 'Westside',
      voucher_size: 2,
      voucher_sizes: [2],
      // SYNTHESIZED from the fixture's legacy `jurisdiction: 'DCA'` (spec section
      // 8): the flyer now publishes the accepted-authorities list, and on a legacy
      // unit that list IS the old jurisdiction value - deliberate, so the public
      // "Accepts:" line is not blank for every pre-feature unit.
      accepted_authorities: ['DCA'],
      listing_link: 'https://example.com/listing/1',
    });
    expect(flyer.media).toEqual(['/unit-media/unit-1/photo1', '/unit-media/unit-1/photo2']);
    // The flyer now carries the FULL public payload upfront (no reveal tier)
    // plus contact_number - the main 1:1 business number from config.
    expect(flyer.contact_number).toBe(OUR_NUMBER);

    // The flyer shape carries the public allowlist + media + contact_number and
    // NOTHING beyond it. flyer-leads D1 (2026-10-21): rent, lease terms,
    // accessibility, pets and deposit are staff only again - absent, never null.
    expect(Object.keys(flyer).sort()).toEqual(
      [
        'accepted_authorities',
        'area',
        'baths',
        'beds',
        'listing_link',
        'media',
        'unitId',
        'voucher_size',
        'voucher_sizes',
        'address',
        'utilities',
        'video_url',
        'application_fee',
        'same_day_rta',
        // spec 2026-10-20 D11 (subzone left, D3)
        'washer_dryer',
        'contact_number',
      ].sort(),
    );
    for (const trimmed of [
      'rent_min',
      'rent_max',
      'lease_terms',
      'accessibility',
      'pets',
      'no_pets',
      'pet_fee',
      'deposit',
      'deposit_one_month',
      'deposit_flexible',
    ]) {
      expect(trimmed in flyer, trimmed).toBe(false);
    }

    // INTERNAL fields must never appear in the response (the address is public,
    // so it is in the exact-keys assertion above, where the D1 keys are
    // asserted absent too).
    const serialized = JSON.stringify(res.body);
    for (const secret of [
      'tour_process',
      'application_process',
      'primary_contact',
      'landlordId',
      'contact-ll-secret',
      'payment_standard',
      'lif',
      'SECRET',
      // spec 2026-10-20 D3: subzone is staff only - neither the key nor the value ships
      'subzone',
      'Zone 4',
      // flyer-leads D1: no trimmed text value ships either
      'TRIMMED',
    ]) {
      expect(serialized, secret).not.toContain(secret);
    }
  });

  it('states the RECORDED voucher size, not the bedroom count; the internal key stays off', async () => {
    // The 2026-10-12 prod report: a property with its own voucher size showed
    // the bedroom count on its public flyer.
    const { app, world } = makeWebhookHarness();
    seedFullUnit(world, { beds: 2, voucher_size_accepted: 3 });

    const res = await request(app).get('/public/units/unit-1/flyer').set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    expect(res.body.flyer.voucher_size).toBe(3);
    expect(res.body.flyer.voucher_sizes).toEqual([3]);
    expect(res.body.flyer.beds).toBe(2);
    expect(JSON.stringify(res.body)).not.toContain('voucher_size_accepted');
  });

  it('review F2: a foreign media key never reaches the PUBLIC flyer (omitted, no URL)', async () => {
    // The private bucket is shared with the MMS namespaces; `media` stays
    // PATCH-writable. A foreign entry (an uploads/ MMS attachment or another
    // unit's key) must be OMITTED from the public flyer's resolved url list -
    // never given a display URL on an unauthenticated page.
    const { app, world } = makeWebhookHarness();
    seedFullUnit(world, {
      media: [
        'unit-media/unit-1/own-photo',
        'uploads/private-mms-attachment',
        'unit-media/unit-OTHER/their-photo',
      ],
    });
    const res = await request(app).get('/public/units/unit-1/flyer').set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    const media: string[] = res.body.flyer.media;
    expect(media).toHaveLength(1);
    expect(media[0]).toBe('/unit-media/unit-1/own-photo');
    expect(JSON.stringify(res.body)).not.toContain('private-mms-attachment');
    expect(JSON.stringify(res.body)).not.toContain('unit-OTHER');
  });

  it('404s a missing unit and a setup unit - no existence oracle', async () => {
    const { app, world } = makeWebhookHarness();
    seedFullUnit(world, { status: 'setup' });

    const missing = await request(app)
      .get('/public/units/nope/flyer')
      .set('x-origin-verify', SECRET);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found', contact_number: OUR_NUMBER });

    const setupRes = await request(app)
      .get('/public/units/unit-1/flyer')
      .set('x-origin-verify', SECRET);
    expect(setupRes.status).toBe(404);
    expect(setupRes.body).toEqual({ error: 'not_found', contact_number: OUR_NUMBER });
  });

  it('404s a soft-deleted unit even while its status is still public - no existence oracle', async () => {
    const { app, world } = makeWebhookHarness();
    // status stays 'available' so the ONLY thing hiding it is the deleted_at
    // stamp — proves the soft-delete guard, not the status gate.
    seedFullUnit(world, { deleted_at: '2026-06-30T00:00:00.000Z' });

    const res = await request(app)
      .get('/public/units/unit-1/flyer')
      .set('x-origin-verify', SECRET);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', contact_number: OUR_NUMBER });
  });

  // permanent-flyer-links D2 / D3 / D3a (spec 2026-10-27): the flyer serves
  // every FLYER_PUBLIC status, and a served flyer "renders exactly as an
  // Available one" (D3) - so its payload is the Available payload, but for the
  // outside listing link, which ships only while the home is Available (D3a).
  // Each row seeds a unit with EVERY public field recorded and pins three
  // things about the response body:
  //   - its keys: exactly { flyer }, and the flyer's key set is
  //     PUBLIC_FLYER_KEYS in every status (code review R1 C-2);
  //   - no status word: the stored status value appears nowhere in it and,
  //     off Available, neither that value nor its staff label appears in any
  //     case;
  //   - its values: the whole body is { flyer: AVAILABLE_FLYER } - the
  //     Available payload, written out - with listing_link null off
  //     Available, so a fact blanked, cut short or changed off Available fails
  //     too, not only a key (code review R2-3).
  // One harness per status: a bare harness allows 5 /public requests a minute.
  describe('every public status (permanent-flyer-links D2)', () => {
    // The served payload's whole key set, sorted - the same keys as the
    // allowlist test above. It catches a key added or dropped off Available;
    // the values are AVAILABLE_FLYER's to pin.
    const PUBLIC_FLYER_KEYS = [
      'accepted_authorities',
      'address',
      'application_fee',
      'area',
      'baths',
      'beds',
      'contact_number',
      'listing_link',
      'media',
      'same_day_rta',
      'unitId',
      'utilities',
      'video_url',
      'voucher_size',
      'voucher_sizes',
      'washer_dryer',
    ].sort();

    // The public fields seedFullUnit leaves unset - an unset one reads null in
    // every status, so blanking it off Available would not show - plus STORED
    // two-item lists for the authorities and the voucher sizes, so a list cut
    // short shows too (seedFullUnit has only the one-item fallbacks: the
    // legacy jurisdiction and beds).
    const RECORDED_FACTS: Partial<UnitItem> = {
      utilities: 'Electric and gas',
      video_url: 'https://example.com/tour/1',
      application_fee: 50,
      same_day_rta: true,
      washer_dryer: 'hookups',
      voucher_size_accepted: [1, 2],
      accepted_authorities: ['Atlanta Housing Authority', 'DCA'],
    };

    // The served flyer for that unit while it is Available, written out in
    // PUBLIC_FLYER_KEYS order. A literal, not toUnitFlyer(seed), so the code
    // under test is not its own oracle. Every other row must serve it value
    // for value, listing_link aside.
    const AVAILABLE_FLYER = {
      accepted_authorities: ['Atlanta Housing Authority', 'DCA'],
      address: { line1: '123 Private St', city: 'Atlanta', state: 'GA', zip: '30303' },
      application_fee: 50,
      area: 'Westside',
      baths: 1,
      beds: 2,
      contact_number: OUR_NUMBER,
      listing_link: 'https://example.com/listing/1',
      media: ['/unit-media/unit-1/photo1', '/unit-media/unit-1/photo2'],
      same_day_rta: true,
      unitId: 'unit-1',
      utilities: 'Electric and gas',
      video_url: 'https://example.com/tour/1',
      voucher_size: 1,
      voucher_sizes: [1, 2],
      washer_dryer: 'hookups',
    };

    it.each(['available', 'under_application', 'finalizing', 'occupied', 'on_hold', 'off_market'] as const)(
      'status %s: 200, the Available payload value for value but for the listing link (null off Available), no status word',
      async (status) => {
        const { app, world } = makeWebhookHarness();
        seedFullUnit(world, { ...RECORDED_FACTS, status });

        const res = await request(app).get('/public/units/unit-1/flyer').set('x-origin-verify', SECRET);
        expect(res.status).toBe(200);
        expect(Object.keys(res.body)).toEqual(['flyer']);
        expect(Object.keys(res.body.flyer).sort()).toEqual(PUBLIC_FLYER_KEYS);
        expect(res.body.flyer).not.toHaveProperty('status');
        // Not under any other key either: the stored value appears nowhere.
        expect(JSON.stringify(res.body)).not.toContain(status);
        // Off Available, neither the stored value nor its staff label shows in
        // any case: a label folded into another key's value names the status too.
        if (status !== 'available') {
          const lowered = JSON.stringify(res.body).toLowerCase();
          expect(lowered).not.toContain(status);
          expect(lowered).not.toContain(LISTING_STATUS_LABELS[status].toLowerCase());
        }
        // D3 + D3a: the WHOLE body is the Available one - every value, photos
        // and contact_number included - with the stored link for Available and
        // null (not absent) for the rest.
        expect(res.body).toEqual({
          flyer: { ...AVAILABLE_FLYER, listing_link: status === 'available' ? AVAILABLE_FLYER.listing_link : null },
        });
      },
    );

    it('404s setup, soft-deleted (status occupied), off-list and missing units with ONE identical body', async () => {
      const { app, world } = makeWebhookHarness();
      seedFullUnit(world, { unitId: 'unit-setup', status: 'setup' });
      // Deleted while its status is public: the soft-delete guard alone hides it.
      seedFullUnit(world, { unitId: 'unit-gone', status: 'occupied', deleted_at: '2026-06-30T00:00:00.000Z' });
      // A stored status outside LISTING_STATUSES is not public (spec D1).
      seedFullUnit(world, { unitId: 'unit-offlist', status: 'placed' });

      const bodies: unknown[] = [];
      for (const id of ['unit-setup', 'unit-gone', 'unit-offlist', 'nope']) {
        const res = await request(app).get(`/public/units/${id}/flyer`).set('x-origin-verify', SECRET);
        expect(res.status, id).toBe(404);
        bodies.push(res.body);
      }
      // No existence oracle beyond holding the id: the number is config, not unit data.
      expect(bodies[0]).toEqual({ error: 'not_found', contact_number: OUR_NUMBER });
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
      expect(bodies[3]).toEqual(bodies[0]);
    });
  });
});

describe('POST /public/housing-fair — flyer attribution (optional unitId)', () => {
  it('stamps capture_source:flyer + unit_of_interest for a public unit', async () => {
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

  // permanent-flyer-links D5: a sign-up from the flyer of a home that is no
  // longer Available is credited to it exactly like one from an Available flyer.
  it.each(['occupied', 'on_hold'])(
    'stamps capture_source:flyer + unit_of_interest for a unit in status %s (permanent-flyer-links D5)',
    async (status) => {
      const { app, world } = makeWebhookHarness();
      world.units.set('unit-flyer', { unitId: 'unit-flyer', landlordId: 'll-1', status, beds: 2 });

      const res = await request(app)
        .post(FAIR)
        .set('x-origin-verify', SECRET)
        .send(signupBody({ unitId: 'unit-flyer' }));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      const contact = world.contacts.find((c) => c.phone === '+15550102000');
      expect(contact).toMatchObject({
        capture_source: 'flyer',
        unit_of_interest: 'unit-flyer',
      });
    },
  );

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

  it('falls back to housing_fair when the unit exists but is in Setup', async () => {
    const { app, world } = makeWebhookHarness();
    world.units.set('unit-setup', {
      unitId: 'unit-setup',
      landlordId: 'll-1',
      status: 'setup', // not public (setup)
      beds: 2,
    });

    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ unitId: 'unit-setup' }));
    expect(res.status).toBe(200);

    const contact = world.contacts.find((c) => c.phone === '+15550102000');
    expect(contact?.capture_source).toBe('housing_fair');
    expect(contact?.['unit_of_interest']).toBeUndefined();
  });

  it('falls back to housing_fair when the unit is soft-deleted (even if its status is still public)', async () => {
    const { app, world } = makeWebhookHarness();
    world.units.set('unit-deleted', {
      unitId: 'unit-deleted',
      landlordId: 'll-1',
      status: 'available', // a public status, but...
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

  // permanent-flyer-links D4 (code review R1 A-6): the server half of the
  // fallback's unitId contract. The flyer page's fallback sends the route id
  // only when, trimmed, it is 1 to 200 characters (its own copy of the cap,
  // FlyerPage.tsx MAX_UNIT_ID_LEN), so that its one button can always succeed.
  // The server's cap (public.ts MAX_UNIT_ID_LEN) is checked in
  // parseHousingFairBody AFTER the app-wide body trim (app.ts trimJsonBody).
  // A change to either cap must change both. One request per harness (a bare
  // harness allows 5 /public requests a minute).
  const UNIT_ID_200 = 'u'.repeat(200);

  it.each([
    ['exactly 200 characters', UNIT_ID_200],
    ['200 characters inside surrounding spaces (the body trim)', `  ${UNIT_ID_200}  `],
  ])('accepts a unitId of %s and credits the unit it names (permanent-flyer-links D4)', async (_what, sent) => {
    const { app, world } = makeWebhookHarness();
    world.units.set(UNIT_ID_200, { unitId: UNIT_ID_200, landlordId: 'll-1', status: 'available', beds: 2 });

    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ unitId: sent }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const contact = world.contacts.find((c) => c.phone === '+15550102000');
    expect(contact).toMatchObject({ capture_source: 'flyer', unit_of_interest: UNIT_ID_200 });
  });

  it('refuses a unitId of 201 characters with the generic 400, writing nothing (permanent-flyer-links D4)', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ unitId: 'u'.repeat(201) }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid request' });
    expect(world.contacts).toHaveLength(0);
    expect(world.sent).toHaveLength(0);
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

describe('GET /public/units/:unitId/details - REMOVED (flyer-full-info)', () => {
  it('the details route no longer exists (plain 404 for any id)', async () => {
    const { app, world } = makeWebhookHarness();
    world.units.set('unit-1', {
      unitId: 'unit-1',
      landlordId: 'll-1',
      status: 'available',
    } as UnitItem);
    const res = await request(app)
      .get('/public/units/unit-1/details')
      .set('x-origin-verify', SECRET);
    expect(res.status).toBe(404);
  });
});

describe('GET /public/units/:unitId/flyer - the opaque 404 carries contact_number', () => {
  it('missing, deleted, and setup all return the IDENTICAL body', async () => {
    const { app, world } = makeWebhookHarness();
    world.units.set('unit-setup', {
      unitId: 'unit-setup',
      landlordId: 'll-1',
      status: 'setup',
    } as UnitItem);
    world.units.set('unit-gone', {
      unitId: 'unit-gone',
      landlordId: 'll-1',
      status: 'available',
      deleted_at: 'x',
    } as UnitItem);
    const bodies: unknown[] = [];
    for (const id of ['nope', 'unit-setup', 'unit-gone']) {
      const res = await request(app)
        .get(`/public/units/${id}/flyer`)
        .set('x-origin-verify', SECRET);
      expect(res.status, id).toBe(404);
      bodies.push(res.body);
    }
    // Identical bodies - no existence oracle; the number is config, not unit data.
    expect(bodies[0]).toEqual({ error: 'not_found', contact_number: OUR_NUMBER });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });
});

describe('/public sits behind the origin-secret validator (locked chain stage 2)', () => {
  it('403s without the origin secret (chain intact — public means no requireAuth, not no origin secret)', async () => {
    const { app } = makeWebhookHarness();
    expect((await request(app).post(FAIR).send(signupBody())).status).toBe(403);
  });
});

// unit-photos: the flyer renders the unit's photos via stable same-origin
// /unit-media URLs (design 2026-07-21), inheriting the whole-flyer public gate
// (FLYER_PUBLIC: every status but setup - permanent-flyer-links D2).
describe('GET /public/units/:unitId/flyer - photo resolution + E1 gate', () => {
  function seedShareable(world: ReturnType<typeof createFakeWorld>, overrides: Partial<UnitItem> = {}) {
    const unit: UnitItem = {
      unitId: 'unit-photo',
      landlordId: 'contact-ll-1',
      status: 'available',
      media: ['unit-media/unit-photo/k1', 'unit-media/unit-photo/k2'],
      ...overrides,
    };
    world.units.set(unit.unitId, unit);
    return unit;
  }

  it('an AVAILABLE unit exposes its photos as same-origin URLs (stored keys resolved)', async () => {
    const { app, world } = makeWebhookHarness();
    seedShareable(world);
    const res = await request(app).get('/public/units/unit-photo/flyer').set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    // Each entry is the stable same-origin /unit-media path (the S3 key with a
    // leading slash), not a presigned URL.
    expect(res.body.flyer.media).toEqual([
      '/unit-media/unit-photo/k1',
      '/unit-media/unit-photo/k2',
    ]);
  });

  it('E1: flipping the SAME unit to on_hold still serves the whole flyer, photos included (permanent-flyer-links D2)', async () => {
    const { app, world } = makeWebhookHarness();
    seedShareable(world);
    const before = await request(app).get('/public/units/unit-photo/flyer').set('x-origin-verify', SECRET);
    expect(before.status).toBe(200);
    expect(before.body.flyer.media).toEqual(['/unit-media/unit-photo/k1', '/unit-media/unit-photo/k2']);

    seedShareable(world, { status: 'on_hold' });
    const after = await request(app).get('/public/units/unit-photo/flyer').set('x-origin-verify', SECRET);
    expect(after.status).toBe(200);
    expect(after.body.flyer.media).toEqual(before.body.flyer.media);
  });

  it('E1: flipping the SAME unit to setup 404s the WHOLE flyer with the opaque body (permanent-flyer-links D2)', async () => {
    const { app, world } = makeWebhookHarness();
    seedShareable(world);
    const before = await request(app).get('/public/units/unit-photo/flyer').set('x-origin-verify', SECRET);
    expect(before.status).toBe(200);

    seedShareable(world, { status: 'setup' });
    const after = await request(app).get('/public/units/unit-photo/flyer').set('x-origin-verify', SECRET);
    expect(after.status).toBe(404);
    expect(after.body).toEqual({ error: 'not_found', contact_number: OUR_NUMBER });
  });

  it('resolves own-namespace keys to relative URLs even with NO media store; legacy URLs pass through (E2/E4)', async () => {
    const { app, world } = makeWebhookHarness({ withoutMediaStore: true });
    seedShareable(world, {
      media: ['unit-media/unit-photo/stored', 'https://legacy.example/p.jpg'],
    });
    // Same-origin reads are STORE-INDEPENDENT (design 2026-07-21): the
    // own-namespace key still resolves to its stable /unit-media path even with
    // no media store (it may 404 at the serve route - the same visible outcome
    // as the old url-absent degradation, an absent image); the legacy URL passes
    // through - the flyer still renders, never 500s.
    const res = await request(app).get('/public/units/unit-photo/flyer').set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    expect(res.body.flyer.media).toEqual([
      '/unit-media/unit-photo/stored',
      'https://legacy.example/p.jpg',
    ]);
  });
});

// ---------------------------------------------------------------------------
// join-housing-authority D1/D2: GET /public/housing-authorities through the
// FULL app - its mount ahead of the shared /public limiter, the origin-secret
// chain, the generic 500, and the two independent limits.
// ---------------------------------------------------------------------------

const LIST = '/public/housing-authorities';

describe('GET /public/housing-authorities - the public list read (D1)', () => {
  /** The starting list's housing authority names in D1 order. */
  const STARTING_AUTHORITY_NAMES = [
    'Atlanta Housing Authority',
    'Augusta Housing Authority',
    'College Park Housing Authority',
    'Decatur Housing Authority',
    'DeKalb County Housing Authority',
    'East Point Housing Authority',
    'Fulton County Housing Authority',
    'Georgia Department of Community Affairs',
    'Georgia Housing Voucher Program (DBHDD)',
    'Jonesboro Housing Authority',
    'Macon-Bibb County Housing Authority',
    'Marietta Housing Authority',
  ];

  function listEntry(kind: OrgKind, name: string): OrgEntry {
    return {
      orgId: `org-${name}`,
      kind,
      name,
      spellings: [`${name} spelling`],
      notes: 'internal note',
      createdAt: '2026-10-12T00:00:00.000Z',
      createdBy: 'test',
      updatedAt: '2026-10-12T00:00:00.000Z',
      updatedBy: 'test',
    };
  }

  it('serves the starting list from memory on an empty store: authority names only, sorted, no-store, nothing written', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app).get(LIST).set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ names: STARTING_AUTHORITY_NAMES });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await world.orgListRepo.peek()).toBeNull();
  });

  it('serves the STORED list: housing_authority names only, case-insensitive order, no ids/spellings/notes/agencies', async () => {
    const { app, world } = makeWebhookHarness();
    await world.orgListRepo.putForSeed({
      settingId: 'org-list',
      version: 7,
      entries: [
        listEntry('housing_authority', 'zeta Housing Authority'),
        listEntry('agency', 'Alpha Agency'),
        listEntry('housing_authority', 'Banana Housing Authority'),
        listEntry('housing_authority', 'apple Housing Authority'),
      ],
    });
    const get = vi.spyOn(world.orgListRepo, 'get');
    const mutate = vi.spyOn(world.orgListRepo, 'mutate');
    const putForSeed = vi.spyOn(world.orgListRepo, 'putForSeed');

    const res = await request(app).get(LIST).set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      names: ['apple Housing Authority', 'Banana Housing Authority', 'zeta Housing Authority'],
    });
    const serialized = JSON.stringify(res.body);
    for (const leaked of ['org-', 'spelling', 'internal note', 'Alpha Agency', 'createdBy']) {
      expect(serialized, leaked).not.toContain(leaked);
    }
    expect(get).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(putForSeed).not.toHaveBeenCalled();
  });

  it('a list read failure is the generic 500', async () => {
    const { app, world } = makeWebhookHarness();
    vi.spyOn(world.orgListRepo, 'peek').mockRejectedValue(new Error('settings table unavailable'));
    const res = await request(app).get(LIST).set('x-origin-verify', SECRET);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal server error' });
  });

  it('sits behind the origin-secret validator like every /public route', async () => {
    const { app } = makeWebhookHarness();
    expect((await request(app).get(LIST)).status).toBe(403);
  });
});

describe('GET /public/housing-authorities - its own limit, independent of the shared /public limit (D2)', () => {
  it('stays readable after the shared /public limit is exhausted, and does not touch that window', async () => {
    const { app } = makeWebhookHarness({
      env: { PUBLIC_RATE_LIMIT_MAX: '2', PUBLIC_RATE_LIMIT_WINDOW_MS: '60000' },
    });
    const bad = { firstName: 'A', lastName: 'B' }; // 400 at the handler
    expect((await request(app).post(FAIR).set('x-origin-verify', SECRET).send(bad)).status).toBe(400);
    expect((await request(app).post(FAIR).set('x-origin-verify', SECRET).send(bad)).status).toBe(400);
    expect((await request(app).post(FAIR).set('x-origin-verify', SECRET).send(bad)).status).toBe(429);

    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).get(LIST).set('x-origin-verify', SECRET);
      expect(res.status, `list read ${i + 1}`).toBe(200);
    }
    // The shared window is still exhausted: the list reads neither reset nor used it.
    expect((await request(app).post(FAIR).set('x-origin-verify', SECRET).send(bad)).status).toBe(429);
  });

  it('allows 60 reads per minute per IP, refuses the 61st, and never consumes or is blocked by the shared limit', async () => {
    const { app } = makeWebhookHarness({
      env: { PUBLIC_RATE_LIMIT_MAX: '2', PUBLIC_RATE_LIMIT_WINDOW_MS: '60000' },
    });
    for (let i = 0; i < 60; i += 1) {
      const res = await request(app).get(LIST).set('x-origin-verify', SECRET);
      expect(res.status, `list read ${i + 1}`).toBe(200);
    }
    const limited = await request(app).get(LIST).set('x-origin-verify', SECRET);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
    expect(limited.headers['retry-after']).toBeDefined();

    // The shared limit still has BOTH of its 2 slots: 61 list reads consumed
    // none, and the exhausted list limit does not block the other routes.
    const bad = { firstName: 'A', lastName: 'B' };
    expect((await request(app).post(FAIR).set('x-origin-verify', SECRET).send(bad)).status).toBe(400);
    expect((await request(app).post(FAIR).set('x-origin-verify', SECRET).send(bad)).status).toBe(400);
    expect((await request(app).post(FAIR).set('x-origin-verify', SECRET).send(bad)).status).toBe(429);
  });

  it('(PIN) another method on the list path falls through to the shared /public mount and its limiter', async () => {
    const { app } = makeWebhookHarness({
      env: { PUBLIC_RATE_LIMIT_MAX: '1', PUBLIC_RATE_LIMIT_WINDOW_MS: '60000' },
    });
    // Not the list route: it passes the shared limiter (its single slot) and matches nothing.
    const post = await request(app).post(LIST).set('x-origin-verify', SECRET).send({});
    expect(post.status).toBe(404);
    // Proof it went through the shared limiter: the flyer route is now limited.
    const flyer = await request(app).get('/public/units/nope/flyer').set('x-origin-verify', SECRET);
    expect(flyer.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// join-housing-authority D3-D7: the sign-up's housingAuthority.
// ---------------------------------------------------------------------------

describe('POST /public/housing-fair - housingAuthority shape and the flyer refusal (D3, D4)', () => {
  function harness() {
    return makeWebhookHarness({ env: { PUBLIC_RATE_LIMIT_MAX: '100' } });
  }

  it('refuses a non-string, an empty, a blank and an over-long housingAuthority with the generic 400, writing nothing', async () => {
    const { app, world } = harness();
    for (const bad of [
      42,
      true,
      ['Atlanta Housing Authority'],
      { name: 'Atlanta Housing Authority' },
      '',
      '   ', // trimmed to '' by the body trim
      'A'.repeat(121), // ORG_NAME_MAX is 120
    ]) {
      const res = await request(app)
        .post(FAIR)
        .set('x-origin-verify', SECRET)
        .send(signupBody({ housingAuthority: bad }));
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body, JSON.stringify(bad)).toEqual({ error: 'invalid request' });
    }
    expect(world.contacts).toHaveLength(0);
    expect(world.conversations.size).toBe(0);
    expect(world.sent).toHaveLength(0);
    expect(world.auditEvents).toHaveLength(0);
  });

  it('refuses unitId + housingAuthority with the generic 400 whatever the unit is, without reading the unit', async () => {
    const { app, world } = harness();
    world.units.set('unit-flyer', { unitId: 'unit-flyer', landlordId: 'll-1', status: 'available', beds: 2 });
    world.units.set('unit-setup', { unitId: 'unit-setup', landlordId: 'll-1', status: 'setup', beds: 2 });
    const getById = vi.spyOn(world.unitsRepo, 'getById');
    const bodies: unknown[] = [];
    for (const unitId of ['unit-flyer', 'no-such-unit', 'unit-setup']) {
      const res = await request(app)
        .post(FAIR)
        .set('x-origin-verify', SECRET)
        .send(signupBody({ unitId, housingAuthority: 'Atlanta Housing Authority' }));
      expect(res.status, unitId).toBe(400);
      bodies.push(res.body);
    }
    // Identical for a public, a missing and a setup unit: no oracle.
    expect(bodies).toEqual([
      { error: 'invalid request' },
      { error: 'invalid request' },
      { error: 'invalid request' },
    ]);
    expect(world.contacts).toHaveLength(0);
    expect(world.conversations.size).toBe(0);
    expect(world.sent).toHaveLength(0);
    expect(getById).not.toHaveBeenCalled();
  });
});

describe('POST /public/housing-fair - the housing authority must be on the list (D3)', () => {
  function harness() {
    return makeWebhookHarness({ env: { PUBLIC_RATE_LIMIT_MAX: '100' } });
  }

  function orgEntry(kind: OrgKind, name: string): OrgEntry {
    return {
      orgId: `org-${name}`,
      kind,
      name,
      spellings: [],
      createdAt: '2026-10-12T00:00:00.000Z',
      createdBy: 'test',
      updatedAt: '2026-10-12T00:00:00.000Z',
      updatedBy: 'test',
    };
  }

  it('refuses an unlisted name, a spelling, another case and an agency name with housing_authority_not_listed, writing nothing', async () => {
    const { app, world } = harness();
    for (const value of [
      'Springfield Housing Authority', // not on the list
      'AHA', // a spelling of Atlanta Housing Authority
      'atlanta housing authority', // the name in another case
      'Step Up', // an agency, not a housing authority
      'A'.repeat(120), // the longest shape accepted, still not a name
    ]) {
      const res = await request(app)
        .post(FAIR)
        .set('x-origin-verify', SECRET)
        .send(signupBody({ housingAuthority: value }));
      expect(res.status, value).toBe(400);
      expect(res.body, value).toEqual({ error: 'housing_authority_not_listed' });
    }
    expect(world.contacts).toHaveLength(0);
    expect(world.conversations.size).toBe(0);
    expect(world.sent).toHaveLength(0);
    expect(world.auditEvents).toHaveLength(0);
    // The check read the list without creating it.
    expect(await world.orgListRepo.peek()).toBeNull();
  });

  it('refuses an unlisted name for an EXISTING phone too, before any write (no thread, no welcome, no audit, no change)', async () => {
    const { app, world } = harness();
    world.contacts.push({
      contactId: 'c-existing',
      type: 'tenant',
      status: 'searching',
      phone: '+15550102000',
      firstName: 'Keisha',
      lastName: 'Jones',
      housing_fair_welcomed: false,
    } as ContactItem);
    const before = structuredClone(world.contacts[0]);

    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: 'Springfield Housing Authority' }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'housing_authority_not_listed' });
    expect(world.contacts).toEqual([before]);
    expect(world.conversations.size).toBe(0);
    expect(world.sent).toHaveLength(0);
    expect(world.auditEvents).toHaveLength(0);
  });

  it('checks against the STORED list when there is one (a renamed authority is no longer listed)', async () => {
    const { app, world } = harness();
    await world.orgListRepo.putForSeed({
      settingId: 'org-list',
      version: 4,
      entries: [
        orgEntry('housing_authority', 'Housing Authority of the City of Atlanta'),
        orgEntry('agency', 'Step Up'),
      ],
    });

    const stale = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: 'Atlanta Housing Authority' }));
    expect(stale.status).toBe(400);
    expect(stale.body).toEqual({ error: 'housing_authority_not_listed' });
    expect(world.contacts).toHaveLength(0);

    const current = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: 'Housing Authority of the City of Atlanta' }));
    expect(current.status).toBe(200);
    expect(current.body).toEqual({ ok: true });
    expect(world.contacts).toHaveLength(1);
  });

  it('accepts a listed name, reading the list once with peek() and never creating the item', async () => {
    const { app, world } = harness();
    const peek = vi.spyOn(world.orgListRepo, 'peek');
    const get = vi.spyOn(world.orgListRepo, 'get');
    const mutate = vi.spyOn(world.orgListRepo, 'mutate');
    const putForSeed = vi.spyOn(world.orgListRepo, 'putForSeed');

    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: 'Atlanta Housing Authority' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(peek).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(putForSeed).not.toHaveBeenCalled();
    peek.mockRestore();
    expect(await world.orgListRepo.peek()).toBeNull();
  });

  it('a list read failure is the generic 500 and nothing is written', async () => {
    const { app, world } = harness();
    vi.spyOn(world.orgListRepo, 'peek').mockRejectedValue(new Error('settings table unavailable'));
    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: 'Atlanta Housing Authority' }));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal server error' });
    expect(world.contacts).toHaveLength(0);
    expect(world.conversations.size).toBe(0);
    expect(world.sent).toHaveLength(0);
  });

  it('(PIN) reads no list when no housingAuthority is sent (absent or null)', async () => {
    const { app, world } = harness();
    const peekWithoutAuthority = vi.spyOn(world.orgListRepo, 'peek');
    const absent = await request(app).post(FAIR).set('x-origin-verify', SECRET).send(signupBody());
    const nulled = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ phone: '(555) 010-2001', housingAuthority: null }));
    expect(absent.status).toBe(200);
    expect(nulled.status).toBe(200);
    expect(peekWithoutAuthority).not.toHaveBeenCalled();
  });
});

describe('POST /public/housing-fair - new contacts start Onboarding with the marker; existing ones are untouched (D5, D6)', () => {
  function harness() {
    return makeWebhookHarness({ env: { PUBLIC_RATE_LIMIT_MAX: '100' } });
  }

  it('a /join sign-up with a listed authority creates an onboarding tenant holding it and the marker', async () => {
    const { app, world } = harness();
    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: 'DeKalb County Housing Authority' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const contact = world.contacts.find((c) => c.phone === '+15550102000');
    expect(contact).toMatchObject({
      type: 'tenant',
      status: 'onboarding',
      housingAuthority: 'DeKalb County Housing Authority',
      housing_fair_signup_v2: true,
      capture_source: 'housing_fair',
      consent_method: 'web_form',
      consent_version: 'ctia-2026-06',
    });
    expect(contact?.['unit_of_interest']).toBeUndefined();
    // The welcome text is unchanged.
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]?.body).toBe(WELCOME_TEXT_TEMPLATE.replace('{firstName}', 'Keisha'));
  });

  it('a /join sign-up with no authority (absent or null) creates an onboarding tenant with the marker and no authority', async () => {
    const { app, world } = harness();
    await request(app).post(FAIR).set('x-origin-verify', SECRET).send(signupBody());
    await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ phone: '(555) 010-2001', housingAuthority: null }));
    for (const phone of ['+15550102000', '+15550102001']) {
      const contact = world.contacts.find((c) => c.phone === phone);
      expect(contact, phone).toMatchObject({
        type: 'tenant',
        status: 'onboarding',
        housing_fair_signup_v2: true,
        capture_source: 'housing_fair',
      });
      expect(Object.keys(contact ?? {}), phone).not.toContain('housingAuthority');
    }
  });

  it('a null unitId is no unitId: the authority is kept and the contact starts onboarding', async () => {
    const { app, world } = harness();
    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ unitId: null, housingAuthority: 'Atlanta Housing Authority' }));
    expect(res.status).toBe(200);
    expect(world.contacts.find((c) => c.phone === '+15550102000')).toMatchObject({
      status: 'onboarding',
      housingAuthority: 'Atlanta Housing Authority',
      housing_fair_signup_v2: true,
      capture_source: 'housing_fair',
    });
  });

  it('padded text is trimmed by the body trim and accepted as the listed name it becomes', async () => {
    const { app, world } = harness();
    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: '   Atlanta Housing Authority  ' }));
    expect(res.status).toBe(200);
    expect(world.contacts.find((c) => c.phone === '+15550102000')?.housingAuthority).toBe(
      'Atlanta Housing Authority',
    );
  });

  it('a flyer sign-up for a public unit behaves as today (needs_review, flyer, no authority) plus the marker', async () => {
    const { app, world } = harness();
    world.units.set('unit-flyer', { unitId: 'unit-flyer', landlordId: 'll-1', status: 'available', beds: 2 });
    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ unitId: 'unit-flyer' }));
    expect(res.status).toBe(200);
    const contact = world.contacts.find((c) => c.phone === '+15550102000');
    expect(contact).toMatchObject({
      type: 'tenant',
      status: 'needs_review',
      capture_source: 'flyer',
      unit_of_interest: 'unit-flyer',
      housing_fair_signup_v2: true,
    });
    expect(Object.keys(contact ?? {})).not.toContain('housingAuthority');
    expect(world.sent).toHaveLength(1);
  });

  it('a flyer sign-up for a missing or setup unit keeps needs_review and housing_fair, plus the marker', async () => {
    const { app, world } = harness();
    world.units.set('unit-setup', { unitId: 'unit-setup', landlordId: 'll-1', status: 'setup', beds: 2 });
    await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ unitId: 'no-such-unit' }));
    await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ phone: '(555) 010-2001', unitId: 'unit-setup' }));
    for (const phone of ['+15550102000', '+15550102001']) {
      const contact = world.contacts.find((c) => c.phone === phone);
      expect(contact, phone).toMatchObject({
        type: 'tenant',
        status: 'needs_review',
        capture_source: 'housing_fair',
        housing_fair_signup_v2: true,
      });
      expect(contact?.['unit_of_interest'], phone).toBeUndefined();
      expect(Object.keys(contact ?? {}), phone).not.toContain('housingAuthority');
    }
  });

  it('a flyer unitId with housingAuthority null is a plain flyer sign-up (needs_review, no authority)', async () => {
    const { app, world } = harness();
    world.units.set('unit-flyer', { unitId: 'unit-flyer', landlordId: 'll-1', status: 'available', beds: 2 });
    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ unitId: 'unit-flyer', housingAuthority: null }));
    expect(res.status).toBe(200);
    const contact = world.contacts.find((c) => c.phone === '+15550102000');
    expect(contact).toMatchObject({ status: 'needs_review', capture_source: 'flyer', housing_fair_signup_v2: true });
    expect(Object.keys(contact ?? {})).not.toContain('housingAuthority');
  });

  it('(PIN) an existing phone with a valid authority gets no authority, status or marker write (already welcomed: nothing changes)', async () => {
    const { app, world } = harness();
    world.contacts.push({
      contactId: 'c-existing',
      type: 'tenant',
      status: 'searching',
      phone: '+15550102000',
      firstName: 'Keisha',
      lastName: 'Jones',
      housingAuthority: 'Decatur Housing Authority',
      capture_source: 'housing_fair',
      housing_fair_welcomed: true,
    } as ContactItem);
    const welcomed = structuredClone(world.contacts[0]);

    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: 'Atlanta Housing Authority' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(world.contacts).toEqual([welcomed]);
    expect(world.sent).toHaveLength(0);
  });

  it('an existing phone never welcomed is NOT welcomed now (flyer-leads D5), and nothing is written to it', async () => {
    const { app, world } = harness();
    world.contacts.push({
      contactId: 'c-existing',
      type: 'tenant',
      status: 'needs_review',
      phone: '+15550102000',
      firstName: 'Keisha',
      lastName: 'Jones',
      capture_source: 'housing_fair',
      housing_fair_welcomed: false,
    } as ContactItem);
    const neverWelcomed = structuredClone(world.contacts[0]);

    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: 'Atlanta Housing Authority' }));
    expect(res.status).toBe(200);
    expect(world.sent).toHaveLength(0);
    expect(world.contacts).toEqual([neverWelcomed]);
  });
});

describe('POST /public/housing-fair - audit and log (D7)', () => {
  function harness() {
    return makeWebhookHarness({ env: { PUBLIC_RATE_LIMIT_MAX: '100' } });
  }

  it('a new /join contact with an authority: the audit records signupVersion 2 and the name; the log carries withAuthority only', async () => {
    const { app, world, capture } = harness();
    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: 'Atlanta Housing Authority' }));
    expect(res.status).toBe(200);
    const contact = world.contacts.find((c) => c.phone === '+15550102000');

    expect(world.auditEvents.filter((e) => e.event_type === 'housing_fair_signup')).toEqual([
      {
        entityKey: `contacts#${contact?.contactId}`,
        event_type: 'housing_fair_signup',
        payload: {
          marker: expect.any(String),
          isNew: true,
          welcomeSent: true,
          viaFlyer: false,
          signupVersion: 2,
          housingAuthority: 'Atlanta Housing Authority',
          // flyer-leads D6: a new /join contact - its pin written, no flyer entry.
          existingContact: false,
          deletedContact: false,
          recorded: true,
          sentRecorded: false,
          sentSkipped: 'not_flyer',
          consentVersion: 'ctia-2026-06',
        },
      },
    ]);

    const lines = capture.lines.filter((l) => l['msg'] === 'housing-fair signup captured');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ isNew: true, welcomeSent: true, viaFlyer: false, withAuthority: true });
    expect(JSON.stringify(lines[0])).not.toContain('Atlanta Housing Authority');
  });

  it('no authority (absent or null): housingAuthority null in the audit, withAuthority false in the log', async () => {
    const { app, world, capture } = harness();
    await request(app).post(FAIR).set('x-origin-verify', SECRET).send(signupBody());
    await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ phone: '(555) 010-2001', housingAuthority: null }));

    const payloads = world.auditEvents
      .filter((e) => e.event_type === 'housing_fair_signup')
      .map((e) => e.payload);
    // flyer-leads D6: two new /join contacts - each pin written, no flyer entry.
    const joinFields = {
      existingContact: false,
      deletedContact: false,
      recorded: true,
      sentRecorded: false,
      sentSkipped: 'not_flyer',
      consentVersion: 'ctia-2026-06',
    };
    expect(payloads).toEqual([
      {
        marker: expect.any(String),
        isNew: true,
        welcomeSent: true,
        viaFlyer: false,
        signupVersion: 2,
        housingAuthority: null,
        ...joinFields,
      },
      {
        marker: expect.any(String),
        isNew: true,
        welcomeSent: true,
        viaFlyer: false,
        signupVersion: 2,
        housingAuthority: null,
        ...joinFields,
      },
    ]);
    const lines = capture.lines.filter((l) => l['msg'] === 'housing-fair signup captured');
    expect(lines.map((l) => l['withAuthority'])).toEqual([false, false]);
  });

  it('a flyer sign-up: viaFlyer true, signupVersion 2, housingAuthority null', async () => {
    const { app, world, capture } = harness();
    world.units.set('unit-flyer', { unitId: 'unit-flyer', landlordId: 'll-1', status: 'available', beds: 2 });
    await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ unitId: 'unit-flyer' }));
    expect(world.auditEvents.filter((e) => e.event_type === 'housing_fair_signup').map((e) => e.payload)).toEqual([
      {
        marker: expect.any(String),
        isNew: true,
        welcomeSent: true,
        viaFlyer: true,
        signupVersion: 2,
        housingAuthority: null,
        // flyer-leads D6/D7: a new tenant on a public flyer - pin and flyer entry written.
        existingContact: false,
        deletedContact: false,
        recorded: true,
        sentRecorded: true,
        consentVersion: 'ctia-2026-06',
      },
    ]);
    const lines = capture.lines.filter((l) => l['msg'] === 'housing-fair signup captured');
    expect(lines[0]).toMatchObject({ viaFlyer: true, withAuthority: false });
  });

  it('an existing phone: the audit records the answer it was sent, though nothing is written to the contact', async () => {
    const { app, world, capture } = harness();
    world.contacts.push({
      contactId: 'c-existing',
      type: 'tenant',
      status: 'searching',
      phone: '+15550102000',
      firstName: 'Keisha',
      lastName: 'Jones',
      housing_fair_welcomed: true,
    } as ContactItem);

    const res = await request(app)
      .post(FAIR)
      .set('x-origin-verify', SECRET)
      .send(signupBody({ housingAuthority: 'Atlanta Housing Authority' }));
    expect(res.status).toBe(200);
    expect(world.contacts[0]?.housingAuthority).toBeUndefined();
    expect(world.auditEvents.filter((e) => e.event_type === 'housing_fair_signup')).toEqual([
      {
        entityKey: 'contacts#c-existing',
        event_type: 'housing_fair_signup',
        payload: {
          marker: expect.any(String),
          isNew: false,
          welcomeSent: false,
          viaFlyer: false,
          signupVersion: 2,
          housingAuthority: 'Atlanta Housing Authority',
          // flyer-leads D6: an existing contact - never welcomed, its pin written, no flyer entry.
          existingContact: true,
          deletedContact: false,
          recorded: true,
          sentRecorded: false,
          sentSkipped: 'not_flyer',
          consentVersion: 'ctia-2026-06',
        },
      },
    ]);
    const lines = capture.lines.filter((l) => l['msg'] === 'housing-fair signup captured');
    expect(lines[0]).toMatchObject({ isNew: false, withAuthority: true });
  });
});
