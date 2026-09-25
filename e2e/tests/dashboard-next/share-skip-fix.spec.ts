import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { listThreads, setDeliveryOutcome } from '../../fixtures/fakeTwilio.js';
import { expectTodayReady } from '../../support/today.js';

// share-skip-fix (Sam's improvements #4 and #5), end to end on the hermetic lane:
//   1. A one-to-one share to a tenant whose conversation is switched OFF
//      (lean seed: Dario, conv-0002, ai_mode manual) pre-fills the address +
//      flyer link only (D8), reaches him anyway (D4), and the NEXT share of the
//      same property flags him "Already sent" (his text went out) and keeps him
//      checked (D5: he is the seeded recipient).
//   2. A share whose only recipient was SKIPPED (no consent recorded) reads
//      "Not sent" (D6), its row says why (D7), and once consent is recorded the
//      next share of the property does NOT flag them "Already sent" (D5: a
//      skipped slot never counts).
//   3. A recipient whose text FAILED (carrier 30007) inside a share that still
//      finalized "sent" keeps their "Already sent" flag - the interim rule,
//      pinned as such (D5; Branch B replaces it). The share carries a SECOND,
//      delivering recipient on purpose: a one-recipient share whose only text
//      fails finalizes `failed` and is excluded whole (today's rule, spec
//      section 1 item 7), and the fake's failure lands asynchronously, so a
//      single-recipient version of this test would race finalize.
// Sends are proven through the fake-twilio thread store, never real SMS.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const DARIO = {
  contactId: 'contact-tenant-0002',
  conversationId: 'conv-0002',
  phone: '+15550100004',
  firstName: 'Dario',
};
const NOTE = 'Flagged tenants you picked stay checked; "Select all" skips the others.';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** A fresh Available 1-BR property (Dario is a 1-BR voucher; the seeded units
 *  are under_application and the send guard would refuse them). */
async function createUnitViaApi(
  request: APIRequestContext,
  stamp: string,
): Promise<{ unitId: string; line1: string }> {
  const line1 = `${stamp} Share Skip Ave`;
  const res = await request.post(`${NEXT}/api/units`, {
    data: {
      landlordId: 'contact-landlord-0001',
      beds: 1,
      accepted_authorities: ['atlanta_housing'],
      address: { line1, city: 'Atlanta', state: 'GA', zip: '30314' },
      rent_min: 1100,
      rent_max: 1100,
    },
  });
  expect(res.ok()).toBeTruthy();
  const unitId = (await res.json()).unit.unitId as string;
  const flip = await request.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(flip.ok()).toBeTruthy();
  return { unitId, line1 };
}

/** A 1-BR tenant with a unique phone; `consent: false` leaves consent unrecorded.
 *  The send route's explicit selection re-fences only unknown / non-tenant /
 *  opted-out / unreachable / phone-less contacts - no consent fence
 *  (app/src/routes/broadcasts.ts:662-667) - so such a tenant reaches the
 *  fan-out, whose own consent fence skips them `no_consent`
 *  (app/src/jobs/broadcastFanOut.ts:438-448). Mirrors broadcasts.spec.ts. */
async function createTenant(
  request: APIRequestContext,
  firstName: string,
  opts: { consent: boolean },
): Promise<{ contactId: string; phone: string; firstName: string }> {
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName, lastName: 'Skiptest', phone, voucherSize: 1 },
  });
  expect(res.ok()).toBeTruthy();
  const contactId = (await res.json()).contact.contactId as string;
  if (opts.consent) await recordConsent(request, contactId);
  return { contactId, phone, firstName };
}

async function recordConsent(request: APIRequestContext, contactId: string): Promise<void> {
  const res = await request.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
  });
  expect(res.ok()).toBeTruthy();
}

/** Share `unitId` with exactly `contactIds` through the API (a seeded draft sent
 *  by explicit selection - the same route the dashboard's Send button posts). */
async function shareViaApi(request: APIRequestContext, unitId: string, contactIds: string[]): Promise<string> {
  const draft = await request.post(`${NEXT}/api/broadcasts`, {
    data: { unitId, body_template: '[Address] [FlyerLink]', seedContactIds: contactIds },
  });
  expect(draft.ok()).toBeTruthy();
  const broadcastId = (await draft.json()).broadcastId as string;
  const send = await request.post(`${NEXT}/api/broadcasts/${broadcastId}/send`, {
    data: { recipientContactIds: contactIds },
  });
  expect(send.ok()).toBeTruthy();
  return broadcastId;
}

/** Outbound messages to `phone` whose body carries `needle`. */
async function outboundHits(request: APIRequestContext, phone: string, needle: string): Promise<number> {
  const thread = (await listThreads(request)).find((t) => t.partyNumber === phone);
  return thread?.messages.filter((m) => m.direction === 'outbound' && (m.body ?? '').includes(needle)).length ?? 0;
}

