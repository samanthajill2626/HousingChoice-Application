---
id: group-reply-live-rollup-full-suite-flake
title: Concurrent receipts for one member dropped a legal forward transition (seen as a live group rollup that never finalized)
type: bug
severity: med
status: resolved
area: app/messaging
created: 2026-08-21
resolved: 2026-09-27
refs: app/src/repos/messagesRepo.ts:3688, app/test/groupSendRepo.integration.test.ts:391, e2e/tests/dashboard-next/group-text-reply-all.spec.ts:121, e2e/tests/dashboard-next/group-text-per-recipient-delivery.spec.ts:126
---

**ROOT CAUSE AND FIX (2026-09-27, `fix/recipient-delivery-race`). Not load,
not the SSE push, not the clock - a product race that load exposed.**
`messagesRepo.updateRecipientDeliveryStatus` read the member's slot, then
wrote with `ConditionExpression: delivery_recipients.#mk.#st = :prev` - the
EXACT status it had read. When a member's `sent` and `delivered` receipts were
in flight together, both read `queued`; `sent` committed first; `delivered`
then failed its condition and was DROPPED with the INFO line "group recipient
delivery status transition lost a race (regressed)" and no retry. sent ->
delivered is legal, so a valid receipt was lost for good: the slot stayed
`sent`, the rollup never reached N/N (or 2/3), and no SSE could show a state
that was never stored. The aggregate twin `updateDeliveryStatus` never had
this - it conditions on `delivery_status IN (allowed priors)` - and neither
did the in-memory harness fake (`app/test/helpers/twilioWebhookHarness.ts`),
which applies `allowedPriorStatuses`, so no unit suite could see it.

WHY IT TRACKED LOAD. The fake emits each leg's `sent` 150 ms after the post
and `delivered` at 300 ms (`fake-twilio/src/engine/delivery.ts`). When the
send's post -> append took longer than ~150 ms, `sent` missed the row, slept
the 250 ms `UNKNOWN_MESSAGE_RETRY_DELAY_MS`, and landed in the same window as
`delivered`. Measured over every group send in the preserved logs:
post -> append 8-76 ms gave 0-1 lost receipts; 194-807 ms gave 2-3 lost per
send and the failures. The afternoon of 2026-09-27 ran 2-7x slower on every
DynamoDB-bound route (group-members p50 30 ms -> 214 ms), which is what made it
look deterministic; the same specs passed 3/3 on a quiet machine at 15:24 EDT
the same day (append 8-11 ms, zero losses). The 08:06 EDT full run had already
failed reply-all once with a fast append. The rail "refused / dropped /
deleted" log lines come only from `group-text-reply-all.spec.ts:158`, which
closes a rail on purpose, and are unrelated.

SAME CAUSE, OTHER SPECS. The relay status route shares the method: in the
12:15 full run `group-text-stop.spec.ts:48` lost 4 `delivered` receipts and
`relay-30003-retry.spec.ts:135` lost its 30003 `undelivered` to `sent` (so no
retry claim, no "1 retrying" chip); eight passing relay specs also logged
losses. Production exposure is the same race at real-DynamoDB latency: rarer,
but a lost `delivered` shows staff a member who "never confirmed".

FIX. The condition is now `delivery_recipients.#mk.#st IN (allowed priors)`,
matching `updateDeliveryStatus`; nothing is built from the read since the
child-field writes of spec 15.2b, so the exact-match guard protected nothing.
A late lower status (`sent` after `delivered`) is still refused. Pinned by a
GATED DynamoDB Local test that forces the logged interleave on every run
(group delivered, relay delivered, relay undelivered after `sent`; plus the
reverse refusal) - red on the old condition (3 failed), green on the new. The
e2e specs and their 60 s no-reload polls are unchanged; they were right.
The same bug was filed independently the same day by the
`feat/send-outcome-reconcile` planner as
[group-recipient-delivered-receipt-lost-to-sent-race](./group-recipient-delivered-receipt-lost-to-sent-race.md),
now closed as a duplicate of this one.

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
timeout. Logs (the worktree is retired; preserved with a SHA-256 manifest): `W:/tmp/_preserved-artifacts/voicemail-greeting-20260927/superpowers/planner-gates/`
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

**Recurrence (2026-09-27, `feat/staff-notes-past-tours` final gate run) -
same signature, and this time the app-side log of the failing instance is
in hand.** A bare `timeout 2700 npm run e2e` on `03768233` (25.9 minutes;
the same code paths had run 287/287 in 22.9 minutes at 08:20Z that morning)
failed `group-text-per-recipient-delivery.spec.ts:63` alone ("the per-recipient
rollup never settled at 2/3 LIVE (no reload)") after its 60-second poll;
286 passed. The isolated re-run of the file passed in 27.1 s (the test 5.7 s).
The branch touches no messaging, SSE or group-text code (contacts PATCH,
tours dashboard, two tours/contact e2e specs). Machine conditions: another
mission's full e2e was live on lane 15 for the whole run (its lease was
written at 10:59Z, 16-17 of its node processes alive after). The suggested
trace was not run, but the launcher's captured app log for the failing test's
window (`ok 71` to `x 72`) shows the receipt chain's own verdict - three
lines, verbatim apart from the JSON wrapper:

- `{"conversationId":"16d1845c-...","tsMsgId":"2026-09-27T10:43:14.831Z#IMfake31302060","status":"delivered","msg":"group recipient delivery status transition lost a race (regressed)"}` - TWICE, 22 ms apart (10:43:15.681Z and .703Z), two different requestIds;
- `{"providerSid":"IMfake31302060","status":"sent","currentStatus":"queued","msg":"delivery status transition skipped (would regress)"}` at 10:43:15.882Z;
- plus exactly three `group recipient delivery updated` and one `delivery status updated` lines in the window.

So on the failing instance the two `delivered` receipts for the same
provider SID both lost the per-recipient transition race (each saw a status
it would regress) and were dropped, and the later `sent` receipt was skipped
as a regression of `queued` - the rollup therefore never reached two
delivered out of three, and no SSE push could have shown 2/3 because the
stored state never got there. That points the trace at the per-recipient
transition's compare-and-set (who held `delivered` first, and why a second
`delivered` counts as a regression) rather than at the event stream. Under
load the fake's receipts arrive closer together, which is consistent with
every sighting being a slow full run.

