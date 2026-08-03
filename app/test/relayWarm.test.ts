// relay.warmNumber (relay number buying strategy T4) suite - the warm-a-spare
// service methods (warmOneNumber / refillBufferIfNeeded / flagStuckWarming) plus
// the job handler that dispatches back to warmOneNumber. Uses focused in-memory
// fakes (store-backed repo, order-tracing adapter, a recording OutboundQueue) and
// the REAL jobs envelope machinery for the handler-dispatch test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
  type OutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
  dispatchJob,
  enqueueImmediate,
} from '../src/jobs/jobs.js';
import type { JobEnvelope } from '../src/jobs/types.js';
import {
  createPoolNumbersService,
  RelayProvisioningDisabledError,
  RELAY_WARM_JOB,
  type PoolNumbersService,
} from '../src/services/poolNumbers.js';
import { parseRelayWarmPayload, registerRelayWarmJobHandler } from '../src/jobs/relayWarm.js';
import type { AppConfig } from '../src/lib/config.js';
import type { MessagingAdapter, ProvisionPhoneNumberResult } from '../src/adapters/messaging.js';
import type {
  CreateWarmingInput,
  PoolNumberItem,
  PoolNumbersRepo,
} from '../src/repos/poolNumbersRepo.js';
import type { ConversationItem, ConversationsRepo } from '../src/repos/conversationsRepo.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';

const SENTINEL = '0000-00-00T00:00:00.000Z';

/** Minimal AppConfig for the warm-path tests (only the fields these methods read). */
function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    messagingDriver: 'console',
    relayLiveProvisioning: true,
    relaySpareBufferTarget: 0,
    relayWarmingMaxWaitMs: 30 * 60_000,
    // Buy-side geographic hints (area-code preference). EMPTY here so every
    // pre-existing test keeps today's behavior: one unhinted search per buy.
    relayPreferredAreaCodes: [],
    ...over,
  } as AppConfig;
}

/** Adapter fake: pushes 'provision'/'attach' onto a shared trace + records SIDs. */
function makeAdapter(opts: {
  trace: string[];
  voice?: boolean;
}): MessagingAdapter & { trace: string[]; attachedSids: string[] } {
  const attachedSids: string[] = [];
  let provisions = 0;
  return {
    trace: opts.trace,
    attachedSids,
    async provisionPhoneNumber(): Promise<ProvisionPhoneNumberResult> {
      provisions += 1;
      opts.trace.push('provision');
      const seq = String(provisions).padStart(4, '0');
      return {
        phoneNumber: `+1555030${seq}`,
        capabilities: { sms: true, voice: opts.voice ?? true },
        sid: `PNwarm-${seq}`,
      };
    },
    async attachToMessagingService(sid: string) {
      opts.trace.push('attach');
      attachedSids.push(sid);
    },
    async detachFromMessagingService() {},
    async setVoiceWebhook() {},
    async sendMessage() {
      throw new Error('not used');
    },
    async getMediaStream() {
      throw new Error('not used');
    },
    async getRecordingStream() {
      throw new Error('not used');
    },
    async releasePhoneNumber() {},
    async initiateCall() {
      return { callSid: 'CAwarm' };
    },
    async createViTranscript() {
      throw new Error('not used');
    },
    async fetchViTranscript() {
      throw new Error('not used');
    },
    async listViSentences() {
      throw new Error('not used');
    },
  };
}

interface FakePoolRepo {
  store: Map<string, PoolNumberItem>;
  createWarmingCalls: CreateWarmingInput[];
  seedActiveSpare(pn: string): void;
  seedWarming(pn: string, opts: { sid: string; startedAt: string }): void;
}

/**
 * Store-backed repo fake implementing only the warm-path primitives (cast). A
 * shared `trace` (also passed to makeAdapter) records createWarming so the order
 * test can assert provision -> createWarming -> attach across both fakes.
 */
