# Spec review R2 (reviewer B) - share-sent-outcome design v2

Date: 2026-09-27. Spec under review:
`docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md` (DESIGN v2,
rewritten in place). Adjudications read:
`spec-review-r1-adjudications.md`; reviewer A's round 1: `spec-review-r1-a.md`.
Code: worktree `W:\tmp\share-sent-outcome` at main @d9cb5c04 (read-only;
nothing run). Every file:line below was read by this reviewer.

The other side of this spec's interface is the Stage 1b spec,
`docs/superpowers/specs/2026-09-27-retry-send-adoption-design.md` on
`feat/retry-send-adoption`. Committed revision 2 is @08a41dc7 (read with
`git show`); an UNCOMMITTED revision-3 draft sits in the worktree
`W:\tmp\retry-send-adoption` (read as a file). "1b r2" cites the committed
text; "1b r3 draft" cites the in-flux draft and is marked where the two
differ. Every finding that cites 1b also stands on main-side evidence.

v2 line numbers: section 0 = 20-57, D1 = 123-164, D2 = 166-199, D3 =
201-216, D4 = 218-245, D5 = 247-257, D6 = 259-273, D7 = 275-336, D8 =
338-372, invariants = 383-413, surfaces = 415-444, testing = 464-504, risks
= 506-542, gate = 544-561.

## Summary

