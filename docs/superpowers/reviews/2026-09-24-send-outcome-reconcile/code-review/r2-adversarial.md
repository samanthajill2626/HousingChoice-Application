# Code review round 2 - adversarial re-review

Reviewer: a FRESH read-only adversarial re-reviewer (Claude Opus 5.5),
dispatched 2026-09-27 14:38 EDT over the fix wave FW1 + FW2 (0dd5d4b7..af848977)
on top of the round-1 reviewed commit 83308e15. HEAD a908f9cb (code =
af848977). Plan-blind: its brief carried `r1-adversarial.md`,
`r1-adjudications.md` (for the adjudication challenges), the R2 diff packages
and repository access - no spec, plan, worklist or fix-wave records - plus the
standing charter (architecture and maintainability; races and concurrency;
security; unintended consequences, sweeping every consumer and mutator of the
touched state). Charge, in order: (1) what round 1 missed, (2) the fix diff
cold, (3) adjudication challenges, (4) per-fix verdicts.

Record note: the reviewer returned this report as TEXT (the harness refuses
report files from subagents); the orchestrator landed it here verbatim apart
from the heading. The orchestrator's rulings are in `r2-adjudications.md`.

---

ROUND-2 ADVERSARIAL RE-REVIEW - feat/send-outcome-reconcile at HEAD a908f9cb (code = af848977). Read-only. Three throwaway tests were written, run one at a time and deleted; `git status --short` is empty. I did not run npm test, any e2e, smoke or build, and did not touch the live Playwright lane (PIDs 27908/64532/36188).

The adjudication, fw1 and fw2 records were read for context only; nothing below depends on them.

## (1) New findings - what round 1 missed

N-1. LOW, CONFIRMED (zz-r2a-1). A broadcast recipient carried into the last rung with a still-fresh `attempting` record is never closed, and the share stays "Sending" forever.
- User-visible: the share never leaves "Sending", with the recipient stuck at queued and nothing left to pick it up.
- Mechanism:
  - The cap-close gate treats any `attempting` record younger than the TTL as live and defers it (sendAttemptGate.ts:35-38 -> broadcastFanOut.ts:430-433).
  - finalize then waits on the queued slot indefinitely (broadcastFanOut.ts:1493-1498).
  - Nothing else will act on it: there is no continuation after close A (:1114-1118) or on a re-drive's capped claim (:1099-1102), no reconcile chain, and no sweeper.
- Which carries reach it:
  - Round 1 missed the pre-existing one: the stranded hand-off (handToReconcile write threw, :603).
  - FW2-2 added three more, each leaving the record attempting and the recipient carried: onRejected (:731-734), the refusal arm (:972-976) and the second-unknown close (:761-769).
- Why the ladder cannot rescue it: the ladder spacing is 10 s then 20 s (:148-150, MAX 3 at :136) against a 30 s TTL (sendOutcome.ts:29). So only a pass-1 failure can ever be taken over, and only at pass 3.
  - A failure in pass 2 or pass 3 always gets stuck.
  - So does any failure in a re-drive pass, which meets a spent ladder (or reaches the cap 20 s later).
  - The broadcast second-unknown arm only runs on re-drive passes, so FW2-2 never helps it.
- Evidence (zz-r2a-1):
  - Last rung, 21211 with the reject-slot write throwing: `SLOT {"status":"queued"}`, `RECORD {"state":"attempting"}`, `STATUS sending FANOUT_ATTEMPT 3`, `PENDING_JOBS 0`, `CAP_GATE_LINES ["defer"]`. Failing assertion: `expected 'sending' to be 'sent'`.
  - Re-drive pass: `REDRIVE RECORD {"state":"attempting","attemptNo":2}`, `REDRIVE STATUS sending PENDING_JOBS 0`.
- Fix direction: when a failure-arm write throws, hand the attempt to reconcile directly instead of carrying a live record. Alternatively, let close A take over records that this same pass abandoned (tracked in a local set), whatever their age.

## (2) Defects in the fix diff

F-1. MEDIUM. The mechanism is CONFIRMED (zz-r2a-2); a real double text is PLAUSIBLE. The FW1-6 early stop can support a `never_sent` verdict and re-send a text that is still sitting in the provider's queue.
- User-visible: the tenant gets the same text twice.
- Where: sendReconcile.ts:808-841 (stop at :833, order check at :830), which reaches never_sent at :874.
- The flaw: the stop "trusts the order returned", but checking that pages are non-increasing in date_created cannot detect a list sorted by date_SENT.
  - In such a list every sent message is still ordered by date_created, so the check passes.
  - Meanwhile a still-queued in-window orphan (no date_sent) sorts onto a later page.
  - The list order is still UNVERIFIED against real Twilio (spec Sec 10).
