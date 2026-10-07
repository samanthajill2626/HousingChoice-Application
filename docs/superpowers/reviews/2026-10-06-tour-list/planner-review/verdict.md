# Verdict - feat/tour-list (Sam #18, final part: the Tours page All tab)

Planner: the feature-mission planner session, 2026-10-07.

**MERGE-READY @f177e538 on `feat/tour-list` - UNMERGED (human gate).** The
branch is 0 behind main (a5eabcb3; main synced once, at acb2f832, with zero
conflicts). Code-final commit 27006c28; the two commits after it are
records. No infra and no post-merge operation: no new index, Terraform,
migration, secret or switch. It rides the next deploy, which also ships #1
(the properties available view) and the auto-close backlog run - Cameron's
call.

## Gates on the final commit f177e538 (the planner's own run)

Run bare from `W:\tmp\tour-list` by a detached script, each exit code
captured on the line after its command, verdicts read from the logs
(`.superpowers/sdd/planner-gates-final3/`):

1. `npm run typecheck` - exit 0.
2. `npm test` - exit 0: app 410 files / 8370 passed + 1 skipped (the
   by-design "built dashboard identity tags" diagnostic), dashboard 220 /
   3912, e2e workspace 22 / 503, fake-twilio 34 / 275, fake-twilio-web
   13 / 111; zero `[dynamoAdmin]` lines.
3. `npm run smoke` - exit 0.
4. `npm run e2e` (under `timeout 2700`) - exit 0: "315 passed (22.9m)"; results.json
   expected 315, unexpected 0, flaky 0, skipped 0; the lane stopped clean.
5. `npx eslint` over the branch's 54 lintable files - exit 1 as expected;
   13 rows on the branch = 13 rows on the same paths at the merge base
   (11 errors, 2 warnings, all pre-existing), ZERO new. Rows are keyed on
   the message's first line: the pre-existing `react-hooks/purity` message
   embeds a code frame with line numbers.

The same battery was green on every earlier review head: 1b896aa4 (the
orchestrator's handback; e2e 315 passed), 7267b3be (fix wave 1; 315) and
2243d9ef (fix wave 2; 315).

## Spec conformance (161 items, independent reviewer, three rounds)

145 CONFORMS, 16 DEVIATES-RULED, 0 DEVIATES-UNRULED, 0 PARTIAL, 0 MISSING.
Full per-item table: `spec-conformance.md` (round 1), with the changed rows
in `spec-conformance-r2.md` section 6 and `spec-conformance-r3.md` section 6.

| Spec area | Result |
|---|---|
| Work map S1-S14 | all shipped; recorded rulings A-1 (method placement), A-2/A-3 (fake landing, tie guard), A-5 (log keys), D-1, D-2, D-4/D-6/D-9, D-5, D-7, E-1/E-4/E-6 |
| Decisions D1-D10 | conform; D-1 extends D8 to the property page's tour sort |
| Planner calls P1-P15 | conform; D-5 and E-1 recorded |
| Section 3 constraints | conform |
| 4.1 tabs and routes, 4.2 loading split | conform |
| 4.3 filter bar | conforms; D-4 (480 px rule as a container query) |
| 4.4 rows | conform |
| 4.5 paging, count line, loaders, focus | conforms, as amended in review (R2-1, R3-1: keyboard focus; R2-2: the newer copy wins de-duplication); D-6, D-9 recorded |
| 4.7 URL, 4.8 back arrow, 4.9 return restore | conform |
| 4.10 / 4.11 | conform; the hook's input shape recorded (plan 9.1/11.1) |
| 5 server endpoint | conforms; A-7 (6 Queries per request, spec 5.4 amended), AD-1 (spec 5.5 amended), A-5 |
| 6 search | conforms; D-7 (walk cap per walk) |
| 7 range read and Today | conform (`queryLimit`, spec amended) |
| 8 invariants and labels | conform; E-1 |
| 9 tests | every rule has a test that can fail |

## How it was checked

- Design: spec review 4 rounds (44 findings), plan review 2 rounds (34
  findings), both closed; Cameron approved the spec.
- Build (orchestrator, 6.5 h, zero recoveries): its own review 3 rounds and
  3 fix waves, self-QA of 12 measured scenarios.
- Planner review: own gates on every head; a live check on a full-profile
  lane (17/17 tours listed, equal to the union of the per-status reads; the
  Needs booking chip; Past; the back arrow returning focus to the opened
  row; the Active tab intact; the wording); two independent reviewers
  (spec conformance, and a plan-blind adversarial pass) for three rounds,
  with three fix waves (records: `adjudications.md`, `fix-wave*.md`).
  Findings: round 1, 7 LOW + 1 ruling; round 2, 1 MEDIUM (every action
  button dropped keyboard focus - found by both reviewers) + 8 LOW; round 3,
  1 LOW (the focus fallback jumped to the top - found by both). All fixed,
  filed or rejected with reasons; no rejection is contested.

## Rulings to confirm (each reversible in a line or two)

- A-7: 6 Queries per request (one per phase), so a small list completes in
  one request - 5 left a phantom Load more over every small table.
- D-1: on the property page's Tours card, only a request sorts first; any
  other undated tour reads "Undated" and sorts last.
- D-5: while on All, the All tab's link carries the current filters (a
  Ctrl/Cmd-click opens the same filtered list in a new tab).
