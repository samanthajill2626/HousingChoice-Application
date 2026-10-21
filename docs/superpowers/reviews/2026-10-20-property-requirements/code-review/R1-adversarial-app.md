# R1 adversarial code review - SERVER (app/) - reviewer RA

- Branch: feat/property-requirements @ 738a2b4e (merge-base = main 3df43172)
- Input: .superpowers/review/pkg-app.txt (23 app commits, 38 files) plus full repo read access.
- Method: intended behavior derived from the code and its tests; every claimed race walked as a
  concrete interleaving; every finding reproduced with a throwaway test written in REGRESSION form
  (asserts the correct behavior, so it FAILS on the current code). Tests were run only after
  .superpowers/gates/final/summary.txt carried `end 2026-10-21T01:51:29-04:00`
  (gate1-4 exit 0; gate5 lint exit 1 - not in app/: `npx eslint` over the 38 touched app .ts files
  exits 0).
- Throwaway files (all deleted by exact name; `git status` clean afterwards except this record's
  directory): app/test/zz-review-ra-fence.test.ts, app/test/zz-review-ra-fence-real.test.ts,
  app/test/zz-review-ra-import.test.ts. No source file was edited (no mutants were needed: the fix
  direction for RA-1 was proven with a test-local repo wrapper).

## Summary

| Severity | Count | Findings |
| --- | --- | --- |
| BLOCKER | 0 | - |
| HIGH | 0 | - |
| MEDIUM | 1 | RA-1 |
| LOW | 3 | RA-2, RA-3, RA-4 |
| INFO | 6 | RA-5 .. RA-10 |

- RA-1 (MEDIUM): the requirements fence (landlordId + requirement_sources) does not cover the item
  VALUES its classification and the deposit rule read, so two concurrent saves of one item can
  record a wrong source, store both deposit forms (shown on the PUBLIC flyer), and let Apply
  silently overwrite a value set on the property.

---

## RA-1 - MEDIUM - the fence does not cover the item values the write was computed from

- Confidence: CONFIRMED (route level on the harness fake, and repo level on DynamoDB Local).
- Where:
  - app/src/repos/unitsRepo.ts:1149-1169 (updateIfRequirementsFenced: conditions are only
    unit exists, landlordId as read, requirement_sources as read, and for Apply not deleted).
  - app/src/lib/unitRequirementWrite.ts:166-190 (planRequirementWrite: classification and
    deposit_conflict are computed from `stored` = the read; the map is written only when it
    CHANGES, line 187).
  - app/src/routes/units.ts:781-822 (writeFencedPatch: retries only when the fence fails).
  - app/src/lib/requirements.ts:431-477 + app/src/routes/contactRequirementsApply.ts:181-205
    (planUnitApply decides own values from the read; the Apply write rides the same fence).
- Root cause: a write's outcome depends on EVERY key of each item it touches (D5 classifies the
  whole item; D1 deposit_conflict merges the whole Deposit item over the read), but the condition
  only compares the map. The dashboard sends DIRTY keys only (dashboard/src/routes/listing/
  requirementForm.ts:82-105 buildRequirementPatch), so partial-item writes are the normal path,
  and any write whose classification leaves the map unchanged (set_here -> set_here,
  copied -> copied) does not move the fence for a concurrent writer.
