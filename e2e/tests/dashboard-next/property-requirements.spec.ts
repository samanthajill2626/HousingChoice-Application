// e2e/tests/dashboard-next/property-requirements.spec.ts
//
// Landlord requirements and property fields (tracker #11 + #12; design
// docs/superpowers/specs/2026-10-20-property-requirements-design.md, section 6
// "E2E"), end to end against the real backend:
//   1. a landlord with requirements; "+ Add a property" pre-fills them (D7),
//      each field's flyer tag is its DESCRIPTION, never part of its name
//      (D10); clearing one item before saving makes it "Set on this property"
//      (D5, D6);
//   2. changing the landlord's pets in the landlord form makes a property that
//      copied them read "Landlord updated" (D6, D9);
//   3. Apply to properties (D8): the exception row starts unchecked with its
//      own value marked, the out-of-date row starts checked, and a property
//      whose pets details say "Cats OK" is an own value too and starts
//      unchecked; checked and updated, it records "No pets" with no details,
//      never "No pets (Cats OK)" (Cameron's O1);
//   4. that flyer shows the public items and none of the staff-only ones (D11;
//      since flyer-leads, 2026-10-21, rent, accessibility, lease terms, pets
//      and deposit are staff only too, and the New form's tags say so);
//   5. the property pages show the new values and the Activity line (D13), and
//      the unchecked exception was not written;
//   6. a Matching blast from a two-size property pre-fills two chips, and a
//      6-bedroom tenant matches 4+ (D4, D12).
//
// ISOLATION: everything is RUN-UNIQUE - two landlords, four properties, one
// housing authority and three tenants, all through the real routes and forms.
// Nothing is reseeded and nothing seeded is read or changed, so the lean world
// stays byte-stable (never Apply on a seeded landlord: it rewrites seeded
// units). dashboard-next dialect (e2e/support/selectors.md): a local NEXT, a
// local devLogin, raw page.request for setup, accessibility-first locators.
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { addOrg } from '../../fixtures/orgFixture.js';
import { ORG_PICKER, pickOrgName, pickVoucherSizes } from '../../scenarios/steps.js';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

/** The eight requirement items (plan 1.0), in display order. */
const ITEM_IDS = [
  'evictions',
  'credit_requirements',
  'income_requirements',
  'qualifications',
  'pets',
  'deposit',
  'application_fee',
  'touring',
] as const;
const ALL_COPIED: Record<string, string> = Object.fromEntries(ITEM_IDS.map((id) => [id, 'copied']));

/** Keys the public flyer projection must never carry (D11, plan 2.2). */
const NEVER_ON_FLYER = [
  'no_evictions_on_program',
  'evictions_notes',
  'credit_requirements',
  'income_requirements',
  'qualifications',
  'deposit_notes',
  'tour_type',
  'tour_process',
  'subzone',
  'notes',
  'requirement_sources',
] as const;

/** Keys flyer-leads D1 (2026-10-21) removed from the public flyer projection:
 *  they stay on the property, staff only. */
const TRIMMED_FROM_FLYER = [
  'rent_min',
  'rent_max',
  'lease_terms',
  'accessibility',
  'pets',
  'no_pets',
  'pet_fee',
  'deposit',
  'deposit_one_month',
  'deposit_flexible',
] as const;

interface Landlord {
  contactId: string;
  /** The display name the dashboard shows: "First Last". */
  name: string;
}

interface Tenant {
  contactId: string;
  name: string;
}

async function devLogin(page: Page): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email: 'va@example.com' } });
  expect(res.ok(), `dev-login failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);
}

let phoneSeq = 0;
/** A run-unique, well-formed NANP number (+1555 + 5 stamp digits + 2 seq digits). */
function uniquePhone(): string {
  phoneSeq += 1;
  return `+1555${`${Date.now()}`.slice(-5)}${String(phoneSeq).padStart(2, '0')}`;
}

async function createLandlord(api: APIRequestContext, firstName: string): Promise<Landlord> {
  const lastName = 'Reqlandlord';
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: { type: 'landlord', firstName, lastName, phone: uniquePhone() },
  });
  expect(res.status(), await res.text()).toBe(201);
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  return { contactId, name: `${firstName} ${lastName}` };
}

async function getContact(api: APIRequestContext, contactId: string): Promise<Record<string, unknown>> {
  const res = await api.get(`${NEXT}/api/contacts/${contactId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { contact: Record<string, unknown> }).contact;
}

