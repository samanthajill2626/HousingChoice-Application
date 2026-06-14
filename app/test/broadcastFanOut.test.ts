// broadcast.send (M1.8a) — the milestone golden tests for the share-broadcast
// fan-out job in isolation: 1:1 send per tenant via the REAL sendMessage
// wrapper, message tagged broadcast_id, stats roll up, token-bucket pacing,
// opt-out skip (no token, no send), 429/30022 continuation (capped), 30007
// never-retried, and job-marker idempotency. Driven through the real jobs
// envelope machinery (enqueue → InMemoryScheduler/InProcessOutboundQueue →
// dispatchJob) so the jobId-marker idempotency guard is exercised for real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import type { SendMessageParams } from '../src/adapters/messaging.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
  dispatchJob,
  enqueueImmediate,
} from '../src/jobs/jobs.js';
import {
  BROADCAST_SEND_JOB,
  broadcastBackoffMs,
  registerBroadcastSendJobHandler,
} from '../src/jobs/broadcastFanOut.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { TokenBucket } from '../src/lib/tokenBucket.js';
import type { BroadcastItem, BroadcastRecipient } from '../src/repos/broadcastsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { createSendMessageService } from '../src/services/sendMessage.js';
import { DEV_SESSION_SECRET_DEFAULT } from '../src/lib/config.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { createLogCapture } from './helpers/logCapture.js';

const PUBLIC_BASE = 'https://dxxxx.cloudfront.example';

function testConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    MESSAGING_DRIVER: 'console',
    PUBLIC_BASE_URL: PUBLIC_BASE,
    SESSION_SECRET: DEV_SESSION_SECRET_DEFAULT,
  } as NodeJS.ProcessEnv);
}

function seedTenant(world: FakeWorld, overrides: Partial<ContactItem>): ContactItem {
  const c: ContactItem = {
    contactId: `c-${world.contacts.length + 1}`,
    type: 'tenant',
    status: 'active',
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
    address: { line1: '1 Oak', city: 'Town', state: 'IL', zip: '60000' },
  };
  world.units.set(u.unitId, u);
  return u;
}

/** Seed a 'sending' broadcast with the given tenants' recipient slots queued. */
function seedBroadcast(
  world: FakeWorld,
  tenants: ContactItem[],
  overrides: Partial<BroadcastItem> = {},
): BroadcastItem {
  const recipients: Record<string, BroadcastRecipient> = {};
  for (const t of tenants) recipients[t.contactId] = { status: 'queued' };
  const now = new Date().toISOString();
  const item: BroadcastItem = {
    broadcastId: 'bcast-1',
    created_by: 'usr_test',
    created_at: now,
    status: 'sending',
    unitId: 'unit-1',
    audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
    body_template: 'Hi [TenantName], a [Beds]bd for [Rent]: [FlyerLink]',
    stats: {
      audience: tenants.length,
      sent: 0,
      delivered: 0,
      failed: 0,
      skipped_opted_out: 0,
      queued: tenants.length,
    },
    recipients,
    updated_at: now,
    ...overrides,
  };
  world.broadcasts.set(item.broadcastId, item);
  return item;
}

function wireHandler(world: FakeWorld, logger = createLogger({ destination: createLogCapture().stream }), tokenBucket?: TokenBucket) {
  const config = testConfig();
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
    ...(tokenBucket !== undefined && { tokenBucket }),
  });
}

