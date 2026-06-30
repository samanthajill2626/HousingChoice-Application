// e2e/tests/scenarios/tenant-onboarding.spec.ts
//
// One test() per alt-path of documentation/tenant-onboarding-sequence.mermaid.
// Reads as the diagram: each line is a verb from e2e/scenarios/steps.ts. The shared
// eligibility-intake + RTA-gate tail is written once (intakeAndRtaTail) and invoked at
// the end of each path. Coordinator role is "Team", never the founder's name.
import { test } from '@playwright/test';
import { Scenario, freshTenant } from '../../scenarios/steps.js';

// Opt-in: pause at the END of each test so you can look around the live dashboard
// (e.g. open the tenant's contact page and eyeball the Details panel). Gated on
// E2E_PAUSE so CI/normal runs are unaffected. Run ONE test headed, e.g. (PowerShell):
//   $env:E2E_PAUSE=1; npm run e2e -w @housingchoice/e2e -- tests/scenarios/tenant-onboarding.spec.ts --grep "by text → RTA" --headed
// The Playwright Inspector opens and the browser stays live — click "Resume" to finish.
test.afterEach(async ({ page }) => {
  if (process.env.E2E_PAUSE) await page.pause();
});

/** Eligibility intake → RTA gate → parked/handoff. Shared by every leaf path. */
async function intakeAndRtaTail(flow: Scenario, opts: { inHand: boolean }): Promise<void> {
  const intake = { pets: '1 cat', evictions: 'none', tenure: '3 years', lifEligible: true };
  await flow.teamRecordsIntake(intake);
  await flow.expectIntakeRecorded(intake);
  await flow.teamRecordsRtaDecision(opts.inHand);
  if (opts.inHand) await flow.expectHandoffToSendUnit();
  else await flow.expectParked();
}

test('inbound · by text → RTA in hand → handoff', async ({ page, request }) => {
  const flow = new Scenario(page, request);
  const tenant = freshTenant('Tenant');

  await flow.tenantTexts(tenant, 'Is this property still available?');
  await flow.login();
  await flow.expectRelayedToTeam(tenant, /still available/i);
  await flow.teamReplies(
    'That one is no longer available. Please send your full name, voucher size, and housing authority.',
  );
  await flow.expectDeliveredToTenant(tenant, /no longer available/i);

  await flow.tenantAnswers('Jordan Rivera, 2 bed, Atlanta Housing');
  await flow.teamTriagesUnknownToTenant(tenant, {
    firstName: 'Jordan',
    lastName: 'Rivera',
    voucherSize: 2,
    housingAuthority: 'atlanta_housing',
  });
  await flow.expectTypedTenant(tenant);
  await flow.expectTenantDetails({
    firstName: 'Jordan',
    lastName: 'Rivera',
    voucherSize: 2,
    housingAuthority: 'atlanta_housing',
  });

  await intakeAndRtaTail(flow, { inHand: true });
});

test('inbound · by text → no RTA → parked', async ({ page, request }) => {
  const flow = new Scenario(page, request);
  const tenant = freshTenant('Tenant');

  await flow.tenantTexts(tenant, 'Is this place still open?');
  await flow.login();
  await flow.expectRelayedToTeam(tenant, /still open/i);
  await flow.teamReplies('No longer available — send full name, voucher size, and housing authority.');
  await flow.expectDeliveredToTenant(tenant, /no longer available/i);

  await flow.tenantAnswers('Sam Lee, 1 bed, DeKalb Housing');
  await flow.teamTriagesUnknownToTenant(tenant, {
    firstName: 'Sam',
    lastName: 'Lee',
    voucherSize: 1,
    housingAuthority: 'dekalb_housing',
  });
  await flow.expectTypedTenant(tenant);
  await flow.expectTenantDetails({
    firstName: 'Sam',
    lastName: 'Lee',
    voucherSize: 1,
    housingAuthority: 'dekalb_housing',
  });

  await intakeAndRtaTail(flow, { inHand: false });
});

test('inbound · by phone call → RTA in hand → handoff', async ({ page, request }) => {
  const flow = new Scenario(page, request);
  const tenant = freshTenant('Caller');

  await flow.tenantCalls(tenant);
  await flow.expectAutoReply(/missed you|call back soon/i);
  await flow.login();
  // A missed call fires the auto-text but does NOT auto-capture a contact; the tenant
  // then TEXTS their details (the diagram's next step), creating the unknown to triage.
  await flow.tenantAnswers('Robin Cole, 3 bed, Fulton Housing');
  await flow.expectRelayedToTeam(tenant, /Robin Cole/i);
  await flow.teamTriagesUnknownToTenant(tenant, {
    firstName: 'Robin',
    lastName: 'Cole',
    voucherSize: 3,
    housingAuthority: 'fulton_housing',
  });
  await flow.expectTypedTenant(tenant);
  await flow.expectTenantDetails({
    firstName: 'Robin',
    lastName: 'Cole',
    voucherSize: 3,
    housingAuthority: 'fulton_housing',
  });

  await intakeAndRtaTail(flow, { inHand: true });
});

test('housing fair · Team enters details → RTA in hand → handoff', async ({ page, request }) => {
  const flow = new Scenario(page, request);
  await flow.login();
  await flow.teamCreatesContact({
    firstName: 'Casey',
    lastName: 'Nguyen',
    voucherSize: 2,
    housingAuthority: 'atlanta_housing',
  });
  await flow.expectTypedTenant();
  await flow.expectTenantDetails({
    firstName: 'Casey',
    lastName: 'Nguyen',
    voucherSize: 2,
    housingAuthority: 'atlanta_housing',
  });
  await intakeAndRtaTail(flow, { inHand: true });
});

test('housing fair · Team enters details → no RTA → parked', async ({ page, request }) => {
  const flow = new Scenario(page, request);
  await flow.login();
  await flow.teamCreatesContact({
    firstName: 'Drew',
    lastName: 'Park',
    voucherSize: 1,
    housingAuthority: 'dekalb_housing',
  });
  await flow.expectTypedTenant();
  await flow.expectTenantDetails({
    firstName: 'Drew',
    lastName: 'Park',
    voucherSize: 1,
    housingAuthority: 'dekalb_housing',
  });
  await intakeAndRtaTail(flow, { inHand: false });
});

test('housing fair · Tenant self-serves → RTA in hand → handoff', async ({ page, request }) => {
  const flow = new Scenario(page, request);
  const tenant = freshTenant('SelfServe');

  // The public self-serve portal captures name + voucher size (no housing-authority
  // field on POST /public/housing-fair), so we verify those — not housing authority.
  await flow.tenantSelfServes(tenant, { firstName: 'Jamie', lastName: 'Lopez', voucherSize: 2 });
  await flow.expectDeliveredToTenant(tenant, /thanks for stopping by/i);
  await flow.login();
  await flow.openSelfServedContact(tenant);
  await flow.expectTypedTenant();
  await flow.expectTenantDetails({ firstName: 'Jamie', lastName: 'Lopez', voucherSize: 2 });

  await intakeAndRtaTail(flow, { inHand: true });
});

export { intakeAndRtaTail };
