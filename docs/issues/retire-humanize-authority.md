---
id: retire-humanize-authority
title: Normalize seed authority slugs to canonical names, then delete humanizeAuthority
type: debt
severity: med
status: open
area: dashboard
created: 2026-08-10
refs: dashboard/src/routes/listings/ListingsList.tsx, app/src/lib/seed/matrix.ts, app/src/lib/seed/cast.ts, app/src/lib/seed/lean.ts, app/src/lib/seed/live.ts, app/src/lib/import/apply.ts
---

**Problem.** `humanizeAuthority` (`ListingsList.tsx:36-42`) exists only to convert dev-seed
slugs (`atlanta_housing`, `ga_dca`) back into the human-readable names they should have been.
Cameron's ruling (2026-08-10, tenant-list spec gate): "We don't need something behind the scenes
that changes the way data is input by the user and really only works for seeded data." The
helper is display machinery compensating for fixture debt, and it actively corrupts real values
- it uppercases any token of 3 characters or fewer, so a stored `Step Up` renders `Step UP` and
`Housing Authority of the City of Atlanta` renders with random capitals. The
[[housing-authority-free-text-drift]] issue documents the provenance: slugs entered in commit
`01371194` (M0.3 local-dev fixtures) and were never a product decision.

**Fix, in order (the order matters - deleting the helper first would show raw slugs in demo
worlds):**

1. **Normalize every seed authority value** to the canonical human-readable spellings the
   importer emits (`CANONICAL_AUTHORITY` in `app/src/lib/import/apply.ts` - `Atlanta (AHA)`,
   `DCA`, `Dekalb County Housing`, `Fulton County`, ...). Touches `matrix.ts:73` (the
   `AUTHORITIES` pool - note `gwinnett_housing`/`cobb_housing` have no canonical mapping and
   need spellings decided), `cast.ts`, `lean.ts`, `live.ts`, and both `unit.jurisdiction` seed
   values. Seed-dependent tests follow (`ListingsList.test.tsx:21,32` seed slugs today).
2. **Delete `humanizeAuthority`** and render the stored value as-is in the properties list's
   authority chips - which is what the tenant list (tenant-list-visibility spec) does from day
   one.
3. **Sweep for stragglers**: the e2e `lean` world is byte-stable, so its reseed expectations may
   pin slug values; update in the same change.

**Non-goals.** The two-field-name question (`housingAuthority` vs `jurisdiction`), the agency
split, and production data cleanup all stay with [[housing-authority-free-text-drift]]. This
issue is purely: seeds speak the canonical vocabulary, and the compensating display shim dies.

**Origin.** Filed from the tenant-list-visibility spec gate (Cameron, 2026-08-10). That feature
deliberately does NOT lift or extend the helper - it displays stored values untransformed, so
dev worlds show raw slugs in the tenant list until step 1 lands here.
