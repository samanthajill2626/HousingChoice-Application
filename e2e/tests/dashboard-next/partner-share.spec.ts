// e2e/tests/dashboard-next/partner-share.spec.ts
//
// A direct property share to a partner (caseworkers design D20, D22,
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md),
// end to end against the real backend: from a PARTNER's page ("Properties
// sent" card -> "+ Send", aria-label "Send a property to this partner") the
// seeded composer sends the normal share (address + flyer link) into the
// partner's own conversation, which the share MINTS as `partner_1to1`; the
// partner's Properties sent card lists the property; and the property's
// "Sent to" card labels the partner's row by its role.
//
// The recipient is a fresh, run-unique caseworker - a `partner` with the role
// "Caseworker", created through the contacts POST as a NEW contact (D16) -
// with consent recorded. Never the lean partner Renee Carter: she has no
// consent by design and is a Possible caseworkers row. ISOLATION for the
// thread type (planner rulings, "E2E rules" 3): nothing calls
// POST /api/contacts/:id/conversation before the share - that route mints the
// thread by contact type itself and would make the type check vacuous. The
// type is read only AFTER the send, when the share's thread is the only one
// this phone has ever had. Sends are asserted through the fake-twilio thread
// store (matching-entry-points.spec.ts precedent); a fresh Available property
// satisfies the availability guard.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { listThreads } from '../../fixtures/fakeTwilio.js';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

/** The S10 selector contract rows C16-C19 (plan 3.9, spec D22). */
const UI = {
  propertiesSent: /Properties sent/,
  partnerSend: 'Send a property to this partner',
  composerHeading: 'Send a property',
  property: 'Property',
  message: 'Message',
  preview: 'Preview recipients',
  review: 'Review recipients',
  candidates: 'Candidate recipients',
  sendOne: /^Send to 1 recipient\b/,
  // The heading's name is "Sent to" PLUS its "Send this property" action
  // (Card renders the aside inside the <h3>): match the prefix.
  sentToCard: /^Sent to\b/,
  // displayKind: the role, else the type label (D22).
  rowLabel: /\bCaseworker\b/,
};

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

let phoneSeq = 0;
/** A run-unique, well-formed NANP number (+1555 + 5 stamp digits + 2 seq digits). */
function uniquePhone(): string {
  phoneSeq += 1;
  return `+1555${`${Date.now()}`.slice(-5)}${String(phoneSeq).padStart(2, '0')}`;
}

/** A NEW caseworker (partner + role "Caseworker", D16) with consent recorded,
 *  so the just-in-time consent gate lets the share through. */
async function createConsentedCaseworker(
  request: APIRequestContext,
  stamp: string,
): Promise<{ contactId: string; name: string; phone: string }> {
  const phone = uniquePhone();
  const firstName = `Share${stamp}`;
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type: 'partner', role: 'Caseworker', firstName, lastName: 'Partnershare', phone },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  const consent = await request.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
  });
  expect(consent.ok(), await consent.text()).toBeTruthy();
  return { contactId, name: `${firstName} Partnershare`, phone };
}

