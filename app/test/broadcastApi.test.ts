// Share-broadcast API (M1.8a) — POST /api/broadcasts (draft + estimate),
// /preview, /send (snapshot + enqueue), GET /results + list, AND the
// delivery-status-callback rollup folding delivered/failed into the broadcast
// stats + emitting broadcast.updated. Runs on the shared in-memory world with
// the jobs machinery wired so the broadcast.send enqueue resolves in-process.
// Authed via the real sealed session cookie next to the origin secret.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
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
import { registerBroadcastSendJobHandler } from '../src/jobs/broadcastFanOut.js';
import { loadConfig, DEV_SESSION_SECRET_DEFAULT } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  LIST_PARTITION,
  MAX_BROADCAST_RECIPIENTS,
  type BroadcastItem,
  type BroadcastRecipient,
  type BroadcastStats,
} from '../src/repos/broadcastsRepo.js';
import { buildTsMsgId, type MessageItem } from '../src/repos/messagesRepo.js';
import { SEND_UNCONFIRMED_CODE } from '../src/lib/sendOutcome.js';
import {
  RETRY_OUTCOME_UNCONFIRMED,
  RETRY_PROMISE_WITHDRAWN_AT,
  isRetryPromiseLive,
} from '../src/lib/retrySendWindow.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { SEED } from '../src/lib/seed/lean.js';
import { createSendMessageService } from '../src/services/sendMessage.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  ORIGIN_SECRET,
  PUBLIC_BASE_URL,
  signedTwilioPost,
  statusParams,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';

const STATUS_PATH = '/webhooks/twilio/status';

function seedTenant(world: FakeWorld, overrides: Partial<ContactItem>): ContactItem {
  const c: ContactItem = {
    contactId: `c-${world.contacts.length + 1}`,
    type: 'tenant',
    // A tenant's `status` is its §5 lifecycle (status-model unification — one
    // field). 'searching' is a valid lifecycle value; audience resolution does
    // NOT filter on status (services/audienceResolution.ts), so any value works.
    status: 'searching',
    phone: `+1555010${String(world.contacts.length + 1).padStart(4, '0')}`,
    // A2P/CTIA: a real broadcast audience carries recorded consent; default it so
    // fan-out sends (override to drop it for the no-consent-fence coverage).
    consent_method: 'inbound_text',
    ...overrides,
  };
  world.contacts.push(c);
  return c;
}

function seedUnit(world: FakeWorld): UnitItem {
  const u: UnitItem = {
    unitId: 'unit-1',
    landlordId: 'c-ll',
    status: 'available',
    beds: 2,
    rent_min: 1200,
    rent_max: 1400,
  };
  world.units.set(u.unitId, u);
  return u;
}

/** share-sent-outcome: an attempt key (the message id) whose provider instant is `agoMs` in the past. */
function attemptKeyAgo(agoMs: number, sid: string): string {
  return buildTsMsgId(new Date(Date.now() - agoMs).toISOString(), sid);
}

