# Fix wave 2 report - feat/primary-contact-integrity

Kind: FIX-WAVE REPORT (mission record). Branch
`feat/primary-contact-integrity`, worktree `W:\tmp\primary-contact-integrity`,
base b5d25c31 (the R2 re-review records commit). Fix list: the orchestrator's
fix-wave-2 brief over `code-review/R2-rereview.md` - R2-2 (the one behavior
change), R2-1 and R2-3 (docs and comments only), and the notes R2-N1, R2-N2,
R2-N3 and R2-N8. Implementer: Claude Opus 5.5, alone in the worktree. Date:
2026-10-13.

Never run: `npm test` (full), `npm run e2e`, `npm run e2e:session`,
`e2e:restart` / `e2e:reseed` / `e2e:stop`, `npm run dev`, anything on lane 13
(app :10301, dashboard :10311) or the human's live ports. DynamoDB Local
(shared container) was only used by the two app test files, never started,
stopped or restarted. `env | grep '^AWS_'` printed nothing (grep exit 1)
before every vitest run. No background command was left running. The only
behavior change is item 1 (R2-2); every app change is a comment or a test
title.

Live-lane note: lane 13's Vite serves the dashboard source live, so the
PlacementDetail.tsx fix hot-reloaded into the orchestrator's self-QA session
(the brief allows it). The app and worker run under the NON-watch launcher
(`scripts/e2e-session.mjs`), so the two app comment edits restarted nothing.

## 1. Commits

| item | commit | subject |
|---|---|---|
| 1 (R2-2) | 482f9cf4 | fix(dashboard): placement final-rent save keeps the loaded roster rows and block (code review R2-2) |
| 2 + 3 (R2-1, R2-3) | 613edf85 | docs: name the classification path to the 470 Bolton shape and retire the "UI cannot reach it" claims (code review R2-1, R2-3) |
| 4 (notes) | 4cff3d62 | docs(issues,comments): code review R2 notes - refresh issue citations, fix two issue misstatements, scope the restore comment to both branches, relabel the (h) tests |
| record | (this commit) | this report |

Every commit: bare `git status` read first, `MERGE_HEAD` absent (`test -e
"$(git rev-parse --git-path MERGE_HEAD)"` -> absent), explicit paths only,
the `Co-Authored-By: Claude Opus 5.5` trailer. Nothing under `.superpowers/`,
no `docs/issues/INDEX.md` was committed.

## 2. Item by item (line numbers at the tip)

### Item 1 - R2-2: the placement page's final-rent save re-offered deleted contacts

- FIX `dashboard/src/routes/placements/PlacementDetail.tsx:164-184`
  (`setUnit`). It now applies the unit PATCH answer WITHOUT its stored
  `contacts` (and without any `propertyContact`) and keeps the previous
  unit's `contacts` and `propertyContact` when the page holds them - spec
  7.5's "unit replacements that do not change the roster keep those rows and
  that block", mirroring the property page (`useListing`, whose `roster` and
  `propertyContact` are fixed at load and never touched by `setUnit`). The
  only caller is `onRecordFinalRent` (`:669-671`), whose
  `PATCH { final_rent }` never changes the roster. Every other unit field
  comes from the answer (it is authoritative for the stored fields).
- Design choice: when the load-time GET failed (`prev.unit === null`), the
  merged unit carries NO rows - a PATCH answer is never a roster source, so
  the suggestions stay as they were before the save (the missing tenant
  only) instead of offering stored rows nobody has checked for `deleted`.
  The reviewer's sketch (`prev.unit?.contacts ?? next.contacts`) would have
  fallen back to the unflagged rows there.
- Side effect of the same root cause, also fixed: the stored rows carry no
  read-time names, so before the fix the suggestions also degraded to raw
  contact ids (see the RED lines below).
- TEST `dashboard/src/routes/placements/PlacementDetail.test.tsx:1012-1066`,
  describe "PlacementDetail - the People card after a final-rent save
  (primary-contact-integrity spec 7.5)", "a deleted row is still not offered
  after the final-rent PATCH answers the stored roster": the GET answers an
  enriched roster (`l1` landlord, `pm-gone` flagged primary with
  `deleted: true`, `pm2` live PM) plus a `propertyContact` block; the PATCH
  answers the stored rows (no names, no flags, no block). Edit people ->
  exactly `Also on this property: Dana Reyes - PM`; record the final rent;
  wait for the facts card's `$1,875/mo` (the answer applied); the
  suggestions are still exactly that one line and there is no
  `Add (Gina Gone|pm-gone) to this placement` button.
- RED (`.superpowers/sdd/fixwave2-item1-red.log`, EXIT:1, `Tests 1 failed |
  45 skipped (46)`): the pre-save assertion passed and the post-save one
  failed with Received `"Also on this property: pm-gone - PM - primary
  contact"`, `"Also on this property: pm2 - PM"` - the deleted primary
  offered and labeled "primary contact", names lost.
