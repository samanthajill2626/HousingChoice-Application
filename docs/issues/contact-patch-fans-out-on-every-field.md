---
id: contact-patch-fans-out-on-every-field
title: Every contact PATCH rewrites participant_display_name on every linked thread and emits conversation.updated per thread, whatever field changed
type: debt
severity: low
status: open
area: app/contacts
created: 2026-09-27
refs: app/src/routes/contacts.ts:1752-1792, dashboard/src/app/UnreadContext.tsx:287, dashboard/src/routes/contact/useContactMedia.ts:141
---

**Problem.** `PATCH /api/contacts/:contactId` runs its denormalization tail on
EVERY successful update: it recomputes the contact's display name, writes
`participant_display_name` onto each linked conversation, and emits one
`conversation.updated` per thread (`app/src/routes/contacts.ts:1752-1792`). It
does this whether or not a name field changed. Every connected dashboard then
refetches its unread counts (`UnreadContext.tsx:287`), and every open contact
page refetches its media gallery (`useContactMedia.ts:141`).

This predates the staff-notes feature (Sam's item 22), but that feature makes
a notes-only PATCH the most frequent write on a tenant page, so each hand-typed
note now costs N thread writes plus a fan-out of refetches across every open
dashboard. Found by the planner's adversarial review of
`feat/staff-notes-past-tours` (2026-09-27).

**Suggested fix.** Gate the denormalization tail on `changedFields`
intersecting the name-bearing fields (`firstName`, `lastName`, `contactName`,
`type`, `role`) - the parser already reports `changedFields`, so the check is
one line - and skip the per-thread write and emit otherwise. Keep the emit for
a real name change. Add a test that a `notes`-only and a `staff_notes`-only
PATCH write no conversation rows and emit nothing.
