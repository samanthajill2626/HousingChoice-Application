---
id: contact-structured-intake-fields
title: Contacts have no first-class eligibility-intake fields (pets/evictions/tenure/LIF)
type: improvement
severity: med
status: resolved
area: app
created: 2026-06-29
resolved: 2026-06-29
refs: app/src/repos/contactsRepo.ts:56, app/src/routes/contacts.ts:219, dashboard/src/routes/contact/ContactEditForm.tsx
---

**Problem.** The tenant-onboarding sequence records an eligibility intake (pets,
evictions, time at current address, LIF-eligibility) before the RTA gate, but the
contact has no first-class fields for it — only the generic `customFields` bag, which
is untyped and not reportable/filterable. The conformance audit (tenant-onboarding
e2e) confirmed the edit form exposes no such fields. A diagram step the app cannot
satisfy is a real gap.

**Resolution (2026-06-29).** Added free-text `pets`/`evictions`/`tenure` + boolean
`lifEligible` as first-class optional fields on the contact: schema (`contactsRepo`
ContactItem), API validation (`contacts.ts` parseCreateBody/parseTriageBody), dashboard
types, and a tenant-only "Eligibility intake" fieldset in `ContactEditForm`. Backed by
`app/test/contactIntakeFields.test.ts` and asserted by the tenant-onboarding e2e
scenarios. Shipped in the sequence-diagram→e2e merge (`964c87e`).

**Follow-up — DONE (2026-06-30).** The fields are no longer write-only. A tenant-only
"Eligibility intake" section now renders pets / evictions / time at current address /
LIF eligible in the Details pane (`dashboard/src/routes/contact/EligibilityIntakeCard.tsx`,
rendered by `TenantFile.tsx`), omitting empty fields and hiding entirely when none are
recorded. Backed by `EligibilityIntakeCard.test.tsx`, and the tenant-onboarding e2e
verbs (`expectTenantDetails` / `expectIntakeRecorded`) now assert the rendered Details
panel + intake rows in addition to the API read-back. Shipped on
`chore/onboarding-scenario-touchups`.
