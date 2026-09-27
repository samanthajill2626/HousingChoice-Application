# Code review round 1 - adjudications and the fix-wave list

Orchestrator adjudication of `r1-conformance.md` (C-1..C-11, D-1..D-6) and
`r1-adversarial.md` (ADV-1..ADV-10), plus the build's own held items (R-a, R-b,
R-c2, R-d, R-e; S3b F-1 and F-2). HEAD 83308e15. The P3 gates at that commit were
all green (typecheck 0; npm test 0; smoke 0; e2e 289 passed; lint 0 new), so
every item below is a correctness or honesty defect the suites did not see.

Load-bearing claims were re-checked in the source before ruling: the claim is
written before the presign, the aggregation write and the provider call
(relayFanOut.ts:1941-2021); the DynamoDB client is built with no request
timeout (lib/dynamo.ts:61-78); relay.numberReady carries no run-once marker.

Rulings: FIX (in the ONE fix wave, split by file ownership into FW1 -> FW2 ->
FW3, run sequentially), RESIDUE (filed as an issue, not fixed), NOTE (the
handback states it).

## 1. Rulings

| id | severity | ruling | where |
|---|---|---|---|
| ADV-1 | CRITICAL, confirmed | FIX - re-arm the claim immediately before the provider call | FW1 (repo), FW2 (sites) |
| C-1 / F-1 | BLOCKING | FIX - two-sided candidate window + sibling bounds from it | FW1 |
| F-2 | observation | FIX - body hash AND media count for every body | FW1 |
| ADV-2 | HIGH, confirmed | FIX - the job's own closes write the record first | FW1 |
| ADV-3 | MEDIUM, confirmed | FIX - an op token makes every fenced transition retry-safe | FW1 |
| ADV-4 | MEDIUM, confirmed | FIX - page walk stops at the window's edge; page_bound only at the last check | FW1 |
| C-5 | LOW | FIX - a standalone 20429 code is retryable | FW1 |
| C-7 | LOW | FIX - integration test: a receipt after adoption routes | FW1 |
| C-8 | LOW | FIX - a phone# broadcast key's current number is its own | FW1 |
| ADV-9 | LOW | FIX the comment and the INFO line; RESIDUE the unkeyed hash | FW1 / FW3 |
| C-2 / R-e | MEDIUM, confirmed | FIX - a terminal arm writes the record only after its slot write resolved | FW2 |
| C-3 | MEDIUM, confirmed | FIX - a failed broadcast fence write defers and carries | FW2 |
| C-4 / R-a | LOW | FIX the order (closeRedriven FIRST for a redriven gate) | FW2 |
| C-4 / R-b | LOW | RESIDUE - the gate-then-close window | FW3 |
| ADV-5 | LOW, confirmed | FIX - a re-drive pass refuses a carried member off the roster | FW2 |
| ADV-6 | LOW, confirmed | FIX - property rows survive a record-phase throw | FW2 |
| ADV-7 | LOW, plausible | FIX - every broadcast pass reads its snapshot consistently | FW2 |
| ADV-10 | LOW | FIX - one shared gate helper | FW2 |
| C-6 / R-d | LOW | FIX - the mixed relay chip carries the not-confirmed reason too | FW2 |
| D-5 | LOW | FIX - route-level test for the 201 | FW2 |
| C-11 / R-c2 | LOW | RESIDUE - a known-send hand-off failure closes unresolved | FW3 |
| D-3 | LOW | RESIDUE - duplicate chains with different verdicts | FW3 |
| ADV-8 | LOW | RESIDUE - the route's unconditional markFailed vs the conditional finalize | FW3 |
| C-9, C-10, D-1, D-2, D-4, D-6 | - | NOTE (handback); C-10 already filed | - |

Reasons for the rulings that are not self-evident:
- ADV-1: the spec's premise for the claim TTL (D8a: "a claim older than the
  TTL can only belong to a dead or overrunning call") is false because the
  claim precedes unbounded database work. Re-arming the claim at the provider
  call restores the premise instead of weakening the takeover; it is an
  engineering fix of a spec guarantee (Sec 1 guarantee 1), not a product
  decision. The DynamoDB client's missing request timeout is NOT changed here
  (a global client change beyond this branch); with the re-arm it can no
  longer produce a second send - FW3 files it.
