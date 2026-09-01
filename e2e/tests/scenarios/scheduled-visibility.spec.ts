// e2e/tests/scenarios/scheduled-visibility.spec.ts
//
// Scheduled-message visibility — the end-to-end proof for the two surfaces that
// make queued automated texts VISIBLE and HONEST:
//   - Part A: the tour Reminders panel on /tours/:id (the armed ladder, each
//     rung's state, the NEXT rung, and any will-be-skipped note).
//   - Part B: the pinned "Upcoming scheduled messages" section on a contact's 1:1
//     timeline (future tour reminders + placement nudges, each with a fire-time
//     affordance + honest suppression).
//
// The specs mirror the tours.spec / post-tour-application.spec discipline:
//   - Team acts through the REAL dashboard UI; inbound + pure setup use the API
//     seam. Self-clean isolation: fresh timestamped contacts, NO per-test reseed.
//   - The deterministic tick seams (POST /__dev/tour-reminders/tick,
//     POST /__dev/placement-nudges/tick) drive future→sent transitions; both are
//     GLOBAL and the worker also polls the wall clock, so EVERY arrival assertion
//     scopes to THIS test's phones, ticks ride pre-computed rung dueAts
//     (tourSchedule/justAfter) / transition-relative offsets (hoursFromNow), and
//     1:1 sends stay within the 10/min/conversation breaker budget.
import { test, expect } from '@playwright/test';
import {
  Scenario,
  freshTenant,
  tourSchedule,
  tourScheduleFullLadder,
  justAfter,
  hoursFromNow,
  tourReminderBody,
  tourReminderContext,
  REMINDER_BODY_MARKERS,
  REMINDER_KIND_LABELS,
  type Contact,
  type Unit,
} from '../../scenarios/steps.js';
import { postInboundSms } from '../../fixtures/fakeTwilio.js';
import { useScenarioBudget } from '../../support/scenarioBudget.js';

useScenarioBudget();

// The receipt-check nudge body (app/src/jobs/placementNudges.ts) — a distinctive
// substring pinned so a reword breaks the test loudly (mirrors post-tour-app.spec).
const RECEIPT_NUDGE = 'application come through';

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
 * Shared precondition: a typed, consented, `searching` tenant with a phone + an
 * available unit + a booked SELF-GUIDED tour (self_guided always routes reminders
 * 1:1, so the ladder surfaces on BOTH the tenant timeline and the tour panel).
 * Returns the cast + the booking's pre-computed rung dueAts. `consent:false`
 * skips consent so the caller can immediately opt the tenant out (Spec d).
 */
async function bookedSelfGuidedTour(
  flow: Scenario,
  label: string,
  opts: { consent?: boolean } = {},
): Promise<{ tenant: Contact; tenantId: string; unit: Unit; times: ReturnType<typeof tourSchedule> }> {
  await flow.login();
  const unit = await flow.seedAvailableUnit({ beds: 2 });
  const tenant = freshTenant(label);
  await flow.teamCreatesTenant({
    firstName: tenant.firstName,
    lastName: tenant.lastName,
    phone: tenant.phone,
    ...(opts.consent === false && { consent: false }),
  });
  const tenantId = flow.contactId();
  await flow.seedTenantSearching();
  await flow.tenantAsksToTour(unit);
  await flow.teamCreatesTourFromInterest(unit, 'Self-guided');
  // Full-ladder-safe booking (14:00 local, 2 days out): Part A asserts EVERY
  // rung upcoming. The fixed hour is still load-bearing, but NOT for the reason
  // it was: the 00:00-08:00 wall-clock flake (a now-relative tourSchedule()
  // booking a pre-08:00 tour whose 08:00-org-local morning_of was born skipped
  // past_event, root-caused 2026-08-04) CANNOT recur - the 2026-08-26 retiming
  // made morning_of a pure scheduledAt - 4h offset. What the fixed hour buys
  // now is that every rung instant is identical run to run (day_before 19:30
  // D-1 < morning_of 10:00 D < en_route 13:00 D < start 14:00 D), which is what
  // the quiet-hours case anchors its stored window to, and it keeps day_before
  // - the rung that INHERITED the wall-clock sensitivity - off whatever clock
  // the suite happens to run at. Full history: tourScheduleFullLadder's docblock
  // in e2e/scenarios/steps.ts.
  const times = tourScheduleFullLadder();
  await flow.teamBooksTour(times);
  return { tenant, tenantId, unit, times };
}

