# Inbox Unread Index - Design Spec (2026-08-16)

Status: DRAFT for human review
Branch: feat/inbox-unread-index (worktree W:/tmp/inbox-unread-index, cut from main @41627198)
Issue: docs/issues/inbox-unread-sse-full-walk.md (this spec is the "separate design" it calls for)
Related: docs/issues/inbox-filter-tabs-full-walk.md (unread half resolved here; unknown half stays open)

## 1. Problem

Two defects, one root cause:

1. READ AMPLIFICATION. Finding unread conversations requires walking every OPEN
   conversation because unread state is not queryable. Measured on the imported
   real dataset (610 open 1:1 conversations, zero unread): the nav badge request
   (`GET /api/inbox?filter=unread&limit=100`) made 1,840 serial repository calls
   (~20s median) before the early-rejection fix, and still makes 1,230 calls
   (~1.8s median) after it. The badge fires on every SPA boot and after every
   debounced `conversation.updated` SSE event on every connected dashboard, so
   inbound traffic multiplies this cost. The Unread page pays the same walk, and
   `filter=unread` additionally performs an accepted full group-partition walk
   (GROUP_UNREAD_WALK_LIMIT = 2000, app/src/routes/inbox.ts:181) whose own code
   comment says "time to materialize unread counts".

2. BADGE STALENESS. Opening an unread thread updates the Inbox page's own list
   optimistically (useInbox.ts:261-297) but the nav badge has no optimistic
   path: it waits for server commit -> SSE -> 300ms debounce -> a full unread
   walk. The user sees the badge lag ~2s behind the action.

## 2. Goals

- G1: Unread discovery cost proportional to ACTUAL unread conversations, not
  open conversations. Empty unread state = O(1) queries.
- G2: A dedicated cheap badge-count endpoint; the badge never depends on the
  row-list response shape or its page limit.
- G3: The nav badge reflects the user's own mark-read actions instantly
  (optimistic), with the server as reconciling authority.
- G4: The Unread page uses the same index; no per-open-conversation walks.
- G5: Today's unread-driven sections (needs_you_now unknown triage, unreplied)
  stop depending on the first-100-open-conversations cap.
- G6: Row-level behavior of the Unread feed is preserved: contact dedupe with
  contact-wide unread sums, unknown-number rows, relay-group rows
  (open+connecting only), native-group rows, deleted-contact resurfacing.

## 3. Non-goals

- The `unknown` filter walk (needs contact resolution to decide triage; stays
  as-is, tracked by inbox-filter-tabs-full-walk).
- Latest-message denormalization onto the conversation record (decided against:
  the All page and the bounded Unread page hydrate at most one page of
  latest-messages per request, which is acceptable; no duplicated message data).
- The unmatched-email badge (already server-computed; no optimistic layer now).
- Contacts BatchGet amplification sweep (broadcast results, property recipients,
  property activity) - filed as a follow-up issue in this branch.
- Voice-inbound unread increments (separate open issues; the index picks them up
  automatically if/when voice starts incrementing through the repo primitive).
- Membership-inversion read models (contact->relay/native groups) and the Today
  due/attention read model - out of scope.
- Multi-operator cross-client optimism (another operator's mark-read reaches us
  via SSE reconcile, which is the existing behavior and stays).

## 4. Design overview

### 4.1 The sparse index

New sparse GSI `byUnread` on the conversations table:

- HASH: `unread_flag` (S) - present ONLY while `unread_count > 0`, always the
  constant string `'unread'`.
- RANGE: `last_activity_at` (S) - already on every conversation.
- Projection: ALL (module contract; every GSI projects ALL - tables.ts:60,
  infra/modules/dynamodb/main.tf:56).
- Sparse: a conversation appears in the index only while unread_flag exists.
  Since a GSI indexes an item only when BOTH key attributes are present,
  removing `unread_flag` alone retires the row (last_activity_at always exists,
  so unread_flag is the single controlled attribute).

