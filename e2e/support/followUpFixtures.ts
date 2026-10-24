/**
 * Listing-share fixtures shared by the Matching Follow up tab spec and the
 * Today checklist spec (tracker #31, plan S7.2): a consented run-unique
 * tenant, an Available property, a hermetic listed send with a chosen sentAt,
 * and the contact's last_heard_from_at read back. Moved verbatim from
 * tests/dashboard-next/follow-up-tab.spec.ts; behavior unchanged.
 */
import { expect, type APIRequestContext } from '@playwright/test';
import { dashboardUrl } from './urls.js';

const NEXT = dashboardUrl;
export const DAY = 86_400_000;

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A consented, run-unique tenant (consent so a send reaches them). */
export async function createTenant(
  api: APIRequestContext,
  firstName: string,
  voucherSize = 2,
): Promise<{ contactId: string; firstName: string; name: string; phone: string }> {
  // The house idiom (matching-entry-points.spec.ts): 7 random digits.
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const lastName = 'Followtest';
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName, lastName, phone, voucherSize },
  });
  expect(res.status(), await res.text()).toBe(201);
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  const consent = await api.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
  });
  expect(consent.ok(), await consent.text()).toBeTruthy();
  return { contactId, firstName, name: `${firstName} ${lastName}`, phone };
}

export async function heardAt(api: APIRequestContext, contactId: string): Promise<string | undefined> {
  const res = await api.get(`${NEXT}/api/contacts/${contactId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { contact: { last_heard_from_at?: string } }).contact.last_heard_from_at;
}

/** An Available 2-BR property; `tourType` set = the Interested ROUTE mode. */
export async function createUnitViaApi(
  api: APIRequestContext,
  stamp: string,
  tourType?: 'self_guided' | 'landlord_led' | 'pm_team',
): Promise<{ unitId: string; line1: string }> {
  const line1 = `${stamp}${Math.floor(Math.random() * 90) + 10} Heardfrom Ave`;
  const res = await api.post(`${NEXT}/api/units`, {
    data: {
      landlordId: 'contact-landlord-0001',
      beds: 2,
      accepted_authorities: ['Atlanta Housing Authority'],
      address: { line1, city: 'Atlanta', state: 'GA', zip: '30314' },
      rent_min: 1500,
      rent_max: 1600,
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const unitId = ((await res.json()) as { unit: { unitId: string } }).unit.unitId;
  if (tourType !== undefined) {
    const typed = await api.patch(`${NEXT}/api/units/${unitId}`, { data: { tour_type: tourType } });
    expect(typed.ok(), await typed.text()).toBeTruthy();
  }
  const flip = await api.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(flip.ok(), await flip.text()).toBeTruthy();
  return { unitId, line1 };
}

/** A COUNTED, listed send with the given sentAt and NO broadcast behind it
 *  (S7's hermetic seam). */
export async function plantListedSend(api: APIRequestContext, unitId: string, contactId: string, sentAt: string): Promise<void> {
  const res = await api.post(`${NEXT}/__dev/listing-send-fixture`, { data: { unitId, contactId, sentAt } });
  expect(res.status(), await res.text()).toBe(201);
}

/** A sentAt n days back, padded a minute so floor() cannot read n-1. */
export function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY - 60_000).toISOString();
}
