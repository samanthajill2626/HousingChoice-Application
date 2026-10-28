---
id: contact-edit-form-notes-save-drops-auto-lines
title: A Notes box edit saved from an open contact form erases extraction lines appended while it was open
type: bug
severity: low
status: open
area: dashboard/contact
created: 2026-10-27
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
