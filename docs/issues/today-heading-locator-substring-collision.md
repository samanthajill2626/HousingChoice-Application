---
id: today-heading-locator-substring-collision
title: getByRole('heading', { name: 'Today' }) is a SUBSTRING match - it collides with the clock-dependent "Tours today" group heading
type: bug
severity: med
status: open
area: e2e
created: 2026-08-05
refs: e2e/tests/dashboard-next/outbound-mms.spec.ts:54, dashboard/src/routes/today/Today.tsx:28
---

**Problem.** Playwright's `getByRole(role, { name })` matches the accessible
name by case-insensitive SUBSTRING unless `exact: true`. The dashboard's home
page renders `<h1>Today</h1>` (the page title) and - ONLY when a tour is
scheduled for the current calendar day - an `<h2>Tours today</h2>` group
heading (`dashboard/src/routes/today/Today.tsx:28`; the group is data-driven
and this repo's fixtures are now-relative). When both exist,
`getByRole('heading', { name: 'Today' })` resolves to BOTH and the assertion
fails with a strict-mode violation.

Observed 2026-08-05 (feat/tour-reminder-details final gate, run 1 of 2):
`outbound-mms.spec.ts:252 (d)` failed at its `devLogin` helper's
`:54` assertion - another worker's test had a tour booked for that day, so
"Tours today" was on the page at that moment. Run 2 on the SAME commit:
204/204 green. The failure is a latent brittleness in the LOCATOR - clock- and
cross-test-data-dependent, not a product defect, and not attributable to the
branch under test (the spec, Today.tsx, and every heading-rendering file were
untouched by that diff).

**Fix.** Add `exact: true`. Five specs already use the exact form
(composer-mobile:47, deleted-contact-resurfacing:29,
relay-connect-when-ready:93, relay-group-view:46, relay-number-lifecycle:82) -
someone hit this before and fixed only their own file. One pass should convert
ALL remaining non-exact instances (33 sites, 31 files, list current as of
2026-08-05):

- dashboard-next: a2p-compliance:45, broadcasts:33, contact-create:19,
  contact-detail:16, frame:35, inbox-comms:16, inbox-markread:14, inbox:12,
  landlord-activity:15, listing-activity:19, listing-photos:43, lost-modal:18,
  matching-entry-points:26, mms-transcode:28, outbound-mms:54,
  placement-create:34, placement-history:19, placements-page:14,
  pool-numbers-admin:33, public-pages:52, recording-range:32, settings:22,
  tour-comms-pane:57, unknown-caller-triage:30, voice-outbound:132 + :532,
  voice-transcription:64
- flows: conversation-fact-extraction:25 + :311, email-triage:65,
  event-bridge:41, voice-extraction:33
- scenarios: quiet-hours:135

Most are copies of the same `devLogin` helper - consider hoisting one shared
helper into e2e/scenarios/steps.ts (or a support module) while converting, so
the next spec cannot re-introduce the substring form.
