// messages repo — the append-only conversation log (doc §5).
//
// SK shape: `<ISO ts>#<msgId>` where ts is the PROVIDER's message timestamp
// (stable across Twilio redeliveries) and msgId is the provider SID — so the
// same provider message always computes the same key, and the conditional
// append makes redeliveries/echoes a no-op. This is the §7.1 MessageSid
// idempotency primitive: outbound messages persist at send time, so the
// webhook echo of our own send dedupes here instead of re-entering pipelines.
//
// SID→location pointer: every append also writes `{ PK: sid#<providerSid>,
// SK: ptr }` carrying conversationId + tsMsgId, in the SAME transaction —
// Twilio status callbacks identify messages by SID alone and recover context
// by lookup (doc §9). Pointer partitions (`sid#…`, and the `job#…` execution
// markers below) never collide with real conversation partitions, so
// listByConversation never sees them.
//
// PII: message bodies must NEVER be logged (doc §9) — IDs and lengths only.
import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { RepoDeps } from './conversationsRepo.js';

export type MessageType = 'sms' | 'mms' | 'call' | 'email';
export type MessageDirection = 'inbound' | 'outbound';

/**
 * Voice call lifecycle (M1.9a, doc §7.1 masked calling). Mirrors Twilio's
 * CallStatus values verbatim so the status-callback mapping is identity. A
 * call entry is a metadata-only timeline item — masked calls are NEVER
 * recorded/transcribed (recording_s3_key/transcript stay UNPOPULATED here).
 */
export type CallStatus =
  | 'ringing'
  | 'in-progress'
  | 'completed'
  | 'no-answer'
  | 'busy'
  | 'failed'
  | 'canceled';

/**
 * Coarse human-facing outcome derived from CallStatus + whether a leg
 * connected (M1.9a): `answered` (a leg picked up), `missed` (nobody answered /
 * busy / failed), `voicemail` (reserved — masked calls press-1-gate to block
 * carrier voicemail, so this is the founder-bridge seam, unused here).
 */
export type CallOutcome = 'answered' | 'missed' | 'voicemail';

/**
 * Transcript lifecycle status on a call entity (voice-transcription spec 3.7),
 * driving the in-flight "Transcribing..." indicator on the call bubble. ABSENT
 * when no transcript will ever be requested (masked calls, VI unconfigured,
 * pre-feature calls): 'pending' is stamped the moment a transcript WILL be
 * requested, 'completed' is stamped atomically by setCallTranscript, 'failed'
 * when the pipeline gives up. A late successful persist may upgrade
 * failed -> completed; completed is terminal.
 */
export type TranscriptStatus = 'pending' | 'completed' | 'failed';

/** Forward-only CallStatus progression: which prior statuses each may overwrite. */
const ALLOWED_PRIOR_CALL_STATUS: Record<CallStatus, CallStatus[]> = {
  // Non-terminal: ringing may only be the first write (nothing transitions INTO it).
  ringing: [],
  // in-progress (answered) can follow ringing.
  'in-progress': ['ringing'],
  // Terminal states may follow either non-terminal state; terminals never regress.
  completed: ['ringing', 'in-progress'],
  'no-answer': ['ringing', 'in-progress'],
  busy: ['ringing', 'in-progress'],
  failed: ['ringing', 'in-progress'],
  canceled: ['ringing', 'in-progress'],
};

export function allowedPriorCallStatuses(next: CallStatus): CallStatus[] {
  return ALLOWED_PRIOR_CALL_STATUS[next];
}
/**
 * Who authored the message (doc §5; `ai` is Phase 2). `unknown` is the
 * operator-mandated honesty value (deviations table 2026-06-12): inbound from
 * an unreviewed contact must not be recorded as a guessed `tenant` — it
 * resolves when the contact is typed in the M1.4/M1.5 review flows. `system`
 * is an app-authored relay announcement (relay intro / tour reminder rung —
 * services/relayAnnouncements.ts): no human wrote it, so neither `teammate`
 * nor `ai` would be honest.
 */
export type MessageAuthor = 'tenant' | 'landlord' | 'partner' | 'teammate' | 'ai' | 'unknown' | 'system';

/**
 * Outbound delivery status machine (doc §7.1):
 * queued_pending -> queued -> sent -> delivered | undelivered | failed. Terminal
 * states never regress (a delivered message stays delivered).
 *
 * 'queued_pending' (relay number buying strategy T7) is a PRE-queued hold: a team
 * message composed on a CONNECTING relay group (one whose dedicated number is
 * still warming/registering) is persisted queued_pending and sent to nobody. When
 * relay.numberReady opens the group, flushQueuedMessages transitions each held
 * message queued_pending -> queued and enqueues the normal relay fan-out. It is
 * the earliest state - forward-only, so it can only move toward queued/sent.
 */
export type DeliveryStatus =
  | 'queued_pending'
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'undelivered'
  | 'failed';

/** Statuses a given new status may overwrite — forward-only transitions. */
const ALLOWED_PRIOR: Record<DeliveryStatus, DeliveryStatus[]> = {
  queued_pending: [],
  // queued_pending -> queued is the flush transition (T7): a held message enters
  // the normal send path the instant its connecting group opens.
  queued: ['queued_pending'],
  sent: ['queued', 'queued_pending'],
  delivered: ['queued', 'sent'],
  undelivered: ['queued', 'sent'],
  failed: ['queued', 'sent'],
};

export function allowedPriorStatuses(next: DeliveryStatus): DeliveryStatus[] {
  return ALLOWED_PRIOR[next];
}

/**
 * Per-recipient delivery state for a relay-group fan-out (M1.7). The relayed
 * message is stored ONCE (the inbound source message); this map records the
 * outbound delivery to each OTHER member, keyed by member key
 * (relayMemberKey() below). Each entry runs the SAME forward-only status
 * machine as 1:1 delivery_status, independently per recipient.
 */
export interface RelayRecipientDelivery {
  status: DeliveryStatus;
  /** Provider SID of the per-recipient outbound send (Twilio SMxxx). */
  sid?: string;
  errorCode?: string;
  sentAt?: string;
  deliveredAt?: string;
}

/**
 * Stable member key for relay delivery maps + relaysid pointers: the
 * contactId when the member has one, else `phone#<E164>`. Used as the
 * delivery_recipients map key and stored on the relaysid pointer so a
 * delivery callback can find the right recipient slot to update.
 */
export function relayMemberKey(member: { contactId?: string; phone: string }): string {
  return member.contactId && member.contactId.length > 0
    ? member.contactId
    : `phone#${member.phone}`;
}

/** Deterministic SK: same provider message → same key, every delivery. */
export function buildTsMsgId(providerTs: string, providerSid: string): string {
  return `${providerTs}#${providerSid}`;
}

/**
 * The rail a group send went out on, snapshotted onto the message row.
 * `participantMap` is MBxx -> member key (`phone#<E164>`, spec 15.6).
 */
export interface GroupRailSnapshot {
  conversationSid: string;
  participantMap: Record<string, string>;
}

/**
 * One row in a synthetic DEADLINE partition on the messages table (spec 15.5).
 * `sortKey` MUST start with the ISO 8601 deadline so a sweep can Query the
 * overdue range lexicographically; `attributes` carries the non-key payload
 * (kind, ref pointers, and - as CLEANUP ONLY - an `expires_at` horizon far past
 * the deadline). TTL IS enabled on this table, so a due row that carried a
 * short `expires_at` would be reaped BEFORE its own alarm: TTL is never the
 * alarm mechanism.
 */
export interface MessageDueRow {
  /** Synthetic partition key, e.g. GROUP_SEND_DUE_PARTITION. */
  partition: string;
  /** `<ISO deadline>#<kind>#<id>`. */
  sortKey: string;
  attributes: Record<string, unknown>;
}

/**
 * A group delivery receipt held until its message row exists (spec 15.2a). The
 * status is the RAW Conversations value: the park is a transport, and mapping
 * it twice would bake this slice's vocabulary into stored data.
 */
export interface ParkedGroupReceipt {
  /** IMxx - the Conversations message the receipt is about. */
  messageSid: string;
  /** MBxx - which participant this leg went to. */
  participantSid: string;
  status: string;
  errorCode?: string;
  /** The per-member carrier SID (SMxx). */
  channelMessageSid?: string;
  parkedAt: string;
}

/** A due row as the sweep reads it back. */
export interface GroupDueRow {
  partition: string;
  sortKey: string;
  /** Discriminator, e.g. GROUP_SEND_DUE_KIND. */
  kind: string;
  /** ISO 8601 instant this row became actionable. */
  deadlineAt: string;
  /** The message the row is about. */
  ref: { conversationId: string; tsMsgId: string };
  providerSid?: string;
  /** Cross-check rows only: the rail the event arrived on (CHxx). */
  conversationSid?: string;
  /** Cross-check rows only: the external member who authored the event. */
  author?: string;
}

/**
 * ONE SYNTHETIC DEADLINE PARTITION PER SWEEP, NOT ONE SHARED BY BOTH.
 *
 * Both group guardrail sweeps discover work by Querying a deadline-prefixed
 * partition with a bounded `Limit`. When they shared a partition they also
 * shared that budget, and each dropped the other's rows with a `continue` AFTER
 * the limit had already been spent - so 50 overdue cross-check rows sorted
 * ahead of every stuck send and the send-staleness sweep examined ZERO sends,
 * exactly when both webhooks are most likely to be broken at once. A post-Limit
 * filter is never a correct way to share a partition (`conversationsRepo.ts`
 * says the same thing about `group_open`).
 *
 * Two fixed buckets (not per-day) keep due-discovery to a single Query each; at
 * this feature's scale (132 threads, one row per send, deleted as soon as it is
 * resolved) neither partition holds more than a handful of live rows.
 * Pointer/marker partitions like these never collide with real conversation
 * partitions, so listByConversation cannot see them.
 */
export const GROUP_SEND_DUE_PARTITION = 'groupdue#send';

/** The cross-check's own deadline partition. See GROUP_SEND_DUE_PARTITION. */
export const GROUP_CROSSCHECK_DUE_PARTITION = 'groupdue#xc';

/** Due-row discriminator for the per-send group delivery-staleness check. */
export const GROUP_SEND_DUE_KIND = 'group_send_staleness';

/**
 * How long after a group send its delivery receipts must have landed before the
 * staleness sweep alarms. Ten minutes: long enough that ordinary carrier
 * latency never trips it, short enough that a dead receipts webhook is noticed
 * the same morning it breaks.
 */
export const GROUP_SEND_STALENESS_MS = 10 * 60 * 1000;

/**
 * Cleanup horizon for a due row: far past the alarm deadline, so DynamoDB TTL
 * (best-effort, up to 48h late) can only ever reap a row the sweep already had
 * every chance to act on. 30 days.
 */
export const GROUP_DUE_CLEANUP_MS = 30 * 24 * 60 * 60 * 1000;

/** Deadline-prefixed sort key for a group send's staleness row. */
export function groupSendDueSortKey(deadlineIso: string, providerSid: string): string {
  return `${deadlineIso}#${GROUP_SEND_DUE_KIND}#${providerSid}`;
}

/**
 * Build the staleness due row for a group send. `deadlineAt` MUST already be
 * normalized (`new Date(x).toISOString()`) - the sort key is compared
 * LEXICOGRAPHICALLY, so `...00Z` and `...00.000Z` must collapse to one form.
 */
export function buildGroupSendDueRow(input: {
  conversationId: string;
  tsMsgId: string;
  providerSid: string;
  deadlineAt: string;
  /** Epoch SECONDS (DynamoDB TTL). Cleanup only - never the alarm. */
  expiresAt?: number;
}): MessageDueRow {
  return {
    partition: GROUP_SEND_DUE_PARTITION,
    sortKey: groupSendDueSortKey(input.deadlineAt, input.providerSid),
    attributes: {
      due_kind: GROUP_SEND_DUE_KIND,
      deadline_at: input.deadlineAt,
      ref_conversationId: input.conversationId,
      ref_tsMsgId: input.tsMsgId,
      provider_sid: input.providerSid,
      ...(input.expiresAt !== undefined && { expires_at: input.expiresAt }),
    },
  };
}

// --- Cross-check (T6.2) ------------------------------------------------------
//
// Three row shapes, all on the messages table, all in pointer/marker partitions
// `listByConversation` cannot see:
//
//  1. DEDUPE MARKER, `groupim#<IMxx>` / `ptr` - point-readable, conditional
//     create. Twilio redelivers webhooks; a redelivered event must not enter the
//     ledger twice.
//  2. PAIR LEDGER, `groupxc#<CHxx>#<memberKey>` - the (rail, author) pair. ONE
//     `state` item carries the signed BALANCE that decides every match (see
//     GROUP_CROSSCHECK_STATE_SORT_KEY), plus one `evt#<deadline>#<IMxx>` row per
//     event awaiting its classic filing. The `evt#` rows are the ALARM INDEX and
//     the oldest-first ordering that makes rapid same-author messages match
//     one-for-one; they are no longer what decides a match. There is no
//     `credit#` row shape any more - a credit is just a negative balance, which
//     is what makes the two halves impossible to interleave wrongly.
//  3. DUE ROW, in GROUP_CROSSCHECK_DUE_PARTITION, so the T6.3 sweep discovers
//     overdue events through the same KIND of deadline Query the staleness
//     sweep uses - but over its OWN partition, so neither sweep can spend the
//     other's row budget. Its `ref` points back at the pair row, so resolving an
//     alarm deletes both.
//  4. CLASSIC DEDUPE MARKER, `groupsm#<SMxx>` / `ptr` - the mirror image of (1)
//     for the CLASSIC half. Twilio redelivers the messaging webhook too, and a
//     redelivered filing used to bank a SECOND credit (the credit sort key
//     carries a fresh `filedAt`, so the Put was not idempotent). That phantom
//     credit is later consumed by a genuinely UNMATCHED event, which then never
//     goes pending and never alarms - the guardrail silently reporting health
//     while detection is down. The ledger must be dedupe-safe on BOTH sides.

/** Due-row discriminator for a cross-check event awaiting its classic filing. */
export const GROUP_CROSSCHECK_DUE_KIND = 'group_crosscheck_event';

/**
 * How long a Conversations event may sit unmatched before it alarms. Five
 * minutes: the two webhooks fire off the same carrier message, so real skew is
 * sub-second, and redelivery is the only legitimate source of minutes-scale lag.
 */
export const GROUP_CROSSCHECK_GRACE_MS = 5 * 60 * 1000;

/**
 * How far back a classic filing's credit stays claimable. Longer than the grace
 * window (an event that shows up 4 minutes late must still find its credit),
 * bounded so a stale credit cannot mask a genuine miss forever.
 */
export const GROUP_CROSSCHECK_CREDIT_MS = 15 * 60 * 1000;

/**
 * Cleanup horizon for cross-check rows. CLEANUP ONLY (A12) - TTL is best-effort
 * and up to 48h late, so it can only ever reap a row the sweep already had every
 * chance to act on. Never the alarm mechanism.
 */
export const GROUP_CROSSCHECK_CLEANUP_MS = 7 * 24 * 60 * 60 * 1000;

/** The (rail, author) pair partition both halves of the cross-check read. */
export function groupCrossCheckPairKey(conversationSid: string, memberKey: string): string {
  return `groupxc#${conversationSid}#${memberKey}`;
}

/**
 * THE PAIR STATE ITEM's sort key (fix wave 5, adversarial 3/9).
 *
 * One item per (rail, author) pair carrying a signed `balance`:
 *   balance > 0  -> that many Conversations events are awaiting their classic
 *                   filings (one `evt#` row each, plus a due row each);
 *   balance < 0  -> that many classic filings are banked as credits, the oldest
 *                   of them at `credit_since`;
 *   balance == 0 -> the pair is square.
 *
 * Both halves move it with ONE atomic `ADD`, which is what makes the ledger a
 * claim rather than a check-then-act pair of eventually-consistent Queries. It
 * sorts before both `credit#` and `evt#`, and `state` is not a valid prefix of
 * either, so it can never be mistaken for a ledger row.
 */
export const GROUP_CROSSCHECK_STATE_SORT_KEY = 'state';