/** An ISO instant `offsetMs` from now (negative = the past). */
function isoFromNow(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/**
 * share-sent-outcome D1: a slot's newest attempt row in the world's message
 * store - the row the state service reads (its retry promise and chain end)
 * for a young failed-30003 slot.
 */
function seedAttemptRow(
  world: FakeWorld,
  conversationId: string,
  tsMsgId: string,
  extra: Partial<MessageItem> = {},
): void {
  const [providerTs, providerSid] = [tsMsgId.slice(0, tsMsgId.indexOf('#')), tsMsgId.slice(tsMsgId.indexOf('#') + 1)];
  world.messages.push({
    conversationId,
    tsMsgId,
    type: 'sms',
    direction: 'outbound',
    author: 'teammate',
    provider_sid: providerSid,
    provider_ts: providerTs,
    delivery_status: 'failed',
    error_code: '30003',
    created_at: providerTs,
    ...extra,
  } as MessageItem);
}

/** A finished (or drafted) share of unit-1 written straight into the world - no fan-out; listed like create()'s. */
function seedShare(
  world: FakeWorld,
  broadcastId: string,
  status: BroadcastItem['status'],
  recipients: Record<string, BroadcastRecipient>,
  extra: Partial<BroadcastItem> = {},
): BroadcastItem {
  const now = new Date().toISOString();
  const item: BroadcastItem = {
    broadcastId,
    created_by: 'usr_test',
    created_at: now,
    updated_at: now,
    _listPartition: LIST_PARTITION,
    status,
    unitId: 'unit-1',
    audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
    body_template: 'hi',
    stats: { audience: Object.keys(recipients).length, sent: 0, delivered: 0, failed: 0, skipped_opted_out: 0, skipped_no_consent: 0, queued: 0 },
    recipients,
    ...extra,
  };
  world.broadcasts.set(broadcastId, item);
  return item;
}

/** The send-attempt facts a seeded record carries (the values are opaque here). */
const SEED_ATTEMPT_FACTS = { recipientDigest: 'd'.repeat(32), bodyHash: 'h'.repeat(64), bodyShort: false, mediaCount: 0 };

/** Wire the broadcast.send handler against the world (real sendMessage). */
function wireBroadcastHandler(world: FakeWorld) {
  const config = loadConfig({
    NODE_ENV: 'test',
    MESSAGING_DRIVER: 'console',
    PUBLIC_BASE_URL,
    BUSINESS_PHONE_NUMBER: '+15550009999',
    SESSION_SECRET: DEV_SESSION_SECRET_DEFAULT,
  } as NodeJS.ProcessEnv);
  const logger = createLogger({ destination: createLogCapture().stream });
  const sendMessageService = createSendMessageService({
    config,
    logger,
    adapter: world.adapter,
    conversationsRepo: world.conversationsRepo,
    messagesRepo: world.messagesRepo,
    contactsRepo: world.contactsRepo,
    auditRepo: world.auditRepo,
    events: world.events,
  });
  registerBroadcastSendJobHandler({
    sendAttemptsRepo: world.sendAttemptsRepo,
    config,
    broadcastsRepo: world.broadcastsRepo,
    contactsRepo: world.contactsRepo,
    conversationsRepo: world.conversationsRepo,
    messagesRepo: world.messagesRepo,
    unitsRepo: world.unitsRepo,
    sendMessageService,
    events: world.events,
    logger,
  });
}

describe('share-broadcast API (M1.8a)', () => {
  let world: FakeWorld;
  // The in-process queue now DEFERS immediate dispatch (SQS semantics) - POST
  // /send returns before the fan-out runs. Tests that assert on fan-out results
  // await queueAdapter.settle(); afterEach settle() is a leak-guard so a
  // deferred dispatch never bleeds into the next test.
  let queueAdapter: InProcessOutboundQueueAdapter;

  beforeEach(() => {
    _resetForTests();
    configureJobsLogger(createLogger({ destination: createLogCapture().stream }));
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    queueAdapter = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(queueAdapter);
    wireBroadcastHandler(world);
  });

  afterEach(async () => {
    // The reset lives in `finally` so a slow drain can never poison the NEXT
    // test. Before this, a settle() that blew the hook budget skipped
    // _resetForTests() entirely, and the following tests inherited the poisoned
    // module state and failed with unrelated-looking errors ("expected 500 to
    // be 200") - one real cause reported as three failures. See
    // docs/issues/broadcast-fanout-tests-blow-default-hooktimeout.md.
    try {
      await queueAdapter.settle();
    } finally {
      _resetForTests();
    }
  });

  it('POST /api/broadcasts creates a draft + estimates the audience', async () => {
    seedTenant(world, { contactId: 'c-1', firstName: 'Ann' });
    seedTenant(world, { contactId: 'c-2' });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });

    const res = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({
        unitId: 'unit-1',
        body_template: 'Hi [TenantName], see [FlyerLink]',
        audience_filter: { contact_type: 'tenant' },
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.estimatedCount).toBe(2);
    expect(res.body.broadcastId).toBeDefined();
    // Persisted as a draft with the flyer url snapshot.
    const stored = world.broadcasts.get(res.body.broadcastId)!;
    expect(stored.status).toBe('draft');
    expect(stored.flyer_url).toBe(`${PUBLIC_BASE_URL}/p/unit-1?cta=text`);
  });

  it('share-skip-fix D4: a draft created through the dashboard route records created_via dashboard', async () => {
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const id = await createDraft(app);
    expect(world.broadcasts.get(id)?.created_via).toBe('dashboard');
  });

  it('rejects a non-tenant contact_type (never relay-group rosters)', async () => {
    const { app } = makeWebhookHarness({ world });
    const res = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ body_template: 'hi', audience_filter: { contact_type: 'landlord' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tenant/);
  });

  it('POST /preview re-resolves the audience + returns the full candidate list with phones', async () => {
    seedTenant(world, { contactId: 'c-1', firstName: 'Ann', phone: '+15550100001' });
    seedTenant(world, { contactId: 'c-2', sms_opt_out: true, phone: '+15550100002' });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });

    const create = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'hi', audience_filter: { contact_type: 'tenant' } });
    const id = create.body.broadcastId;

    const res = await request(app)
      .post(`/api/broadcasts/${id}/preview`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(200);
    // The opted-out contact is excluded from the audience.
    expect(res.body.count).toBe(1);
    // The full annotated candidate list (renamed from `sample`); no prior
    // sent/sending broadcast for this unit → not already-sent.
    expect(res.body.candidates).toEqual([
      {
        contactId: 'c-1',
        firstName: 'Ann',
        phone: '+15550100001',
        has_consent: true,
        alreadySentThisProperty: false,
        seeded: false,
      },
    ]);
    expect(res.body.priorRecipientContactIds).toEqual([]);
  });

  it('draft → send transitions, fans out, and reports the count', async () => {
    seedTenant(world, { contactId: 'c-1', firstName: 'Ann', phone: '+15550100001' });
    seedTenant(world, { contactId: 'c-2', phone: '+15550100002' });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });

    const create = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'Hi [TenantName]', audience_filter: { contact_type: 'tenant' } });
    const id = create.body.broadcastId;

    const send = await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(send.status).toBe(200);
    expect(send.body.status).toBe('sending');
    expect(send.body.count).toBe(2);

    // POST /send returns before the deferred fan-out runs (SQS semantics) - wait
    // for the in-process dispatch to drain, then assert on its results.
    await queueAdapter.settle();
    // The in-process fan-out ran → both tenants texted, broadcast finalized 'sent'.
    expect(world.sent.map((s) => s.to).sort()).toEqual(['+15550100001', '+15550100002'].sort());
    expect(world.broadcasts.get(id)!.status).toBe('sent');

    // Results endpoint reflects the rolled-up DERIVED stats: both legs are
    // dispatched ('sent' slots) but no carrier callback ran in this rig, so
    // they derive `sending` (with the carrier) - the SENT bucket is reserved
    // for carrier-confirmed legs (carrierSentAt), and `queued` for legs still
    // on our box.
    const results = await request(app)
      .get(`/api/broadcasts/${id}/results`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(results.status).toBe(200);
    expect(results.body.stats.sending).toBe(2);
    expect(results.body.stats.queued).toBe(0);
    expect(results.body.stats.sent).toBe(0);
    expect(results.body.status).toBe('sent');
  });

  it('refuses a send with an empty audience (400 empty_audience), stays a draft', async () => {
    seedUnit(world);
    const { app } = makeWebhookHarness({ world }); // no tenants seeded

    const create = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'hi', audience_filter: { contact_type: 'tenant' } });
    const id = create.body.broadcastId;

    const send = await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(send.status).toBe(400);
    expect(send.body.error).toBe('empty_audience');
    expect(world.broadcasts.get(id)!.status).toBe('draft');
    expect(world.sent).toHaveLength(0);
  });

  it('a second send is refused (not a draft → 409)', async () => {
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const create = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'hi', audience_filter: { contact_type: 'tenant' } });
    const id = create.body.broadcastId;
    await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    const again = await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('broadcast_not_draft');
  });

  it('requires auth (no cookie → 401/403)', async () => {
    const { app } = makeWebhookHarness({ world });
    const res = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .send({ body_template: 'hi', audience_filter: {} });
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(404);
  });

  // --- Delivery-callback rollup (M1.8a) ----------------------------------
  it('delivered callback for a broadcast message rolls into stats + emits broadcast.updated', async () => {
    seedTenant(world, { contactId: 'c-1', firstName: 'Ann', phone: '+15550100001' });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });

    const create = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'Hi [TenantName]', audience_filter: { contact_type: 'tenant' } });
    const id = create.body.broadcastId;
    await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});

    // The outbound message's provider SID — the callback identifies by it.
    const outbound = world.messages.find((m) => m.broadcast_id === id)!;
    expect(outbound).toBeDefined();
    const sid = outbound.provider_sid;

    world.emitted.length = 0; // focus on the callback's emit
    const res = await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageSid: sid, MessageStatus: 'delivered' }));
    expect(res.status).toBe(200);

    const bcast = world.broadcasts.get(id)!;
    expect(bcast.stats.delivered).toBe(1);
    expect(bcast.recipients['c-1']?.status).toBe('delivered');
    const evt = world.emitted.find((e) => e.event === 'broadcast.updated');
    expect(evt).toBeDefined();
    expect((evt!.payload as { stats: { delivered: number } }).stats.delivered).toBe(1);
  });

  it('S4: a delivered callback decrements persisted sent and emits DERIVED disjoint stats', async () => {
    seedTenant(world, { contactId: 'c-1', firstName: 'Ann', phone: '+15550100001' });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const create = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'Hi [TenantName]', audience_filter: { contact_type: 'tenant' } });
    const id = create.body.broadcastId;
    await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    await queueAdapter.settle();
    // After the send, the recipient is 'sent' (persisted sent=1).
    expect(world.broadcasts.get(id)!.stats.sent).toBe(1);

    const sid = world.messages.find((m) => m.broadcast_id === id)!.provider_sid;
    world.emitted.length = 0;
    await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageSid: sid, MessageStatus: 'delivered' }));

    const bcast = world.broadcasts.get(id)!;
    // Persisted-counter hygiene: delivered decrements sent (mirrors the failed
    // case), so the persisted counters match the disjoint model on new rows.
    expect(bcast.stats.sent).toBe(0);
    expect(bcast.stats.delivered).toBe(1);
    // The emit carries DERIVED disjoint stats (sum to the audience of 1).
    const evt = world.emitted.find((e) => e.event === 'broadcast.updated')!;
    const stats = (evt.payload as { stats: BroadcastStats }).stats;
    expect(stats).toMatchObject({ audience: 1, delivered: 1, sent: 0, queued: 0 });
    // EVERY bucket, incl. the optional `sending`, `unconfirmed` (SOR D22) and
    // `skipped_other` (same sum as broadcastFanOut.test.ts bucketsSumToAudience).
    expect(
      stats.queued +
        (stats.sending ?? 0) +
        stats.sent +
        stats.delivered +
        stats.failed +
        (stats.unconfirmed ?? 0) +
        stats.skipped_opted_out +
        stats.skipped_no_consent +
        (stats.skipped_other ?? 0),
    ).toBe(stats.audience);
  });

  it('failed callback for a broadcast message rolls failed++ (forward-only)', async () => {
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const create = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'hi', audience_filter: { contact_type: 'tenant' } });
    const id = create.body.broadcastId;
    await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    const sid = world.messages.find((m) => m.broadcast_id === id)!.provider_sid;

    await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageSid: sid, MessageStatus: 'failed', ErrorCode: '30008' }));
    const bcast = world.broadcasts.get(id)!;
    expect(bcast.recipients['c-1']?.status).toBe('failed');
    expect(bcast.stats.failed).toBe(1);
    // sent was decremented (a sent that ultimately failed reconciles to failed).
    expect(bcast.stats.sent).toBe(0);

    // A redelivered/duplicate callback does NOT regress or double-count.
    await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageSid: sid, MessageStatus: 'delivered' }));
    expect(world.broadcasts.get(id)!.recipients['c-1']?.status).toBe('failed');
    expect(world.broadcasts.get(id)!.stats.failed).toBe(1);
  });

  // --- Delivery-failure severity taxonomy (marker log level) ---------------
  // The delivery_failed marker's LEVEL follows the taxonomy: a terminal failure
  // is an ERROR (so it reaches the error-logs alarm + Recent Errors panel); a
  // provider-side opt-out (21610) stays WARN (the platform behaving correctly).
  async function sendBroadcastGetSid(app: ReturnType<typeof makeWebhookHarness>['app']): Promise<string> {
    const create = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'hi', audience_filter: { contact_type: 'tenant' } });
    await request(app)
      .post(`/api/broadcasts/${create.body.broadcastId}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    await queueAdapter.settle();
    return world.messages.find((m) => m.broadcast_id === create.body.broadcastId)!.provider_sid;
  }

  it('a terminal delivery failure (30034) logs the delivery_failed marker at ERROR level', async () => {
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
    seedUnit(world);
    const { app, capture } = makeWebhookHarness({ world });
    const sid = await sendBroadcastGetSid(app);

    await signedTwilioPost(
      app,
      STATUS_PATH,
      statusParams({ MessageSid: sid, MessageStatus: 'undelivered', ErrorCode: '30034' }),
    );

    const errorMarker = capture.atLevel(50).find((l) => l['event'] === 'delivery_failed');
    expect(errorMarker, 'a terminal failure must log delivery_failed at error').toBeDefined();
    expect(errorMarker!['errorCode']).toBe('30034');
    // ...and NOT at warn.
    expect(capture.atLevel(40).find((l) => l['event'] === 'delivery_failed')).toBeUndefined();
  });

  it('a provider-side opt-out (21610) logs the delivery_failed marker at WARN, not error', async () => {
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
    seedUnit(world);
    const { app, capture } = makeWebhookHarness({ world });
    const sid = await sendBroadcastGetSid(app);

    await signedTwilioPost(
      app,
      STATUS_PATH,
      statusParams({ MessageSid: sid, MessageStatus: 'failed', ErrorCode: '21610' }),
    );

    const warnMarker = capture.atLevel(40).find((l) => l['event'] === 'delivery_failed');
    expect(warnMarker, 'an opt-out must log delivery_failed at warn').toBeDefined();
    expect(warnMarker!['errorCode']).toBe('21610');
    expect(capture.atLevel(50).find((l) => l['event'] === 'delivery_failed')).toBeUndefined();
  });

  // --- FIX 1: the rollup transition is atomic (exactly-once stat bump) ------
  it('two delivery callbacks for the same SID roll up to delivered exactly once (FIX 1)', async () => {
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const create = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'hi', audience_filter: { contact_type: 'tenant' } });
    const id = create.body.broadcastId;
    await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    const sid = world.messages.find((m) => m.broadcast_id === id)!.provider_sid;

    // Fire the SAME delivered callback twice (a redelivery / out-of-order dup).
    await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageSid: sid, MessageStatus: 'delivered' }));
    await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageSid: sid, MessageStatus: 'delivered' }));

    const bcast = world.broadcasts.get(id)!;
    expect(bcast.recipients['c-1']?.status).toBe('delivered');
    // Exactly once — never exceeds the recipient count.
    expect(bcast.stats.delivered).toBe(1);
    expect(bcast.stats.delivered).toBeLessThanOrEqual(Object.keys(bcast.recipients).length);
  });

  it('conditional setRecipient: a slot transition applies exactly once under a race (FIX 1)', async () => {
    // Drive the repo primitive directly: two writers race the SAME sent→delivered
    // transition on one slot. The conditional prior-status guard lets exactly one
    // win; the loser returns false (so the caller skips its stat bump).
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
    const created = await world.broadcastsRepo.create({
      created_by: 'usr_test',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'hi',
    });
    await world.broadcastsRepo.markSending(created.broadcastId, { 'c-1': { status: 'queued' } });
    await world.broadcastsRepo.setRecipient(created.broadcastId, 'c-1', { status: 'sent' });

    const [a, b] = await Promise.all([
      world.broadcastsRepo.setRecipient(created.broadcastId, 'c-1', { status: 'delivered' }, ['queued', 'sent']),
      world.broadcastsRepo.setRecipient(created.broadcastId, 'c-1', { status: 'delivered' }, ['queued', 'sent']),
    ]);
    // Exactly one write applied; the other was a no-op (slot already terminal).
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(world.broadcasts.get(created.broadcastId)!.recipients['c-1']?.status).toBe('delivered');
  });

  // --- FIX 3+4: bound the audience (no overflow, no silent truncation) ------
  it('preview surfaces count + truncated (FIX 3+4)', async () => {
    seedTenant(world, { contactId: 'c-1', firstName: 'Ann', phone: '+15550100001' });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const create = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'hi', audience_filter: { contact_type: 'tenant' } });
    // The create estimate also surfaces truncated.
    expect(create.body.truncated).toBe(false);
    const res = await request(app)
      .post(`/api/broadcasts/${create.body.broadcastId}/preview`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.truncated).toBe(false);
  });

  it('/send refuses an over-cap audience (400 audience_too_large), stays draft (FIX 3+4)', async () => {
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
    seedTenant(world, { contactId: 'c-2', phone: '+15550100002' });
    seedTenant(world, { contactId: 'c-3', phone: '+15550100003' });
    seedUnit(world);
    // Inject an audience resolver that reports an over-cap / truncated audience
    // (the world contacts are few, but the resolver is the source of truth).
    const overCap = {
      contactIds: ['c-1', 'c-2', 'c-3'],
      contacts: [
        { contactId: 'c-1', phone: '+15550100001', has_consent: true },
        { contactId: 'c-2', phone: '+15550100002', has_consent: true },
        { contactId: 'c-3', phone: '+15550100003', has_consent: true },
      ],
      count: 5_000, // > MAX_BROADCAST_RECIPIENTS (1000)
      truncated: true,
    };
    const { app } = makeWebhookHarness({
      world,
      audienceResolutionService: async () => overCap,
    });
    const create = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'hi', audience_filter: { contact_type: 'tenant' } });
    const id = create.body.broadcastId;

    const send = await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(send.status).toBe(400);
    expect(send.body.error).toBe('audience_too_large');
    expect(send.body.message).toMatch(/narrow/);
    // Stays a draft, nothing enqueued, no sends.
    expect(world.broadcasts.get(id)!.status).toBe('draft');
    expect(world.sent).toHaveLength(0);
  });

  // --- FIX 5: GET /api/broadcasts pagination -------------------------------
  it('list returns nextCursor when more pages exist and a cursor resumes (FIX 5)', async () => {
    // Three drafts by the acting user; page size 2 → page 1 has a cursor.
    for (let i = 0; i < 3; i++) seedTenant(world, { contactId: `c-${i}`, phone: `+1555010000${i}` });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await request(app)
        .post('/api/broadcasts')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ unitId: 'unit-1', body_template: `b${i}`, audience_filter: { contact_type: 'tenant' } });
      ids.push(r.body.broadcastId);
    }

    const page1 = await request(app)
      .get('/api/broadcasts?limit=2')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(page1.status).toBe(200);
    expect(page1.body.broadcasts).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();

    const page2 = await request(app)
      .get(`/api/broadcasts?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(page2.status).toBe(200);
    expect(page2.body.broadcasts).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();

    // The two pages cover all three distinct broadcasts (no overlap, no gap).
    const seen = [
      ...page1.body.broadcasts.map((b: { broadcastId: string }) => b.broadcastId),
      ...page2.body.broadcasts.map((b: { broadcastId: string }) => b.broadcastId),
    ];
    expect(new Set(seen).size).toBe(3);
  });

  it('rejects an invalid cursor with 400 (FIX 5)', async () => {
    const { app } = makeWebhookHarness({ world });
    const res = await request(app)
      .get('/api/broadcasts?cursor=not-a-valid-cursor!!!')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid cursor');
  });

  // --- Team-wide list (byCreated GSI, 2026-07-08) ---------------------------
  // Regression: the no-filter list used to be scoped to the ACTING user
  // (listByCreatedBy), so the dashboard's All tab showed a subset of what its
  // own status tabs (listByStatus, global) showed. Both views are team-wide now.
  it('lists ALL creators (not just the acting user) newest-first, in both the All view and the status view', async () => {
    const { app } = makeWebhookHarness({ world });
    // Three broadcasts by three DIFFERENT users, seeded at the repo (the session
    // user below is user-0002 — the old code would have shown only theirs).
    const filter = { contact_type: 'tenant' as const, excludeOptedOut: true, excludeUnreachable: true };
    const mine = await world.broadcastsRepo.create({ created_by: 'user-0002', body_template: 'a', audience_filter: filter });
    const theirs = await world.broadcastsRepo.create({ created_by: 'user-0001', body_template: 'b', audience_filter: filter });
    const third = await world.broadcastsRepo.create({ created_by: 'user-0003', body_template: 'c', audience_filter: filter });
    // Distinct created_at (newest-first is assertable) + one non-draft.
    const patchRow = (id: string, patch: { created_at: string; status?: 'sent' }): void => {
      const row = world.broadcasts.get(id);
      if (row === undefined) throw new Error(`missing broadcast ${id}`);
      Object.assign(row, patch);
    };
    patchRow(mine.broadcastId, { created_at: '2026-07-01T10:00:00.000Z' });
    patchRow(theirs.broadcastId, { created_at: '2026-07-03T10:00:00.000Z', status: 'sent' });
    patchRow(third.broadcastId, { created_at: '2026-07-02T10:00:00.000Z' });

    const all = await request(app)
      .get('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(all.status).toBe(200);
    expect(all.body.broadcasts.map((b: { broadcastId: string }) => b.broadcastId)).toEqual([
      theirs.broadcastId, // 07-03 — another user's, and it leads (newest)
      third.broadcastId, // 07-02
      mine.broadcastId, // 07-01
    ]);

    // The status view filters the SAME team-wide population, same order.
    const drafts = await request(app)
      .get('/api/broadcasts?status=draft')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(drafts.status).toBe(200);
    expect(drafts.body.broadcasts.map((b: { broadcastId: string }) => b.broadcastId)).toEqual([
      third.broadcastId,
      mine.broadcastId,
    ]);
  });

  // --- FIX 7: a concurrent send → 409, not 500, and does not double-enqueue -
  it('a send racing markSending returns 409 (not 500) and does not double-enqueue (FIX 7)', async () => {
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
    seedUnit(world);
    // Make markSending throw the conditional-check error (a concurrent send won
    // the draft→sending flip between the route's read and the write).
    const realMarkSending = world.broadcastsRepo.markSending.bind(world.broadcastsRepo);
    let first = true;
    world.broadcastsRepo.markSending = async (broadcastId, recipients) => {
      if (first) {
        first = false;
        // Flip it to sending under the hood so the conditional fails, then throw.
        await realMarkSending(broadcastId, recipients);
        throw new ConditionalCheckFailedException({ message: 'raced', $metadata: {} });
      }
      return realMarkSending(broadcastId, recipients);
    };

    const { app } = makeWebhookHarness({ world });
    const create = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'hi', audience_filter: { contact_type: 'tenant' } });
    const id = create.body.broadcastId;

    const send = await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(send.status).toBe(409);
    expect(send.body.error).toBe('broadcast_not_draft');
  });

  // --- Broadcasts dashboard Phase A: DELETE a draft (draft-only) ------------
  async function createDraft(app: import('express').Express, body: Record<string, unknown> = {}) {
    const create = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'hi', audience_filter: { contact_type: 'tenant' }, ...body });
    return create.body.broadcastId as string;
  }

  it('DELETE a draft → 200 {deleted:true}, the row is gone, audit broadcast_deleted', async () => {
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const id = await createDraft(app);

    const del = await request(app)
      .delete(`/api/broadcasts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true });
    // The row is actually gone.
    expect(world.broadcasts.has(id)).toBe(false);
    // Audited IDs-only (broadcast_deleted on the broadcast's entity key).
    const audit = world.auditEvents.find(
      (e) => e.entityKey === `broadcasts#${id}` && e.event_type === 'broadcast_deleted',
    );
    expect(audit).toBeDefined();
    expect(audit!.actorId).toBeDefined();
    // A subsequent GET results is a 404 (truly deleted).
    const after = await request(app)
      .get(`/api/broadcasts/${id}/results`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(after.status).toBe(404);
  });

  it('DELETE a missing broadcast → 404, no audit', async () => {
    const { app } = makeWebhookHarness({ world });
    const del = await request(app)
      .delete('/api/broadcasts/bcast-does-not-exist')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(del.status).toBe(404);
    expect(del.body.error).toBe('broadcast_not_found');
    expect(world.auditEvents.some((e) => e.event_type === 'broadcast_deleted')).toBe(false);
  });

  it('DELETE a sent/sending broadcast → 409 broadcast_not_draft (+status), the row survives', async () => {
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const id = await createDraft(app);
    // Send it (the in-process fan-out finalizes it 'sent').
    await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    await queueAdapter.settle(); // drain the deferred fan-out so it finalizes 'sent'
    expect(world.broadcasts.get(id)!.status).toBe('sent');

    const del = await request(app)
      .delete(`/api/broadcasts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(del.status).toBe(409);
    expect(del.body.error).toBe('broadcast_not_draft');
    expect(del.body.status).toBe('sent');
    // The sent broadcast is NOT deleted (permanent).
    expect(world.broadcasts.has(id)).toBe(true);
    expect(world.auditEvents.some((e) => e.event_type === 'broadcast_deleted')).toBe(false);
  });

  it('DELETE a failed broadcast → 409 broadcast_not_draft', async () => {
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const id = await createDraft(app);
    await world.broadcastsRepo.markFailed(id, 'forced for the test');
    const del = await request(app)
      .delete(`/api/broadcasts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(del.status).toBe(409);
    expect(del.body.error).toBe('broadcast_not_draft');
    expect(del.body.status).toBe('failed');
  });

  it('DELETE racing a draft→sending flip → 409, NO silent delete of the (now sending) row', async () => {
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const id = await createDraft(app);
    // Simulate the race: the conditional delete reads a draft, but between the
    // read and the conditional write the broadcast was flipped to 'sending' by a
    // concurrent send. Mirror it by wrapping the repo's delete so the row flips
    // under the hood right before the conditional check fires — the conditional
    // (status='draft') must then fail → not_draft (409), never a silent delete.
    const realDelete = world.broadcastsRepo.delete.bind(world.broadcastsRepo);
    world.broadcastsRepo.delete = async (broadcastId) => {
      const b = world.broadcasts.get(broadcastId);
      if (b) b.status = 'sending'; // the concurrent send won the flip
      return realDelete(broadcastId);
    };

    const del = await request(app)
      .delete(`/api/broadcasts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(del.status).toBe(409);
    expect(del.body.error).toBe('broadcast_not_draft');
    expect(del.body.status).toBe('sending');
    // The broadcast survives — never silently removed under the race.
    expect(world.broadcasts.has(id)).toBe(true);
    expect(world.auditEvents.some((e) => e.event_type === 'broadcast_deleted')).toBe(false);
  });

  it('DELETE requires auth (no cookie → 401/403)', async () => {
    const { app } = makeWebhookHarness({ world });
    const del = await request(app)
      .delete('/api/broadcasts/bcast-anything')
      .set('x-origin-verify', ORIGIN_SECRET);
    expect(del.status).toBeGreaterThanOrEqual(401);
    expect(del.status).toBeLessThan(404);
  });

  // --- Broadcasts dashboard Phase A: send by explicit selection -------------
  it('send with recipientContactIds builds recipients from EXACTLY that checked set', async () => {
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
    seedTenant(world, { contactId: 'c-2', phone: '+15550100002' });
    seedTenant(world, { contactId: 'c-3', phone: '+15550100003' });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const id = await createDraft(app);

    const send = await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ recipientContactIds: ['c-1', 'c-3'] });
    expect(send.status).toBe(200);
    expect(send.body.count).toBe(2);
    await queueAdapter.settle(); // drain the deferred fan-out before asserting sends
    // The recipients map keys are EXACTLY the surviving checked ids (c-2 excluded).
    expect(Object.keys(world.broadcasts.get(id)!.recipients).sort()).toEqual(['c-1', 'c-3']);
    // Only those two were texted.
    expect(world.sent.map((s) => s.to).sort()).toEqual(['+15550100001', '+15550100003'].sort());
  });

  it('send-by-selection re-enforces opt-out / unreachable / non-tenant / unknown-id drops', async () => {
    seedTenant(world, { contactId: 'c-ok', phone: '+15550100001' });
    seedTenant(world, { contactId: 'c-opt', phone: '+15550100002', sms_opt_out: true });
    seedTenant(world, { contactId: 'c-unreach', phone: '+15550100003', sms_unreachable: true });
    // A non-tenant contact (landlord) must NEVER be texted even if checked.
    world.contacts.push({ contactId: 'c-ll', type: 'landlord', status: 'active', phone: '+15550100004' });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const id = await createDraft(app);

    const send = await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ recipientContactIds: ['c-ok', 'c-opt', 'c-unreach', 'c-ll', 'c-missing'] });
    expect(send.status).toBe(200);
    // Only the clean tenant survives all the re-enforced fences.
    expect(send.body.count).toBe(1);
    expect(Object.keys(world.broadcasts.get(id)!.recipients)).toEqual(['c-ok']);
    expect(world.sent.map((s) => s.to)).toEqual(['+15550100001']);
  });

  it('send-by-selection fans out across multiple fetch chunks and holds the fences (bounded-concurrency)', async () => {
    // A moderate selection (66 ids) spans multiple 50-id fetch chunks, proving
    // the bounded-concurrency getById fan-out accumulates correctly. Mix in
    // opted-out / unreachable / non-tenant / unknown ids — the same hard fences
    // must still drop them after the concurrent fetch.
    seedUnit(world);
    const checked: string[] = [];
    const expectedSurviving: string[] = [];
    for (let i = 0; i < 60; i++) {
      const cid = `sel-${i}`;
      seedTenant(world, { contactId: cid, phone: `+1556${String(i).padStart(7, '0')}` });
      checked.push(cid);
      expectedSurviving.push(cid);
    }
    // Three drops + one unknown id, interleaved across the chunk boundary.
    seedTenant(world, { contactId: 'sel-opt', phone: '+15559990001', sms_opt_out: true });
    seedTenant(world, { contactId: 'sel-unreach', phone: '+15559990002', sms_unreachable: true });
    world.contacts.push({ contactId: 'sel-ll', type: 'landlord', status: 'active', phone: '+15559990003' });
    checked.push('sel-opt', 'sel-unreach', 'sel-ll', 'sel-missing');

    const { app } = makeWebhookHarness({ world });
    const id = await createDraft(app);
    const send = await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ recipientContactIds: checked });
    expect(send.status).toBe(200);
    // Exactly the 60 clean tenants survive — all dropped ids fenced out.
    expect(send.body.count).toBe(60);
    expect(Object.keys(world.broadcasts.get(id)!.recipients).sort()).toEqual(
      [...expectedSurviving].sort(),
    );
  });

  it('send-by-selection de-dupes repeated ids', async () => {
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const id = await createDraft(app);
    const send = await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ recipientContactIds: ['c-1', 'c-1', 'c-1'] });
    expect(send.status).toBe(200);
    expect(send.body.count).toBe(1);
    expect(Object.keys(world.broadcasts.get(id)!.recipients)).toEqual(['c-1']);
  });

  it('send-by-selection with an effective-empty set (all dropped) → 400 empty_audience, stays draft', async () => {
    seedTenant(world, { contactId: 'c-opt', phone: '+15550100002', sms_opt_out: true });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const id = await createDraft(app);
    const send = await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ recipientContactIds: ['c-opt', 'c-unknown'] });
    expect(send.status).toBe(400);
    expect(send.body.error).toBe('empty_audience');
    expect(world.broadcasts.get(id)!.status).toBe('draft');
    expect(world.sent).toHaveLength(0);
  });

  it('send-by-selection with an empty array → 400 empty_audience, stays draft', async () => {
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const id = await createDraft(app);
    const send = await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ recipientContactIds: [] });
    expect(send.status).toBe(400);
    expect(send.body.error).toBe('empty_audience');
    expect(world.broadcasts.get(id)!.status).toBe('draft');
  });

  it('send-by-selection over the recipient cap → 400 refusal, stays draft, nothing sent', async () => {
    seedUnit(world);
    // A checked list LONGER than the cap. The send refuses with a 400 BEFORE any
    // resolution/markSending (parseRecipientContactIds guards the array length —
    // the surviving set can never exceed the input length, so the over-cap
    // explicit selection is rejected at parse). It's a clean 400 that leaves the
    // broadcast a draft and sends nothing; we assert that contract, not the exact
    // error slug (the parse guard reports the cap explicitly).
    const ids: string[] = [];
    for (let i = 0; i < MAX_BROADCAST_RECIPIENTS + 1; i++) ids.push(`cap-${i}`);
    const { app } = makeWebhookHarness({ world });
    const id = await createDraft(app);
    const send = await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ recipientContactIds: ids });
    expect(send.status).toBe(400);
    expect(send.body.error).toMatch(/cap/i); // "...exceeds the 1000 recipient cap" (MAX_BROADCAST_RECIPIENTS)
    expect(world.broadcasts.get(id)!.status).toBe('draft');
    expect(world.sent).toHaveLength(0);
  });

  it('send-by-selection still honors the draft gate (a non-draft → 409)', async () => {
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const id = await createDraft(app);
    await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ recipientContactIds: ['c-1'] });
    const again = await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ recipientContactIds: ['c-1'] });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('broadcast_not_draft');
  });

  it('back-compat: an ABSENT body still uses the filter-resolve path', async () => {
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
    seedTenant(world, { contactId: 'c-2', phone: '+15550100002' });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const id = await createDraft(app);
    const send = await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({}); // no recipientContactIds → filter-resolve both tenants
    expect(send.status).toBe(200);
    expect(send.body.count).toBe(2);
    expect(Object.keys(world.broadcasts.get(id)!.recipients).sort()).toEqual(['c-1', 'c-2']);
  });

  // --- Broadcasts dashboard Phase A: full annotated preview -----------------
  it('preview returns the FULL candidate list (not capped at the old 25-sample)', async () => {
    seedUnit(world);
    for (let i = 0; i < 30; i++) {
      seedTenant(world, { contactId: `p-${i}`, firstName: `T${i}`, phone: `+1557${String(i).padStart(7, '0')}` });
    }
    const { app } = makeWebhookHarness({ world });
    const id = await createDraft(app);
    const res = await request(app)
      .post(`/api/broadcasts/${id}/preview`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(30);
    expect(res.body.candidates).toHaveLength(30); // FULL list, > 25
    expect(res.body.truncated).toBe(false);
  });

  it('preview candidates carry voucherSize/housingAuthority when present', async () => {
    seedUnit(world);
    seedTenant(world, {
      contactId: 'c-rich',
      firstName: 'Rosa',
      phone: '+15550100001',
      voucherSize: 2,
      housingAuthority: 'METRO_HA',
    } as Partial<ContactItem>);
    seedTenant(world, { contactId: 'c-bare', phone: '+15550100002' }); // no voucher/HA
    const { app } = makeWebhookHarness({ world });
    const id = await createDraft(app);
    const res = await request(app)
      .post(`/api/broadcasts/${id}/preview`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(200);
    const rich = res.body.candidates.find((c: { contactId: string }) => c.contactId === 'c-rich');
    const bare = res.body.candidates.find((c: { contactId: string }) => c.contactId === 'c-bare');
    expect(rich).toMatchObject({ voucherSize: 2, housingAuthority: 'METRO_HA', firstName: 'Rosa' });
    // Absent on a contact lacking them (the fields are omitted, not null).
    expect(bare).not.toHaveProperty('voucherSize');
    expect(bare).not.toHaveProperty('housingAuthority');
  });
  it('caseworkers D20: a PARTNER seed previews WITHOUT voucher facts (lean Renee Carter is the negative); a tenant seed keeps them', async () => {
    seedUnit(world);
    const renee = SEED.contacts?.find((c) => c['contactId'] === 'contact-hastaff-0001') as unknown as ContactItem;
    // The fixture is what the ruling says it is: a partner holding a housing
    // authority (a leftover, not a voucher fact).
    expect(renee.type).toBe('partner');
    expect(typeof renee.housingAuthority).toBe('string');
    // A voucher size on the copy too, so BOTH fields are proved stripped.
    world.contacts.push({ ...renee, voucherSize: 2 });
    seedTenant(world, {
      contactId: 'c-voucher',
      phone: '+15550100071',
      voucherSize: 3,
      housingAuthority: 'Atlanta Housing Authority',
    } as Partial<ContactItem>);
    const { app } = makeWebhookHarness({ world });
    const created = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'Hi!', seedContactIds: ['contact-hastaff-0001', 'c-voucher'] });
    expect(created.status).toBe(201);
    const res = await request(app)
      .post(`/api/broadcasts/${created.body.broadcastId}/preview`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.unresolvedSeedIds).toEqual([]);
    const rows = res.body.candidates as Array<Record<string, unknown>>;
    const partnerRow = rows.find((c) => c['contactId'] === 'contact-hastaff-0001');
    expect(partnerRow).toMatchObject({ firstName: 'Renee', lastName: 'Carter', seeded: true, has_consent: false });
    expect(partnerRow).not.toHaveProperty('voucherSize');
    expect(partnerRow).not.toHaveProperty('housingAuthority');
    expect(rows.find((c) => c['contactId'] === 'c-voucher')).toMatchObject({
      voucherSize: 3,
      housingAuthority: 'Atlanta Housing Authority',
    });
  });

  it('alreadySentThisProperty + priorRecipientContactIds reflect a PRIOR sent broadcast of this unit: set by a recipient who REACHED (sent, delivered) and by one still in flight in a sending share', async () => {
    seedTenant(world, { contactId: 'c-1', firstName: 'Ann', phone: '+15550100001' });
    seedTenant(world, { contactId: 'c-2', firstName: 'Bo', phone: '+15550100002' });
    seedTenant(world, { contactId: 'c-3', firstName: 'Cy', phone: '+15550100003' });
    seedTenant(world, { contactId: 'c-4', firstName: 'Di', phone: '+15550100004' });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    // Prior broadcast for unit-1: send to ONLY c-1 (so c-1 is already-sent).
    const prior = await createDraft(app);
    await request(app)
      .post(`/api/broadcasts/${prior}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ recipientContactIds: ['c-1'] });
    await queueAdapter.settle(); // drain the prior broadcast's deferred fan-out
    expect(world.broadcasts.get(prior)!.status).toBe('sent');
    // share-sent-outcome D1: a DELIVERED recipient of another share reached;
    // a queued slot of a share still SENDING is in flight - both may have the text.
    seedShare(world, 'bcast-delivered', 'sent', { 'c-3': { status: 'delivered' } });
    seedShare(world, 'bcast-running', 'sending', { 'c-4': { status: 'queued' } });

    // A NEW draft for the same unit previews all four - c-1, c-3, c-4 flagged, c-2 not.
    const next = await createDraft(app);
    const res = await request(app)
      .post(`/api/broadcasts/${next}/preview`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.priorRecipientContactIds.sort()).toEqual(['c-1', 'c-3', 'c-4']);
    const c1 = res.body.candidates.find((c: { contactId: string }) => c.contactId === 'c-1');
    const c2 = res.body.candidates.find((c: { contactId: string }) => c.contactId === 'c-2');
    const c3 = res.body.candidates.find((c: { contactId: string }) => c.contactId === 'c-3');
    const c4 = res.body.candidates.find((c: { contactId: string }) => c.contactId === 'c-4');
    expect(c1.alreadySentThisProperty).toBe(true);
    expect(c2.alreadySentThisProperty).toBe(false);
    expect(c3.alreadySentThisProperty).toBe(true);
    expect(c4.alreadySentThisProperty).toBe(true);
  });

  it('alreadySentThisProperty is true for a prior recipient keyed phone#… matched by the candidate phone', async () => {
    // The candidate now HAS a contactId, but at the prior broadcast's send time
    // the tenant was texted phone-only — keyed `phone#<E164>` in the recipients
    // map. The preview must flag them by matching on the phone key, not just the
    // contactId (which the prior set never carried).
    const phone = '+15550100099';
    const tenant = seedTenant(world, { contactId: 'c-late', firstName: 'Lena', phone });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    // A PRIOR sent broadcast for unit-1 whose recipients map is keyed phone#…
    // (the phone-only recipient convention) — NOT the contactId.
    const prior = await world.broadcastsRepo.create({
      created_by: 'usr_test',
      unitId: 'unit-1',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'hi',
    });
    await world.broadcastsRepo.markSending(prior.broadcastId, { [`phone#${phone}`]: { status: 'sent' } });
    // Flip it terminal so it counts as a prior sent broadcast.
    world.broadcasts.get(prior.broadcastId)!.status = 'sent';

    // A new draft for the same unit previews the tenant (now contactId-bearing).
    const next = await createDraft(app);
    const res = await request(app)
      .post(`/api/broadcasts/${next}/preview`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(200);
    // The prior set carries the phone key (response shape unchanged — union of keys).
    expect(res.body.priorRecipientContactIds).toEqual([`phone#${phone}`]);
    const cand = res.body.candidates.find((c: { contactId: string }) => c.contactId === tenant.contactId);
    // Flagged via the phone-key fallback even though the contactId never matched.
    expect(cand.alreadySentThisProperty).toBe(true);
  });

  it('alreadySentThisProperty is false for a broadcast with NO unitId (no prior lookup)', async () => {
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
    // A prior SENT broadcast that happens to include c-1, but for a DIFFERENT unit.
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const prior = await createDraft(app); // unit-1
    await request(app)
      .post(`/api/broadcasts/${prior}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ recipientContactIds: ['c-1'] });

    // A unit-LESS draft: no unitId → no prior lookup → nothing flagged.
    const create = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ body_template: 'hi', audience_filter: { contact_type: 'tenant' } });
    const res = await request(app)
      .post(`/api/broadcasts/${create.body.broadcastId}/preview`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.priorRecipientContactIds).toEqual([]);
    const c1 = res.body.candidates.find((c: { contactId: string }) => c.contactId === 'c-1');
    expect(c1.alreadySentThisProperty).toBe(false);
  });

  it('alreadySentThisProperty is NOT set by a prior DRAFT/FAILED broadcast (only sent/sending)', async () => {
    // share-sent-outcome D1: holds as the STRANDED case - a queued slot of a
    // share no longer sending with NO send-attempt record was never texted.
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    // A prior DRAFT for unit-1 with c-1 seeded into recipients, but never sent.
    const draft = await createDraft(app);
    world.broadcasts.get(draft)!.recipients = { 'c-1': { status: 'queued' } };
    // And a prior FAILED one, also with c-1 in recipients.
    const failed = await createDraft(app);
    world.broadcasts.get(failed)!.recipients = { 'c-1': { status: 'queued' } };
    await world.broadcastsRepo.markFailed(failed);

    const next = await createDraft(app);
    const res = await request(app)
      .post(`/api/broadcasts/${next}/preview`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.priorRecipientContactIds).toEqual([]);
    const c1 = res.body.candidates.find((c: { contactId: string }) => c.contactId === 'c-1');
    expect(c1.alreadySentThisProperty).toBe(false);
  });

  // --- share-sent-outcome D1: the flag takes the SAFE reading of the state ----
  /** Preview a fresh unit-1 draft: each candidate's flag, and the prior set the hand-add annotation reads. */
  async function previewFlags(app: import('express').Express): Promise<{ flags: Map<string, boolean>; prior: string[] }> {
    const id = await createDraft(app);
    const res = await request(app)
      .post(`/api/broadcasts/${id}/preview`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(200);
    const candidates = res.body.candidates as Array<{ contactId: string; alreadySentThisProperty: boolean }>;
    return {
      flags: new Map(candidates.map((c) => [c.contactId, c.alreadySentThisProperty])),
      prior: [...(res.body.priorRecipientContactIds as string[])].sort(),
    };
  }

  it("is set for a tenant whose failed 30003 text carries a live retry promise (the safe reading), whatever the share's stored status", async () => {
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
    seedUnit(world);
    const root = attemptKeyAgo(2 * 60_000, 'SMroot1');
    seedAttemptRow(world, 'conv-c1', root, { retry_due_at: isoFromNow(5 * 60_000) });
    seedShare(world, 'bcast-prior', 'failed', {
      'c-1': { status: 'failed', errorCode: '30003', conversationId: 'conv-c1', tsMsgId: root },
    });
    const { app } = makeWebhookHarness({ world });
    const { flags, prior } = await previewFlags(app);
    expect(flags.get('c-1')).toBe(true);
    expect(prior).toEqual(['c-1']);
  });

  it('is set for a Not-confirmed slot even when the share finalized failed (closes unconfirmed-share-invites-resend)', async () => {
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
    seedUnit(world);
    seedShare(world, 'bcast-prior', 'failed', { 'c-1': { status: 'failed', errorCode: SEND_UNCONFIRMED_CODE } });
    const { app } = makeWebhookHarness({ world });
    const { flags, prior } = await previewFlags(app);
    expect(flags.get('c-1')).toBe(true);
    expect(prior).toEqual(['c-1']);
  });

  it('is NOT set for a final failure: a 30007 failure, a 30003 whose promise lapsed, a 30003 whose chain ended unresolved-then-lapsed is Not confirmed instead; a skipped slot never counts (share-skip-fix D5)', async () => {
    seedTenant(world, { contactId: 'c-skipped', phone: '+15550100001' });
    seedTenant(world, { contactId: 'c-final', phone: '+15550100002' });
    seedTenant(world, { contactId: 'c-lapsed', phone: '+15550100003' });
    seedTenant(world, { contactId: 'c-unresolved', phone: '+15550100004' });
    seedUnit(world);
    // Both 30003 rows are young enough to be READ (inside the 24-minute bound),
    // so the verdicts below come from the rows, not from the slot alone.
    const lapsedRoot = attemptKeyAgo(14 * 60_000, 'SMlapsed1');
    seedAttemptRow(world, 'conv-lapsed', lapsedRoot, { retry_due_at: isoFromNow(-10 * 60_000) });
    const unresolvedRoot = attemptKeyAgo(12 * 60_000, 'SMunres1');
    seedAttemptRow(world, 'conv-unresolved', unresolvedRoot, {
      retry_due_at: RETRY_PROMISE_WITHDRAWN_AT,
      retry_outcome: RETRY_OUTCOME_UNCONFIRMED,
    });
    seedShare(world, 'bcast-prior', 'sent', {
      'c-skipped': { status: 'skipped', errorCode: 'manual_mode' },
      'c-final': { status: 'failed', errorCode: '30007', conversationId: 'conv-final', tsMsgId: attemptKeyAgo(5 * 60_000, 'SMfinal1') },
      'c-lapsed': { status: 'failed', errorCode: '30003', conversationId: 'conv-lapsed', tsMsgId: lapsedRoot },
      'c-unresolved': { status: 'failed', errorCode: '30003', conversationId: 'conv-unresolved', tsMsgId: unresolvedRoot },
    });
    const { app } = makeWebhookHarness({ world });
    const { flags, prior } = await previewFlags(app);
    expect(flags.get('c-skipped')).toBe(false);
    expect(flags.get('c-final')).toBe(false);
    expect(flags.get('c-lapsed')).toBe(false);
    expect(flags.get('c-unresolved')).toBe(true);
    // The hand-add annotation reads the SAME set (one rule, one reader).
    expect(prior).toEqual(['c-unresolved']);
  });

  it("is NOT set by a prior DRAFT (queued slots, no record) nor by a FAILED share whose queued slots have no record (stranded); IS set for a failed share's queued slot that has a live record", async () => {
    seedTenant(world, { contactId: 'c-draft', phone: '+15550100001' });
    seedTenant(world, { contactId: 'c-strand', phone: '+15550100002' });
    seedTenant(world, { contactId: 'c-live', phone: '+15550100003' });
    seedUnit(world);
    seedShare(world, 'bcast-draft', 'draft', { 'c-draft': { status: 'queued' } });
    // The route marked this share failed on an enqueue throw, but its pass ran
    // anyway for c-live (a record exists): the text may be out.
    seedShare(world, 'bcast-failed', 'failed', { 'c-strand': { status: 'queued' }, 'c-live': { status: 'queued' } }, { last_error: 'enqueue failed' });
    await world.sendAttemptsRepo.claim(
      { kind: 'broadcast', broadcastId: 'bcast-failed', contactKey: 'c-live' },
      SEED_ATTEMPT_FACTS,
      new Date().toISOString(),
    );
    const { app } = makeWebhookHarness({ world });
    const { flags, prior } = await previewFlags(app);
    expect(flags.get('c-draft')).toBe(false);
    expect(flags.get('c-strand')).toBe(false);
    expect(flags.get('c-live')).toBe(true);
    expect(prior).toEqual(['c-live']);
  });

  it('a failed row read never empties the set (the safe direction)', async () => {
    seedTenant(world, { contactId: 'c-pending', phone: '+15550100001' });
    seedTenant(world, { contactId: 'c-reached', phone: '+15550100002' });
    seedUnit(world);
    // Read successfully, this LAPSED row would drop c-pending: only the safe
    // direction of a failed read keeps the tenant flagged.
    const root = attemptKeyAgo(14 * 60_000, 'SMpend1');
    seedAttemptRow(world, 'conv-pending', root, { retry_due_at: isoFromNow(-10 * 60_000) });
    seedShare(world, 'bcast-prior', 'sent', {
      'c-pending': { status: 'failed', errorCode: '30003', conversationId: 'conv-pending', tsMsgId: root },
      'c-reached': { status: 'sent' },
    });
    const { app, capture } = makeWebhookHarness({ world });
    const reads = vi.spyOn(world.messagesRepo, 'getByTsMsgIdConsistent').mockRejectedValue(new Error('boom'));
    const { flags, prior } = await previewFlags(app);
    expect(reads).toHaveBeenCalled();
    expect(flags.get('c-pending')).toBe(true);
    expect(flags.get('c-reached')).toBe(true);
    expect(prior).toEqual(['c-pending', 'c-reached']);
    expect(capture.atLevel(40).some((l) => String(l['msg']).includes('attempt row read failed'))).toBe(true);
  });

  // --- S4: GET results/list return DERIVED disjoint stats -------------------
  const FILTER = { contact_type: 'tenant' as const, excludeOptedOut: true, excludeUnreachable: true };

  it('S4: GET results returns DERIVED disjoint stats (ignores stale persisted counters)', async () => {
    const { app } = makeWebhookHarness({ world });
    const created = await world.broadcastsRepo.create({ created_by: 'u', audience_filter: FILTER, body_template: 'hi' });
    const row = world.broadcasts.get(created.broadcastId)!;
    row.status = 'sent';
    row.audience_mode = 'seeds_only'; // Matching sends: mode rides the wire
    row.recipients = {
      'c-1': { status: 'delivered' },
      // carrier-confirmed -> the SENT bucket (a bare 'sent' slot would derive
      // as in-flight/queued until the carrier's callback stamps the marker).
      'c-2': { status: 'sent', carrierSentAt: '2026-07-16T00:00:01.000Z' },
      'c-3': { status: 'skipped', errorCode: 'no_consent' },
      'c-4': { status: 'skipped' },
    };
    // Deliberately stale / double-counted persisted counters.
    row.stats = { audience: 4, sent: 4, delivered: 4, failed: 0, skipped_opted_out: 0, skipped_no_consent: 0, queued: 0 };

    const res = await request(app)
      .get(`/api/broadcasts/${created.broadcastId}/results`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    // audience_mode passes through the results payload when set on the row.
    expect(res.body.audience_mode).toBe('seeds_only');
    expect(res.body.stats).toEqual({
      audience: 4,
      delivered: 1,
      sent: 1,
      failed: 0,
      unconfirmed: 0,
      skipped_no_consent: 1,
      skipped_opted_out: 1,
      skipped_other: 0,
      queued: 0,
      sending: 0,
      // share-sent-outcome D4: the route always carries the true count.
      retry_pending: 0,
    });
  });

  it('S4: GET list summaries return DERIVED disjoint stats', async () => {
    const { app } = makeWebhookHarness({ world });
    const created = await world.broadcastsRepo.create({ created_by: 'u', audience_filter: FILTER, body_template: 'hi' });
    const row = world.broadcasts.get(created.broadcastId)!;
    row.status = 'sent';
    row.recipients = { 'c-1': { status: 'delivered' }, 'c-2': { status: 'failed' } };
    row.stats = { audience: 2, sent: 2, delivered: 2, failed: 2, skipped_opted_out: 0, skipped_no_consent: 0, queued: 0 };

    const res = await request(app)
      .get('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    const summary = res.body.broadcasts.find((b: { broadcastId: string }) => b.broadcastId === created.broadcastId);
    expect(summary.stats).toMatchObject({ audience: 2, delivered: 1, failed: 1, sent: 0 });
  });

  // --- share-sent-outcome D3/D4: promise facts, retry_pending, ?view=stats ---
  /** GET with the authed session. */
  async function authedGet(app: import('express').Express, path: string) {
    return request(app).get(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
  }

  it('results: a failed-30003 recipient whose row holds a live promise carries retryDueAt, latestAttempt and retryPending, and stats.retry_pending counts it', async () => {
    const root = attemptKeyAgo(6 * 60_000, 'SMroot1');
    const retry = attemptKeyAgo(3 * 60_000, 'SMretry1');
    const dueAt = isoFromNow(5 * 60_000);
    // The RETRY (the newest attempt) failed 30003 too and holds the promise.
    seedAttemptRow(world, 'conv-1', retry, { retry_due_at: dueAt, retry_of: root });
    seedShare(world, 'b-1', 'sent', {
      'c-1': { status: 'failed', errorCode: '30003', conversationId: 'conv-1', tsMsgId: root, latestAttempt: retry },
      'c-2': { status: 'delivered', conversationId: 'conv-2', tsMsgId: attemptKeyAgo(6 * 60_000, 'SMroot2') },
    });
    const { app } = makeWebhookHarness({ world });
    const res = await authedGet(app, '/api/broadcasts/b-1/results');
    expect(res.status).toBe(200);
    expect(res.body.recipients['c-1']).toMatchObject({
      status: 'failed',
      errorCode: '30003',
      tsMsgId: root,
      retryDueAt: dueAt,
      latestAttempt: retry,
      retryPending: true,
    });
    // A reached recipient carries no promise facts.
    expect(res.body.recipients['c-2']).not.toHaveProperty('retryDueAt');
    expect(res.body.recipients['c-2']).not.toHaveProperty('retryPending');
    expect(res.body.stats).toMatchObject({ delivered: 1, failed: 1, retry_pending: 1 });
  });

  it('results: a recipient whose chain ended unresolved carries retryOutcome unconfirmed, is counted in stats.unconfirmed (not failed), and has no live promise; an old 30003 failure carries neither (no read)', async () => {
    const root = attemptKeyAgo(12 * 60_000, 'SMroot1');
    seedAttemptRow(world, 'conv-1', root, { retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: RETRY_OUTCOME_UNCONFIRMED });
    const old = attemptKeyAgo(40 * 60_000, 'SMold2');
    // Its row still holds a promise, but a 40-minute-old slot is past the read
    // bound: the slot alone is authoritative and nothing reads the row.
    seedAttemptRow(world, 'conv-2', old, { retry_due_at: isoFromNow(5 * 60_000) });
    seedShare(world, 'b-2', 'failed', {
      'c-1': { status: 'failed', errorCode: '30003', conversationId: 'conv-1', tsMsgId: root },
      'c-2': { status: 'failed', errorCode: '30003', conversationId: 'conv-2', tsMsgId: old },
    });
    const { app } = makeWebhookHarness({ world });
    const reads = vi.spyOn(world.messagesRepo, 'getByTsMsgIdConsistent');
    const res = await authedGet(app, '/api/broadcasts/b-2/results');
    expect(res.status).toBe(200);
    expect(res.body.recipients['c-1']).toMatchObject({ retryOutcome: 'unconfirmed' });
    // The row is the one source (I5): the route returns what it holds - here the
    // WITHDRAWN sentinel, which is never live - and the page judges liveness.
    expect(isRetryPromiseLive(res.body.recipients['c-1'].retryDueAt, Date.now())).toBe(false);
    expect(res.body.recipients['c-1']).not.toHaveProperty('retryPending');
    expect(res.body.recipients['c-2']).not.toHaveProperty('retryOutcome');
    expect(res.body.recipients['c-2']).not.toHaveProperty('retryDueAt');
    expect(reads.mock.calls.map((c) => c[1])).toEqual([root]);
    expect(res.body.stats).toMatchObject({ failed: 1, unconfirmed: 1, retry_pending: 0 });
  });

  it('results: a pending recipient whose row read FAILED is still marked retryPending (no retryDueAt) and counted (deviation 14)', async () => {
    const root = attemptKeyAgo(3 * 60_000, 'SMroot1');
    seedShare(world, 'b-1', 'sent', {
      'c-1': { status: 'failed', errorCode: '30003', conversationId: 'conv-1', tsMsgId: root },
    });
    const { app } = makeWebhookHarness({ world });
    vi.spyOn(world.messagesRepo, 'getByTsMsgIdConsistent').mockRejectedValue(new Error('boom'));
    const res = await authedGet(app, '/api/broadcasts/b-1/results');
    expect(res.status).toBe(200);
    expect(res.body.recipients['c-1']).toMatchObject({ status: 'failed', retryPending: true });
    expect(res.body.recipients['c-1']).not.toHaveProperty('retryDueAt');
    expect(res.body.stats).toMatchObject({ failed: 1, retry_pending: 1 });
  });

  it('results and list read NO send-attempt records (the composer flag alone reads them)', async () => {
    // A queued slot of a FINISHED share is exactly what the composer flag reads
    // a record for; these routes read it as in flight without one.
    seedShare(world, 'b-1', 'failed', { 'c-q': { status: 'queued' }, 'c-1': { status: 'delivered' } }, { last_error: 'enqueue failed' });
    const { app } = makeWebhookHarness({ world });
    const reads = vi.spyOn(world.sendAttemptsRepo, 'get');
    expect((await authedGet(app, '/api/broadcasts/b-1/results')).status).toBe(200);
    expect((await authedGet(app, '/api/broadcasts/b-1/results?view=stats')).status).toBe(200);
    expect((await authedGet(app, '/api/broadcasts')).status).toBe(200);
    expect(reads).not.toHaveBeenCalled();
  });

  it('results ?view=stats returns the share and its stats with retry_pending, no recipients, and reads no contacts', async () => {
    seedTenant(world, { contactId: 'c-1', firstName: 'Ann', phone: '+15550100001' });
    const root = attemptKeyAgo(2 * 60_000, 'SMroot1');
    seedAttemptRow(world, 'conv-1', root, { retry_due_at: isoFromNow(5 * 60_000) });
    const share = seedShare(world, 'b-1', 'sent', {
      'c-1': { status: 'failed', errorCode: '30003', conversationId: 'conv-1', tsMsgId: root },
    });
    const { app } = makeWebhookHarness({ world });
    const contactReads = vi.spyOn(world.contactsRepo, 'getDisplaysByIds');
    const res = await authedGet(app, '/api/broadcasts/b-1/results?view=stats');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ broadcastId: 'b-1', status: 'sent', unitId: 'unit-1', stats: { failed: 1, retry_pending: 1 } });
    expect(Object.keys(res.body).sort()).toEqual(['broadcastId', 'created_at', 'stats', 'status', 'unitId']);
    expect(res.body.created_at).toBe(share.created_at);
    expect(res.body.recipients).toBeUndefined();
    expect(contactReads).not.toHaveBeenCalled();
  });

  it('results ?view=other is 400 invalid_view (stats is the only accepted value)', async () => {
    seedShare(world, 'b-1', 'sent', { 'c-1': { status: 'delivered' } });
    const { app } = makeWebhookHarness({ world });
    for (const path of ['/api/broadcasts/b-1/results?view=other', '/api/broadcasts/b-1/results?view=stats&view=stats']) {
      const res = await authedGet(app, path);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_view' });
    }
  });

  it('results reads the share CONSISTENTLY in both views - the list refetches a finished share ~400 ms after the write whose event triggered it, and no later event corrects a stale read (code review R2-1); a missing share is still 404', async () => {
    seedShare(world, 'b-1', 'sent', { 'c-1': { status: 'delivered' } });
    const { app } = makeWebhookHarness({ world });
    // The double's consistent read delegates THROUGH getById (a spy on getById
    // would see it), so the consistent spy reads the unspied original instead.
    const read = world.broadcastsRepo.getById;
    const consistent = vi.spyOn(world.broadcastsRepo, 'getByIdConsistent').mockImplementation((id) => read(id));
    const eventual = vi.spyOn(world.broadcastsRepo, 'getById');
    expect((await authedGet(app, '/api/broadcasts/b-1/results')).status).toBe(200);
    expect(consistent).toHaveBeenCalledTimes(1);
    expect((await authedGet(app, '/api/broadcasts/b-1/results?view=stats')).status).toBe(200);
    expect(consistent).toHaveBeenCalledTimes(2);
    expect(consistent.mock.calls).toEqual([['b-1'], ['b-1']]);
    for (const path of ['/api/broadcasts/b-gone/results', '/api/broadcasts/b-gone/results?view=stats']) {
      const res = await authedGet(app, path);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'broadcast_not_found' });
    }
    expect(consistent).toHaveBeenCalledTimes(4);
    expect(eventual).not.toHaveBeenCalled();
  });

  it('list: every summary carries stats.retry_pending (0 when nothing is pending) and the same Not-confirmed re-bucketing as results; only a young failed-30003 slot costs a read', async () => {
    const pendingRoot = attemptKeyAgo(2 * 60_000, 'SMpend1');
    seedAttemptRow(world, 'conv-p', pendingRoot, { retry_due_at: isoFromNow(5 * 60_000) });
    const unresolvedRoot = attemptKeyAgo(12 * 60_000, 'SMunres1');
    seedAttemptRow(world, 'conv-u', unresolvedRoot, { retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: RETRY_OUTCOME_UNCONFIRMED });
    seedShare(world, 'b-pending', 'sent', {
      'c-p': { status: 'failed', errorCode: '30003', conversationId: 'conv-p', tsMsgId: pendingRoot },
    });
    seedShare(world, 'b-unresolved', 'failed', {
      'c-u': { status: 'failed', errorCode: '30003', conversationId: 'conv-u', tsMsgId: unresolvedRoot },
    });
    seedShare(world, 'b-plain', 'sent', { 'c-1': { status: 'delivered' }, 'c-2': { status: 'failed', errorCode: '30007' } });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const draft = await createDraft(app); // a draft's stats carry the count too
    const reads = vi.spyOn(world.messagesRepo, 'getByTsMsgIdConsistent');
    const res = await authedGet(app, '/api/broadcasts');
    expect(res.status).toBe(200);
    const rows = res.body.broadcasts as Array<{ broadcastId: string; stats: BroadcastStats }>;
    expect(rows.every((b) => typeof b.stats.retry_pending === 'number')).toBe(true);
    const byId = new Map(rows.map((b) => [b.broadcastId, b.stats]));
    expect(byId.get('b-pending')).toMatchObject({ failed: 1, retry_pending: 1 });
    expect(byId.get('b-unresolved')).toMatchObject({ failed: 0, unconfirmed: 1, retry_pending: 0 });
    expect(byId.get('b-plain')).toMatchObject({ delivered: 1, failed: 1, retry_pending: 0 });
    expect(byId.get(draft)).toMatchObject({ retry_pending: 0 });
    expect(reads.mock.calls.map((c) => c[1]).sort()).toEqual([pendingRoot, unresolvedRoot].sort());
  });

  // --- S5: results endpoint enriches recipients with raw identity ----------
  it('S5: enriches contactId recipients with raw firstName/lastName/phone (no server-composed name)', async () => {
    seedTenant(world, { contactId: 'c-1', firstName: 'Ann', phone: '+15550100001', lastName: 'Lee' } as Partial<ContactItem>);
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const id = await createDraft(app);
    await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ recipientContactIds: ['c-1'] });
    await queueAdapter.settle();

    const res = await request(app)
      .get(`/api/broadcasts/${id}/results`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    const entry = res.body.recipients['c-1'];
    expect(entry).toMatchObject({ firstName: 'Ann', lastName: 'Lee', phone: '+15550100001', status: 'sent' });
    // The server ships RAW fields only; name composition stays in the dashboard.
    expect(entry).not.toHaveProperty('name');
  });

  it('S5: a phone#<E164> recipient key takes phone from the key (no lookup)', async () => {
    const { app } = makeWebhookHarness({ world });
    const created = await world.broadcastsRepo.create({ created_by: 'u', audience_filter: FILTER, body_template: 'hi' });
    await world.broadcastsRepo.markSending(created.broadcastId, { 'phone#+15550100077': { status: 'sent' } });

    const res = await request(app)
      .get(`/api/broadcasts/${created.broadcastId}/results`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    const entry = res.body.recipients['phone#+15550100077'];
    expect(entry).toMatchObject({ phone: '+15550100077', status: 'sent' });
    expect(entry).not.toHaveProperty('firstName');
  });

  it('S5: a deleted/unresolvable contactId recipient omits the identity fields (never leaks the raw key)', async () => {
    const { app } = makeWebhookHarness({ world });
    const created = await world.broadcastsRepo.create({ created_by: 'u', audience_filter: FILTER, body_template: 'hi' });
    // 'c-ghost' has no contact in the world.
    await world.broadcastsRepo.markSending(created.broadcastId, { 'c-ghost': { status: 'sent' } });

    const res = await request(app)
      .get(`/api/broadcasts/${created.broadcastId}/results`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    const entry = res.body.recipients['c-ghost'];
    expect(entry.status).toBe('sent');
    expect(entry).not.toHaveProperty('firstName');
    expect(entry).not.toHaveProperty('lastName');
    expect(entry).not.toHaveProperty('phone');
  });

  it('S5: the results route never logs recipient names or phones (PII, doc section 9)', async () => {
    seedTenant(world, { contactId: 'c-1', firstName: 'Ann', phone: '+15550100001', lastName: 'Lee' } as Partial<ContactItem>);
    seedUnit(world);
    const { app, capture } = makeWebhookHarness({ world });
    const id = await createDraft(app);
    await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ recipientContactIds: ['c-1'] });
    await queueAdapter.settle();
    capture.lines.length = 0; // focus on the results request's log lines

    await request(app)
      .get(`/api/broadcasts/${id}/results`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    const dump = JSON.stringify(capture.lines);
    expect(dump).not.toContain('+15550100001');
    expect(dump).not.toContain('Ann');
    expect(dump).not.toContain('Lee');
  });

  // --- Matching sends: seeds + audience_mode on the draft (create path) ------
  it('createDraft with seedContactIds and NO audience_filter stores a seeds_only draft and estimates from the seeds', async () => {
    const app = makeWebhookHarness({ world }).app;
    seedTenant(world, { contactId: 'c-seed', phone: '+15550001001', firstName: 'Brianna' });
    seedTenant(world, { contactId: 'c-other', phone: '+15550001002' }); // must NOT count
    const unitId = seedUnit(world).unitId;
    const res = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId, body_template: 'Hi!', seedContactIds: ['c-seed'] });
    expect(res.status).toBe(201);
    expect(res.body.estimatedCount).toBe(1); // seeds only, not the whole tenant base
    expect(typeof res.body.flyerUrl).toBe('string');
    expect(res.body.flyerUrl).toContain(`/p/${unitId}`);
    const stored = world.broadcasts.get(res.body.broadcastId);
    expect(stored?.seed_contact_ids).toEqual(['c-seed']);
    expect(stored?.audience_mode).toBe('seeds_only');
  });

  // group-texting A8, consumer 6 of 6 (broadcasts.ts resolveSeeds - staff
  // display 2). A hand-picked group member previews as consent-not-recorded.
  it('preview shows has_consent FALSE for a seeded SILENT GROUP MEMBER', async () => {
    const app = makeWebhookHarness({ world }).app;
    seedTenant(world, {
      contactId: 'c-groupmember',
      phone: '+15550001009',
      consent_method: undefined,
      group_participation_at: '2026-08-10T12:00:00.000Z',
    });
    const unitId = seedUnit(world).unitId;
    const create = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId, body_template: 'Hi!', seedContactIds: ['c-groupmember'] });
    expect(create.status).toBe(201);

    const preview = await request(app)
      .post(`/api/broadcasts/${create.body.broadcastId}/preview`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});

    expect(preview.status).toBe(200);
    expect(preview.body.candidates).toHaveLength(1);
    expect(preview.body.candidates[0].contactId).toBe('c-groupmember');
    expect(preview.body.candidates[0].has_consent).toBe(false);
  });

  it('createDraft with seedContactIds AND an audience_filter stays in filter mode and estimates the union', async () => {
    const app = makeWebhookHarness({ world }).app;
    seedTenant(world, { contactId: 'c-1', phone: '+15550001001' });
    seedTenant(world, { contactId: 'c-2', phone: '+15550001002' });
    const res = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({
        body_template: 'Hi!',
        audience_filter: { contact_type: 'tenant' },
        seedContactIds: ['c-1'], // already inside the audience: union must not double-count
      });
    expect(res.status).toBe(201);
    expect(res.body.estimatedCount).toBe(2);
    expect(world.broadcasts.get(res.body.broadcastId)?.audience_mode).toBe('filter');
  });

  it('createDraft drops unresolvable seeds from the estimate (unknown id, opted-out)', async () => {
    const app = makeWebhookHarness({ world }).app;
    seedTenant(world, { contactId: 'c-ok', phone: '+15550001001' });
    seedTenant(world, { contactId: 'c-optout', phone: '+15550001002', sms_opt_out: true });
    const res = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ body_template: 'Hi!', seedContactIds: ['c-ok', 'c-optout', 'c-ghost'] });
    expect(res.status).toBe(201);
    expect(res.body.estimatedCount).toBe(1);
  });

  it('createDraft treats an EMPTY seedContactIds like an absent one (stays filter mode)', async () => {
    const app = makeWebhookHarness({ world }).app;
    seedTenant(world, { contactId: 'c-1', phone: '+15550001001' });
    const res = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ body_template: 'Hi!', seedContactIds: [] });
    expect(res.status).toBe(201);
    const stored = world.broadcasts.get(res.body.broadcastId);
    expect(stored?.audience_mode).toBe('filter');
    expect(stored?.seed_contact_ids).toBeUndefined();
  });

  // --- Matching sends: preview unions seeds + reports unresolved (Task 2) -----
  it('preview unions seeds into candidates, flags them seeded, and reports unresolved seeds', async () => {
    const app = makeWebhookHarness({ world }).app;
    seedTenant(world, { contactId: 'c-aud', phone: '+15550001001', voucherSize: 2 });
    seedTenant(world, { contactId: 'c-seed', phone: '+15550001002', voucherSize: 3 }); // outside bedroomSize filter
    const draft = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({
        body_template: 'Hi!',
        audience_filter: { contact_type: 'tenant', bedroomSize: 2 },
        seedContactIds: ['c-seed', 'c-ghost'],
      });
    const res = await request(app)
      .post(`/api/broadcasts/${draft.body.broadcastId}/preview`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(200);
    const byId = new Map(res.body.candidates.map((c: { contactId: string }) => [c.contactId, c]));
    expect(byId.get('c-aud')).toMatchObject({ seeded: false });
    expect(byId.get('c-seed')).toMatchObject({ seeded: true });
    expect(res.body.seedContactIds).toEqual(['c-seed', 'c-ghost']);
    expect(res.body.unresolvedSeedIds).toEqual(['c-ghost']);
  });

  it('preview on a seeds_only draft returns ONLY the seeds (never the whole tenant base)', async () => {
    const app = makeWebhookHarness({ world }).app;
    seedTenant(world, { contactId: 'c-seed', phone: '+15550001001' });
    seedTenant(world, { contactId: 'c-other', phone: '+15550001002' });
    const draft = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ body_template: 'Hi!', seedContactIds: ['c-seed'] });
    const res = await request(app)
      .post(`/api/broadcasts/${draft.body.broadcastId}/preview`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.body.candidates.map((c: { contactId: string }) => c.contactId)).toEqual(['c-seed']);
    expect(res.body.candidates[0]).toMatchObject({ seeded: true });
    expect(res.body.count).toBe(1);
  });

  // --- Matching sends: seeds_only no-body send resolves the seeds (Task 3) -----
  it('send with NO body on a seeds_only draft sends to the seeds (not the whole base)', async () => {
    const app = makeWebhookHarness({ world }).app;
    seedTenant(world, { contactId: 'c-seed', phone: '+15550001001' });
    seedTenant(world, { contactId: 'c-other', phone: '+15550001002' });
    const unitId = seedUnit(world).unitId;
    const draft = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId, body_template: 'Hi [TenantName]!', seedContactIds: ['c-seed'] });
    const res = await request(app)
      .post(`/api/broadcasts/${draft.body.broadcastId}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    await queueAdapter.settle();
    const stored = world.broadcasts.get(draft.body.broadcastId);
    expect(Object.keys(stored?.recipients ?? {})).toEqual(['c-seed']);
  });

  // --- Matching sends: PATCH persists hand-picked seeds (Task 4) --------------
  it('PATCH replaces seedContactIds on a draft', async () => {
    const app = makeWebhookHarness({ world }).app;
    seedTenant(world, { contactId: 'c-1', phone: '+15550001001' });
    seedUnit(world);
    const id = await createDraft(app);
    const res = await request(app)
      .patch(`/api/broadcasts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ seedContactIds: ['c-1'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ broadcastId: id, seedContactIds: ['c-1'] });
    expect(world.broadcasts.get(id)?.seed_contact_ids).toEqual(['c-1']);
  });

  it('PATCH de-dupes and trims the seedContactIds it stores', async () => {
    const app = makeWebhookHarness({ world }).app;
    seedTenant(world, { contactId: 'c-1', phone: '+15550001001' });
    seedTenant(world, { contactId: 'c-2', phone: '+15550001002' });
    seedUnit(world);
    const id = await createDraft(app);
    const res = await request(app)
      .patch(`/api/broadcasts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ seedContactIds: [' c-1 ', 'c-1', 'c-2'] });
    expect(res.status).toBe(200);
    expect(res.body.seedContactIds).toEqual(['c-1', 'c-2']);
    expect(world.broadcasts.get(id)?.seed_contact_ids).toEqual(['c-1', 'c-2']);
  });

  it('PATCH with an EMPTY array clears the seed list (valid — unlike create)', async () => {
    const app = makeWebhookHarness({ world }).app;
    seedTenant(world, { contactId: 'c-1', phone: '+15550001001' });
    seedUnit(world);
    // Start with a seeded draft, then clear it via PATCH.
    const draft = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'hi', seedContactIds: ['c-1'] });
    const id = draft.body.broadcastId as string;
    expect(world.broadcasts.get(id)?.seed_contact_ids).toEqual(['c-1']);
    const res = await request(app)
      .patch(`/api/broadcasts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ seedContactIds: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ broadcastId: id, seedContactIds: [] });
    expect(world.broadcasts.get(id)?.seed_contact_ids).toEqual([]);
  });

  it('PATCH with an absent/malformed seedContactIds → 400 bad_request', async () => {
    const app = makeWebhookHarness({ world }).app;
    seedTenant(world, { contactId: 'c-1', phone: '+15550001001' });
    seedUnit(world);
    const id = await createDraft(app);
    // Absent.
    const absent = await request(app)
      .patch(`/api/broadcasts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(absent.status).toBe(400);
    expect(absent.body.error).toBe('bad_request');
    // Malformed (non-string element).
    const malformed = await request(app)
      .patch(`/api/broadcasts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ seedContactIds: [123] });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe('bad_request');
  });

  it('PATCH on a missing broadcast → 404 broadcast_not_found', async () => {
    const app = makeWebhookHarness({ world }).app;
    const res = await request(app)
      .patch('/api/broadcasts/bcast-does-not-exist')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ seedContactIds: ['c-1'] });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('broadcast_not_found');
  });

  it('PATCH on a non-draft returns 409 broadcast_not_draft', async () => {
    const app = makeWebhookHarness({ world }).app;
    seedTenant(world, { contactId: 'c-1', phone: '+15550001001' });
    seedUnit(world);
    const id = await createDraft(app);
    await request(app)
      .post(`/api/broadcasts/${id}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ recipientContactIds: ['c-1'] });
    await queueAdapter.settle();
    const res = await request(app)
      .patch(`/api/broadcasts/${id}`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ seedContactIds: ['c-1'] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('broadcast_not_draft');
  });

  it('PATCH requires auth (no cookie → 401/403)', async () => {
    const app = makeWebhookHarness({ world }).app;
    const res = await request(app)
      .patch('/api/broadcasts/bcast-anything')
      .set('x-origin-verify', ORIGIN_SECRET)
      .send({ seedContactIds: ['c-1'] });
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(404);
  });

  describe('send guard: unit availability (spec 2026-07-10)', () => {
    async function draftWithUnit(app: import('express').Express): Promise<string> {
      const create = await request(app)
        .post('/api/broadcasts')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({
          unitId: 'unit-1',
          body_template: 'Hi [TenantName], see [FlyerLink]',
          audience_filter: { contact_type: 'tenant' },
        });
      expect(create.status).toBe(201);
      return create.body.broadcastId as string;
    }

    it('refuses to send when the unit is not available (flyer link would be dead)', async () => {
      seedTenant(world, { contactId: 'c-1' });
      const unit = seedUnit(world);
      unit.status = 'on_hold'; // any non-shareable status
      const { app } = makeWebhookHarness({ world });
      const id = await draftWithUnit(app);

      const res = await request(app)
        .post(`/api/broadcasts/${id}/send`)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ recipientContactIds: ['c-1'] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('unit_not_available');
      // The broadcast is untouched - still a sendable draft.
      const after = await world.broadcastsRepo.getById(id);
      expect(after?.status).toBe('draft');
    });

    it('refuses when the unit was deleted after the draft was created', async () => {
      seedTenant(world, { contactId: 'c-1' });
      seedUnit(world); // available at create time
      const { app } = makeWebhookHarness({ world });
      const id = await draftWithUnit(app);
      world.units.delete('unit-1'); // gone by send time

      const res = await request(app)
        .post(`/api/broadcasts/${id}/send`)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ recipientContactIds: ['c-1'] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('unit_not_available');
    });

    it('a broadcast with NO attached unit sends without any unit lookup', async () => {
      seedTenant(world, { contactId: 'c-1' });
      const { app } = makeWebhookHarness({ world });
      const create = await request(app)
        .post('/api/broadcasts')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ body_template: 'hi', audience_filter: { contact_type: 'tenant' } });
      expect(create.status).toBe(201);

      const res = await request(app)
        .post(`/api/broadcasts/${create.body.broadcastId}/send`)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ recipientContactIds: ['c-1'] });

      expect(res.status).toBe(200);
    });
  });

  // --- Organization names on the housing authority filter (spec 2026-10-06:
  // D5 at draft create; D7 at preview and at the filter-resolving send) -----
  describe('organization names on the housing authority filter (spec D5, D7)', () => {
    /** A stored audience filter holding `housing_authority` exactly as written. */
    const filterFor = (housing_authority: string): BroadcastItem['audience_filter'] => ({
      contact_type: 'tenant',
      housing_authority,
      excludeOptedOut: true,
      excludeUnreachable: true,
    });

    function postDraft(app: import('express').Express, housingAuthority: string) {
      return request(app)
        .post('/api/broadcasts')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({
          unitId: 'unit-1',
          body_template: 'hi',
          audience_filter: { contact_type: 'tenant', housing_authority: housingAuthority },
        });
    }

    /** The names of a 422's candidate / otherKind refs, sorted (order is not the contract). */
    function names(refs: Array<{ name: string }>): string[] {
      return refs.map((r) => r.name).sort();
    }

    it('POST stores an exact list name, and the 201 echoes the stored filter', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const res = await postDraft(app, 'Atlanta Housing Authority');
      expect(res.status).toBe(201);
      expect(res.body.audience_filter).toEqual(filterFor('Atlanta Housing Authority'));
      expect(world.broadcasts.get(res.body.broadcastId)?.audience_filter).toEqual(
        filterFor('Atlanta Housing Authority'),
      );
    });

    it('POST stores a unique spelling as the exact name, and the estimate counts holders of the NAME', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-org-name-1', housingAuthority: 'Atlanta Housing Authority' } as Partial<ContactItem>);
      seedTenant(world, { contactId: 'c-org-name-2', housingAuthority: 'Atlanta Housing Authority' } as Partial<ContactItem>);
      seedTenant(world, { contactId: 'c-org-slug', housingAuthority: 'atlanta_housing' } as Partial<ContactItem>);
      const { app } = makeWebhookHarness({ world });
      const res = await postDraft(app, 'atlanta_housing');
      expect(res.status).toBe(201);
      expect(res.body.audience_filter.housing_authority).toBe('Atlanta Housing Authority');
      // The estimate resolved the NAME (two holders), not the slug (one holder).
      expect(res.body.estimatedCount).toBe(2);
      expect(world.broadcasts.get(res.body.broadcastId)?.audience_filter.housing_authority).toBe(
        'Atlanta Housing Authority',
      );
    });

    it('POST refuses an ambiguous spelling: 422 (field audience_filter), no row, no audit', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const res = await postDraft(app, 'AHA');
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        error: 'org_not_on_list',
        field: 'audience_filter',
        text: 'AHA',
        close: [],
      });
      expect(names(res.body.candidates)).toEqual(['Atlanta Housing Authority', 'Augusta Housing Authority']);
      expect(world.broadcasts.size).toBe(0);
      expect(world.auditEvents.filter((e) => e.event_type === 'broadcast_created')).toHaveLength(0);
    });

    it('POST refuses an agency name, naming it in otherKind', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const res = await postDraft(app, 'Step Up');
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: 'org_not_on_list', field: 'audience_filter', candidates: [] });
      expect(names(res.body.otherKind)).toEqual(['Step Up']);
      expect(world.broadcasts.size).toBe(0);
    });

    it('(PIN) every 400 and the unit 404 still come before the 422', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const create = (body: Record<string, unknown>) =>
        request(app)
          .post('/api/broadcasts')
          .set('x-origin-verify', ORIGIN_SECRET)
          .set('cookie', TEST_SESSION_COOKIE)
          .send(body);
      const filter = { contact_type: 'tenant', housing_authority: 'AHA' };
      const noTemplate = await create({ audience_filter: filter });
      expect(noTemplate.status).toBe(400);
      const badSeeds = await create({ body_template: 'hi', audience_filter: filter, seedContactIds: 'c-1' });
      expect(badSeeds.status).toBe(400);
      const badUnit = await create({ unitId: 'unit-nope', body_template: 'hi', audience_filter: filter });
      expect(badUnit.status).toBe(404);
      expect(badUnit.body).toEqual({ error: 'unit_not_found' });
    });

    function act(
      app: import('express').Express,
      broadcastId: string,
      verb: 'preview' | 'send',
      body: Record<string, unknown> = {},
    ) {
      return request(app)
        .post(`/api/broadcasts/${broadcastId}/${verb}`)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send(body);
    }

    it('preview re-checks a DRAFT: a stored spelling is 422 with its entry as the one candidate', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-org-1', housingAuthority: 'atlanta_housing' } as Partial<ContactItem>);
      seedShare(world, 'bcast-org-slug', 'draft', {}, { audience_filter: filterFor('atlanta_housing') });
      const { app } = makeWebhookHarness({ world });
      const res = await act(app, 'bcast-org-slug', 'preview');
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        error: 'org_not_on_list',
        field: 'audience_filter',
        text: 'atlanta_housing',
        close: [],
      });
      expect(res.body.candidates).toEqual([
        expect.objectContaining({ kind: 'housing_authority', name: 'Atlanta Housing Authority' }),
      ]);
    });

    it('preview re-checks a DRAFT: a stored agency name is 422 with otherKind', async () => {
      seedUnit(world);
      seedShare(world, 'bcast-org-agency', 'draft', {}, { audience_filter: filterFor('Step Up') });
      const { app } = makeWebhookHarness({ world });
      const res = await act(app, 'bcast-org-agency', 'preview');
      expect(res.status).toBe(422);
      expect(names(res.body.otherKind)).toEqual(['Step Up']);
    });

    it('the filter-resolving send re-checks the stored filter: 422, still a draft, nothing sent', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-org-1', housingAuthority: 'atlanta_housing' } as Partial<ContactItem>);
      seedShare(world, 'bcast-org-send', 'draft', {}, { audience_filter: filterFor('atlanta_housing') });
      const { app } = makeWebhookHarness({ world });
      const res = await act(app, 'bcast-org-send', 'send');
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: 'org_not_on_list', field: 'audience_filter', text: 'atlanta_housing' });
      await queueAdapter.settle();
      expect(world.broadcasts.get('bcast-org-send')?.status).toBe('draft');
      expect(world.sent).toHaveLength(0);
    });

    it('(PIN) the curated send (recipientContactIds) is not re-checked', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-org-1', housingAuthority: 'atlanta_housing' } as Partial<ContactItem>);
      seedShare(world, 'bcast-org-curated', 'draft', {}, { audience_filter: filterFor('atlanta_housing') });
      const { app } = makeWebhookHarness({ world });
      const res = await act(app, 'bcast-org-curated', 'send', { recipientContactIds: ['c-org-1'] });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('sending');
    });

    it('(PIN) a seeds_only draft never reads its filter: preview and the no-body send both pass', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-org-1' });
      seedShare(world, 'bcast-org-seeds', 'draft', {}, {
        audience_filter: filterFor('Nowhere Housing Authority'),
        audience_mode: 'seeds_only',
        seed_contact_ids: ['c-org-1'],
      });
      const { app } = makeWebhookHarness({ world });
      const preview = await act(app, 'bcast-org-seeds', 'preview');
      expect(preview.status).toBe(200);
      const send = await act(app, 'bcast-org-seeds', 'send');
      expect(send.status).toBe(200);
    });

    it('(PIN) a draft whose stored filter is an exact list name previews and sends', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-org-1', housingAuthority: 'Atlanta Housing Authority' } as Partial<ContactItem>);
      seedShare(world, 'bcast-org-exact', 'draft', {}, { audience_filter: filterFor('Atlanta Housing Authority') });
      const { app } = makeWebhookHarness({ world });
      const preview = await act(app, 'bcast-org-exact', 'preview');
      expect(preview.status).toBe(200);
      expect(preview.body.count).toBe(1);
      const send = await act(app, 'bcast-org-exact', 'send');
      expect(send.status).toBe(200);
      expect(send.body.count).toBe(1);
    });

    it('(PIN) a SENT share keeps its historical filter: its preview is not re-checked', async () => {
      seedUnit(world);
      seedShare(world, 'bcast-org-sent', 'sent', {}, { audience_filter: filterFor('atlanta_housing') });
      const { app } = makeWebhookHarness({ world });
      const res = await act(app, 'bcast-org-sent', 'preview');
      expect(res.status).toBe(200);
    });
  });

  // --- caseworkers (spec 2026-10-06 D20, plan 3.7): a seed or an explicit
  // recipient may be a TENANT or a PARTNER; a filter stays tenant-only -----
  describe('caseworkers D20: direct shares accept partners', () => {
    const PARTNER_PHONE = '+15550100081';

    /** A consented partner (seedTenant's defaults, re-typed). */
    function seedPartner(overrides: Partial<ContactItem> = {}): ContactItem {
      return seedTenant(world, {
        contactId: 'c-partner',
        type: 'partner',
        status: 'active',
        phone: PARTNER_PHONE,
        firstName: 'Cora',
        lastName: 'Reyes',
        ...overrides,
      });
    }

    function postSeeded(app: import('express').Express, seedContactIds: string[]) {
      return request(app)
        .post('/api/broadcasts')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ unitId: 'unit-1', body_template: 'Hi [TenantName]!', seedContactIds });
    }

    function step(
      app: import('express').Express,
      id: string,
      which: 'preview' | 'send',
      body: Record<string, unknown> = {},
    ) {
      return request(app)
        .post(`/api/broadcasts/${id}/${which}`)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send(body);
    }

    it('a partner seed counts in the draft estimate and previews as a resolved, seeded row', async () => {
      seedUnit(world);
      seedPartner();
      const { app } = makeWebhookHarness({ world });
      const created = await postSeeded(app, ['c-partner']);
      expect(created.status).toBe(201);
      expect(created.body.estimatedCount).toBe(1);
      expect(world.broadcasts.get(created.body.broadcastId)?.audience_mode).toBe('seeds_only');

      const preview = await step(app, created.body.broadcastId, 'preview');
      expect(preview.status).toBe(200);
      expect(preview.body.candidates).toHaveLength(1);
      expect(preview.body.candidates[0]).toMatchObject({
        contactId: 'c-partner',
        firstName: 'Cora',
        lastName: 'Reyes',
        phone: PARTNER_PHONE,
        seeded: true,
        has_consent: true,
      });
      expect(preview.body.unresolvedSeedIds).toEqual([]);
    });

    it('a seeds_only no-body send texts the partner seed', async () => {
      seedUnit(world);
      seedPartner();
      const { app } = makeWebhookHarness({ world });
      const created = await postSeeded(app, ['c-partner']);
      const send = await step(app, created.body.broadcastId, 'send');
      expect(send.status).toBe(200);
      expect(send.body.count).toBe(1);
      expect(Object.keys(world.broadcasts.get(created.body.broadcastId)!.recipients)).toEqual(['c-partner']);
      await queueAdapter.settle();
      expect(world.sent.map((s) => s.to)).toEqual([PARTNER_PHONE]);
    });

    it('an explicit selection keeps tenants and partners and still drops landlord, team member, unknown-type and unknown-id contacts', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-ok', phone: '+15550100082' });
      seedPartner();
      world.contacts.push({ contactId: 'c-ll2', type: 'landlord', status: 'active', phone: '+15550100083' });
      world.contacts.push({ contactId: 'c-team', type: 'team_member', status: 'active', phone: '+15550100084' });
      world.contacts.push({ contactId: 'c-unk', type: 'unknown', status: 'needs_review', phone: '+15550100085' });
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app);
      const send = await step(app, id, 'send', {
        recipientContactIds: ['c-ok', 'c-partner', 'c-ll2', 'c-team', 'c-unk', 'c-missing'],
      });
      expect(send.status).toBe(200);
      expect(send.body.count).toBe(2);
      expect(Object.keys(world.broadcasts.get(id)!.recipients).sort()).toEqual(['c-ok', 'c-partner']);
    });

    it('a partner seed meets every other fence: opted-out, unreachable and phone-less partners (and a landlord) stay unresolved', async () => {
      seedUnit(world);
      seedPartner();
      seedPartner({ contactId: 'c-p-stop', phone: '+15550100086', sms_opt_out: true });
      seedPartner({ contactId: 'c-p-dead', phone: '+15550100087', sms_unreachable: true });
      seedPartner({ contactId: 'c-p-nophone', phone: undefined });
      world.contacts.push({ contactId: 'c-ll-seed', type: 'landlord', status: 'active', phone: '+15550100088' });
      const { app } = makeWebhookHarness({ world });
      const created = await postSeeded(app, ['c-partner', 'c-p-stop', 'c-p-dead', 'c-p-nophone', 'c-ll-seed']);
      const preview = await step(app, created.body.broadcastId, 'preview');
      expect(preview.status).toBe(200);
      expect(preview.body.candidates.map((c: { contactId: string }) => c.contactId)).toEqual(['c-partner']);
      expect(preview.body.unresolvedSeedIds).toEqual(['c-p-stop', 'c-p-dead', 'c-p-nophone', 'c-ll-seed']);
    });

    it('(PIN) a filter-resolved audience stays tenant-only: a partner who is not a seed is never a candidate', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-filter-t', phone: '+15550100089' });
      seedPartner();
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app);
      const preview = await step(app, id, 'preview');
      expect(preview.status).toBe(200);
      expect(preview.body.candidates.map((c: { contactId: string }) => c.contactId)).toEqual(['c-filter-t']);
    });
  });
});
