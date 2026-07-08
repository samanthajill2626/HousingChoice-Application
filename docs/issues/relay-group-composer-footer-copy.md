---
id: relay-group-composer-footer-copy
title: Relay-group composer footer reads "Reply sends to this contact" (it fans out to members)
type: improvement
severity: low
status: open
area: dashboard
created: 2026-07-08
refs: dashboard/src/routes/contact/ReplyTargetPicker.tsx:48, dashboard/src/routes/contact/Timeline.tsx:745, dashboard/src/routes/conversation/ConversationDetail.tsx:404, dashboard/src/routes/tours/TourConversation.tsx:220
---

**Problem.** On a relay-group transcript the composer footer reads "Reply sends
to this contact" - but a group send is a team reply that fans out to ALL
members (e.g. tenant + landlord), not to "this contact". The copy comes from
ReplyTargetPicker's no-`replyToPhone` fallback, which Timeline renders
unconditionally under the reply box. Neither relay consumer passes a
reply-target prop, so BOTH show the same imprecise line: ConversationDetail's
RelayGroupView (/conversations/:id) and the tour page's Group tab. Observed
during tour-detail-page live QA (phase 2.5, OBS A); the tour page's 1:1 tabs
were fixed in that wave to show the contact's number (the contact-page
pattern), but the group wording lives in the shared components, out of scope
for a tour-page-only fix.

**Suggested fix.** Give Timeline (or ReplyTargetPicker) a group-aware footer -
e.g. when `relayRoster` is present, say the reply goes to the group's N members
instead of "this contact". Fixes both consumers at once; 1:1 timelines keep the
current wording.
