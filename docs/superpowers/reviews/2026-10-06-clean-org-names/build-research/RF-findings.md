# RF - build research findings (S14 e2e, S16 docs)

- Reader: RF
- Plan ranges: S14 e2e (plan lines 26012-28046), S16 docs (plan lines
  29737-30220); read with plan sections 0-3, section 12, S12 (15378-15905),
  S13 (15906-16211) and, to verify the S14 selector contract, S11 Tasks 11.5,
  11.6, 11.7, 11.8, 11.9, 11.11, 11.12, 11.13, 11.14, 11.15, 11.16, 11.17,
  11.18 as coded in the plan. Base tree = branch head bef84c54 (source equals
  main @d839494a; main has since gained 13b64f60 and a5eabcb3, see note N3).
- What was checked:
  1. ANCHORS - every quoted anchor in Tasks 14.1-14.8 and 16.1-16.5 against
     the base tree (line, exact bytes, uniqueness in its file), and every
     MISSING / MULTI-IN-FILE / SEVERAL-FILES row of `anchor-check.txt` for
     14.x and 16.x.
  2. SYMBOLS - every e2e import and helper (`@playwright/test` types,
     `fixtures/extraction.ts`, `support/today.ts`, `scenarios/steps.ts`
     `escapeRegExp`, `app/src/lib/orgNames.ts` purity), API routes and
     response shapes (`/api/contacts` POST/PATCH/DELETE, `/api/units`,
     `/api/units/:id/activity`, `/api/contacts/:id/suggestions`,
     `/api/ai-runs`), dev-login, baseURL + Vite `/__dev` proxy, e2e tsconfig
     (strict + noUncheckedIndexedAccess) and the root ESLint config.
  3. CONTRACTS - the S14 selector contract (P1-P6, N1-N4, S1-S8, L1-L6,
     A1-A2) against S11's plan code: every accessible name, role, dialog
     title, button label, region, listbox portal and close-on-pick behavior
     matches. The orgFixture wire shapes match plan 3.6 / 3.12 and S13's
     seam (body, errors, relative path).
  4. FALLOUT - full sweep of `e2e/` (specs, steps, fixtures, support,
     performance) for the six seed slugs, every free-text housing authority /
     agency / accepted_authorities / audience_filter write, every
     `getByLabel('Housing authority...')`, facet and summary pins, lean-world
     reads, Settings-tab pins, missed-call / Templates-hint pins and
     extraction markers. Result: the plan's S14 file list is COMPLETE. The 17
     specs left on `accepted_authorities: ['atlanta_housing']` were each read:
     none reads the value back, none asserts `Accepts:`, and the slug resolves
     through the starting-list spelling `Atlanta Housing` (plan :1403).
  5. TDD VALIDITY - RED reasons for Tasks 14.1-14.3 (verified line by line),
     PIN-only status of 14.4-14.7, GREEN counts (6+2+7, 8+1, 23+1+3, 4/6/8/11).
  6. SPEC CONFORMANCE in passing (D3-D13, section 7, section 12).
- Counts: BLOCKER 0, MAJOR 0, MINOR 7.

Check results in one line each:
- Anchors: clean. All 14.x/16.x anchors exist exactly once in the named file
  at the cited lines. The 7 MISSING rows (14.5 x3, 14.6 x2, 14.7 x2) are the
  byte-exact text of the earlier org-lists.spec.ts tasks (checked line by
  line, indentation included). MULTI-IN-FILE (14.1 sending-unit `:66`) is x1
  in the named file; the other hits are tenant-onboarding (handled by
  `replace_all`) and app files. SEVERAL-FILES rows all name their target.
  Task 14.8 (a) and Step 2 anchors are consumed by S11 Task 11.12 (c) and S13
  first; the plan's skip conditions (`grep agency_not_authority`,
  `grep org-fixture`) correctly skip them.
- Symbols: clean (see N1 for the verified facts implementers may want).
- Contracts: clean - S11's plan code matches every S14 contract row; no
  rename needed in `ORG_PICKER` or `UI`.
- Fallout: clean for S14 (no unlisted e2e file breaks). One S16 doc gap (RF-5).
- TDD validity: clean.
- Spec conformance: clean.

## Findings

