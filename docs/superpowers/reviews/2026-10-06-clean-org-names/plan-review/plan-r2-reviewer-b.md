# Plan review r2 - reviewer B (adversarial, continued)

- Plan: `docs/superpowers/plans/2026-10-06-clean-org-names.md` @fb6cf81e (30,308 lines), reviewed as the diff from efea53ac (1,751 insertions, 491 deletions, all read) plus targeted reads of the unchanged code it now interacts with.
- Spec: revision 8 @d281754f (diff from efea53ac read in full).
- Inputs: `plan-review/adjudications.md` (P1-P25 + "P2 superseded") and `plan-review/plan-r1-reviewer-a.md`.
- Read and grep only: no file other than this one was written, nothing was run except two harmless shell probes (an `echo` through `cmd` to show argument rewriting, and `git show` of another branch's plan from this repo's object store). The other worktree was not touched.

Result: 1 HIGH and 5 LOW. The HIGH is a defect introduced by the round-1 fix for the Settings polling (P13). Sam's starting-list answers are applied consistently: no remaining test, seed, e2e spec or cleanup expectation treats a county value as unknown, and S1's conformance tests still hold when traced by hand.

---

## Findings

### F1 [HIGH] The new `useOrgAdmin` in-flight guard never loads the counts or the "Not on the list" rows under React StrictMode, which is every dev session and every e2e lane

**What is wrong.** The P13 rewrite of `loadDetails` (plan 22583-22612) adds a guard: if a details read is already in flight, it sets `againRef` and returns (22584-22587). After its await, the read clears `inFlightRef` and returns at once if its own controller was aborted (22596-22597, "unmounted"). It does this before the `while (againRef.current)` loop can honour the queued request. The mount effect's cleanup aborts the in-flight controller but leaves `inFlightRef` set (22619).

