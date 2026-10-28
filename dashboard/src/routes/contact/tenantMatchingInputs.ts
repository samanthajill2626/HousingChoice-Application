// WP1 B1 (spec 2026-10-26 D1; plan PR8) - the dashboard's HAND COPY of
// app/src/lib/tenantMatchingInputs.ts, minus `promptGuidance` and `source`.
// The dashboard is a separate package and cannot import app code at
// runtime; tenantMatchingInputsMirror.test.ts imports both and fails on any
// drift in the entries, the caps or the error copy. When it fails, the APP
// module is the source of truth.
//
// Readers iterate this list - the edit form's controls (ContactEditForm),
// the Eligibility intake rows (EligibilityIntakeCard) and
// SUGGESTION_TARGET_LABEL (suggestionTargets.ts); none names the four.
//
// NO IMPORTS: dashboard/src/api/types.ts imports this module's types, and
// the APP and E2E typechecks compile types.ts (app/test/contactTimeline.test.ts,
// e2e/tests/tour-roster.spec.ts), so this module stays import-free.

export type TenantMatchingInputKind = 'text' | 'dollars';
export type TenantMatchingInputControl = 'input' | 'textarea' | 'dollars';

export interface TenantMatchingInput {
  readonly key: string;
  readonly label: string;
  readonly chipLabel: string;
  readonly kind: TenantMatchingInputKind;
  readonly control: TenantMatchingInputControl;
}

export const TENANT_MATCHING_INPUTS = [
  { key: 'area_preference', label: 'Area preference', chipLabel: 'area preference', kind: 'text', control: 'input' },
  {
    key: 'max_tenant_portion',
    label: 'Maximum tenant portion',
    chipLabel: 'maximum tenant portion',
    kind: 'dollars',
    control: 'dollars',
  },
  { key: 'accessibility_need', label: 'Accessibility need', chipLabel: 'accessibility need', kind: 'text', control: 'input' },
  {
    key: 'preferences_constraints',
    label: 'Preferences and constraints',
    chipLabel: 'preferences and constraints',
    kind: 'text',
    control: 'textarea',
  },
] as const satisfies readonly TenantMatchingInput[];

export type TenantMatchingInputKey = (typeof TENANT_MATCHING_INPUTS)[number]['key'];

export const TENANT_MATCHING_TEXT_MAX = 500;
export const TENANT_MATCHING_DOLLARS_MAX = 20000;

/** The stored values, typed from the list by kind (text a string, the
 *  portion whole dollars). Contact and ContactCreate extend it. */
export type TenantMatchingInputValues = {
  [I in (typeof TENANT_MATCHING_INPUTS)[number] as I['key']]?: I['kind'] extends 'dollars' ? number : string;
};

/** A PATCH's values: each key optional; null CLEARS it (the server REMOVEs). */
export type TenantMatchingInputPatch = {
  [K in TenantMatchingInputKey]?: NonNullable<TenantMatchingInputValues[K]> | null;
};

export function tenantMatchingTextTooLong(label: string): string {
  return `${label} must be ${TENANT_MATCHING_TEXT_MAX} characters or fewer.`;
}

export function tenantMatchingDollarsInvalid(label: string): string {
  return `${label} must be a whole dollar amount from 0 to ${TENANT_MATCHING_DOLLARS_MAX}.`;
}

/** A value as the record and the suggestion chip show it: text trimmed; a
 *  portion (a stored number, or a digits-only suggested value) as
 *  `$1,200 / month`; any other portion value raw; '' when there is none. */
export function formatTenantMatchingValue(
  input: Pick<TenantMatchingInput, 'kind'>,
  value: unknown,
): string {
  if (input.kind === 'dollars') {
    const n =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\d+$/.test(value.trim())
          ? Number(value.trim())
          : Number.NaN;
    if (Number.isInteger(n) && n >= 0) return `$${n.toLocaleString('en-US')} / month`;
  }
  return typeof value === 'string' ? value.trim() : '';
}

/** The edit form's starting values: one string per entry (the portion as
 *  digits), '' when not recorded. */
export function tenantMatchingFormValues(stored: Readonly<Record<string, unknown>>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const input of TENANT_MATCHING_INPUTS) {
    const value = stored[input.key];
    if (input.kind === 'dollars') {
      values[input.key] = typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    } else {
      values[input.key] = typeof value === 'string' ? value : '';
    }
  }
  return values;
}

/**
 * The edit form's PATCH for the tenant matching inputs (spec D2): only the
 * entries whose TRIMMED value differs from the stored one; a cleared entry is
 * null (the server REMOVEs it). A bad value refuses the save with the
 * server's own copy (the drift test pins the two). A missing value reads as
 * empty. `unparseable` names the dollars entries whose number input holds
 * text it could not parse (`validity.badInput`): the input then reports '',
 * so such an entry is refused with the server's copy, never read as a clear
 * (code review R1 CONF-1, FW-11).
 */
export function buildTenantMatchingPatch(
  values: Readonly<Record<string, string>>,
  stored: Readonly<Record<string, unknown>>,
  unparseable: ReadonlySet<string> = new Set(),
): { ok: true; patch: TenantMatchingInputPatch } | { ok: false; error: string } {
  const before = tenantMatchingFormValues(stored);
  const patch: TenantMatchingInputPatch = {};
  for (const input of TENANT_MATCHING_INPUTS) {
    if (input.kind === 'dollars' && unparseable.has(input.key)) {
      return { ok: false, error: tenantMatchingDollarsInvalid(input.label) };
    }
    const next = (values[input.key] ?? '').trim();
    if (next === (before[input.key] ?? '').trim()) continue;
    if (next === '') {
      Object.assign(patch, { [input.key]: null });
      continue;
    }
    if (input.kind === 'dollars') {
      if (!/^\d+$/.test(next) || Number(next) > TENANT_MATCHING_DOLLARS_MAX) {
        return { ok: false, error: tenantMatchingDollarsInvalid(input.label) };
      }
      Object.assign(patch, { [input.key]: Number(next) });
      continue;
    }
    if (next.length > TENANT_MATCHING_TEXT_MAX) {
      return { ok: false, error: tenantMatchingTextTooLong(input.label) };
    }
    Object.assign(patch, { [input.key]: next });
  }
  return { ok: true, patch };
}
