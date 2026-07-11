import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  listThreads,
  registerParty,
  sendAsParty,
  postInboundSms,
  twimlMessageBody,
  APP_NUMBER,
} from '../../fixtures/fakeTwilio.js';
import { callTimeline, uniqueVoicePhone, verifyCell } from '../../fixtures/voiceSetup.js';

// A2P / SMS compliance (design §8) — end-to-end coverage of the front-of-lifecycle
// consent hardening shipped in Phases 1–3, against the real hermetic stack (:5174
// dashboard + :8080 app + the fake-twilio host). Each §8 behavior is a describe.
//
// FILED-COPY GUARD: every SMS-copy assertion is pinned to the app's single source
// of truth (app/src/lib/smsCompliance.ts) — reproduced here as `const`s the app
// package can't be imported from the e2e package, so we mirror the strings VERBATIM
// and also assert structural invariants (opt-out line present, HELP has no phone
// number) so a copy drift fails loudly rather than silently matching a stale string.
//
// KEYWORD-REPLY MECHANISM: the webhook answers a matched STOP/HELP/opt-in keyword
// with a TwiML `<Message>` in the /sms HTTP RESPONSE — NOT an outbound thread the
// fake records (the fake's send-as-party discards the response body). So the keyword
// replies are asserted by POSTing the signed inbound webhook OURSELVES via the
// `postInboundSms` test-support helper (fixtures/fakeTwilio.ts) and reading the TwiML
// back. Suppression side-effects (sms_opt_out / consent) are asserted via the
// authenticated contacts API. Unique per-case phones avoid inbound-SID/dedupe and
// per-phone welcome-idempotency collisions.

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

// --- Filed A2P copy (VERBATIM mirror of app/src/lib/smsCompliance.ts) ---
const SMS_BRAND_NAME = 'Tenant Place LLC';
const WELCOME_SMS = `Welcome to ${SMS_BRAND_NAME}! You're signed up for new properties that accept your voucher, plus tour reminders and updates. Msg frequency varies. Msg & data rates may apply. Reply STOP to unsubscribe, HELP for help.`;
const STOP_CONFIRMATION = `You have successfully been unsubscribed. You will not receive any more messages from this number. Reply START to resubscribe.`;
const HELP_REPLY = `${SMS_BRAND_NAME}: housing listing alerts for voucher holders. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out. More info: tenant.place.`;
// Keyword sets (spec §6) — the opt-out set adds OPTOUT+REVOKE; opt-in adds JOIN+HOME.
const OPT_OUT_KEYWORDS = ['OPTOUT', 'CANCEL', 'END', 'QUIT', 'UNSUBSCRIBE', 'REVOKE', 'STOP', 'STOPALL'];
const OPT_IN_KEYWORDS = ['START', 'JOIN', 'HOME', 'YES', 'UNSTOP'];

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

let phoneSeq = 0;
/** Per-run-unique, well-formed NANP number (+1555 + 5 stamp digits + 2 seq digits). */
function uniquePhone(): string {
  phoneSeq += 1;
  const stamp = `${Date.now()}`.slice(-5);
  return `+1555${stamp}${String(phoneSeq).padStart(2, '0')}`;
}
/** A unique inbound MessageSid so the webhook's SID-dedupe never drops a case. */
function uniqueSid(tag: string): string {
  phoneSeq += 1;
  return `SMe2e${tag}${Date.now()}${phoneSeq}`;
}

/** Create a contact via the authenticated API. With no consent fields it is a
 *  NO-CONSENT contact (seeded/created contacts carry no consent_method) — exactly
 *  what the JIT gate + broadcast fence key on. Returns id + phone + first name. */
async function createContact(
  request: APIRequestContext,
  opts: { type?: 'tenant' | 'landlord'; firstName: string; voucherSize?: number },
): Promise<{ contactId: string; firstName: string; phone: string }> {
  const phone = uniquePhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: {
      type: opts.type ?? 'tenant',
      firstName: opts.firstName,
      lastName: 'A2Ptest',
      phone,
      ...(opts.voucherSize !== undefined && { voucherSize: opts.voucherSize }),
    },
  });
  expect(res.ok(), `create contact ${opts.firstName}`).toBeTruthy();
  const contactId = (await res.json()).contact.contactId as string;
  return { contactId, firstName: opts.firstName, phone };
}