- It is a regression against 83308e15: with 2-5 pages, the old walk read every page and would have adopted the orphan.
- Preconditions: more than 1000 messages from that sender to that recipient, and the orphan still unsent at check 2 (a provider queue backlog).
- Evidence (zz-r2a-2): `LIST_CALLS 3 PAGE_TOKENS [null,null,null]` (each check read page 1 only), `RECORD {"state":"redriven","redriveCount":1}`, `REDRIVES [{"broadcastId":"bcast-1","recipientKeys":["t-1"],"attempt":1,"redrive":true}]`. Failing assertion: `expected { ...(11) } to match object { state: 'done', ...(2) }`.
- Fix direction: keep the early stop only for adoption; `never_sent` should require a walk that reached the end of the list, otherwise unresolved.

F-2. LOW, CONFIRMED by reading. The broadcast part of FW2-2's own promise is false, and so is the FW2 residue that restates it.
- The docblock at broadcastFanOut.ts:663-668 says "taken over into reconcile when stale at the cap".
- fw2-report.md:248 says "at the broadcast cap it is taken over".
- Both are false for most positions on the ladder; see N-1. The residue should say the share stays "Sending".

F-3. LOW. FW2-6 (afterSend at broadcastFanOut.ts:916, before finishAttempt at :917) now holds the record `attempting` through the A2P token wait (:790).
- The token bucket is shared, first-come-first-served, by every SMS job in the worker (registerHandlers.ts:60-78), and relay draws one token per leg. So "well under 30 s" (fw2-report.md:262) is not guaranteed under load.
- A takeover of a recipient that was already sent is harmless: the adoption finds the slot moved, and finishAttempt logs a lost fence at WARN.
- It does widen the takeover window used by A-1 below.

F-4. LOW (maintainability). deliveryStatus.ts:625-628 still says the reason "belongs to the FAILED legs only", but :620-623 now appends the send_unconfirmed sentence.
- relayRetryLeg.ts:944's "its hand-off to reconcile was not written" also now mislabels the new C-2 stranded arms.

## (3) Adjudication challenges

A-1. LOW, CONFIRMED in the harness with the stall simulated (zz-r2a-3). This challenges ADV-1's premise and the residue FW3 plans to file.
- r1-adjudications.md:53-55 says "with the re-arm it can no longer produce a second send", and :271 says the same. That is false.
- User-visible: the tenant can still get two texts.
- Mechanism:
  - Each site stamps the re-arm clock before calling rearm (broadcastFanOut.ts:888; relayFanOut.ts:2020).
  - rearm then makes two DynamoDB round trips with no time limit: a consistent GET (sendAttemptsRepo.ts:383) and a TransactWrite (:387-409). The client sets no requestTimeout (lib/dynamo.ts:65,71; smithy defaults it to 0).
  - Case 1, stall after the commit: another pass takes the attempt over and the chain rules never_sent, then the stalled pass still sends.
  - Case 2, GET stall of 90 s or more before the commit: the message lands after the window's end (sendOutcome.ts:41; sendReconcile.ts:777,828), so never_sent at check 2 re-drives it.
  - The two-sided window (FW1-2) cut the stall needed from about 210 s to 90 s.
- Evidence (zz-r2a-3): `AFTER_B {"state":"reconciling"}`, `SENDS_BEFORE_A_RESUMED 1`, `SENDS_TOTAL 2 ["+15550100001","+15550100001"]`, `RECORD {"state":"done","outcome":"sent","attemptNo":2,"redriveCount":1}`. Failing assertion: `expected [...] to have a length of 1 but got 2`.
- Fix direction: take the timestamp inside rearm after the GET, then re-check the elapsed time after the TransactWrite and do not send if too much time has passed (release as retryable, fenced). Or bound the client (requestTimeout plus throwOnRequestTimeout).

A-2. FW1-6 / ADV-4 was adjudicated "an unordered list walks on exactly as today" (r1-adjudications.md:70). A list ordered by date_sent passes the order check and does not walk on; see F-1.

A-3. C-2 (MEDIUM, FIX). The fix chosen, carrying a live record, cannot work on a ladder whose total span (15 s relay, 30 s broadcast) is at or below the TTL.
- relayFanOut.ts:1400-1408 already concedes this for relay; for the broadcast see N-1.
- I suggest re-ruling it as "hand the attempt to reconcile", or filing it honestly as "the share stays Sending".

## (4) Per-fix verdicts (code at HEAD; the pinning test)

