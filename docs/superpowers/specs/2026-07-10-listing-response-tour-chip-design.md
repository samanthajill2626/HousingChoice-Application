<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-07-10).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Drop the listing-send `response` label; derive a tour chip instead

Date: 2026-07-10
Status: APPROVED (Cameron, 2026-07-10) - ready for implementation
Branch: chore/listing-response-tour-chip (worktree w:/tmp/listing-tour-chip, cut from main 1529486)

## 1. Context and decision

Every listing send (a property sent to a tenant, via broadcast or individual)
records a row in listing_sends with a `response` field:
'no_reply' | 'interested' | 'not_a_fit'. Research (2026-07-10) showed the field
is write-mostly decoration:

- 'interested' duplicates the real workflow: interest is recorded by ACTING on
  it - creating a Tour (which carries scheduling, the group thread, and the
  placement conversion). Nothing reads response==='interested'.
- 'no_reply' is stored absence, and STALE absence: it says "No reply" even when
  a reply sits in the inbox.
- 'not_a_fit' is the only unique bit, but nothing consumes it (the composer's
  "Already sent" re-send guard uses broadcast recipient history, not this).
- The manual PATCH that sets it has NO dashboard caller; the listing_reviewed
  milestone therefore never fires outside seeds/tests.

Cameron's decision: REMOVE `response` end to end, and replace the dead label
with a TRUTHFUL, DERIVED signal on the send rosters - a chip showing the
tenant's tour state for that unit, derived live from the tours table.

The listing-sends LEDGER itself (who got which property, when, via what)
STAYS - it powers the composer's "Already sent" annotation and both roster
cards.

## 2. Goals

- G1: No `response` field anywhere - repo, routes, types, seeds, UI, tests.
- G2: The "Sent to tenants" card (property page) and the "Properties sent"
  card (tenant contact page) each show, per row, a tour-derived chip when a
  qualifying tour exists for that unit+tenant, linking to /tours/:tourId.
- G3: Historical data needs no migration: stray `response` attributes on
  existing listing_sends rows decay in place; old `listing_response_set`
  audit rows simply stop rendering in the timeline (graceful).
- G4: All gates green (typecheck + unit + e2e) on a base freshly merged with
  main.

## 3. Non-goals

- NO change to the listing-sends ledger semantics: recordSend stays an
  idempotent upsert keyed (unitId, contactId); sentAt/via/broadcastId
  behavior unchanged; the "Already sent" composer annotation unchanged.
- NO new table/GSI/infra: the chip uses the EXISTING tours byUnit and
  byTenant GSIs.
- NO data migration or read-time stripping of stray `response` attributes
  (ListingSendItem keeps [key: string]: unknown tolerance).
- NO reply-detection ("Replied" indicator from conversation activity) - a
  possible later feature, separate decision.
- NO placement-derived states on the chip (a converted tour renders as
  "Toured"; deeper placement linkage is out of scope).
- Tour pages/entities themselves unchanged.
- Historical docs untouched.

## 4. Removal inventory (the `response` yank)

### R1. app/src/repos/listingSendsRepo.ts
- Remove: ListingResponse type, `response` from ListingSendItem and
  ListingSendRow, toListingSendRow's response field, setResponse() +
  SetResponseResult + ListingSendNotFoundError, and the
  `#response = if_not_exists(#response, :noReply)` clause (+ its
  ExpressionAttributeNames alias and :noReply value) from recordSend.
- recordSend keeps everything else (sentAt/via/broadcastId upsert semantics,
  created_at if_not_exists, broadcastId REMOVE branch). Update the header
  comment (the no-reset invariant paragraph now covers only the ledger
  fields).

### R2. app/src/routes/units.ts
- Remove: PATCH /:unitId/recipients/:contactId (whole route), the
  isListingResponse/LISTING_RESPONSES validation it uses, the
  listing_reviewed milestone emit + listing_response_set audit append, and
  the activityEventsRepo/auditRepo deps IF the removed route was their only
  consumer in this file (check remaining uses before deleting - the units
  router has other audit consumers; remove exactly what dangles, mirroring
  the assignment-yank cleanup discipline).
- GET /:unitId/recipients stays (gains the chip projection, section 5).

### R3. app/src/routes/contactTimeline.ts
- Remove the 'listing_response_set' -> 'listing_reviewed' mapping case
  (~line 491-498). Old audit rows then fall through to `default: return
  null` and stop rendering - graceful, intended (G3). The 'listing_sent'
  milestone mapping STAYS.
- Sweep: if a 'listing_reviewed' milestone TYPE exists in any shared
  milestone-type union (app or dashboard timeline types), remove it and any
  dead label/icon mapping.

### R4. app/src/routes/api.ts (~line 476)
- A comment/emit referencing "BE4: emit listing_reviewed on a real
  interested/not_a_fit change" - locate and remove whatever assignment of
  that logic lives there (comment or code); it dies with the feature.

### R5. Seeds
- app/src/lib/seed/cast.ts (~lines 614, 638), history.ts, matrix.ts: stop
  writing `response` on seeded listing_sends rows (drop the field from the
  seed objects). Seeded TOURS already exist and will light the new chip
  naturally. Seed-coherence tests that assert response values are updated
  (R7).

### R6. Dashboard
- api/types.ts: remove ListingResponse and ListingSendRow.response (keep the
  rest of the C4 shapes in sync with the server projection, incl. the NEW
  tour field from section 5).
- api/endpoints.ts: remove the response-PATCH helper if one exists (research
  found none - verify), keep the recipients/listings-sent GETs.
