---
id: today-contact-hydration-fan-out
title: Today hydrates contacts one Get at a time through a lazy memo, and nobody has measured how many that is
type: debt
severity: low
status: open
area: app/today
created: 2026-08-21
refs: app/src/routes/today.ts:357, app/src/routes/today.ts:371, app/src/routes/today.ts:376, app/src/routes/today.ts:608
---

**Problem.** `GET /api/today` resolves contacts through `getContact`
(today.ts:357), a lazy memoized `contacts.getById` - one round trip per UNIQUE
contact the payload touches, issued serially as assembly walks the boards. Spun
out of [`contacts-batchget-amplified-reads`](contacts-batchget-amplified-reads.md)
on 2026-08-21, which batched six other surfaces and correctly did NOT batch this
one.

**Measure before building. This is the first task, not a preamble.** Nobody
knows N. The memo means cost is unique contacts, not rows, and the payload draws
from placements, tours, deadlines, and relay opted-out members - so N could be
five or fifty depending on the board. Everything below is only worth doing if a
real Today payload (against the imported dataset, not `lean`) touches enough
distinct contacts to matter. `npm run perf:pages` is the sanctioned profiler.
If N is small, CLOSE THIS as wontfix and say so - that outcome is a success.

**Why it is not the mechanical swap the other six were.**

1. `getContact` is a LAZY accessor with three consumers - `resolveName` (:371),
   `isDeletedContact` (:376), and a direct call inside the relay
   opted-out-members loop (:608) whose body BRANCHES on the contact it just
   fetched (`if (!memberContact) continue;` then live-confirms suppression).
   Batching requires knowing every id up front, which means restructuring
   payload assembly into two passes - collect ids, batch, then walk - not
   swapping a call. The ids are not all knowable before the walk today.
2. It needs WHOLE items, so `getManyByIds`, not the display projection: the
   soft-delete check reads `deleted_at` and the :608 branch reads suppression
   flags.
3. `isDeletedContact` SKIPS items from the boards. That puts this squarely in
   the absence-ambiguity class a 2026-08-21 adversarial review caught on the
   broadcast send path: in a batch result, "no such contact" and "we failed to
   read it" are the SAME signal. Today's per-item code deliberately keeps the
   item on a failed read ("A lookup failure is NOT treated as deleted"), and a
   batch conversion must preserve that direction on purpose rather than
   inherit it by luck. See `getManyByIds`'s `requireComplete` option and
   `IncompleteBatchReadError` in `app/src/repos/contactsRepo.ts` - the answer
   here is probably NOT requireComplete (dropping the whole board on a throttle
   is worse than a stale item), but it has to be an argued choice.
4. This file has history. The inbox-unread-index mission added a deleted-contact
   lookup bound here and then REMOVED it, because every bound tried against the
   residue wall was wrong at some threshold - it produced a full block of
   deleted contacts and zero live work. Do not re-introduce a bound as part of
   a batching change.

**Suggested fix (only after the measurement justifies it).** Two-pass assembly:
walk the boards collecting contact ids without resolving, one
`contacts.getManyByIds` for the set, then walk again rendering from the map,
keeping `getContact`'s signature as a map lookup so the three consumers do not
change shape. Preserve: failed-read-keeps-the-item, no lookup bound, and the
`who` fallback to the raw contactId.

Related: [`contacts-batchget-amplified-reads`](contacts-batchget-amplified-reads.md)
(the six batched surfaces and the two repo primitives this would reuse),
[`unread-badge-request-round-trip-cost`](unread-badge-request-round-trip-cost.md)
(the other read-amplification survivor, and the one that actually matters).
