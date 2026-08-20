// conversations repo — thread headers + inbox index (doc §5).
//
// One ACTIVE 1:1 conversation per external phone: createOrGetByParticipantPhone
// queries the byParticipantPhone GSI as the fast path, with a phone-keyed
// CLAIM item (PK `phone#<E164>`, the same pointer pattern as the messages
// repo's SID items) as the correctness backstop — the GSI is eventually
// consistent, so two near-concurrent first messages can both miss it. Item
// shape is a flexible document; only keys/GSI attributes (conversationId,
// participant_phone, status, last_activity_at) are contractual
// (lib/tables.ts).
//
// Circuit-breaker state (doc §7.1) lives ON the conversation item as a
// minute-bucketed counter pair (outbound_minute_bucket + outbound_minute_count)
// maintained by conditional updates — see incrementAutomatedSendCount().
//
// PII: message bodies/previews must NEVER be logged (doc §9) — log lines here
// carry IDs and lengths only; correlation context is attached by the pino mixin.
import { randomBytes, randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';

/**
 * Conversation thread types (doc §5). `unknown_1to1` (2026-06-12 deviation)
 * mirrors the contact-side honesty rule: a thread with no resolved
 * tenant/landlord identity is typed `unknown_1to1`, never guessed.
 * `relay_group` (M1.7) is a multi-party masked thread fronted by a pool
 * number — inbound on the pool number fans out to the other members.
 * `group_text` (native group texting) is a CARRIER group thread on our own
 * business number: no pool number, no fan-out, identity is the sorted outside
 * roster (services/groupIdentity.ts). It lives in its own `group_open` status
 * partition of byLastActivity - never in the 1:1 `open` partition.
 */
export type ConversationType =
  | 'tenant_1to1'
  | 'landlord_1to1'
  | 'partner_1to1'
  | 'unknown_1to1'
  | 'relay_group'
  | 'group_text';

/**
 * The ONE status a `group_text` thread ever carries: its own partition of the
 * EXISTING byLastActivity GSI (HASH is `status`). Group threads are therefore
 * invisible to every reader that queries the `open` partition (Today's capped
 * 100-row read, the inbox contact pager, GET /api/conversations?status=open) -
 * deliberate, and the reason no new GSI/Terraform/lane reset is needed. The
 * repo GUARDS the partition: see touchLastActivity.
 */
export const GROUP_TEXT_STATUS = 'group_open';

/**
 * The ONE value the sparse byUnread GSI's HASH attribute ever carries. A
 * CONSTANT (not a status/type encoding) so that only the unread primitives
 * maintain the attribute: encoding lifecycle state into the key would oblige
 * every status writer to keep it in lockstep, the bug class relay_status has
 * already cost us. Readers filter the projected live status/type instead.
 */
export const UNREAD_FLAG_VALUE = 'unread';

/**
 * The ONE value the sparse byRelayOptOut GSI's HASH attribute ever carries
 * (2026-08-18). Same discipline as UNREAD_FLAG_VALUE: a constant, maintained
 * only by the opt-out primitives (setRelayMemberOptedOut /
 * clearRelayMemberOptedOut) and dropped by the relay-close write, so the index
 * holds exactly the relay groups with a non-empty `relay_opted_out_members` map
 * - the "someone opted out and is still on the roster" attention set Today
 * surfaces - and nothing else.
 */
export const RELAY_OPTOUT_FLAG_VALUE = 'attention';

/**
 * The three kinds `setUnread` conditions on - MU-1 ("unread the human should
 * see", lib/unreadFeed.ts isUnreadVisible) expressed as a WRITE precondition
 * rather than a prior read. The caller names the bucket from the item it read;
 * the ConditionExpression re-checks that reading against the LIVE row, so a
 * concurrent status/type transition loses instead of planting an invisible
 * byUnread resident. `one_to_one` is the NEGATIVE bucket, mirroring
 * isOneToOneBucket: a legacy row with no `type` belongs to it.
 */
export type UnreadBucket = 'relay_group' | 'group_text' | 'one_to_one';

/** Phase 2 hands `auto` to the AI; `manual` means humans only (breaker trips here). */
export type ConversationMode = 'auto' | 'manual';

/**
 * A linked external participant (M1.2 auto-capture): contact + phone pair.
 * For relay groups (M1.7) the array is the MUTABLE member roster — the
 * "relay-group seam" the 1:1 comment names — and each member may carry an
 * optional `name`, the sender-prefix display name resolved from the contact
 * at member-add time (absent when no name is known; the fan-out then uses a
 * neutral label and NEVER leaks the sender's phone).
 */
export interface ConversationParticipant {
  contactId: string;
  phone: string;
  /** Sender-prefix display name (relay groups); resolved from the contact, may be absent. */
  name?: string;
}

/** The contractual + commonly read attributes; items stay flexible documents. */
export interface ConversationItem {
  conversationId: string;
  /**
   * External participant's phone, E.164 (byParticipantPhone GSI). 1:1 threads
   * carry a real phone; relay_group threads have no single counterparty, so
   * this is a synthetic placeholder (the pool number) — relay routing goes
   * through pool_number / byPoolNumber, never this field. OPTIONAL (email
   * channel v1): an email-only 1:1 thread carries `participant_email` and NO
   * phone - channel-agnostic readers fall back to `participant_display_name`.
   */
  participant_phone?: string;
  /**
   * External participant's email address, normalized (byParticipantEmail GSI
   * HASH; email channel v1). Set ONLY on email-participating conversations by
   * the email#<addr> claim arbiter (attachEmailToConversation /
   * createOrGetByParticipantEmail) - the single writer. Absent on phone-only
   * 1:1 threads and relay groups (keeps the GSI sparse).
   */
  participant_email?: string;
  /**
   * URL-safe reply token (email channel v1): minted once by getReplyToken and
   * embedded in an outbound email's Reply-To (`relay+<token>@<domain>`), so an
   * inbound reply routes back to THIS conversation via the token#<tok> reverse
   * pointer even when the sender replies from a new address. Absent until the
   * first outbound email on the thread.
   */
  email_reply_token?: string;
  /**
   * byLastActivity GSI HASH. 1:1 threads only ever write `open`. relay_group
   * threads use `connecting` | `open` | `closed`. `connecting` (relay number
   * buying strategy D9) is a group awaiting its pool number (connect-when-ready):
   * it has NO pool_number yet, the composer QUEUES instead of sends, and
   * assignPoolNumberAndOpen flips it to `open` when the number registers. Closing
   * KEEPS the pool number (a closed group stays resolvable so late texts intercept
   * to the sender's 1:1); reopening reuses the SAME number (nothing is
   * re-provisioned). This is the coarse field the dashboard + inbox key on (D9).
   * `group_text` threads carry `group_open` and NOTHING else (GROUP_TEXT_STATUS)
   * - their own partition, guarded in this repo so no writer can flip them out
   * of it (an unrecoverable loss: nothing points back into the partition).
   */
  status: string;
  /** byLastActivity GSI RANGE (ISO 8601). */
  last_activity_at: string;
  type: ConversationType;
  ai_mode: ConversationMode;
  /**
   * Pool number fronting a relay_group thread (E.164; byPoolNumber GSI HASH).
   * Set ONLY for relay_group conversations — absent on 1:1 threads, which is
   * what keeps the byPoolNumber GSI sparse. NEVER cleared once set: a number
   * may front MANY groups (open + closed) under the burn-multiplexing model, so
   * byPoolNumber is a MULTI-match index - resolve via getAllByPoolNumber.
   */
  pool_number?: string;
  /**
   * Conversation-level STOP suppression (doc §7.1): set even when the phone
   * has no contact record yet (auto-capture is M1.2), so a STOP from an
   * unknown phone still refuses every later send. The send wrapper gates on
   * EITHER this OR the contact's sms_opt_out flag.
   */
  sms_opt_out?: boolean;
  /** Denormalized preview of the latest message (truncated; never logged). */
  last_message_preview?: string;
  /**
   * Participants → contactIds (doc §5; M1.2 auto-capture). 1:1 threads carry
   * exactly one entry; the array shape is the relay-group seam. Written once
   * via setParticipantsIfAbsent — the auto-capture race anchor.
   */
  participants?: ConversationParticipant[];
  /**
   * Optimistic-concurrency version for the relay roster (FIX 3): bumped on
   * every real add/remove so concurrent roster mutations can't silently
   * clobber each other. Absent until the first mutation (treated as 0).
   */
  participants_version?: number;
  /**
   * Denormalized resolved display name of the 1:1 participant (M1.4 triage):
   * the inbox is ONE Query and the conversation record carries no name, so the
   * resolved "First Last" is copied here when triage names the contact. Absent
   * when no name is known — the inbox falls back to the phone, never a guess.
   */
  participant_display_name?: string;
  /** Inbound messages since the last POST /:id/read (M1.2 unread tracking). */
  unread_count?: number;
  /**
   * Sparse byUnread GSI HASH - present IFF unread_count > 0 (the constant
   * string 'unread'). Maintained ONLY by incrementUnread / resetUnread /
   * setUnread and the relay-close / contact-delete resets; status and type
   * transitions leave it alone. Never exposed on a constructed wire shape (it
   * does ride the raw item returned by GET /api/conversations/:conversationId
   * - accepted: internal client, ignores unknown fields).
   */
  unread_flag?: 'unread';
  /**
   * The placement this relay_group is the thread for (M1.10): the
   * conversation→placement BACK-REFERENCE. It lets the voice masked-call seam resolve
   * the landlord-leg target (placement→unit.primary_contact) and the
   * failed-send escalation flag the right placement. Set when a relay is provisioned
   * FROM a placement; absent on 1:1 threads and standalone (test-scaffold) relays.
   *
   * LEGACY: superseded by `owner` (Task 5 generalization). `owner` is the
   * canonical field for new code; `placementId` is kept for back-compat with
   * existing rows and callers. `getOwner(conv)` falls back to this when `owner`
   * is absent.
   */
  placementId?: string;
  /**
   * Generic owner reference (Task 5): the entity this relay_group thread belongs
   * to. `{type:'placement', id}` mirrors the legacy placementId; `{type:'tour',
   * id}` is a tour-owned thread; `{type:null}` or absent means standalone/unowned.
   * NOT in any key/GSI — owner is metadata only (same rule as placementId).
   */
  owner?: { type: 'tour' | 'placement' | null; id?: string };
  /**
   * Operator-edited group-intro copy (relay_group only, 2026-08-20). Present
   * ONLY when the operator changed the previewed text in the confirm dialog
   * before creating the group; absent means relayFanOut composes the intro from
   * the catalog exactly as before. Read once, by the intro announcement.
   *
   * FOUNDER DECISION: this is free operator text on a FIRST-CONTACT message. It
   * carries no brand and no opt-out line, matching the catalog default the
   * founder already directed (see relay.intro in messages/catalog.ts) - length
   * is the only constraint enforced. Do not add opt-out validation here without
   * asking her; it was removed on purpose.
   */
  intro_body?: string;
  created_at: string;
  /** Circuit-breaker minute bucket (`YYYY-MM-DDTHH:mm`, UTC). */
  outbound_minute_bucket?: string;
  /** Automated sends observed within outbound_minute_bucket. */
  outbound_minute_count?: number;
  /**
   * Relay opt-out signal (A2P): members of THIS relay_group who were skipped by
   * the fan-out because they carry contact-level `sms_opt_out` — so staff can be
   * alerted (Today attention item) and investigate/remove them. Keyed by the
   * relayMemberKey (contactId, else `phone#<E164>`); the entry records the member
   * for display + the instant it was observed. The Today endpoint LIVE-CONFIRMS
   * each entry is still opted out, so an opt-back-in / removal auto-resolves the
   * item even before the entry is cleared. Storing phone/name here is DATA (for
   * display) — never logged. Absent on 1:1 threads.
   */
  relay_opted_out_members?: Record<
    string,
    { contactId?: string; phone?: string; name?: string; at: string }
  >;
  /**
   * Sparse byRelayOptOut GSI HASH (2026-08-18) - present IFF
   * `relay_opted_out_members` is non-empty (the constant 'attention').
   * Maintained ONLY by setRelayMemberOptedOut / clearRelayMemberOptedOut and
   * dropped by the relay-close write; status/type transitions otherwise leave it
   * alone. Today's relay opt-out attention pass reads this index instead of
   * walking the open partition. Never exposed on a constructed wire shape.
   */
  relay_optout_flag?: 'attention';
  /**
   * byRelayStatus GSI HASH: `relay_group#<status>` (`relay_group#connecting` /
   * `relay_group#open` / `relay_group#closed`). Written ONLY on relay_group
   * conversations - 1:1 threads never carry it, keeping the GSI sparse (relay
   * groups only). Kept in lockstep with `status` by every relay-group writer
   * (create/assign/close/reopen). listRelayGroups queries this partition
   * directly, so a relay group can never be diluted out of the byLastActivity
   * 'open' partition by open 1:1 volume - and a connecting group is queryable
   * via its own partition even though it has no pool number yet (D9).
   */
  relay_status?: string;
  /**
   * Recurring 28-day close-ask nag (D5): the instant this OPEN relay group's
   * "still open - close it?" nag is next due on Today. Set when the inline
   * close-ask is deferred / "Keep open" (now + CLOSE_NAG_INTERVAL_MS); CLEARED
   * on close. Absent until the first deferral. Relay groups only.
   */
  close_nag_next_at?: string;
  /**
   * Burn provenance (relay groups): the E.164 phones whose burn on this group's
   * pool number belongs to THIS group's history - seeded from the initial roster
   * at createRelayGroup and ADDed on every member add. A DynamoDB string set
   * (reads back as a JS Set<string>); absent on legacy groups created before this
   * attribute existed (member-add initializes it from the current roster then).
   * Member REMOVE never touches it - a burn is forever, so a removed member can
   * be re-added without a fresh (number, phone) claim.
   */
  ever_member_phones?: Set<string> | string[];
  /**
   * Close-announce dedup claim: the instant the ONE relay.group_closed final
   * message was claimed (set by the atomic claimCloseAnnounce, condition
   * status=open AND this attr absent). Cleared on reopen so a future close
   * announces again. Its presence-while-open is the crash-retry marker: a close
   * retry after a crash-between-announce-and-flip sees it set and skips the
   * (already-sent) announcement, proceeding straight to the idempotent flip.
   */
  close_announced_at?: string;
  /**
   * `group_text` only: the CHxx of the Twilio Conversations rail backing this
   * carrier group (the outbound send path). Absent before the rail exists or
   * when rail creation failed - readers must treat absence as "no rail yet",
   * never as an error. Written ONLY by setTwilioConversation, which is fenced
   * on the rail_creating claim below.
   */
  twilio_conversation_sid?: string;
  /**
   * `group_text` only: the rail's participant map, MBxx -> member key
   * (`phone#<E164>`, spec 15.6). Late per-member receipts carry only the MBxx,
   * so this is what makes them attributable. Written with the CHxx in ONE
   * fenced update so a sid can never outlive its map.
   */
  twilio_participant_map?: Record<string, string>;
  /**
   * `group_text` only: the business number the rail was VERIFIED to carry as
   * its projected-address participant - i.e. the one Author a post can use.
   * Written by the same fenced finalize as the sid. `ensureGroupRail` trusts a
   * stored rail without a Twilio read ONLY while this equals the current
   * BUSINESS_PHONE_NUMBER; absent (every rail finalized before 2026-08-17) or
   * different (the number changed under the rail), it re-reads Twilio and
   * repairs. Prod incident 2026-08-17: 135 rails were posted to as a number
   * they did not carry, and every staff group reply failed with 50513.
   */
  twilio_projected_address?: string;
  /**
   * `group_text` only: the in-flight rail-creation claim ({token, at}).
   * ensureGroupRail claims it before talking to Twilio and setTwilioConversation
   * finalizes CONDITIONAL on the token still matching, so an expired claimant
   * that wakes up late cannot overwrite a newer claimant's rail. REMOVEd by a
   * successful finalize.
   */
  rail_creating?: { token: string; at: string };
  /**
   * `group_text` only: the last rail-creation FAILURE ({at, reason}). Written by
   * ensureGroupRail when Twilio refused the roster (a 50407-class member), when
   * the conversation came back closed/failed, or when the participant map did
   * not cover the roster. It is a REPORT, not a fence - it never blocks a retry,
   * and the migration report reads the same reason string live.
   *
   * CLEARED BY A SUCCESSFUL FENCED FINALIZE (fix wave 5, adversarial 10), so it
   * answers "is this rail broken NOW", which is the question spec 14's cutover
   * gate asks. Left uncleared it over-reported: a thread that hit a 429 on one
   * participant and succeeded on the retry a minute later read as a permanent
   * failure forever, indistinguishable from a landline member that can never be
   * railed. Readers: the convergence report (lib/import/convertGroups.ts) and
   * the rail re-enqueue back-off (routes/webhooks/twilio.ts).
   */
  rail_failed?: { at: string; reason: string };
  [key: string]: unknown;
}

/**
 * byRelayStatus GSI partition key for a relay group in the given status.
 * `connecting` (D9) is the connect-when-ready state: the group exists but has no
 * pool number yet, so it lives in its own `relay_group#connecting` partition
 * (listRelayGroups('connecting') surfaces it to the inbox).
 */
export function relayStatusKey(status: 'open' | 'closed' | 'connecting'): string {
  return `relay_group#${status}`;
}

/**
 * Close-ask nag interval (D5): 28 days = exactly 4 weeks, so a deferred nag
 * always lands on the same weekday it was deferred on and recurs within the
 * month. Named export so no magic number sits inline at the call sites.
 */
export const CLOSE_NAG_INTERVAL_MS = 28 * 24 * 60 * 60 * 1000;

/**
 * Generalized owner of a relay_group conversation (Task 5).
 * `type: null` means standalone/unowned.
 */
export type RelayOwner = { type: 'tour' | 'placement'; id: string } | { type: null };

/**
 * Resolve the canonical owner of a relay_group conversation (Task 5).
 * New rows carry `owner`; legacy placement-backed rows carry only `placementId`.
 * Falls back so existing rows keep working without a migration.
 *
 * PII (doc §9): returns IDs only — never a phone or display name.
 */
export function getOwner(conv: ConversationItem): RelayOwner {
  if (conv.owner !== undefined) {
    if (conv.owner.type === 'tour' && typeof conv.owner.id === 'string') {
      return { type: 'tour', id: conv.owner.id };
    }
    if (conv.owner.type === 'placement' && typeof conv.owner.id === 'string') {
      return { type: 'placement', id: conv.owner.id };
    }
    return { type: null };
  }
  // Legacy fallback: placementId present → placement-owned.
  if (typeof conv.placementId === 'string' && conv.placementId.length > 0) {
    return { type: 'placement', id: conv.placementId };
  }
  return { type: null };
}

/**
 * Roster mutation lost the optimistic-concurrency race past the retry bound
 * (FIX 3). Routes map this to HTTP 409 — the caller should re-read and retry.
 */
export class RosterConflictError extends Error {
  constructor(conversationId: string) {
    super(`roster update for ${conversationId} conflicted after retries`);
    this.name = new.target.name;
  }
}

/** Bounded retries for the roster optimistic-concurrency loop (FIX 3). */
const ROSTER_MAX_RETRIES = 3;

/** Previews are denormalized inbox furniture, not transcripts — keep them short. */
const PREVIEW_MAX_CHARS = 120;

/** Default inbox page size (GET /api/conversations passes its own limit). */
const DEFAULT_INBOX_PAGE_LIMIT = 50;

/**
 * listRelayGroups walk bounds: relay groups returned per page × the page budget
 * = the most relay groups one call will return (2000). Since the byRelayStatus
 * GSI partition holds relay groups ONLY (no post-Limit type filter), every
 * evaluated row is a relay group — no dilution by 1:1 volume. Past the budget
 * the result is flagged `truncated` — the caller warns, never silently drops.
 */
const RELAY_LIST_PAGE_LIMIT = 100;
const RELAY_LIST_MAX_PAGES = 20;

/**
 * listGroupTexts walk bounds. The `group_open` partition holds group threads
 * ONLY (no post-Limit type filter), so every evaluated row counts toward the
 * caller's limit. The page budget bounds ONE call; `truncated` says the budget
 * stopped the walk with rows still unread, so the caller surfaces it instead of
 * pretending it saw the whole partition.
 */
const GROUP_LIST_PAGE_LIMIT = 100;
const GROUP_LIST_MAX_PAGES = 20;

/** Default page size for listGroupTexts (callers pass their own). */
const DEFAULT_GROUP_PAGE_LIMIT = 50;

/**
 * Cursor tag for the group partition. The cursor is an opaque base64 blob, so a
 * cursor minted by another reader (or a tampered one) would otherwise be handed
 * to DynamoDB as an ExclusiveStartKey for the WRONG partition and silently
 * return a wrong-but-plausible page. Tagging makes that a loud 400-shaped
 * refusal instead.
 */
const GROUP_CURSOR_TAG = 'gt1';

/**
 * A malformed / foreign listGroupTexts cursor. Routes map this to HTTP 400 -
 * never a 500, and never a silent restart of the walk from the newest row.
 */
export class GroupCursorError extends Error {
  constructor(reason: string) {
    super(`invalid group text cursor: ${reason}`);
    this.name = new.target.name;
  }
}

/** Encode a LastEvaluatedKey as the tagged, opaque group cursor. */
export function encodeGroupCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ t: GROUP_CURSOR_TAG, k: key }), 'utf8').toString('base64url');
}

