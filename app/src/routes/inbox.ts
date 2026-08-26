// C8 / "BE7" — Inbox feed. A READ-ONLY aggregation over the conversations,
// contacts, messages, and placements repos (no new table) that assembles
// the dashboard's secondary comms lens: ONE row per contact (or one untriaged
// unknown number), newest-activity-first, with cross-number unread, the latest
// item's channel/direction/preview, and an optional placement context. Mounted
// at /api/inbox (behind requireAuth via the /api mount in app.ts).
//
// The wire shape (InboxFilter/InboxChannel/InboxRow/InboxPage) is copied
// VERBATIM from the design spec's "Contract C8" (docs/superpowers/specs/
// 2026-06-17-inbox-design.md) and is imported, field-for-field, by the frontend
// `api/types.ts` — do NOT rename/reshape fields here.
//
// ONE ROW PER CONTACT, the "newest-conversation rule": a contact may own several
// phone numbers, each its own 1:1 conversation. We emit the contact's row ONLY
// while iterating its NEWEST conversation (max last_activity_at). That makes the
// feed stateless and SPLIT-PROOF across cursor pages: a contact represented on
// page 1 by its newest conversation can never reappear on page 2 via an older
// one (an older conversation is skipped because it isn't the newest). The cursor
// is the opaque base64url of the raw byLastActivity LastEvaluatedKey — the same
// scheme GET /api/conversations uses.
//
// There are THREE row sources. The contact pager is the first; the two below are
// merged additively onto page one (see aggregateInbox), and neither can collide
// with a contact row because both key by conversationId.
//
// group_text conversations are the THIRD row source (kind='group_text'): native
// carrier group threads, read from the `group_open` partition via
// conversationsRepo.listGroupTexts. They are CAPPED on page one and have their
// own `groups` filter, which pages the whole partition through a namespaced
// cursor - see the merge block and GROUP_PAGE_ONE_LIMIT.
//
// relay_group conversations are a SECOND row source (kind='relay_group'):
// masked relay-group threads carry last_activity_at / status / unread_count /
// last_message_preview just like a 1:1, so they are folded into the same feed
// (queried via conversationsRepo.listRelayGroups, NOT the contact pager) and
// merge-sorted by last_activity_at. To keep paging split-proof they are emitted
// ONLY on the first page and additively — see the merge note in aggregateInbox.
//
// Hydration (name / role / placementContext / channel / direction / preview) is
// BEST-EFFORT and bounded to the page: every external lookup is wrapped so a
// missing/failed read degrades to the id (or omits the field) and NEVER throws
// a 500 - exactly the posture today.ts takes. Per-request caches keep each
// contact/placement resolved at most once.
//
// PII (doc §9): responses carry names/previews to the authed client; LOG LINES
// are counts/IDs only.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { Router } from 'express';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  appEvents,
  toConversationUpdatedEvent,
  type EventBus,
} from '../lib/events.js';
import { formatPhoneForDisplay } from '../lib/phone.js';
import { groupThreadLabel, relayThreadLabel } from '../lib/groupTitle.js';
import { STAGE_LABELS } from '../lib/statusModel.js';
import {
  createPlacementsRepo,
  type PlacementsRepo,
} from '../repos/placementsRepo.js';
import {
  createConversationsRepo,
  getOwner,
  GroupCursorError,
  type ConversationItem,
  type ConversationsRepo,
  type RelayOwner,
} from '../repos/conversationsRepo.js';
import {
  createContactsRepo,
  isDeleted,
  type ContactItem,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import {
  createMessagesRepo,
  type CallOutcome,
  type CallStatus,
  type MessageItem,
  type MessagesRepo,
} from '../repos/messagesRepo.js';
import { callPreview } from '../lib/callPreview.js';
import { conversationsForContact } from '../lib/contactThreads.js';
import { markUnread } from '../lib/markUnread.js';
import {
  BADGE_COUNT_CAP,
  collectUnreadRows,
  isUnreadVisible,
  UNREAD_WALK_LIMIT,
  warnDeletedProbes,
  warnTruncatedZeroCount,
  warnUnreadScanned,
  type UnreadCandidate,
  type UnreadScanPosition,
} from '../lib/unreadFeed.js';
import {
  collectUnknownTriageQueue,
  UNKNOWN_QUEUE_MAX_PAGES,
  UNKNOWN_QUEUE_MAX_ROWS,
  UNKNOWN_QUEUE_PAGE_SIZE,
} from '../lib/unknownQueue.js';

// --- C8 wire contract (VERBATIM — the frontend imports the same shapes) ------

export type InboxFilter = 'all' | 'unread' | 'unknown' | 'groups';
export type InboxChannel = 'sms' | 'mms' | 'call' | 'email';

export interface InboxRow {
  // `group_text` = a NATIVE carrier group thread, the THIRD row source. It
  // reuses conversationId/name/unreadCount/preview/lastActivityAt and omits
  // channel/direction/status/owner/phone.
  kind: 'contact' | 'unknown' | 'relay_group' | 'group_text';
  contactId?: string; // present when kind='contact'
  phone?: string; // E.164; the number (esp. for unknown rows). Absent on relay_group.
  name: string; // contact name, formatted number (unknown), or the group label (relay_group)
  role?: 'tenant' | 'landlord' | 'partner' | 'unknown';
  placementContext?: { placementId: string; label: string }; // e.g. "Touring" — optional
  unreadCount: number; // aggregate across ALL of the contact's numbers (relay: the group's unread)
  preview: string; // latest item's text as a preview (relay: last_message_preview)
  channel?: InboxChannel; // channel of the latest item — OMITTED on relay_group rows
  direction?: 'inbound' | 'outbound'; // 'outbound' → "You: …" — OMITTED on relay_group rows
  lastActivityAt: string; // ISO; sort key (newest first)
  needsTriage: boolean; // true for untriaged unknowns; ALWAYS false for relay_group
  /** Deleted-contact resurfacing (2026-08-03 spec): present/true ONLY on a
   *  soft-deleted contact row surfaced by an unread post-deletion inbound —
   *  the dashboard renders a "Deleted" chip. Absent on live contacts and
   *  non-contact rows. */
  deleted?: boolean;
  // --- multi-party rows (relay_group AND group_text) ---------------------------
  conversationId?: string; // the conversation id -> route /conversations/:conversationId
  // --- relay_group ONLY --------------------------------------------------------
  /** The RELAY group's lifecycle status (D9: connecting = awaiting its number).
   *  DELIBERATELY ABSENT on a `group_text` row: a native carrier group has no
   *  lifecycle in v1 (spec 10 - no close/archive) and its stored status is
   *  `group_open`, which is not one of these literals. Widening this union with
   *  a non-relay literal (or, worse, normalizing `group_open` to `'open'` the way
   *  relayRowFor's catch-all would) would report a silent lie to the dashboard. */
  status?: 'open' | 'closed' | 'connecting';
  owner?: RelayOwner; // owning tour/placement ({type:'tour'|'placement',id} | {type:null})
}

export interface InboxPage {
  rows: InboxRow[]; // newest-activity-first; ONE row per contact
  nextCursor: string | null;
  /** TRUE when the GROUP source could not show every group thread it was asked
   *  for, so the dashboard renders the "showing latest N" affordance instead of
   *  implying the page is complete. Two causes, both surfaced the same way:
   *  the page-one top-50 cap under `filter=all`, and listGroupTexts' own walk
   *  budget. There is NO exact total - the partition cannot produce one without
   *  walking it (spec 11). Absent means "nothing was withheld". */
  groupsTruncated?: boolean;
  /** TRUE when the UNREAD feed ended for a NON-NATURAL reason (spec 4.5 step 3):
   *  the request's raw-scan budget expired before the page filled, or the
   *  SEEN_SET_MAX depth cap ended paging. Set on the `filter=unread` branch
   *  ONLY - never on all/unknown/groups. Absent means the feed ended because it
   *  ran out of unread rows, which is the ordinary case. */
  truncated?: true;
}

/**
 * The nav badge's payload (spec 4.4). It counts VISIBLE INBOX ROWS - one per
 * contact however many unread threads it owns, one per unknown number, one per
 * relay group, one per native group thread.
 *
 * `capped` and `truncated` are SEPARATE fields because the client treats them
 * differently: a capped count is a ceiling rendered "99+" and must NOT be
 * decremented on mark-read, while a truncated count is small and real-so-far
 * and SHOULD still decrement.
 */
export interface InboxUnreadCount {
  unreadCount: number;
  /** BADGE_COUNT_CAP stopped the count (the number is a floor at the cap). */
  capped: boolean;
  /** The request's raw-scan budget stopped the walk first (also a floor). */
  truncated: boolean;
}

// --- Deps (injectable; default to the real repos, like TodayRouterDeps) ------

export interface InboxRouterDeps {
  logger?: Logger;
  conversationsRepo?: ConversationsRepo;
  contactsRepo?: ContactsRepo;
  messagesRepo?: MessagesRepo;
  placementsRepo?: PlacementsRepo;
  events?: EventBus;
  /**
   * TEST SEAM: the raw byUnread items ONE request may scan before it gives up
   * and reports a floor. Production leaves it undefined and takes
   * UNREAD_WALK_LIMIT; a route test sets it small so the `truncated` posture is
   * reachable without seeding thousands of rows. Threaded in from
   * ApiRouterDeps.
   */
  unreadWalkLimit?: number;
  /**
   * TEST SEAMS for the unknown-tab queue read, mirroring unreadWalkLimit:
   * production leaves them undefined and takes the lib/unknownQueue.ts
   * constants; tests set them small so the fill-loop, cap and WARN postures
   * are reachable without 200-contact fixtures.
   */
  unknownQueuePageSize?: number;
  unknownQueueMaxPages?: number;
  unknownQueueMaxRows?: number;
}

// --- Tuning -----------------------------------------------------------------

/** Default + max page size (one row per contact). Clamped at the route. */
export const DEFAULT_INBOX_LIMIT = 25;
export const MAX_INBOX_LIMIT = 100;

/**
 * How many raw conversations we pull per byLastActivity batch while filling a
 * page. A page is `limit` CONTACT rows, but each contact can consume several
 * conversations (multi-number) and filters/relay-skips drop rows — so we may
 * scan more raw conversations than `limit`. A generous batch keeps the number
 * of round-trips low; the consume-boundary cursor makes batching transparent.
 */
const FETCH_BATCH = 100;

/** The valid filter values (route allowlist -> 400 on anything else). */
export const INBOX_FILTERS: ReadonlySet<string> = new Set<InboxFilter>([
  'all',
  'unread',
  'unknown',
  'groups',
]);

/**
 * Page-one cap for the GROUP source under `filter=all` (spec 11). Relay's source
 * is additive and uncapped because a handful of relay groups exist; the founder
 * has 132 native group threads on day one, which would flood page one. The
 * overflow is not lost - it pages in full under `filter=groups`.
 */
export const GROUP_PAGE_ONE_LIMIT = 50;

/**
 * How many contactIds the unread cursor's SEEN-SET may carry (spec 4.3).
 *
 * The binding constraint is the TRANSPORT, not Node: CloudFront's URL limit is a
 * fixed 8,192 bytes and fronts every deployed environment, so an oversized
 * cursor would fail in dev/prod but not locally. 100 ids (~4.7KB of JSON ->
 * ~6.3KB base64url) plus the rest of the request line stays inside that quota
 * with margin, and ends the feed at ~4 pages (120+ unread contact rows), which
 * has no product meaning to exceed: the badge caps at 100 and triage is
 * top-down.
 *
 * THE SERVER NEVER MINTS A CURSOR IT WOULD REJECT - past this, the page returns
 * `nextCursor: null` AND `truncated: true` rather than a cursor the decoder
 * below would 400. That 400 exists for TAMPERED input only.
 */
const SEEN_SET_MAX = 100;

export function isInboxFilter(value: unknown): value is InboxFilter {
  return typeof value === 'string' && INBOX_FILTERS.has(value);
}

/**
 * A bad client input (malformed cursor / bad filter) the route maps to 400 —
 * NEVER a 500. Mirrors the project posture (a tampered cursor must not reach
 * DynamoDB as a malformed key nor crash the handler).
 */
export class InboxBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboxBadRequestError';
  }
}

// --- Cursor (opaque to clients) ---------------------------------------------
// base64url(JSON) of the byLastActivity LastEvaluatedKey. Clients echo it back
// via ?cursor= — it is never constructed by hand. We DON'T over-validate the
// inner shape here (the today/conversations inbox validates the exact GSI key,
// but the aggregator's consume-boundary key is repo-defined and may vary by
// backend); a non-decodable cursor is a 400.

function encodeCursor(lastEvaluatedKey: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(lastEvaluatedKey), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InboxBadRequestError('invalid cursor');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InboxBadRequestError('invalid cursor');
  }
  // NAMESPACED CURSORS (spec 11). `filter=groups` pages the group_open partition
  // with the repo's TAGGED cursor ({t,k}); this 'open'-partition cursor is the
  // bare LastEvaluatedKey. Replaying a group cursor here would hand DynamoDB a
  // key for the WRONG partition - a 500, or worse, a wrong-but-plausible page.
  // A tag where none belongs is therefore a 400, never a Query. (The reverse
  // direction is enforced by decodeGroupCursor's own tag check.)
  if (typeof (parsed as { t?: unknown }).t === 'string') {
    throw new InboxBadRequestError('cursor does not match this filter');
  }
  // The SAME namespacing in the other direction (spec 4.3): `filter=unread`
  // pages the byUnread index with its own `{u,a,c,s}` cursor. Replaying it here
  // would hand DynamoDB a key with the wrong hash attribute for the 'open'
  // partition. A numeric `u` tag where none belongs is a 400, never a Query.
  if (typeof (parsed as { u?: unknown }).u === 'number') {
    throw new InboxBadRequestError('cursor does not match this filter');
  }
  return parsed as Record<string, unknown>;
}

