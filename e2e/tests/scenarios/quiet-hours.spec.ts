// e2e/tests/scenarios/quiet-hours.spec.ts
//
// Quiet hours + Send now - the end-to-end proof of the promise the feature
// makes: an automated text NEVER goes out inside the org's quiet window, it is
// DEFERRED (never dropped) until the window ends, and a human can always push
// one out by hand right now.
//
//   1. Settings round-trip: the admin-only "Quiet hours" section on the System
//      tab shows the stored window and persists an edit through the API.
//   2. Defer + release: a due rung ticked at an org-local instant INSIDE the
//      window sends nothing and is labelled "Will wait"; ticked again outside
//      the window it sends for real.
//   3. Send now: the same rung, still inside the window, goes out immediately
//      on a human click (the force-send bypass).
//
// Conventions mirror scheduled-visibility.spec.ts: Team acts through the REAL
// dashboard UI, inbound + pure setup ride the API seam, contacts are fresh and
// timestamped (no per-test reseed), and proof-of-send is asserted against the
// fake-twilio thread store.
//
// TIMING CONTRACT (the part that makes this deterministic at ANY wall clock).
// The PROMISE is unchanged by the 2026-08-26 retiming. What changed is that the
// two send tests now anchor their stored window DIFFERENTLY, because they prove
// different things:
//   - Test (2) (defer + release) needs the RUNG's dueAt inside the stored window
//     at tick time. day_before now fires at 19:30 ORG-LOCAL the evening before
//     the tour - a FIXED local time of day - so a fixed org-local window around
//     it contains it at ANY wall clock: QUIET_AROUND_DAY_BEFORE. The old trick
//     ("day_before is ~24h out, so it lands at the same local time of day as
//     windowAroundNow()") died with the sched-24h offset.
//   - Test (3) (Send now) needs the WALL CLOCK inside the stored window: the
//     panel's suppression estimate for an already-due rung and the force-send's
//     quiet-hours BYPASS are both wall-clock facts, and the test never ticks. It
//     KEEPS windowAroundNow() (a 4-hour window centred on now, in ORG-local
//     time, so the host's own timezone is irrelevant). Re-anchoring it to the
//     rung would leave no window over the wall clock and so nothing for the
//     bypass to bypass - a vacuous proof at every wall clock outside
//     17:30-21:30 org-local.
//   - No tick instant is ever computed host-side. 19:30 is ORG-local and this
//     host-local file cannot compute it, so BOTH of test (2)'s ticks are derived
//     from the dueAt the SERVER armed (Scenario.armedReminderDueAt): correct by
//     construction. The defer tick is 1s past it (19:30:01 org-local, inside the
//     window) and the release tick 5h past it (00:30 org-local, outside it) -
//     with margin for a DST shift either way.
//   - The ladder is armed with quiet hours OFF so the stored dueAts are
//     UN-CLAMPED (the legacy row shape the fire-time backstop exists for);
//     arming under an enabled window would clamp them out of it and there would
//     be nothing left to defer.
//   - Only ONE rung of the tour is ever due in an ASSERTED tick. This bullet
//     used to argue that the assertions ride day_before because it is "the LAST
//     due rung, which nothing can supersede" - the retiming FALSIFIED that. At
//     19:30 the evening before, day_before is the EARLIEST rung of the ladder,
//     exactly the kind release supersession retires. The argument is now about
//     the TICK INSTANTS, not the rung order: the booking is
//     tourScheduleFullLadder(2) (14:00, two days out), so the next rung up,
//     morning_of, is due 10:00 on TOUR DAY - after the defer tick (19:30:01 the
//     evening before) AND after the release tick (00:30 tour day). No later rung
//     is ever in either batch, so nothing supersedes day_before. (The defer
//     batch now holds day_before ALONE: `confirmation`, whose dueAt was the arm
//     instant, used to share it and be retired by supersession as the earlier
//     rung - it stopped arming on 2026-08-31, so there is no longer anything
//     beside day_before to reason about.)
//
// LANE HYGIENE: the lean seed ships quiet hours OFF (worklist A1) so every other
// spec stays time-of-day independent. This file turns it on explicitly and puts
// it back - defensively in beforeAll and always in afterAll.
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import {
  Scenario,
  freshTenant,
  tourScheduleFullLadder,
  justAfter,
  REMINDER_BODY_MARKERS,
  REMINDER_KIND_LABELS,
  type Contact,
} from '../../scenarios/steps.js';
import { expectTodayReady } from '../../support/today.js';
import { useScenarioBudget } from '../../support/scenarioBudget.js';

