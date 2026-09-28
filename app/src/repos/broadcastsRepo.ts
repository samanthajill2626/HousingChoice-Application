// broadcasts repo (M1.8a) — the filtered share-broadcast ("Share Properties")
// record: a draft → sending → sent/failed lifecycle row carrying the audience
// filter snapshot, the per-recipient delivery map, and rolled-up stats the
// results view reads.
//
// Items stay FLEXIBLE documents — only the key (broadcastId) and the GSI key
// attributes (_listPartition + created_at for the team-wide byCreated list;
// unitId for the sparse byUnit lookup) are contractual (lib/tables.ts).
// Everything else (body_template, audience_filter snapshot, recipients map,
// stats) is a free-form attribute, so schema churn needs no migration —
// exactly the §5 posture.
//
// ITEM SIZE: the `recipients` map lives ON the item. A DynamoDB item is capped
// at 400KB, so this only holds a BOUNDED audience — the Phase-1 filtered tenant
// set is low hundreds, each slot a handful of short fields (~150 bytes), well
// under the ceiling. A future unbounded-audience broadcast would move recipients
// to their own partition (one item per recipient); flagged so the bound is a
// known choice, not an oversight.
//
// PII (doc §9): NEVER log phones/names/bodies — IDs/keys/counts/SIDs only,
// correlated via the pino mixin (relayFanOut precedent).
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import { SEND_UNCONFIRMED_CODE } from '../lib/sendOutcome.js';
import type { RepoDeps } from './conversationsRepo.js';
import type { FanoutClaimResult } from './fanoutClaim.js';

/** Broadcast lifecycle status (the byCreated GSI's FilterExpression key). */
export type BroadcastStatus = 'draft' | 'sending' | 'sent' | 'failed';

/** How preview/send derive candidates: 'filter' resolves the audience filter
 *  (and unions any seeds); 'seeds_only' uses ONLY seed_contact_ids (the seeded
 *  1:1 entry - the default filter would otherwise propose every tenant).
 *  Absent on legacy rows = 'filter'. */
export type BroadcastAudienceMode = 'filter' | 'seeds_only';

/**
 * The byCreated GSI's constant partition value (the tours `_schedPartition`
 * convention): every broadcast stamps `_listPartition = LIST_PARTITION` so the
 * team-wide list is ONE newest-first query. Rows created before this attribute
 * existed need the backfill script or they drop out of the list views.
 */
export const LIST_PARTITION = 'broadcasts';

/**
 * Hard cap on a broadcast's recipient count.
 *
 * The `recipients` map lives ON the broadcast item, and a DynamoDB item is
 * capped at 400KB. A slot carries up to SIX attributes (status,
 * conversationId, tsMsgId, errorCode, carrierSentAt, latestAttempt). A fully
 * populated slot without the pointer is about 230 bytes (contactKey ~44B,
 * conversationId ~41B, tsMsgId ~59B, an ISO carrierSentAt 24B, the attribute
 * names and the map overhead); share-sent-outcome's latestAttempt pointer (a
 * tsMsgId-sized string) adds about 75 bytes. So 1000 slots when EVERY
 * recipient was retried is about 305KB, and the same cap bounds
 * seed_contact_ids (1000 x ~44B), leaving room under 400KB for the rest of
 * the item (audience_filter, body_template, stats, etc.) - the reason the cap
 * came down from 1500 (share-sent-outcome, spec section 9).
 * The /send route REFUSES an audience over this cap (audience_too_large) so the
 * recipients map can never overflow the item - narrow the filter, or move to a
 * one-item-per-recipient layout if Phase-2 ever needs unbounded audiences.
 */
export const MAX_BROADCAST_RECIPIENTS = 1000;

/**
 * The audience filter SNAPSHOT persisted on the broadcast (M1.8a): tenant
 * contacts, optionally narrowed by housing authority and exact bedroom size.
 * contact_type is fixed 'tenant' for M1.8 (never relay-group rosters); opt-out
 * + unreachable are ALWAYS excluded (the booleans record the intent for the
 * audit trail / future flexibility).
 */
export interface AudienceFilter {
  contact_type: 'tenant';
  housing_authority?: string;
  bedroomSize?: number;
  excludeOptedOut: boolean;
  excludeUnreachable: boolean;
}

/** Rolled-up send/delivery counters the results view renders. */
export interface BroadcastStats {
  /** Resolved audience size at send time (the snapshot's length). */
  audience: number;
  /** Provider-accepted sends (queued/sent at the adapter). */
  sent: number;
  /** Delivery callbacks that reached `delivered`. */
  delivered: number;
  /** Sends that failed (carrier filter / invalid number / cap). */
  failed: number;
  /**
   * SOR D22: closed `failed` slots carrying `send_unconfirmed` - the platform
   * could not confirm whether the text went out. Never counted in `failed`,
   * never a skip. Optional - persisted rows predate it, readers default 0 (the
   * close's ADD creates it on such a row).
   */
  unconfirmed?: number;
  /** Recipients skipped at send time for opt-out (no token spent), plus legacy
   *  reason-less skips (opt-out or unreachable, recorded before 2026-09-25). */
  skipped_opted_out: number;
  /**
   * A2P/CTIA (spec §4): recipients skipped because they have NO recorded SMS
   * consent (no token spent, no send). Surfaced separately from
   * skipped_opted_out so the results view can prompt staff to record consent
   * (which re-includes them on a re-send).
   */
  skipped_no_consent: number;
  /**
   * share-skip-fix D7: every OTHER skip - the switch off (`manual_mode`), the
   * breaker, a deleted contact, an unreachable number, the kill switch, any
   * future refusal code. Kept apart from `skipped_opted_out` so an opt-out is
   * an opt-out and nothing else is filed under it. Optional because persisted
   * stats rows written before the field existed lack it (readers default 0;
   * the fan-out's ADD creates it on such a row).
   */
  skipped_other?: number;
  /** Recipients still queued ON OUR BOX (pre-send seed / awaiting the paced
   *  fan-out / transient deferral awaiting a retry continuation). */
  queued: number;
  /**
   * Recipients dispatched to Twilio but not yet carrier-confirmed (slot status
   * 'sent' with no carrierSentAt). Kept SEPARATE from `queued` so a stuck send
   * is diagnosable at a glance: stuck-on-our-box (queued) vs stuck-at-the-
   * carrier (sending) are different failures with different fixes. DERIVED
   * only - optional because legacy persisted stats rows predate the field
   * (readers default it to 0).
   */
  sending?: number;
  /**
   * share-sent-outcome D4: how many `failed` slots hold a LIVE retry promise
   * (a SUB-bucket of `failed`: never in the bucket sum, never persisted). Set
   * only by a caller that supplied a promise count (the results and list
   * routes; the rollup's own lower bound on its emit); ABSENT otherwise, and
   * the dashboard merges an absent count by keeping its last value.
   */
  retry_pending?: number;
}

