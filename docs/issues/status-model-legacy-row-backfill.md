---
id: status-model-legacy-row-backfill
title: One-off backfill of legacy stage/status/lost_reason rows for the new status model
type: debt
severity: med
status: open
area: app
created: 2026-06-19
refs: documentation/STATUS-MODEL.md, app/src/lib/statusModel.ts
---

**Problem.** Adopting the new status model renames/removes stages and statuses,
which per STATUS-MODEL.md §9 needs a **bounded one-off backfill** of any existing
rows so they conform to the new vocabulary. The mappings:

- **Unit `status`:** `placed` → `occupied`; `inactive` → `off_market`. (The new
  `setup` / `under_application` / `finalizing` states are derived going forward;
  no legacy value maps to them.)
- **Case `stage`:** any legacy stage value (`interested`, `porting`, `touring`,
  `applied`, `rta_submitted`, `rent_determined`, `lease`) → the corresponding new
  placement stage in the §4 ladder.
- **Case `lost_reason`:** any string value → the structured form
  `{ category: 'other', text: <old string> }`.

Provenance fields should also be initialized on backfilled rows where missing:
`stage_entered_at` / `stage_source` on cases, `status_source` on units (use a
neutral source such as `import`).

**Suggested fix.** A small, idempotent migration script (scan + conditional
update on the legacy values only). **No prod data exists yet (pre-deploy)**, so
urgency is low, but this MUST run before/with the first deploy of this model so
the new readers/guards never encounter an unmapped legacy value.
