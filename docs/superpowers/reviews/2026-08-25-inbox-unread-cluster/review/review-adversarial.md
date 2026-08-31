# Adversarial review - feat/inbox-unread-cluster (Unknown tab, contact-side read)

Reviewer: fresh-eyes adversarial pass, READ-ONLY. Nothing in the repo was
modified. Evidence was produced with a throwaway tsx probe outside the repo
(`scratchpad/probe.ts`) plus a targeted vitest run of the four new suites
(34/34 green) and `npm run typecheck` (clean).

Scope swept for unintended consequences (item 5 of the brief):

- every consumer of `GET /api/inbox` - `dashboard/src/routes/inbox/useInbox.ts`,
  `Inbox.tsx`, `e2e/performance/routes.ts` (`inbox-unknown` row + its terminal
  contract), `e2e/performance/cli.test.ts`, `app/src/lib/inboxDiagnostics.ts`
  (the `unknown-page` profiler case), `app/test/performanceSeed.integration.test.ts`;
- every reader/writer of the `(type='unknown')` byTypeStatus partition -
  `today.ts` triage block, `routes/contacts.ts` (`GET /api/contacts?type=`,
  create, PATCH triage), `services/contactCapture.ts`, `services/groupMembers.ts`,
  `services/groupConvert.ts`, `lib/seed/cast.ts`, `lib/seed/performance.ts`,
  `lib/import/apply.ts`;
- every caller of the changed functions - `collectUnreadRows` (badge
  `countUnreadRows`, the unread branch, now the unknown branch), `buildContactRow`,
  `roleFromContact`, `dropped()`;
- both fakes that mirror `contactsRepo.listByType`;
- the module-scope rate-limited WARN sinks in `lib/unreadFeed.ts` that the new
  caller now shares with the badge.

**No BLOCKING findings.** **No security findings**: every added log line carries
ids and counts only (`contactId`, `pages`, `kept`, `collected`, `scanned`,
`shown`, `assembled`, `limit`, `queueContacts`, `queuePages`, `sweepScanned`) -
no phone, email or name is added to any log. No authorization surface moved; the
new branch adds no new input that reaches a query (`filter=unknown` now rejects
every cursor before decoding, which is strictly narrower than before).

---

## 1. HIGH - the triage partition is ordered by `status`, so dropping the status narrowing makes the cap starve `needs_review`

**Where:** `app/src/lib/unknownQueue.ts:25-28` (the "NOT COPIED - status" ruling),
`app/src/lib/unknownQueue.ts:48,56` (the budget and the cap),
`app/src/lib/unknownQueue.ts:92-96` (the "ARBITRARY with respect to recency" doc),
`app/src/routes/inbox.ts:1717-1727` (the same claim at the caller).

**What is wrong.** `byTypeStatus` is `(hash: type, range: status)`
(`app/src/lib/tables.ts:90-93`) and `contactsRepo.listByType`
(`app/src/repos/contactsRepo.ts:986-1026`) sets no `ScanIndexForward`, so the
Query returns the partition **ascending by `status`**. For `type='unknown'` the
only two legal statuses are `needs_review` and `active`
(`NON_TENANT_STATUSES`, `lib/statusModel.ts:194`), and `'active' < 'needs_review'`
lexicographically. Every `active` unknown therefore sorts **ahead of every
`needs_review` unknown**.

Class f deliberately removed the `status: 'needs_review'` narrowing, so the
collector walks that ordered partition and cuts it with `UNKNOWN_QUEUE_MAX_ROWS`
(200) and `UNKNOWN_QUEUE_MAX_PAGES * UNKNOWN_QUEUE_PAGE_SIZE` (1000). The cut is
therefore **not** "arbitrary with respect to recency" as both the result doc and
the route comment say - it is deterministic and adversarially ordered: it keeps
the already-reviewed-but-not-retyped rows and discards the front door.

**Concrete failure scenario.**
- 200 or more live `(unknown, active)` contacts with an open thread -> the cap is
  filled entirely from the `active` block and **no `needs_review` contact can ever
  appear on the Unknown tab**, no matter how recent its inbound.
- 1000 or more `(unknown, active)` rows of any kind (live or soft-deleted) ahead
  of the `needs_review` block -> the page budget expires before a single
  `needs_review` row is read; the tab renders the ordinary "No unknown numbers"
  empty state (see finding 5) with only a server WARN behind it.

Because intra-partition order is stable, the same rows come back on every render
- exactly the "loud problem turned silent" pathology `today.ts:843-860` documents
and its fill loop was written for, reintroduced one layer out.

