import { test, expect, type APIRequestContext } from '@playwright/test';
import { Scenario, freshTenant } from '../../scenarios/steps.js';
import { addOrg } from '../../fixtures/orgFixture.js';
import { APP_NUMBER, registerParty, sendAsParty } from '../../fixtures/fakeTwilio.js';

// Tenant facets on the Contacts list (spec sections 5/6/10 of
// docs/superpowers/specs/2026-08-06-tenant-list-visibility-design.md). Proves the
// promise the feature was built for, end to end against the real backend: pick a
// voucher size AND a housing authority, the list narrows to the tenants matching
// BOTH, the row states the same two facts, and a reload restores the selection
// from the URL.
//
// Self-contained: the lean seed world holds two tenants (Tasha, 2-BR /
// Atlanta Housing Authority, and Dario, 1-BR / Atlanta Housing Authority),
// neither of which can make these facets discriminate - the spec creates its
// own three tenants with run-unique names, under two RUN-UNIQUE housing
// authorities it first adds to the organization list (the tenant form can only
// pick list names - spec D5/D6). No other spec holds those names, so the
// "exactly one row" assertion is stable in a full suite run (other specs'
// phoneless tenants land in the Not-recorded buckets).
//
// Chip accessible names carry a LIVE COUNT ("2-BR (3)"), and the count moves with
// whatever earlier specs left in the lane - so every chip locator here is a REGEX
// anchored on the label, never an exact string.
//
// NOT covered here, by necessity: the PORTING facet. `porting` is written through
// PATCH /api/contacts/:id/tenant-status (a lifecycle write), not through the
// identity fields `teamCreatesTenant` sets, and neither lean tenant is porting
// (Tasha is `porting: false`, Dario carries no flag) - so `showPorting` is false
// and the group never renders in a lean lane. Adding a status seam for it is out
// of scope (worklist adjudication A18); the porting chip is covered by the
// component suite and by live self-QA against the `full` profile.
//
// The second test covers the Status facet (spec 2026-10-12 5.7): its default
// hides inactive and placed tenants, which it creates through the UNGATED
// `PATCH /api/contacts/:id/tenant-status` (the lean world has neither status),
// plus the hidden-match hint, the last-heard sort and the URL round trip. Rows
// are asserted by the run-unique FIRST name only: `freshTenant(...).name` is
// "<label> <stamp>-<seq>", never the rendered first + last name.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

