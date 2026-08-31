// e2e/tests/tour-no-show-checkin.spec.ts
//
// Manual "Send no-show check-in" - the end-to-end proof for the de-automated
// no_show_checkin rung (docs/superpowers/plans/2026-07-21-tour-no-show-checkin-manual.md,
// Task 6). Two halves, both asserted here:
//   - NO AUTO-SEND: a scheduled tour whose start time is in the PAST arms NO
//     PENDING rung at all - every rung is either born a visible SKIPPED row or
//     dropped silently (the derivation is at the PATCH below) - and the no-show
//     check-in is not even considered: it is absent from REMINDER_KINDS and has
//     never been auto-armed (app/src/jobs/tourReminders.ts).
//   - MANUAL SEND: staff send it by hand from the tour header kebab ("Send
//     no-show check-in"), which switches to the Tenant channel and PREFILLS the
//     1:1 composer with the editable template; sending delivers exactly one copy
//     to the tenant (the normal 1:1 send path - the seeded tenant is consented).
//
// Mirrors the tours.spec / scheduled-visibility.spec discipline: Team acts through
// the REAL dashboard UI, pure setup uses the API seam, proof-of-send is asserted
// via fake-twilio listThreads scoped to THIS test's tenant phone. Self-clean
// isolation: a fresh timestamped tenant, no per-test reseed.
//
// Past-scheduledAt recipe: there is NO past-schedule helper, and the reminder
// tick seam does not move the client wall clock (which the "start passed" gate
// reads), so we set the booked time directly via PATCH /api/tours/:tourId - the
// same API seam seedTenantSearching/seedAvailableUnit use. The dashboard base URL
// is the per-lane E2E_DASHBOARD_URL (playwright.config.ts) - NEVER the dev :5174
// stack.
import { test, expect } from '@playwright/test';
import { Scenario, freshTenant, APP_NUMBER } from '../scenarios/steps.js';
import { listThreads, getOutboundTo } from '../fixtures/fakeTwilio.js';

// The distinctive no_show_checkin substring (app/src/messages/catalog.ts,
// 'tour.no_show_checkin') - unique to this rung, so a body match cleanly
// identifies the check-in among the other four reminder bodies.
//
// It is the TAIL of the body now, not the whole of it: the 2026-08-26 rewrite
// made the copy 'Hi {tenantFirstName}! Do you need to reschedule?'. That does
// not weaken it as an ABSENCE marker - the phrase still appears in every variant
// of this rung (there is only one, and the name is a prefix), and it is still
// unique to it among the five bodies. The exact prefill asserted in half 2 is
// BUILT from this constant rather than restating it, so the phrase lives in
// exactly two places repo-wide: here and REMINDER_BODY_MARKERS in steps.ts.
const CHECKIN_PHRASE = 'Do you need to reschedule?';

