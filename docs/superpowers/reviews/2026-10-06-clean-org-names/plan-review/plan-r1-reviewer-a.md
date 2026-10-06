# Plan review r1 - reviewer A (adversarial)

- Plan: `docs/superpowers/plans/2026-10-06-clean-org-names.md` (29,048 lines, commit efea53ac)
- Spec: `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md` (revision 6), branch A only
- Method: read the spec in full, plan sections 0-3 and the watch items, then every
  slice; checked every quoted `old_string` the edits depend on in S2, S3, S4, S5, S6,
  S7, S8, S9, S12, S13, S15 and the S11 tenant-form / composer / suggestion-accept
  anchors against the worktree (all found, all unique where the plan claims it);
  grepped `app/src`, `app/scripts`, `app/test`, `dashboard/src` and `e2e/` for every
  writer and reader of `housingAuthority`, `agency`, `accepted_authorities`,
  `jurisdiction` and `audience_filter.housing_authority`. Read and grep only; no
  suite was run.

## Verdict in one paragraph

The plan is unusually complete. Every spec decision D1-D15 and every writer and
reader of section 9 maps to a task; I found no unenumerated writer (the only
contact writers of the two fields are the PATCH parser `app/src/routes/contacts.ts:631-645`,
the AI apply/accept paths, the importer and the seeds; the only unit writers of
`accepted_authorities` are `app/src/routes/units.ts:438-466` / `:1320-1390`, the
importer and the seeds; the only broadcast create is `app/src/routes/broadcasts.ts:520`),
and the quoted current code I checked matches the repo byte for byte. What is
wrong is mostly where the plan quietly departs from the APPROVED spec without the
spec being revised (findings 1, 2, 5, 7, 8), plus a handful of seams between
slices that a literal builder will trip on (9, 10, 11). Nothing I found blocks the
build; two findings change what reaches production and should be settled before
the build starts (1, 2).

---

## 1. [MEDIUM] Contacts are read through the byTypeStatus GSI, not the base table, by every Settings read and every rewrite pass - the spec says base tables

**What is wrong.** Spec D11 (spec line 466): "The job reads base tables, not the
GSI: every contact of every type, active and deleted". Spec section 6 (line 685):
the "Not on the list" view is "Computed on demand from base-table reads". The
plan's single contact iterator, `everyContact()` in `app/src/services/orgRecords.ts`
(plan Task 3.4, lines 3657-3676), pages `contactsRepo.listByType(type, ...)` for a
hard-coded set of five types (`CONTACT_TYPE_KEYS`, plan 3619-3626).
`listByType` is a Query on the `byTypeStatus` GSI (`app/src/repos/contactsRepo.ts:1124-1162`),
whose keys are `type` (hash) and `status` (range) (`app/src/lib/tables.ts:91-94`).
That iterator backs `usage()` (the delete / kind-change `org_in_use` check),
`notOnList()`, `holders()` and `rewrite()` (rename, merge, every "Not on the list"
action). Units ARE read from the base table (`unitsRepo.list` is a Scan,
`unitsRepo.ts:930-946`), and the cleanup script reads BOTH tables with consistent
base Scans (plan Task 15.2, `scanAll`, 28031-28049). The planner accepted the GSI
read in `plan-research/plan-assembly-rulings.md` (S2-S5 issue 8: "ACCEPT (SPEC
note)"), but spec revision 6 predates that ruling and was never amended, and the
plan does not tell the builder this is a deviation.

**Evidence.** Plan 3657-3676, 3619-3626; `contactsRepo.ts:1124-1162`;
`tables.ts:91-94`; spec D11 (466), section 6 (685), section 8 (762-763);
`contactsRepo.ts:533-561` (the `RequiredIndexKeyRemovalError` docblock records
that a contact could lose `status` and vanish from every `listByType` reader
before that guard existed).

