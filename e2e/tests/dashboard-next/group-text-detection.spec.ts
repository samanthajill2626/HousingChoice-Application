import { test, expect, type Page } from '@playwright/test';
import { registerParty, sendGroupAsParty } from '../../fixtures/fakeTwilio.js';
import { conversationIdForGroup, contactIdForPhone } from '../../../app/src/lib/import/ids.js';

// SPEC 1 - a carrier group text becomes a GROUP THREAD, and confers no consent.
//
// This is the feature's front door: an inbound that looks exactly like a 1:1
// except for one undocumented set of form params (`OtherRecipients`). Three
// things have to be true at once and each has bitten a design before:
//   * the message files on a MULTI-PARTY thread, not on the sender's 1:1 - a
//     group message filed 1:1 shows one person saying things to us that they
//     said to a room;
//   * the SILENT members (everyone who did not send) get a contact record but
//     NO consent - being named on someone else's group text is not permission
//     to text you, and the JIT gate must still refuse;
//   * the SENDER does get consent, by the ordinary inbound-text rule - they
//     genuinely texted us.
//
// The roster is From + OtherRecipients (the business number is excluded), and
// the conversationId is uuidv5 over that sorted roster - derived here the same
// way the app derives it, so the spec addresses the thread the app created
// rather than hunting for it.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

// Seeded lean contacts. Tasha carries inbound_text consent; Renee deliberately
// carries NONE (she has no thread with us) - the seed says so out loud.
const TASHA = '+15550100001';
const RENEE = '+15550100003';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

test('a carrier group MMS files as a group thread; silent members gain no consent', async ({
  page,
  request,
}) => {
  const stamp = `${Date.now()}`.slice(-6);
  // A number nobody has ever seen: its contact record will exist ONLY because
  // of this group text, which is what makes the consent assertion below mean
  // something rather than restate a pre-existing state.
  const STRANGER = `+1555078${stamp.slice(-4)}`;
  const body = `Walking the unit together ${stamp}`;
  const conversationId = conversationIdForGroup([TASHA, RENEE, STRANGER]);

  await registerParty(request, { label: `Tasha ${stamp}`, role: 'tenant', number: TASHA });
  await sendGroupAsParty(request, {
    from: TASHA,
    otherRecipients: [RENEE, STRANGER],
    body,
  });

  await devLogin(page);

  // 1) It is in the inbox, under the Groups filter, as a GROUP TEXT - not a
  //    relay group, whose chip is a different word for a different product.
  await page.goto(`${NEXT}/inbox?filter=groups`);
  const row = page.getByRole('link', { name: /^With Tasha & Renee/ });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Group text').first()).toBeVisible();

  // 2) The thread itself: members visible, and the unmasked reality said out
  //    loud (nobody is behind a pool number here).
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/conversations/${conversationId}$`));
  await expect(
    page.getByText(/Everyone in this group text sees everyone's real number/),
  ).toBeVisible();
  const members = page.getByRole('list', { name: 'Group members' });
  await expect(members.getByRole('listitem')).toHaveCount(3);
  await expect(page.getByText(body)).toBeVisible();

  // 3) NOT filed as a 1:1. The sender's own contact timeline must not carry the
  //    group body - a multi-party message pulled into a 1:1 view misattributes
  //    what was said to a room.
  await page.goto(`${NEXT}/contacts/contact-tenant-0001`);
  // The Group threads card is the load anchor AND the point: the group is
  // reachable from her contact page, it just is not IN her 1:1 timeline.
  await expect(page.getByRole('heading', { name: 'Group threads' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(body)).toHaveCount(0);

  // 4) THE CONSENT ASYMMETRY, proven through the real proactive gate rather
  //    than by reading a field. The stranger exists as a contact only because
  //    they were named on this group text, and a proactive send to them is
  //    still hard-blocked - the just-in-time gate opens its consent modal
  //    instead of sending.
  await page.goto(`${NEXT}/contacts/${contactIdForPhone(STRANGER)}`);
  const composer = page.getByRole('textbox', { name: 'Reply message' });
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill(`proactive attempt ${stamp}`);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('dialog', { name: 'Record consent before texting' })).toBeVisible({
    timeout: 15_000,
  });

  // 5) ...while the SENDER, who genuinely texted us, can be replied to with no
  //    gate at all. Same group, same instant, opposite outcome - that contrast
  //    IS the ruling.
  await page.goto(`${NEXT}/contacts/contact-tenant-0001`);
  const senderComposer = page.getByRole('textbox', { name: 'Reply message' });
  await expect(senderComposer).toBeVisible({ timeout: 15_000 });
  await senderComposer.fill(`reply to the sender ${stamp}`);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('dialog', { name: 'Record consent before texting' })).toHaveCount(0);
  await expect(page.getByText(`reply to the sender ${stamp}`)).toBeVisible({ timeout: 15_000 });
});
