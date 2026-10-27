// WP1 B1 (spec docs/superpowers/specs/2026-10-26-wp1-b1-ranking-inputs-design.md
// D1, D2; plan PR8): the ONE list of the tenant matching inputs - the four
// tenant fields staff see and edit, extraction fills, and the B2 ranker
// reads. Every reader iterates TENANT_MATCHING_INPUTS; none names the four.
//
// A LEAF: this module has no imports, so services/extraction/runTypes.ts (a
// cycle-free leaf itself) and the dashboard drift test can load it. The
// dashboard hand-copies the entries minus `promptGuidance` and `source`
// (dashboard/src/routes/contact/tenantMatchingInputs.ts); its
// tenantMatchingInputsMirror.test.ts fails on drift, and THIS file is the
// source of truth.
//
// parseTenantMatchingInputs is the STAFF rule (contacts PATCH and create): a
// bad value is a 400. Extraction's coercion of a model value (spec D3) is a
// different rule - a bad value is dropped - and lives with extraction.

export type TenantMatchingInputKind = 'text' | 'dollars';
export type TenantMatchingInputControl = 'input' | 'textarea' | 'dollars';
/** Where the fact is kept. `notes` is admitted for a later move
 *  (docs/issues/extraction-fields-to-notes.md); B1 builds no path for it. */
export type TenantMatchingInputSource = 'field' | 'notes';

export interface TenantMatchingInput {
  readonly key: string;
  /** The record row and edit-form label - exact, and distinct from every
   *  other intake label (an e2e getByLabel is a substring match). */
  readonly label: string;
  /** The suggestion chip's noun: "AI suggestion for <chipLabel>". */
  readonly chipLabel: string;
  readonly kind: TenantMatchingInputKind;
  readonly control: TenantMatchingInputControl;
  readonly source: TenantMatchingInputSource;
  /** The sentence the extraction prompt uses for this field (spec D3). */
  readonly promptGuidance: string;
}

export const TENANT_MATCHING_INPUTS = [
  {
    key: 'area_preference',
    label: 'Area preference',
    chipLabel: 'area preference',
    kind: 'text',
    control: 'input',
    source: 'field',
    promptGuidance:
      'Where the tenant wants to live: neighborhoods, cities, zip codes, or "near X".',
  },
  {
    key: 'max_tenant_portion',
    label: 'Maximum tenant portion',
    chipLabel: 'maximum tenant portion',
    kind: 'dollars',
    control: 'dollars',
    source: 'field',
    promptGuidance:
      'The most the tenant says they can pay themselves each month toward the rent of a new home, in whole dollars - not the full rent and not the voucher amount.',
  },
  {
    key: 'accessibility_need',
    label: 'Accessibility need',
    chipLabel: 'accessibility need',
    kind: 'text',
    control: 'input',
    source: 'field',
    promptGuidance:
      'A need the HOME must meet for the tenant or a household member (no stairs, a ground floor, wheelchair access, grab bars) - the bare need, never a diagnosis.',
  },
  {
    key: 'preferences_constraints',
    label: 'Preferences and constraints',
    chipLabel: 'preferences and constraints',
    kind: 'text',
    control: 'textarea',
    source: 'field',
    promptGuidance:
      'Anything else the tenant states they want or cannot accept in a home (bedrooms beyond the voucher, a yard, a move-in date, "no apartments").',
  },
] as const satisfies readonly TenantMatchingInput[];

export type TenantMatchingInputKey = (typeof TENANT_MATCHING_INPUTS)[number]['key'];

/** The staff cap on a text input, after the trim (spec D2). */
export const TENANT_MATCHING_TEXT_MAX = 500;
/** The highest whole-dollar portion a tenant can record (spec D2). */
export const TENANT_MATCHING_DOLLARS_MAX = 20000;

/** The stored attributes, typed from the list by kind: text is a string,
 *  the portion whole dollars. ContactItem extends it, so the storage type
 *  follows the list and names none of the four. */
export type TenantMatchingInputValues = {
  [I in (typeof TENANT_MATCHING_INPUTS)[number] as I['key']]?: I['kind'] extends 'dollars' ? number : string;
};

export function tenantMatchingNotText(label: string): string {
  return `${label} must be a string.`;
}

export function tenantMatchingTextTooLong(label: string): string {
  return `${label} must be ${TENANT_MATCHING_TEXT_MAX} characters or fewer.`;
}

export function tenantMatchingDollarsInvalid(label: string): string {
  return `${label} must be a whole dollar amount from 0 to ${TENANT_MATCHING_DOLLARS_MAX}.`;
}

/**
 * The staff value rule for the tenant matching inputs in a contacts PATCH or
 * create body (spec D2). Text: a string, TRIMMED, at most
 * TENANT_MATCHING_TEXT_MAX characters; '' after the trim, or null, CLEARS it
 * (null - the route REMOVEs the attribute; never a stored ''). Dollars: an
 * integer 0..TENANT_MATCHING_DOLLARS_MAX, or null / '' to clear; any other
 * value (a fraction, out of range, any other string) is refused. Returns only
 * the keys present in the body (absent = untouched). Not type-gated:
 * tenant-only is a UI guarantee, as for the other intake fields.
 */
export function parseTenantMatchingInputs(
  body: Readonly<Record<string, unknown>>,
): { ok: true; fields: Record<string, string | number | null> } | { ok: false; error: string } {
  const fields: Record<string, string | number | null> = {};
  for (const input of TENANT_MATCHING_INPUTS) {
    if (!(input.key in body)) continue;
    const value = body[input.key];
    if (value === undefined) continue;
    if (value === null) {
      fields[input.key] = null;
      continue;
    }
    if (input.kind === 'dollars') {
      if (value === '') {
        fields[input.key] = null;
        continue;
      }
      if (
        typeof value !== 'number'
        || !Number.isInteger(value)
        || value < 0
        || value > TENANT_MATCHING_DOLLARS_MAX
      ) {
        return { ok: false, error: tenantMatchingDollarsInvalid(input.label) };
      }
      fields[input.key] = value;
      continue;
    }
    if (typeof value !== 'string') return { ok: false, error: tenantMatchingNotText(input.label) };
    const trimmed = value.trim();
    if (trimmed.length > TENANT_MATCHING_TEXT_MAX) {
      return { ok: false, error: tenantMatchingTextTooLong(input.label) };
    }
    fields[input.key] = trimmed.length > 0 ? trimmed : null;
  }
  return { ok: true, fields };
}
