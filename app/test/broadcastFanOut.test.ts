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
import type { PreparedMessageSend } from '../src/adapters/messaging.js';
import { SmsSendingDisabledError as AdapterSmsSendingDisabledError } from '../src/adapters/messagingErrors.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
  defineJobHandler,
  dispatchJob,
  enqueue,
  enqueueImmediate,
} from '../src/jobs/jobs.js';
import {
  BROADCAST_SEND_JOB,
  broadcastBackoffMs,
  finalize,
  parseBroadcastSendPayload,
  registerBroadcastSendJobHandler,
} from '../src/jobs/broadcastFanOut.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { TokenBucket } from '../src/lib/tokenBucket.js';
import type {
  BroadcastItem,
  BroadcastRecipient,
  BroadcastStats,
} from '../src/repos/broadcastsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { createSendMessageService } from '../src/services/sendMessage.js';
import { DEV_SESSION_SECRET_DEFAULT } from '../src/lib/config.js';
import { hashRecipientKey } from '../src/lib/sendFingerprint.js';
import {
  SEND_RECONCILE_JOB,
  registerSendReconcileJobHandler,
  type SendReconcilePayload,
} from '../src/jobs/sendReconcile.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';

const PUBLIC_BASE = 'https://dxxxx.cloudfront.example';

/** `env` merges over the fixed test env (e.g. SMS_SENDING_ENABLED: 'false'). */
function testConfig(env: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    MESSAGING_DRIVER: 'console',
    PUBLIC_BASE_URL: PUBLIC_BASE,
    SESSION_SECRET: DEV_SESSION_SECRET_DEFAULT,
    ...env,
  } as NodeJS.ProcessEnv);
}

function seedTenant(world: FakeWorld, overrides: Partial<ContactItem>): ContactItem {
  const c: ContactItem = {
    contactId: `c-${world.contacts.length + 1}`,
    type: 'tenant',
    status: 'active',
    phone: `+1555010${String(world.contacts.length + 1).padStart(4, '0')}`,
    // A2P/CTIA: a real broadcast audience carries recorded consent; default it
    // so these fan-out tests exercise the SEND path (override to drop it for the
    // no-consent-fence test).
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
      skipped_no_consent: 0,
      queued: tenants.length,
    },
    recipients,
    updated_at: now,
    ...overrides,
  };
  world.broadcasts.set(item.broadcastId, item);
  return item;
}

/** `env` (optional) overrides the config env for BOTH the wrapper and the job. */
function wireHandler(
  world: FakeWorld,
  logger = createLogger({ destination: createLogCapture().stream }),
  tokenBucket?: TokenBucket,
  env: Record<string, string> = {},
) {
  const config = testConfig(env);
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
    auditRepo: world.auditRepo,
    activityEventsRepo: world.activityEventsRepo,
    listingSendsRepo: world.listingSendsRepo,
    events: world.events,
    logger,
    ...(tokenBucket !== undefined && { tokenBucket }),
  });
}

/**
 * The single operator ERROR line every close writes (M5 D8): the cap reached
 * mid-ladder, a pass beginning with the ladder already spent, and a failed
 * continuation enqueue all land on one message, parameterised by closeCode.
 * Matched by message so an unrelated error line cannot inflate the count.
 */
function closeLines(capture: LogCapture): Record<string, unknown>[] {
  return capture
    .atLevel(50)
    .filter((l) => typeof l['msg'] === 'string' && (l['msg'] as string).includes('fan-out closed'));
}

/** A capturing logger whose ERROR lines the close assertions read. */
function capturingLogger(): { capture: LogCapture; logger: ReturnType<typeof createLogger> } {
  const capture = createLogCapture();
  return { capture, logger: createLogger({ level: 'info', destination: capture.stream }) };
}

/**
 * Send stubs as vi.fn COUNTERS. The messaging adapter is replaced wholesale
 * here, so `world.sent` (appended inside the harness adapter) never fills for a
 * deferring recipient - the stub's own call count is the only honest send count.
 */
/** A send stub that must never run - calling it fails the test loudly. */
function neverSends() {
  return vi.fn(async (): Promise<never> => {
    throw new Error('sendMessage must not be called on this pass');
  });
}

