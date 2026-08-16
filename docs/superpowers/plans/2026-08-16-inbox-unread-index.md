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

- [ ] **Step 1: Update the two schema-guard tests to expect `byUnread`** - in `app/test/tables.test.ts` the conversations `gsiNames(t)` exact array gains `'byUnread'`; same array in `app/test/genTables.test.ts` (append after `byRelayStatus`). ALSO: (a) update the `it(...)` titles that enumerate the index list (tables.test.ts:164 region) so titles match content; (b) add a contract assertion for byUnread's shape exactly like the sibling sparse-index assertions at tables.test.ts:176-186: hash `unread_flag` S, range `last_activity_at` S, `sparse: true`.
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
  - `setRelayStatus(id, 'closed', 'open')` on an unread relay group -> count 0 + flag absent; `setRelayStatus(id, 'open', 'closed')` after -> count still 0 (reopen does not resurrect).
- [ ] **Step 2: Run, verify FAIL** (`npx vitest run test/unreadIndexRepo.integration.test.ts -w app` - queryUnreadPage undefined, flag assertions fail).
- [ ] **Step 3: Implement.** `incrementUnread` UpdateExpression becomes `'ADD unread_count :one SET unread_flag = :flag'` with `':flag': 'unread'` added to ExpressionAttributeValues (keep the existing ConditionExpression + ReturnValues). `resetUnread` becomes `'SET unread_count = :zero REMOVE unread_flag'`. `setRelayStatus`: PLANNER-VERIFIED signature (conversationsRepo.ts:724-728 and impl :1786): `(conversationId, status: 'open' | 'closed', expectedCurrent: 'open' | 'closed')` - three params, expectedCurrent REQUIRED, open<->closed only (connecting is assignPoolNumberAndOpen's business, untouched). Do NOT change the signature. When the `status` ARGUMENT is `'closed'`, extend that branch's UpdateExpression with `, unread_count = :zero` in SET and add `unread_flag` to REMOVE (note the method already assembles branch-specific clauses - the reopen branch REMOVEs close_announced_at per the W3 comment at :1795-1798 - so add to the closed branch's assembly, one atomic write). The 'open' branch is untouched. Test calls: `setRelayStatus(id, 'closed', 'open')` and reopen `setRelayStatus(id, 'open', 'closed')`. `queryUnreadPage`:

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
- [ ] **Step 5: Update the test fakes** so the invariant is modeled AND queryable everywhere. (a) `app/test/helpers/twilioWebhookHarness.ts:447-458`: `incrementUnread` also sets `unread_flag: 'unread'` on the stored item; `resetUnread` deletes the property; AND the fake gets a WORKING `queryUnreadPage` derived from the stored map - items with `unread_flag`, ordered (last_activity_at DESC, conversationId DESC), honoring limit + exclusiveStartKey by tuple - plus a `getById` map lookup if absent. This fake backs the route tests of Tasks 5-8 (inboxApi/inboxEmail/contactSoftDelete/contactTriage/today), so a stub here silently empties every unread test. (b) `app/test/contactCapture.test.ts:130`'s strictly-typed fake: same working `queryUnreadPage` (it is exercised by capture flows only, so deriving from the same stored array is enough). (c) `app/test/inboxGroups.test.ts:49-88`'s double-cast conversations fake: add `queryUnreadPage` (flag-derived, tuple-ordered) and `getById` - it is CAST, so the compiler will NOT flag the omission and the failure mode is a runtime TypeError. (d) After typecheck, sweep the CAST fakes the compiler cannot flag - the real casts in this repo are shaped `as unknown as NonNullable<InboxRouterDeps['conversationsRepo']>` and similar, so grep broadly: `grep -rn "as unknown as" app/test | grep -i -E "conversation|inboxrouterdeps"` plus `grep -rln "listByLastActivity" app/test` - every hit either gains a working `queryUnreadPage`/`getById` or provably never reaches the unread path (note which, in the task report).
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
  - WARN: read `app/src/lib/rateLimitedWarn.ts` FIRST and copy an existing call site's wiring (module-level limiter instance with a named key; interval per the module's convention). Test contract: with >500 scanned, the warn PATH is entered (assert via injected logger spy that warn was called AT LEAST once with the chosen message key; do NOT assert exactly-once - the limiter is time-based, not per-request, and its own behavior is already tested in its module).
- [ ] **Step 2: Run, verify FAIL** (module not found).
- [ ] **Step 3: Implement** - internal loop: Query pages of `Math.min(100, remaining budget)`; for each raw item: update scanPosition + scanned; if scanned > UNREAD_WALK_WARN enter the rate-limited warn path (the limiter owns dedupe - never assert exactly-once); skip invisible; `yield` visible. Stop when budget exhausted or no lastEvaluatedKey (set scanExhausted when the final page had no LEK AND all its items were consumed).
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
      unreadConversations: ConversationItem[] } // [0] is newest-encountered
  | { kind: 'unknown'; phone: string; conversation: ConversationItem }
  | { kind: 'relay_group' | 'group_text'; conversation: ConversationItem };

