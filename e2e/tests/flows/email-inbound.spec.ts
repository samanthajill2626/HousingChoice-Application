import { test, expect } from '@playwright/test';
import { Scenario } from '../../scenarios/steps.js';
import { resetMail, emailDeliveryOutcome } from '../../fixtures/fakeEmail.js';
import { reseed } from '../../fixtures/reseed.js';
import { dashboardUrl } from '../../support/urls.js';

// Inbound email (email-channel v1, B8 matrix items 1, 2, 6) - a known/new sender
// emails IN through the fake-SES inbound seam (MIME -> MinIO -> SNS-shaped POST to
// /webhooks/ses/inbound), and staff act on it in the REAL dashboard:
//   1. Known landlord emails in -> his contact timeline (EmailCard + subject), his
//      inbox row shows channel "Email" + an unread badge; staff reply threads back
//      (Reply-To: relay+<token> - the system's threading anchor).
//   2. A reply from a NEW address to that relay+token address lands in the SAME
//      thread with a "New address" chip.
//   6. A permanent bounce flips the send's chip to "Undelivered" and suppresses the
//      next send (409 email_suppressed -> friendly copy).
//
// Matrix item 7 (outbound WITH an attachment, re-verified post-Phase-B) is NOT
// duplicated here: it is covered by tests/flows/email-outbound.spec.ts (the A7
// spec), which runs in the SAME filtered batch as this file - re-running it green
// against the full Phase-B tree IS the post-B re-verification. See the B8 report.
//
// THREADING NOTE (matrix 1): the plan's matrix asks the staff reply to carry
// In-Reply-To. The shipped A5 send service (sendEmailMessage.ts) does NOT populate
// In-Reply-To/References (the adapter composeRawMime supports both - the service
// never sets them), so the system threads via the Reply-To: relay+<token> header
// instead (proven end-to-end by matrix item 2's round-trip). This spec asserts that
// real threading anchor; the outbound In-Reply-To gap is reported as an A5 follow-up
// in the B8 report (not "bent" - the Reply-To token is the threading mechanism this
// system ships).
const NEXT = dashboardUrl;

// Seeded landlord (app/src/lib/seed/lean.ts): Marcus Bell has a primary email and
// NO seeded conversation - an inbound from him (tier 6 findByEmail) creates his
// email thread; an outbound send does the same.
const MARCUS_ID = 'contact-landlord-0001';
const MARCUS_EMAIL = 'marcus.bell@example.com';

