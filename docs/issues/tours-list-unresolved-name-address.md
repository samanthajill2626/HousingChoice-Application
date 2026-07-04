---
id: tours-list-unresolved-name-address
title: /tours list renders raw tenant/unit IDs instead of a name + address
type: bug
severity: low
status: open
area: dashboard
created: 2026-07-03
refs: dashboard/src/routes/tours/
---

<!--
  Found during browser verification of the seed-now-relative plausibility fix
  (full --seeded profile, isolated lane). Cosmetic; not a deadline/date coherence bug.
-->

**Problem.** On the **/tours** page, some tour rows show the raw entity ID instead
of a human-readable label:

- `tour-mx-scheduled-01` and `tour-mx-confirmed-02` render the tenant as
  **`tenant-mx-searching-standalone-01`** (raw contactId) instead of a name.
- `tour-mx-scheduled-02` renders the property as **`unit-mx-tourable-04`** (raw
  unitId) instead of a street address.

Other rows on the same page resolve correctly (e.g. `tour-mx-requested-01` shows
"Clarence Osei" + a real address), so the list *can* render names/addresses — it
just falls back to the raw ID for certain tours. Looks unpolished when a
navigator clicks through the seeded demo.

**Likely cause (confirm which).** Either (a) the tour points at a tenant/unit that
has no matching seeded `contacts`/`units` row (or one lacking `firstName`/
`lastName`/`address`), so the list has nothing to resolve — a **seed data gap**;
or (b) the /tours list query/component doesn't join the tour's `tenantId`/`unitId`
to the contact name + unit address and shows the id verbatim as a fallback — a
**display gap**. The matrix builds tours from a `searchingTenantIds` pool + an
`availableUnitIds` pool (`app/src/lib/seed/matrix.ts` `buildToursMatrix`); some of
those ids (e.g. `tenant-mx-searching-standalone-01`, the tourable-unit ids) may not
carry a display name/address, which points at (a).

**Suggested fix.** Determine (a) vs (b): check whether
`tenant-mx-searching-standalone-01` and `unit-mx-tourable-04` exist in the seed
with a name/address. If (a), give those seeded pool entities proper
`firstName`/`lastName` + `address`. If (b), have the /tours list resolve
`tenantId`→contact name and `unitId`→unit address (with a graceful "Unknown
tenant"/"(no address)" fallback rather than the raw id). Verify by booting the
full `--seeded` profile and confirming every /tours row shows a name + address.
