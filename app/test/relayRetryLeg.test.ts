// relay.retryLeg - one rung of the 30003 retry ladder, in isolation.
//
// Driven through the real jobs envelope machinery (enqueue ->
// InMemoryScheduler / InProcessOutboundQueue -> dispatchJob) exactly as
// relayFanOut.test.ts does, so the jobId execution marker (spec D4) is
// exercised for real rather than simulated.
//
// MOCKING BOUNDARY (plan Task 11): the ADAPTER is the send seam for the gate,
// bump, send and re-presign tests, so `sendOneRelayLeg` runs FOR REAL and writes
// the delivery slot and the `relaysid#` pointer. `relayFanOut.js` is partially
// mocked only so the two transient-outcome tests can force an outcome the fake
// adapter cannot produce on demand; by default the mock DELEGATES to the real
// unit and just records its arguments.
//
// Retry rows are seeded the way the claim (Task 12) will write them: the six
// lineage fields, a wall-clock `providerTs`, the deterministic
// `relayretry-<digest>-<n>` provider SID, and the MODE-APPROPRIATE single-entry
// slot - versioned rows carry `transportAggregationState: 'planned'`, which is
// the precondition `setVersionedAggregationState` throws without.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import type { SendMessageParams } from '../src/adapters/messaging.js';
import { createMediaStore } from '../src/adapters/mediaStore.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
  dispatchJob,
  enqueueImmediate,
} from '../src/jobs/jobs.js';
import type { RelayLegSendOutcome, sendOneRelayLeg } from '../src/jobs/relayFanOut.js';
import {
  RELAY_RETRY_LEG_JOB,
  _resetRelayRetryLegForTests,
  enqueueRelayRetryLeg,
  registerRelayRetryLegJobHandler,
  type RelayRetryLegJobDeps,
  type RelayRetryLegPayload,
} from '../src/jobs/relayRetryLeg.js';
import { registerAllJobHandlers } from '../src/jobs/registerHandlers.js';
import { createLogger } from '../src/lib/logger.js';
import { TRANSPORT_SCHEMA_VERSION } from '../src/lib/messageTransport.js';
import { TokenBucket } from '../src/lib/tokenBucket.js';
import { relayRetryDigest, relayRetryProviderSid } from '../src/lib/relayRetryClaim.js';
import { SendRefusedError } from '../src/services/sendMessage.js';
import { buildTsMsgId, type MessageItem } from '../src/repos/messagesRepo.js';
import type { ConversationItem, ConversationsRepo } from '../src/repos/conversationsRepo.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';

type LegArgs = Parameters<typeof sendOneRelayLeg>[0];

/**
 * Partial mock of the fan-out module. `calls` records every `sendOneRelayLeg`
 * argument bag (which is how the transport MODE the retry job decided is
 * observed), and `override` - when set - replaces the real unit for the two
 * transient tests. Hoisted because `vi.mock` is hoisted above the imports.
 */
const legSend = vi.hoisted(() => ({
  calls: [] as unknown[],
  override: undefined as undefined | (() => Promise<unknown>),
}));

vi.mock('../src/jobs/relayFanOut.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/jobs/relayFanOut.js')>();
  return {
    ...actual,
    async sendOneRelayLeg(args: LegArgs): Promise<RelayLegSendOutcome> {
      legSend.calls.push(args);
      if (legSend.override !== undefined) {
        return (await legSend.override()) as RelayLegSendOutcome;
      }
      return actual.sendOneRelayLeg(args);
    },
  };
});

const CONV = 'conv-relay-1';
const POOL = '+15550109000';
const ALICE = '+15550100001';
const BOB = '+15550100002';
const CAROL = '+15550100003';
const BOB_NEW = '+15558675399';

/** The root (failed) message the ladder is retrying. Never re-read by the job. */
const ROOT_TS_MSG_ID = '2026-09-02T10:00:00.000Z#SMrelay-in-1';
const RAW_BODY = 'is the unit still available?';
/** The COMPOSED leg copy, frozen at claim time (spec D12). */
const LEG_BODY = 'Alice: is the unit still available?';
const BOB_KEY = 'c-bob';

function legArgs(index: number): LegArgs {
  return legSend.calls[index] as LegArgs;
}

/** Named so the spy's declaration can borrow its precise return type. */
function spyOnTouchLastActivity(repo: ConversationsRepo) {
  return vi.spyOn(repo, 'touchLastActivity');
}

