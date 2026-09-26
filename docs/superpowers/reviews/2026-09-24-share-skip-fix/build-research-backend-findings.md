# Build research (backend, Tasks 6-8) - findings against plan v3

Date: 2026-09-25. Branch: `feat/share-skip-fix` at `cf088d22` (source tree
byte-identical to main@bbaad87d; main has since moved only in
`app/src/jobs/relayRetryLeg.ts` and its test, which Tasks 6-8 do not touch).
Plan: `docs/superpowers/plans/2026-09-25-share-skip-fix.md` (v3), Tasks 6-8.
Spec: `docs/superpowers/specs/2026-09-24-share-skip-fix-design.md` (v10).

Source: a read-only live-tree drift check for the Tasks 6-8 build. The anchor
table, helper signatures, importer lists and byte-exact quotes are in the
git-ignored `.superpowers/sdd/build-worklist-backend.md`. This file holds
findings only and cites code by `file:line`.

Result: no BLOCKER, no MUST-ADJUST. Every plan-quoted test can pass as written
against the current helpers and doubles. Four NOTEs follow.

---

## N1 [NOTE] Fan-out comments: one wrong anchor, two stale comments no task edits

- Task 6 Step 6 cites `:26-27` for the header's SendRefusedError bullet. It is
  `app/src/jobs/broadcastFanOut.ts:25-26`; `:27` is the 429/30022 bullet.
- The header's first-fence bullet at `broadcastFanOut.ts:9-10` says opt-out
  and unreachable recipients bump `skipped_opted_out` with no reason. That is
  wrong once Task 6 sends unreachable to `skipped_other` and records a reason.
  No task edits it.
- The refusal-branch comment at `broadcastFanOut.ts:492-494` says the
  recipient "is simply not reachable for this automated broadcast". That is
  wrong once Task 7 sends dashboard shares as a person's send. Task 7 Step 5
  edits only the header lines.
- All four lines already contain non-ASCII characters: `:9` and `:25` an
  arrow, `:10` and `:492` an em dash. Any reworded line must be written in
  ASCII.

Plan change:

- Task 6 Step 6: cite `:25-26`, and also reword `:9-10`.
- Task 7 Step 5: also reword `:492-494`.

## N2 [NOTE] The seed-file neighbour runs name the wrong test

- Task 7 Step 6 runs `test/seedData.test.ts`. That test reads only the lean
  `SEED`: `app/src/lib/seedData.ts:14-20` re-exports `seed/index.ts`, which
  re-exports `lean.ts`, and lean has no broadcasts. So it never exercises the
  `matrix.ts` or `performance.ts` edits.
- The tests that read those two files are:
  - `app/test/seedMatrix.test.ts` (`:87`, `:490-512`);
  - `app/test/performanceSeed.test.ts`;
  - `app/test/performanceSeed.integration.test.ts`.
- Task 6 Step 7 edits the same two seed files and runs no seed test at all.
- `matrix.ts` `buildBroadcasts()` is typed `Record<string, unknown>[]`
  (`app/src/lib/seed/matrix.ts:1202`). So `npm run typecheck` gives no feedback
  on the matrix additions either.
- I checked the assertions in those three tests. None of them breaks on
  `skipped_other: 0` or `created_via: 'dashboard'`.
- `contactsBatchReads.test.ts` and `contactsBatchIncomplete.test.ts` belong in
  the list. Both call the draft route through the test double's `create()`,
  which Task 7 changes.

Plan change:

- Task 7 Step 6: replace `test/seedData.test.ts` with `test/seedMatrix.test.ts`
  and `test/performanceSeed.test.ts`.
- Task 6 Step 7: add the same two tests.

## N3 [NOTE] Task 8's interface-doc range also covers `listByUnit`'s doc

- Task 8 Step 4 says to update the doc comment at
  `app/src/repos/broadcastsRepo.ts:310-323`.
- Lines `:309-314` are `listByUnit`'s doc. The `priorRecipientContactIds` doc
  is `:315-322`, and its signature is `:323`.
- Lines `:316` and `:320` already contain em dashes.

Plan change: cite `:315-322`, and write the reworded lines in ASCII.

## N4 [NOTE] Small anchor and text drift (each can be found by its content)

- `app/test/broadcastApi.test.ts`: the exact `toEqual` that needs
  `skipped_other: 0` is at `:1216-1225`. The plan says `:1220-1229`.
- `app/test/broadcastsRepo.integration.test.ts:20` already imports
  `UpdateCommand`. So Task 6 Step 3's "add it if it is not there" needs no
  import change.
- Task 8 Step 1's note says the file's lifecycle test already uses
  `setRecipient` and `markSent`. That test (`:84-145`) never calls `markSent`.
  `markSent` is used at `:285` and in the conditional-delete test.
- The `BroadcastStats` doc comment in `dashboard/src/api/types.ts` is at
  `:2888-2891`. The plan says `:2889-2892`.

Plan change: correct the four citations. None of them changes an edit.