**Evidence.** Probe A (throwaway, `scratchpad/probe.ts`), driving the real
`aggregateInbox` with the branch's own `unknownQueueMaxRows` seam and a seed
pre-sorted the way DynamoDB returns the partition:

```
partition order DynamoDB returns: c-active-0(active), c-active-1(active),
  c-active-2(active), c-review-0(needs_review), c-review-1, c-review-2
rows shown: c-active-2, c-active-1, c-active-0
needs_review rows shown: 0
```

The three `needs_review` contacts were the NEWEST activity in that fixture and
were still invisible. Note the perf seed already builds this shape at scale -
`lib/seed/performance.ts:547-553` alternates unknown statuses `needs_review` /
`active`.

**Suggested direction.** Either query the two statuses explicitly and interleave
(two bounded Queries, `needs_review` first), or keep the single Query but make
the cut status-aware rather than positional. If neither, the doc at
`unknownQueue.ts:92-96` and `inbox.ts:1717-1727` must stop saying "arbitrary" and
say "status-ordered, so `needs_review` is cut first" - the word "arbitrary" is
what would stop the next reader from looking.

---

## 2. MED - the "live type re-check" cannot fire, and two comments tell a log reader otherwise

**Where:** `app/src/routes/inbox.ts:1584-1595` (the guard and its comment),
`app/src/routes/inbox.ts:955-962` (the "FOR THE LOG READER" note),
`app/test/inboxUnknownTab.test.ts` - "the live type re-check drops a stale-index
row that no longer renders as unknown".

**What is wrong.** `contact` here is the item `listByType('unknown')` returned.
`type` is the GSI **hash key**, so every item the Query can return carries
`type === 'unknown'` by construction, and `roleFromContact(contact)` reads that
same attribute off that same image. The guard is therefore unreachable in
production and `unknownQueueRetyped` can never appear on a real log line.

It also does not do what the comment says it does. A retype race leaves the OLD
index entry under `type='unknown'` until the GSI catches up, and that entry's
projected `type` attribute is stale in lockstep with its key - i.e. it still
reads `unknown`. So the one case the comment names ("it can only fire on a stale
index image") is precisely the case it passes.

The knock-on is the log-reader note at `:955-962`, which tells whoever is reading
an assembled line that the dead `unknownFilterRole` rejections "now happen as
`unknownQueueRetyped` on the unknown branch". They do not happen at all. What
actually replaced `unknownFilterRole` is the partition Query itself, which
rejects non-unknown contacts silently and by construction, with no counter.

**Test that cannot fail.** The only probe exercising this arm supplies
`listByTypeOverride: () => ({ items: [{ contactId: 'c-retyped', type: 'tenant' }] })`
- an item shape no `listByType('unknown')` call can produce. It pins the guard
against a fixture that bypasses the very partition semantics the branch built a
faithful fake for.

**Evidence.** Probe B: over a seed containing tenant / team_member / landlord /
two unknowns, both `listByTypeFromContacts(seed,'unknown')` and
`collectUnknownTriageQueue` return `types: unknown` only, and
`items.filter(c => c.type !== 'unknown').length === 0`. The real repo enforces
the same thing with `KeyConditionExpression: '#t = :t'`.

**Suggested direction.** Either make it a real check (re-read the contact with
`getById` before emitting - which costs one read per row and is probably not
worth it), or keep the no-op guard but rewrite both comments to say what is true:
"unreachable on a real partition read; kept as a belt if a future caller ever
hands this loop contacts from somewhere else", and delete the claim that
`unknownQueueRetyped` is where the old rejections went.

---

## 3. MED - "triage retypes the contact out of the partition" is false for a reachable triage path, and it is the justification for shipping no cursor

**Where:** `app/src/lib/unknownQueue.ts:28`, `app/src/routes/inbox.ts:1731-1738`,
`docs/issues/inbox-filter-tabs-full-walk.md` (the "WINDOW cut" bullet).

**What is wrong.** `PATCH /api/contacts/:id` explicitly supports a **status-only**
triage: `routes/contacts.ts:1414-1424` handles `'status' in patch && !('type' in patch)`
and validates it against `statusAllowlistFor(stored.type)`, which for `unknown`
is `needs_review | active`. The dashboard edit form reaches it
(`ContactEditForm.tsx:243-249` sends `patch.status` for non-tenants). After such a
write the contact is `(unknown, active)`: it leaves Today's triage block (which
narrows on `needs_review`, `today.ts:866`) but it **never leaves the Inbox
Unknown queue**, because the queue is keyed on `type` alone - and class f
explicitly admits `(unknown, active)` as a triage row.

