---
id: retire-humanize-authority
title: Remove the unit PATCH tombstones for jurisdiction and accepted_programs (seed slugs and humanizeAuthority are done)
type: debt
severity: low
status: open
area: app
created: 2026-08-10
updated: 2026-10-07
refs: app/src/lib/seed/matrix.ts, app/src/lib/seed/cast.ts, app/src/lib/seed/lean.ts, app/src/lib/seed/live.ts, app/src/lib/import/apply.ts, app/src/lib/unitFields.ts, app/src/routes/units.ts
---

**Progress (2026-10-07): steps 1 and 3 are DONE by `feat/clean-org-names` (tracker #2),
so step 4 is all that remains.** Every seed - lean, full cast, matrix, live and
performance, the seeded broadcast filters and the landlord-only `authorities_served`
included - now writes NAMES from the organization list (the `org-list` settings item;
the slug mapping is in section 7 of
`docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`), and the
e2e specs that read the lean world were updated with it. Step 1's target changed on the
way: seeds speak the stored list's names, not the retired `CANONICAL_AUTHORITY`
spellings. The one-time cleanup script (`app/scripts/clean-org-names.ts`) backfills
`accepted_authorities` from a legacy `jurisdiction`, so once it has run in an environment
no stored unit depends on the read-time synthesis. Step 4 stays open: `TOMBSTONED_FIELDS`
and `sawTombstone` in `app/src/lib/unitFields.ts`, and the retired-fields-only no-op return
of the unit PATCH in `app/src/routes/units.ts`, still accept-and-discard the retired
`jurisdiction` / `accepted_programs` keys, until no deployed dashboard bundle predates the
accepted-authorities consolidation. Severity lowered to low and area moved to app: what
remains is a small app-side deletion with no user-facing effect.

**Progress (2026-10-01): step 2 is DONE, ahead of step 1, by Cameron's decision.**
`feat/properties-available-view` (tracker #1) deleted `humanizeAuthority`; the properties list's
authority chips and its new by-authority summary both show the STORED spelling, the same as the
tenant list. The trade-off the original ordering avoided is now accepted: demo and e2e worlds
show raw seed slugs (`atlanta_housing`, `ga_dca`) on the properties list too, exactly as the
tenant list already did. What remains - step 1 (seed values to canonical names), step 3 (lean
stragglers) and step 4 (the PATCH tombstones) - belongs with tracker #2 (one clean name per
housing authority), which builds the master name list these seeds should speak. The original
report follows; its line numbers predate the deletion.

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
4. **Delete the PATCH tombstones** (added 2026-08-10 by tenant-list-visibility):
   `TOMBSTONED_FIELDS` in `app/src/lib/unitFields.ts` accepts-and-discards the retired
   `jurisdiction` / `accepted_programs` keys plus the `sawTombstone` no-op path in
   `app/src/routes/units.ts`, so a stale cached dashboard bundle's save does not 400 during the
   transition. The code comments name THIS issue as their end-of-life; once no deployed bundle
   predates the consolidation, remove the tombstones so an unknown field surfaces loudly again.

**Non-goals.** The two-field-name question (`housingAuthority` vs `jurisdiction`), the agency
split, and production data cleanup all stay with [[housing-authority-free-text-drift]]. This
issue is purely: seeds speak the canonical vocabulary, and the compensating display shim dies.

**Origin.** Filed from the tenant-list-visibility spec gate (Cameron, 2026-08-10). That feature
deliberately does NOT lift or extend the helper - it displays stored values untransformed, so
dev worlds show raw slugs in the tenant list until step 1 lands here.