async function heardAt(api: APIRequestContext, contactId: string): Promise<string | undefined> {
  const res = await api.get(`${NEXT}/api/contacts/${contactId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { contact: { last_heard_from_at?: string } }).contact.last_heard_from_at;
}

async function createTenantApi(
  api: APIRequestContext,
  t: { firstName: string; lastName: string; phone: string },
): Promise<string> {
  const res = await api.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName: t.firstName, lastName: t.lastName, phone: t.phone },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
}

/** No gate in setTenantStatus (app/src/services/statusTransition.ts): inactive and placed are reachable. */
async function setTenantStatus(api: APIRequestContext, contactId: string, toStatus: string): Promise<void> {
  const res = await api.patch(`${NEXT}/api/contacts/${contactId}/tenant-status`, {
    data: { toStatus, source: 'manual' },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

// The row separator is U+00B7 with spaces. ONE construction form, in the source
// AND here: String.fromCharCode(0xB7) - never a literal middot, never an HTML
// entity (an entity inside a JS string renders literally as text). Keeps this
// spec's lines ASCII, exactly as selectors.md's em-dash row mandates.
const SEP = ' ' + String.fromCharCode(0xB7) + ' ';

test('tenant facets narrow the list, state the row facts, and survive a reload', async ({
  page,
  request,
}) => {
  test.slow(); // three tenants, each a create dialog PLUS an edit-dialog round trip.
  const flow = new Scenario(page, request);
  const stamp = `${Date.now()}`.slice(-6);
  // Letters, digits and spaces only, so each name is also a literal RegExp source.
  const authority = `Facet Authority ${stamp}`;
  const otherAuthority = `Facet Other Authority ${stamp}`;
  const match = freshTenant('FacetMatch'); // 2-BR / authority - the single survivor
  const otherSize = freshTenant('FacetSize'); // 3-BR / authority - excluded by the voucher facet
  const otherAuth = freshTenant('FacetAuth'); // 2-BR / otherAuthority - excluded by the authority facet

  await flow.login();
  for (const name of [authority, otherAuthority]) {
    await addOrg(page.request, { kind: 'housing_authority', name });
  }
  for (const t of [
    { who: match, voucherSize: 2, housingAuthority: authority },
    { who: otherSize, voucherSize: 3, housingAuthority: authority },
    { who: otherAuth, voucherSize: 2, housingAuthority: otherAuthority },
  ]) {
    await flow.teamCreatesTenant({
      firstName: t.who.firstName,
      lastName: t.who.lastName,
      voucherSize: t.voucherSize,
      housingAuthority: t.housingAuthority,
      consent: false, // no phone and nothing is ever sent: skip the consent section.
    });
  }

  await page.goto(`${NEXT}/contacts/tenants`);
  const rows = page.getByRole('list', { name: 'Tenants' }).getByRole('listitem');
  await expect(rows.filter({ hasText: match.firstName })).toHaveCount(1);
  await expect(rows.filter({ hasText: otherSize.firstName })).toHaveCount(1);
  await expect(rows.filter({ hasText: otherAuth.firstName })).toHaveCount(1);

  // Chips are scoped to their own group: both facets end in a "Not recorded"
  // chip, so an unscoped name would be a strict-mode collision.
  const voucherFacet = page.getByRole('group', { name: 'Voucher size' });
  const authorityFacet = page.getByRole('group', { name: 'Housing authority' });
  const twoBr = voucherFacet.getByRole('button', { name: /^2-BR \(/ });
  const authorityChip = authorityFacet.getByRole('button', { name: new RegExp(`^${authority} \\(`) });

  await twoBr.click();
  await authorityChip.click();

  // AND across facets: only the 2-BR tenant under `authority` survives.
  await expect(rows).toHaveCount(1);
  await expect(rows.filter({ hasText: match.firstName })).toHaveCount(1);

  // The row states the same two facts, exact (never bucketed - "2 BR", not
  // "2-BR"), joined by the middot, with the full value on `title`.
  const facts = `2 BR${SEP}${authority}`;
  const row = rows.first();
  await expect(row.getByText(facts, { exact: true })).toBeVisible();
  await expect(row.getByTitle(facts)).toBeVisible();

  // The URL is the only state carrier (repeated params; the normalized
  // authority key is lowercased with whitespace collapsed, and URLSearchParams
  // writes each space as '+').
  await expect(page).toHaveURL(/[?&]voucher=2(&|$)/);
  const haParam = new URLSearchParams({ ha: authority.toLowerCase() }).toString();
  await expect(page).toHaveURL(new RegExp(`[?&]${haParam.replace(/\+/g, '\\+')}(&|$)`));

  await page.reload();

  await expect(rows).toHaveCount(1);
  await expect(rows.filter({ hasText: match.firstName })).toHaveCount(1);
  await expect(twoBr).toHaveAttribute('aria-pressed', 'true');
  await expect(authorityChip).toHaveAttribute('aria-pressed', 'true');
});

test('the Status facet hides inactive and placed by default; chips, the hint and Clear move it; last heard from sorts; the URL survives a reload', async ({
  page,
  request,
}) => {
  test.slow(); // three API creates, two status writes and an inbound text before the UI starts.
  const flow = new Scenario(page, request);
  const inactive = freshTenant('StatusInactive');
  const placed = freshTenant('StatusPlaced');
  const replied = freshTenant('StatusReplied');

  // Setup: a manual create is `onboarding` (default-visible); move two of them
  // to the statuses the default hides, and give the third a fresh inbound.
  await flow.login();
  const api = page.request;
  const inactiveId = await createTenantApi(api, inactive);
  const placedId = await createTenantApi(api, placed);
  const repliedId = await createTenantApi(api, replied);
  await setTenantStatus(api, inactiveId, 'inactive');
  await setTenantStatus(api, placedId, 'placed');
  await registerParty(request, { label: replied.name, role: 'tenant', number: replied.phone });
  await sendAsParty(request, { from: replied.phone, to: APP_NUMBER, body: `Still looking ${replied.firstName}` });
  await expect
    .poll(async () => (await heardAt(api, repliedId)) !== undefined, {
      timeout: 20_000,
      message: `last_heard_from_at never landed on ${repliedId}`,
    })
    .toBe(true);

  // Default set: everything but inactive and placed, written as NO param.
  await page.goto(`${NEXT}/contacts/tenants`);
  const rows = page.getByRole('list', { name: 'Tenants' }).getByRole('listitem');
  const statusFacet = page.getByRole('group', { name: 'Status', exact: true });
  const inactiveChip = statusFacet.getByRole('button', { name: /^Inactive \(/ });
  // Never /^Plac/ - it also matches Placing.
  const placedChip = statusFacet.getByRole('button', { name: /^Placed \(/ });
  const clearStatus = page.getByRole('button', { name: 'Clear status filter' });
  await expect(rows.filter({ hasText: replied.firstName })).toHaveCount(1);
  await expect(rows.filter({ hasText: inactive.firstName })).toHaveCount(0);
  await expect(rows.filter({ hasText: placed.firstName })).toHaveCount(0);
  await expect(inactiveChip).toHaveAttribute('aria-pressed', 'false');
  await expect(placedChip).toHaveAttribute('aria-pressed', 'false');
  await expect(statusFacet.getByRole('button', { name: /^Searching \(/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(statusFacet.getByRole('button', { name: /^Onboarding \(/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(clearStatus).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]status=/);

  // Last-heard sort (the default): the list loads on mount, so reload until the
  // inbound above is on the server; `workers: 1`, so it is the newest instant in
  // the lane and its tenant leads the list.
  await expect(async () => {
    await page.reload();
    await expect(rows.first()).toContainText(replied.firstName, { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await expect(
    rows.filter({ hasText: replied.firstName }).getByText(/^Last heard from Today \d{1,2}:\d{2} [AP]M$/),
  ).toBeVisible();

  // Hidden-match hint: a search only a hidden status blocks says so (entity
  // quotes - the regex accepts either style), and its action lights all seven.
  const search = page.getByRole('searchbox', { name: 'Search contacts' });
  await search.fill(inactive.firstName);
  await expect(page.getByText(/No matches for .+ among the statuses shown/)).toBeVisible();
  await page.getByRole('button', { name: 'Show all statuses' }).click();
  await expect(rows.filter({ hasText: inactive.firstName })).toHaveCount(1);
  for (const label of ['Needs review', 'Onboarding', 'Searching', 'Placing', 'Placed', 'On hold', 'Inactive']) {
    await expect(statusFacet.getByRole('button', { name: new RegExp(`^${label} \\(`) })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  }
  await expect(page).toHaveURL(/[?&]status=inactive(&|$)/);
  await expect(page).toHaveURL(/[?&]status=placed(&|$)/);
  await search.fill('');

  // Clear returns to the DEFAULT, not to empty.
  await clearStatus.click();
  await expect(page).not.toHaveURL(/[?&]status=/);
  await expect(rows.filter({ hasText: inactive.firstName })).toHaveCount(0);
  await expect(rows.filter({ hasText: placed.firstName })).toHaveCount(0);

  // One chip on top of the default.
  await inactiveChip.click();
  await expect(rows.filter({ hasText: inactive.firstName })).toHaveCount(1);
  await expect(rows.filter({ hasText: placed.firstName })).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]status=inactive(&|$)/);
  await expect(page).not.toHaveURL(/[?&]status=placed(&|$)/);

  // Sort by name + reload: the URL is the only state carrier for both.
  await page.getByLabel('Sort by').selectOption('name');
  await expect(page).toHaveURL(/[?&]sort=name(&|$)/);
  await expect(page).toHaveURL(/[?&]status=inactive(&|$)/);
  await page.reload();
  await expect(page.getByLabel('Sort by')).toHaveValue('name');
  await expect(inactiveChip).toHaveAttribute('aria-pressed', 'true');
  await expect(placedChip).toHaveAttribute('aria-pressed', 'false');
  await expect(rows.filter({ hasText: inactive.firstName })).toHaveCount(1);
  await expect(rows.filter({ hasText: placed.firstName })).toHaveCount(0);
});
