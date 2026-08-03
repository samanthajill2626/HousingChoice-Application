---
id: deleted-entity-refs-render-as-raw-ids
title: Cross-reference lookup maps built from live-only lists render raw ids for soft-deleted contacts/units
type: bug
severity: med
status: open
area: dashboard
created: 2026-08-03
refs: dashboard/src/routes/placements/usePlacements.ts:78, dashboard/src/routes/placements/pageModel.ts:84
---

**Problem.** Several dashboard pages resolve tenant names and property labels by
building id->record maps from the LIVE list endpoints only. A record that outlives
its contact/unit (soft-deleted after the fact - tenant placed, property removed
from inventory) then renders the raw uuid instead of a name/address.

The tours list had exactly this bug and was fixed on 2026-08-03 (commit 0ce0b018:
ToursPage now also fetches `useContacts('deleted')` + `useListings(true)` and
merges them under the live records). Same-pattern surfaces NOT yet fixed:

- Placements page: `usePlacements` fetches live tenants (`getContacts({type:'tenant'})`)
  and live units only; a closed placement whose tenant/unit was deleted shows raw ids
  in the ledger rows (pageModel `tenantName`/`listingAddress` fall back to the id).
- Audit any other consumer of the "full contacts + units lists" cross-reference
  pattern (property-page placements card, edit-form relationship candidates).

Note: single-entity GETs (`/api/contacts/:id`, `/api/units/:id`) DO return
soft-deleted records, so detail pages that join per-id (TourDetail, PlacementDetail)
are not affected by soft-deletes - only truly-missing (404) refs degrade there.

**Suggested fix.** Mirror the ToursPage fix: also fetch the deleted lists and merge
them into the lookup maps with live records winning on id collision. If a page ever
needs to distinguish, style deleted-entity rows (e.g. muted/"(deleted)") - not
required for correctness.
