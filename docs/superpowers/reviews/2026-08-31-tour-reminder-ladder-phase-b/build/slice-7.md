# Slice 7 report - Task 13 (relay catalog rewrite: `{names}`, `joinedName`, five entries)

Branch `feat/tour-reminder-ladder-phase-b`, worktree `W:\tmp\tour-reminder-ladder-phase-b`.
Base at slice start: `6e153c83`. ONE commit: **`642b8755`**
`feat(relay): founder intro entries; names token; member_added deferred to the split`
(11 files, +437/-45).

## Status: SHIPPED, all four plan steps, no skips.

---

## 1. The pre-change composer capture (the brief's first binding step)

Run BEFORE any edit, from `app/`, against the live `composeIntroBody` /
`composeConnectionSentence`:

| roster | pre-change `composeIntroBody(...)` | post-change | changed? |
|---|---|---|---|
| `['Alicia Reyes','Marcus Webb']` | `Hey, it's Sam. You're now connected with Alicia and Marcus on this number. Reply here and everyone in the group sees it. Use this group text for anything that comes up. It can be a long process, so ask me anything in here!` | identical | **NO** |
| `[undefined,undefined,undefined]` | `...connected with 2 other people on this number. Reply here and everyone in the group sees it. ...` | identical | **NO** |
| `[undefined,undefined]` | `...connected with 1 other person on this number. Reply here and everyone in the group sees it. ...` | identical | **NO** |
| `[undefined]` | `Hey, it's Sam. You're now connected on this number. Reply here and the group sees it. Use this group text...` | `Hey, it's Sam. You're now connected with 1 other person on this number. Reply here and everyone in the group sees it. Use this group text...` | **YES - the one deliberate change** |

**Exactly ONE composed output changed**, and it is the one spec 9.2's table
legislates: the zero-others row. The pre-change code RESTRUCTURED the sentence
("connected on this number ... the group sees it"), which a token cannot do; 9.2
routes it to the `1 other person` phrasing so the single template always works.
**The named-roster output did not change**, on any arity - that is the
byte-identity pin, and it is asserted twice (via `resolveMessage` directly and
via `composeIntroBody`, so the seam itself is proven, not just the template).

Also captured for the record: the trailing sentence "Reply here and everyone in
the group sees it." moved OUT of the code-built list and INTO the
`relay.intro` default, exactly as 9.2 requires. The list value is now bare.

## 2. What shipped, per file

- **`app/src/messages/catalog.ts`** - `relay.intro` default rewritten to spec
  9.2's fenced text, `vars: ['names']`. Four entries ADDED byte-exact from the
  spec 9.1 / 9.4 fenced blocks: `relay.intro_tour_today`, `relay.intro_tour`,
  `relay.intro_placement`, `relay.member_added_role`; all
  `class:'operational' / channel:'sms' / editable:false`; `{where}` declared
  LAST in all three intro variants. All four added to the `MessageId` union with
  per-member comments. Docblocks written for: the founder wording + date
  (Sam 2026-08-24, Cameron 2026-08-31); the "on {when}" vs Sam's "at {when}"
  ruling and why the today form drops the date; the same-timezone note; the
  no-sender-identity exposure carried forward from the 2026-08-20 note with the
  founder-question pointer; STOP omitted per changelog 1.2.1 #7; the
  housing-authority note sitting BESIDE `relay.intro_placement` recording that
  the 2026-08-20 removal was scoped to `relay.intro` and that the new wording
  honours its rationale; and the `{where}`-last rule. The `{members}` block was
  replaced with a dated PHASE B note (superseded-wording history above it
  untouched - it is a deliberate historical record and still says `{members}`).
- **`app/src/jobs/relayFanOut.ts`** - `composeConnectionSentence` ->
  `composeNameList` (bare Oxford list of first names; `N other people` /
  `1 other person`; TOTAL, including on an EMPTY array). `joinedName` added and
  exported (first name, else lower-cased `a new member`). `composeIntroBody`
  keeps its CURRENT signature and is now
  `resolveMessage('relay.intro', { names: composeNameList(memberNames) })`.