useScenarioBudget();

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

/** The seeded ADMIN persona (dev.ts maps this email to role 'admin'). The System
 *  tab and PUT /api/settings are admin-only, and an admin can drive every step a
 *  VA can, so the whole file runs as the founder. */
const ADMIN_EMAIL = 'founder@example.com';

/** The org timezone the backend evaluates the window in (settingsRepo default).
 *  Every window here is computed in THIS zone, never the host's. */
const ORG_TZ = 'America/New_York';

/** The rendered separator in the suppression note. Written as a char code so this
 *  source line stays pure ASCII (worklist A14) while the assertion still pins the
 *  exact string the dashboard renders. */
const EM_DASH = String.fromCharCode(0x2014);

/** The deferral note as RENDERED by RemindersPanel: quiet hours is a WAIT, not a
 *  skip - if this ever reverts to "Will be skipped" the promise is broken.
 *
 *  REACHABLE AGAIN since 2026-08-31: the manual-only hold-back that outranked it
 *  from 2026-08-20 is lifted (MANUAL_ONLY_REMINDER_KINDS is empty), so an
 *  auto-armed rung held by the window chips this once more - which is what test
 *  (2) below asserts, with the pause note asserted ABSENT so it stays a
 *  precedence proof rather than "some note rendered". */
const QUIET_NOTE = `Will wait ${EM_DASH} quiet hours`;

/** The pause note, kept ONLY as a negative: nothing should chip it now that
 *  MANUAL_ONLY_REMINDER_KINDS is empty, and a rung that does is either a
 *  re-pause nobody announced or the precedence regressing. */
const PAUSED_NOTE = `Paused ${EM_DASH} send manually`;

/** The product default window (settingsRepo DEFAULT_ORG_SETTINGS) with the
 *  feature OFF - the lean seed's posture, and what this file restores. */
const QUIET_OFF = {
  quietHoursEnabled: false,
  quietHoursStart: '21:00',
  quietHoursEnd: '08:00',
} as const;

/** A settings patch limited to the quiet-hours fields. */
interface QuietPatch {
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
}

/** "HH:MM" of `at` in the ORG timezone (not the host's) - the shape the API
 *  stores and the Settings inputs render. */
