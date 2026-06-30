<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-06-20).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted on 2026-06-20. **This file is NOT
> current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# Manual placement creation — design spec

> Date: 2026-06-20 · Status: approved (brainstorm) → ready for implementation plan
> Lets staff create a placement (the tenant↔unit workflow record) by hand: a button + a
> form, launchable from the board or pre-filled from a tenant or a unit.

## 1. Goal & decisions

Add a way to **create a placement manually** in the dashboard. Agreed decisions:

1. **Entry points:** a blank **"New placement"** button on the Placements board, **plus** a
   symmetric **"Start placement"** action on the **tenant file** (tenant pre-filled) and on
   the **listing/unit detail** (unit pre-filled). Same form component either way; only which
   side is pre-filled + locked differs.
2. **Starting stage:** the operator **picks** the starting stage (default `Send application`)
   so an in-flight deal can be entered at its true stage. Terminals (`Moved in`/`Lost`) are
   NOT creatable — they're reached via the board.
3. **Overlap:** **warn but allow** — if the chosen tenant or unit already has an active
   (non-terminal) placement, show an inline notice (with a link to it) and let the operator
   proceed. Never blocks.
4. **Derivation:** **derive on create** — the create path derives the tenant + listing
   statuses for the chosen stage (extends the backend; see §2). One call, consistent result.

The placement entity already exists end-to-end (`PlacementItem`, `placementsRepo`, table
`placements`, `/api/placements`); the create route exists too. This feature is mostly
frontend + one backend extension.

## 2. Backend — derive on create

**File:** `app/src/routes/placements.ts` (the `router.post('/', …)` handler).

Today the handler validates `{ tenantId, unitId, stage?, placement_tag? }` (tenant+unit
required; `stage` defaults to `send_application`), creates the row, and stamps the
placement's own provenance (`stage_entered_at`, `stage_source`). It does **not** derive the
tenant/listing coarse statuses — a latent gap (a freshly-created placement leaves its tenant
at e.g. `searching` and its listing at `available`).

**Change:** after creating the row, derive + write the tenant and listing statuses for the
chosen initial stage, reusing the status-transition service's derivation (`deriveStatuses`
in `app/src/lib/statusModel.ts`, and the override-gated + audited derived-write helpers in
`app/src/services/statusTransition.ts`). Specifics:
- Use the §7 alignment: non-terminal stages → tenant `placing`, listing `under_application`
  (Application…Rent) or `finalizing` (Contract/Administrative/Closure); `moved_in` → tenant
  `placed`, listing `occupied`.
- Writes use source `derived` (lowest precedence) through the shared helpers, so a manual
  pin still wins and override/exit states (`on_hold`/`off_market`/`inactive`) are NOT
  clobbered.
- Wire the status-transition service (or its derivation helpers) into the placements router
  `deps`. Derivation is best-effort like elsewhere — it must not fail the 201.
- The backend derives for **any valid stage it receives** (defensive — incl. `moved_in`);
  the UI simply doesn't offer terminals (§5). Response unchanged: `201 { placement }`.

This also fixes the latent create-never-derived gap for ALL placement creation, not just
the manual UI.

## 3. API client

**File:** `dashboard/src/api/endpoints.ts` (+ `api/types.ts` if a body type helps).

Add `createPlacement(body: { tenantId: string; unitId: string; stage: PlacementStage;
placement_tag?: string }): Promise<PlacementItem>` — `POST /api/placements`, unwrap
`{ placement }`. Mirror the existing typed-endpoint style.

## 4. Frontend — the form

**New:** `dashboard/src/routes/placements/PlacementCreateForm.tsx` (a modal, mirroring
`dashboard/src/routes/contact/ContactCreateForm.tsx`). Props let it open blank or pre-filled:
`{ tenantId?, unitId?, onClose, onCreated }` (a pre-filled side renders locked/read-only).

