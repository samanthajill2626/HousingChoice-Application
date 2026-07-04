// e2e/tests/scenarios/approval-and-move-in.spec.ts
//
// The Approval & Move-in sequence — documentation/approval-and-move-in-
// sequence.mermaid + its writeup. The 6th/FINAL placements sequence: it picks up
// exactly where Post-Tour & Application handed off (the placement sitting at
// `Awaiting authority approval`, the landlord having submitted the RTA) and walks
// the placement spine through the ~4-week authority window to the finishline,
// `Moved in`.
//
// The founder's headline requirement (2026-07-03): the happy path moves the
// placement INTO AND OUT OF EVERY stamped stage in ladder order, skipping none:
//   awaiting_authority_approval → schedule_inspection → awaiting_inspection →
//   determine_rent → awaiting_rent_acceptance → awaiting_hap_contract →
//   complete_paperwork → awaiting_move_in → moved_in.
// Test 1 IS that no-skip walk (with the recorded data + derivations asserted at
// each rung). The other tests encode the diagram's THREE marked deviations
// (inspection fails → Lost, landlord rejects rent → Lost, either party backs out
// → Lost) plus the LIF non-eligible checklist branch.
//
// Structural rules encoded (mirrors the sibling scenario specs):
//   - The entry state is reached by REUSING the Post-Tour & Application path: a
//     convertible tour WITH a masked relay group → convert → walk the application/
//     RTA ladder to `Awaiting authority approval`. The masked relay group survives
//     conversion, so the backout deviation can prove it CLOSES on Lost.
//   - Team acts through the REAL PlacementDetail "Move to…" picker; four moves are
//     GATED by a prompt modal (inspection date, inspection outcome, determined
//     rent, final rent, move-in readiness). Un-gated moves are bare transitions.
//   - Derivations write the entity STATUS directly: at awaiting_hap_contract the
//     property reads Finalizing; at moved_in the property reads Occupied and the
//     tenant reads Placed. final_rent is written onto the UNIT on rent acceptance.
//   - DISTINCT money amounts (1850 determined, 1875 accepted) so the rendered
//     "$X/mo" assertions never cross-match. Self-clean isolation: fresh timestamped
//     entities per test, NO per-test /__dev/reseed.
//   - LostReason categories used (app/src/lib/statusModel.ts LOST_REASON_CATEGORIES
//     + dashboard LOST_REASON_CATEGORY_LABELS): landlord_lost_inspection ("Failed
//     inspection"), landlord_lost_rent ("Landlord couldn't get rent"),
//     tenant_withdrew ("Tenant withdrew").
import { test, expect, type Page } from '@playwright/test';
import {
  Scenario,
  freshLandlord,
  freshTenant,
  tourSchedule,
  type Contact,
  type Unit,
} from '../../scenarios/steps.js';

// Distinct money amounts (determined vs accepted final rent) — see the header note.
const DETERMINED_RENT = 1850;
const FINAL_RENT = 1875;
// A fixed landlord-scheduled inspection date (bare YYYY-MM-DD, as the modal sends).
const INSPECTION_DATE = '2026-08-15';

// The application/RTA ladder rungs (Post-Tour & Application) walked bare to reach
// this sequence's entry state. Proven labels from post-tour-application.spec.ts.
const PTA_LADDER = [
  'Awaiting receipt',
  'Awaiting completion',
  'Awaiting approval',
  'Collect RTA',
  'Review RTA',
  'Send RTA to landlord',
  'Awaiting landlord submission',
  'Awaiting authority approval',
] as const;

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
 * relay group — the landlord-led-with-group shape that carries a group thread
 * through to the placement (so the backout deviation can prove the relay closes).
 * Returns the cast so each test can diverge. Mirrors the PTA spec's helper.
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

  await flow.tenantAsksToTour(unit);
  await flow.teamCreatesTourFromInterest(unit, 'Landlord-led');
  await flow.teamOpensTourGroup();
  await flow.teamBooksTour(tourSchedule());
  await flow.teamMarksToured();
  await flow.teamRecordsExitGate('yes');
  await flow.expectTourConvertible();
  return { tenant, owner, ownerId, unit };
}

/**
 * Reach this sequence's ENTRY state: convert the convertible tour and walk the
 * application/RTA ladder to `Awaiting authority approval` (the exact Post-Tour &
 * Application handoff). Returns the cast plus the placement id and the tenant's
 * contact id (needed to flip lifEligible before the paperwork stage).
 */
async function reachAwaitingAuthorityApproval(
  flow: Scenario,
  labels: { tenant: string; owner: string },
): Promise<{ tenant: Contact; owner: Contact; unit: Unit; placementId: string; tenantContactId: string }> {
  const { tenant, owner, unit } = await reachConvertibleTour(flow, labels);
  const tenantContactId = flow.contactId(); // active contact is the tenant here
  const placementId = await flow.teamConvertsTourToPlacement();
  await flow.expectGroupThreadReboundToPlacement();
  for (const label of PTA_LADDER) {
    await flow.teamMovesPlacementTo(label);
  }
  await flow.expectPlacementStage('Awaiting authority approval');
  return { tenant, owner, unit, placementId, tenantContactId };
}