/** Read a contact through the authenticated API (asserts consent/suppression state). */
async function getContact(
  request: APIRequestContext,
  contactId: string,
): Promise<Record<string, unknown>> {
  const res = await request.get(`${NEXT}/api/contacts/${contactId}`);
  expect(res.ok(), `get contact ${contactId}`).toBeTruthy();
  return (await res.json()).contact as Record<string, unknown>;
}

// =====================================================================
// §8.1 — Public form checkbox is SERVER-enforced (client gate + server 400)
// =====================================================================
test.describe('A2P §8.1 — public intake consent checkbox', () => {
  test('the /join submit is blocked until the consent box is checked (client gate)', async ({
    page,
  }) => {
    // No session — the standalone housing-fair intake.
    await page.goto(`${NEXT}/join`);
    await expect(page.getByRole('heading', { name: /Find your next home/i })).toBeVisible();

    const phone = uniquePhone();
    await page.getByLabel('First name').fill('Consent');
    await page.getByLabel('Last name').fill('Gate');
    await page.getByLabel('Phone number').fill(phone);

    // The required CTIA consent checkbox exists, is unchecked by default, and its
    // accessible name is the filed disclosure (/I agree to receive/).
    const consent = page.getByRole('checkbox', { name: /I agree to receive/i });
    await expect(consent).toBeVisible();
    await expect(consent).not.toBeChecked();

    // Submit WITHOUT checking it → the client blocks the send: an inline error
    // appears and the thank-you never renders (no navigation to the reveal).
    await page.getByRole('button', { name: 'Sign me up' }).click();
    await expect(page.getByRole('alert')).toContainText(/agree to receive texts/i);
    await expect(page.getByRole('heading', { name: /you're signed up/i })).toHaveCount(0);

    // Check the box → submit now succeeds (the thank-you renders).
    await consent.check();
    await page.getByRole('button', { name: 'Sign me up' }).click();
    await expect(page.getByRole('heading', { name: /you're signed up/i })).toBeVisible();
  });

  test('the server rejects a direct POST missing smsConsent (consent_required) and stamps web_form on success', async ({
    page,
    request,
  }) => {
    // (a) Direct POST with NO smsConsent → 400 consent_required (the second fence
    // behind the client checkbox). A distinct code (not the generic "invalid request").
    const noConsent = await request.post(`${NEXT}/public/housing-fair`, {
      data: { firstName: 'Server', lastName: 'Gate', phone: uniquePhone() },
    });
    expect(noConsent.status()).toBe(400);
    expect((await noConsent.json()).error).toBe('consent_required');

    // smsConsent:false is likewise rejected (must be exactly true).
    const falseConsent = await request.post(`${NEXT}/public/housing-fair`, {
      data: { firstName: 'Server', lastName: 'Gate', phone: uniquePhone(), smsConsent: false },
    });
    expect(falseConsent.status()).toBe(400);
    expect((await falseConsent.json()).error).toBe('consent_required');

    // (b) With consent → 200; the contact is created with consent_method='web_form',
    // and the welcome SMS is the FILED WELCOME_SMS copy.
    const phone = uniquePhone();
    const ok = await request.post(`${NEXT}/public/housing-fair`, {
      data: { firstName: 'Webform', lastName: 'Signup', phone, voucherSize: 2, smsConsent: true },
    });
    expect(ok.ok()).toBeTruthy();

    // dev-login so page.request carries the session for the authenticated contacts read.
    await devLogin(page);
    let contact: Record<string, unknown> | undefined;
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${NEXT}/api/contacts?phone=${encodeURIComponent(phone)}`);
          if (!res.ok()) return false;
          contact = (await res.json()).contacts[0];
          return contact !== undefined;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    expect(contact!['consent_method']).toBe('web_form');
    expect(contact!['consent_version']).toBe('ctia-2026-06');

    // The welcome SMS landed in the fake thread and equals the filed WELCOME_SMS
    // (the default welcome carries no {firstName} token → exact-match).
    await expect
      .poll(
        async () => {
          const threads = await listThreads(request);
          const t = threads.find((x) => x.partyNumber === phone);
          return t?.messages.some((m) => m.direction === 'outbound' && m.body === WELCOME_SMS) ?? false;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  });
});

// =====================================================================
// §8.2 — Just-in-time consent gate (hard-block modal + reply exemption)
// =====================================================================
test.describe('A2P §8.2 — JIT consent gate', () => {
  test('a proactive text to a no-consent contact hard-blocks; recording consent in the modal lets it send', async ({
    page,
    request,
  }) => {
    await devLogin(page);
    const stamp = `${Date.now()}`.slice(-6);
    const tenant = await createContact(page.request, { firstName: `Jit${stamp}` });

    // Register the party on the fake so the proactive outbound has a thread to land in.
    await registerParty(request, { label: tenant.firstName, role: 'tenant', number: tenant.phone });

    // Establish a conversation the reply box can send into WITHOUT conferring
    // consent. An INBOUND interaction can no longer do that — by design (the
    // client-inbound consent basis), an inbound text stamps `inbound_text` and an
    // inbound call stamps `inbound_call`. The one realistic no-consent
    // thread-opener is an OUTBOUND masked call (staff call a manually-added
    // contact first, then text): the originate route creates the 1:1 conversation
    // BEFORE dialing and stamps NO consent_method. Verify the session navigator's
    // cell (the originate route 409s without one), then place the call — no need
    // to answer; the conversation + call entry persist at originate time.
    await verifyCell(page.request, uniqueVoicePhone());
    const call = await page.request.post(`${NEXT}/api/contacts/${tenant.contactId}/call`, {
      data: {},
    });
    expect(call.status(), await call.text()).toBe(200);
    // Wait for the call entry to land on the contact timeline (the reply box
    // resolves its conversation from the timeline).
    await expect
      .poll(async () => (await callTimeline(page.request, tenant.contactId)).length, {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    // Sanity: the contact STILL has no consent — an OUTBOUND call stamps none —
    // so a HUMAN proactive text will hit the JIT gate.
    expect((await getContact(page.request, tenant.contactId))['consent_method']).toBeUndefined();

    await page.goto(`${NEXT}/contacts/${tenant.contactId}`);
    // Fill the reply FIRST (the Send button is disabled while the draft is empty),
    // then it enables once the timeline resolves a conversation to send into.
    const body = `Hi — a 2BR home just opened up. ${stamp}`;
    await page.getByRole('textbox', { name: 'Reply message' }).fill(body);
    const sendBtn = page.getByRole('button', { name: 'Send', exact: true });
    await expect(sendBtn).toBeEnabled({ timeout: 20_000 });

    // Attempt a PROACTIVE 1:1 send → the JIT gate refuses it (409 contact_no_consent).
    await sendBtn.click();

    // The hard-block consent modal appears (NOT a generic error).
    const modal = page.getByRole('dialog', { name: 'Record consent before texting' });
    await expect(modal).toBeVisible();

    // Record consent in the modal: pick a HUMAN method (+ default today) → confirm.
    await modal.getByLabel('How did they consent?').selectOption('verbal_phone');
    await modal.getByRole('button', { name: 'Record consent & send' }).click();

    // The modal closes and the send goes through — proof-of-send via the fake thread.
    await expect(modal).toHaveCount(0, { timeout: 10_000 });
    await expect
      .poll(
        async () => {
          const threads = await listThreads(request);
          const t = threads.find((x) => x.partyNumber === tenant.phone);
          return t?.messages.some((m) => m.direction === 'outbound' && (m.body ?? '').includes(body)) ?? false;
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    // Consent was stamped on the contact (the JIT PATCH; server records the method).
    const after = await getContact(page.request, tenant.contactId);
    expect(after['consent_method']).toBe('verbal_phone');
  });

  test('a reply in a contact-STARTED conversation does NOT block (inbound_text consent)', async ({
    page,
    request,
  }) => {
    const stamp = `${Date.now()}`.slice(-6);
    // The tenant TEXTS FIRST (inbound auto-capture stamps consent_method='inbound_text').
    const phone = uniquePhone();
    await registerParty(request, { label: `Starter${stamp}`, role: 'tenant', number: phone });
    await sendAsParty(request, { from: phone, to: APP_NUMBER, body: `I need a place. ${stamp}` });

    await devLogin(page);
    // Resolve the auto-captured (unknown) contact by phone.
    let contactId: string | undefined;
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${NEXT}/api/contacts?type=unknown`);
          if (!res.ok()) return false;
          contactId = ((await res.json()).contacts as Array<{ contactId: string; phone?: string }>).find(
            (c) => c.phone === phone,
          )?.contactId;
          return contactId !== undefined;
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    // It carries inbound_text consent from auto-capture (so a reply must NOT block).
    const captured = await getContact(page.request, contactId!);
    expect(captured['consent_method']).toBe('inbound_text');

    // Reply from the open thread → sends immediately, NO consent modal.
    await page.goto(`${NEXT}/contacts/${contactId}`);
    const reply = `Sure — let's find you one. ${stamp}`;
    await page.getByRole('textbox', { name: 'Reply message' }).fill(reply);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.getByRole('dialog', { name: 'Record consent before texting' })).toHaveCount(0);
    await expect
      .poll(
        async () => {
          const threads = await listThreads(request);
          const t = threads.find((x) => x.partyNumber === phone);
          return t?.messages.some((m) => m.direction === 'outbound' && (m.body ?? '').includes(reply)) ?? false;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  });
});

// =====================================================================
// §8.3 — Broadcast excludes + surfaces no-consent recipients
// =====================================================================
test.describe('A2P §8.3 — broadcast consent fence', () => {
  test('a no-consent tenant is surfaced in the preview + excluded from the send; recording consent re-includes them', async ({
    page,
    request,
  }) => {
    await devLogin(page);
    const stamp = `${Date.now()}`.slice(-6);

    // Two 2-BR tenants: one WITH consent (via a JIT-style PATCH) and one WITHOUT.
    const consented = await createContact(page.request, { firstName: `Yes${stamp}`, voucherSize: 2 });
    const noConsent = await createContact(page.request, { firstName: `No${stamp}`, voucherSize: 2 });
    await registerParty(request, { label: consented.firstName, role: 'tenant', number: consented.phone });
    await registerParty(request, { label: noConsent.firstName, role: 'tenant', number: noConsent.phone });
    // Record consent on the "consented" tenant via the contacts PATCH (human method).
    const patch = await page.request.patch(`${NEXT}/api/contacts/${consented.contactId}`, {
      data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
    });
    expect(patch.ok()).toBeTruthy();

    // Seed an AVAILABLE 2-BR property to broadcast from (so the composer pre-fills a
    // 2-BR audience that catches both tenants).
    const landlord = 'contact-landlord-0001';
    const created = await page.request.post(`${NEXT}/api/units`, {
      data: {
        landlordId: landlord,
        jurisdiction: 'atlanta_housing',
        beds: 2,
        rent_min: 1500,
        rent_max: 1600,
        address: { line1: `${stamp} Consent Fence Way NW`, city: 'Atlanta', state: 'GA', zip: '30314' },
      },
    });
    expect(created.ok()).toBeTruthy();
    const unitId = (await created.json()).unit.unitId as string;
    const pub = await page.request.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
      data: { toStatus: 'available', source: 'manual' },
    });
    expect(pub.ok()).toBeTruthy();

    // Compose from the property → 2-BR audience pre-filled → Preview.
    await page.goto(`${NEXT}/broadcasts/new?unitId=${unitId}`);
    await expect(page.getByRole('heading', { name: 'Send a property' })).toBeVisible();
    const body = `Open house ${stamp} — 2BR available.`;
    await page.getByLabel('Message').fill(body);
    const previewBtn = page.getByRole('button', { name: 'Preview recipients' });
    await expect(previewBtn).toBeEnabled({ timeout: 15_000 });
    await previewBtn.click();
    await expect(page.getByRole('heading', { name: 'Review recipients' })).toBeVisible();

    const list = page.getByRole('list', { name: 'Candidate recipients' });
    const noConsentRow = list.locator('li', { hasText: noConsent.firstName });
    // The no-consent row is BADGED + its checkbox is unchecked and DISABLED (hard fence).
    await expect(noConsentRow.getByText('consent not recorded — fix before sending')).toBeVisible();
    const noConsentBox = noConsentRow.getByRole('checkbox');
    await expect(noConsentBox).not.toBeChecked();
    await expect(noConsentBox).toBeDisabled();
    // And the count treatment surfaces (role=status), covering the "record consent to include" prompt.
    await expect(page.getByRole('status')).toContainText(/without recorded consent/i);

    // The consented tenant IS a checked candidate.
    const consentedRow = list.locator('li', { hasText: consented.firstName });
    await expect(consentedRow.getByRole('checkbox')).toBeChecked();

    // Send → lands on Results. (The UI posts ONLY the checked contactIds, so the
    // disabled no-consent row is simply never submitted — the composer is the
    // exclusion. The fan-out's skipped_no_consent counter is exercised separately
    // below via the filter-resolve send path.)
    await page.getByRole('button', { name: /^Send to/ }).click();
    await expect(page).toHaveURL(/\/broadcasts\/[A-Za-z0-9_-]+$/, { timeout: 15_000 });

    // The no-consent tenant got NO outbound; the consented one did.
    await expect
      .poll(
        async () => {
          const threads = await listThreads(request);
          const t = threads.find((x) => x.partyNumber === consented.phone);
          return t?.messages.some((m) => m.direction === 'outbound' && (m.body ?? '').includes(body)) ?? false;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    const noConsentGotIt = (await listThreads(request))
      .find((x) => x.partyNumber === noConsent.phone)
      ?.messages.some((m) => m.direction === 'outbound' && (m.body ?? '').includes(body));
    expect(noConsentGotIt ?? false).toBe(false);

    // Recording consent RE-INCLUDES them: a fresh preview now shows the tenant checkable.
    const patch2 = await page.request.patch(`${NEXT}/api/contacts/${noConsent.contactId}`, {
      data: { consent_method: 'paper_form', consent_at: new Date().toISOString() },
    });
    expect(patch2.ok()).toBeTruthy();
    await page.goto(`${NEXT}/broadcasts/new?unitId=${unitId}`);
    await page.getByLabel('Message').fill(`Re-include ${stamp}`);
    const previewBtn2 = page.getByRole('button', { name: 'Preview recipients' });
    await expect(previewBtn2).toBeEnabled({ timeout: 15_000 });
    await previewBtn2.click();
    await expect(page.getByRole('heading', { name: 'Review recipients' })).toBeVisible();
    const reListRow = page
      .getByRole('list', { name: 'Candidate recipients' })
      .locator('li', { hasText: noConsent.firstName });
    await expect(reListRow.getByRole('checkbox')).toBeEnabled();
    await expect(reListRow.getByText('consent not recorded — fix before sending')).toHaveCount(0);
  });

  test('the fan-out fence counts skipped_no_consent when the audience is filter-resolved (no explicit selection)', async ({
    page,
    request,
  }) => {
    // The composer posts an EXPLICIT selection (checked ids), so the excluded row
    // never reaches the fan-out. The filter-resolve send path (no recipientContactIds)
    // re-resolves the WHOLE audience at send time and the fan-out fences no-consent
    // recipients there → skipped_no_consent. Drive that path via the API.
    await devLogin(page);
    const stamp = `${Date.now()}`.slice(-6);
    // Unique housing authority so this broadcast's audience is EXACTLY our two tenants.
    const authority = `a2pfence_${stamp}`;
    const consented = await createContact(page.request, { firstName: `FenceYes${stamp}`, voucherSize: 2 });
    const noConsent = await createContact(page.request, { firstName: `FenceNo${stamp}`, voucherSize: 2 });
    await registerParty(request, { label: consented.firstName, role: 'tenant', number: consented.phone });
    await registerParty(request, { label: noConsent.firstName, role: 'tenant', number: noConsent.phone });
    // Put both tenants in the unique housing authority + consent only the first.
    for (const id of [consented.contactId, noConsent.contactId]) {
      const r = await page.request.patch(`${NEXT}/api/contacts/${id}`, { data: { housingAuthority: authority } });
      expect(r.ok()).toBeTruthy();
    }
    const grant = await page.request.patch(`${NEXT}/api/contacts/${consented.contactId}`, {
      data: { consent_method: 'verbal_phone', consent_at: new Date().toISOString() },
    });
    expect(grant.ok()).toBeTruthy();

    // Create a draft targeting that housing authority + 2-BR, then SEND with NO
    // explicit selection → the fan-out re-resolves the audience and fences no-consent.
    const draft = await page.request.post(`${NEXT}/api/broadcasts`, {
      data: {
        body_template: `Fence check ${stamp} — [TenantName]`,
        audience_filter: { contact_type: 'tenant', housing_authority: authority, bedroomSize: 2 },
      },
    });
    expect(draft.ok()).toBeTruthy();
    const broadcastId = (await draft.json()).broadcastId as string;
    const send = await page.request.post(`${NEXT}/api/broadcasts/${broadcastId}/send`, { data: {} });
    expect(send.ok()).toBeTruthy();

    // The fan-out records skipped_no_consent for the no-consent tenant and sends the
    // consented one (the consented tenant's outbound lands in their fake thread).
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${NEXT}/api/broadcasts/${broadcastId}/results`);
          if (!res.ok()) return -1;
          return ((await res.json()).stats?.skipped_no_consent as number) ?? -1;
        },
        { timeout: 15_000 },
      )
      .toBe(1);
    await expect
      .poll(
        async () => {
          const t = (await listThreads(request)).find((x) => x.partyNumber === noConsent.phone);
          // The no-consent tenant NEVER receives the broadcast body.
          return t?.messages.some((m) => m.direction === 'outbound' && (m.body ?? '').includes(stamp)) ?? false;
        },
        { timeout: 5_000 },
      )
      .toBe(false);
  });
});

// =====================================================================
// §8.4 / §8.5 — every keyword honored + STOP/HELP copy matches filed strings
// =====================================================================
test.describe('A2P §8.4/§8.5 — self-managed STOP / HELP / opt-in keyword replies', () => {
  // Assert digit-free HELP by rejecting any run of 3+ digits (a phone-number-shaped
  // run); the filed HELP copy contains none.
  function hasPhoneNumber(s: string): boolean {
    return /\d{3,}/.test(s);
  }

  for (const keyword of OPT_OUT_KEYWORDS) {
    test(`opt-out keyword "${keyword}" → sms_opt_out set + STOP_CONFIRMATION reply`, async ({
      page,
      request,
    }) => {
      // A fresh contact via an initial inbound so it exists + is primary-number scoped.
      const phone = uniquePhone();
      await registerParty(request, { label: `Out${keyword}`, role: 'tenant', number: phone });
      // Seed the contact first with a benign inbound (auto-capture).
      await sendAsParty(request, { from: phone, to: APP_NUMBER, body: 'hello there' });

      // Now post the opt-out keyword DIRECTLY and read the TwiML reply.
      const { status, body } = await postInboundSms(request, {
        from: phone,
        body: keyword,
        messageSid: uniqueSid(`out${keyword}`),
      });
      expect(status).toBe(200);
      // The TwiML <Message> reply (XML-unescaped) is EXACTLY the filed STOP copy.
      expect(twimlMessageBody(body)).toBe(STOP_CONFIRMATION);

      // The contact's sms_opt_out flag is set (primary-number opt-out).
      await devLogin(page);
      await expect
        .poll(
          async () => {
            const res = await page.request.get(`${NEXT}/api/contacts?phone=${encodeURIComponent(phone)}`);
            if (!res.ok()) return undefined;
            return ((await res.json()).contacts[0] as { sms_opt_out?: boolean } | undefined)?.sms_opt_out;
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    });
  }

  for (const keyword of OPT_IN_KEYWORDS) {
    test(`opt-in keyword "${keyword}" → suppression cleared + WELCOME_SMS + consent stamped`, async ({
      page,
      request,
    }) => {
      const phone = uniquePhone();
      await registerParty(request, { label: `In${keyword}`, role: 'tenant', number: phone });
      // Seed + opt OUT first (so opt-in has suppression to clear), then read state.
      await sendAsParty(request, { from: phone, to: APP_NUMBER, body: 'hi' });
      await postInboundSms(request, { from: phone, body: 'STOP', messageSid: uniqueSid(`inpre${keyword}`) });

      // Now the opt-in keyword → WELCOME_SMS TwiML reply.
      const { status, body } = await postInboundSms(request, {
        from: phone,
        body: keyword,
        messageSid: uniqueSid(`in${keyword}`),
      });
      expect(status).toBe(200);
      expect(twimlMessageBody(body)).toBe(WELCOME_SMS);

      // Suppression cleared + consent stamped (inbound_text) on the contact.
      await devLogin(page);
      await expect
        .poll(
          async () => {
            const res = await page.request.get(`${NEXT}/api/contacts?phone=${encodeURIComponent(phone)}`);
            if (!res.ok()) return undefined;
            const c = (await res.json()).contacts[0] as
              | { sms_opt_out?: boolean; consent_method?: string }
              | undefined;
            return c ? { optOut: c.sms_opt_out === true, consent: c.consent_method } : undefined;
          },
          { timeout: 10_000 },
        )
        .toEqual({ optOut: false, consent: 'inbound_text' });
    });
  }

  test('HELP → filed HELP_REPLY with NO phone number in the body', async ({ request }) => {
    const phone = uniquePhone();
    await registerParty(request, { label: 'Helper', role: 'tenant', number: phone });
    await sendAsParty(request, { from: phone, to: APP_NUMBER, body: 'hi' });

    const { status, body } = await postInboundSms(request, {
      from: phone,
      body: 'HELP',
      messageSid: uniqueSid('help'),
    });
    expect(status).toBe(200);
    // Exact filed HELP copy (XML-unescaped from the TwiML reply)…
    const replyBody = twimlMessageBody(body);
    expect(replyBody).toBe(HELP_REPLY);
    // …and it carries NO phone number (the campaign declares phone-numbers = No) —
    // assert against BOTH the filed constant and the ACTUAL reply body.
    expect(hasPhoneNumber(HELP_REPLY)).toBe(false);
    expect(hasPhoneNumber(replyBody ?? '')).toBe(false);
  });

  test('a non-keyword inbound gets an EMPTY TwiML ack (no <Message> reply)', async ({ request }) => {
    const phone = uniquePhone();
    await registerParty(request, { label: 'Chatter', role: 'tenant', number: phone });
    const { status, body } = await postInboundSms(request, {
      from: phone,
      body: 'what homes do you have?',
      messageSid: uniqueSid('plain'),
    });
    expect(status).toBe(200);
    expect(body).not.toContain('<Message>');
    expect(body).toContain('<Response/>');
  });
});

// =====================================================================
// §8.6 — Template floor: stripping opt-out language is rejected
// =====================================================================
test.describe('A2P §8.6 — first-contact template opt-out floor', () => {
  test('a settings PUT that drops the opt-out line from a first-contact template → 400 missing_opt_out_language', async ({
    page,
  }) => {
    // Admin session (founder@example.com → admin) so the PUT is authorized.
    const login = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email: 'founder@example.com' } });
    expect(login.ok()).toBeTruthy();

    // missedCallAutoText WITHOUT "STOP" → rejected.
    const badMissed = await page.request.put(`${NEXT}/api/settings`, {
      data: { missedCallAutoText: 'Sorry we missed your call! Text us back.' },
    });
    expect(badMissed.status()).toBe(400);
    expect((await badMissed.json()).error).toBe('missing_opt_out_language');

    // welcomeText WITHOUT "STOP" → rejected too.
    const badWelcome = await page.request.put(`${NEXT}/api/settings`, {
      data: { welcomeText: 'Welcome! Come find a home with us.' },
    });
    expect(badWelcome.status()).toBe(400);
    expect((await badWelcome.json()).error).toBe('missing_opt_out_language');

    // A template that KEEPS the opt-out line is accepted (control) — then restore a
    // compliant default so we don't leave a mutated template for cross-spec reads.
    const good = await page.request.put(`${NEXT}/api/settings`, {
      data: { missedCallAutoText: `${SMS_BRAND_NAME}: Sorry we missed your call! Reply STOP to opt out.` },
    });
    expect(good.ok()).toBeTruthy();
  });
});
