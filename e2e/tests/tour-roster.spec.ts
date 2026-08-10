// e2e/tests/tour-roster.spec.ts
//
// The tour People card IS the roster editor (contact-rosters spec 6.2 / 6.3,
// plan Task 11). Two walks, both end to end against the real API:
//
//   1. THE SWAP - the motivating flow. A PM-managed property: the owner is the
//      landlord of record, a PM is the property's primary contact, so the tour
//      DEFAULTS to tenant + PM. On THIS one tour the arrangement is different -
//      the owner is showing it - so the operator adds the owner from the inline
//      "Also on this property" suggestion and removes the PM. Two clicks, both
//      persisted on click, both SILENT (no thread exists yet, so nothing has
//      been sent and there is nothing to confirm). Then [Open group text] shows
//      the SERVER-composed intro - the body asserted against the server's OWN
//      preview, never a literal - with its recipients, and only the confirm
//      provisions - after which the conversation's participants ARE the card's
//      rows (spec D1: the thread is the fact).
//
//   1b. and 2b. NARROW VIEWPORT (spec 6.7, "every surface in this spec is
//      verified at 360px"). Walk 1 ends by measuring the ADD-TO-LIVE confirm's
//      stacked footer, walk 2 opens by measuring the editing rows, and walk 3
//      is the tab rail. All three assert REAL boundingBox() geometry - a
//      computed style proves a rule exists, not that the pixels landed.
//
//   2. THE REMOVED TENANT - the caseworker-to-PM arrangement (spec D6/D11).
//      Anyone is removable, the tenant included. The card then says reminders
//      are paused AND the ladder proves it - one deterministic poll pass
//      retires the due rung with the roster reason on its own chip - lifecycle
//      milestones STILL pin to the tenant's own timeline (they are the tenant's
//      history, not the roster's), and the inline "On this tour" suggestion
//      restores them in ONE click.
//
//   3. THE TAB RAIL at phone width - five channels on a 360px rail: one row
//      that scrolls, never two rows (spec 6.6 / 6.7). The rail is built from
//      the ROSTER, so this walk needs no relay group at all.
//
// dashboard-next dialect (e2e/support/selectors.md): a local NEXT const + a
// local devLogin, raw page.request for setup, accessibility-first locators, no
// Scenario verbs. Self-clean isolation: every contact / property / tour is
// minted fresh per test, so NOTHING here reseeds - the lean world stays
// byte-stable and a reseed mid-suite would wipe other specs' data.
//
// The PM is rostered onto the property through POST /api/units/:unitId/contacts
// rather than the property page's editor: THAT editor is property-roster.spec's
// subject, and this file's subject is the tour card.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { driveConnectingGroupToOpen } from '../fixtures/relayConnect.js';
import {
  NARROW_360,
  WIDE_RESTORE,
  expectNoHorizontalOverflow,
  expectNoHorizontalOverflowIn,
} from '../support/viewport.js';
// COPY-CHANGE-PROOF EXPECTATIONS. Neither the intro body nor the skip chip is
// spelled out here: a hand-written literal turns a copy edit into a red test
// instead of an updated one (the reminder-body helpers made the same move when
// TOUR_REMINDER_BODIES was deleted). The catalog import is the established pure
// cross-workspace idiom (relay-open-stop.spec.ts, post-tour-application.spec.ts
// - `catalog.ts` reaches no repo and no AWS SDK); `dashboard/src/api/types.ts`
// is the same kind of leaf, a file with ZERO imports that holds the wire types
// and the staff-facing label maps the Reminders panel renders from.
import { MESSAGE_CATALOG } from '../../app/src/messages/catalog.js';
import {
  REMINDER_KIND_LABELS,
  REMINDER_SKIP_REASON_LABELS,
} from '../../dashboard/src/api/types.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  // `exact` on purpose: the home page also renders an <h2>Tours today</h2> the
  // moment any tour is scheduled for the current day, and a substring 'Today'
  // matches both (docs/issues/today-heading-locator-substring-collision.md).
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}

