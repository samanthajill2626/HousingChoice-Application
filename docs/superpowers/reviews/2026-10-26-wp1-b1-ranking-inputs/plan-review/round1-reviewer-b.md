# Plan review round 1 - reviewer B (adversarial)

Plan: docs/superpowers/plans/2026-10-26-wp1-b1-ranking-inputs.md (PLAN v1).
Spec: docs/superpowers/specs/2026-10-26-wp1-b1-ranking-inputs-design.md (rev 8).
Tree: W:\tmp\wp1-b1-ranking-inputs at main @d0e2c2d8 (source unbuilt).
Line references "plan:N" are lines of the plan file; "file:N" are lines of
the tree as read for this review.

Overall: spec coverage is complete - every D1-D7 decision, every spec 4
surface and every spec 5 test line maps to a task, and the slice drafts are
unusually well anchored (helpers, anchors, counts and even the WI2 literal
hashes check out against the tree; see "Verified" at the end). The defects
are at the SEAMS between slices that were drafted in parallel: several later
tasks contradict tests or APIs an earlier task creates, so a literal builder
hits red gates the plan says are green.

---

## F1 [HIGH] S5.5 deletes a prompt phrase that S4.6's own new test pins; S5.5 GREEN cannot be green

What is wrong. S4.6 appends a NEW case to app/test/extractionSchema.test.ts,
"keeps the reconcile, append-only, short-line and no-address rules verbatim",
which asserts `expect(sys).toContain('Addresses NEVER go in noteLines');`
(plan:7189-7195, the assertion at plan:7193). S5.5 then replaces that bullet
(prompt.ts:132-133) with "The client's OWN address NEVER goes in a noteLine
..." (plan:9087-9100) and its own new test asserts
`expect(sys).not.toContain('Addresses NEVER go in noteLines')` (plan:9009).
S5.5 Step 1a edits only the OLD pin (extractionSchema.test.ts:569-575, plan:8959-8975);
it never names S4.6's case. S5.5 Step 4 says "Expect all green" for
extractionSchema.test.ts (plan:9104-9107).

Evidence. Current pin at app/test/extractionSchema.test.ts:574; S4.6 test
text plan:7189-7195; S5.5 edit plan:9087-9100 and test plan:9006-9010; PR17
(plan:258-262) says S5.5 rewrites the bullet "and updates its pin
(extractionSchema.test.ts:574)" - one pin only. S4's own cross-slice note
(plan:5704-5708) already says S5 narrows that bullet, so S4.6 pinning it is
an S4-internal oversight.

Implication. Literal execution of S5.5 is red at GREEN. The builder must
edit an S4 test the plan never names, against ground rule "never revert an
earlier task" (plan:60-62) - exactly the improvisation the plan is meant to
remove.

Fix. Drop the `Addresses NEVER go in noteLines` assertion from S4.6's
"verbatim" case (S4 must not pin a bullet PR17 hands to S5), OR add to S5.5
Step 1 an explicit edit of that S4.6 case to the new wording, and name it in
PR17.

## F2 [HIGH] S6.6 writes a tenant matching key into extractionFake.ts, which S3.3's reader pin forbids - the app workspace goes red at S6.10/S7

What is wrong. S3.3 creates app/test/tenantMatchingInputsReaders.test.ts:
no file in READERS may contain any list key as a substring; READERS includes
`['adapters', 'extractionFake.ts']` (plan:4433-4456, extractionFake at
plan:4443). S6.6 inserts a header comment into app/src/adapters/extractionFake.ts
containing `EXTRACT:{"fields":{"area_preference":{"op":"write",...}}}`
(plan:13286-13301, the key at plan:13292). S6.6's only run is
extractionAdapter.test.ts (plan:13273-13276), so the break is not seen until
S6.10 Step 3 (`npx vitest run`, plan:13622-13631) or the S7 gates.

Evidence. plan:4443 and plan:4447-4456 (the `source.includes(key)` check);
plan:13292.