/** A conversation's stored automation switch (`ai_mode`). */
async function aiModeOf(request: APIRequestContext, conversationId: string): Promise<string | undefined> {
  const res = await request.get(`${NEXT}/api/conversations/${conversationId}`);
  expect(res.ok(), `conversation fetch failed: ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { conversation: { ai_mode?: string } }).conversation.ai_mode;
}

/** The conversation a share's recipient slot was sent through (results API). */
async function slotConversationId(
  request: APIRequestContext,
  broadcastId: string,
  contactId: string,
): Promise<string | undefined> {
  const res = await request.get(`${NEXT}/api/broadcasts/${broadcastId}/results`);
  expect(res.ok(), `results fetch failed: ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { recipients: Record<string, { conversationId?: string }> };
  return body.recipients[contactId]?.conversationId;
}

/** Open the seeded one-to-one composer for (unit, tenant) and go to the review
 *  list; returns the tenant's row locator. */
async function openReviewRow(page: Page, unitId: string, contactId: string, firstName: string) {
  await page.goto(`${NEXT}/broadcasts/new?unitId=${unitId}&contactId=${contactId}`);
  await expect(page.getByLabel('Message')).toHaveValue(new RegExp(`/p/${unitId}\\?cta=text$`), { timeout: 10_000 });
  const previewBtn = page.getByRole('button', { name: 'Preview recipients' });
  await expect(previewBtn).toBeEnabled({ timeout: 15_000 });
  await previewBtn.click();
  const list = page.getByRole('list', { name: 'Candidate recipients' });
  await expect(list).toBeVisible();
  return list.locator('li', { hasText: firstName });
}

test.describe('share-skip-fix - one-to-one shares', () => {
  test('a share to a switched-off conversation: address + link default, the text lands, the next share flags him and keeps him checked', async ({
    page,
    request,
  }) => {
    await devLogin(page);
    // The proof needs Dario's thread switched OFF when the share starts. Assert
    // it LOUDLY: a lane whose conv-0002 was switched on (a stale world, a fix
    // script rehearsal) would let this test pass without proving D4.
    expect(await aiModeOf(page.request, DARIO.conversationId)).toBe('manual');
    const stamp = `${Date.now()}`.slice(-6);
    const { unitId, line1 } = await createUnitViaApi(page.request, stamp);

    // From Dario's contact page: "+ Send" opens the seeded one-to-one composer.
    await page.goto(`${NEXT}/contacts/${DARIO.contactId}`);
    await page.getByRole('button', { name: 'Send a property to this tenant' }).click();
    await expect(page).toHaveURL(new RegExp(`/broadcasts/new\\?contactId=${DARIO.contactId}`));
    await page.getByRole('combobox', { name: 'Property' }).fill(line1);
    await page.getByRole('option', { name: new RegExp(`${stamp} Share Skip`) }).click();

    // D8: the one-line address, ONE space, the flyer link - nothing else. The
    // link is the server's (?cta=text) once the first draft exists.
    const message = page.getByLabel('Message');
    await expect(message).toHaveValue(
      new RegExp(`^${line1}, Atlanta, GA 30314 \\S+/p/${unitId}\\?cta=text$`),
      { timeout: 10_000 },
    );

    const previewBtn = page.getByRole('button', { name: 'Preview recipients' });
    await expect(previewBtn).toBeEnabled({ timeout: 15_000 });
    await previewBtn.click();
    const list = page.getByRole('list', { name: 'Candidate recipients' });
    await expect(list.getByRole('checkbox')).toHaveCount(1);
    await expect(list.getByRole('checkbox')).toBeChecked();
    await expect(page.getByText(NOTE)).toBeVisible();
    await page.getByRole('button', { name: /^Send to 1 tenant\b/ }).click();

    // D4: the conversation is switched OFF (lean seed) and the text lands anyway;
    // the results row reaches Delivered (the fake auto-delivers).
    await expect(page).toHaveURL(/\/broadcasts\/[A-Za-z0-9_-]+$/, { timeout: 15_000 });
    const recipients = page.getByRole('list', { name: 'Recipients' });
    await expect(recipients.getByText('Delivered').first()).toBeVisible({ timeout: 15_000 });
    await expect(recipients.getByText('Skipped')).toHaveCount(0);
    await expect
      .poll(async () => outboundHits(request, DARIO.phone, `/p/${unitId}`), { timeout: 15_000 })
      .toBe(1);
    // ...and it went out THROUGH the switched-off thread: the fan-out found
    // conv-0002 by its participant_phone instead of minting a fresh (switched
    // on) conversation, which would also deliver and prove nothing.
    const broadcastId = new URL(page.url()).pathname.split('/').pop() ?? '';
    expect(await slotConversationId(page.request, broadcastId, DARIO.contactId)).toBe(DARIO.conversationId);

    // D5 (went out -> flagged): the NEXT share of the same property flags Dario
    // "Already sent" and, as the seeded recipient, keeps him CHECKED.
    const row = await openReviewRow(page, unitId, DARIO.contactId, DARIO.firstName);
    await expect(row.getByText('Already sent')).toBeVisible();
    await expect(row.getByRole('checkbox')).toBeChecked();
    // Do not send twice; leave the draft (the composer disposes an untouched one).
  });

  test('a share whose only recipient was SKIPPED reads Not sent and says why; after consent is recorded they are NOT "Already sent"', async ({
    page,
    request,
  }) => {
    await devLogin(page);
    const stamp = `${Date.now()}`.slice(-6);
    const { unitId } = await createUnitViaApi(page.request, stamp);
    const noConsent = await createTenant(page.request, `Skipme${stamp}`, { consent: false });
    const broadcastId = await shareViaApi(page.request, unitId, [noConsent.contactId]);

    // D6 + D7 on the results page: the one recipient was skipped for consent.
    await page.goto(`${NEXT}/broadcasts/${broadcastId}`);
    await expect(page.locator('header').getByText('Not sent', { exact: true })).toBeVisible({ timeout: 15_000 });
    const recipients = page.getByRole('list', { name: 'Recipients' });
    await expect(recipients.getByText(/No texting consent recorded/)).toBeVisible({ timeout: 15_000 });
    expect(await outboundHits(request, noConsent.phone, `/p/${unitId}`)).toBe(0);

    // D6 on the list: the same share reads Not sent there, still under the Sent
    // tab - THIS share's row (by its link), not whichever all-skipped share
    // happens to be listed first.
    await page.goto(`${NEXT}/broadcasts`);
    await page.getByRole('tab', { name: 'Sent' }).click();
    const rows = page.getByRole('list', { name: 'Property sends' });
    const shareRow = rows.locator(`a[href="/broadcasts/${broadcastId}"]`);
    await expect(shareRow.getByText('Not sent', { exact: true })).toBeVisible({ timeout: 10_000 });

    // D5 (skipped -> NOT flagged): record consent, open the next share of the
    // same property to them - no "Already sent" flag, and the row is checked.
    await recordConsent(page.request, noConsent.contactId);
    const row = await openReviewRow(page, unitId, noConsent.contactId, noConsent.firstName);
    await expect(row).toBeVisible();
    await expect(row.getByText('Already sent')).toHaveCount(0);
    await expect(row.getByRole('checkbox')).toBeChecked();
  });

  test('a recipient whose text FAILED, in a share that still finalized sent, stays "Already sent" (the interim rule, pinned)', async ({
    page,
    request,
  }) => {
    await devLogin(page);
    const stamp = `${Date.now()}`.slice(-6);
    const { unitId } = await createUnitViaApi(page.request, stamp);
    const fine = await createTenant(page.request, `Fineme${stamp}`, { consent: true });
    const failing = await createTenant(page.request, `Failme${stamp}`, { consent: true });
    // Arm the NEXT message to the failing handset with a carrier failure. The
    // fake fails it ASYNCHRONOUSLY (a status callback ~300 ms after the send),
    // so the share also carries a normal recipient: with one recipient the
    // callback could land before finalize and the share would close `failed`
    // and be excluded whole - a real rule, not a flake. Two recipients make
    // the share finalize `sent` whatever the timing.
    await setDeliveryOutcome(request, {
      partyNumber: failing.phone,
      profile: { kind: 'fail', failState: 'failed', errorCode: '30007' },
    });
    const broadcastId = await shareViaApi(page.request, unitId, [fine.contactId, failing.contactId]);

    // D7 on a failed row: the carrier reason, from the shared map; the other
    // row delivers, so the share itself reads Sent.
    await page.goto(`${NEXT}/broadcasts/${broadcastId}`);
    const recipients = page.getByRole('list', { name: 'Recipients' });
    await expect(recipients.getByText('Failed').first()).toBeVisible({ timeout: 15_000 });
    await expect(recipients.getByText(/Carrier filtered the message/)).toBeVisible({ timeout: 15_000 });
    await expect(recipients.getByText('Delivered').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('header').getByText('Sent', { exact: true })).toBeVisible({ timeout: 15_000 });

    // D5 (failed -> still flagged, interim): the next share of the property flags
    // the failed recipient exactly as it flags the delivered one.
    const row = await openReviewRow(page, unitId, failing.contactId, failing.firstName);
    await expect(row.getByText('Already sent')).toBeVisible();
    await expect(row.getByRole('checkbox')).toBeChecked(); // seeded, so still checked
  });
});
