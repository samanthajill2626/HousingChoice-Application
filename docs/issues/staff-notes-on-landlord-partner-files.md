---
id: staff-notes-on-landlord-partner-files
title: Staff notes card exists only on the tenant file; landlord and partner files may want it too
type: improvement
severity: low
status: open
area: dashboard/contact
created: 2026-09-26
refs: dashboard/src/routes/contact/TenantFile.tsx, dashboard/src/routes/contact/LandlordFile.tsx, dashboard/src/routes/contact/PartnerFile.tsx
---

**Problem.** Sam's improvements list item 22 asked for a manual notes box
"separate from Call preferences & notes" for tenants, and the mission that
built it (spec `docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md`,
section 3.6-3.7) put the "Staff notes" card on the TENANT file only. The
`staff_notes` field itself is on every contact record and the PATCH route
accepts it for any contact type, so the server side is already type-agnostic;
only the dashboard card is tenant-only.

Landlord and partner files render the same AI-appended "Preferences & notes"
card (`LandlordFile.tsx`, `PartnerFile.tsx`), so the same drift Sam described
(hand-written reminders mixed into an auto-captured field) can happen there
too: "prefers calls after 5", "owner's brother handles showings".

**Suggested fix.** Render `StaffNotesCard` on `LandlordFile` and `PartnerFile`
(and decide about `UnknownFile`) above their "Preferences & notes" cards, wired
to the same `onContactUpdated` prop. The card is self-contained, so this is a
small change; the open question is product, not code: does Sam want it there?
Ask before building.

**Note (build research, 2026-09-27).** The PATCH is not type-gated, so a tenant
who is later retyped to landlord, partner, team member or unknown KEEPS the
stored `staff_notes` and its stamp, but no file renders them until the contact
is retyped back to tenant (or this issue is built). Nothing is lost; the box is
merely invisible on the other kinds.
