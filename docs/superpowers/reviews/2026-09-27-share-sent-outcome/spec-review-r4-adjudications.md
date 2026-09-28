# Branch B spec review round 4 - adjudications (the cap)

Date: 2026-09-27. Spec v4 (commit dc480dcc) -> spec v5 (this commit).
Reviewer: B continued (`spec-review-r4.md`, 5 findings: 1 medium, 4 low; two
adjudication contests, one conceded and one defended narrowly). Every finding
is a claim: ACCEPT (the spec changed), REJECT (with the reason), or DEFER
(filed). Severity labels are the reviewer's; whether a DECISION changed is
the planner's call.

Round 4 is the HARD CAP. Its precision findings are folded into v5 and the
loop STOPS. Two items still move the design; by the standing rule they are
NOT decided by a round 5 - they go to Cameron at the spec gate (v5 section 9),
each with a recommendation.

## Put to Cameron (design still moving at the cap)

1. **F1 (MEDIUM) - D4's per-row refetch had no route: the only per-share
   read is the results route, which returns every recipient and reads every
   contact; during a long pass every progress event (one a second) would
   re-trigger it for a share whose stored Sending label never needed the
   count.** ACCEPT the finding. Folded as precision: the refetch fires only
   for a FINISHED share (stored `sent` / `failed`) with a positive last-known
   count - a Sending or Draft share keeps its stored label and needs no
   count - so the volume is the receipts of finished shares with retries, a
   few a day. Still open, for Cameron: the READ's shape - a stats-only query
   flag on the existing per-share route (recommended: no new endpoint), a new
   stats endpoint, or no refetch (accepting the round-3 defect). Section 9
   item 1.
2. **F4 (LOW) - contest (a), defended narrowly: in exactly the one-hop
   hole's case (the retried row is a pre-1b retry row) r5's root walk already
   reads the root, which carries `broadcast_id` for a share chain, so taking
   it from there is a zero-read, one-expression change at r5's append sites;
   it closes the deploy-to-repair window D8 otherwise leaves open for the
   weeks between 1b's deploy and this branch's.** The defense is correct as
   far as it goes; the call is whether to reopen a closed 1b review loop for
   it. Planner's recommendation: skip - the window is not a regression (such
   a retry keeps today's behavior, its receipt bypassing the share, until D8
   runs) and D8 covers it. Cameron's call, section 9 item 2. The reviewer
   itself said "if 1b stays closed, D8 stands".

## Accepted - precision (no decision changed)

3. **F2 (LOW) - D1's record read had no bound and no failure rule; a failed
   read inside the preview's catch-all would empty the set; `never_sent` is a
   verdict, never a stored outcome (its stored shape is `redriven`, which is
   in flight); a running route-failed pass's unreached recipients have no
   record yet and read stranded.** ACCEPT: v5 D1 bounds the read by the
   record's 30-day life (a queued slot in a share older than that reads
   stranded without a read), reads in flight on a failed read (safe, logged,
   never empties the set), names the never-went shapes as stored (`done` with
   `refused`, `rejected`, `enqueue_failed`, `redrive_refused`; everything
   else in flight), and names the running-pass window as a residual in the
   double-text hint class (section 8), accepted under the standing severity
   rule.
4. **F3 (LOW) - slot-first covered the slot, not the ledger (D7's
   `unconfirmed` write at the job's arms had no stated order), and not the
   enqueue arm's first crash window (a crash between 1b's hand-off to
   `reconciling` and this branch's write leaves a record no redelivery
   revisits; D8 read only `done/unresolved`).** ACCEPT: v5 D2 puts the ledger
   write with the slot write, before the close, and names the window; D8 step
   3 also reads a `reconciling` retry record older than the reconcile's
   schedule with no chain row as unresolved.
5. **F5 (LOW) - D8 stamped only rows LACKING the fields, so a post-1b row
   whose root r5's hop cap got wrong kept it and, once stamped with
   `broadcast_id`, would route to no slot; section 0's interim note said only
   30003 texts have retries, but r5 stamps the staff Retry route's row
   too.** ACCEPT: v5 D8 step 2 corrects a `retry_root` that disagrees with
   the rebuilt chain; section 0's interim note names both retry kinds.

## Rejected

None.

## Deferred

None.

## Contests

- (a) One-hop `broadcast_id` vs asking 1b: defended narrowly by the reviewer;
  put to Cameron (item 2 above) rather than ruled by the planner.
- (b) The step-4 re-apply as a fifth site: conceded by the reviewer - after
  slot-first, the only loss left at the job's arms is a dropped guarded
  write, after which the job completes normally and no redelivery reaches
  step 4.

## Checked and holding (the reviewer's list, the plan's baseline)

- Section 0's four facts match r5.
- The send-attempt record is addressable from the share id and the slot key.
- No crash path re-sends after a slot-first write.
- No attempt shape outlives the 24-minute bound (the worst is 23 minutes plus
  seconds).

## Loop summary (four rounds)

| Round | Reviewer(s) | Findings | Decisions changed | Rejected |
|---|---|---|---|---|
| 1 | A + B, independent | 19 + 20 | 8 | A12 part (moot), B16 part (later CONCEDED by the planner in round 2) |
| 2 | B continued | 14 | 9 | none outright; F1's PROPOSED FIX replaced (reviewer conceded in round 3) |
| 3 | B continued | 8 | 6 | none |
| 4 | B continued (cap) | 5 | 0 folded; 2 put to Cameron | none |