function makeRepo(trace: string[] = []): PoolNumbersRepo & FakePoolRepo {
  const store = new Map<string, PoolNumberItem>();
  const createWarmingCalls: CreateWarmingInput[] = [];
  const repo = {
    store,
    createWarmingCalls,
    seedActiveSpare(pn: string) {
      store.set(pn, {
        poolNumber: pn,
        lifecycle_state: 'active',
        quarantine_until: SENTINEL,
        voice_capable: true,
        sms_capable: true,
        provisioned_at: new Date().toISOString(),
      });
    },
    seedWarming(pn: string, opts: { sid: string; startedAt: string }) {
      store.set(pn, {
        poolNumber: pn,
        lifecycle_state: 'warming',
        quarantine_until: SENTINEL,
        voice_capable: true,
        sms_capable: true,
        sid: opts.sid,
        warming_started_at: opts.startedAt,
        provisioned_at: new Date().toISOString(),
      });
    },
    async createWarming(input: CreateWarmingInput): Promise<PoolNumberItem> {
      trace.push('createWarming');
      createWarmingCalls.push(input);
      const item: PoolNumberItem = {
        poolNumber: input.poolNumber,
        lifecycle_state: 'warming',
        quarantine_until: SENTINEL,
        voice_capable: input.voiceCapable,
        sms_capable: input.smsCapable,
        sid: input.sid,
        warming_started_at: new Date().toISOString(),
        ...(input.provisionedVia !== undefined && { provisioned_via: input.provisionedVia }),
        ...(input.conversationId !== undefined && { pending_conversation_id: input.conversationId }),
        provisioned_at: new Date().toISOString(),
      };
      store.set(item.poolNumber, item);
      return item;
    },
    async listWarming(): Promise<PoolNumberItem[]> {
      return [...store.values()].filter((i) => i.lifecycle_state === 'warming');
    },
    async countFreshSpares(): Promise<number> {
      return [...store.values()].filter((i) => {
        if (i.lifecycle_state !== 'active') return false;
        const b = i.burned_phones;
        const c = b instanceof Set ? b.size : Array.isArray(b) ? b.length : 0;
        return c === 0 && i.pending_conversation_id === undefined;
      }).length;
    },
    async countWarming(): Promise<number> {
      return [...store.values()].filter((i) => i.lifecycle_state === 'warming').length;
    },
    async findByPendingConversationId(conversationId: string): Promise<PoolNumberItem[]> {
      return [...store.values()].filter(
        (i) =>
          (i.lifecycle_state === 'warming' || i.lifecycle_state === 'active') &&
          i.pending_conversation_id === conversationId,
      );
    },
    async clearPendingConversation(poolNumber: string): Promise<void> {
      const item = store.get(poolNumber);
      if (item) delete item.pending_conversation_id;
    },
  };
  return repo as unknown as PoolNumbersRepo & FakePoolRepo;
}

/** Records enqueued envelopes without dispatching (refill enqueue-count assertions). */
function makeRecordingQueue(): OutboundQueueAdapter & { envelopes: JobEnvelope[] } {
  const envelopes: JobEnvelope[] = [];
  return {
    envelopes,
    async enqueue(envelope: JobEnvelope) {
      envelopes.push(envelope);
    },
  };
}

function stubConversations(): ConversationsRepo {
  return {
    async getAllByPoolNumber() {
      return [];
    },
  } as unknown as ConversationsRepo;
}

