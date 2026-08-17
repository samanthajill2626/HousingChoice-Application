---
id: message-push-no-ttl-doze-flush-renotify
title: Message pushes carry no TTL and renotify per message, so a doze flush re-alerts once per queued message in one burst
type: decision
severity: low
status: open
area: app/push
created: 2026-08-17
refs: app/src/adapters/webPush.ts, app/src/routes/webhooks/twilio.ts, app/src/services/inboundEmail.ts, dashboard/src/sw/display.ts, docs/superpowers/specs/2026-08-16-inbound-message-push-design.md
---

Found by the planner's plan-blind adversarial review of inbound-message-push
(2026-08-17); adjudicated as a TUNABLE for the operator, not a defect - the
spec's D9 (no TTL, late-beats-never) and D2 (alert on every message like a
native SMS thread) were deliberate, and native SMS behaves the same way when
a phone wakes.

**The behavior.** Message pushes pass no `ttlSeconds` (web-push default: four
weeks), pinned by test. The service worker sets `renotify: true` for kind
`message` and `unmatched_email` (so message 2 in a thread still buzzes -
without it a same-tag replacement is silent). Android defers even
urgency:high pushes while the device dozes and flushes the backlog when the
FCM socket wakes (observed live 2026-08-16 for pre_ring). Combined: a phone
that dozes through a busy afternoon wakes to the whole message backlog, and
each queued push re-alerts (vibrate + sound) rather than silently replacing
its predecessor. Per-conversation tags coalesce the SHADE entries but not
the alerts - the count of buzzes is the count of queued messages, all stale,
in one burst.

**The lever, if it annoys.** A moderate TTL on message pushes (e.g. 3600s):
a message the phone could not receive within an hour is dropped by the push
service instead of delivered late - the unread badge and the inbox still
show it. This trades "never lose a notification" for "never get a stale
burst". The pre_ring push already uses ttlSeconds=60 for its own reason. A
one-line change at the three emit sites plus the pinned test. Operator call;
revisit after real-world use on the Pixel with the battery exemptions set.
