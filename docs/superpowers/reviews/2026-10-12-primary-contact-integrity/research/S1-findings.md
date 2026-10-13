# S1 research - findings (live-tree verification of plan slice S1)

Kind: FINDINGS. Byte-exact quotations and the full importer lists are in the
gitignored reference `.superpowers/sdd/research-S1-reference.md`.

Tree: `W:\tmp\primary-contact-integrity`, branch
`feat/primary-contact-integrity`, tip 14c2856b. The app, dashboard and e2e
trees are byte-identical to the plan base 0e565b86 (empty
`git diff --stat 0e565b86 HEAD -- app dashboard e2e`).
Plan read: lines 1-360 and the S1 slice, lines 361-3587. Reader: read-only;
no test or write command was run against the repo.

## Verdict

- Anchor mismatches: 0. All 23 `old_string` blocks that S1.4-S1.7 apply to
  live files occur exactly once, byte for byte (checked by a script, not by
  eye): routes/units.ts 3, tourContacts.test.ts 5, tourContacts.ts 5,
  rosterResolution.test.ts 1, rosterResolution.ts 4, rosterProvision.ts 5.
  The 3 self-anchors in S1.2 and S1.3 (on S1.1/S1.2's own new text) are
  unique as well. Every function, type, export, test file and test name the
  slice relies on exists, and its shape matches the plan's code (strict and
  `noUncheckedIndexedAccess` included). None of the nine files S1 creates
  exists yet.
- Cycle (ruling R3): SAFE. S1 creates no cycle at all, and the two-module
  cycle S2 adds is safe under R3. Details in F7.
- No finding blocks S1. Everything below is LOW or INFO.

## Findings

F1 (LOW, comment drift outside S1's files). `e2e/scenarios/steps.ts:38-41`
says `app/src/lib/tourContacts.js` VALUE-imports `unitContacts` from
`repos/unitsRepo.js`, and that is why the harness must import the type only.
After Task S1.5 Edit A, tourContacts.ts imports `UnitItem` as a type only, and
it value-imports `lib/propertyContact.js` instead. That module value-imports
both `repos/unitsRepo.js` and `repos/contactsRepo.js`. The comment's
conclusion still holds (importing it would pull the AWS SDK into the e2e
bundle), but the reason it names becomes false. S1's file list excludes
`e2e/`, so fix it in S5, or let S1.5 add one comment line.

F2 (LOW, comment drift that S2 does not schedule). The `UnitItem.primary_contact`
docblock, `app/src/repos/unitsRepo.ts:336-344`, names
"lib/rosterResolution.ts, lib/tourContacts.ts, services/rosterProvision.ts" as
the resolvers that "take the row marked primary, else the landlordId". After
S1 that rule lives only in `lib/propertyContact.ts`, and it skips a deleted or
missing contact. S2 owns unitsRepo.ts. S2's comment rewrites cover only:
- the addContact interface docblock (plan near line 4877);
- the write-region comment, live `unitsRepo.ts:999-1007` (plan near line 5040).

They do not cover this docblock. S1's planner note about
`ContactListFacts` (`unitsRepo.ts:172-179`, the `autoPrimaryEligible` pointer
at routes/units.ts) remains valid and is also S2's.

F3 (INFO, test-name citation). Task S1.7 (plan around line 3017) quotes the
placement pin as "400s when the tenant has no phone on file". The live name is
"400s when the tenant has no phone on file (never a half-roster relay)"
(`app/test/placementsRelay.test.ts:282`). The quote is a substring of the real
name, so a `-t` filter still matches, but an exact-name search does not. The
other three quoted test names match exactly (`app/test/toursApi.test.ts:3307`,
`:3328`; `app/test/placementsRelay.test.ts:293`).

F4 (INFO, caller-list precision). S1 contract issue 5 (plan lines 431-433)
says routes/tourReminders.ts `composeInputsOf` has "two call sites". The live
tree shows:
- `composeInputsOf` is called three times (`app/src/routes/tourReminders.ts:456`,
  `:540`, `:602`);
- the file calls `resolveTourContactNames` a second time at `:963` (GET
  no-show-checkin-draft), with `unit: undefined`.

Spec 9.2's caller list also omits `:963`. No action is needed. That call never
looks up a property contact, and under ruling R1 it gets no `propertyContact`
field. Every caller reads only named fields, so the R1 field breaks no
compile:
- `app/src/jobs/relayFanOut.ts:530`
- `app/src/jobs/tourReminders.ts:955-970`
- `app/src/routes/relayGroups.ts:263-267`
- `app/src/routes/tourReminders.ts:270-276`
- `app/src/routes/contactTimeline.ts:1083`, `:1122` and `:1193`. These spread
  the result and pass it to a function that reads three flags
  (`:874-876`), and nothing serializes or logs it.

F5 (INFO, readers that the sweep finds but spec 9.2 and plan 3.1 do not list).
None of them walks the primary-then-landlord ladder, and none needs a task.
Append them to spec 9.2's "unchanged on purpose" list so the next sweep does
not re-flag them:
- `app/src/jobs/relayFanOut.ts:386-404` resolveMemberRole. It reads a roster
  row's ROLE by contactId for the member-added clause.
- `app/src/services/contactHoldings.ts:107` (rosterUnitIds) and
  `app/src/services/caseworkerConversion.ts:229-236`. These read roster seats
  and the landlord of record to decide whether a caseworker conversion is
  allowed.
- Dashboard landlord-of-record readers:
  - `dashboard/src/routes/contact/buildContactFile.ts:17-19` and
    `dashboard/src/routes/contact/useContactFile.ts:168` (units this landlord
    owns);
  - `dashboard/src/routes/listing/useListing.ts:119-127` and `:185`
    (loadLandlord). This feeds `listingRoster`, which spec 9.2 does list.

The sweep found no fifth ladder copy anywhere: app/src, app/test, app/scripts,
dashboard/src and e2e were all checked. Both ladder regexes match only the four
copies, at `lib/tourContacts.ts:129`, `lib/rosterResolution.ts:294`, and
`services/rosterProvision.ts:233` and `:525`.

F6 (INFO, behavior change the S1.6 docblock could state). Today a
record-less (dangling) property contact on the DEFAULT roster becomes a bare
row:
- `app/src/lib/rosterResolution.ts:300` calls memberFromContact, which
  returns the bare row at `:191`;
- describeRoster then shows that row as `removed_contact`
  (`rosterResolution.ts:541-543`).

After S1.6 the default adds no row for it. It falls through to the landlord
of record, or to nobody. Spec section 3 intends this (a missing contact counts
as deleted), and S1.6's own test "a primary with NO record is skipped like a
deleted one" pins it. The new memberFromContact docblock (plan lines
2873-2888) has two gaps:
- It says a dangling id keeps its bare row. That is true for plan entries and
  the tenant slot.