- **prose-only** (`app/src/lib/groupTitle.ts:60`,
  `app/src/services/relayGroupDuplicates.ts:11`, `app/test/groupTitle.test.ts:88`,
  `app/test/relayGroupDuplicates.test.ts:322`) - symbol name only; the logic in
  both modules builds its own name list and was NOT touched.
- **e2e (ruling R10)** - `contact-create-relay-group.spec.ts` (STANDALONE, stays
  naked) and `tour-roster.spec.ts` (rewritten wholesale in T14) both retarget
  the split literal `'{members}'` -> `'{names}'`.
- **tests** - `catalog.test.ts` and `relayFanOut.test.ts`, below.

## 3. Tests written (TDD - red first, 11 failures, then green)

`app/test/relayFanOut.test.ts` (imports extended with `composeNameList`,
`joinedName`; `resolveMessage` was already imported):
- `composeNameList` Oxford list; the three no-name rows; PLUS two rows the plan
  sketch did not have - whitespace-only (`['  ']`) and the EMPTY array, both of
  which reach the `Math.max(len-1,0)` branch and must still answer rather than
  return `''`.
- a partially-named roster lists only the names it has (no placeholder mixed in).
- `joinedName` three rows, plus an explicit pin that it is NOT `'A new member'`
  (the sentence-initial constant) - the lower-casing is load-bearing for Sam's
  mid-sentence wording and is easy to "fix" back.
- the byte-identity pin, asserted through BOTH `resolveMessage` and
  `composeIntroBody`.
- the two nameless multi-member intros pinned byte-exact as well.
- the ONE deliberate change (zero-others), pinned in both directions: the new
  body exactly, AND `not.toContain("You're now connected on this number")`.
- the four new entries' resolved copy, exact.

`app/test/messages/catalog.test.ts`:
- the `:62-70` tripwire re-targeted `{members}` -> `{names}` with the same
  editable-flag intent, and the `editable === false` half extended from two ids
  to all SIX via a loop.
- NEW `it`: the 9.2a metadata table pinned directly - exact `vars` arrays in
  order, an explicit `{where}` is LAST assertion per intro entry, and
  `class`/`channel` for the four new ids.
- the STOP/brand assertions extended to the four new ids (previously only the
  two old relay entries).
- the housing-authority assertion given its scoping comment plus a POSITIVE pin
  that `relay.intro_placement` DOES carry the sentence - so a future reader who
  "fixes the drift" by deleting it trips a test.

The pre-existing catalog invariants (every token declared, no dead tokens on a
non-editable entry, no STOP, no brand, no 'housing authority' in `relay.intro`)
all pass on the new entries UNCHANGED, as spec 9.2a predicted.

## 4. Divergences from the plan / worklist - all three deliberate, all reported

1. **`legacyConnectionSentence` (module-private) was ADDED.** The brief is
   binding that `composeMemberAddedBody` is UNTOUCHED, but the rename forces it
   to reference *something*. Rebuilding its `{members}` value from
   `composeNameList` would have silently changed `composeMemberAddedBody`'s
   output on the zero-others roster - the same edge case 9.2 changes for the
   intro - which is a member_added behaviour change in Task 13. So the
   pre-change sentence is preserved verbatim in a private helper that Task 14
   deletes alongside `ANONYMOUS_JOINED_LABEL`. `composeMemberAddedBody` is
   byte-identical on EVERY input. **Task 14: delete `legacyConnectionSentence`
   too** - it is dead the moment the split lands, and gate 5 would attribute the
   unused-symbol error to that branch.