/** Flip the tenant's lifEligible flag via the authenticated PATCH seam (relative
 *  URL → resolves against the dashboard baseURL). */
async function setLifEligible(page: Page, contactId: string, value: boolean): Promise<void> {
  const res = await page.request.patch(`/api/contacts/${contactId}`, { data: { lifEligible: value } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

/** Read the placement via the API (relative URL → dashboard baseURL). */
async function getPlacement(page: Page, placementId: string): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/placements/${placementId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { placement: Record<string, unknown> }).placement;
}

test('happy path: walk EVERY approval → move-in stage in ladder order (no skip) → Moved in', async ({
  page,
  request,
}) => {
  test.slow(); // the packed no-skip walk — nine stages, gated modals, derivations.
  const flow = new Scenario(page, request);
  const { tenant, unit, placementId, tenantContactId } = await reachAwaitingAuthorityApproval(flow, {
    tenant: 'Mover',
    owner: 'Keys',
  });
  // LIF-eligible tenant → the LIF checklist row + the readiness "unconfirmed LIF"
  // advisory. Flip it BEFORE the paperwork stage renders.
  await setLifEligible(page, tenantContactId, true);

  // --- Authority approval: the ~4-week window opens ------------------------
  // Awaiting authority approval → Schedule inspection (ungated: authority approved).
  await flow.teamMovesPlacementTo('Schedule inspection');
  await flow.expectPlacementStage('Schedule inspection');

  // --- Inspection ----------------------------------------------------------
  // Schedule inspection → Awaiting inspection (gated: the landlord-scheduled date).
  await flow.teamMovesPlacementToWithInspectionDate(INSPECTION_DATE);
  await flow.expectInspectionDateShown(INSPECTION_DATE);
  // Awaiting inspection → Determine rent (gated: the pass/fail outcome). `pass`.
  await flow.teamRecordsInspectionOutcome('pass');
  await flow.expectPlacementStage('Determine rent');
  expect((await getPlacement(page, placementId)).inspection_outcome).toBe('pass');

  // --- Rent determination --------------------------------------------------
  // Determine rent → Awaiting rent acceptance (gated: the determined amount).
  await flow.teamMovesPlacementToWithRentDetermined(DETERMINED_RENT);
  await flow.expectDeterminedRentShown(DETERMINED_RENT);
  // Awaiting rent acceptance → Awaiting HAP contract (gated: the accepted final
  // rent, written onto the unit). The property flips to Finalizing here (Contract).
  await flow.teamAcceptsRent(FINAL_RENT);
  await flow.expectFinalRentShown(FINAL_RENT);
  await flow.expectPropertyFinalizing(unit);

  // --- Contract ------------------------------------------------------------
  // Awaiting HAP contract → Complete paperwork (ungated: the HAP contract recorded).
  await flow.teamMovesPlacementTo('Complete paperwork');
  await flow.expectPlacementStage('Complete paperwork');

  // --- Paperwork (unordered checklist; LIF conditional + optional) ---------
  await flow.expectPaperworkChecklist({ lif: true });
  await flow.teamTicksPaperwork('lease');
  await flow.teamTicksPaperwork('moveInDetails');
  // LIF left UNticked on purpose → the readiness confirm must NOTE unconfirmed LIF.
  // Complete paperwork → Awaiting move-in (gated: the readiness confirmation).
  await flow.teamConfirmsMoveInReady({ lifUnconfirmed: true });
  await flow.expectPlacementStage('Awaiting move-in');
  // Property stays Finalizing through the Closure wait.
  await flow.expectPropertyFinalizing(unit);

  // --- Move-in: the finishline ---------------------------------------------
  // Awaiting move-in → Moved in (ungated). Derivations: tenant Placed, unit Occupied.
  await flow.teamMovesPlacementTo('Moved in');
  await flow.expectPlacementStage('Moved in');
  await flow.expectTenantPlaced(tenant);
  await flow.expectPropertyOccupied(unit);
});

test('marked deviation — inspection FAILS at Awaiting inspection → Lost (landlord_lost_inspection, bounce-back, relay closed)', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { tenant, unit, placementId } = await reachAwaitingAuthorityApproval(flow, {
    tenant: 'Failed',
    owner: 'Inspect',
  });

  // Walk to the inspection wait.
  await flow.teamMovesPlacementTo('Schedule inspection');
  await flow.teamMovesPlacementToWithInspectionDate(INSPECTION_DATE);
  await flow.expectPlacementStage('Awaiting inspection');

  // Inspection fails → the outcome `fail` is RECORDED on the awaiting_inspection
  // exit (the landlord re-inspects — back to Schedule inspection, the diagram's
  // marked deviation), exercising the fail data path end-to-end...
  await flow.teamRecordsInspectionOutcome('fail');
  await flow.expectPlacementStage('Schedule inspection');
  expect((await getPlacement(page, placementId)).inspection_outcome).toBe('fail');

  // ...then the placement is LOST with landlord_lost_inspection (the marked exit).
  await flow.teamMovesPlacementTo('Lost', { lostReason: 'Failed inspection' });
  await flow.expectPlacementLost();
  expect((await getPlacement(page, placementId)).lost_reason).toMatchObject({
    category: 'landlord_lost_inspection',
  });

  // Bounce-back: tenant → Searching, property → Available, relay closed.
  await flow.expectTenantBackSearching();
  await flow.expectUnitAvailable(unit);
  await flow.expectRelayClosed();
});

test('marked deviation — landlord REJECTS the determined rent at Awaiting rent acceptance → Lost (landlord_lost_rent, final_rent NOT written)', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { tenant, unit, placementId } = await reachAwaitingAuthorityApproval(flow, {
    tenant: 'Reject',
    owner: 'Rent',
  });

  // Walk to the rent-acceptance wait (recording the inspection pass + determined rent).
  await flow.teamMovesPlacementTo('Schedule inspection');
  await flow.teamMovesPlacementToWithInspectionDate(INSPECTION_DATE);
  await flow.teamRecordsInspectionOutcome('pass');
  await flow.teamMovesPlacementToWithRentDetermined(DETERMINED_RENT);
  await flow.expectPlacementStage('Awaiting rent acceptance');

  // Landlord won't accept → LOST with landlord_lost_rent. The Lost modal (not the
  // finalRent prompt) fires, so NO final_rent is ever written onto the unit.
  await flow.teamMovesPlacementTo('Lost', { lostReason: "Landlord couldn't get rent" });
  await flow.expectPlacementLost();
  expect((await getPlacement(page, placementId)).lost_reason).toMatchObject({
    category: 'landlord_lost_rent',
  });

  // final_rent must NOT be stamped onto the unit — the deal died at acceptance.
  const uRes = await page.request.get(`/api/units/${unit.unitId}`);
  expect(uRes.ok(), await uRes.text()).toBeTruthy();
  const { unit: u } = (await uRes.json()) as { unit: { final_rent?: number } };
  expect(u.final_rent).toBeUndefined();

  // Bounce-back + relay closed.
  await flow.expectTenantBackSearching();
  await flow.expectUnitAvailable(unit);
  await flow.expectRelayClosed();
});