- It says the default "never adds one" only about a SOFT-DELETED contact.

Suggested wording: "soft-deleted or record-less". Related consequence: a plan
that was materialized while its primary was live, and whose primary was later
deleted, will now read `customized: true` in describeRoster
(`rosterResolution.ts:592-609`). The new default no longer equals that plan.
This follows from spec 4.1 and is already covered by 9.2's describeRoster
entry. It is worth knowing for S4 and live self-QA.

F7 (INFO, the cycle analysis behind the R3 verdict).
- Import closures today:
  - `repos/unitsRepo.ts` value-imports only `lib/config`, `lib/dynamo`,
    `lib/logger`, `lib/statusModel` and `lib/unitMedia` (closure: 8 modules).
  - `repos/contactsRepo.ts` reaches 8 modules.
  - `lib/logger.ts` reaches 3 modules.
  - None of these closures reaches `lib/propertyContact`, `lib/tourContacts`,
    `lib/rosterResolution`, `services/rosterProvision` or `routes/units`.
    So S1 forms no cycle.
- Top-level evaluation:
  - The planned `lib/propertyContact.ts` has only `function` declarations and
    `type` aliases at top level. It reads `unitContacts`, `isDeleted` and the
    default logger inside function bodies only.
  - unitsRepo.ts top-level statements (`:53`, `:56`, `:81-86`, five error
    classes, `:221`, `:1383`) touch no propertyContact binding.
  - contactsRepo.ts's one top-level call (`:531`, `getTableSpec`) is outside
    any cycle.
- After S2: S2 (plan near lines 6583-6594) makes unitsRepo.ts value-import
  `applyPrimary`, `chooseHeir` and `rosterContactIds`, and adds a
  contactsRepo value import. The only resulting cycle is
  propertyContact <-> unitsRepo. It stays safe as long as S2 adds no
  top-level read on either side.

