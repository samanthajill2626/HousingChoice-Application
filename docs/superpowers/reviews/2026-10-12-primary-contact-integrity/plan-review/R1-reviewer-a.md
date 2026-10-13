# Plan review R1 - reviewer A (adversarial, plan-blind to rationale)

Plan: `docs/superpowers/plans/2026-10-13-primary-contact-integrity.md` (v1, 20625 lines)
Spec: `docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md` (rev 6)
Tree: `W:\tmp\primary-contact-integrity` @ 08fd4208 (read-only; nothing run but grep/sed/python text checks)

## Scope of this review

Examined deeply (code blocks read against the tree):

- Sections 0-3 (constraints, contracts, slice map, matrix, rulings).
- S1 entirely (S1.1-S1.8).
- S2.1-S2.11 implementations and their tests; S2.12-S2.14 read.
- S3.1 (resolver rewrite), S3.5 (block + enrichRosterView), S3.6 anchor, S3.7.
- S4.3 (edited-draft rule), S4.4, S4.6, S4.8 (box logic lines), S4.9, S4.13.
- S5.1, S5.2 (planner), S5.10, S5.11, S5.12; S5.5/S5.6 spot-checked.

Skimmed (outline + targeted greps only): S3.2-S3.4, S4.1, S4.2, S4.5, S4.7,
S4.10-S4.12, S5.3, S5.4, S5.7-S5.9.

Mechanical check (all slices): every fenced block introduced as an Edit
`old_string` / "Replace the line" (190 blocks) was matched against the current
tree. Every block either matches exactly once in its target file, or is text an
EARLIER task of the plan creates (verified for each: e.g. S1.2/S1.3 anchors,
S2.4 (c) = S1.4 Edit B output, S2.9 (b) = S2.7 (c) output, S3.5 3a = S2.8 (a)
output, S4.3 anchor = S4.2 output), or is a deliberate `replace_all` (S4.9 1e,
S3.6). Region replacements selected "by marker lines" were checked: every marker
line exists once (`routes/units.ts:1132,1314,1349,441,1835`;
`unitsRepo.ts:899,1056,1134,1270`; harness `:2944,3015,3043,3117,3125`). The plan
file itself is ASCII and contains no `\u` escapes. No Edit anchor defect found.

## Surface enumeration (independent sweep, not the plan's list)

Mutation surfaces of the roster / primary flag / scalar / landlord of record
(grep of `app/src`, `app/scripts`, `dashboard/src`, `e2e`):

| surface | evidence | plan task | status |
|---|---|---|---|
| contact-list add/edit route + `addContact` | `routes/units.ts:1132-1312`, `unitsRepo.ts:899-1054` | S2.2-S2.4 | covered |
| contact-list remove route + `removeContact` | `units.ts:1314-1347`, `unitsRepo.ts:1056-1132` | S2.5-S2.6 | covered (see F2) |
| unit restore route (plain / clear / swap) + `restoreWithLandlord` | `units.ts:1717-1893`, `unitsRepo.ts:1270-1360` | S2.7-S2.8 | covered (see F1) |
| contact soft delete (ONLY caller of `contactsRepo.softDelete`) | `routes/contacts.ts:2253` | S2.9-S2.11 | covered |
| contact restore | `contacts.ts:2370-2400` | S2.11 pin | covered |
| unit create / PATCH (`primary_contact` writable) | `lib/unitFields.ts:107` | S2.1 | covered |
| unit `update()` callers (status, media, final_rent, authorities) | `statusTransition.ts:382,521,643`, `unitsRepo.ts:1192,1212`, `dev.ts:1254`, `orgRecords.ts:670` | none needed | never touch contacts/landlordId |
| importer upsert / retract | `lib/import/apply.ts` (no `primary_contact`, no roster) | none (P1 covers) | as spec |
| caseworker conversion | `services/caseworkerConversion.ts:224-240` refuses on any roster seat | none | no roster write |
| seeds | `seed/cast.ts:1365-1367`, `seed/performance.ts:578,604-607` | S5.12 step 3 (byte check) | as spec |
| dev seams | `routes/dev.ts` (no roster writes today) | S5.5 adds one | covered |
| API-test fake | `test/helpers/twilioWebhookHarness.ts:2820` (the ONLY `UnitsRepo` object literal) | S2.4/S2.6/S2.8/S2.9/S5.1 | covered |
| scripts | only `clean-org-names.ts` writes units (authorities only) | S5 new script | covered |

