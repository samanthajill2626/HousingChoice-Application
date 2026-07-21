import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { Scenario } from '../../scenarios/steps.js';
import { resetMail } from '../../fixtures/fakeEmail.js';
import { dashboardUrl } from '../../support/urls.js';

// Outbound email (email-channel v1, A7) - compose + send email from a contact page
// via the fake-SES surface, end to end against the hermetic lane stack:
//   dev-login -> open the seeded landlord (Marcus Bell, has an email in lean seed)
//   -> flip the [Text | Email] channel toggle -> subject + body + one image
//   attachment -> Send email -> the timeline shows the EmailCard (EMAIL tag +
//   subject + Sent chip) AND the fake-SES store recorded the send with the To /
//   Subject headers + the attachment content-type in the raw MIME.
// The B8 matrix adds inbound + triage + bounce; this is the one focused outbound flow.
const NEXT = dashboardUrl;

// The tiny valid PNG fixture the file picker uploads (a real file is required; the
// app reads its bytes back from MinIO and embeds them in the SES raw MIME).
const FIXTURE_PNG = fileURLToPath(new URL('../../fixtures/tiny.png', import.meta.url));

// Seeded landlord (app/src/lib/seed/lean.ts): has BOTH a primary email and the
// email channel toggle on his contact page. No seeded conversation - the first
// email send creates the 1:1 (ensureContactConversation) before it attaches.
const MARCUS_ID = 'contact-landlord-0001';
const MARCUS_EMAIL = 'marcus.bell@example.com';

test.describe('Outbound email - contact composer', () => {
  test('compose + send an email with an image attachment: EmailCard + fake-SES record', async ({
    page,
    request,
  }) => {
    const flow = new Scenario(page, request);
    // Hermetic: the SMS /control/reset does NOT clear mail (separate engine), so
    // clear the fake-SES store explicitly before this run's send.
    await resetMail(request);

    await flow.login();
    await page.goto(`${NEXT}/contacts/${MARCUS_ID}`);

    // Flip the composer to Email (Marcus has an address, so the segment swaps in the
    // EmailComposer). Scope to the toggle group so the tag "EMAIL" never matches.
    const channel = page.getByRole('group', { name: 'Message channel' });
    await expect(channel).toBeVisible({ timeout: 15_000 });
    await channel.getByRole('button', { name: 'Email' }).click();

    // Compose. To defaults to Marcus's primary address. Subject + body are required
    // for Send to arm; 'Message' is exact so it can't match the SMS "Reply message".
    await page.getByLabel('Subject').fill('Welcome');
    await page.getByLabel('Message', { exact: true }).fill('Welcome to Housing Choice - details attached.');

    // Attach the PNG via the (visually hidden) file input, then wait for the upload
    // to finish - Send re-enables only when nothing is uploading and fields are set.
    await page.locator('#email-attach-input').setInputFiles(FIXTURE_PNG);
    const sendBtn = page.getByRole('button', { name: 'Send email' });
    await expect(sendBtn).toBeEnabled({ timeout: 20_000 });
    await sendBtn.click();

    // (i) The timeline renders the outbound EmailCard: the "EMAIL" transport tag
    //     (exact, so it never matches the "Email" toggle), the subject, and - once
    //     the optimistic 'queued' card reconciles to the persisted send - a "Sent"
    //     delivery chip.
    const timeline = page.getByRole('region', { name: 'Communications and activity' });
    await expect(timeline.getByText('EMAIL', { exact: true })).toBeVisible({ timeout: 20_000 });
    // Subject is `exact` so it matches the subject span, not the body snippet (which
    // begins "Welcome to Housing Choice ...").
    await expect(timeline.getByText('Welcome', { exact: true })).toBeVisible();
    await expect(timeline.getByText('Sent', { exact: true })).toBeVisible({ timeout: 20_000 });

    // (ii) Proof-of-send: the fake-SES store captured the send to Marcus with a
    //      subject matching /Welcome/. expectEmailSentTo returns the matched record.
    const email = await flow.expectEmailSentTo(MARCUS_EMAIL, /Welcome/);

    // (iii) The record's parsed To carries the seeded address, and the raw MIME the
    //       app POSTed carries the Subject header, the To address, and the attachment
    //       content-type (image/png) - proof the attachment rode along in the MIME.
    expect(email.to).toContain(MARCUS_EMAIL);
    expect(email.subject).toBe('Welcome');
    expect(email.rawMime).toContain('Subject: Welcome');
    expect(email.rawMime).toContain(MARCUS_EMAIL);
    expect(email.rawMime).toContain('image/png');
  });
});
