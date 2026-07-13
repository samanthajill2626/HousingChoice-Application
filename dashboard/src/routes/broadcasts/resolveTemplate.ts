// resolveTemplate (Task 7) - the client-side mirror of the backend's renderBody
// (app/src/lib/mergeFields.ts) so the SINGLE-recipient editor can show EXACTLY
// what will send. NO AI: a literal token replace. Unit-derived tokens come from
// the attached unit; [TenantName] is the one per-recipient token (fallback
// "there" - never a phone/id). Unresolvable tokens (or no unit) render as ''.
//
// Parity notes (keep in lockstep with mergeFields.ts):
//   [Beds]    - String(beds), finite numbers only.
//   [Address] - a LOCAL port of the backend's formatAddress (app/src/lib/
//               address.ts - the dashboard cannot import from app/): "line1
//               line2, city, state zip" - line1+line2 and state+zip join with
//               a SPACE. NOT the dashboard's contact/format.js formatAddress,
//               which comma-joins everything and would diverge from the sent
//               body on structured addresses.
//   [Rent]    - "$min-$max", or "$value" when min===max (NO thousands separator,
//               matching the backend's formatRent; finite numbers only).
//   [FlyerLink] - the argument (server truth, else the same-origin funnel).
import type { UnitItem } from '../../api/index.js';

/** The default message template: a fresh compose PRE-FILLS it as the actual
 *  message (the send is usually close to it, so staff can go straight to
 *  Preview), and MessageEditor keeps it as the placeholder for a cleared
 *  textarea - ONE source of the copy for both. */
export const DEFAULT_SEND_TEMPLATE =
  'Hi [TenantName], a [Beds] home at [Address] is available for [Rent]/mo. Details: [FlyerLink]';

/** Neutral [TenantName] fallback when no first name is known - NEVER a phone. */
const NEUTRAL_TENANT_NAME = 'there';

/** One-line address, ported verbatim from the backend's formatAddress
 *  (app/src/lib/address.ts) so [Address] previews exactly what will send:
 *  "line1 line2, city, state zip". Tolerant of a legacy plain-string address
 *  (returned trimmed, as-is) and of missing fields. */
function serverFormatAddress(a: UnitItem['address']): string {
  if (a === undefined) return '';
  if (typeof a === 'string') return a.trim();
  const street = [a.line1, a.line2].filter((s) => s && s.length > 0).join(' ');
  const cityState = [a.city, [a.state, a.zip].filter((s) => s && s.length > 0).join(' ')]
    .filter((s) => s && s.length > 0)
    .join(', ');
  return [street, cityState].filter((s) => s.length > 0).join(', ');
}

/** A finite number, else undefined (the backend guards every numeric merge
 *  field with Number.isFinite - NaN/Infinity never reach a message body). */
function finite(n: number | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** A unit's asking-rent range; '' when no rent is known. Mirrors the backend's
 *  formatRent (unformatted dollars, so the preview matches the sent body). */
function rentText(unit: UnitItem): string {
  const min = finite(unit.rent_min);
  const max = finite(unit.rent_max);
  if (min !== undefined && max !== undefined && max !== min) return `$${min}-$${max}`;
  const v = min ?? max;
  return v !== undefined ? `$${v}` : '';
}

/** Escape a literal token (the tokens contain `[`/`]`) for a global RegExp. */
function tokenRegex(token: string): RegExp {
  return new RegExp(token.replace(/[[\]]/g, '\\$&'), 'g');
}

/** Resolve the UNIT-derived tokens ([Beds]/[Address]/[Rent]/[FlyerLink]) to
 *  literal text while PRESERVING [TenantName] - the one per-recipient token,
 *  rendered per recipient by the backend at send time. This is the multi-
 *  recipient prefill (property-first flow): staff see the real property
 *  details, and each tenant still gets their own name. */
export function resolveTemplateForUnit(
  template: string,
  unit: UnitItem | null,
  flyerLink: string | undefined,
): string {
  const beds = unit !== null ? finite(unit.beds) : undefined;
  return template
    .replace(tokenRegex('[Beds]'), beds !== undefined ? String(beds) : '')
    .replace(tokenRegex('[Address]'), unit !== null ? serverFormatAddress(unit.address) : '')
    .replace(tokenRegex('[Rent]'), unit !== null ? rentText(unit) : '')
    .replace(tokenRegex('[FlyerLink]'), flyerLink ?? '');
}

/** Client-side mirror of the backend's renderBody (mergeFields.ts): the unit
 *  resolution above PLUS [TenantName] (single-recipient resolved mode).
 *  firstName undefined/blank -> the neutral fallback; a null unit (or missing
 *  field) drops the token to ''. */
export function resolveTemplateForTenant(
  template: string,
  unit: UnitItem | null,
  firstName: string | undefined,
  flyerLink: string | undefined,
): string {
  const name =
    firstName !== undefined && firstName.trim().length > 0 ? firstName.trim() : NEUTRAL_TENANT_NAME;
  return resolveTemplateForUnit(template, unit, flyerLink).replace(
    tokenRegex('[TenantName]'),
    name,
  );
}
