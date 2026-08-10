---
id: exactly-once-send-intent
title: No send path has exactly-once semantics - a lost HTTP response plus a staff re-click can duplicate any outbound message
type: improvement
severity: low
status: open
area: app/messaging
created: 2026-08-10
refs: app/src/services/sendMessage.ts, docs/superpowers/specs/2026-08-10-group-texting-design.md
---

**Problem.** Raised during the group-texting external design review: if the
provider accepts a send but the HTTP response is lost, a retry (or a staff
re-click after an error surface) duplicates the message. This is true of
EVERY send path today (1:1, relay fan-out, broadcasts, and the new group
sends) - none carries a durable send intent or client-dedupe identifier.

**Scope note.** Deliberately NOT fixed inside the group-texting mission
(2026-08-10): holding one new path to a stronger standard than the rest of
the app hides the real, app-wide shape of the problem. Group sends ship
with documented parity.

**Sketch.** A durable send-intent record (client-generated idempotency key
persisted before the provider call; recovery by key + provider history on
ambiguous outcomes), applied uniformly across send services.
