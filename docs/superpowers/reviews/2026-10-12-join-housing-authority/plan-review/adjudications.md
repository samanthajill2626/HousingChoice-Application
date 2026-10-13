# Plan review round 1 - adjudications

Plan: `docs/superpowers/plans/2026-10-12-join-housing-authority.md`
(assembled @59a725f2). Two fresh opus reviewers: `R1-reviewer-a.md`
(5 findings) and `R1-reviewer-b.md` (6 findings). Both walked D1-D11 and
spec sections 6-7 to tasks and found full coverage; neither found a
BLOCKING or HIGH, nor a defect in the feature code - every finding is in
the build and run instructions. Merged below as P1-P8.

Before ruling, the planner verified the main-drift claim: main had moved 3
commits since the cut (e27868bc flyer voucher size, 794de277 RUNBOOK
caseworkers deployed, 5c0d3f6a matching voucher size), touching three files
the plan edits (`app/test/publicIntake.test.ts`,
`e2e/tests/dashboard-next/public-pages.spec.ts`, `RUNBOOK.md`). The branch
held only docs, so the planner merged main in BEFORE the build (@469241f7,
clean) and had each section's writer re-verify its anchors against the
merged tree.

Result: 7 accepted, 1 accepted in a different form. Decisions changed: yes
(P1 adds a task; P3 changes Task 4.5's tests) - round 2 follows.

| # | Finding (sources) | Ruling | Effect |
|---|---|---|---|
| P1 | The backfill rehearsal the spec requires has no steps: no lane id, no way to write pre-change leads into that lane; a wrong key/prefix tests nothing or writes into the live local stack (A-F1 MED, B-F2 MED) | ACCEPT | New Task 6.3a (S4 writer): find the booted lane's id, a throwaway seeding script through `app/scripts/lib/stageClient.ts` (lane-bound tables and key only), dry run + `--apply`, the marker-holding /join lead shown NOT a target; output verbatim into the handback. |
| P2 | Lane readiness `grep "web :"` matches the early "starting ... web :<port>" line (scripts/e2e-session.mjs:750), not the ready line (:766) (A-F2 LOW, B-F1 MED) | ACCEPT | S5 writer replaces the check with an ASCII pattern matching only the ready line. |
| P3 | Task 4.5 checks the CLI exit codes only by searching source text (A-F3) | ACCEPT | S4 writer makes the exit-code mapping executed by tests. |
| P4 | Main has moved; RUNBOOK's Caseworkers heading (Task 4.6's anchor) was rewritten by 794de277; Task 6.1's overlap list was wrong (A-F4, B-F3) | ACCEPT | Planner merged main pre-build (@469241f7); writers re-anchored S1-S2, S4 and S5 against it; Task 6.1 rewritten (keep main's RUNBOOK side exactly; the real overlap list). |
| P5 | Two accepted D10 edges live only in plan notes, not in docs/issues (A-F5) | ACCEPT, other form | They are accepted DESIGN limits, not deferred work, so they go into spec D10 beside the best-effort audit gap (precision edit), not into the issue registry. |
| P6 | S3's header says its commands work in PowerShell and Git Bash; its ASCII and MERGE_HEAD checks are bash-only (B-F4) | ACCEPT | S3 header: run from Git Bash. |
| P7 | Task 3.2 attributes lint errors against the shared main checkout, not the merge base (B-F5) | ACCEPT | Task 3.2 uses a throwaway detached worktree at the merge base, as gate 5 and S6 do. |
| P8 | Gate 4's `timeout` on Windows kills only npm; an orphaned stack would be adopted by the next run (B-F6) | ACCEPT | Task 6.2 gate 4: on any non-clean end, tree-kill this worktree's processes by PID and confirm the lane's ports are free before self-QA or a re-run. |

---

# Plan review round 2 - adjudications (TERMINAL)

Round 2 reviewed the plan @1da54a3c on the merged tree (@469241f7).
Reviewer B continued (`R2-reviewer-b.md`, 4 LOW + 1 concession). It found
that main's three commits break nothing the plan assumes, that every anchor
and the re-counted totals (30 -> 58) hold, and that the new Task 4.5 `main`,
its child-process test, Task 6.3a's lane guards and expected outputs, the
S5 ready-line grep and the 469241f7 RED source check out against the code.
It conceded P5 (the two D10 edges are one-shot or unreachable; the spec is
the right home).

Result: 4 accepted as precision edits to run instructions. Decisions
changed: NONE - the plan review is CLOSED at round 2.

| # | Finding | Ruling | Effect |
|---|---|---|---|
| Q1 | R2-1 [LOW] P8's tree-kill searched by command line; the launcher, app and worker run with relative command lines, so only Vite would match | ACCEPT | Task 6.2 gate 4: `npm run e2e:stop`, then `taskkill /T` on `lane.json`'s `launcherPid`, then the port check. |
| Q2 | R2-2 [LOW] Task 6.3a's curl fallback posts to the app port without the origin-secret header -> 403 | ACCEPT | Post through `<urls.dashboard>` (the Vite proxy adds the header). |
| Q3 | R2-3 [LOW] Task 6.3a's backfill commands had the builder type `<L>`; a dropped `--lane` becomes a bare `--env local` at the live local stack | ACCEPT | Every backfill command reads the lane from `lane.json` in the same Bash call and refuses an empty or non-positive lane. |
| Q4 | R2-4 [LOW] The lint baseline in a throwaway worktree has no node_modules, so its eslint cannot load the config | ACCEPT | Task 3.2 and gate 5: lint the merge-base content from the feature worktree with `git show <base>:<path> | npx eslint --stdin --stdin-filename <path>`. |

Plan review totals: 2 rounds, 16 findings (11 in round 1, merged to P1-P8;
5 in round 2 incl. 1 concession), 0 rejected, 1 accepted in another form
(P5).
