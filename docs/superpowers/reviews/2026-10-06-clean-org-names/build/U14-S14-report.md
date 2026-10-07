# U14 report - S14 (e2e on the new world: picker driver, org fixture, pinned specs, org-lists spec, e2e docs)

- Implementer: U14 (Opus 5.5), 2026-10-07, worktree W:/tmp/clean-org-names,
  branch feat/clean-org-names. Range: plan Tasks 14.1-14.8 (plan lines
  26012-28012) plus worklist RF-7. Task 14.9 (the whole suite) NOT run - the
  orchestrator's (worklist RF-4).
- Start: 66865641 (clean tree, no MERGE_HEAD). End: ea32a24b (clean tree).
- Preconditions (S14 header): S11/S12/S13 commits present, OrgPicker.tsx
  exists, app/src/routes/dev.ts mounts /__dev/org-fixture; Docker up
  (hc-dynamodb-local running, never restarted).
- Edited ONLY files under e2e/. Every e2e run was a targeted, single-hop
  `npm run e2e -w @housingchoice/e2e -- <files>` from the worktree root; each
  booted hermetic lane 13 (app :10301, dashboard :10311, fake :10321) and tore
  it down; after every run netstat showed no listener left on the lane's
  ports. No run aborted, so no e2e:stop was needed. Never touched :5174/:8080.
- Logs: `.superpowers/sdd/u14-*.log` (gitignored).
- Transcription check: orgFixture.ts, the new org-lists.spec.ts and each
  appended block (14.5, 14.6, 14.7), and the selectors.md rows (b) and (f)
  and README line (2b) were diffed against the plan's own lines (sed
  extraction): byte-identical (the (f) Settings row differs only by RF-7).

## Selector contract (verified against the as-built S11 sources)

- Before 14.1 (P1-P5) against OrgPicker.tsx: combobox = `<input
  role="combobox">` labelled by `<label htmlFor>` (the field label); options
  portaled to document.body, name = entry name + optional ` (<spelling>)`;
  add option `Add <text> as a new <housing authority|agency>` (only with
  onRequestAdd - AudienceFilters passes none); chip button aria-label
  `Remove <value>`; marker text `Not on the list`. No differences.
- Before 14.4 (N1-N4, S1-S8, L1-L6, A1-A2) against NewOrgDialog.tsx, Modal,
  OrgListSection.tsx, OrgEntryDialogs.tsx, NotOnListSection.tsx,
  SettingsPage.tsx/settingsTabs.ts, AiRunDetail.tsx (+ AI_RUN_DROP_REASON_LABELS)
  and listingFormat.ts: dialog titles, `Use <name>`, `Yes, add it`, `Name` /
  `Notes`, tab `Housing authorities & agencies`, regions via
  `<section aria-labelledby>`, `<th scope="row">` names, `Add agency`,
  `Edit notes for <name>` -> `Edit notes` / `Notes` / `Save`, usage text
  `N tenants ... N property`, `Rename <name>` -> `New name` / `Rename`, admin
  actions absent for a VA (isAdmin gate), `Show records`, holder `<li>` with
  link + ` - deleted`, `Use|Move to Agency as|Split into ... + ...|Clear` with
  confirms repeating the label, checkbox `Remember this spelling` (off and
  disabled for a name variant), drop label `Agency, not a housing authority`,
  Activity `Housing authority updated` + `from -> to`. No differences - the
  UI block and ORG_PICKER are the plan's as written (recorded in the 14.1 and
  14.4 commit bodies).

## Per task

### Task 14.1 - 00365e09 test(e2e): org picker driver; scenario steps pick organization-list names
- Files: e2e/scenarios/steps.ts (5 edits: ORG_PICKER + pickOrgName,
  expectTenantDetails comment, seedAvailableUnit doc/default,
  teamCreatesUnitFromIntake doc + picker loop, editTenantIdentity),
  tests/scenarios/tenant-onboarding.spec.ts (4+4+2 replace_all + the SMS
  line), tests/scenarios/sending-unit.spec.ts (1).