1. [HIGH] Two of 1b's three unresolved-retry closes run inside the retry job, which I7 bars this branch from touching, so a re-driven retry that comes back unknown never reaches the slot; D1's own list then reads its withdrawn promise as "failed", while the durable `retry_outcome` 1b writes on the very row D1/D3 already read is ignored
2. [MEDIUM] D2's new slot primitive has no rule for a lost condition (only the ledger got "re-read and re-apply"), so the drop-the-loser shape survives: a retry's `failed` that loses to its own `sent` leaves the slot "reached" for a failed text
3. [MEDIUM] D2's, I3's and D7's ordering rules are defined only over message ids, but three v2 writes have none - the unresolved retry (caller 3), the legacy-seeded ledger entry and the original's unresolved entry - so the rule as written refuses caller 3's own write
4. [MEDIUM] `retry_pending` is zero in every SSE payload and both share pages replace their stats with the payload, so the list pill reads "Not sent" (danger) from the very failure event that starts a pending retry until reload; D4's "re-judged when it refetches" misdescribes a hook that never refetches
5. [MEDIUM] The promise read has no time bound: every failed-30003 slot of every listed share and of every prior share of a unit pays a message read on every list and preview fetch, forever, one call per recipient; a read failure inside the preview's catch-all empties the whole "Already sent" set
6. [MEDIUM] D6 maps a `pending` entry to "Property sent", but the ledger never leaves `pending` when a chain ends without a retry row (refused, rejected, window closed at job time, deferral cap, enqueue failure, job-side unresolved), so those milestones read "Property sent" forever - the issue D6 closes, reopened for 30003
7. [LOW] D1's "stranded - never texted" is false for the route's ambiguous enqueue failure: the fan-out never reads the stored status, so recipients being texted in that pass are un-flagged and the share reads "Not sent"
8. [LOW] Contest B16 (part): the rejection's premise is false - a stale-tab or API Retry of a superseded failed row is accepted once its promise lapses (RSW gap 2, 1b's stated residual), so an older attempt's delivery can be refused and a delivered share un-counted; I2's parenthetical is false
9. [LOW] The slot learns a retry only at its first receipt, while 1b lets the retried row's promise expire at due + 2 min even after the retry went out: a late job or a late receipt reads a final failure and shows a hint the thread (which shows the retry) does not offer
10. [LOW] D7's writer for the share's own unresolved closes writes an entry nothing reads (no milestone exists for a never-accepted original; `unconfirmed` never counts) and adds a ledger write - a new failure point - to four SOR close sites
11. [LOW] Three incompatible `retry_root` rules (v2: no walk; 1b r2: walk three hops; 1b r3 draft: "one hop", wrong by v2's own section 0), and D8 stamps only rows "written before Stage 1b", so a post-1b retry of an unstamped pre-1b retry row stays unattributed and unrepaired; D8's two indexes also miss unit-less shares created before the list backfill
12. [LOW] 1b moves the rollup's "no matching recipient slot" line to INFO for every miss, and v2 never restores it: once both land, a genuine lost rollup on an original - the stuck-`sent` class D8 repairs - logs at INFO
13. [LOW] D3 has the route report "whether its promise is live", but the page must re-judge it on a ticker, which needs `retry_due_at`, not a boolean; and a "Not confirmed" pill can sit over finalize's stored "all recipients failed" alert
14. [LOW] Section 7's "drops it when it lapses" is unobservable in the scenario it sits in (the retry delivers at ~10 s, long before due + 2 min)

Adjudication contests: B16 (part) defended (finding 8); A12 (part) conceded -
v2 rewrote D7's writer list, so the misfiling it named no longer exists.

---

## 1. [HIGH] Two of three unresolved-retry closes never reach the slot

**What is wrong.** v2 answers round 1's BLOCKING (A1/B2) by making "the
reconcile's unresolved close of a retry" D2's third caller (D2 195-197;
section 0 49-56). But 1b ends a retry `unresolved` at THREE sites, and two of
them are in the retry JOB, not the reconcile:

- 1b r2 R3 (committed, line 295): on an unknown outcome, "If
  `secondUnknownWouldClose` (a re-driven attempt came back unknown) ...
  `finishAttempt(unresolved, second_unknown)`, then WITHDRAW, ERROR. An
  enqueue that throws after `handToReconcile`: `closeFromReconcile(unresolved,
  enqueue_failed)` then WITHDRAW, ERROR (a send may have happened)." The same
  arms are in the r3 draft (272-273).
- 1b r2 lines 401-402 (r3 draft 372-375): `retry_outcome: 'unconfirmed'` is
  "written only by the WITHDRAW write (R3's second-unknown and
  enqueue-failed arms, R4's unresolved close and its re-apply)".

I7 (404-407) says this branch "writes nothing to the retry job's record,
claim or closes" and extends only "the two reconcile paths". So for the two
job-side closes nothing writes the slot. The slot keeps the retried row's
`failed`/30003, whose promise is now WITHDRAWN - and D1's own state list files
"a withdrawn promise" under **failed** (143-145), the reading Cameron's Q1
ruling forbids (1b r3 draft 46-53: "Branch B counts such a recipient as
'already sent' on the review list").

The reconcile-side write is also not crash-safe: the reconcile closes the
record FIRST and a redelivered check that finds it `done` re-applies only
`slotCloseOf` (`app/src/jobs/sendReconcile.ts:405-419`); for the retry owner
1b maps that to its own WITHDRAW annotate (1b r3 draft 359-368), not to this
branch's slot write. And D8 (347-365) rebuilds chains from message rows; an
unresolved retry has no row, and D8 does not read `retry_outcome`, so the
repair cannot restore the state either.

**Evidence of the mechanism.** A re-drive happens only after the reconcile
rules `never_sent` (1b r3 draft 341-347); the re-driven send, in the same
incident, can time out again and close `unresolved` in the job with no
reconcile check - the shape a send outage produces. The share side of SOR
already handles the equivalent original-attempt path (the fan-out's
second-unknown close, `app/src/jobs/broadcastFanOut.ts:784-793`); the retry
side does not.

**What it implies.** For these retries the tenant, whose retry text may have
arrived, is un-flagged and offered pre-checked; the results row shows a plain
30003 failure plus "open conversation to retry" (D3's hint conditions,
211-214, never consult `retry_outcome`) while the thread hides Retry and the
route answers 409 `retry_unresolved` (1b r3 draft R5 387-389, R6 405-408) -
I5 broken. Goal 2's "by every path an outcome can arrive" (101-102) fails.
The cheap, principled fix needs no change to 1b: D1 and D3 already read the
newest attempt's message row for every failed-30003 slot (D3 203-206;
section 5 425-427), and 1b's R10 contract puts `retry_outcome` on exactly
that row (1b r3 draft 486-488). Read it there as "unconfirmed"; keep the
reconcile-side slot write as the accelerator; have D8 read it too.

## 2. [MEDIUM] D2's slot primitive has no rule for a lost condition

**What is wrong.** Round 1 (B7) showed that a status-only condition lets a
late `sent` regress a `failed`, and a strict compare-and-set drops a
`delivered` that loses to its own `sent`. The adjudication (item 6) answered
with a NEW primitive whose condition "names the attempt the slot currently
records" (171-175). That fixes the regression; it does not fix the dropped
loser. v2 gives the LEDGER "re-read and re-applied on a lost condition up to a
small bound" (299-301) and tests it (470-473), and says nothing of the kind for
the SLOT; section 7 lists no lost-race test for D2 (466-469).

**Evidence.** The rollup reads the share eventually consistently
(`app/src/routes/webhooks/twilio.ts:3880`, `:3899`); a retry's `sent` and
terminal receipts are separate requests after separate message transitions
(`twilio.ts:3462-3467`, `:3520-3545`; `failed` is allowed from `sent`,
`app/src/repos/messagesRepo.ts:138-141`); the fake posts them 150 ms apart
(`fake-twilio/src/engine/delivery.ts:18-31`). The repo already carries this
exact bug on the relay/group path
(`docs/issues/group-recipient-delivered-receipt-lost-to-sent-race.md:18-42`).

**What it implies.** Both rollups read `failed(R0)`; `sent(R1)` commits; the
`failed(R1)` write's condition names R0 and fails; if dropped, the slot reads
`sent(R1)` - "reached" - for a retry that failed: flagged, counted in the
strict reading, labeled Sent. The primitive needs the ledger's rule too: on a
lost condition, re-read consistently and re-apply while the D2 rule still
allows the move.

## 3. [MEDIUM] The ordering rules are defined only over message ids; three writes have none

**What is wrong.** D2's rule (181-189) is stated entirely in message ids: a
newer id applies, the same id applies "only forward, in the message machine's
own order", an older id never. I3 (393-395): a `failed` slot moves "only
through a NEWER attempt". D7's entry rule (317-319) likewise, with the forward
list "`counted` -> `pending` / `failed` / `unconfirmed`". Three v2 writes carry
no message id:

- D2 caller 3, "the reconcile's unresolved close of a retry ... there is no
  receipt and no row" (195-197): it moves `failed/30003` to
  `failed/send_unconfirmed` for the SAME recorded attempt - neither newer nor
  forward (failed is terminal in the message machine) - so the rule as written
  REFUSES it, and I3 forbids it. The ledger's `pending -> unconfirmed` is not
  in D7's forward list either.
- D7's legacy seeding (324-328): "the share its `broadcastId` names becomes a
  `counted` entry at its `sentAt`" - with no attempt id to compare against the
  next writer's.
- D7 writer 4 (309-310): the original's unresolved close has no message.

**What it implies.** A builder following the text either refuses the writes
the spec asks for or invents the ordering. State it: an id-less write applies
over the attempt it names (the retried row for caller 3); a seeded entry
orders before any real attempt.

## 4. [MEDIUM] `retry_pending` is zeroed by every SSE payload; the list pill reads "Not sent"

**What is wrong.** D4 (235-245): `retry_pending` is derived "only [on] the
results and list routes ... every other caller of the derivation gets zero",
and "the list row is re-judged only when it refetches (a `broadcast.updated`
from the retry's receipt, or a visit)". The list never refetches on
`broadcast.updated`; it REPLACES the row's stats with the event payload
(`dashboard/src/routes/broadcasts/useBroadcastsList.ts:111-124`), and the
results page overlays the payload's stats before its debounced refetch
(`useBroadcastResults.ts:121-134`). Every payload's stats come from an emitter
that, by D4, gets zero: the rollup (`twilio.ts:3936`, `:3981`), the fan-out
and reconcile emits (`broadcastFanOut.ts:226-232`, used at 13 sites). Worker
emits reach the app's SSE clients through the bridge, which forwards every
event name (`app/src/lib/eventBridge.ts:4-7`, `:42-57`). The pill is computed
from those stats (`BroadcastsList.tsx:144`, `BroadcastResults.tsx:146`).

**What it implies.** The failure rollup that STARTS a pending retry emits
stats with `retry_pending: 0`; the list row then reads "Not sent" (danger)
for the whole backoff, and every later emit for that share re-zeroes it; the
results header flickers the same way for 400 ms. Conversely, with no emit, a
lapsed promise leaves "Sending" until the tab is reloaded - not "up to the
grace plus the backoff" (243-245). D4 and I5 (401: "A list row may lag it by
one refetch") both misdescribe the hook. The spec must say how a payload
without the count is merged (keep the row's last value, or refetch the list
row on `broadcast.updated`).

## 5. [MEDIUM] The promise read has no time bound and degrades unsafely

**What is wrong.** v2 moves the promise off the slot and reads it from the
newest attempt's row "for a failed 30003 row" (D3 203-206) on the results
route, the list route (D4 238-240) and the preview route (section 5 425-427),
calling it "one read per such row, batched by conversation" and "Accepted"
(section 8 518-520).

**Evidence.**
- The repo batches within ONE conversation only
  (`messagesRepo.ts:1504`, `:3401-3407`); a one-to-one share has one row per
  conversation, so "batched by conversation" batches nothing across
  recipients.
- The preview unions every share of the unit, paged to exhaustion, inside
  one catch-all that returns an EMPTY set on any error
  (`app/src/repos/broadcastsRepo.ts:702-745`, catch at `:737-742`).
- The list route serves a page of shares (`app/src/routes/broadcasts.ts:803-839`;
  the dashboard asks 50, `useBroadcastsList.ts:29`), each up to the cap.
- Nothing bounds the reads in time, although the slot already says when its
  newest attempt was sent: the tsMsgId is `<provider ISO>#<SID>`
  (`messagesRepo.ts:202-204`), RSW's window is 15 minutes and 1b's longest
  refresh is `attemptedAt + 240 s + 2 min` (1b r2 line 295).

**What it implies.** A share that failed 30003 wholesale in an outage makes
every later preview of that property, and every list page that shows it, pay
one message read per failed recipient - forever. And a single failed read
inside the preview's catch-all now clears the "Already sent" flag for the
whole unit, the unsafe direction for the double text this branch exists to
prevent. Decide: skip the read when the newest attempt is older than the
longest possible promise; count an unreadable promise as pending.

## 6. [MEDIUM] D6 reads a `pending` entry as "Property sent" forever

**What is wrong.** D7 keeps the ledger free of time by never counting
`pending`, and a promise that lapses "leaves the entry `pending`" (293-297;
I6 402-403). D6 (263-267) then renders `pending` as "Property sent (the safe
reading for a timeline fact that is being retried)". Nothing ever moves a
`pending` entry when the chain ends without a retry row:

