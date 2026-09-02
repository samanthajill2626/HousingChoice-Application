// e2e/tests/scenarios/participant-names.spec.ts
//
// M1 (2026-08-31): a contact's name is resolved when a surface renders, not
// copied onto the conversation when it is created. One flow: open a tour relay
// group, rename the tenant, then assert the NEW name on the three surfaces the
// founder reported stale - Today, the group thread header, the Relay groups
// card on the contact file.
//
// The header assertion reads the `With ...` facts line, which the relay view
// builds from GET /conversations/:id/members (Task 5) - the thread-header
// passthrough itself is deliberately not hydrated (spec section 3).
import { expect, test } from '@playwright/test';
import { Scenario, freshLandlord, freshTenant, type Contact } from '../../scenarios/steps.js';
import { expectTodayReady } from '../../support/today.js';
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
  await flow.teamCreatesTourFromInterest(unit, 'Landlord-led');
  // No time booked, so the group opens on the naked intro (the default variant).
  await flow.teamOpensTourGroup();

  const renamed: Contact = { ...tenant, firstName: `${tenant.firstName}X`, lastName: 'Renamed', name: `${tenant.firstName}X Renamed` };
  await flow.teamRenamesActiveTenant(tenant, { firstName: renamed.firstName, lastName: renamed.lastName });

  // Leave the tenant's contact page FIRST. The rename left the browser on it,
  // and an open contact timeline marks a live inbound read the moment it lands
  // (POST /api/inbox/:contactId/read - "conversation unread reset"), which would
  // keep the thread off Today entirely.
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);

  // An unread 1:1 from the tenant puts them on Today's Unreplied list.
  await flow.tenantTexts(tenant, 'Is the tour still on?');

  // 1. Today names the person by the NEW name. Today is the dashboard ROOT
  // route ("/" - the nav's "Today" link points there); there is no /today path,
  // it falls through to the Not-found placeholder. The board fetches once on
  // mount and never polls, so reload until the inbound has been ingested.
  await expect(async () => {
    await page.goto(`${NEXT}/`);
    await expectTodayReady(page);
    await expect(page.getByText(renamed.name, { exact: false }).first()).toBeVisible({
      timeout: 5_000,
    });
  }).toPass({ timeout: 20_000 });

  // 2. The OWNER's contact file: its Relay groups card is named for the tenant.
  await flow.expectGroupOnContactFile(renamed, ownerId);

  // 3. The group thread header's facts line, after a fresh load.
  await page.goto(`${NEXT}/conversations/${flow.activeTourGroupId()}`);
  await expect(page.getByText(new RegExp(`^With .*${renamed.firstName}`))).toBeVisible({ timeout: 15_000 });
});
