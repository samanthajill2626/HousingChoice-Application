// poolNumbers service (burn-multiplexing revision) - the provisionForGroup
// burn-as-claim ladder + config-gated retirement sweep. Uses an in-memory
// poolNumbersRepo whose burnClaim is ATOMIC-FAITHFUL (a synchronous overlap
// check before the mutate, so a sloppy fake cannot fake-pass the ladder) + a
// fake adapter (deterministic numbers; never touches Twilio) + a minimal fake
// conversationsRepo (getAllByPoolNumber drives the open-group veto).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type MessagingAdapter,
  type ProvisionPhoneNumberResult,
} from '../src/adapters/messaging.js';
import type { AppConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import type { ConversationItem, ConversationsRepo } from '../src/repos/conversationsRepo.js';
import {
  RELEASE_GRACE_MS,
  type PoolNumberItem,
  type PoolNumbersRepo,
} from '../src/repos/poolNumbersRepo.js';
import {
  createPoolNumbersService,
  RelayProvisioningDisabledError,
  RELAY_WARM_JOB,
} from '../src/services/poolNumbers.js';
import {
  _resetForTests,
  configureOutboundQueue,
} from '../src/jobs/jobs.js';
import type { OutboundQueueAdapter } from '../src/adapters/scheduler.js';
import type { JobEnvelope } from '../src/jobs/types.js';
import { createLogCapture } from './helpers/logCapture.js';

const logger = createLogger({ destination: createLogCapture().stream });

/** In-memory repo mirroring the burn-model semantics (atomic burnClaim). */
function makeFakeRepo(): PoolNumbersRepo & { store: Map<string, PoolNumberItem> } {
  const store = new Map<string, PoolNumberItem>();
  const SENTINEL = '0000-00-00T00:00:00.000Z';
  return {
    store,
    async get(poolNumber) {
      return store.get(poolNumber);
    },
    async create(input) {
      const now = new Date().toISOString();
      const item: PoolNumberItem = {
        poolNumber: input.poolNumber,
        lifecycle_state: 'active',
        quarantine_until: SENTINEL,
        voice_capable: input.voiceCapable,
        sms_capable: input.smsCapable,
        ...(input.provisionedVia !== undefined && { provisioned_via: input.provisionedVia }),
        ...(input.burn.length > 0 && { burned_phones: new Set(input.burn) }),
        ...(input.tag !== undefined && { placement_tag: input.tag }),
        provisioned_at: now,
      };
      store.set(item.poolNumber, item);
      return item;
    },
    async listActive() {
      return [...store.values()].filter((i) => i.lifecycle_state === 'active');
    },
    async listByState(state) {
      return [...store.values()].filter((i) => i.lifecycle_state === state);
    },
    async burnClaim(poolNumber, phones, tag) {
      if (phones.length === 0) return undefined;
      const item = store.get(poolNumber);
      if (!item || item.lifecycle_state !== 'active') return undefined;
      // ATOMIC: the overlap check + mutate happen with no await between them,
      // faithful to the conditional-ADD invariant.
      const burned =
        item.burned_phones instanceof Set ? item.burned_phones : new Set(item.burned_phones ?? []);
      if (phones.some((p) => burned.has(p))) return undefined; // overlap -> loser
      for (const p of phones) burned.add(p);
      item.burned_phones = burned;
      if (tag !== undefined) item.placement_tag = tag;
      return item;
    },
    async noteGroupClosed(poolNumber, closedAt) {
      const item = store.get(poolNumber);
      if (!item) return;
      const existing = item.last_group_closed_at;
      if (existing === undefined || existing < closedAt) item.last_group_closed_at = closedAt;
    },
    async beginRelease(poolNumber) {
      // W2: active -> releasing (the sweep's claim).
      const item = store.get(poolNumber);
      if (!item || item.lifecycle_state !== 'active') return undefined;
      item.lifecycle_state = 'releasing';
      return item;
    },
    async abortRelease(poolNumber) {
      // W2: releasing -> active (rollback).
      const item = store.get(poolNumber);
      if (!item || item.lifecycle_state !== 'releasing') return undefined;
      item.lifecycle_state = 'active';
      return item;
    },
    async releaseNumber(poolNumber) {
      // W2: finalize from RELEASING only (beginRelease must claim first).
      const item = store.get(poolNumber);
      if (!item || item.lifecycle_state !== 'releasing') return undefined;
      item.lifecycle_state = 'released';
      item.released_at = new Date().toISOString();
      return item;
    },
    async createWarming(input) {
      const now = new Date().toISOString();
      const item: PoolNumberItem = {
        poolNumber: input.poolNumber,
        lifecycle_state: 'warming',
        quarantine_until: SENTINEL,
        voice_capable: input.voiceCapable,
        sms_capable: input.smsCapable,
        sid: input.sid,
        warming_started_at: now,
        ...(input.provisionedVia !== undefined && { provisioned_via: input.provisionedVia }),
        ...(input.tag !== undefined && { placement_tag: input.tag }),
        ...(input.conversationId !== undefined && {
          pending_conversation_id: input.conversationId,
        }),
        provisioned_at: now,
      };
      store.set(item.poolNumber, item);
      return item;
    },
    async promoteToActive(poolNumber) {
      // Sole warming->active writer; conditional + idempotent (false if not warming).
      const item = store.get(poolNumber);
      if (!item || item.lifecycle_state !== 'warming') return false;
      item.lifecycle_state = 'active';
      delete item.warming_started_at; // pending_conversation_id left intact
      return true;
    },
    async listWarming() {
      return [...store.values()].filter((i) => i.lifecycle_state === 'warming');
    },
    async findWarmingBySid(sid) {
      return [...store.values()].find((i) => i.lifecycle_state === 'warming' && i.sid === sid);
    },
    async countFreshSpares() {
      // active AND empty-burn AND not earmarked (D7 Set-or-array-safe count).
      return [...store.values()].filter((i) => {
        if (i.lifecycle_state !== 'active') return false;
        const burned = i.burned_phones;
        const burnedCount =
          burned instanceof Set ? burned.size : Array.isArray(burned) ? burned.length : 0;
        return burnedCount === 0 && i.pending_conversation_id === undefined;
      }).length;
    },
    async countWarming() {
      return [...store.values()].filter((i) => i.lifecycle_state === 'warming').length;
    },
  };
}

function makeFakeAdapter(
  opts: { voice?: boolean } = {},
): MessagingAdapter & { provisions: number; released: string[] } {
  let provisions = 0;
  const released: string[] = [];
  const adapter: MessagingAdapter & { provisions: number; released: string[] } = {
    get provisions() {
      return provisions;
    },
    released,
    async sendMessage() {
      return { providerSid: 'SMx', status: 'queued', providerTs: new Date().toISOString() };
    },
    async getMediaStream() {
      throw new Error('not used');
    },
    async getRecordingStream() {
      throw new Error('not used');
    },
    async provisionPhoneNumber(): Promise<ProvisionPhoneNumberResult> {
      provisions += 1;
      const seq = String(provisions).padStart(4, '0');
      return {
        phoneNumber: `+1555020${seq}`,
        capabilities: { sms: true, voice: opts.voice ?? true },
        sid: `PNtest-${seq}`,
      };
    },
    async setVoiceWebhook() {},
    async releasePhoneNumber(phoneNumber) {
      released.push(phoneNumber);
    },
    async attachToMessagingService() {},
    async detachFromMessagingService() {},
    async initiateCall() {
      return { callSid: 'CAtest-pool' };
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
  return adapter;
}

/** Minimal conversations repo: only getAllByPoolNumber is exercised by the sweep. */
function makeFakeConversations(
  byPool: Record<string, Array<{ status: string }>> = {},
): ConversationsRepo {
  return {
    async getAllByPoolNumber(poolNumber: string) {
      return (byPool[poolNumber] ?? []) as ConversationItem[];
    },
    // provisionForGroup opportunistically fires flagStuckConnecting, which lists
    // the connecting partition - stub it (no connecting groups in these tests).
    async listRelayGroups() {
      return { items: [] as ConversationItem[], truncated: false };
    },
  } as unknown as ConversationsRepo;
}

/**
 * Minimal AppConfig for the ladder tests. messagingDriver = source tag,
 * relayLiveProvisioning = provisioning kill-switch, relayNumberReleaseEnabled =
 * retirement gate (default OFF so the lazy sweep no-ops).
 */
function makeConfig(over: Partial<AppConfig>): AppConfig {
  return {
    messagingDriver: 'console',
    relayLiveProvisioning: true,
    relayNumberReleaseEnabled: false,
    // Warm-pool knobs (T4/T5). Dev default target 0 -> refillBufferIfNeeded
    // enqueues nothing, so the ladder tests never touch the job queue unless a
    // test opts in (the target-0 refill assertion below wires a recording queue).
    relaySpareBufferTarget: 0,
    relayWarmingMaxWaitMs: 30 * 60_000,
    ...over,
  } as AppConfig;
}
const consoleConfig = (): AppConfig =>
  makeConfig({ messagingDriver: 'console', relayLiveProvisioning: true });
const twilioConfigOff = (): AppConfig =>
  makeConfig({ messagingDriver: 'twilio', relayLiveProvisioning: false });
const twilioConfigOn = (): AppConfig =>
  makeConfig({ messagingDriver: 'twilio', relayLiveProvisioning: true });

const T1 = '+15551110001';
const L1 = '+15551110002';

/** Records enqueued job envelopes without dispatching (refill enqueue counts). */
function makeRecordingQueue(): OutboundQueueAdapter & { envelopes: JobEnvelope[] } {
  const envelopes: JobEnvelope[] = [];
  return {
    envelopes,
    async enqueue(envelope: JobEnvelope) {
      envelopes.push(envelope);
    },
  };
}

/** Seed an EMPTY-burn active spare (fresh spare; optional connect-when-ready earmark). */
async function seedSpare(
  repo: ReturnType<typeof makeFakeRepo>,
  pn: string,
  opts: { via?: 'console' | 'twilio'; pendingConversationId?: string } = {},
): Promise<void> {
  await repo.create({
    poolNumber: pn,
    voiceCapable: true,
    smsCapable: true,
    provisionedVia: opts.via ?? 'console',
    burn: [], // empty burn -> a fresh spare
  });
  if (opts.pendingConversationId !== undefined) {
    repo.store.get(pn)!.pending_conversation_id = opts.pendingConversationId;
  }
}

describe('poolNumbersService.provisionForGroup - three-tier ladder (T5)', () => {
  afterEach(() => {
    _resetForTests();
  });

  it('TIER 1 preferred over TIER 2: an already-burned non-overlapping active is claimed, the fresh spare untouched', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    // A burned (multiplexable) active + a pristine spare. The roster overlaps
    // neither, so BOTH could take it - tier 1 (multiplex) must win.
    await repo.create({ poolNumber: '+1BURNED', voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: ['+15559990001'] });
    await seedSpare(repo, '+1SPARE');
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: consoleConfig(),
    });

    const result = await svc.provisionForGroup([T1, L1]);
    expect(result.kind).toBe('assigned');
    if (result.kind !== 'assigned') throw new Error('unreachable');
    expect(result.poolNumber).toBe('+1BURNED'); // multiplex preferred
    expect(result.provisioned).toBe(false);
    expect(adapter.provisions).toBe(0); // NEVER buys
    // The burned number now also carries the roster; the spare is pristine.
    expect([...(repo.store.get('+1BURNED')!.burned_phones as Set<string>)]).toEqual(
      expect.arrayContaining([T1, L1]),
    );
    expect(repo.store.get('+1SPARE')!.burned_phones).toBeUndefined(); // untouched
  });

  it('TIER 1 reuse: claims the FIRST burned active with zero overlap, skips overlapping ones', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    // numberA burned {T1} (overlaps), numberB burned {x1} (clear). Roster {T1,L1}.
    await repo.create({ poolNumber: '+1A', voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: [T1] });
    await repo.create({ poolNumber: '+1B', voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: ['+15559990001'] });
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: consoleConfig(),
    });

    const result = await svc.provisionForGroup([T1, L1]);
    expect(result).toMatchObject({ kind: 'assigned', poolNumber: '+1B', provisioned: false });
    expect(adapter.provisions).toBe(0);
    expect([...(repo.store.get('+1B')!.burned_phones as Set<string>)]).toEqual(
      expect.arrayContaining([T1, L1]),
    );
    expect([...(repo.store.get('+1A')!.burned_phones as Set<string>)]).not.toContain(L1);
  });

  it('TIER 2: no reusable active but a fresh spare exists -> the spare is claimed (kind assigned, provisioned false)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    await seedSpare(repo, '+1SPARE');
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: consoleConfig(),
    });

    const result = await svc.provisionForGroup([T1, L1], 'fair-2026');
    expect(result).toMatchObject({ kind: 'assigned', poolNumber: '+1SPARE', provisioned: false });
    expect(adapter.provisions).toBe(0); // spare consumed, nothing bought
    const rec = repo.store.get('+1SPARE')!;
    expect([...(rec.burned_phones as Set<string>)].sort()).toEqual([T1, L1].sort());
    expect(rec.placement_tag).toBe('fair-2026'); // tag stamped on claim
  });

  it('TIER 3: NO active and NO spare -> needs_connecting, and NO adapter buy call', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    const provisionSpy = vi.spyOn(adapter, 'provisionPhoneNumber');
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: consoleConfig(),
    });

    const result = await svc.provisionForGroup([T1, L1]);
    expect(result).toEqual({ kind: 'needs_connecting' });
    expect(provisionSpy).not.toHaveBeenCalled(); // buying is warmOneNumber's job only
  });

  it('TIER 3: every burned active overlaps and there is no spare -> needs_connecting (no buy)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    await repo.create({ poolNumber: '+1OVERLAP', voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: [T1] });
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: consoleConfig(),
    });

    const result = await svc.provisionForGroup([T1, L1]); // overlaps the only number
    expect(result).toEqual({ kind: 'needs_connecting' });
    expect(adapter.provisions).toBe(0);
  });

  it('G2: a fresh spare carrying pending_conversation_id is NOT consumed (earmarked to a connecting group) -> needs_connecting', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    // The ONLY candidate is an empty-burn active EARMARKED to a connecting group.
    // Tier 2 must skip it (same "fresh spare" definition as countFreshSpares), so
    // a concurrent group cannot steal a number another group is waiting to open.
    await seedSpare(repo, '+1EARMARKED', { pendingConversationId: 'conv-waiting' });
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: consoleConfig(),
    });

    const result = await svc.provisionForGroup([T1, L1]);
    expect(result).toEqual({ kind: 'needs_connecting' });
    // The earmarked number was NEVER burned onto (still a pristine, earmarked spare).
    expect(repo.store.get('+1EARMARKED')!.burned_phones).toBeUndefined();
    expect(repo.store.get('+1EARMARKED')!.pending_conversation_id).toBe('conv-waiting');
  });

  it('kill-switch OFF: a tier-3 miss THROWS RelayProvisioningDisabledError (no buy, no warm job enqueued - the connect-when-ready path stays dormant, route surfaces a clean 503)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    const provisionSpy = vi.spyOn(adapter, 'provisionPhoneNumber');
    // The ONLY candidate overlaps the roster and there is no spare -> tier-3 miss.
    // With the kill-switch OFF the connect-when-ready path cannot complete (no
    // number now and warming is forbidden), so provisionForGroup must THROW rather
    // than return needs_connecting - otherwise the caller mints a CONNECTING group
    // whose warm job dies in the worker, stranding it permanently connecting.
    await repo.create({ poolNumber: '+1OVERLAP', voiceCapable: true, smsCapable: true, provisionedVia: 'twilio', burn: [T1] });
    // A NON-ZERO buffer target so a stray refillBufferIfNeeded WOULD enqueue a warm
    // job; asserting zero proves the throw short-circuits BEFORE any refill (dormant).
    const queue = makeRecordingQueue();
    configureOutboundQueue(queue);
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger,
      config: makeConfig({ messagingDriver: 'twilio', relayLiveProvisioning: false, relaySpareBufferTarget: 2 }),
    });

    await expect(svc.provisionForGroup([T1, L1])).rejects.toBeInstanceOf(RelayProvisioningDisabledError);
    expect(provisionSpy).not.toHaveBeenCalled(); // never buys - the buy path is warmOneNumber only
    // NO warm job enqueued by this method: the path is fully dormant with the flag off.
    expect(queue.envelopes.filter((e) => e.jobName === RELAY_WARM_JOB)).toHaveLength(0);
  });

  it('reuse works regardless of the kill-switch: a clean twilio-tagged burned active is claimed with the flag OFF', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    await repo.create({ poolNumber: '+1CLEAN', voiceCapable: true, smsCapable: true, provisionedVia: 'twilio', burn: ['+15559990003'] });
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: twilioConfigOff(),
    });

    const result = await svc.provisionForGroup([T1, L1]);
    expect(result).toMatchObject({ kind: 'assigned', poolNumber: '+1CLEAN', provisioned: false });
    expect(adapter.provisions).toBe(0);
  });

  it('spare works regardless of the kill-switch: a fresh twilio-tagged spare is consumed with the flag OFF (tier 2 never buys)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    const provisionSpy = vi.spyOn(adapter, 'provisionPhoneNumber');
    // A pristine twilio-tagged spare. Tier 2 consumes it (no buy, no throw) even
    // with the kill-switch OFF - only a tier-3 MISS is gated by the flag.
    await seedSpare(repo, '+1TWSPARE', { via: 'twilio' });
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: twilioConfigOff(),
    });

    const result = await svc.provisionForGroup([T1, L1]);
    expect(result).toMatchObject({ kind: 'assigned', poolNumber: '+1TWSPARE', provisioned: false });
    expect(provisionSpy).not.toHaveBeenCalled(); // spare consumed, nothing bought
  });

  it('driver source-isolation: the twilio path does NOT reuse a console-tagged number -> needs_connecting', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    // A pristine console-tagged spare + a burned console-tagged active: the twilio
    // driver must reuse NEITHER (source isolation), so it needs a connecting group.
    await seedSpare(repo, '+1CONSOLE_SPARE', { via: 'console' });
    await repo.create({ poolNumber: '+1CONSOLE_BURNED', voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: ['+15559990002'] });
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: twilioConfigOn(),
    });

    const result = await svc.provisionForGroup([T1, L1]);
    expect(result).toEqual({ kind: 'needs_connecting' });
    expect(repo.store.get('+1CONSOLE_SPARE')!.burned_phones).toBeUndefined(); // never claimed
    expect(repo.store.get('+1CONSOLE_BURNED')!.lifecycle_state).toBe('active'); // never touched
  });

  it('a lost race on the only burned candidate falls through to needs_connecting (no spare to fall back to)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    await repo.create({ poolNumber: '+1RACE', voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: ['+15559990004'] });
    // The clean burned candidate loses its tier-1 claim (burnClaim -> undefined);
    // there is no empty-burn spare, so the ladder falls through to needs_connecting.
    repo.burnClaim = async () => undefined;
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: consoleConfig(),
    });

    const result = await svc.provisionForGroup([T1, L1]);
    expect(result).toEqual({ kind: 'needs_connecting' });
    expect(adapter.provisions).toBe(0);
  });

  it('empty roster throws (never claim an unburnable group)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: consoleConfig(),
    });
    await expect(svc.provisionForGroup([])).rejects.toThrow();
  });

  it('refillBufferIfNeeded RAN after an assign (tops the buffer up)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    await seedSpare(repo, '+1SPARE');
    // countFreshSpares is called ONLY by refillBufferIfNeeded (never elsewhere in
    // provisionForGroup), so observing it proves the refill hook ran on the assign.
    const refillProbe = vi.spyOn(repo, 'countFreshSpares');
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: consoleConfig(),
    });

    const result = await svc.provisionForGroup([T1, L1]);
    expect(result.kind).toBe('assigned');
    expect(refillProbe).toHaveBeenCalled();
  });

  it('dev target 0: consuming a fresh spare enqueues 0 refill jobs', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    await seedSpare(repo, '+1SPARE');
    const queue = makeRecordingQueue();
    configureOutboundQueue(queue);
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger,
      config: makeConfig({ relaySpareBufferTarget: 0 }),
    });

    const result = await svc.provisionForGroup([T1, L1]); // consumes the spare (tier 2)
    expect(result.kind).toBe('assigned');
    expect(queue.envelopes.filter((e) => e.jobName === RELAY_WARM_JOB)).toHaveLength(0);
  });
});