Fields:
- **Tenant** (required): reuse `dashboard/src/routes/contact/ContactSearchField.tsx`, scoped
  to `type: 'tenant'` (filter results to tenants if the field isn't already scopeable).
  Pre-filled + locked when `tenantId` prop is set.
- **Unit** (required): a **new** `UnitSearchField.tsx` (alongside `ContactSearchField`) — a
  typeahead over units by address. No backend unit-search exists, so fetch units
  (`getUnits`) and filter client-side by address; acceptable at current inventory (note a
  backend search as a future improvement if inventory grows). Pre-filled + locked when
  `unitId` prop is set.
- **Starting stage** (required, default `send_application`): a `<select>` of the
  **non-terminal** placement stages, labeled via `STAGE_LABELS`.
- **Label** (optional): `placement_tag` free text.
- **Overlap notice:** when a tenant and/or unit is selected, query
  `getPlacements({ tenantId })` / `getPlacements({ unitId })` (the board endpoint already
  filters by these) for active (non-terminal) placements; if any exist, render an inline
  warning naming the existing placement (stage + the other party) with a link to it.
  Non-blocking.
- **Submit:** disabled until tenant + unit are both chosen. On success (`201`), close the
  modal and navigate to `/placements/:placementId`. On API error, show an inline message and
  keep the modal open.

## 5. Entry points

- **Board** — `dashboard/src/routes/placements/PlacementsBoard.tsx`: a "New placement"
  button in the header (mirror the "New contact" button in `ContactsList.tsx`) → opens
  `PlacementCreateForm` blank.
- **Tenant file** — the tenant contact view (`dashboard/src/routes/contact/TenantFile.tsx`):
  a "Start placement" action → opens the form with `tenantId` pre-filled + locked.
- **Listing/unit detail** — `dashboard/src/routes/listing/ListingDetail.tsx`: a "Start
  placement" action (header or actions menu) → opens the form with `unitId` pre-filled +
  locked.

## 6. Data flow

open (maybe pre-filled) → pick tenant + unit → overlap check fires on selection → pick stage
(+ optional label) → submit → `createPlacement` → backend creates the row **and derives**
tenant/listing → `201 { placement }` → close + navigate to the new placement detail.

## 7. Validation & errors

- Required: tenant + unit (submit disabled otherwise). Stage comes from the select (always
  valid, non-terminal).
- Overlap is a warning, not a block (confirm-to-proceed inline).
- Backend 400/404 (e.g. unknown tenant/unit) → inline error; modal stays open. No PII in logs.

## 8. Testing

- **Component (dashboard):** form renders; tenant + unit pickers select; stage select
  defaults to `Send application` and offers only non-terminal stages; overlap warning appears
  when an active placement exists for the tenant/unit (and not otherwise); submit is disabled
  until both chosen; submit calls `createPlacement` with the exact body; each entry point
  opens with the right side pre-filled + locked.
- **Backend:** `POST /api/placements` at a mid-ladder stage (e.g. `awaiting_inspection`)
  derives tenant `placing` + listing `under_application` and stamps provenance; derived
  writes respect an existing override pin (e.g. a listing `on_hold` is not clobbered);
  default stage still works; the 201 doesn't fail if a derived write errors (best-effort).
- **e2e:** from the board, "New placement" → pick a seeded tenant + unit → create → lands on
  the new placement detail; plus a pre-filled create from a listing (unit locked).

## 9. Components (each one job)

- `endpoints.createPlacement` — the API call (pure).
- `PlacementCreateForm` — the modal; orchestrates the pickers, stage, overlap, submit.
- `UnitSearchField` — a reusable unit-by-address typeahead (new).
- Overlap lookup — active-placement check by tenant/unit (inline or a small hook).
- Entry-point buttons — board, tenant file, listing detail.
- Backend create-derivation — extend the placements `POST /` handler.

## 10. Notes / future

- **Unit search is client-side** for now (filter `getUnits` by address). If inventory grows,
  add a backend unit-search and swap `UnitSearchField`'s data source — its interface stays.
- **Terminals not creatable** by design; `Lost` would also need a reason, which the board's
  lost-modal already handles.