/** Decode a tagged group cursor; throws GroupCursorError on anything else. */
export function decodeGroupCursor(cursor: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new GroupCursorError('not decodable');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { t?: unknown }).t !== GROUP_CURSOR_TAG
  ) {
    throw new GroupCursorError('wrong tag');
  }
  const key = (parsed as { k?: unknown }).k;
  if (typeof key !== 'object' || key === null) throw new GroupCursorError('no key');
  return key as Record<string, unknown>;
}

export function toPreview(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  // Truncate by CODE POINTS (Array.from), not UTF-16 units — a string slice
  // could split a surrogate pair (emoji) at the boundary into a lone
  // surrogate that breaks downstream JSON/display.
  const points = Array.from(text);
  return points.length > PREVIEW_MAX_CHARS
    ? `${points.slice(0, PREVIEW_MAX_CHARS - 1).join('')}…`
    : text;
}

/** UTC minute bucket (`2026-06-12T15:04`) for the breaker counter. */
export function minuteBucket(at: Date = new Date()): string {
  return at.toISOString().slice(0, 16);
}

/**
 * Claim-item partition key for a phone (the per-phone create lock). Claim
 * partitions (`phone#…`) never collide with real `conv-…` partitions.
 */
function phoneClaimPk(phone: string): string {
  return `phone#${phone}`;
}

/**
 * Claim-item partition key for an email address (the per-address create lock,
 * email channel v1). The email#<addr> claim maps address -> conversationId and
 * is the SINGLE arbiter of which conversation owns an address; it carries ONLY
 * the key + ref_conversationId (no participant_email/status), so it never
 * indexes into the sparse GSIs. Never collides with real `conv-...` partitions.
 */
function emailClaimPk(email: string): string {
  return `email#${email}`;
}

/** Reverse-lookup pointer key for an email reply token (token#<tok>). */
function tokenPk(token: string): string {
  return `token#${token}`;
}