/** How many oldest-first pending rows one claim will try before giving up. */
const CROSSCHECK_CLAIM_ATTEMPTS = 3;

/**
 * How the claim reads its window (fix wave 3, adversarial 2).
 *
 * `Limit` is applied by DynamoDB at the INDEX, before any filter - so filtering
 * `counted` in the caller after a `Limit: 3` let three UNCOUNTED rows shadow
 * every claimable row on the pair. Uncounted rows are by construction OLDER
 * than the counted rows written after them, and the range reads
 * oldest-deadline-first, so they sort ahead of the row that should be consumed:
 * the claim returned nothing, the filing logged
 * `group_crosscheck_pending_row_missing`, and the counted row alarmed at its
 * deadline. Re-issuing the identical Query returns the identical rows.
 *
 * So the filter rides the QUERY and the claim PAGES: `Limit` becomes a page
 * budget rather than the answer size, and a page that filters down to nothing
 * with a `LastEvaluatedKey` behind it is followed rather than read as "nothing
 * claimable". Bounded, because an unbounded walk of a pathological pair belongs
 * to no single webhook: at these sizes the claim can look past 100 uncounted
 * rows, and the sweep reaps those at their own deadlines.
 */
const CROSSCHECK_CLAIM_PAGE_SIZE = 25;
const CROSSCHECK_CLAIM_PAGES = 4;

/**
 * THE MID-TRANSITION WAIT (fix wave 4, item 2) - the window wave 3's paging left
 * open, and the one interleaving in this ledger that arrives on ORDINARY
 * traffic rather than after a fault.
 *
 * The event half writes the row, bumps the balance, THEN marks the row
 * `counted`. Between the bump and the mark the pair's balance says "one event is
 * pending" while no row is claimable. Twilio fires the classic webhook and the
 * Conversations webhook off ONE carrier message, concurrently, so a classic
 * filing landing inside that one-round-trip window is not exotic - it is the
 * shape the ledger exists to arbitrate. When it happens:
 *
 *   - the filing's ADD takes the slot and reports `matched`;
 *   - the claim finds zero COUNTED rows and returns undefined;
 *   - the caller logs `group_crosscheck_pending_row_missing`;
 *   - the mark then lands, and that row - already paid for by a filing that
 *     really arrived - sits until its deadline and raises
 *     `group_crosscheck_inbound_missing` at ERROR.
 *
 * That is a FALSE alarm on the one signal that says the undocumented
 * `OtherRecipients` envelope may have gone away, on healthy traffic. There is no
 * stolen-slot cascade behind it (the sweep's release is conditional on a
 * positive balance and the balance is already square), so the cost is exactly
 * one spurious ERROR plus one WARN - which is the cost that trains an operator
 * to ignore the alarm.
 *
 * Unlike the shadowing defect, RE-READING HELPS HERE: the row genuinely changes
 * under us, because the mark is one round trip behind the bump. So an empty read
 * is re-tried a bounded number of times a short beat apart. It costs nothing on
 * the ordinary path (a non-empty read never waits). The wait sits INSIDE the
 * claim-attempt loop, so the true worst case is `ATTEMPTS * READS * MS`
 * (~120ms) on a pair that reads non-empty but loses every conditional claim -
 * a rare case which ends in a WARN either way.
 */
const CROSSCHECK_MARK_WAIT_MS = 20;
const CROSSCHECK_MARK_WAIT_READS = 2;

/**
 * How many read-decide-write rounds the event half will take on one pair.
 *
 * Generous on purpose: the decision (matched-or-pending) depends on the balance
 * it was made against, so a concurrent writer must cause a RETRY rather than a
 * wrong answer - and a busy rail can put many events and filings on one pair
 * item at once. Each round is one consistent read plus one conditional write,
 * with a short randomized backoff so concurrent losers do not re-collide.
 */
const CROSSCHECK_LEDGER_ATTEMPTS = 12;
/** Max randomized backoff between contended ledger rounds. */
const CROSSCHECK_LEDGER_BACKOFF_MS = 40;

/**
 * The pending-event row prefix.
 *
 * `evt2#`, NOT `evt#` (fix wave 2, adversarial 12). Pre-deploy `evt#` rows sit
 * INSIDE the claim path's `BETWEEN 'evt#' AND 'evt#~'` range and the claim reads
 * oldest-deadline first - so at deploy every stale pre-wave row would be claimed
 * IN PREFERENCE to a fresh one, costing a false `group_crosscheck_inbound_missing`
 * on a healthy message while silently absorbing the alarm the stale row had
 * earned. Bumping the prefix puts the old rows outside the range, where they
 * reap on the existing 7-day TTL and are genuinely never read again. Any
 * pre-deploy DUE row still alarms once, which is the cost already priced.
 */
const CROSSCHECK_EVENT_PREFIX = 'evt2#';

/** Sort key for a pending cross-check event row. */
function crossCheckEventSortKey(deadlineIso: string, messageSid: string): string {
  return `${CROSSCHECK_EVENT_PREFIX}${deadlineIso}#${messageSid}`;
}

/** Deadline-prefixed due sort key for an unmatched cross-check event. */
export function groupCrossCheckDueSortKey(deadlineIso: string, messageSid: string): string {
  return `${deadlineIso}#${GROUP_CROSSCHECK_DUE_KIND}#${messageSid}`;
}

/** A cross-check event still waiting for its classic counterpart. */
export interface PendingCrossCheckEvent {
  pairKey: string;
  messageSid: string;
  conversationSid: string;
  author: string;
  deadlineAt: string;
}

export interface NewMessage {
  conversationId: string;
  /** Provider message SID (Twilio SMxxx/MMxxx) — the idempotency key. */
  providerSid: string;
  /** PROVIDER timestamp (ISO 8601) — stable across redeliveries. */
  providerTs: string;
  type: MessageType;
  direction: MessageDirection;
  author: MessageAuthor;
  body?: string;
  /** Provider media URLs (MMS); S3 mirroring is Builder B's webhook path. */
  mediaUrls?: string[];
  /**
   * Outbound MMS attachments (design gap #3): the durable {s3Key, contentType}
   * pairs behind an outbound send, persisted so sent media renders through the
   * existing authed serve endpoint + timeline. Distinct from mediaUrls (which
   * for an outbound send are the presigned, EXPIRING provider-fetch URLs). The
   * inbound mirror sets media_attachments from its mirrored keys; this lets the
   * SEND path close the same asymmetry. Absent on text-only sends.
   */
  mediaAttachments?: MediaAttachment[];
  deliveryStatus: DeliveryStatus;
  errorCode?: string;
  /** Relay group (M1.7): sender member key on an inbound relay message. */
  relaySenderKey?: string;
  /** Relay group (M1.7): inbound landed on a closed relay thread (no fan-out).
   *  Retained for the VOICE masked-call path (webhooks/voice.ts); the SMS relay
   *  path no longer sets it (a late text is intercepted into the 1:1 instead -
   *  see viaClosedGroup). */
  receivedOnClosedThread?: boolean;
  /**
   * Relay group (relay-number-lifecycle): a LATE text to a pool number whose
   * only roster match for the sender is a CLOSED group is delivered into the
   * sender's 1:1 thread; this records that closed group's conversationId so the
   * dashboard can badge the message's provenance ("via the closed group chat").
   * Absent on every other message.
   */
  viaClosedGroup?: string;
  /**
   * Native group texting (spec 5.4): this message was filed into a 1:1 thread by
   * a FAIL-OPEN group path - the envelope tripwire, the corrupt-shape branch, or
   * the collapsed-roster rule - so its body MAY be carrier-group content that
   * references other parties. AI fact extraction filters marked messages out of
   * every transcript window it builds (jobs/extraction.ts), because attributing
   * possibly-group content to this contact as 1:1 facts is exactly the harm.
   * Absent on every ordinary message.
   */
  groupAmbiguousOrigin?: boolean;
  /**
   * Relay group (M1.7): SEED the per-recipient delivery map on the SOURCE
   * message at append time. The fan-out's setRecipientDelivery is a CHILD-ONLY
   * SET (DynamoDB forbids seeding a map and a child in one expression), so the
   * parent map MUST already exist before the first per-recipient write. Pass an
   * EMPTY map `{}` on the relay INBOUND path (the fan-out resolves current
   * membership at run time); team-send seeds per-member 'queued' slots via this
   * field too. Absent on 1:1 messages.
   */
  deliveryRecipients?: Record<string, RelayRecipientDelivery>;
  /**
   * Native group texting (spec 15.2c): the rail SNAPSHOT for an OUTBOUND group
   * send - the CHxx this message was posted into, plus the MBxx -> member-key
   * map as it stood at send time. A per-member delivery receipt carries only an
   * MBxx, and recreating a rail mints NEW MBxx values, so resolving a late
   * receipt against the thread's CURRENT map would mis-attribute or silently
   * drop it. Written in the SAME transaction as the message row, so it can never
   * be missing for a message that exists. Absent on every other message.
   */
  groupRailSnapshot?: GroupRailSnapshot;
  /**
   * A DUE-ROW written in the SAME transaction as this message (spec 15.5): one
   * item in a synthetic, deadline-prefixed partition that a periodic sweep
   * Queries (the messages table has NO GSI, so due-discovery must be a partition
   * Query, never a scan). The group send path uses it for the per-send
   * delivery-staleness alarm, which after spec 16.2 is the ONLY detector of a
   * dead receipts webhook - so it must not have a crash window between the send
   * and its own scheduling. Absent on every other message.
   */
  dueRow?: MessageDueRow;
  /**
   * Share-broadcast id (M1.8a): when set, the persisted message is tagged with
   * `broadcast_id` so the delivery-status callback rollup can resolve which
   * broadcast's recipient slot to update by the provider SID alone.
   */
  broadcastId?: string;
  /**
   * Manual retry (dashboard Retry button): the tsMsgId of the FAILED message this
   * send supersedes. Stamped as `retry_of` at append so the timeline can collapse
   * the stale failed bubble atomically (no annotate-after race). The 30003
   * auto-retry job sets retry_of via annotateMessage instead (it also writes
   * retry_attempt for the chain cap).
   */
  retryOf?: string;

  // --- Voice calls (M1.9a) -------------------------------------------------
  // A `type:'call'` message is a metadata-only timeline entry for a masked
  // (pool-number) call. `providerSid` carries the Twilio CallSid (the dedupe
  // key — same append conditional + a parallel callsid pointer for the status
  // callback). PII (doc §9): NEVER the raw counterpart phone — the label below
  // is a role/name only.
  /** Voice call lifecycle status (absent on sms/mms). */
  callStatus?: CallStatus;
  /** Coarse outcome (set/refined by the status callback). */
  callOutcome?: CallOutcome;
  /** When the call leg was first seen (ISO 8601). */
  startedAt?: string;
  /** When a leg connected (ISO 8601); absent until answered. */
  answeredAt?: string;
  /** When the call ended (ISO 8601); absent until completion. */
  endedAt?: string;
  /** Billable/connected duration in whole seconds (from Twilio CallDuration). */
  callDuration?: number;
  /** True for masked relay-pool calls — they are NEVER recorded/transcribed. */
  masked?: boolean;
  /**
   * A MASKED party label for the timeline: the COUNTERPART's role ("Tenant"/
   * "Landlord"/"Team") or contact name — NEVER the raw counterpart phone (PII).
   */
  callPartyLabel?: string;

  // --- Email channel v1 (type:'email' items) -------------------------------
  // Provider-id convention (plan F5/F14): INBOUND providerSid = the RFC
  // Message-ID (the sid# pointer IS the threading lookup); OUTBOUND providerSid
  // = the SES MessageId and `email_message_id` is our own <hc-...@domain> id -
  // set `rfcMessageIdPointer` to that RFC id and append() writes a THIRD
  // emailmsgid#<rfcId> pointer so getByRfcMessageId can follow it.
  /** Email subject line. */
  subject?: string;
  /** RFC From address (normalized). */
  email_from?: string;
  /** RFC To addresses (normalized). */
  email_to?: string[];
  /** RFC Cc addresses (normalized). */
  email_cc?: string[];
  /** The RFC Message-ID (ours on outbound `<hc-...>`, the sender's on inbound). */
  email_message_id?: string;
  /**
   * INBOUND email: the References chain from the mail's headers (bracketed RFC
   * ids), persisted so an outbound staff REPLY can build its own References (this
   * chain + the inbound's own Message-ID, capped) for recipient-MUA threading.
   * Absent on outbound + non-email.
   */
  email_references?: string[];
  /** Sanitized inbound HTML body (Phase B B7 renders it; absent on outbound). */
  email_html_sanitized?: string;
  /** S3 ref to the raw MIME (inbound only; NEVER presigned/served unauthed). */
  email_raw_ref?: { bucket: string; key: string };
  /**
   * INBOUND email (B2 tier 5): the message threaded via a reply token or
   * References match, but the From-address is NOT on the resolved contact -
   * the UI renders a "New address" chip; ADDING the address to the contact
   * stays a staff action (Decision 4 - never auto-attached). Absent otherwise.
   */
  email_new_address?: boolean;
  /**
   * INBOUND email (B2 DoS caps): some parsed attachments were NOT stored -
   * over the 50-attachment cap, past the 25MB per-message total, or no media
   * store was configured. The raw MIME (email_raw_ref) remains the full-
   * fidelity record. Absent when every attachment stored.
   */
  attachments_truncated?: boolean;
  /**
   * INBOUND email (B2 DoS caps): a sender-controlled stored array was capped so
   * the assembled item stays under DynamoDB's 400 KB ceiling - the To/Cc
   * recipient lists (count + summed bytes), the References chain (last-N), or an
   * attachment filename (summed bytes). Long Cc/References are ROUTINE on
   * forwarded / mailing-list mail, so this is not just an adversarial guard. The
   * raw MIME (email_raw_ref) keeps the full header set. Absent when nothing
   * capped.
   */
  headers_truncated?: boolean;
  /**
   * OUTBOUND email only: our own RFC Message-ID (`<hc-...@domain>`). When set,
   * append() adds a THIRD emailmsgid#<rfcId> pointer to the transaction so an
   * inbound reply's In-Reply-To/References can resolve this message via
   * getByRfcMessageId (the SES providerSid differs from our RFC id).
   */
  rfcMessageIdPointer?: string;
  /**
   * Recording/transcript seams (later decision; UNUSED for masked calls —
   * masked calls never record). Included so M1.9b/founder-bridge can populate
   * them without a schema change.
   */
  recordingS3Key?: string;
  transcript?: string;
  /**
   * Source-attributed channel->role map for a dual-channel bridge recording
   * (voice-extraction Layer 1). Keys = VI mediaChannel ints as strings ("1"/"2"),
   * values = the KNOWN speaker role for that channel. Stamped at call-append time
   * by the two dial sites (inbound founder bridge / outbound originate), where
   * leg orientation is deterministic at ring time. Persisted as the snake_case
   * attr `transcript_channel_roles`. Call-only; absent on sms/mms and on
   * voicemail (single-channel, no dial).
   */
  transcriptChannelRoles?: Record<string, 'staff' | 'client'>;
}

/** One mirrored MMS attachment: its S3 key + the normalized stored Content-Type. */
export interface MediaAttachment {
  s3Key: string;
  contentType: string;
  /**
   * The pristine uploaded original (RCS-forward, spec Sec 5). `s3Key` is the
   * MMS-deliverable rendition actually sent; `originalKey` is the full-fidelity
   * asset a future RCS channel can send instead. Absent on inbound-mirrored and
   * legacy attachments (they carry only the delivered key).
   */
  originalKey?: string;
  /**
   * The original client-supplied filename (email-channel v1). Carried from the
   * composer through the send so the outbound MIME part and the timeline gallery
   * show `lease.pdf` rather than a synthesized `attachment-1.pdf`. Optional -
   * MMS/inbound/legacy attachments have none.
   */
  filename?: string;
}

