---
id: group-threads-across-multiple-tours
title: How to manage group threads across a tenant's multiple concurrent tours (open question)
type: decision
severity: med
status: open
area: app
created: 2026-07-01
refs: docs/superpowers/specs/2026-07-01-tours-first-class-entity-design.md, docs/issues/tour-scheduling-off-placement.md
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