- D-7: the 50-request search-walk cap counts per search, not per list.
- Spec 4.5 (review rounds 2-3): Load more / Keep checking / Retry stay in
  place, busy, while the user's own request runs, and focus then moves to
  the first new row (else the last visible row) without scrolling.

## Issues

- RESOLVED: `tours-scheduled-range-query-unpaginated`, `undated-tour-wording`.
- WIDENED: `perf-pages-tours-past-surface` (now `/tours/past` and `/tours/all`).
- FILED (all low): `tours-closed-tab-loads-every-tour`,
  `tours-tabs-load-every-contact-for-names`, `tours-all-server-side-search`
  (with the at-scale costs: the re-walk on every return to a searched list,
  per-row formatting), `tours-all-live-updates`,
  `tours-date-range-reads-unbounded-span` (availability at scale),
  `error-handler-logs-router-relative-path`,
  `harness-date-range-fake-ignores-sched-partition`,
  `tour-list-restore-anchor-trackpad-swipe`,
  `tour-list-date-inputs-half-typed-year` (confirm first),
  `units-contacts-batchget-walk-duplicated` (debt).
- Still open (spec 10): `tour-no-show-without-date`.

## For the owner

- Local dev data seeded before this branch can hold dated seed tours without
  the date-index partition; such a tour is missing from the All tab (and from
  Today and the Active and Past tabs) until the local data is reseeded. No
  deployed data is affected: every create stamps the partition.
- Optional checks: AD-4 (a crafted oversized cursor key against hosted dev -
  the route already refuses it before DynamoDB); AD-5 (a macOS trackpad
  swipe-back and the return anchor - issue filed with the trace to take).
- Minor UX notes, spec-consistent: during the 300 ms search debounce an
  incomplete list briefly reads "N matches so far - not the whole list"
  before "Searching..."; a hidden Needs booking selection survives When
  changes but drops when another chip is toggled under a dated When.

## Merge (Cameron)

From the main checkout - the house's no-fast-forward merge:

    git -C "W:\AI Projects\Housing Choice\HC Application" merge --no-ff feat/tour-list

The worktree `W:\tmp\tour-list` and the branch stay until an explicit
cleanup go.

## Tracker #18 note (neutral third person)

The Tours page now has an All tab, listed first, that shows every tour -
upcoming and past - filtered and paged by the server (When, status chips,
tour type, a tenant or property search and a sort), with Load more past 50
rows and a return that puts the staff member back on the row they opened;
the Active tab still opens by default. Unbooked requests are listed by
pressing the Needs booking chip under Any time, and a tour without a date
now reads "Needs booking" (a request) or "Undated" (any other) everywhere.
It goes live with the next deploy.
