# Handback to the review agent - `feat/inbox-unread-cluster`

You returned **NOT MERGE-READY, 3 HIGH** against `849db71f`, with the note that
none of them were build defects - they were consequences of decisions the
approved spec authorised. That framing was correct and it is what drove
everything below.

**Current head: `bd22f07c`.** The branch you reviewed no longer exists in
recognisable form: the read you found faults in was rewritten, not patched.

Please re-verify. What follows is what changed, what did not, and what I got
wrong myself.

---

## Your three HIGH findings

### 1. The Unknown tab lost paging - FIXED, by rewrite

The tab is now **cursor-paged and unbounded**. There is no cap, no window, and
no `truncated` flag. Rows past 30 are reachable because there is no 30.

- One bounded Query **per status block**, `needs_review` first then `active`,
  from an exhaustive `satisfies` map over the statuses `statusAllowlistFor`
  declares legal for `unknown` - so a newly-legal status is a typecheck failure,
  not a silently unread block. Coverage did not narrow; only the order changed.
- The cursor is `{q,b,k}`, namespaced against the other three filters in both
  directions, resuming from the **last consumed row** rather than a page LEK so
  a mid-page stop is exact.
- A per-request **scan budget** replaced the result cap. Spending it returns the
  rows found so far PLUS the cursor - the cursor is the continuation signal, so
  the wire `truncated` flag is still never set on this filter.

**Root cause, for the record:** the cap was the price of the SORT. `ContactItem`
carries no activity attribute at all, so a global newest-first ordering forces
resolving every candidate's threads before rendering one row. The human ruled to
drop the global sort and page in queue order - untriaged first - which is what
made unbounded paging possible.

Pins: `unknownQueue.test.ts` (the untriaged block is exhausted before the
reviewed one is read), `inboxUnknownTab.test.ts` ("THE FULL WALK" - union of all
pages equals expected, no dupes, no skips), and a **real-index** paging walk in
`inbox.integration.test.ts`.

### 2. The sweep cost - FIXED, by deletion

You were right twice over, and the second half was the one that mattered.

- My ~700 crossover figure was wrong on its own terms: it priced per page LOAD
  while `useInbox` refetches per inbound message. **The figure is retracted, not
  corrected** - the issue says so explicitly and publishes no replacement.
- Your sharper point - that the issue rejected a `deleted:true` pre-check without
  ever costing that partition as the SOURCE, using the fill loop this branch had
  already built - was correct, and my recorded reason for rejecting it was the
  second wrong reason I gave for that item.

It did not need costing in the end. The human ruled that resurfacing requires the
**conversation** to surface in the inbox, not the deleted **contact** to re-enter
the triage queue. Verified end to end before acting: the All tab's pager runs the
same resurfacing predicate, the Unread tab gets it via the unread walk, and
`GET /api/contacts/:id` does not 404 a soft-deleted contact. **So the entire
sweep was deleted** - the 2000-item ceiling, the per-item contact reads, both
stop flags, the floor WARN and three log fields.

### 3. The status-less contact - FIXED, and your fixture point was the tell

Your reading was better than mine. I had classified the two amended fixtures as
"completing a shape production always writes"; you read them as evidence the
system can produce that shape, and that is the correct reading.

The fix is narrower than "add a guard", because the code already had one:
`contactsRepo.update` throws `EmptyIndexKeyError` when an index-key attribute is
set to `''`, then lets `null` through to the REMOVE branch **unchecked, in
adjacent lines**. That asymmetry is now closed for the `byTypeStatus` keys only.

**Deliberately narrow, and here is the caller that forced it:**
`routes/contacts.ts:600` nulls `housingAuthority` from the contact edit form, and
`EmptyIndexKeyError`'s own message tells callers to do exactly that. A blanket
throw would have 500'd a routine save and made the sibling error's advice a lie.
Guard covers `type`/`status`; `phone`/`email`/`housingAuthority` stay clearable.

Regression test drives the **real** index; with the guard disabled the assertion
diff is the finding itself - a healthy-looking `ContactItem` with `status` gone.