Schema change lands in app/src/lib/tables.ts (conversations block, lines
118-174) following the byRelayStatus precedent (commit 996de828), then
`npm run gen:tables` regenerates both tfvars files. The exact-array GSI
assertions in app/test/tables.test.ts:164-186 and app/test/genTables.test.ts:
182-188 are updated in the same commit.

WHY A CONSTANT HASH, NOT A STATUS-ENCODED ONE: encoding status into the key
(like relay_status = 'relay_group#<status>') would obligate three more writers
(setRelayStatus, assignPoolNumberAndOpen, convertRelayGroupToGroupText) to
maintain the attribute, recreating the exact class of bug documented at
conversationsRepo.ts:2245-2248 and import/apply.ts:1137-1145. With a constant
hash, ONLY the two unread primitives ever touch the attribute; status
transitions leave it alone and the READER filters by the projected live
status/type (free - projection is ALL, and unread rows are few by definition).
The single-partition GSI is not a hot-partition concern at any plausible scale
(hundreds of unread conversations; one write per inbound message).

### 4.2 The invariant and its complete writer surface

INVARIANT: `unread_flag` exists on a conversation item if and only if
`unread_count > 0` intends to be true, maintained atomically with the counter.

The research map (see section 10) proves the entire runtime zero-crossing
surface is exactly two repo methods; both change in place:

- `incrementUnread` (conversationsRepo.ts:1491-1503):
  `ADD unread_count :one SET unread_flag = :flag` - one UpdateCommand. Every
  increment idempotently (re)sets the flag; no `=== 1` crossing detection is
  needed or safe under concurrency.
- `resetUnread` (conversationsRepo.ts:1505-1521):
  `SET unread_count = :zero REMOVE unread_flag` - one UpdateCommand,
  unconditional and idempotent (the method cannot see the old value; it does
  not need to). `unread_count` stays SET to 0, not REMOVEd - readers and the
  SSE payload already coerce absent -> 0 and existing shapes are preserved.

Because both fields ride ONE UpdateExpression in each primitive, the documented
last-write-wins race between a reset and an in-flight increment
(conversationsRepo.ts:1506-1508) keeps flag and count consistent with each
other regardless of which write lands last. No transaction is needed.

Non-runtime writers that bypass the repo:

- SEEDS (whole-item PutItem, clobber-by-design): every fixture whose
  `unread_count > 0` must also carry `unread_flag: 'unread'`. Audit result:
  only app/src/lib/seed/performance.ts:820 and :889 seed nonzero unread; both
  get the flag. lean.ts/cast.ts/live.ts seed 0 or omit - no flag (and a guard
  test asserts no fixture ships flag-with-zero-count). The performance seed's
  existing invariant assertions (performance.ts:1069-1115 region) gain the
  analogous unread check.
- IMPORT (lib/import/apply.ts upsertConversation): never writes unread_count,
  and the new key attributes are not derived from status/type, so the import
  writer has NO new obligation. Import retract deletes conversation rows
  (apply.ts:712-719); a delete drops the GSI entry automatically.
- BACKFILL: a new idempotent script stamps/removes the flag on existing rows
  (section 7).

Pointer/claim partitions (`phone#`, `email#`, `token#` rows) never carry
unread_count and therefore never enter the index - same discipline as every
existing sparse GSI (conversationsRepo.ts:1111-1115).

### 4.3 The shared enumerator (server)

New module `app/src/lib/unreadFeed.ts` exporting one function used by BOTH the
badge-count endpoint and the Unread page so the two can never diverge:

```
enumerateUnread(deps, opts): {
  rows: UnreadCandidateRow[],   // identity-level, NOT hydrated
  lastEvaluatedKey?,            // index cursor position
  truncated: boolean            // walk budget hit
}
```

Behavior:

1. ONE Query on `byUnread` (ScanIndexForward false, newest activity first),
   paged internally up to a walk budget (UNREAD_WALK_LIMIT = 500 items; WARN
   past 400 - mirrors the GROUP_UNREAD_GROWTH_THRESHOLD pattern this design
   retires).
