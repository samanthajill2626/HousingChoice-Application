# Drift check - S8 dashboard + e2e perf mutation catalog (findings)

- Date: 2026-10-01. Reader: read-only S8 drift reader (Phase 1 research).
- Tree: W:\tmp\tour-auto-close, branch feat/tour-auto-close; code == main @ae04122d
  (HEAD f319a306 adds docs only). Every anchor below was located BY NAME in the
  live tree; line numbers are the live ones.
- Plan checked: section S8 (plan lines 1390-1684) + the S8 rows of section 1.
  Spec checked: sections 3 (Dashboard), 9, 10, 12.
- Byte-exact quotes for every site cited here:
  `.superpowers/sdd/research/ref-s8-dashboard.md` (gitignored reference).

Verdict: 18 plan corrections, 0 STOP findings. Every S8 task is buildable as
written once the corrections below are applied; most are traps that turn a
gate red (typecheck / lint) or silently drop coverage, not design changes.

## 1. Plan corrections

Format: plan says -> tree has -> instruction becomes.

1. [S8 preamble] Plan: dashboard tests pin Date in "`test/setup.ts`".
   Tree: the file is `dashboard/src/test/setup.ts:32-36` (registered at
   `dashboard/vite.config.ts:136`); the pin is a bare `vi.setSystemTime`
   (2026-07-01T12:00:00Z, Date only, timers stay real) at module load AND in a
   global beforeEach. Instruction: cite that path. Only a test that needs fake
   TIMERS calls `vi.useRealTimers()` then `vi.useFakeTimers()` (precedent
   `useTodayPastTours.test.tsx:167-168`); none of the reopen / Outcome-card
   tests need fake timers. Build fixtures against the pinned now - makeTour's
   default scheduledAt 2026-07-10 is in the FUTURE under the pin
   (`TourDetail.test.tsx:578-581`).

2. [8.1] Plan: match `request`'s option names by mirroring `createTourRelay`
   or `cancelPendingRosterAction`. Tree: `cancelPendingRosterAction` does not
   exist; `createTourRelay` (`endpoints.ts:2699-2724`) uses
   `requestWithStatus`, not `request`. The JSON-body option of `request` is
   `body` (`client.ts:37-49`, serialized with Content-Type set). Instruction:
   mirror `createTour` (`endpoints.ts:2204-2218`, `{ method: 'POST', body }`)
   or `cancelTourRosterAction` (`endpoints.ts:2490-2497`, `{ method: 'POST' }`).
   The plan's `reopenTour` block (`method: 'POST', body: {}`) is valid as
   written; S6's route reads `req.body ?? {}` (plan line 1324).

3. [8.1] Plan: export `reopenTour` through `api/index.ts` "if that file lists
   exports explicitly". Tree: `index.ts:3` and `:5` are `export *` from
   types / endpoints. Instruction: no index.ts edit; `reopenTour` and
   `StaffTourOutcome` flow through the barrel.

4. [8.1] Plan: remove the now-unused `TourOutcome` imports. Tree confirms one
   use each: `endpoints.ts:77` (used only at `:2674`), `TourDetail.tsx:43`
   (only `:532`), `TourModals.tsx:23` (only `:286`). Instruction: in the SAME
   edit each of the three files must ADD `StaffTourOutcome` to its import
   (endpoints.ts type list `:6-88`; TourDetail.tsx `:29-46`; TourModals.tsx
   `:23`). A dead import is invisible to `npm run typecheck`
   (`tsconfig.base.json` has no noUnusedLocals); only gate 5 catches it
   (`@typescript-eslint/no-unused-vars` is an error, `eslint.config.mjs:32-40`).

5. [8.1] Plan: fix `patchTour`'s doc. Tree: the doc is `endpoints.ts:2665-2668`
   and its first line carries a non-ASCII em-dash. Instruction: every
   rewritten doc line must be ASCII (an edited line is an added line).

6. [8.2] Plan: `tourReopen.test.ts` runs "the same table as Task 1.3", which
   includes `autoClosedFrom: 'canceled'`. Tree: once 8.1 types
   `autoClosedFrom?: 'scheduled' | 'toured' | 'no_show'`, a `Tour` literal
   carrying 'canceled' fails `npm run typecheck` - `dashboard/tsconfig.json:12`
   includes all of `src`, so test files are typechecked. Instruction: build
   that row (and any other off-union value) with a cast
   (`{ ... } as unknown as Tour`).

