# unit-tour-type — file-level implementation worklist

Research companion to `docs/superpowers/specs/2026-07-15-unit-tour-type-design.md`.
All paths absolute-from-repo-root. Line numbers are current as of branch
`feat/unit-tour-type` at research time; re-confirm before editing.

ASCII-only reminder (E5): every touched line stays plain ASCII (labels, captions,
comments). The em-dash placeholder rows in `ListingDetail.tsx` use a literal U+2014;
that file is pre-existing non-ASCII, so match its existing style there ONLY.

---

## S1 — TourType relocation + unit model (app)  [the riskiest slice]

### Where TourType lives today
- **Canonical definition:** `app/src/repos/toursRepo.ts:42`
  `export type TourType = 'self_guided' | 'landlord_led' | 'pm_team';`
  (byte-exact union; three members.)
- **Runtime tuple + guard (route-local, NOT exported):** `app/src/routes/tours.ts:88-93`
  ```
  const TOUR_TYPES: readonly TourType[] = ['self_guided', 'landlord_led', 'pm_team'];
  const TOUR_TYPE_SET: ReadonlySet<string> = new Set(TOUR_TYPES);
  function isTourType(x: unknown): x is TourType { return typeof x === 'string' && TOUR_TYPE_SET.has(x); }
  ```

### EVERY app importer of the TourType *type* (the "still compiles" checklist)
There is exactly **ONE** app import site of the `TourType` type:
- `app/src/routes/tours.ts:53-58` imports it from `../repos/toursRepo.js`:
  ```
  import {
    createToursRepo,
    type TourItem,
    type ToursRepo,
    type TourType,
  } from '../repos/toursRepo.js';
  ```
  Used at `tours.ts:57` (import), `:88` (TOUR_TYPES tuple), `:91` (guard), `:295`
  (`tourType: b['tourType'] as TourType`).
- Internal uses inside `toursRepo.ts` itself: `TourItem.tourType` (`:76`),
  `CreateTourInput.tourType` (`:103`).
- **No other `app/src` file imports the type.** All the `tourType: 'self_guided'`
  occurrences across `app/test/**` and `app/src/lib/seed/**` are STRING LITERALS
  in object payloads (never `import type { TourType }`), so they are unaffected by
  the move. (Verified: `grep TourType app/test` = 0 hits.)

**Move plan that keeps the single importer compiling:** re-export from
`toursRepo.ts` after moving the definition to `toursModel.ts`:
```
// app/src/repos/toursRepo.ts (replace line 42)
export type { TourType } from '../lib/toursModel.js';   // canonical home is toursModel
```
Then `tours.ts:53-58` (which imports `type TourType` from `toursRepo.js`) still
resolves — no change required there, though moving its import to `toursModel.js`
alongside its existing `TOUR_STATUSES/TOUR_OUTCOMES` import (`tours.ts:44-52`) is
cleaner and lets it drop the route-local tuple/guard in favor of shared ones.

### toursModel.ts — confirmed the cycle-free home
- **Exists:** `app/src/lib/toursModel.ts` (full read done).
- **Exports today:** `TOUR_STATUSES` + `TourStatus` + `TOUR_STATUS_LABELS` +
  `isTourStatus`; `TOUR_OUTCOMES` + `TourOutcome` + `TOUR_OUTCOME_LABELS` +
  `isTourOutcome`; `canReschedule`. Pattern is literally
  `as const array -> type -> Set -> guard -> labels map` (line 1-5 doc comment).
