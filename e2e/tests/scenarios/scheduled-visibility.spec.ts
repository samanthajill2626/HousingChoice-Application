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
import { test } from '@playwright/test';
import {
  Scenario,
  freshTenant,
  tourSchedule,
  justAfter,
  hoursFromNow,
  TOUR_REMINDER_BODIES,
  type Contact,
  type Unit,
} from '../../scenarios/steps.js';
import { postInboundSms } from '../../fixtures/fakeTwilio.js';

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
  const times = tourSchedule();
  await flow.teamBooksTour(times);
  return { tenant, tenantId, unit, times };
}

test('Part A — the tour Reminders panel renders the armed ladder + NEXT rung on /tours/:id', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  await bookedSelfGuidedTour(flow, 'Ladder');

  // The whole ladder is armed and upcoming right after booking; confirmation
  // (dueAt = arm-time now) is the earliest → the highlighted NEXT rung.
  await flow.openTourReminders();
  await flow.expectReminderRung('confirmation', 'next');
  await flow.expectReminderRung('day_before', 'upcoming');
  await flow.expectReminderRung('morning_of', 'upcoming');
  await flow.expectReminderRung('en_route', 'upcoming');
  await flow.expectReminderRung('no_show_checkin', 'upcoming');

  // Fire the confirmation rung → the panel now reads it SENT, and day_before is
  // still upcoming (a future rung the tick left untouched).
  await flow.tickTourReminders();
  await flow.openTourReminders();
  await flow.expectReminderRung('confirmation', 'sent');
  await flow.expectReminderRung('day_before', 'upcoming');
});

test('(a)+(b) tour reminder: future item on the tenant timeline → tick → leaves Upcoming, sends 1:1', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { tenant, tenantId, times } = await bookedSelfGuidedTour(flow, 'Upcomer');

  // BEFORE any tick: the day_before rung is a pinned Upcoming item on the tenant's
  // timeline — its body, a "Tour reminder" tag, and a "sends in Nh · <abs>" line.
  // (The immediate confirmation rung rides the same section as "sending shortly".)
  await flow.expectUpcomingItem(tenantId, {
    bodyContains: TOUR_REMINDER_BODIES.day_before,
    source: 'tour_reminder',
  });

  // Tick past the day_before dueAt → the rung fires 1:1 (proof-of-send in the fake
  // thread), and it TRANSITIONS out of Upcoming into a real sent bubble.
  await flow.tickTourReminders(justAfter(times.dayBefore));
  await flow.expectReminderTo1to1('day_before', tenant);
  await flow.expectScheduledSent(tenantId, TOUR_REMINDER_BODIES.day_before);
});

test('(c) reschedule: tick a rung → panel states → reschedule cancels + re-arms a fresh ladder', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { tenant } = await bookedSelfGuidedTour(flow, 'Rebooker');

  // Fire the confirmation rung, then read the panel: confirmation SENT, day_before
  // still upcoming.
  await flow.tickTourReminders();
  await flow.expectReminderTo1to1('confirmation', tenant);
  await flow.openTourReminders();
  await flow.expectReminderRung('confirmation', 'sent');
  await flow.expectReminderRung('day_before', 'upcoming');

  // Reschedule to a new time → the pending ladder is CANCELED and a fresh one is
  // armed off the new time. The panel now shows an old canceled rung AND a fresh
  // upcoming ladder whose confirmation is the new NEXT rung.
  await flow.teamReschedulesTour(tourSchedule(72));
  await flow.openTourReminders();
  await flow.expectReminderRung('day_before', 'canceled'); // the retired old rung
  await flow.expectReminderRung('confirmation', 'next'); // the fresh armed ladder

  // The re-armed confirmation fires on a tick — a SECOND confirmation copy 1:1
  // proves the ladder truly re-armed (not merely re-labeled).
  await flow.tickTourReminders();
  await flow.expectReminderTo1to1('confirmation', tenant, 2);
});

test('(d) suppression: an opted-out tenant → the Upcoming item is marked will-be-skipped → tick sends nothing', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  // Self-seed WITHOUT consent, then opt the tenant out via a real inbound STOP
  // (sets the contact's sms_opt_out) BEFORE booking arms the ladder.
  const { tenant, tenantId, times } = await bookedSelfGuidedTour(flow, 'Stopper', { consent: false });
  await postInboundSms(request, {
    from: tenant.phone,
    body: 'STOP',
    messageSid: `sched-stop-${Date.now()}`,
  });

  // The day_before rung still ARMS + surfaces in Upcoming, but honestly flagged:
  // "Will be skipped — contact opted out".
  await flow.expectUpcomingSuppressed(tenantId, TOUR_REMINDER_BODIES.day_before);

  // Tick past its dueAt → the poller refuses the send (honest suppression): the
  // day_before body never reaches the opted-out tenant.
  await flow.tickTourReminders(justAfter(times.dayBefore));
  await flow.expectNoOutboxMessageContaining(tenant, TOUR_REMINDER_BODIES.day_before);
});

test('(e) tenant nudge: a placement at Awaiting receipt shows an Upcoming nudge → tick → sent 1:1', async ({
  page,
  request,
}) => {
  test.slow(); // convert → walk to a nudged stage → tick.
  const flow = new Scenario(page, request);
  const { tenant, tenantId } = await bookedSelfGuidedTour(flow, 'Applicant');

  // Toured → exit gate YES → convertible → placement (the Post-Tour spine's entry).
  await flow.teamMarksToured();
  await flow.teamRecordsExitGate('yes');
  await flow.expectTourConvertible();
  await flow.teamConvertsTourToPlacement();

  // Send application → Awaiting receipt arms the [AUTO] receipt-check nudge 1:1 to
  // the TENANT (~24h out) — it surfaces as a pinned Upcoming "Nudge" item.
  await flow.teamMovesPlacementTo('Awaiting receipt');
  await flow.expectUpcomingItem(tenantId, { bodyContains: RECEIPT_NUDGE, source: 'placement_nudge' });

  // Tick ~25h past the transition → the nudge fires 1:1 and leaves Upcoming.
  await flow.devPlacementNudgeTick(hoursFromNow(25));
  await flow.expectOutboxMessageContaining(tenant, RECEIPT_NUDGE);
  await flow.expectScheduledSent(tenantId, RECEIPT_NUDGE);
});
