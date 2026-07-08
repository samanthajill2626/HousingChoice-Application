// e2e/tests/scenarios/tours.spec.ts
//
// One test() per leaf path of documentation/tours-sequence.mermaid — the tour
// coordination flow that picks up when a searching tenant says YES to touring a
// specific unit (Sending Unit's exit) and ends at the exit gate. Reads as the
// diagram: each line is a verb from e2e/scenarios/steps.ts. Coordinator role is
// "Team", never the founder's name. Self-clean isolation: fresh timestamped
// contacts, no per-test reseed.
//
// Structural rules this suite encodes (documentation/tours-sequence-writeup.md):
//   - The tour record is created at INTEREST, with NO time — booking (setting
//     the time) is the moment the confirmation + reminder ladder fire.
//   - Masked relay groups are Team-created BY HAND (a TourDetail button), never
//     auto-created; the tenant↔landlord/PM time negotiation happens INSIDE the
//     group, each message relayed masked ("Name: body" from the pool number).
//   - Reminders route to the GROUP for landlord-led/PM tours; to the tenant 1:1
//     for self-guided (always) and for a landlord-led tour with NO group.
//   - Self-guided ID gate: NO ID, NO code — ever (asserted as gate ORDERING).
//   - Tours are separate from placements: the exit gate records the decision
//     only (YES → convertible; NO → close). No placement is created and the
//     tenant stays `searching` on BOTH branches.
//
// Reminder-tick discipline: POST /__dev/tour-reminders/tick is GLOBAL (it fires
// every due row in the DB) and the worker ALSO polls on the real clock — so all
// arrival assertions scope to THIS test's phones, tick `now`s ride pre-computed
// rung dueAts (tourSchedule/justAfter), and 1:1 rungs stay within the send
// breaker's 10/min/conversation budget.
import { test } from '@playwright/test';
import {
  Scenario,
  freshLandlord,
  freshTenant,
  tourSchedule,
  justAfter,
  type Contact,
  type Unit,
} from '../../scenarios/steps.js';

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

/**
 * Shared precondition (the diagram's "picks up from Sending Unit"): a typed,
 * consented, `searching` tenant with a phone + a property owner contact WITH a
 * phone + an available unit owned by that contact. The owner is the landlord for
 * landlord-led tours and the PM for pm_team tours — Phase 1 models the PM as the
 * unit's owning landlord-typed contact, because the tour-relay auto-resolve
 * pulls [tenant, unit.landlordId] (there is no separate PM slot on a unit).
 */
async function searchingTenantOwnerUnit(
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
  return { tenant, owner, ownerId, unit };
}

test('landlord-led: interest → group negotiation → booked → group reminders → toured → exit YES (convertible, no placement, still searching)', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { tenant, owner, ownerId, unit } = await searchingTenantOwnerUnit(flow, {
    tenant: 'Tourist',
    owner: 'Shower',
  });

  // Tour interest → the tour record, tenant + unit, NO time yet (the anchor).
  await flow.tenantAsksToTour(unit);
  await flow.teamCreatesTourFromInterest(unit, 'Landlord-led');

  // [MANUAL] Open the masked relay group on the tour → [AUTO] intros to everyone.
  await flow.teamOpensTourGroup();
  await flow.expectGroupIntros([tenant, owner]);

  // Membership shows on BOTH contact files (the "Group texts" card): the
  // tenant's file names the owner, the owner's file names the tenant — each
  // row linking to the owning tour's detail page.
  await flow.expectGroupOnContactFile(owner);
  await flow.expectGroupOnContactFile(tenant, ownerId);

  // The time negotiation happens IN the group — both directions, masked.
  await flow.partyProposesTimeInGroup(tenant, 'Could we do Saturday around 2pm?');
  await flow.expectRelayedInGroup(owner, tenant, 'Could we do Saturday around 2pm?');
  await flow.partyProposesTimeInGroup(owner, 'Saturday 2pm works for me.', 'landlord');
  await flow.expectRelayedInGroup(tenant, owner, 'Saturday 2pm works for me.');

  // [MANUAL] Booking = setting the agreed time → [AUTO] ladder arms; reminders
  // land in the GROUP (both members, from the pool number).
  const times = tourSchedule();
  await flow.teamBooksTour(times);
  await flow.tickTourReminders();
  await flow.expectReminderInGroup('confirmation', [tenant, owner]);
  await flow.tickTourReminders(justAfter(times.dayBefore));
  await flow.expectReminderInGroup('day_before', [tenant, owner]);

  // Tour day: the tenant is on the way → the landlord gets the heads-up in-group.
  await flow.tenantSendsOnMyWay();
  await flow.expectOnMyWayInGroup(owner);

  // [MANUAL] Log the tour outcome (toured), then collect feedback 1:1.
  await flow.teamMarksToured();
  await flow.teamAsksFeedback();
  await flow.tenantAnswers('Loved it — I want to move forward!');
  // Assert on a phrase unique to the REPLY — the timeline also shows Team's
  // feedback ask, so a loose /move forward/ would double-match (strict mode).
  await flow.expectInboundRelayedToTeam(/Loved it/i);

  // Exit gate YES: convertible — and NOTHING else moves (no placement, tenant
  // stays searching; conversion belongs to Post-Tour & Application).
  await flow.teamRecordsExitGate('yes');
  await flow.expectTourConvertible();
  await flow.expectNoPlacement();
  await flow.expectTenantStillSearching();
});

