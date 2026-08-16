# Inbox Unread Index - Design Spec (2026-08-16)

Status: DRAFT v2 (post design-review round 1) for human review
Branch: feat/inbox-unread-index (worktree W:/tmp/inbox-unread-index, cut from main @41627198)
Issue: docs/issues/inbox-unread-sse-full-walk.md (this spec is the "separate design" it calls for)
Related: docs/issues/inbox-filter-tabs-full-walk.md (unread half resolved here; unknown half stays open)
Design review: round-1 adjudications at .superpowers/design-review/adjudications.md

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
  open conversations. Empty unread state = O(1) queries. (Bounded caveat:
  permanently-invisible unread rows accrue in the index - section 6.)
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
  CONSEQUENCE (accepted limitation): a relay group closed while unread keeps
  its flag - invisible to every reader (visibility rules below) yet indexed -
  until something resets it. These rows consume walk budget (section 6).
  Resetting unread on close was considered and REJECTED: today a reopened
  relay group resurfaces with its unread intact, and this design does not
  change product behavior.

Pointer/claim partitions (`phone#`, `email#`, `token#`) never carry
unread_count and never enter the index (conversationsRepo.ts:1111-1119).

### 4.3 The server read layers

New module `app/src/lib/unreadFeed.ts` with TWO exports, layered so every
unread consumer shares ONE set of visibility rules:

LAYER 1 - `listUnreadConversations(deps, opts)`: conversation-level.

1. Queries `byUnread` newest-first (ScanIndexForward false), paging internally
   up to a raw walk budget (UNREAD_WALK_LIMIT = 500 index items; WARN past
   400). Accepts an optional exclusive-start boundary (below).
2. Applies VISIBILITY RULES per item, using projected attributes (free -
   projection ALL):
   - skip items without a positive `unread_count` or without `type`-agnostic
     required fields (defensive; also catches un-backfilled or
     writer-bug rows where flag and count disagree within one item image -
     NOT a defense against GSI replication lag, see section 6);
   - `relay_group`: keep iff status is `open` or `connecting` (closed stays
     invisible, as today - inbox.ts:823);
   - `group_text`: keep iff status is `group_open`;
   - everything else (the 1:1 bucket, matching today's NEGATIVE filter at
     inbox.ts:466 - including any legacy row with no `type`): keep iff
     status is `open`.
3. Returns `{ items, boundary?, truncated }` where `boundary` is the
   (last_activity_at, conversationId) tuple of the last RETURNED item and
   `truncated` means the walk budget stopped the read.

Today (section 4.6) consumes layer 1 directly.

LAYER 2 - `enumerateUnreadRows(deps, opts)`: row-identity level, used by BOTH
the badge count and the Unread page so those two cannot diverge.

1. Walks layer-1 items newest-first, grouping into ROW CANDIDATES:
   - relay_group / group_text conversation -> its own candidate (keyed by
     conversationId);
   - 1:1 conversation -> resolve the contact (contacts.findByPhone, then
     findByEmail - the rowForConversation resolution order, inbox.ts:476-477).
     Resolved contact -> ONE candidate per contactId (first/newest index item
     is the candidate's REPRESENTATIVE; later items of the same contact merge
     silently). No contact + phone -> unknown-number candidate keyed by
     phone. No contact + no phone (contactless email thread) -> skipped
     (parity with inbox.ts:489).
   - The enumerator does NOT compute unread sums (the page hydrates fresh
     ones; the badge needs none).
2. DELETED CONTACTS: a candidate whose contact isDeleted survives only under
   the resurfacing rule - some unread thread's newest message is an inbound
   with created_at > deleted_at (probe: messages.listByConversation(limit 1)
   per unread thread of DELETED contacts only, matching inbox.ts:537-576).
3. Emits candidates in index order up to `opts.maxRows`; returns
   `{ candidates, boundary?, truncated, saturated }` where `boundary` is now
   the index tuple of the LAST EMITTED candidate's representative item and
   `saturated` means maxRows stopped emission.

CURSOR AND SPLIT-PROOF RESUME (the round-1 blocking finding, resolved):

