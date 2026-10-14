# D11 - S7 Tasks 7.3-7.5: decisions record

Dispatch D11 of the feat/last-heard-from build (implementer, 2026-10-13).
Scope: the dashboard side of the waiting list - `useFollowUps`,
`FollowUpView` and the Matching "Follow up" tab (Task 7.3), `useFollowUpCounts`
and the Properties `<n> waiting` pill (Task 7.4) - and the new Task 7.5 that
keeps `npm run perf:pages` honest about the new GET (adjudication
matching-F2). Plan: `docs/superpowers/plans/2026-10-12-last-heard-from.md`
(S7 Tasks 7.3-7.4, the W3 contract notes, sections 3.4 #4-#7 and #10, and
11). Binding corrections applied: outcome-F3 (contract N1), F9, F10, F8.

## Commits

- 4e4ce649 Task 7.3 - `dashboard/src/api/types.ts` (FollowUpItem :3440,
  FollowUpsResponse :3459); `dashboard/src/api/endpoints.ts` (getFollowUps
  :1941); new `dashboard/src/routes/broadcasts/useFollowUps.ts`,
  `FollowUpView.tsx`, `FollowUpView.module.css` and their tests;
  `BroadcastsList.tsx` (FOLLOW_UP_TAB :34, chooseFilter :63, chooseFollowUp
  :76, the tabpanel :179); `BroadcastsList.module.css` (:49, :55, .tabCount
  :77); `BroadcastsList.test.tsx`; `endpoints.test.ts`.
- fae40853 Task 7.4 - new `dashboard/src/routes/listings/useFollowUpCounts.ts`
  (+ test); `ListingsList.tsx` (import :60, the pill :128, the hook call
  :210); `ListingsList.module.css` (.waiting); both ListingsList test files
  mock the new hook.
- fb24bff8 Task 7.5 - `e2e/performance/templates.ts` :133;
  `e2e/performance/routes.ts` (:309 and the /listings and /broadcasts rows,
  plus their ledger citations); `routes.test.ts` :84, :113;
  `redact.test.ts` :34.

`npm run typecheck` exited 0 after each commit; `npx eslint` on every
touched .ts/.tsx file exited 0.

## RED / GREEN evidence

- 7.3 RED: FollowUpView.test and useFollowUps.test failed to load (modules
  absent); the six new BroadcastsList cases failed (no Follow up tab, no
  tabpanel); the new endpoints case failed on "getFollowUps is not a
  function". GREEN: FollowUpView 18/18, useFollowUps 3/3, BroadcastsList
  26/26, endpoints 53/53; `src/routes/broadcasts` + endpoints 314/314.
- 7.4 RED: useFollowUpCounts.test failed to load; ListingsList could not
  find "2 waiting" and the Deleted case saw no hook call. GREEN:
  `src/routes/listings` 97/97; App.test 10/10.
- 7.5 RED: the routes.test deep-compare failed on /listings warm and the
  redact.test mapping returned `/api/broadcasts/:broadcastId`. GREEN:
  `e2e` `performance/` 17 files, 478/478.

## Decisions and divergences

1. F10 (binding): after Not interested, the in-place assertions wait for the
   `Undo not interested for <name>` button, then check the chip text
   (FollowUpView.test.tsx, the "Not interested marks the row" and "disables
   the row actions" cases).
2. F9 (binding): every new `beforeEach` is a block body.
3. outcome-F3 / N1 (binding): the two date spans spread `title` only when
   non-empty (FollowUpView.tsx:110, :113); a test pins that "Never" carries
   no title attribute.
4. The Follow up tab is its own view and hook, never a `BroadcastsFilter`
   value (spec 14.4); a BroadcastsList test pins that no list call carries a
   follow-up status, and that switching to the tab does not refetch.
5. Small additive CSS outside the plan: the Matching tab row wraps and each
   tab keeps its label on one line (BroadcastsList.module.css:49, :55) - six
   tabs plus the count outgrow a phone pane; the Settings tab row is the
   wrap precedent. Self-QA should look at 360px.
6. The FOLLOW_UP_TAB comment names deep links and the e2e as its users, not
   the Properties pill, which is not a link (plan 3.4 #6).
7. Additional tests, additive only: the "Interested" chip when the route
   response has no tour (copy 3.4 #5), Text disabled in flight, the hook's
   error state and abort signal, getFollowUps' path and signal, the pill is
   not a link, and the Deleted view calls the counts hook with
   enabled=false only (the ListingsList mock records its argument).
8. 7.5 scope: only the /listings and /broadcasts SURFACE gets changed
   (routes.ts :309 and the two rows); `UNIT_LIVE_WALK` and the
   /listings/deleted surface are untouched, per the ruling. Source contracts
   whose page is /listings or /broadcasts keep their gets: source gets have
   no reader outside routes.ts and the ruling named the surfaces.

## Notes for later slices (S8)

- Group headings read `<unitLabel><n> waiting` with no separator (the count
  is a child span): select a group by a pattern that starts with the
  unitLabel.
- The tab's accessible name is `Follow up <n>` when the count shows and a
  bare `Follow up` otherwise (loading, zero, or a failed fetch).
- An actioned row stays listed for the session; reload before asserting a
  row or group is gone.
