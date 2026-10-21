# Build worklist - property requirements (P1 research merged)

Orchestrator merge of the five P1 research readers (2026-10-20, tree
b0b07a5a = main @1d7a4667 + docs). Findings files in this directory:
`R1-app-units.md` (S1+S2), `R2-app-landlord-matching.md` (S3+S4 app),
`R3-dashboard-forms.md` (S4 dashboard+S5), `R4-dashboard-pages.md` (S6),
`R5-e2e-docs.md` (S7). Byte-exact reference material (gitignored):
`.superpowers/sdd/research/R<n>-*-ref.md`.

Result: 0 BLOCKER, 0 MAJOR, 39 MINOR. Every quoted anchor in S1-S7 matches
byte-exact (or is produced by an earlier task); every "fact" holds apart
from line-number hints; every existing test that pins changed behavior is
updated by a named task; no S1->S7 cross-slice name or signature mismatch;
the 35-row PROPERTY_FORM_FIELDS lists of Tasks 1.7 and 5.2 are identical; no
invariant surface (writer or reader) is missing that needs code. No spike:
no new dependency, no infra, no platform binary.

## Orchestrator rulings (OR-x) - BINDING on the implementers, beside plan section 4

Each ruling names the finding it settles and the dispatch unit that carries it.

- OR-1 (R1-F1, unit U4): Task 2.4 Step 3a imports ONLY `depositConflictAfter`,
  `planRequirementWrite`, `splitRequirementsSnapshot`; Task 2.5 Step 3a adds
  `touchesRequirements`. Every task ends with `npx eslint` on its touched
  `.ts/.tsx` files (no NEW errors vs the merge base).
- OR-2 (R1-F2, U1): keep S1's parser behavior - `requirements_snapshot` with
  `landlordId: ''` is the shape 400 (`requirements_snapshot must be an object
  with a landlordId`). Recorded interpretation of plan 2.4; no code change.
- OR-3 (R1-F3): no change; PR1-8 binds the harness's `isDeleted` mirror. Do not
  add a parity case for a non-string `deleted_at`.
- OR-4 (R1-F4): the performance seed `buildUnit`
  (`app/src/lib/seed/performance.ts:582-605`) and the dev zero-primary fixture
  (`app/src/routes/dev.ts:1405-1409`) are create-time `landlordId` writers that
  write no map. WATCH only, recorded here; no plan edit, no code.
- OR-5 (R1-F5, U13): the importer parses the Airtable `Washer Dryer?` column
  (`app/src/lib/import/airtableSource.ts:57,155`) and drops it (spec section 5:
  no importer change). Task 7.7 files a new tier-2 issue
  `docs/issues/import-washer-dryer-not-mapped.md` (copy `_TEMPLATE.md`, type
  gap, severity low, status open) and names it from the
  `unit-onboarding-fields` partial-close text.
- OR-6 (R3-F3, U1/U2): `app/src/lib/requirements.ts` stays within ES2022 APIs
  (the dashboard drift test compiles it with lib ES2022): no `toSorted`,
  `toReversed`, `toSpliced`, `.with()`, `findLast`, `findLastIndex`,
  `Object.groupBy`, `Map.groupBy`. If Task 5.2's typecheck fails inside the app
  module, fix the API use there, never widen the dashboard lib.
- OR-7 (R2-F1, U5): Task 3.3 Step 3(b) ALSO writes `updated_at: CD` on the PM
  unit that receives `requirement_sources`, so plan 3.1's "every map writer
  stamps updated_at" holds literally (the importer cannot address
  `unit-cast-*` ids anyway; no test reads it).
- OR-8 (R2-F2, U6): in Task 4.2 Step 2 the case "an empty list, or none, is no
  size filter" is GREEN on unchanged code (a de-facto PIN); the other D12 cases
  give the real RED.
- OR-9 (R2-F7, U6): Task 4.4 Step 4 also runs
  `git -C W:/tmp/property-requirements diff --exit-code 1d7a4667 -- app/src/lib/seed/lean.ts`.
- OR-10 (R2-F5, R2-F6, U5): the S3 slice report lists the extra safe `req_`
  readers/writers R2 checked (pass-through GET/list/PATCH response; the named-
  field contact creators; importer contact writes; caseworker conversion) and
  the D2-bound residue: a landlord re-typed away keeps its `req_` keys and the
  type gate refuses a clearing null. No code.
- OR-11 (R3-F1, U7): Task 4.6 Step 1a replaces the WHOLE describe
  `AudienceFilters - voucher size pre-fill + override` (`AudienceFilters.test.tsx:95-144`)
  FIRST, then the two single-line edits (the first anchor occurs at :122 and
  :207 until the describe is replaced).