function seedRelay(world: FakeWorld, overrides: Partial<ConversationItem> = {}): ConversationItem {
  const now = new Date().toISOString();
  const conv: ConversationItem = {
    conversationId: CONV,
    participant_phone: POOL,
    pool_number: POOL,
    status: 'open',
    last_activity_at: now,
    type: 'relay_group',
    ai_mode: 'manual',
    participants: [
      { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
      { contactId: BOB_KEY, phone: BOB, name: 'Bob' },
      { contactId: 'c-carol', phone: CAROL, name: 'Carol' },
    ],
    created_at: now,
    ...overrides,
  };
  world.conversations.set(conv.conversationId, conv);
  return conv;
}

interface SeedRetryOptions {
  /** Ladder rung (1..3). Also the deterministic provider SID's suffix. */
  attempt?: number;
  /** The leg's member key - `phone#<E164>` for a contact-less member (spec D5). */
  memberKey?: string;
  /** false = a LEGACY retry row: no schema version, a bare `{status:'queued'}` slot. */
  versioned?: boolean;
  /** The destination the ladder was claimed against (spec D5's digest input). */
  destination?: string;
  media?: MessageItem['media_attachments'];
  /** Transient passes already consumed on THIS row (spec D10's own budget). */
  fanoutAttempt?: number;
  legBody?: string;
}

/**
 * Seed one retry row exactly as the claim path will write it. The slot shape is
 * mode-dependent on purpose: a versioned row's `planned` state is what the first
 * `setVersionedAggregationState('attempted', ...)` needs, and a legacy row must
 * carry no transport fields at all (spec D2).
 */
function seedRetryRow(world: FakeWorld, opts: SeedRetryOptions = {}): MessageItem {
  const attempt = opts.attempt ?? 1;
  const versioned = opts.versioned ?? true;
  const destination = opts.destination ?? BOB;
  const memberKey = opts.memberKey ?? BOB_KEY;
  const providerTs = new Date().toISOString();
  const providerSid = relayRetryProviderSid(relayRetryDigest(ROOT_TS_MSG_ID, destination), attempt);
  const row: MessageItem = {
    conversationId: CONV,
    tsMsgId: buildTsMsgId(providerTs, providerSid),
    type: opts.media !== undefined ? 'mms' : 'sms',
    // Mirrors the ORIGINAL's direction/author/sender key (spec D2). The original
    // here is a member-originated inbound relay source, so no message-level
    // `requested_transport` is written even on the versioned row.
    direction: 'inbound',
    author: 'unknown',
    body: RAW_BODY,
    provider_sid: providerSid,
    provider_ts: providerTs,
    delivery_status: 'queued',
    created_at: providerTs,
    relay_sender_key: 'c-alice',
    ...(opts.media !== undefined && { media_attachments: opts.media }),
    ...(versioned && { transport_schema_version: TRANSPORT_SCHEMA_VERSION }),
    ...(opts.fanoutAttempt !== undefined && { fanout_attempt: opts.fanoutAttempt }),
    delivery_recipients: {
      [memberKey]: versioned
        ? { status: 'queued', requestedTransport: 'sms', transportAggregationState: 'planned' }
        : { status: 'queued' },
    },
    relay_retry_of: ROOT_TS_MSG_ID,
    relay_retry_member_key: memberKey,
    relay_retry_attempt: attempt,
    relay_retry_dest_digest: relayRetryDigest(ROOT_TS_MSG_ID, destination),
    relay_retry_origin_direction: 'inbound',
    relay_retry_leg_body: opts.legBody ?? LEG_BODY,
  };
  world.messages.push(row);
  return row;
}

describe('relay.retryLeg (30003 ladder)', () => {
  let world: FakeWorld;
  let outbound: InProcessOutboundQueueAdapter;
  let capture: LogCapture;
  let logger: ReturnType<typeof createLogger>;
  /**
   * OUR OWN bump recorder. The harness fake deliberately does NOT push
   * `touchLastActivityPreservingStatus` into `world.touches` (that array is the
   * `touchLastActivity` ledger), so "the retry wrote status" and "the retry
   * preserved status" stay distinguishable - which means a test that wants to
   * see the preview argument has to record it itself.
   */
  let bumps: { conversationId: string; preview: string | undefined; at: string }[];
  let touchLastActivitySpy: ReturnType<typeof spyOnTouchLastActivity>;

  beforeEach(() => {
    _resetForTests();
    _resetRelayRetryLegForTests();
    legSend.calls.length = 0;
    legSend.override = undefined;
    capture = createLogCapture();
    logger = createLogger({ level: 'info', destination: capture.stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob, logger });
    configureOutboundQueue(outbound);

    bumps = [];
    const realBump = world.conversationsRepo.touchLastActivityPreservingStatus.bind(
      world.conversationsRepo,
    );
    world.conversationsRepo.touchLastActivityPreservingStatus = async (id, preview, at) => {
      bumps.push({ conversationId: id, preview, at });
      return realBump(id, preview, at);
    };
    touchLastActivitySpy = spyOnTouchLastActivity(world.conversationsRepo);
  });

  afterEach(() => {
    _resetForTests();
    _resetRelayRetryLegForTests();
    vi.restoreAllMocks();
  });

  function register(overrides: RelayRetryLegJobDeps = {}): void {
    registerRelayRetryLegJobHandler({
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      mediaStore: world.mediaStore,
      logger,
      ...overrides,
    });
  }

  function payloadFor(row: MessageItem): RelayRetryLegPayload {
    return { relayConversationId: CONV, retryTsMsgId: row.tsMsgId };
  }

  async function runHandler(payload: RelayRetryLegPayload) {
    const envelope = await enqueueImmediate(RELAY_RETRY_LEG_JOB, payload);
    await outbound.settle();
    return envelope;
  }

  function storedRow(tsMsgId: string): MessageItem {
    return world.messages.find((m) => m.tsMsgId === tsMsgId)!;
  }

  function slotOf(tsMsgId: string) {
    return storedRow(tsMsgId).delivery_recipients?.[BOB_KEY];
  }

  const errorLogs = (): Record<string, unknown>[] => capture.atLevel(50);
  const warnLogs = (): Record<string, unknown>[] => capture.atLevel(40);
  const infoLogs = (): Record<string, unknown>[] => capture.atLevel(30);

  // --- D4: the marker, not the claim, is what defeats a duplicate DELIVERY ---

  it('sends nothing on a redelivered job (the execution marker)', async () => {
    seedRelay(world);
    const row = seedRetryRow(world);
    register();

    const envelope = await runHandler(payloadFor(row));
    expect(world.sent).toHaveLength(1);

    // Re-dispatch the SAME envelope (SQS at-least-once): the jobId marker
    // suppresses it. Without this guard the member is simply texted again.
    await dispatchJob(JSON.parse(JSON.stringify(envelope)));
    expect(world.sent).toHaveLength(1);
    expect(legSend.calls).toHaveLength(1);
    expect(
      infoLogs().some((l) => String(l['msg']).includes('duplicate delivery suppressed')),
    ).toBe(true);
  });

  // --- D9: every attempt re-runs the gates; a refusal ends the chain ---

  const gateCases: [string, (world: FakeWorld) => void, string][] = [
    [
      'closed group',
      (w) => {
        w.conversations.get(CONV)!.status = 'closed';
      },
      'retry_group_closed',
    ],
    [
      'removed member',
      (w) => {
        const conv = w.conversations.get(CONV)!;
        conv.participants = (conv.participants ?? []).filter((m) => m.contactId !== BOB_KEY);
      },
      'retry_member_removed',
    ],
    [
      'changed number',
      (w) => {
        const conv = w.conversations.get(CONV)!;
        conv.participants = (conv.participants ?? []).map((m) =>
          m.contactId === BOB_KEY ? { ...m, phone: BOB_NEW } : m,
        );
      },
      'retry_number_changed',
    ],
    [
      'opted out',
      (w) => {
        w.contacts.push({ contactId: BOB_KEY, type: 'tenant', phone: BOB, sms_opt_out: true });
      },
      'retry_opted_out',
    ],
  ];

  it.each(gateCases)(
    'refuses on %s and closes the retry leg with the gate code',
    async (_name, arrange, code) => {
      seedRelay(world);
      const row = seedRetryRow(world);
      arrange(world);
      register();

      await runHandler(payloadFor(row));

      expect(world.sent).toHaveLength(0);
      expect(legSend.calls).toHaveLength(0);
      expect(slotOf(row.tsMsgId)).toMatchObject({ status: 'failed', errorCode: code });
      // The chain ENDS: nothing further is scheduled, on either ladder.
      expect(outbound.delayed).toHaveLength(0);
      const terminal = errorLogs().filter((l) => l['closeCode'] === code);
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({
        event: 'relay_retry_leg',
        relay: true,
        retryClaim: 'gate_refused',
        rootTsMsgId: ROOT_TS_MSG_ID,
        attempt: 1,
      });
    },
  );

  it('never stamps contact_opted_out on an opt-out refusal (the rollup drops that code)', async () => {
    seedRelay(world);
    const row = seedRetryRow(world);
    world.contacts.push({ contactId: BOB_KEY, type: 'tenant', phone: BOB, sms_opt_out: true });
    register();

    await runHandler(payloadFor(row));

    expect(slotOf(row.tsMsgId)?.errorCode).toBe('retry_opted_out');
    expect(slotOf(row.tsMsgId)?.errorCode).not.toBe('contact_opted_out');
  });

  it('compares the DIGEST, not the current phone, on the changed-number gate', async () => {
    seedRelay(world);
    const row = seedRetryRow(world);
    // The member KEY is unchanged (a contact-keyed member keeps `c-bob`), so
    // only the destination digest can catch this. A member whose phone changed
    // must never silently receive the old message at the new number.
    const conv = world.conversations.get(CONV)!;
    conv.participants = (conv.participants ?? []).map((m) =>
      m.contactId === BOB_KEY ? { ...m, phone: BOB_NEW } : m,
    );
    expect(relayRetryDigest(ROOT_TS_MSG_ID, BOB_NEW)).not.toBe(row.relay_retry_dest_digest);
    register();

    await runHandler(payloadFor(row));

    expect(world.sent).toHaveLength(0);
    expect(slotOf(row.tsMsgId)?.errorCode).toBe('retry_number_changed');
  });

  it('refuses a member whose current number cannot be normalised to E164', async () => {
    seedRelay(world);
    const row = seedRetryRow(world);
    const conv = world.conversations.get(CONV)!;
    conv.participants = (conv.participants ?? []).map((m) =>
      m.contactId === BOB_KEY ? { ...m, phone: 'not-a-number' } : m,
    );
    register();

    await runHandler(payloadFor(row));

    expect(world.sent).toHaveLength(0);
    expect(slotOf(row.tsMsgId)?.errorCode).toBe('retry_number_changed');
  });

  // --- D12: the send, and the leg copy frozen at claim time ---

  it('sends exactly one leg, the stored leg copy verbatim, after a sender rename', async () => {
    seedRelay(world);
    const row = seedRetryRow(world);
    // The sender's display name changed between the original send and this
    // rung. The leg copy is READ OFF THE ROW, never recomposed, so the wording
    // cannot drift mid-ladder.
    const conv = world.conversations.get(CONV)!;
    conv.participants = (conv.participants ?? []).map((m) =>
      m.contactId === 'c-alice' ? { ...m, name: 'Samantha' } : m,
    );
    register();

    await runHandler(payloadFor(row));

    expect(world.sent).toHaveLength(1);
    const sent = world.sent[0] as SendMessageParams;
    expect(sent.to).toBe(BOB);
    expect(sent.from).toBe(POOL);
    expect(sent.body).toBe(LEG_BODY);
    expect(sent.body).not.toContain('Samantha');
    // The RAW body stays on the row (spec D12) - only the leg carries the prefix.
    expect(storedRow(row.tsMsgId).body).toBe(RAW_BODY);
    // The extracted unit wrote the slot AND the pointer. Neither is written twice.
    expect(slotOf(row.tsMsgId)).toMatchObject({ status: 'queued' });
    expect(slotOf(row.tsMsgId)?.sid).toMatch(/^SMfake-out-/);
    expect(world.relaySidPointers.size).toBe(1);
    expect([...world.relaySidPointers.values()][0]).toMatchObject({
      conversationId: CONV,
      tsMsgId: row.tsMsgId,
      memberKey: BOB_KEY,
    });
  });

  it('sends to the failed member ONLY - never to the rest of the roster', async () => {
    seedRelay(world);
    const row = seedRetryRow(world);
    register();

    await runHandler(payloadFor(row));

    expect(world.sent.map((s) => s.to)).toEqual([BOB]);
  });

  // --- D16: the bump orders the inbox WITHOUT writing status ---

  it('bumps a group closed mid-backoff without reopening it, and rewrites no preview', async () => {
    seedRelay(world);
    const row = seedRetryRow(world);
    const stored = world.conversations.get(CONV)!;
    stored.last_message_preview = 'a newer message';
    // An explicitly OLD stamp: the handler runs in well under a millisecond, so
    // "now" and the seeded value would otherwise be the same ISO string and the
    // bump-happened assertion would pass or fail on clock resolution.
    const before = '2026-09-02T09:00:00.000Z';
    stored.last_activity_at = before;
    // The group CLOSED during the 60-240s backoff. The gate is stubbed open so
    // the send still runs - the hazard under test is the BUMP, not the gate.
    stored.status = 'closed';
    const realGet = world.conversationsRepo.getById.bind(world.conversationsRepo);
    world.conversationsRepo.getById = async (id: string) => {
      const conv = await realGet(id);
      return conv === undefined ? undefined : { ...conv, status: 'open' };
    };
    register();

    await runHandler(payloadFor(row));

    expect(world.sent).toHaveLength(1);
    // The actual hazard: `touchLastActivity` sets status='open' on any
    // non-group-text conversation, which would resurrect the closed group.
    expect(touchLastActivitySpy).not.toHaveBeenCalled();
    expect(world.touches).toHaveLength(0);
    expect(world.conversations.get(CONV)!.status).toBe('closed');
    // The bump DID run - ordering is the whole point of it.
    expect(bumps).toHaveLength(1);
    expect(world.conversations.get(CONV)!.last_activity_at).not.toBe(before);
    // Adjudication S3: the preview belongs to the thread's NEWEST message, which
    // a retry sent 60-240s later is not.
    expect(bumps[0]!.preview).toBeUndefined();
    expect(world.conversations.get(CONV)!.last_message_preview).toBe('a newer message');
  });

  it('does not bump when the leg did not send', async () => {
    seedRelay(world);
    const row = seedRetryRow(world);
    world.conversations.get(CONV)!.status = 'closed';
    register();

    await runHandler(payloadFor(row));

    expect(bumps).toHaveLength(0);
  });

  // --- D13: a presigned URL is never replayed ---

  it('re-presigns attachments on every attempt', async () => {
    seedRelay(world);
    const media = [{ s3Key: 'relay/photo.jpg', contentType: 'image/jpeg' }];
    const presignSpy = vi.spyOn(world.mediaStore, 'presign');
    const rung1 = seedRetryRow(world, { attempt: 1, media });
    register();
    await runHandler(payloadFor(rung1));

    const rung2 = seedRetryRow(world, { attempt: 2, media });
    await runHandler(payloadFor(rung2));

    expect(presignSpy).toHaveBeenCalledTimes(2);
    expect(world.sent).toHaveLength(2);
    const first = world.sent[0]!.mediaUrls?.[0];
    const second = world.sent[1]!.mediaUrls?.[0];
    expect(first).toContain('X-Amz-Signature');
    expect(second).toContain('X-Amz-Signature');
    // A fresh grant every attempt, still pointing at the same durable key.
    expect(second).not.toBe(first);
    expect(second).toContain('relay/photo.jpg');
  });

  // --- D2: the transport MODE mirrors the retry ROW, and legacy is ordinary ---

  it('drives a LEGACY retry row down the legacy path', async () => {
    seedRelay(world);
    const row = seedRetryRow(world, { versioned: false });
    const classify = vi.spyOn(world.adapter, 'classifyMessageTransport');
    const prepare = vi.spyOn(world.adapter, 'prepareMessageSend');
    const aggregate = vi.spyOn(world.messagesRepo, 'setRecipientTransportAggregationState');
    const apply = vi.spyOn(world.messagesRepo, 'applyRecipientSendResult');
    register();

    await runHandler(payloadFor(row));

    expect(legArgs(0).transport).toEqual({ kind: 'legacy' });
    // Mechanically free of every transport hook, exactly as the fan-out is.
    expect(classify).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(aggregate).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(slotOf(row.tsMsgId)?.sid).toMatch(/^SMfake-out-/);
    expect(slotOf(row.tsMsgId)?.transportAggregationState).toBeUndefined();
  });

  it('drives a VERSIONED retry row down the versioned path, off its seeded planned slot', async () => {
    seedRelay(world);
    const row = seedRetryRow(world, { versioned: true });
    const prepare = vi.spyOn(world.adapter, 'prepareMessageSend');
    const apply = vi.spyOn(world.messagesRepo, 'applyRecipientSendResult');
    register();

    await runHandler(payloadFor(row));

    expect(legArgs(0).transport).toMatchObject({
      kind: 'versioned',
      intent: { requestedTransport: 'sms' },
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
    // `planned -> attempted` is the transition the seeded slot exists for; a
    // slot without it throws inside setVersionedAggregationState.
    expect(slotOf(row.tsMsgId)?.transportAggregationState).toBe('attempted');
    expect(slotOf(row.tsMsgId)?.actualTransport).toBe('sms');
  });

  it('classifies an MMS retry row as mms from its own attachments', async () => {
    seedRelay(world);
    const row = seedRetryRow(world, {
      media: [{ s3Key: 'relay/photo.jpg', contentType: 'image/jpeg' }],
    });
    register();

    await runHandler(payloadFor(row));

    expect(legArgs(0).transport).toMatchObject({
      kind: 'versioned',
      intent: { requestedTransport: 'mms' },
    });
  });

  // Code review R1, F4: the fan-out logs this ERROR (relayFanOut.ts:1015-1024)
  // precisely because the degradation is otherwise invisible - `hasForwardableMedia`
  // folds "no store" into the transport intent and an MMS retry silently
  // re-sends text only.
  it('ERRORs when the retry row carries media and no MediaStore is configured', async () => {
    // The seam under test is the LAZY build: with no explicit store the handler
    // calls createMediaStore(), which returns undefined with MEDIA_BUCKET unset.
    // Asserted so this fails loudly rather than silently if that ever changes.
    expect(createMediaStore()).toBeUndefined();
    seedRelay(world);
    const row = seedRetryRow(world, {
      media: [{ s3Key: 'relay/photo.jpg', contentType: 'image/jpeg' }],
    });
    register({ mediaStore: undefined });

    await runHandler(payloadFor(row));

    const line = errorLogs().find((l) => l['mediaCount'] === 1);
    expect(line).toMatchObject({ event: 'relay_retry_leg', relay: true, mediaCount: 1 });
    expect(String(line!['msg'])).toContain('media dropped');
    // The ERROR records the degradation; it does not stop the rung.
    expect(world.sent).toHaveLength(1);
    // No PII on the new line, as on every other one.
    expect(JSON.stringify(capture.lines)).not.toContain(BOB);
  });

  it('logs no media-without-store ERROR when the row carries no media', async () => {
    seedRelay(world);
    const row = seedRetryRow(world);
    register({ mediaStore: undefined });

    await runHandler(payloadFor(row));

    expect(errorLogs()).toHaveLength(0);
  });

  it('addresses the RETRY row, never the root, and passes the transient pass number', async () => {
    seedRelay(world);
    const row = seedRetryRow(world);
    register();

    await runHandler(payloadFor(row));

    expect(legArgs(0).payload).toEqual({
      relayConversationId: CONV,
      sourceTsMsgId: row.tsMsgId,
      attempt: 1,
    });
    expect(legArgs(0).legBody).toBe(LEG_BODY);
    expect(legArgs(0).poolNumber).toBe(POOL);
    expect(legArgs(0).currentSource.tsMsgId).toBe(row.tsMsgId);
  });

  // --- D10: the transient sub-ladder, on the retry row's OWN budget ---

  it('re-enqueues the SAME rung on a transient send error, consuming no retry rung', async () => {
    seedRelay(world);
    const row = seedRetryRow(world);
    legSend.override = async (): Promise<RelayLegSendOutcome> => ({
      kind: 'transient',
      errorCode: '429',
    });
    register();

    await runHandler(payloadFor(row));

    expect(outbound.delayed).toHaveLength(1);
    const deferred = outbound.delayed[0]!;
    expect(deferred.envelope.jobName).toBe(RELAY_RETRY_LEG_JOB);
    expect(deferred.envelope.payload).toEqual({
      relayConversationId: CONV,
      retryTsMsgId: row.tsMsgId,
    });
    // The fan-out's transient shape, NOT the retry ladder's: 5s then 10s.
    expect(deferred.delaySeconds).toBe(5);
    // The rung is already claimed - this is that rung trying again.
    expect(storedRow(row.tsMsgId).relay_retry_attempt).toBe(1);
    expect(storedRow(row.tsMsgId).fanout_attempt).toBe(1);
    // No slot close: the leg is still in flight.
    expect(slotOf(row.tsMsgId)?.status).toBe('queued');
    expect(errorLogs()).toHaveLength(0);
    expect(
      warnLogs().some((l) => l['transientPass'] === 1 && l['event'] === 'relay_retry_leg'),
    ).toBe(true);
  });

  it('uses the injected transient backoff for the sub-ladder', async () => {
    seedRelay(world);
    const row = seedRetryRow(world);
    legSend.override = async (): Promise<RelayLegSendOutcome> => ({
      kind: 'transient',
      errorCode: '30022',
    });
    register({ transientBackoffMs: () => 7000 });

    await runHandler(payloadFor(row));

    expect(outbound.delayed[0]!.delaySeconds).toBe(7);
  });

  it('keeps the transient sub-ladder on its own default when the RETRY backoff is shortened', async () => {
    seedRelay(world);
    const row = seedRetryRow(world);
    legSend.override = async (): Promise<RelayLegSendOutcome> => ({
      kind: 'transient',
      errorCode: '429',
    });
    // The lane's E2E_RELAY_RETRY_BACKOFF_MS lands here, on `backoffMs`. The two
    // ladders are separate knobs on purpose (spec D10): shortening the retry
    // rung must not touch the transient sub-ladder's 5s/10s.
    register({ backoffMs: () => 3000 });

    await runHandler(payloadFor(row));

    expect(outbound.delayed[0]!.delaySeconds).toBe(5);
  });

  it('closes with transient_cap when the retry row pass budget is already spent', async () => {
    seedRelay(world);
    const row = seedRetryRow(world, { fanoutAttempt: 3 });
    legSend.override = async (): Promise<RelayLegSendOutcome> => ({
      kind: 'transient',
      errorCode: '429',
    });
    register();

    await runHandler(payloadFor(row));

    expect(slotOf(row.tsMsgId)).toMatchObject({ status: 'failed', errorCode: 'transient_cap' });
    expect(outbound.delayed).toHaveLength(0);
    expect(errorLogs()).toContainEqual(
      expect.objectContaining({
        event: 'relay_retry_leg',
        retryClaim: 'cap_exhausted',
        closeCode: 'transient_cap',
      }),
    );
  });

  it('closes with transient_cap on the LAST claimable pass rather than enqueueing an unreachable rung', async () => {
    seedRelay(world);
    // Two passes consumed: the claim succeeds with attempt 3, which is the cap -
    // the fan-out's own second branch, and why fanOutBackoffMs is documented as
    // 5s then 10s ONLY.
    const row = seedRetryRow(world, { fanoutAttempt: 2 });
    legSend.override = async (): Promise<RelayLegSendOutcome> => ({
      kind: 'transient',
      errorCode: '429',
    });
    register();

    await runHandler(payloadFor(row));

    expect(storedRow(row.tsMsgId).fanout_attempt).toBe(3);
    expect(outbound.delayed).toHaveLength(0);
    expect(slotOf(row.tsMsgId)?.errorCode).toBe('transient_cap');
  });

  // --- Adjudication S2: the extraction's terminal code SURVIVES ---

  it('leaves a refused leg with the code the extraction wrote, and only logs', async () => {
    seedRelay(world);
    const row = seedRetryRow(world);
    world.adapter.sendPreparedMessage = async () => {
      throw new SendRefusedError('breaker open', 'breaker_open');
    };
    register();

    await runHandler(payloadFor(row));

    // The unit already wrote the SPECIFIC code; the job writes nothing else.
    expect(slotOf(row.tsMsgId)).toMatchObject({ status: 'failed', errorCode: 'breaker_open' });
    expect(outbound.delayed).toHaveLength(0);
    expect(errorLogs()).toContainEqual(
      expect.objectContaining({
        event: 'relay_retry_leg',
        retryClaim: 'gate_refused',
        legOutcome: 'refused',
        errorCode: 'breaker_open',
      }),
    );
    // No close code: the job wrote no slot on this path.
    expect(errorLogs().some((l) => l['closeCode'] !== undefined)).toBe(false);
  });

  // Code review R1 F7, REPLACED by R2 W4. The gate and `sendOneRelayLeg` used to
  // ask `isMemberSuppressed` independently; if the answer flipped between them
  // the extraction stamped `contact_opted_out` on the retry row, which
  // `presentRelayDelivery` filters out of its denominator - on a one-member
  // relay group the rollup returns null and the leg vanishes from the surface.
  //
  // Fix wave 1 re-stamped the slot afterwards, which was INERT on the shape
  // every relay source now takes: on a VERSIONED row `applyRecipientSendResult`
  // preserves the FIRST terminal code, so the write was refused. The fix is to
  // stop asking twice - and this case uses the REAL `sendOneRelayLeg` (NO
  // `legSend.override`, which replaces the writer and is why the old test could
  // pass on a versioned row without exercising the bug) on the DEFAULT versioned
  // seed, so it reproduces R2's finding exactly.
  it('sends the leg when the suppression answer flips after the gate, on a VERSIONED row', async () => {
    seedRelay(world);
    const row = seedRetryRow(world);
    expect(row.transport_schema_version).toBe(TRANSPORT_SCHEMA_VERSION);
    world.contacts.push({ contactId: BOB_KEY, type: 'tenant', phone: BOB, sms_opt_out: false });
    // THE FLIP: read 1 (the D9 gate) answers "not suppressed"; any read after it
    // would answer "suppressed".
    let reads = 0;
    const realGetById = world.contactsRepo.getById.bind(world.contactsRepo);
    world.contactsRepo.getById = async (contactId) => {
      const contact = await realGetById(contactId);
      if (contactId !== BOB_KEY || contact === undefined) return contact;
      reads += 1;
      return { ...contact, sms_opt_out: reads > 1 };
    };
    register();

    await runHandler(payloadFor(row));

    // The unit did NOT ask a second time - which is the whole fix, and the one
    // assertion that fails the moment the duplicate read comes back.
    expect(reads).toBe(1);
    expect(world.sent).toHaveLength(1);
    // So the leg SENT, and its slot never carries the code that would delete the
    // rollup this feature exists to keep truthful.
    expect(slotOf(row.tsMsgId)?.errorCode).toBeUndefined();
    expect(slotOf(row.tsMsgId)?.status).not.toBe('failed');
    expect(errorLogs()).toHaveLength(0);
  });

  it('leaves a carrier-filtered leg at 30007 and reports code_not_retryable', async () => {
    seedRelay(world);
    const row = seedRetryRow(world);
    world.adapter.sendPreparedMessage = async () => {
      throw Object.assign(new Error('carrier filtered'), { code: 30007 });
    };
    register();

    await runHandler(payloadFor(row));

    expect(slotOf(row.tsMsgId)).toMatchObject({ status: 'failed', errorCode: '30007' });
    expect(errorLogs()).toContainEqual(
      expect.objectContaining({
        event: 'relay_retry_leg',
        retryClaim: 'code_not_retryable',
        legOutcome: 'filtered',
      }),
    );
  });

  it('does nothing further when the slot is already terminal', async () => {
    seedRelay(world);
    const row = seedRetryRow(world);
    row.delivery_recipients = { [BOB_KEY]: { status: 'delivered' } };
    register();

    await runHandler(payloadFor(row));

    expect(world.sent).toHaveLength(0);
    expect(bumps).toHaveLength(0);
    expect(errorLogs()).toHaveLength(0);
    expect(slotOf(row.tsMsgId)?.status).toBe('delivered');
  });

  // --- Malformed input is a programming error, not a gate refusal ---

  it('throws on a retry row that is missing its lineage', async () => {
    seedRelay(world);
    const row = seedRetryRow(world);
    delete storedRow(row.tsMsgId).relay_retry_dest_digest;
    register();

    await expect(dispatchJob({
      jobId: 'job-malformed-1',
      jobName: RELAY_RETRY_LEG_JOB,
      payload: payloadFor(row),
      enqueuedAt: new Date().toISOString(),
    } as never)).rejects.toThrow(/relay_retry_dest_digest/);
    expect(world.sent).toHaveLength(0);
  });

  // --- PII: the queue carries identifiers only ---

  it('puts no body and no phone number on the queue or in the logs', async () => {
    seedRelay(world);
    const row = seedRetryRow(world);
    register();

    const envelope = await runHandler(payloadFor(row));

    expect(Object.keys(envelope.payload as object).sort()).toEqual([
      'relayConversationId',
      'retryTsMsgId',
    ]);
    const wire = JSON.stringify(envelope.payload);
    expect(wire).not.toContain(RAW_BODY);
    expect(wire).not.toContain(LEG_BODY);
    expect(wire).not.toContain(BOB);
    const logs = JSON.stringify(capture.lines);
    expect(logs).not.toContain(BOB);
    expect(logs).not.toContain(RAW_BODY);
  });

  it('redacts a contact-less member key in the log line', async () => {
    const now = new Date().toISOString();
    world.conversations.set(CONV, {
      conversationId: CONV,
      participant_phone: POOL,
      pool_number: POOL,
      status: 'closed',
      last_activity_at: now,
      type: 'relay_group',
      ai_mode: 'manual',
      participants: [{ contactId: '', phone: BOB }],
      created_at: now,
    } as ConversationItem);
    // A contact-less member's stored key IS `phone#<E164>` (spec D5's residual).
    const row = seedRetryRow(world, { memberKey: `phone#${BOB}` });
    register();

    await runHandler(payloadFor(row));

    const terminal = errorLogs().filter((l) => l['closeCode'] === 'retry_group_closed');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!['memberKey']).toBe('phone-only-member');
    expect(JSON.stringify(capture.lines)).not.toContain(BOB);
  });
});

// --- Task 14 Step 1: the lane backoff seam, read at handler registration ---

describe('relay.retryLeg backoff seam (E2E_RELAY_RETRY_BACKOFF_MS)', () => {
  const ENV_KEY = 'E2E_RELAY_RETRY_BACKOFF_MS';
  /** The TOPOLOGY discriminator (code review R2, W3): set in every deployed
   *  environment, unset in the hermetic lane and local dev. */
  const QUEUE_KEY = 'JOBS_QUEUE_URL';
  let outbound: InProcessOutboundQueueAdapter;
  let saved: string | undefined;
  let savedQueueUrl: string | undefined;

  beforeEach(() => {
    _resetForTests();
    _resetRelayRetryLegForTests();
    saved = process.env[ENV_KEY];
    savedQueueUrl = process.env[QUEUE_KEY];
    delete process.env[ENV_KEY];
    delete process.env[QUEUE_KEY];
    const logger = createLogger({ destination: createLogCapture().stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    outbound = new InProcessOutboundQueueAdapter({ dispatch: async () => {}, logger });
    configureOutboundQueue(outbound);
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
    if (savedQueueUrl === undefined) delete process.env[QUEUE_KEY];
    else process.env[QUEUE_KEY] = savedQueueUrl;
    _resetForTests();
    _resetRelayRetryLegForTests();
  });

  const payload: RelayRetryLegPayload = {
    relayConversationId: CONV,
    retryTsMsgId: '2026-09-02T10:01:00.000Z#relayretry-abc-1',
  };

  function registerThroughTheSeam(): void {
    // The REAL registration path, so the env read under test is the shipped one.
    registerAllJobHandlers({ tokenBucket: new TokenBucket({ capacity: 1, refillPerSec: 1 }) });
  }

  async function delaysForRungs(): Promise<number[]> {
    const out: number[] = [];
    for (const attempt of [1, 2, 3]) {
      outbound.delayed.length = 0;
      await enqueueRelayRetryLeg(payload, attempt);
      out.push(outbound.delayed[0]!.delaySeconds);
    }
    return out;
  }

  it('leaves 60/120/240 with the override ABSENT', async () => {
    registerThroughTheSeam();
    expect(await delaysForRungs()).toEqual([60, 120, 240]);
  });

  it.each(['abc', '0', '-5', '', '  '])(
    'leaves 60/120/240 on the malformed value %j',
    async (value) => {
      process.env[ENV_KEY] = value;
      registerThroughTheSeam();
      expect(await delaysForRungs()).toEqual([60, 120, 240]);
    },
  );

  it('shortens EVERY rung on a valid positive value', async () => {
    process.env[ENV_KEY] = '3000';
    registerThroughTheSeam();
    // Every rung, not just the ones the handler enqueues: rung 1 comes from the
    // status WEBHOOK, which holds no deps object, so the resolved value has to
    // live at module scope for the lane override to reach it at all.
    expect(await delaysForRungs()).toEqual([3, 3, 3]);
  });

  it('falls back to 60/120/240 with no registration at all', async () => {
    expect(await delaysForRungs()).toEqual([60, 120, 240]);
  });

  // Code review R1, F5 - PRODUCTION'S topology, which no case covered. The app
  // process registers NO handlers when JOBS_QUEUE_URL is set (`index.ts`), yet
  // it is where the status webhook enqueues every rung, so the module-scope
  // store is empty at the only call site. Before F5 the env was read solely at
  // registration, so a backoff supplied that way was silently ignored exactly
  // where the ladder is scheduled.
  it('reads the override on the FREE enqueue when nothing registered', async () => {
    process.env[ENV_KEY] = '9000';
    expect(await delaysForRungs()).toEqual([9, 9, 9]);
  });

  it.each(['abc', '0', '-5', '', '  '])(
    'ignores the malformed value %j on the free enqueue too',
    async (value) => {
      process.env[ENV_KEY] = value;
      expect(await delaysForRungs()).toEqual([60, 120, 240]);
    },
  );

  it('lets an explicit deps.backoffMs win over the registered one', async () => {
    process.env[ENV_KEY] = '3000';
    registerThroughTheSeam();
    outbound.delayed.length = 0;
    await enqueueRelayRetryLeg(payload, 1, { backoffMs: () => 11_000 });
    expect(outbound.delayed[0]!.delaySeconds).toBe(11);
  });

  // Code review R2, W3. F5 was right to resolve the override one way for both
  // topologies, and in doing so it deleted the property that made the variable
  // safe: with the parse only at registration, the app process (which registers
  // nothing) could never read it. Afterwards it read it on EVERY rung, so
  // `E2E_RELAY_RETRY_BACKOFF_MS=1` in a deployed environment would have fired
  // all three rungs within milliseconds - texting a member three times.
  // `JOBS_QUEUE_URL` restores the guard structurally: setting it IS what makes
  // the app a producer-only process, and it is unset in the one topology where
  // a lane exists.
  it('IGNORES the override in production topology - the free enqueue', async () => {
    process.env[ENV_KEY] = '9000';
    process.env[QUEUE_KEY] = 'https://sqs.us-east-1.amazonaws.com/000000000000/hc-prod-jobs';
    expect(await delaysForRungs()).toEqual([60, 120, 240]);
  });

  it('IGNORES the override in production topology - through the handler too', async () => {
    process.env[ENV_KEY] = '9000';
    process.env[QUEUE_KEY] = 'https://sqs.us-east-1.amazonaws.com/000000000000/hc-prod-jobs';
    registerThroughTheSeam();
    expect(await delaysForRungs()).toEqual([60, 120, 240]);
  });

  // The MIRROR, so the two cases above are proven to be a GUARD rather than a
  // value that never arrives: the same env, the queue URL unset, and the lane
  // gets its shortened rung. (The handler-path mirror is the "shortens EVERY
  // rung on a valid positive value" case above, which registers with the queue
  // URL deleted by this describe's beforeEach.)
  it('honors the SAME override with JOBS_QUEUE_URL unset', async () => {
    process.env[ENV_KEY] = '9000';
    expect(await delaysForRungs()).toEqual([9, 9, 9]);
  });

  // An EMPTY queue URL is not a deployed topology: `.env` files and shells
  // routinely carry an unset value as the empty string, and treating that as
  // "production" would silently take the lane's override away.
  it('treats an EMPTY JOBS_QUEUE_URL as unset', async () => {
    process.env[ENV_KEY] = '9000';
    process.env[QUEUE_KEY] = '';
    expect(await delaysForRungs()).toEqual([9, 9, 9]);
  });
});
