# Plan review R1 - reviewer A (adversarial, plan-anchored)

Plan: `docs/superpowers/plans/2026-10-20-property-requirements.md` (PLAN v1, 26227 lines).
Spec: `docs/superpowers/specs/2026-10-20-property-requirements-design.md` (rev 6).
Repo read at the worktree tip (dbde9f58, main @1d7a4667 + docs). Read-only; nothing run but
grep / sed / reads. Two read-only explore sub-agents enumerated (a) every unit `landlordId` /
unit-attribute writer and (b) every reader/writer of the touched attributes; their results
were spot-checked and are cited below where used.

Overall: spec coverage is close to complete - every D1-D13 decision, the section 6 test list
and the section 7 file list map to a task, and the mutation-surface enumeration (plan 3.1)
matches the code (see "Surfaces checked" at the end). The findings are where a builder who
executes the text LITERALLY hits a contradiction between a binding assembly ruling (section
4) and the slice code it is supposed to override, or a step whose pass/fail signal is wrong.

---

## F1 [MEDIUM] AR32's deposit_conflict copy is bound but no task implements or tests it - both forms keep the generic error, which repeats on every retry

What is wrong. AR32 binds two sentences for a 400 `deposit_conflict`:
"A deposit can be one month's rent or a fixed amount, not both. Reload the property and try
again." (property edit form) and the "... Reload the landlord and try again." variant (landlord
form, "S6 Task 6.9"), "The form stays open with what staff typed." Neither Task 5.8 nor Task
6.9 contains the strings, a branch for `err.code === 'deposit_conflict'`, or a test.

Evidence.
- AR32: plan :754-759.
- Task 5.8's catch handles only 422 org_not_on_list and 409 property_changed, then
  `setError("Couldn't save - please try again.")` (plan :17621-17640). Its tests (T1-T8,
  plan :16951-17335) have no deposit_conflict case.
- Task 6.9 adds no error mapping (plan :22836-22943); `ContactEditForm` today maps any other
  failure to `"Couldn't save - please try again."` (`dashboard/src/routes/contact/ContactEditForm.tsx:533`).
- `grep -n "Reload the property\|Reload the landlord"` over the plan finds only AR32 itself.
- S5 CI-9 (plan :13373-13379) describes the dead end the ruling was meant to fix: a colleague
  ticks One month's rent after this form opened; staff type an amount; the PATCH sends only
  `deposit: N`; the server answers 400 `deposit_conflict` (plan :7849-7952) and every retry
  sends the same body.

Implies. A binding ruling ships undelivered unless the builder invents the branch, the copy
placement and the tests. Without it staff hit a silent, repeating "Couldn't save" with no cue
to reload. Add the branch + one test to Task 5.8 (property form) and Task 6.9 (landlord form).

---

## F2 [MEDIUM] AR1 rewrites Task 1.7 (Owning landlord row) but Task 1.7's code and exact-list test still have 34 rows; S5 then forbids editing S1 files, so a literal S1 build blocks at Task 5.2

What is wrong. AR1 makes `{ label: 'Owning landlord', keys: ['landlordId'], flyer: 'staff_only' }`
the FIRST `PROPERTY_FORM_FIELDS` row "in the app module (S1 Task 1.7 adds it, and the D10a
walk's sample unit gains a landlordId)". Task 1.7 was not updated: its expected list, its
`SAMPLE` map and its implementation all omit the row.

Evidence.
- AR1: plan :632-639 ("The 35-row list in S5 Task 5.2 is the binding content; S1 Task 1.7's
  list must equal it row for row").
- Task 1.7 test: exact 34-row `toEqual` starting at 'Housing authorities' (plan :4717-4752);
  `SAMPLE` has no `landlordId` (plan :4574-4608), so `sampleFor('landlordId')` would throw once
  the row exists.
- Task 1.7 implementation: `PROPERTY_FORM_FIELDS` starts with 'Housing authorities'
  (plan :4864-4884).
- S5 Task 5.2's drift test deep-compares the two tables (`expect(mirror.PROPERTY_FORM_FIELDS).toEqual(app.PROPERTY_FORM_FIELDS)`,
  plan :14469-14471) against a 35-row mirror (plan :14788-14824), and its Step 4 says "If
  PROPERTY_FORM_FIELDS differs, the planner's C1 ruling decides which side is wrong; never
  edit S1's files from this task" (plan :14851-14852).

Implies. If S1 is built from the task text, S5 Task 5.2 cannot go green without editing S1's
committed files, which S5 forbids - false independence between S1 and S5. Fold AR1 into Task
1.7's test, SAMPLE and code so the slice text is self-consistent.

---

## F3 [MEDIUM] The dashboard mirror's `readField` reads `tour_type` as free text; the app reads it through `isTourType`, so Task 5.2's own drift test is red as written

