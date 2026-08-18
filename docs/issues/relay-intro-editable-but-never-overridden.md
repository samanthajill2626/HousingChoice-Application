---
id: relay-intro-editable-but-never-overridden
title: relay.intro is editable in the catalog but operator edits are silently inert
type: bug
severity: med
status: open
area: app/messaging
created: 2026-08-17
refs: app/src/jobs/relayFanOut.ts, app/src/messages/resolve.ts
---

**Problem.** `relay.intro` is marked `editable: true` in the message catalog,
but `composeIntroBody` calls `resolveMessage` with no overrides argument
(`jobs/relayFanOut.ts`), and `resolveMessage` only honors an override when one
is passed (`messages/resolve.ts`). An operator who edits the template sees the
edit accepted and then silently ignored at send time. Latent bug in existing
code, unrelated to and predating the contact-create-relay-group feature; all
three relay-open surfaces share it.

**Suggested fix.** Either pass stored overrides through `composeIntroBody` (and
define how the member-name composition interacts with an overridden body), or
mark the catalog entry `editable: false` until overrides are actually applied.
