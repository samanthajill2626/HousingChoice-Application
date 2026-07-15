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
// The four nudge bodies, sourced from the app message catalog (the single source
// of truth) so a body reword can't silently drift the assertions apart. Import
// the PURE catalog module (no repo/AWS deps). Full bodies still satisfy the
// `…Containing` outbox assertions below.
import { MESSAGE_CATALOG } from '../../../app/src/messages/catalog.js';

const RECEIPT_NUDGE = MESSAGE_CATALOG['nudge.receipt_check'].default;
const COMPLETION_NUDGE = MESSAGE_CATALOG['nudge.completion_check'].default;
const APPROVAL_NUDGE = MESSAGE_CATALOG['nudge.approval_check'].default;
const RTA_CLOSING_NUDGE = MESSAGE_CATALOG['nudge.rta_window_closing'].default;

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
 * Shared precondition: drive the Tours flow through the YES exit gate, which
 * AUTO-CONVERTS into the placement this whole sequence drives (with a masked
 * relay group carried through). Returns the cast so each test can diverge.
 */
async function reachConvertedPlacement(
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

  // Tour → group → booked → toured → exit gate YES, which AUTO-CONVERTS
  // (2026-07-15): the placement is born in the same step and becomes the
  // scenario's active placement. QUIET — no announcement at convert time
  // (founder 2026-07-02); the masked relay group survives, placement-owned.
  await flow.tenantAsksToTour(unit);
  await flow.teamCreatesTourFromInterest(unit, 'Landlord-led');
  await flow.teamOpensTourGroup();
  await flow.teamBooksTour(tourSchedule());
  await flow.teamMarksToured();
  await flow.teamRecordsExitGate('yes');
  await flow.expectTourAutoConverted();
  return { tenant, owner, ownerId, unit };
}

test('happy path: convert → walk EVERY placement stage in ladder order (no skip) → Awaiting authority approval', async ({
  page,
  request,
}) => {
  test.slow(); // the packed no-skip walk — every stage, three ticks, board reads.
  const flow = new Scenario(page, request);
  const { tenant, owner, unit } = await reachConvertedPlacement(flow, { tenant: 'Mover', owner: 'Keys' });

  // Diagram-faithful: the "L->>A: Received — reviewing" arrow once the application
  // reaches the landlord. This is NOT a technical prerequisite for the landlord
  // nudges — the poller now mints the 1:1 on demand when none exists (see the BLOWN
  // deviation below, which deliberately omits this). We keep it here because the
  // diagram models the landlord replying. (The masked group is NEVER a nudge target
  // — founder 2026-07-02.)
  await flow.landlordTexts(owner, 'Got the application — reviewing it now.');

  // The YES gate already converted (placement born at Send application; tenant
  // Searching → Placing; the masked relay group survives, placement-owned).
  await flow.expectPlacementStage('Send application');
  // Conversion is finalized on BOTH sides: the tour closes as converted (back-links
  // to the placement) and the property reads Under application.
  await flow.expectTourFinalized();
  await flow.expectUnitUnderApplication(unit);
  await flow.expectTenantPlacing();
  await flow.expectGroupThreadReboundToPlacement();

  // --- Application block ---------------------------------------------------
  // Send application → Awaiting receipt: the [AUTO] receipt-check nudge fires 1:1
  // to the TENANT ~24h later.
  await flow.teamMovesPlacementTo('Awaiting receipt confirmation');
  await flow.devPlacementNudgeTick(hoursFromNow(25));
  await flow.expectOutboxMessageContaining(tenant, RECEIPT_NUDGE);

  // Awaiting receipt → Awaiting completion (tenant confirmed receipt): the [AUTO]
  // completion-check nudge fires 1:1 to the TENANT ~24h later. Tick + assert BEFORE
  // the next move (leaving the stage cancels the rung).
  await flow.teamMovesPlacementTo('Awaiting completion');
  await flow.devPlacementNudgeTick(hoursFromNow(25));
  await flow.expectOutboxMessageContaining(tenant, COMPLETION_NUDGE);

  // Awaiting completion → Awaiting approval (completed app is in the landlord's
  // hands): the [AUTO] approval-check nudge fires 1:1 to the LANDLORD ~24h later.
  await flow.teamMovesPlacementTo('Awaiting approval');
  await flow.devPlacementNudgeTick(hoursFromNow(25));
  await flow.expectOutboxMessageContaining(owner, APPROVAL_NUDGE);

  // --- RTA block -----------------------------------------------------------
  // KNOWN COLLAPSE (docs/issues/rta-documents-mms-unmodeled.md): the diagram's
  // `T->>A: RTA documents (photos or files, MMS)` inbound is not modeled — the
  // collect→review moves are bare stage transitions with no documents. The MMS
  // build path exists (see the tours ID gate); modeled in a later wave.
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
  // placement-deadline-model: leaving awaiting_landlord_submission RETIRED the +48h
  // rta_window DEADLINE ITEM. Stuck is no longer a deadline that takes the slot — it
  // is DERIVED from time-in-stage (no 'stuck_placement' deadline is armed) — so with
  // no other deadline pending the computed flat next_deadline is now ABSENT. (The
  // stuck signal surfaces via DERIVATION once time-in-stage passes the stage
  // threshold, not the instant this move lands; that RENDERED coexistence — stuck in
  // Follow-ups WHILE a hard clock is due in Needs-you-now — is proven in the
  // deadline-model spec below.)
  await flow.expectRtaClockCleared();
});

