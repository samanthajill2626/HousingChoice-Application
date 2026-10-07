# Plan review r3 - reviewer B (adversarial, continued)

- **Plan:** `docs/superpowers/plans/2026-10-06-clean-org-names.md` @2f42d119. I reviewed it as the diff from fb6cf81e (5069e8dc and 2f42d119; every changed hunk read), plus targeted reads of the code the changes touch.
- **Spec:** @2f42d119 (revision 8, round-2 amendments); the diff from fb6cf81e was read in full.
- **Inputs:** `plan-review/adjudications.md` section "Round 2" (P26-P32).
- **Constraints kept:** read and grep only. I wrote no file other than this one and ran nothing. I touched no other worktree; I read the tour-list branch only through `git show` from this repo.

**Result: 3 LOW findings.** No BLOCKING, HIGH or MEDIUM issue remains.

The round-2 fixes do what their adjudications say. I traced the riskiest one, the `useOrgAdmin` slot release, through StrictMode, a real unmount, `reload()` during a read, and the rewrite-stopped effect, against every existing `useOrgAdmin` test.

---

## Findings

### F1 [LOW] A whitespace-only stored value is listed under "Not on the list" but can never be settled

- **What is wrong:**
  - `notOnList` skips only an exact `''` (plan 3931-3932), so a stored `housingAuthority` or `agency` of, say, two spaces is listed as a row. Its resolution is `unknown`.
  - Every settle request for that row fails before any rewrite:
    - `trimJsonBody` turns the row's `value` into `''` (`app/src/app.ts:142`).
    - The resolve route then answers 400 `value is required` (plan 8617-8619).
    - Even past the route, the service refuses a blank value (plan 6734).
    - The P28 exact-text path only adds non-blank trimmed texts (plan 4775).
  - The cleanup leaves such a value as-is (`unknown`).
- **Why it can exist:** before `trimJsonBody` (2026-07-14) the contacts PATCH stored any non-empty string as-is (`app/src/routes/contacts.ts:634`, `v.length > 0 ? v : null`). The repo notes that such pre-trim data exists (`app/src/routes/contacts.ts:478-480`).
- **Implication:** rare, but it contradicts the stated goal of the P10/P28 fixes that every "Not on the list" row can be settled (plan 4763-4768). The row stays on the Settings page forever.
- **Fix:** treat a whitespace-only value like `''` - not listed - and have the cleanup clear it. Or let Clear accept a value whose trim is `''`.

### F2 [LOW] Task 17.1's tour-list note misplaces the harness overlap

- **What is wrong:** the note says the tour-list harness fake `getDisplaysByIds` lands "beside this branch's Task 6.3 `getById(unitId, opts?)` change" (plan 30244-30246). But Task 6.3 changes no fake ("No fake changes", plan 9576-9579).
- **Where the edits actually meet:**
  - Tour-list puts `getDisplaysByIds` right after the harness units fake's `getById` (`feat/tour-list:app/test/helpers/twilioWebhookHarness.ts:2711-2714`).
  - This branch's units-fake addition is Task 3.3's `rewriteAcceptedAuthorities`, inserted after `list(...)` (plan 3485-3508).
  - In `app/src/repos/unitsRepo.ts`, both branches append a method at the end of the interface and the implementation: Task 3.3 adds `rewriteAcceptedAuthorities`, tour-list adds `getDisplaysByIds`. That is the likely textual conflict.
- **Implication:** cosmetic. The merge shows the real conflicts. Point the note at Task 3.3 so a builder does not look for a harness `getById` edit that does not exist.

### F3 [LOW, informational] `Clayton` (P30) is also a city outside Clayton County, and as a unique spelling it maps there automatically

