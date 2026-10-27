# D2-S2 findings - plan section 6 (S2 Priority on/off)

Reader D2-S2 checked plan lines 1-515 (binding sections 0-4) and 2895-3627
(S2: tasks S2.1-S2.4 and the S2 coverage table) against the worktree at
branch HEAD ede08552, whose app/, dashboard/, e2e/ and scripts/ are
byte-identical to main @d0e2c2d8 (`git diff --stat d0e2c2d8 HEAD` over those
paths is empty). Checked: every quoted anchor (verbatim, unique, ASCII), every
name/helper/fixture the S2 test sketches call, every consumer of the unit
`priority` key and of `WRITABLE_FIELDS`, every test that counts or iterates
`PROPERTY_FORM_FIELDS` in app and dashboard, the create/PATCH write paths, the
TaggedCheckbox and KV markup, the ListingDetail header, the seed PIN imports,
and the e2e specs for collisions. Nothing was run. Two findings.

## D2-S2-1 - BLOCKER - S2.2 misses the dashboard's second PROPERTY_FORM_FIELDS table; Step 7 goes red

- Plan location: Task S2.2 Step 1b (plan lines 3152-3157), Step 2 (3230-3237),
  Step 7 (3371-3380); WI12 (172-174); S2 coverage row "parity table 36 rows"
  (3624).
- What the plan says: Step 1b makes "the same two edits to its table case":
  old (:599-600) `- 35 rows` / `toHaveLength(35)`, and inserts
  `['Priority', ['priority'], 'staff_only'],` "between its ['Same-day RTA',
  ...] and ['No evictions while on the program', ...] rows". Step 7 says all
  pass with "36 rows in both tables".
- What the tree holds: `dashboard/src/routes/listing/requirements.test.ts`
  holds TWO exhaustive tables over `PROPERTY_FORM_FIELDS`:
  (1) :223-262, `describe('PROPERTY_FORM_FIELDS (the D10a tag table)')` /
  `it('lists every New / Edit property-form field in form order with its tag')`
  - `PROPERTY_FORM_FIELDS.map((f) => [f.label, f.flyer])` `.toEqual([...])`
  with exactly 35 `[label, flyer]` pairs; its Same-day RTA pair is at :242-243;
  (2) :598-641, the `[label, keys, flyer]` "- 35 rows" case the plan edits.
  No step touches (1). Once Step 3b adds the mirror row, (1) receives 36 rows
  against 35 expected and fails, so Step 7's run of
  `src/routes/listing/requirements.test.ts` is red and the S2.2 commit leaves
  the dashboard suite red (S2.4 Step 4 then fails too). Step 2 does not catch
  it: (1) is green until the implementation lands. The insert instruction is
  also ambiguous: the Same-day RTA / No evictions row pair occurs twice in the
  file (:242-243 and :621-622), and the FIRST textual match is the two-element
  table, where a three-element row would be wrong.