test('marked deviation — a party BACKS OUT mid-window (Awaiting HAP contract) → Lost (bounce-back, relay closed)', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { unit } = await reachAwaitingAuthorityApproval(flow, { tenant: 'Backout', owner: 'Mid' });

  // Walk into the mid-window Contract stage (also exercises entering awaiting_hap_contract).
  await flow.teamMovesPlacementTo('Schedule inspection');
  await flow.teamMovesPlacementToWithInspectionDate(INSPECTION_DATE);
  await flow.teamRecordsInspectionOutcome('pass');
  await flow.teamMovesPlacementToWithRentDetermined(DETERMINED_RENT);
  await flow.teamAcceptsRent(FINAL_RENT);
  await flow.expectPlacementStage('Awaiting HAP contract');

  // Either party backs out → LOST from wherever it stands (any stage).
  await flow.teamMovesPlacementTo('Lost', { lostReason: 'Tenant withdrew' });
  await flow.expectPlacementLost();
  await flow.expectTenantBackSearching();
  await flow.expectUnitAvailable(unit);
  await flow.expectRelayClosed();
});

test('LIF non-eligible branch — advances through Complete paperwork with the LIF row absent and no LIF flag on the readiness confirm', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { unit } = await reachAwaitingAuthorityApproval(flow, { tenant: 'NoLif', owner: 'Plain' });
  // Tenant lifEligible left UNSET → the LIF checklist row is absent and the
  // readiness confirm carries no LIF advisory.

  // Walk to Complete paperwork.
  await flow.teamMovesPlacementTo('Schedule inspection');
  await flow.teamMovesPlacementToWithInspectionDate(INSPECTION_DATE);
  await flow.teamRecordsInspectionOutcome('pass');
  await flow.teamMovesPlacementToWithRentDetermined(DETERMINED_RENT);
  await flow.teamAcceptsRent(FINAL_RENT);
  await flow.teamMovesPlacementTo('Complete paperwork');
  await flow.expectPlacementStage('Complete paperwork');

  // LIF row absent (the honest "not applicable" line renders instead of a checkbox).
  await flow.expectPaperworkChecklist({ lif: false });
  await flow.teamTicksPaperwork('lease');
  await flow.teamTicksPaperwork('moveInDetails');
  // Readiness confirm carries NO LIF advisory for a non-eligible tenant.
  await flow.teamConfirmsMoveInReady({ lifUnconfirmed: false });
  await flow.expectPlacementStage('Awaiting move-in');
  await flow.expectPropertyFinalizing(unit);
});
