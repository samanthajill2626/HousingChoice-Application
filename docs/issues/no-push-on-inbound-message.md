---
id: no-push-on-inbound-message
title: No push notification is sent for an inbound text - push is voice-only
type: improvement
severity: med
status: open
area: app/push
created: 2026-08-16
refs: app/src/routes/webhooks/twilio.ts, app/src/services/pushService.ts, dashboard/public/sw.js
---

**Problem.** An inbound text message produces NO push notification. Found during
go-live testing 2026-08-16: the Settings "Send test notification" push arrives
correctly on Android, but texting the business number produces nothing.

This is not a regression or a misconfiguration - the code path does not exist.
An audit of every `pushService` send call site in the app finds exactly four:

| kind          | trigger                                   | source              |
| ------------- | ----------------------------------------- | ------------------- |
| `test`        | Settings -> Send test notification        | routes/push.ts:158  |
| `pre_ring`    | ~2s before the holder's cell rings        | webhooks/voice.ts:724  |
| `missed_call` | missed inbound business-line call         | webhooks/voice.ts:1827 |
| `voicemail`   | a voicemail lands                         | webhooks/voice.ts:1864 |

All three real kinds are VOICE. The inbound SMS webhook
(`routes/webhooks/twilio.ts`) contains no push references at all. `kind:
'message'` in `routes/contactTimeline.ts` is an SSE timeline entry type, not a
notification.

**Why it is missing.** Push was scoped in PHASE1_CHANGE_ORDER_2 to founder CALL
TRIAGE ("the founder receives many calls daily... she must glance at her ringing
phone and know whether to safely ignore"). Inbound-message push was never
specified, so it was never built. Worth stating plainly because the absence
reads as a bug to anyone who installs the PWA and texts the business number.

**The client half already exists.** `dashboard/public/sw.js` documents its
payload shape as `kind: 'missed_call' | 'message' | 'test' | string` and
`dashboard/src/sw/route.ts` already routes a payload carrying `conversationId`
to `/conversations/<id>`. So the worker can already display and route a message
push correctly - this is SERVER-SIDE ONLY work.

**Suggested fix.** Emit a push from the inbound-message path after the message
is durably filed, mirroring the voice sends: `pushService.sendToUser(..., {
kind: 'message', payload })` with `conversationId` set so the tap deep-links to
the thread. Design questions to settle first, because they are the reason this
is not a one-liner:

- **Who receives it.** The voice pushes target the inbound-voice-line holder
  (pre-ring) or every admin (missed call). Messages have no equivalent owner
  concept - all staff, or the assigned navigator, or the founder only?
- **Volume.** Calls are naturally rate-limited by being calls. Inbound texts at
  scale (629 imported contacts, group threads) could be a notification flood.
  Needs at minimum a per-conversation coalescing/`tag` strategy - the worker
  already sets `tag` from `conversationId`, which coalesces in-place, but the
  quiet-hours and per-thread-mute questions are unanswered.
- **Quiet hours.** OrgSettings has a quiet-hours concept for outbound sends;
  whether it should gate staff-facing pushes is a product decision.
- **PII.** The push body is rendered on a lock screen. The voice pushes carry a
  caller label; a message push must not spill message content beyond whatever
  the founder accepts on a lock screen.

**Design decisions (operator, 2026-08-16).** All four questions above are
settled; the guiding principle is "this is a texting app at its most basic
function - mirror how the native messaging apps behave":

- **Who receives it: everyone with notifications turned on.** No owner or
  assignment filtering - every user with an active push subscription gets the
  message push. Opting out is turning notifications off on the device/PWA.
- **Volume: native-messaging-app semantics.** Per-conversation coalescing via
  the notification tag (the display mirror in dashboard/src/sw/display.ts now
  yields `message:<conversationId>`, replacing in place per thread the way an
  SMS app keeps one entry per thread). No additional server-side throttle.
- **Quiet hours: device do-not-disturb ONLY.** The device's own DND applies
  automatically at the OS layer - that is the whole quiet gate. Org quiet
  hours must NOT gate staff-facing pushes; that setting is outbound-only.
- **PII: include everything, like a native SMS app.** Sender and full message
  content go in the push. Lock-screen content hiding is the user's own device
  setting, not something the server pre-censors.
- **Scope note:** "message" means any inbound message channel - SMS and email
  both (email is a first-class channel since email-channel-v1).

Delivery: via the feature workflow (brainstorm remainder -> spec -> plan ->
mission build), queued to start once the 2026-08-16 voice-notification work
(call-push tag fix + deploy + live re-tests) is finished.
