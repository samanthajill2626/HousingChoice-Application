// Voicemail greeting routes (spec 2026-09-26 sections 4.3-4.5). Task 2 owns the
// parsePatch pin; Task 4 adds the upload/remove/serve cases below it.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { TEST_ADMIN_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

const GREETING = {
  s3Key: 'settings/voicemail-greeting',
  contentType: 'audio/mpeg',
  fileName: 'sam.mp3',
  sizeBytes: 427,
  uploadedAt: '2026-09-26T12:00:00.000Z',
  uploadedByUserId: 'user-0001',
  uploadedByEmail: 'founder@example.com',
} as const;

describe('PUT /api/settings ignores voicemailGreeting (only the greeting routes write it)', () => {
  it('a body carrying it changes nothing', async () => {
    const { app, world } = makeWebhookHarness();
    const res = await request(app)
      .put('/api/settings')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ voicemailGreeting: GREETING, missedCallAutoTextEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body.settings.voicemailGreeting).toBeUndefined();
    expect(world.settings.voicemailGreeting).toBeUndefined();
    expect(world.settings.missedCallAutoTextEnabled).toBe(false);
  });
});