describe('broadcast.send (M1.8a)', () => {
  let world: FakeWorld;
  let logger: ReturnType<typeof createLogger>;
  let outbound: InProcessOutboundQueueAdapter;

  beforeEach(() => {
    _resetForTests();
    logger = createLogger({ level: 'info', destination: createLogCapture().stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    // Delay refactor: the <=12min transient continuation (5/10/20s) routes
    // through the SQS path (outbound adapter), recorded in `delayed[]` for
    // assertions; NOT EventBridge.
    outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(outbound);
  });

  afterEach(() => {
    _resetForTests();
  });

  it('fans out to each tenant 1:1, tags broadcast_id, renders merge fields, rolls up stats', async () => {
    const alice = seedTenant(world, { contactId: 'c-alice', firstName: 'Alice', phone: '+15550100001' });
    const bob = seedTenant(world, { contactId: 'c-bob', phone: '+15550100002' }); // no firstName
    seedUnit(world);
    seedBroadcast(world, [alice, bob]);
    wireHandler(world, logger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });

    // Two sends, one per tenant, to their own phones.
    expect(world.sent.map((s) => s.to).sort()).toEqual([alice.phone, bob.phone].sort());

    // Each persisted outbound message carries broadcast_id.
    const outbound = world.messages.filter((m) => m.direction === 'outbound');
    expect(outbound).toHaveLength(2);
    expect(outbound.every((m) => m.broadcast_id === 'bcast-1')).toBe(true);

    // Merge fields rendered: Alice by name, Bob falls back to the neutral label.
    const aliceMsg = world.messages.find((m) => m.body?.startsWith('Hi Alice'));
    expect(aliceMsg?.body).toBe(`Hi Alice, a 2bd for $1200–$1400: ${PUBLIC_BASE}/flyer/unit-1`);
    const bobMsg = world.messages.find((m) => m.body?.startsWith('Hi there'));
    expect(bobMsg).toBeDefined();
    expect(bobMsg?.body).not.toMatch(/\+1555/); // never leak the phone

    // Stats rolled up: 2 sent, 0 queued left, broadcast terminal 'sent'.
    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.stats.sent).toBe(2);
    expect(bcast.stats.queued).toBe(0);
    expect(bcast.status).toBe('sent');

    // Per-recipient slots recorded with conversationId + tsMsgId.
    expect(bcast.recipients['c-alice']?.status).toBe('sent');
    expect(bcast.recipients['c-alice']?.tsMsgId).toBeDefined();
    expect(bcast.recipients['c-alice']?.conversationId).toBeDefined();

    // A broadcast.updated SSE event fired on completion.
    const evt = world.emitted.find((e) => e.event === 'broadcast.updated');
    expect(evt).toBeDefined();
    expect((evt!.payload as { status: string }).status).toBe('sent');
  });

  it('skips an opted-out recipient (skipped_opted_out++), NO token spent, NO send', async () => {
    const ok = seedTenant(world, { contactId: 'c-ok', firstName: 'Ok', phone: '+15550100001' });
    const stopped = seedTenant(world, { contactId: 'c-stop', sms_opt_out: true, phone: '+15550100002' });
    seedUnit(world);
    seedBroadcast(world, [ok, stopped]);

    // Spy on the bucket: acquire() must be called exactly once (only for `ok`).
    const acquire = vi.fn(async () => {});
    const bucket = { acquire } as unknown as TokenBucket;
    wireHandler(world, logger, bucket);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });

    // Only the reachable tenant was texted; the opted-out one never.
    expect(world.sent.map((s) => s.to)).toEqual([ok.phone]);
    expect(acquire).toHaveBeenCalledTimes(1); // NO token spent on the skip

    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.stats.sent).toBe(1);
    expect(bcast.stats.skipped_opted_out).toBe(1);
    expect(bcast.recipients['c-stop']?.status).toBe('skipped');
    expect(bcast.status).toBe('sent'); // sent ones succeeded
  });

  it('100-recipient broadcast trickles through the bucket (injected clock) and completes', async () => {
    const tenants: ContactItem[] = [];
    for (let i = 0; i < 100; i++) {
      tenants.push(seedTenant(world, { contactId: `c-${i}`, phone: `+1555011${String(i).padStart(4, '0')}` }));
    }
    seedUnit(world);
    seedBroadcast(world, tenants);

    // Fake clock: 2 tokens/sec, capacity 2 (starts full). 100 sends need ~49s.
    let nowMs = 0;
    const sleeps: number[] = [];
    const bucket = new TokenBucket({
      capacity: 2,
      refillPerSec: 2,
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms; // advance the clock by exactly the requested wait
      },
      maxJitterMs: 0,
    });
    wireHandler(world, logger, bucket);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });

    expect(world.sent).toHaveLength(100);
    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.stats.sent).toBe(100);
    expect(bcast.status).toBe('sent');
    // The first 2 went immediately (full bucket); the rest paced — so the
    // handler slept and the injected clock advanced (~49s of waits).
    expect(sleeps.length).toBeGreaterThan(0);
    expect(nowMs).toBeGreaterThanOrEqual(48_000);
  });

  it('429/30022 mid-batch → continuation enqueued with ONLY the remaining recipients', async () => {
    const a = seedTenant(world, { contactId: 'c-a', phone: '+15550100001' });
    const b = seedTenant(world, { contactId: 'c-b', phone: '+15550100002' });
    seedUnit(world);
    seedBroadcast(world, [a, b]);
    wireHandler(world, logger);

    // Bob's send rate-limits (429); Alice succeeds.
    world.adapter.sendMessage = async (params: SendMessageParams) => {
      if (params.to === b.phone) throw Object.assign(new Error('rate limited'), { code: 429 });
      return { providerSid: `SMok-${params.to}`, status: 'sent', providerTs: new Date().toISOString() };
    };

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });

    // A continuation broadcast.send was enqueued (SQS path) for ONLY the
    // deferred key, with an exact DelaySeconds backoff — not an EventBridge
    // schedule.
    expect(outbound.delayed).toHaveLength(1);
    const cont = outbound.delayed[0]!.envelope;
    expect(cont.jobName).toBe(BROADCAST_SEND_JOB);
    const payload = cont.payload as { recipientKeys?: string[]; attempt?: number };
    expect(payload.recipientKeys).toEqual(['c-b']);
    expect(payload.attempt).toBe(2);
    // Not finalized yet (a continuation is pending).
    expect(world.broadcasts.get('bcast-1')!.status).toBe('sending');
  });

  it('429 capped at MAX_BROADCAST_ATTEMPTS → remaining marked failed, finalized', async () => {
    const b = seedTenant(world, { contactId: 'c-b', phone: '+15550100002' });
    seedUnit(world);
    seedBroadcast(world, [b]);
    wireHandler(world, logger);
    world.adapter.sendMessage = async () => {
      throw Object.assign(new Error('rate limited'), { code: 429 });
    };

    // attempt=3 is the last allowed; the next would be 4 > MAX(3) → cap reached.
    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1', attempt: 3 });

    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.recipients['c-b']?.status).toBe('failed');
    expect(bcast.recipients['c-b']?.errorCode).toBe('transient_cap');
    expect(bcast.stats.failed).toBe(1);
    expect(bcast.status).toBe('failed'); // all (1) failed
  });

  it('30007 carrier filtering → recipient failed, NEVER retried', async () => {
    const b = seedTenant(world, { contactId: 'c-b', phone: '+15550100002' });
    seedUnit(world);
    seedBroadcast(world, [b]);
    wireHandler(world, logger);
    world.adapter.sendMessage = async () => {
      throw Object.assign(new Error('filtered'), { code: 30007 });
    };

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });

    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.recipients['c-b']?.status).toBe('failed');
    expect(bcast.recipients['c-b']?.errorCode).toBe('30007');
    expect(bcast.status).toBe('failed');
    // No continuation enqueued — 30007 is never retried.
    expect(outbound.delayed).toHaveLength(0);
  });

  it('30005 invalid number → recipient failed + contact flagged sms_unreachable', async () => {
    const b = seedTenant(world, { contactId: 'c-b', phone: '+15550100002' });
    seedUnit(world);
    seedBroadcast(world, [b]);
    wireHandler(world, logger);
    world.adapter.sendMessage = async () => {
      throw Object.assign(new Error('invalid'), { code: 30005 });
    };

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });

    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.recipients['c-b']?.status).toBe('failed');
    expect(world.flagWrites.some((f) => f.contactId === 'c-b' && f.flag === 'sms_unreachable')).toBe(true);
  });

  it('idempotency: a redelivered job (same jobId) never double-sends', async () => {
    const a = seedTenant(world, { contactId: 'c-a', phone: '+15550100001' });
    seedUnit(world);
    seedBroadcast(world, [a]);
    wireHandler(world, logger);

    const envelope = await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    expect(world.sent).toHaveLength(1);

    // Re-dispatch the SAME envelope (SQS at-least-once): the jobId marker
    // suppresses it — no further sends.
    await dispatchJob(JSON.parse(JSON.stringify(envelope)));
    expect(world.sent).toHaveLength(1);
  });

  it('per-recipient idempotency: a continuation skips a recipient already terminal', async () => {
    const a = seedTenant(world, { contactId: 'c-a', phone: '+15550100001' });
    const b = seedTenant(world, { contactId: 'c-b', phone: '+15550100002' });
    seedUnit(world);
    const bcast = seedBroadcast(world, [a, b]);
    // Pre-mark Alice 'sent' (a prior partial pass).
    bcast.recipients['c-a'] = { status: 'sent', conversationId: 'conv-x', tsMsgId: 'ts-x' };
    wireHandler(world, logger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });

    // Only Bob is sent — Alice was already terminal.
    expect(world.sent.map((s) => s.to)).toEqual([b.phone]);
  });

  // --- FIX 2: a refused send (sendMessage SendRefusedError) spends NO token ---
  it('conversation-level opt-out → sendMessage refuses → skipped, NO token spent (FIX 2)', async () => {
    // Contact-level flag is FALSE so the pre-token first fence PASSES; the
    // refusal comes from sendMessage's conversation-level opt-out gate — which
    // throws BEFORE any adapter send, so no token may be consumed.
    const ok = seedTenant(world, { contactId: 'c-ok', firstName: 'Ok', phone: '+15550100001' });
    const stopped = seedTenant(world, { contactId: 'c-stop', phone: '+15550100002' }); // flag false
    seedUnit(world);
    seedBroadcast(world, [ok, stopped]);

    // Pre-create the stopped tenant's 1:1 conversation with the CONVERSATION
    // opt-out flag set (a STOP from a phone before its contact was flagged).
    const stoppedConv = await world.conversationsRepo.createOrGetByParticipantPhone(
      stopped.phone!,
      'tenant_1to1',
    );
    await world.conversationsRepo.setSmsOptOut(stoppedConv.conversationId, true);

    const acquire = vi.fn(async () => {});
    const bucket = { acquire } as unknown as TokenBucket;
    wireHandler(world, logger, bucket);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });

    // Only the reachable tenant was texted; the conversation-opted-out one never.
    expect(world.sent.map((s) => s.to)).toEqual([ok.phone]);
    // The token was acquired ONLY for the real send — the refusal spent none.
    expect(acquire).toHaveBeenCalledTimes(1);

    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.recipients['c-stop']?.status).toBe('skipped');
    expect(bcast.recipients['c-stop']?.errorCode).toBe('contact_opted_out');
    expect(bcast.stats.sent).toBe(1);
    expect(bcast.stats.skipped_opted_out).toBe(1);
  });

  // --- FIX 6: the continuation waits ITS OWN attempt's backoff -------------
  it('continuation backoff uses the NEXT attempt delay (FIX 6)', async () => {
    const b = seedTenant(world, { contactId: 'c-b', phone: '+15550100002' });
    seedUnit(world);
    seedBroadcast(world, [b]);
    wireHandler(world, logger);
    world.adapter.sendMessage = async () => {
      throw Object.assign(new Error('rate limited'), { code: 429 });
    };

    // First run is attempt 1 → the continuation runs AS attempt 2, so it must
    // wait broadcastBackoffMs(2) = 10s (NOT broadcastBackoffMs(1) = 5s). Via
    // the SQS path this is an EXACT DelaySeconds of 10 (no EventBridge floor).
    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1', attempt: 1 });

    expect(outbound.delayed).toHaveLength(1);
    const item = outbound.delayed[0]!;
    expect((item.envelope.payload as { attempt?: number }).attempt).toBe(2);
    const expected = broadcastBackoffMs(2); // 10_000
    expect(expected).toBe(10_000);
    // The recorded DelaySeconds matches the 2nd-step backoff exactly.
    expect(item.delaySeconds).toBe(10);
  });
});