/** A send stub that always rate-limits (429 = transient -> continuation). */
function alwaysRateLimits() {
  return vi.fn(async (): Promise<never> => {
    throw Object.assign(new Error('rate limited'), { code: 429 });
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
    await outbound.settle();

    // Two sends, one per tenant, to their own phones.
    expect(world.sent.map((s) => s.to).sort()).toEqual([alice.phone, bob.phone].sort());

    // Each persisted outbound message carries broadcast_id.
    const outboundMsgs = world.messages.filter((m) => m.direction === 'outbound');
    expect(outboundMsgs).toHaveLength(2);
    expect(outboundMsgs.every((m) => m.broadcast_id === 'bcast-1')).toBe(true);

    // Merge fields rendered: Alice by name, Bob falls back to the neutral label.
    const aliceMsg = world.messages.find((m) => m.body?.startsWith('Hi Alice'));
    expect(aliceMsg?.body).toBe(`Hi Alice, a 2bd for $1200-$1400: ${PUBLIC_BASE}/p/unit-1?cta=text`);
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

    // broadcast.updated SSE events fired: a live tick per recipient PLUS the
    // terminal 'sent' on finalize (S2). The LAST one is the terminal emit.
    const updates = world.emitted.filter((e) => e.event === 'broadcast.updated');
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect((updates.at(-1)!.payload as { status: string }).status).toBe('sent');
  });

  it('writes a units# broadcast_sent audit row with the recipient count on completion', async () => {
    const alice = seedTenant(world, { contactId: 'c-alice', firstName: 'Alice', phone: '+15550100001' });
    const bob = seedTenant(world, { contactId: 'c-bob', phone: '+15550100002' });
    seedUnit(world); // unitId 'unit-1'
    seedBroadcast(world, [alice, bob]); // unitId 'unit-1', 2 recipients
    wireHandler(world, logger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    const rows = world.auditEvents.filter(
      (e) => e.entityKey === 'units#unit-1' && e.event_type === 'broadcast_sent',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ broadcastId: 'bcast-1', tenantCount: 2 });
  });

  it('writes NO units# broadcast_sent audit row for a unit-less broadcast', async () => {
    const alice = seedTenant(world, { contactId: 'c-alice', firstName: 'Alice', phone: '+15550100001' });
    seedBroadcast(world, [alice], { unitId: undefined, body_template: 'Hello there' });
    wireHandler(world, logger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    expect(world.auditEvents.filter((e) => e.event_type === 'broadcast_sent')).toHaveLength(0);
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
    await outbound.settle();

    // Only the reachable tenant was texted; the opted-out one never.
    expect(world.sent.map((s) => s.to)).toEqual([ok.phone]);
    expect(acquire).toHaveBeenCalledTimes(1); // NO token spent on the skip

    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.stats.sent).toBe(1);
    expect(bcast.stats.skipped_opted_out).toBe(1);
    expect(bcast.recipients['c-stop']?.status).toBe('skipped');
    expect(bcast.recipients['c-stop']?.errorCode).toBe('opted_out'); // share-skip-fix D7: a recorded reason
    expect(bcast.status).toBe('sent'); // sent ones succeeded
  });

  it('share-skip-fix D7: an UNREACHABLE recipient is skipped with its own reason and counted skipped_other, NO token, NO send', async () => {
    const ok = seedTenant(world, { contactId: 'c-ok', firstName: 'Ok', phone: '+15550100001' });
    const dead = seedTenant(world, { contactId: 'c-dead', sms_unreachable: true, phone: '+15550100002' });
    seedUnit(world);
    seedBroadcast(world, [ok, dead]);
    const acquire = vi.fn(async () => {});
    wireHandler(world, logger, { acquire } as unknown as TokenBucket);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    expect(world.sent.map((s) => s.to)).toEqual([ok.phone]);
    expect(acquire).toHaveBeenCalledTimes(1);
    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.recipients['c-dead']).toEqual({ status: 'skipped', errorCode: 'unreachable' });
    expect(bcast.stats.skipped_other).toBe(1);
    expect(bcast.stats.skipped_opted_out).toBe(0);
  });

  it('share-skip-fix D7: a manual-mode refusal is skipped with reason manual_mode and counted skipped_other, not opted_out', async () => {
    const ok = seedTenant(world, { contactId: 'c-ok', firstName: 'Ok', phone: '+15550100001' });
    const off = seedTenant(world, { contactId: 'c-off', phone: '+15550100002' });
    seedUnit(world);
    // An AUTOMATED share (no created_via) - Task 7 covers the staff path. Its
    // PERSISTED skip counters start STALE (drift the recipient outcomes do not
    // imply, as on a legacy cumulative row), so the persisted and derived
    // buckets disagree at finalize and the log line below can tell them apart.
    seedBroadcast(world, [ok, off], {
      stats: {
        audience: 2,
        sent: 0,
        delivered: 0,
        failed: 0,
        skipped_opted_out: 5,
        skipped_no_consent: 4,
        skipped_other: 2,
        queued: 2,
      },
    });
    const offConv = await world.conversationsRepo.createOrGetByParticipantPhone(off.phone!, 'tenant_1to1');
    await world.conversationsRepo.setMode(offConv.conversationId, 'manual');
    const { capture, logger: log } = capturingLogger(); // the file's own helper (line ~159)
    wireHandler(world, log);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    expect(world.sent.map((s) => s.to)).toEqual([ok.phone]);
    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.recipients['c-off']).toEqual({ status: 'skipped', errorCode: 'manual_mode' });
    // The refusal bumped skipped_other (stale 2 -> 3), never the opt-out or
    // consent counters (stale 5 and 4, unchanged).
    expect(bcast.stats.skipped_other).toBe(3);
    expect(bcast.stats.skipped_opted_out).toBe(5);
    expect(bcast.stats.skipped_no_consent).toBe(4);
    // The finalize log line reports every bucket from the DERIVED stats (info =
    // 30), never the stale persisted counters: one dispatched leg (`sending`,
    // no carrier callback in this rig), one skipped_other, nothing else.
    const done = capture.atLevel(30).find((l) => String(l['msg']).includes('broadcast send finalized'));
    expect(done).toBeDefined();
    expect(done).toMatchObject({
      status: 'sent',
      sent: 0,
      sending: 1,
      delivered: 0,
      failed: 0,
      skipped_opted_out: 0,
      skipped_no_consent: 0,
      skipped_other: 1,
    });
  });

  it('share-skip-fix D4: a DASHBOARD share reaches a switched-off (manual) conversation - sent and audited as a person (automated: false)', async () => {
    const off = seedTenant(world, { contactId: 'c-off', firstName: 'Off', phone: '+15550100001' });
    seedUnit(world);
    seedBroadcast(world, [off], { created_via: 'dashboard' });
    const offConv = await world.conversationsRepo.createOrGetByParticipantPhone(off.phone!, 'tenant_1to1');
    await world.conversationsRepo.setMode(offConv.conversationId, 'manual');
    wireHandler(world, logger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    expect(world.sent.map((s) => s.to)).toEqual([off.phone]);
    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.recipients['c-off']?.status).toBe('sent');
    // The wrapper audited it as a person's send (the harness records the real
    // DynamoDB item shape: event_type, payload - twilioWebhookHarness.ts:226-236).
    const sentEvents = world.auditEvents.filter(
      (e) => e.entityKey === `conversations#${offConv.conversationId}` && e.event_type === 'message_sent',
    );
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]!.payload).toMatchObject({ automated: false });
  });

  it('share-skip-fix I1: a DASHBOARD share still refuses an opted-out, a no-consent and a soft-deleted recipient (fence order: opt-out, unreachable, deleted, consent)', async () => {
    const stopped = seedTenant(world, { contactId: 'c-stop', sms_opt_out: true, phone: '+15550100001' });
    const noConsent = seedTenant(world, { contactId: 'c-nc', phone: '+15550100002', consent_method: undefined });
    const deleted = seedTenant(world, { contactId: 'c-del', phone: '+15550100003', deleted_at: '2026-09-01T00:00:00.000Z' });
    const both = seedTenant(world, { contactId: 'c-both', phone: '+15550100004', sms_opt_out: true, deleted_at: '2026-09-01T00:00:00.000Z' });
    // Past opt-out: unreachable is judged BEFORE deleted, deleted BEFORE consent.
    const unreachableDeleted = seedTenant(world, {
      contactId: 'c-ud',
      phone: '+15550100005',
      sms_unreachable: true,
      deleted_at: '2026-09-01T00:00:00.000Z',
    });
    const deletedNoConsent = seedTenant(world, {
      contactId: 'c-dnc',
      phone: '+15550100006',
      consent_method: undefined,
      deleted_at: '2026-09-01T00:00:00.000Z',
    });
    seedUnit(world);
    seedBroadcast(world, [stopped, noConsent, deleted, both, unreachableDeleted, deletedNoConsent], { created_via: 'dashboard' });
    wireHandler(world, logger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    expect(world.sent).toHaveLength(0);
    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.recipients['c-stop']).toEqual({ status: 'skipped', errorCode: 'opted_out' });
    expect(bcast.recipients['c-nc']).toEqual({ status: 'skipped', errorCode: 'no_consent' });
    expect(bcast.recipients['c-del']).toEqual({ status: 'skipped', errorCode: 'contact_deleted' });
    expect(bcast.recipients['c-both']).toEqual({ status: 'skipped', errorCode: 'opted_out' }); // opt-out wins
    expect(bcast.recipients['c-ud']).toEqual({ status: 'skipped', errorCode: 'unreachable' }); // unreachable wins over deleted
    expect(bcast.recipients['c-dnc']).toEqual({ status: 'skipped', errorCode: 'contact_deleted' }); // deleted wins over consent
    // c-del, c-ud and c-dnc all land in skipped_other; c-dnc never reaches no_consent.
    expect(bcast.stats).toMatchObject({ skipped_opted_out: 2, skipped_no_consent: 1, skipped_other: 3 });
  });

  it('share-skip-fix I8: consent is judged on the FENCED recipient, not on a duplicate no-consent contact that shares the phone', async () => {
    // The fake findByPhone returns the FIRST contact on the phone in insertion
    // order: push the duplicate (no consent) first, the real recipient second.
    seedTenant(world, { contactId: 'c-dup', phone: '+15550100001', consent_method: undefined });
    const real = seedTenant(world, { contactId: 'c-real', firstName: 'Real', phone: '+15550100001' });
    seedUnit(world);
    seedBroadcast(world, [real], { created_via: 'dashboard' });
    wireHandler(world, logger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    expect(world.sent.map((s) => s.to)).toEqual([real.phone]);
    expect(world.broadcasts.get('bcast-1')!.recipients['c-real']?.status).toBe('sent');
  });

  it('share-skip-fix I8: a phone#-keyed recipient of a DASHBOARD share still sends - as a person, into a switched-off (manual) conversation', async () => {
    const byPhone = seedTenant(world, { contactId: 'c-by-phone', firstName: 'Ph', phone: '+15550100009' });
    seedUnit(world);
    const item = seedBroadcast(world, [], { created_via: 'dashboard' });
    item.recipients[`phone#${byPhone.phone}`] = { status: 'queued' };
    item.stats.audience = 1;
    item.stats.queued = 1;
    // Switched OFF: an automated send would be refused manual_mode here, so
    // only a person's send (D4) can reach this conversation.
    const conv = await world.conversationsRepo.createOrGetByParticipantPhone(byPhone.phone!, 'tenant_1to1');
    await world.conversationsRepo.setMode(conv.conversationId, 'manual');
    wireHandler(world, logger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    expect(world.sent.map((s) => s.to)).toEqual([byPhone.phone]);
    expect(world.broadcasts.get('bcast-1')!.recipients[`phone#${byPhone.phone}`]?.status).toBe('sent');
    const sentEvents = world.auditEvents.filter(
      (e) => e.entityKey === `conversations#${conv.conversationId}` && e.event_type === 'message_sent',
    );
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]!.payload).toMatchObject({ automated: false });
  });

  it('share-skip-fix I1: the SMS kill switch still refuses a DASHBOARD share - skipped sms_sending_disabled, skipped_other, nothing sent', async () => {
    const t = seedTenant(world, { contactId: 'c-ks', firstName: 'Ks', phone: '+15550100001' });
    seedUnit(world);
    seedBroadcast(world, [t], { created_via: 'dashboard' });
    wireHandler(world, logger, undefined, { SMS_SENDING_ENABLED: 'false' });

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    expect(world.sent).toHaveLength(0);
    expect(world.messages.filter((m) => m.direction === 'outbound')).toHaveLength(0);
    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.recipients['c-ks']).toEqual({ status: 'skipped', errorCode: 'sms_sending_disabled' });
    expect(bcast.stats.skipped_other).toBe(1);
    expect(bcast.stats.skipped_opted_out).toBe(0);
    expect(bcast.stats.sent).toBe(0);
    // Not "all failed", so the share finalizes `sent` (the D6 label then reads "Not sent").
    expect(bcast.status).toBe('sent');
  });

  it('share-skip-fix I2: a share with NO created_via is automated and a manual conversation still refuses it', async () => {
    const off = seedTenant(world, { contactId: 'c-off', phone: '+15550100001' });
    seedUnit(world);
    seedBroadcast(world, [off]);
    const offConv = await world.conversationsRepo.createOrGetByParticipantPhone(off.phone!, 'tenant_1to1');
    await world.conversationsRepo.setMode(offConv.conversationId, 'manual');
    wireHandler(world, logger);
    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();
    expect(world.sent).toHaveLength(0);
    expect(world.broadcasts.get('bcast-1')!.recipients['c-off']).toEqual({ status: 'skipped', errorCode: 'manual_mode' });
  });

  it('A2P/CTIA (spec §4): skips a NO-CONSENT recipient (skipped_no_consent++), NO token, NO send', async () => {
    const ok = seedTenant(world, { contactId: 'c-ok', firstName: 'Ok', phone: '+15550100001' });
    // Override the default consent so this recipient has NONE.
    const noConsent = seedTenant(world, {
      contactId: 'c-noconsent',
      phone: '+15550100002',
      consent_method: undefined,
    });
    seedUnit(world);
    seedBroadcast(world, [ok, noConsent]);

    const acquire = vi.fn(async () => {});
    const bucket = { acquire } as unknown as TokenBucket;
    wireHandler(world, logger, bucket);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    // Only the consented tenant was texted; the no-consent one never.
    expect(world.sent.map((s) => s.to)).toEqual([ok.phone]);
    expect(acquire).toHaveBeenCalledTimes(1); // NO token spent on the consent skip

    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.stats.sent).toBe(1);
    expect(bcast.stats.skipped_no_consent).toBe(1);
    expect(bcast.stats.skipped_opted_out).toBe(0); // a distinct bucket
    expect(bcast.recipients['c-noconsent']?.status).toBe('skipped');
    expect(bcast.recipients['c-noconsent']?.errorCode).toBe('no_consent');
    expect(bcast.status).toBe('sent');
  });

  // group-texting A8, consumer 4 of 6 (broadcastFanOut.ts). The fence reads the
  // ONE hasSmsConsent predicate, so the distinct group basis leaves it untouched.
  it('skips a SILENT GROUP MEMBER (group_participation_at is not consent)', async () => {
    const ok = seedTenant(world, { contactId: 'c-ok', firstName: 'Ok', phone: '+15550100001' });
    const groupOnly = seedTenant(world, {
      contactId: 'c-groupmember',
      phone: '+15550100002',
      consent_method: undefined,
      group_participation_at: '2026-08-10T12:00:00.000Z',
    });
    seedUnit(world);
    seedBroadcast(world, [ok, groupOnly]);

    wireHandler(world, logger, { acquire: vi.fn(async () => {}) } as unknown as TokenBucket);
    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    expect(world.sent.map((s) => s.to)).toEqual([ok.phone]);
    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.stats.skipped_no_consent).toBe(1);
    expect(bcast.recipients['c-groupmember']?.errorCode).toBe('no_consent');
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
    await outbound.settle();

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
    world.adapter.sendPreparedMessage = async (prepared: PreparedMessageSend) => {
      if (prepared.params.to === b.phone) throw Object.assign(new Error('rate limited'), { code: 429 });
      return {
        providerSid: `SMok-${prepared.params.to}`,
        status: 'sent',
        providerTs: new Date().toISOString(),
      };
    };

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

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
    // M5: pass 1 claimed rung 1 on the DURABLE item. The envelope's `attempt` is
    // advisory from here on - this is the number the cap is read from.
    expect(world.broadcasts.get('bcast-1')!.fanout_attempt).toBe(1);
  });

  // --- M5: the three closes. Each leaves the SAME terminal shape - every
  // recipient terminal, persisted stats.queued 0, the row finalized (never left
  // 'sending'), and exactly one operator ERROR line (D8).
  it('close A: 429 capped at MAX_BROADCAST_ATTEMPTS (ladder driven for real) -> remaining marked failed, finalized', async () => {
    const b = seedTenant(world, { contactId: 'c-b', phone: '+15550100002' });
    seedUnit(world);
    seedBroadcast(world, [b]);
    const { capture, logger: capLogger } = capturingLogger();
    wireHandler(world, capLogger);
    const send = alwaysRateLimits();
    world.adapter.sendPreparedMessage = send;

    // Drive the ladder the way PRODUCTION reaches the cap - three passes, each
    // deferring - instead of injecting attempt=3 in the envelope, which the
    // durable counter has made advisory.
    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    // deliverDelayed drains TRANSITIVELY and empties delayed[], so one call
    // would run passes 2 AND 3 and erase both delays. Shift one continuation at
    // a time and dispatch it, recording the rung's delay first.
    const delaysObserved: number[] = [];
    for (let pass = 2; pass <= 3; pass += 1) {
      const item = outbound.delayed.shift();
      expect(item).toBeDefined();
      delaysObserved.push(item!.delaySeconds);
      await dispatchJob(JSON.parse(JSON.stringify(item!.envelope)));
    }

    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.recipients['c-b']?.status).toBe('failed');
    expect(bcast.recipients['c-b']?.errorCode).toBe('transient_cap');
    expect(bcast.stats.failed).toBe(1);
    expect(bcast.status).toBe('failed'); // all (1) failed
    // The terminal shape, and the ladder's own shape.
    expect(bcast.stats.queued).toBe(0);
    expect(bcast.status).not.toBe('sending');
    expect(outbound.delayed).toHaveLength(0); // no FOURTH continuation
    expect(closeLines(capture)).toHaveLength(1);
    // D10: the operator line reports the DURABLE counter the close decided on -
    // here the cap itself, reached by driving the real ladder.
    expect(closeLines(capture)[0]!['fanoutAttempt']).toBe(3);
    // D7: pass count and delays are exactly main's - 3 sends, 10s then 20s.
    expect(send).toHaveBeenCalledTimes(3);
    expect(delaysObserved).toEqual([10, 20]);
    // The cap was reached on the DURABLE counter, not on the envelope.
    expect(bcast.fanout_attempt).toBe(3);
  });

  it('close B: a pass that begins with the ladder already spent closes it, sending nothing', async () => {
    const b = seedTenant(world, { contactId: 'c-b', phone: '+15550100002' });
    seedUnit(world);
    seedBroadcast(world, [b]);
    const { capture, logger: capLogger } = capturingLogger();
    wireHandler(world, capLogger);
    const send = neverSends();
    world.adapter.sendPreparedMessage = send;

    // Seed the STORED item at the cap (world.broadcasts holds the live object;
    // getById returns a shallow copy). A FIRST-pass envelope - no attempt, no
    // recipientKeys - so only the durable counter can refuse the claim.
    world.broadcasts.get('bcast-1')!.fanout_attempt = 3;

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    const bcast = world.broadcasts.get('bcast-1')!;
    expect(send).not.toHaveBeenCalled();
    expect(bcast.recipients['c-b']?.status).toBe('failed');
    expect(bcast.recipients['c-b']?.errorCode).toBe('transient_cap');
    expect(bcast.stats.queued).toBe(0);
    expect(bcast.status).toBe('failed');
    expect(bcast.status).not.toBe('sending');
    expect(closeLines(capture)).toHaveLength(1);
    // D10: this is the line an operator reads to answer "why did it give up".
    // It must carry the STORED count that refused the claim (3), not the
    // first-pass envelope's advisory 1 - the two are kept distinguishable.
    expect(closeLines(capture)[0]!['fanoutAttempt']).toBe(3);
    expect(closeLines(capture)[0]!['envelopeAttempt']).toBe(1);
    // A capped claim consumes nothing: the counter is UNCHANGED.
    expect(bcast.fanout_attempt).toBe(3);
    expect(outbound.delayed).toHaveLength(0);
  });

  it('close C: a continuation the queue REFUSES closes the broadcast instead of leaving it sending', async () => {
    const b = seedTenant(world, { contactId: 'c-b', phone: '+15550100002' });
    seedUnit(world);
    seedBroadcast(world, [b]);
    const { capture, logger: capLogger } = capturingLogger();
    wireHandler(world, capLogger);
    const send = alwaysRateLimits();
    world.adapter.sendPreparedMessage = send;

    // DELAY-SELECTIVE: this file starts every job through the SAME adapter with
    // delaySeconds 0, so an unconditional thrower would kill the test's own
    // entry enqueue and the handler would never run.
    configureOutboundQueue({
      async enqueue(envelope, opts) {
        if ((opts?.delaySeconds ?? 0) > 0) throw new Error('queue down');
        return outbound.enqueue(envelope, opts);
      },
    });

    // PASS 1 deliberately: runDeferred catches a handler throw (so settle()
    // resolves and the assertions are reachable); deliverDelayed does not.
    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.recipients['c-b']?.status).toBe('failed');
    expect(bcast.recipients['c-b']?.errorCode).toBe('enqueue_failed');
    expect(bcast.stats.queued).toBe(0);
    expect(bcast.status).toBe('failed');
    expect(bcast.status).not.toBe('sending'); // the anchor bug: stuck forever
    expect(closeLines(capture)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('the claim reports `missing` (item deleted between the handler read and the claim) -> warn, NOTHING sent, NOTHING written, NO close', async () => {
    const b = seedTenant(world, { contactId: 'c-b', phone: '+15550100002' });
    seedUnit(world);
    seedBroadcast(world, [b]);
    const { capture, logger: capLogger } = capturingLogger();
    wireHandler(world, capLogger);
    const send = neverSends();
    world.adapter.sendPreparedMessage = send;

    // The RACE, and an override is the only way to model it: the handler reads
    // the broadcast at the top and claims further down, so `missing` means a
    // delete landed in that window. The fake's own claim reads the live map,
    // which still holds the seeded row, so it could never answer `missing` here.
    world.broadcastsRepo.claimFanoutPass = async () => ({ outcome: 'missing' });

    // A local queue carrying the CAPTURING logger: runDeferred swallows a
    // handler throw and logs it at ERROR, so with this wiring the empty
    // error-level assertion below is a real "returned cleanly" check.
    const queue = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob, logger: capLogger });
    configureOutboundQueue(queue);
    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await queue.settle();

    const bcast = world.broadcasts.get('bcast-1')!;
    expect(send).not.toHaveBeenCalled();
    // NOTHING written: the slot is untouched, the counters are untouched, and
    // the row is NOT finalized. `missing` has nothing to close (D8's close would
    // write recipient rows onto an item that no longer exists), so the handler
    // logs and returns - no close line, and no ERROR of any kind.
    expect(bcast.recipients['c-b']?.status).toBe('queued');
    expect(bcast.recipients['c-b']?.errorCode).toBeUndefined();
    expect(bcast.stats.queued).toBe(1);
    expect(bcast.stats.failed).toBe(0);
    expect(bcast.stats.sent).toBe(0);
    expect(bcast.status).toBe('sending');
    expect(closeLines(capture)).toHaveLength(0);
    expect(capture.atLevel(50)).toHaveLength(0);
    expect(queue.delayed).toHaveLength(0);
    // The ONE operator line the arm does write, at WARN.
    expect(
      capture
        .atLevel(40)
        .filter((l) => String(l['msg']).includes('vanished before the pass claim')),
    ).toHaveLength(1);
  });

  it('30007 carrier filtering → recipient failed, NEVER retried', async () => {
    const b = seedTenant(world, { contactId: 'c-b', phone: '+15550100002' });
    seedUnit(world);
    seedBroadcast(world, [b]);
    wireHandler(world, logger);
    world.adapter.sendPreparedMessage = async () => {
      throw Object.assign(new Error('filtered'), { code: 30007 });
    };

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

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
    world.adapter.sendPreparedMessage = async () => {
      throw Object.assign(new Error('invalid'), { code: 30005 });
    };

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

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
    await outbound.settle();
    expect(world.sent).toHaveLength(1);
    expect(world.broadcasts.get('bcast-1')!.fanout_attempt).toBe(1);

    // Re-dispatch the SAME envelope (SQS at-least-once): the jobId marker
    // suppresses it — no further sends.
    await dispatchJob(JSON.parse(JSON.stringify(envelope)));
    expect(world.sent).toHaveLength(1);
    // D6: the duplicate returned above the claim, so it consumed NO rung. A
    // claim placed earlier would burn the ladder on redeliveries alone.
    expect(world.broadcasts.get('bcast-1')!.fanout_attempt).toBe(1);
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
    await outbound.settle();

    // Only Bob is sent — Alice was already terminal.
    expect(world.sent.map((s) => s.to)).toEqual([b.phone]);
  });

  it('a pass whose recipients are ALL already terminal claims no rung and falls through to finalize', async () => {
    const a = seedTenant(world, { contactId: 'c-a', phone: '+15550100001' });
    seedUnit(world);
    const seeded = seedBroadcast(world, [a]);
    // A continuation that raced: every key in this pass is already terminal.
    seeded.recipients['c-a'] = { status: 'sent', conversationId: 'conv-x', tsMsgId: 'ts-x' };
    seeded.stats.sent = 1;
    seeded.stats.queued = 0;
    wireHandler(world, logger);
    const send = neverSends();
    world.adapter.sendPreparedMessage = send;

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    const bcast = world.broadcasts.get('bcast-1')!;
    expect(send).not.toHaveBeenCalled();
    // D6: a pass that attempts no send consumes no rung - the attribute is
    // still ABSENT, so a later real pass still gets the full ladder.
    expect(bcast.fanout_attempt).toBeUndefined();
    // It fell through to the trailing finalize rather than closing.
    expect(bcast.status).toBe('sent');
    expect(outbound.delayed).toHaveLength(0);
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
    await outbound.settle();

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
    world.adapter.sendPreparedMessage = async () => {
      throw Object.assign(new Error('rate limited'), { code: 429 });
    };

    // First run is attempt 1 → the continuation runs AS attempt 2, so it must
    // wait broadcastBackoffMs(2) = 10s (NOT broadcastBackoffMs(1) = 5s). Via
    // the SQS path this is an EXACT DelaySeconds of 10 (no EventBridge floor).
    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1', attempt: 1 });
    await outbound.settle();

    expect(outbound.delayed).toHaveLength(1);
    const item = outbound.delayed[0]!;
    expect((item.envelope.payload as { attempt?: number }).attempt).toBe(2);
    const expected = broadcastBackoffMs(2); // 10_000
    expect(expected).toBe(10_000);
    // The recorded DelaySeconds matches the 2nd-step backoff exactly.
    expect(item.delaySeconds).toBe(10);
  });

  // --- BE2/C2: listing_sent milestone per recipient actually sent ----------
  it('records a listing_sent activity event per recipient sent (refType unit when the broadcast has a unitId)', async () => {
    const alice = seedTenant(world, { contactId: 'c-alice', firstName: 'Alice', phone: '+15550100001' });
    const bob = seedTenant(world, { contactId: 'c-bob', phone: '+15550100002' });
    seedUnit(world); // unit-1
    seedBroadcast(world, [alice, bob]); // seedBroadcast sets unitId: 'unit-1'
    wireHandler(world, logger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    const sent = world.activityEvents.filter((e) => e.type === 'listing_sent');
    expect(sent).toHaveLength(2);
    expect(sent.map((e) => e.contactId).sort()).toEqual(['c-alice', 'c-bob']);
    // Deep-links to the unit (the thing sent), not the broadcast.
    expect(sent.every((e) => e.refType === 'unit' && e.refId === 'unit-1')).toBe(true);
  });

  it('does NOT record listing_sent for a skipped (opted-out) recipient', async () => {
    const optedOut = seedTenant(world, { contactId: 'c-opt', phone: '+15550100009', sms_opt_out: true });
    seedUnit(world);
    seedBroadcast(world, [optedOut]);
    wireHandler(world, logger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    expect(world.activityEvents.filter((e) => e.type === 'listing_sent')).toHaveLength(0);
  });

  // --- BE4/C4: listing-send record per recipient (when unit-targeted) --------
  it('records a listing-send row (via=broadcast) per recipient sent when the broadcast has a unitId', async () => {
    const alice = seedTenant(world, { contactId: 'c-alice', firstName: 'Alice', phone: '+15550100001' });
    const bob = seedTenant(world, { contactId: 'c-bob', phone: '+15550100002' });
    seedUnit(world); // unit-1
    seedBroadcast(world, [alice, bob]); // seedBroadcast sets unitId: 'unit-1'
    wireHandler(world, logger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    expect(world.listingSends).toHaveLength(2);
    expect(world.listingSends.map((r) => r.contactId).sort()).toEqual(['c-alice', 'c-bob']);
    expect(world.listingSends.every((r) => r.unitId === 'unit-1')).toBe(true);
    expect(world.listingSends.every((r) => r.via === 'broadcast')).toBe(true);
    expect(world.listingSends.every((r) => r.broadcastId === 'bcast-1')).toBe(true);
    // The removed `response` label is never written.
    expect(world.listingSends.every((r) => !('response' in r))).toBe(true);
  });

  it('records NO listing-send rows for a unit-less broadcast', async () => {
    const alice = seedTenant(world, { contactId: 'c-alice', phone: '+15550100001' });
    // A unit-less broadcast: no unitId on the broadcast (and no unit seeded).
    seedBroadcast(world, [alice], { unitId: undefined });
    wireHandler(world, logger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    // The SMS still goes out (sanity) but no listing-send row is recorded.
    expect(world.sent).toHaveLength(1);
    expect(world.listingSends).toHaveLength(0);
  });

  it('does NOT record a listing-send row for a skipped (opted-out) recipient', async () => {
    const optedOut = seedTenant(world, { contactId: 'c-opt', phone: '+15550100009', sms_opt_out: true });
    seedUnit(world);
    seedBroadcast(world, [optedOut]);
    wireHandler(world, logger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    expect(world.listingSends).toHaveLength(0);
  });

  it('best-effort capture isolation: a recordSend failure NEVER fails the send (SMS still out, recipient counted sent, error logged)', async () => {
    const alice = seedTenant(world, { contactId: 'c-alice', firstName: 'Alice', phone: '+15550100001' });
    seedUnit(world); // unit-1
    seedBroadcast(world, [alice]); // unitId: 'unit-1' → would normally record a listing-send

    // Capture the fan-out's own logs so we can assert the swallowed error logged.
    const capture = createLogCapture();
    const capturingLogger = createLogger({ level: 'info', destination: capture.stream });

    // The listing-send capture throws — it must be swallowed and never propagate.
    world.listingSendsRepo.recordSend = async () => {
      throw new Error('listing_sends table is on fire');
    };
    wireHandler(world, capturingLogger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    // (a) The SMS still went out to the recipient.
    expect(world.sent.map((s) => s.to)).toEqual([alice.phone]);
    // (b) The broadcast finalized with the recipient counted as sent.
    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.stats.sent).toBe(1);
    expect(bcast.recipients['c-alice']?.status).toBe('sent');
    expect(bcast.status).toBe('sent');
    // (c) The recordSend failure was logged (error level) and swallowed.
    const errs = capture
      .atLevel(50)
      .filter((l) => typeof l['msg'] === 'string' && (l['msg'] as string).includes('listing-send row failed'));
    expect(errs.length).toBeGreaterThanOrEqual(1);
  });

  // --- DLR-rollup race: persist the recipient slot BEFORE the pacing token ---
  it('records the sent recipient slot BEFORE acquiring the A2P pacing token (race fix)', async () => {
    // The delivery callback matches a recipient by its persisted slot
    // (conversationId+tsMsgId). If the ~1s A2P token acquire runs BEFORE the
    // slot write, a fast callback lands in the gap and its outcome is lost. So
    // the success-path recordRecipient(+bumpStats) MUST precede acquire.
    const alice = seedTenant(world, { contactId: 'c-alice', firstName: 'Alice', phone: '+15550100001' });
    seedUnit(world);
    seedBroadcast(world, [alice]);

    // A shared call-order log: both acquire() and the 'sent' slot write append.
    const order: string[] = [];
    const acquire = vi.fn(async () => {
      order.push('acquire');
    });
    const bucket = { acquire } as unknown as TokenBucket;

    // Wrap the ONE conditional slot+stats write (SOR D7a) so the 'sent' write
    // records its position relative to acquire (the fake still applies it).
    const realRecord = world.broadcastsRepo.recordRecipientOutcome.bind(world.broadcastsRepo);
    world.broadcastsRepo.recordRecipientOutcome = async (broadcastId, contactKey, recipient, delta, priors) => {
      if (recipient.status === 'sent') order.push('recordRecipientOutcome:sent');
      return realRecord(broadcastId, contactKey, recipient, delta, priors);
    };

    wireHandler(world, logger, bucket);
    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    const sentIdx = order.indexOf('recordRecipientOutcome:sent');
    const acquireIdx = order.indexOf('acquire');
    expect(sentIdx).toBeGreaterThanOrEqual(0);
    expect(acquireIdx).toBeGreaterThanOrEqual(0);
    // The recipient slot is persisted BEFORE the pacing token is acquired.
    expect(sentIdx).toBeLessThan(acquireIdx);
  });

  // --- S2: per-recipient live SSE ticks from the fan-out loop ---------------
  function broadcastUpdates(): Array<{ status: string; stats: BroadcastStats }> {
    return world.emitted
      .filter((e) => e.event === 'broadcast.updated')
      .map((e) => e.payload as { status: string; stats: BroadcastStats });
  }
  function bucketsSumToAudience(s: BroadcastStats): boolean {
    return (
      s.queued +
        (s.sending ?? 0) +
        s.sent +
        s.delivered +
        s.failed +
        (s.unconfirmed ?? 0) +
        s.skipped_opted_out +
        s.skipped_no_consent +
        (s.skipped_other ?? 0) ===
      s.audience
    );
  }

  it('S2: emits broadcast.updated with DERIVED disjoint stats after each recipient transition (live ticks)', async () => {
    const a = seedTenant(world, { contactId: 'c-a', phone: '+15550100001' });
    const b = seedTenant(world, { contactId: 'c-b', phone: '+15550100002' });
    seedUnit(world);
    seedBroadcast(world, [a, b]);
    wireHandler(world, logger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    const updates = broadcastUpdates();
    // One tick per sent recipient (2) + the terminal finalize emit = 3.
    expect(updates).toHaveLength(3);
    // Every emit carries derived, disjoint stats that sum to the audience (2).
    for (const u of updates) {
      expect(u.stats.audience).toBe(2);
      expect(bucketsSumToAudience(u.stats)).toBe(true);
    }
    // DERIVED stats: a dispatched slot ('sent', no carrierSentAt) counts as
    // `sending` (with the carrier) - distinct from `queued` (on our box) and
    // from carrier-confirmed `sent`. No webhook runs in this rig, so no
    // carrierSentAt ever lands: dispatched legs sit in `sending` even after
    // the job finalizes (status 'sent' = the JOB finished dispatching).
    expect(updates[0]!.status).toBe('sending');
    expect(updates[0]!.stats).toMatchObject({ sent: 0, sending: 1, queued: 1 });
    // The terminal emit: job done ('sent'), both legs awaiting the carrier.
    expect(updates.at(-1)!.status).toBe('sent');
    expect(updates.at(-1)!.stats).toMatchObject({ sent: 0, sending: 2, queued: 0 });
  });

  it('S2: the transient-defer path (slot stays queued, no bumpStats) emits NOTHING for that recipient', async () => {
    const a = seedTenant(world, { contactId: 'c-a', phone: '+15550100001' });
    const b = seedTenant(world, { contactId: 'c-b', phone: '+15550100002' });
    seedUnit(world);
    seedBroadcast(world, [a, b]);
    wireHandler(world, logger);
    // Bob rate-limits (429 transient) -> deferred to a continuation, slot stays
    // queued, NO bumpStats. Alice succeeds.
    world.adapter.sendPreparedMessage = async (prepared: PreparedMessageSend) => {
      if (prepared.params.to === b.phone) throw Object.assign(new Error('rate limited'), { code: 429 });
      return {
        providerSid: `SMok-${prepared.params.to}`,
        status: 'sent',
        providerTs: new Date().toISOString(),
      };
    };

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    const updates = broadcastUpdates();
    // ONLY Alice's send emitted. Bob's transient defer emits nothing, and a
    // continuation is pending so finalize (its terminal emit) does NOT run.
    expect(updates).toHaveLength(1);
    expect(updates[0]!.status).toBe('sending');
    // The two in-flight states split: Alice dispatched -> `sending` (with the
    // carrier), Bob deferred-retry -> `queued` (still on our box).
    expect(updates[0]!.stats).toMatchObject({ sent: 0, sending: 1, queued: 1 });
    expect(bucketsSumToAudience(updates[0]!.stats)).toBe(true);
  });

  it('S2: a skip transition emits a derived tick (skipped bucket, disjoint)', async () => {
    const ok = seedTenant(world, { contactId: 'c-ok', phone: '+15550100001' });
    const stopped = seedTenant(world, { contactId: 'c-stop', sms_opt_out: true, phone: '+15550100002' });
    seedUnit(world);
    seedBroadcast(world, [ok, stopped]);
    wireHandler(world, logger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    const updates = broadcastUpdates();
    // A tick for the skip + a tick for the send + the finalize emit.
    expect(updates.length).toBeGreaterThanOrEqual(2);
    for (const u of updates) expect(bucketsSumToAudience(u.stats)).toBe(true);
    // Terminal: one dispatched (`sending` until the carrier confirms - no
    // webhook runs in this rig), one skipped (opted-out), disjoint.
    expect(updates.at(-1)!.stats).toMatchObject({
      sent: 0,
      sending: 1,
      queued: 0,
      skipped_opted_out: 1,
    });
  });

  // -------------------------------------------------------------------------
  // SOR (send-outcome-reconcile) Task 7: every recipient reaches a terminal
  // state without anyone throwing out of the loop, and nobody is texted
  // twice. At Task 7 NO send.reconcile handler exists: a test drains only the
  // broadcast.send envelopes it needs and asserts a reconcile envelope by
  // inspection (a delayed one) or through a recording stub (a delay-0 one).
  // -------------------------------------------------------------------------
  describe('unknown send errors (spec D7, D7a, D8a, D9, D13a) - the first test must fail on main', () => {
    const MAIN = '+15550009999';
    // The override REPLACES the adapter and records nothing: its own call
    // count is the only honest send count.
    const sends: string[] = [];
    beforeEach(() => {
      sends.length = 0;
    });
    function unknownOn(phones: Set<string>) {
      world.adapter.sendPreparedMessage = async (prepared: PreparedMessageSend) => {
        sends.push(prepared.params.to);
        if (phones.has(prepared.params.to)) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        return { providerSid: `SM-${prepared.params.to}`, status: 'sent', providerTs: new Date().toISOString() };
      };
    }
    function tenants(n: number): ContactItem[] {
      return Array.from({ length: n }, (_, i) =>
        seedTenant(world, { contactId: `t-${i + 1}`, phone: `+1555010000${i + 1}` }),
      );
    }
    const ownerOf = (k: string) => ({ kind: 'broadcast' as const, broadcastId: 'bcast-1', contactKey: k });

    it('1 an unknown error on recipient 3 of 5 leaves 4 and 5 attempted, 3 handed to reconcile, no throw', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(5));
      const { logger: log } = capturingLogger();
      wireHandler(world, log, undefined, { BUSINESS_PHONE_NUMBER: MAIN });
      unknownOn(new Set(['+15550100003']));

      await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
      await outbound.settle();

      const b = world.broadcasts.get('bcast-1')!;
      expect([b.recipients['t-4']!.status, b.recipients['t-5']!.status]).toEqual(['sent', 'sent']);
      expect(b.recipients['t-3']).toEqual({ status: 'queued' });
      expect(await world.sendAttemptsRepo.get(ownerOf('t-3'))).toMatchObject({
        state: 'reconciling',
        attemptNo: 1,
        checkNo: 0,
        sender: MAIN,
      });
      const reconcile = outbound.delayed.find((d) => d.envelope.jobName === SEND_RECONCILE_JOB);
      expect(reconcile?.envelope.payload).toMatchObject({
        owner: { kind: 'broadcast', broadcastId: 'bcast-1', recipientKeyHash: hashRecipientKey('t-3') },
        checkNo: 0,
      });
      // Check 0 runs about 5 s after the ATTEMPT (the list lag, D13a).
      expect(reconcile!.delaySeconds).toBeGreaterThanOrEqual(4);
      expect(reconcile!.delaySeconds).toBeLessThanOrEqual(5);
      expect(sends).toHaveLength(5);
      // Not finalized: the reconciling recipient is still a queued slot.
      expect(b.status).toBe('sending');
    });

    /** Facts for a record a test seeds directly (the values are never matched here). */
    const seedFacts = { recipientDigest: 'd'.repeat(32), sender: MAIN, bodyHash: 'h'.repeat(64), bodyShort: false, mediaCount: 0 };
    const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();
    /** G4: a delay-0 reconcile hand-off never reaches outbound.delayed - record it with a stub handler. */
    function recordReconciles(): SendReconcilePayload[] {
      const got: SendReconcilePayload[] = [];
      defineJobHandler(SEND_RECONCILE_JOB, async (p) => {
        got.push(p as SendReconcilePayload);
      });
      return got;
    }
    const delayedOf = (jobName: string) => outbound.delayed.filter((d) => d.envelope.jobName === jobName);
    const continuationKeys = () =>
      (delayedOf(BROADCAST_SEND_JOB)[0]?.envelope.payload as { recipientKeys?: string[] } | undefined)?.recipientKeys;
    function wire(): LogCapture {
      const { capture, logger: log } = capturingLogger();
      wireHandler(world, log, undefined, { BUSINESS_PHONE_NUMBER: MAIN });
      return capture;
    }
    async function runFirstPass(): Promise<void> {
      await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
      await outbound.settle();
    }
    async function runPayload(payload: Record<string, unknown>): Promise<void> {
      await enqueueImmediate(BROADCAST_SEND_JOB, payload);
      await outbound.settle();
    }
    const errorLabels = (capture: LogCapture) => capture.atLevel(50).map((l) => l['label']).filter((l) => l !== undefined);

    it('2 a claimed recipient whose sendMessage refuses closes done/refused, slot skipped, no reconcile - Review Focus 3', async () => {
      seedUnit(world);
      const [t] = tenants(1);
      seedBroadcast(world, [t!]);
      const conv = await world.conversationsRepo.createOrGetByParticipantPhone(t!.phone!, 'tenant_1to1');
      await world.conversationsRepo.setMode(conv.conversationId, 'manual');
      wire();
      await runFirstPass();
      expect(world.broadcasts.get('bcast-1')!.recipients['t-1']).toEqual({ status: 'skipped', errorCode: 'manual_mode' });
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'done', outcome: 'refused', cause: 'manual_mode' });
      expect(outbound.delayed.some((d) => d.envelope.jobName === SEND_RECONCILE_JOB)).toBe(false);
      expect(world.broadcasts.get('bcast-1')!.status).toBe('sent');
    });

    it('3 a prepare-phase throw defers the recipient as send_retryable with no record', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(2));
      const capture = wire();
      vi.spyOn(world.conversationsRepo, 'createOrGetByParticipantPhone').mockRejectedValueOnce(new Error('dynamo blip'));
      await runFirstPass();
      const b = world.broadcasts.get('bcast-1')!;
      expect(b.recipients['t-1']).toEqual({ status: 'queued', errorCode: 'send_retryable' });
      expect(b.recipients['t-2']!.status).toBe('sent');
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toBeUndefined();
      expect(continuationKeys()).toEqual(['t-1']);
      expect(world.sent.map((s) => s.to)).toEqual(['+15550100002']);
      const warn = capture.atLevel(40).filter((l) => String(l['msg']).includes('prepare failed'));
      expect(warn).toHaveLength(1);
      expect(warn[0]).toMatchObject({ recipientKey: 't-1', err: { message: 'dynamo blip' } });
      expect(capture.atLevel(50)).toHaveLength(0);
    });

    it('3b a deferral write that itself throws is logged and the next recipient is still attempted (D7a)', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(2));
      const capture = wire();
      vi.spyOn(world.conversationsRepo, 'createOrGetByParticipantPhone').mockRejectedValueOnce(new Error('dynamo blip'));
      vi.spyOn(world.broadcastsRepo, 'recordRecipientOutcome').mockRejectedValueOnce(new Error('dynamo down'));
      await runFirstPass();
      const b = world.broadcasts.get('bcast-1')!;
      expect(errorLabels(capture)).toEqual(['deferSlot']);
      expect(b.recipients['t-1']).toEqual({ status: 'queued' });
      expect(b.recipients['t-2']!.status).toBe('sent');
      expect(continuationKeys()).toEqual(['t-1']);
    });

    it('3c the deferral never reverts a skipped slot', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      wire();
      // A PREPARE step makes the stored slot terminal AND throws: the unit
      // falls into the pre-claim catch, whose deferral carries ['queued'].
      world.conversationsRepo.createOrGetByParticipantPhone = async () => {
        world.broadcasts.get('bcast-1')!.recipients['t-1'] = { status: 'skipped', errorCode: 'opted_out' };
        throw new Error('boom');
      };
      await runFirstPass();
      expect(world.broadcasts.get('bcast-1')!.recipients['t-1']).toEqual({ status: 'skipped', errorCode: 'opted_out' });
      expect(continuationKeys()).toEqual(['t-1']);
    });

    it('4a three consecutive unknowns brake the pass; the untried remainder is deferred, not attempted (D9)', async () => {
      seedUnit(world);
      const item = seedBroadcast(world, tenants(7));
      // A terminal key AFTER the brake is skipped, never carried (build finding T7-12).
      item.recipients['t-7'] = { status: 'sent', conversationId: 'conv-x', tsMsgId: 'ts-x' };
      const capture = wire();
      unknownOn(new Set(['+15550100001', '+15550100002', '+15550100003']));
      await runFirstPass();
      const b = world.broadcasts.get('bcast-1')!;
      expect(['t-4', 't-5', 't-6'].map((k) => b.recipients[k])).toEqual([
        { status: 'queued' },
        { status: 'queued' },
        { status: 'queued' },
      ]);
      expect(sends).toHaveLength(3);
      expect(delayedOf(BROADCAST_SEND_JOB)[0]?.envelope.payload).toMatchObject({ recipientKeys: ['t-4', 't-5', 't-6'], attempt: 2 });
      expect(delayedOf(SEND_RECONCILE_JOB)).toHaveLength(3);
      const brake = capture.atLevel(40).filter((l) => l['event'] === 'outage_brake');
      expect(brake).toHaveLength(1);
      expect(brake[0]).toMatchObject({ broadcastId: 'bcast-1', untried: 3 });
    });

    it('4b a sent between two unknowns resets the streak', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(6));
      const capture = wire();
      unknownOn(new Set(['+15550100001', '+15550100003', '+15550100005']));
      await runFirstPass();
      expect(sends).toHaveLength(6);
      expect(world.broadcasts.get('bcast-1')!.recipients['t-6']!.status).toBe('sent');
      expect(capture.atLevel(40).some((l) => l['event'] === 'outage_brake')).toBe(false);
    });

    it('4c a fence skip between two unknowns resets the streak (D9: a skip resets)', async () => {
      seedUnit(world);
      const ts = tenants(6);
      ts[1]!.sms_opt_out = true;
      ts[3]!.sms_opt_out = true;
      seedBroadcast(world, ts);
      const capture = wire();
      unknownOn(new Set(['+15550100001', '+15550100003', '+15550100005']));
      await runFirstPass();
      expect(sends).toEqual(['+15550100001', '+15550100003', '+15550100005', '+15550100006']);
      expect(world.broadcasts.get('bcast-1')!.recipients['t-6']!.status).toBe('sent');
      expect(capture.atLevel(40).some((l) => l['event'] === 'outage_brake')).toBe(false);
    });

    it('4d three rejected do not brake', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(5));
      const capture = wire();
      world.adapter.sendPreparedMessage = async (prepared: PreparedMessageSend) => {
        sends.push(prepared.params.to);
        if (sends.length <= 3) throw Object.assign(new Error('filtered'), { code: 30007 });
        return { providerSid: `SM-${prepared.params.to}`, status: 'sent', providerTs: new Date().toISOString() };
      };
      await runFirstPass();
      expect(sends).toHaveLength(5);
      expect(capture.atLevel(40).some((l) => l['event'] === 'outage_brake')).toBe(false);
    });

    it('4d three retryable do not brake', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(5));
      const capture = wire();
      world.adapter.sendPreparedMessage = async (prepared: PreparedMessageSend) => {
        sends.push(prepared.params.to);
        if (sends.length <= 3) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        return { providerSid: `SM-${prepared.params.to}`, status: 'sent', providerTs: new Date().toISOString() };
      };
      await runFirstPass();
      expect(sends).toHaveLength(5);
      expect(continuationKeys()).toEqual(['t-1', 't-2', 't-3']);
      expect(capture.atLevel(40).some((l) => l['event'] === 'outage_brake')).toBe(false);
    });

    it('4e a stranded unknown counts toward the brake', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(5));
      const capture = wire();
      unknownOn(new Set(['+15550100001', '+15550100002', '+15550100003']));
      vi.spyOn(world.sendAttemptsRepo, 'handToReconcile').mockRejectedValue(new Error('dynamo down'));
      await runFirstPass();
      expect(sends).toHaveLength(3);
      // The stranded three are carried (record attempting, slot untouched), then the untried two.
      expect(continuationKeys()).toEqual(['t-1', 't-2', 't-3', 't-4', 't-5']);
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'attempting' });
      expect(world.broadcasts.get('bcast-1')!.recipients['t-1']).toEqual({ status: 'queued' });
      expect(errorLabels(capture)).toEqual(['handToReconcile', 'handToReconcile', 'handToReconcile']);
      expect(capture.atLevel(40).some((l) => l['event'] === 'outage_brake')).toBe(true);
    });

    it('5a a record-phase failure after a successful send hands the SID to reconcile and never re-sends (D7a)', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      const capture = wire();
      const real = world.broadcastsRepo.recordRecipientOutcome;
      world.broadcastsRepo.recordRecipientOutcome = async () => {
        throw new Error('dynamo hiccup');
      };
      await runFirstPass();
      world.broadcastsRepo.recordRecipientOutcome = real;
      expect(world.sent).toHaveLength(1);
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'reconciling', sid: world.sentDetails[0]!.sid });
      const line = capture.atLevel(50).find((l) => String(l['msg']).includes('sent_unrecorded'));
      expect(line).toMatchObject({ providerSid: world.sentDetails[0]!.sid, recipientKey: 't-1' });
      expect(delayedOf(SEND_RECONCILE_JOB)).toHaveLength(1);
      expect(delayedOf(BROADCAST_SEND_JOB)).toHaveLength(0);
    });

    it('5b a SendAcceptedNotRecordedError from sendMessage does the same', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      const capture = wire();
      vi.spyOn(world.messagesRepo, 'append').mockRejectedValueOnce(new Error('TransactionInProgressException'));
      await runFirstPass();
      expect(world.sent).toHaveLength(1);
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'reconciling', sid: world.sentDetails[0]!.sid });
      expect(capture.atLevel(50).some((l) => String(l['msg']).includes('sent_unrecorded'))).toBe(true);
      expect(world.broadcasts.get('bcast-1')!.recipients['t-1']).toEqual({ status: 'queued' });
      expect(delayedOf(SEND_RECONCILE_JOB)).toHaveLength(1);
    });

    it('5c an unknown whose handToReconcile write throws strands the recipient: NO second provider call, record still attempting, deferred (R2 #1)', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      const capture = wire();
      unknownOn(new Set(['+15550100001']));
      vi.spyOn(world.sendAttemptsRepo, 'handToReconcile').mockRejectedValueOnce(new Error('dynamo down'));
      await runFirstPass();
      expect(sends).toHaveLength(1);
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'attempting', attemptNo: 1 });
      expect(errorLabels(capture)).toEqual(['handToReconcile']);
      expect(world.broadcasts.get('bcast-1')!.recipients['t-1']).toEqual({ status: 'queued' });
      expect(continuationKeys()).toEqual(['t-1']);
      // (b) The continuation meets the record still FRESH: the claim is refused and the key carried again.
      const idx = outbound.delayed.findIndex((d) => d.envelope.jobName === BROADCAST_SEND_JOB);
      const [cont] = outbound.delayed.splice(idx, 1);
      await dispatchJob(JSON.parse(JSON.stringify(cont!.envelope)));
      await outbound.settle();
      expect(sends).toHaveLength(1);
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'attempting', attemptNo: 1 });
      expect(delayedOf(BROADCAST_SEND_JOB)[0]?.envelope.payload).toMatchObject({ recipientKeys: ['t-1'], attempt: 3 });
    });

    it('5d a handToReconcile whose FENCE is lost (resolved false) hands off nothing and carries nothing (G5)', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      const capture = wire();
      unknownOn(new Set(['+15550100001']));
      vi.spyOn(world.sendAttemptsRepo, 'handToReconcile').mockResolvedValueOnce(false);
      await runFirstPass();
      expect(sends).toHaveLength(1);
      expect(outbound.delayed).toHaveLength(0);
      expect(capture.atLevel(30).some((l) => String(l['msg']).includes('hand-off fence lost'))).toBe(true);
      expect(capture.atLevel(50)).toHaveLength(0);
    });

    it('6 a reconcile enqueue that throws closes the recipient unresolved on the spot', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      const capture = wire();
      unknownOn(new Set(['+15550100001']));
      configureOutboundQueue({
        async enqueue(envelope, opts) {
          if ((opts?.delaySeconds ?? 0) > 0) throw new Error('queue down');
          return outbound.enqueue(envelope, opts);
        },
      });
      await runFirstPass();
      const b = world.broadcasts.get('bcast-1')!;
      expect(b.recipients['t-1']).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
      expect(b.stats.unconfirmed).toBe(1);
      expect(b.stats.queued).toBe(0);
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'enqueue_failed' });
      expect(b.status).toBe('failed');
      expect(b.last_error).toBe("Couldn't confirm any text went out");
      expect(capture.atLevel(50).some((l) => String(l['msg']).includes('reconcile enqueue failed'))).toBe(true);
    });

    it('7a two passes for the same recipient produce ONE provider call (D8a)', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      wire();
      unknownOn(new Set());
      await world.sendAttemptsRepo.claim(ownerOf('t-1'), seedFacts, new Date().toISOString());
      await runPayload({ broadcastId: 'bcast-1', recipientKeys: ['t-1'], attempt: 2 });
      expect(sends).toHaveLength(0);
      expect(world.broadcasts.get('bcast-1')!.recipients['t-1']).toEqual({ status: 'queued' });
      expect(delayedOf(BROADCAST_SEND_JOB)[0]?.envelope.payload).toMatchObject({ recipientKeys: ['t-1'] });
    });

    it('7b a stale attempting record is taken over into reconcile by the next pass, and a takeover does not count toward the brake', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(4));
      const capture = wire();
      unknownOn(new Set());
      const reconciles = recordReconciles();
      const stale = agoIso(31_000);
      for (const k of ['t-1', 't-2', 't-3']) await world.sendAttemptsRepo.claim(ownerOf(k), seedFacts, stale);
      await runPayload({ broadcastId: 'bcast-1', recipientKeys: ['t-1', 't-2', 't-3', 't-4'], attempt: 2 });
      for (const k of ['t-1', 't-2', 't-3']) {
        expect(await world.sendAttemptsRepo.get(ownerOf(k))).toMatchObject({ state: 'reconciling', attemptedAt: stale, attemptNo: 1 });
        expect(world.broadcasts.get('bcast-1')!.recipients[k]).toEqual({ status: 'queued' });
      }
      expect(reconciles).toHaveLength(3);
      expect(reconciles[0]).toEqual({
        owner: { kind: 'broadcast', broadcastId: 'bcast-1', recipientKeyHash: 't-1' },
        attemptedAt: stale,
        checkNo: 0,
      });
      // Three takeovers in a row are NOT an outage: t-4 still sends.
      expect(sends).toEqual(['+15550100004']);
      expect(capture.atLevel(40).some((l) => l['event'] === 'outage_brake')).toBe(false);
    });

    it('7c a takeover whose fence is lost hands off nothing (INFO)', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      const capture = wire();
      unknownOn(new Set());
      const reconciles = recordReconciles();
      await world.sendAttemptsRepo.claim(ownerOf('t-1'), seedFacts, agoIso(31_000));
      vi.spyOn(world.sendAttemptsRepo, 'takeOver').mockResolvedValueOnce(false);
      await runPayload({ broadcastId: 'bcast-1', recipientKeys: ['t-1'], attempt: 2 });
      expect(reconciles).toHaveLength(0);
      expect(sends).toHaveLength(0);
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'attempting' });
      expect(capture.atLevel(30).some((l) => String(l['msg']).includes('takeover lost'))).toBe(true);
      expect(outbound.delayed).toHaveLength(0);
    });

    it('7e a FIRST pass does not carry a recipient a foreign fresh attempt owns (T7-11)', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      wire();
      unknownOn(new Set());
      await world.sendAttemptsRepo.claim(ownerOf('t-1'), seedFacts, new Date().toISOString());
      await runFirstPass();
      expect(sends).toHaveLength(0);
      expect(outbound.delayed).toHaveLength(0);
      expect(world.broadcasts.get('bcast-1')!.recipients['t-1']).toEqual({ status: 'queued' });
      expect(world.broadcasts.get('bcast-1')!.status).toBe('sending');
    });

    it('7d a continuation that meets a reconciling record skips it and does not carry it', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      wire();
      unknownOn(new Set());
      const at = new Date().toISOString();
      await world.sendAttemptsRepo.claim(ownerOf('t-1'), seedFacts, at);
      await world.sendAttemptsRepo.handToReconcile(ownerOf('t-1'), { attemptNo: 1, attemptedAt: at });
      await runPayload({ broadcastId: 'bcast-1', recipientKeys: ['t-1'], attempt: 2 });
      expect(sends).toHaveLength(0);
      expect(outbound.delayed).toHaveLength(0);
      expect(world.broadcasts.get('bcast-1')!.recipients['t-1']).toEqual({ status: 'queued' });
      expect(world.broadcasts.get('bcast-1')!.status).toBe('sending');
    });

    it('10 a retryable with a network code writes send_retryable, never the network string', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      wire();
      world.adapter.sendPreparedMessage = async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      };
      await runFirstPass();
      expect(world.broadcasts.get('bcast-1')!.recipients['t-1']).toEqual({ status: 'queued', errorCode: 'send_retryable' });
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'done', outcome: 'retryable', cause: 'send_retryable' });
      expect(continuationKeys()).toEqual(['t-1']);
    });

    it('10b a SendNotAttemptedError after the claim defers send_retryable and releases the record retryable', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(2));
      wire();
      // The wrapper's contact read is inside sendMessage, after the job's claim.
      vi.spyOn(world.contactsRepo, 'findByPhone').mockRejectedValueOnce(new Error('dynamo blip'));
      await runFirstPass();
      expect(world.broadcasts.get('bcast-1')!.recipients['t-1']).toEqual({ status: 'queued', errorCode: 'send_retryable' });
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'done', outcome: 'retryable', cause: 'send_retryable' });
      expect(world.broadcasts.get('bcast-1')!.recipients['t-2']!.status).toBe('sent');
      expect(continuationKeys()).toEqual(['t-1']);
    });

    it('11 a foreign fresh attempt on a fenced recipient defers the fence instead of writing skipped (D8, R2 #12)', async () => {
      seedUnit(world);
      const [t] = tenants(1);
      t!.sms_opt_out = true;
      seedBroadcast(world, [t!]);
      wire();
      unknownOn(new Set());
      await world.sendAttemptsRepo.claim(ownerOf('t-1'), seedFacts, new Date().toISOString());
      await runPayload({ broadcastId: 'bcast-1', recipientKeys: ['t-1'], attempt: 2 });
      expect(world.broadcasts.get('bcast-1')!.recipients['t-1']).toEqual({ status: 'queued' });
      expect(continuationKeys()).toEqual(['t-1']);
      expect(sends).toHaveLength(0);
    });

    it('11b a fenced recipient whose record is terminal is skipped: no slot write, not carried', async () => {
      seedUnit(world);
      const [t] = tenants(1);
      t!.sms_opt_out = true;
      seedBroadcast(world, [t!]);
      wire();
      const at = new Date().toISOString();
      await world.sendAttemptsRepo.claim(ownerOf('t-1'), seedFacts, at);
      await world.sendAttemptsRepo.finishAttempt(ownerOf('t-1'), { attemptNo: 1, attemptedAt: at }, { outcome: 'sent', sid: 'SMx' });
      await runPayload({ broadcastId: 'bcast-1', recipientKeys: ['t-1'], attempt: 2 });
      const b = world.broadcasts.get('bcast-1')!;
      expect(b.recipients['t-1']).toEqual({ status: 'queued' });
      expect(b.stats.skipped_opted_out).toBe(0);
      expect(outbound.delayed).toHaveLength(0);
    });

    it('11c a fenced recipient whose record is stale is taken over and handed off; its slot is untouched', async () => {
      seedUnit(world);
      const [t] = tenants(1);
      t!.sms_opt_out = true;
      seedBroadcast(world, [t!]);
      wire();
      const reconciles = recordReconciles();
      const stale = agoIso(31_000);
      await world.sendAttemptsRepo.claim(ownerOf('t-1'), seedFacts, stale);
      await runFirstPass();
      expect(world.broadcasts.get('bcast-1')!.recipients['t-1']).toEqual({ status: 'queued' });
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'reconciling', attemptedAt: stale });
      expect(reconciles).toHaveLength(1);
    });

    it('11d a fenced recipient whose record is done/retryable is fenced as today (the record is left alone)', async () => {
      seedUnit(world);
      const [t] = tenants(1);
      t!.sms_opt_out = true;
      seedBroadcast(world, [t!]);
      wire();
      const at = new Date().toISOString();
      await world.sendAttemptsRepo.claim(ownerOf('t-1'), seedFacts, at);
      await world.sendAttemptsRepo.finishAttempt(ownerOf('t-1'), { attemptNo: 1, attemptedAt: at }, { outcome: 'retryable', cause: '429' });
      await runPayload({ broadcastId: 'bcast-1', recipientKeys: ['t-1'], attempt: 2 });
      expect(world.broadcasts.get('bcast-1')!.recipients['t-1']).toEqual({ status: 'skipped', errorCode: 'opted_out' });
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'done', outcome: 'retryable' });
    });

    it('12 every log line for a phone-keyed recipient names it redacted', async () => {
      seedUnit(world);
      seedTenant(world, { contactId: 'c-p1', phone: '+15550100081' });
      seedTenant(world, { contactId: 'c-p2', phone: '+15550100082' });
      const item = seedBroadcast(world, []);
      item.recipients['phone#+15550100081'] = { status: 'queued' };
      item.recipients['phone#+15550100082'] = { status: 'queued' };
      item.stats.audience = 2;
      item.stats.queued = 2;
      const capture = wire();
      configureJobsLogger(createLogger({ level: 'info', destination: capture.stream }));
      unknownOn(new Set(['+15550100081', '+15550100082']));
      // The first hand-off write fails: its ERROR line carries the recipient key.
      vi.spyOn(world.sendAttemptsRepo, 'handToReconcile').mockRejectedValueOnce(new Error('dynamo down'));
      await runFirstPass();
      const text = JSON.stringify(capture.lines);
      expect(text).toContain('phone#redacted');
      expect(text).not.toContain('phone#+');
      expect(text).not.toContain('+1555010008');
      // The reconcile payload carries the HASHED key, never the phone.
      const payloads = JSON.stringify(delayedOf(SEND_RECONCILE_JOB).map((d) => d.envelope.payload));
      expect(payloads).toContain(hashRecipientKey('phone#+15550100082'));
      expect(payloads).not.toContain('+1555010008');
    });

    it('13 a 4xx with no code writes failed with NO errorCode; the record cause keeps the status (R3 #13)', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      wire();
      world.adapter.sendPreparedMessage = async () => {
        throw Object.assign(new Error('bad request'), { status: 400 });
      };
      await runFirstPass();
      const b = world.broadcasts.get('bcast-1')!;
      expect(b.recipients['t-1']).toEqual({ status: 'failed' });
      expect(b.stats.failed).toBe(1);
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'done', outcome: 'rejected', cause: '400' });
      expect(b.status).toBe('failed');
    });

    it('13b a Twilio rejection with its code fails the recipient with that code and closes the record rejected; the known arms keep their writes', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(3));
      wire();
      const codes: Record<string, number> = { '+15550100001': 21211, '+15550100002': 30007, '+15550100003': 30005 };
      world.adapter.sendPreparedMessage = async (prepared: PreparedMessageSend) => {
        throw Object.assign(new Error('rejected'), { status: 400, code: codes[prepared.params.to] });
      };
      await runFirstPass();
      const b = world.broadcasts.get('bcast-1')!;
      expect(b.recipients['t-1']).toEqual({ status: 'failed', errorCode: '21211' });
      expect(b.recipients['t-2']).toEqual({ status: 'failed', errorCode: '30007' });
      expect(b.recipients['t-3']).toEqual({ status: 'failed', errorCode: '30005' });
      expect(b.stats.failed).toBe(3);
      expect(b.stats.queued).toBe(0);
      for (const [k, code] of [['t-1', '21211'], ['t-2', '30007'], ['t-3', '30005']] as const) {
        expect(await world.sendAttemptsRepo.get(ownerOf(k))).toMatchObject({ state: 'done', outcome: 'rejected', cause: code });
      }
      expect(world.flagWrites.filter((f) => f.flag === 'sms_unreachable').map((f) => f.contactId)).toEqual(['t-3']);
      expect(b.status).toBe('failed');
      expect(b.last_error).toBe('all recipients failed');
    });

    it('13c the adapter kill switch fails the recipient with its prose token (D5, D23)', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      wire();
      world.adapter.sendPreparedMessage = async () => {
        throw new AdapterSmsSendingDisabledError('SMS sending is disabled');
      };
      await runFirstPass();
      expect(world.broadcasts.get('bcast-1')!.recipients['t-1']).toEqual({ status: 'failed', errorCode: 'sms_sending_disabled' });
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'done', outcome: 'rejected', cause: 'sms_sending_disabled' });
    });

    it('14 anything else thrown at the send is an UNKNOWN outcome (D2): handed to reconcile, never failed', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      const { logger: log } = capturingLogger();
      registerBroadcastSendJobHandler({
        sendAttemptsRepo: world.sendAttemptsRepo,
        config: testConfig({ BUSINESS_PHONE_NUMBER: MAIN }),
        broadcastsRepo: world.broadcastsRepo,
        contactsRepo: world.contactsRepo,
        conversationsRepo: world.conversationsRepo,
        messagesRepo: world.messagesRepo,
        unitsRepo: world.unitsRepo,
        sendMessageService: async () => {
          throw new Error('an untyped failure');
        },
        auditRepo: world.auditRepo,
        activityEventsRepo: world.activityEventsRepo,
        listingSendsRepo: world.listingSendsRepo,
        events: world.events,
        logger: log,
      });
      await runFirstPass();
      expect(world.broadcasts.get('bcast-1')!.recipients['t-1']).toEqual({ status: 'queued' });
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'reconciling' });
      expect(delayedOf(SEND_RECONCILE_JOB)).toHaveLength(1);
    });

    // --- the cap-close gate (D8) and the re-drive pass (D13a, D16) ---------
    /** A record the reconcile ruled never_sent and re-drove: redriven, redriveCount 1. */
    async function seedRedriven(k: string): Promise<void> {
      const at = new Date().toISOString();
      await world.sendAttemptsRepo.claim(ownerOf(k), seedFacts, at);
      await world.sendAttemptsRepo.handToReconcile(ownerOf(k), { attemptNo: 1, attemptedAt: at });
      await world.sendAttemptsRepo.markRedriven(ownerOf(k), at);
    }
    function refuseDelayedEnqueues(): void {
      // DELAY-SELECTIVE: the entry enqueue (delay 0) must still pass.
      configureOutboundQueue({
        async enqueue(envelope, opts) {
          if ((opts?.delaySeconds ?? 0) > 0) throw new Error('queue down');
          return outbound.enqueue(envelope, opts);
        },
      });
    }

    it('8 a cap-close closes only records that are absent or done/retryable, skips a terminal one, defers a live one and takes over a stale attempting one (D8)', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(6));
      const capture = wire();
      unknownOn(new Set());
      const reconciles = recordReconciles();
      // Close B: the ladder is already spent when this first pass begins.
      world.broadcasts.get('bcast-1')!.fanout_attempt = 3;
      const now = new Date().toISOString();
      const stale = agoIso(31_000);
      // t-1: no record.
      await world.sendAttemptsRepo.claim(ownerOf('t-2'), seedFacts, now); // fresh attempting
      await world.sendAttemptsRepo.claim(ownerOf('t-3'), seedFacts, stale); // stale attempting
      await world.sendAttemptsRepo.claim(ownerOf('t-4'), seedFacts, now); // reconciling
      await world.sendAttemptsRepo.handToReconcile(ownerOf('t-4'), { attemptNo: 1, attemptedAt: now });
      await world.sendAttemptsRepo.claim(ownerOf('t-5'), seedFacts, now); // done/sent
      await world.sendAttemptsRepo.finishAttempt(ownerOf('t-5'), { attemptNo: 1, attemptedAt: now }, { outcome: 'sent', sid: 'SM5' });
      await world.sendAttemptsRepo.claim(ownerOf('t-6'), seedFacts, now); // done/retryable
      await world.sendAttemptsRepo.finishAttempt(ownerOf('t-6'), { attemptNo: 1, attemptedAt: now }, { outcome: 'retryable', cause: '429' });

      await runFirstPass();

      const b = world.broadcasts.get('bcast-1')!;
      expect(b.recipients['t-1']).toEqual({ status: 'failed', errorCode: 'transient_cap' });
      for (const k of ['t-2', 't-3', 't-4', 't-5']) expect(b.recipients[k], k).toEqual({ status: 'queued' });
      expect(b.recipients['t-6']).toEqual({ status: 'failed', errorCode: 'transient_cap' });
      expect(b.stats).toMatchObject({ failed: 2, queued: 4 });
      expect(await world.sendAttemptsRepo.get(ownerOf('t-3'))).toMatchObject({ state: 'reconciling', attemptedAt: stale });
      expect(await world.sendAttemptsRepo.get(ownerOf('t-2'))).toMatchObject({ state: 'attempting' });
      expect(await world.sendAttemptsRepo.get(ownerOf('t-6'))).toMatchObject({ state: 'done', outcome: 'retryable' });
      expect(reconciles).toEqual([
        { owner: { kind: 'broadcast', broadcastId: 'bcast-1', recipientKeyHash: 't-3' }, attemptedAt: stale, checkNo: 0 },
      ]);
      expect(sends).toHaveLength(0);
      expect(closeLines(capture)).toHaveLength(1);
      // finalize ran and deferred: four recipients are still owned elsewhere.
      expect(b.status).toBe('sending');
    });

    it('8b a cap-close takeover whose fence is lost leaves the recipient alone', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      wire();
      unknownOn(new Set());
      const reconciles = recordReconciles();
      world.broadcasts.get('bcast-1')!.fanout_attempt = 3;
      await world.sendAttemptsRepo.claim(ownerOf('t-1'), seedFacts, agoIso(31_000));
      vi.spyOn(world.sendAttemptsRepo, 'takeOver').mockResolvedValueOnce(false);
      await runFirstPass();
      expect(world.broadcasts.get('bcast-1')!.recipients['t-1']).toEqual({ status: 'queued' });
      expect(reconciles).toHaveLength(0);
    });

    it('8c a cap-close whose gate read throws for one recipient logs it and still closes the rest and finalizes (T7-9)', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(2));
      const capture = wire();
      unknownOn(new Set());
      world.broadcasts.get('bcast-1')!.fanout_attempt = 3;
      vi.spyOn(world.sendAttemptsRepo, 'get').mockRejectedValueOnce(new Error('dynamo down'));
      await runFirstPass();
      const b = world.broadcasts.get('bcast-1')!;
      expect(b.recipients['t-1']).toEqual({ status: 'queued' });
      expect(b.recipients['t-2']).toEqual({ status: 'failed', errorCode: 'transient_cap' });
      const capClose = capture.atLevel(50).filter((l) => l['label'] === 'capClose');
      expect(capClose).toHaveLength(1);
      expect(capClose[0]).toMatchObject({ broadcastId: 'bcast-1', recipientKey: 't-1' });
      expect(closeLines(capture)).toHaveLength(1);
      expect(capture.atLevel(30).some((l) => String(l['msg']).includes('finalize deferred'))).toBe(true);
    });

    it('9a a re-drive pass claims no ladder rung up front and its fence closes the redriven record done/refused', async () => {
      seedUnit(world);
      const [t] = tenants(1);
      t!.sms_opt_out = true;
      seedBroadcast(world, [t!]);
      wire();
      unknownOn(new Set());
      await seedRedriven('t-1');
      world.broadcasts.get('bcast-1')!.fanout_attempt = 3;
      const claimPass = vi.spyOn(world.broadcastsRepo, 'claimFanoutPass');
      await runPayload({ broadcastId: 'bcast-1', recipientKeys: ['t-1'], attempt: 4, redrive: true });
      const b = world.broadcasts.get('bcast-1')!;
      expect(b.recipients['t-1']).toEqual({ status: 'skipped', errorCode: 'opted_out' });
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'done', outcome: 'refused', cause: 'opted_out' });
      expect(claimPass).not.toHaveBeenCalled();
      expect(b.fanout_attempt).toBe(3);
      expect(b.status).toBe('sent');
    });

    it('9b a re-drive attempt that comes back unknown closes unresolved with no second reconcile (D13a)', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      const capture = wire();
      unknownOn(new Set(['+15550100001']));
      await seedRedriven('t-1');
      const claimPass = vi.spyOn(world.broadcastsRepo, 'claimFanoutPass');
      await runPayload({ broadcastId: 'bcast-1', recipientKeys: ['t-1'], attempt: 4, redrive: true });
      const b = world.broadcasts.get('bcast-1')!;
      expect(sends).toHaveLength(1);
      expect(b.recipients['t-1']).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
      expect(b.stats.unconfirmed).toBe(1);
      expect(b.stats.queued).toBe(0);
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({
        state: 'done',
        outcome: 'unresolved',
        cause: 'second_unknown',
        attemptNo: 2,
        redriveCount: 1,
      });
      expect(outbound.delayed).toHaveLength(0);
      expect(claimPass).not.toHaveBeenCalled();
      expect(b.status).toBe('failed');
      expect(b.last_error).toBe("Couldn't confirm any text went out");
      expect(capture.atLevel(50).filter((l) => l['cause'] === 'second_unknown')).toHaveLength(1);
    });

    it('9c a re-drive pass that defers before its claim and hits the cap closes its OWN redriven record (R2 #11)', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      wire();
      unknownOn(new Set());
      await seedRedriven('t-1');
      world.broadcasts.get('bcast-1')!.fanout_attempt = 3;
      vi.spyOn(world.conversationsRepo, 'createOrGetByParticipantPhone').mockRejectedValueOnce(new Error('dynamo blip'));
      const claimPass = vi.spyOn(world.broadcastsRepo, 'claimFanoutPass');
      await runPayload({ broadcastId: 'bcast-1', recipientKeys: ['t-1'], attempt: 4, redrive: true });
      const b = world.broadcasts.get('bcast-1')!;
      expect(b.recipients['t-1']).toEqual({ status: 'failed', errorCode: 'transient_cap' });
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'done', outcome: 'refused', cause: 'transient_cap' });
      // The rung is claimed only AFTER the loop, because the pass has a remainder - and it is capped.
      expect(claimPass).toHaveBeenCalledTimes(1);
      expect(sends).toHaveLength(0);
      expect(b.status).toBe('failed');
    });

    it('9d a redriven record reached by an ORDINARY continuation (no marker) whose fence trips closes done/refused (R3 #17)', async () => {
      seedUnit(world);
      const [t] = tenants(1);
      t!.sms_opt_out = true;
      seedBroadcast(world, [t!]);
      wire();
      await seedRedriven('t-1');
      await runPayload({ broadcastId: 'bcast-1', recipientKeys: ['t-1'], attempt: 2 });
      expect(world.broadcasts.get('bcast-1')!.recipients['t-1']).toEqual({ status: 'skipped', errorCode: 'opted_out' });
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'done', outcome: 'refused', cause: 'opted_out' });
    });

    it('9e a re-drive pass whose continuation enqueue is refused closes its redriven record enqueue_failed (G7)', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      wire();
      unknownOn(new Set());
      await seedRedriven('t-1');
      vi.spyOn(world.conversationsRepo, 'createOrGetByParticipantPhone').mockRejectedValueOnce(new Error('dynamo blip'));
      refuseDelayedEnqueues();
      await runPayload({ broadcastId: 'bcast-1', recipientKeys: ['t-1'], attempt: 4, redrive: true });
      const b = world.broadcasts.get('bcast-1')!;
      expect(b.recipients['t-1']).toEqual({ status: 'failed', errorCode: 'enqueue_failed' });
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'done', outcome: 'enqueue_failed', cause: 'enqueue_failed' });
      expect(b.status).toBe('failed');
    });

    it('9f a re-drive pass with a retryable remainder claims its rung AFTER the loop; the continuation carries no marker', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      wire();
      const refused = vi.fn(async (): Promise<never> => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      });
      world.adapter.sendPreparedMessage = refused;
      await seedRedriven('t-1');
      const claimPass = vi.spyOn(world.broadcastsRepo, 'claimFanoutPass');
      await runPayload({ broadcastId: 'bcast-1', recipientKeys: ['t-1'], attempt: 4, redrive: true });
      expect(refused).toHaveBeenCalledTimes(1);
      expect(claimPass).toHaveBeenCalledTimes(1);
      // AFTER the loop: the rung is claimed only once the pass knows it has a remainder.
      expect(claimPass.mock.invocationCallOrder[0]!).toBeGreaterThan(refused.mock.invocationCallOrder[0]!);
      expect(delayedOf(BROADCAST_SEND_JOB).map((d) => d.envelope.payload)).toEqual([
        { broadcastId: 'bcast-1', attempt: 2, recipientKeys: ['t-1'] },
      ]);
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'done', outcome: 'retryable', redriveCount: 1 });
    });

    it('9g a re-drive pass whose recipient sends claims no rung and finalizes', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      wire();
      unknownOn(new Set());
      await seedRedriven('t-1');
      const claimPass = vi.spyOn(world.broadcastsRepo, 'claimFanoutPass');
      await runPayload({ broadcastId: 'bcast-1', recipientKeys: ['t-1'], attempt: 4, redrive: true });
      expect(sends).toHaveLength(1);
      expect(claimPass).not.toHaveBeenCalled();
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'done', outcome: 'sent', sid: 'SM-+15550100001' });
      expect(world.broadcasts.get('bcast-1')!.status).toBe('sent');
    });

    it('the payload parser carries redrive: true and nothing else', () => {
      expect(parseBroadcastSendPayload({ broadcastId: 'b', redrive: true })).toEqual({ broadcastId: 'b', attempt: 1, redrive: true });
      expect(parseBroadcastSendPayload({ broadcastId: 'b', redrive: 'yes' })).toEqual({ broadcastId: 'b', attempt: 1 });
      expect(parseBroadcastSendPayload({ broadcastId: 'b', recipientKeys: ['k'], attempt: 2 })).toEqual({
        broadcastId: 'b',
        attempt: 2,
        recipientKeys: ['k'],
      });
    });

    it('a continuation reads its snapshot strongly consistently; a first pass does not (D11, D16)', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      wire();
      unknownOn(new Set());
      const consistent = vi.spyOn(world.broadcastsRepo, 'getByIdConsistent');
      // First pass: a prepare throw defers t-1 (a continuation is pending, so no finalize reads either).
      vi.spyOn(world.conversationsRepo, 'createOrGetByParticipantPhone').mockRejectedValueOnce(new Error('dynamo blip'));
      await runFirstPass();
      expect(consistent).not.toHaveBeenCalled();
      // A continuation: a foreign fresh attempt defers t-1 again - the one consistent read is the snapshot.
      await world.sendAttemptsRepo.claim(ownerOf('t-1'), seedFacts, new Date().toISOString());
      await runPayload({ broadcastId: 'bcast-1', recipientKeys: ['t-1'], attempt: 2 });
      expect(consistent).toHaveBeenCalledTimes(1);
      expect(consistent).toHaveBeenCalledWith('bcast-1');
    });

    // --- code review ADV-1 (FW2-1): the re-arm immediately before the send ---

    /** A real broadcast.send envelope NOT run by the queue: dispatched by hand, a stalled pass never blocks outbound.settle(). */
    async function detachedEnvelope(): Promise<unknown> {
      const envelope = await enqueue(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' }, { runAt: new Date(Date.now() + 600_000) });
      const [item] = outbound.delayed.splice(
        outbound.delayed.findIndex((d) => d.envelope.jobId === envelope.jobId),
        1,
      );
      return JSON.parse(JSON.stringify(item!.envelope)) as unknown;
    }
    const takenOverLines = (capture: LogCapture) =>
      capture.atLevel(30).filter((l) => String(l['msg']).includes('taken over before the send'));

    it('ADV-1 (zz-adv-6): a pass stalled between its claim and the send - taken over, reconciled never_sent and re-driven meanwhile - resumes and does NOT send: its re-arm finds the attempt moved on (FW2-1)', async () => {
      seedUnit(world);
      const [t] = tenants(1);
      seedBroadcast(world, [t!]);
      const capture = wire();
      registerSendReconcileJobHandler({
        adapter: world.adapter,
        messagesRepo: world.messagesRepo,
        broadcastsRepo: world.broadcastsRepo,
        contactsRepo: world.contactsRepo,
        conversationsRepo: world.conversationsRepo,
        sendAttemptsRepo: world.sendAttemptsRepo,
        activityEventsRepo: world.activityEventsRepo,
        listingSendsRepo: world.listingSendsRepo,
        auditRepo: world.auditRepo,
        events: world.events,
        logger: createLogger({ level: 'info', destination: capture.stream }),
      });
      // Pass A claims t-1 and stalls in the send wrapper's contact read (after
      // the claim, before the provider call) - for 31 s: past the claim TTL.
      const realClaim = world.sendAttemptsRepo.claim.bind(world.sendAttemptsRepo);
      vi.spyOn(world.sendAttemptsRepo, 'claim').mockImplementationOnce((owner, facts) =>
        realClaim(owner, facts, agoIso(31_000)),
      );
      const realFind = world.contactsRepo.findByPhone.bind(world.contactsRepo);
      let resumeA!: () => void;
      let stalledA!: () => void;
      const aIsStalled = new Promise<void>((resolve) => {
        stalledA = resolve;
      });
      vi.spyOn(world.contactsRepo, 'findByPhone').mockImplementationOnce(async (...args) => {
        stalledA();
        await new Promise<void>((resolve) => {
          resumeA = resolve;
        });
        return realFind(...args);
      });
      const passA = dispatchJob(await detachedEnvelope());
      await aIsStalled;
      // Pass B - a second first pass under another jobId - finds the claim
      // stale: it takes it over and hands off; checks 0 and 1 are due at once.
      await runFirstPass();
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'reconciling', attemptNo: 1 });
      // Check 2: the provider holds nothing - never_sent. The record is
      // re-driven and the re-drive pass claims attempt 2 and sends.
      const [check2] = outbound.delayed.splice(
        outbound.delayed.findIndex((d) => d.envelope.jobName === SEND_RECONCILE_JOB),
        1,
      );
      await dispatchJob(JSON.parse(JSON.stringify(check2!.envelope)) as unknown);
      await outbound.settle();
      expect(world.sent.map((s) => s.to)).toEqual([t!.phone]);
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({
        state: 'done',
        outcome: 'sent',
        attemptNo: 2,
        redriveCount: 1,
      });
      // Pass A resumes. The attempt it claimed is gone: it must not send.
      resumeA();
      await passA;
      await outbound.settle();
      expect(world.sent.map((s) => s.to)).toEqual([t!.phone]);
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({
        state: 'done',
        outcome: 'sent',
        attemptNo: 2,
        redriveCount: 1,
      });
      expect(world.broadcasts.get('bcast-1')!.recipients['t-1']).toMatchObject({ status: 'sent' });
      expect(world.broadcasts.get('bcast-1')!.status).toBe('sent');
      expect(takenOverLines(capture)).toHaveLength(1);
      expect(capture.atLevel(50)).toHaveLength(0);
    });

    it('ADV-1: a re-arm that finds the attempt taken over sends nothing and writes nothing - not carried, no reconcile, one INFO (FW2-1)', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      const capture = wire();
      const claim = vi.spyOn(world.sendAttemptsRepo, 'claim');
      vi.spyOn(world.sendAttemptsRepo, 'rearm').mockResolvedValueOnce(undefined);
      // A continuation, so a carried recipient would show as a new continuation.
      await runPayload({ broadcastId: 'bcast-1', recipientKeys: ['t-1'], attempt: 2 });
      expect(world.sent).toHaveLength(0);
      expect(world.broadcasts.get('bcast-1')!.recipients['t-1']).toEqual({ status: 'queued' });
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({
        state: 'attempting',
        attemptNo: 1,
        attemptedAt: claim.mock.calls[0]![2],
      });
      expect(outbound.delayed).toHaveLength(0);
      expect(takenOverLines(capture)).toHaveLength(1);
      expect(takenOverLines(capture)[0]).toMatchObject({ broadcastId: 'bcast-1', recipientKey: 't-1' });
      expect(capture.atLevel(40).filter((l) => String(l['msg']).includes('send not attempted'))).toHaveLength(0);
      expect(capture.atLevel(50)).toHaveLength(0);
    });

    it('ADV-1: a re-arm that throws defers the recipient send_retryable and releases the attempt retryable on its claimed ref - nothing sent (FW2-1)', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(2));
      const capture = wire();
      vi.spyOn(world.sendAttemptsRepo, 'rearm').mockRejectedValueOnce(new Error('TransactionConflict'));
      await runFirstPass();
      const b = world.broadcasts.get('bcast-1')!;
      expect(b.recipients['t-1']).toEqual({ status: 'queued', errorCode: 'send_retryable' });
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({
        state: 'done',
        outcome: 'retryable',
        cause: 'send_retryable',
        attemptNo: 1,
      });
      expect(b.recipients['t-2']!.status).toBe('sent');
      expect(world.sent.map((s) => s.to)).toEqual(['+15550100002']);
      expect(continuationKeys()).toEqual(['t-1']);
      const warn = capture.atLevel(40).filter((l) => String(l['msg']).includes('send not attempted'));
      expect(warn).toHaveLength(1);
      expect(warn[0]).toMatchObject({ recipientKey: 't-1' });
    });

    it('ADV-1: the pass re-arms inside the send wrapper as the LAST step before the provider call and fences its record write on the ref the re-arm returned (FW2-1)', async () => {
      seedUnit(world);
      seedBroadcast(world, tenants(1));
      wire();
      const findByPhone = vi.spyOn(world.contactsRepo, 'findByPhone');
      const realRearm = world.sendAttemptsRepo.rearm.bind(world.sendAttemptsRepo);
      const later = new Date(Date.now() + 1_000).toISOString();
      const rearm = vi
        .spyOn(world.sendAttemptsRepo, 'rearm')
        .mockImplementationOnce((owner, ref) => realRearm(owner, ref, later));
      const send = vi.spyOn(world.adapter, 'sendPreparedMessage');
      await runFirstPass();
      expect(rearm).toHaveBeenCalledTimes(1);
      expect(findByPhone.mock.invocationCallOrder[0]!).toBeLessThan(rearm.mock.invocationCallOrder[0]!);
      expect(rearm.mock.invocationCallOrder[0]!).toBeLessThan(send.mock.invocationCallOrder[0]!);
      expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({
        state: 'done',
        outcome: 'sent',
        attemptNo: 1,
        attemptedAt: later,
      });
    });
  });

  describe('finalize (spec D16a)', () => {
    function terminalBroadcast(slots: Record<string, BroadcastRecipient>): void {
      const ts = Object.keys(slots).map((k, i) => seedTenant(world, { contactId: k, phone: `+1555010100${i}` }));
      const item = seedBroadcast(world, ts);
      for (const [k, slot] of Object.entries(slots)) item.recipients[k] = slot;
    }
    const run = () => finalize(world.broadcastsRepo, world.events, 'bcast-1', logger, world.auditRepo);

    it('N callers produce one flip, one audit row, one terminal emit', async () => {
      terminalBroadcast({
        a: { status: 'sent', conversationId: 'c', tsMsgId: 'x' },
        b: { status: 'skipped', errorCode: 'opted_out' },
      });
      await Promise.all([run(), run(), run(), run(), run()]);
      const b = world.broadcasts.get('bcast-1')!;
      expect(b.status).toBe('sent');
      expect(world.auditEvents.filter((e) => e.event_type === 'broadcast_sent')).toHaveLength(1);
      const emits = world.emitted.filter((e) => e.event === 'broadcast.updated');
      expect(emits).toHaveLength(1);
      expect((emits[0]!.payload as { status: string }).status).toBe('sent');
    });

    it('all skipped plus one unconfirmed finalizes failed with the prose - Review Focus 5', async () => {
      terminalBroadcast({
        a: { status: 'skipped', errorCode: 'opted_out' },
        b: { status: 'skipped', errorCode: 'opted_out' },
        c: { status: 'skipped', errorCode: 'opted_out' },
        d: { status: 'failed', errorCode: 'send_unconfirmed' },
      });
      await run();
      const b = world.broadcasts.get('bcast-1')!;
      expect(b.status).toBe('failed');
      expect(b.last_error).toBe("Couldn't confirm any text went out");
    });

    it('a real failure beside an unconfirmed one reads "all recipients failed"', async () => {
      terminalBroadcast({
        a: { status: 'failed', errorCode: '30007' },
        b: { status: 'failed', errorCode: 'send_unconfirmed' },
      });
      await run();
      expect(world.broadcasts.get('bcast-1')!).toMatchObject({ status: 'failed', last_error: 'all recipients failed' });
    });

    it('decides from the recipients map when the persisted failed counter is stale', async () => {
      terminalBroadcast({
        a: { status: 'delivered', conversationId: 'c', tsMsgId: 'x' },
        b: { status: 'delivered', conversationId: 'c', tsMsgId: 'y' },
      });
      world.broadcasts.get('bcast-1')!.stats.failed = 99;
      const consistent = vi.spyOn(world.broadcastsRepo, 'getByIdConsistent');
      await run();
      const b = world.broadcasts.get('bcast-1')!;
      expect(b.status).toBe('sent');
      expect(b.last_error).toBeUndefined();
      // D16a: the decision rests on a strongly consistent read.
      expect(consistent).toHaveBeenCalledWith('bcast-1');
    });

    it.each([
      ['dispatched (sending)', { status: 'sent', conversationId: 'c', tsMsgId: 'x' }],
      ['carrier-confirmed sent', { status: 'sent', conversationId: 'c', tsMsgId: 'x', carrierSentAt: '2026-09-27T00:00:00.000Z' }],
      ['delivered', { status: 'delivered', conversationId: 'c', tsMsgId: 'x' }],
    ] as const)('one %s recipient keeps the share sent, whatever else failed', async (_name, reached) => {
      terminalBroadcast({
        a: { ...reached },
        b: { status: 'failed', errorCode: '30007' },
        c: { status: 'failed', errorCode: 'send_unconfirmed' },
      });
      await run();
      expect(world.broadcasts.get('bcast-1')!.status).toBe('sent');
    });

    it('a broadcast of skips alone finalizes sent', async () => {
      terminalBroadcast({ a: { status: 'skipped', errorCode: 'manual_mode' } });
      await run();
      expect(world.broadcasts.get('bcast-1')!.status).toBe('sent');
    });

    it('a still-queued recipient defers finalize: no flip, no audit row, no emit', async () => {
      terminalBroadcast({
        a: { status: 'sent', conversationId: 'c', tsMsgId: 'x' },
        b: { status: 'queued' },
      });
      await run();
      expect(world.broadcasts.get('bcast-1')!.status).toBe('sending');
      expect(world.auditEvents.filter((e) => e.event_type === 'broadcast_sent')).toHaveLength(0);
      expect(world.emitted.filter((e) => e.event === 'broadcast.updated')).toHaveLength(0);
    });

    // Drives the REAL send.reconcile handler (Task 10), so this test never
    // calls the describe-local recordReconciles() stub: a second registration
    // of SEND_RECONCILE_JOB would throw.
    it('pass-then-verdict and verdict-then-pass both finalize exactly once', async () => {
      const MAIN = '+15550009999';
      seedUnit(world);
      wireHandler(world, logger, undefined, { BUSINESS_PHONE_NUMBER: MAIN });
      registerSendReconcileJobHandler({
        adapter: world.adapter,
        messagesRepo: world.messagesRepo,
        broadcastsRepo: world.broadcastsRepo,
        contactsRepo: world.contactsRepo,
        conversationsRepo: world.conversationsRepo,
        sendAttemptsRepo: world.sendAttemptsRepo,
        activityEventsRepo: world.activityEventsRepo,
        listingSendsRepo: world.listingSendsRepo,
        auditRepo: world.auditRepo,
        events: world.events,
        logger,
      });
      // The first recipient of each share: the provider RECORDS the message and
      // then the socket drops (the accept-then-drop case) - an unknown outcome
      // the reconcile finds and adopts. `duringNextSend` lets the verdict land
      // while the pass is still sending the NEXT recipient.
      const dropFor = new Set<string>();
      let duringNextSend: (() => Promise<void>) | undefined;
      const realSend = world.adapter.sendPreparedMessage.bind(world.adapter);
      world.adapter.sendPreparedMessage = async (prepared: PreparedMessageSend) => {
        if (dropFor.has(prepared.params.to)) {
          world.providerMessages.push({
            providerSid: `SMdrop-${prepared.params.to.slice(-4)}`,
            providerStatus: 'delivered',
            body: prepared.params.body ?? '',
            mediaCount: 0,
            createdAt: new Date().toISOString(),
            to: prepared.params.to,
            from: prepared.params.from ?? '',
          });
          throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        }
        const hook = duringNextSend;
        duringNextSend = undefined;
        if (hook !== undefined) await hook();
        return realSend(prepared);
      };
      /** Deliver the one scheduled reconcile check of a share now (its delay is not awaited). */
      async function runVerdict(broadcastId: string): Promise<void> {
        const index = outbound.delayed.findIndex(
          (d) =>
            d.envelope.jobName === SEND_RECONCILE_JOB &&
            (d.envelope.payload as SendReconcilePayload).owner.kind === 'broadcast' &&
            (d.envelope.payload as { owner: { broadcastId: string } }).owner.broadcastId === broadcastId,
        );
        expect(index).toBeGreaterThanOrEqual(0);
        const [item] = outbound.delayed.splice(index, 1);
        await dispatchJob(JSON.parse(JSON.stringify(item!.envelope)) as unknown);
      }
      const terminalEmits = (broadcastId: string) =>
        world.emitted.filter(
          (e) =>
            e.event === 'broadcast.updated' &&
            (e.payload as { broadcastId: string }).broadcastId === broadcastId &&
            (e.payload as { status: string }).status !== 'sending',
        );
      const auditRows = (broadcastId: string) =>
        world.auditEvents.filter((e) => e.event_type === 'broadcast_sent' && e.payload?.['broadcastId'] === broadcastId);

      // PASS then VERDICT: the pass ends with its dropped recipient still
      // reconciling (a queued slot - finalize defers); the verdict adopts it
      // and is the finalize that flips.
      const a1 = seedTenant(world, { contactId: 'a-1', phone: '+15550100011' });
      const a2 = seedTenant(world, { contactId: 'a-2', phone: '+15550100012' });
      seedBroadcast(world, [a1, a2], { broadcastId: 'bcast-a' });
      dropFor.add(a1.phone!);
      await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-a' });
      await outbound.settle();
      expect(world.broadcasts.get('bcast-a')!.recipients['a-1']).toEqual({ status: 'queued' });
      expect(world.broadcasts.get('bcast-a')!.status).toBe('sending');
      await runVerdict('bcast-a');
      expect(world.broadcasts.get('bcast-a')!.recipients['a-1']).toMatchObject({ status: 'delivered' });
      expect(world.broadcasts.get('bcast-a')!.status).toBe('sent');
      expect(auditRows('bcast-a')).toHaveLength(1);
      expect(terminalEmits('bcast-a')).toHaveLength(1);

      // VERDICT then PASS: the verdict lands while the pass is still sending
      // the second recipient - its finalize defers on that queued slot - and
      // the pass's own finalize is the one that flips.
      const b1 = seedTenant(world, { contactId: 'b-1', phone: '+15550100021' });
      const b2 = seedTenant(world, { contactId: 'b-2', phone: '+15550100022' });
      seedBroadcast(world, [b1, b2], { broadcastId: 'bcast-b' });
      dropFor.add(b1.phone!);
      let statusWhenVerdictRan: string | undefined;
      duringNextSend = async () => {
        await runVerdict('bcast-b');
        statusWhenVerdictRan = world.broadcasts.get('bcast-b')!.status;
      };
      await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-b' });
      await outbound.settle();
      expect(statusWhenVerdictRan).toBe('sending');
      expect(world.broadcasts.get('bcast-b')!.recipients['b-1']).toMatchObject({ status: 'delivered' });
      expect(world.broadcasts.get('bcast-b')!.recipients['b-2']).toMatchObject({ status: 'sent' });
      expect(world.broadcasts.get('bcast-b')!.status).toBe('sent');
      expect(auditRows('bcast-b')).toHaveLength(1);
      expect(terminalEmits('bcast-b')).toHaveLength(1);
    });
  });
});
