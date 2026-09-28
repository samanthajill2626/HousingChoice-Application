# Spec review R4 (reviewer B) - share-sent-outcome design v4 (the cap)

Date: 2026-09-27. Spec under review:
`docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md`, DESIGN v4
at dc480dcc (read in full; `git diff 1951d190 HEAD` read). Adjudications read:
`spec-review-r3-adjudications.md`. Code: worktree `W:\tmp\share-sent-outcome`
at main @d9cb5c04 (read-only; nothing run). Stage 1b: revision 5 @dad3fecb on
`feat/retry-send-adoption`, unchanged since round 3 (worktree clean), cited as
**1b r5** with its line numbers. Every file:line below was read by this
reviewer.

v4 line numbers: section 0 = 24-99, D1 = 168-242, D2 = 244-301, D3 = 303-321,
D4 = 323-370, D6 = 384-405, D7 = 407-483, D8 = 485-527, invariants =
538-576, testing = 629-688, risks = 690-751, gate = 753-774.

## Summary

1. [MEDIUM] D4's per-row refetch has no route: the only per-share read is the results route, which returns every recipient and BatchGets every contact; during a long pass with any pending recipient every fan-out progress event re-triggers it (about one full read per second per open list page) for a share whose stored `sending` label never needed the count
2. [LOW] D1's record read has no bound and no failure rule: one consistent `get` per queued slot of every non-`sending` share of the unit, on every preview, forever (the repo has no batch read); a failed read inside `priorRecipientContactIds`'s catch-all would empty the whole set; `never_sent` is a verdict, never a stored outcome; and a running route-failed pass's unreached recipients (no record yet) read stranded
3. [LOW] Slot-first covers the slot, not the ledger, and not the enqueue arm's first crash window: a crash between 1b's hand-off (`reconciling`) and this branch's write leaves a record with no chain that no redelivery revisits and D8 does not read (it heals only `done/unresolved`), so the recipient reads failed for good
4. [LOW] Contest (a), defended narrowly: in exactly the hole's case (the retried row is a pre-1b retry row), r5's root walk already reads the root, which carries `broadcast_id` for a share chain - taking it there is a zero-read, one-expression change that closes the deploy-to-repair window D8 otherwise leaves open for weeks
5. [LOW] Two precision gaps against r5: D8 stamps only rows that LACK the fields, so a post-1b row whose root r5's three-hop cap got wrong keeps it (and, once stamped with `broadcast_id`, routes to no slot and logs ERROR); section 0's interim note says only 30003 texts have retries, but r5 stamps the staff Retry route's row too

Contest (b) - the step-4 re-apply: **conceded.** After slot-first, the only
loss left at the job's arms is a dropped guarded write, and then the job
completes normally, so no redelivery ever reaches step 4.

---

## 1. [MEDIUM] D4's per-row refetch has no route, and a pass drives it once a second

**What is wrong.** D4's merge (356-362): a payload that omits the count on a
row whose last count is above zero keeps it "only until a debounced refetch of
THAT row's stats from the route (the true count, from D1's reads) replaces it".
No route serves one share's stats in the list's shape. The broadcasts router
has one per-share read, `GET /broadcasts/:broadcastId/results`
(`app/src/routes/broadcasts.ts:786-797`), and it returns the whole recipients
map enriched with a contacts BatchGet over every contact key
(`:223-258`) - and, under v4, D1's promise reads. The list endpoint pages the
team-wide index with no id filter (`:803-839`). Sections 5 and 6 name no new
route.

**Evidence of the volume.** The fan-out emits `broadcast.updated` after every
slot move (`app/src/jobs/broadcastFanOut.ts:226-232`, used at 13 sites) at the
pacing rate, one send a second by default (`app/src/lib/config.ts:1059-1064`),
and the worker's bridge forwards every event to the app's SSE clients
(`app/src/lib/eventBridge.ts:42-57`). Every one of those emits omits the count
(D4 352-355). So once any early recipient of a long pass fails 30003 - the
rollup's lower bound makes the row's count positive (348-351) - each
subsequent progress event triggers the row refetch: about one full results
read per second per open list page for the rest of the pass (about 17 minutes
at the 1000 cap). The count buys nothing there: "Draft and Sending shares keep
their stored labels" (336).

**What it implies.** Name the route (a stats-only per-share read, or an id
filter on the list endpoint) as a new surface in sections 5 and 6, and refetch
only a finished share's row. Section 7's e2e (b) on the list (665-666) depends
on it.

## 2. [LOW] D1's record read: unbounded per preview, no failure rule, and two imprecisions

The read itself is sound: a broadcast record is keyed
`sendattempt#broadcast#<broadcastId>` with the hashed slot key as its sort key
(`app/src/repos/sendAttemptsRepo.ts:152-155`, `:176-181`), a contact-id key is
stored raw and a phone key hashed (`app/src/lib/sendFingerprint.ts:48-51`), and
`get` is one consistent read (`sendAttemptsRepo.ts:146`) - so the share id and
the slot key are enough. But:

