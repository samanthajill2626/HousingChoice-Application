import { test, expect, type Page } from '@playwright/test';

// Placement history (:5174) against the real backend (F2.3). Proves the placement
// detail page renders the placement facts + the provenance history, and that a
// transition made on the detail page adds a fresh history row (newest-first).
// The seeded placement (placement-0001) is Tasha Nguyen on unit A, stage
// awaiting_inspection. Served on :5174 (the suite baseURL); targeted by
// absolute URL for explicitness.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const TENANT = 'contact-tenant-0001'; // Tasha Nguyen — the tenant on placement-0001

// Log in as the seeded VA, then reset the seeded placement (placement-0001) back to
// `awaiting_inspection` via an AUTHENTICATED request (session-safe, targeted) so
// the seeded card is in the Inspection column for the "Open" link below —
// /__dev/reseed would wipe users/sessions and break auth after frame.spec.
async function devLoginAndReset(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  const res = await page.request.post(`${NEXT}/api/placements/placement-0001/transition`, {
    data: { toStage: 'awaiting_inspection', source: 'manual' },
  });
  expect(res.ok()).toBeTruthy();
}

test('Placement detail: shows placement facts + history, and a transition adds a row', async ({ page }) => {
  await devLoginAndReset(page);

  // Open the seeded placement from its ledger row.
  await page.goto(`${NEXT}/placements`);
  await page.getByRole('link', { name: 'Tasha Nguyen - Awaiting inspection' }).click();

  // Detail header: the stage label + the History panel.
  await expect(page.getByRole('heading', { name: /Awaiting inspection/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /History/ })).toBeVisible();

  // Move out of awaiting_inspection via the stage pill (menu items carry the
  // stage LABELS) → the outcome prompt → confirm. This records a transition the
  // history then reflects.
  await page.getByRole('button', { name: /^Placement stage:/ }).click();
  await page.getByRole('menuitemradio', { name: 'Determine rent', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Record inspection outcome' })).toBeVisible();
  // Scope to the move dialog — the in-place inspection recorder card (shown at
  // awaiting_inspection) also has a Pass/Fail radio.
  const outcomeDialog = page.getByRole('dialog');
  await outcomeDialog.getByRole('radio', { name: 'Pass' }).click();
  await outcomeDialog.getByRole('button', { name: 'Confirm move' }).click();

  // The stage advanced and the history list shows at least one row (newest-first).
  await expect(page.getByRole('heading', { name: /Determine rent/ })).toBeVisible();
  const history = page.getByRole('list', { name: 'Placement history' });
  await expect(history.getByRole('listitem').first()).toBeVisible();

  // Activity coverage: the SAME transition also lands as a person-centric
  // `stage_changed` milestone on the TENANT's timeline (placement-0001 is Tasha =
  // contact-tenant-0001), deep-linking back to the placement. `.first()` tolerates
  // the pins that accumulate across re-runs (each run + its reset transition).
  await page.goto(`${NEXT}/contacts/${TENANT}`);
  const timeline = page.getByRole('region', { name: 'Communications and activity' });
  const stagePin = timeline.getByRole('link', { name: /Stage → Determine rent/ }).first();
  await expect(stagePin).toBeVisible({ timeout: 10_000 });
  await expect(stagePin).toHaveAttribute('href', '/placements/placement-0001');
});
