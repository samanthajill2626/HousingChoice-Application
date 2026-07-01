// e2e/tests/scenarios/landlord-onboarding.spec.ts
//
// One test() per leaf path of documentation/landlord-onboarding-sequence.mermaid — the
// sales-first landlord & unit onboarding flow (prove value → sign the contract → onboard
// the landlord → intake the unit → publish → hand off to Matching). Reads as the diagram:
// each line is a verb from e2e/scenarios/steps.ts. Coordinator role is "Team", never the
// founder's name. Self-clean isolation: fresh timestamped landlords (freshTenant), no
// per-test reseed.
//
// Phase-1 realities encoded here:
//   - The cold call is NOT app-placed — it's modelled as Team creating the landlord
//     contact from the sourced lead (teamCreatesLandlord).
//   - Welcome email + DocuSign are an external channel; we assert only the recorded
//     contract_status ("signed"/"unsigned"), never the signing itself.
//   - "Onboarding call" data is Team-recorded (no AI extraction): the deal terms +
//     approval criteria land via the Edit-contact form / the /tenant-status route.
//   - Unit creation is API setup (no create-unit UI); publish → available; the handoff
//     to Matching is "the unit appears in GET /api/units?status=available".
import { test } from '@playwright/test';
import { Scenario, freshTenant, type Landlord, type Unit } from '../../scenarios/steps.js';

// Opt-in end-of-test pause for eyeballing the live dashboard (gated on E2E_PAUSE so
// CI/normal runs are unaffected). Same two modes as the sibling specs:
//   E2E_PAUSE=1     — page.pause(): click "Resume" (▶) in the Playwright INSPECTOR
//                     window (separate from Chrome) to continue to the next test.
//   E2E_PAUSE=hold  — the headed browser just stays open ~E2E_PAUSE_MS (default 10m).
test.afterEach(async ({ page }) => {
  const mode = process.env.E2E_PAUSE;
  if (!mode) return;
  test.setTimeout(0);
  if (mode === 'hold') {
    const ms = Number(process.env.E2E_PAUSE_MS ?? 600_000);
    // eslint-disable-next-line no-console
    console.log(`\n[E2E_PAUSE] test done — browser open ~${Math.round(ms / 1000)}s (Ctrl+C to quit).\n`);
    await page.waitForTimeout(ms);
  } else {
    // eslint-disable-next-line no-console
    console.log('\n[E2E_PAUSE] test done — click "Resume" (▶) in the Playwright Inspector window to continue.\n');
    await page.pause();
  }
});

/** The onboarding-call deal terms shared by every "signed → onboarded" path. */
const ONBOARDING = {
  expectedRent: 1450,
  registeredLandlord: true,
  rta48h: true,
  inspectionFirstTry: true,
  softTermsNote:
    'Utilities on tenant; $50 hold fee; deposit = 1 month; LIF ok; tours by appt; text + group text fine.',
} as const;
const CRITERIA = {
  incomeIncludesVoucher: true,
  criteriaNote:
    'Evictions >3yrs ok; utility debt must be on a plan; soft credit only; 2 references; voucher counts as income.',
} as const;

/**
 * Shared "signed → onboarded → unit-available → handoff" tail: record the contract as
 * signed, capture the onboarding details + approval criteria (two edit sessions), then
 * create + publish the unit under the landlord and hand off to Matching. Invoked at the
 * end of the two happy paths (cold-call & inbound-text).
 */
async function signedThroughHandoff(flow: Scenario, landlordId: string): Promise<void> {
  await flow.teamRecordsContractSigned();
  await flow.teamRecordsLandlordOnboarding(ONBOARDING);
  await flow.teamRecordsApprovalCriteria(CRITERIA);
  await flow.expectLandlordOnboardingRecorded({
    contractSigned: true,
    expectedRent: ONBOARDING.expectedRent,
    registeredLandlord: ONBOARDING.registeredLandlord,
    rta48h: ONBOARDING.rta48h,
    inspectionFirstTry: ONBOARDING.inspectionFirstTry,
    incomeIncludesVoucher: CRITERIA.incomeIncludesVoucher,
  });

  // Property + unit intake → create the unit under the landlord → publish → hand off.
  const unit = await flow.teamCreatesUnitFromIntake(landlordId, {
    beds: 3,
    baths: 2,
    voucherSizeAccepted: 2,
    listingLink: 'https://www.zillow.com/homedetails/onboarded-unit',
  });
  await flow.expectUnitAvailableWithListingLink(unit);
  await flow.expectHandoffToMatching(unit);
}

test('cold call → interested → signed → onboarded → unit available → handoff', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const landlord = freshTenant('Landlord');

  await flow.login();
  // Cold call (not app-placed in Phase 1): Team creates the landlord from the sourced lead.
  await flow.teamCreatesLandlord({
    firstName: landlord.firstName,
    lastName: landlord.lastName,
    phone: landlord.phone,
  });
  await flow.teamMarksLeadInterested();
  await flow.expectLeadInterested();

  await signedThroughHandoff(flow, flow.landlordId());
});

