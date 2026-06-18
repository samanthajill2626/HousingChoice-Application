// Contact routes — triage (M1.4) + full list/create CRUD (M1.5). Mounted under
// /api/contacts (behind requireAuth; VAs run day-to-day, so NO admin gate).
//
//   GET   /api/contacts?type=&status=&phone=&limit=&cursor=  → { contacts, nextCursor }   (M1.5)
//   POST  /api/contacts  { type, firstName, lastName, phone, … }  → 201 { contact } | 409  (M1.5)
//   GET   /api/contacts/:contactId   → { contact }                                          (M1.4)
//   PATCH /api/contacts/:contactId   { type?, firstName?, lastName?, voucherSize?, status?, notes? }
//                                    → { contact }                                          (M1.4)
//
// THE M1.5 SEAM the honest-identity deviation left (README 2026-06-12):
// resolving a contact's type to tenant/landlord PROPAGATES that to the linked
// conversation(s)' type (unknown_1to1 → tenant_1to1/landlord_1to1). Triage
// happens HERE, so the propagation is implemented HERE.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { Router } from 'express';
import { parseContactName } from '../lib/contactName.js';
import { appEvents, toConversationUpdatedEvent, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { mergeContext } from '../lib/context.js';
import { normalizeToE164 } from '../lib/phone.js';
import { parseRole, parseRelationships, parseCustomFields } from '../lib/contactProfile.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import {
  contactPhones,
  createContactsRepo,
  PrimaryPhoneRemovalError,
  type ContactItem,
  type ContactsRepo,
  type ContactType,
  type ListContactsOpts,
} from '../repos/contactsRepo.js';
import {
  createConversationsRepo,
  type ConversationsRepo,
  type ConversationType,
} from '../repos/conversationsRepo.js';
import {
  createMessagesRepo,
  mediaAttachmentsOf,
  type MessagesRepo,
} from '../repos/messagesRepo.js';
import {
  createActivityEventsRepo,
  type ActivityEventsRepo,
} from '../repos/activityEventsRepo.js';
import {
  createListingSendsRepo,
  toListingSendRow,
  type ListingSendsRepo,
} from '../repos/listingSendsRepo.js';
import {
  createContactVocabularyRepo,
  type ContactVocabularyRepo,
} from '../repos/contactVocabularyRepo.js';

export interface ContactsRouterDeps {
  logger?: Logger;
  contactsRepo?: ContactsRepo;
  conversationsRepo?: ConversationsRepo;
  /** BE5/C5: aggregate a contact's media across their conversations (GET /:id/media). */
  messagesRepo?: MessagesRepo;
  auditRepo?: AuditRepo;
  /** BE2/C2: emit a `number_added` milestone on a successful phone add. */
  activityEventsRepo?: ActivityEventsRepo;
  /** BE4/C4: serve a contact's "Listings sent" (GET /:id/listings-sent). */
  listingSendsRepo?: ListingSendsRepo;
  /** Task 4: auto-suggest vocabulary (roles, relationship roles, field labels). */
  vocabularyRepo?: ContactVocabularyRepo;
  /** SSE live-update bus (M1.2); the process singleton by default. */
  events?: EventBus;
}

/**
 * BE5/C5 wire shape (VERBATIM — the frontend imports identical field names).
 * One mirrored media attachment surfaced on the contact's Media panel: its S3
 * key + normalized content-type, the source message's provider_ts, and the 1:1
 * conversation it lives on. NO URL is generated — the frontend fetches bytes via
 * the existing GET /api/messages/:sid/media/:idx endpoint using s3Key.
 */
interface ContactMediaItem {
  s3Key: string;
  contentType: string;
  /** ISO 8601 — the source message's provider_ts (the sort key). */
  at: string;
  conversationId: string;
}

/**
 * Bound on messages pulled per conversation when aggregating media. The contact
 * media panel is a recent-media view, not an archive; a single page per
 * conversation at this scale covers the working set. If a conversation has more
 * than this, the older media is dropped — and that drop is LOGGED (no silent
 * truncation). Generous (a thread rarely has hundreds of MMS).
 */
const MEDIA_SCAN_PAGE_LIMIT = 200;

/** The contact types triage may set (the full union incl. 'unknown'). */
const CONTACT_TYPES: readonly ContactType[] = [
  'tenant',
  'landlord',
  'team_member',
  'unknown',
] as const;

function isContactType(value: unknown): value is ContactType {
  return typeof value === 'string' && (CONTACT_TYPES as readonly string[]).includes(value);
}

/**
 * Allowed contact lifecycle statuses (L1). Triage previously accepted ANY
 * string, which polluted the byTypeStatus GSI (the human-triage queue keys on
 * (type, status)) with arbitrary values. These are the lifecycle values the
 * codebase actually writes: 'needs_review' (auto-capture stub) → 'active'
 * (resolved). An unknown status is a 400.
 */