describe('poolNumbersService.retireEligible', () => {
  const NOW = new Date('2026-07-17T00:00:00.000Z');
  const OLD_CLOSE = new Date(NOW.getTime() - RELEASE_GRACE_MS - 24 * 60 * 60 * 1000).toISOString();
  const RECENT_CLOSE = new Date(NOW.getTime() - RELEASE_GRACE_MS + 24 * 60 * 60 * 1000).toISOString();

  /** Seed an active number with a set last_group_closed_at. */
  async function seedClosed(repo: ReturnType<typeof makeFakeRepo>, pn: string, closedAt?: string) {
    await repo.create({ poolNumber: pn, voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: [`${pn}-x`] });
    if (closedAt !== undefined) repo.store.get(pn)!.last_group_closed_at = closedAt;
  }

  it('releases a number with zero open groups whose newest close is older than the grace', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    await seedClosed(repo, '+1OLD', OLD_CLOSE);
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, logger, now: () => NOW,
      conversationsRepo: makeFakeConversations({ '+1OLD': [{ status: 'closed' }] }),
      config: makeConfig({ relayNumberReleaseEnabled: true }),
    });

    const released = await svc.retireEligible();
    expect(released).toEqual(['+1OLD']);
    expect(adapter.released).toEqual(['+1OLD']); // dropped at Twilio
    expect(repo.store.get('+1OLD')!.lifecycle_state).toBe('released');
  });

  it('vetoes when ANY open group exists on the number (adapter NOT called)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    await seedClosed(repo, '+1OPEN', OLD_CLOSE);
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, logger, now: () => NOW,
      conversationsRepo: makeFakeConversations({ '+1OPEN': [{ status: 'closed' }, { status: 'open' }] }),
      config: makeConfig({ relayNumberReleaseEnabled: true }),
    });

    expect(await svc.retireEligible()).toEqual([]);
    expect(adapter.released).toEqual([]);
    expect(repo.store.get('+1OPEN')!.lifecycle_state).toBe('active');
  });

  it('vetoes inside the grace window (newest close is more recent than the grace)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    await seedClosed(repo, '+1RECENT', RECENT_CLOSE);
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, logger, now: () => NOW,
      conversationsRepo: makeFakeConversations({ '+1RECENT': [{ status: 'closed' }] }),
      config: makeConfig({ relayNumberReleaseEnabled: true }),
    });
    expect(await svc.retireEligible()).toEqual([]);
    expect(adapter.released).toEqual([]);
  });

  it('vetoes a number that never hosted a group (no last_group_closed_at)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    await seedClosed(repo, '+1FRESH'); // no close stamp
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, logger, now: () => NOW,
      conversationsRepo: makeFakeConversations({ '+1FRESH': [] }),
      config: makeConfig({ relayNumberReleaseEnabled: true }),
    });
    expect(await svc.retireEligible()).toEqual([]);
    expect(adapter.released).toEqual([]);
  });

  it('vetoes a corrupt / unparseable last_group_closed_at (adapter NOT called, nothing released, stays active)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    // A corrupt stamp: Date.parse('not-a-date') = NaN, and NaN > cutoff is false,
    // so an unguarded grace check would WRONGLY fall through and release it. The
    // sweep must instead SKIP it (parity with the admin page's NaN guard).
    await seedClosed(repo, '+1CORRUPT', 'not-a-date');
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, logger, now: () => NOW,
      conversationsRepo: makeFakeConversations({ '+1CORRUPT': [{ status: 'closed' }] }),
      config: makeConfig({ relayNumberReleaseEnabled: true }),
    });

    expect(await svc.retireEligible()).toEqual([]);
    expect(adapter.released).toEqual([]); // never dropped at Twilio
    expect(repo.store.get('+1CORRUPT')!.lifecycle_state).toBe('active'); // never claimed
  });

  it('no-ops entirely when relayNumberReleaseEnabled=false', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    await seedClosed(repo, '+1OLD', OLD_CLOSE);
    const convSpy = vi.fn(async () => [] as ConversationItem[]);
    const conversationsRepo = { getAllByPoolNumber: convSpy } as unknown as ConversationsRepo;
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo, logger, now: () => NOW,
      config: makeConfig({ relayNumberReleaseEnabled: false }),
    });

    expect(await svc.retireEligible()).toEqual([]);
    expect(convSpy).not.toHaveBeenCalled(); // short-circuits before any read
    expect(adapter.released).toEqual([]);
  });

  it('adapter failure on one number: it ABORTS back to active, error logged, the sweep continues', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    // First release throws; the second succeeds -> proves the sweep continues.
    let calls = 0;
    adapter.releasePhoneNumber = async (pn: string) => {
      calls += 1;
      if (calls === 1) throw new Error('twilio 500');
      adapter.released.push(pn);
    };
    await seedClosed(repo, '+1FAILS', OLD_CLOSE);
    await seedClosed(repo, '+1OK', OLD_CLOSE);
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, logger, now: () => NOW,
      conversationsRepo: makeFakeConversations({ '+1FAILS': [{ status: 'closed' }], '+1OK': [{ status: 'closed' }] }),
      config: makeConfig({ relayNumberReleaseEnabled: true }),
    });

    const released = await svc.retireEligible();
    expect(released).toEqual(['+1OK']); // only the one that dropped cleanly
    // W2: the adapter failure ABORTED the release (releasing -> active). If the
    // abort had NOT run it would be stuck 'releasing'; 'active' proves the roll-back.
    expect(repo.store.get('+1FAILS')!.lifecycle_state).toBe('active');
    expect(repo.store.get('+1OK')!.lifecycle_state).toBe('released');
  });

  // --- W2 TOCTOU fence -----------------------------------------------------
  it('W2 happy path: claims BEFORE dropping at Twilio, finalizes AFTER (active -> releasing -> released)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    await seedClosed(repo, '+1WALK', OLD_CLOSE);
    // Capture the lifecycle_state at the instant the adapter drop runs - it must
    // already be 'releasing' (claimed by beginRelease), proving no NEW group
    // could have burned onto it while we hand it back.
    let stateAtDrop: string | undefined;
    adapter.releasePhoneNumber = async (pn: string) => {
      stateAtDrop = repo.store.get(pn)!.lifecycle_state;
      adapter.released.push(pn);
    };
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, logger, now: () => NOW,
      conversationsRepo: makeFakeConversations({ '+1WALK': [{ status: 'closed' }] }),
      config: makeConfig({ relayNumberReleaseEnabled: true }),
    });

    expect(await svc.retireEligible()).toEqual(['+1WALK']);
    expect(stateAtDrop).toBe('releasing'); // claimed before the Twilio drop
    expect(repo.store.get('+1WALK')!.lifecycle_state).toBe('released'); // finalized after
  });

  it('W2: burnClaim is REFUSED while a number is mid-release (releasing); abort restores it', async () => {
    const repo = makeFakeRepo();
    await repo.create({
      poolNumber: '+1REL', voiceCapable: true, smsCapable: true, provisionedVia: 'console',
      burn: ['+15551110001'],
    });
    // beginRelease claims it; burnClaim (conditions on active) now refuses, so no
    // NEW group can land on a number mid-release.
    expect(await repo.beginRelease('+1REL')).toMatchObject({ lifecycle_state: 'releasing' });
    expect(await repo.burnClaim('+1REL', ['+15551119990'])).toBeUndefined();
    // Aborting the release returns it to service - burnClaim works again.
    expect(await repo.abortRelease('+1REL')).toMatchObject({ lifecycle_state: 'active' });
    expect(await repo.burnClaim('+1REL', ['+15551119990'])).toBeDefined();
  });

  it('W2 re-verify: a group that OPENS between the pre-veto and the claim ABORTS the release (adapter NOT called)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    await seedClosed(repo, '+1RACE2', OLD_CLOSE);
    // Pre-veto (1st read) sees only a closed group; the re-verify (2nd read, after
    // the claim) sees a newly-OPEN group -> abort, and the adapter is never called.
    let reads = 0;
    const conversationsRepo = {
      async getAllByPoolNumber() {
        reads += 1;
        return (reads === 1
          ? [{ status: 'closed' }]
          : [{ status: 'closed' }, { status: 'open' }]) as ConversationItem[];
      },
    } as unknown as ConversationsRepo;
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo, logger, now: () => NOW,
      config: makeConfig({ relayNumberReleaseEnabled: true }),
    });

    expect(await svc.retireEligible()).toEqual([]);
    expect(adapter.released).toEqual([]); // never dropped at Twilio
    expect(repo.store.get('+1RACE2')!.lifecycle_state).toBe('active'); // aborted back to active
    expect(reads).toBe(2); // pre-veto + the fresh re-verify both ran
  });

  // --- T8 explicit Messaging Service detach on retirement ------------------
  it('T8 detach ordering: detaches from the messaging service BEFORE dropping the number at Twilio', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    await seedClosed(repo, '+1DETACH', OLD_CLOSE);
    // Record the adapter call order: the A2P sender-pool detach must run BEFORE
    // the resource delete (deterministic membership cleanup; the delete would
    // otherwise detach only implicitly).
    const order: string[] = [];
    vi.spyOn(adapter, 'detachFromMessagingService').mockImplementation(async () => {
      order.push('detach');
    });
    vi.spyOn(adapter, 'releasePhoneNumber').mockImplementation(async (pn: string) => {
      order.push('release');
      adapter.released.push(pn);
    });
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, logger, now: () => NOW,
      conversationsRepo: makeFakeConversations({ '+1DETACH': [{ status: 'closed' }] }),
      config: makeConfig({ relayNumberReleaseEnabled: true }),
    });

    expect(await svc.retireEligible()).toEqual(['+1DETACH']);
    expect(order).toEqual(['detach', 'release']); // detach FIRST, then the delete
    expect(adapter.released).toEqual(['+1DETACH']);
  });

  it('T8 best-effort: a detach failure is logged but does NOT abort the release (delete + finalize still run)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    await seedClosed(repo, '+1DFAIL', OLD_CLOSE);
    // The detach throws (e.g. a transient Twilio API error). Because the number
    // delete below drops it from the service implicitly anyway, the sweep must
    // swallow + log the detach error and STILL release + finalize the number -
    // never strand a retirement on a detach hiccup.
    const detachSpy = vi
      .spyOn(adapter, 'detachFromMessagingService')
      .mockRejectedValue(new Error('twilio 500 on detach'));
    const releaseSpy = vi.spyOn(adapter, 'releasePhoneNumber');
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, logger, now: () => NOW,
      conversationsRepo: makeFakeConversations({ '+1DFAIL': [{ status: 'closed' }] }),
      config: makeConfig({ relayNumberReleaseEnabled: true }),
    });

    const released = await svc.retireEligible();
    expect(detachSpy).toHaveBeenCalledWith('+1DFAIL'); // detach was attempted
    expect(released).toEqual(['+1DFAIL']); // retirement COMPLETED despite the detach throw
    expect(releaseSpy).toHaveBeenCalledWith('+1DFAIL'); // the delete still ran
    expect(adapter.released).toEqual(['+1DFAIL']);
    expect(repo.store.get('+1DFAIL')!.lifecycle_state).toBe('released'); // finalized
  });
});
