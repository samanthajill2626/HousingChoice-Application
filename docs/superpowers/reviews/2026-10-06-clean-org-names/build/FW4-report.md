# FW4 report - code review round 4 micro-wave (B26, B27), dashboard

- Implementer: FW4 (Claude Opus 5.5), 2026-10-07. Worktree `W:/tmp/clean-org-names`,
  branch `feat/clean-org-names`.
- Range: after 6d8f1fbe (R4 records) through 21f6e7ea - 2 commits, one per item. 6 files,
  +115/-13. Tree clean after the last commit. Nothing left running. `app/` and `e2e/`
  untouched; no e2e, smoke or `npm test` run (per dispatch).
- Both items test-first: the new tests ran RED on the unfixed code at the assertion the
  finding names, then GREEN. Logs: `.superpowers/sdd/fw4-*.log`.
- Commit checks each time: bare `git status` as its own command, no MERGE_HEAD, explicit
  paths only, `git commit -F <file>`, ASCII message with the `Co-Authored-By: Claude Opus
  5.5` trailer; 0 non-ASCII bytes on added lines (`git diff -U0` checked per commit).
- Baseline before any edit: broadcasts + orgs + ContactEditForm + listing, 29 files / 630,
  exit 0.

## Per item

| item | commit | RED (one line) | GREEN | fast gates (exit) |
|---|---|---|---|---|
| B26 | 4750b0a3 fix(dashboard): a composer change undone before its draft lands leaves Preview usable | R4-2 T5: `?unitId=unit-0001`, Preview enabled, type `X{Backspace}` in Message, wait 800 ms: one create (passed), then `expect(previewButton()).toBeEnabled()` failed - button `disabled` (BroadcastComposer.test.tsx:958). Sibling: second create rejects -> error alert + Preview disabled (passed), Backspace -> `toBeEnabled()` failed (:973). 2 failed | 2/2; broadcasts 12 files / 220, exit 0 | eslint 0 new (below) |
| B27 | 21f6e7ea fix(dashboard): an org picker emptied after a failed re-read stays usable | R4-3: tenant form, Agency "Hope", "Yes, add it" for Metro HA with the re-read failing, `user.clear(agency())` -> `expect(agency()).toBeEnabled()` failed - input `disabled`, value "" (ContactEditForm.test.tsx:1100). 1 failed | 1/1; broadcasts + orgs + ContactEditForm + listing + settings 50 files / 895, exit 0 | typecheck 0; eslint 0 errors |

B26 mutants (each setter removed alone, the rest of the fix kept): no `setReachPending(false)`
-> T5 fails; no `setStale(false)` -> the sibling fails at `toBeEnabled()`; no
`setError(null)` -> the sibling fails at the alert's `not.toBeInTheDocument()`. Each of
the three is pinned by exactly one test.

## Final gates (after the last commit)

- dashboard workspace `npx vitest run`: 222 files / 3972 tests, exit 0 (3969 at FW3-B's
  end + 3 new).
- `npm run typecheck` (every workspace): exit 0.
- eslint on the 6 `.ts/.tsx` files touched 6d8f1fbe..HEAD: 4 errors, 0 new. Same rules and
  counts at d839494a (linted from `git show` via `--stdin`): `BroadcastComposer.test.tsx`
  3 x `@typescript-eslint/no-unused-vars` (`ContactsPage`, `UnitsPage`,
  `DEFAULT_SEND_TEMPLATE`; 44:10 vs base 37:10, an import-line shift);
  `useComposerDraft.ts` 1 x `react-hooks/refs` (140; base 116). `AudienceFilters.tsx`,
  `ContactEditForm.test.tsx`: 0 now and at base; `orgCopy.ts`, `useTypedOrgText.ts`: 0
  (new on the branch, absent at base). Checked further: with the ref write at
  useComposerDraft.ts:140 removed, base and HEAD both lint clean - the compiler's bail-out
  on that error hides no `set-state-in-effect` from the three setters B26 adds.

## Divergences and decisions

1. B27 - the expression is `list.error && orgListUnknown(list) && text.trim() === ''`, not
   R4-3's literal `orgListUnknown(list) && text.trim() === ''`. `orgListUnknown` is also
   true while the FIRST read is in flight (`loading`), so the literal form disables every
   empty form picker until the list lands and swallows text typed right after a form
   opens. Run as a mutant: 41 failed / 287 passed across ContactEditForm, ListingEditForm,
   UnitCreateForm - R2-FE-1 "Save before the list loads", the R3-FE-6 and R3-FE-3 tests,
   the new R4-3 test itself, and most typing tests (`fw4-b27-literal-mutant.log`). The
   ruling's own words ("an EMPTY picker under a failed list", "disable an empty picker
   only when no list was ever loaded") give the gated form. useOrgList sets `error` true
   only with `loading` false, so the gated form is exactly "a failed read with nothing in
   hand".
2. B27 - AudienceFilters takes the same expression for one rule; it is behavior-neutral
   there. Its useOrgList is never re-read (no `reload` / `noteAdded` / `poll` in
   AudienceFilters or BroadcastComposer), so a failed read there never has a list in
   hand. No RED is possible, so none was written.
3. B27 - doc-only, a third file: `orgCopy.ts` `OrgListView.error` said "the pickers are
   disabled, except one holding typed text". It now says "with no list in hand", so the
   shared type's doc no longer contradicts the hook. Also updated: useTypedOrgText's
   header and `disabled` doc, and the AudienceFilters comment.
4. B27 - the RED test goes on to the user's actual goal (retype "Step Up", pick it from
   the list in hand, Save sends `{ housingAuthority: 'Metro Housing Authority', agency:
   'Step Up' }`). It also asserts that R4-3's second symptom is fixed: the Housing
   authority picker and its new chip's remove button stay enabled. The never-loaded tests
   are unchanged and green (e.g. ContactEditForm.test.tsx:752, :1002, :1014; the listing
   forms' equivalents).
5. B26 - a second test (a failed recreate, undone) beyond T5. The ruled fix also clears
   `stale` and `error`, and T5 alone pins only `reachPending` (the mutants above show
   this).
6. B26 - the UI copy carries non-ASCII characters (an ellipsis in "Sizing the audience",
   an em dash in "Couldn't estimate the audience - try again."), so the tests match
   `/Sizing the audience/` and `/estimate the audience/` and stay ASCII.

## Out of scope, noticed (no change made)

1. R4 Charge 1a's T3 (a dropped preview that comes back as the review after an undo, with
   Preview disabled after "Edit audience & message") rested on the same `reachPending`
   flag, and B26 clears it. Fixed by construction, as traced (the early return now clears
   the flag before the review re-renders); not separately tested.
2. `e2e/support/selectors.md:122` already states the B27 rule correctly ("a failed RE-read
   settles the text against the list still in hand"). Nothing stale there.
