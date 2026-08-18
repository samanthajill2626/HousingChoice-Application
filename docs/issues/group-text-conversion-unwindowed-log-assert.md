---
id: group-text-conversion-unwindowed-log-assert
title: group-text-conversion.spec.ts asserts zero error lines over an unwindowed log tail
type: debt
severity: med
status: open
area: e2e
created: 2026-08-17
refs: e2e/tests/dashboard-next/group-text-conversion.spec.ts:125, e2e/fixtures/groupText.ts, app/src/services/poolNumbers.ts:484-521, app/src/lib/seed/lean.ts
---

**Problem.** Creating ANY relay group fires `poolNumbers.flagStuckConnecting()`,
which logs one error line per over-age connecting group - and the lean seed
permanently ships one whose conversationId is exactly the `CONNECTING_ID` that
`group-text-conversion.spec.ts` asserts has ZERO error lines, over an
UNWINDOWED `readLogTail`. Any spec that provisions a relay group and sorts
before `group-text-conversion.spec.ts` (path-ordered, workers:1) therefore
fails that spec, with a confusing cross-file blame. Found when
`contact-create-relay-group.spec.ts` (which sorts first) tripped it; that spec
works around it by clearing the log ring in `afterAll`, but the workaround
belongs to the caller and every future relay-creating spec would need to
repeat it.

**Observed evidence (2026-08-17, contact-create-relay-group branch, e2e run 1).**
The caught line, verbatim shape: `event=relay_connecting_stuck`, `level=50`,
`conversationId=f65fe0e6-ba3d-5cc2-90c7-68b7b1a14cd7` (= the spec's
`CONNECTING_ID`), msg "relay group stuck connecting past the max wait - its
warm number never registered (manual attention)". Producer:
`poolNumbers.flagStuckConnecting` (`poolNumbers.ts:484-499`), a fire-and-forget
sweep fired from EVERY `provisionForGroup` call (`:521`) that flags every
connecting group older than `relayWarmingMaxWaitMs` - which the lean seed's
permanent connecting group always is. Deterministic, not timing: any
relay-creating spec that path-sorts before this one trips it. (The
`relay.warmNumber` Twilio-404 error lines in the same runs are unrelated to
this assertion: they carry the WARMED group's conversationId, never
`CONNECTING_ID`, and are the hermetic lane's designed stay-connecting
mechanism.)

**Suggested fix.** Scope `group-text-conversion.spec.ts`'s `readLogTail`
assertion to a window that starts at the spec's own setup (or filter to
correlation ids the spec itself created) so earlier files' legitimate
`flagStuckConnecting` noise cannot fail it. Then the `afterAll` log-ring clear
in `contact-create-relay-group.spec.ts` can be retired.
