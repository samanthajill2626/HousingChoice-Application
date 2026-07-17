// Public (unauthenticated) API client for the public pages. These endpoints are
// reachable with NO session - the public surface mounts OUTSIDE the auth gate.
// We reuse the SAME request() transport every other api/*.ts function uses
// (same-origin; the browser sends Origin so the app's origin/CSRF check passes).
// getFlyer returns an opaque 404 (ApiError.status === 404) when a unit is missing
// OR not shareable - the flyer page maps that to a friendly "no longer available"
// state, never an existence oracle.
//
// PublicFlyer MIRRORS app/src/lib/unitFields.ts UnitFlyer exactly (same field
// names + nullability), PLUS contact_number (added by the route) - so the public
// projection and the client never drift.
import { request } from '../../api/client.js';

/** A structured postal address (allowlisted sub-fields only). Mirrors the app's
 *  `Address` (address.ts) — every field optional. */
export interface PublicAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  zip?: string;
}

/** The full public flyer - mirrors app/src/lib/unitFields.ts UnitFlyer exactly
 *  (same names + nullability), PLUS contact_number (config-sourced by the
 *  route: the main 1:1 business number, null when unconfigured). Everything is
 *  shown upfront - the teaser/reveal split is gone (flyer-full-info). */
export interface PublicFlyer {
  unitId: string;
  media: string[];
  beds: number | null;
  baths: number | null;
  area: string | null;
  subzone: string | null;
  voucher_size: number | null;
  accepted_programs: string[];
  listing_link: string | null;
  rent_min: number | null;
  rent_max: number | null;
  address: PublicAddress;
  utilities: string | null;
  video_url: string | null;
  application_fee: number | null;
  same_day_rta: boolean | null;
  pets: string | boolean | null;
  accessibility: string | null;
  deposit: number | null;
  lease_terms: string | null;
  contact_number: string | null;
}

/** Intake payload — first/last/phone required, voucher + unit optional.
 *  `smsConsent` is the REQUIRED A2P/CTIA consent flag: the client sends `true`
 *  only when the required consent checkbox is checked (the server rejects a
 *  missing/false value with 400 { error: 'consent_required' }). */
export interface HousingFairInput {
  firstName: string;
  lastName: string;
  phone: string;
  voucherSize?: number;
  /** When present (and a shareable unit), the signup is attributed to the home. */
  unitId?: string;
  /** do-not-remove — A2P/CTIA consent gate (client-side; server also enforces).
   *  True once the required consent checkbox is checked. */
  smsConsent: boolean;
}

/** GET the full public flyer. Throws ApiError (status 404) when unavailable. */
export async function getFlyer(unitId: string, signal?: AbortSignal): Promise<PublicFlyer> {
  const { flyer } = await request<{ flyer: PublicFlyer }>(
    `/public/units/${encodeURIComponent(unitId)}/flyer`,
    { signal },
  );
  return flyer;
}

/** POST the housing-fair intake. Omits unitId/voucherSize when not supplied so
 *  the body matches the backend's optional-field contract. ALWAYS sends
 *  `smsConsent` — the server requires it and rejects a missing/false value with
 *  400 { error: 'consent_required' }.
 *
 *  do-not-remove — A2P/CTIA consent gate (client-side; server also enforces). */
export async function submitHousingFair(input: HousingFairInput): Promise<void> {
  const body: Record<string, unknown> = {
    firstName: input.firstName,
    lastName: input.lastName,
    phone: input.phone,
    smsConsent: input.smsConsent,
  };
  if (input.voucherSize !== undefined) body['voucherSize'] = input.voucherSize;
  if (input.unitId !== undefined) body['unitId'] = input.unitId;
  await request<{ ok: true }>('/public/housing-fair', { method: 'POST', body });
}