2. Per returned item (projection ALL - no follow-up reads needed for these
   decisions), apply the VISIBILITY RULES that preserve today's semantics:
   - re-verify `unread_count > 0` (defends against GSI eventual-consistency
     lag on rows that just crossed to zero);
   - skip pointer partitions defensively (no `type`);
   - 1:1 types (`tenant_1to1|landlord_1to1|partner_1to1|unknown_1to1`):
     require `status === 'open'`;
   - `relay_group`: require status `open` or `connecting` (closed relay groups
     holding unread stay invisible, exactly as today - inbox.ts:823 reads only
     those two partitions);
   - `group_text`: require `status === 'group_open'`.
3. Group 1:1 conversations into candidate rows by resolved identity:
   - resolve contact via contacts.findByPhone / findByEmail (per unread
     conversation - bounded by actual unread, NOT by open conversations);
   - conversations resolving to the same contactId merge into ONE candidate
     carrying the set of that contact's UNREAD conversations found in the
     index (their unread_counts sum to the contact-wide unreadSum, because
     read threads contribute zero by definition);
   - no-contact phone conversations become unknown-number candidates keyed by
     phone; contactless email conversations are skipped (spec Decision 4
     parity with inbox.ts:489);
   - relay_group / group_text conversations are each their own candidate.
4. Deleted contacts: a candidate whose contact isDeleted survives only under
   the resurfacing rule - some unread thread's newest message is an inbound
   with created_at > deleted_at (one messages.listByConversation(limit 1) per
   unread thread of DELETED contacts only; live contacts need no message read
   at this stage). This keeps badge count and page rows in exact agreement
   with the current resurfacing semantics (inbox.ts:537-576).

The enumerator returns candidates in index (newest-unread-activity) order.
Split-proof rule for multi-thread contacts: a contact is emitted at its
NEWEST unread conversation; later index items resolving to an already-seen
contact within the same enumeration merge into the existing candidate, and a
cursor resume re-derives the guard from the resumed stream (an older unread
thread whose contact was already emitted on a previous page re-resolves the
contact and re-queries its unread set; if the contact's newest unread thread
precedes the cursor, the candidate is suppressed - same one-row-per-contact
guarantee the current pager provides via the newest-conversation rule).

### 4.4 Badge endpoint

`GET /api/inbox/unread-count` -> `{ unreadCount: number, saturated: boolean }`

- Runs the enumerator with a count budget: stop growing after
  BADGE_COUNT_CAP = 100 distinct candidates (display caps at 99+;
  NavContents.tsx:67), set `saturated: true` when the cap or the walk budget
  was hit.
- No hydration at all: no previews, no placement labels, no latest-message
  reads (except the deleted-contact resurfacing probe, which is a visibility
  rule, not presentation).
- Cost: empty unread = 1 index query. N unread 1:1s = 1 index query + N
  contact resolutions (+ resurfacing probes for deleted contacts only).
- Auth: same requireAuth /api mount as the rest of inbox. Route registered
  BEFORE `POST /read` ordering concerns do not apply (GET vs POST), but it is
  registered above the `/:contactId/read` param route for clarity.
- Error posture: normal 500 on failure; the client already collapses any
  error to "no badge".
- BEHAVIOR CHANGE (accepted, called out): the aria-label previously carried
  the uncapped row count from a limit-100 page walk; it now carries the capped
  count (at most "100 unread" while saturated). The visible text already
  capped at 99+.

### 4.5 Unread page (`GET /api/inbox?filter=unread`)

The `filter=unread` branch of aggregateInbox is rewritten to consume the
enumerator instead of the contact pager + additive relay merge + group walk:

1. Enumerate candidates from the index (cursor = opaque base64url of the index
   LastEvaluatedKey, namespaced with a tag `{u:1}` so unread cursors, group
   cursors, and open-partition cursors can never be replayed cross-filter -
   same posture as decodeCursor/decodeGroupCursor today).
