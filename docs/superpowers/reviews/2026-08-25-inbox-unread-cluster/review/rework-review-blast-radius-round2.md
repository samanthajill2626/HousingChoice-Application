# Adversarial re-review (round 2) - BLAST RADIUS

Branch: `feat/inbox-unread-cluster`. Fix wave: `30ba7eef` (issues `bbc553db`).
Diff reviewed cold: `git diff 1ceb2e52..30ba7eef`.
Worktree: `W:\tmp\inbox-unread-cluster`.
Posture: READ-ONLY. No file changed, no commit, no server started, no
`npm test` / `npm run e2e`. Probes were pure-logic, in the session scratchpad.

Every fix landed and every one is enforced by something. The new findings are
all about where the M1 fix REACHES - a second filter, a second render state, and
a server-side workaround that existed only because the client was broken.

---

## PART 1 - NEW FINDINGS

### N1. MED - `emptyMoreCopy()` fires on `filter=unread` after the ordinary triage gesture, and its wording is false there

**Where:** `dashboard/src/routes/inbox/Inbox.tsx:33` (copy selection) against
`:203` (the empty block's gate), with `dashboard/src/routes/inbox/useInbox.ts:533`
(the Unread narrowing) and `dashboard/src/routes/inbox/inboxFilters.ts:36-39`
(the new copy).

**What is wrong.** The two halves of the empty state are now gated on different
quantities:

```
:33   const empty = inbox.hasMore ? emptyMoreCopy() : emptyCopy(filter);   // SERVER statement
:203  inbox.status === 'ready' && inbox.rows.length === 0 && !serverEndedEarlyEmpty  // CLIENT list
```

`hasMore` is a statement about the SERVER page. `rows` is the client-filtered
list, and on `filter=unread` `useInbox.ts:533` empties it as the operator marks
rows read - by design, so the list and the "all caught up" state stay in sync
with the action. Pairing the two lets a CLIENT-caused emptiness select a
SERVER-flavoured sentence.

This is the exact drift class this file has already fixed twice and documented
at length - `useInbox.ts:41-57` (adversarial 30) and `Inbox.tsx:52-57`,
`:178-182` (adversarial 4). The doctrine it wrote down is one line: a claim
about the SERVER page is gated on `serverRowCount`, never on `rows`. The new
copy switch breaks it under a new name.

**Failure scenario (the most common gesture on the tab).** Unread tab, 100
unread threads. Page 1 returns 30 rows with a cursor - minted because the page
FILLED - and `truncated: false`. The operator marks all 30 read, which is what
the tab is for. State: `rows: []`, `hasMore: true`, `truncated: false`,
`serverRowCount: 30`.

- Before the fix wave: `"You're all caught up"`, no Load more.
- After: **"Nothing on this page yet / This search stopped early to stay fast.
  Load more to keep looking."**

The search did not stop early. It filled normally, and the list is empty because
the operator emptied it. The Load more appearing here is an IMPROVEMENT (there
really are 70 more unread behind); the sentence is a REGRESSION, and it is a
specific false claim about the server on a tab whose own comment says "not
lying is the point" (`Inbox.tsx:174`).

**Evidence.** Probe replicating `Inbox.tsx:33/:46/:203/:210/:242` and
`useInbox.ts:533` verbatim:

```
UNREAD after marking the whole page read:
  { copy: 'Nothing on this page yet', emptyBlock: true, rowsBlock: false, loadMore: true, banner: false }
  same state BEFORE the fix wave would have said: You're all caught up | Load more: false
```

**Direction.** Gate the copy switch on a SERVER quantity, matching the file's own
doctrine: `serverRowCount === 0 && hasMore` selects `emptyMoreCopy()`. That
leaves a third state uncovered on purpose - client-emptied WITH more behind -
and neither existing string is right for it ("all caught up" is false because
more is behind; "stopped early" is false because it did not). Give it its own
line, e.g. "Page cleared - more unread behind", and keep the Load more.

---

### N2. LOW - the adversarial-4 pin now goes green while proving only the weaker half

**Where:** `dashboard/src/routes/inbox/Inbox.test.tsx:136-143`, with
`baseState`'s `hasMore: false` at `:22`.

**What is wrong.** That test is named *"a truncated page whose rows were all
marked read is caught up, NOT an error"* and its comment is the adversarial-4
record. It asserts `/all caught up/`. It passes only because `baseState` leaves
`hasMore` false; the realistic version of the state it models carries a cursor,
and that version now takes the `emptyMoreCopy()` branch and no longer says "all
caught up" at all.

So the single test that exists to defend the copy in exactly this scenario
cannot see N1. It is green for a weaker reason than its name claims - which is
worse than red, because the next reader will trust it.

**Direction.** Add the `hasMore: true` variant to that test (or as its sibling)
once N1 is decided, so the pin covers the state the operator actually reaches.

---

### N3. MED - the fix wave removed the client limitation but not the server-side workaround built for it, and the workaround's recorded reason is now false

**Where:** `app/src/routes/inbox.ts:1629` (`if (unreadRows.length === 0)
unreadCursor = null;`) and its justification at `:1624-1628`.

**What is wrong.** The comment reads:

> "An empty truncated page keeps its error-state posture rather than offering a
> Load more the client has nothing to hang off."

The client now HAS something to hang it off - that is precisely what M1 changed
(`Inbox.tsx:242`, Load more on `status === 'ready' && hasMore` alone). Two
consequences, and they pull in opposite directions, which is why this needs a
decision rather than a tidy-up:

1. **The stated reason is now false**, in a codebase whose comments are the
   design record. Anyone acting on the reason as written would delete the line.
2. **The line is nevertheless the only thing making the implementer's own flagged
   worry unreachable.** The fix commentary at `Inbox.tsx:229-233` says Load more
   "can now render ... on `filter=unread`, alongside the early-end failure
   banner". It cannot - I checked. The banner needs
   `serverRowCount === 0 && truncated`, and `:1629` guarantees that a zero-row
   unread page carries `nextCursor: null`, so `hasMore` is false there. The
   probe confirms the shape would render banner + Load more together **if** the
   server could produce it:

   ```
   UNREAD empty + truncated + cursor: { emptyBlock: false, rowsBlock: false, loadMore: true, banner: true }
   ```

   That state is currently server-unreachable, and `:1629` is the single line
   holding it that way. Delete the line on the strength of its own obsolete
   comment and the pairing becomes reachable the same day.
3. **Meanwhile `unread` still carries the dead-end class M1 removed from
   `unknown`.** The budget exit at `:1595-1604` deliberately mints a cursor and
   explains why discarding one is wrong - "Returning null discarded a
   scanPosition the request had already paid for, so the only forward affordance
   left was Retry - which re-runs the identical prefix with a fresh budget and
   truncates identically" (`:1600-1603`). `:1629` then discards it anyway
   whenever no rows survived, landing in exactly the failure mode `:1600` names.
   Before the fix wave that was forced. Now it is a choice nobody re-made.

**Direction.** Decide `:1629` explicitly rather than leave it inherited. If the
error-state posture is still wanted for `unread`, rewrite the comment to say so
on its own merits AND record that this line is what keeps banner+Load-more
unreachable, so it is not removed by accident. If the position should be kept,
`unread` gets the same continuation `unknown` now has, and the banner pairing
needs a deliberate answer.

---

### N4. LOW - a route test whose name is now false, passing for a different reason than it states

**Where:** `app/test/inboxApi.test.ts:270-275`.

**What is wrong.** The test is named
`'400 on filter=unknown with any cursor (the unknown feed mints none)'`. Both
claims died at `1ceb2e52`: the unknown feed's entire purpose is now to mint
cursors, and a valid `{q,b,k}` cursor returns 200 (proved by the real-index
paged walk at `app/test/inbox.integration.test.ts:502-531`). The body sends
`{idx: 0}`, which 400s as a FOREIGN cursor - a correct assertion under a name
that misdescribes it.

It survived both the rework and the fix wave. Anyone grepping the suite for
"does `filter=unknown` accept a cursor?" finds a passing test saying no.

**Direction.** Rename to what it asserts - a foreign/untagged cursor is a 400 -
and drop the parenthetical.

---

### N5. LOW - `retryFrom` does not advance across a zero-row read, so a persistent thread-read failure re-pays the residue walk on every Load more

**Where:** `app/src/routes/inbox.ts:1762-1775` (`retryFrom`), the outer
fill-or-exhaust loop's `position = read.next` (around `:1930-1940`), and the
thread-read stop at `:1856-1875`.

**What is wrong.** `retryFrom` advances only inside the per-row loop. When
`readUnknownQueue` returns `rows: []` - an entire fetch eaten by the
soft-delete FilterExpression, which is the documented normal case for this
partition - `position` advances but `retryFrom` does not. If a later row's
thread read then throws, `boundary = retryFrom` names the request's START, so
the next request re-scans all the residue it already paid for.

**Not a correctness bug**, and I checked why: nothing between the stale
`retryFrom` and the failed row was ever EMITTED (a zero-row read means zero
`page.items`, so no contact was consumed), so re-reading that span produces no
duplicate and loses nothing. The cost is that a persistently-failing row makes
every Load more click re-walk up to the whole scan budget with no progress -
which degrades M3's intended "VISIBLE-stuck" into "visibly stuck AND expensive".

**Direction.** When `read.rows.length === 0`, advance `retryFrom = read.next`
alongside `position`. Safe by the argument above; worth stating in the comment
so the safety is not re-derived.

---

### N6. LOW - the performance harness has no terminal alternative for the new copy

**Where:** `e2e/performance/routes.ts:399-406` (`inboxTerminal`), consumed by
`e2e/performance/cli.ts:483-505` (`terminalStateFor`).

**What is wrong.** `inboxTerminal(emptyTitle)` builds `terminal(populated,
empty, error, structure)` with the default `'any'` combine, so each inbox
surface gets exactly ONE populated alternative (the `Conversations` list) and
ONE empty alternative (its per-filter title). The new
`"Nothing on this page yet"` state matches neither: no list, and the pinned
title is absent. `terminalStateFor` then returns `'unknown'`
(`cli.ts:501-505`), readiness never resolves (`readiness.ts:101-110`), and the
sample fails as `ready_timeout` / `unresolved_terminal` - a failure that names
the readiness gate, not the copy that caused it.

**Reachability today: none.** The perf seed mints `contacts / 100` unknown
contacts (`app/src/lib/seed/performance.ts:195-198`) against a 1000-row scan
budget, so the budget exit cannot fire, and the harness never marks rows read so
it cannot reach N1's state either. This is latent - but it is exactly the
"fails in ways that look unrelated" class the charge names, and the harness has
`terminalAlternatives` already built for precisely this (`routes.ts:207`).

**Direction.** Give the four inbox surfaces a second empty alternative carrying
the `emptyMoreCopy()` title.

---

## PART 2 - THE M1 FIX ACROSS ALL FOUR FILTERS

The new Load more gate is `status === 'ready' && hasMore` (`Inbox.tsx:242`), and
the new copy switch is `hasMore ? emptyMoreCopy() : emptyCopy(filter)`
(`:33`). The only genuinely NEW render state is **empty block + Load more**
(previously impossible, since Load more required `rows.length > 0`). I walked
each filter for whether it can reach it, from both the server and the client
side.

| filter | `rows: [] && hasMore` reachable? | how | verdict |
|---|---|---|---|
| `unknown` | YES, server-side, by design | scan-budget exit; and NEW - the M3 thread-read-failure exit | **IMPROVEMENT** - this is M1's whole point |
| `unread` | YES, client-side only | operator marks every row on a cursored page read (`useInbox.ts:533`) | **MIXED** - the button is an improvement, the copy is a **REGRESSION** (N1) |
| `all` | NO | `inbox.ts:1991-2019`: `nextCursor` is set only in the page-FULL branch and nulled when the stream exhausts, so empty implies no cursor; the client applies no narrowing for `all` | **NEUTRAL** |
| `groups` | NO | `conversationsRepo.ts:2358-2407`: the Query is key-condition-only with no FilterExpression, so zero items implies the partition ended and no cursor is minted; `groupRowsFor` is a 1:1 `map` with no drops | **NEUTRAL** |

**The implementer's own flagged concern - Load more under the `unread` failure
banner - is UNREACHABLE**, and not for the reason they gave. It needs
`serverRowCount === 0 && truncated && hasMore`; `inbox.ts:1629` guarantees a
zero-row unread page carries a null cursor. See N3: that guard is load-bearing
for this and its comment no longer says so.

**Can `emptyMoreCopy()` appear where its wording is simply wrong?** Yes, on
`unread` - N1. On `unknown` it is accurate for the budget exit. For M3's new
thread-read-failure exit it is a **half-truth worth noting**: "This search
stopped early to stay fast" describes a performance bound, but that exit is a
read FAILURE. The state is otherwise identical and the operator's correct move
is the same (click Load more), so I am not filing it separately - but if N1 is
fixed by giving states their own copy, this one deserves a mention in the
`emptyMoreCopy` docblock, which currently names only the budget exit.

---

## PART 3 - CONTESTED ADJUDICATIONS

### M2 / my finding 1 (client re-sort): the RULING is right, the ESCALATION is incomplete

I do not contest comment-only-plus-escalate. Whether the operator should see
queue order or recency is a product call, and the corrected comment
(`inbox.ts:2001-2023`) is accurate - it now says fetch order and names
`useInbox.ts`'s `sortByActivity` explicitly.

What I contest is the escalation's FRAMING. It is put to the human as a binary
("should the client stop re-sorting for this filter"), and that omits the fact
that the status quo is neither option. Three things the human needs and does not
have:

1. **The rendered order is recency over an ARBITRARY queue-order prefix** - "the
   newest of whatever happened to be fetched" - which is not the queue ordering
   and not a global recency ordering either. Neither side of the binary
   describes what ships today.
2. **`unknown` is the first filter where the client sort actually REORDERS, so
   Load more makes the list reflow.** On `all` and `unread` the server serves
   newest-first globally, so appending a page always appends older rows and
   `sortByActivity` is a no-op. On `unknown` it is not: page 2's `active` rows
   can sort ABOVE page 1's `needs_review` rows, so clicking Load more INSERTS
   rows above the one the operator was reading. That is a concrete usability
   consequence, distinct from the ordering question, and it is not in the
   escalation.
3. **The server's per-page sort (`inbox.ts:2024-2026`) is dead weight for the
   only consumer.** The client re-sorts the same rows immediately. Whichever way
   the product call goes, one of the two sorts should go.

**Direction:** add those three to the escalation before the human decides.
No code change is being argued for.

### B6 / my finding 6 (`create()` does not require `status`): FILED is correct

I agree with the ruling. I re-read the filed issue
(`docs/issues/contacts-create-does-not-require-status.md`) - it states the
mechanism, the eight safe call sites, and the existing Scan-based detector
accurately, and its `severity: low` matches the latency of the hole. Nothing to
contest.

### A1 / the cross-page status flip: FILED is correct

`docs/issues/unknown-queue-status-flip-duplicates-across-pages.md` records the
asymmetry (common triage -> visible duplicate; rare un-triage -> invisible skip),
the real threshold (`limit`, not `UNKNOWN_QUEUE_PAGE_SIZE`) and the real window
(the operator's Load-more gap). Closing it needs an unbounded cursor, which is
the boundedness this feed exists to escape. Correct call.

---

## PART 4 - VERDICT PER FIX: REAL, OR MERELY PLAUSIBLE?

| fix | verdict | what ENFORCES it |
|---|---|---|
| **M1** Load more on `hasMore` alone + `emptyMoreCopy()` | **REAL, incomplete** - the `unknown` dead end is gone; it reaches `unread` with a wrong sentence (N1) | 3 new pins, `Inbox.test.tsx:408-428`: renders Load more on an empty cursored page, swaps the copy, and keeps the real copy once the walk ends |
| **M2** comment correction on fetch-vs-rendered order | **REAL** - `inbox.ts:2001-2023` now states it correctly and names the client file | Nothing can enforce a comment; inherent, not a gap |
| **M3** thread-read failure stops the page AT the row | **REAL** - `boundary = retryFrom` re-reads the failed row; I traced the invariant (`retryFrom` = `after` of the last fully-processed row) and found no duplicate and no loss | 2 new pins, `inboxUnknownTab.test.ts`: "a THROWN thread read STOPS the page AT that row" and "a TRANSIENT thread-read failure costs a SHORT PAGE, not a lost row: the retry serves it". Residual cost in N5 |
| **M4** full `k` validation + block/key agreement | **REAL** - all five measured tamper shapes are now 400 | Two ways: the strict shape check itself, AND the real-index paged walk through the HTTP route (`inbox.integration.test.ts:502-531`), which would go red if the hand-listed `'contactId,status,type'` ever diverged from what DynamoDB mints. It currently cannot: `tables.ts:78-79` gives contacts a hash-only primary key, so a byTypeStatus LEK is exactly those three |
| **M5** duplicate/skip comment corrected + filed | **REAL** - threshold and window both restated correctly at `inbox.ts:1836-1866` | The filed issue carries the reproduction |
| **M6** `want`/`budget` seam guards | **REAL, and it cannot fire in production** - I traced the only caller: the fill-or-exhaust loop breaks on `remainingBudget === 0` BEFORE re-entering, and breaks on `filled` before `want` can reach 0. `profile-inbox.ts`'s cases carry a REQUIRED `limit: number` (`inboxDiagnostics.ts:39`, all four cases pass 30), so the exported-caller path is safe too | `unknownQueue.test.ts`: "refuses a degenerate `want` or `budget` LOUDLY" |
| **M7** fake tie-break restated as the fake's own convention | **REAL** - now carries the measured `c1..c4 -> c2, c4, c1, c3` counter-example and points at the integration test that sorts before comparing | The measurement is in the comment; the integration walk is the behavioural backstop |
| **M8** rule-6 rationale + the `contactId`-only fallback | **REAL** - rationale rewritten to what the sort model buys NOW (block order is expressible); the fallback THROWS instead of silently restarting | `contactsPartitionFake.test.ts` additions. I re-swept all six consumers: none passes a key lacking `status`, so the new throw breaks nothing |

---

## WHAT I RE-SWEPT

- **All four filters through the new render matrix**, server-side and
  client-side, for the empty+Load-more state, the banner+Load-more state and the
  notice+Load-more state. Reachability traced to source in every cell:
  `inbox.ts:1991-2019` (`all`), `conversationsRepo.ts:2358-2407` (`groups`),
  `inbox.ts:1566-1629` (`unread`, all five exits), `inbox.ts:1789-1946`
  (`unknown`). Results in Part 2.
- **Copy-string pins.** `grep` for every affected string across `dashboard/`,
  `e2e/` and `app/`: `Inbox.test.tsx` (7 sites), `useInbox.test.tsx` (2 sites),
  `e2e/tests/dashboard-next/unknown-caller-triage.spec.ts:127,153`. None breaks
  - the e2e asserts `'No unknown numbers'` on a lean seed with ZERO unknowns
  (`hasMore` false, so `emptyCopy`), and the `all caught up` pins all carry
  `hasMore: false`. One of them is green for the weaker reason (N2); the perf
  harness has no pin for the new string at all (N6).
- **Performance harness.** `collect.ts:150-192`'s exact two-key `{filter,limit}`
  tuple is untouched by a render change; `routes.ts:583`'s `inbox-unknown`
  terminal and `cli.ts:483-505`'s state machine re-checked against the new copy
  (N6); the perf seed's unknown count re-derived (`performance.ts:195-198`) to
  establish the state is unreachable there today.
- **The tightened cursor decoder's own minting path.** Verified that everything
  the server mints still decodes: `after.key` is `{type,status,contactId}` by
  construction (`unknownQueue.ts:307-311`) and `read.next.key` is a raw
  byTypeStatus LEK, which on a hash-only table is the same three attributes
  (`tables.ts:78-79`). The block/key agreement check holds because the Query is
  narrowed on `(type,status)`, so a returned item cannot carry others. Covered
  end to end by the real-index walk.
- **The two new throws for consumer impact.** `readUnknownQueue`'s `want`/
  `budget` guards: sole production caller traced, plus `aggregateInbox`'s only
  other caller (`scripts/profile-inbox.ts:117`) and its case definitions. The
  fake's new key throw: all six consumers of `listByTypeFromContacts`
  re-checked; every one passes either no key or a fake-minted three-attribute
  one.
- **`retryFrom`'s exactly-once invariant** across all five paths that touch it
  (retyped, `emitted`, no-open-thread, page-filled, normal advance) plus the
  zero-row-read gap (N5) and the first-row-of-first-request case (mints
  `{block: 0}`, resolves to page one, no false "queue exhausted" - correct).
- **The two filed issues** (`bbc553db`) read for accuracy against the code they
  describe. Both accurate.

## VERDICT

The fix wave is real work, not paper: every one of M1-M8 landed with something
enforcing it, and M3's boundary and M4's validation are the two I tried hardest
to break and could not.

It is not finished. The M1 fix reaches `filter=unread`, where it hangs a correct
button under a false sentence and re-opens a drift the file has already fixed
twice (N1), guarded by a pin that cannot see it (N2). And it removed the client
limitation that a server-side workaround was built around without revisiting the
workaround, leaving a false design-record comment on a line that is now
load-bearing for a state the implementer believed was already reachable (N3).

Nothing found is BLOCKING. N1 and N3 want a decision before merge; N2, N4, N5
and N6 are cheap follow-ups.
