---
id: unknown-queue-cap-starves-needs-review
title: The Unknown tab's bounded read cuts in STATUS order, so its cap starves `needs_review` and keeps already-reviewed rows
type: bug
severity: med
status: open
area: app
created: 2026-08-26
refs: app/src/lib/unknownQueue.ts, app/src/routes/inbox.ts, app/src/repos/contactsRepo.ts, app/src/lib/tables.ts:90-93, app/test/unknownQueue.test.ts, app/test/helpers/contactsPartitionFake.ts
---

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

**The fact is PINNED so it cannot be quietly rediscovered or contradicted:**
`app/test/unknownQueue.test.ts` ("THE CAP STARVES needs_review") drives the real
collector over a mixed-status partition and asserts the `needs_review` rows are
the ones cut, and `app/test/helpers/contactsPartitionFake.ts` rule 6 models the
range-key sort that makes it expressible at all - its absence is why no test
could catch this before.

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

Full context, including the coverage-class decisions this queue implements:
[`inbox-filter-tabs-full-walk`](inbox-filter-tabs-full-walk.md).
