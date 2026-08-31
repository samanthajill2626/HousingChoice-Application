# Research: `app/src/routes/inbox.ts` as it exists NOW

Read-only survey taken 2026-08-26 from `W:\tmp\inbox-unread-cluster`, branch
`feat/inbox-unread-cluster`, working tree CLEAN. File is 2003 lines.

Contract checked against:
- `docs/superpowers/specs/2026-08-25-inbox-unknown-tab-walk-design.md`
- `docs/superpowers/plans/2026-08-25-inbox-unknown-tab-contact-side-read.md`
  (facts block + Task 5)

QUOTING CONVENTION (this file is ASCII-only per AGENTS.md): the source contains
a small number of non-ASCII bytes. Where a quoted line carries one, it is
written here as `[EMDASH]` (U+2014) or `[ARROW]` (U+2192). Those markers are
NOT in the source; everything else is byte-exact. Any line you TOUCH must be
ASCII, so treat a marker as "do not retype this character".

---

## DRIFT / CORRECTIONS (read these first)

### D1. The plan's Step 6 names FOUR stale-comment sites. There are EIGHT.

Step 6 lists: the read-accounting block (~599-623), `passesFilter`'s unknown
arm (~710-711), `rowForConversation`'s header + unknown arms (~836-838, ~901),
and the relay-merge / group-gate comments (~1571-1576, ~1599-1601). All four
are real and correctly located. The flip ALSO invalidates these, none of which
the plan mentions:

- **`inbox.ts:341-342`** - inside `decodeUnreadCursor`:
  ```
      // A cursor minted under `all`/`unknown` (a bare LastEvaluatedKey) or under
      // `groups` (the repo's `{t,k}`) carries no `u:1` and lands here.
  ```
  After Step 4 the unknown feed MINTS no cursor at all, so "a cursor minted
  under `all`/`unknown`" is false. This comment is the file's own record of the
  cursor namespacing; leaving it says the opposite of the new 400 posture.

- **`inbox.ts:804-807`** - inside `buildContactRow`:
  ```
      // A type='unknown' contact IS an untriaged inbound (it just already has a
      // record) - so it needs triage and belongs under the "unknown" filter, exactly
      // like a no-contact record. Keying triage off the ROLE (not "no contact
      // record") is what makes both cases surface.
  ```
  (Verified byte-exact; all four lines are ASCII.)
  "exactly like a no-contact number" is precisely the class (e) claim the flip
  RETIRES: a contactless number no longer surfaces on the tab. Worth an
  amendment, or the next reader re-derives class (e) as still covered.

- **`inbox.ts:930-931`**:
  ```
      // Deleted fast-path: nothing unread -> hidden, no message read needed. NOT
      // dead - it still runs for `all` and `unknown`.
  ```
  After the flip it runs for `all` ONLY.

- **`inbox.ts:1611-1617`** - the `filteredGroup` keep-comment:
  ```
      // `filteredGroup` is DEAD TODAY and kept deliberately: only `filter=all`
      // reaches this block (`groups` and `unread` returned earlier, `unknown` is
      // gated out above) and `passesFilter` is unconditionally true for `all`, so
      // the counter can never fire. It exists so a future filter that DOES reach
      // here cannot silently drop every group row - the shape `filteredRelay`
      // catches on `unknown` today. Read its absence as "no information", not as
      // "nothing was dropped".
  ```
  Two stale claims: `unknown` is no longer "gated out above" (it returns much
  earlier), and `filteredRelay` no longer "catches on `unknown` today" - which
  is the same fact Step 6 item 4 already asks you to fix at :1571.

### D2. "`groups` returns at 1034, `unread` at 1064" cites the BRANCH OPENINGS, not the returns.

- `1034` is `  if (filter === 'groups') {`. Its `return {` is at **1046**, closing
  `}` at **1053**.
- `1064` is `  if (filter === 'unread') {`. Its `return {` is at **1449**,
  closing `}` at **1454**.

Task 5 Step 5's own instruction ("insert after the closing `}` at ~1454") is
correct; the facts block's numbers are just not what the prose says they are.
Anchor the insertion on the CLOSING BRACE, not on 1064.

### D3. `app/test/inboxGroups.test.ts` - the `filter=unknown` test is NOT at 357.

