# FW-B report - code review round 1, dashboard fix wave (B1-B9)

- Implementer: FW-B (Claude Opus 5.5), 2026-10-07. Worktree `W:/tmp/clean-org-names`,
  branch `feat/clean-org-names`.
- Range: after 579ae6c2 (FW-A report) through 55f1294d - 11 commits: one per item, plus
  B9's issue resolution as its own docs commit (so it can name the fix hash) and the
  `addOrg` doc comment FW-A flagged. Tree clean after the last commit (this report is the
  only untracked file). Nothing left running. `app/` untouched; e2e not run.
- Every item test-first: the new tests were run RED on the pre-fix code and failed for the
  reason the finding states, then GREEN. Logs: `.superpowers/sdd/fwb-*.log`.
- Commit checks every time: bare `git status` as its own command, no MERGE_HEAD, explicit
  paths only, ASCII message with the `Co-Authored-By: Claude Opus 5.5` trailer (11/11).
  Added lines in 579ae6c2..HEAD: 0 non-ASCII. No new files.
- Baseline before any edit: the 11 affected dashboard suites 183/183 (exit 0).

## Per item

| item | commit | RED (one line) | GREEN | fast gates (exit) |
|---|---|---|---|---|
| B1 | 977d092c fix(dashboard): text typed in an org picker is never dropped silently on Save | 21 failed / 110 passed (5 files): forms sent no `housingAuthority` / no `accepted_authorities` (UnitCreateForm "DCA" body `{landlordId, beds: 2}` - the finding's case), no alert; `settleTypedOrgText is not a function`; callback never called; no note; handle no-op; no re-open. PINs green | 5 files 131/131 | fallout (orgs, settings, broadcasts, contact, listing, listings) 119 files 2157 (0); typecheck 0; eslint 10 files 0 |
| B2 | 1820ca90 fix(dashboard): an org picker closes its list when focus leaves the field | 2 failed / 20 passed: listbox still in the document after Tab; list mousedown not prevented (option-click PIN green) | OrgPicker 22/22 | fallout 119 files 2160 (0); eslint 0 |
| B3 | 62ae0917 fix(dashboard): Settings judges a rewrite's heartbeat on the server's clock | 4 failed / 28 passed: browser 20 min fast -> `rewriteLive` false, status not "Updating records"; 20 min slow -> `rewriteLive` true, no "An update stopped responding" | 2 files 32/32 | settings + orgs + serverClock 26 files 332 (0); eslint 0 errors |
| B4 | 031b8da3 fix(dashboard): a Settings poll never aborts its own list read | 2 failed / 9 passed: reads 60 ms, pollMs 25 -> `expected 'running' to be 'done'` after 5 s (plain and StrictMode) | useOrgList + useOrgAdmin 16/16; useOrgAdmin re-run x2 green | mutation (poll without the skip): 3 failed / 13 passed; fallout 119 files 2167 (0); typecheck 0; eslint 0 errors |
| B5 | 4401fb11 fix(dashboard): Edit spellings' Save keeps a typed spelling and skips an unchanged PATCH | 4 failed / 23 passed: PATCH `{spellings: ['AHA']}` with "ATL HA" typed; unchanged Save still PATCHed | OrgListSection 27/27 | settings + orgs 25 files 324 (0); eslint 0 |
| B6 | 25ac0753 fix(dashboard): a name used from "Is this really new?" never reads Not on the list | 4 failed / 86 passed (3 forms): chip text contains "Not on the list" after "Use Metro Housing Authority" / "Put it in Agency" | 4 files 95/95 | fallout 119 files 2175 (0); typecheck 0; eslint 0 |
| B7 | 4d0bc749 fix(dashboard): "Is this really new?" re-checks a name edited back to its starting text | 1 failed / 15 passed: no /check for "Metro Housing" after X + Backspace (last call stays "Metro HousingX"; stuck "Checking the list...") | NewOrgDialog 16/16 | every dialog host (orgs, settings, contact, listing) 107 files 1971 (0); eslint 0 |
| B8 | 305020ad fix(dashboard): a settle confirm counts every row the rewrite reaches | 1 failed / 15 passed: confirm said "(3 records)" for "rook junk" beside "Rook Junk" (2 +1 deleted) and "Rook-Junk" (1) | NotOnListSection 16/16 | settings + orgs 25 files 326 (0); eslint 0 |
| B9 | 6435dd26 fix(dashboard): a Settings Add clears a notice an earlier action left | 1 failed / 27 passed: the "Not kept as a spelling" `<p>` still in the document after Add | OrgListSection 28/28 | settings 21 files 258 (0); eslint 0 |
| B9 docs | 2c203b70 docs(issues): resolve org-settings-notice-stale-after-add (fixed by 6435dd26) | n/a | `npm run issues` 0: 370 open / 197 closed / 567; row shows resolved (INDEX.md gitignored, not staged) | ASCII 0 |
| comment | 55f1294d docs(dashboard): addOrg names the 409 org_rewrite_running an add can now meet | n/a (comment) | - | eslint 0 |

## Final gates (after the last commit)

- dashboard workspace `npx vitest run`: 222 files / 3914 tests, exit 0 (3871 at the S11
  slice gate + the 43 new tests).
- e2e workspace `npx vitest run performance`: 17 files / 473, exit 0.
- `npm run typecheck`: exit 0 (dashboard tsconfig includes the test files).
- Gate 5 preview: `npx eslint` on the 23 `.ts/.tsx` files touched 579ae6c2..HEAD: exit 0,
  0 errors, 1 warning - `useOrgAdmin.ts:130` "Unused eslint-disable directive", the U12/U13
  plan-code warning, present at 579ae6c2 as `:121` (re-linted via `git show | --stdin`).
  None of the S17 baseline errors sit in files this wave touched.

## What changed, and every divergence / decision

B1 (R1-ADV-FE-1).
1. OrgPicker: `onPendingTextChange` (raw text on every change; '' after a pick, a clear, an
   emptied input, or `clearText()`), the note `ORG_TYPED_NOT_SAVED` under a field that lost
   focus holding non-blank text (`aria-describedby` = hint, note, error), class
   `.pendingNote` (amber token). Copy `ORG_TYPED_NOT_SAVED` / `ORG_TYPED_BLOCKED` in orgCopy.ts.
2. Addition the ruling implies but does not name: an imperative handle `OrgPickerHandle
   { focus(), clearText() }` passed as the React 19 `ref` prop. Why: the typed text is the
   picker's local state, so the form needs a way to focus the refused input ("focus its
   input") and to empty the text it committed (else a failed save would leave the committed
   text in the input under a misleading "Not saved" note).
