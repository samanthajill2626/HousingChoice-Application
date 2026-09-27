// app/src/lib/sendFingerprint.ts
// Spec D12/D13: the facts a reconcile matches on. LOSSY on purpose: the
// Messaging Service has Smart Encoding on, and the 2026-09-24 spike showed the
// STORED body of a message with a curly quote, an em dash or an ellipsis comes
// back as ', - and ... - an exact comparison would rule a real orphan "never
// sent" and re-send it.
import { createHash } from 'node:crypto';

/** Unicode NFKC, then letters and digits only (every separator and symbol dropped). */
export function normalizeBodyForMatch(body: string | undefined): string {
  if (body === undefined) return '';
  return body.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
}

export interface BodyFingerprint {
  /** sha256 hex of the normalized body. */
  hash: string;
  /**
   * Fewer than 3 normalized characters (a media- or emoji-only text). Kept on
   * the attempt record; it no longer decides a match - the reconcile compares
   * the hash AND the media count for every body (code review F-2, fix FW1-3).
   */
  short: boolean;
}

export function bodyFingerprint(body: string | undefined): BodyFingerprint {
  const normalized = normalizeBodyForMatch(body);
  return { hash: createHash('sha256').update(normalized).digest('hex'), short: normalized.length < 3 };
}

/**
 * The recipient number's keyed digest (D12): keyed on the sender, independent
 * of the owner, so a reconcile can prove the number it would look up is the
 * number the attempt was sent to without the record ever holding a phone.
 */
export function recipientDigest(sender: string | undefined, destinationE164: string): string {
  return createHash('sha256').update(`${sender ?? ''}|${destinationE164}`).digest('hex').slice(0, 32);
}

/** A phone-bearing recipient key (`phone#<E164>`) hashed for a stored key or payload; any other key unchanged. */
export function hashRecipientKey(recipientKey: string): string {
  if (!recipientKey.startsWith('phone#')) return recipientKey;
  return `phonehash#${createHash('sha256').update(recipientKey).digest('hex').slice(0, 32)}`;
}

/** A recipient key safe for a log line: a phone-bearing key is redacted, any other key unchanged. */
export function safeRecipientKey(recipientKey: string): string {
  return recipientKey.startsWith('phone#') ? 'phone#redacted' : recipientKey;
}
