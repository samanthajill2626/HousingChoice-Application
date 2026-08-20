---
id: relay-intro-editable-but-never-overridden
title: relay.intro claimed to be operator-editable when nothing could override it
type: bug
severity: med
status: resolved
area: app/messaging
created: 2026-08-17
resolved: 2026-08-20
refs: app/src/messages/catalog.ts, app/src/messages/resolve.ts, app/src/jobs/relayFanOut.ts
---

**Problem.** `relay.intro` was marked `editable: true` in the message catalog,
but `composeIntroBody` calls `resolveMessage` with no overrides argument
(`jobs/relayFanOut.ts`), and `resolveMessage` only honors an override when one
is passed (`messages/resolve.ts`). `relay.member_added` is the same.

**Correction to the original filing (2026-08-20).** This issue was first written
as "an operator who edits the template sees the edit accepted and then silently
ignored". That overstated it - the edit could never be made in the first place.
An override has to clear three gates to reach a send, and for these two entries
NONE of them existed:

1. `OrgSettings` has no field to store a relay-intro override. The Settings >
   Templates UI exposes exactly five fields (`preRingPauseSeconds`,
   `missedCallAutoText`, `missedCallAutoTextEnabled`, `quickReplies`,
   `welcomeText`) and the settings route's `parsePatch` accepts no others.
2. `settingsToOverrides` maps only `welcomeText` -> `welcome.sms` and
   `missedCallAutoText` -> `missed_call.autotext`.
3. `composeIntroBody` / `composeMemberAddedBody` pass no overrides at all.

So the defect was a false claim in the catalog rather than a lost edit. It still
mattered: gate 3 is a SECOND break, so the day someone adds the generic
`messageOverrides` map to `settingsToOverrides` (gates 1 and 2), these entries
would go on being ignored - silently, and now with a UI encouraging the edit.

**Resolution (2026-08-20).** Both relay entries are `editable: false`, with the
reasoning recorded at the catalog entry, and a test pins it: flipping the flag
back without doing the wiring fails
`app/test/messages/catalog.test.ts`. The test also asserts the guard that gives
the flag its meaning - a non-editable entry ignores an override even when one is
handed to the resolver. No behavior changed for any send; no override for these
ids could exist.

**Still wanted, and NOT done here: letting the founder edit this copy herself.**
She has asked for relay-intro wording changes twice (2026-08-17 and 2026-08-20)
and both had to ship as code. Doing it properly means a generic
`messageOverrides` map on `OrgSettings`, the settings route accepting it,
`settingsToOverrides` spreading it, a Templates UI that lists catalog entries,
and threading overrides into the relayFanOut composers - which makes those
composers async against the settings repo. That is a feature, tracked with the
rest of the founder's template work in
[[founder-message-template-updates-owed]].
