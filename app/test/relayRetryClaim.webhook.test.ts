// The 30003 retry CLAIM in the relay status callback (plan Task 12, spec D3/D5/
// D6/D7/D8/D12/D13/D14/D16/D23).
//
// Driven through the REAL app (buildApp via the webhook harness) with the REAL
// jobs machinery wired, so a rung the claim enqueues can be drained and run for
// real: `failNextLeg()` dispatches whatever rung is scheduled, lets
// `sendOneRelayLeg` write the retry leg's slot and its `relaysid#` pointer, and
// then posts a 30003 for that leg's REAL provider SID. That is the only way to
// walk a whole ladder - a single callback cannot see rung 2 chaining to the
// ROOT, the cap, or the escalation not repeating.
//
// The base fixture is a MEMBER-ORIGINATED, LEGACY source: every relay source
// written before 2026-09-02 is legacy, so a retry of an old message is the
// ordinary case rather than an edge one (spec D2). The versioned, outbound and
// team shapes get their own cases.
//
// This file is separate from relayWebhook.test.ts (966 lines, and about the
// INBOUND pipeline) purely for size - the harness idioms are the same ones.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
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
import { TEAM_SENDER_KEY, TEAM_SENDER_LABEL } from '../src/jobs/relayFanOut.js';
import {
  RELAY_RETRY_LEG_JOB,
  _resetRelayRetryLegForTests,
  registerRelayRetryLegJobHandler,
} from '../src/jobs/relayRetryLeg.js';
import { createLogger } from '../src/lib/logger.js';
import { relayRetryDigest, relayRetryProviderSid } from '../src/lib/relayRetryClaim.js';
import { SYSTEM_SENDER_KEY } from '../src/services/relayAnnouncements.js';
import type { MessageItem, RelayRecipientDelivery } from '../src/repos/messagesRepo.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  signedTwilioPost,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';
import type { LogCapture } from './helpers/logCapture.js';

const WARN = 40;
const ERROR = 50;
const STATUS_PATH = '/webhooks/twilio/status';

const CONV = 'conv-relay-1';
const POOL = '+15550109000';
const ALICE = '+15550100001';
const BOB = '+15550100002';
const CAROL = '+15550100003';
const BOB_KEY = 'c-bob';
const CAROL_KEY = 'c-carol';
/** The leg SIDs the fan-out would have written pointers for. */
const BOB_LEG_SID = 'SMleg-bob-0000';
const CAROL_LEG_SID = 'SMleg-carol-000';
const ROOT_SID = `SM${'5'.repeat(32)}`;
/** Older than any wall clock a claim can take, so the retry rows sort after it. */
const ROOT_PROVIDER_TS = '2026-09-01T12:00:00.000Z';
const RAW_BODY = 'is the unit still available?';
const LEG_BODY = 'Alice: is the unit still available?';
const PLACEMENT_ID = 'placement-relay-1';

interface SourceOptions {
  direction?: 'inbound' | 'outbound';
  author?: MessageItem['author'];
  senderKey?: string;
  versioned?: boolean;
  body?: string;
  /** Bob's slot as the fan-out left it, BEFORE the failure callback. */
  bobSlot?: RelayRecipientDelivery;
}

