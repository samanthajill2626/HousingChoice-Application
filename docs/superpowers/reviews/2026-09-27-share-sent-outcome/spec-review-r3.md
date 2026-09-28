# Spec review R3 (reviewer B) - share-sent-outcome design v3

Date: 2026-09-27. Spec under review:
`docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md`, DESIGN v3
at 1951d190 (read in full; the v2 -> v3 diff read with
`git diff 82bdd304 1951d190`). Adjudications read:
`spec-review-r2-adjudications.md`. Code: worktree `W:\tmp\share-sent-outcome`
at main @d9cb5c04 (read-only; nothing run). Every file:line below was read by
this reviewer.

**The other side of the interface has moved.** The brief cites Stage 1b as
"committed r2 @08a41dc7 and the r3 draft". Branch `feat/retry-send-adoption`
has since committed revisions 3, 4 and 5; its HEAD is dad3fecb, "revision 5
... (final; ...) - review loop closed at 46/46/0" (commit message), and its
worktree `W:\tmp\retry-send-adoption` is clean. Revision 5 is what will be
built, so every 1b citation below is **1b r5 (dad3fecb)**, file
`docs/superpowers/specs/2026-09-27-retry-send-adoption-design.md` on that
branch. Where r5 changes a premise v3 relies on, the finding says so.

v3 line numbers: section 0 = 21-77, D1 = 145-199, D2 = 201-249, D3 =
251-269, D4 = 271-315, D5 = 317-327, D6 = 329-345, D7 = 347-420, D8 =
422-460, invariants = 471-506, surfaces = 508-538, testing = 558-606, risks
= 608-654, gate = 656-679.

## Summary

