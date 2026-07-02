---
id: tours-dialog-unit-label-glossary
title: ScheduleTourForm's visible 'Unit' label violates the staff-copy glossary ("property")
type: bug
severity: low
status: open
area: dashboard
created: 2026-07-02
refs: dashboard/src/routes/tours/ScheduleTourForm.tsx, dashboard/src/routes/tours/ScheduleTourForm.test.tsx, e2e/scenarios/steps.ts, e2e/tests/scenarios/tours.spec.ts, e2e/tests/dashboard-next/tours-page.spec.ts
---

**Problem.** `ScheduleTourForm` is a staff/navigator-facing dialog, but its visible
label + the `UnitSearchField` accessible name are both **"Unit"**. Per
[documentation/GLOSSARY.md](../../documentation/GLOSSARY.md) the blessed staff copy
for the single-`unit` entity is **"property"** ("unit" is the code/data word only).
The losing `ScheduleTourDialog` used "Property" correctly, but we kept main's
`ScheduleTourForm` as the survivor (its accessible names are pinned by the merged
e2e verb vocabulary), so the visible copy now drifts from the glossary. Low
severity: the tour still works and staff understand "Unit"; this is copy/consistency
drift, not a functional bug.

**Suggested fix.** Rename the visible label AND the `UnitSearchField inputLabel`
from "Unit" → "Property" in `ScheduleTourForm.tsx`. Because the accessible name is
pinned across the e2e vocabulary, the rename MUST land in ONE change that also
updates every selector that keys on the "Unit" combobox name:
- `dashboard/src/routes/tours/ScheduleTourForm.tsx` (label + `inputLabel`)
- `dashboard/src/routes/tours/ScheduleTourForm.test.tsx` (`combobox { name: 'Unit' }`)
- `e2e/scenarios/steps.ts` (tour verbs that drive the dialog by its accessible name)
- `e2e/tests/scenarios/tours.spec.ts`
- `e2e/tests/dashboard-next/tours-page.spec.ts` (retargeted to 'Unit' during the
  cluster-C de-dup merge — flip back to 'Property' in the same change)

Do NOT do a partial rename — a mismatch between the component's accessible name and
any one spec breaks that spec. Keep the internal code/data word `unit`/`unitId`
untouched (only the human-facing copy changes).
