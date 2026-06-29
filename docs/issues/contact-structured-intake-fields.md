---
id: contact-structured-intake-fields
title: Contacts have no first-class eligibility-intake fields (pets/evictions/tenure/LIF)
type: improvement
severity: med
status: in-progress
area: app
created: 2026-06-29
refs: app/src/repos/contactsRepo.ts:56, app/src/routes/contacts.ts:219, dashboard/src/routes/contact/ContactEditForm.tsx
---

**Problem.** The tenant-onboarding sequence records an eligibility intake (pets,
evictions, time at current address, LIF-eligibility) before the RTA gate, but the
contact has no first-class fields for it — only the generic `customFields` bag, which
is untyped and not reportable/filterable. The conformance audit (tenant-onboarding
e2e) confirmed the edit form exposes no such fields. A diagram step the app cannot
satisfy is a real gap.

**Suggested fix.** Add free-text `pets`/`evictions`/`tenure` + boolean `lifEligible`
as first-class optional fields on the contact: schema (`contactsRepo` ContactItem),
API validation (`contacts.ts` parseCreateBody/parseTriageBody), dashboard types, and a
tenant-only "Eligibility intake" fieldset in `ContactEditForm`. Being built in Phase B
of the sequence-diagram→e2e plan
(`docs/superpowers/plans/2026-06-29-sequence-diagram-e2e-scenarios.md`).
