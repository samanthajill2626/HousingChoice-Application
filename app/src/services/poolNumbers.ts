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
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  createMessagingAdapter,
  VoiceCapabilityError,
  type MessagingAdapter,
  type ProvisionPhoneNumberResult,
} from '../adapters/messaging.js';
import {
  createPoolNumbersRepo,
  type PoolNumberItem,
  type PoolNumbersRepo,
} from '../repos/poolNumbersRepo.js';

/** Voice webhook the relay pool number is pre-wired to (M1.9 bridge seam). */
const VOICE_WEBHOOK_PATH = '/webhooks/twilio/voice';

/**
 * Bounded retries when a freshly-provisioned number collides with an existing
 * pool_numbers record (create's attribute_not_exists guard fires). In production
 * a purchased number is globally unique so this never loops; the cap only bites
 * locally, where the console driver's per-process counter restarts each
 * `npm run dev` and collides with leftover assigned/quarantined numbers in the
 * shared dev table — generous enough to step past those, then a clear throw.
 */
const MAX_PROVISION_ATTEMPTS = 20;

/**
 * Thrown by provisionForPlacement when obtaining a NEW pool number would be
 * required but the relay number-provisioning kill-switch is off
 * (config.relayLiveProvisioning === false). Raised BEFORE any
 * adapter.provisionPhoneNumber call, so the deployed twilio driver can never
 * accidentally PURCHASE a real number before A2P approval / an explicit
 * RELAY_LIVE_PROVISIONING=true decision. The message is actionable and PII-free.
 */
export class RelayProvisioningDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

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

  // The driver that owns THIS process — the source tag stamped on numbers we
  // provision and the filter the reuse path matches against (kill-switch source
  // isolation). Local/test = console (fake $0 numbers), deployed = twilio (real
  // purchases); the two must never reuse each other's numbers (the shared dev
  // table holds both).
  const currentVia = config.messagingDriver; // 'console' | 'twilio'

  return {
    async provisionForPlacement(conversationId, tag) {
      // (a) Lazy reclaim — never let quarantine starve the pool silently.
      await repo.reclaimExpired(now());

      // (b) Reuse an available number when one exists (race-safe claim). The
      // GSI read is just a candidate; claim() is the arbiter — if we lose the
      // race we fall through to provisioning a fresh number (never reuse a
      // quarantined one; findAvailable only returns 'available'). SOURCE
      // ISOLATION (M1.7 kill-switch): only reuse a number our CURRENT driver
      // obtained — the live twilio path must never reuse a fake console number
      // (and vice-versa), even though both live in the shared dev table.
      const candidate = await repo.findAvailable();
      if (candidate && candidate.provisioned_via === currentVia) {
        const claimed = await repo.claim(candidate.poolNumber, conversationId, tag);
        if (claimed) {
          log.info({ conversationId, provisioned: false }, 'relay pool number acquired (reused)');
          return { poolNumber: claimed.poolNumber, record: claimed, provisioned: false };
        }
      }

      // Obtaining a NEW number is required. KILL-SWITCH (M1.7): when relay live
      // provisioning is off (default when deployed/twilio), refuse BEFORE the
      // adapter call so no real number is ever PURCHASED pre-A2P. Strict: we do
      // not fall back to reusing anything here (the matching-source reuse above
      // already failed) — deployed pre-A2P relay creation fails cleanly with an
      // actionable error.
      if (!config.relayLiveProvisioning) {
        throw new RelayProvisioningDisabledError(
          'relay number provisioning is disabled in this environment — set ' +
            'RELAY_LIVE_PROVISIONING=true after A2P approval to enable buying a pool number',
        );
      }

      // (c) Provision fresh, RETRYING on a number collision. The adapter can hand
      // back a number that ALREADY has a pool_numbers record — create()'s
      // attribute_not_exists(poolNumber) guard then throws
      // ConditionalCheckFailedException. That used to bubble to a 500; instead we
      // try the NEXT number. (Local console driver: its per-process counter
      // restarts each `npm run dev` and collides with leftover assigned/
      // quarantined numbers in the shared dev table. Production: a purchased
      // number is globally unique, so create never collides and this runs once.)
      // REQUIRE voice on each candidate — a misconfigured account/exhausted
      // inventory must fail HERE (provision time), not at M1.9 call time.
      let provisioned: ProvisionPhoneNumberResult | undefined;
      for (let attempt = 1; attempt <= MAX_PROVISION_ATTEMPTS; attempt += 1) {
        const candidate = await adapter.provisionPhoneNumber({ voiceCapable: true });
        if (!candidate.capabilities.voice) {
          throw new VoiceCapabilityError(
            `provisionForPlacement: provisioned ${candidate.sid} lacks voice capability`,
          );
        }
        try {
          // Persist as available + source-tag with the current driver (kill-switch
          // source isolation); the claim below flips it to assigned.
          await repo.create({
            poolNumber: candidate.phoneNumber,
            voiceCapable: candidate.capabilities.voice,
            smsCapable: candidate.capabilities.sms,
            lifecycleState: 'available',
            provisionedVia: currentVia,
          });
          provisioned = candidate;
          break;
        } catch (err) {
          if (err instanceof ConditionalCheckFailedException) {
            // The number already has a record (collision) — try the next one.
            log.warn(
              { conversationId, attempt },
              'provisioned number already in the pool — retrying with a fresh number',
            );
            continue;
          }
          throw err;
        }
      }
      if (provisioned === undefined) {
        throw new Error(
          `provisionForPlacement: could not obtain a free pool number after ${MAX_PROVISION_ATTEMPTS} attempts`,
        );
      }
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