export interface RepoDeps {
  /** Injectable for tests (throwaway prefixes against DynamoDB Local). */
  doc?: DynamoDBDocumentClient;
  /** Env for tableName() resolution — tests pass a throwaway TABLE_PREFIX. */
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

export interface ConversationsRepo {
  /**
   * The one active 1:1 conversation for an external phone — found via the
   * byParticipantPhone GSI (fast path), created (status `open`, ai_mode
   * `auto`) when none exists. The GSI is eventually consistent, so creation
   * is arbitrated by a conditional put on a phone-keyed claim item
   * (`phone#<E164>` → ref_conversationId): the winner creates the real row,
   * losers adopt the claimed id — two concurrent firsts can never create two
   * conversations. A crash between claim and row create self-heals on the
   * next call (the claimed id is recreated).
   */
  createOrGetByParticipantPhone(phone: string, type: ConversationType): Promise<ConversationItem>;
  getById(conversationId: string): Promise<ConversationItem | undefined>;
  /**
   * All conversations for an external phone via the byParticipantPhone GSI
   * (M1.4 contact triage: when a contact's type is resolved, the linked
   * conversation's type is propagated). Filters out the phone-claim items
   * (they don't project participant_phone, so they never appear in the GSI —
   * but the filter is defensive). Returns [] when none.
   */
  findByParticipantPhone(phone: string): Promise<ConversationItem[]>;
  /**
   * Email channel v1 - THE CLAIM ARBITER (plan F13). Conditionally put the
   * email#<addr> claim (attribute_not_exists) mapping the address to
   * `conversationId`. On a claim conflict this RESOLVES: it GETs the existing
   * claim and returns THAT conversationId (never errors, never orphans). The
   * single arbiter both email writers go through.
   */
  claimEmailForConversation(
    email: string,
    conversationId: string,
  ): Promise<{ conversationId: string }>;
  /**
   * Email channel v1 - attach an address to an EXISTING conversation (e.g. a
   * known contact's inbound email joining their 1:1 thread). Claims first: if
   * the claim points ELSEWHERE, returns that other conversation's id (the
   * caller threads there instead) and leaves this conversation untouched; if
   * the claim is won, SET participant_email on this conversation's row.
   */
  attachEmailToConversation(
    conversationId: string,
    email: string,
  ): Promise<{ conversationId: string }>;
  /**
   * Email channel v1 - the one active email 1:1 conversation for an address,
   * created (status `open`, ai_mode `auto`) when none exists. Mirrors
   * createOrGetByParticipantPhone's two-write claim + self-heal SEQUENCE
   * verbatim on the byParticipantEmail GSI + email#<addr> claim: the winner
   * creates the row, a crash between claim and create self-heals under the
   * claimed id. `opts` (ADJ-9) seed a participants roster + display name at
   * CREATE time so channel-agnostic readers can resolve an email-only thread.
   */
  createOrGetByParticipantEmail(
    email: string,
    type: ConversationType,
    opts?: { contactId?: string; displayName?: string },
  ): Promise<ConversationItem>;
  /**
   * All conversations for an email address via the byParticipantEmail GSI -
   * the email analog of findByParticipantPhone (returns an array; the readers
   * iterate a contact's addresses alongside their phones). [] when none.
   */
  findByParticipantEmail(email: string): Promise<ConversationItem[]>;
  /**
   * Email channel v1 - mint (once) + persist the URL-safe email_reply_token for
   * a conversation and write its token#<tok> reverse pointer. Idempotent: a
   * conversation that already carries a token returns it WITHOUT new writes.
   * Throws ConditionalCheckFailedException for an unknown conversation.
   */
  getReplyToken(conversationId: string): Promise<string>;
  /** Resolve an email reply token to its conversation via the token#<tok> pointer. */
  findByReplyToken(token: string): Promise<ConversationItem | undefined>;
  /**
   * Set a conversation's type (M1.4 contact triage: unknown_1to1 →
   * tenant_1to1/landlord_1to1 once a human resolves the contact's identity).
   * Returns the post-update item (ALL_NEW) — the fresh inbox row the
   * conversation.updated SSE event is built from. Throws
   * ConditionalCheckFailedException for unknown conversations.
   */
  setType(conversationId: string, type: ConversationType): Promise<ConversationItem>;
  /**
   * M1.4 triage write: set the resolved type (when it changes) and/or the
   * denormalized participant_display_name (when a name is known) in ONE
   * update, returning the post-update item (ALL_NEW) for the
   * conversation.updated SSE event. Pass `displayName: null` to leave the
   * name untouched (only known names are ever written — auto-capture never
   * guesses a name). Throws ConditionalCheckFailedException for unknown
   * conversations.
   */
  applyTriage(
    conversationId: string,
    fields: { type?: ConversationType; displayName?: string | null },
  ): Promise<ConversationItem>;
  /**
   * Stamp the byLastActivity GSI attrs (status + last_activity_at) + preview.
   * Returns the post-update item (ALL_NEW) — the fresh inbox row the M1.2
   * SSE conversation.updated event is built from.
   *
   * PARTITION GUARD (native group texting): the status write is CONDITIONAL on
   * the row not being a `group_text` thread; on the conditional failure the
   * activity + preview are re-applied WITHOUT the status clause. So a group
   * thread keeps `group_open` through every touch (inbound, outbound send,
   * announcements) while 1:1 rows - typed AND legacy type-less - keep today's
   * exact "activity (re)opens the thread" behavior. A missing row still throws
   * ConditionalCheckFailedException (both commands require the row to exist), so
   * no call site can phantom-upsert.
   */
  touchLastActivity(
    conversationId: string,
    previewText: string | undefined,
    ts: string,
  ): Promise<ConversationItem>;
  /**
   * Atomically claim the participants link IFF none exists yet — the M1.2
   * auto-capture race anchor (the conversation row is unique per phone; the
   * contacts byPhone GSI is NOT trustworthy mid-race). True when THIS call
   * set the link; false when a link already existed (read it via getById).
   * Throws when the conversation does not exist.
   */
  setParticipantsIfAbsent(
    conversationId: string,
    participants: ConversationParticipant[],
  ): Promise<boolean>;
  /** Atomic unread bump on a FRESH inbound persist; returns the new count. */
  incrementUnread(conversationId: string): Promise<number>;
  /**
   * Zero the unread counter (POST /:id/read); returns the updated item.
   * Throws ConditionalCheckFailedException for unknown conversations.
   */
  resetUnread(conversationId: string): Promise<ConversationItem>;
  /**
   * Mark a thread unread (the operator's Mark-unread toggle): SETs the counter
   * to exactly 1 and stamps the byUnread flag, CONDITIONAL on the live row
   * still being eligible (`eligibility.bucket`, see UnreadBucket) AND still
   * read. Returns the updated item.
   *
   * Throws ConditionalCheckFailedException when the row is absent, ineligible,
   * or already unread. DynamoDB does not say WHICH clause failed, so the caller
   * re-reads once and classifies - eligibility BEFORE count, because an
   * ineligible-AND-unread thread is a real state (an inbound re-flagging a
   * closed relay group) and count-first would report success for that residue.
   */
  setUnread(
    conversationId: string,
    eligibility: { bucket: UnreadBucket },
  ): Promise<ConversationItem>;
  /**
   * Raw one-page Query on the sparse byUnread GSI, newest-activity-first. NO
   * filtering happens here - visibility (deleted contacts, thread kinds, the
   * walk budget) belongs to the unreadFeed layer above, so this stays a
   * mechanical index read. `exclusiveStartKey` is the SYNTHESIZED full key
   * { unread_flag, last_activity_at, conversationId }: the trailing table key
   * is what disambiguates rows sharing one last_activity_at, so a caller can
   * resume from any item it has seen, not just from a LastEvaluatedKey.
   */
  queryUnreadPage(opts: {
    limit: number;
    exclusiveStartKey?: Record<string, unknown>;
  }): Promise<{ items: ConversationItem[]; lastEvaluatedKey?: Record<string, unknown> }>;
  /**
   * THE inbox read (M1.2): ONE DynamoDB Query on the byLastActivity GSI
   * (status partition, last_activity_at descending) — never a Scan.
   * Pagination via the raw LastEvaluatedKey; routes base64 it into an
   * opaque cursor.
   */
  listByLastActivity(opts: {
    status: string;
    limit?: number;
    exclusiveStartKey?: Record<string, unknown>;
  }): Promise<{ items: ConversationItem[]; lastEvaluatedKey?: Record<string, unknown> }>;
  setMode(conversationId: string, mode: ConversationMode): Promise<void>;
  /** Set/clear the conversation-level STOP suppression flag (doc §7.1). */
  setSmsOptOut(conversationId: string, value: boolean): Promise<void>;
  /**
   * Circuit-breaker support (doc §7.1): atomically count an automated send
   * against the conversation's CURRENT minute bucket and return the new
   * count. Bucket rollover resets the counter via a conditional-update
   * retry pair (ADD within the bucket; SET on bucket change).
   */
  incrementAutomatedSendCount(conversationId: string, bucket: string): Promise<number>;

  // --- Relay groups (M1.7) -------------------------------------------------

  /**
   * Create a relay_group conversation fronted by `poolNumber` with the given
   * member roster. status `open`, ai_mode `manual` (relay threads are never
   * AI-driven). The pool number doubles as participant_phone (synthetic — see
   * the field comment) so the inbox row renders, and is written to
   * pool_number for the byPoolNumber GSI. `tag` is an optional placement
   * label stored for operators. Returns the created item.
   *
   * Connect-when-ready (T6): `poolNumber` is OPTIONAL. When ABSENT the group is
   * created in the `connecting` state - NO pool_number / participant_phone,
   * status `connecting`, relay_status `relay_group#connecting`. It carries no
   * usable number until assignPoolNumberAndOpen stamps one on registration. The
   * poolNumber-provided path is unchanged (status `open`, exactly as today).
   *
   * Task 5: `owner` is the generalized ownership field; `placementId` is kept
   * for back-compat and is still written when `owner` is absent — both paths
   * call `getOwner()` to read it.
   */
  createRelayGroup(input: {
    /** Absent => create a CONNECTING group (connect-when-ready); present => OPEN. */
    poolNumber?: string;
    members: ConversationParticipant[];
    tag?: string;
    /** Legacy back-reference (M1.10). Prefer `owner` for new callers. */
    placementId?: string;
    /** Generalized owner (Task 5). Takes precedence over `placementId`. */
    owner?: RelayOwner;
    /**
     * Operator-edited intro copy, captured in the confirm dialog at create time
     * (2026-08-20). Absent => relayFanOut composes the intro from the catalog as
     * before. It is stored on the CONVERSATION rather than ridden in on the job
     * payload deliberately: a `connecting` group has no number yet and sends its
     * intro only once relay.numberReady fires, and quiet hours can defer an
     * intro further still, so the edited text has to outlive the request that
     * typed it.
     */
    introBody?: string;
  }): Promise<ConversationItem>;
  /**
   * Re-parent a relay_group conversation to a new owner (Task 5).
   * Preserves the pool number and member roster — ONLY the owner metadata is
   * updated. `newOwner` may be `{type:'tour'|'placement', id}` or `{type:null}`
   * (unowned). Returns the post-update item (ALL_NEW). Throws
   * ConditionalCheckFailedException for unknown conversations.
   *
   * PII (doc §9): logs conversationId + owner type only — never an id in a log.
   */
  rebindOwner(conversationId: string, newOwner: RelayOwner): Promise<ConversationItem>;
  /**
   * LEGACY single-collapse: resolve a pool number to ONE relay_group via the
   * byPoolNumber GSI, preferring the OPEN match (else the first the GSI yields).
   * Under burn-multiplexing a number fronts MANY groups (open + closed), so this
   * lossy view is retained ONLY for the voice masked-inbound seam
   * (webhooks/voice.ts), which assumes one group per number and is unchanged by
   * this design. New callers (SMS routing, retirement) use getAllByPoolNumber.
   */
  getByPoolNumber(poolNumber: string): Promise<ConversationItem | undefined>;
  /**
   * ALL relay_group conversations ever fronted by this pool number (open +
   * closed) via the byPoolNumber GSI - the multi-match routing/retirement read.
   * pool_number is never cleared now, so a number accumulates every group it has
   * hosted. Paged; returns the full array (never silently truncated).
   */
  getAllByPoolNumber(poolNumber: string): Promise<ConversationItem[]>;
  /**
   * List the relay_group conversations in ONE status partition ('open' |
   * 'closed'), newest-activity-first — the inbox relay rows + the contact
   * "Relay groups" read (GET /api/contacts/:id/relay-groups). There is NO
   * member→conversation index (a relay's participant_phone is the POOL number;
   * rosters live in the un-indexed participants list), so this queries the
   * SPARSE byRelayStatus GSI (relay_status = `relay_group#<status>`, written on
   * relay groups ONLY) — a DIRECT Query on a relays-only partition, never a
   * Scan and never diluted by open 1:1 volume (the old byLastActivity walk +
   * post-Limit type filter dropped relay groups behind >budget open 1:1s —
   * relay-inbox-open-groups-truncation). The walk is bounded by a fixed page
   * budget: `truncated` is true when the budget stopped it early — the caller
   * MUST surface that (no silent truncation).
   *
   * `connecting` (D9) queries the connect-when-ready partition - the inbox reads
   * it ALONGSIDE 'open' so a group awaiting its number is still visible/openable.
   */
  listRelayGroups(
    status: 'open' | 'closed' | 'connecting',
  ): Promise<{ items: ConversationItem[]; truncated: boolean }>;
  /**
   * The relay groups that currently carry at least one opted-out member (the
   * `relay_opted_out_members` map is non-empty) - the Today "opted out of a
   * relay group" attention set - newest-activity-first. ONE Query on the sparse
   * byRelayOptOut GSI, so it costs O(attention items) and nothing else: it used
   * to be found by walking the whole open 1:1+relay partition, hard-capped at
   * 100 rows, which in prod (649 open threads) truncated on every Today load.
   * `limit` bounds ONE page; the caller treats a full page as its tripwire.
   */
  listRelayOptOutAttention(opts: { limit: number }): Promise<{ items: ConversationItem[] }>;
  /**
   * Idempotent member add (relay groups): appends the member unless an entry
   * with the same phone already exists. OPTIMISTIC CONCURRENCY: the write is
   * conditioned on the roster's `participants_version` being unchanged since
   * the read, and bumps it — concurrent add/remove never silently clobber each
   * other (a lost-version write retries on the fresh roster; exhausting the
   * bounded retries surfaces RosterConflictError). Adding an existing member is
   * a success no-op (no version bump). Returns the post-update item (ALL_NEW).
   * Throws ConditionalCheckFailedException for unknown conversations.
   */
  addMember(conversationId: string, member: ConversationParticipant): Promise<ConversationItem>;
  /**
   * Idempotent member remove (relay groups): drops the entry whose phone
   * matches. A no-op when no such member exists (no version bump). Same
   * optimistic-concurrency version guard + bounded retry as addMember. Returns
   * the post-update item. Throws ConditionalCheckFailedException for unknown
   * conversations.
   */
  removeMember(conversationId: string, phone: string): Promise<ConversationItem>;
  /**
   * Flip a relay_group's `status` (open/closed) with its `relay_status` GSI
   * mirror in lockstep. pool_number is NEVER touched - a closed group keeps its
   * number so late texts still intercept (burn-multiplexing) and reopen reuses
   * the same number (nothing is re-provisioned).
   *
   * `expectedCurrent` makes the flip CONDITIONAL on the current status - close
   * from `open`, reopen from `closed` - so concurrent close/reopen are
   * idempotent: a flip whose precondition no longer holds throws
   * ConditionalCheckFailedException and the caller no-ops (the close/reopen
   * race). Also throws ConditionalCheckFailedException for unknown
   * conversations. Returns the post-update item (ALL_NEW).
   */
  setRelayStatus(
    conversationId: string,
    status: 'open' | 'closed',
    expectedCurrent: 'open' | 'closed',
  ): Promise<ConversationItem>;
  /**
   * Connect-when-ready assign (T6): the warming number earmarked to this
   * `connecting` group has A2P-registered - stamp `pool_number` +
   * `participant_phone` and flip `status` + `relay_status` from connecting ->
   * open, ALL CONDITIONAL on the group currently BEING connecting on BOTH fields
   * (G3 exactly-once: a redelivered relay.numberReady finds it already open and
   * this is a no-op). Returns the post-update item (ALL_NEW) on the winning flip,
   * or `undefined` when the condition did not hold (already assigned / not
   * connecting / missing) - the caller then skips the (already-enqueued) intro so
   * no member is intro'd twice. Distinct from setRelayStatus (open<->closed): a
   * connecting group has no pool number to preserve, and this SETS one.
   */
  assignPoolNumberAndOpen(
    conversationId: string,
    poolNumber: string,
  ): Promise<ConversationItem | undefined>;
  /**
   * Set (ISO string) or CLEAR (null -> REMOVE) a relay group's recurring
   * 28-day close-ask nag timestamp (D5). Conditional on the conversation
   * existing. Cleared on close; set to now + CLOSE_NAG_INTERVAL_MS on defer.
   */
  setCloseNagNextAt(conversationId: string, at: string | null): Promise<void>;
  /**
   * W3 close-announce dedup claim. Atomically SET close_announced_at conditional
   * on the group being OPEN and the marker absent; returns true for the ONE
   * winner (which then sends the relay.group_closed announcement) and false for
   * losers/retries (already closed, already announced, or missing) - which skip
   * the announcement and proceed to the idempotent status flip. Closes both the
   * concurrent-close double-announce TOCTOU and the crash-between-announce-and-
   * flip retry. Reopen clears the marker (setRelayStatus -> open) so a later
   * close announces again.
   */
  claimCloseAnnounce(conversationId: string): Promise<boolean>;
  /**
   * Record ONE relay member as opted-out on the conversation's
   * `relay_opted_out_members` map (A2P — the fan-out detected `sms_opt_out` and
   * skipped them). MERGES a single map slot (a targeted `SET
   * relay_opted_out_members.#mk` — the map is auto-seeded if absent), so it never
   * clobbers OTHER members' entries. Best-effort caller: a failure must never
   * break the fan-out. `memberKey` is the relayMemberKey (may contain `#`), bound
   * via an aliased name.
   */
  setRelayMemberOptedOut(
    conversationId: string,
    memberKey: string,
    entry: { contactId?: string; phone?: string; name?: string; at: string },
  ): Promise<void>;
  /**
   * Clear ONE relay member's `relay_opted_out_members` entry (they opted back in
   * or were removed from the group). A targeted `REMOVE` of the single map slot —
   * leaves the others intact. Idempotent (removing an absent slot is a no-op).
   */
  clearRelayMemberOptedOut(conversationId: string, memberKey: string): Promise<void>;

