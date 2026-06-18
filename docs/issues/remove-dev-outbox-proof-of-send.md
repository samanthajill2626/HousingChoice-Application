---
id: remove-dev-outbox-proof-of-send
title: Remove the deprecated /__dev/outbox proof-of-send log + RecordingMessagingDriver
type: debt
severity: low
status: open
area: app/dev-harness
created: 2026-06-18
refs: app/src/routes/dev.ts:88, app/src/adapters/recordingMessaging.ts:42, app/src/adapters/messaging.ts
---

**Problem.** The dev-only `/__dev/outbox` proof-of-send log and its
`RecordingMessagingDriver` decorator are deprecated. They only capture **outbound**
messages, whereas the fake-twilio thread store (`GET /control/threads`) captures **both
directions + delivery-status progression**. They're retained solely so three pre-existing
green specs (outbox / intake-to-reply / boards) don't churn; the code is marked "do not
extend / do not add new reliance."

**Suggested fix.** Migrate those three specs to assert against the fake-twilio thread
store, then delete: the `/__dev/outbox` route (`dev.ts`), the `RecordingMessagingDriver`
(`recordingMessaging.ts`), its wiring in `messaging.ts`, and the lazily-created outbox
table. Dev/hermetic-only — no prod impact (never in terraform).

Graduated 2026-06-18 from `@deprecated` / `DEPRECATED` markers on the code above (found in
a sweep for non-TODO flags). Inline marker: `TODO(remove-dev-outbox-proof-of-send)` in `dev.ts`.