test('PM-team: same shape with the PM in the landlord slot → exit NO (not a fit, closed, still searching)', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  // Phase 1 models the PM as the unit's owning landlord-typed contact (the
  // relay auto-resolve pulls the unit's landlordId) — see the setup helper.
  const { tenant, owner: pm, unit } = await searchingTenantOwnerUnit(flow, {
    tenant: 'Prospect',
    owner: 'Pm',
  });

  await flow.tenantAsksToTour(unit);
  await flow.teamCreatesTourFromInterest(unit, 'PM team');

  // Same shape as landlord-led: hand-opened masked group, PM in place of the
  // landlord; negotiation relayed masked in the group.
  await flow.teamOpensTourGroup();
  await flow.expectGroupIntros([tenant, pm]);
  await flow.partyProposesTimeInGroup(pm, 'Our showing slots are Mon 10am or Wed 4pm.', 'pm');
  await flow.expectRelayedInGroup(tenant, pm, 'Our showing slots are Mon 10am or Wed 4pm.');
  await flow.partyProposesTimeInGroup(tenant, 'Wednesday 4pm please!');
  await flow.expectRelayedInGroup(pm, tenant, 'Wednesday 4pm please!');

  // Book → the confirmation lands in the GROUP (pm_team routes like landlord-led).
  const times = tourSchedule();
  await flow.teamBooksTour(times);
  await flow.tickTourReminders();
  await flow.expectReminderInGroup('confirmation', [tenant, pm]);

  // Toured -> exit gate NO -> the same PATCH closes the tour (not a fit). The
  // 'confirmed' status was removed 2026-07-08: scheduled -> toured directly.
  await flow.teamMarksToured();
  await flow.teamRecordsExitGate('no');
  await flow.expectTourClosedNotAFit();

  // Re-match: the tenant stays searching (hand back to Sending Unit).
  await flow.expectTenantStillSearching();
});

test('self-guided: windows 1:1 (no group) → booked → 1:1 reminders → ID gate before the code → toured', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { tenant, unit } = await searchingTenantOwnerUnit(flow, {
    tenant: 'Walker',
    owner: 'Lockbox',
  });
  const LOCKBOX_CODE = '4711#';

  await flow.tenantAsksToTour(unit);
  await flow.teamCreatesTourFromInterest(unit, 'Self-guided');

  // The rebuilt page: a self-guided tour opens on the Tenant channel (no group)
  // and the Guidance card leads with the bolded ID-gate rule.
  await flow.expectSelfGuidedTourPage();

  // No mutual meeting time means usually NO group thread. The 'Open group text'
  // button still shows (an admin MAY hand-create one), so assert NON-EXISTENCE:
  // no groupThreadId on the tour + no pool-number traffic to the tenant.
  await flow.expectNoTourGroup();

  // Scheduling happens 1:1: Team offers windows, the tenant picks one.
  await flow.teamOffersTourWindows('Lockbox tour windows: Sat 10-12 or Sun 1-3.');
  await flow.tenantPicksWindow('Sun 1-3 works for me');

  // Book → confirmation arrives 1:1 from the APP number (self-guided never
  // routes to a group, per the founder rule).
  const times = tourSchedule();
  await flow.teamBooksTour(times);
  await flow.tickTourReminders();
  await flow.expectReminderTo1to1('confirmation', tenant);

  // The ID gate, before access: ask → (no code yet!) → ID arrives (MMS) → Team
  // reviews it on the timeline → only THEN the code goes out. NO ID, NO code.
  await flow.teamRequestsPhotoId();
  await flow.expectNoLockboxCodeYet(LOCKBOX_CODE);
  await flow.tenantSendsPhotoId();
  await flow.teamSendsLockboxCode(LOCKBOX_CODE);

  // The en-route nudge fires 1:1 as the window approaches (earlier rungs ride
  // along in the same tick — unasserted noise, within the breaker budget).
  await flow.tickTourReminders(justAfter(times.enRoute));
  await flow.expectReminderTo1to1('en_route', tenant);

  // The tenant tours via the code; Team logs the outcome.
  await flow.teamMarksToured();
});

