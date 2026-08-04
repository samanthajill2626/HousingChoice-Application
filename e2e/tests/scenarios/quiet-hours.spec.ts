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
// fake-twilio thread store (never the deprecated /__dev/outbox).
//
// TIMING CONTRACT (the part that makes this deterministic at ANY wall clock):
//   - The panel's suppression estimate is computed against the SERVER'S WALL
//     CLOCK, not against a tick's synthetic `now`. So the "Will wait" chip can
//     only be produced by storing a REAL window that contains the wall clock -
//     which is what windowAroundNow() does (a 4-hour window centred on now, in
//     ORG-local time, so the host's own timezone is irrelevant).
//   - The tick instants are independent of that: both are derived from the same
//     booking, so the DEFER tick lands at an org-local time-of-day inside the
//     window (~24h out = the same local time of day) and the RELEASE tick 5h
//     later lands outside it - with margin for a DST shift either way.
//   - The ladder is armed with quiet hours OFF so the stored dueAts are
//     UN-CLAMPED (the legacy row shape the fire-time backstop exists for);
//     arming under an enabled window would clamp them out of it and there would
//     be nothing left to defer.
//   - Only ONE rung of the tour is ever due in an asserted tick: release
//     supersession retires an earlier rung when a LATER rung of the same tour is
//     due in the same batch, so the assertions ride the LAST due rung
//     (day_before), which nothing can supersede.
//
// LANE HYGIENE: the lean seed ships quiet hours OFF (worklist A1) so every other
// spec stays time-of-day independent. This file turns it on explicitly and puts
// it back - defensively in beforeAll and always in afterAll.
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import {
  Scenario,
  freshTenant,
  tourSchedule,
  justAfter,
  TOUR_REMINDER_BODIES,
  REMINDER_KIND_LABELS,
  type Contact,
  type TourTimes,
} from '../../scenarios/steps.js';

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
 *  skip - if this ever reverts to "Will be skipped" the promise is broken. */
const QUIET_NOTE = `Will wait ${EM_DASH} quiet hours`;

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
 */
function windowAroundNow(): QuietPatch {
  const base = Date.now();
  return {
    quietHoursEnabled: true,
    quietHoursStart: orgLocalHhMm(new Date(base - 2 * 3_600_000)),
    quietHoursEnd: orgLocalHhMm(new Date(base + 2 * 3_600_000)),
  };
}

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
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
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
 * A consented tenant + an available property + a booked SELF-GUIDED tour 48h out
 * (self_guided routes reminders 1:1 AND is the only tour type the panel computes
 * a suppression estimate for). Quiet hours must be OFF when this runs so the
 * armed dueAts are un-clamped.
 */
async function bookedSelfGuidedTour(
  flow: Scenario,
  page: Page,
  label: string,
): Promise<{ tenant: Contact; times: TourTimes }> {
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
  const times = tourSchedule();
  await flow.teamBooksTour(times);
  return { tenant, times };
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
  test.slow(); // full booking flow + two reminder ticks
  const flow = new Scenario(page, request);

  // Arm the ladder with quiet hours OFF -> un-clamped (legacy-shaped) dueAts.
  await putQuietHours(request, QUIET_OFF);
  const { tenant, times } = await bookedSelfGuidedTour(flow, page, 'Quiet');

  // Now switch the window ON around the WALL CLOCK (see the timing contract).
  await putQuietHours(request, windowAroundNow());

  // Tick 1s past the day_before rung: due, and org-locally INSIDE the window.
  await flow.tickTourReminders(justAfter(times.dayBefore));

  // Deferred, not dropped: nothing reached the tenant...
  await flow.expectNoOutboxMessageContaining(tenant, TOUR_REMINDER_BODIES.day_before);
  // ...the rung is STILL pending (the backstop never claimed it)...
  await flow.openTourReminders();
  await flow.expectReminderRung('day_before', 'upcoming');
  // ...and the panel says so honestly: a WAIT, not a skip.
  await expect(reminderRow(page, 'day_before').getByText(QUIET_NOTE)).toBeVisible({
    timeout: 15_000,
  });

  // Tick again 5h later: still past the rung, now org-locally OUTSIDE the window
  // (and still before morning_of, so nothing supersedes it) -> it fires for real.
  await flow.tickTourReminders(
    new Date(Date.parse(times.dayBefore) + 5 * 3_600_000).toISOString(),
  );
  await flow.expectReminderTo1to1('day_before', tenant);
  await flow.openTourReminders();
  await flow.expectReminderRung('day_before', 'sent');
});

test('(3) Send now: a human send goes out immediately, even inside the quiet window', async ({
  page,
  request,
}) => {
  test.slow(); // full booking flow + a settings round-trip before the click
  const flow = new Scenario(page, request);

  await putQuietHours(request, QUIET_OFF);
  const { tenant } = await bookedSelfGuidedTour(flow, page, 'Sendnow');
  await putQuietHours(request, windowAroundNow());

  await flow.openTourReminders();
  const row = reminderRow(page, 'day_before');

  // The automated send WOULD wait right now (the wall clock is in the window)...
  await expect(row.getByText(QUIET_NOTE)).toBeVisible({ timeout: 15_000 });

  // ...and Send now overrides exactly that: human sends bypass quiet hours.
  // Per-rung accessible name (worklist A10) - a bare "Send now" would collide.
  await row.getByRole('button', { name: 'Send Day before reminder now' }).click();

  await flow.expectReminderTo1to1('day_before', tenant);
  await flow.expectReminderRung('day_before', 'sent');
});