test('no_show_checkin is not auto-sent; staff send it manually with prefilled copy', async ({
  page,
  request,
}) => {
  test.slow(); // a full page-driven walk: setup + reminder tick + a manual send.
  const flow = new Scenario(page, request);

  // The per-lane dashboard URL (set by playwright.config.ts). Read WITHOUT a
  // :5174 fallback so a mis-set env fails loud here rather than silently driving
  // the human's live dev stack.
  const dashboard = process.env['E2E_DASHBOARD_URL'];
  expect(dashboard, 'E2E_DASHBOARD_URL must be set by playwright.config.ts (per-lane)').toBeTruthy();

  // --- Arrange: a searching, consented tenant + an available unit + a tour ---
  await flow.login();
  const unit = await flow.seedAvailableUnit({ beds: 2 });
  const tenant = freshTenant('NoShow');
  await flow.teamCreatesTenant({
    firstName: tenant.firstName,
    lastName: tenant.lastName,
    phone: tenant.phone,
  });
  await flow.seedTenantSearching();
  await flow.tenantAsksToTour(unit);
  // Self-guided: no group, reminders route 1:1 to the tenant, and the tour page
  // defaults to the Tenant channel.
  const tourId = await flow.teamCreatesTourFromInterest(unit, 'Self-guided');

  // Put the tour in the PAST + 'scheduled' (the manual-send gate = start passed &&
  // scheduled/no_show). A scheduledAt PATCH re-arms the ladder off the new time.
  //
  // WHAT THAT ACTUALLY ARMS, re-derived 2026-08-26 against the retimed ladder and
  // the new skip rules (the lean seed has quiet hours OFF, so nothing clamps):
  //   - confirmation: dueAt IS the arm instant, which is 26h AFTER the tour
  //     start, so the at-or-past-start rule fires and it is born a VISIBLE
  //     `past_event` skipped row. It is NOT pending and it does NOT fire.
  //   - day_before: its RAW time is 19:30 org-local the evening before the tour's
  //     local date - about two days ago - so the arm instant is far past
  //     (RAW - 4h) and it is born a VISIBLE `booked_too_late` skipped row.
  //   - morning_of: RAW is start - 4h, i.e. 30h ago. Its booked-too-late rule
  //     needs the ARM to fall on the tour's OWN local date, and 26h back always
  //     crosses a local date boundary, so that rule never fires here; the dueAt
  //     is simply already past, which is the one SILENT drop - no row.
  //   - en_route: start - 1h, 27h ago - the same silent drop, no row.
  //   - no_show_checkin: absent from REMINDER_KINDS, never considered at all.
  // So NOTHING is pending, and the wall-clock tick in half 1 fires NOTHING.
  const pastIso = new Date(Date.now() - 26 * 3_600_000).toISOString();
  const patched = await page.request.patch(`${dashboard}/api/tours/${tourId}`, {
    data: { scheduledAt: pastIso, status: 'scheduled' },
  });
  expect(patched.ok(), await patched.text()).toBeTruthy();

  // --- Half 1: NO AUTO-SEND ---
  // Run the reminder poll on the wall clock. Per the derivation above there is
  // nothing pending for it to pick up, so it sends NOTHING - not the never-armed
  // no-show check-in and not any other rung either.
  //
  // TWO assertions, deliberately. The phrase-scoped one is the named proof, but
  // on its own a WRONG derivation would fail SILENTLY: an absence check for one
  // phrase passes just as happily when four other rungs did fire. The count
  // comparison is what makes the derivation itself falsifiable.
  const outboundBefore = (await getOutboundTo(request, { to: tenant.phone })).length;
  await flow.tickTourReminders();
  await flow.expectNoOutboxMessageContaining(tenant, CHECKIN_PHRASE);
  expect(
    (await getOutboundTo(request, { to: tenant.phone })).length,
    'the tick must send nothing at all - no rung of this tour is pending',
  ).toBe(outboundBefore);

  // --- Half 2: MANUAL SEND from the tour header kebab ---
  await page.goto(`${dashboard}/tours/${tourId}`);
  await expect(page.getByRole('button', { name: /more actions/i })).toBeVisible({ timeout: 10_000 });

  // Start OFF the Tenant channel so the kebab action's SWITCH to Tenant is
  // observable end-to-end (the same group-start -> tenant-tab seed the
  // TourConversation unit test covers).
  await page.getByRole('tab', { name: 'Relay group' }).click();
  await expect(page.getByRole('tab', { name: 'Relay group', selected: true })).toBeVisible();

  await page.getByRole('button', { name: /more actions/i }).click();
  await page.getByRole('menuitem', { name: /send no-show check-in/i }).click();

  // The action selects the tenant's channel and prefills its 1:1 composer with
  // the editable no_show_checkin template. Person tabs are labeled by DISPLAY
  // NAME (contact-rosters slice 2) - anchor on the run-unique first name.
  await expect(
    page.getByRole('tab', { name: new RegExp(`^${tenant.firstName}\\b`), selected: true }),
  ).toBeVisible({ timeout: 10_000 });
  // EXACT, not a regex: the tenant's first name reaching this prefill is the
  // whole point of the 2026-08-26 name threading, and a /phrase/ match cannot
  // see it. Built from CHECKIN_PHRASE so the phrase stays a single literal.
  await expect(page.getByRole('textbox', { name: 'Reply message' })).toHaveValue(
    `Hi ${tenant.firstName}! ${CHECKIN_PHRASE}`,
  );

  // Send it (the normal 1:1 send path).
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  // --- Assert: exactly ONE check-in reached the tenant 1:1 (the suite's
  // listThreads filter idiom: this tenant's thread, outbound from the app number,
  // body carrying the check-in phrase). ---
  await expect
    .poll(
      async () => {
        const threads = await listThreads(request);
        const thread = threads.find((x) => x.partyNumber === tenant.phone);
        return (
          thread?.messages.filter(
            (m) =>
              m.direction === 'outbound' &&
              m.from === APP_NUMBER &&
              (m.body ?? '').includes(CHECKIN_PHRASE),
          ).length ?? 0
        );
      },
      { timeout: 15_000 },
    )
    .toBe(1);
});
