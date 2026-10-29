---
id: contact-edit-form-notes-save-drops-auto-lines
title: A Notes box edit saved from an open contact form erases extraction lines appended while it was open
type: bug
severity: low
status: resolved
area: dashboard/contact
created: 2026-10-27
updated: 2026-10-29
resolved: 2026-10-29
refs: dashboard/src/routes/contact/ContactEditForm.tsx:183, dashboard/src/routes/contact/ContactEditForm.tsx:228, dashboard/src/routes/contact/ContactEditForm.tsx:379, app/src/routes/contacts.ts:642, app/src/services/extraction/apply.ts:713
---

**Problem.** The contact edit form keeps the contact AS OPENED
(`const [base] = useState(contact)`, ContactEditForm.tsx:183), seeds the Notes
textarea from it (:228) and, when the text differs from `base.notes`, sends
the WHOLE box (:379); the PATCH stores it verbatim (contacts.ts:642-646). So
every `[Auto - <date>]` line extraction appended while the form was open is
erased by a save that touched the notes, with nothing to recover it from (the
`contact_updated` audit row records field names only).

This is pre-existing and inside the accepted last-write-wins class for contact
fields (see staff-notes-stale-page-overwrite, spec Q12), but WP1 B1 raises its
cost: from B1 the Notes box carries the matching facts extraction writes and
the feedback lines B2 attaches to each sent property. Same failure shape as
import-overwrites-notes-box. Found by the WP1 B1 build research (reader E1,
2026-10-27); not in B1's scope.

**Suggested fix.** Product call. Either follow the staff_notes stale-save
guard precedent (`staff_notes_expected_updated_at`, contacts.ts:1980-1987):
the form sends a version of the box it opened with and the PATCH refuses with
409 when the stored box changed since; or merge server-side, keeping the lines
the stored box gained after the form opened.

**Resolution (2026-10-29).** WP1 B2a (spec D14.3) took the staff_notes
precedent. Every Notes writer stamps `notes_updated_at` in the same write as
the box (the contacts PATCH, manual create, extraction apply and the
importer's overwrite); a client cannot write the stamp. The edit form sends
`notes_expected_updated_at` - the stamp it opened with, or null for a box
never stamped - whenever it sends `notes`; the PATCH refuses a stale save
with 409 `notes_stale` and the current contact (when another guard also
refused, `notes_stale` only if the Notes stamp moved; `staff_notes_stale`
wins when both moved). On `notes_stale` the form keeps every typed field and
shows, directly above the Notes box, the copy as built
(`NOTES_STALE_COPY`, `dashboard/src/routes/contact/ContactEditForm.tsx`):
"Nothing was saved. These notes were changed since you opened this form.
The current notes are below, and your text is still in the box. Save again
to replace them, or Cancel to keep them." with the current notes below it.
Pinned by `app/test/contactNotesGuard.test.ts` (the PATCH guard),
`dashboard/src/routes/contact/ContactEditForm.test.tsx` (the form) and
`e2e/tests/dashboard-next/contact-notes-conflict.spec.ts` (end to end, from
a stale page). The importer and extraction still overwrite or append without
a guard (import-overwrites-notes-box stays open).
