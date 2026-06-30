// Public (unauthenticated) API client for the public-pages funnel. These three
// endpoints are reachable with NO session — the public surface mounts OUTSIDE
// the auth gate. We reuse the SAME `request()` transport every other api/*.ts
// function uses (same-origin; the browser sends Origin so the app's origin/CSRF
// check passes). The flyer/details GETs return an opaque 404 (ApiError.status
// === 404) when a unit is missing OR not shareable — the funnel maps that to a
// friendly "no longer available" state, never an existence oracle.
//
// The TS shapes MIRROR app/src/lib/unitFields.ts (UnitFlyer / UnitFlyerDetails)
// exactly — same field names + nullability — so the public projection and the
// client never drift.
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

/** The minimal teaser flyer — the EXISTING `toUnitFlyer` allowlist. NO address,
 *  fees, or external link in the teaser view (the funnel drops `listing_link`). */
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
}

/** The post-intake "full details" reveal — the teaser PLUS address, utilities,
 *  video tour, application fee, same-day RTA. Mirrors `UnitFlyerDetails`. */
export interface PublicFlyerDetails extends PublicFlyer {
  address: PublicAddress;
  utilities: string | null;
  video_url: string | null;
  application_fee: number | null;
  same_day_rta: boolean | null;
}

/** Intake payload — first/last/phone required, voucher + unit optional. */
export interface HousingFairInput {
  firstName: string;
  lastName: string;
  phone: string;
  voucherSize?: number;
  /** When present (and a shareable unit), the signup is attributed to the home. */
  unitId?: string;
}

/** GET the teaser flyer. Throws ApiError (status 404) when unavailable. */
export async function getFlyer(unitId: string, signal?: AbortSignal): Promise<PublicFlyer> {
  const { flyer } = await request<{ flyer: PublicFlyer }>(
    `/public/units/${encodeURIComponent(unitId)}/flyer`,
    { signal },
  );
  return flyer;
}

/** GET the full-details reveal. Throws ApiError (status 404) when unavailable. */
export async function getFlyerDetails(
  unitId: string,
  signal?: AbortSignal,
): Promise<PublicFlyerDetails> {
  const { details } = await request<{ details: PublicFlyerDetails }>(
    `/public/units/${encodeURIComponent(unitId)}/details`,
    { signal },
  );
  return details;
}

/** POST the housing-fair intake. Omits unitId/voucherSize when not supplied so
 *  the body matches the backend's optional-field contract. */
export async function submitHousingFair(input: HousingFairInput): Promise<void> {
  const body: Record<string, unknown> = {
    firstName: input.firstName,
    lastName: input.lastName,
    phone: input.phone,
  };
  if (input.voucherSize !== undefined) body['voucherSize'] = input.voucherSize;
  if (input.unitId !== undefined) body['unitId'] = input.unitId;
  await request<{ ok: true }>('/public/housing-fair', { method: 'POST', body });
}
