# FWF2 report - micro-wave after final review round 2 (caseworker integrity)

Implementer: FWF2 (Claude Opus 5.5), caseworker-integrity mission,
2026-10-13. Worktree `W:\tmp\caseworker-integrity`, branch
`fix/caseworker-integrity`, from 02804b38 (spec revision 7). Brief
`.superpowers/sdd/briefs/FWF2.md`; work order `final-review/adjudications.md`
"## Round 2" (R2-1, R2-4, R2-2, R2-F5, R2-F4, R2-3, R2-5) and
`final-review/FWF-review-dispositions.md` (F7). Findings only; code is cited
by file:line at 28980d2e (the code is final at 9bbf178d; the docs commit
after it changes no code).

Headline: two code commits (R2-1, R2-4), one comment-only commit (R2-2,
R2-F5, F7), one docs commit (R2-F4 and the issue work), plus this report.
Every RED failed for the stated reason before its fix; every revert went red
on exactly its target cases and was restored byte-identically (sha256
against a post-fix baseline). The gate is green. No STOP condition was hit:
no item grew past its description and none contradicted the code.

## Commits

| Item | Commit | RED (before the fix) | GREEN | Revert proof |
|---|---|---|---|---|
| R2-1 | ea518b87 | app `unitsRestoreLandlord.test.ts` 6 failed / 32, each `expected { error: 'unit_roster_conflict' } to deeply equal { error: 'restore_landlord_not_needed' }` (`:258`); dashboard 7 failed / 103: RestoreLandlordDialog 2 (`onLandlordNotNeeded` called 0 times - the code fell through to "Couldn't restore"), ListingDetail 5 (no `getUnit`, the dialog still open, the sentence never shown) | app 32 / 32; dashboard 13 + 90 | app: the 409 code back to `unit_roster_conflict` - the same 6 red, restored, sha256 `714b06eb...` OK; dashboard: five reverts below |
| R2-4 | d97de3c9 | `unitsRepoContactListRules.integration.test.ts` (DynamoDB Local) 1 failed / 6: `expected [ true, undefined ] to deeply equal [ true, true ]` | 6 / 6 | option removed - the same 1 red, restored, sha256 `791ae6b2...` OK |
| R2-2 comment, R2-F5, F7 | 9bbf178d | comments only (diff checked: no non-comment line changed) | - | n/a |
| R2-F4 + issues | 28980d2e | - | `npm run issues` 0 | n/a |
| report | (this commit) | - | - | - |

Dashboard revert proofs for R2-1 - each one Edit, one run of the two listing
files, then restored and checked against `fwf2w-r21-dash-baseline.sha256`
(all OK):

1. The dialog's new branch removed (`RestoreLandlordDialog.tsx:89-93`): 7 red,
   exactly the 2 dialog cases and the 5 page cases.
2. The press-time clear removed (`ListingDetail.tsx:390`): 1 red, "clears on
   the next Restore press".
3. The render-time reset removed (`ListingDetail.tsx:240`): 1 red, "reset by a
   history move".
4. The failed-re-read notice removed (`ListingDetail.tsx:1495`): 1 red, "a
   failed re-read ...".
5. The dialog close removed from the page callback (`ListingDetail.tsx:1484`):
   3 red - the live, still-deleted and failed re-read cases.

Logs: `.superpowers/sdd/logs/fwf2w-*.log` (every run redirected, exit code
echoed, never piped). Hash baselines: `.superpowers/sdd/fwf2w-start-baseline.sha256`
(every file this wave might touch, before any edit) and
`fwf2w-r21-app/r21-dash/r24-baseline.sha256`. Baselines before any edit:
app (the 6-file gate set) 110 passed; dashboard (the 4 listed files) 276
passed (ListingDetail 86, RestoreLandlordDialog 11, ContactDetail 128,
endpoints 51).

## R2-1: the late restore body answers 409 restore_landlord_not_needed

- Route `app/src/routes/units.ts:1784-1791`: in the plain path
  (`!needsLandlord`) a body (`choosesLandlord`) answers 409
  `{ error: 'restore_landlord_not_needed' }` before `units.restore` and the
  `unit_restored` audit (log line unchanged). Route doc `:1738-1748`, inline
  `:1780-1783`. The `unit_roster_conflict` paths are untouched:
  `restoreWithLandlord`'s `RosterWriteConflictError` (`:1858-1860`), still
  pinned by the two "came back live before the write" cases, the
  "landlord changed under the request" case and the two contact-list race
  cases of `app/test/unitsRestoreLandlord.test.ts`.
