# Handback - feat/properties-available-view (tracker #1)

Status: MERGE-READY, UNMERGED (human gate). Branch `feat/properties-available-view`,
worktree `W:\tmp\properties-available-view`, 17 commits on main @ae04122d (main has not
moved; no sync was needed). Final commit c9eba3cd. Small-fix lane, built by the planner
session overnight 2026-10-01/02; design note
`docs/superpowers/specs/2026-10-01-properties-available-view-design.md`.

## What it does

- The Properties page's Active tab opens on Available; the Deleted tab keeps every status.
- A "By housing authority" table leads the Active tab: an All row (each property once),
  one row per authority (stored spelling, a property counted under every authority it
  accepts), and a No authority recorded row; columns Available and Coming soon (Setup).
  Every non-zero count opens exactly the properties it counted (Back undoes it). Under a
  voucher filter the counts follow it, and a line says how many properties are not counted
  because they record no voucher size.
- Voucher-size chips (Studio .. 4+ BR, Not recorded) read `voucher_size_accepted` as one
  number or a list (#12), never beds.
- Filters persist in the URL: Back from a property restores the view, switching tabs
  starts clean, and a selection no chip shows never filters (closes
  `properties-authority-filter-invisible-lock`).
- Empty default view: "No available properties right now." with Show all statuses.
- `humanizeAuthority` is deleted; chips show stored spellings.

## Design items

Decisions D1-D4 and calls C1-C8 delivered; D5 (no overnight DynamoDB restart) was a
process rule and was honored - the containers exited on their own at 02:00 UTC and were
restarted only on Cameron's explicit go at about 03:15 UTC. The conformance reviewer's
final count was 61/64 items against the re-amended note; the three gaps were D5 (process)
and two round-3 precision items, both fixed in 669d8199/c9eba3cd. Deviations from the
first note, all adopted into the amended note: filter state is local urgent state with
the URL as persistence (react-router 7 applies URL changes in transitions); the search
saves on blur or row-open, never per keystroke (WebKit's history-call cap); summary
counts push; own writes are stamped in history state; unit-based code names.

## Gates (bare, final commit c9eba3cd, quiet tree before and after)

```
TYPECHECK_EXIT=0
TEST_EXIT=0    app 399 files 8109 passed 1 skipped; dashboard 213/3676; e2e 22/503;
               fake-twilio 34/275; fake-twilio-web 13/111; zero [dynamoAdmin] lines
SMOKE_EXIT=0   1544 import specifier(s) across 268 emitted file(s) resolve
E2E_EXIT=0     306 passed (17.5m)
LINT_EXIT=0    13 branch files
```

The round-2 commit e9b9e421 also ran the full e2e green (306 passed, 17.6m). Live
self-QA: `self-qa.md` (PASS on every check; screenshots under `.playwright-mcp/`).

## Review

Two reviewers (opus), continued across three rounds: an adversarial plan-blind
reviewer and a spec-conformance reviewer. Round 1: 19 findings, 5 MEDIUM (A1 the
WebKit history-call cap, A2 silent voucher exclusion, A3 voucher readers, A4 + C1 the
perf contracts) and 14 LOW - 14 accepted, 3 accepted in part, 1 deferred, 1 rejected. Round 2: 14 LOW - 12 accepted, 1 in part,
1 deferred. Round 3 (terminal, no decision changed): 7 LOW, all accepted. The adversarial
reviewer conceded A2, A13 and A2-4; the planner conceded A6. Records:
`code-review-*-r1..r3.md`, `review-adjudications-r1..r3.md`. Every new protection was
mutation-checked (the matching test fails with the protection removed).

## Filed / updated issues

- Resolved: `properties-authority-filter-invisible-lock`.
- New: `unit-voucher-size-readers-diverge` (Matching pre-fill and flyer read beds; the
  property page and edit form read one number - for #12/#6);
  `tenant-filters-clear-focus-contrast` (the same two a11y defects on the Tenants list).
- Progress: `retire-humanize-authority` (step 2 done; seeds and tombstones go with #2);
  `housing-authority-free-text-drift` (helper gone).

## Owed after merge

- Nothing to run for the merge itself: dashboard-only, no API, data, seed or infra change.
- Deploy is Cameron's call. `/listings` page-performance numbers are not comparable with
  pre-merge baselines (the default view renders fewer rows).

## Known limits (documented)

- Search text typed and then abandoned by a browser Back/Forward is not saved.
- Demo/e2e worlds show raw seed slugs until #2; long slugs break mid-word at 360px.
- Most real properties likely record no voucher size yet; the page says so under a
  voucher filter.

## Merge (PowerShell, from anywhere)

```
git -C "W:\AI Projects\Housing Choice\HC Application" merge --no-ff feat/properties-available-view
```
