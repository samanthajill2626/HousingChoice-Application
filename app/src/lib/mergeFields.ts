// Merge-field rendering (M1.8a) — a small PURE helper that substitutes the
// share-broadcast template tokens. NO AI: a literal token replace.
//
// Tokens:
//   [TenantName]  — the recipient's first name, else a neutral fallback
//                   ("there") — NEVER a phone number (PII leak guard).
//   [Beds]        — the unit's bedroom count.
//   [Address]     — formatAddress of the unit (one-line, NOT the public flyer).
//   [Rent]        — the unit's asking-rent range.
//   [FlyerLink]   — `${PUBLIC_BASE_URL}/p/${unitId}`.
//
// Unit-derived tokens come from the unit and are identical for every recipient;
// only [TenantName] is per-recipient, so the unit context is rendered ONCE and
// the per-recipient pass only swaps [TenantName]. Unknown/empty values render as
// an empty string or a neutral fallback — a missing first name never leaks a
// phone.
import { formatAddress } from './address.js';
import type { UnitItem } from '../repos/unitsRepo.js';

/** Neutral [TenantName] fallback when no first name is known — NEVER a phone. */
export const NEUTRAL_TENANT_NAME = 'there';

/** Public flyer URL shape — the funnel route the public surface mounts (the
 *  FlyerFunnel at /p/:unitId). Every shared [FlyerLink] must land here. */
export function flyerUrl(publicBaseUrl: string | undefined, unitId: string): string {
  const base = (publicBaseUrl ?? '').replace(/\/+$/, '');
  return `${base}/p/${unitId}`;
}

/** Format a unit's asking-rent range; '' when no rent is known. */
export function formatRent(unit: UnitItem | undefined): string {
  if (!unit) return '';
  const min = typeof unit.rent_min === 'number' && Number.isFinite(unit.rent_min) ? unit.rent_min : undefined;
  const max = typeof unit.rent_max === 'number' && Number.isFinite(unit.rent_max) ? unit.rent_max : undefined;
  if (min !== undefined && max !== undefined) {
    return min === max ? `$${min}` : `$${min}–$${max}`;
  }
  if (min !== undefined) return `$${min}`;
  if (max !== undefined) return `$${max}`;
  return '';
}

/** The unit-derived merge context, resolved ONCE per broadcast. */
export interface UnitMergeContext {
  beds: string;
  address: string;
  rent: string;
  flyerLink: string;
}

/**
 * Build the per-broadcast (unit-derived) merge context. unit may be undefined
 * (a unit-less broadcast — tokens render empty); flyerLink is empty when there
 * is no unitId.
 */
export function buildUnitMergeContext(
  unit: UnitItem | undefined,
  publicBaseUrl: string | undefined,
): UnitMergeContext {
  const beds =
    unit && typeof unit.beds === 'number' && Number.isFinite(unit.beds) ? String(unit.beds) : '';
  return {
    beds,
    address: unit ? formatAddress(unit.address) : '',
    rent: formatRent(unit),
    flyerLink: unit ? flyerUrl(publicBaseUrl, unit.unitId) : '',
  };
}

/** Escape a literal token for use inside a RegExp (the tokens have `[`/`]`). */
function tokenRegex(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'g');
}

/**
 * Render one recipient's message body: substitute the unit-derived tokens
 * (constant for the broadcast) + [TenantName] (per-recipient). firstName
 * undefined → the neutral fallback (never a phone). Returns the rendered string.
 */
export function renderBody(
  template: string,
  unitContext: UnitMergeContext,
  firstName: string | undefined,
): string {
  const tenantName =
    typeof firstName === 'string' && firstName.trim().length > 0
      ? firstName.trim()
      : NEUTRAL_TENANT_NAME;
  return template
    .replace(tokenRegex('[TenantName]'), tenantName)
    .replace(tokenRegex('[Beds]'), unitContext.beds)
    .replace(tokenRegex('[Address]'), unitContext.address)
    .replace(tokenRegex('[Rent]'), unitContext.rent)
    .replace(tokenRegex('[FlyerLink]'), unitContext.flyerLink);
}
