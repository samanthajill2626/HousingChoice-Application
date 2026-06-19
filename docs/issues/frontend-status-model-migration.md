---
id: frontend-status-model-migration
title: Dashboard frontend still uses the OLD status-model enums — migrate in lockstep
type: bug
severity: high
status: open
area: dashboard
created: 2026-06-19
refs: dashboard/src/api/types.ts, dashboard/src/routes/listings/ListingsList.tsx
---

**Problem.** The backend now uses the new placement-status vocabulary
(STATUS-MODEL.md §4–§7): the new placement stage ladder, the widened
`unit.status` set (`setup` / `under_application` / `finalizing` / `occupied` /
`on_hold` / `off_market`, replacing the old `placed` / `inactive`), and a
STRUCTURED `lost_reason` `{ category, text }` (no longer a plain string). The
dashboard frontend still hardcodes the OLD enums and shapes, so until it is
migrated in lockstep the dashboard will:

- **400 on stage writes** — the frontend's `CaseStage` / `CASE_STAGES` list no
  longer matches the backend's placement stages, and stage changes must now go
  through `POST /api/cases/:caseId/transition` (the legacy `PATCH /api/cases/:id
  { stage }` path now refuses a `stage` write).
- **Show empty / wrong listing filters** — the listings status filter still uses
  `available` / `placed` / `inactive`; `placed`→`occupied` and
  `inactive`→`off_market`, and three new states (`setup`, `under_application`,
  `finalizing`) are unrepresented.
- **Render lost reasons wrong** — `lost_reason` is now an object
  `{ category, text }`, not a string; rendering it as a string will print
  `[object Object]` or break.

**Specific frontend files / enums to update:**
- `dashboard/src/api/types.ts` — `CaseStage` / `CASE_STAGES` (replace with the
  new placement stage ladder); the `unit.status` type/union; the `lost_reason`
  type (string → `{ category?: LostReasonCategory; text?: string }`); add the
  lost-reason category enum.
- `dashboard/src/routes/listings/ListingsList.tsx` — the status filter
  (`available` / `placed` / `inactive` → the new six-value listing set).
- Any stage-write call site — switch from `PATCH /api/cases/:id { stage }` to
  `POST /api/cases/:caseId/transition { toStage, source, reason?, lostReason?,
  finalRent? }`; tenant-status / listing-status writes to the new
  `PATCH /api/contacts/:id/tenant-status` and `PATCH /api/units/:id/listing-status`.
- Any UI rendering `lost_reason` — read `{ category, text }`.

**Suggested fix.** Migrate the frontend in the SAME change set as this backend.
**This backend MUST NOT be merged to main until the frontend is migrated in
lockstep (or the backend is gated)** — otherwise the live dashboard breaks on
stage writes, listing filters, and lost-reason rendering.