test('marked deviation — landlord denies at Awaiting approval → Lost (tenant Searching, unit Available, relay closed)', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { tenant, owner, unit } = await reachConvertedPlacement(flow, { tenant: 'Denied', owner: 'Nope' });
  // Landlord 1:1 exists — so we can PROVE no approval nudge fires after Lost.
  await flow.landlordTexts(owner, 'Reviewing.');

  await flow.teamMovesPlacementTo('Awaiting receipt confirmation');
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

test('marked deviation — 48h window BLOWN at Awaiting landlord submission → closing nudge + overdue RTA deadline on Today → late submit clears it', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { owner } = await reachConvertedPlacement(flow, { tenant: 'Late', owner: 'Slow' });
  // NO manufactured landlord 1:1 here: this landlord's only prior traffic was the
  // masked pool number (the DESIGNED flow), so no landlord_1to1 exists yet. The
  // rta_window_closing nudge below exercises CREATE-ON-DEMAND end-to-end — the
  // poller mints the 1:1 on first send (resolves placement-nudge-needs-landlord-1to1).

  // Walk to Awaiting landlord submission (no skip).
  await flow.teamMovesPlacementTo('Awaiting receipt confirmation');
  await flow.teamMovesPlacementTo('Awaiting completion');
  await flow.teamMovesPlacementTo('Awaiting approval');
  await flow.teamMovesPlacementTo('Collect RTA');
  await flow.teamMovesPlacementTo('Review RTA');
  await flow.teamMovesPlacementTo('Send RTA to landlord');
  await flow.teamMovesPlacementTo('Awaiting landlord submission');

  // The 48h clock is armed on the placement; ticking past the 36h rung fires the
  // closing nudge 1:1 to the landlord.
  await flow.expectRtaClockArmed();
  await flow.devPlacementNudgeTick(hoursFromNow(37));
  await flow.expectOutboxMessageContaining(owner, RTA_CLOSING_NUDGE);

  // BLOW the window: Today compares the deadline to the server wall clock (it can't
  // be ticked), so overwrite the rta_window to a PAST instant to simulate the 48h
  // elapsing — then the deadline surfaces OVERDUE on the Today board (needs_you_now).
  await flow.devBlowRtaWindow();
  await flow.expectRtaDeadlineOnBoard();

  // Recommit: late submission → Awaiting authority approval. The stage-scoped
  // rta_window is retired, so the overdue row is GONE from the board.
  await flow.teamMovesPlacementTo('Awaiting authority approval');
  await flow.expectPlacementStage('Awaiting authority approval');
  await flow.expectPlacementGoneFromBoard();
});

