# U4 report - S4 + S5 (Tasks 4.1-5.3)

- Implementer: U4 (Claude Opus 5.5), 2026-10-06.
- Worktree `W:/tmp/clean-org-names`, branch `feat/clean-org-names`.
- Range: after 235973ee (U3f report) through 4a225bad - 5 commits, one per
  task. Worktree clean after the last commit. Nothing left running.
- Next: S6 Task 6.1 (contacts PATCH D5). Per worklist RB-2, Task 6.1 Step 0
  item 4's grep now prints Task 5.1's harness line
  (`orgListRepo: world.orgListRepo,` in the `api:` block) - skip that fallback.

## Per task

| task | commit | RED (one line) | GREEN | fast gates (exit) |
|---|---|---|---|---|
| 4.1 | bc2fc3a5 feat(org-names): org.rewrite job runner - current-run check, per-field passes, never rethrows | Cannot find module '../src/jobs/orgRewrite.js' (file failed to load, no tests) | orgRewriteJob 9/9 | typecheck 0 |
| 4.2 | 96bd3482 feat(org-names): register org.rewrite for the worker and the in-process app | registerHandlers: expected 14 names to deeply equal 15; orgRewriteJob: (0 , registerOrgRewriteJobHandler) is not a function (2 failed, 9 green) | registerHandlers + orgRewriteJob 11/11 | typecheck 0; registrar fallout relayRetryLeg + mediaMirrorJob 141/141 (0) |
| 5.1 | f5135cb3 feat(org-names): /api/organizations reads, wired once in the composition root | 8 cases: expected 404 to be 200/400 (nothing mounted); the (PIN) requireAuth case green (401) | organizationsApi 9/9 | typecheck 0; named sweep settings + apiRoutes + broadcastApi 180/180 (0) |
| 5.2 | fbd0d6a3 feat(org-names): /api/organizations add, notes, admin spellings/rename/kind, delete | 8 new cases: expected 404 to be 201/409/503/200/403 (9 Task 5.1 cases green) | organizationsApi 17/17 | typecheck 0 |
| 5.3 | 4a225bad feat(org-names): /api/organizations merge, Not on the list resolve, Run again | 7 new cases: expected 404 to be 409/202/403 (merge, resolve, run-again unmounted); the (PIN) rename case green as the plan says (18 green) | organizationsApi 25/25 | typecheck 0; slice suites (organizationsApi, orgRewriteJob, orgRewriteService, orgRecords, orgNamesService, orgListFake, registerHandlers) 7 files 111/111 (0) |

Typecheck = root `npm run typecheck` (every workspace), run bare with output
to `.superpowers/sdd/u4-t*-typecheck.log`; 0 `error TS` lines each time.
Test logs: `.superpowers/sdd/u4-t41-red.log` ... `u4-t53-slice.log`.

Extra checks (not required gates here):
- Lint preview: `npx eslint` on the 8 files this unit touched (the
  `235973ee..HEAD` list), exit 0, no messages.
- Direct `buildApp` callers (the new router is default-constructed there):
  app, auth, devGating, staticSmoke, rateLimit, appIdentity - 6 files,
  162 passed / 1 skipped (the pre-existing built-dashboard diagnostic), exit 0.

Checks on every commit: bare `git status` read first as its own command, no
`.git/worktrees/clean-org-names/MERGE_HEAD`, explicit paths only (RB-3 lists,
below), ASCII subject + `Co-Authored-By: Claude Opus 5.5
<noreply@anthropic.com>` trailer (verified with `git log
--format=%(trailers)`). New files: `tr -d` count 0 each
(`app/src/jobs/orgRewrite.ts`, `app/test/orgRewriteJob.test.ts`,
`app/src/routes/organizations.ts`, `app/test/organizationsApi.test.ts`);
edited files: 0 non-ASCII added `git diff` lines (the pre-existing non-ASCII
lines of `registerHandlers.ts` / `registerHandlers.test.ts` / `api.ts` are
untouched). DynamoDB Local was up throughout (never started, stopped or
restarted).

## Worklist items applied

- RB-3 (explicit staging paths): 4.1 `app/src/jobs/orgRewrite.ts`,
  `app/test/orgRewriteJob.test.ts`; 4.2 those plus
  `app/src/jobs/registerHandlers.ts`, `app/test/registerHandlers.test.ts`;
  5.1 `app/src/routes/organizations.ts`, `app/src/routes/api.ts`,
  `app/test/helpers/twilioWebhookHarness.ts`,
  `app/test/organizationsApi.test.ts`; 5.2 and 5.3
  `app/src/routes/organizations.ts`, `app/test/organizationsApi.test.ts`.
- B-2 (build-time ruling): no change, as instructed. The router passes the
  service's OrgHttpError through unchanged. The one S5 case that exercises
  Run again with a stored definition (5.3 "an enqueue failure answers 202 ...
  Run again restarts it under a new id") passes WITH the B-2 from-text check
  in place: the rename's from-text (the old DCA name) is then only a spelling
  of the renamed entry, never a NAME, so the check does not fire. The service
  was not touched.

## Divergences from the plan

None. Every created file and every edit is the plan's text, verified by
`diff` of each created file / inserted block against the plan's fenced block
(byte-identical). Every anchor matched exactly once as TEXT. Line drift only:
the harness `api:` anchor (plan `:5143-5145`) sits at `:5198-5200` after the
S2/S3 harness edits; the `api.ts` anchors were at the plan's base lines
(`:85`, `:155`, `:331-333`, `:696-698`, `:739-748`).

## Out of scope, noticed (no change made - for the reviewers)

1. `app/src/routes/organizations.ts` DELETE `/:orgId` and PATCH `{ kind }`
   (plan text): `refuseWhileUsed` (a full contacts + units scan) runs BEFORE
   the service's running-rewrite check (`refuseWhileRewriteRuns` inside
   `OrgNamesService.remove` / `changeKind`). While a rewrite runs, an in-use
   entry therefore answers 409 `org_in_use` rather than 409
   `org_rewrite_running`, and each such request pays a full scan before it is
   refused. Both are 409 refusals and the service lock still guards the list
   write, so this is precedence/efficiency only - no wrong write is possible.
2. Plan text 3.4 / 3.5 / 3.6 (plan lines 356, 423, 449) still describe Run
   again's `org_rewrite_target_gone` as the target check only; B-2 widened it
   (the service docstring at `app/src/services/orgRewrite.ts:84-89` is
   current). Already known to the orchestrator; named here so S11's copy task
   and the reviewers read the worklist ruling, not the plan line.
