// poolNumbers service (M1.7, burn-multiplexing revision) - provision + retire
// relay-group pool numbers, sitting between the API routes and the repo +
// messaging adapter.
//
// provisionForGroup(rosterPhones):
//   (a) LAZY RETIREMENT sweep first (the seat the quarantine reclaim used to
//       hold) - config-gated, fire-and-forget.
//   (b) REUSE: burn-as-claim onto the first active same-driver number whose burn
//       does not overlap the roster (repo.burnClaim is the atomic arbiter).
//   (c) else PROVISION a fresh one through the adapter - REQUIRE voice
//       capability (M1.9 masked calling rides the same number), create its
//       record with burned_phones = roster (create IS the claim), pre-wire its
//       voice webhook.
//
// retireEligible(): release every active number with ZERO open groups whose
// newest group closed more than RELEASE_GRACE_MS ago (drop it at Twilio, then
// mark released). Gated behind relayNumberReleaseEnabled (off everywhere by
// default). noteGroupClosed() stamps the retirement clock on close.
//
// PII: a phone number is PII (doc section 9) - log states/counts/SIDs only.
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
  createConversationsRepo,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import {
  createPoolNumbersRepo,
  RELEASE_GRACE_MS,
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
 * `npm run dev` and collides with leftover numbers in the shared dev table -
 * generous enough to step past those, then a clear throw.
 */
const MAX_PROVISION_ATTEMPTS = 20;

/**
 * Thrown by provisionForGroup when obtaining a NEW pool number would be
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
  /** Retirement sweep needs getAllByPoolNumber (the live open-group veto). */
  conversationsRepo?: ConversationsRepo;
  /** Injectable clock for the retirement grace cutoff (tests). */
  now?: () => Date;
}

export interface ProvisionForGroupResult {
  poolNumber: string;
  record: PoolNumberItem;
  /** True when a fresh number was purchased; false when an active one was reused. */
  provisioned: boolean;
}

export interface PoolNumbersService {
  /**
   * Acquire a voice+sms-capable pool number for a relay GROUP via burn-as-claim:
   * a lazy retirement sweep, then reuse the first active same-driver number whose
   * burn does not overlap `rosterPhones`, else provision a fresh one (seeded with
   * the roster burn). `rosterPhones` = every member phone of the NEW group; MUST
   * be non-empty. Throws VoiceCapabilityError when a fresh number cannot be made
   * voice-capable, RelayProvisioningDisabledError when a fresh purchase is needed
   * but the kill-switch is off.
   */
  provisionForGroup(rosterPhones: string[], tag?: string): Promise<ProvisionForGroupResult>;
  /** Stamp a group-close time onto the number (the retirement clock). */
  noteGroupClosed(poolNumber: string, closedAt: string): Promise<void>;
  /**
   * Read the pool record (thin repo.get passthrough). Used by the reopen route
   * (AF-3) to refuse reopening a group onto a number that retirement RELEASED -
   * a pure status flip would otherwise mint a zombie open group on a number we
   * no longer own at Twilio. Returns undefined when no record exists.
   */
  getRecord(poolNumber: string): Promise<PoolNumberItem | undefined>;
  /**
   * Release-eligibility sweep (config-gated by relayNumberReleaseEnabled).
   * Releases every active number with zero open groups whose newest group closed
   * more than RELEASE_GRACE_MS ago. Returns the numbers released. Also exposed
   * for the ops script.
   */
  retireEligible(): Promise<string[]>;
}

/** True if any roster phone is already in the number's burn set (Set or array). */
function rosterOverlapsBurn(
  roster: string[],
  burned: Set<string> | string[] | undefined,
): boolean {
  if (burned === undefined) return false;
  const set = burned instanceof Set ? burned : new Set(burned);
  return roster.some((p) => set.has(p));
}

