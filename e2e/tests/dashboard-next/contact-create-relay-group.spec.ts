import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { clearLogTail } from '../../fixtures/groupText.js';
import { getOutbox } from '../../fixtures/outbox.js';
import { driveConnectingGroupToOpen } from '../../fixtures/relayConnect.js';
// Single source of truth for the relay intro copy (no drift): the spec reads the
// app catalog directly, the same cross-package import tour-roster.spec.ts uses.
import { MESSAGE_CATALOG } from '../../../app/src/messages/catalog.js';

// Start a STANDALONE relay group from a contact file (contact-create-relay-group
// design section 7). Drives the real dashboard + API on the hermetic lane through
// the whole three-state flow the feature adds:
//
//   picking    - the "Relay groups" card action opens the picker modal, seeded
//                with the contact whose page this is; a COMMITTED pick from the
//                "Add member" combobox adds a member row IMMEDIATELY (there is no
//                Add button - the committed pick IS the add).
//   confirming - the picker unmounts and RosterConfirmDialog shows the
//                SERVER-composed relay.intro body plus every recipient by name.
//   connecting - the dialog unmounts and the picker modal re-mounts (SAME title)
//                carrying the unsent-intro notice and a single "Go to the group"
//                link. It does NOT navigate.
//
// THE TIER-3 TRAP: in the hermetic lane every fresh pair lands CONNECTING
// (e2e/fixtures/relayConnect.ts:9-25 - MESSAGING_DRIVER=twilio, spare buffer K=0,
// and the seeded pool numbers are provisioned_via 'console' so the reuse ladder
// skips them). A connecting group has NO number and has sent NO intro, so the
// intro cannot be asserted straight after the create. We assert the connecting
// landing LOUDLY (status + empty pool number, so a group that provisioned
// immediately fails here instead of passing vacuously), then drive the
// connect-when-ready handshake, and only THEN assert the intro fan-out.
//
// ORDERING TRAP: driveConnectingGroupToOpen needs the conversationId while the
// modal is still open - the id only reaches the URL after the link is followed.
// "Go to the group" is a real react-router <Link>, so its href carries the id.
//
// WHY THIS FILE RESEEDS. The group it creates renders an Inbox row named
// "With Tasha Nguyen & Marcus Bell", and four later dashboard-next files address
// Inbox rows with an UNSCOPED getByRole('link', { name: /Tasha Nguyen/ })
// (inbox.spec.ts, inbox-comms.spec.ts, inbox-markread.spec.ts,
// deleted-contact-resurfacing.spec.ts). Files run path-ordered under workers:1,
// and "contact-create-relay-group" sorts before every one of them, so the residue
// would be a strict-mode collision / a broken zero-count in specs this change has
// nothing to do with. The beforeEach reseed is ALSO the tier-3 precondition (a
// fresh lean world has no reusable twilio-provisioned active number), and the
// afterAll reseed restores the byte-stable lean baseline the rest of the suite
// expects - this file may not run last.
//
// AND WHY IT CLEARS THE LOG RING. Creating ANY relay group fires the opportunistic
// stuck-sweep in poolNumbers.provisionForGroup, and `flagStuckConnecting`
// (poolNumbers.ts:484-499) log.ERRORs one line per connecting group older than
// relayWarmingMaxWaitMs. The LEAN SEED ships exactly such a group (lean.ts:247-269 -
// an imported relay group that never gets a number), so this spec's create leaves an
// ERROR line naming ITS conversationId in the app's retained log ring. That id is
// group-text-conversion.spec.ts's CONNECTING_ID, and that spec asserts ZERO error
// lines carrying it over an UNWINDOWED readLogTail (:125-128) - so the line would
// fail a spec this change has nothing to do with. Observed for real in the first
// full-suite run of this file. The residue is ours, so we drop it.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

// --- Lean seed identities (app/src/lib/seed/lean.ts:81-150) ------------------
// The TENANT is the page we drive from: her "Relay groups" card is EMPTY in the
// lean world. The landlord's is not - lean seeds a connecting group of his - so
// driving from his page would make the card assertions ambiguous.
const TENANT_ID = 'contact-tenant-0001';
const TENANT_NAME = 'Tasha Nguyen';
const TENANT_PHONE = '+15550100001';
const LANDLORD_NAME = 'Marcus Bell';
const LANDLORD_PHONE = '+15550100002';

// The connecting result panel's notice, byte-exact (the string the modal ships).
const CONNECTING_NOTICE =
  'This group is still getting its number. The intro text has not been sent yet; it goes out once the number is ready.';

// The relay.intro trailing opt-out footer - a stable substring that identifies
// the auto-intro leg in the outbox (relay-open-stop.spec.ts:39).
const INTRO_NEEDLE = 'Reply STOP to opt out';

