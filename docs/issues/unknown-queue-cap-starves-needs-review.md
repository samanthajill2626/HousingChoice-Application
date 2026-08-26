---
id: unknown-queue-cap-starves-needs-review
title: The Unknown tab's bounded read cuts in STATUS order, so its cap starves `needs_review` and keeps already-reviewed rows
type: bug
severity: med
status: resolved
area: app
created: 2026-08-26
updated: 2026-08-26
refs: app/src/lib/unknownQueue.ts, app/src/routes/inbox.ts, app/src/repos/contactsRepo.ts, app/src/lib/tables.ts:90-93, app/test/unknownQueue.test.ts, app/test/helpers/contactsPartitionFake.ts
---

**RESOLVED 2026-08-26 by suggested fix 2 - "query the two statuses explicitly
and interleave" - taken as far as it goes: the tab now reads ONE bounded Query
per status BLOCK, `needs_review` first and `active` second, and pages the blocks
with the index's own cursor. There is no cap left to starve anything.**

The block list and its order are one named, isolated decision
(`UNKNOWN_QUEUE_BLOCKS` in `app/src/lib/unknownQueue.ts`), derived from an
exhaustive `satisfies Record<...>` map over the statuses `statusAllowlistFor`
declares legal for `unknown` - so a newly-legal status is a TYPECHECK failure,
not a silently unread block. Coverage did not narrow: every legal status is a
block and every block is read, so `(unknown, active)` contacts - class f - stay
on the tab exactly as before. Only the ORDER changed.

`listByType` was NOT reversed (suggested fix 1), so the sibling
`broadcast-audience-truncation-drops-searching-tenants` is untouched and still
open on its own terms.

**What replaced the cap:** a per-request SCAN BUDGET on raw index rows
(`UNKNOWN_QUEUE_SCAN_BUDGET`, 1000). Spending it returns the rows found so far
PLUS the cursor the request stopped at, so nothing is withheld and the wire
`truncated` flag is never set - the cursor is the continuation signal.