- C-1: agree with the conformance reviewer that lowering the sibling bound alone
  is not enough while the candidate window has no upper end; with the re-arm,
  our own message can only be created while our request is in flight, so a
  two-sided window is sound and a late check can no longer adopt a later
  attempt's message.
- ADV-2: inverts spec D8's "the reconcile job's own closes write the slot FIRST"
  - a declared deviation. Crash safety is kept by extending ruling A7: a
  redelivered check that finds the record `done` for its own attempt re-applies
  the idempotent slot close.
- ADV-3: an op token (not a state comparison) because a takeover and a
  hand-off produce the same record state; only a token proves "my write
  committed".
- ADV-4: the early stop uses the ORDER the provider actually returned (checked
  per page), because the list order is still UNVERIFIED against real Twilio
  (spec Sec 10); an unordered list walks on exactly as today.
- C-4 / R-b: closing the gate-then-close window fully needs a transactional
  condition on the record with every other writer's slot write (fences,
  cap-closes, the suppression arm, refuseGate / closeTerminally) - a design
  change larger than this branch; its damage is a mislabeled slot, never a
  second send, and it needs two passes on one key inside one DynamoDB round
  trip. The redriven case - the one a real re-drive can produce - is closed by
  the R-a reorder.
- C-11, D-3, ADV-8: each needs a double fault or an SQS duplicate plus a
  flapping provider; each mislabels, none sends twice.
- F-2: every short-body case the plan's rule adopted either matches on the hash
  as well, or is someone else's message; an own orphan that no longer matches is
  an UNMATCHED candidate, which ends `unresolved` at the last check and never
  `never_sent` - so the tightening cannot produce a re-send. Declared spec-text
  deviation (extends S3a deviation 1).

## 2. FW1 - the attempt record and the reconcile core

Files: `app/src/repos/sendAttemptsRepo.ts`, `app/test/sendAttemptsRepo.integration.test.ts`,
`app/test/helpers/twilioWebhookHarness.ts` (the fakes), `app/test/twilioWebhookHarnessSendAttempts.integration.test.ts`,
`app/src/repos/broadcastsRepo.ts` (finalizeStatus only) + its tests,
`app/src/jobs/sendReconcile.ts`, `app/test/sendReconcile.test.ts`,
`app/test/sendReconcile.integration.test.ts`, `app/src/lib/sendOutcome.ts`
(C-5 + the ADV-1 comment), `app/test/sendOutcome.test.ts`,
`app/src/lib/sendFingerprint.ts` (comment), `app/src/adapters/messaging.ts`
(the ADV-1 comment only).

FW1-1 (ADV-1, repo half). New `SendAttemptsRepo.rearm(owner, ref: AttemptRef,
nowIso: string): Promise<AttemptRef | undefined>` - ONE TransactWrite: Update the
record `SET attempted_at = :now, expires_at = :exp` with condition
`attempt_state = attempting AND attempt_no = :no AND attempted_at = :at`, plus a
Put of a NEW index item for `:now` (the claim's index-item shape, so the
recipient index finds the attempt by its re-armed time). Returns
`{ attemptNo, attemptedAt: nowIso }` when written; `undefined` when index 0's
condition failed (the attempt was taken over); rethrows anything else (the
claim's cancellation attribution). The harness fake mirrors it exactly (parity
cases: re-arm of the own attempt; re-arm after a takeover; re-arm with a stale
ref; re-arm then listByRecipient finds the attempt by the new time; a stale
takeover measured from the re-armed time). Fix the comments that state the TTL
premise (`sendOutcome.ts:20-25`, `messaging.ts:683-690`, and the claim docblock)
to: the TTL is measured from the attempt's LAST re-arm, which every send site
performs immediately before the provider call.