test('no-show: booked (no group → 1:1 fallback) → check-in fires → logged no-show → rescheduled (ladder re-arms)', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { tenant, unit } = await searchingTenantOwnerUnit(flow, {
    tenant: 'Ghost',
    owner: 'Patient',
  });

  await flow.tenantAsksToTour(unit);
  // Landlord-led WITHOUT opening a group — exercises the reminder 1:1 fallback
  // (a non-self-guided tour with no usable group must never lose a reminder).
  await flow.teamCreatesTourFromInterest(unit, 'Landlord-led');

  const times = tourSchedule();
  await flow.teamBooksTour(times);
  await flow.tickTourReminders();
  await flow.expectReminderTo1to1('confirmation', tenant);

  // The tenant never shows: 30m past the booked time the [AUTO] no-show
  // check-in asks about rescheduling (earlier rungs ride along, unasserted).
  await flow.tickTourReminders(justAfter(times.noShowCheckin));
  await flow.expectReminderTo1to1('no_show_checkin', tenant);

  // Team logs the no-show, then reschedules — no-show tours stay reschedulable,
  // and rescheduling cancels + RE-ARMS the ladder off the new time: a FRESH
  // confirmation (the 2nd in this thread) proves the re-arm.
  await flow.teamMarksNoShow();
  const newTimes = tourSchedule(72);
  await flow.teamReschedulesTour(newTimes);
  await flow.tickTourReminders();
  await flow.expectReminderTo1to1('confirmation', tenant, 2);
});

// Activity coverage: each surfaced tour transition dual-writes a tenant activity
// event (→ contact timeline pin, deep-linked to the tour) + a units# audit row.
// These two tests assert the TENANT-timeline surface for the lifecycle pins.
test('activity coverage: booked + toured tour pins land on the tenant timeline (deep-linked to the tour)', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { unit } = await searchingTenantOwnerUnit(flow, { tenant: 'Milestone', owner: 'Pinner' });

  await flow.tenantAsksToTour(unit);
  await flow.teamCreatesTourFromInterest(unit, 'Self-guided');

  // Book → 'scheduled' → a `tour_scheduled` pin.
  await flow.teamBooksTour(tourSchedule());
  await flow.expectTourMilestoneOnTenantTimeline('Tour scheduled');

  // Mark toured → a `tour_took_place` pin.
  await flow.teamMarksToured();
  await flow.expectTourMilestoneOnTenantTimeline('Tour took place');
});

test('activity coverage: a canceled tour pins on the tenant timeline', async ({ page, request }) => {
  const flow = new Scenario(page, request);
  const { unit } = await searchingTenantOwnerUnit(flow, { tenant: 'Caller', owner: 'Offit' });

  await flow.tenantAsksToTour(unit);
  await flow.teamCreatesTourFromInterest(unit, 'Self-guided');
  await flow.teamBooksTour(tourSchedule());

  // Cancel → a `tour_canceled` pin.
  await flow.teamCancelsTour();
  await flow.expectTourMilestoneOnTenantTimeline('Tour canceled');
});

// The page-driven arc: walk the WHOLE sequence THROUGH the rebuilt TourDetail
// page (not just the API) - the two-pane conversation switcher (group send +
// relay fan-out, tenant 1:1), the header CTA ladder (Book -> Mark toured ->
// Record outcome -> Start placement), and the Outcome + Activity cards.
test('page arc: create -> book (CTA modal) -> group tab fans out -> tenant 1:1 -> toured -> outcome YES -> start placement -> Activity + placement link', async ({
  page,
  request,
}) => {
  test.slow(); // a full page-driven walk with a relay fan-out + a conversion.
  const flow = new Scenario(page, request);
  const { tenant, owner, unit } = await searchingTenantOwnerUnit(flow, {
    tenant: 'Arc',
    owner: 'Host',
  });

  // Interest -> a timeless 'requested' tour; the page shows Requested + Not booked.
  await flow.tenantAsksToTour(unit);
  await flow.teamCreatesTourFromInterest(unit, 'Landlord-led');

  // Open the masked group ON the page (the Group tab empty state), then send from
  // the Group tab -> the relay fans the message out to BOTH members.
  await flow.teamOpensTourGroup();
  await flow.expectGroupIntros([tenant, owner]);
  await flow.teamSendsInGroupTab('Are you both set for the visit?', [tenant, owner]);

  // The Tenant channel tab shows the tenant 1:1 (their tour-interest inbound).
  await flow.expectTenantTabShows1to1(/would like to tour/i);

  // Book via the header CTA modal -> Scheduled -> Mark toured (CTA) -> Record
  // outcome YES (CTA modal) -> convertible.
  await flow.teamBooksTour(tourSchedule());
  await flow.teamMarksToured();
  await flow.teamRecordsExitGate('yes');
  await flow.expectTourConvertible();

  // Start placement (CTA) navigates to the new placement; the tour then links back.
  await flow.teamConvertsTourToPlacement();
  await flow.expectTourShowsPlacementLink();

  // The Activity card tells the whole story (group opened, booked, toured,
  // outcome, converted). Order-independent presence check.
  await flow.expectTourActivityRows([
    'Group text opened',
    'Tour scheduled',
    'Tour took place',
    'Outcome recorded',
    'Converted to placement',
  ]);
});

// Mobile (M1): the rebuilt page leads with DETAILS on a 360px viewport (unlike the
// contact page, which leads with comms), and the primary CTA stays reachable
// without horizontal scroll.
test('mobile: the tour page opens on Details with the primary CTA in-viewport (360px)', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { unit } = await searchingTenantOwnerUnit(flow, { tenant: 'Mobi', owner: 'Narrow' });
  await flow.tenantAsksToTour(unit);
  await flow.teamCreatesTourFromInterest(unit, 'Landlord-led');

  await flow.expectMobileDetailsFirst();
});