test('Part A — the tour Reminders panel renders the armed ladder + NEXT rung on /tours/:id', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { tenant, unit, times } = await bookedSelfGuidedTour(flow, 'Ladder');

  // The whole ladder is armed and upcoming right after booking. day_before is
  // the earliest rung -> the highlighted NEXT one. (It took that place on
  // 2026-08-31, when `confirmation` - whose dueAt was the arm instant, and so
  // always the earliest - stopped arming; the kind itself still renders, it is
  // simply never born any more.)
  await flow.openTourReminders();
  await flow.expectReminderRung('day_before', 'next');
  // The morning_of row is now found by the relabelled staff string
  // ('Morning of' -> '4 hours before', REMINDER_KIND_LABELS). Verified at the
  // relabel: nothing else the Reminders card renders contains "4 hours" - no
  // tour.* body says "hour" at all, and the nearest skip-reason label is
  // roster_unavailable's "gave up after an hour" - so the substring filter still
  // selects exactly this row.
  await flow.expectReminderRung('morning_of', 'upcoming');
  await flow.expectReminderRung('en_route', 'upcoming');
  // no_show_checkin is no longer auto-armed (manual send only), so its rung never
  // appears in the panel. Assert its ABSENCE where expectReminderRung would look:
  // the Reminders card listitems, keyed by the staff label.
  // RE-DERIVED 2026-08-26 against the new skip rules, because `booked_too_late`
  // writes a VISIBLE row where the old past-dueAt branch wrote none, so near-term
  // ladders got LONGER, not shorter: this count still holds because
  // no_show_checkin is absent from REMINDER_KINDS entirely - the arm loop never
  // reaches a skip rule for it - and in any case a 14:00 booking two days out
  // trips neither booked-too-late rule (day_before's RAW is ~19:30 D-1, far more
  // than 4h out; morning_of's rule needs the ARM to fall on the tour's own local
  // date). RE-DERIVED AGAIN 2026-08-31: the auto ladder is THREE rungs now that
  // `confirmation` no longer arms, and the three asserted above (day_before as
  // NEXT, morning_of, en_route) are the whole panel.
  const reminders = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Reminders' }) });
  await expect(
    reminders.getByRole('listitem').filter({ hasText: REMINDER_KIND_LABELS.no_show_checkin }),
  ).toHaveCount(0);

  // The rung PREVIEW is the real thing, not a template: the day_before row shows
  // the body the tenant will actually receive, carrying THIS tour's address and
  // its org-local date and time (spec section 8). Composed by the app's own
  // composer, so a copy change moves both sides together. NOTE: no zone-
  // DISTINGUISHING claim is made here - this box runs on America/New_York too,
  // so the browser and the org zone agree and only the TEXT is provable; the
  // composing-zone half is pinned by the app's unit tests.
  await expect(
    reminders.getByRole('listitem').filter({ hasText: REMINDER_KIND_LABELS.day_before }),
  ).toContainText(
    tourReminderBody(
      'day_before',
      tourReminderContext(unit, times, {
        tourType: 'self_guided',
        names: { tenantFirstName: tenant.firstName },
      }),
    ),
  );

  // Fire the earliest rung - the panel now reads it SENT, and morning_of is
  // still upcoming (a later rung the tick left untouched). The tick rides the
  // dueAt the SERVER armed (day_before is 19:30 ORG-local, which no host-local
  // mirror can compute) rather than a bare wall-clock tick: since the pause was
  // lifted the lane runs a live 30s worker, so a bare tick is no longer the only
  // thing that can move a rung. At 19:30 D-1 the two later rungs (10:00 and
  // 13:00 on tour day) are not due, so release supersession cannot retire the
  // rung being asserted - the same margin the (a)+(b) case below derives.
  await flow.tickTourReminders(justAfter(await flow.armedReminderDueAt('day_before')));
  await flow.openTourReminders();
  await flow.expectReminderRung('day_before', 'sent');
  await flow.expectReminderRung('morning_of', 'upcoming');
});

