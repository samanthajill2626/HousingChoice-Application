# Adversarial review - BLAST RADIUS lens

Branch: `feat/inbox-unread-cluster`, rework range `0393c75e..HEAD`
Worktree: `W:\tmp\inbox-unread-cluster`
Posture: READ-ONLY. No file changed, no commit, no server started, no suite run.
Probes were pure-logic and lived in the session scratchpad.

The diff is where the change is. This review is about where the damage is, so
almost everything below was found OUTSIDE the diff - in `dashboard/`, in the
route's callers, and in the helper's consumers.

---

## FINDINGS

### 1. HIGH - the dashboard re-sorts the accumulated pages and destroys queue order

**Where:** `dashboard/src/routes/inbox/useInbox.ts:117-121` (`sortByActivity`),
`:343` (`setBase((prev) => [...prev, ...pageData.rows])`), `:534`
(`const rows = sortByActivity(visible)`).
Contradicted comment: `app/src/routes/inbox.ts:1902-1909`.

**What is wrong.** The whole rework rests on one property: rows are READ in
queue order - the `needs_review` block drained before the `active` block is
touched - so "the TOTAL order across pages is QUEUE order, not activity order"
(`inbox.ts:1903-1905`). The server then applies a deliberate PER-PAGE sort and
documents the trade in detail.

The client throws that away. `useInbox` appends every page into one `base`
array and then sorts the WHOLE accumulated array newest-first, with no filter
gate - `sortByActivity` is applied for every filter, `unknown` included. The
moment the operator clicks Load more, page 2's already-reviewed `active` rows
interleave with (and can sit entirely above) page 1's untriaged `needs_review`
rows. The server's careful arrangement survives exactly one page.

**Failure scenario (concrete).** 40 `type='unknown'` contacts with open
threads: 30 `needs_review` whose traffic is from June, 10 `active` whose
traffic is from August. Page 1 = the 30 untriaged rows. Operator clicks Load
more. Page 2 = the 10 reviewed rows. The rendered list now leads with all 10
`active` rows, and the untriaged queue - the thing the tab exists for - is
pushed below them. "Untriaged first" is true on the wire and false on screen.

**Evidence.** Probe replicating `useInbox.ts:117-121` and `:343` verbatim:

```
server total order across pages : nr-1(needs_review) nr-2(needs_review) act-1(active) act-2(active)
client rendered order           : act-2(active) act-1(active) nr-2(needs_review) nr-1(needs_review)
untriaged rows above reviewed?  : false
```

`useInbox.ts:533` narrows only on `filter === 'unread'`; nothing exempts
`unknown` from the sort. `Inbox.tsx:209` maps `inbox.rows` (the sorted list),
not `base`.

**Direction.** Either (a) stop sorting client-side for `filter === 'unknown'`
and trust the server's page order - the server already sorts each page, so
rendering `visible` unsorted preserves both per-page readability and global
queue order; or (b) keep the client sort and delete the server's per-page sort
plus the paragraph claiming a cross-page queue order, and say plainly that the
rendered order is activity order over an arbitrary queue-order prefix. What
must not stand is the current state, where the server's design record asserts a
property the only consumer removes.

---

### 2. HIGH - a budget-stopped EMPTY page ships a cursor the dashboard cannot render

**Where:** `dashboard/src/routes/inbox/Inbox.tsx:206-230` (the `Load more`
button is nested inside `inbox.rows.length > 0`).
Contradicted comment + contract: `app/src/routes/inbox.ts:1849-1853`.
Server-side pin with no client counterpart: `app/test/inboxUnknownTab.test.ts:303-332`.

**What is wrong.** The new branch deliberately returns an empty page WITH a
cursor when the scan budget runs out, and the code says what it expects the
client to do:

> "NAMED HONESTLY: a budget-stopped page that kept ZERO rows returns an EMPTY
> page WITH a cursor. The dashboard then shows its ordinary empty state plus a
> live Load more." (`inbox.ts:1849-1853`)