const CONTACT_STATUSES: readonly string[] = ['needs_review', 'active'] as const;

// --- M1.5 list pagination + cursor -----------------------------------------
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

/** Parse ?limit= into 1..MAX_PAGE_LIMIT (default). undefined ⇒ 400 upstream. */
function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined) return DEFAULT_PAGE_LIMIT;
  if (typeof raw !== 'string') return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) return undefined;
  return limit;
}

function encodeCursor(lastEvaluatedKey: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(lastEvaluatedKey), 'utf8').toString('base64url');
}

/**
 * Decode a byTypeStatus cursor. The ExclusiveStartKey carries the base-table
 * key (contactId) plus the GSI keys (type, status) — a small flat scalar
 * object. Validate the SHAPE (1..3 string attributes) before it becomes a
 * DynamoDB key; a tampered cursor must never reach DynamoDB malformed.
 */
function decodeCursor(cursor: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const key = parsed as Record<string, unknown>;
    const entries = Object.entries(key);
    if (entries.length < 1 || entries.length > 3) return undefined;
    for (const [, v] of entries) if (typeof v !== 'string') return undefined;
    return key;
  } catch {
    return undefined;
  }
}

/**
 * Decode a URL-encoded :phone route param to a normalized E.164, or undefined
 * when it's missing/malformed/uncanonicalizable. decodeURIComponent throws
 * URIError on a malformed %-sequence (e.g. `%E0%A4%A`) — caught here so the
 * route returns a 400 (invalid phone) instead of a 500 + an error-logs alarm.
 */
function decodePhoneParam(raw: unknown): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(String(raw ?? ''));
  } catch {
    // URIError on a malformed escape → treat as an invalid phone (400).
    return undefined;
  }
  return normalizeToE164(decoded);
}

/** A resolved-identity 1:1 type for the conversation, or undefined when not propagatable. */
function conversationTypeFor(contactType: ContactType): ConversationType | undefined {
  if (contactType === 'tenant') return 'tenant_1to1';
  if (contactType === 'landlord') return 'landlord_1to1';
  // team_member/unknown have no 1:1 conversation type to propagate.
  return undefined;
}

/**
 * The denormalized inbox display name from a contact's resolved fields:
 * `firstName`/`lastName` joined and trimmed → a non-empty string, else null.
 * HONEST: returns null when no name is known — the inbox falls back to the
 * phone; a name is NEVER invented. PII (doc §9): the name is data, never
 * logged here.
 */
function displayNameOf(contact: ContactItem): string | null {
  const first = typeof contact.firstName === 'string' ? contact.firstName : '';
  const last = typeof contact.lastName === 'string' ? contact.lastName : '';
  const joined = `${first} ${last}`.trim();
  return joined.length > 0 ? joined : null;
}

interface TriagePatch {
  patch: Record<string, unknown>;
  /** The fields actually changed (for the audit event). */
  changedFields: string[];
}

/**
 * Validate the triage body into a contacts patch. Returns the patch + the
 * list of changed field names, or an error message. Accepts EITHER structured
 * fields OR a raw "First Last - N Bed" string (parsed via the one true
 * parser). Never blanks a name that was set unless explicitly cleared (empty
 * string clears; absent leaves untouched — the repo's SET-merge enforces it).
 */