7. [8.3] Plan: optional props `canReopen?: boolean` and `onReopen?: () => void`.
   Tree: items fire through `run(fn: () => void)` (`TourActionsMenu.tsx:91-94`),
   so `run(onReopen)` does not typecheck. Instruction: render the item only
   when `canReopen && onReopen !== undefined` (or default `onReopen` to a no-op
   in the destructure, `:44-59`), and add `!canReopen` to the null check
   (`:81-89`).

8. [8.3] Plan: "Update the file header's action list." Tree: the header
   (`TourActionsMenu.tsx:1-8`) already omits "Send no-show check-in"
   (pre-existing drift), and the null-check comment (`:79-80`, "a closed tour
   with a group has no branch actions") becomes false for a convertible closed
   tour. Instruction: rewrite the header list in full (incl. Reopen) and reword
   `:79-80`. Keep `:106-109` (a literal `'\u22EF'` escape) out of every Edit
   old/new string - the Edit tool decodes `\u`.

9. [8.4] Plan: RED in "TourDetail.test.tsx or a new TourModals.test.tsx if one
   exists for other modals". Tree: no TourModals.test.tsx exists; every tour
   dialog is tested through the page in TourDetail.test.tsx (Cancel
   `:459-470`, Mark already toured `:486-569`, Book / Reschedule / Record
   outcome `:683-796`). Instruction: write the ReopenTourModal and 8.4b cases
   page-level in TourDetail.test.tsx (the default), or create ONE new
   TourModals.test.tsx that renders the dialogs directly with vi.fn props;
   never split one dialog's cases across both files.

10. [8.4b] Plan: bind the error in each catch and branch on
    `err instanceof ApiError && err.status === 409`. Tree: TourModals.tsx
    imports no `ApiError` (`:23` imports only `type TourOutcome`); the four
    catches are binding-less `catch {` at `:86-89` (DateTimeModal,
    `setError(errorText)`; Book copy `:150`, Reschedule copy `:167`),
    `:220-223` (Mark already toured), `:303-306` (Record outcome), `:377-380`
    (Cancel). Instruction: add the VALUE import `ApiError` from
    '../../api/index.js' and bind `catch (err)`. A 409 test for Book /
    Reschedule must submit an ORDINARY time (future, under 14 days - the file's
    `localDatetime(2 * DAY)`, `TourDetail.test.tsx:672-681`); a past or far
    time raises the odd-time warning first (also `role="alert"`,
    `TourModals.tsx:123-127`) and no PATCH is sent.

11. [8.4b] Plan: update the TourModals header (`:1-21`). Tree: `:1` says "the
    five small input dialogs" (six with Reopen); the onConfirm contract
    paragraph is `:18-21`; `:7` carries a non-ASCII em-dash. Instruction: say
    six, add the Reopen bullet and the shared 409 rule to `:18-21`; ASCII on
    any edited line.

12. [8.5] Plan: the "Closed automatically on <date>" line uses "the file's KV
    / text styling". Tree: `KV` renders k and v as two spans
    (`contact/Card.tsx:134-160`), so a KV split defeats the plan's own
    `getByText('Closed automatically on <date>')`-style assertion.
    Instruction: render ONE element - e.g. `<p className={styles.subtle}>`
    (`.subtle` exists at `TourDetail.module.css:218-221`, unused by
    TourDetail.tsx today) or `<EmptyRow>`. `shortDate`
    (`placementsFormat.ts:114-119`) formats in LOCAL time as "Jul 15" (no
    year) and vitest sets no TZ: use a midday-UTC `autoClosedAt` fixture
    (precedent `ToursPage.test.tsx:536`).

13. [8.5] Plan: "with the client mocked the way the file already mocks
    patchTour". Tree: the barrel mock is `...actual` plus per-function
    overrides (`TourDetail.test.tsx:50-76`), so an un-overridden `reopenTour`
    would run the real fetch. Instruction: add `const reopenTour = vi.fn();`
    beside `:41` and `reopenTour: (...a: unknown[]) => reopenTour(...a),` in the
    factory (the global `vi.clearAllMocks()` at `:223` resets it). The modal
    union to extend is the inline `useState` generic at `TourDetail.tsx:273-275`
    (no named type). `TourDetail.tsx:638` holds a literal `'\u2190'` escape just
    above the CTA / kebab render (`:648-667`) - keep it out of Edit strings.

14. [8.6] Plan: header comment at `ToursPage.tsx:25-29`. Tree: the Closed
    paragraph is `:26-30` (`:25` is a bare `//`); `:26` - the "status closed
    (terminal)" line - carries a non-ASCII em-dash. Instruction: the rewritten
    line must be ASCII.

15. [8.6 / 8.7] Plan rewrites only the `useTours.ts:10-12` header. Tree: the
    `ClosedToursState` / `useClosedTours` docs at `useTours.ts:108-118` also
    say "status closed (terminal)". Instruction: reword them in the same
    commit; `:10`, `:111-112`, `:116-117` carry em-dashes (ASCII on edit).

16. [8.7] Plan: the RED in `useTodayPastTours.test.tsx` "around :80" is the
    row order. Tree: that test is `:77-91`; besides the order (becomes
    `['new', 'ns', 'old']`, total stays 3 at `:87`) it asserts at `:90` that
    `getContact` was NOT called for 'c-ns' - after GREEN the no-show's tenant
    IS looked up. Instruction: flip or drop `:90`; retitle `:77` ("minus
    no-shows") and fix the file header `:1-7` ("no-shows off").

17. [8.7] Plan: delete `selectTodayPastTours` and "its tests in useTours.test.ts
    (around :297-330)", keeping `TODAY_PAST_TOURS_CAP`. Tree: the describe is
    `:297-332` and contains the ONLY cap pin ("caps Today at five rows",
    `:329-331`). Instruction: keep that `it` (move it to its own describe),
    delete the rest, and remove `selectTodayPastTours` from the import list
    (`:31`) - importing a removed export fails typecheck.

18. [8.7] Plan: "use the Past rows directly where it called the selector".
    Tree: `const eligible = useMemo(() => selectTodayPastTours(past), [past]);`
    (`useTodayPastTours.ts:147`) feeds `labelRows(eligible, ...)` (`:158`) and
    the deps `[pastStatus, eligible, pastCount]` (`:163`); `useMemo` is used
    nowhere else in the file (import `:20`). Instruction: pass `past`
    directly, drop `useMemo` from the import (else gate 5 fails on
    no-unused-vars), rewrite the `:145-146` comment, and trim the import at
    `:30` to `TODAY_PAST_TOURS_CAP, usePastTours`.

## 2. Anchors that hold (no change)

- `types.ts:899-906` TourOutcome + TOUR_OUTCOME_LABELS; `Tour` is `:914-940`
  and ends with `[key: string]: unknown` (`:939`), so new optional typed
  fields are compatible. `TimelineMilestoneType` `:2495-2517`, `tour_converted`
  at `:2506` (server union is in the same order,
  `app/src/repos/activityEventsRepo.ts:31-58`). Doc list `:2897-2902`.
- CRITICAL check (A4): the ONLY `Record<TourOutcome, ...>` in dashboard/src is
  `TOUR_OUTCOME_LABELS` (`types.ts:903`), updated in the same task. No switch,
  `never` check or other exhaustive map over TourOutcome or
  TimelineMilestoneType exists (Timeline.tsx `milestoneVariant` has a
  `default`). Widening the union breaks nothing else.
- `client.ts:13-33` ApiError: `status`, `code`, `body`, `detail?`; message is
  `<code> (<detail>)` or `<code>` (`errorFrom`, `:75-83`).
- `TourDetail.tsx`: CTA ladder `:569-601`; Outcome card `:789-806`; guarded
  already-toured close `:820-829`; `runDirect` `:340-353`; `shortDate`
  imported at `:57`; `setTour` is the LoadedProps prop (`:165`, from
  useTour); `confirmOutcome(decision: { outcome: TourOutcome; moveForward:
  boolean })` at `:531-534`; kebab render `:650-667`; header `:1-26`.
- Closed non-convertible tour today: no primary CTA (unless converted /
  convertible) and NO kebab - every guard is false for status closed
  (`TourDetail.tsx:301-320`), so `TourActionsMenu` returns null
  (`TourActionsMenu.tsx:81-89`). Pin: `TourDetail.test.tsx:449` "a closed tour
  with a group has no kebab at all" - stays green after 8.5 (its closed +
  not_a_fit fixture newly shows the "Reopen tour" CTA, still no kebab).
- `TourActionsMenu`: items are `<button type="button" role="menuitem">`; the
  trigger is `aria-label="More actions"` (`:103`), so a `button` query never
  sees a kebab item (plan 8.5 relies on this - correct).
- `Modal` props (`contact/Modal.tsx:12-25`): `title` (also aria-labelledby),
  `onClose`, `children`, `footer?`, `variant?`, `headerActions?`,
  `trapFocus?`, `initialFocus?`, `restoreFocus?`, `onDialogKeyDown?`; Escape
  uses an internal `onCloseRef`; backdrop mousedown and the "Close" X call the
  latest `onClose` - the guarded close covers all three.
- `ToursPage.tsx`: TourRow `:124-158` (badges `:152-153`, `styles.badge`);
  PAGE_INTRO `:591-595`; Closed render `:778-799`.
- `useTours.ts`: header `:10-12`; selectPastTours `:198-210`;
  selectOffRangeTours `:237-250`; selector `:252-263` (cap `:253`).
- `useTodayPastTours.ts`: header `:1-5`; leaves-out note `:47-50`.
- `Today.tsx`: header `:7-9`; section comment `:220-224`; link rule `:241`,
  `:255-257`; a non-toured row links to `/tours/<id>` without `?outcome=1`
  and shows `pastState` ("No show") (`:193-218`) - the 8.7 Today PIN is a
  true pin.
- `tourActivityFormat.ts:14-23` labels, `:63-72` MILESTONE_TYPE;
  `listingFormat.ts:114-121` TOUR_LABELS - an unknown type falls to the
  humanized default with NO link (`:171-174`); `UnitActivityEvent.tourId` is
  projected for any audit type (`app/src/routes/units.ts:217`), so the new
  kinds keep `/tours/<id>` once listed.
- `Timeline.tsx:428-444` default neutral - no change (spec 9.5 holds).
- Tests: the 409-generic test that 8.4b turns RED is exactly
  `TourDetail.test.tsx:555-568` and is the ONLY test asserting a tour
  dialog's generic copy (repo grep; ScheduleTourForm's own copy is a
  different, create-only dialog). Past intro pin `ToursPage.test.tsx:712-716`.
  Today retitle `Today.test.tsx:421` (assertion stays valid).