export interface MessageItem {
  conversationId: string;
  tsMsgId: string;
  type: MessageType;
  direction: MessageDirection;
  author: MessageAuthor;
  body?: string;
  mediaUrls?: string[];
  provider_sid: string;
  provider_ts: string;
  delivery_status: DeliveryStatus;
  error_code?: string;
  created_at: string;
  /**
   * Mirrored MMS attachments (M1.1 webhook path): each carries its S3 key AND
   * the normalized stored Content-Type, together, so key and type can never
   * drift. Index `i` is the same attachment the `…/media/:i` serve URL selects.
   * Supersedes `media_s3_keys`; read via `mediaAttachmentsOf()` for compat.
   */
  media_attachments?: MediaAttachment[];
  /** @deprecated Legacy parallel key array (pre-`media_attachments`). Read via
   *  `mediaAttachmentsOf()`, which folds it into the new shape as octet-stream.
   *  Removal tracked: docs/issues/remove-media-s3-keys-legacy.md (gated on data migration). */
  media_s3_keys?: string[];
  /** Set on a 30003 retry send: the tsMsgId of the message being retried. */
  retry_of?: string;
  /** 1-based retry attempt number (caps the 30003 retry chain, doc §7.1). */
  retry_attempt?: number;
  /**
   * Relay group (M1.7): on an INBOUND relay message, the member key
   * (relayMemberKey) of the sender — which member texted the pool number.
   * Absent on 1:1 messages.
   */
  relay_sender_key?: string;
  /**
   * Relay group (M1.7): true when this inbound arrived on a CLOSED relay
   * thread — persisted for the audit trail but NOT fanned out. Absent
   * otherwise. Set today only by the VOICE masked-call path (webhooks/voice.ts);
   * the SMS relay path intercepts late texts into the 1:1 (via_closed_group).
   */
  received_on_closed_thread?: boolean;
  /**
   * Relay group (relay-number-lifecycle): the conversationId of the CLOSED
   * relay group a late text was intercepted from. Present ONLY on a 1:1 message
   * delivered by the closed-group interception path; the dashboard renders a
   * "via the closed group chat" provenance badge off it. Absent otherwise.
   */
  via_closed_group?: string;
  /**
   * Native group texting (spec 5.4): filed 1:1 by a fail-open group path, so the
   * body may be carrier-group content. AI fact extraction EXCLUDES these from
   * every transcript window (jobs/extraction.ts). See NewMessage.groupAmbiguousOrigin.
   */
  group_ambiguous_origin?: boolean;
  /**
   * Relay group (M1.7): per-recipient delivery state for the fan-out of THIS
   * (inbound source) message to the other members, keyed by member key. The
   * relayed message is stored once; fan-out only updates this map. Absent on
   * 1:1 messages (the single `delivery_status` is unchanged for those).
   */
  delivery_recipients?: Record<string, RelayRecipientDelivery>;
  /**
   * Native group texting (spec 15.2c): the CHxx this OUTBOUND group message was
   * posted into, snapshotted at send time. See NewMessage.groupRailSnapshot.
   */
  group_conversation_sid?: string;
  /**
   * Native group texting (spec 15.2c): MBxx -> member key, snapshotted at send
   * time. A receipt resolves its member through THIS map first and only falls
   * back to the thread's current map, so a rail recreation cannot orphan the
   * receipts of messages sent before it.
   */
  group_participant_map?: Record<string, string>;
  /**
   * Share-broadcast id (M1.8a): set on an outbound broadcast send so the
   * delivery-status callback can roll delivered/failed into the broadcast's
   * stats by SID lookup. Absent on 1:1 / relay messages.
   */
  broadcast_id?: string;

  // --- Voice calls (M1.9a) — present only on type:'call' items -------------
  /** Twilio CallStatus (lifecycle); the status callback advances it forward-only. */
  call_status?: CallStatus;
  /** Coarse outcome (answered/missed/voicemail) — refined by the status callback. */
  call_outcome?: CallOutcome;
  /** First-seen time of the call leg (ISO 8601). */
  started_at?: string;
  /** When a leg connected (ISO 8601); absent until answered. */
  answered_at?: string;
  /** When the call ended (ISO 8601); absent until completion. */
  ended_at?: string;
  /** Connected duration in whole seconds (Twilio CallDuration). */
  call_duration?: number;
  /** True for masked relay-pool calls (NEVER recorded/transcribed). */
  masked?: boolean;
  /** MASKED party label (counterpart role/name) — NEVER a raw phone (PII). */
  call_party_label?: string;

  // --- Email channel v1 - present only on type:'email' items ---------------
  /** Email subject line. */
  subject?: string;
  /** RFC From address (normalized). */
  email_from?: string;
  /** RFC To addresses (normalized). */
  email_to?: string[];
  /** RFC Cc addresses (normalized). */
  email_cc?: string[];
  /** RFC Message-ID (ours on outbound, the sender's on inbound). */
  email_message_id?: string;
  /** INBOUND email References chain (see NewMessage.email_references). */
  email_references?: string[];
  /**
   * OUTBOUND email (A5): the SES MessageId returned by adapter.send, stamped by
   * recordProviderSidAlias AFTER send. Distinct from provider_sid (which is our
   * own RFC id, known before send) - the correlation key SES delivery/bounce/
   * complaint events (B5) arrive under. Absent on inbound + non-email messages.
   */
  ses_message_id?: string;
  /** Sanitized inbound HTML body (Phase B rendering; absent on outbound). */
  email_html_sanitized?: string;
  /** S3 ref to the raw MIME (inbound only; NEVER presigned/served unauthed). */
  email_raw_ref?: { bucket: string; key: string };
  /** Inbound tier-5 "new address" flag (see NewMessage.email_new_address). */
  email_new_address?: boolean;
  /** Inbound attachment-cap note (see NewMessage.attachments_truncated). */
  attachments_truncated?: boolean;
  /** Inbound stored-array cap note (see NewMessage.headers_truncated). */
  headers_truncated?: boolean;
  /**
   * S3 key of the mirrored recording (M1.9c founder-bridge calls only; UNUSED
   * for masked calls, which are never recorded). Set by the recording callback.
   */
  recording_s3_key?: string;
  /**
   * RecordingSid of the stored recording (M1.9c) — the idempotency key for the
   * recordingStatusCallback: a redelivered callback carrying the SAME
   * RecordingSid is a no-op (no re-fetch, no re-store). Set alongside
   * recording_s3_key.
   */
  recording_sid?: string;
  /** Recording duration in whole seconds (M1.9c; from Twilio RecordingDuration). */
  recording_duration?: number;
  /**
   * VERBATIM call transcript (M1.9c founder-bridge calls only; UNUSED for
   * masked calls). Populated when the transcription ENGINE (Twilio Voice
   * Intelligence, operator-configured) POSTs to the transcription callback. NO
   * AI / structured extraction — that is Phase 2.
   */
  transcript?: string;
  /**
   * Transcript lifecycle status (voice-transcription spec 3.7) - drives the
   * in-flight "Transcribing..." indicator on the call bubble. Absent until the
   * recording handler's create leg stamps 'pending'; see TranscriptStatus.
   */
  transcript_status?: TranscriptStatus;
  /**
   * Source-attributed channel->role map (voice-extraction Layer 1) - a
   * flexible-doc attr `transcript_channel_roles?: Record<string,'staff'|'client'>`
   * stamped at call-append time on dual-channel bridge recordings: keys = VI
   * mediaChannel ints as strings, values = that channel's KNOWN speaker role.
   * Read back via the index signature below (no explicit typed field) by
   * joinViSentences to render `Staff: `/`Client: ` prefixes. Absent on sms/mms
   * and on voicemail (single-channel, no dial).
   */
  [key: string]: unknown;
}

/**
 * Post-append annotations (M1.1 Builder B). The timeline stays append-only in
 * the doc-§5 sense — content (body/author/direction) is never rewritten;
 * these add operational metadata the same way delivery_status updates do.
 */
export interface MessageAnnotations {
  mediaAttachments?: MediaAttachment[];
  retryOf?: string;
  retryAttempt?: number;
}

/**
 * Normalized attachment list for a stored message. Prefers `media_attachments`;
 * falls back to legacy `media_s3_keys` (type unknown → `application/octet-stream`
 * → the serve endpoint forces a safe download). The media-serve endpoint and the
 * dashboard both read through this so old and new messages render uniformly.
 */
export function mediaAttachmentsOf(
  item: Pick<MessageItem, 'media_attachments' | 'media_s3_keys'>,
): MediaAttachment[] {
  if (Array.isArray(item.media_attachments)) return item.media_attachments;
  if (Array.isArray(item.media_s3_keys)) {
    return item.media_s3_keys.map((s3Key) => ({ s3Key, contentType: 'application/octet-stream' }));
  }
  return [];
}

export interface AppendResult {
  /** False = fresh write; true = this provider SID was already persisted. */
  deduped: boolean;
  /** The PERSISTED message's SK — on dedupe, the FIRST write's key (which can differ from this call's providerTs). */
  tsMsgId: string;
}

export interface ListByConversationOptions {
  limit?: number;
  /** Exclusive upper bound on tsMsgId — pass the oldest seen key to page back. */
  before?: string;
}

/**
 * A parked SES delivery event (email-channel B5 orphan parking, plan F12). An
 * outbound email persists under our OWN RFC id and only gets a `sid#<sesId>`
 * alias AFTER adapter.send returns - so a fast Bounce/Complaint/Delivery can
 * arrive before that alias exists (getByProviderSid(sesId) misses). Rather than
 * drop it, applyEmailEvent PARKS it under the `emailevent#<sesId>` pointer
 * partition; A5's post-send applyParkedEmailEvents then applies + consumes it.
 * Only the three fields the applier needs are stored (never message content).
 */
export interface ParkedEmailEvent {
  /** 'Bounce' | 'Complaint' | 'Delivery'. */
  eventType: string;
  sesMessageId: string;
  bounceType?: string;
}

export interface MessagesRepo {
  /** Conditional append + SID pointer in one transaction; dedupe is a no-op. */
  append(message: NewMessage): Promise<AppendResult>;
  /** Resolve a provider SID to its message via the pointer item (doc §9). */
  getByProviderSid(sid: string): Promise<MessageItem | undefined>;
  /**
   * Email channel v1 - resolve an RFC Message-ID to its message. Checks the
   * emailmsgid#<id> pointer (OUTBOUND: our own <hc-...> id, distinct from the SES
   * providerSid) FIRST, then falls back to sid#<id> (INBOUND: providerSid IS the
   * RFC Message-ID). The In-Reply-To/References threading lookup for inbound
   * replies. Undefined when neither pointer resolves.
   */
  getByRfcMessageId(messageId: string): Promise<MessageItem | undefined>;
  /**
   * Apply a status-callback transition. Returns false (no-op) when the
   * message is unknown or the transition would move backwards — delivery
   * callbacks arrive out of order and redelivered (doc §7.1).
   */
  updateDeliveryStatus(sid: string, status: DeliveryStatus, errorCode?: string): Promise<boolean>;
  /**
   * Email channel v1 (A5): alias a provider SID to an ALREADY-persisted message.
   * An outbound email persists under our own RFC Message-ID as `provider_sid`
   * (we do not know the SES MessageId until adapter.send returns), so this writes
   * a second `sid#<providerSid>` pointer to that message AND stamps
   * `ses_message_id`. A later SES delivery/bounce/complaint event (B5) - keyed on
   * the SES MessageId - then resolves the message via getByProviderSid(sesId) and
   * runs the SAME forward-only updateDeliveryStatus machine. Idempotent: a
   * duplicate alias writes the same pointer + field (harmless).
   */
  recordProviderSidAlias(
    providerSid: string,
    ref: { conversationId: string; tsMsgId: string },
  ): Promise<void>;
  /**
   * Voice call (M1.9a): apply a call status-callback transition to a
   * `type:'call'` item, found by CallSid (== provider_sid). Forward-only on
   * call_status (a redelivered/out-of-order callback can never regress a
   * terminal call), and idempotently stamps the supplied lifecycle fields
   * (answered_at/ended_at/call_duration/call_outcome). Returns false (no-op)
   * when the call is unknown or the transition would regress — so a redelivered
   * webhook never double-writes or double-counts. PII (doc §9): IDs/labels only.
   */
  updateCallStatus(
    callSid: string,
    fields: {
      callStatus: CallStatus;
      callOutcome?: CallOutcome;
      answeredAt?: string;
      endedAt?: string;
      callDuration?: number;
    },
  ): Promise<boolean>;
  /**
   * Voice call recording (M1.9c): stamp recording_s3_key (+ recording_sid +
   * recording_duration) onto a `type:'call'` item found by CallSid. IDEMPOTENT
   * per RecordingSid — the write is conditioned on the call NOT already carrying
   * a recording_sid (a redelivered recordingStatusCallback with the same
   * RecordingSid is a no-op). Returns true on the first store, false when a
   * recording is already present (so the callback skips re-fetch/re-store) or
   * the CallSid is unknown. PII (doc §9): IDs/keys/durations only — never the
   * RecordingUrl content.
   */
  setCallRecording(
    callSid: string,
    recording: { recordingSid: string; recordingS3Key: string; recordingDuration?: number },
  ): Promise<boolean>;
  /**
   * Voice call recording (M1.9c, FIX 4 — claim rollback): RELEASE a recording
   * claim made by setCallRecording when the subsequent media fetch/put fails, so
   * the call entry does not keep a recording_s3_key/recording_sid pointing at an
   * S3 object that was never written (and Twilio's redelivery can re-claim +
   * re-fetch). Clears recording_sid/recording_s3_key/recording_duration CONDI-
   * TIONALLY on recording_sid still equalling the one we claimed, so it never
   * clobbers a different concurrent writer. Best-effort + idempotent: a no-op
   * (unknown CallSid, or the claim already superseded) never throws.
   */
  releaseCallRecording(callSid: string, recordingSid: string): Promise<void>;
  /**
   * Voice call transcript (M1.9c): save the VERBATIM transcript onto a
   * `type:'call'` item found by CallSid. IDEMPOTENT — the write is conditioned
   * on the call NOT already carrying a (non-empty) transcript, so a redelivered
   * transcription callback never overwrites a completed transcript (and an empty
   * redelivery is refused upstream too). Returns true on the first save, false
   * when a transcript already exists or the CallSid is unknown. PII (doc §9):
   * NEVER log the transcript text.
   */
  setCallTranscript(callSid: string, transcript: string): Promise<boolean>;
  /**
   * Voice transcription lifecycle (voice-transcription spec 3.7): stamp
   * transcript_status = 'pending' the moment a transcript WILL be requested
   * (recording persisted, founder-bridge, VI configured). Conditional on no
   * transcript_status existing yet, so a redelivered recording callback is a
   * no-op. Returns true on the first stamp, false when already stamped or the
   * CallSid is unknown.
   */
  setTranscriptPending(callSid: string): Promise<boolean>;
  /**
   * Voice transcription lifecycle (spec 3.7): stamp transcript_status =
   * 'failed' when the pipeline gives up (VI reports failed / reconcile exhausts
   * attempts). Conditional on the status still being 'pending', so a saved
   * transcript ('completed') is never regressed - completed is terminal.
   * Returns true when it flips a pending call to failed, false otherwise
   * (already completed/failed, never pending, or the CallSid is unknown).
   */
  setTranscriptFailed(callSid: string): Promise<boolean>;
  /**
   * Platform voicemail (voice-transcription spec 4.2): upgrade a call outcome
   * 'missed' -> 'voicemail' via a conditional write (only-if-currently-missed),
   * which also makes redelivered recording callbacks idempotent. Returns true
   * on the first upgrade, false when the call is not currently 'missed'
   * (already voicemail/answered) or the CallSid is unknown.
   */
  upgradeCallOutcomeToVoicemail(callSid: string): Promise<boolean>;
  /** Newest-first page of a conversation's log. */
  listByConversation(conversationId: string, opts?: ListByConversationOptions): Promise<MessageItem[]>;
  /**
   * Point-get ONE message by its exact key. Added for the AI run log's window
   * rehydration (design 2026-08-06 section 9): the run stores message IDs, not
   * text, so the detail view reads them back on demand. Returns undefined for a
   * deleted message - the view renders that as unavailable, and the stored hash
   * and char count still prove what was sent.
   */
  getByTsMsgId(conversationId: string, tsMsgId: string): Promise<MessageItem | undefined>;
  /**
   * BATCH point-get for a whole window (up to MAX_TRANSCRIPT_MESSAGES ids),
   * keyed by tsMsgId. Chunked at the BatchGetItem 100-key limit, with an
   * UnprocessedKeys retry. Missing ids are simply absent from the map.
   */
  getManyByTsMsgIds(conversationId: string, tsMsgIds: string[]): Promise<Map<string, MessageItem>>;
  /** Stamp operational metadata (media S3 keys / retry lineage) onto a message. */
  annotateMessage(conversationId: string, tsMsgId: string, annotations: MessageAnnotations): Promise<void>;
  /**
   * Execution guard for duplicate-sensitive jobs (M1.2): conditionally
   * record that the job with this envelope jobId ran — `{ PK: job#<jobId>,
   * SK: ran }`, the same pointer-partition trick as the SID items. True =
   * first execution (proceed); false = this jobId already ran (an SQS
   * redelivery — suppress the side effect).
   */
  putJobExecutionMarker(jobId: string, conversationId: string): Promise<boolean>;
  /**
   * READ a job-execution marker (the inbound-email object-key dedupe FAST PATH,
   * email-channel fix-wave B): true = this jobId already ran to a terminal
   * durable write. Correctness never rests on it - the durable writes are
   * independently idempotent - it only lets a clean redelivery skip the work.
   */
  getJobExecutionMarker(jobId: string): Promise<boolean>;

