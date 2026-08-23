---
id: group-reply-live-rollup-full-suite-flake
title: Live group delivery rollup can miss SSE completion under full-suite load
type: bug
severity: med
status: open
area: e2e/messaging
created: 2026-08-21
refs: e2e/tests/dashboard-next/group-text-reply-all.spec.ts:121, dashboard/src/routes/conversation/GroupTextView.tsx, dashboard/src/api/EventStreamProvider.tsx
---

**Problem.** A bare `npm run e2e` on the environment-visual-identity feature head
`709a5263` failed the live group-reply assertion after its 60-second poll. The UI
never showed a finalized per-member delivery rollup without a reload, and the test
reported that the SSE push was missing. The complete run finished with 250 passing
and three failing tests in 27.1 minutes.

The exact spec and its group-send, receipt, persistence, event-stream, and dashboard
rendering chain are byte-identical between base `165a267b` and feature head
`709a5263`. An immediate isolated rerun of the file passed both tests in 23.4 seconds.
That makes a feature regression unlikely, but one isolated pass is not enough to
waive this assertion: a recurring failure can represent a real missing live event.

**Suggested fix.** Reproduce under a loaded hermetic lane and trace one message from
provider receipt callback through `message.persisted` and `/api/events` to the live
rollup. Preserve the no-reload assertion. If the event is emitted and received, add
diagnostics around client reconciliation before changing the timeout.