async function getUnit(api: APIRequestContext, unitId: string): Promise<Record<string, unknown>> {
  const res = await api.get(`${NEXT}/api/units/${unitId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { unit: Record<string, unknown> }).unit;
}

/** Setup -> Available through the transition route (status is not a CRUD field). */
async function publish(api: APIRequestContext, unitId: string): Promise<void> {
  const res = await api.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

/** A tenant through the real routes: Searching, with recorded consent (a
 *  sendable Matching row), holding `housingAuthority`, which must already be a
 *  list name (the PATCH checks it; the create ignores the field). */
async function createTenant(
  api: APIRequestContext,
  opts: { firstName: string; voucherSize: number; housingAuthority: string },
): Promise<Tenant> {
  const lastName = 'Reqtenant';
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: {
      type: 'tenant',
      firstName: opts.firstName,
      lastName,
      phone: uniquePhone(),
      voucherSize: opts.voucherSize,
      status: 'searching',
      consent_method: 'verbal_in_person',
      consent_at: new Date().toISOString(),
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  const patch = await api.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { housingAuthority: opts.housingAuthority },
  });
  expect(patch.ok(), await patch.text()).toBeTruthy();
  return { contactId, name: `${opts.firstName} ${lastName}` };
}

/**
 * "+ Add a property" on the landlord page opens the New property form locked to
 * that landlord. With `prefilledFrom`, wait for the landlord's requirements to
 * fill in (D7) BEFORE `edit` runs, so the fill never lands on top of an edit.
 * Then fill the address and Create; the app lands on /listings/<unitId>, whose
 * id is returned.
 */
async function addPropertyFromLandlordPage(
  page: Page,
  landlord: Landlord,
  line1: string,
  opts: { prefilledFrom?: string; edit?: (dialog: Locator) => Promise<void> } = {},
): Promise<string> {
  await page.goto(`${NEXT}/contacts/${landlord.contactId}`);
  await page.getByRole('button', { name: 'Add a property for this landlord' }).click();
  const dialog = page.getByRole('dialog', { name: 'New property' });
  await expect(dialog).toBeVisible();
  if (opts.prefilledFrom !== undefined) {
    await expect(
      dialog.getByText(
        `Filled in from ${opts.prefilledFrom}'s requirements. Change anything that is different for this property.`,
        { exact: true },
      ),
    ).toBeVisible();
  }
  if (opts.edit !== undefined) await opts.edit(dialog);
  await dialog.getByLabel('Street address', { exact: true }).fill(line1);
  await dialog.getByLabel('City', { exact: true }).fill('Atlanta');
  await dialog.getByLabel('State', { exact: true }).fill('GA');
  await dialog.getByLabel('ZIP', { exact: true }).fill('30314');
  await dialog.getByRole('button', { name: /^Create$/ }).click();
  await page.waitForURL(/\/listings\/[^/?#]+$/);
  const match = /\/listings\/([^/?#]+)/.exec(page.url());
  if (match === null || match[1] === undefined) throw new Error('expected a /listings/:id URL after Create');
  return decodeURIComponent(match[1]);
}

/** The property page's Requirements card: a Card <section> whose <h3> starts
 *  with its title (the heading's name also carries its Edit action). */
function requirementsCard(page: Page): Locator {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: /^Requirements/ }) });
}

function activityCard(page: Page): Locator {
  return page.locator('section', { has: page.getByRole('heading', { name: 'Activity' }) });
}

