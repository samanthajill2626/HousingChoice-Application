// M1.4 unit tests: the founder-settings routes —
//   GET /api/settings   (requireAuth — VAs may view)
//   PUT /api/settings   (requireRole('admin') — only admins edit)
// against the in-memory settings repo in the harness. Asserts defaults, the
// admin-only PUT gate, validation, the field-level merge, and the
// settings_updated audit event.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ORG_SETTINGS } from '../src/repos/settingsRepo.js';
import { TEST_ADMIN_COOKIE, TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

const SECRET = ORIGIN_SECRET;

describe('GET /api/settings', () => {
  it('returns the CO2 defaults on a fresh stack (VA may view)', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE); // a VA cookie
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual(DEFAULT_ORG_SETTINGS);
    expect(res.body.settings.missedCallAutoTextEnabled).toBe(true);
    expect(res.body.settings.quickReplies).toEqual(['Please text me', "I'll call you back soon"]);
  });

  it('401s without a session', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app).get('/api/settings').set('x-origin-verify', SECRET);
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/settings — admin only', () => {
  it('a VA is forbidden (403)', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE) // VA
      .send({ missedCallAutoTextEnabled: false });
    expect(res.status).toBe(403);
  });

  it('an admin can edit; the patch merges field-level and the change is audited', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ missedCallAutoText: 'New auto-text', missedCallAutoTextEnabled: false });

    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({
      missedCallAutoText: 'New auto-text',
      missedCallAutoTextEnabled: false,
      // quickReplies untouched (field-level merge).
      quickReplies: DEFAULT_ORG_SETTINGS.quickReplies,
    });
    expect(world.settings.missedCallAutoText).toBe('New auto-text');

    const audit = world.auditEvents.find((e) => e.event_type === 'settings_updated');
    expect(audit).toBeDefined();
    expect(audit?.entityKey).toBe('settings#org');
    expect(audit?.payload).toMatchObject({
      fields: ['missedCallAutoText', 'missedCallAutoTextEnabled'],
    });
    // Actor stamped (the admin).
    expect(audit?.payload?.['actor']).toBe('usr_testadmin000000000000000');
  });

  it('admin can replace quickReplies wholesale', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ quickReplies: ['Call me', 'Text me'] });
    expect(res.status).toBe(200);
    expect(world.settings.quickReplies).toEqual(['Call me', 'Text me']);
  });

  it('admin can set preRingPauseSeconds (a valid integer in range); GET returns it', async () => {
    const { app, world } = makeWebhookHarness();
    const put = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ preRingPauseSeconds: 4 });
    expect(put.status).toBe(200);
    expect(put.body.settings.preRingPauseSeconds).toBe(4);
    expect(world.settings.preRingPauseSeconds).toBe(4);

    // It rides the GET projection too (VA may view).
    const get = await request(app)
      .get('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(get.status).toBe(200);
    expect(get.body.settings.preRingPauseSeconds).toBe(4);
  });

  it('the boundary values 0 and 10 are accepted', async () => {
    const { app } = makeWebhookHarness();
    for (const v of [0, 10]) {
      const res = await request(app)
        .put('/api/settings')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_ADMIN_COOKIE)
        .send({ preRingPauseSeconds: v });
      expect(res.status, String(v)).toBe(200);
      expect(res.body.settings.preRingPauseSeconds).toBe(v);
    }
  });

  it('400s validation failures', async () => {
    const { app } = makeWebhookHarness();
    const bad = [
      { missedCallAutoText: '' }, // empty
      { missedCallAutoText: 'x'.repeat(321) }, // too long
      { missedCallAutoTextEnabled: 'yes' }, // not boolean
      { quickReplies: 'a string' }, // not array
      { quickReplies: ['ok', ''] }, // empty element
      { quickReplies: Array.from({ length: 11 }, (_v, i) => `r${i}`) }, // too many
      { preRingPauseSeconds: 2.5 }, // non-integer
      { preRingPauseSeconds: -1 }, // below range
      { preRingPauseSeconds: 11 }, // above range
      { preRingPauseSeconds: '3' }, // not a number
    ];
    for (const body of bad) {
      const res = await request(app)
        .put('/api/settings')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_ADMIN_COOKIE)
        .send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

// --- welcomeText (Settings surface, §4): the housing-fair welcome SMS body,
// editable in-app. Validated 1..320 chars; admin-only PUT (the existing gate);
// VAs may VIEW it on GET. ---
describe('PUT /api/settings — welcomeText (admin only)', () => {
  it('an admin can set welcomeText; it persists, rides the GET, and is audited', async () => {
    const { app, world } = makeWebhookHarness();
    const custom = 'Hi {firstName}, welcome from the HousingChoice team!';
    const put = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ welcomeText: custom });
    expect(put.status).toBe(200);
    expect(put.body.settings.welcomeText).toBe(custom);
    expect(world.settings.welcomeText).toBe(custom);

    // The audit event lists welcomeText among the changed fields.
    const audit = world.auditEvents.find((e) => e.event_type === 'settings_updated');
    expect(audit?.payload).toMatchObject({ fields: ['welcomeText'] });

    // GET projects it (a VA may view the welcome copy).
    const get = await request(app)
      .get('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE); // VA
    expect(get.status).toBe(200);
    expect(get.body.settings.welcomeText).toBe(custom);
  });

  it('accepts the boundary lengths 1 and 320', async () => {
    const { app, world } = makeWebhookHarness();
    for (const v of ['a', 'x'.repeat(320)]) {
      const res = await request(app)
        .put('/api/settings')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_ADMIN_COOKIE)
        .send({ welcomeText: v });
      expect(res.status, String(v.length)).toBe(200);
      expect(res.body.settings.welcomeText).toBe(v);
      expect(world.settings.welcomeText).toBe(v);
    }
  });

  it('400s an empty string, an over-320-char string, and a non-string (but NOT null — that CLEARS)', async () => {
    const { app } = makeWebhookHarness();
    // null is an explicit CLEAR (its own test below), so it is NOT in this list.
    for (const v of ['', 'x'.repeat(321), 123, true, ['hi']]) {
      const res = await request(app)
        .put('/api/settings')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_ADMIN_COOKIE)
        .send({ welcomeText: v });
      expect(res.status, JSON.stringify(v)).toBe(400);
    }
  });

  it('an admin can CLEAR welcomeText with null — the attribute is removed and a welcome falls back to the default', async () => {
    const { app, world } = makeWebhookHarness();
    const custom = 'Hi {firstName}, custom welcome!';

    // First set a custom welcomeText...
    const set = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ welcomeText: custom });
    expect(set.status).toBe(200);
    expect(world.settings.welcomeText).toBe(custom);

    // ...then CLEAR it with an explicit null.
    const cleared = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ welcomeText: null });
    expect(cleared.status).toBe(200);
    // The attribute is gone — neither the PUT response nor a GET projects it.
    expect(cleared.body.settings.welcomeText).toBeUndefined();
    expect(world.settings.welcomeText).toBeUndefined();

    const get = await request(app)
      .get('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE); // VA
    expect(get.status).toBe(200);
    expect(get.body.settings.welcomeText).toBeUndefined();

    // The clear is audited as a welcomeText change too.
    const audit = world.auditEvents.filter((e) => e.event_type === 'settings_updated');
    expect(audit.at(-1)?.payload).toMatchObject({ fields: ['welcomeText'] });
  });

  it('a VA is still forbidden (403) from setting welcomeText — the gate is unchanged', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE) // VA
      .send({ welcomeText: 'Hi {firstName}!' });
    expect(res.status).toBe(403);
    expect(world.settings.welcomeText).toBeUndefined(); // unchanged
  });
});