The second half is false. `Inbox.tsx` renders the rows block and the Load more
button under one gate, `inbox.status === 'ready' && inbox.rows.length > 0`
(:206); `inbox.hasMore` is only consulted INSIDE that block (:219). With zero
rows the empty-state block at :199 renders instead - `serverEndedEarlyEmpty` is
false because the unknown branch deliberately never sets `truncated` - and the
cursor is held in state with no affordance that can spend it.

**Failure scenario.** The unknown partition accumulates threadless
group-detection stubs and soft-deleted residue (both are named in
`unknownQueue.ts:35-46` as the reason the fill loop and the budget exist). Once
the first `UNKNOWN_QUEUE_SCAN_BUDGET` (1000) raw index rows yield zero contacts
with an open non-relay thread, the request returns `{ rows: [], nextCursor:
"<q,b,k>" }`. The operator sees "No unknown numbers" with no Load more. Every
queue row behind row 1000 is unreachable from the UI - which is precisely the
HIGH finding ("rows past that window were UNREACHABLE ... nothing an operator
could click reached row 31", `unknownQueue.ts:12-13`) this rework was chartered
to fix, reintroduced one layer up.

**Evidence.** Probe evaluating the exact JSX gates with the exact state the
server can now produce:

```
empty page WITH nextCursor -> empty state: true | Load more rendered: false | hasMore was: true
```

`grep -c "loadMore|Load more" Inbox.tsx` = 6, all within the single :206-230
block; there is no second render site. `dashboard/src/routes/inbox/Inbox.test.tsx:389-406`
pins the Unknown empty state but only with `baseState()` (hasMore false) - no
dashboard test covers empty + hasMore, so this ships green.

**Reachability caveat, stated honestly:** with the measured partitions (16 dev /
7 prod) this is not reachable today. It is reachable at any scale where
threadless stubs outnumber the budget, and the server has already committed to
the contract in a passing test.

**Direction.** Hoist the Load more button out of the `rows.length > 0` gate -
render it whenever `status === 'ready' && hasMore`, alongside either the row
list or the empty state. Then add the dashboard pin that the app-side pin
already assumes exists.

---

### 3. MED - `decodeUnknownCursor` never cross-checks `b` against `k`, so a mismatched pair 500s

**Where:** `app/src/routes/inbox.ts:372-404` (`decodeUnknownCursor`), consumed
at `:1655` and passed into `readUnknownQueue` at `:1727-1735`, which builds the
Query from `blocks[block]` (`unknownQueue.ts:297-303`) while the
`exclusiveStartKey` comes from the client's `k`.

**What is wrong.** This is the only one of the four inbox cursor namespaces
where the server picks the Query's KeyConditionExpression from one cursor field
(`b` -> `blocks[b].status`) and the ExclusiveStartKey from another (`k`), and
nothing checks that the two describe the same partition. The decoder
deliberately does not pin `k`'s key NAMES (":364-366", copying `decodeCursor`'s
posture) - but `decodeCursor`'s key is replayed against the same Query it was
minted from, so the two situations are not analogous.

The reader's own doc claims the pairing is safe by construction: "using the
block's values means a malformed stored image cannot produce a key that points
into a different partition" (`unknownQueue.ts:219-221`). That holds for a key
minted in-process. It does not hold for a key that arrived over the wire and
was re-paired with a server-chosen block.

**Failure scenarios.**
- *Tamper, reachable today:* `{q:1, b:0, k:{type:'unknown', status:'active',
  contactId:'x'}}`. Block 0 is `needs_review`, so the Query is
  `type = :t AND status = 'needs_review'` with an ExclusiveStartKey carrying
  `status: 'active'`. DynamoDB rejects a start key inconsistent with the range
  key predicate. `aggregateInbox` maps only `InboxBadRequestError`
  (`inbox.ts:2282-2288`), so a ValidationException reaches the error handler as
  a 500 on an endpoint whose cursor decoder exists specifically to guarantee
  400s. Same for `{q:1, b:1, k:{foo:'bar'}}` - non-empty string values pass
  :400 and an incomplete key reaches the service.