function parseTriageBody(body: unknown): TriagePatch | { error: string } {
  if (typeof body !== 'object' || body === null) {
    return { error: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  const changedFields: string[] = [];

  // A raw "First Last - N Bed" convention string the dashboard may send
  // instead of structured fields — parse it with the one true parser.
  if ('contactName' in b) {
    const raw = b['contactName'];
    if (typeof raw !== 'string') return { error: 'contactName must be a string' };
    const parsed = parseContactName(raw);
    if (parsed === undefined) {
      return { error: 'contactName does not match the "First Last - N Bed" convention' };
    }
    patch['firstName'] = parsed.firstName;
    patch['lastName'] = parsed.lastName;
    patch['voucherSize'] = parsed.voucherSize;
    changedFields.push('firstName', 'lastName', 'voucherSize');
  }

  if ('type' in b) {
    if (!isContactType(b['type'])) {
      return { error: `type must be one of: ${CONTACT_TYPES.join(', ')}` };
    }
    patch['type'] = b['type'];
    changedFields.push('type');
  }
  if ('firstName' in b) {
    const v = b['firstName'];
    if (typeof v !== 'string') return { error: 'firstName must be a string' };
    patch['firstName'] = v;
    changedFields.push('firstName');
  }
  if ('lastName' in b) {
    const v = b['lastName'];
    if (typeof v !== 'string') return { error: 'lastName must be a string' };
    patch['lastName'] = v;
    changedFields.push('lastName');
  }
  if ('voucherSize' in b) {
    const v = b['voucherSize'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 12) {
      return { error: 'voucherSize must be an integer 0..12' };
    }
    patch['voucherSize'] = v;
    changedFields.push('voucherSize');
  }
  if ('status' in b) {
    const v = b['status'];
    if (typeof v !== 'string' || !CONTACT_STATUSES.includes(v)) {
      return { error: `status must be one of: ${CONTACT_STATUSES.join(', ')}` };
    }
    patch['status'] = v;
    changedFields.push('status');
  }
  if ('notes' in b) {
    const v = b['notes'];
    if (typeof v !== 'string') return { error: 'notes must be a string' };
    patch['notes'] = v;
    changedFields.push('notes');
  }
  // Landlord/PM company name (edit form). Free text; empty string clears it.
  if ('company' in b) {
    const v = b['company'];
    if (typeof v !== 'string') return { error: 'company must be a string' };
    patch['company'] = v;
    changedFields.push('company');
  }
  // Tenant housing authority (edit form). camelCase — it's the byHousingAuthority
  // GSI hash key, so writing it re-indexes the contact for broadcast targeting.
  if ('housingAuthority' in b) {
    const v = b['housingAuthority'];
    if (typeof v !== 'string') return { error: 'housingAuthority must be a string' };
    patch['housingAuthority'] = v;
    changedFields.push('housingAuthority');
  }
  // Structured postal address (edit form). Every part optional; we store only the
  // non-empty parts (a SET-merge replaces the whole address object).
  if ('address' in b) {
    const v = b['address'];
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return { error: 'address must be an object' };
    }
    const a = v as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const key of ['line1', 'line2', 'city', 'state', 'zip'] as const) {
      const part = a[key];
      if (part !== undefined) {
        if (typeof part !== 'string') return { error: `address.${key} must be a string` };
        const trimmed = part.trim();
        if (trimmed.length > 0) out[key] = trimmed;
      }
    }
    patch['address'] = out;
    changedFields.push('address');
  }

  if ('role' in b) {
    const r = parseRole(b['role']);
    if (typeof r !== 'string') return r;
    patch['role'] = r.length > 0 ? r : null;  // null → REMOVE the attribute (clear the role)
    changedFields.push('role');
  }
  if ('relationships' in b) {
    const rels = parseRelationships(b['relationships']);
    if (!Array.isArray(rels)) return rels;
    patch['relationships'] = rels;
    changedFields.push('relationships');
  }
  if ('customFields' in b) {
    const cf = parseCustomFields(b['customFields']);
    if (!Array.isArray(cf)) return cf;
    patch['customFields'] = cf;
    changedFields.push('customFields');
  }

  if (changedFields.length === 0) {
    return { error: 'no updatable fields supplied' };
  }
  return { patch, changedFields };
}

/** A validated manual-create contact body (the fields actually persisted). */
interface CreateContactResult {
  /** The contact attributes to store (sans contactId — the repo generates it). */
  item: Partial<ContactItem> & { type: ContactType };
  /** Normalized E.164 phone (the dedupe key), when one was supplied. */
  phone?: string;
}

/**
 * Validate the manual-create body (M1.5). Required: a valid `type`. Optional:
 * firstName/lastName/phone/voucherSize/notes/status, plus the "First Last - N
 * Bed" convenience string via `contactName` (the one true parser). Phone is
 * normalized to E.164 and rejected when it can't be canonicalized. A manual
 * create defaults status to 'active' (the human entering it knows who it is) —
 * unlike auto-capture stubs, which are 'needs_review'.
 */
