// poolNumbers service (burn-multiplexing revision) - the provisionForGroup
// burn-as-claim ladder + config-gated retirement sweep. Uses an in-memory
// poolNumbersRepo whose burnClaim is ATOMIC-FAITHFUL (a synchronous overlap
// check before the mutate, so a sloppy fake cannot fake-pass the ladder) + a
// fake adapter (deterministic numbers; never touches Twilio) + a minimal fake
// conversationsRepo (getAllByPoolNumber drives the open-group veto).
import { describe, expect, it, vi } from 'vitest';
import {
  VoiceCapabilityError,
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
} from '../src/services/poolNumbers.js';
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
    async releaseNumber(poolNumber) {
      const item = store.get(poolNumber);
      if (!item || item.lifecycle_state !== 'active') return undefined;
      item.lifecycle_state = 'released';
      item.released_at = new Date().toISOString();
      return item;
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
    async initiateCall() {
      return { callSid: 'CAtest-pool' };
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

describe('poolNumbersService.provisionForGroup - burn ladder', () => {
  it('reuses the FIRST active number with zero overlap (skips overlapping ones)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    // numberA burned {T1}; numberB burned {x1}. Roster {T1, L1} overlaps A -> B.
    await repo.create({ poolNumber: '+1A', voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: [T1] });
    await repo.create({ poolNumber: '+1B', voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: ['+15559990001'] });
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: consoleConfig(),
    });

    const result = await svc.provisionForGroup([T1, L1]);
    expect(result).toMatchObject({ poolNumber: '+1B', provisioned: false });
    expect(adapter.provisions).toBe(0); // never bought
    // B's burn now contains the roster.
    expect([...(repo.store.get('+1B')!.burned_phones as Set<string>)]).toEqual(
      expect.arrayContaining([T1, L1]),
    );
    // A untouched (the roster was never burned onto it).
    expect([...(repo.store.get('+1A')!.burned_phones as Set<string>)]).not.toContain(L1);
  });

  it('driver source-isolation: a console-tagged clean number is NOT reused by the twilio path', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    // A perfectly clean number, but tagged console - the twilio driver must buy fresh.
    await repo.create({ poolNumber: '+1CONSOLE', voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: ['+15559990002'] });
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: twilioConfigOn(),
    });

    const result = await svc.provisionForGroup([T1, L1]);
    expect(result.provisioned).toBe(true);
    expect(result.poolNumber).not.toBe('+1CONSOLE');
    expect(repo.store.get('+1CONSOLE')!.lifecycle_state).toBe('active'); // never claimed
  });

  it('buys fresh when EVERY active number overlaps; the new record is burn-seeded with the roster', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    await repo.create({ poolNumber: '+1OVERLAP', voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: [T1] });
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: consoleConfig(),
    });

    const result = await svc.provisionForGroup([T1, L1]); // overlaps the only number
    expect(result.provisioned).toBe(true);
    expect(adapter.provisions).toBe(1);
    // The fresh record carries the roster as its burn (create IS the claim).
    expect([...(repo.store.get(result.poolNumber)!.burned_phones as Set<string>)].sort()).toEqual(
      [T1, L1].sort(),
    );
  });

  it('kill-switch guards the FRESH branch only: reuse still works with the flag OFF', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    // A clean twilio-tagged number - reusable even though the flag is OFF.
    await repo.create({ poolNumber: '+1CLEAN', voiceCapable: true, smsCapable: true, provisionedVia: 'twilio', burn: ['+15559990003'] });
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: twilioConfigOff(),
    });

    const result = await svc.provisionForGroup([T1, L1]);
    expect(result).toMatchObject({ poolNumber: '+1CLEAN', provisioned: false });
    expect(adapter.provisions).toBe(0);
  });

  it('kill-switch: a FRESH purchase is refused when relayLiveProvisioning=false (all overlap)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    const provisionSpy = vi.spyOn(adapter, 'provisionPhoneNumber');
    await repo.create({ poolNumber: '+1OVERLAP', voiceCapable: true, smsCapable: true, provisionedVia: 'twilio', burn: [T1] });
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: twilioConfigOff(),
    });

    await expect(svc.provisionForGroup([T1, L1])).rejects.toBeInstanceOf(RelayProvisioningDisabledError);
    expect(provisionSpy).not.toHaveBeenCalled();
  });

  it('a lost race on a clean candidate falls through (here, to a fresh purchase)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    await repo.create({ poolNumber: '+1RACE', voiceCapable: true, smsCapable: true, provisionedVia: 'console', burn: ['+15559990004'] });
    // The clean candidate loses the race exactly ONCE (burnClaim -> undefined),
    // so the ladder falls through to a fresh purchase.
    const realBurnClaim = repo.burnClaim.bind(repo);
    let lostOnce = false;
    repo.burnClaim = async (pn, phones, tag) => {
      if (!lostOnce) {
        lostOnce = true;
        return undefined;
      }
      return realBurnClaim(pn, phones, tag);
    };
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: consoleConfig(),
    });

    const result = await svc.provisionForGroup([T1, L1]);
    expect(result.provisioned).toBe(true); // fell through to fresh
    expect(adapter.provisions).toBe(1);
  });

  it('empty roster throws (never claim an unburnable group)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: consoleConfig(),
    });
    await expect(svc.provisionForGroup([])).rejects.toThrow();
  });

  it('provisions a fresh voice-capable number when the pool is empty (source-tagged)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: consoleConfig(),
    });
    const result = await svc.provisionForGroup([T1, L1], 'fair-2026');
    expect(result.provisioned).toBe(true);
    expect(adapter.provisions).toBe(1);
    const rec = repo.store.get(result.poolNumber)!;
    expect(rec.lifecycle_state).toBe('active');
    expect(rec.provisioned_via).toBe('console');
    expect(rec.placement_tag).toBe('fair-2026');
  });

  it('throws VoiceCapabilityError when a provisioned number lacks voice', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter({ voice: false });
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger, config: consoleConfig(),
    });
    await expect(svc.provisionForGroup([T1])).rejects.toBeInstanceOf(VoiceCapabilityError);
  });

  it('pre-wires the voice webhook when PUBLIC_BASE_URL is configured', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    const setVoice = vi.spyOn(adapter, 'setVoiceWebhook');
    const svc = createPoolNumbersService({
      adapter, poolNumbersRepo: repo, conversationsRepo: makeFakeConversations(), logger,
      config: makeConfig({ publicBaseUrl: 'https://dxxxx.cloudfront.example' }),
    });
    await svc.provisionForGroup([T1]);
    expect(setVoice).toHaveBeenCalledWith(
      expect.stringMatching(/^\+1555/),
      'https://dxxxx.cloudfront.example/webhooks/twilio/voice',
    );
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

  it('adapter failure on one number: it stays active, error logged, the sweep continues', async () => {
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
    expect(repo.store.get('+1FAILS')!.lifecycle_state).toBe('active'); // stayed active
    expect(repo.store.get('+1OK')!.lifecycle_state).toBe('released');
  });
});
