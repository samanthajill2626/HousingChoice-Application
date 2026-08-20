---
id: missed-call-push-fans-out-duplicate-replies
title: Two admins can each quick-reply to the same missed call, texting the caller twice
type: bug
severity: low
status: open
area: app
created: 2026-08-20
refs: app/src/routes/webhooks/voice.ts, dashboard/src/routes/quickReply/QuickReply.tsx
---

**Problem.** `sendMissedCallPush` pushes the missed call to EVERY admin user.
Each push carries the same `callId` and the same quick-reply action buttons, and
the quick-reply sheet's send-once latch is per-client - it guarantees one
auto-send per call PER DEVICE, which is all a client-side latch can guarantee.
Two founders tapping "Sorry I missed you" on the same missed call send the caller
two identical texts.

The fan-out is not new and neither is the possibility. What changed on
2026-08-20 is the cost of acting on the push: the reply is now one tap from the
notification instead of a navigate-read-type sequence, so the window in which
both people act before either sees the other's reply is much wider. The old path
gave the second founder a thread view showing the first founder's message; the
new one gives them a button.

Currently only one admin exists in practice, which is why this is filed low.

**Suggested fix.** Idempotency belongs on the server, not in the sheet: refuse a
quick-reply send when one has already been recorded for that CallSid, the same
shape as the `call.missedAutoText` job's per-CallSid guard. That requires the
send to know which call it belongs to - the sheet currently posts to the plain
`POST /api/conversations/:id/messages` route and the call is not part of the
request. A `POST /api/calls/:callId/quick-reply { action }` route would carry it,
and would also let the server resolve the reply BODY from settings rather than
trusting a client-supplied string.

The cheap partial: have the sheet show a "someone already replied to this call"
state when the thread's newest outbound message postdates the call. That narrows
the window without closing it, and it costs a fetch the sheet does not currently
make.
