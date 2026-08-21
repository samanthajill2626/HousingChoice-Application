// Read-amplification pins (docs/issues/contacts-batchget-amplified-reads.md).
//
// Six routes used to resolve contacts one GetItem at a time inside per-row
// loops, so cost scaled linearly with row count. These tests assert the thing
// the issue actually cares about - ROUND-TRIP COUNT - rather than wall-clock,
// because local DynamoDB timings are emulator-bound and scale with table size
// regardless of what a query returns. Each case seeds enough rows that a
// per-row fan-out is unmistakable (N getById calls) and pins the batched shape
// (zero getById, one batch call).
//
// Two batch primitives are in play, and which one a site uses is a real
// decision, not an accident:
//   - getDisplaysByIds  - projects contactId/firstName/lastName/phone. Used
//     where the route only labels a row. Strictly less data over the wire.
//   - getManyByIds      - full items. Used where the route reads attributes
//     outside that projection (roster reads `company`; the send path re-fences
//     on `type`/`sms_opt_out`/`sms_unreachable`).
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
  defineJobHandler,
  dispatchJob,
} from '../src/jobs/jobs.js';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  ORIGIN_SECRET,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';

const SECRET = ORIGIN_SECRET;

/** Enough rows that a per-row fan-out is unmistakable, still one batch chunk. */
const N = 12;

/** The audience filter shape every broadcast row carries. */
const FILTER = {
  contact_type: 'tenant' as const,
  excludeOptedOut: true,
  excludeUnreachable: true,
};

const authedGet = (app: import('express').Express, path: string) =>
  request(app).get(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);

function seedTenants(world: FakeWorld, ids: string[]): void {
  for (const [i, contactId] of ids.entries()) {
    world.contacts.push({
      contactId,
      type: 'tenant',
      status: 'searching',
      firstName: `First${i}`,
      lastName: `Last${i}`,
      phone: `+1555020${String(i).padStart(4, '0')}`,
      consent_method: 'inbound_text',
    } as ContactItem);
  }
}

function ids(prefix: string, n = N): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
}

/** Spy both the per-row read and the two batch primitives on the shared repo. */
function watchReads(world: FakeWorld) {
  return {
    getById: vi.spyOn(world.contactsRepo, 'getById'),
    getDisplaysByIds: vi.spyOn(world.contactsRepo, 'getDisplaysByIds'),
    getManyByIds: vi.spyOn(world.contactsRepo, 'getManyByIds'),
  };
}

