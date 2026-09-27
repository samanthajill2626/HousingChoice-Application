# Planner verdict - feat/staff-notes-past-tours

Date: 2026-09-27, updated after Cameron's morning rulings (the 08:18 verdict
is superseded; it is in git history at 82021f6f).
Planner: Fable overnight; Opus 5.5 from the morning (Cameron switched the
model). Orchestrator: Fable (build-orchestrator), resumed once after the
planner's usage-limit death (infra tier; recovery budget unused).

## VERDICT: MERGE-READY - UNMERGED (human gate)

Branch `feat/staff-notes-past-tours` at `W:\tmp\staff-notes-past-tours`, code
head `dab99730`, tip = the commit carrying this file (records only after the
code head). Main was merged in ONCE, with Cameron's go (`28098b04`, clean, the
voicemail-greeting landing); 0 behind `main` @e13f207f.

Merge (PowerShell, from the main checkout, only when you are ready):

    git merge --no-ff feat/staff-notes-past-tours

No infra, dependency, deploy, seed-world or message-catalog change. No
post-merge operation owed. Cleanup (worktree, branch, doc stamping) only on
your explicit go.

## What changed since the 08:18 verdict (Cameron's rulings)

1. **Stale-page overwrite: BUILT** (spec 3.9). A Staff notes save carries the
   `staff_notes_updated_at` the editor opened with; the server refuses a stale
   save atomically (a conditional DynamoDB update) with 409
   `staff_notes_stale` and the current contact. The card shows the newer
   note, keeps the typed text, and a second Save replaces it on purpose.
   Issue `staff-notes-stale-page-overwrite` RESOLVED.
2. **Undated toured tours: BUILT** (spec 4.2a). The Past tab also reads
   `status=toured` and lists toured tours with no date LAST, as "Undated",
   with Record outcome. Issue `past-tab-timeless-toured-tours` RESOLVED. From
   the round-2 review, the same rows now include a tour marked toured BEFORE
   its day (it showed on no tab until that day) - spec 4.2a second amendment.
3. **Perf profiler: left out, hole marked in the code** - a KNOWN GAP TODO on
   the registry in `e2e/performance/routes.ts` and a paragraph in the e2e
   README's profiler section, both naming `perf-pages-tours-past-surface`.
4. **No-show exit: asked Sam** - a question under item 18 of the Improvements
   Tracker (Google Doc) ("Should a no-show get a way off the list, such as
   Cancel tour?"). Issue `past-tab-no-show-rows-need-an-exit` stays open for
   the answer.
5. **Kept as decided:** Past runs through the end of today (Q9); a
   move-forward tour with no placement shows as "Needs placement" (Q3); the
   Past row layout (OD-7).

## Gates (bare, from the worktree, quoted exit codes)

Full five on the merged tree `28098b04` (quiet tree, 17:09Z-17:40Z):

| gate | exit |
|---|---|
| `npm run typecheck` | 0 |
| `npm test` | 0 - app 7295 passed / 1 skipped; dashboard 3467; e2e-vitest 499; fake-twilio 252; fake-twilio-web 111. 0 `[dynamoAdmin]` lines. |
| `npm run smoke` | 0 - 1437 import specifiers across 254 files resolve |
| `timeout 2700 npm run e2e` | 0 - `293 passed (23.1m)` |
| `npx eslint <touched files>` | 1 - `3 problems`, exactly the merge-base baseline (unused `FieldSource` import in TenantFile; `react-hooks/purity` in TourDetail; `react-hooks/set-state-in-effect` in the pre-existing `useClosedTours`). No new error. |

Re-verification on the code head `dab99730` (the round-2 fixes; quiet tree):

| check | exit |
|---|---|
| `npm run typecheck` | 0 |
| `npm test` | 0 - app 7295 passed / 1 skipped; dashboard 3469 (+2: the future-dated selector case and the focus case); e2e-vitest 499 (includes the perf route registry tests); fake-twilio 252; fake-twilio-web 111. 0 `[dynamoAdmin]` lines. |
| `npm run smoke` | 0 |
| `npx eslint <touched files, branch + working tree>` | 1 - the same 3 baseline errors, nothing new |
| `npm run e2e -w @housingchoice/e2e -- tours-past.spec.ts tenant-staff-notes.spec.ts` | 0 - `4 passed (35.6s)` on a fresh hermetic stack |
| the undated Playwright test ALONE (`--grep "undated"`) | 0 - `1 passed` (it failed alone before the fix, per the reviewer) |

Not re-run on `dab99730`: the other 289 Playwright specs. The code delta
touches only the Past selector (its two specs ran), the Staff notes card's
focus effect (its spec ran), a test-only fake (every app suite ran) and
comments. Say so if you want the full e2e on the final commit; it is ~25
minutes.

## Reviews and adjudications (all records committed in this directory)

- Design: spec 3 rounds (37 + 9 + 4 findings), plan 3 rounds (29 + 6 + 3).
- Build: R1 spec-conformance CONFORMS 0/2/7, R1 adversarial plan-blind 0/3/3,
  two fix waves, R2 re-review 0/1/4, live self-QA (`self-qa.md`).
- Planner review (overnight): conformance CONFORMS (10 low), adversarial 0
  blocking / 1 medium / 7 low (`planner-review-*.md`).
- Guard + undated review, round 1 (`guard-review-adversarial.md`): 1 blocking
  (a pinned test body, also caught by the gate), 1 medium, 5 low - all
  accepted and fixed (`guard-review-adjudications.md`).
- Round 2 (`guard-review-r2-adversarial.md`): 0 blocking / high / medium, 5
  low + 1 nit - all accepted (one in part: the undated rows' docblock, no new
  copy, per Cameron's "Undated" ruling) and fixed at `dab99730`
  (`guard-review-r2-adjudications.md`). The review stops here: round 2 changed
  one decision (future-dated tours), and its fix is a single filter pinned by
  tests, not a new surface.

## Issues on the branch (10 filed: 8 open, 2 resolved)

Open: `extraction-prompt-read-staff-notes`, `staff-notes-on-landlord-partner-files`,
`tours-scheduled-range-query-unpaginated`, `past-tab-no-show-rows-need-an-exit`
(asked Sam), `tour-conversion-pending-placeholder-view-link`,
`perf-pages-tours-past-surface`, `tours-patch-status-precondition`,
`contact-patch-fans-out-on-every-field`. Resolved here:
`staff-notes-stale-page-overwrite`, `past-tab-timeless-toured-tours`. Evidence
appended to `group-reply-live-rollup-full-suite-flake`.

## Incidents

- The first orchestrator died at 03:36Z on the usage limit (planner side);
  the 1:28am timer fired, a fresh orchestrator resumed from the ledger with
  nothing redone. Recovery tally 0 of 2.
- While clearing my stale transcript mirror at 01:29 I matched on the script
  name and stopped every `transcript-tail` process on the box, including the
  voicemail-greeting mission's live.log mirror. Its build was unaffected.
- This morning a copy edit to the Staff notes card landed while a full e2e
  was running; the harness serves source live, so that run tested two trees
  and was discarded (one spec expected the old copy). Re-run on a quiet tree.
  Both lessons are in memory.