- OR-12 (R3-F2, U8): Task 5.2's mirror test copies the mirrored-function cases
  from ALL THREE app files: `app/test/requirements.test.ts` (1.1),
  `app/test/requirementSources.test.ts` (1.2, `readRequirementSources`,
  `isOwnValue`) and `app/test/propertyFormFlyerParity.test.ts` (1.7, the 35-row
  table) - same `it` names, inputs and expected values.
- OR-13 (R3-F4, U9): Task 5.7 Step 4's GREEN run adds
  `src/routes/placements src/routes/shared src/routes/tours` (three more
  ContactSearchField hosts).
- OR-14 (R3-F5, U11): Task 6.2 refreshes the stale `acceptedVoucherSizes` doc
  comments in `dashboard/src/routes/listing/listingFormat.ts:78-91` and
  `listingFormat.test.ts:83-86` (a list now; the row is "Voucher sizes
  accepted"). ASCII on added lines; the file has pre-existing arrows.
- OR-15 (R3-F6, U8): add NO import to `dashboard/src/api/types.ts` (the app
  typecheck also compiles it, `app/test/contactTimeline.test.ts:42`).
- OR-16 (R4-F1, U11): Task 6.1 Step 3(a) merges `type Contact, type UnitItem`
  into S5's EXISTING `import { TOUR_TYPE_LABELS, ... } from '../../api/index.js'`
  (no second import of the module) and leaves S5's top-level `TOUR_TYPE_SET`
  where it is; read "every value import is used only inside function bodies"
  as the imports from `./listingFormat.js` and `../contact/format.js`.
- OR-17 (R4-F2, U12) - DIVERGENCE, recorded for Cameron's eye: after a MID-RUN
  stop (a later batch 409 or failure) or a FIRST-request non-409 failure, the
  dialog's re-read must not silently re-check what staff unchecked. The next
  SUCCESSFUL read sets the left column to
  `previousChecked INTERSECT defaultCheckedItems(newLandlord)` (an item staff
  unchecked stays unchecked; an item the landlord has since blanked comes back
  unchecked, never a surprise "Clears"); the `hand` row choices still reset
  (rows re-confirm, as planned). On open, Try again with no pending preserve,
  and a FIRST-request 409 `requirements_changed`: today's full reset to
  defaults. A pending preserve survives a failed re-read + Try again and is
  consumed by the next successful read. Pin: after a mid-run stop, an item
  staff unchecked is still unchecked after the re-read; an item the re-read
  landlord holds blank is unchecked. Rationale: "Review the rest and press
  Update again" continues the same Apply; the reset could copy an item staff
  deliberately left out (e.g. Touring, which changes interested-reply routing,
  spec section 4) onto the remaining properties. The rule only ever copies
  LESS than staff chose, never more.
- OR-18 (R4-F3, U12): Task 6.12 clears `applyingFor` and `applyDone` when the
  page's contactId changes (an effect keyed on it), so Back/Forward to the
  landlord never re-opens the dialog or re-shows an old result. Pin it in
  `ContactDetail.test.tsx` (open Apply on L1, move to another contact and
  back: no dialog, no done notice).
- OR-19 (R4-F5): ignore S6's stale note that S5's money inputs carry
  `step={1}`; PR2-3's `step="any"` stands.
- OR-20 (R4-F7, U11): `recordedVoucherSizes` keeps every finite recorded
  number (the page shows what is stored, a legacy 2.5 included; the edit form
  flags it). No filter. Accepted difference.
- OR-21 (R4-F8, R4-F9, U11/U12/U13): never `exact: true` on
  `getByText('Requirements applied from the landlord')` or `getByText('own value')`
  (the Activity row renders label + fields in one element; the mark renders
  ` (own value)`). Scope every `getByRole('group', { name: <item label> })` to
  its card or dialog (RequirementsFields renders group legends with the same
  names inside the edit dialogs).
- OR-22 (R4-F10, U11): in Task 6.5 also pass the identity-checked landlord
  (`requirementsLandlord ?? null`, the same guard the Requirements card uses)
  to the `listingRoster(contactsUnit, ...)` call (`ListingDetail.tsx:369`), so
  the roster fallback row never names the previous landlord during the
  re-read window; one unit test with a mismatched landlord fixture.
- OR-23 (R4-F11, orchestrator): after the Task 7.8 sync re-run
  `src/routes/contact/ContactDetail.test.tsx` and `useContactFile.test.tsx`
  (an in-flight `fix/contact-file-double-fetch` targets that hook).
- OR-24 (R4-F12, U12, optional): where Task 6.8/6.9 already edits the file,
  one comment line at `ContactEditForm.test.tsx:517-525`, `files.test.tsx:502-504`
  and `LandlordFile.tsx:114-116` saying the landlord's copy-only requirement
  defaults (pets included) now live in the Requirements / Qualifications
  fieldset (D9). Assertions unchanged.
- OR-25 (R5-F1, U13): Task 7.1 Step 1 also checks the count pin
  (`grep -n "toHaveLength(12" e2e/performance/mutationCatalog.test.ts`); on the
  fallback branch it applies S5's pin edit too and adds the test file to its
  commit.
- OR-26 (R5-F3, U13) - spec-section-7 wording deviation, intent kept: the
  LANDLORD form's Notes is a wrapping label around its textarea
  (`ContactEditForm.tsx:986-993`), so `getByLabel('Notes', { exact: true })`
  matches only while the box is empty. Task 7.2 Step 3 uses
  `dialog.getByLabel(/^Notes/)` there; Task 7.5 row 2 states the carve-out.
  The property forms' Notes keep `{ exact: true }` (S5 renders the control
  outside the label).