export interface CollectResult {
  candidates: UnreadCandidate[];
  scanPosition?: UnreadScanPosition; // after the last CONSUMED item
  consumedAll: boolean;  // supply ran out (scan exhausted AND drained)
  truncated: boolean;    // request budget ran out first
  capped: boolean;       // maxRows stopped emission
  remainingBudget: number;
  deletedProbes: number; // probes THIS collect ONLY - the caller
                         // accumulates per request and owns the WARN
                         // (the page loop makes many collects; a
                         // per-collect threshold could never fire)
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

- Grouping (spec 4.3): relay/group items -> own candidate. 1:1 items -> resolve contact (`findByPhone` on `participant_phone` first, then `findByEmail` on `participant_email` - the inbox.ts:476-477 order, both wrapped in try/catch degrading to no-contact); resolved -> one candidate per contactId; the FIRST (newest) encountered item is `unreadConversations[0]`, later same-contact items push behind it; excluded contactIds skipped entirely (their items still consume scan range); no contact + phone -> `unknown` candidate; no contact + no phone -> skipped. NO unread sums.
- Deleted contacts (spec 4.3 step 2), PER-THREAD EVALUATION (plan-review A6: a qualifying older thread can arrive AFTER a non-qualifying newer one, so a one-shot candidate evaluation would silently drop multi-thread deleted contacts): when a 1:1 item resolves to a deleted contact, probe THAT thread (`messages.listByConversation(convId, { limit: 1 })`, counting `deletedProbes`); the contact's candidate exists in a hidden state and becomes EMITTED at the stream position of the FIRST thread whose probe passes (`inbound && created_at > contact.deleted_at`); once emitted, later threads merge normally without probing. A contact none of whose encountered threads qualify never emits and never enters the seen-set (its items still consume scan range and count toward `consumedAll`). Probes are REPORTED via `deletedProbes`; the caller accumulates per request and fires the rate-limited `UNREAD_DELETED_PROBE_WARN` past 25 (Task 6's loop sums across collects; Task 5's single collect is the request).
- Emission stops AT `maxRows` - the generator is not pulled further (laziness carries through).

- [ ] **Step 1: Write failing tests** (extend the fakes with contacts/messages maps):
  - grouping: multi-phone contact with 2 unread threads -> ONE candidate, representative = newer, `unreadConversations.length === 2`; phone+email contact merges likewise; unknown-number item -> unknown candidate; contactless email item -> skipped; relay + group items -> own candidates.
  - excludeContactIds: contact's items skipped, scanPosition still advances past them.
  - capped vs consumedAll (THE round-3 blocking case): 300-item visible index, `maxRows: 30` -> `capped: true`, `consumedAll: false`, scanPosition after item 30's consumption; SAME data, `maxRows: 500` -> `consumedAll: true`, `capped: false`.
  - resume without loss: run once at maxRows 30, feed `scanPosition` + emitted contactIds back as startAfter/exclude -> second call emits exactly candidates 31..60, none duplicated, none skipped (assert by union of ids), including when items 30/31 share a `last_activity_at`.
  - deleted contact: fresh post-deletion inbound -> survives; pre-deletion-only unread -> dropped; post-deletion OUTBOUND newest -> dropped; a thread with stale `last_activity_at` OLDER than deleted_at but a fresh inbound message -> SURVIVES (the withdrawn-short-circuit regression case); MULTI-THREAD deleted contact whose NEWER thread fails the probe but whose OLDER thread passes -> exactly ONE candidate, emitted at the older thread's position (the per-thread evaluation case); `deletedProbes` counted; >25 probes in one collect -> rate-limited warn fires.
  - laziness passthrough: maxRows 1 against 300 visible -> 1 queryUnreadPage call.
- [ ] **Step 2: Run -> FAIL. Step 3: Implement. Step 4: Run -> PASS; typecheck.**
- [ ] **Step 5: Commit** `feat(inbox): unread row collector with contact grouping + resurfacing`.

### Task 5: GET /api/inbox/unread-count

**Files:**
- Modify: `app/src/routes/inbox.ts` (new route ABOVE the `/:contactId/read` registration; new exported handler helper `countUnreadRows(deps)` next to aggregateInbox; `InboxRouterDeps` gains optional `unreadWalkLimit?: number` here)
- Test: `app/test/inboxApi.test.ts` (extend - it already boots the router with fakes)

**Interfaces:**
- Produces: `GET /api/inbox/unread-count` -> 200 `{ unreadCount: number, capped: boolean, truncated: boolean }`; 500 on repo throw (no special handling - the client collapses errors).
- Implementation: one `collectUnreadRows` call, `maxRows: BADGE_COUNT_CAP, budget: deps.unreadWalkLimit ?? UNREAD_WALK_LIMIT` - THIS task introduces the optional `InboxRouterDeps.unreadWalkLimit?: number` field (doc-commented as a test seam; Task 6 consumes the same field); `unreadCount = candidates.length`, `capped`, `truncated` pass through. Fire the rate-limited UNREAD_DELETED_PROBE_WARN when the collect's `deletedProbes > 25` (single collect == the request here). NO hydration calls.

- [ ] **Step 1: Failing tests** in inboxApi.test.ts. EVERY new unread fixture item MUST carry `unread_flag: 'unread'` (the Task 2 harness index is flag-derived; a flagless fixture is invisible to it and the test dead-ends green/empty - round-2 finding). Cases: zero-unread fixture -> `{ unreadCount: 0, capped: false, truncated: false }` AND the fake recorded exactly 1 queryUnreadPage call and 0 findByPhone/listByConversation calls; a 3-contact + 1-group + 1-relay-open + 1-relay-CLOSED fixture -> `unreadCount: 5` (closed excluded); multi-thread contact counts once; 101+ visible candidates -> `unreadCount: 100, capped: true`; with the deps seam `unreadWalkLimit` (the optional InboxRouterDeps field THIS task introduces; Task 6 consumes the same field) set tiny -> `truncated: true` with a small real count; repo throw -> 500.
- [ ] **Step 2: Run -> FAIL. Step 3: Implement (route + helper). Step 4: PASS + typecheck.**
- [ ] **Step 5: Commit** `feat(inbox): unread-count endpoint`.

### Task 6: filter=unread rewrite - fill-or-exhaust page + seen-set cursor + truncated

**Files:**
- Modify: `app/src/routes/inbox.ts` (the `filter=unread` path of aggregateInbox; `InboxPage` at :118-129 gains `truncated?: true`; cursor codec; DELETE `GROUP_UNREAD_WALK_LIMIT`/`GROUP_UNREAD_GROWTH_THRESHOLD` and the unread group-walk branch at :857-887; rowForConversation is NOT edited beyond two dead-arm comments - see the bullets below)
- Modify: `app/src/lib/seed/performance.ts` (:820/:889 flags - moved here from Task 9), `dashboard/src/api/types.ts` (:2685-2695 `truncated?: true` - the same-commit rule)
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
- CURSOR DECODE ORDERING (plan-review B1 - BLOCKING if missed): aggregateInbox currently decodes EVERY non-groups cursor through `decodeCursor` at inbox.ts:363-364; under the new design that line must run ONLY for `filter === 'all' | 'unknown'`, and the unread branch decodes its own cursor via `decodeUnreadCursor`. `decodeCursor` gains the `u`-tag rejection (mirror the `t`-tag check at :233); `decodeGroupCursor` needs NOTHING (its existing tag check already rejects foreign cursors - round-2 verified). CAUTION: `startKey` doubles as the PAGE-ONE SENTINEL for the relay merge (gate at inbox.ts:816, block :801-853) and the group source (gate :867, block :855-892) - keep that variable and its semantics fully intact for filter=all/unknown; the unread branch keeps its own cursor state and never reads or writes `startKey`, and its relay/group merge blocks are skipped by filter, not by sentinel.
- NEWEST-CONVERSATION GUARD REMOVAL (plan-review A2/B2 - BLOCKING if missed): the hydration refactor of rowForConversation's body MUST NOT carry over the identity guard at inbox.ts:527-528 (`if (maxConv.conversationId !== conv.conversationId) return undefined`). Under the new path, row identity/dedupe is the collector's seen-set; `newestOf(convs)` is kept ONLY to pick the REPRESENTATION (phone/lastActivityAt/placement/latest-message source). Add the explicit test: a contact whose newest overall thread is READ and whose older thread is unread -> the row RENDERS, displaying the newest (read) thread's lastActivityAt.
- CONTACT-ROW BODY: EXTRACT, DO NOT FORK (round-3 decision, superseding round-2's 'not edited at all' - the shareable part is not just closures; the resurfacing predicate :537-576 and the row literals :583-597 are ~70 inline lines that would otherwise be duplicated): extract rowForConversation's contact-row construction - from AFTER its guards (post the :529 maxConv selection) through the returned row literal, INCLUDING the deleted-resurfacing predicate - into one aggregateInbox-scoped helper `buildContactRow(contact, convs, maxConv): Promise<InboxRow | undefined>` (undefined = resurfacing hid it). rowForConversation keeps ALL its guards (emittedContacts, newest-conversation identity at :527-528, the filter arms - now commented as dead for unread) and delegates to the helper; the unread hydration path calls the helper directly after its own re-sum/drop rules. The unknown/relay/group row builders are reused as-is (`latestMessageOf` + the :492-area unknown literal for unknown candidates, `relayRowFor` :620, `groupRowFor` :671 - all aggregateInbox-scoped and reachable). Behavior-identity for all/unknown is proven by the untouched existing suites + the Step 0 baseline; ADD the agreement test: a deleted-contact resurfacing fixture rendered via BOTH paths (filter=all through rowForConversation, filter=unread through the new path) yields deep-equal rows.
- BUDGET SEAM (plan-review B7): `InboxRouterDeps` gains optional `unreadWalkLimit?: number` (default UNREAD_WALK_LIMIT) consumed only by the unread branch - the budget tests drive it; document it as a test seam in the field's doc comment.
- Page algorithm (spec 4.5, implement exactly):
  1. Loop: `collectUnreadRows({ maxRows: limit - rows.length, budget: remaining, startAfter, excludeContactIds: seen })` - `remaining` starts at `deps.unreadWalkLimit ?? UNREAD_WALK_LIMIT` (the Task 5 seam) and threads each call's `remainingBudget` forward; hydrate candidates (below); accumulate emitted contactIds into `seen` (WHETHER OR NOT hydration kept the row); SUM each call's `deletedProbes` into a request-level accumulator and fire the rate-limited UNREAD_DELETED_PROBE_WARN once when the request total passes 25 (the sentinel is per-REQUEST; a per-collect threshold could never fire across many small collects); repeat until rows.length === limit, or `consumedAll`, or `remainingBudget === 0`.
  2. Hydration per candidate kind: `contact` -> `contactConversations(contact)` (per-request cache stays), `maxConv = newestOf(...)`, re-summed `unreadSum` (DROP row when 0), then delegate to the EXTRACTED `buildContactRow(contact, convs, maxConv)` helper (see the extraction bullet above - it carries the deleted-resurfacing predicate, latestMessageOf, placement label, and the row literal; undefined return = resurfacing hid the row -> drop and refill); `unknown`/`relay_group`/`group_text` -> ONE `conversations.getById(conversationId)` point read, drop if now invisible/read, then the existing latestMessageOf + unknown literal / relayRowFor / groupRowFor.
  3. `nextCursor`: null if `consumedAll`; null (+ set page `truncated: true`) if minting would exceed SEEN_SET_MAX; null (+ `truncated: true`) if the loop ended on budget; else `encodeUnreadCursor(scanPosition, seen)`.
  4. Relay-merge (:804-842) and group-source (:856-881) blocks: SKIPPED entirely under filter=unread (their rows now come from the collector). `groupsTruncated` never set here.
- `conversations.getById` exists on the repo (used by GET /api/conversations/:conversationId, api.ts:1691); if the repo method has a different name, use that name everywhere - do not add a duplicate.

- [ ] **Step 0: CAPTURE THE PARITY BASELINE BEFORE ANY inbox.ts EDIT** (plan-review: a builder mid-task cannot run 'pre-change' code). Write the new parity test file FIRST, running the CURRENT aggregateInbox against four fixtures (one contact, one unknown, one relay, one group under filter=unread). The fixtures MUST already carry `unread_flag: 'unread'` on their unread items (harmless to current code, which ignores the attribute; REQUIRED after the rewrite so the same fixtures stay index-visible - round-2 finding: a flagless baseline goes red with rows:[] for a reason unrelated to parity). The file is `app/test/inboxUnreadParity.test.ts` (add it to this task's Test list mentally and to every fake-sweep inventory); its conversations fake needs the SAME working `queryUnreadPage` (flag-derived, tuple-ordered) + `getById` as the Task 2 recipe, so the identical fixtures drive both the old and new paths. Serialize ONLY the individual ROW objects as literal expected JSON keyed by rowKey - never the page order, nextCursor, or groupsTruncated (spec 4.5 declares those three CHANGED; pinning them pins the old behavior). (npx vitest run with a temporary console.log, paste, delete the log.) Commit this passing baseline test on its own (`test(inbox): pin unread row-shape baseline`).
- [ ] **Step 1: Migrate fixtures RED-first.** Add `unread_flag: 'unread'` to every fixture item with `unread_count > 0` in: `app/src/lib/seed/performance.ts` :820/:889 builder sites TOO (moved here from Task 9 - plan-review B6: `performanceSeed.integration.test.ts:409` asserts unread rows exist, so the full-suite gate in this task fails if seeds lag the route; the seed edit is `...(unreadValue > 0 && { unread_flag: 'unread' as const })` with the existing per-row ternary factored into `unreadValue` - NOTE both sites sit inside single shared object literals, adjust in place), and in: inboxApi.test.ts (:100-101,174,194-196,322-334,418-434,493,532), inboxEmail.test.ts (:79-175), contactSoftDelete.test.ts (:96-97,116), inboxFeed.test.ts (:193-240 + filter='unread' cases), inboxGroups.test.ts (:265-296), contactTriage.test.ts (:91), inbox.integration.test.ts (:311). Extend the inboxFeed in-memory conversations fake (:69-115) with `queryUnreadPage` DERIVED FROM `unread_flag` (not `unread_count`), honoring limit + exclusiveStartKey by (last_activity_at DESC, conversationId DESC) tuple, and `getById` by map lookup.
- [ ] **Step 2: Write the new failing route tests** (inboxFeed.test.ts unless noted):
  - per-row content parity: `app/test/inboxUnreadParity.test.ts` (the Step 0 artifact) stays green through the rewrite - its pinned literals ARE the pre-change shapes; do not re-capture them after editing inbox.ts.
  - unified composition: 2 contacts + 2 groups + 1 relay all unread, limit 3 -> page 1 = newest 3 by activity regardless of kind, `nextCursor !== null`; page 2 via cursor = remaining 2; union exact, no duplicates.
  - THE round-3 blocking case: 40 visible unread, limit 30, budget ample -> page 1 has 30 rows AND non-null cursor; page 2 has 10 + null cursor.
  - fill-or-exhaust: contact whose fresh re-sum is 0 (fake's participant threads read) is dropped and REPLACED by the next candidate; when ALL candidates drop and supply exhausts -> `rows: []`, `nextCursor: null`.
  - exclude-set accumulation across loop iterations: multi-thread contact whose older thread would re-emerge in iteration 2 -> exactly one row (assert no duplicate rowKey in the page).
  - depth cap: seed 101 distinct unread contacts, limit 30 -> page 4 mints no cursor and sets `truncated: true`.
  - budget: tiny budget (pass budget through a test seam - export the page's internals or set via deps override; the route uses UNREAD_WALK_LIMIT) -> underfull page + `truncated: true`; empty page + `truncated: true` when budget dies before any row.
  - cursor namespacing: unread cursor under filter=all -> 400; group/open-partition cursor under filter=unread -> 400; tampered `s` of 101 ids -> 400.
  - stale index row: fake index still lists a conversation whose stored item is read -> point read drops it (unknown/group kinds).
  - zero-unread dataset: empty page, null cursor, exactly 1 queryUnreadPage call, ZERO findByPhone/listByConversation/placements calls (call-count idiom from the fix-A tests at inboxFeed.test.ts:193+).
  - probe-sentinel: a 30-deleted-contact fixture whose probes spread across multiple loop collects fires the request-level UNREAD_DELETED_PROBE_WARN via the accumulator (spy on the warn entry; a per-collect threshold would stay silent here - that is the regression this pins).
  - groupsTruncated: never present under filter=unread even with 60 unread groups (they page via cursor); (inboxGroups.test.ts) REWRITE the :265 full-walk contract test to assert exactly this.
  - deleted-contact resurfacing rows still render with `deleted: true` (contactSoftDelete.test.ts fixtures now flagged).
- [ ] **Step 3: Run the touched files -> RED. Step 4: Implement the rewrite. Step 5: Run -> GREEN; full `npm run test -w app` bare; typecheck.**
- [ ] **Step 6: SAME-COMMIT RULE (plan-review B12, spec section 8): `dashboard/src/api/types.ts` gains `truncated?: true` on InboxPage (:2685-2695) IN THIS COMMIT** (types-only; the dashboard consumes it in Task 12). Commit `feat(inbox): index-backed unread page with seen-set cursor` (all touched paths explicit, including the dashboard types file and the seed files).

### Task 7: Contact soft-delete reset fan-out

**Files:**
- Modify: `app/src/routes/contacts.ts` (the soft-delete handler - find it via the presence fan-out emit at :1864; the delete sets `deleted_at` then fans out over `conversationsForContact`)
- Test: `app/test/contactSoftDelete.test.ts` (extend)

**Interfaces:**
- Consumes: `conversationsForContact` (lib/contactThreads.ts), `resetUnread`, `unreadOf`-equivalent check.

- [ ] **Step 1: Failing tests**: deleting a contact with 2 unread threads (1 phone, 1 email) -> `resetUnread` called for exactly those 2 (not the read third); items end count 0 + flag absent (harness fake from Task 2 models it); a `ConditionalCheckFailedException` from one reset does not fail the delete (mock one rejection); restore does NOT resurrect unread; delete-then-inbound: `incrementUnread` after the delete leaves the thread unread + flagged (resurfacing input intact).
- [ ] **Step 2: RED. Step 3: Implement - IN THE DELETE HANDLER ONLY** (plan-review B5/A5 - BLOCKING if missed): contacts.ts:1864's presence fan-out lives inside `propagateContactPresenceChange`, which the RESTORE handler (:1942) ALSO calls; putting the reset there would zero genuine post-deletion unread on restore and break resurfacing. Implement the reset fan-out inline in the DELETE route handler (:1915 region), AFTER `deleted_at` is written and BEFORE/alongside its `propagateContactPresenceChange` call: `conversationsForContact` -> filter `unread_count > 0` -> `Promise.all(resetUnread)` each in try/catch swallowing `ConditionalCheckFailedException`. The existing emits stay. The Step-1 test list already includes the restore case - make it assert restore triggers ZERO resetUnread calls.
- [ ] **Step 4: GREEN + typecheck. Step 5: Commit** `feat(contacts): soft-delete resets unread across the contact's threads`.

### Task 8: Today - index-fed unread pass

**Files:**
- Modify: `app/src/routes/today.ts` (:515-641 region; `warnIfCapped` :354-357 gains an explicit threshold param)
- Test: `app/test/today*.test.ts` (whichever file covers the unread sections - locate via `grep -l "unreplied" app/test`)

**Interfaces:**
- Consumes: `iterateUnreadConversations` + `isUnreadVisible` + `toExclusiveStartKey` (Task 3). `TODAY_UNREAD_CAP = 100` local const.

- [ ] **Step 1: Failing tests**: (a) an unread 1:1 whose activity ranks it ~120th among open conversations (beyond the old 100-cap window) now yields an `unreplied` item; (b) the relay opt-out attention item still emits for an opted-out member in the first-100 window (loop intact); (c) 150 unread 1:1s -> exactly 100 items + the capped warn fired with threshold 100; (d) a burst of 120 unread group_text threads + 3 unread 1:1s -> all 3 1:1 items emit (filter-then-cap); (e) `emittedUnknownPhones` still dedupes the contacts-triage pass; (f) budget-expired underfilled pass -> rate-limited warn (use a deps seam for budget).
- [ ] **Step 2: RED. Step 3: Implement**: keep the :529 query + loop for the relay opt-out block ONLY (delete the unread gate + downstream from the loop); add a second pass driving the iterator, `if (!isOneToOneBucket(conv)) continue;` - `isOneToOneBucket` is a NEW export of `app/src/lib/unreadFeed.ts` (Task 3 file): `type !== 'relay_group' && type !== 'group_text'` (the negative 1:1 bucket; type-less rows pass, matching the visibility rule - today.ts's downstream branches then ignore type-less rows exactly as they do now, since they switch on the positive type values). Collect up to TODAY_UNREAD_CAP, then run the EXISTING per-conversation branches (unknown_1to1 -> needs_you_now + emittedUnknownPhones; tenant/landlord/partner -> unreplied) unchanged. Pass runs BEFORE the contacts-triage pass. `warnIfCapped` (:354-357) gains an explicit threshold parameter - update ALL SIX existing call sites (:381, :427, :493, :530, :696, :751) passing the old constant. Today's test fakes need a `queryUnreadPage` (flag-derived, tuple-ordered) added to whatever conversations fake the today tests use - locate it in the today test file's setup, same recipe as Task 2 step 5. Budget seam: TodayRouterDeps gains optional `unreadWalkLimit?: number` like Task 6's.
- [ ] **Step 4: GREEN + typecheck. Step 5: Commit** `feat(today): unread sections read the byUnread index`.

### Task 9: Seeds - flags + guard

**Files:**
- Modify: `app/src/lib/seed/performance.ts` (:820, :889 + invariant assertions :1069-1115 region)
- Test: `app/test/seedUnreadFlag.test.ts` (Create)

NOTE: the performance.ts seed EDITS moved into Task 6 step 1 (the full-suite gate there needs them). This task adds the standing GUARD only.
- [ ] **Step 1: Failing-by-construction guard test**: identify the real accessors first (read how `performanceSeed.integration.test.ts` obtains fixture arrays and mirror it; for lean/cast/live import their exported builders from `app/src/lib/seed/*.ts` - if a file exports only a writer function, refactor-export its item array builder). Assert for EVERY conversation item across all four worlds: `('unread_flag' in item) === ((item.unread_count ?? 0) > 0)` and the flag value is exactly `'unread'` when present. To prove the test CAN fail, temporarily flip one performance fixture's flag off, observe RED, revert.
- [ ] **Step 2: Add the analogous assertion to the performance-seed invariant block (performance.ts:1069-1115 region). Step 3: GREEN; run `performanceSeed.integration.test.ts` too. Step 4: Commit** `test(seed): guard unread_flag iff unread across seed worlds`.

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
- [ ] **Step 2: Implement**: localhost-endpoint guard copied from `db-create.ts:22-29`; for each TABLES spec, DescribeTable, diff GSI names, issue `UpdateTableCommand` with `GlobalSecondaryIndexUpdates: [{ Create: gsiInput(spec) }]`. `gsiInput` (dynamoAdmin.ts:44-50) is NOT exported today - EXPORT it (one-word change, note in the commit). UpdateTable REQUIRES `AttributeDefinitions` covering the new index's key attributes - build them from the spec's hash/range types (same mapping `toCreateTableInput` uses at :52-66) and pass only the attributes this index needs. DynamoDB allows ONE GSI create per UpdateTable call - loop with the SDK waiter for table ACTIVE between creates. Log `added <table>.<index>` / `ok <table>`.
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
- useInbox: in `markRead`, mint the key INSIDE the same branch that resolved the read action (plan-review B13: deriving from row.kind separately from the action branches lets a kind/field mismatch mint `c:undefined` - the third branch catches rows by PHONE): conversation branch (:271-275) -> conversationClearKey(conversationId); contactId branch (:276-278) -> contactClearKey(contactId); phone branch (:279-281) -> phoneClearKey(phone). Call `noteRowsCleared([key])` alongside `setPatch` (after the :283 addressability guard), `rollbackRowsCleared([key])` inside the `.catch` (:291-293). Surface `truncated` from page responses (both fetchFirstPage and loadMore) as new `InboxState.truncated: boolean`.
- Inbox.tsx: TWO gate edits, not one (round-3: gating only the error block would render the failure alert AND 'all caught up' together): (1) the error block (copy "We couldn't load your inbox." at Inbox.tsx:116) renders when `status === 'error' || (status === 'ready' && rows.length === 0 && truncated)`; (2) the empty-state block at Inbox.tsx:130 gains `&& !truncated`. Do not invent new copy; the spec's 4.5 step 3 was aligned to this exact reuse. Test: empty+truncated renders the failure copy and NOT the all-caught-up copy (assert both).
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
- Modify: `e2e/performance/templates.ts` (:119-121 region - add `/api/inbox/unread-count`), `e2e/performance/routes.ts` (:239 COLD_SHELL_GETS badge entry -> the new path with no query keys; line-pin :761 re-pointed at the rewritten UnreadContext lines; :666/:720 WILL churn - Task 12 adds `truncated` inside the pinned useInbox.ts:46-65 range - re-derive them against the actual post-Task-12 files, never assume; :753-755 also change - the channel hooks gained wiring in Task 12, re-derive), `e2e/performance/collect.ts` (the classifier function `classifyInboxRequestForCollection` at :141-166 has an EARLY RETURN for non-/api/inbox paths and a two-query-param arity guard at :147 - add the `/api/inbox/unread-count` path match BEFORE both, returning `{ requestClass: 'inbox_badge' }`; the old `filter==='unread' && limit==='100'` arm at :162 is REMOVED so a page request at limit 100 falls through to the page classes; :128/:175-179/:362 keep compiling against the class), their tests (`routes.test.ts:48`, `collect.test.ts:207,230-233,250,269,296,303,315`, `report.test.ts:561,580`), `app/scripts/profile-inbox.ts` + `app/src/lib/inboxDiagnostics.ts` (plan: `unread-badge` case drives `countUnreadRows`-equivalent via the route helper; `unread-page` case at limit 30)
- Test: the three e2e-workspace test files above (they run under root `npm test`)

- [ ] **Step 1: RED**: update the pinned expectations first (routes.test.ts:48 string, collect.test.ts badge cases, report.test.ts) to the new contract; run `npm run test -w @housingchoice/e2e` - RED against the unmigrated source.
- [ ] **Step 2: Implement the source changes. Step 3: GREEN + typecheck (workspace).**
- [ ] **Step 4: profile-inbox**: the case list is a TYPED UNION in `app/src/lib/inboxDiagnostics.ts:44-52` (`createInboxProfilePlan`), not in profile-inbox.ts - extend the union with a `kind: 'unread-badge-endpoint'` case and branch on it in `app/scripts/profile-inbox.ts`'s runner to call the exported count helper (import from `../src/routes/inbox.js`), keeping proxy-timing; the existing `unread-page` case moves to limit 30. Run `npm run perf:inbox` against the local imported dataset if present (best-effort; note absence in the report rather than failing).
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
