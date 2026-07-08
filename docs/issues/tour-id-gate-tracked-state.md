---
id: tour-id-gate-tracked-state
title: Tracked ID-gate state (id_verified_at / code_sent_at) for self-guided tours
type: improvement
severity: low
status: open
area: app/tours
created: 2026-07-08
refs: docs/superpowers/specs/2026-07-08-tour-detail-page-design.md
---

**Problem.** The self-guided tour flow has a hard rule: photo ID before the
lockbox code, always. The tour detail page redesign (2026-07-08) ships this as
a GUIDANCE CARD ONLY - procedural text on the page, no backend state - per the
spec's decision 5 ("Self-guided ID gate: guidance card only (no new backend
gate state); file a follow-up issue for tracked gate state"). Nothing records
WHETHER the VA actually verified ID or when the code went out, so there is no
audit answer to "was the gate honored for this tour?" and no UI affordance
that walks the VA through the two steps in order.

**Suggested fix.** Add tracked, tour-scoped gate state and a checklist UI:

- Fields on the tour (or a small gate sub-object): `id_verified_at` and
  `code_sent_at` (ISO timestamps, set once, operator-attributed).
- PATCH support with the obvious ordering guard (code_sent_at requires
  id_verified_at) mirroring the exit-gate 409 style.
- A two-step checklist on the tour page's Guidance card for self-guided tours
  (check "ID verified" -> unlocks "Lockbox code sent"), each step writing the
  timestamp + a tours# audit milestone so the Activity card tells the story.

Deferred by the 2026-07-08 guidance-card-only decision; revisit when the
self-guided volume makes the manual discipline worth enforcing in data.
