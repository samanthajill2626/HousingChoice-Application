// M1.4 unit tests: the founder-settings routes —
//   GET /api/settings   (requireAuth — VAs may view)
//   PUT /api/settings   (requireRole('admin') — only admins edit)
// against the in-memory settings repo in the harness. Asserts defaults, the
// admin-only PUT gate, validation, the field-level merge, and the
// settings_updated audit event.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { FOUNDER_MISSED_CALL_AUTOTEXT, WELCOME_SMS } from '../src/lib/smsCompliance.js';
import {
  createSettingsRepo,
  DEFAULT_ORG_SETTINGS,
  GROUP_CROSSCHECK_SWEEP_LAST_RUN_AT_ID,
  JOURNAL_SWEEP_LAST_RUN_AT_ID,
  JOURNAL_SWEEP_SCAN_CURSOR_ID,
} from '../src/repos/settingsRepo.js';
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
    // FOUNDER DECISION 2026-08-18: the default missed-call auto-text is now the
    // founder wording and deliberately carries NO opt-out line. Engineering
    // advised against it; attribution is on FOUNDER_MISSED_CALL_AUTOTEXT in
    // lib/smsCompliance.ts. This is THE value that actually reaches a caller -
    // the catalog default for missed_call.autotext is unreachable, because
    // missedCallAutoText is a required string and always wins as an override.
    expect(res.body.settings.missedCallAutoText).toBe(FOUNDER_MISSED_CALL_AUTOTEXT);
    expect(res.body.settings.missedCallAutoText).not.toMatch(/Reply STOP/);
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

describe('/api/settings - the env-sourced business number', () => {
  it('GET returns it ALONGSIDE the settings (never inside them - it is not patchable)', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE); // a VA cookie
    expect(res.status).toBe(200);
    expect(res.body.businessPhoneNumber).toBe('+15550009999');
    expect(res.body.settings.businessPhoneNumber).toBeUndefined();
  });

  it('PUT returns it too (the dashboard re-sets its state from the save response)', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ quietHoursEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body.businessPhoneNumber).toBe('+15550009999');
  });

  it('is env-sourced and NOT patchable: a body carrying it changes nothing', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ businessPhoneNumber: '+15550001111' });
    expect(res.status).toBe(200);
    // The response still carries the ENV value, and nothing was stored.
    expect(res.body.businessPhoneNumber).toBe('+15550009999');
    expect(res.body.settings.businessPhoneNumber).toBeUndefined();
  });

  it('is OMITTED (never null) when the env has no business number', async () => {
    const { app } = makeWebhookHarness({ env: { BUSINESS_PHONE_NUMBER: undefined } });
    const res = await request(app)
      .get('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect('businessPhoneNumber' in res.body).toBe(false);
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

  it('400s missing_opt_out_language when welcomeText drops opt-out copy (A2P floor)', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ welcomeText: 'Hi there - no way to opt out here.' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'missing_opt_out_language' });
    // Nothing was written (the floor rejects BEFORE the repo).
    expect(world.settings.welcomeText).toBeUndefined();
  });

  // FOUNDER DECISION 2026-08-18: the opt-out gate was lifted for the missed-call
  // auto-text ONLY, which is what lets the founder's wording be saved at all.
  // welcomeText above still enforces it - the asymmetry is deliberate, so this
  // pins both halves and fails if someone "tidies" them back into one check.
  it('ACCEPTS a missedCallAutoText with no opt-out copy (gate lifted for this field only)', async () => {
    const { app, world } = makeWebhookHarness();
    const body = 'Hey, this is Sam. Sorry I missed your call! Text me your name and voucher size?';
    const res = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ missedCallAutoText: body });
    expect(res.status).toBe(200);
    expect(res.body.settings.missedCallAutoText).toBe(body);
    expect(world.settings.missedCallAutoText).toBe(body);
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

