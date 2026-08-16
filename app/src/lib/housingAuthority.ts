// The ONE place a housing-authority string is normalized, for every writer of
// `contact.housingAuthority`.
//
// It lived in lib/import/apply.ts until 2026-08-16, when the AI extractor needed
// it too. Extraction is not downstream of the importer, so leaving it there
// would have made a conversation-extraction service import from a batch-import
// module to answer "how is this field spelled" - a dependency that says nothing
// true about the domain. lib/import/apply.ts re-exports both symbols, so the
// importer's public surface is unchanged.
//
// WHY normalize at all: the field is FREE TEXT (Cameron, 2026-08-09) - a
// flexible document attribute with no closed vocabulary. What matters is
// spelling CONSISTENCY, because broadcast audience resolution does an exact hash
// match on the byHousingAuthority GSI. "Dekalb Housing" and "Dekalb County
// Housing" are two audiences invisible to each other, so known variants collapse
// to one spelling and UNKNOWN values pass through verbatim rather than being
// dropped. Dropping is the one behavior this module never does.
//
// The founder's taxonomy (email 2026-08-09): agencies/non-profits (HUD VASH,
// Hope Atlanta, Claratel, Step Up) are DIFFERENT things from housing authorities
// (AHA, JHA, DCA, ...) and one person can hold both. A single field cannot
// represent the pair; that model gap is
// docs/issues/housing-authority-free-text-drift.md and is not solved here.

/**
 * The founder's Airtable "voucher program" spellings -> ONE canonical spelling
 * each. Most come from the 2026-08-09 tenants table (666 rows) - e.g.
 * "Atlanta, aha, Atlanta housing" x450.
 *
 * Adding a variant here is the ONLY thing that still needs a code change, and
 * only to collapse two spellings of the SAME authority. A brand-new authority
 * needs nothing: it flows through verbatim.
 */
const CANONICAL_AUTHORITY: Readonly<Record<string, string>> = {
  'atlanta, aha, atlanta housing': 'Atlanta (AHA)',
  'atlanta housing': 'Atlanta (AHA)',
  'jonesboro, jha, jonesboro housing': 'Jonesboro (JHA)',
  'jonesboro housing': 'Jonesboro (JHA)',
  'dekalb county housing': 'Dekalb County Housing',
  'dekalb housing': 'Dekalb County Housing',
  'georgia housing voucher, ghv': 'Georgia Housing Voucher (GHV)',
  'georgia housing voucher (ghv)': 'Georgia Housing Voucher (GHV)',
  ghv: 'Georgia Housing Voucher (GHV)',
  'dca, department of community affairs': 'DCA',
  dca: 'DCA',
  'fulton, fulton county': 'Fulton County',
  'fulton county': 'Fulton County',
  clayton: 'Clayton County',
  'clayton county': 'Clayton County',
  'eastpoint housing authority': 'East Point',
  'east point': 'East Point',
  'mcdonough housing authority': 'McDonough',
  mcdonough: 'McDonough',
  'hud vash': 'HUD VASH',
  claratel: 'Claratel',
  'hope atlanta': 'Hope Atlanta',
  'step up': 'Step Up',
};

/** The canonical spellings this module emits (also the importer's passthrough report). */
export const KNOWN_AUTHORITIES: ReadonlySet<string> = new Set(
  Object.values(CANONICAL_AUTHORITY),
);

/**
 * Normalize an authority string: canonical spelling when known, verbatim
 * (whitespace-collapsed) when not, undefined only when empty.
 */
export function housingAuthorityFor(rawProgram: string | undefined): string | undefined {
  if (!rawProgram) return undefined;
  const cleaned = rawProgram.trim().replace(/\s+/g, ' ');
  if (!cleaned) return undefined;
  return CANONICAL_AUTHORITY[cleaned.toLowerCase()] ?? cleaned;
}

/**
 * Is this string one we already recognise?
 *
 * The extraction apply layer uses this to decide WRITE vs SUGGEST, and that is
 * the only reason it takes a post-normalization value: `isKnownAuthority('Dekalb
 * Housing')` is false, but `housingAuthorityFor('Dekalb Housing')` is
 * 'Dekalb County Housing', which IS known. Normalize first, then ask.
 */
export function isKnownAuthority(normalized: string): boolean {
  return KNOWN_AUTHORITIES.has(normalized);
}
