# Caseworkers branch B - handback to the local dev machine

Date: 2026-10-12. From: the planner (Claude Code cloud session). To: the
agent on the local Windows dev machine. Requested by Cameron.

| Item | Value |
| --- | --- |
| Repository / branch | samanthajill2626/HousingChoice-Application, `feat/caseworkers`, UNMERGED (human gate) |
| Remote tip | the commit that adds this file; the last code change is `2f875cea` |
| Base / main | `d874915873a61864f6d051a0a9af3f0bb8e7e6e2` (main had not moved as of 2026-10-11) |
| Handoff this follows | `51a4868c` (the builder's cloud handoff, `handback.md`) |
| Verdict | QUALIFIED PASS for Cameron's merge decision (unchanged); all five gates pass on `2f875cea` in the Linux cloud container |
| What is still unproven | the gates on WINDOWS since the Linux harness merge, and gate 4 on the PINNED Chromium (the cloud ran Chromium 141) |

## 1. First: sync this machine

Your checkout may predate everything below. Sync without disturbing anyone
else's work, and run each command alone, checking its exit:

1. Never move `HEAD` in the shared `main` checkout.
2. `git worktree list --porcelain` - find the worktree on `feat/caseworkers`
   (the build used `W:\tmp\caseworkers`). Read its live state, not memory or
   older notes.
3. `git -C <worktree> status` must be clean, with no `.git` `MERGE_HEAD`. If
   it is dirty, or step 6 fails, STOP and ask Cameron: that is someone's
   work. Never reset, stash, rebase or force-push it.
4. `git -C <worktree> remote -v` - find the GitHub remote (named `origin`
   below).
5. `git -C <worktree> fetch origin feat/caseworkers main`
6. `git -C <worktree> merge-base --is-ancestor HEAD origin/feat/caseworkers`
   must exit 0 (the local branch has nothing the remote lacks).
7. `git -C <worktree> merge --ff-only origin/feat/caseworkers`
8. `git -C <worktree> log --oneline -1` must equal the remote tip, and
   `git -C <worktree> diff --name-only 2f875cea HEAD` must list Markdown under
   `docs/` only.
9. `git rev-parse origin/main` - if it is no longer `d8749158`, report the
   drift to Cameron before running gates (AGENTS.md: ask before a sync that
   could conflict).

No worktree on the branch? Create one per AGENTS.md and copy
`.claude\settings.local.json` into it (`.claude/CLAUDE.md`). No package,
lockfile or Playwright config changed since `51a4868c`, so an existing
`node_modules` is current; run `npm ci` only if it is missing.

A builder-era e2e lane may still be up. The preflight refuses a stack booted
at a different commit, but confirm no listener survives on the lane's ports
(or run `npm run e2e:stop`) before gate 4.

## 2. What changed since `51a4868c`

**A. Planner review records (docs only).** `7bcd6260`
[planner-final-review.md](planner-final-review.md) (with a 2026-10-09
addendum); `e6447786`
[planner-spec-conformance-review.md](planner-spec-conformance-review.md):
whole branch against spec rev 15 branch B, no P1/P2, fourteen P3 items, six
spec gaps.

**B. The Linux e2e harness merge** from `claude/ecstatic-edison-1r1s10`
(`9481ecf5`, `e156aafb`, then docs `9c14f54b`). It changes SHARED harness
code that runs on Windows too:

- `scripts/lib/cliEntry.mjs` (run-as-CLI detection for a POSIX `argv[1]`)
  and its callers `app/scripts/db-create.ts`, `app/scripts/db-update-gsis.ts`,
  `e2e/support/lane.mjs`;
- `scripts/lib/npmCli.mjs` (finding `npm-cli.js` in the POSIX Node layout)
  and its caller `scripts/e2e-session.mjs`;
- tests `app/test/cliEntry.test.ts`, `app/test/npmCli.test.ts`,
  `app/test/setup/dynamoAccessKeyGuard.test.ts`,
  `app/test/voicemailGreetingRoutes.test.ts`;
- docs: AGENTS.md (exported AWS credentials before `npm test`),
  `.claude/CLAUDE.md` and `e2e/README.md` ("Claude Code cloud container
  (Linux)" - cloud-only setup; it does not apply on Windows).

The unit tests cover both path shapes, but no gate has run on Windows since
this landed.

**C. Fix wave 2** (`70cbfe8e`, `10de23e7`, `2f875cea`; records `f464938a`,
`32db3531`). Cameron approved fixing P3-1..P3-8, test gaps T-1/T-2 and docs
D-1/D-2, and leaving P3-9. Full RED/GREEN, mutation and review evidence:
[fix-wave-2.md](fix-wave-2.md); the independent review:
[fix-wave-2-review.md](fix-wave-2-review.md). In short:

- New contact KindPicker: six choices are a 3x2 grid above the phone
  breakpoint ("Other" was clipped on desktop); Caseworker -> Other clears the
  role.
- Caseworker dialog and Possible list: a deleted contact, a team member, or a
  contact no longer possible gets a final line with no retry, and the lists
  re-read.
- Caseworkers rows: a long organization ellipsizes at wide panes and wraps in
  full when stacked, instead of crushing the name.
- Server: the repair path's audit carries the stored conversion record; a
  type override audits `type_source`; Move/Split on the wrong field answer
  400 before the lock; the contacts PATCH 404s phone/email pointer ids and
  Possible caseworkers skips pointer rows.
- Tests: FakeWorld `listByLandlord` pages like the real index (page-two
  refusal case); the housing-authority audience keeps partners out.
- Docs: RUNBOOK "Putting a mistaken conversion back" gains a status step;
  new issue [contact-routes-email-pointer-guard](../../../issues/contact-routes-email-pointer-guard.md)
  (pre-existing, not fixed).

## 3. Verification so far (Linux cloud container, `2f875cea`)

| Gate | Result |
| --- | --- |
| 1 `npm run typecheck` | exit 0 |
| 2 `npm test` (exported AWS keys unset) | exit 0, 740 files, no `[dynamoAdmin]` line |
| 3 `npm run smoke` | exit 0 |
| 4 `npm run e2e` (CI=1, Chromium 141 shim) | exit 0, 338 passed in 36.9m |
| 5 scoped `npx eslint` vs `origin/main` | only the 5 known base errors (`BroadcastComposer.tsx:204,229,248,263`, `ContactsList.tsx:184`); ratchet pass |

## 4. Your task: the Windows gates on the pinned browser

1. From the synced worktree, run the five gates exactly as AGENTS.md
   "Required completion gates" gives them, bare, one at a time, never piped,
   with a hard outer timeout on gate 4 (budget about 40 minutes).
   - Before gate 2, check `Get-ChildItem env:AWS_*`. If a key is exported,
     run gate 2 with it removed for that process only.
   - Gate 4 uses the repo-pinned Playwright Chromium (no shim). Expect
     **338** tests: 337 at handoff plus the new long-organization row test.
   - Gate 5: `main...HEAD` needs a local `main` at the base. If `main` is
     missing or elsewhere, the list comes back empty and eslint goes
     repo-wide (23 errors) - use `origin/main...HEAD`. Expect exactly the 5
     base errors above.
2. On any failure: AGENTS.md has no named-flake list, so a failure is a
   regression to diagnose. Re-run the failing file alone, compare with the
   cloud results above, and check whether it touches the section 2B harness
   files (a Windows-only harness failure points at that merge). Diagnose to
   root cause and report to Cameron; a fix needs his go under the small-fix
   gates.
3. Optional: Windows fonts were the original cause of the clipped "Other"
   (P3-1), and gate 4 measures it at 1280, 600 and 375px. If you want eyes on
   it, open the New contact dialog and Contacts > Caseworkers in an
   `e2e:session` lane (never `:5174`/`:8080`), screenshots under
   `.playwright-mcp/`, and stop the lane before gate 4.
4. Record exact commands, exits, counts, durations and the Chromium version
   in a NEW file `docs/superpowers/reviews/2026-10-07-caseworkers/windows-gates-<YYYY-MM-DD>.md`
   (ASCII; do not edit existing records). Read bare `git status`, commit that
   path explicitly with a `Co-Authored-By` trailer, and push to
   `feat/caseworkers` only.

## 5. Decisions that stay with Cameron

- The merge itself. The one-line PowerShell merge in
  [planner-final-review.md](planner-final-review.md) section 9 still applies
  if main has not moved.
- P3-9: the Possible-row button's accessible name ("Make <name> a
  caseworker") does not contain its visible label (WCAG 2.5.3); plan 3.9
  binds that name.
- The standing qualifications: Task 10.4 baseline-red and the unapplied C6
  scope decision; R2-ADV-1 (reproduced, parent-deferred, recommended for a fix
  soon after merge); the unexplained first FINAL2 blank-document failure.
- The six spec gaps in
  [planner-spec-conformance-review.md](planner-spec-conformance-review.md);
  review notes FW2-7 and FW2-8; the new email-pointer issue; Sam's A2P
  question.

## 6. Do not

Merge into main, deploy, run infrastructure or SSM changes, touch secrets or
real `.env.*` files, delete branches or worktrees, or stamp historical
records. Do not run `npm run e2e` and an `e2e:session` from the same worktree
at once.