3. Resolver `settleTypedOrgText(entries, kinds, text)` in orgCopy.ts (pure, 4 unit tests):
   blank = nothing typed; exactly one NAME match (normalized) wins; else exactly one entry
   carrying the spelling; anything else blocks (2+ name matches block, never falling
   through to spellings; text normalizing to '' such as "()" blocks).
4. A chip removal ("a clear") now takes half-typed text with it, so its '' report is true.
5. Addition beyond the letter: focusing the field again re-opens its list for the text it
   holds (pinned). It is what makes the guard's focus useful ("AHA" shows Atlanta and
   Augusta again under the alert).
6. Forms: Save computes the settled values locally (buildPatch/buildBody take them as an
   argument - state updates are async) and also sets them in state as a pick would, clearing
   a 422 field message the same way. Block alert = the picker's existing `error` prop
   (role="alert"), precedence blocked > 422 message > load error; it clears on any change
   of that picker's text. Tenant form: both pickers settled each Save, resolvable ones
   committed even when the other blocks, focus to the first blocked (HA, then Agency);
   typed state reset when the type leaves tenant (the pickers unmount). Unchanged values
   stay off the wire (PIN tests: tenant HADC over a stored DeKalb; property list already
   holding the typed name -> "nothing changed", closes).
7. Test rewritten: ContactEditForm.test.tsx "typing alone changes nothing: Save just
   closes" pinned the bug itself; it is now "typed text is never dropped silently: part of
   a name stops Save and the picker says why" (the unknown/partial case).
