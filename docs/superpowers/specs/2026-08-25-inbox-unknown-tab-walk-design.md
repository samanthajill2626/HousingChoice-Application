# The Unknown inbox tab's unbounded walk (C1 anchor) - design

Status: **DRAFT 3.** Drafts 1 and 2 were both rejected by two reviewers; both
are in git history. Not gated.

Branch: `feat/inbox-unread-cluster`, cut from `main`.
Issue: [`inbox-filter-tabs-full-walk`](../../issues/inbox-filter-tabs-full-walk.md).
Reviews: `W:\tmp\handbacks\unknown-tab-review-r1-2026-08-25\`,
`...-r2-2026-08-25\`.

## 0. How to read this document

Drafts 1 and 2 each asserted things about the code that were false, and each
built a recommendation on top. The pattern in both was the same: check one
surface, generalise to all surfaces. Reviewers caught six such claims.

So draft 3 states its evidence inline and marks anything unverified as
UNVERIFIED. Where a number appears, it came from
`app/scripts/measure-unread-contact-coverage.ts` after that instrument was
itself corrected - draft 2's numbers were taken from a version that did not
replicate the pager, and are void.

## 1. The measurements

All taken 2026-08-25 with the corrected instrument, on both deployed
environments.

**What the tab costs today** (`--audit-unknown-page`, which replicates the
pager: group rows dropped before any lookup, `findByPhone` then `findByEmail`,
chunk size 30, one row per contact):

| | dev | prod |
| --- | --- | --- |
| partition Queries | 22 | 24 |
| conversations scanned | 637 | 693 |
| **contact lookups PAID** | **636** | **684** |
| matching rows (upper bound) | 12 | 8 |
| contactless rows | 0 | 0 |
| outcome | partition EXHAUSTED | partition EXHAUSTED |

**What the proposed read costs** (`--audit-triage-partition`):

| | dev | prod |
| --- | --- | --- |
| Queries issued | 1 | 1 |
| rows, unfiltered | 16 | 7 |
| rows, origin-excluded | 13 | 4 |
| partition exhausted within budget | yes | yes |

**Whether the two sources agree** (`--audit-tab-vs-partition`, comparing
identities, not counts):

| | dev | prod |
| --- | --- | --- |
| in tab, NOT in partition | 0 | 4 - ALL soft-deleted (benign) |
| in tab, excluded by origin | 0 | 0 |
| in partition, NOT in tab | 1 | 0 |

**The cost case is settled**: ~684 lookups across 24 Queries to return at most 8
rows, versus 7 rows in 1 Query. The row sets reconcile once soft-delete is
accounted for. Three things reviewers feared did NOT materialise: the partition
needs no fill loop at this scale, the contactless class is empty, and the
type-versus-status divergence is zero - every row on both sides is
`needs_review`.

**The cost inverts with triage quality.** The pager breaks when the page FILLS,
so a backlogged tab is cheap and a CLEARED tab is expensive. Discipline causes
the cost, and no test with a healthy backlog can see it.

## 2. The precedent, which drafts 1 and 2 did not know existed

**This read already ships.** `today.ts:855-899` queries the same
`(type=unknown, status=needs_review)` partition through the same `listByType`,
and its comments are a dated record of how it failed. It needed:

- a bounded fill loop of up to `TRIAGE_MAX_PAGES` (10) SEQUENTIAL Queries;
- `excludeOrigin: GROUP_DETECTION_ORIGIN`, because detection mints a contact for
  every unseen roster member into exactly this partition;
- a hard cap on the RESULT, not just the read, because the loop breaks on `>=`;
- a status re-check after the query, as belt to the braces;
- a truncation WARN, added because a partition thick with excluded rows
  exhausted the walk and rendered a short block that read as **"nothing needs
  triage"** - a loud problem turned silent.

Draft 2 described this same read as "one Query per page, never a Scan" with
"none of it a new invariant". Section 1 shows the partition is currently small
enough that one Query suffices - but the precedent's protections exist for a
partition that grows, and **the new reader inherits every one of them or
documents why not.** They are not optional decoration on a working read; they
are the record of it failing in front of an operator.

## 3. Coverage: five classes, each with a decision

Draft 2 named one gap and called it "the one real coverage gap". There are five,
in both directions. Measured counts are current; the DECISIONS are what the
build needs.

| class | on the tab today | returned by the query | decision |
| --- | --- | --- | --- |
| (a) group-detection stubs | NO - they have no 1:1 thread | YES - they fill the partition | Copy `excludeOrigin`. This is the population that produced the empty-block failure. prod 3, dev 3. |
| (b) contact whose only thread is a relay group or closed | NO | YES - `conversationsForContact` returns the RAW union, no status or type filter | Filter by thread type and status at the reader. dev shows 1 such row. |
| (c) `team_member` contacts | **YES** - `roleFromContact` returns `'unknown'` for `team_member` | **NO** - `listByType('unknown')` cannot return them under any option | **OPEN - human decision, section 7.** A silent behaviour change either way. |
| (d) soft-deleted under the resurfacing rule | YES, deliberately, while an unread post-deletion inbound exists | NO by default - and see the constraint below | Must be handled explicitly or the resurfacing feature is silently deleted. prod 4, dev 0. |
| (e) contactless conversations | YES (phone, no contact) | NO - there is no contact to return | Measured ZERO in both environments. See the caveat below. |

**A hard constraint on (d).** `listByType`'s `deleted` option is a TRI-STATE
with no "both": it applies either `attribute_exists(deleted_at)` or
`attribute_not_exists(deleted_at)`. So "all unknown contacts, deleted included"
is **not expressible in one Query**. Resurfacing therefore costs a second query
or a different shape. `softDelete` leaves `type` and `status` untouched, so
soft-deleted unknowns accumulate in that partition permanently - the same
never-shrinks argument draft 2 used against draft 1 applies here, for spam and
wrong numbers, which are exactly what an operator soft-deletes from a triage
queue.

**The caveat on (e), and it is the one methodological point worth keeping.**
Draft 2 wrote "if N is zero the gap is theoretical" - which is the same
snapshot-as-guarantee move draft 2 itself rejected nine lines earlier. Zero
today is not zero by construction: the class is produced by a logged
best-effort failure path, so it measures recent luck. **Decide the second source
unconditionally, or state that the class is accepted as lost and why.**

## 4. The design

Query the triage partition, resolve each contact's thread, render. Cost becomes
proportional to rows RETURNED rather than to an open partition that never
shrinks.

Use the seams that already exist rather than the raw primitives: `contactConversations`
and `buildContactRow` are already extracted in `inbox.ts` and reusable, which
makes this cheaper to build than draft 2 argued.

Required, each from a measured fact or a review finding:

1. **Copy the precedent's protections** - fill loop, `excludeOrigin`, result
   cap, status re-check, truncation WARN - or document why each is unnecessary.
   Section 1 says one Query suffices today; it does not say it always will.
2. **Handle resurfacing explicitly** (class d), knowing it cannot share the
   query with the live rows.
3. **Filter threads by type and status** at the reader (class b).
4. **Make the thread-read failure LOUD.** `contactConversations` swallows a
   query failure and returns an empty list. Today's pager survives that because
   it is standing on a conversation and falls back to it; a contact-side read
   has no such fallback, so an empty result means NO ROW - a transient failure
   silently removes someone from the triage queue. The repo has the right
   precedent in the same file: the group source is loud by contract, because
   "'No group threads' and 'the group query broke' would be indistinguishable".
   Match that.
5. **Bound and page it.** The contacts partition ranges on `status`, not
   activity, so ordering by `last_activity_at` means resolving threads and then
   sorting. At the measured size that is trivial; specify the bound and the
   cursor before it is not.

## 5. Keep the safety net regardless

Give the existing open-partition pager the budget + cursor + `truncated`
contract the unread branch already has. It does not fix this issue - a budget
would page an operator through a tab holding 8 rows - but an unbounded read
should not exist even when it is cheap, and this one is the last on the route.
It carries its own gate: as specified it would light the unfiltered inbox
failure banner on an empty All/Unknown page, which must be solved first.

## 6. Testing

- **The regression test must STARVE the filter**: many open conversations, few
  matches. A fixture that fills a page measures the cheap path and proves
  nothing. `inboxFeed.test.ts` has read-counting machinery to build on - review
  notes it is a starting point rather than a drop-in, so budget for extending it.
- Assert reads for a given queue size, never wall-clock.
- Pin each of the five coverage classes explicitly. They are the behaviour
  change; the cost is just the reason for it.
- Pin the LOUD failure posture (requirement 4) - a swallowed error must fail the
  test, not shrink the queue.
- Mutation-probe everything: reintroduce the defect and watch it fail.
- Five gates bare from the worktree: typecheck, test, smoke, e2e, `npx eslint`
  on the branch's own touched files.

## 7. Open for the human

1. **Class (c), `team_member`.** Their threads sit on the Unknown tab today
   because `roleFromContact` maps `team_member` to `'unknown'`. A contact-side
   read cannot return them. Should a known team member appear in a triage queue
   at all? Either answer is a deliberate behaviour change; inheriting the
   current one by accident is the only wrong outcome. Measured at zero in both
   environments today, so this is cheap to decide now and expensive to discover
   later.

## 8. Out of scope

- The C1 generator-contract slice - independent, can proceed in parallel.
- [`today-shows-phone-instead-of-name`](../../issues/today-shows-phone-instead-of-name.md)
  and
  [`group-roster-name-snapshot-never-refreshed`](../../issues/group-roster-name-snapshot-never-refreshed.md) -
  both found during this work, both their own defects.
- Retyping stale `conv.type` rows. Nothing in this design reads that field.
