# Code review round 2 - adjudications and the FW4 list

Orchestrator adjudication of `r2-conformance.md` (R2C-1..R2C-7) and
`r2-adversarial.md` (N-1, F-1..F-4, A-1..A-3), over the fix wave FW1 + FW2
(0dd5d4b7..af848977). The gates at a908f9cb (code = af848977) were all green
before these rulings: typecheck 0 (0 `error TS`); smoke 0 (1481 specifiers /
259 files); lint gate 5 with 0 new errors; `npm test` 0 (app 383 files 7666
passed / 1 skipped; dashboard 204/3403; e2e-unit 21/499; fake-twilio 34/268;
fake-twilio/web 13/111; 0 `[dynamoAdmin]`); `npm run e2e` 0 (289 passed,
20.1m).

The human's standing ruling on this branch applies to every item below: a
double text is annoying, NOT critical - he would rather risk one than take on
new failure points or a lot of redo (`r1-adjudications.md` section 6).

Load-bearing claims re-checked in the source before ruling: the early stop
breaks the walk at any check and never_sent follows an empty candidate set
(sendReconcile.ts:833, :866-874); the page-bound return comes BEFORE the
candidates are judged (:838-840); the broadcast ladder waits 10 s then 20 s
with 3 passes (broadcastFanOut.ts:136-150) against the 30 s claim TTL; the
onRejected docblock (:662-668) promises a takeover at the cap; the known-arm
WARN "recipient failed, NOT retried" is logged before the `slotWritten` check
(:726-733); the rung's stranded message names only the hand-off
(relayRetryLeg.ts:932-946); the dashboard comment at deliveryStatus.ts:625-628
predates FW2-9; `r1-adjudications.md:54-55` and `:271-272` say the re-arm
leaves no second-send path.

Rulings: FIX (FW4, one implementer, sequential), RESIDUE (filed by FW3,
which now runs after FW4 and carries round 1's residues, FW1's and FW2's new
residues, and these), NOTE (the handback states it).

## 1. FIX - FW4

### FW4-1 (R2C-1 = F-1, and A-2): never_sent needs a complete walk

Both reviewers found it independently and both reproduced the mechanism: with
a list that passes the per-page order check but is sorted on another key (a
still-queued orphan with a null date_sent sorting last), FW1-6's early stop
ends the walk before the orphan, and the last check rules never_sent and
re-drives - a double text, and a regression against 83308e15 for a 2-5 page
list. It is our own fix wave's defect, the fix removes a double-text path
without adding a failure point, and it costs at most four more list calls on
the rare last check - within the ruling. Graded LOW-MEDIUM (it needs a
recipient with more than 1000 messages from one sender AND an unverified list
order); fixed regardless.

Binding semantics for `lookup()` (sendReconcile.ts):

- (a) The early stop applies only to checks BEFORE the last (a miss there
  only defers to the next check). At the LAST check the walk goes on until the
  list ends or the page bound.
- (b) A walk cut at the page bound (a page still pending after
  RECONCILE_MAX_PAGES pages) no longer returns before judging: at EVERY check
  it judges the candidates it saw and may adopt one (an adoptable candidate is
  real whatever lies on the unread pages). When nothing is adopted it returns
  exactly as today: before the last check `continue` / `page_bound`; at the
  last check `unresolved` / `page_bound`.
- (c) never_sent requires a COMPLETE walk - the list's end reached on the last
  check. A cut walk never rules never_sent.
- (d) At the last check with nothing adopted, the causes keep today's
  precedence for a cut walk: `page_bound` first; then, for a complete walk,
  `unidentified_candidate`, then `same_fingerprint_sibling`, then never_sent.
- The comment above the walk says what the stop may and may not prove.

Tests: the reviewers' scenario (page 1 newest-first and wholly older than the
window, the orphan on page 2): checks 0-1 stop early and continue, the last
check reads page 2 and adopts - found, no re-drive; the orphan beyond the bound
at the last check - unresolved page_bound, no re-drive; a cut walk (a list
longer than the bound) whose orphan is on page 1 - adopted; a complete walk
still reaches never_sent. Each new test fails on af848977 (quote the failing
line). Every FW1-6 pin that encoded the last-check early stop is restated with
its old and new expectation and the reason.

### FW4-2 (F-2, F-4, and R2C's log wording): comments and log text only

No behavior change. Before changing any log message, grep `infra/`, `e2e/`,
`scripts/`, `app/` and `dashboard/` for the exact old text; update a test pin
in the same commit; if infrastructure matches the text (a metric filter, an
alarm), leave it and report.

- broadcastFanOut.ts:662-668 (the onRejected docblock) and any twin of that
  promise (grep "taken over into reconcile", "stale at the cap"): only a
  pass-1 strand is old enough to be taken over at the cap; a strand in pass 2
  or 3, or in any re-drive pass, stays `attempting` and the share stays
  Sending until the sweeper (`send-attempt-sweeper`).
- broadcastFanOut.ts:726-729: the known-arm WARN "recipient failed, NOT
  retried" must not be logged when the slot write threw; that path logs that
  the rejection's slot write failed and the recipient is carried with the
  attempt still open.