  // --- Email orphan-event parking lot (email-channel B5, plan F12) ----------

  /**
   * Park a SES event whose sesMessageId has no message yet (a fast bounce before
   * the A5 post-send alias write). Stored under `emailevent#<sesMessageId>` /
   * `parked#<eventType>` (m4: keyed per event type so a Delivery cannot overwrite
   * a parked Bounce and silently lose the suppression) with an `expires_at`
   * (epoch seconds) TTL backstop. Idempotent UPSERT: a redelivery of the SAME
   * event type overwrites the identical item (harmless). The authoritative
   * cleanup is deleteParkedEmailEvent (the consume), NOT the TTL.
   *
   * CORRECTED 2026-08-11 (group-texting A12): TTL **is** enabled on the messages
   * table, in dev AND prod (`ttl_attribute: "expires_at"` in both tfvars, and
   * dynamoAdmin enables it on local table creation). This comment previously
   * claimed the opposite. Anything written here WILL be reaped once `expires_at`
   * passes - best-effort, up to 48h late - so `expires_at` must always be a
   * CLEANUP horizon far past whatever deadline actually matters, never the
   * mechanism something is waiting on.
   */
  putParkedEmailEvent(event: ParkedEmailEvent, opts: { receivedAt: string; expiresAt: number }): Promise<void>;
  /** ALL parked events for a sesMessageId (m4: one per eventType), or [] when
   *  nothing is parked. The post-send drain applies + consumes every one. */
  listParkedEmailEvents(sesMessageId: string): Promise<ParkedEmailEvent[]>;
  /**
   * Consume (delete) ONE parked event (by sesMessageId + eventType) - the
   * exactly-once marker. Conditional on the item still existing (attribute_
   * exists); a concurrent consumer that already deleted it makes this a no-op
   * (ConditionalCheckFailed swallowed).
   */
  deleteParkedEmailEvent(sesMessageId: string, eventType: string): Promise<void>;

  // --- Relay groups (M1.7) -------------------------------------------------

  /**
   * Record the per-recipient send result on the SOURCE message's
   * delivery_recipients map (relay fan-out): sets `status` (+ optional sid /
   * sentAt / errorCode) for `memberKey`. A blind SET on the nested map slot —
   * the fan-out owns the initial queued→sent write per recipient; the
   * forward-only state machine is enforced by updateRecipientDeliveryStatus
   * (the callback path). No-op semantics are the caller's (idempotency check).
   */
  setRecipientDelivery(
    conversationId: string,
    tsMsgId: string,
    memberKey: string,
    delivery: RelayRecipientDelivery,
  ): Promise<void>;
  /**
   * Apply a delivery-callback transition to ONE recipient slot of a multi-party
   * source message: forward-only (same machine as updateDeliveryStatus), keyed
   * by memberKey. Returns false (no-op) when the slot is unknown or the
   * transition would regress.
   *
   * WRITES CHILD FIELDS, never the whole slot (spec 15.2b). It used to SET the
   * entire `delivery_recipients.<memberKey>` map from a value read moments
   * earlier, which silently discarded any field written in between - and the
   * group receipts path writes `sid` for one member while another member's
   * status transition is in flight. The prior-status ConditionExpression is
   * unchanged, so the forward-only guarantee is exactly what it was.
   *
   * `opts.sid` records the per-member channel SID (Twilio SMxx) alongside the
   * transition. `opts.context` labels the log lines: it defaults to 'relay' so
   * the relay caller's lines stay byte-identical.
   */
  updateRecipientDeliveryStatus(
    conversationId: string,
    tsMsgId: string,
    memberKey: string,
    status: DeliveryStatus,
    errorCode?: string,
    opts?: { sid?: string; context?: 'relay' | 'group' },
  ): Promise<boolean>;
  /**
   * Record the per-member channel SID on a slot ONLY IF it has none yet - the
   * targeted write that keeps a DUPLICATE receipt useful. A redelivered receipt
   * carries the same SMxx but its status transition is rejected as a regression,
   * so without this the sid would be lost whenever the first delivery of a
   * receipt raced the append. Conditional on absence, so it can never overwrite
   * a sid already recorded. Returns false when the slot is missing or already
   * has one.
   */
  setRecipientDeliverySid(
    conversationId: string,
    tsMsgId: string,
    memberKey: string,
    sid: string,
  ): Promise<boolean>;
  /**
   * Write the relaysid pointer for a per-recipient fan-out send: `{ PK:
   * relaysid#<providerSid>, SK: ptr }` → conversationId + tsMsgId + memberKey.
   * Delivery callbacks carry only the SID, so this is how a relay-recipient
   * callback recovers WHICH source message + recipient slot to update. Same
   * marker-partition convention as the sid# pointers (never collides with
   * real conversation partitions). Conditional create — a redelivered
   * fan-out never clobbers an existing pointer.
   */
  putRelaySidPointer(
    providerSid: string,
    ref: { conversationId: string; tsMsgId: string; memberKey: string },
  ): Promise<void>;
  /** Resolve a relay-recipient provider SID to its source message + member slot. */
  getRelaySidPointer(
    providerSid: string,
  ): Promise<{ conversationId: string; tsMsgId: string; memberKey: string } | undefined>;
  /**
   * Mark a provider SID as a SYSTEM send: a real outbound SMS deliberately NOT
   * persisted as a conversation message (e.g. the cell-verification code,
   * routes/voiceApi.ts verify-start). The /status webhook checks this marker
   * before its unknown-SID ERROR backstop so the send's delivery receipts ack
   * at INFO instead of feeding the error alarm
   * (docs/issues/verification-sms-receipts-trip-error-alarm.md). Same
   * marker-partition convention as sid#/job#/relaysid# (`syssid#<sid>`).
   * Unconditional put - a redelivered write is the same content.
   */
  putSystemSidMarker(providerSid: string, kind: string): Promise<void>;
  /** The system-send marker for a provider SID, or undefined. */
  getSystemSidMarker(providerSid: string): Promise<{ kind: string } | undefined>;

  // --- Group texting: the deadline partition (spec 15.5) --------------------

  /**
   * Due rows whose deadline has passed, oldest first - the sweep's ONLY
   * discovery mechanism (the messages table has no GSI, so this is a Query over
   * a deadline-prefixed sort-key range, never a scan). `throughIso` MUST be a
   * normalized ISO 8601 instant: sort keys are compared LEXICOGRAPHICALLY.
   */
  listDueRows(partition: string, throughIso: string, limit?: number): Promise<GroupDueRow[]>;
  /**
   * PARK a group delivery receipt whose IMxx has no message row yet (spec
   * 15.2a): the receipt genuinely can beat the send's own append. Keyed
   * IMxx + ParticipantSid, because ONE posted message produces a receipt per
   * participant and a second member's receipt must not overwrite the first's.
   *
   * FORWARD-ONLY COALESCING WITHIN A SLOT: `rank` is the caller's ordering of
   * the status (queued < sent < terminal); the write is conditional on the
   * parked rank being no further ahead, so a late `sent` can never overwrite a
   * parked `delivered`. Returns false when the condition rejected it.
   */
  parkGroupReceipt(
    receipt: ParkedGroupReceipt,
    opts: { rank: number; expiresAt: number },
  ): Promise<boolean>;
  /** Every parked receipt for one IMxx (one per participant), or []. */
  listParkedGroupReceipts(messageSid: string): Promise<ParkedGroupReceipt[]>;
  /** Consume one parked receipt. Idempotent - a re-drain deletes nothing. */
  deleteParkedGroupReceipt(messageSid: string, participantSid: string): Promise<void>;
  /**
   * Resolve one due row (delete it). Idempotent: deleting an already-deleted row
   * is a no-op, so a sweep that crashes mid-batch can rerun safely. A base-table
   * partition has no sparse-index trick to fall back on - the row must actually
   * go, or it alarms forever.
   */
  deleteDueRow(partition: string, sortKey: string): Promise<void>;

  // --- Group texting: the cross-check ledger (T6.2) -------------------------

  /**
   * Conditional-create the per-IM dedupe marker. `false` means this event has
   * already been recorded (a Twilio redelivery), so the caller must NOT add a
   * second entry to the pair ledger.
   */
  claimCrossCheckEvent(
    messageSid: string,
    attrs: { conversationSid: string; author: string; receivedAt: string },
    expiresAt: number,
  ): Promise<boolean>;
  /**
   * Conditional-create the per-CLASSIC-SID dedupe marker - the mirror image of
   * `claimCrossCheckEvent`. `false` means this classic inbound has already been
   * filed into the ledger (a Twilio redelivery of the messaging webhook), so the
   * caller must NOT consume a second pending event or bank a second credit.
   *
   * THIS IS THE IDEMPOTENCY AUTHORITY FOR THE CLASSIC HALF, deliberately in
   * preference to the append's `deduped` flag: a first delivery that died AFTER
   * the append but BEFORE the ledger write leaves no marker, and its redelivery
   * is then the only chance to file the classic half. Keying on the flag instead
   * would turn that recovery into a false `group_crosscheck_inbound_missing`.
   */
  claimCrossCheckClassic(
    providerSid: string,
    attrs: { conversationSid: string; memberKey: string; filedAt: string },
    expiresAt: number,
  ): Promise<boolean>;
  /**
   * THE EVENT HALF'S ONE ATOMIC LEDGER STEP (fix wave 5, adversarial 3/9).
   *
   * Adds this event to the pair's balance and reports what it landed on:
   *   - `'credit'`: the balance was negative, i.e. a classic filing for this
   *     pair arrived FIRST and is still claimable. Matched.
   *   - `'pending'`: nothing was banked (or every banked credit was stale), so
   *     this event now awaits its classic filing.
   *
   * WHY A COUNTER AND NOT TWO ROW RANGES. The old ledger was two independent
   * rows read check-then-act: the event half Queried for a `credit#` row and
   * the classic half Queried for an `evt#` row, both eventually consistent and
   * both followed by an UNCONDITIONAL delete. Two webhooks fired by ONE carrier
   * message could therefore each miss the other's row - by a true interleave or
   * by read lag alone - leaving a credit AND a pending row for the same message
   * and raising `group_crosscheck_inbound_missing` at ERROR on healthy traffic,
   * while the orphaned credit went on to absorb a LATER genuine miss. A single
   * `ADD` on one item is strongly consistent and read-modify-write atomic, so
   * neither half can miss the other and neither can double-consume.
   *
   * `notBeforeIso` is the credit freshness bound. `credit_since` tracks the
   * OLDEST outstanding credit, so a quiet period that banked credits long ago
   * can never mask a later genuine miss - those credits are discarded and this
   * event goes pending instead. DISCARDING REMOVES THE CREDITS IT DECIDED
   * AGAINST (fix wave 3, adversarial 1; see `discardStaleCredits`): the stale
   * stack counted at a consistent read, plus this event's own slot, so a credit
   * banked concurrently survives as arithmetic rather than being destroyed with
   * the stale ones.
   *
   * FOUR SEQUENTIAL WRITES, NOT A TRANSACTION - AND `counted` IS WHY THAT IS
   * SAFE (fix wave 2, adversarial 11; corrected in fix wave 3, adversarial 4 /
   * conformance 2). There is NO `TransactWriteItems` here, and an earlier
   * version of this comment claiming one was wrong: a transacted, condition-
   * pinned version was built and thrown away because optimistic concurrency on
   * one hot pair item thrashes (it failed the twenty-concurrent-pairs test).
   * What ships is (1) the pair row, (2) the due row, (3) the balance `ADD`,
   * (4) `SET counted` - in that order, because the classic half claims a pending
   * ROW whenever the balance says one exists, so the row must be durable before
   * the bump that says so. `counted` is the load-bearing part, not belt-and-
   * braces: a row is written UNCOUNTED and marked only once the bump has landed,
   * the claim consumes counted rows only, and an uncounted row is therefore a
   * pending row the balance does not account for - which is a state that occurs
   * by design, not an invariant violation. Because it occurs by design, the
   * claim WAITS a bounded beat for the mark rather than reporting nothing
   * claimable the instant it sees an empty read (fix wave 4, item 2): the window
   * between (3) and (4) is one round trip, and a concurrent classic filing
   * landing inside it is ordinary traffic, not a fault.
   *
   * THE RESIDUAL, PRICED HONESTLY (fix wave 3, adversarial 3). A throw between
   * the row writes and step (4) leaves rows uncounted. That costs one false
   * `group_crosscheck_inbound_missing` when the sweep alarms them - and a second
   * effect worth naming: that event's own classic filing then arrives to a
   * square balance, banks a CREDIT for a slot that no longer exists, and the
   * NEXT event on the pair consumes it and is reported matched. So if detection
   * genuinely broke inside that credit window (GROUP_CROSSCHECK_CREDIT_MS), one
   * real miss can go unalarmed. The cascade the `counted` marker closed is the
   * STEAL-driven one (an unrelated event's slot taken, that event alarming
   * falsely); this uncounted-row-driven instance remains by construction, and
   * is the gap a transaction would have closed. Accepted for a heuristic monitor
   * that has two other mechanisms beside it.
   *
   * A CREDIT WRITES ITS ROWS AND RETRACTS THEM. The outcome is only known after
   * the `ADD`, so an event that lands on a banked credit deletes the two rows it
   * just wrote. A throw between the `ADD` and those deletes leaves rows behind
   * for an event the balance has already matched, and the sweep alarms them -
   * the same class of extra-alarm residual as above, never a missed one.
   */
  recordCrossCheckEvent(
    event: PendingCrossCheckEvent,
    bounds: { notBeforeIso: string; nowIso: string; expiresAt: number },
  ): Promise<'credit' | 'pending'>;
  /**
   * THE CLASSIC HALF'S ONE ATOMIC LEDGER STEP. The mirror of
   * `bumpCrossCheckEvent`:
   *   - `'matched'`: the balance was positive, i.e. an event for this pair is
   *     pending. The caller must claim and resolve the oldest pending row.
   *   - `'credit'`: nothing pending, so this filing is banked for the event
   *     that has not arrived yet.
   */
  bumpCrossCheckClassic(
    pairKey: string,
    nowIso: string,
    expiresAt: number,
  ): Promise<'matched' | 'credit'>;
  /**
   * Give an ALARMED pending event back to the balance. The sweep has stopped
   * waiting for it, so it must stop counting as pending - otherwise a very late
   * classic filing would "match" a message we already reported missing.
   * Conditional on a positive balance, and never throws for a race.
   */
  releaseCrossCheckPending(pairKey: string): Promise<void>;
  /**
   * CLAIM the OLDEST pending event for this pair (deleting both its pair row and
   * its due row), or `undefined` when nothing is claimable. Oldest-first is what
   * makes rapid same-author messages match one-for-one.
   *
   * A CLAIM, NOT A READ (adversarial 9). The Query is `ConsistentRead` - the
   * pair row is written microseconds before the balance bump that sends a caller
   * here, so an eventually-consistent read would miss it - and the delete is
   * CONDITIONAL with its result inspected, so two concurrent claimants can never
   * both take the same row. A loser retries against the next-oldest row.
   *
   * AN EMPTY READ IS RE-TRIED, BRIEFLY (fix wave 4, item 2). Callers reach this
   * only after the balance said a slot exists, and the commonest way for that to
   * be true with nothing claimable is that the event half's `SET counted` is
   * still in flight one round trip behind its bump - an interleaving that arrives
   * on ORDINARY traffic, because Twilio fires both webhooks off one carrier
   * message. Left alone it cost a false `group_crosscheck_inbound_missing` ERROR
   * for a message whose classic filing had arrived. See CROSSCHECK_MARK_WAIT_MS.
   */
  claimOldestCrossCheckPending(pairKey: string): Promise<PendingCrossCheckEvent | undefined>;
  /**
   * Resolve an ALARMED pending event: delete the due row and its pair row so the
   * alarm fires exactly once. There is no sparse-index trick on a base-table
   * partition - the rows must actually go, or they alarm forever.
   *
   * Both keys are passed VERBATIM from the due row's own pointer (fix wave 2,
   * adversarial 12): re-deriving them would miss a row written under an older
   * key convention and silently leave it to alarm forever.
   *
   * Returns whether THIS call removed the pair row. The sweep gives a slot back
   * only when it did (fix wave 2, adversarial 11): a classic filing that claimed
   * the row first already moved the balance, and a second decrement there would
   * take an unrelated event's slot and make THAT one alarm falsely.
   *
   * AN UNCOUNTED ROW COUNTS AS A REMOVAL (fix wave 3, conformance 1). A throw
   * between the balance `ADD` and the `SET counted` leaves a +1 on the pair with
   * an uncounted row under it; reporting only COUNTED removals stranded that +1
   * until the 7-day TTL, and while it stood the next classic filing was absorbed
   * by the phantom slot, banked no credit, and its own event alarmed. Reporting
   * the removal is safe by construction because the release is conditional on a
   * POSITIVE balance: where the bump never landed there is no slot to take. The
   * residual it accepts is the mirror of the one it closes - on a pair holding
   * BOTH an uncounted row and a counted one, the uncounted row's alarm now
   * releases the counted row's slot - and both cost extra alarms, never a
   * missed one.
   */
  resolveCrossCheckPending(
    pairKey: string,
    pairSortKey: string,
    dueSortKey: string,
  ): Promise<boolean>;
}