describe('contact read amplification - property (unit) routes', () => {
  let world: FakeWorld;

  beforeEach(() => {
    world = createFakeWorld();
  });

  it('roster enrichment batches: one getManyByIds, zero per-row getById', async () => {
    const roster = ids('c-roster');
    seedTenants(world, roster);
    world.units.set('unit-1', {
      unitId: 'unit-1',
      landlordId: roster[0]!,
      status: 'available',
      created_at: '2026-06-12T09:00:00.000Z',
      updated_at: '2026-06-12T09:00:00.000Z',
      contacts: roster.map((contactId) => ({ contactId, role: 'pm' as const, primaryContact: false })),
    });
    const { app } = makeWebhookHarness({ world });
    const reads = watchReads(world);

    const res = await authedGet(app, '/api/units/unit-1');

    expect(res.status).toBe(200);
    expect(reads.getById).not.toHaveBeenCalled();
    expect(reads.getManyByIds).toHaveBeenCalledTimes(1);
    // Still enriched, and still reading a field OUTSIDE the display projection.
    const rows = res.body.unit.contacts as Array<Record<string, unknown>>;
    expect(rows.find((r) => r['contactId'] === roster[3])).toMatchObject({ name: 'First3 Last3' });
  });

  it('roster enrichment reads `company`, which the display projection does not carry', async () => {
    world.contacts.push({
      contactId: 'c-ll',
      type: 'landlord',
      firstName: 'Dana',
      company: 'Keystone Properties',
    } as ContactItem);
    world.units.set('unit-co', {
      unitId: 'unit-co',
      landlordId: 'c-ll',
      status: 'available',
      created_at: '2026-06-12T09:00:00.000Z',
      updated_at: '2026-06-12T09:00:00.000Z',
      contacts: [{ contactId: 'c-ll', role: 'landlord' as const, primaryContact: true }],
    });
    const { app } = makeWebhookHarness({ world });

    const res = await authedGet(app, '/api/units/unit-co');

    expect(res.status).toBe(200);
    const row = (res.body.unit.contacts as Array<Record<string, unknown>>)[0];
    expect(row).toMatchObject({ name: 'Dana', company: 'Keystone Properties' });
  });

  it('recipients name hydration batches: one display batch, zero per-row getById', async () => {
    const tenants = ids('c-recip');
    seedTenants(world, tenants);
    world.units.set('unit-2', {
      unitId: 'unit-2',
      landlordId: 'c-ll',
      status: 'available',
      created_at: '2026-06-12T09:00:00.000Z',
      updated_at: '2026-06-12T09:00:00.000Z',
    });
    for (const contactId of tenants) {
      await world.listingSendsRepo.recordSend({ contactId, unitId: 'unit-2', via: 'individual' });
    }
    const { app } = makeWebhookHarness({ world });
    const reads = watchReads(world);

    const res = await authedGet(app, '/api/units/unit-2/recipients');

    expect(res.status).toBe(200);
    expect(res.body.recipients).toHaveLength(N);
    expect(reads.getById).not.toHaveBeenCalled();
    expect(reads.getDisplaysByIds).toHaveBeenCalledTimes(1);
    // Pin the RENDERED name too (adversarial review r1 finding 6): a call-count
    // assertion alone would still pass if the enrichment loop were deleted.
    const row = (res.body.recipients as Array<Record<string, unknown>>).find(
      (r) => r['contactId'] === tenants[5],
    );
    expect(row).toMatchObject({ tenantName: 'First5 Last5' });
  });

  it('placements tenant names batch: one display batch, zero per-row getById', async () => {
    const tenants = ids('c-plc');
    seedTenants(world, tenants);
    world.units.set('unit-3', {
      unitId: 'unit-3',
      landlordId: 'c-ll',
      status: 'available',
      created_at: '2026-06-12T09:00:00.000Z',
      updated_at: '2026-06-12T09:00:00.000Z',
    });
    for (const [i, tenantId] of tenants.entries()) {
      world.placements.set(`p-${i}`, {
        placementId: `p-${i}`,
        tenantId,
        unitId: 'unit-3',
        stage: 'awaiting_inspection',
        created_at: '2026-06-12T09:00:00.000Z',
        updated_at: '2026-06-12T09:00:00.000Z',
      });
    }
    const { app } = makeWebhookHarness({ world });
    const reads = watchReads(world);

    const res = await authedGet(app, '/api/units/unit-3/placements');

    expect(res.status).toBe(200);
    expect(reads.getById).not.toHaveBeenCalled();
    expect(reads.getDisplaysByIds).toHaveBeenCalledTimes(1);
    const row = (res.body.placements as Array<Record<string, unknown>>).find(
      (p) => p['tenantId'] === tenants[5],
    );
    expect(row).toMatchObject({ tenantName: 'First5 Last5' });
  });

  it('activity contactName enrichment batches: one display batch, zero per-row getById', async () => {
    const tenants = ids('c-act');
    seedTenants(world, tenants);
    world.units.set('unit-4', {
      unitId: 'unit-4',
      landlordId: 'c-ll',
      status: 'available',
      created_at: '2026-06-12T09:00:00.000Z',
      updated_at: '2026-06-12T09:00:00.000Z',
    });
    for (const contactId of tenants) {
      await world.auditRepo.append('units#unit-4', 'unit_contact_added', {
        contactId,
        role: 'property_manager',
      });
    }
    const { app } = makeWebhookHarness({ world });
    const reads = watchReads(world);

    const res = await authedGet(app, '/api/units/unit-4/activity');

    expect(res.status).toBe(200);
    expect(reads.getById).not.toHaveBeenCalled();
    expect(reads.getDisplaysByIds).toHaveBeenCalledTimes(1);
    const named = (res.body.events as Array<Record<string, unknown>>).filter(
      (e) => e['contactName'] !== undefined,
    );
    expect(named).toHaveLength(N);
  });

  it('a batch failure degrades the page instead of 500ing it (blast radius is the whole chunk)', async () => {
    const tenants = ids('c-fail');
    seedTenants(world, tenants);
    world.units.set('unit-5', {
      unitId: 'unit-5',
      landlordId: 'c-ll',
      status: 'available',
      created_at: '2026-06-12T09:00:00.000Z',
      updated_at: '2026-06-12T09:00:00.000Z',
    });
    for (const contactId of tenants) {
      await world.auditRepo.append('units#unit-5', 'unit_contact_added', {
        contactId,
        role: 'property_manager',
      });
    }
    const { app } = makeWebhookHarness({ world });
    vi.spyOn(world.contactsRepo, 'getDisplaysByIds').mockRejectedValue(new Error('dynamo down'));

    const res = await authedGet(app, '/api/units/unit-5/activity');

    // Never a 500: the rows serve nameless and the client falls back to the id.
    expect(res.status).toBe(200);
    const events = res.body.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(N);
    for (const event of events) expect(event).not.toHaveProperty('contactName');
  });
});

