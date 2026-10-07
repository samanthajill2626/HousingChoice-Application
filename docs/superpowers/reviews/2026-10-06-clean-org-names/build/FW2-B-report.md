# FW2-B report - code review round 2, dashboard + e2e fix wave (B10-B19)

- Implementer: FW2-B (Claude Opus 5.5), 2026-10-07. Worktree `W:/tmp/clean-org-names`,
  branch `feat/clean-org-names`.
- Range: after e03d39aa (FW2-A report) through 5848ff6d - 10 commits, one per item, in
  the order B13, B14, B16, B11, B15, B10, B18, B17, B12, B19 (B15's shared helper first,
  so B10 and B18 extend it instead of three per-form copies). Tree clean after the last
  commit (this report is the only untracked file). Nothing left running. `app/` untouched.
- Every dashboard item test-first: the new tests ran RED on the code before the fix and
  failed for the reason the finding states, then GREEN. Logs: `.superpowers/sdd/fw2b-*.log`.
- Commit checks every time: bare `git status` as its own command, no MERGE_HEAD, explicit
  paths only, `git commit -F <file>`, ASCII message with the `Co-Authored-By: Claude Opus
  5.5` trailer. Added diff lines: 0 non-ASCII; the one new file
  (`dashboard/src/routes/orgs/useTypedOrgText.ts`) is ASCII (`tr` count 0).
- Baseline before any edit: the 13 affected dashboard suites 267/267 (exit 0).

## Per item

| item | commit | RED (one line) | GREEN | fast gates (exit) |
|---|---|---|---|---|
| B13 | 6c9ff4ba fix(dashboard): a settle confirm groups placeholder values the way the server matches them | Clear on "--" said "(7 records (+1 deleted), written as -, - , -- or ())", expected "(3 records)". 1 failed / 16 passed | settings 21 files 259/259 | eslint 0 |
| B14 | 78e5fa71 fix(dashboard): a Settings poll restarts a list read that never settles | first poll read hangs: `expected 'running' to be 'done'` after 5 s (plain and StrictMode); useOrgList 5th tick: `expected "spy" to be called 2 times, but got 1`. 3 failed / 16 passed | orgs + settings 25 files 331/331; the two hook files re-run x2: 19/19 | eslint 0 errors (1 pre-existing warning, below) |
| B16 | b5c07f9e fix(dashboard): a renamed entry used from "Is this really new?" never reads Not on the list | chip "Atlanta Housing AuthorityNot on the list" after "Use Atlanta Housing Authority" for o-atl read as "Atlanta HA"; hook entries `[['o-atl','Atlanta HA']]`. 2 failed / 56 passed | 30 files 474/474 | eslint 0 |
| B11 | 50dae914 fix(dashboard): removing an org chip keeps the text typed in the picker | after Remove the field held '' (expected 'DeK'; tenant 'Georgia Department of Community Affairs'; property 'DCA'). 3 failed / 97 passed | 30 files 477/477 | eslint 0 |
| B15 | fef2b81e fix(dashboard): the note under an org picker says what its host will do with the text | forms' note for "DCA"/"HADC" read "Not saved - pick a name from the list, or clear the text." (expected "Save will use ..."), composer the same (expected "Not used as a filter - ..."); `typedOrgNote` / unmount report absent. 9 failed / 155 passed; the type-change PIN green | 30 files 487/487; fallout 119 files 2197/2197 | typecheck 0; eslint 0 |
| B10 | 4ab203c6 fix(dashboard): a form's Save never waits on an org picker staff cannot use | failed read: Save refused (updateContact / createUnit never called); re-read failure: "Couldn't load agencies" absent (the refusal shown instead); loading: alert "Pick a name from the list, add it as new, or clear the text." not "Still loading the list - try again in a moment.". 11 failed / 96 passed (6 are orgCopy unit cases on the new signature) | 119 files 2205/2205 | typecheck 0; eslint 0 |
| B18 | f51f835b fix(dashboard): every refused org-picker Save is announced again | second refusal's alert `toBe` the first node (same `<p id="..-error">`). 3 failed / 109 passed | 119 files 2208/2208 | typecheck 0; eslint 0 |
| B17 | f7009224 fix(dashboard): an org picker's note line is reserved while it holds typed text | no note line while the field holds text and focus (`expected null not to be null`) - the blur inserted it. 1 failed / 26 passed | 119 files 2209/2209 | eslint 0 |
| B12 | e58bf213 fix(dashboard): the blast composer holds Preview back while its authority filter holds typed text | exact name typed, option shown: Preview `not disabled`; AudienceFilters never forwarded the text; the field disabled under a failed list. 4 failed / 53 passed; the "Change" PIN green | 119 files 2214/2214 | typecheck 0; eslint: 7 errors, all pre-existing (below) |
| B19 | 5848ff6d test(e2e): org pickers - typed text saved, refused, and held back from the composer's Preview | n/a - see divergence 13 | org-lists.spec.ts alone: 14 passed (28.6 s), exit 0 - the 11 existing + the 3 new | typecheck (all workspaces) 0 |

