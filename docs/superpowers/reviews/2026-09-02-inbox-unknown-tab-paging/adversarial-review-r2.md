# Adversarial review R2 - feat/inbox-unknown-tab-paging

Scope: the UNCOMMITTED fix wave in the working tree on top of `5de0bc90`
(`git diff HEAD` - five files), reviewed cold, plus a fresh sweep of the whole
changed state. Adjudications read at
`adversarial-review-r1-adjudications.md`. Read-only: nothing was edited,
staged or committed, no suite was run, no server was started. All line numbers
are as the working tree stands now.

Five new findings, none BLOCKING or HIGH. Both contested adjudications are
CONCEDED, with one sentence of the coordinator's reasoning contested in turn.

---

## 1. [MEDIUM] The unknown cursor's DEFINITION comment still says `{q:1, b, k}` - `d` is absent from the paragraph that introduces the wire shape, and three sibling decoders plus a test still label it `{q,b,k}`

**What is wrong.** The branch commit added a fourth wire field and updated
exactly ONE of the six places that state the namespace. The one it updated is a
usage-site aside (`app/src/routes/inbox.ts:1760`, "This filter's OWN cursor
namespace (`{q,b,k,d}`)"). The place a reader actually goes to learn the shape -
the section header that opens the unknown-cursor block - still enumerates three
fields and then stops:

- `app/src/routes/inbox.ts:326` - "A THIRD cursor namespace: `{q:1, b, k}` where
  `b` is the index into UNKNOWN_QUEUE_BLOCKS the walk is inside and `k` is that
  block's byTypeStatus ExclusiveStartKey." The paragraph goes on to explain the
  absent-`k` encoding and the tag discipline. Nothing in it mentions `d`, which
  is the field that LICENSES A ROW DROP. `d`'s own docblock is 20 lines below at
  `:346-357`, inside the interface, so the definition and the description now
  disagree at the top of the same block.

The four cross-references, all still `{q,b,k}`:

- `app/src/routes/inbox.ts:315` (inside `decodeCursor`, the `all` decoder)
- `app/src/routes/inbox.ts:524` (inside the `unread` decoder)
- `app/src/routes/inbox.ts:757`
- `app/test/inboxApi.test.ts:273` ("a valid `{q,b,k}` cursor returns 200")

**Evidence.** `app/src/routes/inbox.ts:325-337` (the header), `:346-357` (`d`'s
docblock), `:1760` (the one site updated); `:315`, `:524`, `:757`;
`app/test/inboxApi.test.ts:273`. `git diff main...HEAD` and `git diff HEAD`
touch none of the five stale sites.

**What it implies.** This is the same defect class the coordinator ACCEPTED as
finding 1 and finding 5 in R1 - a comment naming a shape the code no longer has -
and it sits at a strictly more authoritative location than either of those.
The three decoder cross-references are lower consequence (they exist to explain
the `q`-tag rejection, and the tag is unchanged), but `:326` is the wire
contract, and it under-describes a field whose whole purpose is to authorize
skipping a triage row.

**Suggested fix.** Add `d` to `:326`'s enumeration in one clause ("...and `d`,
present only on a cursor a thread-read deferral minted, naming the row the next
request re-reads"), and s/`{q,b,k}`/`{q,b,k,d}`/ at the four cross-reference
sites.

---

## 2. [MEDIUM] The rewritten comment still claims "Exactly one retry per row, from ANY page". A row consumed AHEAD of the deferred row makes that row defer a second time, and the new exception paragraph does not cover it.

**What is wrong.** The fix wave conditioned the PROGRESS half of the claim but
left the RETRY-COUNT half unconditional:
`app/src/routes/inbox.ts:2012` - "Exactly one retry per row, from ANY page, and
PROGRESS WHENEVER THE SAME ROW IS AT THE HEAD ON TWO CONSECUTIVE REQUESTS". The
exception paragraph that follows (`:2015-2023`) enumerates exactly one
counter-case: "if a DIFFERENT contact sorts into the head position between the
two requests ... and that row's read ALSO fails". There is a second, distinct
counter-case, reached through a different clause of the same guard:

Request N defers at X, minting `d = X` and a position P immediately before X
(`:2057-2058`). Between requests a row W appears between P and X - an ordinary
new `type='unknown'` contact whose id sorts there inside the same status block,
or a soft-deleted one restored. Request N+1: W is consumed and kept, which sets
`retryFrom = after(W); retryFromMoved = true` (`:2081-2082`). X is then read and
fails again. The guard at `:2033-2037` requires `!retryFromMoved`, which is now
FALSE, so the step-over does NOT fire - X is DEFERRED a second time, with the
same `d`, at an advanced position. Request N+2 finds X at the head and steps
over. X therefore received TWO retries, and the WARN fired twice for it.

The behaviour is safe (an extra retry is the conservative direction) and the
walk still advances. The CONTRACT SENTENCE is what is wrong.

**Evidence.** `app/src/routes/inbox.ts:2012` (the claim), `:2015-2023` (the
enumerated exception, head-change only), `:2033-2037` (the guard's three
clauses), `:2057-2058` (the deferral re-stamping `d`), `:2081-2082` (a kept row
sets `retryFromMoved`).

**What it implies.** A reader who trusts "Exactly one retry per row" has two ways
to go wrong. Building a metric or an alarm on "one WARN per failing row" is one.
The sharper one: the parenthetical two lines below the guard says
"`keptContacts.length === 0` is implied by `!retryFromMoved`", which invites
treating the `!retryFromMoved` clause itself as redundant once `d` matches - and
`!retryFromMoved` is precisely the clause that produces this second retry. The
fix wave's whole purpose was to make this paragraph true of the code beneath it;
it is still not.

**Suggested fix.** Change "Exactly one retry per row" to "at least one retry per
row, and exactly one when nothing has moved under the cursor", and add the
consumed-row-ahead case to the exception paragraph in one sentence.

---

## 3. [LOW] The fix wave conditioned the termination claim in the code and left the identical unconditional claim standing in the issue it closes

**What is wrong.** `docs/issues/unknown-queue-page-head-drop-after-filled-page.md:22`
(the Resolution block added by the branch commit) reads: "Exactly one retry per
row from any page; a permanently failing row is still stepped over on its second
failure, so the walk still terminates." That is word-for-word the claim R1
finding 2 flagged and the fix wave softened at
`app/src/routes/inbox.ts:2012-2023`. The issue file was not touched by the fix
wave (`git diff HEAD` touches `inbox-filter-tabs-full-walk.md` and
`inbox-parselimit-empty-one-row.md` only).

**Evidence.** `docs/issues/unknown-queue-page-head-drop-after-filled-page.md:22`;
`app/src/routes/inbox.ts:2012-2023`; `git diff HEAD --stat`.

**What it implies.** A closed issue is the artifact a future reader trusts most,
and the registry is the repo's issue tracker of record. Correcting the code
comment while leaving the closed issue asserting the stronger version means the
next person to ask "is this bounded?" gets the answer the fix wave decided was
wrong, from the more durable source.

**Suggested fix.** One clause in the Resolution: "...stepped over on its second
failure AT THE HEAD, so the walk terminates whenever the same row is at the head
on two consecutive requests (see the comment at the guard for the churn case)."

---

## 4. [LOW] The new decoder disclaimer understates the forged-`d` bound: it is one un-retried row PER FORGED CURSOR, not one per walk

**What is wrong.** The fix wave's new sentence at
`app/src/routes/inbox.ts:439-444` says a well-formed forged `d` "can cost the
forger exactly one un-retried row on their own walk". The scope word is "walk",
which spans requests; the actual bound is per REQUEST. Each request carries one
cursor and can therefore step over at most one row, but a client is free to mint
a fresh forged cursor for every Load more, so across a walk the number of
un-retried rows it can skip is the number of requests it makes (each still
requiring a genuine thread-read failure on the named row).

**Evidence.** `app/src/routes/inbox.ts:439-444` (the claim);
`:2033-2037` and `:2038-2044` - the step-over is inside the per-row loop but
guarded by `!retryFromMoved && keptContacts.length === 0`, so it can fire at most
once per request; the cursor is decoded once per request at `:1764`.

**What it implies.** Small in consequence - a forger already skips arbitrary rows
by fabricating the POSITION (`b`/`k`), which is a strictly stronger primitive
than `d`, so `d` adds nothing to their reach. That is the stronger sentence the
comment could have made. As written it states a bound the code does not provide,
in the one paragraph whose job is to stop someone re-filing this as a security
issue.

**Suggested fix.** "...one un-retried row per forged cursor, and nothing a
forged POSITION could not already skip - which is why this is robustness, not a
security boundary."

---

## 5. [LOW, PRE-EXISTING, WIDENED BY THIS BRANCH] `drops.unknownThreadReadFailed` counts a DEFERRAL as a drop, and the branch makes deferrals strictly more common

**What is wrong.** `resolveOpenThreads` calls `dropped('unknownThreadReadFailed')`
on every thread-read failure (`app/src/routes/inbox.ts:1803`), before the caller
has decided whether the failure is a DEFERRAL (row kept for the next request) or
a DROP (row stepped over). Both outcomes therefore increment the same key in the
`drops` map that ships on the `inbox feed assembled` line. The `drops` docblock
states the opposite contract at `:812`: "Its absence means nothing was dropped".

The branch changes the mix: every page-head failure arriving on a cursor WITHOUT
a matching `d` - which is now every page-full and every roll-over cursor - is a
DEFERRAL where it used to be a DROP. So the counter's false-positive rate goes
up as a direct consequence of this change.

**Evidence.** `app/src/routes/inbox.ts:1803` (the counter, in the helper);
`:2038-2044` (the deferral, which does not decrement or re-label it);
`:812` (the "absence means nothing was dropped" contract);
`app/test/inboxUnknownTab.test.ts:605-606` pins
`drops: { unknownThreadReadFailed: 1 }` on the DROP request - the deferral
request one lines above produces the identical value with nothing dropped.

**What it implies.** On a queue whose stated stakes are "silent row loss on a
queue whose entire job is that nothing rots unseen" (`:1998-2001`), the single
aggregate field an operator would reach for cannot tell "we deferred, nothing
lost" from "we dropped a row". The WARN/ERROR discrimination at `:2038-2056`
does distinguish them, so the information exists - it is the summary line that
conflates. Not introduced here, but made more frequent here.

**Suggested fix.** Either rename the counter to `unknownThreadReadFailed` in a
separate non-`drops` field, or add a second key (`unknownThreadReadDropped`)
incremented only on the step-over at `:2038-2044`.

---

## Responses to the adjudications

**R1 finding 3 (encoder can mint `d: ""`) - REJECTED. CONCEDED.**
`app/src/lib/tables.ts:79` makes `contactId` the contacts table's hash key, so
DynamoDB cannot hold an item with `contactId: ''` and the encoder cannot be
handed one; the finding is unreachable in production and the asymmetry is
harmless. I contest ONE sentence of the reasoning, not the verdict: "leaving the
asymmetry keeps the impossible case loud (a 400)" is not true of this path. The
400 is returned without a log line (`app/src/routes/inbox.ts:2607-2610` - no
`log.warn`/`log.error` before the response), and the dashboard swallows it in an
empty catch (`dashboard/src/routes/inbox/useInbox.ts:350-352`, "keep the cursor
so the user can retry"). Neither branch of the impossible case is loud; the
rejection stands on reachability alone, which is sufficient.

**R1 finding 2, positional-match alternative - REJECTED. CONCEDED, and the
coordinator is right on a trace I did not run.** Licensing the step-over on
"cursor carries `d` AND `retryFrom === resume.position`" would fire on the
churn case itself: request N defers at X (`d = X`, position P); a new contact W
sorts into the head at P; request N+1 reads W first, W's thread read fails,
`retryFrom` is still P and `d` is present - so the alternative steps over W,
which no request has ever retried. That is the exact defect class the branch
exists to close, reintroduced one layer down. The identity match is the correct
predicate. The comment fix (accepted) is the right disposition, subject to
finding 2 above, which is a different sentence in the same paragraph.

---

## Verified OK

The fix diff, reviewed cold:

- `app/src/routes/inbox.ts:439-444` (decoder disclaimer) - the three factual
  halves are TRUE: the cursor is unsigned base64url JSON (`:373`), a forged `d`
  is honoured only alongside the matching position (`:2033-2034`), and the
  step-over still requires a genuine thread-read failure (the guard is inside
  `if (open === undefined)` at `:1969`). Scope word contested as finding 4.
- `app/src/routes/inbox.ts:2012-2023` (progress condition) - the softened claim
  is accurate on the head-change path it describes: a non-matching head defers
  again at the SAME position with a NEW `d` (`:2056-2058`), emits a WARN not an
  ERROR (`:2053-2056`), and each request terminates - there is no server-side
  loop. "It needs the head to change on EVERY consecutive pair" is correct: any
  pair where the head is stable advances positionally.
- `app/test/inboxUnknownTab.test.ts:550-553` - "THE CAP REQUIRES A DEFERRAL
  CURSOR NAMING THIS ROW" now matches `app/src/routes/inbox.ts:2033-2037`, the
  history clause is accurate, and "see the two FILLED-page pins further down" is
  true - both new pins are below this one (`:700` and `:761`).
- `app/test/inboxUnknownTab.test.ts:618-620` - the rewritten mutation probe is
  FAITHFUL and I traced it: replacing the first clause with `true` makes the
  guard `true && !retryFromMoved && keptContacts.length === 0`, which on request
  one (no cursor) steps over `c-p1-broken`, serves `c-p2`/`c-p3` and ends
  `nextCursor: null`, so `expect([...seen].sort()).toEqual([...])` - the first
  assertion after the loop - goes RED. It is exactly equivalent to the deletion
  the old probe named, which is what makes the rewrite a faithful restatement
  rather than a new probe.
- `dashboard/src/api/paging.ts:33-39` - BOTH halves of the new sentence are true.
  (a) "NOT walked by this helper": `fetchAllPages` has exactly four call sites,
  all in `dashboard/src/api/endpoints.ts` - conversations (`:525`), contacts
  (`:1302`), units (`:1324`), placements (`:1343`). Neither `/api/inbox` (which
  uses its own `PAGE_LIMIT = 30` in `dashboard/src/routes/inbox/useInbox.ts:94`)
  nor `/api/ai-runs` (`endpoints.ts:2735`, a single-page read) is among them.
  (b) "clamp an oversized limit and fall back ... on an empty, zero or negative
  one": true of `app/src/routes/inbox.ts:2550-2555` and
  `app/src/routes/aiRuns.ts:75-86`.
  (c) The "two routes" count is EXHAUSTIVE - I enumerated every `?limit=`
  consumer in `app/src`: seven `parseLimit` copies that 400 (`api.ts:449`,
  `broadcasts.ts:157`, `contacts.ts:374`, `contactTimeline.ts:339`,
  `placements.ts:189`, `units.ts:240`, `unmatchedEmail.ts:143`) plus three
  inline parsers that also 400 (`tours.ts:195-201`, `contacts.ts:1348-1357`,
  `statusTransition.ts:221-230`) and one dev-only reader (`dev.ts:249`,
  structurally absent in deployed envs). No third clamping route exists.
- `docs/issues/inbox-filter-tabs-full-walk.md` - the reword is now correct
  against `app/src/routes/inbox.ts:1795` and the class-b comment at `:2063-2066`.
- `docs/issues/inbox-parselimit-empty-one-row.md` - "the module-private function
  above `createInboxRouter`" is accurate: `parseLimit` is unexported at
  `app/src/routes/inbox.ts:2550` and `createInboxRouter` is exported at `:2573`.
- Every added line in the fix diff is ASCII (checked mechanically over
  `git diff HEAD`). No `max-len` or `printWidth` rule exists in
  `eslint.config.mjs`, so the one 89-column added line
  (`app/test/inboxUnknownTab.test.ts:620`) is a cosmetic break from the block's
  own 80-column wrapping, not a gate-5 error.
- The fix diff is comment-only in `app/src` and `dashboard/src`; no executable
  statement changed, so no test outcome can move on it. Confirmed by reading the
  whole of `git diff HEAD`.

Fresh sweep of the branch's behaviour (second pass, hunting for what everyone
missed - no new behavioural defect found):

- **`d` is never paired with a boundary the deferral did not mint.**
  `deferredContactId` is assigned at exactly one site (`:2058`), immediately
  after `boundary = retryFrom` (`:2057`) and immediately before
  `threadReadStopped = true; break` (`:2059-2060`), which the outer loop honours
  at `:2100`. The page-full (`:2077`) and roll-over/exhaust (`:2091`) exits are
  both unreachable after it. So `encodeUnknownCursor(boundary, deferredContactId)`
  at `:2229` can only ever attach `d` to the deferral's own position.
- **A deferral always mints a real cursor.** `boundary = retryFrom` and
  `retryFrom` is `resume?.position ?? { block: 0 }` (`:1851`), never `undefined`,
  so there is no path where `d` is computed and then discarded by the
  `boundary === undefined` branch at `:2229`.
- **No double-serve.** A deferral's boundary is at-or-before the failing row and
  strictly after every row kept on that page; the resume position a previous
  request minted is always after everything it served. Re-verified for all four
  boundary sources.
- **No new row loss.** The step-over fires strictly less often than under the old
  predicate, and the deferral path consumes nothing.
- **Termination at `limit = 1`.** A kept head row fills the page immediately, so
  a deferral at `limit = 1` can only occur with `keptContacts.length === 0`; the
  next request matches `d` and steps over. Traced.
- **Budget interaction.** A budget-stopped read mints `boundary = read.next` with
  no `d` (`:2091`, `:2123`), so a `d` is dropped rather than carried past rows it
  no longer describes - conservative, and it costs at most one extra deferral.
  `remainingBudget` is per-request, so nothing accumulates across a deferral.
- **The second new test's `expect(third.nextCursor).toBeNull()` is sound**, not
  accidental: after stepping over `c-g3-broken` and keeping `c-g4`, the first
  read returns with `next = { block: 1 }` (the inner `rows.length >= want` break
  at `unknownQueue.ts:343` fires after the roll-over), so the caller loops once
  more, the empty `active` block exhausts, and `read.next` is `undefined`.
- **`readUnknownQueue`'s docblock is unaffected.** `d` never reaches it; its
  `want`/`budget` guards (`unknownQueue.ts:325-332`) are still unreachable from
  HTTP because `parseLimit` cannot return < 1.
- **The `unknown` cursor's `d` never reaches DynamoDB.** `deferredContactId`
  appears at eight sites in `inbox.ts` (`:363`, `:366`, `:371`, `:448`, `:1843`,
  `:2034`, `:2058`, `:2229`); the only read is the `===` comparison at `:2034`.
- **The branch made one pre-existing comment TRUE that was false before.**
  `resolveOpenThreads`'s docblock defines a DROP as "the row already had its
  retry and the walk steps over it". Under the old `resume !== undefined`
  predicate that was false for every cursor-bearing first-row failure; under the
  identity match it is now exactly right.
- **The design spec needs no update.**
  `docs/superpowers/specs/2026-08-25-inbox-unknown-tab-walk-design.md` carries the
  `<!-- HISTORICAL-RECORD -->` banner (line 1) and states no cursor shape, so the
  `d` addition owes it nothing.
- **Dashboard rendering of the more-frequent empty-page-with-cursor state.**
  `Inbox.tsx:64` selects the empty copy on `hasMore` and `:284` gates Load more
  on `hasMore` alone; `useInbox.ts:340-346` installs the new cursor unconditionally,
  and a cursor differing only in `d` is a different string, so Load more stays
  live. No client change is owed.

UNVERIFIED (not attempted, per the read-only brief):

- No suite was executed; every RED/GREEN and pass/fail statement here is a code
  reading. `npm run typecheck` and gate-5 `eslint` were not run - though the fix
  diff changes no executable line, so neither can newly fail on it.
- The reachability of finding 2's second retry path is argued from the index
  ordering, not measured: it needs one contact to appear between the cursor
  position and the deferred row between two requests. I did not construct it
  against a real byTypeStatus index.
