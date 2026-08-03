---
id: outbound-voice-ignores-deleted-contacts
title: Outbound voice calls have no soft-deleted-contact gate
type: bug
severity: low
status: open
area: app
created: 2026-08-03
refs: app/src/services/originateCall.ts:108, app/src/services/sendMessage.ts, docs/superpowers/specs/2026-08-03-deleted-contact-resurfacing-design.md
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

**Suggested fix.** When building the inbound-calls-invisible-in-inbox work (or
sooner if a stray call to a deleted contact is reported), add an isDeleted
gate to originateCall mirroring ContactDeletedError semantics (refuse with a
typed error the dashboard can map to "restore them to call"), and audit which
Call affordances render for a deleted contact in the dashboard.
