// e2e/tests/dashboard-next/property-roster.spec.ts
//
// The property page's Contacts card is the ROSTER EDITOR (contact-rosters spec
// 6.1 / D9). It is the ONE place a property's PRIMARY CONTACT is set, and the
// primary contact is who a tour or placement puts on the group text and reaches
// by masked call whenever nobody has overridden that tour's own roster.
//
// This spec is the end-to-end proof that the editor and the resolver are the
// same fact, walked over the motivating PM-managed property:
//
//   1. add a property manager to the property roster (committed-pick contact
//      search + role), with the OWNER immovable as the landlord of record
//   2. make the PM the primary contact
//   3. the TOUR page's People card now resolves to the PM (slice 3 resolution) -
//      the card the operator reads for "who is on this tour" followed a change
//      made on a different page entirely
//   4. remove the PM - the confirm NAMES the owner who inherits the routing,
//      because silently re-pointing live calls is not acceptable
//   5. the tour's People card falls back to the owner
//
// The tour deliberately has NO relay group and no plan override, so its roster
// resolves from the PROPERTY (spec D1/D3) - which is exactly the link under test.
//
// dashboard-next dialect (e2e/support/selectors.md): a local NEXT const + a
// local devLogin, raw page.request for setup, accessibility-first locators, no
// Scenario verbs. Self-clean isolation: every contact / property / tour is
// minted fresh per test, so NOTHING here reseeds (a reseed mid-suite would wipe
// other specs' data and log this session out).
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/** A run-unique E.164 (the landlord-activity.spec idiom) - never a seeded number. */
function freshPhone(): string {
  return `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
}

interface Party {
  contactId: string;
  firstName: string;
  lastName: string;
  phone: string;
  /** The display name every roster surface renders for this contact. */
  name: string;
}

/** A fresh typed contact. A property manager is a `landlord`-typed contact
 *  (useContacts' TYPES_FOR note) - the ROLE is what the roster row carries. */
async function createContact(
  request: APIRequestContext,
  type: 'tenant' | 'landlord',
  firstName: string,
): Promise<Party> {
  const lastName = 'Proster';
  const phone = freshPhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type, firstName, lastName, phone, ...(type === 'tenant' && { voucherSize: 2 }) },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  return { contactId, firstName, lastName, phone, name: `${firstName} ${lastName}` };
}

/** An AVAILABLE property owned by `landlordId` (POST /api/units + publish). */
async function createAvailableUnit(request: APIRequestContext, landlordId: string): Promise<string> {
  const line1 = `${`${Date.now()}`.slice(-6)} Property Roster Way NW`;
  const res = await request.post(`${NEXT}/api/units`, {
    data: {
      landlordId,
      jurisdiction: 'atlanta_housing',
      beds: 2,
      rent_min: 1500,
      rent_max: 1600,
      address: { line1, city: 'Atlanta', state: 'GA', zip: '30314' },
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const unitId = ((await res.json()) as { unit: { unitId: string } }).unit.unitId;
  const pub = await request.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(pub.ok(), await pub.text()).toBeTruthy();
  return unitId;
}

/** A tour via the real route. Timeless ('requested') - no ladder is armed and,
 *  crucially, no relay group exists, so the roster resolves from the property. */
async function createTour(
  request: APIRequestContext,
  data: { tenantId: string; unitId: string; tourType: string },
): Promise<string> {
  const res = await request.post(`${NEXT}/api/tours`, { data });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { tour: { tourId: string } }).tour.tourId;
}

test.describe('Property roster editor - the Contacts card sets the primary contact', () => {
  test('add a PM, make them primary, and the tour People card follows - then falls back on removal', async ({
    page,
  }) => {
    test.slow(); // a full build-a-world walk (owner + property + PM + tenant + tour).
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);

    const owner = await createContact(req, 'landlord', `Prowner${stamp}`);
    const unitId = await createAvailableUnit(req, owner.contactId);
    const pm = await createContact(req, 'landlord', `Prpm${stamp}`);
    const tenant = await createContact(req, 'tenant', `Prten${stamp}`);
    const tourId = await createTour(req, {
      tenantId: tenant.contactId,
      unitId,
      tourType: 'landlord_led',
    });

    // --- 1. Add the PM to the property roster --------------------------------
    await page.goto(`${NEXT}/listings/${unitId}`);
    await page.getByRole('button', { name: 'Edit contacts' }).click();
    await page.getByRole('button', { name: '+ Add contact' }).click();
    const search = page.getByRole('combobox', { name: 'Add contact' });
    await search.fill(pm.firstName);
    // Picking COMMITS the field (committed-selection typeahead): typing alone
    // never carries a contactId, so nobody can be added by a near-miss.
    await page.getByRole('option', { name: pm.name }).click();
    await page.getByRole('combobox', { name: 'Role for the new contact' }).selectOption('pm');
    await page.getByRole('button', { name: 'Add contact to this property' }).click();

    // Persisted ON CLICK: the PM is now a roster row with its own controls.
    const makePmPrimary = page.getByRole('button', { name: `Make ${pm.name} the primary contact` });
    await expect(makePmPrimary).toBeVisible({ timeout: 20_000 });
    // The owner is the LANDLORD OF RECORD - immovable from the roster, with the
    // reason on the row rather than a doomed click.
    await expect(
      page.getByRole('button', { name: `Remove ${owner.name} from this property` }),
    ).toBeDisabled();

    // --- 2. Make the PM the primary contact ----------------------------------
    await makePmPrimary.click();
    // The star moved: the owner now offers the control and the PM no longer does.
    await expect(
      page.getByRole('button', { name: `Make ${owner.name} the primary contact` }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(makePmPrimary).toHaveCount(0);

    // --- 3. The TOUR's People card resolves to the PM ------------------------
    const roster = page.getByRole('list', { name: 'Roster' });
    await page.goto(`${NEXT}/tours/${tourId}`);
    await expect(roster.getByRole('link', { name: pm.name })).toBeVisible({ timeout: 20_000 });
    await expect(roster.getByRole('link', { name: tenant.name })).toBeVisible();
    // The owner is NOT on this tour: the default is tenant + the property's
    // primary contact, and the primary contact is the PM now.
    await expect(roster.getByRole('link', { name: owner.name })).toHaveCount(0);

    // --- 4. Remove the PM: the confirm NAMES the promotion -------------------
    await page.goto(`${NEXT}/listings/${unitId}`);
    await page.getByRole('button', { name: 'Edit contacts' }).click();
    await page.getByRole('button', { name: `Remove ${pm.name} from this property` }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove the primary contact?' });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(
        `${owner.name} becomes the primary contact - calls and new group texts for this property will go to them.`,
      ),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Remove contact' }).click();
    await expect(
      page.getByRole('button', { name: `Remove ${pm.name} from this property` }),
    ).toHaveCount(0, { timeout: 20_000 });

    // --- 5. The tour's People card falls back to the owner -------------------
    await page.goto(`${NEXT}/tours/${tourId}`);
    await expect(roster.getByRole('link', { name: owner.name })).toBeVisible({ timeout: 20_000 });
    await expect(roster.getByRole('link', { name: tenant.name })).toBeVisible();
    await expect(roster.getByRole('link', { name: pm.name })).toHaveCount(0);
  });
});