describe('relay 30003 retry claim (POST /webhooks/twilio/status)', () => {
  let world: FakeWorld;
  let app: Express;
  let capture: LogCapture;
  let outbound: InProcessOutboundQueueAdapter;
  let rootKey: string;

  beforeEach(() => {
    _resetForTests();
    _resetRelayRetryLegForTests();
    configureScheduler(new InMemorySchedulerAdapter());
    outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(outbound);
    world = createFakeWorld();
    const harness = makeWebhookHarness({ world });
    app = harness.app;
    capture = harness.capture;
    const logger = createLogger({ destination: capture.stream });
    configureJobsLogger(logger);
    // The SAME world the webhook writes through, so a rung the claim enqueues
    // runs against the row the claim just appended.
    registerRelayRetryLegJobHandler({
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      logger,
    });
    rootKey = '';
  });

  afterEach(() => {
    _resetForTests();
    _resetRelayRetryLegForTests();
  });

  function seedConversation(overrides: Record<string, unknown> = {}): void {
    world.conversations.set(CONV, {
      conversationId: CONV,
      participant_phone: POOL,
      pool_number: POOL,
      status: 'open',
      last_activity_at: ROOT_PROVIDER_TS,
      type: 'relay_group',
      ai_mode: 'manual',
      participants: [
        { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
        { contactId: BOB_KEY, phone: BOB, name: 'Bob' },
        { contactId: CAROL_KEY, phone: CAROL, name: 'Carol' },
      ],
      created_at: ROOT_PROVIDER_TS,
      ...overrides,
    });
  }

  /** An ACTIVE placement on the relay thread - what flagPlacementAttention needs. */
  async function seedPlacement(): Promise<void> {
    await world.placementsRepo.create({
      placementId: PLACEMENT_ID,
      tenantId: BOB_KEY,
      unitId: 'unit-1',
      stage: 'send_application',
    });
    const conv = world.conversations.get(CONV)!;
    conv.placementId = PLACEMENT_ID;
  }

  /**
   * Seed the source row the ladder retries, plus the two `relaysid#` pointers the
   * fan-out would have written. Written directly rather than through a real
   * fan-out so `world.sent` starts EMPTY - which is what makes "3 sends, all to
   * Bob" a real assertion rather than an arithmetic one.
   */
  async function seedSource(opts: SourceOptions = {}): Promise<string> {
    seedConversation();
    const versioned = opts.versioned ?? false;
    const versionedSlot = (status: RelayRecipientDelivery['status']): RelayRecipientDelivery => ({
      status,
      requestedTransport: 'sms',
      transportAggregationState: 'attempted',
    });
    const appended = await world.messagesRepo.append({
      conversationId: CONV,
      providerSid: ROOT_SID,
      providerTs: ROOT_PROVIDER_TS,
      type: 'sms',
      direction: opts.direction ?? 'inbound',
      author: opts.author ?? 'tenant',
      deliveryStatus: opts.direction === 'outbound' ? 'queued' : 'delivered',
      relaySenderKey: opts.senderKey ?? 'c-alice',
      ...(versioned && { transportSchemaVersion: 1 as const }),
      body: opts.body ?? RAW_BODY,
      deliveryRecipients: {
        [BOB_KEY]: opts.bobSlot ?? (versioned ? versionedSlot('sent') : { status: 'sent' }),
        // `sent`, not `delivered`: a delivered slot cannot take a failure
        // callback at all (forward-only), so the second-member escalation case
        // would silently assert nothing.
        [CAROL_KEY]: versioned ? versionedSlot('sent') : { status: 'sent' },
      },
    });
    for (const [sid, memberKey] of [
      [BOB_LEG_SID, BOB_KEY],
      [CAROL_LEG_SID, CAROL_KEY],
    ] as const) {
      await world.messagesRepo.putRelaySidPointer(sid, {
        conversationId: CONV,
        tsMsgId: appended.tsMsgId,
        memberKey,
      });
    }
    rootKey = appended.tsMsgId;
    return appended.tsMsgId;
  }

  function failureParams(over: Record<string, string> = {}): Record<string, string> {
    return {
      MessageSid: BOB_LEG_SID,
      MessageStatus: 'undelivered',
      ErrorCode: '30003',
      To: BOB,
      From: POOL,
      ApiVersion: '2010-04-01',
      ...over,
    };
  }

  async function postStatus(params: Record<string, string>): Promise<void> {
    const res = await signedTwilioPost(app, STATUS_PATH, params);
    expect(res.status).toBe(200);
  }

  /** The 30003 for Bob's ROOT leg. */
  async function postRootFailure(over: Record<string, string> = {}): Promise<void> {
    await postStatus(failureParams(over));
  }

  function retryRows(): MessageItem[] {
    return world.messages
      .filter((m) => typeof m.relay_retry_of === 'string')
      .slice()
      .sort((a, b) => (a.relay_retry_attempt ?? 0) - (b.relay_retry_attempt ?? 0));
  }

  function slotOf(tsMsgId: string, memberKey: string = BOB_KEY): RelayRecipientDelivery | undefined {
    return world.messages.find((m) => m.tsMsgId === tsMsgId)?.delivery_recipients?.[memberKey];
  }

  function scheduledRetryJobs(): { envelope: { jobName: string }; delaySeconds: number }[] {
    return outbound.delayed.filter((d) => d.envelope.jobName === RELAY_RETRY_LEG_JOB);
  }

  function failureLines(level: number): Record<string, unknown>[] {
    return capture
      .atLevel(level)
      .filter((l) => l['event'] === 'delivery_failed' && l['relay'] === true);
  }

  function escalations(): Record<string, unknown>[] {
    return capture.atLevel(WARN).filter((l) => l['event'] === 'placement_escalation');
  }

  /**
   * One turn of the ladder: run whatever rung is currently scheduled (none on the
   * first call), then post a 30003 for the leg that most recently sent to Bob -
   * the ROOT's leg first, then each retry leg's REAL provider SID through the
   * `relaysid#` pointer `sendOneRelayLeg` wrote for it.
   */
  async function failNextLeg(): Promise<void> {
    await outbound.deliverDelayed(dispatchJob);
    await outbound.settle();
    const rows = retryRows();
    const sourceKey = rows.length > 0 ? rows[rows.length - 1]!.tsMsgId : rootKey;
    const entry = [...world.relaySidPointers.entries()].find(
      ([, ref]) => ref.tsMsgId === sourceKey && ref.memberKey === BOB_KEY,
    );
    expect(entry).toBeDefined();
    await postStatus(failureParams({ MessageSid: entry![0] }));
  }

  // --- the claim itself ----------------------------------------------------

  // D8. The gate is the SLOT'S POST-WRITE STATE plus THIS callback's code, never
  // whether this callback transitioned the slot.
  it('claims exactly one retry for a forward 30003 on a relay leg', async () => {
    const root = await seedSource();

    await postRootFailure();

    const rows = retryRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      relay_retry_of: root,
      relay_retry_member_key: BOB_KEY,
      relay_retry_attempt: 1,
      relay_retry_origin_direction: 'inbound',
      relay_retry_dest_digest: relayRetryDigest(root, BOB),
      delivery_status: 'queued',
      direction: 'inbound',
      author: 'tenant',
      relay_sender_key: 'c-alice',
      type: 'sms',
    });
    expect(rows[0]!.provider_sid).toBe(
      relayRetryProviderSid(relayRetryDigest(root, BOB), 1),
    );
    // The seeded slot: one entry, for the failed member only, queued.
    expect(Object.keys(rows[0]!.delivery_recipients ?? {})).toEqual([BOB_KEY]);
    expect(slotOf(rows[0]!.tsMsgId)).toEqual({ status: 'queued' });
    // ONE rung scheduled, at the 1:1 ladder's first backoff.
    const jobs = scheduledRetryJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.delaySeconds).toBe(60);
    // The FAILED slot on the original is never rewritten (D1).
    expect(slotOf(root)).toMatchObject({ status: 'undelivered', errorCode: '30003' });
    // WARN while a retry is claimed, with the cause and the rung on the line.
    expect(failureLines(WARN)).toContainEqual(
      expect.objectContaining({ retryClaim: 'claimed', retryAttempt: 1 }),
    );
    expect(failureLines(ERROR)).toHaveLength(0);
  });

  // Sec 7 intention 11, server half: the ONE field that would delete the ORIGINAL
  // bubble (the timeline hides a retry row's PREDECESSOR).
  it('never stamps retry_of on the retry row', async () => {
    await seedSource();
    await postRootFailure();
    expect(retryRows()[0]!.retry_of).toBeUndefined();
    expect(retryRows()[0]!.retry_attempt).toBeUndefined();
  });

  // D3: the SID is the claim identity. It carries no '#' (splitTsMsgId splits on
  // the first one) and no phone number (a sort key must never hold a handset).
  it('keys the retry row on a phone-free deterministic SID, ordered after the root', async () => {
    const root = await seedSource();
    await postRootFailure();
    const row = retryRows()[0]!;
    expect(row.tsMsgId).toContain('relayretry-');
    expect(row.tsMsgId).not.toContain(BOB);
    expect(row.tsMsgId).not.toContain(BOB.slice(1));
    // Exactly one '#': splitTsMsgId splits on the FIRST one.
    expect(row.tsMsgId.split('#')).toHaveLength(2);
    // A WALL CLOCK, not derived from the root: at an identical providerTs the
    // retry would sort BELOW the team/system SIDs of the same second.
    expect(row.provider_ts > ROOT_PROVIDER_TS).toBe(true);
    expect(row.tsMsgId > root).toBe(true);
  });

  // D12: the row body stays RAW (it is what the inbox preview inherits); the
  // composed leg copy is stored separately and resent verbatim.
  it('stores the RAW body on the row and the composed leg copy beside it', async () => {
    await seedSource();
    await postRootFailure();
    const row = retryRows()[0]!;
    expect(row.body).toBe(RAW_BODY);
    expect(row.relay_retry_leg_body).toBe(LEG_BODY);

    // Rung 2 copies the stored leg copy VERBATIM even after the sender is renamed.
    const conv = world.conversations.get(CONV)!;
    conv.participants = [
      { contactId: 'c-alice', phone: ALICE, name: 'Alicia Renamed' },
      { contactId: BOB_KEY, phone: BOB, name: 'Bob' },
      { contactId: CAROL_KEY, phone: CAROL, name: 'Carol' },
    ];
    await failNextLeg();
    expect(retryRows()[1]!.relay_retry_leg_body).toBe(LEG_BODY);
    expect(world.sent[0]!.body).toBe(LEG_BODY);
  });

  // D3: a duplicate, redelivered or concurrent callback loses the create.
  it('claims nothing twice for a duplicate callback, and says so on the line', async () => {
    await seedSource();
    await postRootFailure();
    await postRootFailure();
    expect(retryRows()).toHaveLength(1);
    expect(scheduledRetryJobs()).toHaveLength(1);
    expect(failureLines(WARN)).toContainEqual(
      expect.objectContaining({ retryClaim: 'already_claimed', retryAttempt: 1 }),
    );
  });

  // D8, and this is the test a TRANSITION gate fails - it is why the gate reads
  // state. The crash is simulated by writing the slot terminal, then replaying
  // the callback: updateRecipientDeliveryStatus then transitions nothing.
  it('RECOVERS a claim lost to a crash between the slot write and the claim', async () => {
    await seedSource({ bobSlot: { status: 'undelivered', errorCode: '30003' } });
    await postRootFailure();
    expect(retryRows()).toHaveLength(1);
    expect(scheduledRetryJobs()).toHaveLength(1);
  });

  // D8's slot-code-ABSENT clause, exercised rather than assumed reachable:
  // `canceled` maps to failed with NO code, which then blocks the 30003 from ever
  // reaching the slot. Gating on the STORED code alone would refuse a real first
  // failure.
  it('claims when a code-less terminal callback landed first', async () => {
    await seedSource();
    const codeless = failureParams({ MessageStatus: 'canceled' });
    delete codeless['ErrorCode'];
    await postStatus(codeless);
    expect(retryRows()).toHaveLength(0);
    expect(slotOf(rootKey)).toMatchObject({ status: 'failed' });
    expect(slotOf(rootKey)!.errorCode).toBeUndefined();

    await postRootFailure();
    expect(retryRows()).toHaveLength(1);
  });

  // D8: the one reachable contradiction stays closed - a leg that sent, took a
  // terminal 30007, then received a second, contradictory 30003.
  it('claims nothing when the slot already reads a different terminal code', async () => {
    await seedSource({ bobSlot: { status: 'failed', errorCode: '30007' } });
    await postRootFailure();
    expect(retryRows()).toHaveLength(0);
    expect(failureLines(ERROR)).toContainEqual(
      expect.objectContaining({ retryClaim: 'slot_ineligible' }),
    );
  });

  // D7: the fence is POSITIVE. A negative one ("not system") passes on an
  // unreadable source and would claim a retry against a tour-reminder rung.
  it('claims nothing for an announcement leg, and keeps it at WARN', async () => {
    await seedSource({ senderKey: SYSTEM_SENDER_KEY, direction: 'outbound', author: 'ai' });
    await postRootFailure();
    expect(retryRows()).toHaveLength(0);
    expect(failureLines(WARN)).toContainEqual(
      expect.objectContaining({ retryClaim: 'fenced_announcement' }),
    );
    expect(failureLines(ERROR)).toHaveLength(0);
    // The fence asserts the VALUE, not the imported constant.
    expect(SYSTEM_SENDER_KEY).toBe('system');
  });

  // D7/D23. After the consistent read an absent row is genuinely absent - an
  // internal fault, which alarms with its OWN message so it is not misattributed
  // to the carrier.
  it('claims nothing when the source row cannot be read, with its own message', async () => {
    await seedSource();
    const realConsistent = world.messagesRepo.getByTsMsgIdConsistent.bind(world.messagesRepo);
    let reads = 0;
    world.messagesRepo.getByTsMsgIdConsistent = async (conversationId, tsMsgId) => {
      reads += 1;
      if (reads === 1) return undefined;
      return realConsistent(conversationId, tsMsgId);
    };

    await postRootFailure();

    expect(retryRows()).toHaveLength(0);
    const line = failureLines(ERROR).find((l) => l['retryClaim'] === 'source_unreadable');
    expect(line).toBeDefined();
    expect(line!['msg']).not.toBe('twilio relay-recipient delivery failed (undelivered/failed)');
    expect(String(line!['msg'])).toContain('source message row unreadable');
  });

  // D5: missing or malformed must never mint a different digest and thus a
  // parallel ladder.
  it.each([
    ['missing', undefined, 'to_missing'],
    ['malformed', 'not-a-number', 'to_malformed'],
  ])('claims nothing when To is %s', async (_label, to, expected) => {
    await seedSource();
    const params = failureParams();
    if (to === undefined) delete params['To'];
    else params['To'] = to;

    await postStatus(params);

    expect(retryRows()).toHaveLength(0);
    expect(failureLines(ERROR)).toContainEqual(expect.objectContaining({ retryClaim: expected }));
  });

  // D23 / adjudication S2a: EVERY relay failure line carries a cause, including
  // the ones no ladder could ever run for.
  it('stamps code_not_retryable on a relay failure whose code is not 30003', async () => {
    await seedSource();
    await postRootFailure({ ErrorCode: '30005' });
    expect(retryRows()).toHaveLength(0);
    expect(failureLines(ERROR)).toContainEqual(
      expect.objectContaining({ retryClaim: 'code_not_retryable', errorCode: '30005' }),
    );
  });

  // --- the ladder ----------------------------------------------------------

  // Rungs 2 and 3 chain to the ROOT, not to the previous rung: that key is what
  // the thread-level join buckets on.
  it('points every rung at the root message', async () => {
    const root = await seedSource();

    await failNextLeg();
    await failNextLeg();
    await failNextLeg();

    const rows = retryRows();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.relay_retry_of)).toEqual([root, root, root]);
    expect(rows.map((r) => r.relay_retry_attempt)).toEqual([1, 2, 3]);
    // One ladder, one digest: the destination never changed.
    expect(new Set(rows.map((r) => r.relay_retry_dest_digest)).size).toBe(1);
  });

  it('stops at the cap and says the cap is what stopped it', async () => {
    await seedSource();
    for (let i = 0; i < 5; i += 1) await failNextLeg();
    expect(retryRows()).toHaveLength(3);
    expect(failureLines(ERROR)).toContainEqual(
      expect.objectContaining({ retryClaim: 'cap_exhausted' }),
    );
  });

  // Sec 7 intention 7, on EVERY rung. "No duplicate send" is the criterion a
  // green chip cannot establish, and only a unit test can walk the whole ladder.
  it('never sends to any other member, on any rung', async () => {
    await seedSource();
    for (let i = 0; i < 5; i += 1) await failNextLeg();
    expect(world.sent.filter((p) => p.to === BOB)).toHaveLength(3);
    expect(world.sent.filter((p) => p.to !== BOB)).toHaveLength(0);
  });

  // --- what the retry row mirrors -----------------------------------------

  // Sec 7 intention 18. A versioned slot on a legacy row would drive the blind
  // whole-slot write and erase the aggregation state the first send needs.
  it('a LEGACY original produces a legacy retry row and a legacy slot', async () => {
    await seedSource({ versioned: false });
    await postRootFailure();
    const row = retryRows()[0]!;
    expect(row.transport_schema_version).toBeUndefined();
    expect(row.requested_transport).toBeUndefined();
    expect(row.actual_transport).toBeUndefined();
    expect(slotOf(row.tsMsgId)).toEqual({ status: 'queued' });
  });

  // D2: `planned` is load-bearing - `attempted` is reachable ONLY from it, so a
  // slot seeded without it throws on the very first retry send.
  it('a VERSIONED original produces a versioned retry row with a planned slot', async () => {
    await seedSource({ versioned: true });
    await postRootFailure();
    const row = retryRows()[0]!;
    expect(row.transport_schema_version).toBe(1);
    expect(slotOf(row.tsMsgId)).toEqual({
      status: 'queued',
      requestedTransport: 'sms',
      transportAggregationState: 'planned',
    });
    // And the send really does reach `attempted` from it.
    await outbound.deliverDelayed(dispatchJob);
    await outbound.settle();
    expect(slotOf(row.tsMsgId)).toMatchObject({ transportAggregationState: 'attempted' });
  });

  // D2: the prohibition is on the MESSAGE's requestedTransport, NOT on the slot's,
  // which is permitted and required. Inverting the two is the easy mistake.
  it('a versioned INBOUND original carries no message-level requested transport', async () => {
    await seedSource({ versioned: true, direction: 'inbound' });
    await postRootFailure();
    const row = retryRows()[0]!;
    expect(row.direction).toBe('inbound');
    expect(row.relay_retry_origin_direction).toBe('inbound');
    expect(row.requested_transport).toBeUndefined();
    expect(slotOf(row.tsMsgId)!.requestedTransport).toBe('sms');
  });

  // A team original yields an OUTBOUND retry row, and its leg copy comes from the
  // neutral team label - the only value any caller passes as senderNameOverride.
  it('an OUTBOUND team original mirrors its shape and composes the team leg copy', async () => {
    await seedSource({
      direction: 'outbound',
      author: 'teammate',
      senderKey: TEAM_SENDER_KEY,
      versioned: true,
    });
    await postRootFailure();
    const row = retryRows()[0]!;
    expect(row).toMatchObject({
      direction: 'outbound',
      author: 'teammate',
      relay_sender_key: TEAM_SENDER_KEY,
      relay_retry_origin_direction: 'outbound',
      delivery_status: 'queued',
    });
    expect(row.relay_retry_leg_body).toBe(`${TEAM_SENDER_LABEL}: ${RAW_BODY}`);
  });

  // --- the enqueue failure -------------------------------------------------

  // D14: `enqueue_failed`, never the cap's `transient_cap` - one code for both
  // would tell an operator retries ran when none did.
  it('closes the retry leg enqueue_failed when the enqueue throws', async () => {
    await seedSource();
    outbound.enqueue = async () => {
      throw new Error('queue down');
    };

    await postRootFailure();

    const row = retryRows()[0]!;
    expect(slotOf(row.tsMsgId)).toMatchObject({ status: 'failed', errorCode: 'enqueue_failed' });
    expect(failureLines(ERROR)).toContainEqual(
      expect.objectContaining({ retryClaim: 'enqueue_failed', retryAttempt: 1 }),
    );
    // The diagnostic line carries the cause and no phone number.
    const detail = capture
      .atLevel(ERROR)
      .find((l) => l['retryClaim'] === 'enqueue_failed' && l['closeCode'] === 'enqueue_failed');
    expect(detail).toBeDefined();
    expect(detail!['memberKey']).toBe(BOB_KEY);
    expect(JSON.stringify(detail)).not.toContain(BOB);
  });

  it('closes a VERSIONED retry leg enqueue_failed through the transport-aware path', async () => {
    await seedSource({ versioned: true });
    outbound.enqueue = async () => {
      throw new Error('queue down');
    };

    await postRootFailure();

    expect(slotOf(retryRows()[0]!.tsMsgId)).toMatchObject({
      status: 'failed',
      errorCode: 'enqueue_failed',
      transportAggregationState: 'excluded',
    });
  });

  // --- the SSE on claim ----------------------------------------------------

  // D16 + adjudication S4. Arranged as the crash-recovery case on purpose: the
  // slot is already terminal, so nothing transitions and the EXISTING emit cannot
  // fire. Only the claim's own emit can produce this - and without it the chip
  // reads "1 failed" for the whole first backoff interval.
  it('emits message.persisted for the ROOT even when nothing transitioned', async () => {
    const root = await seedSource({ bobSlot: { status: 'undelivered', errorCode: '30003' } });

    await postRootFailure();

    const rootEmits = world.emitted.filter(
      (e) =>
        e.event === 'message.persisted' &&
        (e.payload as { tsMsgId?: string }).tsMsgId === root,
    );
    expect(rootEmits).toHaveLength(1);
  });

  it('addresses the ROOT on rung 2, never the retry row it was called for', async () => {
    const root = await seedSource();
    await failNextLeg();
    world.emitted.length = 0;

    await failNextLeg();

    const claimEmits = world.emitted.filter((e) => e.event === 'message.persisted');
    expect(claimEmits.length).toBeGreaterThan(0);
    expect(
      claimEmits.some((e) => (e.payload as { tsMsgId?: string }).tsMsgId === root),
    ).toBe(true);
  });

  // --- the placement escalation -------------------------------------------

  it('escalates once on the first 30003, exactly as today', async () => {
    await seedSource();
    await seedPlacement();
    await postRootFailure();
    expect(escalations()).toHaveLength(1);
  });

  // The regression this exists to prevent: every rung re-enters the same handler,
  // so an untouched call site escalates FOUR times and resets the triage clock at
  // +60s, +180s and +420s.
  it('does not re-escalate on any rung of the ladder', async () => {
    await seedSource();
    await seedPlacement();
    for (let i = 0; i < 5; i += 1) await failNextLeg();
    expect(retryRows()).toHaveLength(3);
    expect(escalations()).toHaveLength(1);
  });

  // THE test that separates the right discriminator from a plausible wrong one.
  // "Skip when any retry row exists in this conversation" passes both tests above
  // and silently swallows a SECOND member's failure - a different tenant, never
  // escalated to a human. The discriminator is the SOURCE ROW, not the thread.
  it('still escalates a different member failing mid-ladder', async () => {
    await seedSource();
    await seedPlacement();

    await failNextLeg(); // member A (Bob), the ROOT's leg
    await failNextLeg(); // member A, rung 1 - no second escalation
    await postStatus(
      failureParams({ MessageSid: CAROL_LEG_SID, To: CAROL, ErrorCode: '30005' }),
    );

    expect(escalations()).toHaveLength(2);
  });
});