function parseCreateBody(body: unknown): CreateContactResult | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;

  if (!isContactType(b['type'])) {
    return { error: `type is required and must be one of: ${CONTACT_TYPES.join(', ')}` };
  }
  const item: Partial<ContactItem> & { type: ContactType } = { type: b['type'] };

  // Convenience: "First Last - N Bed" → firstName/lastName/voucherSize.
  if ('contactName' in b) {
    const raw = b['contactName'];
    if (typeof raw !== 'string') return { error: 'contactName must be a string' };
    const parsed = parseContactName(raw);
    if (parsed === undefined) {
      return { error: 'contactName does not match the "First Last - N Bed" convention' };
    }
    item.firstName = parsed.firstName;
    item.lastName = parsed.lastName;
    item.voucherSize = parsed.voucherSize;
  }

  if ('firstName' in b) {
    if (typeof b['firstName'] !== 'string') return { error: 'firstName must be a string' };
    item.firstName = b['firstName'];
  }
  if ('lastName' in b) {
    if (typeof b['lastName'] !== 'string') return { error: 'lastName must be a string' };
    item.lastName = b['lastName'];
  }
  if ('voucherSize' in b) {
    const v = b['voucherSize'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 12) {
      return { error: 'voucherSize must be an integer 0..12' };
    }
    item.voucherSize = v;
  }
  if ('notes' in b) {
    if (typeof b['notes'] !== 'string') return { error: 'notes must be a string' };
    item.notes = b['notes'];
  }
  if ('status' in b) {
    const v = b['status'];
    if (typeof v !== 'string' || !CONTACT_STATUSES.includes(v)) {
      return { error: `status must be one of: ${CONTACT_STATUSES.join(', ')}` };
    }
    item.status = v;
  }

  let phone: string | undefined;
  if ('phone' in b && b['phone'] !== undefined && b['phone'] !== '') {
    if (typeof b['phone'] !== 'string') return { error: 'phone must be a string' };
    const normalized = normalizeToE164(b['phone']);
    if (normalized === undefined) {
      return { error: 'phone is not a valid phone number' };
    }
    phone = normalized;
    item.phone = normalized;
  }

  if ('company' in b) {
    if (typeof b['company'] !== 'string') return { error: 'company must be a string' };
    item.company = b['company'];
  }
  if ('role' in b) {
    const r = parseRole(b['role']);
    if (typeof r !== 'string') return r;            // { error }
    if (r.length > 0) item.role = r;
  }
  if ('relationships' in b) {
    const rels = parseRelationships(b['relationships']);
    if (!Array.isArray(rels)) return rels;          // { error }
    item.relationships = rels;
  }
  if ('customFields' in b) {
    const cf = parseCustomFields(b['customFields']);
    if (!Array.isArray(cf)) return cf;              // { error }
    item.customFields = cf;
  }

  // A manual create asserts identity — default to active (not needs_review).
  if (item.status === undefined) item.status = 'active';

  return { item, ...(phone !== undefined && { phone }) };
}