test('inbound text → worth pursuing → interested → signed → onboarded → unit available → handoff', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const landlord: Landlord = freshTenant('Landlord');

  // First touch — inbound text from an unknown number.
  await flow.landlordTexts(landlord, 'Can you help fill my unit?');
  await flow.login();
  await flow.expectUnknownCaptured(landlord);
  await flow.expectRelayedToTeam(landlord, /help fill my unit/i);

  // Qualify — Team asks for the property address; the landlord replies; relayed.
  await flow.teamReplies('Happy to help! What is the property address?');
  await flow.expectDeliveredToTenant(landlord, /property address/i);
  await flow.landlordAnswers('123 Peachtree St NW, Atlanta GA 30303');
  await flow.expectRelayedToTeam(landlord, /Peachtree St/i);

  // Worth pursuing → triage to Landlord → set interested.
  await flow.teamTriagesUnknownToLandlord(landlord);
  await flow.teamMarksLeadInterested();
  await flow.expectLeadInterested();

  await signedThroughHandoff(flow, flow.landlordId());
});

test('cold call → declines → parked (reason)', async ({ page, request }) => {
  const flow = new Scenario(page, request);
  const landlord = freshTenant('Landlord');

  await flow.login();
  await flow.teamCreatesLandlord({
    firstName: landlord.firstName,
    lastName: landlord.lastName,
    phone: landlord.phone,
  });
  // No thanks — a PM, not the owner. Log the decline reason + park.
  await flow.teamParksLead('Declined — a property manager, not the owner');
  await flow.expectLeadParked('Declined — a property manager, not the owner');
});

test('inbound text → not a fit → parked (reason)', async ({ page, request }) => {
  const flow = new Scenario(page, request);
  const landlord: Landlord = freshTenant('Landlord');

  await flow.landlordTexts(landlord, 'Do you take listings outside Georgia?');
  await flow.login();
  await flow.expectUnknownCaptured(landlord);
  await flow.expectRelayedToTeam(landlord, /outside Georgia/i);

  await flow.teamReplies('What is the property address?');
  await flow.expectDeliveredToTenant(landlord, /property address/i);
  await flow.landlordAnswers('It is in Birmingham, Alabama.');
  await flow.expectRelayedToTeam(landlord, /Birmingham/i);

  // Not a fit (out of jurisdiction) → log the reason + park. Triage to Landlord first so
  // the parked reason lands on a typed landlord record (mirrors the diagram's triage step).
  await flow.teamTriagesUnknownToLandlord(landlord);
  await flow.teamParksLead('Out of service area (Alabama)');
  await flow.expectLeadParked('Out of service area (Alabama)');
});

test('contract → never signed → parked (reason "never signed")', async ({ page, request }) => {
  const flow = new Scenario(page, request);
  const landlord = freshTenant('Landlord');

  await flow.login();
  await flow.teamCreatesLandlord({
    firstName: landlord.firstName,
    lastName: landlord.lastName,
    phone: landlord.phone,
  });
  await flow.teamMarksLeadInterested();
  await flow.expectLeadInterested();

  // Welcome email + DocuSign sent (external), but the landlord never signs → park.
  // contract_status stays unsigned (its default — never recorded as signed).
  await flow.teamParksLead('never signed');
  await flow.expectLeadParked('never signed');
});

test('property intake · missing field → follow-up → set → published → handoff', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const landlord = freshTenant('Landlord');

  await flow.login();
  await flow.teamCreatesLandlord({
    firstName: landlord.firstName,
    lastName: landlord.lastName,
    phone: landlord.phone,
  });
  await flow.teamMarksLeadInterested();
  await flow.expectLeadInterested();
  await flow.teamRecordsContractSigned();
  const landlordId = flow.landlordId();

  // Property intake, but voucher_size_accepted is missing → the unit record is created
  // NOT-yet-published (the loop's "Until the unit record is complete"). Text-only: the
  // diagram's MMS photos attach to the unit, but that's a deferred gap
  // (docs/issues/unit-create-and-mms-media-ui.md), so we don't send media here.
  await flow.landlordTextsProperty(
    'Property: 55 Elm Ct NW, 3bd/2ba, fits a king bed, https://www.zillow.com/homedetails/elm-ct',
  );
  const unit: Unit = await flow.teamCreatesUnitFromIntake(landlordId, {
    beds: 3,
    baths: 2,
    listingLink: 'https://www.zillow.com/homedetails/elm-ct',
    // voucherSizeAccepted intentionally omitted → not published yet.
  });

  // Team asks for the missing field; the landlord texts it back.
  await flow.teamReplies('Thanks! One more — what voucher size does this unit accept?');
  await flow.expectDeliveredToTenant(landlord, /voucher size/i);
  await flow.landlordTextsProperty('It accepts a 2BR voucher (3bd/2ba).');

  // Team records the missing field → now the record is complete → publish → hand off.
  await flow.teamUpdatesUnit(unit, { voucherSizeAccepted: 2 });
  await flow.expectUnitVoucherSizeAccepted(unit, 2);
  await flow.teamPublishesUnit(unit);
  await flow.expectUnitAvailableWithListingLink(unit);
  await flow.expectHandoffToMatching(unit);
});
