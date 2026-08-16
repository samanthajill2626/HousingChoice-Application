# Inbox Unread Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make unread discovery O(actual unread) via a sparse `byUnread` GSI, add a cheap badge-count endpoint, and make the nav badge update optimistically at click time.

**Architecture:** A sparse attribute `unread_flag` maintained atomically inside the two unread repo primitives (plus relay-close and contact-delete resets, per the human gate ruling) feeds a single-partition GSI. A lazy two-layer read module (`app/src/lib/unreadFeed.ts`) serves the badge count, the rewritten `filter=unread` page (fill-or-exhaust, seen-set cursor), and Today's unread pass. The dashboard's `UnreadContext` swaps to the count endpoint and gains a pending-clears optimistic layer wired from every unread-verified mark-read surface.

**Tech Stack:** TypeScript, Express 5, DynamoDB (DocumentClient), Vitest, React, Playwright.

**Spec:** docs/superpowers/specs/2026-08-16-inbox-unread-index-design.md (v6, commit c489a0b3). THE SPEC IS THE AUTHORITY - every task below implements a spec section; read the cited section before starting the task.

## Global Constraints

- ASCII only in every new/edited line (verify per file: `tr -d '\11\12\15\40-\176' < FILE | wc -c` prints 0).
- Never pipe gate commands. Run bare; filter after.
- Commit with explicit paths only + `Co-Authored-By:` trailer naming your model. `git status` (bare, separate command) before EVERY commit.
- Worktree: W:/tmp/inbox-unread-index. `cd` explicitly in EVERY shell command.
- Constants (spec values, verbatim): `unread_flag` value `'unread'`; `UNREAD_WALK_LIMIT = 2000` (per request); `UNREAD_WALK_WARN = 500`; `BADGE_COUNT_CAP = 100`; `SEEN_SET_MAX = 100`; `TODAY_UNREAD_CAP = 100`; `UNREAD_DELETED_PROBE_WARN = 25`; client `RECHECK_DELAY_MS = 2000`, `PENDING_CLEAR_TTL_MS = 10_000`.
- Wire additions (verbatim): `GET /api/inbox/unread-count` -> `{ unreadCount: number, capped: boolean, truncated: boolean }`; `InboxPage.truncated?: true` (added in BOTH app/src/routes/inbox.ts:118-129 and dashboard/src/api/types.ts:2685-2695); unread cursor = base64url JSON `{ u: 1, a: string, c: string, s: string[] }`.
- Badge clear-key vocabulary (verbatim): `c:<contactId>` | `u:<phone>` | `cv:<conversationId>` (kind-free; BOTH group kinds use `cv:`).
- `groupsTruncated` is NEVER set on filter=unread responses. `truncated` is NEVER set on other filters.
- filter=all / unknown / groups behavior and costs are UNTOUCHED (including main @39c1aa41's early rejections).
- Do not run e2e and an interactive session concurrently; e2e lanes may hold a pre-GSI schema - wipe `hc-local-<L>-*` under the lane's OWN key `hclane<L>` if a broad deterministic red cluster appears (docs/issues/e2e-lane-tables-stale-schema.md).

---

### Task 1: Schema - byUnread GSI + ConversationItem type

**Files:**
- Modify: `app/src/lib/tables.ts` (conversations block, :118-174)
- Modify: `app/src/repos/conversationsRepo.ts` (~:162, next to `unread_count`)
- Modify: `app/test/tables.test.ts:164-186`, `app/test/genTables.test.ts:182-188`
- Generated: `infra/envs/dev/tables.auto.tfvars.json`, `infra/envs/prod/tables.auto.tfvars.json` (via `npm run gen:tables` - NEVER hand-edit)

**Interfaces:**
- Produces: GSI `byUnread` (HASH `unread_flag` S, RANGE `last_activity_at` S, sparse); `ConversationItem.unread_flag?: 'unread'`.

- [ ] **Step 1: Update the two schema-guard tests to expect `byUnread`** - in `app/test/tables.test.ts` the conversations `gsiNames(t)` exact array gains `'byUnread'`; same array in `app/test/genTables.test.ts`. Keep alphabetical/positional convention matching the existing array order (append after `byRelayStatus`).
- [ ] **Step 2: Run both tests, verify they FAIL** (`cd W:/tmp/inbox-unread-index && npx vitest run test/tables.test.ts test/genTables.test.ts -w app` - expected: the two exact-array assertions fail because the schema lacks byUnread).
- [ ] **Step 3: Add the GSI spec to `app/src/lib/tables.ts`** in the conversations block, modeled byte-for-byte on the `byRelayStatus` entry at :167-172 (the sparse precedent):

```ts
      {
        // Sparse unread index (design 2026-08-16): unread_flag exists ONLY
        // while unread_count > 0, maintained atomically by incrementUnread /
        // resetUnread (+ the relay-close and contact-delete resets). One
        // constant HASH value 'unread'; readers filter status/type.
        indexName: 'byUnread',
        hashKey: { name: 'unread_flag', type: 'S' },
        rangeKey: { name: 'last_activity_at', type: 'S' },
        sparse: true,
      },
```

(Match the surrounding `GsiSpec` field names exactly - read the `byRelayStatus` entry first; if the file uses `hash`/`range` or bare strings instead of `hashKey`/`rangeKey` objects, follow the file.)
- [ ] **Step 4: Add the type field** in `app/src/repos/conversationsRepo.ts` next to `unread_count?: number` (:162):

```ts
  /** Sparse byUnread GSI HASH - present IFF unread_count > 0 (constant
   *  'unread'). Maintained ONLY by incrementUnread/resetUnread and the
   *  relay-close / contact-delete resets. Never exposed on constructed wire
   *  shapes (rides the raw GET /api/conversations/:id item; accepted). */
  unread_flag?: 'unread';
```

- [ ] **Step 5: Regenerate tfvars**: `cd W:/tmp/inbox-unread-index && npm run gen:tables`. Verify both env JSONs changed identically (`git diff --stat infra/`).
- [ ] **Step 6: Run the two tests again, verify PASS**; then `npm run typecheck -w app` - expected PASS.
- [ ] **Step 7: Commit** (paths: `app/src/lib/tables.ts app/src/repos/conversationsRepo.ts app/test/tables.test.ts app/test/genTables.test.ts infra/envs/dev/tables.auto.tfvars.json infra/envs/prod/tables.auto.tfvars.json`), message `feat(schema): add sparse byUnread GSI on conversations`.

### Task 2: Repo - flag maintenance in the unread primitives + relay-close reset + raw index Query

**Files:**
- Modify: `app/src/repos/conversationsRepo.ts` (`incrementUnread` :1490-1502, `resetUnread` :1504-1520, `setRelayStatus` :1786-1819, `ConversationsRepo` interface ~:593)
- Test: `app/test/unreadIndexRepo.integration.test.ts` (Create; DynamoDB Local, model on `app/test/relayRepos.integration.test.ts`)

**Interfaces:**
- Produces (interface additions, exact):

```ts
  /** Raw one-page Query on byUnread, newest-first. NO filtering - the
   *  unreadFeed layer owns visibility. exclusiveStartKey is the synthesized
   *  full key { unread_flag: 'unread', last_activity_at, conversationId }. */
  queryUnreadPage(opts: { limit: number; exclusiveStartKey?: Record<string, unknown> }):
    Promise<{ items: ConversationItem[]; lastEvaluatedKey?: Record<string, unknown> }>;
```

- [ ] **Step 1: Write the failing integration tests** in `app/test/unreadIndexRepo.integration.test.ts` (reuse relayRepos.integration.test.ts's local-dynamo setup/teardown idiom and table bootstrap):
  - `incrementUnread` on a fresh conversation -> item has `unread_count: 1` AND `unread_flag: 'unread'`; a second increment -> `2` + flag still present.
  - `resetUnread` -> `unread_count: 0` AND `unread_flag` ABSENT (assert `'unread_flag' in item === false` via GetItem).
  - reset-then-increment -> count 1 + flag present; increment-then-reset -> count 0 + flag absent (either ordering leaves flag iff count>0).
  - `queryUnreadPage({limit: 10})` returns exactly the flagged conversations newest-`last_activity_at`-first; a conversation after `resetUnread` disappears from the query; `exclusiveStartKey` built from the tuple of item N resumes at item N+1 even when N and N+1 share `last_activity_at` (seed two items with an identical timestamp).
  - `setRelayStatus(id, 'closed')` on an unread relay group -> count 0 + flag absent; `setRelayStatus(id, 'open')` after -> count still 0 (reopen does not resurrect).
- [ ] **Step 2: Run, verify FAIL** (`npx vitest run test/unreadIndexRepo.integration.test.ts -w app` - queryUnreadPage undefined, flag assertions fail).
- [ ] **Step 3: Implement.** `incrementUnread` UpdateExpression becomes `'ADD unread_count :one SET unread_flag = :flag'` with `':flag': 'unread'` added to ExpressionAttributeValues (keep the existing ConditionExpression + ReturnValues). `resetUnread` becomes `'SET unread_count = :zero REMOVE unread_flag'`. `setRelayStatus`: when the target status is `'closed'`, append `, unread_count = :zero` to its SET clause and add `REMOVE unread_flag` (one atomic write; the 'open'/reopen branch is untouched - read the existing expression first and extend it, do not rebuild it). `queryUnreadPage`:

```ts
    async queryUnreadPage({ limit, exclusiveStartKey }) {
      const { Items, LastEvaluatedKey } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byUnread',
          KeyConditionExpression: 'unread_flag = :u',
          ExpressionAttributeValues: { ':u': 'unread' },
          ScanIndexForward: false, // newest activity first
          Limit: limit,
          ...(exclusiveStartKey !== undefined && {
            ExclusiveStartKey: exclusiveStartKey as QueryCommandInput['ExclusiveStartKey'],
          }),
        }),
      );
      return {
        items: (Items ?? []) as ConversationItem[],
        ...(LastEvaluatedKey !== undefined && { lastEvaluatedKey: LastEvaluatedKey }),
      };
    },
```

- [ ] **Step 4: Run tests, verify PASS.** Note: a stale per-worktree vitest DB predating Task 1 lacks the GSI - if `byUnread` missing errors appear, delete the `hctest<hash>` tables (see `app/test/globalSetup.ts:33-116`) and rerun.
- [ ] **Step 5: Update the webhook-harness fake** so the invariant is modeled everywhere: in `app/test/helpers/twilioWebhookHarness.ts:447-458`, `incrementUnread` also sets `unread_flag: 'unread'` on the stored item; `resetUnread` deletes the property. In `app/test/contactCapture.test.ts:130`'s repo fake, add a `queryUnreadPage: async () => ({ items: [] })` stub (it must exist to satisfy the interface).
- [ ] **Step 6: Full app unit suite** (`npm run test -w app` bare) - expected PASS; then typecheck. Fix any repo-interface fakes the compiler flags (the exhaustive list is in spec section 8).
- [ ] **Step 7: Commit** `feat(repo): maintain sparse unread_flag in unread primitives; relay close resets unread`.

### Task 3: unreadFeed layer 1 - the lazy iterator

**Files:**
- Create: `app/src/lib/unreadFeed.ts`
- Test: `app/test/unreadFeed.test.ts` (Create; in-memory fakes per inboxFeed.test.ts conventions)

**Interfaces:**
- Produces (exact, spec 4.3 layer 1):

```ts
export interface UnreadScanPosition { lastActivityAt: string; conversationId: string }
export const UNREAD_WALK_LIMIT = 2000;
export const UNREAD_WALK_WARN = 500;

export interface UnreadWalkState {
  scanPosition?: UnreadScanPosition; // last RAW item scanned
  scanExhausted: boolean;            // underlying Query stream ended
  scanned: number;                   // raw items consumed from the budget
}

/** Lazy visible-unread iterator. Yields items passing the visibility rules;
 *  counts EVERY scanned raw item against opts.budget. Mutates state as it
 *  goes so the caller can stop pulling at any point and read the position. */
export async function* iterateUnreadConversations(
  deps: { conversations: Pick<ConversationsRepo, 'queryUnreadPage'>; logger?: Logger },
  opts: { startAfter?: UnreadScanPosition; budget: number },
  state: UnreadWalkState,
): AsyncGenerator<ConversationItem>;

export function toExclusiveStartKey(p: UnreadScanPosition): Record<string, unknown>;
// -> { unread_flag: 'unread', last_activity_at: p.lastActivityAt, conversationId: p.conversationId }
```

- Visibility rules (verbatim from spec 4.3; implement as an exported pure `isUnreadVisible(item): boolean` so layer 2, Today, and tests share it): skip non-positive `unread_count`; `relay_group` -> status `open`|`connecting`; `group_text` -> status `group_open`; everything else (INCLUDING type-less items) -> status `open`. Skip pointer partitions defensively (`conversationId` starting `phone#`/`email#`/`token#`).

- [ ] **Step 1: Write failing tests** (fake `queryUnreadPage` backed by an array, honoring limit/exclusiveStartKey by tuple position and recording call count):
  - visibility matrix: one item per branch (open 1:1, closed 1:1, type-less open, relay open/connecting/closed, group_text group_open, pointer row `phone#+1...`, `unread_count: 0` item) -> exactly the visible ones yielded, in order.
  - LAZINESS: 300-item fake index, consumer takes 1 item and stops -> fake received exactly ONE queryUnreadPage call (internal page size 100).
  - fully-filtered run: 250 invisible items then 1 visible -> the visible item is yielded and `state.scanPosition` advanced through all 251.
  - budget: `budget: 50` against 300 items -> iterator ends after scanning 50; `state.scanned === 50`; `scanExhausted === false`.
  - scanExhausted: 5-item index fully drained -> `scanExhausted === true`.
  - WARN: >500 scanned -> logger.warn called (via a spy) exactly once (rate-limited path - assert the rateLimitedWarn wrapper is used by spying on it, `app/src/lib/rateLimitedWarn.ts`).
- [ ] **Step 2: Run, verify FAIL** (module not found).
- [ ] **Step 3: Implement** - internal loop: Query pages of `Math.min(100, remaining budget)`; for each raw item: update scanPosition + scanned; if scanned > UNREAD_WALK_WARN fire the rate-limited warn once per request; skip invisible; `yield` visible. Stop when budget exhausted or no lastEvaluatedKey (set scanExhausted when the final page had no LEK AND all its items were consumed).
- [ ] **Step 4: Run tests -> PASS; typecheck -> PASS.**
- [ ] **Step 5: Commit** `feat(inbox): lazy byUnread iterator with visibility rules`.

### Task 4: unreadFeed layer 2 - collectUnreadRows

**Files:**
- Modify: `app/src/lib/unreadFeed.ts`
- Test: `app/test/unreadFeed.test.ts` (extend)

**Interfaces:**
- Produces (exact, spec 4.3 layer 2):

```ts
export type UnreadCandidate =
  | { kind: 'contact'; contactId: string; contact: ContactItem;
      unreadConversations: ConversationItem[]; representative: ConversationItem }
  | { kind: 'unknown'; phone: string; conversation: ConversationItem }
  | { kind: 'relay_group' | 'group_text'; conversation: ConversationItem };

export interface CollectResult {
  candidates: UnreadCandidate[];
  scanPosition?: UnreadScanPosition; // after the last CONSUMED item
  consumedAll: boolean;  // supply ran out (scan exhausted AND drained)
  truncated: boolean;    // request budget ran out first
  capped: boolean;       // maxRows stopped emission
  remainingBudget: number;
  deletedProbes: number; // resurfacing probes issued (tripwire counter)
}

export const BADGE_COUNT_CAP = 100;
export const UNREAD_DELETED_PROBE_WARN = 25;

export async function collectUnreadRows(
  deps: {
    conversations: Pick<ConversationsRepo, 'queryUnreadPage'>;
    contacts: Pick<ContactsRepo, 'findByPhone' | 'findByEmail'>;
    messages: Pick<MessagesRepo, 'listByConversation'>;
    logger?: Logger;
  },
  opts: { maxRows: number; budget: number; startAfter?: UnreadScanPosition;
          excludeContactIds?: ReadonlySet<string> },
): Promise<CollectResult>;
```

- Grouping (spec 4.3): relay/group items -> own candidate. 1:1 items -> resolve contact (`findByPhone` on `participant_phone` first, then `findByEmail` on `participant_email` - the inbox.ts:476-477 order, both wrapped in try/catch degrading to no-contact); resolved -> one candidate per contactId, FIRST (newest) item is `representative`, later same-contact items push into `unreadConversations`; excluded contactIds skipped entirely (their items still consume scan range); no contact + phone -> `unknown` candidate; no contact + no phone -> skipped. NO unread sums.
- Deleted contacts (spec 4.3 step 2): if `isDeleted(contact)`, the candidate survives iff SOME conversation in `unreadConversations` has newest message inbound with `created_at > contact.deleted_at` - `messages.listByConversation(convId, { limit: 1 })` per unread thread, UNCONDITIONALLY, counting `deletedProbes`; fire the rate-limited `UNREAD_DELETED_PROBE_WARN` when a single call exceeds 25. A failed candidate's items still consume scan range and do NOT emit.
- Emission stops AT `maxRows` - the generator is not pulled further (laziness carries through).

- [ ] **Step 1: Write failing tests** (extend the fakes with contacts/messages maps):
  - grouping: multi-phone contact with 2 unread threads -> ONE candidate, representative = newer, `unreadConversations.length === 2`; phone+email contact merges likewise; unknown-number item -> unknown candidate; contactless email item -> skipped; relay + group items -> own candidates.
  - excludeContactIds: contact's items skipped, scanPosition still advances past them.
  - capped vs consumedAll (THE round-3 blocking case): 300-item visible index, `maxRows: 30` -> `capped: true`, `consumedAll: false`, scanPosition after item 30's consumption; SAME data, `maxRows: 500` -> `consumedAll: true`, `capped: false`.
  - resume without loss: run once at maxRows 30, feed `scanPosition` + emitted contactIds back as startAfter/exclude -> second call emits exactly candidates 31..60, none duplicated, none skipped (assert by union of ids), including when items 30/31 share a `last_activity_at`.
  - deleted contact: fresh post-deletion inbound -> survives; pre-deletion-only unread -> dropped; post-deletion OUTBOUND newest -> dropped; a thread with stale `last_activity_at` OLDER than deleted_at but a fresh inbound message -> SURVIVES (the withdrawn-short-circuit regression case); `deletedProbes` counted; >25 probes -> rate-limited warn spy fires.
  - laziness passthrough: maxRows 1 against 300 visible -> 1 queryUnreadPage call.
- [ ] **Step 2: Run -> FAIL. Step 3: Implement. Step 4: Run -> PASS; typecheck.**
- [ ] **Step 5: Commit** `feat(inbox): unread row collector with contact grouping + resurfacing`.

### Task 5: GET /api/inbox/unread-count

**Files:**
- Modify: `app/src/routes/inbox.ts` (new route ABOVE the `/:contactId/read` registration; new exported handler helper `countUnreadRows(deps)` next to aggregateInbox)
- Test: `app/test/inboxApi.test.ts` (extend - it already boots the router with fakes)

**Interfaces:**
- Produces: `GET /api/inbox/unread-count` -> 200 `{ unreadCount: number, capped: boolean, truncated: boolean }`; 500 on repo throw (no special handling - the client collapses errors).
- Implementation: one `collectUnreadRows` call, `maxRows: BADGE_COUNT_CAP, budget: UNREAD_WALK_LIMIT`; `unreadCount = candidates.length`, `capped = capped`, `truncated = truncated`. NO hydration calls.

- [ ] **Step 1: Failing tests** in inboxApi.test.ts: zero-unread fixture -> `{ unreadCount: 0, capped: false, truncated: false }` AND the fake recorded exactly 1 queryUnreadPage call and 0 findByPhone/listByConversation calls; a 3-contact + 1-group + 1-relay-open + 1-relay-CLOSED fixture -> `unreadCount: 5` (closed excluded); multi-thread contact counts once; 101+ visible candidates -> `unreadCount: 100, capped: true`; repo throw -> 500.
- [ ] **Step 2: Run -> FAIL. Step 3: Implement (route + helper). Step 4: PASS + typecheck.**
- [ ] **Step 5: Commit** `feat(inbox): unread-count endpoint`.

### Task 6: filter=unread rewrite - fill-or-exhaust page + seen-set cursor + truncated

**Files:**
- Modify: `app/src/routes/inbox.ts` (the `filter=unread` path of aggregateInbox; `InboxPage` at :118-129 gains `truncated?: true`; cursor codec; DELETE `GROUP_UNREAD_WALK_LIMIT`/`GROUP_UNREAD_GROWTH_THRESHOLD` and the unread group-walk branch at :857-887 and the unread pre-filters at :490/:530 which the new path supersedes - filter=all keeps everything it uses today)
- Test: `app/test/inboxFeed.test.ts`, `app/test/inboxApi.test.ts`, `app/test/inboxGroups.test.ts`, `app/test/inboxEmail.test.ts`, `app/test/contactSoftDelete.test.ts`, `app/test/contactTriage.test.ts`, `app/test/inbox.integration.test.ts`

**Interfaces:**
- Consumes: `collectUnreadRows`, `iterateUnreadConversations` types from Tasks 3-4.
- Produces: unread cursor codec (exact):

```ts
const SEEN_SET_MAX = 100;
interface UnreadCursor { u: 1; a: string; c: string; s: string[] }
function encodeUnreadCursor(p: UnreadScanPosition, seen: ReadonlySet<string>): string; // base64url JSON
function decodeUnreadCursor(cursor: string): UnreadCursor; // throws InboxBadRequestError on: bad JSON, u !== 1, s.length > SEEN_SET_MAX, non-string members
```

  `decodeCursor` (:217-237, other filters) additionally 400s a cursor whose payload has `u: 1` (cross-filter rejection both directions; mirror the existing `t` tag check at :233).
- Page algorithm (spec 4.5, implement exactly):
  1. Loop: `collectUnreadRows({ maxRows: limit - rows.length, budget: remaining, startAfter, excludeContactIds: seen })`; hydrate candidates (below); accumulate emitted contactIds into `seen` (WHETHER OR NOT hydration kept the row); repeat until rows.length === limit, or `consumedAll`, or `remainingBudget === 0`.
  2. Hydration per candidate kind: `contact` -> existing `contactConversations(contact)` wrapper (per-request cache stays), `maxConv = newestOf(...)`, re-summed `unreadSum` (DROP row when 0), then the EXISTING deleted-resurfacing presentation block, `latestMessageOf(maxConv)`, placement label - i.e. the current rowForConversation body from :510 down, refactored to take (contact, conv) instead of re-resolving; `unknown`/`relay_group`/`group_text` -> ONE `conversations.getById(conversationId)` point read, drop if now invisible/read, then the existing latestMessageOf/relayRowFor/groupRowFor.
  3. `nextCursor`: null if `consumedAll`; null (+ set page `truncated: true`) if minting would exceed SEEN_SET_MAX; null (+ `truncated: true`) if the loop ended on budget; else `encodeUnreadCursor(scanPosition, seen)`.
  4. Relay-merge (:804-842) and group-source (:856-881) blocks: SKIPPED entirely under filter=unread (their rows now come from the collector). `groupsTruncated` never set here.
- `conversations.getById` exists on the repo (used by GET /api/conversations/:conversationId, api.ts:1691); if the repo method has a different name, use that name everywhere - do not add a duplicate.

- [ ] **Step 1: Migrate fixtures RED-first.** Add `unread_flag: 'unread'` to every fixture item with `unread_count > 0` in: inboxApi.test.ts (:100-101,174,194-196,322-334,418-434,493,532), inboxEmail.test.ts (:79-175), contactSoftDelete.test.ts (:96-97,116), inboxFeed.test.ts (:193-240 + filter='unread' cases), inboxGroups.test.ts (:265-296), contactTriage.test.ts (:91), inbox.integration.test.ts (:311). Extend the inboxFeed in-memory conversations fake (:69-115) with `queryUnreadPage` DERIVED FROM `unread_flag` (not `unread_count`), honoring limit + exclusiveStartKey by (last_activity_at DESC, conversationId DESC) tuple, and `getById` by map lookup.
- [ ] **Step 2: Write the new failing route tests** (inboxFeed.test.ts unless noted):
  - per-row content parity: for one contact fixture, one unknown, one relay, one group - the row objects under the new path deep-equal the pre-change shape (assert against literal expected objects copied from a pre-change run).
  - unified composition: 2 contacts + 2 groups + 1 relay all unread, limit 3 -> page 1 = newest 3 by activity regardless of kind, `nextCursor !== null`; page 2 via cursor = remaining 2; union exact, no duplicates.
  - THE round-3 blocking case: 40 visible unread, limit 30, budget ample -> page 1 has 30 rows AND non-null cursor; page 2 has 10 + null cursor.
  - fill-or-exhaust: contact whose fresh re-sum is 0 (fake's participant threads read) is dropped and REPLACED by the next candidate; when ALL candidates drop and supply exhausts -> `rows: []`, `nextCursor: null`.
  - exclude-set accumulation across loop iterations: multi-thread contact whose older thread would re-emerge in iteration 2 -> exactly one row (assert no duplicate rowKey in the page).
  - depth cap: seed 101 distinct unread contacts, limit 30 -> page 4 mints no cursor and sets `truncated: true`.
  - budget: tiny budget (pass budget through a test seam - export the page's internals or set via deps override; the route uses UNREAD_WALK_LIMIT) -> underfull page + `truncated: true`; empty page + `truncated: true` when budget dies before any row.
  - cursor namespacing: unread cursor under filter=all -> 400; group/open-partition cursor under filter=unread -> 400; tampered `s` of 101 ids -> 400.
  - stale index row: fake index still lists a conversation whose stored item is read -> point read drops it (unknown/group kinds).
  - zero-unread dataset: empty page, null cursor, exactly 1 queryUnreadPage call, ZERO findByPhone/listByConversation/placements calls (call-count idiom from the fix-A tests at inboxFeed.test.ts:193+).
  - groupsTruncated: never present under filter=unread even with 60 unread groups (they page via cursor); (inboxGroups.test.ts) REWRITE the :265 full-walk contract test to assert exactly this.
  - deleted-contact resurfacing rows still render with `deleted: true` (contactSoftDelete.test.ts fixtures now flagged).
- [ ] **Step 3: Run the touched files -> RED. Step 4: Implement the rewrite. Step 5: Run -> GREEN; full `npm run test -w app` bare; typecheck.**
- [ ] **Step 6: Commit** `feat(inbox): index-backed unread page with seen-set cursor` (all touched paths explicit).

### Task 7: Contact soft-delete reset fan-out

**Files:**
- Modify: `app/src/routes/contacts.ts` (the soft-delete handler - find it via the presence fan-out emit at :1864; the delete sets `deleted_at` then fans out over `conversationsForContact`)
- Test: `app/test/contactSoftDelete.test.ts` (extend)

**Interfaces:**
- Consumes: `conversationsForContact` (lib/contactThreads.ts), `resetUnread`, `unreadOf`-equivalent check.

- [ ] **Step 1: Failing tests**: deleting a contact with 2 unread threads (1 phone, 1 email) -> `resetUnread` called for exactly those 2 (not the read third); items end count 0 + flag absent (harness fake from Task 2 models it); a `ConditionalCheckFailedException` from one reset does not fail the delete (mock one rejection); restore does NOT resurrect unread; delete-then-inbound: `incrementUnread` after the delete leaves the thread unread + flagged (resurfacing input intact).
- [ ] **Step 2: RED. Step 3: Implement** - inside the existing delete path, after `deleted_at` is written, mirror the POST /api/inbox/:contactId/read fan-out shape (inbox.ts:999-1015): `conversationsForContact` -> filter `unread_count > 0` -> `Promise.all(resetUnread)` each in try/catch swallowing `ConditionalCheckFailedException`; the handler's existing per-thread `conversation.updated` emits stay as-is (they already fire after the fan-out).
- [ ] **Step 4: GREEN + typecheck. Step 5: Commit** `feat(contacts): soft-delete resets unread across the contact's threads`.

### Task 8: Today - index-fed unread pass

**Files:**
- Modify: `app/src/routes/today.ts` (:515-641 region; `warnIfCapped` :354-357 gains an explicit threshold param)
- Test: `app/test/today*.test.ts` (whichever file covers the unread sections - locate via `grep -l "unreplied" app/test`)

**Interfaces:**
- Consumes: `iterateUnreadConversations` + `isUnreadVisible` + `toExclusiveStartKey` (Task 3). `TODAY_UNREAD_CAP = 100` local const.

- [ ] **Step 1: Failing tests**: (a) an unread 1:1 whose activity ranks it ~120th among open conversations (beyond the old 100-cap window) now yields an `unreplied` item; (b) the relay opt-out attention item still emits for an opted-out member in the first-100 window (loop intact); (c) 150 unread 1:1s -> exactly 100 items + the capped warn fired with threshold 100; (d) a burst of 120 unread group_text threads + 3 unread 1:1s -> all 3 1:1 items emit (filter-then-cap); (e) `emittedUnknownPhones` still dedupes the contacts-triage pass; (f) budget-expired underfilled pass -> rate-limited warn (use a deps seam for budget).
- [ ] **Step 2: RED. Step 3: Implement**: keep the :529 query + loop for the relay opt-out block ONLY (delete the unread gate + downstream from the loop); add a second pass driving the iterator, `if (!is1to1Bucket(conv)) continue;` (relay_group/group_text skipped), collect up to TODAY_UNREAD_CAP, then run the EXISTING per-conversation branches (unknown_1to1 -> needs_you_now + emittedUnknownPhones; tenant/landlord/partner -> unreplied) unchanged. Pass runs BEFORE the contacts-triage pass. `warnIfCapped(label, count, threshold)` - update the one existing call site with the old constant.
- [ ] **Step 4: GREEN + typecheck. Step 5: Commit** `feat(today): unread sections read the byUnread index`.

### Task 9: Seeds - flags + guard

**Files:**
- Modify: `app/src/lib/seed/performance.ts` (:820, :889 + invariant assertions :1069-1115 region)
- Test: `app/test/seedUnreadFlag.test.ts` (Create)

- [ ] **Step 1: Failing guard test**: import the seed fixture builders (lean/cast/live/performance conversation arrays - use the same accessors performanceSeed.integration.test.ts uses) and assert for EVERY conversation item: `('unread_flag' in item) === ((item.unread_count ?? 0) > 0)` and flag value is exactly `'unread'` when present.
- [ ] **Step 2: RED (performance rows with unread 2 lack the flag). Step 3: Implement**: at :820 and :889 add `...(unreadValue > 0 && { unread_flag: 'unread' as const })` using the same per-row conditional the count uses (factor the ternary into a local `const unreadValue = ...` first). Add the analogous assertion to the performance-seed invariant block. lean/cast/live need NO change (verify the guard passes them).
- [ ] **Step 4: GREEN; run `performanceSeed.integration.test.ts` too. Step 5: Commit** `feat(seed): performance fixtures carry unread_flag iff unread`.

### Task 10: Backfill script

**Files:**
- Create: `app/scripts/backfill-unread-flag.ts`
- Test: `app/test/backfillUnreadFlag.test.ts` (planner unit) + extend `app/test/unreadIndexRepo.integration.test.ts` (script round-trip)

**Interfaces:**
- Model on `app/scripts/backfill-broadcast-list-partition.ts` (header, `--dry-run` flag, Scan pagination, per-row conditional UpdateCommand, `{scanned, stamped, removed, skipped}` + add `{closedReset, deletedReset, probed}`, isEntrypoint guard) and `backfillConsentMethod.ts` (pure planner). Planner (exact):

```ts
export type BackfillAction =
  | { kind: 'stamp' } | { kind: 'remove' } | { kind: 'skip' }
  | { kind: 'reset' }            // zero count + remove flag (closed relay / stable-no deleted)
  | { kind: 'probe' };           // deleted-contact thread - needs the message read first
export function planUnreadBackfill(
  item: Record<string, unknown>,
  deletedContactKeys: { phones: ReadonlySet<string>; emails: ReadonlySet<string>;
                        deletedAtByKey: ReadonlyMap<string, string> },
): BackfillAction;
```

  Rules (spec 7.2, verbatim order): pointer partitions -> skip; `unread_count > 0` + closed relay_group -> reset; `unread_count > 0` + participant key in the deleted set -> probe (the runner then reads the newest message: inbound + `created_at > deleted_at` -> stamp, else reset); `unread_count > 0` + flag absent -> stamp; flag present + count 0/absent -> remove; else skip.
- Runner: pre-pass Scan of contacts collecting `deleted_at` phones/emails (contactPhones/contactEmails helpers from contactsRepo); then the conversations Scan applying the planner; every write idempotent (`ConditionExpression` guarding the state it transitions from). Local endpoint/prefix guard identical to `assertLocalInboxProfileTarget`'s posture but accepting the ambient env for dev/prod use (copy backfill-broadcast-list-partition's target resolution).

- [ ] **Step 1: Planner unit tests RED** (one per rule, incl. the probe->stamp and probe->reset resolutions and a pointer row). **Step 2: Implement planner. Step 3: GREEN.**
- [ ] **Step 4: Integration test**: seed a mixed table (flagged-read row, unflagged-unread row, closed-unread relay, deleted-contact thread with post-deletion inbound, one with pre-deletion only, pointer row); run the script function with dry-run -> counts only, no writes; live -> exact end-state assertions per row.
- [ ] **Step 5: GREEN + typecheck. Step 6: Commit** `feat(scripts): unread_flag backfill with close/delete retroactive rules`.

### Task 11: db-update-gsis script

**Files:**
- Create: `app/scripts/db-update-gsis.ts`
- Test: extend `app/test/unreadIndexRepo.integration.test.ts`

- [ ] **Step 1: Failing integration test**: create a table from a TABLES spec with one GSI artificially removed (build the CreateTableInput via `toCreateTableInput` from `app/src/lib/dynamoAdmin.ts:52-66`, then delete the GSI from it), run `ensureGsis()`, assert the table now has the missing GSI ACTIVE and a second run reports nothing to do.
- [ ] **Step 2: Implement**: localhost-endpoint guard copied from `db-create.ts:22-29`; for each TABLES spec, DescribeTable, diff GSI names, issue `UpdateTableCommand` with `GlobalSecondaryIndexUpdates: [{ Create: gsiInput(spec) }]` (reuse `gsiInput` from dynamoAdmin.ts:44-50; DynamoDB allows ONE create per call - loop with `waitUntilTableAvailable` between), attribute definitions merged from the spec. Log `added <table>.<index>` / `ok <table>`.
- [ ] **Step 3: GREEN + typecheck. Step 4: Add npm script** `"db:update-gsis": "tsx app/scripts/db-update-gsis.ts"` to root package.json. **Step 5: Commit** `feat(scripts): add missing local GSIs without dropping tables`.

### Task 12: Dashboard - types, endpoint, optimistic UnreadContext, wiring

**Files:**
- Modify: `dashboard/src/api/types.ts` (:2685-2695 `InboxPage.truncated?: true`; new `InboxUnreadCount` at :2686 region), `dashboard/src/api/endpoints.ts` (`getUnreadCount` after :1535), `dashboard/src/app/UnreadContext.tsx` (rewrite), `dashboard/src/routes/inbox/useInbox.ts` (clear-key derivation + noteRowsCleared/rollback wiring + surface `truncated` from BOTH fetch paths), `dashboard/src/routes/inbox/Inbox.tsx` (empty+truncated failure state), `dashboard/src/routes/tours/useTourChannels.ts` (:267-269, :288-293), `dashboard/src/routes/placements/usePlacementChannels.ts` (:275, :293)
- Test: `UnreadContext.test.tsx`, `useInbox.test.tsx`, `Inbox.test.tsx` (baseState factory :13-25), `AppFrame.test.tsx` (:6-8 stub), `useTourChannels.test.tsx`, `usePlacementChannels.test.tsx`

**Interfaces (exact):**

```ts
// types.ts
export interface InboxUnreadCount { unreadCount: number; capped: boolean; truncated: boolean }
// endpoints.ts
export function getUnreadCount(signal?: AbortSignal): Promise<InboxUnreadCount>; // GET /api/inbox/unread-count
// UnreadContext value
interface UnreadValue {
  unread: number | null;
  unmatchedUnread: number | null;
  noteRowsCleared: (keys: string[]) => void;     // no-op default on createContext
  rollbackRowsCleared: (keys: string[]) => void; // no-op default
}
// shared key helper (new file dashboard/src/app/unreadKeys.ts)
export function contactClearKey(contactId: string): string;      // `c:${id}`
export function phoneClearKey(phone: string): string;            // `u:${phone}`
export function conversationClearKey(conversationId: string): string; // `cv:${id}`
```

- UnreadContext mechanics (spec 4.7.2, implement exactly): `serverCount`/`capped` state + `pendingClears: Map<string, number>` in a ref-plus-version pattern (Map in a ref, integer version in state to trigger renders); displayed `unread = serverCount === null ? null : capped ? serverCount : Math.max(0, serverCount - pendingClears.size)`; fetch generation counter (a fetch resolving after a newer fetch STARTED is discarded); on a resolved fetch: expire every pending clear recorded BEFORE that fetch started, and if any expired, schedule ONE follow-up `fetchCount` in RECHECK_DELAY_MS = 2000 unless a fetch/debounce is already pending; TTL sweep expires clears older than PENDING_CLEAR_TTL_MS = 10_000 (lazy: checked on render/insert, plus a timer armed only while the map is non-empty); provider value memoized with useMemo; `onOpen: scheduleRefetch` added to the useEventStream subscription (:119-122).
- useInbox: in `markRead` past the :263/:283 guards, derive the key (`contact` -> contactClearKey, `unknown` -> phoneClearKey, `relay_group`/`group_text` -> conversationClearKey), call `noteRowsCleared([key])` alongside `setPatch`, `rollbackRowsCleared([key])` inside the `.catch` (:291-293). Surface `truncated` from page responses (both fetchFirstPage and loadMore) as new `InboxState.truncated: boolean`.
- Inbox.tsx: when `status === 'ready' && rows.length === 0 && truncated` render the existing error-state block copy "Couldn't load unread conversations." + the retry button (reuse the error affordance markup) instead of the all-caught-up empty state.
- Channel hooks: inside the existing guards (`unread <= 0 return`), `markGroupRead` calls `noteRowsCleared([conversationClearKey(conversationId)])` (+ rollback on catch); `markPersonRead` likewise with `contactClearKey(contactId)`. Consume the context via `useUnread()`.

- [ ] **Step 1: RED tests** (conventions per the existing files - importActual spread, arrow-wrapped mocks, sse handler capture, manual-promise-release for in-flight):
  - UnreadContext: fetches `/unread-count` (assert `getUnreadCount` called, not getInbox); optimistic decrement SYNCHRONOUS (assert displayed value before any await); idempotent double-insert; rollback restores; clamp at 0; capped suppression (capped:true, count 100 -> a clear leaves 100) and NO suppression with truncated-only; expiry on first post-clear resolved fetch (release-controlled promises: fetch A starts pre-clear -> resolving it does NOT expire; fetch B starts post-clear -> resolving expires + display returns to server value); follow-up scheduled once under a 3-click burst (fake timers for this one test; assert at most one pending timer); follow-up skipped when a debounce is pending; TTL backstop; generation guard (stale fetch discarded); bare-render safety (hook without provider -> no throw); onOpen triggers refetch.
  - useInbox: markRead fires noteRowsCleared exactly once with the right key per kind (4 cases); rollback on ApiError; truncated surfaced from loadMore page too.
  - Inbox.test: empty+truncated renders the failure copy, not "all caught up"; baseState gains `truncated: false`.
  - AppFrame.test stub gains the two no-op functions.
  - Channel hooks: markGroupRead/markPersonRead call the context past their guards, never below/at zero unread; provider-less render safe.
- [ ] **Step 2: RED. Step 3: Implement. Step 4: GREEN (`npm run test -w dashboard` bare) + typecheck.**
- [ ] **Step 5: Commit** `feat(dashboard): optimistic unread badge on the count endpoint`.

### Task 13: perf-harness + profiler migration

**Files:**
- Modify: `e2e/performance/templates.ts` (:119-121 region - add `/api/inbox/unread-count`), `e2e/performance/routes.ts` (:239 COLD_SHELL_GETS badge entry -> the new path with no query keys; line-pin :761 re-pointed at the rewritten UnreadContext lines; :666/:720 verified, expect no churn; :753-755 NOW CHANGE - the channel hooks gained wiring in Task 12, re-derive those pins), `e2e/performance/collect.ts` (:162 classifier -> path match `/api/inbox/unread-count` => `inbox_badge`; ensure an `/api/inbox?filter=unread&limit=100` PAGE request no longer classifies as badge; :128/:175-179/:362 keep compiling against the class), their tests (`routes.test.ts:48`, `collect.test.ts:207,230-233,250,269,296,303,315`, `report.test.ts:561,580`), `app/scripts/profile-inbox.ts` + `app/src/lib/inboxDiagnostics.ts` (plan: `unread-badge` case drives `countUnreadRows`-equivalent via the route helper; `unread-page` case at limit 30)
- Test: the three e2e-workspace test files above (they run under root `npm test`)

- [ ] **Step 1: RED**: update the pinned expectations first (routes.test.ts:48 string, collect.test.ts badge cases, report.test.ts) to the new contract; run `npm run test -w @housingchoice/e2e` - RED against the unmigrated source.
- [ ] **Step 2: Implement the source changes. Step 3: GREEN + typecheck (workspace).**
- [ ] **Step 4: profile-inbox**: swap the badge case to call the exported count helper (import from `../src/routes/inbox.js`), keep proxy-timing; run `npm run perf:inbox` against the local imported dataset if present (best-effort; do not fail the task if the local DB is absent - note it in the report).
- [ ] **Step 5: Commit** `feat(perf): migrate badge contract to unread-count`.

### Task 14: e2e nav-badge spec + full gates + handback prep

**Files:**
- Create: `e2e/tests/dashboard-next/inbox-nav-badge.spec.ts`
- Modify: `RUNBOOK.md` (owed-ops row per spec section 7.4), `docs/issues/inbox-unread-sse-full-walk.md` (status: resolved), `docs/issues/inbox-filter-tabs-full-walk.md` (unread half resolved note)

- [ ] **Step 1: Write the spec** (accessibility-first selectors; lean profile; model the raced-response idiom on `group-text-inbox.spec.ts:180-195`): seed an unread inbound (the existing lean-world inbound helper used by inbox-markread.spec.ts), assert the nav badge appears (`getByRole('navigation').getByRole('link', { name: 'Inbox' })` + sibling `span[aria-label*="unread"]` - the email-triage.spec.ts:53-60 locator shape); click the unread row; assert the badge DISAPPEARS (count was 1) BEFORE the reconcile lands - arm `page.waitForResponse` on `/api/inbox/unread-count` first and assert the badge is already gone when it resolves; repeat for a group-text unread (badge decrements on the group row's Mark-read button, no navigation).
- [ ] **Step 2: Run the new spec on a FRESH lane** (`npm run e2e` bare from the worktree; it recreates lane tables so the GSI exists - if the run shows the ~20-spec deterministic red cluster, wipe that lane's `hc-local-<L>-*` tables under key `hclane<L>` and rerun once). Known flakes: re-run once before blaming the change (`tour-reminders-panel-e2e-flake`, `conversationdetail-members-mock-suite-flake`).
- [ ] **Step 3: Docs**: RUNBOOK schema-changes row (apply BEFORE deploy; plan carries the owed backlog per RUNBOOK.md:117-220; backfill dry-run then live; `npm run db:update-gsis` + backfill for the human's local dataset); issue status flips; `npm run issues` to regenerate the index.
- [ ] **Step 4: FINAL GATES, bare, from the worktree**: `npm run typecheck`; `npm test`; `timeout 1500 npm run e2e`. Quote real exit codes in the handback.
- [ ] **Step 5: Sync main ONCE** (merge main into the branch; resolve preserving both sides; rerun typecheck + unit if anything merged). **Step 6: Commit remaining paths; write the handback per the orchestrator manual.**

---

## Self-review notes (planner)

- Spec 4.1-4.2 -> Tasks 1, 2, 7, 9, 10; 4.3 -> Tasks 3, 4; 4.4 -> Task 5; 4.5 -> Task 6; 4.6 -> Task 8; 4.7 -> Task 12; 7.2/7.3 -> Tasks 10, 11; 8's perf-harness block -> Task 13; e2e + ops -> Task 14. `db:update-gsis` npm alias delivered in Task 11.
- Type-consistency: `UnreadScanPosition`/`collectUnreadRows`/`queryUnreadPage`/clear-key helpers named identically across Tasks 2-6, 8, 12, 13.
- Known intentional deviation from full-code granularity: mechanical fixture sweeps and pin updates are specified as exact file:line inventories rather than repeated code blocks; the fixture edit is one attribute per listed line. Builders must treat every inventory line as mandatory.
