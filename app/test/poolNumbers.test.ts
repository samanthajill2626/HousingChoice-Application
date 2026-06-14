// poolNumbers service (M1.7) — quarantine-reuse collision, lazy reclaim,
// reuse-vs-provision, and voice-capability enforcement. Uses an in-memory
// poolNumbersRepo that mirrors the real lifecycle semantics + a fake adapter
// (deterministic provisioned numbers; never touches Twilio).
import { describe, expect, it, vi } from 'vitest';
import {
  VoiceCapabilityError,
  type MessagingAdapter,
  type ProvisionPhoneNumberResult,
} from '../src/adapters/messaging.js';
import type { AppConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import {
  QUARANTINE_WINDOW_MS,
  type PoolNumberItem,
  type PoolNumbersRepo,
} from '../src/repos/poolNumbersRepo.js';
import {
  createPoolNumbersService,
  RelayProvisioningDisabledError,
} from '../src/services/poolNumbers.js';
import { createLogCapture } from './helpers/logCapture.js';

const logger = createLogger({ destination: createLogCapture().stream });

/** In-memory repo mirroring the real lifecycle + GSI-query semantics. */
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
        lifecycle_state: input.lifecycleState ?? 'available',
        quarantine_until: SENTINEL,
        voice_capable: input.voiceCapable,
        sms_capable: input.smsCapable,
        ...(input.provisionedVia !== undefined && { provisioned_via: input.provisionedVia }),
        provisioned_at: now,
      };
      store.set(item.poolNumber, item);
      return item;
    },
    async findAvailable() {
      for (const item of store.values()) if (item.lifecycle_state === 'available') return item;
      return undefined;
    },
    async claim(poolNumber, conversationId, tag) {
      const item = store.get(poolNumber);
      if (!item || item.lifecycle_state !== 'available') return undefined;
      item.lifecycle_state = 'assigned';
      item.assigned_conversation_id = conversationId;
      item.assigned_at = new Date().toISOString();
      if (tag !== undefined) item.placement_tag = tag;
      return item;
    },
    async reassign(poolNumber, conversationId) {
      const item = store.get(poolNumber);
      if (item && item.lifecycle_state === 'assigned') item.assigned_conversation_id = conversationId;
    },
    async release(poolNumber) {
      const item = store.get(poolNumber);
      if (!item) throw new Error('release: not found');
      const now = Date.now();
      item.lifecycle_state = 'quarantined';
      item.released_at = new Date(now).toISOString();
      item.quarantine_until = new Date(now + QUARANTINE_WINDOW_MS).toISOString();
      delete item.assigned_conversation_id;
      return item;
    },
    async reclaimExpired(now) {
      const cutoff = now.toISOString();
      let reclaimed = 0;
      for (const item of store.values()) {
        if (item.lifecycle_state === 'quarantined' && item.quarantine_until <= cutoff) {
          item.lifecycle_state = 'available';
          item.quarantine_until = SENTINEL;
          reclaimed += 1;
        }
      }
      return reclaimed;
    },
  };
}