What is wrong. The app registry reads a stored `tour_type` that is not a TourType as blank
(`if (field.kind === 'tour_type') return isTourType(raw) ? raw : null;`). The mirror has no
`tour_type` branch: it falls through to the text branch and returns any trimmed non-empty
string. The mirror's drift fixture includes `{ tour_type: 'bogus' }`, so `unitItemValue`
disagrees on it.

Evidence.
- App: plan :1675-1682 (Task 1.1 `readField`).
- Mirror: plan :14700-14708 ("text and tour type a trimmed non-empty string").
- Drift fixture: `{ tour_type: 'bogus' }` (plan :14431) and the agreement assertion
  (plan :14487-14493).
- S5's own note admits it and defers: "`tour_type` as trimmed text (no enum check); if the
  app differs, the drift test fails and S5's builder changes the mirror" (plan :19512-19514).
  No assembly ruling resolves it; the mirror also needs a tour-type list it does not import
  (the dashboard has `TOUR_TYPE_LABELS`, `dashboard/src/api/types.ts:907-911`).
- Same class, smaller: Task 5.2 tells the builder to copy every app-suite `it` the mirror's
  exports touch (plan :14376-14384); that includes the app's "is frozen" case (plan :1196-1202),
  which fails against the unfrozen mirror (plan :14609-14673).

Implies. The plan ships code it knows fails its gate; the builder must improvise the fix
(and freezing). If someone "fixes" the test instead, the dashboard would show tags and Apply
own-value marks that disagree with the server for an invalid stored tour type. Correct the
mirror code in the plan.

---

## F4 [MEDIUM] Task 7.4's RED-by-mutation liveness check runs the wrong app test file for the planUnitApply mutant, and its rule then says "fix the mutant"

What is wrong. Step 5 proves M1 (planUnitApply skips null keys) and M2 (exact voucher match)
live with `npx vitest run test/requirements.test.ts test/blastAudienceRules.test.ts`, expecting
"at least one failure in EACH file". planUnitApply's cases are not in `test/requirements.test.ts`.

Evidence.
- Step 5: plan :25464-25470 ("If either file has no failure, the mutant is not on the tested
  path: fix the mutant, never the test").
- `test/requirements.test.ts` (Task 1.1, plan :1068-1489) imports no `planUnitApply`;
  planUnitApply's suite is `app/test/requirementsApply.test.ts` (Task 1.3, plan :2371,
  :2383-2390).
- The fallback grep is conditioned on "If S1/S4 named the files differently" - they did not;
  the plan named them.

Implies. Executed literally, the M1 check shows zero failures and instructs the builder to
rework a correct mutant. Name `test/requirementsApply.test.ts`.

---

## F5 [LOW] Task 7.4's mutant M3 points at ApplyRequirementsDialog.tsx for the row's starting state; the rule lives in applyRequirementsModel.ts