- GREEN (`fixwave2-item1-green.log`, EXIT:0, `Tests 1 passed | 45 skipped
  (46)`); whole file `Tests 46 passed (46)` (`fixwave2-item1-file.log`);
  dashboard `tsc` EXIT:0 (`fixwave2-item1-dash-tsc.log`); eslint on both
  files EXIT:0 (`fixwave2-item1-eslint.log`).
- TourDetail: the pattern is ABSENT. `useTour.ts` exposes no `setUnit`;
  the unit enters state only through `load()` (the GET, on mount and on a
  `tour.updated` refetch), and `TourDetail.tsx` never calls `updateUnit`.
  The only other `updateUnit` caller in the dashboard is
  `ListingEditForm.tsx:247`, which feeds `useListing.setUnit` (already
  keeps the roster). No change there.

### Item 2 - R2-1 (docs only): the classification path to the 470 Bolton shape

No route changed. Recorded as a KNOWN GAP in three places:

- Spec `docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md:391-399`
  (section 4.7, the known-gaps bullet): a contact TYPE change runs no
  roster write (4.4), so a contact that joined an ownerless, no-primary
  property non-primary while not eligible (a tenant, an unknown) and is
  then classified as a landlord or property manager is left eligible and
  non-primary with nobody primary; the property box offers the fix (7.4)
  and the script (section 8) repairs it whenever it runs.
- `documentation/GLOSSARY.md:269-276` (primary contact): the zero-primary
  list gains "when such a contact is classified as a landlord or property
  manager on its contact page AFTER it joined (a type change is not a
  contact-list write, so it promotes nobody - the 470 Bolton shape again)".
- `RUNBOOK.md:500` (Primary contacts backfill, intro paragraph, right after
  "after the deploy one pass catches them all"): one sentence - that shape
  can still recur after the deploy, so the script (idempotent, every write
  conditional) is also safe to re-run as a periodic sweep for it.

### Item 3 - R2-3 (docs/comments only): the "UI cannot reach it" claims

One wording everywhere: "The UI can reach a property with no primary
contact (Restore without a landlord, then add only contacts not typed
landlord), and can even recreate the imported shape - an eligible contact
left non-primary - by classifying one of those contacts as a property
manager after seating it (a type change promotes nobody, spec 4.4). The dev
seam exists so a spec builds that shape in one call without the detour."
Where a place also explained why direct adds cannot build the shape (a new
property needs a landlord; an add on an ownerless property makes an
eligible contact primary at once), that true clause stays, now as the
reason for the detour.

- `e2e/README.md:746-753` (Dev-only surface, the seam bullet).
- `e2e/support/selectors.md:88` (the no-primary box row; fix wave 1's
  "what it cannot build" clause replaced) and `:117` (the Dev seam row's
  "The only way to reach the state").
- `app/src/routes/dev.ts:1269-1280` (the seam's comment; the paragraph's
  last lines re-wrapped).
- `e2e/fixtures/primaryContact.ts:7-14` (header).
- `e2e/tests/dashboard-next/primary-contact-integrity.spec.ts:7-14`
  (header).
- SEVENTH place, found by a repo-wide sweep and fixed with the same
  wording (item 3 says "every place"):
  `app/test/devZeroPrimaryFixture.test.ts:4-12` (header: "because no UI
  path and no lean seed unit reaches that state").
- NOT changed: spec section 10's e2e paragraph (`:823`, "the zero-primary
  state cannot be reached through the UI") - approved text, left for
  Cameron as R2-3 recommends; and the plan
  (`docs/superpowers/plans/2026-10-13-primary-contact-integrity.md`) and the
  review records, which quote the old sentences as history.

### Item 4 - the notes

- (a) R2-N1: both new issue files cite the current tree.
  `docs/issues/primary-handoff-no-flag-landlord-delete-gap.md`:
  `propertyContact.ts:149-156` -> `151-158` (frontmatter and `:24`).
  `docs/issues/roster-liveness-read-eventual-consistency.md`:
  `propertyContact.ts:84-102` -> `86-104` (frontmatter and `:14`). Item
  4(d) adds one comment line in `unitsRepo.ts` above three cited spots, so
  those were refreshed in the same commit: `unitsRepo.ts:1738-1740` ->
  `1739-1741` (no-flag issue frontmatter, `:19`, `:87`), `:1663` -> `:1664`
  and `:1744` -> `:1745` (consistency issue frontmatter, `:20`, `:22`).
  Every other citation in both files re-checked at the tip and unchanged:
  `primaryHandoff.ts:86-89`, `:100-105`, `:138-141`;
  `contacts.ts:2275-2279`; `ContactDetail.tsx:140-141`;
  `contactsRepo.ts:978-980`, `:1288-1290`; `units.ts:1408`, `:597`, `:546`;
  `unitsRepo.ts:865-868`, `:1375`; `assign-primary-contacts.ts:314`.
- (b) R2-N2(a), no-flag issue `:32-35`: a landlord-only unit is a Scan
  TARGET, but its derived row is its only row - `chooseHeir` finds no heir
  and `handOffPrimaryFrom` answers `unchanged`, so nothing moves ("is
  handed off" removed).
- (c) R2-N2(b), consistency issue `:45-48`: "which spec 4.4 forbids" ->
  "spec 4.2's accepted-race class (spec 4.4's refusal is the 409 on an
  explicit write, which an automatic pick never meets)".
- (d) R2-N3, `app/src/repos/unitsRepo.ts:1615-1623` (comment only, +1
  line): a deleted row flagged elsewhere "stays flagged (spec 4.7) until
  the script, a Make primary or that row's removal - or, after a clear (4.4
  needs no live landlord of record), the next eligible write" - true on
  both restore branches. The scalar sentence is kept.