**What it implies.**
- Two different populations: a contact the GSI does not index (no `status`, no
  `type`, or a `type` outside the five-member union - the lean seed comment at
  `app/src/lib/seed/lean.ts:160-167` records that an off-union type,
  `housing_authority_staff`, once existed in the seeded data)
  is mapped by the cleanup script but is never counted in usage (so Delete /
  Change kind can remove a name it still holds), never listed under "Not on the
  list", and never rewritten by a rename or merge. I1 is then violated silently,
  with no surface that would ever show it. Whether production holds such
  contacts is UNVERIFIED.
- GSI reads are eventually consistent: the `org_in_use` check before a delete can
  miss a holder written moments earlier (the delete route reads usage, then
  removes - plan 7614-7621, 7723-7732).

**Fix.** Either amend the spec (D11, section 6) to record the GSI read and its
consequences, or give `orgRecords` the same base-table Scan the script already
has (skip `phoneref#` / `emailref#` ids, as Task 15.2 does) and drop the
five-type list.

## 2. [MEDIUM] The plan settles spec section 13 itself: Appendix A (Fulton) and the seed mapping differ from the approved spec

**What is wrong.** Spec D2 (225-227) and section 13 (897-898): "Appendix A must
be final before the branch A plan is written", because the first read in an
environment pins the starting list there and later code edits never reach it.
Spec Appendix A still lists Fulton County Housing Authority as PENDING, with
spellings "Housing Authority of Fulton County; Fulton County; Fulton, Fulton
County" (929-930), and section 7 maps `fulton_housing` to "section 13 item 1"
(735-736). The plan instead "decided by the planner 2026-10-06, Sam's answers no
longer block the build" (1377-1385): `STARTING_ORG_LIST` gets the Fulton entry
with ONE spelling and deliberately drops "Fulton County" (1341-1346, test
1270-1278), and S12 maps `fulton_housing` to it (14616, 14754-14755). The same
document contradicts itself: the watch items say PENDING-SAM amendments are the
planner's to apply later and the builder must "never guess them" (29046-29048),
and S6/S7 still call it "the PENDING Fulton entry" (8112, 8656, 10919). The
starting list also carries four notes that are not in Appendix A, one of them a
fact not in the spec's research at all ("North Regional Office in Atlanta",
1313; also 1319, 1345, 1351).

**Evidence.** Plan 1341-1346, 1377-1385, 14616, 14754, 29046-29048, 8112, 8656,
10919; spec 225-227, 735-736, 897-898, 929-930.

**What it implies.** The builder ships a starting list the approved spec does
not contain, and per D2 that list is what dev and prod are born with on the
first read after the deploy. If Sam's answer differs, the fix is manual Settings
work in two environments (and Fulton tenants' "Fulton County" values will not
auto-map either way). This is a product decision recorded only in a planner
note.

**Fix.** Put Sam's answers (or Cameron's explicit sign-off on the planner's
call) into a spec revision - Appendix A rows, Fulton spellings, the
`fulton_housing` mapping, and whether starting entries carry notes - then make
the plan's three Fulton references agree.

## 3. [LOW] A stale rewrite run keeps writing records after a newer rewrite took the lock

**What is wrong.** Spec D11 (488-490): "It acts only while `lastRewrite` still
carries its id and `running`". The job checks currency once, at the start
(`runOrgRewriteJob`, plan 6656-6661). Afterwards `heartbeat()` silently writes
nothing when the lock is no longer the run's (plan 5564-5573) and the pass loop
never learns it (plan 4408-4418 swallow and continue), so the pass keeps writing
records. The plan's own test of this case (6563-6575) asserts only that
`lastRewrite` is not overwritten - not that the stale run stops writing.

**What it implies.** If a run's heartbeats fail for 15 minutes (the lock goes
stale) and an admin presses Run again or starts another rewrite, two passes
write concurrently; e.g. an old "use X -> A" pass can re-write records a newer
"rename A -> B" pass already visited, leaving them on a spelling. Rare, and the
conditional writes keep it from corrupting anything else.