- **Imports:** NONE. The file has zero import statements ("pure constants, guards,
  helpers. NO I/O"). **=> Cycle verdict: moving `TourType` + labels here is
  CYCLE-FREE.** `toursModel` depends on nothing; `toursRepo` -> `toursModel` and
  `unitsRepo` -> `toursModel` are both one-directional leaf imports.
- `toursRepo.ts` does NOT currently import `toursModel` (it hand-mirrors
  `TourStatus`/`TourOutcome` as loose types at `:45,:48`); adding
  `export type { TourType } from '../lib/toursModel.js'` introduces the first such
  edge, still acyclic.
- `unitsRepo.ts` does NOT import `toursModel` today (imports: `address`, `config`,
  `dynamo`, `logger`, `statusModel`, `conversationsRepo` type). Adding
  `import type { TourType } from '../lib/toursModel.js'` is safe (no cycle:
  toursModel imports nothing, and does not import unitsRepo).

**Suggested additions to `toursModel.ts`** (mirror the existing idiom):
```
export const TOUR_TYPES = ['self_guided', 'landlord_led', 'pm_team'] as const;
export type TourType = (typeof TOUR_TYPES)[number];
const TOUR_TYPE_SET: ReadonlySet<string> = new Set(TOUR_TYPES);
export function isTourType(x: unknown): x is TourType { return typeof x === 'string' && TOUR_TYPE_SET.has(x); }
export const TOUR_TYPE_LABELS: Readonly<Record<TourType, string>> = {
  self_guided: 'Self-guided', landlord_led: 'Landlord-led', pm_team: 'PM team',
};
```
(Labels chosen to match the dashboard's existing `TOUR_TYPE_LABELS` at
`dashboard/src/api/types.ts:525-529` — keep them identical.)

### Is there a TourType LABEL MAP in app today?
- **No app-side label map exists.** `TOUR_TYPE_LABELS` exists ONLY on the dashboard
  (`dashboard/src/api/types.ts:525`). The app has label maps for statuses/outcomes
  (`TOUR_STATUS_LABELS`, `TOUR_OUTCOME_LABELS` in toursModel) but none for type.
  Adding `TOUR_TYPE_LABELS` to toursModel gives app its first one. (The app route
  doesn't need labels — it only validates. The label map is mostly for symmetry /
  future app-side rendering; the dashboard keeps its own mirror per S4.)

### UnitItem model + snake_case convention to mirror
- **`UnitItem` interface:** `app/src/repos/unitsRepo.ts:113-227`.
- **Existing optional snake_case fields to mirror** (byte-quoted):
  - `app/src/repos/unitsRepo.ts:190-191`
    `/** The never-standardized per-unit tour process (free text). INTERNAL. */`
    `tour_process?: string;`
  - `:192-193`
    `/** The never-standardized per-unit application process (free text). INTERNAL. */`
    `application_process?: string;`
  - `:163-168` `lease_terms?: string;` (with its multi-line doc comment).
- **Add:** `tour_type?: TourType;` (import `TourType` — either re-exported from
  the same repo or from `../lib/toursModel.js`). Place it beside `tour_process`
  (`:190`) with an INTERNAL doc comment. The item already has an index signature
  `[key: string]: unknown;` (`:226`) so storage is flexible; the typed field is
  for validation + dashboard-mirror parity, not a schema/GSI change.

---

## S1 routes — units PATCH + create validation & the CLEAR pattern (E4)

### Where validation lives
- **All unit field validation is in `app/src/lib/unitFields.ts`**, shared by the
  authenticated router and the public flyer. `validateUnitBody(body, mode)` at
  `:105-160`. Field allowlist `WRITABLE_FIELDS` at `:35-89` (a
  `Record<string, FieldKind>`; `FieldKind` at `:18`).
- Routes: `POST /api/units` `app/src/routes/units.ts:329-359` (calls
  `validateUnitBody(req.body, 'create')` at `:330`); `PATCH /api/units/:unitId`
  `:708-734` (calls `validateUnitBody(req.body, 'update')` at `:710`, then
  `units.update(unitId, validation.fields)` at `:717`).

### How an existing optional STRING field validates + how it clears — and the GAP
- `tour_process` / `application_process` are declared `'string'` in
  `WRITABLE_FIELDS` (`unitFields.ts:80-81`). The `'string'` branch
  (`:119-121`) only checks `typeof value !== 'string'`.
- **The repo clear mechanism** is a real REMOVE: `unitsRepo.update()`
  (`app/src/repos/unitsRepo.ts:412-458`) walks the patch (`:425-437`):
  `value === undefined` -> skip (untouched); **`value === null` -> REMOVE**
  (`:429-430`); else SET (`:431-435`). So a `null` reaching the repo clears the
  attribute to ABSENT.
- **THE GAP (flag):** for a plain `'string'` kind, `validateUnitBody` REJECTS
  `null` (`typeof null !== 'string'` -> 400) and PASSES `''` straight through as a
  stored empty string. So existing string fields (`tour_process` etc.) DO NOT
  clear-to-absent through the API today — clearing them via the edit form persists
  an **empty string `''`**, not a removed attribute. (Confirmed: `ListingEditForm`
  sends the raw `''`; nothing maps it to `null`.)
- **Consequence for tour_type (E4):** the spec wants `tour_type` to clear to
  ABSENT (no stray empty-string enum). Since the plain-string pattern does NOT do
  that, `tour_type` needs a **dedicated FieldKind** in `unitFields.ts`, e.g.
  `'tour_type'`, whose branch:
  1. accepts `''` or `null` as a CLEAR -> set `fields['tour_type'] = null` (so the
     repo REMOVEs it — reusing the existing null->REMOVE path);
  2. accepts a value in the union (use `isTourType` from toursModel) -> pass through;
  3. rejects anything else -> `return { ok: false, error: 'tour_type must be one of: self_guided, landlord_led, pm_team' }`.
  Add `tour_type: 'tour_type'` to `WRITABLE_FIELDS` (near `:80`). This is the only
  place the enum-clear differs from the "mirror tour_process" instruction in the
  spec — the spec's "clear the way other optional string fields clear" is
  imprecise because those clear to `''`, not absent.

### 400-on-invalid enum pattern to copy
- The nearest enum-ish validator is the `tourType` guard in the tours route
  (`app/src/routes/tours.ts:281-282`): `if (!isTourType(...)) res.status(400)...`
  with message `` `tourType must be one of: ${TOUR_TYPES.join(', ')}` ``. Mirror
  its message shape for the unit `tour_type` 400.
- Existing 400 tests to imitate live in `app/test/unitFields.test.ts` (see E3/E4
  below) — the same `expect(validateUnitBody(...)).toEqual({ ok:false, error:... })`
  form.

---

## E3 — public flyer projection must NOT gain tour_type

- **Projection functions** (`app/src/lib/unitFields.ts`): `toUnitFlyer(unit)`
  `:210-228` (teaser allowlist -> `UnitFlyer` iface `:170-184`) and
  `toUnitFlyerDetails(unit)` `:230-244` (reveal allowlist -> `UnitFlyerDetails`
  iface `:197-208`). Both are strict build-UP allowlists; `tour_process` /
  `application_process` are explicitly listed as NEVER-include in the doc comments
  (`:167-168`, `:191-196`). **Do NOT add `tour_type` to either** — it simply is
  not copied.
- **Served from** `app/src/routes/public.ts:313-322` (`/flyer`) and `:330-339`
  (`/details`).
- **Exact-shape TEST (the E3 pin home):** `app/test/unitFields.test.ts`.
  - Fixture `fullUnit()` at `:132-167` already sets `tour_process:'SECRET lockbox 9999'`
    (`:160`). **Add `tour_type: 'self_guided'` to `fullUnit()`.**
  - The exact-shape `toEqual<UnitFlyerDetails>({...})` at `:169-191` is already a
    closed shape (`toEqual` is exact) — adding `tour_type` to the fixture but NOT to
    the expected object makes this test FAIL if it ever leaks. That is the pin.
  - Also add `'tour_type'` to the forbidden-keys loop in the "allowlist wall" test
    at `:196-213` for an explicit assertion.

---

## S2 — dashboard property surfaces

### ListingDetail.tsx — the "Tour type" KV row
- File: `dashboard/src/routes/listing/ListingDetail.tsx`.
- **KV render pattern (em-dash-when-unset):** `<KV k="Label" v={value ?? '—'} />`
  used throughout the "Property details" grid at `:293-323` (e.g. `:298`
  `<KV k="Jurisdiction" v={unit.jurisdiction ?? '—'} />`, `:302`
  `<KV k="Lease terms" v={unit.lease_terms ?? '—'} />`). `KV` is imported from
  `../contact/Card.js` (`:26`).
- **The "Tour & application process" card:** `:361-379` — a separate `Card` with
  free-text `<p>` paragraphs (`unit.tour_process` / `unit.application_process`),
  NOT a KV grid.
- **Where the row goes:** spec S2 wants the structured KV near the free-form card.
  Two clean options — implementer's choice:
  (a) add `<KV k="Tour type" v={unit.tour_type ? TOUR_TYPE_LABELS[unit.tour_type] : '—'} />`
      into the "Property details" detailGrid (`:293-323`); OR
  (b) add the same KV at the top of the "Tour & application process" card body
      (`:371`), above the paragraphs, so structured + free-form read together
      (matches the spec's "read together" intent most literally).
- **Import to add:** `TOUR_TYPE_LABELS` from `../../api/index.js` (the file already
  imports `TOUR_STATUS_LABELS` etc. from there at `:18-25`). Confirm
  `TOUR_TYPE_LABELS` is re-exported by `dashboard/src/api/index.ts` (it lives in
  `types.ts`; check the barrel re-exports it — `ScheduleTourForm.tsx:32` already
  imports it from `../../api/index.js`, so the barrel DOES export it).

### ListingEditForm.tsx — the "Tour type" select
- File: `dashboard/src/routes/listing/ListingEditForm.tsx`. **There is NO existing
  `<select>` in this form** — every field is a text/number `<input>`, one
  `<textarea>` per process field, and one checkbox (`same_day_rta` `:461-469`).
  So the tour_type select is a NEW control here; model it on the ONLY dashboard
  tour-type select that exists (`ScheduleTourForm.tsx:325-336`).
- **State + dirty-diff pattern to mirror** (string fields):
  - init: `:50` `const [tourProcess, setTourProcess] = useState(str(unit.tour_process));`
    -> add `const [tourType, setTourType] = useState(str(unit.tour_type));`
    (`str()` helper `:18-20` returns `''` when unset). Cast may be needed:
    `useState<string>(str(unit.tour_type))`.
  - diff in `buildPatch()`: `:112`
    `if (tourProcess !== str(unit.tour_process)) patch['tour_process'] = tourProcess;`
    -> add `if (tourType !== str(unit.tour_type)) patch['tour_type'] = tourType;`
    This SENDS `''` on clear -> the backend `'tour_type'` FieldKind (E4) maps `''`
    -> null -> REMOVE. (Do NOT route it through `addNumber`.)
- **The select markup** (a "Not set" empty option + the three labels):
  ```
  <label className={styles.field}>
    <span className={styles.label}>Tour type</span>
    <select className={styles.input} aria-label="Tour type"
            value={tourType} onChange={(e) => setTourType(e.target.value)}>
      <option value="">Not set</option>
      {(Object.keys(TOUR_TYPE_LABELS) as TourType[]).map((t) => (
        <option key={t} value={t}>{TOUR_TYPE_LABELS[t]}</option>
      ))}
    </select>
  </label>
  ```
  Place it near the "Tour process" textarea (`:471-479`). Import `TOUR_TYPE_LABELS`
  + `type TourType` from `../../api/index.js`.
- **Note:** `styles.input` is used on the ScheduleTourForm select too, so it styles
  a `<select>` acceptably; reuse it (or add a select-specific class if the CSS
  module needs it — check `ListingEditForm.module.css`).

### UnitCreateForm.tsx — the same optional select (default Not set)
- File: `dashboard/src/routes/listing/UnitCreateForm.tsx` (shares
  `ListingEditForm.module.css`). Fields are all inputs/textareas/checkbox; NO
  select today.
- **State:** add `const [tourType, setTourType] = useState('');` beside `:70`
  (`const [tourProcess, setTourProcess] = useState('');`).
- **Body build:** in `buildBody()` the string helper is `addStr(key, value)`
  (`:142-145`) which trims and only sets when non-empty — but `addStr` won't send a
  cleared value, which is fine on CREATE (absent = unset). For an enum, add a
  guarded line near `:154` (`addStr('tour_process', tourProcess);`):
  `if (tourType) body['tour_type'] = tourType;` (only send when a real type is
  chosen; "Not set" -> omit). Do NOT use `addStr` (it would still work since ''
  is falsy, but the enum isn't a free string — an explicit guard is clearer).
- **Select markup:** identical to the ListingEditForm block above; place near the
  "Tour process" textarea (`:501-509`).

---

## S3 — the create-tour modal `ScheduleTourForm.tsx`

File: `dashboard/src/routes/tours/ScheduleTourForm.tsx` (full read done).

### deriveTourType (the keyword guesser) — KEEP as the labeled fallback
- `:72-102`. Signature `deriveTourType(tourProcess: string | undefined): TourType`.
  Returns `'self_guided'` when arg falsy or no keyword matches. Keyword order:
  pm_team phrases / `\bpm\b` -> `landlord/owner` -> `self` -> default self_guided.
  Do NOT remove (spec Non-goal): it becomes provenance-caption #2.

### Current silent prefill chain (to REPLACE with the 3-branch provenance chain)
- `const DEFAULT_TOUR_TYPE: TourType = 'self_guided';` `:63`.
- Type state: `:129` `const [tourType, setTourType] = useState<TourType>(DEFAULT_TOUR_TYPE);`
- Override flag: `:135` `const [tourTypeOverridden, setTourTypeOverridden] = useState(false);`
- **Prefill effect:** `:211-216`
  ```
  useEffect(() => {
    if (resolvedUnitId === undefined) return;
    if (tourTypeOverridden) return;
    const unit = units.find((u) => u.unitId === resolvedUnitId);
    setTourType(deriveTourType(unit?.tour_process));
  }, [resolvedUnitId, units, tourTypeOverridden]);
  ```
  This is where the new 3-branch chain goes: `unit.tour_type` set -> use it
  (caption "From the property"); else non-empty `unit.tour_process` ->
  `deriveTourType(...)` (caption "Guessed from the property's tour notes - check it");
  else `self_guided` (caption "Default - no tour info on the property"). Store the
  computed caption in a new state (e.g. `const [provenance, setProvenance] = useState<string | null>(null)`),
  set it alongside `setTourType` in this effect.
- **Manual-pick-sticks logic:**
  - `handleUnitChange` `:220-225`: resets `tourTypeOverridden` to false only when a
    DIFFERENT unit id is picked (`:221`) -> next pick re-derives; re-picking the
    SAME unit keeps a manual choice.
  - `handleTourTypeChange` `:227-230`: `setTourType(...)`; `setTourTypeOverridden(true)`.
    On override the caption must stop claiming property provenance (E1) — set
    `provenance` to null or a neutral "Manual pick" here.
  - **Clear (E2):** the unit typeahead's Clear is handled by `UnitSearchField`
    (`handleUnitChange` receives `{ label:'' }` with `unitId` undefined). When
    `resolvedUnitId === undefined` the effect early-returns and leaves stale state;
    add a branch (or a small effect) to reset `tourType` -> DEFAULT, `provenance`
    -> null, and the text block -> hidden when the unit is cleared.

### The type <select>
- `:322-337`. `aria-label="Tour type"` (`:327`), `value={tourType}`,
  `onChange={handleTourTypeChange}`, options mapped over
  `TOUR_TYPES = Object.keys(TOUR_TYPE_LABELS) as TourType[]` (`:66`). The
  provenance caption should render directly under this `<label>` block; the
  read-only tour_process block under that (spec S3/G3).

### Does the modal have the unit's data? — YES
- Units are fetched full via `getUnits({})` and stored as `UnitItem[]`
  (`:118`, `:171-192`). The prefill effect already reads `unit.tour_process`
  (`:214-215`). Once the dashboard `UnitItem` mirror gains `tour_type` (S4), the
  same `units.find(...)` object exposes BOTH `unit.tour_type` and
  `unit.tour_process` — **no new fetch or prop plumbing needed.** The read-only
  `tour_process` text block (G3) reads the same `unit.tour_process`.
- Attach points: provenance caption + `tour_process` read-only block both go
  inside the `{/* 3 — Tour type */}` label region (`:322-337`), immediately after
  the `<select>`. Guard the text block on `unit?.tour_process` being non-empty AND
  a unit being picked (no unit -> render neither, per E2).

### Existing unit-test fixtures for the prefill (extend these)
- `dashboard/src/routes/tours/ScheduleTourForm.test.tsx`: fixture units at `:44-53`
  (`tour_process` strings), prefill tests 7a/7b at `:219-243`, override test at
  `:250-261`. Add a `tour_type`-set fixture for the "From the property" branch and
  assert the caption text; keep 7a/7b as the guess-path (caption #2) cases.

---

## S4 — dashboard types + labels

- File: `dashboard/src/api/types.ts`.
- **`TourType` mirror:** `:521-522`
  `/** ... (mirrors app/src/repos/toursRepo.ts TourType). */`
  `export type TourType = 'self_guided' | 'landlord_led' | 'pm_team';`
  (Update the "mirrors ..." comment to point at `app/src/lib/toursModel.ts` after
  the S1 move, to keep the hand-mirror provenance honest.)
- **`TOUR_TYPE_LABELS` (REUSE — do not add a second map):** `:524-529`
  ```
  export const TOUR_TYPE_LABELS: Readonly<Record<TourType, string>> = {
    self_guided: 'Self-guided', landlord_led: 'Landlord-led', pm_team: 'PM team',
  };
  ```
- **UnitItem mirror:** `interface UnitItem` at `:1105-1162`. Hand-mirror sync
  convention = a doc comment per field pointing at the server field. Existing
  parallels to copy: `:1152` `/** Free-text "how to tour" copy ... */ tour_process?: string;`
  and `:1153-1154` `application_process?: string;`. **Add** `tour_type?: TourType;`
  beside them with a one-line doc comment (e.g.
  `/** Structured tour type; prefill source for the Schedule-a-tour modal. */`).
  The interface already has `[key: string]: unknown;` (`:1161`), so untyped
  pass-through already works; the typed field is for `ScheduleTourForm` +
  the forms to read `unit.tour_type` without a cast.
- No change needed to `getUnits` / `updateUnit` / `createUnit` in
  `dashboard/src/api/endpoints.ts` — they pass whole bodies/objects; `tour_type`
  flows through by the index signature once typed.

---

## S5 — seeds (FULL profile only; LEAN untouched, byte-stable)

- **Lean seed is a SEPARATE file:** `app/src/lib/seed/lean.ts`. Do NOT touch it
  (spec G5 / S5 byte-stable baseline). Full-profile units come from `cast.ts` +
  `matrix.ts`.
- **cast.ts hand-authored units** (each a `unit: { ... }` block):
  - `UNIT_CAST_SEARCHING` at `:419-434`: `tour_process: 'Landlord-led; text to
    schedule an appointment.'` (`:431`). **This is the spec's exact example** —
    set `tour_type: 'landlord_led'` here (agrees with text) for the "From the
    property" branch.
  - `UNIT_TOURED` at `:674-688`: `tour_process: 'Landlord-led; call to schedule.'`
    (`:686`). **Leave UNSET** (no `tour_type`) so the guess path (caption #2) stays
    exercised on a toured unit (spec S5 "leave at least one toured unit UNSET").
  - `UNIT_MID_INTAKE` context near `:1105-1117`
    (`tour_process: 'Text landlord to arrange viewing.'`) — optional; can stay unset.
- **matrix.ts generated tourable units** — the clean insertion point:
  - `tourableSpecs` at `:674-681`: each spec ALREADY carries a
    `processType: 'self_guided' | 'landlord_led' | 'pm_team'` that maps to its
    `tour_process` via `TOURL_PROCESSES_BY_TYPE` (`:683-687`). In the build loop
    `:689-709`, the unit object (`:694-708`) sets `tour_process:
    TOURL_PROCESSES_BY_TYPE[spec.processType]` (`:706`). **Add
    `tour_type: spec.processType,`** right after — a coherent structured value that
    AGREES with the text, for several units. (Leave the earlier bulk
    status-loop units at `:645-668`, which use `tourProcess(counter)`, UNSET so the
    guess/default paths also appear in dev.)
- **Seed-coherence tests:** `app/test/seedMatrixCoherence.test.ts` iterates
  placements/deadlines/tenants — it does NOT enumerate a closed unit-field set, so
  adding `tour_type` will NOT break it. Other seed tests to be aware of:
  `app/test/seedData.test.ts`, `app/test/seedMatrix.test.ts`,
  `app/test/seedRosterShape.test.ts` — none assert an exact unit-key set (spot-check
  before finishing, but no change expected). Only update a seed test if it starts
  enumerating unit fields.

---

## E2E — reusable selectors / verbs

### ScheduleTourForm driving (accessible selectors — reuse verbatim)
- Open dialog: `page.getByRole('button', { name: 'Schedule a tour' }).click();`
  then `const dialog = page.getByRole('dialog', { name: /Schedule a tour/i });`
  (`tours-page.spec.ts:112-113`; `steps.ts:1437-1438`).
- Locked tenant side: `dialog.getByRole('group', { name: 'Tenant' })`
  (`tours-page.spec.ts:117`).
- Unit typeahead: `dialog.getByRole('combobox', { name: 'Unit' })` -> `.fill('Joseph')`
  -> `dialog.getByRole('option', { name: /Joseph E\. Boone/ }).click();`
  (`tours-page.spec.ts:120-122`). Clear button: `{ name: 'Clear Unit' }`
  (`steps.ts:1449`).
- **Prefill assertion (the model to extend for provenance):**
  `tours-page.spec.ts:124-128`
  ```
  const tourTypeSelect = dialog.getByRole('combobox', { name: 'Tour type' });
  await expect(tourTypeSelect).toHaveValue('landlord_led');
  ```
  (unit-0001's `tour_process` mentions "landlord" -> guess path). For the new
  "From the property" case, set a structured `tour_type` via the edit form (below),
  reopen the modal, and additionally assert the provenance caption text is visible.
- Select a type: `dialog.getByLabel('Tour type').selectOption({ label: tourType })`
  (`steps.ts:1462`) — the override step.
- Submit: `dialog.getByRole('button', { name: 'Schedule', exact: true }).click();`
  then wait for `/\/tours\/[^/?#]+$/`. (`steps.ts:1465-1466`.)
- The composite verb `teamCreatesTourFromInterest(unit, tourType)` at
  `steps.ts:1430-1474` already parameterizes the tour-type label — reuse/extend it.

### Setting a property field via the edit form (the pattern to copy)
- `e2e/tests/dashboard-next/listing-activity.spec.ts:22-30` `editUtilities()`:
  ```
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Edit property/i }).click();
  const dialog = page.getByRole('dialog', { name: /Edit property/i });
  await dialog.getByLabel(/Utilities/i).fill(value);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  ```
  For tour_type substitute
  `await dialog.getByLabel('Tour type').selectOption('landlord_led');` (or
  `{ label: 'Landlord-led' }`). This is the setup step for the "From the property"
  provenance e2e (spec §6: set on property -> reopen modal -> caption + value).
- Seeded-unit helper for e2e setups: `steps.ts:613` `seedAvailableUnit({beds,...})`
  POSTs a unit then publishes via `.../listing-status` — use it to create a fresh
  property, then edit its Tour type, then open Schedule-a-tour.

### e2e test homes
- Extend `e2e/tests/dashboard-next/tours-page.spec.ts` (the Schedule-a-tour spec)
  for the provenance/override/guess assertions.
- `e2e/tests/dashboard-next/listing-activity.spec.ts` is the model for
  edit-form-driven property field round-trips.

---

## Flags / drift vs the spec

1. **E4 clear semantics are NOT a straight mirror of `tour_process`.** Existing
   optional STRING fields (`tour_process`, `application_process`, `lease_terms`)
   clear to an empty string `''`, NOT to absent: `validateUnitBody`'s `'string'`
   branch rejects `null` and passes `''` through, and the edit form sends `''`.
   To honor E4 ("no stray empty-string tour_type; clear -> attribute removed"),
   `tour_type` needs a **dedicated `FieldKind`** in `unitFields.ts` that maps
   `''`/`null` -> `null` so the repo's existing null->REMOVE path
   (`unitsRepo.ts:429-430`) fires. The spec's "clear the way other optional string
   fields clear" is imprecise on this point — flag for the S1 implementer.

2. **No existing `<select>` in `ListingEditForm.tsx` / `UnitCreateForm.tsx`.** The
   spec says "following the form's existing select conventions" but these forms have
   none. Model the new select on `ScheduleTourForm.tsx:325-336` (the only dashboard
   tour-type select) plus a `<option value="">Not set</option>`. CSS: reuse
   `styles.input` (already applied to the ScheduleTourForm select); verify it reads
   well on a `<select>` in `ListingEditForm.module.css`.

3. **App has no `TOUR_TYPE_LABELS` today** — only the dashboard does
   (`types.ts:525`). Adding one to `toursModel.ts` is net-new (harmless); keep the
   label strings byte-identical to the dashboard's so the two mirrors agree.

4. **Provenance caption on Clear (E2)** is not covered by the current effect —
   `ScheduleTourForm`'s prefill effect early-returns when `resolvedUnitId` is
   undefined (`:212`), leaving stale `tourType`/caption. The implementer must add an
   explicit reset-to-no-unit branch (type -> default, caption -> null, text block
   hidden). Existing tests don't cover the cleared state; add one.

5. **`ScheduleTourForm.tsx` header comment (`:20-25`)** documents the OLD silent
   `tour_process`-only prefill. Update it to describe the 3-branch provenance chain
   (ASCII-only) so the doc doesn't drift.

---

## One-file-per-slice summary of edits

- **S1 (app):** `app/src/lib/toursModel.ts` (+TourType/TOUR_TYPES/isTourType/
  TOUR_TYPE_LABELS); `app/src/repos/toursRepo.ts:42` (re-export TourType from
  toursModel); `app/src/repos/unitsRepo.ts:190` (+`tour_type?: TourType`);
  `app/src/lib/unitFields.ts` (+`tour_type` FieldKind w/ ''/null->null clear + union
  validate + 400; add to WRITABLE_FIELDS); optionally simplify `app/src/routes/
  tours.ts:88-93` to use shared TOUR_TYPES/isTourType. Tests:
  `app/test/unitFields.test.ts` (E3 pin + E4 set/clear/absent), and a units
  PATCH/create test (see `app/test/*Api` patterns).
- **S2 (dashboard):** `ListingDetail.tsx` (KV row + TOUR_TYPE_LABELS import);
  `ListingEditForm.tsx` (select + state + buildPatch diff);
  `UnitCreateForm.tsx` (select + state + buildBody guard). Component tests alongside.
- **S3 (dashboard):** `ScheduleTourForm.tsx` (3-branch provenance chain, caption
  state, read-only tour_process block, clear reset, header-comment update);
  `ScheduleTourForm.test.tsx` (branch + override + clear coverage).
- **S4 (dashboard):** `api/types.ts:1152` (+`tour_type?: TourType` on UnitItem
  mirror; update the TourType "mirrors" comment).
- **S5 (app):** `app/src/lib/seed/cast.ts:431` unit gets `tour_type:'landlord_led'`;
  `app/src/lib/seed/matrix.ts:706` add `tour_type: spec.processType`; leave
  `UNIT_TOURED` (cast.ts:674) unset. `lean.ts` untouched.
- **E2E:** extend `e2e/tests/dashboard-next/tours-page.spec.ts` (+ reuse
  `listing-activity.spec.ts` edit pattern and `steps.ts` verbs).
