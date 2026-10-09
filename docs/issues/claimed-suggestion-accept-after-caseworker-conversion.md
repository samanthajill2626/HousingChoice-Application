---
id: claimed-suggestion-accept-after-caseworker-conversion
title: A claimed housing-authority acceptance can commit after caseworker conversion
type: bug
severity: med
status: open
area: app/extraction
created: 2026-10-08
refs: app/src/services/suggestionResolution.ts:194, app/src/services/suggestionResolution.ts:341, app/src/repos/suggestionResolutionRepo.ts:638, app/src/repos/suggestionResolutionRepo.ts:798, app/src/services/caseworkerConversion.ts:390
---

**Problem.** An authority suggestion acceptance can be claimed while a contact
is a tenant, then apply its contact effect after caseworker conversion. Claiming
atomically deletes the pending sugg# row and creates an active resolve# journal.
The journal is not pending and is outside conversion's byOwner suggestion sweep.
The persisted accept plan guards only housingAuthority and its provenance, not
classification. If both fields were absent when the plan was built, conversion
removes already-absent fields and leaves those guards satisfied. The acceptance
or journal recovery can then add authority and AI provenance to the caseworker.
An existing-caseworker make repair runs only follow-ons, so it will not clear it.

This is distinct from extraction-in-flight-writes-onto-converted-caseworker:
it is a staff acceptance already claimed, with durable recovery, rather than
model output applying against an extraction run-start snapshot. Do not interpret
that issue's explicit approved deferral as covering this writer automatically.

**Evidence and limits.** Independent review records the exact source-derived
claim -> convert -> domain-commit/recovery schedule in
`docs/superpowers/reviews/2026-10-07-caseworkers/code-review-adversarial-r2.md`
(R2-ADV-1). No runtime reproduction was executed; the predicted outcome has not
been observed in a test or live system. The pending sweep itself satisfies its
defined boundary. The Caseworkers parent adjudicated this as a separate follow-up,
not a repaired defect or a proven regression in the PATCH fix. It remains visible
for the human merge decision. Other tenant facts intentionally remain stored on
converted contacts and the partner page hides them; the narrow concern here is
housing authority being added after its explicit conversion cleanup.

**Suggested work.** First pin the exact paused-claim and recovered-journal
schedules with a deterministic regression. Decide whether pre-conversion claimed
accepts should be abandoned after reclassification. If so, persist and atomically
guard their raw originating classification, handling already-created active
journals and real/fake parity. A fresh pre-commit read alone leaves a race. Do not
silently cancel unrelated accepted phone/address edits or make a claim of atomic
coordination across all conversion follow-ons. Until addressed, an affected
authority must be cleared explicitly; make-again does not clear it.

**Review qualification.** R2 retains P2 priority. Claim records durable intent; it does not mean the contact effect or successful response already happened. Durable recovery may perform the write later. The absence of a runtime reproduction is an evidence limit, not evidence of low likelihood. The independent adjudication response is in code-review-adjudication-response-r2.md in the same mission records directory.

**Planner review update (2026-10-09): reproduced.** The schedule above has now
been executed, in both forms, against the FakeWorld routes and against the real
repositories on DynamoDB Local: a claim paused at the `claimed` boundary that
resumes after the conversion, and a claim that crashes there and is recovered
by an ordinary suggestions read (`recoverAbandoned`). Every run ends with the
converted partner/Caseworker holding "Atlanta Housing Authority" plus AI
provenance; a second `make` leaves it. Filter-resolved blasts still exclude the
contact (they fence `type === 'tenant'`). Exact results and limits are in
`docs/superpowers/reviews/2026-10-07-caseworkers/planner-final-review.md`
section 4. The "no runtime reproduction" limit above is superseded; severity,
priority and the scope decision are unchanged and remain Cameron's call.
