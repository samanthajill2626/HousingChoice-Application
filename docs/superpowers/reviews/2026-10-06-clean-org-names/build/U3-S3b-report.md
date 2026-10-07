# U3 report - S3b (Tasks 3.6-3.10)

- Implementer: U3 (Claude Opus 5.5), 2026-10-06.
- Worktree `W:/tmp/clean-org-names`, branch `feat/clean-org-names`.
- Range: after a7766e7e (U2 report) through 33fd03e0 - 5 commits, one per
  task. Worktree clean after the last commit. Nothing left running.
- Next: S4 Task 4.1 (`runOrgRewriteJob`).

## Per task

| task | commit | RED (one line) | GREEN | fast gates (exit) |
|---|---|---|---|---|
| 3.6 | a9140be9 feat(org-names): OrgNamesService reads and checks | 5 new cases: TypeError (0 , createOrgNamesService) is not a function (10 Task 3.1 cases green) | orgNamesService 15/15 | typecheck 0 |
| 3.7 | 744731d4 feat(org-names): OrgNamesService list writes - add, notes, spellings, kind, delete | 8 new cases: svc.add / updateNotes / updateSpellings / changeKind / remove is not a function | orgNamesService 23/23 (all blocks) | typecheck 0 |
| 3.8 | ea6cb95b feat(org-names): rewrite lock, rename, heartbeat and finish | Cannot find module '../src/services/orgRewrite.js' | orgRewriteService 7/7 | typecheck 0 |
| 3.9 | 543970ff feat(org-names): merge with the full spelling transfer | 3 new cases: svc.merge is not a function (7 green) | orgRewriteService 10/10 | typecheck 0 |
| 3.10 | 33fd03e0 feat(org-names): settle Not on the list values, Run again, and the cleanup lock | 11 new cases: resolveNotOnList / runAgain / acquireForCleanup is not a function (10 green) | orgRewriteService 21/21 (all blocks) | typecheck 0 |

Typecheck = root `npm run typecheck` (every workspace; app runs tsconfig.json,
tsconfig.scripts.json and tsconfig.test.json). No task names fallout: no
existing importer or typed fake is touched (both services are new surfaces).

Final combined run of every S1-S3 suite (orgNames, orgStartingList,
orgListRepo.integration, orgListFake, orgNamesService,
orgRecordWriters.integration, orgRecords, orgRewriteService): 8 files,
168/168, exit 0 (U2's 134 + 13 + 21). Lint preview (not a required gate
here): `npx eslint` on the 4 touched files, exit 0, no findings.

Checks on every commit: bare `git status` read first as its own command, no
MERGE_HEAD, explicit paths only (the two files of each task), ASCII subject +
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer (verified
with `git log --format=%(trailers)`). New files: `tr -d` count 0 each; edited
files: added `git diff` lines 0 non-ASCII. DynamoDB Local was up throughout
(never started, stopped or restarted).

## Worklist items applied

None in range (worklist S3 holds only RA-1, handled by U2).

## Divergences from the plan

None. Every file and edit is the plan's text; every anchor matched exactly
once as TEXT (Task 3.6 "append at the end of the file" = after
`asOrgHttpError`, the file's last function; Task 3.10's `heartbeat, finish,
}; }` anchor is the returned object's tail, after Task 3.9's `merge`). Binding
shapes kept: the rewrite id is minted by `newId()` before the one
`list.mutate` (Add as new mints the entry id first, then the rewrite id);
heartbeat / finish re-check `jobId` + `running` and write nothing otherwise
(`next === current`); `fields` fixed at start (`recordFieldsForKind` for
rename/merge, `[field]` for value actions, all three for the cleanup lock);
`ORG_REWRITE_JOB = 'org.rewrite'` declared in services/orgRewrite.ts.

## Out of scope, noticed (no change made - for the reviewers)

1. `app/src/services/orgNames.ts:294-304` (updateSpellings, plan text): the
   probe entry (`spellings: []`) that stops a re-sent list being refused as a
   duplicate of itself ALSO hides the entry's own spellings from the D4
   compound test. Reproduced on the fake: `updateSpellings('org-dca', ['DCA',
   'Georgia DCA', 'AHA DCA'], { confirmShared: false })` is ACCEPTED, although
   `resolveOrgText` calls "AHA DCA" compound and `checkOrgSpelling(full list,
   DCA, 'AHA DCA')` answers `compound` (so POST /check with spellingFor
   org-dca says compound while the PATCH stores it); afterwards "AHA DCA"
   resolves as a DCA match. Spec D12 refuses a compound admin spelling.
   Admin-only and needs a typed compound that contains one of the entry's own
   spellings, so low impact. Possible fix: also refuse when
   `compoundSpans(current.entries, normalizeOrgText(spelling)) !== null` for a
   NEW spelling (a text made only of the entry's own name/spellings is not
   compound - every span shares that entry).
2. `app/src/services/orgRewrite.ts:441-468` (runAgain, plan text = spec D11's
   letter): Run again re-checks only the TARGET names, never the from-texts.
   `resolveNotOnList` refuses an on-list value and a name variant (D10 guard;
   `orgRecords.ts:35-39` states orgRewrite.ts refuses such definitions), but a
   stored failed/stalled definition is re-queued even when a from-text has
   since become an exact list name (or a variant of one) of the field's kind.
   Reproduced: failed Clear of agency "Mercy Care"; "Mercy Care" then added as
   an agency (add is open to every user); a fresh Clear is refused 400, yet
   `runAgain` re-queues the Clear - its pass would clear every record holding
   the now-on-list name. Needs a failure + an add (or rename/merge onto the
   text) + an admin's Run again, so rare, but destructive. Possible fix: in
   runAgain, refuse (409 `org_rewrite_target_gone`, or a new code) when a
   from-text normalizes equal to the NAME of an entry of a field's kind other
   than `toName`.
3. Carried from U2 (unchanged, still open): whitespace-only legacy agency /
   housing authority values count as "holds something else" in the Move/Split
   planners (`app/src/services/orgRecords.ts:285-345`).
