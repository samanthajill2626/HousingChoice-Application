# U2 report - S3a (Tasks 3.1-3.5)

- Implementer: U2 (Claude Opus 5.5), 2026-10-06.
- Worktree `W:/tmp/clean-org-names`, branch `feat/clean-org-names`.
- Range: after 0aafb22d (U1 report) through 4fb917dc - 5 commits, one per
  task. Worktree clean after the last commit. Nothing left running.
- Next: Task 3.6 (`OrgNamesService`: read and the checks).

## Per task

| task | commit | RED (one line) | GREEN | fast gates (exit) |
|---|---|---|---|---|
| 3.1 | a9797f5d feat(org-names): shared org refusals and the control-character rule | Cannot find module '../src/services/orgNames.js' | orgNames + orgNamesService 44/44 (34 + 10) | typecheck 0 |
| 3.2 | 0fb55ec8 feat(org-names): contactsRepo.rewriteOrgFields - two-field conditional machine write | 12/12 TypeError: w.contacts.rewriteOrgFields is not a function (6 fake + 6 DynamoDB Local) | orgRecordWriters.integration 12/12, both halves RAN (none skipped) | typecheck 0; contactCapture + sendMessage + scheduledSendSuppression + audienceResolution + contactsRepo.integration 150/150 (0) |
| 3.3 | 0a655e22 feat(org-names): unitsRepo.rewriteAcceptedAuthorities - whole-list conditional, no updated_at | 10 units cases TypeError: w.units.rewriteAcceptedAuthorities is not a function (12 contacts cases green) | orgRecordWriters.integration 22/22, both halves RAN | typecheck 0; unitsRepo.integration + unitsRepoRoster.integration 27/27 (0) |
| 3.4 | 35f2b0f4 feat(org-names): org record access - uses, Not on the list, holders | Cannot find module '../src/services/orgRecords.js' | orgRecords 4/4 | typecheck 0 |
| 3.5 | 4fb917dc feat(org-names): the conditional per-field rewrite pass with heartbeat and audit | 14 rewrite cases TypeError: records.rewrite is not a function (the 4 Task 3.4 cases green) | orgRecords 18/18 | typecheck 0 |

Final combined run (S1 + S2 + S3a suites: orgNames, orgStartingList,
orgListRepo.integration, orgListFake, orgNamesService,
orgRecordWriters.integration, orgRecords): 7 files, 134/134, exit 0.
Lint preview (not a required gate here): `npx eslint` on all 13 touched
files, exit 0, no findings.

Checks on every commit: bare `git status` read first as its own command, no
MERGE_HEAD, explicit paths only, ASCII subject + `Co-Authored-By: Claude Opus
5.5 <noreply@anthropic.com>` trailer (verified with git log). New files: `tr
-d` count 0 each; edited files: added `git diff` lines 0 non-ASCII bytes.
DynamoDB Local was up throughout (never started, stopped or restarted).

## Worklist items applied

- RA-1 (Task 3.5): confirmed - the `(PIN) use whose from-text IS the name`
  case was RED with its neighbours at the RED run (records.rewrite is not a
  function) and GREEN after the implementation. Expected, not a regression.

## Divergences from the plan

None in code: every file and edit is the plan's text, and every anchor
matched exactly once as TEXT. Line numbers matched the plan for
contactsRepo, unitsRepo and the four suite fakes; the harness anchors had
drifted (contacts fake at 2488-2492 vs the plan's 2479-2483, units fake at
2875-2881 vs 2862-2868) because U1's Task 2.3 harness edits sit above them -
the drift plan section 0 anticipates. The Task 3.3 units writer sits exactly
where the plan puts it (after `list` in both the interface and the
implementation; no existing member reordered).

Process notes only:
- Task 3.5 RED: the plan lists two reasons (missing class exports, missing
  `rewrite`). Under vitest a missing named export is `undefined` at runtime,
  so all 14 cases fail on the first one hit - `records.rewrite is not a
  function`; the missing exports are type errors only. Same root cause.
- Typed-fake fallout was exactly the plan's list: harness + the four suites
  for 3.2, harness only for 3.3. Root typecheck (all workspaces, incl.
  tsconfig.test.json and tsconfig.scripts.json) found no other full
  ContactsRepo / UnitsRepo literal.

## Exports later slices rely on (as the plan writes them)

- `app/src/services/orgNames.ts`: OrgHttpError, toOrgRef, hasOrgControlChar,
  checkNewOrgName, checkOrgSpelling, nameProblemError, spellingProblemError,
  isOrgRewriteRunning, rewriteRunningError, asOrgHttpError.
- `app/src/lib/orgNames.ts`: SpellingProblem gained `{ problem: 'invalid' }`.
- `app/src/services/orgRecords.ts`: HolderRecord, NotOnListResolution,
  NotOnListRow, OrgUsage, OrgRecordsService (usage, notOnList, holders,
  rewrite), OrgRecordsDeps, createOrgRecordsService, ORG_REWRITE_HEARTBEAT_MS,
  recordFieldsForKind, OrgRewriteAbortedError, OrgRewriteLockLostError.
- `ContactsRepo.rewriteOrgFields`, `UnitsRepo.rewriteAcceptedAuthorities`
  (real repos + harness fakes; parity-tested against DynamoDB Local).

## Out of scope, noticed (no change made)

- `app/src/services/orgRecords.ts:285-345` (planContactRewrite, plan text):
  a WHITESPACE-ONLY stored agency (pre-trim legacy data, which notOnList and
  D5 treat as blank) counts as "holds something else": Move to Agency leaves
  the record as a conflict, and Split sets the authority but counts a
  conflict and keeps the blank agency. Likewise a whitespace-only housing
  authority makes Move to Housing authority a conflict. Spec D10 says
  "where agency is absent or ''". Low impact - legacy rows only, the record
  keeps its value and stays in "Not on the list", fixable one at a time - so
  flagged for the reviewers, not changed.
