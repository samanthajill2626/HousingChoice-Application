import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { expectTodayReady } from '../../support/today.js';

// Send outcome on the roster cards (spec 2026-10-12 section 8 (4), 5.4, 5.5,
// 14.3, D11): the property's "Sent to" card and the tenant's "Properties sent"
// card show the DERIVED outcome per row and carry its actions. Interested on a
// property WITH a tour type creates exactly one requested tour (route mode);
// on a property WITHOUT one it opens the Schedule a tour form with the tenant
// locked and creates nothing (form mode). Not interested / Undo round-trip on
// either card and mirror on the other, and a tour scheduled after a decline
// supersedes it. Every row is a run-unique tenant on a run-unique property, sent
// through a real broadcast.

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const DAY = 86_400_000;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function devLogin(page: Page): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email: 'va@example.com' } });
  expect(res.ok(), `dev-login failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);
}

/** A consented, run-unique tenant (consent so a send reaches them). */
async function createTenant(
  api: APIRequestContext,
  firstName: string,
  voucherSize = 2,
): Promise<{ contactId: string; firstName: string; name: string; phone: string }> {
  // The house idiom (matching-entry-points.spec.ts): 7 random digits.
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const lastName = 'Outcometest';
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

/** An Available 2-BR property; `tourType` set = the Interested ROUTE mode. */
async function createUnitViaApi(
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

function sentToCard(page: Page): Locator {
  // The heading's name includes its "Send this property" action - prefix match, never exact.
  return page.locator('section', { has: page.getByRole('heading', { name: /^Sent to\b/ }) });
}

function propertiesSentCard(page: Page): Locator {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: /Properties sent/ }) });
}

/** Markup R1: a row is the card's listitem holding the identity link. */
function rowFor(page: Page, card: Locator, linkName: string | RegExp): Locator {
  const name = typeof linkName === 'string' ? { name: linkName, exact: true } : { name: linkName };
  return card.getByRole('listitem').filter({ has: page.getByRole('link', name) });
}

interface RecipientWire {
  contactId: string;
  outcome: string;
  declined?: { by: string };
  tour?: { tourId: string };
}

async function recipients(api: APIRequestContext, unitId: string): Promise<RecipientWire[]> {
  const res = await api.get(`${NEXT}/api/units/${unitId}/recipients`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { recipients: RecipientWire[] }).recipients;
}

async function recipientRow(api: APIRequestContext, unitId: string, contactId: string): Promise<RecipientWire> {
  const row = (await recipients(api, unitId)).find((r) => r.contactId === contactId);
  expect(row, `no recipients row for ${contactId} on ${unitId}`).toBeDefined();
  return row!;
}

/** Send the property to these tenants through a real broadcast and wait for
 *  the ledger rows (the listing-activity.spec.ts idiom). */
async function sendTo(api: APIRequestContext, unitId: string, contactIds: string[], stamp: string): Promise<void> {
  const draft = await api.post(`${NEXT}/api/broadcasts`, {
    data: { unitId, body_template: `Outcome ${stamp} at [Address]`, audience_filter: { contact_type: 'tenant', bedroomSize: 2 } },
  });
  expect(draft.ok(), await draft.text()).toBeTruthy();
  const broadcastId = ((await draft.json()) as { broadcastId: string }).broadcastId;
  const send = await api.post(`${NEXT}/api/broadcasts/${broadcastId}/send`, { data: { recipientContactIds: contactIds } });
  expect(send.ok(), await send.text()).toBeTruthy();
  await expect
    .poll(
      async () => {
        const ids = (await recipients(api, unitId)).map((r) => r.contactId);
        return contactIds.every((id) => ids.includes(id));
      },
      { timeout: 30_000, message: 'the broadcast never wrote the listing-send rows' },
    )
    .toBe(true);
}

async function toursFor(api: APIRequestContext, tenantId: string, unitId: string): Promise<Array<{ tourId: string; status: string }>> {
  const res = await api.get(`${NEXT}/api/tours?tenantId=${encodeURIComponent(tenantId)}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { tours: Array<{ tourId: string; unitId: string; status: string }> }).tours.filter(
    (x) => x.unitId === unitId,
  );
}

