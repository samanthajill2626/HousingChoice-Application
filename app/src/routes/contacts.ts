// Contact triage routes (M1.4) — resolves the needs_review honesty flow from
// the dashboard side panel. Mounted under /api/contacts (behind requireAuth;
// VAs triage, so NO admin gate). Scope is triage-of-an-EXISTING-contact; full
// contacts/units CRUD is M1.5.
//
//   GET   /api/contacts/:contactId   → { contact }
//   PATCH /api/contacts/:contactId   { type?, firstName?, lastName?, voucherSize?, status?, notes? }
//                                    → { contact }
//
// THE M1.5 SEAM the honest-identity deviation left (README 2026-06-12):
// resolving a contact's type to tenant/landlord PROPAGATES that to the linked
// conversation(s)' type (unknown_1to1 → tenant_1to1/landlord_1to1). Triage
// happens HERE, so the propagation is implemented HERE.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { Router } from 'express';
import { parseContactName } from '../lib/contactName.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { mergeContext } from '../lib/context.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import {
  createContactsRepo,
  type ContactsRepo,
  type ContactType,
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

/** A resolved-identity 1:1 type for the conversation, or undefined when not propagatable. */
function conversationTypeFor(contactType: ContactType): ConversationType | undefined {
  if (contactType === 'tenant') return 'tenant_1to1';
  if (contactType === 'landlord') return 'landlord_1to1';
  // pm/team_member/unknown have no 1:1 conversation type to propagate.
  return undefined;
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

export function createContactsRouter(deps: ContactsRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });

  const router = Router();

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

    // PROPAGATE resolved identity to the linked conversation(s) (the M1.5
    // seam): when type was set to tenant|landlord, every open unknown_1to1
    // thread on this contact's phone becomes tenant_1to1/landlord_1to1.
    let propagatedConversations = 0;
    const newType = parsed.patch['type'];
    const convType = isContactType(newType) ? conversationTypeFor(newType) : undefined;
    const phone = typeof updated.phone === 'string' ? updated.phone : undefined;
    if (convType !== undefined && phone !== undefined) {
      const linked = await conversations.findByParticipantPhone(phone);
      for (const conv of linked) {
        // Only flip an UNKNOWN thread — never re-type a thread already
        // resolved to a different identity (that would be a triage conflict
        // the human must reconcile, not something to silently overwrite).
        if (conv.type === 'unknown_1to1') {
          await conversations.setType(conv.conversationId, convType);
          propagatedConversations += 1;
        }
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
