// e2e/tests/scenarios/participant-names.spec.ts
//
// M1 (2026-08-31): a contact's name is resolved when a surface renders, not
// copied onto the conversation when it is created. One flow: open a tour relay
// group, rename the tenant, then assert the NEW name on the three surfaces the
// founder reported stale - Today (the tour's row in Tours to book: the flow's
// tour has no time, so it is a requested tour), the group thread header, the
// Relay groups card on the contact file.
//
// The header assertion reads the `With ...` facts line, which the relay view
// builds from GET /conversations/:id/members (Task 5) - the thread-header
// passthrough itself is deliberately not hydrated (spec section 3).
import { expect, test } from '@playwright/test';
import { Scenario, freshLandlord, freshTenant, type Contact } from '../../scenarios/steps.js';
import { expectTodayReady, showAllIn } from '../../support/today.js';
import { useScenarioBudget } from '../../support/scenarioBudget.js';

useScenarioBudget();

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

test('renaming a contact shows on Today, the group header and the contact card', async ({ page, request }) => {
  const flow = new Scenario(page, request);
  await flow.login();
  const owner = freshLandlord('PNOwner');
  await flow.teamCreatesLandlord({ firstName: owner.firstName, lastName: owner.lastName, phone: owner.phone });
  const ownerId = flow.landlordId();
  const unit = await flow.seedAvailableUnit({ beds: 2, landlordId: ownerId });
  const tenant = freshTenant('PNTenant');
  await flow.teamCreatesTenant({ firstName: tenant.firstName, lastName: tenant.lastName, phone: tenant.phone });
  await flow.seedTenantSearching();
  await flow.tenantAsksToTour(unit);
  const tourId = await flow.teamCreatesTourFromInterest(unit, 'Landlord-led');
  // No time booked, so the group opens on the naked intro (the default variant).
  await flow.teamOpensTourGroup();

  const renamed: Contact = { ...tenant, firstName: `${tenant.firstName}X`, lastName: 'Renamed', name: `${tenant.firstName}X Renamed` };
  await flow.teamRenamesActiveTenant(tenant, { firstName: renamed.firstName, lastName: renamed.lastName });

  // 1. Today names the person by the NEW name, on the row of the tour the flow
  // created: no time was booked, so it is a requested tour in the checklist's
  // Tours to book section, whose who is resolved at render time. (Before
  // tracker #31 the vehicle was an unread text in Unreplied, a section Today no
  // longer has.) Today is the dashboard ROOT route ("/"); there is no /today
  // path. Expanded first: this spec does not reseed, and the section lists the
  // OLDEST request first, so on a shared lane this one can sit past the fifth.
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);
  await showAllIn(page, 'Tours to book');
  const tourRow = page
    .getByRole('list', { name: 'Tours to book', exact: true })
    .locator(`a[href="/tours/${tourId}"]`);
  await expect(tourRow).toContainText(renamed.name);
  // The contact's display name BEFORE the rename (a name copied at create time
  // would still read so). Not `tenant.name`: freshContact's `name` is a label
  // that is never rendered, so a check on it could never fail.
  await expect(tourRow).not.toContainText(`${tenant.firstName} ${tenant.lastName}`);

  // 2. The OWNER's contact file: its Relay groups card is named for the tenant.
  await flow.expectGroupOnContactFile(renamed, ownerId);

  // 3. The group thread header's facts line, after a fresh load.
  await page.goto(`${NEXT}/conversations/${flow.activeTourGroupId()}`);
  await expect(page.getByText(new RegExp(`^With .*${renamed.firstName}`))).toBeVisible({ timeout: 15_000 });
});