- OR-27 (R5-F4, U13): Task 7.5 also corrects `e2e/README.md:191` to the one-hop
  form `npm run e2e -w @housingchoice/e2e -- --grep "<name>"`.
- OR-28 (R5-F2, orchestrator): main is 8 ahead (not 4); b222a4ac changes
  `dashboard/src/api/client.ts` (a signalled request waits one microtask and is
  dropped if aborted in that tick). No plan task edits a main-changed path;
  the 7.8 merge is expected clean, no `npm ci`. The handback names b222a4ac as
  a behavior change only the post-sync gates exercise.
- Line-number hints that drifted (R1-F6/F7, R2-F3/F4, R3-F6, R5-F5/F6): anchor
  by the QUOTED text (plan section 0); nothing else to do.

## Dispatch units (strictly sequential, one implementer each, model opus)

Every unit also reads plan lines 1-913 (sections 0-4, binding) and its
slice's header/contract-issues/facts block and coverage/notes block.

| Unit | Tasks | Plan lines (tasks) | Slice header + notes | Rulings |
|---|---|---|---|---|
| U1 S1a | 1.1-1.3 registry core | 1134-2831 | 914-1133, 5032-5134 | OR-2, OR-6 |
| U2 S1b | 1.4-1.7 types, validator, flyer, D10a walk | 2832-5031 | 914-1133, 5032-5134 | OR-6 |
| U3 S2a | 2.1-2.2 repo fences, harness, parity, REMOVEs | 5316-6587 | 5135-5315, 8485-8557 | OR-3 |
| U4 S2b | 2.3-2.6 write planner, POST, PATCH, Activity | 6588-8484 | 5135-5315, 8485-8557 | OR-1 |
| U5 S3 | 3.1-3.3 contacts req_, Apply route, full seed | 8742-10535 | 8558-8741, 10536-10626 | OR-7, OR-10 |
| U6 S4a | 4.1-4.4 matching app + matrix seed | 10832-12227 | 10627-10831, 13487-13565 | OR-8, OR-9 |
| U7 S4b | 4.5-4.6 matching dashboard | 12228-13486 | 10627-10831, 13487-13565 | OR-11 |
| U8 S5a | 5.1-5.4 types/endpoints/catalog, mirror, form plumbing, FlyerTag | 13844-16158 | 13566-13843, 19943-20018 | OR-12, OR-15 |
| U9 S5b | 5.5-5.7 VoucherSizePicker, RequirementsFields, pickers | 16159-17312 | 13566-13843, 19943-20018 | OR-13 |
| U10 S5c | 5.8-5.9 ListingEditForm, UnitCreateForm | 17313-19942 | 13566-13843, 19943-20018 | - |
| U11 S6a | 6.1-6.6 display, listingFormat, useListing, property card, ListingDetail, flyer | 20278-22202 | 20019-20277, 24733-24829 | OR-14, OR-16, OR-20, OR-21, OR-22 |
| U12 S6b | 6.7-6.12 Apply model, landlord card, fieldset, reads, dialog, wiring | 22203-24732 | 20019-20277, 24733-24829 | OR-17, OR-18, OR-21, OR-24 |
| U13 S7 | 7.1-7.7 e2e repairs, new spec + mutants, docs, issues | 25116-26397 | 24830-25115, 26721-26814 | OR-5, OR-21, OR-25, OR-26, OR-27 |
| orchestrator | 7.8 sync, 7.9 gates, 7.10 handback | 26398-26720 | - | OR-23, OR-28 |

## For the handback (sub-threshold, "your eye")

- OR-17 (Apply dialog keeps staff's left-column choices across a stop
  re-read, conservatively) - a behavior the spec leaves open; the build chose
  the side that never copies more than staff chose.
- R2-F6: a landlord re-typed to another contact type keeps its `req_` keys,
  and the D2 type gate refuses the null that would clear them; nothing reads
  them on a non-landlord. Spec-consistent residue.
- OR-20: a legacy non-integer voucher size (only possible under today's rule)
  shows on the property page as recorded ("2.5 BR") while the edit form flags
  it for removal on save.
- OR-26: the landlord form's Notes selector is `/^Notes/`, not
  `{ exact: true }` as spec section 7 words it (same intent, robust to a
  non-empty box).
