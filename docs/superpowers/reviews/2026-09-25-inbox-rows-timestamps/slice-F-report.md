# Slice F report - inbox rows + timestamps (plan Tasks 10b and 10, two test pins)

Date: 2026-09-25. Branch `feat/inbox-rows-timestamps`. Implementer: Claude
Opus 5.5 (1M context). I touched only the files the brief names. No excluded
file was needed; `app/src/routes/inbox.ts` was read only. Logs are in the
ignored `.superpowers/sdd/sliceF-*` files.

## Commits

- `67040252` chore(perf): the inbox request classifier and profiler plan
  follow the 100-row page (collect.ts, collect.test.ts, inboxDiagnostics.ts
  and its test, e2e/README.md).
- `85c94c26` docs(issues): resolve the reconcile-failure decision; file the
  inbox follow-ups (2 edited, 4 new issue files).
- `6f995947` test(inbox): pin the NBSP normalization and the Groups-tab
  complete head.

## Gates

All ran bare from the worktree, with output redirected to a log.

- **Collector tests** (`npm run test -w @housingchoice/e2e -- performance/collect.test.ts`):
  - HEAD baseline: exit 0, 40 passed.
  - Red (tuples moved, classifier not yet): exit 1, 3 failed and 37 passed.
    The failures were the tests at `collect.test.ts:257`, `:287` and `:448`.
  - Green: exit 0, 40 passed. The final re-run after the mutant checks was
    also exit 0, 40 passed.
- **`test/inboxDiagnostics.test.ts`** (run from `app/`): exit 0, 6 passed.
  - Against the HEAD plan module: exit 1, 2 failed and 4 passed.
  - Final re-run: exit 0, 6 passed. No `[dynamoAdmin]` line.
- **The two pinned dashboard files** (`--root dashboard`): exit 0, 37 passed.
  inboxListMerge has 23 (22 + 1) and inboxTime has 14 (12 + 2).
- **`npm run typecheck`**: exit 0 after commit 1's edits, and exit 0 again
  at the end.
- **`npm run test -w @housingchoice/e2e`** (performance and support, not
  Playwright): exit 0, 21 files, 499 tests.
  - I re-ran it after the dashboard test edits, because
    `mutationCatalog.test.ts` scans dashboard sources: exit 0, 21 files, 499
    tests.
- **`npm run test -w @housingchoice/dashboard`**: exit 0, 197 files, 3251
  tests. Slice D's last run had 3248; the extra 3 are this slice's tests.
- **`npx eslint` on the six touched .ts files**: exit 1 with exactly 2
  errors, both pre-existing: `no-unused-vars` for `mode` and `repeat` at
  `collect.test.ts:1218`.
  - Baseline: the HEAD file, linted under the same path, reports the same
    two errors at `:1204`. My 14 added lines moved them to `:1218`.
  - The other five files are clean. The two dashboard test files on their
    own: exit 0.
- **`npm run issues`**: exit 0.
  - Output: "292 open, 180 closed, 472 total" and "open by severity: 6 high,
    128 med, 158 low".
  - No warnings. My six files index as five open/low rows and one resolved
    row.
- **ASCII**: every added line has 0 non-ASCII bytes, and so does each of the
  four new issue files (`tr -d` count 0). `e2e/README.md` still has its 81
  pre-existing non-ASCII bytes; I did not touch those lines.

## Mutant checks

I reverted every mutant and checked that the file blobs equal the committed
ones.

- **M1: the arity guard removed from `collect.ts`.**
  - With the double-filter and cursor tuples at 100: exit 1. The
    double-filter assertion (`:318`) fails. With the double filter parked at
    30, the cursor tuple on its own also fails, at `:337`.
  - With both tuples at 30: exit 0, 40 passed. The pin is lost.
- **M2: the Groups arm left at 30.** Exit 1. Only the new per-filter loop
  (`:303-315`) catches it.
- **Pin B: `isAdditive` ignoring the filter.** Exit 1, with 1 failed (only
  the new test) and 22 passed. After the revert, `inboxListMerge.ts` has no
  diff (`git diff --exit-code` 0) and its blob equals HEAD.
- **Pin A: `plainSpaces` as an identity.** 2 failed and 12 passed.
  - With U+00A0 dropped from the regex: 1 failed (the Full test) and 13
    passed.
  - After the revert, the `inboxTime.ts` blob equals HEAD.

## Worklist items 15-22

- **15.** In `seen-set-max-equals-max-inbox-limit.md`:
  - I replaced the whole paragraph at old :51-55; it is now :53-63.
  - It cites the depth-cap tests by name, at `inboxFeed.test.ts:1469` and
    `:1489`, re-grepped after Task 8.
  - I changed the `updated:` value in place at :9 and did not add a second
    key.
  - `inbox.ts:196, :238, :1386` are now `:223, :272, :1715` in refs and in
    the body.
- **16.** The Resolution reads "Options 1 and 2 of the list below together,
  with the failure made visible (what option 3 wanted preserved)"
  (`inbox-reconcile-failure-blanks-list.md:20-22`). The file also has
  `status: resolved` (:6) and `resolved: 2026-09-25` after `created:` (:10).
