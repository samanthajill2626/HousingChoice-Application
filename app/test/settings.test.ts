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

  it('400s validation failures', async () => {
    const { app } = makeWebhookHarness();
    const bad = [
      { missedCallAutoText: '' }, // empty
      { missedCallAutoText: 'x'.repeat(321) }, // too long
      { missedCallAutoTextEnabled: 'yes' }, // not boolean
      { quickReplies: 'a string' }, // not array
      { quickReplies: ['ok', ''] }, // empty element
      { quickReplies: Array.from({ length: 11 }, (_v, i) => `r${i}`) }, // too many
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