function makeFakeAdapter(opts: { voice?: boolean } = {}): MessagingAdapter & { provisions: number } {
  let provisions = 0;
  const adapter: MessagingAdapter & { provisions: number } = {
    get provisions() {
      return provisions;
    },
    async sendMessage() {
      return { providerSid: 'SMx', status: 'queued', providerTs: new Date().toISOString() };
    },
    async getMediaStream() {
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
    async initiateCall() {
      return { callSid: 'CAtest-pool' };
    },
  };
  return adapter;
}

/**
 * Minimal AppConfig for the kill-switch tests — only the two fields
 * provisionForPlacement reads (messagingDriver = source tag, relayLiveProvisioning
 * = kill-switch). Cast through `as AppConfig`: the rest is irrelevant here.
 */
function makeConfig(over: Partial<AppConfig>): AppConfig {
  return { messagingDriver: 'console', relayLiveProvisioning: true, ...over } as AppConfig;
}
/** Console driver, live provisioning on (the local/test default). */
const consoleConfig = (): AppConfig =>
  makeConfig({ messagingDriver: 'console', relayLiveProvisioning: true });
/** Twilio driver with the kill-switch OFF (the deployed pre-A2P default). */
const twilioConfigOff = (): AppConfig =>
  makeConfig({ messagingDriver: 'twilio', relayLiveProvisioning: false });
/** Twilio driver with the kill-switch ON (post-A2P, RELAY_LIVE_PROVISIONING=true). */
const twilioConfigOn = (): AppConfig =>
  makeConfig({ messagingDriver: 'twilio', relayLiveProvisioning: true });

describe('poolNumbers service (M1.7)', () => {
  it('provisions a fresh voice-capable number when the pool is empty', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    const svc = createPoolNumbersService({ adapter, poolNumbersRepo: repo, logger });

    const result = await svc.provisionForPlacement('conv-1', 'fair-2026');
    expect(result.provisioned).toBe(true);
    expect(adapter.provisions).toBe(1);
    const rec = repo.store.get(result.poolNumber)!;
    expect(rec.lifecycle_state).toBe('assigned');
    expect(rec.assigned_conversation_id).toBe('conv-1');
    expect(rec.placement_tag).toBe('fair-2026');
  });

  it('reuses an AVAILABLE number instead of provisioning a fresh one', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    // Source-tag it for the CURRENT (console) driver so the reuse filter matches.
    await repo.create({
      poolNumber: '+15550200001',
      voiceCapable: true,
      smsCapable: true,
      provisionedVia: 'console',
    });
    const svc = createPoolNumbersService({
      adapter,
      poolNumbersRepo: repo,
      logger,
      config: consoleConfig(),
    });

    const result = await svc.provisionForPlacement('conv-1');
    expect(result.provisioned).toBe(false);
    expect(result.poolNumber).toBe('+15550200001');
    expect(adapter.provisions).toBe(0); // never provisioned — reused
  });

  it('quarantine-reuse collision: a released number is NOT reused before 30d (a different number is provisioned)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    const svc = createPoolNumbersService({ adapter, poolNumbersRepo: repo, logger });

    // Acquire, then release to quarantine.
    const first = await svc.provisionForPlacement('conv-1');
    await svc.release(first.poolNumber);
    expect(repo.store.get(first.poolNumber)!.lifecycle_state).toBe('quarantined');

    // A new placement BEFORE the window lapses must NOT reuse the quarantined
    // number — it provisions a fresh, different one.
    const second = await svc.provisionForPlacement('conv-2');
    expect(second.poolNumber).not.toBe(first.poolNumber);
    expect(second.provisioned).toBe(true);
    expect(repo.store.get(first.poolNumber)!.lifecycle_state).toBe('quarantined');
  });

  it('lazy reclaim: after quarantine_until passes, the number CAN be reclaimed and reused', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    // Clock the reclaim cutoff far in the future (past the 30d window).
    const future = () => new Date(Date.now() + QUARANTINE_WINDOW_MS + 60_000);
    const svc = createPoolNumbersService({ adapter, poolNumbersRepo: repo, logger, now: future });

    const first = await svc.provisionForPlacement('conv-1');
    await svc.release(first.poolNumber);

    // Next placement runs lazy reclaim with the future clock → the quarantined
    // number flips back to available and is REUSED (no fresh provision).
    const second = await svc.provisionForPlacement('conv-2');
    expect(second.poolNumber).toBe(first.poolNumber);
    expect(second.provisioned).toBe(false);
    expect(adapter.provisions).toBe(1); // only the original provision
  });

  it('throws VoiceCapabilityError when a provisioned number lacks voice', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter({ voice: false });
    const svc = createPoolNumbersService({ adapter, poolNumbersRepo: repo, logger });
    await expect(svc.provisionForPlacement('conv-1')).rejects.toBeInstanceOf(VoiceCapabilityError);
  });

  it('pre-wires the voice webhook when PUBLIC_BASE_URL is configured', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    const setVoice = vi.spyOn(adapter, 'setVoiceWebhook');
    const svc = createPoolNumbersService({
      adapter,
      poolNumbersRepo: repo,
      logger,
      config: makeConfig({ publicBaseUrl: 'https://dxxxx.cloudfront.example' }),
    });
    await svc.provisionForPlacement('conv-1');
    expect(setVoice).toHaveBeenCalledWith(
      expect.stringMatching(/^\+1555/),
      'https://dxxxx.cloudfront.example/webhooks/twilio/voice',
    );
  });

  // --- M1.7 relay provisioning kill-switch -------------------------------

  it('console driver (default, no env) → provisioning works (existing behavior preserved)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    // No config passed → loadConfig() with the test env (console driver, flag
    // defaults true). The console fake provision must keep working with no env.
    const svc = createPoolNumbersService({ adapter, poolNumbersRepo: repo, logger });
    const result = await svc.provisionForPlacement('conv-1');
    expect(result.provisioned).toBe(true);
    expect(adapter.provisions).toBe(1);
    // Source-tagged 'console' so the live twilio path can never reuse it later.
    expect(repo.store.get(result.poolNumber)!.provisioned_via).toBe('console');
  });

  it('twilio driver + flag OFF (deployed default) → throws RelayProvisioningDisabledError; adapter NEVER purchases', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    const provisionSpy = vi.spyOn(adapter, 'provisionPhoneNumber');
    const svc = createPoolNumbersService({
      adapter,
      poolNumbersRepo: repo,
      logger,
      config: twilioConfigOff(),
    });

    await expect(svc.provisionForPlacement('conv-1')).rejects.toBeInstanceOf(
      RelayProvisioningDisabledError,
    );
    // The purchase is PROVABLY skipped — the adapter was never asked for a number.
    expect(provisionSpy).not.toHaveBeenCalled();
    expect(adapter.provisions).toBe(0);
  });

  it('twilio driver + RELAY_LIVE_PROVISIONING=true → provisioning proceeds (adapter called)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    const provisionSpy = vi.spyOn(adapter, 'provisionPhoneNumber');
    const svc = createPoolNumbersService({
      adapter,
      poolNumbersRepo: repo,
      logger,
      config: twilioConfigOn(),
    });

    const result = await svc.provisionForPlacement('conv-1');
    expect(result.provisioned).toBe(true);
    expect(provisionSpy).toHaveBeenCalledTimes(1);
    // Tagged 'twilio' (real purchase) — never reusable by a console process.
    expect(repo.store.get(result.poolNumber)!.provisioned_via).toBe('twilio');
  });

  it('source isolation: the twilio path does NOT reuse a console-sourced available number (it provisions)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    // A fake console number sitting available in the shared table.
    await repo.create({
      poolNumber: '+15550100001',
      voiceCapable: true,
      smsCapable: true,
      provisionedVia: 'console',
    });
    const svc = createPoolNumbersService({
      adapter,
      poolNumbersRepo: repo,
      logger,
      config: twilioConfigOn(), // twilio driver, flag ON so it may provision
    });

    const result = await svc.provisionForPlacement('conv-1');
    // It did NOT reuse the console fake — a fresh twilio number was provisioned.
    expect(result.poolNumber).not.toBe('+15550100001');
    expect(result.provisioned).toBe(true);
    expect(adapter.provisions).toBe(1);
    expect(repo.store.get(result.poolNumber)!.provisioned_via).toBe('twilio');
    // The console fake is still available — never claimed by the live path.
    expect(repo.store.get('+15550100001')!.lifecycle_state).toBe('available');
  });

  it('source isolation (reverse): the console path does NOT reuse a twilio-sourced available number', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    await repo.create({
      poolNumber: '+15550100002',
      voiceCapable: true,
      smsCapable: true,
      provisionedVia: 'twilio',
    });
    const svc = createPoolNumbersService({
      adapter,
      poolNumbersRepo: repo,
      logger,
      config: consoleConfig(),
    });

    const result = await svc.provisionForPlacement('conv-1');
    expect(result.poolNumber).not.toBe('+15550100002');
    expect(result.provisioned).toBe(true);
    expect(repo.store.get('+15550100002')!.lifecycle_state).toBe('available');
  });

  it('explicit flag OFF on the console driver → refuses (the override beats the default)', async () => {
    const repo = makeFakeRepo();
    const adapter = makeFakeAdapter();
    const provisionSpy = vi.spyOn(adapter, 'provisionPhoneNumber');
    const svc = createPoolNumbersService({
      adapter,
      poolNumbersRepo: repo,
      logger,
      config: makeConfig({ messagingDriver: 'console', relayLiveProvisioning: false }),
    });

    await expect(svc.provisionForPlacement('conv-1')).rejects.toBeInstanceOf(
      RelayProvisioningDisabledError,
    );
    expect(provisionSpy).not.toHaveBeenCalled();
  });
});
