# U2 (S1b) - types, unit validator, flyer projection, D10a walk - Tasks 1.4, 1.5, 1.6, 1.7

- Unit: U2, slice S1b (plan Tasks 1.4-1.7 and the S1 exit check), implementer
  model Claude Opus 5.5.
- Branch `feat/property-requirements`, worktree `W:/tmp/property-requirements`,
  started at `dfba1959` (U1's report commit).
- Rulings carried: AR1 + PR1-2, AR2, AR3, AR4, AR28 (plan section 4), OR-6
  (worklist).
- STOP items: none.

## Per task

| Task | Result | Files |
|---|---|---|
| 1.4 UnitItem / ContactItem declare the requirement keys; stale repo comments | SHIPPED as written | `app/src/repos/unitsRepo.ts`, `app/src/repos/contactsRepo.ts`, `app/test/requirementItemTypes.test.ts` (new) |
| 1.5 unit validator: requirement kinds, legacy pets write, voucher list, subzone, washer/dryer | SHIPPED as written | `app/src/lib/unitFields.ts`, `app/test/unitFields.test.ts`, `app/test/unitsApi.test.ts` |
| 1.6 flyer projection (D11 data) and the never-list | SHIPPED as written | `app/src/lib/unitFields.ts`, `app/test/unitFields.test.ts`, `app/test/publicIntake.test.ts` |
| 1.7 `PROPERTY_FORM_FIELDS` and the D10a parity walk | SHIPPED as written | `app/src/lib/requirements.ts` (append), `app/test/propertyFormFlyerParity.test.ts` (new) |
| Mutant follow-up (M10) | ADDED one test case | `app/test/unitFields.test.ts:801-808` |

Plan fidelity, checked mechanically (a throwaway script in the session
scratchpad applies a task's plan anchor -> replacement line ranges to the
pre-task text and compares the result with the file): for Tasks 1.5 and 1.6
before each commit, and for Task 1.4's two repo files after its commit
(against `dfba1959`, with the plan's `<EM DASH>` placeholders restored to
U+2014). Every anchor matched exactly once (Task 1.5's T4 replace_all hit
exactly 4) and every edited file equals base + plan edits byte for byte. The
two new test files are byte-identical to plan lines 2851-2953 and 4634-4908
(diffed before their commits); `requirements.ts` equals its pre-1.7 text
plus a blank line plus plan lines 4928-4988.

## Commits

| Hash | Subject |
|---|---|
| `49ca3555` | feat(requirements): UnitItem and ContactItem declare the requirement keys |
| `347838e5` | feat(units): the unit validator takes the requirement keys, a voucher size list, subzone and washer/dryer |
| `8e39ed6e` | feat(flyer): the flyer projection drops subzone and adds the voucher size list and the public requirement fields |
| `2a949b6e` | feat(requirements): PROPERTY_FORM_FIELDS and the D10a flyer parity walk |
| `4bb75fbc` | test(flyer): a stored negative money amount projects null - the flyer reads deposit and application fee through the D1 read |
| (this file) | docs(records): ... U2 S1b report |

## RED runs (each red for the stated reason)

- 1.4: `npm run typecheck -w @housingchoice/app` exit 2 with 34 errors, all
  in `requirementItemTypes.test.ts`: 28 x TS2322 (25 undeclared keys, the
  `[2, 3]` voucher list, the two declared-list entries) and 6 x TS2578 (every
  `@ts-expect-error` unused). The plan predicted 28 + 6. The file's vitest run
  is green at runtime by design (types erased) and was not counted.
- 1.5: `unitFields.test.ts` 23 failed / 38 passed (the plan's count);
  `unitsApi.test.ts` 5 failed / 26 passed (voucher create and PATCH read back
  `2` not `[2]`, the CO1 create stores `pets: true`, the new list PATCH and
  the new legacy-pets PATCH). Reasons seen: `unknown field: <key>`,
  `deposit must be a number` on null, `pets must be a string or boolean`,
  `subzone must be a string`, `voucher_size_accepted must be a number`.
- 1.6: `unitFields.test.ts` 9 failed / 57 passed and `publicIntake.test.ts`
  2 failed / 56 passed; the (PIN) application-fee case green. App typecheck
  exit 2 with 20 errors (TS2339 x12, TS2551 x6, TS2561 x1, TS2322 x1), the
  plan's count.
- 1.7: `propertyFormFlyerParity.test.ts` 7 failed / 2 passed (the two PINs),
  `TypeError` on the missing `PROPERTY_FORM_FIELDS`; typecheck TS2305 for
  `PROPERTY_FORM_FIELDS` and `FormFieldVisibility` (plus 7 cascade
  TS7006 / TS2339 errors from the untyped `f`).

## GREEN runs

| When | Command scope | Result |
|---|---|---|
| 1.4 | app typecheck | exit 0 |
| 1.4 | `test/requirementItemTypes.test.ts test/unitFields.test.ts test/publicIntake.test.ts test/unitsApi.test.ts` | 4 files, 131/131 |
| 1.4 | eslint (the three files) | exit 0 |
| 1.5 | filters `unitFields units publicIntake similarUnits seedData requirement` | 37 files, 691/691 (the four `requirement*` suites included, R1-F6) |
| 1.5 | app typecheck / eslint (the three files) | exit 0 / exit 0 |
| 1.6 | filters `unitFields publicIntake units requirement` | 36 files, 681/681 |
| 1.6 | app typecheck / eslint (the three files) | exit 0 / exit 0 |
| 1.7 | `test/propertyFormFlyerParity.test.ts requirement unitFields` | 6 files, 165/165 |
| 1.7 | app typecheck / eslint (the two files) | exit 0 / exit 0 |
| 1.7 | AR28 / OR-6 proof: `tsc` on `requirements.ts` alone, `lib: ["ES2022"]`, `types: []`, strict + noUncheckedIndexedAccess (throwaway tsconfig in the scratchpad) | exit 0; the program held only `toursModel.ts` and `requirements.ts` |
| Follow-up | `test/unitFields.test.ts`; app typecheck; eslint | 67/67; exit 0; exit 0 |
| Unit end | the eight suites this unit and U1 touched | 8 files, 255/255 |

ASCII: both new files print 0 on the `tr` check; added lines of
`unitsRepo.ts`, `contactsRepo.ts`, `unitFields.ts`, `unitFields.test.ts`,
`unitsApi.test.ts` and `publicIntake.test.ts` print 0 (all six carry
pre-existing em dashes; no new one added). No literal backslash-u anywhere;
the `\n` in `unitFields.test.ts:325,345` landed literally.

## S1 exit check

1. Root `npm run typecheck` (app, dashboard, e2e, fake-twilio,
   fake-twilio-web): exit 0.
2. `cd app && npx vitest run` (the whole app workspace, DynamoDB Local up,
   no skip flag; the root `npm test` was NOT run, per the brief): 514 files
   passed, 10586 tests passed, 1 skipped, exit 0, 48.6 s. The one skip is
   `staticSmoke.test.ts:380`'s self-skip (no built dashboard in this
   worktree), pre-existing and unrelated. No `[dynamoAdmin]` warn line (the
   only matches were the `dynamoAdminRetry.test.ts` names).
3. eslint on the twelve S1 files: exit 0.
4. e2e: not run and not expected green after S1 (plan section 3).

## Mutant table

Line numbers are in the final tree. Each mutant was applied and reverted
with the Edit tool; after each revert `git diff --stat` showed only the
next mutant, and at the end `git diff --exit-code` on every touched source
file was clean (the only change left was the follow-up test, committed as
`4bb75fbc`).

| # | Mutant | file:line | Test run | Result | Follow-up |
|---|---|---|---|---|---|
| M1 | off-by-one: `isVoucherSize` `<=` -> `<` (12 refused) | `unitFields.ts:178` | `unitFields.test.ts` | KILLED (2 of 66) | - |
| M2 | missing REMOVE: an emptied voucher list stored as `[]` | `unitFields.ts:252` | `unitFields.test.ts` | KILLED (1 of 66) | - |
| M3 | weakened guard: boolean `pets` refused only beside `no_pets: true` | `unitFields.ts:269` | `unitFields.test.ts` | KILLED (1 of 66, the null `no_pets` body) | - |
| M4 | dropped partner key: boolean `pets` no longer writes `no_pets` | `unitFields.ts:273` | `unitFields.test.ts` + `unitsApi.test.ts` | KILLED (3 of 66 + 1 of 31) | - |
| M5 | `'requirement'` case stores the raw body value, not the normalized one | `unitFields.ts:293` | `unitFields.test.ts` | KILLED (5 of 66) | - |
| M6 | binding AR3 copy drift: pets 400 reverts to `pets must be a string or boolean` | `unitFields.ts:278` | `unitFields.test.ts` | KILLED (1 of 66) | - |
| M7 | flyer `no_pets` read from the raw key (D1 legacy read bypassed) | `unitFields.ts:504` | `unitFields` + parity + `publicIntake` | KILLED (1 of 133; the walk alone does not see it - no base holds a legacy boolean, by design) | - |
| M8 | flyer drops a public key: `washer_dryer: null` | `unitFields.ts:511` | `propertyFormFlyerParity.test.ts` ALONE | KILLED (2 of 9; the walk flags Washer / dryer on all 3 bases) | - |
| M9 | the D3 regression: the projection re-adds `subzone` | `unitFields.ts:491` | `propertyFormFlyerParity.test.ts` ALONE | KILLED (2 of 9; the walk flags Subzone on all 3 bases) | - |
| M10 | flyer `application_fee` read raw (`isFiniteNumber`) instead of through the D1 money read | `unitFields.ts:501` | `unitFields` + parity + `publicIntake` | SURVIVED (133/133) | Real gap, see below; new case fails on the mutant ("expected -50 to be null", 1 of 67) and passes on real code (67/67); committed `4bb75fbc` |

M10 is a real gap, low severity. Task 1.6 deliberately moved both money keys
of the projection onto the D1 read (R1's reference: "negative values pass
today; after 1.6 they read null"), but no case pinned it. With the mutant, a
stored negative amount (never writable: the validator has always required
>= 0, so only bad raw data can hold one) publishes on the public flyer as
"$-50" while the registry read (`unitItemValue`, which S6's property card and
the D5 classification use) reads it as blank. The new case
(`unitFields.test.ts:801-808`) covers both keys: the sibling mutant on
`deposit` (`unitFields.ts:507`) also fails it ("expected -1400 to be null")
and was reverted the same way.

## Divergences from the plan text

- None in code: every task's files are the plan's text (see "Plan fidelity").
- Added one test case for M10 (`app/test/unitFields.test.ts:801-808`, inside
  the `toUnitFlyer - the merged public allowlist` describe).
- Wording slip only: Task 1.4 Step 3 says "four edits" to `unitsRepo.ts` but
  lists Edits 1-5; all five were applied.
- Task 1.5 Edit T1 was anchored with the preceding import line included (the
  plan's one-line anchor is also unique); the result is byte-identical.

## Rulings applied

- AR1 + PR1-2: `PROPERTY_FORM_FIELDS` is the 35-row list with
  `Owning landlord` first (`requirements.ts:519`); the walk's `SAMPLE`
  carries `landlordId` (`propertyFormFlyerParity.test.ts:32`). Verified
  independently: Task 5.2's `FORM_FIELD_LIST` (plan 15163-15197) equals Task
  1.7's table (plan 4811-4845), 35 = 35 rows, 0 differences (label, keys,
  flyer); the GREEN table case proves the shipped constant equals Task 1.7's.
- AR2: `No application fee` has its own row just before `Application fee`
  (`requirements.ts:499-506`).
- AR3: the nine strings are produced verbatim (CONTRACT below); M6 shows the
  pets one is pinned, U1's M5 the checkbox one.
- AR4: the stated mid-build breakage is now live in the tree (see "For later
  units").
- AR28: `requirements.ts` still imports only `./toursModel.js`
  (`requirements.ts:18`); the append added no import and no Node global.
- OR-6: no post-ES2022 API (grep for `toSorted`, `toReversed`, `toSpliced`,
  `.with(`, `findLast`, `groupBy` empty), proven by the lib-ES2022 compile.

## CONTRACT (what later units rely on)

### `WRITABLE_FIELDS` kinds per key (`app/src/lib/unitFields.ts:60-154`)

`FieldKind` (`:26-41`) is now `string`, `number`, `boolean`, `string[]`,
`pets`, `address`, `requirement`, `clearable_string`, `washer_dryer`,
`voucher_sizes`. The old `tour_type` and `clearable_number` kinds are GONE,
and `isTourType` is no longer imported.

| Key | Kind | Change |
|---|---|---|
| landlordId | string | - |
| address | address | - |
| accepted_authorities | string[] | - |
| beds, baths, rent_min, rent_max, final_rent, payment_standard, lif | number | - |
| area, utilities, accessibility, notes, lease_terms, priority, listing_link, video_url, application_process, propertyId | string | - (null still a 400, '' still stored) |
| media | string[] | - |
| same_day_rta | boolean | - |
| subzone | clearable_string | was string: trimmed, '' / whitespace / null REMOVE |
| deposit | requirement (money) | was number: null REMOVEs |
| application_fee | requirement (money) | was number: null REMOVEs; 0 kept |
| pets | pets | string / null = details text (trimmed, '' / null REMOVE); legacy boolean stored in the new shape |
| voucher_size_accepted | voucher_sizes | was clearable_number: null / [] REMOVE; integer 0..12 -> [n]; list -> de-duplicated ascending |
| tour_process | requirement (text) | was string: trimmed, '' / null REMOVE |
| tour_type | requirement (tour_type) | was tour_type: same behavior and message |
| no_evictions_on_program, no_pets, deposit_one_month, deposit_flexible | requirement (checkbox) | NEW: true stored; false / null REMOVE |
| evictions_notes, credit_requirements, income_requirements, pet_fee, deposit_notes | requirement (text) | NEW |
| qualifications | requirement (long_text) | NEW |
| washer_dryer | washer_dryer | NEW: hookups / included / none; '' / null REMOVE |

Not writable (unchanged): `requirement_sources` (PIN:
`unknown field: requirement_sources`), `primary_contact`, `status`, repo
keys. Tombstoned (unchanged): `jurisdiction`, `accepted_programs`. The
validator stays pure: no `deposit_conflict` check (pinned). A `null` in the
output is REMOVE on update and dropped on create, as before. A boolean
`pets` always emits BOTH Pets keys (`no_pets` true or null, `pets` null or
'Allowed'); the body check for the combo is "any `no_pets` that is not
undefined" (`:269`).

### Validator error strings (exact `error` values)

AR3 (binding), `<key>` = the unit key:
- `<key> must be true, false or null` - the four checkboxes
  (`requirements.ts:234`, via `normalizeRequirementValue`).
- `<key> must be a string or null` - the text / long_text requirement keys,
  incl. `tour_process` (`requirements.ts:253`); not reachable for `pets`
  (its own message comes first).
- `<key> must be a number`, `<key> must be >= 0` - `deposit`,
  `application_fee` (`requirements.ts:239,241`); the plain number kind keeps
  the same two strings (`unitFields.ts:230-231`).
- `tour_type must be one of: self_guided, landlord_led, pm_team`
  (`requirements.ts:247`).
- `pets must be a string, a boolean or null` (`unitFields.ts:278`).
- `voucher_size_accepted must be an integer 0..12 or a list of them`
  (`unitFields.ts:247`).
- `subzone must be a string or null` (`unitFields.ts:302`).
- `washer_dryer must be one of: hookups, included, none`
  (`unitFields.ts:314`).

Plan 2.2: `pets: a boolean pets cannot be combined with no_pets`
(`unitFields.ts:270`).

Unchanged: `body must be a JSON object` (`:205`), `unknown field: <key>`
(`:222`), `<key> must be a string` (`:227`), `<key> must be a boolean`
(`:256`), `<key> must be an array of strings` (`:259`),
`landlordId is required (the owning landlord contactId)` (`:333`),
`no updatable fields supplied` (`:336`), the address validator's messages.
Internal guard (unreachable): thrown `unitFields: <key> is not a requirement key`
(`:193`).

Gone: `pets must be a string or boolean`; `subzone must be a string`;
`voucher_size_accepted must be a number` / `... must be >= 0`;
`tour_process must be a string`; `deposit must be a number` /
`application_fee must be a number` for null (null now REMOVEs; the strings
remain for non-numbers).

### `UnitFlyer` / `toUnitFlyer` (`unitFields.ts:375-421`, `:471-513`)

- REMOVED: `subzone`.
- ADDED: `voucher_sizes: number[]` (`:386`; `acceptedVoucherSizes`
  de-duplicated and ascending, NOT filtered); `no_pets: boolean` (`:406`);
  `pet_fee: string | null` (`:408`, trimmed, blank -> null);
  `deposit_one_month: boolean` (`:414`); `deposit_flexible: boolean`
  (`:416`); `washer_dryer: 'hookups' | 'included' | 'none' | null` (`:420`,
  only a recorded value).
- KEPT, semantics updated: `voucher_size` (`:383`, = `voucher_sizes[0]`, the
  SMALLEST size: a messy legacy list `[3, 2]` now gives 2, before 3);
  `pets: string | null` (`:404`, was `string | boolean | null`; the D1
  details text: legacy true -> 'Allowed', legacy false -> null with
  `no_pets: true`, trimmed, blank -> null); `deposit`, `application_fee`
  (`:412`, `:399`, the D1 money read: a negative or non-finite stored amount
  -> null, pinned by `4bb75fbc`; 0 kept).
- KEPT unchanged: `unitId`, `media`, `beds`, `baths`, `area`,
  `accepted_authorities`, `listing_link`, `rent_min`, `rent_max`, `address`,
  `utilities`, `video_url`, `same_day_rta`, `accessibility`, `lease_terms`.
  25 keys in all; the route adds `contact_number` (26, pinned in
  `publicIntake.test.ts`).
- Never-list comment (`:347-355`) now also names `subzone`,
  `requirement_sources` and the six staff-only requirement keys.

### `PROPERTY_FORM_FIELDS` and `FormFieldVisibility` (`app/src/lib/requirements.ts:479-539`)

`FormFieldVisibility` (`:482-488`) = `{ label: string; keys: readonly string[]; flyer: FlyerVisibility }`.
Frozen at every level - array, row, keys (`formField`, `:490-492`). Rows
18-33 are derived from `REQUIREMENT_ITEMS` (`:499-506`), so the registry's
labels and tags flow in (pinned by `propertyFormFlyerParity.test.ts:216`).

The 35 rows, in order (label / keys / flyer):
1. Owning landlord / landlordId / staff_only (New form only, AR1)
2. Housing authorities / accepted_authorities / on_flyer
3. Beds / beds / on_flyer
4. Baths / baths / on_flyer
5. Voucher sizes accepted / voucher_size_accepted / on_flyer
6. Rent min / rent_min / on_flyer
7. Rent max / rent_max / on_flyer
8. Payment standard / payment_standard / staff_only
9. Address / address / on_flyer
10. Subzone / subzone / staff_only
11. Washer / dryer / washer_dryer / on_flyer
12. Tenant-paid utilities / utilities / on_flyer
13. Accessibility / accessibility / on_flyer
14. Lease terms / lease_terms / on_flyer
15. Public listing link / listing_link / on_flyer
16. Video URL / video_url / on_flyer
17. Same-day RTA / same_day_rta / on_flyer
18. No evictions while on the program / no_evictions_on_program / staff_only
19. Evictions (details) / evictions_notes / staff_only
20. Credit score / credit_requirements / staff_only
21. Income requirements / income_requirements / staff_only
22. Qualifications / qualifications / staff_only
23. No pets / no_pets / on_flyer
24. Pets (details) / pets / on_flyer
25. Pet fee / pet_fee / on_flyer
26. One month's rent / deposit_one_month / on_flyer
27. Fixed amount / deposit / on_flyer
28. Flexible / payment terms available / deposit_flexible / on_flyer
29. Deposit notes / deposit_notes / staff_only
30. No application fee / application_fee / on_flyer (AR2)
31. Application fee / application_fee / on_flyer
32. Tour type / tour_type / staff_only
33. Tour process / tour_process / staff_only
34. Application process / application_process / staff_only
35. Notes / notes / staff_only

The walk (`propertyFormFlyerParity.test.ts:149-171`) compares, per row and
per base, the base with the row's keys cleared against the same unit with
them set to `SAMPLE`, over three bases (bare, fully filled, sizes equal
beds); it has a non-vacuity case (`:260-267`) and the trap pin (`:269-274`).

### `UnitItem` / `ContactItem` type additions

`UnitItem` (`app/src/repos/unitsRepo.ts`):
- NEW: `no_evictions_on_program?: true` (`:505`), `evictions_notes?: string`
  (`:507`), `credit_requirements?: string` (`:509`),
  `income_requirements?: string` (`:511`), `qualifications?: string`
  (`:513`), `no_pets?: true` (`:515`), `pet_fee?: string` (`:517`),
  `deposit_one_month?: true` (`:519`), `deposit_flexible?: true` (`:521`),
  `deposit_notes?: string` (`:523`),
  `washer_dryer?: 'hookups' | 'included' | 'none'` (`:525`),
  `requirement_sources?: Record<string, 'copied' | 'set_here'>` (`:534`).
- WIDENED: `voucher_size_accepted?: number | number[]` (`:484`). No typed
  reader broke (the root typecheck is green).
- Comments only: `subzone` (`:412-417`, staff only), `deposit`
  (`:421-423`), `lease_terms` (`:449-455`, the stale "Internal only" fixed:
  it is PUBLIC), `pets?: string | boolean` (`:456-462`, the legacy boolean
  read). `application_fee?: number`, `tour_type?: TourType`,
  `tour_process?: string` are unchanged.

`ContactItem` (`app/src/repos/contactsRepo.ts`): the 15 `req_` keys
(`:356-370`) - checkboxes `true` (`req_no_evictions_on_program`,
`req_no_pets`, `req_deposit_one_month`, `req_deposit_flexible`),
`req_deposit` / `req_application_fee` `number`, `req_tour_type` `TourType`
(new type-only import `:23`), the rest `string`; `req_pets` is `string`,
never boolean. The tenant `pets` / `evictions` are untouched.

Type pins: `app/test/requirementItemTypes.test.ts` (every key must be a
DECLARED property, not the index signature; six `@ts-expect-error` kind
pins).

## For later units and the orchestrator

- AR4 / plan section 3, now live in the tree: a stored voucher size becomes a
  list on every save (the property page's number-only row goes blank for a
  list; `e2e/scenarios/steps.ts` voucher assertions fail until S7); the flyer
  no longer serves `subzone`; '' on `tour_process` / `pets` and null on
  `deposit` / `application_fee` / `subzone` / `tour_process` REMOVE; a raw
  `pets: true` / `false` write stores `pets: 'Allowed'` / `no_pets: true`;
  until S2 a boolean `pets` PATCH audits both Pets keys
  (`Object.keys(validation.fields)`); an old FlyerPage shows no Pets row for
  a legacy `pets: false` property until S6.
- U4 (S2 writes): strip `requirements_snapshot` BEFORE `validateUnitBody`
  (it is an unknown field there). The boolean-pets output carries both keys
  even when one is a no-op, so the fenced path's PR1-10 audit must compute
  the keys actually changed. The stored-legacy-boolean PARTNER rule is the
  route's (the validator sees no stored record).
- U8 (S5 mirror, OR-12): Task 5.2's 35-row list equals this table (checked,
  0 differences); `PROPERTY_FORM_FIELDS` / `FormFieldVisibility` are now
  exported from the app module the drift test imports, and the module is
  still a lib-ES2022 leaf. The M10 follow-up is a `toUnitFlyer` case, not a
  mirrored-function case.
- U11 (S6 flyer page): read `voucher_sizes` (it may hold an off-chip 2.5 or
  13 from old data); `voucher_size` is now the smallest size; `pets` is
  `string | null` and `no_pets` decides the "No pets" lead; a negative stored
  amount arrives as null.
- U13 (S7): app-side flyer / validator changes e2e still pins are those in
  the plan's S1 notes (plan lines 5128-5133); nothing new from this unit.
- Orchestrator: the S1 exit check is green (above). The one skipped app test
  is `staticSmoke.test.ts:380` (no built dashboard here), unrelated.
