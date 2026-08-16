# Inbox Unread Index - Design Spec (2026-08-16)

Status: DRAFT v3 (post design-review rounds 1-2) for human review
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
  open conversations. Empty unread state = O(1) queries. (Indexed unread
  includes two invisible accrual classes - section 6.)
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
- Optimistic badge decrements from the tour/placement comms tabs and the
  contact/conversation auto-mark paths (v1 wires the Inbox page only - section
  4.7; the others reconcile via the now-cheap refetch).
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
so seed fixtures typecheck. WIRE EXPOSURE: the attribute deliberately appears
on no wire shape we construct (SSE payload and conversation summaries project
explicit fields - events.ts:100, api.ts:416); it DOES ride the raw item
returned by `GET /api/conversations/:conversationId` (api.ts:1688-1697), which
is accepted (internal client; ignores unknown fields).

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
- Status/lifecycle transitions (touchLastActivity, setRelayStatus,
  assignPoolNumberAndOpen, convertRelayGroupToGroupText, rebindOwner, roster
  and close-nag writers): none touch unread or the flag; NO changes.
- Contact soft-delete/restore: does not touch conversation rows; NO changes.

ACCEPTED ACCRUAL (invisible index residents) - TWO classes, both stated:

1. Relay groups closed while unread (invisible: inbox reads open+connecting
   only, inbox.ts:823). Resetting unread on close is REJECTED: today a
   reopened relay group resurfaces with its unread intact, and this design
   does not change product behavior.
2. Unread threads of soft-deleted contacts that fail the resurfacing rule
   (inbox.ts:537-576). Resetting unread on contact delete is REJECTED for the
   same reason (restore currently resurfaces old unread, and a post-deletion
   inbound re-increments anyway - the reset would not change resurfacing
   outcomes but WOULD change restore semantics).

Both classes stay indexed until something resets them. Consequences and
mitigations: sections 4.3 (walk budget + scan-resume), 4.4 (probe
short-circuit), 6 (cost accounting).

Pointer/claim partitions (`phone#`, `email#`, `token#`) never carry
unread_count and never enter the index (conversationsRepo.ts:1111-1119).

### 4.3 The server read layers

New module `app/src/lib/unreadFeed.ts` with TWO exports, layered so every
unread consumer shares ONE set of visibility rules.

LAYER 1 - `listUnreadConversations(deps, opts)`: conversation-level.

1. Queries `byUnread` newest-first (ScanIndexForward false), paging
   internally. RAW WALK BUDGET: UNREAD_WALK_LIMIT = 2000 index items - parity
   with the group walk this design retires (inbox.ts:181), sized so the
   accrual classes cannot plausibly exhaust it - with a WARN past
   UNREAD_WALK_WARN = 500 (the tripwire to revisit accrual). Accepts an
   optional exclusive-start position (a synthesized ExclusiveStartKey
   `{ unread_flag: 'unread', last_activity_at, conversationId }` - the GSI's
   full key shape for this hash-only-base-key table).
2. Applies VISIBILITY RULES per item, on projected attributes:
   - skip items without a positive `unread_count` (defends WITHIN-IMAGE
     inconsistency only - un-backfilled rows, a hypothetical broken writer -
     NOT GSI replication lag; section 6);
   - `relay_group`: keep iff status `open` or `connecting` (closed invisible,
     as today - inbox.ts:823);
   - `group_text`: keep iff status `group_open`;
   - everything else (the 1:1 bucket, matching today's NEGATIVE filter at
     inbox.ts:466 - including any legacy row with no `type`): keep iff status
     `open`.
3. Returns `{ items, scanPosition?, exhausted, truncated }`:
   - `scanPosition` = the (last_activity_at, conversationId) tuple of the
     last RAW item SCANNED (not the last item returned) - defined whenever
     anything was scanned, so a run of filtered items always advances the
     resume position and can never dead-end the feed;
   - `exhausted` = the index stream ended (underlying Query returned no
     LastEvaluatedKey);
   - `truncated` = the raw budget stopped the read before exhaustion.