- relayRetryLeg.ts:932-946: the `stranded` comment and ERROR cover both
  causes FW2-2 now routes there (the hand-off write failed, or a terminal
  close's slot write threw).
- deliveryStatus.ts:625-628: the comment says the reason also carries the
  send_unconfirmed sentence after the failed legs' reasons (FW2-9).

## 2. RESIDUE - filed by FW3 (docs/issues only)

- N-1, R2C-3, A-3, F-2 (second half) - LOW, a double fault: a broadcast
  failure arm whose slot write throws (FW2-2's onRejected, refusal and
  second-unknown arms) or a hand-off whose write throws (pre-existing), in
  pass 2 or 3 or in any re-drive pass, leaves the record `attempting` while
  still fresh at the cap; the cap close defers it, finalize waits on the
  queued slot, and the share stays Sending until the Stage 2 sweeper. Relay
  concedes the same at relayFanOut.ts:1400-1408. A-3 answered: FW2-2 is KEPT -
  a record left `attempting` conforms to D7a and stays recoverable by the
  sweeper, where a terminal record beside a stuck slot would not; the carry
  rescues only a pass-1 strand; the claim that the ladder clears it is
  withdrawn (FW4-2 corrects the docblock; the filing states it plainly). The
  reviewer's fix directions (hand the attempt to reconcile directly; let the
  cap close take over records this same pass abandoned) are new machinery on a
  double-fault path - declined under the ruling, recorded in the issue.
- A-1 - LOW, CONFIRMED in the harness with the stall simulated: the re-arm
  NARROWS the ADV-1 window but does not close it. Its own two DynamoDB calls
  (the consistent Get and the TransactWrite, sendAttemptsRepo.ts:379-420) run
  on a client with no request timeout (lib/dynamo.ts), and the sites stamp the
  re-arm before the call; a stall of about 90 s or more inside the re-arm (a
  Get stall that commits a stale stamp, or a response stall after the commit),
  together with a concurrent taker (an SQS redelivery), can still send twice.
  Before the re-arm, a stall of that length anywhere in the prepare phase was
  enough. Designed fixes for a future decision: a client request timeout; or
  stamp inside the re-arm after its Get and re-check the elapsed time after
  the TransactWrite, failing closed. Held by the ruling (no client timeout
  change, no new machinery).
- R2C-6 - LOW: a re-arm that commits and then throws takes the prepare
  deferral on the pre-re-arm ref; the release fences out, the record stays
  `attempting` on the re-armed clock and the slot queued / send_retryable -
  the sweeper's; nothing is sent. File with A-1.
- R2C-7 - NOTE: the automated-send breaker counts before the re-arm hook
  (sendMessage.ts:549-573 before :615), so a lost or thrown re-arm spends a
  count for a text never sent (bounded). File with A-1.
- F-3 - LOW: FW2-6 holds the record `attempting` through the A2P token wait
  (broadcastFanOut.ts:790, :916-917); the bucket is shared first-come by every
  SMS job, so FW2 residue 6's "well under 30 s" is not guaranteed under load. A
  takeover of an already-sent recipient is harmless (the adoption finds the
  slot moved; finishAttempt logs a lost fence), but it widens A-1's takeover
  window. The filing corrects residue 6's wording.
- R2C-5 - LOW: the broadcast known arms (30007/30005/30006) write the slot and
  the stats in ONE guardWrite (broadcastFanOut.ts:680-687), so a stats-only
  failure carries the recipient and keeps the record `attempting` beside a
  terminal slot - a false open record; the sweeper must read the slot before
  any re-drive (`send-attempt-sweeper`).
- The rung's stranded arms emit no root close (relayRetryLeg.ts:932-946) - a
  double-fault path; the record stays `attempting` for the sweeper. File with
  the emit-nothing class.

## 3. NOTES - the handback states them

- R2C-2 - a spec-level unknown for the hosted-dev checks (spec Sec 10): does
  the Messages list show a queued / accepted message at all, and where do rows
  with a null date_sent sort? The spike's B1 step saw a just-created message
  absent from the list and present 2 s later; if unsent messages are unlisted,
  a message held in Twilio's queue past +240 s is ruled never_sent and
  re-driven (a double text) whatever FW4-1 does.
- R2C-4 - spec-text deviations the fix wave added, declared beside ADV-2 and
  F-2: (a) the re-arm moves the record's attemptedAt after the claim (D8a),
  so the relay slot's D20a clock (the claim instant) and the record's differ;
  (b) the two-sided window replaces D13's "to now" (its cost is FW1 residue 4
  and A-1); (c) FW2-6 runs the best-effort follow-ups before the record's
  done/sent (D7a's RECORD order); (d) on relay a stranded rejection or refusal
  counts toward the D9 brake, although D9 says a rejection resets it (FW2
  deviation 5).

## 4. Corrections to round 1's adjudications

- A-1: the claim at `r1-adjudications.md:54-55` and `:271-272` that with the
  re-arm the missing DynamoDB request timeout "can no longer produce a second
  send" is WITHDRAWN - see section 2.
- A-2: the ADV-4 ruling's "an unordered list walks on exactly as today" did not
  cover a list that passes the order check while sorted on another key; FW4-1
  closes it.
- The conformance reviewer AGREED with the reading of the human ruling
  (section 6 of round 1): a lost re-arm returns skipped_terminal / 'takeover',
  the loop and the rung ignore it, the broadcast writes and carries nothing,
  and every way the re-arm's condition can fail leaves a taker that already
  handed off or closed.

## 5. Per-fix verdicts (both reviewers)

REAL: FW1-1, FW1-2, FW1-3, FW1-4, FW1-5, FW1-7, FW1-9, FW1-10, FW2-1 (for a
stall before the re-arm - A-1), FW2-3, FW2-4, FW2-5, FW2-7, FW2-8, FW2-9;
coverage-only: FW1-8, FW2-10. PARTIAL: FW1-6 (-> FW4-1); FW2-2 (the docblock
and the stuck-share class -> FW4-2 and the N-1 residue); FW2-6 (the adoption
half, unbuilt and declared).
