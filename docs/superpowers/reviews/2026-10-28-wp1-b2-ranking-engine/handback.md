# WP1 B2a Ranking engine - build orchestrator handback (2026-10-29, refreshed 2026-10-30 after PFW1)

**CODE-COMPLETE @2c4894ad on `feat/wp1-b2-ranking-engine`
(`W:\tmp\wp1-b2-ranking-engine`), 0 behind `main` (main = 404e039d = the
merge base), UNMERGED (human gate). GATES PENDING THE PLANNER'S RE-RUN on
the post-PFW1 tree: the last full green battery is 542e6874, BEFORE the
planner's fix wave PFW1 (below). Then PENDING Cameron's three real-model
runs (`gate-run-commands.md`, the merge gate; measured commit now
45fc3326, fingerprint unchanged).**

## Q1 - ANSWERED by Cameron: option (a) (spec rev 7 D10, charter item 15)

The unlawful-flag record's `reason` is ALWAYS the fixed sentence "flagged
as a requirement fair housing does not allow"; the pair's own text stays
on its match and run (180-day TTL). Built in PFW1-1 (`flagReason` removed;
tests pin that no against / unknowns text reaches the record). The issue
`ranking-unlawful-flag-reason-source` is resolved.

## Planner fix wave PFW1 (2026-10-30; records code-review/planner-*.md, PFW1-report.md)

Cameron also widened where flags show (spec rev 7 D10 "Shown", charter
item 16). Commits 1a590afb..2c4894ad:

- PFW1-1 fixed reason (1a590afb, d6ef89d8).
- PFW1-2 (de8c1f2c): the Rankings page lists open unlawful flags only for
  a PROPERTY anchor's ranking and that property's runs; a tenant anchor's
  read answers `flags: []` and a tenant-anchor run detail reads no flag
  record. The cap is unchanged (candidate properties' open flags still
  suppress caps on a tenant anchor).
