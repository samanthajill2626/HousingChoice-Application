import { test, expect, type Page, type Locator } from '@playwright/test';

// Placements page (:5174) against the real status-model backend. The kanban
// board is gone: the page is a phase FILTER (rail on desktop / chips on mobile)
// + one ledger list. Rows link to the placement detail; the desktop kebab menu
// moves a placement by exact stage (gated prompts still apply). The seeded
// placement (placement-0001) is tenant Tasha Nguyen on unit A; each test resets
// it to `awaiting_inspection` (Inspection phase).
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

async function devLoginAndReset(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  const res = await page.request.post(`${NEXT}/api/placements/placement-0001/transition`, {
    data: { toStage: 'awaiting_inspection', source: 'manual' },
  });
  expect(res.ok()).toBeTruthy();
}

/** The rebuilt PlacementDetail (hub) header band, scoped by its back crumb. The
 *  stage pill + the "Advance to <next>" CTA live here; the Now card repeats the
 *  stage label + an Advance button, so header assertions scope to THIS band to
 *  disambiguate. */
function placementBanner(page: Page): Locator {
  return page
    .locator('header')
    .filter({ has: page.getByRole('link', { name: 'Back to placements' }) });
}

// The hub tests below drive placement-0001 through gate + nudge stages; restore it
// to the seeded Inspection-phase stage after each test so downstream specs (and
// re-runs) see the seeded active placement. A manual transition out of any active
// stage is allowed; the per-test dev-login's session cookie authorizes it.
test.afterEach(async ({ page }) => {
  await page.request.post(`${NEXT}/api/placements/placement-0001/transition`, {
    data: { toStage: 'awaiting_inspection', source: 'manual' },
  });
});

test('all-view groups by phase; the row appears under its phase heading', async ({ page }) => {
  await devLoginAndReset(page);
  await page.goto(`${NEXT}/placements`);

  await expect(page.getByRole('heading', { name: 'Placements' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Inspection/ })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Tasha Nguyen - Awaiting inspection' }),
  ).toBeVisible();
});

test('phase filter narrows the list and lands in the URL', async ({ page }) => {
  await devLoginAndReset(page);
  await page.goto(`${NEXT}/placements`);

  const nav = page.getByRole('navigation', { name: 'Placement phases' });
  await nav.getByRole('link', { name: /^Inspection/ }).click();
  await expect(page).toHaveURL(/\?phase=inspection$/);
  await expect(page.getByRole('link', { name: 'Tasha Nguyen - Awaiting inspection' })).toBeVisible();
  // A slice is flat: no group heading.
  await expect(page.getByRole('heading', { name: /^Inspection \d/ })).toHaveCount(0);
  // The selected entry is marked.
  await expect(nav.getByRole('link', { name: /^Inspection/ })).toHaveAttribute('aria-current', 'true');
});

test('search narrows rows by tenant name', async ({ page }) => {
  await devLoginAndReset(page);
  await page.goto(`${NEXT}/placements`);

  await page.getByRole('searchbox', { name: 'Search placements' }).fill('tasha');
  await expect(page.getByRole('link', { name: 'Tasha Nguyen - Awaiting inspection' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search placements' }).fill('zzz-no-such');
  await expect(page.getByText("No matches for 'zzz-no-such'.")).toBeVisible();
});

test('kebab menu moves by exact stage through the gate prompt and persists', async ({ page }) => {
  await devLoginAndReset(page);
  await page.goto(`${NEXT}/placements`);

  // Moving OUT of awaiting_inspection requires the inspection outcome. Scope the
  // kebab to placement-0001's own row (its detail link is unique to the seeded
  // Inspection-stage placement) so manual placements other specs may have created
  // for the same tenant don't make the button name ambiguous.
  const row = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: 'Tasha Nguyen - Awaiting inspection' }) });
  await row.getByRole('button', { name: 'Actions for Tasha Nguyen' }).click();
  await page.getByRole('menuitem', { name: 'Determine rent' }).click();
  await expect(page.getByRole('heading', { name: 'Record inspection outcome' })).toBeVisible();
  await page.getByRole('radio', { name: 'Pass' }).click();
  await page.getByRole('button', { name: 'Confirm move' }).click();

  await expect(page.getByRole('link', { name: 'Tasha Nguyen - Determine rent' })).toBeVisible();

  // Persisted across a reload.
  await page.reload();
  await expect(page.getByRole('link', { name: 'Tasha Nguyen - Determine rent' })).toBeVisible();
});

test('mobile: chip filter works, no kebab, row navigates to the detail', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await devLoginAndReset(page);
  await page.goto(`${NEXT}/placements`);

  // The filter renders as chips (same accessible nav) and still filters.
  const nav = page.getByRole('navigation', { name: 'Placement phases' });
  await expect(nav).toBeVisible();
  await nav.getByRole('link', { name: /^Inspection/ }).click();
  await expect(page).toHaveURL(/\?phase=inspection$/);

  // No row actions on mobile (the kebab is display:none below 768px).
  await expect(page.getByRole('button', { name: 'Actions for Tasha Nguyen' })).not.toBeVisible();

  // The whole row opens the placement detail.
  await page.getByRole('link', { name: 'Tasha Nguyen - Awaiting inspection' }).click();
  await expect(page).toHaveURL(/\/placements\/placement-0001$/);
});

