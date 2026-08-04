---
id: comms-panes-missing-optout-note
title: Placement/tour 1:1 panes never show the Do-Not-Contact standing note
type: improvement
severity: low
status: resolved
area: dashboard
created: 2026-08-03
resolved: 2026-08-04
refs: dashboard/src/routes/placements/PlacementConversation.tsx, dashboard/src/routes/tours/TourConversation.tsx, dashboard/src/routes/contact/Timeline.tsx:197, dashboard/src/routes/contact/Timeline.tsx:1289, dashboard/src/routes/contact/ContactDetail.tsx:430, app/src/services/sendMessage.ts:272
---

**Problem.** The shared `Timeline` composer takes an `optedOut` prop
(Timeline.tsx:197) and, when it is true, renders a standing note above the
composer - "On the Do-Not-Contact list - texting is disabled for this contact"
(Timeline.tsx:1289). Only ContactDetail passes it: it computes
`optedOut = contact.sms_opt_out === true` (ContactDetail.tsx:430) and hands it to
both Timeline mounts.

The placement page's 1:1 panes (PlacementConversation.tsx) and the tour page's
1:1 panes (TourConversation.tsx) never pass `optedOut` at all, so a navigator
working from either of those pages sees a normal composer for a STOP'd contact,
types a reply, and only learns it is refused when the send comes back 409
`contact_opted_out` (sendMessage.ts:272). Nothing is actually sent - this is a
staff-experience gap, not a compliance hole.

Pre-existing (it predates the 2026-08-03 deleted-contact resurfacing work) and
deliberately NOT folded into that mission: the human-approved scope amendment
there covered the DELETED lock only.

**Suggested fix.** Exactly the same plumbing as the deleted flag: both parents
already hold the tenant and landlord `Contact` objects, so compute
`sms_opt_out === true` for the active 1:1 party and pass `optedOut` down to
where each pane renders `Timeline` (alongside the `deleted` prop added on
2026-08-03). Note the note is text-channel copy, so if the pane later gains the
email channel toggle the wording may need a second look.

**Resolution (2026-08-04).** Resolved by feat/contact-comms-pane - the pane
passes optedOut from its effective contact on every surface, so the
Do-Not-Contact note reaches tour/placement 1:1 tabs exactly as on the contact
page. Carried forward, not re-opened: the note's copy is still text-channel
wording ("texting is disabled") even though these tabs now also expose the
email channel toggle, a pre-existing wording question tracked here.
