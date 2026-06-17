// contactPhones — resolve a Contact's phone numbers + the default reply/call
// target, handling BOTH the C1 shape (contact.phones[]) and the legacy single
// `phone`. Pure + tested so the header and the file pane stay declarative.
import type { Contact, ContactPhone } from '../../api/index.js';

/** Normalize a Contact to a ContactPhone[]. When C1's phones[] is present use
 *  it; otherwise synthesize a single primary from the legacy `phone`. Returns
 *  [] when the contact has no number at all (honest — never fabricate). */
export function contactPhones(contact: Contact): ContactPhone[] {
  if (contact.phones && contact.phones.length > 0) return contact.phones;
  if (contact.phone) return [{ phone: contact.phone, primary: true }];
  return [];
}

/** The default reply/call target: the `primary` phone, else the most recent by
 *  lastSeenAt, else the first, else undefined. */
export function defaultPhone(phones: ContactPhone[]): ContactPhone | undefined {
  if (phones.length === 0) return undefined;
  const primary = phones.find((p) => p.primary);
  if (primary) return primary;
  const withSeen = phones.filter((p) => p.lastSeenAt);
  if (withSeen.length > 0) {
    return withSeen.reduce((a, b) => ((a.lastSeenAt ?? '') >= (b.lastSeenAt ?? '') ? a : b));
  }
  return phones[0];
}

/** A short label for why a phone is the default target ("primary" vs "most
 *  recent"), for the reply box copy. */
export function defaultPhoneLabel(phones: ContactPhone[]): string {
  if (phones.length === 0) return '';
  if (phones.some((p) => p.primary)) return 'primary';
  if (phones.some((p) => p.lastSeenAt)) return 'most recent';
  return '';
}
