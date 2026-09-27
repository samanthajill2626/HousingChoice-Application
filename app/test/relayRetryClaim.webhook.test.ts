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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { RelayRetryGateCode } from '../src/lib/relayRetryGates.js';
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
/** Bob's number after a change (the changed-number gate, retry-send-window D3). */
const BOB_NEW = '+15558675399';

/**
 * An ISO instant `minutes` before now - a relay slot's `sentAt`, the send
 * window's origin (retry-send-window D2). Wall-clock relative, with a margin
 * of 30 seconds or more against every boundary a test aims at.
 */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

interface SourceOptions {
  direction?: 'inbound' | 'outbound';
  author?: MessageItem['author'];
  senderKey?: string;
  versioned?: boolean;
  body?: string;
  /** Bob's slot as the fan-out left it, BEFORE the failure callback. */
  bobSlot?: RelayRecipientDelivery;
  /** Carol's slot, likewise (retry-send-window: the same-data comparison). */
  carolSlot?: RelayRecipientDelivery;
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
        [CAROL_KEY]: opts.carolSlot ?? (versioned ? versionedSlot('sent') : { status: 'sent' }),
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

  /**
   * Run the rung that is currently scheduled (it sends to Bob) and return that
   * rung's REAL leg SID - so a test can change the world between a rung going
   * out and its failure callback arriving.
   */
  async function runScheduledRung(): Promise<string> {
    await outbound.deliverDelayed(dispatchJob);
    await outbound.settle();
    const rows = retryRows();
    const latest = rows[rows.length - 1]!;
    const entry = [...world.relaySidPointers.entries()].find(
      ([, ref]) => ref.tsMsgId === latest.tsMsgId && ref.memberKey === BOB_KEY,
    );
    expect(entry).toBeDefined();
    return entry![0];
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
    // WARN, not ERROR (code review R1 F1, narrowed by R2 W1): this leg ended on
    // 30007 and was logged at 30007's own severity when it did. The
    // contradictory 30003 is not a second dead end - the severity battery in
    // twilioStatusWebhook.test.ts owns that rule; here the point is the OUTCOME,
    // which is `slot_settled` and NOT the anomaly value beside it.
    expect(failureLines(WARN)).toContainEqual(
      expect.objectContaining({ retryClaim: 'slot_settled' }),
    );
    expect(failureLines(ERROR)).toHaveLength(0);
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

  // --- a THROW inside the claim --------------------------------------------

  /** Reject `messages.append` exactly ONCE, then let it work. Returns a probe
   *  for whether the rejection was actually consumed. */
  function rejectAppendOnce(): () => boolean {
    let rejected = false;
    const realAppend = world.messagesRepo.append.bind(world.messagesRepo);
    world.messagesRepo.append = async (message) => {
      if (!rejected) {
        rejected = true;
        throw new Error('dynamodb throttled');
      }
      return realAppend(message);
    };
    return () => rejected;
  }

  // Code review R1 F2, CORRECTED by R2 W2. The helper cannot RETURN out of the
  // handler, but it can THROW - `append` rethrows a condition failure, and every
  // read it makes can time out. Unguarded, the rejection would skip the whole
  // tail; on Twilio's redelivery nothing transitions, so the placement
  // escalation would be lost for that leg for good. So the tail runs FIRST and
  // the error is rethrown AFTER it - the 5xx is what makes Twilio redeliver, and
  // the redelivery is the ladder's only recovery (the next case).
  it('runs the whole tail and then REJECTS when the claim itself throws', async () => {
    await seedSource();
    await seedPlacement();
    const wasRejected = rejectAppendOnce();

    // The route 5xxs rather than acking: D8's state gate re-claims on the
    // redelivery, and acking 200 here would lose the member's message for good.
    const res = await signedTwilioPost(app, STATUS_PATH, failureParams());
    expect(res.status).toBe(500);

    expect(wasRejected()).toBe(true);
    expect(retryRows()).toHaveLength(0);
    // ONE ERROR LINE IN THE WHOLE CAPTURE - counted over every line at ERROR,
    // not over the markers (code review R3, X1 / R3 finding 1.1). Fix wave 2
    // counted markers and so could not see the SECOND line it had introduced:
    // the rethrow reached `createExpressErrorHandler`, whose generic
    // `unhandled error while handling request` carries no `event`, no
    // `retryClaim` and no `memberKey` yet feeds the same ErrorLogs alarm. The
    // route now answers the 500 itself, so this count is the whole claim.
    expect(capture.atLevel(ERROR)).toHaveLength(1);
    expect(failureLines(WARN)).toHaveLength(0);
    const markers = failureLines(ERROR).filter((l) => l['retryClaim'] === 'claim_failed');
    expect(markers).toHaveLength(1);
    const marker = markers[0]!;
    // Its own message, like `source_unreadable`: nothing about the carrier failed.
    expect(marker['msg']).not.toBe('twilio relay-recipient delivery failed (undelivered/failed)');
    expect(marker['err']).toBeDefined();
    expect(JSON.stringify(marker)).toContain('dynamodb throttled');
    expect(JSON.stringify(marker)).not.toContain(BOB);
    // The EXISTING SSE still fires (the slot did transition), and the escalation
    // still runs exactly once - the two things the tail exists for.
    expect(
      world.emitted.filter(
        (e) =>
          e.event === 'message.persisted' &&
          (e.payload as { tsMsgId?: string }).tsMsgId === rootKey,
      ),
    ).toHaveLength(1);
    expect(escalations()).toHaveLength(1);
  });

  // THE RECOVERY the 5xx buys, and the reason the rethrow is worth its cost.
  // Twilio redelivers on a 5xx; D8 gates the claim on the SLOT'S POST-WRITE
  // STATE, which the first callback already wrote, so the redelivered callback
  // reads terminal-plus-30003 and claims. Fix wave 1 acked 200 here and a test
  // pinned `retryRows()` at zero - i.e. specified the loss.
  it('CLAIMS on the redelivery that the rejection triggered', async () => {
    await seedSource();
    await seedPlacement();
    rejectAppendOnce();
    expect((await signedTwilioPost(app, STATUS_PATH, failureParams())).status).toBe(500);
    expect(retryRows()).toHaveLength(0);

    // Twilio's redelivery of the SAME callback.
    await postRootFailure();

    expect(retryRows()).toHaveLength(1);
    expect(scheduledRetryJobs()).toHaveLength(1);
    // And the escalation does NOT double-fire: it is gated on `transitioned`,
    // which is false the second time round.
    expect(escalations()).toHaveLength(1);
  });

  // Code review R3, X1. The catch at the call site is NARROW: it answers the
  // 500 only for the claim's own rethrow, which it recognises by IDENTITY. Any
  // OTHER fault out of this branch emitted no failure marker, so swallowing it
  // would leave a 500 with no ERROR line anywhere - strictly worse than the two
  // lines X1 exists to reduce to one. This case is what makes that a property
  // rather than an intention.
  it('lets an UNRELATED relay fault keep the generic handlers ERROR line', async () => {
    await seedSource();
    world.messagesRepo.updateRecipientDeliveryStatus = async () => {
      throw new Error('slot write down');
    };

    const res = await signedTwilioPost(app, STATUS_PATH, failureParams());
    expect(res.status).toBe(500);

    // No marker at all - the tail never ran - so the generic line is the ONLY
    // record this fault has, and it must survive.
    expect(failureLines(ERROR)).toHaveLength(0);
    const errors = capture.atLevel(ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!['msg']).toContain('unhandled error while handling request');
    expect(JSON.stringify(errors[0])).toContain('slot write down');
  });

  // Code review R2, W2 / R2 2.6. The enqueue-failure CLOSE runs inside the
  // enqueue's own catch; when it throws too, the claim has still DECIDED and a
  // retry row exists, so the outcome must stay `enqueue_failed`. Reporting
  // `claim_failed` ("threw before deciding - no retry claimed") described the
  // opposite state, and would now also 5xx a callback whose row already exists.
  it('keeps enqueue_failed when the enqueue-failure close throws as well', async () => {
    await seedSource();
    outbound.enqueue = async () => {
      throw new Error('queue down');
    };
    // The LEGACY close path is `setRecipientDelivery`; the root leg's own write
    // above goes through `updateRecipientDeliveryStatus` and is untouched.
    world.messagesRepo.setRecipientDelivery = async () => {
      throw new Error('close failed too');
    };

    // Still a 200: a row exists and nothing is recoverable by redelivering.
    await postRootFailure();

    const rows = retryRows();
    expect(rows).toHaveLength(1);
    const line = failureLines(ERROR).find((l) => l['retryClaim'] === 'enqueue_failed');
    expect(line).toBeDefined();
    // The claim decided, so this is NOT the claim_failed shape...
    expect(failureLines(ERROR).some((l) => l['retryClaim'] === 'claim_failed')).toBe(false);
    // ...and the diagnostic line names the close failure while claiming NO
    // close code, because nothing was written.
    const detail = capture
      .atLevel(ERROR)
      .find((l) => l['retryClaim'] === 'enqueue_failed' && l['retryTsMsgId'] !== undefined)!;
    expect(detail['closeErr']).toBeDefined();
    expect(detail['closeCode']).toBeUndefined();
    expect(JSON.stringify(detail)).not.toContain(BOB);
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

  // --- retry-send-window: the claim decides at once (spec D2, D3, D5, D9) ---
  //
  // Every NEW fixture below carries a slot `sentAt` - the window's origin
  // (D2). The older fixtures above carry none and pass through D5 unchanged:
  // their rungs are claimed without a window check, exactly as before.

  it('retry-send-window D3: with every gate passing inside the window, claims as today and carries the origin', async () => {
    const sentAt = minutesAgo(1);
    const root = await seedSource({ bobSlot: { status: 'sent', sentAt } });

    await postRootFailure();

    const rows = retryRows();
    expect(rows).toHaveLength(1);
    // D2: the ROOT member slot's sentAt, carried on the rung. The harness
    // append preserves the field (Task 2), so this cannot pass vacuously.
    expect(rows[0]!.relay_retry_window_start).toBe(sentAt);
    expect(slotOf(rows[0]!.tsMsgId)).toEqual({ status: 'queued' });
    const jobs = scheduledRetryJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.delaySeconds).toBe(60);
    expect(failureLines(WARN)).toContainEqual(
      expect.objectContaining({ retryClaim: 'claimed', retryAttempt: 1 }),
    );
    expect(failureLines(ERROR)).toHaveLength(0);
    // No D5 line: the origin was usable.
    expect(capture.atLevel(WARN).some((l) => l['windowOrigin'] !== undefined)).toBe(false);
    // The member's slot on the ROOT is untouched by the claim.
    expect(slotOf(root)).toEqual({ status: 'undelivered', errorCode: '30003', sentAt });
  });

  const claimGateCases: [string, () => void, RelayRetryGateCode][] = [
    [
      'the group closed',
      () => {
        world.conversations.get(CONV)!.status = 'closed';
      },
      'retry_group_closed',
    ],
    [
      'the member was removed',
      () => {
        const conv = world.conversations.get(CONV)!;
        conv.participants = (conv.participants ?? []).filter((m) => m.contactId !== BOB_KEY);
      },
      'retry_member_removed',
    ],
    [
      'the number changed',
      () => {
        const conv = world.conversations.get(CONV)!;
        conv.participants = (conv.participants ?? []).map((m) =>
          m.contactId === BOB_KEY ? { ...m, phone: BOB_NEW } : m,
        );
      },
      'retry_number_changed',
    ],
    [
      'the member opted out',
      () => {
        world.contacts.push({ contactId: BOB_KEY, type: 'tenant', phone: BOB, sms_opt_out: true });
      },
      'retry_opted_out',
    ],
  ];

  it.each(claimGateCases)(
    'retry-send-window D3: when %s, rung 1 is APPENDED already CLOSED with that gate code and nothing is enqueued',
    async (_label, arrange, code) => {
      const sentAt = minutesAgo(1);
      const root = await seedSource({ bobSlot: { status: 'sent', sentAt } });
      arrange();

      await postRootFailure();

      const rows = retryRows();
      expect(rows).toHaveLength(1);
      // ONE data shape: the rung exists with its full lineage and origin, and
      // is appended closed with the code the job itself would have written.
      expect(rows[0]).toMatchObject({
        relay_retry_of: root,
        relay_retry_attempt: 1,
        relay_retry_window_start: sentAt,
        delivery_status: 'queued',
      });
      expect(slotOf(rows[0]!.tsMsgId)).toEqual({ status: 'failed', errorCode: code });
      expect(scheduledRetryJobs()).toHaveLength(0);
      expect(world.sent).toHaveLength(0);
      // WARN (Cameron's Q1 ruling), carrying the code the rung was appended with.
      expect(failureLines(WARN)).toContainEqual(
        expect.objectContaining({ retryClaim: 'gate_refused', retryAttempt: 1, closeCode: code }),
      );
      expect(capture.atLevel(ERROR)).toHaveLength(0);
      expect(slotOf(root)).toEqual({ status: 'undelivered', errorCode: '30003', sentAt });
    },
  );

  it('retry-send-window D3: with two gates refusing, the rung carries the one the JOB checks first', async () => {
    await seedSource({ bobSlot: { status: 'sent', sentAt: minutesAgo(1) } });
    // Number changed AND opted out: the job checks the number first.
    const conv = world.conversations.get(CONV)!;
    conv.participants = (conv.participants ?? []).map((m) =>
      m.contactId === BOB_KEY ? { ...m, phone: BOB_NEW } : m,
    );
    world.contacts.push({ contactId: BOB_KEY, type: 'tenant', phone: BOB_NEW, sms_opt_out: true });

    await postRootFailure();

    expect(slotOf(retryRows()[0]!.tsMsgId)).toEqual({
      status: 'failed',
      errorCode: 'retry_number_changed',
    });
    expect(failureLines(WARN)).toContainEqual(
      expect.objectContaining({ retryClaim: 'gate_refused', closeCode: 'retry_number_changed' }),
    );
  });

  it('retry-send-window D3: a gate refusal is recorded ahead of a closed window - the gates run first', async () => {
    await seedSource({ bobSlot: { status: 'sent', sentAt: minutesAgo(14) } });
    world.conversations.get(CONV)!.status = 'closed';

    await postRootFailure();

    expect(slotOf(retryRows()[0]!.tsMsgId)).toEqual({
      status: 'failed',
      errorCode: 'retry_group_closed',
    });
    expect(failureLines(WARN)).toContainEqual(
      expect.objectContaining({ retryClaim: 'gate_refused', closeCode: 'retry_group_closed' }),
    );
    expect(capture.atLevel(ERROR)).toHaveLength(0);
  });

  it.each([2, 3])(
    'retry-send-window D3: a member who opts out mid-ladder gets rung %i appended CLOSED at the claim, carrying the ROOT origin',
    async (rung) => {
      const sentAt = minutesAgo(1);
      await seedSource({ bobSlot: { status: 'sent', sentAt } });
      await postRootFailure(); // rung 1 claimed open
      for (let next = 2; next <= rung; next += 1) {
        const legSid = await runScheduledRung(); // rung next-1 goes out
        if (next === rung) {
          world.contacts.push({ contactId: BOB_KEY, type: 'tenant', phone: BOB, sms_opt_out: true });
        }
        await postStatus(failureParams({ MessageSid: legSid })); // ...and fails 30003
      }

      const rows = retryRows();
      expect(rows).toHaveLength(rung);
      const declined = rows[rung - 1]!;
      expect(declined.relay_retry_attempt).toBe(rung);
      // Carried rung to rung from the ROOT leg (D2), never re-derived.
      expect(declined.relay_retry_window_start).toBe(sentAt);
      expect(slotOf(declined.tsMsgId)).toEqual({ status: 'failed', errorCode: 'retry_opted_out' });
      expect(scheduledRetryJobs()).toHaveLength(0);
      expect(world.sent).toHaveLength(rung - 1);
      expect(failureLines(WARN)).toContainEqual(
        expect.objectContaining({
          retryClaim: 'gate_refused',
          retryAttempt: rung,
          closeCode: 'retry_opted_out',
        }),
      );
      expect(failureLines(ERROR)).toHaveLength(0);
    },
  );

  it('retry-send-window D3: a TEAM send declined at the claim keeps its mirrored shape and its gate code', async () => {
    const sentAt = minutesAgo(1);
    const root = await seedSource({
      direction: 'outbound',
      author: 'teammate',
      senderKey: TEAM_SENDER_KEY,
      versioned: true,
      bobSlot: { status: 'sent', requestedTransport: 'sms', transportAggregationState: 'attempted', sentAt },
    });
    const conv = world.conversations.get(CONV)!;
    conv.participants = (conv.participants ?? []).filter((m) => m.contactId !== BOB_KEY);

    await postRootFailure();

    const row = retryRows()[0]!;
    expect(row).toMatchObject({
      direction: 'outbound',
      author: 'teammate',
      relay_sender_key: TEAM_SENDER_KEY,
      relay_retry_origin_direction: 'outbound',
      relay_retry_window_start: sentAt,
      relay_retry_leg_body: `${TEAM_SENDER_LABEL}: ${RAW_BODY}`,
    });
    expect(slotOf(row.tsMsgId)).toEqual({
      status: 'failed',
      requestedTransport: 'sms',
      transportAggregationState: 'excluded',
      errorCode: 'retry_member_removed',
    });
    expect(scheduledRetryJobs()).toHaveLength(0);
    expect(failureLines(WARN)).toContainEqual(
      expect.objectContaining({ retryClaim: 'gate_refused', retryAttempt: 1, closeCode: 'retry_member_removed' }),
    );
    expect(failureLines(ERROR)).toHaveLength(0);
    // Spec section 6 intention 2 ("the slot on the root is unchanged in every case"): this callback's own status write only.
    expect(slotOf(root)).toEqual({
      status: 'undelivered',
      requestedTransport: 'sms',
      transportAggregationState: 'attempted',
      errorCode: '30003',
      sentAt,
    });
  });

  it.each([false, true])(
    'retry-send-window D3: a rung that would send past the window is APPENDED CLOSED retry_window_closed - one write, one ERROR, nothing enqueued (versioned=%s)',
    async (versioned) => {
      // One minute of window left; rung 1 needs 60s backoff + 60s grace.
      const sentAt = minutesAgo(14);
      const root = await seedSource({
        versioned,
        bobSlot: versioned
          ? { status: 'sent', requestedTransport: 'sms', transportAggregationState: 'attempted', sentAt }
          : { status: 'sent', sentAt },
      });
      // The three writers a job-time refusal uses. The root leg's own writes
      // go through updateRecipientDeliveryStatus / setRecipientActualTransport,
      // so any call to these would be a second write on the rung.
      const setSlot = vi.spyOn(world.messagesRepo, 'setRecipientDelivery');
      const setState = vi.spyOn(world.messagesRepo, 'setRecipientTransportAggregationState');
      const applyResult = vi.spyOn(world.messagesRepo, 'applyRecipientSendResult');

      await postRootFailure();

      const rows = retryRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.relay_retry_window_start).toBe(sentAt);
      // The SAME slot the job's own window refusal leaves (Task 5 pins the job
      // side to this identical literal) - written by the append alone.
      expect(slotOf(rows[0]!.tsMsgId)).toEqual(
        versioned
          ? {
              status: 'failed',
              requestedTransport: 'sms',
              transportAggregationState: 'excluded',
              errorCode: 'retry_window_closed',
            }
          : { status: 'failed', errorCode: 'retry_window_closed' },
      );
      expect(setSlot).not.toHaveBeenCalled();
      expect(setState).not.toHaveBeenCalled();
      expect(applyResult).not.toHaveBeenCalled();
      expect(scheduledRetryJobs()).toHaveLength(0);
      expect(world.sent).toHaveLength(0);
      // D9: ONE ERROR line - the marker, through isTerminalRelayLegFailure.
      expect(capture.atLevel(ERROR)).toHaveLength(1);
      expect(failureLines(ERROR)).toContainEqual(
        expect.objectContaining({
          retryClaim: 'window_closed',
          retryAttempt: 1,
          closeCode: 'retry_window_closed',
          errorCode: '30003',
        }),
      );
      expect(failureLines(WARN)).toHaveLength(0);
      // The member's slot on the ROOT holds exactly what this callback's own
      // status write left - the failure over the seeded slot - in BOTH shapes:
      // the claim never writes it (spec D3). The fixture leg SID yields no
      // observed transport, so no actualTransport is written either.
      expect(slotOf(root)).toEqual(
        versioned
          ? {
              status: 'undelivered',
              requestedTransport: 'sms',
              transportAggregationState: 'attempted',
              errorCode: '30003',
              sentAt,
            }
          : { status: 'undelivered', errorCode: '30003', sentAt },
      );
    },
  );

  it('retry-send-window D2/D3: rung 2 measures from the ORIGIN rung 1 carried, never from the fresh send of rung 1', async () => {
    // 2.5 minutes of window left. Rung 1 needs 60s backoff + 60s grace: it
    // fits. Rung 2 needs 120s + 60s: it does not - measured from the ROOT
    // leg's send. Rung 1's own slot gets a FRESH sentAt when it goes out, so a
    // claim that re-derived the origin from that slot would find the whole
    // window left and claim.
    const sentAt = minutesAgo(12.5);
    await seedSource({ bobSlot: { status: 'sent', sentAt } });
    await postRootFailure();
    expect(retryRows()[0]!.relay_retry_window_start).toBe(sentAt);
    expect(scheduledRetryJobs()).toHaveLength(1);

    await failNextLeg(); // rung 1 goes out, then its own leg fails 30003

    const rows = retryRows();
    expect(rows).toHaveLength(2);
    const rungOneSentAt = slotOf(rows[0]!.tsMsgId)?.sentAt;
    expect(rungOneSentAt).toBeDefined();
    expect(Date.now() - Date.parse(rungOneSentAt!)).toBeLessThan(60_000);
    // Copied from rung 1's row, not re-derived from rung 1's own slot.
    expect(rows[1]!.relay_retry_window_start).toBe(sentAt);
    expect(slotOf(rows[1]!.tsMsgId)).toEqual({ status: 'failed', errorCode: 'retry_window_closed' });
    expect(scheduledRetryJobs()).toHaveLength(0);
    expect(failureLines(ERROR)).toContainEqual(
      expect.objectContaining({
        retryClaim: 'window_closed',
        retryAttempt: 2,
        closeCode: 'retry_window_closed',
      }),
    );
  });

  it('Review Focus 3: rung 2 of a ladder whose rung 1 predates this deploy (no carried origin) claims OPEN, with one WARN naming the gap', async () => {
    // 12.5 minutes after the root leg's send: a windowed rung 2 (120 s backoff
    // + 60 s grace) would be declined. Without a carried origin the claim
    // cannot measure the window, so it must not decline on it (spec D5).
    const sentAt = minutesAgo(12.5);
    await seedSource({ bobSlot: { status: 'sent', sentAt } });
    await postRootFailure();
    // A rung 1 written before this deploy carries no origin. retryRows()
    // returns the stored rows, so this edits the world.
    delete (retryRows()[0] as { relay_retry_window_start?: string }).relay_retry_window_start;

    await failNextLeg(); // rung 1 goes out, then its own leg fails 30003

    const rows = retryRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.relay_retry_window_start).toBeUndefined();
    expect(slotOf(rows[1]!.tsMsgId)?.status).toBe('queued');
    const gap = capture.atLevel(WARN).filter((l) => l['windowOrigin'] !== undefined);
    expect(gap).toContainEqual(
      expect.objectContaining({
        windowOrigin: 'missing',
        originField: 'relay_retry_window_start',
        attempt: 2,
      }),
    );
  });