test('landlord requirements: the New form pre-fills them, the property page tags exceptions and stale copies, Apply writes only the checked properties', async ({
  page,
}) => {
  // Two New property forms, the landlord form, the Apply dialog and five page
  // loads: about 55 s idle, so well past the 60 s default under load.
  test.setTimeout(240_000);
  await devLogin(page);
  const api = page.request;
  const stamp = `${Date.now()}`.slice(-6);

  // --- A landlord with requirements: every item recorded (D2, the req_ keys). ---
  const REQ = {
    evictionsNotes: `Nothing in the last five years ${stamp}`,
    credit: `Credit 580 or higher ${stamp}`,
    income: `Income twice the tenant share ${stamp}`,
    qualifications: `Two landlord references ${stamp}`,
    petsDetails: `Small dogs OK ${stamp}`,
    petFee: '$300',
    depositNotes: `Payment plan by arrangement ${stamp}`,
    tourProcess: `Text the landlord a day ahead ${stamp}`,
  };
  const landlord = await createLandlord(api, `Reqs${stamp}`);
  const recorded = await api.patch(`${NEXT}/api/contacts/${landlord.contactId}`, {
    data: {
      req_no_evictions_on_program: true,
      req_evictions_notes: REQ.evictionsNotes,
      req_credit_requirements: REQ.credit,
      req_income_requirements: REQ.income,
      req_qualifications: REQ.qualifications,
      req_pets: REQ.petsDetails,
      req_pet_fee: REQ.petFee,
      req_deposit_one_month: true,
      req_deposit_flexible: true,
      req_deposit_notes: REQ.depositNotes,
      req_application_fee: 0,
      req_tour_type: 'landlord_led',
      req_tour_process: REQ.tourProcess,
    },
  });
  expect(recorded.ok(), await recorded.text()).toBeTruthy();

  // --- 1. Property A: the New form starts filled in from the landlord (D7);
  // each tag is a description, not part of the name (D10); Credit score is
  // cleared before Create, so it is set on this property (D5, D6). ---
  const lineA = `${stamp} Reqs Exception St`;
  const unitA = await addPropertyFromLandlordPage(page, landlord, lineA, {
    prefilledFrom: landlord.name,
    edit: async (dialog) => {
      await expect(dialog.getByLabel('No evictions while on the program', { exact: true })).toBeChecked();
      await expect(dialog.getByLabel('Evictions (details)', { exact: true })).toHaveValue(REQ.evictionsNotes);
      await expect(dialog.getByLabel('Credit score', { exact: true })).toHaveValue(REQ.credit);
      await expect(dialog.getByLabel('Income requirements', { exact: true })).toHaveValue(REQ.income);
      await expect(dialog.getByLabel('Qualifications', { exact: true })).toHaveValue(REQ.qualifications);
      await expect(dialog.getByLabel('No pets', { exact: true })).not.toBeChecked();
      await expect(dialog.getByLabel('Pets (details)', { exact: true })).toHaveValue(REQ.petsDetails);
      await expect(dialog.getByLabel('Pet fee', { exact: true })).toHaveValue(REQ.petFee);
      await expect(dialog.getByLabel("One month's rent", { exact: true })).toBeChecked();
      await expect(dialog.getByLabel('Fixed amount', { exact: true })).toBeDisabled();
      await expect(dialog.getByLabel('Flexible / payment terms available', { exact: true })).toBeChecked();
      await expect(dialog.getByLabel('Deposit notes', { exact: true })).toHaveValue(REQ.depositNotes);
      await expect(dialog.getByLabel('No application fee', { exact: true })).toBeChecked();
      await expect(dialog.getByLabel('Application fee', { exact: true })).toBeDisabled();
      await expect(dialog.getByLabel('Tour type', { exact: true })).toHaveValue('landlord_led');
      await expect(dialog.getByLabel('Tour process', { exact: true })).toHaveValue(REQ.tourProcess);
      await expect(dialog.getByText('On flyer - tenants see it on the public flyer.', { exact: true })).toBeVisible();
      await expect(dialog.getByText('Staff only - never leaves the dashboard.', { exact: true })).toBeVisible();
      await expect(dialog.getByLabel('Credit score', { exact: true })).toHaveAccessibleDescription(/Staff only/);
      await expect(dialog.getByLabel('Subzone', { exact: true })).toHaveAccessibleDescription(/Staff only/);
      // flyer-leads D2 (2026-10-21): rent, accessibility, lease terms and every
      // field of the Pets and Deposit items are Staff only; the application fee
      // pair and tenant-paid utilities stay On flyer.
      for (const label of [
        'Rent min',
        'Rent max',
        'Accessibility',
        'Lease terms',
        'No pets',
        'Pets (details)',
        'Pet fee',
        "One month's rent",
        'Fixed amount',
        'Flexible / payment terms available',
      ]) {
        await expect(dialog.getByLabel(label, { exact: true }), label).toHaveAccessibleDescription(/Staff only/);
      }
      for (const label of ['No application fee', 'Application fee', 'Tenant-paid utilities']) {
        await expect(dialog.getByLabel(label, { exact: true }), label).toHaveAccessibleDescription(/On flyer/);
      }
      // D2: the public note shows only under an On flyer field - on this form,
      // Tenant-paid utilities alone (never under a Staff only field).
      await expect(dialog.getByText('Tenants see this on the public flyer.', { exact: true })).toHaveCount(1);
      await dialog.getByLabel('Credit score', { exact: true }).fill('');
    },
  });
  const cardA = requirementsCard(page);
  await expect(cardA.getByText('Set on this property', { exact: true })).toHaveCount(1);
  await expect(cardA.getByText(`Landlord: ${REQ.credit}`, { exact: true })).toBeVisible();
  await expect(cardA.getByText('Landlord updated', { exact: true })).toHaveCount(0);
  const createdA = await getUnit(api, unitA);
  expect('credit_requirements' in createdA).toBe(false);
  expect(createdA['requirement_sources']).toEqual({ ...ALL_COPIED, credit_requirements: 'set_here' });

  // Property B: the same pre-fill, untouched - every item is a copy.
  const lineB = `${stamp} Reqs Copy Ave`;
  const unitB = await addPropertyFromLandlordPage(page, landlord, lineB, { prefilledFrom: landlord.name });
  const createdB = await getUnit(api, unitB);
  expect(createdB['pets']).toBe(REQ.petsDetails);
  expect(createdB['requirement_sources']).toEqual(ALL_COPIED);

  // Property C: through the API with no snapshot (D5) - its "Cats OK" details
  // are the only requirement it writes, so the only item classified: set here.
  const lineC = `${stamp} Reqs Cats Ct`;
  const subzone = `SZ${stamp}`;
  const createC = await api.post(`${NEXT}/api/units`, {
    data: {
      landlordId: landlord.contactId,
      beds: 2,
      rent_min: 1500,
      rent_max: 1600,
      address: { line1: lineC, city: 'Atlanta', state: 'GA', zip: '30314' },
      pets: 'Cats OK',
      // D4: a list, stored de-duplicated and ascending.
      voucher_size_accepted: [3, 2, 3],
      washer_dryer: 'hookups',
      subzone,
    },
  });
  expect(createC.status(), await createC.text()).toBe(201);
  const createdC = ((await createC.json()) as { unit: Record<string, unknown> }).unit;
  const unitC = createdC['unitId'] as string;
  expect(createdC['voucher_size_accepted']).toEqual([2, 3]);
  expect(createdC['requirement_sources']).toEqual({ pets: 'set_here' });
  await publish(api, unitC);

  // --- 2. The landlord's pets change in the landlord form (D9): No pets, blank
  // details, no fee. ---
  await page.goto(`${NEXT}/contacts/${landlord.contactId}`);
  await page.getByRole('button', { name: 'Edit contact details' }).click();
  const editForm = page.getByRole('dialog', { name: /Edit contact/i });
  await expect(editForm.getByText('Requirements / Qualifications', { exact: true })).toBeVisible();
  await expect(editForm.getByLabel('Pets (details)', { exact: true })).toHaveValue(REQ.petsDetails);
  await editForm.getByLabel('No pets', { exact: true }).check();
  await editForm.getByLabel('Pets (details)', { exact: true }).fill('');
  await editForm.getByLabel('Pet fee', { exact: true }).fill('');
  await editForm.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editForm).toHaveCount(0, { timeout: 10_000 });
  const changed = await getContact(api, landlord.contactId);
  expect(changed['req_no_pets']).toBe(true);
  expect('req_pets' in changed).toBe(false);
  expect('req_pet_fee' in changed).toBe(false);
  expect(changed['req_credit_requirements']).toBe(REQ.credit);

  // B copied the old pets: copy only, so its own value stands and it now reads
  // "Landlord updated" with the landlord's new value.
  await page.goto(`${NEXT}/listings/${unitB}`);
  const cardB = requirementsCard(page);
  await expect(cardB.getByText('Landlord updated', { exact: true })).toHaveCount(1);
  await expect(cardB.getByText('Landlord now: No pets', { exact: true })).toBeVisible();
  await expect(cardB.getByText('Set on this property', { exact: true })).toHaveCount(0);
  await expect(cardB.getByText(REQ.petsDetails)).toBeVisible();

  // --- 3. Apply to properties (D8). ---
  await page.goto(`${NEXT}/contacts/${landlord.contactId}`);
  await page.getByRole('button', { name: 'Apply to properties', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Apply to properties' });
  const rows = dialog.getByRole('list', { name: 'Which properties' });
  const rowOf = (line1: string): Locator => rows.getByRole('listitem').filter({ hasText: line1 });
  await expect(rows.getByRole('listitem')).toHaveCount(3);
  // A: its own (blank) Credit score is among the changes -> unchecked, marked.
  await expect(rowOf(lineA)).toContainText('Credit score');
  await expect(rowOf(lineA).getByText('own value')).toHaveCount(1);
  await expect(rowOf(lineA).getByRole('checkbox')).not.toBeChecked();
  // B: only its out-of-date Pets copy changes -> checked, nothing marked.
  await expect(rowOf(lineB)).toContainText('Pets');
  await expect(rowOf(lineB).getByText('own value')).toHaveCount(0);
  await expect(rowOf(lineB).getByRole('checkbox')).toBeChecked();
  // C: "Cats OK" is its own Pets value -> unchecked, marked.
  await expect(rowOf(lineC)).toContainText('Pets');
  await expect(rowOf(lineC).getByText('own value')).toHaveCount(1);
  await expect(rowOf(lineC).getByRole('checkbox')).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Update 1 property', exact: true })).toBeEnabled();

  // Staff accept C's exception on purpose; A stays unchecked.
  await rowOf(lineC).getByRole('checkbox').check();
  const applyRequest = page.waitForRequest(
    (r) =>
      r.method() === 'POST' &&
      new URL(r.url()).pathname === `/api/contacts/${landlord.contactId}/requirements/apply`,
  );
  await dialog.getByRole('button', { name: 'Update 2 properties', exact: true }).click();
  const sent = (await applyRequest).postDataJSON() as {
    units: Array<{ unitId: string; ownItems: string[]; seen: Record<string, unknown> }>;
    items: string[];
  };
  expect([...sent.items].sort()).toEqual([...ITEM_IDS].sort());
  expect(sent.units).toHaveLength(2);
  // Planner ruling PR-1: each own value rides with C's value as the dialog read it.
  expect(sent.units).toEqual(
    expect.arrayContaining([
      { unitId: unitB, ownItems: [], seen: {} },
      { unitId: unitC, ownItems: ['pets'], seen: { pets: { no_pets: null, pets: 'Cats OK', pet_fee: null } } },
    ]),
  );
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText(/^Updated 2 properties/)).toBeVisible();
  await expect(page.getByText(/\d+ skipped/)).toHaveCount(0);

  // --- 4. C's flyer. C was created with no application fee, so the "No
  // application fee" row exists only since Apply: it proves this load carries
  // the applied values before the absences are read. Pets and Deposit are
  // staff only since flyer-leads (D1/D2, 2026-10-21), so neither the copied
  // "No pets" nor the deposit reaches the flyer; step 5 reads them on the
  // property. ---
  await page.goto(`${NEXT}/p/${unitC}`);
  await expect(page.getByText('No application fee', { exact: true })).toBeVisible();
  await expect(page.getByText('Fits a 2- or 3-bedroom voucher')).toBeVisible();
  await expect(page.getByText('Hookups', { exact: true })).toBeVisible();
  for (const gone of ['Pets', 'No pets', 'Pet fee', 'Deposit', "One month's rent, flexible / payment plan available"]) {
    await expect(page.getByText(gone, { exact: true }), gone).toHaveCount(0);
  }
  await expect(page.getByText('Cats OK')).toHaveCount(0);
  for (const staffOnly of [
    REQ.evictionsNotes,
    REQ.credit,
    REQ.income,
    REQ.qualifications,
    REQ.depositNotes,
    REQ.tourProcess,
    subzone,
    'No evictions while on the program',
    'Landlord-led',
  ]) {
    await expect(page.getByText(staffOnly), staffOnly).toHaveCount(0);
  }
  const flyerRes = await api.get(`${NEXT}/public/units/${unitC}/flyer`);
  expect(flyerRes.ok(), await flyerRes.text()).toBeTruthy();
  const { flyer } = (await flyerRes.json()) as { flyer: Record<string, unknown> };
  expect(flyer).toMatchObject({
    application_fee: 0,
    washer_dryer: 'hookups',
    voucher_sizes: [2, 3],
    voucher_size: 2,
  });
  for (const key of [...NEVER_ON_FLYER, ...TRIMMED_FROM_FLYER]) expect(Object.keys(flyer), key).not.toContain(key);

  // --- 5. The property pages. The Activity row renders with the loaded unit,
  // so the absences after it read the loaded card; requirement_sources is the
  // authority for "no tag" (a tag also waits on the landlord read). ---
  // B: written - the new pets value and the Activity line (D13).
  await page.goto(`${NEXT}/listings/${unitB}`);
  await expect(activityCard(page).getByText('Requirements applied from the landlord').first()).toBeVisible();
  await expect(requirementsCard(page).getByText(REQ.petsDetails)).toHaveCount(0);
  await expect(requirementsCard(page).getByText('Landlord updated', { exact: true })).toHaveCount(0);
  const appliedB = await getUnit(api, unitB);
  expect(appliedB['no_pets']).toBe(true);
  expect('pets' in appliedB).toBe(false);
  expect('pet_fee' in appliedB).toBe(false);
  expect(appliedB['requirement_sources']).toEqual(ALL_COPIED);

  // C: written - every item is now the landlord's, and a copy.
  await page.goto(`${NEXT}/listings/${unitC}`);
  await expect(activityCard(page).getByText('Requirements applied from the landlord').first()).toBeVisible();
  await expect(requirementsCard(page).getByText('Cats OK')).toHaveCount(0);
  await expect(requirementsCard(page).getByText('Set on this property', { exact: true })).toHaveCount(0);
  const appliedC = await getUnit(api, unitC);
  expect('pets' in appliedC).toBe(false);
  // O1, on the record now that pets are staff only (flyer-leads D1): the
  // copied item is "No pets" with no details, and the deposit was copied too.
  expect(appliedC['no_pets']).toBe(true);
  expect(appliedC['deposit_one_month']).toBe(true);
  expect(appliedC['credit_requirements']).toBe(REQ.credit);
  expect(appliedC['requirement_sources']).toEqual(ALL_COPIED);

  // A: NOT written (left unchecked) - its exception and its stale Pets copy stand.
  await page.goto(`${NEXT}/listings/${unitA}`);
  const cardA2 = requirementsCard(page);
  await expect(cardA2.getByText('Set on this property', { exact: true })).toHaveCount(1);
  await expect(cardA2.getByText('Landlord updated', { exact: true })).toHaveCount(1);
  await expect(cardA2.getByText('Landlord now: No pets', { exact: true })).toBeVisible();
  const untouchedA = await getUnit(api, unitA);
  expect(untouchedA['pets']).toBe(REQ.petsDetails);
  expect(untouchedA['requirement_sources']).toEqual({ ...ALL_COPIED, credit_requirements: 'set_here' });
});

