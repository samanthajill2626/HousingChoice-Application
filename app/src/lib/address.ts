// Shared, reusable postal address shape (CO: structured unit addresses). ONE
// definition the whole backend uses wherever it stores an address — units now,
// tenant/contact addresses later reuse the SAME type and validator. NO
// geocoding (out of scope, kickoff): this is the typed-text address, never a
// coordinate.
//
// Everything is optional by design: intake is partial — a unit (or a contact)
// can be created with just a street line and filled in over time, exactly like
// the rest of the flexible-document model.

/** A US postal address. All fields optional (partial-by-design intake). */
export interface Address {
  /** Street address line 1. */
  line1?: string;
  /** Unit / apt # (line 2). */
  line2?: string;
  city?: string;
  /** 2-letter US state code. */
  state?: string;
  zip?: string;
}

/** The closed set of allowed address keys — the write validator rejects others. */
export const ADDRESS_KEYS = ['line1', 'line2', 'city', 'state', 'zip'] as const;
export type AddressKey = (typeof ADDRESS_KEYS)[number];

/**
 * Per-field length caps (sane upper bounds, not format validation). Generous
 * enough for real addresses; tight enough that a stray blob can't be smuggled
 * through a string field. State is the 2-letter code but we allow a little slack
 * (full-name typo-tolerance) rather than format-policing on a partial-intake field.
 */
const FIELD_CAPS: Record<AddressKey, number> = {
  line1: 200,
  line2: 100,
  city: 100,
  state: 40,
  zip: 20,
};

/** Result of validating/normalizing an address value off the write surface. */
export type AddressValidation = { ok: true; address: Address } | { ok: false; error: string };

/**
 * Validate a value as a structured Address and return a normalized copy:
 * - must be a plain object (not array/null/scalar),
 * - only the allowed keys (line1/line2/city/state/zip) — unknown keys rejected,
 * - each present value must be a string within its length cap,
 * - values are trimmed; empty (or whitespace-only) strings are DROPPED so a
 *   blank field never persists as "".
 * The result may be an empty object ({}); the caller decides whether to store it.
 */
export function validateAddress(value: unknown, fieldLabel = 'address'): AddressValidation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: `${fieldLabel} must be an object` };
  }
  const out: Address = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(ADDRESS_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `${fieldLabel} has unknown key: ${key}` };
    }
    if (raw === undefined) continue;
    if (typeof raw !== 'string') {
      return { ok: false, error: `${fieldLabel}.${key} must be a string` };
    }
    if (raw.length > FIELD_CAPS[key as AddressKey]) {
      return { ok: false, error: `${fieldLabel}.${key} exceeds ${FIELD_CAPS[key as AddressKey]} chars` };
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue; // drop empty/whitespace-only fields
    out[key as AddressKey] = trimmed;
  }
  return { ok: true, address: out };
}

/** True when the value is a plausible structured Address (no unknown keys, all-string). */
export function isValidAddress(value: unknown): value is Address {
  return validateAddress(value).ok;
}

/**
 * One-line display string for server-side logging / display needs. Joins the
 * present fields in postal order; "city, state zip" reads naturally. Tolerant of
 * a legacy plain-string address (returns it as-is) and of missing fields.
 * NOT for the public flyer — the flyer never shows the street address.
 */
export function formatAddress(a: Address | string | undefined): string {
  if (a === undefined) return '';
  if (typeof a === 'string') return a.trim();
  const street = [a.line1, a.line2].filter((s) => s && s.length > 0).join(' ');
  const cityState = [a.city, [a.state, a.zip].filter((s) => s && s.length > 0).join(' ')]
    .filter((s) => s && s.length > 0)
    .join(', ');
  return [street, cityState].filter((s) => s.length > 0).join(', ');
}
