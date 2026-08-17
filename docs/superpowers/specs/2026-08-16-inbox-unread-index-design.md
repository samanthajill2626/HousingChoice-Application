<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-08-17).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Inbox Unread Index - Design Spec (2026-08-16)

Status: APPROVED v6 (human gate 2026-08-16, with the close/delete reset ruling)
Branch: feat/inbox-unread-index (worktree W:/tmp/inbox-unread-index, cut from main @41627198)
Issue: docs/issues/inbox-unread-sse-full-walk.md (this spec is the "separate design" it calls for)
Related: docs/issues/inbox-filter-tabs-full-walk.md (unread half resolved here; unknown half stays open)
Design review: adjudications at .superpowers/design-review/adjudications.md

## 1. Problem

Two defects, one root cause:

1. READ AMPLIFICATION. Finding unread conversations requires walking every OPEN
   conversation because unread state is not queryable. Measured on the imported
   real dataset (610 open 1:1 conversations, ZERO unread - the zero-unread
   state; unread-heavy behavior is unmeasured): the nav badge request
   (`GET /api/inbox?filter=unread&limit=100`) made 1,840 serial repository
   calls (~20s median) before the early-rejection change
   (main @39c1aa41, see app/src/routes/inbox.ts:490), and still makes 1,230
   calls (~1.8s median) after it (figures from
   docs/issues/inbox-unread-sse-full-walk.md). The badge fires on every SPA
   boot and after every debounced `conversation.updated` SSE event on every
   connected dashboard, so inbound traffic multiplies this cost. The Unread
   page pays the same walk, and `filter=unread` additionally performs an
   accepted full group-partition walk (GROUP_UNREAD_WALK_LIMIT = 2000,
   app/src/routes/inbox.ts:181) whose own code comment says "time to
   materialize unread counts".

2. BADGE STALENESS. Opening an unread thread updates the Inbox page's own list
   optimistically (useInbox.ts:261-297) but the nav badge has no optimistic
   path: it waits for server commit -> SSE -> 300ms debounce -> a full unread
   walk. The user sees the badge lag ~2s behind the action.

## 2. Goals

- G1: Unread discovery cost proportional to indexed unread conversations, not
  open conversations. Empty unread state = O(1) queries. (Invisible-resident
  accrual is eliminated by the close/delete resets - section 4.2 - leaving
  only transient races.)
- G2: A dedicated cheap badge-count endpoint; the badge never depends on the
  row-list response shape or its page limit.
- G3: The nav badge reflects the user's own Inbox mark-read actions instantly
  (optimistic), with the server as reconciling authority.
- G4: The Unread page uses the same index; no per-open-conversation walks.
- G5: Today's unread-driven sections (needs_you_now unknown triage, unreplied)
  select from ALL unread conversations instead of unread-within-the-first-100
  -open (a silent-miss fix). Today's total query cost does not decrease (the
  open-partition read stays for the relay opt-out scan); the win is
  correctness, not cost.
- G6: Row-level content of Unread feed rows is preserved (same fields, same
  values for the same data). Page COMPOSITION changes deliberately - section
  4.5 declares the change.

## 3. Non-goals

- The `unknown` filter walk (needs contact resolution to decide triage; stays
  as-is, tracked by inbox-filter-tabs-full-walk).
- Latest-message denormalization onto the conversation record (decided against:
  the All page and the bounded Unread page hydrate at most one page of
  latest-messages per request; no duplicated message data).
- The unmatched-email badge (already server-computed; no optimistic layer now).
- Optimistic badge decrements from the contact/conversation AUTO-mark paths
  (useMarkContactRead and the conversation-detail mount marks fire blind,
  with no unread knowledge - they stay reconcile-only). The tour/placement
  comms tabs ARE wired (section 4.7) - the close-reset ruling removed the
  closed-group hazard that had excluded them.
- Contacts BatchGet amplification sweep - filed as
  docs/issues/contacts-batchget-amplified-reads.md (the agreed next mission).
- Voice-inbound unread increments (separate open issues; the index picks them
  up automatically if voice ever increments through the repo primitive).
- Membership-inversion read models and the Today due/attention read model.
- Multi-operator cross-client optimism (another operator's mark-read reaches
  us via SSE reconcile, as today).

## 4. Design

### 4.1 The sparse index

New sparse GSI `byUnread` on the conversations table:

- HASH: `unread_flag` (S) - present ONLY while `unread_count > 0`, always the
  constant string `'unread'`.
- RANGE: `last_activity_at` (S) - already required on every conversation.
- Projection: ALL (module contract - tables.ts:60,
  infra/modules/dynamodb/main.tf:56).
- Sparse: a GSI indexes an item only when BOTH key attributes are present;
  `last_activity_at` always exists, so `unread_flag` is the single controlled
  attribute and REMOVEing it retires the row.

Schema lands in app/src/lib/tables.ts (conversations block, :118-174) per the
byRelayStatus precedent (commit 996de828); `npm run gen:tables` regenerates
both tfvars; the exact-array GSI assertions in app/test/tables.test.ts:164-186
and app/test/genTables.test.ts:182-188 update in the same commit.

`ConversationItem` gains `unread_flag?: 'unread'`
(app/src/repos/conversationsRepo.ts, next to `unread_count?: number` at :162)
so seed fixtures typecheck. WIRE EXPOSURE (corrected against source during the
build - this paragraph originally named ONE response; there are TEN): the
attribute deliberately appears on no wire shape we CONSTRUCT (SSE payload and
conversation summaries project explicit fields - events.ts:100, api.ts:416),
but it rides every response that returns a RAW `ConversationItem`, and there
are ten of those:

- api.ts x2 - `GET /api/conversations/:conversationId` and
  `POST /api/conversations/:conversationId/read`;
- contacts.ts x3 - the phone create-or-get conversation route (both its
  name-denorm and plain branches) and the email create-or-get route;
- relayGroups.ts x5 - the close/reopen route (its already-closed and
  already-open idempotent no-op branches plus the normal transition) and the
  close-nag defer route (its closed-group no-op and its refreshed read).

Every one is authed and internal, so the original acceptance (internal client;
ignores unknown fields) holds for all ten unchanged. This is a precision fix,
not a design change. Located by route rather than by line because the exact
lines move with every slice.

WHY A CONSTANT HASH, NOT A STATUS-ENCODED ONE: encoding status into the key
(like relay_status = 'relay_group#<status>') would obligate three more writers
(setRelayStatus, assignPoolNumberAndOpen, convertRelayGroupToGroupText) to
maintain the attribute, recreating the bug class documented at
conversationsRepo.ts:2245-2248 and lib/import/apply.ts:1137-1145. With a
constant hash, ONLY the two unread primitives touch the attribute; status
transitions leave it alone and READERS filter by the projected live
status/type. The single-partition GSI is not a hot-partition concern at this
scale (at most hundreds of unread rows; one write per inbound message).

### 4.2 The invariant and its complete writer surface

INVARIANT: `unread_flag` exists on a conversation item iff `unread_count > 0`
is intended, maintained atomically with the counter.

The runtime zero-crossing surface is exactly two repo methods (research-
verified; reconfirmed by both round-1 reviewers). Both change in place:

- `incrementUnread` (conversationsRepo.ts:1490-1502):
  `ADD unread_count :one SET unread_flag = :flag` - one UpdateCommand. Every
  increment idempotently (re)sets the flag; no `=== 1` crossing detection is
  needed or safe under concurrency.
- `resetUnread` (conversationsRepo.ts:1504-1520):
  `SET unread_count = :zero REMOVE unread_flag` - one UpdateCommand,
  unconditional and idempotent. `unread_count` stays SET to 0 (readers and the
  SSE payload coerce absent -> 0; existing shapes preserved).

Both fields ride ONE UpdateExpression in each primitive, so the documented
last-write-wins race between reset and an in-flight increment
(conversationsRepo.ts:1505-1507) keeps flag and count consistent with each
other regardless of ordering. No transaction needed.

Non-runtime writers:

- SEEDS (whole-item PutItem, clobber-by-design): every fixture row carries
  `unread_flag: 'unread'` IFF that row's `unread_count > 0`. Audit: only
  app/src/lib/seed/performance.ts:820 and :889 seed nonzero unread, and both
  do so CONDITIONALLY per row - the flag is written under the same per-row
  condition, never unconditionally. lean.ts/cast.ts/live.ts seed 0 or omit -
  no flag. A guard test walks the fixture arrays and asserts flag iff
  count > 0. The performance seed's invariant assertions
  (performance.ts:1069-1115 region) gain the analogous unread check.
- IMPORT (lib/import/apply.ts upsertConversation): never writes unread_count;
  the new keys are not derived from status/type; NO new obligation. Import
  retract deletes rows (apply.ts:712-719); deletes drop GSI entries.
- BACKFILL: section 7.
- Status/lifecycle transitions: touchLastActivity, assignPoolNumberAndOpen,
  convertRelayGroupToGroupText, rebindOwner, roster and close-nag writers
  touch neither unread nor the flag; NO changes. `setRelayStatus` is the
  EXCEPTION by human ruling - closing zeroes unread + removes the flag in
  the same write (below).
- Contact soft-delete now fans out resetUnread over the contact's threads
  (below); restore does not touch conversation rows.

ACCRUAL ELIMINATED BY HUMAN RULING (spec gate, 2026-08-16): the review
rounds had ACCEPTED two invisible-resident accrual classes (relay groups
closed while unread; unread threads of soft-deleted contacts) because
resetting them changed product behavior. The human ruled the OPPOSITE at
the gate: closing a relay group and soft-deleting a contact now RESET
unread. Two new reset surfaces, both maintaining the flag invariant:

1. RELAY CLOSE resets structurally: `setRelayStatus` to 'closed'
   (conversationsRepo.ts:1786-1819; sole close caller
   routes/relayGroups.ts:453) adds `SET unread_count = :zero REMOVE
   unread_flag` to ITS OWN UpdateExpression when the target status is
   'closed' - one atomic write, and every future close path inherits it.
   Reopen (relayGroups.ts:516 -> 'open') does not touch unread. DECLARED
   PRODUCT CHANGE (human-approved): a reopened relay group returns with
   unread 0, not its pre-close count. The close route's existing
   conversation.updated emit (relayGroups.ts:530) reconciles clients.
2. CONTACT SOFT-DELETE resets via fan-out: the delete handler (the same
   place that runs the delete/restore presence fan-out over
   conversationsForContact, contacts.ts:1864 region) calls `resetUnread`
   for each of the contact's threads with unread > 0 - the exact shape of
   POST /api/inbox/:contactId/read's fan-out (inbox.ts:997-1015),
   ConditionalCheckFailedException swallowed, existing emits reconcile.
   DECLARED PRODUCT CHANGE (human-approved): a restored contact returns
   with unread 0. RESURFACING IS UNAFFECTED: the resurfacing rule requires
   a POST-deletion inbound (inbox.ts:537-576), and that inbound itself
   re-increments unread - so every thread that could resurface still does;
   only pre-deletion unread (which never resurfaced anyway) stops counting.

   AMENDED ON-BRANCH (2026-08-16, review fix wave): the fan-out resets EVERY
   thread `conversationsForContact` returns, not only those the read reports as
   unread. The thread list comes from `byParticipantPhone`/`byParticipantEmail`,
   which section 6 declares lag INDEPENDENTLY of `byUnread`, so a stale image
   reporting 0 made the reset skip a genuinely-unread thread permanently -
   nothing re-runs this fan-out for an already-deleted contact. `resetUnread` is
   idempotent, so the cost is one extra write per already-read thread.

LEGACY residents (rows closed/deleted BEFORE this ships) are cleaned by the
backfill (section 7.2) applying the same two rules one-time. Residual
invisible-resident exposure drops to transient races (a close/delete racing
an inbound); the walk budget, scanned-items WARN, and deleted-probe WARN
are KEPT as regression sentinels, not standing mitigations.

Pointer/claim partitions (`phone#`, `email#`, `token#`) never carry
unread_count and never enter the index (conversationsRepo.ts:1111-1119).

### 4.3 The server read layers

New module `app/src/lib/unreadFeed.ts` with TWO exports, layered so every
unread consumer shares ONE set of visibility rules.

LAYER 1 - `iterateUnreadConversations(deps, opts)`: conversation-level,
PULL-BASED (an async iterator; round-3 finding - a materialized batch made
every consumer scan the whole index before its own cap applied, breaking the
cost model and colliding two meanings of "exhausted"):

1. Lazily Queries `byUnread` newest-first (ScanIndexForward false) in
   internal pages (Query Limit ~100), fetching the NEXT page only when the
   consumer keeps pulling. Options: `startAfter` (a synthesized
   ExclusiveStartKey `{ unread_flag: 'unread', last_activity_at,
   conversationId }` - the GSI's full key shape for this hash-only-base-key
   table) and `budget` (raw items this iteration may scan; the CALLER
   threads one budget across a whole request).
2. Applies VISIBILITY RULES per item, on projected attributes, yielding only
   passers but COUNTING every scanned item against the budget:
   - skip items without a positive `unread_count` (defends WITHIN-IMAGE
     inconsistency only - un-backfilled rows, a hypothetical broken writer -
     NOT GSI replication lag; section 6);
   - `relay_group`: keep iff status `open` or `connecting` (closed invisible,
     as today - inbox.ts:823);
   - `group_text`: keep iff status `group_open`;
   - everything else (the 1:1 bucket, matching today's NEGATIVE filter at
     inbox.ts:466 - including any legacy row with no `type`): keep iff status
     `open`.
3. Exposes, at any stop point: `scanPosition` (the tuple of the last RAW
   item scanned - always advances through filtered runs, so they cannot
   dead-end the feed), `scanExhausted` (the underlying Query stream ended),
   and `scanned` (raw items consumed from the budget). Because the iterator is lazy, a consumer that stops
   pulling stops the scan - the walk does only the work its consumer needs.

RAW WALK BUDGET: UNREAD_WALK_LIMIT = 2000 scanned items per REQUEST (a
safety ceiling, not a per-call allowance - callers pass the remaining budget
through every iteration). With lazy pulling the ceiling is only ever
approached when invisible accrual dominates the index; the tripwire is
UNREAD_WALK_WARN = 500 scanned-per-request, logged through
lib/rateLimitedWarn.ts (this fires on the badge path - the app's
highest-frequency request - so an unthrottled WARN would flood exactly when
it matters).

Today (section 4.6) consumes layer 1 directly.

LAYER 2 - `collectUnreadRows(deps, opts)`: row-identity level, used by BOTH
the badge count and the Unread page so those two cannot diverge. Drives a
layer-1 iterator and stops pulling the moment `maxRows` candidates are
emitted - so the badge (maxRows=100) scans only as many raw items as it
takes to find 100 visible candidates, and the page (maxRows=limit) scans
proportionally to one page.

1. Walks layer-1 items newest-first, grouping into ROW CANDIDATES:
   - relay_group / group_text conversation -> its own candidate (keyed by
     conversationId);
   - 1:1 conversation -> resolve the contact (contacts.findByPhone then
     findByEmail - the rowForConversation order, inbox.ts:476-477). Resolved
     contact -> ONE candidate per contactId (first/newest index item is the
     candidate's representative; later items of the same contact merge
     silently, and contacts named by `opts.excludeContactIds` - the cursor's
     seen-set, below - are skipped entirely). No contact + phone ->
     unknown-number candidate keyed by phone. No contact + no phone
     (contactless email thread) -> skipped (parity with inbox.ts:489).
   - No unread sums are computed here (the page hydrates fresh ones; the
     badge needs none).
2. DELETED CONTACTS: a candidate whose contact isDeleted survives only under
   the resurfacing rule (some unread thread's newest message is an inbound
   with created_at > contact.deleted_at - inbox.ts:537-576), probed via
   messages.listByConversation(limit 1) per unread thread of deleted
   contacts, with NO `last_activity_at <= deleted_at` short-circuit. (A
   round-2 remedy added such a short-circuit; round 3
   showed that premise is false in this codebase - last_activity_at is the
   PROVIDER timestamp while created_at is OUR ingest clock, with a
   documented CLOCK CAVEAT at inbox.ts:558-563, and the append/touch gap
   can leave last_activity_at stale while a fresh post-deletion message
   exists, twilio.ts:2132-2134. The short-circuit is WITHDRAWN: the saved
   Query is not worth silently suppressing a genuine resurfacing. With the
   human-ruled delete-reset + backfill cleanup (4.2/7.2), the probed
   population is just the resurface-eligible threads - deleted contacts
   with post-deletion unread - each costing a contact resolution AND a
   message probe per request, tripwired by UNREAD_DELETED_PROBE_WARN.)
   AMENDED, fix wave 2 (post-gate change, conformance r2 finding 5): the
   probe is no longer UNCONDITIONAL, as this step said until now. It is
   bounded per REQUEST - see 4.4 PROBE BOUND - and the bound counts only
   WASTED probes, i.e. reads that found the thread still hidden. The round-3
   ruling it appears to touch is intact in the case that ruling was about: a
   probe is never skipped to save a Query on an ordinary walk, and a
   resurfacing is never suppressed by a heuristic short-circuit. What the
   bound does is refuse to keep PAYING once a request has proved, 26 reads
   running, that it is walking a wall of hidden residue - and it says so on
   the wire (`truncated`) instead of silently.
3. Emits candidates in index order up to `opts.maxRows`, then STOPS PULLING.
   Returns `{ candidates, scanPosition?, consumedAll, truncated, capped,
   remainingBudget }` (remainingBudget is what 4.5's loop threads into the
   next collect call):
   - `capped` = maxRows stopped emission;
   - `consumedAll` = the item SUPPLY ran out - the iterator's scan
     exhausted with every yielded item consumed into a candidate or
     merged/excluded. This is a CONSUMPTION fact, distinct from layer-1's
     scanExhausted (round-3 blocking finding: conflating them made every
     under-budget dataset return page one with a null cursor);
   - `truncated` = the walk stopped early without filling the cap or draining
     the supply: the request budget ran out, OR the deleted-probe bound did
     (AMENDED, A2 - the two are reported identically because the caller's
     answer is identical: the list is a FLOOR);
   - `scanPosition` = position after the last index item CONSUMED, so
     resumption re-scans nothing and skips nothing.

CURSOR AND SPLIT-PROOF PAGING (round-1 blocking finding, REDESIGNED in round
2 after its ordering-comparison guard was shown to rest on stale reads and
undocumented tie order):

- The page cursor is the base64url of
  `{ u: 1, a: <last_activity_at>, c: <conversationId>, s: [<contactId>...] }`:
  the layer-2 `scanPosition` plus the SEEN-SET `s` - every contactId emitted
  as a candidate on this and prior pages (carried forward cumulatively).
- Resume: the synthesized ExclusiveStartKey from (a, c) continues the index
  walk exactly after the last consumed item - an exact-position mechanism
  that needs NO assumption about DynamoDB's ordering of equal range values.
  Suppression of already-emitted contacts is pure set membership
  (`excludeContactIds = s`): no ordering comparison, no re-reading of the
  contact's threads, no staleness exposure, deterministic under timestamp
  ties. This restates today's one-row-per-contact guarantee
  (inbox.ts:522-527) exactly.
- The `u: 1` tag namespaces the cursor; decodeCursor/decodeGroupCursor gain
  the matching cross-filter rejection (unread cursor under another filter ->
  400, and vice versa - the group-cursor posture today).