F8 (INFO, ruling R15 wording against S1's zero-call path). R15 says
`readRosterContacts` makes "exactly ONE" `getManyByIds(ids, { requireComplete:
true })` call. S1.1 makes NO call when there is no usable id, and its own test
pins that ("reads nothing at all for no usable ids"). Every later-slice test
that counts or inspects these calls uses a non-empty id set (plan near lines
5354, 8736, 10119, 10586, 13390), so nothing conflicts. Recorded so that no
one "fixes" the zero-call path to match R15's wording.

F9 (INFO, spec line drift; harmless because the plan anchors by name).
Line numbers here are as the spec cites them, then the live tree:
- `contactsRepo.ts:940-997` (getManyByIds) -> 957-1000. The raw-chunk
  rethrow is at 989 and IncompleteBatchReadError at 996.
- `unitsRepo.ts:296-303` (unitContacts) -> 390-398.
- `unitsRepo.ts:821-824` (the scalar is written only with a stored primary)
  -> 1008-1011.
- `lib/unitFields.ts:104` -> 107.
- `routes/units.ts:384-411` (enrichRoster) -> 401-438.
- `routes/units.ts:1202` (related units) -> 1377.

Every other S1-relevant spec citation still matches the live lines:
- `tourContacts.ts:124-139`
- `rosterResolution.ts:174-180`, `:181-190`, `:292-301`
- `rosterProvision.ts:232-247`, `:515-544`, `:524-535`
- `tourReminders.ts:960-963`
- `rosterEdits.ts:271-283`

## Confirmed facts the build can rely on (no action)

- The `autoRoutingEligible` definition `app/src/routes/units.ts:133-153` is the
  plan's Edit C text exactly. It has exactly two call sites, `:474`
  (soleLandlordToPromote) and `:1250` (add route). `isDeleted as
  isContactDeleted` (`:66`) has its only use at `:150`, so removing it is
  safe. `ContactItem` stays used at `:415` and `:1819`. S2.4(c)'s anchor
  (plan near line 5672) equals S1.4 Edit B's added lines.
- `contactsRepo.getManyByIds(contactIds, opts?: { requireComplete? })`
  (`app/src/repos/contactsRepo.ts:734-737`, implementation `:1288-1290`) fails
  in two shapes under `requireComplete`:
  - a raw chunk error, rethrown at `:989`;
  - `IncompleteBatchReadError(unprocessed, requested)`, at `:996` (class at
    `:622-633`).

  It de-duplicates ids itself (`:969`) and sets no `ConsistentRead`
  (`:979`). `isDeleted` (`:369-371`) treats `''` as not deleted.
- `unitContacts` (`app/src/repos/unitsRepo.ts:390-398`) returns the stored
  rows, or else a derived `{ landlordId, role: 'landlord', primaryContact:
  true }` row. `UnitItem.landlordId` is a REQUIRED string (`:232`).
- The fail-closed rule is kept. `ReminderNamesUnavailableError` is defined at
  `app/src/jobs/tourReminders.ts:105-109`, and the throw at `:960-963` reacts
  to `propertyReadFailed`. Under C1 that flag is true only when a candidate
  read throws, and the walk never falls through after a throw.
- The bare row on a read failure: today, `memberFromContact`
  (`app/src/lib/rosterResolution.ts:181-200`) returns `{ contactId }` when a
  read throws. S1.6 keeps exactly that for the `read_failed` candidate, and the
  `(PIN)` tests are green both before and after.
- Diagnostic texts: the tour detail strings
  (`app/src/services/rosterProvision.ts:229-247`) and the placement codes
  (`:515-544`) map onto C1's outcomes exactly as the S1.7 table states.
  `toursApi.test.ts:3328` "names each missing rung" keeps passing, because
  `ll-ghost` now resolves as nobody/deleted, which gives "landlord contact not
  found".
- The catalog copy that S1.5's tests compose is present: `tour.en_route_self_guided`
  at `app/src/messages/catalog.ts:175-177` and `tour.en_route_landlord_led` at
  `:186-188`. A missing property-contact first name falls back to the
  self-guided entry (`app/src/messages/tourCopy.ts:149-151`).
- Static guards: the new log calls put `err` only at depth 0, so
  `app/test/logCallSiteGuard.test.ts` stays green. ESLint
  (`eslint.config.mjs`) has no import-cycle rule, and `_`-prefixed unused
  arguments are allowed.
