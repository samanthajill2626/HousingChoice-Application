# MISSION: Tours page All tab - a server-paged, filtered tour list (Sam #18, final part)

Worktree: W:\tmp\tour-list  Branch: feat/tour-list  (cut from main @d839494a)
Profile: W:\tmp\tour-list\.claude\feature-mission.profile.md
Spec: docs/superpowers/specs/2026-10-06-tour-list-design.md (DRAFT 6, approved by Cameron at the spec gate 2026-10-06; later precision amendments are marked in place)
Plan: docs/superpowers/plans/2026-10-06-tour-list.md (PLAN v3 @649125f3)
Design review: spec R4 (closed; 44 findings, 2 rejections conceded), plan R2 (closed; 28 + 6 findings, all accepted, round 2 terminal) - adjudications at docs/superpowers/reviews/2026-10-06-tour-list/design-review/adjudications.md
Records: docs/superpowers/reviews/2026-10-06-tour-list/ (commit each record as produced; run state only in .superpowers/)

Work map (plan section 2; order S1 -> S15):
- S1 the date-range read pages to completion; Today's stale tours_today cap warning removed
- S2 seeds: `_schedPartition` on the four unstamped seed tour rows; the matrix assertion inverted; seedLive pin
- S3 `unitsRepo.getDisplaysByIds` (BatchGet, best-effort) + every typed UnitsRepo fake
- S4 `app/src/lib/tourListQuery.ts`: parse/normalize, phase plan, fingerprint + cursor
- S5 `toursRepo.queryListPhase` (+ scannedCount) + the ONE shared fake model + its DynamoDB Local mirror test
- S6 `listTourPage` engine (budget injected) + the engine over DynamoDB Local
- S7 `GET /api/tours/list` (before `/:tourId`)
- S8 `undatedTourLabel` + its eight readers ("Needs booking" for a request, "Undated" otherwise; "Not booked" retires)
- S9 dashboard api types + `listTours`; `tourListSelection.ts`
- S10 tabs All | Active | Past | Closed (/tours still lands on Active), `/tours/all` + its perf route-pin exclusion, P15, the named-views split
- S11 `useAllTours` (one loader at a time; walk / restore / follow; list generations)
- S12 `AllToursView`: filters, rows, count line; URL state (#1's model); back state + TourDetail; row-open write + return restore
- S13 e2e `tours-all.spec.ts`; perf known-gap note + ledger refresh
- S14 GLOSSARY + issues (`undated-tour-wording` resolved; the perf-pages issue widened)
- S15 sync main ONCE, the five gates, live self-QA, handback

Watch items: plan section 16, plus:
- PARALLEL BRANCH feat/clean-org-names (W:\tmp\clean-org-names, tracker #2 + #19) is at its plan stage. Shared files: `app/src/repos/unitsRepo.ts` and the typed UnitsRepo fakes, `dashboard/src/api/types.ts` + `endpoints.ts`, `app/src/lib/seed/*`, `documentation/GLOSSARY.md`. Keep edits there minimal and additive; never touch that worktree. If it merged to main before S15's sync, resolve by keeping both sides.
- DynamoDB Local is SHARED with Cameron's local dev data: `npm run db:start` if stopped; never restart, stop or remove the container.
- Never test against Cameron's live :5174 / :8080; Playwright only through the e2e workspace; never edit source while this worktree's e2e runs.
- Do NOT edit the Improvements Tracker (Google Doc). The handback carries a two-to-three-sentence note for tracker #18 in neutral third person (no "you").
- No housing-authority filter on this list (tracker #2 owns clean names).

Gates (bare, from W:\tmp\tour-list, real exit codes, never piped; AGENTS.md "Required completion gates"):
1. npm run typecheck
2. npm test  (DynamoDB Local up; on red, AGENTS.md's re-run-and-compare; any `[dynamoAdmin]` line is a real container fault)
3. npm run smoke
4. npm run e2e  (hard outer timeout; judge failures outside this feature against a main baseline)
5. npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')  (no NEW errors vs the merge base on the same paths; the config does not lint .js/.mjs)

Post-merge obligations already known: none expected - no new index, Terraform, migration, secret or feature switch. It rides the next deploy (which also ships #1 and the auto-close backlog run - Cameron's call).
