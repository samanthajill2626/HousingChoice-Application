# D10 - S7 Tasks 7.1-7.2: decisions record

Dispatch D10 of the feat/last-heard-from build (implementer, 2026-10-13).
Scope: the app side of the waiting list - the follow-ups builder and
`GET /api/broadcasts/follow-ups` (Task 7.1), and the hermetic dev seam
`POST /__dev/listing-send-fixture` (Task 7.2). Plan:
`docs/superpowers/plans/2026-10-12-last-heard-from.md` (S7 Tasks 7.1-7.2, the
W3 contract notes, sections 3.4 #5/#7 and 11). Binding correction applied:
matching F4 (7.1).

## Commits

- 3ecf19f3 Task 7.1 - new `app/src/services/followUps.ts` (cap :34,
  `FollowUpItem` :40, `FollowUpsResponse` :60, `FollowUpsDeps` :68,
  `nameOf` :81, `buildFollowUps` :97, cap check :110, the one
  requireComplete batch :139, `isWaiting` keep rule :158, order :178);
  `app/src/routes/broadcasts.ts` (header route line :12, import :84, route
  :1065-1085, registered above every `/broadcasts/:broadcastId` handler);
  tests `app/test/followUps.test.ts`, `app/test/followUpsApi.test.ts`.
- 9fb61076 Task 7.2 - `app/src/routes/dev.ts` (imports :59-60,
  `DevRouterDeps.listingSendsRepo?` :153, route :1320-1390 after the
  org-fixture route); test `app/test/devListingSendFixture.test.ts`.

`npm run typecheck` exited 0 after each commit; `npx eslint` on every
touched .ts file exited 0.

## RED / GREEN evidence

- 7.1 RED: the builder test failed to load (module absent); the route test
  4/4 failed on a 404. GREEN: 17/17 across the two files;
  `broadcastApi.test.ts` 109/109.
- 7.2 RED: 5 cases failed on a 404 (route absent); the new PIN case green
  before and after. GREEN: 62/62 across devListingSendFixture, devOrgFixture
  and devGating.

## Decisions and divergences

1. F4 (binding): no `app/src/lib/contactDisplay.ts`; `routes/units.ts` is
   untouched. The builder names a row with `contactDisplayName` from
   `app/src/lib/contactName.ts` (followUps.ts:16, :82) - the same part-wise
   trim and join as `displayNameOfContact` - then the phone, then the id
   (the plan's fallback rule, unchanged).
2. Extra tests, additive only: the name fallback (phone, part-wise trim) is
   pinned in followUps.test.ts; the route test asserts no `conversationId`
   on any item (spec 5.6) and adds the tours-read 503; the seam test asserts
   the 201 row carries no `declined` (I2) and adds a PIN that the seam is
   absent when the dev router is not mounted (the structural gate it shares
   with `/__dev/reseed`).
3. `FollowUpItem.declined` stays in the type and the builder never sets it
   (plan 3.4 #7).
4. Eligibility, outcome, thresholds and waitingSince all come from the
   shipped `app/src/lib/listingSendOutcome.ts` helpers - no local copy of
   any rule; a non-tenant never reads a tour because
   `deriveListingSendOutcome` drops the tour inputs for it.

## Notes for later slices

- The seam row gets `via: 'broadcast'` from putShareMemory's if_not_exists
  (no broadcastId); S8 should not assert `via` on a seam row.
- The perf-harness template for the new GET is adjudication F2, Task 7.5
  (next dispatch).