Implication. A definite red in the full app suite, found late. The tempting
fix - weakening the D1 "no reader names the four" pin - silently erodes the
spec D1 guarantee.

Fix. In S6.6 write the example payload without a literal key (e.g. "a
fields entry for one tenant matching input, keyed by its list key") or
build it from the list in the test only; or remove extractionFake.ts from
READERS with a stated reason in S3.3. Pick one in a planner ruling.

## F3 [HIGH] The S6 probe code and its test file are written against S4/S5 APIs the plan does not deliver; PR20 renames only

What is wrong. S6 was drafted against guessed signatures (its cross-slice
notes say "assumed", plan:10569-10596) and the code blocks were never
reconciled with what S4/S5 actually build:
- Block module and function: S6 imports
  `../src/services/extraction/propertiesSentBlock.js` in the test file
  (plan:11210) and the script (plan:11543, :11579) and calls
  `m.sentBlock.renderPropertiesSentBlock(sent.map(sentRow), displays)`
  (plan:11654). S5 builds `sentPropertiesBlock.ts` exporting
  `selectSentRows(rows)` and `renderSentPropertiesBlock(entries: SentPropertyEntry[])`
  (plan:8494-8559). PR20 (plan:267-271) fixes the NAMES only; the argument
  shape (rows + a displays map vs pre-joined entries) and the need to go
  through `selectSentRows` (production's "signed up" rule,
  latestCountedShareKey === 'flyer') are left to the builder.
- filterNoteLines: S6.3 `writtenLines` calls `m.apply.filterNoteLines({
  modelLines, systemLines, existingNotes, floor, demoted })` - no `prefix`,
  which S4.2 makes REQUIRED in `NoteLineFilterInput` (plan:6052-6053) - and
  reads `out.lines` (plan:12316-12323), while S4.2 returns `append` /
  `modelCount` (plan:6058-6067). Typecheck fails.
- Floor: S6.3 `factFloor` builds a whole `loadConfig(...)` (plan:12327-12333)
  although S4.1 exports `parseExtractionFactMinConfidence` precisely for the
  probe (plan:5694-5700, :5811-5827). Works, but it is a second path to the
  same value, contrary to the S4 note.

Evidence. Lines cited above. S6.2 notes tell the builder to "adjust these
functions only" (plan:12022-12026), i.e. the plan knowingly ships
non-compiling code for the merge-gate script.

Implication. S6.2-S6.4 are red at typecheck when executed literally, and
the property the spec D7 gate depends on - "the gate certifies production
code, not a copy" - rests on the builder's improvisation: a builder who
constructs `SentPropertyEntry` objects directly from the probe data (using
`SentProperty.signedUp`) bypasses `selectSentRows`, so the probe would no
longer certify production's row selection and signed-up rule.

Fix. Rewrite the S6 SEAMS block against the S4/S5 signatures as the plan
defines them: import `sentPropertiesBlock.js`; `renderSentBlock` = build
`ListingSendItem` rows (sentRow), run `selectSentRows`, join each with its
display address into `SentPropertyEntry`, call `renderSentPropertiesBlock`;
`writtenLines` passes `prefix` and reads `append`; `factFloor` calls
`parseExtractionFactMinConfidence(env.EXTRACTION_FACT_MIN_CONFIDENCE)`. Fix
the test-file import (plan:11210) to match. Then PR20 can say "S6's code is
already S5's API".

## F4 [MEDIUM] S4.3 misses the second exact ApplyOutcome pin; its GREEN claim is false, and S5.7's replacement text drops S4's fields

What is wrong. Two tests pin the whole ApplyOutcome with `toEqual`:
app/test/extractionApply.test.ts:207 ('op:none does nothing') and
:267-276 ('no-ops ALL field ops for a landlord contact'). S4.3 adds
`notesBelowFloor` / `notesDemoted` to ApplyOutcome (plan:6690-6705,
:6798-6802) but migrates only :207 (plan:6219-6220); its RED list
mentions only :207 (plan:6518-6519) and Step 4 claims all green
(plan:6859-6866). The landlord case at :267 then fails (outcome has two
extra keys). S5's notes assume "S4 also edits both" (plan:7489, :7561-7563),
which is not so. Separately, S5.7 Step 1a gives a replacement for :207 that
OMITS S4's two fields (plan:9774) while the prose says "keep S4's fields"
(plan:9765-9766) - the literal text is wrong.

Evidence. extractionApply.test.ts:207 and :267-276 (read); plan lines above.

Implication. Unplanned red at S4.3 GREEN; then S5.7's anchor
(`suggested: [],\n notedLines: 0,\n displaced: [],`, plan:9777-9789) no
longer matches whatever the builder did at S4.3.

Fix. Add the :267-276 pin to S4.3 Step 1c (`notedLines: 0, notesBelowFloor:
0, notesDemoted: 0,`), list it in S4.3's RED, and correct S5.7 Step 1a to
show both pins with S4's fields plus `appendedLines: []`.

## F5 [MEDIUM] Run-detail Notes block: S5.8 contradicts PR10 and never widens S4.5's render guard; its own zero-count test fails

What is wrong.
(a) PR10 (binding, plan:235-238) puts `feedbackLines`, `unlabeledAddressLines`
AND `sentPropertiesFingerprint` in the S4 "Notes lines" block. S5.8 puts the
fingerprint in the `<header>` and its test asserts it there (plan:10194-10195,
:10277). A builder obeying PR10 (rulings win) fails S5.8's test.
(b) S4.5's `NotesLines` returns null unless the run carries
`notesBelowFloor`/`notesDemoted` or `notedLines > 0` (plan:7115-7116). S4's
cross-slice note says S5 "widens the render condition" (plan:5691-5693), but
S5.8 Step 3 never says so: it says put the two rows "immediately after S4's
last row, in the same element type" (plan:10280-10282). S5.8's test "shows a
zero count as 0, not as missing" renders a run with `feedbackLines: 0`,
`unlabeledAddressLines: 0`, no floor/demotion counts and the fixture's
`notedLines: 0` (AiRunsSection.test.tsx:26 fixture, read) - NotesLines
returns null, so `getByText('Feedback lines: 0')` throws.

Implication. Red at S5.8 GREEN on the literal path; and the plan cannot
tell the builder whether the fingerprint belongs in the header or the block.

Fix. Decide in PR10: fingerprint in the header next to the org-list
fingerprint (as S5.8 builds) or in the block (then change S5.8's test). In
S5.8 Step 3 state the widened guard explicitly, e.g. render when any of
notesBelowFloor / notesDemoted / feedbackLines / unlabeledAddressLines is
defined or notedLines > 0.

## F6 [LOW] Planner rulings override spec text although section 1 says "the spec wins on any doubt"

PR24 (plan:289-291) removes the `_source` keys the spec puts on `ContactPatch`
and the create type (spec D2, spec:141-144); PR21/PR22 add rules the spec
does not state (excluded case "not measured", uncommenting four other
`.env.example` keys). Each is reasonable, but plan:72 ("the spec wins on any
doubt") and plan:14-18 ("Section 4 ... wins over any slice text") leave the
spec-vs-ruling precedence undefined. Fix: say in section 0 that section 4
rulings that deviate from the spec are listed for Cameron's plan-gate
approval, and list PR21, PR22, PR24 among them.

## F7 [LOW] secrets:sync handback item contradicts PR22, and sync writes an EMPTY value, not 0.7

PR22 (plan:279-283): `npm run secrets:sync` is NOT a handback obligation.
S6.10 Step 7 lists it as a handback item for Cameron (plan:13681-13682) and
S6's cross-slice note 7 implies the real files "gain the new key" through it
(plan:10605-10607). scripts/lib/secretsCore.mjs:239-246 (read) writes
`KEY=` with an EMPTY right-hand side for a key new to the real file. Harmless
only because S4.1 reads blank as the 0.7 default (plan:5749-5753, :5819). Fix:
strike the S6.10 handback item per PR22, or state that the synced line is
empty by design and blank means 0.7.

## F8 [LOW] UNVERIFIED price table values

S6.1 hard-codes `claude-sonnet-5-5: { input: 2, output: 10 }` and
`claude-opus-4-8: { input: 5, output: 25 }` with source "claude-api model
table, cached 2026-10-06" (plan:11142-11150), and pins them in a test
(plan:10812-10816). Nothing in the repo lets a builder verify them; a wrong
row silently mis-costs the gate record spec D7 requires. Fix: have Cameron
confirm the two rows at the plan gate, or cite a committed source.

## F9 [LOW] S7.1-S7.3 give no exact command to run a single new e2e spec

S7.1 says "drive the file with the e2e workspace runner the README names for
a single spec" (plan:13895-13898); S7.2 and S7.3 give no command at all. The
plan's own ground rule forbids stray Playwright invocations (AGENTS.md) and
the root script's argument handling is not stated. Fix: write the exact
e2e-workspace command (and how to pass the file) once in section 11.

## F10 [LOW] Banned-term list will raise false gate FAILs on ordinary home facts

Lines of EVERY case are checked against the union of all terms
(plan:12466, decision 4 at plan:10617-10622). Terms such as `grade`
("grade-level entrance" - a home accessibility feature the prompt itself
invites), `black` ("black mold"), `citizen` ("senior citizen"), `country`
are matched at a word start (plan:10872-10900, :12411-12419). Each false
hit fails the gate and forces a term edit, which changes case hashes and
requires a new paid run. Not a build blocker; Cameron should see the list
at the plan gate.

---

## Verified (no finding)

- Coverage: every spec D1-D7 bullet, spec 4 surface and spec 5 test line
  maps to a task (S1-S7 coverage tables re-walked against the spec).
- Unenumerated surfaces checked and clear: no other ApplyDeps / ExtractionJobDeps
  construction site beyond worker.ts:489, routes/dev.ts:765 and the two
  harnesses (grep); no other `noteLines` consumer in app/src or dashboard/src;
  no contact merge path; importer and lib/import have no priority/intake
  reference; `same_day_rta` surfaces = the ones S2 edits; unit GET returns
  the whole item (units.ts:1025-1037); contacts update REMOVEs null
  (contactsRepo.ts:1577-1615); PATCH supersedes pending suggestions for any
  changed field (contacts.ts:2034-2052); no PATCH type-gate on
  TENANT_ONLY_TARGETS (contacts.ts:1662).
- No new import cycle: suggestionResolution -> apply is new, and nothing
  reachable from apply.ts imports suggestionResolution (importers are
  journalSweep, routes/api, routes/suggestions).
- WI2 literals: sha256 first-16 of the two rendered lines = 8804bb247bad2f59
  and f0196a44d5ac9368, matching plan:8674-8675.
- Test helpers the plan uses exist with the stated shapes: extractionJob.test.ts
  (makeHarness, callMsg, tenantContactWith, unknownContact, NOW Jul 17),
  extractionApply.test.ts (makeDeps updateImpl/findByPhone, NOW Jul 16),
  suggestions.test.ts (seedTenant, seedSuggestion, accept, dismiss, ACTOR),
  unitsRepoDisplays.test.ts (stubDoc script signature, 4-attempt retry loop
  at unitsRepo.ts:1283), extractionAdapter.test.ts (8 `orgListBlock: '',
  profile:` sites, markerInput), extractionSchema.test.ts (4 six-space
  `orgListBlock: '',` sites).
- Exact-count pins enumerated by S3 C1 match the tree (journalSweep.test.ts:135,
  extractionJob.test.ts:1129, the two 35-row tables).