/** Reseed the lane with the LEAN profile (the byte-stable e2e world). */
async function reseedLean(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${NEXT}/__dev/reseed`);
  expect(res.ok(), `lean reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
}

/** Fresh dev-login via the seeded VA (session minted AFTER the reseed, so its
 *  cookie epoch matches the freshly re-seeded users table). page.request then
 *  shares the authenticated context for the /api reads below. */
async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  // exact: a non-exact name is a case-insensitive SUBSTRING match, and the Today
  // board's "Tours today" group heading would then collide (strict-mode).
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}

/** Poll the dev outbox until a message to `phone` whose body includes `needle`
 *  and is FROM `from` is observed (relay-open-stop.spec.ts:82-99). Pinning the
 *  sender to the group's own pool number keeps the assertion immune to any
 *  earlier send to the same seeded handset. */
async function expectOutboxIncludes(
  request: APIRequestContext,
  phone: string,
  needle: string,
  from: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const msgs = await getOutbox(request, { to: phone });
        return msgs.some((m) => (m.body ?? '').includes(needle) && m.from === from);
      },
      { timeout: 15_000, message: `outbox to ${phone} never carried the relay intro` },
    )
    .toBe(true);
}

test.beforeEach(async ({ request }) => {
  await reseedLean(request);
});

// Restore the lean baseline the rest of the suite expects (this file may not run
// last, and the group it creates is exactly the Inbox residue documented above),
// then drop the retained log lines the create's stuck-sweep wrote (see the header).
test.afterAll(async ({ request }) => {
  await reseedLean(request);
  await clearLogTail(request);
});

