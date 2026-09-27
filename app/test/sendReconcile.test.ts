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
  registerBroadcastSendJobHandler,
  type BroadcastSendPayload,
} from '../src/jobs/broadcastFanOut.js';
import {
  SEND_RECONCILE_JOB,
  reconcileCheckDelaysMs,
  reconcileDelayMs,
  registerSendReconcileJobHandler,
  toOwnerRef,
  type SendReconcilePayload,
} from '../src/jobs/sendReconcile.js';
import { DEV_SESSION_SECRET_DEFAULT, loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { bodyFingerprint, hashRecipientKey, recipientDigest } from '../src/lib/sendFingerprint.js';
import { RECONCILE_CHECK_DELAYS_MS } from '../src/lib/sendOutcome.js';
import type { BroadcastItem, BroadcastRecipient } from '../src/repos/broadcastsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
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

    it('6b a media-only attempt matches a candidate on media count; a long-bodied candidate with the same count is not ours (deviation: the STOP guard)', async () => {
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