- **17.** I filed `inbox-profiler-total-ms-overcounts-with-prefetch.md`: debt,
  low, open, area app/inbox, with the three refs.
  - It cites `profile-inbox.ts:117, :147` and `inbox.ts:2424`.
  - It cites `inboxDiagnostics.ts:144, :161`, re-grepped after commit 1
    moved that file by one line.
- **18.** No schema problem: `npm run issues` printed no warnings (see Gates).
- **19.** I moved `:273` and `:442` (now `:456`) to 100, and also `:289`. I
  replaced the comment at `:299-302`. For `:306-308` and `:320`, see
  divergence 2.
- **20.** `e2e/README.md:205-213` now lists the four `limit=100` page reads.
  It names the badge as `GET /api/inbox/unread-count`, classified by path.
  `:411` now says 100 contact rows.
  - Nothing else in the README changed.
  - The passage sits inside the CLI-reference span that
    `config.test.ts:348-369` parses. It adds no `--option` token.
- **21.** In `inboxDiagnostics.test.ts` I updated the title (:11), the four
  pins (:16-19), the comment (:37-38) and the `[100]` pin (:40). The
  `inboxDiagnostics.ts:58-64` docblock is rewrapped.
- **22.** The collector tests ran through the e2e workspace command as given.

## `limit=30` left in `collect.test.ts`

There is one, at `:312`, inside the per-filter loop. It asserts that each
filter's 30-row read classifies as null: the retired shape. It extends the
plan's `filter=all&limit=30` case to all four filters. The comment at `:301`
names it.

## Divergences from the plan

1. **Per-filter loop** (`collect.test.ts:299-315`). Each filter at 100 maps
   to its class, and at 30 to null. This replaces the plan's two assertions,
   for two reasons:
   - once `:289` is at 100, the plan's first assertion repeats `:291-293`;
   - no classifier call pinned the Unknown or Groups arms. M2 is caught only
     by the loop.
2. **Refused tuples at 100.** The double-filter (`:318`) and cursor (`:334`)
   tuples moved to 100 instead of staying at 30; the brief allowed either.
   - At 30, the size also refuses them, so M1 passes all 40 tests. At 100,
     only the arity guard can refuse them.
   - Each has a one-line comment.
   - The plan's own reason, "refused by arity, not by limit", holds only
     at 100.
3. **Badge docblock** (`inboxDiagnostics.ts:43-49`). "A workload the app no
   longer issues" became false once the unread page case is
   `{ filter: 'unread', limit: 100 }`. It now says such a case profiles the
   Unread page read, not the badge.
4. **README.** The rewritten passage also names `DEFAULT_PAGE_LIMIT`. It also
   says any other page size is a contract mismatch.
5. **Seen-set citations.** I went beyond the brief's three citations:
   - I refreshed every other stale line citation in the body: `:358,
     :1072, :1283, :1249, :1325, :223-237, :1732-1737`, and test `:1417`
     twice.
   - I mapped each one by reading the line at the issue's anchor commit
     `88ac7b36`, then re-grepping it in the live file. One sentence says so
     (:16-18).
   - The limit list "1, 2, 3, 25, or 30" gained 4, for Task 8's prefetch
     tests. "Nothing above 30" still holds.
   - The new paragraph cites `useInbox.ts:60`.
6. **Timeline issue.** `contact-timeline-time-format-differs-from-inbox.md`
   also names the property activity log. `listing/ListingDetail.tsx:822` uses
   the same `formatTime`, so this shows everything the fix would change.
7. **Profiler issue.** It also records slice E's residual. A prefetch chain
   still in flight when `aggregateInbox` returns settles after `durationMs`.
   Its events reach `trace.jsonl` and the summary, but not the printed
   "timed calls" count.
8. **Pin A.** The Full test also covers U+00A0. Both tests assert their spy
   was called once, so neither can pass on the real formatter's output alone.
9. **Commit bodies.** Commits 1 and 2 have a short body under the plan's
   subject.

A correction to the brief: the two existing issue files already had 0
non-ASCII bytes at HEAD. Only `e2e/README.md` has pre-existing non-ASCII.

## Worth an eye (not blocking)

- **Stale source fingerprints.** `e2e/performance/routes.ts:135, :689-692,
  :770, :778, :787` and `collect.test.ts:358` cite `useInbox.ts` line ranges
  from before the Task 5 rebuild. They are descriptive strings only, and
  nothing checks them.
- **Harness reads at 30.** Some of the harness's own inbox reads still use
  `limit: '30'`:
  - `routes.ts:1170`, the relay resolver;
  - `selfQa.ts:145` and `:225`, the fixture proof and snapshot;
  - both pinned at `routes.test.ts:716`.

  These are Node-side API reads and are never classified. I left them alone
  per spec 5.11.
- **Test docblock.** `app/test/inboxFeed.test.ts:1448` still calls limit 30
  "the dashboard's page size".
- **Open issue.** `thread-hooks-refetch-whole-page-per-event.md:124` still
  says each refetch reads 30 rows and installs them wholesale. It is now 100
  rows, applied through the spec 5.6 merge.
- **Profile comparability.** `perf:inbox` summaries have no workload version,
  so 30-row profiles from before this branch cannot be compared with new ones.