- **What is wrong:** P30 adds bare `Clayton` to Jonesboro Housing Authority's spellings (plan 1432; spec Appendix A). From general knowledge, not the spec's research, Clayton is also the county seat of Rabun County. Rabun County's vouchers are DCA's (it is not in DCA's exception list, spec 1.3).
- **Where it maps automatically:** a unique spelling resolves with no confirmation in:
  - the importer (D9);
  - the cleanup (section 8);
  - the AI apply layer, which writes a match directly when the model's op says `write` (D8).
- **What guards it:** only the AI path, through P32's prompt rule (plan 11502-11503).
- **Implication:** for a metro-Atlanta caseload, bare "Clayton" almost always means Clayton County, as the retired alias map assumed (`app/src/lib/housingAuthority.ts:48`). This adds one fact to the launch-gate confirmation P30 already sends to Cameron; it is not a reason to undo it.

---

## Adjudications contested

None. P26-P31 apply my round-2 findings as I would have. P32, the planner's place-name rule, is sound:
- It addresses a real automatic-write path for the new place-name spellings (`McDonough`, `Henry County`, `Cobb County`, `Clayton`, and the older `East Point` / `College Park`).
- It keeps the system prompt static.
- Its asserted phrase sits inside one prompt line, so it satisfies C3 (`app/test/extractionSchema.test.ts:524-525`; plan 11404 against prompt line 11502).
- It names no list entry, so the existing check that the prompt contains no housing authority name still holds (plan 11385-11392).

## Fixes checked and holding (not findings)

- **P26 `useOrgAdmin` slot release (plan 22645-22694).** Checked against the hook's existing tests:
  - **StrictMode:** read A is aborted and its slot released by the cleanup. The second mount's read B starts. A returns at its `aborted` check without touching B's slot.
  - **Real unmount:** the read is aborted and released, and no state is set afterwards.
  - **`reload()` during a read:** the queued flag runs exactly one more read after the first lands, and nothing is aborted.
  - **Rewrite-stopped effect during a read:** handled the same way as `reload()`.
  - The existing tests keep their counts. The new StrictMode test is RED against the P13 body (the mocks ignore the signal, and the old body returned on `aborted` and dropped the queue).
- **P27 `checkSpelling` returns `empty` for a spelling that normalizes to `''`.** Checked against every caller:
  - The admin spelling edit refuses it with copy (plan 5490-5517).
  - "Use with Remember" skips it with a reason, and the dashboard checkbox turns off with "it has no letters or digits".
  - Rename never reaches it (a name cannot normalize to `''`), and merge does not call `checkSpelling`.
  - The starting-list conformance test is unaffected: no starting spelling normalizes to `''`.
  - No test pins the old "it is blank" copy.
- **P28 on-list exemption (plan 6745).** It admits only `use` with `name` equal to the trimmed value. The pass then rewrites only holders whose stored text differs from the name (`SAME_FIELD_ACTIONS` exclusion), so exact holders are never touched. Every other action on an on-list value stays 400. "Remember" on it is a `duplicate` no-op.
- **P28 trimmed exact-text match (plan 4775, 4780).** The conditional writes still expect the STORED (padded) text (`planContactRewrite(..., value, c)`; units pass the stored list), so a record that changed meanwhile is still skipped.
- **P30 `Clayton`.** D4 conformance holds by hand trace:
  - no new shared spelling;
  - no compound starting spelling (`Clayton County` and `Housing Authority of Clayton County` each yield one span);
  - every name is still valid against the others.
  
  No test, seed or fixture in `app/test`, the seeds, `dashboard/src` or `e2e` uses a value containing "clayton" as an unknown. The only hits are the vocabulary test, datalist test and `orgVocabulary.ts` that S10 and S11 delete. The AI block still fits its budget.
- **P29, P31.** The PowerShell / `MSYS_NO_PATHCONV=1` wording is correct. The tour-list file list matches that plan's named files. The seed pins it names exist: `seedRosterShape.test.ts` and `seedMatrixCoherence.test.ts` on this branch, `seedTourPartition.test.ts` on `feat/tour-list`.
- **ASCII.** New plan and spec lines are ASCII.
