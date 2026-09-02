# Research B findings - plan vs. live tree, Tasks 4/5/6

Scope: `docs/superpowers/plans/2026-09-01-participant-snapshot-refresh.md` Global
Constraints and Tasks 4, 5, 6, checked against `W:\tmp\participant-snapshot-refresh`
at HEAD `e6599b4f`. Byte-exact quotations of every anchor are in
`.superpowers/sdd/research-B-reference.md`.

Severity key: BLOCKING = the builder would stop, or a test could not compile;
HIGH = a plan expectation value is wrong; MED / LOW otherwise.

---

## F1 (MED) - Task 4: the relay-groups replace-start line is off by one

Plan (`plan:756`) says to replace "the block from
`for (const status of ['open', 'connecting', 'closed'] as const) {` (`:1189`)".

In `app/src/routes/contacts.ts` that statement is at **`:1188`**. Line `:1189` is the
`listRelayGroups(status)` call INSIDE it. The plan's Files line (`plan:689`) states the
region as `:1189-1230`; the real inner region is `:1188-1204` (through
`const others = relayMemberLabels(...)`), with the inner loop closing at `:1226`, the
outer at `:1227`, and `groups.sort(` at `:1230`.

Delta: a builder replacing by LINE would orphan the `for (const status ...)` header and
delete the `listRelayGroups` call. The plan does name the symbol, so a
symbol-first builder is safe. Use `:1188` as the anchor.

## F2 (MED) - Task 4: the group-threads RED test's `title` assertion is vacuous

Plan `plan:738` expects `res.body.groups[0].title` to be `'With Marcus'` after the
change, and `plan:746` lists the RED failure as `'Marcus Landlord'`.

`groupThreadLabel` (`app/src/lib/groupTitle.ts:29-52`, first-name-only at `:36`) reduces
BOTH the stored `'Marcus Landlord'` and the contact-derived `'Marcus Renamed'` to the
first token `'Marcus'`. The existing pin at
`app/test/contactGroupThreads.test.ts:83` already asserts `'With Marcus'` off the STORED
name today.

Delta: the title expectation passes before AND after the change - it proves nothing
about precedence. Only the `otherMemberNames` assertion is actually RED, so Step 2 still
turns red overall and nothing breaks; but if the intent is to pin the title too, the
fixture must give the contact a different FIRST name (e.g. contact
`firstName: 'Marco'`, expecting `'With Marco'` against a stored `'Marcus Landlord'`).

## F3 (MED) - Task 5: the members-route replace region is `:481-506`, not `:483-505`

