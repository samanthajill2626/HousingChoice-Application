// Honest-identity + phone-formatting helpers for the Thread view (PURE,
// unit-testable). The product NEVER fabricates a name or a tenant/landlord type:
// when a contact is un-triaged (type 'unknown' / status 'needs_review') or the
// conversation is still 'unknown_1to1', we surface the formatted phone number
// and a "needs review" cue instead of guessing.
import type { Contact, Conversation, ConversationType } from '../../api';

/**
 * Format an E.164 phone for display. US 10-digit numbers (with or without the
 * +1 country code) render as (AAA) BBB-CCCC; anything else is returned as-is so
 * we never mangle an unexpected shape.
 */
export function formatPhone(phone: string | undefined): string {
  if (phone === undefined || phone.length === 0) return 'Unknown number';
  const digits = phone.replace(/[^\d]/g, '');
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (local.length === 10) {
    return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
  }
  return phone;
}

/** A contact's full name from structured fields, or undefined when neither is set. */
export function contactFullName(contact: Contact | undefined): string | undefined {
  if (!contact) return undefined;
  const parts = [contact.firstName, contact.lastName].filter(
    (p): p is string => typeof p === 'string' && p.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** True when this conversation has not yet been triaged to a real identity. */
export function isUnknownConversation(type: ConversationType | undefined): boolean {
  return type === 'unknown_1to1';
}

/** True when the contact is awaiting human triage (honest-identity state). */
export function isContactNeedsReview(contact: Contact | undefined): boolean {
  if (!contact) return false;
  return contact.type === 'unknown' || contact.status === 'needs_review';
}

export interface IdentityDisplay {
  /** The name to show, or the formatted phone when we have no honest name. */
  label: string;
  /** True → surface the "needs review" cue (Avatar review + review Badge). */
  needsReview: boolean;
  /** The contact name (if any) — used to derive Avatar initials. */
  name: string | undefined;
  /** Formatted phone, always available for the honest fallback / subtitle. */
  phone: string;
}

/**
 * Resolve the header identity from the conversation + (optional) contact,
 * honestly. A real name is shown only when the contact carries one AND the
 * thread is no longer un-triaged; otherwise the formatted phone stands in and
 * `needsReview` is set so the UI shows the triage cue.
 */
export function resolveIdentity(
  conversation: Conversation | undefined,
  contact: Contact | undefined,
): IdentityDisplay {
  const phone = formatPhone(conversation?.participant_phone ?? contact?.phone);
  const name = contactFullName(contact);
  const needsReview = isUnknownConversation(conversation?.type) || isContactNeedsReview(contact);
  // Only show a real name when we have one AND the identity is resolved.
  const label = name !== undefined && !needsReview ? name : phone;
  return { label, needsReview, name: needsReview ? undefined : name, phone };
}

/** The human label for a conversation type, for the header badge. */
export function conversationTypeLabel(type: ConversationType | undefined): string {
  switch (type) {
    case 'tenant_1to1':
      return 'Tenant';
    case 'landlord_1to1':
      return 'Landlord';
    case 'unknown_1to1':
    default:
      return 'Needs review';
  }
}
