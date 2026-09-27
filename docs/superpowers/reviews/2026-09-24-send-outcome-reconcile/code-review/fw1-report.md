# Fix wave FW1 - the attempt record and the reconcile core

Implementer: Claude Opus 5.5 (1M context). Worktree `W:\tmp\send-outcome-reconcile`,
base 282116ee, HEAD 518053ee. All of FW1-1 .. FW1-10 (`r1-adjudications.md`
section 2) built, tested and committed; the tree is clean. No FW2-owned or
fenced file changed (0 diff lines in twilio.ts, jobs.ts, sqsJobConsumer.ts,
retrySend.ts, registerHandlers.ts, broadcastFanOut.ts, relayFanOut.ts,
relayRetryLeg.ts, sendMessage.ts, dashboard/ and docs/issues); no run-once
marker added (the only putJobExecutionMarker mention in sendReconcile.ts is the
docblock at :11). Every commit: bare git status read, MERGE_HEAD absent,
explicit paths, 0 non-ASCII added bytes, typecheck 0 with 0 "error TS",
Co-Authored-By trailer.

Record note: the implementer returned this report as TEXT (the harness refuses
report-file writes from implementer subagents); the orchestrator landed it
here with its checkpoint appended, per AGENTS.md.

## Commits

- `0dd5d4b7 fix(repos): re-arm the send attempt immediately before the provider call, and make every fenced transition safe against the SDK's own replay (code review ADV-1, ADV-3; FW1-1, FW1-5)`
- `0a7e3950 fix(repos): finalizeStatus tells a flip that committed on an earlier SDK attempt from a genuine loser (code review ADV-3; FW1-5)`
- `782c9796 fix(jobs): send.reconcile's window is two-sided, its siblings are every attempt whose window overlaps, and a fingerprint is the body hash AND the media count for every body (code review C-1, S3b F-1, F-2; FW1-2, FW1-3)`
- `ebc3a1f4 fix(jobs): send.reconcile's own closes write the record first and touch the slot only when that close won; a redelivery re-applies the slot close its outcome implies (code review ADV-2; FW1-4)`
- `6763d51b fix(jobs): send.reconcile's page walk stops at the window's edge and cuts to page_bound only at the last check; a phone-keyed share recipient is looked up by its own number; the not-found INFO carries no recipient hash (code review ADV-4, C-8, ADV-9; FW1-6, FW1-9, FW1-10)`
- `04250da0 fix(lib): a standalone Twilio 20429 is retryable whatever the status, ranked after the 5xx rule (code review C-5; FW1-7)`
- `7f51192f test(jobs): a receipt for an adopted orphan routes through the app's status webhook onto the adopted slot - relay leg and broadcast recipient, on DynamoDB Local (code review C-7; FW1-8)`
- `988a4e44 test: FW1 mutant pass - pin the four decisions the new tests did not yet hold (FW1-1, FW1-2, FW1-4, FW1-6)`
- `518053ee test(repos): the 101-claim paging case binds its own facts, so an overrun on a loaded DynamoDB Local cannot write into the next case's index partition`

## Per item (built -> regression test(s) -> the failing line on the pre-fix code)

**FW1-1 (ADV-1, repo half).** `SendAttemptsRepo.rearm` (interface
sendAttemptsRepo.ts:127, implementation :379); a shared `indexItem` helper
(:196) used by the claim and the re-arm; `recordConditionFailed` attribution
(:210); harness fake `rearm` (twilioWebhookHarness.ts:4401) with
`putAttemptIndex` (:4346). The TTL premise is restated in sendOutcome.ts (the
SEND_CLAIM_TTL_MS docblock), messaging.ts (the TWILIO_REQUEST_TIMEOUT_MS
docblock), the ClaimResult docblock and the claim's TTL line. Tests
(sendAttemptsRepo.integration.test.ts): "rearm re-arms THIS attempt in ONE
transaction...", "rearm refuses a ref that is not the live attempt...", "rearm
after a takeover is refused: the stalled pass learns it lost the attempt and
must not send (FW1-1, the zz-adv-6 interleaving at the repo)", "the claim TTL
is measured from the attempt's LAST re-arm, and listByRecipient finds the
attempt by its re-armed time", three stub-client attribution cases; the parity
file gains 3 re-arm scripts (own attempt, stale refs, takeover measured from
the re-arm, re-arm after takeover refused; no sender and same-instant;
re-claimed attempt and re-drive, absent and done records). Failing line:
`TypeError: repo.rearm is not a function`; parity `TypeError: Cannot read
properties of undefined (reading 'get')`.