- The page cursor is the base64url of `{ u: 1, a: <last_activity_at>,
  c: <conversationId> }` - the boundary tuple of the last emitted candidate's
  representative index item. It is NOT a raw DynamoDB LastEvaluatedKey: LEKs
  address fetch boundaries, not consumption boundaries, and one candidate can
  consume several index items (the existing pager pays a boundary re-query
  for exactly this reason, inbox.ts:770-788). A synthesized ExclusiveStartKey
  `{ unread_flag: 'unread', last_activity_at: a, conversationId: c }` resumes
  the index walk exactly after that item.
- The `u: 1` tag namespaces the cursor; decodeCursor/decodeGroupCursor gain
  the matching cross-filter rejection (a tagged unread cursor under any other
  filter -> 400, and vice versa - same posture as the group cursor today).
- ORDERING TUPLE: all order comparisons use (last_activity_at DESC,
  conversationId DESC as tiebreak) - the GSI's own item ordering for equal
  range values is resumed exactly via the synthesized key, and OUR guard
  comparisons use the same explicit tuple, so equal timestamps (bulk imports
  write identical ones) cannot double-serve or drop a row.
- ONE ROW PER CONTACT ACROSS PAGES: on a resumed enumeration, when a 1:1 item
  resolves to a contact, compute the contact's newest VISIBLE unread thread:
  the newest tuple among the contact's open 1:1 conversations (via the
  contact-thread resolution in step 1's sense) that carry unread_flag. If
  that tuple sorts STRICTLY NEWER than the cursor boundary tuple, the contact
  was already emitted on an earlier page -> suppress. Because the contact
  bucket contains only open 1:1s (always visible), the guard's visibility can
  never disagree with enumeration's. This restates today's newest-conversation
  rule (inbox.ts:522-527) against the index stream, tie-safe via the tuple.

### 4.4 Badge endpoint

`GET /api/inbox/unread-count` -> `{ unreadCount: number, saturated: boolean }`

- `enumerateUnreadRows` with `maxRows = BADGE_COUNT_CAP = 100`;
  `saturated: true` when maxRows or the walk budget stopped it.
- No hydration: no previews, placement labels, or latest-message reads
  (except the deleted-contact resurfacing probe, a visibility rule).
- Cost: empty unread = 1 index query. N unread 1:1s = 1 index query + N
  contact resolutions (+ probes for deleted contacts only).
- Registered above the `/:contactId/read` param route; no collision with
  existing inbox routes (GET `/`, POST `/read`, POST `/:contactId/read`).
- Error posture: normal 500; the client collapses any error to "no badge".

DECLARED BEHAVIOR CHANGES (badge semantics):

- Today's badge count is NOT capped at 100: `limit=100` bounds only the
  contact pager, then relay rows merge additively uncapped and ALL unread
  group rows merge via the 2000-item walk (inbox.ts:798-887;
  UnreadContext.tsx:32-38 documents that group unread is deliberately exempt
  from the limit). The new count caps ALL row kinds at 100 candidates, and
  group rows now compete for that cap. The visible badge already capped at
  99+ (NavContents.tsx:67), so the display changes only in that the
  aria-label - previously the uncapped row count, which could exceed 100 -
  now reads at most "100 unread". Accepted: a count above 99 has no display
  fidelity anyway.

### 4.5 Unread page (`GET /api/inbox?filter=unread`)

The `filter=unread` branch of aggregateInbox is rewritten to consume
`enumerateUnreadRows` (maxRows = the request `limit`) instead of the contact
pager + additive relay merge + group walk.

DECLARED BEHAVIOR CHANGE - PAGE COMPOSITION: today's `filter=unread` page one
is up to `limit` CONTACT rows PLUS all unread relay rows PLUS all unread
group rows additively (it can exceed `limit`). The new page is a SINGLE
unified stream: up to `limit` rows total, all kinds interleaved newest-first,
with a real cursor over the whole stream (overflow of ANY kind reaches later
pages via Load more). Row CONTENT is preserved; page composition is not, and
the fixture-parity tests assert per-row content, not page shape.

`groupsTruncated` under filter=unread now means ONLY "the walk budget
withheld rows" (enumerator `truncated`); group rows withheld by the page
limit are behind `nextCursor` instead of silently dropped, so the "showing
the latest" affordance yields to the pager. (Under filter=all nothing
changes.) The dashboard needs no code change for this (it already renders
both affordances), but the semantics are declared here because the old
full-walk contract test pins the opposite (section 8).

