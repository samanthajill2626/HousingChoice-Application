---
id: group-text-conversion-unwindowed-log-assert
title: group-text-conversion.spec.ts asserts zero error lines over an unwindowed log tail
type: debt
severity: med
status: resolved
area: e2e
created: 2026-08-17
resolved: 2026-08-21
refs: e2e/tests/dashboard-next/group-text-conversion.spec.ts, e2e/tests/dashboard-next/contact-create-relay-group.spec.ts, app/src/lib/logger.ts:152
---

**Resolution (2026-08-21, `fix/test-suite-hardening`).** The assertion is now
windowed to the spec's own second pass: it stamps `secondPassFrom` immediately
before the second `sendGroupAsParty` and passes `since` to `readLogTail`. The
`since` filter compares each line's own `time` (`app/src/lib/logger.ts:152-155`),
so every earlier file's `flagStuckConnecting` line is timestamped outside the
window and cannot reach it.

The window is deliberately narrow rather than "since this spec started". The
claim being made is specific - *the SECOND arrival at an already-converted
thread does not error* - so the window starts exactly there.

**The `clearLogTail` workaround in `contact-create-relay-group.spec.ts` is
retired**, along with its now-unused import. That was the wrong end of the
problem: the residue was blamed on the producer, so the fix lived in the caller
and every future relay-creating spec would have had to repeat it. The consumer
now scopes its own assertion.

**Proven both directions** by running the two specs together in path order,
which is the exact failure shape (workers:1, so path order is run order):

| | result |
|---|---|
| windowed (the fix) | **4 passed** |
| window removed again | **1 failed** - `Received length: 4` |

Four real error lines carrying `CONNECTING_ID` were present in that run and the
windowed assertion correctly ignored all of them.

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
