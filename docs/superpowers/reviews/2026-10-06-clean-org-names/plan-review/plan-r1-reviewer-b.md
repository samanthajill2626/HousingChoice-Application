# Plan review r1 - reviewer B (adversarial)

- Plan under review: `docs/superpowers/plans/2026-10-06-clean-org-names.md` (29,048 lines, commit efea53ac)
- Spec: `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md` (revision 6). Branch A covers D1-D15 and sections 5-9 and 11-12.
- Repository read at the worktree HEAD (efea53ac). The source tree is unchanged since the branch point d839494a (only docs commits since), so every "current code" quote was checked against what a builder will see.

Method
- I read plan sections 0-3 and S1 in full.
- I walked every spec decision and section to the task that delivers it.
- I grepped the whole repo for writers and readers of `housingAuthority`, `agency`, `accepted_authorities` and `audience_filter.housing_authority`.
- Slice by slice, I verified quotes, existing symbols, cross-slice seams and RED states. Eight parallel read-only verifiers did this first pass, one per slice range, and I re-checked every finding below at the cited lines unless it is marked UNVERIFIED.
- No file other than this one was created or changed, and no test suite, build or e2e run was executed.

## Verdict

The plan is unusually careful: about 600 quoted anchors were checked and are verbatim (a few line numbers drift), the binding interfaces in section 3 agree with the slices that implement and consume them, and every writer in spec section 9 is covered. No spec decision is left undelivered.

The build will still stall in one place. S10's guard test cannot pass against S8's own test file, and its old_string is the pre-S8 text (F1).

Six MEDIUM items need a plan change before the build:
- one product decision the spec reserved for Cameron and Sam (F2);
- two departures from spec D11's data-path rules (F3, F4);
- a dashboard/server contract mismatch (F5);
- two gate failures a literal builder will hit (F6, F7).

Everything else is LOW.

---

## Findings

### F1 [HIGH] S10 cannot go green as written: its permanent guard flags S8's own test, and its quote of `extractionSchema.test.ts:16` is the pre-S8 text

What is wrong
- S8 Task 8.2 appends a source-check block to `app/test/importOrgNames.test.ts` (plan 13792-13799). Its test title contains `lib/housingAuthority.ts`, and its assertions contain the string literals `'housingAuthorityFor'` and `'KNOWN_AUTHORITIES'`.
- S10 Task 10.1 adds `app/test/orgListsRetired.test.ts` (plan 14411-14449). It walks `app/src`, `app/scripts` AND `app/test`, and fails on `/\bhousingAuthorityFor\b/`, `/\bKNOWN_AUTHORITIES\b/` and `/\/housingAuthority\.(?:js|ts)\b/`. All three match S8's file.
- S10 never names `importOrgNames.test.ts`. Its offender rule (plan 14551-14558) covers only two cases: "a COMMENT - rewrite it" and "LIVE CODE (an import or a call) - STOP and report". Its expected-hits grep (plan 14591-14593) leaves the file out.
- S8 Task 8.2 (plan 13948-13955) re-points `app/test/extractionSchema.test.ts:16` to `import { housingAuthorityFor } from '../src/lib/housingAuthority.js';`.
- S10 item 4 (plan 14532) tells the builder to delete `import { housingAuthorityFor } from '../src/lib/import/apply.js';`. That is the pre-S8 text, so the edit target does not exist. The line that does exist is a live import of the module S10 deletes, and S10's own rule 6 says to STOP on that.

Implication: a builder following the plan literally halts at S10, or improvises by editing another slice's test.

Fix:
- S10 deletes S8's source-check block, since the guard supersedes it.
- S10 quotes line 16 as S8 leaves it.
- S10 lists `importOrgNames.test.ts` among the files it edits.

### F2 [MEDIUM] The starting list settles spec section 13 on the planner's own authority and departs from Appendix A

What is wrong
- The spec makes a final Appendix A a precondition of this plan: "Appendix A must be final before the branch A plan is written" (spec 897-898; see also D2, spec 225-227).
- Appendix A lists Fulton County Housing Authority as PENDING, with the spellings "Housing Authority of Fulton County; Fulton County; Fulton, Fulton County" (spec 929-930). Section 7 leaves `fulton_housing` to "section 13 item 1" (spec 735-736).
- The plan adds the entry with ONE spelling (plan 1341-1346), and three places lock that in:
  - its conformance test pins `Fulton County` as NOT a match (plan 1270-1274);
  - S12 maps `fulton_housing` to the full name (plan 14754-14755);
  - S14 explains its Decatur substitution as if Fulton were not on the list (plan 25230-25233).