**FW1-2 (C-1 / F-1).** sendOutcome.ts:41 `RECONCILE_WINDOW_TRAIL_MS` and :47
`RECONCILE_SIBLING_SPAN_MS`; sendReconcile.ts:777 the window end; :786 the
sibling query from `attemptedAt - SPAN`; :791 the live-start filter, both
bounds; :828 the candidate filter on both bounds, inclusive. Tests
(sendReconcile.test.ts): "F-1: O claims 238 s after S with the same
fingerprint - S cannot adopt O's message...; O adopts it; S is re-driven";
"C-1 late-S variant: however late S's final check runs, it never adopts a
message created after its window"; "the window's upper edge is inclusive...";
"the sibling span is two-sided and inclusive..."; mutant pin "a sibling is
judged by its LIVE attempt start...". Failing lines: F-1 and late-S
`expected {...13} to match object { state: 'redriven' }` (S had adopted O's
message); the edge test adopted the +1 ms candidate; the span test
`offset -150000: expected {...} to match object { state: 'done', ... }`.

**FW1-3 (F-2).** `matches` (sendReconcile.ts:552) and `sameFingerprint` (:562)
are media count equal AND body hash equal. Tests: "F-2: two short-named
members' media-only legs to one recipient never adopt each other"; "F-2
mirror: an open short-bodied sibling with ANOTHER short body does not withhold
never_sent; one with the same body does"; the STOP guard "the STOP auto-reply
still never matches: an emoji-only text..." (a guard, green before and after);
the Smart-Encoded body test 6 stays green. Failing line: `expected {...13} to
match object { state: 'done', ...(unresolved) }` (Al adopted Jo's photo);
mirror `...to match object { state: 'redriven' }`.

**FW1-4 (ADV-2).** `closeUnresolved` (:971) and `closeRedriveRefused` (:1108)
close the RECORD first and write the slot only when that close returned true
(a lost close logs INFO and writes nothing); `slotCloseOf` (:890): unresolved
-> send_unconfirmed / unconfirmed; redrive_refused -> redrive_refused / failed;
enqueue_failed -> enqueue_failed / failed; the superseded-exit re-apply at
:416, then afterClose. Tests: "ADV-2 (zz-adv-3): a duplicate delivery of the
last check that closes unresolved while the re-drive is mid-send writes
NOTHING..." (through the real broadcast pass, with a stalled list and a
stalled provider call); "ADV-2 relay twin" (a stale roster read refuses after
the twin re-drove the leg); 14d and 14e updated to the record-first order; "an
enqueue_failed close that dies at its slot write is COMPLETED by the
redelivery..."; mutant pin "a record a PASS closed (refused, from redriven) is
not the job's close...". Failing lines: zz-adv-3 `expected { status: 'failed',
errorCode: 'send_unconfirmed' } to deeply equal { status: 'queued' }` (the bug
reproduced); relay twin slot failed/redrive_refused; 14d and 14e `expected
{...11} to match object { state: 'done', ... }`; enqueue_failed `expected {
status: 'queued' } to deeply equal { status: 'failed', ... }`.

**FW1-5 (ADV-3).** `transition()` (:453) writes a fresh `last_op` (`#op =
:op`, aliases listed per statement) and on ConditionalCheckFailed makes a
consistent projected Get and returns `last_op === op` (:480). `finalizeStatus`
writes `finalize_op` (broadcastsRepo.ts:943) and treats a read-back carrying its
own token as won (:974); the typed optional field is at :212. Fakes:
`world.sendAttemptOps` (harness :328, via `writeAttempt` :4355); the broadcasts
fake stores `finalize_op` on a winning flip (:3242). Tests: "a transition whose
write committed on an earlier SDK attempt reports success when the replay
fails its own condition - every fenced transition" (zz-adv-5's method: a
document client that commits and then throws CCF; all 7 transitions, and a
genuinely lost fence still reports false); "every fenced transition writes a
FRESH op token..."; broadcastsRepo "finalizeStatus is safe against the SDK's
replay..." (won:true for the retried winner, won:false for a second
finalizer); parity holds the fake to WHEN a token is written (the random token
is reduced to presence in the broadcasts parity). Failing lines:
`AssertionError: expected false to be true`; `expected 'undefined' to be
'string'`; `expected { won: false, ... } to match object { won: true, ... }`.

**FW1-6 (ADV-4).** The page walk at sendReconcile.ts:830 (the newest-first
check), :833 (the early stop) and :839 (page_bound only at the last check,
otherwise continue with reason `page_bound`). Tests: "ADV-4 (zz-adv-4): heavy
OLD history does not bury an orphan on page 1..." (page size 2, 12 old
messages); "equal creation instants ... a page of ties behind the window ends
the walk"; "the early stop wins over the bound..."; "a list whose order is NOT
monotonic walks on as today - within a page, and across pages..."; "a page that
ends EXACTLY at the window start does not stop the walk"; test 10's bound half
updated (checks 0 and 1 continue; check 2 closes page_bound). Failing lines:
`expected "listMessages" to be called 1 times, but got 5 times`; test 10
`expected {...13} to match object { state: 'reconciling', checkNo: 1 }`.

**FW1-7 (C-5).** sendOutcome.ts:59 `RATE_LIMIT_CODE`, the rule at :106 (after
the 5xx rule). Test "a code 20429 is retryable whatever the status says or
omits - after the 5xx rule". Failing line: `expected { kind: 'unknown', code:
'20429' } to deeply equal { kind: 'retryable', code: '20429' }`.

**FW1-8 (C-7).** sendReconcile.integration.test.ts, one DynamoDB Local case:
"C-7: a receipt for an ADOPTED orphan routes through the status webhook onto
the adopted slot - a relay leg and a broadcast recipient" (a harness app over
the real messages, broadcasts, contacts and conversations repos; a signed
/webhooks/twilio/status; a pre-adoption receipt must be dropped; lookup-path
adoption, then a delivered receipt moves the relay slot, and the broadcast slot
plus its stats). Coverage-only: it cannot fail on correct code; its teeth are
the pre-adoption drop assertions.

**FW1-9 (C-8).** `currentPhone` (sendReconcile.ts:522): a phone#-keyed
broadcast key returns its own number. Test "C-8: a phone#-keyed recipient is
looked up by its key's OWN number - no byPhone GSI read decides it". Failing
line: `expected "findByPhone" to not be called at all, but actually been called
1 times`.

**FW1-10 (ADV-9 part).** `ownerRefLog` (:363), used by the "owner recipient not
found" INFO (:393); the sendFingerprint.ts digest comment corrected (salted not
keyed; the owner maps keep the raw key; brute-forceable) and the `short` field
comment fixed (an FW1-3 consequence). Test "ADV-9: the "owner recipient not
found" INFO names the owner kind and its ids - never the recipient hash".
Failing line: `expected [ { kind: 'broadcast', ...(2) }, ...] to deeply equal [
{ kind: 'broadcast', ...(1) }, ...]`.

## Deviations from the adjudicated text, with reasons

1. `rearm` reads before it writes: the signature has no facts and the index
   item needs them (sender, digest, body hash, media), so it does a consistent
   Get first; the conditional write still decides; an absent record returns
   undefined without writing.
2. A `rearm` "belt": on an index-0 condition failure, if a consistent re-read
   shows the record attempting with ref.attemptNo and attemptedAt === nowIso,
   rearm returns the re-armed ref (a replay of a committed re-arm, which only
   this call can produce). The SDK's auto-filled ClientRequestToken should
   already make such a replay succeed; this can only turn a spurious "taken
   over" into a correct "re-armed". rearm writes no op token.
3. FW1-4 log order: the verdict's ERROR (WARN for redrive_refused) is logged
   after the record close wins and BEFORE the slot write, so a death at the slot
   write has still logged it once; the redelivery completes the slot silently;
   enqueueOrClose's redriven branch uses the same order. The `recordClosed:
   false` field is gone (a lost close now logs INFO, never the ERROR), so S3a
   residue 9 (duplicate ERRORs) shrinks.
4. The FW1-6 early stop is conservative: it fires only while EVERY page so far
   has been newest-first (one unordered page disables it for the rest of the
   walk); the stop is strict (<), so a page ending exactly at the window start
   walks on; the new continue reason is `page_bound`.
5. FW1-5 fakes: the send-attempt fake keeps tokens in a side map
   (`world.sendAttemptOps`), not in the record, so `world.sendAttempts` still
   holds exactly what get() returns. BroadcastItem gains a typed optional
   `finalize_op`; the routes whitelist fields and SSE derives stats, so it never
   leaks.
6. Existing tests deliberately updated: 6b retitled (no assertion change; no
   existing test pinned the old short rule); 14d, 14e and test 10's bound half
   updated to the new rules; S1b's 101-claim case isolated (see Gates).

## Mutants

63 one-line mutants, each written from a pristine scratch copy, restored by
writing back the original bytes, and verified with `cmp`; all 63 KILLED (W07
survived at first and is killed by the new pin). No [dynamoAdmin] line in any
run.

| id | mutant | killed by |
|---|---|---|
| R01-R03 | each rearm clause made vacuous | "rearm refuses a ref..." |
| R04 | index Put at the old time | "rearm re-arms THIS attempt..." |
| R05 | expiry not moved | same |
| R06-R08 | belt at any instant / removed / any attemptNo | the stub belt case |
| R09 | any cancellation read as a takeover | the stub attribution case |
| R10 | absent record returns success | the absent-record cases |
| T01 | token always mine | "finishAttempt is fenced..." |
| T02 | token never mine | the replay test |
| T03 | constant token | "finishAttempt is fenced..." |
| T04 | token under another attribute | the replay test |
| B01 | finalize token never mine | the finalize replay test |
| B02-B03 | always mine / constant | "finalizeStatus wins once..." |
| F01-F06, F09 | fake rearm state / attemptNo / attemptedAt checks, index write, index time, clock move, token write | parity re-arm script |
| F07-F08 | fake transition token dropped / claim writes a token | parity "fresh claim..." |
| F10 | fake finalize without token | broadcasts parity finalize case |
| O01-O02 | TRAIL / SPAN wrong | window-edge constant pins |
| O03 | 20429 rule removed | 20429 test |
| O04 | 20429 rule before 5xx | 20429 test |
| W01 | no upper bound | F-1 |
| W02 | upper bound strict | window-edge test |
| W03 | lower bound strict | the exact-window-start test |
| W04 | siblings from the window start | span test |
| W05 | no sibling upper bound | F-1 |
| W06 | sibling upper bound strict | span test |
| W07 | no live-start lower filter | the LIVE-start pin |
| M01 | old short rule | F-2 |
| M02 | no media check | 6b |
| M03 | mirror, old short rule | F-2 mirror |
| M04 | mirror, no media check | 8d |
| C01, C03 | slot first / ERROR after the slot | 14d |
| C02 | slot on a lost close | zz-adv-3 |
| C04 | refused slot on a lost close | relay twin |
| C05 | refused slot first | 14e |
| S01-S02 | no re-apply / wrong bucket | 14d |
| S03 | no redrive_refused re-apply | 14e |
| S04, S06 | no enqueue_failed re-apply / ERROR after the slot | the enqueue_failed test |
| S05 | re-apply for any outcome | the refused pin |
| P01 | no early stop | zz-adv-4 |
| P02-P03 | within-page / cross-page order ignored | non-monotonic test |
| P04 | ties not newest-first | ties test |
| P05 | edge stop inclusive | exact-edge test |
| P06-P07 | page_bound always closes / never closes | test 10 |
| P08 | bound checked before the early stop | early-stop-wins test |
| K01 | phone key read through the contact | C-8 test |
| L01 | INFO logs the payload owner | ADV-9 test |

## Gates

- Fast set (10 files): EXIT=0, 592 passed, 75 s, 0 [dynamoAdmin] (before the
  two test-only commits 988a4e44 and 518053ee; the second app-workspace run
  below covers them).
- typecheck (final tree): EXIT=0, 0 "error TS".
- smoke: EXIT=0, "1477 import specifier(s) across 258 emitted file(s)".
- eslint on all 14 touched .ts files: EXIT=0, nothing reported.
- App workspace, first run: EXIT=1, 3 failed, all in
  sendAttemptsRepo.integration: S1b's 101-claim case timed out at 60 s under
  machine load, and its orphaned loop wrote 16 claims into the next case's
  index partition through the shared `let facts`. Per AGENTS.md the file was
  re-run alone twice: EXIT=0 both times, 41/41. The isolation was fixed in
  518053ee (the case binds its own facts; 120 s headroom); proven: with its
  timeout forced to 1.5 s it alone fails and the other 40 pass.
- App workspace, second run: EXIT=0 - 383 files, 7622 passed, 1 skipped
  (staticSmoke, environmental), 266.95 s, 0 [dynamoAdmin].

## Contract for FW2

`SendAttemptsRepo.rearm(owner, ref, nowIso): Promise<AttemptRef | undefined>`
- Real repo: a consistent Get (an absent record returns undefined and writes
  nothing), then ONE TransactWrite: Update `SET attempted_at = :now, expires_at
  = :exp` only if `attempt_state = attempting AND attempt_no = ref.attemptNo AND
  attempted_at = ref.attemptedAt`; Put a NEW index item for nowIso (the claim's
  shape, under the record's own sender and digest). Success returns `{
  attemptNo: ref.attemptNo, attemptedAt: nowIso }`; an index-0
  ConditionalCheckFailed returns undefined (except the belt, deviation 2);
  anything else is rethrown (TransactionConflict, throttle, the index item's
  condition, validation).
- Fake: the same condition, applied synchronously; it sets attemptedAt = nowIso
  and adds the index entry (replacing a same-key one); it never retries and
  writes no op token.
- A site must call it as the LAST step before the provider call; on success use
  the RETURNED ref for every later fenced write (finishAttempt,
  handToReconcile) and the reconcile payload's attemptedAt; on undefined NOT
  call the provider; a throw is the post-claim prepare failure.
- Timing: rearm checks no TTL (a stalled pass that was NOT taken over re-arms
  and may send, which is correct - nobody else owns the attempt); the claim
  TTL, takeovers and the reconcile window are all measured from the last
  re-arm; any await between the re-arm and the provider call eats into
  RECONCILE_WINDOW_TRAIL_MS.

Constants (sendOutcome.ts): `RECONCILE_WINDOW_TRAIL_MS` = SEND_CLAIM_TTL_MS +
RECONCILE_WINDOW_LEAD_MS = 90000; `RECONCILE_SIBLING_SPAN_MS` = 2 * LEAD + TTL
= 150000; the window is [attemptedAt - LEAD, attemptedAt + TRAIL], both edges
inclusive.

Classifier: a code 20429 is retryable whatever the status, after the 5xx rule
(5xx + 20429 stays unknown; 400 + 20429 is now retryable - it was rejected).

Op token: method signatures unchanged; every fenced transition also returns
true when its write committed on an earlier SDK attempt (false still means the
condition failed); finalizeStatus returns won:true to such a retried winner.
Fakes: `world.sendAttemptOps` holds the tokens; a fake-finalized broadcast
item now carries `finalize_op`, so a new test that deep-equals a whole
finalized item from the fake will see it.

Reconcile: a redelivery that finds the record done for its own attemptedAt
with outcome unresolved, redrive_refused or enqueue_failed re-applies the
matching idempotent slot close (including a site's closeRedriven with those
outcomes on a redriven record); the not-found INFO and the unresolved and
redrive_refused lines no longer carry `recordClosed`.

Watch item: relayFanOut.ts:1384 (FW2's file) has a comment "cannot outlast the
claim TTL, so a still-fresh record is deferred" - re-check it against the
re-arm premise.

## New residues (for FW3 or the handback)

1. C-8 remainder: two contact reads still go through the byPhone GSI for a
   phone# broadcast key - heldBy's contact read (sendReconcile contactOf ->
   resolveContact; runs only when a candidate SID has a sid# row) and the
   adoption's contact read (broadcastFanOut.ts:1289, FW2's file). Both err
   toward other_owner, unresolved or a retry.
2. rearm cost: each send gains 1 consistent Get and 1 TransactWrite, plus 1
   Get on a lost condition.
3. Op-token re-read window: a write that committed and was then overwritten
   by another writer's transition before the re-read reports false (the
   narrow ADV-3-note class).
4. Window TRAIL assumption: TRAIL assumes Twilio creates the message within
   90 s of the re-arm; the Twilio timeout is an idle-socket timeout (ADV-1), so
   a request that trickles past TRAIL would put its orphan outside the window -
   a never_sent verdict and a re-send (extreme, but a double-send path).
5. The early stop depends on list order: it relies on the provider returning
   newest-first, unverified against real Twilio (Sec 10); an unordered list
   keeps the old cost.
6. Replay safety unproven locally: DynamoDB Local cannot show
   ClientRequestToken replay behavior; the belt covers the re-arm either way.

## Concerns

1. Machine load: other worktrees loaded the machine throughout (a
   voicemail-greeting e2e, a staff-notes-past-tours vitest run, and an
   unrelated `npm test --workspaces`, PID 67300); that load produced the first
   app-run failure; the orchestrator's gates may meet the same load.
2. Mutant-pass incident: the shell timeout killed the mutant runner
   mid-mutant (~12:24), leaving mutant T02 (`return Item === null;`) applied to
   sendAttemptsRepo.ts; detected at once by `cmp`, restored from the pristine
   copy (cmp OK), and `git diff --quiet HEAD -- app/src app/test/helpers`
   verified before anything else ran; no commit ever contained a mutant (all
   source commits predate it); the runner now restores on SIGTERM and runs in
   smaller chunks; no process of the implementer's is left running.
3. Scratch: scripts, logs and pristine copies only under the session
   scratchpad `FW1\`.

## Orchestrator checkpoint

Verified at 518053ee: only the 14 in-scope files changed (no FW2-owned, fenced
or dashboard file); 0 non-ASCII bytes in the added lines; `npm run typecheck`
EXIT=0 with 0 `error TS`; the five core files (sendAttemptsRepo.integration,
the send-attempts parity, sendReconcile, sendReconcile.integration,
sendOutcome) re-run EXIT=0 (182 passed). The human ruling on ADV-1 (section 6
of `r1-adjudications.md`) arrived during FW1: the repo half stays; FW2's site
half is kept minimal under the STOP-and-file rule. Residue 4 (a request that
trickles past TRAIL) is recorded for FW3 as part of the ADV-1 residue note.