const DEFAULT_PAGE_LIMIT = 50;

/** Pointer partition key for a provider SID. */
function sidPk(providerSid: string): string {
  return `sid#${providerSid}`;
}

/**
 * Pointer partition key for an OUTBOUND email's own RFC Message-ID (email
 * channel v1). Written as a THIRD append item when rfcMessageIdPointer is set;
 * getByRfcMessageId checks it before the sid# fallback. Never collides with
 * real conversation partitions.
 */
function emailMsgIdPk(rfcMessageId: string): string {
  return `emailmsgid#${rfcMessageId}`;
}

/** Marker partition key for a job execution (see putJobExecutionMarker). */
function jobPk(jobId: string): string {
  return `job#${jobId}`;
}

/** Pointer partition key for a relay-recipient provider SID (M1.7). */
function relaySidPk(providerSid: string): string {
  return `relaysid#${providerSid}`;
}

/** Marker partition key for a system (non-conversation) send's provider SID. */
function sysSidPk(providerSid: string): string {
  return `syssid#${providerSid}`;
}

/** Point-readable dedupe marker for ONE Conversations event (IMxx). */
function groupCrossCheckMarkerPk(messageSid: string): string {
  return `groupim#${messageSid}`;
}

/** Point-readable dedupe marker for ONE CLASSIC group inbound (SMxx/MMxx). */
function groupCrossCheckClassicPk(providerSid: string): string {
  return `groupsm#${providerSid}`;
}

/**
 * Marker partition for a group delivery receipt that arrived before its message
 * (spec 15.2a). One partition per IMxx, one sort key per ParticipantSid - the
 * same pointer-partition convention as sid#/job#/relaysid#, so listByConversation
 * can never see these.
 */
function groupReceiptPk(messageSid: string): string {
  return `groupreceipt#${messageSid}`;
}

/** Sort key for a parked group receipt, per PARTICIPANT. */
function parkedParticipantSk(participantSid: string): string {
  return `parked#${participantSid}`;
}

/** Pointer partition key for a PARKED SES event (email-channel B5, plan F12). */
function emailEventPk(sesMessageId: string): string {
  return `emailevent#${sesMessageId}`;
}

/** Sort key for a parked SES event, per EVENT TYPE (m4): a single sesMessageId
 *  can have a Bounce AND a Delivery parked at once (a second park must not
 *  overwrite the first and silently lose the suppression), so the sort key
 *  carries the eventType discriminator instead of a fixed 'parked'. */
function parkedSk(eventType: string): string {
  return `parked#${eventType}`;
}

