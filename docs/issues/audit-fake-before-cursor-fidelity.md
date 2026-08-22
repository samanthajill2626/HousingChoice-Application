---
id: audit-fake-before-cursor-fidelity
title: Test fake auditRepo.listByEntity treats `before` as a numeric seq, not a lexical ISO SK
type: debt
severity: low
status: resolved
area: app/test-harness
created: 2026-07-03
resolved: 2026-08-21
refs: app/test/helpers/twilioWebhookHarness.ts, app/test/contactTimeline.test.ts
---

**Resolution (2026-08-21, `fix/test-suite-hardening`).** Both halves, and only
the second one was still outstanding.

**The fake was already fixed.** `listByEntity` in `twilioWebhookHarness.ts`
compares `before` LEXICALLY against the hidden `__ts` (`<ISO>#<zero-padded
seq>`), matching the real repo's contract, and its comment says so. The
`Number(opts.before)` compare this issue describes is gone. So the code half was
done by some earlier change and the issue text had gone stale.

**The test was not.** This issue's second ask - "add a landlord-timeline
pagination test that pages past a property-audit boundary and asserts no
dup/skip across pages" - had no coverage. The existing dup/skip test
(`contactTimeline.test.ts`) pages over MESSAGES only, so no page boundary ever
landed on an audit row and the `before` bound was never exercised.

Added `pages across a PROPERTY-AUDIT boundary with no dups and no skips`: five
`broadcast_sent` rows on one owned unit, `limit=2`, so every boundary lands on a
property-audit row.

**Probed rather than trusted** - the whole point of this issue is that the fake
and the real repo can silently disagree, so a new test that has never failed
would prove nothing. Re-introducing the original defect (`seqOf(e) <
Number(before)`) makes it fail with **`expected [...] to have a length of 5 but
got 2`** - the exact skip class described above. Restored byte-identical, 46/46
green.

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