// --- The unread cursor (spec 4.3) -------------------------------------------
// A DIFFERENT cursor namespace from the one above: `{u:1, a, c, s}` where (a,c)
// is the byUnread scan position and `s` is the SEEN-SET of contactIds already
// emitted on this and every prior page. Resume is therefore an EXACT position
// plus pure set membership - no ordering comparison, no re-read of a contact's
// threads, deterministic under `last_activity_at` ties.

interface UnreadCursor {
  /** Namespace tag. Any other value is a cursor from another filter -> 400. */
  u: 1;
  /** The scan position's `last_activity_at` (the index's range key). */
  a: string;
  /** The scan position's conversationId (the trailing table key). */
  c: string;
  /** Contact ids already emitted - suppressed on the next page. */
  s: string[];
}

function encodeUnreadCursor(position: UnreadScanPosition, seen: ReadonlySet<string>): string {
  const payload: UnreadCursor = {
    u: 1,
    a: position.lastActivityAt,
    c: position.conversationId,
    s: [...seen],
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode + VALIDATE an unread cursor. Unlike `decodeCursor` (whose payload is a
 * repo-defined LastEvaluatedKey we deliberately do not over-validate), every
 * field here is ours, so every field is checked: a tampered `s` is what would
 * otherwise let a client push an unbounded array into the resume path.
 */
function decodeUnreadCursor(cursor: string): UnreadCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InboxBadRequestError('invalid cursor');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InboxBadRequestError('invalid cursor');
  }
  const payload = parsed as { u?: unknown; a?: unknown; c?: unknown; s?: unknown };
  // A cursor minted under `all` (a bare LastEvaluatedKey) or under `groups`
  // (the repo's `{t,k}`) carries no `u:1` and lands here. `unknown` MINTS NO
  // CURSOR AT ALL since the 2026-08-25 contact-side read - its branch rejects
  // every cursor it is handed before any decode runs - so nothing of its own
  // can arrive here either.
  if (payload.u !== 1) throw new InboxBadRequestError('cursor does not match this filter');
  if (typeof payload.a !== 'string' || typeof payload.c !== 'string') {
    throw new InboxBadRequestError('invalid cursor');
  }
  // NON-EMPTY, not merely string (adversarial A4). Both fields become KEY
  // attributes of the synthesized ExclusiveStartKey, and DynamoDB permits an
  // empty String for a non-key attribute ONLY - an empty range or table key is
  // a ValidationException, which nothing on this path maps, so a hand-made
  // cursor turned the one decoder written to guarantee 400s into a 500.
  if (payload.a.length === 0 || payload.c.length === 0) {
    throw new InboxBadRequestError('invalid cursor');
  }
  if (!Array.isArray(payload.s)) throw new InboxBadRequestError('invalid cursor');
  // The server never mints one this long (it returns `truncated` instead), so
  // an over-long seen-set can only be tampered input.
  if (payload.s.length > SEEN_SET_MAX) throw new InboxBadRequestError('invalid cursor');
  // An empty id would never match a contactId, so it can only be tampering -
  // and the server never mints one (a contactId is always non-empty).
  if (payload.s.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new InboxBadRequestError('invalid cursor');
  }
  return { u: 1, a: payload.a, c: payload.c, s: payload.s as string[] };
}

// --- Pure helpers (no I/O) ---------------------------------------------------

/**
 * The human label for a placement stage — the centralized STAGE_LABELS map
 * (single source of display copy). Falls back to a title-cased key for any
 * non-stage value.
 */
