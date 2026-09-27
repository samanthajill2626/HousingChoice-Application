---
id: group-reply-live-rollup-full-suite-flake
title: Live group delivery rollup can miss SSE completion under full-suite load
type: bug
severity: med
status: open
area: e2e/messaging
created: 2026-08-21
resolved: 2026-08-24
refs: e2e/tests/dashboard-next/group-text-reply-all.spec.ts:121, dashboard/src/routes/conversation/GroupTextView.tsx, dashboard/src/api/EventStreamProvider.tsx
---

**Sighting (2026-09-27 afternoon, `feat/voicemail-greeting` gate runs) -
the reopen signature, now DETERMINISTIC IN ISOLATION.** A full `npm run e2e`
at 12:15-12:53 EDT (284 passed, 5 failed, 38.6m) failed
`group-text-reply-all.spec.ts:45` and `group-text-per-recipient-delivery.spec.ts:63`
on exactly this signature (the per-member rollup never finalized LIVE; 60 s
poll). Run ALONE they failed again (2 of 2), and run alone at MAIN @65015b2c
(before the branch's last commit, which touches only voicemail-greeting log
levels and copy) they failed the same way (13:00, 1 passed / 2 failed). So it
is not load and not that branch. The same machine passed the full suite at
09:16 that morning (289 passed on c720e0a3, identical group-text code). The
app log during the failing runs carries "the Conversations rail refused a
post because it is closed or gone" / "group text rail dropped" / "deleted a
dead Conversations rail". The other three full-run failures that day
(`group-text-stop.spec.ts:48`, `matching-entry-points.spec.ts:270`,
`relay-30003-retry.spec.ts:135`) passed alone. Unverified lead: something
time-of-day or wall-clock dependent (compare
`group-crosscheck-wiring-test-wall-clock-dependent`) or fake-twilio
Conversations state; run the suggested trace below before touching any
timeout. Logs: `W:/tmp/voicemail-greeting/.superpowers/planner-gates/`
(`final-e2e.log`, `final-e2e-rerun5.log`, `base-e2e-grouptext.log`).

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

**Recurrence (2026-09-26, `feat/inbox-rows-timestamps` planner review) -
REOPENED on the exact signature.** A bare `npm run e2e` on bc1efe1e (28.0
minutes; the same runtime code had run 284/284 in 24.9 minutes at 16:20Z on
the same machine) failed BOTH group-text rollup assertions back to back:
`group-text-per-recipient-delivery.spec.ts:63` ("the per-recipient rollup
never settled at 2/3 LIVE (no reload)") and `group-text-reply-all.spec.ts:45`
("the per-member delivery rollup never finalized LIVE (no reload) - the SSE
push is missing"), each after its 60-second poll, the sends themselves
succeeding. The isolated re-run of the two files passed 3/3 in 42.1s. The
branch under test touches no messaging, SSE or group-text code (inbox, auth
gate and perf harness only; `adapters/messaging.ts`, `relay*` jobs and the
Twilio webhook are on its exclusion list). Machine conditions during the
run: 15-49% CPU with about 32 node processes from other sessions (mostly
idle `@playwright/mcp` servers), DynamoDB Local container 38 hours up at
1.9 GiB. Same shape as the 2026-08-21 sighting: a slow full run, both group
rollups, clean alone. The suggested trace (receipt callback ->
`message.persisted` -> `/api/events` -> rollup) has still not been run on a
failing instance; a `E2E_CHILD_LOG_DIR` run is NOT the tool for it (a
timing symptom), a trace on first retry is.

