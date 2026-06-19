# Listing (unit) soft-delete (delete / restore) — design

**Status:** implemented (landed on `main` this session).
**Date:** 2026-06-19.
**Surface:** backend (`app/` — units repo + routes) and the new dashboard
(`dashboard/`, :5174 — listing detail ⋯ menu + banner, Listings list).

The direct parallel of the [contact soft-delete](./2026-06-19-contact-soft-delete-design.md),
applied to listings (`unit` records — "listing" is the staff/landlord label).

## Goal

Staff can "delete" a listing without losing data — the record + history are
**retained** and can be **restored**. Deleted listings drop out of the normal
views and live behind a Listings **Deleted** tab.

## Data model

A sparse `deleted_at` ISO-8601 timestamp on the unit record. **Present → deleted.**
No schema/GSI/infra change. `isDeleted(unit)` (in `unitsRepo.ts`) is the single
definition. Restore = REMOVE the attribute (both delete + restore bump `updated_at`).

## Backend

- **Repo** (`unitsRepo.ts`): `softDelete(id, at)` SETs `deleted_at`; `restore(id)`
  REMOVEs it (both `attribute_exists(unitId)`-guarded → 404).
- **List filters**: `ListUnitsOpts.deleted` — default
  `attribute_not_exists(deleted_at)` (hide deleted); `true` →
  `attribute_exists(deleted_at)`. Applied in the shared `queryIndex` (covers
  `listByLandlord` / `listByStatus` / `listByJurisdiction` / `listByProperty`)
  **and** the no-filter `list` Scan — so deleted listings vanish from the listings
  page, the landlord's "Listings" card (reads the no-filter list), and the
  related/similar derivations.
- **Routes** (`routes/units.ts`): `DELETE /api/units/:id` (server-side `deleted_at`,
  audit `unit_deleted`), `POST /api/units/:id/restore` (audit `unit_restored`), and
  `GET /api/units?...&deleted=true` for the Deleted view (flows into whichever list
  path the query resolves to).
- **No inbox/today involvement** — units aren't queued there (broadcast targeting
  resolves contacts, not units), so the contact feature's inbox/today exclusion has
  no analog here. Listing-sends + cases retain their historical unit pairing (a
  deleted unit's recipient panel 404s on the unit, so it never surfaces).

## Frontend

- **⋯ menu** (`ListingActionsMenu`, new — the kebab was a stub): Copy link to
  listing + **Delete listing** (danger) / **Restore listing**.
- **Confirm → navigate**: Delete opens a confirm `Modal`; on confirm it `DELETE`s
  and navigates back to `/listings`. Restore is immediate and applies the returned
  unit **in place** (`useListing` gained a `setUnit`; the banner clears, no refetch).
- **Deleted detail page**: a "🗑 Deleted" header badge + a standing banner with a
  Restore button; the Broadcast/Edit buttons are hidden while deleted.
- **Listings list**: **Active / Deleted** view tabs (`/listings` and
  `/listings/deleted`); `useListings(deleted)` passes `deleted` to `getUnits`. The
  status + housing-authority filters still apply within each view.

## Decisions (carried from the contact feature, per "exact same thing")

- Confirm dialog first, then navigate to the Listings list.
- Restore from the Deleted view → the listing's page → Restore.
- The Deleted view is a tab pair (listings has no audience tabs to hang it on,
  unlike contacts).

## Testing

- Backend: `unitsSoftDelete.test.ts` (delete/restore, list exclusion across the
  no-filter/byStatus/byLandlord paths, Deleted view, 404s). Repo filters verified
  on real DynamoDB Local via `unitsRepo.integration.test.ts`. Full app suite green.
- Frontend: `ListingActionsMenu` (Delete/Restore + busy), `ListingDetail`
  (confirm→navigate, Deleted banner + restore-in-place), `useListings` (deleted
  fan-out). Full dashboard suite green.

## Non-goals

- No hard delete (retention by design).
- `getUnit(:id)` still resolves a deleted unit (so the detail page + restore work);
  only the LIST paths filter.