function stageLabel(value: string): string {
  const label = (STAGE_LABELS as Record<string, string>)[value];
  if (label !== undefined) return label;
  return value
    .split('_')
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Resolved "First Last" from a contact, or undefined (never a guess). */
function nameFromContact(contact: ContactItem | undefined): string | undefined {
  if (!contact) return undefined;
  const first = typeof contact.firstName === 'string' ? contact.firstName : '';
  const last = typeof contact.lastName === 'string' ? contact.lastName : '';
  const joined = `${first} ${last}`.trim();
  if (joined.length > 0) return joined;
  // A name may also live in a single denormalized field on some records.
  const name = typeof contact.name === 'string' ? contact.name : '';
  return name.length > 0 ? name : undefined;
}

/** A contact's audience role for the row chip (tenant/landlord/partner, else unknown). */
function roleFromContact(
  contact: ContactItem | undefined,
): 'tenant' | 'landlord' | 'partner' | 'unknown' {
  if (contact?.type === 'tenant') return 'tenant';
  if (contact?.type === 'landlord') return 'landlord';
  if (contact?.type === 'partner') return 'partner';
  return 'unknown';
}

/**
 * The unread count carried on a conversation row (sparse → 0). Pulled into a
 * helper so the cross-number SUM and the per-row read share one definition.
 */
function unreadOf(conv: ConversationItem): number {
  return typeof conv.unread_count === 'number' ? conv.unread_count : 0;
}

// The roster-derived group title now lives in lib/groupTitle.ts - ONE
// derivation for the inbox row, the contact card and (via its documented
// dashboard mirror) the thread header. Re-exported because the S4 tests and
// the e2e assertions bind to it here.
export { groupThreadLabel };

/** The latest message's channel/direction/preview, derived (never stored). */
interface DerivedLatest {
  channel: InboxChannel;
  direction: 'inbound' | 'outbound';
  preview: string;
  /** The latest message's created_at (ISO). Absent when no message row was
   *  readable (fallback preview) — callers needing recency must treat absent
   *  as "unknown", never as "new". */
  createdAt?: string;
}

/**
 * Derive channel/direction/preview from the newest message on the representative
 * conversation. mms when the message carries media; call when it's a call
 * record; else sms. Falls back to the conversation's denormalized preview (and
 * sms/inbound) when no message is available — never throws.
 */
// Exhaustive by construction: adding a member to either union in messagesRepo
// fails typecheck here (`satisfies Record<Union, true>`), so an unknown call
// state can never silently fall through to the wrong preview.
const CALL_STATUS_MAP = {
  ringing: true,
  'in-progress': true,
  completed: true,
  'no-answer': true,
  busy: true,
  failed: true,
  canceled: true,
} satisfies Record<CallStatus, true>;
const CALL_OUTCOME_MAP = { answered: true, missed: true, voicemail: true } satisfies Record<CallOutcome, true>;
function isCallStatus(v: unknown): v is CallStatus {
  return typeof v === 'string' && Object.hasOwn(CALL_STATUS_MAP, v);
}
function isCallOutcome(v: unknown): v is CallOutcome {
  return typeof v === 'string' && Object.hasOwn(CALL_OUTCOME_MAP, v);
}

function deriveLatest(
  latest:
    | {
        type?: unknown;
        direction?: unknown;
        body?: unknown;
        mediaUrls?: unknown;
        media_attachments?: unknown;
        created_at?: unknown;
        call_status?: unknown;
        call_outcome?: unknown;
        call_duration?: unknown;
      }
    | undefined,
  conv: ConversationItem,
): DerivedLatest {
  const fallbackPreview =
    typeof conv.last_message_preview === 'string' ? conv.last_message_preview : '';
  if (!latest) {
    return { channel: 'sms', direction: 'inbound', preview: fallbackPreview };
  }
  let channel: InboxChannel;
  if (latest.type === 'call') {
    channel = 'call';
  } else if (latest.type === 'email') {
    // Email channel v1: an email is its own channel (checked before the mms
    // media-array sniff, since an inbound email may carry attachments).
    channel = 'email';
  } else if (
    latest.type === 'mms' ||
    (Array.isArray(latest.mediaUrls) && latest.mediaUrls.length > 0) ||
    (Array.isArray(latest.media_attachments) && latest.media_attachments.length > 0)
  ) {
    channel = 'mms';
  } else {
    channel = 'sms';
  }
  const direction: 'inbound' | 'outbound' = latest.direction === 'outbound' ? 'outbound' : 'inbound';
  // A call row has no body. The STORED preview (written by the voice paths from
  // the Dial summary / voicemail callback - call-inbox-unread) is authoritative
  // once it exists for a finished call. Derive from the row itself ONLY when
  // the row carries a KNOWN call_status and either (a) the call is still
  // non-terminal - during the ring, or forever when the caller abandons before
  // any summary (docs/issues/voice-caller-abandon-no-dial-summary.md), where
  // the stored preview is empty or the previous TEXT's body under a "Call"
  // chip - or (b) no preview was ever stored (a call that finished before this
  // shipped) - or (c) the row carries a TERMINAL call_status with NO
  // call_outcome, which is the signature of a gate refusal stamp (spec 6.3 D12,
  // written at voice.ts's three outbound refusal branches: the /outbound-bridge
  // unresolved target, the whisper gate's unresolved target/business number,
  // and the DNC re-check). Those calls never dial, so no Dial summary ever
  // stamps a preview; before D12 they sat at 'ringing' and derived through (a),
  // and clause (c) keeps that same row. Raw absence of call_outcome is the test
  // (NOT isCallOutcome): an imported row's out-of-union outcome is not a D12
  // stamp, and a 'canceled' row that DOES carry an outcome - reachable when
  // stampCallActivity fails and swallows it - must keep its stored preview.
  // The strings coincide because callPreview's base case and its ringing arm
  // are both "Outgoing call" FOR OUTBOUND, which is what all three D12 sites
  // are; they are NOT the same arm. An inbound terminal-with-no-outcome writer
  // would derive "Call" here where the ringing row derived "Incoming call", so
  // re-check this if one is ever added. Never for a row without a known
  // call_status (the Quo importer
  // writes none, and its call_outcome values are outside the union): a stored
  // preview or blank is the honest answer there, not a synthetic live ring.
  // Never overrides a stored terminal preview - the outbound preview is
  // deliberately derived from the Dial status, not from the persisted
  // call_outcome (outbound-call-outcome-answered-before-target-rings), and
  // re-deriving from the row here would undo that. Never derives "in progress"
  // either: `in-progress` is written by the whisper gate the moment the bridge
  // is accepted and nothing but a Dial summary moves a call off it, so a call
  // that ends without one would assert a LIVE call forever; an in-progress row
  // keeps the stored preview, or derives as a plain "Incoming call" /
  // "Outgoing call" when nothing was stored (true, and never stale-false).
  // Zero extra reads either way.
  const callStatus: CallStatus | undefined = isCallStatus(latest.call_status) ? latest.call_status : undefined;
  const preview =
    typeof latest.body === 'string' && latest.body.length > 0
      ? latest.body
      : channel === 'call' &&
          callStatus !== undefined &&
          (callStatus === 'ringing' ||
            (callStatus === 'canceled' && latest.call_outcome === undefined) ||
            fallbackPreview === '')
        ? callPreview({
            direction,
            callStatus: callStatus === 'in-progress' ? 'ringing' : callStatus,
            ...(isCallOutcome(latest.call_outcome) && { callOutcome: latest.call_outcome }),
            ...(typeof latest.call_duration === 'number' && { callDuration: latest.call_duration }),
          })
        : fallbackPreview;
  const createdAt = typeof latest.created_at === 'string' ? latest.created_at : undefined;
  return { channel, direction, preview, ...(createdAt !== undefined && { createdAt }) };
}

// --- The aggregator ----------------------------------------------------------

/**
 * Assemble one page of the inbox feed. See the module header for the
 * newest-conversation rule + the split-proof cursor scheme.
 *
 * Throws InboxBadRequestError for a malformed cursor (the route → 400). All
 * other repo reads are best-effort and degrade rather than throw.
 */
export async function aggregateInbox(
  opts: { filter: InboxFilter; limit: number; cursor?: string },
  deps: InboxRouterDeps,
): Promise<InboxPage> {
  const log = deps.logger ?? defaultLogger;
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const placements = deps.placementsRepo ?? createPlacementsRepo({ logger: deps.logger });

  const { filter, limit, cursor } = opts;
  // ONLY `all` pages the 'open' partition now, so ONLY it decodes the cursor
  // here. The other three filters own their own cursor NAMESPACE: `groups`
  // decodes inside listGroupTexts (the repo's tagged `{t,k}`), `unread` via
  // decodeUnreadCursor (the `{u,a,c,s}` index cursor) in its branch below, and
  // `unknown` MINTS NO CURSOR at all since the 2026-08-25 contact-side read -
  // it serves one sorted window over a bounded queue and 400s any cursor it is
  // handed (its branch below). Decoding any of those as an 'open'-partition
  // LastEvaluatedKey is precisely the cross-partition replay the namespacing
  // exists to prevent.
  const startKey =
    filter === 'all' && cursor !== undefined ? decodeCursor(cursor) : undefined;

  // Per-request memoization (each contact/placement/user resolved at most once).
  const contactConvsCache = new Map<string, ConversationItem[]>();
  const placementLabelCache = new Map<string, string | undefined>();
  // Contacts already emitted in THIS page (the newest-conversation guard so a
  // multi-number contact never yields two rows on one page).
  const emittedContacts = new Set<string>();

  // --- Read accounting for the assembled-feed log line ------------------------
  // WHY THIS EXISTS: a zero-row answer is, in the log we ship today, identical
  // to a healthy one - `count: 0` cannot say whether the partition Query came
  // back empty or whether every row it returned was dropped during assembly.
  // Three e2e sightings of a READY-AND-EMPTY All tab were undiagnosable for
  // exactly that reason (call-inbox-unread-detached-node-flake): the failure
  // artifacts are browser-side only, and nothing server-side recorded which of
  // the two happened. `rawScanned` separates those two worlds in one field, and
  // the per-reason drop counts name WHICH guard consumed the rows when it was
  // the second. Kept in production, not test-only scaffolding: the same
  // ambiguity exists in every deployed environment.
  //
  // SCOPE, stated because the fields are easy to over-read:
  //
  // - They cover the OPEN-PARTITION pager only - filter `all`. The `groups`,
  //   `unread` and (since the 2026-08-25 contact-side read) `unknown` branches
  //   return through their own log lines and carry none of this. The unread
  //   line's `scanned` is BUDGET UNITS, not rows, so `count: 0, scanned: 0`
  //   there still carries the ambiguity this removed for `all`. Filed rather
  //   than fixed here: see docs/issues/inbox-read-accounting-gaps.md.
  // - The `unknown` branch answers the same zero-row question with its OWN
  //   fields on the shared 'inbox feed assembled' line: `queueContacts` /
  //   `queuePages` (what the triage partition returned), `threadReadFailures`,
  //   plus this block's own `drops` object - which IS shared, because
  //   `dropped()` is. `rawScanned` / `rawQueries` stay zero there; nothing
  //   pages the open partition on that filter any more. (It also carried
  //   `sweepScanned` / `resurfaceTruncated` / `resurfaceCapped` until the
  //   resurfacing sweep was deleted on 2026-08-26; those fields are gone, so
  //   an old log query for them returns nothing rather than zeroes.)
  // - `rawScanned == count + sum(drops)` DOES NOT HOLD, in ANY case - including
  //   the `count: 0` one. `count` includes relay and group rows that no chunk
  //   Query ever scanned; a page that FILLS stops mid-chunk with the remaining
  //   items counted in `rawScanned` but never assembled; and `filteredRelay` /
  //   `filteredGroup` count rows that were never scanned either, so `sum(drops)`
  //   can EXCEED `rawScanned` (an empty open partition with three filtered relay
  //   rows logs `rawScanned: 0, drops: {filteredRelay: 3}`). Do not do this
  //   arithmetic; read the fields as two separate statements - what the
  //   partition returned, and what assembly discarded.
  // - `drops` is a NORMAL-TRAFFIC field, not an exception field: `dupContact`
  //   fires for every extra thread of a multi-number contact on the same page.
  //   Its absence means nothing was dropped; its presence means nothing is
  //   wrong.
  // - `filteredRelay` and `filteredGroup` are PAGE-ONE-ONLY (both merge blocks
  //   gate on `startKey === undefined`), so their absence on page 2+ carries no
  //   information at all.
  let rawScanned = 0;
  let rawQueries = 0;
  const drops: Record<string, number> = {};
  /** Record a drop reason and return the `undefined` the caller was returning. */
  const dropped = (reason: string): undefined => {
    drops[reason] = (drops[reason] ?? 0) + 1;
    return undefined;
  };

  /** All open 1:1 conversations a contact owns, across every phone AND email (cached). */
  const contactConversations = async (contact: ContactItem): Promise<ConversationItem[]> => {
    if (contactConvsCache.has(contact.contactId)) {
      return contactConvsCache.get(contact.contactId)!;
    }
    let list: ConversationItem[] = [];
    try {
      // Email channel v1 (invariant rule): resolve across BOTH phones AND emails
      // so a mixed contact's unread SUM + newest-conversation choice include
      // email-only threads. The feed shows OPEN 1:1s only (relay groups are the
      // separate row source).
      // A NATIVE GROUP TEXT CAN NEVER APPEAR HERE, for two independent reasons,
      // and both are worth naming: conversationsForContact resolves only via
      // findByParticipantPhone / findByParticipantEmail, and a group thread
      // writes NEITHER key; and the `status === 'open'` clause below excludes
      // the `group_open` partition anyway. So group unread never enters a
      // contact's unread SUM - which is the correct product answer too (its
      // unread belongs to the group row, and no 1:1 mark-read could clear it).
      const all = await conversationsForContact(contact, conversations);
      list = all.filter((c) => c.status === 'open' && c.type !== 'relay_group');
    } catch (err) {
      log.warn({ err, contactId: contact.contactId }, 'inbox: contact conversations lookup failed (best-effort)');
    }
    contactConvsCache.set(contact.contactId, list);
    return list;
  };

  /** The newest conversation in a set (max last_activity_at); undefined if empty. */
  const newestOf = (convs: ConversationItem[]): ConversationItem | undefined => {
    let best: ConversationItem | undefined;
    for (const c of convs) {
      if (best === undefined || c.last_activity_at > best.last_activity_at) best = c;
    }
    return best;
  };

  /** Resolve a placement's label (stage title-cased); cached + best-effort. */
  const placementLabel = async (placementId: string): Promise<string | undefined> => {
    if (placementLabelCache.has(placementId)) return placementLabelCache.get(placementId);
    let label: string | undefined;
    try {
      const c = await placements.getById(placementId);
      if (c && typeof c.stage === 'string') label = stageLabel(c.stage);
    } catch (err) {
      log.warn({ err, placementId }, 'inbox: placement label hydration failed (best-effort)');
    }
    placementLabelCache.set(placementId, label);
    return label;
  };

  /** Derive the newest message on a conversation; best-effort (degrades). */
  const latestMessageOf = async (
    conversationId: string,
    conv: ConversationItem,
  ): Promise<DerivedLatest> => {
    let latest: MessageItem | undefined;
    try {
      const page = await messages.listByConversation(conversationId, { limit: 1 });
      latest = page[0];
    } catch (err) {
      log.warn({ err, conversationId }, 'inbox: latest-message hydration failed (best-effort)');
    }
    return deriveLatest(latest, conv);
  };

  /** Does the row pass the active filter? EXHAUSTIVE on purpose - the `default:`
   *  arm this switch used to carry made a missing filter case SILENT (every row
   *  passing), which is exactly how a new filter ships as a no-op. */
  const passesFilter = (row: InboxRow): boolean => {
    switch (filter) {
      case 'unread':
        // UNREACHABLE since spec 4.5 (the unread branch returns before any
        // caller of this runs) but NOT removable: the switch is exhaustive over
        // InboxFilter with no `default:`, so deleting the arm is a type error -
        // and re-adding a `default:` is exactly how a new filter ships as a
        // silent no-op.
        return row.unreadCount > 0;
      case 'unknown':
        // UNREACHABLE since the 2026-08-25 contact-side read (the unknown
        // branch returns before any caller of this runs) but NOT removable,
        // for the same reason as the `'unread'` arm above: the switch is
        // exhaustive over InboxFilter with no `default:`, so deleting the arm
        // is a type error - and re-adding a `default:` is exactly how a new
        // filter ships as a silent no-op.
        return row.needsTriage;
      case 'groups':
        return row.kind === 'group_text';
      case 'all':
        return true;
    }
  };

  /**
   * THE contact row: presentation hydration (latest message, placement label),
   * the deleted-contact resurfacing predicate, and the row literal.
   *
   * EXTRACTED, NEVER FORKED - both read paths call it: the open-partition pager
   * (rowForConversation, below) and the index-backed unread page. That is what
   * stops the two surfaces drifting into rendering the same contact
   * differently.
   *
   * SINGLE-CAUSE RETURN: `undefined` means exactly one thing - resurfacing hid
   * a soft-deleted row. Every other reason to skip a contact belongs to the
   * CALLER (the filter arms, the newest-conversation identity guard, the dedupe
   * set), and each caller records its own dedupe entry when this returns a row
   * (the pager -> emittedContacts; the unread loop -> its seen-set). That is
   * observably identical to adding it here, since the add only ever happened
   * when a row was about to be returned.
   *
   * PHONE/EMAIL COME FROM `maxConv`, not from a caller-iterated conversation.
   * On the pager path those coincide by construction - its identity guard only
   * lets a contact emit while iterating the very conversation `newestOf` chose -
   * so this is byte-identical there; the unread path passes its own hydrated
   * `maxConv`.
   */
  const buildContactRow = async (
    contact: ContactItem,
    convs: ConversationItem[],
    maxConv: ConversationItem,
    unreadSum: number,
    deleted: boolean,
  ): Promise<InboxRow | undefined> => {
    // Recomputed rather than taken as a parameter: `roleFromContact` is a
    // MODULE-LEVEL pure derivation over `contact` alone, and the caller hands us
    // the same contact object it derived its own `role` from, so the two values
    // are identical by construction.
    const role = roleFromContact(contact);
    const phone = maxConv.participant_phone;
    const email = maxConv.participant_email;
    const { channel, direction, preview, createdAt } = await latestMessageOf(maxConv.conversationId, maxConv);
    if (deleted) {
      // Surface ONLY while SOME conversation of this contact is unread AND that
      // conversation's newest message is an inbound from AFTER the deletion.
      // The predicate is PER CONVERSATION, not "unread anywhere + the newest
      // thread looks fresh": a contact owns one thread per participant key, so
      // the unread and the fresh inbound can sit on different threads. Mixing
      // them broke the rule both ways - a pre-deletion unread on thread A kept
      // the row up forever after thread B's fresh inbound was read (single-conv
      // mark-read from a placement/tour pane), and a newer empty/outbound thread
      // buried a genuinely unread fresh inbound on an older one.
      // Pre-deletion unread stays hidden (deleting draws a line); a post-deletion
      // OUTBOUND (e.g. a straggler scheduled send) does not resurface anyone.
      // Absent createdAt (no readable message row) -> never counts as new.
      const isFreshInbound = (dir: 'inbound' | 'outbound', at: string | undefined): boolean =>
        dir === 'inbound' &&
        typeof at === 'string' &&
        typeof contact.deleted_at === 'string' &&
        // CLOCK CAVEAT: created_at is OUR ingest timestamp while message ordering
        // (tsMsgId) uses the PROVIDER timestamp, so clock skew around the delete
        // can momentarily hide a resurfaced row until the next inbound lands.
        at > contact.deleted_at;

      let resurfaces = false;
      for (const c of convs) {
        // Only an unread thread can resurface the row (spec Decision 3), so read
        // threads are never probed.
        if (unreadOf(c) === 0) continue;
        // maxConv's latest is already in hand for presentation - reuse it rather
        // than re-reading the same conversation.
        const latest =
          c.conversationId === maxConv.conversationId
            ? { direction, createdAt }
            : await latestMessageOf(c.conversationId, c);
        if (isFreshInbound(latest.direction, latest.createdAt)) {
          resurfaces = true;
          break; // one qualifying thread is enough
        }
      }
      if (!resurfaces) return undefined;
    }

    let placementContext: { placementId: string; label: string } | undefined;
    if (typeof maxConv.placementId === 'string' && maxConv.placementId.length > 0) {
      const label = await placementLabel(maxConv.placementId);
      if (label !== undefined) placementContext = { placementId: maxConv.placementId, label };
    }

    // A type='unknown' contact IS an untriaged inbound (it just already has a
    // record) - so it needs triage, and it is what the "unknown" filter serves.
    // Keying `needsTriage` off the ROLE (not "no contact record") is what makes
    // BOTH a contact-backed unknown and a contactless number carry the flag,
    // which is still what the `all` and `unread` rows render from.
    //
    // The two are NO LONGER equivalent on the unknown TAB, though: since the
    // 2026-08-25 contact-side read that tab is built from the (type='unknown')
    // contact partition, which cannot see a number with no contact record at
    // all (design class e - the row stays visible and replyable on `all`, it
    // just leaves the triage queue). Do not read this comment as "a contactless
    // number appears under filter=unknown"; it does not.
    // Name fallback when the contact has no resolved name: the formatted phone
    // for a phone thread, else the email address for an email-only thread (never
    // undefined - email-only contacts lack a phone).
    const fallbackLabel =
      phone !== undefined ? (formatPhoneForDisplay(phone) ?? phone) : (email ?? '');
    return {
      kind: 'contact',
      contactId: contact.contactId,
      ...(maxConv.participant_phone !== undefined && { phone: maxConv.participant_phone }),
      name: nameFromContact(contact) ?? fallbackLabel,
      role,
      ...(placementContext !== undefined && { placementContext }),
      unreadCount: unreadSum,
      preview,
      channel,
      direction,
      lastActivityAt: maxConv.last_activity_at,
      needsTriage: role === 'unknown',
      ...(deleted && { deleted: true }),
    };
  };

  /**
   * Build the row for a single raw conversation (or return undefined when this
   * conversation does NOT emit one: a relay_group, an already-emitted contact,
   * or a contact whose newest conversation is elsewhere). Pure of paging — the
   * caller owns the page-fill / boundary bookkeeping.
   *
   * THE OPEN-PARTITION PATH ONLY, and since the 2026-08-25 contact-side read
   * that means `filter=all` ALONE. `filter=unread` returns from its own
   * index-backed branch before the pager runs, and `filter=unknown` now returns
   * from the contact-partition branch, so BOTH sets of arms below are
   * unreachable today - see their comments.
   */
  const rowForConversation = async (conv: ConversationItem): Promise<InboxRow | undefined> => {
    // relay_group threads are emitted by the SEPARATE relay source (relayRowFor
    // via listRelayGroups), never by the contact pager — so skip them here to
    // guarantee they can't be double-counted. group_text threads are the same
    // shape of exclusion and are ALREADY unreachable here (the pager queries the
    // `open` partition and they live in `group_open`); the explicit case is
    // defense-in-depth so this reader can never treat a group as a 1:1.
    if (conv.type === 'relay_group' || conv.type === 'group_text') return dropped('groupKind');

    // Email channel v1 (plan F2/F3 BLOCKER): resolve the contact via
    // participant_phone OR participant_email, so an email-only thread folds into
    // its contact's row (channel 'email') instead of surfacing as a phantom
    // unknown.
    const phone = conv.participant_phone;
    const email = conv.participant_email;
    let contact: ContactItem | undefined;
    try {
      if (phone !== undefined) contact = await contacts.findByPhone(phone);
      if (!contact && email !== undefined) contact = await contacts.findByEmail(email);
    } catch (err) {
      log.warn({ err }, 'inbox: contact lookup failed (best-effort)');
      contact = undefined;
    }

    if (!contact) {
      // No contact. A phoneless conversation (an email thread that resolved to no
      // contact) must NOT render as a phantom unknown-triage row - email unknowns
      // live in the unmatched-email surface only (spec Decision 4). In practice
      // ingestion never creates a contactless email conversation, but be
      // defensive: with no phone there is no unknown identity to show, so skip.
      if (phone === undefined) return dropped('noContactNoPhone');
      // Unread is already carried on the conversation row. A read unknown number
      // cannot pass this filter, so do not fetch a latest message just to reject it.
      // DEAD ARM (spec 4.5): `filter=unread` no longer reaches this function -
      // it returns from the index-backed branch before the pager runs. Kept
      // because `filter` is a runtime value and this is still its right answer.
      if (filter === 'unread' && unreadOf(conv) === 0) return dropped('unreadZeroUnknown');
      // Unknown NUMBER -> an untriaged unknown row, keyed by phone.
      const { channel, direction, preview } = await latestMessageOf(conv.conversationId, conv);
      return {
        kind: 'unknown',
        phone,
        name: formatPhoneForDisplay(phone) ?? phone,
        role: 'unknown',
        unreadCount: unreadOf(conv),
        preview,
        channel,
        direction,
        lastActivityAt: conv.last_activity_at,
        needsTriage: true,
      };
    }

    // Soft-deleted contact → hidden from the inbox EXCEPT while an unread
    // post-deletion inbound exists (deleted-contact resurfacing, 2026-08-03
    // spec): the thread resurfaces with deleted:true until read or restored.
    // findByPhone stays unfiltered for routing, so the decision lives here.
    // A resolved contact's role is enough to reject it from Unknown. Keep this
    // ahead of conversation, message, and placement hydration; only type=unknown
    // contacts can produce a known-contact row for this filter.
    //
    // DEAD ARM since the 2026-08-25 contact-side read, same shape and same
    // reason as the two `filter === 'unread'` arms in this function:
    // `filter=unknown` returns from the contact-partition branch before the
    // pager runs, so this guard can no longer fire. Kept because `filter` is a
    // runtime value and this is still its right answer.
    //
    // FOR THE LOG READER: `unknownFilterRole` is this counter's ONLY site in
    // the file, so it can never appear on an assembled line again. Its absence
    // means the arm is dead, NOT that nothing was rejected.
    //
    // AND THERE IS NO REPLACEMENT COUNTER TO LOOK AT (corrected 2026-08-25,
    // adversarial MED-2 - this used to send you to `unknownQueueRetyped`,
    // which fires NOWHERE: see the guard's own comment on the unknown branch
    // for why it is structurally unreachable). What replaced this rejection is
    // the partition Query itself: listByType('unknown') hashes on `type`, so a
    // non-unknown contact is excluded BY CONSTRUCTION, before any row exists
    // to count. Rejections that used to be visible as a drop count are now
    // invisible because they never happen. If you need to know what the queue
    // read saw, the assembled line's `queueContacts` / `queuePages` are the
    // fields that carry it.
    const role = roleFromContact(contact);
    if (filter === 'unknown' && role !== 'unknown') return dropped('unknownFilterRole');

    const deleted = isDeleted(contact);

    if (emittedContacts.has(contact.contactId)) return dropped('dupContact'); // one row per page
    const convs = await contactConversations(contact);
    const maxConv = newestOf(convs) ?? conv;
    // Represent the contact ONLY at its NEWEST conversation. An older one is
    // skipped — a newer conversation already (or will) emit the row. This is
    // what makes paging split-proof: a contact seen on page 1 (at its newest
    // conv) can never re-emit on page 2 via an older conv.
    // THE IDENTITY GUARD. Counted separately because a stale participant-GSI
    // image can name a DIFFERENT thread as this contact's newest and suppress
    // the row the pager is standing on - the read-side shape of
    // mark-read-fanout-stale-gsi-skip.
    //
    // BUT IT IS NOT DIAGNOSTIC OF THAT ON ITS OWN, and a reader grepping the
    // log must not treat a nonzero count as evidence of GSI lag. It fires
    // routinely on healthy PAGED reads: `emittedContacts` is per-REQUEST, so
    // from page 2 on, every contact whose newest conversation was emitted on an
    // earlier page hits this guard again at its older conversation. Expect it
    // nonzero whenever multi-thread contacts span a page boundary.
    if (maxConv.conversationId !== conv.conversationId) return dropped('notNewestConv');

    const unreadSum = convs.reduce((sum, c) => sum + unreadOf(c), 0);
    // This must use the contact-wide sum, not unreadOf(conv): an older phone or
    // email thread can be unread while the representative newest thread is read.
    // DEAD ARM (spec 4.5), same reason as the unknown-branch arm above.
    if (filter === 'unread' && unreadSum === 0) return dropped('unreadZeroContact');
    // Deleted fast-path: nothing unread -> hidden, no message read needed. NOT
    // dead - it still runs for `all`, which since the 2026-08-26 ruling is the
    // ONLY pager path a soft-deleted contact can resurface on. (`unknown` ran
    // through here too until the 2026-08-25 contact-side read, then through a
    // resurfacing sweep of its own until that ruling deleted it; a soft-deleted
    // contact no longer re-enters the triage queue at all.)
    if (deleted && unreadSum === 0) return dropped('deletedNoUnread');

    const row = await buildContactRow(contact, convs, maxConv, unreadSum, deleted);
    // undefined here means exactly one thing: resurfacing hid a deleted row.
    if (row === undefined) return dropped('resurfaceHidden');
    // The dedupe entry moves CALLER-SIDE with the extraction. It used to sit
    // just above the row literal, which ran iff a row was about to be returned -
    // so this is the same observable behavior at the same moment.
    emittedContacts.add(contact.contactId);
    return row;
  };

  /**
   * Build the relay_group row for one relay conversation. Relay groups are the
   * SECOND row source (queried via listRelayGroups, not the contact pager).
   * Label precedence mirrors the dashboard's GroupTextsCard.groupLabel: other
   * member names -> operator tag -> formatted pool number -> "Relay group".
   *
   * PII: the returned row carries names/preview to the authed client (like the
   * contact rows); log lines stay counts/IDs only.
   */
  const relayRowFor = async (conv: ConversationItem): Promise<InboxRow> => {
    const label = relayThreadLabel(conv);

    const preview =
      typeof conv.last_message_preview === 'string' ? conv.last_message_preview : '';
    // D9: surface the DISTINCT connecting state (never mis-bucket it as open) so
    // the dashboard can render a "Connecting" affordance + queue on the composer.
    const status: 'open' | 'closed' | 'connecting' =
      conv.status === 'closed' ? 'closed' : conv.status === 'connecting' ? 'connecting' : 'open';

    return {
      kind: 'relay_group',
      conversationId: conv.conversationId,
      name: label,
      unreadCount: unreadOf(conv),
      preview,
      lastActivityAt: conv.last_activity_at,
      status,
      owner: getOwner(conv),
      needsTriage: false, // relay rows never need triage (never under the "unknown" filter)
    };
  };

  /**
   * Build the `group_text` row for one native carrier-group conversation. The
   * THIRD row source (queried via listGroupTexts on the group_open partition,
   * never the contact pager and never listRelayGroups).
   *
   * It deliberately does NOT reuse relayRowFor: that builder's status normalizer
   * has an `'open'` CATCH-ALL, so a `group_open` thread run through it would be
   * reported to the dashboard as a plain open relay group - a silent lie (S2
   * T2.6 ruling). A group row carries no status, no owner, and no channel.
   *
   * PII: the row carries names/preview to the authed client (like every other
   * row); log lines stay counts/IDs only.
   */
  const groupRowFor = (conv: ConversationItem): InboxRow => ({
    kind: 'group_text',
    conversationId: conv.conversationId,
    name: groupThreadLabel(conv.participants),
    unreadCount: unreadOf(conv),
    preview: typeof conv.last_message_preview === 'string' ? conv.last_message_preview : '',
    lastActivityAt: conv.last_activity_at,
    // Group rows never need triage: the roster is already resolved to contacts
    // at detection time, so they never appear under the "unknown" filter.
    needsTriage: false,
  });

  /**
   * The group source. Reads the group_open partition ONLY.
   *
   * LOUD BY CONTRACT (spec 4.2): unlike the relay source's best-effort catch, a
   * failed group query is NOT swallowed. "No group threads" and "the group query
   * broke" would be indistinguishable, and the failure mode is every group
   * conversation silently vanishing from the inbox. The repo logs at ERROR and
   * throws; we let it propagate to the route's 500.
   */
  const readGroupSource = async (
    readLimit: number,
    groupCursor?: string,
  ): Promise<{ items: ConversationItem[]; nextCursor?: string; truncated: boolean }> => {
    try {
      return await conversations.listGroupTexts({
        limit: readLimit,
        ...(groupCursor !== undefined && { cursor: groupCursor }),
      });
    } catch (err) {
      if (err instanceof GroupCursorError) {
        // A cursor from another partition (or a tampered one) -> 400, never a
        // silent restart of the walk at the newest row.
        throw new InboxBadRequestError('cursor does not match this filter');
      }
      throw err;
    }
  };

  // --- filter=groups: the group partition IS the feed --------------------------
  // The contact pager does NOT run (spec 11, r3 finding 10) and neither does the
  // relay source: this filter pages the FULL group list through the group
  // partition's own tagged cursor, which is not interchangeable with the
  // 'open'-partition cursor the other filters use.
  if (filter === 'groups') {
    const page = await readGroupSource(limit, cursor);
    const groupRows = page.items.map(groupRowFor);
    log.info(
      {
        filter,
        count: groupRows.length,
        groupCount: groupRows.length,
        hasMore: page.nextCursor !== undefined,
      },
      'inbox feed assembled',
    );
    return {
      rows: groupRows,
      nextCursor: page.nextCursor ?? null,
      // Here `truncated` can only mean the repo's walk budget stopped early -
      // the caller's limit produces a nextCursor instead.
      ...(page.truncated && { groupsTruncated: true }),
    };
  }

  // --- filter=unread: the sparse byUnread index IS the feed --------------------
  // A SINGLE unified stream (spec 4.5): contacts, unknown numbers, relay groups
  // and native group threads all come from ONE index walk, newest-first, up to
  // `limit` rows TOTAL - so nothing below this point runs under this filter.
  // That is what makes "skip the relay merge", "skip the group source" and
  // "groupsTruncated is never set under unread" structural facts rather than
  // three more conditionals: the open-partition pager and both merge blocks are
  // simply out of reach. This branch keeps its OWN cursor state and never reads
  // or writes `startKey`, which stays the page-one sentinel for filter=all.
  if (filter === 'unread') {
    const resume = cursor !== undefined ? decodeUnreadCursor(cursor) : undefined;
    // THE SEEN-SET: every contact emitted as a candidate on this page or any
    // prior one. Suppression is pure set membership - no ordering comparison, no
    // re-read of a contact's threads - so it is deterministic under
    // last_activity_at ties. It ACCUMULATES across the fill loop's iterations
    // too: without that, iteration 2 re-emits a contact iteration 1 already
    // emitted, which is a duplicate React key on one page.
    const seen = new Set<string>(resume?.s ?? []);
    let scanPosition: UnreadScanPosition | undefined =
      resume === undefined ? undefined : { lastActivityAt: resume.a, conversationId: resume.c };
    // ONE raw-scan budget for the whole REQUEST (spec 4.3), threaded into and
    // back out of every collect. `unreadWalkLimit` is the deps test seam.
    const startingBudget = deps.unreadWalkLimit ?? UNREAD_WALK_LIMIT;
    let remainingBudget = startingBudget;
    // Both tripwires are REQUEST-level: this loop makes MANY collects, and a
    // per-collect threshold could never fire for a request that spent a little
    // in each of many of them.
    let deletedProbes = 0;
    // The WASTED half of that total is a BUDGET, not just a statistic: it is
    // threaded into every collect (like `remainingBudget`) so the probe bound
    // is per REQUEST. `deletedSkipped` is what the bound refused to read, and
    // it makes this page's answer a floor.
    let wastedProbes = 0;
    let deletedSkipped = 0;
    const unreadRows: InboxRow[] = [];
    let consumedAll = false;
    let budgetSpent = false;
    /**
     * Candidates hydration dropped on a LAGGING read (see `Hydrated` below),
     * held for one retry once the rest of the request's reads are done.
     *
     * CONTACT candidates only, and the TYPE says so rather than a guard in the
     * retry loop (adversarial r3 finding 8): `lagged: true` is returned from
     * the contact arm alone - both non-contact returns are hard-coded
     * `lagged: false` - so a non-contact lag is not a modelled state.
     */
    const laggedDrops: Extract<UnreadCandidate, { kind: 'contact' }>[] = [];

    /**
     * The outcome of hydrating ONE candidate. A drop carries WHY, because the
     * two reasons are not the same fact (adversarial r2 finding 4):
     *
     * - `lagged: false` - the fresh, authoritative read says this row is read
     *   or gone. The index entry is simply stale; dropping is CORRECT and the
     *   page reached a genuine end. This is the ordinary mark-read race.
     * - `lagged: true` - the fresh read does not know about the thread the
     *   index just offered at all. Nothing here is authoritative, the row is
     *   probably real, and the badge is certainly still counting it.
     *
     * Only the second kind may claim the page ended early, or the client's
     * `serverRowCount === 0 && truncated` gate would render the inbox ERROR
     * state at the end of an ordinary, successful triage session - exactly the
     * regression conformance C2 fixed.
     */
    type Hydrated = { row: InboxRow } | { row: undefined; lagged: boolean };

    /** Turn ONE candidate into a row, or drop it (spec 4.5 hydration). */
    const hydrateUnread = async (candidate: UnreadCandidate): Promise<Hydrated> => {
      if (candidate.kind === 'contact') {
        // The freshest available sources, per-request cached exactly as the
        // pager's are. They resolve via the participant GSIs, which lag
        // INDEPENDENTLY of byUnread (spec 6) - hence the drop below.
        const convs = await contactConversations(candidate.contact);
        const unreadSum = convs.reduce((sum, c) => sum + unreadOf(c), 0);
        const maxConv = newestOf(convs);
        // A fresh sum of 0 DROPS the row - today's passesFilter contract, moved
        // to hydration. (A zero sum is also the only way `convs` can be empty,
        // so the maxConv guard is belt-and-braces for the type.)
        if (unreadSum === 0 || maxConv === undefined) {
          // LAG, or a real read? Discriminate with ONE AUTHORITATIVE BASE-TABLE
          // READ of the thread the index just offered - the same point read the
          // non-contact arm below already trusts (adversarial r3 finding 1).
          //
          // The fix-wave-2 discriminator asked instead whether the offered
          // thread was ABSENT from the fresh participant set, and that is the
          // wrong question: a GSI replicates the whole projected ITEM, so the
          // window where byUnread carries the increment and byParticipantPhone
          // does not shows the thread PRESENT with its PRE-increment
          // `unread_count: 0`. Membership absence needs a conversation that did
          // not exist a moment ago, which resolves to no contact and takes the
          // `unknown` branch. So the dominant lag shape was classified
          // authoritative: never retried, and not even flagged.
          //
          // THE OFFERED THREAD IS `unreadConversations[0]` (conformance r3
          // finding 6): the collector emits a contact candidate AT its first
          // offered thread and only merges later threads onto it, so [0] IS the
          // thread whose index entry produced this candidate.
          const offered = candidate.unreadConversations[0]?.conversationId;
          if (offered === undefined) return { row: undefined, lagged: false };
          // BEST-EFFORT, like every other external read in this module (header:
          // "NEVER throws a 500"). A failed point read cannot prove lag, so it
          // classifies as NOT lag: drop, no retry, page served (adversarial r4
          // finding 5 / conformance r4 finding 3 - the earlier "deliberately
          // uncaught" posture contradicted the module contract).
          let base: ConversationItem | undefined;
          try {
            base = await conversations.getById(offered);
          } catch (err) {
            log.warn({ err, conversationId: offered }, 'inbox: lag discriminator read failed (best-effort)');
            return { row: undefined, lagged: false };
          }
          // Base says still unread -> the participant image is behind, the 0 is
          // a missing question, and a retry can learn something. Base says read,
          // closed or gone -> an ORDINARY mark-read race (or a closed thread the
          // index has not caught up with, conformance r3 finding 7): dropping is
          // CORRECT and the page reached a genuine end.
          return { row: undefined, lagged: base !== undefined && isUnreadVisible(base) };
        }
        // NOTE the newest-conversation IDENTITY GUARD is deliberately ABSENT
        // here: row identity is the seen-set, and `newestOf` picks only the
        // REPRESENTATION (phone / lastActivityAt / placement / latest-message
        // source). A contact whose newest thread is READ and whose older thread
        // is unread MUST render - carrying the guard over would drop it.
        const built = await buildContactRow(
          candidate.contact,
          convs,
          maxConv,
          unreadSum,
          isDeleted(candidate.contact),
        );
        // The only drop left in there is the deleted-contact resurfacing RULE,
        // decided against fresh message reads: an answer, not a lag.
        return built === undefined ? { row: undefined, lagged: false } : { row: built };
      }

      // Every non-contact candidate maps onto exactly ONE index item, so a
      // single point read (an eventually-consistent base-table GetItem,
      // typically fresher than any GSI - ConsistentRead deliberately not used)
      // refreshes status + unread_count. A row the index still lists but the
      // base table reports read or closed is dropped right here.
      // BEST-EFFORT (module header: every external lookup degrades, never a
      // 500): a failed point read drops the row for this page and the next
      // reconcile refetch re-offers it. See the contact arm's twin above.
      let fresh: ConversationItem | undefined;
      try {
        fresh = await conversations.getById(candidate.conversation.conversationId);
      } catch (err) {
        log.warn(
          { err, conversationId: candidate.conversation.conversationId },
          'inbox: unread point read failed (best-effort)',
        );
        return { row: undefined, lagged: false };
      }
      // A base-table point read IS authoritative, so this drop is never "lag":
      // there is nothing a retry could learn.
      if (fresh === undefined || !isUnreadVisible(fresh)) return { row: undefined, lagged: false };
      if (candidate.kind !== 'unknown') {
        // The two multi-party kinds reuse the pager's builders verbatim.
        // groupRowFor is deliberately NOT relayRowFor: that one's status
        // normalizer has an 'open' catch-all, which would report a group_open
        // thread to the dashboard as a plain open relay group.
        return {
          row: candidate.kind === 'relay_group' ? await relayRowFor(fresh) : groupRowFor(fresh),
        };
      }
      // The unknown-number row, built inline rather than extracted: the pager's
      // literal reads its driving conversation directly, and ~10 duplicated
      // lines are cheaper than a second parameterized helper (plan round 4).
      const { channel, direction, preview } = await latestMessageOf(fresh.conversationId, fresh);
      return {
        row: {
          kind: 'unknown',
          phone: candidate.phone,
          name: formatPhoneForDisplay(candidate.phone) ?? candidate.phone,
          role: 'unknown',
          unreadCount: unreadOf(fresh),
          preview,
          channel,
          direction,
          lastActivityAt: fresh.last_activity_at,
          needsTriage: true,
        },
      };
    };

    // FILL-OR-EXHAUST (spec 4.5 step 1) - the same invariant the open-partition
    // pager provides: collect -> hydrate -> drop -> refill, until the page is
    // full, the SUPPLY runs out, or the request budget does. It TERMINATES
    // because the only non-breaking outcome is `capped`, which by definition
    // consumed at least one raw item, so `remainingBudget` strictly decreases.
    for (;;) {
      const collected = await collectUnreadRows(
        { conversations, contacts, messages, logger: log },
        {
          maxRows: limit - unreadRows.length,
          budget: remainingBudget,
          ...(scanPosition !== undefined && { startAfter: scanPosition }),
          excludeContactIds: seen,
          wastedProbesBefore: wastedProbes,
        },
      );
      deletedProbes += collected.deletedProbes;
      wastedProbes += collected.wastedProbes;
      deletedSkipped += collected.skippedDeletedThreads;
      remainingBudget = collected.remainingBudget;
      if (collected.scanPosition !== undefined) scanPosition = collected.scanPosition;

      for (const candidate of collected.candidates) {
        const hydrated = await hydrateUnread(candidate);
        if (hydrated.row === undefined) {
          // Held for ONE retry after the loop (adversarial r2 finding 4). A
          // lag-dropped candidate is NOT re-offered by any later collect -
          // `scanPosition` is already past its index item - so this is the last
          // chance the request has to deliver it. The `kind` test is what TYPES
          // the list; it is not a guard against a state the arms can produce.
          if (hydrated.lagged && candidate.kind === 'contact') laggedDrops.push(candidate);
          continue;
        }
        const row = hydrated.row;
        // The seen-set records EMITTED contacts ONLY (spec 4.5 step 1, amended
        // in review fix wave 1 - adversarial A3). Adding a DROPPED candidate
        // suppressed it for the rest of the paging session, and the drop's own
        // cause is a lagging participant GSI: the badge, which never hydrates,
        // kept counting a row no page could ever show. Within-page duplication
        // is not what this set defends - `scanPosition` advances past every
        // consumed item, so a collect never re-offers one - it defends
        // CROSS-PAGE and cross-iteration re-emission of a contact whose OLDER
        // thread is still ahead in the index.
        if (candidate.kind === 'contact') seen.add(candidate.contactId);
        unreadRows.push(row);
      }

      if (unreadRows.length >= limit) break; // page full
      if (collected.consumedAll) {
        consumedAll = true;
        break;
      }
      if (collected.truncated || remainingBudget === 0) {
        budgetSpent = true;
        break;
      }
      // Otherwise the collect stopped at its cap and hydration dropped rows -
      // go again from the new scan position to refill the page.
    }

    // THE ONE DROP-AWARE RETRY (adversarial r2 finding 4). A candidate dropped
    // because the participant GSI had not caught up is unreachable afterwards:
    // it is not in the seen-set (fix wave 1 stopped suppressing it), but
    // `scanPosition` is past its only index item, so no later page re-offers it
    // either - while the badge, which never hydrates, keeps counting it.
    //
    // Retrying LAST is the point: every other read in the request has happened
    // since, which is the settling time a lagging GSI usually needs. Exactly
    // once, and only for the lag-shaped drops, so an ordinary mark-read race
    // costs nothing extra. The per-request cache is dropped for those contacts,
    // or the retry would re-read its own first answer.
    //
    // AND IT IS BOUNDED, at the page `limit` (adversarial r3 finding 4 /
    // conformance r3 finding 2). Every retry costs a fresh
    // `conversationsForContact` - one or more participant-GSI Queries - and a
    // lagging or DEGRADED participant GSI (a thrown lookup degrades to an empty
    // set, which reads as a fresh sum of 0) makes EVERY candidate a lag-shaped
    // drop, so an unbounded retry doubles the reads of a page that returns
    // nothing. `limit` is the natural bound: a retry that could not fit on the
    // page is counted `unresolvedDrops` anyway.
    let unresolvedDrops = 0;
    let laggedRetries = 0;
    for (const candidate of laggedDrops) contactConvsCache.delete(candidate.contactId);
    for (const candidate of laggedDrops) {
      if (seen.has(candidate.contactId)) continue; // emitted later
      if (unreadRows.length >= limit || laggedRetries >= limit) {
        // No room on the page, or the retry budget is spent. The row is still
        // lost for this paging session, so it counts as unresolved rather than
        // being quietly forgotten.
        unresolvedDrops += 1;
        continue;
      }
      laggedRetries += 1;
      const hydrated = await hydrateUnread(candidate);
      if (hydrated.row === undefined) {
        unresolvedDrops += 1;
        continue;
      }
      seen.add(candidate.contactId);
      unreadRows.push(hydrated.row);
    }

    // Both tripwires fire ONCE, on the REQUEST total. The scanned total is
    // exactly `startingBudget - remainingBudget` because ONE budget is threaded
    // through every collect; the in-collector WARN is per-walk and would miss a
    // request that scanned 200 in each of three collects.
    warnDeletedProbes(log, {
      probes: deletedProbes,
      wasted: wastedProbes,
      skipped: deletedSkipped,
    });
    warnUnreadScanned(log, startingBudget - remainingBudget);

    // Rows sort by DISPLAYED lastActivityAt, as every other filter does. The
    // stream ordered them by newest UNREAD activity, and for a multi-thread
    // contact whose newest thread is read the two differ - spec 4.5's declared
    // ordering nuance.
    unreadRows.sort((a, b) =>
      a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0,
    );

    // nextCursor keys on CONSUMPTION, never on scan state (spec 4.5 step 2);
    // `truncated` names a NON-NATURAL end (step 3).
    let unreadCursor: string | null = null;
    let truncated = false;
    if (scanPosition === undefined) {
      // Nothing consumed at all (an empty index, or a cursor already past the
      // end): no position to resume from. Whether anything was WITHHELD is a
      // separate question - `budgetSpent` answers it (conformance N3). Consuming
      // nothing while the budget died first is a real early end (a
      // queryUnreadPage returning an empty page WITH a LastEvaluatedKey gets
      // here in production; the unreadWalkLimit seam gets here in tests), and
      // reporting it as a NATURAL end made a feed with unread behind it render
      // "You're all caught up" - the exact silent-zero this branch's siblings
      // exist to prevent.
      unreadCursor = null;
      truncated = budgetSpent;
    } else if (consumedAll) {
      // THE NATURAL END, checked FIRST: the supply ran out, so nothing was
      // withheld and `truncated` must stay off (spec 4.5 step 3 defines it as a
      // NON-NATURAL end). This branch outranks the depth cap on purpose. The cap
      // ordered first fired on every consumedAll page past SEEN_SET_MAX ids, so
      // a correct - even EMPTY - final unread page claimed an early end, and an
      // empty one rendered the inbox failure state on a tab that was genuinely
      // caught up (conformance finding 1).
      unreadCursor = null;
    } else if (seen.size > SEEN_SET_MAX) {
      // THE DEPTH CAP, and now only when rows really are behind it: past this
      // many ids the server can no longer mint a cursor it would itself accept,
      // so paging is over while supply remains - and round 4's rule is that the
      // cap must never be the one early-end path carrying no signal.
      truncated = true;
    } else if (budgetSpent) {
      truncated = true;
      // ...AND STILL MINT THE CURSOR (spec 4.5 step 2, amended in review fix
      // wave 1 - conformance C1). Step 2 enumerates exactly TWO null-cursor
      // conditions, and a budget-expired page is neither: it has a known
      // position and a seen-set inside the cap. Returning null discarded a
      // scanPosition the request had already paid for, so the only forward
      // affordance left was Retry - which re-runs the identical prefix with a
      // fresh budget and truncates identically. `truncated` is a SIGNAL layered
      // ON paging, not a replacement for it. The empty-page invariant below
      // still nulls this out when no rows survived.
      unreadCursor = encodeUnreadCursor(scanPosition, seen);
    } else {
      unreadCursor = encodeUnreadCursor(scanPosition, seen);
    }
    // NOTE what is deliberately NOT here (fix wave 3, adversarial r3 finding 2):
    // `deletedSkipped > 0` no longer forces `truncated`. Threads the probe bound
    // called hidden without reading them do NOT make a DRAINED walk an early
    // end - the assumption past the bound is "hidden", which is what an empty
    // page already means, and forcing the flag turned a residue-only, genuinely
    // caught-up org into a permanent inbox failure banner. The collector's own
    // `truncated` (a stopped walk) still arrives through `budgetSpent` above,
    // and the deleted-probe WARN carries the skipped depth to the operator.
    //
    // A row this request KNOWS it could not deliver IS still a floor (adversarial
    // r2 finding 4). The page must not report a natural end while the badge
    // counts a row no page in this session can show; `truncated` is the one
    // honest name for "we may disagree with the badge".
    if (unresolvedDrops > 0) truncated = true;
    // INVARIANT (spec 4.5 step 2): an empty rows array implies a null cursor -
    // the dashboard's empty-state and Load-more gating both key on rows.length.
    // This is LOAD-BEARING for the budget branch above (which mints a cursor
    // unconditionally); for every other exit it is the defensive belt that
    // keeps the invariant true if the loop ever grows another one. An empty
    // truncated page keeps its error-state posture rather than offering a Load
    // more the client has nothing to hang off.
    if (unreadRows.length === 0) unreadCursor = null;

    log.info(
      {
        filter,
        count: unreadRows.length,
        scanned: startingBudget - remainingBudget,
        seen: seen.size,
        hasMore: unreadCursor !== null,
        ...(truncated && { truncated: true }),
        // THE RETRY VOLUME, on the REQUEST-level line (adversarial r3 finding
        // 4 asked for the request's WARN payload; the retry is now hard-capped
        // at `limit`, so it is a per-request STATISTIC rather than a tripwire,
        // and this is the line that already carries scanned/seen/truncated).
        // Always present when nonzero, so the pair "the badge counts rows this
        // page could not deliver" is readable without a second request.
        ...(laggedRetries > 0 && { laggedRetries }),
        ...(unresolvedDrops > 0 && { unresolvedDrops }),
      },
      'inbox feed assembled',
    );
    return {
      rows: unreadRows,
      nextCursor: unreadCursor,
      ...(truncated && { truncated: true as const }),
    };
  }

  // --- filter=unknown: the triage partition IS the feed (design 2026-08-25) --
  // The old read walked the ENTIRE open partition and paid one contact lookup
  // per conversation to find a handful of triage rows (~684 lookups across 24
  // Queries for at most 8 rows, measured in prod). This read queries the
  // (type='unknown') byTypeStatus partition and pays per row COLLECTED -
  // bounded by UNKNOWN_QUEUE_MAX_ROWS, NOT by the `limit` the caller asked
  // for. (Corrected 2026-08-25, adversarial MED-4: this said "per row
  // RETURNED", which is off by the whole cap. Hydration runs inside the loop
  // over queue.contacts below, while the window `slice(0, limit)` happens
  // AFTER the sort - so a cap-full queue hydrates up to 200 rows serially to
  // render 30.)
  //
  // ONLY THE THREAD RESOLUTION HAS TO PRECEDE THE SORT (corrected again
  // 2026-08-25, round-2 finding N1). This block used to add "that ordering is
  // REQUIRED ... the sort key is the hydrated activity, so the window cannot
  // be applied before the rows exist", which is FALSE and told the next reader
  // a real saving did not exist. The sort key is `row.lastActivityAt`, which
  // buildContactRow copies verbatim from `maxConv.last_activity_at` - a
  // CONVERSATION field, produced by resolveOpenThreads. `latestMessageOf`
  // (channel/direction/preview) and `placementLabel` are PRESENTATION ONLY and
  // are not sort inputs, so on this deleted=false path they could move AFTER
  // `slice(0, limit)`.
  //
  // KNOWINGLY DEFERRED, not impossible: at the cap that is up to 200 message
  // reads and up to 200 placement reads to render 30 rows - roughly 340
  // discarded serial round trips. Taking it is a PERFORMANCE change with its
  // own test surface (nothing on this branch pins the hydration count), and
  // this branch's fix waves are chartered not to move behaviour. Recorded as a
  // deferral in docs/issues/inbox-filter-tabs-full-walk.md.
  //
  // (This block used to carve out an exception for the resurfacing sweep,
  // where `latestMessageOf` WAS a visibility predicate rather than
  // presentation. The sweep was deleted 2026-08-26, so the branch now has one
  // hydration path and the caveat is gone with it.)
  //
  // The
  // coverage decisions - what each class of row does under the new source -
  // are section 3 of docs/superpowers/specs/
  // 2026-08-25-inbox-unknown-tab-walk-design.md; the parity suite
  // (test/inboxUnknownParity.test.ts) pins them one by one.
  if (filter === 'unknown') {
    // The unknown feed is a single sorted window over a bounded queue: it
    // MINTS no cursor, so any cursor here is foreign (another filter's, or
    // tampered). 400, never a wrong-partition Query - the same namespacing
    // posture every other filter takes.
    if (cursor !== undefined) {
      throw new InboxBadRequestError('cursor does not match this filter');
    }

    // LOUD BY CONTRACT, like the group source (readGroupSource above): the
    // module norm is best-effort hydration, but a failed triage-partition
    // Query is NOT swallowed - "no unknown contacts" and "the query broke"
    // must not be indistinguishable, because the failure mode is the entire
    // triage queue silently vanishing behind a healthy-looking empty state.
    // collectUnknownTriageQueue does not catch; the throw propagates to the
    // route's 500.
    const queue = await collectUnknownTriageQueue(
      { contacts, logger: log },
      {
        pageSize: deps.unknownQueuePageSize ?? UNKNOWN_QUEUE_PAGE_SIZE,
        maxPages: deps.unknownQueueMaxPages ?? UNKNOWN_QUEUE_MAX_PAGES,
        maxRows: deps.unknownQueueMaxRows ?? UNKNOWN_QUEUE_MAX_ROWS,
      },
    );

    let threadReadFailures = 0;
    /**
     * Requirement 4: "query threw" and "filtered to nothing" must be different
     * CODE PATHS. This calls conversationsForContact DIRECTLY - NOT the
     * best-effort contactConversations seam above, which catches and returns
     * [] for both - and catches locally: a failure withholds ONE row loudly
     * (WARN + its own drop counter) instead of 500ing the whole tab or
     * silently shrinking a triage queue. `undefined` = threw; `[]` = the
     * contact genuinely has no open non-relay thread.
     */
    const resolveOpenThreads = async (
      contact: ContactItem,
    ): Promise<ConversationItem[] | undefined> => {
      try {
        const all = await conversationsForContact(contact, conversations);
        return all.filter((c) => c.status === 'open' && c.type !== 'relay_group');
      } catch (err) {
        threadReadFailures += 1;
        dropped('unknownThreadReadFailed');
        log.warn(
          { err, contactId: contact.contactId },
          'inbox: unknown-queue thread read FAILED - a triage row is withheld from this page',
        );
        return undefined;
      }
    };

    const emitted = new Set<string>();
    const unknownRows: InboxRow[] = [];

    for (const contact of queue.contacts) {
      // UNREACHABLE FROM A REAL QUERY - a belt, not a check (corrected
      // 2026-08-25, adversarial MED-2). The precedent's STATUS re-check does
      // not carry over (the query no longer narrows on status - class f), and
      // this was presented as its honest replacement. It is not one:
      // listByType('unknown') Queries the index whose HASH KEY IS `type`, so
      // every item it can return carries type === 'unknown' by construction,
      // and roleFromContact reads that same attribute off that same image.
      // The stale-index case this was written for FAILS to fire too: a retype
      // race leaves the OLD index entry under type='unknown' with its
      // projected `type` stale in lockstep with its key - i.e. still 'unknown'.
      // So `unknownQueueRetyped` cannot appear on a real log line.
      //
      // KEPT anyway, cheaply: it would matter if a second type were ever
      // mapped 'queried' in UNKNOWN_TAB_TYPE_DECISIONS, or if this loop were
      // ever handed contacts from somewhere other than a byTypeStatus Query
      // (the base table, a BatchGet, a future caller). It costs one predicate
      // per collected row.
      //
      // What ACTUALLY replaced the old roleFromContact rejection is the
      // partition Query itself, which excludes non-unknown contacts silently
      // and by construction, with no counter. team_member in particular falls
      // THROUGH roleFromContact to 'unknown' but can never be returned by
      // listByType('unknown') at all (class c ruling, 2026-08-25: internal
      // staff are not triage).
      if (roleFromContact(contact) !== 'unknown') {
        dropped('unknownQueueRetyped');
        continue;
      }
      // ONE ROW PER CONTACT (round-2 finding N5). It landed alongside the
      // resurfacing sweep, which carried the same check, and this loop only
      // ADDED to `emitted` without ever consulting it. The sweep is gone
      // (2026-08-26 ruling, below), but this guard is NOT its leftover: it
      // protects the PARTITION read against the mid-walk status flip described
      // next, which has nothing to do with resurfacing. It has its own
      // regression test (test/inboxUnknownTab.test.ts, "a DUPLICATED queue
      // item ships ONE row").
      //
      // NARROW, and stated honestly rather than dressed up: a Query resuming
      // from an ExclusiveStartKey cannot re-serve an item unless that item's
      // INDEX KEY MOVED, and `status` IS this index's range key - so a contact
      // flipped 'active' -> 'needs_review' between two pages of the SAME walk
      // moves FORWARD past the cursor and is collected twice. That needs a
      // multi-page walk (>UNKNOWN_QUEUE_PAGE_SIZE unknown contacts) AND a write
      // landing between two sequential Queries; it is not a state anyone hits
      // this week. The mirror flip ('needs_review' -> 'active') moves the row
      // BACKWARD and silently skips it, which no guard here can see.
      //
      // Cheap insurance against a user-visible symptom: the dashboard keys the
      // wire row by contactId (useInbox `rowKey` -> `c:<contactId>`), so a
      // duplicate ships a doubled row under a duplicate React key.
      if (emitted.has(contact.contactId)) continue;
      const open = await resolveOpenThreads(contact);
      if (open === undefined) continue; // threw - counted and WARNed above
      const maxConv = newestOf(open);
      // No open non-relay thread -> no row: threadless group-detection stubs
      // (class a - which is also why excludeOrigin buys nothing here) and
      // contacts whose only thread is relay or closed (class b).
      if (maxConv === undefined) {
        dropped('unknownNoOpenThread');
        continue;
      }
      const unreadSum = open.reduce((sum, c) => sum + unreadOf(c), 0);
      const row = await buildContactRow(contact, open, maxConv, unreadSum, false);
      // Unreachable with deleted=false (buildContactRow's single-cause
      // return); kept as the belt so a future deleted-path change here cannot
      // silently drop rows.
      if (row === undefined) {
        dropped('resurfaceHidden');
        continue;
      }
      emitted.add(contact.contactId);
      unknownRows.push(row);
    }

    // CLASS D - A SOFT-DELETED UNKNOWN DOES NOT RE-ENTER THIS QUEUE (human
    // ruling 2026-08-26). listByType's `deleted` option is a TRI-STATE with no
    // "both", so soft-deleted unknowns cannot come from the partition read
    // above, and until this ruling the branch bought them back with a
    // resurfacing sweep: ONE collectUnreadRows walk over the byUnread index,
    // up to UNREAD_WALK_LIMIT (2000) raw items and one contact lookup per
    // visible item, on EVERY Unknown page load - and re-paid on every
    // debounced refetch, because useInbox refetches the current filter on
    // incoming messages. That is deleted.
    //
    // THE PRODUCT REASON, which is the durable one: a contact you deliberately
    // deleted is one you have ALREADY TRIAGED - you decided it was spam.
    // Putting it back into the queue of "people I have not identified yet" is
    // the wrong behaviour. The message still needs attention, and that is what
    // the All and Unread tabs are for.
    //
    // THE REQUIREMENT IS STILL MET, and it is pinned rather than asserted.
    // What the product needs is that the CONVERSATION resurfaces in the inbox,
    // not that the CONTACT reappears here, and both halves already hold with
    // no sweep: the `all` pager runs buildContactRow's resurfacing predicate
    // (see its `deleted` block above) and so does the unread branch, and
    // GET /api/contacts/:contactId does not 404 a soft-deleted contact, so the
    // row opens normally when clicked. test/inboxUnknownParity.test.ts class
    // (d) asserts the `all` half in the same world as the absence here - if
    // that ever goes red, this deletion's premise is wrong.

    // Requirement 2: the whole KEPT queue, sorted in memory, newest first -
    // the byTypeStatus index has no activity dimension, so index-order paging
    // would yield globally out-of-order pages. TWO different cuts can hide
    // rows, and they are NOT the same claim.
    //
    // 1. This WINDOW cut (below) really is newest-first, so what it hides is
    //    the older tail.
    // 2. The COLLECTOR's cap/page-budget cut (already WARNed inside
    //    collectUnknownTriageQueue) is in STATUS-ASCENDING order. Corrected
    //    2026-08-25 (adversarial HIGH-1) - this used to call it "arbitrary
    //    with respect to recency", which is both wrong and reassuring.
    //    byTypeStatus's RANGE KEY is `status` and contactsRepo.listByType sets
    //    no `ScanIndexForward` (contactsRepo.ts:1009-1020), so the Query
    //    ascends it; within type='unknown' the legal statuses are
    //    'needs_review' and 'active', and 'active' < 'needs_review'. So past
    //    UNKNOWN_QUEUE_MAX_ROWS the hidden rows are not a random slice - they
    //    are DETERMINISTICALLY the `needs_review` ones, the contacts nobody
    //    has looked at, however recent their inbound. Stable order means the
    //    same rows are hidden on every render.
    //
    //    NOT MITIGATED HERE, deliberately: the fix is a
    //    `ScanIndexForward: false` option on the repo read, and listByType is
    //    a SHARED read that today.ts's triage block also uses - reversing it
    //    is a repo-wide change and the human's call. Reopen point:
    //    docs/issues/inbox-filter-tabs-full-walk.md. Pinned as a fact by
    //    test/unknownQueue.test.ts ("THE CAP STARVES needs_review").
    //
    // The sort orders what SURVIVED; it cannot repair what the collector never
    // read.
    unknownRows.sort((a, b) =>
      a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0,
    );
    // The response window is the wire limit (route-clamped, dashboard sends
    // 30). Rows past it are NOT silently gone: the WARN below names the count,
    // and - for THIS cut only, see above - the remainder becomes reachable as
    // rows are RE-TYPED away.
    //
    // RE-TYPED, not merely triaged (corrected 2026-08-25, adversarial MED-3:
    // this used to say "triage drains the queue newest-first", which is the
    // justification for shipping no cursor and is only half true). PATCH
    // /api/contacts/:id supports a STATUS-ONLY triage - see the block on
    // NOT-COPIED status in lib/unknownQueue.ts - so an operator can mark an
    // unknown contact `active` and it stays type='unknown' and stays in this
    // queue forever. Worse, per the ordering note above, `active` sorts FIRST,
    // so a status-only triage PROMOTES that row to the front of the collector's
    // read and crowds out rows nobody has reviewed. Only a TYPE change - to any
    // other ContactType, team_member included - or a SOFT-DELETE actually
    // drains a row (completed 2026-08-25, round 2: this said "a type change (to
    // tenant/landlord/partner)", which omits both). Until one of those happens
    // the rows past `limit` have no affordance that reaches them. No cursor - an
    // offset page over a mutating in-memory sort
    // re-serves and skips rows, and the design settled on cap-plus-WARN
    // (requirement 2). The affordance gap is recorded in
    // docs/issues/inbox-filter-tabs-full-walk.md.
    const windowed = unknownRows.slice(0, limit);
    if (windowed.length < unknownRows.length) {
      log.warn(
        { shown: windowed.length, assembled: unknownRows.length, limit },
        'inbox: the unknown tab could not show every triage row - the queue is a floor',
      );
    }

    log.info(
      {
        filter,
        count: windowed.length,
        queueContacts: queue.contacts.length,
        queuePages: queue.pagesWalked,
        ...(queue.truncated && { queueTruncated: true }),
        ...(threadReadFailures > 0 && { threadReadFailures }),
        ...(Object.keys(drops).length > 0 && { drops }),
      },
      'inbox feed assembled',
    );
    // NEVER the `truncated` wire flag here: that field is the unread branch's
    // contract (see InboxPage.truncated), and an empty page carrying it
    // renders the dashboard's FAILURE banner - on a tab whose NORMAL state is
    // an empty, cleared queue (design requirement 5). Truncation on this
    // branch is a WARN, by design.
    return { rows: windowed, nextCursor: null };
  }

  const rows: InboxRow[] = [];
  let nextCursor: string | null = null;
  // The resume key for the CURRENT fetch batch (the cursor passed in, then each
  // batch's terminal LEK). A batch is a raw byLastActivity Query of chunkSize
  // conversations; its LEK is the EXACT boundary after the batch's last
  // conversation. We never break a page mid-batch WITHOUT recovering the precise
  // boundary (see the re-query below), so the emitted cursor always resumes
  // exactly after the conversation that filled the page — no rows skipped, none
  // double-served.
  let chunkStartKey: Record<string, unknown> | undefined = startKey;

  // The page is `limit` CONTACT rows, but each row can consume several raw
  // conversations (multi-number contacts, relay-skips, filter-drops), so we pull
  // batches until the page fills or the stream is exhausted. chunkSize is the
  // raw conversations per Query: at least the page size (so a page of all-1:1
  // contacts fills in one Query), capped at FETCH_BATCH.
  const chunkSize = Math.min(FETCH_BATCH, Math.max(limit, DEFAULT_INBOX_LIMIT));

  pager: for (;;) {
    const chunk = await conversations.listByLastActivity({
      status: 'open',
      limit: chunkSize,
      ...(chunkStartKey !== undefined && { exclusiveStartKey: chunkStartKey }),
    });
    const chunkStartKeyForThisChunk = chunkStartKey;
    const moreChunks = chunk.lastEvaluatedKey !== undefined;
    // Counted BEFORE assembly, so a zero-row page says which world it is in:
    // rawScanned 0 means the byLastActivity 'open' partition itself answered
    // empty; rawScanned > 0 with count 0 means assembly consumed every row, and
    // `drops` names the guard that did it.
    rawQueries += 1;
    rawScanned += chunk.items.length;

    for (let i = 0; i < chunk.items.length; i++) {
      const conv = chunk.items[i]!;
      const row = await rowForConversation(conv);
      if (row === undefined) continue;
      if (!passesFilter(row)) {
        drops['filtered'] = (drops['filtered'] ?? 0) + 1;
        continue;
      }
      rows.push(row);
      if (rows.length === limit) {
        // Page full at chunk index i. The resume boundary is the LEK AFTER this
        // conversation. When it's the chunk's LAST consumed conversation, that's
        // the chunk LEK; otherwise re-query exactly (i+1) conversations from this
        // chunk's start key to recover the precise per-conversation boundary —
        // ONE extra Query, only when a page fills mid-chunk.
        let boundaryKey: Record<string, unknown> | undefined;
        if (i === chunk.items.length - 1) {
          boundaryKey = chunk.lastEvaluatedKey;
        } else {
          const boundary = await conversations.listByLastActivity({
            status: 'open',
            limit: i + 1,
            ...(chunkStartKeyForThisChunk !== undefined && {
              exclusiveStartKey: chunkStartKeyForThisChunk,
            }),
          });
          boundaryKey = boundary.lastEvaluatedKey;
        }
        nextCursor = boundaryKey !== undefined ? encodeCursor(boundaryKey) : null;
        break pager;
      }
    }

    if (!moreChunks) {
      // Walked the whole stream without filling the page → no more rows.
      nextCursor = null;
      break;
    }
    chunkStartKey = chunk.lastEvaluatedKey;
  }

  // --- Relay-group rows: the second source, folded in split-proof ------------
  // The contact pager above NEVER emits relay rows (rowForConversation skips
  // type==='relay_group'). We merge relay rows ONLY on the FIRST page (cursor
  // absent) and ADDITIVELY — they don't consume the contact pager's limit /
  // cursor accounting. That makes paging provably safe:
  //   • no double-serve — later pages (cursor present) omit relay rows entirely;
  //   • no drop — every relay row lands on page 1 (bounded by listRelayGroups'
  //     page budget, whose `truncated` flag we surface rather than silently drop);
  //   • no dedupe needed — relay rows key by conversationId, disjoint from the
  //     contact/unknown rows.
  // Trade-off: a relay group whose last activity predates the page-1 boundary
  // still sorts onto page 1 (relay groups are active surfaces, so in practice
  // they cluster near the top). Only OPEN groups are surfaced — matching the
  // rest of the feed, which is open-only.
  let relayCount = 0;
  if (startKey === undefined) {
    // Relay rows come from TWO status partitions now: OPEN groups AND CONNECTING
    // groups (D9). A connect-when-ready group has no pool number yet but MUST be
    // visible so staff can open it + queue messages on the composer - otherwise it
    // is invisible until its warm number registers. Fetch both, merge, render.
    const relayItems: ConversationItem[] = [];
    let anyTruncated = false;
    for (const relayStatus of ['open', 'connecting'] as const) {
      try {
        const res = await conversations.listRelayGroups(relayStatus);
        relayItems.push(...res.items);
        if (res.truncated) anyTruncated = true;
      } catch (err) {
        log.warn({ err, relayStatus }, 'inbox: relay-group list failed (best-effort)');
      }
    }
    if (anyTruncated) {
      // No silent truncation — surface it (counts only; never a phone/body).
      log.warn(
        { returned: relayItems.length },
        'inbox: relay-group list truncated by the page budget — some groups omitted',
      );
    }
    const relayRows: InboxRow[] = [];
    for (const conv of relayItems) {
      const row = await relayRowFor(conv);
      // Counted like the pager's own filter drops. It USED to reject every
      // relay row under filter=unknown (a relay row's needsTriage is always
      // false), and leaving that uncounted made a zero-row Unknown page look
      // like an empty partition - the confusion these fields exist to break.
      // Since the 2026-08-25 contact-side read that filter returns before the
      // relay merge runs, so `filteredRelay` can no longer fire under
      // `unknown`; only `filter=all` reaches here, and `passesFilter` is
      // unconditionally true for it. The counter now guards FUTURE filters
      // that reach this merge - like `filteredGroup` below, read its absence
      // as "no information", not as "nothing was dropped".
      if (passesFilter(row)) relayRows.push(row);
      else dropped('filteredRelay');
    }
    if (relayRows.length > 0) {
      rows.push(...relayRows);
      // Re-sort the page newest-first (stable) so relay rows interleave with the
      // contact/unknown rows by last_activity_at.
      rows.sort((a, b) =>
        a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0,
      );
      relayCount = relayRows.length;
    }
  }

  // --- group_text rows: the THIRD source, folded in the same split-proof way ---
  // Same additive first-page contract as the relay source above (no double-serve,
  // no drop, no dedupe - group ids are disjoint from contact/unknown/relay keys),
  // with ONE difference that spec 11 makes explicit: the group source is CAPPED.
  // Relay's uncapped merge is sized for a handful of rows; there are 132 group
  // threads on day one, so page one takes the newest GROUP_PAGE_ONE_LIMIT and
  // says so (groupsTruncated) rather than flooding the feed or lying about it.
  // There is no exact total - the partition cannot produce one without walking it.
  let groupCount = 0;
  let groupsTruncated = false;
  // This block USED to carry a `&& filter !== 'unknown'` term: `unknown` never
  // contains group rows (needsTriage is always false), so it skipped the query
  // outright rather than reading a partition to throw it all away. The
  // 2026-08-25 contact-side read RETIRED that term - not by choice but by
  // construction. With `groups`, `unread` and now `unknown` all returning from
  // their own branches above, `filter` is NARROWED to the literal `'all'` here,
  // and `tsc` rejects the comparison outright (TS2367, no overlap). The term
  // could not be kept as belt-and-braces; the early return IS the belt now.
  // If a future filter reaches this line, decide its group posture HERE - the
  // guard that used to make that decision for `unknown` is gone.
  if (startKey === undefined) {
    // Only `filter=all` reaches here now (`groups`, `unread` and `unknown`
    // returned above), so the read is always the page-one cap. The unread FULL
    // PARTITION WALK this block used to run - and its growth WARN - died with
    // spec 4.5: unread group rows come from the byUnread index like every other
    // unread row, and page-one overflow of ANY kind is reachable through the
    // unread cursor.
    const page = await readGroupSource(GROUP_PAGE_ONE_LIMIT);
    // TRUNCATED means "rows this filter would have shown were withheld": the
    // repo's walk budget stopped early, or (page-one only) the cap did.
    groupsTruncated = page.truncated || page.nextCursor !== undefined;
    // `filteredGroup` is DEAD TODAY and kept deliberately: only `filter=all`
    // reaches this block (`groups`, `unread` and - since the 2026-08-25
    // contact-side read - `unknown` all returned from their own branches
    // earlier) and `passesFilter` is unconditionally true for `all`, so the
    // counter can never fire. It exists so a future filter that DOES reach
    // here cannot silently drop every group row. `filteredRelay` above is now
    // dead for exactly the same reason - no live filter reaches either merge
    // and rejects rows - so read BOTH absences as "no information", not as
    // "nothing was dropped".
    const groupRows = page.items.map(groupRowFor).filter((row) => {
      if (passesFilter(row)) return true;
      dropped('filteredGroup');
      return false;
    });
    if (groupRows.length > 0) {
      rows.push(...groupRows);
      // Re-sort newest-first (stable) so group rows interleave by last_activity_at.
      rows.sort((a, b) =>
        a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0,
      );
      groupCount = groupRows.length;
    }
  }

  log.info(
    {
      filter,
      count: rows.length,
      relayCount,
      groupCount,
      hasMore: nextCursor !== null,
      // THE READ ACCOUNTING (see `rawScanned` at the top of this function).
      // `rawQueries` counts the pager's chunk Queries ONLY - not the boundary
      // re-query (it re-reads rows already counted), and not the relay list,
      // the group source, contact resolution or message hydration. It is NOT
      // the request's round-trip count and must not be used as one: the badge
      // work in cluster C1 is measured in round trips, and this field would
      // under-report by orders of magnitude.
      rawScanned,
      rawQueries,
      // Only when something was actually dropped, so an ordinary page keeps a
      // short line. Counts and reason names only - no phone, no body, no id.
      ...(Object.keys(drops).length > 0 && { drops }),
    },
    'inbox feed assembled',
  );
  return { rows, nextCursor, ...(groupsTruncated && { groupsTruncated: true }) };
}

/**
 * Count the unread inbox ROWS for the nav badge (spec 4.4).
 *
 * ONE `collectUnreadRows` call over the sparse byUnread index, capped at
 * BADGE_COUNT_CAP. Because layer 1 is lazy and layer 2 stops at the cap, an
 * empty index costs a single Query and a busy one scans only far enough to find
 * 100 rows - never the whole index.
 *
 * NO HYDRATION: no previews, no placement labels, no latest-message reads. The
 * deleted-contact resurfacing probe inside the collector is the one message read
 * this path performs, and it is a VISIBILITY rule (spec 4.3 step 2), not
 * presentation.
 *
 * Repo reads are NOT caught here: an index failure is a normal 500 and the
 * client collapses any error to "no badge" (spec 4.4).
 */
export async function countUnreadRows(deps: InboxRouterDeps): Promise<InboxUnreadCount> {
  const log = deps.logger ?? defaultLogger;
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });

  const result = await collectUnreadRows(
    { conversations, contacts, messages, logger: log },
    {
      maxRows: BADGE_COUNT_CAP,
      budget: deps.unreadWalkLimit ?? UNREAD_WALK_LIMIT,
    },
  );
  // ONE collect IS the whole request here, so this collect's probe total is the
  // request total the tripwire wants. The shared module-scope limiter (the same
  // instance the unread PAGE fires) owns the threshold - do not re-test it here.
  warnDeletedProbes(log, {
    probes: result.deletedProbes,
    wasted: result.wastedProbes,
    skipped: result.skippedDeletedThreads,
  });
  // THE SILENT ZERO (conformance C1): an early-stopped walk that found nothing
  // renders as no badge at all, which the operator reads as "caught up" while
  // unread rows sit behind the truncation. `truncated` is on the wire, but v1's
  // client deliberately does not render it, so this WARN is the only place the
  // state is observable.
  if (result.candidates.length === 0 && result.truncated) {
    warnTruncatedZeroCount(log, {
      scanned: (deps.unreadWalkLimit ?? UNREAD_WALK_LIMIT) - result.remainingBudget,
      probes: result.deletedProbes,
      // How DEEP the wall behind the zero is - the field `probes` cannot supply
      // once the bound pins it to a constant (adversarial r3 finding 6).
      skipped: result.skippedDeletedThreads,
    });
  }

  // Deliberately no per-request INFO line: this is the highest-frequency call in
  // the app (every SPA boot plus every debounced conversation event, per
  // connected dashboard). The rate-limited WARN tripwires are the signal.
  //
  // TWO SURFACES, ONE FACT (conformance r3 finding 5). The badge returns the
  // collector's `truncated` verbatim while the unread PAGE re-derives its own
  // from the cursor branch chain (the page can end early for reasons the
  // collector cannot see: the seen-set depth cap, an undeliverable lag drop).
  // The two converge on the same wire meaning - "the scan ended EARLY, so this
  // answer is a floor" - and the collector's derivation, with the fix-wave-3
  // rule that a drained stream is a natural end, is at
  // lib/unreadFeed.ts `collectUnreadRows`' return.
  return {
    unreadCount: result.candidates.length,
    capped: result.capped,
    truncated: result.truncated,
  };
}

