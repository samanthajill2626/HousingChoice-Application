---
id: contact-detail-inflight-actions-cross-contact
title: Contact page - a Delete or a create still in flight when staff move to another contact lands on that contact's page
type: bug
severity: low
status: open
area: dashboard
created: 2026-10-21
refs: dashboard/src/routes/contact/ContactDetail.tsx, docs/superpowers/reviews/2026-10-20-property-requirements/code-review/R2-dashboard.md
---

**Problem.** The `/contacts/:contactId` route re-renders the SAME `ContactDetail` instance on a
param change, and resets per-contact state by hand in its contactId effect (property
requirements added the dialog flags to that reset, code review RD-4). But a request started on
contact A and still in flight when staff move to contact B resolves into B's page: a failed
Delete writes "Couldn't delete - please try again." into B's Delete dialog state, and a
successful one navigates away from B to the Contacts list; the New property, New placement and
Schedule a tour `onCreated` handlers likewise navigate to the record created for A from
whatever contact is on screen when the create resolves. `deleteBusy` is not reset either, so B's
Delete / Restore stay disabled until A's request settles. Found by the round-2 dashboard review
of property requirements (R2D-2); the class predates that branch, so it was filed, not fixed.

**Suggested fix.** The generation guard the page already uses for unread state and extraction
(`unreadGenerationRef`, `pressGenerationRef`): capture a generation at the press, drop the
resolution (error, navigation, busy flag) when the contact changed; reset `deleteBusy` with the
other per-contact flags.
