// send.reconcile (SOR spec Sec 5, D11-D16a) - the job that resolves a send the
// provider left AMBIGUOUS: it looks the message up at the provider, then adopts
// it, re-drives the recipient once, or closes it `unresolved`.
//
// Driven through the real jobs envelope machinery over the fake world (the
// harness twins are held to the real repos by the two parity suites). Every
// check a test runs is dispatched from a real envelope, so a handler throw
// PROPAGATES (a delayed dispatch rethrows); the checks the job schedules for
// itself land in `outbound.delayed` with their delay in SECONDS; a re-drive is
// an immediate enqueue, drained by `outbound.settle()` (build finding T10-8).
// Every attemptedAt a test observes a delayed enqueue from is FRESH (T9-1).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  enqueue,
} from '../src/jobs/jobs.js';
import {
  BROADCAST_SEND_JOB,
  isBroadcastRowFor,
  registerBroadcastSendJobHandler,
  type BroadcastSendPayload,
} from '../src/jobs/broadcastFanOut.js';
import { RELAY_FANOUT_JOB, type RelayFanOutPayload } from '../src/jobs/relayFanOut.js';
import {
  RELAY_RETRY_LEG_JOB,
  _resetRelayRetryLegForTests,
  registerRelayRetryLegJobHandler,
  type RelayRetryLegPayload,
} from '../src/jobs/relayRetryLeg.js';
import {
  SEND_RECONCILE_JOB,
  parseSendReconcilePayload,
  reconcileCheckDelaysMs,
  reconcileDelayMs,
  registerSendReconcileJobHandler,
  toOwnerRef,
  type SendReconcilePayload,
} from '../src/jobs/sendReconcile.js';
import { DEV_SESSION_SECRET_DEFAULT, loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { relayRetryDigest, relayRetryProviderSid } from '../src/lib/relayRetryClaim.js';
import { bodyFingerprint, hashRecipientKey, recipientDigest } from '../src/lib/sendFingerprint.js';
import {
  RECONCILE_CHECK_DELAYS_MS,
  RECONCILE_SIBLING_SPAN_MS,
  RECONCILE_WINDOW_LEAD_MS,
  RECONCILE_WINDOW_TRAIL_MS,
  SEND_CLAIM_TTL_MS,
} from '../src/lib/sendOutcome.js';
import type { BroadcastItem, BroadcastRecipient } from '../src/repos/broadcastsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { ConversationItem, ConversationParticipant } from '../src/repos/conversationsRepo.js';
import { buildTsMsgId, type MessageItem, type RelayRecipientDelivery } from '../src/repos/messagesRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import type { SendAttemptFacts, SendAttemptOwner } from '../src/repos/sendAttemptsRepo.js';
import { createSendMessageService } from '../src/services/sendMessage.js';
import { createFakeWorld, type FakeProviderMessage, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';

/** The business number every broadcast attempt is sent from (the record's sender). */
const MAIN = '+15550009999';
/** A broadcast body with no per-recipient merge field: every recipient's fingerprint is equal. */
const BODY = 'New listing: 2bd for $1200 near the park - reply YES for a tour';
const T_PHONE = '+15550100001';

describe('send.reconcile (spec D11-D16)', () => {
  let world: FakeWorld;
  let capture: LogCapture;
  let logger: ReturnType<typeof createLogger>;
  let outbound: InProcessOutboundQueueAdapter;

  beforeEach(() => {
    _resetForTests();
    capture = createLogCapture();
    logger = createLogger({ level: 'info', destination: capture.stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob, logger });
    configureOutboundQueue(outbound);
  });

  afterEach(() => {
    _resetForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function register(): void {
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
  }

  /** A recording stub for a job the reconcile enqueues (the re-drive), so the envelope is observed, not run. */
  function recordJobs(jobName: string): unknown[] {
    const got: unknown[] = [];
    defineJobHandler(jobName, async (p) => {
      got.push(p);
    });
    return got;
  }

  // ---- broadcast fixtures ---------------------------------------------------

  function seedTenant(overrides: Partial<ContactItem> = {}): ContactItem {
    const n = world.contacts.length + 1;
    const contact: ContactItem = {
      contactId: `t-${n}`,
      type: 'tenant',
      status: 'active',
      phone: `+1555010000${n}`,
      consent_method: 'inbound_text',
      ...overrides,
    };
    world.contacts.push(contact);
    return contact;
  }

  function seedUnit(): void {
    const unit: UnitItem = {
      unitId: 'unit-1',
      landlordId: 'c-ll',
      status: 'available',
      beds: 2,
      rent_min: 1200,
      rent_max: 1400,
      address: { line1: '1 Oak', city: 'Town', state: 'IL', zip: '60000' },
    };
    world.units.set(unit.unitId, unit);
  }

  function seedBroadcast(keys: string[], overrides: Partial<BroadcastItem> = {}): BroadcastItem {
    const recipients: Record<string, BroadcastRecipient> = Object.fromEntries(
      keys.map((k): [string, BroadcastRecipient] => [k, { status: 'queued' }]),
    );
    const now = new Date().toISOString();
    const item: BroadcastItem = {
      broadcastId: 'bcast-1',
      created_by: 'usr_test',
      created_at: now,
      status: 'sending',
      unitId: 'unit-1',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: BODY,
      stats: {
        audience: keys.length,
        sent: 0,
        delivered: 0,
        failed: 0,
        unconfirmed: 0,
        skipped_opted_out: 0,
        skipped_no_consent: 0,
        queued: keys.length,
      },
      recipients,
      updated_at: now,
      ...overrides,
    };
    world.broadcasts.set(item.broadcastId, item);
    return item;
  }

  const bOwner = (contactKey: string, broadcastId = 'bcast-1'): SendAttemptOwner => ({
    kind: 'broadcast',
    broadcastId,
    contactKey,
  });

  /** THIS attempt's facts, exactly as a send site computes them. */
  function factsFor(phone: string, opts: { body?: string; mediaCount?: number; sender?: string | null } = {}): SendAttemptFacts {
    const sender = opts.sender === null ? undefined : (opts.sender ?? MAIN);
    const fp = bodyFingerprint(opts.body ?? BODY);
    return {
      recipientDigest: recipientDigest(sender, phone),
      ...(sender !== undefined && { sender }),
      bodyHash: fp.hash,
      bodyShort: fp.short,
      mediaCount: opts.mediaCount ?? 0,
    };
  }

  /** Claim and hand to reconcile, as a send site does after an unknown outcome. Returns the attempt start. */
  async function reconciling(
    owner: SendAttemptOwner,
    facts: SendAttemptFacts,
    opts: { at?: string; sid?: string } = {},
  ): Promise<string> {
    const at = opts.at ?? new Date().toISOString();
    const claimed = await world.sendAttemptsRepo.claim(owner, facts, at);
    expect(claimed.outcome).toBe('claimed');
    const ref = { attemptNo: claimed.record.attemptNo, attemptedAt: claimed.record.attemptedAt };
    expect(await world.sendAttemptsRepo.handToReconcile(owner, ref, opts.sid)).toBe(true);
    return claimed.record.attemptedAt;
  }

  function payloadOf(owner: SendAttemptOwner, attemptedAt: string, checkNo = 0): SendReconcilePayload {
    return { owner: toOwnerRef(owner), attemptedAt, checkNo };
  }

  /** A message the provider holds that the app never recorded (an orphan), or any provider-side message. */
  function plant(m: Partial<FakeProviderMessage> & { providerSid: string }): FakeProviderMessage {
    const msg: FakeProviderMessage = {
      providerStatus: 'sent',
      body: BODY,
      mediaCount: 0,
      createdAt: new Date().toISOString(),
      to: T_PHONE,
      from: MAIN,
      ...m,
    };
    world.providerMessages.push(msg);
    return msg;
  }

  /** Dispatch ONE check from a real envelope; a handler throw propagates. Immediate follow-ups are drained. */
  async function runCheck(payload: SendReconcilePayload): Promise<void> {
    const envelope = await enqueue(SEND_RECONCILE_JOB, payload, { runAt: new Date(Date.now() + 600_000) });
    const index = outbound.delayed.findIndex((d) => d.envelope.jobId === envelope.jobId);
    const [item] = outbound.delayed.splice(index, 1);
    await dispatchJob(JSON.parse(JSON.stringify(item!.envelope)) as unknown);
    await outbound.settle();
  }

  /** The checks the job scheduled for itself, in order. */
  const scheduledChecks = () => outbound.delayed.filter((d) => d.envelope.jobName === SEND_RECONCILE_JOB);

  /** Run the next check the chain scheduled (the one-at-a-time idiom). */
  async function runNextCheck(): Promise<SendReconcilePayload> {
    const index = outbound.delayed.findIndex((d) => d.envelope.jobName === SEND_RECONCILE_JOB);
    expect(index).toBeGreaterThanOrEqual(0);
    const [item] = outbound.delayed.splice(index, 1);
    await dispatchJob(JSON.parse(JSON.stringify(item!.envelope)) as unknown);
    await outbound.settle();
    return item!.envelope.payload as SendReconcilePayload;
  }

  /** Run check 0 and then every check the chain schedules, to its end. */
  async function runChain(payload: SendReconcilePayload): Promise<void> {
    await runCheck(payload);
    while (scheduledChecks().length > 0) await runNextCheck();
  }

  const lines = (level: number) => capture.atLevel(level).filter((l) => l['event'] === 'send_reconcile');
  const slotOf = (key: string, broadcastId = 'bcast-1') => world.broadcasts.get(broadcastId)!.recipients[key];
  const recordOf = (owner: SendAttemptOwner) => world.sendAttemptsRepo.get(owner);

  describe('registration and the payload', () => {
    it('registers WITHOUT the run-once marker: the same envelope delivered twice runs twice and converges (D11)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      const marker = vi.spyOn(world.messagesRepo, 'putJobExecutionMarker');
      const list = vi.spyOn(world.adapter, 'listMessages');
      const envelope = await enqueue(SEND_RECONCILE_JOB, payloadOf(bOwner(t.contactId), at), {
        runAt: new Date(Date.now() + 600_000),
      });
      const index = outbound.delayed.findIndex((d) => d.envelope.jobId === envelope.jobId);
      const [item] = outbound.delayed.splice(index, 1);
      const wire = JSON.stringify(item!.envelope);
      await dispatchJob(JSON.parse(wire) as unknown);
      await dispatchJob(JSON.parse(wire) as unknown);
      expect(marker).not.toHaveBeenCalled();
      // Both deliveries looked the message up; the check was recorded once.
      expect(list).toHaveBeenCalledTimes(2);
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'reconciling', checkNo: 1 });
      // A duplicate check may schedule a second successor - "at most one extra chain" (D11).
      expect(scheduledChecks()).toHaveLength(2);
    });

    it('rejects a payload that is not a reconcile check (the owner, the attempt start, the check index)', async () => {
      register();
      const bad: unknown[] = [
        { owner: { kind: 'broadcast', broadcastId: 'b' }, attemptedAt: new Date().toISOString(), checkNo: 0 },
        { owner: { kind: 'nope', recipientKeyHash: 'k' }, attemptedAt: new Date().toISOString(), checkNo: 0 },
        { owner: { kind: 'broadcast', broadcastId: 'b', recipientKeyHash: 'k' }, attemptedAt: 'not a date', checkNo: 0 },
        { owner: { kind: 'broadcast', broadcastId: 'b', recipientKeyHash: 'k' }, attemptedAt: new Date().toISOString(), checkNo: 3 },
        { owner: { kind: 'broadcast', broadcastId: 'b', recipientKeyHash: 'k' }, attemptedAt: new Date().toISOString(), checkNo: 1.5 },
        {
          owner: { kind: 'relay_leg', relayConversationId: 'c', sourceTsMsgId: 's', recipientKeyHash: 'k' },
          attemptedAt: new Date().toISOString(),
          checkNo: 0,
          continuation: { senderNameOverride: 'x' },
        },
      ];
      for (const payload of bad) {
        await expect(runCheck(payload as SendReconcilePayload)).rejects.toThrow(/sendReconcile/);
      }
    });

    it('an owner whose recipient cannot be resolved is left for the sweeper: INFO, nothing written', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      await runCheck({ ...payloadOf(bOwner(t.contactId), at), owner: { kind: 'broadcast', broadcastId: 'bcast-1', recipientKeyHash: 'nobody' } });
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'reconciling', checkNo: 0 });
      expect(capture.atLevel(30).some((l) => String(l['msg']).includes('owner recipient not found'))).toBe(true);
      expect(scheduledChecks()).toHaveLength(0);
    });
  });

  describe('the broadcast owner', () => {
    it('1 a known SID is fetched, never listed, and adopted with the fetched status - no digest check (D13 known-SID path)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      // A digest that matches NO number: a lookup-path digest check would rule this unresolved.
      const facts = { ...factsFor(t.phone!), recipientDigest: 'd'.repeat(32) };
      const at = await reconciling(bOwner(t.contactId), facts, { sid: 'SMknown-1' });
      const sentAt = new Date().toISOString();
      plant({ providerSid: 'SMknown-1', providerStatus: 'delivered', sentAt });
      const list = vi.spyOn(world.adapter, 'listMessages');
      const get = vi.spyOn(world.adapter, 'getMessage');
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(list).not.toHaveBeenCalled();
      expect(get).toHaveBeenCalledWith('SMknown-1');
      const row = world.messages.find((m) => m.provider_sid === 'SMknown-1')!;
      expect(slotOf(t.contactId)).toEqual({
        status: 'delivered',
        conversationId: row.conversationId,
        tsMsgId: row.tsMsgId,
        carrierSentAt: sentAt,
      });
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMknown-1' });
    });

    it('2 a listed delivered orphan adopts as the send would have recorded it, and the broadcast finalizes sent', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      const sentAt = new Date().toISOString();
      const orphan = plant({ providerSid: 'SMorphan-1', providerStatus: 'delivered', sentAt });
      await runCheck(payloadOf(bOwner(t.contactId), at));
      const row = world.messages.find((m) => m.provider_sid === 'SMorphan-1')!;
      expect(row).toMatchObject({
        direction: 'outbound',
        author: 'teammate',
        body: BODY,
        broadcast_id: 'bcast-1',
        automated: true,
        recipient_contact_id: t.contactId,
        delivery_status: 'delivered',
        provider_ts: orphan.createdAt,
      });
      const conversation = world.conversations.get(row.conversationId)!;
      expect(conversation.participant_phone).toBe(t.phone);
      expect(slotOf(t.contactId)).toEqual({
        status: 'delivered',
        conversationId: row.conversationId,
        tsMsgId: row.tsMsgId,
        carrierSentAt: sentAt,
      });
      expect(world.broadcasts.get('bcast-1')!.stats).toMatchObject({ delivered: 1, queued: 0 });
      // The listing_sent milestone and the "Properties sent" row: only for a sent/delivered adoption.
      expect(world.activityEvents.filter((e) => e.type === 'listing_sent')).toHaveLength(1);
      expect(world.listingSends).toHaveLength(1);
      expect(world.auditEvents.filter((e) => e.event_type === 'message_sent')).toHaveLength(1);
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan-1' });
      // D16a: the adoption was the last open recipient, so it finalizes.
      expect(world.broadcasts.get('bcast-1')!.status).toBe('sent');
      // The emits: the derived progress tick, the 1:1 thread, the terminal broadcast emit.
      expect(world.emitted.some((e) => e.event === 'message.persisted'
        && (e.payload as { conversationId: string }).conversationId === row.conversationId)).toBe(true);
      const ticks = world.emitted.filter((e) => e.event === 'broadcast.updated');
      expect(ticks.map((e) => (e.payload as { status: string }).status)).toEqual(['sending', 'sent']);
      // T16-2: the found INFO carries the event field a self-QA greps.
      const found = lines(30).filter((l) => l['verdict'] === 'found');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ owner: { kind: 'broadcast', broadcastId: 'bcast-1' }, recipientKey: t.contactId, sid: 'SMorphan-1' });
    });

    it('2a a known SID whose row the send wrapper already recorded (the pass\'s slot write threw) repairs the slot once: no second row, no second audit row; the property-sent rows the pass never reached are written', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      // What sendMessage left behind before the pass's record-phase write threw: its row and its audit row.
      const conv = await world.conversationsRepo.createOrGetByParticipantPhone(t.phone!, 'tenant_1to1');
      const recorded = await world.messagesRepo.append({
        conversationId: conv.conversationId,
        providerSid: 'SMrec-1',
        providerTs: new Date().toISOString(),
        type: 'sms',
        direction: 'outbound',
        author: 'teammate',
        body: BODY,
        deliveryStatus: 'queued',
        broadcastId: 'bcast-1',
        automated: true,
        recipientContactId: t.contactId,
      });
      await world.auditRepo.append(`conversations#${conv.conversationId}`, 'message_sent', { providerSid: 'SMrec-1', automated: true, author: 'teammate' });
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!), { sid: 'SMrec-1' });
      plant({ providerSid: 'SMrec-1', providerStatus: 'sent', sentAt: new Date().toISOString() });
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(slotOf(t.contactId)).toMatchObject({ status: 'sent', conversationId: conv.conversationId, tsMsgId: recorded.tsMsgId });
      expect(world.messages.filter((m) => m.provider_sid === 'SMrec-1')).toHaveLength(1);
      expect(world.auditEvents.filter((e) => e.event_type === 'message_sent')).toHaveLength(1);
      expect(world.activityEvents.filter((e) => e.type === 'listing_sent')).toHaveLength(1);
      expect(world.listingSends).toHaveLength(1);
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMrec-1' });
    });

    it('2b a dashboard share adopts its row as a person\'s send (automated false)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId], { created_via: 'dashboard' });
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      plant({ providerSid: 'SMorphan-1', providerStatus: 'queued' });
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(world.messages.find((m) => m.provider_sid === 'SMorphan-1')).toMatchObject({ automated: false, delivery_status: 'queued' });
      // A provider queued/accepted/sending/sent message adopts as the success path's `sent`; no carrier clock yet.
      expect(slotOf(t.contactId)).toMatchObject({ status: 'sent' });
      expect(slotOf(t.contactId)!.carrierSentAt).toBeUndefined();
    });

    it('3 an undelivered 30005 adopts as failed with its code, flags the contact, and writes no milestone or listing-send (D15)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      plant({ providerSid: 'SMorphan-1', providerStatus: 'undelivered', errorCode: '30005' });
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(slotOf(t.contactId)).toMatchObject({ status: 'failed', errorCode: '30005' });
      expect(world.flagWrites).toEqual([{ contactId: t.contactId, flag: 'sms_unreachable', value: true }]);
      expect(world.activityEvents.filter((e) => e.type === 'listing_sent')).toHaveLength(0);
      expect(world.listingSends).toHaveLength(0);
      expect(world.messages.find((m) => m.provider_sid === 'SMorphan-1')).toMatchObject({ delivery_status: 'undelivered', error_code: '30005' });
      const warn = capture.atLevel(40).filter((l) => String(l['msg']).includes('adopted terminal failure - webhook side effects skipped'));
      expect(warn).toHaveLength(1);
      expect(warn[0]).toMatchObject({ errorCode: '30005' });
      expect(world.broadcasts.get('bcast-1')).toMatchObject({ status: 'failed', last_error: 'all recipients failed' });
    });

    it('4 an empty list at check 0 continues; the orphan listed by check 1 adopts; check 1 runs attemptedAt + 30 s (the list lag)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'reconciling', checkNo: 1 });
      const next = scheduledChecks();
      expect(next).toHaveLength(1);
      expect(next[0]!.envelope.payload).toEqual(payloadOf(bOwner(t.contactId), at, 1));
      const expected = Math.ceil(reconcileDelayMs(at, 1, Date.now()) / 1000);
      expect(Math.abs(next[0]!.delaySeconds - expected)).toBeLessThanOrEqual(1);
      expect(next[0]!.delaySeconds).toBeGreaterThan(20);
      plant({ providerSid: 'SMlate-1', providerStatus: 'sent' });
      await runNextCheck();
      expect(slotOf(t.contactId)).toMatchObject({ status: 'sent' });
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMlate-1', checkNo: 2 });
      expect(scheduledChecks()).toHaveLength(0);
    });

    it('5 a candidate held by ANOTHER owner is excluded; one whose row is THIS owner\'s is a repair (found)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      // Another share's recorded send to the same tenant, same body, in the window.
      plant({ providerSid: 'SMother-1' });
      await world.messagesRepo.append({
        conversationId: 'conv-x',
        providerSid: 'SMother-1',
        providerTs: new Date().toISOString(),
        type: 'sms',
        direction: 'outbound',
        author: 'teammate',
        body: BODY,
        deliveryStatus: 'sent',
        broadcastId: 'bcast-other',
      });
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(slotOf(t.contactId)).toEqual({ status: 'queued' });
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'reconciling', checkNo: 1 });
      // THIS owner's send was recorded after all (its row exists; the slot does not know it): a repair.
      const conv = await world.conversationsRepo.createOrGetByParticipantPhone(t.phone!, 'tenant_1to1');
      plant({ providerSid: 'SMmine-1' });
      const mine = await world.messagesRepo.append({
        conversationId: conv.conversationId,
        providerSid: 'SMmine-1',
        providerTs: new Date().toISOString(),
        type: 'sms',
        direction: 'outbound',
        author: 'teammate',
        body: BODY,
        deliveryStatus: 'queued',
        broadcastId: 'bcast-1',
        automated: true,
        recipientContactId: t.contactId,
      });
      await runNextCheck();
      expect(slotOf(t.contactId)).toMatchObject({ status: 'sent', conversationId: conv.conversationId, tsMsgId: mine.tsMsgId });
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMmine-1' });
      // The repair appended nothing: one row per SID.
      expect(world.messages.filter((m) => m.provider_sid === 'SMmine-1')).toHaveLength(1);
    });

    it('5b a candidate the syssid# system-send marker holds is excluded', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      plant({ providerSid: 'SMsys-1' });
      world.systemSidMarkers.set('SMsys-1', 'cell_verification');
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(slotOf(t.contactId)).toEqual({ status: 'queued' });
      expect(world.messages.some((m) => m.provider_sid === 'SMsys-1')).toBe(false);
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'reconciling', checkNo: 1 });
    });

    it('5c a candidate whose SID sits on a SIBLING attempt record (no pointer yet) is excluded (R2 #5)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      seedBroadcast([t.contactId], { broadcastId: 'bcast-2' });
      // The sibling: another share to the same number from the same sender, reconciling WITH a known SID.
      await reconciling(bOwner(t.contactId, 'bcast-2'), factsFor(t.phone!), { sid: 'SMsib-1' });
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      plant({ providerSid: 'SMsib-1' });
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(slotOf(t.contactId)).toEqual({ status: 'queued' });
      expect(world.messages.some((m) => m.provider_sid === 'SMsib-1')).toBe(false);
    });

    it('5d a known SID another owner holds is unresolved sid_held_elsewhere: no fetch, no send, no re-drive, ONE ERROR naming both owners', async () => {
      register();
      const redrives = recordJobs(BROADCAST_SEND_JOB);
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!), { sid: 'SMheld-1' });
      await world.messagesRepo.append({
        conversationId: 'conv-x',
        providerSid: 'SMheld-1',
        providerTs: new Date().toISOString(),
        type: 'sms',
        direction: 'outbound',
        author: 'teammate',
        body: BODY,
        deliveryStatus: 'sent',
        broadcastId: 'bcast-other',
        recipientContactId: 'c-other',
      });
      const get = vi.spyOn(world.adapter, 'getMessage');
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(get).not.toHaveBeenCalled();
      expect(slotOf(t.contactId)).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'sid_held_elsewhere' });
      expect(redrives).toHaveLength(0);
      expect(world.sent).toHaveLength(0);
      const errors = capture.atLevel(50);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        event: 'send_reconcile',
        verdict: 'unresolved',
        cause: 'sid_held_elsewhere',
        owner: { kind: 'broadcast', broadcastId: 'bcast-1' },
        recipientKey: t.contactId,
        heldBy: 'broadcast#bcast-other#c-other',
      });
    });

    it('5e two contacts on ONE phone in one share and ONE orphan: the first adopts, the second ends unresolved same_fingerprint_sibling, never re-driven (R2 #18)', async () => {
      register();
      const redrives = recordJobs(BROADCAST_SEND_JOB);
      const a = seedTenant({ phone: T_PHONE });
      const b = seedTenant({ phone: T_PHONE });
      seedBroadcast([a.contactId, b.contactId]);
      const atA = await reconciling(bOwner(a.contactId), factsFor(T_PHONE));
      const atB = await reconciling(bOwner(b.contactId), factsFor(T_PHONE));
      plant({ providerSid: 'SMone-1' });
      await runCheck(payloadOf(bOwner(a.contactId), atA));
      expect(await recordOf(bOwner(a.contactId))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMone-1' });
      expect(world.messages.find((m) => m.provider_sid === 'SMone-1')).toMatchObject({ recipient_contact_id: a.contactId });
      await runChain(payloadOf(bOwner(b.contactId), atB));
      expect(slotOf(b.contactId)).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
      expect(await recordOf(bOwner(b.contactId))).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'same_fingerprint_sibling' });
      expect(redrives).toHaveLength(0);
      expect(world.messages.filter((m) => m.provider_sid === 'SMone-1')).toHaveLength(1);
    });

    it('6 the spike\'s Smart-Encoded body matches the body submitted (curly quote, em dash, ellipsis)', async () => {
      register();
      const t = seedTenant();
      const submitted = 'It\u2019s available \u2014 tour Saturday at 10\u2026 reply YES';
      seedBroadcast([t.contactId], { body_template: submitted });
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!, { body: submitted }));
      plant({ providerSid: 'SMsmart-1', body: "It's available - tour Saturday at 10... reply YES" });
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMsmart-1' });
    });

    it('6b a media-only attempt matches an empty-bodied candidate with the same media count; a long body or another count is not ours (the fingerprint is body hash AND media for every body - FW1-3)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!, { body: '', mediaCount: 2 }));
      // A long body is never a short attempt's message, whatever its media count.
      plant({ providerSid: 'SMlong-1', body: 'You have successfully been unsubscribed.', mediaCount: 2 });
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'reconciling' });
      // A different media count is not ours either.
      plant({ providerSid: 'SMone-1', body: '', mediaCount: 1 });
      await runNextCheck();
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'reconciling' });
      plant({ providerSid: 'SMtwo-1', body: '', mediaCount: 2 });
      await runNextCheck();
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMtwo-1' });
    });

    it('6c a long body matches only on the same media count too (the fingerprint is body AND media)', async () => {
      register();
      const redrives = recordJobs(BROADCAST_SEND_JOB);
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      plant({ providerSid: 'SMmms-1', mediaCount: 1 });
      await runChain(payloadOf(bOwner(t.contactId), at));
      // Never adopted, never re-driven: an unmatched candidate at the last check is unresolved.
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'unidentified_candidate' });
      expect(redrives).toHaveLength(0);
    });

    it('9 a STOP auto-reply in the window continues at checks 0-1 and decides unresolved unidentified_candidate at check 2', async () => {
      register();
      const redrives = recordJobs(BROADCAST_SEND_JOB);
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      plant({ providerSid: 'SMstop-1', body: 'You have successfully been unsubscribed. You will not receive any more messages from this number.' });
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'reconciling', checkNo: 1 });
      await runNextCheck();
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'reconciling', checkNo: 2 });
      expect(lines(50)).toHaveLength(0);
      await runNextCheck();
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'unidentified_candidate' });
      expect(slotOf(t.contactId)).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
      expect(world.messages.some((m) => m.provider_sid === 'SMstop-1')).toBe(false);
      expect(redrives).toHaveLength(0);
      const errors = lines(50);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ verdict: 'unresolved', cause: 'unidentified_candidate', checkNo: 2 });
      // D16a: an all-unconfirmed share finalizes failed with its prose.
      expect(world.broadcasts.get('bcast-1')).toMatchObject({ status: 'failed', last_error: "Couldn't confirm any text went out" });
      expect(world.broadcasts.get('bcast-1')!.stats).toMatchObject({ unconfirmed: 1, queued: 0 });
    });

    it('10 a multi-page list is walked to its end; a walk past the 5-page bound is unresolved page_bound', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      world.listPageSize = 2;
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      const base = Date.parse(at);
      // Newest first: four newer non-matching messages (other shares' recorded sends) put the orphan on page 3.
      for (let i = 1; i <= 4; i += 1) {
        const sid = `SMnoise-${i}`;
        plant({ providerSid: sid, createdAt: new Date(base + 1000 * (i + 1)).toISOString(), body: `other share ${i}` });
        await world.messagesRepo.append({
          conversationId: 'conv-x',
          providerSid: sid,
          providerTs: new Date(base + 1000 * (i + 1)).toISOString(),
          type: 'sms',
          direction: 'outbound',
          author: 'teammate',
          deliveryStatus: 'sent',
          broadcastId: `bcast-noise-${i}`,
        });
      }
      plant({ providerSid: 'SMdeep-1', createdAt: new Date(base + 500).toISOString() });
      const list = vi.spyOn(world.adapter, 'listMessages');
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(list).toHaveBeenCalledTimes(3);
      expect(list.mock.calls.map((c) => c[0].pageToken)).toEqual([undefined, '2', '4']);
      expect(list.mock.calls.every((c) => c[0].pageSize === 1000 && c[0].to === t.phone && c[0].from === MAIN)).toBe(true);
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMdeep-1' });

      // The bound: page 5 still has a next page.
      const u = seedTenant();
      seedBroadcast([u.contactId], { broadcastId: 'bcast-2' });
      world.listPageSize = 1;
      const atU = await reconciling(bOwner(u.contactId, 'bcast-2'), factsFor(u.phone!));
      for (let i = 1; i <= 6; i += 1) plant({ providerSid: `SMmany-${i}`, to: u.phone!, body: `unrelated ${i}` });
      list.mockClear();
      await runCheck(payloadOf(bOwner(u.contactId, 'bcast-2'), atU));
      expect(list).toHaveBeenCalledTimes(5);
      expect(await recordOf(bOwner(u.contactId, 'bcast-2'))).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'page_bound' });
      expect(slotOf(u.contactId, 'bcast-2')).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
    });

    it('11 an empty window through all three checks is never_sent: ONE re-drive of that recipient; a second delivery of the verdict enqueues nothing', async () => {
      register();
      const redrives = recordJobs(BROADCAST_SEND_JOB);
      const t = seedTenant();
      seedBroadcast([t.contactId], { fanout_attempt: 2 });
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      await runCheck(payloadOf(bOwner(t.contactId), at));
      await runNextCheck();
      const last = await runNextCheck();
      expect(last.checkNo).toBe(2);
      expect(redrives).toEqual([{ broadcastId: 'bcast-1', recipientKeys: [t.contactId], attempt: 3, redrive: true } satisfies BroadcastSendPayload]);
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'redriven', redriveCount: 1 });
      // The slot is never written while reconciling: a re-driven recipient is an ordinary queued slot.
      expect(slotOf(t.contactId)).toEqual({ status: 'queued' });
      const warn = lines(40).filter((l) => l['verdict'] === 'never_sent');
      expect(warn).toHaveLength(1);
      // A redelivered verdict: the record is redriven now - nothing is marked or enqueued again.
      await runCheck(last);
      expect(redrives).toHaveLength(1);
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'redriven', redriveCount: 1 });
      expect(lines(50)).toHaveLength(0);
    });

    it('11b the re-drive runs through the real broadcast pass: it claims the redriven record and sends ONCE; the share finalizes sent (D16)', async () => {
      register();
      seedUnit();
      const config = loadConfig({
        NODE_ENV: 'test',
        MESSAGING_DRIVER: 'console',
        PUBLIC_BASE_URL: 'https://dxxxx.cloudfront.example',
        SESSION_SECRET: DEV_SESSION_SECRET_DEFAULT,
        BUSINESS_PHONE_NUMBER: MAIN,
      } as NodeJS.ProcessEnv);
      registerBroadcastSendJobHandler({
        sendAttemptsRepo: world.sendAttemptsRepo,
        config,
        broadcastsRepo: world.broadcastsRepo,
        contactsRepo: world.contactsRepo,
        conversationsRepo: world.conversationsRepo,
        messagesRepo: world.messagesRepo,
        unitsRepo: world.unitsRepo,
        sendMessageService: createSendMessageService({
          config,
          logger,
          adapter: world.adapter,
          conversationsRepo: world.conversationsRepo,
          messagesRepo: world.messagesRepo,
          contactsRepo: world.contactsRepo,
          auditRepo: world.auditRepo,
          events: world.events,
        }),
        auditRepo: world.auditRepo,
        activityEventsRepo: world.activityEventsRepo,
        listingSendsRepo: world.listingSendsRepo,
        events: world.events,
        logger,
      });
      const t = seedTenant();
      seedBroadcast([t.contactId], { fanout_attempt: 3 });
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      await runChain(payloadOf(bOwner(t.contactId), at));
      expect(world.sent.map((s) => s.to)).toEqual([t.phone]);
      expect(slotOf(t.contactId)).toMatchObject({ status: 'sent' });
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'sent', attemptNo: 2, redriveCount: 1 });
      expect(world.broadcasts.get('bcast-1')!.status).toBe('sent');
      // The re-drive pass claimed no rung: the spent ladder did not close the recipient first.
      expect(world.broadcasts.get('bcast-1')!.fanout_attempt).toBe(3);
    });

    it('12 a provider that throws on every check is unresolved provider_unreachable with exactly ONE ERROR; the provider error rides under err only', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      world.adapter.listMessages = async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      };
      await runChain(payloadOf(bOwner(t.contactId), at));
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'provider_unreachable' });
      expect(slotOf(t.contactId)).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
      const errors = capture.atLevel(50);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ event: 'send_reconcile', verdict: 'unresolved', cause: 'provider_unreachable', err: { message: 'connect ECONNREFUSED' } });
      // Checks 0 and 1 counted the error as their result: WARN, and the chain went on.
      expect(lines(40).filter((l) => l['err'] !== undefined)).toHaveLength(2);
    });

    it('13 a recipient whose number changed since the attempt is unresolved digest_mismatch, never listed, never re-sent - Review Focus 2', async () => {
      register();
      const redrives = recordJobs(BROADCAST_SEND_JOB);
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      t.phone = '+15558675309';
      const list = vi.spyOn(world.adapter, 'listMessages');
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(list).not.toHaveBeenCalled();
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'digest_mismatch' });
      expect(redrives).toHaveLength(0);
    });

    it('13a a record with no sender (an unpinned dev send) is unresolved no_sender (D12)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!, { sender: null }));
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'no_sender' });
    });

    it('13b a candidate created 59 s BEFORE the attempt is inside the window; one at 61 s is not - Review Focus 4', async () => {
      register();
      const redrives = recordJobs(BROADCAST_SEND_JOB);
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      plant({ providerSid: 'SMlead-59', createdAt: new Date(Date.parse(at) - 59_000).toISOString() });
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMlead-59' });

      const u = seedTenant();
      seedBroadcast([u.contactId], { broadcastId: 'bcast-2' });
      const atU = await reconciling(bOwner(u.contactId, 'bcast-2'), factsFor(u.phone!));
      plant({ providerSid: 'SMlead-61', to: u.phone!, createdAt: new Date(Date.parse(atU) - 61_000).toISOString() });
      await runChain(payloadOf(bOwner(u.contactId, 'bcast-2'), atU));
      // Outside the window: not a candidate at all, so not even an unidentified one.
      expect(await recordOf(bOwner(u.contactId, 'bcast-2'))).toMatchObject({ state: 'redriven' });
      expect(redrives).toHaveLength(1);
    });

    it('14 a payload for an OLDER attempt writes nothing and reads nothing from the provider (D11)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const older = new Date(Date.now() - 1000).toISOString();
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      plant({ providerSid: 'SMorphan-1' });
      const list = vi.spyOn(world.adapter, 'listMessages');
      await runCheck(payloadOf(bOwner(t.contactId), older));
      expect(list).not.toHaveBeenCalled();
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'reconciling', attemptedAt: at, checkNo: 0 });
      expect(slotOf(t.contactId)).toEqual({ status: 'queued' });
      expect(scheduledChecks()).toHaveLength(0);
      expect(capture.atLevel(30).some((l) => String(l['msg']).includes('superseded'))).toBe(true);
    });

    it('14a a check behind the recorded one is dropped: a redelivered check 0 after check 1 ran writes nothing', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      await runCheck(payloadOf(bOwner(t.contactId), at));
      await runNextCheck();
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ checkNo: 2 });
      const list = vi.spyOn(world.adapter, 'listMessages');
      await runCheck(payloadOf(bOwner(t.contactId), at, 0));
      expect(list).not.toHaveBeenCalled();
      expect(capture.atLevel(30).some((l) => String(l['msg']).includes('check already recorded'))).toBe(true);
    });

    it('14b an unresolved verdict delivered twice writes once: one slot close, one bucket bump, one ERROR', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      t.phone = '+15558675309';
      await runCheck(payloadOf(bOwner(t.contactId), at));
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(world.broadcasts.get('bcast-1')!.stats).toMatchObject({ unconfirmed: 1, queued: 0 });
      expect(lines(50)).toHaveLength(1);
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'digest_mismatch' });
    });

    it('A7 a close whose finalize never ran is finished by the next delivery of the same attempt; an older attempt\'s is not', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      // A previous run closed the slot and the record, then died before finalize.
      await world.broadcastsRepo.closeRecipientIfQueued('bcast-1', t.contactId, 'send_unconfirmed', 'unconfirmed');
      await world.sendAttemptsRepo.closeFromReconcile(bOwner(t.contactId), at, { outcome: 'unresolved', cause: 'digest_mismatch' });
      expect(world.broadcasts.get('bcast-1')!.status).toBe('sending');
      await runCheck(payloadOf(bOwner(t.contactId), new Date(Date.parse(at) - 5000).toISOString()));
      expect(world.broadcasts.get('bcast-1')!.status).toBe('sending');
      await runCheck(payloadOf(bOwner(t.contactId), at, 2));
      expect(world.broadcasts.get('bcast-1')).toMatchObject({ status: 'failed', last_error: "Couldn't confirm any text went out" });
    });

    it('15c heldBy for a broadcast owner: a row of the same share naming ANOTHER contact is someone else\'s; naming this contact it is a repair', async () => {
      register();
      const a = seedTenant({ phone: T_PHONE });
      const b = seedTenant({ phone: T_PHONE });
      seedBroadcast([a.contactId, b.contactId]);
      const conv = await world.conversationsRepo.createOrGetByParticipantPhone(T_PHONE, 'tenant_1to1');
      await world.messagesRepo.append({
        conversationId: conv.conversationId,
        providerSid: 'SMrow-a',
        providerTs: new Date().toISOString(),
        type: 'sms',
        direction: 'outbound',
        author: 'teammate',
        body: BODY,
        deliveryStatus: 'queued',
        broadcastId: 'bcast-1',
        automated: true,
        recipientContactId: a.contactId,
      });
      plant({ providerSid: 'SMrow-a', providerStatus: 'sent' });
      // b's attempt claims to know that SID: the row names a, and b's slot does not carry it.
      const atB = await reconciling(bOwner(b.contactId), factsFor(T_PHONE), { sid: 'SMrow-a' });
      await runCheck(payloadOf(bOwner(b.contactId), atB));
      expect(await recordOf(bOwner(b.contactId))).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'sid_held_elsewhere' });
      expect(lines(50)[0]).toMatchObject({ heldBy: `broadcast#bcast-1#${a.contactId}` });
      // a's own attempt with the same SID: the row names a - mine, a repair.
      const atA = await reconciling(bOwner(a.contactId), factsFor(T_PHONE), { sid: 'SMrow-a' });
      await runCheck(payloadOf(bOwner(a.contactId), atA));
      expect(await recordOf(bOwner(a.contactId))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMrow-a' });
      expect(slotOf(a.contactId)).toMatchObject({ status: 'sent', conversationId: conv.conversationId });
    });

    it('17 a re-drive enqueue that throws closes enqueue_failed (record via closeRedriven, then the slot) and finalizes', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      configureOutboundQueue({
        async enqueue(envelope, opts) {
          if (envelope.jobName === BROADCAST_SEND_JOB) throw new Error('queue down');
          return outbound.enqueue(envelope, opts);
        },
      });
      const closeRedriven = vi.spyOn(world.sendAttemptsRepo, 'closeRedriven');
      const closeSlot = vi.spyOn(world.broadcastsRepo, 'closeRecipientIfQueued');
      await runChain(payloadOf(bOwner(t.contactId), at));
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'enqueue_failed', redriveCount: 1 });
      expect(slotOf(t.contactId)).toEqual({ status: 'failed', errorCode: 'enqueue_failed' });
      expect(world.broadcasts.get('bcast-1')!.stats).toMatchObject({ failed: 1, queued: 0 });
      // T10-14: the record FIRST, the slot only after it won.
      expect(closeRedriven.mock.invocationCallOrder[0]!).toBeLessThan(closeSlot.mock.invocationCallOrder[0]!);
      expect(world.broadcasts.get('bcast-1')).toMatchObject({ status: 'failed', last_error: 'all recipients failed' });
      const errors = lines(50);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ verdict: 'never_sent', cause: 'enqueue_failed', err: { message: 'queue down' } });
    });

    it('17a a re-drive enqueue failure whose record a pass already claimed writes no slot (T10-14)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      configureOutboundQueue({
        async enqueue(envelope, opts) {
          if (envelope.jobName === BROADCAST_SEND_JOB) throw new Error('queue down');
          return outbound.enqueue(envelope, opts);
        },
      });
      vi.spyOn(world.sendAttemptsRepo, 'closeRedriven').mockResolvedValueOnce(false);
      await runChain(payloadOf(bOwner(t.contactId), at));
      expect(slotOf(t.contactId)).toEqual({ status: 'queued' });
      expect(world.broadcasts.get('bcast-1')!.status).toBe('sending');
    });

    it('17b a check enqueue that throws closes the recipient unresolved enqueue_failed', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      const envelope = await enqueue(SEND_RECONCILE_JOB, payloadOf(bOwner(t.contactId), at), {
        runAt: new Date(Date.now() + 600_000),
      });
      const [item] = outbound.delayed.splice(outbound.delayed.findIndex((d) => d.envelope.jobId === envelope.jobId), 1);
      configureOutboundQueue({
        async enqueue() {
          throw new Error('queue down');
        },
      });
      await dispatchJob(JSON.parse(JSON.stringify(item!.envelope)) as unknown);
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'enqueue_failed' });
      expect(slotOf(t.contactId)).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
      expect(world.broadcasts.get('bcast-1')!.stats).toMatchObject({ unconfirmed: 1 });
      const errors = lines(50);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ verdict: 'unresolved', cause: 'enqueue_failed', err: { message: 'queue down' } });
    });

    it('19 a known-SID fetch that throws, or finds nothing, is a job failure - a genuine retry that writes no verdict', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!), { sid: 'SMknown-1' });
      world.adapter.getMessage = async () => {
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      };
      await expect(runCheck(payloadOf(bOwner(t.contactId), at))).rejects.toThrow('socket hang up');
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'reconciling', checkNo: 1 });
      expect(slotOf(t.contactId)).toEqual({ status: 'queued' });
      world.adapter.getMessage = async () => undefined;
      await expect(runCheck(payloadOf(bOwner(t.contactId), at))).rejects.toThrow(/known SID/);
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'reconciling', checkNo: 1 });
    });

    it('20 never_sent on an attempt that was already re-driven once closes unresolved second_unknown - no second re-drive (D13a)', async () => {
      register();
      const redrives = recordJobs(BROADCAST_SEND_JOB);
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const owner = bOwner(t.contactId);
      const first = await reconciling(owner, factsFor(t.phone!), { at: new Date(Date.now() - 120_000).toISOString() });
      expect(await world.sendAttemptsRepo.markRedriven(owner, first)).toBe(true);
      // The re-drive attempt went stale and was taken over: reconciling again, redriveCount 1.
      const claimed = await world.sendAttemptsRepo.claim(owner, factsFor(t.phone!), new Date().toISOString());
      expect(claimed).toMatchObject({ outcome: 'claimed', record: { attemptNo: 2, redriveCount: 1 } });
      expect(await world.sendAttemptsRepo.takeOver(owner, claimed.record)).toBe(true);
      await runChain(payloadOf(owner, claimed.record.attemptedAt));
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'second_unknown' });
      expect(slotOf(t.contactId)).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
      expect(redrives).toHaveLength(0);
      expect(lines(50)).toHaveLength(1);
    });

    it('21 a phone-keyed recipient: the payload carries only its hash, the job resolves it, and no envelope or log line carries the phone', async () => {
      register();
      seedTenant({ phone: T_PHONE });
      const key = `phone#${T_PHONE}`;
      seedBroadcast([key]);
      const at = await reconciling(bOwner(key), factsFor(T_PHONE));
      expect(toOwnerRef(bOwner(key))).toMatchObject({ recipientKeyHash: hashRecipientKey(key) });
      await runCheck(payloadOf(bOwner(key), at));
      expect(JSON.stringify(scheduledChecks().map((d) => d.envelope))).not.toContain('phone#+');
      plant({ providerSid: 'SMorphan-1' });
      await runNextCheck();
      expect(await recordOf(bOwner(key))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan-1' });
      expect(slotOf(key)).toMatchObject({ status: 'sent' });
      expect(JSON.stringify(capture.lines)).not.toContain('phone#+');
      expect(lines(30).some((l) => l['recipientKey'] === 'phone#redacted')).toBe(true);
    });

    // ---- S3b: decisions the mutant pass found unpinned (broadcast owner) ----

    it('14c a check whose attempt record is ABSENT is superseded: INFO, no throw, nothing listed or written (D11)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const list = vi.spyOn(world.adapter, 'listMessages');
      await runCheck(payloadOf(bOwner(t.contactId), new Date().toISOString()));
      expect(list).not.toHaveBeenCalled();
      expect(await recordOf(bOwner(t.contactId))).toBeUndefined();
      expect(slotOf(t.contactId)).toEqual({ status: 'queued' });
      expect(scheduledChecks()).toHaveLength(0);
      expect(lines(30).some((l) => l['state'] === 'absent')).toBe(true);
    });

    it('14d an unresolved close that dies at its slot write is COMPLETED by the redelivery: the RECORD is closed first, and the superseded exit re-applies the slot close (FW1-4, ruling A7 extended)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const owner = bOwner(t.contactId);
      const at = await reconciling(owner, factsFor(t.phone!));
      t.phone = '+15558675309';
      vi.spyOn(world.broadcastsRepo, 'closeRecipientIfQueued').mockRejectedValueOnce(new Error('the process died at the slot write'));
      await expect(runCheck(payloadOf(owner, at))).rejects.toThrow('the process died at the slot write');
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'digest_mismatch' });
      expect(slotOf(t.contactId)).toEqual({ status: 'queued' });
      await runCheck(payloadOf(owner, at));
      expect(slotOf(t.contactId)).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
      expect(world.broadcasts.get('bcast-1')!.stats).toMatchObject({ unconfirmed: 1, queued: 0 });
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'digest_mismatch' });
      expect(world.broadcasts.get('bcast-1')!.status).toBe('failed');
      // The verdict's ERROR was logged once, by the close that won the record.
      expect(lines(50)).toHaveLength(1);
    });

    it('ADV-2 (zz-adv-3): a duplicate delivery of the last check that closes unresolved while the re-drive is mid-send writes NOTHING - its record close comes first and loses; the re-drive\'s text lands on its queued slot (FW1-4)', async () => {
      register();
      seedUnit();
      const config = loadConfig({
        NODE_ENV: 'test',
        MESSAGING_DRIVER: 'console',
        PUBLIC_BASE_URL: 'https://dxxxx.cloudfront.example',
        SESSION_SECRET: DEV_SESSION_SECRET_DEFAULT,
        BUSINESS_PHONE_NUMBER: MAIN,
      } as NodeJS.ProcessEnv);
      registerBroadcastSendJobHandler({
        sendAttemptsRepo: world.sendAttemptsRepo,
        config,
        broadcastsRepo: world.broadcastsRepo,
        contactsRepo: world.contactsRepo,
        conversationsRepo: world.conversationsRepo,
        messagesRepo: world.messagesRepo,
        unitsRepo: world.unitsRepo,
        sendMessageService: createSendMessageService({
          config,
          logger,
          adapter: world.adapter,
          conversationsRepo: world.conversationsRepo,
          messagesRepo: world.messagesRepo,
          contactsRepo: world.contactsRepo,
          auditRepo: world.auditRepo,
          events: world.events,
        }),
        auditRepo: world.auditRepo,
        activityEventsRepo: world.activityEventsRepo,
        listingSendsRepo: world.listingSendsRepo,
        events: world.events,
        logger,
      });
      const t = seedTenant();
      seedBroadcast([t.contactId], { fanout_attempt: 1 });
      const owner = bOwner(t.contactId);
      const at = await reconciling(owner, factsFor(t.phone!));
      await runCheck(payloadOf(owner, at));
      await runNextCheck();
      // The last check, delivered TWICE (an SQS duplicate). Delivery B lists first and hangs.
      const [last] = outbound.delayed.splice(outbound.delayed.findIndex((d) => d.envelope.jobName === SEND_RECONCILE_JOB), 1);
      const wire = JSON.stringify(last!.envelope);
      const realList = world.adapter.listMessages.bind(world.adapter);
      let releaseB!: (err: Error) => void;
      let bListing!: () => void;
      const bIsListing = new Promise<void>((resolve) => {
        bListing = resolve;
      });
      let listCalls = 0;
      world.adapter.listMessages = async (args) => {
        listCalls += 1;
        if (listCalls === 1) {
          bListing();
          await new Promise<never>((_resolve, reject) => {
            releaseB = reject;
          });
        }
        return realList(args);
      };
      // The re-drive's provider call hangs until released.
      const realSend = world.adapter.sendPreparedMessage.bind(world.adapter);
      let releaseSend!: () => void;
      let sendStarted!: () => void;
      const sendIsWaiting = new Promise<void>((resolve) => {
        sendStarted = resolve;
      });
      world.adapter.sendPreparedMessage = async (prepared) => {
        sendStarted();
        await new Promise<void>((resolve) => {
          releaseSend = resolve;
        });
        return realSend(prepared);
      };
      const deliveryB = dispatchJob(JSON.parse(wire) as unknown);
      await bIsListing;
      // Delivery A: never_sent - the record goes redriven and the re-drive pass claims attempt 2 and calls the provider.
      await dispatchJob(JSON.parse(wire) as unknown);
      await sendIsWaiting;
      expect(await recordOf(owner)).toMatchObject({ state: 'attempting', attemptNo: 2 });
      // B's list answers a 5xx at the last check: provider_unreachable.
      releaseB(Object.assign(new Error('Service Unavailable'), { status: 503 }));
      await deliveryB;
      expect(slotOf(t.contactId)).toEqual({ status: 'queued' });
      expect(world.broadcasts.get('bcast-1')!.status).toBe('sending');
      releaseSend();
      await outbound.settle();
      expect(world.sent.map((s) => s.to)).toEqual([t.phone]);
      expect(slotOf(t.contactId)).toMatchObject({ status: 'sent' });
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'sent', attemptNo: 2 });
      expect(world.broadcasts.get('bcast-1')!.status).toBe('sent');
      expect(lines(50)).toHaveLength(0);
    });

    it('an enqueue_failed close that dies at its slot write is COMPLETED by the redelivery: the superseded exit re-applies the enqueue_failed slot close and finalizes (FW1-4)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const owner = bOwner(t.contactId);
      const at = await reconciling(owner, factsFor(t.phone!));
      configureOutboundQueue({
        async enqueue(envelope, opts) {
          if (envelope.jobName === BROADCAST_SEND_JOB) throw new Error('queue down');
          return outbound.enqueue(envelope, opts);
        },
      });
      await runCheck(payloadOf(owner, at));
      await runNextCheck();
      const last = scheduledChecks()[0]!.envelope.payload as SendReconcilePayload;
      vi.spyOn(world.broadcastsRepo, 'closeRecipientIfQueued').mockRejectedValueOnce(new Error('the process died at the slot write'));
      await expect(runNextCheck()).rejects.toThrow('the process died at the slot write');
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'enqueue_failed' });
      expect(slotOf(t.contactId)).toEqual({ status: 'queued' });
      await runCheck(last);
      expect(slotOf(t.contactId)).toEqual({ status: 'failed', errorCode: 'enqueue_failed' });
      expect(world.broadcasts.get('bcast-1')!.stats).toMatchObject({ failed: 1, queued: 0 });
      expect(world.broadcasts.get('bcast-1')).toMatchObject({ status: 'failed', last_error: 'all recipients failed' });
      expect(lines(50)).toHaveLength(1);
    });

    it('11c a duplicate chain whose markRedriven lost to its twin closes nothing and enqueues nothing: the twin owns the one re-drive (D11, D13a)', async () => {
      register();
      const redrives = recordJobs(BROADCAST_SEND_JOB);
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const owner = bOwner(t.contactId);
      const at = await reconciling(owner, factsFor(t.phone!));
      await runCheck(payloadOf(owner, at));
      await runNextCheck();
      // The last check's snapshot reads redriveCount 0; its twin marks the record redriven first.
      const realMark = world.sendAttemptsRepo.markRedriven.bind(world.sendAttemptsRepo);
      vi.spyOn(world.sendAttemptsRepo, 'markRedriven').mockImplementationOnce(async (o, a) => {
        expect(await realMark(o, a)).toBe(true);
        return false;
      });
      await runNextCheck();
      expect(redrives).toHaveLength(0);
      expect(slotOf(t.contactId)).toEqual({ status: 'queued' });
      expect(await recordOf(owner)).toMatchObject({ state: 'redriven', redriveCount: 1 });
      expect(lines(50)).toHaveLength(0);
      expect(lines(40).filter((l) => l['verdict'] === 'never_sent')).toHaveLength(0);
    });

    it('5f a free match whose own SID claim lands on ANOTHER share\'s row is someone else\'s message: not adopted, the slot untouched, the chain goes on (D11)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const owner = bOwner(t.contactId);
      const at = await reconciling(owner, factsFor(t.phone!));
      plant({ providerSid: 'SMrace-1' });
      await world.messagesRepo.append({
        conversationId: 'conv-x',
        providerSid: 'SMrace-1',
        providerTs: new Date().toISOString(),
        type: 'sms',
        direction: 'outbound',
        author: 'teammate',
        body: BODY,
        deliveryStatus: 'sent',
        broadcastId: 'bcast-other',
      });
      // This check's holder read races the other share's append: it sees no row, so the SID looks free.
      vi.spyOn(world.messagesRepo, 'getByProviderSidConsistent').mockResolvedValueOnce(undefined);
      await runCheck(payloadOf(owner, at));
      expect(await recordOf(owner)).toMatchObject({ state: 'reconciling', checkNo: 1 });
      expect((await recordOf(owner))!.sid).toBeUndefined();
      expect(slotOf(t.contactId)).toEqual({ status: 'queued' });
      expect(scheduledChecks()).toHaveLength(1);
    });

    it('5g a slot the pass already recorded carries the row\'s tsMsgId: that row is this recipient\'s even when it names another contact (isBroadcastRowFor at both call sites)', async () => {
      register();
      const t = seedTenant({ phone: T_PHONE });
      const key = `phone#${T_PHONE}`;
      seedBroadcast([key]);
      // The send wrapper named the contact the phone key resolved to at send time; it resolves to another now.
      const conv = await world.conversationsRepo.createOrGetByParticipantPhone(T_PHONE, 'tenant_1to1');
      const row = await world.messagesRepo.append({
        conversationId: conv.conversationId,
        providerSid: 'SMkeyed-1',
        providerTs: new Date().toISOString(),
        type: 'sms',
        direction: 'outbound',
        author: 'teammate',
        body: BODY,
        deliveryStatus: 'sent',
        broadcastId: 'bcast-1',
        automated: true,
        recipientContactId: 'c-then',
      });
      expect(t.contactId).not.toBe('c-then');
      world.broadcasts.get('bcast-1')!.recipients[key] = { status: 'sent', conversationId: conv.conversationId, tsMsgId: row.tsMsgId };
      const at = await reconciling(bOwner(key), factsFor(T_PHONE), { sid: 'SMkeyed-1' });
      plant({ providerSid: 'SMkeyed-1', providerStatus: 'sent' });
      await runCheck(payloadOf(bOwner(key), at));
      expect(await recordOf(bOwner(key))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMkeyed-1' });
      expect(lines(50)).toHaveLength(0);
    });

    it('1b a known SID the system-send marker holds is unresolved sid_held_elsewhere, never fetched: a verification code is never adopted as a share\'s text (D13)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!), { sid: 'SMsys-2' });
      world.systemSidMarkers.set('SMsys-2', 'cell_verification');
      plant({ providerSid: 'SMsys-2' });
      const get = vi.spyOn(world.adapter, 'getMessage');
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(get).not.toHaveBeenCalled();
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'sid_held_elsewhere' });
      expect(world.messages.some((m) => m.provider_sid === 'SMsys-2')).toBe(false);
      expect(lines(50)[0]).toMatchObject({ heldBy: 'syssid:cell_verification' });
    });

    it('1c the recipient\'s contact is read strongly consistently: a STOP or a number change since the send is seen (D11, T10-3)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      const read = vi.spyOn(world.contactsRepo, 'getById');
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(read).toHaveBeenCalled();
      for (const call of read.mock.calls) expect(call).toEqual([t.contactId, { consistentRead: true }]);
    });

    it('3c a provider `failed` 30007 adopts as a failed slot with its code: the failed bucket, no property-sent rows, no unreachable flag (D15)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      plant({ providerSid: 'SMfail-1', providerStatus: 'failed', errorCode: '30007' });
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(slotOf(t.contactId)).toMatchObject({ status: 'failed', errorCode: '30007' });
      expect(world.broadcasts.get('bcast-1')!.stats).toMatchObject({ failed: 1, sent: 0, queued: 0 });
      expect(world.messages.find((m) => m.provider_sid === 'SMfail-1')).toMatchObject({ type: 'sms', delivery_status: 'failed', error_code: '30007' });
      expect(world.flagWrites).toEqual([]);
      expect(world.activityEvents.filter((e) => e.type === 'listing_sent')).toHaveLength(0);
      expect(world.listingSends).toHaveLength(0);
      expect(capture.atLevel(40).filter((l) => String(l['msg']).includes('adopted terminal failure'))).toHaveLength(1);
    });

    it('2c a success status carries no code: a message the provider reports sent with a stray code adopts code-free, and bumps sent out of queued (D15)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      plant({ providerSid: 'SMok-1', providerStatus: 'sent', errorCode: '30003' });
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(slotOf(t.contactId)).toMatchObject({ status: 'sent' });
      expect(slotOf(t.contactId)!.errorCode).toBeUndefined();
      expect(world.messages.find((m) => m.provider_sid === 'SMok-1')!.error_code).toBeUndefined();
      expect(world.broadcasts.get('bcast-1')!.stats).toMatchObject({ sent: 1, queued: 0 });
    });

    it('2d a unit-less share\'s adoption records the listing_sent milestone against the share and writes no listing-send row', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId], { unitId: undefined });
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      plant({ providerSid: 'SMnounit-1' });
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(world.activityEvents.filter((e) => e.type === 'listing_sent')).toEqual([
        expect.objectContaining({ contactId: t.contactId, refType: 'broadcast', refId: 'bcast-1' }),
      ]);
      expect(world.listingSends).toHaveLength(0);
    });

    it('2e the adopted row names the contact only while it holds the thread\'s number (contactHoldsPhone), exactly as the send wrapper does', async () => {
      register();
      // The number texted is the scalar one; the contact's phones[] has since moved off it.
      const t = seedTenant({ phones: [{ phone: '+15558675309', primary: true }] });
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      plant({ providerSid: 'SMnamed-1' });
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMnamed-1' });
      expect(world.messages.find((m) => m.provider_sid === 'SMnamed-1')!.recipient_contact_id).toBeUndefined();
    });

    it('2f a skipped adoption (the slot already records the send) writes none of the success path\'s follow-ups: no move, no bump, no rows, no thread emit (D15)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      // sent_unrecorded: the pass recorded its row and its slot, then its record write failed.
      const conv = await world.conversationsRepo.createOrGetByParticipantPhone(t.phone!, 'tenant_1to1');
      const row = await world.messagesRepo.append({
        conversationId: conv.conversationId,
        providerSid: 'SMdone-1',
        providerTs: new Date().toISOString(),
        type: 'sms',
        direction: 'outbound',
        author: 'teammate',
        body: BODY,
        deliveryStatus: 'sent',
        broadcastId: 'bcast-1',
        automated: true,
        recipientContactId: t.contactId,
      });
      const b = world.broadcasts.get('bcast-1')!;
      b.recipients[t.contactId] = { status: 'sent', conversationId: conv.conversationId, tsMsgId: row.tsMsgId };
      b.stats = { ...b.stats, sent: 1, queued: 0 };
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!), { sid: 'SMdone-1' });
      plant({ providerSid: 'SMdone-1', providerStatus: 'delivered', sentAt: new Date().toISOString() });
      world.emitted.length = 0;
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMdone-1' });
      expect(slotOf(t.contactId)).toEqual({ status: 'sent', conversationId: conv.conversationId, tsMsgId: row.tsMsgId });
      expect(world.broadcasts.get('bcast-1')!.stats).toMatchObject({ sent: 1, delivered: 0, queued: 0 });
      expect(world.activityEvents.filter((e) => e.type === 'listing_sent')).toHaveLength(0);
      expect(world.listingSends).toHaveLength(0);
      expect(world.emitted.filter((e) => e.event === 'message.persisted')).toHaveLength(0);
    });

    it('2g the adoption moves the inbox forward only: a newer message touches and announces the thread, an older one leaves it (T10-12)', async () => {
      register();
      const a = seedTenant();
      const b = seedTenant();
      seedBroadcast([a.contactId, b.contactId]);
      const convA = await world.conversationsRepo.createOrGetByParticipantPhone(a.phone!, 'tenant_1to1');
      const convB = await world.conversationsRepo.createOrGetByParticipantPhone(b.phone!, 'tenant_1to1');
      const later = new Date(Date.now() + 3_600_000).toISOString();
      world.conversations.get(convA.conversationId)!.last_activity_at = new Date(Date.now() - 3_600_000).toISOString();
      world.conversations.get(convB.conversationId)!.last_activity_at = later;
      const atA = await reconciling(bOwner(a.contactId), factsFor(a.phone!));
      const atB = await reconciling(bOwner(b.contactId), factsFor(b.phone!));
      const createdA = new Date().toISOString();
      plant({ providerSid: 'SMfwd-a', to: a.phone!, createdAt: createdA });
      plant({ providerSid: 'SMfwd-b', to: b.phone! });
      await runCheck(payloadOf(bOwner(a.contactId), atA));
      await runCheck(payloadOf(bOwner(b.contactId), atB));
      expect(world.conversations.get(convA.conversationId)!.last_activity_at).toBe(createdA);
      expect(world.conversations.get(convB.conversationId)!.last_activity_at).toBe(later);
      const updated = world.emitted
        .filter((e) => e.event === 'conversation.updated')
        .map((e) => (e.payload as { conversationId: string }).conversationId);
      expect(updated).toEqual([convA.conversationId]);
    });

    it('3d the adoption\'s follow-ups are best-effort: an audit row, inbox touch or unreachable flag that throws is logged and the adoption stands (D15)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const conv = await world.conversationsRepo.createOrGetByParticipantPhone(t.phone!, 'tenant_1to1');
      world.conversations.get(conv.conversationId)!.last_activity_at = new Date(Date.now() - 3_600_000).toISOString();
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      plant({ providerSid: 'SMbest-1', providerStatus: 'undelivered', errorCode: '30005' });
      vi.spyOn(world.auditRepo, 'append').mockRejectedValue(new Error('audit down'));
      vi.spyOn(world.conversationsRepo, 'touchLastActivityPreservingStatus').mockRejectedValue(new Error('touch down'));
      vi.spyOn(world.contactsRepo, 'setFlag').mockRejectedValue(new Error('flag down'));
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(slotOf(t.contactId)).toMatchObject({ status: 'failed', errorCode: '30005' });
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMbest-1' });
      const errors = capture.atLevel(50).map((l) => String(l['msg']));
      expect(errors.filter((m) => m.includes('adoption audit row failed'))).toHaveLength(1);
      expect(errors.filter((m) => m.includes('adoption inbox touch failed'))).toHaveLength(1);
      expect(errors.filter((m) => m.includes('failed to flag contact sms_unreachable'))).toHaveLength(1);
    });

    it('13c a candidate created EXACTLY 60 s before the attempt is inside the window: the lead bound is inclusive', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      plant({ providerSid: 'SMlead-60', createdAt: new Date(Date.parse(at) - 60_000).toISOString() });
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMlead-60' });
    });

    it('10b a list of exactly five pages is walked to its end: the page bound fires only when a sixth page exists', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      world.listPageSize = 1;
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      const base = Date.parse(at);
      for (let i = 1; i <= 4; i += 1) {
        const sid = `SMfive-${i}`;
        const createdAt = new Date(base + 1000 * (i + 1)).toISOString();
        plant({ providerSid: sid, createdAt, body: `other share ${i}` });
        await world.messagesRepo.append({
          conversationId: 'conv-x',
          providerSid: sid,
          providerTs: createdAt,
          type: 'sms',
          direction: 'outbound',
          author: 'teammate',
          deliveryStatus: 'sent',
          broadcastId: `bcast-five-${i}`,
        });
      }
      plant({ providerSid: 'SMfive-orphan', createdAt: new Date(base + 500).toISOString() });
      const list = vi.spyOn(world.adapter, 'listMessages');
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(list).toHaveBeenCalledTimes(5);
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMfive-orphan' });
    });

    it('12b an unresolved close of a recipient that is not the last ticks the results page with the unconfirmed bucket (D22)', async () => {
      register();
      const t = seedTenant();
      const u = seedTenant();
      seedBroadcast([t.contactId, u.contactId]);
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      t.phone = '+15558675309';
      await runCheck(payloadOf(bOwner(t.contactId), at));
      const ticks = world.emitted.filter((e) => e.event === 'broadcast.updated');
      expect(ticks).toHaveLength(1);
      expect(ticks[0]!.payload).toMatchObject({ broadcastId: 'bcast-1', status: 'sending', stats: { unconfirmed: 1, queued: 1 } });
    });
  });

  describe('the relay owners', () => {
    const CONV = 'conv-relay-1';
    const POOL = '+15550109000';
    const ALICE = '+15550100001';
    const BOB = '+15550100002';
    const CAROL = '+15550100003';
    const DAVE = '+15550100004';
    /** The COMPOSED leg copy a leg sends (the record's fingerprint is over this, never the raw body). */
    const LEG_BODY = 'Alice: is the unit still available?';
    /** The root (failed) leg a retry rung retries - the key the rung's root emit announces. */
    const ROOT = '2026-09-27T10:00:00.000Z#SMrelay-root-1';
    const CONT = { senderKey: 'c-alice' };
    const MEMBERS: ConversationParticipant[] = [
      { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
      { contactId: 'c-bob', phone: BOB, name: 'Bob' },
      { contactId: 'c-carol', phone: CAROL, name: 'Carol' },
    ];
    let rowCounter = 0;

    beforeEach(() => {
      rowCounter = 0;
    });

    afterEach(() => {
      _resetRelayRetryLegForTests();
    });

    function seedRelay(overrides: Partial<ConversationItem> = {}): ConversationItem {
      // An hour-old inbox position, so an adoption's status-preserving touch visibly moves it.
      const then = new Date(Date.now() - 3_600_000).toISOString();
      const conv: ConversationItem = {
        conversationId: CONV,
        participant_phone: POOL,
        pool_number: POOL,
        status: 'open',
        last_activity_at: then,
        type: 'relay_group',
        ai_mode: 'manual',
        participants: MEMBERS.map((m) => ({ ...m })),
        created_at: then,
        ...overrides,
      };
      world.conversations.set(CONV, conv);
      return conv;
    }

    /** An inbound relay SOURCE row (legacy unless `versioned`), its slots as given. */
    function seedSource(opts: { slots?: Record<string, RelayRecipientDelivery>; direction?: 'inbound' | 'outbound' } = {}): MessageItem {
      rowCounter += 1;
      const providerTs = new Date(Date.now() - 1000 * rowCounter).toISOString();
      const sid = `SMrelay-in-${rowCounter}`;
      const item: MessageItem = {
        conversationId: CONV,
        tsMsgId: buildTsMsgId(providerTs, sid),
        type: 'sms',
        direction: opts.direction ?? 'inbound',
        author: 'unknown',
        body: 'is the unit still available?',
        provider_sid: sid,
        provider_ts: providerTs,
        delivery_status: 'delivered',
        created_at: providerTs,
        relay_sender_key: 'c-alice',
        delivery_recipients: structuredClone(opts.slots ?? { 'c-bob': { status: 'queued' } }),
      };
      world.messages.push(item);
      return item;
    }

    /** A LEGACY 30003 retry row, as the status webhook's claim writes it, for Bob's leg of ROOT. */
    function seedRetryRow(): MessageItem {
      rowCounter += 1;
      const providerTs = new Date().toISOString();
      const providerSid = relayRetryProviderSid(relayRetryDigest(ROOT, BOB), rowCounter);
      const row: MessageItem = {
        conversationId: CONV,
        tsMsgId: buildTsMsgId(providerTs, providerSid),
        type: 'sms',
        direction: 'inbound',
        author: 'unknown',
        body: 'is the unit still available?',
        provider_sid: providerSid,
        provider_ts: providerTs,
        delivery_status: 'queued',
        created_at: providerTs,
        relay_sender_key: 'c-alice',
        delivery_recipients: { 'c-bob': { status: 'queued' } },
        relay_retry_of: ROOT,
        relay_retry_member_key: 'c-bob',
        relay_retry_attempt: 1,
        relay_retry_dest_digest: relayRetryDigest(ROOT, BOB),
        relay_retry_origin_direction: 'inbound',
        relay_retry_leg_body: LEG_BODY,
        relay_retry_window_start: new Date(Date.now() - 60_000).toISOString(),
      };
      world.messages.push(row);
      return row;
    }

    const legOwner = (source: MessageItem, memberKey = 'c-bob'): SendAttemptOwner => ({
      kind: 'relay_leg',
      relayConversationId: CONV,
      sourceTsMsgId: source.tsMsgId,
      memberKey,
    });
    const rungOwner = (row: MessageItem): SendAttemptOwner => ({
      kind: 'relay_rung',
      relayConversationId: CONV,
      retryTsMsgId: row.tsMsgId,
      memberKey: 'c-bob',
    });

    /** A leg attempt's facts, exactly as sendOneRelayLeg computes them: from the pool number, over the leg copy. */
    function legFacts(opts: { phone?: string; body?: string; mediaCount?: number } = {}): SendAttemptFacts {
      const fp = bodyFingerprint(opts.body ?? LEG_BODY);
      return {
        recipientDigest: recipientDigest(POOL, opts.phone ?? BOB),
        sender: POOL,
        bodyHash: fp.hash,
        bodyShort: fp.short,
        mediaCount: opts.mediaCount ?? 0,
      };
    }

    function legPayload(
      owner: SendAttemptOwner,
      at: string,
      checkNo = 0,
      continuation: SendReconcilePayload['continuation'] | null = CONT,
    ): SendReconcilePayload {
      return { owner: toOwnerRef(owner), attemptedAt: at, checkNo, ...(continuation !== null && { continuation }) };
    }

    const plantLeg = (providerSid: string, m: Partial<FakeProviderMessage> = {}) =>
      plant({ providerSid, body: LEG_BODY, to: BOB, from: POOL, ...m });
    const rowOf = (row: MessageItem) => world.messages.find((m) => m.tsMsgId === row.tsMsgId)!;
    const slotAt = (row: MessageItem, key = 'c-bob') => rowOf(row).delivery_recipients?.[key];
    const persisted = () => world.emitted.filter((e) => e.event === 'message.persisted').map((e) => e.payload);

    it('3 an undelivered 30005 adopts on a relay leg as undelivered with its code - no unreachable flag - and the thread is told (A1)', async () => {
      register();
      seedRelay();
      const source = seedSource();
      const owner = legOwner(source);
      const at = await reconciling(owner, legFacts());
      const sentAt = new Date().toISOString();
      plantLeg('SMleg-1', { providerStatus: 'undelivered', errorCode: '30005', sentAt });
      await runCheck(legPayload(owner, at));
      expect(slotAt(source)).toEqual({ status: 'undelivered', errorCode: '30005', sid: 'SMleg-1', sentAt });
      // An MMS leg's 30005 says nothing of SMS reachability: the relay owner records the code only (D15).
      expect(world.flagWrites).toEqual([]);
      expect(world.relaySidPointers.get('SMleg-1')).toEqual({ conversationId: CONV, tsMsgId: source.tsMsgId, memberKey: 'c-bob' });
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMleg-1' });
      expect(persisted()).toEqual([{ conversationId: CONV, tsMsgId: source.tsMsgId, direction: 'inbound', deliveryStatus: 'undelivered' }]);
      const warn = capture.atLevel(40).filter((l) => String(l['msg']).includes('adopted terminal failure - webhook side effects skipped'));
      expect(warn).toHaveLength(1);
      expect(warn[0]).toMatchObject({ errorCode: '30005', owner: { kind: 'relay_leg', relayConversationId: CONV } });
    });

    it('3b a delivered relay leg adopts forward with the provider clock and clears a stale transient code', async () => {
      register();
      seedRelay();
      const source = seedSource({ slots: { 'c-bob': { status: 'queued', errorCode: 'send_retryable' } } });
      const owner = legOwner(source);
      const at = await reconciling(owner, legFacts());
      const createdAt = new Date().toISOString();
      plantLeg('SMleg-2', { providerStatus: 'delivered', createdAt });
      await runCheck(legPayload(owner, at));
      // No date_sent: the relay slot's sentAt takes the provider's creation time.
      expect(slotAt(source)).toEqual({ status: 'delivered', sid: 'SMleg-2', sentAt: createdAt });
      expect(persisted()).toEqual([{ conversationId: CONV, tsMsgId: source.tsMsgId, direction: 'inbound', deliveryStatus: 'delivered' }]);
      expect(capture.atLevel(40).some((l) => String(l['msg']).includes('adopted terminal failure'))).toBe(false);
    });

    it('A1 every relay-leg close the job makes tells the thread, in the source row\'s direction; a close that moved nothing tells nobody', async () => {
      register();
      seedRelay();
      // A TEAM source (outbound) whose member's number no longer matches: unresolved.
      const team = seedSource({ direction: 'outbound' });
      const ownerA = legOwner(team);
      const atA = await reconciling(ownerA, legFacts({ phone: '+15550000000' }));
      await runCheck(legPayload(ownerA, atA));
      expect(slotAt(team)).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
      expect(persisted()).toEqual([{ conversationId: CONV, tsMsgId: team.tsMsgId, direction: 'outbound', deliveryStatus: 'failed' }]);
      // A slot that already holds a send is never closed, and nothing is announced.
      const landed = seedSource({ slots: { 'c-bob': { status: 'queued', sid: 'SMlanded' } } });
      const ownerB = legOwner(landed);
      const atB = await reconciling(ownerB, legFacts({ phone: '+15550000000' }));
      world.emitted.length = 0;
      await runCheck(legPayload(ownerB, atB));
      expect(slotAt(landed)).toEqual({ status: 'queued', sid: 'SMlanded' });
      expect(persisted()).toEqual([]);
      expect(await recordOf(ownerB)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'digest_mismatch' });
    });

    it('5 relay: a candidate whose relaysid pointer is THIS leg\'s is a repair (found); another source\'s pointer excludes its SID', async () => {
      register();
      seedRelay();
      const other = seedSource({ slots: { 'c-bob': { status: 'sent', sid: 'SMother' } } });
      // A late send landed its slot and pointer, but its record fence was lost (plan deviation 3).
      const source = seedSource({ slots: { 'c-bob': { status: 'queued', sid: 'SMlate' } } });
      const owner = legOwner(source);
      const at = await reconciling(owner, legFacts());
      world.relaySidPointers.set('SMother', { conversationId: CONV, tsMsgId: other.tsMsgId, memberKey: 'c-bob' });
      world.relaySidPointers.set('SMlate', { conversationId: CONV, tsMsgId: source.tsMsgId, memberKey: 'c-bob' });
      plantLeg('SMother', { createdAt: new Date(Date.parse(at) - 2000).toISOString() });
      plantLeg('SMlate', { providerStatus: 'sent' });
      await runCheck(legPayload(owner, at));
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMlate' });
      expect(slotAt(source)).toMatchObject({ status: 'sent', sid: 'SMlate' });
      expect(slotAt(other)).toEqual({ status: 'sent', sid: 'SMother' });
      expect(world.relaySidPointers.get('SMother')).toMatchObject({ tsMsgId: other.tsMsgId });
    });

    it('7 two text attempts with one body and two orphans each adopt one; the pointer claim decides a race; neither re-drives', async () => {
      register();
      const redrives = recordJobs(RELAY_FANOUT_JOB);
      seedRelay();
      const s1 = seedSource();
      const s2 = seedSource();
      const a = legOwner(s1);
      const b = legOwner(s2);
      const atA = await reconciling(a, legFacts());
      const atB = await reconciling(b, legFacts());
      const t0 = Date.now();
      plantLeg('SMo-1', { createdAt: new Date(t0 - 2000).toISOString() });
      plantLeg('SMo-2', { createdAt: new Date(t0 - 1000).toISOString() });
      await runCheck(legPayload(a, atA));
      expect(await recordOf(a)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMo-1' });
      // b's reads race a's claim: it sees neither a's record nor a's pointer on o-1,
      // so o-1 looks free and matching - and b's OWN claim says it is someone else's.
      vi.spyOn(world.sendAttemptsRepo, 'listByRecipient').mockResolvedValueOnce([]);
      vi.spyOn(world.messagesRepo, 'getRelaySidPointerConsistent').mockResolvedValueOnce(undefined);
      await runCheck(legPayload(b, atB));
      expect(await recordOf(b)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMo-2' });
      expect(world.relaySidPointers.get('SMo-1')).toMatchObject({ tsMsgId: s1.tsMsgId });
      expect(world.relaySidPointers.get('SMo-2')).toMatchObject({ tsMsgId: s2.tsMsgId });
      expect(slotAt(s1)).toMatchObject({ sid: 'SMo-1' });
      expect(slotAt(s2)).toMatchObject({ sid: 'SMo-2' });
      expect(redrives).toHaveLength(0);
    });

    it('8 two MEDIA attempts with one fingerprint and ONE orphan: one adopts, the other is unresolved same_fingerprint_sibling - never a re-drive', async () => {
      register();
      const redrives = recordJobs(RELAY_FANOUT_JOB);
      seedRelay();
      const photo = 'Alice sent a photo';
      const s1 = seedSource();
      const s2 = seedSource();
      const a = legOwner(s1);
      const b = legOwner(s2);
      const atA = await reconciling(a, legFacts({ body: photo, mediaCount: 1 }));
      const atB = await reconciling(b, legFacts({ body: photo, mediaCount: 1 }));
      plantLeg('SMphoto-1', { body: photo, mediaCount: 1 });
      await runCheck(legPayload(a, atA));
      expect(await recordOf(a)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMphoto-1' });
      await runChain(legPayload(b, atB));
      expect(await recordOf(b)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'same_fingerprint_sibling' });
      expect(slotAt(s2)).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
      expect(redrives).toHaveLength(0);
    });

    it('8b never_sent is withheld while a same-fingerprint sibling is still OPEN (reconciling)', async () => {
      register();
      const redrives = recordJobs(RELAY_FANOUT_JOB);
      seedRelay();
      const s1 = seedSource();
      const s2 = seedSource();
      await reconciling(legOwner(s1), legFacts());
      const b = legOwner(s2);
      const atB = await reconciling(b, legFacts());
      await runChain(legPayload(b, atB));
      expect(await recordOf(b)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'same_fingerprint_sibling' });
      expect(redrives).toHaveLength(0);
    });

    it('8c a sibling with a DIFFERENT fingerprint, or one that closed without adopting, does not withhold never_sent', async () => {
      register();
      const redrives = recordJobs(RELAY_FANOUT_JOB);
      seedRelay();
      const s1 = seedSource();
      const s2 = seedSource();
      const s3 = seedSource();
      await reconciling(legOwner(s1), legFacts({ body: 'Carol: a different message' }));
      const closedOwner = legOwner(s2);
      const atClosed = await reconciling(closedOwner, legFacts());
      await world.sendAttemptsRepo.closeFromReconcile(closedOwner, atClosed, { outcome: 'unresolved', cause: 'digest_mismatch' });
      const b = legOwner(s3);
      const atB = await reconciling(b, legFacts());
      await runChain(legPayload(b, atB));
      expect(await recordOf(b)).toMatchObject({ state: 'redriven', redriveCount: 1 });
      expect(redrives).toHaveLength(1);
    });

    it('13 a relay member whose phone changed since the claim is unresolved digest_mismatch - never listed, never re-sent (Review Focus 2)', async () => {
      register();
      const redrives = recordJobs(RELAY_FANOUT_JOB);
      const conv = seedRelay();
      const source = seedSource();
      const owner = legOwner(source);
      const at = await reconciling(owner, legFacts());
      conv.participants = MEMBERS.map((m) => (m.contactId === 'c-bob' ? { ...m, phone: '+15558675309' } : { ...m }));
      const list = vi.spyOn(world.adapter, 'listMessages');
      await runChain(legPayload(owner, at));
      expect(list).not.toHaveBeenCalled();
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'digest_mismatch' });
      expect(slotAt(source)).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
      expect(redrives).toHaveLength(0);
      expect(world.sent).toHaveLength(0);
    });

    it('15 relay never_sent: on a closed group redrive_refused (slot, record, the thread told, no enqueue); on an open one ONE relay.fanOut re-drive carries the continuation', async () => {
      register();
      const redrives = recordJobs(RELAY_FANOUT_JOB);
      const conv = seedRelay();
      const closedSource = seedSource();
      const ownerC = legOwner(closedSource);
      const atC = await reconciling(ownerC, legFacts());
      conv.status = 'closed';
      await runChain(legPayload(ownerC, atC));
      expect(await recordOf(ownerC)).toMatchObject({ state: 'done', outcome: 'redrive_refused', cause: 'group_not_open', redriveCount: 0 });
      expect(slotAt(closedSource)).toEqual({ status: 'failed', errorCode: 'redrive_refused' });
      expect(persisted()).toEqual([{ conversationId: CONV, tsMsgId: closedSource.tsMsgId, direction: 'inbound', deliveryStatus: 'failed' }]);
      expect(redrives).toHaveLength(0);
      expect(lines(40).filter((l) => l['verdict'] === 'never_sent' && l['cause'] === 'group_not_open')).toHaveLength(1);

      conv.status = 'open';
      const open = seedSource();
      open.fanout_attempt = 3;
      const ownerO = legOwner(open);
      const atO = await reconciling(ownerO, legFacts());
      await runChain(legPayload(ownerO, atO, 0, { senderKey: 'team', senderNameOverride: 'HousingChoice' }));
      expect(await recordOf(ownerO)).toMatchObject({ state: 'redriven', redriveCount: 1 });
      expect(redrives).toEqual([
        {
          relayConversationId: CONV,
          sourceTsMsgId: open.tsMsgId,
          senderKey: 'team',
          senderNameOverride: 'HousingChoice',
          recipientKeys: ['c-bob'],
          attempt: 4,
          redrive: true,
        } satisfies RelayFanOutPayload,
      ]);
      expect(slotAt(open)).toEqual({ status: 'queued' });
    });

    it('15a a relay-leg never_sent with no continuation, or whose phone-only member left the roster, is redrive_refused with that cause', async () => {
      register();
      const redrives = recordJobs(RELAY_FANOUT_JOB);
      seedRelay();
      const s1 = seedSource();
      const o1 = legOwner(s1);
      const at1 = await reconciling(o1, legFacts());
      await runChain(legPayload(o1, at1, 0, null));
      expect(await recordOf(o1)).toMatchObject({ state: 'done', outcome: 'redrive_refused', cause: 'no_continuation' });
      expect(slotAt(s1)).toEqual({ status: 'failed', errorCode: 'redrive_refused' });
      // A phone-only member, off the roster: its key's own number proves the digest; the re-drive has nobody to send to.
      const daveKey = `phone#${DAVE}`;
      const s2 = seedSource({ slots: { [daveKey]: { status: 'queued' } } });
      const o2 = legOwner(s2, daveKey);
      const at2 = await reconciling(o2, legFacts({ phone: DAVE }));
      await runChain(legPayload(o2, at2));
      expect(await recordOf(o2)).toMatchObject({ state: 'done', outcome: 'redrive_refused', cause: 'member_removed' });
      expect(slotAt(s2, daveKey)).toEqual({ status: 'failed', errorCode: 'redrive_refused' });
      expect(redrives).toHaveLength(0);
    });

    it('15b a relay rung\'s never_sent re-drives the SAME rung; through the real rung handler it claims from redriven (attempt 2) and sends ONCE; on a closed group redrive_refused', async () => {
      register();
      registerRelayRetryLegJobHandler({
        sendAttemptsRepo: world.sendAttemptsRepo,
        adapter: world.adapter,
        conversationsRepo: world.conversationsRepo,
        messagesRepo: world.messagesRepo,
        contactsRepo: world.contactsRepo,
        mediaStore: world.mediaStore,
        events: world.events,
        logger,
      });
      const enqueued = vi.spyOn(outbound, 'enqueue');
      const conv = seedRelay();
      const row = seedRetryRow();
      const owner = rungOwner(row);
      const at = await reconciling(owner, legFacts());
      await runChain({ owner: toOwnerRef(owner), attemptedAt: at, checkNo: 0 });
      const redrive = enqueued.mock.calls.map((c) => c[0]).filter((e) => e.jobName === RELAY_RETRY_LEG_JOB);
      expect(redrive.map((e) => e.payload)).toEqual([
        { relayConversationId: CONV, retryTsMsgId: row.tsMsgId, redrive: true } satisfies RelayRetryLegPayload,
      ]);
      expect(world.sent.map((s) => s.to)).toEqual([BOB]);
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'sent', attemptNo: 2, redriveCount: 1 });
      expect(slotAt(row)).toMatchObject({ status: 'queued', sid: world.sentDetails[0]!.sid });

      // A closed group: the re-drive is refused, and the root is announced.
      const row2 = seedRetryRow();
      const owner2 = rungOwner(row2);
      const at2 = await reconciling(owner2, legFacts());
      conv.status = 'closed';
      world.emitted.length = 0;
      await runChain({ owner: toOwnerRef(owner2), attemptedAt: at2, checkNo: 0 });
      expect(await recordOf(owner2)).toMatchObject({ state: 'done', outcome: 'redrive_refused', cause: 'group_not_open' });
      expect(slotAt(row2)).toEqual({ status: 'failed', errorCode: 'redrive_refused' });
      expect(persisted()).toEqual([{ conversationId: CONV, tsMsgId: ROOT, direction: 'inbound', deliveryStatus: 'failed' }]);
      expect(world.sent).toHaveLength(1);
    });

    it('16 a relay-rung adoption touches the inbox the status-preserving way and announces the root with the adopted status; its closes announce the root failed (T10-2)', async () => {
      register();
      seedRelay({ status: 'closed' });
      const row = seedRetryRow();
      const owner = rungOwner(row);
      // A send that landed but was not recorded: the known-SID path.
      const at = await reconciling(owner, legFacts(), { sid: 'SMrung-1' });
      const createdAt = new Date().toISOString();
      plantLeg('SMrung-1', { providerStatus: 'delivered', createdAt, sentAt: createdAt });
      await runCheck({ owner: toOwnerRef(owner), attemptedAt: at, checkNo: 0 });
      expect(slotAt(row)).toEqual({ status: 'delivered', sid: 'SMrung-1', sentAt: createdAt });
      // The status-preserving touch: the closed group stays closed, the inbox moves forward.
      expect(world.conversations.get(CONV)).toMatchObject({ status: 'closed', last_activity_at: createdAt });
      expect(persisted()).toEqual([{ conversationId: CONV, tsMsgId: ROOT, direction: 'inbound', deliveryStatus: 'delivered' }]);
      // Never backwards: an older adoption leaves the inbox where it is.
      const row2 = seedRetryRow();
      const owner2 = rungOwner(row2);
      const at2 = await reconciling(owner2, legFacts(), { sid: 'SMrung-2' });
      plantLeg('SMrung-2', { providerStatus: 'sent', createdAt: new Date(Date.parse(createdAt) - 5000).toISOString() });
      await runCheck({ owner: toOwnerRef(owner2), attemptedAt: at2, checkNo: 0 });
      expect(world.conversations.get(CONV)!.last_activity_at).toBe(createdAt);

      // A rung close (unresolved) announces the root failed.
      const row3 = seedRetryRow();
      const owner3 = rungOwner(row3);
      const at3 = await reconciling(owner3, legFacts({ phone: '+15550000000' }));
      world.emitted.length = 0;
      await runCheck({ owner: toOwnerRef(owner3), attemptedAt: at3, checkNo: 0 });
      expect(await recordOf(owner3)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'digest_mismatch' });
      expect(slotAt(row3)).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
      expect(persisted()).toEqual([{ conversationId: CONV, tsMsgId: ROOT, direction: 'inbound', deliveryStatus: 'failed' }]);
    });

    it('16b a rung found whose slot a receipt already advanced moves nothing and announces the slot\'s REAL status, not the stale provider one', async () => {
      register();
      seedRelay();
      const row = seedRetryRow();
      const owner = rungOwner(row);
      const at = await reconciling(owner, legFacts(), { sid: 'SMrung-9' });
      rowOf(row).delivery_recipients = { 'c-bob': { status: 'delivered', sid: 'SMrung-9', sentAt: at } };
      plantLeg('SMrung-9', { providerStatus: 'sent' });
      await runCheck({ owner: toOwnerRef(owner), attemptedAt: at, checkNo: 0 });
      expect(slotAt(row)).toEqual({ status: 'delivered', sid: 'SMrung-9', sentAt: at });
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMrung-9' });
      expect(persisted()).toEqual([{ conversationId: CONV, tsMsgId: ROOT, direction: 'inbound', deliveryStatus: 'delivered' }]);
      expect(lines(30).filter((l) => l['verdict'] === 'found')[0]).toMatchObject({ adoption: 'skipped' });
    });

    it('17 a relay re-drive enqueue that throws closes enqueue_failed: the record FIRST, then the slot, then the thread or the root is told', async () => {
      register();
      seedRelay();
      configureOutboundQueue({
        async enqueue(envelope, opts) {
          if (envelope.jobName === RELAY_FANOUT_JOB || envelope.jobName === RELAY_RETRY_LEG_JOB) throw new Error('queue down');
          return outbound.enqueue(envelope, opts);
        },
      });
      const closeRedriven = vi.spyOn(world.sendAttemptsRepo, 'closeRedriven');
      const closeSlot = vi.spyOn(world.messagesRepo, 'closeRelayRecipientIfUnsent');
      const source = seedSource();
      const leg = legOwner(source);
      const atLeg = await reconciling(leg, legFacts());
      await runChain(legPayload(leg, atLeg));
      expect(await recordOf(leg)).toMatchObject({ state: 'done', outcome: 'enqueue_failed', redriveCount: 1 });
      expect(slotAt(source)).toEqual({ status: 'failed', errorCode: 'enqueue_failed' });
      expect(closeRedriven.mock.invocationCallOrder[0]!).toBeLessThan(closeSlot.mock.invocationCallOrder[0]!);
      expect(persisted()).toEqual([{ conversationId: CONV, tsMsgId: source.tsMsgId, direction: 'inbound', deliveryStatus: 'failed' }]);

      const row = seedRetryRow();
      const rung = rungOwner(row);
      const atRung = await reconciling(rung, legFacts());
      world.emitted.length = 0;
      await runChain({ owner: toOwnerRef(rung), attemptedAt: atRung, checkNo: 0 });
      expect(await recordOf(rung)).toMatchObject({ state: 'done', outcome: 'enqueue_failed' });
      expect(slotAt(row)).toEqual({ status: 'failed', errorCode: 'enqueue_failed' });
      expect(persisted()).toEqual([{ conversationId: CONV, tsMsgId: ROOT, direction: 'inbound', deliveryStatus: 'failed' }]);
    });

    it('21 a phone-only member: the reconcile payload carries only the hashed key, the job resolves it, and no reconcile envelope or log line carries the phone', async () => {
      register();
      const daveKey = `phone#${DAVE}`;
      seedRelay({ participants: [...MEMBERS.map((m) => ({ ...m })), { contactId: '', phone: DAVE }] });
      const source = seedSource({ slots: { [daveKey]: { status: 'queued' } } });
      const owner = legOwner(source, daveKey);
      const at = await reconciling(owner, legFacts({ phone: DAVE }));
      await runCheck(legPayload(owner, at));
      expect(JSON.stringify(scheduledChecks().map((d) => d.envelope))).not.toContain('phone#+');
      plantLeg('SMdave-1', { to: DAVE });
      await runNextCheck();
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMdave-1' });
      expect(world.relaySidPointers.get('SMdave-1')).toMatchObject({ memberKey: daveKey });
      expect(slotAt(source, daveKey)).toMatchObject({ sid: 'SMdave-1' });
      expect(JSON.stringify(capture.lines)).not.toContain('phone#+');
      expect(lines(30).some((l) => l['recipientKey'] === 'phone#redacted' && l['verdict'] === 'found')).toBe(true);
    });

    // ---- S3b: decisions the mutant pass found unpinned (relay owners) ----

    it('1d a legacy source that holds no slot for the member yet (its best-effort attempt clock never landed) resolves the member from the roster and adopts, seeding the slot (D12)', async () => {
      register();
      seedRelay();
      const source = seedSource({ slots: {} });
      const owner = legOwner(source);
      const at = await reconciling(owner, legFacts());
      plantLeg('SMseed-1', { providerStatus: 'sent' });
      await runCheck(legPayload(owner, at));
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMseed-1' });
      expect(slotAt(source)).toMatchObject({ status: 'sent', sid: 'SMseed-1' });
    });

    it('3f a provider `failed` 30007 adopts on a relay leg as failed with its code and the provider\'s date_sent (not its creation) as sentAt, and WARNs (D15)', async () => {
      register();
      seedRelay();
      const source = seedSource();
      const owner = legOwner(source);
      const at = await reconciling(owner, legFacts());
      const createdAt = new Date(Date.now() - 2000).toISOString();
      const sentAt = new Date(Date.now() - 1000).toISOString();
      plantLeg('SMleg-f', { providerStatus: 'failed', errorCode: '30007', createdAt, sentAt });
      await runCheck(legPayload(owner, at));
      expect(slotAt(source)).toEqual({ status: 'failed', errorCode: '30007', sid: 'SMleg-f', sentAt });
      expect(world.flagWrites).toEqual([]);
      const warn = capture.atLevel(40).filter((l) => String(l['msg']).includes('adopted terminal failure - webhook side effects skipped'));
      expect(warn).toHaveLength(1);
      expect(warn[0]).toMatchObject({ errorCode: '30007' });
    });

    it('3g a relay leg\'s success status carries no code: a stray provider code on a delivered message is never written to the slot (D15)', async () => {
      register();
      seedRelay();
      const source = seedSource();
      const owner = legOwner(source);
      const at = await reconciling(owner, legFacts());
      plantLeg('SMleg-ok', { providerStatus: 'delivered', errorCode: '30003' });
      await runCheck(legPayload(owner, at));
      expect(slotAt(source)).toMatchObject({ status: 'delivered', sid: 'SMleg-ok' });
      expect(slotAt(source)!.errorCode).toBeUndefined();
    });

    it('3h a relay-leg adoption a receipt already advanced moves nothing and tells nobody: no stale status reaches the thread, no WARN (A1)', async () => {
      register();
      seedRelay();
      const source = seedSource();
      const owner = legOwner(source);
      const at = await reconciling(owner, legFacts(), { sid: 'SMleg-r' });
      rowOf(source).delivery_recipients = { 'c-bob': { status: 'delivered', sid: 'SMleg-r', sentAt: at } };
      plantLeg('SMleg-r', { providerStatus: 'sent' });
      await runCheck(legPayload(owner, at));
      expect(slotAt(source)).toEqual({ status: 'delivered', sid: 'SMleg-r', sentAt: at });
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMleg-r' });
      expect(persisted()).toEqual([]);
    });

    it('5h relay: a candidate whose SID has a message ROW but no relaysid pointer (a pool announcement to the member) is someone else\'s - never adopted, whatever its body', async () => {
      register();
      const redrives = recordJobs(RELAY_FANOUT_JOB);
      seedRelay();
      const source = seedSource();
      const owner = legOwner(source);
      const at = await reconciling(owner, legFacts());
      const intro = 'Hey Bob! It is Sam. Welcome to the group.';
      plantLeg('SMintro-1', { body: intro });
      await world.messagesRepo.append({
        conversationId: CONV,
        providerSid: 'SMintro-1',
        providerTs: new Date().toISOString(),
        type: 'sms',
        direction: 'outbound',
        author: 'teammate',
        body: intro,
        deliveryStatus: 'sent',
      });
      await runChain(legPayload(owner, at));
      expect(world.relaySidPointers.has('SMintro-1')).toBe(false);
      expect(slotAt(source)!.sid).toBeUndefined();
      expect(await recordOf(owner)).toMatchObject({ state: 'redriven', redriveCount: 1 });
      expect(redrives).toHaveLength(1);
    });

    it('5i relay: a relaysid pointer naming the same row and member in ANOTHER conversation is someone else\'s, not a repair', async () => {
      register();
      seedRelay();
      const source = seedSource();
      const owner = legOwner(source);
      const at = await reconciling(owner, legFacts());
      world.relaySidPointers.set('SMconv-x', { conversationId: 'conv-relay-other', tsMsgId: source.tsMsgId, memberKey: 'c-bob' });
      plantLeg('SMconv-x', { createdAt: new Date(Date.parse(at) - 2000).toISOString() });
      plantLeg('SMconv-mine');
      await runCheck(legPayload(owner, at));
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMconv-mine' });
    });

    it('5j relay: a known SID whose pointer names ANOTHER member of the same row is held elsewhere - never fetched - and the ERROR names that member redacted (D13, D18)', async () => {
      register();
      const daveKey = `phone#${DAVE}`;
      seedRelay({ participants: [...MEMBERS.map((m) => ({ ...m })), { contactId: '', phone: DAVE }] });
      const source = seedSource({ slots: { 'c-bob': { status: 'queued' }, [daveKey]: { status: 'sent', sid: 'SMdave-2' } } });
      world.relaySidPointers.set('SMdave-2', { conversationId: CONV, tsMsgId: source.tsMsgId, memberKey: daveKey });
      const owner = legOwner(source);
      const at = await reconciling(owner, legFacts(), { sid: 'SMdave-2' });
      const get = vi.spyOn(world.adapter, 'getMessage');
      await runCheck(legPayload(owner, at));
      expect(get).not.toHaveBeenCalled();
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'sid_held_elsewhere' });
      expect(lines(50)[0]).toMatchObject({ heldBy: `relay#${CONV}#${source.tsMsgId}#phone#redacted` });
      expect(JSON.stringify(capture.lines)).not.toContain('phone#+');
    });

    it('5k relay: a candidate this leg\'s pointer already holds is a repair even when its stored body does not match (THIS owner needs no fingerprint - D13)', async () => {
      register();
      seedRelay();
      const source = seedSource();
      const owner = legOwner(source);
      const at = await reconciling(owner, legFacts());
      world.relaySidPointers.set('SMmine-2', { conversationId: CONV, tsMsgId: source.tsMsgId, memberKey: 'c-bob' });
      plantLeg('SMmine-2', { body: 'a body the provider stored differently' });
      await runCheck(legPayload(owner, at));
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMmine-2' });
      expect(slotAt(source)).toMatchObject({ sid: 'SMmine-2' });
    });

    it('5l relay: a candidate held by THIS leg whose own claim then reports another owner is unresolved sid_held_elsewhere - never passed over toward a re-send', async () => {
      register();
      seedRelay();
      const source = seedSource();
      const owner = legOwner(source);
      const at = await reconciling(owner, legFacts());
      world.relaySidPointers.set('SMlost-1', { conversationId: CONV, tsMsgId: source.tsMsgId, memberKey: 'c-bob' });
      plantLeg('SMlost-1');
      vi.spyOn(world.messagesRepo, 'claimRelaySidPointer').mockResolvedValueOnce('other');
      await runCheck(legPayload(owner, at));
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'sid_held_elsewhere' });
      expect(slotAt(source)).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
      expect(scheduledChecks()).toHaveLength(0);
    });

    it('5m relay known SID: an adoption whose own pointer claim is lost to another leg closes unresolved sid_held_elsewhere naming it - never left open (D13)', async () => {
      register();
      seedRelay();
      const other = seedSource({ slots: { 'c-bob': { status: 'sent', sid: 'SMk-1' } } });
      const source = seedSource();
      const owner = legOwner(source);
      const at = await reconciling(owner, legFacts(), { sid: 'SMk-1' });
      world.relaySidPointers.set('SMk-1', { conversationId: CONV, tsMsgId: other.tsMsgId, memberKey: 'c-bob' });
      plantLeg('SMk-1');
      // The holder read races the other leg's pointer write: it sees nothing; the claim then finds it.
      vi.spyOn(world.messagesRepo, 'getRelaySidPointerConsistent').mockResolvedValueOnce(undefined);
      await runCheck(legPayload(owner, at));
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'sid_held_elsewhere' });
      expect(lines(50)[0]).toMatchObject({ heldBy: `relay#${CONV}#${other.tsMsgId}#c-bob` });
      expect(slotAt(source)).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
    });

    it('8d a same-body sibling with a DIFFERENT media count does not withhold never_sent (the fingerprint is body AND media)', async () => {
      register();
      const redrives = recordJobs(RELAY_FANOUT_JOB);
      seedRelay();
      const s1 = seedSource();
      const s2 = seedSource();
      await reconciling(legOwner(s1), legFacts({ mediaCount: 1 }));
      const b = legOwner(s2);
      const atB = await reconciling(b, legFacts());
      await runChain(legPayload(b, atB));
      expect(await recordOf(b)).toMatchObject({ state: 'redriven', redriveCount: 1 });
      expect(redrives).toHaveLength(1);
    });

    it('8e a short-bodied open sibling does not withhold never_sent from a long-bodied attempt: it could never have claimed that message (the mirror of the match rule)', async () => {
      register();
      const redrives = recordJobs(RELAY_FANOUT_JOB);
      seedRelay();
      const s1 = seedSource();
      const s2 = seedSource();
      await reconciling(legOwner(s1), legFacts({ body: 'ok' }));
      const b = legOwner(s2);
      const atB = await reconciling(b, legFacts());
      await runChain(legPayload(b, atB));
      expect(await recordOf(b)).toMatchObject({ state: 'redriven', redriveCount: 1 });
      expect(redrives).toHaveLength(1);
    });

    it('8f never_sent is withheld while a same-fingerprint sibling is still mid-send (attempting), not only while it reconciles (D13)', async () => {
      register();
      const redrives = recordJobs(RELAY_FANOUT_JOB);
      seedRelay();
      const s1 = seedSource();
      const s2 = seedSource();
      expect((await world.sendAttemptsRepo.claim(legOwner(s1), legFacts(), new Date().toISOString())).outcome).toBe('claimed');
      const b = legOwner(s2);
      const atB = await reconciling(b, legFacts());
      await runChain(legPayload(b, atB));
      expect(await recordOf(b)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'same_fingerprint_sibling' });
      expect(redrives).toHaveLength(0);
    });

    // ---- FW1-3 (S3b F-2): the fingerprint is the body hash AND the media count, for every body ----

    it('F-2: two short-named members\' media-only legs to one recipient never adopt each other - the body hash decides for every body (FW1-3)', async () => {
      register();
      const redrives = recordJobs(RELAY_FANOUT_JOB);
      seedRelay();
      const sAl = seedSource();
      const sJo = seedSource();
      const al = legOwner(sAl);
      const jo = legOwner(sJo);
      // composeRelayBody('Al', '') and ('Jo', ''): both normalize under three characters.
      expect(bodyFingerprint('Al: ').short && bodyFingerprint('Jo: ').short).toBe(true);
      const atAl = await reconciling(al, legFacts({ body: 'Al: ', mediaCount: 1 }));
      const atJo = await reconciling(jo, legFacts({ body: 'Jo: ', mediaCount: 1 }));
      plantLeg('SMjo-photo', { body: 'Jo: ', mediaCount: 1 });
      await runChain(legPayload(al, atAl));
      // Jo's photo is not Al's message: an unmatched candidate, unresolved at the last check - never adopted, never re-driven.
      expect(await recordOf(al)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'unidentified_candidate' });
      await runChain(legPayload(jo, atJo));
      expect(await recordOf(jo)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMjo-photo' });
      expect(world.relaySidPointers.get('SMjo-photo')).toMatchObject({ tsMsgId: sJo.tsMsgId });
      expect(redrives).toHaveLength(0);
    });

    it('F-2 mirror: an open short-bodied sibling with ANOTHER short body does not withhold never_sent; one with the same body does (FW1-3)', async () => {
      register();
      const redrives = recordJobs(RELAY_FANOUT_JOB);
      seedRelay();
      await reconciling(legOwner(seedSource()), legFacts({ body: 'Jo: ', mediaCount: 1 }));
      const al = legOwner(seedSource());
      const atAl = await reconciling(al, legFacts({ body: 'Al: ', mediaCount: 1 }));
      await runChain(legPayload(al, atAl));
      expect(await recordOf(al)).toMatchObject({ state: 'redriven' });
      expect(redrives).toHaveLength(1);
      const twin = legOwner(seedSource());
      await reconciling(twin, legFacts({ body: 'Al: ', mediaCount: 1 }));
      const al2 = legOwner(seedSource());
      const atAl2 = await reconciling(al2, legFacts({ body: 'Al: ', mediaCount: 1 }));
      await runChain(legPayload(al2, atAl2));
      expect(await recordOf(al2)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'same_fingerprint_sibling' });
    });

    it('the STOP auto-reply still never matches: an emoji-only text with no media is not adopted onto it (FW1-3 guard)', async () => {
      register();
      const redrives = recordJobs(RELAY_FANOUT_JOB);
      seedRelay();
      const owner = legOwner(seedSource());
      // A short-named member's emoji: 'Al: ' plus a thumbs-up normalizes to 'Al' - a short body with no media.
      expect(bodyFingerprint('Al: \u{1F44D}').short).toBe(true);
      const at = await reconciling(owner, legFacts({ body: 'Al: \u{1F44D}', mediaCount: 0 }));
      plantLeg('SMstop-2', { body: 'You have successfully been unsubscribed. You will not receive any more messages from this number.' });
      await runChain(legPayload(owner, at));
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'unidentified_candidate' });
      expect(world.relaySidPointers.has('SMstop-2')).toBe(false);
      expect(redrives).toHaveLength(0);
    });

    // ---- FW1-2 (code review C-1, S3b F-1): the two-sided window and the sibling span ----

    /** S3b F-1: S claims at t0; O, the same fingerprint, claims `gapMs` later and its message lands, unrecorded. */
    async function laterSibling(gapMs: number): Promise<{ S: SendAttemptOwner; O: SendAttemptOwner; sS: MessageItem; atS: string; atO: string }> {
      const photo = 'Alice sent a photo';
      const sS = seedSource();
      const sO = seedSource();
      const S = legOwner(sS);
      const O = legOwner(sO);
      const t0 = Date.now() - 900_000;
      const atS = await reconciling(S, legFacts({ body: photo, mediaCount: 1 }), { at: new Date(t0).toISOString() });
      const atO = await reconciling(O, legFacts({ body: photo, mediaCount: 1 }), { at: new Date(t0 + gapMs).toISOString() });
      plantLeg('SMo-photo', { body: photo, mediaCount: 1, createdAt: new Date(t0 + gapMs + 1_000).toISOString() });
      return { S, O, sS, atS, atO };
    }

    it('F-1: O claims 238 s after S with the same fingerprint - S cannot adopt O\'s message (outside S\'s window); O adopts it; S is re-driven (FW1-2, C-1)', async () => {
      register();
      const redrives = recordJobs(RELAY_FANOUT_JOB);
      seedRelay();
      const { S, O, sS, atS, atO } = await laterSibling(238_000);
      await runChain(legPayload(S, atS));
      expect(await recordOf(S)).toMatchObject({ state: 'redriven', redriveCount: 1 });
      expect(world.relaySidPointers.has('SMo-photo')).toBe(false);
      await runChain(legPayload(O, atO));
      expect(await recordOf(O)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMo-photo' });
      // One re-drive, S's: O's photo goes once, S's is sent again.
      expect(redrives).toHaveLength(1);
      expect(redrives[0]).toMatchObject({ sourceTsMsgId: sS.tsMsgId, recipientKeys: ['c-bob'] });
    });

    it('C-1 late-S variant: however late S\'s final check runs, it never adopts a message created after its window - O\'s, ten minutes on (FW1-2)', async () => {
      register();
      const redrives = recordJobs(RELAY_FANOUT_JOB);
      seedRelay();
      const { S, O, atS, atO } = await laterSibling(600_000);
      await runChain(legPayload(S, atS));
      expect(await recordOf(S)).toMatchObject({ state: 'redriven' });
      await runChain(legPayload(O, atO));
      expect(await recordOf(O)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMo-photo' });
      expect(redrives).toHaveLength(1);
    });

    it('the window\'s upper edge is inclusive: a message created EXACTLY attemptedAt + TTL + LEAD is a candidate; one millisecond later is not (FW1-2)', async () => {
      expect(RECONCILE_WINDOW_TRAIL_MS).toBe(SEND_CLAIM_TTL_MS + RECONCILE_WINDOW_LEAD_MS);
      expect(RECONCILE_SIBLING_SPAN_MS).toBe(2 * RECONCILE_WINDOW_LEAD_MS + SEND_CLAIM_TTL_MS);
      register();
      const redrives = recordJobs(RELAY_FANOUT_JOB);
      seedRelay();
      const s1 = seedSource();
      const a = legOwner(s1);
      const t0 = Date.now() - 900_000;
      const atA = await reconciling(a, legFacts(), { at: new Date(t0).toISOString() });
      plantLeg('SMedge-in', { createdAt: new Date(t0 + RECONCILE_WINDOW_TRAIL_MS).toISOString() });
      await runCheck(legPayload(a, atA));
      expect(await recordOf(a)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMedge-in' });

      const s2 = seedSource();
      const b = legOwner(s2);
      const t1 = t0 - 3_600_000;
      const atB = await reconciling(b, legFacts(), { at: new Date(t1).toISOString() });
      plantLeg('SMedge-out', { createdAt: new Date(t1 + RECONCILE_WINDOW_TRAIL_MS + 1).toISOString() });
      await runChain(legPayload(b, atB));
      // Outside the window: not a candidate at all, so not even an unidentified one.
      expect(await recordOf(b)).toMatchObject({ state: 'redriven' });
      expect(redrives).toHaveLength(1);
    });

    it('the sibling span is two-sided and inclusive: an open same-fingerprint attempt EXACTLY SPAN before or after withholds never_sent; one millisecond beyond either edge does not (FW1-2)', async () => {
      register();
      const redrives = recordJobs(RELAY_FANOUT_JOB);
      seedRelay();
      const cases: Array<{ offset: number; withheld: boolean }> = [
        { offset: -RECONCILE_SIBLING_SPAN_MS, withheld: true },
        { offset: RECONCILE_SIBLING_SPAN_MS, withheld: true },
        { offset: -RECONCILE_SIBLING_SPAN_MS - 1, withheld: false },
        { offset: RECONCILE_SIBLING_SPAN_MS + 1, withheld: false },
      ];
      for (const [i, { offset, withheld }] of cases.entries()) {
        // Each pair far from the others (an hour apart), so no two cases see each other.
        const t = Date.now() - 36_000_000 + i * 3_600_000;
        const sib = legOwner(seedSource());
        await reconciling(sib, legFacts(), { at: new Date(t + offset).toISOString() });
        const self = legOwner(seedSource());
        const at = await reconciling(self, legFacts(), { at: new Date(t).toISOString() });
        await runChain(legPayload(self, at));
        expect(await recordOf(self), `offset ${offset}`).toMatchObject(
          withheld ? { state: 'done', outcome: 'unresolved', cause: 'same_fingerprint_sibling' } : { state: 'redriven' },
        );
      }
      expect(redrives).toHaveLength(2);
    });

    it('14e relay: a redrive_refused close that dies at its slot write is COMPLETED by the redelivery - the RECORD first, then the superseded exit re-applies the slot close and tells the thread (FW1-4)', async () => {
      register();
      const conv = seedRelay();
      const source = seedSource();
      const owner = legOwner(source);
      const at = await reconciling(owner, legFacts());
      conv.status = 'closed';
      await runCheck(legPayload(owner, at));
      await runNextCheck();
      const last = scheduledChecks()[0]!.envelope.payload as SendReconcilePayload;
      vi.spyOn(world.messagesRepo, 'closeRelayRecipientIfUnsent').mockRejectedValueOnce(new Error('the process died at the slot write'));
      await expect(runNextCheck()).rejects.toThrow('the process died at the slot write');
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'redrive_refused', cause: 'group_not_open' });
      expect(slotAt(source)).toEqual({ status: 'queued' });
      world.emitted.length = 0;
      await runCheck(last);
      expect(slotAt(source)).toEqual({ status: 'failed', errorCode: 'redrive_refused' });
      expect(persisted()).toEqual([{ conversationId: CONV, tsMsgId: source.tsMsgId, direction: 'inbound', deliveryStatus: 'failed' }]);
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'redrive_refused', cause: 'group_not_open' });
    });

    it('ADV-2 relay twin: a duplicate last check that rules redrive_refused from a stale roster read AFTER its twin re-drove the leg writes nothing - the record close comes first and loses (FW1-4)', async () => {
      register();
      const redrives = recordJobs(RELAY_FANOUT_JOB);
      const conv = seedRelay();
      const source = seedSource();
      const owner = legOwner(source);
      const at = await reconciling(owner, legFacts());
      await runCheck(legPayload(owner, at));
      await runNextCheck();
      const [last] = outbound.delayed.splice(outbound.delayed.findIndex((d) => d.envelope.jobName === SEND_RECONCILE_JOB), 1);
      const wire = JSON.stringify(last!.envelope);
      // Delivery B reads the group from a lagging replica (closed) and hangs in its list call.
      vi.spyOn(world.conversationsRepo, 'getById').mockResolvedValueOnce({ ...conv, status: 'closed' });
      const realList = world.adapter.listMessages.bind(world.adapter);
      let releaseB!: () => void;
      let bListing!: () => void;
      const bIsListing = new Promise<void>((resolve) => {
        bListing = resolve;
      });
      let listCalls = 0;
      world.adapter.listMessages = async (args) => {
        listCalls += 1;
        if (listCalls === 1) {
          bListing();
          await new Promise<void>((resolve) => {
            releaseB = resolve;
          });
        }
        return realList(args);
      };
      const deliveryB = dispatchJob(JSON.parse(wire) as unknown);
      await bIsListing;
      // Delivery A: the group is open - never_sent, the record goes redriven, ONE re-drive.
      await dispatchJob(JSON.parse(wire) as unknown);
      await outbound.settle();
      expect(redrives).toHaveLength(1);
      expect(await recordOf(owner)).toMatchObject({ state: 'redriven' });
      world.emitted.length = 0;
      releaseB();
      await deliveryB;
      // B's stale read refuses the re-drive, but the record is no longer this chain's: nothing is closed.
      expect(slotAt(source)).toEqual({ status: 'queued' });
      expect(await recordOf(owner)).toMatchObject({ state: 'redriven' });
      expect(persisted()).toEqual([]);
      expect(lines(40).filter((l) => l['cause'] === 'group_not_open')).toHaveLength(0);
    });

    it('15d a relay never_sent whose source row is gone is refused (source_not_found); a rung\'s whose retry row is gone (retry_row_not_found) announces nothing and throws nothing', async () => {
      register();
      const redrives = recordJobs(RELAY_FANOUT_JOB);
      const rungRedrives = recordJobs(RELAY_RETRY_LEG_JOB);
      seedRelay();
      const leg: SendAttemptOwner = { kind: 'relay_leg', relayConversationId: CONV, sourceTsMsgId: '2026-09-27T09:00:00.000Z#SMgone-src', memberKey: 'c-bob' };
      const atLeg = await reconciling(leg, legFacts());
      await runChain(legPayload(leg, atLeg));
      expect(await recordOf(leg)).toMatchObject({ state: 'done', outcome: 'redrive_refused', cause: 'source_not_found' });
      const rung: SendAttemptOwner = { kind: 'relay_rung', relayConversationId: CONV, retryTsMsgId: '2026-09-27T09:00:01.000Z#SMgone-rung', memberKey: 'c-bob' };
      const atRung = await reconciling(rung, legFacts());
      world.emitted.length = 0;
      await runChain({ owner: toOwnerRef(rung), attemptedAt: atRung, checkNo: 0 });
      expect(await recordOf(rung)).toMatchObject({ state: 'done', outcome: 'redrive_refused', cause: 'retry_row_not_found' });
      expect(persisted()).toEqual([]);
      expect(redrives).toHaveLength(0);
      expect(rungRedrives).toHaveLength(0);
    });

    it('19b a relay known-SID adoption whose source row is gone throws - a genuine retry - and closes nothing (the slot to adopt onto is missing)', async () => {
      register();
      seedRelay();
      const leg: SendAttemptOwner = { kind: 'relay_leg', relayConversationId: CONV, sourceTsMsgId: '2026-09-27T09:00:00.000Z#SMgone-src2', memberKey: 'c-bob' };
      const at = await reconciling(leg, legFacts(), { sid: 'SMgone-1' });
      plantLeg('SMgone-1');
      await expect(runCheck(legPayload(leg, at))).rejects.toThrow(/missing/);
      expect(await recordOf(leg)).toMatchObject({ state: 'reconciling', checkNo: 1 });
    });

    it('16c a rung adoption survives a failed inbox touch: the touch is best-effort, the adoption stands (D15)', async () => {
      register();
      seedRelay();
      const row = seedRetryRow();
      const owner = rungOwner(row);
      const at = await reconciling(owner, legFacts(), { sid: 'SMrung-t' });
      plantLeg('SMrung-t', { providerStatus: 'sent' });
      vi.spyOn(world.conversationsRepo, 'touchLastActivityPreservingStatus').mockRejectedValueOnce(new Error('touch down'));
      await runCheck({ owner: toOwnerRef(owner), attemptedAt: at, checkNo: 0 });
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMrung-t' });
      expect(capture.atLevel(50).filter((l) => String(l['msg']).includes('inbox touch after a rung adoption failed'))).toHaveLength(1);
    });

    it('16d a rung whose retry row mirrors a TEAM original (outbound) announces its root in that direction (A1, T10-2)', async () => {
      register();
      seedRelay();
      const row = seedRetryRow();
      row.direction = 'outbound';
      const owner = rungOwner(row);
      const at = await reconciling(owner, legFacts(), { sid: 'SMrung-o' });
      plantLeg('SMrung-o', { providerStatus: 'delivered' });
      await runCheck({ owner: toOwnerRef(owner), attemptedAt: at, checkNo: 0 });
      expect(persisted()).toEqual([{ conversationId: CONV, tsMsgId: ROOT, direction: 'outbound', deliveryStatus: 'delivered' }]);
    });
  });

  describe('the payload, the owner reference and the row owner test', () => {
    it('the parser refuses every other malformed field: empty or missing ids, a null payload, owner or continuation, a non-string attemptedAt, a negative check index', () => {
      const at = new Date().toISOString();
      const bad: unknown[] = [
        null,
        { owner: null, attemptedAt: at, checkNo: 0 },
        { owner: { kind: 'broadcast', broadcastId: '', recipientKeyHash: 'k' }, attemptedAt: at, checkNo: 0 },
        { owner: { kind: 'broadcast', recipientKeyHash: 'k' }, attemptedAt: at, checkNo: 0 },
        { owner: { kind: 'broadcast', broadcastId: 'b', recipientKeyHash: '' }, attemptedAt: at, checkNo: 0 },
        { owner: { kind: 'relay_leg', sourceTsMsgId: 's', recipientKeyHash: 'k' }, attemptedAt: at, checkNo: 0 },
        { owner: { kind: 'relay_leg', relayConversationId: 'c', recipientKeyHash: 'k' }, attemptedAt: at, checkNo: 0 },
        { owner: { kind: 'relay_rung', retryTsMsgId: 'r', recipientKeyHash: 'k' }, attemptedAt: at, checkNo: 0 },
        { owner: { kind: 'relay_rung', relayConversationId: 'c', recipientKeyHash: 'k' }, attemptedAt: at, checkNo: 0 },
        { owner: { kind: 'broadcast', broadcastId: 'b', recipientKeyHash: 'k' }, attemptedAt: 12345, checkNo: 0 },
        { owner: { kind: 'broadcast', broadcastId: 'b', recipientKeyHash: 'k' }, attemptedAt: at, checkNo: -1 },
        { owner: { kind: 'broadcast', broadcastId: 'b', recipientKeyHash: 'k' }, attemptedAt: at, checkNo: 0, continuation: null },
      ];
      for (const payload of bad) {
        expect(() => parseSendReconcilePayload(payload), JSON.stringify(payload)).toThrow(/^sendReconcile: /);
      }
    });

    it('toOwnerRef hashes a phone-bearing key for EVERY owner kind: no reconcile payload ever carries a phone (D12, D18)', () => {
      const key = 'phone#+15550100009';
      const owners: SendAttemptOwner[] = [
        { kind: 'broadcast', broadcastId: 'b', contactKey: key },
        { kind: 'relay_leg', relayConversationId: 'c', sourceTsMsgId: 's', memberKey: key },
        { kind: 'relay_rung', relayConversationId: 'c', retryTsMsgId: 'r', memberKey: key },
      ];
      for (const owner of owners) {
        const ref = toOwnerRef(owner);
        expect(ref.recipientKeyHash).toBe(hashRecipientKey(key));
        expect(JSON.stringify(ref)).not.toContain('phone#+');
      }
    });

    it('isBroadcastRowFor: a row of THIS share is this recipient\'s when it names no contact, names this contact, or is the row this recipient\'s slot carries - never another share\'s (R2 #18)', () => {
      const owner = { broadcastId: 'b1', contactId: 'c-me', slotTsMsgId: 'ts-mine' };
      expect(isBroadcastRowFor({ broadcast_id: 'b2', tsMsgId: 'ts-mine' }, owner)).toBe(false);
      expect(isBroadcastRowFor({ broadcast_id: 'b1', tsMsgId: 'ts-x' }, owner)).toBe(true);
      expect(isBroadcastRowFor({ broadcast_id: 'b1', recipient_contact_id: 'c-me', tsMsgId: 'ts-x' }, owner)).toBe(true);
      expect(isBroadcastRowFor({ broadcast_id: 'b1', recipient_contact_id: 'c-other', tsMsgId: 'ts-mine' }, owner)).toBe(true);
      expect(isBroadcastRowFor({ broadcast_id: 'b1', recipient_contact_id: 'c-other', tsMsgId: 'ts-x' }, owner)).toBe(false);
      expect(isBroadcastRowFor({ broadcast_id: 'b1', recipient_contact_id: 'c-other', tsMsgId: 'ts-x' }, { ...owner, slotTsMsgId: undefined })).toBe(false);
    });
  });

  describe('the lane seam (D13a)', () => {
    it('18 E2E_SEND_RECONCILE_DELAYS_MS overrides the check delays only when no real queue is configured; reconcileDelayMs reads it', () => {
      vi.stubEnv('JOBS_QUEUE_URL', '');
      vi.stubEnv('E2E_SEND_RECONCILE_DELAYS_MS', '100, 200,300');
      expect(reconcileCheckDelaysMs()).toEqual([100, 200, 300]);
      const at = '2026-09-27T12:00:00.000Z';
      expect(reconcileDelayMs(at, 1, Date.parse(at) + 50)).toBe(150);
      expect(reconcileDelayMs(at, 0, Date.parse(at) + 5000)).toBe(0);
      vi.stubEnv('E2E_SEND_RECONCILE_DELAYS_MS', '1,2');
      expect(reconcileCheckDelaysMs()).toEqual(RECONCILE_CHECK_DELAYS_MS);
      vi.stubEnv('E2E_SEND_RECONCILE_DELAYS_MS', '1,-2,3');
      expect(reconcileCheckDelaysMs()).toEqual(RECONCILE_CHECK_DELAYS_MS);
      vi.stubEnv('E2E_SEND_RECONCILE_DELAYS_MS', '100,200,300');
      vi.stubEnv('JOBS_QUEUE_URL', 'https://sqs.us-east-2.amazonaws.com/1/jobs');
      expect(reconcileCheckDelaysMs()).toEqual(RECONCILE_CHECK_DELAYS_MS);
      expect(reconcileDelayMs(at, 1, Date.parse(at))).toBe(30_000);
    });
  });
});
