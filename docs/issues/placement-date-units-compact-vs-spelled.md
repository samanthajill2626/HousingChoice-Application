---
id: placement-date-units-compact-vs-spelled
title: Decide compact vs spelled-out relative date units on the placement hub
type: decision
severity: low
area: dashboard
status: open
created: 2026-07-15
refs: dashboard/src/routes/placements/placementsFormat.ts
---

**Problem.** The placement detail hub's date vocabulary renders relative
spans with COMPACT units ("(3d ago)", "(in 15d)", "(in 12h)") because every
verb-phrase formatter composes from one shared coarseSpan bucket, DRY with
the mandated sendRelative ("sends in Nh"). The design spec's examples are
internally inconsistent - the header example spells units out ("(3 days)",
"(18 days)") while its own vocabulary table uses "(in 2d)". The builder chose
compact everywhere; visually confirmed readable, but the founder may prefer
spelled-out units on the header facts line for polish.

**Suggested fix.** Founder taste call. If spelled-out wins: widen coarseSpan
(or add a verbose variant used by the header/card formatters) so "3d" renders
as "3 days" / "12h" as "12 hours" - one function, all placement formatters
inherit it; sendRelative's established "sends in Nh" wording stays as-is
either way. If compact wins: stamp this decision here and normalize the spec
examples the next time that doc is touched.
