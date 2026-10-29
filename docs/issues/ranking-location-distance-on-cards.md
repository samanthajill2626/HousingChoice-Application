---
id: ranking-location-distance-on-cards
title: The ranker judges location from addresses alone - add code-computed distances to the cards if Sam's review shows location fit is where rankings miss
type: improvement
severity: low
status: deferred
area: app/matching
created: 2026-10-28
refs: docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md, docs/superpowers/specs/2026-10-28-wp1-b2a-ranking-engine-design.md
---

**Problem.** The WP1 ranker reads only the cards and uses no tools
(charter 7.1). It judges location from what the cards carry: the tenant's
area preference, feedback lines ("too far from work"), the full card of
every home the tenant was sent, and each candidate's address, area and
subzone. That covers broad fit (which side of town), but not exact
distances ("within 2 miles of the tenant's job"). Cameron asked at the
B2a spec gate (2026-10-28) whether the ranker could look up properties
near a place; the answer was no tools in WP1, test how it does, and
revisit if location becomes a bigger issue: "Alright lets try that and
we'll have to do testing to see how that all works. If it becomes a
bigger issue we can retest that."

Why not tools: a web or lookup result is not on a card, so it is not
fingerprinted (out-of-date detection cannot see it); neighborhood
searches surface demographic, school and crime proxies for protected
characteristics (steering), which the counterfactual check cannot test;
search queries would carry tenant data out; and each lookup adds latency
and cost.

**Suggested fix.** If Sam's review (B2b's records, or her acceptance
pass) shows location is where rankings miss: geocode properties (the
subzone work already geocoded most; see subzone auto-fill, tracker #33)
and the place a tenant names, and put each candidate's distance to that
place on its card, computed in code. That is fingerprinted, covered by
the counterfactual check, and cheap. It needs a place field or a way to
read the tenant's named place, which is its own design.
