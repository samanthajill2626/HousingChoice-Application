# Adversarial Design Review - Round 4

Reviewed the design through `156b2b96`, adjudications, and prior review reports.
The new guarded delete and finalization-handoff rule close the previously accepted
post-write deletion/marker races when the classification route that wrote a
revision is still the latest kind-changing write. A material stale-route hole
remains before that point: the protocol fences deletion, but not the delayed
route's own kind-changing contact update.

## 1. [HIGH] `classification_revision` does not stop an older delayed PATCH from overwriting and draining a newer Unknown epoch

### What is wrong

D11 calls the revision returned by a route's contact update its authority. That is
too late to distinguish request age. A route that read the contact in revision 0
can be delayed before `contacts.update`; a later request can advance the contact
to revision 1, leave it Unknown, and allow a fresh revision-1 type suggestion.
When the older route resumes, its unconditional kind PATCH becomes revision 2.
It is now, by D11's definition, the authority and deletes the revision-1 row as
an "older" suggestion.

Concrete successful trace:

1. R1 begins a card/Edit classification request on an Unknown, revision-0 contact
   and reads its pre-write suggestion snapshot, then pauses before the contact
   write.
2. R2, initiated later, PATCHes `type: 'unknown'` or only `role`. D11 requires
   either shape to advance the revision to 1. Its cleanup completes.
3. Extraction E starts from the new Unknown revision-1 snapshot and writes a
   revision-1 actionable type suggestion S1. Its live check succeeds.
4. R1 resumes. Nothing requires its contact write to match the revision it read,
   so it writes its original Tenant/Landlord/Partner choice and increments the
   contact to revision 2.
5. R1's drain is guarded by its returned revision 2, reads S1 (revision 1),
   successfully cross-table deletes it, and stamps it as human-superseded.

Every read and transaction succeeded. Nevertheless an *older classification
request* overwrote the later retype-to-Unknown and judged/deleted its newer epoch's
actionable suggestion. This directly contradicts D11's claimed ownership rule and
acceptance criterion 12. A fence only on the later delete cannot repair a stale
update that is allowed to become the later committed contact revision.

### Evidence

- D11 increments on every `type` or `role` PATCH, treats the revision returned by
  that update as route authority, and claims a later kind change prevents an older
  request from deleting or judging a later revision's suggestion: spec D11,
  lines 290-345; section 7, lines 486-492; acceptance criterion 12, lines
  626-628. Its prescribed cross-table transaction checks the revision *after* the
  contact update; no decision requires the kind-changing contact update to be
  conditional on the revision observed at request start.
- The current route reads its initial contact and suggestion state, then calls
  `contacts.update(contactId, parsed.patch)` without an expected-version argument:
  `app/src/routes/contacts.ts:1397-1407, 1506-1527`.
- The current repo update similarly conditions only on contact existence, so
  concurrent/delayed PATCHes are last-writer-wins:
  `app/src/repos/contactsRepo.ts:1152-1210`. D11 lists an increment but does not
  specify a new expected-revision condition or stale-update result for that
  operation.
- The spec's proposed delayed-drain test covers a later retype after the older
  route has a returned revision; it does not require the reverse ordering above,
  where the older route is delayed *before* its contact update and therefore
  obtains the later revision: spec section 8.1, lines 545-547.

### What it implies

The kind-affecting contact update must carry and condition on the route's
consistent pre-write `classification_revision` (with absent treated as 0), and the
spec must define the stale-condition result before any status/conversation/audit or
suggestion side effects run. The route needs a distinct conflict/re-read policy;
it cannot silently retry the old intended type as a new authority. Add an
integration test that pauses R1 before its contact update, completes R2's
role-only and retype-to-Unknown cases plus E's new-epoch put, then resumes R1 and
proves R1 neither updates the contact nor deletes/stamps S1.

## Attack surfaces checked without additional material findings

- Legacy absent contact/suggestion classification revisions defaulting to zero,
  and legacy suggestion identity fallback.
- Role-only changes, explicit retype to Unknown, late drains after a newer
  committed kind change, and replacement rows within one epoch.
- Cross-table delete result classification (`deleted`, suggestion changed/absent,
  contact revision changed), consistent reads, CAS ownership transfer, and bounded
  route retries.
- In-flight finalization markers, `putRun` marker merge, extraction-owned dropped
  outcomes, and displaced-run stamping.
- Both dashboard classification writers, generic suggestion behavior, Today, and
  existing non-type replacement semantics.