export function createMessagesRepo(deps: RepoDeps = {}): MessagesRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('messages', deps.env);
  const log = deps.logger ?? defaultLogger;

  /** Read the SID pointer item: where the persisted message actually lives. */
  async function getSidPointer(
    sid: string,
    opts: { consistent?: boolean } = {},
  ): Promise<{ ref_conversationId: string; ref_tsMsgId: string } | undefined> {
    const pointer = await doc.send(
      new GetCommand({
        TableName: table,
        Key: { conversationId: sidPk(sid), tsMsgId: 'ptr' },
        // The append's dedupe branch reads STRONGLY: it only gets there because
        // the pointer's own conditional Put just failed, so "absent" would be a
        // real invariant violation - and it is about to be treated as one.
        ...(opts.consistent === true && { ConsistentRead: true }),
      }),
    );
    return pointer.Item as { ref_conversationId: string; ref_tsMsgId: string } | undefined;
  }

  async function getByProviderSid(sid: string): Promise<MessageItem | undefined> {
    const ptr = await getSidPointer(sid);
    if (!ptr) return undefined;
    const { Item } = await doc.send(
      new GetCommand({
        TableName: table,
        Key: { conversationId: ptr.ref_conversationId, tsMsgId: ptr.ref_tsMsgId },
      }),
    );
    return Item as MessageItem | undefined;
  }

  /**
   * DISCARD STALE CREDITS AND TAKE A PENDING SLOT, returning the new balance.
   *
   * Reached only when the conditional ADD refused, i.e. the pair is in credit
   * AND the oldest of those credits predates the match window. Stale credits
   * must never mask a genuine miss, so they are discarded rather than consumed.
   *
   * IT DISCARDS THE CREDITS IT DECIDED AGAINST, AND NOTHING ELSE (fix wave 3,
   * adversarial 1). Two earlier shapes destroyed a fresh credit: `SET balance =
   * 1`, and then a delta of `1 - observed` written under `#b = :observed`, which
   * is the SAME arithmetic - the condition forces the balance to equal
   * `observed` at write time, so the result is exactly 1 for every reading, and
   * a credit banked concurrently only caused a re-read that discarded it too.
   * The stack is now moved by `(-observed) + 1`: the stale credits counted at
   * the read, plus this event's own pending slot. A credit banked under the
   * write survives as arithmetic - the balance simply lands lower, and at zero
   * or below this event MATCHES it instead of alarming for a message whose
   * classic filing arrived.
   *
   * PINNED WITHOUT BEING FROZEN. The write is conditioned on `#cs = :since` AND
   * `#b <= :observed`. While the balance is negative and `credit_since` is set,
   * the only moves possible are more credits (which make it lower - permitted,
   * and the point) and another discard (which moves the anchor, so this one
   * refuses and re-reads rather than subtracting the same stack twice).
   * Contention here is bounded and rare: the common path never reaches it.
   *
   * THE ANCHOR IS RE-STAMPED, NOT REMOVED. Letting the survivors of a discard
   * sit anchorless would make them consumable at ANY age, because the event
   * half's freshness condition passes on `attribute_not_exists(#cs)` - so a
   * classic-only outage could stack credits that never age out and mask a real
   * miss days later. Those survivors were banked between this read and this
   * write, so `nowIso` is their true age. On the ordinary outcome (a positive
   * balance) the stamp is inert: both halves consult it only while the balance
   * is negative, and the next filing that opens a credit run re-stamps it.
   *
   * REMAINING BY DESIGN (conformance 5): credits banked before the read that are
   * individually fresh still go with the stale ones, because the ledger tracks
   * ONE `credit_since` - the oldest - rather than a timestamp per credit. Only
   * reachable when recovering from a dead Conversations webhook, and it only
   * ever produces extra alarms.
   */
  async function discardStaleCredits(
    pairKey: string,
    notBeforeIso: string,
    nowIso: string,
    expiresAt: number,
  ): Promise<number> {
    const key = { conversationId: pairKey, tsMsgId: GROUP_CROSSCHECK_STATE_SORT_KEY };
    for (let attempt = 0; attempt < CROSSCHECK_LEDGER_ATTEMPTS; attempt += 1) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
      );
      const state = Item as { balance?: unknown; credit_since?: unknown } | undefined;
      const observed = typeof state?.balance === 'number' ? state.balance : 0;
      const since = typeof state?.credit_since === 'string' ? state.credit_since : undefined;
      const stale = observed < 0 && since !== undefined && since < notBeforeIso;
      // The stale credits COUNTED AT THE READ, plus this event's own slot. Not
      // `1 - observed`: that pins the result at 1 whatever else has landed.
      // When `stale` is false the pair moved out of the stale-credit shape
      // between the refused ADD and this read, so a plain bump is the truthful
      // answer now.
      const delta = stale ? -observed + 1 : 1;
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: key,
            UpdateExpression: stale
              ? 'ADD #b :delta SET #e = :exp, #cs = :now'
              : 'ADD #b :delta SET #e = :exp',
            // `<=`, not `=`: a credit banked under this write is exactly what
            // must SURVIVE it, and the anchor equality is what stops two
            // discards subtracting one stack twice.
            ConditionExpression: stale
              ? '#b <= :observed AND #cs = :since'
              : 'attribute_not_exists(#b) OR #b = :observed',
            ExpressionAttributeNames: stale
              ? { '#b': 'balance', '#e': 'expires_at', '#cs': 'credit_since' }
              : { '#b': 'balance', '#e': 'expires_at' },
            ExpressionAttributeValues: {
              ':delta': delta,
              ':exp': expiresAt,
              ':observed': observed,
              ...(stale && { ':now': nowIso }),
              ...(stale && since !== undefined && { ':since': since }),
            },
            ReturnValues: 'UPDATED_NEW',
          }),
        );
        if (stale) {
          log.info(
            { pairKey, notBeforeIso, discarded: -observed },
            'cross-check: stale credits discarded - the event takes a pending slot',
          );
        }
        return Number((Attributes as { balance?: number } | undefined)?.balance ?? 1);
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.floor(Math.random() * CROSSCHECK_LEDGER_BACKOFF_MS)),
        );
      }
    }
    // Never silently swallowed: the caller's rows exist and are UNCOUNTED, which
    // both consumers already treat as "not accounted for in the balance".
    throw new Error(
      `cross-check ledger: could not settle stale credits after ${CROSSCHECK_LEDGER_ATTEMPTS} attempts`,
    );
  }

  return {
    getByProviderSid,

    async getByRfcMessageId(messageId) {
      // OUTBOUND: emailmsgid#<rfcId> maps our own RFC id -> the message (the SES
      // providerSid differs). INBOUND: no emailmsgid pointer - providerSid IS the
      // RFC id, so fall back to sid#<rfcId>. Both pointer shapes are
      // {ref_conversationId, ref_tsMsgId}.
      const emailPtrRes = await doc.send(
        new GetCommand({ TableName: table, Key: { conversationId: emailMsgIdPk(messageId), tsMsgId: 'ptr' } }),
      );
      const emailPtr = emailPtrRes.Item as
        | { ref_conversationId: string; ref_tsMsgId: string }
        | undefined;
      const ptr = emailPtr ?? (await getSidPointer(messageId));
      if (!ptr) return undefined;
      const { Item } = await doc.send(
        new GetCommand({
          TableName: table,
          Key: { conversationId: ptr.ref_conversationId, tsMsgId: ptr.ref_tsMsgId },
        }),
      );
      return Item as MessageItem | undefined;
    },

    async append(message) {
      const tsMsgId = buildTsMsgId(message.providerTs, message.providerSid);
      const now = new Date().toISOString();
      const item: MessageItem = {
        conversationId: message.conversationId,
        tsMsgId,
        type: message.type,
        direction: message.direction,
        author: message.author,
        body: message.body,
        mediaUrls: message.mediaUrls,
        provider_sid: message.providerSid,
        provider_ts: message.providerTs,
        delivery_status: message.deliveryStatus,
        error_code: message.errorCode,
        created_at: now,
        // Outbound MMS: persist the durable attachment keys so sent media
        // renders through the authed serve endpoint (gap #3). Only when present.
        ...(message.mediaAttachments !== undefined &&
          message.mediaAttachments.length > 0 && { media_attachments: message.mediaAttachments }),
        ...(message.relaySenderKey !== undefined && { relay_sender_key: message.relaySenderKey }),
        ...(message.receivedOnClosedThread === true && { received_on_closed_thread: true }),
        ...(message.viaClosedGroup !== undefined && { via_closed_group: message.viaClosedGroup }),
        ...(message.groupAmbiguousOrigin === true && { group_ambiguous_origin: true }),
        // Seed the per-recipient delivery map (possibly empty) so the fan-out's
        // child-only setRecipientDelivery has a parent map to write into.
        ...(message.deliveryRecipients !== undefined && {
          delivery_recipients: message.deliveryRecipients,
        }),
        // Native group texting: the rail snapshot rides the SAME item as the
        // seeded delivery map, so a late receipt can never find a message row
        // without the map that makes its MBxx resolvable.
        ...(message.groupRailSnapshot !== undefined && {
          group_conversation_sid: message.groupRailSnapshot.conversationSid,
          group_participant_map: message.groupRailSnapshot.participantMap,
        }),
        ...(message.broadcastId !== undefined && { broadcast_id: message.broadcastId }),
        // Manual retry (dashboard Retry button): stamp retry_of AT APPEND so the
        // new message carries its lineage atomically — no annotate-after race. The
        // 30003 auto-retry still annotates post-send (it also needs retry_attempt).
        ...(message.retryOf !== undefined && { retry_of: message.retryOf }),
        // Voice call (M1.9a): metadata-only fields on a type:'call' item. The
        // same sid#<CallSid> pointer the append already writes lets the status
        // callback recover context via getByProviderSid(CallSid). Masked calls
        // never populate recording_s3_key/transcript (asserted in tests).
        ...(message.callStatus !== undefined && { call_status: message.callStatus }),
        ...(message.callOutcome !== undefined && { call_outcome: message.callOutcome }),
        ...(message.startedAt !== undefined && { started_at: message.startedAt }),
        ...(message.answeredAt !== undefined && { answered_at: message.answeredAt }),
        ...(message.endedAt !== undefined && { ended_at: message.endedAt }),
        ...(message.callDuration !== undefined && { call_duration: message.callDuration }),
        ...(message.masked === true && { masked: true }),
        ...(message.callPartyLabel !== undefined && { call_party_label: message.callPartyLabel }),
        ...(message.recordingS3Key !== undefined && { recording_s3_key: message.recordingS3Key }),
        ...(message.transcript !== undefined && { transcript: message.transcript }),
        // Voice-extraction Layer 1: source-attributed channel->role map for the
        // call's dual-channel recording (keys = VI mediaChannel ints as strings).
        // Stamped by the two dial sites; read back by joinViSentences via the
        // MessageItem index signature. Call-only; absent on sms/mms/voicemail.
        ...(message.transcriptChannelRoles !== undefined && {
          transcript_channel_roles: message.transcriptChannelRoles,
        }),
        // Email channel v1 (type:'email'): the email fields land beside the
        // broadcastId pattern above. Only-when-present so non-email messages are
        // byte-identical to before.
        ...(message.subject !== undefined && { subject: message.subject }),
        ...(message.email_from !== undefined && { email_from: message.email_from }),
        ...(message.email_to !== undefined && { email_to: message.email_to }),
        ...(message.email_cc !== undefined && { email_cc: message.email_cc }),
        ...(message.email_message_id !== undefined && { email_message_id: message.email_message_id }),
        ...(message.email_references !== undefined &&
          message.email_references.length > 0 && { email_references: message.email_references }),
        ...(message.email_html_sanitized !== undefined && {
          email_html_sanitized: message.email_html_sanitized,
        }),
        ...(message.email_raw_ref !== undefined && { email_raw_ref: message.email_raw_ref }),
        ...(message.email_new_address === true && { email_new_address: true }),
        ...(message.attachments_truncated === true && { attachments_truncated: true }),
        ...(message.headers_truncated === true && { headers_truncated: true }),
      };
      try {
        await doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: table,
                  Item: item,
                  // §7.1 idempotency primitive: same provider message never
                  // persists twice (PK exists, so condition the SK).
                  ConditionExpression: 'attribute_not_exists(tsMsgId)',
                },
              },
              {
                Put: {
                  TableName: table,
                  Item: {
                    conversationId: sidPk(message.providerSid),
                    tsMsgId: 'ptr',
                    ref_conversationId: message.conversationId,
                    ref_tsMsgId: tsMsgId,
                  },
                  ConditionExpression: 'attribute_not_exists(tsMsgId)',
                },
              },
              // Email channel v1: an OUTBOUND email carries its own RFC
              // Message-ID (distinct from the SES providerSid) - write a THIRD
              // emailmsgid#<rfcId> pointer so an inbound reply's In-Reply-To
              // resolves this message via getByRfcMessageId. Only when set
              // (INBOUND uses providerSid == the RFC id, so its sid# pointer is
              // already the threading lookup - no third item).
              ...(message.rfcMessageIdPointer !== undefined
                ? [
                    {
                      Put: {
                        TableName: table,
                        Item: {
                          conversationId: emailMsgIdPk(message.rfcMessageIdPointer),
                          tsMsgId: 'ptr',
                          ref_conversationId: message.conversationId,
                          ref_tsMsgId: tsMsgId,
                        },
                        ConditionExpression: 'attribute_not_exists(tsMsgId)',
                      },
                    },
                  ]
                : []),
              // Native group texting (spec 15.5): a deadline row in the synthetic
              // due partition, written ATOMICALLY with the message. A
              // post-append enqueue would leave a crash window in which a send
              // exists with nothing watching its receipts - and after spec 16.2
              // this sweep is the ONLY detector of a dead receipts webhook.
              // A redelivered send fails this condition too - but so does the
              // SID pointer, and it is the SID POINTER's cancellation reason
              // (never this one) that the branch below reads as a dedupe.
              ...(message.dueRow !== undefined
                ? [
                    {
                      Put: {
                        TableName: table,
                        Item: {
                          conversationId: message.dueRow.partition,
                          tsMsgId: message.dueRow.sortKey,
                          ...message.dueRow.attributes,
                        },
                        ConditionExpression: 'attribute_not_exists(tsMsgId)',
                      },
                    },
                  ]
                : []),
            ],
          }),
        );
      } catch (err) {
        if (err instanceof TransactionCanceledException) {
          // PRECISE ATTRIBUTION, not "any item failed". CancellationReasons is
          // index-aligned with TransactItems, and index 1 is ALWAYS the SID
          // pointer - the one and only item whose condition failing means "this
          // provider message is already persisted". Inferring dedupe from the
          // transaction as a whole would let a due-row (or email-pointer)
          // collision - which rolls the WHOLE transaction back, message row
          // included - report a message as written when nothing was written, and
          // hand the caller a tsMsgId that addresses nothing.
          const reasons = err.CancellationReasons ?? [];
          const sidPointerFailed = reasons[1]?.Code === 'ConditionalCheckFailed';
          if (sidPointerFailed) {
            // The PERSISTED tsMsgId can differ from the one computed above:
            // inbound redeliveries carry no provider timestamp, so a
            // redelivered webhook computes a NEW first-seen providerTs.
            // Resolve the real key via the SID pointer (written in the same
            // transaction as the original message, so it MUST exist here - the
            // read is strongly consistent so "absent" is not a race).
            const ptr = await getSidPointer(message.providerSid, { consistent: true });
            if (ptr === undefined) {
              // The pointer's own condition just failed, so it exists. Falling
              // back to the computed tsMsgId here would silently hand back a key
              // for a row nobody can prove is there.
              log.error(
                { conversationId: message.conversationId, providerSid: message.providerSid },
                'message append deduped but the SID pointer it deduped against cannot be read - refusing to guess the persisted key',
              );
              throw err;
            }
            log.info(
              { conversationId: message.conversationId, providerSid: message.providerSid },
              'message append deduped (provider SID already persisted)',
            );
            return { deduped: true, tsMsgId: ptr.ref_tsMsgId };
          }
          // THE EMAIL POINTER IS NOT THIS BRANCH'S BUSINESS (fix wave 5,
          // adversarial 36). Precise attribution was the right change, but it
          // widened a PRE-EXISTING channel's behaviour as a side effect: the old
          // code returned `{deduped: true}` for ANY ConditionalCheckFailed, so an
          // outbound email whose generated RFC Message-ID pointer collided
          // (index 2) used to succeed; after the change it threw out of
          // sendEmailMessage into a 500. That id collision means this exact
          // message is already persisted under that Message-ID - a genuine
          // dedupe - so resolve the EXISTING key from the pointer and report it,
          // which is both the prior behaviour and an honest answer. The rethrow
          // stays for the cases it was actually written for: the message row's
          // own key, and the group due row.
          const emailPointerIndex = message.rfcMessageIdPointer !== undefined ? 2 : -1;
          const emailPointerOnly =
            emailPointerIndex >= 0 &&
            reasons[emailPointerIndex]?.Code === 'ConditionalCheckFailed' &&
            reasons.every((r, i) => i === emailPointerIndex || r.Code !== 'ConditionalCheckFailed');
          if (emailPointerOnly) {
            const { Item } = await doc.send(
              new GetCommand({
                TableName: table,
                Key: {
                  conversationId: emailMsgIdPk(message.rfcMessageIdPointer as string),
                  tsMsgId: 'ptr',
                },
                ConsistentRead: true,
              }),
            );
            const ptr = Item as { ref_tsMsgId?: string } | undefined;
            log.warn(
              {
                conversationId: message.conversationId,
                providerSid: message.providerSid,
                resolved: ptr?.ref_tsMsgId !== undefined,
              },
              'message append deduped on the RFC Message-ID pointer - this email is already persisted under that Message-ID',
            );
            if (typeof ptr?.ref_tsMsgId === 'string') {
              return { deduped: true, tsMsgId: ptr.ref_tsMsgId };
            }
            // The pointer's own condition just failed, so it exists; an
            // unreadable one is a real fault and must not be guessed at.
            throw err;
          }
          if (reasons.some((r) => r.Code === 'ConditionalCheckFailed')) {
            // A condition failed somewhere OTHER than the SID pointer: the
            // message row's own key collided, or a group due row did. Nothing
            // was written. Loud, and rethrown - never reported as a dedupe.
            log.error(
              {
                conversationId: message.conversationId,
                providerSid: message.providerSid,
                reasons: reasons.map((r) => r.Code ?? 'None'),
              },
              'message append transaction cancelled by a condition OTHER than the provider-SID pointer - nothing was persisted',
            );
          }
        }
        throw err;
      }
      log.info(
        {
          conversationId: message.conversationId,
          providerSid: message.providerSid,
          direction: message.direction,
          type: message.type,
          bodyLength: message.body?.length ?? 0,
          mediaCount: message.mediaUrls?.length ?? 0,
        },
        'message appended',
      );
      return { deduped: false, tsMsgId };
    },

    async updateDeliveryStatus(sid, status, errorCode) {
      const existing = await getByProviderSid(sid);
      if (!existing) {
        log.warn({ providerSid: sid, status }, 'delivery status for unknown provider SID ignored');
        return false;
      }
      const allowed = allowedPriorStatuses(status);
      if (allowed.length === 0) return false; // nothing may transition INTO queued
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId: existing.conversationId, tsMsgId: existing.tsMsgId },
            UpdateExpression:
              errorCode !== undefined
                ? 'SET delivery_status = :s, error_code = :e'
                : 'SET delivery_status = :s',
            // Forward-only: the write commits only from an allowed prior
            // status, so out-of-order callbacks can never regress `delivered`.
            ConditionExpression: `delivery_status IN (${allowed.map((_, i) => `:p${i}`).join(', ')})`,
            ExpressionAttributeValues: {
              ':s': status,
              ...(errorCode !== undefined && { ':e': errorCode }),
              ...Object.fromEntries(allowed.map((p, i) => [`:p${i}`, p])),
            },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info(
            { providerSid: sid, status, currentStatus: existing.delivery_status },
            'delivery status transition skipped (would regress)',
          );
          return false;
        }
        throw err;
      }
      log.info({ providerSid: sid, status, errorCode }, 'delivery status updated');
      return true;
    },

    async recordProviderSidAlias(providerSid, ref) {
      // (1) sid#<providerSid> -> the message: the SAME pointer shape append
      // writes, so getByProviderSid(sesMessageId) / updateDeliveryStatus resolve
      // it. Unconditional Put: a redelivery writes the identical ref (harmless).
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            conversationId: sidPk(providerSid),
            tsMsgId: 'ptr',
            ref_conversationId: ref.conversationId,
            ref_tsMsgId: ref.tsMsgId,
          },
        }),
      );
      // (2) Stamp the SES id on the message for correlation/display. Best-effort
      // idempotent SET (no condition - re-writing the same id is a no-op).
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId: ref.conversationId, tsMsgId: ref.tsMsgId },
          UpdateExpression: 'SET ses_message_id = :m',
          ExpressionAttributeValues: { ':m': providerSid },
        }),
      );
      log.info({ providerSid, conversationId: ref.conversationId }, 'email provider-sid alias recorded');
    },

    async updateCallStatus(callSid, fields) {
      // CallSid == provider_sid, so the same sid# pointer the call append wrote
      // resolves the item — no separate callsid partition needed.
      const existing = await getByProviderSid(callSid);
      if (!existing) {
        log.warn({ callSid, callStatus: fields.callStatus }, 'call status for unknown CallSid ignored');
        return false;
      }
      const allowed = allowedPriorCallStatuses(fields.callStatus);
      if (allowed.length === 0) return false; // nothing transitions INTO ringing
      const sets = ['call_status = :s'];
      const values: Record<string, unknown> = { ':s': fields.callStatus };
      if (fields.callOutcome !== undefined) {
        sets.push('call_outcome = :o');
        values[':o'] = fields.callOutcome;
      }
      if (fields.answeredAt !== undefined) {
        sets.push('answered_at = :a');
        values[':a'] = fields.answeredAt;
      }
      if (fields.endedAt !== undefined) {
        sets.push('ended_at = :e');
        values[':e'] = fields.endedAt;
      }
      if (fields.callDuration !== undefined) {
        sets.push('call_duration = :d');
        values[':d'] = fields.callDuration;
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId: existing.conversationId, tsMsgId: existing.tsMsgId },
            UpdateExpression: `SET ${sets.join(', ')}`,
            // Forward-only: commit only from an allowed prior call_status, so an
            // out-of-order/redelivered callback can never regress a terminal call.
            ConditionExpression: `call_status IN (${allowed.map((_, i) => `:p${i}`).join(', ')})`,
            ExpressionAttributeValues: {
              ...values,
              ...Object.fromEntries(allowed.map((p, i) => [`:p${i}`, p])),
            },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info(
            { callSid, callStatus: fields.callStatus, currentStatus: existing.call_status },
            'call status transition skipped (would regress)',
          );
          return false;
        }
        throw err;
      }
      log.info({ callSid, callStatus: fields.callStatus }, 'call status updated');
      return true;
    },

    async setCallRecording(callSid, recording) {
      // CallSid == provider_sid, so the sid# pointer the call append wrote
      // resolves the item (same as updateCallStatus). PII (doc §9): IDs/keys/
      // durations only — never the RecordingUrl/content.
      const existing = await getByProviderSid(callSid);
      if (!existing) {
        log.warn({ callSid, recordingSid: recording.recordingSid }, 'recording for unknown CallSid ignored');
        return false;
      }
      const sets = ['recording_s3_key = :k', 'recording_sid = :rsid'];
      const values: Record<string, unknown> = {
        ':k': recording.recordingS3Key,
        ':rsid': recording.recordingSid,
      };
      if (recording.recordingDuration !== undefined) {
        sets.push('recording_duration = :d');
        values[':d'] = recording.recordingDuration;
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId: existing.conversationId, tsMsgId: existing.tsMsgId },
            UpdateExpression: `SET ${sets.join(', ')}`,
            // Idempotent per RecordingSid: commit ONLY when no recording is yet
            // stored, so a redelivered recordingStatusCallback (same or a later
            // RecordingSid) never re-stores or overwrites the first one.
            ConditionExpression: 'attribute_not_exists(recording_sid)',
            ExpressionAttributeValues: values,
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info(
            { callSid, recordingSid: recording.recordingSid },
            'recording store skipped (already recorded)',
          );
          return false;
        }
        throw err;
      }
      log.info(
        { callSid, recordingSid: recording.recordingSid, recordingDuration: recording.recordingDuration },
        'call recording stored',
      );
      return true;
    },

    async releaseCallRecording(callSid, recordingSid) {
      // FIX 4: roll back a claim whose media fetch/put failed. CallSid ==
      // provider_sid (same pointer lookup as setCallRecording).
      const existing = await getByProviderSid(callSid);
      if (!existing) return;
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId: existing.conversationId, tsMsgId: existing.tsMsgId },
            UpdateExpression: 'REMOVE recording_sid, recording_s3_key, recording_duration',
            // Only release OUR claim — never clobber a different concurrent
            // writer that has since stored a (different) RecordingSid.
            ConditionExpression: 'recording_sid = :rsid',
            ExpressionAttributeValues: { ':rsid': recordingSid },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          // The claim was already superseded/cleared — nothing to release.
          log.info({ callSid, recordingSid }, 'recording claim release skipped (claim superseded)');
          return;
        }
        throw err;
      }
      log.info({ callSid, recordingSid }, 'call recording claim released (mirror failed)');
    },

    async setCallTranscript(callSid, transcript) {
      // CallSid == provider_sid (same pointer lookup). PII (doc §9): NEVER log
      // the transcript text — length only.
      //
      // PHASE 1 DECISION — "first verbatim wins": the write is conditioned on no
      // (non-empty) transcript existing, so the FIRST transcript to land is
      // permanent. There is NO transcription-SID idempotency, so a CORRECTED
      // re-POST from Voice Intelligence (same call, revised text) is DROPPED, not
      // applied. Accepted for Phase 1 (verbatim capture only; no transcript
      // versioning / structured extraction — that is Phase 2).
      const existing = await getByProviderSid(callSid);
      if (!existing) {
        log.warn({ callSid }, 'transcript for unknown CallSid ignored');
        return false;
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId: existing.conversationId, tsMsgId: existing.tsMsgId },
            // Also stamp transcript_status = 'completed' atomically (spec 3.7).
            // The condition is on `transcript` (NOT status), so a late webhook
            // still upgrades a 'failed' call to completed; completed is terminal.
            UpdateExpression: 'SET transcript = :t, transcript_status = :c',
            // Idempotent: commit ONLY when no (non-empty) transcript exists yet,
            // so a redelivered transcription callback never overwrites a saved
            // transcript. (An empty redelivery is refused at the callback too.)
            ConditionExpression: 'attribute_not_exists(transcript) OR transcript = :empty',
            ExpressionAttributeValues: { ':t': transcript, ':empty': '', ':c': 'completed' },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info({ callSid }, 'transcript save skipped (already transcribed)');
          return false;
        }
        throw err;
      }
      log.info({ callSid, transcriptLength: transcript.length }, 'call transcript saved');
      return true;
    },

    async setTranscriptPending(callSid) {
      // Voice transcription lifecycle (spec 3.7): stamp 'pending' the moment a
      // transcript WILL be requested. CallSid == provider_sid (same pointer
      // lookup). Conditional on no transcript_status yet, so a redelivered
      // recording callback never re-stamps. PII: sids only.
      const existing = await getByProviderSid(callSid);
      if (!existing) {
        log.warn({ callSid }, 'transcript-pending for unknown CallSid ignored');
        return false;
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId: existing.conversationId, tsMsgId: existing.tsMsgId },
            UpdateExpression: 'SET transcript_status = :p',
            ConditionExpression: 'attribute_not_exists(transcript_status)',
            ExpressionAttributeValues: { ':p': 'pending' },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info({ callSid }, 'transcript-pending stamp skipped (already stamped)');
          return false;
        }
        throw err;
      }
      log.info({ callSid }, 'transcript status set to pending');
      return true;
    },

    async setTranscriptFailed(callSid) {
      // Voice transcription lifecycle (spec 3.7): flip 'pending' to 'failed'
      // when the pipeline gives up. Conditional on the status still being
      // 'pending' so a 'completed' transcript is never regressed (completed is
      // terminal). PII: sids only.
      const existing = await getByProviderSid(callSid);
      if (!existing) {
        log.warn({ callSid }, 'transcript-failed for unknown CallSid ignored');
        return false;
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId: existing.conversationId, tsMsgId: existing.tsMsgId },
            UpdateExpression: 'SET transcript_status = :f',
            ConditionExpression: 'transcript_status = :p',
            ExpressionAttributeValues: { ':f': 'failed', ':p': 'pending' },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info({ callSid }, 'transcript-failed stamp skipped (not pending)');
          return false;
        }
        throw err;
      }
      log.info({ callSid }, 'transcript status set to failed');
      return true;
    },

    async upgradeCallOutcomeToVoicemail(callSid) {
      // Platform voicemail (spec 4.2): upgrade 'missed' to 'voicemail' on the
      // completed recording. Conditional on the outcome still being 'missed', so
      // a redelivered recording callback is idempotent (only the first wins).
      const existing = await getByProviderSid(callSid);
      if (!existing) {
        log.warn({ callSid }, 'voicemail outcome upgrade for unknown CallSid ignored');
        return false;
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId: existing.conversationId, tsMsgId: existing.tsMsgId },
            UpdateExpression: 'SET call_outcome = :v',
            ConditionExpression: 'call_outcome = :m',
            ExpressionAttributeValues: { ':v': 'voicemail', ':m': 'missed' },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info({ callSid }, 'voicemail outcome upgrade skipped (not currently missed)');
          return false;
        }
        throw err;
      }
      log.info({ callSid }, 'call outcome upgraded from missed to voicemail');
      return true;
    },

    async annotateMessage(conversationId, tsMsgId, annotations) {
      const sets: string[] = [];
      const values: Record<string, unknown> = {};
      if (annotations.mediaAttachments !== undefined) {
        sets.push('media_attachments = :mediaAttachments');
        values[':mediaAttachments'] = annotations.mediaAttachments;
      }
      if (annotations.retryOf !== undefined) {
        sets.push('retry_of = :retryOf');
        values[':retryOf'] = annotations.retryOf;
      }
      if (annotations.retryAttempt !== undefined) {
        sets.push('retry_attempt = :retryAttempt');
        values[':retryAttempt'] = annotations.retryAttempt;
      }
      if (sets.length === 0) return;
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId, tsMsgId },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(tsMsgId)',
          ExpressionAttributeValues: values,
        }),
      );
      log.info(
        {
          conversationId,
          tsMsgId,
          mediaKeyCount: annotations.mediaAttachments?.length,
          retryOf: annotations.retryOf,
          retryAttempt: annotations.retryAttempt,
        },
        'message annotated',
      );
    },

    async putJobExecutionMarker(jobId, conversationId) {
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: {
              conversationId: jobPk(jobId),
              tsMsgId: 'ran',
              ref_conversationId: conversationId,
              executed_at: new Date().toISOString(),
            },
            ConditionExpression: 'attribute_not_exists(tsMsgId)',
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
      return true;
    },

    async getJobExecutionMarker(jobId) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { conversationId: jobPk(jobId), tsMsgId: 'ran' } }),
      );
      return Item !== undefined;
    },

    async putParkedEmailEvent(event, opts) {
      // Unconditional UPSERT keyed by (sesMessageId, eventType) (m4): a redelivery
      // of the SAME event type before the alias exists overwrites the identical
      // item (idempotent), but a DIFFERENT event type (e.g. a Delivery after a
      // parked Bounce) lands in its own slot instead of clobbering the first.
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            conversationId: emailEventPk(event.sesMessageId),
            tsMsgId: parkedSk(event.eventType),
            event_type: event.eventType,
            ses_message_id: event.sesMessageId,
            ...(event.bounceType !== undefined && { bounce_type: event.bounceType }),
            received_at: opts.receivedAt,
            expires_at: opts.expiresAt,
          },
        }),
      );
      log.info({ sesMessageId: event.sesMessageId, eventType: event.eventType }, 'SES event parked');
    },

    async listParkedEmailEvents(sesMessageId) {
      // ALL parked events for this SES id (the drain applies every one). The
      // partition holds one item per eventType (parked#<eventType>).
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'conversationId = :pk AND begins_with(tsMsgId, :sk)',
          ExpressionAttributeValues: { ':pk': emailEventPk(sesMessageId), ':sk': 'parked#' },
        }),
      );
      const out: ParkedEmailEvent[] = [];
      for (const Item of Items ?? []) {
        const eventType = Item['event_type'];
        const storedId = Item['ses_message_id'];
        if (typeof eventType !== 'string' || typeof storedId !== 'string') continue;
        const bounceType = Item['bounce_type'];
        out.push({
          eventType,
          sesMessageId: storedId,
          ...(typeof bounceType === 'string' && { bounceType }),
        });
      }
      return out;
    },

    async deleteParkedEmailEvent(sesMessageId, eventType) {
      try {
        await doc.send(
          new DeleteCommand({
            TableName: table,
            Key: { conversationId: emailEventPk(sesMessageId), tsMsgId: parkedSk(eventType) },
            // The consume marker: exactly-once even under a concurrent double-apply.
            ConditionExpression: 'attribute_exists(tsMsgId)',
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return;
        throw err;
      }
      log.info({ sesMessageId, eventType }, 'parked SES event consumed');
    },

    async listByConversation(conversationId, opts = {}) {
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: opts.before
            ? 'conversationId = :c AND tsMsgId < :before'
            : 'conversationId = :c',
          ExpressionAttributeValues: {
            ':c': conversationId,
            ...(opts.before && { ':before': opts.before }),
          },
          ScanIndexForward: false, // newest-first
          Limit: opts.limit ?? DEFAULT_PAGE_LIMIT,
        }),
      );
      return (Items ?? []) as MessageItem[];
    },

    async getByTsMsgId(conversationId, tsMsgId) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { conversationId, tsMsgId } }),
      );
      return Item as MessageItem | undefined;
    },

    async getManyByTsMsgIds(conversationId, tsMsgIds) {
      const out = new Map<string, MessageItem>();
      if (tsMsgIds.length === 0) return out;

      // BatchGetItem caps at 100 keys per request.
      for (let i = 0; i < tsMsgIds.length; i += 100) {
        let keys = tsMsgIds.slice(i, i + 100).map((tsMsgId) => ({ conversationId, tsMsgId }));
        for (let attempt = 0; attempt < 4 && keys.length > 0; attempt += 1) {
          if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** (attempt - 1)));
          const res = await doc.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: keys } } }));
          for (const item of (res.Responses?.[table] ?? []) as MessageItem[]) out.set(item.tsMsgId, item);
          keys = (res.UnprocessedKeys?.[table]?.Keys ?? []) as Array<{ conversationId: string; tsMsgId: string }>;
        }
      }
      return out;
    },

    // --- Relay groups (M1.7) -----------------------------------------------

    async setRecipientDelivery(conversationId, tsMsgId, memberKey, delivery) {
      // CHILD-ONLY SET of the recipient slot (delivery_recipients.<memberKey>).
      // The parent `delivery_recipients` map is always pre-seeded on the source
      // message at append time (team-send seeds per-member 'queued'; the relay
      // inbound path seeds an empty map) — so it always exists when the fan-out
      // calls this. DynamoDB rejects an UpdateExpression that SETs both a map
      // and a child of that map in one statement (overlapping document paths),
      // so we must NOT also seed the parent here. memberKey is attacker-free
      // (derived from our own roster) but may contain `#` (phone keys) — bind it
      // as a value, address the map slot via an aliased name to avoid
      // dotted-path parsing issues.
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId, tsMsgId },
          UpdateExpression: 'SET delivery_recipients.#mk = :d',
          ConditionExpression: 'attribute_exists(tsMsgId)',
          ExpressionAttributeNames: { '#mk': memberKey },
          ExpressionAttributeValues: { ':d': delivery },
        }),
      );
    },

    async updateRecipientDeliveryStatus(conversationId, tsMsgId, memberKey, status, errorCode, opts) {
      // Defaults to 'relay' so the four log strings below stay BYTE-IDENTICAL
      // for the one pre-existing caller (webhooks/twilio.ts).
      const label = opts?.context ?? 'relay';
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { conversationId, tsMsgId } }),
      );
      const message = Item as MessageItem | undefined;
      const slot = message?.delivery_recipients?.[memberKey];
      if (!slot) {
        log.warn(
          { conversationId, tsMsgId, status },
          `${label} recipient delivery status for unknown recipient slot ignored`,
        );
        return false;
      }
      const allowed = allowedPriorStatuses(status);
      if (!allowed.includes(slot.status)) {
        log.info(
          { conversationId, tsMsgId, status, currentStatus: slot.status },
          `${label} recipient delivery status transition skipped (would regress)`,
        );
        return false;
      }
      const now = new Date().toISOString();
      // CHILD-FIELD writes (spec 15.2b). The old whole-slot `SET
      // delivery_recipients.#mk = :d` rebuilt the slot from a value read a
      // moment earlier, so a targeted sid write that landed in between was
      // silently discarded. DynamoDB has no conditional SET inside one
      // expression, so the clauses are assembled by hand - the same shape
      // updateDeliveryStatus already uses.
      const sets = ['delivery_recipients.#mk.#st = :s'];
      const names: Record<string, string> = { '#mk': memberKey, '#st': 'status' };
      const values: Record<string, unknown> = { ':s': status, ':prev': slot.status };
      if (errorCode !== undefined) {
        sets.push('delivery_recipients.#mk.#ec = :e');
        names['#ec'] = 'errorCode';
        values[':e'] = errorCode;
      }
      if (status === 'delivered') {
        sets.push('delivery_recipients.#mk.#da = :da');
        names['#da'] = 'deliveredAt';
        values[':da'] = now;
      }
      if (opts?.sid !== undefined) {
        sets.push('delivery_recipients.#mk.#sid = :sid');
        names['#sid'] = 'sid';
        values[':sid'] = opts.sid;
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId, tsMsgId },
            UpdateExpression: `SET ${sets.join(', ')}`,
            // Guard the read-modify-write: only commit if the slot is still on
            // the status we just read (forward-only under concurrent callbacks).
            ConditionExpression: 'delivery_recipients.#mk.#st = :prev',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info(
            { conversationId, tsMsgId, status },
            `${label} recipient delivery status transition lost a race (regressed)`,
          );
          return false;
        }
        throw err;
      }
      log.info({ conversationId, tsMsgId, status, errorCode }, `${label} recipient delivery updated`);
      return true;
    },

    async setRecipientDeliverySid(conversationId, tsMsgId, memberKey, sid) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId, tsMsgId },
            UpdateExpression: 'SET delivery_recipients.#mk.#sid = :sid',
            // The slot must exist and must NOT already carry a sid. Both halves
            // matter: without the first this creates a dangling path error,
            // without the second a redelivered receipt could overwrite the sid
            // a later leg recorded.
            ConditionExpression:
              'attribute_exists(delivery_recipients.#mk) AND attribute_not_exists(delivery_recipients.#mk.#sid)',
            ExpressionAttributeNames: { '#mk': memberKey, '#sid': 'sid' },
            ExpressionAttributeValues: { ':sid': sid },
          }),
        );
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    },

    async putRelaySidPointer(providerSid, ref) {
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: {
              conversationId: relaySidPk(providerSid),
              tsMsgId: 'ptr',
              ref_conversationId: ref.conversationId,
              ref_tsMsgId: ref.tsMsgId,
              ref_member_key: ref.memberKey,
            },
            ConditionExpression: 'attribute_not_exists(tsMsgId)',
          }),
        );
      } catch (err) {
        // A redelivered fan-out re-sends to the same recipient under a NEW
        // provider SID, so a collision here is unexpected — but never fatal:
        // the existing pointer already routes the callback correctly.
        if (err instanceof ConditionalCheckFailedException) return;
        throw err;
      }
    },

    async getRelaySidPointer(providerSid) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { conversationId: relaySidPk(providerSid), tsMsgId: 'ptr' } }),
      );
      const ptr = Item as
        | { ref_conversationId: string; ref_tsMsgId: string; ref_member_key: string }
        | undefined;
      if (!ptr) return undefined;
      return {
        conversationId: ptr.ref_conversationId,
        tsMsgId: ptr.ref_tsMsgId,
        memberKey: ptr.ref_member_key,
      };
    },

    async putSystemSidMarker(providerSid, kind) {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            conversationId: sysSidPk(providerSid),
            tsMsgId: 'ptr',
            kind,
            created_at: new Date().toISOString(),
          },
        }),
      );
      log.info({ providerSid, kind }, 'system-send SID marker written');
    },

    async getSystemSidMarker(providerSid) {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { conversationId: sysSidPk(providerSid), tsMsgId: 'ptr' } }),
      );
      if (!Item) return undefined;
      return { kind: (Item as { kind?: string }).kind ?? 'unknown' };
    },

    async listDueRows(partition, throughIso, limit = DEFAULT_PAGE_LIMIT) {
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'conversationId = :p AND tsMsgId <= :through',
          ExpressionAttributeValues: {
            ':p': partition,
            // Sort keys are `<ISO deadline>#<kind>#<id>`. '~' (0x7E) sorts after
            // the '#' separator, so `<now>~` includes every row whose deadline is
            // exactly `now` and excludes every LATER deadline (the difference
            // shows up inside the ISO prefix).
            ':through': `${throughIso}~`,
          },
          Limit: limit,
          ScanIndexForward: true,
        }),
      );
      return (Items ?? []).map((raw) => {
        const item = raw as Record<string, unknown>;
        return {
          partition,
          sortKey: String(item['tsMsgId']),
          kind: typeof item['due_kind'] === 'string' ? item['due_kind'] : 'unknown',
          deadlineAt: typeof item['deadline_at'] === 'string' ? item['deadline_at'] : '',
          ref: {
            conversationId:
              typeof item['ref_conversationId'] === 'string' ? item['ref_conversationId'] : '',
            tsMsgId: typeof item['ref_tsMsgId'] === 'string' ? item['ref_tsMsgId'] : '',
          },
          ...(typeof item['provider_sid'] === 'string' && { providerSid: item['provider_sid'] }),
          ...(typeof item['conversation_sid'] === 'string' && {
            conversationSid: item['conversation_sid'],
          }),
          ...(typeof item['author'] === 'string' && { author: item['author'] }),
        };
      });
    },

    async deleteDueRow(partition, sortKey) {
      await doc.send(
        new DeleteCommand({ TableName: table, Key: { conversationId: partition, tsMsgId: sortKey } }),
      );
    },

    async claimCrossCheckEvent(messageSid, attrs, expiresAt) {
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: {
              conversationId: groupCrossCheckMarkerPk(messageSid),
              tsMsgId: 'ptr',
              message_sid: messageSid,
              conversation_sid: attrs.conversationSid,
              author: attrs.author,
              received_at: attrs.receivedAt,
              // CLEANUP ONLY (A12). The marker outlives the ledger entry so a
              // redelivery hours later is still recognized as a duplicate.
              expires_at: expiresAt,
            },
            ConditionExpression: 'attribute_not_exists(conversationId)',
          }),
        );
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    },

    async claimCrossCheckClassic(providerSid, attrs, expiresAt) {
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: {
              conversationId: groupCrossCheckClassicPk(providerSid),
              tsMsgId: 'ptr',
              provider_sid: providerSid,
              conversation_sid: attrs.conversationSid,
              member_key: attrs.memberKey,
              filed_at: attrs.filedAt,
              // CLEANUP ONLY (A12), and the marker deliberately OUTLIVES the
              // credit it guards: a redelivery hours later must still be
              // recognized as a duplicate rather than banking a phantom credit.
              expires_at: expiresAt,
            },
            ConditionExpression: 'attribute_not_exists(conversationId)',
          }),
        );
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    },

    async recordCrossCheckEvent(event, bounds) {
      const { notBeforeIso, nowIso, expiresAt } = bounds;
      const pairKey = event.pairKey;
      const key = { conversationId: pairKey, tsMsgId: GROUP_CROSSCHECK_STATE_SORT_KEY };
      const pairSortKey = crossCheckEventSortKey(event.deadlineAt, event.messageSid);
      const dueSortKey = groupCrossCheckDueSortKey(event.deadlineAt, event.messageSid);

      // (1) THE ROWS FIRST, UNCOUNTED. The classic half claims a pending ROW
      // whenever the balance says one exists, so the row has to be durable
      // before the bump that says so. What is new (fix wave 2, adversarial 11)
      // is `counted`: until the bump lands, this row is NOT accounted for in the
      // balance, and both consumers know it. That is what stops a throw between
      // these two steps from cascading - previously such a row was alarmed by
      // the sweep, whose bare pair-scoped release then took a DIFFERENT event's
      // slot, making that one alarm falsely and banking a spurious credit able
      // to absorb a later real miss. It does NOT make the sequence atomic -
      // there is no transaction here; the interface docstring above prices what
      // an uncounted row still costs.
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            conversationId: pairKey,
            tsMsgId: pairSortKey,
            message_sid: event.messageSid,
            conversation_sid: event.conversationSid,
            author: event.author,
            deadline_at: event.deadlineAt,
            expires_at: expiresAt,
          },
        }),
      );
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            conversationId: GROUP_CROSSCHECK_DUE_PARTITION,
            tsMsgId: dueSortKey,
            due_kind: GROUP_CROSSCHECK_DUE_KIND,
            deadline_at: event.deadlineAt,
            // `ref` points back at the pair row, so resolving an alarm can drop
            // both without re-deriving anything.
            ref_conversationId: pairKey,
            ref_tsMsgId: pairSortKey,
            provider_sid: event.messageSid,
            conversation_sid: event.conversationSid,
            author: event.author,
            expires_at: expiresAt,
          },
        }),
      );

      // (2) THE BALANCE. One atomic ADD in the common case - no read, so a hot
      // pair with many events and filings in flight never has to retry.
      //
      // WHAT THE EVENT HALF COSTS (fix wave 3, adversarial 7). Four writes, not
      // the two wave 1 issued: two Puts, this ADD, and the `counted` mark - plus
      // two Deletes on the credit branch, and up to a further 24 round trips if
      // `discardStaleCredits` engages on a contended pair. In production that is
      // ~6 sequential round trips per railed group inbound on the Conversations
      // webhook (the liveness stamp and the event claim included), comfortably
      // inside Twilio's 5s budget at single-digit-ms latencies. It is loud in
      // ONE place: DynamoDB Local's single SQLite write lock, which is why the
      // heaviest seed suites needed a bigger budget in the same wave.
      let balance: number;
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: key,
            UpdateExpression: 'ADD #b :one SET #e = :exp',
            // Refuse ONLY the stale-credit case: the pair is in credit AND the
            // oldest of those credits predates the match window. Everything else
            // (no state item yet, a square pair, a fresh credit) proceeds.
            ConditionExpression:
              'attribute_not_exists(#b) OR #b >= :zero OR attribute_not_exists(#cs) OR #cs >= :notBefore',
            ExpressionAttributeNames: { '#b': 'balance', '#e': 'expires_at', '#cs': 'credit_since' },
            ExpressionAttributeValues: {
              ':one': 1,
              ':zero': 0,
              ':exp': expiresAt,
              ':notBefore': notBeforeIso,
            },
            ReturnValues: 'UPDATED_NEW',
          }),
        );
        balance = Number((Attributes as { balance?: number } | undefined)?.balance ?? 1);
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        balance = await discardStaleCredits(pairKey, notBeforeIso, nowIso, expiresAt);
      }

      if (balance <= 0) {
        // The ADD landed on a banked credit: this event is matched, so its rows
        // are retracted. (Order is what makes the retract safe: nothing can
        // claim a row for an event the balance says is not pending.)
        await doc.send(
          new DeleteCommand({ TableName: table, Key: { conversationId: pairKey, tsMsgId: pairSortKey } }),
        );
        await doc.send(
          new DeleteCommand({
            TableName: table,
            Key: { conversationId: GROUP_CROSSCHECK_DUE_PARTITION, tsMsgId: dueSortKey },
          }),
        );
        return 'credit';
      }

      // (3) COUNTED. The balance now accounts for this row, so say so on the row
      // itself: the claim path consumes only counted rows, and the sweep gives a
      // slot back only for a counted row it alarmed.
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId: pairKey, tsMsgId: pairSortKey },
            UpdateExpression: 'SET counted = :yes',
            ConditionExpression: 'attribute_exists(conversationId)',
            ExpressionAttributeValues: { ':yes': true },
          }),
        );
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // THE ROW IS GONE, AND NOT FOR THE REASON THIS CATCH USED TO CLAIM (fix
        // wave 3, adversarial 5). It cannot have been claimed by a classic
        // filing - the claim reads counted rows only, and this row is not
        // counted yet - nor by the sweep, whose deadline is a whole grace window
        // away. So if this branch is ever entered the row vanished for some
        // other reason, and the +1 this bump just made is a phantom slot with no
        // row under it. Self-correcting: the next classic filing for the pair
        // reports 'matched', finds nothing claimable, and logs
        // `group_crosscheck_pending_row_missing` - one extra WARN, never a
        // missed alarm. Swallowed rather than thrown because the rows and the
        // balance are already durable and the caller's answer is unchanged.
      }
      return 'pending';
    },

    async bumpCrossCheckClassic(pairKey, nowIso, expiresAt) {
      const key = { conversationId: pairKey, tsMsgId: GROUP_CROSSCHECK_STATE_SORT_KEY };
      const names = { '#b': 'balance', '#e': 'expires_at', '#cs': 'credit_since' };
      try {
        // FIRST CREDIT of a run stamps `credit_since`, so the freshness bound
        // the event half applies is the age of the OLDEST outstanding credit.
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: key,
            UpdateExpression: 'ADD #b :negOne SET #cs = :now, #e = :exp',
            ConditionExpression: 'attribute_not_exists(#b) OR #b >= :zero',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: {
              ':negOne': -1,
              ':zero': 0,
              ':now': nowIso,
              ':exp': expiresAt,
            },
            ReturnValues: 'UPDATED_NEW',
          }),
        );
        const balance = Number((Attributes as { balance?: number } | undefined)?.balance ?? -1);
        return balance >= 0 ? 'matched' : 'credit';
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
      }
      // The pair is ALREADY in credit: stack another one and keep the existing
      // `credit_since` (the oldest credit is the one the window is measured on).
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: key,
          UpdateExpression: 'ADD #b :negOne SET #e = :exp',
          ExpressionAttributeNames: { '#b': 'balance', '#e': 'expires_at' },
          ExpressionAttributeValues: { ':negOne': -1, ':exp': expiresAt },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      const balance = Number((Attributes as { balance?: number } | undefined)?.balance ?? -1);
      return balance >= 0 ? 'matched' : 'credit';
    },

    async releaseCrossCheckPending(pairKey) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId: pairKey, tsMsgId: GROUP_CROSSCHECK_STATE_SORT_KEY },
            UpdateExpression: 'ADD #b :negOne',
            ConditionExpression: '#b > :zero',
            ExpressionAttributeNames: { '#b': 'balance' },
            ExpressionAttributeValues: { ':negOne': -1, ':zero': 0 },
          }),
        );
      } catch (err) {
        // Already square (or claimed by a classic filing in the same instant).
        // Giving a slot back is best effort by construction.
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
      }
    },

    async claimOldestCrossCheckPending(pairKey) {
      // COUNTED ROWS ONLY (fix wave 2, adversarial 11), FILTERED AT THE INDEX
      // (fix wave 3, adversarial 2). A row whose balance bump has not landed is
      // not one of the pending slots this balance is reporting, so consuming it
      // would leave a counted row unmatched - and that one would then alarm
      // falsely. An uncounted row is left alone; the sweep alarms and drops it
      // at its deadline. Paging is what stops those rows from shadowing the
      // claimable ones: see CROSSCHECK_CLAIM_PAGE_SIZE.
      async function readClaimable(): Promise<Record<string, unknown>[]> {
        const claimable: Record<string, unknown>[] = [];
        let startKey: Record<string, unknown> | undefined;
        for (let page = 0; page < CROSSCHECK_CLAIM_PAGES; page += 1) {
          const { Items, LastEvaluatedKey } = await doc.send(
            new QueryCommand({
              TableName: table,
              KeyConditionExpression: 'conversationId = :p AND tsMsgId BETWEEN :lo AND :hi',
              FilterExpression: '#c = :counted',
              ExpressionAttributeNames: { '#c': 'counted' },
              ExpressionAttributeValues: {
                ':p': pairKey,
                ':lo': CROSSCHECK_EVENT_PREFIX,
                ':hi': `${CROSSCHECK_EVENT_PREFIX}~`,
                ':counted': true,
              },
              ScanIndexForward: true, // OLDEST pending event first
              // STRONGLY CONSISTENT BY CONTRACT. The event half writes this row
              // microseconds before the balance bump that sends a caller here,
              // so an eventually-consistent read can miss a row that certainly
              // exists - which is exactly how the old ledger produced false
              // `group_crosscheck_inbound_missing` ERRORs on healthy traffic.
              ConsistentRead: true,
              Limit: CROSSCHECK_CLAIM_PAGE_SIZE,
              ...(startKey !== undefined && { ExclusiveStartKey: startKey }),
            }),
          );
          claimable.push(...((Items ?? []) as Record<string, unknown>[]));
          // A few in hand is enough: if another claimant takes the oldest, the
          // next-oldest is already here.
          if (claimable.length >= CROSSCHECK_CLAIM_ATTEMPTS) break;
          startKey = LastEvaluatedKey as Record<string, unknown> | undefined;
          if (startKey === undefined) break;
        }
        return claimable.slice(0, CROSSCHECK_CLAIM_ATTEMPTS);
      }

      for (let attempt = 0; attempt < CROSSCHECK_CLAIM_ATTEMPTS; attempt += 1) {
        let items = await readClaimable();
        // AN EMPTY READ IS NOT YET AN ANSWER (fix wave 4, item 2). This function
        // is only ever reached when the balance has just said a pending event
        // exists, and the commonest way for that to be true with nothing
        // claimable is that the event half's `SET counted` is still in flight -
        // one round trip behind the bump that sent us here. Waiting a beat and
        // re-reading turns a false `group_crosscheck_inbound_missing` ERROR into
        // the match it actually was. See CROSSCHECK_MARK_WAIT_MS.
        for (let wait = 0; items.length === 0 && wait < CROSSCHECK_MARK_WAIT_READS; wait += 1) {
          await new Promise((resolve) => setTimeout(resolve, CROSSCHECK_MARK_WAIT_MS));
          items = await readClaimable();
        }
        if (items.length === 0) return undefined;
        for (const item of items) {
          const sortKey = String(item['tsMsgId']);
          const messageSid = String(item['message_sid']);
          const deadlineAt = String(item['deadline_at']);
          try {
            // THE CLAIM. Conditional, and its result IS inspected: two
            // concurrent claimants cannot both take one row.
            await doc.send(
              new DeleteCommand({
                TableName: table,
                Key: { conversationId: pairKey, tsMsgId: sortKey },
                ConditionExpression: 'attribute_exists(conversationId)',
              }),
            );
          } catch (err) {
            if (err instanceof ConditionalCheckFailedException) continue; // lost it
            throw err;
          }
          await doc.send(
            new DeleteCommand({
              TableName: table,
              Key: {
                conversationId: GROUP_CROSSCHECK_DUE_PARTITION,
                tsMsgId: groupCrossCheckDueSortKey(deadlineAt, messageSid),
              },
            }),
          );
          return {
            pairKey,
            messageSid,
            conversationSid: String(item['conversation_sid'] ?? ''),
            author: String(item['author'] ?? ''),
            deadlineAt,
          };
        }
      }
      return undefined;
    },

    async resolveCrossCheckPending(pairKey, pairSortKey, dueSortKey) {
      let deletedPairRow = false;
      try {
        await doc.send(
          new DeleteCommand({
            TableName: table,
            Key: { conversationId: pairKey, tsMsgId: pairSortKey },
            // Inspected, not assumed: a classic filing may have claimed this row
            // between the sweep's read and here, and it already paid the balance.
            ConditionExpression: 'attribute_exists(conversationId)',
          }),
        );
        // COUNTED OR NOT (fix wave 3, conformance 1). An uncounted row may still
        // have a +1 standing behind it - the bump lands before the mark - and
        // leaving that slot stranded costs a later filing AND an extra alarm.
        // The release is balance-guarded, so where the bump never landed there
        // is nothing to take.
        deletedPairRow = true;
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
      }
      await doc.send(
        new DeleteCommand({
          TableName: table,
          Key: { conversationId: GROUP_CROSSCHECK_DUE_PARTITION, tsMsgId: dueSortKey },
        }),
      );
      return deletedPairRow;
    },

    async parkGroupReceipt(receipt, opts) {
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: {
              conversationId: groupReceiptPk(receipt.messageSid),
              tsMsgId: parkedParticipantSk(receipt.participantSid),
              message_sid: receipt.messageSid,
              participant_sid: receipt.participantSid,
              status: receipt.status,
              ...(receipt.errorCode !== undefined && { error_code: receipt.errorCode }),
              ...(receipt.channelMessageSid !== undefined && {
                channel_message_sid: receipt.channelMessageSid,
              }),
              parked_at: receipt.parkedAt,
              rank: opts.rank,
              // CLEANUP ONLY (spec 15.5). The drain is the authoritative
              // consume; this just stops an unclaimed park accruing forever.
              expires_at: opts.expiresAt,
            },
            // Forward-only within the slot: `<=` keeps a redelivery of the same
            // status idempotent while refusing a late lower-ranked one.
            ConditionExpression: 'attribute_not_exists(tsMsgId) OR #r <= :r',
            ExpressionAttributeNames: { '#r': 'rank' },
            ExpressionAttributeValues: { ':r': opts.rank },
          }),
        );
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    },

    async listParkedGroupReceipts(messageSid) {
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'conversationId = :p',
          ExpressionAttributeValues: { ':p': groupReceiptPk(messageSid) },
          // STRONGLY CONSISTENT (fix wave 5, adversarial 17). This read is the
          // cardinality check behind MAX_PARKED_GROUP_RECEIPTS, and it is also
          // the drain's work list. An eventually-consistent read made the bound
          // trivially exceedable by receipts arriving milliseconds apart and let
          // a drain miss a park it should have consumed. The partition holds at
          // most a rail's worth of rows, so the cost is negligible.
          ConsistentRead: true,
        }),
      );
      return (Items ?? []).map((raw) => {
        const item = raw as Record<string, unknown>;
        return {
          messageSid,
          participantSid: String(item['participant_sid'] ?? ''),
          status: String(item['status'] ?? ''),
          ...(typeof item['error_code'] === 'string' && { errorCode: item['error_code'] }),
          ...(typeof item['channel_message_sid'] === 'string' && {
            channelMessageSid: item['channel_message_sid'],
          }),
          parkedAt: typeof item['parked_at'] === 'string' ? item['parked_at'] : '',
        };
      });
    },

    async deleteParkedGroupReceipt(messageSid, participantSid) {
      await doc.send(
        new DeleteCommand({
          TableName: table,
          Key: {
            conversationId: groupReceiptPk(messageSid),
            tsMsgId: parkedParticipantSk(participantSid),
          },
        }),
      );
    },
  };
}