FW1-2 (C-1 / F-1). The lookup's candidate window becomes two-sided:
`[attemptedAt - RECONCILE_WINDOW_LEAD_MS, attemptedAt + SEND_CLAIM_TTL_MS + RECONCILE_WINDOW_LEAD_MS]`
(name the new bound as a constant in `sendOutcome.ts`). Siblings: query
`listByRecipient(sender, digest, attemptedAt - SPAN)` and keep live records whose
`attemptedAt` lies within `[attemptedAt - SPAN, attemptedAt + SPAN]`, where
`SPAN = 2 * RECONCILE_WINDOW_LEAD_MS + SEND_CLAIM_TTL_MS` (two windows overlap
exactly when their attempts are within SPAN). Tests: S3b's F-1 interleaving (S
at t=0, O at t=238: S cannot adopt O's message; O adopts it; S is re-driven);
the conformance reviewer's late-S variant (S's final check runs very late: it
still cannot adopt a later attempt's message); both window edges inclusive.

FW1-3 (F-2). `matches(record, m)` = media count equal AND body hash equal, for
every body; `sameFingerprint(a, b)` = media count equal AND body hash equal
(the exact mirror). `bodyShort` stays on the record but no longer decides a
match. Tests: two short-name members' media-only legs to one recipient do not
adopt each other; the STOP auto-reply still never matches; the Smart-Encoded
body still matches its submitted body; update the tests that pinned the old
short-body rule.

FW1-4 (ADV-2). `closeUnresolved` and `sendReconcile.ts`'s `closeRedriveRefused`
write the RECORD first (`closeFromReconcile` / `closeRedriven`, fenced) and
close the slot only when that returned true; the superseded exit (ruling A7)
additionally re-applies the matching idempotent slot close when the record is
`done` for the payload's attemptedAt with outcome `unresolved` (->
`send_unconfirmed`), `redrive_refused` (-> `redrive_refused`) or
`enqueue_failed` (-> `enqueue_failed`), then runs afterClose. Tests: zz-adv-3's
interleaving (a duplicate delivery of the last check that closes unresolved
while a re-drive is mid-send) must fail before the change and pass after; a
crash between the record close and the slot close is completed by the
redelivery.

FW1-5 (ADV-3). Every fenced transition in `sendAttemptsRepo.ts` (`finishAttempt`,
`handToReconcile`, `takeOver`, `recordCheck`, `markRedriven`,
`closeFromReconcile`, `closeRedriven`) and `broadcastsRepo.finalizeStatus`
writes a fresh random op token (attribute `last_op`; `finalize_op` on the
broadcast) and, on ConditionalCheckFailedException, re-reads consistently and
returns success when the stored token equals its own (the write committed on an
earlier SDK attempt). The fakes store the token too (behavior unchanged - they
never retry). Tests: a document client that commits a write and then raises
ConditionalCheckFailedException on the SDK's replay (zz-adv-5's method) - the
transition reports success; a genuinely lost fence still reports false;
finalizeStatus reports `won: true` to the retried winner and `won: false` to a
second finalizer.

FW1-6 (ADV-4). The page walk stops once a page's messages are in
non-increasing `createdAt` order (and not newer than the previous page's last
message) and its oldest message is older than the window start. A walk cut by
`RECONCILE_MAX_PAGES` with a next page pending is `page_bound` only at the LAST
check (earlier checks `continue`), and only when the early stop did not apply.
Candidates newer than the window's upper bound are ignored (FW1-2). Tests:
zz-adv-4 (heavy old history, the orphan on page 1 -> adopted at check 0); a list
whose order is not monotonic walks on as today; page_bound at a non-last check
continues.

FW1-7 (C-5). `classifySendFailure`: after the 5xx rule, a code `20429` is
`retryable` whatever the status. Test.

FW1-8 (C-7). Integration test (DynamoDB Local): adopt an orphan, then deliver a
status callback for that SID through the app's status webhook handler and assert
the slot moves (relay leg and broadcast recipient).

FW1-9 (C-8). `currentPhone` for a broadcast recipient keyed `phone#<E164>`
returns the key's own number (no GSI read), as the relay branch does. Test.