- *Honest cursor, no tampering:* `b` is a positional index into a DERIVED
  array. The decoder handles the array SHRINKING (`b >= length` -> 400, :390)
  but not it being REORDERED or having a member INSERTED. A deploy that adds a
  legal status for `unknown` ordered between `needs_review` and `active` gives
  index 1 a new meaning; a cursor minted seconds before the deploy then pairs
  block 1's new status with the old block's `active` start key.

**Confidence.** The b/k coupling and the missing check are CONFIRMED by
reading. The exact AWS behaviour on a start key that disagrees with the range
key predicate - ValidationException rather than a silent seek - is PLAUSIBLE
rather than proven here; I did not start DynamoDB Local. **What would settle
it:** one case in `app/test/inbox.integration.test.ts` that calls
`GET /api/inbox?filter=unknown` with a hand-built `{q:1,b:0,k:{...status:'active'...}}`
cursor against the real index and asserts 400. Note that either outcome is a
defect: a ValidationException is a 500, and a silent seek serves a page from the
wrong block.

**Direction.** Since `k` already carries `status` (the reader mints it that
way), derive the block from `k` or validate `k.status === UNKNOWN_QUEUE_BLOCKS[b].status`
and `k.type === ...[b].type`, 400 on disagreement. That closes the tamper case,
the deploy-shift case, and removes the positional-index fragility in one check.

---

### 4. LOW - the shared partition fake's rule 6 rationale now describes deleted code and cites a deleted test

**Where:** `app/test/helpers/contactsPartitionFake.ts:39-49`.

**What is wrong.** The diff carefully updated this file's KEY SHAPE paragraph
and added the new resume-block commentary, but left rule 6's "WHY THIS RULE
EXISTS" block untouched. It still reads:

> "...which means the unknown queue's page budget and result cap cut
> STATUS-FIRST and starve the status that means 'nobody has looked at this yet'.
> ... Pinned by test/unknownQueue.test.ts ('the cap starves needs_review...')."

Both bounds are gone (`UNKNOWN_QUEUE_MAX_ROWS` and `UNKNOWN_QUEUE_MAX_PAGES` no
longer exist), and the cited pin was deleted - `app/test/unknownQueue.test.ts:77`
says so explicitly ("REPLACES the deleted 'THE CAP STARVES needs_review' pin").
`grep -rn "CAP STARVES|cap starves" app/` returns exactly these two lines: the
stale citation and its own obituary.

This matters more here than in an ordinary file, because the header positions
this helper as "the one helper positioned as the authority on partition
semantics" and its rule 6 is the justification a future reader will consult
before touching the sort model.

**Direction.** Rewrite the paragraph to say what is still true - modelling the
range-key sort is what makes BLOCK ORDER expressible, and is what the new
"untriaged block is exhausted before the reviewed block is read" pin depends on
- and drop the citation to the deleted test.

---

### 5. LOW - the fake's `contactId`-only resume fallback is dead and carries the exact bug the rework removed

**Where:** `app/test/helpers/contactsPartitionFake.ts:128-130`.

**What is wrong.** The new positional path (:121-127) was written because
identity resume "returns -1 there and, +1, silently RESTARTS the partition,
which would model the paging bug (duplicate rows on page 2) as correct
behaviour" (:107-110). The `else if` fallback immediately below keeps exactly
that: `findIndex((c) => c.contactId === startContactId) + 1`, which is `0` on a
miss.

