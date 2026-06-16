// Inbound MMS media — mirror to S3 (1:1 AND relay) + the authed serving
// endpoint GET /api/messages/:providerSid/media/:idx the dashboard <img> hits.
//
// Covered:
//  - 1:1 inbound MMS mirrors to S3 + records media_attachments (refactor regression)
//  - RELAY inbound MMS now ALSO captures + mirrors media (the new behavior — the
//    relay path previously dropped media entirely)
//  - the serving endpoint streams the stored bytes with the stored content-type,
//    is AUTH-ONLY (PII), and 404s/400s on the missing/invalid cases
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
  dispatchJob,
} from '../src/jobs/jobs.js';
import { registerRelayFanOutJobHandler } from '../src/jobs/relayFanOut.js';
import { createLogger } from '../src/lib/logger.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  signedTwilioPost,
  ORIGIN_SECRET,
  OUR_NUMBER,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';

const POOL = '+15550109000';
const ALICE = '+15550100001';
const BOB = '+15550100002';
const CALLER = '+15550177777';

/** Inbound 1:1 MMS to a business number (one image attachment by default). */
function inboundMmsParams(over: Record<string, string> = {}): Record<string, string> {
  return {
    MessageSid: 'SMmms0001',
    AccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    From: CALLER,
    To: OUR_NUMBER,
    Body: 'here is the doc',
    NumMedia: '1',
    MediaUrl0: 'https://api.twilio.com/media/abc0',
    MediaContentType0: 'image/jpeg',
    SmsStatus: 'received',
    ApiVersion: '2010-04-01',
    ...over,
  };
}

function seedRelay(world: FakeWorld, overrides: Partial<ConversationItem> = {}): ConversationItem {
  const now = new Date().toISOString();
  const conv: ConversationItem = {
    conversationId: 'conv-relay-mms',
    participant_phone: POOL,
    pool_number: POOL,
    status: 'open',
    last_activity_at: now,
    type: 'relay_group',
    ai_mode: 'manual',
    participants: [
      { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
      { contactId: 'c-bob', phone: BOB, name: 'Bob' },
    ],
    created_at: now,
    ...overrides,
  };
  world.conversations.set(conv.conversationId, conv);
  return conv;
}

beforeEach(() => {
  _resetForTests();
  configureJobsLogger(createLogger({ level: 'info', destination: createLogCapture().stream }));
  configureScheduler(new InMemorySchedulerAdapter());
  configureOutboundQueue(new InProcessOutboundQueueAdapter({ dispatch: dispatchJob }));
});
afterEach(() => {
  _resetForTests();
});

describe('inbound MMS media mirroring', () => {
  it('1:1 inbound MMS mirrors to S3 and records media_attachments', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, '/webhooks/twilio/sms', inboundMmsParams());

    // Mirrored to S3 under media/<conversationId>/<MessageSid>/<i> with the type.
    expect(world.mediaPuts).toHaveLength(1);
    expect(world.mediaPuts[0]!.key).toMatch(/\/SMmms0001\/0$/);
    expect(world.mediaPuts[0]!.contentType).toBe('image/jpeg');
    // The key is recorded on the message + it's typed mms.
    const msg = [...world.messages.values()].find((m) => m.provider_sid === 'SMmms0001');
    expect(msg?.type).toBe('mms');
    expect(msg?.media_attachments).toEqual([
      { s3Key: world.mediaPuts[0]!.key, contentType: 'image/jpeg' },
    ]);
  });

  it('normalizes a dangerous sender Content-Type to octet-stream AT STORE time', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    // The MMS sender controls MediaContentType — a malicious text/html must NOT
    // be persisted as the object's type (defense-in-depth with the serve-time
    // allowlist).
    await signedTwilioPost(app, '/webhooks/twilio/sms', inboundMmsParams({ MediaContentType0: 'text/html' }));

    expect(world.mediaPuts).toHaveLength(1);
    expect(world.mediaPuts[0]!.contentType).toBe('application/octet-stream');
  });

  it('RELAY inbound MMS now captures + mirrors media (previously dropped)', async () => {
    const world = createFakeWorld();
    registerRelayFanOutJobHandler({
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      logger: createLogger({ level: 'info', destination: createLogCapture().stream }),
    });
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, '/webhooks/twilio/sms', {
      MessageSid: 'SMrelaymms1',
      From: ALICE,
      To: POOL,
      Body: 'photo of the kitchen',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/relay0',
      MediaContentType0: 'image/png',
      ApiVersion: '2010-04-01',
    });

    expect(world.mediaPuts).toHaveLength(1);
    expect(world.mediaPuts[0]!.key).toMatch(/^media\/conv-relay-mms\/SMrelaymms1\/0$/);
    const msg = [...world.messages.values()].find((m) => m.provider_sid === 'SMrelaymms1');
    expect(msg?.type).toBe('mms');
    expect(msg?.media_attachments).toEqual([
      { s3Key: world.mediaPuts[0]!.key, contentType: 'image/png' },
    ]);
  });
});