- **Cost.** `priorRecipientContactIds` unions every share of the unit on every
  preview (`app/src/repos/broadcastsRepo.ts:702-745`), and the repo has no
  batch read (`sendAttemptsRepo.ts:112-149`). A route-failed 1000-recipient
  share costs 1000 consistent gets on every preview of that property, forever.
  The record TTL gives a free bound (`sendAttemptsRepo.ts:47-48`): a share
  older than 30 days has no records, so its queued slots read stranded with no
  read; a draft needs none either.
- **Failure.** D1's "a read that fails ... never empties the set" (241-242)
  covers the promise read. The record read sits in the same repo method, whose
  catch-all returns an empty set on any error (`broadcastsRepo.ts:737-742`).
  Say a failed record read reads in flight (the safe side).
- **`never_sent` is not a stored outcome.** It is a verdict
  (`app/src/jobs/sendReconcile.ts:307`, `:463`) that marks the record
  `redriven` (`:1182-1194`); nothing writes `done/never_sent`. The stored shape
  of "never went, a re-drive is coming" is the `redriven` state, which v4 reads
  in flight - right while the re-drive is pending.
- **A running route-failed pass.** D1 calls this case in flight (190-191), but
  the pass claims a recipient only when it reaches it
  (`broadcastFanOut.ts:866-879`); the recipients it has not reached yet have no
  record and read stranded (unflagged) for the rest of the pass - the in-pass
  window v1 accepted for `sending` shares, now for this one too. Rare; say it.

For the brief's questions: a `done/retryable` record beside a `queued` slot is
a deferral awaiting its continuation (the slot is written first, then the
record, `broadcastFanOut.ts:620-627`) - in flight is right while the pass
lives; a `done/adopted` record beside a `queued` slot is effectively
unreachable (the adoption moves the slot from `queued` before the record
closes, `:1395-1416`, `sendReconcile.ts:426-429`). The 30-day TTL bites only a
strand older than 30 days, which then reads stranded - acceptable for a hint.

## 3. [LOW] Slot-first covers neither the ledger nor the enqueue arm's first window

- **The ledger.** D2 puts the SLOT write first at the job's two arms
  (293-298); D7's `unconfirmed` entry write at the same arms (446-447) has no
  stated order. If it follows 1b's record close and is dropped, the entry
  stays `pending` and D6 reads its row (391-396), whose refreshed promise
  lapses - "Property text failed" while the slot says Not confirmed, until D8
  rebuilds the ledger. Put both writes first (the order rule supersedes an early
  `unconfirmed` entry exactly as it does the slot), or state that the ledger
  follows and D8 is its healer.
- **The enqueue arm's first window.** That arm runs `handToReconcile` (record
  `reconciling`), then the enqueue throws, then this branch's write, then the
  close (1b r5 R3 unknown row, 296). A crash between the hand-off and this
  branch's write leaves a `reconciling` record with no reconcile chain; the
  redelivered job returns at INFO on `reconciling` (1b r5 R2 step 4, 210-212);
  D8 step 3 heals only a `done` / `unresolved` record (508-512). The slot keeps
  its 30003 failure and, once the refreshed promise lapses, reads failed - for
  good - while the retry's text may be out. It is SOR's known
  "reconciling with no chain" strand
  (`docs/issues/send-attempt-sweeper.md:24-26`), but for a share original SOR
  leaves the slot `queued` (flagged, safe) and here the slot reads failed. Rare
  on rare; let D8 read a retry record stuck `attempting` or `reconciling` past
  the window plus the check schedule as unresolved.

The rest of the crash matrix holds: a crash before this branch's write at the
second-unknown arm leaves `attempting`, which the redelivery (after the claim
TTL) takes over into reconcile; a crash after it leaves the slot safely
`unconfirmed`; a crash after 1b's close leaves D8 the `done/unresolved`
record. No machine path re-sends after the slot is marked: a record already
re-driven once cannot be re-driven again and closes `unresolved`
(`sendReconcile.ts:1182-1186`), which lands on this branch's reconcile-side
writer; an adoption, or a staff Retry after r5's 15-minute record staleness
(1b r5 R6, 453-460), appends a row newer than the retried row, which the order
rule places after the row-less marker - it supersedes correctly.

## 4. [LOW] Contest (a): take `broadcast_id` from the root r5 already reads

