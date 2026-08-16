---
id: quick-reply-surface-not-rebuilt
title: One-tap quick replies are dead - the quick-reply sheet was never rebuilt
type: bug
severity: high
status: open
area: dashboard
created: 2026-08-15
refs: dashboard/src/sw/route.ts, dashboard/public/sw.js, app/src/routes/webhooks/voice.ts:1810
---

**Problem.** CO2 founder triage (PHASE1_CHANGE_ORDER_2.md) specified that a
missed-call push deep-links to a quick-reply sheet at `/quick-reply/<callId>`,
where the founder taps a canned reply and it sends with zero further typing. On
Android the notification carries ACTION BUTTONS whose ids ride the URL hash
(`#action=qr-0`) so the sheet can pre-select or auto-send the chosen reply; on
iOS, where notification actions are not supported, the plain tap is the whole
mechanism.

The legacy dashboard implemented this (`dashboard-legacy/src/routes/QuickReply.tsx`
plus `routes/quickReply/*`). **The rebuilt dashboard has no `quick-reply` route
at all** - `App.tsx` goes straight from `placements/:placementId` to
`conversations/:conversationId`, and a `/quick-reply/...` path falls to the
`path="*"` NotFound catch-all.

This surfaced on 2026-08-15 while restoring the PWA service worker (deleted with
the dashboard-legacy workspace). The worker's routing table still pointed at
`/quick-reply/<callId>`, so restoring it verbatim would have sent every
missed-call notification tap to a 404.

**What was done instead.** `resolveSafePath` now routes `missed_call` to the
caller's CONVERSATION. The push payload already carries `conversationId`
alongside `callId` (`voice.ts:1810`), so there is a real destination and the
call entry lives in that thread. `/quick-reply/` was also removed from
`assertSameOriginPath`'s allow-list, so a stale worker still holding the old
target cannot navigate a user to a dead route. The `action` argument is accepted
and ignored, and both `route.ts` and its verbatim mirror in `public/sw.js` carry
a pointer here.

**What is lost until this is rebuilt: the ONE-TAP quick reply.** A missed-call
tap now opens the thread and the founder types (or picks a template) as normal,
and the Android action buttons no longer do anything distinct from a plain tap.

**NOT the same thing as the zero-tap auto-text**, which is a separate,
server-side path (the `call.missedAutoText` job - automatic on a missed call,
idempotent per CallSid, throttled, settings- and opt-out-gated) and is entirely
unaffected. Auto-text is the ZERO-tap mechanism; quick replies are the ONE-tap
mechanism. The alert itself and the call entry are also unaffected.

**This is a regression from the dashboard rebuild, not from the 2026-08-15 PWA
restore.** It has been dead on both envs since `6c821b5a`: prod had no
registered service worker at all, and on dev a phone still running the cached
M1.4 worker navigates to `/quick-reply/<callId>`, which the rebuilt router sends
to NotFound. The restore changed the destination from a 404 to the conversation;
it did not take a working feature away.

**Suggested fix.** Rebuild the sheet as a route in the current dashboard,
consuming `#action=<id>` against `OrgSettings.quickReplies` (the same list
`voice.ts` slices to build the notification actions). Then re-add the
`missed_call` branch to `resolveSafePath` AND to the mirror in `public/sw.js`,
and put `/quick-reply/<id>` back in the `assertSameOriginPath` allow-list -
`route.test.ts` has a case asserting that path is currently REFUSED, which will
need inverting at the same time.
