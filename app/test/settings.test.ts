// M1.4 unit tests: the founder-settings routes —
//   GET /api/settings   (requireAuth — VAs may view)
//   PUT /api/settings   (requireRole('admin') — only admins edit)
// against the in-memory settings repo in the harness. Asserts defaults, the
// admin-only PUT gate, validation, the field-level merge, and the
// settings_updated audit event.
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { WELCOME_SMS } from '../src/lib/smsCompliance.js';
import { createSettingsRepo, DEFAULT_ORG_SETTINGS } from '../src/repos/settingsRepo.js';
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
    // A2P/CTIA (spec §5): the default first-contact template carries brand
    // identity + opt-out language (the compliant DEFAULT_MISSED_CALL_AUTOTEXT).
    expect(res.body.settings.missedCallAutoText).toContain('Tenant Place LLC');
    expect(res.body.settings.missedCallAutoText).toMatch(/Reply STOP to opt out\./);
    // The read-only built-in welcome body rides ALONGSIDE the settings (never
    // inside them — it's not patchable) so the UI can show what "blank" sends.
    expect(res.body.welcomeTextDefault).toBe(WELCOME_SMS);
    expect(res.body.settings.welcomeTextDefault).toBeUndefined();
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
      .send({ missedCallAutoText: 'New auto-text. Reply STOP to opt out.', missedCallAutoTextEnabled: false });

    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({
      missedCallAutoText: 'New auto-text. Reply STOP to opt out.',
      missedCallAutoTextEnabled: false,
      // quickReplies untouched (field-level merge).
      quickReplies: DEFAULT_ORG_SETTINGS.quickReplies,
    });
    expect(world.settings.missedCallAutoText).toBe('New auto-text. Reply STOP to opt out.');

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
    // First-contact template: MUST keep opt-out language (A2P/CTIA floor).
    const custom = 'Hi {firstName}, welcome from the HousingChoice team! Reply STOP to opt out.';
    const put = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ welcomeText: custom });
    expect(put.status).toBe(200);
    expect(put.body.settings.welcomeText).toBe(custom);
    // The default still rides alongside (an override doesn't hide what blank sends).
    expect(put.body.welcomeTextDefault).toBe(WELCOME_SMS);
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

  it('accepts the shortest-compliant and max-length (320) first-contact templates', async () => {
    const { app, world } = makeWebhookHarness();
    // The A2P/CTIA floor requires opt-out language, so the smallest accepted
    // welcomeText carries "STOP"; the max stays the 320-char boundary (with STOP).
    const prefix = 'Reply STOP to opt out. ';
    for (const v of ['Reply STOP to opt out.', `${prefix}${'x'.repeat(320 - prefix.length)}`]) {
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

  it('400s missing_opt_out_language when a first-contact template drops opt-out copy (A2P floor)', async () => {
    const { app, world } = makeWebhookHarness();
    for (const field of ['welcomeText', 'missedCallAutoText'] as const) {
      const res = await request(app)
        .put('/api/settings')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_ADMIN_COOKIE)
        .send({ [field]: 'Hi there — no way to opt out here.' });
      expect(res.status, field).toBe(400);
      expect(res.body).toEqual({ error: 'missing_opt_out_language' });
    }
    // Nothing was written (the floor rejects BEFORE the repo).
    expect(world.settings.welcomeText).toBeUndefined();
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
    const custom = 'Hi {firstName}, custom welcome! Reply STOP to opt out.';

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

// --- Quiet hours (spec 2026-08-03 section 3): the automated-send quiet window
// and the org timezone live on the SAME OrgSettings singleton. GET projects the
// defaults; PUT validates HH:MM / IANA shape and rejects a MERGED zero-length
// window (start === end) - "off" is expressed with quietHoursEnabled: false. ---
describe('GET /api/settings - quiet hours defaults', () => {
  it('a fresh stack projects the quiet-hours defaults (21:00-08:00 America/New_York, enabled)', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE); // a VA cookie
    expect(res.status).toBe(200);
    expect(res.body.settings.quietHoursEnabled).toBe(true);
    expect(res.body.settings.quietHoursStart).toBe('21:00');
    expect(res.body.settings.quietHoursEnd).toBe('08:00');
    expect(res.body.settings.timezone).toBe('America/New_York');
  });
});

describe('PUT /api/settings - quiet hours (admin only)', () => {
  it('an admin can disable quiet hours; the change is echoed, persisted and audited', async () => {
    const { app, world } = makeWebhookHarness();
    const put = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ quietHoursEnabled: false });
    expect(put.status).toBe(200);
    expect(put.body.settings.quietHoursEnabled).toBe(false);
    expect(world.settings.quietHoursEnabled).toBe(false);
    // The window itself is untouched (field-level merge).
    expect(world.settings.quietHoursStart).toBe('21:00');

    const audit = world.auditEvents.find((e) => e.event_type === 'settings_updated');
    expect(audit?.entityKey).toBe('settings#org');
    expect(audit?.payload).toMatchObject({ fields: ['quietHoursEnabled'] });
  });

  it('an admin can move the window and set the org timezone; the GET projects them', async () => {
    const { app, world } = makeWebhookHarness();
    const put = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ quietHoursStart: '22:00', quietHoursEnd: '07:30', timezone: 'America/Chicago' });
    expect(put.status).toBe(200);
    expect(put.body.settings).toMatchObject({
      quietHoursStart: '22:00',
      quietHoursEnd: '07:30',
      timezone: 'America/Chicago',
    });
    expect(world.settings.quietHoursStart).toBe('22:00');
    expect(world.settings.quietHoursEnd).toBe('07:30');
    expect(world.settings.timezone).toBe('America/Chicago');

    // It rides the GET projection too (VA may view).
    const get = await request(app)
      .get('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(get.status).toBe(200);
    expect(get.body.settings.quietHoursStart).toBe('22:00');
    expect(get.body.settings.quietHoursEnd).toBe('07:30');
    expect(get.body.settings.timezone).toBe('America/Chicago');
  });

  it('the HH:MM boundary values 00:00 and 23:59 are accepted', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ quietHoursStart: '23:59', quietHoursEnd: '00:00' });
    expect(res.status).toBe(200);
    expect(world.settings.quietHoursStart).toBe('23:59');
    expect(world.settings.quietHoursEnd).toBe('00:00');
  });

  it('400s malformed quiet-hours values', async () => {
    const { app, world } = makeWebhookHarness();
    const bad = [
      { quietHoursStart: '9:00' }, // not HH:MM (no leading zero)
      { quietHoursStart: '24:00' }, // hour out of range
      { quietHoursEnd: 800 }, // not a string
      { quietHoursEnabled: 'yes' }, // not a boolean
      { timezone: 'Not/AZone' }, // not resolvable by Intl
      { timezone: '' }, // empty
    ];
    for (const body of bad) {
      const res = await request(app)
        .put('/api/settings')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_ADMIN_COOKIE)
        .send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    // Nothing was written (validation rejects BEFORE the repo).
    expect(world.settings.quietHoursStart).toBe('21:00');
    expect(world.settings.quietHoursEnd).toBe('08:00');
    expect(world.settings.quietHoursEnabled).toBe(true);
    expect(world.settings.timezone).toBe('America/New_York');
  });

  it("400s quiet_hours_zero_length when the MERGED window has start === end", async () => {
    const { app, world } = makeWebhookHarness();
    // The stored end is the default '08:00', so this ONE-field patch would
    // silently create a zero-length window - the check merges over the STORED
    // settings precisely so it cannot sneak through.
    const res = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ quietHoursStart: '08:00' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'quiet_hours_zero_length' });
    // Nothing was written.
    expect(world.settings.quietHoursStart).toBe('21:00');
  });

  it('400s quiet_hours_zero_length when BOTH fields arrive equal in one patch', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ quietHoursStart: '09:00', quietHoursEnd: '09:00' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'quiet_hours_zero_length' });
    expect(world.settings.quietHoursStart).toBe('21:00');
    expect(world.settings.quietHoursEnd).toBe('08:00');
  });

  it('a one-field window patch that does NOT collide with the stored value is accepted', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ quietHoursStart: '20:00' }); // stored end is '08:00' - no collision
    expect(res.status).toBe(200);
    expect(world.settings.quietHoursStart).toBe('20:00');
    expect(world.settings.quietHoursEnd).toBe('08:00');
  });

  it('a VA is forbidden (403) from changing quiet hours - the gate is unchanged', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE) // VA
      .send({ quietHoursEnabled: false });
    expect(res.status).toBe(403);
    expect(world.settings.quietHoursEnabled).toBe(true); // unchanged
  });
});

