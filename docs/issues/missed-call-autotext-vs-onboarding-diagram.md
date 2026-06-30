---
id: missed-call-autotext-vs-onboarding-diagram
title: Missed-call auto-text copy doesn't request the onboarding details the diagram shows
type: decision
severity: low
status: resolved
area: app
created: 2026-06-29
resolved: 2026-06-30
refs: app/src/repos/settingsRepo.ts:59, documentation/tenant-onboarding-sequence.mermaid
---

**Problem.** The tenant-onboarding diagram's by-phone branch shows the missed-call
auto-reply asking the prospect to "Send full name, voucher size, and housing
authority." The implemented missed-call auto-text is the generic operator template
`"Sorry I missed you — I'll call back soon; you can also text me here."`
(`settingsRepo.ts:52`, founder-editable, `missedCallAutoTextEnabled` defaults ON).
So the auto-reply does NOT request the three onboarding details the diagram depicts;
the prospect supplies them only after a human follows up.

This was a copy/product decision, not a code bug.

**Decision (2026-06-30).** Align the copy with the diagram's intent. The default
`missedCallAutoText` now requests the onboarding details:
`"Sorry we missed your call! To get started, please text us your full name, voucher
size, and housing authority and we'll be right with you."` (`settingsRepo.ts:59`,
still founder-editable, still ON by default). The diagram's exact wording was
illustrative — this is close in intent, not verbatim. The by-phone e2e path now asserts
the request-for-details intent (`expectAutoReply(/voucher size/i)`) and continues with
the tenant texting their details, as before.