  // --- Native group texts (carrier groups on the business number) ----------

  /**
   * Create the `group_text` thread for an ALREADY-DERIVED deterministic id
   * (services/groupIdentity.ts -> conversationIdForGroup over the sorted outside
   * roster). status `group_open`, ai_mode `manual` (a carrier group is never
   * AI-driven in v1), roster written ONCE at creation. NO participant_phone /
   * participant_email (group threads are never reached through those GSIs), NO
   * pool_number, NO relay_status - ever.
   *
   * Conditional create with the house "loser adopts" semantics: two members'
   * near-simultaneous first inbounds derive the SAME id and race on the same
   * key, so exactly one call reports `created: true` and the other returns the
   * stored row UNCHANGED (its roster is authoritative - roster changes are a new
   * identity by construction, never a mutation of this one).
   */
  createGroupTextThread(input: {
    /** Deterministic id from groupIdentity() - never a random uuid. */
    conversationId: string;
    members: ConversationParticipant[];
    /** ISO; defaults to now. */
    lastActivityAt?: string;
    /** Optional first preview (truncated like every other preview write). */
    preview?: string;
  }): Promise<{ item: ConversationItem; created: boolean }>;
  /**
   * List `group_text` threads newest-activity-first: ONE Query on the EXISTING
   * byLastActivity GSI, `group_open` partition - never a Scan, and never diluted
   * by 1:1 volume (they are in a different partition entirely).
   *
   * LOUD (spec 4.2): a failed Query logs at ERROR and THROWS. It must NEVER
   * degrade to an empty page - "no group threads" and "the query broke" would be
   * indistinguishable and the inbox would silently hide every group.
   *
   * `cursor` is a TAGGED opaque cursor (see GroupCursorError): a foreign or
   * tampered cursor is refused, never used as an ExclusiveStartKey for someone
   * else's partition. `truncated` is true when the page budget stopped the walk
   * early - the caller MUST surface that (no silent truncation).
   */
  listGroupTexts(opts?: {
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<{ items: ConversationItem[]; nextCursor?: string; truncated: boolean }>;
  /**
   * FENCED rail claim (spec 6.1 / 15.3): take the `rail_creating` claim BEFORE
   * any Twilio call, carrying an OWNER TOKEN and its timestamp.
   *
   * The write is conditional on the row existing AND the claim being FREE -
   * absent, or older than `expiredBefore`. An expired claim is deliberately
   * RE-CLAIMABLE: a claimant that crashed between claim and finalize must never
   * strand a thread rail-less against the hardened cutover gate. Safety does not
   * rest on the expiry (a clock is not a lock) but on setTwilioConversation,
   * which is fenced on the token - so a resurrected claimant loses the finalize
   * rather than clobbering the new claimant's rail.
   *
   * The LOSER gets `{claimed: false, item}` - the freshly re-read row, so it can
   * see whether the winner already stamped a sid. `item` is absent only when the
   * row is gone.
   */
  claimRailCreation(
    conversationId: string,
    claim: { token: string; at: string },
    expiredBefore: string,
  ): Promise<{ claimed: boolean; item?: ConversationItem }>;
  /**
   * Record a rail-creation failure and RELEASE the claim, both conditional on
   * the caller still owning it. Releasing matters: without it a failed attempt
   * would block every retry until the expiry window elapsed, and the migration
   * runner is expected to be re-run immediately. Never throws on a lost fence.
   */
  recordRailFailure(
    conversationId: string,
    reason: string,
    at: string,
    claimToken: string,
  ): Promise<void>;
  /**
   * DROP a rail that Twilio has told us is CLOSED or GONE, so the ensure path
   * can build a new one (fix wave 2, adversarial 2). `ensureGroupRail` returns
   * the STORED rail whenever the sid is stamped and the map covers the roster -
   * it never re-reads Twilio - so a rail that closes after creation was
   * previously unhealable: every send failed on the same dead sid, forever,
   * and `hasActiveGroupRail` kept the re-enqueue path from helping either.
   *
   * CONDITIONAL ON THE SID WE SAW. A concurrent healer may already have stamped
   * a fresh rail; clearing unconditionally would delete THAT one. Returns true
   * when this call is the one that cleared it. Never throws on a lost
   * condition - losing means someone else already fixed it.
   */
  clearGroupRail(conversationId: string, expectedSid: string): Promise<boolean>;
  /**
   * FENCED rail finalize: stamp `twilio_conversation_sid` + the MBxx -> member
   * key map and CLEAR the `rail_creating` claim, CONDITIONAL on the caller still
   * owning that claim (`rail_creating.token === claimToken`). Returns the
   * post-update item (ALL_NEW) on the winning write, or `undefined` when the
   * condition did not hold (claim taken over, claim already cleared, or the row
   * is gone) - a late/expired claimant can then discard its orphaned rail
   * instead of overwriting the live one.
   */
  setTwilioConversation(
    conversationId: string,
    twilioConversationSid: string,
    participantMap: Record<string, string>,
    claimToken: string,
    /**
     * The business number the rail was verified to carry as its projected
     * participant (`twilio_projected_address`). Lands in the SAME fenced write
     * as the sid, so a rail is never "verified" for an author it was not
     * checked against.
     */
    projectedAddress: string,
  ): Promise<ConversationItem | undefined>;
  /**
   * MIGRATION (group-texting spec section 9): flip an imported
   * `relay_group`/`connecting` thread onto the native `group_text` shape, in ONE
   * CONDITIONAL write - type, status, the contactId-backfilled roster and the
   * removal of every relay-only field land together or not at all.
   *
   * The condition is the three preconditions verbatim (`relay_group`,
   * `connecting`, no `pool_number`) plus row existence, so this can never
   * convert an open relay group, a group that already has a pool number, or a
   * thread another caller converted first. Returns the post-update item on the
   * winning write and `undefined` on a lost condition - the caller RE-READS to
   * decide whether it lost to a concurrent convert (already converted) or the
   * row never qualified (refused). Never a throw: losing is an expected outcome
   * when the bulk runner and inbound auto-convert race on the same thread.
   *
   * The conversationId is NEVER changed: history stays attached, and the id is
   * already the derived group id both the importer and detection produce.
   */
  convertRelayGroupToGroupText(
    conversationId: string,
    members: ConversationParticipant[],
  ): Promise<ConversationItem | undefined>;
  /**
   * Convergence helper for a thread that is ALREADY `group_text`: rewrite the
   * roster (the contactId backfill) without touching type or status. Conditional
   * on the row still being a group thread, so it can never resurrect a roster
   * onto something else. `undefined` when that condition did not hold.
   *
   * `expectedPrior` is the roster the caller READ before deriving `members`.
   * Pass it whenever one exists: this is a whole-array overwrite and two
   * converge paths can run against one thread concurrently, so without it the
   * later write wins wholesale (fix wave 5, adversarial 27). A caller that gets
   * `undefined` back should re-read rather than retry blindly.
   */
  backfillGroupTextRoster(
    conversationId: string,
    members: ConversationParticipant[],
    expectedPrior?: ConversationParticipant[],
  ): Promise<ConversationItem | undefined>;
}

export function createConversationsRepo(deps: RepoDeps = {}): ConversationsRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('conversations', deps.env);
  const log = deps.logger ?? defaultLogger;

  async function getById(conversationId: string): Promise<ConversationItem | undefined> {
    const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { conversationId } }));
    return Item as ConversationItem | undefined;
  }

  /**
   * Create the real conversation row under an agreed (claimed) id. Losing
   * the conditional put just means another caller created it first — read
   * it back and return it (both callers end up with the same row).
   */
  async function createConversationRow(item: ConversationItem): Promise<ConversationItem> {
    try {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(conversationId)',
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      const existing = await getById(item.conversationId);
      if (!existing) {
        throw new Error(
          `createOrGetByParticipantPhone: conversation ${item.conversationId} exists per the conditional put but is unreadable`,
        );
      }
      return existing;
    }
    log.info({ conversationId: item.conversationId, type: item.type }, 'conversation created');
    return item;
  }

  /**
   * Email channel v1 - the email#<addr> claim arbiter (plan F13). Conditionally
   * put the claim; on conflict GET it and return the existing owner. Shared by
   * the interface method + attachEmailToConversation (a factory closure, so no
   * `this`-binding - same pattern as getById/createConversationRow).
   */
  async function claimEmail(
    email: string,
    conversationId: string,
  ): Promise<{ conversationId: string }> {
    try {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: { conversationId: emailClaimPk(email), ref_conversationId: conversationId },
          ConditionExpression: 'attribute_not_exists(conversationId)',
        }),
      );
      return { conversationId };
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      // Claim taken (now or in the past): resolve to the existing owner.
      const claim = await doc.send(
        new GetCommand({ TableName: table, Key: { conversationId: emailClaimPk(email) } }),
      );
      const ref = (claim.Item as { ref_conversationId?: unknown } | undefined)?.ref_conversationId;
      if (typeof ref !== 'string' || ref.length === 0) {
        throw new Error(
          'claimEmailForConversation: email claim exists but carries no ref_conversationId',
        );
      }
      return { conversationId: ref };
    }
  }

  /**
   * FIX 3 — roster read-modify-write under optimistic concurrency. `mutate`
   * returns the NEW roster, or undefined for an idempotent no-op (member
   * already present / already absent). On a real change the write is
   * conditioned on `participants_version` matching the value read (or absent on
   * the very first mutation) and increments it; a concurrent mutation fails
   * that condition, so we re-read and retry up to ROSTER_MAX_RETRIES before
   * surfacing RosterConflictError. A missing conversation throws
   * ConditionalCheckFailedException (the routes map it to 404).
   */
  async function rosterMutate(
    conversationId: string,
    op: string,
    mutate: (roster: ConversationParticipant[]) => ConversationParticipant[] | undefined,
    everMemberAdd?: string,
  ): Promise<ConversationItem> {
    for (let attempt = 0; attempt < ROSTER_MAX_RETRIES; attempt++) {
      const existing = await getById(conversationId);
      if (!existing) {
        throw new ConditionalCheckFailedException({
          message: `${op}: conversation ${conversationId} not found`,
          $metadata: {},
        });
      }
      const roster = existing.participants ?? [];
      const next = mutate(roster);
      if (next === undefined) {
        log.info({ conversationId, op }, 'relay roster mutation is a no-op (idempotent)');
        return existing; // nothing changed — no version bump, no write
      }
      const currentVersion =
        typeof existing.participants_version === 'number' ? existing.participants_version : 0;
      // Burn provenance (W1): on the ADD path, record the added phone in
      // ever_member_phones in the SAME conditional write as the roster (roster +
      // provenance move together atomically). A LEGACY group (attr absent) is
      // SEEDED from the post-add roster - its current members' burns
      // definitionally belong to this group's provisioning - so a later
      // remove-then-re-add of any of them needs no fresh claim; an existing set
      // is extended with an ADD clause. removeMember passes no everMemberAdd (a
      // burn is forever - history never shrinks).
      const values: Record<string, unknown> = {
        ':p': next,
        ':curV': currentVersion,
        ':nextV': currentVersion + 1,
      };
      let setExtra = '';
      let addClause = '';
      if (everMemberAdd !== undefined) {
        if (existing.ever_member_phones === undefined) {
          values[':everSeed'] = new Set(next.map((m) => m.phone));
          setExtra = ', ever_member_phones = :everSeed';
        } else {
          values[':everAdd'] = new Set([everMemberAdd]);
          addClause = ' ADD ever_member_phones :everAdd';
        }
      }
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            UpdateExpression: `SET participants = :p, participants_version = :nextV${setExtra}${addClause}`,
            // Existence guard + the optimistic-concurrency check: the roster's
            // version must be exactly what we read (or absent on first mutation).
            ConditionExpression:
              'attribute_exists(conversationId) AND (attribute_not_exists(participants_version) OR participants_version = :curV)',
            ExpressionAttributeValues: values,
            ReturnValues: 'ALL_NEW',
          }),
        );
        log.info({ conversationId, op, memberCount: next.length }, 'relay roster mutated');
        return Attributes as ConversationItem;
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // Lost the version race: a concurrent add/remove committed first.
        // Re-read and retry on the fresh roster (the loop re-reads at the top).
        log.info({ conversationId, op, attempt }, 'relay roster mutation lost a version race — retrying');
      }
    }
    throw new RosterConflictError(conversationId);
  }

  return {
    getById,

    async createOrGetByParticipantPhone(phone, type) {
      // Fast path: the byParticipantPhone GSI. Eventually consistent — a
      // miss here is NOT proof the conversation doesn't exist.
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byParticipantPhone',
          KeyConditionExpression: 'participant_phone = :p',
          ExpressionAttributeValues: { ':p': phone },
        }),
      );
      const active = (Items as ConversationItem[] | undefined)?.find((c) => c.status === 'open');
      if (active) return active;

      const now = new Date().toISOString();
      const item: ConversationItem = {
        conversationId: `conv-${randomUUID()}`,
        participant_phone: phone,
        status: 'open',
        last_activity_at: now,
        type,
        ai_mode: 'auto',
        created_at: now,
      };
      // Correctness backstop (the SID-pointer pattern from messagesRepo):
      // conditionally claim the phone before creating. The claim item
      // carries ONLY the key + ref_conversationId — no participant_phone,
      // status, or last_activity_at on purpose, so the sparse GSIs
      // (byParticipantPhone, byLastActivity) never index it.
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: { conversationId: phoneClaimPk(phone), ref_conversationId: item.conversationId },
            ConditionExpression: 'attribute_not_exists(conversationId)',
          }),
        );
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // Claim taken: another caller won (now or in the past). Adopt the
        // claimed id; if the winner crashed before creating the row, the
        // conditional create below self-heals it under the SAME id.
        const claim = await doc.send(
          new GetCommand({ TableName: table, Key: { conversationId: phoneClaimPk(phone) } }),
        );
        const ref = (claim.Item as { ref_conversationId?: unknown } | undefined)
          ?.ref_conversationId;
        if (typeof ref !== 'string' || ref.length === 0) {
          throw new Error(
            'createOrGetByParticipantPhone: phone claim exists but carries no ref_conversationId',
          );
        }
        const existing = await getById(ref);
        if (existing) return existing;
        return createConversationRow({ ...item, conversationId: ref });
      }
      return createConversationRow(item);
    },

    async findByParticipantPhone(phone) {
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byParticipantPhone',
          KeyConditionExpression: 'participant_phone = :p',
          ExpressionAttributeValues: { ':p': phone },
        }),
      );
      return (Items as ConversationItem[] | undefined) ?? [];
    },

    // --- Email channel v1 (the claim arbiter + reply tokens) -----------------

    claimEmailForConversation: claimEmail,

    async attachEmailToConversation(conversationId, email) {
      // Claim first: if the address already belongs to a DIFFERENT conversation,
      // return THAT one (the caller threads there) and leave this row untouched -
      // never two conversations for one address.
      const { conversationId: owner } = await claimEmail(email, conversationId);
      if (owner !== conversationId) return { conversationId: owner };
      // We own the claim - stamp participant_email onto this conversation's row
      // (the byParticipantEmail GSI HASH). Guard on existence so an unknown id
      // never creates a row.
      //
      // NOTE (m7): participant_email is SINGLE-VALUED, so this SET overwrites any
      // prior address when a thread spans several of a contact's addresses. It is a
      // best-effort LAST-WRITER hint for the byParticipantEmail GSI, NOT the source
      // of truth: the per-address email#<addr> claim rows (claimEmail) are the
      // authoritative owner map, and contact-side readers (conversationsForContact)
      // iterate ALL of a contact's addresses. A future reader that queries the GSI by
      // a specific (non-current) address may miss the thread - resolve via the claim.
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: 'SET participant_email = :e',
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeValues: { ':e': email },
        }),
      );
      log.info({ conversationId }, 'email attached to conversation');
      return { conversationId };
    },

    async createOrGetByParticipantEmail(email, type, opts) {
      // Fast path: the byParticipantEmail GSI. Eventually consistent - a miss
      // here is NOT proof the conversation doesn't exist (the claim below is the
      // correctness backstop, exactly like createOrGetByParticipantPhone).
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byParticipantEmail',
          KeyConditionExpression: 'participant_email = :e',
          ExpressionAttributeValues: { ':e': email },
        }),
      );
      const active = (Items as ConversationItem[] | undefined)?.find((c) => c.status === 'open');
      if (active) return active;

      const now = new Date().toISOString();
      const item: ConversationItem = {
        conversationId: `conv-${randomUUID()}`,
        // Email-only thread: participant_email is the routing key; NO
        // participant_phone (channel-agnostic readers fall back to the display
        // name). ADJ-9: seed a participants roster + display name so
        // whoOfConversation / involvesContact can resolve an email-only thread.
        participant_email: email,
        status: 'open',
        last_activity_at: now,
        type,
        ai_mode: 'auto',
        created_at: now,
        ...(opts?.contactId !== undefined && {
          // Mirror the phone path's participant shape ({contactId, phone}); an
          // email participant has no phone, so `phone` is empty (readers key on
          // contactId first - jobs/extraction.ts, today.ts whoContactId).
          participants: [{ contactId: opts.contactId, phone: '' }],
        }),
        ...(opts?.displayName !== undefined && { participant_display_name: opts.displayName }),
      };
      // Correctness backstop: conditionally claim the address before creating.
      // The claim item carries ONLY the key + ref (no participant_email/status),
      // so the sparse GSIs never index it.
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: { conversationId: emailClaimPk(email), ref_conversationId: item.conversationId },
            ConditionExpression: 'attribute_not_exists(conversationId)',
          }),
        );
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // Claim taken: adopt the claimed id; if the winner crashed before
        // creating the row, the conditional create below self-heals it.
        const claim = await doc.send(
          new GetCommand({ TableName: table, Key: { conversationId: emailClaimPk(email) } }),
        );
        const ref = (claim.Item as { ref_conversationId?: unknown } | undefined)?.ref_conversationId;
        if (typeof ref !== 'string' || ref.length === 0) {
          throw new Error(
            'createOrGetByParticipantEmail: email claim exists but carries no ref_conversationId',
          );
        }
        const existing = await getById(ref);
        if (existing) return existing;
        return createConversationRow({ ...item, conversationId: ref });
      }
      return createConversationRow(item);
    },

    async findByParticipantEmail(email) {
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byParticipantEmail',
          KeyConditionExpression: 'participant_email = :e',
          ExpressionAttributeValues: { ':e': email },
        }),
      );
      return (Items as ConversationItem[] | undefined) ?? [];
    },

    async getReplyToken(conversationId) {
      const existing = await getById(conversationId);
      if (!existing) {
        throw new ConditionalCheckFailedException({
          message: `getReplyToken: conversation ${conversationId} not found`,
          $metadata: {},
        });
      }
      // Idempotent: a thread that already minted a token returns it, no writes.
      if (
        typeof existing.email_reply_token === 'string' &&
        existing.email_reply_token.length > 0
      ) {
        return existing.email_reply_token;
      }
      // 16 random bytes -> 22 url-safe chars. Write the reverse pointer FIRST so a
      // crash after it still leaves the token resolvable, then claim the canonical
      // slot on the row (attribute_not_exists) - a concurrent minter loses that
      // claim and returns the winner's token (its own pointer is a harmless extra
      // that still resolves to this conversation).
      const token = randomBytes(16).toString('base64url');
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: { conversationId: tokenPk(token), ref_conversationId: conversationId },
            ConditionExpression: 'attribute_not_exists(conversationId)',
          }),
        );
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // Astronomically unlikely token collision - nothing to do, the pointer
        // already exists (and points somewhere); fall through to the row claim.
      }
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            UpdateExpression: 'SET email_reply_token = :t',
            ConditionExpression:
              'attribute_exists(conversationId) AND attribute_not_exists(email_reply_token)',
            ExpressionAttributeValues: { ':t': token },
          }),
        );
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // Lost the race: another minter set the canonical token. Return theirs.
        const fresh = await getById(conversationId);
        const tok = fresh?.email_reply_token;
        if (typeof tok === 'string' && tok.length > 0) return tok;
        throw new Error('getReplyToken: token write lost the race but no token is present');
      }
      log.info({ conversationId }, 'email reply token minted');
      return token;
    },

    async findByReplyToken(token) {
      const pointer = await doc.send(
        new GetCommand({ TableName: table, Key: { conversationId: tokenPk(token) } }),
      );
      const ref = (pointer.Item as { ref_conversationId?: unknown } | undefined)?.ref_conversationId;
      if (typeof ref !== 'string' || ref.length === 0) return undefined;
      return getById(ref);
    },

    async setType(conversationId, type) {
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: 'SET #t = :type',
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeNames: { '#t': 'type' },
          ExpressionAttributeValues: { ':type': type },
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ conversationId, type }, 'conversation type set');
      return Attributes as ConversationItem;
    },

    async applyTriage(conversationId, fields) {
      // SET only the fields supplied: type (when triage resolves identity) and
      // participant_display_name (when a name is known). At least one is
      // present by the caller's contract; if neither were, this would be an
      // empty SET — guarded against by returning the current item.
      const sets: string[] = [];
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      if (fields.type !== undefined) {
        names['#t'] = 'type';
        values[':type'] = fields.type;
        sets.push('#t = :type');
      }
      if (fields.displayName !== undefined && fields.displayName !== null) {
        names['#dn'] = 'participant_display_name';
        values[':dn'] = fields.displayName;
        sets.push('#dn = :dn');
      }
      if (sets.length === 0) {
        const existing = await getById(conversationId);
        if (!existing) {
          throw new ConditionalCheckFailedException({
            message: `applyTriage: conversation ${conversationId} not found`,
            $metadata: {},
          });
        }
        return existing;
      }
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      // PII (doc §9): log the FACT of a name write, never the name itself.
      log.info(
        { conversationId, typeSet: fields.type ?? null, nameSet: ':dn' in values },
        'conversation triage applied',
      );
      return Attributes as ConversationItem;
    },

    async touchLastActivity(conversationId, previewText, ts) {
      const preview = toPreview(previewText);
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            // Activity (re)opens the thread; preview only set when one exists.
            UpdateExpression:
              preview !== undefined
                ? 'SET #s = :open, last_activity_at = :ts, last_message_preview = :preview'
                : 'SET #s = :open, last_activity_at = :ts',
            // PARTITION GUARD: never write `open` onto a group_text thread. A
            // group thread lives in the `group_open` partition and nothing points
            // back into it, so one blind status write would lose it forever.
            // Legacy rows carry no `type` at all - attribute_not_exists keeps
            // them on today's path.
            ConditionExpression:
              'attribute_exists(conversationId) AND (attribute_not_exists(#type) OR #type <> :groupText)',
            ExpressionAttributeNames: { '#s': 'status', '#type': 'type' },
            ExpressionAttributeValues: {
              ':open': 'open',
              ':groupText': 'group_text',
              ':ts': ts,
              ...(preview !== undefined && { ':preview': preview }),
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return Attributes as ConversationItem;
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // Group thread (or a missing row). Re-apply activity + preview with the
        // status clause DROPPED. This MUST be a separate command object: reusing
        // the one above with the clause stripped would leave `#s`/`:open`/
        // `:groupText` bound but unreferenced, and DynamoDB rejects unused
        // expression names/values with a ValidationException - which would turn
        // every group touch into a 500. `attribute_exists(conversationId)` stays,
        // so a MISSING row still fails here and the CCFE surfaces to the caller
        // exactly as it does today (no phantom upsert).
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            UpdateExpression:
              preview !== undefined
                ? 'SET last_activity_at = :ts, last_message_preview = :preview'
                : 'SET last_activity_at = :ts',
            ConditionExpression: 'attribute_exists(conversationId)',
            ExpressionAttributeValues: {
              ':ts': ts,
              ...(preview !== undefined && { ':preview': preview }),
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return Attributes as ConversationItem;
      }
    },

    async setParticipantsIfAbsent(conversationId, participants) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            UpdateExpression: 'SET participants = :p',
            ConditionExpression:
              'attribute_exists(conversationId) AND attribute_not_exists(participants)',
            ExpressionAttributeValues: { ':p': participants },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          // Either a link already exists (the normal race-loser case) or the
          // conversation is missing — disambiguate with a read.
          const existing = await getById(conversationId);
          if (!existing) {
            throw new Error(`setParticipantsIfAbsent: conversation not found: ${conversationId}`);
          }
          return false;
        }
        throw err;
      }
      log.info(
        { conversationId, contactId: participants[0]?.contactId },
        'conversation participants linked',
      );
      return true;
    },

    async incrementUnread(conversationId) {
      // Counter and byUnread flag ride ONE UpdateExpression so the row can
      // never be unread-but-unindexed. Every increment idempotently (re)sets
      // the flag - detecting the 0 -> 1 crossing would be both unnecessary and
      // unsafe under concurrent inbound writes.
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: 'ADD unread_count :one SET unread_flag = :flag',
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeValues: { ':one': 1, ':flag': UNREAD_FLAG_VALUE },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return (Attributes as ConversationItem).unread_count ?? 1;
    },

    async resetUnread(conversationId) {
      // Accepted risk (M1.2): SET-to-zero is last-write-wins vs in-flight
      // inbound increments — a read racing an inbound can drop that bump
      // (a watermark design fixes it if this ever bites).
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          // REMOVE (not "set empty") is what retires the row from byUnread:
          // the flag is the index HASH, so its absence IS the exit. The count
          // stays SET to 0 - existing readers and the SSE payload keep their
          // shape. Both clauses are one write, so the race above cannot leave
          // the flag and the counter disagreeing.
          UpdateExpression: 'SET unread_count = :zero REMOVE unread_flag',
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeValues: { ':zero': 0 },
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ conversationId }, 'conversation unread reset');
      return Attributes as ConversationItem;
    },

    async setUnread(conversationId, { bucket }) {
      // EVERY bucket carries a TYPE clause, not only one_to_one. Without it the
      // relay_group predicate is satisfied by any open 1:1 thread, and the only
      // separator would be the route's own type read - the exact value this
      // condition exists to distrust. It is safe today only because the sole
      // type-changing writer (convertRelayGroupToGroupText) also moves status
      // out of the admitted set; do not depend on that coincidence.
      const buckets: Record<UnreadBucket, { predicate: string; values: Record<string, unknown> }> = {
        relay_group: {
          predicate: '#type = :type AND #s IN (:open, :connecting)',
          values: { ':type': 'relay_group', ':open': 'open', ':connecting': 'connecting' },
        },
        group_text: {
          predicate: '#type = :type AND #s = :groupOpen',
          values: { ':type': 'group_text', ':groupOpen': GROUP_TEXT_STATUS },
        },
        one_to_one: {
          // The NEGATIVE type test, mirroring isOneToOneBucket: a legacy row
          // with no `type` - and any future 1:1 type - stays flaggable instead
          // of silently dropping out of the bucket.
          predicate: '(attribute_not_exists(#type) OR NOT #type IN (:relay, :groupText)) AND #s = :open',
          values: { ':relay': 'relay_group', ':groupText': 'group_text', ':open': 'open' },
        },
      };
      const { predicate, values } = buckets[bucket];
      // Accepted risk, the same class documented for resetUnread above: SET is
      // last-write-wins against an in-flight inbound ADD, so a setUnread racing
      // a fresh inbound writes 1 where the truth is 2. The flag is correct
      // either way and the row stays visible.
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          // SET, not ADD: the count is deterministically 1, and the counter and
          // the index hash ride ONE write so the row can never be
          // unread-but-unindexed.
          UpdateExpression: 'SET unread_count = :one, unread_flag = :flag',
          // Clause 3's attribute_not_exists half is LOAD-BEARING: unread_count
          // is genuinely sparse, so a thread that has never received an inbound
          // has never had it written, and a bare `= :zero` would refuse that
          // whole class forever.
          //
          // Pointer-partition rows (MU-1's first clause) are deliberately NOT
          // in the condition: conversationId is the table key and cannot
          // change, so the route's pre-check for them cannot be raced.
          ConditionExpression:
            `attribute_exists(conversationId) AND (${predicate}) ` +
            'AND (attribute_not_exists(unread_count) OR unread_count = :zero)',
          ExpressionAttributeNames: { '#s': 'status', '#type': 'type' },
          // Bucket values are spread in per bucket: DynamoDB rejects an
          // expression carrying a value placeholder it never references.
          ExpressionAttributeValues: {
            ':one': 1,
            ':flag': UNREAD_FLAG_VALUE,
            ':zero': 0,
            ...values,
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ conversationId }, 'conversation unread set');
      return Attributes as ConversationItem;
    },

    async queryUnreadPage({ limit, exclusiveStartKey }) {
      // ONE Query on the sparse byUnread partition - the whole point of the
      // index is that unread discovery costs O(actual unread) rather than a
      // walk of every open thread. No FilterExpression: filtering here would
      // burn read units before Limit applies AND split the visibility rules
      // across two layers; unreadFeed owns them.
      const { Items, LastEvaluatedKey } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byUnread',
          KeyConditionExpression: 'unread_flag = :u',
          ExpressionAttributeValues: { ':u': UNREAD_FLAG_VALUE },
          ScanIndexForward: false, // newest activity first
          Limit: limit,
          ...(exclusiveStartKey !== undefined && {
            ExclusiveStartKey: exclusiveStartKey as QueryCommandInput['ExclusiveStartKey'],
          }),
        }),
      );
      return {
        items: (Items ?? []) as ConversationItem[],
        ...(LastEvaluatedKey !== undefined && { lastEvaluatedKey: LastEvaluatedKey }),
      };
    },

    async listByLastActivity({ status, limit, exclusiveStartKey }) {
      // M1.2 mandate: the inbox is ONE Query on byLastActivity (status
      // partition, last_activity_at DESC) — NEVER a Scan, at any size.
      const { Items, LastEvaluatedKey } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byLastActivity',
          KeyConditionExpression: '#s = :status',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':status': status },
          ScanIndexForward: false, // newest activity first
          Limit: limit ?? DEFAULT_INBOX_PAGE_LIMIT,
          ...(exclusiveStartKey !== undefined && {
            ExclusiveStartKey: exclusiveStartKey as QueryCommandInput['ExclusiveStartKey'],
          }),
        }),
      );
      return {
        items: (Items ?? []) as ConversationItem[],
        ...(LastEvaluatedKey !== undefined && { lastEvaluatedKey: LastEvaluatedKey }),
      };
    },

    async setMode(conversationId, mode) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: 'SET ai_mode = :mode',
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeValues: { ':mode': mode },
        }),
      );
      log.info({ conversationId, mode }, 'conversation mode set');
    },

    async setSmsOptOut(conversationId, value) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: 'SET sms_opt_out = :v',
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeValues: { ':v': value },
        }),
      );
      log.info({ conversationId, smsOptOut: value }, 'conversation sms_opt_out set');
    },

    async incrementAutomatedSendCount(conversationId, bucket) {
      // Accepted risk (M1.1): this is a FIXED minute window — a burst
      // straddling a bucket boundary can reach ~2x the cap before tripping.
      // Two conditional shapes, retried: (a) ADD when the item is already on
      // this bucket; (b) SET/reset when the bucket changed (or never existed).
      // A loser of either race re-enters the loop; two passes settle it in
      // practice, the bound is just a stuck-loop guard.
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const { Attributes } = await doc.send(
            new UpdateCommand({
              TableName: table,
              Key: { conversationId },
              UpdateExpression: 'ADD outbound_minute_count :one',
              ConditionExpression: 'outbound_minute_bucket = :bucket',
              ExpressionAttributeValues: { ':one': 1, ':bucket': bucket },
              ReturnValues: 'ALL_NEW',
            }),
          );
          return (Attributes as ConversationItem).outbound_minute_count ?? 1;
        } catch (err) {
          if (!(err instanceof ConditionalCheckFailedException)) throw err;
        }
        try {
          await doc.send(
            new UpdateCommand({
              TableName: table,
              Key: { conversationId },
              UpdateExpression: 'SET outbound_minute_bucket = :bucket, outbound_minute_count = :one',
              ConditionExpression:
                'attribute_exists(conversationId) AND (attribute_not_exists(outbound_minute_bucket) OR outbound_minute_bucket <> :bucket)',
              ExpressionAttributeValues: { ':bucket': bucket, ':one': 1 },
            }),
          );
          return 1;
        } catch (err) {
          if (!(err instanceof ConditionalCheckFailedException)) throw err;
        }
      }
      throw new Error(
        `incrementAutomatedSendCount: conditional updates kept failing for ${conversationId} — does the conversation exist?`,
      );
    },

    // --- Relay groups (M1.7 / Task 5 owner generalization) ----------------

    async createRelayGroup({ poolNumber, members, tag, placementId, owner, introBody }) {
      const now = new Date().toISOString();
      // Resolve canonical owner: explicit `owner` wins; fall back to legacy
      // `placementId`; fall back to standalone (unowned).
      const resolvedOwner: RelayOwner =
        owner !== undefined
          ? owner
          : typeof placementId === 'string' && placementId.length > 0
            ? { type: 'placement', id: placementId }
            : { type: null };

      // Connect-when-ready (T6): no pool number yet => CONNECTING. A connecting
      // group carries NO pool_number / participant_phone (byParticipantPhone +
      // byPoolNumber stay sparse until assignPoolNumberAndOpen stamps the number
      // on registration); it is reachable only via its byRelayStatus partition.
      const connecting = poolNumber === undefined;
      const status = connecting ? 'connecting' : 'open';

      const item: ConversationItem = {
        conversationId: `conv-${randomUUID()}`,
        // Synthetic participant_phone: relay threads route on pool_number, but
        // the inbox row + byParticipantPhone GSI still want a value. The pool
        // number is the natural one (it is "the thread's number"). A connecting
        // group has neither yet - both are stamped at assign time.
        ...(poolNumber !== undefined && {
          participant_phone: poolNumber,
          pool_number: poolNumber,
        }),
        status,
        // byRelayStatus GSI HASH (sparse; relay groups only) — kept in lockstep
        // with `status` so listRelayGroups queries this partition directly.
        relay_status: relayStatusKey(status),
        last_activity_at: now,
        type: 'relay_group',
        // Relay threads are operator-run, never AI-driven; manual keeps the
        // automated-send breaker's manual-mode refusal off the relay path
        // (fan-out sends are not breaker-metered — see relayFanOut).
        ai_mode: 'manual',
        participants: members,
        // Burn provenance (W1): seed from the initial roster - these phones'
        // burns on the pool number belong to THIS group. A JS Set marshals to a
        // DynamoDB string set (empty sets are forbidden, so only when non-empty).
        ...(members.length > 0 && {
          ever_member_phones: new Set(members.map((m) => m.phone)),
        }),
        created_at: now,
        ...(tag !== undefined && { placement_tag: tag }),
        // Legacy back-compat: write placementId when the owner IS a placement
        // (so existing code that reads placementId directly still works).
        ...(resolvedOwner.type === 'placement' && { placementId: resolvedOwner.id }),
        // Canonical owner field (new rows always carry this).
        ...(resolvedOwner.type !== null && { owner: resolvedOwner }),
        // Operator-edited intro copy (2026-08-20). Written only when the
        // operator actually changed the previewed text, so an untouched preview
        // leaves the attribute absent and relayFanOut composes as it always has.
        ...(introBody !== undefined && introBody.length > 0 && { intro_body: introBody }),
      };
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(conversationId)',
        }),
      );
      log.info(
        { conversationId: item.conversationId, memberCount: members.length },
        'relay group created',
      );
      return item;
    },

    async getByPoolNumber(poolNumber) {
      // LEGACY single-collapse for the voice seam (see interface): prefer the
      // OPEN match, else the first the GSI yields. Under burn-multiplexing a
      // number fronts many groups (open + closed); new SMS/retirement callers
      // use getAllByPoolNumber instead.
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byPoolNumber',
          KeyConditionExpression: 'pool_number = :p',
          ExpressionAttributeValues: { ':p': poolNumber },
        }),
      );
      const items = (Items as ConversationItem[] | undefined) ?? [];
      return items.find((c) => c.status === 'open') ?? items[0];
    },

    async getAllByPoolNumber(poolNumber) {
      // Multi-match read: pool_number is never cleared, so byPoolNumber holds
      // ALL of a number's relay groups (open + closed). Page the full partition
      // (small in practice, but never truncate silently).
      const items: ConversationItem[] = [];
      let exclusiveStartKey: QueryCommandInput['ExclusiveStartKey'];
      do {
        const { Items, LastEvaluatedKey } = await doc.send(
          new QueryCommand({
            TableName: table,
            IndexName: 'byPoolNumber',
            KeyConditionExpression: 'pool_number = :p',
            ExpressionAttributeValues: { ':p': poolNumber },
            ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
          }),
        );
        items.push(...((Items ?? []) as ConversationItem[]));
        exclusiveStartKey = LastEvaluatedKey;
      } while (exclusiveStartKey !== undefined);
      return items;
    },

    async listRelayGroups(status) {
      // Query the byRelayStatus SPARSE GSI directly — its partition holds relay
      // groups ONLY (relay_status = `relay_group#<status>` is written on no other
      // item type), so there is no post-Limit type filter to dilute the budget.
      // This is immune to the TOTAL volume of open 1:1 threads: the old path
      // walked the byLastActivity 'open' partition (EVERY open conversation) with
      // a `type = relay_group` FilterExpression, which DynamoDB applies AFTER the
      // Limit — a relay group ordered behind >budget more-recently-active open
      // 1:1s was never returned (relay-inbox-open-groups-truncation). Results
      // come back newest-activity-first (last_activity_at SORT, descending). The
      // page budget still bounds the walk; `truncated` flags a budget stop.
      const items: ConversationItem[] = [];
      let exclusiveStartKey: QueryCommandInput['ExclusiveStartKey'];
      for (let page = 0; page < RELAY_LIST_MAX_PAGES; page++) {
        const { Items, LastEvaluatedKey } = await doc.send(
          new QueryCommand({
            TableName: table,
            IndexName: 'byRelayStatus',
            KeyConditionExpression: '#rs = :rs',
            ExpressionAttributeNames: { '#rs': 'relay_status' },
            ExpressionAttributeValues: { ':rs': relayStatusKey(status) },
            ScanIndexForward: false, // newest activity first
            Limit: RELAY_LIST_PAGE_LIMIT,
            ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
          }),
        );
        items.push(...(((Items ?? []) as ConversationItem[])));
        if (LastEvaluatedKey === undefined) return { items, truncated: false };
        exclusiveStartKey = LastEvaluatedKey;
      }
      return { items, truncated: true };
    },

    async listRelayOptOutAttention({ limit }) {
      // ONE Query on the sparse byRelayOptOut partition (2026-08-18): the rows
      // ARE the attention set, so there is nothing to filter and nothing to walk
      // past. Newest activity first, like every other Today read.
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byRelayOptOut',
          KeyConditionExpression: 'relay_optout_flag = :flag',
          ExpressionAttributeValues: { ':flag': RELAY_OPTOUT_FLAG_VALUE },
          ScanIndexForward: false,
          Limit: limit,
        }),
      );
      return { items: (Items ?? []) as ConversationItem[] };
    },

    async addMember(conversationId, member) {
      // FIX 3 — optimistic concurrency. Read-modify-write the roster, but
      // condition the write on `participants_version` being unchanged since the
      // read and bump it. A concurrent add/remove invalidates the version, so
      // this write loses its conditional and re-reads + retries (bounded) — no
      // silent clobber. Idempotent on phone: re-adding an existing phone is a
      // success no-op that never bumps the version (so it can't spuriously
      // conflict with a concurrent change).
      return rosterMutate(
        conversationId,
        'addMember',
        (roster) => {
          if (roster.some((p) => p.phone === member.phone)) return undefined; // no-op
          return [...roster, member];
        },
        // Record this phone's burn provenance atomically with the roster (W1).
        member.phone,
      );
    },

    async removeMember(conversationId, phone) {
      // FIX 3 — same optimistic-concurrency version guard as addMember.
      // Idempotent: removing an absent phone is a success no-op (no bump).
      return rosterMutate(conversationId, 'removeMember', (roster) => {
        const next = roster.filter((p) => p.phone !== phone);
        return next.length === roster.length ? undefined : next; // undefined = no-op
      });
    },

    async setRelayStatus(conversationId, status, expectedCurrent) {
      // pool_number is NEVER touched - a closed relay KEEPS its number so late
      // texts still intercept to the sender's 1:1 (burn-multiplexing), and
      // reopen reuses the same number. Only `status` + its `relay_status` GSI
      // mirror flip, in lockstep so the byRelayStatus GSI moves the item to the
      // new status partition (open<->closed). The required `expectedCurrent`
      // makes the flip conditional on the current status so concurrent
      // close/reopen are idempotent (the loser's precondition fails and it
      // throws ConditionalCheckFailedException for the route to no-op).
      // W3: a REOPEN (-> open) also REMOVEs close_announced_at, so a FUTURE close
      // re-announces (the marker is atomically cleared with the reopen flip - a
      // separate write could crash-window into a close that never announces). A
      // close (-> closed) leaves the marker set (the claim just wrote it).
      // UNREAD (design 2026-08-16): a CLOSE also zeroes unread_count and drops
      // unread_flag in this same write, so a closed group can never sit unread
      // and invisible in the byUnread index; every future close path inherits
      // it. Reopen deliberately does NOT resurrect the count (declared product
      // change). ':zero' is therefore attached to the CLOSE branch only -
      // DynamoDB rejects an UpdateExpression carrying a value placeholder it
      // never references, so a shared literal would make every reopen throw
      // ValidationException.
      // RELAY OPT-OUT ATTENTION (2026-08-18): a CLOSE also drops
      // relay_optout_flag - a closed group's opted-out members are no longer
      // anyone's to-do (the old open-partition walk never showed them either),
      // so the row leaves byRelayOptOut in this same write. The map itself is
      // kept (history); a reopen re-flags only through the next set/clear.
      const isClose = status === 'closed';
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: isClose
            ? 'SET #s = :status, relay_status = :rs, unread_count = :zero REMOVE unread_flag, relay_optout_flag'
            : 'SET #s = :status, relay_status = :rs REMOVE close_announced_at',
          ConditionExpression: 'attribute_exists(conversationId) AND #s = :expected',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':status': status,
            ':rs': relayStatusKey(status),
            ':expected': expectedCurrent,
            ...(isClose && { ':zero': 0 }),
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ conversationId, status }, 'relay status set');
      return Attributes as ConversationItem;
    },

    async assignPoolNumberAndOpen(conversationId, poolNumber) {
      // Connect-when-ready assign (T6 / G3): stamp the now-registered pool number
      // and flip connecting -> open on BOTH status + relay_status IN ONE
      // conditional write. The condition requires the group to still be
      // `connecting` on both fields, so a redelivered relay.numberReady (group
      // already open) fails the condition and this is an idempotent no-op
      // (undefined) - the intro is enqueued exactly once (only the winner
      // proceeds). participant_phone is set to the pool number too (the synthetic
      // value a relay thread carries, mirroring createRelayGroup). PII: log the
      // conversationId only, never the number.
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            UpdateExpression:
              'SET pool_number = :pn, participant_phone = :pn, #s = :open, relay_status = :rsOpen',
            ConditionExpression:
              'attribute_exists(conversationId) AND #s = :connecting AND relay_status = :rsConnecting',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
              ':pn': poolNumber,
              ':open': 'open',
              ':connecting': 'connecting',
              ':rsOpen': relayStatusKey('open'),
              ':rsConnecting': relayStatusKey('connecting'),
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        log.info({ conversationId }, 'relay connecting group assigned pool number and opened');
        return Attributes as ConversationItem;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          // Not connecting (already assigned / closed / unknown) - the exactly-
          // once guard for a redelivered relay.numberReady.
          log.info(
            { conversationId },
            'relay assignPoolNumberAndOpen no-op - group not connecting (already assigned or unknown)',
          );
          return undefined;
        }
        throw err;
      }
    },

    async claimCloseAnnounce(conversationId) {
      // W3 dedup claim: atomically win the right to send the ONE
      // relay.group_closed final message. SET close_announced_at conditional on
      // the group being OPEN and the marker still absent - so exactly one caller
      // wins under concurrent closes, and a close retry after a crash between
      // announce and flip (marker set, status still open) LOSES here and skips
      // the already-sent announcement. ConditionalCheckFailed (already closed /
      // already announced / missing) -> false. PII: log conversationId only.
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            UpdateExpression: 'SET close_announced_at = :now',
            ConditionExpression:
              'attribute_exists(conversationId) AND #s = :open AND attribute_not_exists(close_announced_at)',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':now': new Date().toISOString(), ':open': 'open' },
          }),
        );
        log.info({ conversationId }, 'relay close announce claimed');
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    },

    async setCloseNagNextAt(conversationId, at) {
      // SET the next-nag instant, or REMOVE it (null) when the group closes or
      // has no pending nag. Conditional on existence only (D5).
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: at === null ? 'REMOVE close_nag_next_at' : 'SET close_nag_next_at = :at',
          ConditionExpression: 'attribute_exists(conversationId)',
          ...(at !== null && { ExpressionAttributeValues: { ':at': at } }),
        }),
      );
      log.info({ conversationId, cleared: at === null }, 'relay close nag set');
    },

    async setRelayMemberOptedOut(conversationId, memberKey, entry) {
      // MERGE one slot without clobbering the others. DynamoDB rejects a single
      // SET that both seeds the parent map AND writes a child of it (overlapping
      // document paths — the same constraint messagesRepo.setRecipientDelivery
      // documents), and the parent map is NOT pre-seeded here (unlike
      // delivery_recipients). So: try the child-only SET first (the common path
      // once the map exists); if the map is absent the path SET fails its
      // implicit parent-exists precondition, so we seed the whole (merged) map in
      // a second write. Best-effort caller — a failure never breaks the fan-out.
      // memberKey may carry `#` (phone keys) → aliased name. PII: log keys only.
      //
      // THE byRelayOptOut FLAG RIDES BOTH WRITES (2026-08-18): the map going
      // non-empty is exactly the moment this thread becomes a Today attention
      // item, and stamping the flag in the same UpdateExpression is what keeps
      // the sparse index the truth (no second write to crash between).
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            UpdateExpression: 'SET relay_opted_out_members.#mk = :entry, relay_optout_flag = :flag',
            ConditionExpression:
              'attribute_exists(conversationId) AND attribute_exists(relay_opted_out_members)',
            ExpressionAttributeNames: { '#mk': memberKey },
            ExpressionAttributeValues: { ':entry': entry, ':flag': RELAY_OPTOUT_FLAG_VALUE },
          }),
        );
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // The map didn't exist yet — seed it with THIS one entry (existence of
        // the conversation still guarded so an unknown id doesn't create a row).
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            UpdateExpression: 'SET relay_opted_out_members = :map, relay_optout_flag = :flag',
            ConditionExpression: 'attribute_exists(conversationId)',
            ExpressionAttributeValues: { ':map': { [memberKey]: entry }, ':flag': RELAY_OPTOUT_FLAG_VALUE },
          }),
        );
      }
      log.info({ conversationId, memberKey }, 'relay member opt-out recorded on conversation');
    },

    async clearRelayMemberOptedOut(conversationId, memberKey) {
      // Idempotent no-op when there is nothing to clear. DynamoDB rejects a
      // `REMOVE relay_opted_out_members.#mk` whose parent map is ABSENT (the
      // document path is invalid for update → ValidationException), which is the
      // common member-remove case since the map only exists once someone has
      // opted out. Guard the REMOVE on the map existing (mirrors how the sibling
      // RECORD path tolerates the missing map), and swallow the resulting
      // ConditionalCheckFailedException — the map (or the key) being absent means
      // there is nothing to clear. We never create the map here. PII: log keys only.
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            UpdateExpression: 'REMOVE relay_opted_out_members.#mk',
            ConditionExpression:
              'attribute_exists(conversationId) AND attribute_exists(relay_opted_out_members)',
            ExpressionAttributeNames: { '#mk': memberKey },
          }),
        );
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // No opt-out map on this conversation → nothing to clear (no-op).
        return;
      }
      // RETIRE THE ROW FROM byRelayOptOut when that was the last entry
      // (2026-08-18). A second, CONDITIONAL write rather than one combined
      // REMOVE: DynamoDB evaluates `size(map)` against the row as it stands, so
      // "was this the last one" can only be asked AFTER the slot is gone. The
      // condition makes it safe under concurrent clears (whichever runs after
      // the map empties wins; the others no-op) and under a concurrent set
      // (a map that just gained an entry keeps its flag). Best-effort like the
      // rest of this path: a lost race leaves a flag on an empty map, which the
      // Today reader tolerates (it iterates the entries and emits nothing) and
      // the next set/clear corrects.
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            UpdateExpression: 'REMOVE relay_optout_flag',
            ConditionExpression:
              'attribute_exists(conversationId) AND attribute_exists(relay_opted_out_members) AND size(relay_opted_out_members) = :zero',
            ExpressionAttributeValues: { ':zero': 0 },
          }),
        );
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // Other members are still opted out (or a concurrent set landed): the
        // thread stays an attention item.
      }
      log.info({ conversationId, memberKey }, 'relay member opt-out cleared on conversation');
    },

    async rebindOwner(conversationId, newOwner) {
      // Re-parent the relay_group to a new owner — ONLY metadata changes.
      // Pool number + member roster are PRESERVED (not touched).
      // PII (doc §9): log type only, never the owner id.
      let updateExpression: string;
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};

      if (newOwner.type === null) {
        // Clear owner + legacy placementId (unowned).
        updateExpression = 'REMOVE #owner, #pid';
        names['#owner'] = 'owner';
        names['#pid'] = 'placementId';
      } else if (newOwner.type === 'placement') {
        // Placement-owned: write both `owner` + legacy `placementId` for back-compat.
        updateExpression = 'SET #owner = :owner, #pid = :pid';
        names['#owner'] = 'owner';
        names['#pid'] = 'placementId';
        values[':owner'] = newOwner;
        values[':pid'] = newOwner.id;
      } else {
        // Tour-owned: write `owner`; REMOVE legacy `placementId` (no longer applicable).
        updateExpression = 'SET #owner = :owner REMOVE #pid';
        names['#owner'] = 'owner';
        names['#pid'] = 'placementId';
        values[':owner'] = newOwner;
      }

      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          UpdateExpression: updateExpression,
          ConditionExpression: 'attribute_exists(conversationId)',
          ExpressionAttributeNames: names,
          ...(Object.keys(values).length > 0 && { ExpressionAttributeValues: values }),
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ conversationId, ownerType: newOwner.type }, 'relay group owner rebound');
      return Attributes as ConversationItem;
    },

    // --- Native group texts ------------------------------------------------

    async createGroupTextThread({ conversationId, members, lastActivityAt, preview }) {
      const now = new Date().toISOString();
      const previewText = toPreview(preview);
      const item: ConversationItem = {
        conversationId,
        // Own partition of byLastActivity - never `open` (see GROUP_TEXT_STATUS).
        status: GROUP_TEXT_STATUS,
        last_activity_at: lastActivityAt ?? now,
        type: 'group_text',
        // Carrier groups are staff-run in v1; `manual` keeps the automated-send
        // breaker's manual-mode posture, matching relay groups.
        ai_mode: 'manual',
        participants: members,
        created_at: now,
        ...(previewText !== undefined && { last_message_preview: previewText }),
      };
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: item,
            ConditionExpression: 'attribute_not_exists(conversationId)',
          }),
        );
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // Another inbound for the SAME roster won the race (ids are derived, so
        // both callers target one key). Adopt the stored row untouched.
        const existing = await getById(conversationId);
        if (!existing) {
          throw new Error(
            `createGroupTextThread: conversation ${conversationId} exists per the conditional put but is unreadable`,
          );
        }
        return { item: existing, created: false };
      }
      // PII (doc 9): ids + counts only, never a member phone.
      log.info({ conversationId, memberCount: members.length }, 'group text thread created');
      return { item, created: true };
    },

    async listGroupTexts(opts = {}) {
      const limit = opts.limit ?? DEFAULT_GROUP_PAGE_LIMIT;
      // Decode BEFORE any I/O: a foreign cursor must never reach DynamoDB as an
      // ExclusiveStartKey (it would page someone else's partition).
      let exclusiveStartKey: QueryCommandInput['ExclusiveStartKey'] =
        opts.cursor !== undefined && opts.cursor.length > 0
          ? (decodeGroupCursor(opts.cursor) as QueryCommandInput['ExclusiveStartKey'])
          : undefined;

      const items: ConversationItem[] = [];
      for (let page = 0; page < GROUP_LIST_MAX_PAGES; page++) {
        const remaining = limit - items.length;
        if (remaining <= 0) break;
        let result;
        try {
          result = await doc.send(
            new QueryCommand({
              TableName: table,
              IndexName: 'byLastActivity',
              KeyConditionExpression: '#s = :status',
              ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: { ':status': GROUP_TEXT_STATUS },
              ScanIndexForward: false, // newest activity first
              Limit: Math.min(remaining, GROUP_LIST_PAGE_LIMIT),
              ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
            }),
          );
        } catch (err) {
          // LOUD, never best-effort-empty: an empty page here is
          // indistinguishable from "this org has no group threads", which would
          // silently hide every group conversation in the inbox.
          log.error({ err }, 'group text list query failed');
          throw err;
        }
        items.push(...((result.Items ?? []) as ConversationItem[]));
        exclusiveStartKey = result.LastEvaluatedKey;
        if (exclusiveStartKey === undefined) {
          return { items, truncated: false };
        }
      }
      // More rows remain: hand back the tagged cursor. `truncated` says the PAGE
      // BUDGET (not the caller's limit) ended the walk - the caller surfaces it.
      return {
        items,
        ...(exclusiveStartKey !== undefined && {
          nextCursor: encodeGroupCursor(exclusiveStartKey as Record<string, unknown>),
        }),
        truncated: items.length < limit && exclusiveStartKey !== undefined,
      };
    },

    async claimRailCreation(conversationId, claim, expiredBefore) {
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            UpdateExpression: 'SET #rc = :claim',
            // FREE means absent or expired. `<=` (not `<`) so a claim stamped at
            // exactly the boundary is re-claimable rather than sticky.
            ConditionExpression:
              'attribute_exists(conversationId) AND ' +
              '(attribute_not_exists(#rc) OR #rc.#at <= :expiredBefore)',
            ExpressionAttributeNames: { '#rc': 'rail_creating', '#at': 'at' },
            ExpressionAttributeValues: { ':claim': claim, ':expiredBefore': expiredBefore },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return { claimed: true, item: Attributes as ConversationItem };
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // LOSER RE-READS (spec 6.1): the winner may already have stamped a sid,
        // in which case the loser has nothing to do and nothing to report.
        const item = await getById(conversationId);
        return { claimed: false, ...(item !== undefined && { item }) };
      }
    },

    async recordRailFailure(conversationId, reason, at, claimToken) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            UpdateExpression: 'SET rail_failed = :failed REMOVE #rc',
            ConditionExpression: 'attribute_exists(conversationId) AND #rc.#tok = :token',
            ExpressionAttributeNames: { '#rc': 'rail_creating', '#tok': 'token' },
            ExpressionAttributeValues: { ':failed': { at, reason }, ':token': claimToken },
          }),
        );
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // Someone else owns the claim now (or the row is gone). Their outcome is
        // the live one; ours is stale by definition.
        log.warn({ conversationId }, 'group text rail failure record lost its claim');
      }
    },

    async clearGroupRail(conversationId, expectedSid) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            // The map goes with the sid: a map without a sid describes a rail
            // that no longer exists, and every receipt mapped through it would
            // be attributed to a dead conversation.
            UpdateExpression:
              'REMOVE twilio_conversation_sid, twilio_participant_map, twilio_projected_address',
            ConditionExpression: 'attribute_exists(conversationId) AND twilio_conversation_sid = :sid',
            ExpressionAttributeValues: { ':sid': expectedSid },
          }),
        );
        log.warn(
          { event: 'group_rail_cleared', conversationId },
          'group text rail dropped - Twilio reported it closed or gone, so the ensure path can build a new one',
        );
        return true;
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // Someone healed it first (or the row is gone). Theirs is the live rail.
        log.info({ conversationId }, 'group text rail clear skipped - the stored rail is no longer the one we saw');
        return false;
      }
    },

    async setTwilioConversation(
      conversationId,
      twilioConversationSid,
      participantMap,
      claimToken,
      projectedAddress,
    ) {
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            // The sid, its MBxx map AND the verified projected address land
            // together (a sid without a map makes late receipts unattributable;
            // a sid without a verified author is a rail every post fails on),
            // and the claim is cleared in the same write so the rail is never
            // "done" while still marked in-flight.
            //
            // AND `rail_failed` GOES WITH IT (fix wave 5, adversarial 10). It
            // used to be written on every non-terminal path and cleared by
            // nothing, so a thread whose rail failed once and succeeded a minute
            // later was indistinguishable from one that never came back - and
            // spec 14 makes "zero UNRESOLVED rail failures" a hard cutover gate
            // over 132 real threads. A healed thread is not a failure. Clearing
            // it HERE, inside the fenced finalize, is what makes the field mean
            // "this rail is broken right now" rather than "this rail was broken
            // at some point in its history".
            UpdateExpression:
              'SET twilio_conversation_sid = :sid, twilio_participant_map = :map, ' +
              'twilio_projected_address = :projected ' +
              'REMOVE #rc, rail_failed',
            // FENCING (spec 15.3): only the claimant that still owns the token may
            // finalize. An expired claimant waking up late fails here rather than
            // overwriting the newer claimant's live rail.
            ConditionExpression: 'attribute_exists(conversationId) AND #rc.#tok = :token',
            ExpressionAttributeNames: { '#rc': 'rail_creating', '#tok': 'token' },
            ExpressionAttributeValues: {
              ':sid': twilioConversationSid,
              ':map': participantMap,
              ':projected': projectedAddress,
              ':token': claimToken,
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        log.info(
          { conversationId, participantCount: Object.keys(participantMap).length },
          'group text rail finalized',
        );
        return Attributes as ConversationItem;
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // Claim taken over / already cleared / row gone: the caller discards its
        // orphaned rail. Never a throw - losing the fence is an expected outcome.
        log.warn({ conversationId }, 'group text rail finalize lost its claim');
        return undefined;
      }
    },

    async convertRelayGroupToGroupText(conversationId, members) {
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            UpdateExpression:
              'SET #type = :groupText, #s = :groupOpen, participants = :members ' +
              // Every relay-only field goes in the SAME write. relay_status is
              // the one that MUST go: leaving it would keep the thread in the
              // sparse byRelayStatus GSI, so it would still answer
              // listRelayGroups('connecting') while rendering as a group text.
              'REMOVE relay_status, pool_number, participant_phone, participants_version, ' +
              'relay_opted_out_members, close_nag_next_at, close_announced_at, ' +
              'ever_member_phones, placementId, #owner',
            ConditionExpression:
              'attribute_exists(conversationId) AND #type = :relayGroup AND #s = :connecting ' +
              'AND attribute_not_exists(pool_number)',
            ExpressionAttributeNames: { '#type': 'type', '#s': 'status', '#owner': 'owner' },
            ExpressionAttributeValues: {
              ':groupText': 'group_text',
              ':groupOpen': GROUP_TEXT_STATUS,
              ':relayGroup': 'relay_group',
              ':connecting': 'connecting',
              ':members': members,
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        log.info(
          { conversationId, memberCount: members.length },
          'relay group converted to native group text',
        );
        return Attributes as ConversationItem;
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // Expected: another converter won, or the row never qualified. The
        // caller re-reads and classifies - this is not an error here.
        return undefined;
      }
    },

    async backfillGroupTextRoster(conversationId, members, expectedPrior) {
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId },
            UpdateExpression: 'SET participants = :members',
            // ROSTER-UNCHANGED PRECONDITION (fix wave 5, adversarial 27). This
            // is a WHOLE-ARRAY overwrite derived from a `getById` earlier in the
            // same call, and the bulk conversion runner and the inline
            // auto-convert can converge one thread concurrently with no lock -
            // so without this the later write won wholesale and could drop a
            // `name` the other side had just resolved. The caller passes what it
            // READ; a loser gets `undefined` and re-reads rather than clobbering.
            // Omitted (undefined) means "no prior expectation" - the import path
            // that mints the roster in the first place has nothing to compare.
            ConditionExpression:
              'attribute_exists(conversationId) AND #type = :groupText' +
              (expectedPrior === undefined ? '' : ' AND participants = :prior'),
            ExpressionAttributeNames: { '#type': 'type' },
            ExpressionAttributeValues: {
              ':groupText': 'group_text',
              ':members': members,
              ...(expectedPrior !== undefined && { ':prior': expectedPrior }),
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return Attributes as ConversationItem;
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        return undefined;
      }
    },
  };
}
