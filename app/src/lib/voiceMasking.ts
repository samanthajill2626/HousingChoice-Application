// Shared voice MASKING helpers (spec §9). One source of truth for the masked
// party labels + the honesty-rule role/author/conversation-type mapping, used by
// BOTH the inbound founder/relay bridges (routes/webhooks/voice.ts) AND the
// outbound originate service + bridge (services/originateCall.ts). Keeping them
// here means the outbound path REUSES the exact same masking the inbound path
// was built with — no drift, no duplicated PII rules.
//
// PII (spec §9): none of these ever emit a raw phone — a resolved display name
// (founder/staff-facing context) or a masked ROLE word only.
import type { ContactItem } from '../repos/contactsRepo.js';
import type { MessageAuthor } from '../repos/messagesRepo.js';
import type { ConversationType } from '../repos/conversationsRepo.js';

/** The sentinel label for a caller/contact we couldn't resolve to a role/name. */
export const UNKNOWN_CALLER_LABEL = 'Unknown caller';

/**
 * Author of a call entry = the counterpart's reviewed ROLE (honesty rule: only a
 * reviewed tenant/landlord claims a role; everything else is `unknown`).
 */
export function authorForContact(contact: ContactItem | undefined): MessageAuthor {
  return contact?.type === 'landlord' || contact?.type === 'tenant' ? contact.type : 'unknown';
}

/** The 1:1 conversation type for a (reviewed) contact — mirrors the SMS path. */
export function conversationTypeFor(contact: ContactItem | undefined): ConversationType {
  switch (contact?.type) {
    case 'landlord':
      return 'landlord_1to1';
    case 'tenant':
      return 'tenant_1to1';
    default:
      return 'unknown_1to1';
  }
}

/**
 * A MASKED, abbreviated display name from a contact's resolved fields —
 * "First L." (initial-only surname keeps the label terse + a touch more
 * private), else just "First", else undefined. HONEST: never invents a name.
 */
export function contactShortName(contact: ContactItem | undefined): string | undefined {
  const first = typeof contact?.firstName === 'string' ? contact.firstName.trim() : '';
  const last = typeof contact?.lastName === 'string' ? contact.lastName.trim() : '';
  if (first.length === 0 && last.length === 0) return undefined;
  if (first.length === 0) return last; // surname only
  if (last.length === 0) return first; // given name only
  return `${first} ${last.charAt(0)}.`;
}

/** The masked ROLE word for the contact's reviewed type, else undefined. */
export function roleWordForContact(contact: ContactItem | undefined): string | undefined {
  if (contact?.type === 'tenant') return 'Tenant';
  if (contact?.type === 'landlord') return 'Landlord';
  return undefined;
}

/**
 * The MASKED caller/contact label STORED on the call entity + spoken in the
 * whisper: the role + abbreviated name when known ("Tenant (Jane D.)"), the role
 * alone, the name alone, else "Unknown caller". NEVER the raw phone (PII, §9).
 */
export function maskedCallerLabel(contact: ContactItem | undefined): string {
  const role = roleWordForContact(contact);
  const name = contactShortName(contact);
  if (role !== undefined && name !== undefined) return `${role} (${name})`;
  if (role !== undefined) return role;
  if (name !== undefined) return name;
  return UNKNOWN_CALLER_LABEL;
}