- Task 8.8 app mirrors: `app/src/lib/seed/history.ts:79-96`,
  `app/test/seedTourTrails.test.ts:53-69` + title `:134`,
  `app/test/seedHistory.test.ts:858-861` - all SUBSET (`has`) checks, so new
  labels cannot turn them red; only the comments / title become false.
- Catalog (D): comparison is SORTED fingerprints (order-free), so "beside
  createTour" (`mutationCatalog.ts:131`) is cosmetic. Pin `toHaveLength(110)`
  at `mutationCatalog.test.ts:375`, ledger `:367-374`
  (102 + 1 + 3 + 2 + 2 = 110) -> 111. The scanner will discover
  `dashboard/src/api/endpoints.ts :: reopenTour :: request:POST ::
  /api/tours/:tourId/reopen` (the `${encodeURIComponent(tourId)}` span becomes
  `:tourId` - the parameter MUST be named `tourId`). The path starts with
  `/api/`, so `isCatalogPathIntercepted` is true and the default
  `first_party_api` is right (`:410-414`). No firewall / templates / routes /
  INTERCEPTION_SCOPE_VERSION change (precedent 0188e87b touched only the two
  catalog files).
- e2e strings that survive: `tours-past.spec.ts:113` (`/^Last 90 days:/`),
  `tours-page.spec.ts:444` (`getByText('Closed', { exact: true })` beside the
  new outcome badge). No e2e asserts a tour dialog's "Couldn't ..." copy.

