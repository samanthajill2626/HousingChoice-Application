---
id: inbound-calls-invisible-in-inbox
title: Calls never surface in the inbox - no activity bump, no unread, no re-sort
type: improvement
severity: med
status: open
area: app
created: 2026-08-03
refs: app/src/routes/webhooks/voice.ts, app/src/routes/inbox.ts:228, app/src/repos/conversationsRepo.ts:447
---

**Problem.** The voice webhook records call history as `type:'call'` message items
in the conversation, but it never calls `conversations.touchLastActivity` and never
bumps `unread_count` (the only bump sites are the SMS/MMS webhook and email
ingestion). So a call - answered, missed, or voicemail - does not re-sort the
thread in the inbox, does not update its preview, and carries no unread badge.
Staff can miss an inbound call entirely unless they happen to open the timeline.
Ironically the inbox already renders a `call` channel row (deriveLatest supports
`type:'call'`); it just never gets fed. This applies to ALL contacts, and it also
gates the deleted-contact resurfacing feature (see the 2026-08-03 spec): a deleted
contact's missed call cannot resurface their thread until calls bump unread.

**Desired behavior (operator decision, 2026-08-03).**

- EVERY call (answered, missed, voicemail, outbound) stamps `last_activity_at`
  plus a preview ("Missed call", "Call - 12 min", ...) so the thread surfaces and
  re-sorts in the inbox.
- ONLY missed calls and voicemails bump `unread_count` (unread badge). An
  answered call surfaces as already-read - the conversation happened.

**Suggested fix.** Wire the voice webhook's call-outcome sites (the status
callback that classifies answered/missed/voicemail) to `touchLastActivity` +
conditional `incrementUnread`. Needs its own small design pass first: which
lifecycle events stamp what, masked/relay call handling, outbound legs, and
whether the deleted-contact send guard interacts. Once calls bump unread, the
deleted-contact resurfacing rule (unread inbound newer than `deleted_at`) picks
up missed calls automatically - build order is deleted-resurfacing first, then
this.
