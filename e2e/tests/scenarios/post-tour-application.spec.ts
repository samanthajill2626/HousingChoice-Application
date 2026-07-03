// e2e/tests/scenarios/post-tour-application.spec.ts
//
// The Post-Tour & Application sequence — documentation/post-tour-application-
// sequence.mermaid + its writeup. Picks up from the Tours exit gate (a
// convertible tour) and walks the placement spine from birth
// (`Send application`) to the handoff (`Awaiting authority approval`).
//
// The founder's headline requirement (2026-07-03): the happy path moves the
// placement INTO AND OUT OF EVERY stamped stage in ladder order, skipping none.
// Test 1 IS that no-skip walk. The other three encode the diagram's three MARKED
// deviations (landlord denies, 48h window blown, a party backs out early).
//
// Structural rules encoded (mirrors tours.spec discipline):
//   - Conversion is QUIET — no announcement text at convert time (founder
//     2026-07-02). The tour's masked relay group SURVIVES, rebinding to the
//     placement (the channel continues; nothing new/unmasked is created).
//   - Nudges route to the PARTY's 1:1 thread (tenant rungs → tenant, landlord
//     rungs → landlord via unit.landlordId), NEVER the masked group.
//   - The placement-nudge tick (POST /__dev/placement-nudges/tick) is GLOBAL and
//     the worker also polls the wall clock — so arrival assertions scope to THIS
//     scenario's phones, and ticks ride `hoursFromNow(x)` relative to the
//     transition moment (nudge dueAt is `transitionTime + delay`).
//   - Team acts through the REAL dashboard UI; inbound + pure setup use the API
//     seam. Self-clean isolation: fresh timestamped contacts, NO per-test reseed.
import { test } from '@playwright/test';
import {
  Scenario,
  freshLandlord,
  freshTenant,
  tourSchedule,
  hoursFromNow,
  type Contact,
  type Unit,
} from '../../scenarios/steps.js';

// Distinctive substrings of the four nudge bodies (app/src/jobs/placementNudges.ts
// NUDGE_RUNGS) — pinned here so a body reword breaks the test loudly.
const RECEIPT_NUDGE = 'did the rental application come through';
const APPROVAL_NUDGE = 'any decision yet on the application';
const RTA_CLOSING_NUDGE = 'the 48-hour RTA window is closing';

// Opt-in end-of-test pause for eyeballing the live dashboard (gated on E2E_PAUSE),
// mirroring the sibling scenario specs.
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

/**
 * Shared precondition: drive the Tours flow to a CONVERTIBLE tour WITH a masked
 * relay group (the entry state this whole sequence picks up from). Returns the
 * cast so each test can diverge. The landlord-led-with-group shape is the one that
 * carries a group thread through to the placement.
 */
async function reachConvertibleTour(
  flow: Scenario,
  labels: { tenant: string; owner: string },
): Promise<{ tenant: Contact; owner: Contact; ownerId: string; unit: Unit }> {
  await flow.login();
  const owner = freshLandlord(labels.owner);
  await flow.teamCreatesLandlord({
    firstName: owner.firstName,
    lastName: owner.lastName,
    phone: owner.phone,
  });
  const ownerId = flow.landlordId();
  const unit = await flow.seedAvailableUnit({ beds: 2, landlordId: ownerId });
  const tenant = freshTenant(labels.tenant);
  await flow.teamCreatesTenant({
    firstName: tenant.firstName,
    lastName: tenant.lastName,
    phone: tenant.phone,
  });
  await flow.seedTenantSearching();

  // Tour → group → booked → toured → exit gate YES → convertible (the Tours
  // sequence's exit; proven verbs, reused).
  await flow.tenantAsksToTour(unit);
  await flow.teamCreatesTourFromInterest(unit, 'Landlord-led');
  await flow.teamOpensTourGroup();
  await flow.teamBooksTour(tourSchedule());
  await flow.teamMarksToured();
  await flow.teamRecordsExitGate('yes');
  await flow.expectTourConvertible();
  return { tenant, owner, ownerId, unit };
}