### RF-1 | Task 16.3, plan lines 30038-30041 | MINOR
Evidence: the new Progress paragraph says "`TOMBSTONED_FIELDS` in
`app/src/lib/unitFields.ts` and the `sawTombstone` no-op path in
`app/src/routes/units.ts`". `sawTombstone` is in `app/src/lib/unitFields.ts`
(:149, :153, :214; `TOMBSTONED_FIELDS` at :123), not in the route; the route's
part is the retired-fields-only no-op return of the unit PATCH,
`app/src/routes/units.ts:1327-1344` (`res.json({ unit: existing })`). (The
issue's original step 4 text has the same slip; the plan copies it.)
Correction: write "`TOMBSTONED_FIELDS` and `sawTombstone` in
`app/src/lib/unitFields.ts`, and the retired-fields-only no-op return of the
unit PATCH in `app/src/routes/units.ts`".

### RF-2 | Task 16.2 second commit, plan lines 29983-29990 | MINOR
Evidence: closing `docs/issues/contact-authority-clear-empty-string-500.md`
gives no text - only "a RESOLVED block at the top" - while every other doc
edit in S16 is transcribed. The template's form is
`**Resolution (YYYY-MM-DD).**` (`docs/issues/_TEMPLATE.md`, README "Resolution"
note). The bug was fixed long before this branch: commit `d827bab6`
(2026-08-13, "fix(contacts): clearing housingAuthority REMOVEs instead of
writing """), today at `app/src/routes/contacts.ts:631-635`
(`v.length > 0 ? v : null`), pinned by `app/test/contactTriage.test.ts:470-506`.
Correction: frontmatter `status: resolved`, add `updated: <BUILD-DATE>` and
`resolved: <BUILD-DATE>`; insert above `**Problem.**`:
`**Resolution (<BUILD-DATE>).** Fixed by d827bab6 (2026-08-13): the contacts
PATCH maps a '' housing authority to null and the repo REMOVEs the attribute
(app/src/routes/contacts.ts:631-635). Pinned by
app/test/contactTriage.test.ts:470-506 and, since feat/clean-org-names, by the
"(PIN) a clear always passes" case in app/test/contactOrgNames.test.ts. The
issue stayed open only because its frontmatter was never updated.`

### RF-3 | Task 16.4, plan lines 30056-30058 | MINOR
Evidence: "`npm run issues` -> prints its summary, lists the four new ids as
open". `scripts/issues.mjs` prints only the counts line, the by-severity line
and warnings (:90-96); ids appear only in the gitignored
`docs/issues/INDEX.md` "## Open" table it writes (:72-88).
Correction: expected stdout = the summary with no warning naming any of the
four files; then `grep -n "property-authorities-from-address\|ai-extraction-fills-agency\|ai-adds-new-org-names\|reimport-reverts-unknown-triage" "W:/tmp/clean-org-names/docs/issues/INDEX.md"`
prints four rows (all above the `## Closed` heading). Never stage INDEX.md.

### RF-4 | Task 14.9 Step 1, plan lines 28018-28022 | MINOR
Evidence: the full suite runs as bare `npm run e2e` in the background with no
outer timeout. AGENTS.md ("Use a hard outer timeout for a suite that can
wedge"), and Task 17.2 gate 4 uses `timeout 2700 npm run e2e` from Git Bash
plus a tree-kill recipe. Step 2's "after an aborted run" covers only
`e2e:stop` + port check, not the launcher tree-kill.
Correction: Step 1 = `cd "W:/tmp/clean-org-names"; timeout 2700 npm run e2e`
from the Bash tool (background), and on exit 124 or any abort apply Task 17.2's
(a)-(c) verbatim (taskkill /T /F of `launcherPid` from `e2e/.artifacts/lane.json`
with `MSYS_NO_PATHCONV=1` in Bash, then `npm run e2e:stop`, then confirm no
listener on the lane's four ports) before any re-run.

### RF-5 | S16 (gap - no task), plan lines 29737-30220 | MINOR
Evidence: `docs/issues/unit-accepted-authorities-edge-cases.md` (status open)
case 2 - "`['']` passes validation and renders a bare public Accepts:" - is
fixed for every new write by this branch: D5's `checkListWrite` drops blank
members (plan Task 1.3, :1104) and S6 stores the checked value on the unit
POST and PATCH (plan Task 6.2 :9364 and Task 6.3 :9646). The
issue is not touched by S16 (case 1, the re-import flatten, still stands: S8
keeps SET for import-owned units).
Correction: add an S16 step (own commit) inserting above its `**Problem.**`:
`**Update (<BUILD-DATE>).** Case 2 is closed for every new write by
feat/clean-org-names: the unit POST and PATCH run the organization-list check
(spec D5), which drops blank members, so [''] is stored as []. A value already
stored stays until it is edited. Case 1 stands (the importer still SETs the
list on import-owned units).` plus `updated: <BUILD-DATE>` (status stays open).
Alternatively name it in the handback; do not silently leave it.

### RF-6 | Task 16.1, plan lines 29797-29801 and 29894-29895 | MINOR
Evidence: (a) the rewritten **housing authority** entry says "every writer
checks a changed value against the list (... anything else is refused with
422 `org_not_on_list`)", but two writers never answer 422: the AI apply layer
demotes unknown text to a staff suggestion and drops agency names (plan 3.10,
S7 Task 7.5), and the importer leaves unknown values unwritten and reports
them (plan section 1, "importer"). (b) the updated **accepted authorities**
entry keeps "Staff and landlords see ONE \"Housing authorities\"
input/row" two sentences after describing the multi-picker.
Correction: (a) "... every API writer refuses anything else with 422
`org_not_on_list`; the AI turns it into a staff suggestion and the importer
reports it". (b) "Staff and landlords see ONE \"Housing authorities\"
picker/row".

### RF-7 | Task 14.8 Step 1 (f), plan line 27970 | MINOR
Evidence: the new selectors.md Settings row says "`exact` keeps `Housing
authorities` off the tab's own title". The tab is role `tab`, not a region,
and `SettingsPage.tsx:23` renders an unlabelled `<section>` (no region role),
so no region carries "Housing authorities & agencies"; the stated reason is
wrong (the advice to pass `exact: true` is still right).
Correction: replace that clause with "`exact` because `getByRole` name
matching is substring by default".

## Notes (no action required)

- N1 Verified facts the S14 code relies on (all hold): `workers: 1`,
  `fullyParallel: false`, `retries: 0`, `use.baseURL` = lane dashboard, expect
  timeout 15 s, test timeout 60 s (`e2e/playwright.config.ts`); Vite proxies
  `/__dev` (`dashboard/vite.config.ts:114`); contacts POST ignores
  `housingAuthority` (`parseCreateBody`), DELETE is a role-free soft delete
  that only sets `deleted_at` (`app/src/repos/contactsRepo.ts:1259-1273`);
  `requireRole` answers 403 `forbidden` (`app/src/middleware/auth.ts:241-243`);
  audience resolution excludes only opted-out / unreachable / phoneless, not
  no-consent (`app/src/services/audienceResolution.ts:150-152`), so "Reaches 2
  tenants" holds; the unit activity route projects every audit type with
  string `from`/`to` (`app/src/routes/units.ts:191-221`); the chip text is
  `AI heard "<suggestedValue>"` (`dashboard/src/routes/contact/SuggestionChip.tsx:43`);
  `app/src/lib/orgNames.ts` stays import-free through S3 (plan :642-703,
  :1022, :1167, :2654), so the e2e value import is safe.
- N2 Starting-list spellings S14 queries depend on (plan :1399-1462): `Atlanta
  Housing` (so `atlanta_housing` resolves), `HADC` only on DeKalb, `AHA` on
  Atlanta and Augusta, `Step Up` an agency. OrgPicker never word-prefix
  matches (exact name, exact spelling, name prefix, name substring, spelling
  substring; `MAX_SHOWN` 10 - plan :18614-18638); every S14 query is a full
  name, a name prefix or an exact spelling, so the contract row P2 wording
  "word-prefix" is harmless.
- N3 `main` gained `e2e/tests/dashboard-next/stream-hidden-label-overflow.spec.ts`
  (13b64f60) since the branch base. It reseeds `full` before each test and
  lean after all, touches no organization value, and sorts after
  `org-lists.spec.ts`; nothing in S14 depends on it. Task 14.9's "main's count
  plus 11" holds after the S17 sync.
- N4 Settings-tab pins in `e2e/tests/dashboard-next/settings.spec.ts:38-39,
  217-221` use substring tab names that the new "Housing authorities &
  agencies" tab does not contain; `settings.spec.ts:72`'s "saved" pin still
  matches S9's new Templates hint (plan S9, the hint keeps "agency saved").
