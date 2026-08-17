---
id: push-subscription-change-not-handled
title: Service worker has no pushsubscriptionchange handler - out-of-app permission bounces strand the server
type: bug
severity: med
status: open
area: dashboard/push
created: 2026-08-16
refs: dashboard/public/sw.js, dashboard/src/routes/settings/useNotifications.ts, app/src/services/pushService.ts
---

**Problem.** The service worker (dashboard/public/sw.js) handles install,
activate, push and notificationclick - but NOT `pushsubscriptionchange`. When
the browser's push subscription is invalidated or rotated OUTSIDE the app's
own Settings toggle, nothing tells the server:

- Toggling the WebAPK's notification permission in ANDROID SYSTEM settings
  (off then on) can invalidate the subscription.
- Chrome/FCM can rotate a subscription on its own (key rotation, app data
  events).

After such a change, the server keeps sending to the dead endpoint. Each send
"succeeds" until the push service answers 410, at which point pushService
prunes the record - and the device then has ZERO server-side subscriptions,
silently, until the user manually bounces the in-app toggle.

**Why it stayed hidden.** The IN-APP toggle handles the lifecycle correctly:
observed live on prod 2026-08-16 (~19:57Z), the off/on bounce produced a clean
DELETE (subscriptionCount 0) then POST (subscriptionCount 1) and test sends to
the fresh subscription reported sent:1. So anyone testing via the app never
sees the gap; only an out-of-app permission bounce or a silent FCM rotation
hits it.

**Suggested fix.** Add a `pushsubscriptionchange` handler to sw.js (and any
tested mirror it needs): re-subscribe with the stored VAPID applicationServerKey
(`event.oldSubscription?.options.applicationServerKey` or a fetch of
/api/push/vapid-public-key) and POST the new subscription to
/api/push/subscriptions, inside `event.waitUntil`. Note the endpoint requires
an authenticated session cookie - decide behavior when the worker fires with
no valid session (queue and retry on next activation is the usual answer).
Server-side, pushService already prunes 410s, which remains the right backstop.