/** A fresh per-run property, published Available (the send guard requires it). */
async function createUnitViaApi(
  request: APIRequestContext,
  stamp: string,
): Promise<{ unitId: string; line1: string }> {
  const line1 = `${stamp} Partner Share Ave`;
  const res = await request.post(`${NEXT}/api/units`, {
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
  const flip = await request.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(flip.ok(), await flip.text()).toBeTruthy();
  return { unitId, line1 };
}

/** Outbound messages to `phone` whose body contains `needle` (fake-twilio).
 *  A fresh number's thread holds only what this test sent. */
async function outboundHits(request: APIRequestContext, phone: string, needle: string): Promise<number> {
  const threads = await listThreads(request);
  const thread = threads.find((x) => x.partyNumber === phone);
  return (
    thread?.messages.filter((m) => m.direction === 'outbound' && (m.body ?? '').includes(needle)).length ?? 0
  );
}

test.describe('Partner share - a property sent from a partner page', () => {
  test('the share lands in a partner_1to1 thread, on the Properties sent card, and on the property labelled by role', async ({
    page,
    request,
  }) => {
    // dev-login FIRST so page.request carries the session cookie for setup.
    await devLogin(page);
    const stamp = `${Date.now()}`.slice(-6);
    const partner = await createConsentedCaseworker(page.request, stamp);
    const { unitId, line1 } = await createUnitViaApi(page.request, stamp);

    // The partner page's Properties sent card + its Send action (D20).
    await page.goto(`${NEXT}/contacts/${partner.contactId}`);
    const propertiesSent = page.locator('section', { has: page.getByRole('heading', { name: UI.propertiesSent }) });
    await expect(propertiesSent).toBeVisible();
    await propertiesSent.getByRole('button', { name: UI.partnerSend, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/broadcasts/new\\?contactId=${partner.contactId}`));
    await expect(page.getByRole('heading', { name: UI.composerHeading })).toBeVisible();
    await expect(page.getByText(/Sending to/)).toBeVisible();

    // Pick the property; the message fills with the normal share: the one-line
    // address and the flyer link (share-skip-fix D8).
    await page.getByRole('combobox', { name: UI.property }).fill(line1);
    await page.getByRole('option', { name: new RegExp(`${stamp} Partner Share Ave`) }).click();
    await expect(page.getByLabel(UI.message)).toHaveValue(
      new RegExp(`^${stamp} Partner Share Ave, Atlanta, GA 30314 \\S+/p/${unitId}\\?cta=text$`),
      { timeout: 10_000 },
    );

    // The partner seed RESOLVES (before caseworkers it was dropped as a
    // non-tenant): one pre-checked row, named for the partner.
    const previewBtn = page.getByRole('button', { name: UI.preview });
    await expect(previewBtn).toBeEnabled({ timeout: 15_000 });
    await previewBtn.click();
    await expect(page.getByRole('heading', { name: UI.review })).toBeVisible();
    const list = page.getByRole('list', { name: UI.candidates });
    await expect(list.getByRole('checkbox')).toHaveCount(1);
    await expect(list.getByRole('checkbox')).toBeChecked();
    await expect(list.locator('li', { hasText: partner.name })).toBeVisible();
    await page.getByRole('button', { name: UI.sendOne }).click();

    // Proof of send: exactly one text with the flyer link.
    await expect
      .poll(async () => outboundHits(request, partner.phone, `/p/${unitId}`), {
        timeout: 15_000,
        message: 'the partner should receive exactly one message with the flyer link',
      })
      .toBe(1);

    // The share MINTED the partner's thread as partner_1to1 (D20:
    // conversationTypeFor(contact) at both fan-out sites). This POST RETURNS
    // the open thread the share created - it mints only when there is none,
    // and this phone had none before the share.
    const conv = await page.request.post(`${NEXT}/api/contacts/${partner.contactId}/conversation`);
    expect(conv.ok()).toBeTruthy();
    expect(((await conv.json()) as { conversation: { type: string } }).conversation.type).toBe('partner_1to1');

    // The listing send is recorded a beat after the text (same deferred pass):
    // wait for it through the card's own API before loading the page.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${NEXT}/api/contacts/${partner.contactId}/listings-sent`);
          if (!res.ok()) return false;
          const rows = ((await res.json()) as { sent: Array<{ unitId: string }> }).sent;
          return rows.some((r) => r.unitId === unitId);
        },
        { timeout: 15_000, message: 'the listing send should be recorded for the partner' },
      )
      .toBe(true);

    // The partner's Properties sent card lists the property.
    await page.goto(`${NEXT}/contacts/${partner.contactId}`);
    await expect(propertiesSent.locator(`a[href="/listings/${unitId}"]`)).toBeVisible({ timeout: 10_000 });

    // The property's "Sent to" card lists the partner, labelled by role (D22).
    // A fresh property sent once: the card holds this one row only.
    await page.goto(`${NEXT}/listings/${unitId}`);
    const sentTo = page.locator('section', { has: page.getByRole('heading', { name: UI.sentToCard }) });
    await expect(sentTo.locator(`a[href="/contacts/${partner.contactId}"]`)).toBeVisible({ timeout: 10_000 });
    await expect(sentTo.getByText(UI.rowLabel).first()).toBeVisible();
  });
});
