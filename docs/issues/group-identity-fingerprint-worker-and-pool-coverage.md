---
id: group-identity-fingerprint-worker-and-pool-coverage
title: The group-identity fingerprint pins only the static config list, while identity also depends on the mutable active-pool list
type: bug
severity: low
status: open
area: app/group-texting
created: 2026-08-11
refs: app/src/services/groupIdentityFingerprint.ts:36, app/src/services/groupIdentity.ts:91, app/src/index.ts:113, app/src/worker.ts
---

**Problem.** A native group text's `conversationId` is uuidv5 over the roster
left after an EXCLUSION SET is subtracted, and that set has three parts
(`services/groupIdentity.ts:91-98`):

```
businessPhoneNumber + poolNumbers (the ACTIVE relay pool, read at runtime) + configuredNumbers (GROUP_IDENTITY_EXCLUDED_NUMBERS)
```

The boot fingerprint that exists to refuse a silent change to that set hashes
only the third part (`groupIdentityFingerprint.ts:36-39`).

So the guard is complete for the part that never moves and absent for the part
that moves by design: relay pool numbers are BOUGHT AND RETIRED at runtime.
Retiring a pool number that appears in a carrier group's envelope re-mints that
group's conversationId - precisely the migration-grade change the fingerprint
exists to refuse - with nothing but the `poolNumbersInEnvelope` WARN to say it
happened. The business number is likewise unhashed, though it is protected
separately by its own three-tier config validation and its own foot-gun
documentation.

This is NARROW today: a relay pool number appearing inside a carrier group's
roster is already anomalous (it means somebody added our masked number to a
group chat), and the detection path warns when it sees one. It is filed because
the guard's own reasoning applies to it unchanged.

**Already done (group-texting fix wave 1, 2026-08-11).** The other half of this
finding - "the guard runs at app boot but not at worker boot" - WAS fixed: the
worker now runs `verifyGroupIdentityFingerprint` before its consumer starts
polling, with the same `deployed` gate as the app. It was a small, obviously
correct change (the claim write is conditional, so the two processes are
order-independent and idempotent). Only the exclusion-set COVERAGE question
remains open.

**Suggested fix.** One of:

- (a) Fold the business number into the fingerprint (it is as immutable as the
  config list in practice, and it already has a documented change procedure), and
  document IN THE FINGERPRINT MODULE why the pool list deliberately cannot be
  hashed - it moves legitimately, so hashing it would make every number purchase
  a boot failure.
- (b) Refuse the group branch outright when `poolNumbersInEnvelope.length > 0`
  rather than deriving an id whose stability depends on a mutable list. The
  message would file 1:1 with the extraction marker, which is recoverable,
  instead of minting an id that a later pool retirement silently forks.

Related: [`group-mms-including-pool-numbers`](./group-mms-including-pool-numbers.md).
