# Implementation plan - inbox mark-unread

Spec: `docs/superpowers/specs/2026-08-17-inbox-mark-unread-design.md` (approved
at the human's gate, tip `2dbdea0f`).
Worktree: `W:\tmp\inbox-mark-unread`   Branch: `feat/inbox-mark-unread`
Base: `main` @aa62b493

Assume ZERO context. Every path is repo-relative from the worktree root. Every
task is TDD: write the failing test, watch it fail for the RIGHT reason, then
implement.

---

## Global constraints (copied verbatim from the spec - do not re-derive)

- `unread_count = 1` is the written value. `SET`, never `ADD`.
- The sparse GSI hash constant is `UNREAD_FLAG_VALUE` (`'unread'`), already
  exported from `app/src/repos/conversationsRepo.ts`.
- **MU-1**: a mark-unread write is permitted only where
  `isUnreadVisible({ ...c, unread_count: 1 })` is true. Enforced as a WRITE
  CONDITION, not a prior read.
- **MU-2**: refused when the target thread's contact is soft-deleted. Enforced
  in the route (it cannot ride the condition - different item).
- Condition clause 3: `(attribute_not_exists(unread_count) OR unread_count = :zero)`.
  `unread_count` is genuinely sparse - the `attribute_not_exists` half is load-bearing.
- Condition-failure classification order, ALL routes: absent -> 404;
  ineligible -> 409; eligible-and-already-unread -> 200 no write. **Eligibility
  is checked BEFORE the count.**
- Every route returns the authoritative resulting count.
- `last_activity_at` is NEVER written by this feature.
- Fan-in selection: `status === 'open'` AND `isOneToOneBucket`, newest by
  `last_activity_at`, strict `>` so ties keep first-encountered.
- ASCII only in all new/touched lines, including comments and test names.
- Commit explicit paths only. A bare `git status` is a SEPARATE read before
  every commit. `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## Verification commands

Per-slice (fast): `npm test -- <path>` for the touched test file.
Slice gates: `npm run typecheck`.
Final gates, BARE, from the worktree root, never piped:
`npm run typecheck`, then `npm test`, then `npm run e2e`.

## Slice order and why

S1 -> S2 -> S3 are server, bottom-up: the primitive, then the conversation
route, then the two fan-in routes. S4 is the client bridge. S5 -> S8 are client
surfaces. S9 is e2e. **S6 must land before S7**: S7's header actions call the
handle S6 creates, so building S7 first leaves the drain unimplementable and
invites the builder to ship the round-2 bug the spec exists to prevent.

Each slice is independently green. Stopping between any two leaves the tree
passing and no user-visible half-feature (the client surfaces are the only
user-visible parts, and each lands complete).

---

# S1 - Repo primitive `setUnread`

Files: `app/src/repos/conversationsRepo.ts`,
`app/src/repos/conversationsRepo.integration.test.ts`

## S1.1 RED - the tests

Add to `app/src/repos/conversationsRepo.integration.test.ts`, following the
existing `resetUnread` describe block's setup idioms (reuse whatever helper the
neighbouring unread tests use to seed a conversation; do NOT invent a new one).

```ts
describe('setUnread', () => {
  it('sets unread_count to 1 and stamps unread_flag on a read thread', async () => {
    const conv = await seedConversation({ status: 'open', unread_count: 0 });
    const updated = await repo.setUnread(conv.conversationId, { bucket: 'one_to_one' });
    expect(updated.unread_count).toBe(1);
    expect(updated.unread_flag).toBe('unread');
  });

  it('ACCEPTS a thread that has no unread_count attribute at all', async () => {
    // unread_count is sparse: a thread that never received an inbound has never
    // had it written. A bare `unread_count = :zero` condition would 409 this
    // class of thread forever and nothing else in the suite would catch it.
    const conv = await seedConversation({ status: 'open' }); // no unread_count
    const updated = await repo.setUnread(conv.conversationId, { bucket: 'one_to_one' });
    expect(updated.unread_count).toBe(1);
  });

  it('REFUSES an already-unread thread, leaving the real count intact', async () => {
    const conv = await seedConversation({ status: 'open', unread_count: 5 });
    await expect(
      repo.setUnread(conv.conversationId, { bucket: 'one_to_one' }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    const after = await repo.getById(conv.conversationId);
    expect(after?.unread_count).toBe(5);
  });

  it('throws ConditionalCheckFailedException for an unknown conversation', async () => {
    await expect(
      repo.setUnread('conv-does-not-exist', { bucket: 'one_to_one' }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });

  // --- the condition bites, per bucket -------------------------------------
  it('one_to_one refuses a closed thread', async () => {
    const conv = await seedConversation({ status: 'closed', unread_count: 0 });
    await expect(
      repo.setUnread(conv.conversationId, { bucket: 'one_to_one' }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });

  it('one_to_one refuses a row whose type is relay_group', async () => {
    const conv = await seedConversation({ status: 'open', type: 'relay_group', unread_count: 0 });
    await expect(
      repo.setUnread(conv.conversationId, { bucket: 'one_to_one' }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });

  it('one_to_one ACCEPTS a legacy row with no type', async () => {
    const conv = await seedConversation({ status: 'open', unread_count: 0 }); // no type
    const updated = await repo.setUnread(conv.conversationId, { bucket: 'one_to_one' });
    expect(updated.unread_count).toBe(1);
  });

  it('relay_group accepts open and connecting, refuses closed', async () => {
    for (const status of ['open', 'connecting'] as const) {
      const ok = await seedConversation({ status, type: 'relay_group', unread_count: 0 });
      const updated = await repo.setUnread(ok.conversationId, { bucket: 'relay_group' });
      expect(updated.unread_count).toBe(1);
    }
    const closed = await seedConversation({ status: 'closed', type: 'relay_group', unread_count: 0 });
    await expect(
      repo.setUnread(closed.conversationId, { bucket: 'relay_group' }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });

  it('relay_group REFUSES an open 1:1 thread (the type clause, not the status)', async () => {
    // Without the type clause this passes silently: a 1:1 thread also carries
    // status 'open', so only the route's own type read would separate them -
    // the exact value the conditional write exists to distrust.
    const conv = await seedConversation({ status: 'open', unread_count: 0 }); // 1:1
    await expect(
      repo.setUnread(conv.conversationId, { bucket: 'relay_group' }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });

  it('group_text accepts group_open and refuses plain open', async () => {
    const ok = await seedConversation({ status: 'group_open', type: 'group_text', unread_count: 0 });
    const updated = await repo.setUnread(ok.conversationId, { bucket: 'group_text' });
    expect(updated.unread_count).toBe(1);

    const wrong = await seedConversation({ status: 'open', type: 'group_text', unread_count: 0 });
    await expect(
      repo.setUnread(wrong.conversationId, { bucket: 'group_text' }),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });

  it('round trip: setUnread lands the row in the byUnread index', async () => {
    const conv = await seedConversation({ status: 'open', unread_count: 0 });
    await repo.setUnread(conv.conversationId, { bucket: 'one_to_one' });
    const page = await repo.queryUnreadPage({ limit: 50 });
    expect(page.items.map((i) => i.conversationId)).toContain(conv.conversationId);

    await repo.resetUnread(conv.conversationId);
    const after = await repo.queryUnreadPage({ limit: 50 });
    expect(after.items.map((i) => i.conversationId)).not.toContain(conv.conversationId);
  });
});
```

Run `npm test -- app/src/repos/conversationsRepo.integration.test.ts`. Every
test must fail with "setUnread is not a function" - NOT a condition error. If
any fails differently, the seed helper is wrong; fix that before implementing.

## S1.2 GREEN - the type

In `app/src/repos/conversationsRepo.ts`, above the `ConversationsRepo`
interface:

```ts
/**
 * Which eligibility predicate `setUnread` writes into its ConditionExpression.
 * The ROUTE picks the bucket from the item it read; the CONDITION is what makes
 * that choice safe against a transition committing in between (MU-1).
 */
export type UnreadBucket = 'relay_group' | 'group_text' | 'one_to_one';
```

Add to the interface, immediately after `resetUnread`'s declaration:

```ts
  /**
   * Make a thread unread (`unread_count = 1` + the sparse `unread_flag`), the
   * mirror of resetUnread. Carries its whole precondition in the
   * ConditionExpression: the row must exist, match the bucket's type/status
   * predicate (MU-1), and be currently READ. A read-then-write would be TOCTOU
   * - a relay close committing in the window leaves permanent index residue.
   * Throws ConditionalCheckFailedException when ANY clause fails; the caller
   * classifies by re-reading (routes: 404 absent / 409 ineligible / 200
   * already-unread, in that order).
   */
  setUnread(conversationId: string, eligibility: { bucket: UnreadBucket }): Promise<ConversationItem>;
```

## S1.3 GREEN - the implementation

Insert immediately after the `resetUnread` implementation (around
`conversationsRepo.ts:1561`):

```ts
    async setUnread(conversationId, eligibility) {
      // MU-1 AS A WRITE CONDITION. Every bucket carries a TYPE clause, not only
      // one_to_one: a 1:1 thread also carries status 'open', so without it the
      // relay_group predicate would be satisfied by any open 1:1 and the only
      // separator would be the route's own type read - the value this condition
      // exists to distrust. It is safe today only because the sole type-changing
      // writer (convertRelayGroupToGroupText) also moves status out of the
      // admitted set; do not depend on that coincidence.
      const names: Record<string, string> = { '#s': 'status' };
      const values: Record<string, unknown> = {
        ':one': 1,
        ':flag': UNREAD_FLAG_VALUE,
        ':zero': 0,
      };
      let predicate: string;
      if (eligibility.bucket === 'relay_group') {
        names['#type'] = 'type';
        values[':type'] = 'relay_group';
        values[':open'] = 'open';
        values[':connecting'] = 'connecting';
        predicate = '#type = :type AND #s IN (:open, :connecting)';
      } else if (eligibility.bucket === 'group_text') {
        names['#type'] = 'type';
        values[':type'] = 'group_text';
        values[':groupOpen'] = GROUP_TEXT_STATUS;
        predicate = '#type = :type AND #s = :groupOpen';
      } else {
        // The 1:1 bucket mirrors isOneToOneBucket's NEGATIVE test, so a legacy
        // row with no `type` - and any future 1:1 type - stays admitted rather
        // than vanishing.
        names['#type'] = 'type';
        values[':relay'] = 'relay_group';
        values[':groupText'] = 'group_text';
        values[':open'] = 'open';
        predicate =
          '(attribute_not_exists(#type) OR NOT #type IN (:relay, :groupText)) AND #s = :open';
      }

      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId },
          // Counter and flag ride ONE write, so the row can never be
          // unread-but-unindexed - the property incrementUnread was built for.
          UpdateExpression: 'SET unread_count = :one, unread_flag = :flag',
          // Clause 3 is the ALREADY-READ precondition. `attribute_not_exists`
          // is load-bearing: unread_count is SPARSE, so a thread that never
          // received an inbound has never had it written, and a bare
          // `= :zero` would refuse that whole class forever.
          ConditionExpression:
            `attribute_exists(conversationId) AND ${predicate}` +
            ' AND (attribute_not_exists(unread_count) OR unread_count = :zero)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      log.info({ conversationId, bucket: eligibility.bucket }, 'conversation unread set');
      return Attributes as ConversationItem;
    },
```

Accepted risk to note in the comment block (same class the repo already
documents for `resetUnread` at `conversationsRepo.ts:1541-1543`): `SET` is
last-write-wins against an in-flight inbound `ADD`, so a `setUnread` racing a
fresh inbound writes 1 where the truth is 2. The flag is correct either way and
the row stays visible.

## S1.4 Verify

`npm test -- app/src/repos/conversationsRepo.integration.test.ts` green, then
`npm run typecheck`. Commit `app/src/repos/conversationsRepo.ts` and the test.

---

# S2 - `POST /api/conversations/:conversationId/unread`

Files: `app/src/routes/api.ts`, `app/src/lib/markUnread.ts` (new),
`app/src/routes/api.test.ts` (or the existing conversations-route test file -
put the tests beside the existing `/read` route tests).

## S2.1 The shared classification helper (new file)

`app/src/lib/markUnread.ts`:

```ts
// The mark-unread route layer's two shared decisions, extracted because THREE
// routes make them and a fork between them is how the invariant drifts.
import { isOneToOneBucket, isUnreadVisible } from './unreadFeed.js';
import type { ConversationItem, UnreadBucket } from '../repos/conversationsRepo.js';

/** The bucket whose ConditionExpression predicate matches this item's type. */
export function bucketFor(conv: ConversationItem): UnreadBucket {
  if (conv.type === 'relay_group') return 'relay_group';
  if (conv.type === 'group_text') return 'group_text';
  return 'one_to_one';
}

/** MU-1 as a route-level PRE-check (fail fast with a clear error). The
 *  authoritative enforcement is setUnread's condition; this only avoids a
 *  pointless write and gives a specific 409. */
export function isMarkableUnread(conv: ConversationItem): boolean {
  return isUnreadVisible({ ...conv, unread_count: 1 });
}

/** The fan-in selection rule (spec 6.2), shared by both inbox routes.
 *
 *  STRICTER than the inbox reader's literal `type !== 'relay_group'`:
 *  isOneToOneBucket excludes group_text too. The sets are identical today, but
 *  contactThreads.ts warns that giving a group thread a participant key would
 *  break every caller relying on the enumerated form. A negative bucket test
 *  survives that change.
 *
 *  Strict `>` mirrors newestOf, so ties keep the FIRST encountered - the same
 *  thread the inbox row itself previews. */
export function newestMarkable(convs: ConversationItem[]): ConversationItem | undefined {
  let best: ConversationItem | undefined;
  for (const c of convs) {
    if (c.status !== 'open') continue;
    if (!isOneToOneBucket(c)) continue;
    if (best === undefined || c.last_activity_at > best.last_activity_at) best = c;
  }
  return best;
}
```

Unit-test this file directly (`app/src/lib/markUnread.test.ts`): `newestMarkable`
skips closed, skips relay_group, skips group_text, keeps first on a tie, returns
undefined on an empty/all-ineligible list.

## S2.2 The classification, used by all three routes

Also in `app/src/lib/markUnread.ts`:

```ts
export type MarkUnreadOutcome =
  | { kind: 'not_found' }
  | { kind: 'ineligible' }
  | { kind: 'already_unread'; conversation: ConversationItem };

/**
 * Classify a ConditionalCheckFailedException from setUnread by re-reading ONCE.
 * The condition has three clauses and DynamoDB does not say which failed.
 *
 * ORDER IS LOAD-BEARING: eligibility BEFORE count. An ineligible-AND-unread
 * thread is a real state, not a hypothetical - a closed relay group re-flagged
 * by an inbound (docs/issues/inbound-reflags-closed-relay-group.md). Classifying
 * on the count first answers 200 for exactly that residue row.
 */
export async function classifyConditionFailure(
  conversationId: string,
  getById: (id: string) => Promise<ConversationItem | undefined>,
): Promise<MarkUnreadOutcome> {
  const conv = await getById(conversationId);
  if (!conv) return { kind: 'not_found' };
  if (!isMarkableUnread(conv)) return { kind: 'ineligible' };
  return { kind: 'already_unread', conversation: conv };
}
```

Tests: all three arms, and explicitly the ineligible-AND-unread row -> 
`ineligible`, never `already_unread`.

## S2.3 RED - the route tests

Beside the existing `POST /api/conversations/:id/read` tests:

- 200 on a read 1:1: body carries the updated conversation with
  `unread_count: 1`; `conversation.updated` emitted once.
- 404 unknown id.
- 409 for a CLOSED relay group.
- 409 for a 1:1 thread whose contact is soft-deleted (MU-2).
- 200 for a `connecting` relay group; 200 for a `group_open` group text.
- 200 no-write for an already-unread ELIGIBLE thread: response carries the REAL
  count (e.g. 5), the stored row is still 5, and NO `conversation.updated` is
  emitted.
- 409 for a thread that is BOTH ineligible and unread (the ORDER test).
- 404 when the conversation is deleted between the route's read and its write
  (drive by stubbing the repo so `setUnread` rejects with
  `ConditionalCheckFailedException` and `getById` then returns undefined).

## S2.4 GREEN - the route

In `app/src/routes/api.ts`, immediately after the existing `/read` handler
(around line 2047):

```ts
  // POST /api/conversations/:conversationId/unread - make the thread unread so
  // it resurfaces as a to-do. The mirror of /read, with three differences that
  // are all deliberate: it writes 1 rather than 0, it refuses ineligible and
  // deleted-contact targets (MU-1/MU-2), and an ALREADY-unread thread is a
  // SUCCESS with no write rather than a clobber to 1.
  router.post('/conversations/:conversationId/unread', async (req, res) => {
    const { conversationId } = req.params;
    mergeContext({ conversationId });

    const conv = await conversations.getById(conversationId);
    if (!conv) {
      res.status(404).json({ error: 'conversation_not_found' });
      return;
    }
    if (!isMarkableUnread(conv)) {
      res.status(409).json({ error: 'thread_not_markable_unread' });
      return;
    }
    // MU-2. A group thread has no single owning contact and skips this.
    if (isOneToOneBucket(conv) && (await ownerContactIsDeleted(conv, contacts))) {
      res.status(409).json({ error: 'thread_not_markable_unread' });
      return;
    }

    try {
      const conversation = await conversations.setUnread(conversationId, {
        bucket: bucketFor(conv),
      });
      events.emit('conversation.updated', toConversationUpdatedEvent(conversation));
      res.json({ conversation });
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      const outcome = await classifyConditionFailure(conversationId, (id) =>
        conversations.getById(id),
      );
      if (outcome.kind === 'not_found') {
        res.status(404).json({ error: 'conversation_not_found' });
        return;
      }
      if (outcome.kind === 'ineligible') {
        res.status(409).json({ error: 'thread_not_markable_unread' });
        return;
      }
      // Already unread: the goal state holds. Success, no write, NO event -
      // nothing changed. The real count goes back so the client stops assuming 1.
      res.json({ conversation: outcome.conversation });
    }
  });
```

`ownerContactIsDeleted` is a small helper in `app/src/lib/markUnread.ts`:
resolve the thread's contact via `participant_phone` -> `contacts.findByPhone`
else `participant_email` -> `contacts.findByEmail`, and return true only when a
contact was found AND carries `deleted_at`. A thread with no contact record is
NOT deleted (an untriaged unknown number is markable).

## S2.5 Verify

Route tests green; `npm run typecheck`. Commit.

---

# S3 - The two fan-in inbox routes

File: `app/src/routes/inbox.ts` + its route test file.

## S3.1 RED - tests

`POST /api/inbox/unread` `{ phone }`:
- 400 missing/non-string phone; 400 non-E.164.
- 404 `no_conversation_for_phone`.
- **409 `contact_deleted` when the phone belongs to a soft-deleted contact**
  (the MU-2 gap review found - this route's `/read` sibling deliberately has no
  such check, so it will not be copied in by accident).
- 409 `no_markable_thread` when every candidate is ineligible.
- 200 flipping ONLY the newest eligible thread when the number owns several;
  assert the others are untouched; response carries `{ ok: true, unreadCount }`.

`POST /api/inbox/:contactId/unread`:
- 404 `contact_not_found`; 409 `contact_deleted`.
- 200 flipping ONLY the newest eligible thread across a phone+email union, with
  the other threads asserted still at 0.
- **200 does NOT select an open relay group** even when the contact's record
  carries the pool number (the 6.2 filter - this is the finding that made the
  filter shared).
- The same condition-failure classification arms as S2.

## S3.2 GREEN - the routes

Register both immediately after the existing `/read` handlers, keeping
`POST /unread` above `POST /:contactId/unread`. Note in the comment that the
ordering is house-style belt-and-braces, NOT a live hazard: the paths are one
and two segments, exactly as `inbox.ts:1607-1610` already records for the read
pair.

Both routes: select with `newestMarkable(...)`, call `setUnread` with
`bucketFor(selected)`, wrap in the same try/catch classification as S2, emit
`conversation.updated` on a real write only, and respond
`{ ok: true, unreadCount: conversation.unread_count }`.

The by-phone route's MU-2 step: `contacts.findByPhone(phone)`; if found and
`deleted_at` is set -> `409 contact_deleted`.

Add a comment on both routes recording the GSI-lag dependency
(`docs/issues/markread-fanout-depends-on-stale-participant-gsi.md`): a fan-OUT
degrades gracefully under participant-GSI lag, a fan-IN "pick exactly one" does
not, so `409 no_markable_thread` is EXPECTED and RETRYABLE rather than an error
state.

## S3.3 Verify

Route tests green; `npm run typecheck`. Commit.

---

# S4 - API client

File: `dashboard/src/api/endpoints.ts`.

Beside `markConversationRead` (line ~860) and `markInboxRead` (line ~1578):

```ts
/** POST /api/conversations/:id/unread - make the thread unread again so it
 *  resurfaces as a to-do. Returns the AUTHORITATIVE conversation: an
 *  already-unread thread answers 200 with its real count, NOT 1. */
export async function markConversationUnread(
  conversationId: string,
  signal?: AbortSignal,
): Promise<ConversationHeader> {
  const res = await request<{ conversation: ConversationHeader }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/unread`,
    { method: 'POST', ...(signal !== undefined && { signal }) },
  );
  return res.conversation;
}

/** POST /api/inbox/:contactId/unread (contact rows + the contact page) - or
 *  POST /api/inbox/unread { phone } (unknown rows). Returns the resulting
 *  unread count so callers never assume 1. */
export async function markInboxUnread(
  target: { contactId: string } | { phone: string },
  signal?: AbortSignal,
): Promise<number> {
  const res =
    'contactId' in target
      ? await request<{ ok: true; unreadCount: number }>(
          `/api/inbox/${encodeURIComponent(target.contactId)}/unread`,
          { method: 'POST', ...(signal !== undefined && { signal }) },
        )
      : await request<{ ok: true; unreadCount: number }>('/api/inbox/unread', {
          method: 'POST',
          body: { phone: target.phone },
          ...(signal !== undefined && { signal }),
        });
  return res.unreadCount;
}
```

Export both from `dashboard/src/api/index.ts` if that barrel enumerates names.
`npm run typecheck`. Commit.

---

# S5 - Inbox row action

Files: `dashboard/src/routes/inbox/InboxRow.tsx`,
`dashboard/src/routes/inbox/useInbox.ts`, plus both test files.

## S5.1 RED

`InboxRow.test.tsx`:
- renders "Mark unread" when `unreadCount === 0`, and NOT "Mark read";
- renders "Mark read" when `unreadCount > 0`, and NOT "Mark unread";
- clicking calls `onMarkUnread` with the row.

`useInbox.test.tsx`:
- per-kind dispatch: relay_group / group_text -> `markConversationUnread`;
  contact -> `markInboxUnread({ contactId })`; phone-bearing fallback ->
  `markInboxUnread({ phone })`;
- optimistic patch to 1, then **commits the SERVER's returned count** - an
  already-unread thread answering 5 leaves the row at 5, not 1;
- rejection drops the patch (row returns to 0);
- calls `rollbackRowsCleared` with the same key `markRead` would have minted.
  Drive the pending-clear assertion through the FETCH-GENERATION seam (resolve
  a `getUnreadCount`), NOT a clock - a clock-driven test passes with or without
  the call.

## S5.2 GREEN - `InboxRow.tsx`

Add `onMarkUnread: (row: InboxRowData) => void` to `InboxRowProps`. Replace the
actions block:

```tsx
        <div className={styles.actions}>
          {unread ? (
            <button
              type="button"
              className={styles.action}
              onClick={() => onMarkRead(row)}
              aria-label={`Mark ${row.name} read`}
            >
              Mark read
            </button>
          ) : (
            <button
              type="button"
              className={styles.action}
              onClick={() => onMarkUnread(row)}
              aria-label={`Mark ${row.name} unread`}
            >
              Mark unread
            </button>
          )}
        </div>
```

**Deliberately NO client-side D5 guards here.** Add this comment so nobody
restores them:

```tsx
        {/* No `deleted` / closed-relay guard on this action, deliberately: a
            deleted row is emitted ONLY when some thread is unread
            (inbox.ts:786), and a closed relay group is never an inbox row at
            all (the relay source reads only the open and connecting
            partitions, inbox.ts:1396). Both states are mutually exclusive with
            unreadCount === 0, so a guard would be dead code and a test for it
            would prove nothing. D5 is enforced server-side. */}
```

## S5.3 GREEN - `useInbox.markUnread`

Mirror `markRead` (line ~306). Differences, all load-bearing:

- guard is `if (row.unreadCount > 0) return;`
- resolves `markConversationUnread` / `markInboxUnread` per kind, minting the
  clear key in the SAME branch (the third branch catches rows BY PHONE across
  kinds, so a kind-derived key would mint `c:undefined`);
- `setPatch(key, { unreadCount: 1 })` for the optimistic paint;
- `rollbackRowsCleared([clearKey])` - purges a stale pending CLEAR from a
  mark-read the operator just performed. Do NOT call `noteRowsCleared`; there
  is no optimistic-increment layer and none is being added.
- on success, commit **the returned count**:
  `setBase(prev => prev.map(r => rowKey(r) === key ? { ...r, unreadCount: served } : r))`
- on failure, drop the patch. Note in a comment that `rollbackRowsCleared` has
  no re-add, so the badge sits one ABOVE truth until the next reconcile
  (~300ms); accepted and self-healing.

Wire `onMarkUnread={inbox.markUnread}` in `Inbox.tsx`'s `InboxRow` render.

## S5.4 Verify

Both test files green; `npm run typecheck`. Commit.

---

# S6 - The auto-read latch and drain (MUST precede S7)

Files: `dashboard/src/routes/contact/useMarkContactRead.ts`,
`dashboard/src/routes/conversation/useMarkThreadRead.ts` (new),
`dashboard/src/routes/conversation/ConversationDetail.tsx`,
`dashboard/src/routes/conversation/GroupTextView.tsx`, plus tests.

## S6.1 The contract

Both hooks return the same handle:

```ts
export interface AutoReadHandle {
  /** Suppress auto-read for the CURRENT identity, then wait for any in-flight
   *  auto-read to settle. Await this BEFORE issuing a mark-unread POST. */
  suppressAndDrain: () => Promise<void>;
}
```

## S6.2 `useMarkContactRead` changes

Currently returns `void`. Change to return `AutoReadHandle`, and add:

- `suppressedForRef: useRef<string | null>(null)` - the latch, holding the
  IDENTITY it suppresses, not a boolean. `markRead` returns early when
  `suppressedForRef.current === contactId`.
  **Keyed, not per-mount.** `/contacts/a` -> `/contacts/b` is a React Router
  param change, NOT a remount (`ContactDetail.tsx:214`), and `markRead`'s
  `[contactId]` dependency refires for the new contact. A boolean ref would
  leave the NEXT contact never marked read for the rest of the visit.
- `inFlightPromiseRef: useRef<{ id: string; promise: Promise<unknown> } | null>(null)` -
  set when `markRead` issues its POST, cleared in `finally`. Keyed the same way
  so the drain can never await a request belonging to a previous contact.
- `suppressAndDrain`:

```ts
  const suppressAndDrain = useCallback(async () => {
    suppressedForRef.current = contactId;
    const pending = inFlightPromiseRef.current;
    if (pending === null || pending.id !== contactId) return;
    // BOUNDED. `request` has no timeout of its own and the auto-read passes no
    // signal, so an unbounded await would make the button look dead - a worse
    // and likelier failure than the narrow tail race. On timeout we proceed;
    // the latch still suppresses the late RESPONSE client-side, and only the
    // server-side ordering is unprotected in that tail.
    await Promise.race([
      pending.promise.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, AUTO_READ_DRAIN_TIMEOUT_MS)),
    ]);
  }, [contactId]);
```

with `const AUTO_READ_DRAIN_TIMEOUT_MS = 2000;` at module scope.

Why await rather than abort: a client-side abort does not stop the server from
committing the `resetUnread`, so aborting would HIDE the race instead of
closing it. The fan-out is the heavier write (`inbox.ts:1661-1675` does a
lookup plus a `resetUnread` per thread), so last-writer-wins would frequently
be the fan-out.

## S6.3 `useMarkThreadRead` (new, extracted)

`ConversationDetail.tsx:238-242` and `GroupTextView.tsx:259-263` hold the SAME
inline mount effect. Extract it verbatim into
`dashboard/src/routes/conversation/useMarkThreadRead.ts` with the identical
latch/drain shape keyed on `conversationId`, and have both components call it
instead of their inline effect.

**Preserve the existing comment block** in the extracted hook - it records the
deliberate ruling that this read is UNWIRED from the badge's optimistic layer,
and that ruling is pinned by regression spies.

## S6.4 RED - tests

- TRIGGER path: after `suppressAndDrain()`, firing a `message.persisted` event
  does NOT issue `markInboxRead`. Same shape for the thread hook's mount read.
- **DRAIN path (the one that matters): assert ORDER.** With a mount fan-out
  still in flight (a deferred promise), `suppressAndDrain()` does not resolve
  until that request settles. A trigger-only test stays green while the
  in-flight ordering bug ships.
- BOUNDED: with an auto-read that never settles, `suppressAndDrain()` still
  resolves after the timeout (use fake timers).
- KEYED: after suppressing on contact `a`, a param change to contact `b` DOES
  mark `b` read.
- The existing `noteRowsCleared` regression spies in `GroupTextView.test.tsx`
  and `ConversationDetail.test.tsx` must still pass unchanged - the extraction
  must not wire the badge layer in.

## S6.5 Verify

`npm test -- dashboard/src/routes/contact dashboard/src/routes/conversation`;
`npm run typecheck`. Commit.

---

# S7 - Thread header actions

Files: `dashboard/src/routes/conversation/ConversationDetail.tsx` (and/or
`RelayGroupView` / `GroupTextView` header), `dashboard/src/routes/contact/ContactDetail.tsx`,
`dashboard/src/routes/contact/ContactActionsMenu.tsx`, plus tests.

Both surfaces: `await handle.suppressAndDrain()`, then `await` the POST, then
`navigate('/inbox')`. On failure stay put and use the surface's existing inline
error treatment. Render a pending state while the drain/POST is outstanding.

**No client-side "already unread" guard on either surface.** The count guard is
condition clause 3 (S1). Neither surface can evaluate it: the conversation
page's header is fetched once per mount and is deterministically PRE-auto-read
(`ConversationDetail.tsx:81-87`, `:118-152`, `:148-151` - nothing re-reads it),
and the contact page has no unread datum at all (`useContact.ts:23-45`). A
client rule would hide the action for the whole visit on the feature's primary
flow. Put that reasoning in a comment on both.

- **Conversation page**: "Mark unread" header action calling
  `markConversationUnread(conversationId)`. HIDDEN for a closed relay group -
  unlike the inbox row, this guard IS live, because a closed relay group is
  reachable here by deep link and from the contact's relay-groups card.
- **Contact page**: a "Mark unread" item in `ContactActionsMenu` (the existing
  kebab at `ContactDetail.tsx:658`), calling `markInboxUnread({ contactId })`.
  Hidden when the contact is soft-deleted. It goes in the MENU, not a bare
  header button, and specifically NOT in `ContactCommsPane` - that pane is
  shared with the tour and placement 1:1 tabs
  (`TourConversation.tsx:263`, `PlacementConversation.tsx:260`), so putting it
  there would leak the action onto the surfaces non-goal 5 excludes.

**Neither header action touches `UnreadContext`** - no `noteRowsCleared`, no
`rollbackRowsCleared`. Neither auto-read records a clear (that is pinned by the
regression spies), so there is nothing to roll back.

Tests: navigates to `/inbox` on success; does NOT navigate on rejection; absent
for a closed relay group; absent for a soft-deleted contact; calls
`suppressAndDrain` BEFORE the POST; a `409 no_markable_thread` renders the
retryable inline message and leaves the action available; neither surface calls
into `UnreadContext` (extend the existing spies rather than adding new ones).

---

# S8 - The Unread list truncation notice

Files: `dashboard/src/routes/inbox/Inbox.tsx`, `Inbox.test.tsx`.

Render when `inbox.truncated && inbox.serverRowCount > 0`, reusing
`styles.notice` (the treatment the group-text truncation already uses at
`Inbox.tsx:88-116`):

```tsx
      {/* A truncated NON-EMPTY unread page ends silently today: hasMore is
          false so no "Load more" renders, and the truncation banner below is
          gated on the page having come back EMPTY. So a capped list looks
          exactly like the end of the feed. Gate on serverRowCount, NOT
          rows.length - both `truncated` and that count describe the SERVER
          page, while `rows` is the client-filtered list the Unread tab empties
          as the operator marks rows read, so a rows-keyed notice would vanish
          mid-triage. This condition is the exact complement of
          serverEndedEarlyEmpty, so the two can never render together.
          NO COUNT in the copy: the operator clears rows while the server's flag
          stands, so any number reaches zero with the notice still up. */}
      {inbox.status === 'ready' && inbox.truncated && inbox.serverRowCount > 0 ? (
        <p className={styles.notice}>
          Showing the most recent unread. There are older unread threads not shown here.
        </p>
      ) : null}
```

Tests: renders on a non-empty truncated page; does NOT render on an untruncated
page; does NOT render alongside the empty/error surface; and **STAYS rendered
after every visible row is marked read** (the `serverRowCount`-not-`rows.length`
gate - a test keyed on `rows` would pass while the regression ships).

---

# S9 - e2e

File: `e2e/tests/dashboard-next/inbox-mark-unread.spec.ts` (new).

**Starting state:** lean seeds every conversation `unread_count: 0` on purpose
(`app/src/lib/seed/lean.ts:23-25`), so the spec MUST manufacture unread with the
fake-Twilio inbound fixture (`sendAsParty`, as `inbox-nav-badge.spec.ts` does).
Do not assume a seeded unread thread.

**Anchoring:** an inbox row's count carries `aria-label="<n> unread"`
(`InboxRow.tsx:107-111`), the SAME accessible name as the nav badge
(`NavContents.tsx:66`). A bare `getByLabel('1 unread')` matches both and fails
strict mode - the trap `inbox-nav-badge.spec.ts:15-21` documents. Address rows
by href.

Steps:
1. Drive an inbound to a seeded contact; open the row (which marks it read);
   return to the inbox; confirm no unread treatment on that row.
2. Reveal the row's actions, click "Mark unread"; assert the row (by href) shows
   the unread treatment and a count of 1.
3. Switch to the Unread filter; assert the row is present.
4. From the contact page, click the kebab's "Mark unread"; assert the browser
   lands on the inbox with that row unread.

---

# S10 - Close out

1. Sync `main` into the branch ONCE, at this final step. If `main` has advanced
   in a way that conflicts, ASK before resolving. Expect a conflict window in
   `app/src/routes/inbox.ts` and `app/src/repos/conversationsRepo.ts` from
   `feat/call-inbox-unread` if it has landed - report drift, do not chase it.
2. Run the three gates BARE, never piped, from `W:\tmp\inbox-mark-unread`:
   `npm run typecheck`, `npm test`, `npm run e2e`. Re-run either known flake
   once before blaming this change, and report BOTH runs:
   `tour-reminders-panel-e2e-flake`,
   `conversationdetail-members-mock-suite-flake`.
3. `npm run issues` if any `docs/issues/` file was added.
4. Write the handback to `.superpowers/sdd/handback.md`: per-spec-item status,
   quoted exit codes on the final commit, drift, and owed post-merge ops
   (expected: NONE - no dependency, schema, GSI, infra, config, or backfill).

## Watch items for the builder

- **Do not "fix" the relay close path.** It already zeroes unread and drops the
  flag inside `setRelayStatus` (`conversationsRepo.ts:1877-1878`); a reviewer
  wrongly reported otherwise by grepping only the route file.
- **Do not add an optimistic-increment layer to `UnreadContext`.** Non-goal 4.
- **Do not touch `last_activity_at`.** D4.
- **Do not put the contact action in `ContactCommsPane`.** Non-goal 5.
- **`unread_count` is sparse.** The `attribute_not_exists` half of clause 3 is
  not defensive padding.
