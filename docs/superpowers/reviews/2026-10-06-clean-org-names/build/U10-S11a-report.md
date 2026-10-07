# U10 report - S11a (dashboard API client, accept value, orgCopy, useOrgList, OrgPicker, NewOrgDialog)

- Implementer: U10 (Opus 5.5), 2026-10-07, worktree W:/tmp/clean-org-names,
  branch feat/clean-org-names. Range: plan Tasks 11.1-11.6 (plan lines
  16212-19445) plus worklist items B-2 (Task 11.3 copy) and RE1-5 (Task 11.6).
- Start: 15f373a0 (clean tree, no MERGE_HEAD). End: 6f4dbd98 (clean tree).
- Slow gates (npm test, e2e, smoke) NOT run - the orchestrator's.
- Logs: `.superpowers/sdd/u10-*.log` (gitignored).

## Per task

### Task 11.1 - ac187406 feat(dashboard): API client for /api/organizations and its mutation-catalog rows
- Files: dashboard/src/api/types.ts (org types appended), endpoints.ts (type
  imports + 11 functions appended), endpoints.test.ts, e2e/performance/
  mutationCatalog.ts (7 workflow_only rows), mutationCatalog.test.ts (111 -> 118).
- RED: endpoints "TypeError: getOrgList is not a function" / "checkOrgText is
  not a function" (2 failed, 43 passed); catalog "expected [ Array(111) ] to
  have a length of 118 but got 111".
- GREEN: endpoints.test 45 passed; mutationCatalog.test 4 passed.
- Gates: typecheck exit 0.

### Task 11.2 - 991b0880 feat(dashboard): suggestion accept carries an optional value; copy for its refusals
- Files: endpoints.ts (acceptSuggestion value?), endpoints.test.ts,
  routes/contact/useSuggestions.ts + .test.tsx, api/types.ts (2 copy entries),
  api/types.test.ts (2 SERVER_CODES).
- RED: accept body was the bare identity; the hook's second call had 3 args;
  value_not_from_suggestion got the generic sentence (3 failed, 73 passed).
- GREEN: 3 files / 76 passed. Named fallout ContactDetail.test.tsx 96 passed
  (accept pins stay three-argument).
- Gates: typecheck exit 0.

### Task 11.3 - a91c94bf feat(dashboard): organization-list copy, normalization mirror and rewrite-status helpers
- Files: routes/orgs/orgCopy.ts (new), orgCopy.test.ts (new).
- RED: "Failed to resolve import ./orgCopy.js".
- GREEN: 22 passed (the plan's 21 + 1 B-2 pin, see divergences).
  normalizeOrgText is byte-identical to app/src/lib/orgNames.ts:42-49.
- Gates: typecheck exit 0.

### Task 11.4 - a669e386 feat(dashboard): useOrgList hook
- Files: routes/orgs/useOrgList.ts (new), useOrgList.test.tsx (new).
- RED: "Failed to resolve import ./useOrgList.js".
- GREEN: 4 passed, no act() warnings.
- Gates: typecheck exit 0.

### Task 11.5 - b6474bae feat(dashboard): OrgPicker - the organization-list picker
- Files: routes/orgs/OrgPicker.tsx, OrgPicker.module.css, OrgPicker.test.tsx
  (all new). Every CSS token used exists in dashboard/src/ui/tokens.css.
- RED: "Failed to resolve import ./OrgPicker.js".
- GREEN: 15 passed.
- Gates: typecheck exit 0; `npx eslint` OrgPicker.tsx orgCopy.ts useOrgList.ts
  exit 0, no output.

### Task 11.6 - 6f4dbd98 feat(dashboard): NewOrgDialog - "Is this really new?"
- Files: routes/orgs/NewOrgDialog.tsx, NewOrgDialog.test.tsx (new).
- RED 1: "Failed to resolve import ./NewOrgDialog.js".
- RED 2 (RE1-5, on the plan's code written verbatim first): 14 passed, 1
  failed - "a name over 120 characters ..." expected "Yes, add it" to have
  accessible description "Cannot add it: Names can be at most 120
  characters." and received none (the plan code showed "Checking the
  list..." and would POST /check).
- GREEN: 15 passed.
- Gates: typecheck exit 0; eslint over all 16 files this unit touched exit 0,
  no output (gate-5 clean for this range).

## Final combined run
- dashboard `npx vitest run src/api src/routes/orgs src/routes/contact/useSuggestions.test.tsx src/routes/contact/ContactDetail.test.tsx`:
  16 files / 291 passed, exit 0.
- e2e `npx vitest run performance`: 17 files / 473 passed, exit 0.
- `git diff 15f373a0..HEAD` added lines: 0 non-ASCII; new files `tr` check 0.

## Divergences from the plan / worklist
1. B-2 (Task 11.3): `org_rewrite_target_gone` copy is exactly "The list
   changed since this update started, so it cannot run again - start a new
   one from the list." with a 2-line comment above it naming the ruling. No
   plan test pinned the old sentence (nothing to adjust); I ADDED one case,
   "one sentence covers both Run again refusals for a changed list", pinning
   the new sentence exactly.
2. RE1-5 (Task 11.6): the helper is `nameProblemCopy` (same name as the
   worklist). Change: module const `ORG_NAME_MAX = 120` (not exported); the
   check effect returns early when `trimmed.length > ORG_NAME_MAX`; derived
   `tooLong`; `checking` excludes it; `problem = tooLong ? 'org_name_too_long'
   : check?.nameProblem` (so "Yes, add it" is disabled and described by
   "Cannot add it: Names can be at most 120 characters."). The Name input's
   `maxLength={120}` now reads `maxLength={ORG_NAME_MAX}` (same value).
   Display of a caller-held `initialCheck` (Use buttons etc.) is unchanged.
3. RE1-5 test: one case added, which also imports `NEW_ORG_CHECK_DELAY_MS`.
   It waits a REAL 350 ms (setup.ts pins Date only; timers are real) to prove
   no check fires, then Backspaces to exactly 120 characters and asserts the
   check runs and "Yes, add it" enables (guards an off-by-one). ~0.7 s.
4. Commit 6f4dbd98 carries a 2-line body naming RE1-5 (subject as planned).

## Out of scope, noticed
- dashboard/src/routes/contact/ContactDetail.test.tsx "Run AI extraction >
  carries the unqueued threads into a FAILED resolution too" prints React
  act() warnings to stderr (pre-existing, untouched; passes).
- Nothing else: the plan's anchors applied exactly once, every symbol and
  token existed, and no typed fake or importer broke.