// --- Repo-level cadence + cursor records for the abandoned-journal sweep
// (log-hygiene spec section 9). SCOPE NOTE: the file header above scopes this
// file to the founder-settings ROUTES; like the defensive-projection block
// directly above, everything below is repo-level and runs against the REAL
// createSettingsRepo through a fake document client - the usersRepo.test.ts
// precedent, no Docker and no DynamoDB Local.
//
// The fake is STATEFUL and models claimGroupPeriod's ConditionExpression, so
// "the new cadence id claims independently of the four group ids" is proved
// against the repo rather than against a hand-written repo fake (the
// groupGuardrails.test.ts / devGroupGuardrailTicks.test.ts settings fakes never
// construct createSettingsRepo, so they cannot carry this claim).
interface StatefulSettingsDoc {
  doc: DynamoDBDocumentClient;
  items: Map<string, Record<string, unknown>>;
  updates: UpdateCommand[];
}

/** Resolve a `#alias` through ExpressionAttributeNames (a literal passes through). */
function resolveAttrName(raw: string, names: Record<string, string>): string {
  return raw.startsWith('#') ? (names[raw] ?? raw) : raw;
}

function statefulSettingsDoc(): StatefulSettingsDoc {
  const items = new Map<string, Record<string, unknown>>();
  const updates: UpdateCommand[] = [];
  const doc = {
    send: async (cmd: unknown) => {
      if (cmd instanceof GetCommand) {
        const { settingId } = cmd.input.Key as { settingId: string };
        const item = items.get(settingId);
        return { Item: item === undefined ? undefined : { ...item } };
      }
      if (cmd instanceof UpdateCommand) {
        updates.push(cmd);
        const { settingId } = cmd.input.Key as { settingId: string };
        const item = items.get(settingId) ?? { settingId };
        const names = cmd.input.ExpressionAttributeNames ?? {};
        const values = (cmd.input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
        const condition = cmd.input.ConditionExpression;
        if (condition === 'attribute_not_exists(recorded_at) OR recorded_at <= :notBefore') {
          const stored = item['recorded_at'];
          if (typeof stored === 'string' && stored > (values[':notBefore'] as string)) {
            throw new ConditionalCheckFailedException({ message: 'claimed', $metadata: {} });
          }
        } else if (condition !== undefined) {
          throw new Error(`fake settings doc: unhandled condition ${condition}`);
        }
        const expression = cmd.input.UpdateExpression ?? '';
        const set = /^SET (\S+) = (:\w+)$/.exec(expression);
        const remove = /^REMOVE (\S+)$/.exec(expression);
        if (set !== null) {
          item[resolveAttrName(set[1]!, names)] = values[set[2]!];
        } else if (remove !== null) {
          delete item[resolveAttrName(remove[1]!, names)];
        } else {
          throw new Error(`fake settings doc: unhandled update ${expression}`);
        }
        items.set(settingId, item);
        return {};
      }
      throw new Error('fake settings doc: unexpected command');
    },
  } as unknown as DynamoDBDocumentClient;
  return { doc, items, updates };
}

describe('settingsRepo.claimGroupPeriod - the journal-sweep cadence id', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('claims independently of the four group cadence ids (one record per duty)', async () => {
    const { doc } = statefulSettingsDoc();
    const repo = createSettingsRepo({ doc });
    const at = '2026-08-25T09:00:00.000Z';
    const notBefore = new Date(Date.parse(at) - DAY_MS).toISOString();

    // A group duty claiming its own period must not consume the sweep's.
    expect(await repo.claimGroupPeriod(GROUP_CROSSCHECK_SWEEP_LAST_RUN_AT_ID, at, notBefore)).toBe(
      true,
    );
    expect(await repo.claimGroupPeriod(JOURNAL_SWEEP_LAST_RUN_AT_ID, at, notBefore)).toBe(true);

    // ... and the sweep's own second claim inside the same day is refused,
    // which is the whole cadence gate.
    const later = '2026-08-25T09:00:30.000Z';
    expect(
      await repo.claimGroupPeriod(
        JOURNAL_SWEEP_LAST_RUN_AT_ID,
        later,
        new Date(Date.parse(later) - DAY_MS).toISOString(),
      ),
    ).toBe(false);
  });

  it('a forced claim (notBefore = now) bypasses the gate, as the __dev tick needs', async () => {
    const { doc } = statefulSettingsDoc();
    const repo = createSettingsRepo({ doc });
    const at = '2026-08-25T09:00:00.000Z';
    expect(
      await repo.claimGroupPeriod(JOURNAL_SWEEP_LAST_RUN_AT_ID, at, new Date(Date.parse(at) - DAY_MS).toISOString()),
    ).toBe(true);
    const forced = '2026-08-25T09:00:01.000Z';
    expect(await repo.claimGroupPeriod(JOURNAL_SWEEP_LAST_RUN_AT_ID, forced, forced)).toBe(true);
  });

  it('sends the SAME conditional write for the new id as for the group ids', async () => {
    const { doc, updates } = statefulSettingsDoc();
    const repo = createSettingsRepo({ doc });
    await repo.claimGroupPeriod(
      JOURNAL_SWEEP_LAST_RUN_AT_ID,
      '2026-08-25T09:00:00.000Z',
      '2026-08-24T09:00:00.000Z',
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]!.input).toMatchObject({
      Key: { settingId: 'journal_sweep_last_run_at' },
      UpdateExpression: 'SET recorded_at = :at',
      ConditionExpression: 'attribute_not_exists(recorded_at) OR recorded_at <= :notBefore',
      ExpressionAttributeValues: {
        ':at': '2026-08-25T09:00:00.000Z',
        ':notBefore': '2026-08-24T09:00:00.000Z',
      },
    });
  });
});

