---
id: group-text-conversion-unwindowed-log-assert
title: group-text-conversion.spec.ts asserts zero error lines over an unwindowed log tail
type: debt
severity: med
status: open
area: e2e
created: 2026-08-17
refs: e2e/tests/dashboard-next/group-text-conversion.spec.ts:125, e2e/fixtures/groupText.ts, app/src/lib/seed/lean.ts
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

**Suggested fix.** Scope `group-text-conversion.spec.ts`'s `readLogTail`
assertion to a window that starts at the spec's own setup (or filter to
correlation ids the spec itself created) so earlier files' legitimate
`flagStuckConnecting` noise cannot fail it. Then the `afterAll` log-ring clear
in `contact-create-relay-group.spec.ts` can be retired.
