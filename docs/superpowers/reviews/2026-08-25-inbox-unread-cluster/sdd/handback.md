# Handback - Unknown inbox tab, cursor-paged contact-side read

**Branch `feat/inbox-unread-cluster` @`30e1b9f5` (`W:\tmp\inbox-unread-cluster`),
UNMERGED, human gate. NO infra, NO post-merge ops owed.**

All five gates green on this commit. Two full adversarial review rounds ran on
the rework, and the second returned **nothing blocking** - the first time in this
mission that a review round has not overturned a completion claim. That is the
reason I am willing to write this handback now and was not before.

## Gates on `30e1b9f5`

| gate | result |
| --- | --- |
| `npm run typecheck` | EXIT 0 |
| `npm test` | red once, ENVIRONMENTAL - see below. Clean-key full app run EXIT 0, `340 passed \| 1 skipped (341)` |
| `npm run smoke` | EXIT 0 |
| `npm run e2e` | EXIT 0, 255 tests, `not ok` count 0 |
| `npx eslint <branch files>` | 1 error, PRE-EXISTING (`convBId`, identical in main) |

The `npm test` red was `messaging.integration.test.ts` - a file this branch never
touches - failing on a plain 60s TIMEOUT with `ProvisionedThroughputExceeded`
noise from other suites. It passes ALONE in **3.83 seconds**, a 16x margin, and
the prescribed clean-key full run was green. Same environmental class documented
in `npm-test-dynamodb-local-contention`.

## What this branch now does

Reads the `(type='unknown')` contact partition instead of walking every open
conversation (~684 contact lookups across 24 Queries for at most 8 rows in prod).
It is **cursor-paged and unbounded**: one bounded Query per status BLOCK,
untriaged first, paged with the index's own cursor. No cap, no window, no
`truncated` flag.

## The three rulings that reshaped it, and why

The first build passed all five gates and a clean spec-conformance review. A
plan-blind adversarial round then returned NOT MERGE-READY with 3 HIGH - and none
were build defects. They were consequences of decisions the APPROVED SPEC
authorised. Your rulings:

1. **No fixed windows.** The cap was deleted, not resized. It turned out the cap
   was the PRICE OF THE SORT: `ContactItem` carries no activity attribute, so
   newest-first ordering forces reading everything before rendering anything.
2. **Untriaged-first over newest-first.** Which is what made (1) possible.
3. **Resurfacing needs the CONVERSATION, not the deleted CONTACT back in the
   queue.** Verified end to end before acting on it. The whole byUnread sweep was
   deleted - up to 2000 index items plus one contact read per visible item, and
   re-paid on every debounced refetch, which my original cost model missed
   entirely.

Spec left as the August historical record; rulings recorded in the issue registry
per your instruction.

## Two defects that were MINE, both caught by review

- I asserted in a build brief that the dashboard would render Load more beside an
  empty page. It nests the control inside `rows.length > 0`, so the
  budget-stopped empty page was a **dead end** - the exact unreachability the
  rework existed to remove.
- I ruled "stop the page at a failed row and retry next request" and called the
  consequence a short page. At a page HEAD it renders zero rows forever, and the
  codebase already THROWS to outlaw that shape one file over. Now bounded: one
  retry, then step over and log at ERROR.

## Filed, accepted, NOT fixed

- `unknown-queue-status-flip-duplicates-across-pages` - a mid-walk status flip can
  duplicate (visible) or skip (invisible) a row across pages. Needs >30 rows plus
  a write in the operator's Load-more gap. Closing it needs a cross-page seen-set,
  i.e. the unbounded cursor this feed exists to escape.
- `contacts-create-does-not-require-status` - the byTypeStatus invariant is
  enforced on `update` only. Latent; all live call sites set it.
- `broadcast-audience-truncation-drops-searching-tenants` - the same unstated sort
  in `audienceResolution.ts`, dropping `searching` tenants first. **Worse
  consequences than the triage tab.**
- `denormalize-contact-last-activity-for-ordered-paging` - the follow-up you
  approved. **Its value proposition was corrected in review**: it buys ORDERING,
  not correctness. It swaps a mutable range key for a MORE frequently mutable
  one, so duplicates vanish but the invisible SKIP half gets more frequent.
- `logcallsiteguard-hook-budget-equals-its-own-cost` - a test whose hook budget
  is smaller than its own solo cost.

## The one decision still open

Both reviewers established that the rendered order today is **neither** option we
discussed. `useInbox.ts:534` re-sorts the ACCUMULATED list newest-first with no
filter gate, so what an operator sees is "newest of whatever happens to have been
fetched". The server's block order governs FETCH order only.

`unknown` is also the FIRST filter where that client sort actually REORDERS the
accumulation, so Load more makes the existing list reflow under the operator.
One of the two sorts is dead weight either way.

Three options: leave it (fetch priority is what matters, display stays recency);
drop the client sort for this filter (what you see is the queue); or drop the
server's per-page sort instead. I have not chosen - it is a product call and the
code is honest about it either way.