- 1b keeps RSW's wontfix: after "a refusal, a rejection, a window close or a
  success, the retried row's promise EXPIRES ... nothing here withdraws it"
  (1b r3 draft 62-66); its R3 rows for refused, rejected and a terminal
  deferral leave the promise "untouched (expires)" and write no retry row
  (1b r3 draft 269-271); today's job exits likewise
  (`app/src/jobs/retrySend.ts:174-182`, `:244-255`, `:330-337`);
- the webhook's enqueue-failure withdrawal runs after the rollup has written
  `pending` (`twilio.ts:3531` vs `:3622-3657`);
- the job-side unresolved closes (finding 1).

**What it implies.** Every such milestone says "Property sent" for a text
that never arrived - the exact defect
`tenant-timeline-property-sent-milestone-after-failed-delivery` names, which
D6 claims to close (271-273). An OLD milestone for the same pair would read
"Property text failed" (pair-level `counted` false), so the two
generations disagree. D6 must judge a `pending` entry the way D1 judges
pending - read the recorded attempt's row (the entry stores its message id,
279-282) - or D8 re-runs must be named as the only healer.

## 7. [LOW] "Stranded - never texted" is false for the route's ambiguous enqueue

D1 (147-148) defines stranded as a `queued` slot in a share "no longer
`sending` (the route marked it failed) - never texted", and D4 (228-229) reads
such a share "Not sent, danger". The route marks the share failed on ANY
enqueue throw (`app/src/routes/broadcasts.ts:761-775`; unconditional flip,
`broadcastsRepo.ts:619-645`, `:989-991`), and the fan-out never reads the
stored status (`broadcastFanOut.ts:370-374`), so a throw after SQS accepted
the job texts every recipient anyway
(`docs/issues/broadcast-route-markfailed-blocks-finalize.md:21-24`). During
that pass the recipients about to be texted - and any under reconcile - are
un-flagged and the pill reads "Not sent". Rare; name it as a residual or
classify by the attempt record, not the stored status.

