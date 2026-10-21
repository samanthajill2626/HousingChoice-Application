# Plan review R1 - reviewer B (adversarial, plan + spec + repo only)

Plan: `docs/superpowers/plans/2026-10-20-property-requirements.md` (v1, 26227 lines)
Spec: `docs/superpowers/specs/2026-10-20-property-requirements-design.md` (rev 6)
Repo: `W:\tmp\property-requirements` @ dbde9f58 (main @1d7a4667 + docs), read only.

Method: sections 0-4 read in full; every slice S1-S7 read task by task; every
spec decision D1-D13, D10a and sections 6-7 walked to a task; the mutation
surfaces of `requirement_sources`, the unit requirement keys, the landlord
`req_` keys, `voucher_size_accepted`, `landlordId` and the audience filter's
size grepped across `app/src`, `app/test`, `dashboard/src` and `e2e/`.

Overall: coverage is close to complete and the server-side rules (registry,
classification, fence, Apply plan, matching normalizer) are internally
consistent - I traced the app test cases in Tasks 1.1-1.7, 2.1-2.6 and 3.1-3.2
against the implementation code given and found them coherent. The findings
below are where a builder executing the text LITERALLY goes wrong, or where a
binding ruling is delivered by no step.

---

## 1. [MEDIUM] AR32's binding `deposit_conflict` copy is delivered by no task

**What is wrong.** AR32 (plan section 4) binds two sentences for a 400
`deposit_conflict`: on the property edit form "A deposit can be one month's
rent or a fixed amount, not both. Reload the property and try again." and on
the landlord form (Task 6.9) the same with "Reload the landlord". "The form
stays open with what staff typed." No task implements or tests either.

**Evidence.**
- Task 5.8 Step 3, `ListingEditForm.tsx` `onSubmit` catch block (plan lines
  ~17622-17641): handles 422 `org_not_on_list`, 409 `property_changed`, then
  falls to `"Couldn't save - please try again."`. No `deposit_conflict` branch;
  Task 5.8's T1-T8 tests have no `deposit_conflict` case.
- Task 6.9 Step 3 (plan ~22836-22943) changes only state, `buildPatch` and the
  fieldset; the existing catch block in `ContactEditForm.tsx` (repo
  `dashboard/src/routes/contact/ContactEditForm.tsx:~520-533`) maps
  `caseworker_use_conversion` and otherwise "Couldn't save - please try again."
  Task 6.9's tests have no `deposit_conflict` case.
- S5's own C9 (plan ~13373-13379) states the scenario: a colleague ticks One
  month's rent after this form opened; this form's save sends only `deposit: N`
  -> 400 every time ("saving again repeats it").

**What it implies.** A builder following Tasks 5.8 / 6.9 literally ships the
generic retry message for a 400 that a retry can never clear (the stored
record still holds the other alternative), i.e. a dead end - exactly what the
ruling was written to avoid. Task-anchored reviewers will not see the gap
because no task names it. Add the branch and a test to Tasks 5.8 and 6.9.

---

## 2. [MEDIUM] Section 4 rulings amend slice code blocks that are left contradicting them; one of them dead-ends S5

