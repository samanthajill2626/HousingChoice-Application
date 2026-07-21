// Email address helpers (email-channel A1). The email analog of lib/phone.ts:
// normalize is TOTAL (always returns a string - trim + lowercase, the storage
// canonical form used for the byEmail GSI hash and dedupe), while validity is a
// SEPARATE predicate the routes gate on. Kept dependency-free and pure so it is
// safe to import from repos, routes, adapters, and the worker alike.

/**
 * Canonicalize an email for storage / comparison: trim surrounding whitespace
 * and lowercase. Addresses are compared and indexed (byEmail GSI hash) in this
 * form, so every write and lookup MUST normalize first. Total by design - it
 * never rejects; call isValidEmailAddress() to decide acceptability.
 */
export function normalizeEmailAddress(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Pragmatic RFC-subset validity check, applied AFTER normalize: exactly one `@`
 * with a non-empty, whitespace-free local part and a dotted, whitespace-free
 * domain (`local@domain.tld`). Deliberately permissive (we accept far more than
 * we could deliver to) but rejects the obvious garbage - empty, no `@`, a
 * dotless domain, a trailing dot, interior spaces, or multiple `@`. The exact
 * pattern is fixed by the plan: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.
 */
export function isValidEmailAddress(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmailAddress(raw));
}