describe('GET /api/messages/:providerSid/media/:idx (authed)', () => {
  /** Drive a 1:1 inbound MMS so a message + its mirrored media exist. */
  async function seedMms(world: FakeWorld) {
    const { app } = makeWebhookHarness({ world });
    await signedTwilioPost(app, '/webhooks/twilio/sms', inboundMmsParams());
    return app;
  }

  it('streams the mirrored bytes with the stored content-type (authed)', async () => {
    const world = createFakeWorld();
    const app = await seedMms(world);

    const res = await request(app)
      .get('/api/messages/SMmms0001/media/0')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    // Allowlisted image → INLINE (no attachment disposition) so the <img> renders.
    expect(res.headers['content-disposition']).toBeUndefined();
    // Defense headers on every media response.
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect((res.body as Buffer).toString()).toContain('media-bytes-for:');
  });

  it('XSS GUARD: a dangerous stored Content-Type (text/html) is forced to a download', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    // The MMS sender controls MediaContentType — simulate a malicious html type.
    await signedTwilioPost(app, '/webhooks/twilio/sms', inboundMmsParams({ MediaContentType0: 'text/html' }));

    const res = await request(app)
      .get('/api/messages/SMmms0001/media/0')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(200);
    // Never served as text/html (would render + run script same-origin).
    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect(res.headers['content-type']).not.toContain('text/html');
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect(res.headers['content-security-policy']).toContain('sandbox');
  });

  it('XSS GUARD: image/svg+xml (script-capable) is forced to a download, not served inline', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    await signedTwilioPost(app, '/webhooks/twilio/sms', inboundMmsParams({ MediaContentType0: 'image/svg+xml' }));

    const res = await request(app)
      .get('/api/messages/SMmms0001/media/0')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect(res.headers['content-type']).not.toContain('svg');
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
  });

  it('GUARDRAIL: requires auth (no session cookie → 401/403) — MMS media is never public', async () => {
    const world = createFakeWorld();
    const app = await seedMms(world);
    const res = await request(app)
      .get('/api/messages/SMmms0001/media/0')
      .set('x-origin-verify', ORIGIN_SECRET);
    expect([401, 403]).toContain(res.status);
  });

  it('404 for an unknown message', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    const res = await request(app)
      .get('/api/messages/SM-nope/media/0')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('message_not_found');
  });

  it('404 for an out-of-range media index', async () => {
    const world = createFakeWorld();
    const app = await seedMms(world);
    const res = await request(app)
      .get('/api/messages/SMmms0001/media/5')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('media_not_found');
  });

  it('400 for a non-integer media index', async () => {
    const world = createFakeWorld();
    const app = await seedMms(world);
    const res = await request(app)
      .get('/api/messages/SMmms0001/media/abc')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_media_index');
  });
});
