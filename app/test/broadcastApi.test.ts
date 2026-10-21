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
import type { ListingSendItem } from '../src/repos/listingSendsRepo.js';
import type { TourItem } from '../src/repos/toursRepo.js';
import { SEED } from '../src/lib/seed/lean.js';
import { TOUR_REQUEST_HOLD_MS } from '../src/lib/blastAudienceRules.js';
import { createSendMessageService } from '../src/services/sendMessage.js';
import { applyFlyerShareEntry } from '../src/services/shareLedger.js';
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
    // field). 'searching' is a valid lifecycle value AND one a filter audience
    // reads: matching-blast-rules D1 resolves only searching and onboarding
    // tenants (services/audienceResolution.ts), so a tenant that must be IN a
    // filter audience keeps this default or uses 'onboarding'.
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

  it('matching-blast-rules D1: a filter draft reaches ONLY searching and onboarding tenants, searching first (estimate, preview, no-body send)', async () => {
    seedUnit(world);
    seedTenant(world, { contactId: 'c-onb', status: 'onboarding' });
    seedTenant(world, { contactId: 'c-sea', status: 'searching' });
    for (const status of ['needs_review', 'placing', 'placed', 'on_hold', 'inactive']) {
      seedTenant(world, { contactId: `c-${status}`, status });
    }
    const { app } = makeWebhookHarness({ world });
    const create = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'hi', audience_filter: { contact_type: 'tenant' } });
    expect(create.status).toBe(201);
    expect(create.body.estimatedCount).toBe(2);

    const preview = await request(app)
      .post(`/api/broadcasts/${create.body.broadcastId}/preview`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(preview.status).toBe(200);
    expect(preview.body.candidates.map((c: { contactId: string }) => c.contactId)).toEqual(['c-sea', 'c-onb']);

    const send = await request(app)
      .post(`/api/broadcasts/${create.body.broadcastId}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(send.status).toBe(200);
    expect(send.body.count).toBe(2);
    expect(Object.keys(world.broadcasts.get(create.body.broadcastId)!.recipients).sort()).toEqual([
      'c-onb',
      'c-sea',
    ]);
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
        status: 'searching',
        declinedThisProperty: false,
        // matching-blast-rules D5: the server's default-check rule (no tour
        // hold here, so no tourHold key).
        checkedByDefault: true,
      },
    ]);
    expect(res.body.priorRecipientContactIds).toEqual([]);
    expect(res.body.declinedContactIds).toEqual([]);
    expect(res.body.tourHolds).toEqual([]);
    // D5/D7: the decline-only degrade flag is gone; the seeds_only flag is absent on success.
    expect(res.body).not.toHaveProperty('declineLabelsUnavailable');
    expect(res.body).not.toHaveProperty('audienceRulesUnavailable');
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
    // matching-blast-rules D7: no filter narrows the read any more, so the
    // truncation message gives no narrowing advice (plan AR32: no count).
    expect(send.body.message).toBe('audience resolution was truncated - the audience could not be read completely');
    expect(send.body.truncated).toBe(true);
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

  it('last-heard-from 5.3: an audience candidate carries status and lastHeardFromAt', async () => {
    seedUnit(world);
    seedTenant(world, { contactId: 'c-heard', phone: '+15550100001', last_heard_from_at: '2026-10-03T09:30:00.000Z' });
    const { app } = makeWebhookHarness({ world });
    const id = await createDraft(app);
    const res = await request(app)
      .post(`/api/broadcasts/${id}/preview`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.candidates[0]).toMatchObject({
      contactId: 'c-heard',
      status: 'searching',
      lastHeardFromAt: '2026-10-03T09:30:00.000Z',
    });
  });

  it('last-heard-from 5.3: markSending stores { status: queued } per key - never status or lastHeardFromAt (paths b and c)', async () => {
    seedUnit(world);
    seedTenant(world, { contactId: 'c-1', phone: '+15550100001', last_heard_from_at: '2026-10-03T09:30:00.000Z' });
    seedTenant(world, { contactId: 'c-seed', phone: '+15550100002', last_heard_from_at: '2026-10-04T09:30:00.000Z' });
    const markSending = vi.spyOn(world.broadcastsRepo, 'markSending');
    const { app } = makeWebhookHarness({ world });
    // Path (c): the no-body filter-resolve send snapshots ResolvedContact rows.
    const filterId = await createDraft(app);
    const sendC = await request(app)
      .post(`/api/broadcasts/${filterId}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(sendC.status).toBe(200);
    // Path (b): a seeds_only draft resolves its seeds through resolveSeeds -> buildRecipientsFrom.
    const seeded = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'hi', seedContactIds: ['c-seed'] });
    expect(seeded.status).toBe(201);
    const sendB = await request(app)
      .post(`/api/broadcasts/${seeded.body.broadcastId}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(sendB.status).toBe(200);
    expect(markSending).toHaveBeenCalledTimes(2);
    // Exact equality: any extra field on a slot (status, lastHeardFromAt, ...) fails.
    expect(markSending.mock.calls[0]![1]).toEqual({ 'c-1': { status: 'queued' }, 'c-seed': { status: 'queued' } });
    expect(markSending.mock.calls[1]![1]).toEqual({ 'c-seed': { status: 'queued' } });
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
    /** A LEGACY stored audience filter (saved before matching-blast-rules D2)
     *  holding `housing_authority` exactly as written. Kept as legacy
     *  coverage: storedFilterRefusal and the resolver read it through
     *  authoritiesOfFilter as a one-member list. */
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

    it('POST (LEGACY body string) stores an exact list name as a one-member list, and the 201 echoes the wire filter', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const res = await postDraft(app, 'Atlanta Housing Authority');
      expect(res.status).toBe(201);
      const wire = {
        contact_type: 'tenant',
        housing_authorities: ['Atlanta Housing Authority'],
        excludeOptedOut: true,
        excludeUnreachable: true,
      };
      expect(res.body.audience_filter).toEqual({ ...wire, bedroomSizes: [] });
      expect(res.body.audience_filter).not.toHaveProperty('housing_authority');
      const stored = world.broadcasts.get(res.body.broadcastId)?.audience_filter;
      expect(stored).toEqual(wire);
      expect(stored).not.toHaveProperty('housing_authority');
    });

    it('POST stores a unique spelling as the exact name, and the estimate counts holders of the NAME', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-org-name-1', housingAuthority: 'Atlanta Housing Authority' } as Partial<ContactItem>);
      seedTenant(world, { contactId: 'c-org-name-2', housingAuthority: 'Atlanta Housing Authority' } as Partial<ContactItem>);
      seedTenant(world, { contactId: 'c-org-slug', housingAuthority: 'atlanta_housing' } as Partial<ContactItem>);
      const { app } = makeWebhookHarness({ world });
      const res = await postDraft(app, 'atlanta_housing');
      expect(res.status).toBe(201);
      expect(res.body.audience_filter.housing_authorities).toEqual(['Atlanta Housing Authority']);
      // The estimate resolved the NAME (two holders), not the slug (one holder).
      expect(res.body.estimatedCount).toBe(2);
      expect(world.broadcasts.get(res.body.broadcastId)?.audience_filter.housing_authorities).toEqual([
        'Atlanta Housing Authority',
      ]);
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

    it('(PIN) every 400 and the unit 404 still come before the 422 (legacy string and list alike)', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const create = (body: Record<string, unknown>) =>
        request(app)
          .post('/api/broadcasts')
          .set('x-origin-verify', ORIGIN_SECRET)
          .set('cookie', TEST_SESSION_COOKIE)
          .send(body);
      const filters = [
        { contact_type: 'tenant', housing_authority: 'AHA' },
        { contact_type: 'tenant', housing_authorities: ['Atlanta Housing Authority', 'AHA'] },
      ];
      for (const filter of filters) {
        const noTemplate = await create({ audience_filter: filter });
        expect(noTemplate.status).toBe(400);
        const badSeeds = await create({ body_template: 'hi', audience_filter: filter, seedContactIds: 'c-1' });
        expect(badSeeds.status).toBe(400);
        const badUnit = await create({ unitId: 'unit-nope', body_template: 'hi', audience_filter: filter });
        expect(badUnit.status).toBe(404);
        expect(badUnit.body).toEqual({ error: 'unit_not_found' });
      }
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

  // --- matching-blast-rules D2 (plan Task 1.4): the housing authority LIST at
  // draft create - the shape 400s, the legacy one-string body, the org-list
  // check (the FIRST failing member is the 422) and the stored + echoed
  // list. The estimate here is still today's math (S2 replaces it). ---------
  describe('matching-blast-rules D2: housing_authorities at draft create', () => {
    function postFilter(app: import('express').Express, audience_filter: Record<string, unknown>) {
      return request(app)
        .post('/api/broadcasts')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ unitId: 'unit-1', body_template: 'hi', audience_filter });
    }

    /** The names of a 422's candidate / otherKind refs, sorted (order is not the contract). */
    function names(refs: Array<{ name: string }>): string[] {
      return refs.map((r) => r.name).sort();
    }

    it('stores exact names and unique spellings as entry NAMES - trimmed, blanks dropped, de-duplicated - and echoes the wire filter', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const res = await postFilter(app, {
        contact_type: 'tenant',
        housing_authorities: ['Atlanta Housing Authority', ' DCA ', 'atlanta_housing', '', '   '],
      });
      expect(res.status).toBe(201);
      const wire = {
        contact_type: 'tenant',
        housing_authorities: ['Atlanta Housing Authority', 'Georgia Department of Community Affairs'],
        excludeOptedOut: true,
        excludeUnreachable: true,
      };
      expect(res.body.audience_filter).toEqual({ ...wire, bedroomSizes: [] });
      const stored = world.broadcasts.get(res.body.broadcastId)?.audience_filter;
      expect(stored).toEqual(wire);
      expect(stored).not.toHaveProperty('housing_authority');
    });

    it('LEGACY body: a housing_authority string is a one-member list, stored as housing_authorities', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const res = await postFilter(app, { contact_type: 'tenant', housing_authority: 'atlanta_housing' });
      expect(res.status).toBe(201);
      expect(res.body.audience_filter).toEqual({
        contact_type: 'tenant',
        housing_authorities: ['Atlanta Housing Authority'],
        bedroomSizes: [],
        excludeOptedOut: true,
        excludeUnreachable: true,
      });
      const stored = world.broadcasts.get(res.body.broadcastId)!.audience_filter;
      expect(stored.housing_authorities).toEqual(['Atlanta Housing Authority']);
      expect(stored).not.toHaveProperty('housing_authority');
    });

    it('both keys at once is a 400, and nothing is stored', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const res = await postFilter(app, {
        contact_type: 'tenant',
        housing_authorities: ['Atlanta Housing Authority'],
        housing_authority: 'Atlanta Housing Authority',
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'audience_filter: use housing_authorities only' });
      expect(world.broadcasts.size).toBe(0);
    });

    it('a list that is not an array of at most 100 strings is a 400, and nothing is stored', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const bad: unknown[] = [
        'Atlanta Housing Authority',
        { name: 'Atlanta Housing Authority' },
        ['Atlanta Housing Authority', 7],
        Array.from({ length: 101 }, () => 'Atlanta Housing Authority'),
      ];
      for (const housing_authorities of bad) {
        const res = await postFilter(app, { contact_type: 'tenant', housing_authorities });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({
          error: 'audience_filter.housing_authorities must be an array of at most 100 strings',
        });
      }
      expect(world.broadcasts.size).toBe(0);
    });

    it('exactly 100 members passes the shape guard (and duplicates collapse)', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const res = await postFilter(app, {
        contact_type: 'tenant',
        housing_authorities: Array.from({ length: 100 }, () => 'Atlanta Housing Authority'),
      });
      expect(res.status).toBe(201);
      expect(world.broadcasts.get(res.body.broadcastId)?.audience_filter.housing_authorities).toEqual([
        'Atlanta Housing Authority',
      ]);
    });

    it('the FIRST failing member is the 422 (field audience_filter, text = that member); no row, no audit', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const res = await postFilter(app, {
        contact_type: 'tenant',
        housing_authorities: ['Atlanta Housing Authority', 'AHA', 'Step Up'],
      });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: 'org_not_on_list', field: 'audience_filter', text: 'AHA', close: [] });
      expect(names(res.body.candidates)).toEqual(['Atlanta Housing Authority', 'Augusta Housing Authority']);
      expect(res.body).not.toHaveProperty('otherKind');
      expect(world.broadcasts.size).toBe(0);
      expect(world.auditEvents.filter((e) => e.event_type === 'broadcast_created')).toHaveLength(0);
    });

    it('a LATER member that fails is refused too, naming that member (an agency names otherKind)', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const res = await postFilter(app, { contact_type: 'tenant', housing_authorities: ['DCA', 'Step Up'] });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: 'org_not_on_list', field: 'audience_filter', text: 'Step Up', candidates: [] });
      expect(names(res.body.otherKind)).toEqual(['Step Up']);
      expect(world.broadcasts.size).toBe(0);
    });

    it('(PIN) an empty or all-blank list is no authority filter: no key stored, the org list not read', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      // Spied AFTER the harness is built: the org-names service holds this
      // same object and calls list.get() per request.
      const read = vi.spyOn(world.orgListRepo, 'get');
      for (const housing_authorities of [[], ['  ', '']]) {
        const res = await postFilter(app, { contact_type: 'tenant', housing_authorities });
        expect(res.status).toBe(201);
        expect(res.body.audience_filter).toEqual({ contact_type: 'tenant', bedroomSizes: [], excludeOptedOut: true, excludeUnreachable: true });
        expect(world.broadcasts.get(res.body.broadcastId)?.audience_filter).not.toHaveProperty('housing_authorities');
      }
      expect(read).not.toHaveBeenCalled();
    });

    it('the estimate counts tenants holding ANY listed authority; no authority and a Placing tenant are left out', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-aha', housingAuthority: 'Atlanta Housing Authority' } as Partial<ContactItem>);
      seedTenant(world, {
        contactId: 'c-dca',
        status: 'onboarding',
        housingAuthority: 'Georgia Department of Community Affairs',
      } as Partial<ContactItem>);
      seedTenant(world, { contactId: 'c-dekalb', housingAuthority: 'DeKalb County Housing Authority' } as Partial<ContactItem>);
      seedTenant(world, { contactId: 'c-none' });
      seedTenant(world, {
        contactId: 'c-placing',
        status: 'placing',
        housingAuthority: 'Atlanta Housing Authority',
      } as Partial<ContactItem>);
      const { app } = makeWebhookHarness({ world });
      const res = await postFilter(app, {
        contact_type: 'tenant',
        housing_authorities: ['Atlanta Housing Authority', 'DCA'],
      });
      expect(res.status).toBe(201);
      expect(res.body.estimatedCount).toBe(2);
    });

    // OR-S1-3 (plan AR3): the three ruled parse edges, one row each - null
    // reads as ABSENT for both keys, the LEGACY key keeps its own 400, and
    // "both keys" is decided BEFORE either value's shape.
    interface ParseEdge {
      filter: Record<string, unknown>;
      status: number;
      error?: string;
      stored?: string[];
    }
    const LEGACY_400 = 'audience_filter.housing_authority must be a non-empty string';
    const PARSE_EDGES: Array<[string, ParseEdge]> = [
      [
        'housing_authorities null reads as absent, so the legacy spelling is stored as a one-member list',
        {
          filter: { contact_type: 'tenant', housing_authorities: null, housing_authority: 'atlanta_housing' },
          status: 201,
          stored: ['Atlanta Housing Authority'],
        },
      ],
      [
        'a blank legacy string keeps the legacy 400',
        { filter: { contact_type: 'tenant', housing_authority: '  ' }, status: 400, error: LEGACY_400 },
      ],
      [
        'a non-string legacy value keeps the legacy 400',
        { filter: { contact_type: 'tenant', housing_authority: 7 }, status: 400, error: LEGACY_400 },
      ],
      [
        'both keys is the both-keys 400 before either value is shape-checked',
        {
          filter: { contact_type: 'tenant', housing_authorities: 'x', housing_authority: 'y' },
          status: 400,
          error: 'audience_filter: use housing_authorities only',
        },
      ],
    ];
    it.each(PARSE_EDGES)('AR3 parse edge: %s', async (_name, { filter, status, error, stored }) => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const res = await postFilter(app, filter);
      expect(res.status).toBe(status);
      if (error !== undefined) {
        expect(res.body).toEqual({ error });
        expect(world.broadcasts.size).toBe(0);
      }
      if (stored !== undefined) {
        const row = world.broadcasts.get(res.body.broadcastId)?.audience_filter;
        expect(row?.housing_authorities).toEqual(stored);
        expect(row).not.toHaveProperty('housing_authority');
      }
    });
  });

  // --- matching-blast-rules D2 (plan Task 1.5): a STORED list is re-checked
  // member by member at preview and at the filter-resolving send, and every
  // response that carries a filter answers the wire shape - a legacy row's
  // string as a one-member housing_authorities, never housing_authority. ----
  describe('matching-blast-rules D2: stored lists at preview, send and the projections', () => {
    /** A stored LIST-shaped filter (what draft create writes since D2). */
    const listFilter = (...housing_authorities: string[]): BroadcastItem['audience_filter'] => ({
      contact_type: 'tenant',
      housing_authorities,
      excludeOptedOut: true,
      excludeUnreachable: true,
    });
    /** A LEGACY stored filter (drafts and shares saved before D2). */
    const legacyFilter = (housing_authority: string): BroadcastItem['audience_filter'] => ({
      contact_type: 'tenant',
      housing_authority,
      excludeOptedOut: true,
      excludeUnreachable: true,
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

    /** The names of a 422's candidate / otherKind refs, sorted (order is not the contract). */
    function names(refs: Array<{ name: string }>): string[] {
      return refs.map((r) => r.name).sort();
    }

    it('preview re-checks EVERY member in order: the first not exactly listed is the 422 (one list read)', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', housingAuthority: 'Atlanta Housing Authority' } as Partial<ContactItem>);
      seedShare(world, 'bcast-list-spelling', 'draft', {}, {
        audience_filter: listFilter('Atlanta Housing Authority', 'DCA', 'Step Up'),
      });
      const { app } = makeWebhookHarness({ world });
      // Spied AFTER the harness is built (the service calls list.get() per request).
      const read = vi.spyOn(world.orgListRepo, 'get');
      const res = await act(app, 'bcast-list-spelling', 'preview');
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: 'org_not_on_list', field: 'audience_filter', text: 'DCA', close: [] });
      expect(res.body.candidates).toEqual([
        expect.objectContaining({ kind: 'housing_authority', name: 'Georgia Department of Community Affairs' }),
      ]);
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('preview: a stored agency member is the 422 with otherKind', async () => {
      seedUnit(world);
      seedShare(world, 'bcast-list-agency', 'draft', {}, { audience_filter: listFilter('Step Up', 'DCA') });
      const { app } = makeWebhookHarness({ world });
      const res = await act(app, 'bcast-list-agency', 'preview');
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: 'org_not_on_list', field: 'audience_filter', text: 'Step Up' });
      expect(names(res.body.otherKind)).toEqual(['Step Up']);
    });

    it('the filter-resolving send re-checks every member of the stored list: 422, still a draft, nothing sent', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', housingAuthority: 'Atlanta Housing Authority' } as Partial<ContactItem>);
      seedShare(world, 'bcast-list-send', 'draft', {}, {
        audience_filter: listFilter('Atlanta Housing Authority', 'Nowhere Housing Authority'),
      });
      const { app } = makeWebhookHarness({ world });
      const res = await act(app, 'bcast-list-send', 'send');
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        error: 'org_not_on_list',
        field: 'audience_filter',
        text: 'Nowhere Housing Authority',
      });
      await queueAdapter.settle();
      expect(world.broadcasts.get('bcast-list-send')?.status).toBe('draft');
      expect(world.sent).toHaveLength(0);
    });

    it('(PIN) a stored list of exact names previews and sends to holders of ANY member', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-aha', housingAuthority: 'Atlanta Housing Authority' } as Partial<ContactItem>);
      seedTenant(world, {
        contactId: 'c-dca',
        housingAuthority: 'Georgia Department of Community Affairs',
      } as Partial<ContactItem>);
      seedTenant(world, { contactId: 'c-dekalb', housingAuthority: 'DeKalb County Housing Authority' } as Partial<ContactItem>);
      seedShare(world, 'bcast-list-exact', 'draft', {}, {
        audience_filter: listFilter('Atlanta Housing Authority', 'Georgia Department of Community Affairs'),
      });
      const { app } = makeWebhookHarness({ world });
      const preview = await act(app, 'bcast-list-exact', 'preview');
      expect(preview.status).toBe(200);
      expect(preview.body.count).toBe(2);
      const send = await act(app, 'bcast-list-exact', 'send');
      expect(send.status).toBe(200);
      expect(send.body.count).toBe(2);
    });

    it('GET results answers the wire filter: a LEGACY row reads housing_authorities, never housing_authority', async () => {
      seedUnit(world);
      seedShare(world, 'bcast-legacy-sent', 'sent', { 'c-1': { status: 'delivered' } }, {
        audience_filter: { ...legacyFilter('Atlanta Housing Authority'), bedroomSize: 2 },
      });
      const { app } = makeWebhookHarness({ world });
      const res = await request(app)
        .get('/api/broadcasts/bcast-legacy-sent/results')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE);
      expect(res.status).toBe(200);
      expect(res.body.audience_filter).toEqual({
        contact_type: 'tenant',
        housing_authorities: ['Atlanta Housing Authority'],
        bedroomSizes: [2],
        bedroomSize: 2,
        excludeOptedOut: true,
        excludeUnreachable: true,
      });
      expect(res.body.audience_filter).not.toHaveProperty('housing_authority');
    });

    it('GET /api/broadcasts rows answer the wire filter too - legacy, list and no-authority rows', async () => {
      seedUnit(world);
      seedShare(world, 'bcast-row-legacy', 'sent', {}, { audience_filter: legacyFilter('Atlanta Housing Authority') });
      seedShare(world, 'bcast-row-list', 'draft', {}, { audience_filter: listFilter('DeKalb County Housing Authority') });
      seedShare(world, 'bcast-row-none', 'draft', {});
      const { app } = makeWebhookHarness({ world });
      const res = await request(app)
        .get('/api/broadcasts')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE);
      expect(res.status).toBe(200);
      const byId = Object.fromEntries(
        (res.body.broadcasts as Array<{ broadcastId: string; audience_filter: Record<string, unknown> }>).map(
          (b) => [b.broadcastId, b.audience_filter],
        ),
      );
      expect(byId['bcast-row-legacy']).toEqual({
        contact_type: 'tenant',
        bedroomSizes: [],
        housing_authorities: ['Atlanta Housing Authority'],
        excludeOptedOut: true,
        excludeUnreachable: true,
      });
      expect(byId['bcast-row-legacy']).not.toHaveProperty('housing_authority');
      expect(byId['bcast-row-list']).toEqual({
        contact_type: 'tenant',
        bedroomSizes: [],
        housing_authorities: ['DeKalb County Housing Authority'],
        excludeOptedOut: true,
        excludeUnreachable: true,
      });
      expect(byId['bcast-row-none']).toEqual({ contact_type: 'tenant', bedroomSizes: [], excludeOptedOut: true, excludeUnreachable: true });
      expect(byId['bcast-row-none']).not.toHaveProperty('housing_authorities');
    });

    // Planner review PA-5: a stored row with NO audience_filter (a hand
    // repair, an old row) must not 500 the whole Matching list - the
    // projections answer it without the field, as main passed it through.
    it('GET /api/broadcasts and GET results answer a stored row with NO audience_filter - 200, the field absent', async () => {
      seedUnit(world);
      const bare = seedShare(world, 'bcast-row-unfiltered', 'sent', { 'c-1': { status: 'delivered' } });
      delete (bare as Partial<BroadcastItem>).audience_filter;
      seedShare(world, 'bcast-row-list', 'draft', {}, { audience_filter: listFilter('DeKalb County Housing Authority') });
      const { app } = makeWebhookHarness({ world });
      const list = await request(app)
        .get('/api/broadcasts')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE);
      expect(list.status).toBe(200);
      const rows = list.body.broadcasts as Array<Record<string, unknown>>;
      const row = rows.find((b) => b.broadcastId === 'bcast-row-unfiltered');
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty('audience_filter');
      // The other rows keep their wire filter.
      expect(rows.find((b) => b.broadcastId === 'bcast-row-list')?.audience_filter).toEqual({
        contact_type: 'tenant',
        bedroomSizes: [],
        housing_authorities: ['DeKalb County Housing Authority'],
        excludeOptedOut: true,
        excludeUnreachable: true,
      });
      const results = await request(app)
        .get('/api/broadcasts/bcast-row-unfiltered/results')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE);
      expect(results.status).toBe(200);
      expect(results.body.broadcastId).toBe('bcast-row-unfiltered');
      expect(results.body).not.toHaveProperty('audience_filter');
    });
  });

  // --- property-requirements D12: the voucher size LIST. POST accepts
  // bedroomSizes (it wins) or the legacy bedroomSize and stores bedroomSizes,
  // normalized (each min(n, 4), de-duplicated, ascending; omitted when
  // empty). The estimate, preview and no-body send read a stored row of
  // either shape through bedroomSizesOfFilter, the 4 chip reaching every
  // holder of 4 or more, and the row is never rewritten. Every projection
  // answers bedroomSizes and, when there is a size, the compat bedroomSize. --
  describe('property-requirements D12: voucher sizes at create, preview, send and the projections', () => {
    function postFilter(app: import('express').Express, audience_filter: Record<string, unknown>) {
      return request(app)
        .post('/api/broadcasts')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ unitId: 'unit-1', body_template: 'hi', audience_filter });
    }

    function act(app: import('express').Express, broadcastId: string, verb: 'preview' | 'send') {
      return request(app)
        .post(`/api/broadcasts/${broadcastId}/${verb}`)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({});
    }

    function authedGet(app: import('express').Express, path: string) {
      return request(app).get(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
    }

    /** A stored filter with no housing authority, carrying either size shape. */
    const storedFilter = (
      sizes: Pick<BroadcastItem['audience_filter'], 'bedroomSizes' | 'bedroomSize'>,
    ): BroadcastItem['audience_filter'] => ({
      contact_type: 'tenant',
      ...sizes,
      excludeOptedOut: true,
      excludeUnreachable: true,
    });

    /** A searching tenant with recorded consent (seedTenant's defaults) and, when given, a voucher size. */
    function sized(contactId: string, voucherSize?: number): void {
      seedTenant(world, { contactId, ...(voucherSize !== undefined && { voucherSize }) } as Partial<ContactItem>);
    }

    const ids = (candidates: Array<{ contactId: string }>): string[] => candidates.map((c) => c.contactId).sort();

    it('POST stores bedroomSizes normalized - clamped to the 4 chip, de-duplicated, ascending - and the 201 echoes it with the compat bedroomSize', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const res = await postFilter(app, { contact_type: 'tenant', bedroomSizes: [3, 6, 2, 3, 5] });
      expect(res.status).toBe(201);
      const stored = world.broadcasts.get(res.body.broadcastId)?.audience_filter;
      expect(stored).toEqual(storedFilter({ bedroomSizes: [2, 3, 4] }));
      expect(stored).not.toHaveProperty('bedroomSize');
      expect(res.body.audience_filter).toEqual({ ...storedFilter({ bedroomSizes: [2, 3, 4] }), bedroomSize: 2 });
    });

    it('LEGACY body: bedroomSize n is stored as bedroomSizes [min(n, 4)], never as bedroomSize', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const cases: Array<[number, number[]]> = [
        [2, [2]],
        [0, [0]],
        [7, [4]],
      ];
      for (const [given, expected] of cases) {
        const res = await postFilter(app, { contact_type: 'tenant', bedroomSize: given });
        expect(res.status).toBe(201);
        const stored = world.broadcasts.get(res.body.broadcastId)?.audience_filter;
        expect(stored).toEqual(storedFilter({ bedroomSizes: expected }));
        expect(stored).not.toHaveProperty('bedroomSize');
        expect(res.body.audience_filter).toMatchObject({ bedroomSizes: expected, bedroomSize: expected[0] });
      }
    });

    it('both keys: bedroomSizes wins - the legacy number is not read, and a present empty list is no size filter', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const listed = await postFilter(app, { contact_type: 'tenant', bedroomSizes: [3], bedroomSize: 'not a size' });
      expect(listed.status).toBe(201);
      expect(world.broadcasts.get(listed.body.broadcastId)?.audience_filter).toEqual(storedFilter({ bedroomSizes: [3] }));
      const emptied = await postFilter(app, { contact_type: 'tenant', bedroomSizes: [], bedroomSize: 2 });
      expect(emptied.status).toBe(201);
      expect(world.broadcasts.get(emptied.body.broadcastId)?.audience_filter).toEqual(storedFilter({}));
      expect(emptied.body.audience_filter).toEqual({ ...storedFilter({}), bedroomSizes: [] });
      expect(emptied.body.audience_filter).not.toHaveProperty('bedroomSize');
    });

    it('a null list reads as absent, so a legacy number beside it is read', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const res = await postFilter(app, { contact_type: 'tenant', bedroomSizes: null, bedroomSize: 3 });
      expect(res.status).toBe(201);
      expect(world.broadcasts.get(res.body.broadcastId)?.audience_filter).toEqual(storedFilter({ bedroomSizes: [3] }));
    });

    it('no size, or an empty list, is no size filter: no key stored, the wire answers bedroomSizes []', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const bodies: Array<Record<string, unknown>> = [{}, { bedroomSizes: [] }];
      for (const sizes of bodies) {
        const res = await postFilter(app, { contact_type: 'tenant', ...sizes });
        expect(res.status).toBe(201);
        const stored = world.broadcasts.get(res.body.broadcastId)?.audience_filter;
        expect(stored).not.toHaveProperty('bedroomSizes');
        expect(stored).not.toHaveProperty('bedroomSize');
        expect(res.body.audience_filter).toEqual({ ...storedFilter({}), bedroomSizes: [] });
        expect(res.body.audience_filter).not.toHaveProperty('bedroomSize');
      }
    });

    it('a list that is not an array of integers 0..12 is a 400, and nothing is stored', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const bad: unknown[] = [3, '2', { 0: 2 }, [2.5], [13], [-1], ['2'], [null], [2, 'x']];
      for (const bedroomSizes of bad) {
        const res = await postFilter(app, { contact_type: 'tenant', bedroomSizes });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'audience_filter.bedroomSizes must be an array of integers 0..12' });
      }
      expect(world.broadcasts.size).toBe(0);
    });

    it('(PIN) the legacy bedroomSize keeps its 400 when no list is sent', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({ world });
      const bad: unknown[] = [13, -1, 2.5, '2'];
      for (const bedroomSize of bad) {
        const res = await postFilter(app, { contact_type: 'tenant', bedroomSize });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'audience_filter.bedroomSize must be an integer 0..12' });
      }
      expect(world.broadcasts.size).toBe(0);
    });

    it('the estimate counts ANY listed size, and the 4 chip counts every holder of 4 or more', async () => {
      seedUnit(world);
      const tenants: Array<[string, number]> = [
        ['v0', 0],
        ['v1', 1],
        ['v2', 2],
        ['v3', 3],
        ['v4', 4],
        ['v5', 5],
        ['v12', 12],
      ];
      for (const [id, size] of tenants) sized(id, size);
      sized('v-none');
      const { app } = makeWebhookHarness({ world });
      const res = await postFilter(app, { contact_type: 'tenant', bedroomSizes: [2, 4] });
      expect(res.status).toBe(201);
      // v2, v4, v5, v12 - all start checked (consent recorded, no tours, no declines).
      expect(res.body.estimatedCount).toBe(4);
    });

    it('preview and the no-body send of a STORED legacy bedroomSize 4 reach every holder of 4 or more (broadcast-4plus-exact-match-underreach); the row is not rewritten', async () => {
      seedUnit(world);
      sized('v3', 3);
      sized('v4', 4);
      sized('v6', 6);
      sized('v12', 12);
      sized('v-none');
      seedShare(world, 'bcast-sz-legacy-4', 'draft', {}, { audience_filter: storedFilter({ bedroomSize: 4 }) });
      const { app } = makeWebhookHarness({ world });
      const preview = await act(app, 'bcast-sz-legacy-4', 'preview');
      expect(preview.status).toBe(200);
      expect(ids(preview.body.candidates)).toEqual(['v12', 'v4', 'v6']);
      const send = await act(app, 'bcast-sz-legacy-4', 'send');
      expect(send.status).toBe(200);
      expect(send.body.count).toBe(3);
      const row = world.broadcasts.get('bcast-sz-legacy-4');
      expect(Object.keys(row?.recipients ?? {}).sort()).toEqual(['v12', 'v4', 'v6']);
      // Stored records are never rewritten (D12): still the legacy shape.
      expect(row?.audience_filter).toEqual(storedFilter({ bedroomSize: 4 }));
    });

    it('a stored legacy size of 5 to 12 (the old uncapped pre-fill) previews every holder of 4 or more (spec section 4)', async () => {
      seedUnit(world);
      sized('v3', 3);
      sized('v4', 4);
      sized('v6', 6);
      sized('v12', 12);
      seedShare(world, 'bcast-sz-legacy-6', 'draft', {}, { audience_filter: storedFilter({ bedroomSize: 6 }) });
      const { app } = makeWebhookHarness({ world });
      const preview = await act(app, 'bcast-sz-legacy-6', 'preview');
      expect(preview.status).toBe(200);
      expect(ids(preview.body.candidates)).toEqual(['v12', 'v4', 'v6']);
    });

    it('preview and the no-body send of a STORED bedroomSizes list reach any listed size - a studio included', async () => {
      seedUnit(world);
      sized('v0', 0);
      sized('v1', 1);
      sized('v2', 2);
      sized('v5', 5);
      sized('v-none');
      seedShare(world, 'bcast-sz-list', 'draft', {}, { audience_filter: storedFilter({ bedroomSizes: [0, 2] }) });
      const { app } = makeWebhookHarness({ world });
      const preview = await act(app, 'bcast-sz-list', 'preview');
      expect(preview.status).toBe(200);
      expect(ids(preview.body.candidates)).toEqual(['v0', 'v2']);
      const send = await act(app, 'bcast-sz-list', 'send');
      expect(send.status).toBe(200);
      expect(send.body.count).toBe(2);
    });

    it('GET results and GET /api/broadcasts answer bedroomSizes for every row - legacy, list and none - and the compat bedroomSize when there is one', async () => {
      seedUnit(world);
      seedShare(world, 'bcast-sz-legacy', 'sent', { 'c-1': { status: 'delivered' } }, {
        audience_filter: storedFilter({ bedroomSize: 7 }),
      });
      seedShare(world, 'bcast-sz-listed', 'draft', {}, { audience_filter: storedFilter({ bedroomSizes: [2, 3] }) });
      seedShare(world, 'bcast-sz-none', 'draft', {});
      const { app } = makeWebhookHarness({ world });
      const results = await authedGet(app, '/api/broadcasts/bcast-sz-legacy/results');
      expect(results.status).toBe(200);
      expect(results.body.audience_filter).toEqual({ ...storedFilter({}), bedroomSizes: [4], bedroomSize: 4 });
      const list = await authedGet(app, '/api/broadcasts');
      expect(list.status).toBe(200);
      const byId = Object.fromEntries(
        (list.body.broadcasts as Array<{ broadcastId: string; audience_filter: Record<string, unknown> }>).map(
          (b) => [b.broadcastId, b.audience_filter],
        ),
      );
      expect(byId['bcast-sz-legacy']).toEqual({ ...storedFilter({}), bedroomSizes: [4], bedroomSize: 4 });
      expect(byId['bcast-sz-listed']).toEqual({ ...storedFilter({}), bedroomSizes: [2, 3], bedroomSize: 2 });
      expect(byId['bcast-sz-none']).toEqual({ ...storedFilter({}), bedroomSizes: [] });
      expect(byId['bcast-sz-none']).not.toHaveProperty('bedroomSize');
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

    it('last-heard-from 5.3: a partner seed previews lastHeardFromAt but NEVER a status; a tenant seed carries both', async () => {
      seedUnit(world);
      seedPartner({ last_heard_from_at: '2026-10-01T12:00:00.000Z' });
      seedTenant(world, { contactId: 'c-tenant', phone: '+15550100082', last_heard_from_at: '2026-10-03T09:30:00.000Z' });
      const { app } = makeWebhookHarness({ world });
      const created = await postSeeded(app, ['c-partner', 'c-tenant']);
      expect(created.status).toBe(201);
      const preview = await step(app, created.body.broadcastId, 'preview');
      expect(preview.status).toBe(200);
      const rows = preview.body.candidates as Array<Record<string, unknown>>;
      const partnerRow = rows.find((c) => c['contactId'] === 'c-partner');
      expect(partnerRow).toMatchObject({ lastHeardFromAt: '2026-10-01T12:00:00.000Z' });
      // StatusBadge kind="tenant" must never see a partner's needs_review | active.
      expect(partnerRow).not.toHaveProperty('status');
      expect(rows.find((c) => c['contactId'] === 'c-tenant')).toMatchObject({
        status: 'searching',
        lastHeardFromAt: '2026-10-03T09:30:00.000Z',
      });
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

  describe('last-heard-from 5.3 + D11: the preview not-interested labels', () => {
    const SENT = '2026-10-01T12:00:00.000Z';
    const DECLINED_AT = '2026-10-02T12:00:00.000Z';

    function listedRow(contactId: string, over: Partial<ListingSendItem> = {}): ListingSendItem {
      return { unitId: 'unit-1', contactId, sentAt: SENT, via: 'individual', counted: true, created_at: SENT, updated_at: SENT, ...over };
    }
    function declinedRow(contactId: string, over: Partial<ListingSendItem> = {}): ListingSendItem {
      return listedRow(contactId, { declined: { at: DECLINED_AT, by: 'staff', staffId: 'user-0002' }, ...over });
    }
    function tourOf(tenantId: string, createdAt: string): TourItem {
      return {
        tourId: `tour-${tenantId}-${createdAt}`,
        tenantId,
        unitId: 'unit-1',
        _schedPartition: 'tours',
        tourType: 'self_guided',
        status: 'requested',
        createdAt,
        updatedAt: createdAt,
      };
    }
    function previewDraft(app: import('express').Express, id: string) {
      return request(app)
        .post(`/api/broadcasts/${id}/preview`)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({});
    }
    function declinedById(body: { candidates: Array<{ contactId: string; declinedThisProperty: boolean }> }) {
      return Object.fromEntries(body.candidates.map((c) => [c.contactId, c.declinedThisProperty]));
    }

    it('an EFFECTIVE decline flags the audience row and lists its id; an undeclined row reads false', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
      seedTenant(world, { contactId: 'c-2', phone: '+15550100002' });
      world.listingSends.push(declinedRow('c-1'), listedRow('c-2'));
      const { app } = makeWebhookHarness({ world });
      const res = await previewDraft(app, await createDraft(app));
      expect(res.status).toBe(200);
      expect(res.body.declinedContactIds).toEqual(['c-1']);
      expect(res.body).not.toHaveProperty('declineLabelsUnavailable');
      expect(declinedById(res.body)).toEqual({ 'c-1': true, 'c-2': false });
    });

    it('a decline superseded by a LATER send is not effective', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
      world.listingSends.push(declinedRow('c-1', { sentAt: '2026-10-03T12:00:00.000Z' }));
      const { app } = makeWebhookHarness({ world });
      const res = await previewDraft(app, await createDraft(app));
      expect(res.body.declinedContactIds).toEqual([]);
      expect(declinedById(res.body)).toEqual({ 'c-1': false });
    });

    it('a decline superseded by a NEWER qualifying tour is not effective; an OLDER tour does not supersede', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-new', phone: '+15550100001' });
      seedTenant(world, { contactId: 'c-old', phone: '+15550100002' });
      world.listingSends.push(declinedRow('c-new'), declinedRow('c-old'));
      const newer = tourOf('c-new', '2026-10-04T12:00:00.000Z');
      const older = tourOf('c-old', '2026-09-30T12:00:00.000Z');
      world.toursMap.set(newer.tourId, newer);
      world.toursMap.set(older.tourId, older);
      const { app } = makeWebhookHarness({ world });
      const res = await previewDraft(app, await createDraft(app));
      expect(res.body.declinedContactIds).toEqual(['c-old']);
      expect(declinedById(res.body)).toEqual({ 'c-new': false, 'c-old': true });
    });

    it('lists a declined contact OUTSIDE the audience (the hand-add annotation, like priorRecipientContactIds)', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-in', phone: '+15550100001', voucherSize: 2 } as Partial<ContactItem>);
      seedTenant(world, { contactId: 'c-out', phone: '+15550100002', voucherSize: 3 } as Partial<ContactItem>);
      world.listingSends.push(declinedRow('c-out'));
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app, { audience_filter: { contact_type: 'tenant', bedroomSize: 2 } });
      const res = await previewDraft(app, id);
      expect(res.body.candidates.map((c: { contactId: string }) => c.contactId)).toEqual(['c-in']);
      expect(res.body.declinedContactIds).toEqual(['c-out']);
    });

    it('a draft with no property reads no declines: both lists empty, no unavailable flag', async () => {
      seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
      const listSpy = vi.spyOn(world.listingSendsRepo, 'listByUnit');
      const { app } = makeWebhookHarness({ world });
      const res = await previewDraft(app, await createDraft(app, { unitId: undefined }));
      expect(res.status).toBe(200);
      expect(listSpy).not.toHaveBeenCalled();
      expect(res.body.declinedContactIds).toEqual([]);
      expect(res.body).not.toHaveProperty('declineLabelsUnavailable');
      expect(res.body).not.toHaveProperty('audienceRulesUnavailable');
      expect(declinedById(res.body)).toEqual({ 'c-1': false });
    });

    it('no declined row on the property -> the tours and contacts reads are skipped', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
      world.listingSends.push(listedRow('c-1'));
      const toursSpy = vi.spyOn(world.toursRepo, 'listByUnit');
      const batchSpy = vi.spyOn(world.contactsRepo, 'getManyByIds');
      const { app } = makeWebhookHarness({ world });
      const res = await previewDraft(app, await createDraft(app));
      expect(res.body.declinedContactIds).toEqual([]);
      expect(toursSpy).not.toHaveBeenCalled();
      expect(batchSpy).not.toHaveBeenCalled();
    });

    // B13: the harness getManyByIds ignores requireComplete, so the failed
    // read is driven by making each read REJECT. matching-blast-rules D5: a
    // filter draft whose decline read fails is no longer served without its
    // labels - the preview fails CLOSED (503, no list), because a list
    // without them would check tenants who said Not interested.
    async function expectRulesUnavailable(arm: () => void): Promise<void> {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550100001' });
      world.listingSends.push(declinedRow('c-1'));
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app);
      arm();
      const res = await previewDraft(app, id);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'audience_rules_unavailable' });
    }
    it('a failed listing-sends read fails the filter preview closed: 503 audience_rules_unavailable, no list', async () => {
      await expectRulesUnavailable(() => {
        vi.spyOn(world.listingSendsRepo, 'listByUnit').mockRejectedValueOnce(new Error('throttled'));
      });
    });
    it('a failed tours read (the decline supersession read) fails the filter preview closed', async () => {
      await expectRulesUnavailable(() => {
        vi.spyOn(world.toursRepo, 'listByUnit').mockRejectedValueOnce(new Error('throttled'));
      });
    });
    it('a failed (or incomplete) contacts batch fails the filter preview closed', async () => {
      await expectRulesUnavailable(() => {
        vi.spyOn(world.contactsRepo, 'getManyByIds').mockRejectedValueOnce(new Error('IncompleteBatchReadError'));
      });
    });
  });

  // --- matching-blast-rules D4/D5/D7: the preview's review rows -------------
  describe('matching-blast-rules D4/D5/D7: the preview review rows', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const SENT = '2026-10-01T12:00:00.000Z';
    const DECLINED_AT = '2026-10-02T12:00:00.000Z';
    type Row = Record<string, unknown>;

    /** A tour written straight into the world. unitId defaults to ANOTHER
     *  property: a hold counts an unresolved tour for ANY property (D4). */
    function seedTour(t: {
      tourId: string;
      tenantId: string;
      status: string;
      unitId?: string;
      createdAt?: string;
      scheduledAt?: string;
      outcome?: TourItem['outcome'];
      moveForward?: boolean;
      convertible?: boolean;
    }): TourItem {
      const createdAt = t.createdAt ?? isoFromNow(-10 * DAY);
      const item: TourItem = {
        tourId: t.tourId,
        tenantId: t.tenantId,
        unitId: t.unitId ?? 'unit-2',
        _schedPartition: 'tours',
        tourType: 'self_guided',
        status: t.status,
        createdAt,
        updatedAt: createdAt,
        ...(t.scheduledAt !== undefined && { scheduledAt: t.scheduledAt }),
        ...(t.outcome !== undefined && { outcome: t.outcome }),
        ...(t.moveForward !== undefined && { moveForward: t.moveForward }),
        ...(t.convertible !== undefined && { convertible: t.convertible }),
      };
      world.toursMap.set(item.tourId, item);
      return item;
    }

    /** An EFFECTIVE #27 decline of unit-1 (listed, then declined; no later send or tour). */
    function declinedRow(contactId: string): ListingSendItem {
      return {
        unitId: 'unit-1',
        contactId,
        sentAt: SENT,
        via: 'individual',
        counted: true,
        created_at: SENT,
        updated_at: SENT,
        declined: { at: DECLINED_AT, by: 'staff', staffId: 'user-0002' },
      };
    }

    function preview(app: import('express').Express, id: string) {
      return request(app)
        .post(`/api/broadcasts/${id}/preview`)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({});
    }

    /** A seeds_only draft: the direct send from a tenant's or caseworker's page. */
    async function createSeedsOnly(app: import('express').Express, seedContactIds: string[]): Promise<string> {
      const res = await request(app)
        .post('/api/broadcasts')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ unitId: 'unit-1', body_template: 'hi', seedContactIds });
      expect(res.status).toBe(201);
      return res.body.broadcastId as string;
    }

    function rowsById(body: { candidates: Row[] }): Map<string, Row> {
      return new Map(body.candidates.map((c) => [c['contactId'] as string, c]));
    }

    function sortedHolds(body: { tourHolds: Array<{ contactId: string }> }): Array<{ contactId: string }> {
      return [...body.tourHolds].sort((a, b) => (a.contactId < b.contactId ? -1 : 1));
    }

    it('every D4 hold kind reaches its candidate as tourHold and unchecks it; a resolved or stale tour holds nothing', async () => {
      seedUnit(world);
      const ids = [
        'c-up', 'c-unmarked', 'c-needs-placement', 'c-needs-outcome', 'c-noshow', 'c-req',
        'c-old-req', 'c-closed', 'c-canceled', 'c-done', 'c-free',
      ];
      ids.forEach((contactId, i) => seedTenant(world, { contactId, phone: `+1555030${String(i + 1).padStart(4, '0')}` }));
      const upAt = isoFromNow(3 * DAY);
      const pastAt = isoFromNow(-2 * DAY);
      const reqAt = isoFromNow(-1 * DAY);
      seedTour({ tourId: 't-up', tenantId: 'c-up', status: 'scheduled', scheduledAt: upAt });
      seedTour({ tourId: 't-unmarked', tenantId: 'c-unmarked', status: 'scheduled', scheduledAt: pastAt });
      seedTour({
        tourId: 't-needs-placement',
        tenantId: 'c-needs-placement',
        status: 'toured',
        scheduledAt: pastAt,
        outcome: 'move_forward',
        moveForward: true,
        convertible: true,
      });
      seedTour({ tourId: 't-needs-outcome', tenantId: 'c-needs-outcome', status: 'toured', scheduledAt: pastAt });
      seedTour({ tourId: 't-noshow', tenantId: 'c-noshow', status: 'no_show', scheduledAt: pastAt });
      seedTour({ tourId: 't-req', tenantId: 'c-req', status: 'requested', createdAt: reqAt });
      seedTour({ tourId: 't-old-req', tenantId: 'c-old-req', status: 'requested', createdAt: isoFromNow(-15 * DAY) });
      seedTour({ tourId: 't-closed', tenantId: 'c-closed', status: 'closed', scheduledAt: pastAt, outcome: 'not_a_fit', convertible: false });
      seedTour({ tourId: 't-canceled', tenantId: 'c-canceled', status: 'canceled', scheduledAt: upAt });
      seedTour({
        tourId: 't-done',
        tenantId: 'c-done',
        status: 'toured',
        scheduledAt: pastAt,
        outcome: 'not_a_fit',
        moveForward: false,
        convertible: false,
      });
      const { app } = makeWebhookHarness({ world });
      const res = await preview(app, await createDraft(app));
      expect(res.status).toBe(200);
      const byId = rowsById(res.body);
      expect(byId.get('c-up')?.['tourHold']).toEqual({ kind: 'upcoming', tourId: 't-up', at: upAt });
      expect(byId.get('c-unmarked')?.['tourHold']).toEqual({ kind: 'not_marked', tourId: 't-unmarked', at: pastAt });
      expect(byId.get('c-needs-placement')?.['tourHold']).toEqual({
        kind: 'needs_placement',
        tourId: 't-needs-placement',
        at: pastAt,
      });
      expect(byId.get('c-needs-outcome')?.['tourHold']).toEqual({ kind: 'needs_outcome', tourId: 't-needs-outcome', at: pastAt });
      expect(byId.get('c-noshow')?.['tourHold']).toEqual({ kind: 'no_show', tourId: 't-noshow', at: pastAt });
      expect(byId.get('c-req')?.['tourHold']).toEqual({ kind: 'requested', tourId: 't-req', at: reqAt });
      for (const id of ['c-up', 'c-unmarked', 'c-needs-placement', 'c-needs-outcome', 'c-noshow', 'c-req']) {
        expect(byId.get(id)?.['checkedByDefault'], id).toBe(false);
      }
      for (const id of ['c-old-req', 'c-closed', 'c-canceled', 'c-done', 'c-free']) {
        expect(byId.has(id), id).toBe(true);
        expect(byId.get(id), id).not.toHaveProperty('tourHold');
        expect(byId.get(id)?.['checkedByDefault'], id).toBe(true);
      }
      expect(sortedHolds(res.body)).toEqual([
        { contactId: 'c-needs-outcome', kind: 'needs_outcome', tourId: 't-needs-outcome', at: pastAt },
        { contactId: 'c-needs-placement', kind: 'needs_placement', tourId: 't-needs-placement', at: pastAt },
        { contactId: 'c-noshow', kind: 'no_show', tourId: 't-noshow', at: pastAt },
        { contactId: 'c-req', kind: 'requested', tourId: 't-req', at: reqAt },
        { contactId: 'c-unmarked', kind: 'not_marked', tourId: 't-unmarked', at: pastAt },
        { contactId: 'c-up', kind: 'upcoming', tourId: 't-up', at: upAt },
      ]);
      expect(res.body).not.toHaveProperty('declineLabelsUnavailable');
      expect(res.body).not.toHaveProperty('audienceRulesUnavailable');
    });

    it('flyer-leads D8 (PIN): a signed_up pair stays checked by default - D5 unchecks only an effective decline (broadcasts.ts derives signed_up for a row whose old decline a later share superseded); a sign-up refused by a CURRENT decline leaves that pair declined and unchecked', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-signed', phone: '+15550302001' });
      seedTenant(world, { contactId: 'c-superseded', phone: '+15550302002' });
      seedTenant(world, { contactId: 'c-declined', phone: '+15550302003' });
      const ledger = { listingSends: world.listingSendsRepo, log: createLogger({ level: 'silent' }) };
      const FLYER_AT = '2026-10-03T12:00:00.000Z';
      // An old decline a later share superseded (sentAt after DECLINED_AT), then a sign-up.
      world.listingSends.push({ ...declinedRow('c-superseded'), sentAt: '2026-10-02T18:00:00.000Z' });
      world.listingSends.push(declinedRow('c-declined'));
      expect(await applyFlyerShareEntry(ledger, { unitId: 'unit-1', contactId: 'c-signed', signedUpAt: FLYER_AT })).toBe('written');
      expect(await applyFlyerShareEntry(ledger, { unitId: 'unit-1', contactId: 'c-superseded', signedUpAt: FLYER_AT })).toBe('written');
      expect(await applyFlyerShareEntry(ledger, { unitId: 'unit-1', contactId: 'c-declined', signedUpAt: FLYER_AT })).toBe('declined');
      const { app } = makeWebhookHarness({ world });
      const res = await preview(app, await createDraft(app));
      expect(res.status).toBe(200);
      const byId = rowsById(res.body);
      expect(byId.get('c-signed')).toMatchObject({ checkedByDefault: true, declinedThisProperty: false });
      expect(byId.get('c-superseded')).toMatchObject({ checkedByDefault: true, declinedThisProperty: false });
      expect(byId.get('c-declined')).toMatchObject({ checkedByDefault: false, declinedThisProperty: true });
      expect(res.body.declinedContactIds).toEqual(['c-declined']);
    });

    it('checkedByDefault is the ONE server rule: a seed is checked whatever its flags; a held, declined, already-sent or no-consent filter row is not; tourHolds lists EVERY held contact, in the rows or not', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-plain', phone: '+15550301001' });
      seedTenant(world, { contactId: 'c-held', phone: '+15550301002' });
      seedTenant(world, { contactId: 'c-held-seed', phone: '+15550301003' });
      seedTenant(world, { contactId: 'c-declined', phone: '+15550301004' });
      seedTenant(world, { contactId: 'c-declined-seed', phone: '+15550301005' });
      seedTenant(world, { contactId: 'c-sent', phone: '+15550301006' });
      seedTenant(world, { contactId: 'c-nocons', phone: '+15550301007', consent_method: undefined });
      seedTenant(world, { contactId: 'c-nocons-seed', phone: '+15550301008', consent_method: undefined });
      // Held but never a filter row: a Placing tenant (D1 leaves them out) and
      // a caseworker seed (D10: a filter never resolves partners; a hand pick may).
      seedTenant(world, { contactId: 'c-placing', phone: '+15550301009', status: 'placing' });
      seedTenant(world, { contactId: 'c-cw-seed', phone: '+15550301010', type: 'partner', status: 'active' });
      // An older tour whose tenantId names a LANDLORD still holds: the hold is
      // keyed on the tour's tenantId with no assumption about type (D4).
      world.contacts.push({ contactId: 'c-ll-tour', type: 'landlord', status: 'active', phone: '+15550301011' });
      const at = isoFromNow(3 * DAY);
      for (const tenantId of ['c-held', 'c-held-seed', 'c-placing', 'c-cw-seed', 'c-ll-tour']) {
        seedTour({ tourId: `t-${tenantId}`, tenantId, status: 'scheduled', scheduledAt: at });
      }
      world.listingSends.push(declinedRow('c-declined'), declinedRow('c-declined-seed'));
      seedShare(world, 'bcast-prior', 'sent', { 'c-sent': { status: 'delivered' } });
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app, {
        seedContactIds: ['c-held-seed', 'c-declined-seed', 'c-nocons-seed', 'c-cw-seed'],
      });
      const res = await preview(app, id);
      expect(res.status).toBe(200);
      const byId = rowsById(res.body);
      expect(Object.fromEntries([...byId].map(([cid, r]) => [cid, r['checkedByDefault']]))).toEqual({
        'c-plain': true,
        'c-held': false,
        'c-held-seed': true,
        'c-declined': false,
        'c-declined-seed': true,
        'c-sent': false,
        'c-nocons': false,
        'c-nocons-seed': false,
        'c-cw-seed': true,
      });
      // A hand pick is never held: it starts checked AND keeps its label (D4).
      expect(byId.get('c-held-seed')).toMatchObject({
        seeded: true,
        tourHold: { kind: 'upcoming', tourId: 't-c-held-seed', at },
      });
      expect(byId.get('c-cw-seed')).toMatchObject({
        seeded: true,
        tourHold: { kind: 'upcoming', tourId: 't-c-cw-seed', at },
      });
      expect(byId.get('c-declined-seed')).toMatchObject({ seeded: true, declinedThisProperty: true });
      expect(byId.get('c-sent')).toMatchObject({ alreadySentThisProperty: true });
      expect(byId.get('c-nocons')).toMatchObject({ has_consent: false });
      expect(byId.has('c-placing')).toBe(false);
      expect(sortedHolds(res.body).map((h) => h.contactId)).toEqual([
        'c-cw-seed',
        'c-held',
        'c-held-seed',
        'c-ll-tour',
        'c-placing',
      ]);
    });

    it('the open-tours read is ONE read per preview: scheduled, toured and no_show to the end, requested from now minus 14 days (D5)', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550301101' });
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app);
      const spy = vi.spyOn(world.toursRepo, 'listByStatus');
      const before = Date.now();
      const res = await preview(app, id);
      const after = Date.now();
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(4);
      expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(['no_show', 'requested', 'scheduled', 'toured']);
      for (const call of spy.mock.calls) {
        if (call[0] !== 'requested') expect(call[1], call[0]).toBeUndefined();
      }
      const requestedCall = spy.mock.calls.find((c) => c[0] === 'requested')!;
      const from = Date.parse(requestedCall[1]!.createdAtFrom!);
      expect(from).toBeGreaterThanOrEqual(before - TOUR_REQUEST_HOLD_MS);
      expect(from).toBeLessThanOrEqual(after - TOUR_REQUEST_HOLD_MS);
    });

    it('several unresolved tours: ONE hold is shown, by kind order, then the earliest upcoming date', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-multi', phone: '+15550301201' });
      seedTenant(world, { contactId: 'c-place', phone: '+15550301202' });
      const soon = isoFromNow(2 * DAY);
      const pastAt = isoFromNow(-3 * DAY);
      seedTour({ tourId: 't-late', tenantId: 'c-multi', status: 'scheduled', scheduledAt: isoFromNow(5 * DAY) });
      seedTour({ tourId: 't-soon', tenantId: 'c-multi', status: 'scheduled', scheduledAt: soon });
      seedTour({ tourId: 't-ask', tenantId: 'c-multi', status: 'requested', createdAt: isoFromNow(-1 * DAY) });
      seedTour({
        tourId: 't-np',
        tenantId: 'c-place',
        status: 'toured',
        scheduledAt: pastAt,
        outcome: 'move_forward',
        moveForward: true,
        convertible: true,
      });
      seedTour({ tourId: 't-next', tenantId: 'c-place', status: 'scheduled', scheduledAt: isoFromNow(1 * DAY) });
      const { app } = makeWebhookHarness({ world });
      const res = await preview(app, await createDraft(app));
      expect(res.status).toBe(200);
      const byId = rowsById(res.body);
      expect(byId.get('c-multi')?.['tourHold']).toEqual({ kind: 'upcoming', tourId: 't-soon', at: soon });
      expect(byId.get('c-place')?.['tourHold']).toEqual({ kind: 'needs_placement', tourId: 't-np', at: pastAt });
    });

    it('a draft stored with the LEGACY one-string filter previews through the normalizer, rows carrying checkedByDefault', async () => {
      seedUnit(world);
      seedTenant(world, {
        contactId: 'c-aha',
        phone: '+15550301301',
        housingAuthority: 'Atlanta Housing Authority',
      } as Partial<ContactItem>);
      seedTenant(world, {
        contactId: 'c-dekalb',
        phone: '+15550301302',
        housingAuthority: 'DeKalb County Housing Authority',
      } as Partial<ContactItem>);
      seedTenant(world, { contactId: 'c-blank', phone: '+15550301303' });
      seedShare(world, 'bcast-legacy', 'draft', {}, {
        audience_filter: {
          contact_type: 'tenant',
          housing_authority: 'Atlanta Housing Authority',
          excludeOptedOut: true,
          excludeUnreachable: true,
        },
      });
      const { app } = makeWebhookHarness({ world });
      const res = await preview(app, 'bcast-legacy');
      expect(res.status).toBe(200);
      expect(res.body.candidates.map((c: Row) => [c['contactId'], c['checkedByDefault']])).toEqual([['c-aha', true]]);
    });

    it('a FILTER draft whose tours read throws is 503 audience_rules_unavailable with NO list (D5 fail closed)', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550301401' });
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app);
      vi.spyOn(world.toursRepo, 'listByStatus').mockRejectedValueOnce(new Error('throttled'));
      const res = await preview(app, id);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'audience_rules_unavailable' });
    });

    it('a filter draft with NO property still reads tours: a throwing tours read is 503 there too', async () => {
      seedTenant(world, { contactId: 'c-1', phone: '+15550301501' });
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app, { unitId: undefined });
      vi.spyOn(world.toursRepo, 'listByStatus').mockRejectedValueOnce(new Error('throttled'));
      const res = await preview(app, id);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'audience_rules_unavailable' });
    });

    it('a seeds_only draft (a direct send): the seed keeps its tour label and stays checked; when the tours read throws it is served WITHOUT labels and says so', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550301601' });
      const at = isoFromNow(2 * DAY);
      seedTour({ tourId: 't-1', tenantId: 'c-1', status: 'scheduled', scheduledAt: at });
      const { app } = makeWebhookHarness({ world });
      const id = await createSeedsOnly(app, ['c-1']);
      const ok = await preview(app, id);
      expect(ok.status).toBe(200);
      expect(ok.body.candidates).toHaveLength(1);
      expect(ok.body.candidates[0]).toMatchObject({
        contactId: 'c-1',
        seeded: true,
        checkedByDefault: true,
        tourHold: { kind: 'upcoming', tourId: 't-1', at },
      });
      expect(ok.body).not.toHaveProperty('audienceRulesUnavailable');
      vi.spyOn(world.toursRepo, 'listByStatus').mockRejectedValueOnce(new Error('throttled'));
      const degraded = await preview(app, id);
      expect(degraded.status).toBe(200);
      expect(degraded.body.candidates).toHaveLength(1);
      expect(degraded.body.candidates[0]).toMatchObject({
        contactId: 'c-1',
        seeded: true,
        checkedByDefault: true,
        declinedThisProperty: false,
      });
      expect(degraded.body.candidates[0]).not.toHaveProperty('tourHold');
      expect(degraded.body.tourHolds).toEqual([]);
      expect(degraded.body.declinedContactIds).toEqual([]);
      expect(degraded.body.audienceRulesUnavailable).toBe(true);
    });

    it('a seeds_only draft whose decline read throws is served without the Not interested label, still checked, audienceRulesUnavailable', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550301701' });
      world.listingSends.push(declinedRow('c-1'));
      const { app } = makeWebhookHarness({ world });
      const id = await createSeedsOnly(app, ['c-1']);
      const ok = await preview(app, id);
      expect(ok.status).toBe(200);
      expect(ok.body.candidates[0]).toMatchObject({ declinedThisProperty: true, checkedByDefault: true });
      expect(ok.body.declinedContactIds).toEqual(['c-1']);
      vi.spyOn(world.listingSendsRepo, 'listByUnit').mockRejectedValueOnce(new Error('throttled'));
      const degraded = await preview(app, id);
      expect(degraded.status).toBe(200);
      expect(degraded.body.candidates[0]).toMatchObject({
        contactId: 'c-1',
        declinedThisProperty: false,
        checkedByDefault: true,
      });
      expect(degraded.body.declinedContactIds).toEqual([]);
      expect(degraded.body.audienceRulesUnavailable).toBe(true);
    });
  });

  // --- matching-blast-rules D8: "Reaches N recipients" = the default-checked rows ---
  describe('matching-blast-rules D8: POST create estimates the default-checked rows', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const SENT = '2026-10-01T12:00:00.000Z';
    const DECLINED_AT = '2026-10-02T12:00:00.000Z';

    /** An upcoming tour on ANOTHER property: holds the tenant (D4). */
    function seedUpcomingTour(tourId: string, tenantId: string): TourItem {
      const createdAt = isoFromNow(-5 * DAY);
      const item: TourItem = {
        tourId,
        tenantId,
        unitId: 'unit-2',
        _schedPartition: 'tours',
        tourType: 'self_guided',
        status: 'scheduled',
        scheduledAt: isoFromNow(3 * DAY),
        createdAt,
        updatedAt: createdAt,
      };
      world.toursMap.set(tourId, item);
      return item;
    }

    /** An EFFECTIVE #27 decline of unit-1. */
    function declinedRow(contactId: string): ListingSendItem {
      return {
        unitId: 'unit-1',
        contactId,
        sentAt: SENT,
        via: 'individual',
        counted: true,
        created_at: SENT,
        updated_at: SENT,
        declined: { at: DECLINED_AT, by: 'staff', staffId: 'user-0002' },
      };
    }

    function postDraft(app: import('express').Express, body: Record<string, unknown>) {
      return request(app)
        .post('/api/broadcasts')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send(body);
    }

    const FILTER_BODY = { unitId: 'unit-1', body_template: 'hi', audience_filter: { contact_type: 'tenant' } };

    it('estimatedCount (stored as stats.audience) counts ONLY the rows that start checked: held, declined, already-sent and no-consent rows are left out; a held seed counts', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-plain', phone: '+15550305001' });
      seedTenant(world, { contactId: 'c-held', phone: '+15550305002' });
      seedTenant(world, { contactId: 'c-held-seed', phone: '+15550305003' });
      seedTenant(world, { contactId: 'c-declined', phone: '+15550305004' });
      seedTenant(world, { contactId: 'c-sent', phone: '+15550305005' });
      seedTenant(world, { contactId: 'c-nocons', phone: '+15550305006', consent_method: undefined });
      seedUpcomingTour('t-held', 'c-held');
      seedUpcomingTour('t-held-seed', 'c-held-seed');
      world.listingSends.push(declinedRow('c-declined'));
      seedShare(world, 'bcast-prior', 'sent', { 'c-sent': { status: 'delivered' } });
      const { app } = makeWebhookHarness({ world });
      const res = await postDraft(app, { ...FILTER_BODY, seedContactIds: ['c-held-seed'] });
      expect(res.status).toBe(201);
      expect(res.body.estimatedCount).toBe(2); // c-plain + the hand-picked c-held-seed
      expect(res.body.truncated).toBe(false);
      expect(world.broadcasts.get(res.body.broadcastId)?.stats.audience).toBe(2);
      // The preview agrees: the same two rows start checked (one rule, D5).
      const preview = await request(app)
        .post(`/api/broadcasts/${res.body.broadcastId}/preview`)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({});
      expect(preview.status).toBe(200);
      const checked = (preview.body.candidates as Array<{ contactId: string; checkedByDefault: boolean }>)
        .filter((c) => c.checkedByDefault)
        .map((c) => c.contactId)
        .sort();
      expect(checked).toEqual(['c-held-seed', 'c-plain']);
    });

    it('a seeds_only create makes NO rules or already-sent reads and counts the seeds WITH recorded consent', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-seed-yes', phone: '+15550305101' });
      seedTenant(world, { contactId: 'c-seed-no', phone: '+15550305102', consent_method: undefined });
      seedUpcomingTour('t-yes', 'c-seed-yes'); // a hand pick is never held anyway
      const toursRead = vi.spyOn(world.toursRepo, 'listByStatus');
      const declinesRead = vi.spyOn(world.listingSendsRepo, 'listByUnit');
      const priorRead = vi.spyOn(world.broadcastsRepo, 'listByUnit');
      const { app } = makeWebhookHarness({ world });
      const res = await postDraft(app, { unitId: 'unit-1', body_template: 'hi', seedContactIds: ['c-seed-yes', 'c-seed-no'] });
      expect(res.status).toBe(201);
      expect(world.broadcasts.get(res.body.broadcastId)?.audience_mode).toBe('seeds_only');
      expect(res.body.estimatedCount).toBe(1);
      expect(toursRead).not.toHaveBeenCalled();
      expect(declinesRead).not.toHaveBeenCalled();
      expect(priorRead).not.toHaveBeenCalled();
    });

    it('a throwing tours read never blocks the draft: 201 WITHOUT estimatedCount, stats.audience 0, no estimate in the audit', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550305201' });
      vi.spyOn(world.toursRepo, 'listByStatus').mockRejectedValueOnce(new Error('throttled'));
      const { app } = makeWebhookHarness({ world });
      const res = await postDraft(app, FILTER_BODY);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('draft');
      expect(res.body).not.toHaveProperty('estimatedCount');
      expect(res.body.truncated).toBe(false);
      const stored = world.broadcasts.get(res.body.broadcastId);
      expect(stored?.status).toBe('draft');
      expect(stored?.stats.audience).toBe(0);
      const audit = world.auditEvents.find((e) => e.event_type === 'broadcast_created');
      expect(audit).toBeDefined();
      expect(audit?.payload).not.toHaveProperty('estimatedCount');
    });

    it('a throwing decline read omits the estimate the same way', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550305301' });
      vi.spyOn(world.listingSendsRepo, 'listByUnit').mockRejectedValueOnce(new Error('throttled'));
      const { app } = makeWebhookHarness({ world });
      const res = await postDraft(app, FILTER_BODY);
      expect(res.status).toBe(201);
      expect(res.body).not.toHaveProperty('estimatedCount');
      expect(world.broadcasts.get(res.body.broadcastId)?.stats.audience).toBe(0);
    });

    it('an omitted estimate still reports a truncated resolution', async () => {
      seedUnit(world);
      const truncatedAudience = {
        contactIds: ['c-t1'],
        contacts: [{ contactId: 'c-t1', phone: '+15550305401', has_consent: true }],
        count: 1,
        truncated: true,
      };
      vi.spyOn(world.toursRepo, 'listByStatus').mockRejectedValueOnce(new Error('throttled'));
      const { app } = makeWebhookHarness({ world, audienceResolutionService: async () => truncatedAudience });
      const res = await postDraft(app, FILTER_BODY);
      expect(res.status).toBe(201);
      expect(res.body).not.toHaveProperty('estimatedCount');
      expect(res.body.truncated).toBe(true);
    });

    it('create reads the send-attempt record (the already-sent input of the estimate): a queued slot of a failed share with a live record counts as already sent', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-live', phone: '+15550305501' });
      seedTenant(world, { contactId: 'c-other', phone: '+15550305502' });
      seedShare(world, 'bcast-failed', 'failed', { 'c-live': { status: 'queued' } }, { last_error: 'enqueue failed' });
      await world.sendAttemptsRepo.claim(
        { kind: 'broadcast', broadcastId: 'bcast-failed', contactKey: 'c-live' },
        SEED_ATTEMPT_FACTS,
        new Date().toISOString(),
      );
      const recordReads = vi.spyOn(world.sendAttemptsRepo, 'get');
      const { app } = makeWebhookHarness({ world });
      const res = await postDraft(app, FILTER_BODY);
      expect(res.status).toBe(201);
      expect(recordReads).toHaveBeenCalled();
      expect(res.body.estimatedCount).toBe(1); // c-other only
    });

    it('(PIN) create counts every default-checked row, past the preview list bound of MAX_BROADCAST_RECIPIENTS', async () => {
      seedUnit(world);
      const contacts = Array.from({ length: MAX_BROADCAST_RECIPIENTS + 1 }, (_, i) => ({
        contactId: `c-big-${i}`,
        phone: `+1556${String(i).padStart(7, '0')}`,
        has_consent: true,
      }));
      const big = { contactIds: contacts.map((c) => c.contactId), contacts, count: contacts.length, truncated: false };
      const { app } = makeWebhookHarness({ world, audienceResolutionService: async () => big });
      const res = await postDraft(app, FILTER_BODY);
      expect(res.status).toBe(201);
      expect(res.body.estimatedCount).toBe(MAX_BROADCAST_RECIPIENTS + 1);
    });
  });

  // --- matching-blast-rules D6: the no-body filter send (path c) -------------
  describe('matching-blast-rules D6: send path (c) leaves out held and declined tenants', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const SENT = '2026-10-01T12:00:00.000Z';
    const DECLINED_AT = '2026-10-02T12:00:00.000Z';

    /** An upcoming tour on ANOTHER property: holds the tenant (D4). */
    function seedUpcomingTour(tourId: string, tenantId: string): TourItem {
      const createdAt = isoFromNow(-5 * DAY);
      const item: TourItem = {
        tourId,
        tenantId,
        unitId: 'unit-2',
        _schedPartition: 'tours',
        tourType: 'self_guided',
        status: 'scheduled',
        scheduledAt: isoFromNow(3 * DAY),
        createdAt,
        updatedAt: createdAt,
      };
      world.toursMap.set(tourId, item);
      return item;
    }

    /** An EFFECTIVE #27 decline of unit-1. */
    function declinedRow(contactId: string): ListingSendItem {
      return {
        unitId: 'unit-1',
        contactId,
        sentAt: SENT,
        via: 'individual',
        counted: true,
        created_at: SENT,
        updated_at: SENT,
        declined: { at: DECLINED_AT, by: 'staff', staffId: 'user-0002' },
      };
    }

    function send(app: import('express').Express, id: string, body: Record<string, unknown> = {}) {
      return request(app)
        .post(`/api/broadcasts/${id}/send`)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send(body);
    }

    /** A resolver result of `n` consented tenants c-cap-0 .. c-cap-(n-1). */
    function capAudience(n: number) {
      const contacts = Array.from({ length: n }, (_, i) => ({
        contactId: `c-cap-${i}`,
        phone: `+1556${String(i).padStart(7, '0')}`,
        has_consent: true,
      }));
      return { contactIds: contacts.map((c) => c.contactId), contacts, count: contacts.length, truncated: false };
    }

    it('the recipients are the resolved audience MINUS held MINUS declined; already-sent and no-consent tenants stay (the fan-out counts skipped_no_consent); seeds stay out', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-plain', phone: '+15550306001' });
      seedTenant(world, { contactId: 'c-held', phone: '+15550306002' });
      seedTenant(world, { contactId: 'c-declined', phone: '+15550306003' });
      seedTenant(world, { contactId: 'c-sent', phone: '+15550306004' });
      seedTenant(world, { contactId: 'c-nocons', phone: '+15550306005', consent_method: undefined });
      seedTenant(world, { contactId: 'c-seed-out', phone: '+15550306006', status: 'placing' });
      seedUpcomingTour('t-held', 'c-held');
      world.listingSends.push(declinedRow('c-declined'));
      seedShare(world, 'bcast-prior', 'sent', { 'c-sent': { status: 'delivered' } });
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app, { seedContactIds: ['c-seed-out'] });
      const res = await send(app, id);
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(3);
      expect(Object.keys(world.broadcasts.get(id)!.recipients).sort()).toEqual(['c-nocons', 'c-plain', 'c-sent']);
      await queueAdapter.settle();
      expect(world.sent.map((s) => s.to).sort()).toEqual(['+15550306001', '+15550306004']);
      const results = await authedGet(app, `/api/broadcasts/${id}/results`);
      expect(results.status).toBe(200);
      expect(results.body.stats.skipped_no_consent).toBe(1);
    });

    it('a throwing tours read is 503 audience_rules_unavailable: still a draft, nothing marked sending, nothing sent', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550306101' });
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app);
      vi.spyOn(world.toursRepo, 'listByStatus').mockRejectedValueOnce(new Error('throttled'));
      const markSending = vi.spyOn(world.broadcastsRepo, 'markSending');
      const res = await send(app, id);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'audience_rules_unavailable' });
      expect(markSending).not.toHaveBeenCalled();
      await queueAdapter.settle();
      expect(world.broadcasts.get(id)?.status).toBe('draft');
      expect(world.sent).toHaveLength(0);
    });

    it('a throwing decline read is 503 audience_rules_unavailable too', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-1', phone: '+15550306201' });
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app);
      vi.spyOn(world.listingSendsRepo, 'listByUnit').mockRejectedValueOnce(new Error('throttled'));
      const res = await send(app, id);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'audience_rules_unavailable' });
      expect(world.broadcasts.get(id)?.status).toBe('draft');
    });

    // AR12: path (c) reads the rules even for an empty or a truncated
    // resolution, so a failed read outranks both refusals (review R1 CONF-2).
    it('(AR12) an EMPTY resolution with a throwing tours read is 503, not 400 empty_audience: still a draft, nothing marked sending or enqueued', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({
        world,
        audienceResolutionService: async () => ({ contactIds: [], contacts: [], count: 0, truncated: false }),
      });
      const id = await createDraft(app);
      vi.spyOn(world.toursRepo, 'listByStatus').mockRejectedValueOnce(new Error('throttled'));
      const markSending = vi.spyOn(world.broadcastsRepo, 'markSending');
      const enqueue = vi.spyOn(queueAdapter, 'enqueue');
      const res = await send(app, id);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'audience_rules_unavailable' });
      expect(markSending).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      await queueAdapter.settle();
      expect(world.broadcasts.get(id)?.status).toBe('draft');
      expect(world.sent).toHaveLength(0);
    });

    it('(AR12) a TRUNCATED resolution (one consented tenant) with a throwing tours read is 503, not 400 audience_too_large', async () => {
      seedUnit(world);
      const { app } = makeWebhookHarness({
        world,
        audienceResolutionService: async () => ({ ...capAudience(1), truncated: true }),
      });
      const id = await createDraft(app);
      vi.spyOn(world.toursRepo, 'listByStatus').mockRejectedValueOnce(new Error('throttled'));
      const markSending = vi.spyOn(world.broadcastsRepo, 'markSending');
      const enqueue = vi.spyOn(queueAdapter, 'enqueue');
      const res = await send(app, id);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'audience_rules_unavailable' });
      expect(markSending).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      await queueAdapter.settle();
      expect(world.broadcasts.get(id)?.status).toBe('draft');
      expect(world.sent).toHaveLength(0);
    });

    it('every resolved tenant excluded is 400 empty_audience, still a draft', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-held', phone: '+15550306301' });
      seedTenant(world, { contactId: 'c-declined', phone: '+15550306302' });
      seedUpcomingTour('t-held', 'c-held');
      world.listingSends.push(declinedRow('c-declined'));
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app);
      const res = await send(app, id);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'empty_audience' });
      expect(world.broadcasts.get(id)?.status).toBe('draft');
    });

    it('the recipient cap counts the FINAL set: 1002 resolved minus 2 held is 1000 and passes the cap', async () => {
      seedUnit(world);
      seedUpcomingTour('t-cap-0', 'c-cap-0');
      seedUpcomingTour('t-cap-1', 'c-cap-1');
      const { app } = makeWebhookHarness({
        world,
        audienceResolutionService: async () => capAudience(MAX_BROADCAST_RECIPIENTS + 2),
      });
      const id = await createDraft(app);
      // Stop at markSending (a lost conditional write answers 409) so no
      // 1000-recipient fan-out runs in a unit test.
      const markSending = vi
        .spyOn(world.broadcastsRepo, 'markSending')
        .mockRejectedValueOnce(new ConditionalCheckFailedException({ message: 'stop before the fan-out', $metadata: {} }));
      const res = await send(app, id);
      expect(res.status).toBe(409);
      expect(markSending).toHaveBeenCalledTimes(1);
      const recipients = markSending.mock.calls[0]![1];
      expect(Object.keys(recipients)).toHaveLength(MAX_BROADCAST_RECIPIENTS);
      expect(recipients).not.toHaveProperty('c-cap-0');
      expect(recipients).not.toHaveProperty('c-cap-1');
      expect(world.broadcasts.get(id)?.status).toBe('draft');
    });

    it('one held of 1002 leaves 1001: 400 audience_too_large with the FINAL count', async () => {
      seedUnit(world);
      seedUpcomingTour('t-cap-0', 'c-cap-0');
      const { app } = makeWebhookHarness({
        world,
        audienceResolutionService: async () => capAudience(MAX_BROADCAST_RECIPIENTS + 2),
      });
      const id = await createDraft(app);
      const res = await send(app, id);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'audience_too_large',
        message: `audience of ${MAX_BROADCAST_RECIPIENTS + 1} exceeds the ${MAX_BROADCAST_RECIPIENTS} recipient cap - narrow the housing authority and/or bedroom-size filter`,
        count: MAX_BROADCAST_RECIPIENTS + 1,
        truncated: false,
      });
      expect(world.broadcasts.get(id)?.status).toBe('draft');
    });

    it('(PIN) path (a), the explicit list the dashboard sends, is unchanged: a checked held or declined tenant is sent', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-held', phone: '+15550306601' });
      seedTenant(world, { contactId: 'c-declined', phone: '+15550306602' });
      seedUpcomingTour('t-held', 'c-held');
      world.listingSends.push(declinedRow('c-declined'));
      const { app } = makeWebhookHarness({ world });
      const id = await createDraft(app);
      const res = await send(app, id, { recipientContactIds: ['c-held', 'c-declined'] });
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
      expect(Object.keys(world.broadcasts.get(id)!.recipients).sort()).toEqual(['c-declined', 'c-held']);
    });

    it('(PIN) path (b), a seeds_only no-body send, is unchanged: a held seed is sent', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-held', phone: '+15550306701' });
      seedUpcomingTour('t-held', 'c-held');
      const { app } = makeWebhookHarness({ world });
      const created = await request(app)
        .post('/api/broadcasts')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ unitId: 'unit-1', body_template: 'hi', seedContactIds: ['c-held'] });
      expect(created.status).toBe(201);
      const res = await send(app, created.body.broadcastId as string);
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
    });
  });
});