  it.each<[string, string | undefined]>([
    ['missing', undefined],
    ['unparseable', 'not-a-date'],
  ])(
    'retry-send-window D5: a %s slot sentAt fails OPEN - claimed without a window check, with one WARN naming the gap',
    async (label, sentAt) => {
      await seedSource({ bobSlot: sentAt === undefined ? { status: 'sent' } : { status: 'sent', sentAt } });

      await postRootFailure();

      const rows = retryRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.relay_retry_window_start).toBeUndefined();
      expect(scheduledRetryJobs()).toHaveLength(1);
      expect(failureLines(WARN)).toContainEqual(expect.objectContaining({ retryClaim: 'claimed' }));
      const gap = capture.atLevel(WARN).filter((l) => l['windowOrigin'] !== undefined);
      expect(gap).toHaveLength(1);
      expect(gap[0]).toMatchObject({
        windowOrigin: label,
        originField: 'sentAt',
        attempt: 1,
        memberKey: BOB_KEY,
        retryTsMsgId: rows[0]!.tsMsgId,
      });
      expect(JSON.stringify(gap[0])).not.toContain(BOB);
    },
  );

  it.each([false, true])(
    'retry-send-window D3: a claim-time decline appends the SAME rung data the job refusal leaves for that code (versioned=%s)',
    async (versioned) => {
      const sentAt = minutesAgo(1);
      const legSlot = (): RelayRecipientDelivery =>
        versioned
          ? { status: 'sent', requestedTransport: 'sms', transportAggregationState: 'attempted', sentAt }
          : { status: 'sent', sentAt };
      await seedSource({ versioned, bobSlot: legSlot(), carolSlot: legSlot() });
      // Carol's leg fails while the group is OPEN: her rung is claimed open.
      await postStatus(failureParams({ MessageSid: CAROL_LEG_SID, To: CAROL }));
      // The group closes. Bob's leg fails now: the CLAIM declines his rung and
      // appends it already closed - it is never enqueued, so only Carol's
      // rung is waiting. (Before this task both rungs were enqueued and the
      // job refused both, which would make the comparison below vacuous.)
      world.conversations.get(CONV)!.status = 'closed';
      await postRootFailure();
      expect(scheduledRetryJobs()).toHaveLength(1);
      const bobRung = retryRows().find((r) => r.relay_retry_member_key === BOB_KEY)!;
      expect(slotOf(bobRung.tsMsgId, BOB_KEY)).toMatchObject({
        status: 'failed',
        errorCode: 'retry_group_closed',
      });
      // Carol's rung runs, and the JOB refuses it at its own gate.
      await outbound.deliverDelayed(dispatchJob);
      await outbound.settle();
      const carolRung = retryRows().find((r) => r.relay_retry_member_key === CAROL_KEY)!;

      /** A rung's data minus what is per-member by construction - its key,
       *  provider identity, timestamps and destination digest - with the
       *  member slot read under the rung's own key. */
      const rungData = (row: MessageItem, key: string) => {
        const {
          tsMsgId: _tsMsgId,
          provider_sid: _providerSid,
          provider_ts: _providerTs,
          created_at: _createdAt,
          relay_retry_member_key: _memberKey,
          relay_retry_dest_digest: _destDigest,
          delivery_recipients: slots,
          ...rest
        } = row;
        return { ...rest, slot: slots?.[key] };
      };
      // Field by field - the row-level delivery_status included - the rung the
      // claim appended closed equals the rung the job closed.
      expect(rungData(bobRung, BOB_KEY)).toEqual(rungData(carolRung, CAROL_KEY));
      expect(bobRung.delivery_status).toBe('queued');
      expect(world.sent).toHaveLength(0);
    },
  );

  it.each<[string, number, boolean, RelayRetryGateCode | 'retry_window_closed']>([
    ['a gate decline', 1, true, 'retry_group_closed'],
    ['a window decline', 14, false, 'retry_window_closed'],
  ])(
    'retry-send-window D3: on %s the rung is APPENDED closed - one write, nothing closes it after - and the ROOT SSE fires once, after that write',
    async (_label, sentMinutesAgo, closeGroup, code) => {
      // The crash-recovery shape (the slot is already terminal on 30003):
      // nothing transitions, so the tail's own emit cannot fire and the ONLY
      // root emit is the claim's.
      const root = await seedSource({
        bobSlot: { status: 'undelivered', errorCode: '30003', sentAt: minutesAgo(sentMinutesAgo) },
      });
      if (closeGroup) world.conversations.get(CONV)!.status = 'closed';
      const rootEmits = (): number =>
        world.emitted.filter(
          (e) =>
            e.event === 'message.persisted' &&
            (e.payload as { tsMsgId?: string }).tsMsgId === root,
        ).length;
      // Record what the rung's append carried, and how many root emits had
      // already happened when it ran.
      let appendedSlot: RelayRecipientDelivery | undefined;
      let emitsAtAppend = -1;
      const realAppend = world.messagesRepo.append.bind(world.messagesRepo);
      world.messagesRepo.append = async (message) => {
        if (message.relayRetryOf !== undefined) {
          appendedSlot = message.deliveryRecipients?.[BOB_KEY];
          emitsAtAppend = rootEmits();
        }
        return realAppend(message);
      };
      const setSlot = vi.spyOn(world.messagesRepo, 'setRecipientDelivery');
      const setState = vi.spyOn(world.messagesRepo, 'setRecipientTransportAggregationState');
      const applyResult = vi.spyOn(world.messagesRepo, 'applyRecipientSendResult');

      await postRootFailure();

      // The append itself carried the final closed slot ...
      expect(appendedSlot).toEqual({ status: 'failed', errorCode: code });
      expect(slotOf(retryRows()[0]!.tsMsgId)).toEqual({ status: 'failed', errorCode: code });
      // ... and no second write touched the rung afterwards.
      expect(setSlot).not.toHaveBeenCalled();
      expect(setState).not.toHaveBeenCalled();
      expect(applyResult).not.toHaveBeenCalled();
      // The claim's root SSE fires once, AFTER that one write.
      expect(emitsAtAppend).toBe(0);
      expect(rootEmits()).toBe(1);
      expect(scheduledRetryJobs()).toHaveLength(0);
    },
  );

  it('retry-send-window D3: a duplicate callback for an OPEN rung answers already_claimed and changes nothing, whatever its own preview says', async () => {
    await seedSource({ bobSlot: { status: 'sent', sentAt: minutesAgo(1) } });
    await postRootFailure();
    const rung = retryRows()[0]!;
    expect(slotOf(rung.tsMsgId)).toEqual({ status: 'queued' });
    // Between the two deliveries the group closes, so THIS callback's own
    // preview declines. Its append dedupes: the rung an earlier callback
    // opened stays open and enqueued.
    world.conversations.get(CONV)!.status = 'closed';

    await postRootFailure();

    expect(retryRows()).toHaveLength(1);
    expect(slotOf(rung.tsMsgId)).toEqual({ status: 'queued' });
    expect(scheduledRetryJobs()).toHaveLength(1);
    expect(failureLines(WARN)).toContainEqual(
      expect.objectContaining({ retryClaim: 'already_claimed', retryAttempt: 1 }),
    );
    expect(failureLines(WARN).some((l) => l['retryClaim'] === 'gate_refused')).toBe(false);
  });

  it('retry-send-window D3: a duplicate callback for a CLOSED rung answers already_claimed and enqueues nothing, whatever its own preview says', async () => {
    await seedSource({ bobSlot: { status: 'sent', sentAt: minutesAgo(1) } });
    world.conversations.get(CONV)!.status = 'closed';
    await postRootFailure();
    const rung = retryRows()[0]!;
    expect(slotOf(rung.tsMsgId)).toEqual({ status: 'failed', errorCode: 'retry_group_closed' });
    // The group reopens: THIS callback's preview would pass. Its append
    // dedupes: the rung an earlier callback closed stays closed.
    world.conversations.get(CONV)!.status = 'open';

    await postRootFailure();

    expect(retryRows()).toHaveLength(1);
    expect(slotOf(rung.tsMsgId)).toEqual({ status: 'failed', errorCode: 'retry_group_closed' });
    expect(scheduledRetryJobs()).toHaveLength(0);
    expect(failureLines(WARN)).toContainEqual(
      expect.objectContaining({ retryClaim: 'already_claimed', retryAttempt: 1 }),
    );
  });

  it('retry-send-window D3 (planner review): a gate-preview read that THROWS fails OPEN - the rung is claimed open and enqueued, one WARN, no claim_failed', async () => {
    await seedSource({ bobSlot: { status: 'sent', sentAt: minutesAgo(1) } });
    // The suppression read (the evaluator's one read) fails ONCE. Twilio does
    // not redeliver a 5xx status callback by default (retry policy `ct`), so a
    // claim that failed here would lose the ladder for good.
    const realGetById = world.contactsRepo.getById.bind(world.contactsRepo);
    let failed = false;
    world.contactsRepo.getById = async (contactId) => {
      if (!failed && contactId === BOB_KEY) {
        failed = true;
        throw new Error('dynamodb throttled');
      }
      return realGetById(contactId);
    };

    const res = await signedTwilioPost(app, STATUS_PATH, failureParams());

    expect(res.status).toBe(200);
    expect(failed).toBe(true);
    const rows = retryRows();
    expect(rows).toHaveLength(1);
    expect(slotOf(rows[0]!.tsMsgId)?.status).toBe('queued');
    expect(scheduledRetryJobs()).toHaveLength(1);
    expect(failureLines(ERROR).some((l) => l['retryClaim'] === 'claim_failed')).toBe(false);
    expect(
      capture
        .atLevel(WARN)
        .some((l) => String(l['msg']).includes('gate preview read failed - the gates are skipped here')),
    ).toBe(true);
  });
});
