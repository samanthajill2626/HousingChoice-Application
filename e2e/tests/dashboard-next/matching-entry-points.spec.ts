import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { listThreads } from '../../fixtures/fakeTwilio.js';

// Matching entry points (:5174) - the two ways a navigator starts a "send a
// property to tenants" flow, end to end against the real backend:
//   1. From a TENANT contact page ("Properties sent" card -> "+ Send"): a seeded
//      1:1 send. The composer opens seeds-only (no filters), the operator picks a
//      property, the message auto-resolves to that single tenant, Preview shows
//      exactly one pre-checked row, Send lands it in the tenant's outbox and on
//      the "Properties sent" card.
//   2. From a PROPERTY detail page ("Sent to tenants" card -> "+ Send"): the
//      audience-filtered composer with the unit pre-filled, curated down to one
//      hand-picked tenant (Deselect all -> add one via search) -> Send -> the
//      "Sent to tenants" card lists them.
//
// Sends are asserted via the fake-twilio thread store (never real SMS), exactly
// as broadcasts.spec.ts does. Fresh, uniquely-phoned tenants are created via the
// API so every outbox thread has a clean, order-independent single message.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const SEEDED_UNIT = 'unit-0001'; // 1450 Joseph E. Boone Blvd NW, Atlanta, GA (beds 2)

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/** Create a consenting tenant via the API (camelCase voucherSize so the resolver
 *  matches). Mirrors broadcasts.spec.ts's helper. `voucherSize` defaults to 2
 *  (the unit-0001 2-BR audience); pass 3 for a tenant the 2-BR filter will NOT
 *  catch (so it must be hand-added via search). Returns the new contactId + the
 *  display name and unique phone we can search/assert on. */
async function createTenant(
  request: APIRequestContext,
  firstName: string,
  voucherSize = 2,
): Promise<{ contactId: string; firstName: string; name: string; phone: string }> {
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName, lastName: 'Matchtest', phone, voucherSize },
  });
  expect(res.ok()).toBeTruthy();
  const contactId = (await res.json()).contact.contactId as string;
  // A no-consent tenant is fenced out of sends; these tenants are meant to be
  // SENDABLE, so record consent.
  const consentRes = await request.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
  });
  expect(consentRes.ok()).toBeTruthy();
  return { contactId, firstName, name: `${firstName} Matchtest`, phone };
}

/** Count the outbound messages to `phone` whose body contains `needle`, read
 *  from the fake-twilio thread store. A freshly-created tenant's thread only
 *  holds messages this test sent, so the count is exact and order-independent. */
async function outboundHits(
  request: APIRequestContext,
  phone: string,
  needle: string,
): Promise<number> {
  const threads = await listThreads(request);
  const thread = threads.find((x) => x.partyNumber === phone);
  return (
    thread?.messages.filter((m) => m.direction === 'outbound' && (m.body ?? '').includes(needle))
      .length ?? 0
  );
}