2. Take up to `limit` candidates; hydrate ONLY those (bounded by page size):
   - contact rows: conversationsForContact once per contact (needed for the
     representative newest conversation - which may be a READ thread - and
     its phone/lastActivityAt, exactly matching today's row content), then
     latestMessageOf(maxConv) once, then placement label if present. The
     unreadSum comes from the enumerator's index-derived sum; a divergence
     with the freshly-read conversation set resolves in favor of the fresh
     read (re-sum over the fetched set) so row content is never stale relative
     to what hydration read.
   - unknown rows / relay rows / group rows: hydrate exactly as today
     (latestMessageOf for unknown; relayRowFor / groupRowFor need no extra
     reads).
3. Rows within the page sort by their displayed lastActivityAt (as today).
   ACCEPTED ORDERING NUANCE: a contact row displays its newest OVERALL
   thread's activity while the index orders by newest UNREAD activity, so
   cross-page ordering can wobble for multi-thread contacts whose newest
   thread is read. Today's feed has an analogous wobble (additive page-1 relay
   and group merges), and unread lists are typically sub-page.
4. `groupsTruncated` semantics: under filter=unread the group source is no
   longer a capped separate walk; the flag maps to `truncated` from the
   enumerator's walk budget (rows this filter would have shown were withheld -
   same meaning as today).

All other filters (`all`, `unknown`, `groups`) are UNTOUCHED, including the
early-rejection behavior fix A landed. The GROUP_UNREAD_WALK_LIMIT /
GROUP_UNREAD_GROWTH_THRESHOLD constants and the unread group walk die with
this rewrite (the group source under filter=all keeps its page-one cap and its
own walk budget exactly as-is).

Mark-read routes (`POST /api/inbox/read`, `POST /api/inbox/:contactId/read`,
`POST /api/conversations/:id/read`) are unchanged - they already call
resetUnread, which now maintains the flag.

### 4.6 Today page unread source