The plan says line 357 twice (Task 2 Step 4 and Task 5's preamble). Actual:
`const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, deps);` is
at **`inboxGroups.test.ts:367`**. Its `contactsRepo` fake block IS at 101-109 as
claimed.

### D4. Everything else in the facts block VERIFIED byte-exact.

Confirmed unchanged at the cited lines: cursor gate 576-579; `buildContactRow`
742-828; `contactConversations` 634-658; `roleFromContact` 396-403;
`InboxPage.truncated` 147-152; `messages.listByConversation` array read 690;
`satisfies Record<Union,true>` 439-448; `unreadFeed.js` import block 86-96;
pager start 1474; `moreChunks` bound 1481 / read 1522; `moreChunks` has exactly
one reader; unread discriminator base read 1148-1161; `warnUnreadScanned`
convention 1351; unread `scanned` field 1434; `collectUnreadRows`
`unreadFeed.ts:478`; flag semantics `unreadFeed.ts:695-709` with the cap set at
`:674-677`; `UNREAD_WALK_LIMIT = 2000` (`unreadFeed.ts:46`);
`contactsRepo.listByType` `:522` with `ListContactsOpts` `:472-490`;
`ContactType` `contactsRepo.ts:51`; `isDeleted` `contactsRepo.ts:306-308`;
`byTypeStatus` `lib/tables.ts:90-93`; harness `listByType` fake at
`twilioWebhookHarness.ts:1684` with the items-remaining LEK defect at `:1707`
and the deleted-before-Limit filter at `:1691` (both as described);
`unreadIndexFake.ts` LEK doc at ~104-118; dashboard
`serverEndedEarlyEmpty` at `Inbox.tsx:42`, banner `:183`, per-filter empty state
`:199`; `inboxFilters.ts:27` = `No unknown numbers`; `inboxApi.test.ts:199-218`;
`inbox.integration.test.ts:323-330`; `performanceSeed.integration.test.ts:414`.

---

## 1. `aggregateInbox`

Declared **559-562**, body ends **1656**.

```
export async function aggregateInbox(
  opts: { filter: InboxFilter; limit: number; cursor?: string },
  deps: InboxRouterDeps,
): Promise<InboxPage> {
```

Doc comment **552-558**:
```
/**
 * Assemble one page of the inbox feed. See the module header for the
 * newest-conversation rule + the split-proof cursor scheme.
 *
 * Throws InboxBadRequestError for a malformed cursor (the route [ARROW] 400). All
 * other repo reads are best-effort and degrade rather than throw.
 */
```
(Line 556's `[ARROW]` is a real U+2192 in the source, verified with `cat -A`
as `M-bM-^FM-^R`. Do not retype it as `->` unless you are deliberately
ASCII-fixing that line.)

Options type is INLINE (there is no named `AggregateInboxOpts`):
`{ filter: InboxFilter; limit: number; cursor?: string }`.
`deps` type is `InboxRouterDeps` (see section 9).

**The local bindings the new branch's code refers to (563-567):**
```
  const log = deps.logger ?? defaultLogger;
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const placements = deps.placementsRepo ?? createPlacementsRepo({ logger: deps.logger });
```
All four bare names the plan's new code uses (`contacts`, `conversations`,
`messages`, `log`) exist in that scope, plus `deps` itself (the parameter) for
the new seams. **569**: `  const { filter, limit, cursor } = opts;`

**Where each existing filter branch returns:**

| filter | branch opens | `return` | closing `}` |
| --- | --- | --- | --- |
| `groups` | 1034 | 1046-1052 | **1053** |
| `unread` | 1064 | 1449-1453 | **1454** |

