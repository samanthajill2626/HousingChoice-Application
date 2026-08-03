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
  NumberUnavailableError,
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
 * Thrown when buying/warming a pool number is required but the relay
 * number-provisioning kill-switch is off (config.relayLiveProvisioning ===
 * false). Raised BEFORE any adapter.provisionPhoneNumber call, so the deployed
 * twilio driver can never accidentally PURCHASE a real number before A2P
 * approval / an explicit RELAY_LIVE_PROVISIONING=true decision. The message is
 * actionable and PII-free.
 *
 * Two throw sites, both gated by the same flag:
 *   - warmOneNumber (T4): buying a warm spare.
 *   - provisionForGroup (T5) at a TIER-3 miss (no reuse AND no spare): with the
 *     flag OFF the connect-when-ready path cannot complete (no number now and none
 *     can be warmed), so it throws rather than returning `needs_connecting` -
 *     otherwise the caller would mint a CONNECTING group whose warm job dies in the
 *     worker, stranding it permanently connecting. The routes map the throw to a
 *     clean 503 and the whole path stays dormant. With the flag ON that same
 *     tier-3 miss returns `needs_connecting` (buying deferred to a warm job).
 * Tiers 1/2 (reuse/spare) never throw - they never buy.
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

/**
 * The outcome of provisionForGroup (T5), a discriminated union:
 *  - `assigned`: a pool number was acquired for the group NOW - tier-1 reuse of
 *    an already-burned active (prefer multiplex) or tier-2 consumption of a
 *    fresh spare. Under the warm-pool model provisionForGroup never BUYS, so
 *    `provisioned` is always false here; it is retained on the shape so existing
 *    callers/telemetry that read it keep compiling.
 *  - `needs_connecting`: no reusable number AND no free spare (a TIER-3 miss) WITH
 *    relay live provisioning ON, so the caller must create a CONNECTING group and
 *    enqueue a warm job (connect-when-ready). No number is bought here (buying is
 *    solely warmOneNumber). When the kill-switch is OFF this same tier-3 miss
 *    THROWS RelayProvisioningDisabledError instead of returning this variant (it
 *    cannot warm a number, so it fails clean via a 503 rather than stranding a
 *    connecting group whose warm job would die in the worker).
 */