test('(a)+(b) tour reminder: future item on the tenant timeline → tick → leaves Upcoming, sends 1:1', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { tenant, tenantId, unit, times } = await bookedSelfGuidedTour(flow, 'Upcomer');
  // The exact text this tour's day_before rung composes to - address + org-local
  // time - so both the Upcoming preview and the sent bubble are matched against
  // the real body rather than a template.
  const dayBefore = tourReminderBody(
    'day_before',
    tourReminderContext(unit, times, {
      tourType: 'self_guided',
      names: { tenantFirstName: tenant.firstName },
    }),
  );

  // BEFORE any tick: the day_before rung is a pinned Upcoming item on the tenant's
  // timeline — its body, a "Tour reminder" tag, and an honest state line. Since
  // the 2026-08-20 hold-back that line reads "Paused" rather than a fire time:
  // the rung is armed and sendable, but nothing will fire it on its own. The
  // tick below still drives it, because the dev tick seam runs with the
  // hold-back off (see routes/dev.ts).
  await flow.expectUpcomingItem(tenantId, {
    bodyContains: dayBefore,
    source: 'tour_reminder',
  });

  // Tick past the day_before dueAt → the rung fires 1:1 (proof-of-send in the fake
  // thread), and it TRANSITIONS out of Upcoming into a real sent bubble. The
  // dueAt is READ BACK from the server (2026-08-26): day_before now fires 19:30
  // ORG-LOCAL the evening before, which no host-local mirror can compute.
  // SAFE AT ANY WALL CLOCK: this books via tourScheduleFullLadder() (14:00, two
  // days out), so at 19:30 D-1 the later rungs are morning_of 10:00 D and
  // en_route 13:00 D - neither is due yet, so release supersession cannot
  // retire the rung being asserted. day_before is now the EARLIEST rung in the
  // ladder as well (confirmation stopped arming 2026-08-31), so nothing at all
  // shares the batch with it.
  // HONEST ABOUT THE ZONE: timesFor builds its instants from HOST-local datetime
  // strings while 19:30 is ORG-local, so that ordering argument assumes host
  // zone == ORG_TIMEZONE. That assumption is PRE-EXISTING harness-wide (see the
  // note above about this box running on America/New_York); nothing in e2e/
  // asserts it. The TICK itself does not depend on it - it is read back from
  // the server - only the "nothing supersedes" margin does.
  await flow.tickTourReminders(justAfter(await flow.armedReminderDueAt('day_before')));
  await flow.expectReminderTo1to1('day_before', tenant);
  await flow.expectScheduledSent(tenantId, dayBefore);
});

test('(c) reschedule: tick a rung → panel states → reschedule cancels + re-arms a fresh ladder', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { tenant } = await bookedSelfGuidedTour(flow, 'Rebooker');

  // Fire the earliest rung, then read the panel: day_before SENT, morning_of
  // still upcoming. The tick rides the SERVER's stored dueAt (19:30 org-local
  // the evening before this D+2 tour), where nothing later is due yet, so
  // release supersession cannot touch it.
  await flow.tickTourReminders(justAfter(await flow.armedReminderDueAt('day_before')));
  await flow.expectReminderTo1to1('day_before', tenant);
  await flow.openTourReminders();
  await flow.expectReminderRung('day_before', 'sent');
  await flow.expectReminderRung('morning_of', 'upcoming');

  // Reschedule to a new time → the pending ladder is CANCELED and a fresh one is
  // armed off the new time. The panel now shows an old canceled rung AND a fresh
  // upcoming ladder whose day_before is the new NEXT rung.
  //
  // RE-DERIVED 2026-08-26 for the retimed ladder, and AGAIN 2026-08-31 when
  // `confirmation` stopped arming. Both halves of the old derivation moved:
  //  - WHICH ROW IS CANCELED. The proof used to fire confirmation and then
  //    assert the old day_before canceled. Confirmation is gone, so the setup
  //    tick now consumes day_before itself and the surviving PENDING old rungs
  //    are morning_of and en_route - morning_of carries the `canceled`
  //    assertion. (A rung that is already SENT is not cancelable, which is
  //    exactly why the assertion had to move rather than be re-pointed.)
  //  - WHICH ROW IS NEXT. `next` is the earliest-dueAt UPCOMING row
  //    (routes/tourReminders.ts). With no arm-instant rung left, that is the
  //    fresh day_before, and the OLD day_before is SENT rather than upcoming -
  //    so the two rows sharing the label are told apart by state, which
  //    expectReminderRung's filters do.
  // The fresh ladder arms in full off now+72h: day_before's RAW is 19:30 the
  // evening before that date, roughly 2.8 days out, so the booked-too-late rule
  // (RAW minus 4h) cannot fire, and morning_of's rule needs the ARM instant to
  // fall on the tour's own local date, which +72h never is.
  await flow.teamReschedulesTour(tourSchedule(72));
  await flow.openTourReminders();
  await flow.expectReminderRung('morning_of', 'canceled'); // the retired old rung
  await flow.expectReminderRung('day_before', 'next'); // the fresh armed ladder

  // The re-armed day_before fires on a tick. Since the flip, a rung's body
  // carries its tour's TIME, so the fresh rung is textually DISTINCT from the one
  // sent above - its arrival at all is the re-arm proof (a stronger one than the
  // old "at least 2 identical copies": a mere re-label could not produce a body
  // composed off the new time). expectReminderTo1to1 composes from the active
  // tour, which teamReschedulesTour has already repointed, and
  // armedReminderDueAt selects on state === 'upcoming', so it reads the FRESH
  // row's dueAt and not the sent one's.
  await flow.tickTourReminders(justAfter(await flow.armedReminderDueAt('day_before')));
  await flow.expectReminderTo1to1('day_before', tenant);
});