test('marked deviation — party backs out early at Awaiting receipt → Lost (bounce-back, relay closed)', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { tenant, unit } = await reachConvertedPlacement(flow, { tenant: 'Quitter', owner: 'Host' });

  await flow.teamMovesPlacementTo('Awaiting receipt confirmation');

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

test('placement-deadline-model — voucher + rta_window coexist (soonest-wins on Needs-you-now) and derived-stuck coexists with a hard clock', async ({
  page,
  request,
}) => {
  test.slow(); // full tour reach + a nine-stage walk + several board reads.
  const flow = new Scenario(page, request);
  await reachConvertedPlacement(flow, { tenant: 'Voucher', owner: 'Clock' });

  // (1) VOUCHER CLOCK. Staff records a PAST (expired) voucher date through the real
  // contact form. The inline voucher sync (deadline-model §6) arms the
  // `voucher_expiration` deadline on the active placement; being due, it surfaces in
  // Needs-you-now as the placement's soonest hard clock.
  await flow.teamSetsTenantVoucherExpiration(-2); // 2 days ago → expired/due
  await flow.expectVoucherDeadlineOnBoard();

  // (2) SOONEST-WINS. Walk (no skip) to Awaiting landlord submission — which arms the
  // +48h rta_window — then BLOW rta to an instant EARLIER than the voucher. rta_window
  // is now the placement's SOONEST due deadline, so Needs-you-now's single row for it
  // reads "RTA window closing" (per-placement dedup keeps the soonest). The two
  // deadline ITEMS are independent — the voucher is untouched underneath.
  await flow.teamMovesPlacementTo('Awaiting receipt confirmation');
  await flow.teamMovesPlacementTo('Awaiting completion');
  await flow.teamMovesPlacementTo('Awaiting approval');
  await flow.teamMovesPlacementTo('Collect RTA');
  await flow.teamMovesPlacementTo('Review RTA');
  await flow.teamMovesPlacementTo('Send RTA to landlord');
  await flow.teamMovesPlacementTo('Awaiting landlord submission');
  // NB: rta_window arms at +48h (future), but the voucher is already due (2d ago), so
  // the placement's computed SOONEST is still the voucher here — we don't assert
  // expectRtaClockArmed (that asserts rta is the soonest, which is false with a due
  // voucher pending). Blowing rta below to 5d ago makes IT the soonest.
  await flow.devBlowRtaWindow(new Date(Date.now() - 5 * 86_400_000).toISOString()); // 5d ago < voucher (2d ago)
  await flow.expectRtaDeadlineOnBoard();

  // (3) RE-SURFACE. Leave the stage → rta_window is RETIRED (stage-scoped). With only
  // the voucher left, the voucher clock re-surfaces as the placement's soonest due
  // deadline on Needs-you-now.
  await flow.teamMovesPlacementTo('Awaiting authority approval');
  await flow.expectVoucherDeadlineOnBoard();

  // (4) COEXISTENCE FIX. Make the placement STUCK (backdate stage_entered_at past the
  // stage threshold). Derived-stuck fires from time-in-stage REGARDLESS of the pending
  // hard clock: the placement now shows in Follow-ups (Stuck) AND Needs-you-now (the
  // due voucher) at once — the two signals no longer suppress each other, which is the
  // entire point of retiring the single overloaded deadline slot.
  await flow.devMakePlacementStuck(20); // > the 10-day awaiting_authority_approval threshold
  await flow.expectPlacementStuckInFollowUps();
  await flow.expectVoucherDeadlineOnBoard();
});