**What is wrong.** Section 4 "wins over any slice text it contradicts", but
several rulings change code the slices give verbatim ("Replace with", "Create
... with"), and the code blocks were not amended. A builder who copies the
block gets the pre-ruling behavior, a compile error, or a stuck slice.

**Evidence.**
- AR1 vs Task 1.7: the ruling says S1 Task 1.7 adds `Owning landlord`
  (`keys ['landlordId']`, staff_only) as the FIRST `PROPERTY_FORM_FIELDS` row
  and `landlordId` to the walk's `SAMPLE`. Task 1.7's test expectation (plan
  ~4717-4752, 34 rows), its `SAMPLE` (no `landlordId`; `sampleFor` throws on a
  missing key) and its implementation (plan ~4864-4884) all omit it. S5 Task
  5.2's drift test deep-compares the two tables (plan ~14469-14471) and Task
  5.2 Step 4 says "never edit S1's files from this task" (plan ~14851-14852):
  a missed AR1 leaves S5 with a red test it is forbidden to fix.
- AR36 vs Task 6.9: the code imports `requirementFormValuesFrom` and
  `requirementPatch` from `../listing/RequirementsFields.js` (plan
  ~22841-22848, ~22876). Neither exists - S5 ships `requirementFormValuesFromLandlord`,
  `buildRequirementPatch` (returns `{ok, patch} | {ok:false, error}`) and
  `toLandlordPatch` in `requirementForm.ts` (plan ~15194-15285). The literal
  code does not compile, and `ContactEditForm.buildPatch` has no error return
  path (repo `ContactEditForm.tsx:325-350` returns a patch object), so AR36's
  "on r.ok === false the form shows r.error and sends nothing" needs a
  restructure no step describes or tests.
- AR39 vs Task 6.2: Step 3(a) defines a second `WASHER_DRYER_LABELS` in
  `listingFormat.ts` (plan ~20352-20357); AR39 says import it from
  `./requirements.js` (no second copy).
- AR46 vs Task 7.9 Step 8: the step still edits `AGENTS.md`'s gate 5 paragraph
  (plan ~26051-26057) and its Files line lists `AGENTS.md`; AR46 strikes it.
- AR6 (see finding 5) asserts a fact about Task 3.2's code that is false.

**What it implies.** The plan does not "stand on its own" for the slices it
assembled verbatim: correctness depends on the builder reconciling 48 rulings
against 26k lines by hand. Fold each ruling into the code block it changes
(at minimum AR1, AR32, AR36, AR39, AR46).

---

## 3. [MEDIUM] Task 7.4's M1 liveness check runs the wrong app test file and tells the builder to "fix the mutant"

**What is wrong.** Step 5 (plan ~25454-25470) mutates `planUnitApply` (M1) and
says: prove it live with `npx vitest run test/requirements.test.ts
test/blastAudienceRules.test.ts` - "at least one failure in EACH file ... If
either file has no failure, the mutant is not on the tested path: fix the
mutant, never the test." The fallback grep applies only "If S1/S4 named the
files differently".

**Evidence.** `planUnitApply`'s tests are in `app/test/requirementsApply.test.ts`
(Task 1.3, plan ~2371, ~2375-2625). `app/test/requirements.test.ts` (Task 1.1,
plan ~1083-1102) imports and exercises no `planUnitApply`. S1 did name the
file `requirements.test.ts`, so the fallback condition never triggers.

**What it implies.** Under a correct M1 the named file reports 0 failures and
the instruction directs the builder to change a mutant that is in fact on the
path - wasting the cold e2e runs the RED-by-mutation proof costs, or producing
a mutant that no longer tests O1. Name `test/requirementsApply.test.ts`.

---

## 4. [LOW] Task 5.2's mirror code fails Task 5.2's own drift test (tour_type)

**What is wrong.** The dashboard mirror's `readField` (plan ~14702-14708)
reads a `tour_type` field as any trimmed non-empty string; the app reads it
through `isTourType` (plan ~1680). The drift test's `UNIT_RECORDS` includes
`{ tour_type: 'bogus' }` (plan ~14431) and compares `unitItemValue` answers
(plan ~14487-14493): app `null`, mirror `'bogus'`.

**Evidence.** As above; S5's own note (plan ~19512-19514) already predicts the
mirror differs and says the builder will fix it.

**What it implies.** The "implementation" step of Task 5.2 is knowingly wrong;
GREEN is red until the builder improvises a fix. Cheap to correct in the plan
(mirror `TOUR_TYPES` membership), and it removes an avoidable detour.

---

## 5. [LOW] AR6 says S3's Apply route clones the read; it does not

**What is wrong.** AR6: "S2's PATCH route and S3's Apply route both do (S3
Task 3.2 already clones)." Task 3.2's route (plan ~9856-9875) passes the
`getById` result straight to `deps.units.applyRequirements(unit, plan.patch)`.

**Evidence.** The harness `getById` returns the live stored object (repo
`app/test/helpers/twilioWebhookHarness.ts:2886-2888`), and the fake fence
compares that same object with itself (plan ~5737-5745). Only the one race
test mocks `getById` to return a clone (plan ~9603-9626).

**What it implies.** No production defect (the real repo returns a fresh
object), but every other Apply route test runs with a vacuous fence, and a
builder trusting AR6 will not add the clone. Add `structuredClone` in the
route, as AR6 intends.

---

