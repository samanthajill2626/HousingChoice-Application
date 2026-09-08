---
id: broadcast-composer-prefill-overwrites-edit
title: Pending broadcast prefill can overwrite a hand-edited message
type: bug
severity: med
status: in-progress
area: dashboard/broadcasts
created: 2026-09-08
refs: dashboard/src/routes/broadcasts/BroadcastComposer.tsx, dashboard/src/routes/broadcasts/BroadcastComposer.prefill.test.tsx, e2e/tests/dashboard-next/a2p-compliance.spec.ts
---

**Problem.** The full E2E run at `ca4317c8` ended with 274 passed and one failure:
`a2p-compliance.spec.ts:323`, waiting at then-line 415 for the consented tenant's
outbound message. The failing trace shows that the default property template,
not the test's custom message, was already visible when `fill()` returned. That
default was submitted as the draft and delivered successfully by the fake
provider. This is not evidence of a consent-fence or delivery-timeout defect.

**Root cause.** The composer stored message text and the hand-edited flag in
separate states. A pending property-prefill effect could observe its render's
old `bodyEdited=false`, then enqueue a default body after a new edit. The
hand-edited flag became true while the text became the default. Both the
single-recipient and multi-recipient effects had this unsafe update. A
deterministic component regression reproduces that ordering and wrong value.

**Fix in progress.** Store text and edit ownership together. Functional prefill
updates inspect the latest ownership and preserve edited messages. Explicit,
confirmed resets still clear both fields. The consent E2E checks the editor's
exact value after the draft settles, before leaving compose; its provider-body
assertion and 30-second delivery budget remain unchanged.

Investigation, evidence, focused proof, and review records:
[adjudication](../superpowers/reviews/2026-09-08-a2p-consent-e2e-fix/adjudication.md).

This issue is separate from the MMS viewer scroll/trigger issues. Do not reopen
or reclassify those based on this broadcast-composer failure.
