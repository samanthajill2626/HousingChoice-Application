import { test, expect, type Page } from '@playwright/test';

// Placement board (:5174) against the real status-model backend (F2.1). Proves
// the board loads cases grouped into phase columns, and that moving a card
// transitions the placement to the target phase's first stage AND persists (the
// card lands in the new column after a reload). The seeded placement (case-0001)
// is tenant Tasha Nguyen on unit A, stage `awaiting_inspection` (Inspection phase)
// — moving OUT of awaiting_inspection requires an inspectionOutcome, so the move
// goes through the outcome prompt. Served on :5174 alongside legacy (:5173);
// targeted by absolute URL since the suite baseURL is :5173.
const NEXT = 'http://localhost:5174';

// Log in as the seeded VA, then reset the seeded placement (case-0001) back to
// `awaiting_inspection` via an AUTHENTICATED request (page.request shares the
// session cookie + rides the proxy's x-origin-verify). Targeted, session-safe
// per-test isolation — these specs mutate the case's stage, and unlike
// /__dev/reseed (which wipes the users table and breaks the session after
// frame.spec signs out), this resets only the one placement.
async function devLoginAndReset(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  const res = await page.request.post(`${NEXT}/api/cases/case-0001/transition`, {
    data: { toStage: 'awaiting_inspection', source: 'manual' },
  });
  expect(res.ok()).toBeTruthy();
}

test('Placement board: card renders in its phase column', async ({ page }) => {
  await devLoginAndReset(page);
  await page.goto(`${NEXT}/cases`);

  await expect(page.getByRole('heading', { name: 'Cases' })).toBeVisible();

  // The seeded placement sits in the Inspection column (stage awaiting_inspection).
  const inspection = page.getByRole('listitem', { name: 'Inspection' });
  await expect(inspection).toBeVisible();
  await expect(inspection.getByText('Tasha Nguyen', { exact: true })).toBeVisible();
});

test('Placement board: moving a card transitions + persists the stage', async ({ page }) => {
  await devLoginAndReset(page);
  await page.goto(`${NEXT}/cases`);

  // Move Tasha's card to the Rent Determination phase via the accessible
  // non-drag "Move to…" affordance (keyboard-equivalent to the drag). Because the
  // card leaves awaiting_inspection, the inspection-outcome prompt opens first.
  await page
    .getByRole('combobox', { name: /Move Tasha Nguyen to phase/i })
    .selectOption('Rent Determination');

  await expect(page.getByRole('heading', { name: 'Record inspection outcome' })).toBeVisible();
  await page.getByRole('radio', { name: 'Pass' }).click();
  await page.getByRole('button', { name: 'Confirm move' }).click();

  // The card now sits in the Rent Determination column (its first stage,
  // determine_rent).
  const rentDet = page.getByRole('listitem', { name: 'Rent Determination' });
  await expect(rentDet.getByText('Tasha Nguyen', { exact: true })).toBeVisible();

  // Persisted: a reload still shows the card in Rent Determination.
  await page.reload();
  await expect(
    page.getByRole('listitem', { name: 'Rent Determination' }).getByText('Tasha Nguyen', { exact: true }),
  ).toBeVisible();
});
