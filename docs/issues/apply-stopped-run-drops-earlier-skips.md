---
id: apply-stopped-run-drops-earlier-skips
title: Apply to properties - a run that stops on a later batch never reports the properties the earlier batches skipped
type: improvement
severity: low
status: open
area: dashboard
created: 2026-10-21
refs: dashboard/src/routes/contact/ApplyRequirementsDialog.tsx, dashboard/src/routes/contact/applyRequirementsModel.ts, docs/superpowers/reviews/2026-10-20-property-requirements/code-review/R1-adversarial-dashboard.md
---

**Problem.** The landlord page's Apply to properties dialog (property requirements, spec
`docs/superpowers/specs/2026-10-20-property-requirements-design.md` D8) sends the checked
properties in requests of at most 100, one after another. When a LATER request fails or answers
409, the dialog stops, re-reads, and says "Updated N properties before this stopped. Review the
rest and press Update again." - N from the responses that landed, exactly as D8 specifies. The
`skipped` entries of those landed responses are dropped: a property skipped as
`landlord_changed`, `deleted` or `not_found` is no longer in the re-read list at all, so staff
never learn it was skipped or why. The done path (no stop) lists every skip with its reason on
the landlord's Requirements / Qualifications card; the stopped path does not. Rare (it needs more
than 100 checked properties and a failing later request). Found by the plan-blind dashboard
review (RD-3), filed rather than fixed because the spec defines the stopped message.

**Suggested fix.** Carry the merged skips of the landed responses into the stopped notice (the
same `<address> - <reason>` lines the done summary uses, under an "M skipped" line), or hand
them to the page with the summary callback so the card shows them after the dialog closes.
