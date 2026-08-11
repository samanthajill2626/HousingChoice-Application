---
id: broadcast-4plus-exact-match-underreach
title: Broadcast "4+ BR" targeting matches ONLY exactly-4 voucherSize while the tenant facet's identical label means >= 4
type: bug
severity: med
status: open
area: app
created: 2026-08-10
refs: app/src/services/audienceResolution.ts, dashboard/src/routes/broadcasts/broadcastFormat.ts, dashboard/src/routes/contacts/tenantFacets.ts
---

**Problem.** Two surfaces share the label `4+ BR` (both via `voucherSizeLabel`,
`broadcastFormat.ts`) with different semantics:

- The tenant-list facet (tenant-list-visibility, 2026-08-10) buckets by `min(voucherSize, 4)` -
  its `4+ BR` chip selects every tenant with voucherSize >= 4 (`tenantFacets.ts`).
- Broadcast audience resolution matches EXACTLY: `voucherSizeOf(contact) !== filter.bedroomSize`
  -> skip (`audienceResolution.ts:143-146`, comment says "exact match"), and the composer's top
  chip sends `bedroomSize: 4`.

So a broadcast targeted `4+ BR` reaches ONLY exactly-4 tenants. A tenant with voucherSize 5 or 6
(the PATCH accepts 0..12) is silently excluded from a send whose label promises to include them -
the same silent-under-reach family as the authority-spelling drift, with the same consequence: a
person does not get told about a property. PRE-EXISTING (this comparison predates the tenant
facet); the facet made the divergence visible by putting the same label on correct >= semantics
one page away.

**Suggested fix.** Make audience resolution treat `bedroomSize: 4` as `>= 4`, mirroring
`min(voucherSize, 4)` bucketing (one-line change + tests), OR cap stored voucherSize at 4 as a
data rule. The first preserves data fidelity; do NOT fix by changing the facet to exact-4, which
would break the truthful-counts contract the tenant list just shipped.

**How it surfaced.** Plan-blind adversarial review of tenant-list-visibility - the reviewer
noticed the facet importing its label from the very module whose consumer disagrees with it.
Related: [[housing-authority-free-text-drift]] (the authority-side under-reach twin).