// --- Router ------------------------------------------------------------------

/** Parse + clamp ?limit= into 1..MAX_INBOX_LIMIT; default DEFAULT_INBOX_LIMIT. */
function parseLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_INBOX_LIMIT;
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isInteger(n)) return DEFAULT_INBOX_LIMIT;
  return Math.min(MAX_INBOX_LIMIT, Math.max(1, n));
}

export function createInboxRouter(deps: InboxRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const events = deps.events ?? appEvents;
  const router = Router();

  // GET /api/inbox?filter=all|unread|unknown|groups&cursor=&limit= -> InboxPage
  // `groups` pages the native group-text partition ONLY (the contact and relay
  // sources do not run) through its own NAMESPACED cursor; a cursor minted under
  // another filter is a 400, not a cross-partition Query.
  router.get('/', async (req, res) => {
    const rawFilter = req.query['filter'];
    // Default to 'all' when the param is absent; reject anything that's not a
    // recognised InboxFilter string (array / nested object values → 400).
    // We pass rawFilter directly to the type-guard (takes unknown) so there is
    // no premature cast; after the guard TypeScript knows it's InboxFilter.
    const filterRaw = rawFilter === undefined ? 'all' : rawFilter;
    if (!isInboxFilter(filterRaw)) {
      res.status(400).json({ error: `filter must be one of: ${[...INBOX_FILTERS].join(', ')}` });
      return;
    }
    const filter: InboxFilter = filterRaw;
    const limit = parseLimit(req.query['limit']);
    const rawCursor = req.query['cursor'];
    const cursor = typeof rawCursor === 'string' && rawCursor.length > 0 ? rawCursor : undefined;

    try {
      const page = await aggregateInbox(
        { filter, limit, ...(cursor !== undefined && { cursor }) },
        deps,
      );
      res.json(page);
    } catch (err) {
      if (err instanceof InboxBadRequestError) {
        res.status(400).json({ error: err.message });
        return;
      }
      log.error({ err }, 'inbox feed failed');
      throw err; // Express 5 forwards async throws to the error handler.
    }
  });

  // GET /api/inbox/unread-count -> { unreadCount, capped, truncated }
  // The nav badge's cheap read (spec 4.4): ONE index-backed collect, no
  // hydration. Registered ABOVE the /:contactId/read param route - Express
  // matches in REGISTRATION order, so a param route placed first would claim
  // "unread-count" as a contactId. Today the param route is a POST two segments
  // deep and cannot collide; keeping this above it is what makes that stay true.
  router.get('/unread-count', async (_req, res) => {
    try {
      res.json(await countUnreadRows(deps));
    } catch (err) {
      log.error({ err }, 'inbox unread count failed');
      throw err; // Express 5 forwards async throws to the error handler (500).
    }
  });

  // POST /api/inbox/read { phone } — mark-read for an unknown number (no
  // contactId). Must be registered BEFORE /:contactId/read so the literal path
  // segment "read" is matched first (different depth: /read vs /:contactId/read,
  // but we keep explicit ordering as belt-and-braces).
  router.post('/read', async (req, res) => {
    const payload = (req.body ?? {}) as { phone?: unknown };
    const phone = payload.phone;
    if (typeof phone !== 'string' || phone.length === 0) {
      res.status(400).json({ error: 'phone must be a non-empty string' });
      return;
    }
    // Basic E.164-ish: must start with + and contain only digits after it.
    if (!/^\+\d+$/.test(phone)) {
      res.status(400).json({ error: 'phone must be E.164 (e.g. +15550001234)' });
      return;
    }

    const convs = await conversations.findByParticipantPhone(phone);
    if (convs.length === 0) {
      res.status(404).json({ error: 'no_conversation_for_phone' });
      return;
    }

    await Promise.all(
      convs
        .filter((c) => unreadOf(c) > 0)
        .map(async (c) => {
          try {
            const updated = await conversations.resetUnread(c.conversationId);
            events.emit('conversation.updated', toConversationUpdatedEvent(updated));
          } catch (err) {
            if (err instanceof ConditionalCheckFailedException) return; // race: already gone
            throw err;
          }
        }),
    );

    log.info({ phone, count: convs.length }, 'inbox: unknown-number mark-read fan-out');
    res.json({ ok: true });
  });

  // POST /api/inbox/:contactId/read — fan-out mark-read across ALL the
  // contact's conversations.
  router.post('/:contactId/read', async (req, res) => {
    const { contactId } = req.params;
    const contact = await contacts.getById(contactId);
    if (!contact) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }

    // Gather all conversations across every phone number AND email address the
    // contact owns (email channel v1, ADJ-1b: an email thread's unread must zero
    // on mark-read too).
    const all = await conversationsForContact(contact, conversations);

    await Promise.all(
      all
        .filter((c) => unreadOf(c) > 0)
        .map(async (c) => {
          try {
            const updated = await conversations.resetUnread(c.conversationId);
            events.emit('conversation.updated', toConversationUpdatedEvent(updated));
          } catch (err) {
            if (err instanceof ConditionalCheckFailedException) return; // race: already gone
            throw err;
          }
        }),
    );

    log.info({ contactId, count: all.length }, 'inbox: contact mark-read fan-out');
    res.json({ ok: true });
  });

  // --- Mark UNREAD (the inbox row's toggle counterpart to Mark read) ---------
  // The row is per CONTACT (newest-conversation rule), so "mark this row
  // unread" flags the contact's NEWEST 1:1 thread - the one the row shows -
  // never a fan-out. Idempotent: an already-unread thread is left alone (no
  // second write), and the reply is the same 200 either way.
  //
  // CONDITIONAL WRITE (H1, 2026-08-17). setUnread SETs the counter to exactly 1
  // and stamps the byUnread flag in one expression, conditional on the LIVE row
  // still being eligible (MU-1, transcribed from isUnreadVisible) and still
  // read. So the pre-checks below are a fast path for specific errors, not the
  // guarantee: a relay close or a type transition committing between the read
  // and the write now loses the write instead of planting an invisible byUnread
  // resident - the residue class scripts/backfill-unread-flag.ts exists to
  // repair. Two consequences the old read-then-write comment got wrong: the
  // count lands at exactly 1 (a SET, so a stale GSI-fed 0 can no longer leave
  // the row at 2), and the candidate filter below is now belt-and-braces rather
  // than the thing standing between a pool number and a closed relay group.
  // lib/markUnread.ts owns the refusal classification and the single retry.
  const newestOf = (convs: ConversationItem[]): ConversationItem | undefined =>
    convs.reduce<ConversationItem | undefined>(
      (best, c) => (best === undefined || c.last_activity_at > best.last_activity_at ? c : best),
      undefined,
    );
  /**
   * Flag `conv` unread. false = refused, which BOTH fan-in routes answer with
   * 409 thread_closed: either the unread feed would never show the thread, or
   * the row is gone - and a client that named a contact or a phone (never this
   * conversation, and the contact demonstrably exists, the route just loaded
   * it) has nothing to be told 404 about.
   */
  const flagUnread = async (conv: ConversationItem): Promise<boolean> => {
    if (!isUnreadVisible({ ...conv, unread_count: 1 })) return false;
    // NO "already unread?" PRE-CHECK HERE, DELIBERATELY (fix wave 1, 2026-08-17).
    // `conv` came from findByParticipantPhone - a Query on the EVENTUALLY
    // CONSISTENT byParticipantPhone GSI - so a stale POSITIVE count would have
    // answered 200 with no write at all, and the client would have committed an
    // optimistic unread onto a row the server left read. setUnread's own
    // condition refuses an already-unread row and markUnread's classify re-reads
    // it as `already-unread`, which lands on the same success below. The price is
    // stated so it is not "optimized" back: an already-unread thread now costs
    // one REFUSED conditional write plus one point read instead of nothing.
    const outcome = await markUnread(conversations, conv);
    if (outcome.kind === 'gone' || outcome.kind === 'ineligible') return false;
    // Emit ONLY on a real write, carrying the image the write itself returned
    // (ALL_NEW): a re-read is eventually consistent and could hand back the
    // pre-write count. Consumers refetch on it regardless.
    if (outcome.kind === 'wrote') {
      events.emit('conversation.updated', toConversationUpdatedEvent(outcome.item));
    }
    return true;
  };

  // POST /api/inbox/unread { phone } - unknown-number rows.
  router.post('/unread', async (req, res) => {
    const payload = (req.body ?? {}) as { phone?: unknown };
    const phone = payload.phone;
    if (typeof phone !== 'string' || phone.length === 0) {
      res.status(400).json({ error: 'phone must be a non-empty string' });
      return;
    }
    if (!/^\+\d+$/.test(phone)) {
      res.status(400).json({ error: 'phone must be E.164 (e.g. +15550001234)' });
      return;
    }
    // MU-2 (H2): this route never resolved the contact, so a soft-deleted
    // contact's number could be flagged unread through it - the one way around
    // the rule /:contactId/unread enforces (a 1:1 cannot reach the conversation
    // route at all). Their row is only ever visible while unread, so a manual
    // flag would fake the fresh inbound the resurfacing rule means.
    //
    // A phone with NO contact record is NOT deleted: an untriaged unknown
    // number is exactly what this route is for and stays markable. findByPhone
    // deliberately ignores deleted_at (contactsRepo), which is what lets this
    // see the deleted contact at all.
    //
    // Its /read twin deliberately carries NO such check - zeroing a deleted
    // contact's unread is harmless; SETTING it is what MU-2 forbids. Do not
    // "make them consistent".
    const owner = await contacts.findByPhone(phone);
    if (owner !== undefined && isDeleted(owner)) {
      res.status(409).json({ error: 'contact_deleted' });
      return;
    }
    const newest = newestOf(await conversations.findByParticipantPhone(phone));
    if (newest === undefined) {
      res.status(404).json({ error: 'no_conversation_for_phone' });
      return;
    }
    if (!(await flagUnread(newest))) {
      res.status(409).json({ error: 'thread_closed' });
      return;
    }
    log.info({ phone, conversationId: newest.conversationId }, 'inbox: unknown-number mark-unread');
    res.json({ ok: true });
  });

  // POST /api/inbox/:contactId/unread - contact rows. A soft-deleted contact
  // is refused: their row is only ever visible while unread (resurfacing), and
  // a manual flag must not fake the "fresh inbound" the resurfacing rule means.
  router.post('/:contactId/unread', async (req, res) => {
    const { contactId } = req.params;
    const contact = await contacts.getById(contactId);
    if (!contact) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }
    if (isDeleted(contact)) {
      res.status(409).json({ error: 'contact_deleted' });
      return;
    }
    // The row's own candidate set (the aggregator's contactConversations rule:
    // status open, never a relay_group), NOT the raw phone/email union - a
    // contact who owns a pool number must not be able to flag a relay thread
    // through here.
    const newest = newestOf(
      (await conversationsForContact(contact, conversations)).filter(
        (c) => c.status === 'open' && c.type !== 'relay_group',
      ),
    );
    if (newest === undefined) {
      res.status(404).json({ error: 'no_conversation_for_contact' });
      return;
    }
    if (!(await flagUnread(newest))) {
      res.status(409).json({ error: 'thread_closed' });
      return;
    }
    log.info({ contactId, conversationId: newest.conversationId }, 'inbox: contact mark-unread');
    res.json({ ok: true });
  });

  return router;
}
