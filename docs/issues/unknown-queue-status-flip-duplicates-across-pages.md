---
id: unknown-queue-status-flip-duplicates-across-pages
title: A mid-walk `status` write duplicates or skips an Unknown-tab row across pages, because the cursor carries a position and not a seen-set
type: bug
severity: med
status: open
area: app/inbox
created: 2026-08-26
refs: app/src/routes/inbox.ts, app/src/lib/unknownQueue.ts, app/src/repos/contactsRepo.ts, dashboard/src/routes/inbox/useInbox.ts, app/test/inboxUnknownTab.test.ts
---

**Problem.** The Unknown tab pages the `(type='unknown')` byTypeStatus partition
as an ordered sequence of `(type, status)` BLOCKS - `needs_review` first, then
`active` - and its cursor is a POSITION inside one of them
(`{q, b, k}`, `app/src/routes/inbox.ts`, `decodeUnknownCursor` /
`encodeUnknownCursor`). But `status` is that index's RANGE KEY *and* a mutable,
operator-written field. A contact whose status changes between two requests of
the same walk does not merely move inside a block, it CHANGES BLOCK - forward
into a block not yet read (served twice) or backward into a block already read
(served never).

The only guard is `emitted`, a per-REQUEST `Set` in the block-consuming loop. By
construction it cannot see across the page boundary, which is where the damage
happens.

**Proved, both directions** (rework review A1, 2026-08-26, driving the real
exported `aggregateInbox` through `app/test/helpers/contactsPartitionFake.ts`).
Queue: `c-n0..c-n3` `needs_review`, `c-a0..c-a2` `active`; `limit=3`.

```
PROBE1 pages: [["c-n2","c-n1","c-n0"],["c-a1","c-a0","c-n3"],["c-a2","c-n0"]]
PROBE1 duplicates: [ 'c-n0' ]
PROBE2 pages: [["c-n2","c-n1","c-n0"],["c-a1","c-a0","c-n3"],[]]
PROBE2 missing: [ 'c-a2' ]
```

- DUPLICATE: after page 1 (cursor inside block 0, after `c-n2`), the operator
  marks the already-served `c-n0` reviewed. It leaves block 0 behind the cursor
  and joins block 1, which has not been read - so it ships on page 1 AND page 3.
- SKIP: after the same page 1, a reviewed contact is re-opened
  (`active -> needs_review`, permitted by `statusAllowlistFor('unknown')`). Its
  id sorts BEFORE the block-0 cursor, so block 0 never reaches it and block 1 no
  longer holds it. `c-a2` is served on no page at all, and the walk still ends
  `nextCursor: null`. `contactId` is `contact-<uuid>` and the index order is not
  time-ordered, so roughly half of such flips land before the cursor.

**Reachability - two conditions, both ordinary.**

1. MORE THAN ONE PAGE: strictly more than the request `limit` live queue rows.
   That is **30** from the dashboard (`dashboard/src/routes/inbox/useInbox.ts`),
   NOT `UNKNOWN_QUEUE_PAGE_SIZE` (100) - an in-code comment claimed the larger
   number until 2026-08-26. The repro above needs SEVEN rows at `limit=3`.
2. A STATUS WRITE IN THE GAP: not a millisecond race between two sequential
   Queries (that window is the one `emitted` genuinely covers) but the
   OPERATOR'S OWN GAP BETWEEN LOAD-MORE CLICKS - seconds to minutes - and the
   write is the operator's own triage click. `PATCH /api/contacts/:id` accepts a
   status-only triage and the dashboard's edit form reaches it, which is also
   the only UI-reachable manufacturer of `(unknown, active)` at all.

NOT reachable on today's data: the measured partitions are 16 dev / 7 prod
(2026-08-25) against a page of 30, so no multi-page walk exists yet.