/** Per-recipient delivery slot on the broadcast (keyed by contactKey). */
export interface BroadcastRecipient {
  /** The tenant's 1:1 conversation the message landed in (set at send). */
  conversationId?: string;
  /** The persisted message's SK (delivery-callback rollup target). */
  tsMsgId?: string;
  /**
   * 'sent' is stamped at DISPATCH (the fan-out's idempotency claim - a
   * continuation pass never re-sends it), which is EARLIER than the carrier's
   * own "sent". See carrierSentAt for the carrier-confirmed instant.
   */
  status: 'queued' | 'sent' | 'delivered' | 'failed' | 'skipped';
  /**
   * Why the slot did not simply send. FAILED: the Twilio error class, or an
   * internal code (no_contact, transient_cap, enqueue_failed). SKIPPED
   * (share-skip-fix D7): the skip reason - a fan-out fence (opted_out,
   * unreachable, contact_deleted, no_consent) or the send wrapper's refusal
   * code (SendRefusedError.code: contact_opted_out, manual_mode,
   * sms_sending_disabled, ...). A first-fence skip (opt-out or unreachable)
   * recorded before 2026-09-25 has none. QUEUED: the transient code a
   * deferred slot is awaiting a retry for.
   */
  errorCode?: string;
  /**
   * ISO - set when the CARRIER's non-terminal 'sent' status callback lands
   * (webhook rollup). Until then a status-'sent' slot is only dispatched, and
   * every read surface presents it as in-flight ("Sending...") so the
   * recipient row can never claim "Sent" while the same message's 1:1 bubble
   * still reads "Sending...".
   */
  carrierSentAt?: string;
  /**
   * share-sent-outcome D1/D2: the order key of the NEWEST attempt for this
   * recipient (a retry row's tsMsgId, or the row-less marker
   * shareAttemptOrder.rowlessAttemptKey). ABSENT while the original send
   * (`tsMsgId`) is the newest attempt. The promise and the chain's end are
   * NEVER copied here - they are read from that attempt's own row (I5).
   */
  latestAttempt?: string;
}

export interface BroadcastItem {
  broadcastId: string;
  /** The acting user's userId (audit/attribution; no longer an index key). */
  created_by: string;
  /** share-skip-fix D4: the creation path; `'dashboard'` = a person's share. See CreateBroadcastInput.createdVia. */
  created_via?: 'dashboard';
  /** byCreated GSI range (ISO 8601). */
  created_at: string;
  /**
   * byCreated GSI hash — the constant LIST_PARTITION, stamped by create().
   * Optional in the type because rows written before the byCreated migration
   * lack it until backfilled.
   */
  _listPartition?: typeof LIST_PARTITION;
  status: BroadcastStatus;
  /** The unit whose flyer + merge fields this broadcast shares (optional draft). */
  unitId?: string;
  /** The audience filter snapshot (resolved at send to the recipients map). */
  audience_filter: AudienceFilter;
  /** The operator's message template (merge tokens rendered per recipient). */
  body_template: string;
  /** The unit's public flyer URL, snapshotted at send. */
  flyer_url?: string;
  stats: BroadcastStats;
  /**
   * contactKey → per-recipient delivery slot. contactKey = contactId else
   * `phone#<E164>` (the relay convention). Bounded (see the item-size note).
   */
  recipients: Record<string, BroadcastRecipient>;
  /** Explicit recipients attached to the draft (entry-point seed or the
   *  review step's hand-picked additions). Independent of audience_filter. */
  seed_contact_ids?: string[];
  audience_mode?: BroadcastAudienceMode;
  /** 1-based pass number of the fan-out CONTINUATION ladder (M5). Claimed by
   *  claimFanoutPass; top-level so a wholesale recipient-slot write cannot erase
   *  it. Absent on rows written before M5 (they claim at 1). */
  fanout_attempt?: number;
  last_error?: string;
  updated_at?: string;
  /**
   * SOR (code review ADV-3, fix FW1-5): the op token of the finalizeStatus
   * flip that won - how a flip that committed on an earlier SDK attempt is
   * told from a genuine loser. Written only by that flip; nothing else reads it.
   */
  finalize_op?: string;
  [key: string]: unknown;
}

/** One page of a broadcasts list query (opaque cursor handled at the route). */
export interface BroadcastsPage {
  items: BroadcastItem[];
  lastEvaluatedKey?: Record<string, unknown>;
}

export interface ListBroadcastsOpts {
  limit?: number;
  exclusiveStartKey?: Record<string, unknown>;
}

/** The two consent refusal codes: the fan-out's own fence and the send wrapper's JIT gate. */
export function isNoConsentCode(code: string | undefined): boolean {
  return code === 'no_consent' || code === 'contact_no_consent';
}

