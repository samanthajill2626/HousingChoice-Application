---
id: outbound-voice-ignores-deleted-contacts
title: Outbound voice calls have no soft-deleted-contact gate
type: bug
severity: med
status: open
area: app
created: 2026-08-03
refs: app/src/services/originateCall.ts:108, app/src/services/sendMessage.ts, app/src/routes/inbox.ts:437-448, docs/superpowers/specs/2026-08-03-deleted-contact-resurfacing-design.md
---

**Problem.** The deleted-contact resurfacing feature (2026-08-03) added
belt-and-braces send guards refusing 1:1 SMS and email to soft-deleted
contacts (409 contact_deleted), mirroring the locked dashboard composer. The
outbound VOICE path has no equivalent: originateCall never checks isDeleted,
so staff can still dial-through to a soft-deleted contact (e.g. from a stale
tab, or any Call affordance that stays reachable while deleted). The spec
deliberately deferred calls (Decision 5: calls do not bump unread or
last-activity for any contact today, tracked in
inbound-calls-invisible-in-inbox.md), but that decision covers INBOUND call
surfacing - the outbound-call guard was simply not in scope and is the
remaining asymmetric edge: texts and emails to a deleted contact are refused,
calls are not.

**Aggravation (adversarial review, 2026-08-03): the same gap also breaks the
inbox invariant this feature just introduced.** The resurfacing rule surfaces a
deleted contact only while the NEWEST message on their newest conversation is an
inbound stamped after deleted_at (the freshInbound rule,
app/src/routes/inbox.ts:437-448). An outbound call record is a message on that
same 1:1 thread, so the un-gated Call button silently UN-resurfaces a
still-unread contact. Concretely: a soft-deleted contact texts back, so her row
reappears in the inbox with the Deleted chip and unread 1; a navigator opens it,
finds the composer locked ("restore them to reply"), and does the one thing the
page still offers - clicks Call; originateCall appends a type:'call',
direction:'outbound' record to that same conversation
(app/src/services/originateCall.ts:141-176); the newest message is now OUTBOUND,
freshInbound goes false, and on the next inbox render the row is GONE with her
text still unread. She is already hidden from the contact lists and from Today,
so that message now exists nowhere in the UI except the direct /contacts/<id>
URL. That is why severity is raised low -> med: the only send affordance the
locked page leaves live is the one that loses an unread message.

**Suggested fix.** When building the inbound-calls-invisible-in-inbox work (or
sooner if a stray call to a deleted contact is reported), add an isDeleted
gate to originateCall mirroring ContactDeletedError semantics (refuse with a
typed error the dashboard can map to "restore them to call"), and audit which
Call affordances render for a deleted contact in the dashboard.