The insertion point named by Task 5 Step 5:
- Line **1454** is exactly `  }` (the unread branch's closing brace).
- Line **1455** is BLANK.
- Line **1456** is `  const rows: InboxRow[] = [];`

So the new branch goes between 1454 and 1456, i.e. replacing the blank line 1455
with the new block plus surrounding blank lines.

## 2. The cursor decode gate

**570-579**, byte-exact:
```
  // ONLY `all` and `unknown` page the 'open' partition, so ONLY they decode the
  // cursor here. The other two filters own their own cursor NAMESPACE and decode
  // it themselves: `groups` inside listGroupTexts (the repo's tagged `{t,k}`),
  // `unread` via decodeUnreadCursor (the `{u,a,c,s}` index cursor) in its branch
  // below. Decoding either of those as an 'open'-partition LastEvaluatedKey is
  // precisely the cross-partition replay the namespacing exists to prevent.
  const startKey =
    (filter === 'all' || filter === 'unknown') && cursor !== undefined
      ? decodeCursor(cursor)
      : undefined;
```

`startKey` has three later readers, ALL page-one gates: **1465**
(`let chunkStartKey: Record<string, unknown> | undefined = startKey;`), **1545**
(`if (startKey === undefined) {`, relay merge), **1601**
(`if (startKey === undefined && filter !== 'unknown') {`, group source).

## 3. `buildContactRow`

A CLOSURE inside `aggregateInbox`. Doc **719-741**, declaration **742-748**,
body ends **828**.

```
  const buildContactRow = async (
    contact: ContactItem,
    convs: ConversationItem[],
    maxConv: ConversationItem,
    unreadSum: number,
    deleted: boolean,
  ): Promise<InboxRow | undefined> => {
```

The single-`undefined` contract, quoted from its doc (**728-734**):
```
   * SINGLE-CAUSE RETURN: `undefined` means exactly one thing - resurfacing hid
   * a soft-deleted row. Every other reason to skip a contact belongs to the
   * CALLER (the filter arms, the newest-conversation identity guard, the dedupe
   * set), and each caller records its own dedupe entry when this returns a row
   * (the pager -> emittedContacts; the unread loop -> its seen-set). That is
   * observably identical to adding it here, since the add only ever happened
   * when a row was about to be returned.
```
The only `return undefined` is **795** (`      if (!resurfaces) return undefined;`),
inside `if (deleted) {` at **757**. With `deleted=false` it always returns a row.
Returned literal is **813-827**, ending
`      needsTriage: role === 'unknown',` (825) and
`      ...(deleted && { deleted: true }),` (826).

## 4. `contactConversations`

Closure, **633-658**:
```
  /** All open 1:1 conversations a contact owns, across every phone AND email (cached). */
  const contactConversations = async (contact: ContactItem): Promise<ConversationItem[]> => {
    if (contactConvsCache.has(contact.contactId)) {
      return contactConvsCache.get(contact.contactId)!;
    }
    let list: ConversationItem[] = [];
    try {
```
...
```
      const all = await conversationsForContact(contact, conversations);
      list = all.filter((c) => c.status === 'open' && c.type !== 'relay_group');
    } catch (err) {
      log.warn({ err, contactId: contact.contactId }, 'inbox: contact conversations lookup failed (best-effort)');
    }
    contactConvsCache.set(contact.contactId, list);
    return list;
  };
```
(the `const all = ...` line is **651**, the filter **652**, the catch **653**,
the warn **654**, the cache write **656**, the return **657**.)

Confirms the plan: it cannot carry threw-vs-empty. NOTE the plan does not
mention: the catch path ALSO writes `[]` into `contactConvsCache` (656), so a
throw poisons the per-request cache. The new branch's `resolveOpenThreads`
bypasses this closure entirely, so it shares no cache with it - each contact
resolved by both paths pays its participant-GSI Queries twice. The plan's
sweep loop guards that with `emitted.has(...)` BEFORE `resolveOpenThreads`, so
the double-pay does not occur for the disjoint sources as written.

`conversationsForContact` signature (`app/src/lib/contactThreads.ts:38-41`):
```
export async function conversationsForContact(
  contact: ContactItem,
  conversations: Pick<ConversationsRepo, 'findByParticipantPhone' | 'findByParticipantEmail'>,
): Promise<ConversationItem[]> {
```

## 5. `roleFromContact`

MODULE-LEVEL (not a closure), **395-403**:
```
/** A contact's audience role for the row chip (tenant/landlord/partner, else unknown). */
function roleFromContact(
  contact: ContactItem | undefined,
): 'tenant' | 'landlord' | 'partner' | 'unknown' {
  if (contact?.type === 'tenant') return 'tenant';
  if (contact?.type === 'landlord') return 'landlord';
  if (contact?.type === 'partner') return 'partner';
  return 'unknown';
}
```
Not exported. Takes `ContactItem | undefined`.

## 6. `newestOf`, `unreadOf`, `dropped`, `drops`

`unreadOf` - MODULE-LEVEL, **405-411**:
```
/**
 * The unread count carried on a conversation row (sparse [ARROW] 0). Pulled into a
 * helper so the cross-number SUM and the per-row read share one definition.
 */
function unreadOf(conv: ConversationItem): number {
  return typeof conv.unread_count === 'number' ? conv.unread_count : 0;
}
```

`newestOf` - CLOSURE inside `aggregateInbox`, **660-667**:
```
  /** The newest conversation in a set (max last_activity_at); undefined if empty. */
  const newestOf = (convs: ConversationItem[]): ConversationItem | undefined => {
    let best: ConversationItem | undefined;
    for (const c of convs) {
      if (best === undefined || c.last_activity_at > best.last_activity_at) best = c;
    }
    return best;
  };
```
WATCH OUT: there is a SECOND, unrelated `newestOf` at **1889-1893**, a different
closure inside `createInboxRouter` (a `reduce`-based one for the mark-unread
routes). Do not confuse them; they are in different scopes and never collide.

`drops` and `dropped` - **624-631**:
```
  let rawScanned = 0;
  let rawQueries = 0;
  const drops: Record<string, number> = {};
  /** Record a drop reason and return the `undefined` the caller was returning. */
  const dropped = (reason: string): undefined => {
    drops[reason] = (drops[reason] ?? 0) + 1;
    return undefined;
  };
```
`drops` IS a plain object (`Record<string, number>`), not a Map. `dropped(reason)`
increments the counter and returns `undefined` - so `return dropped('x')` and a
bare `dropped('x'); continue;` are both idiomatic here (the pager uses the
former; the plan's new branch uses the latter, which is fine).

`Object.keys(drops).length > 0` is the emit gate used at **1651** and **1961**
(plan's new code) - same shape.

## 7. The `../lib/unreadFeed.js` import block

**86-96**, byte-exact:
```
import {
  BADGE_COUNT_CAP,
  collectUnreadRows,
  isUnreadVisible,
  UNREAD_WALK_LIMIT,
  warnDeletedProbes,
  warnTruncatedZeroCount,
  warnUnreadScanned,
  type UnreadCandidate,
  type UnreadScanPosition,
} from '../lib/unreadFeed.js';
```

Confirmations the plan asked for:
- `collectUnreadRows` YES (used 1246, and by `countUnreadRows` 1680)
- `UNREAD_WALK_LIMIT` YES (used 1077, 1684, 1702)
- `warnDeletedProbes` YES (used 1346, 1690)
- `warnUnreadScanned` YES (used 1351)
- `BADGE_COUNT_CAP` YES - used at **1683** only, inside `countUnreadRows`
- `countUnreadRows` is DECLARED here (`inbox.ts:1674`), not imported. Used by the
  route at **1790** and imported by `app/scripts/profile-inbox.ts:20`.

Nothing orphans if the new branch declines `BADGE_COUNT_CAP`.
Also imported but NOT in this block and relevant: `warnTruncatedZeroCount` (1701),
`isUnreadVisible` (1171, 1210, 1902).
`UNREAD_WALK_WARN` is NOT imported (the plan's Step 5 comment mentions it in
prose only - do not add an import for it).

## 8. `conversationsForContact` and `isDeleted` - ALREADY IMPORTED

Both are already in the file; the flip needs no new import for either.

- `conversationsForContact`, **84**:
  `import { conversationsForContact } from '../lib/contactThreads.js';`
  Existing uses: 651 (inside `contactConversations`), 1851, 1986 (routes).
- `isDeleted`, **72**, inside the contactsRepo block **70-75**:
  ```
  import {
    createContactsRepo,
    isDeleted,
    type ContactItem,
    type ContactsRepo,
  } from '../repos/contactsRepo.js';
  ```
  Existing uses: 903, 1183, 1950, 1977.

`ContactItem` (73) and `ConversationItem` (66) types are both in scope for the
new `resolveOpenThreads` signature.

## 9. `InboxRouterDeps` - FULL interface

**173-190**:
```
// --- Deps (injectable; default to the real repos, like TodayRouterDeps) ------

export interface InboxRouterDeps {
  logger?: Logger;
  conversationsRepo?: ConversationsRepo;
  contactsRepo?: ContactsRepo;
  messagesRepo?: MessagesRepo;
  placementsRepo?: PlacementsRepo;
  events?: EventBus;
  /**
   * TEST SEAM: the raw byUnread items ONE request may scan before it gives up
   * and reports a floor. Production leaves it undefined and takes
   * UNREAD_WALK_LIMIT; a route test sets it small so the `truncated` posture is
   * reachable without seeding thousands of rows. Threaded in from
   * ApiRouterDeps.
   */
  unreadWalkLimit?: number;
}
```
`unreadWalkLimit` is the LAST member; the plan's four new seams go after it,
before the closing `}` at 190.

Note the repos are typed as the FULL repo interfaces (`ContactsRepo`, not a
`Pick`), which is why the test fakes need the
`as unknown as NonNullable<InboxRouterDeps['contactsRepo']>` envelope.

## 10. `InboxBadRequestError`

EXPORTED, **244-254**:
```
/**
 * A bad client input (malformed cursor / bad filter) the route maps to 400 [EMDASH]
 * NEVER a 500. Mirrors the project posture (a tampered cursor must not reach
 * DynamoDB as a malformed key nor crash the handler).
 */
export class InboxBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboxBadRequestError';
  }
}
```

The route layer maps it at **1766-1779** (inside `router.get('/')`):
```
    try {
      const page = await aggregateInbox(
        { filter, limit, ...(cursor !== undefined && { cursor }) },
        deps,
      );
      res.json(page);
    } catch (err) {
      if (err instanceof InboxBadRequestError) {
        res.status(400).json({ error: err.message });
        return;
      }
      log.error({ err }, 'inbox feed failed');
      throw err; // Express 5 forwards async throws to the error handler.
    }
```
So a `throw new InboxBadRequestError(...)` from the new branch reaches a 400
with no route change, and any OTHER throw (the LOUD `listByType` failure) is
ERROR-logged and re-thrown to Express's 500.

Existing thrown messages, for copy consistency: `'invalid cursor'` (272, 335,
345, 353, 355, 358, 362) and `'cursor does not match this filter'` (284, 291,
343, 1023). The plan's new branch uses the second string - matching precedent.

## 11. `InboxPage`

**137-153**, byte-exact:
```
export interface InboxPage {
  rows: InboxRow[]; // newest-activity-first; ONE row per contact
  nextCursor: string | null;
  /** TRUE when the GROUP source could not show every group thread it was asked
   *  for, so the dashboard renders the "showing latest N" affordance instead of
   *  implying the page is complete. Two causes, both surfaced the same way:
   *  the page-one top-50 cap under `filter=all`, and listGroupTexts' own walk
   *  budget. There is NO exact total - the partition cannot produce one without
   *  walking it (spec 11). Absent means "nothing was withheld". */
  groupsTruncated?: boolean;
  /** TRUE when the UNREAD feed ended for a NON-NATURAL reason (spec 4.5 step 3):
   *  the request's raw-scan budget expired before the page filled, or the
   *  SEEN_SET_MAX depth cap ended paging. Set on the `filter=unread` branch
   *  ONLY - never on all/unknown/groups. Absent means the feed ended because it
   *  ran out of unread rows, which is the ordinary case. */
  truncated?: true;
}
```

**There is NO `serverRowCount` on `InboxPage`.** That field is DASHBOARD-side:
`dashboard/src/routes/inbox/useInbox.ts:81` (`serverRowCount: number;`) and
`:543` (`serverRowCount: base.length,`), consumed at
`dashboard/src/routes/inbox/Inbox.tsx:42`:
```
  const serverEndedEarlyEmpty = inbox.serverRowCount === 0 && inbox.truncated;
```
`truncated` is typed `?: true` (literal), so the plan's
`...(truncated && { truncated: true as const })` shape at 1452 is required; the
new branch omitting the key entirely satisfies `'truncated' in page === false`.

## 12. The `filter === 'unread'` branch - the shape to mirror

Branch **1064-1454**. Budget setup **1076-1078**:
```
    // ONE raw-scan budget for the whole REQUEST (spec 4.3), threaded into and
    // back out of every collect. `unreadWalkLimit` is the deps test seam.
    const startingBudget = deps.unreadWalkLimit ?? UNREAD_WALK_LIMIT;
    let remainingBudget = startingBudget;
```

`collectUnreadRows` call, **1246-1255**:
```
      const collected = await collectUnreadRows(
        { conversations, contacts, messages, logger: log },
        {
          maxRows: limit - unreadRows.length,
          budget: remainingBudget,
          ...(scanPosition !== undefined && { startAfter: scanPosition }),
          excludeContactIds: seen,
          wastedProbesBefore: wastedProbes,
        },
      );
```
Note the deps object shape `{ conversations, contacts, messages, logger: log }`
is EXACTLY what the plan's new branch reuses.

The two tripwires, **1342-1351**:
```
    // Both tripwires fire ONCE, on the REQUEST total. The scanned total is
    // exactly `startingBudget - remainingBudget` because ONE budget is threaded
    // through every collect; the in-collector WARN is per-walk and would miss a
    // request that scanned 200 in each of three collects.
    warnDeletedProbes(log, {
      probes: deletedProbes,
      wasted: wastedProbes,
      skipped: deletedSkipped,
    });
    warnUnreadScanned(log, startingBudget - remainingBudget);
```
`scanned` is therefore `startingBudget - remainingBudget` - NOT a row count.
The plan's `sweepScanned: sweepBudget - collected.remainingBudget` is the same
derivation over a single collect.

The `'inbox feed assembled'` log, **1430-1448**:
```
    log.info(
      {
        filter,
        count: unreadRows.length,
        scanned: startingBudget - remainingBudget,
        seen: seen.size,
        hasMore: unreadCursor !== null,
        ...(truncated && { truncated: true }),
        // THE RETRY VOLUME, on the REQUEST-level line (adversarial r3 finding
        // 4 asked for the request's WARN payload; the retry is now hard-capped
        // at `limit`, so it is a per-request STATISTIC rather than a tripwire,
        // and this is the line that already carries scanned/seen/truncated).
        // Always present when nonzero, so the pair "the badge counts rows this
        // page could not deliver" is readable without a second request.
        ...(laggedRetries > 0 && { laggedRetries }),
        ...(unresolvedDrops > 0 && { unresolvedDrops }),
      },
      'inbox feed assembled',
    );
```
`log.info(fields, message)` - fields FIRST, message SECOND. The test assertion
`info.mock.calls.find((c) => c[1] === 'inbox feed assembled')?.[0]` in the plan
matches this call shape. All three `'inbox feed assembled'` sites use it: 1037,
1430, 1633.

`collectUnreadRows` return shape (`app/src/lib/unreadFeed.ts:685-715`) - the
flag semantics the new branch must read BOTH of:
```
    consumedAll: !capped && state.scanExhausted,
```
...
```
    truncated: !capped && !state.scanExhausted,
    capped,
    remainingBudget: Math.max(0, opts.budget - state.scanned),
    deletedProbes,
    wastedProbes,
    skippedDeletedThreads,
```
`capped` is set at `unreadFeed.ts:674-677`, counting ALL candidate kinds:
```
    if (candidates.length >= opts.maxRows) {
      capped = true;
      break;
    }
```
Plan's `capped MASKS truncated` claim is CORRECT.

## 13. `passesFilter`

**698-717**, byte-exact:
```
  /** Does the row pass the active filter? EXHAUSTIVE on purpose - the `default:`
   *  arm this switch used to carry made a missing filter case SILENT (every row
   *  passing), which is exactly how a new filter ships as a no-op. */
  const passesFilter = (row: InboxRow): boolean => {
    switch (filter) {
      case 'unread':
        // UNREACHABLE since spec 4.5 (the unread branch returns before any
        // caller of this runs) but NOT removable: the switch is exhaustive over
        // InboxFilter with no `default:`, so deleting the arm is a type error -
        // and re-adding a `default:` is exactly how a new filter ships as a
        // silent no-op.
        return row.unreadCount > 0;
      case 'unknown':
        return row.needsTriage;
      case 'groups':
        return row.kind === 'group_text';
      case 'all':
        return true;
    }
  };
```
The `'unread'` keep-comment is 704-708; the `'unknown'` arm is 710-711 and
currently carries NO comment. Callers: 1493 (pager), 1575 (relay merge), 1619
(group source).

## 14. `rowForConversation`

Header **830-839**:
```
  /**
   * Build the row for a single raw conversation (or return undefined when this
   * conversation does NOT emit one: a relay_group, an already-emitted contact,
   * or a contact whose newest conversation is elsewhere). Pure of paging [EMDASH] the
   * caller owns the page-fill / boundary bookkeeping.
   *
   * THE OPEN-PARTITION PATH ONLY (filters `all` and `unknown`). `filter=unread`
   * returns from its own index-backed branch before the pager runs, so the
   * unread arms below are unreachable today - see their comments.
   */
```
(The `[EMDASH]` is on line 833. Line 836 is the sentence Step 6 item 3 targets.)

Declaration **840**:
```
  const rowForConversation = async (conv: ConversationItem): Promise<InboxRow | undefined> => {
```
Body ends **942**.

**EVERY arm mentioning `filter === 'unknown'` - there is exactly ONE:**

- **901**: `    if (filter === 'unknown' && role !== 'unknown') return dropped('unknownFilterRole');`
  with its lead-in at **897-899**:
  ```
      // A resolved contact's role is enough to reject it from Unknown. Keep this
      // ahead of conversation, message, and placement hydration; only type=unknown
      // contacts can produce a known-contact row for this filter.
  ```
  and `const role = roleFromContact(contact);` at **900**.

That is also **the only `unknownFilterRole` drop-counter site in the file**
(grep confirms one occurrence). After the flip the counter can never fire, so a
log reader must be told so - as Step 6 item 3 requires.

Other `filter === ...` arms in the same function, for orientation (all
`'unread'`, all already marked DEAD ARM):
- **876**: `      if (filter === 'unread' && unreadOf(conv) === 0) return dropped('unreadZeroUnknown');`
  (comment 873-875)
- **929**: `    if (filter === 'unread' && unreadSum === 0) return dropped('unreadZeroContact');`
  (comment 926-928)
The wording those two use ("DEAD ARM (spec 4.5): ... Kept because `filter` is a
runtime value and this is still its right answer.") is the shape to mirror on
the unknown arm.

The contactless-unknown row literal (the class (e) row the flip removes from
this filter) is **879-890**, reached only when `!contact` and `phone !== undefined`.

## 15. The read-accounting comment block

**588-623**, byte-exact:
```
  // --- Read accounting for the assembled-feed log line ------------------------
  // WHY THIS EXISTS: a zero-row answer is, in the log we ship today, identical
  // to a healthy one - `count: 0` cannot say whether the partition Query came
  // back empty or whether every row it returned was dropped during assembly.
  // Three e2e sightings of a READY-AND-EMPTY All tab were undiagnosable for
  // exactly that reason (call-inbox-unread-detached-node-flake): the failure
  // artifacts are browser-side only, and nothing server-side recorded which of
  // the two happened. `rawScanned` separates those two worlds in one field, and
  // the per-reason drop counts name WHICH guard consumed the rows when it was
  // the second. Kept in production, not test-only scaffolding: the same
  // ambiguity exists in every deployed environment.
  //
  // SCOPE, stated because the fields are easy to over-read:
  //
  // - They cover the OPEN-PARTITION pager only - filters `all` and `unknown`.
  //   The `groups` and `unread` branches return through their own log lines and
  //   carry none of this. The unread line's `scanned` is BUDGET UNITS, not rows,
  //   so `count: 0, scanned: 0` there still carries the ambiguity this removed
  //   for `all`. Filed rather than fixed here: see
  //   docs/issues/inbox-read-accounting-gaps.md.
  // - `rawScanned == count + sum(drops)` DOES NOT HOLD, in ANY case - including
  //   the `count: 0` one. `count` includes relay and group rows that no chunk
  //   Query ever scanned; a page that FILLS stops mid-chunk with the remaining
  //   items counted in `rawScanned` but never assembled; and `filteredRelay` /
  //   `filteredGroup` count rows that were never scanned either, so `sum(drops)`
  //   can EXCEED `rawScanned` (an empty open partition with three filtered relay
  //   rows logs `rawScanned: 0, drops: {filteredRelay: 3}`). Do not do this
  //   arithmetic; read the fields as two separate statements - what the
  //   partition returned, and what assembly discarded.
  // - `drops` is a NORMAL-TRAFFIC field, not an exception field: `dupContact`
  //   fires for every extra thread of a multi-number contact on the same page.
  //   Its absence means nothing was dropped; its presence means nothing is
  //   wrong.
  // - `filteredRelay` and `filteredGroup` are PAGE-ONE-ONLY (both merge blocks
  //   gate on `startKey === undefined`), so their absence on page 2+ carries no
  //   information at all.
```
The sentence Step 6 item 1 edits is line **602**.

## 16. The relay-merge drop comment and the group-source gate

Relay drop, **1568-1577**:
```
    const relayRows: InboxRow[] = [];
    for (const conv of relayItems) {
      const row = await relayRowFor(conv);
      // Counted like the pager's own filter drops. On filter=unknown this arm
      // rejects EVERY relay row (a relay row's needsTriage is always false), so
      // leaving it uncounted made a zero-row Unknown page look like an empty
      // partition - the precise confusion these fields exist to break.
      if (passesFilter(row)) relayRows.push(row);
      else dropped('filteredRelay');
    }
```
(comment is 1571-1574; code 1575-1576.)

Group-source gate, **1597-1601**:
```
  let groupCount = 0;
  let groupsTruncated = false;
  // `unknown` never contains group rows (needsTriage is always false), so skip
  // the query outright rather than reading a partition to throw it all away.
  if (startKey === undefined && filter !== 'unknown') {
```
Followed by 1602-1606:
```
    // Only `filter=all` reaches here now (`groups` and `unread` returned above),
    // so the read is always the page-one cap. The unread FULL PARTITION WALK
    // this block used to run - and its growth WARN - died with spec 4.5: unread
    // group rows come from the byUnread index like every other unread row, and
    // page-one overflow of ANY kind is reachable through the unread cursor.
```
That "Only `filter=all` reaches here now" line (1602) is ALREADY true and stays
true; it is the `filter !== 'unknown'` gate at 1601 that becomes belt-and-braces.

## 17. The open-partition pager

Starts **1474**: `  pager: for (;;) {`. Setup immediately above:
- **1456** `  const rows: InboxRow[] = [];`
- **1457** `  let nextCursor: string | null = null;`
- **1465** `  let chunkStartKey: Record<string, unknown> | undefined = startKey;`
- **1472** `  const chunkSize = Math.min(FETCH_BATCH, Math.max(limit, DEFAULT_INBOX_LIMIT));`
  (`FETCH_BATCH = 100` at 205)

`moreChunks`:
- BOUND at **1481**: `    const moreChunks = chunk.lastEvaluatedKey !== undefined;`
- READ at **1522**: `    if (!moreChunks) {` - the ONLY reader (grep-confirmed).

Loop ends **1528**. The pager currently serves **BOTH `all` AND `unknown`**:
`groups` returned at 1053 and `unread` at 1454, so the only two filters that can
reach 1456+ are `all` and `unknown`. After the flip it serves `all` alone.

## 18. `readGroupSource` - the LOUD precedent

**1001-1027**:
```
  /**
   * The group source. Reads the group_open partition ONLY.
   *
   * LOUD BY CONTRACT (spec 4.2): unlike the relay source's best-effort catch, a
   * failed group query is NOT swallowed. "No group threads" and "the group query
   * broke" would be indistinguishable, and the failure mode is every group
   * conversation silently vanishing from the inbox. The repo logs at ERROR and
   * throws; we let it propagate to the route's 500.
   */
  const readGroupSource = async (
    readLimit: number,
    groupCursor?: string,
  ): Promise<{ items: ConversationItem[]; nextCursor?: string; truncated: boolean }> => {
    try {
      return await conversations.listGroupTexts({
        limit: readLimit,
        ...(groupCursor !== undefined && { cursor: groupCursor }),
      });
    } catch (err) {
      if (err instanceof GroupCursorError) {
        // A cursor from another partition (or a tampered one) -> 400, never a
        // silent restart of the walk at the newest row.
        throw new InboxBadRequestError('cursor does not match this filter');
      }
      throw err;
    }
  };
```
The plan's Step 5 comment cites "the group source (readGroupSource above)" - it
IS above the insertion point (1001 vs 1455), so the phrasing is accurate.

## 19. EVERY `'unknown'` site in inbox.ts, classified against the flip

| line | site | after the flip |
| --- | --- | --- |
| 100 | `InboxFilter` union member | LIVE (wire contract) |
| 107 | `InboxRow.kind` includes `'unknown'` | LIVE - `all` and `unread` still emit contactless unknown rows |
| 111 | `role` union | LIVE |
| 118 | `needsTriage` doc | LIVE |
| 150 | `truncated` doc: "never on all/unknown/groups" | LIVE and now MORE load-bearing (requirement 5) |
| 157 | badge doc "one per unknown number" | LIVE (badge unaffected) |
| 211 | `INBOX_FILTERS` allowlist entry | LIVE |
| 341-342 | `decodeUnreadCursor` comment "minted under `all`/`unknown`" | **STALE - see DRIFT D1** |
| 395-402 | `roleFromContact` | LIVE - the new branch's live type re-check uses it |
| 577 | cursor decode gate | **CHANGED by Task 5 Step 4** |
| 602 | read-accounting SCOPE line | **STALE - Step 6 item 1** |
| 710-711 | `passesFilter` `'unknown'` arm | **UNREACHABLE - Step 6 item 2 (keep, comment it)** |
| 804-807 | `buildContactRow` triage comment "exactly like a no-contact number" | **STALE (class e) - not in the plan; see D1** |
| 825 | `needsTriage: role === 'unknown'` | LIVE - the new branch's rows get it from here |
| 836-838 | `rowForConversation` header | **STALE - Step 6 item 3** |
| 866-890 | contactless-unknown row literal | LIVE for `all` / DEAD for `unknown` |
| 897-901 | `unknownFilterRole` guard + its only counter site | **DEAD ARM - Step 6 item 3** |
| 930-931 | "NOT dead - it still runs for `all` and `unknown`" | **STALE - not in the plan; see D1** |
| 972 | relay `needsTriage: false` comment | LIVE (still true) |
| 996-998 | group `needsTriage: false` comment | LIVE (still true) |
| 1211-1236 | unread branch's `'unknown'` candidate arm | LIVE (unread only) |
| 1571-1574 | relay drop comment | **STALE - Step 6 item 4** |
| 1599-1601 | group-source gate | **BELT-AND-BRACES - Step 6 item 4** |
| 1611-1617 | `filteredGroup` keep-comment | **STALE - not in the plan; see D1** |
| 1746 | route doc `filter=all|unread|unknown|groups` | LIVE |

## 20. The limit clamp

- **194-196**:
  ```
  /** Default + max page size (one row per contact). Clamped at the route. */
  export const DEFAULT_INBOX_LIMIT = 25;
  export const MAX_INBOX_LIMIT = 100;
  ```
- The clamp happens ONLY at the route, in `parseLimit` (**1731-1737**):
  ```
  /** Parse + clamp ?limit= into 1..MAX_INBOX_LIMIT; default DEFAULT_INBOX_LIMIT. */
  function parseLimit(raw: unknown): number {
    if (raw === undefined) return DEFAULT_INBOX_LIMIT;
    const n = typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isInteger(n)) return DEFAULT_INBOX_LIMIT;
    return Math.min(MAX_INBOX_LIMIT, Math.max(1, n));
  }
  ```
  called at **1762**: `    const limit = parseLimit(req.query['limit']);`

`aggregateInbox` itself does NOT clamp - a direct caller (every unit test,
`profile-inbox.ts`) can pass any `limit`. The plan's
`UNKNOWN_QUEUE_MAX_ROWS = 200` doc ("2x the route's MAX_INBOX_LIMIT") is
consistent with 100. Note the unit tests pass `limit: 25`/`30`/`3`, unclamped -
so the new branch's `unknownRows.slice(0, limit)` window must not assume
`limit <= 100`.

---

## SWEEP: surfaces the plan does NOT mention that the flip touches

### S1. `app/scripts/profile-inbox.ts` is a second `aggregateInbox` caller.

- `app/scripts/profile-inbox.ts:20` -
  `import { aggregateInbox, countUnreadRows, type InboxFilter } from '../src/routes/inbox.js';`
- `app/scripts/profile-inbox.ts:117` - `const page = await aggregateInbox(`
- Its plan comes from `app/src/lib/inboxDiagnostics.ts:70`:
  `    { kind: 'inbox-page', caseId: 'unknown-page', filter: 'unknown', limit: 30 },`

NOT broken - it injects `createTimedRepository` proxies over the REAL repos, so
`contacts.listByType` resolves. But the `unknown-page` case now measures a
completely different workload, and its per-operation trace rows change shape
(`contacts.listByType` appears; `conversations.listByLastActivity` disappears).
`app/test/inboxDiagnostics.test.ts` pins the PLAN shape, not the workload, so it
stays green (the plan's claim that this file needs no change holds), but the
profiler's saved comparison baselines are invalidated.

### S2. `e2e/performance/cli.ts:582` models `unknown` as a group-bearing surface.

```
  if (filter === 'all' || filter === 'unknown') {
    return await visibleFixedLink('See all group texts');
  }
```
This probes the `groupsTruncated` affordance. Today it is already always false
for `unknown` (the group source is gated out at inbox.ts:1601 and
`groupsTruncated` is never set), and the flip keeps it false, so no assertion
changes. Flagged because the harness explicitly pairs `unknown` with `all` here
- if anyone later "cleans up" this arm they will be reading a stale model.

### S3. `e2e/performance/routes.ts:583` marks `inbox-unknown` scale-bearing.

```
row({ surfaceId: 'inbox-unknown', ... behaviorFamily: 'inbox', ... terminal: inboxTerminal('No unknown numbers'), gets: inboxGets('inbox_page_unknown'), surfaceScaleBearing: true, loadScaleBearing: true }),
```
Pinned by `e2e/performance/routes.test.ts:327`. The plan's Global Constraints
correctly forbid touching `inboxFilters.ts` (the `No unknown numbers` copy at
`dashboard/src/routes/inbox/inboxFilters.ts:27`, verified) and forbid changing
the query tuple (`e2e/performance/collect.ts:185` requires EXACTLY
`filter=unknown&limit=30`, `entries.length !== 2`). What it does NOT say: this
surface is `surfaceScaleBearing`/`loadScaleBearing`, so its measured cost is
part of the perf model. The flip makes it dramatically cheaper - which should
only ever pass a max-budget assertion, but if any budget has a LOWER bound or a
ratio check, that is where it fires.

### S4. `e2e/tests/dashboard-next/inbox.spec.ts:23` iterates the tab labels.

```
  for (const label of ['All', 'Unread', 'Unknown']) {
```
Tab presence only; unaffected. Task 8 correctly targets
`e2e/tests/dashboard-next/unknown-caller-triage.spec.ts` instead.

### S5. The cursor 400 cannot be reached from the shipped dashboard.

`Inbox.tsx` (~line 48) states: "useInbox drops the cursor on every filter change
(its fetch callback is keyed on the filter), so no stale cursor can cross
partitions." Combined with `nextCursor: null` from the new branch, the dashboard
can never send `filter=unknown&cursor=...`. The 400 is therefore a
tamper/foreign-cursor posture only - which is what the plan intends, but the
plan never verifies the client cannot trip it. It cannot.

### S6. No SSE / live path reads the unknown tab specially.

`appEvents` / `toConversationUpdatedEvent` are used only by the mark-read and
mark-unread routes (1826, 1859, 1918). Nothing in the live path branches on
filter. `countUnreadRows` (the badge) does NOT share code with the unknown
filter - it calls `collectUnreadRows` directly with `BADGE_COUNT_CAP` and never
touches `aggregateInbox`. The badge is unaffected by the flip.

### S7. Test files that call `aggregateInbox` with `filter: 'unknown'` today.

Complete list (grep-confirmed), so nothing is missed at flip time:
- `app/test/inboxFeed.test.ts:407, 433, 539, 610, 738` (the plan names 591-613
  and 736-766; **407, 433 and 539 are three more sites** - 407/433 are the
  partner-excluded and Alexis `c-unk` tests the plan mentions as needing only a
  `status` fixture edit, 539 is the relay-matrix pin at ~521's seed)
- `app/test/inboxGroups.test.ts:367` (see DRIFT D3)
- `app/test/inboxApi.test.ts:199-218` (route level)
- `app/test/inbox.integration.test.ts:323-330` (real DynamoDB)
- `app/test/performanceSeed.integration.test.ts:410, 414`
- `app/src/lib/inboxDiagnostics.ts:70` (profiler plan, via profile-inbox.ts)

`app/test/inboxUnreadParity.test.ts` and `app/test/inboxDiagnostics.test.ts`
confirmed to have NO `filter: 'unknown'` call - the plan's claim holds.
