import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { reseed } from '../../fixtures/reseed.js';
import { extractionTick, sendExtractSms } from '../../fixtures/extraction.js';

// Conversation-fact-extraction, end-to-end against the hermetic stack with the
// DETERMINISTIC FAKE driver (EXTRACTION_DRIVER=fake, set in e2e-session childEnv).
// The full pipeline runs for real - inbound webhook -> sliding-debounce schedule ->
// worker job (driven synchronously by POST /__dev/extraction/tick) -> guarded apply
// -> review API -> dashboard chips/badges/Today group. The ONLY substitution is the
// LLM: an inbound SMS body `EXTRACT:` + JSON is parsed by the fake driver into the
// exact ExtractionResult, so each scenario steers the model output precisely.
//
// Each test builds a FRESH contact (unique phone) so the lean seed stays byte-stable
// (we never mutate a seeded contact). Accessible names are the T9 contract:
//   - AutoBadge  -> role img, name "Auto"
//   - chip       -> role group, name `AI suggestion for <label>`; text `AI heard "<value>"`; buttons Accept/Dismiss
//   - triage line-> text `AI suggests: Tenant`
//   - Today group-> role list, name `AI suggestions to review`

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

let seq = 0;
/** Per-run-unique, well-formed NANP number (+1555 + 5 stamp digits + 2 seq digits). */
function uniquePhone(): string {
  seq += 1;
  const stamp = `${Date.now()}`.slice(-5);
  return `+1555${stamp}${String(seq).padStart(2, '0')}`;
}

/** Create a fresh TENANT via the authenticated API (never touches seeded rows).
 *  Returns the new contactId + its phone. Tenant creates default to `onboarding`. */
async function createTenant(
  request: APIRequestContext,
  opts: { firstName: string; voucherSize?: number; status?: string } = { firstName: 'Extract' },
): Promise<{ contactId: string; phone: string }> {
  const phone = uniquePhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: {
      type: 'tenant',
      firstName: opts.firstName,
      lastName: 'Extract',
      phone,
      ...(opts.voucherSize !== undefined && { voucherSize: opts.voucherSize }),
      ...(opts.status !== undefined && { status: opts.status }),
    },
  });
  expect(res.ok(), `create tenant ${opts.firstName}`).toBeTruthy();
  const contactId = (await res.json()).contact.contactId as string;
  return { contactId, phone };
}