**The asymmetry, which is why this is filed at `med` and not higher.** The
COMMON operator action - triaging, `needs_review -> active` - produces the
DUPLICATE. A duplicate is at least visible: the dashboard keys the wire row
`c:<contactId>` (`useInbox`, `rowKey`), so it renders as a doubled row under a
duplicate React key. The RARE action - un-triaging, `active -> needs_review` -
produces the SKIP, and a skip is invisible: the feed reports the queue as fully
drained while omitting a row, and only restarting the tab from page one recovers
it.

**Why a cross-page seen-set was rejected.** Carrying the served ids in the
cursor (the mirror of what the `unread` branch does) would close the duplicate -
though not the skip - at the cost of an UNBOUNDED cursor that grows with every
page. The `unread` branch pays for its seen-set with a hard depth cap, and
escaping exactly that boundedness is why this feed was reworked into an
unbounded, index-cursor-paged read
([`unknown-queue-cap-starves-needs-review`](unknown-queue-cap-starves-needs-review.md)).
Trading the cap back for a set is the defect this feed exists to remove.

**No test asserts this**, deliberately: a test for it would have to pin the
DEFECT as correct behaviour. `app/test/inboxUnknownTab.test.ts` ("a
WITHIN-REQUEST duplicate ships ONE row") covers only the shape `emitted`
handles, and says so in its own comment; its name and comment were corrected on
2026-08-26 because they previously described THIS defect while testing the other
one.

**Suggested fix.** Three options, none free:

1. **Drop the block decomposition** and page the whole `type='unknown'`
   partition with one Query. A row can then only move WITHIN one continuous key
   space, so a flip becomes an ordinary re-position rather than a block change.
   Cost: queue order becomes status-lexicographic (`active` before
   `needs_review`) and starvation has to be re-solved another way - which is the
   problem the blocks were introduced to fix.
2. **Denormalize `last_activity_at` onto the contact and page an
   activity-ordered GSI**
   ([`denormalize-contact-last-activity-for-ordered-paging`](denormalize-contact-last-activity-for-ordered-paging.md)).
   This is the standing plan for this reader, and it **does NOT remove the
   mechanism** - an earlier version of this paragraph claimed it did, which is
   corrected here (round-2 review C1, 2026-08-26). The mechanism is not "the
   range key is operator-written", it is "the cursor is a position in an
   ordering keyed on a MUTABLE attribute", and `last_activity_at` is mutated by
   every inbound and outbound message on the contact's thread - for a queue of
   unknown numbers, an unknown caller texting in again is the most common event
   the system sees, and it needs no operator at all. What it buys and what it
   costs:
   - The DUPLICATE direction genuinely disappears: under newest-first paging an
     activity bump only ever moves a row TOWARD the head, i.e. to positions the
     cursor has already passed.
   - The SKIP direction gets MORE frequent, not less. A row older than the
     cursor that receives a message jumps ahead of the cursor and is served on
     no page - the invisible half this issue argues is the worse one, now
     triggered by any message rather than by a rare un-triage click.
   - It still owes the same seen-set cost. Stable paging over a mutable sort key
     needs a seen-set or a snapshot predicate either way, which is the unbounded
     cursor rejected below.
   So it buys ORDERING, not correctness. Judge it on that.
3. **Accept it and keep it documented** (today's posture). The in-code comment
   at the `emitted` guard in `app/src/routes/inbox.ts` states both directions,
   both reachability conditions and the visible/invisible asymmetry, and points
   here.

**Reopen / escalate** when the live unknown partition exceeds one dashboard page
(30 live rows with an open non-relay thread), which is when condition 1 stops
being hypothetical. The count comes from
`app/scripts/measure-unread-contact-coverage.ts --audit-triage-partition
--no-status-narrow`.

**This issue is NOT closed by option 2.** The defect follows whichever MUTABLE
attribute is the paged ordering's range key - `status` today,
`last_activity_at` after the denormalization - so read the corrected option 2
above before marking it resolved on the strength of that work landing.
