---
id: scheduled-sends-to-deleted-contacts-silent-burn
title: Scheduled sends to a soft-deleted contact are silently burned, and the UI still promises them
type: bug
severity: med
status: open
area: app
created: 2026-08-03
refs: app/src/services/scheduledSendSuppression.ts, app/src/jobs/tourReminders.ts:335-386, app/src/services/sendMessage.ts:268-275, app/src/routes/contactTimeline.ts:589, dashboard/src/routes/contact/ScheduledCard.tsx:19
---

**Problem.** The deleted-contact resurfacing feature (2026-08-03) added a send
gate: sendMessage refuses any 1:1 SMS to a soft-deleted contact with
contact_deleted (sendMessage.ts:268-275). That gate is intentional and it fires
for AUTOMATED sends too - tour reminders and placement nudges included. Two
things did not move with it, and together they make a promised send disappear
without a trace anyone sees:

(a) The read-only PREVIEW is out of sync. evaluateScheduledSendSuppression is
what powers the "will not send because ..." note on an upcoming scheduled
message (scheduledSendSuppression.ts, surfaced through contactTimeline.ts into
TimelineScheduled.suppression and the dashboard's ScheduledCard). It knows about
the kill-switch, opt-out, manual mode and stale stage - not about soft deletion.
So a deleted contact's Upcoming section (and the tour's reminder ladder) lists
"Tour reminder - tomorrow 9:00" with NO suppression chip, exactly as it would for
a live contact. Staff are told a message is going out that cannot go out. That
is most visible on the very page this feature was built to make reachable: a
resurfaced deleted contact's timeline.

(b) The jobs CLAIM the work before sending, then swallow the refusal. Tour
reminders stamp sentAt atomically BEFORE the send (claim-before-send,
tourReminders.ts:335-351) and then catch SendRefusedError and return without
retrying ("claim already stamped, not retried", tourReminders.ts:372-386);
placement nudges follow the same pattern. So the new refusal does not DEFER the
reminder, it CONSUMES it - the rung flips to sent, nothing is delivered, and the
only evidence is a warn log. Restoring the contact afterwards does not bring the
rung back.

Net effect: before this branch both reminders would have been delivered; now
neither is, both rungs are burned at their due time, and the product surfaces
none of it.

**Suggested fix.** A later mission - extending the preview was deliberately out
of scope for the resurfacing feature (enforcement was the whole point of the
gate). When picked up: add a contactDeleted input plus a 'contact_deleted'
reason to evaluateScheduledSendSuppression, thread isDeleted(contact) in from
contactTimeline.ts (which already has the contact in hand) and from
app/src/routes/tourReminders.ts:265, and extend the dashboard's two copy maps -
SUPPRESSION_COPY (ScheduledCard.tsx:19) and REMINDER_SUPPRESSION_LABELS (used by
RemindersPanel.tsx:244) - so the chip reads something like "the contact is
deleted - restore them to send". Separately decide
whether a contact_deleted refusal should un-claim the rung (release sentAt) so a
restore inside the window still delivers, rather than burning it.
