# FW2b report - fix wave 2, dashboard and docs (caseworker integrity)

Implementer: FW2b (Claude Opus 5.5), caseworker-integrity mission,
2026-10-12. Worktree `W:\tmp\caseworker-integrity`, branch
`fix/caseworker-integrity`, from 65637729 (FW2a's report commit). Brief
`.superpowers/sdd/briefs/FW2b.md`; work order `R2-adjudications.md` rows
FW2-5..FW2-10 and "Cameron's rulings on Q4 and Q5" (FW2-13); findings
`R2-dashboard.md` A1, A3-A7; contract: spec revision 5, section 4 "Restore"
and "Contact list (I4)"; FW2a's HANDOFF (no wire shape changed). Findings
only; code is cited by file:line at 5b3e9ade (the last item commit).

Headline: seven item commits plus this report. The one code fix (FW2-5) went
RED for the stated reason before the fix and red again under its revert; each
test-only item's new case was killed by its named mutant; every revert and
mutant was restored byte-identically (sha256 against a pre-edit baseline,
plus an empty `git diff` of the file). No app/ file was edited. No STOP
condition was hit: no item grew past its description, every RED and mutant
failed for the stated reason, and nothing added a mutation surface or a
reader. The gate is green.

## Commits

| Item | Commit | RED (or the mutant that kills the new test) | GREEN | Revert proof |
|---|---|---|---|---|
| FW2-5 (R2D-A1) | aa8164be | before the fix, useListing.test 2 failed / 11: the renderHook case `expected 'loading' to be 'ready'` (`useListing.test.tsx:336`); the page case `expected document not to contain element` = the `role="status" aria-label="Loading"` spinner in place of B's page (`:391`) | useListing.test 11/11; with ListingDetail.test 93/93 | guard at `useListing.ts:168` put back to the unguarded return: the same 2 red at :336 / :391; restored, sha256 86aa248c OK |
| FW2-6 (R2D-A3) | d1d94fdb | test only; mutant M-B (`RestoreLandlordDialog.tsx:64` guard removed, the flag set unconditionally): 1 failed / 11 at `RestoreLandlordDialog.test.tsx:193`, found `<p role="alert">Couldn't load the landlords.</p>` | 11/11 on the branch, three runs | restored, sha256 a9c7c662 OK (= R2's) |
| FW2-7 (R2D-A4) | 667411b5 | test only; mutant M-D (the render-time reset `ListingDetail.tsx:225` replaced by `useEffect(() => setRestoreNeeds(null), [unitId])`, plus the `useEffect` import): 1 failed / 83, the late-409 case - the dialog opened on u2 (`ListingDetail.test.tsx:1599`). Mutant M-C (the reset removed): 2 failed / 83 - the FW-11 case now fails at its u2 check itself (`:1529`, `expected [ 'u1', 'u2' ] to deeply equal [ 'u1' ]`) and the late-409 case | 83/83 on the branch | restored after each, sha256 977bac86 OK (= R2's) |
| FW2-13 (Q5 render) | 565adafa | test only; mutant: the dialog's `onRestored` applies `setUnit(updated)` instead of `applyRosterUnit(updated)` (`ListingDetail.tsx:1427`): 2 failed / 84 - the new case at `ListingDetail.test.tsx:1406` (expected `Dana Reyes (primary)`, received `James Porter (primary)Landlord`: the load-time roster stays) and the existing (PIN) roster case `:1340` | 84/84 on the branch | restored, sha256 977bac86 OK |
| FW2-8 (R2D-A5) | ac099cd6 | comment only (no test) | ListingDetail.test 84/84; eslint 0 | n/a - the diff touches comment lines only; the ruled sentence (`ListingDetail.tsx:542`) is unchanged |
| FW2-9 (R2D-A6) | 87b90fbf | docs | endpoints.test 51/51; eslint 0 | n/a |
| FW2-10 (R2D-A7) | 5b3e9ade | docs | `npm run issues` 0 | n/a |
| report | (this commit) | - | - | - |

Pre-edit baseline (`fw2b-baseline.log`): the four gate files 152/152
(endpoints 51, useListing 9, RestoreLandlordDialog 10, ListingDetail 82). The
three source files hashed equal to R2's mutant baselines (useListing.ts
1bdca179, ListingDetail.tsx 977bac86, RestoreLandlordDialog.tsx a9c7c662).

Logs: `.superpowers/sdd/logs/fw2b-*.log` (30 logs, each run redirected with
its exit code echoed, never piped). Hash baselines:
`.superpowers/sdd/fw2b-start-baseline.sha256` (every touched file before any
edit) and `fw2b-fw25/fw26/fw27-baseline.sha256` (the file under revert or
mutation).

## FW2-5: useListing.setUnit is bound to its unitId

- Fix: `dashboard/src/routes/listing/useListing.ts:168`, the brief's
  one-line form: `return prev.forId === unitId ? { ...prev, status: 'ready',
  unit: applied, forId: unitId } : prev;` (comment `:141-147`). The
  `applied` media merge above it still reads `prev` and is unused when the
  guard declines. Every writer of the page's unit goes through this setter:
  status `ListingDetail.tsx:276`, banner Restore `:375`, `applyRosterUnit`
  `:409` (roster writes `:435`, `:461`; the dialog's `onRestored` `:1427` and
  `onConflict` re-read `:1435`), photos `:648`, `:686`, `:696`, the edit form
  `:1351`.
- Regression tests, `dashboard/src/routes/listing/useListing.test.tsx:303`:
  `:325` (renderHook: the setter held for A, called after the hook moved to B,
  leaves B ready and B's own; positive control: B's own setter still
  applies), `:345` (ListingDetail + RestoreLandlordDialog with the REAL hook,
  API mocked: deleted A, the dialog opens on the plain restore's 409,
  "Restore without a landlord" is left in flight, Back to B (the dialog closes,
  FW-11), A's answer lands -> no Loading spinner, B's heading still shown).
- Issue: `docs/issues/listing-detail-dialogs-survive-property-navigation.md:39`,
  an "Update 2026-10-12" paragraph: the in-flight half is fixed at the root by
  this guard; the open half is the pre-existing "Delete property?" confirm
  (and the other un-reset per-property state) surviving the move. The issue
  stays open; its frontmatter is unchanged.

## FW2-6: the restore dialog's abort guard under StrictMode

`dashboard/src/routes/listing/RestoreLandlordDialog.test.tsx:164`: the dialog
rendered inside `<StrictMode>` with a signal-aware `getAllContacts` mock that
rejects with an `AbortError` DOMException when its signal aborts (as
`dashboard/src/api/client.ts` rethrows it) and otherwise answers on a later
task. It asserts the premise (two reads, signals `[aborted, live]`), that
Nora is offered after typing, and that no `role="alert"` shows (`:193`).

## FW2-7: the late 409, and a u2 check that can fail

- New case `dashboard/src/routes/listing/ListingDetail.test.tsx:1548`: the
  plain restore is left in flight on deleted u1; Back to u2; the 409
  `restore_needs_landlord` lands -> no dialog on u2 (`:1599`); Forward to u1
  -> still none (dropped, not parked); `restoreUnit` called once. The Forward
  step also kills a "hide unless it matches" mutant (render
  `restoreNeeds.unitId === unitId` without resetting), which would show the
  dialog again on u1 - by reading, not run.
- FW-11's case `:1481`: chose MEANINGFUL over removal. It holds the dialog's
  own "Restore without a landlord" button from before the move and presses it
  (`fireEvent.click`) after the move, before the dialog-absence check: under
  FW-11 the button left with the dialog and reaches no handler; with the
  reset removed the same button survives, is bound to the page's current
  property (the dialog's `unitId` prop is `unit.unitId`,
  `ListingDetail.tsx:1423`), and posts `restoreUnit('u2', { landlordId: null })`.
  The mid-test check is now `restoreUnit.mock.calls.map(([id]) => id)`
  toEqual `['u1']` (`:1529`); the final `toHaveBeenCalledTimes(1)` /
  `toHaveBeenCalledWith('u1')` stay. M-D does not kill this case (its effect
  resets at the move, so the button is gone) - the late-409 case kills M-D.

## FW2-13: the restore's promoted sole landlord renders as primary

`dashboard/src/routes/listing/ListingDetail.test.tsx:1348`: a deleted
property with James (landlord of record, primary, re-typed) and Dana (pm, a
contact typed landlord). The plain restore answers 409; "Restore without a
landlord" answers the server's revision-5 shape (no landlordId, James's row
dropped, Dana `primaryContact: true`, `primary_contact: 'pm2'`). Checks: the
dialog closes; the Contacts card's first link reads `Dana Reyes (primary)`
(`:1406`); James is gone; in edit mode Dana's row reads `(primary)`, the card
has exactly one `(primary)`, and there is no "Make Dana Reyes the primary
contact".

## FW2-8: the comment above promotionNotice

`dashboard/src/routes/listing/ListingDetail.tsx:513-534` now states: the
resolvers take the primary row, else the landlord of record; on a property
with neither, routing comes back by (1) a NEW contact typed landlord (a
landlord, property manager or owner, whatever its role) becoming the primary
automatically - other types join non-primary (spec revision 5, Cameron's Q4)
- (2) a contact on the list typed landlord re-roled to Landlord claiming the
empty slot (not made primary; the resolvers fall back to it), (3) otherwise
only Make primary. It records that the ruled sentence names (1) and (3) and
that its "a new contact is added" holds for a new contact typed landlord
only. Checked against `app/src/repos/unitsRepo.ts:901-951` (claim, I3,
auto-primary) and `app/src/routes/units.ts:1180-1192`.

## FW2-9: selectors.md and the addUnitContact doc

- `e2e/support/selectors.md:136`: the dialog's errors are `role="alert"`
  paragraphs and it can hold two at once (`Couldn't load the landlords.` and a
  restore failure, `RestoreLandlordDialog.tsx:130-139`); match one by text,
  `dialog.getByRole('alert').filter({ hasText: <sentence> })`.
- `dashboard/src/api/endpoints.ts:1048-1071`: auto-primary (a NEW seat for a
  contact typed landlord on a property with no primary row and no landlordId,
  spec revision 5; other types join non-primary; render the answer); 409
  `contact_list_caseworker` and 409 `landlord_not_landlord` from the route's
  checks or the roster write (`app/src/routes/units.ts:1180-1192`,
  `:1210-1225`); 404 `contact_not_found` for a missing contact or a routing
  pointer id (`:1159-1162`).

## FW2-10: the Activity row for a restore that changed the landlord

`docs/issues/contact-type-refusal-copy-edge-cases.md:76`, a "Related"
paragraph: Activity reads "Property restored" for every `unit_restored` row
(`dashboard/src/routes/listing/listingFormat.ts:229-230`) although the audit
carries `landlordReplaced` / `landlordCleared` / `primaryPromoted`
(`app/src/routes/units.ts:1799-1806`); a sub line needs new copy AND the
Activity projection to carry the fields - its fixed-key whitelist
(`app/src/routes/units.ts:221`) drops them today.

## Divergences, and why

- FW2-5's two regression cases live in `useListing.test.tsx`, not
  `ListingDetail.test.tsx`: the page case needs the REAL hook and
  `ListingDetail.test.tsx` mocks `useListing` for the whole file.
  `useListing.test.tsx` gained a `useContacts` module mock and `restoreUnit` /
  `getAllContacts` in its API mock (`:8-14`, `:39-40`); its nine existing
  cases are unchanged. The renderHook case adds a positive control (B's own
  setter applies), so a setter that is always a no-op cannot pass.
- FW2-7: the u2 check kept and made falsifiable (held-button press) rather
  than removed. M-C (the reset removed) was applied as a one-line comment in
  place of the statement, equivalent to deleting it.
- FW2-13: this case's `useListing` mock is stateful, mirroring the real
  hook's `setUnit` (replace the unit, keep the load-time roster rows), so the
  page goes live after the restore and edit mode can show (or not) Make
  primary. Placed beside the (PIN) restore-roster case in the first describe.
- FW2-10: appended as a "Related" paragraph, not a fifth numbered item, so
  the issue's title ("four edge cases") stays true; it adds the projection
  fact (the brief said only "new copy"). FW2-5's issue paragraph and FW2-10's
  leave both issues' frontmatter unchanged.
- FW2-9's selectors row names example restore-failure sentences
  (`Only a landlord can be a property's landlord of record.`, `The property
  contacts changed - try that change again.`), both pinned in
  `RestoreLandlordDialog.test.tsx`.

## Gate (bare, from the worktree, at 5b3e9ade)

| Step | Command (short) | Exit | Counts |
|---|---|---|---|
| 1 | `cd dashboard; npx vitest run src/routes/listing/useListing.test.tsx src/routes/listing/ListingDetail.test.tsx src/routes/listing/RestoreLandlordDialog.test.tsx src/api/endpoints.test.ts` (every dashboard test file touched is in it) | 0 | 4 files, 157 passed (endpoints 51, useListing 11, RestoreLandlordDialog 11, ListingDetail 84; baseline 152) |
| 2 | `npm run typecheck` | 0 | all workspaces; the dashboard tsconfig includes `src`, so the tests are checked |
| 3 | `npx eslint $(git diff --name-only --diff-filter=d 65637729..HEAD -- '*.ts' '*.tsx')` | 0 | 6 files (list checked non-empty first), no output |
| 4 | ASCII | - | new files: 0; 9 edited files, added lines vs 65637729: 0 non-ASCII bytes; commit messages 65637729..HEAD: 0 (this report: checked before its commit) |
| 5 | `npm run issues` | 0 | 403 open, 203 closed, 606 total |

DynamoDB Local was not started; no full `npm test`, no e2e, no Docker, no
app/ edit, no AWS variable set.

## Noticed, not fixed

1. `applyRosterUnit` (`dashboard/src/routes/listing/ListingDetail.tsx:407-410`)
   sets `rosterUnit` unguarded. A late answer for property A (a roster
   write, the dialog's `onRestored` or `onConflict` re-read) after a move to
   B replaces B's own `rosterUnit`; the `contactsUnit` unitId guard (`:306`)
   then drops it, and B's Contacts card falls back to the hook's load-time
   `roster` - stale if B had a roster write of its own in between. Narrow
   (A's write in flight across the move AND a roster write on B before it
   lands); by reading, not reproduced. Same class as
   `listing-detail-dialogs-survive-property-navigation`.
2. `deleteBusy` and `rosterBusy` survive a move: a delete or restore in
   flight on A makes B's Restore and Delete confirm no-ops until it settles
   (`ListingDetail.tsx:358`, `:372`), and a roster write in flight on A does
   the same to B's roster actions (`:430`). Pre-existing; by reading.
3. `useListing.ts:236-237` is an orphaned comment ("Apply an updated unit in
   place ...") with no code under it, pre-existing (it carries a non-ASCII
   em dash; not touched).