- Tests `app/test/unitsRestoreLandlord.test.ts:212-264`: FWF-1's six cases
  (no longer deleted / stored landlord typed landlord again / ownerless, x
  `'c-new'` / `null`) expect the new code; unit deep-equal to its
  pre-request clone and no audit row, as before. Comments `:7-11`,
  `:201-211`.
- Dialog `dashboard/src/routes/listing/RestoreLandlordDialog.tsx:36-41`: new
  required prop `onLandlordNotNeeded`; `:89-93`: the code calls it and
  returns - no `setError` (so no `ROSTER_RETRY_COPY`), no `onConflict`.
- Page `dashboard/src/routes/listing/ListingDetail.tsx`:
  - `:195-200` the sentence, `RESTORE_LANDLORD_CHANGED_COPY`, byte-exact
    with spec revision 7 (ASCII apostrophe).
  - `:233-240` page state `restoreNotice: { unitId } | null`, reset during
    render when the route's unitId moves on (the `restoreNeeds` pattern,
    `:231-232`).
  - `:389-390` `onRestore` clears it on every press, after the busy guard.
  - `:1479-1497` `onLandlordNotNeeded`: `setRestoreNeeds(null)` closes the
    dialog, then the best-effort `getUnit` + `applyRosterUnit` (as
    `onConflict`, `:1464-1478`); a still-deleted re-read sets the notice, a
    live one does not; a failed re-read sets it too (divergence 1). Nothing
    calls `restoreUnit`.
- `dashboard/src/api/endpoints.ts:1042-1051`: `restoreUnit`'s doc names the
  new 409 and restates `unit_roster_conflict` per revision 7 (a
  `{ landlordId: <id> }` restore retries a contacts-only race itself).

Where the sentence renders, and why: inside the deleted banner's
`role="status"` region (`ListingDetail.tsx:779`), as a nested `<span>` after
"Its data is retained." within the banner's existing text span (`:780-789`).
There is no restore notice slot, and the brief named this region. The
banner exists only while the page shows the property deleted, so a live page
can never show the sentence. The region is a polite live region, so the
sentence is announced when it appears. The banner is a two-child flex row
with `justify-content: space-between` (`ListingDetail.module.css:78-88`), so a
third child would float between the text and the Restore button; nested in
the text column it needs no CSS change. It is its own element, so
`getByText(<sentence>)` matches it exactly.

Dashboard tests:
- `RestoreLandlordDialog.test.tsx:141-170` (both actions, `it.each`):
  `onLandlordNotNeeded` once, `restoreUnit` calls exactly
  `[['u1', { landlordId }]]`, no `onConflict` / `onRestored` / `onClose`, no
  alert.
- `ListingDetail.test.tsx:1463` (FWF-1's live PIN, converted): the dialog
  closes; the page is live with the re-read's landlord on the Contacts card;
  no sentence and no retry sentence; `restoreUnit` calls exactly
  `[['u1'], ['u1', { landlordId: 'll9' }]]` - the plain press and the one
  choice, no automatic plain restore.
- `:1589` still deleted: the dialog closes, `getUnit('u1')`, `setUnit(fresh)`,
  the banner holds the sentence, no retry sentence, the same two calls.
- `:1618` the next Restore press clears the sentence (that press answers 500,
  so the property stays deleted and only the press can clear it).
- `:1648` failed re-read and `:1672` history-move reset (both extra).
- Unchanged and green: `:1254` (a real `unit_roster_conflict` with a
  still-deleted re-read keeps the dialog - the FWF re-review asked it to stay
  green) and `:1422` (a `unit_roster_conflict` with a live re-read closes it).

Consumers checked: no dashboard code union or error-code list names restore
codes (repo grep); `contactTypeErrorMessage` returns null for the new code;
no e2e spec pins FWF-1's late body (`e2e/tests/dashboard-next/property-roster.spec.ts`
uses the banner by `hasText` substring and the needs-landlord path only).
`e2e/support/selectors.md:136` did not pin it either; see divergence 3.

## R2-4: addContact's re-read after a lost write is consistent

- `app/src/repos/unitsRepo.ts:1018-1021`: the conflict re-read passes
  `{ consistentRead: true }`; the reassignment refusal decided on it
  (`:1027-1033`) is therefore never a lagging replica's.
- Test `app/test/unitsRepoContactListRules.integration.test.ts:229` (FWF-5's
  racing client): an ownerless unit with one PM row; staff B claims the
  vacant slot right after attempt 1's read (raw client, not counted); the
  add's landlord claim loses its no-landlord condition, re-reads and refuses
  `LandlordReassignmentRequiredError`. Asserts 1 write, 1 lost write,
  `unitReads` `[true, true]`, and B's claim stored. Header comment `:16-18`.