**Why that breaks under StrictMode.** The dashboard renders inside `<StrictMode>` (`dashboard/src/main.tsx:15-19`), on React 19 (`dashboard/package.json:15-16`). In development, React mounts each component, then runs its effect cleanup, then runs its effects again. That gives this sequence:
1. The mount effect starts read A and sets `inFlightRef` to A.
2. The simulated unmount aborts A.
3. The second mount effect calls `loadDetails()`. `inFlightRef` still holds A (it is cleared only after A's await), so the call sets `againRef = true` and returns.
4. A settles as aborted. `loadDetails` clears the ref and returns at the `aborted` line. Nothing ever runs the queued read.

As a result, `usage` and `notOnList` stay `null` until the first admin action calls `reload()`. On a fresh page the use counts never appear and "Not on the list" never fills.

**Why the tests and gates are affected.**
- The e2e lane serves the Vite DEV server (`scripts/e2e-session.mjs:462`, `spawnNode('web-next', [viteBin], ...)`, no build), so StrictMode is active in every lane.
- S14 Task 14.5 opens Settings and asserts use counts (selector contract S6).
- S14 Task 14.6 opens Settings and asserts `notOnListRow(...)` visible before any action (e.g. plan 27513-27531).
- Both will fail. So will S17.3 self-QA step 1 ("both lists with counts").
- The unit tests cannot catch this: `useOrgAdmin.test.tsx` renders `<Probe />` without StrictMode (plan 22483-22502 and the cases around it). Round 1's version aborted the old read and started a new one, which is StrictMode-safe; the regression arrives with the fix.

**Implication.** A literal builder ships a Settings tab that works in production (no double effects there) and fails gate 4, with green unit tests and a cause that is hard to see.

**Fix.**
- Make the "skip while in flight" check per call: a read only clears `inFlightRef` if the ref still holds its own controller.
- The cleanup should abort AND release the ref.
- A queued request must survive an aborted predecessor, or the mount read should bypass the guard.
- Add a hook test that renders under `<StrictMode>`.

### F2 [LOW] Spellings that normalize to '' are still accepted; with the new exact-text path, settling a `-` row with the default "Remember this spelling" stores the junk as a spelling

**What is wrong.**
- P10 added the '' rule to NAMES only: `checkNewName`, plan 3.5, spec D13.
- `checkSpelling` (plan 1223-1243) has no such rule. For `-`, `n` is `''`; none of its checks fire, and `compoundSpans` returns null for `''`. So it returns null (accepted), both for an admin spelling edit and through `checkOrgSpelling` (plan 2748-2755).
- The P10 fix makes a `-` row settleable through `exact` matching (plan 4741-4751). Its Use dialog asks `POST /check` with `spellingFor` and gets `spellingProblem: null`, so "Remember this spelling" stays ON (the default, plan 24464-24467).
- The resolve then appends `-` to the target entry (plan 6777-6787).

**Implication.** An inert spelling that matches nothing (`phraseIndex` skips '' keys) still:
- shows on the Settings row;
- is rendered into the AI list block as "also: -" (it is "renderable");
- makes a later identical spelling on another entry read as a shared or cross-kind spelling.

**Fix.** Have `checkSpelling` refuse a spelling that normalizes to '' (problem `invalid` or `empty`). Automatic additions would then skip it, with a reason.

### F3 [LOW] The global body trim defeats the server's exact-text checks for a stored value with surrounding whitespace, so some listed rows can never be settled

**What is wrong.** `trimJsonBody` trims every JSON body string before the routes run (`app/src/app.ts:142`, `app/src/middleware/trimStrings.ts:23-35,43-50`). That includes `value` in `POST /not-on-list/resolve`. The rows themselves list exact stored text (`notOnList`), and the codebase records that pre-2026-07-14 data may be padded (`app/src/routes/contacts.ts:478-480`). Two cases follow:
- **Padded exact name.** The stored value is, say, `Jonesboro Housing Authority ` (trailing space). The row is a name variant, so the dashboard offers only Use. The server receives the trimmed text, and `isOnListFor` then answers the uncoded 400 "the value is on the list for this field; there is nothing to settle" (plan 6704-6707). The row cannot be settled from Settings.
- **Padded '' value.** The stored value is, say, ` - `. The new exact-text path (plan 4751) adds the trimmed `-`, which never equals the stored ` - `. The rewrite finishes `done` with zero counts and the row stays.

**Implication.** Rare. The cleanup apply rewrites the first case, because it resolves to one entry by name. The second case survives the cleanup and can never be settled.

**Fix.** Do the on-list, variant and exact comparisons on trimmed stored text, or let the route re-read the row's stored value.

### F4 [LOW] Gate 4's abort step runs `taskkill /T /F /PID` in the shell where Windows switches get rewritten

**What is wrong.** Gate 4 is to be run "from the BASH tool (Git Bash)" (plan 30200-30203). Its abort procedure step (a) then gives `taskkill /T /F /PID <launcherPid>` (plan 30206-30207) without naming another shell. Git Bash (MSYS) rewrites leading-slash arguments as paths. Probe: `cmd /c echo /T /F /PID 123` from the Bash tool started an interactive cmd, because `/c` was rewritten. With `MSYS_NO_PATHCONV=1` the switches arrived intact.

**Implication.** On the timeout path, the tree-kill step fails with an argument error, and the orphaned stack AGENTS.md warns about survives unless the builder improvises.

**Fix.** Run it in PowerShell, or use `MSYS_NO_PATHCONV=1 taskkill ...` (or `//T //F //PID`).

### F5 [LOW] Sam's list carries every key of the retired alias map except the raw `clayton`, so a re-import of a raw "Clayton" now writes nothing

**What is wrong.**
- Appendix A rev 8 (spec, Jonesboro row) has `Clayton County` and `Housing Authority of Clayton County`, but not bare `Clayton`.
- The retired map collapsed the raw Airtable value `clayton` to `Clayton County` (`app/src/lib/housingAuthority.ts:48`).
- Every other map key resolves to the same entry under rev 8. `mcdonough housing authority` is excluded on purpose, per spec section 13.
- Under D9, a raw `Clayton` program cell is now `unknown`: it is not written and appears in `orgNotWritten`.

**Implication.** This only bites a future re-import of those tenants (D9 is fill-only, and stored `Clayton County` values map through the cleanup). It is a gap in carrying the map over, not a dispute of the mapping.

**Fix.** Confirm with Cameron whether `Clayton` belongs on Jonesboro's spellings.

### F6 [LOW] S17.1's merge guidance does not name the concrete overlap with the in-flight tour-list mission

**What is wrong.** Task 17.1 lists generic "likely" conflict files (plan 30157-30161) and mentions the tour-list mission only for seeds and e2e. The tour-list plan (`feat/tour-list:docs/superpowers/plans/2026-10-06-tour-list.md`) names ten files that this plan also edits:
- `app/src/repos/unitsRepo.ts`
- `dashboard/src/App.tsx`
- `dashboard/src/api/types.ts`
- `dashboard/src/api/endpoints.test.ts`
- `dashboard/src/api/types.test.ts`
- `dashboard/src/routes/contact/files.test.tsx`
- `dashboard/src/routes/listing/ListingDetail.test.tsx`
- `e2e/performance/routes.test.ts`
- `app/src/lib/seed/cast.ts`
- `app/src/lib/seed/matrix.ts`

Its slice A already changes the `UnitsRepo` interface (`getDisplaysByIds`) and `app/test/helpers/twilioWebhookHarness.ts`, so this branch's Task 6.3 `getById(unitId, opts?)` edit will conflict there. Both branches also bump the profiler-route pins in `e2e/performance/routes.test.ts`, and a textual merge of those count pins can be wrong while still applying cleanly (gate 2 would catch it).

**Fix.** Name these files in Task 17.1.

---

## Contested adjudications (round 1 rejections)

- **P3 (contacts read through `byTypeStatus`): conceded.** The spec now records the read path and its self-healing property (D11 rev 7). The repo's index-key guard makes an unindexed contact a bug class for the whole app, not something this branch should work around.
- **P17 (pre-deploy journal replay; dismissal keys): conceded.** The replay window is limited to accepts in flight during a deploy restart, and the dismissal-key change is cosmetic.
- **P22 (Activity `section` locator; 1.5 s negative window): conceded.** Both follow existing specs, and neither can cause a false failure.

## Fixes checked and holding (not findings)

- **Round-1 fixes.** P1, P4, P5, P6, P7, P8, P9, P10 (names), P11, P12, P14-P16 and P18-P25 do what their adjudications say, with these notes:
  - P4: a pass can still write for up to 20 s after a takeover, until its next heartbeat. Spec D11 rev 7 allows this ("a run whose heartbeat finds the lock gone").
  - P7: I did not run eslint.
  - P13 introduced F1 above.
- **Verified specifically:**
  - every `heartbeat` caller and fake: plan 4322, 4344, 7172, 28853, 28888;
  - every `OrgRewriteState` literal carries `fields` or comes from the fixture;
  - the `org_value_is_name_variant` path on the server, the route and the dashboard (copy and `settleChoices`);
  - `rewriteTargetKind` for every action;
  - the job and the cleanup lock-loss tests (the clock arithmetic holds);
  - Task 10.1's item 4 and 4b quotes against S8's output;
  - the `unitsRepo.getById` optional parameter against every typed fake and override in `app/test`;
  - the new quotes: `mutationCatalog.test.ts:367`, `GLOSSARY.md:296-310`, `sequence-diagram-to-test.md:165`, `e2e/README.md:601`;
  - `lane.json` keys `launcherPid` and `ports` (`scripts/e2e-session.mjs:72-78`).
- **Sam's answers, consistency.**
  - S1's conformance holds: by hand trace there is no new shared, compound or name-equal spelling, and every name is still valid against the others. The mapping table and the off-list checks for `fulton_housing` and `McDonough Housing Authority` hold too.
  - No county value is used as an unknown anywhere: grep across S6, S7, S8, S11, S14 and S15. S15's test world and S8's import fixtures contain none.
  - S14's facets spec moved to run-unique names.
  - The AI block still fits its budget.
  - New plan and spec lines are all ASCII.
