---
id: group-identity-pool-number-mutability
title: Retiring a relay pool number silently re-mints the conversationId of any carrier group that number appears in, and no detector fires
type: bug
severity: med
status: open
area: app
created: 2026-08-11
refs: app/src/services/groupIdentity.ts:8, app/src/services/groupIdentity.ts:104, app/src/routes/webhooks/twilio.ts:990, app/src/services/groupIdentityFingerprint.ts:36, app/src/repos/poolNumbersRepo.ts:280
---

**Problem.** A native group thread's identity is
`conversationIdForGroup(<sorted roster>)`, where the roster is the carrier
envelope's participants MINUS three things: the business number, the
`GROUP_IDENTITY_EXCLUDED_NUMBERS` list, and every ACTIVE relay pool number.

`app/src/services/groupIdentity.ts:8-9` states the contract as "The exclusion set
is part of that identity contract and is fixed at deploy". That is true of two of
the three inputs and NOT true of the third:

- `config.groupIdentityExcludedNumbers` - genuinely fixed: pinned by
  `verifyGroupIdentityFingerprint` (`groupIdentityFingerprint.ts:36-39`), which
  refuses to boot when it changes.
- `config.businessPhoneNumber` - genuinely fixed: a scalar, E.164-validated at
  boot.
- `poolNumbers.listActive()` - **MUTABLE**. It is re-read every 60 seconds
  (`app/src/routes/webhooks/twilio.ts:988-1019`) and is defined by the pool's
  `active` partition, which a released or retired number LEAVES. Retiring a relay
  pool number is an ordinary, sanctioned relay-lifecycle operation
  (`poolNumbersRepo.ts:280, :508`) that nothing connects to group identity.

**Failure walk.** A contact starts a carrier group to the business number that
also includes a relay pool number they happen to have in their phone. (That
population is reachable - see
[group-mms-including-pool-numbers](./group-mms-including-pool-numbers.md), which
establishes that contacts really do have pool numbers saved.)

1. While the pool number is ACTIVE: `groupIdentity` subtracts it
   (`:105-111, :133`), WARNs `relay pool number in a carrier group outside-roster
   position` (`:149-154`), and derives thread id **X**. Everything works.
2. The number is later RETIRED. Nothing about the group changes; nobody involved
   knows the two are connected.
3. The next inbound on the SAME carrier group: the number is no longer in
   `listActive()`, so it SURVIVES into the roster. `conversationIdForGroup` now
   hashes a strictly larger roster and yields id **Y**. `getById(Y)` misses, and
   `createGroupTextThread` mints a SECOND thread for the same people with no
   back-pointer to X (`twilio.ts:1186-1202`).
4. **No detector fires.** `businessNumberSurvived` is false (the business number
   was excluded correctly). `poolNumbersInEnvelope` is empty - precisely BECAUSE
   the number stopped being a pool number. The fingerprint guard is not watching
   this input. The only trace is that the staff inbox quietly grows a duplicate
   thread.

This is exactly the outcome `groupIdentityFingerprint.ts:58-71` refuses to boot
over when the CONFIG list changes ("existing threads are orphaned and the next
inbound opens a SECOND thread for the same people"), reachable through an input
the guard does not cover.

**Milder same-shape variant.** Two app processes with 60s-skewed pool caches
(`twilio.ts:948, :990`) can derive two DIFFERENT ids for one envelope during the
retirement window itself, without any operator doing anything wrong.

**Why no fix landed in the group-texting mission.** There is no cheap correct
option. Fingerprinting a legitimately-mutable set is the wrong shape - it would
turn every ordinary pool retirement into a boot refusal. The detection-time
"relay pool number in a carrier group outside-roster position" WARN partially
covers the entry: it names, at the time of the FIRST inbound, every group that is
exposed to this. Nothing acts on that WARN today.

**Suggested fix.** Options, roughly in increasing cost:

1. **Pin the subtraction per thread, not per read.** Persist on the group thread
   the set of numbers that were subtracted when its id was first derived, and
   have detection subtract the union of (currently active pool numbers) and
   (numbers any existing thread pinned). Identity then stops depending on the
   pool's live state.
2. **Guard the retirement instead of the read.** Before retiring a pool number,
   query for group threads whose derivation WARNed on that number and refuse or
   warn loudly, so a retirement that would fork a thread is an operator decision
   rather than a silent one. Cheapest, but it only covers the deliberate path.
3. **Make the existing WARN actionable.** At minimum, record the exposed thread
   ids somewhere queryable so the population is enumerable when this is picked
   up, rather than needing a log archaeology run.

Whichever is chosen, also decide what happens to a fork that ALREADY happened -
there is no group-thread merge today, and merging is the same missing capability
that [import-group-thread-retraction](./import-group-thread-retraction.md) needs.
