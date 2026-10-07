# MISSION: One clean name per housing authority and agency - branch A (Sam #2; #19 caseworkers is branch B, later)

Worktree: W:\tmp\clean-org-names  Branch: feat/clean-org-names  (cut from main @d839494a)
Profile: W:\tmp\clean-org-names\.claude\feature-mission.profile.md
Spec: docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md (revision 8 @a198e88c; revision 5 approved by Cameron at the spec gate 2026-10-06; revisions 6-8 are plan-research and plan-review precision amendments plus Sam's 2026-10-06 answers in section 13 / Appendix A). This mission builds BRANCH A only: D1-D15 and spec sections 5-9, 11. D16-D21 (caseworkers) are branch B - do NOT build them.
Plan: docs/superpowers/plans/2026-10-06-clean-org-names.md (PLAN @a198e88c, 86 tasks; section 3 interfaces are BINDING)
Design review: spec R4 (closed; 68 findings, 67 accepted, 1 rejection conceded), plan R3 (closed; 45 findings over 3 rounds: 41 accepted, 3 rejections conceded by the reviewer, 1 informational note ruled at the launch gate; round 3 terminal; the launch-gate rulings are recorded at the end of the plan-review adjudications) - adjudications at docs/superpowers/reviews/2026-10-06-clean-org-names/design-review/adjudications.md and docs/superpowers/reviews/2026-10-06-clean-org-names/plan-review/adjudications.md
Records: docs/superpowers/reviews/2026-10-06-clean-org-names/ (commit each record as produced; run state only in .superpowers/)

Work map (plan section 2; ORDER S1 -> S2 -> S3 -> S4 -> S5 -> S6 -> S7 -> S8 -> S9 -> S10 -> S12 -> S13 -> S11 -> S14 -> S15 -> S16 -> S17):
- S1 rules: D4 normalize / resolve / compound / close names, D5 write checks, name and spelling checks, the starting list (Appendix A, final)
- S2 store: the `org-list` settings item repo (lazy create-only seed, read-and-bump mutate, unconditional seed put, peek, 300 KB guard) + harness fake
- S3 services: checks against the stored list; list operations; record iteration, usage, "Not on the list"; rewrite lock, start and run-again; new contactsRepo / unitsRepo writers + every typed fake
- S4 the `org.rewrite` job (never rethrows; heartbeat ownership stops a pass; one audit event per field written; never stamps unit `updated_at`)
- S5 `/api/organizations` router + composition-root wiring
- S6 D5 on the contacts PATCH, units POST/PATCH and broadcasts POST / preview / filter-resolved send (422 `org_not_on_list`)
- S7 AI: list block in the USER content, `orgListFingerprint`, apply-layer resolution, `agency_not_authority`, accept `value`
- S8 importer: housing authority fill-only (`if_not_exists`), agency when absent, not-written counts in the report
- S9 intake rule D15 (agency counts as an intake fact; Templates hint)
- S10 retire the app's two hand-kept lists; full-suite checkpoint (typecheck + npm test)
- S12 seeds: list names everywhere + the `org-list` put
- S13 dev seam `POST /__dev/org-fixture`; full-suite checkpoint
- S11 dashboard: API layer + hook; OrgPicker + "Is this really new?"; tenant and property forms; composer picker; suggestion accept; Settings > Housing authorities & agencies (lists, admin actions, Not on the list); activity labels
- S14 e2e: pinned specs move to list names; new specs
- S15 cleanup script `app/scripts/clean-org-names.ts` + tests + RUNBOOK section
- S16 GLOSSARY + issues (incl. the address-based authority follow-up)
- S17 sync main ONCE, the five gates, live self-QA (hermetic lane), handback

Watch items: plan section 12, plus:
- PARALLEL BRANCH feat/tour-list (W:\tmp\tour-list, tracker #18 final part) was building in AUTO on 2026-10-06. Shared files: `app/src/lib/seed/cast.ts` / `matrix.ts`, the END of `app/src/repos/unitsRepo.ts` and the typed UnitsRepo fakes (harness units fake included), `dashboard/src/api/types.ts` + `endpoints.ts` (+ tests), `dashboard/src/App.tsx`, two dashboard test mocks, `documentation/GLOSSARY.md`, `e2e/README.md`, `e2e/performance/routes.ts` + `routes.test.ts` (both branches bump its COUNT pins - recompute, never take a side). Keep edits there minimal and additive; never touch that worktree. Task 17.1 names what to keep if it merged before the sync.
- DynamoDB Local is SHARED with Cameron's local dev data AND with the tour-list mission's gates: `npm run db:start` if stopped; never restart, stop or remove the container. A red DynamoDB-backed suite while another worktree's gates run is judged by AGENTS.md's re-run-and-compare, never excused.
- Never test against Cameron's live :5174 / :8080; Playwright only through the e2e workspace; never edit source while this worktree's e2e runs.
- NO agent runs `clean-org-names.ts` against dev or prod - lane rehearsal only (`--env local --lane <L>`). No deploy, Terraform, secret push or SSM write.
- Do NOT edit the Improvements Tracker (Google Doc). The handback carries a two-to-three-sentence note each for tracker #2 and #19, in neutral third person (no "you"); #19's note says the caseworker half is branch B, planned after this merges.
- Boundaries: #6 owns the blast audience rules (this branch only gives the composer the list); #14 (the /join dropdown) comes later and uses the list.
- MODELS (Cameron's ruling at the launch gate, 2026-10-06): this mission runs NO Fable anywhere. The orchestrator itself is dispatched on Opus 5.5; every child is dispatched with an EXPLICIT model - opus for implementers, explorers, researchers and reviewers, sonnet only for trivial mechanical sweeps. Never let a child inherit the parent model.
- Launch-gate rulings already folded in: bare `Clayton` is a DCA spelling (the city in Rabun County), not Jonesboro's; `Clayton County` stays Jonesboro's. The extraction prompt's place-name rule stands.

Gates (bare, from W:\tmp\clean-org-names, real exit codes, never piped; AGENTS.md "Required completion gates"):
1. npm run typecheck
2. npm test  (DynamoDB Local up; on red, AGENTS.md's re-run-and-compare; any `[dynamoAdmin]` line is a real container fault)
3. npm run smoke
4. timeout 2700 npm run e2e  (from Git Bash, where `timeout` is coreutils; on a timeout: tree-kill `launcherPid` from `e2e/.artifacts/lane.json` - `taskkill /T /F /PID` in PowerShell or with `MSYS_NO_PATHCONV=1` from Git Bash - then `npm run e2e:stop`, confirm the lane's ports are free (plan Task 17.2); judge failures outside this feature against a main baseline)
5. npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')  (no NEW errors vs the merge base on the same paths; pre-existing: `dashboard/src/routes/broadcasts/useComposerDraft.ts:116` react-hooks/refs; the config does not lint .js/.mjs)

Post-merge obligations already known (Cameron's, never an agent's):
- No Terraform, table, index, env var, secret or feature switch: the `org-list` item creates itself on first read.
- BEFORE the deploy: the cleanup DRY RUN against prod from a `main` checkout (RUNBOOK), then review the leftover values with Sam.
- Deploy (dev first). IMMEDIATELY after the deploy: the cleanup APPLY - until it runs, a blast filtered on a new list name misses tenants still holding old spellings.
- Then Sam settles what is left on Settings > Housing authorities & agencies > Not on the list.
- The deploy also ships whatever else is on main and undeployed (#1, the tour auto-close backlog run, the tour list if merged) - Cameron's call.
- Branch B (caseworkers, D16-D21) gets its own plan after this branch merges.