- (e) R2-N8, `app/test/unitsApiRosterAutoPrimary.test.ts:195` "(h)" ->
  "(h2)" and `:223` "(h)" -> "(h3)" (titles only; they match their `u-h2` /
  `u-h3` fixtures; `:182` stays "(h)", and both older tests are on `main`).
  No non-record file quotes the old titles.
- `npm run issues`: EXIT:0, `410 open, 207 closed, 617 total` (INDEX is
  gitignored, not committed; `fixwave2-issues.log`).

## 3. Gates (bare, each redirected to its own log under `.superpowers/sdd/`)

| command | log | result |
|---|---|---|
| `npm run typecheck` (root) | `fixwave2-typecheck.log` | EXIT:0, 0 `error TS`; root + app, dashboard, e2e, fake-twilio, fake-twilio-web |
| `cd dashboard && npx vitest run` PlacementDetail.test.tsx, TourDetail.test.tsx, PeopleCard.test.tsx, rosterPeople.test.ts | `fixwave2-dashboard-vitest.log` | EXIT:0, 4 files, 240/240 (46 + 131 + 58 + 5) |
| `cd app && npx vitest run` test/devZeroPrimaryFixture.test.ts test/unitsApiRosterAutoPrimary.test.ts | `fixwave2-app-vitest.log` | EXIT:0, 2 files, 33/33 (13 + 20); no `[dynamoAdmin]` line |
| `npx eslint` on the 8 touched `.ts`/`.tsx` (PlacementDetail.tsx, PlacementDetail.test.tsx, dev.ts, unitsRepo.ts, devZeroPrimaryFixture.test.ts, unitsApiRosterAutoPrimary.test.ts, fixtures/primaryContact.ts, primary-contact-integrity.spec.ts) | `fixwave2-eslint.log` | EXIT:0, no output. The known pre-existing `TourDetail.tsx:342:85 react-hooks/purity` did not appear: TourDetail.tsx was not touched, so not linted |
| `npm run test -w @housingchoice/e2e` | `fixwave2-e2e-unit.log` | EXIT:0, 22 files, 503/503 |
| added lines `b5d25c31..HEAD` vs non-ASCII; CRLF in touched files | - | 0 non-ASCII; no CR |

The edited Playwright spec (`primary-contact-integrity.spec.ts`, header
comment only) was typechecked and linted, not run (no e2e in this wave).

## 4. Noticed, not blocking

- Spec section 10 (`:823`) still says the zero-primary state cannot be
  reached through the UI - approved text, for Cameron (R2-3). Spec 4.7's
  second bullet has the same scope imprecision R2-N3 found in the comment:
  after "a swap of a landlord who is not the flagged primary", the live
  landlord of record rules out 4.4, so a deleted flagged row there stays
  until the script, a Make primary or its removal, not "the next eligible
  write". Not on this wave's list; left as approved text.
- R2-1's option (c) - should a classification that makes a seated contact
  eligible run auto-primary on the properties it sits on - is still a
  product call for Cameron; this wave only documented the gap.
- The fix adds 17 lines at `PlacementDetail.tsx:164`, so line citations
  below it drift further: spec 7.5 / 9.2's `PlacementDetail.tsx:185`,
  `:260-274`, `:185-237,287-296` (already one line off before this wave)
  and older issue files. Not updated (approximate by nature).
- `roster-liveness-read-eventual-consistency.md` shape 1 still says "the
  only later sweep is the one-time backfill" - still literally true, and
  the RUNBOOK now says that script is safe to re-run as a periodic sweep.
- Untouched by design (not in this wave's list): R2-N4 (Check again late
  answer after a close/reopen), R2-N5 (an emptied draft is sticky), R2-N6
  (two flagged rows, legacy), R2-N7 (the stale-scalar sentence in
  `unit-primary-contact-unchecked`), R2-N9 (D-8's adjudication wording).
