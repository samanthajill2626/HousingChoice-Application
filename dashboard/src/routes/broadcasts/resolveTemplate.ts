// resolveTemplate (Task 7) - the client-side mirror of the backend's renderBody
// (app/src/lib/mergeFields.ts) so the composer can show EXACTLY what will send.
// NO AI: a literal token replace. Unit-derived tokens come from the attached
// unit; [TenantName] is the one per-recipient token, which a blast keeps as a
// token (the backend renders it per recipient at send time). The ONE-recipient
// editor (share-skip-fix D8) pre-fills ONE_TO_ONE_SEND_TEMPLATE, which carries
// no [TenantName], through resolveTemplateForUnit - so the dashboard never
// resolves [TenantName] itself any more (the former resolveTemplateForTenant
// was removed as dead code). Unresolvable tokens (or no unit) render as ''.
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
 *  textarea - ONE source of the copy for both. This is the BLAST default; its
 *  one-recipient twin, ONE_TO_ONE_SEND_TEMPLATE below, plays both roles in
 *  resolved (single-recipient) mode. */
export const DEFAULT_SEND_TEMPLATE =
  'Hi [TenantName], a [Beds]-bedroom home at [Address] is available for [Rent]/mo. Details: [FlyerLink]';

/** share-skip-fix D8 (Sam's #4): the ONE-RECIPIENT default. A navigator sharing
 *  one property with one tenant is usually mid-conversation, so the text is the
 *  address and the link and nothing else - no greeting, no beds, no rent. The
 *  blast default above is unchanged. Resolved through resolveTemplateForUnit
 *  (no per-recipient token here). Dashboard copy, not catalog copy: the
 *  operator sees and edits it before anything sends. */
export const ONE_TO_ONE_SEND_TEMPLATE = '[Address] [FlyerLink]';

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
 *  details, and each tenant still gets their own name. It also renders the
 *  one-recipient default (ONE_TO_ONE_SEND_TEMPLATE), which has no
 *  [TenantName] to keep. */
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