- CURSOR SIZE (round-3 finding: the transport, not Node, is the binding
  constraint - CloudFront's URL limit is a fixed 8,192 bytes and fronts
  every deployed environment, so an oversized cursor fails in dev/prod but
  not locally, and useInbox's Load-more catch is deliberately silent):
  `s` grows by up to `limit` (30) contactIds (~47 bytes each as JSON array
  elements) per page. SEEN_SET_MAX = 100 ids, sized so the worst cursor
  (~4.7KB JSON -> ~6.3KB base64url) plus the rest of the request line stays
  inside CloudFront's 8,192-byte quota with margin. THE SERVER NEVER MINTS
  A CURSOR IT WOULD REJECT: when emitting the next cursor would push the
  seen-set past SEEN_SET_MAX, the page returns `nextCursor: null` AND sets
  `InboxPage.truncated` (round-4 finding: the depth cap must not be the
  one early-end path with no signal - see 4.5 step 3) - the feed ends at
  ~4 pages (120+ unread contact rows), which has no product meaning to
  exceed (the badge caps at 100, and triage is top-down: marking rows read
  is what reaches deeper unread). The 400 for an over-limit or malformed
  cursor remains only for tampered input. Hydration-dropped candidates do
  NOT stay in the seen-set (CORRECTED, review fix wave 1 - A3; the amended
  rule is stated at 4.5 step 1 and in section 12). The set records EMITTED
  contacts only, so a bulk mark-read race spends NO depth allowance on the
  rows it dropped, and the race's own SSE events trigger the reconcile
  refetch that resets paging from the top.
- CURSOR CONTENT (stated decision): the seen-set puts opaque contactIds in
  a GET query param, hence CloudFront access logs and any http.url
  telemetry attribute. contactIds already appear in request URLs today
  (e.g. POST /api/inbox/:contactId/read) and carry no PII by themselves;
  accepted, and noted for the existing telemetry-url-redaction workstream.
- Non-contact candidates need no seen-set: an unknown row's phone and a
  group/relay row's conversationId each map to exactly ONE index item, so
  they cannot straddle pages.

### 4.4 Badge endpoint

`GET /api/inbox/unread-count` ->
`{ unreadCount: number, capped: boolean, truncated: boolean }`

- `collectUnreadRows` with `maxRows = BADGE_COUNT_CAP = 100` and no cursor.
  Lazy layer 1 means the badge scans only as many raw index items as it
  takes to emit 100 candidates (or hit stream end / budget) - never the
  whole index.
- `capped` = the cap stopped counting (count is a floor at the cap).
  `truncated` = the request budget stopped scanning first (count is a floor
  for a different reason; pathological - see 4.3 budget sizing). The two
  are DISTINCT wire fields because the client treats them differently
  (4.7): a capped count is "99+" and must not be decremented; a truncated
  count is small and real-so-far and SHOULD still decrement.
- No hydration: no previews, placement labels, or latest-message reads
  (the deleted-contact resurfacing probe is a visibility rule - 4.3 step
  2 - and is the one message read the badge performs).
- COST: empty unread = 1 index query. N visible unread 1:1s = 1-2 index
  Query pages + N contact resolutions. PLUS the accrual classes (4.2),
  which are scanned through (budget) before/between visible items: each
  closed-unread relay group costs an index slot; each deleted-contact
  unread thread costs an index slot + a contact resolution + a message
  probe per request (the round-2 probe short-circuit is withdrawn - 4.3
  step 2), with the MESSAGE half bounded per request by the PROBE BOUND
  below and the CONTACT half unbounded by design. CORRECTED (fix wave 3,
  adversarial r3 finding 3): that contact half is O(SCANNED INDEX ITEMS),
  NOT O(visible unread) and not O(rows returned). A hidden deleted-contact
  thread PASSES `isUnreadVisible` - the contact lookup is how the collector
  discovers the contact is deleted at all - so a 2,000-thread wall of hidden
  residue costs ~2,000 serial contact resolutions to answer ZERO, on every
  badge request. Nothing bounds it in v1 (bounding it would re-create the
  walk-stop class round 2 blocked: a bound past which live rows go
  uncounted); the scanned-items WARN fires at 500, long before that, and
  docs/issues/contacts-batchget-amplified-reads.md is the remedy. This endpoint is the
  highest-frequency call in the app (every
  SPA boot + every debounced conversation event per connected dashboard).
  TWO rate-limited tripwires, because the two costs grow independently
  (round-4 finding: the scanned-items WARN alone misses the probe cost -
  tens of deleted residents degrade this endpoint long before 500 scanned
  items): the scanned-items WARN (4.3, threshold 500) and a
  DELETED-RESIDENT PROBE WARN when a single request WASTES more than
  UNREAD_DELETED_PROBE_WARN = 25 probes-plus-skips. AMENDED (fix wave 3,
  conformance r3 finding 1): the threshold counts WASTED + SKIPPED, the same
  quantity the PROBE BOUND below counts, never probes ATTEMPTED - otherwise
  it fires on the resurfacing world that bullet declares legitimate.
  Productive probes stay on the payload; they cannot trip the alarm. Both
  through lib/rateLimitedWarn.ts; both are the signal to revisit accrual.
- PROBE BOUND (AMENDED, A2; REWRITTEN in fix wave 2, adversarial r2 findings
  1-3 and conformance r2 finding 1.1): the probe WARN is backed by a HARD
  BOUND of UNREAD_DELETED_PROBE_LIMIT = UNREAD_DELETED_PROBE_WARN + 1
  WASTED probes per REQUEST. Three parts, each load-bearing:
  - WASTED ONLY. A wasted probe is one that found the thread still hidden. A
    probe that RESURFACES a contact emits a row, and rows are already bounded
    by `maxRows`, so productive probes never spend the bound. (Fix wave 1
    counted every probe, which floored the badge at 26 in the ordinary world
    of 27+ resurfaced deleted contacts - not at BADGE_COUNT_CAP, and through
    `truncated`, which v1's client does not render.)
  - PER REQUEST, not per collect: the page's fill loop threads the running
    wasted total into each collect the way it threads `remainingBudget`.
  - IT BOUNDS THE PROBES, NEVER THE WALK. Past the bound a deleted-contact
    thread is treated as hidden WITHOUT a read; live contacts, unknowns,
    groups and relay threads keep being counted and emitted. (Fix wave 1
    stopped the walk, which turned 27 hidden threads ahead of live unread
    into a page of ZERO rows with a NULL cursor - the inbox error state, with
    a Retry that reproduces itself.)
  Consequence, declared - AMENDED (fix wave 3, adversarial r3 finding 2):
  skipped threads do NOT by themselves make the result `truncated`. A DRAINED
  stream is a NATURAL end regardless of how many deleted-contact threads the
  bound called hidden without reading them: the assumption past the bound is
  "hidden", which is the overwhelmingly likely truth inside a wall of
  confirmed-hidden threads and is exactly what an empty page already means.
  Fix wave 2's rule (skips force a floor) put a residue-only, GENUINELY
  caught-up org into the client's inbox FAILURE state permanently -
  `serverRowCount === 0 && truncated` - over a deterministic prefix whose
  Retry reproduces itself. `truncated` keeps its 4.5 step 3 meaning: the scan
  ended EARLY (budget, depth cap, or an undeliverable lag drop). The skip
  total and the probe WARN remain the operator-facing signal that the wall is
  there. Threads skipped at the bound are re-evaluated by the NEXT request
  from the top, not deferred within this one. The residue itself is what has
  to go (the delete-time reset and backfill rule 3). The +1 keeps the bound
  above the tripwire so tripping it always warns, and the WARN reports probes
  ATTEMPTED, WASTED and SKIPPED separately so it can distinguish 26 residents
  from 2,600.
  NO MEMO: fix wave 1's per-collect memo keyed on the participant key is
  REMOVED. The claim arbiters (`phone#<E164>`, `claimEmail`) guarantee at
  most one OPEN conversation per key, so it could never hit. Contact
  resolution stays one lookup per 1:1 index item WALKED - see the corrected
  cost sentence above - and batching it belongs to
  docs/issues/contacts-batchget-amplified-reads.md.
- SILENT ZERO (AMENDED, C1): when the badge answers 0 with `truncated` set, the
  server logs a rate-limited WARN. A zero renders as NO badge, which is
  indistinguishable from caught up, and v1 deliberately gives the client no
  indeterminate rendering; the WARN is the only place that state is observable
  until docs/issues/unread-budget-truncation-has-no-forward-path.md is closed.
- Registered above the `/:contactId/read` param route; no collision with
  existing inbox routes (GET `/`, POST `/read`, POST `/:contactId/read`).
- Error posture: normal 500; the client collapses any error to "no badge".

DECLARED BEHAVIOR CHANGES (badge semantics):

- Today's badge count is NOT capped at 100: `limit=100` bounds only the
  contact pager, then relay rows merge additively uncapped and ALL unread
  group rows merge via the 2000-item walk (inbox.ts:798-887;
  UnreadContext.tsx:32-38 documents the group exemption). The new count caps
  ALL row kinds at 100 candidates, and group rows now compete for the cap.
  The visible badge already capped at 99+ (NavContents.tsx:67); the
  aria-label - previously the uncapped row count, which could exceed 100 -
  now reads at most "100 unread". Accepted: a count above 99 has no display
  fidelity anyway.

### 4.5 Unread page (`GET /api/inbox?filter=unread`)

The `filter=unread` branch of aggregateInbox is rewritten around
`collectUnreadRows` + hydration in a FILL-OR-EXHAUST loop (the same invariant
today's pager provides, inbox.ts:755-800):

1. Collect candidates, hydrate them (below), drop the ones hydration
   disqualifies, and REPEAT until `limit` hydrated rows are in hand OR
   `consumedAll` OR the request budget is spent. STATE THREADING (round-3
   finding - both were underspecified): the loop OWNS (a) the exclude set,
   seeded from the cursor's seen-set and ACCUMULATED with every candidate
   EMITTED by every iteration - a candidate hydration DROPPED is NOT recorded
   (AMENDED, A3: see the post-build amendments section; the set's job is
   cross-page suppression of emitted contacts, and `scanPosition` already
   makes within-page re-offering impossible) - and (b) the remaining raw budget
   (UNREAD_WALK_LIMIT per REQUEST), passed into and returned by each
   collect call, (c) the request's WASTED-probe total, threaded the same way
   (AMENDED, fix wave 2: 4.4 PROBE BOUND), and (d) the LAG-SHAPED hydration
   drops, retried once at the end of the request and reported as `truncated`
   if still unresolved (AMENDED, fix wave 2: see 12b, A3 COMPLETED;
   DISCRIMINATOR CORRECTED and the retry BOUNDED in fix wave 3: see 12c).
2. `nextCursor` keys on CONSUMPTION, never scan state: null when the final
   collect reported `consumedAll`; null when minting the cursor would
   exceed SEEN_SET_MAX (the declared depth cap, 4.3); otherwise - INCLUDING a
   budget- or probe-truncated page that has rows (AMENDED, C1) - the cursor
   from the final scanPosition + accumulated seen-set. INVARIANT: an empty
   `rows` array implies `nextCursor: null` - the loop only stops empty on
   consumedAll, budget exhaustion, or the depth cap - so the dashboard's
   empty-state and Load-more gating (Inbox.tsx:130-158) keep working.
3. EARLY-END SIGNALING (rounds 3-4): the InboxPage wire shape gains an
   optional `truncated?: true`, set on the unread branch ONLY, whenever
   the feed ended for a NON-NATURAL reason: the request budget expired
   before the page could fill, or the SEEN_SET_MAX depth cap ended paging
   (4.3). Never set elsewhere. Client handling (declared, small):
   - the SERVER returned no rows AND set truncated, on the FIRST page:
     render the EXISTING inbox error state verbatim (its shipped copy "We
     couldn't load your inbox." + retry - no new copy is invented; one error
     surface stays one surface) - and NOTE (round-4 precision): retry
     refetches the same prefix with a fresh budget and may fail again
     until the underlying accrual is addressed; the point of this state
     is not lying ("all caught up"), not guaranteed recovery. The gate is
     `InboxState.serverRowCount === 0`, NOT the rendered `rows.length`
     (AMENDED, C2 - marking every row on a truncated page read empties
     `rows` and must not flip a successful triage session into the error
     banner).
   - rows present + truncated (including when a LOAD-MORE page reports
     it - useInbox must surface the flag from loadMore responses too, not
     only fetchFirstPage): the list ends, but the cursor is still minted
     (AMENDED, C1), so Load more remains the forward path; no NEW affordance
     is invented. The signal exists on the wire for a future affordance
     without another schema change.

AMBIGUITY RECORDED ON-BRANCH (2026-08-16, review fix wave; NOT resolved here):
steps 2 and 3 pull opposite ways on the BUDGET-truncated case. Step 2 enumerates
only TWO null-cursor conditions (`consumedAll`, and exceeding SEEN_SET_MAX), so
on a literal reading a budget-expired page - which has a known `scanPosition`
and a seen-set inside the cap - OWES a cursor; step 3 says the list simply ends.
The SHIPPED CODE follows the plan's reading (`nextCursor: null` plus
`truncated: true`), and this branch does not change that. Which reading wins is
a product call for the human and is already filed, with the reproduction and
both remedies, as
`docs/issues/unread-budget-truncation-has-no-forward-path.md`.

RESOLVED in the review fix wave (C1): the cursor IS minted when the page has
rows, and stays null when it is empty. See the post-build amendments section at
the end of this document; the filed issue stays open for its OTHER half (the
badge's silent zero).

DECLARED BEHAVIOR CHANGE - PAGE COMPOSITION: today's `filter=unread` page one
is up to `limit` CONTACT rows PLUS all unread relay rows PLUS all unread
group rows additively (it can exceed `limit`). The new page is a SINGLE
unified stream: up to `limit` rows total, all kinds interleaved newest-first,
overflow of ANY kind reachable via Load more. Row CONTENT is preserved; page
composition is not; parity tests assert per-row content.

DECLARED BEHAVIOR CHANGE - `groupsTruncated` is NEVER SET under
filter=unread. Its group-specific meaning ("group-text rows this filter
would show were withheld"; the dashboard renders group-scoped copy linking
to ?filter=groups - Inbox.tsx:91-108, useInbox.ts:36-41) no longer has a
producer: group rows beyond the page limit are behind the cursor (the pager
affordance covers them), and the raw-budget case withholds rows of EVERY
kind, which group-scoped copy would mislabel. filter=all and filter=groups
keep the flag exactly as today. The dashboard needs no code change; the
Unread tab simply never shows the group notice again (previously it could).

HYDRATION (bounded by the page limit). Hydration reads are the FRESHEST
available sources but are still eventually consistent (section 6 - the
round-1 "page is fresh" claim was wrong and is withdrawn):

THE LAG DISCRIMINATOR (AMENDED, fix wave 3 - adversarial r3 finding 1,
conformance r3 findings 6 and 7). A contact candidate whose fresh sum is 0 is
classified by ONE authoritative base-table `getById` of the thread the index
offered (`unreadConversations[0]` - the collector emits a candidate AT its
first offered thread, so [0] IS that thread). Base still unread -> LAG: the
participant image is behind, retry once. Base read, closed or absent -> an
ordinary mark-read race (or a closed thread the index has not caught up with):
drop it, do not retry, do not truncate. Fix wave 2 asked instead whether the
offered thread was ABSENT from the fresh participant set, which is not the
shape a lagging GSI produces - a GSI replicates the whole projected item, so
the lag window shows the thread PRESENT carrying its pre-increment
`unread_count: 0` - so the dominant lag shape was classified authoritative and
neither retried nor flagged. THE RETRY IS BOUNDED at the page `limit`
(adversarial r3 finding 4 / conformance r3 finding 2): a lagging or degraded
participant GSI makes every candidate a lag-shaped drop, and an unbounded
retry doubles the reads of a page that returns nothing. Retry and unresolved
counts ride the request-level `inbox feed assembled` line.

- contact candidates: `contactConversations` - the aggregateInbox wrapper
  filtering conversationsForContact to `status === 'open' && type !==
  'relay_group'` (inbox.ts:373-395); note these resolve via the
  byParticipantPhone/byParticipantEmail GSIs (conversationsRepo.ts:1146-1156,
  :1259-1269), which lag independently of byUnread - once per contact
  (per-request cache as today, inbox.ts:373-395); newest conversation =
  representative for phone/lastActivityAt/placement exactly as today
  (inbox.ts:522-533); unreadSum re-summed over that set; fresh sum 0 ->
  row DROPPED (today's passesFilter contract, inbox.ts:441-445);
  latestMessageOf(maxConv) once; placement label if present.
- relay_group / group_text / unknown candidates: ONE point read of the
  conversation (conversations.getById - an eventually-consistent base-table
  GetItem, typically fresher than any GSI; ConsistentRead deliberately not
  required) refreshes status + unread_count; drop if no longer
  visible/unread; then hydrate exactly as today (latestMessageOf for unknown
  rows; relayRowFor / groupRowFor need no further reads).
- Deleted-contact resurfacing carries over unchanged (probe rules per 4.3
  step 2; presentation reuses maxConv's latest message as today,
  inbox.ts:552-561).
- A row dropped by hydration was already counted into the seen-set /
  consumed scan range; it simply does not render, and the fill loop replaces
  it. If its unread was real but a stale participant-GSI read hid it, the
  row is missed until the next reconcile refetch (section 6; the SSE event
  that accompanies any unread change triggers exactly that refetch).

ORDERING: rows within a page sort by displayed lastActivityAt (as today).
DECLARED NUANCE, sharper than v2 stated it: the stream orders contact
candidates by newest UNREAD activity while the row displays newest OVERALL
activity; these coincide today by construction and diverge here, so (a)
cross-page ordering can wobble for multi-thread contacts whose newest thread
is read, and (b) because the dashboard re-sorts the ACCUMULATED list on every
append (useInbox.ts:87-90, applied to base after loadMore appends at :203),
a Load more can visibly move an already-rendered row. Accepted: unread lists
are typically sub-page; the wobble needs a multi-thread contact with a
read-newer thread AND multi-page unread.

All other filters (`all`, `unknown`, `groups`) are UNTOUCHED, including the
early-rejection behavior from main @39c1aa41. GROUP_UNREAD_WALK_LIMIT /
GROUP_UNREAD_GROWTH_THRESHOLD and the unread group walk die with this
rewrite (the filter=all group source keeps its page-one cap and walk budget
as-is).

Mark-read routes are unchanged (they call resetUnread, which now maintains
the flag).

### 4.6 Today page unread source

today.ts keeps its single open-partition query (today.ts:529) and loop - the
relay opt-out attention scan lives INSIDE that loop, ordered before the
unread gate (today.ts:538-543), and keeps working unchanged. What moves: the
unread gate (today.ts:581-582) and everything downstream (unknown-triage
needs_you_now items and unreplied items, today.ts:584-641) leave the loop and
become a SECOND pass fed by `iterateUnreadConversations` (layer 1), filtered to
the 1:1 bucket - preserving per-conversation type/timestamp semantics.

- ORDERING PRESERVED: the unread pass still runs before the contacts-triage
  pass, which consumes `emittedUnknownPhones` (today.ts:520, :590, :726).
- CAP: FILTER-THEN-CAP, explicitly (round-3 finding: the other order lets a
  burst of unread group/relay threads starve the 1:1 sections): drive the
  layer-1 iterator, keep only 1:1-bucket items, and stop after
  TODAY_UNREAD_CAP = 100 KEPT conversations. Truncation announcements
  (round-4 precision): the cap announcement goes through the warnIfCapped
  mechanism with the EXPLICIT threshold TODAY_UNREAD_CAP (the current
  helper hardcodes GROUP_FETCH_LIMIT as both threshold and logged value,
  today.ts:354-356 - it needs the threshold as a parameter), and a
  budget-expired underfilled pass (iterator stopped by the request budget
  before the cap) logs its own rate-limited WARN rather than passing
  silently.
  SELECTION CHANGE: the newest-100-unread by activity, rather than
  unread-within-the-first-100-open. The NUMERIC bound is unchanged but the
  REALIZED payload is larger on unread-heavy data (today only the unread
  subset of the first 100 open threads emitted; now up to 100 items all
  emit). That growth is the point (the silent-miss fix) and is bounded by
  the same 100.
- PER-DESTINATION-GROUP DEDUPE, AND THE DELETED-CONTACT TEST, BOTH BEFORE THE
  CAP (AMENDED, C3 + A9). contactThreads models one conversation PER
  PARTICIPANT KEY, so a person owning a phone thread and an email thread
  arrives twice and used to emit TWO `unreplied` rows - duplicate React keys in
  one <ul> and two consumed cap slots for one person. And the deleted-contact
  test ran in the EMIT loop, after the cap: with the index source, where
  resurfaced deleted contacts concentrate by construction, a wall of them
  rendered the block empty while warnIfCapped said "capped". Both tests now sit
  in the collect loop beside isOneToOneBucket, for the same reason the spec
  already gives for filtering group threads first. DECLARED PRODUCT CHANGE: a
  contact with unread on both channels is ONE Unreplied row.
  BOUNDED (AMENDED, fix wave 2 - adversarial r2 finding 6): ahead of the cap
  the deleted test runs on every 1:1 item WALKED, and each distinct contact is
  a real `contacts.getById` (the request cache is per contact ID, so the move
  is NOT free as this bullet first implied). The skip work is therefore bounded
  at TODAY_UNREAD_CAP DISTINCT skipped contacts, and warnIfCapped announces the
  state under the label `unread:deleted_skips`. Unbounded, a deleted-residue
  head could cost up to UNREAD_WALK_LIMIT contact Gets on a route every
  connected dashboard SSE-refetches.
  THE BOUND STOPS THE LOOKUPS, NEVER THE WALK (AMENDED, fix wave 3 -
  adversarial r3 finding 5). Fix wave 2 BROKE the pass past the bound, which is
  the walk-stop both reviewers blocked for the inbox in round 2, on the one
  surface with no cursor, no `truncated` and no Load more: every live unread
  thread behind the wall disappeared permanently. Past the bound a 1:1 item is
  treated as NON-deleted and the existing TODAY_UNREAD_CAP ends the pass; a
  contact already known deleted stays filtered for free. DECLARED COST: a
  deleted contact met past the bound CAN render an Unreplied row - bounded by
  the same 100-row cap, and the lesser harm against hiding live work.
- NET COST: Today gains one index query and loses nothing. G5 is a
  correctness fix, not a cost fix.

### 4.7 Client: optimistic badge + fast reconcile

UnreadContext changes (dashboard/src/app/UnreadContext.tsx):

1. FETCH SWAP: `fetchCount` calls new `getUnreadCount()`
   (api/endpoints.ts next to getInbox; type `InboxUnreadCount
   { unreadCount: number; capped: boolean; truncated: boolean }` next to
   InboxPage in api/types.ts). Error posture unchanged: any error -> null.
2. OPTIMISTIC LAYER: context value becomes
   `{ unread, unmatchedUnread, noteRowsCleared, rollbackRowsCleared }`, with
   NO-OP function defaults on the createContext value (provider-less renders
   must not throw - existing tests mount hooks bare), and the provider value
   memoized (every nav leaf consumes this context, NavContents.tsx:40).
   - State: `serverCount`, `capped`, `pendingClears: Map<rowKey,
     clearedAtMs>`, and a fetch generation counter.
   - Displayed `unread = serverCount === null ? null : capped ? serverCount
     : max(0, serverCount - pendingClears.size)`. While CAPPED the
     subtraction is suppressed (the count is a cap; decrementing would
     flick 99+ -> 99 -> 99+). `truncated` does NOT suppress - a truncated
     count is small and real-so-far, and G3's instant feedback stays on.
   - `noteRowsCleared(keys)` inserts keys (idempotent by key: the
     row-click + contact-page double-POST and StrictMode double-invoke
     cannot double-decrement). `rollbackRowsCleared(keys)` deletes them.
   - EXPIRY + CONVERGENCE (round-2 finding: the single SSE event this
     action produces is consumed by the fetch that expires the clear, so a
     stale read there would otherwise stick until an UNRELATED event): a
     pending clear expires when ANY fetch that STARTED after the clear was
     recorded RESOLVES successfully (no value comparison - a value
     predicate creates stuck states); WHEN a resolve expires one or more
     clears, schedule ONE follow-up reconcile fetch RECHECK_DELAY_MS
     (2000ms) later unless another fetch is already scheduled/in-flight.
     BOUND (round-3 correction): the guarantee is "at most one scheduled
     follow-up at a time" - the schedule guard, NOT a no-cascade property
     (a clear recorded between scheduling and firing IS expired by the
     follow-up and may schedule another; continuous clicking sustains a
     bounded chain, one pending fetch at a time). Under continuous SSE
     traffic the guard routinely skips the follow-up and the
     already-pending debounced refetches provide the convergence instead -
     equivalent outcome, stated so the follow-up is not mistaken for the
     sole mechanism. PENDING_CLEAR_TTL_MS = 10_000 stays as backstop when
     no reconcile happens at all. Residual: if the GSI is STILL stale at
     t+2.3s, the badge shows the stale count until the next event/refetch;
     accepted (server remains authority).
   - Generation guard: a fetch resolving after a newer fetch started is
     discarded (a stale in-flight response cannot clobber newer state).
   - Clamp: displayed count never negative.
3. CALLERS - every surface that VERIFIED unread > 0 before marking:
   - `useInbox.markRead`: all four branches, after the `:263` unreadCount
     guard and the `:283` addressability guard; rollback in the existing
     `.catch` (useInbox.ts:291-293).
   - `useTourChannels.markGroupRead`/`markPersonRead` (guards at :268/:288)
     and `usePlacementChannels` equivalents (:275/:293). SOUND BY THE
     CLOSE-RESET RULING: with closed relay groups zeroed at close, any
     unread group these guards pass is open/connecting - i.e. badge-
     counted; person marks target open 1:1 contacts, always badge-visible.
     (Pre-ruling this wiring was excluded because a closed-but-unread group
     would have decremented a row the badge never counted.)
   - BADGE KEY VOCABULARY (kind-free, resolving the round-1 finding that
     the hooks cannot know a row's g:/gt: kind): the badge context keys
     clears as `c:<contactId>` | `u:<phone>` | `cv:<conversationId>`.
     useInbox derives them from its row fields (contact -> c:, unknown ->
     u:, both group kinds -> cv:); the hooks have exactly a contactId or a
     conversationId. One logical row = one key on every surface, so
     cross-surface duplicate clears (inbox click + tour tab within one TTL
     window) dedupe instead of double-decrementing.
   - The contact/conversation AUTO-marks stay unwired (useMarkContactRead
     and the detail-mount marks fire blind on mount, no unread knowledge);
     they reconcile via the cheap refetch - pre-existing behavior minus
     ~1.5s.
4. RECONNECT RECONCILE: subscribe `onOpen` (EventStreamProvider.tsx:57) ->
   scheduleRefetch, correcting drift after an SSE blackout.
5. The 300ms SSE debounce and the unmatched-email half are unchanged.

The Inbox page keeps its own optimistic row-drop; useInbox changes by the
noteRowsCleared/rollback wiring plus surfacing InboxPage.truncated, and
Inbox.tsx renders retry on the empty+truncated case (4.5 step 3).
AppFrame.test's useUnread stub and Inbox.test's baseState factory gain the
new fields (section 8).

### 4.8 What the badge means

The badge counts VISIBLE INBOX ROWS - one per contact (however many unread
threads), one per unknown number, one per relay group, one per native group
thread - capped at BADGE_COUNT_CAP (100), rendered as 99+ past 99. Badge and
page draw from the SAME collector and visibility rules; the numbers can
still diverge transiently (the page hydrates against fresher sources and
drops newly-read rows; the badge reads index state in its own request) and
converge on reconcile. No strict badge==page equality is claimed.

## 5. Wire contract additions

```
GET /api/inbox/unread-count
200 { "unreadCount": number, "capped": boolean, "truncated": boolean }
```

InboxPage gains ONE optional field: `truncated?: true` - present only on a
filter=unread response whose request budget expired before the page filled
(section 4.5 step 3). InboxRow is untouched; `groupsTruncated` is simply
never present on filter=unread responses (section 4.5).

## 6. Consistency model (explicit)

- EVERY read path here is eventually consistent, in three tiers:
  - `byUnread` (the discovery source): a just-read conversation may linger;
    a just-arrived unread may be briefly missing. A projection-side
    `unread_count > 0` check CANNOT detect this lag (the stale entry's
    projected attributes are stale in lockstep); layer-1's check defends
    within-image inconsistency only.
  - `byParticipantPhone` / `byParticipantEmail` (contact-row hydration +
    unreadSum): lag INDEPENDENTLY of byUnread. A contact row can therefore
    render with a stale sum, be dropped on a stale zero, or (rarely, via
    cross-GSI skew) be missed across a page boundary. All converge on the
    next reconcile refetch - the SSE event accompanying any unread change
    triggers exactly that.
  - `getById` point reads (non-contact hydration): eventually-consistent
    base-table reads, typically fresher than any GSI; ConsistentRead is
    deliberately not used.
  The BADGE accepts index staleness outright (no per-candidate base reads -
  cost without commensurate benefit for a typically-ms window); the user's
  own action is masked by the optimistic layer + follow-up reconcile
  (4.7.2); other operators' actions converge on reconcile.
- ACCRUAL is eliminated by the close/delete resets + backfill cleanup
  (4.2/7.2); what remains is transient (a close or delete racing an
  inbound, and deleted contacts with genuine resurface-eligible unread -
  which are SUPPOSED to be indexed and each cost a contact resolution + an
  unconditional message probe per badge request; the round-2 probe
  short-circuit stays withdrawn as clock-unsafe, 4.3 step 2). The
  per-request budget ceiling (2000) and both rate-limited WARNs (500
  scanned items; 25 deleted-probes) remain as regression sentinels for the
  invariant, not as standing mitigations.
- The pre-existing emit gap (increment succeeds, touchLastActivity throws,
  no SSE event - twilio.ts:604-618 et al.) leaves the INDEX correct and
  only delays client refresh; unchanged.
- No transactional projection table; no new event types.

## 7. Migration and operations

1. SCHEMA: tables.ts + `npm run gen:tables` + both tfvars committed together
   (plan/drift hard-fail on stale JSON). Test guards updated in the same
   commit.
2. BACKFILL SCRIPT: `app/scripts/backfill-unread-flag.ts`, modeled on
   backfill-broadcast-list-partition.ts (paginated Scan; per-row
   UpdateCommand; `--dry-run` flag; read-side skip + write-side
   ConditionExpression idempotency; `{scanned, stamped, removed, skipped}`
   counts; isEntrypoint guard; pure planner function unit-tested per
   backfillConsentMethod.ts). FOUR rules, applying the runtime invariant
   AND the human-ruled resets to legacy rows one-time:
   - stamp `unread_flag` where `unread_count > 0` and absent;
   - REMOVE the flag where present with count 0/absent;
   - CLOSED RELAY GROUPS with unread > 0: zero the count + remove the flag
     (the close-reset rule, applied retroactively - these rows are
     invisible to every reader regardless);
   - DELETED-CONTACT THREADS with unread > 0: apply the SAME resurfacing
     predicate the runtime uses (one messages.listByConversation(limit 1)
     probe per such thread; newest message inbound with created_at >
     deleted_at keeps the unread, anything else zeroes it) - a one-shot
     probe cost on a bounded population, so resurface-eligible threads
     survive the cleanup. Requires a pre-pass building the deleted-contact
     participant set (scan contacts for deleted_at, collect phones/emails).
   Skips pointer partitions (`phone#`/`email#`/`token#` prefixes).
3. LOCAL SCHEMA UPDATE (no data loss): `ensureTable` is create-only and
   `db-create --reset` would destroy the human's imported local dataset. New
   script `app/scripts/db-update-gsis.ts` (localhost-endpoint-guarded like
   db-create's reset): diff TABLES GSIs against each live local table, issue
   UpdateTable CreateGlobalSecondaryIndex for missing ones, wait ACTIVE.
   Disposable e2e lanes are wiped instead (hc-local-<L>-* under the lane's
   own access key, per docs/issues/e2e-lane-tables-stale-schema.md).
4. ORDER OF OPERATIONS (human-run, recorded in RUNBOOK). CORRECTED, review
   fix wave 1 (adversarial A1) - this item previously prescribed
   apply -> backfill -> deploy, which is HAZARDOUS: run under the OLD
   `resetUnread`, every mark-read between the backfill and the deploy zeroes
   `unread_count` without REMOVEing `unread_flag`, manufacturing a permanent
   invisible index resident. The order is SCHEMA -> CODE -> DATA. Dev:
   `npm run plan -- dev` -> `npm run apply -- dev` (NOTE: the plan carries
   the entire owed backlog - byJurisdiction delete, several new tables and
   GSI adds/drops, per RUNBOOK.md:117-220; expected, not an error) ->
   `npm run deploy:dev` -> `tsx app/scripts/backfill-unread-flag.ts
   --dry-run` then live. Deploying against a not-yet-backfilled GSI is safe
   (the new code simply does not see legacy unread yet). Prod rides the M1.11
   gate. Local: `tsx app/scripts/db-update-gsis.ts` -> restart the dev stack
   -> backfill. Anyone who already ran the old order must re-run the
   backfill. RUNBOOK.md is the operational copy of this and is authoritative
   for the run itself.
5. RUNBOOK gains the owed-op row in the schema-changes table.

## 8. Testing and existing-surface migration

EXISTING TEST SURFACES THAT CHANGE (enumerated; real builder work):

- In-memory fakes gain the index, KEYED OFF `unread_flag` (not
  unread_count>0) so the invariant is actually exercised:
  app/test/helpers/twilioWebhookHarness.ts:403 (incrementUnread/resetUnread
  at :447-458 must model the flag), app/test/inboxFeed.test.ts:69-115
  (hand-built GSI fake, cast `as unknown as ConversationsRepo` - a missing
  method is a runtime TypeError), app/test/contactCapture.test.ts:130.
- Fixtures seeding nonzero unread gain the flag (flag iff count > 0):
  inboxApi.test.ts (:100-101,174,194-196,322-334,418-434,493,532),
  inboxEmail.test.ts (:79-175), contactSoftDelete.test.ts (:96-97,116),
  inboxFeed.test.ts (:193-240 + the filter='unread' cases),
  inboxGroups.test.ts (:265-296), contactTriage.test.ts (:91),
  inbox.integration.test.ts (:311), performanceSeed.integration.test.ts
  (:409).
- inboxGroups.test.ts:265 pins the retired full-partition-walk contract -
  REWRITTEN to the unified-stream contract (group rows beyond the page limit
  reachable via cursor; groupsTruncated never set under unread).
- e2e/performance CONTRACT MIGRATION (required gate; unit-tested pins):
  ENDPOINT_TEMPLATES gains `/api/inbox/unread-count`
  (e2e/performance/templates.ts:119-121 region - an unlisted path becomes
  unmatched_api and fails selfQa.ts:417, though the typed `endpoint()`
  helper catches omission at typecheck); COLD_SHELL_GETS' badge entry
  (routes.ts:239) becomes the new path-only endpoint; the classifier keyed
  on `filter==='unread' && limit==='100'` (collect.ts:162) becomes a path
  match for /api/inbox/unread-count (also ensuring an Unread-page request
  at limit 100 is NOT misclassified as the badge); shell-request detection
  (collect.ts:175-179), classAware (:128), and the warm-mode special case
  (:362) keep working against the new class; pinned tests (routes.test.ts:
  48, collect.test.ts:207-315 badge cases, report.test.ts:561,580) update.
  LINE-PIN re-derivation (checked against v3's actual edit set, not
  inherited from v1): routes.ts:761 (UnreadContext.tsx:19,52-115) is
  invalidated by the rewrite and must be re-pinned; routes.ts:666,720 pin
  useInbox.ts:46-65,139-155 / Inbox.tsx:53-75 - ranges v3 does not edit
  (the markRead wiring lands ~:260-300) - verify at build, expect no churn;
  routes.ts:753-755 pin the channel hooks, which the v6 ruling DOES now
  edit (markGroupRead/markPersonRead gain badge wiring) - re-derive those
  pins; useInbox pins at routes.ts:666,720 ALSO churn (InboxState gains
  `truncated` inside useInbox.ts:46-65) - re-derive rather than assume.
- app/scripts/profile-inbox.ts / lib/inboxDiagnostics.ts: the plan's
  `unread-badge` case switches to driving the unread-count function; a
  `unread-page` case stays on aggregateInbox at limit 30.
- dashboard: AppFrame.test.tsx's useUnread stub (:6-8) and Inbox.test.tsx's
  baseState factory (:13-25) gain the new fields; useInbox surfaces
  `truncated` from BOTH fetchFirstPage and loadMore responses (round-4
  precision: today it reads page flags only in fetchFirstPage).
- InboxPage lives in TWO places under an explicit field-for-field contract
  (app/src/routes/inbox.ts:118-129 and dashboard/src/api/types.ts:
  2685-2695) - the new `truncated?: true` field is added to BOTH in the
  same commit.

NEW TESTS:

Unit (app/test):
- conversationsRepo: incrementUnread sets flag+count atomically (absent->1
  creates flag; repeats keep it); resetUnread zeroes count and REMOVEs flag;
  both idempotent; either ordering leaves flag consistent with count;
  setRelayStatus('closed') zeroes count + removes flag in the same write
  while 'open'/reopen leaves unread untouched (and a reopened group shows
  unread 0 - the declared product change).
- contacts route: soft-delete fans out resetUnread over every thread with
  unread > 0 (phone + email threads; CCFE swallowed; a thread already at 0
  is untouched); a post-deletion inbound after the delete still increments
  and still resurfaces.
- unreadFeed layer 1: visibility matrix (open/closed/connecting relay,
  group_open, 1:1 bucket incl. a type-less row, pointer-partition skip);
  scanPosition advances across a FULLY-FILTERED run (no dead-end); LAZINESS
  (a consumer that stops pulling stops the Query paging - assert via a
  counting fake that maxRows=1 against a 300-item index issues no further
  Query pages); budget threading across calls; rate-limited WARN.
- unreadFeed layer 2: contact grouping (multi-phone + phone+email merge to
  one candidate); excludeContactIds suppression; unknown-number candidates;
  contactless email skipped; deleted-contact resurfacing (fresh-inbound yes
  / pre-deletion no / outbound no) probed unconditionally (a stale
  last_activity_at older than deleted_at with a fresh post-deletion
  message still resurfaces - the withdrawn-short-circuit regression case);
  capped vs truncated vs consumedAll (an under-budget 300-item index with
  maxRows=30 reports capped, NOT consumedAll - the round-3 blocking case);
  scanPosition on a capped run resumes without re-scan or skip.
- inbox route (filter=unread): per-row content parity with pre-change
  fixtures; unified composition (kinds interleaved, limit respected, cursor
  pages overflow of every kind - incl. an under-budget dataset larger than
  one page, the round-3 blocking case: page 1 MUST carry a non-null
  cursor); FILL-OR-EXHAUST (hydration drops refill the page; the exclude
  set accumulates ACROSS loop iterations - a multi-thread contact whose
  older thread lands in iteration 2 must not emit twice on one page; empty
  rows implies null nextCursor - including a bulk-fan-out mark-read race
  fixture); multi-thread contact split across pages suppressed by the
  seen-set (incl. equal-timestamp boundary items); depth cap (the server
  returns null instead of minting a cursor past SEEN_SET_MAX; no 400 is
  reachable from server-minted cursors); cursor namespacing (unread cursor
  under other filters -> 400, vice versa, tampered oversized seen-set ->
  400); groupsTruncated never present; InboxPage.truncated set on a
  budget-expired underfull page and the dashboard renders retry (not
  all-caught-up) on empty+truncated; zero-unread dataset -> empty page, 1
  index query, NO contact/message/placement calls (call-count assertions).
- unread-count endpoint: counts rows not conversations; capped and
  truncated distinguished; deleted-contact parity with the page; zero
  state = 1 call.
- today route: unread sections fed by layer 1; an unread thread outside the
  first-100-open window surfaces; relay opt-out scan unaffected;
  emittedUnknownPhones ordering preserved; TODAY_UNREAD_CAP + warnIfCapped.
- Seeds guard: fixture arrays carry unread_flag iff unread_count > 0.
- backfill planner: stamp / remove / skip / pointer-row cases.
- UnreadContext: optimistic decrement synchronous (before any debounce);
  idempotent per key; expiry on first post-clear resolved fetch; follow-up
  reconcile bounded to ONE SCHEDULED AT A TIME under a multi-click fixture
  (several clears racing several resolves - not just the single-action
  case); follow-up skipped when a fetch is already pending (convergence
  then rides the pending refetch); TTL backstop; rollback; generation
  guard; clamp at 0; capped suppression (and NO suppression on
  truncated-only); no-op defaults (bare render safe); memoized value;
  onOpen refetch.
- useInbox: noteRowsCleared fires exactly once per guarded mark-read with
  the kind-free key (contact -> c:, unknown -> u:, relay_group AND
  group_text -> cv:), rollback on failure; useMarkContactRead does NOT
  touch the badge context.
- useTourChannels/usePlacementChannels: markGroupRead/markPersonRead call
  noteRowsCleared (cv:/c: keys) only past their unread>0 guards, rollback
  on failure; a same-thread clear from the inbox row and the tour tab
  dedupes to ONE key (no double-decrement); provider-less renders still
  safe via the no-op defaults.
- Backfill rules 3-4: closed-relay unread zeroed; deleted-contact threads
  probed once with the runtime resurfacing predicate (resurface-eligible
  kept, stable-no zeroed); dry-run counts all four rule buckets.
- setRelayStatus('closed') + contact-delete fan-out integration coverage:
  close-then-reopen shows unread 0 through the index AND the feed;
  delete-then-inbound resurfaces with exactly the post-deletion count.

Integration (DynamoDB Local, per relayRepos.integration.test.ts precedent):
- byUnread returns exactly flagged rows newest-first; increment/reset
  round-trip visible through the index; synthesized-ExclusiveStartKey
  resume is exact after a boundary item that shares last_activity_at with
  its neighbors (position-exactness, not order-assumption - the seen-set
  covers dedupe); backfill both directions against a mixed-state table
  (positive / zero / absent / pointer row).

E2E:
- NEW spec: nav Inbox badge - seed unread, badge shows count; open the row;
  badge decrements IMMEDIATELY (assert before the reconcile could land,
  raced-response idiom per group-text-inbox.spec.ts); a group-text row
  decrements too. First nav-badge e2e coverage.
- Existing inbox-markread.spec.ts, group-text-inbox.spec.ts,
  deleted-contact-resurfacing.spec.ts stay green.

Performance evidence:
- `npm run perf:inbox` before/after, >= 5 repeats: unread-page (limit 30)
  and the badge case drop from ~1,230 calls to O(indexed unread) (target:
  <= 3 calls on the zero-unread dataset); all-page/groups-page unchanged.
  Report calls eliminated + remaining; local medians are
  DynamoDB-Local-bound evidence only.

## 9. Acceptance criteria

- Badge request on a zero-unread dataset: 1 index query, no hydration calls.
- Unread page on a zero-unread dataset: 1 index query, empty rows, null
  cursor.
- The scan is LAZY: badge and page issue index Query pages only until their
  row caps fill (a 100-row cap against a 1,000-item index does not scan
  1,000 items).
- An under-budget multi-page unread list pages completely through the
  cursor (no silent depth loss except the declared SEEN_SET_MAX cap).
- Neither badge nor Unread page issues per-OPEN-conversation calls; cost
  scales with scanned index items (visible unread + stated accrual) plus
  per-page hydration bounded by limit.
- A fully-filtered index prefix can never permanently empty the feed
  (scan-position resume + fill-or-exhaust); a budget-expired empty page
  reports InboxPage.truncated and renders retry, never all-caught-up.
- Badge decrements at click time on Inbox mark-read paths, never negative,
  suppressed only while capped; a failed mark-read restores it; convergence
  via the post-clear reconcile + single follow-up (stale-window residual
  bounded by the next event as stated in 4.7).
- Unread row CONTENT unchanged for identical data; page COMPOSITION and
  groupsTruncated per section 4.5's declared changes.
- All/unknown/groups filters and their costs untouched.
- Sparse-flag invariant across every writer (unit + integration + seed
  guard + backfill tests); fakes key their index off the flag.
- e2e/performance suite green under the migrated badge contract.
- Gates: `npm run typecheck`, `npm test`, `npm run e2e` green from the
  worktree.

## 10. Invariant surface enumeration (research-verified, reviewer-audited)

WRITERS of unread_count (all through 2 primitives - verified exhaustive):
- incrementUnread callers: twilio.ts:605 (relay inbound), :905 (closed-group
  late text -> the SENDER'S 1:1, not the closed group), :1660 (group_text
  inbound), :2125 (1:1 inbound), inboundEmail.ts:707 (email inbound). All
  become flag-writers automatically.
- resetUnread callers: api.ts:2020 (conversation read), inbox.ts:982 (phone
  fan-out), inbox.ts:1015 (contact fan-out), and NEW by human ruling: the
  contact soft-delete fan-out (contacts.ts delete handler). All become
  flag-removers automatically. `setRelayStatus('closed')` zeroes
  count+flag inside its own write (4.2) - the one lifecycle writer that
  now touches unread.
- Creation sites (createOrGetByParticipantPhone/Email, createRelayGroup,
  createGroupTextThread, import upsertConversation): omit unread_count ->
  omit flag; NO changes. Every conversation PutCommand is conditional on
  attribute_not_exists(conversationId) - no runtime whole-item clobber.
- Status/lifecycle transitions: no unread/flag writes; reader status filters
  preserve visibility (accrual classes 4.2 accepted).
- Seeds: performance.ts:820/:889 conditionally per row; others zero/absent.
- Deletes (import retract, devReset, performanceSeed lean-group delete): GSI
  entries drop with the item.

READERS of unread state (all accounted for):
- inbox.ts filter=unread + the badge -> the two unreadFeed layers (this
  design).
- inbox.ts deleted-resurfacing + unreadSum -> preserved (collector +
  hydration, with the probe short-circuit).
- today.ts unread gate -> layer 1 (this design); relay opt-out scan keeps
  the open-partition walk.
- api.ts:416 summaries + :1697 raw detail -> counter attribute only;
  unchanged (raw detail now also carries unread_flag; accepted).
- events.ts:100 SSE payload -> unchanged.
- e2e/performance harness -> badge contract migrated (section 8, incl.
  ENDPOINT_TEMPLATES).
- app/scripts/profile-inbox.ts -> plan updated (section 8).
- Dashboard: UnreadContext (rewired), useInbox rows (shape unchanged),
  usePlacementChannels/useTourChannels first-page unread dots (unchanged;
  their documented first-page limitation is out of scope), fake-twilio's
  groupUnreadByPool (different counter; untouched).
- Test fakes and fixtures -> section 8's migration list.

## 11. Follow-up issues


- docs/issues/contacts-batchget-amplified-reads.md (filed on this branch):
  the agreed next mission.
- inbox-unread-sse-full-walk.md -> resolved by this feature when the build
  lands (status flipped on this branch).
- inbox-filter-tabs-full-walk.md -> updated: unread half resolved here,
  unknown half remains open.

## 12. Post-build amendments (2026-08-16, planner-ratified review fix wave)

THE FILE THE HUMAN APPROVED AS v6 IS NO LONGER THIS FILE. Everything below was
written AFTER the spec gate, during the independent review of the built branch,
and every item was adjudicated by the planner (this document's author) against
the conformance and plan-blind adversarial reports. Nothing here reverses a
decision the human made at the gate; each item either resolves an ambiguity the
build exposed, or declares a behavior the build introduced. A reader diffing v6
against this file needs only this section.

The two blocks written on-branch BEFORE this review - the "AMENDED ON-BRANCH"
paragraph in 4.2 (the delete fan-out resets EVERY thread, not only unread ones)
and the "AMBIGUITY RECORDED ON-BRANCH" paragraph in 4.5 (which reading governs a
budget-truncated cursor) - are RATIFIED here rather than rewritten. The first
stands as written; the second is now RESOLVED by item C1 below, and its
paragraph says so in place.

Ratified amendments, by review finding id:

- A2 (4.3 layer 2, 4.4). Contact resolution is MEMOIZED per collect on the
  participant key, and the deleted-contact resurfacing probe gains a HARD BOUND
  of UNREAD_DELETED_PROBE_LIMIT = UNREAD_DELETED_PROBE_WARN + 1 per collect,
  past which the walk STOPS and the result reports `truncated`. `truncated`
  therefore now means "budget OR probe bound", not "budget". DECLARED
  CONSEQUENCE: rows sitting behind a wall of more than that many HIDDEN
  deleted-contact threads are withheld with `truncated` rather than paid for at
  unbounded read cost. Reason: a hidden deleted candidate never counts toward
  `maxRows`, so the row cap could not stop the walk - the reviewer measured
  4,020 serial round trips on one nav-badge request that then answered zero.
- A3 (4.5 step 1). The fill loop's seen-set records EMITTED contacts ONLY. The
  original wording ("accumulated with every candidate emitted", read by the
  build as "kept AND dropped") suppressed a contact for the whole paging session
  whenever hydration dropped it - and hydration drops on a lagging participant
  GSI, so the badge counted a row no page could show. Within-page duplication is
  NOT what the set defends: `scanPosition` advances past every consumed item, so
  a collect cannot re-offer one.
- C1 (4.5 step 2, 4.4). A budget- or probe-truncated page WITH rows mints its
  cursor. Step 2's enumeration of null conditions is exhaustive and this case is
  not in it; discarding a `scanPosition` already paid for left Retry as the only
  affordance, and Retry reproduces the identical truncation. The empty-page
  invariant is unchanged. The badge's half of the same issue is NOT fixed here -
  an indeterminate badge is out of v1 scope - so instead the server logs a
  rate-limited WARN when it answers 0 while truncated, and
  docs/issues/unread-budget-truncation-has-no-forward-path.md stays open for the
  UI affordance.
- C2 (4.5 step 3). The client's early-end gate keys on the new
  `InboxState.serverRowCount`, not on the rendered `rows.length`. The literal
  gate turned a successful triage session (operator marks every row on a
  truncated page read) into "We couldn't load your inbox." Both gates - error
  and empty-state - move together so they stay exact complements.
- C3 + A9 (4.6). Today's unread pass dedupes per destination group AND applies
  the deleted-contact test INSIDE the collect loop, ahead of the cap. Both are
  product-visible: a contact with unread on two channels is now ONE Unreplied
  row, and a wall of deleted-contact threads no longer empties the block.

- A1 (section 7 item 4). THE ROLLOUT ORDER IS A SPEC CHANGE, not a
  RUNBOOK-only correction as this section first recorded it (conformance r2
  finding 3): section 7 spelled the hazardous sequence out verbatim. Both
  recipes are now schema -> code -> data, with the reason inline. See item 4.

Corrections made in the same wave that need NO spec change, recorded so the
diff is fully accounted for: cursor emptiness validation (A4); the backfill's
contact-key pre-pass and its outcome-based counters (A5, A8); the
contact-delete fan-out emitting from its own reset returns (A6); the shared
index fake's LEK-at-the-Limit rule (A7); and comment-only rulings (A10, A12,
C8).

## 12b. Post-review amendments, fix wave 2 (2026-08-16, planner-ratified)

A SECOND independent review round (conformance r2, plan-blind adversarial r2)
found that fix wave 1's A2 remedy was itself a correctness regression, and the
planner adjudicated the corrected design. Everything here is post-gate, and
none of it reverses a human decision made at the spec gate.

- A2 CORRECTED (4.3 step 2, 4.4). The deleted-probe bound counts WASTED probes
  only, is a REQUEST budget, and stops the PROBING rather than the WALK; a
  result carrying skipped threads reports `truncated` as a floor. Full
  statement at 4.4 PROBE BOUND. Two BLOCKING regressions drove it: 27+
  genuinely resurfaced deleted contacts floored the badge at 26 (a product
  state, not an error state), and 27 hidden deleted threads ahead of live
  unread dead-ended the page at zero rows with no cursor. The
  participant-key MEMO is REMOVED as unreachable (the claim arbiters allow one
  open conversation per key); the unread collector is added to the surface
  list in docs/issues/contacts-batchget-amplified-reads.md.
- A2 accepted consequence: a deleted-contact thread refused AT the bound is
  SKIPPED, not deferred - the scan range advances past it, and the next
  request re-evaluates from the top with a fresh budget. This is the
  pathological wall only.
- Probe tripwire: the WARN payload reports probes ATTEMPTED and threads
  SKIPPED separately, so the badge path can still say how DEEP the wall is
  once the reads are capped.
- A3 COMPLETED (4.5 step 1) - IMPLEMENTER-PROPOSED, PLANNER-RATIFIED r3
  (conformance r3 finding 4: the adjudication stated a BLANKET rule, the
  implementer narrowed it to lag-shaped drops and wrote the narrowing into this
  authority document before the planner had ruled; the narrowing is right on
  the merits and is ratified in `planner-adjudications-r3.md`). Fix wave 1
  stopped a hydration-dropped candidate being suppressed; it did not make it
  reachable. The fill loop now retries LAG-SHAPED drops ONCE at the end of the
  request (after every other read, so a lagging participant GSI has had time to
  settle), and a drop the retry cannot fix sets `truncated` on the page - it
  must never report a natural end while the badge counts a row it could not
  deliver. Only lag-shaped drops qualify: marking an ordinary mark-read race
  would render the inbox ERROR state at the end of a successful triage session,
  the regression C2 fixed. HOW lag is recognized was WRONG here (fix wave 2
  keyed on GSI membership) and is CORRECTED in fix wave 3 - see 12c and the
  hydration section of 4.5.
- A6 CORRECTED (no spec claim). The contact-delete reset's authoritative emits
  move AFTER propagateContactPresenceChange so they are genuinely last on the
  wire, and the comment's premise is corrected: no dashboard consumer reads
  `unread_count` off that event today.
- A9 BOUNDED (4.6). Today's pre-cap deleted-contact test is bounded at
  TODAY_UNREAD_CAP DISTINCT skipped contacts; past that the pass stops and
  warns under its own label. Unbounded it could issue up to UNREAD_WALK_LIMIT
  contact Gets per /api/today.
- Conformance r2 3/4/5: section 7's rollout order, 4.3's CURSOR SIZE
  paragraph and 4.3 step 2's "UNCONDITIONALLY" are corrected in place, each
  labeled. The step-2 edit is the one that touches a carried-through gate
  ruling and is surfaced to the human in the merge verdict.

## 12c. Post-review amendments, fix wave 3 (2026-08-16, planner-ratified)

A THIRD independent review round (conformance r3, plan-blind adversarial r3)
verified both round-2 BLOCKERs fixed and found that two of wave 2's remedies
still LIE to the operator - one about what lag looks like, one about what an
empty page means. Everything here is post-gate; none of it reverses a human
decision made at the spec gate. Adjudications: `planner-adjudications-r3.md`.

- LAG DISCRIMINATOR CORRECTED (4.5 hydration; adversarial r3 finding 1,
  conformance r3 findings 6 and 7). Wave 2 asked whether the offered thread was
  ABSENT from the fresh participant set. A GSI replicates the whole projected
  ITEM, so the lag window shows the thread PRESENT carrying its pre-increment
  `unread_count: 0` - the dominant production shape was therefore called
  authoritative: never retried, and not even reported through `truncated`, so
  the page claimed a clean natural end while the badge went on counting the row.
  The contact arm now discriminates with ONE authoritative base-table `getById`
  of the offered thread, exactly as the non-contact arm already does. Base
  unread -> lag; base read, closed or gone -> a real mark-read, dropped without
  a retry. `unreadConversations[0]` IS the offered thread and the code says why.
- LAG RETRY BOUNDED (4.5 step 1(d); adversarial r3 finding 4, conformance r3
  finding 2). At most `limit` retries per request. Correcting the predicate
  makes the retry live, and a lagging or DEGRADED participant GSI (a thrown
  lookup degrades to an empty set) turns every candidate into a lag-shaped drop,
  so an unbounded retry doubles the reads of a page that returns nothing.
  DEVIATION, declared: the adjudication asked for the retry count on "the
  request-level WARN payload"; it rides the request-level `inbox feed assembled`
  INFO line instead, with `unresolvedDrops`. Reason: once capped at `limit` the
  retry is a per-request STATISTIC rather than a tripwire, no WARN in this route
  fires on the shape that produces it (the reviewer's own 200-lagged
  reproduction trips neither existing tripwire), and that line already carries
  scanned / seen / truncated.
- DRAINED IS NATURAL (4.4 PROBE BOUND consequence; adversarial r3 finding 2).
  Skipped-but-unprobed deleted threads no longer force `truncated` on a walk
  that drained. Wave 2's rule made a residue-only, genuinely caught-up org
  render the inbox FAILURE banner permanently. Full statement at 4.4.
- TODAY BOUNDS THE LOOKUPS (4.6; adversarial r3 finding 5). The unread pass
  keeps walking past the deleted-skip bound and stops LOOKING UP instead, with
  the declared cost that a deleted contact met past the bound can render.
- PROBE TRIPWIRE THRESHOLD (4.4 COST; conformance r3 finding 1). Fires on
  WASTED + SKIPPED, never on probes ATTEMPTED, so the resurfacing world wave 2
  declared legitimate stops raising "revisit index accrual" on every request.
  The payload reports attempted, wasted and skipped.
- ZERO-COUNT WARN DEPTH (4.4 SILENT ZERO; adversarial r3 finding 6 /
  conformance r3 finding 8). `warnTruncatedZeroCount` gains `skipped`.
- COST CLAIM CORRECTED (4.4 COST; adversarial r3 finding 3, conformance r3
  finding 3). The contact half is O(scanned index items), not O(visible
  unread): hidden deleted-contact threads pass `isUnreadVisible`, and the
  contact lookup is what discovers they are hidden. NO further bound in v1 -
  bounding contact resolution would re-create the walk-stop class round 2
  blocked - so the scanned-items WARN (500) is the trigger and
  docs/issues/contacts-batchget-amplified-reads.md (raised to HIGH, unread
  collector named the priority surface) is the remedy. Surfaced to the human.
- A6 CALL SITE GUARDED (no spec claim; conformance r3 finding 9). The contact
  delete wraps `propagateContactPresenceChange` so a throw there cannot 500 an
  already-persisted delete or swallow the authoritative reset emits behind it.
- 12b RELABELED (conformance r3 finding 4): its A3 bullet records an
  implementer narrowing as ratified design; it now says so, and the planner's
  ratification is on the record in the r3 adjudications.
- ACCEPTED, unchanged: an `unresolvedDrops`-only truncation on a FULL page has
  no client reader (adversarial r3 finding 7) - the flag is on the wire for the
  future affordance 4.5 step 3 already declares; and the two surfaces derive
  `truncated` by different routes (conformance r3 finding 5) - they converge on
  the same wire value, and the code now cross-references instead of forking.
