# Micro-wave 3 - report (feat/matching-blast-rules)

- Scope: the FIX rows of `fw2-adjudications.md` (FW2-1, FW2-2, FW2-4,
  FW2-5, FW2-6, FW2-7; FW2-8 was the orchestrator's spec clarification) and
  the FILE row FW2-3. Requirement: spec revision 7 D3 Timing, plan AR44.
  Evidence: `fw2-review.md` (same folder). Base 8f651ecf.
- Abbreviations: BC / BCT = `dashboard/src/routes/broadcasts/BroadcastComposer.tsx`
  / its test; AF / AFT = `AudienceFilters.tsx` / its test (same folder);
  SPEC = `e2e/tests/dashboard-next/matching-blast-rules.spec.ts`. Lines at
  the final commits.

## Commits

| Commit | Items |
|---|---|
| 6636816c | fix(dashboard): FW2-1, FW2-2, FW2-6, FW2-7 (BC, BCT, AF, AFT) |
| 104d4083 | test(e2e),docs(selectors): FW2-5, FW2-4 (SPEC, `e2e/support/selectors.md`) |
| 07cdafef | docs(issues): FW2-3 filed |
| this one | docs(records): this report |

Unit RED, both test files at once: 6 failed / 102 passed of 108, each for
its stated reason (below). Unit GREEN: 108 / 108.

## FW2-1 - no Preview hint or spinner while a failure hold shows (6636816c)

- Code: `heldOnFailedRead = prefillNotices.length > 0` (BC:252-256; every
  notice implies a hold, review section 2). The Spinner renders only on
  `draft.reachPending && !heldOnFailedRead` (BC:839); the whole hint chain
  is guarded by `!heldOnFailedRead` (BC:848); the comment at BC:840-847
  replaces the "settling draft/reach is transient" claim. The reach line
  stays pending (AR44). The hint line holding U+2026 (BC:854) is untouched.
- Judgment call: "no remedy hint" is read as the WHOLE chain, including the
  typed-text hint `Pick the housing authority from the list, or clear the
  text.` - clearing typed text does not end a hold either, and the picker's
  own note under the field still says what typed text is. Tested.
- Tests: helper `expectNoPreviewHint` (BCT:850-859: the three hint strings
  absent, no `role="status"` named `Loading`); the property-load hold test
  (BCT:994) checks it before typing, after typing a message and after typing
  `Atl` in the picker; a new list-hold test (BCT:1034) checks it with the
  prefilled message, after typing and with the message emptied. PINS that
  normal settling keeps both (green before and after): BCT:976-979 (list
  still loading) and BCT:1063-1065 (aborted property load) assert `Sizing
  the audience` and the Loading spinner.
- RED: list test - `expected document not to contain element, found <span
  class="_previewHint_277b38"> Sizing the audience... </span>` (U+2026
  shown as "...") at `expectNoPreviewHint`. The property test first stopped
  on its FW2-2 line, so the FW2-1 check was ordered first and that test
  re-run alone (1 failed / 78 skipped): `expected document not to contain
  element, found <span ...> Write a message to enable the preview.`
- GREEN: 108 / 108.

## FW2-2 - the hold notices are alerts (6636816c)

- Code: the notice paragraph carries `role="alert"`, its Try again inside
  (AF:236-240), as the compose step's 503 alert does.
- Tests: AFT:324 - both notices found with `getAllByRole('alert')`, exact
  `textContent` `<notice> Try again`, an enabled Try again inside each;
  BCT:1002 - the property notice IS the page's alert; BCT:1019-1024 - the
  list hold shows two alerts, the picker's `Couldn't load housing
  authorities` first and the notice second. That last test used a single
  `getByRole('alert')`, which the new second alert breaks (the review's
  reason to suggest `status`); the orchestrator ruled `alert`, so the test
  now reads both.
- RED: AFT:324 `Unable to find an accessible element with the role
  "alert"`; BCT list hold `expected [ <p id="_r_4a_-error" ...(2)></p> ] to
  have a length of 2 but got 1`; BCT property hold `Unable to find an
  accessible element with the role "alert"`.
- GREEN: 108 / 108. No other test reads a single alert during a hold (the
  broadcasts folder is green, below); SPEC reads the notice by
  `getByRole('alert').filter({ hasText })`.

## FW2-7 - one period after a name that ends with one (6636816c)

- Code: `unusedNote` appends the period only when the joined names do not
  already end with one (AF:154-157, rendered AF:232); `authorityPrefill.ts`
  trims each name, so this is "the last name ends with a period".
- Tests: AFT:301 (plain note), AFT:313 (with ` This blast is not limited
  by housing authority.`).
- RED: both `Unable to find an element with the text: ...`; the DOM dump
  showed `Not used (not on the organization list): Nowhere Board, Housing
  Auth. of Fulton Co..` and `... Housing Auth. of Fulton Co..` (two periods).
- GREEN: 108 / 108.

## FW2-6 - "read once" comments (6636816c)

- BC:156-159 and AF:61-64 as named, plus a THIRD comment making the same
  claim, AF:127-130 (not in the review's list; same defect, comment-only):
  the list is read once per mount and again only by a failed read's Try
  again. Spec D3 (`...-design.md:325`, "the composer reads it once per page
  load") was left alone: it describes a SUCCESSFUL read (the stale-list
  case), which is still never re-read.
- RED / GREEN: n/a (comments).

## FW2-4 - selectors.md (104d4083)

- Row :134 (Org pickers, text typed but never picked): `each loaded or
  failed` becomes "the property loaded and the organization list loaded";
  a failed property load, or a failed list read while the property accepts
  a housing authority, HOLDS - no draft, Preview disabled, a `role="alert"`
  notice with `Try again` - pointing at the Matching composer row.
- Row :148 (Matching composer; an addition for FW2-1/FW2-2): no hint and no
  spinner beside Preview, the notice is `role="alert"`, read with
  `getByRole('alert').filter({ hasText: <sentence> })` because the picker's
  own list-error alert can show beside it, and SPEC drives the list hold.
- Check: `grep -n "loaded or failed" e2e/support/selectors.md` - no match.

## FW2-5 - an e2e for the hold (104d4083)

- SPEC:377, one new test: a run-unique authority (`addOrg`) and an Available
  property accepting it (`createUnit`); `page.route` on pathname
  `/api/organizations` answers a GET with 500 while a FLAG is set (SPEC:390;
  StrictMode may abort and resend the first read); every POST
  `/api/broadcasts` is recorded through `page.on('request')` with its
  `housing_authorities`. On `/broadcasts/new?unitId=`: the alert with
  LIST_HOLD and its Try again, `Preview recipients` disabled, the message
  prefilled; then it outlasts the 600 ms create debounce
  (`waitForTimeout(1_500)`, the `org-lists.spec.ts:394` precedent) and
  asserts no create (SPEC:420), Preview still disabled and no `Sizing the
  audience`. Flag cleared, Try again: the chip `Remove <name>`, the alert
  gone, a create carrying exactly `[<name>]` (`waitForRequest`), Preview
  enabled, and every recorded create carried `[<name>]`.
- RED by mutation (AR11): SPEC:420 `.toEqual([])` flipped to
  `.not.toEqual([])`. Run `mw3-red`: EXIT:1, 1 failed / 1 passed -
  `Error: no draft is created while the prefill is held` /
  `expect(received).not.toEqual(expected) // deep equality` /
  `Expected: not []` at SPEC:420:72, after every earlier hold assertion had
  passed in the real app. Restored with Edit; `git diff --no-index
  --exit-code` against the pre-mutation copy: exit 0; sha256
  d30fc7f79a72af6dcb3fd9db82c47bd5a3413692bc52016136c2b892507f4107 for both.
- GREEN, run `mw3-green`: EXIT:0 - `ok 1 ... matching-blast-rules.spec.ts:190:1
  ... (6.7s)`, `ok 2 ... matching-blast-rules.spec.ts:377:1 ... (4.1s)`,
  `2 passed (21.7s)`. No blank-page sighting in either run.

## FW2-3 - filed (07cdafef)

- `docs/issues/matching-enable-filters-keeps-one-tenant-message.md` (bug,
  low, open, area dashboard/broadcasts; pre-existing on main at
  `BroadcastComposer.tsx:317-318`), from the review's FW2-3 / I12 evidence,
  with the suggested fix and its regression test. `npm run issues`: exit 0
  (428 open, 638 total; the slug is in the gitignored INDEX.md).

## Verification after GREEN

- Dashboard broadcasts folder (`npx vitest run src/routes/broadcasts`):
  16 files, 324 tests passed (4 new: AFT 3, BCT 1), exit 0.
- `npm run typecheck`: exit 0 (app, dashboard, e2e, fake-twilio,
  fake-twilio-web).
- ESLint (JSON) on the 5 touched `.ts`/`.tsx` files: 2 errors, both the
  pre-existing `react-hooks/set-state-in-effect` in BC, now BC:419 and
  BC:438 (were :414 and :433; +5 lines from BC:252-256). Per-rule compare
  against 8f651ecf (`.superpowers/gates/lint-compare.mjs`): head 2, base 2,
  branch-attributed 0. AF, AFT, BCT and SPEC: no message.
  `useComposerDraft.ts` was not touched (its one `react-hooks/refs` error is
  unchanged by construction).
- ASCII: no non-ASCII on any added line; the new issue file and SPEC are all
  ASCII.

## Surprises

- `e2e/.artifacts/session.pid` (PID 65160, written 09:48) is stale: no such
  process, no node process from this worktree, no listener on the lane's
  ports 10001 / 10011 before either run. Left in place (not this wave's).
- The red run's screenshot and video were deleted when the green run
  started (Playwright cleans its output folder); the log lines quoted above
  are the RED evidence.
- Both runs log `[vite] http proxy error: /__dev/ping ... ECONNREFUSED
  127.0.0.1:10001` at boot: the harness probing before the app listens
  (benign; both runs then passed or failed only where stated).

## Not done

- Nothing in scope. The five gates are the orchestrator's, once, on this
  wave's final commit.
