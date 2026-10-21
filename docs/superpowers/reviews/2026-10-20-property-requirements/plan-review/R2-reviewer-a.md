# Plan review round 2 - reviewer A - property requirements (tracker #11 + #12)

Plan under review: `docs/superpowers/plans/2026-10-20-property-requirements.md`
v2 @51893e3a (diffed against v1 @dbde9f58). Spec rev 6. Inputs also read:
`R1-reviewer-b.md`, `adjudications.md`. Repository read-only; nothing run that
writes, starts servers or runs suites. Plan line numbers are v2.

Order follows the brief: new problems first, then the unreviewed changes,
then the adjudications, then whether the fixes are correct.

## 1. New findings

### N1. [MEDIUM] Task 6.9's new `ok: false` test can never pass: native constraint validation stops the submit before `onSubmit` runs

What is wrong. PR1-7 accepted "the `ok: false` branch of
`buildRequirementPatch` gets a test". v2 delivers it as a ContactEditForm
component test (plan :23218-23231): it sets `Fixed amount` to `-5` with
`fireEvent.change`, clicks Save, and expects
`findByRole('alert')` to read `Fixed amount must be a number 0 or greater.`
That alert can never appear:

- The `Fixed amount` control S5 renders is `type="number" min={0} step={1}`
  (plan :16815-16823, RequirementsFields), and ContactEditForm's form has no
  `noValidate` (`dashboard/src/routes/contact/ContactEditForm.tsx:570`).
- The dashboard runs tests under jsdom (`dashboard/vite.config.ts:134`),
  version 25.0.1 (`node_modules/jsdom/package.json:3`). The Save button is
  `type="submit" form="contact-edit-form"` (`ContactEditForm.tsx:564`); its
  activation calls `form._doRequestSubmit` (`node_modules/jsdom/lib/jsdom/living/nodes/HTMLButtonElement-impl.js:19-24`),
  which calls `requestSubmit` (`HTMLFormElement-impl.js:87-93`), which returns
  WITHOUT firing `submit` when `!this.reportValidity()` (`HTMLFormElement-impl.js:113-116`).
  `-5` against `min=0` is `rangeUnderflow` (`HTMLInputElement-impl.js:998-1011`),
  so the form is invalid, no submit event fires, `onSubmit` (`:570`) never
  runs, `buildPatch` never runs, `error` stays null, and the `role="alert"`
  paragraph (`:1029-1033`, conditional on `error !== null`) is never rendered.
  `findByRole('alert')` times out. The test is red as written.
- No existing dashboard test submits an out-of-range number through a form
  (grep of `dashboard/src/**/*.test.tsx` for `rangeUnderflow` / negative
  values against `min={0}` inputs: none), so nothing in the repo shows the
  writer that this path works.

What it implies.

1. A literal builder hits a red test in Task 6.9 and must improvise. The
   obvious improvisation - adding `noValidate` to `contact-edit-form` - turns
   off native validation for every constrained input on the contact form, a
   shipped behavior change no ruling authorizes.