// ==== Placement detail HUB (two-pane info + comms) ==========================
// The rebuilt /placements/:id is a two-pane hub mirroring the tour page: a comms
// channel switcher (Group / Tenant 1:1 / Landlord 1:1) LEFT, the placement file
// (Now card, Deadlines and nudges, People, facts, History) RIGHT, with an
// "Advance to <next>" header CTA that drives the SAME gated pipeline.

test('hub: opens the group text from the empty state (button disappears, thread mounts)', async ({
  page,
}) => {
  await devLoginAndReset(page);

  // A FRESH placement starts with NO group thread, so the Group tab shows the
  // empty state (the seeded placement-0001 already has a group). Tasha + the free
  // unit-0002 (unit-0002 has no active placement; the tenant-overlap notice is
  // warn-but-allow, so the API create still succeeds).
  const created = await page.request.post(`${NEXT}/api/placements`, {
    data: { tenantId: 'contact-tenant-0001', unitId: 'unit-0002', stage: 'send_application' },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const placementId = ((await created.json()) as { placement: { placementId: string } }).placement
    .placementId;

  await page.goto(`${NEXT}/placements/${placementId}`);

  // The comms pane's Group tab shows the empty state until a group is provisioned.
  await page.getByRole('tab', { name: 'Group text' }).click();
  await expect(page.getByText('No group text yet')).toBeVisible();

  // Open the group text -> the empty-state button provisions the masked relay and
  // mounts the fresh thread; the button (and empty state) disappear.
  const openBtn = page.getByRole('button', { name: 'Open group text' });
  await openBtn.click();
  await expect(openBtn).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText('No group text yet')).toHaveCount(0);
  // The group transcript mounted: its composer (a "Reply message" box) is present.
  await expect(page.getByRole('textbox', { name: 'Reply message' })).toBeVisible({ timeout: 15_000 });
});

test('hub: the header CTA advances a stage through the inspection-outcome gate', async ({ page }) => {
  await devLoginAndReset(page); // placement-0001 at awaiting_inspection
  await page.goto(`${NEXT}/placements/placement-0001`);

  const banner = placementBanner(page);
  await expect(banner.getByText('Awaiting inspection', { exact: true })).toBeVisible();

  // Advance to the next ladder rung via the header CTA. The move OUT of
  // awaiting_inspection is GATED: the inspection-outcome modal fires first.
  await banner.getByRole('button', { name: 'Advance to Determine rent' }).click();
  const gate = page.getByRole('dialog', { name: 'Record inspection outcome' });
  await expect(gate).toBeVisible();
  await gate.getByRole('radio', { name: 'Pass' }).click();
  await gate.getByRole('button', { name: 'Confirm move' }).click();
  await expect(gate).toHaveCount(0, { timeout: 10_000 });

  // The stage advanced: the header pill now reads the destination stage.
  await expect(banner.getByText('Determine rent', { exact: true })).toBeVisible({ timeout: 10_000 });
});

test('hub: an armed nudge shows in the Deadlines card + the tenant Upcoming bucket, then cancels/restores', async ({
  page,
}) => {
  await devLoginAndReset(page);

  // Drive placement-0001 into Awaiting receipt - entering it arms the [AUTO]
  // receipt-check nudge, routed 1:1 to the TENANT (Tasha), ~24h out.
  const res = await page.request.post(`${NEXT}/api/placements/placement-0001/transition`, {
    data: { toStage: 'awaiting_receipt', source: 'manual' },
  });
  expect(res.ok(), await res.text()).toBeTruthy();

  await page.goto(`${NEXT}/placements/placement-0001`);

  // The Deadlines and nudges card shows the armed Receipt check rung to Tasha.
  const card = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Deadlines and nudges' }) });
  await expect(card.getByText('Receipt check')).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText('to Tasha Nguyen')).toBeVisible();

  // The SAME nudge surfaces on the tenant's 1:1 Upcoming bucket (contact timeline).
  await page.goto(`${NEXT}/contacts/contact-tenant-0001`);
  const upcoming = page.getByRole('region', { name: 'Upcoming scheduled messages' });
  await expect(upcoming).toBeVisible({ timeout: 10_000 });
  // The card roots are grandchild divs of the region (region -> list -> card), so a
  // body filter can't select an ancestor container (mirrors the Scenario helper).
  const upcomingNudge = upcoming.locator('> div > div').filter({ hasText: 'application come through' });
  await expect(upcomingNudge).toHaveCount(1, { timeout: 10_000 });
  await expect(upcomingNudge.getByText('Nudge', { exact: true })).toBeVisible();

  // Cancel the nudge from the Deadlines card -> it flips to Canceled + a Restore
  // affordance...
  await page.goto(`${NEXT}/placements/placement-0001`);
  const cancelBtn = card.getByRole('button', { name: 'Cancel Receipt check nudge' });
  await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
  await cancelBtn.click();
  await expect(card.getByRole('button', { name: 'Restore Receipt check nudge' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(card.getByText('Canceled')).toBeVisible();

  // ...and Restore flips it back to an armed, cancelable rung.
  await card.getByRole('button', { name: 'Restore Receipt check nudge' }).click();
  await expect(card.getByRole('button', { name: 'Cancel Receipt check nudge' })).toBeVisible({
    timeout: 10_000,
  });
});
