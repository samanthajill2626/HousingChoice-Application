// resolveTemplate (Task 7) - the client-side mirror of the backend's renderBody
// (app/src/lib/mergeFields.ts) so the SINGLE-recipient editor can show EXACTLY
// what will send. NO AI: a literal token replace. Unit-derived tokens come from
// the attached unit; [TenantName] is the one per-recipient token (fallback
// "there" - never a phone/id). Unresolvable tokens (or no unit) render as ''.
//
// Parity notes (keep in lockstep with mergeFields.ts):
//   [Beds]    - String(beds).
//   [Address] - formatAddress(unit.address): the same full-address accessor the
//               property pages display (tolerant of a legacy plain string).
//   [Rent]    - "$min-$max", or "$value" when min===max (NO thousands separator,
//               matching the backend's formatRent).
//   [FlyerLink] - the argument (server truth, else the same-origin funnel).
import { formatAddress } from '../contact/format.js';
import type { UnitItem } from '../../api/index.js';

/** The default single-recipient message template (also the MessageEditor
 *  placeholder - imported there so there is ONE source of the copy). */
export const DEFAULT_SEND_TEMPLATE =
  'Hi [TenantName], a [Beds] home at [Address] is available for [Rent]/mo. Details: [FlyerLink]';

/** Neutral [TenantName] fallback when no first name is known - NEVER a phone. */
const NEUTRAL_TENANT_NAME = 'there';

/** A unit's asking-rent range; '' when no rent is known. Mirrors the backend's
 *  formatRent (unformatted dollars, so the preview matches the sent body). */
function rentText(unit: UnitItem): string {
  const min = typeof unit.rent_min === 'number' ? unit.rent_min : undefined;
  const max = typeof unit.rent_max === 'number' ? unit.rent_max : undefined;
  if (min !== undefined && max !== undefined && max !== min) return `$${min}-$${max}`;
  const v = min ?? max;
  return v !== undefined ? `$${v}` : '';
}

/** Escape a literal token (the tokens contain `[`/`]`) for a global RegExp. */
function tokenRegex(token: string): RegExp {
  return new RegExp(token.replace(/[[\]]/g, '\\$&'), 'g');
}

/** Client-side mirror of the backend's renderBody (mergeFields.ts). firstName
 *  undefined/blank -> the neutral fallback; a null unit (or missing field)
 *  drops the token to ''. */
export function resolveTemplateForTenant(
  template: string,
  unit: UnitItem | null,
  firstName: string | undefined,
  flyerLink: string | undefined,
): string {
  const name =
    firstName !== undefined && firstName.trim().length > 0 ? firstName.trim() : NEUTRAL_TENANT_NAME;
  return template
    .replace(tokenRegex('[TenantName]'), name)
    .replace(
      tokenRegex('[Beds]'),
      unit !== null && typeof unit.beds === 'number' ? String(unit.beds) : '',
    )
    .replace(tokenRegex('[Address]'), unit !== null ? formatAddress(unit.address) : '')
    .replace(tokenRegex('[Rent]'), unit !== null ? rentText(unit) : '')
    .replace(tokenRegex('[FlyerLink]'), flyerLink ?? '');
}
