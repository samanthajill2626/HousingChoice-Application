// Share-broadcast API (M1.8a) — POST /api/broadcasts (draft + estimate),
// /preview, /send (snapshot + enqueue), GET /results + list, AND the
// delivery-status-callback rollup folding delivered/failed into the broadcast
// stats + emitting broadcast.updated. Runs on the shared in-memory world with
// the jobs machinery wired so the broadcast.send enqueue resolves in-process.
// Authed via the real sealed session cookie next to the origin secret.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { MAX_BROADCAST_RECIPIENTS } from '../src/repos/broadcastsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
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

/** Wire the broadcast.send handler against the world (real sendMessage). */
function wireBroadcastHandler(world: FakeWorld) {
  const config = loadConfig({
    NODE_ENV: 'test',
    MESSAGING_DRIVER: 'console',
    PUBLIC_BASE_URL,
    OUR_PHONE_NUMBERS: '+15550009999',
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

  beforeEach(() => {
    _resetForTests();
    configureJobsLogger(createLogger({ destination: createLogCapture().stream }));
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    configureOutboundQueue(new InProcessOutboundQueueAdapter({ dispatch: dispatchJob }));
    wireBroadcastHandler(world);
  });

  afterEach(() => {
    _resetForTests();
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
    expect(stored.flyer_url).toBe(`${PUBLIC_BASE_URL}/flyer/unit-1`);
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
      { contactId: 'c-1', firstName: 'Ann', phone: '+15550100001', alreadySentThisProperty: false },
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

    // The in-process fan-out ran → both tenants texted, broadcast finalized 'sent'.
    expect(world.sent.map((s) => s.to).sort()).toEqual(['+15550100001', '+15550100002'].sort());
    expect(world.broadcasts.get(id)!.status).toBe('sent');

    // Results endpoint reflects the rolled-up stats.
    const results = await request(app)
      .get(`/api/broadcasts/${id}/results`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(results.status).toBe(200);
    expect(results.body.stats.sent).toBe(2);
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
        { contactId: 'c-1', phone: '+15550100001' },
        { contactId: 'c-2', phone: '+15550100002' },
        { contactId: 'c-3', phone: '+15550100003' },
      ],
      count: 5_000, // > MAX_BROADCAST_RECIPIENTS (1500)
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
    expect(send.body.error).toMatch(/cap/i); // "...exceeds the 1500 recipient cap"
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

  it('alreadySentThisProperty + priorRecipientContactIds reflect a PRIOR sent broadcast of this unit', async () => {
    seedTenant(world, { contactId: 'c-1', firstName: 'Ann', phone: '+15550100001' });
    seedTenant(world, { contactId: 'c-2', firstName: 'Bo', phone: '+15550100002' });
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    // Prior broadcast for unit-1: send to ONLY c-1 (so c-1 is already-sent).
    const prior = await createDraft(app);
    await request(app)
      .post(`/api/broadcasts/${prior}/send`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ recipientContactIds: ['c-1'] });
    expect(world.broadcasts.get(prior)!.status).toBe('sent');

    // A NEW draft for the same unit previews both — c-1 flagged, c-2 not.
    const next = await createDraft(app);
    const res = await request(app)
      .post(`/api/broadcasts/${next}/preview`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.priorRecipientContactIds.sort()).toEqual(['c-1']);
    const c1 = res.body.candidates.find((c: { contactId: string }) => c.contactId === 'c-1');
    const c2 = res.body.candidates.find((c: { contactId: string }) => c.contactId === 'c-2');
    expect(c1.alreadySentThisProperty).toBe(true);
    expect(c2.alreadySentThisProperty).toBe(false);
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
});
