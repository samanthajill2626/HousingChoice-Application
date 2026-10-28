// Public (unauthenticated) API client for the public pages. These endpoints are
// reachable with NO session - the public surface mounts OUTSIDE the auth gate.
// We reuse the SAME request() transport every other api/*.ts function uses
// (same-origin; the browser sends Origin so the app's origin/CSRF check passes).
// getFlyer returns an opaque 404 (ApiError.status === 404) when a unit is
// missing, deleted or in Setup - one body for all three, never an existence
// oracle. The flyer page maps that, and any other failure, to a neutral
// sign-up page (permanent-flyer-links D4).
//
// PublicFlyer MIRRORS app/src/lib/unitFields.ts UnitFlyer exactly (same field
// names + nullability), PLUS contact_number (added by the route) - so the public
// projection and the client never drift.
import { ApiError, request } from '../../api/client.js';

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
 *  shown upfront - the teaser/reveal split is gone (flyer-full-info).
 *  flyer-leads D1 (spec 2026-10-21): rent, lease terms, accessibility, pets
 *  and deposit are staff only - the projection REMOVES those ten keys and
 *  this type drops them too. */
export interface PublicFlyer {
  unitId: string;
  media: string[];
  beds: number | null;
  baths: number | null;
  area: string | null;
  /** The FIRST accepted size - kept for flyer pages opened before D11 (they
   *  read it until they reload). This page reads `voucher_sizes`. */
  voucher_size: number | null;
  /** D11: every voucher size the home takes, ascending (the projection's
   *  acceptedVoucherSizes, so a home with none recorded falls back to beds). */
  voucher_sizes: number[];
  /** The authorities whose vouchers this unit accepts - synthesized server-side
   *  from `accepted_authorities`, falling back to a legacy `jurisdiction` value
   *  (spec section 8; app/src/lib/unitFields.ts `authoritiesOf`). */
  accepted_authorities: string[];
  listing_link: string | null;
  address: PublicAddress;
  utilities: string | null;
  video_url: string | null;
  application_fee: number | null;
  same_day_rta: boolean | null;
  washer_dryer: 'hookups' | 'included' | 'none' | null;
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
  /** When present (and a public unit - every status but Setup), the signup is
   *  attributed to the home. */
  unitId?: string;
  /** join-housing-authority D8: the chosen housing authority's exact listed
   *  name; omitted for "Not sure". /join only - the flyer never sends it (the
   *  server refuses a unitId together with a housingAuthority, spec D4). */
  housingAuthority?: string;
  /** do-not-remove — A2P/CTIA consent gate (client-side; server also enforces).
   *  True once the required consent checkbox is checked. */
  smsConsent: boolean;
}

/** GET the full public flyer. Throws ApiError (status 404) for a missing,
 *  deleted or Setup unit. */
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
  if (input.housingAuthority !== undefined) body['housingAuthority'] = input.housingAuthority;
  await request<{ ok: true }>('/public/housing-fair', { method: 'POST', body });
}

/** join-housing-authority D3: the sign-up's refusal code for a housingAuthority
 *  that is not exactly a listed name (the list changed after the page read it).
 *  Mirrors HOUSING_AUTHORITY_NOT_LISTED in app/src/services/publicOrgList.ts. */
export const HOUSING_AUTHORITY_NOT_LISTED = 'housing_authority_not_listed';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** join-housing-authority D1: GET /public/housing-authorities - the exact name
 *  of every housing authority on the organization list, sorted by the server.
 *  Throws ApiError on any failure: a non-2xx (a 429 included), a network
 *  failure, or a body that is not { names: string[] } (code invalid_response).
 *  An abort rethrows the DOMException, as request() does.
 *
 *  Keep the options argument an INLINE object literal and the path a string
 *  literal: e2e/performance/mutationCatalog.test.ts statically classifies every
 *  request() call (this one is request:GET, so it is not a catalog row). */
export async function getHousingAuthorities(signal?: AbortSignal): Promise<string[]> {
  const body = await request<{ names?: unknown } | undefined>('/public/housing-authorities', { signal });
  const names = body?.names;
  if (!isStringArray(names)) {
    throw new ApiError(0, 'invalid_response', 'Unexpected housing authority list response', body);
  }
  return names;
}