test('(d) suppression: an opted-out tenant → the Upcoming item is marked will-be-skipped → tick sends nothing', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  // Self-seed WITHOUT consent, then opt the tenant out via a real inbound STOP
  // (sets the contact's sms_opt_out) BEFORE booking arms the ladder.
  const { tenant, tenantId, unit, times } = await bookedSelfGuidedTour(flow, 'Stopper', {
    consent: false,
  });
  await postInboundSms(request, {
    from: tenant.phone,
    body: 'STOP',
    messageSid: `sched-stop-${Date.now()}`,
  });

  // The day_before rung still ARMS + surfaces in Upcoming, but honestly flagged:
  // "Will be skipped — contact opted out".
  await flow.expectUpcomingSuppressed(
    tenantId,
    tourReminderBody(
      'day_before',
      tourReminderContext(unit, times, {
        tourType: 'self_guided',
        names: { tenantFirstName: tenant.firstName },
      }),
    ),
  );

  // Tick past its dueAt → the poller refuses the send (honest suppression): the
  // day_before body never reaches the opted-out tenant. ABSENCE, so this rides the
  // kind-distinctive MARKER, not a composed body - a mis-composed exact string
  // would make "nothing arrived" true for the wrong reason. Same read-back and
  // the same supersession safety as (a)+(b) above.
  await flow.tickTourReminders(justAfter(await flow.armedReminderDueAt('day_before')));
  await flow.expectNoOutboxMessageContaining(tenant, REMINDER_BODY_MARKERS.day_before);
});

test('(e) tenant nudge: a placement at Awaiting receipt shows an Upcoming nudge → tick → sent 1:1', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { tenant, tenantId } = await bookedSelfGuidedTour(flow, 'Applicant');

  // Toured → exit gate YES, which auto-converts into the placement (the
  // Post-Tour spine's entry) in the same step.
  await flow.teamMarksToured();
  await flow.teamRecordsExitGate('yes');
  await flow.expectTourAutoConverted();

  // Send application → Awaiting receipt arms the [AUTO] receipt-check nudge 1:1 to
  // the TENANT (~24h out) — it surfaces as a pinned Upcoming "Nudge" item.
  await flow.teamMovesPlacementTo('Awaiting receipt confirmation');
  await flow.expectUpcomingItem(tenantId, { bodyContains: RECEIPT_NUDGE, source: 'placement_nudge' });

  // Tick ~25h past the transition → the nudge fires 1:1 and leaves Upcoming.
  await flow.devPlacementNudgeTick(hoursFromNow(25));
  await flow.expectOutboxMessageContaining(tenant, RECEIPT_NUDGE);
  await flow.expectScheduledSent(tenantId, RECEIPT_NUDGE);
});
