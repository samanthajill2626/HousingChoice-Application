---
id: group-reply-live-rollup-full-suite-flake
title: Live group delivery rollup can miss SSE completion under full-suite load
type: bug
severity: med
status: resolved
area: e2e/messaging
created: 2026-08-21
resolved: 2026-08-24
refs: e2e/tests/dashboard-next/group-text-reply-all.spec.ts:121, dashboard/src/routes/conversation/GroupTextView.tsx, dashboard/src/api/EventStreamProvider.tsx
---

**Resolution (2026-08-24): single sighting from the one sick gate run.** The
2026-08-21 27.1-minute run that produced this also produced two
machine-exhaustion issues since resolved as environmental
(`otel-child-boot-stdout-missing`, `performance-config-npm-cmd-enomem`) and
the reseed-timeout sighting whose new phase timings later showed an 8x healthy
margin. The rollup chain was byte-identical to its base, the isolated rerun
passed in 23.4s, and zero recurrences have appeared in the 8+ full runs since
- including two heavily contended ones, which is the exact load condition the
sighting was blamed on. The keep-alive hardening (2026-08-24) also removed
the strongest mechanism for a silently dropped/hung SSE delivery under load.
REOPEN on the signature: the per-member rollup never finalizing WITHOUT a
reload while the send itself succeeded - and then run this issue's suggested
trace (receipt callback -> message.persisted -> /api/events -> rollup) before
touching any timeout.


**Measurement (2026-08-23, `fix/test-suite-wave3` gate run).** Did NOT
reproduce: 253/253 green (17.3m), group-text-reply-all included. Same caveat as
its siblings - one clean run proves little - but note the provenance: this was
filed off the SAME 2026-08-21 gate run as two since-resolved
machine-exhaustion issues and the reseed-timeout sighting, whose new phase
timings show an 8x margin on a healthy machine. If this recurs, follow the
suggested trace; if the machine was simply sick, it will stay quiet.


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