today.ts currently derives untriaged-unknown and unreplied entries by walking
the first 100 open conversations (today.ts:529, GROUP_FETCH_LIMIT) and gating
on unread (today.ts:581-582). That query is replaced for the UNREAD-DRIVEN
sections by the same byUnread query (filtered to open 1:1 types, honoring the
same visibility rules via the enumerator's conversation-level filter). The
relay opt-out scan and relay close-nag sections keep their existing sources
(they are unread-independent). Effect: unread threads beyond the first 100
open conversations become visible to Today (a silent-miss fix), and Today
stops paying the open-partition walk for unread work.

### 4.7 Client: optimistic badge + fast reconcile

UnreadContext changes (dashboard/src/app/UnreadContext.tsx):

1. FETCH SWAP: `fetchCount` calls the new `getUnreadCount()` endpoint
   (dashboard/src/api/endpoints.ts, next to getInbox; type
   `InboxUnreadCount { unreadCount: number; saturated: boolean }` in
   api/types.ts next to InboxPage). Error posture unchanged: any error -> null
   (no badge). 404 keeps meaning "slice not live yet".
2. OPTIMISTIC LAYER: the context value widens to
   `{ unread, unmatchedUnread, noteRowsCleared(keys: string[]): void }`.
   - Internal state: `serverCount: number | null` plus
     `pendingClears: Map<rowKey, clearedAtMs>`.
   - Displayed `unread = serverCount === null ? null :
     max(0, serverCount - pendingClears.size)`.
   - `noteRowsCleared` inserts row keys (idempotent by key - the row-click +
     contact-page double-POST cannot double-decrement, and StrictMode
     double-invoke is harmless).
   - A pending clear expires (a) after PENDING_CLEAR_TTL_MS = 10_000, or
     (b) when a server count arrives from a fetch that STARTED after the
     clear was recorded AND is <= the displayed value (the server has caught
     up); whichever comes first. The TTL bounds GSI eventual-consistency
     bounce; after it, the server is simply trusted.
   - A failed mark-read rolls back by removing the key (callers pass the same
     keys to a `rollbackRowsCleared(keys)` companion, wired into the existing
     empty `.catch` at useInbox.ts:291-293).
   - Generation guard: fetches carry a generation number; a fetch that
     resolves after a newer fetch started is discarded (the abort-clobber
     hazard - the current code's abort covers overlapping fetches but not the
     interleaving with optimistic writes).
   - The provider value is memoized (useMemo) - every nav leaf consumes this
     context (NavContents.tsx:40).
   - Clamp: displayed count never goes below 0.
3. CALLERS of noteRowsCleared - ONLY sites that verified unread > 0:
   - useInbox.markRead (all four branches, after the :263 unread guard and
     the :283 addressability guard) - keys via the existing rowKey().
   - useTourChannels markGroupRead/markPersonRead and usePlacementChannels
     markGroupRead/markPersonRead (their existing `unread <= 0` guards are
     exactly the precondition); keys: `g:<conversationId>` /
     `gt:<conversationId>` for groups per row kind, `c:<contactId>` for
     persons - matching useInbox.rowKey's scheme, which becomes the shared
     key vocabulary (exported from a shared location; the current rowKey in
     useInbox.ts is the reference implementation).
   - NOT useMarkContactRead (fires blind on every contact-page mount - it
     cannot know whether the contact was unread; it would drive the count
     negative). NOT ConversationDetail/GroupTextView mount marks (same
     blindness). These paths stay reconcile-only; when the user arrived via an
     inbox row click the row's own noteRowsCleared already fired.
4. RECONNECT RECONCILE: subscribe `onOpen` (EventStreamProvider already
   exposes it) -> scheduleRefetch, so a badge that drifted during an SSE
   blackout corrects on reconnect. (New behavior; cheap now that the fetch is
   cheap.)
5. The SSE debounce (300ms) and the unmatched-email half of the provider are
   unchanged.

The Inbox page's own list keeps its existing optimistic row-drop; no changes
to useInbox besides the noteRowsCleared/rollback wiring.

### 4.8 What the badge means (unchanged, now explicit)

The badge counts VISIBLE INBOX ROWS: one per contact (however many unread
threads), one per unknown number, one per relay group, one per native group
thread - capped at 100/saturated, displayed as 99+ beyond 99. It is the same
number of rows the Unread page would list (its first 100), guaranteed by the
shared enumerator.

## 5. Wire contract additions

```
GET /api/inbox/unread-count
200 { "unreadCount": number, "saturated": boolean }
```

No other wire shapes change. InboxRow/InboxPage are untouched.

## 6. Consistency model (explicit)

- The GSI is eventually consistent. Bounded staleness is accepted:
  - a just-read conversation may briefly linger in the index -> the
    enumerator's `unread_count > 0` re-verification drops it (projection ALL
    makes this free);
  - a just-arrived unread may briefly be missing -> the SSE-triggered refetch
    lands ~300ms+ later, far beyond typical GSI propagation; accepted.
- The badge's optimistic layer masks the user's OWN actions for up to the
  10s TTL; other operators' actions arrive via reconcile only (as today).
- The pre-existing emit gap (increment succeeds, touchLastActivity throws, no
  SSE event - twilio.ts:604-618 et al.) leaves the INDEX correct and only
  delays client refresh until the next event; unchanged by this design.
- No transactional projection table; no new event types.

## 7. Migration and operations

1. SCHEMA: tables.ts + `npm run gen:tables` + both tfvars committed together
   (plan/drift hard-fail on stale JSON). Test guards updated in the same
   commit.
2. BACKFILL SCRIPT: `app/scripts/backfill-unread-flag.ts`, modeled on
   backfill-broadcast-list-partition.ts (paginated Scan; per-row
   UpdateCommand; `--dry-run` flag; read-side skip + write-side
   ConditionExpression idempotency; `{scanned, stamped, removed, skipped}`
   counts; isEntrypoint guard; pure planner function unit-tested without a
   DB per backfillConsentMethod.ts precedent). BOTH directions: stamp
   `unread_flag` where `unread_count > 0` and it is absent; REMOVE it where
   present with `unread_count` 0/absent. Skips pointer partitions
   (`phone#`/`email#`/`token#` conversationId prefixes).