test('Matching: a two-size property pre-fills two voucher chips, and a 6-bedroom tenant matches 4+', async ({
  page,
}) => {
  test.slow(); // a New property form, three tenants and a preview
  await devLogin(page);
  const api = page.request;
  const stamp = `${Date.now()}`.slice(-6);
  const authority = `Twosize Authority ${stamp}`;
  await addOrg(api, { kind: 'housing_authority', name: authority });
  const landlord = await createLandlord(api, `Sizes${stamp}`);

  // A property that takes 3- and 5-bedroom vouchers, through picker B (D4).
  const line1 = `${stamp} Reqs Two Sizes Way`;
  const unitId = await addPropertyFromLandlordPage(page, landlord, line1, {
    edit: async (dialog) => {
      await pickOrgName(page, dialog, 'Housing authorities', authority);
      await pickVoucherSizes(dialog, [3, 5]);
    },
  });
  const details = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Property details' }) });
  await expect(details.getByText('Voucher sizes accepted', { exact: true })).toBeVisible();
  await expect(details.getByText('3 BR, 5 BR', { exact: true })).toBeVisible();
  expect((await getUnit(api, unitId))['voucher_size_accepted']).toEqual([3, 5]);
  await publish(api, unitId);

  const six = await createTenant(api, { firstName: `Sixbr${stamp}`, voucherSize: 6, housingAuthority: authority });
  const three = await createTenant(api, { firstName: `Threebr${stamp}`, voucherSize: 3, housingAuthority: authority });
  const two = await createTenant(api, { firstName: `Twobr${stamp}`, voucherSize: 2, housingAuthority: authority });

  // D12: one chip per accepted size - 5 maps to the 4+ chip - each tagged.
  await page.goto(`${NEXT}/broadcasts/new?unitId=${unitId}`);
  await expect(page.getByRole('heading', { name: 'Send a property' })).toBeVisible();
  await expect(page.getByRole('button', { name: ORG_PICKER.removeChip(authority), exact: true })).toBeVisible();
  const threeBr = page.getByRole('button', { name: /^3-BR/ });
  const fourPlus = page.getByRole('button', { name: /^4\+ BR/ });
  await expect(threeBr).toHaveAttribute('aria-pressed', 'true');
  await expect(fourPlus).toHaveAttribute('aria-pressed', 'true');
  await expect(threeBr).toContainText(/matches property/i);
  await expect(fourPlus).toContainText(/matches property/i);
  await expect(page.getByRole('button', { name: /^2-BR/ })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText('Pre-filled to the voucher sizes this property takes: 3-BR, 4+ BR')).toBeVisible();

  // Let the message prefill settle before typing (it is written on property
  // load, then again with the server's ?cta=text link).
  const message = page.getByLabel('Message');
  await expect(message).toHaveValue(new RegExp(`/p/${unitId}\\?cta=text$`), { timeout: 15_000 });
  await message.fill(`Two sizes ${stamp} [FlyerLink]`);
  const previewBtn = page.getByRole('button', { name: 'Preview recipients' });
  await expect(previewBtn).toBeEnabled({ timeout: 15_000 });
  await previewBtn.click();
  await expect(page.getByRole('heading', { name: 'Review recipients' })).toBeVisible();
  const list = page.getByRole('list', { name: 'Candidate recipients' });
  // 4+ means 4 OR MORE: the 6-bedroom tenant is in (it never was before D12).
  await expect(list.getByRole('checkbox', { name: six.name, exact: true })).toBeChecked();
  await expect(list.getByRole('checkbox', { name: three.name, exact: true })).toBeChecked();
  // 2-BR was not chosen: that tenant is not listed at all.
  await expect(list.locator('li', { hasText: two.name })).toHaveCount(0);
});