- PFW1-3 (2a131b18, 45fc3326): a read-only fair-housing notice on the
  property page for admin and va ("Fair-housing flag - <field label>:
  flagged as a requirement fair housing does not allow. Edit this text to
  clear the flag."), from `GET /api/rankings/unit/:unitId/flags` (400 for a
  tenant, 404 missing or deleted, 503 on a failed read -> the page shows
  "Could not check fair-housing flags."). One definition of open (the
  shared `openFlags` over the property's current card, read consistently);
  every card edit goes through the property edit form, whose save
  re-checks the notice without a reload. No Dismiss (B4). The e2e perf
  registry declares the new GET.
- PFW1-4 (40238a00): GLOSSARY and RUNBOOK flag lines.
- PFW1-5 (0a7c85f7): seven new issues, two appends, one resolved.
- Verification by the child (no full battery - the planner runs it):
  typecheck 0; app ranking tests 47 files / 855 passed (DynamoDB Local
  integrations included); dashboard rankings + listing + endpoints 33 /
  872 and src/api 13 / 188; e2e performance unit 17 / 479; eslint 0 on 32
  files; `rankings.spec.ts` 6 passed (run 2; run 1 failed only the new
  test's tenant pick, fixed in the e2e helper 45fc3326 - the anchor-type
  radio follows the URL and settles one render later). The 16 other
  property-page specs were not run (the planner's full e2e covers them).
- Open point for the planner: on a TENANT-anchor run, the run detail's
  per-pair "Flags" column (the run's own model output, D11) still reads
  e.g. "unlawful on qualifications" / "accommodation on no_pets". Spec rev
  7 gates the open-flag LIST; say if that column should drop the unlawful
  kind on tenant-anchor runs too.

## Work map

| Slice | Result | Commits | Report |
|---|---|---|---|
| S1 Notes box | shipped as planned | 657e7e7b..a2367d27 | slices/S1-report.md |
| S2 Foundations | shipped (S2a + S2b) | 6338ebe0..cafbabea, f7de5d9b..667fe48b | slices/S2a-report.md, S2-report.md |
| S3 Pool and cards | shipped (S3a + S3b); WL-S3-3 build ruling | 1d606409..6a84269d, f77d55d9..9dc940ee | slices/S3a-report.md, S3-report.md |
| S4 Model call | shipped (S4a + S4b); WL-S4-2, WL-S4-3 build rulings | 1174c487..a135a242, 5c702299..67b2b7d9 | slices/S4a-report.md, S4-report.md |
| S5 Job | shipped (S5a + S5b) | 6c8d8979..4ab0c5de, 7d1a6fca..7c9b959a | slices/S5a-report.md, S5-report.md |
| S6 Read + API | shipped | f24c2519..3aebab97 | slices/S6-report.md |
| S7 Dashboard + e2e | shipped (S7a + S7b) | 882055bc..6b338d94, 8771feec..04c80495 | slices/S7a-report.md, S7-report.md |
| S8 Scripts + docs | shipped (S8a + S8b) | a561977f..4023335d, e5022b08..a1077128 | slices/S8a-report.md, S8-report.md |
| S9 | sync (no-op), 2 gate batteries, 4 review rounds + 4 fix waves, self-QA, gate sheet filled | ebc618dd..542e6874 | code-review/, self-qa.md |

Phase 1: eleven parallel read-only readers compiled and ran the plan's
code in scratch projects (build-research/, WORKLIST 449ad1e2): 1 BLOCKER
(S5.6 test harness aliased the job record), 5 MAJOR (escape-safe test
writing, a tsc-only stub type, the e2e/performance mutation-catalog and
route pins, a key-printing dry-run step), 59 MINOR - all folded into the
briefs. 14 implementer children + 12 review/fix children, 0 misfires,
0 recoveries.

## Gates - PENDING the planner's re-run on the post-PFW1 tree; the last full battery, at 542e6874 (before PFW1), below (bare, real exit codes, quiet tree)

1. `npm run typecheck` - EXIT=0
2. `npm test` (DynamoDB Local up, no AWS_* exported) - EXIT=0: app 602
   files / 12739 passed / 1 skipped (staticSmoke's built-dashboard
   diagnostic); dashboard 282 / 5807; e2e unit 22 / 509; fake-twilio 34 /
   275; fake-twilio-web 13 / 111; zero `[dynamoAdmin]` lines
3. `npm run smoke` - EXIT=0: "smoke-dist: OK - 1892 import specifier(s)
   across 338 emitted file(s) resolve under plain Node."
4. `npm run e2e` - EXIT=0: "391 passed (16.5m)" (main's 385 + the 6 new:
   rankings.spec.ts 5, contact-notes-conflict.spec.ts 1)
5. `npx eslint` on the 186 `main...HEAD` .ts/.tsx/.js/.mjs/.cjs files -
   EXIT=0 (no errors, so no pre-existing ones to name)
- PR24 read budget, `RANKING_READ_BUDGET=1` on
  `app/test/rankingRead.integration.test.ts` alone - EXIT=0, 12/12:
  "[WI18] 150-tenant property read, ms: 223, 173, 161" (budget 5000)
- Battery 1 at a1077128 (before review): all EXIT=0, e2e 391 passed
  (15.8m), read budget 228 / 178 / 158 ms. No flake, no re-run.

Delta vs main (after PFW1, at 2c4894ad): 169 commits; excluding
docs/superpowers 225 files +32132 / -224; production source (app/src,
dashboard/src non-test, scripts) 79 files +11360 / -107.

## Code review (records: code-review/)

- R1: spec conformance (158 CONFORMS, 1 PARTIAL, 0 MISSING, 9 by ruling;
  0 must-fix) + two plan-blind adversarial reviewers (server; Notes box +
  dashboard). MEDIUMs: a thrown takeover leaked a job slot for the life of
  the worker (FW1-1), the Rankings page applied reads out of order and
  could leave a stale table under "Done" (FW1-4). 12 FIX rows, 5 FILE rows.
  REJECTED: A2-3 (old AI runs' false hash "mismatch" - accepted by spec
  D14.1 / PR28) and A2-4's guard half (extraction stays unguarded, spec
  section 4).
- R2 (two fresh): R2-server-1 MEDIUM = Q1; FW1 left 3 regressions and 2
  incomplete fixes on the page's data hook and the edit form (FW2).
- R3: 2 FW2 regressions (FW3). R4: 1 incomplete fix (FW4, R4's own
  probe-tested one-liner, verified by hand). Loop closed under the written
  LOOP RULE (regressions fixed, newly found pre-existing edges filed).
- Every fix-wave row was verified REAL by the next round (each new test
  fails with only its own fix reverted).

## Self-QA (self-qa.md; screenshots `.playwright-mcp/qa-*.png`, gitignored)

Hermetic lane 7, fake driver, jobs only by the dev tick. All pass: a
property ranked (not ranked yet -> Strong 80 / Good 70 / capped Weak 45
last, no reload); a card edit marks every row out of date; runs list, cost
by week ("Environment: local"), run detail with its own results and a
working "Since re-scored" link; a `[fake:fail-batch]` run ("4 tenants could
not be scored. Press Rank again.", "not scored - retry", "the last ranking
failed for it"); a tenant anchor; VA: no tab, redirect, API 202 / 200 /
200, admin API 403; the Notes conflict across two pages (copy, panel above
the box, Cancel keeps theirs on the page with no reload); events blocked ->
"Done" through the 5 s poll alone; no sideways page scroll at 1440 / 1280 /
1024 / 768 / 390 and the 64-hex fingerprint wraps. Notes: the cost table
and runs list refresh on Refresh, not when a job ends (QA-1).

## For Cameron (PR28, rulings, build decisions)

1. Q1: answered (a), built in PFW1-1; the flag display per charter item
   16 built in PFW1-2 / PFW1-3 (above).
2. The real-model runs: `gate-run-commands.md` - measured commit 45fc3326
   (last code commit, after PFW1), prompt fingerprint
   33e406a60079c1b829b123dbb27d63599bb4ced7e66934550a2793ce13e4bce9
   (unchanged by PFW1); orchestrator dry run (key unset) at 2c4894ad:
   stage one 414 calls (est. $16.80), stage two at most 660 more (est. at
   most $26.78), timing est. $0.15 (likely under $0.60). Check
   ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN are unset in your shell first
   (the sheet says how).
3. `move_in_date` (matrix-seed placed tenants, matrix.ts:542/568) is
   classified EXCLUDE "unclassified at B2a" - classify it.
4. `customFields` reach the model whole (spec D2.1) and two 180-day stores;
   the counterfactual check has no custom-field swap - decide (exclude,
   allowlist labels, or add a swap): `ranking-card-custom-fields-unclassified` (med).
5. Read the rubric r1 (`app/src/services/ranking/rubric.ts`) and the ten
   examples e1 (`examples.ts`). Build changes before the pins: the rubric
   names `created_at`; example cards list keys in a real card's order.
6. Extraction runs recorded before B2a whose window holds U+2028 / U+2029
   now show hash "mismatch" (D14.1, accepted).
7. Rulings approved at the launch gate, built as written: PR18, PR30, PR37,
   PR39 (env examples comment out RANKING_DRIVER / RANKING_WORKER_POLL
   where a laptop loads them - departs from "every var uncommented"), PR45.
8. Build decisions no ruling covered: the Rankings page shows a legacy
   plain-string address as stored (display only; the model's label is
   unchanged); the counterfactual `--out` pre-check exits 2 with no call
   and creates an empty record file, and a failed append after the calls
   prints the record and exits 1; a paid call whose job stopped is logged
   at WARN with usage and cost (spec D7 keeps the run unwritten); the
   final finish write is retried once; a notes_stale refusal hands the
   current contact to the page.
9. Worth your eye (NOTEs): no production-legal pause of ranking spend, and
   a missing ANTHROPIC_API_KEY now stops BOTH the app and the worker from
   booting (A1-9); `uflag#` rows have no TTL and runs / matches keep a
   hard-deleted contact's card up to 180 days (A1-12; the record itself now
   carries only the fixed reason, PFW1-1); one run's unlawful flag lifts
   that field's cap property-wide until the text changes, by spec D10
   (A1-16) - it now shows as a notice on the property page; a
   counterfactual control "hit" needs the flag on a listed field - fails
   safe (N13). The planner review's medium FILE rows (reason text and
   protected traits, a spend ceiling, stored-input retention) are issues
   for you (below).
10. Your launch-gate question holds (R1-conformance 3.1): the prompt
    fingerprint is the matching model's only and feeds no out-of-date
    test; an extraction change marks a match out of date only by writing
    different data onto a record.

## Issues

Closed (resolved 2026-10-29): `contact-edit-form-notes-save-drops-auto-lines`,
`extraction-note-line-break-unprefixed-continuation`,
`ranking-unlawful-flag-reason-source` (Q1, by PFW1-1). Updated:
`notes-guard-stale-reread-vs-flip-back` (part one; open),
`import-overwrites-notes-box`, `units-contacts-batchget-walk-duplicated`,
`extraction-text-field-write-races-staff-fill` (twice: R1 and PA-11),
`ranking-job-lifecycle-robustness` (PA-6, PA-7). New, build review:
`ranking-card-custom-fields-unclassified` (med),
`ranking-job-lifecycle-robustness`, `ranking-unlawful-flag-stale-overwrite`,
`notes-box-line-readers-split-differently`,
`notes-guard-double-click-overwrite`, `rankings-page-hook-edges`,
`perf-pages-settings-rankings-surface` (all low). New, planner review
(PFW1-5): `ranking-reason-text-protected-traits`, `ranking-spend-ceiling`,
`ranking-stored-input-retention` (med); `ranking-card-text-length`,
`ranking-read-cost`, `ranking-cost-undercount`,
`ranking-notes-injection-surface` (low). Planner-filed:
`ranking-location-distance-on-cards` (deferred).

## Post-merge / deploy - NO infra (no Terraform, no table, no index)

- **BROKEN until applied: `ANTHROPIC_API_KEY` must be present in dev AND
  prod before deploy** - production now refuses to start the app and the
  worker without it, whatever `AI_EXTRACTION_ENABLED` says.
- New env keys: RUNBOOK's sync-copy-push-check step - `secrets:sync` adds
  20 (dev) / 21 (prod) keys EMPTY; copy each value from the example (or
  delete the line), push, check; never push a blank.
- Ranking is live on deploy (no switch); only a Rankings-page press calls
  the model until B3. A deploy mid-ranking spends that job's one takeover
  (RUNBOOK).