export function createPoolNumbersService(deps: PoolNumbersServiceDeps = {}): PoolNumbersService {
  const config = deps.config ?? loadConfig();
  const log = deps.logger ?? defaultLogger;
  const adapter = deps.adapter ?? createMessagingAdapter({ config, logger: deps.logger });
  const repo = deps.poolNumbersRepo ?? createPoolNumbersRepo({ logger: deps.logger });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const now = deps.now ?? (() => new Date());

  // The driver that owns THIS process - the source tag stamped on numbers we
  // provision and the filter the reuse path matches against (kill-switch source
  // isolation). Local/test = console (fake $0 numbers), deployed = twilio (real
  // purchases); the two must never reuse each other's numbers (the shared dev
  // table holds both).
  const currentVia = config.messagingDriver; // 'console' | 'twilio'

  // Release-eligibility sweep (D7). Config-gated; returns the numbers released.
  // Defined before the return so the lazy sweep in provisionForGroup can call it
  // without `this`.
  async function retireEligible(): Promise<string[]> {
    if (!config.relayNumberReleaseEnabled) return [];
    const cutoff = now().getTime() - RELEASE_GRACE_MS;
    const released: string[] = [];
    for (const record of await repo.listActive()) {
      // Must have hosted a group AND that newest close is past the grace window.
      const closedAt = record.last_group_closed_at;
      if (closedAt === undefined || Date.parse(closedAt) > cutoff) continue;
      // Live veto: never release a number still fronting an OPEN group, and never
      // release one with zero groups (a fresh unused number caught by timestamps).
      const groups = await conversations.getAllByPoolNumber(record.poolNumber);
      if (groups.length === 0 || groups.some((g) => g.status === 'open')) continue;
      // Drop it at Twilio FIRST; if that fails the number STAYS active (logged,
      // sweep continues) so we never mark released a number Twilio still owns.
      try {
        await adapter.releasePhoneNumber(record.poolNumber);
      } catch (err) {
        log.error({ err }, 'relay retirement: releasePhoneNumber failed - number stays active');
        continue;
      }
      const releasedRec = await repo.releaseNumber(record.poolNumber);
      if (releasedRec !== undefined) released.push(record.poolNumber);
    }
    if (released.length > 0) {
      log.info({ releasedCount: released.length }, 'relay pool numbers retired');
    }
    return released;
  }

  return {
    async provisionForGroup(rosterPhones, tag) {
      // Never claim an unburnable (empty-roster) group - it would match every
      // number's burn guard vacuously.
      if (rosterPhones.length === 0) {
        throw new Error('provisionForGroup: rosterPhones must be non-empty');
      }

      // (a) Lazy retirement sweep - the seat the quarantine reclaim used to hold.
      // Fire-and-forget: a release failure (or the whole sweep) must never block a
      // fresh provision. No-ops silently when the config gate is off.
      void retireEligible().catch((err) => {
        log.error({ err }, 'lazy retirement sweep failed (non-fatal)');
      });

      // (b) Reuse: burn-as-claim onto the FIRST active same-driver number whose
      // burn does not overlap this roster. repo.burnClaim is the atomic arbiter
      // (an overlapping or lost-race candidate fails its condition and we try the
      // next). SOURCE ISOLATION (M1.7 kill-switch): only reuse a number our
      // CURRENT driver obtained - the live twilio path must never reuse a fake
      // console number (and vice-versa), even though both live in the shared dev
      // table.
      const candidates = (await repo.listActive()).filter(
        (c) => c.provisioned_via === currentVia,
      );
      for (const candidate of candidates) {
        // Cheap in-code pre-filter: skip an obviously-overlapping number without a
        // conditional write (burnClaim still enforces the invariant atomically).
        if (rosterOverlapsBurn(rosterPhones, candidate.burned_phones)) continue;
        const claimed = await repo.burnClaim(candidate.poolNumber, rosterPhones, tag);
        if (claimed) {
          log.info({ provisioned: false }, 'relay pool number acquired (reused)');
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
      // back a number that ALREADY has a pool_numbers record - create()'s
      // attribute_not_exists(poolNumber) guard then throws
      // ConditionalCheckFailedException; try the NEXT number. (Local console
      // driver: its per-process counter restarts each `npm run dev` and collides
      // with leftover numbers in the shared dev table. Production: a purchased
      // number is globally unique, so create never collides and this runs once.)
      // REQUIRE voice on each candidate - a misconfigured account/exhausted
      // inventory must fail HERE (provision time), not at M1.9 call time. The
      // fresh record is created with burned_phones = rosterPhones, so create IS
      // the claim (no separate burnClaim call).
      let provisioned: ProvisionPhoneNumberResult | undefined;
      let record: PoolNumberItem | undefined;
      for (let attempt = 1; attempt <= MAX_PROVISION_ATTEMPTS; attempt += 1) {
        const candidate = await adapter.provisionPhoneNumber({ voiceCapable: true });
        if (!candidate.capabilities.voice) {
          throw new VoiceCapabilityError(
            `provisionForGroup: provisioned ${candidate.sid} lacks voice capability`,
          );
        }
        try {
          // Create as ACTIVE + source-tag with the current driver, seeding
          // burned_phones from the roster - the create IS the burn-claim.
          record = await repo.create({
            poolNumber: candidate.phoneNumber,
            voiceCapable: candidate.capabilities.voice,
            smsCapable: candidate.capabilities.sms,
            provisionedVia: currentVia,
            burn: rosterPhones,
            ...(tag !== undefined && { tag }),
          });
          provisioned = candidate;
          break;
        } catch (err) {
          if (err instanceof ConditionalCheckFailedException) {
            // The number already has a record (collision) - try the next one.
            log.warn(
              { attempt },
              'provisioned number already in the pool - retrying with a fresh number',
            );
            continue;
          }
          throw err;
        }
      }
      if (provisioned === undefined || record === undefined) {
        throw new Error(
          `provisionForGroup: could not obtain a free pool number after ${MAX_PROVISION_ATTEMPTS} attempts`,
        );
      }

      // Pre-wire the voice webhook (M1.9). Real driver sets VoiceUrl; console
      // driver logs a no-op. Best-effort: a wiring failure must not strand the
      // claimed number - log and continue (M1.9 re-wires before going live).
      if (config.publicBaseUrl) {
        try {
          await adapter.setVoiceWebhook(
            provisioned.phoneNumber,
            `${config.publicBaseUrl}${VOICE_WEBHOOK_PATH}`,
          );
        } catch (err) {
          log.error({ err }, 'relay pool number voice webhook wiring failed');
        }
      }

      log.info({ provisioned: true }, 'relay pool number acquired (provisioned)');
      return { poolNumber: record.poolNumber, record, provisioned: true };
    },

    async noteGroupClosed(poolNumber, closedAt) {
      await repo.noteGroupClosed(poolNumber, closedAt);
    },

    async getRecord(poolNumber) {
      return repo.get(poolNumber);
    },

    retireEligible,
  };
}
