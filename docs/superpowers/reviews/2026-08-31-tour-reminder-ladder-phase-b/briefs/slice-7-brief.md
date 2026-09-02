# Slice 7 - Task 13 (relay catalog rewrite: `{names}`, `joinedName`, five entries; `member_added` UNTOUCHED)

Common brief (READ FIRST): `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\implementer-brief-common.md`
Report path: `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\reports\slice-7.md`
Research: report C sections 1-3 and 7 (catalog entries + docblocks byte-exact, `MessageId`
union at `catalog.ts:28-78`, `composeConnectionSentence` full body, importers, the catalog
tests that pin the relay entries, the TRIPWIRE inventory with per-task break column).

Scope: plan Task 13 (steps 1-4) EXACTLY. Files: `app/src/messages/catalog.ts`,
`app/src/jobs/relayFanOut.ts` (ONLY: rename `composeConnectionSentence` -> `composeNameList`
with the spec 9.2 TOTAL table; add exported `joinedName`; `composeIntroBody` keeps its CURRENT
signature and becomes `resolveMessage('relay.intro', { names: composeNameList(memberNames) })`),
`app/test/messages/catalog.test.ts`, `app/test/relayFanOut.test.ts`, the four PROSE mentions of
the old symbol (`app/src/lib/groupTitle.ts:60`, `app/src/services/relayGroupDuplicates.ts:11`,
`app/test/groupTitle.test.ts:88`, `app/test/relayGroupDuplicates.test.ts:322` - comments only,
NOT their logic), and the two e2e `{members}` split literals (ruling R10):
`e2e/tests/dashboard-next/contact-create-relay-group.spec.ts:203-215` and
`e2e/tests/tour-roster.spec.ts:237-282` - retarget the literal `'{members}'` -> `'{names}'`
ONLY (one-line each; the tour-roster block is rewritten wholesale in Task 14, not here).

THE TRAP (plan reviews P6 + PR2-1, binding): `relay.member_added` and `composeMemberAddedBody`
are NOT TOUCHED in this task. `joinedName` is written + unit-tested here but NOT wired;
`ANONYMOUS_JOINED_LABEL` stays until Task 14 deletes it. Every call site must be GREEN at your
commit: the naked intro is BYTE-IDENTICAL to today's composed output (the pin proves the seam).

Binding details (spec 9.1, 9.2, 9.2a; worklist s2 T13):
- Derive the byte-identity literal by RUNNING the PRE-CHANGE composer FIRST:
  `cd .../app && npx tsx -e "import('./src/jobs/relayFanOut.js').then(m=>console.log(JSON.stringify(m.composeIntroBody(['Alicia Reyes','Marcus Webb']))))"`
  (adjust the import form to what works) and paste its exact output into the pin. Also capture
  the three no-name cases (`[undefined,undefined,undefined]`, `[undefined,undefined]`,
  `[undefined]`) BEFORE changing anything and record them in your report - spec 9.2's table
  deliberately CHANGES the zero-others sentence ("You're now connected on this number. Reply
  here and the group sees it." -> "1 other person" phrasing) and drops the trailing "Reply here
  and everyone in the group sees it." from the LIST (it moves into the template); state exactly
  which composed outputs changed and that the named-roster output did not.
- Catalog: `relay.intro` default = spec 9.2's fenced text, `vars: ['names']`. ADD
  `relay.intro_tour_today` (`vars: ['tenantFirstName','propertyContactFirstName','time','where']`),
  `relay.intro_tour` (`['tenantFirstName','propertyContactFirstName','when','where']`),
  `relay.intro_placement` (`['tenantFirstName','propertyContactFirstName','where']`),
  `relay.member_added_role` (`['name','role']`, default `Hey, adding {name} to the group as the {role}.`)
  - copy BYTE-EXACT from spec 9.1 / 9.4 fenced blocks; `{where}` declared LAST; all
  `class:'operational', channel:'sms', editable:false`. Add the four ids to `MessageId`.
  Docblocks: founder wording 2026-08-24; the "on {when}" vs "at" ruling (spec 9.1); the
  housing-authority note beside `relay.intro_placement` (spec 9.1, dated 2026-08-20 removal
  was scoped to `relay.intro`); STOP omitted per changelog 1.2.1 #7 (spec 9.4).
- `composeNameList(memberNames: (string|undefined)[]): string` per spec 9.2's four-row table
  (Oxford list of FIRST names; `2 other people`; `1 other person`; zero-others -> `1 other person`).
  `joinedName(name: string|undefined): string` -> first name, else `'a new member'` (blank/whitespace
  -> `'a new member'`).
- Tests per plan T13 step 1 (write fully) + the catalog tripwire rewrite (`catalog.test.ts:62-70`:
  re-target the `{members}` override pin to `{names}` with the same editable-flag intent; extend
  the editable:false assertion to the four new ids). The existing catalog invariants (every
  token declared; non-editable entries use every var; no STOP in relay entries; no brand; no
  'housing authority' in `relay.intro`) must pass on the new entries unchanged.
- `relayFanOut.test.ts` composer cases (`~:674-701`): re-point `composeConnectionSentence` calls
  to `composeNameList` and re-derive expectations from the TOTAL table (the list no longer
  carries a sentence). Leave the member_added cases (`~:703-717`) ALONE - they must stay green.

Verify: `cd .../app && npx vitest run test/messages/ test/relayFanOut.test.ts test/toursApi.test.ts
test/placementsApi.test.ts test/relayGroupPreview.test.ts test/relayApi.test.ts test/rosterEdits.test.ts
test/groupTitle.test.ts test/relayGroupDuplicates.test.ts` - ALL green; `npm run typecheck` (root);
`cd .../e2e && npx tsc --noEmit -p .`; `grep -rn "composeConnectionSentence" app dashboard e2e`
-> zero hits. ONE commit: `feat(relay): founder intro entries; names token; member_added deferred
to the split`.
