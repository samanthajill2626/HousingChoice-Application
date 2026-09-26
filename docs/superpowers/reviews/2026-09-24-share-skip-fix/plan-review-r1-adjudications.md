# Plan review round 1 - adjudications (share-skip-fix Branch A)

Date: 2026-09-25. Plan v1 @a0e594b5 -> plan v2 (this commit). Reviewers: A
(`plan-review-r1-a.md`, 21 findings) and B (`plan-review-r1-b.md`, 21
findings), independent, same brief. Heavy overlap; the merged list below keys
each item by the reviewer numbers (A#/B#). Every finding is a claim: ACCEPT
(the plan changed), REJECT (with the reason), or DEFER (filed). Severity labels
are the reviewers'; whether a DECISION changed is the planner's call and is
marked.

Decisions changed this round: 6 (the local stage selector; the e2e proof
design; the wrapper's recipient input; the fix script's audit-failure
handling; the census routing replay; the main-sync target). Round 2 runs.

## Accepted - decision changed

1. **A3 / B1 - the stage resolver hard-coded access key `local`; `--prefix`
   alone could not reach an e2e lane and steered agents at the live local
   database.** Verified: `e2e/support/lane.mjs:150-168` (one database per
   access key; lanes use `hclane<L>`), `scripts/db.mjs` (no `-sharedDb`),
   `scripts/e2e-session.mjs` forces the lane key. CHANGE: `--prefix` is gone;
   `--lane <L>` (positive integer) derives BOTH `hc-local-<L>-` and `hclane<L>`
   (`laneAccessKeyId`, pinned by test); refused with dev/prod; a bare
   `--env local` is documented as the live stack an agent never targets;
   Task 5's rehearsal, the Global Constraints and the RUNBOOK all say
   `--env local --lane <L>`. A `ResourceNotFoundException` is documented as
   "wrong lane, never fall back to bare local".
2. **A1 / B2 - Task 14 test 2 could not pass: STOP sets the contact flag and the
   send route drops opted-out recipients (400 `empty_audience`).** Verified
   `app/src/routes/broadcasts.ts:654-673` and that the route has NO consent
   fence. CHANGE: test 2 uses a tenant with no recorded consent (skipped
   `no_consent` by the fan-out's fence), which also gives D5 its
   skipped-then-not-flagged proof (below).
3. **A6 / B3 - no e2e proved "a skipped tenant is NOT Already sent", nor pinned
   "failed stays flagged"; the "keeps him checked" assertion was already
   green.** CHANGE: Task 14 now has three tests covering all six items of spec
   section 7: (1) switched-off delivery + D8 + went-out-flagged + seeded
   checked + the note; (2) no-consent skip -> "Not sent" + reason, then consent
   recorded -> NOT flagged and checked; (3) `setDeliveryOutcome` 30007 ->
   Failed + carrier reason -> still flagged (the interim rule, pinned as such).
4. **B15 - the wrapper re-read the recipient by id on the send path, feeding the
   fan-out's strand-the-broadcast throw.** CHANGE: `SendMessageInput.recipient?:
   ContactItem` - the fan-out hands over the item it already resolved; the
   wrapper does no second read; the I8 wrapper test needs no fixture change
   (which also closes A7 / B9). Passed for every recipient, phone#-keyed
   included.
5. **A5 / B7 - the switch write and the audit Put are separate; a lost audit
   left an unaudited change a re-run never fixes (I6).** CHANGE: the switch is
   counted `enabled` and logged BEFORE the audit append; an audit failure is
   caught, logged at ERROR with the conversationId ("switched on but audit NOT
   written"), counted `auditFailed`, and the run exits 1; RUNBOOK step 3 tells
   Cameron to backfill by hand from the named ids. A `TransactWriteItems`
   pairing was considered and not taken: it would need the audit item's key
   format duplicated outside `auditRepo`, a larger surface than a named,
   counted failure for a one-time script.
6. **B6 - the census filed every non-self_guided rung with a groupThreadId under
   `groupPointer` without checking usability; `resolveUsableGroup` is exported
   and costs one read.** CHANGE: the census calls `resolveUsableGroup` (cast to
   its one dependency) and files unusable-group rungs on the tenant 1:1 path,
   exactly as the job does; buckets renamed `groupRouted` / `oneToOneSwitchedOff`
   / `oneToOneBreakerTripped` / `oneToOneSwitchedOn`; the test seeds a usable
   and a closed group.
7. **A15 - the census overstated the rungs the bulk apply releases (breaker-
   tripped conversations; superseded ladders).** CHANGE: breaker-tripped 1:1
   rungs are their own bucket (the trip list is known by then); the superseded
   gate is replayed with `isSupersededRung(row, tour)` (a `superseded` bucket,
   tested via `currentLadderId`). The quiet-hours deferral is not replayed and
   the script's header says why (it delays, never retires).
8. **A4 / B5 - Task 15 merged `origin/main`, 11 commits behind local `main`.**
   Verified (`git rev-list --count origin/main..main` = 11; remote is
   `github`). CHANGE: `git merge main`, with the AGENTS.md ask-first rule.

## Accepted - precision (no decision changed)

9. **A2 / B4 - the D8 e2e regexes anchored at `/p/<unitId>$` matched only the
   pre-draft fallback; the sent link ends `?cta=text`.** Verified
   `app/src/lib/mergeFields.ts:28-30`. CHANGE: every e2e assertion targets the
   `?cta=text` steady state; the composer unit tests keep the fallback form and
   say why (that file's `createBroadcast` mock returns no `flyerUrl`).
10. **A8 / B13 - the sendMessage edit instruction contradicted itself.** CHANGE:
    "replace ONLY the lookup line and the opt-out gate".
11. **A9 / B14 - the deleted fence ran before the opt-out fence.** CHANGE: after
    opt-out and unreachable, before consent; the I1 test adds a deleted+opted-out
    recipient expecting `opted_out`.
12. **A10 / B11 - the exact `toEqual` at `deriveBroadcastStats.test.ts:43-52`
    breaks; Task 8's quoted code used `repo` and incomplete `AudienceFilter`
    literals (typecheck covers tests).** CHANGE: both fixed (`broadcasts`,
    `excludeOptedOut` / `excludeUnreachable`).
13. **A11 / B20 - several "red" steps were already green.** CHANGE: Task 7 names
    which tests are red and which are regression pins; a general note in the
    header says a builder never reports a red state they did not see.
14. **A12 / B10 / B21 - false plan-internal claims (invariant map, phone# case,
    persisted counters, "create if absent", absent-ai_mode origin, handback
    path).** CHANGE: the self-review map is rebuilt against the spec's I1-I8;
    each claim corrected in place.
15. **A13 / B21 - the slice-1 stop rule was ambiguous.** CHANGE: Task 6 starts
    after the orchestrator's slice review is clean and the planner has handed
    the commands to Cameron; it never waits for his dev/prod runs.
16. **A14 / B8 / B12 - RUNBOOK: the heading said "after the deploy"; the Logs
    Insights `=` filter could never match the em dash; bash JSON quoting in a
    PowerShell RUNBOOK; no `--no-cli-pager`.** CHANGE: heading says "as soon as
    slice 1 is reviewed - BEFORE its merge and deploy"; the import-window
    boundary is the merge; `filter msg like /circuit breaker TRIPPED/`; the
    Query uses the file's `ConvertTo-Json` idiom with `--no-cli-pager`.
17. **A16 / B16 - the skip-reason map in `broadcastFormat.ts` created an
    unlisted merge point.** CHANGE: the map (`SHARE_SKIP_REASONS`,
    `shareSkipReason`) lives in `deliveryStatus.ts` beside
    `INTERNAL_CODE_REASONS`, as spec D7 and Appendix A say; `broadcastFormat.ts`
    only composes per row; spec section 6 item 3 now names
    `shareRecipientReason` as the results-row reason gate (spec v9), and the
    handback relay repeats it.
18. **A17 / B17 - seed fixtures as writers of the person's-share record; Dario in
    the full profile.** CHANGE: the matrix and performance seeded shares get
    `created_via: 'dashboard'` (Task 7); spec section 5 says the full profile
    composes lean (v9).
19. **A18 - `ADD stats.skipped_other` on a pre-deploy stats map unexercised
    against DynamoDB.** CHANGE: a `broadcastsRepo.integration` case removes the
    attribute and bumps it (Task 6 Step 3; Review Focus 5).
20. **A19 - single mode never printed the id; refusals surfaced as a PARTIAL
    abort at ERROR.** CHANGE: the id is logged up front (tested); `UsageError`
    exits 2 with no partial banner.
21. **A20 / B19 - stale "the body names ONE tenant" / "exactly ONE tenant"
    comments; the `types.ts` balance rule; the fixture lacked the "RSW must not
    use it" guard.** CHANGE: Task 12 rewrites the two RecipientPreview comments
    and the composer's; Task 6 extends the `types.ts` balance comment; Task 13
    adds the guard to the fixture comment and fixes `contacts-list-facets.spec.ts`.
22. **B20 - the resolved-mode placeholder change had no test.** CHANGE: a
    MessageEditor placeholder test.
23. **B18 - the handback omitted the D1 numbers and the D2 outcome.** CHANGE:
    Task 15 Step 3 lists everything spec section 7 asks for, with PENDING when
    Cameron has not run yet.
24. **A21 - `timeout 1500 npm run e2e` is shell-dependent; a timeout kill
    orphans the stack.** CHANGE: Global Constraints name Git Bash for the
    timeout form, PowerShell bare, and the post-abort port check.

## Rejected

None. Every finding was either verified in the code or was a plan-internal
inconsistency the code cannot contradict.

## Deferred

None.

## Not a finding, recorded for round 2

- Reviewer A's coverage walk and reviewer B's "verified as correct" list are
  carried forward as the round-2 baseline: the round-2 reviewer should spend
  its effort on the v2 material (the lane selector, the census routing replay,
  the audit-failure path, the `recipient` item, the three e2e tests, the
  deliveryStatus map placement) rather than re-deriving them.
