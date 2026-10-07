# U13 report - S11d (Settings > Housing authorities & agencies: lists, admin actions, Not on the list, tab + route + profiler pin)

- Implementer: U13 (Opus 5.5), 2026-10-07, worktree W:/tmp/clean-org-names,
  branch feat/clean-org-names. Range: plan Tasks 11.15-11.18 (plan lines
  22740-26011) plus worklist items RE2-1, RE2-3, RE2-4.
- Start: 5822670b (clean tree, no MERGE_HEAD). End: 12b2f6dd (clean tree).
- Inputs used as they are in the tree (U10-U12): api client + types,
  orgCopy.ts, useOrgList, OrgPicker, NewOrgDialog (settings mode),
  useOrgAdmin. Every symbol the plan imports existed with the plan's shape;
  every CSS token the new stylesheet uses exists in ui/tokens.css.
- Slow gates (npm test, e2e, smoke) NOT run - the orchestrator's.
- Logs: `.superpowers/sdd/u13-*.log` (gitignored).
- Transcription check: every new file and every appended test block was
  diffed against the plan's own lines (sed extraction): byte-identical except
  the divergences listed below.

## Per task

### Task 11.15 - 8183e5b4 feat(dashboard): Settings section for the organization lists - view, add, notes
- Files (new): routes/settings/OrgListSection.tsx, OrgEntryDialogs.tsx (notes),
  OrgListSection.module.css, OrgListSection.test.tsx.
- RED: `Failed to resolve import "./OrgListSection.js"`.
- GREEN: 9 passed, exit 0, no stderr.
- Gates: typecheck exit 0; eslint (3 .ts/.tsx) exit 0; tr check 0 on all 4.

### Task 11.16 - 7b615130 feat(dashboard): admin entry actions on the organization lists
- Files: OrgEntryDialogs.tsx (5 admin dialogs + skippedSpellingsNotice),
  OrgListSection.tsx, OrgListSection.test.tsx.
- RED (plan block): 8 failed / 9 passed - `Unable to find an accessible
  element with the role "button" and name "Edit spellings for Atlanta Housing
  Authority"` (no admin row action; the everyone cases stayed green).
