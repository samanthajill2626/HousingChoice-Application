// Display-side phone formatting for the fake-phones UI. A verbatim mirror of
// the dashboard's `formatPhoneDisplay` (dashboard/src/lib/phone.ts) — the fake
// is a separate package by design, so the helper is re-declared, not imported.

/**
 * Human-friendly display form of an E.164 number.  US/Canada (+1, 11 digits)
 * → "(AAA) BBB-CCCC"; anything else is returned unchanged (we don't reformat
 * unknown country shapes).  Falsy input → empty string (safe for JSX).
 *
 * - "+15550160001"  → "(555) 016-0001"
 * - "+442079460958" → "+442079460958" (non-NANP — left as-is)
 * - undefined / ""  → ""
 */
export function formatPhoneDisplay(e164: string | undefined): string {
  if (!e164) return '';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