That matters beyond the row itself: the branch ships `nextCursor: null` with no
Load-more, and the stated reason the window cut is acceptable is that "triage
drains the queue newest-first, so the remainder becomes reachable as rows are
retyped away". For every contact triaged by status rather than by type, the queue
does not drain, and rows past `limit` (30 from the dashboard) are unreachable by
any affordance.

**Evidence.** Probe C: an `(unknown, active)` contact with one open thread renders
as a triage row (`rows: c-reviewed`). Combined with finding 1, this population is
also the one the partition returns FIRST.

**Suggested direction.** Decide whether "reviewed but untyped" is a triage row. If
it is not, narrow the queue read or filter it after the read. If it is, drop the
"triage retypes the contact out of the partition" claim from the module header and
re-argue the no-cursor decision without it.

---

## 4. MED - "pays per row RETURNED" is false: hydration happens per row COLLECTED, before the window cut

**Where:** `app/src/routes/inbox.ts:1519-1523` (the cost claim),
`app/src/routes/inbox.ts:1583-1617` (the hydration loop),
`app/src/routes/inbox.ts:1739` (the window cut, after all hydration).

**What is wrong.** The branch's cost story - and the number the issue registry now
carries - is "one Query, pays per row returned". The code pays per row
**collected**: every one of up to `UNKNOWN_QUEUE_MAX_ROWS` (200) queue contacts
gets `resolveOpenThreads` (which is `conversationsForContact`: one
`findByParticipantPhone` per phone plus one `findByParticipantEmail` per email,
`lib/contactThreads.ts:44-51`) and then `buildContactRow`, which issues a
`listByConversation` for the preview. Only afterwards does `slice(0, limit)` throw
away everything past 30.

**Concrete failure scenario.** A queue at the cap with the dashboard's `limit=30`:
roughly 200 participant-key Queries plus 200 message reads, all `await`ed
sequentially inside one request, to render 30 rows - about 400 serial round trips
whose results are 85% discarded. The sweep (finding 7/8) is on top of that.

**Suggested direction.** The thread resolution genuinely is needed before the sort
(it produces `lastActivityAt`). The presentation hydration is not: move
`latestMessageOf` and `placementLabel` out of `buildContactRow` for this branch,
or window first and hydrate the survivors. Either way, correct the claim at
`:1523`.

---

## 5. MED - the collector-truncation residual is not in the RESOLVED record, and it is the more likely one

**Where:** `app/src/lib/unknownQueue.ts:165-172`, `app/src/routes/inbox.ts:1766-1771`,
`docs/issues/inbox-filter-tabs-full-walk.md` ("The capped-sweep residual").

**What is wrong.** `collectUnknownTriageQueue` can legitimately return
`{ contacts: [], truncated: true }` - the branch's own test "the page budget bounds
a partition made entirely of residue" pins exactly that. On that result the
unknown branch assembles zero rows and, by requirement 5, must NOT set the wire
`truncated` flag - so the dashboard renders "No unknown numbers" over a triage
queue that has rows in it. The only signals are a server WARN and `queueTruncated`
on the assembled line.

The RESOLVED block in the issue registry enumerates the **capped-sweep** residual
under exactly this heading and says the WARN plus `resurfaceCapped` /
`resurfaceTruncated` "are therefore the ONLY signals that it happened" - but it
does not name the collector's own page-budget residual, which is the more likely
of the two: the module header itself argues that soft-deleted unknowns
"accumulate in this partition FOREVER", and finding 1 shows the `active` block can
consume the whole budget on its own.

**Concrete failure scenario.** 1000 rows of soft-deleted or `active` residue ahead
of the live `needs_review` block -> 10 Queries, zero kept rows, "No unknown
numbers" on screen, a live untriaged queue behind it, and no client-visible
signal.

**Suggested direction.** No code change is forced (requirement 5 genuinely blocks
the wire flag) - but the RESOLVED block should list this residual alongside the
sweep one, with the same reopen trigger, since a reader who only knows about the
sweep will not think to check `queueTruncated`.

---

## 6. MED - two `listByType` fakes with incompatible semantics now back the same route branch