test('Contact file: create a relay group, land CONNECTING, then open it and deliver the intro', async ({
  page,
  request,
}) => {
  // driveConnectingGroupToOpen alone budgets 30s (warm poll) + 60s (open poll)
  // against a 30s per-test default; triple the budget.
  test.slow();
  await devLogin(page);

  // --- Arrange: the tenant's file, whose Relay groups card is empty ----------
  await page.goto(`${NEXT}/contacts/${TENANT_ID}`);
  await expect(page.getByRole('heading', { name: 'Relay groups' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('No relay groups yet.')).toBeVisible({ timeout: 15_000 });

  // --- Act 1: open the picker. The CardAction's aria-label REPLACES its visible
  //     "+ Create group" text as the accessible name. ---
  await page.getByRole('button', { name: 'Create a relay group' }).click();
  const picker = page.getByRole('dialog', { name: 'Create a relay group' });
  await expect(picker).toBeVisible();

  // The contact whose page this is is the LOCKED first member, and one member is
  // not a group: the create action is dead until someone is added.
  const members = picker.getByRole('list', { name: 'Members' });
  await expect(members.getByRole('listitem')).toHaveCount(1);
  await expect(members.getByText(TENANT_NAME)).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Create group' })).toBeDisabled();

  // --- Act 2: add the seeded landlord. A COMMITTED pick adds the row at once -
  //     there is no Add button - and the field resets itself. ---
  const search = picker.getByRole('combobox', { name: 'Add member' });
  await search.fill('Marcus');
  // Portaled to document.body - a sibling of the picker, not a descendant.
  await page
    .getByRole('listbox', { name: 'Add member suggestions' })
    .getByRole('option', { name: new RegExp(LANDLORD_NAME) })
    .click();
  await expect(members.getByRole('listitem')).toHaveCount(2);
  await expect(members.getByText(LANDLORD_NAME)).toBeVisible();
  await expect(search).toHaveValue('');

  // The optional operator tag rides the create as `tag`. It is exercised, not
  // asserted downstream: a group's label prefers the other members' names, so
  // the conversation header below reads "With <names>" either way.
  await picker.getByLabel('Name (optional)').fill(`Create flow ${Date.now()}`);

  await expect(picker.getByRole('button', { name: 'Create group' })).toBeEnabled();
  await picker.getByRole('button', { name: 'Create group' }).click();

  // --- Assert: the confirm dialog shows the SERVER-composed intro + recipients -
  const confirm = page.getByRole('dialog', { name: 'Open the relay group?' });
  await expect(confirm).toBeVisible({ timeout: 20_000 });
  // Exactly ONE modal is mounted at a time: the picker is gone while confirming.
  await expect(page.getByRole('combobox', { name: 'Add member' })).toHaveCount(0);

  const previewRegion = confirm.getByRole('region', { name: 'Message preview' });
  await expect(previewRegion).toBeVisible();
  // WHAT it is previewing, not just that it previews something. The body is the
  // server's; it is pinned against the relay.intro catalog default's own shell
  // around {members} plus who the sentence names, so an edit to the copy moves
  // the expectation and the UI together.
  const introBody = ((await previewRegion.textContent()) ?? '').trim();
  const [introHead = '', introTail = ''] =
    MESSAGE_CATALOG['relay.intro'].default.split('{members}');
  // BOTH halves must be non-empty or the matchers they feed are vacuous:
  // startsWith('') / endsWith('') are true of any string.
  expect(
    introHead.length,
    'the relay.intro default has no copy BEFORE {members} - startsWith below proves nothing',
  ).toBeGreaterThan(0);
  expect(
    introTail.length,
    'the relay.intro default has no copy AFTER {members} - endsWith below proves nothing',
  ).toBeGreaterThan(0);
  expect(introBody.startsWith(introHead), introBody).toBeTruthy();
  expect(introBody.endsWith(introTail), introBody).toBeTruthy();
  expect(introBody).toContain(TENANT_NAME);
  expect(introBody).toContain(LANDLORD_NAME);
  // The preview names people and NEVER prints a phone number (spec 6.2).
  expect(introBody).not.toContain(TENANT_PHONE);
  expect(introBody).not.toContain(LANDLORD_PHONE);

  const recipients = confirm.getByRole('list', { name: 'Recipients' });
  await expect(recipients.getByText(TENANT_NAME)).toBeVisible();
  await expect(recipients.getByText(LANDLORD_NAME)).toBeVisible();
  await expect(confirm.getByText('2 recipients will receive this.')).toBeVisible();

  // --- Act 3: confirm. The create answers CONNECTING, so the flow must NOT
  //     navigate: it re-mounts the picker modal carrying the result panel. ---
  await confirm.getByRole('button', { name: 'Open relay group' }).click();
  await expect(confirm).toHaveCount(0, { timeout: 30_000 });

  await expect(picker).toBeVisible({ timeout: 30_000 });
  await expect(picker.getByRole('heading', { name: 'Create a relay group' })).toBeVisible();
  await expect(picker.getByText(CONNECTING_NOTICE)).toBeVisible();
  // Nothing navigated: we are still on the contact file behind the modal.
  await expect(page).toHaveURL(new RegExp(`/contacts/${TENANT_ID}$`));

  // ...and the Relay groups card BEHIND the panel now lists the group. The
  // create fires onCreated -> the page refetches the file -> the card re-reads
  // GET /api/contacts/:id/relay-groups. This is the ONLY place that read is
  // exercised after a create against the real server (every unit test mocks the
  // slice), so it is also the only place the byRelayStatus GSI's eventual
  // consistency could ever surface. Scope to the CARD: the panel in front of it
  // is a different part of the page, and the card's row label is built from the
  // OTHER members' names (GroupTextsCard.groupLabel).
  const relayCard = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Relay groups' }) });
  await expect(relayCard.getByRole('link', { name: `With ${LANDLORD_NAME}` })).toBeVisible({
    timeout: 15_000,
  });
  await expect(relayCard.getByText('No relay groups yet.')).toHaveCount(0);

  // --- The id, from the link's href (a real react-router <Link>) -------------
  const goLink = picker.getByRole('link', { name: 'Go to the group' });
  await expect(goLink).toBeVisible();
  const href = await goLink.getAttribute('href');
  expect(href, 'the result panel link carries the conversation route').toMatch(
    /^\/conversations\/.+/,
  );
  const conversationId = (href ?? '').split('/').pop() ?? '';
  expect(conversationId).not.toBe('');

  // Assert the connecting landing LOUDLY: a group that provisioned immediately
  // never exercises the branch this panel exists for, and would pass vacuously.
  const convRes = await page.request.get(`${NEXT}/api/conversations/${conversationId}`);
  expect(convRes.ok(), `conversation fetch failed: ${convRes.status()}`).toBeTruthy();
  const { conversation } = (await convRes.json()) as {
    conversation: { status?: string; pool_number?: string };
  };
  expect(conversation.status, 'a fresh pair with no reusable number must be CONNECTING').toBe(
    'connecting',
  );
  expect(conversation.pool_number ?? '', 'a connecting group carries NO pool number yet').toBe('');

  // --- Act 4: complete the connect-when-ready handshake (warm -> register ->
  //     open on the warmed number), THEN follow the link. ---
  const opened = await driveConnectingGroupToOpen(page.request, conversationId);

  await goLink.click();
  await expect(page).toHaveURL(new RegExp(`/conversations/${conversationId}$`));
  await expect(page.getByText(`With ${TENANT_NAME} & ${LANDLORD_NAME}`)).toBeVisible({
    timeout: 15_000,
  });

  // --- Assert: the deferred intro really went out, to BOTH members, FROM the
  //     group's own warmed number (it could not have before the group opened). --
  await expectOutboxIncludes(request, TENANT_PHONE, INTRO_NEEDLE, opened.pool_number);
  await expectOutboxIncludes(request, LANDLORD_PHONE, INTRO_NEEDLE, opened.pool_number);
});
