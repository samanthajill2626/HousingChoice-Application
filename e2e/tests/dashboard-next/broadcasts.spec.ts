import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { listThreads } from '../../fixtures/fakeTwilio.js';

// Broadcasts surface (:5174), Phase B — the rebuilt "Share a property with a
// curated set of tenants" flow, end-to-end against the real backend (draft →
// preview → send-by-explicit-selection → live results) plus draft delete.
//
// Per design §8:
//   - from a seeded PROPERTY detail → "📣 Broadcast to tenants" → composer with
//     the audience PRE-FILLED (voucher size from the unit beds) → write a message
//     → Preview → uncheck one candidate + add one tenant + see an already-sent
//     flag → Send → land on Results with the right recipient count + a recipient
//     row linking to a contact;
//   - delete an unsent draft from the list (create a draft, see it, delete it,
//     confirm it's gone).
//
// Seeded data (app/src/lib/seedData.ts):
//   - unit-0001 = 1450 Joseph E. Boone Blvd NW (beds 2, atlanta_housing)
//   - contact-tenant-0001 = Tasha Nguyen (voucherSize 2) → matches unit-0001's
//     2-BR audience. We seed a PRIOR sent broadcast for unit-0001 that includes
//     Tasha so the next preview flags her "already sent" (the byUnit GSI resolves
//     this on the local DynamoDB).
// To get a multi-candidate, order-independent audience we create our OWN tenants
// (voucherSize 2, unique per-run phones) via the API. Sends are asserted via the
// fake-twilio thread store — never real SMS. Served on :5174 (the suite baseURL).
const NEXT = 'http://localhost:5174';
const SEEDED_UNIT = 'unit-0001'; // 1450 Joseph E. Boone Blvd NW, beds 2
const TASHA = 'contact-tenant-0001';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/** Create a tenant via the API (camelCase voucherSize so the resolver matches).
 *  `voucherSize` defaults to 2 (the unit-0001 audience); pass 3 for a tenant the
 *  2-BR filter will NOT catch (so it must be added manually via search).
 *  Returns the new contactId + the display name we can search/assert on. */
async function createTenant(
  request: APIRequestContext,
  firstName: string,
  voucherSize = 2,
): Promise<{ contactId: string; firstName: string; name: string; phone: string }> {
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName, lastName: 'Bcastest', phone, voucherSize },
  });
  expect(res.ok()).toBeTruthy();
  const contactId = (await res.json()).contact.contactId as string;
  // A2P/CTIA (spec §4): a no-consent tenant is fenced out of broadcasts (its preview
  // row is disabled). These test tenants are meant to be SENDABLE, so record consent.
  const consentRes = await request.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
  });
  expect(consentRes.ok()).toBeTruthy();
  // Preview rows from the resolver show the FIRST name only (no lastName); the
  // add-a-tenant search row shows the full "First Last".
  return { contactId, firstName, name: `${firstName} Bcastest`, phone };
}

