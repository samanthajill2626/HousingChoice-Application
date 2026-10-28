# Plan review round 1 - reviewer A

Plan: docs/superpowers/plans/2026-10-26-wp1-b1-ranking-inputs.md (v1, 14,004 lines)
Spec: docs/superpowers/specs/2026-10-26-wp1-b1-ranking-inputs-design.md (rev 8)
Tree: main @d0e2c2d8 (nothing built). Line numbers "plan:N" are lines of the
plan file; every code cite is a line I read in this worktree.

Question asked: if a builder with no context executes the plan literally, do
they produce the spec? Mostly yes - coverage of D1-D7 is close to complete
and most quoted anchors match the tree. The defects are at the SEAMS between
slices drafted in parallel (S4/S5, S4/S6, S3/S6, S5/S6) and in the S3/S4
commit commands. No finding blocks the build outright; two will make a
literal build go wrong without the builder improvising.

Findings are ordered by severity.

---

## 1. [HIGH] Every S3 and S4 commit runs `git add` / `git commit` with no `-C <worktree>` and no status / MERGE_HEAD read

What is wrong. All seventeen commit steps of S3 and S4 are bare
`git add <paths>` / `git commit -m ...` with no `-C W:/tmp/wp1-b1-ranking-inputs`
and no `cd`, and none shows the bare `git status` + MERGE_HEAD check section 0
requires. S1, S2, S5 and S6 all use `git -C W:/tmp/wp1-b1-ranking-inputs`.

Evidence. plan:3859-3860 (S3.1), 4122-4123, 4663-4664, 4816-4817, 4997-4998,
5173-5174, 5365-5366, 5480-5481 (S3.8, includes an e2e path), 5878-5879,
6142-6143, 6871-6872, 7021-7022, 7156-7157, 7274-7275, 7338-7339 (S4.7).
Section 0 (plan:30-35) requires the status read and MERGE_HEAD check before
every commit. .claude/CLAUDE.md "Claude worktree shell behavior": shell calls
lose the working directory; this session's primary working directory is the
SHARED main checkout (`W:\AI Projects\Housing Choice\HC Application`), and
agent shells reset to it. AGENTS.md: "Never move HEAD in the shared main
checkout"; memory rule "commit takes the WHOLE index".

What it implies. Executed literally from a reset cwd, `git add app/src/...`
runs against the shared main checkout: the paths are unmodified there, so it
stages nothing, and `git commit` then commits WHATEVER another agent has
staged in the shared index onto `main` (or fails "nothing to commit" and the
builder improvises). The first outcome moves main's HEAD with someone else's
work - the one thing AGENTS.md forbids outright.

Fix. Rewrite every S3/S4 commit block in the S1/S5 form: bare
`git -C W:/tmp/wp1-b1-ranking-inputs status`, the MERGE_HEAD `ls`, then
`git -C W:/tmp/wp1-b1-ranking-inputs add <paths>` and
`git -C W:/tmp/wp1-b1-ranking-inputs commit ...`. Add a planner ruling that
every git command in the plan carries `-C <worktree>`.

---

## 2. [HIGH] S6's probe code is written against S5/S4 APIs that do not exist; PR20 renames them but the signatures differ, so the "certifies production code" path is left to the builder

What is wrong.
- S6.2 test and script import `services/extraction/propertiesSentBlock.ts`
  and call `renderPropertiesSentBlock(rows, displays)` returning `{ text }`
  (plan:11210, 11543, 11579, 11650-11655). S5 builds
  `services/extraction/sentPropertiesBlock.ts` with
  `renderSentPropertiesBlock(entries: SentPropertyEntry[], opts?)` where an
  entry is `{ unit, sentAt, signedUp }`, and the "signed up" rule lives in
  `selectSentRows(rows)` (plan:8494-8559). PR20 (plan:267-271) says S5's
  names win, but the CALL SHAPE is different: S6's `renderSentBlock`
  hands raw `ListingSendItem` rows plus a display map; S5's renderer takes
  pre-joined entries and never sees a share ledger.