Plan `plan:816` and `plan:939` both state
`app/src/routes/relayGroups.ts:483-505` as "replace from `const members = await
Promise.all(` through `res.json({ members });`".

Real lines in `app/src/routes/relayGroups.ts`:
`const members = await Promise.all(` = **`:481`**; `res.json({ members });` = **`:506`**;
route closes at `:507`. `:483` is `if (!member.contactId) return member;` and `:489` is
the `delete` - both of those sub-anchors are correct.

The spec carries the same drift: `specs/2026-08-31-...-design.md:49` cites
`routes/relayGroups.ts:469-505`; the route actually spans `:469-507`.

Delta: replacing `:483-505` by line would leave the `Promise.all` header and the
`participants.map` line orphaned above the new code and the `res.json` duplicated below.
The plan names both anchor strings, so a symbol-first builder is safe.

## F4 (MED) - Task 6: the `rosterEdits.ts` phrase the plan tells the builder to replace is split across a line break

Plan `plan:1054` says: change ``the recipient list from `describeRoster` (backfilled
names)`` to ``the recipient list from `describeRoster` (contact-first names, stored name
as the fallback)``.

In `app/src/services/rosterEdits.ts` that phrase does not exist on any single line.
`:454` ends with "and the"; `:455` begins with "recipient list from `describeRoster`
(backfilled names) - one field cannot"; `:456` is "carry both.".

Delta: a literal single-string find/replace fails. The builder must rewrap the docblock
across `:453-456`, and the replacement text is longer than the original, so the wrap
changes. (The other comment target, `:440-441`, IS a clean two-line block and matches
the plan.)

## F5 (LOW) - Task 5: the two rewritten pins span `:427-448` and `:450-470`

Plan `plan:823`, `plan:827` and `plan:856` cite `:427-447` and `:450-469`. In
`app/test/relayApi.test.ts` the first `it(...)` runs `:427-448` and the second `:450-470`
(the closing `});` is one line lower in each case). Titles and bodies match the plan
verbatim. Replacing by the stated ranges would leave a stray `});`.

## F6 (LOW) - Task 4: `seedRelay` is at `:57`, its opts type at `:60-66`, and it accepts no `'connecting'` status

Plan `plan:697` says "read `seedRelay`'s `opts` shape at `:60-95`".

In `app/test/contactRelayGroups.test.ts` the function starts at `:57`; the `opts` type
literal is `:60-66`; the body runs to `:99`. The plan's two substantive claims are both
TRUE: it takes `{ status, ... }` and it sets `relay_status` itself (`:89`).

Additional fact the plan does not state: `opts.status` is typed `'open' | 'closed'` only.
The route reads THREE partitions including `'connecting'`, so the helper cannot seed a
connecting group without widening its type. The plan's Task 4 tests use only
`'open'`/`'closed'`, so they compile as written.

## F7 (LOW) - Global Constraints: `GET /conversations/:id` is at `:1996`; `:2004` is its response line

Plan `plan:21` lists as do-not-touch: "`routes/api.ts` `GET /conversations/:id`
(`:2004`) or `GET /group-members` (`:2020`)".

In `app/src/routes/api.ts` the `router.get('/conversations/:conversationId', ...)`
handler is at **`:1996`**; `:2004` is its `res.json({ conversation });`.
`GET /group-members` IS at `:2020` (the `router.get` line). The two anchors use
different conventions.

Delta: informational only - `:2004` is in fact the exact line the constraint means
(the sibling of the `:2201` response line Task 5 DOES hydrate), so the intent is
unambiguous. Recorded so a later reader does not conclude the route moved.

## F8 (LOW) - Task 6: `rosterActionsPoll.test.ts` also reads `describeRoster` and is not in the Step-4 run list

Plan `plan:1058` runs `rosterResolution`, `rosterEdits`, `relayGroupPreview`, `toursApi`
and `placementsApi`. `app/test/rosterActionsPoll.test.ts` also drives the roster GET
through `describeRoster` (fixtures at `:122-125`, seeded roster names at `:300-301`).

Delta: it will not fail (its stored roster names are byte-identical to its contacts'
display names - verified), but it belongs in the command for completeness.

---

## Not findings - checked and CORRECT

- `ConversationItem` is already imported in `app/src/routes/contacts.ts:66`
  (plan `plan:785`).
- `contacts` / `log` router consts are at `app/src/routes/contacts.ts:919` / `:918`
  (plan `plan:797`).
- `const groups: GroupThreadRow[] = [];` is at `app/src/routes/contacts.ts:1278`
  (plan `plan:787`); the four lines the plan replaces are `:1279-1282`.
- `nameFromContact` is imported at `app/src/routes/relayGroups.ts:39` and its ONLY use
  is `:491` (plan `plan:955`). `resolveMemberName` from the same import is still used at
  `:422` and must stay.
- `contacts` / `log` are in scope in `relayGroups.ts` at `:151` / `:148`.
- `app/src/routes/api.ts`: `log` `:558`, `contacts` `:635`, `GET /calls/:callId`
  `:2185`, `res.json({ call, conversation });` `:2201`. All MATCH.
- `vi` is genuinely ABSENT from `app/test/relayApi.test.ts:6`; the plan's "add it if
  absent" is required.
- `world.contactsRepo.getDisplaysByIds` exists on the fake
  (`app/test/helpers/twilioWebhookHarness.ts:1695`) as a shorthand method on a PLAIN
  OBJECT LITERAL, so it is both reassignable and bindable. For a contact with no
  firstName/lastName it returns `{ contactId, phone }` (no name); an absent contact
  yields no map entry.
- `createRelayGroup`'s fake (`twilioWebhookHarness.ts:703-742`) stores `participants`
  VERBATIM - it keeps a member with `contactId: ''` and adds/normalises nothing. The
  plan's expected member array is correct as written.
- `world.contacts` is `ContactItem[]`; `ContactItem` requires only `contactId` and
  `type` (`status?`, `firstName?: unknown`, `lastName?: unknown`). Every
  `world.contacts.push({...})` in Tasks 4 and 5 compiles.
- `voiceWebhook.test.ts`: `seedRelay(world, overrides?)` at `:31`, default roster
  `c-alice`/'Alice' and `c-bob`/'Bob'; it seeds NO contacts. `inboundVoiceParams()` at
  `:53` (`From: ALICE`, `To: POOL`, `CallSid: 'CAinbound0001'`). The
  `GET /api/calls/:callId` describe is `:897`, the first test `:898-916`. All MATCH,
  and the plan's expected RED value `'Bob'` is right.
- `app/test/relayGroupPreview.test.ts` EXISTS.
- `rosterResolution.ts`: `removed` guard `:541`, comment `:557-562`, `const name =`
  `:563-564`, `let sharesPhoneWithName` `:565`, `displayName` `:163`, `nonEmpty` `:170`,
  `contact = await deps.contacts.getById(...)` `:530`. All MATCH.
- `rosterResolution.test.ts`: `describeRoster` imported `:16`, `makeDeps` `:41`,
  `TOUR` `:74`, `contact` `:81` (yields `lastName: 'Person'`, so
  `contact('c-tenant','+1...','Tina')` displays as `'Tina Person'` - the plan's expected
  value is right), `relayGroup` `:91`, `describeRosterActions` describe `:522`, and
  there is NO existing `describe('describeRoster'` block.
- `rosterEdits.ts`: `buildOpenPreview` `:545`, `buildAddPreview` `:719`.
- NO `body` string can move under Task 6. `buildOpenPreviewFromParts`
  (`rosterEdits.ts:501-518`) composes the body from `parts.bodyMembers`, which
  `buildOpenPreview` builds from `resolveRoster` (`:556-564`, stored names), while
  `recipients` alone comes from `describeRoster` (`:600-607`). `buildAddPreview`'s body
  uses `candidate.name` (`:738`). The plan's STOP condition cannot trigger from this
  change.
- PREVIEW PINS: ZERO expectations need re-baselining. In `rosterEdits.test.ts`,
  `relayGroupPreview.test.ts`, `toursApi.test.ts`, `placementsApi.test.ts` (which has no
  `recipients` expectation at all) and `rosterActionsPoll.test.ts`, every fixture's
  stored roster name is byte-identical to its contact's display name, or the row is a
  bare-phone member with no contact, or it runs the STANDALONE builder that never calls
  `describeRoster`. Full table in the reference file.
- The truncation warn string the plan rewrites
  (`contacts.ts:1195`, currently containing an em dash) is asserted in NO test - the
  ASCII rewrite is safe.