2. **Four extra prose lines touched beyond the brief's "one-line each".** The
   brief's zero-hits grep on `composeConnectionSentence` is only satisfiable if
   the two comments *describing the rename* stop naming the dead symbol, so both
   were re-worded to name `composeNameList` while keeping the provenance. And
   the two e2e blocks' assertion MESSAGES plus their two lead-in comments said
   "`{members}`" while the code now splits on `{names}` - left alone they are
   actively misleading. All six edits are comment/assertion-message text only;
   none can change a result. `app/src/messages/resolve.ts:27` was included: its
   re-expansion docblock used `"{members}"` as its example of a token-shaped
   literal, and that token no longer exists.
3. **The brief says "re-point `composeConnectionSentence` calls to
   `composeNameList`" in `relayFanOut.test.ts:~674-701`.** There are no such
   calls - that block only ever called `composeIntroBody`. Trusted the FILE:
   those cases are UNCHANGED and stay green (`['Alice']` and
   `[undefined,undefined]` both compose identically), and the direct
   `composeNameList` coverage was added as new describes instead.

## 5. Verification

| command | exit | result |
|---|---|---|
| `npx vitest run test/messages/catalog.test.ts test/relayFanOut.test.ts` (RED, pre-implementation) | 1 | 11 failed / 40 passed (51) - the intended red |
| `npx vitest run test/messages/ test/relayFanOut.test.ts test/toursApi.test.ts test/placementsApi.test.ts test/relayGroupPreview.test.ts test/relayApi.test.ts test/rosterEdits.test.ts test/groupTitle.test.ts test/relayGroupDuplicates.test.ts` | **0** | **10 files, 435 passed / 435** |
| same command re-run after the prose edits | **0** | **10 files, 435 passed / 435** |
| `npm run typecheck` (root) | **0** | clean (app, dashboard, e2e, fake-twilio, fake-twilio-web) |
| `cd e2e && npx tsc --noEmit -p .` | **0** | clean |
| `grep -rn "composeConnectionSentence" app dashboard e2e` | 1 | **ZERO hits** |
| `npx eslint <the 11 touched files>` | **0** | clean, no new errors |
| ASCII check on every ADDED diff line (562-line diff) | - | 0 non-ASCII |

`git status` was read bare before the commit (exactly the 11 expected files, no
`.git/MERGE_HEAD`); paths were staged explicitly, never `git add -A`.

Every tripwire report C section 7a marked "T13" is now converted; every one it
marked "survives" was re-run and did survive (notably
`relayGroupPreview.test.ts:151,208` and `relayApi.test.ts:296`, the null-owner
naked path, whose VALUES re-verified unchanged - which is the byte-identity
claim proven a second way, through the real standalone preview route).

## 6. Open worries - not blocking, your eye

- **`legacyConnectionSentence` must die in Task 14.** Called out above and in the
  symbol's own docblock, but it is the one thing this slice leaves behind that a
  later gate could attribute to the wrong branch.
- **`resolve.test.ts:92,97` still uses a literal `'{members}'`** inside a
  member_added probe body. That is CORRECT today (it is testing that a
  token-shaped literal in a VALUE stays literal, and `relay.member_added` still
  declares `members`), but when T14 switches that probe to
  `relay.member_added_role` the literal should become `{names}` or `{role}` or
  it stops demonstrating anything about a DECLARED token.
- **`catalog.ts`'s superseded-wording block still quotes `{members}`.** Left
  deliberately - it is a dated historical record of removed copy - but it means
  a future `grep {members}` is not a clean signal.
- **Spec 9.4's no-role wording (`Hey, adding {name} to the group.`) is NOT in
  the catalog yet.** Per the brief that is `relay.member_added`'s Task 14
  rewrite, not a fifth entry. Flagging because 9.2a's table lists
  `relay.member_added` with `vars: ['name']` and it still declares
  `['joined','members']` at this commit - that row of the table is Task 14's,
  and a reader diffing the table against the catalog now will see a mismatch.
- **`routes/dev.ts:965` replay-intros** now replays the rewritten naked intro at
  boot. Byte-identical for every seeded roster with names, so no e2e should
  notice; recorded because it is the seam that turns into a real behaviour change
  in Task 14 (report C section 7d).
