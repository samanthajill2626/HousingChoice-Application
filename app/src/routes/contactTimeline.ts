// Contact timeline router (BE2/C2) — the person-centric MERGED timeline.
//
//   GET /api/contacts/:contactId/timeline?cursor=&kinds=&limit=
//        → { items: TimelineItem[], nextCursor: string | null }
//
// Mounted under /api/contacts (behind requireAuth via the /api mount). Merges,
// for ONE contact, every 1:1 conversation across ALL their phone numbers
// (messages + call entries) UNION the activity-event log (milestones), sorted
// newest-first by a global `<at>#<id>` key and paginated by an opaque cursor.
//
// ORDER (locked, C2): the page is returned NEWEST-FIRST (descending) and the
// cursor pages BACKWARD in time (each nextCursor fetches the next-older page).
// The C2 client renders oldest→newest by reversing a page; the SERVER stays
// consistently descending so the cursor boundary is unambiguous and there are
// no dups/skips across pages.
//
// PII (doc §9) — load-bearing:
//   - messages: FULL body (no truncation); fromPhone/toPhone derive ONLY from
//     the contact's own number (the conversation's participant_phone) + our org
//     number — never another counterpart.
//   - calls: party_phone is the contact's OWN number for a 1:1 call; a MASKED
//     (relay-pool) call NEVER exposes recording_s3_key/transcript (omitted
//     entirely) — only founder-bridge (masked!==true) calls carry them.
//   - milestones: link-out only (refType/refId) — never inline content.
//   - log lines carry IDs/counts only — never bodies/phones/labels.
import { Router } from 'express';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { mergeContext } from '../lib/context.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  createActivityEventsRepo,
  type ActivityEventItem,
  type ActivityEventsRepo,
  type ActivityEventType,
} from '../repos/activityEventsRepo.js';
import {
  contactPhones,
  createContactsRepo,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
import {
  createConversationsRepo,
  type ConversationItem,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import {
  createMessagesRepo,
  mediaAttachmentsOf,
  type MediaAttachment,
  type MessageDirection,
  type MessageAuthor,
  type MessageItem,
  type MessagesRepo,
  type CallOutcome,
  type DeliveryStatus,
} from '../repos/messagesRepo.js';

export interface ContactTimelineRouterDeps {
  logger?: Logger;
  config?: AppConfig;
  contactsRepo?: ContactsRepo;
  conversationsRepo?: ConversationsRepo;
  messagesRepo?: MessagesRepo;
  activityEventsRepo?: ActivityEventsRepo;
}

// --- C2 wire shapes (VERBATIM — the frontend imports identical field names) --

interface TimelineBase {
  id: string;
  /** ISO 8601 — the global sort key. */
  at: string;
}
interface TimelineMessage extends TimelineBase {
  kind: 'message';
  conversationId: string;
  tsMsgId: string;
  direction: MessageDirection;
  author: MessageAuthor;
  type: 'sms' | 'mms';
  body?: string;
  media_attachments?: MediaAttachment[];
  delivery_status: DeliveryStatus;
  fromPhone?: string;
  toPhone?: string;
}
interface TimelineCall extends TimelineBase {
  kind: 'call';
  conversationId?: string;
  call_outcome: CallOutcome;
  call_duration?: number;
  party_phone?: string;
  recording_s3_key?: string;
  transcript?: string;
}
interface TimelineMilestone extends TimelineBase {
  kind: 'milestone';
  type: ActivityEventType;
  label: string;
  refType?: 'case' | 'unit' | 'conversation' | 'broadcast';
  refId?: string;
}
type TimelineItem = TimelineMessage | TimelineCall | TimelineMilestone;

/** A candidate carries its global comparison key alongside the wire item. */
interface Candidate {
  /** `<at>#<id>` — the global, comparable boundary key. */
  globalKey: string;
  item: TimelineItem;
}

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

const ALL_KINDS = ['message', 'call', 'milestone'] as const;
type TimelineKind = (typeof ALL_KINDS)[number];

/** Parse ?limit= into 1..MAX (default). undefined ⇒ 400 upstream. */
function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined) return DEFAULT_PAGE_LIMIT;
  if (typeof raw !== 'string') return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) return undefined;
  return limit;
}

/**
 * Parse ?kinds= (comma list of message|call|milestone). Absent/empty ⇒ all.
 * Returns the validated SET, or undefined for an invalid token (→ 400).
 */