## 8. [LOW] Contest: B16 (part) was rejected on a false premise

The adjudication (132-136): "the staff Retry route refuses anything but a
failed or undelivered message, and the automatic retry follows a failure, so
two attempts for one recipient never overlap in flight". The route checks only
the PRESSED row: failed/undelivered (`app/src/routes/api.ts:1595-1598`) and
its own promise (`:1608-1611`); "the same failed SID stays retryable
indefinitely" (`:1561-1563`). 1b's record guard does not block a `done/sent`
record (1b r3 draft 414-416) and leaves "the STALE-TAB press RSW already names"
open by construction (1b r3 draft 425-431); RSW files it as gap 2
(`docs/issues/manual-retry-double-send-residual-windows.md:30-33`).

So, once R0's promise lapses: (a) R1 delivered, a stale tab retries R0 -> S is
a LATER attempt after a delivery; the slot refuses it (never from
`delivered`) but D7 applies S as "newer" and, if S fails, un-counts a share the
tenant received - I2 (389-392) and its parenthetical are false; (b) R1
accepted with its receipt still pending, S sent -> they overlap; R1's later
`delivered` is "older" and refused (188-189), so a delivered tenant reads
failed. Rare, but the fix is one clause: a delivered attempt applies whatever
its age, and an entry counted by a delivery is never un-counted.