/** A run-unique E.164 (the landlord-activity.spec idiom) - never a seeded number. */
function freshPhone(): string {
  return `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
}

interface Party {
  contactId: string;
  firstName: string;
  lastName: string;
  phone: string;
  /** The display name every roster surface renders for this contact. */
  name: string;
}

/** A fresh typed contact WITH a phone - reachability is what the group text and
 *  the recipient count are computed from. A property manager is a `landlord`-
 *  typed contact; the ROLE is what the property roster row carries. */
async function createContact(
  request: APIRequestContext,
  type: 'tenant' | 'landlord',
  firstName: string,
): Promise<Party> {
  const lastName = 'Troster';
  const phone = freshPhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type, firstName, lastName, phone, ...(type === 'tenant' && { voucherSize: 2 }) },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  return { contactId, firstName, lastName, phone, name: `${firstName} ${lastName}` };
}

/** An AVAILABLE property owned by `landlordId` (POST /api/units + publish). */
async function createAvailableUnit(request: APIRequestContext, landlordId: string): Promise<string> {
  const line1 = `${`${Date.now()}`.slice(-6)} Tour Roster Way NW`;
  const res = await request.post(`${NEXT}/api/units`, {
    data: {
      landlordId,
      accepted_authorities: ['atlanta_housing'],
      beds: 2,
      rent_min: 1500,
      rent_max: 1600,
      address: { line1, city: 'Atlanta', state: 'GA', zip: '30314' },
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const unitId = ((await res.json()) as { unit: { unitId: string } }).unit.unitId;
  const pub = await request.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(pub.ok(), await pub.text()).toBeTruthy();
  return unitId;
}

/** Put a contact on the PROPERTY's roster, optionally as its primary contact. */
async function rosterOnProperty(
  request: APIRequestContext,
  unitId: string,
  contactId: string,
  role: 'landlord' | 'pm' | 'owner' | 'other',
  primaryContact = false,
): Promise<void> {
  const res = await request.post(`${NEXT}/api/units/${unitId}/contacts`, {
    data: { contactId, role, primaryContact },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

/** A tour via the real route. Timeless ('requested') - no ladder is armed and,
 *  crucially, no relay group exists, so the roster starts as a PLAN. */
async function createTour(
  request: APIRequestContext,
  data: { tenantId: string; unitId: string; tourType: string },
): Promise<string> {
  const res = await request.post(`${NEXT}/api/tours`, { data });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { tour: { tourId: string } }).tour.tourId;
}

/** Plan-add a contact to the tour's roster straight through the API. Valid only
 *  while NO thread exists (409 thread_exists after that) - which is exactly the
 *  silent PLAN write the card makes, so it needs no relay and sends nothing. */
async function planAddMember(
  request: APIRequestContext,
  tourId: string,
  contactId: string,
): Promise<void> {
  const res = await request.post(`${NEXT}/api/tours/${tourId}/roster/members`, {
    data: { contactId },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

/** The tour record straight from the API (for its groupThreadId pointer). */
async function getTour(
  request: APIRequestContext,
  tourId: string,
): Promise<{ groupThreadId?: string }> {
  const res = await request.get(`${NEXT}/api/tours/${tourId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { tour: { groupThreadId?: string } }).tour;
}

