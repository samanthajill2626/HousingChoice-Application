# FW3-B report - code review round 3, dashboard fix wave (B20-B25)

- Implementer: FW3-B (Claude Opus 5.5), 2026-10-07. Worktree `W:/tmp/clean-org-names`,
  branch `feat/clean-org-names`.
- Range: after 053accdc (FW3-A report) through ebb0d0c4 - 6 commits, one per item, in the
  order B24, B25, B22, B23, B21, B20 (independent ones first; B22's `orgListUnknown` gives
  B21 its "no add step"; B23 before B21 so B21 only drops the old error guard). 18 files,
  +657/-97. Tree clean after the last commit. Nothing left running. `app/` untouched.
- Every item test-first: the new tests ran RED on the code before the fix, failing for the
  reason the finding states, then GREEN. Logs: `.superpowers/sdd/fw3b-*.log`.
- Commit checks every time: bare `git status` as its own command, no MERGE_HEAD, explicit
  paths only, `git commit -F <file>`, ASCII message with the `Co-Authored-By: Claude Opus
  5.5` trailer; 0 non-ASCII characters on added lines (`git diff -U0` checked per commit).
- Baseline before any edit: the affected suites (orgs, settings, broadcasts, listing,
  ContactEditForm) 50 files / 873, exit 0.

## Per item

| item | commit | RED (one line) | GREEN | fast gates (exit) |
|---|---|---|---|---|
| B24 | 1145ae35 fix(dashboard): the housing authority hint is a sentence of its own | description "The organization that runs the voucher Save will use Georgia Department of Community Affairs." (expected "...voucher. Save will use ..."); the bare hint lacked its period. 2 failed | ContactEditForm + OrgPicker 85/85 | - (copy only) |
| B25 | b0037402 fix(dashboard): Settings never offers Run again for an update the list outgrew | `canRunAgain` of a failed rewrite with error `org_rewrite_target_gone: ...`: expected true to be false; Settings showed no reason and offered Run again. 2 failed | orgs + settings 25 files 343/343 | - |
| B22 | e8c9df6a fix(dashboard): a list that failed to load marks no chip "Not on the list" | failed first read: "Found multiple elements with the text: Not on the list" (tenant form, property edit form), the composer's chip marked, `orgListUnknown` missing. 5 failed | affected suites 50 files 880/880 | typecheck 0 |
| B23 | f859434a fix(dashboard): an org picker's refusal follows the text it was about | list landed after a refused Save: alert still "Still loading the list - try again in a moment." beside "Save will use DeKalb ..."; unknown text still said "Still loading" (expected the blocked copy). 2 failed | orgs + ContactEditForm + listing 17 files 408/408 | - |
| B21 | 0c107e9e fix(dashboard): typed org text is never dropped when the picker's list failed to load | never-loaded list: field disabled holding "DCA" / "Atlanta Housing Authority" and Create/Save went on without it (all three forms: `toBeEnabled` failed); failed re-read: agency "Step Up" dropped (description "Not saved - the list did not load. Couldn't load agencies"); orgCopy: re-read verdict `unavailable`, expected `resolved`; `refusesSave(unavailable)` false. 7 failed | 18 files 428/428 | typecheck 0 |
| B20 | ebb0d0c4 fix(dashboard): a composer Preview never sends one draft's candidates to another draft | R3-FE-1 (a) reproduced: pick during a held preview -> `sendBroadcast('draft_2', ['c-dekalb'])` (expected 'draft_1'); (b) typed text during a held preview -> the field took it (enabled); message edit / "Change property" during a held preview -> "Review recipients" rendered for the dropped result; AudienceFilters chips enabled. 6 failed | broadcasts 12 files 218/218; composer + AudienceFilters re-run 3x, 64/64 each | typecheck 0 |

## Final gates (after the last commit)