function parseKinds(raw: unknown): Set<TimelineKind> | undefined {
  if (raw === undefined || raw === '') return new Set(ALL_KINDS);
  if (typeof raw !== 'string') return undefined;
  const parts = raw.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return new Set(ALL_KINDS);
  const set = new Set<TimelineKind>();
  for (const p of parts) {
    if (!(ALL_KINDS as readonly string[]).includes(p)) return undefined;
    set.add(p as TimelineKind);
  }
  return set;
}

/**
 * The opaque cursor is the base64url of a global boundary key (`<at>#<id>`),
 * an EXCLUSIVE upper bound. Validate the SHAPE (a non-empty string containing a
 * `#`) so a tampered cursor never silently widens/empties the page — a
 * malformed value is a 400, never a crash.
 */
function encodeCursor(boundaryKey: string): string {
  return Buffer.from(boundaryKey, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): string | undefined {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (decoded.length === 0 || !decoded.includes('#')) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

/**
 * Our org number to stamp on fromPhone/toPhone. Phase-1 single-number posture:
 * the first configured OUR_PHONE_NUMBERS entry (the dashboard sends/receives on
 * it). Absent when unconfigured (tests/local) → those fields are simply omitted.
 */
function ourNumberOf(config: AppConfig): string | undefined {
  return config.ourPhoneNumbers[0];
}

/** Map a stored message → a TimelineMessage (sms/mms). FULL body, no truncation. */
function toTimelineMessage(
  m: MessageItem,
  conversation: ConversationItem | undefined,
  ourNumber: string | undefined,
): TimelineMessage {
  // The contact's OWN number on this 1:1 thread (participant_phone) + our org
  // number are the ONLY phones we expose — never another counterpart (PII).
  const contactPhone = conversation?.participant_phone;
  const fromPhone =
    m.direction === 'inbound' ? contactPhone : ourNumber;
  const toPhone = m.direction === 'inbound' ? ourNumber : contactPhone;
  const media = mediaAttachmentsOf(m);
  return {
    kind: 'message',
    id: m.tsMsgId,
    at: m.provider_ts,
    conversationId: m.conversationId,
    tsMsgId: m.tsMsgId,
    direction: m.direction,
    author: m.author,
    type: m.type === 'mms' ? 'mms' : 'sms',
    ...(m.body !== undefined && { body: m.body }),
    ...(media.length > 0 && { media_attachments: media }),
    delivery_status: m.delivery_status,
    ...(fromPhone !== undefined && { fromPhone }),
    ...(toPhone !== undefined && { toPhone }),
  };
}

/**
 * Map a stored call → a TimelineCall. PII: recording_s3_key + transcript ONLY
 * when masked !== true (founder-bridge); a MASKED call omits both entirely.
 * party_phone is the contact's OWN number for a 1:1 call — never a masked
 * counterpart, so it is only set when the call is NOT masked AND a 1:1 thread
 * resolves the contact's number.
 */
function toTimelineCall(
  m: MessageItem,
  conversation: ConversationItem | undefined,
): TimelineCall {
  const masked = m.masked === true;
  // started_at is the call's first-seen time; fall back to provider_ts for the
  // sort key when a call entry predates the started_at field.
  const at = typeof m.started_at === 'string' && m.started_at.length > 0 ? m.started_at : m.provider_ts;
  const partyPhone = masked ? undefined : conversation?.participant_phone;
  return {
    kind: 'call',
    id: m.tsMsgId,
    at,
    ...(m.conversationId !== undefined && { conversationId: m.conversationId }),
    // call_outcome is required on the wire; default 'missed' when a call entry
    // has no recorded outcome yet (a ringing/unanswered metadata row).
    call_outcome: (m.call_outcome ?? 'missed') as CallOutcome,
    ...(typeof m.call_duration === 'number' && { call_duration: m.call_duration }),
    ...(partyPhone !== undefined && { party_phone: partyPhone }),
    // Masked calls are NEVER recorded/transcribed — never expose these.
    ...(!masked && typeof m.recording_s3_key === 'string' && { recording_s3_key: m.recording_s3_key }),
    ...(!masked && typeof m.transcript === 'string' && { transcript: m.transcript }),
  };
}

/** Map a stored activity event → a TimelineMilestone (link-out only). */
function toTimelineMilestone(e: ActivityEventItem): TimelineMilestone {
  return {
    kind: 'milestone',
    id: e.eventId,
    at: e.at,
    type: e.type,
    label: e.label,
    ...(e.refType !== undefined && { refType: e.refType }),
    ...(e.refId !== undefined && { refId: e.refId }),
  };
}

export function createContactTimelineRouter(deps: ContactTimelineRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const activityEvents = deps.activityEventsRepo ?? createActivityEventsRepo({ logger: deps.logger });

  const router = Router();

  router.get('/:contactId/timeline', async (req, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });

    // 1. The contact must exist (and not be an internal phone-pointer item).
    const contact = await contacts.getById(contactId);
    if (!contact || contact.phone_ref === true) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }

    // 2. Parse kinds / cursor / limit (all validated → 400 on bad input).
    const kinds = parseKinds(req.query['kinds']);
    if (kinds === undefined) {
      res.status(400).json({ error: 'kinds must be a comma list of: message, call, milestone' });
      return;
    }
    const limit = parseLimit(req.query['limit']);
    if (limit === undefined) {
      res.status(400).json({ error: `limit must be an integer 1..${MAX_PAGE_LIMIT}` });
      return;
    }
    let boundaryKey: string | undefined;
    const rawCursor = req.query['cursor'];
    if (rawCursor !== undefined) {
      boundaryKey = typeof rawCursor === 'string' ? decodeCursor(rawCursor) : undefined;
      if (boundaryKey === undefined) {
        res.status(400).json({ error: 'invalid cursor' });
        return;
      }
    }

    // 3. Resolve the contact's numbers (BE1) → the deduped set of 1:1
    // conversationIds. relay_group threads front a pool number (never the
    // contact's real phone), so they are naturally excluded — group-text
    // activity surfaces as milestones, never inlined content.
    const phones = contactPhones(contact).map((p) => p.phone);
    const convById = new Map<string, ConversationItem>();
    for (const phone of phones) {
      const linked = await conversations.findByParticipantPhone(phone);
      for (const conv of linked) {
        if (conv.type === 'relay_group') continue; // pool-number thread, not 1:1
        if (!convById.has(conv.conversationId)) convById.set(conv.conversationId, conv);
      }
    }

    const wantMessage = kinds.has('message');
    const wantCall = kinds.has('call');
    const wantMilestone = kinds.has('milestone');
    const ourNumber = ourNumberOf(config);

    // 4. Candidate gather — fetch limit+1 from EACH source, all bounded
    //    `< boundaryKey`, so the merge can decide whether more pages remain.
    const candidates: Candidate[] = [];

    if (wantMessage || wantCall) {
      for (const conv of convById.values()) {
        const page = await messages.listByConversation(conv.conversationId, {
          limit: limit + 1,
          ...(boundaryKey !== undefined && { before: boundaryKey }),
        });
        for (const m of page) {
          if (m.type === 'call') {
            if (!wantCall) continue;
            candidates.push({ globalKey: m.tsMsgId, item: toTimelineCall(m, conv) });
          } else {
            if (!wantMessage) continue;
            candidates.push({ globalKey: m.tsMsgId, item: toTimelineMessage(m, conv, ourNumber) });
          }
        }
      }
    }

    if (wantMilestone) {
      const { items } = await activityEvents.listByContact(contactId, {
        limit: limit + 1,
        ...(boundaryKey !== undefined && { before: boundaryKey }),
      });
      for (const e of items) {
        candidates.push({ globalKey: e.tsEventId, item: toTimelineMilestone(e) });
      }
    }

    // 5. Merge: sort DESC by the global key, take the newest `limit`. If the
    //    candidate pool had MORE than `limit`, there is another (older) page →
    //    nextCursor = the last returned item's key (the next EXCLUSIVE bound).
    candidates.sort((a, b) => (a.globalKey < b.globalKey ? 1 : a.globalKey > b.globalKey ? -1 : 0));
    const page = candidates.slice(0, limit);
    const hasMore = candidates.length > limit;
    const nextCursor =
      hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!.globalKey) : null;

    log.info(
      {
        contactId,
        conversationCount: convById.size,
        candidateCount: candidates.length,
        returned: page.length,
        hasMore,
      },
      'contact timeline page served',
    );

    // 6. Respond newest-first (the cursor pages backward in time).
    res.json({ items: page.map((c) => c.item), nextCursor });
  });

  return router;
}
