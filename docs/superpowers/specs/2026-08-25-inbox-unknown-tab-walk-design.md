# The Unknown inbox tab's unbounded walk (C1 anchor) - design

Status: **DRAFT 4.** Drafts 1-3 are in git history. Drafts 1 and 2 were
rejected outright; draft 3 was judged the right shape needing one editing pass
by one reviewer and a revision by the other. Not gated.

Branch: `feat/inbox-unread-cluster`, cut from `main`.
Issue: [`inbox-filter-tabs-full-walk`](../../issues/inbox-filter-tabs-full-walk.md).
Reviews: `W:\tmp\handbacks\unknown-tab-review-r1-2026-08-25\`,
`...-r2-2026-08-25\`.

## 0. How to read this document

Drafts 1 and 2 each asserted things about the code that were false, and each
built a recommendation on top. The pattern in both was the same: check one
surface, generalise to all surfaces. Reviewers caught six such claims.

So this draft states its evidence inline and marks anything unverified as
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
accounted for. Two things reviewers feared did NOT materialise: the partition needs no fill
loop at this scale, and the contactless class is empty. A THIRD - that the
type-versus-status divergence measured zero - turned out to be a snapshot rather
than a structural fact, and is corrected in section 3 class (f). Every one of
these numbers describes TODAY; where a permanent decision rests on one, the
document says so.

**The cost inverts with triage quality.** The pager breaks when the page FILLS,
so a backlogged tab is cheap and a CLEARED tab is expensive. Discipline causes
the cost, and no test with a healthy backlog can see it.

## 2. The precedent, which drafts 1 and 2 did not know existed

**This read already ships.** `today.ts:855-899` queries the same
`(type=unknown, status=needs_review)` partition through the same `listByType`,
and its comments are a dated record of how it failed. It needed:

- a bounded fill loop of up to `TRIAGE_MAX_PAGES` (10) SEQUENTIAL Queries;
- `excludeOrigin: GROUP_DETECTION_ORIGIN`, because detection mints a contact for
  every unseen roster member into exactly this partition - **but see section 3:
  this is the ONE protection this design must NOT inherit**, and the reason it
  is safe in `today.ts` is stated four lines past the range cited here;
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

## 3. Coverage: SIX classes, each with a decision

Draft 2 named ONE gap and called it "the one real coverage gap". Draft 3 found
five and presented that as complete. A cold reviewer asked to hunt for a sixth
found one - class (f) - which is why this table is presented as the current best
enumeration rather than a closed set. Measured counts are current; the DECISIONS are what the
build needs.

| class | on the tab today | returned by the query | decision |
| --- | --- | --- | --- |
| (a) group-detection stubs | **SOMETIMES** - a stub that later TEXTS gets a 1:1 thread and shows on the tab today | YES - they fill the partition | **Do NOT copy `excludeOrigin`** - see below. A threadless stub yields no `maxConv` and so no row anyway. prod 3, dev 3. |
| (b) contact whose only thread is a relay group or closed | NO | Returned by the CONTACT query, then dropped | **Already handled by the seam**: `contactConversations` filters `status === 'open' && type !== 'relay_group'`. No new work. |
| (c) `team_member` contacts | **YES** - `roleFromContact` returns `'unknown'` for `team_member` | **NO** - `listByType('unknown')` cannot return them under any option | **OPEN - human decision, section 7.** A silent behaviour change either way. |
| (d) soft-deleted under the resurfacing rule | YES, deliberately, while an unread post-deletion inbound exists | NO by default - and see the constraint below | Must be handled explicitly or the resurfacing feature is silently deleted. prod 4, dev 0. |
| (e) contactless conversations | YES (phone, no contact) | NO - there is no contact to return | Measured ZERO in both environments. See the caveat below. |
| **(f) `type=unknown` with a status other than `needs_review`** | **YES** | **NO, if the query narrows on status** | **Query `type=unknown` with NO status filter.** See below - this class is STRUCTURAL, not incidental. |

**Why `excludeOrigin` must NOT be inherited (class a).** Both round-3 reviewers
found this independently and it is the sharpest lesson in the document.
`today.ts` can afford that exclusion because it is a TWO-SOURCE union, and its
own comment four lines past the range draft 3 cited says so: the exclusion is
safe there because "a real unknown caller who TEXTED still surfaces through the
conversation-row source above". This design DELETES that second source. A
group-detection stub keeps its `origin` forever - nothing rewrites it - so a
roster member who later texts in has a real 1:1 thread, is on the tab today, and
would be silently dropped.

And the exclusion buys nothing here: a stub with no thread produces no
`maxConv`, so it produces no row regardless. Draft 3 told the builder to copy
the precedent's protections wholesale; the correct instruction is to copy each
one WITH ITS REASON and keep only the reasons that still hold.

**Class (f) is structural, and it retires the status question.** A contact
CREATED as `unknown` defaults to `status: 'active'`, not `needs_review`
(`contacts.ts:881-884`); a bare `status: 'active'` PATCH is accepted; and a
re-type to unknown does not normalize an existing valid-but-wrong status. So
`(unknown, active)` is the DEFAULT for a created unknown contact, not an edge
case - and `statusAllowlistFor('unknown')` is `['needs_review', 'active']`, so
both are legal.

Draft 3 measured zero divergence and used it to close a question draft 2 had
correctly escalated to the human. That was the snapshot-as-guarantee fallacy
this document criticises elsewhere, applied to the most ordinary mechanism in
the set.

**The fix is to narrow LESS: query `type=unknown` with no status filter.** A
contact that gets triaged leaves the `unknown` partition entirely (it is
retyped), so the type alone is the queue. This removes class (f), removes the
type-versus-status product question, and removes one failure mode - at the cost
of returning `active` unknowns the tab already shows today, which is the
behaviour we want to preserve.

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

1. **Query `type=unknown` with NO status narrowing**, and do NOT copy
   `excludeOrigin` (section 3, classes a and f). Take the precedent's OTHER
   protections - a bounded fill loop, a hard cap on the RESULT, and a truncation
   WARN - because those guard a partition that grows and this one does too.
2. **Read the WHOLE capped queue, then sort in memory. Do not try to page it in
   activity order** - that construction does not exist. With `status` supplied
   the range key is a constant, and even without it the index has no activity
   dimension, so a bounded page plus an in-memory sort yields globally
   out-of-order pages. Read up to the cap, sort by `last_activity_at`, and when
   the cap truncates, say so with the precedent's WARN. At 7-16 rows this is
   trivial; it is specified now because it will not always be.
3. **Handle resurfacing via `byUnread`, not a second `deleted:true` walk**
   (class d). `listByType`'s `deleted` option is a tri-state with no "both", so
   the naive shape is a second forever-growing partition walk with per-row
   hydration. But a resurfacing row is UNREAD BY DEFINITION, and this route
   already consumes `byUnread` - which is bounded, sparse, and exactly the set
   in question.
4. **Discriminate a failed thread read from an empty one - do not swallow it,
   and do not throw.** `contactConversations` returns `[]` for both "every
   thread filtered out" (normal) and "the query threw" (a dropped triage row),
   so the seam cannot carry the distinction. The nearest precedent is in this
   same file and is neither: the `filter=unread` contact arm discriminates lag
   from a real read with ONE AUTHORITATIVE BASE-TABLE READ. Match that shape.
   Throwing would turn a one-row miss into a whole-tab 500; swallowing silently
   removes someone from a triage queue.
5. **The empty state must not look like a failure.** A cleared triage queue is
   the NORMAL zero-row state for this tab, and the inbox failure banner is not
   filter-gated. Getting this wrong reproduces the precedent's own worst
   outcome - a surface that says nothing needs attention when it simply could
   not tell.

Class (b) needs no requirement: `contactConversations` already filters
`status === 'open' && type !== 'relay_group'`. Draft 3 asked for that work
twice over.

## 5. Keep the safety net regardless

Give the existing open-partition pager the budget + cursor + `truncated`
contract the unread branch already has. It does not fix this issue - a budget
would page an operator through a tab holding 8 rows - but an unbounded read
should not exist even when it is cheap, and this one is the last on the route.
It carries its own gate: as specified it would light the unfiltered inbox
failure banner on an empty All/Unknown page, which must be solved first. **That
gate is NOT specific to the safety net** - the banner is not filter-gated, so
requirement 5 owes the same fix for the new reader, whose normal state is an
empty queue.

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
- **Take a PARITY BASELINE before switching sources.** `inboxUnreadParity.test.ts`
  is the exact precedent: assert the new reader returns the same row set as the
  old one over the same fixture, class by class, so a coverage regression fails
  a test rather than going unnoticed in production. This is the single most
  valuable test here, because every failure mode in section 3 is a row that
  quietly stops appearing.
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
