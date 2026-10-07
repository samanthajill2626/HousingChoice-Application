---
id: ai-extraction-fills-agency
title: The AI never fills a tenant's Agency, even when the conversation names one
type: improvement
severity: low
status: open
area: app/extraction
created: 2026-10-07
refs: app/src/services/extraction/apply.ts, app/src/services/extraction/orgListBlock.ts
---

**Problem.** Conversation fact extraction writes or suggests a tenant's housing authority
(clean-org-names, spec D8) but never their Agency (`contact.agency`), even when the
tenant names one ("my caseworker at HOPE Atlanta"). The extraction prompt's organization
list block already names the agencies (as "not housing authorities"), and the apply
layer DROPS an agency name returned for the housing authority (drop reason
`agency_not_authority`, shown as "Agency, not a housing authority") - so the fact is seen
and then discarded.

**Suggested fix.** Add `agency` as an extractable field: resolve the returned text with
the same rules against the agency list (`app/src/lib/orgNames.ts`), write or suggest an
exact agency name under the op rules the housing authority uses, and turn an
`agency_not_authority` drop into an agency suggestion when the field is empty. Anything
not on the list stays a staff suggestion, as for the housing authority. A spec non-goal
for clean-org-names (section 2); Work Package 2 may revisit.
