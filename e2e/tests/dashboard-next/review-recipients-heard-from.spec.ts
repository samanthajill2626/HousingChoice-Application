import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { APP_NUMBER, getOutboundTo, registerParty, sendAsParty } from '../../fixtures/fakeTwilio.js';
import { expectTodayReady } from '../../support/today.js';

// Review recipients (spec 2026-10-12 section 8 (3), 5.3, 14.4 B7/B8/B11, D4,
// D11): the review step shows Name / Status / Housing authority / Last heard
// from columns OUTSIDE the candidate list, orders the combined list by last
// heard from (absent last), keeps a filter-proposed declined row unchecked
// (and Select all skips it) while a hand-picked declined row stays checked,
// and a deliberate send to declined rows reaches them and clears the decline.
//
// The declines are planted on a COUNTED, listed send with NO broadcast behind
// it (the `/__dev/listing-send-fixture` seam), so the two declined tenants are
// NOT "Already sent" - the decline rule is proved on its own.

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

// The review pane must clear the 768px column breakpoint (14.4 B8); the review
// step replaces the compose form, so the pane is the page's width.
test.use({ viewport: { width: 1440, height: 900 } });

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
  const lastName = 'Heardtest';
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

async function heardAt(api: APIRequestContext, contactId: string): Promise<string | undefined> {
  const res = await api.get(`${NEXT}/api/contacts/${contactId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { contact: { last_heard_from_at?: string } }).contact.last_heard_from_at;
}

/** An Available 2-BR property (no tour type - the review step does not read it). */
async function createUnitViaApi(api: APIRequestContext, stamp: string): Promise<{ unitId: string; line1: string }> {
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
  const flip = await api.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(flip.ok(), await flip.text()).toBeTruthy();
  return { unitId, line1 };
}

/** A COUNTED, listed send with the given sentAt and NO broadcast behind it
 *  (S7's hermetic seam) - so the composer never flags it "Already sent". */
async function plantListedSend(api: APIRequestContext, unitId: string, contactId: string, sentAt: string): Promise<void> {
  const res = await api.post(`${NEXT}/__dev/listing-send-fixture`, { data: { unitId, contactId, sentAt } });
  expect(res.status(), await res.text()).toBe(201);
}

/** An inbound 1:1 text, then poll until it stamps last_heard_from_at. */
async function hearFrom(
  api: APIRequestContext,
  request: APIRequestContext,
  t: { contactId: string; firstName: string; name: string; phone: string },
): Promise<string> {
  await registerParty(request, { label: t.name, role: 'tenant', number: t.phone });
  await sendAsParty(request, { from: t.phone, to: APP_NUMBER, body: `Hi ${t.firstName}` });
  let at: string | undefined;
  await expect
    .poll(async () => (at = await heardAt(api, t.contactId)) !== undefined, {
      timeout: 20_000,
      message: `last_heard_from_at never landed on ${t.contactId}`,
    })
    .toBe(true);
  return at!;
}

interface RecipientWire {
  contactId: string;
  outcome: string;
  declined?: { by: string };
}

async function recipients(api: APIRequestContext, unitId: string): Promise<RecipientWire[]> {
  const res = await api.get(`${NEXT}/api/units/${unitId}/recipients`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { recipients: RecipientWire[] }).recipients;
}

test('Review recipients: columns, last-heard order, declined rows unchecked unless hand-picked, and a deliberate send', async ({
  page,
  request,
}) => {
  test.slow();
  await devLogin(page);
  const api = page.request;
  const stamp = `${Date.now()}`.slice(-6);

  // --- Setup: a property, four 2-BR tenants and one 3-BR (outside the audience,
  // so it must be hand-added). ---
  const { unitId } = await createUnitViaApi(api, stamp);
  const older = await createTenant(api, `Older${stamp}`);
  const recent = await createTenant(api, `Recent${stamp}`);
  const never = await createTenant(api, `Never${stamp}`);
  const declined = await createTenant(api, `Declined${stamp}`);
  const declinedAdded = await createTenant(api, `Declinedadd${stamp}`, 3);

  // Two distinct heard-from instants, `recent` the later.
  const olderAt = await hearFrom(api, request, older);
  const recentAt = await hearFrom(api, request, recent);
  expect(Date.parse(recentAt)).toBeGreaterThan(Date.parse(olderAt));

  // Two declines on this property, each on a planted send an hour old.
  for (const t of [declined, declinedAdded]) {
    await plantListedSend(api, unitId, t.contactId, new Date(Date.now() - 3_600_000).toISOString());
    const res = await api.post(`${NEXT}/api/units/${unitId}/recipients/${t.contactId}/outcome`, {
      data: { outcome: 'not_interested' },
    });
    expect(res.status(), await res.text()).toBe(200);
  }

  // --- Preview ---
  await page.goto(`${NEXT}/broadcasts/new?unitId=${unitId}`);
  await expect(page.getByRole('heading', { name: 'Send a property' })).toBeVisible();
  await page.getByLabel('Message').fill(`Heard review ${stamp} [FlyerLink]`);
  const previewBtn = page.getByRole('button', { name: 'Preview recipients' });
  await expect(previewBtn).toBeEnabled({ timeout: 15_000 });
  await previewBtn.click();
  await expect(page.getByRole('heading', { name: 'Review recipients' })).toBeVisible();
  const list = page.getByRole('list', { name: 'Candidate recipients' });
  await expect(list).toBeVisible();

  // --- Columns (N2 P1): the header cells sit in an aria-hidden row BESIDE the
  // list (same frame), never inside it, so they are found by TEXT and every row
  // stays one listitem. ---
  const frame = list.locator('xpath=..');
  for (const label of ['Name', 'Status', 'Housing authority', 'Last heard from']) {
    await expect(frame.getByText(label, { exact: true })).toBeVisible();
    await expect(list.getByText(label, { exact: true })).toHaveCount(0);
  }
  // Row cells: the tenant StatusBadge and the BARE last-heard label (the narrow
  // layout's "Last heard from " prefix is CSS ::before, never DOM text).
  const recentRow = list.locator('li', { hasText: recent.name });
  await expect(recentRow.getByText('Onboarding', { exact: true })).toBeVisible();
  await expect(recentRow.getByText(/^Today \d{1,2}:\d{2} [AP]M$/)).toBeVisible();
  await expect(list.locator('li', { hasText: never.name }).getByText('Never', { exact: true })).toBeVisible();

  // --- Order: the combined list sorts by last heard from, absent last. ---
  const texts = await list.getByRole('listitem').allInnerTexts();
  const at = (n: string): number => texts.findIndex((x) => x.includes(n));
  expect(at(recent.name), 'recent is listed').toBeGreaterThanOrEqual(0);
  expect(at(older.name), 'older is listed').toBeGreaterThanOrEqual(0);
  expect(at(never.name), 'never is listed').toBeGreaterThanOrEqual(0);
  expect(at(recent.name)).toBeLessThan(at(older.name));
  expect(at(older.name)).toBeLessThan(at(never.name));

  // --- A filter-proposed declined row starts unchecked; Select all skips it. ---
  const declinedRow = list.locator('li', { hasText: declined.name });
  await expect(declinedRow.getByText('Not interested', { exact: true })).toBeVisible();
  await expect(declinedRow.getByText('Already sent', { exact: true })).toHaveCount(0);
  const declinedBox = list.getByRole('checkbox', { name: `${declined.name} - not interested`, exact: true });
  await expect(declinedBox).not.toBeChecked();
  await expect(declinedBox).toBeEnabled();
  // exact: a non-exact "Select all" also matches "Deselect all" (substring).
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(declinedBox).not.toBeChecked();
  await expect(list.getByRole('checkbox', { name: recent.name, exact: true })).toBeChecked();

  // --- A hand-added declined row is a deliberate pick: it stays checked. ---
  await page.getByRole('button', { name: 'Deselect all', exact: true }).click();
  await page.getByRole('combobox', { name: 'Add a tenant' }).fill(declinedAdded.firstName);
  const option = page.getByRole('option', { name: new RegExp(escapeRegExp(declinedAdded.name)) });
  await expect(option).toContainText('Not interested');
  await option.click();
  const addedRow = list.locator('li', { hasText: declinedAdded.name });
  await expect(addedRow.getByText('Not interested', { exact: true })).toBeVisible();
  await expect(addedRow.getByText('Added', { exact: true })).toBeVisible();
  await expect(
    list.getByRole('checkbox', { name: `${declinedAdded.name} - not interested`, exact: true }),
  ).toBeChecked();

  // --- A deliberate send to both declined rows reaches them and clears both
  // declines (the new send's sentAt supersedes them - D4, D11). ---
  await declinedBox.check();
  await page.getByRole('button', { name: /^Send to 2 recipients\b/ }).click();
  await expect(page).toHaveURL(/\/broadcasts\/[A-Za-z0-9_-]+$/, { timeout: 15_000 });
  await expect
    .poll(
      async () => {
        const rows = await recipients(api, unitId);
        return [declined.contactId, declinedAdded.contactId].every((id) =>
          rows.some((r) => r.contactId === id && r.outcome === 'no_reply' && r.declined === undefined),
        );
      },
      { timeout: 30_000, message: 'the send never superseded both declines' },
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        (await getOutboundTo(request, { to: declined.phone })).some((m) =>
          (m.body ?? '').includes(`Heard review ${stamp}`),
        ),
      { timeout: 30_000, message: 'the declined tenant never received the deliberate send' },
    )
    .toBe(true);
});