- `loadBaseModules` decides "is this a B1 checkout" by
  `existsSync(path.join(root, SENT_BLOCK_PATH))` with the wrong path
  (plan:11579, 11600). Literally built, the branch side is treated as
  pre-B1: the default suite sends NO block, and the never-written suite
  throws "needs a WP1 B1 checkout" (plan:11606).
- S6.3 `writtenLines` calls `filterNoteLines({ modelLines, systemLines,
  existingNotes, floor, demoted })` and reads `out.lines` (plan:12316-12323).
  S4's function REQUIRES `prefix` and returns `append`, not `lines`
  (plan:6038-6067). The text says "match the names to what S4 delivered"
  (plan:12347-12348), so the builder must also invent a prefix value.

What it implies. S6.2's test file fails to load (module not found) and the
script fails typecheck as written. More importantly the builder decides,
unaided, how the probe builds the block. The obvious shortcut - build
`SentPropertyEntry` objects straight from `SentProperty.signedUp` - bypasses
production `selectSentRows` (newest-20, sentAt narrowing, latest-counted-share
= flyer), so the gate no longer "builds each case's ... PROPERTIES SENT block
with the production block renderer" end to end (spec D7). The record would
still look fine.

Fix. Planner ruling, replacing S6 cross-slice note 4 and the S6.2/S6.3
seam code: `renderSentBlock(m, sent)` =
`m.sentBlock.renderSentPropertiesBlock(m.sentBlock.selectSentRows(sent.map(sentRow)).map((r) => ({ unit: sentDisplay(byId(r.unitId)), sentAt: r.sentAt, signedUp: r.signedUp }))).text`;
`SENT_BLOCK_PATH = 'app/src/services/extraction/sentPropertiesBlock.ts'`;
the test's `import * as sentBlock` uses that path; `writtenLines` passes
`prefix: '[Auto - Oct 20]'` (any fixed value; `existingNotes` is '') and reads
`out.append`. Then the S6.4 test "every request carries the production
PROPERTIES SENT block" also proves the signed-up line for
`probe-unit-peachtree`.

---

## 3. [MEDIUM] S4.3 migrates only one of the two exact `ApplyOutcome` pins; S5.7's edits of both pins drop S4's fields

What is wrong. `extractionApply.test.ts` has TWO whole-outcome `toEqual`
pins: :207 (`op:none does nothing`) and :268-279 (`no-ops ALL field ops for
a landlord contact`). S4.3 Step 1c adds `notesBelowFloor: 0, notesDemoted: 0`
to :207 only (plan:6219-6220). After S4.3 Step 3j the outcome always carries
both counts (plan:6798-6802), so the :268 pin fails, yet S4.3 Step 4 says
"All green" (plan:6865). S5.7 Step 1a then says "S4 also edits both"
(plan:7489, 7562-7563), quotes :207's PRE-S4 text as the anchor, and its
"new" text for both pins carries `appendedLines: []` but NOT S4's two
counts (plan:9774, 9784-9789) - applied literally, both pins stay red.

Evidence. app/test/extractionApply.test.ts:207 and :268-279 (read in the
tree; grep finds no other whole-outcome pin).

What it implies. Two red GREEN steps in a row; the builder fixes them by
improvisation, and S4's watch-item claim "typecheck/suite green at end of
S4" is false as written.

Fix. S4.3 Step 1c: also edit :271 to add `notesBelowFloor: 0,
notesDemoted: 0,`. S5.7 Step 1a: quote the post-S4 text as the anchor and
give the full post-S5 text
(`notedLines: 0, notesBelowFloor: 0, notesDemoted: 0, appendedLines: [], ...`)
for both pins.

---

## 4. [MEDIUM] S4.6 pins "Addresses NEVER go in noteLines"; S5.5 removes that bullet and asserts it is gone, and never edits S4.6's test