- dashboard workspace `npx vitest run`: 222 files / 3969 tests, exit 0 (3950 at FW2-B's end).
- e2e workspace `npx vitest run performance`: 17 files / 473, exit 0.
- `npm run typecheck` (every workspace): exit 0.
- eslint on the 17 `.ts/.tsx` files touched 053accdc..HEAD: 8 errors, 0 new. All in three
  files, same rules and counts at d839494a (linted from `git show` via `--stdin`):
  `BroadcastComposer.test.tsx` 3 x `@typescript-eslint/no-unused-vars` (`ContactsPage`,
  `UnitsPage`, `DEFAULT_SEND_TEMPLATE`); `BroadcastComposer.tsx` 4 x
  `react-hooks/set-state-in-effect` (204/229/248/263; base 167/192/211/226, effects not
  touched); `useComposerDraft.ts` 1 x `react-hooks/refs` (140; base 116). The other 14: 0.
- e2e, ONLY `tests/dashboard-next/org-lists.spec.ts` (`npm run e2e -w @housingchoice/e2e --
  tests/dashboard-next/org-lists.spec.ts`), lane 13: 14 passed (28.5 s), exit 0, all source
  committed, nothing edited while it ran. Before: a stale `e2e/.artifacts/session.pid`
  (53224, not running); ports 10301/10311/10321/10331 free before and after. 0
  `[dynamoAdmin]` lines (`.superpowers/sdd/fw3b-e2e.log`). DynamoDB Local up throughout,
  never started/stopped/restarted.

## Divergences and decisions

1. B20 - the discard is judged at RENDER, not from refs when the result lands. `preview` keeps
   `{ draftId, key, result }`; the review renders (and Send posts) only while
   `draftId === draft.draftId && key === draft.key && draft.draftKey === draft.key`
   (`currentPreview`, BroadcastComposer.tsx:396); otherwise the compose step shows
   "The audience changed - preview again." (role="alert", cleared when Preview starts
   again). Why: a ref mirrored in an effect lags a render, and a landing-time check misses
   "Change property" during a held preview - no recreate is pending until the next unit
   loads, so the old result would have reviewed under the next property and its Send gone
   to that property's draft (the same harm; pinned by a test). It also drops a result if
   its draft is replaced after landing.
2. B20 - `useComposerDraft` exposes `key` (inputs on screen) and `draftKey` (inputs the
   current draft was made for; null with no draft, an adopted one, or no message), and
   `canPreview` adds `draftKey === key`. This closes the one render between a change and
   its recreate starting, where Preview was still enabled: a click there would preview a
   draft about to be replaced, which the discard would then drop (an e2e flake risk in the
   resolved-mode flows that click Preview right after the flyer link re-seeds the message).
3. B20 - the freeze is AudienceFilters only, as ruled (`disabled`: voucher chips, the
   picker's input and its chip remove button). The message editor, "Change property" and
   "Add more tenants by filters" stay live; the discard covers them.
4. B21 - "entries in hand" is `entries.length > 0`: `orgListUnknown(list) = loading ||
   (error && entries.length === 0)` (orgCopy.ts:154). A list that loaded EMPTY and then
   failed a re-read reads as unknown - the refusal ("The list did not load - ...") is still
   true of the latest read. No change to `OrgListView`.
5. B21 - while a picker whose list failed holds text, the WHOLE picker is enabled (input and
   chip remove), the composer's existing shape - now `useTypedOrgText.disabled`
   (useTypedOrgText.ts:81). Removing a chip needs no list. After a failed RE-read the
   options and the add step work on the list in hand (the blocked refusal offers "add it as
   new"); with nothing in hand there are no options and no add step (B22's `loading`).
6. B21 - the note under an unknown list keeps B10's "Not saved - the list did not load."
   (true now: Save refuses); the alert after Save is the new `ORG_TYPED_LIST_NOT_LOADED`.
   The refusal now shows under a failed list too, taking the picker's one alert slot from
   the load error while it stands.
7. B21 - two test-only corrections after the first GREEN run (the RED reason is unchanged:
   those tests fail earlier, at `toBeEnabled`): `queryByRole('option')` also matched the
   forms' native `<select>` options, so it is now `queryByRole('listbox')`; the tenant form
   shows two alerts there (the HA refusal and Agency's own load error), so the refusal is
   asserted by its text and aria-describedby.
8. B22 - done as every host passing `loading={orgListUnknown(orgList)}` (the reviewer's
   first option) with the OrgPicker `loading` doc widened, not a new prop; the composer's
   filter too, for one rule.
9. B24 - the e2e spec's `UI.helpText` constant follows the new copy (its substring
   `getByText` matched either way).
10. B25 - the reason is APPENDED to the failed status line, reusing
    `orgErrorMessage('org_rewrite_target_gone')` (Run again's own 409 sentence), so the
    line still names what failed and its counts.
11. `e2e/support/selectors.md` row 122 (doc only) now describes the B21 rule and the B20
    freeze/discard.

Unchanged by this wave, as required: every accessible name and label; the composer's
commit-only-on-pick rule; the tenant form's never-send-unchanged-housingAuthority rule (its
PINs pass); useOrgList (the StrictMode-safe poll) untouched.

## Out of scope, noticed (no change made)

1. `dashboard/src/routes/broadcasts/useComposerDraft.ts:175` - a material change reverted
   within the 600 ms debounce (type a character, delete it) leaves `reachPending` stuck
   true: the intermediate run sets it (:178), its cleanup clears the timer, and the
   reverted run returns early at :175 without resetting it - Preview stays disabled beside
   "Sizing the audience..." until another edit. Same shape for `stale` when the key reverts
   after a failed recreate (cleared only at :207 or by the no-message branch). Pre-existing
   (the merge base has the same early return); B20's `currentPreview` relies on neither flag.
2. `dashboard/src/routes/orgs/OrgPicker.test.tsx:83` keeps its own hint literal "The
   organization that runs the voucher" (a component fixture, not the form's copy) - fine.
