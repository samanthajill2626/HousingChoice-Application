# Build worklist - feat/clean-org-names (branch A)

- Orchestrator: build-orchestrator (Opus 5.5), 2026-10-06, AUTO mode.
- Inputs: the eight research findings in this directory (RA S1-S3, RB S4-S6,
  RC S7, RD S8-S10/S12/S13/S15, RE1 S11.1-11.10, RE2 S11.11-11.18, RF S14/S16,
  RG the invariant sweep) and the mechanical anchor check of the plan.
- Base: the branch source equals main @d839494a (docs-only commits on top), so
  the plan's quoted anchors are live text. Readers replayed every edit of
  S1-S6 and S11.1-11.10 on scratch copies: every anchor applies exactly once
  (dependent anchors match the earlier task's new text byte-for-byte), and the
  replayed end states typecheck. Totals: BLOCKER 0, MAJOR 2 (RG-1, RG-2),
  MINOR 35.
- This file is BINDING beside the plan: where an item below changes a plan
  instruction, the item wins. Everything not listed here: follow the plan.

## Orchestrator rulings on the two MAJOR findings

### RG-1 (suggestion-accept journal replay writes its stored text) - ACCEPTED RESIDUAL, no code change

The accept journal stores its built plan and `recoverAbandoned` / a takeover
replays it without rebuilding (app/src/services/suggestionResolution.ts
applyJournal; routes/suggestions.ts GET; jobs/journalSweep.ts). Spec D8
designs this: the accept `value` is "checked with D5 while the plan is built
... and stored in the replayable plan". The gap is (1) a plan built before
the deploy and replayed after it (needs a process death mid-accept or an
abandoned journal at deploy time) and (2) a plan replayed after a rename,
merge or delete. Both are rare, and the outcome - an off-list value on one
contact - is exactly what the "Not on the list" section exists to surface
and settle. A new release arm in the journal state machine (which carries a
long review history) costs more risk than the gap. Recorded as an accepted
residual race beside plan section 12's; named in the handback for Cameron's
eye. Implementers: no change to Task 7.7's recovery comments beyond what the
plan says.

### RG-2 (pre-deploy dismissals stop suppressing the full name) - FIX the suggest path in Task 7.5; writes unchanged

The dismissal fence keys tombstones on `normalizeSuggestionValue(target,
suggestedValue)` (lowercase + whitespace fold). Before the deploy a known
authority was suggested under its alias canonical spelling ("Atlanta (AHA)",
"DCA", "Fulton County", ...) or verbatim unknown text; after Task 7.5 a match
is suggested under the entry NAME, a different key, so a dismissal made
before the deploy no longer suppresses it - breaking the 2026-07-21 ruling
that a dismissed value is never re-suggested.

Amendment to Task 7.5 (S7 implementer, TDD):

- `putSuggestionSafe(deps, s, alsoDismissedAs: readonly string[] = [])` -
  inside its existing `try`, check the dismissal of the suggestion's own key
  FIRST (unchanged), then of every distinct
  `normalizeSuggestionValue(s.target, alt)` for `alt` in `alsoDismissedAs`
  whose key differs from the own key; the first hit returns
  `{ ok: false, dropReason: 'dismissed_before' }` with the same debug log.
  `s` itself is unchanged (it is passed to the repo as is).
- In the housingAuthority branch, when `resolved.status === 'match'`, keep
  the aliases `[String(coerced.value), ...resolved.entry.spellings]` and pass
  them as `alsoDismissedAs` on the suggest path's `putSuggestionSafe` call.
  Every other field passes nothing.
- The WRITE path does not change: spec D8 handles a match "exactly as a known
  authority is today", and writes never consulted dismissals (the ruling
  covers re-suggesting).
- Tests in `app/test/extractionApply.test.ts` (or the file Task 7.5 edits):
  RED - a contact holding a dismissal tombstone keyed
  `normalizeSuggestionValue('housingAuthority', 'Atlanta (AHA)')`, the model
  suggests `Atlanta Housing Authority` (op suggest): today it is suggested;
  after the fix it is dropped `dismissed_before` and no suggestion row is
  written. A second case: the tombstone is keyed on the model's own raw text
  (a spelling such as `Housing Authority of the City of Atlanta`) - dropped.
  PIN - a tombstone keyed on another entry's spelling (`DCA`) does not
  suppress an Atlanta suggestion.

