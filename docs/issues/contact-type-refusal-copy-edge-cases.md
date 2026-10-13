---
id: contact-type-refusal-copy-edge-cases
title: Contact-type refusal and restore copy misreads four edge cases
type: improvement
severity: low
status: open
area: dashboard
created: 2026-10-12
updated: 2026-10-13
refs: dashboard/src/lib/holdingRefusals.ts:35, app/src/services/contactHoldings.ts:137, dashboard/src/routes/listing/RestoreLandlordDialog.tsx:82, dashboard/src/routes/listing/RestoreLandlordDialog.tsx:90, dashboard/src/routes/listing/ListingDetail.tsx:386, dashboard/src/routes/listing/ListingDetail.tsx:779, dashboard/src/routes/listing/ListingDetail.tsx:1479, app/src/routes/units.ts:1773, app/src/routes/units.ts:1784, app/src/routes/units.ts:1804, app/src/routes/units.ts:1892
---

**Problem.** Four edge cases in the copy `fix/caseworker-integrity` added
around contact-type refusals and the property restore, found by its R1 code
review (dashboard findings 2, 3, 4 and 10; backend finding 10). Each is either
spec-approved copy or behavior from before the branch that it kept on purpose,
so none was changed there, and all are rare.

1. **"so they must stay a landlord" for a contact that is not a landlord
   (dashboard finding 2).** The server refuses every result type but
   `landlord` for the landlord of record of a live property, whatever the
   stored type (`app/src/services/contactHoldings.ts:137-141`), and the
   dashboard shows `TYPE_CHANGE_LANDLORD_SENTENCE`
   (`dashboard/src/lib/holdingRefusals.ts:35-36`, via
   `typeChangeRefusalCopy` at `:70`) on the Unknown card
   (`dashboard/src/routes/contact/UnknownFile.tsx:158`) and in the edit form
   (`dashboard/src/routes/contact/ContactEditForm.tsx:609`). When the landlord
   of record is typed `unknown`, `tenant` or `partner` - only data from
   before the branch or from the importer, which already breaks I3 (spec L2;
   `import-bypasses-contact-type-rules`) - "must stay a landlord" is false.
   The sentence is the spec's own (section 3). Direction: a type-neutral
   sentence ("...so they can only be a landlord. ...") or "stay" only when the
   stored type is `landlord`.
   Raised again by the final review's round 2 (R2-5,
   `docs/superpowers/reviews/2026-10-12-caseworker-integrity/final-review/adversarial.md`;
   ruled DEFER to this item in `final-review/adjudications.md` "## Round 2"):
   the same case, seen from the Unknown card's "Mark as Tenant" on such a
   contact - the action that unblocks staff, Mark as Landlord, is not named.