**Fix.** Let `heartbeat()` report "not current" and have `rewrite()` abort the
pass on it.

## 4. [LOW] The cleanup's audit payloads use `null`, contradicting binding plan 3.8 and the job's `''`

**What is wrong.** Binding section 3.8 (429-436): "`from` and `to` are STRINGS
... a removed value is `''`" - the job follows it (`to: ''`, plan 4285, 4312,
3961-3966). The script's `planContact` emits `from: ha ?? null` / `to: nextHa ??
null` (27347-27348), pinned by its tests (27030-27031, 27519-27522); S15's own
preamble claims "CONTRACT ISSUE 2: strings" (26982).

**What it implies.** Two shapes for the org audit events on contacts. No reader
shows contact org audits today, so the cost is a future reader that trusts 3.8.

**Fix.** Emit `''` (and the joined list for units) as 3.8 says, or amend 3.8.

## 5. [LOW] A name-variant "Not on the list" row offers Clear and "Use another name", which the server always refuses - and the dashboard shows "Something went wrong"

**What is wrong.** Spec D10 lists Clear for every row. The plan adds a server
guard (CONTRACT ISSUE 3, plan 6250-6260): a value that differs from an entry's
name only in case or punctuation may only be settled with "Use <that entry>";
anything else is a 400 whose `error` is an English sentence. The dashboard still
offers "Use another name" and Clear on every row (`settleChoices`, plan
24071-24073). `errorFrom` turns `body.error` into `ApiError.code`
(`dashboard/src/api/client.ts:75-80`), and `orgErrorMessage` falls back to
`ORG_GENERIC_ERROR` for any code not in its map (plan 16635, 16658). The same
applies to the other sentence-shaped domain 400s of `resolveNotOnList`
(6240, 6248, 6281, 6286, 6291).

**What it implies.** Between the deploy and the cleanup apply (and for any
record the cleanup skipped) an admin gets buttons that can never work, with a
generic error. The guard itself is right (without it a Clear of "atlanta housing
authority" would clear every exact holder, by D11's normalized matching), but it
is a spec deviation the spec does not record.

**Fix.** Hide those two actions for a `match` resolution whose value normalizes
to the matched NAME, give the guard a code with copy, and note the rule in D10.

## 6. [LOW] `compoundSpans` is leftmost-longest; spec D4 says spans are taken longest first

**What is wrong.** Spec D4 (266-268): "spans taken longest first, so a span inside
a longer matching span does not count". The plan scans left to right and takes
the longest phrase at each position (787-816). The two rules disagree when a
longer phrase starts later and overlaps an earlier, shorter one (phrases "a b",
"b c d" and "a": text "a b c d" is one span left-to-right, two spans longest-first).
The tests only exercise texts where both agree (683-704, 1260-1269).

**What it implies.** A compound-vs-unknown verdict - which decides whether Split
is offered and whether a name can be added - can differ from the spec's rule for
some future list. Not reachable with the starting list as far as I can find.

**Fix.** Implement longest-first (or amend D4 to say leftmost-longest) and add
one test where they differ.

## 7. [LOW] Spec 5.1's `lastRewrite.fields` is dropped; Run again re-derives the fields from the target's current name

**What is wrong.** Spec 5.1 (642-654) stores `fields: string[]` ("which record
fields it rewrites"). Plan 3.2 (155-175) has no `fields`; the job derives a
rename's or merge's passes at run time by finding the entry whose NAME equals
`toName` (`passFields`, 6634-6639). Once a rewrite has FAILED it no longer holds
the lock, so the target can be renamed, merged or deleted before an admin
presses Run again; the re-run then fails with "the rewrite target is no longer
on the list" instead of "re-enqueues the same definition" (spec D11, 461-463).

**Fix.** Store the field list (or the target's kind) in `lastRewrite` at start,
as 5.1 says.

## 8. [LOW] API shape departs from spec section 6

Spec section 6 (681-682): `GET /api/organizations` with `?usage=1` adds the use
counts. The plan adds a separate `GET /api/organizations/usage` (plan 400,
7179-7185) and `GET /not-on-list/records` for the per-row records. Functionally
equivalent and internally consistent, but the spec is the contract; record it.

## 9. [LOW] The plan does not stand on its own: dangling CONTRACT ISSUE and ruling references, a stale spec revision

- "Read ... the CONTRACT ISSUES at the top of these sections" (2369-2371): no
  such sections exist in the plan; they were stripped at assembly. Numbered
  references remain at 2380, 3797, 4791, 5030, 6024, 6250, 6609, 7612, 23530,
  25893, 26982, 26985, and the numbering collides across slices (S3's "ISSUE 2"
  is one-pass-per-field, S11's is `spellingFor`, S15's is string audits). The
  definitions live in `docs/superpowers/reviews/2026-10-06-clean-org-names/plan-research/plan-assembly-rulings.md`.
- Rulings (R1-F1, R2 decisions 2-6, R3-F1..F6, R4-F3..F7, R5) are cited as the
  authority for behavior throughout (e.g. 1027, 4756-4758, 9263, 9483-9484,
  9540, 9577, 12957, 21509) and live in `plan-research/planner-rulings.md`.
- The header calls the spec "revision 5, APPROVED" (line 5); the spec is
  revision 6. Line numbers are quoted "at 93c3c65b" (e.g. 8132, 8401), a commit
  other than the branch base d839494a.

Most task bodies inline the substance, so a builder can proceed, but a builder
told to "read the CONTRACT ISSUES" first will look for text that is not there.

## 10. [LOW] S8 / S10 seam: S10 quotes the pre-S8 import line and orders a STOP on what S8 deliberately left

Task 8.2 retargets `app/test/extractionSchema.test.ts:16` to
`import { housingAuthorityFor } from '../src/lib/housingAuthority.js';`
(13950-13953) "until S10 deletes it". Task 10.1 item 4 tells the builder to
delete the line `import { housingAuthorityFor } from '../src/lib/import/apply.js';`
(14532) - which no longer exists - and item 6 says any remaining LIVE CODE
import of a retired name means "STOP and report: S7 or S8 did not finish"
(14557-14558). The guard test will list exactly that import. A literal builder
stops at a state the plan created on purpose. Fix: quote the post-S8 line in
item 4.

## 11. [LOW] Orphaned documentation hand-offs; GLOSSARY "accepted authorities" left stale

- S12 leaves "NOTE for the S16 writer: `documentation/sequence-diagram-to-test.md:165`
  shows `accepted_authorities:['atlanta_housing']`" (14954-14955). S16's four
  tasks never touch that file; nothing executes the note.
- `documentation/GLOSSARY.md:296-310` ("accepted authorities") still says the
  legacy list is synthesized from `jurisdiction` "- no backfill" and describes a
  plain string list. S15's cleanup backfills `accepted_authorities` and D5 makes
  the members list names; Task 16.1 rewrites only the housing authority and
  agency entries (28550-28649). AGENTS.md asks for the glossary to be fixed in
  the same change that creates the drift.

## 12. [LOW] Unbounded text goes into `closeNames`' Levenshtein on every D5 refusal and every POST /check

`checkScalarWrite` -> `resolveOrgText` -> `closeNames` runs an O(|text| x
|target|) edit distance against every name and spelling of the field's kind
(plan 830-881). Nothing caps the text first: the contacts PATCH parser only
type-checks `housingAuthority` / `agency` (`app/src/routes/contacts.ts:631-645`),
`POST /api/organizations/check` only checks it is a string (7223-7226), and
`express.json()` accepts up to its 100 KB default (`app/src/app.ts:136`). One
signed-in request with a 100 KB value costs roughly 10^8 cell updates on the
event loop today and grows with the list (300 entries x 21 texts at the D13
cap). Internal users only, hence LOW. Fix: no name or spelling can exceed 120
characters (D13), so skip close names (or refuse) for longer text.

## 13. [LOW] Gate 4's hard timeout is shell-specific and may be shorter than a loaded full run

Task 17.2 gate 4 is `timeout 1500 npm run e2e` (28968). `timeout` is GNU
coreutils - under the PowerShell tool it is the Windows wait command and npm
never runs. 1,500 s is 25 minutes; AGENTS.md records a 17.9-minute baseline and
a 34.7-minute loaded run, this branch adds about a dozen e2e tests, and a
timeout kill orphans the lane that `reuseExistingServer` then adopts. The plan
says nothing about what to do when the timeout fires. Fix: name the shell, size
the timeout from a measured run, and add the abort procedure (AGENTS.md: stop
the lane, confirm no listener survives).

---

## Coverage walk (for the record)

| spec item | delivered by |
|---|---|
| D1 store, read-and-bump, no cache | S2 Tasks 2.1-2.3 |
| D2 create-only first read; seeds' unconditional put | S2 Task 2.1; S12 Task 12.1 (+ the reseed-window integration test) |
| D3 exact name, right kind | S1 Task 1.1 (`isOnListFor`) |
| D4 matching, ambiguity, compound, close names | S1 Tasks 1.2, 1.5 (see finding 6) |
| D5 one check, every writer | S1 1.3; S6 6.1-6.5 (contacts PATCH, units POST/PATCH, broadcast POST, preview, filter-send); S7 7.5 (apply), 7.7-7.8 (accept); S8 (importer); POST pinned to keep ignoring the fields |
| D6 pickers + "Is this really new?" | S11 Tasks 11.5-11.8 |
| D7 composer picker, 422 re-pick | S6 6.4-6.5; S11 11.9-11.10 |
| D8 AI block, fingerprint, apply, accept value | S7 7.1-7.8; S11 11.2, 11.11, 11.12 |
| D9 importer | S8 8.1-8.3 |
| D10 Settings | S5; S11 11.14-11.18 (see finding 5) |
| D11 rewrite job, lock, Run again | S3 3.5, 3.8-3.10; S4; S5 5.3 (see findings 1, 3, 7) |
| D12 spellings | S1 1.4; S3 3.7-3.10 |
| D13 limits, control characters, 300 KB | S1 1.4; S2 2.2; S3 3.1 |
| D14 / section 8 cleanup | S15 (see finding 4) |
| D15 intake fact | S9 |
| section 7 seeds, e2e, dev seam | S12; S14; S13 |
| section 9 readers | unchanged code paths verified (`audienceResolution.ts`, tenant/property facets, flyer, `similarUnits.ts`); run-log header and drop label S11 11.12; property Activity S11 11.13 |
| section 11 RUNBOOK | S15 Task 15.3 |
| section 12 follow-ups | S16 Tasks 16.2-16.4 |
| Appendix A | S1 Task 1.5 (see finding 2) |

Writers grepped and confirmed covered: `routes/contacts.ts` PATCH (the only
parser of the two fields, `parseTriageBody` at :509; `parseCreateBody` at :775
does not read them), `routes/units.ts` POST/PATCH (the only callers of
`validateUnitBody`), `routes/broadcasts.ts:520` (the only `broadcasts.create`),
`services/extraction/apply.ts`, `services/suggestionResolution.ts`,
`lib/import/apply.ts`, `lib/seed/{lean,cast,live,matrix,performance}.ts`,
`routes/dev.ts` (no existing fixture writes these fields; the new seam is S13).
No other `contacts.update` / `units.update` caller writes them
(`statusTransition.ts`, `public.ts`, `unmatchedEmail.ts`, `contactCapture.ts`,
`groupConvert.ts`, `groupMembers.ts`, webhooks checked).