## Accepted residual races (documentation; no code change)

Add to the handback's residual list (beside plan section 12's two): the S6
writers check the list then write the record in a separate step (RB-4); the
extraction run and the importer read the list once per run (RG-3); the
rewrite job's byTypeStatus walk misses a contact whose type or status changes
while the walk runs (RG-4); the suggestion-accept journal replay (RG-1). Each
leaves at most an off-list value that shows in "Not on the list".

## Per-slice corrections

### S1 (Tasks 1.1-1.5)

- RD-1: Task 1.5's test comment in `app/test/orgStartingList.test.ts` must not
  name the retired module's path (the S10 guard's module-path regex would
  flag it). Write e.g. `// The retired alias map read a bare \`clayton\` as
  Clayton County; Cameron's launch-gate ruling ...` (no
  `lib/housingAuthority.ts`).

### S2 (Tasks 2.1-2.3)

- RA-2: Task 2.2 "replace the two import lines" is TWO separate Edit calls in
  `app/test/orgListRepo.integration.test.ts`: the one-line
  `@aws-sdk/lib-dynamodb` import (plan 1921 -> 1932), and the two-line
  orgListRepo + orgFixtures imports seven lines later (plan 1925-1926 ->
  1936-1953).

### S3 (Tasks 3.1-3.10)

- RA-1: Task 3.5's case `(PIN) use whose from-text IS the name ...` (plan
  4143) cannot pass before GREEN (`records.rewrite` does not exist yet):
  expect it RED with its neighbours at the RED run, GREEN after.

### S4 + S5 (Tasks 4.1-5.3)

- RB-3: explicit staging paths. 4.1: `app/src/jobs/orgRewrite.ts`,
  `app/test/orgRewriteJob.test.ts`. 4.2: those plus
  `app/src/jobs/registerHandlers.ts`, `app/test/registerHandlers.test.ts`.
  5.1: `app/src/routes/organizations.ts`, `app/src/routes/api.ts`,
  `app/test/helpers/twilioWebhookHarness.ts`,
  `app/test/organizationsApi.test.ts`. 5.2 and 5.3:
  `app/src/routes/organizations.ts`, `app/test/organizationsApi.test.ts`.

### S6 (Tasks 6.1-6.5)

- RB-2: Task 6.1 Step 0 item 4 - the grep prints Task 5.1's `orgListRepo:
  world.orgListRepo` line, so SKIP the fallback harness edit (applying it adds
  a duplicate key, TS1117) and do not stage the harness with Task 6.1.
- RB-1: Task 6.4 RED - old_string = the four-line block at plan 9673-9678;
  new_string = the fenced block at plan 9683-9789 VERBATIM (it already starts
  with the three kept lines and ends with the final `});` - add nothing).

### S7 (Tasks 7.1-7.8)

- RG-2: the Task 7.5 amendment above.
- RC-1: Task 7.8 RED note - the two claim-race cases fail because the Task
  7.7 service ignores `value` and refuses the text 'AHA' with 422
  `org_not_on_list` before the claim (one rejects instead of resolving, the
  other with 422 instead of 409), NOT on a missing `resolutionValueKey`
  export (Task 7.6 exports it).

### S8 + S9 + S10 (Tasks 8.1-10.1)

- RD-2: S10 Task 10.1 items 3, 4 (last bullet) and 5 are already done by
  Tasks 7.4, 8.1 and 8.2: confirm with
  `git -C "W:/tmp/clean-org-names" grep -n housingAuthorityFor -- app/test/importApply.integration.test.ts`
  (no output) and move on; do not hunt for the old test.
- RD-1 (S10 side): if Task 1.5's comment still names the retired path, the
  guard lists `app/test/orgStartingList.test.ts` - rewrite that comment under
  item 6 and stage the file.
- RD-3 (all slices): every vitest command runs from the workspace dir -
  `cd "W:/tmp/clean-org-names/app"; npx vitest run test/<file>`; dashboard
  `cd "W:/tmp/clean-org-names/dashboard"; npx vitest run src/<path>`; repo
  commands from `cd "W:/tmp/clean-org-names"`.

### S12 + S13 (Tasks 12.1-13.1)

- RD-5: Task 12.1 also changes `// Verifies three things:` to
  `// Verifies four things:` in `app/test/seedProfile.integration.test.ts`.