The adjudication adapts to r5's one-hop `broadcast_id` and closes the hole with
D8. The hole is exactly "the retried row is a pre-1b retry row" (v4 fact 1,
54-61). In exactly that case r5 already walks: "for a pre-deploy retry row ...
the row reached by following `retry_of` up to `MAX_SEND_RETRY_ATTEMPTS` hops
(each a consistent read)" (1b r5 35-40). The row it reaches is the chain's
first send, which carries `broadcast_id` when the chain began as a share text.
Taking `broadcast_id` from the retried row, else from the walked-to root, is
one expression at the append sites r5 already names (241, 366, 508-513), with
no extra read. It closes the deploy-to-repair window, which is not small in
time: 1b deploys before this branch is even planned (section 0, 43-48), and
until D8 runs a staff Retry of any failed pre-1b retry row (always "childless"
to r5's route, since pre-1b rows carry no `retrychild#` pointers, 1b r5
496-507) routes nowhere. Worth a one-line relay rather than a reopened review;
if 1b stays closed, D8 is the right healer and the rest of the adjudication
stands.

## 5. [LOW] Two precision gaps against r5

- **D8 does not correct a wrong root.** D8 step 2 stamps retry rows "that lack
  them" (500-503). r5's walk stops at three hops (1b r5 35-40), so a pre-1b
  chain longer than that - an automatic ladder plus a staff hop - gives a
  post-1b retry a present-but-wrong `retry_root` and no `broadcast_id`. D8
  stamps the `broadcast_id`, skips the root, and from then on that row's
  receipts (and those of any retry copied from it) match no slot and log the
  ERROR section 0 reserves for routing bugs (85-88). D8's own walk follows
  every chain to its original (497-499); let step 2 overwrite a root that
  disagrees with it.
- **The interim estimate.** Section 0 says the interim miss costs "a few a day
  at most: only share texts that failed 30003 have retries" (82-85). r5 stamps
  the staff Retry route's row too, so "a transitioned receipt for a share-retry
  row (automatic OR manual...)" is routed into the rollup (1b r5 R7, 514-516):
  a staff Retry of a share text that failed for any reason pays the 2.5 s miss
  as well. Harmless; drop the 30003 qualifier.

---

## Direct answers to the brief's questions

- **Is the record readable by key from the slot's data alone, and is the
  outcome list right?** Yes (finding 2's first paragraph). The list is right
  in effect; `never_sent` is a verdict, not a stored outcome, and its stored
  shape (`redriven`) reads in flight.
- **Slot-first crash matrix.** Before this branch's write: sound at the
  second-unknown arm (takeover into reconcile); a gap at the enqueue arm
  (finding 3). After this branch's write, before the close: the slot is safely
  `unconfirmed`, and any later row supersedes it. After the close, before the
  WITHDRAW: D8 reads the `done/unresolved` record. No machine re-send follows a
  marked slot.
- **D8's record keys.** r5's owner key is
  `retry#<conversationId>#<retriedTsMsgId>#<attempt>` (1b r5 R1, 142) under
  SOR's `sendattempt#` partition prefix with the hashed recipient key as the
  sort key (`sendAttemptsRepo.ts:43-44`, `:176-181`). D8 can derive the
  recipient key by r5's rule - the retried row's `recipient_contact_id`, else
  `phone#<conversation.participant_phone>` (1b r5 149-153) - from the chain
  rows it already walks plus one conversation read; three keyed gets per
  retried row (attempts 1-3), as r5's own route guard does (444-447).
- **D4's row refetch.** No route; see finding 1.
- **D6 and the derived bound.** No shape outlives 24 minutes under r5 as
  written. The worst is the root's retry 1 running at the window's last second
  (`retrySendWindow.ts:72-84`) and coming back unknown: 1b refreshes to
  `attemptedAt + 240 s + 120 s` (1b r5 296), live 120 s more
  (`retrySendWindow.ts:93-97`) - 23 minutes from the root's own timestamp, plus
  the few seconds between the job's window check and its re-arm. A takeover
  uses the taken-over attempt's clock (1b r5 300-301), a re-drive refreshes to
  at most 19 minutes (377-381), a re-driven attempt's second unknown withdraws
  rather than refreshes (296), and a share row always has a window origin, so
  RSW's fail-open never applies. The one-minute margin holds. D6's one read
  per `pending` entry is bounded by the same window.
- **Section 0's four facts.** Accurate to r5: fact 1 (35-40, 62-64, 241, 366,
  508-513), fact 2 (408-411, 68-72), fact 3 (296, 210-212, 262-264), fact 4
  (435-443, 496-507). Finding 5 covers the two imprecisions around them.

## Checked and holding

- The `stranded` state closes round 3's F4: a genuinely failed route send (no
  record) stays unflagged, and a route-failed share whose pass ran flags the
  recipients it claimed.
- D2's older-delivery clause and D7's mirror are consistent: the slot records
  the delivered attempt as newest, and the entry becomes `counted` by delivery,
  terminal for both.
- D6 now reads a `pending` entry's own row, so the ledger holds no promise copy
  and I5's single source holds.
- The derived bound and its constants hold (above).
- Contest (b) conceded; round 3's row-design concession stands.
