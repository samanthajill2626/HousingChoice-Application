// e2e/tests/tour-no-show-checkin.spec.ts
//
// Manual "Send no-show check-in" - the end-to-end proof for the de-automated
// no_show_checkin rung (docs/superpowers/plans/2026-07-21-tour-no-show-checkin-manual.md,
// Task 6). Two halves, both asserted here:
//   - NO AUTO-SEND: a scheduled tour whose start time is in the PAST arms the
//     reminder ladder, but the reminder poll never sends the "may have missed
//     your tour" check-in - it is no longer auto-armed (app/src/jobs/tourReminders.ts).
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
import { listThreads } from '../fixtures/fakeTwilio.js';

// The distinctive no_show_checkin substring (app/src/messages/catalog.ts,
// 'tour.no_show_checkin') - unique to this rung, so a body match cleanly
// identifies the check-in among the other four reminder bodies.
const CHECKIN_PHRASE = 'may have missed your tour';

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
  // scheduled/no_show). A scheduledAt PATCH arms the ladder off the new time - but
  // only the four remaining rungs; no_show_checkin is no longer auto-armed.
  const pastIso = new Date(Date.now() - 26 * 3_600_000).toISOString();
  const patched = await page.request.patch(`${dashboard}/api/tours/${tourId}`, {
    data: { scheduledAt: pastIso, status: 'scheduled' },
  });
  expect(patched.ok(), await patched.text()).toBeTruthy();

  // --- Half 1: NO AUTO-SEND ---
  // Run the reminder poll past every armed rung's due time (start was 26h ago, so
  // the wall-clock tick fires everything due). The four legit rungs may land 1:1
  // (unasserted noise), but the de-armed no_show_checkin never does.
  await flow.tickTourReminders();
  await flow.expectNoOutboxMessageContaining(tenant, CHECKIN_PHRASE);

  // --- Half 2: MANUAL SEND from the tour header kebab ---
  await page.goto(`${dashboard}/tours/${tourId}`);
  await expect(page.getByRole('button', { name: /more actions/i })).toBeVisible({ timeout: 10_000 });

  // Start OFF the Tenant channel so the kebab action's SWITCH to Tenant is
  // observable end-to-end (the same group-start -> tenant-tab seed the
  // TourConversation unit test covers).
  await page.getByRole('tab', { name: 'Group text' }).click();
  await expect(page.getByRole('tab', { name: 'Group text', selected: true })).toBeVisible();

  await page.getByRole('button', { name: /more actions/i }).click();
  await page.getByRole('menuitem', { name: /send no-show check-in/i }).click();

  // The action selects the Tenant channel and prefills its 1:1 composer with the
  // editable no_show_checkin template.
  await expect(page.getByRole('tab', { name: /^Tenant/, selected: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole('textbox', { name: 'Reply message' })).toHaveValue(
    new RegExp(CHECKIN_PHRASE),
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