3. LOCAL SCHEMA UPDATE (no data loss): `ensureTable` is create-only, and
   `db-create --reset` would destroy the human's imported local dataset. New
   small script `app/scripts/db-update-gsis.ts` (localhost-endpoint-guarded,
   same guard as db-create's reset): diff each TABLES spec's GSIs against the
   live local table, issue UpdateTable CreateGlobalSecondaryIndex for missing
   ones, wait for ACTIVE. Used for the human's live local tables and any lane
   worth preserving; disposable e2e lanes can simply be wiped
   (hc-local-<L>-* under the lane's own access key, per the stale-lane
   issue).
4. ORDER OF OPERATIONS (human-run, recorded in RUNBOOK):
   dev: `npm run plan -- dev` -> `npm run apply -- dev` (NOTE: the plan
   carries the entire owed backlog - byJurisdiction delete, several new
   tables and GSI adds - per RUNBOOK.md:117-220; this is expected) ->
   `tsx app/scripts/backfill-unread-flag.ts --dry-run` then live ->
   `npm run deploy:dev`. Schema BEFORE code, per RUNBOOK.md:85-92. Prod rides
   the M1.11 gate as usual.
   local: `tsx app/scripts/db-update-gsis.ts` -> backfill script (local
   endpoint) -> restart dev stack.
5. RUNBOOK gains the owed-op row in the schema-changes table.

## 8. Testing

Unit (app/test):
- conversationsRepo: incrementUnread sets flag + count atomically (absent->1
  creates flag; repeat increments keep it); resetUnread zeroes count and
  removes flag; both idempotent; reset-then-increment and increment-then-reset
  orderings leave flag consistent with count.
- unreadFeed enumerator against in-memory fakes: visibility rules per
  type/status matrix (open/closed/connecting relay, group_open, 1:1), stale
  index row dropped by re-verification, contact grouping + unreadSum,
  multi-phone and phone+email contacts merge to one candidate, unknown-number
  candidates, contactless email skipped, deleted-contact resurfacing
  (fresh-inbound yes / pre-deletion no / outbound no), walk budget truncation,
  count cap + saturated, split-proof cursor resume for multi-thread contacts.
- inbox route: filter=unread page via enumerator - row content parity with
  the pre-change fixtures (row fields byte-equal for the same seed), cursor
  namespacing (a group or open-partition cursor under filter=unread -> 400,
  and vice versa), groupsTruncated mapping, zero-unread dataset produces
  empty page with 1 index query and NO contact/message/placement calls
  (call-count assertions per the fix-A test idiom).
- unread-count endpoint: counts rows not conversations (multi-thread contact
  = 1), saturation, deleted-contact parity with the page, zero state = 1 call.
- today route: unread sections fed by the index source; a 150-open-conv fixture
  with an unread thread at position 120 now surfaces (the old cap missed it).
- Seeds guard: no seed fixture carries unread_flag with unread_count 0/absent,
  and every nonzero-unread fixture carries the flag (walk the TABLES fixture
  arrays in-process).
- backfill planner: pure-function cases (stamp / remove / skip / pointer rows).
- UnreadContext: optimistic decrement is synchronous (asserted before any
  debounce), idempotent per key (double-POST), TTL expiry restores server
  truth, rollback restores count, generation guard discards a stale fetch that
  raced a clear, clamp at 0, memoized value, onOpen refetch. (AppFrame.test's
  useUnread mock and Inbox.test's baseState factory gain the new fields.)
- useInbox/useTourChannels/usePlacementChannels: noteRowsCleared fires exactly
  once per guarded mark-read; useMarkContactRead does NOT call it.

Integration (DynamoDB Local, per relayRepos.integration.test.ts precedent):
- byUnread query returns exactly the flagged rows newest-first; increment/
  reset round-trip visible through the index; backfill script both directions
  against a seeded mixed-state table (positive/zero/absent + a pointer row).

E2E (net-new + existing):
- NEW spec: nav Inbox badge - seed an unread conversation, badge shows the
  count; open the row; badge decrements IMMEDIATELY (assert before the
  reconcile could land, using the raced-response idiom from
  group-text-inbox.spec.ts); a group-text unread decrements via its row too.
  This is the first e2e coverage of the nav badge at all.
- Existing inbox-markread.spec.ts, group-text-inbox.spec.ts,
  deleted-contact-resurfacing.spec.ts must stay green (they pin row-level
  semantics this design preserves).

Performance evidence (DynamoDB Local, hermetic + imported dataset if the human
offers it):
- `npm run perf:inbox` before/after at page limit 30, >= 5 repeats: unread-page
  and unread-badge cases drop from ~1,230 calls to O(actual unread) (target:
  <= 3 calls on the zero-unread dataset); all-page/groups-page unchanged.
  Report calls eliminated + remaining + local medians as emulator-bound
  evidence only.

## 9. Acceptance criteria

- Badge request on a zero-unread dataset: 1 index query, no hydration calls.
- Unread page on a zero-unread dataset: 1 index query, empty rows.
- Neither the badge nor the Unread page issues per-OPEN-conversation calls;
  cost scales only with actual unread candidates (plus per-page hydration
  bounded by limit).
- Badge decrements at click time on every unread-verified mark-read path and
  never goes negative; a failed mark-read restores it; server reconcile
  converges within the TTL under GSI lag.
- Row content of the Unread feed is unchanged for identical data (asserted by
  fixture parity tests + existing e2e).
- All/unknown/groups filters and their costs are untouched.
- Sparse-flag invariant holds across every writer (unit + integration + seed
  guard + backfill tests).
- Gates: `npm run typecheck`, `npm test`, `npm run e2e` all green from the
  worktree.

## 10. Invariant surface enumeration (research-verified)

WRITERS of unread_count (all through 2 primitives - verified exhaustive):
- incrementUnread callers: twilio.ts:605 (relay inbound), :905 (closed-group
  late text), :1660 (group_text inbound), :2125 (1:1 inbound),
  inboundEmail.ts:707 (email inbound). All become flag-writers automatically.
- resetUnread callers: api.ts:2021 (conversation read), inbox.ts:982 (phone
  fan-out), inbox.ts:1015 (contact fan-out). All become flag-removers
  automatically.
- Creation sites (createOrGetByParticipantPhone/Email, createRelayGroup,
  createGroupTextThread, import upsertConversation): omit unread_count ->
  omit flag; NO changes needed.
- Status/lifecycle transitions (touchLastActivity, setRelayStatus,
  assignPoolNumberAndOpen, convertRelayGroupToGroupText, rebindOwner,
  roster/close-nag writers): none touch unread; none touch the flag; the
  reader's status filter preserves visibility semantics. NO changes needed.
- Seeds: performance.ts:820/:889 (nonzero) gain the flag; others unchanged.
- Deletes (import retract, devReset, performanceSeed lean-group delete): GSI
  entries drop with the item automatically.

READERS of unread state (all accounted for):
- inbox.ts filter=unread + badge -> switched to the enumerator (this design).
- inbox.ts deleted-resurfacing + unreadSum -> preserved inside the enumerator.
- today.ts:581 unread gate -> switched to the index source (this design).
- api.ts:416 conversation summaries + :1697 detail -> read the counter
  attribute only; unchanged and unaffected.
- events.ts:100 SSE payload -> unchanged.
- Dashboard: UnreadContext (rewired), useInbox rows (unchanged shape),
  usePlacementChannels/useTourChannels first-page unread dots (unchanged;
  their documented first-page limitation is out of scope).
- fake-twilio's groupUnreadByPool is a different counter entirely; untouched.

## 11. Follow-up issues filed with this feature

- docs/issues/contacts-batchget-amplified-reads.md (NEW): the shared
  contacts.getManyByIds/BatchGet sweep for broadcast results, property
  recipients, and property activity - the agreed next mission.
- inbox-unread-sse-full-walk.md -> resolved by this feature (status flipped on
  this branch when the build lands).
- inbox-filter-tabs-full-walk.md -> updated: unread half resolved here,
  unknown half remains open.