Today (section 4.6) consumes layer 1 directly.

LAYER 2 - `collectUnreadRows(deps, opts)`: row-identity level, used by BOTH
the badge count and the Unread page so those two cannot diverge.

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
   with created_at > contact.deleted_at - inbox.ts:537-576). PROBE
   SHORT-CIRCUIT: a thread whose `last_activity_at <= deleted_at` cannot have
   a post-deletion message at all (a message never postdates its
   conversation's activity), so the messages.listByConversation(limit 1)
   probe runs ONLY for unread threads with activity NEWER than the deletion.
   The stable-no accrual class (4.2 class 2) therefore costs its index slot
   and contact resolution but NO per-request message reads.
3. Emits candidates in index order up to `opts.maxRows`. Returns
   `{ candidates, scanPosition?, exhausted, truncated, capped }` where
   `capped` = maxRows stopped emission (layer-1's `exhausted`/`truncated`
   pass through; `scanPosition` on a capped run is the position after the
   last index item CONSUMED, so resumption re-scans nothing and skips
   nothing).

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
- CURSOR SIZE (accepted): `s` grows by up to `limit` (30) contactIds per
  page (~45 bytes each), so the cursor is roughly 2KB at page 2 and 6KB by
  page 5 - inside Node's default 16KB header budget for a GET query param.
  A cursor whose seen-set exceeds SEEN_SET_MAX = 250 is rejected as invalid
  (400) rather than silently truncated: paging more than ~8 pages deep into
  Unread (250+ contact rows) has no product meaning (the badge caps at
  100), and silently dropping ids would break the dedupe guarantee.
- Non-contact candidates need no seen-set: an unknown row's phone and a
  group/relay row's conversationId each map to exactly ONE index item, so
  they cannot straddle pages.

### 4.4 Badge endpoint

`GET /api/inbox/unread-count` ->
`{ unreadCount: number, capped: boolean, truncated: boolean }`

- `collectUnreadRows` with `maxRows = BADGE_COUNT_CAP = 100` and no cursor.
- `capped` = the cap stopped counting (count is a floor at the cap).
  `truncated` = the raw walk budget stopped scanning first (count is a
  floor for a different reason; pathological - see 4.3 budget sizing). The
  two are DISTINCT wire fields because the client treats them differently
  (4.7): a capped count is "99+" and must not be decremented; a truncated
  count is small and real-so-far and SHOULD still decrement.
- No hydration: no previews, placement labels, or latest-message reads
  (the deleted-contact probe is a visibility rule, and runs only for
  threads with post-deletion activity - 4.3 step 2).
- COST: empty unread = 1 index query. N unread 1:1s = 1 index query + N
  contact resolutions. PLUS the accrual classes (4.2): each closed-unread
  relay group costs an index slot; each deleted-contact unread thread costs
  an index slot + a contact resolution (probe short-circuited unless
  activity postdates deletion). This endpoint is the highest-frequency call
  in the app (every SPA boot + every debounced conversation event per
  connected dashboard) - the accrual WARN (4.3) is the signal to revisit.
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

1. Collect candidates (excludeContactIds from the cursor's seen-set), hydrate
   them (below), drop the ones hydration disqualifies, and REPEAT - resuming
   from the returned scanPosition - until `limit` hydrated rows are in hand
   OR the index stream is exhausted OR the raw budget is spent.
2. `nextCursor` is non-null IFF the stream is neither exhausted nor
   budget-truncated with nothing more to serve: concretely, null when the
   final collect returned `exhausted` (all remaining index items consumed),
   else the cursor built from the final scanPosition + accumulated seen-set.
   INVARIANT PRESERVED: an empty `rows` array implies `nextCursor: null`
   (the loop only stops short of `limit` on exhaustion/budget), so the
   dashboard's empty-state and Load-more gating
   (Inbox.tsx:130-158 renders both off `rows.length`) keep working
   unchanged. A budget-truncated run that produced zero rows returns an
   empty page with a null cursor and `groupsTruncated` absent - the
   pathological-accrual case the WARN exists for; accepted.

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
become a SECOND pass fed by `listUnreadConversations` (layer 1), filtered to
the 1:1 bucket - preserving per-conversation type/timestamp semantics.

- ORDERING PRESERVED: the unread pass still runs before the contacts-triage
  pass, which consumes `emittedUnknownPhones` (today.ts:520, :590, :726).
- CAP: the pass takes at most TODAY_UNREAD_CAP = 100 unread conversations,
  announcing truncation via the existing warnIfCapped (today.ts:354-356).
  SELECTION CHANGE: the newest-100-unread by activity, rather than
  unread-within-the-first-100-open. The NUMERIC bound is unchanged but the
  REALIZED payload is larger on unread-heavy data (today only the unread
  subset of the first 100 open threads emitted; now up to 100 items all
  emit). That growth is the point (the silent-miss fix) and is bounded by
  the same 100.
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
     The follow-up expires nothing (no clears remain from this action) so
     it cannot cascade; it exists purely to observe the index after
     propagation. PENDING_CLEAR_TTL_MS = 10_000 stays as backstop when no
     reconcile happens at all. Residual: if the GSI is STILL stale at
     t+2.3s, the badge shows the stale count until the next event/refetch;
     accepted (server remains authority).
   - Generation guard: a fetch resolving after a newer fetch started is
     discarded (a stale in-flight response cannot clobber newer state).
   - Clamp: displayed count never negative.
3. CALLERS (v1 scope decision): ONLY `useInbox.markRead` - all four
   branches, after the `:263` unreadCount guard and the `:283`
   addressability guard, keyed by the existing rowKey(); rollback in the
   existing `.catch` (useInbox.ts:291-293). Inbox rows are by construction
   rows the badge counts (same collector + visibility rules; closed relay
   rows never render there). The tour/placement channel hooks and the
   contact/conversation auto-marks are NOT wired (the hooks cannot know row
   kind or badge visibility; the auto-marks fire blind on mount). Those
   paths reconcile via the cheap refetch - the pre-existing behavior minus
   ~1.5s.
4. RECONNECT RECONCILE: subscribe `onOpen` (EventStreamProvider.tsx:57) ->
   scheduleRefetch, correcting drift after an SSE blackout.
5. The 300ms SSE debounce and the unmatched-email half are unchanged.

The Inbox page keeps its own optimistic row-drop; useInbox changes only by
the noteRowsCleared/rollback wiring. AppFrame.test's useUnread stub and
Inbox.test's baseState factory gain the new fields (section 8).

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

No other wire shapes change. InboxRow/InboxPage are untouched
(`groupsTruncated` is simply never present on filter=unread responses -
section 4.5).

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
- ACCRUAL (4.2's two classes) costs: index slots + walk budget; deleted-
  contact residents also cost a contact resolution per badge request (probe
  short-circuited per 4.3). The raw budget (2000) is sized so accrual
  cannot plausibly blind the feed; the WARN at 500 is the tripwire to
  revisit (e.g. an ops sweep resetting ancient invisible unread - a future
  decision, not this feature).
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
   backfillConsentMethod.ts). BOTH directions: stamp `unread_flag` where
   `unread_count > 0` and absent; REMOVE where present with count 0/absent.
   Skips pointer partitions (`phone#`/`email#`/`token#` prefixes).
3. LOCAL SCHEMA UPDATE (no data loss): `ensureTable` is create-only and
   `db-create --reset` would destroy the human's imported local dataset. New
   script `app/scripts/db-update-gsis.ts` (localhost-endpoint-guarded like
   db-create's reset): diff TABLES GSIs against each live local table, issue
   UpdateTable CreateGlobalSecondaryIndex for missing ones, wait ACTIVE.
   Disposable e2e lanes are wiped instead (hc-local-<L>-* under the lane's
   own access key, per docs/issues/e2e-lane-tables-stale-schema.md).
4. ORDER OF OPERATIONS (human-run, recorded in RUNBOOK): dev:
   `npm run plan -- dev` -> `npm run apply -- dev` (NOTE: the plan carries
   the entire owed backlog - byJurisdiction delete, several new tables and
   GSI adds/drops, per RUNBOOK.md:117-220; expected, not an error) ->
   `tsx app/scripts/backfill-unread-flag.ts --dry-run` then live ->
   `npm run deploy:dev`. Schema BEFORE code (RUNBOOK.md:85-92). Prod rides
   the M1.11 gate. Local: `tsx app/scripts/db-update-gsis.ts` -> backfill ->
   restart dev stack.
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
  routes.ts:753-755 pin the channel hooks, which v3 does NOT edit - leave
  alone.
- app/scripts/profile-inbox.ts / lib/inboxDiagnostics.ts: the plan's
  `unread-badge` case switches to driving the unread-count function; a
  `unread-page` case stays on aggregateInbox at limit 30.
- dashboard: AppFrame.test.tsx's useUnread stub (:6-8) and Inbox.test.tsx's
  baseState factory (:13-25) gain the new fields.

NEW TESTS:

Unit (app/test):
- conversationsRepo: incrementUnread sets flag+count atomically (absent->1
  creates flag; repeats keep it); resetUnread zeroes count and REMOVEs flag;
  both idempotent; either ordering leaves flag consistent with count.
- unreadFeed layer 1: visibility matrix (open/closed/connecting relay,
  group_open, 1:1 bucket incl. a type-less row, pointer-partition skip);
  scanPosition advances across a FULLY-FILTERED run (no dead-end);
  exhausted vs truncated; WARN threshold.
- unreadFeed layer 2: contact grouping (multi-phone + phone+email merge to
  one candidate); excludeContactIds suppression; unknown-number candidates;
  contactless email skipped; deleted-contact resurfacing (fresh-inbound yes
  / pre-deletion no / outbound no) AND the probe short-circuit (a thread
  with activity <= deleted_at issues NO message read); capped vs truncated
  vs exhausted; scanPosition on a capped run resumes without re-scan or
  skip.
- inbox route (filter=unread): per-row content parity with pre-change
  fixtures; unified composition (kinds interleaved, limit respected, cursor
  pages overflow of every kind); FILL-OR-EXHAUST (hydration drops refill
  the page; empty rows implies null nextCursor - including a bulk-fan-out
  mark-read race fixture); multi-thread contact split across pages
  suppressed by the seen-set (incl. equal-timestamp boundary items);
  cursor namespacing (unread cursor under other filters -> 400, vice
  versa, oversized seen-set -> 400); groupsTruncated never present;
  zero-unread dataset -> empty page, 1 index query, NO
  contact/message/placement calls (call-count assertions).
- unread-count endpoint: counts rows not conversations; capped and
  truncated distinguished; deleted-contact parity with the page; zero
  state = 1 call.
- today route: unread sections fed by layer 1; an unread thread outside the
  first-100-open window surfaces; relay opt-out scan unaffected;
  emittedUnknownPhones ordering preserved; TODAY_UNREAD_CAP + warnIfCapped.
- Seeds guard: fixture arrays carry unread_flag iff unread_count > 0.
- backfill planner: stamp / remove / skip / pointer-row cases.
- UnreadContext: optimistic decrement synchronous (before any debounce);
  idempotent per key; expiry on first post-clear resolved fetch + the
  SINGLE follow-up reconcile (scheduled once, no cascade); TTL backstop;
  rollback; generation guard; clamp at 0; capped suppression (and NO
  suppression on truncated-only); no-op defaults (bare render safe);
  memoized value; onOpen refetch.
- useInbox: noteRowsCleared fires exactly once per guarded mark-read,
  rollback on failure; useMarkContactRead does NOT touch the badge context.

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
- Neither badge nor Unread page issues per-OPEN-conversation calls; cost
  scales with indexed unread (incl. stated accrual) plus per-page hydration
  bounded by limit.
- A fully-filtered index prefix can never permanently empty the feed
  (scan-position resume + fill-or-exhaust + 2000 budget).
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
  fan-out), inbox.ts:1015 (contact fan-out). All become flag-removers
  automatically.
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
