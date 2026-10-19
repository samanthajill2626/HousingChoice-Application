// e2e/tests/dashboard-next/matching-blast-rules.spec.ts
//
// Matching blasts follow the audience rules (tracker #6; design
// docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md, section 6),
// end to end against the real backend:
//   - the bare Matching entry's property step offers Available properties only (D9);
//   - picking a property fills the "Housing authorities" multi picker with its
//     accepted authorities, and the voucher size with its beds (D3);
//   - the caption under the filters (D8);
//   - the filters reach Searching and Onboarding tenants in ANY of the selected
//     authorities only (D1, D2): a Placing tenant and a tenant with no housing
//     authority are not listed;
//   - a tenant with an unresolved tour for ANY property is listed, unchecked and
//     labeled, and Select all skips them (D4, D5, D7); a tour closed Not a fit
//     holds nothing;
//   - "Reaches N recipients" equals the rows that start checked (D8);
//   - Add a tenant adds the Placing tenant checked (a hand pick skips the rules);
//   - the send reaches exactly the checked tenants (fake-twilio thread store).
//
// ISOLATION: the lane keeps every earlier spec's tenants, so everything here is
// RUN-UNIQUE: two housing authorities added through POST /api/organizations,
// seven tenants, two properties and three tours created through the real
// routes. Nothing is reseeded and nothing seeded is changed. The tours sit on a
// second property left in Setup (a hold counts a tour for ANY property), which
// is also the non-Available property the picker must leave out. The 14-day
// tour-request boundary is unit-tested; no backdating seam exists, by design.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { getOutboundTo } from '../../fixtures/fakeTwilio.js';
import { addOrg } from '../../fixtures/orgFixture.js';
import { ORG_PICKER } from '../../scenarios/steps.js';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const DAY_MS = 24 * 60 * 60 * 1000;

/** The D8 caption with all three sentences (a housing authority is selected). */
const CAPTION = [
  'Only tenants in Onboarding or Searching are included.',
  'While a housing authority is selected, tenants whose housing authority is missing or not on the organization list are left out.',
  'Add any other tenant by hand when you review recipients.',
].join(' ');

interface Tenant {
  contactId: string;
  firstName: string;
  name: string;
  phone: string;
}