HYDRATION (bounded by the page limit; the page is FRESH even when the index
is stale - the base-table reads below are authoritative):

- contact candidates: `contactConversations` - the aggregateInbox wrapper
  that filters conversationsForContact to `status === 'open' &&
  type !== 'relay_group'` (inbox.ts:373-395; NOT the raw
  conversationsForContact union) - once per contact; newest conversation =
  representative for phone/lastActivityAt/placement exactly as today
  (inbox.ts:522-533); unreadSum re-summed over the FRESH set; if the fresh
  sum is 0 the row is DROPPED (today's passesFilter contract,
  inbox.ts:441-445 - the badge may briefly have counted it; converges on the
  next reconcile); latestMessageOf(maxConv) once; placement label if present.
- relay_group / group_text / unknown candidates: ONE point read of the
  conversation (the getter behind GET /api/conversations/:conversationId)
  refreshes status + unread_count; drop the row if no longer visible or
  unread; then hydrate exactly as today (latestMessageOf for unknown rows;
  relayRowFor / groupRowFor need no further reads).
- Deleted-contact resurfacing carries over unchanged inside the enumerator +
  hydration (probe reads as in 4.3; presentation reuses maxConv's latest
  message as today, inbox.ts:552-561).

Rows within the page sort by displayed lastActivityAt (as today). ACCEPTED
ORDERING NUANCE: a contact row displays its newest OVERALL thread's activity
while the index orders by newest UNREAD activity; cross-page ordering can
wobble for multi-thread contacts whose newest thread is read (today's feed
has an analogous wobble from its additive merges).

All other filters (`all`, `unknown`, `groups`) are UNTOUCHED, including the
early-rejection behavior from main @39c1aa41. GROUP_UNREAD_WALK_LIMIT /
GROUP_UNREAD_GROWTH_THRESHOLD and the unread group walk die with this rewrite
(the filter=all group source keeps its page-one cap and walk budget as-is).

Mark-read routes are unchanged (they call resetUnread, which now maintains
the flag).

### 4.6 Today page unread source

today.ts keeps its single open-partition query (today.ts:529) and loop - the
relay opt-out attention scan lives INSIDE that loop, ordered before the
unread gate (today.ts:538-543), and keeps working unchanged. What moves: the
unread gate (today.ts:581-582) and everything downstream of it (the
unknown-triage needs_you_now items and the unreplied items, today.ts:584-641)
leave the loop and become a SECOND pass fed by `listUnreadConversations`
(layer 1), filtered to the 1:1 bucket - preserving each item's
per-conversation type/timestamp semantics.

- ORDERING PRESERVED: the unread pass still runs before the contacts-triage
  pass, which consumes `emittedUnknownPhones` (today.ts:520, written :590,
  read :726).
- CAP PRESERVED: the pass takes at most TODAY_UNREAD_CAP = 100 unread
  conversations (the current effective bound) and announces truncation via
  the existing warnIfCapped mechanism (today.ts:354-356). The behavior
  change is the SELECTION: the newest-100-unread by activity, rather than
  unread-within-the-first-100-open. Payload size stays bounded exactly as
  today.
- NET COST: Today gains one index query and loses nothing (the open walk
  stays for relay opt-out). G5 is a correctness fix, not a cost fix.

### 4.7 Client: optimistic badge + fast reconcile

UnreadContext changes (dashboard/src/app/UnreadContext.tsx):

1. FETCH SWAP: `fetchCount` calls new `getUnreadCount()`
   (api/endpoints.ts next to getInbox; type
   `InboxUnreadCount { unreadCount: number; saturated: boolean }` next to
   InboxPage in api/types.ts). Error posture unchanged: any error -> null.