test.describe('Matching entry points - tenant file + property page', () => {
  test('tenant-file + Send: seeded 1:1 send lands in the outbox and on the card', async ({
    page,
    request,
  }) => {
    // dev-login FIRST so page.request carries the session cookie for the setup calls.
    await devLogin(page);

    // A fresh, consenting tenant with a unique phone (clean single-message outbox).
    const stamp = `${Date.now()}`.slice(-6);
    const tenant = await createTenant(page.request, `Sendto${stamp}`);

    // From the tenant's contact page, the "Properties sent" card "+ Send" action
    // opens the seeded 1:1 composer (?contactId=).
    await page.goto(`${NEXT}/contacts/${tenant.contactId}`);
    await page.getByRole('button', { name: 'Send a property to this tenant' }).click();
    await expect(page).toHaveURL(new RegExp(`/broadcasts/new\\?contactId=${tenant.contactId}`));

    // Seeds-only composer: the "Send a property" heading + a "Sending to <name>." banner.
    await expect(page.getByRole('heading', { name: 'Send a property' })).toBeVisible();
    await expect(page.getByText(/Sending to/)).toBeVisible();

    // Pick the property via the typeahead (type a distinctive slice of the address,
    // click the option). This attaches unit-0001 and triggers the auto-resolve.
    await page.getByRole('combobox', { name: 'Property' }).fill('Joseph E. Boone');
    await page.getByRole('option', { name: /Joseph E\. Boone/ }).click();

    // The message now holds the FINAL resolved text (no token template): it greets
    // the tenant by first name and carries the flyer link. No unresolved [TenantName].
    const message = page.getByLabel('Message');
    await expect(message).toHaveValue(/Hi /, { timeout: 10_000 });
    await expect(message).toHaveValue(new RegExp(`/p/${SEEDED_UNIT}`));
    await expect(message).not.toHaveValue(/\[TenantName\]/);

    // Preview -> exactly one pre-checked recipient row (the seeded tenant) -> Send.
    const previewBtn = page.getByRole('button', { name: 'Preview recipients' });
    await expect(previewBtn).toBeEnabled({ timeout: 15_000 });
    await previewBtn.click();

    await expect(page.getByRole('heading', { name: 'Review recipients' })).toBeVisible();
    const list = page.getByRole('list', { name: 'Candidate recipients' });
    await expect(list.getByRole('checkbox')).toHaveCount(1);
    await expect(list.getByRole('checkbox')).toBeChecked();

    await page.getByRole('button', { name: /^Send to 1 tenant\b/ }).click();

    // Proof of send: the tenant's outbox gained EXACTLY ONE message carrying the
    // property's flyer link.
    await expect
      .poll(async () => outboundHits(request, tenant.phone, `/p/${SEEDED_UNIT}`), {
        timeout: 15_000,
        message: 'the tenant should receive exactly one message with the flyer link',
      })
      .toBe(1);

    // The worker records the listing send a beat AFTER the SMS reaches the
    // outbox (same deferred send pass), and the contact page fetches its card
    // data once on mount - so wait for the row via the card's backing API
    // (bounded poll) BEFORE navigating, or the mount can race the write and the
    // card stays empty (observed: the fetch beat the write by ~700ms).
    await expect
      .poll(
        async () => {
          const res = await page.request.get(
            `${NEXT}/api/contacts/${tenant.contactId}/listings-sent`,
          );
          if (!res.ok()) return false;
          const rows = (await res.json()).sent as Array<{ unitId: string }>;
          return rows.some((r) => r.unitId === SEEDED_UNIT);
        },
        { timeout: 15_000, message: 'the listing send should be recorded for the tenant' },
      )
      .toBe(true);

    // Back on the contact page, the "Properties sent" card now lists the unit.
    await page.goto(`${NEXT}/contacts/${tenant.contactId}`);
    const propertiesSent = page.locator('section', {
      has: page.getByRole('heading', { name: /Properties sent/ }),
    });
    await expect(propertiesSent.locator(`a[href="/listings/${SEEDED_UNIT}"]`)).toBeVisible({
      timeout: 10_000,
    });
  });

  test('property-page + Send: hand-picked single recipient', async ({ page, request }) => {
    await devLogin(page);
    const stamp = `${Date.now()}`.slice(-6);

    // A 3-BR tenant: NOT caught by the unit's 2-BR audience filter, so it must be
    // added by hand via the "Add a tenant" search.
    const added = await createTenant(page.request, `Addme${stamp}`, 3);

    // From the property page, the "Sent to tenants" card "+ Send" action opens the
    // audience-filtered composer with the unit pre-filled (?unitId=).
    await page.goto(`${NEXT}/listings/${SEEDED_UNIT}`);
    await page.getByRole('button', { name: 'Send this property to tenants' }).click();
    await expect(page).toHaveURL(new RegExp(`/broadcasts/new\\?unitId=${SEEDED_UNIT}`));
    await expect(page.getByRole('heading', { name: 'Send a property' })).toBeVisible();

    // Filters are visible + the 2-BR chip is pre-filled from the unit's beds.
    const twoBr = page.getByRole('button', { name: /2-BR/ });
    await expect(twoBr).toHaveAttribute('aria-pressed', 'true');

    // Write a token template (unique body so its outbound copy is assertable).
    const body = `Hand-pick ${stamp} - take a look: [FlyerLink]`;
    await page.getByLabel('Message').fill(body);

    const previewBtn = page.getByRole('button', { name: 'Preview recipients' });
    await expect(previewBtn).toBeEnabled({ timeout: 15_000 });
    await previewBtn.click();

    await expect(page.getByRole('heading', { name: 'Review recipients' })).toBeVisible();

    // Curate to exactly the hand-picked tenant: clear the filter matches, then add
    // the 3-BR tenant via search (appends as a checked "Added" row).
    await page.getByRole('button', { name: 'Deselect all' }).click();
    await page.getByRole('combobox', { name: 'Add a tenant' }).fill(`Addme${stamp}`);
    await page.getByRole('option', { name: new RegExp(added.name) }).click();

    const list = page.getByRole('list', { name: 'Candidate recipients' });
    const addedRow = list.locator('li', { hasText: added.name });
    await expect(addedRow.getByRole('checkbox')).toBeChecked();

    // Send to the single curated recipient.
    await page.getByRole('button', { name: /^Send to 1 tenant\b/ }).click();

    // Proof of send: the hand-picked tenant got exactly one message with our body;
    // nobody else was created for this run, so the outbox is unambiguous.
    await expect
      .poll(async () => outboundHits(request, added.phone, stamp), {
        timeout: 15_000,
        message: 'the hand-picked tenant should receive exactly one message',
      })
      .toBe(1);

    // Same worker-write race as test 1: wait for the recipient row via the
    // card's backing API (bounded poll) BEFORE navigating.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${NEXT}/api/units/${SEEDED_UNIT}/recipients`);
          if (!res.ok()) return false;
          const rows = (await res.json()).recipients as Array<{ contactId: string }>;
          return rows.some((r) => r.contactId === added.contactId);
        },
        { timeout: 15_000, message: 'the listing send should be recorded for the unit' },
      )
      .toBe(true);

    // The property page's "Sent to tenants" card now lists the hand-picked tenant.
    await page.goto(`${NEXT}/listings/${SEEDED_UNIT}`);
    const sentCard = page.locator('section', {
      has: page.getByRole('heading', { name: 'Sent to tenants' }),
    });
    await expect(
      sentCard.locator(`a[href="/contacts/${added.contactId}"]`),
    ).toBeVisible({ timeout: 10_000 });
  });
});