## 3. Spec gaps and risks

1. (pre-existing, informational) `useTour` refetches on `tour.updated`
   (`useTour.ts:113-120`) through `GET /api/tours/:tourId`, which reads
   WITHOUT consistentRead (`app/src/routes/tours.ts:432-440`). A stale read can
   repaint the pre-reopen closed row over `setTour(reopened)` and stay until
   the next event. True for every PATCH today; e2e assertions must
   auto-retry. Not an S8 change.
2. Header-alert direct actions (`runDirect`, `TourDetail.tsx:340-367`: Mark
   toured CTA, Mark no-show kebab) still show the raw `ApiError.message`
   (`illegal_status_transition (a closed tour cannot be changed ...)`). D14
   covers dialogs only; the auto-close makes this likelier (Today now sends
   staff to no-show tours near the 14-day line). Spec 8.3 accepts it - worth
   one handback line, no plan change.
3. Bulk Past runner (`ToursPage.tsx:419-453`): a tour closed after the list
   loaded reads "Changed since the list loaded"; one closed between its
   re-read and its PATCH reads "The update failed" (generic, not D14 copy).
   Spec 10.2 accepts.
4. TourRow's link `aria-label` (`ToursPage.tsx:141`) REPLACES its content as
   the accessible name, so the new outcome badge is not part of the link's
   name - unit and e2e tests must find it by text inside the row, never by
   role name.
