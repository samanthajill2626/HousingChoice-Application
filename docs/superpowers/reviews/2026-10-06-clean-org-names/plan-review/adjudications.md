# Plan design review - adjudications

Plan: `docs/superpowers/plans/2026-10-06-clean-org-names.md` (branch A).
Spec: revision 6. Planner: the feature-mission planner session.

## Round 1 (plan @efea53ac; reviewers A and B in parallel)

Reports: `plan-r1-reviewer-a.md` (13 findings), `plan-r1-reviewer-b.md` (23
findings). Adjudicated by theme; tags are reviewer.finding.

| # | Theme (findings) | Ruling | Resulting change | Decision changed |
|---|---|---|---|---|
| P1 | S10 guard flags S8's own source-check test; S10 quotes pre-S8 text (B.F1, A.10) | ACCEPT | Task 10.1 deletes S8's source-check block (the guard supersedes it), quotes `extractionSchema.test.ts:16` as S8 leaves it, lists `importOrgNames.test.ts` among its edits | no (seam fix) |
| P2 | The starting list settles spec section 13 on the planner's authority (B.F2, A.2) | ACCEPT as a LAUNCH-GATE QUESTION | spec Appendix A + section 13 updated to the planner default (Fulton County Housing Authority added with one spelling; `Fulton County`, `Clayton County`, `Cobb County`, `McDonough` are not spellings and go to "Not on the list"), marked "confirmed by Cameron at the launch gate"; stale PENDING-SAM watch item and the stale S6/S14 rationale removed | product decision for Cameron |
| P3 | Contacts read through the `byTypeStatus` GSI, not base tables (B.F3, A.1) | REJECT the switch; ACCEPT a spec amendment | Every contact list in the app reads that index; the repo refuses to remove its keys (`RequiredIndexKeyRemovalError`), so a row missing them is invisible app-wide (a guarded bug class), and a new scan method would break five typed fakes again. GSI lag is sub-second and self-healing: a record a rewrite or delete check misses shows in "Not on the list" once the index catches up, where Use settles it. Spec D11 / section 6 now say so. | no |
| P4 | A rewrite pass that loses its lock keeps writing; the takeover test is vacuous (B.F4, A.3) | ACCEPT | interface 3.4 `heartbeat(jobId): Promise<boolean>` (true = still the caller's lock); the pass checks ownership at each heartbeat and aborts the remaining writes when lost; the takeover test asserts no record is written after the takeover; the cleanup script's heartbeat runs on elapsed time, not only after writes (B.F12) | no (delivers the stated D11 guarantee) |
| P5 | Name-variant rows offer actions the server always refuses with an uncoded 400 (B.F5, A.5) | ACCEPT | spec D10: a row whose value normalizes equal to an entry NAME of the field's kind can only be settled with "Use <that entry>"; server refusal coded 409 `org_value_is_name_variant` `{ entry }`; the dashboard offers only that action on such rows; 11.17's pinned test changed | yes (narrows D10's actions on one row type) |
| P6 | Task 3.2's typecheck needs a method only Task 3.3 adds (B.F6) | ACCEPT | the `units` half of the suite moves to Task 3.3 | no |
| P7 | New hooks will trip `react-hooks/set-state-in-effect` (B.F7) | ACCEPT | the codebase's justified disable on the three effects | no |
| P8 | Run again re-queues without re-checking names; `lastRewrite.fields` dropped (B.F8, A.7, B.F23) | ACCEPT | `lastRewrite.fields: OrgRecordField[]` restored (set at start; rename/merge from the target's kind then); `runAgain` re-checks `toName` / `agencyName` exist with the expected kind, else 409 `org_rewrite_target_gone` | no (restores spec 5.1) |
| P9 | Stale pre-reads and non-conditional writes (B.F9) | ACCEPT in part | units PATCH pre-read becomes consistent (`unitsRepo.getById` gains an optional `{ consistentRead }`, fakes unaffected); the contacts write race (API callers only) and the delete/kind-change scan race are documented in the watch items | no |
| P10 | Values that normalize to '' cannot be settled; Add as new can create such a name (B.F10) | ACCEPT | `checkNewName` refuses a name that normalizes to '' (`org_name_invalid`); value actions match EXACT stored text when the normalized from-text is '' | no |
| P11 | Move and Split audit only the matched field (B.F11) | ACCEPT | one audit event per field written | no |
| P12 | S15 details: null audits, heartbeat placement, CLI message, own deleted test, no-op audit (B.F12, A.4) | ACCEPT | `''` not null; elapsed-time heartbeat; CLI message names the real failure; the repos' `isDeleted` rule; jurisdiction backfill audits `from: ''` | no |
| P13 | Settings polls two full scans every 2 s and aborts reads (B.F13) | ACCEPT | poll only `GET /api/organizations` while running; refresh usage and Not-on-the-list once when the rewrite ends; skip a details read while one is in flight | no |
| P14 | Untested Move to Housing authority; Change kind / Delete enabled while running (B.F14) | ACCEPT | an agency-row test; both disabled while a rewrite runs | no |
| P15 | Phone-width overflow; transient false "Not on the list" mark (B.F15) | ACCEPT | dialog name buttons wrap; chip remove target 24 px; a just-added name counts as on the list until the reload lands | no |
| P16 | Over-budget WARN mislabels unrenderable drops (B.F16) | ACCEPT | separate counts; WARN only for budget drops | no |
| P17 | Pre-deploy claimed journals replay unchecked text; dismissals keyed on old spellings (B.F17) | REJECT | a journal is replayed within seconds of its claim, so the deploy window is negligible; dismissal keys are informational and unchanged by this branch | no |
| P18 | Already-green RED cases unmarked; wrong RED reasons (B.F18) | ACCEPT | marked (PIN) / reasons corrected in 5.1, 5.3, 7.2, 7.8, 11.7, 11.12 | no |
| P19 | S17 details (B.F19, A.13) | ACCEPT | `git merge --no-commit main` then a commit with the trailer; no fetch; `npm ci` when the lockfile changed; e2e timeout 2700 s, tree-kill + `npm run e2e:stop` + lane-port check on a timeout; gate 5 names pre-existing errors (`useComposerDraft.ts:116`); "dev first" in the owed actions; full `npm test` checkpoints after S10 and after S13 | no |
| P20 | Docs drift (B.F20, A.11) | ACCEPT | GLOSSARY "accepted authorities" entry; RUNBOOK step 1 key names; README fixtures list; `documentation/sequence-diagram-to-test.md` per the S12 note | no |
| P21 | Dangling and stale references (B.F21, A.9) | ACCEPT | CONTRACT ISSUES pointers replaced with plan section 3 / the records file; spec revision 6; S4 work-map row; typed-fakes list; `"Accepts:"` grep; edit counts; a note that line numbers drift and anchors are unique text | no |
| P22 | CSS locators and a fixed wait in the new spec (B.F22) | ACCEPT in part | `pickOrgName` scope uses the page, not `locator('body')`; the Activity `section` locator mirrors existing helpers (kept, noted); the 1.5 s negative window is kept (it cannot cause a false failure) | no |
| P23 | API shapes differ from spec section 6 (B.F23, A.8) | ACCEPT | spec section 6 amended to the plan's separate `/usage` and `/not-on-list/records` endpoints | no |
| P24 | Compound spans: left-to-right vs "longest first" (A.6) | ACCEPT | spec D4 wording: "left to right, the longest phrase at each position" (what S1 implements and documents) | no |
| P25 | Unbounded text into the edit-distance scorer (A.12) | ACCEPT | `closeNames` scores only texts whose normalized length is at most 120 (else no close names); `POST /check` refuses text over 200 chars with 400 | no |

Counts: 36 findings; 33 accepted (some in part), 3 rejected (P3's switch,
P17, P22's two kept items). P2 goes to Cameron at the launch gate.
Decisions changed this round: yes (P5) - round 2 continues reviewer B (more
accepted findings: 21 vs 12), handed reviewer A's report.

**P2 superseded (2026-10-06, after the fixer pass):** Sam answered spec
section 13 in the founder meeting the same day, so the starting list no
longer rests on the planner's default and P2 is no longer a launch-gate
question. Spec revision 8 records the answers: Fulton County Housing Authority
stays on the list; the old county values become spellings of the entry that
runs those vouchers (`Fulton County` and `Fulton, Fulton County` -> Fulton
County Housing Authority; `McDonough` and `Henry County` -> Georgia
Department of Community Affairs; `Clayton County` and `Housing Authority of
Clayton County` -> Jonesboro Housing Authority; `Cobb County` -> Marietta
Housing Authority), so the cleanup maps them automatically instead of leaving
them for "Not on the list"; "McDonough Housing Authority" (public housing
only) is deliberately not a spelling; Hands of Hope stays off. Plan edits: S1
Task 1.5's list, its conformance tests (the old "not spellings" test is now a
mapping table plus an off-list check for `fulton_housing` and "McDonough
Housing Authority"; the shared set stays `['AHA', 'MHA']`) and its section-13
note; the stale rationale in S6 (the resolution table row and
`unitsApi.test.ts`'s note - the server now STORES the full name, so the edit
stands), S7 (the rewritten test's comment and the broken-tests note) and S14
(the Decatur substitution note). Outside S1 no test edit changes: every
rewritten expectation already used a list name. Decision changed: yes (the list's
content - a product input from Sam, not a review finding).

## Round 2 (plan @fb6cf81e + 5069e8dc; reviewer B continued)

Report: `plan-r2-reviewer-b.md` (6 findings: 1 HIGH, 5 LOW). Reviewer B
conceded all three round-1 rejections (P3, P17, P22) and verified the other
round-1 fixes and Sam's answers as applied. Load-bearing claims were checked
in the code before ruling: `dashboard/src/main.tsx:15` renders in
`<StrictMode>` on React 19 and `scripts/e2e-session.mjs:462` serves the Vite
dev server (F1); `app/src/app.ts:142` mounts `trimJsonBody`, which trims every
JSON string value (F3); `app/src/lib/housingAuthority.ts:48` maps raw
`clayton` (F5).

| # | Theme (finding) | Ruling | Resulting change | Decision changed |
|---|---|---|---|---|
| P26 | `useOrgAdmin`'s in-flight guard (the P13 fix) never loads the counts or the rows under StrictMode: the cleanup aborts read A but leaves the slot held, the second mount's read queues behind A, and A's aborted return drops the queue (B.F1, HIGH) | ACCEPT | a read releases the slot only while it still holds it (`inFlightRef.current === controller`); the mount effect's cleanup aborts AND releases (and drops a queued request); new hook test renders under `<StrictMode>` and is RED against the old body | no (restores P13's stated behavior) |
| P27 | A spelling that normalizes to '' (`-`) is accepted, so "Use" with "Remember this spelling" stores junk that renders into the AI block (B.F2) | ACCEPT | `checkSpelling` returns `empty` when the normalized text is '' (automatic additions skip it with a reason); the copy for `empty` reads "it has no letters or digits"; spec D13 extends the name rule to spellings | no (D13's rule applied to its sibling) |
| P28 | The global body trim defeats the exact-text checks: a padded exact name cannot be settled (400 "nothing to settle"), a padded `-` never matches (B.F3) | ACCEPT | `resolveNotOnList` exempts "Use <that entry>" from the on-list 400 (the pass rewrites only holders whose stored text differs from the name; every other action stays 400); the pass's exact-text set compares TRIMMED stored text; tests: the padded-name use (service), a padded ` - ` holder (records), and a (PIN) that a use whose from-text is the name rewrites only padded holders | no |
| P29 | Gate 4's abort `taskkill /T /F /PID` runs in Git Bash, which rewrites slash switches (B.F4) | ACCEPT | PowerShell, or `MSYS_NO_PATHCONV=1 taskkill ...` from the Bash tool | no |
| P30 | Every key of the retired alias map carries over except raw `clayton` (B.F5) | ACCEPT | `Clayton` added to Jonesboro Housing Authority's spellings (Sam: Clayton County vouchers are Jonesboro's; the old importer read `clayton` as Clayton County); S1 mapping table, section-13 note, spec section 13 and Appendix A. "McDonough Housing Authority" stays off (spec section 13: a real public-housing authority with no vouchers) | yes (list content; told to Cameron at the launch gate) |
| P31 | Task 17.1 does not name the tour-list overlap (B.F6) | ACCEPT (half done @5069e8dc before the report landed) | Task 17.1 now names all ten files plus the harness fake, and warns that both branches bump the profiler-route COUNT pins in `e2e/performance/routes.test.ts` - recompute them from the merged registry | no |
| P32 | (planner, from Sam's answers) Several spellings are now PLACE names (Cobb County, Henry County, McDonough, Clayton), and the apply layer writes a unique-spelling match directly - so a tenant's home or search area could be recorded as their housing authority | ADD | the extraction system prompt gains one rule: "Where the client lives or wants to live is not a housing authority: a county or city name counts only when the client says it runs the voucher"; a schema test asserts the phrase; spec D8's prompt bullet says so. (Today's prompt already lists Fulton County, Clayton County and McDonough as known spellings; this guards the wider set.) | yes (a new prompt rule) |

Counts: 6 findings, 6 accepted; 0 rejected; 1 planner addition (P32).
Decisions changed this round: yes (P30, P32) - round 3 continues reviewer B
on the round-2 edits.
