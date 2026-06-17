// C8 / "BE7" — Inbox feed. A READ-ONLY aggregation over the conversations,
// contacts, messages, cases, and users repos (no new table) that assembles the
// dashboard's secondary comms lens: ONE row per contact (or one untriaged
// unknown number), newest-activity-first, with cross-number unread, the latest
// item's channel/direction/preview, an optional case context, and the assigned
// team member. Mounted at /api/inbox (behind requireAuth via the /api mount in
// app.ts).
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
// relay_group conversations are EXCLUDED — C8 has no group row kind (the group
// text lives in its own surface; the Inbox is a per-contact lens).
//
// Hydration (name / role / caseContext / assignment / channel / direction /
// preview) is BEST-EFFORT and bounded to the page: every external lookup is
// wrapped so a missing/failed read degrades to the id (or omits the field) and
// NEVER throws a 500 — exactly the posture today.ts takes. Per-request caches
// keep each contact/case/user resolved at most once.
//
// PII (doc §9): responses carry names/previews to the authed client; LOG LINES
// are counts/IDs only.
import { Router } from 'express';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { formatPhoneForDisplay } from '../lib/phone.js';
import {
  createCasesRepo,
  type CasesRepo,
} from '../repos/casesRepo.js';
import {
  createConversationsRepo,
  type ConversationItem,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import {
  contactPhones,
  createContactsRepo,
  type ContactItem,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import { createMessagesRepo, type MessageItem, type MessagesRepo } from '../repos/messagesRepo.js';
import { createUsersRepo, type UsersRepo } from '../repos/usersRepo.js';
import type { AuthedRequest } from '../middleware/auth.js';

// --- C8 wire contract (VERBATIM — the frontend imports the same shapes) ------

export type InboxFilter = 'all' | 'unread' | 'unknown' | 'mine';
export type InboxChannel = 'sms' | 'mms' | 'call';

export interface InboxRow {
  kind: 'contact' | 'unknown';
  contactId?: string; // present when kind='contact'
  phone?: string; // E.164; the number (esp. for unknown rows)
  name: string; // contact name, or formatted number when unknown
  role?: 'tenant' | 'landlord' | 'unknown';
  caseContext?: { caseId: string; label: string }; // e.g. "Touring" — optional
  unreadCount: number; // aggregate across ALL of the contact's numbers
  preview: string; // latest item's text as a preview (UI shows one line, ellipsized)
  channel: InboxChannel; // channel of the latest item
  direction: 'inbound' | 'outbound'; // 'outbound' → render "You: …"
  lastActivityAt: string; // ISO; sort key (newest first)
  assignment?: { userId: string; name: string }; // the Assigned chip
  needsTriage: boolean; // true for untriaged unknowns
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
  casesRepo?: CasesRepo;
  usersRepo?: UsersRepo;
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

/** The four valid filter values (route allowlist → 400 on anything else). */
export const INBOX_FILTERS: ReadonlySet<string> = new Set<InboxFilter>([
  'all',
  'unread',
  'unknown',
  'mine',
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

/** Title-case a stage value for a case label, e.g. touring → "Touring". */
function titleCase(value: string): string {
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

/** A contact's audience role for the row chip (tenant/landlord, else unknown). */
function roleFromContact(contact: ContactItem | undefined): 'tenant' | 'landlord' | 'unknown' {
  if (contact?.type === 'tenant') return 'tenant';
  if (contact?.type === 'landlord') return 'landlord';
  return 'unknown';
}

/** A team user's display name: an explicit name, else the email, else the id. */
function userDisplayName(
  user: { name?: unknown; email?: unknown } | undefined,
  fallbackUserId: string,
): string {
  if (user) {
    if (typeof user.name === 'string' && user.name.length > 0) return user.name;
    if (typeof user.email === 'string' && user.email.length > 0) return user.email;
  }
  return fallbackUserId;
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
  opts: { filter: InboxFilter; limit: number; cursor?: string; userId: string },
  deps: InboxRouterDeps,
): Promise<InboxPage> {
  const log = deps.logger ?? defaultLogger;
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const cases = deps.casesRepo ?? createCasesRepo({ logger: deps.logger });
  const users = deps.usersRepo ?? createUsersRepo({ logger: deps.logger });

  const { filter, limit, cursor, userId } = opts;
  const startKey = cursor !== undefined ? decodeCursor(cursor) : undefined;

  // Per-request memoization (each contact/case/user resolved at most once).
  const contactConvsCache = new Map<string, ConversationItem[]>();
  const caseLabelCache = new Map<string, string | undefined>();
  const userNameCache = new Map<string, string>();
  // Contacts already emitted in THIS page (the newest-conversation guard so a
  // multi-number contact never yields two rows on one page).
  const emittedContacts = new Set<string>();

  /** All open conversations a contact owns, across every phone (cached). */
  const contactConversations = async (contact: ContactItem): Promise<ConversationItem[]> => {
    if (contactConvsCache.has(contact.contactId)) {
      return contactConvsCache.get(contact.contactId)!;
    }
    const byPhone = new Map<string, ConversationItem>();
    try {
      for (const cp of contactPhones(contact)) {
        const convs = await conversations.findByParticipantPhone(cp.phone);
        for (const c of convs) {
          if (c.status !== 'open') continue;
          if (c.type === 'relay_group') continue; // never represented in the feed
          byPhone.set(c.conversationId, c);
        }
      }
    } catch (err) {
      log.warn({ err, contactId: contact.contactId }, 'inbox: contact conversations lookup failed (best-effort)');
    }
    const list = [...byPhone.values()];
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

  /** Resolve a case's label (stage title-cased); cached + best-effort. */
  const caseLabel = async (caseId: string): Promise<string | undefined> => {
    if (caseLabelCache.has(caseId)) return caseLabelCache.get(caseId);
    let label: string | undefined;
    try {
      const c = await cases.getById(caseId);
      if (c && typeof c.stage === 'string') label = titleCase(c.stage);
    } catch (err) {
      log.warn({ err, caseId }, 'inbox: case label hydration failed (best-effort)');
    }
    caseLabelCache.set(caseId, label);
    return label;
  };

  /** Resolve a team user's display name; cached + best-effort. */
  const resolveUserName = async (assigneeId: string): Promise<string> => {
    if (userNameCache.has(assigneeId)) return userNameCache.get(assigneeId)!;
    let name = assigneeId;
    try {
      const user = await users.findById(assigneeId);
      name = userDisplayName(user, assigneeId);
    } catch (err) {
      log.warn({ err }, 'inbox: assignee name hydration failed (best-effort)');
    }
    userNameCache.set(assigneeId, name);
    return name;
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
      case 'mine':
        return row.assignment?.userId === userId;
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
    if (conv.type === 'relay_group') return undefined; // C8 has no group row kind

    const phone = conv.participant_phone;
    let contact: ContactItem | undefined;
    try {
      contact = await contacts.findByPhone(phone);
    } catch (err) {
      log.warn({ err }, 'inbox: contact lookup failed (best-effort)');
      contact = undefined;
    }

    if (!contact) {
      // Unknown number → an untriaged unknown row, keyed by phone.
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

    let caseContext: { caseId: string; label: string } | undefined;
    if (typeof maxConv.caseId === 'string' && maxConv.caseId.length > 0) {
      const label = await caseLabel(maxConv.caseId);
      if (label !== undefined) caseContext = { caseId: maxConv.caseId, label };
    }

    let assignment: { userId: string; name: string } | undefined;
    if (typeof maxConv.assignment === 'string' && maxConv.assignment.length > 0) {
      const name = await resolveUserName(maxConv.assignment);
      assignment = { userId: maxConv.assignment, name };
    }

    emittedContacts.add(contact.contactId);
    return {
      kind: 'contact',
      contactId: contact.contactId,
      phone: maxConv.participant_phone,
      name: nameFromContact(contact) ?? formatPhoneForDisplay(phone) ?? phone,
      role: roleFromContact(contact),
      ...(caseContext !== undefined && { caseContext }),
      unreadCount: unreadSum,
      preview,
      channel,
      direction,
      lastActivityAt: maxConv.last_activity_at,
      ...(assignment !== undefined && { assignment }),
      needsTriage: false,
    };
  };

  const rows: InboxRow[] = [];
  let nextCursor: string | null = null;
  // The resume key for the CURRENT chunk (the cursor passed in, then each
  // chunk's terminal LEK). A chunk is a raw byLastActivity Query of CHUNK_SIZE
  // conversations; its LEK is the EXACT boundary after the chunk's last
  // conversation. We never break a page mid-chunk WITHOUT recovering the precise
  // boundary (see the re-query below), so the emitted cursor always resumes
  // exactly after the conversation that filled the page — no rows skipped, none
  // double-served.
  let chunkStartKey: Record<string, unknown> | undefined = startKey;

  // The page is `limit` CONTACT rows, but each row can consume several raw
  // conversations (multi-number contacts, relay-skips, filter-drops), so we pull
  // chunks until the page fills or the stream is exhausted. CHUNK_SIZE is the
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

  log.info({ filter, count: rows.length, hasMore: nextCursor !== null }, 'inbox feed assembled');
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
  const router = Router();

  // GET /api/inbox?filter=all|unread|unknown|mine&cursor=&limit= → InboxPage
  router.get('/', async (req, res) => {
    const rawFilter = req.query['filter'];
    const filter: InboxFilter = rawFilter === undefined ? 'all' : (rawFilter as InboxFilter);
    if (!isInboxFilter(filter)) {
      res.status(400).json({ error: `filter must be one of: ${[...INBOX_FILTERS].join(', ')}` });
      return;
    }
    const limit = parseLimit(req.query['limit']);
    const rawCursor = req.query['cursor'];
    const cursor = typeof rawCursor === 'string' && rawCursor.length > 0 ? rawCursor : undefined;

    const userId = (req as AuthedRequest).user!.userId;

    try {
      const page = await aggregateInbox(
        { filter, limit, userId, ...(cursor !== undefined && { cursor }) },
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

  return router;
}
