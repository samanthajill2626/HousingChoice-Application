---
id: tenant-filters-clear-focus-contrast
title: The Tenants list's facet Clear drops keyboard focus to the page body, and its text color is under AA
type: bug
severity: low
status: open
area: dashboard
created: 2026-10-01
refs: dashboard/src/routes/contacts/TenantFilters.tsx:72-81, dashboard/src/routes/contacts/TenantFilters.module.css:80-88, dashboard/src/routes/listings/ListingsList.tsx
---

**Problem.** Two accessibility defects on the Tenants list's facet controls, both already
fixed on the Properties list by tracker #1 (`feat/properties-available-view`, code review
rounds 1-2) and left here because the Tenants list was outside that feature's scope:

1. **Clear drops focus.** A facet's Clear button renders only while the facet has a selection
   (`TenantFilters.tsx:72-81`), so activating it unmounts the focused button and keyboard focus
   falls back to `<body>`. A keyboard user loses their place in the filters.
2. **Contrast.** `.clear` is `--c-brand` (#1f6feb) at 13px weight 500
   (`TenantFilters.module.css:80-88`) on the page background `--c-bg` (#f7f8fa): about 4.4:1,
   under the 4.5:1 AA minimum for that size.

**Suggested fix.** Mirror the Properties list: on Clear, move focus to the group's first chip
before clearing (a ref on the chip row), and use `--c-brand-hover` (#1a5fd0, about 5.5:1) for
`.clear`; pin the focus with a test like the Properties list's "Clear hands keyboard focus to
the first chip of its group".

**Why separate.** The plan-blind reviewer of tracker #1 (round 2, A2-7) pointed out that the two
lists' chip UIs are duplicated and had already drifted on exactly this fix. Extracting one shared
chip-group component would close the class; that refactor touches the shipped Tenants filters
and was kept out of #1. Fixing these two defects does not require it.