describe('poolNumbersService warm-a-spare (T4)', () => {
  let capture: LogCapture;
  let logger: ReturnType<typeof createLogger>;
  let queueAdapter: InProcessOutboundQueueAdapter;

  beforeEach(() => {
    _resetForTests();
    capture = createLogCapture();
    logger = createLogger({ level: 'info', destination: capture.stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    queueAdapter = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(queueAdapter);
  });

  afterEach(async () => {
    await queueAdapter.settle();
    _resetForTests();
  });

  describe('warmOneNumber', () => {
    it('buys, creates a WARMING record (sid + conversationId earmark), then attaches - IN THAT ORDER', async () => {
      const trace: string[] = [];
      const adapter = makeAdapter({ trace });
      const repo = makeRepo(trace);
      const svc = createPoolNumbersService({
        adapter,
        poolNumbersRepo: repo,
        conversationsRepo: stubConversations(),
        logger,
        config: makeConfig({ relayLiveProvisioning: true }),
      });

      await svc.warmOneNumber('conv-42');

      // provision -> createWarming -> attach (the setVoiceWebhook pre-wire is gated
      // on publicBaseUrl, unset here, so the trace is exactly these three).
      expect(trace).toEqual(['provision', 'createWarming', 'attach']);
      expect(repo.createWarmingCalls).toHaveLength(1);
      const call = repo.createWarmingCalls[0]!;
      expect(call.poolNumber).toBe('+15550300001');
      expect(call.sid).toBe('PNwarm-0001');
      expect(call.conversationId).toBe('conv-42');
      // attach targets the bought PN SID.
      expect(adapter.attachedSids).toEqual(['PNwarm-0001']);
      // persisted WARMING (never active - promotion is solely the registration event).
      expect(repo.store.get('+15550300001')!.lifecycle_state).toBe('warming');
    });

    it('omits the earmark when no conversationId is given (untagged spare)', async () => {
      const trace: string[] = [];
      const repo = makeRepo();
      const svc = createPoolNumbersService({
        adapter: makeAdapter({ trace }),
        poolNumbersRepo: repo,
        conversationsRepo: stubConversations(),
        logger,
        config: makeConfig(),
      });

      await svc.warmOneNumber();

      expect(repo.createWarmingCalls[0]!.conversationId).toBeUndefined();
      expect(repo.store.get('+15550300001')!.pending_conversation_id).toBeUndefined();
    });

    it('refuses with RelayProvisioningDisabledError when relayLiveProvisioning=false; never touches the adapter', async () => {
      const trace: string[] = [];
      const adapter = makeAdapter({ trace });
      const provisionSpy = vi.spyOn(adapter, 'provisionPhoneNumber');
      const repo = makeRepo();
      const svc = createPoolNumbersService({
        adapter,
        poolNumbersRepo: repo,
        conversationsRepo: stubConversations(),
        logger,
        config: makeConfig({ relayLiveProvisioning: false }),
      });

      await expect(svc.warmOneNumber('conv-1')).rejects.toBeInstanceOf(
        RelayProvisioningDisabledError,
      );
      expect(provisionSpy).not.toHaveBeenCalled();
      expect(trace).toEqual([]);
      expect(repo.createWarmingCalls).toEqual([]);
    });

    it('DEDUP: a redelivered warm for a group with a WARMING earmarked number does NOT buy again (resumes attach)', async () => {
      // A prior warm bought + earmarked a number to conv-42 (and maybe crashed on
      // attach). The redelivered relay.warmNumber must NOT buy a SECOND number - the
      // duplicate would strand forever. It resumes the in-flight warm: re-attach.
      const trace: string[] = [];
      const adapter = makeAdapter({ trace });
      const provisionSpy = vi.spyOn(adapter, 'provisionPhoneNumber');
      const repo = makeRepo(trace);
      repo.seedWarming('+15550309999', { sid: 'PNexisting', startedAt: new Date().toISOString() });
      repo.store.get('+15550309999')!.pending_conversation_id = 'conv-42';
      const svc = createPoolNumbersService({
        adapter,
        poolNumbersRepo: repo,
        conversationsRepo: stubConversations(),
        logger,
        config: makeConfig({ relayLiveProvisioning: true }),
      });

      await svc.warmOneNumber('conv-42');

      // No second buy, no second warming record.
      expect(provisionSpy).not.toHaveBeenCalled();
      expect(repo.createWarmingCalls).toHaveLength(0);
      expect(trace).not.toContain('provision');
      expect(trace).not.toContain('createWarming');
      // Resumed the in-flight warm: re-attached the existing PN sid (idempotent).
      expect(adapter.attachedSids).toEqual(['PNexisting']);
      // Still exactly ONE warming record for the group (no duplicate).
      expect([...repo.store.values()].filter((i) => i.lifecycle_state === 'warming')).toHaveLength(1);
    });

    it('DEDUP: a group whose earmarked number already PROMOTED to active is not re-bought (awaits open)', async () => {
      const trace: string[] = [];
      const adapter = makeAdapter({ trace });
      const provisionSpy = vi.spyOn(adapter, 'provisionPhoneNumber');
      const repo = makeRepo(trace);
      // An already-promoted (active, empty burn) number still earmarked to conv-9,
      // waiting for relay.numberReady - nothing to buy or attach.
      repo.seedActiveSpare('+15550308888');
      repo.store.get('+15550308888')!.pending_conversation_id = 'conv-9';
      const svc = createPoolNumbersService({
        adapter,
        poolNumbersRepo: repo,
        conversationsRepo: stubConversations(),
        logger,
        config: makeConfig({ relayLiveProvisioning: true }),
      });

      await svc.warmOneNumber('conv-9');

      expect(provisionSpy).not.toHaveBeenCalled();
      expect(repo.createWarmingCalls).toHaveLength(0);
      expect(adapter.attachedSids).toEqual([]); // active branch: no re-attach
      expect(trace).toEqual([]);
    });
  });

  describe('refillBufferIfNeeded', () => {
    it('target 2, have 0 -> enqueues 2 relay.warmNumber jobs', async () => {
      const queue = makeRecordingQueue();
      configureOutboundQueue(queue);
      const svc = createPoolNumbersService({
        adapter: makeAdapter({ trace: [] }),
        poolNumbersRepo: makeRepo(),
        conversationsRepo: stubConversations(),
        logger,
        config: makeConfig({ relaySpareBufferTarget: 2 }),
      });

      await svc.refillBufferIfNeeded();

      const warm = queue.envelopes.filter((e) => e.jobName === RELAY_WARM_JOB);
      expect(warm).toHaveLength(2);
    });

    it('target 2, but 1 fresh spare + 1 warming already -> enqueues 0 (warming counts; debounce)', async () => {
      const repo = makeRepo();
      repo.seedActiveSpare('+1SPARE');
      repo.seedWarming('+1WARM', { sid: 'PNw', startedAt: new Date().toISOString() });
      const queue = makeRecordingQueue();
      configureOutboundQueue(queue);
      const svc = createPoolNumbersService({
        adapter: makeAdapter({ trace: [] }),
        poolNumbersRepo: repo,
        conversationsRepo: stubConversations(),
        logger,
        config: makeConfig({ relaySpareBufferTarget: 2 }),
      });

      await svc.refillBufferIfNeeded();

      expect(queue.envelopes.filter((e) => e.jobName === RELAY_WARM_JOB)).toHaveLength(0);
    });

    it('target 0 (dev) -> enqueues 0 regardless', async () => {
      const repo = makeRepo();
      repo.seedActiveSpare('+1SPARE'); // even with headroom, target 0 buys nothing
      const queue = makeRecordingQueue();
      configureOutboundQueue(queue);
      const svc = createPoolNumbersService({
        adapter: makeAdapter({ trace: [] }),
        poolNumbersRepo: repo,
        conversationsRepo: stubConversations(),
        logger,
        config: makeConfig({ relaySpareBufferTarget: 0 }),
      });

      await svc.refillBufferIfNeeded();

      expect(queue.envelopes).toHaveLength(0);
    });
  });

  describe('flagStuckWarming', () => {
    const NOW = new Date('2026-07-22T00:00:00.000Z');

    it('logs a single relay_warm_stuck error for a stale warming record, none for a fresh one', async () => {
      const repo = makeRepo();
      const maxWait = 30 * 60_000;
      // stale: started 1h ago (past the 30min wait); fresh: started 1min ago.
      repo.seedWarming('+1STUCK', {
        sid: 'PNstuck',
        startedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
      });
      repo.seedWarming('+1FRESH', {
        sid: 'PNfresh',
        startedAt: new Date(NOW.getTime() - 60_000).toISOString(),
      });
      const svc = createPoolNumbersService({
        adapter: makeAdapter({ trace: [] }),
        poolNumbersRepo: repo,
        conversationsRepo: stubConversations(),
        logger,
        now: () => NOW,
        config: makeConfig({ relayWarmingMaxWaitMs: maxWait }),
      });

      await svc.flagStuckWarming();

      const stuck = capture.atLevel(50).filter((l) => l['event'] === 'relay_warm_stuck');
      expect(stuck).toHaveLength(1);
      // PII: the SID is logged (the D2 correlation key), never the pool number.
      expect(stuck[0]!['sid']).toBe('PNstuck');
    });

    it('does not promote a stuck warming record (alert only)', async () => {
      const repo = makeRepo();
      repo.seedWarming('+1STUCK', {
        sid: 'PNstuck',
        startedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
      });
      const svc = createPoolNumbersService({
        adapter: makeAdapter({ trace: [] }),
        poolNumbersRepo: repo,
        conversationsRepo: stubConversations(),
        logger,
        now: () => NOW,
        config: makeConfig({ relayWarmingMaxWaitMs: 30 * 60_000 }),
      });

      await svc.flagStuckWarming();

      expect(repo.store.get('+1STUCK')!.lifecycle_state).toBe('warming');
    });
  });

  describe('flagStuckConnecting (T6)', () => {
    const NOW = new Date('2026-07-22T00:00:00.000Z');

    /** A conversations repo returning the given connecting groups (by created_at). */
    function connectingRepo(
      groups: { conversationId: string; createdAt: string }[],
    ): ConversationsRepo {
      return {
        async listRelayGroups(status: string) {
          if (status !== 'connecting') return { items: [], truncated: false };
          return {
            items: groups.map((g) => ({
              conversationId: g.conversationId,
              status: 'connecting',
              relay_status: 'relay_group#connecting',
              type: 'relay_group',
              ai_mode: 'manual',
              last_activity_at: g.createdAt,
              created_at: g.createdAt,
            })) as unknown as ConversationItem[],
            truncated: false,
          };
        },
      } as unknown as ConversationsRepo;
    }

    it('logs a single relay_connecting_stuck error for a stale connecting group, none for a fresh one', async () => {
      const maxWait = 30 * 60_000;
      const svc = createPoolNumbersService({
        adapter: makeAdapter({ trace: [] }),
        poolNumbersRepo: makeRepo(),
        conversationsRepo: connectingRepo([
          // stale: created 1h ago (past the 30min wait); fresh: created 1min ago.
          { conversationId: 'conv-stuck', createdAt: new Date(NOW.getTime() - 60 * 60_000).toISOString() },
          { conversationId: 'conv-fresh', createdAt: new Date(NOW.getTime() - 60_000).toISOString() },
        ]),
        logger,
        now: () => NOW,
        config: makeConfig({ relayWarmingMaxWaitMs: maxWait }),
      });

      await svc.flagStuckConnecting();

      const stuck = capture.atLevel(50).filter((l) => l['event'] === 'relay_connecting_stuck');
      expect(stuck).toHaveLength(1);
      // PII: the conversationId is logged (an internal id), never a member phone.
      expect(stuck[0]!['conversationId']).toBe('conv-stuck');
    });

    it('does not open/mutate a stuck connecting group (alert only)', async () => {
      const listSpy = vi.fn(async () => ({ items: [] as ConversationItem[], truncated: false }));
      const svc = createPoolNumbersService({
        adapter: makeAdapter({ trace: [] }),
        poolNumbersRepo: makeRepo(),
        conversationsRepo: { listRelayGroups: listSpy } as unknown as ConversationsRepo,
        logger,
        now: () => NOW,
        config: makeConfig({ relayWarmingMaxWaitMs: 30 * 60_000 }),
      });

      await svc.flagStuckConnecting();

      // It only READS the connecting partition - no assign/open call exists on the path.
      expect(listSpy).toHaveBeenCalledWith('connecting');
    });
  });

  describe('relay.warmNumber job handler', () => {
    it('dispatches to warmOneNumber with the payload conversationId', async () => {
      const warmOneNumber = vi.fn(async () => {});
      registerRelayWarmJobHandler({
        poolNumbersService: { warmOneNumber } as unknown as PoolNumbersService,
        logger,
      });

      await enqueueImmediate(RELAY_WARM_JOB, { conversationId: 'c-1' });
      await queueAdapter.settle();

      expect(warmOneNumber).toHaveBeenCalledTimes(1);
      expect(warmOneNumber).toHaveBeenCalledWith('c-1');
    });

    it('dispatches with undefined when the payload has no conversationId', async () => {
      const warmOneNumber = vi.fn(async () => {});
      registerRelayWarmJobHandler({
        poolNumbersService: { warmOneNumber } as unknown as PoolNumbersService,
        logger,
      });

      await enqueueImmediate(RELAY_WARM_JOB, {});
      await queueAdapter.settle();

      expect(warmOneNumber).toHaveBeenCalledWith(undefined);
    });
  });

  describe('parseRelayWarmPayload', () => {
    it('surfaces a non-empty conversationId', () => {
      expect(parseRelayWarmPayload({ conversationId: 'c-9' })).toEqual({ conversationId: 'c-9' });
    });
    it('omits a missing / empty / non-string conversationId', () => {
      expect(parseRelayWarmPayload({})).toEqual({});
      expect(parseRelayWarmPayload({ conversationId: '' })).toEqual({});
      expect(parseRelayWarmPayload({ conversationId: 123 })).toEqual({});
    });
    it('throws on a non-object payload', () => {
      expect(() => parseRelayWarmPayload(null)).toThrow();
      expect(() => parseRelayWarmPayload('nope')).toThrow();
    });
  });
});