2. **The restore dialog closes as a success when the server ignored the
   choice (dashboard finding 3; backend finding 10).** The restore route
   honors `{ landlordId }` only when the plain restore would refuse
   (`app/src/routes/units.ts:1727-1737`). If the stored landlord became a
   landlord again (or someone restored the property) between the 409 and the
   click, the dialog's request runs the PLAIN restore and answers 200 with the
   OLD landlord of record, in the plain path's raw shape (`:1804`) rather than
   the body path's enriched roster (`:1892`). The dialog closes
   (`dashboard/src/routes/listing/RestoreLandlordDialog.tsx:82`,
   `dashboard/src/routes/listing/ListingDetail.tsx:1460-1463`) and nothing
   tells staff their choice was not applied; the page then shows the real
   landlord. Related: after a `unit_roster_conflict` re-read that is still
   deleted (`ListingDetail.tsx:1464-1478`) the dialog keeps its first sentence
   even if the stored landlord changed. Ignoring the body is spec section 4
   ("a body is ignored when the plain restore applies"). Direction: compare
   the answer with the request in the dialog and show a page notice that
   names the outcome, or have the route say so (for example
   `landlordChoice: 'ignored'`) and enrich both answer shapes.

   **Replaced by fix waves FWF-1 and FWF2 (2026-10-13; final review A2 and
   round 2 R2-1, spec revisions 6 and 7).** The dialog no longer closes as a
   success when the plain restore would apply: a body that arrives then
   answers 409 `restore_landlord_not_needed` and writes nothing - no restore,
   no `unit_restored` audit (`app/src/routes/units.ts:1784-1791`). The dialog
   closes with no alert (`RestoreLandlordDialog.tsx:90-93`) and the page
   re-reads the property (`ListingDetail.tsx:1479-1497`). When someone else
   restored it meanwhile, the re-read is live and the page shows the property
   as it now is. When instead its stored landlord became a landlord again (or
   it is ownerless) while the dialog was open, the re-read is still deleted
   and the deleted banner says "This property's landlord changed while you
   were choosing. Choose Restore again." (`ListingDetail.tsx:779-789`; also
   when the re-read fails), until the next Restore press clears it
   (`ListingDetail.tsx:390`). The plain restore is never re-run
   automatically: it would override the choice staff made. FWF-1 first
   answered that body with `unit_roster_conflict`, which the dialog reads as
   "try that change again": with a still-deleted re-read the dialog stayed
   open and every retry got the same 409 until Cancel (round 2 R2-1). The
   distinct code ends that loop; `unit_roster_conflict` keeps meaning "the
   contact list or landlord changed, retry".
3. **Any other plain-restore failure is still a dead click (dashboard finding
   4; behavior from before the branch).** A 404 or 500 on the property page's
   Restore re-enables the button with no message
   (`ListingDetail.tsx:386-405`, the "any other failure" branch at `:402`);
   the W7 pins (`dashboard/src/routes/listing/ListingDetail.test.tsx:1715-1739`)
   assert only that no dialog opens. Spec section 4 / watch item W7 kept each
   site's current copy on purpose. Direction: a `role="alert"` "Couldn't
   restore - please try again." in the Deleted banner, sharing
   `RESTORE_FAILED_COPY` (`RestoreLandlordDialog.tsx:22`).
4. **"no longer a landlord" for a landlord contact that no longer exists
   (dashboard finding 10).** The server answers `restore_needs_landlord` with
   no name when the stored contact is missing
   (`app/src/routes/units.ts:1773-1775`), and the dialog then says "This
   property's landlord is no longer a landlord, so they can't stay ..."
   (`RestoreLandlordDialog.tsx:104`, `:134`; pinned by
   `dashboard/src/routes/listing/RestoreLandlordDialog.test.tsx:66`) - the
   contact is gone, not re-typed. Rare: contacts soft-delete and `getById`
   still returns them. The sentence is the spec's (section 4). Direction:
   neutral copy, for example "This property's landlord can't stay its
   landlord. Choose its landlord:".

**Suggested fix.** Decide each direction above with Cameron (items 1, 2 and 4
change spec-approved sentences); each change needs a dashboard test that
fails on the old behavior.

**Related: the Activity row for a restore that changed the landlord (R2 code
review, dashboard finding A7; fix wave 2 FW2-10).** The property's Activity
card reads a bare "Property restored" for every `unit_restored` row
(`dashboard/src/routes/listing/listingFormat.ts:229-230`), including a restore
that replaced the landlord of record, one that cleared it, and one that
cleared it and made the sole remaining contact typed landlord the primary
contact (spec revision 5). The audit row carries each outcome
(`landlordReplaced { from, to }`, `landlordCleared { from }`,
`primaryPromoted { to }`; `app/src/routes/units.ts:1872-1879`), so the label is
not false, but the one place staff can later see that a restore changed who
owns or answers for the property does not say it. Direction: a sub line such
as "Landlord changed" / "Landlord cleared" - new copy, and the Activity
projection would also have to carry the fields (its fixed-key whitelist drops
them today, `app/src/routes/units.ts:244`). The spec asks only for the audit
fields, so nothing was changed.
