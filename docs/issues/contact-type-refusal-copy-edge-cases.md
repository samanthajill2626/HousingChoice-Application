---
id: contact-type-refusal-copy-edge-cases
title: Contact-type refusal and restore copy misreads four edge cases
type: improvement
severity: low
status: open
area: dashboard
created: 2026-10-12
updated: 2026-10-13
refs: dashboard/src/lib/holdingRefusals.ts:35, app/src/services/contactHoldings.ts:137, dashboard/src/routes/listing/RestoreLandlordDialog.tsx:75, dashboard/src/routes/listing/RestoreLandlordDialog.tsx:82, dashboard/src/routes/listing/ListingDetail.tsx:371, dashboard/src/routes/listing/ListingDetail.tsx:1434, app/src/routes/units.ts:1769, app/src/routes/units.ts:1779, app/src/routes/units.ts:1799, app/src/routes/units.ts:1887
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
2. **The restore dialog closes as a success when the server ignored the
   choice (dashboard finding 3; backend finding 10).** The restore route
   honors `{ landlordId }` only when the plain restore would refuse
   (`app/src/routes/units.ts:1727-1737`). If the stored landlord became a
   landlord again (or someone restored the property) between the 409 and the
   click, the dialog's request runs the PLAIN restore and answers 200 with the
   OLD landlord of record, in the plain path's raw shape (`:1799`) rather than
   the body path's enriched roster (`:1887`). The dialog closes
   (`dashboard/src/routes/listing/RestoreLandlordDialog.tsx:75`,
   `dashboard/src/routes/listing/ListingDetail.tsx:1434-1437`) and nothing
   tells staff their choice was not applied; the page then shows the real
   landlord. Related: after a `unit_roster_conflict` re-read that is still
   deleted (`ListingDetail.tsx:1438-1452`) the dialog keeps its first sentence
   even if the stored landlord changed. Ignoring the body is spec section 4
   ("a body is ignored when the plain restore applies"). Direction: compare
   the answer with the request in the dialog and show a page notice that
   names the outcome, or have the route say so (for example
   `landlordChoice: 'ignored'`) and enrich both answer shapes.

   **Replaced by fix wave FWF-1 (2026-10-13; final review A2, spec revision
   6).** The dialog no longer closes as a success when the plain restore
   would apply: a body that arrives then answers 409 `unit_roster_conflict`
   and writes nothing - no restore, no `unit_restored` audit
   (`app/src/routes/units.ts:1779-1786`). The dialog shows "The property
   contacts changed - try that change again." and re-reads the property
   (`RestoreLandlordDialog.tsx:82-84`, `ListingDetail.tsx:1438-1452`). When
   someone else restored it meanwhile, the re-read is live, so the dialog
   closes and the page shows the property as it now is. When instead the
   stored landlord became a landlord again while the dialog was open, the
   re-read is still deleted: the dialog stays open, with its first sentence
   (now false) and the retry sentence, and either restore action answers the
   same 409 on every retry until Cancel (`ListingDetail.tsx:1453`); the
   banner's Restore then sends the plain restore, which restores the property
   with its stored landlord (`ListingDetail.tsx:371-388`). That still-deleted
   behavior was kept as is by the fix wave's brief.
3. **Any other plain-restore failure is still a dead click (dashboard finding
   4; behavior from before the branch).** A 404 or 500 on the property page's
   Restore re-enables the button with no message
   (`ListingDetail.tsx:371-388`, the "any other failure" branch at `:385`);
   the W7 pins (`dashboard/src/routes/listing/ListingDetail.test.tsx:1530-1554`)
   assert only that no dialog opens. Spec section 4 / watch item W7 kept each
   site's current copy on purpose. Direction: a `role="alert"` "Couldn't
   restore - please try again." in the Deleted banner, sharing
   `RESTORE_FAILED_COPY` (`RestoreLandlordDialog.tsx:22`).
4. **"no longer a landlord" for a landlord contact that no longer exists
   (dashboard finding 10).** The server answers `restore_needs_landlord` with
   no name when the stored contact is missing
   (`app/src/routes/units.ts:1769-1771`), and the dialog then says "This
   property's landlord is no longer a landlord, so they can't stay ..."
   (`RestoreLandlordDialog.tsx:92`, `:122`; pinned by
   `dashboard/src/routes/listing/RestoreLandlordDialog.test.tsx:64`) - the
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
`primaryPromoted { to }`; `app/src/routes/units.ts:1867-1874`), so the label is
not false, but the one place staff can later see that a restore changed who
owns or answers for the property does not say it. Direction: a sub line such
as "Landlord changed" / "Landlord cleared" - new copy, and the Activity
projection would also have to carry the fields (its fixed-key whitelist drops
them today, `app/src/routes/units.ts:244`). The spec asks only for the audit
fields, so nothing was changed.