**Pins:** `app/test/unknownQueue.test.ts` ("the UNTRIAGED block is exhausted
BEFORE the reviewed block is read"), `app/test/inboxUnknownTab.test.ts` ("THE
FULL WALK"), and an integration walk against the real byTypeStatus index in
`app/test/inbox.integration.test.ts`. The old pin, "THE CAP STARVES
needs_review", is deleted - it asserted the defect as a fact and there is no cap
for it to describe.

The rest of this file is the original record, kept because the mechanism it
documents (the ascending range key, the status-only triage PATCH that
manufactures `(unknown, active)` rows and never drains them) is still true of
the index and of the product; only the CONSEQUENCE is gone.

**Problem.** The Unknown inbox tab reads the `(type='unknown')` byTypeStatus
partition under two bounds - a hard result cap (`UNKNOWN_QUEUE_MAX_ROWS`, 200)
and a page budget (`UNKNOWN_QUEUE_MAX_PAGES` x `UNKNOWN_QUEUE_PAGE_SIZE`,
10 x 100). Both cuts were designed and documented as recency-arbitrary. **They
are not. They are deterministic and they cut along `status`.**

`byTypeStatus` is `(hash: type, range: status)` (`lib/tables.ts:90-93`) and
`contactsRepo.listByType` sets **no `ScanIndexForward`**, so a Query returns the
partition ASCENDING by range key. Within `type='unknown'` the only legal statuses
are `needs_review` and `active` (`NON_TENANT_STATUSES`), and
`'active' < 'needs_review'` lexicographically. **So every `active` unknown is
returned before any `needs_review` one** - and a bound therefore keeps rows
somebody has already reviewed while discarding the ones nobody has looked at,
which is the entire point of the queue. The order is stable, so the same rows are
hidden on every render, not a rotating sample.

It COMPOUNDS with the status-only triage path. `PATCH /api/contacts/:id` accepts
a status-only triage (`routes/contacts.ts`, re-validated against
`statusAllowlistFor(stored.type)` = `['needs_review','active']` for unknown),
which leaves `type='unknown'` intact - so the row never leaves the queue AND it
moves into the `active` block, which is the block the Query returns FIRST.
Half-triaged rows are promoted to the front of the read and crowd out untriaged
ones. That PATCH is also the ONLY UI-reachable way to mint an `(unknown, active)`
row (the `POST /api/contacts` create default is API-only - `KindPicker` has no
`unknown` segment), and nothing drains one except a re-type or a soft-delete. So
the population is monotonic.

Failure shapes to watch for:

- 200+ live `(unknown, active)` contacts with an open thread: the cap fills
  entirely from the `active` block and NO `needs_review` contact can appear on
  the tab at all.
- 1000+ rows of `(unknown, active)` or soft-deleted residue ahead of the
  `needs_review` block: the page budget expires before a single `needs_review`
  row is read, and the tab renders its ordinary empty state with only a server
  WARN behind it.

**Live impact today: NONE - this is latent behaviour plus a design-record
defect.** Measured 2026-08-25 with `--audit-triage-partition --no-status-narrow`
on `app/scripts/measure-unread-contact-coverage.ts`: 16 unknown contacts in dev,
7 in prod, with ZERO `(unknown, active)` in either - two orders of magnitude from
the cap.

**The flag is not a footnote; it is what makes the zero mean anything.**
`--audit-triage-partition` WITHOUT `--no-status-narrow` queries
`status: 'needs_review'`, so it reports zero `active` rows in every possible
world, including one full of them. The `(unknown, active)` count is the single
figure that makes this LATENT rather than LIVE, and it is the one figure a
narrowed run structurally cannot produce.

**Found** 2026-08-25/26 by the plan-blind adversarial reviewer (HIGH-1) on
`feat/inbox-unread-cluster`, and reproduced live on the real index during that
branch's self-QA. Recorded rather than fixed, by ruling - see below.

**The fact WAS pinned so it could not be quietly rediscovered or contradicted:**
`app/test/unknownQueue.test.ts` ("THE CAP STARVES needs_review") drove the real
collector over a mixed-status partition and asserted the `needs_review` rows
were the ones cut. That pin was DELETED on 2026-08-26 with the cap it described;
see the resolution at the top for what replaced it.
`app/test/helpers/contactsPartitionFake.ts` rule 6 still models the range-key
sort that made this expressible at all - its absence is why no test could catch
it before.

**Suggested fix.** Three options; none was taken on the branch that found it,
because `listByType` is a SHARED read and the governing spec is human-gated.

1. **`ScanIndexForward: false`** on the `listByType` Query, or as an option the
   unknown queue opts into, reversing the partition so `needs_review` comes
   first. `today.ts`'s triage block, `GET /api/contacts?type=`, the importer and
   `app/src/services/audienceResolution.ts` all use this read, so even behind an
   option this is a repo-wide change with its own review.
2. **Query the two statuses explicitly and interleave** (`needs_review` first,
   two bounded Queries).
3. **Make the cut status-aware** rather than positional.

**Consider this issue TOGETHER with
[`broadcast-audience-truncation-drops-searching-tenants`](broadcast-audience-truncation-drops-searching-tenants.md).**
That is the same unstated sort in `audienceResolution.ts`, and it is the second
caller that has to be considered if option 1 is taken - note the flip helps the
two callers in OPPOSITE senses only by coincidence: descending puts `searching`
first (what a send wants) there, and `needs_review` first (what triage wants)
here. Verify both before flipping either.

**Reopen / escalate** when a deployment's unknown partition approaches either
bound, or the moment anyone wants `(unknown, active)` rows to stop crowding the
queue. The re-check is TWO numbers, both from
`--audit-triage-partition --no-status-narrow`:

1. the unknown partition SIZE, against the cap (200) and the page budget
   (10 x 100); and
2. the **`(unknown, active)` count**, which is half the trigger on its own - it
   is the block that fills the cap first, so it can starve the queue long before
   the partition as a whole looks large. A narrowed run reports it as zero
   unconditionally and is not evidence of anything.

Both now come from the `partition statuses` breakdown that audit prints. **That
breakdown did not exist when this issue was first filed** - the audit printed
only totals, and the tab-vs-partition audit breaks down the TAB's rows rather
than the partition's - so the reopen check named a number nobody could produce.
Corrected 2026-08-26 in the same script (print-only, no measured value changed).

**Baseline, measured 2026-08-26 on deployed data** (before the breakdown landed,
so the `active` counts below are derived arithmetically rather than read off):

| | dev | prod |
| --- | --- | --- |
| partition, unfiltered | 16 | 8 |
| partition, origin-excluded | 13 | 5 |
| Queries issued | 1 | 1 |
| partition exhausted in budget | yes | yes |
| `(unknown, active)` | **0 or 1** - 12 of the 13 live non-stub rows are confirmed `needs_review`; the 13th is the "in partition, not on tab" row and its status was not printed | **0** - confirmed: 9 tab rows minus 4 soft-deleted = 5 live, all `needs_review`, and origin-excluded partition = 5 |

Both are ~200x from the cap, which is why this stays LATENT. Re-run the audit
after the breakdown lands to replace dev's derived range with a read number.

Full context, including the coverage-class decisions this queue implements:
[`inbox-filter-tabs-full-walk`](inbox-filter-tabs-full-walk.md).