describe('contact read amplification - broadcast routes', () => {
  let world: FakeWorld;
  let queueAdapter: InProcessOutboundQueueAdapter;

  beforeEach(() => {
    _resetForTests();
    configureJobsLogger(createLogger({ destination: createLogCapture().stream }));
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    queueAdapter = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(queueAdapter);
    // These tests assert on the SEND ROUTE, not the fan-out. A no-op handler
    // keeps settle() deterministic and quiet - without one every enqueue logs a
    // swallowed 'no handler registered' error that reads like a real failure.
    defineJobHandler('broadcast.send', async () => {});
  });

  it('results enrichment batches: one display batch, zero per-row getById', async () => {
    const recipients = ids('c-bres');
    seedTenants(world, recipients);
    const { app } = makeWebhookHarness({ world });
    const created = await world.broadcastsRepo.create({
      created_by: 'u',
      audience_filter: FILTER,
      body_template: 'hi',
    });
    await world.broadcastsRepo.markSending(
      created.broadcastId,
      Object.fromEntries(recipients.map((id) => [id, { status: 'sent' as const }])),
    );
    const reads = watchReads(world);

    const res = await authedGet(app, `/api/broadcasts/${created.broadcastId}/results`);

    expect(res.status).toBe(200);
    expect(reads.getById).not.toHaveBeenCalled();
    expect(reads.getDisplaysByIds).toHaveBeenCalledTimes(1);
    // The projection is exactly what this route renders - identity survives.
    expect(res.body.recipients[recipients[2]!]).toMatchObject({
      firstName: 'First2',
      lastName: 'Last2',
      phone: '+15550200002',
    });
  });

  it('results enrichment still omits identity for an unresolvable id, and never echoes the key', async () => {
    const { app } = makeWebhookHarness({ world });
    const created = await world.broadcastsRepo.create({
      created_by: 'u',
      audience_filter: FILTER,
      body_template: 'hi',
    });
    await world.broadcastsRepo.markSending(created.broadcastId, {
      'c-ghost': { status: 'sent' },
      'phone#+15550100077': { status: 'sent' },
    });

    const res = await authedGet(app, `/api/broadcasts/${created.broadcastId}/results`);

    expect(res.status).toBe(200);
    expect(res.body.recipients['c-ghost']).not.toHaveProperty('firstName');
    expect(res.body.recipients['c-ghost']).not.toHaveProperty('phone');
    // A phone# key still takes its phone from the key, with no lookup at all.
    expect(res.body.recipients['phone#+15550100077']).toMatchObject({ phone: '+15550100077' });
  });

  it('the selection send path batches its re-fence reads: one getManyByIds, zero per-row getById', async () => {
    const recipients = ids('c-bsend');
    seedTenants(world, recipients);
    world.units.set('unit-1', {
      unitId: 'unit-1',
      landlordId: 'c-ll',
      status: 'available',
      beds: 2,
      rent_min: 1200,
      rent_max: 1400,
    });
    const { app } = makeWebhookHarness({ world });
    const draft = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'hi', audience_filter: FILTER });
    const reads = watchReads(world);

    const res = await request(app)
      .post(`/api/broadcasts/${draft.body.broadcastId}/send`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ recipientContactIds: recipients });

    // Assert BEFORE settling the queue: the fan-out job has its own reads and
    // is not what this test is about.
    expect(res.status).toBe(200);
    expect(reads.getById).not.toHaveBeenCalled();
    expect(reads.getManyByIds).toHaveBeenCalledTimes(1);
    await queueAdapter.settle();
  });

  it('the selection send path still re-fences every contact it batched', async () => {
    seedTenants(world, ['c-ok']);
    world.contacts.push({ contactId: 'c-optout', type: 'tenant', phone: '+15550200900', sms_opt_out: true } as ContactItem);
    world.contacts.push({ contactId: 'c-unreach', type: 'tenant', phone: '+15550200901', sms_unreachable: true } as ContactItem);
    world.contacts.push({ contactId: 'c-landlord', type: 'landlord', phone: '+15550200902' } as ContactItem);
    world.units.set('unit-1', { unitId: 'unit-1', landlordId: 'c-ll', status: 'available', beds: 2, rent_min: 1200, rent_max: 1400 });
    const { app } = makeWebhookHarness({ world });
    const draft = await request(app)
      .post('/api/broadcasts')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ unitId: 'unit-1', body_template: 'hi', audience_filter: FILTER });

    await request(app)
      .post(`/api/broadcasts/${draft.body.broadcastId}/send`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ recipientContactIds: ['c-ok', 'c-optout', 'c-unreach', 'c-landlord', 'c-ghost'] });
    await queueAdapter.settle();

    const res = await authedGet(app, `/api/broadcasts/${draft.body.broadcastId}/results`);
    expect(res.status).toBe(200);
    // Only the clean tenant survives the fences - batching changed HOW they are
    // read, never WHICH ones pass.
    expect(Object.keys(res.body.recipients)).toEqual(['c-ok']);
  });
});
