# Fix wave FW5 (planner rulings) - implementer report

Branch feat/property-requirements, worktree W:\tmp\property-requirements.
Work list: "Planner rulings for fix wave FW5" in
`code-review/planner-adjudications.md` (PR-1..PR-5, the PC-17 test, the PA-5
issue file). Findings behind them: `code-review/planner-adversarial.md`
(PA-1, PA-2, PA-3, PA-4, PA-5, PA-7) and `code-review/planner-conformance.md`
(PC-1, PC-17). Every fix was written test-first: the new or changed test was
run RED for the stated reason, then the code, then GREEN, then a hand
mutant of the fix's core line was run and restored. Each touched test FILE
was run with vitest from its workspace. No e2e suite or e2e session was run
(the planner runs every gate); e2e references to every changed string or body
were updated by grep.

Commits, in order:

| sha | ruling |
|---|---|
| 60e64d66 | PR-1 (PA-1) |
| 5627a9d3 | PR-2 (PC-1 + PA-2) |
| 3c400035 | PR-3 (PA-3) |
| ca8f64d4 | PR-4 (PA-4) |
| 5360615f | PR-5 (PA-7) |
| dd6f5a8a | PA-5 issue file |
| (this file) | report |

PC-17: no commit - see its section (the test already exists).

---

## PR-1 (PA-1) - Apply never overwrites an own value changed after the dialog read - 60e64d66

What changed:

- `app/src/routes/contactRequirementsApply.ts:48` new `E_SEEN` ("each entry
  of units needs seen: exactly its ownItems, each with exactly its keys, each
  value a string, a number, a boolean or null"). `:79` `parseItemValue` - the
  item-value parser `expected` already used, extracted so `seen` is validated
  the same way (`expected` keeps E_EXPECTED / E_EXPECTED_VALUE, unchanged).
  `:143-157` per `units[]` entry, after ownItems: `seen` must be an object
  keyed by EXACTLY the de-duplicated ownItems, each item value with exactly
  its keys; any mismatch (shape or value type) is 400 E_SEEN. `seen` is
  required (`{}` for an entry with no ownItems).
- `app/src/lib/requirements.ts:444` planUnitApply gains
  `seen: Partial<Record<RequirementItemId, ItemValue>>`; `:466-472` a
  changing item that is an own value is written only when it is in ownItems
  AND `itemValuesEqual(unitItemValue(read), seen[id])`; otherwise
  `changed_since_opened` (copy unchanged). A changing item that is not an own
  value ignores `seen`. Doc comment updated.
- Route passes `seen` per unit to planUnitApply.
- `dashboard/src/routes/contact/applyRequirementsModel.ts:163-185`
  `applyRequestBody(rows, items, landlord, units)` - new `units` parameter
  (the dialog's unit read); each row sends
  `seen[id] = unitItemValue(unit, id)` for exactly `row.own`. A row whose
  unit is missing from `units` throws (every row is built from those units).
- `dashboard/src/routes/contact/ApplyRequirementsDialog.tsx:243` passes the
  read `units`.
- `dashboard/src/api/types.ts:2696-2706` wire type: `units[].seen`.
- Callers of the body updated: `dashboard/src/api/endpoints.test.ts`
  (type only), `app/test/unitsApiRequirementsPatch.test.ts:419`
  (`seen: {}`), and the e2e body pin
  `e2e/tests/dashboard-next/property-requirements.spec.ts:364,372-373`
  (`seen: {}` for B; C's `{ pets: { no_pets: null, pets: 'Cats OK',
  pet_fee: null } }` - C is created with pets 'Cats OK' only).

Tests added / changed:

- `app/test/requirementsApplyApi.test.ts:450` the reviewer's scenario: the
  dialog saw 'Cats OK'; the stored unit holds 'Cats and small dogs OK' +
  '$200', set_here -> 200, `updated []`, skipped changed_since_opened,
  unit, updated_at and audits untouched.
- `:470` an own value unchanged since the read is still written (seen sent
  as `{ no_pets: false, pets: ' Cats OK ', pet_fee: '$200' }` - D1 equality).
- `:176-207` eight 400 E_SEEN cases (no seen; seen not an object; missing an
  ownItems item; naming an item not in ownItems; an item missing a key; an
  extra key; an item not an object; a value that is an object).
- Existing ownItems tests now send their seen (`SEEN_CATS_OK`, the
  all-blank-landlord u-own-accepted deposit, the RA-1c race).
- `app/test/requirementsApply.test.ts:122` / `:130` pure planUnitApply:
  skip when seen differs or is absent; write when equal (trimmed); a copied
  item writes whatever seen says. The `plan()` helper defaults `seen` to the
  unit as given (nothing changed since the read).
- `dashboard/src/routes/contact/applyRequirementsModel.test.ts:251` and
  `ApplyRequirementsDialog.test.tsx:263-271` the dialog body carries seen.

RED evidence (before the code):

- `requirementsApplyApi.test.ts:460`
  `AssertionError: expected { updated: [ 'u-p' ], skipped: [] } to deeply equal { updated: [], skipped: [ { ...(2) } ] }`
- the eight 400 cases: `requirementsApplyApi.test.ts:213`
  `AssertionError: expected 200 to be 400`
- `requirementsApply.test.ts:125`
  `AssertionError: expected { Object (kind, patch, ...) } to deeply equal { kind: 'skip', ...(1) }`
- `applyRequirementsModel.test.ts:254`
  `expected { units: [ { ...(2) }, { ...(2) } ], ...(2) } to deeply equal { units: [ { ...(3) }, { ...(3) } ], ...(2) }`;
  `ApplyRequirementsDialog.test.tsx:264` `expected "spy" to be called with arguments: [ 'L1', { ...(3) } ]`

GREEN: app 3 files 108/108 (requirementsApplyApi, requirementsApply,
unitsApiRequirementsPatch); dashboard 3 files 111/111 (model, dialog,
endpoints); app typecheck 0.

Mutants (all killed, all restored):

- M1 planUnitApply `if (!own.has(item.id) || shown === undefined || !itemValuesEqual(current, shown))`
  -> `if (!own.has(item.id))`: 2 RED (requirementsApply `:122`,
  requirementsApplyApi PA-1 `:450`).
- M2 route: the seen exact-ids check no longer returns E_SEEN: 1 RED
  ("400 for seen naming an item not in ownItems"; the other shape cases are
  still caught by parseItemValue, as designed).
- M3 dashboard: the `seen[id] = unitItemValue(unit, id)` loop removed: 2 RED
  (model body test, dialog body test).

## PR-2 (PC-1 + PA-2) - the landlord form's note and legend - 5627a9d3

What changed:

- `dashboard/src/routes/listing/RequirementsFields.tsx:153`
  `publicNote={audience === 'property' && field.kind === 'text' && field.flyer === 'on_flyer'}`
  (header comment updated).
- `dashboard/src/routes/listing/FlyerTag.tsx:40` the landlord legend line is
  now exactly
  `On property flyers - tenants see it once it is copied to a property (a new property, or Apply to properties).`
  The property legend and every tag are unchanged.
- e2e: `e2e/tests/dashboard-next/contact-detail.spec.ts:163` legend pin
  updated. No e2e asserts the public note on the landlord form
  (`toHaveAccessibleDescription(/On property flyers/)` at :187 still holds);
  `e2e/support/selectors.md` does not quote the legend.

Tests:

- `RequirementsFields.test.tsx:87` the note expectation follows the
  audience (`audience === 'property' && kind === 'text' && flyer === 'on_flyer'`).
- `FlyerTag.test.tsx:47` the landlord legend, exact.
- `ContactEditForm.test.tsx:1450` the fieldset's legend regex follows the
  copy.

RED: `RequirementsFields.test.tsx:87` "landlord form: "Pets (details)"" and
"landlord form: "Pet fee"" - `AssertionError: expected true to be false`;
`FlyerTag.test.tsx:46` `expected [ ...(2) ] to deeply equal [ ...(2) ]`;
`ContactEditForm.test.tsx:1450` `expect(element).toHaveTextContent()`.

GREEN: 6 dashboard files 317/317 (RequirementsFields, FlyerTag,
ContactEditForm, TaggedField, ListingEditForm, UnitCreateForm - the
property forms keep their notes).

Mutants (killed, restored): M4 the audience gate dropped -> 2 RED (the two
landlord RequirementsFields cases); M5 the old legend line restored -> 2 RED
(FlyerTag, ContactEditForm).

## PR-3 (PA-3) - consistent landlord re-reads - 3c400035

What changed:

- `app/src/routes/contacts.ts:1256-1266` GET /api/contacts/:contactId:
  `req.query['consistent'] === '1'` -> `contacts.getById(contactId, { consistentRead: true })`;
  anything else (absent, '0', 'true', 'yes', a repeated param) ->
  `contacts.getById(contactId)`, byte-identical to before.
- `dashboard/src/api/endpoints.ts:1474-1488` `getContact(contactId, signal?, options: { consistent?: boolean } = {})`;
  `consistent: true` adds `query: { consistent: '1' }`.
- `dashboard/src/routes/contact/ApplyRequirementsDialog.tsx:166` and
  `dashboard/src/routes/listing/UnitCreateForm.tsx:234` pass
  `{ consistent: true }`. (The dialog has one read effect, so its Try again
  and in-dialog re-reads are consistent too.) No other caller changed.
- e2e: no URL matcher on the contact GET compares a full URL (the only
  matchers use `pathname`, and on PATCH / the Apply POST), so the query
  string breaks nothing.

Tests:

- `app/test/landlordRequirementsPatch.test.ts:68` `?consistent=1` -> the
  repo spy saw exactly `[LL, { consistentRead: true }]`; `:79` it.each over
  '', '?consistent=0', '?consistent=true', '?consistent=yes' -> exactly
  `[LL]`.
- `ApplyRequirementsDialog.test.tsx:113` and `UnitCreateForm.test.tsx:576`
  the caller passes `{ consistent: true }`.
- `dashboard/src/api/endpoints.test.ts:850` getContact sends
  `query: { consistent: '1' }` only when asked. This client test is one
  beyond the ruling's list (route + one per caller); it pins the wire form
  of the flag the callers set, and without it the client half of the change
  is untested.

RED: `landlordRequirementsPatch.test.ts:75`
`expected [ [ 'c-req-landlord' ] ] to deeply equal [ [ 'c-req-landlord', ...(1) ] ]`;
`endpoints.test.ts:856` `expected last "spy" call to have been called with [ '/api/contacts/c%201', { ...(2) } ]`;
`ApplyRequirementsDialog.test.tsx:113` / `UnitCreateForm.test.tsx:576`
`expected "spy" to be called with arguments: [ ..., Any<AbortSignal>, ...(1) ]`.
(The four "any other value" route cases passed before and after, as they
pin today's read.)

GREEN: app 38/38; dashboard 3 files 168/168; dashboard and app tsc 0.

Mutants (all killed, restored): M6 route compares to 'MUTANT' -> 1 RED
(route `:68`); M7 client never adds the query -> 1 RED (endpoints `:850`);
M8 dialog drops the flag -> 1 RED (dialog `:113`); M9 New form drops the
flag -> 1 RED (UnitCreateForm `:576`).

## PR-4 (PA-4) - flyer money - ca8f64d4

What changed: `dashboard/src/routes/public/FlyerPage.tsx:145`
`flyerMoney(amount)` - `Number.isInteger(amount) ? '$' + amount : '$' + amount.toFixed(2)`;
`depositLabel` (`:156`) and `applicationFeeLabel` (`:164`) both use it.
Whole amounts print exactly as before. e2e flyer amounts are whole
(1500, 45, 30 in public-pages.spec.ts; property-requirements.spec.ts
uses One month's rent and No application fee), so no e2e change.

Tests: `dashboard/src/routes/public/FlyerPage.test.tsx:497-508` four plain
its (the file's O-1 note on `$` in it.each titles): Deposit 1250.4 ->
"$1250.40"; Deposit 1250.4 + flexible -> "$1250.40, flexible / payment plan
available"; Application fee 37.5 -> "$37.50"; Application fee 40 -> "$40".
The existing integer cases ("$1800", "$1800, flexible ...") are unchanged.

RED: `FlyerPage.test.tsx:506` `expected '$1250.4' to be '$1250.40'`,
`expected '$1250.4, flexible / payment plan avai...' to be '$1250.40, ...'`,
`expected '$37.5' to be '$37.50'`.

GREEN: 55/55.

Mutants (killed, restored): M10 always `toFixed(2)` -> 3 RED (the public
variant's full-info test and both "$1800" cases); M11 the fee bypasses the
formatter -> 1 RED (fee 37.5).

## PR-5 (PA-7) - name the cause of a lost write - 5360615f

What changed: `app/src/routes/contactRequirementsApply.ts:165-194`
`LOST_WRITE_REASONS` {landlord_changed, deleted, not_found} and
`lostWriteReason`: on a ConditionalCheckFailedException the route re-reads
the unit ONCE with `{ consistentRead: true }`, takes its own
`structuredClone` of the re-read (ruling AR6, as the first read), and runs
the same planUnitApply (`planFor`, `:239`, same items / landlord values /
ownItems / seen); a skip with one of the three reasons is reported as that
reason, anything else stays `changed_during_apply` (`:263`). The
`requirements.ts` planUnitApply doc line on races was updated.

One point the ruling did not spell out: if the RE-READ itself throws, the
route logs a warn ("requirements apply: re-read after a lost write failed
(best-effort)") and keeps `changed_during_apply` instead of failing the
request. I read that as the ruling's "anything else stays
changed_during_apply"; the alternative (the throw propagating) would turn a
reason refinement into a 500 after earlier properties were written. It is
pinned by a test and a mutant below; the planner may prefer the other
reading.

Tests: `app/test/requirementsApplyApi.test.ts:575` the landlord-changed race
on the harness: the wrapper moves the stored unit to OTHER_LL, then calls
the real fenced write (which fails its landlordId condition) -> skipped
`landlord_changed`, the read and ONE consistent re-read
(`[['u-moved', { consistentRead: true }], ['u-moved', { consistentRead: true }]]`),
unit / updated_at / audits untouched. `:603` a re-read that throws keeps
changed_during_apply, the run goes on (u-b updated), one warn logged. The
existing race tests (`a write whose condition fails ...`, `an exception set
between the read and the write ...`, RA-1c) still expect
changed_during_apply - they pin "anything else" (their re-read plans are a
write and changed_since_opened).

RED: `:590` `- "reason": "landlord_changed", + "reason": "changed_during_apply"`;
`:622` `AssertionError: expected [] to have a length of 1 but got +0`.
(The second test first went RED for a muddier reason - its mock threw on
u-b's first read - and was tightened to fail only u-a's second read before
any code was written.)

GREEN: app 3 files 110/110; app typecheck 0.

Mutants (all killed, restored): M12 the re-read result ignored -> 1 RED
(`:575`); M15 every re-read skip reason reported (set filter dropped) -> 2
RED (the two existing race tests: the re-read plan is changed_since_opened
and must stay changed_during_apply); M13 the re-read not consistent (`{}`)
-> 1 RED (`:575`, the read-calls pin); M14 the re-read error rethrown -> 1
RED (`:603`, `expected 500 to be 200`).

## PC-17 - NOT DONE: the proposed test already exists

The conformance reviewer's proposed test (render a landlord with a fixed
deposit, tick "One month's rent", Save, expect `req_deposit_one_month: true`
and `req_deposit: null`) is already on the branch:
`dashboard/src/routes/contact/ContactEditForm.test.tsx:1494-1506`, an
it.each with 'holds a fixed amount' (`req_deposit: 1400`) and 'holds no
amount', asserting the EXACT PATCH body
`{ req_deposit_one_month: true, req_deposit: null }`. It was added in
230ccae4 ("landlord edit form Requirements / Qualifications fieldset (D9)").
PC-17's coverage claim ("the landlord form's wiring ... has no test of this
case") does not hold, so adding the proposal would be a duplicate with a
different amount; I stopped this item.

Evidence the existing test guards exactly what the reviewer named (both
mutants killed, restored):

- M16 `toLandlordPatch` drops null values -> both it.each cases RED.
- M17 the form passes its current values as the baseline
  (`buildRequirementPatch(requirements, requirements)`) -> both cases RED.

If the planner still wants the literal `req_deposit: 500` case added, it is
a one-row addition to that it.each.

## PA-5 - issue file - dd6f5a8a

`docs/issues/requirement-text-no-length-cap.md` from `_TEMPLATE.md`: type
improvement, severity low, status open, area app/requirements. It names the
15 requirement attributes (unit and `req_` landlord keys, with kinds), the
100 KB `express.json` body limit (app/src/app.ts:140) and DynamoDB's 400 KB
item limit, and the suggested cap. `npm run issues` regenerated the
(gitignored) index with the entry.

Where the ruling did not fit the code: it says "the 15 requirement text
attributes". There are 15 requirement attributes per record, but only 8 are
free text (evictions_notes, credit_requirements, income_requirements,
qualifications, pets, pet_fee, deposit_notes, tour_process); the other 7 are
booleans, numbers and the tour-type enum, which their kinds already bound.
The issue lists all 15 with their kinds and says plainly that the 8 text
keys are the uncapped ones (the adversarial finding's "15 new uncapped text
attributes" overcounts the same way).

## Final gates (from the worktree, after the last fix, at dd6f5a8a)

No AWS_ variable was exported in this shell (`env | grep '^AWS_'` empty).
DynamoDB Local was already running and was not restarted.

| command | exit | result |
|---|---|---|
| `npm run typecheck` (root, every workspace) | 0 | 0 `error TS` |
| `npm test -w @housingchoice/app` | 0 | 522 files passed; 10910 passed + 1 skipped (10911); 58.2s; `[dynamoAdmin]` lines 0 |
| `npm test -w @housingchoice/dashboard` | 0 | 263 files passed; 5345 passed |
| `npm test -w @housingchoice/e2e` (vitest unit only; two specs were edited) | 0 | 22 files, 508 passed |

Against the planner's gate run on 763314e5 (app 10891 + 1 skipped,
dashboard 5340): app +19 = exactly the new cases (requirementsApplyApi +12:
8 seen 400s, PA-1, D1 equality, the two PR-5 tests; requirementsApply +2;
landlordRequirementsPatch +5), dashboard +5 (getContact client test, four
flyer money cases); the rest were edits of existing tests. The "error"
JSON lines in the app output are the suites' own injected faults
(ProvisionedThroughputExceededException / "boom" stubs), unchanged.

Not run, by instruction: `npm run smoke`, `npm run e2e`, any e2e session.

Lint (not a gate asked of this wave; a courtesy check): `npx eslint` on the
25 .ts/.tsx files FW5 touched (`git diff --name-only 4a976cec..HEAD`)
exits 1 on 2 errors, both `react-hooks/set-state-in-effect` in
`dashboard/src/routes/public/FlyerPage.tsx` at :192 and :210 - the
`setVariant` and `setStage` effect calls at :185 and :203 on 4a976cec,
shifted +7 lines by `flyerMoney`. They are 2 of the planner's 5
pre-existing errors; FW5-attributed: 0.

## Not done / did not fit

- PC-17: not added - the proposed test already exists (above).
- PA-5: "15 text attributes" is 15 attributes of which 8 are text (above).
- PR-5: the failed-re-read branch is a reading of "anything else", flagged
  above for the planner.
- PR-3: one extra client test (endpoints.test.ts) beyond the ruling's list,
  flagged above.
- The spec's D8 wire shape (`units: [{ unitId, ownItems }]`) now differs
  from the code (`seen` added by PR-1); the spec was not edited (out of
  this wave's scope).
