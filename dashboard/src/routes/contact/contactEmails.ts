// contactEmails - resolve a Contact's email addresses + the default send target,
// handling BOTH the roster shape (contact.emails[]) and the legacy single
// `email`. The email analog of contactPhones.ts. Pure + tested so the composer's
// To picker and the EmailManager stay declarative.
import type { Contact, ContactEmail } from '../../api/index.js';

/** Normalize a Contact to a ContactEmail[]. When the roster emails[] is present
 *  use it; otherwise synthesize a single primary from the legacy `email`. Returns
 *  [] when the contact has no address at all (honest - never fabricate). */
export function contactEmails(contact: Contact): ContactEmail[] {
  if (contact.emails && contact.emails.length > 0) return contact.emails;
  if (contact.email) return [{ email: contact.email, primary: true }];
  return [];
}

/** The default send target: the `primary` address, else the most recent by
 *  lastSeenAt, else the first, else undefined. */
export function defaultEmail(emails: ContactEmail[]): ContactEmail | undefined {
  if (emails.length === 0) return undefined;
  const primary = emails.find((e) => e.primary);
  if (primary) return primary;
  const withSeen = emails.filter((e) => e.lastSeenAt);
  if (withSeen.length > 0) {
    return withSeen.reduce((a, b) => ((a.lastSeenAt ?? '') >= (b.lastSeenAt ?? '') ? a : b));
  }
  return emails[0];
}

/** A short label for why an address is the default target ("primary" vs "most
 *  recent"), for the composer copy. */
export function defaultEmailLabel(emails: ContactEmail[]): string {
  if (emails.length === 0) return '';
  if (emails.some((e) => e.primary)) return 'primary';
  if (emails.some((e) => e.lastSeenAt)) return 'most recent';
  return '';
}

/** Client-side email validity - a hand-mirror of app/src/lib/email.ts's
 *  isValidEmailAddress (the exact same pragmatic RFC subset, applied after a
 *  trim+lowercase normalize) so a clearly-invalid address is caught BEFORE the
 *  POST. The dashboard cannot import from app/src, so the pattern is duplicated;
 *  keep it in sync. The server re-validates - this is a UX fast-path only. */
export function isValidEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim().toLowerCase());
}

/** Canonical storage form: trim + lowercase (mirrors normalizeEmailAddress). */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