**Where:** `app/test/helpers/contactsPartitionFake.ts` (new) vs
`app/test/helpers/twilioWebhookHarness.ts:1684-1711` (existing); consumer
`app/test/inboxApi.test.ts` (the new `filter=unknown` assertions and the new
400-on-cursor test).

**What is wrong.** The new fake models three DynamoDB properties the branch
depends on: the **sparse index** (`status === undefined` -> not indexed),
**filter after Limit** (so a page of residue is empty WITH a LEK), and
**LEK means "Limit reached"**. The webhook-harness fake models **none** of them:
it applies the deleted filter before the slice, returns a LEK on
"items remaining", and returns status-less contacts. The new file's header
acknowledges the split and says "new tests use this one" - but the new
route-level `filter=unknown` test in `inboxApi.test.ts` runs through the harness
fake.

**Consequences:**
- The route-level test cannot detect a sparse-index regression. A `type: 'unknown'`
  contact with no `status` is a row there and is invisible in production. The
  branch had to add `status: 'needs_review'` to two existing fixtures
  (`inboxFeed.test.ts`) for exactly this reason; the harness path is the one place
  that would not have gone red.
- The fill loop and the "one extra empty page" LEK behaviour are unreachable
  through the harness, so `queuePages` / call-count reasoning there is
  one round trip short of production.

**Also, and this is what makes finding 1 untestable:** the new fake does not model
the partition's **range-key sort**. It returns items in seed-array order, so no
test in the suite can express "the `active` block precedes the `needs_review`
block". The header claims the helper "Models contactsRepo.listByType the way
DynamoDB executes it" and lists five rules; the sort is the missing sixth.

**Suggested direction.** Sort the partition by `(status, contactId)` in
`contactsPartitionFake.ts` and add the missing rule to its header; point the
`inboxApi.test.ts` unknown assertions at the shared helper, or state in the
harness fake's comment that it must not be used for `filter=unknown`.

---

## 7. MED - the class (c) team_member ruling is enforced for tab membership only; the wire and the chip still say "Needs triage"

**Where:** `app/src/routes/inbox.ts:422-429` (`roleFromContact`),
`app/src/routes/inbox.ts:873` (`needsTriage: role === 'unknown'`),
`dashboard/src/routes/inbox/InboxRow.tsx:106`,
`docs/issues/inbox-filter-tabs-full-walk.md` ("The class (c) ruling").

**What is wrong.** The registry now records the latent bug as fixed: "an INTERNAL
STAFF member's 1:1 thread sits in the operator's triage queue ... The contact-side
redesign fixes it by construction". It fixes the Unknown TAB. It does not fix
`needsTriage`: `roleFromContact` still falls `team_member` through to `'unknown'`,
so a team_member's row on the **All** and **Unread** tabs still ships
`role: 'unknown'` and `needsTriage: true`, and the dashboard still renders the
"Needs triage" chip on it. The "one-line fix" the issue said would be needed "if
that design does not land" is still needed.

Impact today is zero rows (measured), so this is a record-accuracy and
half-fixed-mechanism finding rather than a live defect.

**Nit in the same block:** the newly added reference `roleFromContact
(inbox.ts:396-403)` at `docs/issues/inbox-filter-tabs-full-walk.md:251` is off -
the function is at `inbox.ts:422-429` on this branch.

**Suggested direction.** Either add `team_member` to `roleFromContact` as its own
role (wire change - check `dashboard/src/api/types.ts:2848`), or narrow
`needsTriage` to `contact.type === 'unknown'` and leave `role` alone. Whichever,
correct the RESOLVED block so it does not read as fully closed.

---

## 8. LOW - the Unknown tab now competes with the badge for one process-wide 5-minute WARN window

**Where:** `app/src/routes/inbox.ts:1645-1661`, `app/src/lib/unreadFeed.ts:136-156`.

**What is wrong.** `warnWalkScanned` and `warnProbeBurst` are MODULE-scope
rate-limited sinks shared by the badge, the Unread page, and now the Unknown tab.
The unknown branch runs an unconditional `collectUnreadRows` at
`budget = UNREAD_WALK_LIMIT` (2000) with no candidate cap, so past 500 visible
unread items it trips `unread_walk_scan_tripwire` on **every** Unknown page load -
and `useInbox` refetches the first page on every debounced `conversation.updated`
while the operator sits on the tab (`useInbox.ts:366-376`). Each such firing
consumes the shared 5-minute window, suppressing the badge's and the Unread page's
own tripwire lines for that period.

The code comment at `:1655-1660` notes the shared limiter, but only to explain why
one request emits one line - not that a new, high-frequency, always-maximal caller
now dominates a window two other surfaces depend on.

