---
id: park-reason-prompt-on-pill
title: Parking a landlord via the status pill captures no park_reason - consider a reason prompt
type: improvement
severity: low
status: open
area: dashboard
created: 2026-07-08
refs: dashboard/src/routes/contact/ContactDetail.tsx, app/src/services/statusTransition.ts
---

**Problem.** The contact header's interactive status pill moves a landlord to the
terminal `parked` status with no reason (the transition service's `reason` field
is optional and the pill never sends one). `park_reason` exists specifically to
record WHY a lead was declined/not-a-fit/never-signed - a reason-less park loses
that context. The immediate hazard (a reason-less re-park silently INHERITING a
stale reason from an earlier park) is fixed: the service now clears `park_reason`
when parking without a reason. What remains is the product question of whether
parking should prompt for a reason at all.

**Suggested fix.** Gate the pill's `parked` selection behind a small reason
prompt (optional free text, skippable), mirroring how the placement pill gates
`lost` behind the LostReasonModal - the pill's onChange already supports parent-
owned gating, so this is a ContactDetail-level modal, not a StatusMenu change.
Decide first whether the reason should be required, optional, or skipped; the
Edit-contact form path has the same gap and should match.