It is justified by "a hand-built key is allowed to carry contactId alone", but
no consumer does that. Sweeping the five suites that use this helper plus its
own test, every `exclusiveStartKey` is either a `lastEvaluatedKey` the fake
minted (which always carries `status`) or belongs to a different fake entirely.
So the branch is unreachable today and, the day someone does reach it, it
silently restarts the partition and turns duplicate rows into a green test.

**Direction.** Delete the fallback, or make it throw with a message pointing at
the KEY SHAPE note. A hand-built key that cannot express a position should be a
loud test failure, not a silent restart.

---

### 6. LOW - the byTypeStatus invariant is now enforced on `update()` but not on `create()`

**Where:** `app/src/repos/contactsRepo.ts:1137-1153` (`create`), `:624`
(`create(input: Partial<ContactItem> & { type: ContactType })`), against the new
guard at `:1247-1256`.

**What is wrong.** `REQUIRED_INDEX_KEY_ATTRIBUTES` names `type` AND `status` as
attributes "a contact may never be WITHOUT", and the new
`RequiredIndexKeyRemovalError` enforces that on one mutation surface. `create`
requires only `type`; `status` is optional on `ContactItem` and `create` applies
no default, so `contacts.create({ type: 'unknown' })` type-checks and writes a
contact that is not in the byTypeStatus index at all - invisible to the Unknown
tab, the Today triage block, `GET /api/contacts?type=`, and audienceResolution,
while reading back fine by id. Exactly the failure the guard's own doc calls
"the worst failure class this codebase has met", through the door the guard does
not cover.

**Reachability.** No current caller hits it. I checked every one:
`routes/contacts.ts:1049` (`parseCreateBody` defaults status at :881-884),
`routes/public.ts:257-259`, `routes/unmatchedEmail.ts:461-462`,
`services/contactCapture.ts:80`, `services/groupConvert.ts:340`,
`services/groupMembers.ts:112`, and both seeds (`seed/cast.ts:114`,
`seed/performance.ts:547-558`) all set a real status. So this is a latent hole,
not a live bug.

**Mitigating fact, in the guard's favour:** a DETECTOR already exists.
`app/scripts/measure-unread-contact-coverage.ts:844-936` Scans the base table
and reports "NOT deleted, type=unknown - INVISIBLE TO THE byTypeStatus
PARTITION", so an existing or future stranded row is findable.

**Direction.** Either default `status` in `create` the way `parseCreateBody`
does, or make `status` required in `create`'s input type so omitting it is a
typecheck failure - the same load-bearing-map style the rest of this branch
uses.

---

## WHAT I SWEPT AND FOUND CLEAN

**1. The shared write guard - every caller enumerated.** `contactsRepo.update`
callers: `routes/contacts.ts:1520` (PATCH triage), `routes/public.ts:306`,
`routes/webhooks/twilio.ts:855` and `:896`, `routes/webhooks/voice.ts:611`,
`services/extraction/apply.ts:458` and `:689`, `services/statusTransition.ts:342`
and `:597`. **None can now throw where it did not before:**

- The PATCH route is the only user-facing one that could carry `type`/`status`.
  `parseTriageBody` (`routes/contacts.ts:520-562`) requires `type` to satisfy
  `isContactType` and `status` to be a string in the allowlist - a `null` is a
  400 at the parser, so `RequiredIndexKeyRemovalError` is unreachable from the
  edit form. Its only `catch` maps `ConditionalCheckFailedException`, so a throw
  WOULD be a 500 - but nothing can produce one.
- The provenance loop at `:1502-1506` writes `${f}_source = null`, never `type`
  or `status` themselves.
- `statusTransition` writes real status values (`:342`, `:597` via `plan.patch`).
- The extraction path writes only extractable fields and already catches
  (`apply.ts:459-470`), so even a hypothetical throw is a logged best-effort
  skip, not a dropped background job.
- Repo-wide grep for `status: null` / `type: null` / `['status'] = null` /
  `['type'] = null` on the contacts path: zero production hits.
