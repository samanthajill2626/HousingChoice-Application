# RC findings - build research, S7 (the AI uses the stored list)

- Reader: RC (read-only live-tree drift and gap check, 2026-10-06).
- Tree: `W:/tmp/clean-org-names` @bef84c54 (docs-only on top of main
  @d839494a, so the source equals the plan's base).
- Plan range: S7, `docs/superpowers/plans/2026-10-06-clean-org-names.md`
  lines 10228-13674 (Tasks 7.1-7.8 and the S7 hand-offs), read together
  with sections 0-3 and 12, the S1 rules/starting list (Tasks 1.1-1.5), the
  S2 repo and fake (Tasks 2.1, 2.3), S3 `createOrgNamesService`
  (plan 5095) and S5 Task 5.1 (composition root + harness `api:` wiring).
- Spec: revision 8, D4, D5, D8, sections 5, 6, 9.

## What was checked

1. ANCHORS - every `old_string` / insert-after anchor of Tasks 7.1-7.8
   against the base tree (text, indentation, uniqueness, LF endings), and
   every MISSING / MULTI-IN-FILE / SEVERAL-FILES row of `anchor-check.txt`
   in the range.
2. SYMBOLS - every import and call into existing modules and into S1/S2/S3/S5
   plan code (`resolveOrgText`, `KINDS_FOR_FIELD`, `checkScalarWrite`,
   `OrgEntry`, `STARTING_ORG_LIST`, `buildStartingEntries`, `OrgListItem`,
   `OrgListRepo`, `createOrgListRepo`, `createOrgNamesService`,
   `OrgNamesService.read`, harness `world.orgListRepo.putForSeed`, test
   helpers `createLogCapture` / `createLogger` / `TEST_SESSION_COOKIE`).
3. CONTRACTS - plan 3.3, 3.4/3.4b, 3.5, 3.10 names and shapes.
4. FALLOUT - whole-repo greps (app, dashboard, e2e, fake-twilio, scripts) for
   `ExtractionInput`, `buildExtractionUserContent`, `.extract(`,
   `ExtractionJobDeps`/`runDueExtractions`, `applyExtraction(`,
   `AiRunRecord`/`putRun`, `promptFingerprint`, `DROP_REASONS`/`DropReason`
   and drop-reason label maps, `createSuggestionResolutionService` /
   `ResolutionServiceDeps`, `createSuggestionsRouter`, journal row shapes
   (`state: 'completed'` exact pins), the accept route callers, the
   extraction system prompt text pins, snapshot tests, housingAuthority
   suggestions in seeds/e2e, and the worker / dev / in-process wiring of the
   extraction job (plan 3.4b last bullet).
5. TDD validity - every RED claim and every expected value. Task 7.1's
   budget arithmetic and every D4 resolution the S7 tests rely on were
   re-derived with a scratch port of the plan's S1 rules and Task 7.1
   renderer (results in the reference file): all expectations hold.
6. Spec conformance in passing (D4, D5, D8, section 9 writers/readers).

## Counts

BLOCKER 0, MAJOR 0, MINOR 1.

## Findings

### RC-1 | Task 7.8 RED (plan 13327-13336) | MINOR

Evidence: the RED note says the two claim-race cases "fail on the missing
`resolutionValueKey` export". Task 7.6 (plan 12487-12495) already exports
`resolutionValueKey` from `app/src/repos/suggestionResolutionRepo.ts`, so at
Task 7.8 RED the import resolves. Both cases are still RED, for a different
reason: the Task 7.7 service ignores `input.value`, so `buildPlan` runs the
text check on 'AHA' (ambiguous, `app/src/services/suggestionResolution.ts`
buildPlan via Task 7.7's `acceptedAuthorityName`) and throws 422
`org_not_on_list` before the claim - the 'replays' case rejects instead of
resolving, and the 'refuses 409' case rejects with status 422 instead of 409.

Correction: in the Task 7.8 RED note replace "the two claim-race cases fail
on the missing `resolutionValueKey` export" with "the two claim-race cases
fail because the service ignores `value` and refuses the text 'AHA' with 422
`org_not_on_list` before the claim (one rejects instead of resolving, the
other rejects with 422 instead of 409)". No code change.

## Clean checks (one line each)

- ANCHORS: clean. All SEVERAL-FILES rows hold exactly once in the file the
  plan names; the six MISSING rows are byte-exact new text of earlier S7
  tasks (7.3 step 2 for plan 11350; 7.7 for plan 13138, 13433, 13528, 13556,
  13601), and Task 7.8's whole-function replace matches plan 12849-12866;
  the three MULTI-IN-FILE rows are intended replace-alls with the stated
  counts (8 profile literals in `extractionAdapter.test.ts`; 6
  `await applyExtraction(deps, {` in `extractionApply.test.ts`, step 1 before
  step 3; 2 `coercedValue: coerced.value,` in `apply.ts`). No anchor touches
  a `\u` escape line; all target files are LF.
- SYMBOLS: clean. Every symbol exists with a compatible signature in the
  base tree or in the producing task's plan code (S1 `resolveOrgText` returns
  `other_kind.entries` / `ambiguous.candidates` / `match.entry` exactly as
  Tasks 7.5 and 7.8 read them; `createHash` is already imported in
  `suggestionResolutionRepo.ts:10`; the logger `log` exists in `dev.ts:191`;
  vitest 3.2.6 accepts the `ReturnType<typeof vi.fn>` harness typing, same
  as the existing `aiRuns` option at `extractionJob.test.ts:223, :1270`).
- CONTRACTS: clean. 3.10 shapes (`renderOrgListBlock` result,
  `ExtractionInput.orgListBlock`, `orgListFingerprint?` on draft and record,
  ctx `orgEntries`, `agency_not_authority`, accept `value?`, `valueKey?`),
  3.4b keys (`orgNamesService`, worker/dev build their own `orgListRepo`,
  composition root passes the ONE `orgNames`) and 3.5 codes all match.
- FALLOUT: clean - the plan names every affected site. `ExtractionJobDeps`
  is built only in `worker.ts:463`, `dev.ts:710` and the two harnesses (no
  test passes `extractionTickDeps`; no in-process app poll);
  `ExtractionInput` literals only in the three named test files; apply ctx
  only in `extractionApply.test.ts` and `contactStaffNotes.test.ts:320`;
  the resolution service only in `routes/suggestions.ts`,
  `jobs/journalSweep.ts` and `suggestionResolutionRecovery.test.ts`; all
  other additions are optional fields; `GET /api/ai-runs/:runId` returns the
  whole record (`routes/aiRuns.ts:272`); no snapshot tests, no pinned prompt
  fingerprint value, no dashboard drop-reason map or source-scanning parity
  test (dashboard `types.test.ts:56` SERVER_CODES is S11's hand-off); no
  seed or e2e spec creates or accepts a housingAuthority suggestion.
- TDD validity: clean apart from RC-1. Every other RED is red for its stated
  reason, every PIN is green before GREEN, and every expected value matches
  the simulated renderer and resolver.
- Run commands: clean (absolute `cd`, all named test files exist; the
  journal integration case needs DynamoDB Local up, as Task 7.6 says).
- Spec conformance: clean (D8 block placement, budget order, WARN on budget
  drops only, agency drop reason, accept `value` rule checked before the
  claim, `valueKey` on the completed row, absent equals absent).