- routes/listing/ListingDetail.tsx: remove RESPONSE_META and the response
  chip on "Sent to tenants" rows (replaced by the tour chip, section 5).
- routes/contact/TenantFile.tsx: remove the response labels (~line 82) on
  "Properties sent" rows (replaced by the tour chip).
- Remove/trim: listingFormat.test.ts and files.test.tsx response assertions
  ("No reply" etc.); never weaken unrelated assertions.

### R7. Tests
- app/test/listingSendsRepo.integration.test.ts: drop setResponse coverage;
  keep recordSend upsert/idempotency coverage (minus the response seeding
  assertions).
- app/test/listingSendsApi.test.ts: drop the PATCH-route tests; ADD a pin
  that PATCH /api/units/:id/recipients/:contactId now 404s (route gone -
  cheap regression pin, mirrors the assignment yank's filter=mine pin).
- app/test/seedHistory.test.ts + seedMatrixCoherence.test.ts: update for
  seed rows without response.
- contactTimeline tests: listing_response_set rows map to null.

## 5. The tour-derived chip (new)

### Server derivation (single source of truth)

- Pure helper (suggested home: app/src/lib/toursModel.ts or a small
  listingSendTour.ts lib):
    deriveTourSignal(tours: TourItem[]): { tourId: string;
      state: 'requested' | 'scheduled' | 'toured' } | undefined
  Given ALL tours for one (unit, tenant) pairing, pick the most progressed
  qualifying signal:
    - any tour with status 'toured' -> state 'toured'
    - else status 'closed' AND convertedPlacementId set -> state 'toured'
      (a converted tour necessarily happened; "Toured" is the honest floor)
    - else any 'scheduled' -> 'scheduled'
    - else any 'requested' -> 'requested'
    - 'canceled' / 'no_show' / unconverted 'closed' -> no signal (undefined)
  Ties: prefer the most recently created qualifying tour; return ITS tourId
  (the chip links there).
- GET /api/units/:unitId/recipients: ONE toursRepo.listByUnit(unitId) call,
  group tours by tenantId, attach to each recipient row an OPTIONAL field:
    tour?: { tourId: string; state: 'requested'|'scheduled'|'toured' }
- GET /api/contacts/:contactId/listings-sent: ONE
  toursRepo.listByTenant(contactId) call, group by unitId, same optional
  field per row.
- Rows with no qualifying tour carry NO tour field (chip absent). Cost: one
  existing-GSI query per card load; no N+1.

### Dashboard rendering

- Shared chip presentation (one helper in the listing/contact card layer so
  both cards render identically):
    'requested' -> "Tour requested" (neutral/wait tone)
    'scheduled' -> "Tour scheduled" (positive/progress tone)
    'toured'    -> "Toured" (positive tone)
- The chip is a <Link to={`/tours/${tourId}`}> - it navigates to the tour
  detail page. Rows without the field render no chip (just name/phone-level
  identity + sentAt/via as today).
- Both cards: ListingDetail "Sent to tenants" and TenantFile "Properties
  sent".

### Wire-shape note

ListingSendRow (server + mirrored dashboard type) LOSES `response` and GAINS
`tour?` in the same change; the two declarations are hand-mirrored
independent types (assignment-yank lesson), so the lockstep pin is each
side's own tsc plus payload-shape tests - update both in one commit and pin
the projection with a route test.

## 6. Edge notes

- E1: recordSend's UpdateExpression must remain valid after removing the
  response clause (no dangling ExpressionAttributeNames - DynamoDB rejects
  unused aliases).
- E2: A tenant with tours on OTHER units must not light this unit's chip
  (group strictly by the pairing). Pin with a test (two tenants, tours on
  different units).
- E3: tours listByUnit/listByTenant are best-effort joins: if the tours
  query fails, serve the rows WITHOUT tour fields and log (the roster must
  never 500 because the chip join failed) - same degrade posture as the rest
  of the card hydrations.
- E4: final sweep: rg -i "no_reply|not_a_fit|ListingResponse|setResponse|
  listing_reviewed|listing_response_set|RESPONSE_META" over app/src,
  dashboard/src, e2e must return zero product-code hits (seed/history and
  test remnants included). Include the sweep output in the handback.
- E5: ASCII only in every touched line; chip labels are new feature text -
  plain ASCII.

## 7. Testing and gates

- Unit (app): deriveTourSignal precedence + tie-break + disqualifying
  statuses (canceled/no_show/unconverted closed) + converted-closed floor;
  recipients + listings-sent projections attach tour only for the right
  pairing (E2); tours-join degrade (E3); PATCH 404 pin; recordSend
  idempotency still green without response.
- Unit (dashboard): both cards render the chip states + link href, and no
  chip when absent; removed response assertions.
- E2E (extend the property/listing spec or broadcasts spec where the card
  is already exercised): send a property to seeded tenants; the card shows
  rows WITHOUT any response chip; schedule a tour for one recipient on that
  unit (UI or API); the row gains "Tour scheduled" linking to /tours/:id;
  other rows stay chipless.
- Gates (bare, real exit codes, from the worktree): npm run typecheck +
  npm test + `timeout 1500 npm run e2e`, green on a base freshly merged
  with main before handback.
- Self-QA (live stack + Playwright MCP, full seed): open a seeded unit with
  sends + a seeded tour - verify the chip appears on the right row, links to
  the tour, and no "No reply" text exists anywhere in the app.

## 8. Post-merge

Nothing required (no deps, no schema, no infra). Dev-stack restart picks it
up; stray response attributes + old listing_response_set audit rows decay in
place.