/** The opt-out codes, plus NO code: a skipped slot recorded before 2026-09-25
 *  carried no reason and was an opt-out or an unreachable number - filed under
 *  opted-out, as it always was. */
export function isOptedOutCode(code: string | undefined): boolean {
  return code === undefined || code === 'opted_out' || code === 'contact_opted_out';
}

/**
 * S4 (broadcast live progress): the SINGLE SOURCE OF TRUTH for the disjoint stat
 * buckets, derived from the recipients map so a recipient is counted in EXACTLY
 * ONE bucket and the buckets always sum to the audience (the map size).
 *
 * - EMPTY map (drafts, or a legacy row without a map): return the persisted
 *   stats UNCHANGED (drafts show the audience estimate + zero buckets, today's
 *   behavior). Same object reference - a pure passthrough.
 * - NON-EMPTY map: compute every field from the slots:
 *     audience  = number of slots
 *     queued    = status 'queued': still on OUR box (awaiting the paced
 *                 fan-out, or deferred for a rate-limit retry)
 *     sending   = status 'sent' WITHOUT carrierSentAt: dispatched to Twilio,
 *                 carrier not yet confirmed
 *     sent      = status 'sent' AND carrierSentAt (carrier-confirmed)
 *     delivered = slots with status 'delivered'
 *     failed    = slots with status 'failed', EXCEPT those carrying
 *                 send_unconfirmed, which count as
 *     unconfirmed (SOR D22) and in no other bucket
 *     skipped_no_consent = 'skipped' slots with errorCode no_consent | contact_no_consent
 *     skipped_opted_out  = 'skipped' slots with errorCode opted_out | contact_opted_out,
 *                          or NO errorCode (a legacy first-fence skip: opt-out or
 *                          unreachable, recorded without a reason before 2026-09-25)
 *     skipped_other      = every remaining 'skipped' slot (manual_mode, breaker_open,
 *                          contact_deleted, unreachable, sms_sending_disabled, ...)
 *   queued/sending stay separate so a stuck send is diagnosable: stuck on our
 *   box vs stuck at the carrier are different failures.
 *   Legacy cumulative persisted stats are IGNORED when the map is present, so
 *   historical broadcasts (whose persisted counters double-counted delivered)
 *   still DISPLAY correctly. Same BroadcastStats shape as the persisted counters.
 *
 * share-sent-outcome (D1, D4) - two OPTIONAL caller-supplied facts the slots
 * alone do not carry (they live on the newest attempt's message row):
 *   retryPending    - the count of `failed` slots holding a LIVE retry
 *                     promise; emitted as `retry_pending`, a SUB-bucket of
 *                     `failed` (never in the bucket sum). Absent unless given.
 *   unconfirmedKeys - contactKeys whose state is `unconfirmed` although the
 *                     slot's code is not send_unconfirmed (the row says the
 *                     chain ended unresolved): counted in `unconfirmed`, not
 *                     `failed`.
 * With no options the empty-map passthrough still returns the persisted
 * object ITSELF.
 */
export function deriveBroadcastStats(
  b: Pick<BroadcastItem, 'recipients' | 'stats'>,
  opts?: { retryPending?: number; unconfirmedKeys?: ReadonlySet<string> },
): BroadcastStats {
  const recipients = b.recipients ?? {};
  const keys = Object.keys(recipients);
  if (keys.length === 0) {
    return opts?.retryPending === undefined ? b.stats : { ...b.stats, retry_pending: opts.retryPending };
  }
  let queued = 0;
  let sending = 0;
  let sent = 0;
  let delivered = 0;
  let failed = 0;
  let unconfirmed = 0;
  let skipped_no_consent = 0;
  let skipped_opted_out = 0;
  let skipped_other = 0;
  for (const key of keys) {
    const slot = recipients[key]!;
    switch (slot.status) {
      case 'queued':
        queued += 1;
        break;
      case 'sent':
        // Dispatched-but-carrier-unconfirmed is `sending`, not Sent: the SENT
        // chip must never outrun the per-recipient rows or the message's own
        // 1:1 delivery badge. The carrier's sent callback stamps carrierSentAt
        // and moves it over.
        if (slot.carrierSentAt !== undefined) sent += 1;
        else sending += 1;
        break;
      case 'delivered':
        delivered += 1;
        break;
      case 'failed':
        if (slot.errorCode === SEND_UNCONFIRMED_CODE || opts?.unconfirmedKeys?.has(key) === true) unconfirmed += 1;
        else failed += 1;
        break;
      case 'skipped':
        if (isNoConsentCode(slot.errorCode)) skipped_no_consent += 1;
        else if (isOptedOutCode(slot.errorCode)) skipped_opted_out += 1;
        else skipped_other += 1;
        break;
    }
  }
  return {
    audience: keys.length,
    queued,
    sending,
    sent,
    delivered,
    failed,
    unconfirmed,
    skipped_opted_out,
    skipped_no_consent,
    skipped_other,
    ...(opts?.retryPending !== undefined && { retry_pending: opts.retryPending }),
  };
}

/** Zero-valued stats for a fresh draft. */
export function zeroStats(): BroadcastStats {
  return {
    audience: 0,
    sent: 0,
    delivered: 0,
    failed: 0,
    unconfirmed: 0,
    skipped_opted_out: 0,
    skipped_no_consent: 0,
    skipped_other: 0,
    queued: 0,
    sending: 0,
  };
}

/** Create input: created_by + body_template + audience_filter are required. */
export interface CreateBroadcastInput {
  broadcastId?: string;
  created_by: string;
  audience_filter: AudienceFilter;
  body_template: string;
  unitId?: string;
  flyer_url?: string;
  /** Estimated audience computed at draft time (stats.audience seed). */
  estimatedAudience?: number;
  seedContactIds?: string[];
  audienceMode?: BroadcastAudienceMode;
  /**
   * share-skip-fix D4: `'dashboard'` when the authenticated dashboard draft
   * route created this share. The send job sends such a share as a PERSON'S
   * send (no switch, no breaker). Absent = automated (a draft created before
   * 2026-09-25, or by any other path, including a future engine).
   */
  createdVia?: 'dashboard';
}