Readers of the primary / property contact: the four ladder copies
(`tourContacts.ts:124-140`, `rosterResolution.ts:292-301`,
`rosterProvision.ts:233,525`) are the only `primaryContact === true)?.contactId ??`
/ `primary?.contactId ??` shapes in `app/src`; every other app reader reaches them
through `resolveTourContactNames` / `resolveRoster` (verified `describeRoster`
default at `rosterResolution.ts:588-610` re-enters `resolveRoster`). Landlord-of-
record readers (`placementNudges`, `personEvents`, `contactTimeline`
`LANDLORD_FEED_TYPES` allowlist `:330-335`, dashboard landlord tabs) stay
unchanged as the spec says; the contact timeline's allowlist drops the new audit
type silently (no crash). Dashboard readers: `buildListingFile.ts:49-87`,
`ListingDetail.tsx:323-331,987-1050`, `rosterPeople.ts:59,114`,
`PeopleCard.tsx:686` - all in S4. No reader is missing from the plan.

## Findings

### F1 [MEDIUM] Restore hand-offs still decide "was the old landlord primary" from the `primary_contact` scalar

What is wrong. Spec section 3: "The FLAG is the truth ... Code that needs 'who is
primary' reads `unitContacts(unit)`, never the scalar." Spec 4.7: "Nothing reads
the scalar at runtime." Spec 4.6 runs the restore hand-off "if the cleared
landlord was the primary" / "when the old landlord was primary". The plan's new
code keeps `main`'s scalar disjunct in both decisions:

- S2.7 `restoreWithLandlord` (plan ~L7940-7941):
  `oldWasPrimary = ... (oldRow?.primaryContact === true || unit.primary_contact === old)`,
  and its rewritten interface docblock says "(roster flag or scalar)" (~L7852).
- S2.8 `clearedLandlordHeir` (plan ~L8645-8646):
  `clearedWasPrimary = clearedRow?.primaryContact === true || unit.primary_contact === clearedLandlordId`.
- The fake mirrors it (plan ~L8827-8828).

Evidence that the state is real: spec 4.7 and spec 8 (`scalarAligned`) both say a
legacy scalar that disagrees with a live flagged primary exists until the
one-time script runs, and spec 4.5 says the scalar was client-writable with no
roster check until this branch.

Consequence. Roster `[L landlord false, A owner (typed landlord) false, P pm true]`,
scalar `'L'`, unit soft-deleted, L re-typed: "Restore without a landlord" computes
`clearedWasPrimary = true`, the heir function picks A (earliest eligible), and
`applyPrimary` DEMOTES the live flagged primary P - an unrequested primary move,
audited `unit_primary_contact_assigned { reason: 'handoff_on_restore', from: L }`
although L never held the flag. A landlord swap on the same unit flags the new
landlord over P. No test pins the flag-only reading (every S2.7/S2.8 case seeds a
consistent scalar), so the gap ships green.

Implication. Decide `oldWasPrimary` / `clearedWasPrimary` from the flagged row of
`unitContacts()` only (real repo, route helper and fake), and add one case per
branch with a disagreeing scalar asserting the flagged primary is untouched.

### F2 [LOW] Two intermediate S2 commits leave real API paths returning 500

What is wrong. Section 0 claims "Mid-build breakage ... none expected". But:

- After S2.5's commit, the real `removeContact` treats a missing
  `opts.readContacts` as unknown and throws `RosterReadFailedError` for ANY
  removal of the primary row (plan ~L6633-6638). The route still calls
  `units.removeContact(unitId, contactId)` without opts until S2.6 (~L7042), and
  today's route catch (`routes/units.ts` remove handler) has no branch for that
  error, so DELETE of a primary answers 500 against DynamoDB.
- After S2.7's commit, a landlord SWAP of a primary landlord throws the same way
  until S2.8 passes `handoffOpts` (~L8727).

The FakeWorld fake is only updated in S2.6 / S2.8, so every S2.5 / S2.7 GREEN step
(repo integration + typecheck) passes and nothing reveals the broken route.

Implication. Not a merge risk (S2.14 runs after both), but the commits are
bisect-hostile and the Section 0 statement is false. Land the route wiring in the
same task as the repo change, or have S2.5/S2.7's repo fall back to `main`'s rule
when no read is supplied until the route task lands.

### F3 [LOW] "No DynamoDB Local needed" claims are false for every app vitest run

What is wrong. S1 preconditions (plan ~L450-452: "no DynamoDB Local is needed for
Tasks S1.1-S1.7") and several S2 tasks ("DynamoDB Local: not needed", e.g.
~L3729, ~L3886, ~L5112, ~L6719, ~L10075) assume a pure test file can run without
the container. `app/vitest.config.ts:146` wires `test/globalSetup.ts` into EVERY
run, and it THROWS when DynamoDB Local is unreachable
(`app/test/globalSetup.ts:14-17,72-86`) unless `ALLOW_SKIP_DYNAMO_TESTS=1`. S3
gets this right (~L10970-10976); S1/S2 contradict it.