- RD-6 (optional): Task 12.3 exports `buildLiveStaticItems`; reword reason 1
  of the comment at `app/test/seedUnreadFlag.test.ts:16-26` to say the builder
  is exported (for seedOrgNames.test.ts) - comment only, ASCII.

### S11 (Tasks 11.1-11.18)

- RE1-3: Task 11.8 RED (a) "Also add `within` ... Current (`:1`)" is in
  `dashboard/src/routes/listing/UnitCreateForm.test.tsx` (NOT
  ListingEditForm.test.tsx, whose `:1` is rewritten by RED (b)).
- RE1-4: in the same task, refresh the stale comment at
  `UnitCreateForm.test.tsx:74-76` to: "The housing authorities picker (spec
  2026-10-06 D6) replaces the retired single 'Housing authority' field and the
  'Accepted vouchers / programs' list (spec section 8)."
- RE1-2: Task 11.9's `AudienceFilters.tsx:31-33` is `:32-34` (text match
  governs).
- RE1-1: Task 11.10's lint expectation is wrong: expect 5 pre-existing errors,
  all present at the merge base - `useComposerDraft.ts` react-hooks/refs (at
  the `disposableRef.current =` write, `:116` at base, `:128` after this
  task) and `BroadcastComposer.tsx` react-hooks/set-state-in-effect x4
  (`setUnit(null)` and the three prefill effects). Do not touch them.
- RE1-5: in `NewOrgDialog` (Task 11.6), when the trimmed text is longer than
  120 characters, skip the `POST /check` call and render
  `Cannot add it: ${nameProblemCopy('org_name_too_long')}` with "Yes, add
  it" disabled (the D13 cap; the server stays the authority) - plus one test.
  (Today such text dead-ends on "Couldn't check the list" with a Try again
  that fails the same way.)
- RE1-6: the act() warnings from the synchronous form tests are noise - no
  action.
- RE2-2: Task 11.12 - add `overflow-wrap: anywhere;` to the `.detailHeader p`
  rule in `dashboard/src/routes/settings/aiRuns/AiRunsSection.module.css`
  (edit the unique substring `.detailHeader p { margin: var(--sp-1) 0 0;
  color: var(--c-text-muted); font-size: var(--fs-sm); }`): the 64-character
  fingerprint otherwise overflows at phone width.
- RE2-3: Tasks 11.16/11.17 - in `onRenamed` set the notice to the skipped
  spellings notice when any were skipped and to `null` otherwise; call
  `setNotice(null)` in `closeAndReload` before the reload (a stale notice
  otherwise survives later clean actions).
- RE2-1: Task 11.18 (e) - the issue doc sentence must say "while a rewrite
  runs the section re-reads `GET /api/organizations` every 2 s, then reads the
  two scans once more when it stops" (not "all three endpoints").
- RE2-4 (cosmetic): Task 11.18 - append "+ Housing authorities & agencies"
  to the test names at `settingsTabs.test.ts:42` and `SettingsPage.test.tsx:71`
  and to the header comment's everyone-visible list at
  `settingsTabs.test.ts:3-4`; leave the files' non-ASCII lines byte-identical.
- RE2-5: NOT adopted (the poll's abort-previous shape is the accepted
  `useBroadcastResults` precedent; changing a StrictMode-sensitive hook here
  costs more than it buys).

### S14 (Tasks 14.1-14.9)

