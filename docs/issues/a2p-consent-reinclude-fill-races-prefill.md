---
id: a2p-consent-reinclude-fill-races-prefill
title: a2p-compliance.spec:323 types its message while the property prefill lands - the draft becomes prefill + typed text
type: bug
severity: low
status: open
area: e2e
created: 2026-09-30
refs: e2e/tests/dashboard-next/a2p-compliance.spec.ts:418, dashboard/src/routes/broadcasts/BroadcastComposer.tsx, docs/issues/broadcast-composer-prefill-overwrites-edit.md
---

**Problem.** `a2p-compliance.spec.ts:323` ("a no-consent tenant is surfaced in
the preview + excluded from the send; recording consent re-includes them")
intermittently fails at its exact-value check after the re-include step:

    Expected: "Re-include 218651"
    Received: "Hi [TenantName], a 2-bedroom home at 218651 Consent Fence Way NW,
               Atlanta, GA 30314 is available for $1500-$1600/mo. Details:
               http://127.0.0.1:10411/p/unit-...Re-include 218651"

The unit's default share text (the property prefill) and the test's typed
text are CONCATENATED - not the overwrite that
`broadcast-composer-prefill-overwrites-edit` fixed on 2026-09-08 (that fix is
what added this exact-value check, and the check is doing its job).

Seen on the new PC in 2 of 7 full e2e runs on 2026-09-30, one before and one
after `fix/vite-proxy-keepalive` - both early in the run (test #5), with no
socket errors, so it is not the port-exhaustion problem. It passed in the
other five, including main's baseline run.

**Likely mechanism (unverified).** The spec navigates to
`/broadcasts/new?unitId=...` and calls `getByLabel('Message').fill(...)` at
once. `fill` selects the field's contents, then inserts the text; if the async
property prefill commits between those steps, the insert lands after the
prefilled text instead of replacing it. The component's edit-ownership guard
(the 2026-09-08 fix) protects an EDITED body from a later prefill, but here the
prefill wins the race to an unedited body and the typing then appends.

**Suggested fix.** Test-side, the cheap and correct one: wait for the prefill
to settle before typing - e.g. `await expect(message).toHaveValue(/Details:/)`
- then `fill`. Worth a look whether the same fill-after-goto pattern appears
earlier in this spec (the first compose step) and in other broadcast specs.
If a real user can hit it (typing in the first instant after opening a
prefilled composer), that is a separate, product-side question.
