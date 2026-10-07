# U12 report - S11c (HA suggestion accept, AI run log, property Activity labels, useOrgAdmin)

- Implementer: U12 (Opus 5.5), 2026-10-07, worktree W:/tmp/clean-org-names,
  branch feat/clean-org-names. Range: plan Tasks 11.11-11.14 (plan lines
  21693-22739) plus worklist items RE2-2 (applied) and RE2-5 (NOT adopted,
  as ruled).
- Start: 37838d63 (clean tree, no MERGE_HEAD). End: e8a4a550 (clean tree).
- Inputs used as they are in the tree (U10/U11): api client, orgCopy.ts
  (isRewriteLive, orgErrorCopy), useOrgList, NewOrgDialog (suggestion mode,
  initialCheck, onUse(ref, via), onDismissSuggestion, onAdded).
- Slow gates (npm test, e2e, smoke) NOT run - the orchestrator's.
- Logs: `.superpowers/sdd/u12-*.log` (gitignored).

## Per task

### Task 11.11 - 81fbbe7a feat(dashboard): accepting an AI housing authority goes through "Is this really new?"
- Files: dashboard/src/routes/contact/ContactDetail.tsx, ContactDetail.test.tsx.
- RED: 7 failed / 96 passed (103) - `expected "spy" to be called with
  arguments: [ { kind: 'housing_authority', ... } ]  Number of calls: 0`
  (checkOrgText never called); the failed-check case showed acceptSuggestion
  called at once with the bare three-argument identity; the dialog cases
  found no "Is this really new?" dialog.
- GREEN: ContactDetail 103 + useSuggestions 2 = 105 passed, exit 0 (the
  voucher-size / address / first-name accept pins stay three-argument).
- Gates: typecheck exit 0. eslint ContactDetail.tsx: 0 problems.
  ContactDetail.test.tsx: only its 2 named baseline errors (PlacementsPage
  :8, UnitsPage :11 - worklist S17 list).

### Task 11.12 - 6d7df5b4 feat(dashboard): AI run log labels drop reasons and shows the organization list fingerprint
- Files: dashboard/src/api/types.ts, types.test.ts,
  routes/settings/aiRuns/AiRunDetail.tsx, AiRunsSection.test.tsx,
  AiRunsSection.module.css (RE2-2), e2e/support/selectors.md (row 72).
- RED: 7 failed / 56 passed (63) - types.test `(0 , aiRunDropReasonLabel)
  is not a function` / `Cannot convert undefined or null to object` (map
  missing); Reason cell received `the tenant said Step Up helps her` (model
  reason alone) and `agency not authority` (humanized); header had no
  `Organization list fingerprint` line. The (PIN) case passed.
- GREEN: types.test 32 + AiRunsSection 31 = 63 passed, exit 0.
- Gates: typecheck exit 0; eslint on the 4 touched .ts/.tsx exit 0.
- Hand mirror checked against app/src/services/extraction/runTypes.ts:25-40
  (the same 13 codes, agency_not_authority included).
- RE2-2 applied: `overflow-wrap: anywhere;` added inside the unique
  `.detailHeader p { ... }` substring of AiRunsSection.module.css:18; the
  rest of that one-line file region is byte-identical.

### Task 11.13 - ee82c1d8 feat(dashboard): property Activity names the organization-list rewrites
- Files: dashboard/src/routes/listing/listingFormat.ts, listingFormat.test.ts.
- RED: 1 failed / 31 passed (32) - `expected { label: 'Org name rewrite' }
  to deeply equal { label: 'Housing authority updated', sub: 'AHA, DCA ->
  ...' }` (the humanize fallback).
- GREEN: 32 passed, exit 0.
- Gates: typecheck exit 0; eslint (2 files) exit 0.

### Task 11.14 - e8a4a550 feat(dashboard): useOrgAdmin - the organization Settings data, polled while a rewrite runs
- Files (new): dashboard/src/routes/settings/useOrgAdmin.ts,
  useOrgAdmin.test.tsx - both byte-identical to the plan's code blocks
  (`diff` against plan lines 22606-22733 and 22436-22597: no output).
- RED: `Failed to resolve import "./useOrgAdmin.js"`.
- GREEN: 7 passed, exit 0; re-run 3 more times (real timers): 7/7 each.
- StrictMode evidence: a TEMPORARY P13 mutation (cleanup aborts but keeps
  the slot: the two release lines removed) made the StrictMode case fail -
  `expected null to deeply equal [ { field: 'housingAuthority', ... } ]`
  after the 5 s timeout. Restored with Edit before the commit; the file
  re-diffed identical to the plan and the suite went green again.
- RE2-5 NOT adopted: the poll is the plan's (`setInterval(reloadList,
  pollMs)` keyed on rewriteLive only).
- Gates: typecheck exit 0. eslint (2 files): 0 errors, 1 warning -
  useOrgAdmin.ts:121:7 "Unused eslint-disable directive (no problems were
  reported from 'react-hooks/set-state-in-effect')" on the rewrite-stopped
  effect. That is the plan's code verbatim and RE2's "Not findings"
  predicted it; a warning, not an error (gate 5 counts errors).

## Final combined run
- dashboard `npx vitest run src/routes/contact src/routes/settings
  src/routes/listing src/api src/routes/orgs`: 115 files / 2035 passed,
  exit 0. No stderr from the new cases (the stderr present is the
  pre-existing "Run AI extraction" act() noise and RE1-6's form-test noise).
- eslint over the 10 .ts/.tsx files touched 37838d63..HEAD: 2 errors, both
  named baseline (ContactDetail.test.tsx PlacementsPage, UnitsPage), plus
  the 1 warning above. Nothing new.
- `npm run typecheck` on HEAD: exit 0.
- ASCII: added lines in `git diff 37838d63..HEAD`: 0 non-ASCII; the two new
  files' `tr` check prints 0. No pre-existing non-ASCII line was touched
  (ContactDetail.tsx, listingFormat.ts/.test.ts and types.ts carry glyphs on
  other lines; every edited anchor was ASCII).

## Watch items (verified)
- "Is this really new?" renders after the ContactEditForm block, outside
  every form, and every NewOrgDialog button is typed (U10's component).
- The page reads no list on load: /check runs only at Accept click time.
- `ApiError.message` is never rendered: refusals go through
  `failSuggestion` (suggestionResolutionErrorMessage) or `orgErrorCopy`.
- Labels "Housing authority" etc. untouched.

## Divergences from the plan / worklist
- None in code: every anchor applied exactly once and every symbol existed
  as the plan uses it.
- Edit-tool anchoring only: three old_strings were extended by an adjacent
  unchanged line for certainty (ContactDetail.tsx reset-effect anchor + the
  comment line after it; types.ts `promptFingerprint?: string;` + the
  `usage?` line after it; the test-file appends anchored on each file's last
  assertion). The resulting text is exactly the plan's.
- The 6d7df5b4 commit carries a 2-line body naming RE2-2 (subject as
  planned).
- The StrictMode mutation was a temporary in-task edit, reverted before the
  commit (not a divergence; recorded as evidence).

## Out of scope, noticed
- dashboard/src/routes/settings/useOrgAdmin.ts:121 - the unused
  eslint-disable directive above (plan code); a later cleanup can drop it.
- Nothing else: no typed fake, importer or other suite broke.

## Next
- Task 11.15 (plan line 22740): `OrgListSection` - the two lists, Add,
  notes, the latest rewrite (everyone).
