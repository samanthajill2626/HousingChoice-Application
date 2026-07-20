// Shared address-parts helpers for the address extraction target (spec
// 2026-07-20-address-extraction-design, sections 3 and 5). ONE cleaning /
// formatting / comparison story for the schema parser, the apply policy, the
// suggestion-accept route, and the profile snapshot.
//
// DELIBERATELY SEPARATE from lib/address.ts (do NOT unify them later): that
// module owns the UNIT-address domain - a STRICT validateAddress (rejects
// unknown keys and bad values) plus a formatAddress that renders
// "City, ST 30328" with a SPACE before the zip. This module instead does
// LENIENT cleaning (trim, drop empties, clamp - never reject), because its
// input is untrusted model output, and formats an ALL-COMMA single line
// ("line1, city, GA, 30328") that the 2026-07-20 spec pins as BOTH the chip
// display string and the normalized-equality input. The format difference is
// load-bearing; the two jobs (unit-address validation vs extraction cleaning)
// are different and stay in different modules.

/** The five storable postal parts (matches the edit-form PATCH allowlist). */
export const ADDRESS_PART_KEYS = ['line1', 'line2', 'city', 'state', 'zip'] as const;
export type AddressPartKey = (typeof ADDRESS_PART_KEYS)[number];

export type ExtractionAddressParts = Partial<Record<AddressPartKey, string>>;

const MAX_PART_CHARS = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Trimmed, non-empty, known-key, clamped parts from an untrusted value. */
export function cleanAddressParts(raw: unknown): ExtractionAddressParts {
  if (!isRecord(raw)) return {};
  const out: ExtractionAddressParts = {};
  for (const key of ADDRESS_PART_KEYS) {
    const part = raw[key];
    if (typeof part !== 'string') continue;
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    out[key] = trimmed.length > MAX_PART_CHARS ? trimmed.slice(0, MAX_PART_CHARS) : trimmed;
  }
  return out;
}

/** Canonical single-line display form: non-empty parts joined by ', '. */
export function formatAddressParts(parts: ExtractionAddressParts): string {
  return ADDRESS_PART_KEYS.map((k) => parts[k])
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(', ');
}

/**
 * A stored contact `address` as parts. Handles the two stored shapes: the
 * structured object the edit form writes, and the legacy plain-string
 * `address` some pre-contract dev records carry (folds to line1).
 */
export function contactAddressToParts(raw: unknown): ExtractionAddressParts {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? { line1: trimmed } : {};
  }
  return cleanAddressParts(raw);
}

/** True when the stored value holds NO usable address content. */
export function isEmptyAddressValue(raw: unknown): boolean {
  return formatAddressParts(contactAddressToParts(raw)).length === 0;
}

/** Case/whitespace/punctuation-insensitive comparison key. */
export function normalizeAddressForCompare(text: string): string {
  return text.toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
}
