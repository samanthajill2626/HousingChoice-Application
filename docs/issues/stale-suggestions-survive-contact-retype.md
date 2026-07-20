---
id: stale-suggestions-survive-contact-retype
title: Pending AI suggestions survive a contact re-type; accept routes are not type-gated
type: debt
severity: low
status: open
area: app
created: 2026-07-20
refs: app/src/routes/suggestions.ts:244, app/src/routes/contacts.ts:1255, app/src/services/extraction/apply.ts:216
---

**Problem.** Extraction apply is contact-type-gated (field targets via
fieldApplies, the address target tenant-only), but the suggestion ACCEPT
routes are not: any pending suggestion can be accepted regardless of the
contact's current type. A pending suggestion also survives a contact
re-type (tenant -> landlord/unknown), because the human-edit supersession
loop in the contacts PATCH deletes suggestions keyed by CHANGED FIELD
names, and a re-type changes `type`/`status` - never the suggestion's
target field. Net effect: a stale suggestion (e.g. target `address` or
`voucherSize`) left over from when the contact was a tenant can be
accepted via a direct API call onto a non-tenant, writing the field +
`<field>_source` provenance. UI impact is nil today (only TenantFile
renders the chips), so the surface is API-only and the written attribute
is inert - hence low severity. Found by adversarial review of the
address-extraction branch (2026-07-20); the pattern is shared by ALL
accept targets, not address-specific, which is why it was filed rather
than point-fixed on that branch.

**Suggested fix.** Either (a) type-gate the accept branches to mirror
apply's eligibility rules (tenant-only for address; fieldApplies for the
eight scalars), or (b) delete all pending suggestions for a contact when
its `type` changes (extend the PATCH supersession hook), or both. (b) is
the cleaner invariant: a re-typed contact's pending tenant-profile
suggestions are definitionally stale.