## Final gates (after the last commit)

- dashboard workspace `npx vitest run`: 222 files / 3950 tests, exit 0 (3914 at FW-B's end
  + 36 new). Run after the last dashboard commit (B12); B19 touched e2e files only.
- e2e workspace `npx vitest run performance`: 17 files / 473, exit 0.
- `npm run typecheck` (every workspace, e2e included): exit 0 at 5848ff6d.
- e2e, ONLY `tests/dashboard-next/org-lists.spec.ts`, one npm hop from the worktree root
  (`npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/org-lists.spec.ts`), lane 13:
  14 passed (28.6 s), exit 0 - run after every dashboard commit, nothing edited or committed
  while it ran. Lane ports 10301/10311/10321/10331 free before and after; 0 `[dynamoAdmin]`
  lines in its log (`.superpowers/sdd/fw2b-e2e.log`). DynamoDB Local up throughout (never
  started, stopped or restarted). No other e2e spec types into the composer's housing
  authority filter (grep), so B12 changes no other spec's path.

## What changed, and every divergence / decision

1. B15 - ONE shared helper. The rule stays pure in `orgCopy.ts`
   (`settleTypedOrgText` + `typedOrgNote` + `typedOrgRefusal` + `refusesSave`); a new hook
   `dashboard/src/routes/orgs/useTypedOrgText.ts` holds a picker's typed text and refusal,
   gives the OrgPicker its note (`pendingNote`) and error, and gives Save its verdict
   (`settle()`: records the refusal, empties a committed text). All three forms use it for
   both the note and Save; their own typed/refused state and settle copies are gone. What
   stays per form is only applying a resolved name to that form's value (single: replace;
   multi: add) and which refused field takes focus.
2. B15 - each form OWNS its picker ref and passes it into the hook. A hook result carrying
   a `ref` property made the React Compiler lint (`react-hooks/refs`) flag every render use
   of that result (24 errors); passing the ref in keeps the result a plain value.
3. B15 - OrgPicker now reports '' when it unmounts. This replaces ContactEditForm's manual
   reset of the typed text on a type change (pinned: type in HA, Landlord, Tenant, Save
   sends nothing) and keeps the composer's typed-text state from going stale across
   "Change property" (B12 PIN).
4. B15 - `pendingNote` absent = the old default "Not saved - pick a name from the list, or
   clear the text." (kept for the Settle dialogs, whose typed text is never used); null =
   no note.
5. B10 - copy beyond the ruling: the note for a picker whose list FAILED is "Not saved -
   the list did not load." (`ORG_TYPED_LIST_FAILED`); the ruling's form copy would offer
   remedies a disabled field cannot take. No note while the list is still loading (nothing
   is known about the text yet). `settleTypedOrgText` now takes the list view (entries,
   loading, error) - orgCopy.test's `LIST` became that view, its calls unchanged.