- GREEN on the plan's code verbatim: 17 passed.
- RE2-3 RED (2 new cases, written after the plan's GREEN): 2 failed / 17
  passed - `expected document not to contain element, found <p
  class="_notice_..."> Not kept as a spelling: Atlanta Housing Authority
  (...)` after a later notes save, and after a later rename that skipped
  nothing.
- RE2-3 GREEN: 19 passed; re-run twice more 19/19.
- Gates: typecheck exit 0; eslint (3 files) exit 0; ASCII clean.

### Task 11.17 - b65bccbf feat(dashboard): "Not on the list" - records and the admin settling actions
- Files: NotOnListSection.tsx + NotOnListSection.test.tsx (new),
  OrgListSection.tsx, OrgListSection.test.tsx.
- RED: `Failed to resolve import "./NotOnListSection.js"` and 2 failed / 19
  passed in OrgListSection - `Unable to find role="region" and name "Not on
  the list"` (exactly the plan's two causes).
- GREEN: 2 files / 36 passed; re-run twice more 36/36; no stderr.
- Gates: typecheck exit 0. The task's eslint command (5 files): 0 errors after
  the `offerUse` rename (see divergences); 1 warning = U12's known
  useOrgAdmin.ts:121 unused directive (plan code). Test files lint clean.

### Task 11.18 - 12b2f6dd feat(dashboard): Settings tab for housing authorities and agencies
- Files: settingsTabs.ts, settingsTabs.test.ts, SettingsPage.test.tsx,
  App.tsx, e2e/performance/routes.test.ts, e2e/performance/routes.ts,
  e2e/README.md, docs/issues/perf-pages-settings-organizations-surface.md
  (the plan's staging list, nothing else).
- Baseline before editing: e2e routes.test + mutationCatalog.test 30 passed.
- RED: 6 failed / 4 passed - the expected tab arrays carry 'organizations' /
  'Housing authorities & agencies' and the model has none.
- GREEN (a) settingsTabs.ts: 10 passed.
- Named fallout reproduced after GREEN (b) (App.tsx route): routes.test
  'mechanically matches App route elements ...' 1 failed / 25 passed with
  `+ "/organizations"` (read as an unknown top-level path); GREEN (c) fixed it.
- GREEN: `npx vitest run src/routes/settings src/App.test.tsx` 22 files / 256
  passed; e2e `performance/routes.test.ts performance/mutationCatalog.test.ts`
  2 files / 30 passed; typecheck exit 0; `npm run issues` exit 0 (365 open /
  559 total; INDEX.md row 156 lists the new slug; INDEX.md is gitignored,
  not staged).
- Profiler count pins recomputed, not copied: no ROUTES row is added (the
  path joins `excluded`), `routes.ts` has 31 `row({ surfaceId:` rows, and the
  pins at routes.test.ts:212, :289, :290, :658 all say 31 - equal.
- App.tsx / routes.ts / routes.test.ts edits are additive and exactly at the
  plan's anchors (feat/tour-list touches the same files).
- Gates: eslint (6 touched .ts/.tsx) exit 0; added and removed lines ASCII.

## S11 slice gate (plan, after Task 11.18)
- dashboard workspace `npx vitest run`: 222 files / 3871 passed, exit 0
  (34.4 s).
- e2e `performance/routes.test.ts performance/mutationCatalog.test.ts`: 30
  passed, exit 0. `npm run typecheck` on HEAD: exit 0.
- Gate 5 over the 49 .ts/.tsx files touched 15f373a0..HEAD (all of S11): 10
  errors + 1 warning. All 10 are the worklist's named baseline and were
  re-proved at the merge base d839494a via `git show | npx eslint --stdin`:
  BroadcastComposer.test.tsx no-unused-vars x3, BroadcastComposer.tsx
  set-state-in-effect x4, useComposerDraft.ts react-hooks/refs x1,
  ContactDetail.test.tsx no-unused-vars x2 - same rules and counts at the
  base. None in a U13 file. The warning is useOrgAdmin.ts:121 (U12, plan
  code; a warning, not an error).
- ASCII: `git diff -U0 5822670b..HEAD` - 0 non-ASCII added lines, 0 non-ASCII
  removed lines (no pre-existing glyph line touched: settingsTabs.test.ts:1,
  SettingsPage.test.tsx em-dash lines, App.tsx and README glyph lines all
  byte-identical); `tr` check 0 on all 7 new files.

## Worklist items
- RE2-3 (Tasks 11.16/11.17): OrgListSection.tsx `closeAndReload` (:168-172)
  calls `setNotice(null)` before `admin.reload()`; `onRenamed` sets the
  skipped-spellings notice when any were skipped and `null` otherwise. The
  plan's 11.17 `onSettled` already did skipped-or-null - kept as written.
  Tests: describe 'OrgListSection - a notice never outlives a later clean
  action' (OrgListSection.test.tsx:425), two cases, RED first (above).
- RE2-1 (Task 11.18 e): the issue doc's last Problem sentence reads "... on
  each load, and while a rewrite runs the section re-reads `GET
  /api/organizations` every 2 s, then reads the two scans once more when it
  stops." (diff vs plan: only that sentence).
- RE2-4: settingsTabs.test.ts:42 and SettingsPage.test.tsx:71 test names now
  list "+ Housing authorities & agencies" after "Phone numbers"; the header
  comment (settingsTabs.test.ts:3-5) reads "Templates, Notifications, Voice
  and Phone numbers + Housing authorities & agencies are visible to
  everyone." (rewrapped to two lines). Non-ASCII line 1 untouched.

## Divergences from the plan
1. NotOnListSection.tsx:75 - the plan's local helper `use` inside
   `settleChoices` is renamed `offerUse` (4 call sites). Why: eslint
   react-hooks/rules-of-hooks reads a call to `use` as React 19's use() hook
   and reported 4 errors on the plan's code; the plan's own Task 11.17 step
   requires "no errors" and gate 5 would block. A renamed local (the brief's
   allowed class); behavior identical; named in the commit body.
2. RE2-3 test placement: a new describe block between the plan's 11.16 and
   11.17 blocks (the 11.17 RED (b) block was then appended after it - "at the
   end of the file" as the plan says).
3. Commit bodies: 7b615130, b65bccbf and 12b2f6dd carry short bodies naming
   the worklist item / rename (subjects exactly as planned).

## Out of scope, noticed
- dashboard/src/routes/settings/OrgListSection.tsx:307 - the Settings "Add
  housing authority/agency" `onAdded` (`setAdding(null); admin.reload()`)
  does not clear `notice`, so a "Not kept as a spelling" notice from an
  earlier rename survives a later Add. RE2-3 names only closeAndReload and
  onRenamed, and the plan's onAdded is unchanged, so I followed the plan; a
  one-line `setNotice(null)` there would complete RE2-3's stated intent.
- dashboard/src/routes/settings/settingsTabs.test.ts:3 - "Team + System
  status are the ONLY admin-only tabs" is stale since AI run log
  (pre-existing; not touched beyond RE2-4).
- dashboard/src/routes/settings/useOrgAdmin.ts:121 - unused eslint-disable
  directive (U12 already noted; plan code).

## Next
- S11 is complete (Tasks 11.1-11.18 committed; slice gate green). Next is
  S14 (plan line 26012): e2e pinned specs, the org fixture, org-lists.spec.
