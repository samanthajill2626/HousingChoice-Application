// e2e/fixtures/ranking.ts
//
// Control-plane helpers for the ranking e2e specs (WP1 B2a spec section 6).
// The hermetic lane runs RANKING_DRIVER=fake and RANKING_WORKER_POLL=off
// (scripts/e2e-session.mjs), so a ranking job runs ONLY when a spec calls
// `rankingTick`. The lean world has no available property and one searching
// tenant, so every spec builds its fixtures through the real API here:
//   - a RUN-UNIQUE housing authority (through POST /api/organizations), so
//     the pool holds only the spec's own records - a property that records
//     authorities is limited to the mapped ones, from either side (spec D1);
//   - available properties that accept only it;
//   - searching, textable tenants that hold it.
// Pass `page.request` after a dev-login: the API needs the session cookie.
// The tick is a dev route and needs none (as /__dev/extraction/tick).
import { expect, type APIRequestContext } from '@playwright/test';
import { addOrg } from './orgFixture.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

/** The lean world's landlord of record (app/src/lib/seed/lean.ts IDS.landlord). */
const LEAN_LANDLORD = 'contact-landlord-0001';

/** Run ONE ranking poll pass to completion (spec D7): it returns when the
 *  jobs it claimed have finished. */
export async function rankingTick(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${NEXT}/__dev/ranking/tick`);
  expect(res.ok(), `/__dev/ranking/tick failed: ${res.status()} ${await res.text()}`).toBeTruthy();
}

/** A run-unique housing authority on the organization list; returns its name. */
export async function runUniqueAuthority(api: APIRequestContext, name: string): Promise<string> {
  const entry = await addOrg(api, { kind: 'housing_authority', name });
  return entry.name;
}

let phoneSeq = 0;
/** A run-unique, well-formed NANP number (+1555 + 5 stamp digits + 2 seq digits). */
function uniquePhone(): string {
  phoneSeq += 1;
  return `+1555${`${Date.now()}`.slice(-5)}${String(phoneSeq).padStart(2, '0')}`;
}

export interface RankingTenant {
  contactId: string;
  /** The display the ranking shows: "<firstName> Rankcand". */
  name: string;
}

/** A searching 2-BR tenant with a phone (so sendable, spec D1) holding the
 *  run-unique authority. The create ignores `housingAuthority`; the PATCH
 *  applies the organization-list check. */
export async function createSearchingTenant(
  api: APIRequestContext,
  opts: { firstName: string; authority: string; pets?: string; notes?: string; areaPreference?: string },
): Promise<RankingTenant> {
  const lastName = 'Rankcand';
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: {
      type: 'tenant',
      firstName: opts.firstName,
      lastName,
      phone: uniquePhone(),
      voucherSize: 2,
      status: 'searching',
      ...(opts.pets !== undefined && { pets: opts.pets }),
      ...(opts.notes !== undefined && { notes: opts.notes }),
      ...(opts.areaPreference !== undefined && { area_preference: opts.areaPreference }),
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  const patch = await api.patch(`${NEXT}/api/contacts/${contactId}`, { data: { housingAuthority: opts.authority } });
  expect(patch.ok(), await patch.text()).toBeTruthy();
  return { contactId, name: `${opts.firstName} ${lastName}` };
}

/** An AVAILABLE 2-BR property that accepts a 2-BR voucher and only the given
 *  authority. New units start in Setup; the transition route publishes it. */
export async function createAvailableProperty(
  api: APIRequestContext,
  opts: { line1: string; authority: string; area?: string; noPets?: boolean },
): Promise<string> {
  const res = await api.post(`${NEXT}/api/units`, {
    data: {
      landlordId: LEAN_LANDLORD,
      beds: 2,
      voucher_size_accepted: [2],
      accepted_authorities: [opts.authority],
      address: { line1: opts.line1, city: 'Atlanta', state: 'GA', zip: '30314' },
      rent_min: 1500,
      rent_max: 1600,
      ...(opts.area !== undefined && { area: opts.area }),
      ...(opts.noPets === true && { no_pets: true }),
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const unitId = ((await res.json()) as { unit: { unitId: string } }).unit.unitId;
  const flip = await api.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(flip.ok(), await flip.text()).toBeTruthy();
  return unitId;
}