Implication. With the container down, each S1 "Run it RED" fails at setup, not
with the documented RED text, and a literal builder cannot tell setup failure
from the intended RED. State the probe once in section 0 and use the S3 wording
everywhere.

### F4 [LOW] Slice gates S3.7 and S4.13 are weaker than section 0 promises

What is wrong. Section 0: slice gates run "the touched workspaces' tests". S1.8
and S2.14 run the whole app workspace; S3.7 runs a 20-file subset (~L13697)
although S3 changes outputs other suites consume (`resolveRelayComposeInputs`
now returns `introFallback` on every owned naked result; `RosterPreview`; the unit
GET and both contact-list write responses). S4.13 runs the dashboard suite but no
lint step at all, while S1.8/S2.14/S3.7 each lint. S4 edits dashboard files in
the area holding all 23 pre-existing `react-hooks/*` errors, and S4.3 replaces
`RosterConfirmDialog`'s effect with render-time `setState` - exactly what
`recommended-latest`'s `set-state-in-render` / `set-state-in-effect` rules govern
(`eslint.config.mjs:48-51`).

Implication. A regression or new lint error from S3/S4 first surfaces at S5.12,
after a 22-34 minute e2e run, in a cross-slice diff. Make S3.7 run `npx vitest run`
for the app workspace and add a baseline-compared scoped eslint step to S4.13.

### F5 [LOW] Spec 4.7 (P4) bullet 2 is neither delivered nor declared out of scope

What is wrong. Spec 4.7: "After a remove, a landlord-clearing restore, or a
landlord swap, a unit with a live landlord of record or at least one ELIGIBLE live
roster contact has a live primary - unless liveness was unknown." The plan follows
4.6 literally: the heir runs only when the removed row / old landlord was the
flagged primary (S2.5 ~L6630, S2.7 ~L7966). A unit whose flagged primary is a
SOFT-DELETED third contact keeps it after removing any other row, and after a swap
of a non-primary landlord, even with a live landlord of record - no live primary,
contrary to the P4 sentence. No task names the gap and no test pins either
reading.

Implication. The plan should state which reading it implements (4.6's, with P1,
the property box and the script as the backstop) and pin it with one test, so a
code reviewer anchored on 4.7 does not file it as a defect - or a reviewer
anchored on 4.6 does not miss it if 4.7 is the intent.

### F6 [LOW] Stale draft prose contradicts the binding rulings it points builders at

What is wrong. Section 3.2 says the "full table, with reasons" is
`plan-research/plan-assembly-rulings.md`, but that file's R2 row (L16) still says
S2's import step "replace[s] it with the plain `import { isAutoRoutingEligible,
readRosterContacts }`", while plan 3.2 says R2 was "Changed at assembly" (S2.4
imports BOTH names; S2.8 drops the alias) and S2.4's code block follows 3.2.
Other stale prose that is not a "ruling needed" question and so is not neutralised
by the slice headers: S2 contract issue 11 (~L3673-3679, "imports
`isAutoRoutingEligible` BY THAT NAME"), S5 contract issue 3 (~L17251, "the e2e gate
runs under `timeout 1500`" vs R24 / S5.12's 2700).

Implication. A builder who follows the rulings file's R2 at S2.4 deletes the alias
while `soleLandlordToPromote` still calls `autoRoutingEligible`, breaking
typecheck until S2.8. Update the rulings file's R2 row and strike the stale
sentences.

## Coverage walk (spec decision -> task), no further gaps found

4.1 P1 -> S1.2, S1.5-S1.7 (diagnostic codes/texts pinned per state, S1.7 table);
4.2 -> S1.1, S2.3/S2.5/S2.7/S2.9 per-attempt reads, S2.10 exclusion;
4.3 -> S1.3; 4.4 P2 + 409 + ordering -> S2.2-S2.4; 4.5 -> S2.1;
4.6 remove / delete / contact restore / clear / swap -> S2.5-S2.11 (F1, F5);
5.1-5.2 -> S3.1-S3.3; 7.1-7.2 -> S4.2-S4.5; 7.3 -> S4.9; 7.4 -> S4.7-S4.8;
7.5 -> S3.5-S3.6, S4.1, S4.6, S4.10; 7.6 -> S4.12; 8 -> S2 audits, S3.4, S4.11,
S5.1-S5.4, S5.10; 9.2 comment fixes -> S1.6, S2.3, S2.13, S4.1, S4.6, S4.9;
10 tests -> per task (both read-failure shapes on add, remove, GET, delete
fan-out and restore); 12 -> S5.9, S5.11; 13 -> S5.10.