export interface BroadcastsRepo {
  /** Create a DRAFT broadcast (generates broadcastId); returns the stored item. */
  create(input: CreateBroadcastInput): Promise<BroadcastItem>;
  getById(broadcastId: string): Promise<BroadcastItem | undefined>;
  /**
   * SOR (spec D11, D16a): `getById` with ConsistentRead - for a continuation's
   * snapshot and for finalize, which must not decide from a stale image.
   */
  getByIdConsistent(broadcastId: string): Promise<BroadcastItem | undefined>;
  /** ALL broadcasts (team-wide), newest-first, via the byCreated GSI. */
  list(opts?: ListBroadcastsOpts): Promise<BroadcastsPage>;
  /**
   * Team-wide broadcasts in one lifecycle status, newest-first: the byCreated
   * GSI + a FilterExpression on status. DynamoDB applies Limit BEFORE the
   * filter, so a page can return fewer than `limit` items (even zero) while
   * still carrying a lastEvaluatedKey — callers page until the cursor is gone,
   * never until a short page.
   */
  listByStatus(status: BroadcastStatus, opts?: ListBroadcastsOpts): Promise<BroadcastsPage>;
  /**
   * List the broadcasts targeting a unit via the sparse byUnit GSI (only
   * broadcasts WITH a unitId index here). One page per call; the composer
   * flag's prior-recipients walk (services/shareRecipientState.ts
   * priorRecipientKeys, which owns the "Already sent" rule) pages them.
   */
  listByUnit(unitId: string, opts?: ListBroadcastsOpts): Promise<BroadcastsPage>;
  /**
   * Persist the resolved recipients map + audience count, then flip to
   * `sending` — one conditional write, gated on the broadcast still being a
   * draft (so a double-send can't re-seed mid-flight). Throws
   * ConditionalCheckFailedException when the broadcast is missing or not a
   * draft.
   */
  markSending(
    broadcastId: string,
    recipients: Record<string, BroadcastRecipient>,
  ): Promise<BroadcastItem>;
  /**
   * Replace the draft's hand-picked seed_contact_ids (the review step's curated
   * additions / the seeded 1:1 entry). One conditional write gated on the
   * broadcast still being a `draft` (a sent/sending broadcast's recipients are
   * frozen). An EMPTY array is VALID here — it CLEARS the seed list. Throws
   * ConditionalCheckFailedException when the broadcast is missing or not a
   * draft (mirrors markSending's conditional shape).
   */
  setSeedContactIds(broadcastId: string, seedContactIds: string[]): Promise<BroadcastItem>;
  /**
   * Set one recipient's delivery slot on the nested `recipients` map.
   *
   * Without `allowedPriorStatuses` this is a blind SET (the send job seeds the
   * slot the first time). WITH it, the write is CONDITIONAL on the slot's
   * current nested `status` being one of the allowed predecessors — an atomic
   * forward-only transition that two concurrent callbacks can't both win.
   * Returns `true` when the write applied, `false` on a
   * ConditionalCheckFailedException (another writer already transitioned the
   * slot) so the caller can gate exactly-once side effects (e.g. stats).
   */
  setRecipient(
    broadcastId: string,
    contactKey: string,
    recipient: BroadcastRecipient,
    allowedPriorStatuses?: ReadonlyArray<BroadcastRecipient['status']>,
  ): Promise<boolean>;
  /**
   * Claim ONE pass of the fan-out CONTINUATION ladder (M5): an atomic
   * conditional ADD on the top-level `fanout_attempt`, refused once the count
   * has reached `cap`.
   *
   * `cap` is a PARAMETER because the cap constant lives in `jobs/` and a repo
   * must not import from there. The count is a top-level scalar deliberately:
   * `setRecipient` rewrites a recipient slot WHOLESALE, so a counter inside one
   * would read 1 forever and the cap-and-close branch would stay unreachable
   * (design D2). Absent on pre-M5 rows - ADD creates it, so the first claim
   * returns 1 with no migration (D4).
   */
  claimFanoutPass(broadcastId: string, cap: number): Promise<FanoutClaimResult>;
  /** Atomically add a delta to stats counters (ADD on each present field). */
  bumpStats(broadcastId: string, delta: Partial<BroadcastStats>): Promise<BroadcastItem>;
  /**
   * SOR (spec D8, D8a): ONE conditional write that sets a recipient's slot
   * wholesale AND adds `statsDelta` to the stats counters, only while the
   * slot's current status is one of `allowedPriorStatuses` - so a slot move
   * and its counters can never disagree, and a stale snapshot never overwrites
   * a later outcome. Buckets with a zero (or absent) delta are left out; an
   * EMPTY delta writes the slot only. `{ moved: true, item }` (the item as
   * written) or `{ moved: false }` (the slot is absent or in another status,
   * or the broadcast is missing). An empty prior list is a TypeError.
   */
  recordRecipientOutcome(
    broadcastId: string,
    contactKey: string,
    recipient: BroadcastRecipient,
    statsDelta: Partial<BroadcastStats>,
    allowedPriorStatuses: ReadonlyArray<BroadcastRecipient['status']>,
  ): Promise<{ moved: boolean; item?: BroadcastItem }>;
  /**
   * share-sent-outcome D2: the attempt-ordered slot write. Applies `next`
   * (the whole slot) and ADDs `statsDelta` in ONE conditional write whose
   * condition names the attempt the slot currently records (`latestAttempt`,
   * absent for the original) AND its status - so a newer attempt can leave
   * `failed`, a delayed callback for a superseded attempt cannot, and two
   * writers racing on one slot cannot both win. `{ applied: false }` on a
   * failed condition (the caller re-reads and re-decides, spec D2), a missing
   * broadcast or slot included; anything else throws. Buckets with a zero (or
   * absent) delta are left out; an EMPTY delta writes the slot only.
   */
  applyAttemptOutcome(
    broadcastId: string,
    contactKey: string,
    expect: AttemptOutcomeExpect,
    next: BroadcastRecipient,
    statsDelta: Partial<BroadcastStats>,
  ): Promise<{ applied: boolean; item?: BroadcastItem }>;
  /**
   * share-sent-outcome D5: BatchGet by id (chunks of 100; unprocessed keys are
   * retried once, then WARNed with their ids and left absent). `projection:
   * 'stats'` reads broadcastId, status, unitId, recipients, stats only (a
   * share item can run to 300 KB; a page of them must stay under BatchGet's
   * 16 MB response). Missing ids are absent; duplicate ids are read once.
   */
  getByIds(broadcastIds: string[], opts?: { projection?: 'stats' }): Promise<Map<string, BroadcastItem>>;
  /**
   * SOR (spec D8, D22): close a still-`queued` recipient `failed` with
   * `errorCode`, moving one count from `queued` to `statsBucket` - the cap and
   * enqueue-failure closes (`failed`) and the unresolved close (`unconfirmed`).
   * `recordRecipientOutcome` with `['queued']` as the only prior.
   */
  closeRecipientIfQueued(
    broadcastId: string,
    contactKey: string,
    errorCode: string,
    statsBucket: 'failed' | 'unconfirmed',
  ): Promise<{ moved: boolean; item?: BroadcastItem }>;
  /**
   * SOR (spec D16a): the terminal flip ONE writer wins - conditional on the
   * broadcast still being `sending`. `{ won: true, item }` for the writer that
   * flipped it (it alone audits and emits); `{ won: false, item }` (a
   * consistent read) for everyone else. Throws when the broadcast is missing.
   */
  finalizeStatus(
    broadcastId: string,
    status: 'sent' | 'failed',
    lastError?: string,
  ): Promise<{ won: boolean; item: BroadcastItem }>;
  /** Flip to `sent` (terminal). */
  markSent(broadcastId: string): Promise<BroadcastItem>;
  /** Flip to `failed` (terminal); records last_error. */
  markFailed(broadcastId: string, lastError?: string): Promise<BroadcastItem>;
  /**
   * Delete a broadcast — ONLY when it is still a draft (a sending/sent/failed
   * broadcast is permanent). One conditional DeleteCommand gated on
   * `attribute_exists(broadcastId) AND status='draft'`: the condition is the
   * race guard — a concurrent send that flipped draft→sending between the
   * route's read and this delete fails the condition (never a silent delete of
   * a sent broadcast). Returns a discriminated result the route maps to
   * 200 / 404 / 409 (on the conditional failure a follow-up getById tells
   * `not_found` from `not_draft`).
   */
  delete(broadcastId: string): Promise<DeleteBroadcastResult>;
}