## 6. [LOW] Task 7.4 M3 points at a file that does not hold the rule it mutates, and the revert covers only that file

**What is wrong.** Step 6 (plan ~25485-25502) says: in
`ApplyRequirementsDialog.tsx` "find where a row's STARTING checked state is
computed ... make it always true", then reverts and diff-checks only that file.

**Evidence.** The starting state is `rowIsChecked` in
`dashboard/src/routes/contact/applyRequirementsModel.ts` (plan ~22036-22043);
the dialog only calls it (plan ~23688, ~23829 in Task 6.11's code). A builder
who mutates the rule where it lives (the model) is not reverted by
`git checkout -- .../ApplyRequirementsDialog.tsx`, and the `git diff
--exit-code` proof passes with the mutant still in the tree (caught only later
by Step 7's GREEN run).

**What it implies.** Name the call site in the dialog explicitly, or revert and
diff-check both files.

---

## 7. [LOW] The pure Apply decision and the fenced Apply write disagree on an empty `deleted_at`

**What is wrong.** `planUnitApply` treats `deleted_at: ''` as live and plans a
write (plan ~2440-2441 pins it; ~2682-2683); `applyRequirements` conditions on
`attribute_not_exists(deleted_at)` (plan ~5652-5655) and the fake on
`ownsKey(unit, 'deleted_at')` (plan ~5742), so the same unit is reported
`changed_during_apply`, never `deleted` nor written.

**What it implies.** Edge-only (no writer stores `''` today), but the plan pins
one side of a contradiction. Pick one rule (`isDeleted` = non-empty, per
`unitsRepo.ts:532-534`) for both.

---

## 8. [LOW] AR8 widens D13's audit list beyond "the keys the write actually changed"

**What is wrong.** D13: "The names are the unit keys the write actually
changed". AR8 / Task 2.3 list every normalized body key (`auditFields =
Object.keys(patch)`, plan ~6972) - including a validator-emitted partner that
changes nothing, e.g. a raw `pets: true` on a unit with no `no_pets` audits
`no_pets` (S1 CI-4(b), plan ~893-896, carried through S2).

**What it implies.** Harmless for the forms (they send changed keys only), but
the Activity line can name a field that did not change for raw callers. It is
a planner reinterpretation of an approved spec sentence and should be stated
as a deviation in the handback, or filtered by stored value as Task 1.3 already
does for Apply (`storedValueChanges`, plan ~2650-2655).

---

## Checked and found sound (no finding)

- Mutation surfaces of `requirement_sources` / `landlordId`: create, PATCH,
  Apply, `restoreWithLandlord` (swap and clear), the `addContact` claim, the
  harness, seeds. Grep of `app/src` found no other `landlordId` writer except
  the importer (`app/src/lib/import/apply.ts:1583-1619`), which can only touch
  units without `updated_at` - never one carrying a map through the API.
  `removeContact` refuses the landlord of record (`unitsRepo.ts:1386-1388`).
- Readers: `toUnitFlyer`'s only caller is `public.ts`; the units list GSIs
  project ALL (`app/src/lib/tables.ts:14`; infra tfvars), so the dialog's
  `?landlordId=` read carries the requirement keys; `GET /api/contacts/:id`
  spreads the stored contact (`contacts.ts:1218-1220`); the extraction profile
  is an allowlist (`app/src/jobs/extraction.ts:141-170`), so `req_` keys never
  reach a prompt.
- `bedroomSize` readers are exactly the ones S4 changes (grep of `app/src`,
  `dashboard/src`); e2e posts of the legacy key stay accepted and no e2e reads
  a response `audience_filter` size.
- e2e label sweep: verified `steps.ts:907-908,1161,1515,1683,1887`,
  `contact-detail.spec.ts:63,77`, `listing-activity.spec.ts:28,293,319`,
  `tours-page.spec.ts:329`, `public-pages.spec.ts:239-250,383-410` against the
  new labels; Tasks 7.2/7.3 cover the two collisions and the voucher changes.
  `createShareableUnit` uses no zero fee and no "No pets" text, so AR43's
  no-edit ruling for `public-pages.spec.ts` holds.
- New-file imports in the app (`unitRequirementWrite.ts`,
  `contactRequirementsApply.ts`) use explicit `.js` paths that exist, so gate
  3 (smoke) should hold.