What is wrong. S4.6 adds the case "keeps the reconcile, append-only,
short-line and no-address rules verbatim", which asserts
`expect(sys).toContain('Addresses NEVER go in noteLines')` (plan:7193).
PR17 (plan:258-262) gives S5.5 the job of rewriting that bullet; S5.5
replaces it (plan:9091-9100), edits only the OLD hard-rules case (~570-576,
plan:8959-8975), and adds
`expect(sys).not.toContain('Addresses NEVER go in noteLines')` (plan:9009).
S5.5 Step 4 says "Expect all green" (plan:9105-9109).

What it implies. S5.5's GREEN is unreachable as written; the builder must
decide to weaken a test S4 added as a "verbatim" pin. The two slices encode
opposite truths in the same file.

Fix. S4.6 Step 1: drop the 'Addresses NEVER go in noteLines' assertion from
its "verbatim" case (PR17 already says S4 does not own that bullet), or have
S5.5 Step 1a list that case too and replace the phrase with
`"- The client's OWN address NEVER goes in a noteLine"`.

---

## 5. [MEDIUM] S6.6's fake-driver comment spells `area_preference`, which S3.3's readers pin forbids in that very file

What is wrong. S3.3 adds `app/test/tenantMatchingInputsReaders.test.ts`,
which fails if any listed reader file contains a tenant matching input key
as text; the list includes `adapters/extractionFake.ts` (plan:4433-4444,
4447-4456). S6.6 Step 2 inserts into extractionFake.ts the comment line
`//   EXTRACT:{"fields":{"area_preference":{"op":"write","value":"Decatur"}}}`
(plan:13292). S6.6 runs only extractionAdapter.test.ts and typecheck
(plan:13275, 13305). S6.10 Step 3 runs the whole app workspace and tells the
builder that a red file S6 did not touch is "an unrelated one ... recorded in
the report for the planner" (plan:13627-13631) - the readers test is a file
S6 did not touch.

What it implies. A red app suite after S6, likely mis-filed as unrelated,
surfacing again only at S7's gates.

Fix. In S6.6's comment use a non-key example (e.g. the label text
"Area preference" or `"<field key>"`), or drop `adapters/extractionFake.ts`
from the readers list with a reason. Add the readers test to S6.6's run
command.

---

## 6. [MEDIUM] Where the feedback counts and the PROPERTIES SENT fingerprint render: PR10, S4.5 and S5.8 disagree, and S5.8's zero-count test cannot pass inside S4's block

What is wrong.
- PR10 (binding, plan:235-238): the "Notes lines" block shows `notedLines`,
  `notesBelowFloor`, `notesDemoted` (S4) "then `feedbackLines`,
  `unlabeledAddressLines` and the `sentPropertiesFingerprint` (S5)".
- S4.5 builds that block with a render guard
  `if (!counted && run.notedLines === 0) return null;` where `counted` means
  notesBelowFloor/notesDemoted present (plan:7114-7121); the S4 cross-slice
  note says S5 "widens the render condition" (plan:5690-5693).
- S5.8 puts the fingerprint in the HEADER (plan:10276-10277) and asserts it
  there via the heading's parent (plan:10194-10195), and gives two
  placements for the counts: "after S4's last row, same element type" or the
  header (plan:10280-10291). It never mentions widening S4's guard. Its test
  "shows a zero count as 0" builds a run with `feedbackLines: 0,
  unlabeledAddressLines: 0`, `notedLines: 0` and no S4 counts
  (plan:10200-10209): inside S4's component that run renders nothing, so the
  test fails.

What it implies. A literal builder following PR10 fails S5.8's fingerprint
test; following S5.8's "after S4's rows" fails its zero-count test; only the
header fallback (which S5.8 says to use only if S4 rendered nothing) is
green, and that contradicts PR10.

