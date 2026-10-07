# Plan review round 1 - reviewer A's delegated sub-review of S5 and S7

Returned after reviewer A handed back; it covers S7 Tasks 7.2, 7.3 and 7.5,
which reviewer A did not examine. Recorded by the planner from the
sub-reviewer's report (plan @66cdacf1; code = main @6e25e58a).

Verdict: a literal builder following S5 and S7 delivers D17, D22 "Settings
usage" and the D10/D11 (B) lines on server and dashboard. Distinct-record
logic correct (hand-checked tally arithmetic); every exhaustive map and field
list named; the cleanup script's behavior unchanged; Tasks 7.6 and 8.5 do not
collide. About 120 anchors verified unique at HEAD.

Findings:
1. [MEDIUM] No e2e drives S7's new Settings UI (organization Not-on-the-list
   rows with Use / Add as new + Kind / Clear, the organization-mode new-org
   dialog, Delete/Change kind with organization holders); the 5.7 dev-seam
   extension (`organization` via `POST /__dev/org-fixture`) is never called by
   any spec. AGENTS.md: "add or extend a spec for new behavior".
2. [LOW-MEDIUM] Task 5.5 tests `runAgain` but not the job's claim path, though
   both share `revalidationProblem` (`orgRewrite.ts:213-234, 276-277, 561`).
3. [LOW-MEDIUM] Task 5.6 misdescribes `orgNames.ts:260-262`: the
   `const { entries } = await list.get();` line sits BETWEEN the two quoted
   lines, so a literal edit can leave a redeclaration.
4. [LOW] Task 7.5 places `<OrgKindChoice>` two contradictory ways
   (`NotOnListSection.tsx:407-421`); the first reading is a JSX syntax error.
5. [LOW] Task 7.2 quotes a header comment that does not exist as written
   (`OrgPicker.tsx:36-38`).
6. [LOW] Two quoted comment phrases span lines (`orgRecords.ts:22-23`,
   `NotOnListSection.tsx:52-53`) - exact-match edits fail.
7. [LOW] One deleted record holding the name in two fields adds 2 to the
   display `deleted` while `inUse.deleted` = 1; the Delete dialog and Used by
   cell would show "+2 deleted". Fix: display `inUse.deleted`.
8. [LOW] Organization mode can still show "Use Split instead." via
   `orgErrorCopy` `org_name_compound` (`orgCopy.ts:281, 377`) after a failed
   add - contradicts plan 3.9.
9. [LOW] `e2e/support/selectors.md:121` org-picker row not updated by any task.
10. [LOW] Task 5.2's stated RED reason is wrong (it fails on the `skipped:1`
    count, `orgRecords.ts:353-356`); the RED still holds.
11. [INFO] Task 7.4's anchor appears twice (`OrgEntryDialogs.tsx:447, :503`);
    the plan says "first occurrence" - workable.
