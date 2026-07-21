---
id: email-cc-mirroring
title: CC'd known contacts do not get the email mirrored into their timeline
type: improvement
severity: low
status: open
area: app
created: 2026-07-21
refs: app/src/services/sendEmailMessage.ts, app/src/services/inboundEmail.ts, app/src/routes/contactTimeline.ts
---

**Problem.** Email channel v1 RECORDS CC addresses on the message (`email_cc`) and
DISPLAYS them (the EmailCard "cc ..." line), but a CC is never MIRRORED into the CC'd
party's own conversation timeline. If staff email a landlord and CC a known partner,
the partner's contact page shows nothing - the message lives only in the To-party's
thread. Inbound is the same: a CC on an inbound email is stored and shown but does not
thread into the CC'd contact's history. This is the deliberate v1 scope (spec Decision
10: CC is recorded + displayed only), not a defect - but it means a contact who was
CC'd has an incomplete conversation record.

**Suggested fix (spec Decision 10 follow-up).** When a CC address resolves to a KNOWN
contact, also surface the message on that contact's timeline - either as a true
mirrored message on their conversation or as a lightweight "mirrored (primary thread:
<X>)" reference - so their history is complete, mirroring how a group text surfaces to
each member. Decide the read-model deliberately (a real second message vs a pointer)
so a CC'd thread does not double-count unread or re-trigger fact extraction, and so a
reply from the CC'd party still threads to the right conversation.
