// e2e/tests/scenarios/sending-unit.spec.ts
//
// One test() per leaf path of documentation/sending-unit-sequence.mermaid — the
// "send a listing → feedback → next listing" matching loop that follows onboarding
// and hands off to Tours. Reads as the diagram: each line is a verb from
// e2e/scenarios/steps.ts. Coordinator role is "Team", never the founder's name.
//
// Precondition (shared setup, factored like onboarding's intakeAndRtaTail): an
// RTA-ready tenant in `searching` (handed off from onboarding) + ≥2 available
// properties to send. The two leaves differ only in the optional `opt` block:
//   1. the tenant SHARES preferences on a listing (saved + relayed + visible);
//   2. the tenant shares NO preferences (the opt is skipped).
// Both then advance the loop (find another match → next listing → fits) and hand
// off to Tours.
//
// Audit-surfaced realities (2026-06-30, documentation/sequence-diagram-to-test.md):
//   - "Send a listing" is the broadcast-to-tenants composer, curated to one tenant
//     (no individual-send route exists). Delivery is asserted via the fake thread +
//     the listings-sent API + the timeline "Property sent" link.
//   - Preferences are the contact's free-form `notes` (the "Preferences & notes" card).
//   - There is NO automated matcher — "find another match" = the team browses
//     available properties; we assert a next listing CAN be sent, not a re-ranking.
//   - Tours is now a BUILT first-class workflow (documentation/tours-sequence.mermaid):
//     the handoff = the tenant asks to tour the fitting unit, Team creates the
//     timeless tour record (the Tours diagram's first [MANUAL] step), and the
//     tenant stays `searching` (touring never changes tenant status).
import { test } from '@playwright/test';
import { Scenario, freshTenant, type Tenant, type Unit } from '../../scenarios/steps.js';

// Opt-in end-of-test pause for eyeballing the live dashboard (gated on E2E_PAUSE so
// CI/normal runs are unaffected). Same two modes as tenant-onboarding.spec.ts:
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

/** Shared precondition: a `searching`, RTA-ready tenant (handed off from onboarding)
 *  plus two available 2-BR properties to send. Reuses the onboarding verbs to reach
 *  `searching`; creates the properties via the setup API. */
async function searchingTenantWithListings(
  flow: Scenario,
): Promise<{ tenant: Tenant; unitA: Unit; unitB: Unit }> {
  await flow.login();
  const tenant = freshTenant('Searcher');
  await flow.teamCreatesContact({
    firstName: tenant.firstName,
    lastName: tenant.lastName,
    voucherSize: 2,
    housingAuthority: 'atlanta_housing',
    phone: tenant.phone,
  });
  await flow.teamRecordsRtaDecision(true); // RTA in hand → searching
  await flow.expectHandoffToSendUnit(); // precondition: the tenant is searching
  const unitA = await flow.seedAvailableUnit({ beds: 2 });
  const unitB = await flow.seedAvailableUnit({ beds: 2 });
  return { tenant, unitA, unitB };
}

test('shares preferences on a listing → saved + relayed + visible → next listing fits → Tours', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { tenant, unitA, unitB } = await searchingTenantWithListings(flow);

  // Send a specific listing for feedback → the app delivers it.
  await flow.teamSendsListing(unitA);
  await flow.expectListingDelivered(tenant, unitA);

  // opt: the tenant shares preferences → relayed to Team → saved to the profile → visible.
  await flow.tenantAnswers('no stairs (walker), near MARTA, must fit a king bed');
  await flow.expectPreferencesRelayed(/king bed/i);
  const saved = 'No stairs (walker); near MARTA; fits a king bed.';
  await flow.teamSavesPreferences(saved);
  await flow.expectPreferencesRecorded(saved);

  // Find another match → next matching listing → it fits → hand off to Tours:
  // the tenant asks to tour it and Team creates the (timeless) tour record.
  await flow.teamFindsNextMatch(unitB);
  await flow.teamSendsListing(unitB);
  await flow.expectListingDelivered(tenant, unitB);
  await flow.tenantAsksToTour(unitB);
  await flow.teamCreatesTourFromInterest(unitB, 'Self-guided');
  await flow.expectHandoffToTours(unitB);
});

test('shares NO preferences (opt skipped) → loop still advances → next listing fits → Tours', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { tenant, unitA, unitB } = await searchingTenantWithListings(flow);

  // Send a specific listing for feedback → the app delivers it.
  await flow.teamSendsListing(unitA);
  await flow.expectListingDelivered(tenant, unitA);

  // opt skipped — the tenant volunteers no preferences this round.

  // The loop still advances: find another match → next listing → it fits →
  // Tours (tour interest → Team creates the timeless tour record).
  await flow.teamFindsNextMatch(unitB);
  await flow.teamSendsListing(unitB);
  await flow.expectListingDelivered(tenant, unitB);
  await flow.tenantAsksToTour(unitB);
  await flow.teamCreatesTourFromInterest(unitB, 'Self-guided');
  await flow.expectHandoffToTours(unitB);
});