8. Enter: not driven in the form tests (user-event's implicit submit via a `form=`-linked
   button outside the form is unreliable in jsdom); OrgPicker's existing test still pins
   "Enter with nothing highlighted submits", and the guard runs in onSubmit.
9. Docs that said "typed text is never committed" updated (comments/markdown only):
   `e2e/scenarios/steps.ts` (pickOrgName doc, New property step), `e2e/support/selectors.md`
   Property-form row. Labels and accessible names unchanged.

B2 (R1-ADV-FE-2). Blur dismisses unless `relatedTarget` is inside the list, and resets the
highlight. Addition: the listbox `ul` preventDefaults mousedown, so a press on its scrollbar
or padding keeps focus in the input (without it B2 would close the list on a scrollbar drag;
Chrome's focusable scrollers make the `relatedTarget` check alone insufficient). Pinned.

B3 (R1-ADV-FE-4). Only the call sites pass `serverNowMs()` (useOrgAdmin `isRewriteLive`;
OrgListSection status text and `canRunAgain`); the orgCopy defaults stay `Date.now()`.
Tests skew the clock with `noteServerDate` and reset it in `afterEach`.

B4 (R1-ADV-FE-5). Chose "skip a tick while one is in flight": `useOrgList.poll()` (new
`OrgListState` member), `load()` releases its slot in `finally` only while it still owns it
(StrictMode-safe), `reload()` unchanged (aborts to start afresh after an action). The
StrictMode test stays green; a StrictMode variant of the slow-read test was added, plus a
direct `poll()` pin in useOrgList.test.tsx (written after the fix, so proven by mutation).

B5 (R1-ADV-FE-6). One fold rule (`withDraft`) shared by Add and Save. A list that grew at
Save is sent WITHOUT `confirmShared` even from "Save anyway" (that spelling was never
confirmed; the server asks again). Unchanged -> `onClose` without a PATCH (the NotesDialog
pattern).

B6 (R1-ADV-FE-7). `noteAdded` takes an `OrgRef`; a bare ref becomes a provisional entry
(no spellings, empty timestamps) until a read returns the server's copy. Every "Use" also
triggers one list re-read, even when the name was already in the form's list.

B7 (R1-ADV-FE-8). Skip condition `checked?.name === trimmed`; effect deps now
`[kind, trimmed, checked, attempt]` (`text`, `initialCheck` no longer read there). Side
effect: a name returned to one whose check already landed skips a redundant /check.

B8 (R1-ADV-FE-9). Wording: "6 records (+1 deleted), written as Rook Junk, rook junk or
Rook-Junk"; a row with no sibling keeps "(N records)" (PIN). Computed from the live `rows`
prop; same field only.

B9 (R1-CONF-2). `setNotice(null)` in the Settings `onAdded`. Two commits instead of one so
the Resolution paragraph names the fix hash (the dispatch allowed it riding along).

## Out of scope, noticed (no change made)

1. The pickers inside the Settle dialog ("Name to use", Split) get the blur note but no
   Save guard; nothing is silently saved there (the confirm needs a pick).
2. `dashboard/src/routes/settings/useOrgAdmin.ts:130` - the pre-existing unused
   eslint-disable warning (plan code) is still there.
3. e2e not run by this wave: the B1/B2 picker changes touch every org-picker spec flow
   (org-lists, contact-detail, the New property step); I found no spec that types and saves
   without picking, so none should change outcome - the orchestrator's e2e gate decides.
