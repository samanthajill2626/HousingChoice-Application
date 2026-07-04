// keep in sync with dashboard/src/lib/phone.ts (+ its test at dashboard/src/lib/phone.test.ts)
//
// Phone → E.164 normalizer (M1.5). The ONE place manual/public phone entry is
// canonicalized before it touches the contacts byPhone GSI — auto-capture
// (M1.2) trusts Twilio's already-E.164 `From`, but humans and the public
// housing-fair form type "(555) 010-1234", "555-010-1234", "+1 555 010 1234",
// etc. Canonicalizing here keeps one contact per real phone (the dedupe key).
//
// SCOPE (deliberate, US-first): we support NANP (US/Canada, +1) plus any
// already-+-prefixed E.164. A bare 10-digit number assumes +1; a bare 11-digit
// number starting with 1 assumes +1; an explicit + is taken as-is after a
// shape check. Anything else returns undefined — callers reject it with a
// generic 400 (never guess a country). When HousingChoice serves non-NANP
// markets this is the seam to widen (a libphonenumber dependency would be the
// upgrade path); commented so the assumption is visible, not buried.
//
// Pure function, no I/O, no logging.

/** E.164 shape: `+` then 1-15 digits, first digit non-zero (ITU-T E.164). */
const E164_RE = /^\+[1-9]\d{1,14}$/;

/**
 * Normalize a free-text phone to E.164, or undefined when it cannot be
 * canonicalized with confidence (callers treat undefined as invalid input).
 *
 * - "+15550101234"            → "+15550101234" (already E.164)
 * - "(555) 010-1234"          → "+15550101234" (10 digits → assume +1)
 * - "1 555 010 1234"          → "+15550101234" (11 digits, leading 1 → +1)
 * - "+44 20 7946 0958"        → "+442079460958" (explicit +, kept)
 * - "555-0123" / "abc" / ""   → undefined (too short / garbage)
 */
export function normalizeToE164(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  // Explicit international form: strip spaces/dashes/parens, then shape-check.
  // We never re-guess the country code on a +-prefixed value.
  if (trimmed.startsWith('+')) {
    const compact = `+${trimmed.slice(1).replace(/[\s().-]/g, '')}`;
    return E164_RE.test(compact) ? compact : undefined;
  }

  // No +: keep digits only and apply the NANP (+1) assumption.
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) {
    // Bare NANP number → prepend the US/Canada country code.
    const candidate = `+1${digits}`;
    return E164_RE.test(candidate) ? candidate : undefined;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    const candidate = `+${digits}`;
    return E164_RE.test(candidate) ? candidate : undefined;
  }
  // Any other length is ambiguous without a country code — reject (don't guess).
  return undefined;
}

/** True when the value is already canonical E.164 (the byPhone GSI key shape). */
export function isE164(value: string): boolean {
  return E164_RE.test(value);
}

/**
 * Human-friendly display form of an E.164 number — for OUTBOUND-to-staff UI
 * only (e.g. a founder-triage push for an untriaged caller), NEVER for storage,
 * logs, or a Twilio caller ID. US/Canada (+1, 11 digits) → "(AAA) BBB-CCCC";
 * anything else is returned unchanged (we don't reformat unknown country
 * shapes). undefined/empty → undefined.
 *
 * - "+14049824978"  → "(404) 982-4978"
 * - "+442079460958" → "+442079460958" (non-NANP — left as-is)
 */
export function formatPhoneForDisplay(e164: string | undefined): string | undefined {
  if (e164 === undefined || e164.length === 0) return undefined;
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