- Correction: replace S2.2 Step 1b with these three edits to
  `dashboard/src/routes/listing/requirements.test.ts` (both row anchors are
  unique in the file; the rows carry the file's 6-space indent):

  (a) The two-element case, old (:242-243):

```ts
      ['Same-day RTA', 'on_flyer'],
      ['No evictions while on the program', 'staff_only'],
```

  new:

```ts
      ['Same-day RTA', 'on_flyer'],
      // WP1 B1 spec D6: the Priority switch, its own row after Same-day RTA.
      ['Priority', 'staff_only'],
      ['No evictions while on the program', 'staff_only'],
```

  (b) The three-element case header, old (:599-600) `- 35 rows` /
  `toHaveLength(35)`, new `- 36 rows` / `toHaveLength(36)` (as written).

  (c) The three-element case rows, old (:621-622):

```ts
      ['Same-day RTA', ['same_day_rta'], 'on_flyer'],
      ['No evictions while on the program', ['no_evictions_on_program'], 'staff_only'],
```

  new:

```ts
      ['Same-day RTA', ['same_day_rta'], 'on_flyer'],
      // WP1 B1 spec D6: the Priority switch, its own row after Same-day RTA.
      ['Priority', ['priority'], 'staff_only'],
      ['No evictions while on the program', ['no_evictions_on_program'], 'staff_only'],
```

  Step 2's red line becomes "the app table and both dashboard tables hold 35
  rows (expected 36, with Priority); no Priority checkbox exists on either
  form" ((1) is red only after Step 3b, which Step 7 proves). The S2.4 Step 6
  report's WI12 line names three tables at 36 rows, not two.

## D2-S2-2 - MINOR - The Priority pill is white text on --c-warning: 4.28:1, below WCAG AA for 12px text (already rejected once, code review RD-8)

- Plan location: Task S2.3 Step 3c (plan lines 3493-3510).
- What the plan says: `.priorityBadge` sets `font-size: var(--fs-xs)`,
  `font-weight: var(--fw-semibold)`, `background: var(--c-warning)`,
  `color: var(--c-text-inverse)`.
- What the tree holds: `--c-warning` is `#b06a00` and `--c-text-inverse`
  `#ffffff` (dashboard/src/ui/tokens.css:25, :17). That pair is 4.28:1, under
  AA's 4.5:1 for 12px semibold text - the repo already recorded and fixed this
  exact pairing: dashboard/src/routes/contact/ApplyRequirementsDialog.module.css:113-114
  ("not the shared --c-warning (4.28:1, under AA's 4.5:1 here) - code review
  RD-8"). The header's existing pill `.deletedBadge`
  (ListingDetail.module.css:64-75) is white on `--c-danger` `#c23934`
  (about 5.3:1). tokens.css:94-100 carries an amber "darkened for white-text
  contrast": `--c-pill-unknown-bg: #b45309` (about 5.0:1 with white).
- Correction: in S2.3 Step 3c's rule replace
  `  background: var(--c-warning);` with
  `  background: var(--c-pill-unknown-bg);` and the rule's comment line with
  `/* WP1 B1 (spec D6): the staff Priority pill beside the status. Amber darkened for white text (tokens.css type pills); --c-warning is 4.28:1 (code review RD-8). */`.
  Equivalent alternative: `background: var(--c-evt-amber-bg);` with
  `color: var(--c-evt-amber-text);` (about 6.4:1). No test change.

## Verified with no finding

- Plan range 2895-3627 carries no non-ASCII character. Every quoted anchor in
  S2 is ASCII except unitsRepo.ts:464 (the em dash C4 names); no `\u` escape
  sits near any S2 edit.
- S2.1 validator: `unitFields.ts:106` `  priority: 'string',` is verbatim and
  unique; the `boolean` kind (:265-267) refuses null and every non-boolean with
  `${key} must be a boolean`, so 1b's expectations (including create with
  landlordId) match the validator's output exactly and are red for the stated
  reason on unchanged code.
- `WRITABLE_FIELDS` / `FieldKind` are module-private; the one consumer is
  `validateUnitBody`, called only by routes/units.ts:926 (create) and :2308
  (PATCH). Create: planRequirementWrite passes every field
  (unitRequirementWrite.ts:166-191) and unitsRepo.create drops only nulls
  (unitsRepo.ts:1234-1262), so `true`/`false` are stored. PATCH: `priority` is
  no requirement key, so the plain path runs units.update, which SETs `false`
  and REMOVEs only null (unitsRepo.ts:1315-1361). GET /api/units/:id
  (units.ts:1025-1037) and the PATCH response return the whole item, so the
  dashboard sees the stored boolean. toUnitFlyer (unitFields.ts:480-508) never
  copies it; public.ts:854 projects only through toUnitFlyer.
- unitsRepo.ts:464-465 anchor present as C4 describes; app `UnitItem` keeps its
  index signature (:579).
- unitFields.test.ts: fixture `      priority: 'SECRET high',` (:645) unique;
  the file already imports toUnitFlyer and validateUnitBody (:7-13); the
  forbidden-keys wall (:704-716) still lists `priority`; the "other kinds are
  unchanged" PIN (:539-545) does not name priority.
- seedPriority.test.ts imports resolve: SEED (seed/lean.ts:85), castItems
  (cast.ts:1522), matrixItems (matrix.ts:1425), buildLiveStaticItems
  (live.ts:103); the `Row` / `Tables` / `FULL` pattern is the one
  seedRequirements.test.ts:24-33 compiles today; no seed module holds a
  `priority` unit key, so the PIN is green.
- Readers of unit `priority`: none anywhere in app/src, app/scripts,
  dashboard/src, e2e or scripts beyond unitFields.ts:106 and unitsRepo.ts:465.
  `AirtableProperty.priority` (airtableSource.ts:58, :156) is its own interface
  and is never read (no `.priority` / `['priority']` access in the tree); the
  importer's unit mapping (workbook.ts:307) does not touch it. The string ->
  boolean change compiles everywhere once the :645 fixture moves; a legacy
  string reads off at every reader the plan adds (`=== true`).
- S2.4 Step 1: `app/src/routes/public.ts`, `jobs/extraction.ts` exist; S1 only
  touches seed/cast.ts in those paths; the case-sensitive `git grep -n
  "priority"` returns exactly orgListBlock.ts:98 and :136.
- S2.2 app table: requirements.ts:525 docblock and :551 row verbatim and
  unique; `formField(label, keys, flyer)` (:504) matches. Mirror row anchor
  (dashboard requirements.ts:275) unique; requirementsMirror.test.ts:88
  `toEqual` holds with the planned rows (comments differ, data equal).
- Parity test anchors (:48-49 SAMPLE, :104-105 filled base, :174-175,
  :196-197) verbatim and unique; with SAMPLE `priority: true` and base
  `priority: false` the walk, the writable-keys case (:229-236, valid after
  S2.1) and both flip cases (:262-293) stay green.
- dashboard types.ts:2706 `  same_day_rta?: boolean;` unique; `UnitItem` has an
  index signature (:2760); `CreateUnitBody` has one (:2795-2799), so
  `body['priority'] = true` compiles; `updateUnit` takes
  `Record<string, unknown>` (endpoints.ts:1033-1036). Both forms send a real
  boolean.
- Form anchors verbatim and unique: UnitCreateForm.tsx :174, :311, :736-742;
  ListingEditForm.tsx :118, :187-188, :601-607 (same 8-space JSX indent). No
  existing `priority` / `setPriority` identifier in either component; no
  prefill or reset path in the New form. TaggedCheckbox props (TaggedField.tsx:
  70-77) match the plan's JSX; the tag sits outside the label and the label
  wraps the input, so the accessible name is exactly `Priority`
  (`getByRole('checkbox', { name: 'Priority' })` and `getByLabelText('Priority')`
  resolve); FlyerTag renders `Staff only` (FlyerTag.tsx:21-24).
- The tag and DOM-order cases (UnitCreateForm.test.tsx:1022-1055,
  ListingEditForm.test.tsx:595-646) iterate the table; Priority lands after
  Same-day RTA and before the Requirements heading on both forms, so they hold
  when the row and both controls land in the one task.
- Test harness names exist: setup, dialogReady, blankSnapshot, newUnit,
  createUnit (UnitCreateForm.test.tsx:11-113); UNIT, updateUnit
  (ListingEditForm.test.tsx:6, :46-57). The exact create-body shape matches the
  :256-259 precedent; the no-change-closes behavior matches :167-174.
- No regex label query in the dashboard listing/contact tests and no e2e
  `getByLabel` string matches `Priority` as a substring; no e2e spec reads
  priority, counts property-form checkboxes or tags, or asserts Yes/No on the
  property page.
- ListingDetail: header anchor (:887) and the Video tour KV plus grid close
  (:989-1002) verbatim and unique; the h1 (:869) is the only level-1 heading in
  the page tree and sits inside `<header>` (:866); KV markup
  (contact/Card.tsx:144-166) makes `getByText('Priority').parentElement` the
  row holding the value; cardTitled, READY, renderAt and useListing exist
  (ListingDetail.test.tsx:10, :76-145, :183-185); no existing ListingDetail
  test asserts Yes/No text. CSS anchor `  vertical-align: middle;` is unique
  (:74) and every token the rule names exists (tokens.css).
- Types in the S2.3 sketch: vitest 3.2.6's `it.each` overload
  `<T extends any[] | [any]>` infers tuples, giving `priority: boolean |
  undefined`; no tsconfig sets `exactOptionalPropertyTypes`.
- Line hints a few off by one (SAMPLE :47 is :48; base :105-106 is :104-105;
  header :886 is :887; grid close :1001 is :1002); the quoted anchors are
  verbatim and unique, so no action.