test.describe('Broadcasts — compose from a property → curate → send → results', () => {
  test('pre-filled audience, uncheck one + add one + an already-sent flag, Send → Results', async ({
    page,
    request,
  }) => {
    // dev-login FIRST so page.request carries the session cookie for the
    // authenticated /api setup calls below (the bare `request` fixture has none).
    await devLogin(page);

    // A2P/CTIA (spec §4): seeded Tasha (contact-tenant-0001) carries no consent, so
    // she'd be fenced out of the preview (badged no-consent, not "Already sent").
    // Record consent so she remains a normal already-sent candidate row.
    const tashaConsent = await page.request.patch(`${NEXT}/api/contacts/${TASHA}`, {
      data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
    });
    expect(tashaConsent.ok()).toBeTruthy();

    // --- Set up the audience: two fresh 2-BR tenants we control (unique names). ---
    const stamp = `${Date.now()}`.slice(-6);
    const keep = await createTenant(page.request, `Keepme${stamp}`);
    const drop = await createTenant(page.request, `Dropme${stamp}`);
    // A 3-BR tenant: NOT caught by the 2-BR filter → must be added via search.
    const added = await createTenant(page.request, `Addme${stamp}`, 3);

    // --- Seed a PRIOR sent broadcast for unit-0001 that includes Tasha, so the
    // next preview flags her "already sent". Built straight through the API. ---
    const draftRes = await page.request.post(`${NEXT}/api/broadcasts`, {
      data: {
        unitId: SEEDED_UNIT,
        body_template: `Prior send ${stamp} for [TenantName]`,
        audience_filter: { contact_type: 'tenant', bedroomSize: 2 },
      },
    });
    expect(draftRes.ok()).toBeTruthy();
    const priorId = (await draftRes.json()).broadcastId as string;
    const sentRes = await page.request.post(`${NEXT}/api/broadcasts/${priorId}/send`, {
      data: { recipientContactIds: [TASHA] },
    });
    expect(sentRes.ok()).toBeTruthy();

    // --- Compose from the property: the "📣 Broadcast to tenants" button. ---
    await page.goto(`${NEXT}/listings/${SEEDED_UNIT}`);
    await page.getByRole('button', { name: /Broadcast to tenants/i }).click();
    await expect(page).toHaveURL(new RegExp(`/broadcasts/new\\?unitId=${SEEDED_UNIT}`));
    await expect(page.getByRole('heading', { name: 'New broadcast' })).toBeVisible();

    // The voucher size is PRE-FILLED from the unit's 2 beds (the 2-BR chip is
    // pressed + tagged "matches property").
    const twoBr = page.getByRole('button', { name: /2-BR/ });
    await expect(twoBr).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText(/matches property/i)).toBeVisible();

    // Write a message (unique so its outbound copy is assertable in the fake).
    const body = `Open house ${stamp} — a 2BR home is available.`;
    await page.getByLabel('Message').fill(body);

    // The live reach resolves (a non-empty audience) and Preview enables.
    const previewBtn = page.getByRole('button', { name: 'Preview recipients' });
    await expect(previewBtn).toBeEnabled({ timeout: 15_000 });
    await previewBtn.click();

    // --- The curated recipient list. ---
    await expect(page.getByRole('heading', { name: 'Review recipients' })).toBeVisible();
    const list = page.getByRole('list', { name: 'Candidate recipients' });
    await expect(list).toBeVisible();

    // Our two 2-BR tenants are filter-matched candidates (preview rows show the
    // FIRST name only). Tasha is too (already-sent).
    await expect(list.getByText(keep.firstName)).toBeVisible();
    await expect(list.getByText(drop.firstName)).toBeVisible();

    // Tasha is flagged "already sent" and starts UNCHECKED (soft opt-in to resend).
    const tashaRow = list.locator('li', { hasText: 'Tasha' });
    await expect(tashaRow.getByText('Already sent')).toBeVisible();
    await expect(tashaRow.getByRole('checkbox')).not.toBeChecked();

    // Uncheck one candidate (drop) so it is excluded from the send.
    const dropRow = list.locator('li', { hasText: drop.firstName });
    await dropRow.getByRole('checkbox').uncheck();
    await expect(dropRow.getByRole('checkbox')).not.toBeChecked();

    // Add a tenant the 2-BR filter did NOT catch (our 3-BR tenant), via the
    // search → it appends as an "Added" row, checked.
    await page.getByRole('combobox', { name: 'Add a tenant' }).fill(`Addme${stamp}`);
    await page.getByRole('option', { name: new RegExp(added.name) }).click();
    const addedRow = list.locator('li', { hasText: added.name });
    await expect(addedRow.getByText('Added')).toBeVisible();
    await expect(addedRow.getByRole('checkbox')).toBeChecked();

    // Send to the curated selection.
    await page.getByRole('button', { name: /^Send to/ }).click();

    // --- Lands on Results for this broadcast (the send POST resolves, then the
    // composer navigates). Allow headroom for the send round-trip. ---
    await expect(page).toHaveURL(/\/broadcasts\/[A-Za-z0-9_-]+$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: /Tenants/ })).toBeVisible();
    await expect(page.getByLabel('Delivery stats')).toBeVisible();

    // A recipient row links to a tenant's contact page (the comms disposition path).
    const recipients = page.getByRole('list', { name: 'Recipients' });
    await expect(recipients).toBeVisible({ timeout: 10_000 });
    // At least one recipient row is a contact link → /contacts/<id>.
    await expect(recipients.getByRole('link').first()).toHaveAttribute('href', /\/contacts\//);

    // --- PROOF OF SEND via the fake-twilio thread store (not real SMS): the
    // "keep" tenant got the outbound broadcast body; the "drop" tenant did NOT. ---
    await expect
      .poll(
        async () => {
          const threads = await listThreads(request);
          const t = threads.find((x) => x.partyNumber === keep.phone);
          return t?.messages.some((m) => m.direction === 'outbound' && (m.body ?? '').includes(body)) ?? false;
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    const droppedGotIt = (await listThreads(request))
      .find((x) => x.partyNumber === drop.phone)
      ?.messages.some((m) => m.direction === 'outbound' && (m.body ?? '').includes(body));
    expect(droppedGotIt ?? false).toBe(false);
  });
});

