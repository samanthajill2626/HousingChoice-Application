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
// newest group closed more than RELEASE_GRACE_MS ago. W2 TOCTOU fence per
// candidate: CLAIM active->releasing (fences burnClaim + reopen), RE-VERIFY zero
// open groups with a fresh read (abort->active if any), drop at Twilio (abort on
// failure), then FINALIZE releasing->released. Gated behind
// relayNumberReleaseEnabled (off everywhere by default). noteGroupClosed()
// stamps the retirement clock on close.
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
import { enqueueImmediate } from '../jobs/jobs.js';

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

/**
 * Job name for the connect-when-ready hand-off (D6). A warming number that was
 * earmarked to a connecting group enqueues THIS job on promotion; the handler is
 * registered in a later slice (T6) - dormant until a connecting group tags a
 * warming record, so no orphan jobs land before then. Deliberately a JOB, NOT an
 * appEvents bus event (that bus is SSE-facing / a closed typed union).
 */
export const RELAY_NUMBER_READY_JOB = 'relay.numberReady';

/**
 * Job name for warming ONE pool number (relay number buying strategy T4). The
 * buffer refill (refillBufferIfNeeded) enqueues it per missing spare; the
 * connect-when-ready path (T6) enqueues it tagged with a conversationId. Its
 * handler (registerRelayWarmJobHandler in jobs/relayWarm.ts) dispatches back to
 * warmOneNumber. Defined HERE (the producing service), NOT in the job module, so
 * refillBufferIfNeeded can reference it without a service<->job import cycle -
 * mirroring RELAY_NUMBER_READY_JOB above.
 */
export const RELAY_WARM_JOB = 'relay.warmNumber';

/** Input to onNumberRegistered - the Event Streams registration webhook (T3). */
export interface OnNumberRegisteredInput {
  /** The registered number's Twilio PN SID - the D2 correlation key. */
  phoneNumberSid: string;
  /**
   * The registered number, digits-only / non-E.164 (D1). Informational only -
   * correlation is by SID, never this fragile string. Optional.
   */
  phoneNumber?: string;
  /** The Messaging Service the number registered under (MG...) - sanity-checked. */
  messagingServiceSid?: string;
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
   * Burn ONE additional member phone onto an existing group's pool number - the
   * add-member claim (W1). A thin single-phone repo.burnClaim: returns true when
   * the burn succeeded (the phone was free on this number), false when it
   * conflicts (already burned here by another group, so the add must be refused
   * to keep (To,From) routing unique and block future reuse). Never mutates on a
   * conflict (atomic conditional ADD).
   */
  burnMember(poolNumber: string, phone: string): Promise<boolean>;
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
  /**
   * Buy ONE pool number and park it WARMING until the Event Streams registration
   * event promotes it (T4). Gated by relayLiveProvisioning (throws
   * RelayProvisioningDisabledError when off, like provisionForGroup's fresh-buy
   * guard - no real number is purchased pre-A2P). Order: provision (REQUIRE voice,
   * like the group buy) -> repo.createWarming (persist as warming + the PN sid,
   * the D2 correlation key, + the connect-when-ready earmark when conversationId is
   * given) -> adapter.attachToMessagingService(sid) (start A2P registration). The
   * voice webhook is pre-wired exactly as the group buy does (M1.9). NOT promoted
   * here - promotion is solely the registration event.
   */
  warmOneNumber(conversationId?: string): Promise<void>;
  /**
   * Top the spare buffer up to relaySpareBufferTarget (T4). have =
   * countFreshSpares() + countWarming() (WARMING counts, so an in-flight warm is
   * never double-bought - the debounce); need = max(0, target - have); enqueues
   * that many RELAY_WARM_JOB jobs. Target 0 (dev) enqueues nothing. Wiring this
   * after provisionForGroup is deferred to T5; here it is a standalone method.
   */
  refillBufferIfNeeded(): Promise<void>;
  /**
   * Stuck-warming ALERT sweep (T4): log.error for every warming record whose
   * warming_started_at is older than relayWarmingMaxWaitMs (the registration event
   * never arrived). ALERT ONLY - it NEVER promotes (promotion is solely the
   * registration event). Fresh warming records are skipped. PII (doc section 9):
   * logs the SID (the correlation key an operator acts on), never the pool number.
   */
  flagStuckWarming(): Promise<void>;
  /**
   * Event Streams registration callback (T3): the number identified by its PN
   * SID has been A2P 10DLC-registered. Correlate by SID (D2): findWarmingBySid ->
   * promoteToActive (the SOLE warming->active promotion). When the pre-promote
   * record carried a pending_conversation_id (connect-when-ready earmark), enqueue
   * the RELAY_NUMBER_READY_JOB (D6) so a later slice opens the connecting group.
   * No-op when the SID matches no warming record (unknown / already promoted -
   * idempotent for a redelivered event). Only a genuine store error throws (the
   * webhook maps that to a retry); a queue-enqueue failure is logged, not fatal.
   */
  onNumberRegistered(input: OnNumberRegisteredInput): Promise<void>;
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
  // Roll a claimed number back to service (releasing -> active). If the abort
  // ITSELF fails the number is stuck 'releasing' - HARMLESS to routing (an open
  // group's number is never a candidate; a stuck number just can't be reused or
  // released until manual attention). Log LOUDLY (RUNBOOK has the operator
  // remedy). PII: reason/state only, never the number.
  async function abortRelease(poolNumber: string, reason: string): Promise<void> {
    const back = await repo.abortRelease(poolNumber);
    if (back === undefined) {
      log.error(
        { reason },
        'relay retirement: abortRelease FAILED - number stuck in releasing (manual attention needed)',
      );
    } else {
      log.info({ reason }, 'relay retirement: release aborted - number back in service');
    }
  }