test.describe('Tour roster - the People card edits who is on this tour', () => {
  test('the swap: add the owner, drop the PM, then open the group through the confirm', async ({
    page,
  }) => {
    test.slow(); // a full build-a-world walk plus a real relay provision.
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);

    const owner = await createContact(req, 'landlord', `Trown${stamp}`);
    const unitId = await createAvailableUnit(req, owner.contactId);
    const pm = await createContact(req, 'landlord', `Trpm${stamp}`);
    const tenant = await createContact(req, 'tenant', `Trten${stamp}`);
    // The PM manages this property and is its PRIMARY CONTACT, so tours default
    // to the PM rather than the owner of record (spec D3).
    await rosterOnProperty(req, unitId, pm.contactId, 'pm', true);
    const tourId = await createTour(req, {
      tenantId: tenant.contactId,
      unitId,
      tourType: 'pm_team',
    });

    await page.goto(`${NEXT}/tours/${tourId}`);
    const roster = page.getByRole('list', { name: 'Roster' });
    await expect(roster.getByRole('link', { name: pm.name })).toBeVisible({ timeout: 20_000 });
    await expect(roster.getByRole('link', { name: tenant.name })).toBeVisible();
    await expect(roster.getByRole('link', { name: owner.name })).toHaveCount(0);

    // --- 1. Edit: the owner is on the PROPERTY but not on this tour ----------
    await page.getByRole('button', { name: 'Edit people' }).click();
    await expect(
      page.getByText(`Also on this property: ${owner.name} - landlord`),
    ).toBeVisible();
    // While editing, rows are not links - a click there is an edit gesture.
    await expect(roster.getByRole('link', { name: pm.name })).toHaveCount(0);

    // --- 2. The swap, two clicks, both persisted ON CLICK --------------------
    await page.getByRole('button', { name: `Add ${owner.name} to this tour` }).click();
    await expect(roster.getByText(owner.name)).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: `Remove ${pm.name} from this tour` }).click();
    await expect(roster.getByText(pm.name)).toHaveCount(0, { timeout: 20_000 });
    // Silent: a plan edit sends nothing, so no dialog ever appeared.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // The override is now visibly a customization of the property default.
    await expect(page.getByText(/Customized for this tour/)).toBeVisible();
    await page.getByRole('button', { name: 'Done editing people' }).click();

    // --- 3. Open the group text: preview, then confirm ----------------------
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Open group text' }).click();
    const confirm = page.getByRole('dialog', { name: 'Open the group text?' });
    await expect(confirm).toBeVisible({ timeout: 20_000 });
    // The body is the SERVER's, and every recipient is named with the count.
    await expect(confirm.getByRole('region', { name: 'Message preview' })).toBeVisible();

    // WHAT the dialog is previewing, not just that it previews something. The
    // expectation is the server's OWN composition, read back from the very
    // endpoint the dialog rendered from (spec 6.3 / D1: the body is composed
    // server-side and NEVER rebuilt in the browser), so an edit to the
    // `relay.intro` CATALOG DEFAULT moves the expectation and the UI together.
    // Only the default: this route has no override path to drift from - the
    // entry is `editable: true`, but composeIntroBody (jobs/relayFanOut.ts:199)
    // calls resolveMessage with no override map, and the expectation below is
    // pinned to MESSAGE_CATALOG[...].default rather than to a resolved template.
    // Fetched BEFORE the confirm is accepted: preview-open 409s
    // `relay_already_provisioned` once a thread exists.
    const previewRes = await req.get(`${NEXT}/api/tours/${tourId}/roster/preview-open`);
    expect(previewRes.ok(), await previewRes.text()).toBeTruthy();
    const introBody = ((await previewRes.json()) as { body: string }).body;
    // A pure server-echo can pass VACUOUSLY (an empty body would equal an empty
    // bubble), so the echo is pinned against the catalog default's own shell
    // around {members} plus who the sentence names - all still copy-sourced.
    const [introHead = '', introTail = ''] =
      MESSAGE_CATALOG['relay.intro'].default.split('{members}');
    // BOTH halves of the shell must be non-empty or the matcher they feed is
    // itself vacuous: startsWith('') / endsWith('') are true of any string. An
    // empty tail is also what "the default lost its {members} token entirely"
    // looks like (split returns the whole string as the head).
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
    expect(introBody).toContain(tenant.name);
    expect(introBody).toContain(owner.name);
    expect(introBody).not.toContain(pm.name);
    // The region holds exactly one <p> (the bubble), so this is an exact match.
    await expect(confirm.getByRole('region', { name: 'Message preview' })).toHaveText(introBody);

    const recipients = confirm.getByRole('list', { name: 'Recipients' });
    await expect(recipients.getByText(tenant.name)).toBeVisible();
    await expect(recipients.getByText(owner.name)).toBeVisible();
    await expect(recipients.getByText(pm.name)).toHaveCount(0);
    await expect(confirm.getByText('2 recipients will receive this.')).toBeVisible();
    await confirm.getByRole('button', { name: 'Open group text' }).click();
    await expect(confirm).toHaveCount(0, { timeout: 30_000 });

    // --- 4. The conversation's participants ARE the card's rows (spec D1) ---
    await expect
      .poll(async () => (await getTour(req, tourId)).groupThreadId, {
        timeout: 30_000,
        message: 'the tour never linked a group thread',
      })
      .not.toBeUndefined();
    const conversationId = (await getTour(req, tourId)).groupThreadId as string;
    const conv = await req.get(`${NEXT}/api/conversations/${conversationId}`);
    expect(conv.ok(), await conv.text()).toBeTruthy();
    const { conversation } = (await conv.json()) as { conversation: { status?: string } };
    if (conversation.status === 'connecting') {
      // A fresh pair with no reusable number opens CONNECTING; complete the
      // handshake so the members below are the live, provisioned set.
      await driveConnectingGroupToOpen(req, conversationId);
    }
    const members = await req.get(`${NEXT}/api/conversations/${conversationId}/members`);
    expect(members.ok(), await members.text()).toBeTruthy();
    const phones = ((await members.json()) as { members: { phone: string }[] }).members.map(
      (m) => m.phone,
    );
    expect(phones).toContain(tenant.phone);
    expect(phones).toContain(owner.phone);
    expect(phones).not.toContain(pm.phone);

    // And the card follows the thread now: same people, plus a DISABLED reset
    // (the plan was consumed at open).
    await page.goto(`${NEXT}/tours/${tourId}`);
    await expect(roster.getByRole('link', { name: owner.name })).toBeVisible({ timeout: 20_000 });
    await expect(roster.getByRole('link', { name: tenant.name })).toBeVisible();
    await expect(roster.getByText(pm.name)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reset to property default' })).toBeDisabled();

    // --- 5. The add-to-live confirm at 360px (spec 6.4 / 6.7) ---------------
    // Free coverage on the world above: the thread is LIVE and the PM is on the
    // PROPERTY but off this tour, so they are still an inline suggestion - and
    // adding to a live group is the confirm-first path. Quiet hours are off
    // here, so this is the everyday TWO-button layout (the three-button one is
    // covered by roster-quiet-hours.spec.ts).
    await page.setViewportSize(NARROW_360);
    await page.getByRole('button', { name: 'Edit people' }).click();
    await page.getByRole('button', { name: `Add ${pm.name} to this tour` }).click();
    const addConfirm = page.getByRole('dialog', { name: `Add ${pm.name} to the group text?` });
    await expect(addConfirm).toBeVisible({ timeout: 20_000 });

    // Spec 6.7: below 860px the footer stacks FULL WIDTH with the DEFAULT on
    // top. `exact` keeps 'Add and notify' off the quiet-hours deferral label
    // ('Add and notify at <time>'), which is a substring match otherwise.
    const addCancelBox = (await addConfirm.getByRole('button', { name: 'Cancel' }).boundingBox())!;
    const addBox = (await addConfirm
      .getByRole('button', { name: 'Add and notify', exact: true })
      .boundingBox())!;
    expect(addBox.y, 'the default is the top button').toBeLessThan(addCancelBox.y);
    expect(addBox.width, 'the buttons are full width').toBeGreaterThan(240);
    expect(Math.round(addBox.width)).toBe(Math.round(addCancelBox.width));
    expect(Math.round(addBox.x)).toBe(Math.round(addCancelBox.x));
    // Scoped to the DIALOG's own box: the Modal backdrop is position:fixed, so a
    // dialog contributes nothing to the document's or <main>'s scrollable
    // overflow - a page-level check here would be blind to it (viewport.ts).
    await expectNoHorizontalOverflowIn(addConfirm, 'the add-to-live-group confirm at 360px');

    // Cancelling writes NOTHING - the confirm is the only thing that sends.
    await addConfirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(addConfirm).toHaveCount(0);
    await expect(roster.getByText(pm.name)).toHaveCount(0);
    await page.setViewportSize(WIDE_RESTORE);
  });

  test('a removed tenant: reminders pause, milestones still pin to them, one click restores', async ({
    page,
  }) => {
    test.slow();
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);

    const owner = await createContact(req, 'landlord', `Trown2${stamp}`);
    const unitId = await createAvailableUnit(req, owner.contactId);
    const pm = await createContact(req, 'landlord', `Trpm2${stamp}`);
    const tenant = await createContact(req, 'tenant', `Trten2${stamp}`);
    await rosterOnProperty(req, unitId, pm.contactId, 'pm', true);
    // The tenant needs their 1:1 thread BEFORE the ladder is ticked in step 2b.
    // The poll resolves the SEND TARGET above the roster gate, and a freshly
    // minted contact who has never messaged in has no 1:1 conversation - so
    // without this the rung retires as `no_conversation` and the walk would
    // assert the pause it never actually proved. Create-or-get, no messages.
    const thread = await req.post(`${NEXT}/api/contacts/${tenant.contactId}/conversation`);
    expect(thread.ok(), await thread.text()).toBeTruthy();
    const tourId = await createTour(req, {
      tenantId: tenant.contactId,
      unitId,
      tourType: 'pm_team',
    });

    await page.goto(`${NEXT}/tours/${tourId}`);
    const roster = page.getByRole('list', { name: 'Roster' });
    await expect(roster.getByRole('link', { name: tenant.name })).toBeVisible({ timeout: 20_000 });

    // --- 0. The EDITING rows at 360px (spec 6.7) ----------------------------
    // Measured on the world the walk below uses: the roster is still the
    // default pair, so the tenant's row carries a role AND a live remove.
    await page.setViewportSize(NARROW_360);
    await page.getByRole('button', { name: 'Edit people' }).click();
    const tenantRow = roster.getByRole('listitem').filter({ hasText: tenant.name });
    const tenantRemove = page.getByRole('button', {
      name: `Remove ${tenant.name} from this tour`,
    });
    await expect(tenantRemove).toBeVisible({ timeout: 20_000 });
    const nameBox = (await tenantRow.getByText(tenant.name).boundingBox())!;
    const roleBox = (await tenantRow.getByText('tenant', { exact: true }).boundingBox())!;
    const removeBox = (await tenantRemove.boundingBox())!;
    const rowBox = (await tenantRow.boundingBox())!;

    // The role WRAPPED UNDER the name (.name is flex: 1 1 100% below 860px).
    expect(roleBox.y, 'the role did not wrap under the name').toBeGreaterThan(nameBox.y);
    // The remove control is ANCHORED TO THE NAME LINE - it is a DOM child of
    // it, so it rides the SAME wrapped line as the role and never takes a third
    // line of its own. Two deliberate choices here:
    //   - it is NOT compared to the NAME's y: at <=860px .name is flex 1 1 100%,
    //     so it fills line 1 and the role AND the control wrap together;
    //   - it is compared to the role as a vertical OVERLAP, not as equal tops:
    //     .nameLine is baseline-aligned and the control carries padding, so a
    //     shared line still puts its box a few px above the role's.
    const sharedLine =
      Math.min(removeBox.y + removeBox.height, roleBox.y + roleBox.height) -
      Math.max(removeBox.y, roleBox.y);
    expect(removeBox.y, 'the remove control did not wrap with the role').toBeGreaterThan(nameBox.y);
    expect(sharedLine, 'the remove control took a line of its own').toBeGreaterThanOrEqual(
      roleBox.height / 2,
    );
    // The touch target is the full ROW (min 44px), not the glyph.
    expect(rowBox.height, 'the editing row is the 44px touch target').toBeGreaterThanOrEqual(44);
    expect(
      removeBox.x + removeBox.width,
      'the remove control runs past the 360px viewport',
    ).toBeLessThanOrEqual(NARROW_360.width);
    await expectNoHorizontalOverflow(page, 'the tour People card in edit mode at 360px');

    // Leave edit mode and widen - the walk below is the desktop one.
    await page.getByRole('button', { name: 'Done editing people' }).click();
    await page.setViewportSize(WIDE_RESTORE);

    // --- 1. Remove the TENANT. Anyone is removable (spec D6) ----------------
    await page.getByRole('button', { name: 'Edit people' }).click();
    await page.getByRole('button', { name: `Remove ${tenant.name} from this tour` }).click();
    await expect(roster.getByText(tenant.name)).toHaveCount(0, { timeout: 20_000 });
    // The card says WHY that matters - the reminder ladder is suppressed (D11).
    await expect(
      page.getByText('Tenant is not on this roster - tour reminders are paused'),
    ).toBeVisible();
    // The PM is the only member left, so their remove is disabled with the reason.
    await expect(page.getByRole('button', { name: `Remove ${pm.name} from this tour` })).toBeDisabled();
    await expect(
      page.getByText(
        'A roster needs at least one member. Add someone else before removing this one.',
      ),
    ).toBeVisible();

    // --- 2. Lifecycle milestones STILL pin to the tenant --------------------
    // Book the tour AFTER the removal: the milestone is the tenant's history,
    // not the roster's, so it lands on their timeline either way.
    const booked = await req.patch(`${NEXT}/api/tours/${tourId}`, {
      data: { scheduledAt: new Date(Date.now() + 5 * 24 * 3_600_000).toISOString() },
    });
    expect(booked.ok(), await booked.text()).toBeTruthy();
    await page.goto(`${NEXT}/contacts/${tenant.contactId}`);
    await expect(page.getByRole('link', { name: 'Tour scheduled' })).toBeVisible({
      timeout: 20_000,
    });

    // --- 2b. The LADDER itself shows the pause (spec 9, D11) ----------------
    // The card note above is the ROSTER's statement; this is the reminder
    // ladder's own, and they are different surfaces. An UPCOMING rung says
    // nothing about the roster (tenant_not_on_roster is not a suppression
    // reason), so the only ladder-visible signal is the chip a claim-skip
    // leaves behind - which means the poll has to actually run.
    //
    // TIMING-ROBUST BY CONSTRUCTION: the booking above armed the ladder and the
    // `confirmation` rung's dueAt is the server's ARM-TIME instant, so it is
    // already due - no scheduledAt change is needed (moving the tour near-term
    // would un-arm the other rungs). Rather than tick bare on the wall clock,
    // read the rung's STORED dueAt (which IS the real send time - it is the
    // quiet-hours-clamped instant) and tick 1s past it, the `justAfter` idiom.
    // The tick is global, but at ~now it fires only what the worker's own 60s
    // poll would have fired anyway; a far-future `now` never belongs here.
    const ladder = await req.get(`${NEXT}/api/tours/${tourId}/reminders`);
    expect(ladder.ok(), await ladder.text()).toBeTruthy();
    const { reminders } = (await ladder.json()) as { reminders: { kind: string; dueAt: string }[] };
    const confirmation = reminders.find((r) => r.kind === 'confirmation');
    if (confirmation === undefined) throw new Error('the booking armed no confirmation rung');
    const tick = await req.post(`${NEXT}/__dev/tour-reminders/tick`, {
      data: { now: new Date(Date.parse(confirmation.dueAt) + 1_000).toISOString() },
    });
    expect(tick.ok(), await tick.text()).toBeTruthy();

    await page.goto(`${NEXT}/tours/${tourId}`);
    // The panel is an UNNAMED <section> with a 'Reminders' <h3> (Card), not a
    // region and not behind a disclosure - scope by the heading (the
    // Scenario.remindersCard idiom, inlined for this Scenario-free dialect).
    const remindersCard = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Reminders' }) });
    // `.first()` on the rung is the Scenario.remindersCard idiom too
    // (steps.ts:3277): it resolves to one node today, but it collapses the whole
    // chain, so neither a second matching <section> nor a second matching rung
    // could turn this into a strict-mode violation.
    await expect(
      remindersCard
        .getByRole('listitem')
        .filter({ hasText: REMINDER_KIND_LABELS.confirmation })
        .first(),
    ).toContainText(`Skipped - ${REMINDER_SKIP_REASON_LABELS.tenant_not_on_roster}`, {
      timeout: 20_000,
    });

    // --- 3. ONE click restores them -----------------------------------------
    await page.goto(`${NEXT}/tours/${tourId}`);
    await page.getByRole('button', { name: 'Edit people' }).click();
    await expect(page.getByText(`On this tour: ${tenant.name} - tenant`)).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole('button', { name: `Add ${tenant.name} to this tour` }).click();
    await expect(roster.getByText(tenant.name)).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText('Tenant is not on this roster - tour reminders are paused'),
    ).toHaveCount(0);
  });

  test('the channel tab rail stays ONE row and scrolls at 360px', async ({ page }) => {
    test.slow();
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);

    const owner = await createContact(req, 'landlord', `Trrown${stamp}`);
    const unitId = await createAvailableUnit(req, owner.contactId);
    const pm = await createContact(req, 'landlord', `Trrpm${stamp}`);
    const tenant = await createContact(req, 'tenant', `Trrten${stamp}`);
    const extra = await createContact(req, 'landlord', `Trrxtr${stamp}`);
    await rosterOnProperty(req, unitId, pm.contactId, 'pm', true);
    const tourId = await createTour(req, {
      tenantId: tenant.contactId,
      unitId,
      tourType: 'pm_team',
    });
    // The rail is built from the ROSTER, not from a thread, so a five-tab rail
    // needs NO relay provisioning: the default pair (tenant + the property's
    // primary contact) plus two plan-adds, plus the fixed Group text tab.
    await planAddMember(req, tourId, owner.contactId);
    await planAddMember(req, tourId, extra.contactId);

    await page.setViewportSize(NARROW_360);
    await page.goto(`${NEXT}/tours/${tourId}`);
    await expect(page.getByRole('list', { name: 'Roster' }).getByText(tenant.name)).toBeVisible({
      timeout: 20_000,
    });
    // The hub opens on the DETAILS pane and below 860px the other pane is
    // display:none - a hidden rail has no box at all, so reveal it first.
    await page
      .getByRole('group', { name: 'View' })
      .getByRole('button', { name: 'Conversation' })
      .click();
    const rail = page.getByRole('tablist', { name: 'Conversation channel' });
    await expect(rail).toBeVisible();
    const tabs = rail.getByRole('tab');

    // Spec 6.7 / 6.6: ONE row that SCROLLS - proven from real geometry, never
    // from computed styles (a style proves a rule exists, not that the pixels
    // landed where the spec says).
    const tabTops = await tabs.evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().y)),
    );
    expect(tabTops.length, 'too few tabs for the rail to overflow at all').toBeGreaterThan(3);
    expect(new Set(tabTops).size, 'the rail wrapped onto a second row').toBe(1);

    const metrics = await rail.evaluate((el) => ({
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
      scrollH: el.scrollHeight,
      clientH: el.clientHeight,
    }));
    // A wrapped second row would show up as vertical overflow inside the rail.
    expect(metrics.scrollH, 'the rail hides a second row inside itself').toBeLessThanOrEqual(
      metrics.clientH + 1,
    );
    // The rail really is wider than its box here, so the scroll claim below is
    // about a rail that HAS somewhere to scroll to.
    expect(
      metrics.scrollW - metrics.clientW,
      'the rail does not overflow, so this proves nothing about scrolling',
    ).toBeGreaterThan(1);
    const scrolled = await rail.evaluate((el) => {
      el.scrollLeft = 9999;
      const landed = el.scrollLeft;
      el.scrollLeft = 0;
      return landed;
    });
    expect(scrolled, 'the rail does not scroll horizontally').toBeGreaterThan(0);

    // ...and it is the RAIL that scrolls, not the surface it sits in: the rail's
    // own `overflow-x: auto` box self-contains, so the routed <main> around it
    // must still measure flush (viewport.ts explains why <main>, not the
    // document, is the box that carries that signal in this shell).
    await expectNoHorizontalOverflow(page, 'the tour hub with an overflowing tab rail at 360px');
    await page.setViewportSize(WIDE_RESTORE);
  });
});