test.describe('Broadcasts — delete an unsent draft', () => {
  test('compose a draft, see it in the Drafts list, delete it → gone afterwards', async ({
    page,
  }) => {
    await devLogin(page);
    const stamp = `${Date.now()}`.slice(-6);

    // Compose a fresh draft through the UI. Capture its id from the create
    // response so we can assert it leaves the Drafts list after deletion. (The
    // composer's throwaway draft is (re)created on a debounced material change;
    // the LAST create for this compose is the one Preview/Delete acts on.)
    await page.goto(`${NEXT}/broadcasts/new?unitId=${SEEDED_UNIT}`);
    await expect(page.getByRole('heading', { name: 'New broadcast' })).toBeVisible();

    const createResp = page.waitForResponse(
      (r) => r.url().endsWith('/api/broadcasts') && r.request().method() === 'POST',
    );
    await page.getByLabel('Message').fill(`Draft to delete ${stamp}`);
    const created = await createResp;
    const draftId = (await created.json()).broadcastId as string;

    // It shows in the Drafts list (resume link carries ?draftId=).
    await page.goto(`${NEXT}/broadcasts`);
    await page.getByRole('tab', { name: 'Drafts' }).click();
    await expect(page.locator(`a[href="/broadcasts/new?draftId=${draftId}"]`)).toBeVisible({
      timeout: 10_000,
    });

    // Reach the Delete affordance: open the composer for this draft, write a
    // message + Preview (resume does not repopulate the template — by design;
    // editing a draft = recreate, §10), then Delete the draft.
    await page.goto(`${NEXT}/broadcasts/new?draftId=${draftId}`);
    await page.getByLabel('Message').fill(`Draft to delete ${stamp}`);
    const previewBtn = page.getByRole('button', { name: 'Preview recipients' });
    await expect(previewBtn).toBeEnabled({ timeout: 15_000 });
    await previewBtn.click();
    await expect(page.getByRole('heading', { name: 'Review recipients' })).toBeVisible();
    await page.getByRole('button', { name: 'Delete draft' }).click();

    // Back on the list; the original draft is gone (it was deleted by the recreate
    // when we re-typed the body, and the new throwaway by the Delete button).
    await expect(page).toHaveURL(/\/broadcasts$/);
    await page.getByRole('tab', { name: 'Drafts' }).click();
    await expect(page.locator(`a[href="/broadcasts/new?draftId=${draftId}"]`)).toHaveCount(0, {
      timeout: 10_000,
    });
    // The API confirms the original draft is deleted (404).
    await expect
      .poll(async () => (await page.request.get(`${NEXT}/api/broadcasts/${draftId}/results`)).status(), {
        timeout: 10_000,
      })
      .toBe(404);
  });
});
