import { test, expect } from '../../fixtures/auth.js';
import { getOutbox } from '../../fixtures/outbox.js';

// Phase 5 cross-UI proving slice: a tenant submits the PUBLIC housing-fair form
// → the conversation appears in the STAFF dashboard inbox → a staff member opens
// the thread and replies → both the automated welcome and the staff reply are
// recorded in the dev outbox. Spans public UI + staff UI + API + outbox.
// Unique per-run name/phone so the test is independent of prior state.
test('public intake → staff inbox → staff reply → outbox', async ({ page, vaPage, request }) => {
  const stamp = `${Date.now()}`.slice(-7);
  const firstName = `Flowtest${stamp}`;
  const phone = `+1555${stamp}`;
  const reply = `A navigator will help you shortly. [ref ${stamp}]`;

  // 1) Tenant submits the public form (unauthenticated).
  await page.goto('/housing-fair');
  await page.getByLabel('First name').fill(firstName);
  await page.getByLabel('Last name').fill('Tester');
  await page.getByLabel('Phone').fill(phone);
  await page.getByRole('button', { name: 'Sign me up' }).click();
  await expect(page.getByText("Thanks, we'll text you!")).toBeVisible();

  // 2) Staff sees the new conversation in the inbox (the row's preview is the
  //    welcome text, which contains the tenant's first name).
  await vaPage.goto('/');
  const convo = vaPage.getByRole('link').filter({ hasText: firstName });
  await expect(convo.first()).toBeVisible();

  // 3) Open the thread and send a reply.
  await convo.first().click();
  await expect(vaPage).toHaveURL(/\/conversations\//);
  await vaPage.getByRole('textbox', { name: 'Message' }).fill(reply);
  await vaPage.getByRole('button', { name: 'Send' }).click();

  // 4) The reply renders in the thread timeline. NOTE: this is presentational
  //    only — the bubble is appended optimistically before the POST resolves, so
  //    it proves the UI accepted the input, NOT that the message was sent. The
  //    real proof-of-send is step 5 (the outbox row only exists if the messaging
  //    adapter actually ran). Do not remove step 5 thinking step 4 covers it.
  await expect(vaPage.getByRole('log', { name: 'Message timeline' }).getByText(reply)).toBeVisible();

  // 5) PROOF OF SEND: the outbox recorded BOTH the welcome (contains the first
  //    name) and the staff reply, to this tenant's phone.
  await expect
    .poll(async () => (await getOutbox(request, { to: phone })).map((m) => m.body ?? ''), {
      timeout: 10_000,
    })
    .toEqual(
      expect.arrayContaining([expect.stringContaining(firstName), reply]),
    );
});