- There is no importer call site (`grep` over `src/lib/import/` finds only
  crypto `.update()`), so no half-applied import is possible.

**Guard narrowness (the inverse question).** Correctly scoped: `byPhone`,
`byEmail` and `byHousingAuthority` are excluded, so the edit form's
`housingAuthority` clear (`routes/contacts.ts:600`, `v.length > 0 ? v : null`)
still works, as do `removePhone`/`removeEmail`. `REQUIRED_INDEX_KEY_ATTRIBUTES`
is derived from the table spec by index name and pinned in the integration test,
so a rename cannot silently empty it. The in-memory double mirrors the rule
(`test/helpers/twilioWebhookHarness.ts:1799-1804`), so no fake accepts what the
repo refuses. The one hole is finding 6 (a different mutation surface, not this
one).

**2. The deleted feature - the compensating surface holds end to end.** Class d
(a soft-deleted unknown with a post-deletion unread inbound) is provably still
served by `filter=all`:

- Soft delete does NOT close conversations - `routes/contacts.ts:1952-1966`
  only stamps `deleted_at`; the thread stays in the byLastActivity `open`
  partition the `all` pager walks.
- The delete route's unread reset is explicitly delete-only and does not defeat
  resurfacing (`:1978-1983`), and a post-deletion inbound re-increments unread.
- `all` runs the IDENTICAL predicate the deleted sweep ran -
  `buildContactRow`'s `deleted` block (`inbox.ts:884-923`), reached via the
  `deleted && unreadSum === 0` fast-path at `:1093`. Same code, same rules; the
  sweep was a second caller of it, not a second policy.
- The `all` pager is cursor-paged and unbounded, and a resurfacing row is recent
  by construction (it requires an inbound newer than `deleted_at`), so it lands
  near the top of page 1. No cap, budget or filter on `all` can exclude the
  same rows.
- The link target holds: `InboxRow.tsx:44-46` sends a `kind: 'contact'` row to
  `/contacts/:contactId`, and `routes/contacts.ts:1094-1113` does NOT 404 a
  soft-deleted contact (it 404s only a missing row and a `phone_ref` pointer).
  The row also renders its "Deleted" tag (`InboxRow.tsx:107`) and correctly
  suppresses mark-unread (`:135-138`).
- `app/test/inboxUnknownParity.test.ts:135-170` asserts BOTH halves in ONE
  world, presence on `all` first and absence from `unknown` second.

**3. The response contract - every consumer checked.**
- `dashboard/src/api` / `useInbox`: `nextCursor` was already the general shape;
  `loadMore` (`useInbox.ts:319-360`) handles a non-null cursor for any filter,
  with its filter-generation and first-page-generation guards intact. The one
  gap is finding 2 (the render gate), not the hook.
- Performance harness: `e2e/performance/collect.ts:150-192` classifies by an
  EXACT two-key `{filter, limit}` tuple and 400s anything else into
  `endpointContractMismatch`. The cold load still issues exactly
  `?filter=unknown&limit=30`; a cursor request is user-driven and outside the
  cold sample, so the tuple pin is unaffected.
- `e2e/performance/routes.ts:583`: `inbox-unknown`'s terminal contract accepts
  both populated and empty, so a budget-stopped empty page reports `empty`, not
  `contradictory_terminal`. Its scale profile makes the budget unreachable
  anyway - `seed/performance.ts:195-198` mints `contacts / 100` unknowns, two
  orders of magnitude below `UNKNOWN_QUEUE_SCAN_BUDGET`.
- E2E: `e2e/tests/dashboard-next/unknown-caller-triage.spec.ts` drives
  `GET /api/contacts?type=unknown` and the UI tab; neither depends on
  `nextCursor`. `e2e/tests/dashboard-next/inbox.spec.ts:23` only walks tab
  labels.