- The FakeWorld fake: `unitsRepo.getById(unitId)`
  (`app/test/helpers/twilioWebhookHarness.ts:2839-2841`) takes no options - it
  ignores `consistentRead` and returns the live map object - and its
  `addContact` (`:2944`) is one synchronous read-modify-write with no
  conditional write, no lost-write path and no re-read. Nothing to mirror;
  the harness is unchanged (sha256 against the start baseline OK).

## R2-2, R2-F5, F7 (9bbf178d, comments only)

- `dashboard/src/routes/contact/ContactDetail.tsx:280-294`: FWF-4's close is
  triggered only by `useContact`'s `suggestion.updated` re-read; the
  caseworker conversion emits one; a generic contacts-PATCH re-type usually
  emits none (only when it drains a pending type suggestion), so the review
  can stay open. A `TODO(ha-review-close-name-patch-unfenced):` line points
  at the server fence. The reset itself (`:295`) is unchanged.
- `dashboard/src/routes/listing/ListingDetail.tsx:464-474`: the typed
  contact-list refusals come from the route's no-race pre-checks (an API
  caller, a stale picker) as well as from the roster write; the extra
  re-read is harmless in the no-race case.
- `dashboard/src/api/endpoints.ts:1072-1079` (`addUnitContact`): the revision
  6 auto-primary eligibility - a new seat on a property with no primary row
  and no landlordId, whose contact is typed landlord, not soft-deleted and
  not a routing pointer; any other contact joins non-primary.

## R2-F4 and the issues (28980d2e)

- `RUNBOOK.md:1677`: one caution in the `import:apply` procedure, right after
  "Apply - always dry-run first": read
  `docs/issues/import-bypasses-contact-type-rules.md` before any run (it can
  re-add a landlord that "Restore without a landlord" removed).
- `docs/issues/contact-type-refusal-copy-edge-cases.md`: item 2's FWF-1
  paragraph replaced by FWF-1 + FWF2's behavior (`:58-77`; the loop is
  gone); item 1 gains the round-2 cross-reference for R2-5 (`:34-38`) - item
  1 already says exactly R2-5, so no duplicate; 11 frontmatter refs and the
  moved body refs in items 2-4 and "Related" re-pointed.
- `docs/issues/ha-review-close-name-patch-unfenced.md:41`: the plain re-type
  case appended; 4 moved refs re-pointed, 3 added.
- `docs/issues/auto-routing-changes-not-named.md:41`: R2-3 appended (the
  resolvers do not filter soft-deleted contacts; the I3 claim is type-only);
  6 moved refs re-pointed, 3 added.
- `docs/issues/contact-list-rule-duplication-and-fake-drift.md:45`: R2-4 done;
  `removeContact`'s reads (`unitsRepo.ts:1060`, `:1111`) still eventually
  consistent - pre-existing, untouched by this branch (the branch's diff of
  `unitsRepo.ts` against main has no hunk in `removeContact`); 1 moved ref
  re-pointed, 3 added.
- Every frontmatter `path:line` in the four issues was printed at the tip
  and lands on the cited code. `updated:` is set only where the file uses it
  (contact-type-refusal-copy-edge-cases, already 2026-10-13).

## Divergences, and why

1. R2-1: the sentence also shows when the re-read FAILS - the brief covered
   a still-deleted and a live re-read only. On a failure the page still
   shows the property deleted and the dialog has closed, so without the
   sentence the close would be unexplained; "Choose Restore again" is right
   either way (a live property's plain restore answers 200). Extra test
   `ListingDetail.test.tsx:1648`, revert proof 4.
2. R2-1 tests: "restoreUnit is called exactly once" is asserted as the whole
   call list - on the page `[['u1'], ['u1', { landlordId }]]` (the plain
   press that opened the dialog, then the one choice; nothing after the
   409), in the dialog `[['u1', { landlordId }]]`. The dialog test covers
   both actions; the history-move reset test is extra (the brief stated the
   reset, not a test).
3. R2-1: `e2e/support/selectors.md:136` did not pin FWF-1's behavior (its
   "try that change again" alert is still right for a real contact-list
   race), but it was silent on the new close path, so one sentence names the
   new 409, the closed dialog and the banner sentence. The brief asked for an
   update only if the row pinned the old behavior.
4. R2-1: FWF-1's dashboard live PIN was converted rather than kept: it now
   waits for the Deleted badge to go (the dialog now closes before the
   re-read lands, where FWF-1 closed it after) and adds the no-sentence and
   call-list assertions.
5. R2-2: the comment carries a `TODO(<issue-slug>):` line - the repo's
   convention for an inline registry reference.
6. The bare `git status` before each commit ran in its own call; the
   `MERGE_HEAD` check ran in the same call as the add + commit (unpiped).