1. [MEDIUM] At the two job-side unresolved-end sites there is no re-apply to ride: 1b r5 closes the record FIRST and a redelivered `retrySend` returns at INFO on a `done/unresolved` record, so a crash there loses 1b's WITHDRAW, its `retry_outcome` and this branch's slot write together - D8 heals only from `retry_outcome`, so the only trace left is the 30-day attempt record v3 never reads
2. [MEDIUM] D1's time bound is three minutes short: measured from the newest attempt's own timestamp, a promise can be live for 23 minutes (window 15 + 1b's unknown-outcome refresh 4 + 2 + grace 2), not "about twenty" - past 20 minutes v3 judges the slot alone as a final failure while the retry is still under reconcile
3. [MEDIUM] The list's merge rule leaves a finished share reading "Sending" after its last pending recipient's chain ends in a failure receipt (exhaustion, or a retry's 30007): that arm omits the count and `failed` does not shrink, so the clamp keeps the stale count - the ordinary end of a failed one-to-one share, not the lapse edge D4 names; D4's "right whenever its count is at least one" is false
4. [MEDIUM] "In flight whatever the stored status" flags every recipient of a GENUINELY failed route send forever - not "the price Branch A already pays" (Branch A excludes failed shares) and outside the sweeper's `sending`-only nomination - so the share staff create to recover starts that whole audience unchecked while the failed share reads "Not sent"; section 7's "keep the queued-counts case" is wrong for the route's DRAFT/FAILED pins
5. [LOW] D7 has no counterpart to D2's delivered-at-any-age clause: an older attempt's delivery applies to the slot but is refused by the ledger (neither newer nor the same attempt), so the slot reads Delivered while the entry stays `failed`; which pointer the slot keeps is also unstated
6. [LOW] D6 judges a `pending` entry by a due instant COPIED into the ledger at write time, which 1b's refreshes (deferral, unknown, re-drive) never update, so the timeline reads "Property text failed" for minutes while the retry is still pending - the drift I5's "one source" rules out
7. [LOW] 1b r5 (final) copies `broadcast_id` one hop and walks `retry_root` at most three hops; v3's requirement 1 asks for both walked "bounded by the chain", but its relay (section 9) and drift task (section 8) name only a one-hop `retry_root` - and the unit-less shares D8 never walks keep an unattributed pre-1b chain for good
8. [LOW] "The slot is authoritative past the bound" also fails when a retry's receipt rollup is lost (the webhook catches the throw and answers 200; D2 gives up after its bound): the slot reads a final failure for a delivered retry until someone re-runs D8, and section 8 names only the late-receipt case

Adjudication contest (item 1's fix): **conceded.** The durable-row design I
proposed would not have healed finding 1 either - the crash that loses the
slot write at a job-side site loses 1b's WITHDRAW, and with it the row's
`retry_outcome`, in the same window - so it buys nothing that v3's bounded
reads miss, at the unbounded cost round 2's F5 described.

---

## 1. [MEDIUM] No re-apply at the two job-side unresolved-end sites; D8 cannot heal them

**What is wrong.** v3 calls this branch's slot writer at four unresolved-end
sites and makes the pair durable by "riding whatever re-apply 1b gives its own
WITHDRAW at each site so the two writes share one durability story" (section 0,
72-76). It names the residual as "a crash between 1b's close and this branch's
slot write, with no re-apply", healed by D8 (D1 196-197; section 8 637-642),
and D8 heals it only from the ROW: "failed-30003 slots whose newest attempt's
row says its chain ended unresolved" (D8 step 3, 443-446). Section 9 tells 1b a
re-apply hook "is welcome but not required" (678-679).

1b r5 gives a re-apply at the reconcile only:

- The reconcile has no run-once marker, so a crashed check is redelivered and
  its superseded exit re-applies `slotCloseOf` (`app/src/jobs/sendReconcile.ts:10-17`,
  `:405-419`); for the retry owner r5 maps `unresolved` to its WITHDRAW
  annotate (1b r5 R4 crash safety, 395-404). Sites (a) and (b) are covered.
- The job's two arms close the RECORD first and WITHDRAW second:
  "`finishAttempt(unresolved, second_unknown)`, then WITHDRAW" and
  "`closeFromReconcile(unresolved, enqueue_failed)` then WITHDRAW" (1b r5 R3
  unknown row, 296). A redelivered job that finds its record `done` with outcome
  `unresolved` logs INFO and returns (1b r5 R2 step 4, 210-212). Nothing
  re-applies either write. And every post-claim write goes through
  `guardWrite` - "nothing throws after the claim" (262-264) - so a thrown
  WITHDRAW is logged and dropped, with no redelivery at all.

**What it implies.** A process death between the job's record close and its
WITHDRAW (or two failed guarded writes in the same arm) leaves the row WITHOUT
`retry_outcome` and the slot at `failed/30003`. Neither D1's row read nor D8
step 3 can see it; the only trace is the attempt record, which expires 30 days
after its claim (`app/src/repos/sendAttemptsRepo.ts:47-48`) and which v3 never
reads. The tenant, whose re-driven retry may have arrived, is un-flagged for
good, and the results row shows a final failure plus the hint while the route
answers 409 `retry_unresolved` from that record (1b r5 R6, 449-452). The
double fault is rare (a crash in a short window, or two independent write
failures), but v3's healing claim is false at these two sites. Two small fixes
stay inside v3's own fence: write THIS branch's slot FIRST at the job-side
arms - `unconfirmed` is the safe state, and D2's order lets any later real
outcome (an adoption, a re-drive's row) supersede it - or have D8 read the
`retry_send` records while they live. A re-apply in the job's step-4 return
would be a fifth call site, which I7 (495-500) does not allow. Section 9's
relay should stop calling the re-apply optional.

## 2. [MEDIUM] D1's time bound is three minutes short

**What is wrong.** D1 reads the newest attempt's row only while it is
"younger than the retry window plus its longest refresh and grace (about
twenty minutes, read from the message id's own provider timestamp)" (190-193),
and treats an older slot as authoritative.

**Evidence - the shape that outlives it.**
- The window is 15 minutes; a retry is scheduled only if
  `now + backoff + 60 s <= origin + 15 min` and the job's own check is strict
  at `origin + 15 min` (`app/src/lib/retrySendWindow.ts:15`, `:22`, `:72-84`).
  Attempt 1's backoff is 60 s (`app/src/jobs/retrySend.ts:53-56`).
- So a root whose 30003 lands at ~13 minutes gets retry 1 due at ~14
  minutes; the job may run inside its 60 s grace, up to 15 minutes.
- If that send's outcome is unknown, 1b r5 REFRESHES the root's promise to
  `attemptedAt + reconcileCheckDelaysMs()[2] + RETRY_PROMISE_GRACE_MS`
  (1b r5 R3 unknown row, 296) = `attemptedAt + 240 s + 120 s`
  (`app/src/lib/sendOutcome.ts:30`; `retrySendWindow.ts:29`); a takeover uses
  the taken-over attempt's clock the same way (1b r5 300-301).
- A promise is live until due + 120 s (`retrySendWindow.ts:93-97`).
- Total from the root's own timestamp: 15 + 6 + 2 = **23 minutes**, plus the
  skew between Twilio's second-granular `dateCreated` (the tsMsgId prefix) and
  the server clock. The root is the worst case: every later attempt's promise
  ends by the same instant but starts later.

**What it implies.** From 20 to 23 minutes after a late-window root, a retry
under reconcile reads as a final failure: the composer un-flags a tenant whose
retry may be out, and the results row shows the hint while the thread hides
Retry and the route answers 409 `retry_pending` - I5 broken for exactly the
case 1b's refresh exists to protect. State the bound as the constants' sum
(`RETRY_SEND_WINDOW_MS + reconcileCheckDelaysMs()[2] + 2 x RETRY_PROMISE_GRACE_MS`)
plus a skew margin, not a rounded figure.

## 3. [MEDIUM] The list reads "Sending" after a failed chain ends

**What is wrong.** D4's merge rule (294-305): the rollup that writes a 30003
failure with a live promise emits the count; every other emitter OMITS it; a
page merging an omitted count "keeps the row's last known value, clamped to the
payload's `failed`". D4 then asserts the list "is right whenever its count is at
least one and right again when `failed` empties", accepting staleness only for
"a lapsed promise, or a second pending recipient" (310-315).

**Evidence.** The chain's END is a rollup arm too: attempt 3's 30003 with the
cap exhausted, or a retry that fails 30007, writes a failure with NO live
promise, so its emit omits the count. That failure replaces a failure: the
slot stays in `failed` (`deriveBroadcastStats` counts every failed slot except
`send_unconfirmed`, `app/src/repos/broadcastsRepo.ts:302-305`), so `failed` does
not shrink and the clamp keeps the stale count. The list hook replaces or
merges only from events and never refetches
(`dashboard/src/routes/broadcasts/useBroadcastsList.ts:111-124`).

**What it implies.** A one-to-one share - the matching page's common case -
whose retry chain fails reads "Sending" on the list until the page is
reopened, and section 7's e2e (b) ("the share 'Not sent'", 586-589) would fail
if it checks the list. Answering the brief's second question: no emitter has to
learn to OMIT a field - an optional `retry_pending` stays unset whenever no
promise map is supplied - but both hooks must replace today's wholesale stats
replacement (`useBroadcastsList.ts:118`, `useBroadcastResults.ts:128`) with
the merge. The rollup arm that ends a chain knows its recipient stopped being
pending; it must say so (emit the count from the share's young 30003 slots, or
a decrement), or the list must refetch the row.

## 4. [MEDIUM] "In flight whatever the stored status" flags a genuinely failed send forever

**What is wrong.** v3 D1 now reads EVERY `queued` slot as in flight, "whatever
the share's stored status", and prices it as "the price Branch A already pays"
until SOR's sweeper closes the strand (183-188; section 8 643-644). D4 still
labels a route-failed all-queued share "Not sent, danger" (281-282).

**Evidence.**
- Branch A counts only `sent` and `sending` shares
  (`app/src/repos/broadcastsRepo.ts:716`), so it never flags a failed share's
  queued slots. The price is new.
- The route marks a share failed on any enqueue throw
  (`app/src/routes/broadcasts.ts:761-775`). When the enqueue really failed, no
  job runs and nothing is ever claimed or sent.
- The sweeper, as designed, nominates only `sending` shares
  (`docs/issues/send-attempt-sweeper.md:398-405`), so it never reaches a
  `failed` one - and it states the rule that separates the two cases: "No
  record: the recipient was never claimed and so never sent" (`:406-409`).
- A flagged, unseeded row starts unchecked and "Select all" skips it
  (`dashboard/src/routes/broadcasts/RecipientPreview.tsx:91`, `:162-167`).

**What it implies.** After a real route enqueue failure (the draft is no
longer a draft, so staff start a new share of the property), every tenant of
the failed send appears "Already sent" and unchecked - forever - while the
failed share reads "Not sent". The recovery send reaches nobody unless staff
check each row. Read the attempt record (none = never claimed = not texted) for
queued slots of a share that is not `sending`, or bound the in-flight reading
in time. Also: a DRAFT's queued slots (only the performance seed has them,
`app/src/lib/seed/performance.ts:989-993`, `:1020-1026`) would now flag
although a draft sent nothing; and section 7 (597-598) says the
`priorRecipientContactIds` tests "keep the queued-counts case", but under v3 the
repo test's failed-share exclusion (`app/test/broadcastsRepo.integration.test.ts:339-344`)
and the route test "NOT set by a prior DRAFT/FAILED broadcast"
(`app/test/broadcastApi.test.ts:1183-1205`) both flip.

## 5. [LOW] The ledger refuses the older delivery the slot accepts

D2 lets a DELIVERED receipt apply "whatever its attempt's age" (226-232). D7's
entry rule applies a write only when its attempt is NEWER or the SAME attempt
moving forward (395-403), with no delivery exception. So for an older
attempt's delivery the slot reads Delivered while the ledger keeps the newer
attempt's `failed` - the pair leaves "Properties sent" and D6 reads "Property
text failed" for a tenant who received the text, against I2 (477-481). Mirror
the exception in D7 (an older attempt's delivery counts the entry by delivery)
and state which newest-attempt pointer the slot keeps when it applies (keeping
the newer one leaves a Delivered slot pointing at a failed row, which D8 step 3
would report as a disagreement on every run). Note the scope: 1b r5 now answers
a stale-view press on any row that has a child with 409 `superseded`
(1b r5 R6, 435-443), which closes D2's motivating example for post-1b chains;
the clause still matters for 1b's named fork (two children racing, 470-477) and
for pre-1b chains, which carry no `retrychild#` pointers (1b r5 R7, 496-507).

## 6. [LOW] D6's lapse words read a promise copy that 1b refreshes elsewhere

D7 records "the promise's due instant for a `pending` entry" (351-355) and D6
reads "Property sent" while it is live and "Property text failed" once it
lapses (335-337). The due is the one the writer saw (the webhook's scheduled
run time). 1b r5 then REFRESHES the retried row's promise on a deferral, an
unknown outcome and a re-drive (R3 295-296, R4 377-381), and no ledger writer
runs at those sites. So while a retry is deferred, under reconcile or
re-driven, the timeline reads "Property text failed" for minutes, then flips
back to "Property sent" if the retry reaches. I5 (489-492) says the promise has
"one source, the newest attempt's message row"; the ledger's due is a second
one. Read the recorded attempt's row within D1's bound, or accept the
transient words by name.

## 7. [LOW] 1b r5 copies `broadcast_id` one hop; the relay names only the root

v3's requirement 1 has 1b derive BOTH fields "by walking `retry_of` ... bounded
by the chain; never a one-hop copy" (44-49). 1b r5 walks `retry_root` at most
`MAX_SEND_RETRY_ATTEMPTS` hops, a broken link stopping at the last row read
(35-40), and copies `broadcast_id` from the retried row - one hop - at every
append site (62-64; R2 step 7, 241; R4 adopt, 366; R7, 508-513). v3's relay
asks only for the root walk (section 9, 674-676) and its drift task covers only
"a one-hop `retry_root`" (section 8, 651-654). r5 is final and v3 section 6
(542-543) still has 1b "receiving the refined requirements", so the plan's
first task, not 1b, will be where this lands - say so. Until D8 runs, a
post-1b retry of an unstamped pre-1b retry row carries no `broadcast_id` and
routes nowhere; D8 step 2 stamps such rows (437-440), but D8 walks only
unit-targeted shares (431, 456-459), so for a unit-less share the chain stays
unattributed permanently - a consequence the non-goal (139-141) does not state.

## 8. [LOW] The slot is not authoritative when a retry's rollup was lost

D1 treats a slot past its bound as authoritative "every unresolved end has a
slot writer" (193-196), and section 8 bounds the lapse-before-receipt case "by
receipt latency; the next receipt or the chain end corrects it" (633-636). A
LOST retry rollup is not bounded that way: the webhook catches a rollup throw
and still answers 200, so nothing redelivers
(`app/src/routes/webhooks/twilio.ts:3530-3544`), and D2 gives up after its
re-read bound with a WARN (233-237). The retry row exists, the slot never learns
it, and past the bound the recipient reads a final failure although the retry
delivered - only a manual D8 re-run heals it (D8 step 3, 441-443). Name it
beside the original's stuck-`sent` class.

---

## Direct answers to the brief's questions

- **A re-apply to ride at each of the four sites?** Reconcile close and its
  re-apply: yes (the superseded exit on a redelivered check). The job's
  second-unknown and enqueue-failed arms: no (finding 1).
- **The row-less ordering when the record is redriven?** Sound. A re-drive
  runs the same owner (same retried row, same attempt): if its text is
  appended, that row is newer than the row-less marker and supersedes it; if it
  comes back unknown again, the job's second-unknown arm writes the marker
  after the retried row. One wrinkle, rare: in 1b's named fork (an automatic
  and a manual child of one row, 1b r5 470-477), a row-less end of the
  automatic chain sorts before every row of the manual chain, so a later
  failure of the manual chain replaces a recipient whose automatic retry may
  have arrived.
- **Does I7 still fence anything real?** Yes: "1b writes nothing to a share
  slot" holds in r5 (62-67). The semantics clause is real too, and it is what
  forbids the step-4 re-apply that would otherwise be the natural repair for
  finding 1.
- **The delivered-at-any-age clause.** The stats delta is well defined
  (failed, sent or unconfirmed -1, delivered +1). A same-attempt late `sent`
  after `delivered` is refused ("never from delivered"). A second delivery -
  1b's fork, or a pre-1b chain - is refused by the slot and by the ledger's
  terminal rule, so stats count one delivery for the two texts 1b's residual
  sends. The gap is the ledger's missing older-delivery rule (finding 5).
- **The optional count and its merge rule.** No emitter must learn to omit
  anything; the clamp produces a wrong "Sending" (finding 3).
- **D7's forward list and D6's lapse words.** The list is otherwise sound
  (`counted` by acceptance to `counted` by delivery / `pending` / `failed`,
  `pending` to `failed`, a seeded entry before every real attempt); the gaps
  are findings 5 and 6.

## Checked and holding

- D2's lost-condition re-read closes round 2's F2; D1's failed-read-is-pending
  rule closes F5's catch-all hazard.
- The results route returning `retry_due_at` and `retry_outcome` lets the page
  judge liveness on its own ticker (`dashboard/src/routes/contact/retryPromise.ts:29-34`).
- The adoption hook running on a de-duplicated re-adoption is crash-safe: the
  reconcile adopts before it closes the record (`sendReconcile.ts:426-429`),
  and 1b r5 marks a same-lineage dedupe `skipped` (366-369).
- D7's legacy seeding, create-on-first-write and the removed writer for the
  original's unresolved close are sound.
- The 1000 cap still fits the one-attribute slot; the sparse byContact index
  needs no Terraform change.