2. OPTIMISTIC LAYER: context value becomes
   `{ unread, unmatchedUnread, noteRowsCleared, rollbackRowsCleared }`, with
   NO-OP function defaults on the createContext value (provider-less renders
   - existing tests mount hooks bare - must not throw), and the provider
   value memoized (every nav leaf consumes this context, NavContents.tsx:40).
   - State: `serverCount`, `saturated`, `pendingClears: Map<rowKey,
     clearedAtMs>`, and a fetch generation counter.
   - Displayed `unread = serverCount === null ? null : saturated ?
     serverCount : max(0, serverCount - pendingClears.size)`. While
     SATURATED the optimistic subtraction is suppressed entirely - the
     count is a cap, not a number, and decrementing it would flick
     99+ -> 99 -> 99+.
   - `noteRowsCleared(keys)` inserts keys (idempotent by key: the row-click +
     contact-page double-POST and StrictMode double-invoke cannot
     double-decrement). `rollbackRowsCleared(keys)` deletes them (wired into
     the mark-read failure path).
   - EXPIRY: a pending clear expires when ANY fetch that STARTED after the
     clear was recorded RESOLVES successfully - full stop, no value
     comparison (a value predicate creates stuck states: a clear that
     cleared nothing, or a new inbound during the window, would pin a wrong
     badge for the whole TTL). PENDING_CLEAR_TTL_MS = 10_000 remains only as
     a backstop when no reconcile happens. Consequence (accepted): if GSI
     lag outlives the ~300ms debounce + fetch, the badge can briefly bounce
     back up until the next event's refetch - the server stays the
     authority.
   - Generation guard: a fetch that resolves after a newer fetch started is
     discarded (prevents a stale in-flight response from clobbering newer
     state - the abort ref alone does not cover this interleaving).
   - Clamp: displayed count never negative.
3. CALLERS (v1 scope decision): ONLY `useInbox.markRead` - all four branches,
   after the `:263` unreadCount guard and the `:283` addressability guard,
   keyed by the existing rowKey(); rollback in the existing `.catch`
   (useInbox.ts:291-293). Inbox rows are by construction rows the badge
   counts (same enumerator; closed relay rows never render there), so the
   decrement is always sound. The tour/placement channel hooks and the
   contact/conversation auto-mark paths are NOT wired (the channel hooks
   cannot know row kind or badge visibility - a closed relay group's
   mark-read would decrement a row the badge never counted; the auto-marks
   fire blind on mount). Those paths reconcile via the cheap refetch, which
   is the pre-existing behavior minus ~1.5s.
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
page draw from the SAME enumerator and visibility rules; the numbers can
still diverge transiently (the page hydrates fresh base-table state and drops
newly-read rows; the badge reads index state and runs in its own request) and
converge on reconcile. No strict badge==page equality is claimed.

## 5. Wire contract additions

```
GET /api/inbox/unread-count
200 { "unreadCount": number, "saturated": boolean }
```

No other wire shapes change. InboxRow/InboxPage are untouched.

## 6. Consistency model (explicit)

- The GSI is eventually consistent, and a stale index entry is stale in its
  PROJECTED attributes too - a projection-side `unread_count > 0` check
  CANNOT detect replication lag (the lingering entry still carries the old
  positive count). Therefore:
  - the BADGE accepts index staleness outright: a just-read conversation may
    be counted until the index catches up; the user's own action is masked
    by the optimistic layer; other operators' actions converge on the next
    reconcile. No per-candidate base reads (that would double the badge's
    cost for a window that is typically milliseconds).
  - the PAGE is fresh despite index staleness: every rendered row is
    re-verified against base-table reads during hydration (contact rows via
    contactConversations; relay/group/unknown rows via a point read) and
    dropped if no longer unread/visible.
  - layer 1's projected-attribute checks defend only against
    WITHIN-IMAGE inconsistency (un-backfilled rows, a hypothetical broken
    writer), and the spec claims nothing more for them.
- A just-arrived unread may be briefly missing from the index; the
  SSE-triggered refetch lands 300ms+ later; accepted.
- Permanently-invisible indexed rows (closed-while-unread relay groups)
  accrue (section 4.2) and consume walk budget; `truncated`/`saturated` can
  therefore fire early in pathological accumulations. Accepted at current
  scale; the WARN past 400 raw items is the tripwire.
- The pre-existing emit gap (increment succeeds, touchLastActivity throws,
  no SSE event - twilio.ts:604-618 et al.) leaves the INDEX correct and only
  delays client refresh; unchanged by this design.
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

EXISTING TEST SURFACES THAT CHANGE (enumerated; this is real builder work):

- In-memory fakes gain the index, KEYED OFF `unread_flag` (not
  unread_count>0) so the invariant is actually exercised end-to-end:
  app/test/helpers/twilioWebhookHarness.ts:403 (its incrementUnread /
  resetUnread at :447-458 must model the flag), app/test/inboxFeed.test.ts:
  69-115 (hand-built GSI fake, cast `as unknown as ConversationsRepo` - a
  missing method is a runtime TypeError), app/test/contactCapture.test.ts:130.