/** Resolve the auto-captured (unknown) contact created by an inbound, by phone. */
async function findUnknownContactId(request: APIRequestContext, phone: string): Promise<string> {
  let contactId: string | undefined;
  await expect
    .poll(
      async () => {
        const res = await request.get(`${NEXT}/api/contacts?type=unknown`);
        if (!res.ok()) return false;
        contactId = ((await res.json()).contacts as Array<{ contactId: string; phone?: string }>).find(
          (c) => c.phone === phone,
        )?.contactId;
        return contactId !== undefined;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return contactId!;
}

// A clean slate once for the file (standard fixture); each test still uses fresh
// per-run contacts so this is belt-and-braces (and keeps the extraction table empty
// for the debounce-slide count).
test.beforeAll(async ({ request }) => {
  await reseed(request);
});

test('empty-field write: an extracted fact writes an empty field with an Auto badge', async ({
  page,
  request,
}) => {
  await devLogin(page);
  const { contactId, phone } = await createTenant(page.request, { firstName: 'PetsWrite' });

  await sendExtractSms(request, phone, {
    fields: { pets: { op: 'write', value: 'yes', reason: 'said has a dog' } },
  });
  const tick = await extractionTick(request);
  expect(tick.processed).toBeGreaterThanOrEqual(1);

  await page.goto(`${NEXT}/contacts/${contactId}`);
  const intake = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Eligibility intake' }) });
  await expect(intake).toBeVisible();
  await expect(intake.getByText('yes')).toBeVisible();
  await expect(intake.getByRole('img', { name: 'Auto' })).toBeVisible();
});

test('conflict -> chip -> Accept: a suggestion applies in place with an Auto badge', async ({
  page,
  request,
}) => {
  await devLogin(page);
  const { contactId, phone } = await createTenant(page.request, {
    firstName: 'VoucherAccept',
    voucherSize: 2,
  });

  await sendExtractSms(request, phone, {
    fields: { voucherSize: { op: 'suggest', value: '3', reason: 'mentioned a 3 bedroom' } },
  });
  const tick = await extractionTick(request);
  expect(tick.processed).toBeGreaterThanOrEqual(1);

  await page.goto(`${NEXT}/contacts/${contactId}`);
  const details = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Details' }) });
  const chip = page.getByRole('group', { name: 'AI suggestion for voucher size' });
  await expect(chip).toBeVisible();
  await expect(chip.getByText('AI heard "3"')).toBeVisible();
  // Before accept the stored value is still 2 BR.
  await expect(details.getByText('2 BR')).toBeVisible();

  await chip.getByRole('button', { name: 'Accept' }).click();

  // Accept applies the returned contact in place: value updates, badge appears, chip drops.
  await expect(details.getByText('3 BR')).toBeVisible();
  await expect(details.getByRole('img', { name: 'Auto' })).toBeVisible();
  await expect(chip).toHaveCount(0);
});

test('conflict -> chip -> Dismiss: the value is unchanged and the chip is gone', async ({
  page,
  request,
}) => {
  await devLogin(page);
  const { contactId, phone } = await createTenant(page.request, {
    firstName: 'VoucherDismiss',
    voucherSize: 2,
  });

  await sendExtractSms(request, phone, {
    fields: { voucherSize: { op: 'suggest', value: '3', reason: 'mentioned a 3 bedroom' } },
  });
  const tick = await extractionTick(request);
  expect(tick.processed).toBeGreaterThanOrEqual(1);

  await page.goto(`${NEXT}/contacts/${contactId}`);
  const details = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Details' }) });
  const chip = page.getByRole('group', { name: 'AI suggestion for voucher size' });
  await expect(chip).toBeVisible();

  await chip.getByRole('button', { name: 'Dismiss' }).click();

  await expect(chip).toHaveCount(0);
  // Value unchanged, no AI provenance badge.
  await expect(details.getByText('2 BR')).toBeVisible();
  await expect(details.getByRole('img', { name: 'Auto' })).toHaveCount(0);
});

test('status advance: an onboarding tenant gets a status chip that advances to Searching', async ({
  page,
  request,
}) => {
  await devLogin(page);
  const { contactId, phone } = await createTenant(page.request, {
    firstName: 'StatusAdvance',
    status: 'onboarding',
  });

  await sendExtractSms(request, phone, {
    statusAdvance: { suggest: true, reason: 'voucher in hand' },
  });
  const tick = await extractionTick(request);
  expect(tick.processed).toBeGreaterThanOrEqual(1);

  await page.goto(`${NEXT}/contacts/${contactId}`);
  const statusChip = page.getByRole('group', { name: 'AI suggestion for status' });
  await expect(statusChip).toBeVisible();
  await expect(statusChip.getByText('AI heard "searching"')).toBeVisible();
  // The header pill starts on Onboarding.
  await expect(page.getByRole('button', { name: 'Contact status: Onboarding' })).toBeVisible();

  await statusChip.getByRole('button', { name: 'Accept' }).click();

  await expect(page.getByRole('button', { name: 'Contact status: Searching' })).toBeVisible();
  await expect(statusChip).toHaveCount(0);
});

test('type recommendation: an unknown contact gets an AI-suggests line and triages to Tenant', async ({
  page,
  request,
}) => {
  await devLogin(page);
  const phone = uniquePhone();

  await sendExtractSms(request, phone, {
    typeSuggestion: { value: 'tenant', reason: 'looking for a home' },
  });
  const tick = await extractionTick(request);
  expect(tick.processed).toBeGreaterThanOrEqual(1);

  const contactId = await findUnknownContactId(page.request, phone);
  await page.goto(`${NEXT}/contacts/${contactId}`);
  const triage = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Needs triage' }) });
  await expect(triage.getByText(/AI suggests: Tenant/)).toBeVisible();

  await triage.getByRole('button', { name: 'Mark as Tenant' }).click();

  // Triage flips the type -> the Needs-triage card (and its Mark-as button) resolves.
  await expect(page.getByRole('button', { name: 'Mark as Tenant' })).toHaveCount(0, {
    timeout: 10_000,
  });
});

test('Today tile: a pending suggestion surfaces the AI-suggestions-to-review group', async ({
  page,
  request,
}) => {
  await devLogin(page);
  const { phone } = await createTenant(page.request, { firstName: 'TodayTile', voucherSize: 2 });

  await sendExtractSms(request, phone, {
    fields: { voucherSize: { op: 'suggest', value: '3', reason: 'mentioned a 3 bedroom' } },
  });
  const tick = await extractionTick(request);
  expect(tick.processed).toBeGreaterThanOrEqual(1);

  // The Today action queue is the dashboard home route ("/"). Re-navigate so
  // useToday refetches now that a pending suggestion exists.
  await page.goto(`${NEXT}/`);
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  const group = page.getByRole('list', { name: 'AI suggestions to review' });
  await expect(group).toBeVisible({ timeout: 10_000 });
  expect(await group.getByRole('listitem').count()).toBeGreaterThanOrEqual(1);
});

test('debounce slide: two quick inbound EXTRACT texts run exactly one extraction', async ({
  request,
}) => {
  // Reseed right before so the extraction table is empty and the processed count is
  // exact. Two inbounds from ONE fresh (unknown) number resolve to ONE conversation
  // whose sliding due item is upserted twice -> a single claim -> ONE run.
  await reseed(request);
  const phone = uniquePhone();

  await sendExtractSms(request, phone, { fields: {} });
  await sendExtractSms(request, phone, { fields: {} });

  const tick = await extractionTick(request);
  expect(tick.processed).toBe(1);
});