## 9. [LOW] Between a retry's send and its first receipt the share reads a final failure

v2: "A retry's mere acceptance is not written by anyone ... the slot learns a
retry from the carrier's `sent` confirmation or its terminal receipt"
(197-199). 1b writes no promise on success: "the retried row's
`retry_due_at` expires on RSW's clock" (1b r3 draft 229-232). If the job runs
late or the first receipt lands after `due + 2 min`, D1 reads the slot as
failed (the tenant is un-flagged) and D3 shows the hint (211-214), although
`sendMessage` has already appended the retry row (`sendMessage.ts:627-658`)
and the thread hides the retried row behind it
(`dashboard/src/routes/contact/Timeline.tsx:2066-2075`) - the conversation
offers no Retry. RSW's accepted late-job gap, inherited; name it.

## 10. [LOW] D7's writer for the original's unresolved closes writes a dead entry

D7 writer 4 (309-310) adds an `unconfirmed` ledger write to "the three sites
that write `send_unconfirmed` for a share recipient" (and the superseded
re-apply is a fourth, `sendReconcile.ts:415-417`). Those closes move only a
`queued` slot - an attempt that never recorded a send
(`sendReconcile.ts:936-941`, `:1003-1024`; `broadcastFanOut.ts:561-570`,
`:784-793`) - while the milestone exists only after a recorded send or an
adopted sent/delivered (`broadcastFanOut.ts:817-831`, `:1456-1463`). So the
entry has no milestone to relabel, never counts, and has no other reader. It
adds a ledger write with a re-read loop to SOR's close paths, against the
standing SOR ruling of "no new failure points"
(`docs/issues/send-attempt-sweeper.md:279-283`). Drop it; D6's "not
confirmed" words are reached through the retry path (caller 3) alone.

## 11. [LOW] Three incompatible root rules, and D8's stamp scope misses post-1b rows

- v2 section 0 (41-44): `retry_root` = the previous row's `retry_root`, else
  its own tsMsgId (no walk). v2 also says `retry_of` "names the attempt
  retried ... not ... the root" (30-31).
- 1b r2 (committed, 34-39): else walk `retry_of` up to three hops.
- 1b r3 draft (35-37): else the retried row's `retry_of`, "one hop reaches the
  root" - wrong for any pre-deploy attempt 2 or 3, by v2's own lines 30-31.

