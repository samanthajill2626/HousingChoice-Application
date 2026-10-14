# D5 - S3 Tasks 3.6-3.8: decisions record

Dispatch D5 of the feat/last-heard-from build (implementer, 2026-10-13).
Scope: the two outcome-serving GET projections, the outcome route and its
api.ts wiring, and the dashboard wire mirror with `setListingSendOutcome`.
Plan: `docs/superpowers/plans/2026-10-12-last-heard-from.md` (S3 Tasks
3.6-3.8, plus the N1/N2 contract notes, which bind S4/S5-S8 and need no
S3 code). Binding corrections applied: outcome F1 (3.6), outcome F6 (3.7,
accepted as written), matching F1 (3.8, mutation catalog).

## Commits

- 4ea153e8 Task 3.6 - `toListingSendRow` takes an options object
  (`app/src/repos/listingSendsRepo.ts:212`, `:231`; wire fields from `:141`);
  units recipients read (`app/src/routes/units.ts:210` `RecipientJoin`,
  `:216` `groupToursByTenant`, `:234` `projectRecipientRow`, route `:1180`);
  contact listings-sent read (`app/src/routes/contacts.ts:1232`); new
  `app/test/listingSendRowProjection.test.ts`; knowing rewrites in
  `app/test/listingSendsApi.test.ts`.
- 3e03488e Task 3.7 - the outcome route (`app/src/routes/units.ts:1223`,
  body parser `:281`, deps `:107`, constructor `:447`); api.ts passes the
  shared activity-events repo (`app/src/routes/api.ts:970`); new
  `app/test/listingSendOutcomeApi.test.ts`.
- b0096a2b Task 3.8 - dashboard mirror (`dashboard/src/api/types.ts:2964`,
  `:2965`, `ListingSendRow` fields from `:2988`), `setListingSendOutcome`
  (`dashboard/src/api/endpoints.ts:1149`), new
  `dashboard/src/lib/listingOutcomeErrors.ts` (+ test), typed fixtures in
  `dashboard/src/routes/contact/files.test.tsx`, and the perf mutation
  catalog entry (`e2e/performance/mutationCatalog.ts:84`, pin
  `e2e/performance/mutationCatalog.test.ts:382`).

## RED / GREEN evidence

- 3.6 RED: 17 of 28 failed - the options-object serializer cases (positional
  signature), absent outcome fields, 200 instead of 503 on a failed join,
  and a one-argument batch call where the spy expects `{ requireComplete:
  true }`. The no-sentAt case is a PIN. GREEN: listingSendRowProjection
  3/3, listingSendsApi 25/25; neighbor contactsBatchReads 10/10.
- 3.7 RED: 28 of 29 failed - the route did not exist (Express 404, empty
  body). The one green case ("the row check precedes the body check")
  expects a 404 and passes on unchanged code by coincidence; it binds only
  after GREEN. GREEN: listingSendOutcomeApi 29/29; seven neighboring
  units-route files 115/115.
- 3.8 RED: `setListingSendOutcome is not a function`; the
  listingOutcomeErrors module did not resolve; the catalog inventory saw
  120 of 121. GREEN: endpoints 52/52, listingOutcomeErrors 2/2, files
  45/45; e2e mutationCatalog 4/4 (incl. the interception ==
  `isCatalogPathIntercepted` check), firewall 19/19.
- `npm run typecheck` exit 0 after every commit; eslint on every touched
  file exit 0; every added line ASCII.

## Decisions and divergences (contract-neutral)

1. F1: `app/test/listingSendsApi.test.ts:9` is a value import carrying
   `IncompleteBatchReadError` and `type ContactItem` (the
   `contactsBatchIncomplete.test.ts` shape), never a value appended to a
   type-only import.
2. Knowing rewrites, never deletions, in listingSendsApi.test.ts: the two
   E3 "degrade to 200 chipless" pins and the best-effort failed-batch pin
   now assert the D12 503 `outcome_unavailable` contract; the tour-chip
   cases seed their tenants (under D12 a tour is read only for a resolved
   tenant). The PATCH-404 pin is unchanged and green.
3. `ListingSendRow.tour?` had no doc comment in the live tree; the plan's
   B11 doc line was added rather than "changed".
4. F6 accepted as written: the interested path reads the unit's tours
   filtered to the tenant; the code cites the adjudication
   (`app/src/routes/units.ts:1277`).
5. Watch items held in code: `requireTenantContact` runs after the 400
   `interested_unsupported` display check; `tourType` is `unit.tour_type`
   only (`app/src/routes/units.ts:1289`); `listing_decline_cleared` on a
   clear only when a decline was stored before the call; `listing_interested`
   only after a create; 409 `unit_deleted` for every outcome; 404
   `send_not_found` via `ledgerRowCounted`; 503 `saved: true` when the
   re-read fails after a write; partner rows never carry `tour`.
6. Comment-level only: the existing "no route collision" notes were kept;
   the listings-sent comment's em dashes became ASCII (the plan's block);
   the new deps doc says the sibling repos "already exist" instead of
   "above" (two of them sit below the insertion point); the api.ts comment
   drops a line-number citation.
7. `dashboard/src/lib/listingOutcomeErrors.ts` imports `ApiError` from the
   api barrel as planned (both barrel and client imports exist in
   `dashboard/src/lib`); it lives outside `endpoints.ts` because
   `endpoints.test.ts` mocks the client without `ApiError`.
8. matching F1: the catalog entry sits in endpoints.ts source order (after
   `removeUnitContact`); its default `first_party_api` interception equals
   `isCatalogPathIntercepted` for the path, which the catalog test checks.

## Contracts shipped for later slices

- Wire `ListingSendRow` (app and dashboard): required `outcome`,
  `interestedSupported`; optional `lastHeardFromAt`, `declined { at, by }`,
  `interestedMode`, `eligible`, `recipientMissing`. Units rows always carry
  `interestedMode` and `eligible`; contact rows never do.
- Outcome route answers exactly as plan section 1; 200 body `{ row }` in
  the units-row shape.
- Dashboard: `ListingSendOutcome`, `InterestedMode`,
  `setListingSendOutcome(...) -> Promise<{ row }>`, `isOutcomeSaved`,
  `outcomeErrorCopy`, `OUTCOME_SAVE_FAILED`, `OUTCOME_SAVED_RELOAD`.
- Untyped dashboard mocks (`ListingDetail.test.tsx`,
  `ContactDetail.test.tsx`) are left for S5, as planned.