Fix. One ruling: either (a) everything S5 adds goes in S4's "Notes lines"
block, the guard becomes "any of the five counts present or notedLines > 0",
the fingerprint is an `<li>` there, and S5.8's tests query the
`region "Notes lines"`; or (b) amend PR10 to the header placement and delete
S5.8's alternative. Write the exact JSX and test once.

---

## 7. [LOW] `factFloor` parses the floor through a full `loadConfig` instead of the parser S4.1 exported for the probe

What is wrong. S4.1 exports `parseExtractionFactMinConfidence` "so the
never-written probe reads the floor through the same rule without a full
loadConfig()" (plan:5694-5699, 5811-5827). S6.3's `factFloor` calls
`m.config.loadConfig({ NODE_ENV: 'development', ... })` (plan:12327-12333),
validating dozens of unrelated settings against a synthetic env. UNVERIFIED
whether `loadConfig` passes on `{ NODE_ENV: 'development' }` alone (the
existing config test always adds `CF_ORIGIN_SECRET`,
app/test/configAiExtraction.test.ts:5); S6.3's own test would surface a throw.

Fix. `factFloor` = `m.config.parseExtractionFactMinConfidence(env.EXTRACTION_FACT_MIN_CONFIDENCE)`.

---

## 8. [LOW] WI3's count sweep is word-only, so a numeric stale count survives

What is wrong. The WI3 grep matches `eight|twelve|eleven` as words
(plan:5473). `app/src/services/suggestionResolution.ts:46` reads "the daily
abandoned-journal sweep passes 12" and is not in S3.8's list (S3.8 item 7
fixes only :106-108, plan:5398-5410). After S3.1 the sweep passes
`DECISION_TARGETS.length` (16).

Fix. Add :46 to S3.8, and add `-e '\b12\b'` (reviewing each hit) to the WI3
grep over the same paths.

---

## 9. [LOW] PR22 says `secrets:sync` is not a handback obligation; S6 says it is

What is wrong. PR22 (plan:279-283): "`npm run secrets:sync` is NOT a handback
obligation". S6 cross-slice note 7 (plan:10605-10607) and S6.10 Step 7
(plan:13681-13682) list `secrets:sync -- dev|prod` as handback items for
Cameron. Note also that a sync writes the new key EMPTY
(`KEY=` for a key absent from the real file, scripts/lib/secretsCore.mjs:253-254);
harmless only because S4.1 reads blank as the default (plan:5819).

Fix. Strike the S6 handback line per PR22, or amend PR22; either way state
that a synced-but-empty value means 0.7.

---

## Coverage notes (no finding)

Walked every D1-D7 bullet, spec 4 surface and spec 5 test line to a task.
Delivered: D1 list + leaf pin + mirror/drift test + every named reader
(S1.1-S1.5, S3.1-S3.7, textual pin S3.3); D2 parsers/types/form/card/seed
(S1); D3 (S3, `text_field_filled` before coercion, C5); D4 (S4, PR9/PR11 read
of the order); D5.1-D5.3 (S5); D6 (S2); D7 (S6) plus RUNBOOK/env/GLOSSARY;
e2e (S7). Surfaces I grepped beyond the plan and found already covered or
genuinely untouched: contacts GET returns the full item
(app/src/routes/contacts.ts:1296-1298), the PATCH supersede loop is
key-generic (:1967-1978), journal enumeration iterates DECISION_TARGETS
(app/src/repos/suggestionResolutionRepo.ts:651), AI run detail returns the
stored run whole (app/src/routes/aiRuns.ts:271), `putRun` spreads its input
(app/src/repos/aiRunsRepo.ts:225), the only ExtractionJobDeps construction
sites are worker.ts, routes/dev.ts and the two harnesses, the only string
noteLines in the repo are the four e2e sites and four app test files the
plan names, and `listByContact` already filters `isListed`
(app/src/repos/listingSendsRepo.ts:486-497). The WI2 literal hashes in S5.4
(`8804bb247bad2f59`, `f0196a44d5ac9368`) are correct (recomputed).