- Fixtures seeding nonzero unread gain the flag (flag iff count > 0):
  inboxApi.test.ts (:100-101,174,194-196,322-334,418-434,493,532),
  inboxEmail.test.ts (:79-175), contactSoftDelete.test.ts (:96-97,116),
  inboxFeed.test.ts (:193-240 and the filter='unread' cases),
  inboxGroups.test.ts (:265-296), contactTriage.test.ts (:91),
  inbox.integration.test.ts (:311), performanceSeed.integration.test.ts
  (:409).
- inboxGroups.test.ts:265 pins the retired full-partition-walk contract
  ("returns ALL unread group threads under filter=unread") - REWRITTEN to
  the unified-stream contract (group rows beyond the page limit reachable
  via cursor).
- e2e/performance CONTRACT MIGRATION (required gate - these are unit-tested
  pins): COLD_SHELL_GETS' badge entry (routes.ts:239) becomes the new
  path-only endpoint; the classifier keyed on `filter==='unread' &&
  limit==='100'` (collect.ts:162) becomes a path match for
  /api/inbox/unread-count (also ensuring an Unread-page request at limit 100
  is NOT misclassified as the badge); shell-request detection (collect.ts:
  175-179), classAware (:128), and the warm-mode special case (:362) keep
  working against the new class shape; line-pinned code-evidence references
  (routes.ts:666,720,753-755,761) update to the edited files; pinned tests
  (routes.test.ts:48, collect.test.ts:207-315 badge cases, report.test.ts:
  561,580) update accordingly.
- app/scripts/profile-inbox.ts / lib/inboxDiagnostics.ts: the profile plan's
  `unread-badge` case switches from `aggregateInbox(filter=unread,limit=100)`
  to driving the unread-count function, so the acceptance criteria below
  have an evidence path; a new `unread-page` case stays on aggregateInbox at
  limit 30.
- dashboard: AppFrame.test.tsx's useUnread stub (:6-8) and Inbox.test.tsx's
  baseState factory (:13-25) gain the new fields.

NEW TESTS:

Unit (app/test):
- conversationsRepo: incrementUnread sets flag+count atomically (absent->1
  creates flag; repeats keep it); resetUnread zeroes count and REMOVEs flag;
  both idempotent; either ordering of reset/increment leaves flag consistent
  with count.
- unreadFeed layer 1: visibility matrix (open/closed/connecting relay,
  group_open, 1:1 bucket incl. a type-less row, pointer-partition skip),
  walk budget + truncated + WARN, boundary resume via synthesized key,
  within-image inconsistency skip.
- unreadFeed layer 2: contact grouping (multi-phone and phone+email merge to
  one candidate), unknown-number candidates, contactless email skipped,
  deleted-contact resurfacing (fresh-inbound yes / pre-deletion no /
  outbound no), maxRows + saturated, tie-safe cursor resume: equal
  last_activity_at across the boundary neither double-serves nor drops;
  multi-thread contact split across pages suppressed on page 2.
- inbox route (filter=unread): per-row content parity with pre-change
  fixtures (fields byte-equal for the same seed rows); unified composition
  (kinds interleaved, limit respected, cursor pages the overflow); cursor
  namespacing (unread cursor under other filters -> 400 and vice versa);
  zero-sum-after-hydration row dropped; stale-index row dropped via point
  read; groupsTruncated only from walk budget; zero-unread dataset -> empty
  page, 1 index query, NO contact/message/placement calls (call-count
  assertions per the existing idiom).
- unread-count endpoint: counts rows not conversations; saturation both ways
  (maxRows, walk budget); deleted-contact parity with the page; zero state
  = 1 call.
- today route: unread sections fed by layer 1; a fixture with an unread
  thread outside the first-100-open window now surfaces; relay opt-out scan
  unaffected (still produced with the unread pass moved out);
  emittedUnknownPhones ordering preserved; TODAY_UNREAD_CAP + warnIfCapped.
