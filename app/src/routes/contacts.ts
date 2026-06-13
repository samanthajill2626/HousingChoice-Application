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
import type { AuthedRequest } from '../middleware/auth.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import {
  createContactsRepo,
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

export interface ContactsRouterDeps {
  logger?: Logger;
  contactsRepo?: ContactsRepo;
  conversationsRepo?: ConversationsRepo;
  auditRepo?: AuditRepo;
  /** SSE live-update bus (M1.2); the process singleton by default. */
  events?: EventBus;
}

/** The contact types triage may set (the full union incl. 'unknown'). */
const CONTACT_TYPES: readonly ContactType[] = [
  'tenant',
  'landlord',
  'pm',
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

/** A resolved-identity 1:1 type for the conversation, or undefined when not propagatable. */
function conversationTypeFor(contactType: ContactType): ConversationType | undefined {
  if (contactType === 'tenant') return 'tenant_1to1';
  if (contactType === 'landlord') return 'landlord_1to1';
  // pm/team_member/unknown have no 1:1 conversation type to propagate.
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

  // A manual create asserts identity — default to active (not needs_review).
  if (item.status === undefined) item.status = 'active';

  return { item, ...(phone !== undefined && { phone }) };
}

export function createContactsRouter(deps: ContactsRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
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
    res.status(201).json({ contact });
  });

  // GET /api/contacts/:contactId — the side-panel contact item.
  router.get('/:contactId', async (req, res) => {
    const contactId = String(req.params['contactId'] ?? '');
    mergeContext({ contactId });
    const contact = await contacts.getById(contactId);
    if (!contact) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }
    res.json({ contact });
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
    // never auto-advance for unknown/pm/team_member (they don't resolve a 1:1
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

    res.json({ contact: updated });
  });

  return router;
}
