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
import type { ListMessagesPage, ProviderMessageSummary } from '../src/adapters/messaging.js';
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
import { RETRY_SEND_JOB } from '../src/jobs/retrySend.js';
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
  type RetrySendOwner,
  type SendReconcilePayload,
} from '../src/jobs/sendReconcile.js';
import { DEV_SESSION_SECRET_DEFAULT, loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { relayRetryDigest, relayRetryProviderSid } from '../src/lib/relayRetryClaim.js';
import {
  MAX_SEND_RETRY_ATTEMPTS,
  RETRY_JOB_GRACE_MS,
  RETRY_PROMISE_GRACE_MS,
  RETRY_PROMISE_WITHDRAWN_AT,
} from '../src/lib/retrySendWindow.js';
import { bodyFingerprint, hashRecipientKey, recipientDigest } from '../src/lib/sendFingerprint.js';
import {
  RECONCILE_CHECK_DELAYS_MS,
  RECONCILE_SIBLING_SPAN_MS,
  RECONCILE_WINDOW_LEAD_MS,
  RECONCILE_WINDOW_TRAIL_MS,
  SEND_CLAIM_TTL_MS,
  SEND_UNCONFIRMED_CODE,
} from '../src/lib/sendOutcome.js';
import { rowlessAttemptKey } from '../src/lib/shareAttemptOrder.js';
import type { BroadcastItem, BroadcastRecipient } from '../src/repos/broadcastsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { ConversationItem, ConversationParticipant } from '../src/repos/conversationsRepo.js';
import { buildTsMsgId, type MessageItem, type NewMessage, type RelayRecipientDelivery } from '../src/repos/messagesRepo.js';
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
      // share-sent-outcome D6/D7: the milestone names the share; a DELIVERED
      // adoption counts the entry by delivery at the adopted row's instant.
      expect(world.activityEvents.find((e) => e.type === 'listing_sent')).toMatchObject({ broadcastId: 'bcast-1' });
      const adoptedInstant = new Date(Date.parse(row.tsMsgId.slice(0, row.tsMsgId.indexOf('#')))).toISOString();
      expect(world.listingSends[0]).toMatchObject({ counted: true, broadcastId: 'bcast-1', sentAt: adoptedInstant });
      expect(world.listingSends[0]?.shares?.['bcast-1']).toEqual({ attempt: row.tsMsgId, conversationId: row.conversationId, state: 'counted', by: 'delivery', countedAt: adoptedInstant });
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
      // share-sent-outcome D7: a SENT adoption counts the entry by acceptance, for the recorded row.
      expect(world.listingSends[0]?.shares?.['bcast-1']).toMatchObject({ attempt: recorded.tsMsgId, conversationId: conv.conversationId, state: 'counted', by: 'acceptance' });
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

      // The bound: page 5 still has a next page, and every page is inside the window (no early stop).
      // FW1-6: a cut walk CONTINUES at checks 0 and 1; only the last check closes it page_bound. (FW4-1: it judges
      // what it read first - nothing here is ours; the adopting twins are the FW4-1 tests below.)
      const u = seedTenant();
      seedBroadcast([u.contactId], { broadcastId: 'bcast-2' });
      world.listPageSize = 1;
      const atU = await reconciling(bOwner(u.contactId, 'bcast-2'), factsFor(u.phone!));
      for (let i = 1; i <= 6; i += 1) plant({ providerSid: `SMmany-${i}`, to: u.phone!, body: `unrelated ${i}` });
      list.mockClear();
      await runCheck(payloadOf(bOwner(u.contactId, 'bcast-2'), atU));
      expect(list).toHaveBeenCalledTimes(5);
      expect(await recordOf(bOwner(u.contactId, 'bcast-2'))).toMatchObject({ state: 'reconciling', checkNo: 1 });
      expect(slotOf(u.contactId, 'bcast-2')).toEqual({ status: 'queued' });
      expect(lines(30).filter((l) => l['verdict'] === 'continue' && l['reason'] === 'page_bound')).toHaveLength(1);
      while (scheduledChecks().length > 0) await runNextCheck();
      expect(list).toHaveBeenCalledTimes(15);
      expect(await recordOf(bOwner(u.contactId, 'bcast-2'))).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'page_bound' });
      expect(slotOf(u.contactId, 'bcast-2')).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
    });

    it('ADV-4 (zz-adv-4): heavy OLD history does not bury an orphan on page 1 - the walk stops at the window\'s edge and adopts at check 0 (FW1-6)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      world.listPageSize = 2;
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      const base = Date.parse(at);
      // Twelve recorded sends from an hour ago and more (newest-first behind the orphan).
      for (let i = 1; i <= 12; i += 1) {
        plant({ providerSid: `SMold-${i}`, createdAt: new Date(base - 3_600_000 - 1000 * i).toISOString(), body: `old share ${i}` });
      }
      plant({ providerSid: 'SMorphan-1', createdAt: new Date(base + 1_000).toISOString() });
      const list = vi.spyOn(world.adapter, 'listMessages');
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(list).toHaveBeenCalledTimes(1);
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan-1', checkNo: 1 });
      expect(slotOf(t.contactId)).toMatchObject({ status: 'sent' });
    });

    it('equal creation instants (the provider\'s one-second resolution) are still newest-first: a page of ties behind the window ends the walk (FW1-6)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      world.listPageSize = 2;
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      const base = Date.parse(at);
      const inWindow = new Date(base + 1_000).toISOString();
      const oldTie = new Date(base - 3_600_000).toISOString();
      plant({ providerSid: 'SMorphan-t', createdAt: inWindow });
      plant({ providerSid: 'SMtie-new', createdAt: inWindow, body: 'other share' });
      plant({ providerSid: 'SMtie-old1', createdAt: oldTie, body: 'old share 1' });
      plant({ providerSid: 'SMtie-old2', createdAt: oldTie, body: 'old share 2' });
      for (let i = 3; i <= 8; i += 1) {
        plant({ providerSid: `SMtie-old${i}`, createdAt: new Date(base - 3_600_000 - 1000 * i).toISOString(), body: `old share ${i}` });
      }
      const list = vi.spyOn(world.adapter, 'listMessages');
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(list).toHaveBeenCalledTimes(2);
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan-t' });
    });

    it('a page that ends EXACTLY at the window start does not stop the walk: the next page may hold a message of the same instant (FW1-6)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      world.listPageSize = 1;
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      const edge = new Date(Date.parse(at) - RECONCILE_WINDOW_LEAD_MS).toISOString();
      // Same instant; the later plant is listed first: page 1 = the stranger, page 2 = the orphan.
      plant({ providerSid: 'SMedge-orphan', createdAt: edge });
      plant({ providerSid: 'SMedge-other', createdAt: edge, body: 'other share' });
      const list = vi.spyOn(world.adapter, 'listMessages');
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(list).toHaveBeenCalledTimes(2);
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMedge-orphan' });
    });

    it('the early stop wins over the bound: a fifth page that reaches behind the window ends the walk without page_bound, even with a next page pending (FW1-6)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      world.listPageSize = 1;
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!));
      const base = Date.parse(at);
      for (let i = 1; i <= 3; i += 1) {
        plant({ providerSid: `SMnew-${i}`, createdAt: new Date(base + 10_000 * i).toISOString(), body: `other share ${i}` });
      }
      plant({ providerSid: 'SMorphan-5', createdAt: new Date(base + 1_000).toISOString() });
      for (let i = 1; i <= 3; i += 1) {
        plant({ providerSid: `SMold-${i}`, createdAt: new Date(base - 3_600_000 - 1000 * i).toISOString(), body: `old share ${i}` });
      }
      const list = vi.spyOn(world.adapter, 'listMessages');
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(list).toHaveBeenCalledTimes(5);
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan-5' });

      // Restated for FW4-1: a cut walk now judges what it read too, so the adoption above no longer tells the
      // stop from the bound - the continue reason does. The same shape with nothing of ours: check 0 reads five
      // pages and continues nothing_adoptable (the stop ended the walk), never page_bound.
      const u = seedTenant();
      seedBroadcast([u.contactId], { broadcastId: 'bcast-2' });
      const atU = await reconciling(bOwner(u.contactId, 'bcast-2'), factsFor(u.phone!));
      const baseU = Date.parse(atU);
      for (let i = 1; i <= 4; i += 1) {
        plant({ providerSid: `SMnewU-${i}`, to: u.phone!, createdAt: new Date(baseU + 10_000 * i).toISOString(), body: `other share ${i}` });
      }
      for (let i = 1; i <= 3; i += 1) {
        plant({ providerSid: `SMoldU-${i}`, to: u.phone!, createdAt: new Date(baseU - 3_600_000 - 1000 * i).toISOString(), body: `old share ${i}` });
      }
      list.mockClear();
      await runCheck(payloadOf(bOwner(u.contactId, 'bcast-2'), atU));
      expect(list).toHaveBeenCalledTimes(5);
      expect(await recordOf(bOwner(u.contactId, 'bcast-2'))).toMatchObject({ state: 'reconciling', checkNo: 1 });
      expect(lines(30).filter((l) => l['verdict'] === 'continue').map((l) => l['reason'])).toEqual(['nothing_adoptable']);
    });

    it('a list whose order is NOT monotonic walks on as today - within a page, and across pages - so an orphan behind it is still found (FW1-6)', async () => {
      register();
      const old = -3_600_000;
      /** One recipient whose provider list is `pages` (scripted), and its check 0. */
      async function walk(broadcastId: string, build: (msg: (sid: string, offsetMs: number, body?: string) => ProviderMessageSummary) => ListMessagesPage[]) {
        const t = seedTenant();
        seedBroadcast([t.contactId], { broadcastId });
        const at = await reconciling(bOwner(t.contactId, broadcastId), factsFor(t.phone!));
        const base = Date.parse(at);
        const pages = build((providerSid, offsetMs, body = 'other share') => ({
          providerSid,
          providerStatus: 'sent',
          body,
          mediaCount: 0,
          createdAt: new Date(base + offsetMs).toISOString(),
        }));
        const calls: (string | undefined)[] = [];
        world.adapter.listMessages = async (args) => {
          calls.push(args.pageToken);
          return pages[Number(args.pageToken ?? 0)]!;
        };
        await runCheck(payloadOf(bOwner(t.contactId, broadcastId), at));
        return { calls, record: await recordOf(bOwner(t.contactId, broadcastId)) };
      }
      // Within a page: page 1 rises, then falls behind the window - its last message is old, but the page is not newest-first.
      const within = await walk('bcast-1', (msg) => [
        { messages: [msg('SMa-new1', 20_000), msg('SMa-new2', 40_000), msg('SMa-old', old)], nextPageToken: '1' },
        { messages: [msg('SMorphan-a', 1_000, BODY)] },
      ]);
      expect(within.calls).toEqual([undefined, '1']);
      expect(within.record).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan-a' });
      // Across pages: page 2 is newest-first inside itself and reaches behind the window, but opens NEWER than page 1 ended.
      const across = await walk('bcast-2', (msg) => [
        { messages: [msg('SMb-new1', 20_000)], nextPageToken: '1' },
        { messages: [msg('SMb-new2', 30_000), msg('SMb-old', old)], nextPageToken: '2' },
        { messages: [msg('SMorphan-b', 1_000, BODY)] },
      ]);
      expect(across.calls).toEqual([undefined, '1', '2']);
      expect(across.record).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan-b' });
    });

    // --- code review round 2, R2C-1 / F-1 (FW4-1): the early stop proves
    // nothing about a page it has not read. A list that passes the order check
    // while sorted on ANOTHER key (Twilio documents DateSent; a still-queued
    // message has none and may sort last) can hold our orphan on a later page.
    // So the stop only defers (checks 0-1); the LAST check walks on to the
    // list's end or the bound, and never_sent needs that COMPLETE walk.

    /** Script the provider's list as `pages` (the page token is the page index); returns the tokens asked for. */
    function scriptList(pages: ListMessagesPage[]): (string | undefined)[] {
      const calls: (string | undefined)[] = [];
      world.adapter.listMessages = async (args) => {
        calls.push(args.pageToken);
        return pages[Number(args.pageToken ?? 0)]!;
      };
      return calls;
    }

    /** A provider message created `offsetMs` from `base` (another share's text unless `body` says otherwise). */
    const listed = (base: number, providerSid: string, offsetMs: number, body = 'other share'): ProviderMessageSummary => ({
      providerSid,
      providerStatus: 'sent',
      body,
      mediaCount: 0,
      createdAt: new Date(base + offsetMs).toISOString(),
    });

    it('R2C-1 / F-1: page 1 newest-first and wholly older than the window, our orphan on page 2 - checks 0-1 stop early and continue; the LAST check walks on, reads page 2 and adopts: found, no re-drive (FW4-1)', async () => {
      register();
      const redrives = recordJobs(BROADCAST_SEND_JOB);
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const owner = bOwner(t.contactId);
      const at = await reconciling(owner, factsFor(t.phone!));
      const base = Date.parse(at);
      // Page 1 passes the order check; the orphan, still queued at the provider (no date_sent), sorts onto page 2.
      const calls = scriptList([
        { messages: [listed(base, 'SMold-1', -3_600_000), listed(base, 'SMold-2', -3_601_000)], nextPageToken: '1' },
        { messages: [{ ...listed(base, 'SMorphan-q', 1_000, BODY), providerStatus: 'queued' }] },
      ]);
      await runCheck(payloadOf(owner, at));
      await runNextCheck();
      // Checks 0 and 1 read page 1 alone: the stop defers, nothing is decided.
      expect(calls).toEqual([undefined, undefined]);
      expect(await recordOf(owner)).toMatchObject({ state: 'reconciling', checkNo: 2 });
      expect(lines(30).filter((l) => l['verdict'] === 'continue' && l['reason'] === 'nothing_adoptable')).toHaveLength(2);
      const last = await runNextCheck();
      expect(last.checkNo).toBe(2);
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan-q' });
      expect(redrives).toHaveLength(0);
      expect(calls).toEqual([undefined, undefined, undefined, '1']);
      expect(slotOf(t.contactId)).toMatchObject({ status: 'sent' });
      expect(lines(40).filter((l) => l['verdict'] === 'never_sent')).toHaveLength(0);
    });

    it('FW4-1: the orphan BEYOND the page bound at the last check - the walk goes on to the bound and closes unresolved page_bound: never never_sent, never a re-drive', async () => {
      register();
      const redrives = recordJobs(BROADCAST_SEND_JOB);
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const owner = bOwner(t.contactId);
      const at = await reconciling(owner, factsFor(t.phone!));
      const base = Date.parse(at);
      // Five pages, each newest-first and wholly older than the window, each with a next page; the orphan is on page 6.
      const pages: ListMessagesPage[] = [];
      for (let p = 0; p < 5; p += 1) {
        pages.push({ messages: [listed(base, `SMold-${p}`, -3_600_000 - 1_000 * p)], nextPageToken: String(p + 1) });
      }
      pages.push({ messages: [listed(base, 'SMorphan-far', 1_000, BODY)] });
      const calls = scriptList(pages);
      await runCheck(payloadOf(owner, at));
      await runNextCheck();
      expect(calls).toEqual([undefined, undefined]);
      await runNextCheck();
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'page_bound' });
      expect(redrives).toHaveLength(0);
      expect(calls).toEqual([undefined, undefined, undefined, '1', '2', '3', '4']);
      expect(slotOf(t.contactId)).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
      const errors = lines(50);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ verdict: 'unresolved', cause: 'page_bound', pages: 5, checkNo: 2 });
    });

    it('FW4-1: a CUT walk (a list longer than the bound) judges what it read - an orphan on page 1 is adopted at check 0, not deferred to a page_bound close', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      world.listPageSize = 1;
      const owner = bOwner(t.contactId);
      const at = await reconciling(owner, factsFor(t.phone!));
      const base = Date.parse(at);
      // Seven pages, every message inside the window (no early stop): the orphan is the newest, on page 1.
      for (let i = 1; i <= 6; i += 1) {
        plant({ providerSid: `SMin-${i}`, createdAt: new Date(base + 1_000 * i).toISOString(), body: `other share ${i}` });
      }
      plant({ providerSid: 'SMorphan-cut', createdAt: new Date(base + 10_000).toISOString() });
      const list = vi.spyOn(world.adapter, 'listMessages');
      await runCheck(payloadOf(owner, at));
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan-cut', checkNo: 1 });
      expect(list).toHaveBeenCalledTimes(5);
      expect(slotOf(t.contactId)).toMatchObject({ status: 'sent' });
      expect(scheduledChecks()).toHaveLength(0);
    });

    it('FW4-1: a cut walk at the LAST check still judges what it read - an orphan the list shows only by then (on page 1 of a list longer than the bound) is adopted, not closed page_bound', async () => {
      register();
      const redrives = recordJobs(BROADCAST_SEND_JOB);
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      world.listPageSize = 1;
      const owner = bOwner(t.contactId);
      const at = await reconciling(owner, factsFor(t.phone!));
      const base = Date.parse(at);
      for (let i = 1; i <= 6; i += 1) {
        plant({ providerSid: `SMin-${i}`, createdAt: new Date(base + 1_000 * i).toISOString(), body: `other share ${i}` });
      }
      await runCheck(payloadOf(owner, at));
      await runNextCheck();
      // Checks 0 and 1: cut at the bound with nothing adoptable - they continue page_bound.
      expect(await recordOf(owner)).toMatchObject({ state: 'reconciling', checkNo: 2 });
      expect(lines(30).filter((l) => l['verdict'] === 'continue' && l['reason'] === 'page_bound')).toHaveLength(2);
      // The provider lists the orphan by the last check (list lag): the newest, on page 1.
      plant({ providerSid: 'SMorphan-late', createdAt: new Date(base + 10_000).toISOString() });
      await runNextCheck();
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan-late', checkNo: 3 });
      expect(redrives).toHaveLength(0);
      expect(slotOf(t.contactId)).toMatchObject({ status: 'sent' });
      expect(lines(50)).toHaveLength(0);
    });

    it('FW4-1: a COMPLETE walk at the last check reads past the early stop to the list\'s end: nothing in the window is never_sent (ONE re-drive); an unmatched candidate it reaches there is unidentified_candidate, ahead of an open same-fingerprint sibling', async () => {
      register();
      const redrives = recordJobs(BROADCAST_SEND_JOB);
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const owner = bOwner(t.contactId);
      const at = await reconciling(owner, factsFor(t.phone!));
      const base = Date.parse(at);
      // Three pages, newest-first, every message an hour and more before the window; no next page after page 3.
      const calls = scriptList([
        { messages: [listed(base, 'SMold-1', -3_600_000)], nextPageToken: '1' },
        { messages: [listed(base, 'SMold-2', -3_700_000)], nextPageToken: '2' },
        { messages: [listed(base, 'SMold-3', -3_800_000)] },
      ]);
      await runCheck(payloadOf(owner, at));
      await runNextCheck();
      await runNextCheck();
      expect(calls).toEqual([undefined, undefined, undefined, '1', '2']);
      expect(await recordOf(owner)).toMatchObject({ state: 'redriven', redriveCount: 1 });
      expect(redrives).toEqual([{ broadcastId: 'bcast-1', recipientKeys: [t.contactId], attempt: 1, redrive: true } satisfies BroadcastSendPayload]);

      // The same walk with a STOP auto-reply in the window sorted onto page 3: the complete walk sees it - unresolved, never re-driven.
      const u = seedTenant();
      seedBroadcast([u.contactId], { broadcastId: 'bcast-2' });
      const ownerU = bOwner(u.contactId, 'bcast-2');
      const atU = await reconciling(ownerU, factsFor(u.phone!));
      const baseU = Date.parse(atU);
      const callsU = scriptList([
        { messages: [listed(baseU, 'SMoldU-1', -3_600_000)], nextPageToken: '1' },
        { messages: [listed(baseU, 'SMoldU-2', -3_700_000)], nextPageToken: '2' },
        { messages: [listed(baseU, 'SMstopU', 2_000, 'You have successfully been unsubscribed.')] },
      ]);
      // Rule (d): the causes keep their order - beside an OPEN same-fingerprint sibling (another share's
      // attempt to this number, mid-send) the unmatched candidate still decides.
      expect((await world.sendAttemptsRepo.claim(bOwner(u.contactId, 'bcast-3'), factsFor(u.phone!), new Date().toISOString())).outcome).toBe('claimed');
      await runCheck(payloadOf(ownerU, atU));
      await runNextCheck();
      await runNextCheck();
      expect(await recordOf(ownerU)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'unidentified_candidate' });
      expect(redrives).toHaveLength(1);
      expect(callsU).toEqual([undefined, undefined, undefined, '1', '2']);
    });

    // --- code review round 3, NEW-1 (FW5-1): a failed list call ends the walk
    // but no longer discards what was read - FW4-1's "judge what was read",
    // applied to a list error as well as to the bound. An adoptable candidate
    // already read is adopted; when nothing is, the error is the check's
    // verdict (continue provider_error; unresolved provider_unreachable at the
    // last check) ahead of every other cause, so a walk that met a list error
    // never rules never_sent. A page-1 failure reads nothing and keeps
    // today's verdicts: test 12 pins them at every check.

    /** Script the provider's list call by call: a page answers, an Error throws. Returns the tokens asked for. */
    function scriptCalls(answers: (ListMessagesPage | Error)[]): (string | undefined)[] {
      const calls: (string | undefined)[] = [];
      world.adapter.listMessages = async (args) => {
        calls.push(args.pageToken);
        const answer = answers[calls.length - 1];
        if (answer === undefined) throw new Error(`scriptCalls: no answer scripted for list call ${calls.length}`);
        if (answer instanceof Error) throw answer;
        return answer;
      };
      return calls;
    }

    const unavailable = (): Error => Object.assign(new Error('Service Unavailable'), { status: 503 });

    it('FW5-1 (NEW-1): the list fails at checks 0-1; at the LAST check page 1 holds our orphan with a next page and the page-2 call throws - the orphan already read is adopted, never closed provider_unreachable', async () => {
      register();
      const redrives = recordJobs(BROADCAST_SEND_JOB);
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const owner = bOwner(t.contactId);
      const at = await reconciling(owner, factsFor(t.phone!));
      const base = Date.parse(at);
      // One provider incident: page 1 fails at checks 0 and 1; by the last check it answers, and page 2 fails.
      const calls = scriptCalls([
        unavailable(),
        unavailable(),
        { messages: [listed(base, 'SMorphan', 1_000, BODY), listed(base, 'SMold-1', -3_600_000)], nextPageToken: '1' },
        unavailable(),
      ]);
      await runCheck(payloadOf(owner, at));
      await runNextCheck();
      expect(await recordOf(owner)).toMatchObject({ state: 'reconciling', checkNo: 2 });
      expect(lines(40).filter((l) => l['err'] !== undefined)).toHaveLength(2);
      await runNextCheck();
      expect(calls).toEqual([undefined, undefined, undefined, '1']);
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan' });
      expect(slotOf(t.contactId)).toMatchObject({ status: 'sent' });
      expect(redrives).toHaveLength(0);
      expect(lines(50)).toHaveLength(0);
    });

    it('FW5-1: a page-2 error at the LAST check with nothing adoptable is unresolved provider_unreachable carrying that error - never never_sent or page_bound, and ahead of an unmatched candidate and of an open same-fingerprint sibling', async () => {
      register();
      const redrives = recordJobs(BROADCAST_SEND_JOB);
      /** A recipient whose page 1 (newest-first, reaching behind the window: checks 0-1 stop there) has a next page that throws; its three checks. */
      async function pageTwoFails(broadcastId: string, page1: (base: number) => ProviderMessageSummary[], sibling = false) {
        const t = seedTenant();
        seedBroadcast([t.contactId], { broadcastId });
        const owner = bOwner(t.contactId, broadcastId);
        const at = await reconciling(owner, factsFor(t.phone!));
        if (sibling) {
          // Another share's attempt to this number with the same fingerprint, still mid-send.
          expect((await world.sendAttemptsRepo.claim(bOwner(t.contactId, `${broadcastId}-sib`), factsFor(t.phone!), new Date().toISOString())).outcome).toBe('claimed');
        }
        const page: ListMessagesPage = { messages: page1(Date.parse(at)), nextPageToken: '1' };
        const calls = scriptCalls([page, page, page, new Error(`page 2 down ${broadcastId}`)]);
        await runCheck(payloadOf(owner, at));
        await runNextCheck();
        await runNextCheck();
        const mine = (level: number) => lines(level).filter((l) => (l['owner'] as { broadcastId?: string } | undefined)?.broadcastId === broadcastId);
        return { calls, record: await recordOf(owner), slot: slotOf(t.contactId, broadcastId), errors: mine(50), warns: mine(40) };
      }
      const behind = (base: number) => [listed(base, 'SMold-1', -3_600_000), listed(base, 'SMold-2', -3_601_000)];
      const walks = [
        // Nothing in the window: judged as if complete, this walk would be never_sent.
        ['bcast-1', await pageTwoFails('bcast-1', behind)],
        // An unmatched candidate (a STOP auto-reply) in the window on page 1.
        ['bcast-2', await pageTwoFails('bcast-2', (base) => [listed(base, 'SMstop', 2_000, 'You have successfully been unsubscribed.'), ...behind(base)])],
        // An open same-fingerprint sibling.
        ['bcast-3', await pageTwoFails('bcast-3', behind, true)],
      ] as const;
      for (const [broadcastId, walk] of walks) {
        expect(walk.calls).toEqual([undefined, undefined, undefined, '1']);
        expect(walk.record).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'provider_unreachable' });
        expect(walk.slot).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
        expect(walk.errors).toHaveLength(1);
        expect(walk.errors[0]).toMatchObject({ verdict: 'unresolved', cause: 'provider_unreachable', checkNo: 2, err: { message: `page 2 down ${broadcastId}` } });
        expect(walk.warns.filter((l) => l['verdict'] === 'never_sent')).toHaveLength(0);
      }
      expect(redrives).toHaveLength(0);
      expect(lines(30).filter((l) => l['reason'] === 'page_bound')).toHaveLength(0);
    });

    it('FW5-1: a page-2 error at CHECK 0 with our orphan on page 1 - the orphan already read is adopted at check 0; with nothing adoptable the check continues provider_error carrying that error', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const owner = bOwner(t.contactId);
      const at = await reconciling(owner, factsFor(t.phone!));
      const base = Date.parse(at);
      // Page 1 lies wholly inside the window (no early stop), so the walk asks for page 2 - which throws.
      const calls = scriptCalls([
        { messages: [listed(base, 'SMnew-1', 20_000), listed(base, 'SMorphan', 1_000, BODY)], nextPageToken: '1' },
        unavailable(),
      ]);
      await runCheck(payloadOf(owner, at));
      expect(calls).toEqual([undefined, '1']);
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan', checkNo: 1 });
      expect(slotOf(t.contactId)).toMatchObject({ status: 'sent' });
      expect(scheduledChecks()).toHaveLength(0);
      expect(lines(40).filter((l) => l['err'] !== undefined)).toHaveLength(0);

      // The same walk with nothing of ours on page 1: the error is the check's result - continue provider_error,
      // its WARN carrying the error, never nothing_adoptable; the next check lists again.
      const u = seedTenant();
      seedBroadcast([u.contactId], { broadcastId: 'bcast-2' });
      const ownerU = bOwner(u.contactId, 'bcast-2');
      const atU = await reconciling(ownerU, factsFor(u.phone!));
      const baseU = Date.parse(atU);
      const callsU = scriptCalls([
        { messages: [listed(baseU, 'SMnewU-1', 20_000), listed(baseU, 'SMnewU-2', 1_000)], nextPageToken: '1' },
        new Error('page 2 down'),
      ]);
      await runCheck(payloadOf(ownerU, atU));
      expect(callsU).toEqual([undefined, '1']);
      expect(await recordOf(ownerU)).toMatchObject({ state: 'reconciling', checkNo: 1 });
      expect(scheduledChecks()).toHaveLength(1);
      const warned = lines(40).filter((l) => l['err'] !== undefined);
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatchObject({ checkNo: 0, err: { message: 'page 2 down' } });
      expect(lines(30).filter((l) => l['verdict'] === 'continue').map((l) => l['reason'])).toEqual(['provider_error']);
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

    it('C-8: a phone#-keyed recipient is looked up by its key\'s OWN number - no byPhone GSI read decides it (FW1-9)', async () => {
      register();
      const key = `phone#${T_PHONE}`;
      seedBroadcast([key]);
      // No contact resolves the number through the GSI (none holds it, or the index lags): the key IS the number texted.
      const at = await reconciling(bOwner(key), factsFor(T_PHONE));
      const byPhone = vi.spyOn(world.contactsRepo, 'findByPhone');
      const list = vi.spyOn(world.adapter, 'listMessages');
      await runCheck(payloadOf(bOwner(key), at));
      expect(byPhone).not.toHaveBeenCalled();
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ to: T_PHONE, from: MAIN }));
      expect(await recordOf(bOwner(key))).toMatchObject({ state: 'reconciling', checkNo: 1 });
    });

    it('ADV-9: the "owner recipient not found" INFO names the owner kind and its ids - never the recipient hash (FW1-10)', async () => {
      register();
      const key = `phone#${T_PHONE}`;
      seedBroadcast([key]);
      const at = await reconciling(bOwner(key), factsFor(T_PHONE));
      // The share no longer carries the recipient: the job cannot resolve it from the hash.
      delete world.broadcasts.get('bcast-1')!.recipients[key];
      await runCheck(payloadOf(bOwner(key), at));
      const leg: SendAttemptOwner = { kind: 'relay_leg', relayConversationId: 'conv-gone', sourceTsMsgId: 'ts-gone', memberKey: key };
      await runCheck(payloadOf(leg, at));
      const info = capture.atLevel(30).filter((l) => String(l['msg']).includes('owner recipient not found'));
      expect(info.map((l) => l['owner'])).toEqual([
        { kind: 'broadcast', broadcastId: 'bcast-1' },
        { kind: 'relay_leg', relayConversationId: 'conv-gone', sourceTsMsgId: 'ts-gone' },
      ]);
      expect(JSON.stringify(info)).not.toContain('phonehash#');
      expect(JSON.stringify(info)).not.toContain(hashRecipientKey(key));
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

    it('a record a PASS closed (refused, from redriven) is not the job\'s close: a redelivered check re-applies nothing to its slot (FW1-4)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const owner = bOwner(t.contactId);
      const at = await reconciling(owner, factsFor(t.phone!));
      expect(await world.sendAttemptsRepo.markRedriven(owner, at)).toBe(true);
      // A re-drive pass declined the recipient (a fence) and closed the record; its own slot write never landed.
      expect(await world.sendAttemptsRepo.closeRedriven(owner, { outcome: 'refused', cause: 'opted_out' })).toBe(true);
      await runCheck(payloadOf(owner, at, 2));
      expect(slotOf(t.contactId)).toEqual({ status: 'queued' });
      expect(world.broadcasts.get('bcast-1')!.status).toBe('sending');
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

      // Restated for FW4-1: a cut walk now judges what it read, so adopting page 5's orphan no longer proves the
      // walk was COMPLETE - the last check's verdict does (never_sent needs the list's end). Exactly five pages,
      // all behind the window: checks 0-1 stop at page 1; the last check walks all five, reaches the end, and
      // rules never_sent - never page_bound.
      const redrives = recordJobs(BROADCAST_SEND_JOB);
      const u = seedTenant();
      seedBroadcast([u.contactId], { broadcastId: 'bcast-2' });
      const ownerU = bOwner(u.contactId, 'bcast-2');
      const atU = await reconciling(ownerU, factsFor(u.phone!));
      for (let i = 1; i <= 5; i += 1) {
        plant({ providerSid: `SMfiveU-${i}`, to: u.phone!, createdAt: new Date(Date.parse(atU) - 3_600_000 - 1000 * i).toISOString(), body: `old share ${i}` });
      }
      list.mockClear();
      await runCheck(payloadOf(ownerU, atU));
      await runNextCheck();
      expect(list).toHaveBeenCalledTimes(2);
      await runNextCheck();
      expect(list).toHaveBeenCalledTimes(7);
      expect(await recordOf(ownerU)).toMatchObject({ state: 'redriven', redriveCount: 1 });
      expect(redrives).toEqual([{ broadcastId: 'bcast-2', recipientKeys: [u.contactId], attempt: 1, redrive: true } satisfies BroadcastSendPayload]);
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

    it('a sibling is judged by its LIVE attempt start: one re-claimed at an EARLIER instant (a skewed clock), outside the span, does not withhold never_sent although its first index item lies inside the query bound (FW1-2)', async () => {
      register();
      const redrives = recordJobs(RELAY_FANOUT_JOB);
      seedRelay();
      const t = Date.now() - 36_000_000;
      const sib = legOwner(seedSource());
      // The sibling's first attempt, 100 s after ours: its index item is inside our query bound.
      const first = await world.sendAttemptsRepo.claim(sib, legFacts(), new Date(t + 100_000).toISOString());
      expect(await world.sendAttemptsRepo.finishAttempt(sib, { attemptNo: 1, attemptedAt: first.record.attemptedAt }, { outcome: 'retryable' })).toBe(true);
      // Re-claimed by a process whose clock runs ten minutes behind: the live start is far outside the span.
      expect((await world.sendAttemptsRepo.claim(sib, legFacts(), new Date(t - 600_000).toISOString())).outcome).toBe('claimed');
      const self = legOwner(seedSource());
      const at = await reconciling(self, legFacts(), { at: new Date(t).toISOString() });
      await runChain(legPayload(self, at));
      expect(await recordOf(self)).toMatchObject({ state: 'redriven' });
      expect(redrives).toHaveLength(1);
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

  describe('retry_send owner (retry-send-adoption R4)', () => {
    /** The one-to-one tenant's number (file-local: T_PHONE belongs to the broadcast fixtures). */
    const TENANT_PHONE = '+15550100077';
    const iso = (ms: number): string => new Date(ms).toISOString();
    /** The one-to-one thread's id - MINTED by the fake (`conv-<n>`), never hard-coded; set by seedOneToOne. */
    let retryConv = '';

    /** A one-to-one thread with a consented tenant; returns the contact and the conversation. */
    async function seedOneToOne(): Promise<{ contact: ContactItem; conversation: ConversationItem }> {
      const contact: ContactItem = { contactId: 'c-retry', type: 'tenant', status: 'active', phone: TENANT_PHONE, consent_method: 'inbound_text' };
      world.contacts.push(contact);
      const conversation = await world.conversationsRepo.createOrGetByParticipantPhone(TENANT_PHONE, 'tenant_1to1');
      retryConv = conversation.conversationId;
      return { contact, conversation };
    }

    /**
     * An outbound 30003 row in that thread (the ROOT by default; pass retryOf /
     * retryAttempt / retryRoot for a retry row). Returns the STORED row - the
     * live object the fake keeps - so a test may stamp retry_due_at on it.
     */
    async function seedRow(sid: string, fields: Partial<NewMessage> = {}): Promise<MessageItem> {
      await world.messagesRepo.append({
        conversationId: retryConv,
        providerSid: sid,
        providerTs: iso(Date.now() - 30_000),
        type: 'sms',
        direction: 'outbound',
        author: 'teammate',
        body: BODY,
        deliveryStatus: 'undelivered',
        errorCode: '30003',
        automated: false,
        recipientContactId: 'c-retry',
        ...fields,
      });
      return world.messages.find((m) => m.provider_sid === sid)!;
    }

    /** Attempt `attempt` of the automatic retry of `row` (the RETRIED row), keyed as the job keys it (R1). */
    const rOwner = (
      row: MessageItem,
      attempt: number,
      recipientKey = 'c-retry',
      retryRoot = row.retry_root ?? row.tsMsgId,
    ): RetrySendOwner => ({ kind: 'retry_send', conversationId: row.conversationId, retriedTsMsgId: row.tsMsgId, attempt, recipientKey, retryRoot });
    /** The retry row attempt `attempt` of `retriedTsMsgId` produced, if any. */
    const retryRow = (retriedTsMsgId: string, attempt: number) =>
      world.messages.find((m) => m.retry_of === retriedTsMsgId && m.retry_attempt === attempt);
    const persistedFor = (tsMsgId: string) =>
      world.emitted.filter((e) => e.event === 'message.persisted' && (e.payload as { tsMsgId: string }).tsMsgId === tsMsgId);
    const notFoundLines = () => capture.atLevel(30).filter((l) => String(l['msg']).includes('owner recipient not found'));

    it('the owner renders in every log line as strings - kind, conversationId, retriedTsMsgId, attempt, retryRoot - and never with a phone or its recipient hash (ownerLog, ownerRefLog)', async () => {
      register();
      await seedOneToOne();
      const root = await seedRow('SMroot');
      const expected = { kind: 'retry_send', conversationId: retryConv, retriedTsMsgId: root.tsMsgId, attempt: '2', retryRoot: root.tsMsgId };
      // Resolvable, but no record: superseded - the line renders the RESOLVED owner (ownerLog).
      await runCheck(payloadOf(rOwner(root, 2), new Date().toISOString()));
      const superseded = lines(30).filter((l) => String(l['msg']).includes('superseded'));
      expect(superseded).toHaveLength(1);
      expect(superseded[0]!['owner']).toStrictEqual(expected);
      expect(superseded[0]).toMatchObject({ recipientKey: 'c-retry', state: 'absent' });
      // A reference whose hash matches no key the rows derive: unaddressable - the line renders the REFERENCE (ownerRefLog).
      await runCheck(payloadOf(rOwner(root, 2, 'c-someone-else'), new Date().toISOString()));
      const notFound = notFoundLines();
      expect(notFound).toHaveLength(1);
      expect(notFound[0]!['owner']).toStrictEqual(expected);
      // A phone-keyed attempt (the row records no recipient): redacted, never hashed or in the clear.
      const phoneRow = await seedRow('SMroot-phone', { recipientContactId: undefined });
      await runCheck(payloadOf(rOwner(phoneRow, 1, `phone#${TENANT_PHONE}`), new Date().toISOString()));
      expect(lines(30).filter((l) => String(l['msg']).includes('superseded'))[1]).toMatchObject({ recipientKey: 'phone#redacted' });
      const all = JSON.stringify(capture.lines);
      expect(all).not.toContain(TENANT_PHONE);
      expect(all).not.toContain('phonehash#');
    });

    // ---- adoption (spec section 4 items 10 and 14) ----

    it('10 a listed orphan adopts as the retry row sendMessage would have appended - the full R4 field set, its retrychild# pointer, one audit row, the emits, the inbox moved forward - and NO promise write', async () => {
      register();
      await seedOneToOne();
      const root = await seedRow('SMroot', { providerTs: iso(Date.now() - 20_000) });
      const due = iso(Date.now() + 10_000);
      root.retry_due_at = due;
      world.conversations.get(retryConv)!.last_activity_at = iso(Date.now() - 3_600_000);
      const owner = rOwner(root, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE));
      const orphan = plant({ providerSid: 'SMorphan-r', providerStatus: 'delivered', to: TENANT_PHONE });
      await runCheck(payloadOf(owner, at));
      const row = retryRow(root.tsMsgId, 1)!;
      expect(row).toMatchObject({
        conversationId: retryConv,
        type: 'sms',
        direction: 'outbound',
        author: 'teammate',
        body: BODY,
        provider_sid: 'SMorphan-r',
        provider_ts: orphan.createdAt,
        delivery_status: 'delivered',
        transport_schema_version: 1,
        requested_transport: 'sms',
        retry_of: root.tsMsgId,
        retry_attempt: 1,
        retry_window_start: root.provider_ts,
        retry_root: root.tsMsgId,
        automated: false,
        recipient_contact_id: 'c-retry',
      });
      for (const absent of ['broadcast_id', 'error_code', 'media_attachments', 'mediaUrls', 'retry_due_at', 'retry_outcome']) {
        expect(row, absent).not.toHaveProperty(absent);
      }
      expect(await world.messagesRepo.listRetryChildrenConsistent(retryConv, root.tsMsgId)).toEqual([
        { tsMsgId: row.tsMsgId, providerSid: 'SMorphan-r', retryAttempt: 1 },
      ]);
      expect(world.auditEvents.filter((e) => e.event_type === 'message_sent')).toEqual([
        { entityKey: `conversations#${retryConv}`, event_type: 'message_sent', payload: { providerSid: 'SMorphan-r', automated: false, author: 'teammate' } },
      ]);
      expect(persistedFor(row.tsMsgId).map((e) => e.payload)).toEqual([
        { conversationId: retryConv, tsMsgId: row.tsMsgId, direction: 'outbound', deliveryStatus: 'delivered' },
      ]);
      // The status-preserving touch with no preview, forward only, announced.
      expect(world.conversations.get(retryConv)).toMatchObject({ status: 'open', last_activity_at: orphan.createdAt });
      expect(world.emitted.filter((e) => e.event === 'conversation.updated')).toHaveLength(1);
      // No promise write on an adoption: the retried row's promise expires on RSW's clock.
      expect(root.retry_due_at).toBe(due);
      expect(root).not.toHaveProperty('retry_outcome');
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan-r' });
      const found = lines(30).filter((l) => l['verdict'] === 'found');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        adoption: 'adopted',
        path: 'lookup',
        sid: 'SMorphan-r',
        owner: { kind: 'retry_send', conversationId: retryConv, retriedTsMsgId: root.tsMsgId, attempt: '1', retryRoot: root.tsMsgId },
      });
    });

    it('10a the adopted row copies broadcast_id from a share root and follows the original send: ai stays ai, automated stays automated, and a legacy row with no automated flag is retried automated', async () => {
      register();
      await seedOneToOne();
      const share = await seedRow('SMroot-share', { broadcastId: 'bcast-9', author: 'ai', automated: true });
      const shareOwner = rOwner(share, 1);
      const atShare = await reconciling(shareOwner, factsFor(TENANT_PHONE));
      plant({ providerSid: 'SMorphan-share', to: TENANT_PHONE });
      await runCheck(payloadOf(shareOwner, atShare));
      expect(retryRow(share.tsMsgId, 1)).toMatchObject({
        broadcast_id: 'bcast-9',
        author: 'ai',
        automated: true,
        retry_root: share.tsMsgId,
        delivery_status: 'sent',
      });
      expect(world.auditEvents.filter((e) => e.event_type === 'message_sent').map((e) => e.payload)).toEqual([
        { providerSid: 'SMorphan-share', automated: true, author: 'ai' },
      ]);
      // A root appended before the automated flag existed: retried automated (RSW relay B4), as the job does.
      const legacy = await seedRow('SMroot-legacy', { automated: undefined });
      const legacyOwner = rOwner(legacy, 1);
      const atLegacy = await reconciling(legacyOwner, factsFor(TENANT_PHONE));
      plant({ providerSid: 'SMorphan-legacy', to: TENANT_PHONE });
      await runCheck(payloadOf(legacyOwner, atLegacy));
      expect(retryRow(legacy.tsMsgId, 1)).toMatchObject({ automated: true, author: 'teammate' });
      expect(retryRow(legacy.tsMsgId, 1)).not.toHaveProperty('broadcast_id');
    });

    it('10b recipient_contact_id rides the adopted row only while the recorded contact exists undeleted and still holds the thread number', async () => {
      register();
      const { contact } = await seedOneToOne();
      /** Reconcile a fresh root's attempt 1 against a fresh orphan; the adopted row. */
      async function adoptOne(n: number): Promise<MessageItem> {
        const root = await seedRow(`SMroot-${n}`);
        const owner = rOwner(root, 1);
        const at = await reconciling(owner, factsFor(TENANT_PHONE));
        plant({ providerSid: `SMorphan-${n}`, to: TENANT_PHONE });
        await runCheck(payloadOf(owner, at));
        expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: `SMorphan-${n}` });
        return retryRow(root.tsMsgId, 1)!;
      }
      expect(await adoptOne(1)).toMatchObject({ recipient_contact_id: 'c-retry' });
      contact.deleted_at = iso(Date.now());
      expect(await adoptOne(2)).not.toHaveProperty('recipient_contact_id');
      delete contact.deleted_at;
      contact.phone = '+15558675309';
      expect(await adoptOne(3)).not.toHaveProperty('recipient_contact_id');
    });

    it('10b2 media rides the adopted row only when the attempt sent media (the record\'s mediaCount - deviation 9): the retried row\'s attachments, else its raw mediaUrls; nothing when the job sent the body only', async () => {
      register();
      await seedOneToOne();
      const attachments = [{ s3Key: 'media/out/photo-1.jpg', contentType: 'image/jpeg' }];
      async function adoptOne(n: number, fields: Partial<NewMessage>, mediaCount: number): Promise<MessageItem> {
        const root = await seedRow(`SMroot-${n}`, { type: 'mms', ...fields });
        const owner = rOwner(root, 1);
        const at = await reconciling(owner, factsFor(TENANT_PHONE, { mediaCount }));
        plant({ providerSid: `SMorphan-${n}`, to: TENANT_PHONE, mediaCount });
        await runCheck(payloadOf(owner, at));
        expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: `SMorphan-${n}` });
        return retryRow(root.tsMsgId, 1)!;
      }
      // Attachments on the root, but the job had no store and sent the body only (mediaCount 0).
      const bodyOnly = await adoptOne(1, { mediaAttachments: attachments }, 0);
      expect(bodyOnly).toMatchObject({ type: 'sms', requested_transport: 'sms' });
      expect(bodyOnly).not.toHaveProperty('media_attachments');
      expect(bodyOnly).not.toHaveProperty('mediaUrls');
      // The job re-presigned the attachments and sent them: the durable keys ride, never a stored presigned URL.
      const withMedia = await adoptOne(2, { mediaAttachments: attachments, mediaUrls: ['https://bucket.example/presigned-expired'] }, 1);
      expect(withMedia).toMatchObject({ type: 'mms', requested_transport: 'mms', media_attachments: attachments });
      expect(withMedia).not.toHaveProperty('mediaUrls');
      // No attachments, raw mediaUrls (the internal/e2e seam the job replays): they ride as sent.
      const raw = await adoptOne(3, { mediaUrls: ['https://media.example/raw-1.jpg'] }, 1);
      expect(raw).toMatchObject({ type: 'mms', mediaUrls: ['https://media.example/raw-1.jpg'] });
      expect(raw).not.toHaveProperty('media_attachments');
    });

    it('10c the ORIGINAL message inside the window is held by its own row (other) - never adopted as the retry (Review Focus 2)', async () => {
      register();
      await seedOneToOne();
      const root = await seedRow('SMroot', { providerTs: iso(Date.now() - 5_000) });
      const owner = rOwner(root, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE));
      // The root's provider twin sits in the window with the same body, OLDER than the retry's orphan (walked first).
      plant({ providerSid: 'SMroot', providerStatus: 'undelivered', errorCode: '30003', to: TENANT_PHONE, createdAt: root.provider_ts });
      plant({ providerSid: 'SMorphan-r', providerStatus: 'sent', to: TENANT_PHONE });
      await runCheck(payloadOf(owner, at));
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan-r' });
      expect(world.messages.filter((m) => m.provider_sid === 'SMroot')).toHaveLength(1);
      expect(retryRow(root.tsMsgId, 1)).toMatchObject({ provider_sid: 'SMorphan-r' });
      expect(lines(50)).toHaveLength(0);
    });

    it('10c2 nor is the original\'s twin an UNMATCHED candidate: with a different fingerprint (its photo, a body-only retry) and nothing else in the window, the last check is never_sent - one re-drive - not unidentified_candidate (Review Focus 2)', async () => {
      register();
      const got = recordJobs(RETRY_SEND_JOB);
      await seedOneToOne();
      const root = await seedRow('SMroot', {
        providerTs: iso(Date.now() - 5_000),
        type: 'mms',
        mediaAttachments: [{ s3Key: 'media/out/photo-1.jpg', contentType: 'image/jpeg' }],
      });
      const owner = rOwner(root, 1);
      // The job had no media store: it sent the body only.
      const at = await reconciling(owner, factsFor(TENANT_PHONE, { mediaCount: 0 }));
      plant({ providerSid: 'SMroot', providerStatus: 'undelivered', errorCode: '30003', to: TENANT_PHONE, createdAt: root.provider_ts, mediaCount: 1 });
      await runChain(payloadOf(owner, at));
      expect(await recordOf(owner)).toMatchObject({ state: 'redriven', redriveCount: 1 });
      expect(got).toEqual([{ providerSid: 'SMroot', conversationId: retryConv, attempt: 1 }]);
      expect(lines(50)).toHaveLength(0);
    });

    it('10d a redelivered check is idempotent: the same envelope twice adopts once - one row, one pointer, one audit row', async () => {
      register();
      await seedOneToOne();
      const root = await seedRow('SMroot');
      const owner = rOwner(root, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE));
      plant({ providerSid: 'SMorphan-r', to: TENANT_PHONE });
      const envelope = await enqueue(SEND_RECONCILE_JOB, payloadOf(owner, at), { runAt: new Date(Date.now() + 600_000) });
      const [item] = outbound.delayed.splice(outbound.delayed.findIndex((d) => d.envelope.jobId === envelope.jobId), 1);
      const wire = JSON.stringify(item!.envelope);
      await dispatchJob(JSON.parse(wire) as unknown);
      await dispatchJob(JSON.parse(wire) as unknown);
      await outbound.settle();
      expect(world.messages.filter((m) => m.provider_sid === 'SMorphan-r')).toHaveLength(1);
      expect(await world.messagesRepo.listRetryChildrenConsistent(retryConv, root.tsMsgId)).toHaveLength(1);
      expect(world.auditEvents.filter((e) => e.event_type === 'message_sent')).toHaveLength(1);
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan-r' });
    });

    it('10e the known-SID path adopts the row sendMessage appended before a record-phase failure as a repair (mine): no second row, no audit row, adoption skipped (spec 14)', async () => {
      register();
      await seedOneToOne();
      const root = await seedRow('SMroot');
      const retry = await seedRow('SMretry1', {
        providerTs: iso(Date.now()),
        deliveryStatus: 'queued',
        errorCode: undefined,
        retryOf: root.tsMsgId,
        retryAttempt: 1,
        retryWindowStart: root.provider_ts,
        retryRoot: root.tsMsgId,
      });
      const owner = rOwner(root, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE), { sid: 'SMretry1' });
      plant({ providerSid: 'SMretry1', providerStatus: 'sent', to: TENANT_PHONE });
      const count = world.messages.length;
      const list = vi.spyOn(world.adapter, 'listMessages');
      await runCheck(payloadOf(owner, at));
      expect(list).not.toHaveBeenCalled();
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMretry1' });
      expect(world.messages).toHaveLength(count);
      expect(world.auditEvents.filter((e) => e.event_type === 'message_sent')).toHaveLength(0);
      expect(lines(30).filter((l) => l['verdict'] === 'found')[0]).toMatchObject({ path: 'known_sid', adoption: 'skipped', sid: 'SMretry1' });
      expect(await world.messagesRepo.listRetryChildrenConsistent(retryConv, root.tsMsgId)).toEqual([
        { tsMsgId: retry.tsMsgId, providerSid: 'SMretry1', retryAttempt: 1 },
      ]);
    });

    it('10f a known SID held by ANOTHER row of the thread (here the original\'s own) is unresolved sid_held_elsewhere naming it as a message row - never fetched - and the promise is withdrawn', async () => {
      register();
      await seedOneToOne();
      const root = await seedRow('SMroot');
      root.retry_due_at = iso(Date.now() + 10_000);
      const owner = rOwner(root, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE), { sid: 'SMroot' });
      plant({ providerSid: 'SMroot', providerStatus: 'undelivered', errorCode: '30003', to: TENANT_PHONE });
      const get = vi.spyOn(world.adapter, 'getMessage');
      await runCheck(payloadOf(owner, at));
      expect(get).not.toHaveBeenCalled();
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'sid_held_elsewhere' });
      expect(lines(50)).toHaveLength(1);
      expect(lines(50)[0]).toMatchObject({ verdict: 'unresolved', cause: 'sid_held_elsewhere', heldBy: `message#${retryConv}#${root.tsMsgId}` });
      expect(root).toMatchObject({ retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' });
    });

    it('10g a free-looking match whose append dedupes onto ANOTHER lineage is someone else\'s: not adopted, nothing written, the chain goes on', async () => {
      register();
      await seedOneToOne();
      const root = await seedRow('SMroot');
      const owner = rOwner(root, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE));
      // Staff re-typed the same text meanwhile: its row holds the SID.
      await world.messagesRepo.append({
        conversationId: retryConv,
        providerSid: 'SMstaff-1',
        providerTs: iso(Date.now()),
        type: 'sms',
        direction: 'outbound',
        author: 'teammate',
        body: BODY,
        deliveryStatus: 'sent',
        automated: false,
      });
      plant({ providerSid: 'SMstaff-1', to: TENANT_PHONE });
      // This check's holder read races that append: it sees no row, so the SID looks free.
      vi.spyOn(world.messagesRepo, 'getByProviderSidConsistent').mockResolvedValueOnce(undefined);
      const count = world.messages.length;
      await runCheck(payloadOf(owner, at));
      expect(await recordOf(owner)).toMatchObject({ state: 'reconciling', checkNo: 1 });
      expect(retryRow(root.tsMsgId, 1)).toBeUndefined();
      expect(world.messages).toHaveLength(count);
      expect(await world.messagesRepo.listRetryChildrenConsistent(retryConv, root.tsMsgId)).toEqual([]);
      expect(world.auditEvents).toHaveLength(0);
      expect(scheduledChecks()).toHaveLength(1);
    });

    it('10h an adopted terminal failure is recorded honestly with its code and WARNed (the 30003 ladder does not continue from it); a success status carries no code', async () => {
      register();
      await seedOneToOne();
      const failedRoot = await seedRow('SMroot-f');
      const owner = rOwner(failedRoot, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE));
      plant({ providerSid: 'SMorphan-f', providerStatus: 'undelivered', errorCode: '30003', to: TENANT_PHONE });
      await runCheck(payloadOf(owner, at));
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan-f' });
      expect(retryRow(failedRoot.tsMsgId, 1)).toMatchObject({ delivery_status: 'undelivered', error_code: '30003' });
      const warns = capture.atLevel(40).filter((l) => String(l['msg']).includes('adopted terminal failure on a retry row'));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatchObject({
        event: 'send_reconcile',
        sid: 'SMorphan-f',
        deliveryStatus: 'undelivered',
        errorCode: '30003',
        owner: { kind: 'retry_send', retriedTsMsgId: failedRoot.tsMsgId, attempt: '1' },
      });
      // A delivered message the provider reports with a stray code adopts code-free.
      const okRoot = await seedRow('SMroot-ok');
      const okOwner = rOwner(okRoot, 1);
      const okAt = await reconciling(okOwner, factsFor(TENANT_PHONE));
      plant({ providerSid: 'SMorphan-ok', providerStatus: 'delivered', errorCode: '30003', to: TENANT_PHONE });
      await runCheck(payloadOf(okOwner, okAt));
      expect(retryRow(okRoot.tsMsgId, 1)).toMatchObject({ delivery_status: 'delivered' });
      expect(retryRow(okRoot.tsMsgId, 1)).not.toHaveProperty('error_code');
    });

    // ---- never_sent (spec section 4 item 11) ----

    it('11 never_sent inside the window re-drives ONCE: a messaging.retrySend envelope with the retried row\'s providerSid, the attempt and NO deferred; the record redriven; the promise REFRESHED and emitted; a redelivered verdict enqueues nothing', async () => {
      register();
      const got = recordJobs(RETRY_SEND_JOB);
      await seedOneToOne();
      const root = await seedRow('SMroot', { providerTs: iso(Date.now() - 20_000) });
      root.retry_due_at = iso(Date.now() + 10_000);
      const owner = rOwner(root, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE));
      await runCheck(payloadOf(owner, at));
      await runNextCheck();
      const last = await runNextCheck();
      expect(last.checkNo).toBe(2);
      expect(got).toEqual([{ providerSid: 'SMroot', conversationId: retryConv, attempt: 1 }]);
      expect(await recordOf(owner)).toMatchObject({ state: 'redriven', redriveCount: 1 });
      const refreshed = Date.parse(root.retry_due_at!);
      expect(refreshed).toBeGreaterThanOrEqual(Date.now() + RETRY_JOB_GRACE_MS + RETRY_PROMISE_GRACE_MS - 5_000);
      expect(refreshed).toBeLessThanOrEqual(Date.now() + RETRY_JOB_GRACE_MS + RETRY_PROMISE_GRACE_MS);
      expect(root).not.toHaveProperty('retry_outcome');
      expect(persistedFor(root.tsMsgId).map((e) => e.payload)).toEqual([
        { conversationId: retryConv, tsMsgId: root.tsMsgId, direction: 'outbound', deliveryStatus: 'undelivered' },
      ]);
      expect(lines(40).filter((l) => l['verdict'] === 'never_sent')).toHaveLength(1);
      expect(capture.atLevel(50)).toHaveLength(0);
      // The verdict delivered again: the record is redriven now - nothing is marked, enqueued or refreshed again.
      const annotate = vi.spyOn(world.messagesRepo, 'annotateRetryPromise');
      await runCheck(last);
      expect(got).toHaveLength(1);
      expect(annotate).not.toHaveBeenCalled();
      expect(await recordOf(owner)).toMatchObject({ state: 'redriven', redriveCount: 1 });
    });

    it('11a never_sent OUTSIDE the window closes redrive_refused / retry_window_closed while reconciling: ONE ERROR, no enqueue, the promise untouched - a redelivered verdict writes nothing either', async () => {
      register();
      const got = recordJobs(RETRY_SEND_JOB);
      await seedOneToOne();
      const root = await seedRow('SMroot', { providerTs: iso(Date.now() - 16 * 60_000) });
      const due = iso(Date.now() + 10_000);
      root.retry_due_at = due;
      const owner = rOwner(root, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE));
      const annotate = vi.spyOn(world.messagesRepo, 'annotateRetryPromise');
      await runCheck(payloadOf(owner, at));
      await runNextCheck();
      const last = await runNextCheck();
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'redrive_refused', cause: 'retry_window_closed', redriveCount: 0 });
      expect(got).toEqual([]);
      expect(root.retry_due_at).toBe(due);
      expect(root).not.toHaveProperty('retry_outcome');
      expect(annotate).not.toHaveBeenCalled();
      const errors = capture.atLevel(50);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        event: 'send_reconcile',
        verdict: 'never_sent',
        cause: 'retry_window_closed',
        checkNo: 2,
        owner: { kind: 'retry_send', retriedTsMsgId: root.tsMsgId, attempt: '1', retryRoot: root.tsMsgId },
      });
      expect(lines(40).filter((l) => l['verdict'] === 'never_sent')).toHaveLength(0);
      // afterClose: the retried row re-renders (its promise will expire).
      expect(persistedFor(root.tsMsgId)).toHaveLength(1);
      await runCheck(last);
      expect(annotate).not.toHaveBeenCalled();
      expect(root.retry_due_at).toBe(due);
      expect(capture.atLevel(50)).toHaveLength(1);
    });

    it('11b never_sent with NO usable window origin fails open (RSW D5): the re-drive is enqueued', async () => {
      register();
      const got = recordJobs(RETRY_SEND_JOB);
      await seedOneToOne();
      const root = await seedRow('SMroot');
      root.provider_ts = 'not a time';
      const owner = rOwner(root, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE));
      await runChain(payloadOf(owner, at));
      expect(got).toEqual([{ providerSid: 'SMroot', conversationId: retryConv, attempt: 1 }]);
      expect(await recordOf(owner)).toMatchObject({ state: 'redriven', redriveCount: 1 });
    });

    it('11c a re-drive enqueue that throws closes enqueue_failed with NO retry_outcome and the promise untouched (nothing was sent: Retry returns once the promise expires); a redelivered verdict re-applies nothing to the promise', async () => {
      register();
      await seedOneToOne();
      const root = await seedRow('SMroot');
      const due = iso(Date.now() + 10_000);
      root.retry_due_at = due;
      const owner = rOwner(root, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE));
      configureOutboundQueue({
        async enqueue(envelope, opts) {
          if (envelope.jobName === RETRY_SEND_JOB) throw new Error('queue down');
          return outbound.enqueue(envelope, opts);
        },
      });
      const annotate = vi.spyOn(world.messagesRepo, 'annotateRetryPromise');
      await runCheck(payloadOf(owner, at));
      await runNextCheck();
      const last = await runNextCheck();
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'enqueue_failed', cause: 'enqueue_failed', redriveCount: 1 });
      expect(root.retry_due_at).toBe(due);
      expect(root).not.toHaveProperty('retry_outcome');
      expect(annotate).not.toHaveBeenCalled();
      const errors = capture.atLevel(50);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ verdict: 'never_sent', cause: 'enqueue_failed', err: { message: 'queue down' } });
      await runCheck(last);
      expect(annotate).not.toHaveBeenCalled();
      expect(root).not.toHaveProperty('retry_outcome');
    });

    // ---- unresolved (spec section 4 item 12) ----

    it('12 unresolved (the list fails on every check): the record closes FIRST, then ONE write sets the sentinel AND retry_outcome unconfirmed; one ERROR; no re-send; a redelivered check re-applies the withdrawal, and one more is a no-op', async () => {
      register();
      const got = recordJobs(RETRY_SEND_JOB);
      await seedOneToOne();
      const root = await seedRow('SMroot');
      root.retry_due_at = iso(Date.now() + 10_000);
      const owner = rOwner(root, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE));
      world.adapter.listMessages = async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      };
      const annotate = vi.spyOn(world.messagesRepo, 'annotateRetryPromise');
      const close = vi.spyOn(world.sendAttemptsRepo, 'closeFromReconcile');
      await runChain(payloadOf(owner, at));
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'provider_unreachable' });
      expect(root).toMatchObject({ retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' });
      expect(annotate).toHaveBeenCalledTimes(1);
      expect(annotate.mock.calls[0]!.slice(0, 3)).toEqual([
        retryConv,
        root.tsMsgId,
        { retryDueAt: RETRY_PROMISE_WITHDRAWN_AT, retryOutcome: 'unconfirmed' },
      ]);
      // The record FIRST (D8 as built), then the withdrawal.
      expect(close.mock.invocationCallOrder[0]!).toBeLessThan(annotate.mock.invocationCallOrder[0]!);
      const errors = capture.atLevel(50);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        event: 'send_reconcile',
        verdict: 'unresolved',
        cause: 'provider_unreachable',
        checkNo: 2,
        owner: { kind: 'retry_send', conversationId: retryConv, retriedTsMsgId: root.tsMsgId, attempt: '1', retryRoot: root.tsMsgId },
      });
      expect(got).toEqual([]);
      expect(world.sent).toHaveLength(0);
      // The withdrawal's emit, then afterClose's: the retried row re-renders "retry not confirmed".
      expect(persistedFor(root.tsMsgId)).toHaveLength(2);
      // A redelivered last check finds the record done for its own attempt: the superseded exit re-applies the withdrawal.
      delete root.retry_outcome;
      root.retry_due_at = iso(Date.now() + 10_000);
      await runCheck({ owner: toOwnerRef(owner), attemptedAt: at, checkNo: 2 });
      expect(root).toMatchObject({ retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' });
      expect(annotate).toHaveBeenCalledTimes(2);
      // Once more, already withdrawn: no write at all.
      await runCheck({ owner: toOwnerRef(owner), attemptedAt: at, checkNo: 2 });
      expect(annotate).toHaveBeenCalledTimes(2);
      expect(capture.atLevel(50)).toHaveLength(1);
    });

    it('12a a CONTACT-keyed attempt whose thread number changed or vanished still resolves (the key is the recorded contact) and is unresolved digest_mismatch - never listed - with the promise withdrawn', async () => {
      register();
      await seedOneToOne();
      const conv = world.conversations.get(retryConv)!;
      const rootA = await seedRow('SMroot-a');
      const rootB = await seedRow('SMroot-b');
      const ownerA = rOwner(rootA, 1);
      const ownerB = rOwner(rootB, 1);
      const atA = await reconciling(ownerA, factsFor(TENANT_PHONE));
      const atB = await reconciling(ownerB, factsFor(TENANT_PHONE));
      const list = vi.spyOn(world.adapter, 'listMessages');
      conv.participant_phone = '+15558675309';
      await runCheck(payloadOf(ownerA, atA));
      delete conv.participant_phone;
      await runCheck(payloadOf(ownerB, atB));
      expect(list).not.toHaveBeenCalled();
      for (const [owner, root] of [[ownerA, rootA], [ownerB, rootB]] as const) {
        expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'digest_mismatch' });
        expect(root).toMatchObject({ retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' });
      }
      expect(lines(50).map((l) => l['cause'])).toEqual(['digest_mismatch', 'digest_mismatch']);
    });

    it('12a2 a PHONE-keyed attempt (the row records no recipient) whose thread number vanished or changed is unaddressable: INFO "owner recipient not found", the record stays reconciling for the sweeper, the promise untouched', async () => {
      register();
      await seedOneToOne();
      const conv = world.conversations.get(retryConv)!;
      const due = iso(Date.now() + 10_000);
      const rootA = await seedRow('SMroot-a', { recipientContactId: undefined });
      const rootB = await seedRow('SMroot-b', { recipientContactId: undefined });
      rootA.retry_due_at = due;
      rootB.retry_due_at = due;
      const ownerA = rOwner(rootA, 1, `phone#${TENANT_PHONE}`);
      const ownerB = rOwner(rootB, 1, `phone#${TENANT_PHONE}`);
      const atA = await reconciling(ownerA, factsFor(TENANT_PHONE));
      const atB = await reconciling(ownerB, factsFor(TENANT_PHONE));
      delete conv.participant_phone;
      await runCheck(payloadOf(ownerA, atA));
      conv.participant_phone = '+15558675309';
      await runCheck(payloadOf(ownerB, atB));
      expect(notFoundLines()).toHaveLength(2);
      for (const [owner, root] of [[ownerA, rootA], [ownerB, rootB]] as const) {
        expect(await recordOf(owner)).toMatchObject({ state: 'reconciling', checkNo: 0 });
        expect(root.retry_due_at).toBe(due);
        expect(root).not.toHaveProperty('retry_outcome');
      }
      expect(scheduledChecks()).toHaveLength(0);
      expect(JSON.stringify(capture.lines)).not.toContain(TENANT_PHONE);
    });

    it('12b a retried row that no longer exists leaves the record for the sweeper (INFO): nothing written, nothing scheduled', async () => {
      register();
      await seedOneToOne();
      const root = await seedRow('SMroot');
      const owner = rOwner(root, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE));
      world.messages.splice(world.messages.indexOf(root), 1);
      await runCheck(payloadOf(owner, at));
      expect(await recordOf(owner)).toMatchObject({ state: 'reconciling', checkNo: 0 });
      expect(notFoundLines()).toHaveLength(1);
      expect(scheduledChecks()).toHaveLength(0);
    });

    it('12c the second unknown after one re-drive closes unresolved second_unknown and withdraws - never a second re-drive (D13a)', async () => {
      register();
      const got = recordJobs(RETRY_SEND_JOB);
      await seedOneToOne();
      const root = await seedRow('SMroot');
      root.retry_due_at = iso(Date.now() + 10_000);
      const owner = rOwner(root, 1);
      const facts = factsFor(TENANT_PHONE);
      const first = await reconciling(owner, facts, { at: iso(Date.now() - 120_000) });
      expect(await world.sendAttemptsRepo.markRedriven(owner, first)).toBe(true);
      // The re-driven attempt went unknown again and is reconciling with redriveCount 1 (case 20's form).
      const claimed = await world.sendAttemptsRepo.claim(owner, facts, new Date().toISOString());
      expect(claimed).toMatchObject({ outcome: 'claimed', record: { attemptNo: 2, redriveCount: 1 } });
      expect(await world.sendAttemptsRepo.takeOver(owner, claimed.record)).toBe(true);
      await runChain(payloadOf(owner, claimed.record.attemptedAt));
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'second_unknown' });
      expect(root).toMatchObject({ retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' });
      expect(got).toEqual([]);
      expect(capture.atLevel(50)).toHaveLength(1);
      expect(lines(50)[0]).toMatchObject({ verdict: 'unresolved', cause: 'second_unknown' });
    });

    // ---- code review round 1, fix wave FW1: C-2 (a WITHDRAW that does not land is re-applied) ----

    /**
     * An unresolved chain (the list fails on every check) whose FIRST delivery
     * of the last check meets `withdrawAnswer` at the WITHDRAW - 'failed' (its
     * write throws once) or 'lost' (its two writes lose their condition) - then
     * the SQS redelivery of that SAME check envelope. Every other promise write
     * goes through. Returns the retried row, the owner and the spy.
     */
    async function unresolvedWithdrawFault(withdrawAnswer: 'failed' | 'lost') {
      register();
      const got = recordJobs(RETRY_SEND_JOB);
      await seedOneToOne();
      const root = await seedRow('SMroot');
      const due = iso(Date.now() + 10_000);
      root.retry_due_at = due;
      const owner = rOwner(root, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE));
      world.adapter.listMessages = async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      };
      const real = world.messagesRepo.annotateRetryPromise.bind(world.messagesRepo);
      let faults = 0;
      const annotate = vi.spyOn(world.messagesRepo, 'annotateRetryPromise').mockImplementation(async (conversationId, tsMsgId, patch, expected) => {
        if (patch.retryOutcome !== undefined && faults < (withdrawAnswer === 'failed' ? 1 : 2)) {
          faults += 1;
          if (withdrawAnswer === 'failed') throw new Error('annotate exploded');
          return false;
        }
        return real(conversationId, tsMsgId, patch, expected);
      });
      await runCheck(payloadOf(owner, at));
      await runNextCheck();
      // The last check, taken off the queue so it can be delivered twice: an SQS redelivery keeps its envelope.
      const index = outbound.delayed.findIndex((d) => d.envelope.jobName === SEND_RECONCILE_JOB);
      const [last] = outbound.delayed.splice(index, 1);
      expect((last!.envelope.payload as SendReconcilePayload).checkNo).toBe(2);
      const wire = JSON.stringify(last!.envelope);
      await expect(dispatchJob(JSON.parse(wire) as unknown)).rejects.toThrow(`withdrawal answered '${withdrawAnswer}'`);
      // The record closed FIRST; the row still promises; nothing re-rendered yet (afterClose did not run).
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'provider_unreachable' });
      expect(root.retry_due_at).toBe(due);
      expect(root).not.toHaveProperty('retry_outcome');
      expect(persistedFor(root.tsMsgId)).toHaveLength(0);
      // The SQS redelivery of that same check: the superseded exit re-applies the WITHDRAW, then afterClose.
      await dispatchJob(JSON.parse(wire) as unknown);
      await outbound.settle();
      expect(root).toMatchObject({ retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' });
      expect(persistedFor(root.tsMsgId)).toHaveLength(2);
      expect(lines(30).filter((l) => String(l['msg']).includes('superseded'))).toEqual([
        expect.objectContaining({ state: 'done', outcome: 'unresolved', checkNo: 2 }),
      ]);
      // ONE unresolved ERROR in total: the redelivery logs no verdict of its own.
      expect(lines(50).filter((l) => l['verdict'] === 'unresolved')).toHaveLength(1);
      expect(got).toEqual([]);
      expect(world.sent).toHaveLength(0);
      return { root, owner, annotate };
    }

    it('FW1 C-2 (failed): a WITHDRAW whose write THROWS at the unresolved close fails the check (after the helper\'s ERROR); the redelivery of that check finds the record done for its own attempt and re-applies the WITHDRAW through the superseded exit - ONE unresolved ERROR in total', async () => {
      const { annotate } = await unresolvedWithdrawFault('failed');
      expect(annotate).toHaveBeenCalledTimes(2);
      expect(capture.atLevel(50).map((l) => l['msg'])).toEqual([
        'send.reconcile: unresolved - the platform cannot tell whether this text went out; closed send_unconfirmed, never re-sent',
        'failure-arm write failed (best-effort); the attempt record decides',
        'job failed: send.reconcile',
      ]);
    });

    it('FW1 C-2 (lost): a WITHDRAW LOST twice (the promise kept moving) fails the check the same way; its redelivery re-applies the WITHDRAW - ONE unresolved ERROR in total', async () => {
      const { annotate } = await unresolvedWithdrawFault('lost');
      expect(annotate).toHaveBeenCalledTimes(3);
      expect(capture.atLevel(50).map((l) => l['msg'])).toEqual([
        'send.reconcile: unresolved - the platform cannot tell whether this text went out; closed send_unconfirmed, never re-sent',
        'retry promise withdrawal lost twice - a concurrent writer keeps moving the promise',
        'job failed: send.reconcile',
      ]);
    });

    // ---- fix wave FW2 (planner review A1): THIS attempt's own row, by its retrychild# pointer ----

    /** The one-to-one world for the FW2 cases: the reconcile registered, the re-drive recorded (never run). */
    async function ownRowWorld(): Promise<unknown[]> {
      register();
      const got = recordJobs(RETRY_SEND_JOB);
      await seedOneToOne();
      return got;
    }

    /**
     * A retried row (`SMroot-<n>`, its promise due in 10 s) whose attempt 1 is
     * reconciling WITHOUT a sid - a takeover of a run whose provider call was
     * still in flight - and a child of it appended through the fake's append,
     * so its retrychild# pointer exists: attempt `childAttempt`'s retry row
     * (`SMown-<n>`, sent), created 100 s after the attempt started - outside
     * the window [at - 60 s, at + 90 s] (the adversarial review's late text).
     * The provider lists nothing.
     */
    async function withChildRow(n: number, childAttempt: number, facts: SendAttemptFacts = factsFor(TENANT_PHONE)) {
      const root = await seedRow(`SMroot-${n}`, { providerTs: iso(Date.now() - 20_000) });
      const due = iso(Date.now() + 10_000);
      root.retry_due_at = due;
      const owner = rOwner(root, 1);
      const at = await reconciling(owner, facts);
      const child = await seedRow(`SMown-${n}`, {
        providerTs: iso(Date.parse(at) + 100_000),
        deliveryStatus: 'sent',
        errorCode: undefined,
        retryOf: root.tsMsgId,
        retryAttempt: childAttempt,
        retryRoot: root.tsMsgId,
      });
      return { root, due, owner, at, child };
    }

    const ownRowMissing = "send.reconcile: a retrychild# pointer names this attempt's retry row but the row cannot be read - the lookup goes on";

    it('FW2 A1: a retried row that already holds THIS attempt\'s own retry row (its retrychild# pointer) is found from that row at check 0 - done/adopted with its SID, adoption skipped, path lookup - before any provider list: no re-drive, no second row, no audit row, no promise write', async () => {
      const got = await ownRowWorld();
      const { root, due, owner, at, child } = await withChildRow(1, 1);
      const list = vi.spyOn(world.adapter, 'listMessages');
      const count = world.messages.length;
      await runChain(payloadOf(owner, at));
      expect(list).not.toHaveBeenCalled();
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMown-1' });
      expect(got).toEqual([]);
      expect(scheduledChecks()).toHaveLength(0);
      expect(world.messages).toHaveLength(count);
      expect(await world.messagesRepo.listRetryChildrenConsistent(retryConv, root.tsMsgId)).toEqual([
        { tsMsgId: child.tsMsgId, providerSid: 'SMown-1', retryAttempt: 1 },
      ]);
      expect(world.auditEvents).toHaveLength(0);
      expect(lines(30).filter((l) => l['verdict'] === 'found')).toEqual([
        expect.objectContaining({ path: 'lookup', adoption: 'skipped', sid: 'SMown-1', deliveryStatus: 'sent', checkNo: 0 }),
      ]);
      // Neither refreshed nor withdrawn; afterClose re-renders the retried row once, and nothing re-announces the child.
      expect(root.retry_due_at).toBe(due);
      expect(root).not.toHaveProperty('retry_outcome');
      expect(persistedFor(root.tsMsgId)).toHaveLength(1);
      expect(persistedFor(child.tsMsgId)).toHaveLength(0);
      expect(capture.atLevel(40)).toHaveLength(0);
      expect(capture.atLevel(50)).toHaveLength(0);
    });

    it('FW2 A1: the own-row proof wins over every provider-side verdict (the check is the lookup\'s FIRST step) - with the list throwing on every check, with no sender on the record (no_sender) and with the thread\'s number changed (digest_mismatch), each attempt is found/adopted from its own row: never unresolved, no ERROR, the promise never withdrawn', async () => {
      const got = await ownRowWorld();
      const list = vi
        .spyOn(world.adapter, 'listMessages')
        .mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      // (1) the provider unreachable on every check (unresolved provider_unreachable before FW2).
      const unreachable = await withChildRow(1, 1);
      await runChain(payloadOf(unreachable.owner, unreachable.at));
      // (2) a record with no sender - an unpinned dev send (unresolved no_sender before FW2).
      const unpinned = await withChildRow(2, 1, factsFor(TENANT_PHONE, { sender: null }));
      expect(await recordOf(unpinned.owner)).not.toHaveProperty('sender');
      await runChain(payloadOf(unpinned.owner, unpinned.at));
      // (3) the thread's number changed after the send (unresolved digest_mismatch before FW2).
      const renumbered = await withChildRow(3, 1);
      world.conversations.get(retryConv)!.participant_phone = '+15558675309';
      await runChain(payloadOf(renumbered.owner, renumbered.at));
      for (const [n, s] of [[1, unreachable], [2, unpinned], [3, renumbered]] as const) {
        expect(await recordOf(s.owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: `SMown-${n}` });
        expect(s.root.retry_due_at).toBe(s.due);
        expect(s.root).not.toHaveProperty('retry_outcome');
      }
      expect(lines(30).filter((l) => l['verdict'] === 'found').map((l) => [l['sid'], l['path'], l['adoption'], l['checkNo']])).toEqual([
        ['SMown-1', 'lookup', 'skipped', 0],
        ['SMown-2', 'lookup', 'skipped', 0],
        ['SMown-3', 'lookup', 'skipped', 0],
      ]);
      expect(list).not.toHaveBeenCalled();
      expect(capture.atLevel(50)).toHaveLength(0);
      expect(capture.atLevel(40)).toHaveLength(0);
      expect(got).toEqual([]);
      expect(world.sent).toHaveLength(0);
    });

    it('FW2 A1 (control): a child of ANOTHER attempt number is not this attempt\'s row - the pointer partition is read once per check and the lookup runs as before: never_sent at the last check, ONE re-drive', async () => {
      const got = await ownRowWorld();
      const { owner, at } = await withChildRow(1, 2);
      const children = vi.spyOn(world.messagesRepo, 'listRetryChildrenConsistent');
      const list = vi.spyOn(world.adapter, 'listMessages');
      await runChain(payloadOf(owner, at));
      expect(children).toHaveBeenCalledTimes(3);
      expect(children).toHaveBeenCalledWith(retryConv, owner.retriedTsMsgId);
      expect(list).toHaveBeenCalledTimes(3);
      expect(await recordOf(owner)).toMatchObject({ state: 'redriven', redriveCount: 1 });
      expect(got).toEqual([{ providerSid: 'SMroot-1', conversationId: retryConv, attempt: 1 }]);
      expect(lines(30).filter((l) => l['verdict'] === 'found')).toHaveLength(0);
      expect(lines(40).filter((l) => l['verdict'] === 'never_sent')).toHaveLength(1);
      expect(lines(40).filter((l) => l['msg'] === ownRowMissing)).toHaveLength(0);
    });

    it('FW2 A1 (anomaly): a pointer of THIS attempt whose row cannot be read WARNs once per check - naming the owner and the child\'s tsMsgId - and the lookup runs unchanged: here never_sent at the last check and ONE re-drive', async () => {
      const got = await ownRowWorld();
      const { owner, at, child } = await withChildRow(1, 1);
      const read = world.messagesRepo.getByTsMsgIdConsistent.bind(world.messagesRepo);
      vi.spyOn(world.messagesRepo, 'getByTsMsgIdConsistent').mockImplementation(async (conversationId, tsMsgId) =>
        tsMsgId === child.tsMsgId ? undefined : read(conversationId, tsMsgId),
      );
      const list = vi.spyOn(world.adapter, 'listMessages');
      await runChain(payloadOf(owner, at));
      const missing = lines(40).filter((l) => l['msg'] === ownRowMissing);
      expect(missing.map((l) => l['checkNo'])).toEqual([0, 1, 2]);
      expect(missing[0]).toMatchObject({
        childTsMsgId: child.tsMsgId,
        recipientKey: 'c-retry',
        owner: { kind: 'retry_send', conversationId: retryConv, retriedTsMsgId: owner.retriedTsMsgId, attempt: '1', retryRoot: owner.retryRoot },
      });
      expect(list).toHaveBeenCalledTimes(3);
      expect(await recordOf(owner)).toMatchObject({ state: 'redriven', redriveCount: 1 });
      expect(got).toEqual([{ providerSid: 'SMroot-1', conversationId: retryConv, attempt: 1 }]);
      expect(lines(30).filter((l) => l['verdict'] === 'found')).toHaveLength(0);
    });

    // ---- the lineage exclusion in the sibling rule (spec section 4 item 13; R4, R12) ----

    it('13 attempt 1 adopted, then attempt 2 never_sent inside the sibling span is RE-DRIVEN - the record that produced the retried row is lineage, not a sibling', async () => {
      register();
      const got = recordJobs(RETRY_SEND_JOB);
      await seedOneToOne();
      const root = await seedRow('SMroot', { providerTs: iso(Date.now() - 30_000) });
      // Attempt 1: its record done/adopted with the retry row it adopted.
      const a1 = rOwner(root, 1);
      const at1 = await reconciling(a1, factsFor(TENANT_PHONE), { at: iso(Date.now() - 20_000) });
      const r1 = await seedRow('SMretry1', { providerTs: iso(Date.now() - 19_000), retryOf: root.tsMsgId, retryAttempt: 1, retryRoot: root.tsMsgId });
      expect(await world.sendAttemptsRepo.closeFromReconcile(a1, at1, { outcome: 'adopted', sid: 'SMretry1' })).toBe(true);
      // Attempt 2 retries r1 and finds nothing.
      const a2 = rOwner(r1, 2);
      expect(a2.retryRoot).toBe(root.tsMsgId);
      const at2 = await reconciling(a2, factsFor(TENANT_PHONE));
      await runChain(payloadOf(a2, at2));
      expect(await recordOf(a2)).toMatchObject({ state: 'redriven', redriveCount: 1 });
      expect(got).toEqual([{ providerSid: 'SMretry1', conversationId: retryConv, attempt: 2 }]);
      expect(lines(50)).toHaveLength(0);
    });

    /** A share's record for a recipient of this number (`contactKey`, c-retry by default) claimed at `atMs`; closed adopted when asked, else left reconciling (open). */
    async function shareRecord(broadcastId: string, atMs: number, adopted: boolean, contactKey = 'c-retry'): Promise<void> {
      const owner: SendAttemptOwner = { kind: 'broadcast', broadcastId, contactKey };
      const at = await reconciling(owner, factsFor(TENANT_PHONE), { at: iso(atMs) });
      if (adopted) {
        expect(await world.sendAttemptsRepo.closeFromReconcile(owner, at, { outcome: 'adopted', sid: `SM${broadcastId}` })).toBe(true);
      }
    }

    it('13a a share root\'s OWN broadcast record, adopted inside the span, is lineage too: attempt 1 on the share root is re-driven', async () => {
      register();
      const got = recordJobs(RETRY_SEND_JOB);
      await seedOneToOne();
      const root = await seedRow('SMroot', { providerTs: iso(Date.now() - 25_000), broadcastId: 'bcast-1' });
      await shareRecord('bcast-1', Date.now() - 20_000, true);
      const a1 = rOwner(root, 1);
      const at = await reconciling(a1, factsFor(TENANT_PHONE));
      await runChain(payloadOf(a1, at));
      expect(await recordOf(a1)).toMatchObject({ state: 'redriven', redriveCount: 1 });
      expect(got).toHaveLength(1);
    });

    it('13a2 an UNRELATED share to the same tenant, still open inside the span, keeps SOR\'s protection: the attempt is unresolved same_fingerprint_sibling although its own share\'s record is excluded', async () => {
      register();
      const got = recordJobs(RETRY_SEND_JOB);
      await seedOneToOne();
      const root = await seedRow('SMroot', { providerTs: iso(Date.now() - 25_000), broadcastId: 'bcast-1' });
      await shareRecord('bcast-1', Date.now() - 20_000, true);
      await shareRecord('bcast-2', Date.now() - 10_000, false);
      const a1 = rOwner(root, 1);
      const at = await reconciling(a1, factsFor(TENANT_PHONE));
      await runChain(payloadOf(a1, at));
      expect(await recordOf(a1)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'same_fingerprint_sibling' });
      expect(got).toEqual([]);
    });

    it('13a3 the SAME share\'s record for ANOTHER contact on this number is not lineage either (R2 #18): it still withholds never_sent', async () => {
      register();
      const got = recordJobs(RETRY_SEND_JOB);
      await seedOneToOne();
      const root = await seedRow('SMroot', { providerTs: iso(Date.now() - 25_000), broadcastId: 'bcast-1' });
      await shareRecord('bcast-1', Date.now() - 20_000, true);
      await shareRecord('bcast-1', Date.now() - 15_000, false, 'c-housemate');
      const a1 = rOwner(root, 1);
      const at = await reconciling(a1, factsFor(TENANT_PHONE));
      await runChain(payloadOf(a1, at));
      expect(await recordOf(a1)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'same_fingerprint_sibling' });
      expect(got).toEqual([]);
    });

    it('13b a MANUAL-retry chain under the same root still blocks (the same root is not lineage): the original chain\'s attempt against the manual row\'s PARENT is not the manual row\'s producer', async () => {
      register();
      const got = recordJobs(RETRY_SEND_JOB);
      await seedOneToOne();
      const root = await seedRow('SMroot', { providerTs: iso(Date.now() - 60_000) });
      // The original chain's attempt 1 against the root, still reconciling.
      await reconciling(rOwner(root, 1), factsFor(TENANT_PHONE), { at: iso(Date.now() - 20_000) });
      // A staff Retry of the root (a manual row: retry_of, no retry_attempt) that itself failed 30003.
      const manual = await seedRow('SMmanual', { providerTs: iso(Date.now() - 15_000), retryOf: root.tsMsgId, retryRoot: root.tsMsgId });
      const m1 = rOwner(manual, 1);
      expect(m1.retryRoot).toBe(root.tsMsgId);
      const at = await reconciling(m1, factsFor(TENANT_PHONE));
      await runChain(payloadOf(m1, at));
      expect(await recordOf(m1)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'same_fingerprint_sibling' });
      expect(got).toEqual([]);
      expect(manual).toMatchObject({ retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' });
    });

    it('13c the ancestry walk stops at a BROKEN retry_of - the rows read so far are still lineage: the producer of the retried row is excluded and attempt 2 is re-driven', async () => {
      register();
      const got = recordJobs(RETRY_SEND_JOB);
      await seedOneToOne();
      // r1's retry_of names a row that is gone; attempt 1 against that missing row produced r1.
      const missing = '2026-09-27T09:00:00.000Z#SMgone';
      const r1 = await seedRow('SMretry1', { providerTs: iso(Date.now() - 19_000), retryOf: missing, retryAttempt: 1, retryRoot: missing });
      const producer: RetrySendOwner = { kind: 'retry_send', conversationId: retryConv, retriedTsMsgId: missing, attempt: 1, recipientKey: 'c-retry', retryRoot: missing };
      const atP = await reconciling(producer, factsFor(TENANT_PHONE), { at: iso(Date.now() - 20_000) });
      expect(await world.sendAttemptsRepo.closeFromReconcile(producer, atP, { outcome: 'adopted', sid: 'SMretry1' })).toBe(true);
      const a2 = rOwner(r1, 2);
      const at2 = await reconciling(a2, factsFor(TENANT_PHONE));
      await runChain(payloadOf(a2, at2));
      expect(await recordOf(a2)).toMatchObject({ state: 'redriven', redriveCount: 1 });
      expect(got).toHaveLength(1);
    });

    /** A staff Retry of `root` (a manual row) whose OWN chain's attempt 1 was adopted inside the span as m1; returns m1. */
    async function manualChainAdopted(root: MessageItem): Promise<MessageItem> {
      const manual = await seedRow('SMmanual', { providerTs: iso(Date.now() - 25_000), retryOf: root.tsMsgId, retryRoot: root.tsMsgId });
      const producer = rOwner(manual, 1);
      const at = await reconciling(producer, factsFor(TENANT_PHONE), { at: iso(Date.now() - 20_000) });
      const m1 = await seedRow('SMmanual-r1', {
        providerTs: iso(Date.now() - 19_000),
        retryOf: manual.tsMsgId,
        retryAttempt: 1,
        retryRoot: root.tsMsgId,
      });
      expect(await world.sendAttemptsRepo.closeFromReconcile(producer, at, { outcome: 'adopted', sid: 'SMmanual-r1' })).toBe(true);
      return m1;
    }

    it('13d under a manual retry\'s own chain the walk reaches the automatic row: its producer (attempt 1 against the MANUAL row) is lineage - attempt 2 is re-driven', async () => {
      register();
      const got = recordJobs(RETRY_SEND_JOB);
      await seedOneToOne();
      const root = await seedRow('SMroot', { providerTs: iso(Date.now() - 60_000) });
      const m1 = await manualChainAdopted(root);
      const a2 = rOwner(m1, 2);
      const at = await reconciling(a2, factsFor(TENANT_PHONE));
      await runChain(payloadOf(a2, at));
      expect(await recordOf(a2)).toMatchObject({ state: 'redriven', redriveCount: 1 });
      expect(got).toEqual([{ providerSid: 'SMmanual-r1', conversationId: retryConv, attempt: 2 }]);
    });

    it('13e the ancestry walk STOPS at the manual row: the original chain\'s attempt beyond it, adopted inside the span, still withholds never_sent', async () => {
      register();
      const got = recordJobs(RETRY_SEND_JOB);
      await seedOneToOne();
      const root = await seedRow('SMroot', { providerTs: iso(Date.now() - 60_000) });
      const a1 = rOwner(root, 1);
      const at1 = await reconciling(a1, factsFor(TENANT_PHONE), { at: iso(Date.now() - 30_000) });
      expect(await world.sendAttemptsRepo.closeFromReconcile(a1, at1, { outcome: 'adopted', sid: 'SMorig-r1' })).toBe(true);
      const m1 = await manualChainAdopted(root);
      const a2 = rOwner(m1, 2);
      const at = await reconciling(a2, factsFor(TENANT_PHONE));
      await runChain(payloadOf(a2, at));
      expect(await recordOf(a2)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'same_fingerprint_sibling' });
      expect(got).toEqual([]);
    });

    // ---- deviation 7 and worklist item 10: a share-RETRY row is never the share's own row ----

    // ---- share-sent-outcome T6: a share retry's outcome reaches the ORIGINAL slot ----

    /**
     * A SHARE root (the retried row of attempt 1): the one-to-one 30003 row
     * stamped with `broadcastId`, and that share (unit unit-1) whose slot
     * c-retry failed 30003 on it. Returns the stored root row.
     */
    async function seedShareRoot(sid = 'SMshare-root', broadcastId = 'b-9'): Promise<MessageItem> {
      const root = await seedRow(sid, { providerTs: iso(Date.now() - 20_000), broadcastId });
      root.retry_due_at = iso(Date.now() + 10_000);
      world.broadcasts.set(broadcastId, {
        broadcastId,
        created_by: 'usr_test',
        created_at: iso(Date.now() - 60_000),
        status: 'sent',
        unitId: 'unit-1',
        audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
        body_template: BODY,
        stats: { audience: 1, sent: 0, delivered: 0, failed: 1, unconfirmed: 0, skipped_opted_out: 0, skipped_no_consent: 0, queued: 0 },
        recipients: { 'c-retry': { status: 'failed', errorCode: '30003', conversationId: retryConv, tsMsgId: root.tsMsgId } },
        updated_at: iso(Date.now() - 60_000),
      });
      return root;
    }
    const shareSlot = (broadcastId = 'b-9') => world.broadcasts.get(broadcastId)!.recipients['c-retry']!;
    const failArmLines = () => capture.atLevel(50).filter((l) => String(l['msg']).includes('share slot write failed'));

    it('share-sent-outcome: adopting a share retry (found, adopted) moves the original slot as a newer attempt BEFORE the record closes - the slot write precedes closeFromReconcile in call order; the ledger counts by delivery', async () => {
      register();
      await seedOneToOne();
      const root = await seedShareRoot();
      const owner = rOwner(root, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE));
      const sentAt = new Date().toISOString();
      plant({ providerSid: 'SMorphan-share', providerStatus: 'delivered', to: TENANT_PHONE, sentAt });
      const slotSpy = vi.spyOn(world.broadcastsRepo, 'applyAttemptOutcome');
      const closeSpy = vi.spyOn(world.sendAttemptsRepo, 'closeFromReconcile');
      await runCheck(payloadOf(owner, at));
      const adopted = retryRow(root.tsMsgId, 1)!;
      expect(adopted).toMatchObject({ broadcast_id: 'b-9', retry_root: root.tsMsgId });
      expect(slotSpy).toHaveBeenCalledTimes(1);
      expect(slotSpy.mock.invocationCallOrder[0]!).toBeLessThan(closeSpy.mock.invocationCallOrder[0]!);
      expect(shareSlot()).toEqual({ status: 'delivered', conversationId: retryConv, tsMsgId: root.tsMsgId, latestAttempt: adopted.tsMsgId, carrierSentAt: sentAt });
      expect(world.broadcasts.get('b-9')!.stats).toMatchObject({ failed: 0, delivered: 1 });
      expect((await world.listingSendsRepo.getByKeyConsistent('unit-1', 'c-retry'))?.shares?.['b-9']).toMatchObject({ attempt: adopted.tsMsgId, state: 'counted', by: 'delivery' });
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan-share' });
      expect(world.emitted.filter((e) => e.event === 'broadcast.updated' && (e.payload as { broadcastId: string }).broadcastId === 'b-9')).toHaveLength(1);
      expect(capture.atLevel(50)).toHaveLength(0);
    });

    it('share-sent-outcome: a transient slot-write fault at the adoption hook is retried and the slot lands', async () => {
      register();
      await seedOneToOne();
      const root = await seedShareRoot();
      const owner = rOwner(root, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE));
      plant({ providerSid: 'SMorphan-share', providerStatus: 'delivered', to: TENANT_PHONE });
      let calls = 0;
      const real = world.broadcastsRepo.applyAttemptOutcome.bind(world.broadcastsRepo);
      world.broadcastsRepo.applyAttemptOutcome = async (...a) => {
        calls += 1;
        if (calls === 1) throw new Error('dynamo blip');
        return real(...a);
      };
      await runCheck(payloadOf(owner, at));
      expect(calls).toBe(2);
      expect(shareSlot().status).toBe('delivered');
      expect(world.broadcasts.get('b-9')!.stats).toMatchObject({ failed: 0, delivered: 1 });
      expect((await recordOf(owner))?.outcome).toBe('adopted');
      expect(failArmLines()).toHaveLength(0);
      expect(capture.atLevel(50)).toHaveLength(0);
    });

    it('share-sent-outcome: a permanent slot-write fault at the adoption hook is ONE ERROR and the record still closes adopted (never a failed check)', async () => {
      register();
      await seedOneToOne();
      const root = await seedShareRoot();
      const owner = rOwner(root, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE));
      plant({ providerSid: 'SMorphan-share', providerStatus: 'delivered', to: TENANT_PHONE });
      let calls = 0;
      world.broadcastsRepo.applyAttemptOutcome = async () => {
        calls += 1;
        throw new Error('Item size has exceeded the maximum allowed size');
      };
      await runCheck(payloadOf(owner, at));
      expect(calls).toBe(3);
      expect(failArmLines()).toHaveLength(1);
      expect(failArmLines()[0]).toMatchObject({ broadcastId: 'b-9', retryRoot: root.tsMsgId });
      expect(capture.atLevel(50)).toHaveLength(1);
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan-share' });
      expect(shareSlot()).toMatchObject({ status: 'failed', errorCode: '30003' });
    });

    it('share-sent-outcome: a process crash between the adoption hook and the record close (the close throws once) leaves the record reconciling; the redelivered check re-finds the adopted row through its child pointer and re-runs the hook as a de-duplicated re-adoption', async () => {
      register();
      await seedOneToOne();
      const root = await seedShareRoot();
      const owner = rOwner(root, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE));
      plant({ providerSid: 'SMorphan-share', providerStatus: 'delivered', to: TENANT_PHONE, sentAt: new Date().toISOString() });
      let thrown = false;
      const realClose = world.sendAttemptsRepo.closeFromReconcile.bind(world.sendAttemptsRepo);
      world.sendAttemptsRepo.closeFromReconcile = async (...a) => {
        if (!thrown) {
          thrown = true;
          throw new Error('crash');
        }
        return realClose(...a);
      };
      await expect(runCheck(payloadOf(owner, at))).rejects.toThrow('crash');
      expect((await recordOf(owner))?.state).toBe('reconciling');
      expect(shareSlot().status).toBe('delivered');   // the hook ran before the close
      const slotWrites = vi.spyOn(world.broadcastsRepo, 'applyAttemptOutcome');
      await runCheck(payloadOf(owner, at));   // the same check, redelivered
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan-share' });
      expect(lines(30).filter((l) => l['verdict'] === 'found').at(-1)).toMatchObject({ adoption: 'skipped', path: 'lookup' });
      expect(slotWrites).not.toHaveBeenCalled();   // the slot already records it: no second write
      expect(world.broadcasts.get('b-9')!.stats).toMatchObject({ failed: 0, delivered: 1 });
      expect(world.messages.filter((m) => m.provider_sid === 'SMorphan-share')).toHaveLength(1);
    });

    it('share-sent-outcome 10a: adopting a share retry whose broadcast item is missing logs WARN and still closes adopted', async () => {
      register();
      await seedOneToOne();
      const share = await seedRow('SMroot-share', { broadcastId: 'bcast-9', author: 'ai', automated: true });
      const owner = rOwner(share, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE));
      plant({ providerSid: 'SMorphan-share', to: TENANT_PHONE });
      await runCheck(payloadOf(owner, at));
      expect(capture.atLevel(40).filter((l) => String(l['msg']).includes('broadcast not found'))).toHaveLength(1);
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan-share' });
      expect(capture.atLevel(50)).toHaveLength(0);
    });

    it('share-sent-outcome: an adopted share retry whose root matches no slot is ONE ERROR (a routing bug) and still closes adopted', async () => {
      register();
      await seedOneToOne();
      const root = await seedShareRoot();
      world.broadcasts.get('b-9')!.recipients = { 'c-retry': { status: 'failed', errorCode: '30003', conversationId: retryConv, tsMsgId: 'another-row' } };
      const owner = rOwner(root, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE));
      plant({ providerSid: 'SMorphan-share', providerStatus: 'delivered', to: TENANT_PHONE });
      await runCheck(payloadOf(owner, at));
      const noSlot = capture.atLevel(50).filter((l) => String(l['msg']).includes('no matching recipient slot'));
      expect(noSlot).toHaveLength(1);
      expect(noSlot[0]).toMatchObject({ event: 'send_reconcile', broadcastId: 'b-9', retryRoot: root.tsMsgId });
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted' });
    });

    it('share-sent-outcome: an unresolved close of a share retry withdraws the promise, then writes send_unconfirmed on the original slot as a row-less attempt; the redelivered check re-applies both as no-ops; ONE unresolved ERROR in total', async () => {
      register();
      const got = recordJobs(RETRY_SEND_JOB);
      await seedOneToOne();
      const root = await seedShareRoot();
      const owner = rOwner(root, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE));
      world.adapter.listMessages = async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      };
      const annotate = vi.spyOn(world.messagesRepo, 'annotateRetryPromise');
      const slotWrites = vi.spyOn(world.broadcastsRepo, 'applyAttemptOutcome');
      await runChain(payloadOf(owner, at));
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'provider_unreachable' });
      // The WITHDRAW first, then the slot.
      expect(annotate.mock.invocationCallOrder[0]!).toBeLessThan(slotWrites.mock.invocationCallOrder[0]!);
      expect(root).toMatchObject({ retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' });
      expect(shareSlot()).toEqual({ status: 'failed', errorCode: SEND_UNCONFIRMED_CODE, conversationId: retryConv, tsMsgId: root.tsMsgId, latestAttempt: rowlessAttemptKey(root.tsMsgId) });
      expect(world.broadcasts.get('b-9')!.stats).toMatchObject({ failed: 0, unconfirmed: 1 });
      expect((await world.listingSendsRepo.getByKeyConsistent('unit-1', 'c-retry'))?.shares?.['b-9']).toMatchObject({ attempt: rowlessAttemptKey(root.tsMsgId), state: 'unconfirmed' });
      expect(capture.atLevel(50)).toHaveLength(1);
      expect(got).toEqual([]);
      // A redelivered last check finds the record done for its own attempt: both re-apply as no-ops.
      await runCheck({ owner: toOwnerRef(owner), attemptedAt: at, checkNo: 2 });
      expect(slotWrites).toHaveBeenCalledTimes(1);
      expect(world.broadcasts.get('b-9')!.stats).toMatchObject({ failed: 0, unconfirmed: 1 });
      expect(capture.atLevel(50)).toHaveLength(1);
    });

    it('share-sent-outcome: at the unresolved close the WITHDRAW runs first - a permanently failing slot write is ONE ERROR, the promise is still withdrawn and the check does not fail', async () => {
      register();
      recordJobs(RETRY_SEND_JOB);
      await seedOneToOne();
      const root = await seedShareRoot();
      const owner = rOwner(root, 1);
      const at = await reconciling(owner, factsFor(TENANT_PHONE));
      world.adapter.listMessages = async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      };
      world.broadcastsRepo.applyAttemptOutcome = async () => {
        throw new Error('Item size has exceeded the maximum allowed size');
      };
      await runChain(payloadOf(owner, at));
      expect(root).toMatchObject({ retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' });
      expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'unresolved' });
      expect(failArmLines()).toHaveLength(1);
      expect(capture.atLevel(50).filter((l) => l['msg'] === 'job failed: send.reconcile')).toHaveLength(0);
      expect(shareSlot()).toMatchObject({ status: 'failed', errorCode: '30003' });
    });

    it('isBroadcastRowFor never claims a share-RETRY row (retry_of set) for the share recipient - not even the row its slot carries (deviation 7)', () => {
      const owner = { broadcastId: 'b-1', contactId: 'c-1', slotTsMsgId: undefined };
      expect(isBroadcastRowFor({ broadcast_id: 'b-1', recipient_contact_id: 'c-1', tsMsgId: 'x' }, owner)).toBe(true);
      expect(isBroadcastRowFor({ broadcast_id: 'b-1', recipient_contact_id: 'c-1', tsMsgId: 'x', retry_of: 'root' }, owner)).toBe(false);
      expect(isBroadcastRowFor({ broadcast_id: 'b-1', tsMsgId: 'x', retry_of: 'root' }, owner)).toBe(false);
      expect(isBroadcastRowFor({ broadcast_id: 'b-1', tsMsgId: 'x', retry_of: 'root' }, { ...owner, slotTsMsgId: 'x' })).toBe(false);
    });

    it('a broadcast attempt whose known SID is a RETRY row of its own share is sid_held_elsewhere, and the holder is named as a message row - never as the share\'s own row (worklist item 10)', async () => {
      register();
      const t = seedTenant();
      seedBroadcast([t.contactId]);
      const conv = await world.conversationsRepo.createOrGetByParticipantPhone(t.phone!, 'tenant_1to1');
      const shareRow = {
        conversationId: conv.conversationId,
        type: 'sms' as const,
        direction: 'outbound' as const,
        author: 'teammate' as const,
        body: BODY,
        broadcastId: 'bcast-1',
        automated: true,
        recipientContactId: t.contactId,
      };
      const root = await world.messagesRepo.append({ ...shareRow, providerSid: 'SMshare-root', providerTs: iso(Date.now() - 60_000), deliveryStatus: 'undelivered', errorCode: '30003' });
      const retry = await world.messagesRepo.append({
        ...shareRow,
        providerSid: 'SMshare-retry',
        providerTs: iso(Date.now()),
        deliveryStatus: 'sent',
        retryOf: root.tsMsgId,
        retryAttempt: 1,
        retryRoot: root.tsMsgId,
      });
      const at = await reconciling(bOwner(t.contactId), factsFor(t.phone!), { sid: 'SMshare-retry' });
      plant({ providerSid: 'SMshare-retry', providerStatus: 'sent', to: t.phone! });
      await runCheck(payloadOf(bOwner(t.contactId), at));
      expect(await recordOf(bOwner(t.contactId))).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'sid_held_elsewhere' });
      expect(lines(50)).toHaveLength(1);
      expect(lines(50)[0]).toMatchObject({ heldBy: `message#${conv.conversationId}#${retry.tsMsgId}` });
      expect(slotOf(t.contactId)).toEqual({ status: 'failed', errorCode: 'send_unconfirmed' });
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
        { kind: 'retry_send', conversationId: 'c', retriedTsMsgId: 'r', attempt: 1, recipientKey: key, retryRoot: 'root' },
      ];
      for (const owner of owners) {
        const ref = toOwnerRef(owner);
        expect(ref.recipientKeyHash).toBe(hashRecipientKey(key));
        expect(JSON.stringify(ref)).not.toContain('phone#+');
      }
    });

    it('retry_send (retry-send-adoption R1): the reference round-trips through the payload - the ids, the NUMERIC attempt and the root carried, the recipient key only as its hash', () => {
      const at = new Date().toISOString();
      for (const recipientKey of ['c-retry', 'phone#+15550100009']) {
        const owner: RetrySendOwner = {
          kind: 'retry_send',
          conversationId: 'conv-1',
          retriedTsMsgId: '2026-09-27T12:00:00.000Z#SMa',
          attempt: 2,
          recipientKey,
          retryRoot: '2026-09-27T11:59:00.000Z#SMroot',
        };
        const ref = toOwnerRef(owner);
        expect(ref).toStrictEqual({
          kind: 'retry_send',
          conversationId: 'conv-1',
          retriedTsMsgId: '2026-09-27T12:00:00.000Z#SMa',
          attempt: 2,
          retryRoot: '2026-09-27T11:59:00.000Z#SMroot',
          recipientKeyHash: hashRecipientKey(recipientKey),
        });
        const parsed = parseSendReconcilePayload(JSON.parse(JSON.stringify({ owner: ref, attemptedAt: at, checkNo: 1 })) as unknown);
        expect(parsed).toStrictEqual({ owner: ref, attemptedAt: at, checkNo: 1 });
        expect(JSON.stringify(parsed)).not.toContain('phone#+');
      }
    });

    it('retry_send: the parser refuses an attempt outside 1..MAX_SEND_RETRY_ATTEMPTS, a fractional or string attempt, and a missing id or root', () => {
      const at = new Date().toISOString();
      const good = { kind: 'retry_send', conversationId: 'conv-1', retriedTsMsgId: 'T#SMa', attempt: 1, retryRoot: 'T0#SMroot', recipientKeyHash: 'c-1' };
      expect(parseSendReconcilePayload({ owner: good, attemptedAt: at, checkNo: 0 }).owner).toStrictEqual(good);
      expect(parseSendReconcilePayload({ owner: { ...good, attempt: MAX_SEND_RETRY_ATTEMPTS }, attemptedAt: at, checkNo: 0 }).owner).toMatchObject({
        attempt: MAX_SEND_RETRY_ATTEMPTS,
      });
      const { attempt: _attempt, ...noAttempt } = good;
      const { retryRoot: _retryRoot, ...noRoot } = good;
      const { conversationId: _conversationId, ...noConversation } = good;
      const { retriedTsMsgId: _retriedTsMsgId, ...noRetried } = good;
      const bad: unknown[] = [
        { ...good, attempt: 0 },
        { ...good, attempt: MAX_SEND_RETRY_ATTEMPTS + 1 },
        { ...good, attempt: '1' },
        { ...good, attempt: 1.5 },
        noAttempt,
        noRoot,
        { ...good, retryRoot: '' },
        noConversation,
        noRetried,
        { ...good, recipientKeyHash: '' },
      ];
      for (const owner of bad) {
        expect(() => parseSendReconcilePayload({ owner, attemptedAt: at, checkNo: 0 }), JSON.stringify(owner)).toThrow(/^sendReconcile: /);
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
