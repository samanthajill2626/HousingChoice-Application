---
id: missed-call-autotext-vs-onboarding-diagram
title: Missed-call auto-text copy doesn't request the onboarding details the diagram shows
type: decision
severity: low
status: open
area: app
created: 2026-06-29
refs: app/src/repos/settingsRepo.ts:52, documentation/tenant-onboarding-sequence.mermaid
---

**Problem.** The tenant-onboarding diagram's by-phone branch shows the missed-call
auto-reply asking the prospect to "Send full name, voucher size, and housing
authority." The implemented missed-call auto-text is the generic operator template
`"Sorry I missed you — I'll call back soon; you can also text me here."`
(`settingsRepo.ts:52`, founder-editable, `missedCallAutoTextEnabled` defaults ON).
So the auto-reply does NOT request the three onboarding details the diagram depicts;
the prospect supplies them only after a human follows up.

This is a copy/product decision, not a code bug. The e2e suite asserts the REAL
operator-template body (per the design's `expectAutoReply` = "assert the operator
template"), and the by-phone scenario continues with the tenant texting their details
in the next step regardless — so the suite stays faithful and green.

**Suggested fix (optional).** If the product wants the missed-call auto-text to request
the onboarding details, change the default `missedCallAutoText` template (or add a
distinct onboarding-specific template). Until then, the divergence is intentional and
documented.