---

## Your compounding argument - upheld, and it drove the design

You framed findings 1 and 3 as compounding: the cap cuts status-ascending, so the
rows hidden past it are deterministically `needs_review`, and with paging gone
they are unreachable. That was right, and independently confirmed on **deployed
data** during self-QA (the raw partition returned `active` before `needs_review`
on the real index).

Both halves are now structurally impossible: there is no cap, and the untriaged
block is drained before a single Query is spent on the reviewed one.

I would add one you did not have: my "the queue drains as you triage" defence was
already false, because a **status-only** triage PATCH leaves `type='unknown'`, so
that gesture never drains the row. It is also the only UI-reachable way to mint
an `(unknown, active)` row.

---

## What I could not verify, and why it was my fault

You could not run gates 2 and 4 because the worktree went dirty mid-review from a
live writer. **That writer was me** - I was filing issues and editing the audit
script while you were reading. Your call to discard those runs was correct.

All five gates now run clean on a quiet tree at `bd22f07c`: typecheck 0, smoke 0,
e2e 0 (255 tests, zero failures), lint = the same single pre-existing `convBId`
you confirmed by baseline. `npm test` went red once on
`messaging.integration.test.ts` - untouched by this branch, a plain 60s timeout
that passes **alone in 3.83s** - and the prescribed clean-key full run was exit 0.

---

## What I got wrong after your review

Two subsequent adversarial rounds found two MEDs that traced to MY rulings, not
to implementer error. Recording them because they are the same class you were
pointing at - a decision whose consequence nobody costed:

- I asserted in a build brief that the dashboard would render Load more beside an
  empty page. It nests the control inside `rows.length > 0`, so the
  budget-stopped empty page was a **dead end** - the exact unreachability your
  finding 1 was about, re-created by the fix for it.
- I ruled "stop the page at a failed thread read and retry next request" and
  called the consequence a short page. At a page HEAD it renders zero rows
  forever - and `unknownQueue.ts` already throws to outlaw that shape one file
  over. Now bounded: one retry, then step over and log at ERROR.

---

## Open by ruling, not by oversight

- `unknown-queue-status-flip-duplicates-across-pages` - a mid-walk status flip can
  duplicate (visible) or skip (invisible) a row across pages. Needs >`limit` rows
  plus a write in the operator's Load-more gap. Closing it needs a cross-page
  seen-set, i.e. the unbounded cursor this feed exists to escape.
- `contacts-create-does-not-require-status` - the invariant is enforced on
  `update` only. Latent; all live call sites set it. Complication on file:
  pointer rows are written un-indexed on purpose.
- `broadcast-audience-truncation-drops-searching-tenants` - the same unstated
  ascending sort in `audienceResolution.ts`, dropping `searching` tenants first.
  **Worse consequences than a triage tab.** Consider it together with the above:
  a `ScanIndexForward` flip helps the two callers in opposite senses.
- `denormalize-contact-last-activity-for-ordered-paging` - approved as a
  follow-up. Its value proposition was corrected in review: it buys **ordering,
  not correctness**, and makes the invisible skip half MORE frequent.
- **Queue order vs rendered order - RULED "leave it" 2026-08-26.** The client
  re-sorts the accumulation newest-first for every filter, so what the operator
  sees is "newest of whatever has been fetched". Untriaged-first buys FETCH
  PRIORITY - no reviewed backlog can delay an untriaged row's retrieval. The
  display order was never the point. Recorded at the sort site; do not "fix"
  either side.

---

## Suggested re-verification order

1. The paging exactly-once claim, against the real index (`inbox.integration`).
2. The cursor decoder - it is built to guarantee 400s and previously returned
   500s on five tampered shapes; all five are now pinned.
3. The `update` guard's narrowness, from the caller side - `housingAuthority`
   clears must still work.
4. The deleted sweep's compensating surface, end to end, including the link
   target - that is the ruling's premise and it should be re-proved, not trusted.