1b copies `broadcast_id` from the retried row (1b r3 draft 220-221, 442-447),
so a post-1b retry of an unstamped pre-1b RETRY row (an automatic chain in
flight at 1b's deploy, or a staff Retry of an old failed retry row) carries no
`broadcast_id` and possibly a wrong root. D8 step 2 stamps only rows "written
before Stage 1b" (353-356); such a row already carries `retry_root`, so a
builder keying on its absence skips it - unattributed and unrepaired. D8 step
1 walks "both share indexes" (347-349), but a unit-less share created before
the list backfill is in neither (`app/src/lib/tables.ts:368-370`, `:376-382`).
Pin one root rule across both specs and stamp any share-chain retry row whose
`broadcast_id` is missing or whose root is not the chain's first send.

## 12. [LOW] The interim INFO downgrade outlives the interim

1b r3 draft R7 (458-462) moves the rollup's give-up line
(`twilio.ts:3903-3906`) from WARN to INFO for every miss "until B lands"; v2
says a share retry's receipt "is logged at INFO" in the interim (45-48) and
never says what the line is afterwards. Once retry rows match, the only misses
left are genuine lost rollups on originals - the stuck-`sent` class D8 step 3
repairs (357-360) - and they would log at INFO. Restore WARN for rows without
`retry_root`, or scope the downgrade to retry rows.

## 13. [LOW] D3's boolean cannot be re-judged; a stale alert under "Not confirmed"

D3 (203-209) has the route report "whether its promise is live" and the page
"re-judges it on a one-minute ticker"; re-judging needs the instant, as the
dashboard's rule shows (`dashboard/src/routes/contact/retryPromise.ts:29-34`).
Return `retry_due_at`. (The sentence "so a promise that lapses is not shown
until the next fetch", 208-209, still reads as the opposite of the ticker's
purpose.) Separately, D4 shows `last_error` under Not confirmed (231-232); a
share whose original failed 30003 before finalize is stored with "all
recipients failed" (`broadcastFanOut.ts:1536-1537`), so after its retry ends
unresolved the "Not confirmed" pill sits over that alert.

## 14. [LOW] Section 7's lapse assertion cannot be observed where it sits

Section 7 (479-484) puts "the results row reads 'will retry' while the promise
is live and drops it when it lapses" inside the scenario whose retry delivers.
With the lane's ten-second backoff the row turns Delivered long before
`due + RETRY_PROMISE_GRACE_MS` (120 s, `retryPromise.ts:19`). The lapse needs
its own scenario - a retry that produces no outcome (a refusal during the
backoff) - and a wait of about two minutes plus one tick.

---

## Adjudications: accepted items that do not resolve their finding, or add a defect

- Item 1 (A1/B2): resolves the reconcile's unresolved close only; the two
  job-side closes remain (finding 1).
- Item 3 (A2) with item 10 (retry_pending): the read-through is right, but its
  cost has no bound (finding 5) and the derived count is erased by every SSE
  payload (finding 4).
- Item 4 (A4/B3): the ledger stays clean, but D6 turns `pending` into
  "Property sent" permanently (finding 6).
- Item 6 (B7): fixes the regression, not the dropped loser (finding 2).
- Item 14 (B11): the new writer has no reader and adds SOR failure points
  (finding 10).
- Item 5 (A6/B6): correct, with one misclassified case (finding 7).
- Item 20 (B20): stamp scope and index coverage gaps remain (finding 11).
- Rejected B16 (part): defended (finding 8). Rejected A12 (part): conceded.

## Checked and holding

- D1's in-flight reading restores today's flag for a reconciling or unreached
  recipient of a `sending` share (`broadcastsRepo.ts:716`, `:731`), and keeps
  `broadcasts.spec.ts`'s immediate "Already sent" assertion deterministic.
- D2's second caller is needed exactly as v2 says: an adopted retry's early
  receipts are dropped before its row exists (`twilio.ts:3353-3370`,
  `:3408-3422`), and SOR's own adoption writes the owner's slot for that reason
  (`broadcastFanOut.ts:1395-1416`). The reconcile adopts BEFORE it closes the
  record (`sendReconcile.ts:426-429`), so a hook inside the adoption is
  crash-safe provided it also runs on a deduped (`skipped`) re-adoption
  (1b r3 draft 331-333); D8 can heal a lost one, since the row exists.
- `retry_pending` as a sub-bucket of `failed` leaves finalize, the persisted
  counters and the chip balance intact (`broadcastFanOut.ts:1532-1537`;
  `StatChips.tsx:1-7`).
- D7's create-on-first-write and legacy seeding answer round 1's findings
  (modulo finding 3's ordering gap); the byContact GSI drops an item without
  `sentAt`, and flagging it `sparse` in `tables.ts` changes no generated
  Terraform (`app/scripts/gen-tables.ts` emits no `sparse`).
- The 1000 cap fits the one-attribute design: a retried slot is about 240 B
  plus a ~73 B pointer, ~313 KB at 1000 slots before the rest of the item.
- `sendMessage` only stamps `broadcast_id` (`sendMessage.ts:655-658`); its three
  readers remain the rollup gate, `isBroadcastRowFor` and `heldBy`'s label.
