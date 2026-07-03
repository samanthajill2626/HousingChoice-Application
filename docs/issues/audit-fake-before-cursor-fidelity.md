---
id: audit-fake-before-cursor-fidelity
title: Test fake auditRepo.listByEntity treats `before` as a numeric seq, not a lexical ISO SK
type: debt
severity: low
status: open
area: app/test-harness
created: 2026-07-03
refs: app/test/helpers/twilioWebhookHarness.ts
---

**Problem.** Found during the activity-coverage landlord-interleave review
(2026-07-03). The in-memory fake `auditRepo.listByEntity` in the webhook harness
implements the `before` pagination bound as an exclusive **numeric `__seq`** compare
(`Number(opts.before)`), whereas the real repo (`auditRepo.ts`) — and the fake
message/activity repos — treat `before` as an exclusive **lexical `<ISO>#<suffix>` SK**
bound. When a merged contact-timeline cursor derived from a property-audit row (an ISO
SK) is fed back into the fake's `listByEntity`, `Number('<ISO>#…')` is `NaN`, so the
fake's `before` filter becomes a no-op.

Impact: the landlord property-activity **pagination across pages** (contactTimeline
landlord interleave, WS3) is currently verified correct only by code reading — the
`globalKey` is the raw audit SK so the production lexical compare is right — but the
fake can't exercise a property-row-anchored page-2 cursor, so a future regression in
that paging path would not be caught by the unit suite. This is a **pre-existing fake
design** (predates the activity-coverage work); it did not cause a bug, but it is a
test-fidelity blind spot now that property-audit rows participate in the merged
timeline.

**Suggested fix.** Align the fake's `before` handling to the real repo: compare
`opts.before` lexically against the item's `ts` (`<ISO>#<suffix>`) instead of parsing
it as a number. Then add a landlord-timeline pagination test that pages past a
property-audit boundary and asserts no dup/skip across pages.