- RF-7: Task 14.8 (f) selectors.md row - replace "`exact` keeps `Housing
  authorities` off the tab's own title" with "`exact` because `getByRole`
  name matching is substring by default".
- RF-4: Task 14.9's full suite is run by the ORCHESTRATOR as a checkpoint
  with Task 17.2's `timeout 2700` and abort recipe - the S14 implementer runs
  only the targeted specs.

### S15 (Tasks 15.1-15.3)

- RD-4: Task 15.2 RED "replace the import block (its first four lines)" means
  the four IMPORT lines (from `import { describe, expect, it } from 'vitest';`
  through `import { planContact, planUnit } from '../scripts/clean-org-names.js';`)
  - keep the four-line comment header above them.
- RG-5: the dry run (and the apply summary) also counts contacts that hold a
  non-empty `housingAuthority` or `agency` but lack `type` or `status`, and
  prints the count beside the leftovers (expected 0; such legacy rows are
  seen by the cleanup's base-table scan but not by the rewrite job, the usage
  counts or "Not on the list"). One test.
- RG-6: the RUNBOOK cleanup section gains one sentence: stored "Clayton
  County" values include pre-deploy bare "Clayton" text (the retired alias map
  canonicalized `clayton` to Clayton County), so the cleanup maps all of them
  to Jonesboro Housing Authority; review any bare "Clayton" rows in the
  Airtable export with Sam if a tenant should be DCA's.

### S16 (Tasks 16.1-16.5)

- RF-6: Task 16.1 GLOSSARY - (a) "... every API writer refuses anything else
  with 422 `org_not_on_list`; the AI turns it into a staff suggestion and the
  importer reports it"; (b) "Staff and landlords see ONE \"Housing
  authorities\" picker/row".
- RF-2: Task 16.2's second commit closes
  `docs/issues/contact-authority-clear-empty-string-500.md`: frontmatter
  `status: resolved`, `updated:` and `resolved:` the build date; insert above
  `**Problem.**`: "**Resolution (<date>).** Fixed by d827bab6 (2026-08-13): the
  contacts PATCH maps a '' housing authority to null and the repo REMOVEs the
  attribute (app/src/routes/contacts.ts:631-635). Pinned by
  app/test/contactTriage.test.ts:470-506 and, since feat/clean-org-names, by
  the "(PIN) a clear always passes" case in app/test/contactOrgNames.test.ts.
  The issue stayed open only because its frontmatter was never updated."
- RF-1: Task 16.3 wording: "`TOMBSTONED_FIELDS` and `sawTombstone` in
  `app/src/lib/unitFields.ts`, and the retired-fields-only no-op return of the
  unit PATCH in `app/src/routes/units.ts`".
- RF-3: Task 16.4's expected output - `npm run issues` prints only the summary
  (no warning naming the four new files); then grep the gitignored
  `docs/issues/INDEX.md` for the four slugs (four rows above `## Closed`).
  Never stage INDEX.md.
- RF-5: new step (own commit): `docs/issues/unit-accepted-authorities-edge-cases.md`
  gains above `**Problem.**`: "**Update (<date>).** Case 2 is closed for every
  new write by feat/clean-org-names: the unit POST and PATCH run the
  organization-list check (spec D5), which drops blank members, so [''] is
  stored as []. A value already stored stays until it is edited. Case 1 stands
  (the importer still SETs the list on import-owned units)." plus `updated:`
  (status stays open).

### S17 (gate 5 baseline, from RE1-1)

Pre-existing lint errors in files this branch touches (present at the merge
base; name them in the handback, do not fix): `useComposerDraft.ts`
react-hooks/refs; `BroadcastComposer.tsx` react-hooks/set-state-in-effect x4;
`ContactDetail.test.tsx` no-unused-vars `PlacementsPage`, `UnitsPage`;
`BroadcastComposer.test.tsx` no-unused-vars `ContactsPage`, `UnitsPage`,
`DEFAULT_SEND_TEMPLATE`. Gate 5 still attributes by baseline comparison.

## Clean results worth knowing

- Settings table: no code path reads it generically (all access by fixed key;
  the two wipers delete shape-agnostically; no stream) - the new `org-list`
  item trips nothing (RG).
- Every other writer of the protected fields is covered by a plan task or a
  spec-stated exception; every reader except the dismissal fence works with
  full names and off-list values (RG).
- Typed fakes: the plan's named fallout is complete (RA, RB, RC).
- S10: no importer of the retired modules remains after S7/S8/S10/S11/S15/S16
  (RD). S12: every pinned slug and seed-derived value is named (RD, RF).
- e2e: the S14 file list is complete; the 17 specs left on
  `['atlanta_housing']` resolve through the starting-list spelling `Atlanta
  Housing` and never read the value back (RF).