**Suggested direction.** Give this branch its own limiter instance, or key the
limiter by surface, so an Unknown-tab tripwire cannot mask a badge tripwire.

---

## 9. LOW - the resurfacing sweep is paid unconditionally, including when there are zero soft-deleted unknowns

**Where:** `app/src/routes/inbox.ts:1645-1649`.

The sweep exists solely to find class (d) rows - soft-deleted unknown contacts
with a fresh post-deletion inbound. In dev and prod that population is measured at
zero. The sweep nevertheless walks up to 2000 raw byUnread items and issues one
`findByPhone` per VISIBLE item on every Unknown page load, then discards every
candidate that is not both a queue type and soft-deleted
(`inbox.ts:1662-1676`). The accepted-cost note at `:1631-1644` prices this
honestly, but does not ask whether the cost can be skipped when it can buy
nothing.

**Suggested direction.** A bounded `listByType('unknown', { deleted: true, ... })`
probe (the same fill-loop shape the collector already has) answers "are there any
soft-deleted unknowns at all" in a handful of Queries and lets the common case
skip the whole O(visible unread) sweep. Worth measuring before building.

---

## 10. LOW - the measurement script still presents two now-retired modes as live

**Where:** `app/scripts/measure-unread-contact-coverage.ts:309-326`
(`--audit-unknown-page`) and `:723+` (`--audit-tab-vs-partition`).

`--audit-unknown-page` still documents itself as "THE measurement for
`inbox-filter-tabs-full-walk`" and "replicates the pager: same partition, same
order, same per-conversation contact resolution, same break condition".
`--audit-tab-vs-partition` still walks the open partition and labels the result
"tab would show (by contact)". After this branch, `filter=unknown` does neither of
those things - both modes now measure a read the application no longer performs,
while reading as the current instrument. The branch edited this same file for
measurement accuracy (`--no-status-narrow`), which is what makes the omission
notable.

**Also (same file, minor):** under `--no-status-narrow` the printed line
`status mismatch <n>  (should be 0 - the range key is the status)` is emitted with
a counter that is never incremented (`statusMismatch` is guarded on `narrow`), so
it reads as a passed check while carrying no information.

**Suggested direction.** Prefix both docblocks with "HISTORICAL - replicates the
pre-2026-08-25 read", or suppress the status-mismatch line when not narrowing.

---

## Things I checked and did NOT find a defect in

- **Cursor namespacing.** `filter=unknown` now rejects every cursor before any
  decode; `decodeCursor` is reached only by `all`; `decodeUnreadCursor`'s comment
  about which filters can land there is accurate. Pinned by two tests.
- **`capped` masking `truncated`.** `inbox.ts:1701` reads both flags, which is
  correct against `CollectResult`'s derivation (`unreadFeed.ts:708-709`), and the
  probe that guards it is real (it makes the cap the stop with a shrunk seam).
- **Requirement 4 discrimination.** `resolveOpenThreads` genuinely separates
  "threw" (`undefined`, own counter, own WARN) from "no open thread" (`[]`), and
  the test would go red if it were routed through the best-effort
  `contactConversations` seam.
- **Dedupe between the two sources.** Partition rows are live-only (FilterExpression
  `attribute_not_exists(deleted_at)`), sweep rows are deleted-only, plus the
  `emitted` belt - the two sets are disjoint under every interleaving I could
  construct, including a delete landing between the two reads.
- **Group / relay merge.** The removal of the `filter !== 'unknown'` term is forced
  by narrowing (`filter` really is narrowed to `'all'` at that point - typecheck
  confirms the file compiles), and the early return is an adequate replacement.
- **`status`-less unknown contacts in production.** Every write path that mints a
  `type: 'unknown'` contact sets a status (`contactCapture.ts:79-80`,
  `groupMembers.ts:111-112`, `groupConvert.ts:339-340`, `routes/contacts.ts:881-884`,
  both seeds, the importer). `contactsRepo.update(id, { status: null })` would drop
  one out of the sparse index; I found no caller, which matches the issue's own
  wording.
- **e2e isolation.** `unknown-caller-triage.spec.ts` reseeds in `beforeEach`, so the
  new empty-state assertion is not contaminated by the earlier test in the file.
- **Perf harness.** The `inbox-unknown` terminal contract is `(list OR empty text)`,
  so an empty or a populated tab both satisfy it; the endpoint contract tuple did
  not change (no cursor, same limit).
