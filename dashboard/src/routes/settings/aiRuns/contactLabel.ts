import type { AiRunContactDisplay } from '../../../api/index.js';
import { contactDisplayName } from '../../contact/format.js';

export function aiRunContactLabel(
  contact: AiRunContactDisplay | undefined,
  fallback: string,
): string {
  if (contact === undefined) return fallback;
  const hasName = Boolean(contact.firstName?.trim() || contact.lastName?.trim());
  if (!hasName && !contact.phone) return fallback;
  return contactDisplayName(contact.firstName, contact.lastName, contact.phone);
}