| Item | Verdict | Code | Pinning test / note |
|---|---|---|---|
| FW1-1 ADV-1 repo half | REAL | sendAttemptsRepo.ts:379-420 | sendAttemptsRepo.integration "rearm ..." cases incl. :221, plus the parity file. Residual: A-1. |
| FW1-2 C-1/F-1 | REAL | sendReconcile.ts:775-793,828 | sendReconcile.test.ts:2443 (F-1), :2458 (late-S) |
| FW1-3 F-2 | REAL | sendReconcile.ts:552-564 | :2372 |
| FW1-4 ADV-2 | REAL | sendReconcile.ts:405-421, 971-992, 1108-1128 | :1243 (zz-adv-3), :2559 (relay twin), :1351 (crash completion) |
| FW1-5 ADV-3 | REAL | sendAttemptsRepo.ts:453-482; broadcastsRepo finalizeStatus | sendAttemptsRepo.integration :692, :746; broadcastsRepo.integration :784 |
| FW1-6 ADV-4 | PARTIAL | sendReconcile.ts:808-841 | Page_bound fix pinned by :720; introduces F-1 |
| FW1-7 C-5 | REAL | sendOutcome.ts:106 | sendOutcome.test.ts:37 |
| FW1-8 C-7 | Coverage-only | none (test only) | sendReconcile.integration.test.ts:339 |
| FW1-9 C-8 | REAL | sendReconcile.ts:522 | :1175 |
| FW1-10 ADV-9 part | REAL | sendReconcile.ts:363-372, 392-395; comment sendFingerprint.ts:31-42 | :1189 |
| FW2-1 ADV-1 sites | REAL for a stall before the re-arm | broadcastFanOut.ts:887-895, 985-990; relayFanOut.ts:2016-2025; sendMessage.ts:615-617 | broadcastFanOut.test.ts:2103,2178,2200,2222; relayFanOut.test.ts:2277. Residual: A-1. |
| FW2-2 C-2/R-e | PARTIAL | broadcastFanOut.ts:731,761,972 | Tests at broadcastFanOut.test.ts:2249-2333 only exercise first-pass positions (N-1, F-2) |
| FW2-3 C-3 | REAL | broadcastFanOut.ts:642-655 | :2337 |
| FW2-4 C-4/R-a | REAL | broadcastFanOut.ts:436-445,646-649; relayFanOut.ts:1280-1289,1875-1881; relayRetryLeg.ts:680-699 | broadcastFanOut.test.ts:2381-2432; relayFanOut.test.ts:2492-2536; relayRetryLeg.test.ts:1981,2000 |
| FW2-5 ADV-5 | REAL | relayFanOut.ts:1143-1149 | relayFanOut.test.ts:2551 |
| FW2-6 ADV-6 | PARTIAL | broadcastFanOut.ts:916 | Pass half pinned by :2449; adoption half unbuilt (declared: the milestone write is not idempotent); see F-3 |
| FW2-7 ADV-7 | REAL | broadcastFanOut.ts:370 | :2053, :2070 (the fake cannot show eventual consistency) |
| FW2-8 ADV-10 | REAL (refactor) | lib/sendAttemptGate.ts | Existing gate tests plus the FW2 mutant log |
| FW2-9 C-6/R-d | REAL | deliveryStatus.ts:620-623 | Restated pin in deliveryStatus.test.ts; stale comment F-4 |
| FW2-10 D-5 | Coverage-only | none (test only) | apiRoutes.test.ts:125 |

## (5) Not verified, and the throwaway tests

Not verified:
- Twilio's real list sort key and where unsent messages sort (F-1).
- DynamoDB's ClientRequestToken replay behaviour for rearm, and how likely a 90 s or longer stall is on the single-EC2 deployment (A-1).
- Existing suites were not re-run. The verdicts come from reading the code, the named tests and the FW mutant tables.
- Not swept: fake-twilio and the e2e specs.
- Checked and found sound: nothing consumes the messages-table stream (only the infra output at infra/modules/dynamodb/outputs.tf:11); finalize_op does not leak (routes/broadcasts.ts:280-310 build responses field by field); the relay rollup's isFailure does not offer Retry (Timeline.tsx:1031, 1426 read the message's own status).

Throwaway tests (all deleted):
- zz-r2a-1: stuck at cap. FAILED as the probe expected (2/2), confirming N-1.
- zz-r2a-2: early stop with a date_sent-ordered list. FAILED as expected, confirming F-1's mechanism.
- zz-r2a-3: re-arm commit then stall. FAILED as expected, confirming A-1 with the stall simulated.
