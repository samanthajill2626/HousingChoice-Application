---
id: frontend-status-model-migration
title: Dashboard frontend still uses the OLD status-model enums — migrate in lockstep
type: bug
severity: high
status: resolved
area: dashboard
created: 2026-06-19
resolved: 2026-06-19
refs: dashboard/src/api/types.ts, dashboard/src/routes/listings/ListingsList.tsx
---

**Resolution (2026-06-19).** The dashboard frontend was migrated in lockstep on the
same branch (`feat/status-model-be-foundation`): F1 (commit 645a410) migrated
`types.ts` to mirror the backend model (PLACEMENT_STAGES/PHASES + labels,
LISTING_STATUSES, TENANT_STATUSES, LostReason `{category,text}`,
TRANSITION_SOURCES, INSPECTION_OUTCOMES), added the transition endpoints
(`transitionPlacement`/`setTenantStatus`/`setListingStatus`/`getPlacementHistory`),
made the property + contact status pickers type-aware (writing through the
transition routes, never the plain PATCH), and rendered `lost_reason` as an object;
F2 (commit 5b553b7) added the placement board at `/placements` (@dnd-kit drag→transition),
the lost-reason modal, placement detail + history, and finalRent/inspection-outcome
prompts. Tenant lifecycle lives on the single `contact.status` (no `tenant_status`).
Verified: dashboard typecheck + eslint clean, 459 component tests, and the full
Playwright e2e suite **21/21** (incl. board render, drag-move transition+persist,
lost-modal gating, placement detail+history) in a fresh hermetic run (commit 60b30ee).
Backend + frontend are now consistent and can merge together. (Also folded in on
this branch: backend F0 (commit d6efb1c) added `inspection_outcome` and removed the
RTA-in-hand app gate per product decision.) — the merge gate is cleared.

**Problem.** The backend now uses the new placement-status vocabulary
(STATUS-MODEL.md §4–§7): the new placement stage ladder, the widened
`unit.status` set (`setup` / `under_application` / `finalizing` / `occupied` /
`on_hold` / `off_market`, replacing the old `placed` / `inactive`), and a
STRUCTURED `lost_reason` `{ category, text }` (no longer a plain string). The
dashboard frontend still hardcodes the OLD enums and shapes, so until it is
migrated in lockstep the dashboard will:

- **400 on stage writes** — the frontend's `PlacementStage` / `PLACEMENT_STAGES`
  list no longer matches the backend's placement stages, and stage changes must
  now go through `POST /api/placements/:placementId/transition` (the legacy
  `PATCH /api/placements/:id { stage }` path now refuses a `stage` write).
- **Show empty / wrong property filters** — the properties status filter still uses
  `available` / `placed` / `inactive`; `placed`→`occupied` and
  `inactive`→`off_market`, and three new states (`setup`, `under_application`,
  `finalizing`) are unrepresented.
- **Render lost reasons wrong** — `lost_reason` is now an object
  `{ category, text }`, not a string; rendering it as a string will print
  `[object Object]` or break.

**Specific frontend files / enums to update:**
- `dashboard/src/api/types.ts` — `PlacementStage` / `PLACEMENT_STAGES` (the new
  placement stage ladder); the `unit.status` type/union; the `lost_reason`
  type (string → `{ category?: LostReasonCategory; text?: string }`); add the
  lost-reason category enum.
- `dashboard/src/routes/listings/ListingsList.tsx` — the status filter
  (`available` / `placed` / `inactive` → the new six-value property set).
- Any stage-write call site — switch from `PATCH /api/placements/:id { stage }` to
  `POST /api/placements/:placementId/transition { toStage, source, reason?, lostReason?,
  finalRent? }`; tenant-status / property-status writes to the new
  `PATCH /api/contacts/:id/tenant-status` and `PATCH /api/units/:id/listing-status`.
- Any UI rendering `lost_reason` — read `{ category, text }`.

**Tenant status is ONE field — `contact.status` (no separate `tenant_status`).**
The status-model work briefly added a SECOND status field (`tenant_status` +
`tenant_status_source`) on contacts. That has been REMOVED: a contact has a
SINGLE, type-scoped lifecycle that lives on the EXISTING `contact.status` field
(the one the dashboard already reads, and the `byTypeStatus` GSI range key):
- **Tenant** (`type === 'tenant'`): `contact.status` ∈ the §5 lifecycle
  (`needs_review` / `onboarding` / `searching` / `placing` / `placed` /
  `on_hold` / `inactive`). Provenance is `contact.status_source`
  (a `TransitionSource`); the `porting` boolean flag stays.
- **Non-tenant** (landlord / team_member / unknown): `contact.status` ∈
  `needs_review` | `active` (unchanged — they have no lifecycle).

So the frontend should render/drive `contact.status` for ALL contacts, but with
the TENANT lifecycle vocabulary (and labels — `TENANT_STATUS_LABELS`) when
`type === 'tenant'`. There is NO `tenant_status` field to read or write.
Tenant-status writes go through `PATCH /api/contacts/:id/tenant-status`
(`{ toStatus, source, reason?, porting? }`), which validates `toStatus` against
the tenant lifecycle and persists onto the unified `contact.status`.

**Suggested fix.** Migrate the frontend in the SAME change set as this backend.
**This backend MUST NOT be merged to main until the frontend is migrated in
lockstep (or the backend is gated)** — otherwise the live dashboard breaks on
stage writes, property filters, and lost-reason rendering.