- Seeds guard: fixture arrays carry unread_flag iff unread_count > 0.
- backfill planner: stamp / remove / skip / pointer-row cases.
- UnreadContext: optimistic decrement synchronous (asserted before any
  debounce); idempotent per key; expiry on first post-clear resolved fetch;
  TTL backstop; rollback; generation guard discards a stale in-flight fetch;
  clamp at 0; saturated suppression (no decrement while saturated); no-op
  defaults (bare render does not throw); memoized value; onOpen refetch.
- useInbox: noteRowsCleared fires exactly once per guarded mark-read,
  rollback on failure; useMarkContactRead does NOT touch the badge context.

Integration (DynamoDB Local, per relayRepos.integration.test.ts precedent):
- byUnread returns exactly flagged rows newest-first; increment/reset
  round-trip visible through the index; synthesized-ExclusiveStartKey resume
  matches the GSI's native order across an equal-timestamp tie; backfill
  script both directions against a mixed-state table (positive / zero /
  absent / pointer row).

E2E:
- NEW spec: nav Inbox badge - seed unread, badge shows count; open the row;
  badge decrements IMMEDIATELY (assert before the reconcile could land,
  raced-response idiom per group-text-inbox.spec.ts); a group-text row
  decrements too. First nav-badge e2e coverage.
- Existing inbox-markread.spec.ts, group-text-inbox.spec.ts,
  deleted-contact-resurfacing.spec.ts stay green (they pin row-level
  semantics this design preserves).

Performance evidence:
- `npm run perf:inbox` before/after, >= 5 repeats: unread-page (limit 30)
  and the new badge case drop from ~1,230 calls to O(indexed unread)
  (target: <= 3 calls on the zero-unread dataset); all-page/groups-page
  unchanged. Report calls eliminated + remaining; local medians are
  DynamoDB-Local-bound evidence only.

## 9. Acceptance criteria

- Badge request on a zero-unread dataset: 1 index query, no hydration calls.
- Unread page on a zero-unread dataset: 1 index query, empty rows.
- Neither badge nor Unread page issues per-OPEN-conversation calls; cost
  scales with indexed unread candidates (plus per-page hydration bounded by
  limit).
- Badge decrements at click time on Inbox mark-read paths, never negative,
  suppressed while saturated; a failed mark-read restores it; reconcile
  converges (bounce under GSI lag is bounded by the next refetch).
- Unread row CONTENT unchanged for identical data (per-row parity tests +
  existing e2e); page COMPOSITION per section 4.5's declared change.
- All/unknown/groups filters and their costs untouched.
- Sparse-flag invariant across every writer (unit + integration + seed guard
  + backfill tests); fakes key their index off the flag.
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
  attribute_not_exists(conversationId), so no runtime whole-item write can
  clobber the flag.
- Status/lifecycle transitions: no unread writes; no flag writes; reader
  status filters preserve visibility (closed-while-unread accrual accepted -
  sections 4.2/6).
- Seeds: performance.ts:820/:889 conditionally per row; others zero/absent.
- Deletes (import retract, devReset, performanceSeed lean-group delete): GSI
  entries drop with the item.

READERS of unread state (all accounted for):
- inbox.ts filter=unread + the badge -> the two unreadFeed layers (this
  design).
- inbox.ts deleted-resurfacing + unreadSum -> preserved (enumerator +
  hydration).
- today.ts unread gate -> layer 1 (this design); relay opt-out scan keeps
  the open-partition walk.
- api.ts:416 summaries + :1697 raw detail -> counter attribute only;
  unchanged (raw detail now also carries unread_flag; accepted).
- events.ts:100 SSE payload -> unchanged.
- e2e/performance harness -> badge contract migrated (section 8).
- app/scripts/profile-inbox.ts -> plan updated (section 8).
- Dashboard: UnreadContext (rewired), useInbox rows (shape unchanged),
  usePlacementChannels/useTourChannels first-page unread dots (unchanged;
  their documented first-page limitation is out of scope), fake-twilio's
  groupUnreadByPool (different counter entirely; untouched).
- Test fakes and fixtures -> section 8's migration list.

## 11. Follow-up issues

- docs/issues/contacts-batchget-amplified-reads.md (filed on this branch):
  the agreed next mission.
- inbox-unread-sse-full-walk.md -> resolved by this feature when the build
  lands (status flipped on this branch).
- inbox-filter-tabs-full-walk.md -> updated: unread half resolved here,
  unknown half remains open.