- RED: tenant-onboarding.spec.ts:142 + :161 -> 2 failed, both at
  expectTenantDetails `expect(contact['housingAuthority']).toBe(...)`
  Expected "atlanta_housing" / "dekalb_housing", Received undefined (the
  plan's first stated reason).
- GREEN: tenant-onboarding + sending-unit + landlord-onboarding -> 15 passed
  (6+2+7), 0 failed (1.0m).
- Gates: e2e typecheck exit 0; eslint (3 files) exit 0 - 0 errors, 4
  pre-existing warnings (unused no-console directives at
  tenant-onboarding.spec.ts:34,38 and sending-unit.spec.ts:44,48, untouched
  lines); added lines ASCII.

### Task 14.2 - 34636728 test(e2e): org fixture; contact detail and tenant facets on organization-list names
- Files: e2e/fixtures/orgFixture.ts (new), contact-detail.spec.ts (6 edits;
  the non-ASCII line 107 untouched), contacts-list-facets.spec.ts (5 edits).
- RED: contact-detail.spec.ts:82 -> 1 failed at :90,
  `getByText('atlanta_housing').first()` element(s) not found.
- GREEN: contact-detail + contacts-list-facets -> 9 passed (8+1), 0 failed.
- Gates: typecheck exit 0; eslint (3 files) exit 0; tr check on
  orgFixture.ts = 0; added lines ASCII.

### Task 14.3 - 53b3acb0 test(e2e): blast fence, Properties summary and composer label on organization-list names
- Files: a2p-compliance.spec.ts (import + run-unique added authority),
  properties-available-view.spec.ts (4 edits), matching-entry-points.spec.ts
  (2 exact labels), broadcasts.spec.ts (the :20 comment).
- RED: a2p-compliance.spec.ts:444 + properties-available-view.spec.ts -> 2
  failed: a2p at :463 `expect(r.ok())` (server log: contact PATCH 422);
  properties at createProperty :69 with body
  `{"error":"org_not_on_list","field":"accepted_authorities","text":"Summary Authority 911262",...}`.
- GREEN: a2p-compliance + properties-available-view + matching-entry-points
  -> 27 passed (23+1+3), 0 failed.
- Gates: typecheck exit 0; eslint (4 files) exit 1 with ONE error,
  broadcasts.spec.ts:270 no-unused-vars `request` - PRE-EXISTING: the same
  error at the same line when linting HEAD's and d839494a's copies through
  --stdin (this task only changed the :20 comment). Added lines ASCII.

### Task 14.4 - b276145f test(e2e): org-lists spec - tenant, property and composer pickers
- File: e2e/tests/dashboard-next/org-lists.spec.ts (new). PIN-only (plan
  section 0's e2e exception).
- GREEN: org-lists.spec.ts -> 4 passed, 0 failed.
- Gates: typecheck exit 0; eslint exit 0; tr check 0.

### Task 14.5 - 5868803c test(e2e): org-lists spec - Settings lists, VA add and notes, admin rename
- PIN. Imports extended (Locator; getOrgUsage, requireOrg, waitForRewrite),
  Settings block appended.
- GREEN: org-lists.spec.ts -> 6 passed, 0 failed.
- Gates: typecheck exit 0; eslint exit 0; tr check 0.

### Task 14.6 - e93cccdc test(e2e): org-lists spec - Not on the list: records, Use, Move, Split, Clear
- PIN. Import + getNotOnList, "Not on the list" block appended.
- GREEN: org-lists.spec.ts -> 8 passed, 0 failed (the four-rewrite admin
  test ran in 4.1s).
- Gates: typecheck exit 0; eslint exit 0; tr check 0.

### Task 14.7 - 544c9bf4 test(e2e): org-lists spec - AI housing authority suggestions and the agency drop
- PIN. extraction fixture import, AI block appended (`\\b` verified intact).
- GREEN: org-lists.spec.ts -> 11 passed, 0 failed.
- Gates: typecheck exit 0; eslint exit 0; tr check 0.

### Task 14.8 - ea32a24b docs(e2e): selectors for the org pickers, Settings lists and the org-fixture seam
- selectors.md: (a) SKIPPED per its own condition (`agency_not_authority`
  already at :72, added by S11); (b) dev-seam row; (c) `Atlanta Housing
  Authority (2)`; (d) the row-facts example; (e) the stored-value sentence;
  (f) property-form row + three new rows, with worklist RF-7 applied
  ("`exact` because `getByRole` name matching is substring by default"; the
  old "tab's own title" clause no longer appears).
- README.md: Step 2 SKIPPED per its own condition (S13's `/__dev/org-fixture`
  line exists at :595); Step 2b fixtures line (now :610) gains `orgFixture`.
- Check: `git diff -U0 ... | grep '^+' | grep -nP '[^\x00-\x7F]'` printed
  nothing.

## Extra checks
- e2e workspace unit tests (`cd e2e; npx vitest run`, which scan spec files
  and README): 22 files / 503 tests passed, exit 0.
- Isolation proof: `git grep -n "Accepts:" -- e2e/tests e2e/scenarios` prints
  nothing.
- The only `atlanta_housing` left in e2e are the 17 `accepted_authorities`
  specs the S14 header leaves unchanged by design; no other literal slug or
  free-text authority value remains, and no `getByLabel('Housing
  authorit...')` without `exact: true`.

## Divergences from the plan / worklist
- None in code: every file and block is the plan's text (diff-verified).
- RF-7 applied as the worklist says (14.8 f).
- Commit bodies were added to 14.1, 14.4 and 14.8 (contract conformance and
  the two skips); subjects are the plan's.
- Process note: the 14.1 RED invocation ended with `; echo "exit=$?"` after
  the redirected e2e command (it only printed the exit code; the reporter
  lines were read from the log). Every later run was bare, per the no-chain
  rule.

## Out of scope noticed
- Gate-5 baseline addition (pre-existing at d839494a):
  e2e/tests/dashboard-next/broadcasts.spec.ts:270 no-unused-vars `request`.
- Pre-existing eslint WARNINGS (not errors): unused no-console disable
  directives at e2e/tests/scenarios/tenant-onboarding.spec.ts:34,38 and
  e2e/tests/scenarios/sending-unit.spec.ts:44,48.
- Not covered end to end (plan 14.7's list, for the handback): merge,
  delete, kind change, admin spelling edits and the shared-spelling confirm,
  Move to Housing authority, Add as new, Run again, the composer's 422
  re-pick after a rename (D7), the other-kind message in "Is this really
  new?", and a pre-deploy agency suggestion's Dismiss.