// --- Repo-level defensive projection. `toOrgSettings` is an inner function of
// createSettingsRepo (not exported), so it is exercised THROUGH getOrgSettings()
// with a fake document client - the usersRepo.test.ts precedent, no Docker or
// DynamoDB Local needed. A malformed stored value must never reach a caller:
// quiet hours drive send timing, so a garbage window has to read as the safe
// default rather than disabling the gate. ---
function fakeDocReturning(item: Record<string, unknown> | undefined): DynamoDBDocumentClient {
  return {
    send: async () => ({ Item: item }),
  } as unknown as DynamoDBDocumentClient;
}

describe('settingsRepo.getOrgSettings - defensive quiet-hours projection', () => {
  it('malformed stored quiet-hours values project the DEFAULTS', async () => {
    const repo = createSettingsRepo({
      doc: fakeDocReturning({
        settingId: 'org',
        quietHoursEnabled: 'yes', // not a boolean
        quietHoursStart: 'garbage', // not HH:MM
        quietHoursEnd: '25:00', // hour out of range
        timezone: 'Not/AZone', // not a resolvable IANA id
      }),
    });
    const s = await repo.getOrgSettings();
    expect(s.quietHoursEnabled).toBe(true);
    expect(s.quietHoursStart).toBe('21:00');
    expect(s.quietHoursEnd).toBe('08:00');
    expect(s.timezone).toBe('America/New_York');
  });

  it('a stored item predating the feature (no quiet-hours attributes) reads as the defaults', async () => {
    const repo = createSettingsRepo({
      doc: fakeDocReturning({ settingId: 'org', preRingPauseSeconds: 5 }),
    });
    const s = await repo.getOrgSettings();
    expect(s).toMatchObject({
      preRingPauseSeconds: 5, // the pre-existing attribute still projects
      quietHoursEnabled: DEFAULT_ORG_SETTINGS.quietHoursEnabled,
      quietHoursStart: DEFAULT_ORG_SETTINGS.quietHoursStart,
      quietHoursEnd: DEFAULT_ORG_SETTINGS.quietHoursEnd,
      timezone: DEFAULT_ORG_SETTINGS.timezone,
    });
  });

  it('valid stored quiet-hours values are projected as stored', async () => {
    const repo = createSettingsRepo({
      doc: fakeDocReturning({
        settingId: 'org',
        quietHoursEnabled: false,
        quietHoursStart: '22:30',
        quietHoursEnd: '06:15',
        timezone: 'America/Chicago',
      }),
    });
    const s = await repo.getOrgSettings();
    expect(s).toMatchObject({
      quietHoursEnabled: false,
      quietHoursStart: '22:30',
      quietHoursEnd: '06:15',
      timezone: 'America/Chicago',
    });
  });
});