  async function retireEligible(): Promise<string[]> {
    if (!config.relayNumberReleaseEnabled) return [];
    const cutoff = now().getTime() - RELEASE_GRACE_MS;
    const released: string[] = [];
    for (const record of await repo.listActive()) {
      // Must have hosted a group AND that newest close is past the grace window.
      const closedAt = record.last_group_closed_at;
      // W4: a corrupt / unparseable last_group_closed_at parses to NaN, and
      // `NaN > cutoff` is false - so the grace check below would WRONGLY fall
      // through and release the number, treating "unknown close time" as
      // infinitely past grace. Skip it as NOT eligible (the admin page's retire
      // mirror guards NaN the same way, so page and sweep stay in parity). PII:
      // log neither the number nor any phone - only that the stamp was unparseable.
      if (closedAt !== undefined && Number.isNaN(Date.parse(closedAt))) {
        log.error(
          { hasParseableCloseStamp: false },
          'relay retirement: unparseable last_group_closed_at - skipping (corrupt stamp)',
        );
        continue;
      }
      if (closedAt === undefined || Date.parse(closedAt) > cutoff) continue;
      // Cheap PRE-veto (skip obviously-live numbers without claim/abort churn);
      // the AUTHORITATIVE veto is the post-claim re-verify below.
      const groups = await conversations.getAllByPoolNumber(record.poolNumber);
      if (groups.length === 0 || groups.some((g) => g.status === 'open')) continue;

      // (1) CLAIM active -> releasing (W2 TOCTOU fence). From here burnClaim
      // refuses this number and listActive skips it, so no NEW group can land
      // while we hand it back; the reopen guard (lifecycle_state !== 'active')
      // also refuses a reopen. A lost claim (concurrent state change) -> skip.
      const claimed = await repo.beginRelease(record.poolNumber);
      if (claimed === undefined) continue;

      // (2) RE-VERIFY with a FRESH read: a group may have opened between the
      // pre-veto and the claim. Any open (or now zero groups) -> abort + skip,
      // and the adapter is NEVER called for it.
      const fresh = await conversations.getAllByPoolNumber(record.poolNumber);
      if (fresh.length === 0 || fresh.some((g) => g.status === 'open')) {
        await abortRelease(record.poolNumber, 'open group found on re-verify');
        continue;
      }

      // (3) Drop it at Twilio. On failure ABORT back to active (matches the
      // existing adapter-failure contract - the number stays fully reusable) and
      // continue; we never mark released a number Twilio still owns.
      try {
        await adapter.releasePhoneNumber(record.poolNumber);
      } catch (err) {
        log.error({ err }, 'relay retirement: releasePhoneNumber failed - aborting release');
        await abortRelease(record.poolNumber, 'adapter release failed');
        continue;
      }

      // (4) FINALIZE releasing -> released.
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

    async burnMember(poolNumber, phone) {
      // The add-member claim (W1): burn ONE phone onto this group's number. The
      // repo's conditional ADD is the atomic arbiter - undefined => the phone is
      // already burned here (another group's history), so the add is refused.
      const claimed = await repo.burnClaim(poolNumber, [phone]);
      return claimed !== undefined;
    },

    async getRecord(poolNumber) {
      return repo.get(poolNumber);
    },

    async onNumberRegistered({ phoneNumberSid, messagingServiceSid }) {
      // Correlate by PN SID (D2), never the (non-E.164) phone string. The warming
      // set is tiny (K spares + any connecting numbers), so a listWarming scan is
      // cheap. An unknown SID or an already-promoted number (a redelivered event -
      // findWarmingBySid only matches lifecycle_state 'warming') is an idempotent
      // no-op. PII: log the outcome only, never the SID/number.
      const record = await repo.findWarmingBySid(phoneNumberSid);
      if (record === undefined) {
        log.info(
          { event: 'relay_register_no_match' },
          'relay registration event: no warming record for this SID - ignoring (unknown or already promoted)',
        );
        return;
      }
      // Sanity: a registration under a DIFFERENT messaging service than the one we
      // attach warming numbers to is surprising (a misrouted sink). Warn but still
      // promote - the SID matched a warming record WE created, so the number is
      // ours regardless. Only checked when both sides are known.
      if (
        messagingServiceSid !== undefined &&
        config.twilioMessagingServiceSid !== undefined &&
        messagingServiceSid !== config.twilioMessagingServiceSid
      ) {
        log.warn(
          { event: 'relay_register_service_mismatch' },
          'relay registration event messaging service does not match the configured service - promoting anyway',
        );
      }
      // pending_conversation_id survives the promote (repo contract), but read it
      // from the pre-promote record so the earmark is captured before any mutate.
      const pendingConversationId = record.pending_conversation_id;
      // The SOLE warming->active promotion. Conditional + idempotent: a concurrent
      // event that already promoted returns false, and we then skip the enqueue so
      // relay.numberReady is emitted exactly once (the winner emits it).
      const promoted = await repo.promoteToActive(record.poolNumber);
      log.info(
        { event: 'relay_number_promoted', promoted },
        'relay pool number registration event processed (warming -> active)',
      );

      // Connect-when-ready hand-off (D6): signal readiness via the JOB queue (NOT
      // the SSE-facing appEvents bus). Best-effort like the intro enqueue - a queue
      // hiccup must not undo the durable promote; T6's stuck-connecting alert
      // reconciles a lost signal. Dormant until a connecting group tags a warming
      // record (T6), so this branch does not fire in this slice's normal flow.
      if (promoted && pendingConversationId !== undefined) {
        try {
          await enqueueImmediate(RELAY_NUMBER_READY_JOB, {
            conversationId: pendingConversationId,
            poolNumber: record.poolNumber,
          });
        } catch (err) {
          log.error(
            { err, event: 'relay_number_ready_enqueue_failed' },
            'relay.numberReady enqueue failed - connecting group stays pending until reconciled',
          );
        }
      }
    },

    async warmOneNumber(conversationId) {
      // KILL-SWITCH (M1.7): warming a spare BUYS a real number, so refuse BEFORE
      // the adapter call when relay live provisioning is off - the identical guard
      // provisionForGroup's fresh-buy branch uses, so a deployed stack never
      // purchases a number pre-A2P.
      if (!config.relayLiveProvisioning) {
        throw new RelayProvisioningDisabledError(
          'relay number provisioning is disabled in this environment - set ' +
            'RELAY_LIVE_PROVISIONING=true after A2P approval to enable warming a pool number',
        );
      }

      // Buy a voice+sms-capable number, RETRYING on a pool collision exactly like
      // provisionForGroup's fresh block (createWarming's attribute_not_exists guard
      // can fire locally against the shared dev table; a purchased number is
      // globally unique in prod so this runs once). REQUIRE voice on each candidate
      // (M1.9 masked calling rides the same number) - a misconfigured account fails
      // HERE, not at call time. Persist WARMING (NOT active) with the PN sid (D2
      // correlation key) + the connect-when-ready earmark; the number is NOT a
      // usable pool number until the registration event promotes it.
      let candidate: ProvisionPhoneNumberResult | undefined;
      for (let attempt = 1; attempt <= MAX_PROVISION_ATTEMPTS; attempt += 1) {
        const bought = await adapter.provisionPhoneNumber({ voiceCapable: true });
        if (!bought.capabilities.voice) {
          throw new VoiceCapabilityError(
            `warmOneNumber: provisioned ${bought.sid} lacks voice capability`,
          );
        }
        try {
          await repo.createWarming({
            poolNumber: bought.phoneNumber,
            sid: bought.sid,
            voiceCapable: bought.capabilities.voice,
            smsCapable: bought.capabilities.sms,
            provisionedVia: currentVia,
            ...(conversationId !== undefined && { conversationId }),
          });
          candidate = bought;
          break;
        } catch (err) {
          if (err instanceof ConditionalCheckFailedException) {
            log.warn(
              { attempt },
              'warmed number already in the pool - retrying with a fresh number',
            );
            continue;
          }
          throw err;
        }
      }
      if (candidate === undefined) {
        throw new Error(
          `warmOneNumber: could not obtain a free pool number after ${MAX_PROVISION_ATTEMPTS} attempts`,
        );
      }

      // Attach to the A2P messaging service so Twilio begins registering it (the
      // event that later promotes it fires against this membership). AFTER the
      // durable createWarming, so a crash between buy and attach still leaves a
      // warming record the stuck-warming alert surfaces. Idempotent on 21710.
      await adapter.attachToMessagingService(candidate.sid);

      // Pre-wire the voice webhook exactly as provisionForGroup does (M1.9 bridge
      // seam). Best-effort: a wiring failure must not strand the warming number.
      if (config.publicBaseUrl) {
        try {
          await adapter.setVoiceWebhook(
            candidate.phoneNumber,
            `${config.publicBaseUrl}${VOICE_WEBHOOK_PATH}`,
          );
        } catch (err) {
          log.error({ err }, 'relay warming number voice webhook wiring failed');
        }
      }

      log.info(
        { event: 'relay_number_warming' },
        'relay pool number bought and warming (awaiting A2P registration)',
      );
    },

    async refillBufferIfNeeded() {
      // have = fresh spares + warming (WARMING counts, so a 2nd spare is never
      // bought while the 1st is still registering - the debounce). need clamps at
      // 0, so target 0 (dev) enqueues nothing. Each missing spare = one warm job.
      const have = (await repo.countFreshSpares()) + (await repo.countWarming());
      const need = Math.max(0, config.relaySpareBufferTarget - have);
      for (let i = 0; i < need; i += 1) {
        await enqueueImmediate(RELAY_WARM_JOB, {});
      }
      if (need > 0) {
        log.info(
          { event: 'relay_buffer_refill', need },
          'relay spare buffer below target - warm jobs enqueued',
        );
      }
    },

    async flagStuckWarming() {
      // ALERT-ONLY stuck-registration sweep: a warming number older than the max
      // wait means Twilio's A2P registration event never arrived. NEVER promote
      // (promotion is solely the registration event) - just log.error so the
      // error-logs alarm surfaces it. PII (doc section 9): log the SID (the D2
      // correlation key an operator acts on), NEVER the pool number.
      const cutoff = now().getTime() - config.relayWarmingMaxWaitMs;
      for (const record of await repo.listWarming()) {
        const startedAt = record.warming_started_at;
        if (startedAt === undefined) continue; // no stamp - cannot age it
        const startedMs = Date.parse(startedAt);
        if (Number.isNaN(startedMs)) continue; // corrupt stamp - skip (retire NaN-guard parity)
        if (startedMs < cutoff) {
          log.error(
            { event: 'relay_warm_stuck', sid: record.sid },
            'relay warming number stuck past the max wait - A2P registration never arrived (manual attention)',
          );
        }
      }
    },

    retireEligible,
  };
}