export type ProvisionResult =
  | { kind: 'assigned'; poolNumber: string; record: PoolNumberItem; provisioned: boolean }
  | { kind: 'needs_connecting' };

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
   * Acquire a pool number for a relay GROUP via the THREE-TIER ladder (T5),
   * returning a discriminated ProvisionResult. It never BUYS; it throws the
   * kill-switch error (RelayProvisioningDisabledError) ONLY at a tier-3 miss when
   * relay live provisioning is off (see TIER 3):
   *   TIER 1 - reuse, PREFER MULTIPLEX: burn-as-claim onto the first active
   *     same-driver number that ALREADY hosts a group (non-empty burn) and does
   *     not overlap `rosterPhones`.
   *   TIER 2 - fresh spare: burn-as-claim onto an active same-driver EMPTY-burn
   *     spare that is NOT earmarked to a connecting group (G2 - same "fresh spare"
   *     definition as countFreshSpares).
   *   TIER 3 - connect-when-ready: neither hit. With the flag ON ->
   *     `{ kind: 'needs_connecting' }` (the caller creates a connecting group +
   *     enqueues a warm job). With the flag OFF -> THROWS
   *     RelayProvisioningDisabledError (no number now and none can be warmed; the
   *     routes map it to a 503 and the path stays dormant). Tiers 1/2 are
   *     unaffected by the flag - they never buy.
   * `rosterPhones` = every member phone of the NEW group; MUST be non-empty.
   * Before every NON-THROWING return it awaits refillBufferIfNeeded (tops the warm
   * spare buffer; on dev target 0 this enqueues nothing) and opportunistically
   * fires the retirement + stuck-warming sweeps. The tier-3 throw short-circuits
   * BEFORE refillBufferIfNeeded, so with the flag off nothing is enqueued.
   */
  provisionForGroup(rosterPhones: string[], tag?: string): Promise<ProvisionResult>;
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
   * Burn a connecting group's WHOLE roster onto its freshly-assigned pool number
   * (G1 - the connect-when-ready "burn on assign"). The number was created warming
   * with an EMPTY burn and promoted to active still empty (+ earmarked via
   * pending_conversation_id), so on a genuine first assign this claim CANNOT
   * overlap-fail - it records the burn, preserving the burn-multiplexing invariant
   * and enabling future multiplex. On a redelivered relay.numberReady the roster is
   * already burned here, so burnClaim returns undefined and this returns false
   * (benign - the caller still proceeds to the idempotent assign). A thin
   * multi-phone repo.burnClaim (vs burnMember's single phone). Returns true when
   * the burn was recorded.
   */
  burnGroupRoster(poolNumber: string, phones: string[]): Promise<boolean>;
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
   *
   * The BUY searches with a geographic-hint LADDER (area-code preference
   * 2026-08-03): postalCode first when the caller supplied one (a
   * connect-when-ready buy for a tour/placement group prefers a number local to
   * the property), then each config.relayPreferredAreaCodes entry in order, then
   * an unhinted any-US search (today's behavior, and still a loud failure when it
   * too comes back empty). ONLY a NumberUnavailableError advances a rung - any
   * other error propagates immediately, so a number that was already PURCHASED
   * can never be followed by a second purchase. The dedup-resume paths never buy,
   * so they ignore postalCode entirely.
   */
  warmOneNumber(conversationId?: string, postalCode?: string): Promise<void>;
  /**
   * Clear the connect-when-ready earmark (pending_conversation_id) on EVERY pool
   * record still tagged to this conversation - called when the group OPENS
   * (relay.numberReady). The assigned number now carries a REAL burn, so its
   * earmark is stale; and any OTHER record left earmarked (a duplicate warm that
   * raced past the dedup) is reclaimed as a usable fresh spare - otherwise it stays
   * active+empty-burn+earmarked and countFreshSpares excludes it forever (a
   * stranded number + a leaked A2P sender-pool slot). Idempotent + best-effort.
   */
  clearConnectingEarmarks(conversationId: string): Promise<void>;
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
   * Stuck-CONNECTING ALERT sweep (T6, D9 sibling of flagStuckWarming): log.error
   * for every relay group left in the `connecting` state longer than
   * relayWarmingMaxWaitMs (its earmarked warm number never registered, so the
   * relay.numberReady that would open it never fired). ALERT ONLY - it never
   * promotes/opens anything (opening is solely the registration -> relay.numberReady
   * path). Fresh connecting groups are skipped. PII (doc section 9): logs the
   * conversationId only (an internal id) - never a member phone/name.
   */
  flagStuckConnecting(): Promise<void>;
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

/**
 * True if the number carries ANY burn (D7 Set-or-array-safe). Separates the
 * tier-1 "already hosts a group" candidates (prefer multiplex) from the tier-2
 * empty-burn spares. `!burned?.size` is unsafe for the `string[]` arm of
 * `Set<string> | string[]`, so branch on both shapes explicitly.
 */
function hasBurn(burned: Set<string> | string[] | undefined): boolean {
  if (burned === undefined) return false;
  if (burned instanceof Set) return burned.size > 0;
  return Array.isArray(burned) && burned.length > 0;
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

      // (2b) DETACH from the A2P Messaging Service sender pool FIRST (T8), so the
      // sender-pool membership is cleaned up deterministically BEFORE the resource
      // delete. BEST-EFFORT: releasePhoneNumber below also drops the number from the
      // service implicitly, so a detach failure LOGS (error taxonomy) and the sweep
      // CONTINUES to the delete rather than aborting - a detach hiccup must never
      // strand an otherwise-eligible retirement. PII (doc section 9): the adapter
      // logs the SID/boolean only, never the number.
      try {
        await adapter.detachFromMessagingService(record.poolNumber);
      } catch (err) {
        log.error(
          { err },
          'relay retirement: detachFromMessagingService failed - continuing to release (delete detaches implicitly)',
        );
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

  // Buffer refill (T4). Hoisted to a local function (like retireEligible) so
  // provisionForGroup can await it directly, without relying on `this` binding.
  // have = fresh spares + warming (WARMING counts, so a 2nd spare is never bought
  // while the 1st is still registering - the debounce). need clamps at 0, so
  // target 0 (dev) enqueues nothing. Each missing spare = one warm job.
  async function refillBufferIfNeeded(): Promise<void> {
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
  }

  // Stuck-warming ALERT sweep (T4). Hoisted for the same reason (the
  // opportunistic fire-and-forget in provisionForGroup calls it directly). A
  // warming number older than the max wait means Twilio's A2P registration event
  // never arrived. NEVER promote (promotion is solely the registration event) -
  // just log.error so the error-logs alarm surfaces it. PII (doc section 9): log
  // the SID (the D2 correlation key an operator acts on), NEVER the pool number.
  async function flagStuckWarming(): Promise<void> {
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
  }

  // Stuck-CONNECTING ALERT sweep (T6, D9). A group left connecting past the max
  // wait means its earmarked warm number never registered, so the relay.numberReady
  // that opens it never fired. ALERT ONLY (never opens anything). Ages the group by
  // its created_at (when the connecting group was minted). PII: conversationId only.
  async function flagStuckConnecting(): Promise<void> {
    const cutoff = now().getTime() - config.relayWarmingMaxWaitMs;
    const { items } = await conversations.listRelayGroups('connecting');
    for (const group of items) {
      const startedAt = group.created_at;
      if (typeof startedAt !== 'string') continue; // no stamp - cannot age it
      const startedMs = Date.parse(startedAt);
      if (Number.isNaN(startedMs)) continue; // corrupt stamp - skip
      if (startedMs < cutoff) {
        log.error(
          { event: 'relay_connecting_stuck', conversationId: group.conversationId },
          'relay group stuck connecting past the max wait - its warm number never registered (manual attention)',
        );
      }
    }
  }

  return {
    async provisionForGroup(rosterPhones, tag) {
      // Never claim an unburnable (empty-roster) group - it would match every
      // number's burn guard vacuously.
      if (rosterPhones.length === 0) {
        throw new Error('provisionForGroup: rosterPhones must be non-empty');
      }

      // Opportunistic background sweeps - fire-and-forget, never block a provision
      // and never fail it: (a) lazy retirement (the seat the quarantine reclaim
      // used to hold) and (b) the stuck-warming ALERT (T4 - a warming number whose
      // A2P registration event never arrived). Both no-op silently when their
      // config gates are off / nothing is stuck.
      void retireEligible().catch((err) => {
        log.error({ err }, 'lazy retirement sweep failed (non-fatal)');
      });
      void flagStuckWarming().catch((err) => {
        log.error({ err }, 'stuck-warming sweep failed (non-fatal)');
      });
      void flagStuckConnecting().catch((err) => {
        log.error({ err }, 'stuck-connecting sweep failed (non-fatal)');
      });

      // SOURCE ISOLATION (M1.7 kill-switch): only ever reuse a number our CURRENT
      // driver obtained - the live twilio path must never burn onto a fake console
      // number (and vice-versa), even though both live in the shared dev table.
      const actives = (await repo.listActive()).filter(
        (c) => c.provisioned_via === currentVia,
      );

      // TIER 1 - REUSE, PREFER MULTIPLEX: burn-as-claim onto the FIRST active
      // same-driver number that ALREADY hosts a group (non-empty burn) and whose
      // burn does not overlap this roster. Preferring already-burned numbers packs
      // groups onto existing numbers (multiplexing) BEFORE consuming a fresh spare
      // - so the warm buffer is spent last. repo.burnClaim is the atomic arbiter
      // (an overlapping / lost-race candidate fails its condition; try the next).
      for (const candidate of actives) {
        if (!hasBurn(candidate.burned_phones)) continue; // empty-burn spares are tier 2
        if (rosterOverlapsBurn(rosterPhones, candidate.burned_phones)) continue;
        const claimed = await repo.burnClaim(candidate.poolNumber, rosterPhones, tag);
        if (claimed) {
          await refillBufferIfNeeded();
          log.info({ provisioned: false, tier: 1 }, 'relay pool number acquired (reused - multiplex)');
          return { kind: 'assigned', poolNumber: claimed.poolNumber, record: claimed, provisioned: false };
        }
      }

      // TIER 2 - FRESH SPARE: consume a warm-pool spare (active, EMPTY burn, and
      // NOT earmarked to a connecting group - G2). The empty-burn + no-pending
      // check is the SAME "fresh spare" definition as repo.countFreshSpares, so we
      // never burn a roster onto a number a concurrent connecting group is waiting
      // to open (that number is momentarily active+empty-burn but carries a
      // pending_conversation_id).
      for (const candidate of actives) {
        if (hasBurn(candidate.burned_phones)) continue; // burned actives were tier 1
        if (candidate.pending_conversation_id !== undefined) continue; // G2: earmarked - hands off
        const claimed = await repo.burnClaim(candidate.poolNumber, rosterPhones, tag);
        if (claimed) {
          await refillBufferIfNeeded();
          log.info({ provisioned: false, tier: 2 }, 'relay pool number acquired (fresh spare)');
          return { kind: 'assigned', poolNumber: claimed.poolNumber, record: claimed, provisioned: false };
        }
      }

      // TIER 3 - CONNECT-WHEN-READY: no reusable number and no free spare. Buying
      // is solely warmOneNumber (T4), gated by the SAME kill-switch, so when relay
      // live provisioning is OFF (the deployed default pre-A2P) this path cannot
      // complete: there is no number now AND none can be warmed. Throw the identical
      // kill-switch error the old buy path used (routes map it to a clean 503)
      // rather than returning needs_connecting - otherwise the caller would mint a
      // CONNECTING group and enqueue a warm job that dies with
      // RelayProvisioningDisabledError in the worker, stranding the group
      // permanently connecting. Thrown BEFORE refillBufferIfNeeded, so with the
      // flag off NOTHING is enqueued and the whole warm/connect path stays dormant.
      // Tiers 1/2 are unaffected (they never buy, so they resolve regardless).
      if (!config.relayLiveProvisioning) {
        throw new RelayProvisioningDisabledError(
          'relay number provisioning is disabled in this environment - set ' +
            'RELAY_LIVE_PROVISIONING=true after A2P approval to enable buying a pool number',
        );
      }

      // Flag ON: do NOT buy here (buying is solely warmOneNumber, T4) - signal the
      // caller to create a connecting group + enqueue a warm job. Still top the
      // buffer up first (dev target 0 enqueues nothing; prod refills the spare this
      // group would have consumed).
      await refillBufferIfNeeded();
      log.info(
        { event: 'relay_needs_connecting' },
        'no reusable relay number and no spare - connect-when-ready',
      );
      return { kind: 'needs_connecting' };
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

    async burnGroupRoster(poolNumber, phones) {
      // G1 - burn on assign (connect-when-ready): claim the whole roster onto the
      // now-active dedicated number. A fresh number's burn is empty, so a genuine
      // first assign never overlap-fails; a redelivery finds the roster already
      // burned here (undefined) -> false, which the caller treats as benign.
      const claimed = await repo.burnClaim(poolNumber, phones);
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

    async warmOneNumber(conversationId, postalCode) {
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

      // DEDUP (connect-when-ready). A redelivered relay.warmNumber for the SAME
      // connecting group - or a retry after a transient attach failure - must NOT
      // buy a SECOND number earmarked to this conversation. Only the first opens the
      // group; the duplicate would stay active+empty-burn+earmarked, be excluded
      // from countFreshSpares forever, and never be assigned or retired (stranded
      // cost + a leaked A2P sender-pool slot -> eventual 21714). If a warming/active
      // record already carries this pending_conversation_id, RESUME it instead of
      // buying again: for a warming record re-attach (idempotent on 21710) so a
      // prior attach failure that redelivered this job still lands the number in the
      // A2P service and re-wire its voice webhook; for an already-promoted active
      // record there is nothing to do but wait for relay.numberReady.
      if (conversationId !== undefined) {
        const earmarked = await repo.findByPendingConversationId(conversationId);
        const warmingDup = earmarked.find((r) => r.lifecycle_state === 'warming');
        if (warmingDup !== undefined) {
          if (warmingDup.sid !== undefined) {
            await adapter.attachToMessagingService(warmingDup.sid);
          }
          if (config.publicBaseUrl) {
            try {
              await adapter.setVoiceWebhook(
                warmingDup.poolNumber,
                `${config.publicBaseUrl}${VOICE_WEBHOOK_PATH}`,
              );
            } catch (err) {
              log.error({ err }, 'relay warming number voice webhook re-wiring failed (dedup resume)');
            }
          }
          log.info(
            { event: 'relay_warm_dedup_warming' },
            'relay warmOneNumber: a warming number is already earmarked to this group - resumed attach, not buying again',
          );
          return;
        }
        if (earmarked.length > 0) {
          log.info(
            { event: 'relay_warm_dedup_active' },
            'relay warmOneNumber: an active number is already earmarked to this group (awaiting open) - not buying again',
          );
          return;
        }
      }

      // Buy a voice+sms-capable number, RETRYING on a pool collision exactly like
      // provisionForGroup's fresh block (createWarming's attribute_not_exists guard
      // can fire locally against the shared dev table; a purchased number is
      // globally unique in prod so this runs once). REQUIRE voice on each candidate
      // (M1.9 masked calling rides the same number) - a misconfigured account fails
      // HERE, not at call time. Persist WARMING (NOT active) with the PN sid (D2
      // correlation key) + the connect-when-ready earmark; the number is NOT a
      // usable pool number until the registration event promotes it.
      // Geographic hint ladder (area-code preference design 2026-08-03):
      // property ZIP first (when the caller supplied one), then each preferred
      // area code, then the unhinted search (today's behavior, still loud on
      // total exhaustion). ONLY a NumberUnavailableError (search empty)
      // advances to the next hint - any other failure propagates immediately,
      // so a number that was successfully PURCHASED can never be followed by a
      // second purchase (no buy-and-leak). PII: log hint TYPE only, never the
      // ZIP or code value alongside a number.
      const hints: { areaCode?: string; postalCode?: string }[] = [
        ...(postalCode !== undefined ? [{ postalCode }] : []),
        ...config.relayPreferredAreaCodes.map((areaCode) => ({ areaCode })),
        {},
      ];
      const hintTierOf = (h: { areaCode?: string; postalCode?: string }): string =>
        h.postalCode !== undefined ? 'postal' : h.areaCode !== undefined ? 'areaCode' : 'bare';
      async function provisionWithHints(): Promise<{
        bought: ProvisionPhoneNumberResult;
        hintTier: string;
      }> {
        for (let i = 0; i < hints.length; i += 1) {
          const hint = hints[i]!;
          try {
            const bought = await adapter.provisionPhoneNumber({ voiceCapable: true, ...hint });
            return { bought, hintTier: hintTierOf(hint) };
          } catch (err) {
            if (err instanceof NumberUnavailableError && i < hints.length - 1) {
              log.info(
                { event: 'relay_warm_hint_miss', hintTier: hintTierOf(hint) },
                'relay warm: no number available for this search hint - trying the next',
              );
              continue;
            }
            throw err;
          }
        }
        throw new Error('unreachable: the hint ladder always ends with a bare attempt');
      }

      let candidate: ProvisionPhoneNumberResult | undefined;
      // Which rung won the accepted buy, for the success log (TYPE only, never
      // the ZIP/code value). A createWarming collision re-runs the whole ladder,
      // so the LAST attempt's tier is the one that landed.
      let winningHintTier = 'bare';
      for (let attempt = 1; attempt <= MAX_PROVISION_ATTEMPTS; attempt += 1) {
        const { bought, hintTier } = await provisionWithHints();
        winningHintTier = hintTier;
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
        { event: 'relay_number_warming', hintTier: winningHintTier },
        'relay pool number bought and warming (awaiting A2P registration)',
      );
    },

    async clearConnectingEarmarks(conversationId) {
      // Finding 4 reclaim: clear pending_conversation_id on EVERY pool record still
      // tagged to this conversation. The assigned number (now burned) sheds a stale
      // earmark; a duplicate number (empty burn) becomes a countable fresh spare
      // instead of a stranded one. Idempotent - clearPendingConversation is a no-op
      // on an already-clear/missing record.
      const earmarked = await repo.findByPendingConversationId(conversationId);
      for (const rec of earmarked) {
        await repo.clearPendingConversation(rec.poolNumber);
      }
      if (earmarked.length > 0) {
        log.info(
          { count: earmarked.length, event: 'relay_earmarks_cleared' },
          'relay: cleared connect-when-ready earmarks on group open',
        );
      }
    },

    // Hoisted above (so provisionForGroup can call them without `this`); exposed
    // here via shorthand so the public service surface is unchanged.
    refillBufferIfNeeded,
    flagStuckWarming,
    flagStuckConnecting,

    retireEligible,
  };
}
