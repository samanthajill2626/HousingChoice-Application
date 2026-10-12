# MISSION: tracker #14 - /join housing authority dropdown, Onboarding start, lead backfill

Worktree: W:\tmp\join-housing-authority  Branch: feat/join-housing-authority
(cut from main @19607658; main merged in pre-build @469241f7 while the branch
held only docs; mission docs HEAD @fcff14fe)
Profile: W:\tmp\join-housing-authority\.claude\feature-mission.profile.md
Spec: docs/superpowers/specs/2026-10-12-join-housing-authority-design.md
(revision 4 + two precision notes; APPROVED by Cameron 2026-10-12)
Plan: docs/superpowers/plans/2026-10-12-join-housing-authority.md
(sections 0-4 BINDING; section 4 assembly rulings win over slice text)
Design review: spec R3 (terminal), plan R2 (terminal) - adjudications at
docs/superpowers/reviews/2026-10-12-join-housing-authority/design-review/adjudications.md
and .../plan-review/adjudications.md
Records: docs/superpowers/reviews/2026-10-12-join-housing-authority/
(commit each record as produced; run state in .superpowers/)

Work map:
- S1 Tasks 1.1-1.3: publicOrgList.ts (peek + starting-list fallback, never
  writes), the list router with its own 60/min limiter, mounted at /public
  BEFORE the shared /public mount; harness wiring; edge guard stays green.
- S2 Tasks 2.1-2.4: sign-up housingAuthority shape + exact-list check
  (housing_authority_not_listed), unitId+authority refusal, onboarding for
  no-unitId creates, housing_fair_signup_v2 on every new contact, audit
  signupVersion 2 + requested name, withAuthority log key, stale comments.
- S3 Tasks 3.1-3.6: publicApi, IntakeForm optional props (flyer unchanged),
  HousingAuthoritySelect, /join list read (default, loading, 10 s timeout,
  failed, StrictMode), not-listed recovery + 429 copy, Sign up another person.
- S4 Tasks 4.1-4.6: backfill script (rules, report, reads with audit paging,
  guarded apply, CLI main with executed exit codes) + RUNBOOK entry.
- S5 Tasks 5.1-5.3: /join e2e (two sign-ups, Onboarding + authority + marker),
  self-serve scenario, stale docs.
- S6 Tasks 6.1, 6.2, 6.3a, 6.3: one main sync, the five gates, the backfill
  rehearsal on a hermetic lane, handback.

Watch items:
- Two other agents work concurrently (fix/caseworker-integrity at
  W:\tmp\caseworker-integrity; the #3 + #27 work). Shared DynamoDB Local:
  check `docker ps`; never start, stop or restart a running container
  (AR-5). Never touch the live stack (:5174 / :8080).
- The e2e preflight refuses a session booted at another commit: boot per
  task, stop it before each commit (AR-6). Never edit app or dashboard
  source while an e2e run is live in this worktree.
- The backfill runs ONLY as `--env local --lane "$L"` with L read from
  e2e/.artifacts/lane.json in the same Bash call; never dev or prod; never a
  bare `--env local`.
- The Edit/Write tools decode `\u` escapes. Several anchors sit next to
  non-ASCII lines (public.ts, app.ts, publicIntake.test.ts, the harness,
  tenant-onboarding.spec.ts, STATUS-MODEL.md): copy those lines from Read
  output, never retype them. Added lines are ASCII.
- No named-flake list: a failing spec is a regression. Copy
  e2e/.artifacts/test-results BEFORE any re-run.
- Gate 4 on Windows: a timeout kills only npm - `npm run e2e:stop`, then
  `taskkill /T` on lane.json's launcherPid, then confirm the lane's ports are
  free before self-QA or a re-run.
- Gate 5: an empty file list means SKIP; attribute errors by the stdin
  baseline at the merge base. No eslint-disable comments for
  react-hooks/set-state-in-effect - raise a QUESTION instead.
- `npm test`: unset any exported AWS_* key; a `[dynamoAdmin]` line is a real
  container fault.
- Never merge. Never edit the Improvements Tracker. No infra, deploys or
  secrets.

Gates (bare, from the worktree, real exit codes):
1. npm run typecheck
2. npm test
3. npm run smoke
4. timeout 2700 npm run e2e
5. npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')
   (skip when the list is empty)

Post-merge obligations already known: the RUNBOOK backfill entry - Cameron
runs the dry run and then `--apply` on dev, then prod, after this branch
deploys there. No Terraform, secrets, schema, index or env change.
