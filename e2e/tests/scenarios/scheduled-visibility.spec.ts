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
  // rung upcoming, and a now-relative tourSchedule() run between 00:00 and
  // 08:00 local books a pre-08:00 tour whose morning_of is born skipped
  // (past_event) - the 00:00-08:00 wall-clock flake, root-caused 2026-08-04.
  const times = tourScheduleFullLadder();
  await flow.teamBooksTour(times);
  return { tenant, tenantId, unit, times };
}

test('Part A — the tour Reminders panel renders the armed ladder + NEXT rung on /tours/:id', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);
  const { unit, times } = await bookedSelfGuidedTour(flow, 'Ladder');

  // The whole ladder is armed and upcoming right after booking; confirmation
  // (dueAt = arm-time now) is the earliest → the highlighted NEXT rung.
  await flow.openTourReminders();
  await flow.expectReminderRung('confirmation', 'next');
  await flow.expectReminderRung('day_before', 'upcoming');
  await flow.expectReminderRung('morning_of', 'upcoming');
  await flow.expectReminderRung('en_route', 'upcoming');
  // no_show_checkin is no longer auto-armed (manual send only), so its rung never
  // appears in the panel. Assert its ABSENCE where expectReminderRung would look:
  // the Reminders card listitems, keyed by the staff label.
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
  ).toContainText(tourReminderBody('day_before', tourReminderContext(unit, times)));

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
  const { tenant, tenantId, unit, times } = await bookedSelfGuidedTour(flow, 'Upcomer');
  // The exact text this tour's day_before rung composes to - address + org-local
  // time - so both the Upcoming preview and the sent bubble are matched against
  // the real body rather than a template.
  const dayBefore = tourReminderBody('day_before', tourReminderContext(unit, times));

  // BEFORE any tick: the day_before rung is a pinned Upcoming item on the tenant's
  // timeline — its body, a "Tour reminder" tag, and a "sends in Nh · <abs>" line.
  // (The immediate confirmation rung rides the same section as "sending shortly".)
  await flow.expectUpcomingItem(tenantId, {
    bodyContains: dayBefore,
    source: 'tour_reminder',
  });

  // Tick past the day_before dueAt → the rung fires 1:1 (proof-of-send in the fake
  // thread), and it TRANSITIONS out of Upcoming into a real sent bubble.
  await flow.tickTourReminders(justAfter(times.dayBefore));
  await flow.expectReminderTo1to1('day_before', tenant);
  await flow.expectScheduledSent(tenantId, dayBefore);
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

  // The re-armed confirmation fires on a tick. Since the flip, a rung's body
  // carries its tour's TIME, so the fresh confirmation is textually DISTINCT from
  // the one sent above - its arrival at all is the re-arm proof (a stronger one
  // than the old "at least 2 identical copies": a mere re-label could not produce
  // a body composed off the new time). expectReminderTo1to1 composes from the
  // active tour, which teamReschedulesTour has already repointed.
  await flow.tickTourReminders();
  await flow.expectReminderTo1to1('confirmation', tenant);
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
    tourReminderBody('day_before', tourReminderContext(unit, times)),
  );

  // Tick past its dueAt → the poller refuses the send (honest suppression): the
  // day_before body never reaches the opted-out tenant. ABSENCE, so this rides the
  // kind-distinctive MARKER, not a composed body - a mis-composed exact string
  // would make "nothing arrived" true for the wrong reason.
  await flow.tickTourReminders(justAfter(times.dayBefore));
  await flow.expectNoOutboxMessageContaining(tenant, REMINDER_BODY_MARKERS.day_before);
});

test('(e) tenant nudge: a placement at Awaiting receipt shows an Upcoming nudge → tick → sent 1:1', async ({
  page,
  request,
}) => {
  test.slow(); // convert → walk to a nudged stage → tick.
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
