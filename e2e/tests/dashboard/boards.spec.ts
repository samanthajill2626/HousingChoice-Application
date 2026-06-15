import { test, expect } from '../../fixtures/auth.js';
import { getOutbox } from '../../fixtures/outbox.js';

// M1.10 boards/cases proving slice (staff UI + API + relay-on-placement + outbox):
// a navigator opens a case from the board for the seeded tenant + listing, then
// "Set up relay thread" → the masked relay group is provisioned and the intro
// text fans out to BOTH parties (tenant + the listing's landlord) from the pool
// number — proven in the dev outbox. Parallel-safe: it creates a NEW case with a
// unique placement tag against the stable seeded tenant/landlord (never reseeds),
// and isolates the outbox assertion with `since`. Mutations go through the
// browser (the SPA's fetch carries the Origin the CSRF check wants).

// Seeded by db:seed (src/lib/seedData.ts) — both carry a phone, so the relay
// roster (tenant + the unit's landlord) is reachable and the intro can send.
const TENANT_ID = 'contact-tenant-0001';
const UNIT_ID = 'unit-0001';
const TENANT_PHONE = '+15550100001';
const LANDLORD_PHONE = '+15550100002';

test('boards: open a case, set up its relay thread → both parties get the intro text', async ({
  vaPage,
  request,
}) => {
  const stamp = `${Date.now()}`.slice(-7);
  const tag = `E2E relay ${stamp}`;

  // 1) The board renders with the stage-ladder columns.
  await vaPage.goto('/boards');
  await expect(vaPage.getByRole('heading', { name: 'Boards' })).toBeVisible();
  await expect(vaPage.getByLabel('Interested')).toBeVisible();
  await expect(vaPage.getByLabel('Touring')).toBeVisible();

  // 2) Open a NEW case for the seeded tenant + listing (the unique tag is the
  //    card title, so the rest of the test is independent of other cases).
  await vaPage.getByRole('link', { name: 'New case' }).click();
  await expect(vaPage.getByRole('heading', { name: 'New case' })).toBeVisible();
  await vaPage.getByLabel('Tenant').selectOption(TENANT_ID);
  await vaPage.getByLabel('Listing').selectOption(UNIT_ID);
  await vaPage.getByLabel('Placement tag').fill(tag);
  const before = new Date().toISOString();
  await vaPage.getByRole('button', { name: 'Open case' }).click();

  // 3) Lands on the case detail, titled by the placement tag.
  await expect(vaPage).toHaveURL(/\/boards\/case-/);
  await expect(vaPage.getByRole('heading', { name: tag })).toBeVisible();

  // 4) Set up the masked relay thread (the explicit per-case action).
  await vaPage.getByRole('button', { name: 'Set up relay thread' }).click();
  await expect(vaPage.getByRole('link', { name: 'Open relay thread' })).toBeVisible();

  // 5) PROOF OF SEND: the relay intro fanned out to BOTH parties from the pool
  //    number — the outbox row only exists if the messaging adapter actually ran.
  await expect
    .poll(async () => (await getOutbox(request, { to: TENANT_PHONE, since: before })).length, {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await getOutbox(request, { to: LANDLORD_PHONE, since: before })).length, {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);
});

test('boards: advancing a case stage moves its card to the new column', async ({ vaPage }) => {
  const stamp = `${Date.now()}`.slice(-7);
  const tag = `E2E stage ${stamp}`;

  // Open a fresh case (starts in Interested).
  await vaPage.goto('/boards/new');
  await vaPage.getByLabel('Tenant').selectOption(TENANT_ID);
  await vaPage.getByLabel('Listing').selectOption(UNIT_ID);
  await vaPage.getByLabel('Placement tag').fill(tag);
  await vaPage.getByRole('button', { name: 'Open case' }).click();
  await expect(vaPage.getByRole('heading', { name: tag })).toBeVisible();

  // Advance the stage to Applied and save. (exact: true — the case-detail
  // region's accessible name also contains "stage" via the placement tag.)
  await vaPage.getByLabel('Stage', { exact: true }).selectOption('applied');
  await vaPage.getByRole('button', { name: 'Save stage' }).click();

  // Back on the board, the card now lives under the Applied column.
  await vaPage.goto('/boards');
  const applied = vaPage.getByLabel('Applied', { exact: true });
  await expect(applied.getByText(tag)).toBeVisible();
  await expect(vaPage.getByLabel('Interested', { exact: true }).getByText(tag)).toHaveCount(0);
});
