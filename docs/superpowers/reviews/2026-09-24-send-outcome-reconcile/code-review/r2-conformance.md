# Code review round 2 - spec-conformance re-review

Reviewer: a FRESH read-only spec-conformance re-reviewer (Claude Opus 5.5),
dispatched 2026-09-27 14:38 EDT over the fix wave FW1 + FW2 (0dd5d4b7..af848977)
on top of the round-1 reviewed commit 83308e15. HEAD a908f9cb (code =
af848977). Inputs: the spec (rev 11), the plan (rev 4), the build worklist,
`r1-conformance.md`, `r1-adversarial.md`, `r1-adjudications.md`,
`fw1-report.md`, `fw2-report.md`, and the R2 diff packages. Charge, in order:
(1) what round 1 missed, (2) the fix diff cold, (3) adjudication challenges,
(4) per-fix verdicts.

Record note: the reviewer returned this report as TEXT (the harness refuses
report files from subagents); the orchestrator landed it here verbatim apart
from the heading. The orchestrator's rulings are in `r2-adjudications.md`.

---

ROUND-2 SPEC-CONFORMANCE RE-REVIEW - send-outcome-reconcile, HEAD a908f9cb (code = af848977). Read-only. Priority order followed; ~85 of 100 minutes used.

BOTTOM LINE: the fix wave holds up. I re-walked the attempt record (rearm, op token, fenced transitions), the reconcile (window, sibling span, fingerprint, page walk, record-first closes and the superseded re-apply), every send-site failure arm and hand-off, finalize and the dashboard chip. Nothing BLOCKING or HIGH. One NEW double-send path came in with the fix diff: FW1-6's early stop (LOW; confirmed in the harness, only plausible in production). There is one spec-level unknown worth adding to the Sec 10 hosted-dev checks, plus a few LOW items.

## (1) New findings (what round 1 missed)

R2C-1  LOW - mechanism CONFIRMED in the harness, PLAUSIBLE in production - a double text. Introduced by FW1-6.
- Where: sendReconcile.ts:830-833 stops the page walk once a page is newest-first by createdAt and its oldest message is before the window start. On the last check an empty candidate set then falls through to never_sent (:866-874) and a re-drive.
- The flaw: the monotonicity check only covers pages already walked, so it proves nothing about later pages. If the provider sorts on another key, a newer message can sit on a later page. Twilio documents its list as sorted by DateSent; a still-queued message has a null date_sent, and a nulls-last sort would put it on the last page.
- Result: our orphan is never seen, the verdict is never_sent, and the recipient is re-driven. Before FW1-6 the walk read up to 5 pages and adopted it.
- Trigger: more than 1000 prior messages from that sender to that recipient (production page size), AND the orphan out of createdAt order at the final check (+240 s), e.g. still queued at Twilio.
- Consequence: the tenant or member gets the text twice.
- Suggested fix: never let an early-stopped walk produce never_sent. At the last check, walk on to the bound (page_bound -> unresolved) or rule unresolved. Keep the early stop for checks 0-1 and for adoption.

