# The Unknown inbox tab's unbounded walk (C1 anchor) - design

Status: **DRAFT 2, rewritten 2026-08-25 after review round 1 returned NOT
BUILDABLE from both reviewers.** Draft 1 is in git history; its recommendation
is withdrawn and the instrument behind its numbers was wrong. Not gated.

Branch: `feat/inbox-unread-cluster`, cut from `main` @88ac7b36.
Issue: [`inbox-filter-tabs-full-walk`](../../issues/inbox-filter-tabs-full-walk.md).
Reviews: `W:\tmp\handbacks\unknown-tab-review-r1-2026-08-25\`.

## 1. What survived review, and what did not

**Survived: the cost, and its direction.** An Unknown-tab page render exhausts
the open partition and pays a contact lookup per row - measured at 637 (dev) and
693 (prod) - and `useInbox` re-issues it on every debounced
`conversation.updated` while an operator sits on the tab. Both reviewers
re-derived this independently and neither could break it.

**Survived: the inversion.** The pager breaks when the page FILLS, so a
backlogged tab is cheap and a CLEARED tab is expensive. Discipline causes the
cost. A regression test with a healthy backlog measures the cheap path and
proves nothing.

**Did NOT survive - four claims, all corrected:**

1. **"Nothing renders the denormalized name."** FALSE. `today.ts:1074-1081`
   renders `participant_display_name` and never consults the contact, so ~580
   threads show a bare PHONE where the operator should see a person. Draft 1
   used that false claim to declare the drift costless. Now filed separately as
   [`today-shows-phone-instead-of-name`](../../issues/today-shows-phone-instead-of-name.md)
   at `high`.
2. **"Nothing pre-filters on `conv.type`."** FALSE. `today.ts:779` branches on
   it. So retyping ~610 threads is a VISIBLE PRODUCT CHANGE - Today rows move
   buckets and change their links - not a hygiene backfill.
3. **Hole 4 was backwards.** The importer's CONVERSATION type write is
   `if_not_exists(#type, :type)`. The real unlisted hole is `apply.ts:967`, an
   unconditional CONTACT type write that can demote to `unknown` with no fan-out
   at all.
4. **The instrument did not replicate the pager** - it counted relay groups as
   matches, used the wrong resolver, the wrong chunk size, and counted per
   conversation rather than per contact. Fixed and re-probed. The match counts
   quoted from draft 1 are VOID; the cost figure is not.

Two more, both accepted: `setConversationType` does not exist (it is `setType`,
with zero callers), and there are further contact creators with no fan-out at
all (`public.ts:257`, `unmatchedEmail.ts:462`).

## 2. Why draft 1's recommendation is withdrawn

Draft 1 proposed making `conv.type` trustworthy and pre-filtering on it. Against
the corrected facts that is the wrong shape:

- The backfill it needs is an operator-visible product change (correction 2),
  not a silent repair.
- It makes a denormalization load-bearing for what an operator sees, and a row
  the pre-filter skips fails SILENTLY.
- Its miss-risk argument rested on "zero drift in that direction today", which
  is a snapshot, not a structural guarantee.
- A `FilterExpression` pre-filter would break the pager's mid-chunk boundary
  re-query and skip rows on page 2.
- It leaves the unbounded walk in the issue's title unfixed, on a partition that
  structurally never shrinks - nothing closes a 1:1 thread.

The last point is the deepest: draft 1 optimised the CONSTANT on a walk whose
length grows forever.

## 3. The recommended shape: query the triage queue directly

**Drive the Unknown tab from the CONTACT side.** The repo already has the index
and already says what it is for:

> On the byTypeStatus GSI, `(type=unknown, status=needs_review)` IS the human
> triage queue, resolved by the M1.4/M1.5 review flows.

`listByType` queries it - one Query per page, never a Scan - and
`conversationsForContact` is the existing contact-side thread reader. Both ship
today.

**Cost becomes proportional to ROWS RETURNED rather than to partition size.** A
queue of ~10 costs ~10 thread reads instead of ~693 contact lookups. The failure
mode inverts back to something sane: expensive only when there is a real
backlog, which is visible, bounded by operator behaviour, and precisely the case
where an operator wants the rows.

What it needs, and none of it is a new invariant:

- No denormalization, no backfill, no new index, no new attribute.
- The demotion hole - a contact returned to `unknown` whose thread stays typed
  `tenant_1to1` - is fixed FOR FREE, because the read consults the authoritative
  field instead of a copy.
- `conv.type` stays exactly as stale as it is now, harmlessly, and nothing new
  starts trusting it.

### 3.1 Three things that must be settled first

**(a) Ordering.** The tab is ordered by `last_activity_at`, which lives on the
conversation; the contacts partition ranges on `status`. So the read is: query
the queue, resolve each contact's thread, sort by activity. That is fine at the
measured size and needs a stated bound and cursor story before the queue can be
large. **Design the bound now.** This document exists because an unbounded read
shipped once already.

**(b) Contactless rows - the one real coverage gap.** The pager today emits an
untriaged row for a conversation with a phone and NO contact at all (the
`!contact` branch, `needsTriage: true`). Those rows have no contact, so a
contact-side query cannot find them. **Measure this class before committing:**
`--audit-unknown-page` now reports it as
`matching rows found (contactless: N)`. If N is zero the gap is theoretical; if
it is not, the design needs a second source and the shape changes.

**(c) Type versus status.** The current filter keys on contact TYPE only
(`roleFromContact(contact) === 'unknown'`), while the triage partition is
`(unknown, needs_review)`. A contact typed `unknown` with some other status is
shown by the tab today and would NOT be returned by the partition query. Either
query the type across statuses, or accept a deliberate narrowing and say so.
Do not let this be settled by whichever query is easier to write.

## 4. Options not taken

- **Make `conv.type` trustworthy and pre-filter on it** (draft 1) - withdrawn,
  section 2.
- **A sparse `needs_triage` flag with its own GSI** - a new attribute and a new
  index to reproduce a partition the contacts table already has. `byUnread` and
  `byRelayOptOut` are in-repo precedents for the shape, so it is buildable; it
  is simply unnecessary while section 3 works.
- **Batch the contact reads** - turns ~693 serial Queries into ~7 BatchGets, but
  optimises hydrating rows that are then discarded. Strictly worse than not
  reading them.
- **Budget + cursor + `truncated` on the existing pager** - bounds the damage
  with no schema change. **Keep this as a SAFETY NET regardless of section 3**:
  an unbounded read should not exist even when it is cheap. It carries its own
  gate - review found it would light the unfiltered inbox failure banner on an
  empty page, which must be solved first.

## 5. What still has to be swept

Section 3 removes the invariant burden, so the fan-out holes stop being
load-bearing for THIS read - but they remain real defects feeding two other
issues, and the sweep is still owed there:

- Every writer of `contact.type`, including `apply.ts:967`'s unconditional write
  and the no-fan-out creators at `public.ts:257` and `unmatchedEmail.ts:462`.
- The phone DELETE / primary-PATCH routes, which create the miss shape.
- `setType`'s zero callers - dead code to remove or wire.

Do not treat that list as complete. Draft 1's equivalent was wrong in both
directions, and the C1 spec's was wrong three times in three drafts.

## 6. Testing

- **The regression test must STARVE the filter.** A fixture that fills a page
  measures the cheap path. `inboxFeed.test.ts` already has the read-counting
  harness this needs, so it is buildable rather than aspirational.
- Assert on the number of reads for a given queue size, never wall-clock.
- Mutation-probe every check: reintroduce the defect and watch it fail. A guard
  with no failing mode is not covered.
- Pin the contactless-row behaviour explicitly once 3.1(b) is measured - it is
  the one class that changes hands between the two designs.
- Five gates bare from the worktree: typecheck, test, smoke, e2e, and `npx
  eslint` on the branch's own touched files.

## 7. Open for the human

1. **3.1(c)** - narrowing the tab to `needs_review` is a product decision, not a
   query-shape convenience.
2. The Today name defect is filed separately and does not block this. It wants
   its own read-versus-write decision, and the same discipline applies: decide
   what SHOULD read the field before deciding who keeps it in sync.

## 8. Out of scope

- The C1 generator-contract slice - independent, can proceed in parallel.
- The group-roster name
  ([`group-roster-name-snapshot-never-refreshed`](../../issues/group-roster-name-snapshot-never-refreshed.md)),
  which reaches outbound content and is its own `high`.
- Retyping stale `conv.type` rows at all. Section 3 removes the reason to.