5. The converted Closed fixture (`ToursPage.test.tsx:444-456`, move_forward)
   will newly show a "Move forward" badge - spec 9.3 applies to any closed
   tour with an outcome. Existing `getByText('Closed')` in that row (`:537`)
   stays unique. A "no outcome badge" case must use the canceled fixture.
6. A closed tour carrying a `pending:` claim renders "View placement" to
   `/placements/pending:x` (`TourDetail.tsx:334`, `:571-576`) - pre-existing;
   the plan's matrix only asserts no Reopen there. Out of scope.
7. ASCII hotspots on lines S8 is likely to rewrite: `endpoints.ts:2665`,
   `ToursPage.tsx:26`, `useTours.ts:10`, `:111-112`, `:116-117`,
   `TourModals.tsx:7`, `types.ts:2897` (S3), `Today.tsx:1`. Worktree files
   are CRLF (core.autocrlf=true).

## 4. Reader sweep (spec section 12, dashboard side)

| reader | site | verdict |
|---|---|---|
| Past selection | `useTours.ts:198-250` | unaffected; reopened tours return by status; a reopened undated toured tour is listed via `updatedAt` (`:239`) = the reopen |
| Today rows | `useTodayPastTours.ts:147` | changes (8.7) |
| Closed tab | `useTours.ts:119-151`, `ToursPage.tsx:778-799` | badge (8.6); the updatedAt-desc sort (`useTours.ts:135-139`) puts first-run closes on top, matching spec 13's review step |
| CTA ladder / kebab / Outcome card | `TourDetail.tsx:569-601`, `:300-334`, `:789-806` | 8.5 |
| canOpenGroup | `TourDetail.tsx:319-320` | status-derived; a reopened tour without a group can open one; no change |
| groupDead | `TourConversation.tsx:162`, `:235-246` | status-derived; reopened tour is not dead (spec 12 agrees); copy "This tour is closed - ..." uses the raw status (pre-existing); no change |
| contact / property tour cards | `TenantFile.tsx:339`, `LandlordFile.tsx:219`, `ListingDetail.tsx:1088` | status label only -> "Closed"; no change (confirmed) |
| status tone | `ui/StatusBadge.tsx:62-66` | closed = neutral; no change |
| milestone colour | `contact/Timeline.tsx:428-444` | default neutral; no change |
| activity labels | `tourActivityFormat.ts`, `listingFormat.ts` | 8.8 |
| listing-send chip | `contact/Card.tsx:197-216` renders the server's `TourSignalState` (`types.ts:2728`) | S7 server-only; no dashboard change |
| Today client fallback | `today/buildToday.ts:182-185`, `:265` | scheduled-only tours_today; unaffected |
| live refetch | `useTour.ts:113-120`, `useTourActivity.ts:85-91`, `RemindersPanel.tsx:319-325`, `useRoster` | all refetch on `tour.updated`, which the sweep and reopen emit; see risk 1 |
| bulk runner | `ToursPage.tsx:419-453` | unaffected; see risk 3 |

Not in the spec's list but stale after this change (comment-only; fold into
the owning task): `useTours.ts:108-118` (correction 15),
`TourActionsMenu.tsx:79-80` (correction 8), `types.ts:926` (`Tour.outcome`
"set via PATCH" - the sweep now writes `no_outcome`), `Today.tsx:188-192`
(PastTourRow doc: "the others open the tour page, where Mark toured / Start
placement live" - a no-show row's page offers Reschedule / check-in),
`useTodayPastTours.ts:15-16` ("a status or outcome PATCH, a conversion" -
now also the sweep and reopen), `ToursPage.test.tsx:472-473` ("terminal
closed tour"). Nothing functional is missing from the spec's reader list.

## 5. Commands (from the live package files)

- Catalog test (workspace `@housingchoice/e2e`, `e2e/package.json:2`, script
  `test: vitest run`, include `performance/**/*.test.ts`):
  `cd "W:/tmp/tour-auto-close"; npm run test -w @housingchoice/e2e -- performance/mutationCatalog.test.ts`
  (equivalent: `cd "W:/tmp/tour-auto-close/e2e"; npx vitest run performance/mutationCatalog.test.ts`).
  The root `npm test` also runs it (workspaces --if-present).
- Dashboard files: `cd "W:/tmp/tour-auto-close/dashboard"; npx vitest run src/routes/tours/TourDetail.test.tsx`
  (likewise for the other test files); typecheck from the root:
  `cd "W:/tmp/tour-auto-close"; npm run typecheck` (covers dashboard tests and
  the e2e workspace).