FW1-10 (ADV-9, part). The "owner recipient not found" INFO logs the owner kind
and its ids, never `recipientKeyHash`; correct `sendFingerprint.ts:30` (the
record's `owner` map does keep the raw recipient key).

## 3. FW2 - the send sites, the send wrapper, the dashboard

Files: `app/src/services/sendMessage.ts` + test, `app/src/jobs/broadcastFanOut.ts`
+ test, `app/src/jobs/relayFanOut.ts` + test, `app/src/jobs/relayRetryLeg.ts` +
test, NEW `app/src/lib/sendAttemptGate.ts` (+ test if the helper gains logic),
`dashboard/src/routes/contact/deliveryStatus.ts` + test, one app route test file
for D-5.

FW2-1 (ADV-1, site half). Each send site calls `attempts.rearm(owner, ref,
now)` as the LAST step before the provider call and, on success, replaces its
`ref` with the returned one (every later fenced write uses it). Relay unit:
after the `attempted` aggregation write, still in phase `prepare`. Broadcast:
`sendMessage` gains an optional input `beforeProviderSend?: () =>
Promise<boolean>`, called after every pre-provider step and immediately before
`adapter.sendPreparedMessage`; `false` throws a new `SendClaimLostError`
(extends `SendNotAttemptedError`), a throw is wrapped as
`SendNotAttemptedError`. On a LOST claim (`undefined` / `SendClaimLostError`)
the site does NOT send, writes no slot and no record, does not carry the
recipient (the takeover chain owns it) and logs INFO; the relay unit returns
`skipped_terminal` with reason `takeover`. A re-arm that THROWS is the
post-claim prepare failure (release retryable on the pre-re-arm ref - fenced, so
harmless if the re-arm had applied - and defer). No other `sendMessage` caller
changes. Tests: zz-adv-6's interleaving (a pass stalled between claim and send,
taken over, re-driven; the stalled pass resumes and does NOT send) on relay and
on broadcast; a lost re-arm writes nothing.

FW2-2 (C-2 / R-e). In every TERMINAL failure arm (broadcast `onRejected`
incl. the 30007 / 30005 / 30006 arms, the refusal arm, the second-unknown close,
`handOff`'s enqueue-failure close; relay rejected / filtered / refused arms, the
second-unknown close, `handOff`'s enqueue-failure close; the rung's `handOff`
enqueue-failure close) the record transition runs only when the slot write
RESOLVED; when it threw, leave the record open (the sweeper's class) and carry
the recipient as stranded where a pass can still act (broadcast: carried;
relay: `stranded`). Deferral arms are unchanged. Tests: P1's scenario (a 21211
whose reject-slot write throws) leaves the record `attempting` and the recipient
carried; the relay twin.

FW2-3 (C-3). A broadcast fence write that throws reaches the unit's prepare
catch (deferSlot + carry) instead of being swallowed. Test: P2's scenario.

FW2-4 (C-4 / R-a). For a gate that returned `proceed` with a `redriven` record,
every close by another writer (closeBroadcast, closeRelay, the rung's
closeUnlessOwned, the broadcast fences, the relay suppression arm) runs
`closeRedriven` FIRST and writes its slot only when that returned true (false:
INFO, leave the recipient to whoever re-claimed it). Tests per site.

FW2-5 (ADV-5). A relay-leg RE-DRIVE pass closes every carried member no longer
on the roster `redrive_refused` / cause `member_removed` (record first, then
the slot, as the pass's other re-drive refusals). Test: zz-adv-2.

FW2-6 (ADV-6). The broadcast record phase runs `afterSend` (token, milestone,
listing-send - each best-effort) right after the slot write moved and BEFORE
`finishAttempt(sent)`, so a finishAttempt throw no longer skips them. Also: when
the adoption finds the slot already carrying THIS row's tsMsgId with status
sent/delivered, it writes the property rows - ONLY if both writes are proven
idempotent (read `activityEvents.record` and `listingSends.recordSend`); if
either is not, leave that half and report it. Test: zz-adv-1.

FW2-7 (ADV-7). Every broadcast pass (the first one too) reads its snapshot with
`getByIdConsistent`. Update the tests that pinned the first-pass read.

FW2-8 (ADV-10). Extract `gateFor` / `GateResult` into
`app/src/lib/sendAttemptGate.ts` and use it from the three sites (no behavior
change; the existing gate tests keep passing).

FW2-9 (C-6 / R-d). When a real failure sits beside a `send_unconfirmed` leg,
the relay rollup chip's reason joins the D20 sentence after the failed legs'
reasons. Update the pinned test.

FW2-10 (D-5). One route-level test: the staff send route answers 201 (not 500)
when a post-append step (the inbox touch) fails after a successful send.

## 4. FW3 - residues filed (docs/issues only)

- `send-attempt-gate-then-close-window` (new, low): C-4 / R-b - the gate read
  and another writer's close are not atomic (fences, cap-closes, the suppression
  arm, refuseGate / closeTerminally); a claim between them can be recorded under
  the close; closing it needs a transactional record condition with the slot
  write; the redriven case is closed (FW2-4).