- The only authority cited is "decided by the planner 2026-10-06" (plan 1377-1385; `plan-research/plan-assembly-rulings.md`, "Starting list (planner, 2026-10-06)"). Neither Cameron nor Sam made the call.
- The watch items tell the builder about "PENDING-SAM AMENDMENT items (S1 Task 1.5, S12)" (plan 29046-29048), but no such marker exists anywhere else in the plan.
- S6 still explains its test edits with the superseded state: `Fulton County` is "a spelling only of the PENDING Fulton entry" (plan 8112, 8654-8657).

Implication: D2 seeds every environment ONCE from this list (spec 221-227), so whatever ships becomes prod's list, and later corrections are manual Settings edits. Before the build:
- get Cameron's explicit sign-off, or revise Appendix A and section 13;
- delete the stale watch item;
- correct the stale rationale in S6 and S14.

### F3 [MEDIUM] Every Settings read and every rewrite pass lists contacts through the `byTypeStatus` GSI, but the spec requires base-table reads

What is wrong
- Spec D11 (spec 466-467): "The job reads base tables, not the GSI: every contact of every type, active and deleted". Spec section 6 (spec 685): "Not on the list" is "Computed on demand from base-table reads".
- `orgRecords.everyContact()` (plan 3658-3676) loops `contacts.listByType(type, ...)` over five hard-coded types. `listByType` is a Query on `byTypeStatus` (`app/src/repos/contactsRepo.ts:1124-1150`), keyed hash `type`, range `status` (`app/src/lib/tables.ts:90-94`).
- That one generator feeds:
  - `usage()`, which the router's `org_in_use` check for delete and kind change uses (plan 7614-7621);
  - `notOnList()` and `holders()`;
  - every rewrite pass (plan 4467).
- The cleanup script, by contrast, scans the base tables (plan 26979-26980; `scanAll` at plan 28031).

Implication
- **Eventual consistency.** GSI reads are eventually consistent, so a record written moments before a rename, merge, Use or delete check can be missed.
- **Unsettleable records.** A delete whose in-use check misses a holder leaves a record holding a name that is no longer on the list. "Not on the list" reads the same GSI, so that record may never appear there.
- **Sparse index.** The index is sparse on both keys. A contact with a `type` outside `ContactType` (`contactsRepo.ts:51`), or with no `status`, is invisible to the counts, to "Not on the list" and to every rewrite. The code treats such rows as bugs and the create paths set both keys, so prod exposure is UNVERIFIED.
- **Inconsistent previews.** The cleanup dry run (base scan) and the Settings page (GSI) can disagree about what is "not on the list".
- **Undocumented deviation.** It rests on a planner ruling outside the plan (`plan-assembly-rulings.md:77-82`).

Fix: scan the contacts base table, as S15 does, or have the spec changed.

### F4 [MEDIUM] A rewrite run that loses its lock keeps writing records, and the plan's own test enshrines it

What is wrong
- Spec D11 (spec 488-490) says the job "acts only while `lastRewrite` still carries its id and `running`". The job checks that once, at start (plan 6658).
- `heartbeat` is `Promise<void>` in binding interface 3.4 (plan 326), and it silently does nothing once the lock is not the job's (plan 5564-5573). The pass swallows heartbeat failures and has no stop path (plan 4407-4419), so it can never learn that it lost the lock.
- The job's docblock claims "a run whose lock a newer rewrite took over does nothing" (plan 6589-6597). The test meant to prove it, "a stale run never overwrites a newer rewrite that took the lock meanwhile" (plan 6563-6575), hands job-2 the lock mid-pass and asserts only `lastRewrite`. Job-1 still writes every record after the takeover, and the test passes.

Implication
- A newer rewrite takes the lock while the old pass keeps writing in two cases:
  - after 15 minutes without a successful heartbeat (for example repeated `OrgListBusyError` on heartbeats);
  - when a second worker picks up an SQS redelivery past the 120 s visibility timeout (`infra/modules/jobs/main.tf:36`; the consumer never extends visibility).