What is wrong. M3: "in `ApplyRequirementsDialog.tsx` find where a row's STARTING checked state
is computed ... and make it always `true`". The starting state is `rowIsChecked` in the model
(Task 6.7); the dialog only calls it twice (`checkedRows` and each checkbox's `checked`). The
revert step reverts only the dialog file.

Evidence. Plan :25486-25502 (M3); `rowIsChecked` plan :22038-22043; dialog calls plan :23688
and :23829.

Implies. Ambiguous mutation point; a builder who mutates the model (the real site) leaves it
un-reverted. Name the model function and revert both paths.

---

## F6 [LOW] AR6 says S3 Task 3.2 "already clones" the unit read; it does not

What is wrong. AR6 requires every caller of `applyRequirements` to pass its own
`structuredClone` and asserts "S3 Task 3.2 already clones". The Task 3.2 route passes the
`getById` result itself.

Evidence. AR6 plan :663-667; route plan :9857-9868
(`const unit = await deps.units.getById(...)` then `deps.units.applyRequirements(unit, plan.patch)`).
The harness `getById` returns the live stored object (`app/test/helpers/twilioWebhookHarness.ts:2886-2888`),
and the fake fence compares stored with read by value (plan :5725-5745).

Implies. A builder who trusts AR6's factual claim adds nothing; on the fake, the Apply fence
then compares the stored unit with itself and can never lose except through the one test that
mocks `getById` to return a clone (plan :9603-9626). Production (fresh objects from DynamoDB)
is unaffected. Fix the sentence or the code.

---

## F7 [LOW] S6 tasks are written against helper names and copies S5 does not ship; the rulings repair them only in prose

What is wrong.
- Task 6.9 imports `requirementFormValuesFrom` / `requirementPatch` from
  `RequirementsFields.js` (plan :22841-22858, :22876) - S5 exports neither; AR36 remaps to
  `requirementFormValuesFromLandlord` / `buildRequirementPatch` / `toLandlordPatch`
  (plan :776-784). `buildRequirementPatch` returns `{ ok: false, error }` for a bad amount
  (plan :15222-15245); the 6.9 tests (plan :22723-22826) never exercise that path, so the
  error branch AR36 requires ("shows r.error and sends nothing") ships untested.
  (`ContactEditForm.buildPatch` already returns `ContactPatch | { error }`,
  `ContactEditForm.tsx:305-309`, so the wiring is small.)
- Task 6.2 Step 3 defines a second `WASHER_DRYER_LABELS` in `listingFormat.ts`
  (plan :20352-20357); AR39 forbids it and says import from `./requirements.js`
  (plan :791-796).
- Task 7.9 Step 8 and its Files list still edit `AGENTS.md` (plan :25879-25880,
  :26051-26056); AR46 strikes that half (plan :822-824).

Implies. Each is recoverable because section 4 wins, but every one is a place where the
literal task and the binding ruling disagree; a builder applying the code blocks verbatim
produces non-compiling code (6.9), a duplicated constant (6.2) or an edit to a governance
file the planner struck (7.9). Fold the rulings into the task text.

---

## F8 [LOW] planUnitApply treats an empty `deleted_at` as live; the Apply write's condition treats it as deleted

What is wrong. planUnitApply skips `deleted` only for a non-empty stamp and pins that an empty
stamp is writable; `applyRequirements` conditions on `attribute_not_exists(deleted_at)`, which
fails for `deleted_at: ''`.

Evidence. plan :2682-2683 and the pin :2440-2441; repo condition plan :5652-5655; fake
`ownsKey(unit, 'deleted_at')` plan :5742.

Implies. Such a row (no writer produces one today; `isDeleted`, `unitsRepo.ts:532-534`)
would be reported `changed_during_apply` on every Apply forever. Worth one sentence: align the
two (either condition `attribute_not_exists OR = ''`, or skip as deleted in the plan).

---

## F9 [LOW] One landlord-of-record writer is missing from the spec and plan enumeration: the importer's import-owned branch REPLACES `landlordId`

What is wrong. Spec section 2 and plan 3.1 describe the importer as filling an ABSENT
`landlordId` only. Its import-owned branch is a plain `SET landlordId = :v` (condition
`attribute_not_exists(updated_at)`), which overwrites an existing landlord.

Evidence. `app/src/lib/import/apply.ts:1584` (fact), `:1604-1609` (plain SET under
`attribute_not_exists(updated_at)`), `:1615-1619` (human-owned `if_not_exists`); spec :96-103,
:423-426; plan :597 (WATCH "importer fill of landlordId").

Implies. Benign today: every create, PATCH and Apply stamps `updated_at`
(`unitsRepo.ts:1020-1027`; plan :5633-5635), so an import-owned unit can never hold a
`requirement_sources` map to go stale. Record it in the WATCH row so a later change to the
importer or to `updated_at` stamping does not silently break D5's landlord-change reset.

---

## Surfaces checked (no finding)

- Unit `landlordId` writers: create, PATCH (now fenced), `addContact` claim, `restoreWithLandlord`
  (swap and clear, AR7), importer (F9), seeds, perf seed, dev zero-primary fixture.
  `removeContact`, `handOffPrimaryFrom`, `assignPrimaryIfCurrent`, restore, softDelete,
  `rewriteAcceptedAuthorities`, status transitions and media writes never touch `landlordId`
  or the map (`unitsRepo.ts` / `services/statusTransition.ts`). No unit TransactWrite exists.
- `requirement_sources` readers: only the dashboard card / dialog and the Apply route; the
  public flyer allowlist excludes it (plan :4029-4045); unit GSIs project ALL
  (`app/src/lib/tables.ts:14,60`), so `GET /api/units?landlordId=` (the dialog's read) carries it.
- `voucher_size_accepted` readers: `acceptedVoucherSizes` (app + mirror), `toUnitFlyer`,
  `ListingDetail`, both forms, `BroadcastComposer`, `unitListFacets` (list-ready). All covered.
- `bedroomSize` readers/writers: `parseAudienceFilter`, `wireAudienceFilter`, the resolver, the
  matrix seed, dashboard composer / filters / summary / draft key, 7 e2e legacy POSTs (still
  accepted). All covered by S4.
- `subzone` public exposure: `toUnitFlyer`, the FlyerPage H1 and the tap-to-text SMS prefill
  both go through `neighborhood()`, which Task 6.6 reduces to `area`. Similar-units summary is
  staff only.
- No AI prompt or outbound message serializes a whole unit (`lib/mergeFields.ts:46-71`,
  `jobs/extraction.ts:142-170`).
- e2e substring-label sweep (plan :24469-24502) re-checked against `e2e/`; the tenant-form
  `Notes` / `Pets` / `Evictions` selectors stay valid because the fieldset is landlord-only.
- Dashboard `Contact` and `UnitItem` both carry `[key: string]: unknown`
  (`dashboard/src/api/types.ts`), so the `Record<string, unknown>` helpers type-check;
  dashboard `lib` is ES2022 (`Object.hasOwn` in the app module compiles in the drift test).
