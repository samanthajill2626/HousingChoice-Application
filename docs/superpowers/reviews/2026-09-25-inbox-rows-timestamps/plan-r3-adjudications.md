# Plan review round 3 - adjudications (review closed)

Plan: `docs/superpowers/plans/2026-09-25-inbox-rows-timestamps.md`
Reviewed: v3 @c7744e19 against spec DRAFT 8.2. Result: plan v4 and spec
DRAFT 8.3 (5.2 residual stated; 5.8 sidebar link; 4.1 exception).
Reviewer: A, continued (`plan-r3-reviewer-a.md`, 9 findings; the reviewer's
read: precision outside Task 7b, whose two DECISION items belong to Cameron's
pending ruling).
Adjudicator: the planner (this session), 2026-09-25.

## Counts

- 9 accept, 0 reject. Decisions changed by the planner: 0. Both DECISION
  findings are inputs to the Task 7b ruling that is already with Cameron;
  the plan builds 7b by default with both folded in. Under the skill's stop
  rule this is the terminal round (precision-only outside a decision that
  is already the human's), one inside the four-round cap.

## Findings

1. HIGH DECISION, Task 7b changes where the mark-unread actions land, so
   `inbox-mark-unread-header.spec.ts:215` fails at the e2e gate. ACCEPT.
   Verified the assertion. Task 7b now names the one-line change to that
   spec; spec 4.1 records the exception. Part of the 7b ruling.
2. MEDIUM PRECISION, the `backToInbox` "goes BACK" test re-navigates when the
   inbox remounts. ACCEPT. The stub renders a row-shaped `Link` the test
   clicks; no auto-navigation.
3. MEDIUM PRECISION, reading `scrollRootRef.current` during render trips
   `react-hooks/refs` for dashboard sources. ACCEPT. Verified: the rule is
   off only for test files. The container is held in state for the observer
   and in a ref for the two mutating effects, both set in one layout effect.
4. MEDIUM PRECISION, the `statusRef === 'ready'` escape is untested after
   the deletion; a same-filter path exists. ACCEPT. The old test is
   REWRITTEN on that path (mark read, empty complete head, failed head with
   nothing rendered, Retry, commit under Retry); the orphaned paragraphs go
   with it; the carried-over comment example says the same path.
5. MEDIUM PRECISION, two rare timings could still fetch a second page.
   ACCEPT. The re-observe effect discards any unconsumed report first (a
   batched crossing), with a test; the queued-entry timing is stated as an
   UNVERIFIED residual in the plan and spec 5.2 rather than claimed away.
6. MEDIUM DECISION, contact pages have no back arrow, so the sidebar link is
   the way back from the main path. ACCEPT. Task 7b extends the same
   `fromInbox` rule to the sidebar's Inbox link; spec 5.8 says why. Part of
   the 7b ruling, put to Cameron with the recommendation.
7. LOW PRECISION, unconditional `preventDefault` breaks modified clicks.
   ACCEPT. `isPlainLeftClick` guard.
8. LOW PRECISION, the back link lives in `RelayGroupView`. ACCEPT.
9. LOW PRECISION, dropping 7b touches three other places. ACCEPT. Listed in
   Task 7b.

## Review totals (plan)

63 findings over three rounds; 62 accepted, 1 rejected then conceded. The
spec took precision edits in each round (DRAFT 8.1, 8.2, 8.3); no product
decision changed. Open for Cameron: the in-app way back (Task 7b) as
recommended, or drop it.

**Ruling (Cameron, 2026-09-25):** Task 7b DROPPED. The phone has its own
back button or gesture even in the installed app, so the premise was wrong;
only back and history navigations restore, every forward navigation opens at
the top. Findings 1 and 6 are moot with it; the plan is v5, the spec 8.4.