- Example: an old merge A->B keeps writing B while a newer rename B->C runs. Records end up holding B, which is now only a spelling. Those are off-list values written after the deploy (spec I1).
- With one worker, a batch runs to completion before the next poll (`app/src/adapters/sqsJobConsumer.ts:126-129`), so this is rare. But the builder will ship the false docblock and the vacuous test as written.

Fix: `heartbeat` returns whether the lock is still the caller's (a change to interface 3.4), the pass aborts when it is not, and the test asserts that no record is written after the takeover.

### F5 [MEDIUM] "Not on the list" offers "Use another name" and "Clear" on name-variant rows, which the server always refuses with an uncoded 400

What is wrong
- **Server side.** S3 `resolveNotOnList` (plan 6247-6259, the planner's "CONTRACT ISSUE 3") checks whether a row's value normalizes equal to an entry NAME of the field's kind, for example `merlin housing authority`. If so, it refuses every action except `use` with that same entry. The reason: the pass matches normalized text, so any other action would also rewrite every exact holder of the name. The refusal is a 400 whose `error` is an English sentence, not a code.
- **Dashboard side.** S11's `settleChoices` (plan 24038-24075) still offers "Use another name" and "Clear" on such rows. The 11.17 unit test pins exactly that offering for the row `merlin housing authority` (plan 23726-23731).
- **Error copy.** `orgErrorMessage` maps an unknown code to generic copy (plan 16658-16660, 16764-16765). No e2e uses those buttons on a variant row.

Implication: two buttons always fail with "Something went wrong" on that row type. Such rows exist between the deploy and the cleanup apply, and on lanes. Spec D10 lists Clear for every row, so the server rule is also an undocumented narrowing of D10.

Fix:
- On a name-variant row (status `match`, and the normalized value equals the normalized match name), offer only `Use <match>`.
- Give the server refusals codes and copy.
- Change the pinned test.

### F6 [MEDIUM] Task 3.2's typecheck step cannot pass: its test names a `UnitsRepo` method that only Task 3.3 adds

What is wrong
- Task 3.2 creates `app/test/orgRecordWriters.integration.test.ts` with `units: Pick<UnitsRepo, 'rewriteAcceptedAuthorities'>` (plan 2806-2808), and requires `npm run typecheck` GREEN before committing (plan 3143-3146).
- `UnitsRepo` gains `rewriteAcceptedAuthorities` only in Task 3.3. The interface currently ends at `list(...)` (`app/src/repos/unitsRepo.ts:430-431`).
- The typecheck gate compiles `test/` (`app/package.json:13`, `app/tsconfig.test.json:14`), so it fails with TS2344.

Implication: the vitest runs pass (vitest strips types), but a builder who honors the gate is blocked at Task 3.2.

Fix: move the `units` half of the suite into Task 3.3, or move the typecheck and commit to the end of Task 3.3.

### F7 [MEDIUM] The two new data hooks likely trip `react-hooks/set-state-in-effect`, a NEW lint error that gate 5 blocks on (UNVERIFIED: eslint not run)

What is wrong
- `useOrgList` mounts with `useEffect(() => { void load(); return () => abortRef.current?.abort(); }, [load])`, where `load` sets state after an await (plan 17097-17117).
- `useOrgAdmin` has the same shape in its mount effect (plan 21709-21712) and its liveness effect (plan 21722-21730).
- The rule is on for every non-test dashboard file (`eslint.config.mjs:48-51`); only `*.test.*` files are exempt (`:57-68`).
- Every existing instance of this loader shape carries a justified `// eslint-disable-next-line react-hooks/set-state-in-effect`, with the note "sets state only AFTER an await". I checked `dashboard/src/routes/contact/useContactTimeline.ts:502-505`. The slice verifier also reported `PlacementDetail.tsx:200-205`, `AuthContext.tsx:43-48` and `UnreadContext.tsx:170-172, 263-265`.
- The plan writes no such disable, yet claims these files lint clean.

Implication: gate 5 ("no new errors in files you touched", AGENTS.md) fails at S17 on two new files, or the builder improvises mid-slice.

Fix: add the codebase's justified disable to all three effects.

### F8 [LOW] "Run again" re-queues the stored definition without re-checking its names against the current list

- `runAgain` (plan 6340-6358) re-runs `last` exactly as stored.
- `remove()` and `changeKind()` refuse only while a rewrite is RUNNING (plan 5188, 5216), and `org_in_use` counts only exact-name holders.
- **Deleted target.** If a failed value action's target is then deleted, Run again writes a name that is no longer on the list (spec I1). Example: an "Add as new" whose enqueue failed, so nothing holds the new name yet.
- **Re-kinded target.** For rename and merge, the passes' fields come from the target entry's kind at run time (plan 6633-6638). A kind change in between makes the passes rewrite the wrong fields. Spec 5.1 stores `fields: string[]`, but plan 3.2 dropped it.
- Fix: re-check `toName` and `agencyName` inside the `runAgain` mutate, else 409.

### F9 [LOW] "Unchanged" decisions rest on reads that can be stale and on writes that are not conditional

- **Units pre-read.** The units PATCH decides "already held", and grants the legacy-`jurisdiction` pass, from `units.getById` (plan 8966-8972). That read is eventually consistent: `app/src/repos/unitsRepo.ts:561-563` sets no `ConsistentRead`, and the interface at `:333` takes no option. Task 6.1 deliberately switches the contacts pre-read to `{ consistentRead: true }`, because "a stale read could pass an off-list value through as unchanged" (plan 8460-8468). The same reasoning applies to units.
- **Contacts write.** The contacts PATCH judges "unchanged" against its pre-read, but its write is conditional only on staff notes (`app/src/routes/contacts.ts:1599-1610`). If a rewrite changes the field between the read and the write, an API caller that re-sends the old off-list text as "unchanged" writes it back (spec I1). The dashboard never sends an unchanged value, so only API callers are exposed.
- **Delete and kind change.** Both count uses with a full scan, then do a separate list write (plan 7614-7621, 7714-7729). A record written in between ends up holding a deleted or re-kinded name. The plan accepts this only in a ruling outside the plan.

### F10 [LOW] A value that normalizes to '' (for example `-`, `.`, `()`) shows under "Not on the list" but can never be settled

- `notOnList` skips only an exact `''` (plan 3743).
- The pass drops empty normalized from-texts (plan 4434), so Use or Clear on such a row finishes `done` with zero counts and the row stays.
- "Add as new" with such a value passes `checkNewName`, which tests only `trimmed === ''` (plan 1121-1122). That creates an entry whose name normalizes to ''.
- Whether such stored values exist: UNVERIFIED.

### F11 [LOW] Move and Split write two fields but audit one

Move to Agency, Move to Housing authority and Split also SET the other field (plan 4316-4359). But each record write appends one event, naming only the matched field (plan 4479). No audit payload records the agency a contact received. This meets the letter of D11 but loses provenance.

### F12 [LOW] S15 cleanup script: contract and robustness details

- **`null` audit payloads.** Plan 3.8 (plan 431-436) says `from`/`to` are STRINGS and a removed value is `''`, and the rewrite job complies (plan 4312-4339). S15's `FieldAudit` is `string | null` (plan 27244-27250), its planner writes `null` (plan 27347-27348), and its tests pin it (plan 27030-27031, 27043). Nothing reads contact audit partitions today, so the two event families simply disagree.
- **Heartbeat placement.** The run heartbeats only after a write attempt (plan 28171-28196, and the same for units). A long stretch with nothing to write never refreshes the lock, so after 15 minutes a rewrite can take it while the apply keeps writing (the F4 class).
- **Misleading CLI message.** A lock failure other than a refusal, or a `finish()` that throws after a completed run, lands in the CLI catch. That catch prints "FAILED (see the PARTIAL report above)" although no PARTIAL report was printed (plan 28072-28097, 28447).
- **Own "deleted" test.** The run tests `row['deleted_at'] !== undefined` (plan 28170, 28209) instead of the repos' non-empty-string rule (`app/src/repos/contactsRepo.ts:324-326`).
- **No-op Activity lines.** Backfilling an unresolvable `jurisdiction` audits `from == to`, which the property Activity tab renders as "X -> X" (plan 27376, 27537).

### F13 [LOW] The Settings tab re-polls two full scans every 2 s and aborts each in-flight read

- While a rewrite runs, `useOrgAdmin` re-reads `/usage` and `/not-on-list` every 2 s, and `loadDetails` aborts the previous read first (plan 21686-21727).
- Each read is a full pass over every contact type and every unit (F3). If one takes longer than 2 s, no count or row refreshes until the rewrite stops.
- The aborted scans still finish on the server.
- The instant-mock test cannot see any of this.

### F14 [LOW] Untested settling paths and inconsistent disabled states in the Settings UI

- **Move to Housing authority.** No NotOnListSection fixture has an `agency` row (plan 23585-23621), and S14 lists this action as uncovered end to end (plan 26806-26810). Its label, request body and field gating are untested.
- **Split.** Its halves are prefilled but never edited in a test.
- **Disabled states.** Change kind and Delete stay enabled while a rewrite runs (plan 23370-23432), though the server refuses both with 409 `org_rewrite_running` (plan 5188, 5216). Rename and Merge are disabled.

### F15 [LOW] Phone width and a transient false "Not on the list" mark in the new pickers

- **Overflow at phone width.** The shared Button is `white-space: nowrap` (`dashboard/src/ui/Button.module.css:11`). "Is this really new?" renders a button per name (plan 18381-18400, 18486-18503), for example "Use HUD-Veterans Affairs Supportive Housing (HUD-VASH)", and names run up to 120 characters. At 375 px that overflows the dialog's content box of about 309 px, and the dialog scrolls sideways. The plan adds no wrap override, though its own self-QA requires usability at 360 px (plan 28998). The chip remove target is also only 18x18 px.
- **Transient mark.** After "Yes, add it", the new chip is checked against the previous `orgList.entries` until `reload()` lands, so it briefly carries the "Not on the list" mark (plan 19178-19181, 19918-19922). The unit-test reload mocks return the old list, and nothing asserts on it. S14's add test asserts only the chip's remove button (plan 26104-26108).

### F16 [LOW] The AI list block's over-budget WARN also fires, with a wrong message, for entries dropped by the TRANSCRIPT rule

`dropped` also counts entries left out because their text is not renderable (plan 9876-9884). The job logs any non-zero count as "organization list over the prompt budget" (plan 10233-10238). Spec D8 asks for WARNs on budget drops only.

### F17 [LOW] Small spec-I1 and suggestion gaps in S7

- **Replayed journals.** A journal claimed by pre-deploy code and replayed after the deploy writes its stored, unchecked text. Recovery replays stored plans and never reads the list (plan 12356-12358, 12397). The window is tiny.
- **Dismissals.** Dismissal tombstones are keyed on the normalized old suggested text (plan 11357-11385). So a dismissed `Atlanta (AHA)` no longer blocks the same authority when it is suggested under its full name. Informational.

### F18 [LOW] RED cases that are already green and not marked PIN, and wrong RED reasons

Section 0 requires an already-green case to be marked (PIN). These are not:
- **Task 5.1.** The RED note says "every request answers 404" (plan 7078), but the case "sits behind requireAuth" (plan 6993-6996) gets its expected 401 at RED and passes.
- **Task 5.3.** The RED note (plan 7970-7972) says the rename cases "fail only on their job assertions". But "an admin rename answers 202..." (plan 7825-7858) already passes: Task 5.2 shipped PATCH `{ name }` and S4 registered the handler. The other rename case fails on the run-again 404 instead.
- **Task 7.2.** "never reads the list on a skip path" (plan 10082-10096).
- **Task 7.8.** "accepts the name the text resolves to" and "accepts a name staff just added" (plan 12468-12480). Its RED note (plan 12613-12616) also misstates why the other cases fail: they fail on a 422, not on the valueKey.
- **Task 11.7.** Its RED reason, "no combobox named 'Housing authority'" (plan 18861-18863), is wrong. Today's `<input list=...>` (`dashboard/src/routes/contact/ContactEditForm.tsx:519-528`) already has the implicit combobox role under that label. The new tests still fail, for other reasons.
- **Task 11.12.** "a run that never read the list shows no organization list line" (plan 21292-21295).

### F19 [LOW] Final-step and gate details

- **Task 17.1 merge (plan 28942, 28952-28953).**
  - In a non-TTY shell `git merge main` commits a clean merge itself, so "then commit the merge (... plus the trailer)" has nothing left to commit. Use `--no-commit`, or say how the trailer is added.
  - `git fetch` is pointless for a local `main`.
  - There is no `npm ci` after a merge that changes the lockfile.
- **Gate 4 timeout.** `timeout 1500 npm run e2e` (plan 28968) allows 25 minutes, but Task 14.9 says the suite "takes 20-40 minutes" (plan 26931), and this branch adds 11 org-lists tests. Nothing says to tree-kill the stack and check the lane ports if the timeout fires, though AGENTS.md warns that `reuseExistingServer` adopts an orphaned stack on a commit match.
- **Gate 5.** Plan 28974 expects exit 0, but a pre-existing lint error sits in a touched file (`dashboard/src/routes/broadcasts/useComposerDraft.ts:116`, recorded in `plan-assembly-rulings.md`). The handback list (plan 29005-29013) does not ask the builder to name pre-existing errors, which AGENTS.md requires.
- **Operator actions.** The handback's owed actions (plan 29008-29012) omit "dev first" (spec section 8).
- **No full-suite checkpoint.** The full `npm test` runs only at S17 (plan 28963). Every earlier task runs named files only, so any fallout a task fails to name surfaces only at the end.

### F20 [LOW] Documentation drift the branch leaves behind

- **Glossary.** `documentation/GLOSSARY.md:296-310` ("accepted authorities") still says legacy units are synthesized with "no backfill", and says nothing about list names. Task 16.1 rewrites only lines 271-294, yet S15 backfills and D5 constrains members. AGENTS.md requires fixing glossary drift in the same change.
- **RUNBOOK.** Step 1 (plan 28472) describes the printed summary by key names that only the JSON done line uses (plan 28242-28250 vs 28362-28389).
- **README.** S14 never adds `orgFixture` to the README's fixtures list (`e2e/README.md:601`).

### F21 [LOW] Dangling and stale cross-references a context-free builder will trip on

- "the CONTRACT ISSUES at the top of these sections" (plan 2369-2371) do not exist in the plan. They live in `plan-research/plan-assembly-rulings.md:59-88`, and the same numbers mean different things in S3, S11 (plan 23530), S14 ("PIN, see CONTRACT ISSUE 5", plan 25893) and S15 (plan 26982-26985).
- Plan line 5 cites spec revision 5; the spec is at revision 6.
- The work map's S4 row names `app/src/worker.ts (+ in-process wiring)` (plan 94), but S4 says the worker needs no edit (plan 6387-6391).
- The watch item's typed-fakes list (plan 29026-29028) omits `audienceResolution.test.ts`, which Task 3.2 does update (plan 3114-3119).
- S14's isolation proof:
  - It says `git grep -n "Accepts" -- e2e/tests e2e/scenarios` "prints nothing" (plan 25037-25042). It prints four `teamAcceptsRent` lines: `e2e/scenarios/steps.ts:3326`, and `e2e/tests/scenarios/approval-and-move-in.spec.ts:216,328,353`. Use `"Accepts:"`.
  - The same rule says "15 other specs" and then lists 17.
- Edit counts do not match their lists: "five edits" lists six (plan 25445); "seven edits" lists six (plan 26818).
- Task 11.7 says `git grep -n orgVocabulary -- dashboard` lists `files.test.tsx:125` (plan 18564-18565). It lists only `ContactEditForm.tsx:73,177`.
- Task 11.1 changes the mutation-catalog assertion to 118 but leaves the header comment at `e2e/performance/mutationCatalog.test.ts:367` saying 111 (plan 15616-15634).
- Line references drift where earlier tasks in the same slice insert lines above them:
  - S7 Tasks 7.4, 7.5 and 7.8;
  - S8 Task 8.2;
  - S9 items 3-4;
  - S5 Task 5.1's harness reference;
  - S11 Task 11.9: `AudienceFilters.tsx` is cited at `:31-33`, but the text is at 32-34.

  Every anchor is unique text, so the edits still apply.

### F22 [LOW] S14 selector and timing nits

- Two CSS locators break the accessibility-first rule (`e2e/support/selectors.md`):
  - `page.locator('section', { has: heading 'Activity' })` (plan 26430) copies existing usage; `selectors.md:59` warns this pattern can match two sections.
  - `page.locator('body')` is used as the `pickOrgName` scope (plan 26230).
- A fixed `page.waitForTimeout(1_500)` guards the "typing never commits" check (plan 26225). Under load it can only let a real bug slip through; it cannot cause a false failure.

### F23 [LOW] API and data-model shapes differ from spec sections 6 and 5.1 without saying so

- **Usage counts.** Spec section 6: `GET /api/organizations?usage=1` adds the counts. Plan 3.6 (plan 400) instead ships a separate `GET /api/organizations/usage`.
- **Records.** Spec section 6 returns records "per row, on request". The plan ships them as a separate `GET /not-on-list/records`.
- **`lastRewrite.fields`.** Spec 5.1's `fields: string[]` is dropped; see F8.

Both API shapes are consistent inside the plan, since S11 consumes 3.6. The plan should record the deviation so that a spec-anchored reviewer does not flag the as-built API.

---

## Coverage walk (spec decision -> task)

| Spec | Delivered by | Verdict |
|---|---|---|
| D1 store, read-and-bump, no cache | S2 Tasks 2.1-2.2 | delivered |
| D2 lazy create-only seed; seeds put unconditionally | S2 Task 2.1; S12 Task 12.1 (reseed window pinned in `seedProfile.integration.test.ts`); every profile and `/__dev/reseed` go through lean `SEED.settings` (`app/src/lib/devReset.ts:100-107`) | delivered |
| D3 exact text, right kind | S1 Task 1.1 | delivered |
| D4 matching, compound, close names | S1 Tasks 1.2, 1.5 | delivered. I traced the conformance loop by hand against every starting spelling; it holds. |
| D5 every writer | S3 Task 3.6; S6 (contacts PATCH, units POST/PATCH, broadcasts POST); S7 (apply, accept); S8 (importer); S4/S15 (machine writers) | delivered (F9). Contacts POST stays allowlisted (`app/src/routes/contacts.ts:775-860`). |
| D6 pickers + "Is this really new?" | S11 Tasks 11.5-11.8 | delivered (F15), including "Put it in Agency" on the tenant form and no move on property forms |
| D7 composer; re-check at draft preview and the filter send only | S6 Tasks 6.4-6.5; S11 Tasks 11.9-11.10 | delivered. The send re-check sits inside branch (c) only (`app/src/routes/broadcasts.ts:786-790`). |
| D8 AI list block, fingerprint, apply, accept value | S7; S11 Tasks 11.11-11.12 | delivered (F16-F18) |
| D9 importer | S8 | delivered |
| D10 Settings | S5; S11 Tasks 11.14-11.18 | delivered except F5 and F14 |
| D11 rewrite job | S3 Tasks 3.5, 3.8-3.10; S4 | delivered except F3, F4 and F8 |
| D12, D13 | S1 Task 1.4; S3 Tasks 3.1, 3.7-3.10 | delivered (F10) |
| D14 cleanup | S15 | delivered (F12) |
| D15 intake | S9 | delivered |
| Section 7 seeds, e2e, dev seam | S12, S14, S13 | delivered. The lane reseeds per run (`e2e/support/preflight.ts:143`), `workers: 1` (`e2e/playwright.config.ts:140-141`), and only `org-lists.spec.ts` starts rewrites, each awaited. |
| Section 9 writers | all listed writers | delivered. A whole-app grep found no other writer: `public.ts:257`, `unmatchedEmail.ts:462`, `statusTransition.ts:597`, the group/capture stubs, dev routes and e2e fixtures write none of these fields. |
| Section 9 readers | unchanged-code readers | delivered. Property Activity passes every event type (`app/src/routes/units.ts:191-221`). The landlord timeline allowlists event types, so the new audit types cannot leak there (`app/src/routes/contactTimeline.ts:331-336`). Share messages do not render authorities; only the flyer page does. |
| Section 11 RUNBOOK | S15 Task 15.3 | delivered |
| Section 12 follow-ups | S16 Tasks 16.2-16.4 | delivered |
| Section 3 glossary | S16 Task 16.1 | delivered, except the adjacent entry in F20; branch-B entries are correctly left out |
