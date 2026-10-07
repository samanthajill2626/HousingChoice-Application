# U11 report - S11b (tenant pickers + retire orgVocabulary, property multi-picker, composer filter picker, composer 422)

- Implementer: U11 (Opus 5.5), 2026-10-07, worktree W:/tmp/clean-org-names,
  branch feat/clean-org-names. Range: plan Tasks 11.7-11.10 (plan lines
  19446-21692) plus worklist items RE1-1, RE1-2, RE1-3, RE1-4, RE1-6.
- Start: 7b7e7b75 (clean tree, no MERGE_HEAD). End: 5e0a7cfc (clean tree).
- Inputs used as they are in the tree (U10): api client, orgCopy.ts,
  useOrgList, OrgPicker, NewOrgDialog (incl. U10's RE1-5 120-char guard).
- Slow gates (npm test, e2e, smoke) NOT run - the orchestrator's.
- Logs: `.superpowers/sdd/u11-*.log` (gitignored).

## Per task

### Task 11.7 - a4a2141c feat(dashboard): tenant form picks the housing authority and agency from the lists; retire orgVocabulary
- Files: routes/contact/ContactEditForm.tsx, ContactEditForm.test.tsx,
  files.test.tsx (comment only), ContactDetail.test.tsx (getOrgList /
  checkOrgText / addOrg mocks); routes/contact/orgVocabulary.ts DELETED
  (`git rm`, as the plan says).
- RED: 11 failed / 32 passed (43) - on behavior, not a missing combobox (as
  the plan predicted): `Unable to find role="option" and name
  /^DeKalb County Housing Authority/`; "typing alone" sent a PATCH
  (`expected "spy" to not be called`); no hint description, no chip / Remove
  button / "Not on the list", no "Couldn't load housing authorities".
- GREEN: ContactEditForm 43 + ContactDetail 96 + files 35 = 174 passed, exit 0.
- Gates: typecheck exit 0. eslint (4 touched files): only the 2 named
  baseline errors in ContactDetail.test.tsx (PlacementsPage, UnitsPage).

### Task 11.8 - cfd2009c feat(dashboard): property forms pick housing authorities from the list
- Files: routes/listing/UnitCreateForm.tsx, UnitCreateForm.test.tsx,
  ListingEditForm.tsx, ListingEditForm.test.tsx, ListingDetail.test.tsx.
- RE1-3 applied: `within` added to UnitCreateForm.test.tsx `:1` (the
  ListingEditForm.test.tsx `:1` is rewritten by RED (b)).
- RE1-4 applied: UnitCreateForm.test.tsx `:74-76` comment now reads the
  worklist text verbatim, wrapped over three `//` lines.
- RED: 10 failed / 19 passed (29) - `Unable to find an accessible element
  with the role "combobox" and name "Housing authorities"` (the chip cases
  fail on "Remove ga_dca" / "Not on the list" for the same reason).
- GREEN: UnitCreateForm 11 + ListingEditForm 18 + ListingDetail 67 = 96
  passed, exit 0.
- Gates: typecheck exit 0; eslint (5 touched files) exit 0.
- Checked for unnamed fallout: no other suite opens "New property" or the
  property edit dialog (ListingsList renders UnitCreateForm; its tests never
  open it).

### Task 11.9 - 39874f22 feat(dashboard): blast composer picks the housing authority filter from the list
- Files: routes/broadcasts/AudienceFilters.tsx, AudienceFilters.test.tsx,
  BroadcastComposer.test.tsx + BroadcastComposer.prefill.test.tsx (getOrgList
  mocks).
- RE1-2: the `truncated: boolean; }` anchor was at `:32-34`; matched by text.
- RED: 4 failed / 8 passed (12) - no combobox "Housing authority" (2 cases),
  no role=alert for the load failure / `authorityError` (2 cases).
- GREEN: AudienceFilters 12 + prefill 2 + BroadcastComposer 37 = 51 passed,
  exit 0.
- Gates: typecheck exit 0. eslint: AudienceFilters.tsx/.test.tsx and the
  prefill test clean; BroadcastComposer.test.tsx only its 3 named baseline
  errors (ContactsPage, UnitsPage, DEFAULT_SEND_TEMPLATE).
- Only the two named composer suites render AudienceFilters
  (RecipientPreview.test.tsx / BroadcastsList.test.tsx never mount the
  composer).

### Task 11.10 - 5e0a7cfc feat(dashboard): the composer clears a housing authority pick the server refuses
- Files: routes/broadcasts/useComposerDraft.ts, BroadcastComposer.tsx,
  BroadcastComposer.test.tsx.
- RED: 2 failed / 37 passed (39) - the GONE text not found; the DOM showed
  exactly the plan's causes: create 422 -> "Couldn't estimate the audience
  - try again." with the Atlanta chip still present; Preview 422 -> the raw
  `org_not_on_list`.
- GREEN: `npx vitest run src/routes/broadcasts` 12 files / 205 passed, exit 0.
  BroadcastComposer.test.tsx re-run twice more (real 600 ms debounce): 39/39
  both times.
- Gates: typecheck exit 0. Task eslint command (useComposerDraft.ts,
  BroadcastComposer.tsx, AudienceFilters.tsx): exactly the 5 RE1-1 baseline
  errors - useComposerDraft.ts:128 react-hooks/refs (the disposableRef
  write); BroadcastComposer.tsx:190, :215, :234, :249
  react-hooks/set-state-in-effect. Baseline proof: the same two files at the
  merge base d839494a linted via `--stdin --stdin-filename` give the same
  rules and counts at :116 and :167/:192/:211/:226 - nothing new. The new
  onOrgNotOnListRef write sits in an effect and lints clean.

## Final combined run
- dashboard `npx vitest run src/routes/contact src/routes/listing
  src/routes/listings src/routes/broadcasts src/routes/orgs`: 98 files / 1881
  passed, exit 0.
- eslint over all 15 .ts/.tsx files touched 7b7e7b75..HEAD: 10 errors, every
  one in the worklist's named baseline (S17 list + RE1-1); none new.
- ASCII: `git diff 7b7e7b75..HEAD` added lines with non-ASCII: 0. No
  pre-existing non-ASCII line was altered (the em-dash fallback lines kept
  byte-identical: UnitCreateForm.tsx / ListingEditForm.tsx catch fallbacks,
  useComposerDraft.ts comment after the new 422 branch).

## Watch items (verified)
- Tenant form never sends an unchanged housingAuthority: exact compare with
  the stored text; pinned by "marks stored values ... never sends them
  untouched" (toStrictEqual { firstName }) and "typing alone changes
  nothing".
- "Is this really new?" renders after the </form>: `closest('form')` is null,
  asserted in the tenant, New property and Edit property forms.
- Composer picker commits only on a pick or a clear: asserted (typing AHA ->
  onChange not called); the 422 paths clear the pick via the composer.
- Labels "Housing authority", "Housing authorities", "Agency" unchanged; the
  pre-existing label assertions stayed green.

## Divergences from the plan / worklist
- None in code: every plan anchor applied exactly once and every symbol from
  U10's files existed as the plan uses it.
- RE1-4: the worklist's sentence is written verbatim (its single quotes kept)
  as a three-line comment.
- Task 11.7 (j): `git rm` staged the deletion before the explicit-path
  `git add` of the four edited files; the commit holds exactly those 5 paths.

## Out of scope, noticed
- dashboard/src/routes/broadcasts/AudienceFilters.module.css:64-78 - the
  `.input` and `.input:focus-visible` rules are now dead (Task 11.9 removed
  the last `styles.input` use; only AudienceFilters.tsx imports this module).
  Harmless; a later cleanup can drop them.
- act() warnings in the ContactEditForm / ContactDetail runs: RE1-6 noise, no
  action.

## Next
- Task 11.11 (plan line 21693): accepting an AI housing authority suggestion
  goes through "Is this really new?".