6. B10 - a refusal recorded before the list failed is hidden while the list error stands
   (the load error shows: "never replaces it"); it would show again if a later read
   succeeds, until the text changes or the next Save.
7. B12 - the composer under a FAILED list: its picker stays enabled while it holds typed
   text (disabled again once cleared). Skipping the text there, as the forms do, would let
   Preview resolve the unfiltered audience - the very harm R2-FE-3 names - and keeping
   Preview held with the field disabled would lock it for good (R2-FE-1). Pinned in
   AudienceFilters.test. Hint order: "Write a message ..." first, then the typed-text hint,
   then "Sizing the audience...".
8. B14 - the age cap counts poll ticks (`POLL_TICKS_PER_READ` = 5, about 5 x pollMs), not
   wall time: the poller owns the cadence, and the dashboard tests pin `Date.now()` (a
   clock cap would never fire there). The read is given up on whether or not it honours
   abort. `useOrgAdmin.ts` header comment updated to match.
9. B16 - the provisional entry overrides the read's copy of its orgId by name and kind and
   keeps the read's spellings; a read that still returns the old name keeps the provisional.
10. B17 - the reserved line is one line of note (`min-height` = fs-xs x lh-normal; the
    note's line-height is now set). A note that wraps (narrow width, a long name) still
    adds its extra lines on blur. Checked in a real browser by B19 case 1 (the Agency
    field's offset from the HA field is unchanged across the blur).
11. B11 - the OrgPicker test that pinned the wipe ("... after a pick, a clear and an
    emptied input") now covers pick + emptied input; a new test pins the keep.
12. B18 - OrgPicker takes `errorAttempt` (the alert's React key); the hook counts refused
    Saves monotonically, so every refusal re-mounts the alert and a plain re-render keeps it.
13. B19 - written after the fixes it covers (the dispatch ordered e2e last), so its first
    run is GREEN; each behavior was shown RED in jsdom (B12, B15, B17) or in round 1 (B1).
    Case 1 also asserts, in a real browser, the "Save will use <name>." note and the
    no-reflow blur (B15, B17). One new `e2e/support/selectors.md` row documents the
    typed-text copy, the note and the composer hint.

## Lint (gate 5 preview)

`npx eslint` on the 22 `.ts/.tsx` files touched e03d39aa..HEAD: 7 errors + 1 warning, none
new. Every other touched file (the new hook and the e2e spec included): 0.
- `dashboard/src/routes/broadcasts/BroadcastComposer.tsx` 4 x
  `react-hooks/set-state-in-effect` (198, 223, 242, 257) - at d839494a the same 4 (167, 192,
  211, 226), effects this wave did not touch.
- `dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx` 3 x
  `@typescript-eslint/no-unused-vars` (`ContactsPage` 11:24, `UnitsPage` 11:69,
  `DEFAULT_SEND_TEMPLATE` 41:10) - at d839494a 11:24, 11:69, 37:10.
  (Both files re-linted at the merge base with `git show d839494a:<file> | npx eslint --stdin`.)
- `dashboard/src/routes/settings/useOrgAdmin.ts:133` WARNING "Unused eslint-disable
  directive" - present at e03d39aa as :130 (FW-B's note; the file is new on this branch, so
  it has no merge-base twin); B14's comment lines moved it.

## Out of scope, noticed (no change made)

1. `lastRewrite.error` (now A6's claim reason) is never shown on Settings, and A7's two new
   count keys reach the status line through `humanizeKey` ("Audit failed: N") - FW2-A's
   notes; not in this wave's items.
2. The forms' 422 field message (`orgFieldError`) is not re-announced on a repeated
   identical 422 - R2-FE-10 covered the typed-text refusal only
   (`dashboard/src/routes/contact/ContactEditForm.tsx`, the error prop of both pickers).
3. The Settle dialogs' pickers ("Name to use", Split) keep the default note and no guard
   (nothing there is saved without a pick) - unchanged.
4. `NotOnListSection` names two rows that differ only by surrounding whitespace (" - " and
   "-") separately in "written as" - cosmetic.