interface TourWire {
  tourId: string;
  status: string;
  createdAt: string;
  scheduledAt?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

/** A 2-BR tenant through the real routes, with recorded consent and an EXPLICIT
 *  status. `housingAuthority` must already be a list name: the PATCH applies the
 *  organization-list check (the create ignores the field). */
async function createTenant(
  api: APIRequestContext,
  opts: { firstName: string; status: 'searching' | 'onboarding' | 'placing'; housingAuthority?: string },
): Promise<Tenant> {
  const phone = uniquePhone();
  const lastName = 'Blastrule';
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: {
      type: 'tenant',
      firstName: opts.firstName,
      lastName,
      phone,
      voucherSize: 2,
      status: opts.status,
      consent_method: 'verbal_in_person',
      consent_at: new Date().toISOString(),
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  if (opts.housingAuthority !== undefined) {
    const patch = await api.patch(`${NEXT}/api/contacts/${contactId}`, {
      data: { housingAuthority: opts.housingAuthority },
    });
    expect(patch.ok(), await patch.text()).toBeTruthy();
  }
  return { contactId, firstName: opts.firstName, name: `${opts.firstName} ${lastName}`, phone };
}

/** A 2-BR property under the seeded landlord; `authorities` must be list names.
 *  New units start in Setup; `available` publishes it through the transition route. */
async function createUnit(
  api: APIRequestContext,
  opts: { line1: string; authorities: string[]; available: boolean },
): Promise<string> {
  const res = await api.post(`${NEXT}/api/units`, {
    data: {
      landlordId: 'contact-landlord-0001',
      beds: 2,
      accepted_authorities: opts.authorities,
      address: { line1: opts.line1, city: 'Atlanta', state: 'GA', zip: '30314' },
      rent_min: 1500,
      rent_max: 1600,
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const unitId = ((await res.json()) as { unit: { unitId: string } }).unit.unitId;
  if (opts.available) {
    const flip = await api.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
      data: { toStatus: 'available', source: 'manual' },
    });
    expect(flip.ok(), await flip.text()).toBeTruthy();
  }
  return unitId;
}

/** POST /api/tours: with scheduledAt the tour is scheduled; without, a dateless request. */
async function createTour(
  api: APIRequestContext,
  input: { tenantId: string; unitId: string; scheduledAt?: string },
): Promise<TourWire> {
  const res = await api.post(`${NEXT}/api/tours`, {
    data: {
      tenantId: input.tenantId,
      unitId: input.unitId,
      tourType: 'self_guided',
      ...(input.scheduledAt !== undefined && { scheduledAt: input.scheduledAt }),
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { tour: TourWire }).tour;
}

async function patchTour(api: APIRequestContext, tourId: string, data: Record<string, unknown>): Promise<TourWire> {
  const res = await api.patch(`${NEXT}/api/tours/${tourId}`, { data });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { tour: TourWire }).tour;
}

/** The dashboard's tour date ("Oct 20"), computed IN THE BROWSER so it uses the
 *  page's local timezone - the same call as shortDate in
 *  dashboard/src/routes/placements/placementsFormat.ts. */
async function browserShortDate(page: Page, iso: string): Promise<string> {
  return page.evaluate(
    (value) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    iso,
  );
}

test('a Matching blast follows the audience rules: status, housing authorities, tour holds, Available-only picker', async ({
  page,
  request,
}) => {
  test.slow();
  await devLogin(page);
  const api = page.request;
  const stamp = `${Date.now()}`.slice(-6);

  // --- Two run-unique listed housing authorities. ---
  const authA = `Wren Rules Authority ${stamp}`;
  const authB = `Finch Rules Authority ${stamp}`;
  await addOrg(api, { kind: 'housing_authority', name: authA });
  await addOrg(api, { kind: 'housing_authority', name: authB });

  // --- The Available property the blast sends (it accepts both authorities),
  // and a second one left in Setup that carries the tours. Both street lines
  // share the run-unique prefix the picker is searched by. ---
  const prefix = `${stamp} Blastrule`;
  const line1 = `${prefix} Ave`;
  const tourLine1 = `${prefix} Tour Ct`;
  const unitId = await createUnit(api, { line1, authorities: [authA, authB], available: true });
  const tourUnitId = await createUnit(api, { line1: tourLine1, authorities: [authA], available: false });

  // --- Seven tenants, all 2-BR with recorded consent and an explicit status. ---
  const searching = await createTenant(api, { firstName: `Searcha${stamp}`, status: 'searching', housingAuthority: authA });
  const onboarding = await createTenant(api, { firstName: `Onboardb${stamp}`, status: 'onboarding', housingAuthority: authB });
  const placing = await createTenant(api, { firstName: `Placinga${stamp}`, status: 'placing', housingAuthority: authA });
  const touring = await createTenant(api, { firstName: `Touringa${stamp}`, status: 'searching', housingAuthority: authA });
  const requesting = await createTenant(api, { firstName: `Requesta${stamp}`, status: 'searching', housingAuthority: authA });
  const notFit = await createTenant(api, { firstName: `Notfita${stamp}`, status: 'searching', housingAuthority: authA });
  const noAuthority = await createTenant(api, { firstName: `Noauth${stamp}`, status: 'searching' });

  // --- Tours, all on the Setup property. ---
  // An upcoming tour five days out.
  const upcoming = await createTour(api, {
    tenantId: touring.contactId,
    unitId: tourUnitId,
    scheduledAt: new Date(Date.now() + 5 * DAY_MS).toISOString(),
  });
  expect(upcoming.status).toBe('scheduled');
  expect(upcoming.scheduledAt, 'a scheduled tour carries its time').toBeDefined();
  // A fresh tour request with no date.
  const tourRequest = await createTour(api, { tenantId: requesting.contactId, unitId: tourUnitId });
  expect(tourRequest.status).toBe('requested');
  // notFit's ONLY tour: a request, toured two days ago, then closed Not a fit
  // with the dashboard's Record outcome PATCH.
  const fitTour = await createTour(api, { tenantId: notFit.contactId, unitId: tourUnitId });
  await patchTour(api, fitTour.tourId, {
    status: 'toured',
    scheduledAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
  });
  const closed = await patchTour(api, fitTour.tourId, { outcome: 'not_a_fit', moveForward: false, status: 'closed' });
  expect(closed.status).toBe('closed');

  // --- D9: the bare Matching entry's property step offers Available properties only. ---
  await page.goto(`${NEXT}/broadcasts/new`);
  await expect(page.getByRole('heading', { name: 'Send a property' })).toBeVisible();
  const propertyBox = page.getByRole('combobox', { name: 'Property' });
  await propertyBox.fill(prefix);
  await expect(page.getByRole('option', { name: new RegExp(escapeRegExp(line1)) })).toBeVisible();
  await expect(page.getByRole('option', { name: new RegExp(escapeRegExp(tourLine1)) })).toHaveCount(0);
  // Close the typeahead before using the rows under it (its options overlay
  // them; matching-entry-points.spec.ts documents the race).
  await propertyBox.press('Escape');
  await expect(page.getByRole('option'), 'the typeahead dropdown never closed').toHaveCount(0, {
    timeout: 10_000,
  });
  const properties = page.getByRole('list', { name: 'Properties', exact: true });
  const propertyRow = properties.getByRole('button', { name: new RegExp(escapeRegExp(line1)) });
  await expect(propertyRow).toBeVisible();
  await expect(properties.getByRole('button', { name: new RegExp(escapeRegExp(tourLine1)) })).toHaveCount(0);
  await propertyRow.click();

  // --- D3: both accepted authorities fill the multi picker; the voucher size
  // is the property's 2 beds. ---
  await expect(page.getByRole('combobox', { name: 'Housing authorities', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: ORG_PICKER.removeChip(authA), exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: ORG_PICKER.removeChip(authB), exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^2-BR/ })).toHaveAttribute('aria-pressed', 'true');

  // --- D8: the caption, all three sentences while authorities are selected. ---
  await expect(page.getByText(CAPTION, { exact: true })).toBeVisible();

  // Let the message prefill settle before typing: it is written on property
  // load, then again with the server's ?cta=text link
  // (docs/issues/a2p-consent-reinclude-fill-races-prefill.md).
  const message = page.getByLabel('Message');
  await expect(message).toHaveValue(new RegExp(`/p/${unitId}\\?cta=text$`), { timeout: 15_000 });
  const marker = `Rules check ${stamp}`;
  await message.fill(`${marker} [FlyerLink]`);
  const previewBtn = page.getByRole('button', { name: 'Preview recipients' });
  await expect(previewBtn).toBeEnabled({ timeout: 15_000 });
  await expect(message).toHaveValue(`${marker} [FlyerLink]`);

  // --- D8: the reach counts the rows that will START CHECKED - searching,
  // onboarding and notFit. touring and requesting are held; placing and
  // noAuthority are not in the audience at all. ---
  const startChecked = [searching, onboarding, notFit];
  await expect(page.getByText(`Reaches ${startChecked.length} recipients`, { exact: true })).toBeVisible();

  await previewBtn.click();
  await expect(page.getByRole('heading', { name: 'Review recipients' })).toBeVisible();
  const list = page.getByRole('list', { name: 'Candidate recipients' });
  const rowOf = (t: Tenant) => list.locator('li', { hasText: t.name });
  const boxOf = (t: Tenant, cues = '') => list.getByRole('checkbox', { name: `${t.name}${cues}`, exact: true });

  // Listed and checked: nothing holds them.
  for (const t of startChecked) await expect(boxOf(t)).toBeChecked();

  // Listed, UNCHECKED and labeled: the tour holds (a tour for ANY property, D4, D7).
  const upcomingLabel = `Tour ${await browserShortDate(page, upcoming.scheduledAt as string)}`;
  const requestedLabel = `Tour requested ${await browserShortDate(page, tourRequest.createdAt)}, no date yet`;
  await expect(rowOf(touring).getByText(upcomingLabel, { exact: true })).toBeVisible();
  await expect(rowOf(requesting).getByText(requestedLabel, { exact: true })).toBeVisible();
  const touringBox = boxOf(touring, ` - ${upcomingLabel.toLowerCase()}`);
  const requestingBox = boxOf(requesting, ` - ${requestedLabel.toLowerCase()}`);
  await expect(touringBox).not.toBeChecked();
  await expect(touringBox).toBeEnabled();
  await expect(requestingBox).not.toBeChecked();
  await expect(requestingBox).toBeEnabled();

  // Self-QA QA-L1: in the wide layout (a 768px+ review pane) a hold label wider
  // than the tags column wraps INSIDE the column. The tags were flex: 0 0 auto,
  // so this label ran past its row: the list scrolled sideways and cut it off
  // (34px past the list's visible right edge at 1280 wide, where it is measured).
  await page.setViewportSize({ width: 1280, height: 900 });
  const requestedTag = list.getByText(requestedLabel, { exact: true });
  await expect(requestedTag).toBeVisible();
  const tagRight = await requestedTag.evaluate((el) => el.getBoundingClientRect().right);
  const listBox = await list.evaluate((el) => ({
    visibleRight: el.getBoundingClientRect().left + el.clientWidth,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(tagRight, 'the tour-request tag stays inside the visible list').toBeLessThanOrEqual(
    listBox.visibleRight + 1,
  );
  expect(listBox.scrollWidth, 'the candidate list does not scroll sideways').toBeLessThanOrEqual(
    listBox.clientWidth + 1,
  );

  // The reach line equals the rows that start checked.
  await expect(list.getByRole('checkbox', { checked: true })).toHaveCount(startChecked.length);

  // Not in the audience at all (D1, D2) - asserted after the rows above rendered.
  await expect(rowOf(placing)).toHaveCount(0);
  await expect(rowOf(noAuthority)).toHaveCount(0);

  // --- Select all re-applies the default: the held rows stay unchecked. ---
  await page.getByRole('button', { name: 'Deselect all', exact: true }).click();
  await expect(list.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(touringBox).not.toBeChecked();
  await expect(requestingBox).not.toBeChecked();
  for (const t of startChecked) await expect(boxOf(t)).toBeChecked();
  await expect(list.getByRole('checkbox', { checked: true })).toHaveCount(startChecked.length);

  // --- Add a tenant: a hand pick skips the rules, so the Placing tenant joins checked. ---
  await page.getByRole('combobox', { name: 'Add a tenant' }).fill(placing.firstName);
  await page.getByRole('option', { name: new RegExp(escapeRegExp(placing.name)) }).click();
  await expect(rowOf(placing).getByText('Added', { exact: true })).toBeVisible();
  await expect(boxOf(placing)).toBeChecked();

  // --- Send: exactly the checked tenants. ---
  const recipients = [...startChecked, placing];
  await page.getByRole('button', { name: `Send to ${recipients.length} recipients`, exact: true }).click();
  await expect(page).toHaveURL(/\/broadcasts\/[A-Za-z0-9_-]+$/, { timeout: 15_000 });

  const hits = async (t: Tenant): Promise<number> =>
    (await getOutboundTo(request, { to: t.phone })).filter((m) => (m.body ?? '').includes(marker)).length;
  for (const t of recipients) {
    await expect
      .poll(() => hits(t), { timeout: 30_000, message: `${t.firstName} should receive the blast exactly once` })
      .toBe(1);
  }
  // Every recipient's copy has landed, so the fan-out is done: the others got none.
  for (const t of [touring, requesting, noAuthority]) {
    expect(await hits(t), `${t.firstName} must not receive the blast`).toBe(0);
  }
});
