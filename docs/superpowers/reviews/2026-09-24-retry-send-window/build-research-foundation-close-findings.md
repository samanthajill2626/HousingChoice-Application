# Build research - foundation (S1: Tasks 1-2) and close (S5: Tasks 19-21) - findings

Read-only research against the live tree, worktree `W:\tmp\retry-send-window`,
HEAD `6fb365dd` (code identical to `f49a2fe9`; `main` has not moved,
`git rev-list --count HEAD..main` = 0). Plan v3
`docs/superpowers/plans/2026-09-25-retry-send-window.md`, spec draft 7.3.
Byte-exact quotations, the full implementer list and the invariant sweep are in
the gitignored reference, `.superpowers/sdd/build-research-foundation-close-reference.md`.

Result: 0 blockers, 2 must-fix, 5 notes. Every old-text anchor in Tasks 2 and 20
(35 checked) matches byte-for-byte at the cited line and is unique in its file;
Task 9's `childEnv` anchor (which Task 19 depends on) matches at
`scripts/e2e-session.mjs:272-273`. The gate-5 baseline claim holds: `npx eslint
dashboard/src/routes/contact/Timeline.tsx` exits 1 with exactly one error,
`react-hooks/set-state-in-effect` at `:1495:7`, and every other existing file
the plan touches lints clean. The spec's section 4 claim that no seed or dev seam
writes a retry field holds.

## Must-fix

1. **must-fix - Task 19 Step 1: the em-dash probe can never come back empty.**
   `rg -n "unreachable \x{2014}" dashboard/src` also matches
   `dashboard/src/routes/contact/deliveryStatus.ts:409`, a docblock line of the
   relay rollup presenter ("... unreachable <U+2014> the chip could never
   finalize"), which is not 30003 copy and which no task edits (Task 15's edit
   list is `:778`, `:818`, `:820-858`, `:863-876`, `:934`, `:990-1004`). Run
   today it prints `:409` and `:778`; after Tasks 15-18 it still prints `:409`,
   so Step 1's "NO hit ... If any is missing ... stop and finish it first"
   fires falsely and can send the builder back into Task 15.
   Correction: probe the copy, not the word -
   `rg -n "Phone unreachable \x{2014}" dashboard/src` (expected: no hit) - or keep
   the probe and name `deliveryStatus.ts:409` as its one expected, unrelated hit.

2. **must-fix - Task 20 Step 5 edit (a) and Task 21 Step 8 cite a reconcile
   revision the spec superseded.** Step 5 writes "`feat/send-outcome-reconcile`
   (revision 5, @`616d120d`)" into
   `docs/issues/manual-retry-double-send-residual-windows.md:47`, justified as
   "spec section 5 names revision 5 @`616d120d`" (plan `:9902`, `:9947`); the
   handback's Issues bullet repeats it (plan `:10410`). The live spec names
   revision 6 @`b93ab376` (spec `:568`, `:594-595`, `:764`) - the edit plan review
   R2-2 accepted (`plan-review-r2-adjudications.md:17`) but that never reached
   Tasks 20 and 21. Both commits exist; `b93ab376` is the one that splits the
   `retrySend` adoption into reconcile's Stage 1b.
   Correction: write "(revision 6, @`b93ab376`)" in the issue and in the
   handback, and fix Step 5(a)'s rationale. The suggested-fix sentence stays true;
   keying `retrySend`'s record is now Stage 1b's (spec section 5).

## Notes

3. **note - Task 20 Step 9 expects "exactly these seven files as modified".** The
   `git add` list has six paths (four issue files, `e2e/support/selectors.md`,
   `e2e/tests/dashboard-next/relay-30003-retry.spec.ts`); `docs/issues/INDEX.md`
   is gitignored (`.gitignore:62`). Correction: six.

4. **note - Task 20 Step 4's check is weaker than its purpose.**
   `git diff --stat -- docs/issues/relay-retry-stranded-claim-window.md` sees only
   uncommitted working-tree changes, so it cannot show that no earlier commit on
   the branch touched the file. Correction: `git diff --stat main...HEAD -- <path>`
   and `git status --short -- <path>`, both empty.

5. **note - Task 21 Step 8's handback lists one new issue; the branch adds two.**
   "Filed new" names only `vitest-config-globalsetup-fail-soft-comment` (added at
   `1c0c7ab3`), but `docs/issues/manual-retry-double-send-residual-windows.md` is
   also new on this branch (`git diff --name-status main...HEAD` shows `A`; added
   at `613752d1`, spec draft 3). Correction: list it as filed new as well as
   reconciled.

6. **note - Task 21 Step 8's copy-location recipe returns three lines.** After Task
   15, `rg -n "'30003': 'Phone unreachable'" dashboard/src --glob '!*.test.*'`
   matches the base `ERROR_CODE_REASONS` entry, the new `RETRY_SCHEDULED_REASONS`
   entry (a prefix match) and the kept `RELAY_ERROR_CODE_REASONS` entry (today
   `deliveryStatus.ts:860`). Correction: say which line each copy string records;
   searching `'Phone unreachable',` (with the closing quote and comma) separates
   the promise from the two plain entries.

7. **note - Task 2's "unchanged, must compile" list is incomplete, harmlessly.** It
   omits `app/test/emailEvents.test.ts:364`, `:392` (inline
   `updateDeliveryStatus: async () => true` inside `as unknown as MessagesRepo`
   casts) and the `annotateMessage` doubles `app/test/sendMessage.test.ts:251`,
   `app/test/scheduledSendSuppression.test.ts:293`,
   `app/test/mediaMirrorJob.test.ts:57`,
   `app/test/backfillMediaContentTypes.test.ts:81`. All stay assignable (fewer
   parameters, `unknown` or `never` casts). No class or `satisfies` implements
   `MessagesRepo`. The harness `append` is confirmed an explicit allowlist
   (`app/test/helpers/twilioWebhookHarness.ts:1088-1193`) that drops every new
   field today. No other allowlist-style double sits on a Task 8, 10 or 11 test
   path: Task 8's double pushes the raw input (`app/test/sendMessage.test.ts:232-235`),
   and Tasks 10 and 11 run through the harness that Task 2 fixes. The only other
   allowlist `append` (`app/test/apiRoutes.test.ts:312-318`, a relay team send)
   and the group-receipts `updateDeliveryStatus` double
   (`app/test/groupReceipts.test.ts:135-144`, ignores a fourth argument) are on
   no retry path. No action needed.
