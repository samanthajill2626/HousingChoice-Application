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
// relay_group conversations are a SECOND row source (kind='relay_group'):
// masked group-text threads carry last_activity_at / status / unread_count /
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
import { STAGE_LABELS } from '../lib/statusModel.js';
import {
  createPlacementsRepo,
  type PlacementsRepo,
} from '../repos/placementsRepo.js';
import {
  createConversationsRepo,
  getOwner,
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
import { createMessagesRepo, type MessageItem, type MessagesRepo } from '../repos/messagesRepo.js';
import { conversationsForContact } from '../lib/contactThreads.js';

// --- C8 wire contract (VERBATIM — the frontend imports the same shapes) ------

export type InboxFilter = 'all' | 'unread' | 'unknown';
export type InboxChannel = 'sms' | 'mms' | 'call' | 'email';

export interface InboxRow {
  kind: 'contact' | 'unknown' | 'relay_group';
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
  // --- relay_group only (present iff kind === 'relay_group') --------------------
  conversationId?: string; // the relay conversation id → route /conversations/:conversationId
  status?: 'open' | 'closed'; // the relay group's lifecycle status
  owner?: RelayOwner; // owning tour/placement ({type:'tour'|'placement',id} | {type:null})
}

export interface InboxPage {
  rows: InboxRow[]; // newest-activity-first; ONE row per contact
  nextCursor: string | null;
}

// --- Deps (injectable; default to the real repos, like TodayRouterDeps) ------

export interface InboxRouterDeps {
  logger?: Logger;
  conversationsRepo?: ConversationsRepo;
  contactsRepo?: ContactsRepo;
  messagesRepo?: MessagesRepo;
  placementsRepo?: PlacementsRepo;
  events?: EventBus;
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

/** The three valid filter values (route allowlist -> 400 on anything else). */
export const INBOX_FILTERS: ReadonlySet<string> = new Set<InboxFilter>([
  'all',
  'unread',
  'unknown',
]);

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
  return parsed as Record<string, unknown>;
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

/** The latest message's channel/direction/preview, derived (never stored). */
interface DerivedLatest {
  channel: InboxChannel;
  direction: 'inbound' | 'outbound';
  preview: string;
}

/**
 * Derive channel/direction/preview from the newest message on the representative
 * conversation. mms when the message carries media; call when it's a call
 * record; else sms. Falls back to the conversation's denormalized preview (and
 * sms/inbound) when no message is available — never throws.
 */
function deriveLatest(
  latest: { type?: unknown; direction?: unknown; body?: unknown; mediaUrls?: unknown; media_attachments?: unknown } | undefined,
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
  const preview = typeof latest.body === 'string' && latest.body.length > 0 ? latest.body : fallbackPreview;
  return { channel, direction, preview };
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
  const startKey = cursor !== undefined ? decodeCursor(cursor) : undefined;

  // Per-request memoization (each contact/placement/user resolved at most once).
  const contactConvsCache = new Map<string, ConversationItem[]>();
  const placementLabelCache = new Map<string, string | undefined>();
  // Contacts already emitted in THIS page (the newest-conversation guard so a
  // multi-number contact never yields two rows on one page).
  const emittedContacts = new Set<string>();

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

  /** Does the row pass the active filter? */
  const passesFilter = (row: InboxRow): boolean => {
    switch (filter) {
      case 'unread':
        return row.unreadCount > 0;
      case 'unknown':
        return row.needsTriage;
      case 'all':
      default:
        return true;
    }
  };

  /**
   * Build the row for a single raw conversation (or return undefined when this
   * conversation does NOT emit one: a relay_group, an already-emitted contact,
   * or a contact whose newest conversation is elsewhere). Pure of paging — the
   * caller owns the page-fill / boundary bookkeeping.
   */
  const rowForConversation = async (conv: ConversationItem): Promise<InboxRow | undefined> => {
    // relay_group threads are emitted by the SEPARATE relay source (relayRowFor
    // via listRelayGroups), never by the contact pager — so skip them here to
    // guarantee they can't be double-counted.
    if (conv.type === 'relay_group') return undefined;

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
      if (phone === undefined) return undefined;
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

    // Soft-deleted contact → hidden from the inbox (record retained; restore
    // resurfaces it). findByPhone stays unfiltered for routing, so filter here.
    if (isDeleted(contact)) return undefined;

    if (emittedContacts.has(contact.contactId)) return undefined; // one row per page
    const convs = await contactConversations(contact);
    const maxConv = newestOf(convs) ?? conv;
    // Represent the contact ONLY at its NEWEST conversation. An older one is
    // skipped — a newer conversation already (or will) emit the row. This is
    // what makes paging split-proof: a contact seen on page 1 (at its newest
    // conv) can never re-emit on page 2 via an older conv.
    if (maxConv.conversationId !== conv.conversationId) return undefined;

    const unreadSum = convs.reduce((sum, c) => sum + unreadOf(c), 0);
    const { channel, direction, preview } = await latestMessageOf(maxConv.conversationId, maxConv);

    let placementContext: { placementId: string; label: string } | undefined;
    if (typeof maxConv.placementId === 'string' && maxConv.placementId.length > 0) {
      const label = await placementLabel(maxConv.placementId);
      if (label !== undefined) placementContext = { placementId: maxConv.placementId, label };
    }

    emittedContacts.add(contact.contactId);
    // A type='unknown' contact IS an untriaged inbound (it just already has a
    // record) — so it needs triage and belongs under the "unknown" filter, exactly
    // like a no-contact number. Keying triage off the ROLE (not "no contact
    // record") is what makes both cases surface.
    const role = roleFromContact(contact);
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
    };
  };

  /**
   * Build the relay_group row for one relay conversation. Relay groups are the
   * SECOND row source (queried via listRelayGroups, not the contact pager).
   * Label precedence mirrors the dashboard's GroupTextsCard.groupLabel: other
   * member names → operator tag → formatted pool number → "Group text".
   *
   * PII: the returned row carries names/preview to the authed client (like the
   * contact rows); log lines stay counts/IDs only.
   */
  const relayRowFor = async (conv: ConversationItem): Promise<InboxRow> => {
    const memberNames = (conv.participants ?? [])
      .map((p) => (typeof p.name === 'string' ? p.name.trim() : ''))
      .filter((n) => n.length > 0);
    // GOTCHA: the operator tag rides ConversationItem's index signature under
    // the key `placement_tag` (NOT `tag`) and is untyped — read it defensively.
    const tag = typeof conv.placement_tag === 'string' ? conv.placement_tag.trim() : '';
    let label: string;
    if (memberNames.length > 0) {
      label = `With ${memberNames.join(' & ')}`;
    } else if (tag.length > 0) {
      label = tag;
    } else if (typeof conv.pool_number === 'string' && conv.pool_number.length > 0) {
      label = formatPhoneForDisplay(conv.pool_number) ?? conv.pool_number;
    } else {
      label = 'Group text';
    }

    const preview =
      typeof conv.last_message_preview === 'string' ? conv.last_message_preview : '';
    const status: 'open' | 'closed' = conv.status === 'closed' ? 'closed' : 'open';

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

    for (let i = 0; i < chunk.items.length; i++) {
      const conv = chunk.items[i]!;
      const row = await rowForConversation(conv);
      if (row === undefined || !passesFilter(row)) continue;
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
    let relayResult: { items: ConversationItem[]; truncated: boolean };
    try {
      relayResult = await conversations.listRelayGroups('open');
    } catch (err) {
      log.warn({ err }, 'inbox: relay-group list failed (best-effort)');
      relayResult = { items: [], truncated: false };
    }
    if (relayResult.truncated) {
      // No silent truncation — surface it (counts only; never a phone/body).
      log.warn(
        { returned: relayResult.items.length },
        'inbox: relay-group list truncated by the page budget — some groups omitted',
      );
    }
    const relayRows: InboxRow[] = [];
    for (const conv of relayResult.items) {
      const row = await relayRowFor(conv);
      if (passesFilter(row)) relayRows.push(row);
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

  log.info(
    { filter, count: rows.length, relayCount, hasMore: nextCursor !== null },
    'inbox feed assembled',
  );
  return { rows, nextCursor };
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

  // GET /api/inbox?filter=all|unread|unknown&cursor=&limit= -> InboxPage
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

  return router;
}
