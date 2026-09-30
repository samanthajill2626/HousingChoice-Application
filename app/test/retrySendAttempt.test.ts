// retry-send-adoption (plan Task 4; spec section 4 items 1-9 and 11, R1-R3,
// R9): the one-to-one 30003 automatic retry job `messaging.retrySend` on the
// send-attempt record. The run-once marker is gone: the job claims a
// per-(retried row, attempt) record before its provider call, re-arms it just
// before the call, and resolves every outcome through its arms - an unknown
// outcome goes to the `send.reconcile` job instead of being lost.
//
// Driven through the real jobs envelope machinery over the fake world, with
// the REAL send service and the business number pinned (OUR_NUMBER), so every
// record carries a `sender` and a reconcile can list. WALL CLOCK throughout
// (the job's `now` is unset): rows are seeded relative to Date.now(), because
// the real reconcile runs beside the job in the chain cases. A job the handler
// enqueues NOW (a stale attempt's check 0, the reconcile's re-drive) is
// dispatched at once by the in-process queue and drained by settle(); a delayed
// one lands in `outbound.delayed` with its delay in SECONDS.
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmsSendingDisabledError as AdapterSmsSendingDisabledError } from '../src/adapters/messagingErrors.js';
import type { MediaStore } from '../src/adapters/mediaStore.js';
import { InMemorySchedulerAdapter, InProcessOutboundQueueAdapter } from '../src/adapters/scheduler.js';
import { buildApp } from '../src/app.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
  defineJobHandler,
  dispatchJob,
  enqueue,
} from '../src/jobs/jobs.js';
import type { JobEnvelope } from '../src/jobs/types.js';
import {
  registerRetrySendJobHandler,
  resolveSendRetryBackoffMs,
  RETRY_SEND_JOB,
  type RetrySendJobDeps,
  type RetrySendPayload,
} from '../src/jobs/retrySend.js';
import { reconcileCheckDelaysMs, registerSendReconcileJobHandler, SEND_RECONCILE_JOB } from '../src/jobs/sendReconcile.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import {
  isRetryPromiseLive,
  RETRY_PROMISE_GRACE_MS,
  RETRY_PROMISE_WITHDRAWN_AT,
  RETRY_WINDOW_CLOSED_CODE,
} from '../src/lib/retrySendWindow.js';
import { bodyFingerprint, hashRecipientKey, recipientDigest } from '../src/lib/sendFingerprint.js';
import { SEND_UNCONFIRMED_CODE } from '../src/lib/sendOutcome.js';
import { rowlessAttemptKey } from '../src/lib/shareAttemptOrder.js';
import type { MessageItem, NewMessage } from '../src/repos/messagesRepo.js';
import type { SendAttemptFacts, SendAttemptOwner } from '../src/repos/sendAttemptsRepo.js';
import { createSendMessageService } from '../src/services/sendMessage.js';
import { makeFakeUsersRepo, testUserItem, TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';
import { createFakeWorld, ORIGIN_SECRET, OUR_NUMBER, TENANT_PHONE, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const INFO = 30;
const WARN = 40;
const ERROR = 50;
/** The retried text. Distinctive, so the R9 case can prove no log line carries it. */
const BODY = 'Retry adoption check - your tour is at 4pm on Oak Street';

describe('messaging.retrySend on the send-attempt record (retry-send-adoption T4)', () => {
  let world: FakeWorld;
  let capture: LogCapture;
  let logger: ReturnType<typeof createLogger>;
  let outbound: InProcessOutboundQueueAdapter;
  /** The fake's real send, captured per test so a case can restore it after an override. */
  let originalSend: FakeWorld['adapter']['sendPreparedMessage'];
  /** BUSINESS_PHONE_NUMBER = OUR_NUMBER for the job AND the send service: the record's sender is the number the send pins. */
  const config = loadConfig({
    NODE_ENV: 'test',
    CF_ORIGIN_SECRET: ORIGIN_SECRET,
    MESSAGING_DRIVER: 'console',
    BUSINESS_PHONE_NUMBER: OUR_NUMBER,
  });

  beforeEach(() => {
    _resetForTests();
    capture = createLogCapture();
    logger = createLogger({ level: 'info', destination: capture.stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob, logger });
    configureOutboundQueue(outbound);
    originalSend = world.adapter.sendPreparedMessage;
  });

  afterEach(() => {
    _resetForTests();
    vi.restoreAllMocks();
  });

  const iso = (ms: number): string => new Date(ms).toISOString();

  /** The job over the world's fakes - every dep it reads (a missing one would lazily build a REAL DynamoDB repo) - and the REAL send service. */
  function wire(extra: Partial<RetrySendJobDeps> = {}): void {
    registerRetrySendJobHandler({
      sendMessage: createSendMessageService({
        config,
        logger,
        adapter: world.adapter,
        conversationsRepo: world.conversationsRepo,
        messagesRepo: world.messagesRepo,
        contactsRepo: world.contactsRepo,
        auditRepo: world.auditRepo,
        events: world.events,
      }),
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      conversationsRepo: world.conversationsRepo,
      sendAttemptsRepo: world.sendAttemptsRepo,
      // share-sent-outcome T6: the two unresolved-end arms write a share retry's slot and ledger entry.
      broadcastsRepo: world.broadcastsRepo,
      listingSendsRepo: world.listingSendsRepo,
      config,
      events: world.events,
      logger,
      ...extra,
    });
  }

  /** The REAL reconcile over the same world (sendReconcile.test.ts), for the cases that drive a chain end to end. */
  function registerReconcile(): void {
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

  /**
   * A recording stub for a job the handler enqueues (sendReconcile.test.ts): an
   * IMMEDIATE enqueue (check 0 of an attempt already older than 5 s) is
   * dispatched at once and never lands in `outbound.delayed`; the recorder
   * takes it. ONE registration per job name per test (jobs.ts refuses a
   * second): a case uses this OR registerReconcile, never both.
   */
  function recordJobs(jobName: string): unknown[] {
    const got: unknown[] = [];
    defineJobHandler(jobName, async (p) => {
      got.push(p);
    });
    return got;
  }

  /** The consented tenant every retried row records as its recipient (added once per world). */
  function seedTenant(): void {
    if (world.contacts.some((c) => c.contactId === 'c-real')) return;
    world.contacts.push({
      contactId: 'c-real',
      type: 'tenant',
      status: 'active',
      phone: TENANT_PHONE,
      consent_method: 'verbal_in_person',
    });
  }

  /**
   * A failed 30003 one-to-one row - the RETRIED ROW - in the consented
   * tenant's thread: sent 30 s ago (inside the window), a person's send
   * recorded to c-real, its retry promise due in 10 s. `fields` override the
   * append (a lineage, a share stamp, a send time, `recipientContactId:
   * undefined`), so a retry lineage writes its retrychild# pointer as in
   * production. Returns the STORED row - the live object the fake keeps - so a
   * case sees the job's promise writes on it.
   */
  async function seedRetried(sid: string, fields: Partial<NewMessage> = {}): Promise<MessageItem> {
    seedTenant();
    const conversation = await world.conversationsRepo.createOrGetByParticipantPhone(TENANT_PHONE, 'tenant_1to1');
    await world.messagesRepo.append({
      conversationId: conversation.conversationId,
      providerSid: sid,
      providerTs: iso(Date.now() - 30_000),
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: BODY,
      deliveryStatus: 'undelivered',
      errorCode: '30003',
      automated: false,
      recipientContactId: 'c-real',
      ...fields,
    });
    const row = world.messages.find((m) => m.provider_sid === sid)!;
    row.retry_due_at = iso(Date.now() + 10_000);
    return row;
  }

  /** A plain outbound row in the retried row's thread (noise, or a child when a lineage is spread over it). */
  const outboundRow = (sid: string, atMs: number, conversationId: string): NewMessage => ({
    conversationId,
    providerSid: sid,
    providerTs: iso(atMs),
    type: 'sms',
    direction: 'outbound',
    author: 'teammate',
    body: `noise ${sid}`,
    deliveryStatus: 'delivered',
  });

  /** Attempt `attempt` of the automatic retry of `row` (the RETRIED row), keyed as the job keys it (R1): the root is a fact, not a key. */
  const ownerOf = (row: MessageItem, attempt: number, key = 'c-real'): SendAttemptOwner => ({
    kind: 'retry_send',
    conversationId: row.conversationId,
    retriedTsMsgId: row.tsMsgId,
    attempt,
    recipientKey: key,
    retryRoot: row.retry_root ?? row.tsMsgId,
  });
  const recordOf = (row: MessageItem, attempt = 1, key = 'c-real') => world.sendAttemptsRepo.get(ownerOf(row, attempt, key));

  /** THIS attempt's facts, exactly as the job computes them at the claim (the seeded-record cases). */
  const factsFor = (row: MessageItem): SendAttemptFacts => {
    const fp = bodyFingerprint(row.body);
    return {
      recipientDigest: recipientDigest(OUR_NUMBER, TENANT_PHONE),
      sender: OUR_NUMBER,
      bodyHash: fp.hash,
      bodyShort: fp.short,
      mediaCount: 0,
    };
  };

  /** A record the reconcile re-drove (claim + handToReconcile + markRedriven - the relayRetryLeg.test.ts seedRedriven recipe). */
  async function seedRedriven(owner: SendAttemptOwner, facts: SendAttemptFacts, at = new Date().toISOString()): Promise<void> {
    expect((await world.sendAttemptsRepo.claim(owner, facts, at)).outcome).toBe('claimed');
    expect(await world.sendAttemptsRepo.handToReconcile(owner, { attemptNo: 1, attemptedAt: at })).toBe(true);
    expect(await world.sendAttemptsRepo.markRedriven(owner, at)).toBe(true);
  }

  /** A record a deferral released (claim + finishAttempt retryable). */
  async function seedRetryable(owner: SendAttemptOwner, facts: SendAttemptFacts, at = iso(Date.now() - 60_000)): Promise<void> {
    expect((await world.sendAttemptsRepo.claim(owner, facts, at)).outcome).toBe('claimed');
    expect(
      await world.sendAttemptsRepo.finishAttempt(owner, { attemptNo: 1, attemptedAt: at }, { outcome: 'retryable', cause: '20429' }),
    ).toBe(true);
  }

  /** Enqueue the job NOW (an immediate in-process dispatch) and drain it. A handler throw is swallowed with an ERROR. */
  async function run(row: MessageItem, attempt = 1, extra: Partial<RetrySendPayload> = {}): Promise<void> {
    await enqueue(RETRY_SEND_JOB, { providerSid: row.provider_sid, conversationId: row.conversationId, attempt, ...extra });
    await outbound.settle();
  }

  /** A job envelope taken off the queue undelivered, so a case dispatches it itself: its jobId is known and a handler throw PROPAGATES. */
  async function envelopeFor(row: MessageItem, attempt = 1, extra: Partial<RetrySendPayload> = {}): Promise<JobEnvelope> {
    const envelope = await enqueue(
      RETRY_SEND_JOB,
      { providerSid: row.provider_sid, conversationId: row.conversationId, attempt, ...extra },
      { runAt: new Date(Date.now() + 600_000) },
    );
    const index = outbound.delayed.findIndex((d) => d.envelope.jobId === envelope.jobId);
    outbound.delayed.splice(index, 1);
    return envelope;
  }
  const dispatch = (envelope: JobEnvelope): Promise<void> => dispatchJob(JSON.parse(JSON.stringify(envelope)) as unknown);

  const reconcileEnvelopes = () => outbound.delayed.filter((d) => d.envelope.jobName === SEND_RECONCILE_JOB);
  /** Every send.reconcile hand-off the job made: the delayed envelopes still queued plus the immediate ones a recorder took. */
  const reconcileHandOffs = (recorded: unknown[]): unknown[] => [...reconcileEnvelopes().map((d) => d.envelope.payload), ...recorded];
  const retryEnvelopes = () => outbound.delayed.filter((d) => d.envelope.jobName === RETRY_SEND_JOB);
  const retryPayloads = () => retryEnvelopes().map((d) => d.envelope.payload as RetrySendPayload);

  /** Run every send.reconcile check the chain schedules, to its end (the sendReconcile.test.ts runNextCheck idiom). */
  async function runReconcileChain(): Promise<void> {
    while (reconcileEnvelopes().length > 0) {
      const index = outbound.delayed.findIndex((d) => d.envelope.jobName === SEND_RECONCILE_JOB);
      const [item] = outbound.delayed.splice(index, 1);
      await dispatchJob(JSON.parse(JSON.stringify(item!.envelope)) as unknown);
      await outbound.settle();
    }
  }

  /** Every provider call, whatever the current override answers. Bind it BEFORE the run and AFTER any override (a new spy per call). */
  const providerCalls = () => vi.spyOn(world.adapter, 'sendPreparedMessage');
  const unknownOn = (): void => {
    world.adapter.sendPreparedMessage = async () => {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    };
  };
  /** A 4xx status is what makes an unlisted code `rejected` (sendOutcome.ts). */
  const rejectWith = (code: number): void => {
    world.adapter.sendPreparedMessage = async () => {
      throw Object.assign(new Error(`rejected ${code}`), { code, status: 400 });
    };
  };
  const throttle = (): void => {
    world.adapter.sendPreparedMessage = async () => {
      throw Object.assign(new Error('too many requests'), { code: 20429, status: 429 });
    };
  };

  /** The queue refuses the enqueues `refuses` picks (the sendReconcile.test.ts case-17 seam); every other one passes through. */
  function refuseEnqueues(refuses: (jobName: string, delaySeconds: number) => boolean): void {
    configureOutboundQueue({
      async enqueue(envelope, opts) {
        if (refuses(envelope.jobName, opts?.delaySeconds ?? 0)) throw new Error('queue down');
        return outbound.enqueue(envelope, opts);
      },
    });
  }

  const persistedFor = (tsMsgId: string) =>
    world.emitted.filter((e) => e.event === 'message.persisted' && (e.payload as { tsMsgId: string }).tsMsgId === tsMsgId);
  const msgLines = (level: number, msg: string) => capture.atLevel(level).filter((l) => l['msg'] === msg);
  /** The REFRESH an unknown hand-off writes: the whole reconcile schedule plus the promise grace (R3). */
  const handOffDueAt = (attemptedAt: string): string =>
    iso(Date.parse(attemptedAt) + reconcileCheckDelaysMs()[2]! + RETRY_PROMISE_GRACE_MS);

  // ---- the unknown outcome (the anchor) ----------------------------------------

  it('1 FAILS ON MAIN: an unknown provider error (a dropped socket) no longer rethrows - the job returns, the record is reconciling, ONE send.reconcile hand-off carries the retry_send owner with no phone, and the retried row\'s promise is refreshed and emitted', async () => {
    wire();
    const recorded = recordJobs(SEND_RECONCILE_JOB);
    unknownOn();
    const row = await seedRetried('SMroot1');
    const before = row.retry_due_at!;
    await run(row);
    const record = await recordOf(row);
    expect(record).toMatchObject({ state: 'reconciling', attemptNo: 1, sender: OUR_NUMBER, mediaCount: 0 });
    // A fresh attempt's check 0 runs 5 s after it: it waits in outbound.delayed.
    const handOffs = reconcileHandOffs(recorded);
    expect(handOffs).toEqual([
      {
        owner: {
          kind: 'retry_send',
          conversationId: row.conversationId,
          retriedTsMsgId: row.tsMsgId,
          attempt: 1,
          retryRoot: row.tsMsgId,
          recipientKeyHash: 'c-real',
        },
        attemptedAt: record!.attemptedAt,
        checkNo: 0,
      },
    ]);
    expect(reconcileEnvelopes()[0]!.delaySeconds).toBeGreaterThan(0);
    expect(JSON.stringify(handOffs)).not.toContain(TENANT_PHONE);
    expect(JSON.stringify(handOffs)).not.toContain('phone#');
    // REFRESHED to cover the whole reconcile schedule, and announced for the retried row.
    expect(row.retry_due_at).toBe(handOffDueAt(record!.attemptedAt));
    expect(Date.parse(row.retry_due_at!)).toBeGreaterThan(Date.parse(before) + RETRY_PROMISE_GRACE_MS);
    expect(persistedFor(row.tsMsgId)).toHaveLength(1);
    expect(msgLines(INFO, 'retrySend: retry outcome unknown - handed to reconcile')).toHaveLength(1);
    // Nothing threw: no handler failure, no swallowed dispatch error, no ERROR at all.
    expect(capture.atLevel(ERROR)).toHaveLength(0);
    expect(world.messages.filter((m) => m.retry_of !== undefined)).toEqual([]);
  });

  it('1b a phone-keyed attempt (no recorded recipient) hashes its key: the hand-off carries recipientKeyHash = hashRecipientKey(phone#...) and never the number', async () => {
    wire();
    const recorded = recordJobs(SEND_RECONCILE_JOB);
    unknownOn();
    const row = await seedRetried('SMphone1', { recipientContactId: undefined });
    await run(row);
    const phoneKey = `phone#${TENANT_PHONE}`;
    expect(await recordOf(row, 1, phoneKey)).toMatchObject({ state: 'reconciling' });
    const handOffs = reconcileHandOffs(recorded);
    expect(handOffs).toHaveLength(1);
    expect(handOffs[0]).toMatchObject({ owner: { kind: 'retry_send', recipientKeyHash: hashRecipientKey(phoneKey) } });
    expect(hashRecipientKey(phoneKey)).toMatch(/^phonehash#[0-9a-f]{32}$/);
    expect(JSON.stringify(handOffs)).not.toContain(TENANT_PHONE);
    expect(JSON.stringify(handOffs)).not.toContain('phone#');
    // The log line names the key only redacted.
    expect(msgLines(INFO, 'retrySend: retry outcome unknown - handed to reconcile')[0]).toMatchObject({ recipientKey: 'phone#redacted' });
  });

  it('1c an unknown outcome on a RE-DRIVEN attempt gets no second reconcile (SOR D13a): record done/unresolved cause second_unknown, the retried row\'s promise WITHDRAWN - retry not confirmed - ONE ERROR, no hand-off', async () => {
    wire();
    unknownOn();
    const row = await seedRetried('SMroot1');
    await seedRedriven(ownerOf(row, 1), factsFor(row));
    await run(row);
    expect(await recordOf(row)).toMatchObject({
      state: 'done',
      outcome: 'unresolved',
      cause: 'second_unknown',
      attemptNo: 2,
      redriveCount: 1,
    });
    expect(row).toMatchObject({ retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' });
    expect(persistedFor(row.tsMsgId)).toHaveLength(1);
    expect(reconcileEnvelopes()).toHaveLength(0);
    expect(capture.atLevel(ERROR)).toEqual([
      expect.objectContaining({
        msg: 'retrySend: unknown send outcome after a re-drive - attempt closed unresolved; the retry promise is withdrawn',
        cause: 'second_unknown',
        outcome: 'unresolved',
      }),
    ]);
  });

  it('1d a reconcile hand-off whose enqueue fails closes the attempt unresolved enqueue_failed (a send may have happened) and WITHDRAWS the promise, ONE ERROR', async () => {
    wire();
    unknownOn();
    refuseEnqueues((jobName) => jobName === SEND_RECONCILE_JOB);
    const row = await seedRetried('SMroot1');
    await run(row);
    expect(await recordOf(row)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'enqueue_failed' });
    expect(row).toMatchObject({ retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' });
    expect(persistedFor(row.tsMsgId)).toHaveLength(1);
    expect(capture.atLevel(ERROR)).toEqual([
      expect.objectContaining({
        msg: 'retrySend: reconcile enqueue failed - attempt closed unresolved; the retry promise is withdrawn',
        cause: 'enqueue_failed',
        outcome: 'unresolved',
      }),
    ]);
  });

  // ---- the terminal arms --------------------------------------------------------

  it('2 a rejected retry (21211 with a 4xx status): record done/rejected cause 21211, no retry row, the retried row keeps its 30003 and its promise, ONE ERROR', async () => {
    wire();
    rejectWith(21211);
    const row = await seedRetried('SMroot1');
    const before = row.retry_due_at;
    const annotate = vi.spyOn(world.messagesRepo, 'annotateRetryPromise');
    await run(row);
    expect(await recordOf(row)).toMatchObject({ state: 'done', outcome: 'rejected', cause: '21211' });
    expect(world.messages.filter((m) => m.retry_of !== undefined)).toEqual([]);
    expect(row).toMatchObject({ delivery_status: 'undelivered', error_code: '30003', retry_due_at: before });
    expect(annotate).not.toHaveBeenCalled();
    const errors = capture.atLevel(ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      msg: 'retrySend: retry chain ended - provider rejected the retry',
      errorCode: '21211',
      status: 400,
      outcome: 'rejected',
      cause: '21211',
      retryRoot: row.tsMsgId,
      retriedTsMsgId: row.tsMsgId,
      attempt: 1,
    });
  });

  it('2a the ADAPTER\'s kill switch (sms_sending_disabled, classified rejected) is a refusal: record done/refused cause sms_sending_disabled at WARN, no ERROR (plan deviation 2)', async () => {
    wire();
    world.adapter.sendPreparedMessage = async () => {
      throw new AdapterSmsSendingDisabledError('SMS sending is disabled (pre-A2P)');
    };
    const row = await seedRetried('SMroot1');
    const before = row.retry_due_at;
    await run(row);
    expect(await recordOf(row)).toMatchObject({ state: 'done', outcome: 'refused', cause: 'sms_sending_disabled' });
    expect(row.retry_due_at).toBe(before);
    expect(msgLines(WARN, 'retrySend: send refused - retry chain stopped')).toEqual([
      expect.objectContaining({ refusal: 'sms_sending_disabled', outcome: 'refused', cause: 'sms_sending_disabled' }),
    ]);
    expect(capture.atLevel(ERROR)).toHaveLength(0);
  });

  it('3 a refused retry (the contact opted out during the backoff): record done/refused cause contact_opted_out, the promise untouched, WARN, no provider call', async () => {
    wire();
    const row = await seedRetried('SMroot1');
    const before = row.retry_due_at;
    world.contacts.find((c) => c.contactId === 'c-real')!.sms_opt_out = true;
    const calls = providerCalls();
    await run(row);
    expect(await recordOf(row)).toMatchObject({ state: 'done', outcome: 'refused', cause: 'contact_opted_out' });
    expect(row.retry_due_at).toBe(before);
    expect(calls).not.toHaveBeenCalled();
    expect(world.sent).toHaveLength(0);
    expect(msgLines(WARN, 'retrySend: send refused - retry chain stopped')).toEqual([
      expect.objectContaining({ refusal: 'contact_opted_out', outcome: 'refused' }),
    ]);
    expect(capture.atLevel(ERROR)).toHaveLength(0);
  });

  // ---- the deferral (item 4) ------------------------------------------------------

  it('4 a 429 is deferred ONCE: the same payload re-enqueued with deferred: true at the RSW backoff, record done/retryable, the promise refreshed to the run time and emitted; the re-claimed run sends once', async () => {
    wire();
    throttle();
    const row = await seedRetried('SMroot1');
    await run(row);
    const deferred = retryEnvelopes();
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.envelope.payload).toEqual({ providerSid: 'SMroot1', conversationId: row.conversationId, attempt: 1, deferred: true });
    expect(deferred[0]!.delaySeconds).toBe(Math.round(resolveSendRetryBackoffMs(1) / 1000));
    expect(await recordOf(row)).toMatchObject({ state: 'done', outcome: 'retryable', cause: '20429', attemptNo: 1 });
    expect(Date.parse(row.retry_due_at!)).toBeGreaterThanOrEqual(Date.now() + resolveSendRetryBackoffMs(1) - 5_000);
    expect(persistedFor(row.tsMsgId)).toHaveLength(1);
    expect(msgLines(WARN, 'retrySend: retry deferred - re-scheduled')).toEqual([
      expect.objectContaining({ cause: '20429', outcome: 'retryable', runAt: row.retry_due_at }),
    ]);
    // The deferred run claims from done/retryable and sends (the fake's real send restored).
    world.adapter.sendPreparedMessage = originalSend;
    await outbound.deliverDelayed(dispatchJob);
    expect(world.sent).toHaveLength(1);
    expect(await recordOf(row)).toMatchObject({ state: 'done', outcome: 'sent', attemptNo: 2, sid: world.sentDetails[0]!.sid });
  });

  it('4-cap a 429 on a deferred payload ends the chain: record done/refused cause deferral_cap, ONE ERROR, no third enqueue, the promise untouched; a later delivery of that job is skipped by the gate and never reaches the provider', async () => {
    wire();
    throttle();
    const calls = providerCalls();
    const row = await seedRetried('SMroot1');
    const before = row.retry_due_at;
    await run(row, 1, { deferred: true });
    expect(await recordOf(row)).toMatchObject({ state: 'done', outcome: 'refused', cause: 'deferral_cap', attemptNo: 1 });
    expect(retryEnvelopes()).toHaveLength(0);
    expect(row.retry_due_at).toBe(before);
    expect(capture.atLevel(ERROR)).toEqual([
      expect.objectContaining({ msg: 'retrySend: retry deferred twice - chain ended', cause: 'deferral_cap', outcome: 'refused' }),
    ]);
    expect(calls).toHaveBeenCalledTimes(1);
    await run(row, 1, { deferred: true });
    // The provider was NOT called again (world.sent is 0 either way: the throttle throws before the fake records).
    expect(calls).toHaveBeenCalledTimes(1);
    expect(await recordOf(row)).toMatchObject({ state: 'done', outcome: 'refused', attemptNo: 1 });
    expect(capture.atLevel(INFO).filter((l) => l['gate'] === 'skip')).toHaveLength(1);
  });

  it('4-window a deferral whose run time would fall past the window ends the chain: done/refused cause retry_window_closed, ONE ERROR, no re-enqueue, the promise untouched', async () => {
    wire();
    throttle();
    // Inside the window at job time; the 60 s backoff plus the grace lands past it.
    const row = await seedRetried('SMroot1', { providerTs: iso(Date.now() - 14.5 * 60_000) });
    const before = row.retry_due_at;
    await run(row);
    expect(await recordOf(row)).toMatchObject({ state: 'done', outcome: 'refused', cause: RETRY_WINDOW_CLOSED_CODE });
    expect(retryEnvelopes()).toHaveLength(0);
    expect(row.retry_due_at).toBe(before);
    expect(capture.atLevel(ERROR)).toEqual([
      expect.objectContaining({
        msg: 'retrySend: retry window closed - a deferred re-run would land past the window; chain ended',
        cause: RETRY_WINDOW_CLOSED_CODE,
        outcome: 'refused',
      }),
    ]);
  });

  it('4-enqueue a deferral whose re-enqueue fails ends the chain: record done/refused cause enqueue_failed, ONE ERROR, the promise untouched, nothing sent', async () => {
    wire();
    throttle();
    refuseEnqueues((jobName, delaySeconds) => jobName === RETRY_SEND_JOB && delaySeconds > 0);
    const row = await seedRetried('SMroot1');
    const before = row.retry_due_at;
    await run(row);
    expect(await recordOf(row)).toMatchObject({ state: 'done', outcome: 'refused', cause: 'enqueue_failed' });
    expect(retryEnvelopes()).toHaveLength(0);
    expect(row.retry_due_at).toBe(before);
    expect(row).not.toHaveProperty('retry_outcome');
    expect(capture.atLevel(ERROR)).toEqual([
      expect.objectContaining({ msg: 'retrySend: retry re-schedule failed - chain ended', cause: 'enqueue_failed', outcome: 'refused' }),
    ]);
  });

  it('4-prepare nothing sent is deferred too: a presign that throws (the prepare phase) and a wrapper failure before its provider call (SendNotAttemptedError) each release the record retryable cause send_retryable and re-enqueue once', async () => {
    const failingStore = {
      async presign() {
        throw new Error('presign exploded');
      },
    } as unknown as MediaStore;
    wire({ mediaStore: failingStore });
    const calls = providerCalls();
    // (1) The presign throws. The plan had the attachment, so the claim recorded mediaCount 1.
    const withMedia = await seedRetried('SMmedia1', { mediaAttachments: [{ s3Key: 'uploads/aaaa', contentType: 'image/png' }] });
    await run(withMedia);
    expect(await recordOf(withMedia)).toMatchObject({ state: 'done', outcome: 'retryable', cause: 'send_retryable', mediaCount: 1 });
    // (2) The wrapper's own contact read throws before the provider call.
    const plain = await seedRetried('SMplain1');
    vi.spyOn(world.contactsRepo, 'findByPhone').mockRejectedValueOnce(new Error('contact read exploded'));
    await run(plain);
    expect(await recordOf(plain)).toMatchObject({ state: 'done', outcome: 'retryable', cause: 'send_retryable' });
    expect(calls).not.toHaveBeenCalled();
    expect(retryPayloads().map((p) => [p.providerSid, p.deferred])).toEqual([
      ['SMmedia1', true],
      ['SMplain1', true],
    ]);
    expect(msgLines(WARN, 'retrySend: retry deferred - re-scheduled')).toHaveLength(2);
    expect(capture.atLevel(ERROR)).toHaveLength(0);
  });

  it('4-redriven a re-DRIVEN run\'s first 429 still gets its deferral (the re-drive payload carries no deferred)', async () => {
    wire();
    throttle();
    const row = await seedRetried('SMroot1');
    await seedRedriven(ownerOf(row, 1), factsFor(row));
    await run(row);
    expect(await recordOf(row)).toMatchObject({ state: 'done', outcome: 'retryable', attemptNo: 2, redriveCount: 1 });
    expect(retryPayloads()).toEqual([{ providerSid: 'SMroot1', conversationId: row.conversationId, attempt: 1, deferred: true }]);
  });

  it('4-lost a LOST release after the deferral enqueue refreshes NOTHING and logs no re-scheduled line; a THROWN release still refreshes the promise (the deferred job is live) and names the strand at ERROR', async () => {
    wire();
    throttle();
    const finish = vi.spyOn(world.sendAttemptsRepo, 'finishAttempt');
    // Sub-case 1: the release's fence LOST (a takeover owns the record). Its own row: the
    // fake keeps records between sub-cases, and this one stays attempting.
    const lost = await seedRetried('SMlost1');
    const lostBefore = lost.retry_due_at;
    finish.mockResolvedValueOnce(false);
    await run(lost);
    expect(retryPayloads().filter((p) => p.providerSid === 'SMlost1')).toHaveLength(1); // enqueued FIRST
    expect(lost.retry_due_at).toBe(lostBefore);
    expect(msgLines(INFO, 'retrySend: attempt close lost its fence - the takeover owns the record')).toEqual([
      expect.objectContaining({ outcome: 'retryable', cause: '20429' }),
    ]);
    expect(msgLines(WARN, 'retrySend: retry deferred - re-scheduled')).toHaveLength(0);
    expect(await recordOf(lost)).toMatchObject({ state: 'attempting' });
    expect(capture.atLevel(ERROR)).toHaveLength(0);
    // Sub-case 2: the release THREW (it may or may not have committed).
    const threw = await seedRetried('SMlost2');
    finish.mockRejectedValueOnce(new Error('release exploded'));
    await run(threw);
    const threwPayloads = retryPayloads().filter((p) => p.providerSid === 'SMlost2');
    expect(threwPayloads).toEqual([{ providerSid: 'SMlost2', conversationId: threw.conversationId, attempt: 1, deferred: true }]);
    expect(Date.parse(threw.retry_due_at!)).toBeGreaterThanOrEqual(Date.now() + resolveSendRetryBackoffMs(1) - 5_000);
    expect(persistedFor(threw.tsMsgId)).toHaveLength(1);
    expect(await recordOf(threw)).toMatchObject({ state: 'attempting' });
    expect(capture.atLevel(ERROR).map((l) => l['msg'])).toEqual([
      'failure-arm write failed (best-effort); the attempt record decides',
      'retrySend: retry re-scheduled but its record release threw - the record may still be attempting; the deferred run meets whatever it left (a takeover past the claim TTL, else a strand for the sweeper)',
    ]);
    expect(msgLines(WARN, 'retrySend: retry deferred - re-scheduled')).toHaveLength(0);
  });

  // ---- the gates before the claim -------------------------------------------------

  it('4b records are per RETRIED ROW: a manual Retry row that fails 30003 starts a chain whose attempt-1 record keys on the manual row and CLAIMS, although the root\'s chain already ran three attempts (Review Focus 4)', async () => {
    wire();
    const root = await seedRetried('SMroot1', { providerTs: iso(Date.now() - 60_000) });
    for (const attempt of [1, 2, 3]) {
      const at = iso(Date.now() - 50_000 + attempt * 1_000);
      expect((await world.sendAttemptsRepo.claim(ownerOf(root, attempt), factsFor(root), at)).outcome).toBe('claimed');
      expect(
        await world.sendAttemptsRepo.finishAttempt(ownerOf(root, attempt), { attemptNo: 1, attemptedAt: at }, { outcome: 'sent', sid: `SMold${attempt}` }),
      ).toBe(true);
    }
    // A staff Retry of the root: retry_of, no retry_attempt - and it failed 30003 too.
    const manual = await seedRetried('SMmanual1', { retryOf: root.tsMsgId });
    await run(manual);
    expect(world.sent).toHaveLength(1);
    expect(await recordOf(manual)).toMatchObject({
      state: 'done',
      outcome: 'sent',
      attemptNo: 1,
      owner: { kind: 'retry_send', retriedTsMsgId: manual.tsMsgId, attempt: 1, retryRoot: root.tsMsgId },
    });
    expect(world.messages.find((m) => m.retry_of === manual.tsMsgId)).toMatchObject({ retry_attempt: 1, retry_root: root.tsMsgId });
    expect(world.sendAttempts.size).toBe(4);
  });

  it('4c a manual retry supersedes the chain: with a MANUAL child of the retried row already appended the job declines at INFO before claiming - on a first run (no record), on a deferral re-run (done/retryable, nothing written) and on a re-drive (redriven closed refused); the check is ONE retrychild# Query that finds the child among 60 newer unrelated rows (an AUTOMATIC child is case 4c2\'s)', async () => {
    wire();
    const superseded = 'retrySend: a manual retry superseded this attempt';
    const row = await seedRetried('SMroot1');
    const t = Date.now();
    await world.messagesRepo.append({ ...outboundRow('SMmanual', t + 1_000, row.conversationId), retryOf: row.tsMsgId, automated: false });
    for (let i = 0; i < 60; i += 1) await world.messagesRepo.append(outboundRow(`SMnoise${i}`, t + 2_000 + i, row.conversationId));
    const list = vi.spyOn(world.messagesRepo, 'listRetryChildrenConsistent');
    // Never a thread scan - the fake's consistent read delegates through the eventual one, so both are watched.
    const scanConsistent = vi.spyOn(world.messagesRepo, 'listByConversationConsistent');
    const scanEventual = vi.spyOn(world.messagesRepo, 'listByConversation');
    const calls = providerCalls();
    // (1) a first run: no record, nothing written.
    await run(row);
    expect(calls).not.toHaveBeenCalled();
    expect(await recordOf(row)).toBeUndefined();
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(row.conversationId, row.tsMsgId);
    expect(scanConsistent).not.toHaveBeenCalled();
    expect(scanEventual).not.toHaveBeenCalled();
    expect(msgLines(INFO, superseded)).toEqual([expect.objectContaining({ cause: 'manual_retry_superseded', retriedTsMsgId: row.tsMsgId })]);
    // (2) a deferral re-run over done/retryable: declines, writes nothing.
    await seedRetryable(ownerOf(row, 1), factsFor(row));
    const released = await recordOf(row);
    await run(row, 1, { deferred: true });
    expect(await recordOf(row)).toEqual(released);
    expect(calls).not.toHaveBeenCalled();
    // (3) a re-drive over a redriven record: declines and closes it refused.
    const row2 = await seedRetried('SMroot2');
    await world.messagesRepo.append({ ...outboundRow('SMmanual2', Date.now() + 1_000, row2.conversationId), retryOf: row2.tsMsgId, automated: false });
    await seedRedriven(ownerOf(row2, 1), factsFor(row2));
    await run(row2);
    expect(await recordOf(row2)).toMatchObject({ state: 'done', outcome: 'refused', cause: 'manual_retry_superseded' });
    expect(calls).not.toHaveBeenCalled();
    expect(msgLines(INFO, superseded)).toHaveLength(3);
  });

  it('4c2 THIS attempt already appended its retry row (FW2, planner review A1): an AUTOMATIC child carrying the payload\'s attempt number is this attempt\'s own text - the job declines at WARN before claiming, with zero provider calls - on a first run (no record, nothing written), on a re-drive (redriven closed done/refused already_sent) and on a deferral re-run (done/retryable, nothing written); an automatic child of ANOTHER attempt number is unreachable (FW3, planner re-review R2): the one job that could append it - a payload naming attempt 2 against a ROOT, here beside the root\'s own attempt-1 retry row - is refused at step 1 with no provider call and no record; seeded-only (unreachable in production), such a child does not decline a consistent payload: the job claims and sends once', async () => {
    wire();
    const alreadySent = 'retrySend: this attempt already appended its retry row - not re-sent';
    /** A fresh retried row with an automatic child of attempt `childAttempt` (its retrychild# pointer rides the append); each sub-case has its own row - the fake keeps records between sub-cases. */
    async function withAutomaticChild(sid: string, childAttempt: number): Promise<{ row: MessageItem; child: MessageItem }> {
      const row = await seedRetried(sid);
      await world.messagesRepo.append({
        ...outboundRow(`${sid}-r`, Date.now() + 1_000, row.conversationId),
        retryOf: row.tsMsgId,
        retryAttempt: childAttempt,
        retryRoot: row.tsMsgId,
      });
      return { row, child: world.messages.find((m) => m.provider_sid === `${sid}-r`)! };
    }
    const annotate = vi.spyOn(world.messagesRepo, 'annotateRetryPromise');
    const calls = providerCalls();
    // (1) a first run: no record - nothing written, nothing sent.
    const first = await withAutomaticChild('SMown1', 1);
    const firstDue = first.row.retry_due_at;
    await run(first.row);
    expect(calls).not.toHaveBeenCalled();
    expect(await recordOf(first.row)).toBeUndefined();
    expect(first.row.retry_due_at).toBe(firstDue);
    expect(msgLines(WARN, alreadySent)).toEqual([
      expect.objectContaining({
        cause: 'already_sent',
        providerSid: 'SMown1',
        conversationId: first.row.conversationId,
        retriedTsMsgId: first.row.tsMsgId,
        retryRoot: first.row.tsMsgId,
        attempt: 1,
        recipientKey: 'c-real',
        childTsMsgId: first.child.tsMsgId,
        childProviderSid: 'SMown1-r',
      }),
    ]);
    // (2) a re-drive over a redriven record: declines and closes it done/refused already_sent.
    const redriven = await withAutomaticChild('SMown2', 1);
    await seedRedriven(ownerOf(redriven.row, 1), factsFor(redriven.row));
    await run(redriven.row);
    expect(await recordOf(redriven.row)).toMatchObject({ state: 'done', outcome: 'refused', cause: 'already_sent', redriveCount: 1 });
    expect(calls).not.toHaveBeenCalled();
    // (3) a deferral re-run over done/retryable: declines, writes nothing.
    const retryable = await withAutomaticChild('SMown3', 1);
    await seedRetryable(ownerOf(retryable.row, 1), factsFor(retryable.row));
    const released = await recordOf(retryable.row);
    await run(retryable.row, 1, { deferred: true });
    expect(await recordOf(retryable.row)).toEqual(released);
    expect(calls).not.toHaveBeenCalled();
    // ONE WARN per decline; no other decline fired, nothing at ERROR, no promise write.
    expect(msgLines(WARN, alreadySent).map((l) => [l['providerSid'], l['cause'], l['childProviderSid']])).toEqual([
      ['SMown1', 'already_sent', 'SMown1-r'],
      ['SMown2', 'already_sent', 'SMown2-r'],
      ['SMown3', 'already_sent', 'SMown3-r'],
    ]);
    expect(msgLines(INFO, 'retrySend: a manual retry superseded this attempt')).toHaveLength(0);
    expect(capture.atLevel(ERROR)).toHaveLength(0);
    expect(annotate).not.toHaveBeenCalled();
    expect(world.sent).toHaveLength(0);
    // (4) FW3 (planner re-review R2): an automatic child of ANOTHER attempt number could only be appended by a
    // payload the retried row cannot schedule - attempt 2 against a ROOT, whose one attempt is 1. That job is
    // refused at step 1, even beside the root's own attempt-1 retry row: no provider call, no record at attempt
    // 1 or 2, ONE WARN naming both numbers.
    const cannotSchedule = "retrySend: the payload's attempt is not the one the retried row can schedule - refusing";
    const wrongAttempt = await withAutomaticChild('SMown4', 1);
    await run(wrongAttempt.row, 2);
    expect(calls).not.toHaveBeenCalled();
    expect(await recordOf(wrongAttempt.row, 1)).toBeUndefined();
    expect(await recordOf(wrongAttempt.row, 2)).toBeUndefined();
    expect(msgLines(WARN, cannotSchedule)).toEqual([
      expect.objectContaining({ providerSid: 'SMown4', conversationId: wrongAttempt.row.conversationId, attempt: 2, rowAttempt: 1 }),
    ]);
    expect(world.sent).toHaveLength(0);
    // (5) seeded-only (unreachable in production): a root SEEDED with an automatic child of attempt 2, run with a
    // CONSISTENT payload (attempt 1) - step 4a's carve-out stays as written: the job claims and sends once.
    const seededOnly = await withAutomaticChild('SMown5', 2);
    await run(seededOnly.row);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(await recordOf(seededOnly.row)).toMatchObject({ state: 'done', outcome: 'sent', attemptNo: 1 });
    expect(world.sent).toHaveLength(1);
    expect(msgLines(WARN, alreadySent)).toHaveLength(3);
    expect(msgLines(WARN, cannotSchedule)).toHaveLength(1);
  });

  it('4d an existing attempt is resolved BEFORE the window: a stale attempting record (31 s) with the window already closed is taken over into reconcile, not logged window_closed; a deferral re-run whose run time slipped past the window declines "retry window closed" and sends nothing (RSW #1)', async () => {
    wire();
    // The takeover's hand-off is check 0 of a 31 s-old attempt: IMMEDIATE, taken by the recorder.
    const recorded = recordJobs(SEND_RECONCILE_JOB);
    const calls = providerCalls();
    // Sub-case 1: its own row (the fake keeps records between sub-cases).
    const stale = await seedRetried('SMstale1', { providerTs: iso(Date.now() - 16 * 60_000) });
    const at = iso(Date.now() - 31_000);
    expect((await world.sendAttemptsRepo.claim(ownerOf(stale, 1), factsFor(stale), at)).outcome).toBe('claimed');
    await run(stale);
    expect(await recordOf(stale)).toMatchObject({ state: 'reconciling', attemptedAt: at });
    expect(recorded).toHaveLength(1);
    expect(capture.atLevel(ERROR).filter((l) => l['retryDecision'] === 'window_closed')).toHaveLength(0);
    expect(calls).not.toHaveBeenCalled();
    // Sub-case 2: a done/retryable record whose deferred run found the window closed.
    const slipped = await seedRetried('SMslip1', { providerTs: iso(Date.now() - 16 * 60_000) });
    await seedRetryable(ownerOf(slipped, 1), factsFor(slipped));
    const released = await recordOf(slipped);
    await run(slipped, 1, { deferred: true });
    expect(capture.atLevel(ERROR).filter((l) => l['retryDecision'] === 'window_closed')).toEqual([
      expect.objectContaining({ msg: 'retrySend: retry window closed - retry chain ended without sending', cause: RETRY_WINDOW_CLOSED_CODE }),
    ]);
    expect(await recordOf(slipped)).toEqual(released);
    expect(calls).not.toHaveBeenCalled();
  });

  it('4e a conversation that is missing, a group text, a relay group, or a thread without a participant phone is a WARN decline in the decision\'s vocabulary - no record, no throw', async () => {
    wire();
    const calls = providerCalls();
    const group = await seedRetried('SMgroup1');
    const thread = world.conversations.get(group.conversationId)!;
    thread.type = 'group_text';
    await run(group);
    thread.type = 'relay_group';
    const relay = await seedRetried('SMrelay1');
    await run(relay);
    thread.type = 'tenant_1to1';
    const phoneless = await seedRetried('SMphoneless1');
    delete thread.participant_phone;
    await run(phoneless);
    // A new thread for the tenant (the old one lost its phone), then removed.
    const missing = await seedRetried('SMmissing1');
    expect(missing.conversationId).not.toBe(group.conversationId);
    world.conversations.delete(missing.conversationId);
    await run(missing);
    expect(msgLines(WARN, 'retrySend: conversation not retryable').map((l) => [l['providerSid'], l['reason']])).toEqual([
      ['SMgroup1', 'group_text'],
      ['SMrelay1', 'not_one_to_one'],
      ['SMphoneless1', 'not_one_to_one'],
      ['SMmissing1', 'conversation_missing'],
    ]);
    expect(world.sendAttempts.size).toBe(0);
    expect(calls).not.toHaveBeenCalled();
    expect(capture.atLevel(ERROR)).toHaveLength(0);
  });

  it('4f step 1 refuses a payload whose attempt is not the one the retried row can schedule, (retry_attempt ?? 0) + 1 (FW3, planner re-review R2): against a MANUAL retried row (retry_of, no retry_attempt) attempt 2 is refused with ONE WARN naming rowAttempt 1 - nothing read past the retried row, nothing claimed, no provider call; attempt 1 against a fresh manual row claims and sends once', async () => {
    wire();
    const cannotSchedule = "retrySend: the payload's attempt is not the one the retried row can schedule - refusing";
    const root = await seedRetried('SMf4root', { providerTs: iso(Date.now() - 60_000) });
    // Staff Retries of the root appended before this deploy - retry_of, no retry_attempt, no retry_root - so the
    // root walk right after step 1 WOULD read: the decline's placement ahead of it is observable. A fresh row per sub-case.
    const refused = await seedRetried('SMf4manual1', { retryOf: root.tsMsgId });
    const proceeds = await seedRetried('SMf4manual2', { retryOf: root.tsMsgId });
    const calls = providerCalls();
    const reads = {
      lineage: vi.spyOn(world.messagesRepo, 'getByTsMsgIdConsistent'),
      recipient: vi.spyOn(world.contactsRepo, 'getById'),
      thread: vi.spyOn(world.conversationsRepo, 'getById'),
      record: vi.spyOn(world.sendAttemptsRepo, 'get'),
      marker: vi.spyOn(world.messagesRepo, 'getJobExecutionMarker'),
      children: vi.spyOn(world.messagesRepo, 'listRetryChildrenConsistent'),
    };
    const claim = vi.spyOn(world.sendAttemptsRepo, 'claim');
    const annotate = vi.spyOn(world.messagesRepo, 'annotateRetryPromise');
    // (1) attempt 2: this manual row can only schedule attempt 1.
    await run(refused, 2);
    expect(calls).not.toHaveBeenCalled();
    for (const [name, read] of Object.entries(reads)) expect({ name, calls: read.mock.calls.length }).toEqual({ name, calls: 0 });
    expect(claim).not.toHaveBeenCalled();
    expect(annotate).not.toHaveBeenCalled();
    expect(await recordOf(refused, 1)).toBeUndefined();
    expect(await recordOf(refused, 2)).toBeUndefined();
    const lines = msgLines(WARN, cannotSchedule);
    expect(lines).toEqual([
      expect.objectContaining({ providerSid: 'SMf4manual1', conversationId: refused.conversationId, attempt: 2, rowAttempt: 1 }),
    ]);
    // The base context: logged before the root walk, so no root or retried-row fields ride it.
    expect(lines[0]).not.toHaveProperty('retryRoot');
    expect(lines[0]).not.toHaveProperty('retriedTsMsgId');
    expect(world.sendAttempts.size).toBe(0);
    expect(world.sent).toHaveLength(0);
    // (2) attempt 1 against a fresh manual row proceeds: the root walk runs, the job claims and sends once.
    await run(proceeds, 1);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(reads.lineage).toHaveBeenCalled();
    expect(await recordOf(proceeds)).toMatchObject({ state: 'done', outcome: 'sent', attemptNo: 1 });
    expect(world.sent).toHaveLength(1);
    expect(world.messages.find((m) => m.retry_of === proceeds.tsMsgId)).toMatchObject({ retry_attempt: 1, retry_root: root.tsMsgId });
    expect(msgLines(WARN, cannotSchedule)).toHaveLength(1);
    expect(capture.atLevel(ERROR)).toHaveLength(0);
  });

  // ---- accepted, not recorded (item 5) ----------------------------------------------

  it('5 accepted-not-recorded (the append throws): record reconciling WITH the SID, one hand-off, one provider call, ERROR sent_unrecorded, the promise refreshed', async () => {
    wire();
    const row = await seedRetried('SMroot1');
    vi.spyOn(world.messagesRepo, 'append').mockRejectedValueOnce(new Error('append exploded'));
    await run(row);
    expect(world.sent).toHaveLength(1);
    const sid = world.sentDetails[0]!.sid;
    const record = await recordOf(row);
    expect(record).toMatchObject({ state: 'reconciling', sid });
    expect(reconcileEnvelopes()).toHaveLength(1);
    expect(reconcileEnvelopes()[0]!.envelope.payload).toMatchObject({ attemptedAt: record!.attemptedAt, checkNo: 0 });
    expect(world.messages.filter((m) => m.retry_of !== undefined)).toEqual([]);
    expect(capture.atLevel(ERROR)).toEqual([
      expect.objectContaining({
        msg: 'retrySend: sent_unrecorded - the retry was sent but not recorded; its SID goes to reconcile',
        sid,
      }),
    ]);
    expect(row.retry_due_at).toBe(handOffDueAt(record!.attemptedAt));
  });

  // ---- the duplicate guard (item 6, Review Focus 1) -------------------------------

  it('6a the duplicate guard, sequential: the same envelope dispatched twice makes ONE provider call - the second delivery meets the finished record at the gate (skip) (Review Focus 1)', async () => {
    wire();
    const row = await seedRetried('SMroot1');
    const calls = providerCalls();
    const envelope = await envelopeFor(row);
    await dispatch(envelope);
    await dispatch(envelope);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(await recordOf(row)).toMatchObject({ state: 'done', outcome: 'sent', attemptNo: 1 });
    expect(capture.atLevel(INFO).filter((l) => l['gate'] === 'skip')).toEqual([
      expect.objectContaining({ msg: 'retrySend: this attempt is already resolved', jobId: envelope.jobId }),
    ]);
    // The gate answered before any claim.
    expect(capture.lines.filter((l) => String(l['msg']).startsWith('retrySend: claim refused'))).toHaveLength(0);
    expect(world.jobExecutionMarkers.size).toBe(0);
  });

  it('6b a stale attempting record (31 s) is taken over into reconcile by the redelivered job, with the same recipientKey derived again - no provider call, the promise refreshed', async () => {
    wire();
    const recorded = recordJobs(SEND_RECONCILE_JOB);
    const row = await seedRetried('SMroot1');
    const before = row.retry_due_at!;
    const at = iso(Date.now() - 31_000);
    expect((await world.sendAttemptsRepo.claim(ownerOf(row, 1), factsFor(row), at)).outcome).toBe('claimed');
    const calls = providerCalls();
    await run(row);
    expect(await recordOf(row)).toMatchObject({ state: 'reconciling', attemptNo: 1, attemptedAt: at });
    // Check 0 of a 31 s-old attempt is due now: an IMMEDIATE hand-off, never in outbound.delayed.
    expect(reconcileEnvelopes()).toHaveLength(0);
    expect(recorded).toEqual([
      {
        owner: {
          kind: 'retry_send',
          conversationId: row.conversationId,
          retriedTsMsgId: row.tsMsgId,
          attempt: 1,
          retryRoot: row.tsMsgId,
          recipientKeyHash: 'c-real',
        },
        attemptedAt: at,
        checkNo: 0,
      },
    ]);
    expect(calls).not.toHaveBeenCalled();
    expect(row.retry_due_at).toBe(handOffDueAt(at));
    expect(Date.parse(row.retry_due_at!)).toBeGreaterThan(Date.parse(before));
    expect(capture.atLevel(INFO).filter((l) => l['gate'] === 'taken_over')).toEqual([
      expect.objectContaining({ msg: 'retrySend: a stale attempt was taken over into reconcile' }),
    ]);
  });

  it('6c a lost re-arm sends nothing and writes nothing: the claim stays attempting for the takeover, INFO', async () => {
    wire();
    const row = await seedRetried('SMroot1');
    const before = row.retry_due_at;
    vi.spyOn(world.sendAttemptsRepo, 'rearm').mockResolvedValueOnce(undefined);
    const calls = providerCalls();
    await run(row);
    expect(calls).not.toHaveBeenCalled();
    expect(world.sent).toHaveLength(0);
    expect(await recordOf(row)).toMatchObject({ state: 'attempting', attemptNo: 1 });
    expect(row.retry_due_at).toBe(before);
    expect(retryEnvelopes()).toHaveLength(0);
    expect(reconcileEnvelopes()).toHaveLength(0);
    expect(msgLines(INFO, 'retrySend: attempt taken over before the send - not sent; the takeover owns it')).toHaveLength(1);
    expect(capture.atLevel(ERROR)).toHaveLength(0);
  });

  it('6d putJobExecutionMarker is never called by this job - on a success or on an unknown outcome', async () => {
    wire();
    const marker = vi.spyOn(world.messagesRepo, 'putJobExecutionMarker');
    const ok = await seedRetried('SMok1');
    await run(ok);
    expect(await recordOf(ok)).toMatchObject({ state: 'done', outcome: 'sent' });
    unknownOn();
    const unknown = await seedRetried('SMunknown1');
    await run(unknown);
    expect(await recordOf(unknown)).toMatchObject({ state: 'reconciling' });
    expect(marker).not.toHaveBeenCalled();
    expect(world.jobExecutionMarkers.size).toBe(0);
  });

  it('6e the duplicate guard, concurrent (the gate): a FRESH attempting record (5 s old - another delivery is inside its provider call) defers this one - nothing sent, nothing written, INFO (Review Focus 1)', async () => {
    wire();
    const row = await seedRetried('SMroot1');
    const at = iso(Date.now() - 5_000);
    expect((await world.sendAttemptsRepo.claim(ownerOf(row, 1), factsFor(row), at)).outcome).toBe('claimed');
    const seeded = await recordOf(row);
    const calls = providerCalls();
    await run(row);
    expect(calls).not.toHaveBeenCalled();
    expect(await recordOf(row)).toEqual(seeded);
    expect(capture.atLevel(INFO).filter((l) => l['gate'] === 'defer')).toEqual([
      expect.objectContaining({ msg: 'retrySend: a concurrent delivery owns this attempt' }),
    ]);
  });

  it('6f the duplicate guard, concurrent (the claim race): a delivery that read NO record at the gate but loses the claim to a concurrent winner is refused FRESH and sends nothing (Review Focus 1)', async () => {
    wire();
    const row = await seedRetried('SMroot1');
    const at = iso(Date.now() - 5_000);
    expect((await world.sendAttemptsRepo.claim(ownerOf(row, 1), factsFor(row), at)).outcome).toBe('claimed');
    const seeded = await recordOf(row);
    // The gate reads "absent" (the winner's claim landed after it read); the claim then meets the winner.
    vi.spyOn(world.sendAttemptsRepo, 'get').mockResolvedValueOnce(undefined);
    const calls = providerCalls();
    await run(row);
    expect(calls).not.toHaveBeenCalled();
    expect(msgLines(INFO, 'retrySend: claim refused - another delivery owns this attempt or it is resolved')).toEqual([
      expect.objectContaining({ fresh: true, state: 'attempting' }),
    ]);
    expect(await recordOf(row)).toEqual(seeded);
  });

  it('6g a claim that meets a STALE attempting record (the gate read none) takes it over into reconcile - never a send', async () => {
    wire();
    const recorded = recordJobs(SEND_RECONCILE_JOB);
    const row = await seedRetried('SMroot1');
    const at = iso(Date.now() - 31_000);
    expect((await world.sendAttemptsRepo.claim(ownerOf(row, 1), factsFor(row), at)).outcome).toBe('claimed');
    vi.spyOn(world.sendAttemptsRepo, 'get').mockResolvedValueOnce(undefined);
    const calls = providerCalls();
    await run(row);
    expect(calls).not.toHaveBeenCalled();
    expect(await recordOf(row)).toMatchObject({ state: 'reconciling', attemptedAt: at });
    expect(recorded).toEqual([expect.objectContaining({ attemptedAt: at, checkNo: 0 })]);
    expect(row.retry_due_at).toBe(handOffDueAt(at));
  });

  // ---- success and the chain (items 7, 8) -------------------------------------------

  it('7 a successful retry: record done/sent with the SID; the retry row carries retry_of, retry_attempt, retry_window_start, retry_root, automated false, recipient_contact_id and - from a share root - broadcast_id; the retried row\'s promise is NOT written', async () => {
    wire();
    const annotate = vi.spyOn(world.messagesRepo, 'annotateRetryPromise');
    const plain = await seedRetried('SMplain1');
    const plainDue = plain.retry_due_at;
    const share = await seedRetried('SMshare1', { broadcastId: 'bcast-7' });
    await run(plain);
    await run(share);
    expect(world.sent).toHaveLength(2);
    // The sender the attempt's facts pinned is the number the send pinned.
    expect(world.sent[0]).toEqual({ to: TENANT_PHONE, body: BODY, from: OUR_NUMBER });
    const plainRetry = world.messages.find((m) => m.retry_of === plain.tsMsgId)!;
    expect(await recordOf(plain)).toMatchObject({ state: 'done', outcome: 'sent', sid: plainRetry.provider_sid, sender: OUR_NUMBER });
    expect(plainRetry).toMatchObject({
      direction: 'outbound',
      author: 'teammate',
      body: BODY,
      retry_of: plain.tsMsgId,
      retry_attempt: 1,
      retry_window_start: plain.provider_ts,
      retry_root: plain.tsMsgId,
      automated: false,
      recipient_contact_id: 'c-real',
    });
    expect(plainRetry).not.toHaveProperty('broadcast_id');
    // The retrychild# pointer rode the send's append (R7).
    expect(await world.messagesRepo.listRetryChildrenConsistent(plain.conversationId, plain.tsMsgId)).toEqual([
      { tsMsgId: plainRetry.tsMsgId, providerSid: plainRetry.provider_sid, retryAttempt: 1 },
    ]);
    const shareRetry = world.messages.find((m) => m.retry_of === share.tsMsgId)!;
    expect(shareRetry).toMatchObject({ retry_root: share.tsMsgId, broadcast_id: 'bcast-7' });
    expect(annotate).not.toHaveBeenCalled();
    expect(plain.retry_due_at).toBe(plainDue);
    expect(msgLines(INFO, 'retrySend: message re-sent')).toEqual([
      expect.objectContaining({ newProviderSid: plainRetry.provider_sid, outcome: 'sent', retriedTsMsgId: plain.tsMsgId }),
      expect.objectContaining({ newProviderSid: shareRetry.provider_sid, outcome: 'sent', retriedTsMsgId: share.tsMsgId }),
    ]);
  });

  it('7b a record-phase fence LOST after a recorded send is a WARN, never sent_unrecorded: the row exists, the takeover reconcile repairs', async () => {
    wire();
    const row = await seedRetried('SMroot1');
    vi.spyOn(world.sendAttemptsRepo, 'finishAttempt').mockResolvedValueOnce(false);
    await run(row);
    expect(world.sent).toHaveLength(1);
    expect(world.messages.filter((m) => m.retry_of === row.tsMsgId)).toHaveLength(1);
    expect(msgLines(WARN, 'retrySend: attempt fence lost after a recorded send; the takeover reconcile repairs')).toHaveLength(1);
    expect(capture.atLevel(ERROR)).toHaveLength(0);
    expect(reconcileEnvelopes()).toHaveLength(0);
  });

  it('8 attempt 2: the retried row is the attempt-1 retry row; the record keys on THAT row with attempt 2; the new row\'s retry_root is the chain root and its window starts at the root\'s send - a pre-deploy retried row (retry_of, no retry_root) yields the root through retry_of', async () => {
    wire();
    const root = await seedRetried('SMroot1', { providerTs: iso(Date.now() - 90_000) });
    // Appended before this deploy: lineage and window origin, but no retry_root.
    const r1 = await seedRetried('SMretry1', { retryOf: root.tsMsgId, retryAttempt: 1, retryWindowStart: root.provider_ts });
    expect(r1).not.toHaveProperty('retry_root');
    await run(r1, 2);
    expect(await world.sendAttemptsRepo.get(ownerOf(r1, 2))).toMatchObject({
      state: 'done',
      outcome: 'sent',
      owner: { kind: 'retry_send', retriedTsMsgId: r1.tsMsgId, attempt: 2, retryRoot: root.tsMsgId, recipientKey: 'c-real' },
    });
    expect(world.sendAttempts.size).toBe(1);
    const r2 = world.messages.find((m) => m.retry_of === r1.tsMsgId)!;
    expect(r2).toMatchObject({ retry_attempt: 2, retry_root: root.tsMsgId, retry_window_start: root.provider_ts });
  });

  it('9 reads before the claim: a closed window with no record leaves no record; a conversation read that throws leaves no record and rethrows (the redelivery then sends once); a no-origin row fails open with the WARN', async () => {
    wire();
    // (a) the window closed: an ERROR, no record.
    const late = await seedRetried('SMlate1', { providerTs: iso(Date.now() - 16 * 60_000) });
    await run(late);
    expect(await recordOf(late)).toBeUndefined();
    expect(capture.atLevel(ERROR).filter((l) => l['retryDecision'] === 'window_closed')).toHaveLength(1);
    // (b) a throwing conversation read fails the delivery before the claim.
    const row = await seedRetried('SMthrow1');
    vi.spyOn(world.conversationsRepo, 'getById').mockRejectedValueOnce(new Error('conversation read exploded'));
    const envelope = await envelopeFor(row);
    await expect(dispatch(envelope)).rejects.toThrow('conversation read exploded');
    expect(await recordOf(row)).toBeUndefined();
    expect(world.sent).toHaveLength(0);
    await dispatch(envelope); // the SQS redelivery re-runs the reads and sends once
    expect(world.sent).toHaveLength(1);
    expect(await recordOf(row)).toMatchObject({ state: 'done', outcome: 'sent', attemptNo: 1 });
    // (c) no usable origin: the WARN, and the retry goes out unwindowed.
    const noOrigin = await seedRetried('SMnots1');
    delete (noOrigin as { provider_ts?: string }).provider_ts;
    await run(noOrigin);
    expect(msgLines(WARN, 'retrySend: no usable window origin - sending without a window check (fail open)')).toHaveLength(1);
    expect(await recordOf(noOrigin)).toMatchObject({ state: 'done', outcome: 'sent' });
    expect(world.messages.find((m) => m.retry_of === noOrigin.tsMsgId)).not.toHaveProperty('retry_window_start');
  });

  it('11 (second half) the reconcile\'s never_sent re-drive runs through THIS handler: it claims from redriven (attemptNo 2) and sends once; a re-driven job whose window closed at job time closes its redriven record refused', async () => {
    wire();
    registerReconcile();
    unknownOn();
    const row = await seedRetried('SMroot1');
    await run(row);
    expect(await recordOf(row)).toMatchObject({ state: 'reconciling' });
    // The provider holds nothing (the override threw before the fake recorded a send).
    world.adapter.sendPreparedMessage = originalSend;
    expect(world.providerMessages).toHaveLength(0);
    // Checks 0-2 find nothing -> never_sent -> ONE immediate re-drive, drained inside the chain.
    await runReconcileChain();
    expect(world.sent).toHaveLength(1);
    expect(await recordOf(row)).toMatchObject({ state: 'done', outcome: 'sent', attemptNo: 2, redriveCount: 1 });
    expect(world.messages.filter((m) => m.retry_of === row.tsMsgId)).toHaveLength(1);
    // Sub-case 2: a re-driven record whose job finds the window closed.
    const late = await seedRetried('SMlate1', { providerTs: iso(Date.now() - 16 * 60_000) });
    await seedRedriven(ownerOf(late, 1), factsFor(late));
    const calls = providerCalls();
    await run(late);
    expect(await recordOf(late)).toMatchObject({ state: 'done', outcome: 'refused', cause: RETRY_WINDOW_CLOSED_CODE });
    expect(calls).not.toHaveBeenCalled();
  });

  it('R9 every line THE JOB writes names the owner - conversationId, retryRoot, retriedTsMsgId, attempt, the redacted key - and no line anywhere carries the phone or the body', async () => {
    wire();
    unknownOn();
    // Phone-keyed: the recipient key itself carries the number.
    const row = await seedRetried('SMr9', { recipientContactId: undefined });
    await run(row);
    const jobLines = capture.lines.filter((l) => String(l['msg']).startsWith('retrySend:'));
    expect(jobLines.length).toBeGreaterThanOrEqual(2);
    for (const line of jobLines) {
      expect(line).toMatchObject({
        conversationId: row.conversationId,
        retryRoot: row.tsMsgId,
        retriedTsMsgId: row.tsMsgId,
        attempt: 1,
        recipientKey: 'phone#redacted',
      });
    }
    const all = JSON.stringify(capture.lines);
    expect(all).not.toContain(TENANT_PHONE);
    expect(all).not.toContain(BODY);
    expect(all).not.toContain('phonehash#');
  });

  // ---- the job reads no run-once marker (the pre-adoption belt was removed 2026-09-29) ----

  it('a job whose jobId has a run-once marker and no attempt record is not suppressed - the marker is never read; the job claims and sends once', async () => {
    wire();
    const read = vi.spyOn(world.messagesRepo, 'getJobExecutionMarker');
    const row = await seedRetried('SMbelt1');
    const envelope = await envelopeFor(row);
    world.jobExecutionMarkers.set(envelope.jobId, row.conversationId);
    const calls = providerCalls();
    await dispatch(envelope);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(await recordOf(row)).toMatchObject({ state: 'done', outcome: 'sent' });
    expect(read).not.toHaveBeenCalled();
  });

  // ---- code review round 1, fix wave FW1 --------------------------------------------

  it('FW1 C-1 (4a): a re-driven attempt superseded by a manual child whose decline close THROWS fails the delivery (R2: a throw before the claim; SQS redelivers) - the record stays redriven, nothing is sent; the redelivery closes it done/refused manual_retry_superseded', async () => {
    wire();
    const calls = providerCalls();
    const superseded = 'retrySend: a manual retry superseded this attempt';
    const row = await seedRetried('SMc1manual');
    await world.messagesRepo.append({ ...outboundRow('SMc1child', Date.now() + 1_000, row.conversationId), retryOf: row.tsMsgId, automated: false });
    await seedRedriven(ownerOf(row, 1), factsFor(row));
    vi.spyOn(world.sendAttemptsRepo, 'closeRedriven').mockRejectedValueOnce(new Error('closeRedriven exploded'));
    const envelope = await envelopeFor(row);
    await expect(dispatch(envelope)).rejects.toThrow('closeRedriven exploded');
    expect(await recordOf(row)).toMatchObject({ state: 'redriven', redriveCount: 1 });
    expect(msgLines(INFO, superseded)).toHaveLength(0);
    await dispatch(envelope); // the SQS redelivery re-runs the idempotent decline
    expect(await recordOf(row)).toMatchObject({ state: 'done', outcome: 'refused', cause: 'manual_retry_superseded' });
    expect(msgLines(INFO, superseded)).toEqual([expect.objectContaining({ cause: 'manual_retry_superseded', retriedTsMsgId: row.tsMsgId })]);
    // Zero provider calls throughout; the throw was never swallowed as a failure-arm write.
    expect(calls).not.toHaveBeenCalled();
    expect(world.sent).toHaveLength(0);
    expect(capture.atLevel(ERROR).map((l) => l['msg'])).toEqual(['job failed: messaging.retrySend']);
  });

  it('FW1 C-1 (4b): a re-driven attempt whose job finds the window closed and whose decline close THROWS fails the delivery - the record stays redriven, nothing is sent; the redelivery closes it done/refused retry_window_closed with its ONE window ERROR', async () => {
    wire();
    const calls = providerCalls();
    const late = await seedRetried('SMc1late', { providerTs: iso(Date.now() - 16 * 60_000) });
    await seedRedriven(ownerOf(late, 1), factsFor(late));
    vi.spyOn(world.sendAttemptsRepo, 'closeRedriven').mockRejectedValueOnce(new Error('closeRedriven exploded'));
    const envelope = await envelopeFor(late);
    await expect(dispatch(envelope)).rejects.toThrow('closeRedriven exploded');
    expect(await recordOf(late)).toMatchObject({ state: 'redriven', redriveCount: 1 });
    await dispatch(envelope); // the SQS redelivery re-runs the idempotent decline
    expect(await recordOf(late)).toMatchObject({ state: 'done', outcome: 'refused', cause: RETRY_WINDOW_CLOSED_CODE });
    expect(calls).not.toHaveBeenCalled();
    expect(world.sent).toHaveLength(0);
    expect(capture.atLevel(ERROR).map((l) => l['msg'])).toEqual([
      'job failed: messaging.retrySend',
      'retrySend: retry window closed - retry chain ended without sending',
    ]);
  });

  it('FW1 C-3: the gate DEFERS before the window (R2 step 4) - a reconciling record, and a FRESH attempting one, on a retried row whose window already closed: ONE INFO gate defer each, no ERROR (no spurious "retry window closed"), no claim-refused line, no retrychild# Query, nothing sent or written (Review Focus 1)', async () => {
    wire();
    const list = vi.spyOn(world.messagesRepo, 'listRetryChildrenConsistent');
    const calls = providerCalls();
    const pastWindow: Partial<NewMessage> = { providerTs: iso(Date.now() - 16 * 60_000) };
    const deferLines = () => capture.atLevel(INFO).filter((l) => l['gate'] === 'defer');
    // (1) reconciling: the attempt is in the reconcile's hands.
    const handed = await seedRetried('SMc3reconciling', pastWindow);
    const handedAt = iso(Date.now() - 60_000);
    expect((await world.sendAttemptsRepo.claim(ownerOf(handed, 1), factsFor(handed), handedAt)).outcome).toBe('claimed');
    expect(await world.sendAttemptsRepo.handToReconcile(ownerOf(handed, 1), { attemptNo: 1, attemptedAt: handedAt })).toBe(true);
    const handedRecord = await recordOf(handed);
    expect(handedRecord).toMatchObject({ state: 'reconciling' });
    await run(handed);
    expect(deferLines()).toEqual([
      expect.objectContaining({ msg: 'retrySend: a concurrent delivery owns this attempt', providerSid: 'SMc3reconciling' }),
    ]);
    expect(await recordOf(handed)).toEqual(handedRecord);
    // (2) a FRESH attempting record (5 s old): another delivery is inside its provider call.
    const fresh = await seedRetried('SMc3fresh', pastWindow);
    expect((await world.sendAttemptsRepo.claim(ownerOf(fresh, 1), factsFor(fresh), iso(Date.now() - 5_000))).outcome).toBe('claimed');
    const freshRecord = await recordOf(fresh);
    await run(fresh);
    expect(deferLines().map((l) => l['providerSid'])).toEqual(['SMc3reconciling', 'SMc3fresh']);
    expect(await recordOf(fresh)).toEqual(freshRecord);
    // The deferral answered BEFORE every later step: no manual-child Query, no window ERROR, no claim.
    expect(capture.atLevel(ERROR)).toHaveLength(0);
    expect(capture.lines.filter((l) => String(l['msg']).startsWith('retrySend: claim refused'))).toHaveLength(0);
    expect(list).not.toHaveBeenCalled();
    expect(calls).not.toHaveBeenCalled();
  });

  it('FW1 C-5 (second unknown): the unresolved close line states what the WITHDRAW did - a write that throws (failed) or loses twice (lost) reads "withdrawal failed - the record decides", never "withdrawn"; a row already withdrawn reads "withdrawn"; ONE close line each, after the helper\'s own ERROR', async () => {
    wire();
    unknownOn();
    const annotate = vi.spyOn(world.messagesRepo, 'annotateRetryPromise');
    const withdrawn = 'retrySend: unknown send outcome after a re-drive - attempt closed unresolved; the retry promise is withdrawn';
    const notWithdrawn =
      'retrySend: unknown send outcome after a re-drive - attempt closed unresolved; the retry promise withdrawal failed - the record decides';
    // (1) failed: the WITHDRAW's write throws.
    const failed = await seedRetried('SMc5failed');
    const failedDue = failed.retry_due_at;
    await seedRedriven(ownerOf(failed, 1), factsFor(failed));
    annotate.mockRejectedValueOnce(new Error('annotate exploded'));
    await run(failed);
    expect(await recordOf(failed)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'second_unknown' });
    expect(failed.retry_due_at).toBe(failedDue);
    expect(failed).not.toHaveProperty('retry_outcome');
    // (2) lost: both WITHDRAW writes lose their condition.
    const lost = await seedRetried('SMc5lost');
    const lostDue = lost.retry_due_at;
    await seedRedriven(ownerOf(lost, 1), factsFor(lost));
    annotate.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    await run(lost);
    expect(await recordOf(lost)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'second_unknown' });
    expect(lost.retry_due_at).toBe(lostDue);
    expect(lost).not.toHaveProperty('retry_outcome');
    // (3) already: the row already holds the sentinel AND the outcome - a no-op that IS withdrawn.
    const already = await seedRetried('SMc5already');
    already.retry_due_at = RETRY_PROMISE_WITHDRAWN_AT;
    already.retry_outcome = 'unconfirmed';
    await seedRedriven(ownerOf(already, 1), factsFor(already));
    const writesBefore = annotate.mock.calls.length;
    await run(already);
    expect(await recordOf(already)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'second_unknown' });
    expect(annotate.mock.calls.length).toBe(writesBefore);
    expect(capture.atLevel(ERROR).map((l) => [l['providerSid'], l['msg']])).toEqual([
      ['SMc5failed', 'failure-arm write failed (best-effort); the attempt record decides'],
      ['SMc5failed', notWithdrawn],
      ['SMc5lost', 'retry promise withdrawal lost twice - a concurrent writer keeps moving the promise'],
      ['SMc5lost', notWithdrawn],
      ['SMc5already', withdrawn],
    ]);
    expect(msgLines(ERROR, notWithdrawn)).toEqual([
      expect.objectContaining({ cause: 'second_unknown', outcome: 'unresolved', retriedTsMsgId: failed.tsMsgId }),
      expect.objectContaining({ cause: 'second_unknown', outcome: 'unresolved', retriedTsMsgId: lost.tsMsgId }),
    ]);
  });

  it('FW1 C-5 (hand-off enqueue failure): the unresolved enqueue_failed close line reads "withdrawal failed - the record decides" when the WITHDRAW fails (its write throws) or is lost twice - never "withdrawn"; ONE close line each, after the helper\'s own ERROR', async () => {
    wire();
    unknownOn();
    refuseEnqueues((jobName) => jobName === SEND_RECONCILE_JOB);
    const annotate = vi.spyOn(world.messagesRepo, 'annotateRetryPromise');
    const notWithdrawn = 'retrySend: reconcile enqueue failed - attempt closed unresolved; the retry promise withdrawal failed - the record decides';
    // (1) failed: the WITHDRAW's write throws.
    const failed = await seedRetried('SMc5hofailed');
    const failedDue = failed.retry_due_at;
    annotate.mockRejectedValueOnce(new Error('annotate exploded'));
    await run(failed);
    expect(await recordOf(failed)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'enqueue_failed' });
    expect(failed.retry_due_at).toBe(failedDue);
    expect(failed).not.toHaveProperty('retry_outcome');
    // (2) lost: both WITHDRAW writes lose their condition.
    const lost = await seedRetried('SMc5holost');
    const lostDue = lost.retry_due_at;
    annotate.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    await run(lost);
    expect(await recordOf(lost)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'enqueue_failed' });
    expect(lost.retry_due_at).toBe(lostDue);
    expect(lost).not.toHaveProperty('retry_outcome');
    expect(capture.atLevel(ERROR).map((l) => [l['providerSid'], l['msg']])).toEqual([
      ['SMc5hofailed', 'failure-arm write failed (best-effort); the attempt record decides'],
      ['SMc5hofailed', notWithdrawn],
      ['SMc5holost', 'retry promise withdrawal lost twice - a concurrent writer keeps moving the promise'],
      ['SMc5holost', notWithdrawn],
    ]);
    expect(msgLines(ERROR, notWithdrawn)).toEqual([
      expect.objectContaining({ cause: 'enqueue_failed', outcome: 'unresolved', retriedTsMsgId: failed.tsMsgId }),
      expect.objectContaining({ cause: 'enqueue_failed', outcome: 'unresolved', retriedTsMsgId: lost.tsMsgId }),
    ]);
  });

  // ---- share-sent-outcome T6: the job's two unresolved-end arms write the share slot FIRST ----

  /**
   * A share root as the retried row (attempt 1): the 30003 row stamped with
   * broadcast b-1, and that share (unit unit-1) whose slot c-real failed 30003
   * on it. Returns the stored row.
   */
  async function seedShareRetried(sid: string): Promise<MessageItem> {
    const row = await seedRetried(sid, { broadcastId: 'b-1' });
    world.broadcasts.set('b-1', {
      broadcastId: 'b-1',
      created_by: 'usr_test',
      created_at: iso(Date.now() - 60_000),
      status: 'sent',
      unitId: 'unit-1',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: BODY,
      stats: { audience: 1, sent: 0, delivered: 0, failed: 1, unconfirmed: 0, skipped_opted_out: 0, skipped_no_consent: 0, queued: 0 },
      recipients: { 'c-real': { status: 'failed', errorCode: '30003', conversationId: row.conversationId, tsMsgId: row.tsMsgId } },
      updated_at: iso(Date.now() - 60_000),
    });
    return row;
  }

  it('share-sent-outcome: second unknown on a share retry - the original slot reads send_unconfirmed as a row-less attempt and the slot write PRECEDES the record close in call order; still ONE close ERROR', async () => {
    wire();
    unknownOn();
    const row = await seedShareRetried('SMshare1');
    await seedRedriven(ownerOf(row, 1), factsFor(row));
    const slotSpy = vi.spyOn(world.broadcastsRepo, 'applyAttemptOutcome');
    const finishSpy = vi.spyOn(world.sendAttemptsRepo, 'finishAttempt');
    await run(row);
    expect(slotSpy).toHaveBeenCalledTimes(1);
    expect(slotSpy.mock.invocationCallOrder[0]!).toBeLessThan(finishSpy.mock.invocationCallOrder[0]!);
    expect(world.broadcasts.get('b-1')!.recipients['c-real']).toEqual({
      status: 'failed',
      errorCode: SEND_UNCONFIRMED_CODE,
      conversationId: row.conversationId,
      tsMsgId: row.tsMsgId,
      latestAttempt: rowlessAttemptKey(row.tsMsgId),
    });
    expect(world.broadcasts.get('b-1')!.stats).toMatchObject({ failed: 0, unconfirmed: 1 });
    expect((await world.listingSendsRepo.getByKeyConsistent('unit-1', 'c-real'))?.shares?.['b-1']).toMatchObject({ state: 'unconfirmed' });
    expect(await recordOf(row)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'second_unknown' });
    expect(row).toMatchObject({ retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' });
    expect(capture.atLevel(ERROR)).toEqual([
      expect.objectContaining({ msg: 'retrySend: unknown send outcome after a re-drive - attempt closed unresolved; the retry promise is withdrawn' }),
    ]);
  });

  it('share-sent-outcome: a hand-off enqueue failure on a share retry - the slot write goes first (before the record close), then the close and the WITHDRAW; ONE close ERROR', async () => {
    wire();
    unknownOn();
    refuseEnqueues((jobName) => jobName === SEND_RECONCILE_JOB);
    const row = await seedShareRetried('SMshare2');
    const slotSpy = vi.spyOn(world.broadcastsRepo, 'applyAttemptOutcome');
    const closeSpy = vi.spyOn(world.sendAttemptsRepo, 'closeFromReconcile');
    await run(row);
    expect(slotSpy.mock.invocationCallOrder[0]!).toBeLessThan(closeSpy.mock.invocationCallOrder[0]!);
    expect(world.broadcasts.get('b-1')!.recipients['c-real']).toMatchObject({ status: 'failed', errorCode: SEND_UNCONFIRMED_CODE, latestAttempt: rowlessAttemptKey(row.tsMsgId) });
    expect(await recordOf(row)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'enqueue_failed' });
    expect(capture.atLevel(ERROR)).toEqual([
      expect.objectContaining({ msg: 'retrySend: reconcile enqueue failed - attempt closed unresolved; the retry promise is withdrawn' }),
    ]);
  });

  it("share-sent-outcome: a hand-off enqueue failure on a share retry whose slot write THROWS every time - tried three times (the bounded write every site uses), then ONE 'share slot write failed after retries' ERROR, never the guard's, and the close still runs", async () => {
    wire();
    unknownOn();
    refuseEnqueues((jobName) => jobName === SEND_RECONCILE_JOB);
    const row = await seedShareRetried('SMshare3');
    let calls = 0;
    world.broadcastsRepo.applyAttemptOutcome = async () => {
      calls += 1;
      throw new Error('dynamo down');
    };
    await run(row);
    expect(calls).toBe(3);
    expect(capture.atLevel(ERROR).filter((l) => String(l['msg']).includes('share slot write failed after retries'))).toEqual([
      expect.objectContaining({ broadcastId: 'b-1', retryRoot: row.tsMsgId, attempt: rowlessAttemptKey(row.tsMsgId), outcome: 'unresolved' }),
    ]);
    expect(capture.atLevel(ERROR).filter((l) => String(l['msg']).includes('failure-arm write failed'))).toHaveLength(0);
    expect(await recordOf(row)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'enqueue_failed' });
    expect(row).toMatchObject({ retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' });
    expect(world.broadcasts.get('b-1')!.recipients['c-real']).toMatchObject({ status: 'failed', errorCode: '30003' });
  });

  it('share-sent-outcome: a share retry whose slot write throws ONCE (a transient fault) is retried at the job arm and the slot lands send_unconfirmed - no ERROR for the slot (planner fix wave, adversarial 5)', async () => {
    wire();
    unknownOn();
    refuseEnqueues((jobName) => jobName === SEND_RECONCILE_JOB);
    const row = await seedShareRetried('SMshare6');
    const real = world.broadcastsRepo.applyAttemptOutcome.bind(world.broadcastsRepo);
    let calls = 0;
    world.broadcastsRepo.applyAttemptOutcome = async (...a) => {
      calls += 1;
      if (calls === 1) throw new Error('dynamo blip');
      return real(...a);
    };
    await run(row);
    expect(calls).toBe(2);
    expect(world.broadcasts.get('b-1')!.recipients['c-real']).toMatchObject({ status: 'failed', errorCode: SEND_UNCONFIRMED_CODE, latestAttempt: rowlessAttemptKey(row.tsMsgId) });
    expect(world.broadcasts.get('b-1')!.stats).toMatchObject({ failed: 0, unconfirmed: 1 });
    expect(await recordOf(row)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'enqueue_failed' });
    // The only ERROR is the arm's own close line: nothing for the slot.
    expect(capture.atLevel(ERROR)).toEqual([
      expect.objectContaining({ msg: 'retrySend: reconcile enqueue failed - attempt closed unresolved; the retry promise is withdrawn' }),
    ]);
  });

  it("share-sent-outcome: a share retry whose conversation HAS a slot of the share with another original pointer is ONE WARN at the job's arm - never the routing-bug ERROR - and nothing moves; a slot in no conversation of the retry's is the ERROR (planner fix wave, adversarial 2)", async () => {
    wire();
    unknownOn();
    refuseEnqueues((jobName) => jobName === SEND_RECONCILE_JOB);
    const row = await seedShareRetried('SMshare4');
    world.broadcasts.get('b-1')!.recipients = { 'c-real': { status: 'failed', errorCode: '30003', conversationId: row.conversationId, tsMsgId: 'another-row' } };
    await run(row);
    const unmatched = capture.atLevel(WARN).filter((l) => String(l['msg']).includes('no matching original pointer'));
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]).toMatchObject({
      broadcastId: 'b-1',
      msg: "retrySend: retry row's conversation has a slot but no matching original pointer - the record phase may be pending or the chain unstamped (the repair re-checks)",
    });
    expect(capture.atLevel(ERROR).filter((l) => String(l['msg']).includes('routing bug'))).toHaveLength(0);
    expect(world.broadcasts.get('b-1')!.recipients['c-real']).toStrictEqual({ status: 'failed', errorCode: '30003', conversationId: row.conversationId, tsMsgId: 'another-row' });

    const lost = await seedShareRetried('SMshare5');
    world.broadcasts.get('b-1')!.recipients = { 'c-other': { status: 'failed', errorCode: '30003', conversationId: 'conv-elsewhere', tsMsgId: 'another-row' } };
    await run(lost);
    expect(capture.atLevel(ERROR).filter((l) => String(l['msg']).includes('routing bug'))).toHaveLength(1);
    expect(capture.atLevel(WARN).filter((l) => String(l['msg']).includes('no matching original pointer'))).toHaveLength(1);
  });

  // "A later attempt supersedes the unconfirmed slot the job wrote": after the
  // job closes the record nothing adopts, so the superseding attempt is a NEW
  // one (a staff Retry row's receipt). That path is Task 4's service test
  // ("a LATER real attempt supersedes it") and Task 5's webhook route; no job
  // test claims it.
  it('share-sent-outcome: a retry of a one-to-one text that is NOT a share (no broadcast_id) writes no slot and reads no broadcast - at either arm', async () => {
    wire();
    unknownOn();
    const reads = vi.spyOn(world.broadcastsRepo, 'getByIdConsistent');
    const plain = await seedRetried('SMplain-su');
    await seedRedriven(ownerOf(plain, 1), factsFor(plain));
    await run(plain);
    expect(await recordOf(plain)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'second_unknown' });
    refuseEnqueues((jobName) => jobName === SEND_RECONCILE_JOB);
    const plain2 = await seedRetried('SMplain-ho');
    await run(plain2);
    expect(await recordOf(plain2)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'enqueue_failed' });
    expect(reads).not.toHaveBeenCalled();
  });

  // ---- A-6: the manual Retry route reads the record KEY this job writes ----

  /** The REAL manual Retry route over the SAME world - its send-attempt fake included - with the real send wrapper. */
  function routeApp(): ReturnType<typeof buildApp> {
    return buildApp({
      config,
      logger,
      auth: { usersRepo: makeFakeUsersRepo([testUserItem()]).repo },
      api: {
        conversationsRepo: world.conversationsRepo,
        messagesRepo: world.messagesRepo,
        contactsRepo: world.contactsRepo,
        sendAttemptsRepo: world.sendAttemptsRepo,
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
      },
    });
  }
  const pressRetry = (row: MessageItem) =>
    request(routeApp())
      .post(`/api/conversations/${row.conversationId}/messages/${row.provider_sid}/retry`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send();

  it('FW1 A-6 (pending): the REAL job leaves a reconciling record (an unknown outcome) on a retried row with NO retry_outcome, no live promise and no child - the REAL route over the same world answers 409 retry_pending from that record alone', async () => {
    wire();
    unknownOn();
    const row = await seedRetried('SMa6pending');
    await run(row);
    const record = await recordOf(row);
    expect(record).toMatchObject({ state: 'reconciling' });
    // Take away every other answer: the promise lapsed (RSW's time guard passes), no retry_outcome (no row
    // belt), no child (the unknown send appended nothing); the fake's send restored, so a press that got
    // through would text.
    row.retry_due_at = iso(Date.now() - 10 * 60_000);
    expect(isRetryPromiseLive(row.retry_due_at, Date.now())).toBe(false);
    expect(row).not.toHaveProperty('retry_outcome');
    expect(await world.messagesRepo.listRetryChildrenConsistent(row.conversationId, row.tsMsgId)).toEqual([]);
    world.adapter.sendPreparedMessage = originalSend;
    const res = await pressRetry(row);
    expect({ status: res.status, body: res.body }).toEqual({ status: 409, body: { error: 'retry_pending' } });
    expect(world.sent).toHaveLength(0);
    expect(await recordOf(row)).toEqual(record);
  });

  it('FW1 A-6 (unresolved): the REAL job hands an unknown outcome to the REAL reconcile, which closes it done/unresolved (the list fails on every check); with its WITHDRAW\'s retry_outcome taken off the row, the REAL route over the same world answers 409 retry_unresolved from the record alone', async () => {
    wire();
    registerReconcile();
    unknownOn();
    const row = await seedRetried('SMa6unresolved');
    await run(row);
    expect(await recordOf(row)).toMatchObject({ state: 'reconciling' });
    world.adapter.listMessages = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    };
    await runReconcileChain();
    expect(await recordOf(row)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'provider_unreachable' });
    expect(row).toMatchObject({ retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' });
    // Only the record may answer: the belt off (as if its write were lost), the sentinel is no live promise,
    // no child; the fake's send restored, so a press that got through would text.
    delete row.retry_outcome;
    expect(isRetryPromiseLive(row.retry_due_at, Date.now())).toBe(false);
    expect(await world.messagesRepo.listRetryChildrenConsistent(row.conversationId, row.tsMsgId)).toEqual([]);
    world.adapter.sendPreparedMessage = originalSend;
    const res = await pressRetry(row);
    expect({ status: res.status, body: res.body }).toEqual({ status: 409, body: { error: 'retry_unresolved' } });
    expect(world.sent).toHaveLength(0);
  });
});
