---
id: inbound-calls-invisible-in-inbox
title: Calls never surface in the inbox - no activity bump, no unread, no re-sort
type: improvement
severity: med
status: resolved
resolved: 2026-08-17
area: app
created: 2026-08-03
refs: app/src/routes/webhooks/voice.ts, app/src/services/originateCall.ts, app/src/lib/callPreview.ts, app/src/routes/inbox.ts:228, app/src/repos/conversationsRepo.ts:447
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

**Update (2026-08-04, contact-comms-pane).** The VISIBILITY half is now fixed on
the tour and placement hubs, though not on the surface this issue tracks. Spec
`docs/superpowers/specs/2026-08-03-contact-comms-pane-design.md` rebuilt both
pages' 1:1 tabs on the person-centric comms pane, so those tabs render
`GET /api/contacts/:id/timeline` - which carries `kind:'call'` rows - instead of
the single relay transcript that dropped them. A call placed to or from a tenant
or landlord is therefore visible from their tour/placement tab and from the
contact page. The INBOX surface is untouched and this issue stays open: calls
still do not stamp `last_activity_at`, do not re-sort or re-preview the thread,
and never bump `unread_count`, so an inbound call still cannot surface a row an
operator is not already looking at (and still cannot resurface a deleted
contact's thread). Status: open.

**Resolution (2026-08-17, branch `feat/call-inbox-unread`, small-fix lane with an
end-of-branch adversarial review).** Design record, since this change has no
separate spec:

- Write-side wiring into the EXISTING primitives (`touchLastActivity` +
  `incrementUnread`), no schema/index/infra/deps change; the whole read stack
  (byUnread index, Unread tab, nav badge, Today, `conversation.updated` SSE,
  the deleted-contact resurfacing rule) picks calls up unchanged. Rejected:
  read-side derivation (defeats the index) and a separate call log surface.
- Founder-bridge inbound call, three stamp points on the caller's 1:1 thread:
  ring -> "Incoming call" (already-read); terminal Dial summary -> the outcome
  preview ("Missed call" / "Call - 12m 3s") and `incrementUnread` ONLY when
  `isMissed && direction inbound && !masked`, gated on the forward-only
  `transitioned` so a redelivered summary never double-counts; voicemail
  upgrade -> "Voicemail" and `incrementUnread` AGAIN (deliberate: a read miss
  must re-flag when the voicemail lands; the badge counts rows).
- Outbound originate: "Outgoing call" lifecycle stamps, never unread.
- Ordering: the unread write lands BEFORE `message.persisted` (a staff member
  viewing the contact re-marks read on that event), `conversation.updated`
  follows - the SMS webhook's order.
- Preview strings live in `app/src/lib/callPreview.ts` (stored, like message
  bodies; staff dashboard copy, not catalog copy).
- Non-goals: masked/pool-number relay calls (touching a relay thread would
  blind-write `status='open'` over `connecting`; roster semantics); the
  no-holder guard path; historical backfill; dashboard changes (the existing
  `Call` chip + preview + bold/badge rendering carry it).
- Accepted v1 wart (operator decision 2026-08-17): the missed-call auto-text
  re-previews the thread with the auto-text body (`sendMessage` touches), so an
  unread missed-call row can read as the auto-text; the row stays unread and the
  timeline shows both. Follow-up if it grates: a call-aware preview.

Coverage: `app/test/voiceInboxActivity.test.ts`, `app/test/callPreview.test.ts`,
`e2e/tests/dashboard-next/call-inbox-unread.spec.ts`.