function localDatetimeAt(base: Date, hour: number, minute: number): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}T${pad(hour)}:${pad(minute)}`;
}

/** Both Mark buttons ("interested" and "not interested") on a row. */
const ANY_MARK = /^Mark .+ interested in /;

test.describe('Send outcome on the roster cards (spec 2026-10-12 5.5)', () => {
  test('Interested creates exactly one tour, lands on Needs booking, and both cards read Tour requested', async ({ page }) => {
    await devLogin(page);
    const api = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const { unitId, line1 } = await createUnitViaApi(api, stamp, 'self_guided');
    const t = await createTenant(api, `Keen${stamp}`);
    await sendTo(api, unitId, [t.contactId], stamp);

    await page.goto(`${NEXT}/listings/${unitId}`);
    const row = rowFor(page, sentToCard(page), t.name);
    await expect(row.getByText('No reply yet', { exact: true })).toBeVisible();
    await row
      .getByRole('button', { name: new RegExp(`^Mark ${escapeRegExp(t.name)} interested in ${escapeRegExp(line1)}`) })
      .click();

    // The tour IS the outcome: the chip links to it and no outcome button remains.
    const chip = row.getByRole('link', { name: 'Tour requested' });
    await expect(chip).toBeVisible();
    await expect(row.getByRole('button', { name: ANY_MARK })).toHaveCount(0);

    // Exactly one requested tour (I3), and the chip links to it.
    await expect.poll(async () => (await toursFor(api, t.contactId, unitId)).length, { timeout: 15_000 }).toBe(1);
    const [tour] = await toursFor(api, t.contactId, unitId);
    expect(tour!.status).toBe('requested');
    await expect(chip).toHaveAttribute('href', `/tours/${tour!.tourId}`);
    await page.reload();
    await expect(rowFor(page, sentToCard(page), t.name).getByRole('link', { name: 'Tour requested' })).toBeVisible();
    expect((await toursFor(api, t.contactId, unitId)).length).toBe(1);

    // The tour list agrees (tours-page.spec.ts's Needs booking idiom).
    await page.goto(`${NEXT}/tours`);
    await expect(
      page.getByRole('region', { name: 'Needs booking' }).getByRole('link', {
        name: new RegExp(`Tour for ${escapeRegExp(t.name)} at .*${escapeRegExp(line1)}`, 'i'),
      }),
    ).toBeVisible({ timeout: 10_000 });

    // And so does the tenant's Properties sent card.
    await page.goto(`${NEXT}/contacts/${t.contactId}`);
    await expect(
      rowFor(page, propertiesSentCard(page), new RegExp(escapeRegExp(line1))).getByRole('link', { name: 'Tour requested' }),
    ).toBeVisible();
  });

  test('Not interested then Undo, recorded on either card and mirrored on the other', async ({ page }) => {
    await devLogin(page);
    const api = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const { unitId, line1 } = await createUnitViaApi(api, stamp, 'self_guided');
    const t = await createTenant(api, `Undo${stamp}`);
    await sendTo(api, unitId, [t.contactId], stamp);

    // Property card: Not interested.
    await page.goto(`${NEXT}/listings/${unitId}`);
    const row = rowFor(page, sentToCard(page), t.name);
    await row
      .getByRole('button', { name: new RegExp(`^Mark ${escapeRegExp(t.name)} not interested in ${escapeRegExp(line1)}`) })
      .click();
    await expect(row.getByText('Not interested', { exact: true })).toBeVisible();
    await expect(
      row.getByRole('button', { name: new RegExp(`^Undo not interested for ${escapeRegExp(t.name)}`) }),
    ).toBeVisible();
    await expect(row.getByRole('button', { name: ANY_MARK })).toHaveCount(0);
    const declined = await recipientRow(api, unitId, t.contactId);
    expect(declined.outcome).toBe('not_interested');
    expect(declined.declined?.by).toBe('staff');

    // The contact card mirrors it; Undo there.
    await page.goto(`${NEXT}/contacts/${t.contactId}`);
    const contactRow = rowFor(page, propertiesSentCard(page), new RegExp(escapeRegExp(line1)));
    await expect(contactRow.getByText('Not interested', { exact: true })).toBeVisible();
    await contactRow.getByRole('button', { name: /^Undo not interested for / }).click();
    await expect(contactRow.getByText('No reply yet', { exact: true })).toBeVisible();
    await expect(contactRow.getByRole('button', { name: /^Mark .+ not interested in / })).toBeVisible();

    // Back on the property card: waiting again, both Mark buttons back.
    await page.goto(`${NEXT}/listings/${unitId}`);
    await expect(row.getByText('No reply yet', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: ANY_MARK })).toHaveCount(2);
    const cleared = await recipientRow(api, unitId, t.contactId);
    expect(cleared.outcome).toBe('no_reply');
    expect(cleared.declined).toBeUndefined();
  });

  test('a tour scheduled from the Tours page after a decline flips the row to Tour scheduled', async ({ page }) => {
    await devLogin(page);
    const api = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const { unitId, line1 } = await createUnitViaApi(api, stamp, 'self_guided');
    const t = await createTenant(api, `Comeback${stamp}`);
    await sendTo(api, unitId, [t.contactId], stamp);

    await page.goto(`${NEXT}/listings/${unitId}`);
    const row = rowFor(page, sentToCard(page), t.name);
    await row
      .getByRole('button', { name: new RegExp(`^Mark ${escapeRegExp(t.name)} not interested in ${escapeRegExp(line1)}`) })
      .click();
    await expect(row.getByText('Not interested', { exact: true })).toBeVisible();

    // Schedule a tour from the Tours page (tours-page.spec.ts "+ New tour" flow);
    // three days out, so the reminder ladder sends nothing during the run.
    await page.goto(`${NEXT}/tours`);
    await page.getByRole('button', { name: '+ New tour' }).click();
    const dialog = page.getByRole('dialog', { name: /Schedule a tour/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Tenant' }).fill(t.firstName);
    await page
      .getByRole('listbox', { name: 'Tenant suggestions' })
      .getByRole('option', { name: new RegExp(escapeRegExp(t.name)) })
      .click();
    await dialog.getByRole('combobox', { name: 'Unit' }).fill(line1);
    await page
      .getByRole('listbox', { name: 'Unit suggestions' })
      .getByRole('option', { name: new RegExp(escapeRegExp(line1)) })
      .click();
    await dialog.getByLabel('Tour type').selectOption({ label: 'Self-guided' });
    await dialog.getByLabel('Date and time').fill(localDatetimeAt(new Date(Date.now() + 3 * DAY), 10, 0));
    await dialog.getByRole('button', { name: 'Schedule', exact: true }).click();
    await expect(page).toHaveURL(/\/tours\/[A-Za-z0-9_-]+$/, { timeout: 10_000 });
    const tourId = decodeURIComponent(new URL(page.url()).pathname.split('/').pop() ?? '');
    expect(tourId).not.toBe('');

    // D11: the NEW tour supersedes the earlier decline.
    await page.goto(`${NEXT}/listings/${unitId}`);
    await expect(async () => {
      await page.reload();
      const chip = row.getByRole('link', { name: 'Tour scheduled' });
      await expect(chip).toBeVisible({ timeout: 5_000 });
      await expect(chip).toHaveAttribute('href', `/tours/${tourId}`);
    }).toPass({ timeout: 20_000 });
    await expect(row.getByText('Not interested', { exact: true })).toHaveCount(0);
    await expect(row.getByRole('button', { name: /^Undo not interested for / })).toHaveCount(0);
    const wire = await recipientRow(api, unitId, t.contactId);
    expect(wire.outcome).toBe('interested');
    expect(wire.declined).toBeUndefined();

    await page.goto(`${NEXT}/contacts/${t.contactId}`);
    await expect(
      rowFor(page, propertiesSentCard(page), new RegExp(escapeRegExp(line1))).getByRole('link', { name: 'Tour scheduled' }),
    ).toBeVisible();
  });

  test('a property with no tour type opens the Schedule a tour form and creates nothing', async ({ page }) => {
    await devLogin(page);
    const api = page.request;
    const stamp = `${Date.now()}`.slice(-6);
    const { unitId, line1 } = await createUnitViaApi(api, stamp);
    const t = await createTenant(api, `Formmode${stamp}`);
    await sendTo(api, unitId, [t.contactId], stamp);

    await page.goto(`${NEXT}/listings/${unitId}`);
    const row = rowFor(page, sentToCard(page), t.name);
    await row
      .getByRole('button', { name: new RegExp(`^Mark ${escapeRegExp(t.name)} interested in ${escapeRegExp(line1)}`) })
      .click();
    await expect(page).toHaveURL(/[?&]tour=new(&|$)/);
    await expect(page).toHaveURL(new RegExp(`[?&]tenantId=${escapeRegExp(t.contactId)}(&|$)`));
    const dialog = page.getByRole('dialog', { name: /Schedule a tour/i });
    await expect(dialog).toBeVisible();
    // The tenant is LOCKED (14.3 B9): a named group, not a free typeahead.
    await expect(dialog.getByRole('group', { name: 'Tenant' })).toContainText(t.name);
    expect(await toursFor(api, t.contactId, unitId)).toHaveLength(0);

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog', { name: /Schedule a tour/i })).toHaveCount(0);
    await expect(page).not.toHaveURL(/[?&]tour=new/);
    await expect(row.getByText('No reply yet', { exact: true })).toBeVisible();
    expect(await toursFor(api, t.contactId, unitId)).toHaveLength(0);
  });
});