- Concrete interleavings (all reproduced):
  - RA-1a (wrong source + D6 guard defeated). Landlord req_pets 'Cats OK'. Property pets
    'Cats OK', pet_fee '$25', map {pets: set_here}. A reads; B reads; B saves pets 'Dogs OK'
    (classified set_here, map unchanged, commits); A saves pet_fee null computed on its read
    ({pets:'Cats OK'} == landlord -> copied), its fence still matches, commits. Result: pets
    'Dogs OK' recorded `copied` although it differs from the landlord (the page shows the orange
    "Landlord updated" for a value a colleague set here). A later Apply with ownItems [] treats it
    as not own and overwrites 'Dogs OK' with 'Cats OK'. Either sequential order records set_here
    and Apply skips the unit (control case passes).
  - RA-1b (D1 invariant broken, public flyer). Landlord has no deposit requirement; property
    deposit_notes set, map {deposit: set_here}. A reads; B checks One month's rent (the dashboard
    shape {deposit_one_month: true, deposit: null}, set_here -> set_here) and commits; A's
    {deposit: 900} was checked against A's read (no one-month) and commits. Stored: BOTH
    deposit_one_month and deposit 900. The public flyer returns deposit_one_month true AND
    deposit 900; every later save touching any Deposit key (even deposit_notes) is refused
    400 deposit_conflict until someone clears one side.
  - RA-1c (Apply overwrites an edit made between its read and its write). Property pets
    'Cats OK', map {pets: set_here}; staff chose to replace it (ownItems [pets]). Between Apply's
    read and write a colleague saves pets 'Dogs OK' (map unchanged). Apply's fence matches and the
    write replaces 'Dogs OK'. This breaks the suite's own stated rule
    (app/test/requirementsApplyApi.test.ts "an exception set between the read and the write is
    never overwritten" - that test only covers a race that also changes the map).
- Proof:
  - `cd W:/tmp/property-requirements/app && npx vitest run test/zz-review-ra-fence.test.ts`
    -> `Tests 8 failed | 4 passed (12)`; the RA-1 lines:
    - RA-1a: `expected { pets: 'copied' } to deeply equal { pets: 'set_here' }`;
      `expected [] to deeply equal [ { unitId: 'u-1', ...(1) } ]` (Apply skipped nothing);
      `expected 'Cats OK' to be 'Dogs OK'` (B's value overwritten).
    - CONTROL (both sequential orders): passed.
    - RA-1c: `expected [] to deeply equal [ { unitId: 'u-1', ...(1) } ]`;
      `expected undefined to be 'Dogs OK'`.
    - RA-1b: `expected true to be false` (hasDepositConflict on the stored unit);
      `expected 400 to be 200` (the later deposit_notes save); `expected true to be false`
      (flyer carries both deposit_one_month and deposit 900).
  - `npx vitest run test/zz-review-ra-fence-real.test.ts` (real unitsRepo, DynamoDB Local) ->
    `Tests 2 failed | 1 passed (3)`; logged state after the stale write committed:
    `{"pets":"Dogs OK","pet_fee":null,"requirement_sources":{"pets":"copied"}}` and
    `{"deposit_one_month":true,"deposit":900}`; both stale writes were NOT refused
    (`expected false to be true`).
  - Fix direction proven: the same three races with a test-local repo wrapper that adds a
    revision condition (match the read's `requirements_rev`, then set a new one) all PASS with no
    route change - the existing retry re-reads and recomputes: RA-1a ends set_here and Apply
    skips; RA-1b answers 400 deposit_conflict and stores no conflict; RA-1c is skipped as
    changed_during_apply.
- Why it matters: the fence is the feature's concurrency guarantee for D5/D6 ("a race re-reads
  and recomputes"); its hole defeats the own-value protection Apply exists to respect, can publish
  contradictory move-in costs to tenants, and wedges the Deposit form. Likelihood is low (two saves
  of one property item inside one read-write window, tens of ms), consequence is silent.
- Fix (either):
  1. Add a `requirements_rev` attribute: updateIfRequirementsFenced / applyRequirements condition
     `attribute_not_exists(requirements_rev)` or `requirements_rev = :readRev` and SET a fresh
     value on every write (keep the landlordId and map conditions; claim/restore are still fenced
     by landlordId). Smallest change; proven above.
  2. Or condition every key of each item the patch writes (PATCH) / each changing item (Apply) on
     its read value (`attribute_not_exists(#k)` when the read lacks it, else `#k = :readK`).
  Regression tests: the RA-1a/RA-1b/RA-1c route cases (harness: race the second save inside the
  first `updateIfRequirementsCurrent` / `applyRequirements` call) plus the two repo cases on
  DynamoDB Local; each fails on the current code as shown.

## RA-2 - LOW - the landlord PATCH's deposit_conflict and landlord-only checks are not fenced to its write

- Confidence: CONFIRMED.
- Where: app/src/routes/contacts.ts:1644-1668 (both checks decided on the consistent read),
  app/src/routes/contacts.ts:1882-1893 (contacts.update carries only the classification and staff
  notes guards).
- Scenario:
  - RA-2a: A saves req_deposit 900 while B checks One month's rent ({req_deposit_one_month: true,
    req_deposit: null}). A read before B committed, so A's merged check passes and A commits after
    B: the landlord stores both. Apply then answers 409 deposit_conflict for EVERY item
    (app/src/routes/contactRequirementsApply.ts:159), e.g. an Apply of credit_requirements only,
    until someone edits a Deposit key (a body without a Deposit key is not re-checked).
  - RA-2b: A saves req_pets while B re-types the contact to tenant (B carries the
    classification guard; A has none). A commits after B: req_pets stored on a tenant. Such keys
    cannot be cleared later (the gate also refuses null on a non-landlord).
- Proof: `npx vitest run test/zz-review-ra-fence.test.ts` - RA-2a: `expected true to be false`
  (hasDepositConflict on the stored landlord), `expected 409 to be 200` (Apply of an unrelated
  item); RA-2b: `expected 'Cats OK' to be undefined`.
- Why it matters: a stored conflict blocks Apply wholesale; inert keys on a non-landlord are
  unreachable for cleanup. Low likelihood, recoverable by a deposit edit.
- Fix: ride the existing `expect` guards on contacts.update: when the body carries a req_ key and
  no type change, add `{ attr: 'type', value: stored.type }`; when it carries a Deposit key, add
  guards on `req_deposit` (number | null) and `req_deposit_one_month` (ExpectClause.value needs
  `true` support, contactsRepo.ts:711-714, or use an attribute_exists form). The current 409
  contact_changed path then answers with the fresh contact.

## RA-3 - LOW - a `__proto__` body key reaches the new fenced PATCH; root cause is a pre-existing allowlist hole

- Confidence: CONFIRMED.
- Where: app/src/lib/unitFields.ts:220-221 and :327 (`WRITABLE_FIELDS[key]` is an inherited
  lookup; for `__proto__` it returns Object.prototype, so the key is "known" and
  `fields[key] = value` sets the PROTOTYPE of `fields`); new consumers that read through the
  prototype: app/src/routes/units.ts:2330-2331 (`fenced`) and :785 (`landlordPatch`), then
  app/src/lib/unitRequirementWrite.ts:176-185 (landlordChanged -> map REMOVE).
- Scenario: `PATCH /api/units/:id` with the raw JSON
  `{"__proto__":{"landlordId":"<any landlord id>"},"notes":"x"}` -> 200; landlordId unchanged,
  notes written, requirement_sources REMOVEd, audit row lists only `notes` - the map is wiped with
  no landlord change and no trace. Pre-existing on main (same lookup at unitFields.ts:162 on
  3df43172): `constructor`, `toString`, `valueOf`, `hasOwnProperty` ... pass the strict allowlist
  UNVALIDATED and are stored on the unit with any JSON value.
- Proof: `npx vitest run test/zz-review-ra-fence.test.ts` - validateUnitBody case:
  `expected 'c-ll-2' to be undefined` (fields['landlordId'] inherited); route case:
  `expected undefined to deeply equal { pets: 'set_here' }`; root-cause case logged
  `stored own keys: unitId,landlordId,status,created_at,updated_at,toString,valueOf` with
  `expected 200 to be 400`.
- Why it matters: authenticated callers only, but it bypasses the file's own invariant ("Unknown
  keys are rejected") and gives a silent way to reset where-each-value-came-from.
- Fix: `const kind = Object.hasOwn(WRITABLE_FIELDS, key) ? WRITABLE_FIELDS[key] : undefined;`
  (or a null-prototype table / Map); optionally read `fields['landlordId']` with Object.hasOwn at
  units.ts:785 and :2331. Regression test: the three cases above (400 `unknown field: __proto__`
  / `unknown field: toString`; the map kept).

## RA-4 - LOW - the importer claims a vacant landlord of record without resetting requirement_sources

- Confidence: CONFIRMED (DynamoDB Local, runApply).
- Where: app/src/lib/import/apply.ts:1584 (landlordId fact) and :1606-1619 (human-owned branch:
  `landlordId = if_not_exists(landlordId, :landlordId)`, no REMOVE of requirement_sources).
- Scenario: an imported property whose landlord name was unresolved is edited by staff (a fenced
  write classifies against no landlord -> set_here, stamps updated_at); a later import resolves
  the name and fills landlordId through if_not_exists. D5 says a landlord-of-record change starts
  the map EMPTY (every other writer does: unitsRepo.ts:1510 claim, :1883 restore, PATCH
  unitRequirementWrite.ts:176-185). Blank set_here entries then read as own values against the
  new landlord.
- Proof: `npx vitest run test/zz-review-ra-import.test.ts` -> 1 failed; logged
  `{"landlordId":"8d86230b-...","requirement_sources":{"pets":"set_here"}}`,
  `expected { pets: 'Cats OK', ...(13) } to not have property "requirement_sources"`.
- Fix: drop landlordId from the if_not_exists facts and, when a landlord resolves, send a separate
  `SET landlordId = :l REMOVE requirement_sources` conditioned on `attribute_not_exists(landlordId)`
  (ConditionalCheckFailed = already owned, skip). Regression test: the case above.

## INFO

- RA-5 (code read). Legacy broadcast rows: bedroomSizesOfFilter reads a stored one-number
  `bedroomSize` n as [min(n, 4)] (app/src/lib/blastAudienceRules.ts:231-232; match rule
  voucherSizeMatches below it). Intended by D12 for
  drafts, but it also (a) widens a legacy draft of 5/6/7 to "4 or more" at send, and (b) rewrites
  history on the wire: a SENT share stored with bedroomSize 7 now projects `bedroomSizes: [4]`
  and compat `bedroomSize: 4` (broadcasts.ts:472, :502), and its re-resolved preview lists 4+
  tenants. Worth a conscious yes, or a projection that keeps exact legacy sizes for non-drafts.
- RA-6 (code read). Apply's body check demands EXACTLY each item's registry keys
  (app/src/routes/contactRequirementsApply.ts:96, `rawKeys.length !== keys.length`), while
  requirements_snapshot ignores unknown keys. Adding a field to an item later will 400 every Apply
  sent by an already-open dashboard tab until reload; consider ignoring extra keys and treating
  missing ones as blank, as the snapshot parser does.
- RA-7 (code read). writeFencedPatch reads the landlord of record (consistent) on every attempt
  even when no requirement item changes (a body that only re-sends an unchanged landlordId with
  other fields, units.ts:796-800). Extra read per save, and a contacts-table fault now fails a
  unit save that never read contacts on main. Skip the read when `!touchesRequirements(fields)`.
- RA-8 (code read). The unit_updated field list now means different things by path: fenced =
  keys whose stored value changed, plain = every body key (units.ts:2408-2422). The same resend of
  `beds` is listed or not depending on whether a requirement key rides along. Documented
  (PR1-10) but a trap for any future reader of `fields`.
- RA-9 (code read, cross-feature). Apply of the Touring item writes tour_type onto properties;
  tour_type drives interestedModeFor (app/src/lib/listingSendOutcome.ts:111) and the recipients
  outcome route's 409 tour_type_required branch (app/src/routes/units.ts:1608-1612), so an Apply
  switches every applied property's "interested" outcome from the form to the automatic route.
  Probably intended - confirm it is.
- RA-10 (code read). Apply is per-unit and non-transactional by design; any non-conditional error
  mid-loop (throttle, item-size ValidationException - requirement text has no length cap, like the
  other free-text fields) 500s the request and the units already written are not reported back
  (their audits were appended). Apply also accepts a soft-deleted landlord contact (only pointer
  rows and type are refused, contactRequirementsApply.ts:146-153).

---

## Consumer / mutator sweep

Scope grepped: app/src (routes, services, jobs, repos, lib incl. import/ and seed/), app/scripts,
scripts/, the e2e-facing dev routes, AI extraction (services/extraction, jobs/extraction.ts) and
the public router. "OK" = agrees with the new rules.

### Unit `requirement_sources` (new, server-owned)

| Writer / reader | Where | Verdict |
| --- | --- | --- |
| W: POST /api/units (create, snapshot or landlord) | routes/units.ts:952-967 | OK |
| W: PATCH fenced write | routes/units.ts:781-822, unitRequirementWrite.ts:166-190 | RA-1 (fence gap) |
| W: Apply | contactRequirementsApply.ts:181-205, requirements.ts:475 | RA-1c |
| W: roster claim of the vacant landlord slot (REMOVE) | repos/unitsRepo.ts:1505-1510 | OK |
| W: restoreWithLandlord landlord change (REMOVE) | repos/unitsRepo.ts:1883 | OK |
| W: importer landlord fill (no REMOVE) | lib/import/apply.ts:1584, :1617 | RA-4 |
| W: full seed | lib/seed/cast.ts:1386 | OK (valid ids/values, updated_at stamped) |
| W: client body | lib/unitFields.ts allowlist (absent) | OK - 400 unknown field (tested) |
| R: classification held map | unitRequirementWrite.ts:172 (readRequirementSources) | OK |
| R: Apply own values | requirements.ts:456-461 | OK |
| R: fence condition | unitsRepo.ts:1157-1162 | OK - map equality is key-order-insensitive (probe on DynamoDB Local: read order `touring,pets,credit_requirements`, reversed order also passed) |
| R: public flyer | lib/unitFields.ts:471-512 | OK - never projected |
| R: staff GETs / lists | routes/units.ts (raw item) | OK |

### Unit requirement keys (15 keys; pets/deposit/application_fee/tour_type/tour_process pre-existing)

| Writer / reader | Where | Verdict |
| --- | --- | --- |
| W: validateUnitBody kinds | lib/unitFields.ts:233-318 | OK (legacy boolean pets converted; RA-3 allowlist hole is pre-existing) |
| W: create / PATCH / Apply | as above | RA-1 |
| W: seeds | lib/seed/cast.ts, lean.ts, live.ts, matrix.ts (pets strings, deposit, tour_process) | OK |
| W: importer | lib/import/apply.ts:1523-1586 | OK - writes none of them |
| W: statusTransition, photos, roster writes, dev fixtures | services/statusTransition.ts:382/521/643, routes/dev.ts:1318/1405 | OK - none |
| R: public flyer projection | lib/unitFields.ts:471-512, routes/public.ts:451-464 | OK - only on_flyer keys; staff-only items, subzone, requirement_sources absent |
| R: tour_type -> interested mode | lib/listingSendOutcome.ts:111, routes/units.ts:1610 | OK (RA-9 consequence) |
| R: merge fields / fan-out | lib/mergeFields.ts:64 (beds only), jobs/broadcastFanOut.ts:487 | OK |
| R: tour reminders / relay groups | routes/tourReminders.ts:256, routes/relayGroups.ts:245 (address only) | OK |
| R: similar units | lib/similarUnits.ts:52-57 (subzone/area) | OK |

### Unit landlord of record (`landlordId`) - every change must REMOVE the map (D5)

| Writer | Where | Verdict |
| --- | --- | --- |
| PATCH (fenced, per-attempt I3 check) | routes/units.ts:785-801 | OK (RA-3: a prototype key can fake a change) |
| addContact claim | repos/unitsRepo.ts:1505-1510 | OK |
| restoreWithLandlord | repos/unitsRepo.ts:1876-1883 | OK |
| POST create | routes/units.ts:963 | OK (new unit) |
| importer | lib/import/apply.ts:1584/1617 | RA-4 |
| dev zero-primary fixture (ownerless create) | routes/dev.ts:1405 | OK |
| removeContact / handOffPrimaryFrom / assign-primary-contacts / clean-org-names | unitsRepo.ts, app/scripts | OK - never change landlordId |

### Landlord `req_*` keys on contacts (new)

| Writer / reader | Where | Verdict |
| --- | --- | --- |
| W: PATCH /api/contacts/:id | routes/contacts.ts:785-790, 1644-1668, 1889 | RA-2 (not fenced) |
| W: POST /api/contacts | routes/contacts.ts:1153 | OK - ignored (tested) |
| W: seed | lib/seed/cast.ts:1332-1345 | OK |
| W: importer / AI extraction | lib/import/*, services/extraction/* | OK - never written (tenant `pets` is a different key; PROVENANCE untouched) |
| R: Apply | contactRequirementsApply.ts:167-176 | OK |
| R: unit create / PATCH classification | routes/units.ts:930 (requireLandlordContact), :754/:799 | OK (reads any type - see RA-2b leftovers) |
| R: AI prompt profile | jobs/extraction.ts:150-160 | OK - explicit keys, req_ not read |
| R: public routes | routes/public.ts | OK - no landlord projection |

### Unit `voucher_size_accepted` (number -> list), `subzone` (now staff-only, clearable), `washer_dryer` (new)

| Writer / reader | Where | Verdict |
| --- | --- | --- |
| W: validator | lib/unitFields.ts:233-253, :296-318 | OK (old tabs' bare integer stored as [n]) |
| W: seed | lib/seed/cast.ts:1373 ([2, 3]) | OK |
| R: acceptedVoucherSizes (only reader) | lib/unitFields.ts:464 -> toUnitFlyer | OK - both shapes |
| R: subzone | lib/similarUnits.ts:52-57 | OK (legacy untrimmed values may not match trimmed new ones - negligible) |
| R: flyer washer_dryer | lib/unitFields.ts:511 | OK - validated on read |

### Broadcast `audience_filter.bedroomSizes` / legacy `bedroomSize`

| Writer / reader | Where | Verdict |
| --- | --- | --- |
| W: POST /api/broadcasts | routes/broadcasts.ts:225-243 | OK (list wins over legacy; stored only when non-empty) |
| W: seeds | lib/seed/matrix.ts:1232, :1271; performance.ts (no size) | OK |
| R: resolver (estimate, preview, send) | services/audienceResolution.ts:161, :202 | OK - RA-5 legacy widening |
| R: wire projections | lib/blastAudienceRules.ts:268-281 <- broadcasts.ts:472, 502, 1009 | OK - RA-5 history |
| R: storedFilterRefusal | routes/broadcasts.ts:682-705 | OK - authorities only |

### Audit `unit_updated` (`fields`, `reason: requirements_applied`)

| Writer / reader | Where | Verdict |
| --- | --- | --- |
| W: PATCH (fenced changed keys / plain body keys) | routes/units.ts:2408-2422 | OK (RA-8) |
| W: Apply (best-effort) | contactRequirementsApply.ts:207-219 | OK |
| R: property Activity projection | routes/units.ts:382-391 | OK - reason lifted only for exactly requirements_applied |
| R: contact timeline | routes/contactTimeline.ts:311 | OK |

### Other checks (no finding)

- Apply authorization/scope: a unit of another landlord is skipped (planUnitApply) and fenced
  (landlordId condition); a soft-deleted unit is skipped and fenced (`deleted_at` absent or '').
- Injection: every UpdateExpression aliases names and values; Apply/snapshot/req_ parsers read
  fixed registry keys only (no attacker-chosen attribute names).
- Logging/PII: ids and counts only; audit payloads carry key names, never values.
- ASCII: no non-ASCII on added app lines. Lint: touched app .ts files clean.
- D11 flyer compat: voucher_size, deposit, application_fee, pets kept; pets is now string|null
  (a legacy boolean false reads as no_pets true, which an old cached flyer bundle does not know -
  transitional only).