function orgLocalHhMm(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ORG_TZ,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const raw = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const hh = raw === '24' ? '00' : raw; // some ICU builds render midnight as 24
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hh}:${mm}`;
}

/**
 * A REAL quiet window centred on the wall clock: [now-2h, now+2h] in org-local
 * time. Wide enough that the whole test runs inside it, narrow enough that an
 * instant 5h later is comfortably OUTSIDE it even if a DST change shifts the
 * org-local clock by an hour. Never zero-length (the API rejects start === end).
 *
 * TEST (3) ONLY since 2026-08-26 (see the timing contract): a quiet-hours BYPASS
 * is provable only while the WALL CLOCK is inside a stored window, so this stays.
 * Test (2) anchors to the RUNG instead - QUIET_AROUND_DAY_BEFORE below.
 */
function windowAroundNow(): QuietPatch {
  const base = Date.now();
  return {
    quietHoursEnabled: true,
    quietHoursStart: orgLocalHhMm(new Date(base - 2 * 3_600_000)),
    quietHoursEnd: orgLocalHhMm(new Date(base + 2 * 3_600_000)),
  };
}

/** A REAL stored window that always contains the day_before anchor: the rung
 *  now fires 19:30 ORG-LOCAL, so [17:30, 21:30) org-local contains its dueAt
 *  at ANY wall clock - the window is anchored to the RUNG, not the clock
 *  (the retimed ladder's version of the old windowAroundNow trick). Wide
 *  enough that a DST shift cannot move 19:30 outside it; the release tick
 *  at dueAt + 5h (00:30 local) is comfortably outside. */
const QUIET_AROUND_DAY_BEFORE: QuietPatch = {
  quietHoursEnabled: true,
  quietHoursStart: '17:30',
  quietHoursEnd: '21:30',
};

/** Store a quiet-hours patch through the REAL admin API (PUT /api/settings is
 *  requireRole('admin'), so the context signs in as the founder first). */
async function putQuietHours(api: APIRequestContext, patch: QuietPatch | typeof QUIET_OFF): Promise<void> {
  const login = await api.post(`${NEXT}/auth/dev-login`, { data: { email: ADMIN_EMAIL } });
  expect(login.ok(), await login.text()).toBeTruthy();
  const res = await api.put(`${NEXT}/api/settings`, { data: patch });
  expect(res.ok(), await res.text()).toBeTruthy();
}

/** Dev-login as a persona on the PAGE (settings.spec.ts pattern), then load the
 *  app so the SPA picks up the freshly-set session cookie. */
async function devLoginAs(page: Page, email: string): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email } });
  expect(res.ok(), await res.text()).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);
}

/** The Quiet hours section on /settings/system. It is a <section> with an
 *  aria-labelledby heading, so it exposes a NAMED region - which is what
 *  disambiguates it from both the SettingsPage wrapper <section> and the
 *  System status section that shares the tab. */
function quietHoursSection(page: Page): Locator {
  return page.getByRole('region', { name: 'Quiet hours' });
}

/** One rung row in the OPEN tour Reminders panel, scoped by its staff label
 *  (the same card locator expectReminderRung uses). */
function reminderRow(page: Page, kind: keyof typeof REMINDER_KIND_LABELS): Locator {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Reminders' }) })
    .getByRole('listitem')
    .filter({ hasText: REMINDER_KIND_LABELS[kind] });
}

/**
 * A consented tenant + an available property + a booked SELF-GUIDED tour two
 * days out at 14:00 local (self_guided routes reminders 1:1 AND is the only tour
 * type the panel computes a suppression estimate for). Quiet hours must be OFF
 * when this runs so the armed dueAts are un-clamped.
 *
 * tourScheduleFullLadder(2), not plain tourSchedule(), since 2026-08-26. The
 * fixed 14:00 removes test (2)'s last wall-clock dependency: every rung instant
 * is then the same relative shape run to run (day_before 19:30 D-1 < morning_of
 * 10:00 D < en_route 13:00 D < start 14:00 D), which is what makes "no later
 * rung is in either batch" true at any hour. It is harmless to test (3), which
 * never ticks. The old comment on tourSchedule() steering quiet-hours flows to
 * the now-relative booking described the PRE-RETIME contract, where day_before
 * was sched-24h and therefore landed at the wall clock's own time of day.
 */
async function bookedSelfGuidedTour(
  flow: Scenario,
  page: Page,
  label: string,
): Promise<{ tenant: Contact }> {
  await devLoginAs(page, ADMIN_EMAIL);
  const unit = await flow.seedAvailableUnit({ beds: 2 });
  const tenant = freshTenant(label);
  await flow.teamCreatesTenant({
    firstName: tenant.firstName,
    lastName: tenant.lastName,
    phone: tenant.phone,
  });
  await flow.seedTenantSearching();
  await flow.tenantAsksToTour(unit);
  await flow.teamCreatesTourFromInterest(unit, 'Self-guided');
  await flow.teamBooksTour(tourScheduleFullLadder(2));
  return { tenant };
}

// Defensive restore BEFORE the file runs (a crashed earlier run could have left
// the window on) and unconditional restore after it - other specs assume the
// lean seed's OFF posture.
test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext();
  try {
    await putQuietHours(api, QUIET_OFF);
  } finally {
    await api.dispose();
  }
});

test.afterAll(async ({ playwright }) => {
  const api = await playwright.request.newContext();
  try {
    await putQuietHours(api, QUIET_OFF);
  } finally {
    await api.dispose();
  }
});

// Opt-in end-of-test pause for eyeballing the live dashboard (gated on E2E_PAUSE),
// mirroring the sibling scenario specs.
test.afterEach(async ({ page }) => {
  const mode = process.env.E2E_PAUSE;
  if (!mode) return;
  test.setTimeout(0);
  if (mode === 'hold') {
    const ms = Number(process.env.E2E_PAUSE_MS ?? 600_000);
    // eslint-disable-next-line no-console
    console.log(`\n[E2E_PAUSE] test done - browser open ~${Math.round(ms / 1000)}s (Ctrl+C to quit).\n`);
    await page.waitForTimeout(ms);
  } else {
    // eslint-disable-next-line no-console
    console.log('\n[E2E_PAUSE] test done - click "Resume" in the Playwright Inspector window to continue.\n');
    await page.pause();
  }
});

test('(1) Settings: the System tab shows the stored quiet window and round-trips an edit', async ({
  page,
}) => {
  await devLoginAs(page, ADMIN_EMAIL);
  await page.goto(`${NEXT}/settings/system`);

  // Await the labelled CONTROL, not the heading: the section renders its heading
  // immediately and its controls only after its OWN GET /api/settings resolves.
  const section = quietHoursSection(page);
  const paused = section.getByLabel('Pause automated messages overnight');
  await expect(paused).toBeVisible({ timeout: 15_000 });

  // The lean seed's posture (worklist A1): the feature is OFF, on the product
  // default 21:00-08:00 window, in the org's single timezone (fixed text, not a
  // control - so it is asserted by its rendered copy).
  await expect(paused).not.toBeChecked();
  await expect(section.getByLabel('Start')).toHaveValue('21:00');
  await expect(section.getByLabel('End')).toHaveValue('08:00');
  await expect(section.getByText('Eastern - America/New_York')).toBeVisible();

  // Save is inert until something actually changes...
  await expect(section.getByRole('button', { name: 'Save' })).toBeDisabled();

  // ...then an End edit saves and PERSISTS across a full reload (a real
  // round-trip through PUT + GET /api/settings, not local component state).
  await section.getByLabel('End').fill('08:30');
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByRole('status')).toHaveText('Saved');

  await page.reload();
  await expect(section.getByLabel('End')).toHaveValue('08:30', { timeout: 15_000 });

  // Leave the lane clean - restore the default window through the same UI.
  await section.getByLabel('End').fill('08:00');
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(section.getByLabel('End')).toHaveValue('08:00', { timeout: 15_000 });
});

test('(2) Defer + release: a due rung WAITS inside the window, then sends once it ends', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);

  // Arm the ladder with quiet hours OFF -> un-clamped (legacy-shaped) dueAts.
  await putQuietHours(request, QUIET_OFF);
  const { tenant } = await bookedSelfGuidedTour(flow, page, 'Quiet');

  // Now switch the window ON around the RUNG, not the clock (see the timing
  // contract): 19:30 org-local is a fixed instant of the tour's calendar, so
  // [17:30, 21:30) org-local contains it whatever hour this suite runs at.
  await putQuietHours(request, QUIET_AROUND_DAY_BEFORE);

  // The rung's ARMED dueAt, read back from the server - 19:30 ORG-LOCAL the
  // evening before the tour, which this host-local file cannot compute.
  const dueAt = await flow.armedReminderDueAt('day_before');

  // Tick 1s past it: due, and org-locally INSIDE the window (19:30:01).
  await flow.tickTourReminders(justAfter(dueAt));

  // Deferred, not dropped: nothing reached the tenant. ABSENCE, so this rides the
  // kind-distinctive MARKER rather than a composed body - an exact string that
  // were ever mis-composed would make "nothing arrived" pass vacuously. (The
  // matching PRESENCE assertions below go through expectReminderTo1to1, which
  // composes the whole body from the active tour.)
  await flow.expectNoOutboxMessageContaining(tenant, REMINDER_BODY_MARKERS.day_before);
  // ...the rung is STILL pending (the backstop never claimed it)...
  await flow.openTourReminders();
  await flow.expectReminderRung('day_before', 'upcoming');
  // ...and the panel says so honestly: a WAIT, not a skip and not a pause. From
  // 2026-08-20 to 2026-08-31 this read PAUSED_NOTE, because the manual-only
  // hold-back outranked quiet hours and was the thing that outlasted the window.
  // The hold-back is gone, so the rung's real reason is the window again, and
  // the negative assertion below is what keeps that honest: a PAUSED_NOTE here
  // would mean something re-paused the ladder without saying so.
  //
  // With the window anchored to the RUNG, the estimate's quiet disjunct (a
  // FUTURE dueAt inside an occurrence of the stored window) is true at every
  // wall clock, so this is a real precedence proof rather than an accident of
  // the hour - which is more than the old wall-clock anchoring could promise.
  const dayBeforeRow = reminderRow(page, 'day_before');
  await expect(dayBeforeRow.getByText(QUIET_NOTE)).toBeVisible({ timeout: 15_000 });
  await expect(dayBeforeRow.getByText(PAUSED_NOTE)).toHaveCount(0);

  // Tick again 5h later: still past the rung, now org-locally OUTSIDE the window
  // (00:30) - and 00:30 on tour day is still before morning_of at 10:00, so
  // nothing supersedes it -> it fires for real.
  await flow.tickTourReminders(new Date(Date.parse(dueAt) + 5 * 3_600_000).toISOString());
  await flow.expectReminderTo1to1('day_before', tenant);
  await flow.openTourReminders();
  await flow.expectReminderRung('day_before', 'sent');
});

test('(3) Send now: a human send goes out immediately, even inside the quiet window', async ({
  page,
  request,
}) => {
  const flow = new Scenario(page, request);

  await putQuietHours(request, QUIET_OFF);
  const { tenant } = await bookedSelfGuidedTour(flow, page, 'Sendnow');
  // WALL-CLOCK anchored, deliberately, and NOT switched to the rung-anchored
  // window test (2) uses: this test never ticks, and a quiet-hours BYPASS is
  // only provable while the clock is genuinely inside a stored window. Anchoring
  // to the rung would leave nothing for Send now to bypass at any hour outside
  // 17:30-21:30 org-local.
  await putQuietHours(request, windowAroundNow());

  await flow.openTourReminders();
  const row = reminderRow(page, 'day_before');

  // NOT the exact inversion of test (2), and deliberately so - read this before
  // "fixing" it to assert QUIET_NOTE. This test's window is anchored to the WALL
  // CLOCK, while the day_before rung is ~1.8 days out at a FIXED 19:30 org-local
  // (tourScheduleFullLadder). The panel's estimate for a FUTURE rung asks
  // whether the RUNG's own dueAt falls in an occurrence of the stored window, so
  // windowAroundNow() only covers 19:30 when the suite happens to run between
  // 17:30 and 21:30 org-local. Asserting QUIET_NOTE here would be a coin flip on
  // the hour. (Before the 2026-08-26 retiming the rung WAS ~24h out and so
  // landed at the same local time as the window - that is why this line used to
  // read QUIET_NOTE; the pause then masked the breakage.) The wall clock IS in
  // the window, which is all the BYPASS below needs.
  //
  // So the panel promises the send, and both suppression notes are absent -
  // PAUSED_NOTE most of all: since 2026-08-31 nothing pauses a tour rung, and a
  // pause note appearing here would mean the ladder was re-paused silently.
  await flow.expectReminderRung('day_before', 'upcoming');
  await expect(row.getByText(PAUSED_NOTE)).toHaveCount(0);
  await expect(row.getByText(QUIET_NOTE)).toHaveCount(0);

  // ...and Send now goes out anyway, with the wall clock inside the stored
  // window: a human send bypasses quiet hours. That bypass is the whole point of
  // this test, and it is a wall-clock fact, which is why the window stays
  // anchored to the clock.
  // Per-rung accessible name (worklist A10) - a bare "Send now" would collide.
  await row.getByRole('button', { name: 'Send the Day before reminder now' }).click();

  await flow.expectReminderTo1to1('day_before', tenant);
  await flow.expectReminderRung('day_before', 'sent');
});