export function createContactsRouter(deps: ContactsRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const activityEvents =
    deps.activityEventsRepo ?? createActivityEventsRepo({ logger: deps.logger });
  const listingSends = deps.listingSendsRepo ?? createListingSendsRepo({ logger: deps.logger });
  const vocabulary = deps.vocabularyRepo ?? createContactVocabularyRepo({ logger: deps.logger });
  const events = deps.events ?? appEvents;

  const router = Router();

  // GET /api/contacts?type=&status=&phone=&limit=&cursor= — list/filter (M1.5).
  // ?phone= is an exact byPhone lookup (returns 0 or 1) and takes priority;
  // otherwise ?type= drives a byTypeStatus Query (optionally narrowed by
  // ?status=). `type` is REQUIRED when not doing a phone lookup — a bare list
  // of ALL contacts would be an unbounded Scan, deliberately not offered.
  router.get('/', async (req, res) => {
    const rawPhone = req.query['phone'];
    if (typeof rawPhone === 'string' && rawPhone.length > 0) {
      const normalized = normalizeToE164(rawPhone);
      if (normalized === undefined) {
        res.status(400).json({ error: 'phone is not a valid phone number' });
        return;
      }
      const contact = await contacts.findByPhone(normalized);
      res.json({ contacts: contact ? [contact] : [], nextCursor: null });
      return;
    }

    const rawType = req.query['type'];
    if (typeof rawType !== 'string' || !isContactType(rawType)) {
      res.status(400).json({ error: `type must be one of: ${CONTACT_TYPES.join(', ')} (or pass phone=)` });
      return;
    }

    const limit = parseLimit(req.query['limit']);
    if (limit === undefined) {
      res.status(400).json({ error: `limit must be an integer 1..${MAX_PAGE_LIMIT}` });
      return;
    }

    const rawStatus = req.query['status'];
    let status: string | undefined;
    if (typeof rawStatus === 'string' && rawStatus.length > 0) {
      if (!CONTACT_STATUSES.includes(rawStatus)) {
        res.status(400).json({ error: `status must be one of: ${CONTACT_STATUSES.join(', ')}` });
        return;
      }
      status = rawStatus;
    }

    let exclusiveStartKey: Record<string, unknown> | undefined;
    const rawCursor = req.query['cursor'];
    if (rawCursor !== undefined) {
      exclusiveStartKey = typeof rawCursor === 'string' ? decodeCursor(rawCursor) : undefined;
      if (exclusiveStartKey === undefined) {
        res.status(400).json({ error: 'invalid cursor' });
        return;
      }
    }

    const opts: ListContactsOpts = {
      limit,
      ...(status !== undefined && { status }),
      ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
    };
    const page = await contacts.listByType(rawType, opts);
    res.json({
      contacts: page.items,
      nextCursor:
        page.lastEvaluatedKey !== undefined ? encodeCursor(page.lastEvaluatedKey) : null,
    });
  });

  // POST /api/contacts — manual create with phone dedupe (M1.5). DEDUPE POLICY:
  // if a contact already exists for the (normalized) phone, return 409 with the
  // existing contact rather than creating a duplicate — the byPhone GSI is the
  // hottest lookup and one-contact-per-phone keeps it honest. A create without
  // a phone is always allowed (no dedupe key).
  router.post('/', async (req: AuthedRequest, res) => {
    const parsed = parseCreateBody(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    if (parsed.phone !== undefined) {
      const existing = await contacts.findByPhone(parsed.phone);
      if (existing) {
        // 409 + the existing record so the client can adopt it (the frontend
        // shows "this phone already exists" and links to it).
        res.status(409).json({ error: 'contact_exists', contact: existing });
        return;
      }
    }

    const contact = await contacts.create(parsed.item);
    await audit.append(`contacts#${contact.contactId}`, 'contact_created', {
      actor: req.user?.userId,
      type: contact.type,
      source: 'manual',
    });
    log.info(
      { contactId: contact.contactId, type: contact.type, actor: req.user?.userId },
      'contact created via api',
    );
    // Best-effort vocabulary write: collect tokens from the newly created contact.
    // Never fails the response — if DynamoDB is unavailable, the create still succeeds.
    try {
      const { item } = parsed;
      const vocabRoles =
        typeof item.role === 'string' && item.role.length > 0 ? [item.role] : [];
      const vocabRels = Array.isArray(item.relationships)
        ? item.relationships.map((r) => r.role)
        : [];
      const vocabCf = Array.isArray(item.customFields)
        ? item.customFields.map((c) => c.label)
        : [];
      await vocabulary.add({
        ...(vocabRoles.length > 0 && { roles: vocabRoles }),
        ...(vocabRels.length > 0 && { relationshipRoles: vocabRels }),
        ...(vocabCf.length > 0 && { fieldLabels: vocabCf }),
      });
    } catch (err) {
      log.warn({ err, contactId: contact.contactId }, 'vocabulary add failed (best-effort)');
    }
    res.status(201).json({ contact });
  });

  // GET /api/contacts/vocabulary — auto-suggest vocabulary (sorted, deduped).
  // MUST be registered BEFORE GET /:contactId so the literal segment `vocabulary`
  // is not captured as a contactId param.
  router.get('/vocabulary', async (_req, res) => {
    const vocab = await vocabulary.get();
    res.json({ vocabulary: vocab });
  });

  // GET /api/contacts/:contactId — the side-panel contact item. The returned
  // shape is a SUPERSET of the legacy one: the scalar `phone` stays intact and
  // `phones` (C1) is populated from contactPhones() (back-compat: a scalar-only
  // contact serializes as [{phone, primary:true}]). Never mutates stored items.
  router.get('/:contactId', async (req, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    const contact = await contacts.getById(contactId);
    if (!contact) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }
    // BE1 hardening: a phone-pointer item (phone_ref) is an INTERNAL routing
    // record, not a contact — never surface it as one. (Repo getById stays
    // pointer-returning because the pointer-hop in findByPhone relies on it; the
    // guard lives at the route only.)
    if (contact.phone_ref === true) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }
    res.json({ contact: { ...contact, phones: contactPhones(contact) } });
  });

  // GET /api/contacts/:contactId/listings-sent — the tenant page's "Listings
  // sent" (BE4/C4). Returns { sent: ListingSendRow[] } via listByContact
  // (newest-first by sentAt). Returns [] for none. A phone-pointer id (BE1's
  // internal routing record) is a 404 — never a contact, never a listings owner.
  // (`listings-sent` is a distinct segment from the bare :contactId routes, so
  // there is no route collision.)
  router.get('/:contactId/listings-sent', async (req, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    const contact = await contacts.getById(contactId);
    if (!contact || contact.phone_ref === true) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }
    const rows = await listingSends.listByContact(contactId);
    res.json({ sent: rows.map(toListingSendRow) });
  });

  // GET /api/contacts/:contactId/media → { media: ContactMediaItem[] } (BE5/C5).
  // The tenant/landlord page's Media panel: every mirrored MMS attachment across
  // the contact's 1:1 conversations (ALL their numbers), newest-first. Reuses the
  // timeline's cross-phone resolution (contactPhones → findByParticipantPhone →
  // dedupe conversationIds) and EXCLUDES relay_group threads (those front a pool
  // number, never the contact's real 1:1 — group-text media is never inlined).
  // 404 unknown contact / phone-pointer id (mirrors BE1's GET). Returns [] for a
  // contact with no media (never a 404 for "no media"). NO URL is generated —
  // the frontend fetches bytes via GET /api/messages/:sid/media/:idx using s3Key.
  // Auth-gated (this router sits behind requireAuth via the /api mount).
  router.get('/:contactId/media', async (req, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    const contact = await contacts.getById(contactId);
    if (!contact || contact.phone_ref === true) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }

    // Resolve the contact's 1:1 conversations across ALL their numbers — exactly
    // like the merged timeline. relay_group threads front a pool number (never
    // the contact's real phone), so they are excluded purely on type.
    const phones = contactPhones(contact).map((p) => p.phone);
    const convById = new Map<string, string>(); // conversationId → (presence)
    for (const phone of phones) {
      const linked = await conversations.findByParticipantPhone(phone);
      for (const conv of linked) {
        if (conv.type === 'relay_group') continue; // pool-number thread, not 1:1
        convById.set(conv.conversationId, conv.conversationId);
      }
    }

    // Single pass: collect every attachment of every media-bearing message.
    const media: ContactMediaItem[] = [];
    for (const conversationId of convById.keys()) {
      // Probe one PAST the cap (limit = cap + 1): if MORE than the cap came back
      // the thread is genuinely truncated; a thread of EXACTLY the cap is
      // complete (no false-positive warn). Process at most the newest `cap`.
      const fetched = await messages.listByConversation(conversationId, {
        limit: MEDIA_SCAN_PAGE_LIMIT + 1,
      });
      const truncated = fetched.length > MEDIA_SCAN_PAGE_LIMIT;
      const page = truncated ? fetched.slice(0, MEDIA_SCAN_PAGE_LIMIT) : fetched;
      if (truncated) {
        // No silent truncation — record that older media for this thread was not
        // scanned (the page is newest-first, so the dropped media is the oldest).
        log.warn(
          { contactId, conversationId, scanned: page.length, cap: MEDIA_SCAN_PAGE_LIMIT },
          'contact media: conversation hit the scan cap — older media not aggregated',
        );
      }
      for (const m of page) {
        const attachments = mediaAttachmentsOf(m);
        for (const a of attachments) {
          media.push({
            s3Key: a.s3Key,
            contentType: a.contentType,
            at: m.provider_ts,
            conversationId,
          });
        }
      }
    }

    // Newest-first by `at`; stable tie-break by s3Key so equal-timestamp items
    // (and multiple attachments on one message) order deterministically.
    media.sort((a, b) =>
      a.at < b.at ? 1 : a.at > b.at ? -1 : a.s3Key < b.s3Key ? -1 : a.s3Key > b.s3Key ? 1 : 0,
    );

    log.info({ contactId, conversationCount: convById.size, mediaCount: media.length }, 'contact media served');
    res.json({ media });
  });

  // PATCH /api/contacts/:contactId — triage an existing contact.
  router.patch('/:contactId', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });

    const parsed = parseTriageBody(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    // The resolved 1:1 type, if triage set type=tenant|landlord this PATCH.
    const newType = parsed.patch['type'];
    const convType = isContactType(newType) ? conversationTypeFor(newType) : undefined;

    // AUTO-ADVANCE (Cluster A): resolving identity to tenant|landlord moves the
    // contact off the needs_review triage queue at the moment the identity is
    // known — but only when the caller didn't set status itself (an explicit
    // status always wins). 'active' is allowlisted in CONTACT_STATUSES. We
    // never auto-advance for unknown/team_member (they don't resolve a 1:1
    // identity) — and we never fabricate a name to do it.
    if (convType !== undefined && !('status' in parsed.patch)) {
      parsed.patch['status'] = 'active';
      parsed.changedFields.push('status');
    }

    let updated;
    try {
      updated = await contacts.update(contactId, parsed.patch);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'contact_not_found' });
        return;
      }
      throw err;
    }

    // DENORMALIZE (Cluster D): the inbox is one Query and the conversation row
    // carries no name — copy the resolved "First Last" onto the linked
    // thread(s) so rows show the person, not the phone. HONEST: null when no
    // name is known (the inbox falls back to the phone, never a guess).
    const displayName = displayNameOf(updated);

    // PROPAGATE resolved identity + name to the linked conversation(s) (the
    // M1.5 seam) and EMIT a live conversation.updated for each touched thread
    // so connected inboxes update without a reload (Cluster C).
    let propagatedConversations = 0;
    const phone = typeof updated.phone === 'string' ? updated.phone : undefined;
    // Touch threads when EITHER identity resolved (flip unknown_1to1) OR a name
    // is known to denormalize (so naming a contact without typing it still
    // surfaces in the inbox).
    if (phone !== undefined && (convType !== undefined || displayName !== null)) {
      const linked = await conversations.findByParticipantPhone(phone);
      for (const conv of linked) {
        // Only FLIP an UNKNOWN thread — never re-type a thread already resolved
        // to a different identity (a triage conflict the human must reconcile,
        // never silently overwritten). The name still denormalizes onto it.
        const flipType = convType !== undefined && conv.type === 'unknown_1to1';
        if (!flipType && displayName === null) continue; // nothing to write
        const fresh = await conversations.applyTriage(conv.conversationId, {
          ...(flipType && { type: convType }),
          displayName, // null leaves the name untouched
        });
        if (flipType) propagatedConversations += 1;
        events.emit('conversation.updated', toConversationUpdatedEvent(fresh));
      }
    }

    await audit.append(`contacts#${contactId}`, 'contact_updated', {
      fields: parsed.changedFields,
      actor: req.user?.userId,
      ...(propagatedConversations > 0 && { propagatedConversations, conversationType: convType }),
    });
    log.info(
      { contactId, fields: parsed.changedFields, propagatedConversations, actor: req.user?.userId },
      'contact triaged',
    );

    // Best-effort vocabulary write: collect tokens from this patch.
    // Never fails the response.
    try {
      const patchRoles =
        typeof parsed.patch['role'] === 'string' && parsed.patch['role'].length > 0
          ? [parsed.patch['role']]
          : [];
      const patchRels = Array.isArray(parsed.patch['relationships'])
        ? (parsed.patch['relationships'] as { role: string }[]).map((r) => r.role)
        : [];
      const patchCf = Array.isArray(parsed.patch['customFields'])
        ? (parsed.patch['customFields'] as { label: string }[]).map((c) => c.label)
        : [];
      await vocabulary.add({
        ...(patchRoles.length > 0 && { roles: patchRoles }),
        ...(patchRels.length > 0 && { relationshipRoles: patchRels }),
        ...(patchCf.length > 0 && { fieldLabels: patchCf }),
      });
    } catch (err) {
      log.warn({ err, contactId }, 'vocabulary add failed on patch (best-effort)');
    }

    res.json({ contact: updated });
  });

  // POST /api/contacts/:contactId/opt-out { optOut: boolean } → 200 { contact }.
  // Manually mark a contact Do-Not-Contact (sms_opt_out=true) or clear it. The
  // contact-level flag is authoritative for send suppression — the send wrapper
  // refuses on contact.sms_opt_out (sendMessage.ts gate) — so setting it here
  // stops outbound texts immediately, mirroring an inbound STOP. Clearing it is a
  // staff override (e.g. the contact re-consented by phone); the audit trail
  // records who toggled it. (Conversation-level denorm isn't propagated here; the
  // contact flag governs suppression.)
  router.post('/:contactId/opt-out', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });

    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b['optOut'] !== 'boolean') {
      res.status(400).json({ error: 'optOut (boolean) is required' });
      return;
    }
    const optOut = b['optOut'];

    // Existence check up front so the 404 is independent of how setFlag signals a
    // missing row (the real repo throws ConditionalCheckFailedException).
    const existing = await contacts.getById(contactId);
    if (!existing) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }

    if (optOut) {
      await contacts.setFlag(contactId, 'sms_opt_out');
    } else {
      await contacts.clearFlag(contactId, 'sms_opt_out');
    }

    await audit.append(`contacts#${contactId}`, 'contact_opt_out_changed', {
      optOut,
      actor: req.user?.userId,
    });
    log.info({ contactId, optOut, actor: req.user?.userId }, 'contact sms_opt_out toggled');
    // Reflect the new flag without a second round-trip.
    res.json({ contact: withPhones({ ...existing, sms_opt_out: optOut }) });
  });

  // --- BE1/C1 contact-phones CRUD (manual curation / merge) ------------------
  // The response always re-serializes phones via contactPhones() so the wire
  // shape is consistent with GET /:contactId (an addPhone that just materialized
  // phones[] from the scalar still returns the canonical array).
  function withPhones(contact: ContactItem): ContactItem & { phones: ReturnType<typeof contactPhones> } {
    return { ...contact, phones: contactPhones(contact) };
  }

  // POST /api/contacts/:contactId/phones { phone, label? } → 200 { contact }.
  // 200 (not 201): this is an idempotent upsert into the contact's phone roster
  // returning the parent contact (re-posting the same number is a no-op), NOT a
  // new top-level resource — consistent with POST /api/units/:id/contacts (BE3).
  // 404 unknown contact; 400 invalid body; 409 when the (normalized) number
  // already resolves to a DIFFERENT contact (one-number-per-contact, mirroring
  // the POST / dedupe policy).
  router.post('/:contactId/phones', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });

    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const b = body as Record<string, unknown>;
    if (typeof b['phone'] !== 'string') {
      res.status(400).json({ error: 'phone is required and must be a string' });
      return;
    }
    const normalized = normalizeToE164(b['phone']);
    if (normalized === undefined) {
      res.status(400).json({ error: 'phone is not a valid phone number' });
      return;
    }
    let label: string | undefined;
    if ('label' in b) {
      if (typeof b['label'] !== 'string') {
        res.status(400).json({ error: 'label must be a string' });
        return;
      }
      label = b['label'];
    }

    // Conflict guard: the number must not already resolve to another contact
    // (findByPhone is pointer-aware, so this covers BOTH a primary scalar AND a
    // pointer-attached number on some other contact). A number that already
    // resolves to THIS contact falls through to addPhone's idempotent no-op.
    const owner = await contacts.findByPhone(normalized);
    if (owner && owner.contactId !== contactId) {
      res.status(409).json({ error: 'phone_in_use', contact: owner });
      return;
    }

    // Was the number already attached? addPhone is an idempotent no-op for an
    // existing number — so we only emit the `number_added` milestone for a
    // genuinely NEW number (computed before the write, from the resolved owner
    // above: a known number resolving to THIS contact is already attached).
    const alreadyAttached = owner?.contactId === contactId;

    let updated: ContactItem;
    try {
      updated = await contacts.addPhone(contactId, {
        phone: normalized,
        ...(label !== undefined && { label }),
      });
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'contact_not_found' });
        return;
      }
      throw err;
    }

    await audit.append(`contacts#${contactId}`, 'contact_phone_added', {
      actor: req.user?.userId,
      phone: normalized,
    });
    // BE2/C2: a real number-add is a timeline milestone. Best-effort — a log
    // failure must never fail the curation action (the phone is already saved).
    if (!alreadyAttached) {
      try {
        await activityEvents.record({
          contactId,
          type: 'number_added',
          label: 'Number added',
        });
      } catch (err) {
        log.error({ err, contactId }, 'contact phone: recording number_added milestone failed');
      }
    }
    log.info({ contactId, actor: req.user?.userId }, 'contact phone added via api');
    res.status(200).json({ contact: withPhones(updated) });
  });

  // PATCH /api/contacts/:contactId/phones/:phone { primary?, label? } → { contact }.
  // :phone is a URL-encoded E.164; decode + normalize. 404 contact-or-phone
  // missing; 400 invalid body / no updatable field.
  router.patch('/:contactId/phones/:phone', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    const normalized = decodePhoneParam(req.params['phone']);
    if (normalized === undefined) {
      res.status(400).json({ error: 'phone is not a valid phone number' });
      return;
    }

    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const b = body as Record<string, unknown>;
    const opts: { primary?: boolean; label?: string } = {};
    if ('primary' in b) {
      if (typeof b['primary'] !== 'boolean') {
        res.status(400).json({ error: 'primary must be a boolean' });
        return;
      }
      opts.primary = b['primary'];
    }
    if ('label' in b) {
      if (typeof b['label'] !== 'string') {
        res.status(400).json({ error: 'label must be a string' });
        return;
      }
      opts.label = b['label'];
    }
    if (opts.primary === undefined && opts.label === undefined) {
      res.status(400).json({ error: 'no updatable fields supplied (primary and/or label)' });
      return;
    }

    let updated: ContactItem;
    try {
      updated = await contacts.setPhone(contactId, normalized, opts);
    } catch (err) {
      // setPhone throws the conditional-check error for BOTH an unknown contact
      // and a phone not on the contact — either way the resource isn't there.
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'contact_or_phone_not_found' });
        return;
      }
      throw err;
    }

    await audit.append(`contacts#${contactId}`, 'contact_phone_updated', {
      actor: req.user?.userId,
      phone: normalized,
      ...(opts.primary !== undefined && { primary: opts.primary }),
    });
    log.info({ contactId, actor: req.user?.userId }, 'contact phone updated via api');
    res.json({ contact: withPhones(updated) });
  });

  // DELETE /api/contacts/:contactId/phones/:phone → 200 { contact }. 404
  // contact-or-phone missing; 409 when removing the primary while others remain.
  router.delete('/:contactId/phones/:phone', async (req: AuthedRequest, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    const normalized = decodePhoneParam(req.params['phone']);
    if (normalized === undefined) {
      res.status(400).json({ error: 'phone is not a valid phone number' });
      return;
    }

    let updated: ContactItem;
    try {
      updated = await contacts.removePhone(contactId, normalized);
    } catch (err) {
      if (err instanceof PrimaryPhoneRemovalError) {
        res.status(409).json({ error: 'cannot_remove_primary' });
        return;
      }
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'contact_or_phone_not_found' });
        return;
      }
      throw err;
    }

    await audit.append(`contacts#${contactId}`, 'contact_phone_removed', {
      actor: req.user?.userId,
      phone: normalized,
    });
    log.info({ contactId, actor: req.user?.userId }, 'contact phone removed via api');
    res.json({ contact: withPhones(updated) });
  });

  return router;
}
