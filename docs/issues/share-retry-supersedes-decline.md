---
id: share-retry-supersedes-decline
title: An automatic 30003 retry of a pre-decline share supersedes a recorded decline
type: bug
severity: low
status: open
area: app
created: 2026-10-13
refs: app/src/services/shareLedger.ts:51, app/src/services/shareLedger.ts:112, app/src/lib/listingSendOutcome.ts, app/src/lib/retrySendWindow.ts:15
---

**Problem.** A decline ("Not interested") is superseded by a later counted
share (the listing_sends row's `sentAt`, last-heard-from spec 5.4). A share
retried automatically after a 30003 failure is a NEW attempt with a later
instant, so if staff record Not interested inside the 15-minute retry window of
a share sent BEFORE the decline, the accepted retry moves `sentAt` past the
decline and the pair is Waiting again (back on the Follow up list, checked in the
next preview). Proven with a throwaway test in code review round 1 (finding
ADV-4, `docs/superpowers/reviews/2026-10-12-last-heard-from/code-review/adversarial-findings.md`).
The tour side already refuses automated writes as supersession; the share side
does not make that distinction.

**Suggested fix.** Supersede by a share whose ORIGINAL attempt (the retry
chain's root instant) postdates the decline, or accept and document. Narrow
window; low.
