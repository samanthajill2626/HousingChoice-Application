---
id: similar-units-authority-score-always-on
title: The similar-unit authority dimension is now always-on, so the zero-score drop stops firing in single-market data
type: improvement
severity: low
status: open
area: app
created: 2026-08-10
refs: app/src/lib/similarUnits.ts:103,app/src/lib/similarUnits.ts:175
---

**Problem.** The similar-unit ranker's authority-overlap dimension carries weight 0.20. Before the
tenant-list-visibility feature it was effectively DEAD: it scored `accepted_programs`, which no
seed and no writer ever populated, so it contributed 0 to every candidate. The feature repointed it
at `authoritiesOf()`, which SYNTHESIZES an authority from a legacy `jurisdiction` value, so every
seeded and every imported unit now has at least one - the dimension is live for the whole corpus.

Spec section 8 states and defends the intended consequence (Cameron's ruling: "the program list WAS
the authority list all along, so this is a rename, not a semantic change", with similar-unit
rankings expected to shift in demo worlds). What it does NOT state is this second-order effect: in
data where every unit shares the same authority - a single-market deployment, which is today's
reality - the dimension contributes a CONSTANT 0.20 to every candidate. That is enough to keep a
genuinely dissimilar unit above the ranker's `matchPct === 0` drop, so a unit with the wrong bed
count, the wrong area and a far-off rent can still surface as a 20% "Similar property" instead of
being dropped. The 0%-drop becomes dead code in exactly the data shape that matters.

Not fixed during the feature build because every available remedy is product policy the change was
not entitled to invent - whether a dimension on which all candidates tie should contribute at all
is a ranking decision, not a defect repair. No unit test or e2e can catch it either: the suites
score fixtures with DELIBERATELY differing authorities, which is the case where the dimension is
meaningful.

**Suggested fix.** Decide the policy, then pin it. The most likely shape: treat a dimension on
which every candidate scores identically as non-discriminating and exclude it from that ranking's
weighted total (renormalizing the remaining weights), so the 0%-drop recovers its meaning in
single-market data while multi-authority data keeps the signal. Pin with a fixture where all
candidates share one authority and one candidate is otherwise a total mismatch: it should drop, not
rank.

Found by the adversarial reviewer (finding F2) during the tenant-list-visibility mission.
