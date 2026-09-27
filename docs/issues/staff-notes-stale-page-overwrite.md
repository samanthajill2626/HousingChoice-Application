---
id: staff-notes-stale-page-overwrite
title: A Staff notes save from a stale page silently overwrites a colleague's newer note, and the old text is unrecoverable
type: decision
severity: med
status: open
area: dashboard/contact
created: 2026-09-27
refs: dashboard/src/routes/contact/StaffNotesCard.tsx:65-86, app/src/routes/contacts.ts:1521, app/src/routes/contacts.ts:1573, dashboard/src/routes/contact/useContact.ts
---

**Problem.** The Staff notes card (Sam's item 22, spec
`docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md`) saves
through the generic contact PATCH with no version check, and nothing
refreshes `staff_notes` on an open contact page: there is no contact SSE
event, and `useContact` refetches only on `suggestion.updated`. So: staff A
opens a tenant at 9:00; staff B edits the staff notes at 9:10; A, still on the
9:00 page, presses Edit, types, and saves at 9:20 - B's text is gone. The
`contact_updated` audit row records only the field NAME, so the overwritten
text cannot be recovered from anywhere.

The spec accepted last-write-wins deliberately (section 9, Q12: parity with
every other contact field, which has the same race; the AI's own notes append
accepts it too). The planner's adversarial reviewer (2026-09-27) rated it
MEDIUM because, unlike the other free-text fields, this box is the one Sam
asked for precisely to hold hand-typed things that could be important to a
tenant, and a silent loss there is the failure the feature was meant to avoid.
The field already carries what a cheap guard needs: `staff_notes_updated_at`,
server-stamped on every write.

**Suggested fix (product call).** Optimistic concurrency on this ONE field:
the card sends the `staff_notes_updated_at` it loaded with as
`staff_notes_expected_updated_at`; the PATCH route, when that key is present
and differs from the stored stamp, refuses with 409 `staff_notes_stale` and
returns the current contact; the card shows "Someone else changed these notes
- here is the current text" with the newer note and the user's draft side by
side. Nothing else in the PATCH contract changes. Alternatively (cheaper,
weaker) record the previous text in the audit payload so a loss is at least
recoverable. Ask Sam how often two people work one tenant at the same time.