test('happy path: convert → walk EVERY placement stage in ladder order (no skip) → Awaiting authority approval', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { tenant, owner } = await reachConvertibleTour(flow, { tenant: 'Mover', owner: 'Keys' });

  // Landlord-routed nudges need a landlord 1:1 to land in — the diagram's
  // "L->>A: Received — reviewing" once the application reaches them. (The masked
  // group is NEVER a nudge target — founder 2026-07-02.)
  await flow.landlordTexts(owner, 'Got the application — reviewing it now.');

  // [MANUAL] Convert — QUIET. Placement born at Send application; tenant Searching
  // → Placing; the masked relay group survives, now placement-owned.
  await flow.teamConvertsTourToPlacement();
  await flow.expectPlacementStage('Send application');
  await flow.expectTenantPlacing();
  await flow.expectGroupThreadReboundToPlacement();

  // --- Application block ---------------------------------------------------
  // Send application → Awaiting receipt: the [AUTO] receipt-check nudge fires 1:1
  // to the TENANT ~24h later.
  await flow.teamMovesPlacementTo('Awaiting receipt');
  await flow.devPlacementNudgeTick(hoursFromNow(25));
  await flow.expectOutboxMessageContaining(tenant, RECEIPT_NUDGE);

  // Awaiting receipt → Awaiting completion (tenant confirmed receipt).
  await flow.teamMovesPlacementTo('Awaiting completion');

  // Awaiting completion → Awaiting approval (completed app is in the landlord's
  // hands): the [AUTO] approval-check nudge fires 1:1 to the LANDLORD ~24h later.
  await flow.teamMovesPlacementTo('Awaiting approval');
  await flow.devPlacementNudgeTick(hoursFromNow(25));
  await flow.expectOutboxMessageContaining(owner, APPROVAL_NUDGE);

  // --- RTA block -----------------------------------------------------------
  await flow.teamMovesPlacementTo('Collect RTA');
  await flow.teamMovesPlacementTo('Review RTA');
  await flow.teamMovesPlacementTo('Send RTA to landlord');

  // Send RTA to landlord → Awaiting landlord submission: arms the 48-HOUR clock;
  // the [AUTO] closing nudge fires 1:1 to the LANDLORD ~36h later.
  await flow.teamMovesPlacementTo('Awaiting landlord submission');
  await flow.expectRtaClockArmed();
  await flow.devPlacementNudgeTick(hoursFromNow(37));
  await flow.expectOutboxMessageContaining(owner, RTA_CLOSING_NUDGE);

  // Awaiting landlord submission → Awaiting authority approval (landlord
  // submitted): the handoff to Approval & Move-in. END of this sequence.
  await flow.teamMovesPlacementTo('Awaiting authority approval');
  await flow.expectPlacementStage('Awaiting authority approval');
});

test('marked deviation — landlord denies at Awaiting approval → Lost (tenant Searching, unit Available, relay closed)', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { tenant, owner, unit } = await reachConvertibleTour(flow, { tenant: 'Denied', owner: 'Nope' });
  // Landlord 1:1 exists — so we can PROVE no approval nudge fires after Lost.
  await flow.landlordTexts(owner, 'Reviewing.');

  await flow.teamConvertsTourToPlacement();
  await flow.teamMovesPlacementTo('Awaiting receipt');
  await flow.teamMovesPlacementTo('Awaiting completion');
  await flow.teamMovesPlacementTo('Awaiting approval');

  // Landlord denies → Lost via the reason modal (marked deviation).
  await flow.teamMovesPlacementTo('Lost', { lostReason: "Landlord couldn't get rent" });
  await flow.expectPlacementLost();

  // Bounce-back: tenant → Searching (re-match), property → Available, relay closed.
  await flow.expectTenantBackSearching();
  await flow.expectUnitAvailable(unit);
  await flow.expectRelayClosed();

  // Pending nudges were canceled on Lost — a tick fires nothing new.
  await flow.devPlacementNudgeTick(hoursFromNow(48));
  await flow.expectNoOutboxMessageContaining(owner, APPROVAL_NUDGE);
  await flow.expectNoOutboxMessageContaining(tenant, RECEIPT_NUDGE);
});

test('marked deviation — 48h window blown at Awaiting landlord submission → closing nudge + RTA deadline → late submit', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { owner } = await reachConvertibleTour(flow, { tenant: 'Late', owner: 'Slow' });
  await flow.landlordTexts(owner, 'Reviewing.');

  await flow.teamConvertsTourToPlacement();
  // Walk to Awaiting landlord submission (no skip).
  await flow.teamMovesPlacementTo('Awaiting receipt');
  await flow.teamMovesPlacementTo('Awaiting completion');
  await flow.teamMovesPlacementTo('Awaiting approval');
  await flow.teamMovesPlacementTo('Collect RTA');
  await flow.teamMovesPlacementTo('Review RTA');
  await flow.teamMovesPlacementTo('Send RTA to landlord');
  await flow.teamMovesPlacementTo('Awaiting landlord submission');

  // The 48h clock is armed on the placement; ticking past the 36h rung fires the
  // closing nudge (the deadline alert is display-only on Today, verified via the
  // armed deadline on the placement — Today reads that same next_deadline).
  await flow.expectRtaClockArmed();
  await flow.devPlacementNudgeTick(hoursFromNow(37));
  await flow.expectOutboxMessageContaining(owner, RTA_CLOSING_NUDGE);

  // Recommit: late submission → Awaiting authority approval.
  await flow.teamMovesPlacementTo('Awaiting authority approval');
  await flow.expectPlacementStage('Awaiting authority approval');
});

test('marked deviation — party backs out early at Awaiting receipt → Lost (bounce-back, relay closed)', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { tenant, unit } = await reachConvertibleTour(flow, { tenant: 'Quitter', owner: 'Host' });

  await flow.teamConvertsTourToPlacement();
  await flow.teamMovesPlacementTo('Awaiting receipt');

  // Party backs out (marked deviation) — Lost is reachable from ANY stage.
  await flow.teamMovesPlacementTo('Lost', { lostReason: 'Tenant withdrew' });
  await flow.expectPlacementLost();
  await flow.expectTenantBackSearching();
  await flow.expectUnitAvailable(unit);
  await flow.expectRelayClosed();

  // The receipt-check nudge was canceled on Lost — a tick delivers nothing.
  await flow.devPlacementNudgeTick(hoursFromNow(48));
  await flow.expectNoOutboxMessageContaining(tenant, RECEIPT_NUDGE);
});