describe('settingsRepo - the journal-sweep Scan cursor', () => {
  it('reads undefined before any run has stored one (a fresh stack scans from the top)', async () => {
    const { doc } = statefulSettingsDoc();
    expect(await createSettingsRepo({ doc }).getJournalSweepCursor()).toBeUndefined();
  });

  it('round-trips a cursor on its OWN record, never on the cadence record', async () => {
    const { doc, items } = statefulSettingsDoc();
    const repo = createSettingsRepo({ doc });
    const cursor = JSON.stringify({ itemId: 'resolve#contact-9#pets' });

    await repo.claimGroupPeriod(
      JOURNAL_SWEEP_LAST_RUN_AT_ID,
      '2026-08-25T09:00:00.000Z',
      '2026-08-24T09:00:00.000Z',
    );
    await repo.putJournalSweepCursor(cursor);

    expect(await repo.getJournalSweepCursor()).toBe(cursor);
    // Two separate settings rows: a cadence stamp can never clobber the cursor.
    expect(items.get(JOURNAL_SWEEP_SCAN_CURSOR_ID)?.['cursor']).toBe(cursor);
    expect(items.get(JOURNAL_SWEEP_LAST_RUN_AT_ID)?.['cursor']).toBeUndefined();
  });

  it('putJournalSweepCursor(undefined) CLEARS the stored cursor (a run that exhausted the table)', async () => {
    const { doc } = statefulSettingsDoc();
    const repo = createSettingsRepo({ doc });
    await repo.putJournalSweepCursor(JSON.stringify({ itemId: 'resolve#contact-1#pets' }));
    await repo.putJournalSweepCursor(undefined);
    expect(await repo.getJournalSweepCursor()).toBeUndefined();
  });

  it('clearing an absent cursor is a no-op, not a throw (the common exhausted case)', async () => {
    const { doc } = statefulSettingsDoc();
    const repo = createSettingsRepo({ doc });
    await expect(repo.putJournalSweepCursor(undefined)).resolves.toBeUndefined();
    expect(await repo.getJournalSweepCursor()).toBeUndefined();
  });
});