## Gate (bare, from the worktree, at 28980d2e)

| Step | Command (short) | Exit | Counts |
|---|---|---|---|
| 1 | app `npx vitest run` unitsRestoreLandlord, unitsRepoRestoreWithLandlord.integration, unitsRepoRoster.integration, unitsRepoAutoPrimary.integration, unitsApiRosterTypeChecks + touched unitsRepoContactListRules.integration | 0 | 6 files, 111 passed (baseline 110 + 1): 32, 18, 17, 15, 23, 6; DynamoDB Local suites ran (no SKIPPED) |
| 1b | extra: app unitsSoftDelete, unitsApiRoster, unitsApiRosterAutoPrimary (the other restore-route / roster suites) | 0 | 3 files, 48 passed: 4, 25, 19 |
| 2 | dashboard `npx vitest run` ListingDetail, RestoreLandlordDialog, ContactDetail, endpoints (all four touched or listed) | 0 | 4 files, 282 passed (baseline 276 + 6): 90, 13, 128, 51 |
| 3 | `npm run typecheck` | 0 | all 5 workspaces, 0 TS errors |
| 4 | `npx eslint` on `git diff --name-only --diff-filter=d 02804b38..HEAD -- '*.ts' '*.tsx'` | 0 | 10 files (list checked non-empty), no output |
| 5 | ASCII: `git diff -U0 02804b38 -- <16 touched files> \| grep '^+' \| tr -d '\11\12\15\40-\176' \| wc -c` | - | 0; commit messages 02804b38..HEAD: 0; this report: checked before its commit |
| 6 | `npm run issues` | 0 | 407 open, 203 closed, 610 total; no warnings |

No `[dynamoAdmin]`, SKIPPED or ENOBUFS line in any log; no `AWS_*` variable
in the environment; DynamoDB Local was reachable and not started, stopped or
touched otherwise (no Docker command); no full `npm test`, no e2e; no
background command left running. The only stderr in the dashboard runs is
the pre-existing act() warnings of the two synchronous sentence tests in
`RestoreLandlordDialog.test.tsx` (`:56`, `:66`).

## Noticed, not fixed

1. The FWF re-review suggested a seventh app late-body state - the stored
   landlord typed landlord but SOFT-DELETED (the plain path applies to it).
   Not added: the brief named FWF-1's six cases. It takes the same
   `!needsLandlord` branch (`units.ts:1771-1784`).
2. The plain restore's landlord check (`units.ts:1773`) and
   `requireLandlordContact` still let a soft-deleted landlord-typed contact
   through (FWF "Noticed, not fixed" 2; adversarial A4's last bullet).
3. The page's still-deleted check before setting the notice
   (`ListingDetail.tsx:1488`) cannot be killed through the UI: the sentence
   renders only inside the deleted banner, so an unconditional set shows
   nothing on a live page. Kept so a live re-read leaves no hidden state.
4. Open issues outside this wave's edit set cite lines this wave moved, and
   were not re-pointed (some were already stale before it):
   `import-bypasses-contact-type-rules` (`unitsRepo.ts:1331`, now `:1334`),
   `restore-without-landlord-can-leave-nobody-reachable`
   (`ListingDetail.tsx:542`, `RestoreLandlordDialog.tsx:122`,
   `unitsRepo.ts:1292`, `:1303`), `listing-detail-dialogs-survive-property-navigation`
   (`ListingDetail.tsx:214`, `:225`, `:407`, `:1425`),
   `property-card-409-settle-dead-code` (`ListingDetail.tsx:387`),
   `modal-footers-do-not-stack-at-phone-width` (`ListingDetail.tsx:1307`,
   `:1392`), `unit-voucher-size-readers-diverge` (`ListingDetail.tsx:752`,
   `:755`), `contact-page-late-async-writes` (`ContactDetail.tsx:666`, `:694`),
   `inbox-restore-shows-row-read-after-mark-unread-jump`
   (`ContactDetail.tsx:399`), and the deferred
   `extraction-skip-reason-not-rendered` (`ContactDetail.tsx:968`).
5. `contact-type-refusal-copy-edge-cases`' "Related" paragraph still cites
   `listingFormat.ts:229-230` for the "Property restored" label, which is at
   `:228` (FWF "Noticed, not fixed" 4; drift from before both waves).
6. FWF re-review F6 stands: a plain restore of a LIVE property still writes
   a second `unit_restored` row (`units.ts:1802`; predates the branch).
7. After the still-deleted close, the next Restore press sends the plain
   restore, which restores with the stored landlord (a landlord again) - the
   staff member's earlier pick is not applied. That is the ruling (no
   automatic choice either way); the sentence asks for the press.