R2C-2  Spec-level, PLAUSIBLE / unverified - possible double text. Not a code defect.
- Evidence: in the spike (research/spike-twilio-idempotency-output.txt, step B1), an unfiltered To+From list taken right after a create returned 5 old messages. The just-created message (status accepted, date_sent null) was absent. It appeared at +2 s, already sent.
- That fits "list lag" (the spec's reading). It fits equally "a message is listed only once it has a date_sent".
- If the second reading is true: a message held in Twilio's queue past +240 s is invisible at all three checks, is ruled never_sent and re-driven (a double text), and R2C-1's ordering hazard is real.
- Action: add both questions (are queued/accepted messages listed; where do null-DateSent rows sort) to the Sec 10 hosted-dev checks.

R2C-3  LOW / NOTE - a share can stay "Sending..." forever after a double fault.
- A broadcast recipient stranded in pass 2 or 3 (FW2-2 carry, or the pre-existing hand-off strand) is still under 30 s old at the cap.
- The cap close's gate therefore defers it: broadcastFanOut.ts:425-433 and :1114-1118.
- The record stays attempting, the slot queued, and finalize defers (:1494-1498) until the Stage 2 sweeper.
- The docblock claim at broadcastFanOut.ts:662-668 ("taken over into reconcile when stale at the cap") holds only for a strand in pass 1. So does spec D8a rev 11's "the broadcast ladder clears it". FW2-2 widened this recorded residue class; it did not create it.

R2C-4  LOW - undeclared spec-text deviations added by the fix wave. The handback must declare them next to ADV-2 and F-2:
- (a) The re-arm moves attemptedAt after the claim (D8a). The relay slot's D20a clock (the claim instant) now differs from the record's (FW2 deviation 1).
- (b) The two-sided window [attemptedAt - 60 s, attemptedAt + 90 s] replaces D13's "to now". Its cost is FW1 residue 4: a request that trickles past +90 s gets never_sent and a double text.
- (c) FW2-6 puts the best-effort follow-ups before the record's done/sent (D7a RECORD order).
- (d) On relay, a stranded rejection or refusal counts toward the D9 brake, although D9 says a rejection resets it (relayFanOut.ts:1633-1645; FW2 deviation 5).

R2C-5  LOW - no double send. In the broadcast's known arms (30007/30005/30006), setRecipient and bumpStats share one guardWrite (broadcastFanOut.ts:680-687).
- If setRecipient succeeds and bumpStats throws, slotWritten is false and the recipient is carried (:731-734).
- The record then stays attempting until the 30-day cleanup, next to a terminal slot the next pass skips. That is a false open record for the future sweeper.
- For 30005/30006 the contact is still flagged sms_unreachable (:704-708), so a later re-drive fences it skipped/unreachable instead of failed/30005.

R2C-6  LOW - no double send; the recipient is stranded. A re-arm that commits and then throws takes the prepare deferral on the PRE-re-arm ref:
- Broadcast: sendMessage.ts:615 into broadcastFanOut.ts:993. Relay: relayFanOut.ts:2085-2096.
- The retryable release then fails its fence, so the record stays attempting with the re-armed clock and the slot is queued/send_retryable.
- On relay it is still fresh at the cap, so the sweeper's. Nothing is ever sent.
- The adjudication called this "harmless"; that is true only in the no-double-send sense.

R2C-7  NOTE - the automated-send breaker increment (sendMessage.ts:549-573) runs before the re-arm hook (:615). A lost or thrown re-arm on an automated share spends a breaker count for a text never sent. Bounded (ladder of 3), cap 10/min.

## (2) Defects in the fix diff

Defects:
- R2C-1 (FW1-6).
- R2C-3: the FW2-2 docblock overclaims.
- R2C-5 (FW2-2, known arms).
- R2C-6 (FW2-1 throw path).
- Log wording, trivial:
  - broadcastFanOut.ts:726-729 still logs "NOT retried" for a rejection that is carried and later re-driven.
  - relayRetryLeg.ts:932-946 logs a refusal/rejection strand with the hand-off wording and emits no root close.
  - deliveryStatus.ts:630-633 comment "belongs to the FAILED legs only" is stale after FW2-9.

Checked cold and sound:
- transition() op token and read-back (sendAttemptsRepo.ts:453-482); finalizeStatus token (broadcastsRepo.ts:943, :974).
- rearm condition, belt and index Put (:379-420); the harness fake mirrors it (twilioWebhookHarness.ts:4401-4415).
- Ref replacement at both sites: the catch builds `held` after the re-arm (relayFanOut.ts:2100; broadcastFanOut.ts:941).
- Record-first closes and the superseded re-apply (sendReconcile.ts:415-419, :890-901, :971-992, :1108-1128). No site close reaches that re-apply wrongly.
- FW2-4 order at all five sites; FW2-5 is a no-op off re-drive passes (relayFanOut.ts:1688).
- Callers of changed contracts: classifySendFailure (2 callers), sendOneRelayLeg (2 callers, both switches exhaustive), finalizeStatus (1 caller). Every transition caller tolerates the new CCF-then-read-fails throw.

## (3) Adjudication challenges

- ADV-4 / FW1-6: challenge the rationale "uses the ORDER the provider actually returned (checked per page)". It cannot cover pages not yet walked. Restrict the early stop as in R2C-1.
- C-1 / FW1-2: agree with the fix. But it is a spec-text deviation (D13 "to now") with its own double-send residue; declare it (R2C-4b).
- C-2 / R-e / FW2-2: agree. Minor: for the known arms, a bumpStats-only failure should not keep the record open (R2C-5).
- Section 6 reading: AGREE. A lost re-arm returns skipped_terminal/'takeover' (relayFanOut.ts:2020-2024). The loop ignores it (:1425-1431). The rung logs and returns (relayRetryLeg.ts:1053-1062). The broadcast writes nothing and carries nothing (broadcastFanOut.ts:887-895, :985-990).
  - Every way the re-arm's condition can fail leaves a taker that already handed off or closed, so no second chain starts.
  - A throw takes the existing deferral; the one nuance is R2C-6.
- FW2-6 adoption half: agree it was right to leave it; activityEvents.record is not idempotent.
- No severity challenges otherwise.

## (4) Per-fix-item verdicts

Test files below are under app/test/; "sR" = sendReconcile.test.ts, "bFO" = broadcastFanOut.test.ts, "rFO" = relayFanOut.test.ts, "rRL" = relayRetryLeg.test.ts.

| item | verdict | code | pinned by |
|---|---|---|---|
| FW1-1 | REAL | sendAttemptsRepo.ts:127, :379-420; comments sendOutcome.ts:21-29, messaging.ts:683-692, sendAttemptsRepo.ts:89-106 | sendAttemptsRepo.integration.test.ts:596, :621, :644, :654, :210, :221, :243 |
| FW1-2 | REAL (see R2C-4b) | sendOutcome.ts:41, :47; sendReconcile.ts:775-793, :828 | sR:2443, :2458, :2470, :2495, :2520 |
| FW1-3 | REAL | sendReconcile.ts:552-564 | sR:2372, :2394, :2412, :615 |
| FW1-4 | REAL | sendReconcile.ts:415-419, :890-901, :971-992, :1108-1128 | sR:1223, :1243, :1337, :1351, :2538, :2559 |
| FW1-5 | REAL | sendAttemptsRepo.ts:453-482; broadcastsRepo.ts:937-980 | sendAttemptsRepo.integration.test.ts:692, :746; broadcastsRepo.integration.test.ts:784 |
| FW1-6 | PARTIAL: built and tested, but introduces R2C-1 | sendReconcile.ts:808-841 | sR:720, :739, :761, :777, :797, :671 |
| FW1-7 | REAL | sendOutcome.ts:105-106 | sendOutcome.test.ts:37 |
| FW1-8 | REAL (coverage-only) | test only | sendReconcile.integration.test.ts:339 |
| FW1-9 | REAL | sendReconcile.ts:522 | sR:1175 |
| FW1-10 | REAL | sendReconcile.ts:363-372, :392-395; sendFingerprint.ts comment | sR:1189 |
| FW2-1 | REAL | sendMessage.ts:386, :615-617; bFO source :887-895, :985-990; rFO source :2016-2025 | bFO:2103, :2178, :2200, :2222; rFO:2277, :2339, :2357, :2376; rRL:1750; sendMessage.test.ts:1305 |
| FW2-2 | REAL (see R2C-3, R2C-5) | bFO source :677-741, :751-769, :964-976, :556-575; rFO source :2145-2148, :2167-2170, :2189-2198, :2234-2246, :1220-1238; rRL source :617-632 | bFO:2249-2316; rFO:2426 (it.each), :2444, :2461; rRL:1671 |
| FW2-3 | REAL | bFO source :642-655 | bFO:2337 |
| FW2-4 | REAL | bFO source :434-446, :646-649; rFO source :1278-1289, :1875-1881; rRL source :680-700 | bFO:2381, :2399, :2414, :2432; rFO:2492, :2506, :2520, :2536; rRL:1981, :2000 |
| FW2-5 | REAL | rFO source :1143-1149 | rFO:2551, :2599 |
| FW2-6 | REAL for the adjudicated scope; adoption half left out under the adjudication's own condition | bFO source :916-917 | bFO:2449 |
| FW2-7 | REAL | bFO source :370 | bFO:2053, :2070 |
| FW2-8 | REAL (refactor; no new logic) | sendAttemptGate.ts:10-39, imported at broadcastFanOut.ts:66, relayFanOut.ts:114, relayRetryLeg.ts:67 | existing gate tests only |
| FW2-9 | REAL | dashboard/src/routes/contact/deliveryStatus.ts:613-634 | deliveryStatus.test.ts:1922 |
| FW2-10 | REAL (coverage; passes by construction) | test only | apiRoutes.test.ts:126 |

## (5) Not verified; throwaway tests

Not verified:
- Real Twilio list order and whether queued messages are listed (R2C-2); DynamoDB Local cannot show it.
- SDK or ClientRequestToken replay behavior.
- The e2e lane under the re-arm; the gate chain was running, so no suite was run.
- R2C-3, R2C-5, R2C-6 and R2C-7 are walked, not reproduced.
- The mutant counts claimed in the FW records.

Throwaway test:
- app/test/zz-r2c-1.test.ts. Setup: page 1 newest-first and older than the window; our orphan on page 2.
- Result: PASSED, i.e. the defect reproduced. Logged LIST_CALLS [null,null,null] (page 2 never read on any of the three checks), RECORD {"state":"redriven","redriveCount":1}, REDRIVES 1.
- Assertion that held: `expect(rec).toMatchObject({ state: 'redriven', redriveCount: 1 })`.
- File deleted.

Tree state: `git status --short` shows only app/test/zz-r2a-1.test.ts and zz-r2a-2.test.ts. They are another reviewer's, not mine, and I left them untouched. No tracked file was modified.
