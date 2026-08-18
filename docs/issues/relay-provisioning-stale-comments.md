---
id: relay-provisioning-stale-comments
title: Stale relay provisioning comments assert the opposite of what the code does
type: debt
severity: low
status: open
area: app/relay
created: 2026-08-17
refs: app/src/services/relayProvisioning.ts:87, app/src/services/poolNumbers.ts:5-13
---

**Problem.** Comments that mislead a reader of otherwise-correct code:

1. `services/relayProvisioning.ts:87` claims provisioning never throws the
   kill-switch error; contradicted by `poolNumbers.ts` (~577-579), where a
   tier-3 miss with `RELAY_LIVE_PROVISIONING` OFF throws
   `RelayProvisioningDisabledError` precisely so a connecting group is never
   stranded.
2. The `poolNumbers.ts:5-13` file header still describes the pre-tier-3
   behavior "(c) else PROVISION a fresh one through the adapter" - the opposite
   of the current three-tier ladder (reuse -> warm spare -> connect-when-ready,
   where buying happens only in the warm job).

A third instance (the dashboard `ConversationHeader.status` docblock omitting
`'connecting'`) was fixed by the contact-create-relay-group branch; the two
above were left alone because `poolNumbers.ts` was out of that mission's scope
(a parallel same-pair-number-reuse effort owns the file).

**Suggested fix.** Rewrite both comments to describe the current ladder and the
kill-switch throw, ideally in the same-pair-number-reuse branch that already
owns `poolNumbers.ts`.
