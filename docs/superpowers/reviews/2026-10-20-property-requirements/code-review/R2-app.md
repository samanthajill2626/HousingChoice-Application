# R2 code review - SERVER (app/) - reviewer R2A (fresh, round 2)

- Branch: feat/property-requirements @ 83ec4ee3 (FW1a ends 2aa30812; FW1b on top), merge base
  main 3df43172.
- Inputs: R1-adversarial-app.md, adjudications.md, build/FW1a-app.md, .superpowers/review/
  pkg-fw1-app.txt (the fix diff) and pkg-app-fw1.txt (the feature's server diff after the fix),
  the spec (rev 6), full repo read access.
- Order of work, as charged: (1) a sweep for what round 1 missed, (2) the fix diff reviewed cold,
  (3) adjudication challenges, (4) the fixes proven by mutants.
- Gate: no file was created under app/ and no test was run until
  .superpowers/gates/fw1/summary.txt carried `end 2026-10-21T04:13:27-04:00` (gate1-4 exit 0;
  gate5 exit 1 = the 5 pre-existing dashboard react-hooks errors named in adjudications.md -
  BroadcastComposer.tsx x2, useComposerDraft.ts x1, FlyerPage.tsx x2; the 39 app files lint clean).
- Throwaway files (both deleted by exact name; `ls app/test/zz-review-r2a-*` -> no such file):
  app/test/zz-review-r2a-fence-values.test.ts (parity: harness fake + DynamoDB Local),
  app/test/zz-review-r2a-contacts.test.ts (route level, harness). Mutants: 7, each made and
  reverted with the Edit tool, each revert proven with `git diff --exit-code -- <file>`; a final
  `git diff --exit-code -- app/src app/test/helpers` was clean and the 7 fix-wave suites re-ran
  317/317. The dashboard's zz-review-r2d-* files and the modified
  dashboard/src/routes/contact/LandlordRequirementsCard.tsx in `git status` are reviewer R2D's
  concurrent work, not touched here. No mutant touched app/src/lib/requirements.ts (the one app
  module a dashboard test imports).

## Summary

| Severity | Count | Findings |
| --- | --- | --- |
| BLOCKER | 0 | - |
| HIGH | 0 | - |
| MEDIUM | 0 | - |
| LOW | 1 | R2A-1 |
| INFO | 4 | R2A-2 .. R2A-5 |

Every FW1a fix is REAL (mutant-killed). The fix diff's new code (the item-value fence, the
contacts guards, the attribution, the own-key allowlist, the skipped landlord read) holds under
every value shape and interleaving tried; the only defects are a pre-existing-class gap the
fix wave's own ruling left open (R2A-1) and four INFO notes.

---

## New findings

### R2A-1 - LOW - CONFIRMED - a plain re-type away from landlord strands the contact's req_ keys (RA-2b's end state, without a race)