- Diagnostics/alerting: `grep` over `*.tf` / `*.json` / `*.yaml` finds NO
  consumer of the removed log fields (`sweepScanned`, `resurfaceTruncated`,
  `resurfaceCapped`, `queueContacts`, `queuePages`). Their only surviving
  mentions are deliberate historical notes plus the negative assertions at
  `app/test/inboxUnknownTab.test.ts:513-515`.
- `app/scripts/measure-unread-contact-coverage.ts` took a comment-only change;
  its `listByType` reads and its Scan-based invisibility audit are untouched.

**4. Cursor namespacing.** All four namespaces are mutually exclusive:
`decodeCursor` (`all`) rejects `t`, `u` AND the new `q` (`inbox.ts:317-319`);
`decodeUnreadCursor` rejects anything without `u === 1` (`:454`);
`decodeUnknownCursor` rejects anything without `q === 1` (`:385`); the groups
cursor is tagged `gt1` and validated in `conversationsRepo` (`:452-471`). No
foreign cursor can reach a wrong-partition Query. (Finding 3 is about
SELF-consistency within the unknown cursor, not about namespace crossing.)

**5. The shared test helper - no suite silently weakened.** Consumers of
`listByTypeFromContacts`: `inboxFeed.test.ts:222`, `inboxGroups.test.ts:115`,
`inboxUnknownParity.test.ts:84`, `inboxUnknownTab.test.ts:127`,
`unknownQueue.test.ts:36`, plus `contactsPartitionFake.test.ts`. Every one of
those either passes no `exclusiveStartKey` or passes a `lastEvaluatedKey` the
fake minted (always three attributes), so the identity->positional change is a
no-op for them: same seek, same pages, same reasons. The `twilioWebhookHarness`
fake is a separate historical one and kept its shape; its only change is
mirroring the new write guard. Nothing goes green for a weaker reason.

**6. Block-order isolation.** `grep` for `UNKNOWN_QUEUE_BLOCKS` /
`UNKNOWN_QUEUE_STATUS_ORDER` / `UNKNOWN_QUEUE_TYPES` outside `unknownQueue.ts`:
only `routes/inbox.ts` (which uses `.length` for the cursor range check and
never hard-codes an order) and the tests. The "anything that hard-codes
'needs_review then active' outside this file un-does the isolation" instruction
is currently honoured.

**7. Termination.** The `for(;;)` fill-or-exhaust loop at `inbox.ts:1726-1857`
terminates for every reachable input: `parseLimit` clamps to `1..100`
(`:2242-2246`), so `want >= 1` on every pass, and each non-terminal pass charges
at least `pageSize` against a strictly decreasing budget. `budget: 0` returns
immediately with `budgetSpent` and breaks. (`limit: 0` would spin, but only an
in-process caller of `aggregateInbox` could supply it, and none does.)

**8. Other readers/writers of the touched state.** `listByType` itself is
unchanged, so `today.ts`'s triage block, `GET /api/contacts?type=`, and
`audienceResolution` read the byTypeStatus partition exactly as before; the
`status` narrowing is a new OPTION the reader passes, not a change to the shared
read. `create`/`createIfAbsent`/`setFlag`/`clearFlag`/`softDelete`/`restore` do
not touch `type` or `status` (except finding 6's omission on `create`).

---

## SUMMARY

Six findings: two HIGH (both cross-layer - the server's design record asserts a
property the dashboard removes, in two different ways), one MED (a cursor whose
two halves are never checked against each other), three LOW (a stale design
record in the shared fake, a dead-and-dangerous fallback in it, and an invariant
enforced at one mutation surface but not its sibling).

The write guard's blast radius is **nil** - I enumerated all nine callers and
none can now throw. The deleted feature's compensating surface is **proven** end
to end, including the link target. The response-contract sweep is **clean**
across the hook, the perf harness's exact query tuples, the e2e specs and the
absence of any alerting on the removed log fields. The test-helper change
weakens **no** existing pin.
