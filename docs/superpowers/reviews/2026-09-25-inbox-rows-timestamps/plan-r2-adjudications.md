# Plan review round 2 - adjudications

Plan: `docs/superpowers/plans/2026-09-25-inbox-rows-timestamps.md`
Reviewed: v2 @41159963 against spec DRAFT 8.1. Result: plan v3 and spec
DRAFT 8.2 (precision edits: 5.2, 5.8, 5.11, 7.3, 4.1, 10).
Reviewer: A, continued (`plan-r2-reviewer-a.md`, 18 findings: 3 labelled
DECISION, 15 PRECISION; conceded adjudication 21 of round 1).
Adjudicator: the planner (this session), 2026-09-25.

## Counts

- 18 accept, 0 reject.
- Decisions changed (planner's call): 2. (a) The auto-load rule: a report is
  consumed at arrival - fired while enabled, DISCARDED while disabled - and
  the hook re-observes when enabled with an epoch it has not handled; this
  replaces the "fire on a new report" rule that could act on a held report
  when the hook was re-enabled in the same render as a commit. (b) The in-app
  "Back to inbox" actions go back in history when the row was opened from
  the inbox; this is a PRODUCT call raised to Cameron at the launch gate and
  built by default as Task 7b. Round 3 is required and expected to be
  precision-only; the cap is round 4.

## Findings

1. HIGH DECISION, two pages when a commit that re-enables the hook finds a
   held "in view" report (restore, manual Load more after an empty page,
   mid-load crossing). ACCEPT. Verified the walk against
   IntersectionObserver's asynchronous delivery. Rule (a) above; Task 6
   rewritten with tests for each shape; spec 5.2 rewritten.
2. HIGH DECISION, the "enabled-only change never fires" test failed against
   v2 while the discard-and-re-issue case needed the opposite. ACCEPT. Rule
   (a) separates them: a failed page moves no epoch (no re-observe, the held
   report is discarded); a discarded loadMore follows a head commit (epoch
   moved, so enabling re-observes once).
3. MEDIUM PRECISION, the fake observer reports synchronously and no test
   changes `enabled` with the epoch. ACCEPT. The rule is timing-independent
   by construction (consumption at arrival); the new tests change `enabled`
   and the epoch in one render for the restore shape and cross mid-load.
4. MEDIUM PRECISION, the Task 7 test code still read
   `document.scrollingElement`. ACCEPT. Fallback in the test too.
5. MEDIUM PRECISION, the rewritten line-781 test cannot reach the guard and
   duplicates :717. ACCEPT. The test is DELETED instead (its scenario no
   longer exists); :717 still pins the spinner guard; the new-rule tests pin
   5.7.
6. MEDIUM PRECISION, Task 5 edits `Inbox.test.tsx` without listing or
   staging it. ACCEPT. Listed and staged.
7. MEDIUM PRECISION, no test exercises the `restoreScroll` seed. ACCEPT.
   Added (unmount immediately after a restored mount; 77 vs 0).
8. MEDIUM PRECISION, a long name CAN be minted through `POST /api/contacts`.
   ACCEPT (contesting round-1 adjudication 19 succeeded). Test 4 creates the
   contact first, then texts from its number; the placement tag stays in
   self-QA (spec 7.3 revised).
9. MEDIUM DECISION, the "Back to inbox" links and mark-unread navigations
   are PUSH arrivals; on the installed phone app they may be the only way
   back. ACCEPT as a product question for Cameron (spec 5.8, section 10);
   built by default as Task 7b (`backToInbox.ts`, row link state, four call
   sites); e2e test 3 gains the in-app back step.
10. LOW PRECISION, two carried-over comment blocks now say false things.
    ACCEPT. Both sentences amended in the carry-over instructions.
11. LOW PRECISION, a fifth `limit: 30` pin and DynamoDB Local for the app
    run. ACCEPT (Task 10b).
12. LOW PRECISION, Task 8's "honest red" was not red. ACCEPT. The stop-flag
    test gains `toBeGreaterThan(1)`, which is red before the prefetch exists
    (the sequential loop reads exactly one); the paragraph rewritten.
13. LOW PRECISION, `expectHeadFirst`'s second assertion was vacuous. ACCEPT.
    Replaced by "cursor requests followed" with an explicit expectation.
14. LOW PRECISION, self-QA item 5 wording. ACCEPT.
15. LOW PRECISION, interface blocks and Files lists. ACCEPT (four-argument
    signature; `Inbox.styles.test.ts` listed).
16. LOW PRECISION, `scrollTop` assigned on a state-held element may trip
    `react-hooks/immutability`. ACCEPT. The container lives in a ref with a
    `rootReady` render trigger.
17. LOW PRECISION, the warm-sample worry is unfounded (readiness waits for no
    pending tracked request). ACCEPT. Spec 5.11 and Task 11 simplified.
18. LOW, round-1 adjudication 21 conceded by the reviewer. Noted.

Round 3 goes to reviewer A (continued).