- Where:
  - app/src/routes/contacts.ts:1677-1687 - the landlord-only gate refuses EVERY req_ key, null
    (REMOVE) included, when the resulting type is not `landlord`;
  - app/src/routes/contacts.ts:1763-1805 - a type change runs only the caseworker refusal and
    typeChangeRefusals (I2 open placements/tours, I3 a LIVE unit's landlord of record); nothing
    removes or blocks on req_ keys;
  - the OR-30 type guard (contacts.ts:1640) only fences a req_ write against a re-type that lands
    BEFORE it.
- Scenario: a landlord holding requirements and no live property (a lead recorded before its
  properties, one whose properties were deleted, or an unknown inbound mis-triaged as landlord)
  -> PATCH `{ type: 'tenant' }` (or partner, or unknown) -> 200; the req_ keys stay on the
  contact. PATCH `{ req_pets: null, req_deposit: null }` -> 400 `requirements can only be set on
  a landlord`. The keys can only be removed by re-typing back to landlord, clearing, and re-typing
  again. A re-import that re-types a contact (type_source not manual) reaches the same state.
- Proof (throwaway route test, regression form, 3 cases fail):
  - `[R2A] re-type landlord -> tenant: 200; stored req_ keys after: {"req_pets":"Cats OK","req_deposit":900}`
  - `[R2A] clear req_ keys on the tenant: 400 {"error":"requirements can only be set on a landlord"}`
  - the same two lines for `partner` and `unknown`.
- Why it matters: RA-2 named exactly this consequence ("inert keys on a non-landlord are
  unreachable for cleanup", LOW, ACCEPTED). OR-30 closed only the interleaving where A's req_
  write commits after B's re-type; the reverse order (A's req_ write, then B's re-type) and the
  plain sequential re-type produce the identical state, and the sequential path is the MORE likely
  one. Impact stays low: LandlordFile is the only renderer of the requirements
  (dashboard/src/routes/contact/LandlordFile.tsx:164), so the keys are invisible on a tenant or
  partner page and come back if the contact is re-typed to landlord.
- Fix (Cameron's call, smallest first):
  1. let a clear through the gate on any type - refuse at contacts.ts:1683 only when some req_
     value in the body is non-null (a REMOVE can never add data to a non-landlord); or
  2. a type change away from landlord REMOVEs every req_ key in the same write and lists them in
     contact_updated; or
  3. accept and document (the keys are inert and resurface on a re-type back to landlord).
  Regression test: the case above, for each non-landlord type.

### R2A-2 - INFO - CONFIRMED - OR-30 over-guards: a Deposit save that cannot create a conflict is refused 409 contact_changed under a race

- Where: app/src/routes/contacts.ts:1641-1646 - both counterpart guards ride whenever the body
  carries ANY Deposit key (req_deposit_notes and req_deposit_flexible included), and a stored
  `true` one-month or a stored amount is guarded too.
- Scenario: landlord `{ req_deposit_one_month: true }`. A saves `{ req_deposit_notes: 'Two
  payments' }`; inside A's write a colleague switches the landlord to a fixed amount
  (`{ req_deposit_one_month: null, req_deposit: 900 }`, 200). A answers 409 `contact_changed`; the
  landlord form shows its generic "Couldn't save - please try again."
  (dashboard/src/routes/contact/ContactEditForm.tsx:568) and a second save lands. No interleaving
  of a notes- or flexible-only body can store both forms (each form-setting save is itself checked
  and guarded), and a guard holding a stored `true` one-month never prevents a conflict (a body
  that sets an amount over a stored true is a 400 before the write unless it also clears the
  box, after which the write REMOVEs it anyway).
- Proof: throwaway route test - `[R2A] colleague 200; notes-only save: 409 "contact_changed"`.
  Mutant C2 (guardAsRead stops guarding booleans, contacts.ts:530) is killed ONLY by the
  guard-shape assertion (landlordRequirementsPatch.test.ts:358), by no behavioral case.
- Fix (optional): guard the counterpart only when the body SETS a form - a numeric req_deposit
  guards req_deposit_one_month as read; req_deposit_one_month true guards req_deposit as read;
  nothing for a notes/flexible-only body. Or keep it: the extra 409s are rare and recoverable.

### R2A-3 - INFO - CONFIRMED - money past 2^53 passes validation and 500s at the DynamoDB marshaller

- Where: app/src/lib/requirements.ts:236-243 (money: finite and >= 0, no upper bound), used by the
  unit's deposit / application_fee and by the NEW landlord req_deposit / req_application_fee.
- Proof (DynamoDB Local, real units repo): `updateIfRequirementsCurrent(read, { deposit: 1e16 })`
  threw `Error: Number 10000000000000000 is greater than Number.MAX_SAFE_INTEGER. Use NumberValue
  from @aws-sdk/lib-dynamodb.` - a plain Error, not ConditionalCheckFailedException, so
  writeFencedPatch rethrows and the PATCH answers 500. The harness fake stores the value, so no
  route suite can see it (a fake/real divergence).
- Pre-existing class (every 'number' unit kind on main has no upper bound); new only for the two
  landlord money keys. Fix: an upper bound on money (for example <= 1,000,000) answering 400
  `<key> must be at most ...`, in normalizeRequirementValue (both sides).

### R2A-4 - INFO - CONFIRMED - an Apply body repeats the landlord's text in `expected`, so text the PATCH accepted can fail an Apply

- Where: app/src/app.ts:140 (`express.json()` default limit, 100kb), contactRequirementsApply.ts:
  84-107 (`expected` carries every listed item's full value), requirements.ts:251-255 (requirement
  text has no length cap).
- Proof (throwaway route test): a landlord PATCH carrying 99,000 characters of requirement text
  -> 200; an Apply of those two items over a 100-property batch -> 500 (the body-parser refusal
  surfaces as a 500, not a 413); at 90,000 characters the same Apply is 200.
- The sizes are unrealistic; RA-10 already notes "no length cap". The addition: the limit that
  matters for Apply is ~100KB minus the units list, and the refusal is an opaque 500 that the
  dialog answers with "press Update again" forever. Fix: a length cap on requirement text in
  normalizeRequirementValue (unit and landlord; for example 4,000 characters), which also bounds
  RA-10's item-size risk.

### R2A-5 - INFO - the approved spec still describes the fence as landlordId + map only

- Where: spec D5 (lines 429-446: "CONDITIONED on the unit's requirement_sources and landlordId
  still being what it read") and D8 (lines 571-573), and plan ruling AR11. Since 988f4208 (OR-29)
  the code also conditions every key of each item it writes. adjudications.md records the
  divergence for Cameron and FW1a "Divergences" says the spec was not edited; the spec file's last
  commit is still c41b9b90 (rev 6). For the handback: a spec note, or Cameron accepts the drift.

---

## Checked and clean (negative results, with proof)

- Fence value shapes, each on DynamoDB Local AND the harness fake (throwaway parity test):
  - legacy `''` text: main's string kinds stored `''`, and main's edit form sent it on a clear
    (`git show main:dashboard/src/routes/listing/ListingEditForm.tsx` lines 164 and 180:
    `patch['tour_process'] = tourProcess`, `patch['pets'] = pets`), so prod units can hold
    `tour_process: ''` / `pets: ''`. A Touring write over `tour_process ''` and an Apply of Pets
    over `pets ''` both LAND (`#fenceJ = :fenceJ` with an empty string is accepted);
  - a stored NULL (`pet_fee: null`) under a Pets write: LANDS (DynamoDB `=` matches NULL to
    NULL; the fake's isDeepStrictEqual agrees);
  - money with cents (1250.4) and a list stored in a requirement key: LAND;
  - the largest condition - a write of all 8 items (15 fence keys, 13 present, a 5,000-character
    qualifications) plus a landlord change, and an Apply of all 8 items: both LAND on DynamoDB
    Local (no expression-size limit near; aliases `#k<i>`/`:v<i>`, `#fence<j>`/`:fence<j>`,
    `#expected*`, `#updatedAt`, `:blankDeletedAt` are disjoint; a fence name may alias a SET
    target because DynamoDB evaluates the condition on the pre-update item).
- Harness mirror vs the real condition: equivalent for every shape above (own-property presence +
  isDeepStrictEqual vs `=` / attribute_not_exists). The only divergences: an explicit-undefined
  own key (the FW1a contract forbids it; the real DocumentClient runs with removeUndefinedValues,
  lib/dynamo.ts:87, which would leave `:fenceJ` undefined) and R2A-3.
- requirementFenceKeys completeness: every input the PATCH planner decides on is fenced -
  deposit_conflict reads the Deposit item only when the body writes a Deposit key (fenced then),
  the legacy pets partner reads the Pets item only when the body writes a Pets key (fenced then),
  the classification classifies only changed items (= items the patch writes), the map and
  landlordId are fenced whole. Apply: the changing items' keys are exactly the patch's requirement
  keys; a listed item that already matched and changes between Apply's read and write is not
  written, which is serializable (Apply, then the edit).
- Interleavings walked, no defect: a PATCH landlord change vs a requirement PATCH (both orders:
  the loser re-reads; a landlord-change retry resets the map, a requirement retry classifies
  against the new landlord); PATCH vs Apply; Apply vs restoreWithLandlord / soft delete / roster
  claim (landlordId, map and requireLive conditions); two Applies on one unit (the second skips
  `changed_during_apply` although the end state is the one it wanted - UX only, not filed).
- The skipped landlord read (RA-7): behavior-neutral - with no requirement key and no legacy
  partner (writesItem(fields, 'pets') is false) no item's interpreted value changes, so the map is
  kept; a landlord CHANGE still reads and type-checks the new landlord.
- The attribution: no regression for the pre-existing guard combinations ([notes] -> stale,
  [classification, notes] -> by stamp, [classification] -> contact_changed, as before). The new
  `guards.length === 1` disjunct is logically redundant (a lone notes guard fails only when its
  stamp moved), which is why no test can kill it; harmless.
- FW1a claims verified by hand: no import cycle (app/src/lib/requirements.ts imports only
  toursModel.ts, which has no imports); 0 non-ASCII and 0 literal backslash-u on added app lines
  b7fd58b6..2aa30812.
- Sweep beyond round 1's table (writers and readers of the changed state):
  - req_ keys: the importer writes contacts with UpdateCommand only (lib/import/apply.ts:748-1594;
    no Put can wipe them); contact CREATE ignores them; the AI profile reads explicit tenant keys
    (jobs/extraction.ts:150-160); the only stranding path is R2A-1.
  - landlordId / requirement_sources: app/scripts/assign-primary-contacts.ts and clean-org-names.ts
    never write landlordId or requirement keys; the contact DELETE hand-off never changes the
    landlord of record (contacts.ts:2410-2424); the unit restore route changes a landlord only
    through restoreWithLandlord (units.ts:2462-2622), which REMOVEs the map.
  - requirement keys: no app/src writer outside unitFields / the planner / Apply / seeds; seeds
    store no `''` or null requirement value (grep).
  - broadcast sizes: no reader of bedroomSize outside bedroomSizesOfFilter (grep across app/src,
    app/scripts, scripts); preview, send, fan-out and every projection go through it.
  - unit_updated: no reader beyond toUnitActivityEvent (contactTimeline keeps unit_* events on the
    unit); Apply's `landlordId` payload field is never projected.
  - flyer / public: the public router projects units only through toUnitFlyer (public.ts:463);
    similarUnits reads subzone/area/beds/rent/authorities; mergeFields reads beds only.
  - the Apply route sits under /api (requireAuth, app.ts:243) on an existing prefix, so it needs
    no new CloudFront ordered_cache_behavior.

---

## Adjudication challenges

- RA-2 / OR-30 (ACCEPT) - PARTLY NOT CLOSED. RA-2a (both deposit forms) is closed in both race
  directions (mutant C1). RA-2b's stated consequence - req_ keys on a non-landlord, uncleanable -
  remains reachable by the reverse interleaving and by a plain re-type (R2A-1, proven). Recommend
  keeping OR-30 and adding R2A-1's option 1, or recording option 3 for Cameron.
- RA-4 (REJECT), RA-5 / RA-6 / RA-8 / RA-9 (NO ACTION), RA-10 (NO ACTION + handback): reasons
  re-checked against the spec and code - agree. RA-5 note: a SENT share's preview also resolves
  through bedroomSizesOfFilter (broadcasts.ts:1038-1042, "previews as before"), so a sent legacy
  `bedroomSize: 7` previews every 4+ tenant; D12 lists "preview" among the normalizer's users, so
  the spec covers it.
- OR-31's premise ("with OR-30 the [landlord both-forms] state is reachable only by a direct data
  edit"): verified - the contacts PATCH is the only writer of req_deposit_one_month / req_deposit
  and is guarded both ways; CREATE ignores req_ keys; seeds and the importer never write them. The
  same holds for units: the PATCH is fenced and checked, Apply copies a landlord that cannot hold
  both (409 deposit_conflict otherwise), create is checked.

---

## Per-fix verdicts

Each mutant below was mine, made and reverted with the Edit tool; `git diff --exit-code` was clean
for the file after each revert. Baseline for the 7 fix-wave suites (fence integration, unit PATCH,
Apply, landlord PATCH, unitFields, contactStaffNotes, caseworker parity): 317/317, nothing
skipped (DynamoDB Local reachable).

| Fix | Verdict | Mutant and result |
| --- | --- | --- |
| OR-29, real repo (unitsRepo.ts:1196-1205) | REAL | R1 - the fence loop fed no keys: 7 failed / 129 - every OR-29 `[DynamoDB Local]` case (the six stale-write value types and the applyRequirements case) |
| OR-29, harness mirror (twilioWebhookHarness.ts:2897) | REAL | H1 - the mirror line made a tautology: 10 failed / 129 - the 7 `[harness fake]` halves, RA-1a (unitsApiRequirementsPatch.test.ts:394), RA-1b (:426), RA-1c (requirementsApplyApi.test.ts:520) |
| OR-30 guards (contacts.ts:1638-1647, carried at :1917) | REAL | C1 - the guards dropped from the write: 5 failed / 59 - RA-2a x2 (landlordRequirementsPatch.test.ts:287), RA-2b (:302), attribution (:315), guard shape (:358). C2 - booleans unguarded: 1 failed (guard shape only; see R2A-2) |
| OR-30 attribution (contacts.ts:1939-1942) | REAL | A1 - the old `classificationGuard === undefined`: 1 failed / 59 - the attribution case (:315) |
| RA-3 (unitFields.ts:224) | REAL | F1 - bare `WRITABLE_FIELDS[key]`: 15 failed / 111 |
| RA-7 (units.ts:804) | REAL | S1 - the landlord of record always read: 1 failed / 30 - the RA-7 case |
| RC-1 | PIN (coverage) | green before and after OR-29 by design; not a fix, nothing to kill |

The FW1a mutant table reproduces where it overlaps (its M1/M2/M3 vs R1/H1, M4a-c vs C1, M5 vs A1,
M6 vs F1, M7 vs S1). Final state after every revert: no diff under app/src or app/test/helpers;
the 7 suites 317/317.