test.describe('Inbound email - contact timeline, threading, and bounce', () => {
  test.beforeEach(async ({ request }) => {
    // Clean slate per test: reseed clears the app DB (incl. unmatched_email +
    // messages); resetMail clears the fake-SES outbound store so listEmails[0] is
    // this test's send.
    await reseed(request);
    await resetMail(request);
  });

  test('known landlord emails in -> timeline EmailCard, inbox Email row + unread, staff reply threads', async ({
    page,
    request,
  }) => {
    const flow = new Scenario(page, request);
    await flow.login();

    // (1) Marcus (a known contact) emails in. Tier-6 findByEmail threads it onto his
    //     contact, creating his email conversation.
    const subject = 'Following up on 1450 Boone';
    await flow.partnerEmailsIn(MARCUS_EMAIL, subject, 'Is the unit still open? Please advise.');

    // (2) Inbox: Marcus's row shows the "Email" channel label + an unread badge
    //     (the inbound bumped unread). Asserted BEFORE opening his contact, because
    //     opening the contact marks the thread read.
    await page.goto(`${NEXT}/inbox`);
    const marcusRow = page.getByRole('listitem').filter({ hasText: 'Marcus Bell' });
    await expect(marcusRow).toBeVisible({ timeout: 15_000 });
    await expect(marcusRow.getByText('Email', { exact: true })).toBeVisible();
    await expect(marcusRow.locator('[aria-label$="unread"]')).toBeVisible();

    // (3) Contact timeline: the inbound EmailCard with its subject.
    await page.goto(`${NEXT}/contacts/${MARCUS_ID}`);
    await flow.expectEmailInTimeline(/Following up on 1450 Boone/);

    // (4) Staff replies from the Email composer -> the claim arbiter threads it into
    //     the SAME conversation (the To address is already claimed by his thread).
    const channel = page.getByRole('group', { name: 'Message channel' });
    await expect(channel).toBeVisible({ timeout: 15_000 });
    await channel.getByRole('button', { name: 'Email' }).click();
    await page.getByLabel('Subject').fill('Re: 1450 Boone tour');
    await page.getByLabel('Message', { exact: true }).fill('Yes - it is available. Want to tour Saturday?');
    await page.getByRole('button', { name: 'Send email' }).click();

    const timeline = page.getByRole('region', { name: 'Communications and activity' });
    await expect(timeline.getByText('Re: 1450 Boone tour', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(timeline.getByText('Sent', { exact: true })).toBeVisible({ timeout: 20_000 });

    // (5) Threading proof: the outbound reply carries Reply-To: relay+<token> - the
    //     anchor an inbound reply comes back on (matrix 2 proves that round-trip).
    const reply = await flow.expectEmailSentTo(MARCUS_EMAIL, /Re: 1450 Boone tour/);
    expect(reply.rawMime).toMatch(/Reply-To:\s*relay\+[^@\s]+@mail\.local\.test/i);
  });

  test('a reply from a NEW address to the relay+token thread lands in-thread with a "New address" chip', async ({
    page,
    request,
  }) => {
    const flow = new Scenario(page, request);
    await flow.login();
    await page.goto(`${NEXT}/contacts/${MARCUS_ID}`);

    // Staff sends an outbound email to Marcus -> creates his email thread + an
    // outbound carrying Reply-To: relay+<token>.
    const channel = page.getByRole('group', { name: 'Message channel' });
    await expect(channel).toBeVisible({ timeout: 15_000 });
    await channel.getByRole('button', { name: 'Email' }).click();
    await page.getByLabel('Subject').fill('Your listing at 1450 Boone');
    await page.getByLabel('Message', { exact: true }).fill('Sharing a tenant who is interested.');
    await page.getByRole('button', { name: 'Send email' }).click();
    await expect(
      page.getByRole('region', { name: 'Communications and activity' }).getByText('Sent', { exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    // Harvest the relay+token address from the outbound's Reply-To header.
    const outbound = await flow.expectEmailSentTo(MARCUS_EMAIL, /Your listing/);
    const match = outbound.rawMime.match(/Reply-To:\s*(relay\+[^@\s]+@mail\.local\.test)/i);
    expect(match, 'outbound Reply-To must carry a relay+token address').not.toBeNull();
    const relayAddress = match![1]!;

    // A NEW (unknown) address replies TO that relay+token address -> tier-5a token
    // routing threads it into Marcus's conversation, flagged email_new_address (the
    // From-address is not on his contact).
    const NEW_ADDRESS = 'assistant.newdesk@example.net';
    await flow.partnerEmailsIn(NEW_ADDRESS, 'Re: Your listing at 1450 Boone', 'Marcus asked me to reply for him.', {
      to: [relayAddress],
    });

    // Marcus's timeline: the inbound is in-thread AND carries the "New address" chip.
    await page.goto(`${NEXT}/contacts/${MARCUS_ID}`);
    const timeline = page.getByRole('region', { name: 'Communications and activity' });
    await expect(async () => {
      await page.reload();
      await expect(timeline.getByText('New address').first()).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    await expect(timeline.getByText(/Re: Your listing at 1450 Boone/).first()).toBeVisible();
  });

  test('a permanent bounce marks the send Undelivered and suppresses the next send', async ({ page, request }) => {
    const flow = new Scenario(page, request);
    await flow.login();
    await page.goto(`${NEXT}/contacts/${MARCUS_ID}`);

    // Staff sends an email to Marcus.
    const channel = page.getByRole('group', { name: 'Message channel' });
    await expect(channel).toBeVisible({ timeout: 15_000 });
    await channel.getByRole('button', { name: 'Email' }).click();
    await page.getByLabel('Subject').fill('Welcome packet');
    await page.getByLabel('Message', { exact: true }).fill('Attaching the welcome packet for 1450 Boone.');
    await page.getByRole('button', { name: 'Send email' }).click();
    const sent = await flow.expectEmailSentTo(MARCUS_EMAIL, /Welcome packet/);

    // SES reports a PERMANENT bounce for that send (correlated by its SES MessageId).
    const outcome = await emailDeliveryOutcome(request, {
      sesMessageId: sent.sesMessageId,
      outcome: 'bounce',
      bounceType: 'Permanent',
    });
    expect(outcome.appStatus).toBe(200);

    // The EmailCard's delivery chip flips to "Undelivered" (the dev route applies the
    // bounce synchronously; a reload picks up the persisted status).
    // The chip reads "Undelivered - <reason>" (label + failure reason in one span),
    // so match the label as a substring, not exact.
    const timeline = page.getByRole('region', { name: 'Communications and activity' });
    await expect(async () => {
      await page.reload();
      await expect(timeline.getByText(/Undelivered/).first()).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 30_000 });

    // The permanent bounce set email_unreachable on Marcus -> a subsequent send is
    // refused (409 email_suppressed). The composer surfaces the friendly copy in a
    // role="alert" (distinct from the pre-emptive role="note" suppression hint).
    await page.getByRole('group', { name: 'Message channel' }).getByRole('button', { name: 'Email' }).click();
    await page.getByLabel('Subject').fill('Second attempt');
    await page.getByLabel('Message', { exact: true }).fill('Trying to reach you again.');
    await page.getByRole('button', { name: 'Send email' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /not receiving email/i })).toBeVisible({
      timeout: 15_000,
    });
  });
});
