---
id: group-threads-across-multiple-tours
title: How to manage group threads across a tenant's multiple concurrent tours (open question)
type: decision
severity: med
status: resolved
area: app
created: 2026-07-01
resolved: 2026-07-17
refs: docs/superpowers/specs/2026-07-01-tours-first-class-entity-design.md, docs/superpowers/specs/2026-07-17-relay-number-lifecycle-design.md, docs/issues/tour-scheduling-off-placement.md
---

**Problem.** In the first-class Tours model, a tenant can have **several tours scheduled at
once** (touring multiple units in the same week), and each tour likely has its own group
thread / masked relay (tenant + that unit's landlord + Team). That raises questions the Tours
feature build deliberately does NOT decide:

- **Numbering:** does each concurrent tour get its own pool number (more numbers per tenant,
  ~$1/mo each), or is there a shared/tenant-level thread with per-tour context?
- **Presentation:** how does the Team (and the tenant) tell the threads apart when several are
  active for the same tenant at the same time? How is the tenant's inbox not confusing?
- **Landlord side:** each landlord sees only their own tour's thread — is that clean, or does a
  landlord with multiple units create ambiguity?
- **Conversion:** when one tour converts to a placement, its thread/number carries over to the
  placement (decided) — but what happens to the *other* concurrent tours' threads (close?
  keep for a re-tour?)?

**Why deferred.** The Tours feature (see the design spec) builds **owner-agnostic** group
threads — a thread can belong to a tour, a placement, or stand alone, and is re-parentable.
That is enough to ship tours with group threads. The *multi-concurrent-tour* UX + numbering
strategy is a larger product/design question that should be decided separately, not baked in
under time pressure during the Tours build.

**Next step.** Product decision on the numbering + presentation strategy for concurrent-tour
threads, then a follow-up design. Filed while specifying the Tours first-class entity.

**Resolution (2026-07-17).** Resolved by the relay-number-lifecycle design. The
numbering strategy is MULTIPLEXING with a permanent (number, person) burn: one
pool number hosts many participant-disjoint relay groups, so a tenant's several
concurrent tours can share ONE number as long as no person repeats on it; the
first roster overlap forces the next number. Closing a group KEEPS its number
(a later text from a closed-group member intercepts into that sender's 1:1
thread with provenance), and idle numbers release back to Twilio only after a
180-day grace, behind a config gate. Presentation/inbox questions are handled by
the existing per-group threads plus the close-ask and Today nag flows. Spec:
docs/superpowers/specs/2026-07-17-relay-number-lifecycle-design.md.
