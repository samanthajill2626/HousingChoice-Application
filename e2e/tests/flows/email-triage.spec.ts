import { test, expect } from '@playwright/test';
import { Scenario } from '../../scenarios/steps.js';
import { resetMail } from '../../fixtures/fakeEmail.js';
import { reseed } from '../../fixtures/reseed.js';
import { dashboardUrl } from '../../support/urls.js';

// Email triage (email-channel v1, B8 matrix items 3, 4, 5) - inbound email from
// UNKNOWN senders never becomes a contact/conversation (spec Decision 4); it lands
// in the /email side-door surface. Staff act on it in the REAL dashboard:
//   3. Unknown sender, no token -> the Email nav badge increments, a row in the
//      Unmatched tab, and NOTHING in the general inbox or Today; Link-to-contact via
//      the modal typeahead moves it into that contact's timeline + adds the address.
//   4. spamVerdict FAIL from an unknown sender -> Quarantine tab only; Release moves
//      it back to Unmatched.
//   5. A script-bearing HTML email renders INERT - a fully sandboxed, CSP-locked
//      iframe, no dialog, and the script payload nowhere on the page - on BOTH the
//      unmatched-triage detail AND (now that B8 scope-1 landed the serializer line)
//      the contact-timeline EmailCard.
const NEXT = dashboardUrl;

// Seeded personas (app/src/lib/seed/lean.ts): Tasha the tenant (link target) and
// Marcus the landlord (known-sender timeline variant).
const TASHA_ID = 'contact-tenant-0001';
const MARCUS_ID = 'contact-landlord-0001';
const MARCUS_EMAIL = 'marcus.bell@example.com';

// A script-bearing HTML body: a <script> and an onerror <img>. sanitize-html strips
// both at ingest; the sandbox="" iframe + the CSP inside its srcDoc are defense in
// depth. The two payload strings must appear NOWHERE on the rendered page.
const SCRIPT_HTML =
  "<p>Totally legit message, click here.</p>" +
  "<script>alert('xss-pwned')</script>" +
  '<img src="x" onerror="alert(\'xss-img\')">';