/**
 * share-sent-outcome D2: what `applyAttemptOutcome` expects the slot to hold -
 * its status and the attempt it records (`undefined` = the slot records no
 * `latestAttempt`, i.e. the original send is its newest attempt).
 */
export interface AttemptOutcomeExpect {
  status: BroadcastRecipient['status'];
  latestAttempt: string | undefined;
}

/** Outcome of a draft-only delete (the route maps it to 200 / 404 / 409). */
export type DeleteBroadcastResult =
  | { deleted: true }
  | { deleted: false; reason: 'not_found' | 'not_draft' };

export function createBroadcastsRepo(deps: RepoDeps = {}): BroadcastsRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('broadcasts', deps.env);
  const log = deps.logger ?? defaultLogger;

  /** SOR (spec D11): `getById` and its consistent twin share this ONE read. */
  async function readById(broadcastId: string, consistent: boolean): Promise<BroadcastItem | undefined> {
    const { Item } = await doc.send(
      new GetCommand({ TableName: table, Key: { broadcastId }, ...(consistent && { ConsistentRead: true }) }),
    );
    return Item as BroadcastItem | undefined;
  }

  async function getById(broadcastId: string): Promise<BroadcastItem | undefined> {
    return readById(broadcastId, false);
  }

  /**
   * SOR (spec D8, D8a): the slot AND its counters in ONE conditional write.
   * Names and values are built per statement - only buckets with a non-zero
   * delta are aliased (an unused alias is a ValidationException), and an
   * EMPTY delta leaves the ADD clause out entirely.
   */
  async function recordOutcome(
    broadcastId: string,
    contactKey: string,
    recipient: BroadcastRecipient,
    statsDelta: Partial<BroadcastStats>,
    allowedPriorStatuses: ReadonlyArray<BroadcastRecipient['status']>,
  ): Promise<{ moved: boolean; item?: BroadcastItem }> {
    if (allowedPriorStatuses.length === 0) {
      throw new TypeError('recordRecipientOutcome: at least one allowed prior status is required');
    }
    const names: Record<string, string> = { '#ck': contactKey, '#updatedAt': 'updated_at', '#status': 'status' };
    const values: Record<string, unknown> = { ':rec': recipient, ':now': new Date().toISOString() };
    const priors = allowedPriorStatuses.map((status, i) => {
      values[`:ps${i}`] = status;
      return `:ps${i}`;
    });
    const adds: string[] = [];
    for (const [bucket, delta] of Object.entries(statsDelta)) {
      if (typeof delta !== 'number' || delta === 0) continue;
      const i = adds.length;
      names[`#a${i}`] = bucket;
      values[`:v${i}`] = delta;
      adds.push(`stats.#a${i} :v${i}`);
    }
    try {
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { broadcastId },
          UpdateExpression:
            `SET recipients.#ck = :rec, #updatedAt = :now` + (adds.length > 0 ? ` ADD ${adds.join(', ')}` : ''),
          ConditionExpression: `attribute_exists(broadcastId) AND recipients.#ck.#status IN (${priors.join(', ')})`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      return { moved: true, item: Attributes as BroadcastItem };
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return { moved: false };
      throw err;
    }
  }

  /** Shared GSI query (one partition, optional status filter + pagination). */
  async function queryIndex(
    indexName: string,
    keyName: string,
    keyValue: string,
    opts: ListBroadcastsOpts,
    scanIndexForward = true,
    statusFilter?: BroadcastStatus,
  ): Promise<BroadcastsPage> {
    // `status` is a DynamoDB reserved word → expression-aliased.
    const input: QueryCommandInput = {
      TableName: table,
      IndexName: indexName,
      KeyConditionExpression: '#k = :v',
      ExpressionAttributeNames: {
        '#k': keyName,
        ...(statusFilter !== undefined && { '#s': 'status' }),
      },
      ExpressionAttributeValues: {
        ':v': keyValue,
        ...(statusFilter !== undefined && { ':s': statusFilter }),
      },
      // Limit applies BEFORE the filter (see listByStatus's contract note).
      ...(statusFilter !== undefined && { FilterExpression: '#s = :s' }),
      ScanIndexForward: scanIndexForward,
      ...(opts.limit !== undefined && { Limit: opts.limit }),
      ...(opts.exclusiveStartKey !== undefined && {
        ExclusiveStartKey: opts.exclusiveStartKey as QueryCommandInput['ExclusiveStartKey'],
      }),
    };
    const { Items, LastEvaluatedKey } = await doc.send(new QueryCommand(input));
    return {
      items: (Items ?? []) as BroadcastItem[],
      ...(LastEvaluatedKey !== undefined && { lastEvaluatedKey: LastEvaluatedKey }),
    };
  }

  /** SET a terminal status + updated_at, returning ALL_NEW. */
  async function flipStatus(
    broadcastId: string,
    status: BroadcastStatus,
    lastError?: string,
  ): Promise<BroadcastItem> {
    const now = new Date().toISOString();
    const sets = ['#s = :status', 'updated_at = :now'];
    const names: Record<string, string> = { '#s': 'status' };
    const values: Record<string, unknown> = { ':status': status, ':now': now };
    if (lastError !== undefined) {
      sets.push('last_error = :err');
      values[':err'] = lastError;
    }
    const { Attributes } = await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { broadcastId },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_exists(broadcastId)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    log.info({ broadcastId, status }, 'broadcast status set');
    return Attributes as BroadcastItem;
  }

  return {
    getById,

    async getByIdConsistent(broadcastId) {
      return readById(broadcastId, true);
    },

    async create(input) {
      const now = new Date().toISOString();
      const stats = zeroStats();
      if (typeof input.estimatedAudience === 'number') stats.audience = input.estimatedAudience;
      const item: BroadcastItem = {
        broadcastId: input.broadcastId ?? `bcast-${randomUUID()}`,
        created_by: input.created_by,
        created_at: now,
        _listPartition: LIST_PARTITION, // byCreated GSI membership
        status: 'draft',
        audience_filter: input.audience_filter,
        body_template: input.body_template,
        stats,
        recipients: {},
        updated_at: now,
        ...(input.unitId !== undefined && { unitId: input.unitId }),
        ...(input.flyer_url !== undefined && { flyer_url: input.flyer_url }),
        ...(input.seedContactIds !== undefined &&
          input.seedContactIds.length > 0 && { seed_contact_ids: input.seedContactIds }),
        ...(input.audienceMode !== undefined && { audience_mode: input.audienceMode }),
        ...(input.createdVia !== undefined && { created_via: input.createdVia }),
      };
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(broadcastId)',
        }),
      );
      log.info({ broadcastId: item.broadcastId, createdBy: item.created_by }, 'broadcast draft created');
      return item;
    },

    async list(opts = {}) {
      // Newest-first: byCreated sorts on created_at; descending.
      return queryIndex('byCreated', '_listPartition', LIST_PARTITION, opts, false);
    },

    async listByStatus(status, opts = {}) {
      // Same partition, post-Query status filter (see the interface's paging note).
      return queryIndex('byCreated', '_listPartition', LIST_PARTITION, opts, false, status);
    },

    async listByUnit(unitId, opts = {}) {
      // Sparse byUnit GSI (unit-less broadcasts never index here).
      return queryIndex('byUnit', 'unitId', unitId, opts);
    },

    async markSending(broadcastId, recipients) {
      const now = new Date().toISOString();
      const audience = Object.keys(recipients).length;
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { broadcastId },
          UpdateExpression:
            'SET #s = :sending, recipients = :r, stats.audience = :aud, stats.queued = :aud, updated_at = :now',
          // Only a DRAFT may be sent — a concurrent/duplicate send fails here
          // and the route no-ops (idempotent), so recipients are never re-seeded
          // mid-flight (which would reset the per-recipient delivery map).
          ConditionExpression: 'attribute_exists(broadcastId) AND #s = :draft',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':sending': 'sending',
            ':draft': 'draft',
            ':r': recipients,
            ':aud': audience,
            ':now': now,
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ broadcastId, audience }, 'broadcast marked sending');
      return Attributes as BroadcastItem;
    },

    async setSeedContactIds(broadcastId, seedContactIds) {
      // Only a DRAFT may have its seeds re-picked — a sending/sent broadcast's
      // recipients are frozen, so the same status='draft' condition markSending
      // uses guards this write. An EMPTY array is a valid CLEAR (SET seeds to
      // []). A missing/non-draft broadcast fails the condition and surfaces the
      // ConditionalCheckFailedException for the route to map to 404/409.
      const now = new Date().toISOString();
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { broadcastId },
          UpdateExpression: 'SET seed_contact_ids = :s, updated_at = :now',
          ConditionExpression: 'attribute_exists(broadcastId) AND #s = :draft',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': seedContactIds, ':draft': 'draft', ':now': now },
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ broadcastId, seedCount: seedContactIds.length }, 'broadcast seeds replaced');
      return Attributes as BroadcastItem;
    },

    async setRecipient(broadcastId, contactKey, recipient, allowedPriorStatuses) {
      // CHILD-ONLY SET of the recipient slot. The parent `recipients` map is
      // always pre-seeded by markSending (`SET ... recipients = :r ...`), and
      // the /send route only enqueues the fan-out AFTER markSending succeeds —
      // so `recipients` always exists when this runs. DynamoDB rejects an
      // UpdateExpression that SETs both a map and a child of that map in one
      // statement (overlapping document paths), so we must NOT also seed the
      // parent here. contactKey may contain `#` (phone keys) — bind as an
      // aliased name (dotted-path safe).
      const names: Record<string, string> = { '#ck': contactKey };
      const values: Record<string, unknown> = { ':rec': recipient };
      let condition = 'attribute_exists(broadcastId)';
      if (allowedPriorStatuses !== undefined) {
        // Atomic forward-only transition: only apply when the slot's NESTED
        // `status` is one of the allowed predecessors (dotted-path on the map
        // entry via aliased names). Two concurrent callbacks racing the same
        // transition: exactly ONE passes the condition; the loser throws
        // ConditionalCheckFailedException → returns false (no stat double-bump).
        names['#status'] = 'status';
        const statusPlaceholders = allowedPriorStatuses.map((s, i) => {
          const k = `:ps${i}`;
          values[k] = s;
          return k;
        });
        condition += ` AND recipients.#ck.#status IN (${statusPlaceholders.join(', ')})`;
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { broadcastId },
            UpdateExpression: 'SET recipients.#ck = :rec',
            ConditionExpression: condition,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          }),
        );
        return true;
      } catch (err) {
        if (allowedPriorStatuses !== undefined && err instanceof ConditionalCheckFailedException) {
          // The slot was no longer in an allowed prior state — another writer
          // already transitioned it. Treat as a no-op (caller skips the bump).
          return false;
        }
        throw err;
      }
    },

    async claimFanoutPass(broadcastId, cap) {
      // One conditional ADD, no read first: the condition IS the cap, so two
      // concurrent deliveries can never take the same pass number. The counter
      // name is aliased (`#fa`) to keep the reserved-word question off the
      // table, and UPDATED_NEW hands back only the counter rather than the whole
      // item (which carries the recipients map).
      let attempt: number | undefined;
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { broadcastId },
            UpdateExpression: 'ADD #fa :one',
            ConditionExpression:
              'attribute_exists(broadcastId) AND (attribute_not_exists(#fa) OR #fa < :cap)',
            ExpressionAttributeNames: { '#fa': 'fanout_attempt' },
            ExpressionAttributeValues: { ':one': 1, ':cap': cap },
            ReturnValues: 'UPDATED_NEW',
          }),
        );
        attempt = (Attributes as { fanout_attempt?: number } | undefined)?.fanout_attempt;
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // The refusal is ambiguous - missing broadcast or spent ladder - and the
        // two demand different handling (close vs log-and-return). Only a
        // STRONGLY consistent read separates them; getById above is eventually
        // consistent and could report a live broadcast missing, skipping a
        // close.
        const { Item } = await doc.send(
          new GetCommand({ TableName: table, Key: { broadcastId }, ConsistentRead: true }),
        );
        if (Item === undefined) return { outcome: 'missing' };
        const current = (Item as BroadcastItem).fanout_attempt;
        return { outcome: 'capped', attempt: typeof current === 'number' ? current : 0 };
      }
      if (typeof attempt !== 'number') {
        throw new Error(`claimFanoutPass(${broadcastId}): UPDATED_NEW returned no fanout_attempt`);
      }
      return { outcome: 'claimed', attempt };
    },

    async bumpStats(broadcastId, delta) {
      // ADD each present counter (atomic increment). stats fields pre-exist
      // (create/markSending seed them), so ADD on a nested numeric attribute is
      // safe. updated_at is bumped alongside.
      const adds: string[] = [];
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      let i = 0;
      for (const [key, value] of Object.entries(delta)) {
        if (typeof value !== 'number' || value === 0) continue;
        const nameKey = `#sk${i}`;
        const valueKey = `:sv${i}`;
        names[nameKey] = key;
        values[valueKey] = value;
        adds.push(`stats.${nameKey} ${valueKey}`);
        i += 1;
      }
      if (adds.length === 0) {
        const existing = await getById(broadcastId);
        if (!existing) {
          throw new ConditionalCheckFailedException({
            message: `bumpStats: broadcast ${broadcastId} not found`,
            $metadata: {},
          });
        }
        return existing;
      }
      names['#updatedAt'] = 'updated_at';
      values[':now'] = new Date().toISOString();
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { broadcastId },
          UpdateExpression: `ADD ${adds.join(', ')} SET #updatedAt = :now`,
          ConditionExpression: 'attribute_exists(broadcastId)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      return Attributes as BroadcastItem;
    },

    recordRecipientOutcome: recordOutcome,

    async applyAttemptOutcome(broadcastId, contactKey, expect, next, statsDelta) {
      // recordOutcome's expression style: names and values are built per
      // statement, so `:pa` is bound only when the condition names an attempt
      // and only non-zero buckets are aliased (an unused alias is a
      // ValidationException); an EMPTY delta leaves the ADD clause out.
      const names: Record<string, string> = { '#ck': contactKey, '#updatedAt': 'updated_at', '#status': 'status', '#la': 'latestAttempt' };
      const values: Record<string, unknown> = { ':rec': next, ':now': new Date().toISOString(), ':ps': expect.status };
      let attemptCond = 'attribute_not_exists(recipients.#ck.#la)';
      if (expect.latestAttempt !== undefined) {
        values[':pa'] = expect.latestAttempt;
        attemptCond = 'recipients.#ck.#la = :pa';
      }
      const adds: string[] = [];
      for (const [bucket, delta] of Object.entries(statsDelta)) {
        if (typeof delta !== 'number' || delta === 0) continue;
        const i = adds.length;
        names[`#a${i}`] = bucket;
        values[`:v${i}`] = delta;
        adds.push(`stats.#a${i} :v${i}`);
      }
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { broadcastId },
            UpdateExpression:
              `SET recipients.#ck = :rec, #updatedAt = :now` + (adds.length > 0 ? ` ADD ${adds.join(', ')}` : ''),
            ConditionExpression: `attribute_exists(broadcastId) AND recipients.#ck.#status = :ps AND ${attemptCond}`,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: 'ALL_NEW',
          }),
        );
        return { applied: true, item: Attributes as BroadcastItem };
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return { applied: false };
        throw err;
      }
    },

    async getByIds(broadcastIds, opts) {
      const out = new Map<string, BroadcastItem>();
      const ids = [...new Set(broadcastIds)];
      const projection =
        opts?.projection === 'stats'
          ? { ProjectionExpression: 'broadcastId, #s, unitId, recipients, stats', ExpressionAttributeNames: { '#s': 'status' } }
          : {};
      for (let i = 0; i < ids.length; i += 100) {
        let keys: Array<{ broadcastId: string }> = ids.slice(i, i + 100).map((broadcastId) => ({ broadcastId }));
        // The first read, then ONE retry of whatever DynamoDB left unprocessed.
        for (let round = 0; round < 2 && keys.length > 0; round += 1) {
          const res = await doc.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: keys, ...projection } } }));
          for (const item of (res.Responses?.[table] ?? []) as BroadcastItem[]) out.set(item.broadcastId, item);
          keys = (res.UnprocessedKeys?.[table]?.Keys ?? []) as Array<{ broadcastId: string }>;
        }
        if (keys.length > 0) {
          log.warn(
            { count: keys.length, broadcastIds: keys.map((k) => k.broadcastId) },
            'broadcasts getByIds: keys still unprocessed after one retry - left absent',
          );
        }
      }
      return out;
    },

    async closeRecipientIfQueued(broadcastId, contactKey, errorCode, statsBucket) {
      const delta: Partial<BroadcastStats> = { queued: -1 };
      delta[statsBucket] = 1;
      return recordOutcome(broadcastId, contactKey, { status: 'failed', errorCode }, delta, ['queued']);
    },

    async finalizeStatus(broadcastId, status, lastError) {
      // flipStatus's expression, conditioned on `sending`: N callers, ONE flip.
      // Plus a fresh op token (code review ADV-3, fix FW1-5): the SDK's replay
      // of a flip that COMMITTED fails its own condition, and only the token
      // on the read-back tells that winner from a genuine loser - without it
      // the real winner would skip the unit audit row and the terminal emit.
      const op = randomUUID();
      const sets = ['#s = :status', 'updated_at = :now', '#fop = :op'];
      const values: Record<string, unknown> = {
        ':status': status,
        ':now': new Date().toISOString(),
        ':op': op,
        ':sending': 'sending',
      };
      if (lastError !== undefined) {
        sets.push('last_error = :err');
        values[':err'] = lastError;
      }
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { broadcastId },
            UpdateExpression: `SET ${sets.join(', ')}`,
            ConditionExpression: 'attribute_exists(broadcastId) AND #s = :sending',
            ExpressionAttributeNames: { '#s': 'status', '#fop': 'finalize_op' },
            ExpressionAttributeValues: values,
            ReturnValues: 'ALL_NEW',
          }),
        );
        log.info({ broadcastId, status }, 'broadcast status finalized');
        return { won: true, item: Attributes as BroadcastItem };
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
      }
      const item = await readById(broadcastId, true);
      if (item === undefined) throw new Error(`finalizeStatus: broadcast ${broadcastId} not found`);
      if (item.finalize_op === op) {
        log.info({ broadcastId, status }, 'broadcast status finalized (the flip committed on an earlier SDK attempt)');
        return { won: true, item };
      }
      log.info(
        { broadcastId, status, currentStatus: item.status },
        'broadcast finalize not taken - the broadcast is no longer sending',
      );
      return { won: false, item };
    },

    async markSent(broadcastId) {
      return flipStatus(broadcastId, 'sent');
    },

    async markFailed(broadcastId, lastError) {
      return flipStatus(broadcastId, 'failed', lastError);
    },

    async delete(broadcastId) {
      // Conditional delete: only a DRAFT may be deleted. The condition is the
      // race guard — a concurrent send that flipped draft→sending between the
      // route's read and here fails the condition (no silent delete of a sent
      // broadcast). On ConditionalCheckFailedException a follow-up getById
      // distinguishes a missing broadcast (404) from a non-draft one (409),
      // mirroring markSending's CCF handling.
      try {
        await doc.send(
          new DeleteCommand({
            TableName: table,
            Key: { broadcastId },
            ConditionExpression: 'attribute_exists(broadcastId) AND #s = :draft',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':draft': 'draft' },
          }),
        );
        log.info({ broadcastId }, 'broadcast draft deleted');
        return { deleted: true };
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          const existing = await getById(broadcastId);
          return existing === undefined
            ? { deleted: false, reason: 'not_found' }
            : { deleted: false, reason: 'not_draft' };
        }
        throw err;
      }
    },
  };
}