2. The branch is unreachable in a real browser for the same reason: a
   negative is caught by `min=0`, a fraction by `step=1`, and letters cannot
   be typed into a number input (the test's own comment, :23222-23224). So
   `ok: false` is defensive only, and a component test cannot reach it
   without disabling the browser behavior that makes it unreachable.
3. PR1-7's "the `ok: false` branch gets a test" is therefore NOT delivered by
   v2's new test. The real coverage is the unit level, which v2 already has:
   `requirementForm.test.ts` pins the same message (plan :15367-15371,
   :15404).

Fix (smallest). Drop the component test, or rewrite it to what does happen:
after the click, `expect(within(fieldset()).getByLabelText('Fixed amount')).toBeInvalid()`
and `expect(updateContact).not.toHaveBeenCalled()` - both true under jsdom 25.
Leave the `ok: false` -> `{ error }` wiring in buildPatch (harmless) and let
the unit test own the branch.

### N2. [LOW] PR1-10 / PR1-10a make `unit_updated` contents depend on which write path a body takes

What is wrong. v2 computes `fields` two ways (Task 2.5,
`const auditFields = changedTo !== undefined || touchesRequirements(fields) ? plan.auditFields : Object.keys(fields);`):

- Fenced path (a requirement key or `landlordId` in the body): only keys
  whose stored value changes (`changedKeys`, Task 2.3 :7117), and an empty
  list appends NO row (PR1-10a, route `if (auditFields.length > 0)`, test
  :7689).
- Plain path (everything else): `Object.keys(validation.fields)`, today's
  behavior - every re-sent key, changed or not, and a row even when nothing
  changed.

So the same no-op save produces a "Property updated" Activity line listing
every key when the body holds only plain keys (e.g. `{ beds: 2 }` re-sent on
a 2-bed unit), and no line at all once one unchanged requirement key rides
along (`{ beds: 2, income_requirements: '3x rent' }` re-sent unchanged; the
:6815-6825 case shows `beds` dropped on the fenced path). D13's "the unit
keys the write actually changed" (spec) is honored on one path only.

Second, PR1-10a's cited reason (plan :882-885, :8524-8529) is the tombstone
no-op at `app/src/routes/units.ts:2122-2129`. That comment argues against
BOTH effects of a no-op save - "would stamp `updated_at` and append a bare
'Property updated' activity row for a change that did not happen" - and
returns the unchanged unit without writing. PR1-10a keeps the stamp and drops
only the row, so the citation supports half of the ruling.

What it implies. No data loss; the Activity feed is inconsistent for no-op
saves and the audit rule is path-dependent. Consequence is low because the
dashboard forms are the main callers. No code change is demanded: record the
asymmetry in plan 4.1 under PR1-10a (the plain path is unchanged by design,
and the fenced path still stamps `updated_at`) so a later reader does not
treat either path as the D13 reference.

## 2. The v2 changes, reviewed cold

Each change below was read in v2 and checked against the repo. None needs a
change beyond N1 and N2.

- **S1 Task 1.7 (PR1-2).** The table now carries 35 rows including Owning
  landlord, and the SAMPLE carries `landlordId`; the list equals S5 Task
  5.2's, so the S5 drift test is green against S1 as written.
- **S2 Task 2.1 (PR1-8).** The condition
  `(attribute_not_exists(#expectedDeletedAt) OR #expectedDeletedAt = :blankDeletedAt)`
  with `:blankDeletedAt = ''` matches `isDeleted`'s reading of `''` as live.
  The new parity case stores `deleted_at: ''`; that is storable because the
  document client sets only `removeUndefinedValues: true`
  (`app/src/lib/dynamo.ts:82-90`, no `convertEmptyValues`), so the case is
  real on DynamoDB Local. The fake's `(requireLive && isUnitDeleted(unit))`
  mirrors it.
- **S2 Tasks 2.3 / 2.5 (PR1-10, PR1-10a).** `changedKeys` is correct for the
  three shapes it must handle: a SET to a different value (`isDeepStrictEqual`,
  so list order counts - as it does in storage), a REMOVE of a held key
  (`value === null` -> `hasKey`), and never `requirement_sources` or an
  `undefined`. The map can change only alongside a value change or a
  landlord change (the :6800-6813 case shows an unchanged re-send leaves the
  map out of the patch), so PR1-10a cannot drop a row for a write whose only
  effect is a tag flip. See N2 for the path asymmetry.
- **S3 Task 3.2 (PR1-6).** The route reads once, `structuredClone`s once, and
  passes the clone to both `planUnitApply` and `applyRequirements`; the race
  test wraps `applyRequirements` with `getById` unmocked and asserts the
  passed read is not the live harness object. The fake fence now compares
  against a snapshot, as AR6 intended.
- **S5 Task 5.2 (PR1-3).** The mirror reads `tour_type` through
  `TOUR_TYPE_SET = new Set(Object.keys(TOUR_TYPE_LABELS))`, a value import
  from the api barrel at module scope. The dashboard tests that mock the api
  barrel spread `importActual`, so `TOUR_TYPE_LABELS` is defined when the
  mirror module initializes. The added drift fixtures (`' pm_team '`, `7`,
  `req_tour_type: 'bogus'`, `' landlord_led'`) now agree between app and
  mirror. Freezing is tested.
- **S5 Task 5.8 / S6 Task 6.9 (PR1-1).** Both forms catch
  `err.status === 400 && err.code === 'deposit_conflict'`, render the bound
  copy, and keep the form open. The 6.9 anchors are right
  (`DEPOSIT_CONFLICT_COPY` after `CASEWORKER_USE_CONVERSION`,
  `ContactEditForm.tsx:108`; the catch branch before the generic else,
  `:525-533`). Both tests submit a VALID amount (1200), so they are reachable
  under constraint validation, unlike N1.
- **S6 Task 6.9 imports (PR1-7).** `RequirementsFields`,
  `buildRequirementPatch`, `requirementFormValuesFromLandlord`,
  `toLandlordPatch` and `RequirementFormValues` are all names S5 exports. The
  `buildPatch` wiring returns `{ error }` through the existing
  `ContactPatch | { error: string }` contract (`ContactEditForm.tsx:305-309`,
  handled at `:479-483`). Only the new `ok: false` test is wrong (N1).
- **S6 Task 6.2 and the import cycle.** `listingFormat.ts` importing
  `WASHER_DRYER_LABELS` from `./requirements.js` while `requirements.ts`
  imports `formatMoney` from `./listingFormat.js` is a cycle, but each side
  uses the other's binding only inside function bodies, so ESM evaluation
  order cannot hit a TDZ. Holds only while that stays true: a module-scope
  use (for example a frozen table built with `formatMoney`) would break it.
  The task note says function-body only; adequate.
- **S6 follow-on: FlyerPage imports `WASHER_DRYER_LABELS` from
  `../listing/requirements.js`.** The dashboard has no route-level code
  splitting, so the public page already ships that module; no bundle or
  boundary cost. Accepted.
- **S7 Task 7.4 (PR1-4, PR1-5).** M1's anchor and liveness file
  (`requirementsApply.test.ts`, plus `blastAudienceRules.test.ts`) are where
  the `planUnitApply` cases live; M3 now targets `rowIsChecked` in
  `applyRequirementsModel.ts` with `applyRequirementsModel.test.ts` as its
  liveness check; Step 7 reverts all three files in one diff.
- **S7 Task 7.9.** No longer edits AGENTS.md (AR46 applied).
- **Plan 3.1 WATCH row (PR1-9).** Its premise holds: `unitsRepo.create`
  stamps `updated_at` (`app/src/repos/unitsRepo.ts:1027`), PATCH and Apply
  go through stamping writes, and the importer's fact write is conditioned on
  `attribute_not_exists(updated_at)` (`app/src/lib/import/apply.ts:1607`,
  ownership line documented at `:1461-1467`). So a unit holding a map is
  never import-owned. The watch disposition is right.
- **Fresh sweep, perf harness.** The plan's claim that no route contract
  changes holds: the dialog's `GET /api/units?landlordId=&limit=` fires on a
  click, and the property page already reads the landlord contact on the
  with-landlord branch (`e2e/performance/routes.ts:909-912`).

## 3. Adjudications

- PR1-1, PR1-2, PR1-3, PR1-4, PR1-5, PR1-6, PR1-8, PR1-9: concede the rulings
  and severities; the v2 fixes deliver them (section 2).
- PR1-7: CONTESTED in one clause only. "The `ok: false` branch of
  `buildRequirementPatch` gets a test" is not delivered - the v2 test cannot
  pass and the branch cannot be reached through the form (N1, with jsdom and
  form file:line). The other clauses (imports, one `WASHER_DRYER_LABELS`, no
  AGENTS.md edit) are delivered.
- PR1-10: concede the ruling (it was B's finding and corrects AR8). Its
  consequence is recorded as N2.
- PR1-10a: not contested as a decision; its citation supports only half of
  it (N2).

## 4. Are the fixes correct or merely plausible

Correct, verified against the repo: PR1-1, PR1-2, PR1-3, PR1-4, PR1-5,
PR1-6, PR1-8, PR1-9, PR1-10, and the S6 follow-on. Merely plausible: the
PR1-7 `ok: false` test (red as written, N1). Implemented but inconsistent
across write paths: PR1-10a (N2).
