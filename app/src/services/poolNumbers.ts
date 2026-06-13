// poolNumbers service (M1.7) — provision/release relay-group pool numbers,
// sitting between the API routes and the repo + messaging adapter.
//
// provisionForPlacement():
//   (a) LAZY RECLAIM first — flip any quarantined numbers whose window lapsed
//       back to available (cheap GSI sweep; keeps the pool from starving
//       without a separate cron).
//   (b) try to CLAIM an already-available number (race-safe at the repo).
//   (c) else PROVISION a fresh one through the adapter — REQUIRE voice
//       capability (M1.9 masked calling rides the same number), persist it as
//       assigned, and pre-wire its voice webhook.
//
// release(): hand a number to a 30-day quarantine (carriers recycle freed
// numbers; a prior conversant might still text it — see the repo header). A
// quarantined number is NOT reusable until quarantine_until passes, so a
// re-provision before then gets a DIFFERENT/new number (the quarantine-reuse
// collision guard).
//
// PII: a phone number is PII (doc §9) — log states/counts/SIDs only.
import { loadConfig, type AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  createMessagingAdapter,
  VoiceCapabilityError,
  type MessagingAdapter,
} from '../adapters/messaging.js';
import {
  createPoolNumbersRepo,
  type PoolNumberItem,
  type PoolNumbersRepo,
} from '../repos/poolNumbersRepo.js';

/** Voice webhook the relay pool number is pre-wired to (M1.9 bridge seam). */
const VOICE_WEBHOOK_PATH = '/webhooks/twilio/voice';

export interface PoolNumbersServiceDeps {
  config?: AppConfig;
  logger?: Logger;
  adapter?: MessagingAdapter;
  poolNumbersRepo?: PoolNumbersRepo;
  /** Injectable clock for the lazy-reclaim cutoff (tests). */
  now?: () => Date;
}

export interface ProvisionForPlacementResult {
  poolNumber: string;
  record: PoolNumberItem;
  /** True when a fresh number was purchased; false when an available one was reused. */
  provisioned: boolean;
}

export interface PoolNumbersService {
  /**
   * Acquire a voice+sms-capable pool number for a relay placement, assigned to
   * `conversationId`. Reclaims expired quarantine, reuses an available number
   * if any, else provisions a fresh one. Throws VoiceCapabilityError when a
   * fresh number cannot be made voice-capable.
   */
  provisionForPlacement(
    conversationId: string,
    tag?: string,
  ): Promise<ProvisionForPlacementResult>;
  /**
   * Point an assigned pool number at its real conversation id (create flow):
   * provisionForPlacement claims under a provisional id before the
   * conversation exists; this stamps the real id once it does.
   */
  assignConversation(poolNumber: string, conversationId: string): Promise<void>;
  /** Release a number to quarantine (relay closed). Returns the updated record. */
  release(poolNumber: string): Promise<PoolNumberItem>;
}

export function createPoolNumbersService(deps: PoolNumbersServiceDeps = {}): PoolNumbersService {
  const config = deps.config ?? loadConfig();
  const log = deps.logger ?? defaultLogger;
  const adapter = deps.adapter ?? createMessagingAdapter({ config, logger: deps.logger });
  const repo = deps.poolNumbersRepo ?? createPoolNumbersRepo({ logger: deps.logger });
  const now = deps.now ?? (() => new Date());

  return {
    async provisionForPlacement(conversationId, tag) {
      // (a) Lazy reclaim — never let quarantine starve the pool silently.
      await repo.reclaimExpired(now());

      // (b) Reuse an available number when one exists (race-safe claim). The
      // GSI read is just a candidate; claim() is the arbiter — if we lose the
      // race we fall through to provisioning a fresh number (never reuse a
      // quarantined one; findAvailable only returns 'available').
      const candidate = await repo.findAvailable();
      if (candidate) {
        const claimed = await repo.claim(candidate.poolNumber, conversationId, tag);
        if (claimed) {
          log.info({ conversationId, provisioned: false }, 'relay pool number acquired (reused)');
          return { poolNumber: claimed.poolNumber, record: claimed, provisioned: false };
        }
      }

      // (c) Provision fresh. REQUIRE voice — a misconfigured account/exhausted
      // inventory must fail HERE (provision time), not at M1.9 call time.
      const provisioned = await adapter.provisionPhoneNumber({ voiceCapable: true });
      if (!provisioned.capabilities.voice) {
        throw new VoiceCapabilityError(
          `provisionForPlacement: provisioned ${provisioned.sid} lacks voice capability`,
        );
      }

      // Persist as assigned (skip the available→claim hop — we own it already).
      await repo.create({
        poolNumber: provisioned.phoneNumber,
        voiceCapable: provisioned.capabilities.voice,
        smsCapable: provisioned.capabilities.sms,
        lifecycleState: 'available',
      });
      const claimed = await repo.claim(provisioned.phoneNumber, conversationId, tag);
      if (!claimed) {
        // The number we just created should be claimable — a failure here is
        // a real anomaly (a duplicate provision under the same number).
        throw new Error(
          `provisionForPlacement: freshly provisioned number could not be claimed (${provisioned.sid})`,
        );
      }

      // Pre-wire the voice webhook (M1.9). Real driver sets VoiceUrl; console
      // driver logs a no-op. Best-effort: a wiring failure must not strand the
      // claimed number — log and continue (M1.9 re-wires before going live).
      if (config.publicBaseUrl) {
        try {
          await adapter.setVoiceWebhook(
            provisioned.phoneNumber,
            `${config.publicBaseUrl}${VOICE_WEBHOOK_PATH}`,
          );
        } catch (err) {
          log.error({ err, conversationId }, 'relay pool number voice webhook wiring failed');
        }
      }

      log.info({ conversationId, provisioned: true }, 'relay pool number acquired (provisioned)');
      return { poolNumber: claimed.poolNumber, record: claimed, provisioned: true };
    },

    async assignConversation(poolNumber, conversationId) {
      await repo.reassign(poolNumber, conversationId);
    },

    async release(poolNumber) {
      const released = await repo.release(poolNumber);
      log.info({ lifecycleState: released.lifecycle_state }, 'relay pool number released');
      return released;
    },
  };
}