test.describe('Email triage - unmatched, quarantine, and inert HTML', () => {
  test.beforeEach(async ({ request }) => {
    await reseed(request);
    await resetMail(request);
  });

  test('unknown sender -> Unmatched (badge, not inbox, not Today); Link-to-contact threads it + adds the address', async ({
    page,
    request,
  }) => {
    const flow = new Scenario(page, request);
    await flow.login();

    const STRANGER = 'stranger.caller@outside.example.com';
    await flow.partnerEmailsIn(STRANGER, 'Question about a listing', 'Saw your flyer - is anything open?');

    // (a) The Email nav badge increments (unmatched-unread), and the sender is NOT in
    //     the general inbox (Decision 4).
    await page.goto(`${NEXT}/inbox`);
    const emailNav = page
      .getByRole('navigation', { name: 'Communications' })
      .getByRole('link', { name: 'Email' });
    await expect(emailNav).toBeVisible({ timeout: 15_000 });
    await expect(
      emailNav.locator('xpath=following-sibling::span[contains(@aria-label, "unread")]'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/stranger\.caller/)).toHaveCount(0);

    // (b) Nothing shows up in Today either.
    await page.goto(`${NEXT}/`);
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/stranger\.caller/)).toHaveCount(0);

    // (c) The row IS in the Unmatched tab.
    await flow.expectUnmatchedRow(/stranger\.caller/);

    // (d) Link-to-contact: pick Tasha in the committed-state typeahead, link. The row
    //     actions are pointer-events:none until the row is hovered (revealed on
    //     hover / focus-within), so hover the row first.
    const strangerRow = page.getByRole('listitem').filter({ hasText: /stranger\.caller/ });
    await strangerRow.hover();
    await strangerRow.getByRole('button', { name: 'Link to contact' }).click();
    const dialog = page.getByRole('dialog', { name: 'Link to contact' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Search contacts' }).fill('Tasha');
    await dialog.getByRole('option', { name: /Tasha/ }).click();
    await dialog.getByRole('button', { name: 'Link', exact: true }).click();

    // (e) It lands in Tasha's timeline (re-ingested into her thread) AND her contact
    //     now carries the sender's address (a To option in the email composer).
    await page.waitForURL(`**/contacts/${TASHA_ID}`, { timeout: 15_000 });
    await flow.expectEmailInTimeline(/Question about a listing/);
    await page.getByRole('group', { name: 'Message channel' }).getByRole('button', { name: 'Email' }).click();
    await expect(page.getByLabel('To').locator('option', { hasText: STRANGER })).toHaveCount(1);
  });

  test('spamVerdict FAIL from an unknown sender -> Quarantine only; Release moves it to Unmatched', async ({
    page,
    request,
  }) => {
    const flow = new Scenario(page, request);
    await flow.login();

    const SPAMMER = 'promo@spam.example.com';
    await flow.partnerEmailsIn(SPAMMER, 'You are pre-approved', 'Act now for a limited-time deal.', {
      spamVerdict: 'FAIL',
    });

    // NOT in the Unmatched tab.
    await page.goto(`${NEXT}/email`);
    await expect(page.getByRole('heading', { name: 'Email', level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/promo@spam/)).toHaveCount(0);

    // IS in the Quarantine tab, tagged "Spam".
    await page.goto(`${NEXT}/email/quarantine`);
    const qlist = page.getByRole('list', { name: 'Quarantined email' });
    await expect(qlist).toBeVisible({ timeout: 15_000 });
    const qrow = qlist.getByRole('listitem').filter({ hasText: /promo@spam/ });
    await expect(qrow).toBeVisible();
    await expect(qrow.getByText('Spam', { exact: true })).toBeVisible();

    // Release -> the row moves back to Unmatched. Row actions are pointer-events:none
    // until hover (revealed on hover / focus-within), so hover the row first.
    await qrow.hover();
    await qrow.getByRole('button', { name: 'Release' }).click();
    await flow.expectUnmatchedRow(/promo@spam/);
  });

  test('script-bearing HTML from an unknown sender renders inert in the triage detail', async ({
    page,
    request,
  }) => {
    // Record any dialog the payload might try to raise; assert none fired.
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });

    const flow = new Scenario(page, request);
    await flow.login();

    const EVIL = 'attacker@evil.example.com';
    await flow.partnerEmailsIn(EVIL, 'You won a prize', 'plain-text fallback body', { html: SCRIPT_HTML });

    // Open the unmatched row, then the sandboxed HTML frame.
    await page.goto(`${NEXT}/email`);
    const row = page.getByRole('listitem').filter({ hasText: /attacker@evil/ });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByText('You won a prize').click(); // the header button toggles the detail
    const summary = page.getByText('View original formatting');
    await expect(summary).toBeVisible({ timeout: 15_000 });
    await summary.click();

    const frame = page.getByTitle('Email message');
    await expect(frame).toBeVisible({ timeout: 10_000 });
    await expect(frame).toHaveAttribute('sandbox', '');
    // Inert: no dialog fired, and neither script payload string is anywhere on the
    // page (sanitize-html stripped <script> + onerror at ingest).
    await expect(page.getByText('xss-pwned')).toHaveCount(0);
    await expect(page.getByText('xss-img')).toHaveCount(0);
    expect(dialogs).toEqual([]);
  });

  test('script-bearing HTML from a known sender renders inert in the contact timeline (scope-1 payoff)', async ({
    page,
    request,
  }) => {
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });

    const flow = new Scenario(page, request);
    await flow.login();

    // A KNOWN sender (Marcus) emails HTML in -> threads onto his contact. The B8
    // scope-1 serializer line carries email_html_sanitized to the contact timeline,
    // so his EmailCard can mount the sandboxed frame.
    await flow.partnerEmailsIn(MARCUS_EMAIL, 'Formatted reply attached', 'plain-text fallback body', {
      html: SCRIPT_HTML,
    });

    await page.goto(`${NEXT}/contacts/${MARCUS_ID}`);
    await flow.expectEmailInTimeline(/Formatted reply attached/);

    const timeline = page.getByRole('region', { name: 'Communications and activity' });
    const summary = timeline.getByText('View original formatting');
    await expect(summary).toBeVisible({ timeout: 15_000 });
    await summary.click();

    const frame = timeline.getByTitle('Email message');
    await expect(frame).toBeVisible({ timeout: 10_000 });
    await expect(frame).toHaveAttribute('sandbox', '');
    await expect(page.getByText('xss-pwned')).toHaveCount(0);
    await expect(page.getByText('xss-img')).toHaveCount(0);
    expect(dialogs).toEqual([]);
  });
});
