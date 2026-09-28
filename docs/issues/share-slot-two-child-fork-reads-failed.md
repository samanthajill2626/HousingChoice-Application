---
id: share-slot-two-child-fork-reads-failed
title: A share recipient whose failed text has TWO retry children (1b's two-child fork, or a stale-tab Retry on a pre-1b chain) can read a final failure although the automatic retry may have arrived
type: bug
severity: low
status: open
area: app/broadcasts
created: 2026-09-28
refs: app/src/services/shareAttemptOutcome.ts:123, app/src/lib/shareAttemptOrder.ts, app/src/routes/api.ts:1653, app/scripts/repair-share-outcomes.ts
---

**Found by.** `feat/share-sent-outcome` spec section 8 ("1b's two-child fork"),
accepted there; filed at the branch's fix wave 1 (plan T15) so the residual is
tracked. Anchors at that fix wave.

**Problem.** A share slot orders a recipient's attempts by message id - the
provider's time - and records the NEWEST attempt's outcome; an older attempt
applies only as a delivery (spec D2, `app/src/services/shareAttemptOutcome.ts:123-131`).
A retry that ended UNRESOLVED with no row is ordered right after the attempt
it retried (the row-less key `<retried>~`, `app/src/lib/shareAttemptOrder.ts`),
so it sorts BEFORE every later row. That order assumes one chain per retried
row. Two chains can exist:

- **1b's two-child fork** - an automatic retry and a staff Retry of the same
  failed text that both go out (the in-flight overlap Stage 1b names in
  [manual-retry-double-send-residual-windows](./manual-retry-double-send-residual-windows.md),
  "What remains");
- **a stale-tab Retry on a pre-1b chain** - a Retry pressed from a stale view
  on a row whose automatic retry already went out before 1b deployed: that
  child has no `retrychild#` pointer, so the route's "any child supersedes"
  refusal cannot see it (`app/src/routes/api.ts:1653-1657`; no backfill).

When the automatic chain ends unresolved (the text may have arrived) and the
manual chain's row later FAILS, the manual failure is the newer attempt and the
slot records it: the recipient reads a final failure - not flagged "Already
sent" in the composer, "Not sent" / "No tenants reached" when nobody else was
reached - although the automatic retry may have been delivered. A DELIVERED
receipt from either chain still wins at any age (I2), so the gap is an
unresolved automatic end beside a failed manual one. The repair (D8) walks
both children as one chain and decides the same way.

**Why accepted.** Rare on rare: it needs 1b's fork (itself a named residual)
or a pre-1b chain, plus an unresolved end, plus a failed manual text. Spec
section 8 accepts it with 1b's residual; a double text is at most HIGH on the
standing scale, and this is LOW.

**Directions (not taken).** Order the slot per chain (a recipient reads the
SAFEST of its chains' ends: a delivery, else unresolved, else failure); or
close 1b's fork itself (the route's conditional write on the attempt record,
the direction in the 1b issue).

**Related.** [manual-retry-double-send-residual-windows](./manual-retry-double-send-residual-windows.md),
[send-reconcile-job-residues](./send-reconcile-job-residues.md) (pre-deploy
children have no pointer), [broadcast-30003-retry-never-updates-slot](./broadcast-30003-retry-never-updates-slot.md)
(resolved by the branch).