- C-11 / R-c2 -> `fanout-close-path-robustness-residues`: a known-send hand-off
  enqueue failure closes the record `unresolved` and the slot `send_unconfirmed`
  although the provider accepted the message (a double fault).
- D-3 -> `send-reconcile-job-residues`: two deliveries of one check reaching
  different verdicts (unresolved vs found) can leave the slot `send_unconfirmed`
  beside an appended row; needs an SQS duplicate plus a flapping provider.
- ADV-8 -> new, low: the broadcast send route's unconditional `markFailed` on an
  ambiguous enqueue failure cannot be undone by the conditional finalize.
- ADV-9 -> new, low: the recipient hashes are unkeyed sha256 over a phone
  (brute-forceable); keying needs a secret (infra - not on this branch).
- ADV-1 note -> `send-attempt-sweeper` or new: the DynamoDB client has no request
  timeout; with the re-arm it cannot produce a second send, but a stalled
  prepare still holds a claim until it is taken over.
- ADV-3 note: the non-record conditional writes (slot/stats) keep the plain
  "condition failed = someone else" reading; an SDK replay can only cost a
  progress tick there.

## 5. Notes for the handback (no change)

C-9 (the undeclared deviations: the per-key catches in the close loops; T10-14's
record-first redriven close; T4-1; the match rule), C-10 (filed), D-1 (no batch
read exists), D-2 (spec text drift: Sec 8 item 6, Sec 2's broadcast
`attemptedAt`, D7a "as today"), D-4 (the hosted-dev check also covers link
shortening and Advanced Opt-Out), D-6 (the Sec 10 checks), the S5b lane-timing
adjudication, and the AGENTS.md log-capture observation.

## 6. Human ruling on ADV-1 (Cameron, 2026-09-27, relayed by the planner)

"A double text is annoying, NOT critical" - he would rather risk a double text
than take on new failure points or a lot of redo. Applied:

- ADV-1 is reclassified from CRITICAL to HIGH (the reviewer's own report in
  `r1-adversarial.md` keeps its original grading - it is the reviewer's record).
- FW1-1 (the repo `rearm()`, landed at 0dd5d4b7 as one fenced write mirroring
  the claim) stays.
- The FW2 site half is MINIMAL: one `rearm` call immediately before the
  provider call at each send site, failing CLOSED - `undefined` means another
  writer took the attempt over, so the site does not send and takes the
  existing path for an attempt another writer took over (the relay unit's
  existing "takeover lost" / G5 fence-lost outcome, `skipped_terminal` - the
  taker already handed the attempt to reconcile, so no second chain is
  started); a THROW takes the existing post-claim prepare-phase deferral. No new
  machinery, no DynamoDB client timeout change (a filed residue), no extra
  retries or states.
- If the site half grows beyond those insertions, breaks existing pins in a way
  that needs redesign, or introduces a new failure mode, ADV-1 STOPS: the site
  calls are reverted, `rearm()` stays in the repo unused-but-tested (or is
  dropped - the FW2 record states which), the double-text window under a
  >30 s pre-send stall is filed as a docs/issues item with the re-arm as the
  designed fix, and the wave continues without it. The FW2 record states the
  size of the site half (files, lines) either way.
- Everything else in the wave stands as adjudicated.
