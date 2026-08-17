# Implementation plan - inbox mark-unread

Spec: `docs/superpowers/specs/2026-08-17-inbox-mark-unread-design.md` (approved
at the human's gate, tip `2dbdea0f`).
Worktree: `W:\tmp\inbox-mark-unread`   Branch: `feat/inbox-mark-unread`
Base: `main` @aa62b493
Plan review: R1 complete (2 reviewers, 32 findings); adjudications at
`.superpowers/design-review/adjudications.md`.

Assume ZERO context. Every path is repo-relative from the worktree root. Every
task is TDD: write the failing test, watch it fail for the RIGHT reason, then
implement.

---

## Global constraints (copied verbatim from the spec - do not re-derive)

- `unread_count = 1` is the written value. `SET`, never `ADD`.
- The sparse GSI hash constant is `UNREAD_FLAG_VALUE` (`'unread'`), already
  exported from `app/src/repos/conversationsRepo.ts`.
- **MU-1**: permitted only where `isUnreadVisible({ ...c, unread_count: 1 })` is
  true. Enforced as a WRITE CONDITION, not a prior read.
- **MU-2**: refused when the target thread's contact is soft-deleted. Enforced
  in the route (it cannot ride the condition - different item).
- Condition clause 3: `(attribute_not_exists(unread_count) OR unread_count = :zero)`.
  `unread_count` is genuinely sparse - the `attribute_not_exists` half is load-bearing.
- Classification order, ALL routes: absent -> 404; ineligible -> 409;
  eligible-and-already-unread -> 200 no write. **Eligibility BEFORE count.**
- Every route returns the authoritative resulting count as a TOP-LEVEL
  `unreadCount` number.
- `last_activity_at` is NEVER written by this feature.
- Fan-in selection: `status === 'open'` AND `isOneToOneBucket`, newest by
  `last_activity_at`, strict `>` so ties keep first-encountered.
- ASCII only in all new/touched lines, including comments and test names.
- Commit explicit paths only. A bare `git status` is a SEPARATE read before
  every commit. `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## Repo facts the builder MUST know before starting

These were wrong in the first draft of this plan and each one cost a blocking
review finding. Do not re-derive them; they are verified.

1. **App tests live in `app/test/`**, not beside sources. They import from
   `../src/...`. There is NO `app/src/repos/conversationsRepo.integration.test.ts`
   and no `seedConversation` helper anywhere.
2. **The unread integration suite is `app/test/unreadIndexRepo.integration.test.ts`.**
   Its `byUnread` describe (line 51) creates rows THROUGH THE REPO and has no
   raw-seed helper of its own; the raw `PutCommand` seeds elsewhere in the file
   belong to other describes with different table variables. You will add a
   local `seedRaw` (S1.1). It asserts BOTH the item shape (via its `rawItem`
   helper - the only way to prove an attribute is genuinely ABSENT) AND index
   membership via `queryUnreadPage`.
3. **That suite SELF-SKIPS when DynamoDB Local is unreachable** (it probes
   `DYNAMODB_ENDPOINT`, default `http://localhost:8000`). A "green" run without
   Docker means SKIPPED, not passing - so the TDD red state is unobservable.
   **Run `npm run db:start` before S1 and confirm the suite actually executes.**
4. **Per-slice test commands must target a workspace.** Root `npm test` is
   `npm run test --workspaces --if-present`, so `npm test -- <path>` forwards the
   path to every workspace and fails. Use:
   - `npm test -w app -- test/<file>`
   - `npm test -w dashboard -- src/routes/<path>`
5. **`isDeleted` already exists** (`app/src/repos/contactsRepo.ts:297`) and is
   already imported into `app/src/routes/api.ts:64`. Do NOT write a new
   deleted-contact helper.
6. **`ConversationsRepo` has full-literal fakes** that will fail typecheck the
   moment a required method is added. See S1.5 for the enumerated list.

## Verification

Per-slice: the workspace-scoped commands above.
Slice gate: `npm run typecheck`.
Final gates, BARE, from the worktree root, never piped:
`npm run typecheck`, then `npm test`, then `npm run e2e`.

## Slice order

S1 -> S2 -> S3 server bottom-up; S4 client bridge; S5 -> S8 client surfaces;
S9 e2e; S10 close-out.

**S6 must land before S7** - S7's header actions call the handle S6 creates.
Built the other way round the drain is unimplementable and the builder ships
the exact ordering bug the spec exists to prevent.

**S1.5 is part of S1, not a follow-up.** Adding a required interface method
breaks every full-literal fake in the same commit; splitting them leaves the
tree red and falsifies "each slice independently green".

---

# S1 - Repo primitive `setUnread`

Files: `app/src/repos/conversationsRepo.ts`,
`app/test/unreadIndexRepo.integration.test.ts`, plus the fakes in S1.5.

**Precondition: `npm run db:start`.** Confirm the suite runs rather than skips
before trusting any red or green.

## S1.1 RED - tests

Add a `describe('setUnread', ...)` block INSIDE the existing
`describe.skipIf(!reachable)('byUnread index + unread_flag ...')` at
`app/test/unreadIndexRepo.integration.test.ts:51`, so it inherits that block's
throwaway table prefix and lifecycle.

**Seeding: write a local helper; there is no existing one to reuse.** That
describe has `doc`, `table`, `rawItem`, `unreadIds` and `nextPhone` in scope but
does NOT seed with `PutCommand` itself - it goes through the repo. The raw
`PutCommand` seeds elsewhere in the file (lines ~333, ~400, ~426, ~598) live in
the backfill/GSI describes and reference DIFFERENT table variables
(`contactsTable`, `convTable`, `messagesTable`); do not reach for them.

Add, inside the byUnread describe:

```ts
  /** Seed a conversation row of an ARBITRARY shape. The repo's creators cannot
   *  express closed / group_text / legacy-no-type / a pre-set unread_count, and
   *  every one of those is a case the condition must be proved against. */
  async function seedRaw(item: Record<string, unknown>): Promise<string> {
    const conversationId = `conv-${randomUUID()}`;
    await doc.send(new PutCommand({ TableName: table, Item: { conversationId, ...item } }));
    return conversationId;
  }
```

Assert BOTH sides the way this file already does - item shape via `rawItem`
(the only way to prove an attribute is genuinely ABSENT) and index membership
via `unreadIds`. Cases:

- read 1:1 -> `unread_count` 1, `unread_flag` stamped, row present in
  `queryUnreadPage`.
- **thread with NO `unread_count` attribute at all -> ACCEPTED.** `unread_count`
  is sparse; a thread that never received an inbound has never had it written. A
  bare `unread_count = :zero` condition would refuse that whole class forever and
  nothing else in the suite would catch it.
- already-unread thread at 5 -> rejects `ConditionalCheckFailedException`, and a
  follow-up `getById` still reads 5.
- unknown id -> rejects `ConditionalCheckFailedException`.
- `one_to_one` refuses `closed`; refuses a row whose `type` is `relay_group`;
  ACCEPTS a legacy row with no `type`.
- `relay_group` accepts `open` and `connecting`, refuses `closed`, and
  **refuses an OPEN 1:1 thread** (the type clause - without it this passes
  silently, since a 1:1 also carries status `open`).
- `group_text` accepts `group_open`, refuses plain `open`.
- round trip: `setUnread` puts the row in the index, `resetUnread` removes it.

Red state must be "setUnread is not a function", not a condition error.

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

Declare on the interface immediately after `resetUnread`:

```ts
  /**
   * Make a thread unread (`unread_count = 1` + the sparse `unread_flag`), the
   * mirror of resetUnread. Carries its WHOLE precondition in the
   * ConditionExpression: the row exists, matches the bucket's type/status
   * predicate (MU-1), and is currently READ. A read-then-write would be TOCTOU -
   * a relay close committing in the window leaves permanent index residue.
   * Throws ConditionalCheckFailedException when ANY clause fails; callers
   * classify by re-reading (see app/src/lib/markUnread.ts).
   */
  setUnread(conversationId: string, eligibility: { bucket: UnreadBucket }): Promise<ConversationItem>;
```

## S1.3 GREEN - the implementation

Insert after the `resetUnread` implementation (~`conversationsRepo.ts:1561`).
Build `ExpressionAttributeNames`/`Values` per bucket and AND three clauses:
`attribute_exists(conversationId)`, the bucket predicate, and
`(attribute_not_exists(unread_count) OR unread_count = :zero)`.

Bucket predicates:
- `relay_group`: `#type = :type AND #s IN (:open, :connecting)`
- `group_text`: `#type = :type AND #s = :groupOpen` (`GROUP_TEXT_STATUS`)
- `one_to_one`: `(attribute_not_exists(#type) OR NOT #type IN (:relay, :groupText)) AND #s = :open`

`UpdateExpression: 'SET unread_count = :one, unread_flag = :flag'`,
`ReturnValues: 'ALL_NEW'`, log `conversation unread set` at info.

Comments to carry:
- Every bucket has a TYPE clause, not only `one_to_one`: a 1:1 also carries
  status `open`, so without it the `relay_group` predicate is satisfied by any
  open 1:1 and the only separator would be the route's own type read - the value
  this condition exists to distrust. Safe today only because
  `convertRelayGroupToGroupText` also moves status out of the admitted set; do
  not depend on that.
- The 1:1 bucket mirrors `isOneToOneBucket`'s NEGATIVE test so legacy and future
  1:1 types stay admitted.
- Accepted risk, same class documented at `conversationsRepo.ts:1541-1543`:
  `SET` is last-write-wins against an in-flight inbound `ADD`, so a `setUnread`
  racing a fresh inbound writes 1 where truth is 2. Flag correct either way.
- **Pointer-partition rows** (MU-1's first clause) are NOT in the condition, on
  purpose: `conversationId` is the table key and cannot change, so the route's
  pre-check cannot be raced. Say so, or a future reader will read the omission
  as a gap.

## S1.4 Update the attribute's contract comment

`conversationsRepo.ts:172-178` currently says `unread_flag` is
"Maintained ONLY by incrementUnread / resetUnread and the relay-close /
contact-delete resets". `setUnread` is now a THIRD writer. Update that comment
in the same commit - it is the doc every future reader trusts.

## S1.5 Update every full-literal `ConversationsRepo` fake (same commit)

Adding a required interface method breaks typecheck in every file holding a
FULL OBJECT LITERAL of the repo. Do not trust this list blindly - a `resetUnread`
mention is not the same as a literal. Derive it, then fix each:

```
grep -rln "resetUnread" app --include=*.ts | grep -v node_modules
```

For each hit, open it and classify:
- **Full literal** (an object satisfying `ConversationsRepo`) -> add `setUnread`.
- **Injects the real repo** (e.g. `conversationHub.integration.test.ts`) -> no
  change needed; it gets the method for free.
- **`Pick<>` / partial** -> no change unless the picked set is widened.

Known full literals at the time of writing:
`app/test/helpers/twilioWebhookHarness.ts` (the one S2/S3 route tests use),
`app/test/contactCapture.test.ts`, `app/test/scheduledSendSuppression.test.ts`,
`app/test/sendMessage.test.ts`. Verify rather than assume.

**The harness fake's `setUnread` MUST actually implement the condition** -
refuse when the row is absent, when the bucket predicate fails, or when
`unread_count > 0`, throwing `ConditionalCheckFailedException`. If it
unconditionally succeeds, every classification test in S2/S3 is vacuous: they
would assert route branches that the fake can never trigger. Fakes elsewhere may
throw "not implemented" if their suites never reach it.

## S1.6 Verify

`npm test -w app -- test/unreadIndexRepo.integration.test.ts` (with Docker up),
then `npm run typecheck`. Commit.

---

# S2 - Shared helpers + `POST /api/conversations/:conversationId/unread`

Files: `app/src/lib/markUnread.ts` (new), `app/test/markUnread.test.ts` (new),
`app/src/routes/api.ts`, and the existing route-test file that covers
`POST /api/conversations/:id/read` (find it: `grep -rln "conversations/.*read" app/test`).

## S2.1 `app/src/lib/markUnread.ts`

Three pure helpers plus one classifier. Extracted because THREE routes make
these decisions and a fork between them is how the invariant drifts.

- `bucketFor(conv): UnreadBucket` - `relay_group` / `group_text` / else
  `one_to_one`.
- `isMarkableUnread(conv): boolean` - `isUnreadVisible({ ...conv, unread_count: 1 })`.
  A route-level PRE-check for a fast, specific 409; the authoritative
  enforcement is the write condition.
- `newestMarkable(convs): ConversationItem | undefined` - filter
  `status === 'open'` AND `isOneToOneBucket`, take newest by `last_activity_at`
  with strict `>` so ties keep first-encountered.
  Comment: deliberately STRICTER than the inbox reader's literal
  `type !== 'relay_group'` (`isOneToOneBucket` excludes `group_text` too). The
  sets are identical today, but `contactThreads.ts:22-23` warns that giving a
  group thread a participant key breaks every caller relying on the enumerated
  form; a negative bucket test survives that change.
- `classifyConditionFailure(conversationId, getById)`:

```ts
export type MarkUnreadOutcome =
  | { kind: 'not_found' }
  | { kind: 'ineligible' }
  | { kind: 'already_unread'; conversation: ConversationItem }
  | { kind: 'raced' };

export async function classifyConditionFailure(
  conversationId: string,
  getById: (id: string) => Promise<ConversationItem | undefined>,
): Promise<MarkUnreadOutcome> {
  const conv = await getById(conversationId);
  if (!conv) return { kind: 'not_found' };
  // ORDER IS LOAD-BEARING: eligibility BEFORE count. An ineligible-AND-unread
  // thread is a real state - a closed relay group re-flagged by an inbound
  // (docs/issues/inbound-reflags-closed-relay-group.md). Count-first would
  // answer 200 for exactly that residue row.
  if (!isMarkableUnread(conv)) return { kind: 'ineligible' };
  // Eligible AND already unread: the goal state holds.
  if ((conv.unread_count ?? 0) > 0) return { kind: 'already_unread', conversation: conv };
  // Eligible AND read, yet the write was refused: the row was concurrently
  // RESET between our write and this re-read. Reporting 200 here would tell the
  // client "unread" about a row reading 0. The caller retries the write ONCE.
  return { kind: 'raced' };
}
```

Unit-test all four arms in `app/test/markUnread.test.ts`, plus `newestMarkable`
(skips closed, skips relay_group, skips group_text, keeps first on a tie,
undefined on empty/all-ineligible) and `bucketFor`.

## S2.2 The shared route body

All three routes share this shape. Write it ONCE in `app/src/lib/markUnread.ts`
as a PURE function - it takes the conversation and a narrow repo view and
RETURNS a discriminated result. **It must not emit events.** `markUnread.ts` is
a lib with no event-bus dependency, and giving it one to save three lines at
each call site would invert the layering; the ROUTE owns the emit.

```ts
export type MarkUnreadResult =
  | { kind: 'wrote'; conversation: ConversationItem }
  | { kind: 'already_unread'; conversation: ConversationItem }
  | { kind: 'gone' }
  | { kind: 'ineligible' };

export async function applyMarkUnread(
  conv: ConversationItem,
  repo: Pick<ConversationsRepo, 'setUnread' | 'getById'>,
): Promise<MarkUnreadResult>;
```

Behavior:

1. `setUnread(conv.conversationId, { bucket: bucketFor(conv) })` -> `wrote`.
2. On `ConditionalCheckFailedException` -> `classifyConditionFailure`:
   - `not_found` -> `gone`
   - `ineligible` -> `ineligible`
   - `already_unread` -> `already_unread`
   - `raced` -> retry `setUnread` ONCE. If the retry succeeds -> `wrote`. If it
     fails, classify once more and map WITHOUT a second retry; a `raced` on the
     retry also becomes `ineligible` at the boundary (see the code note below).

Route mapping:

- `wrote` -> emit `conversation.updated` with
  `toConversationUpdatedEvent(conversation)`, respond 200.
- `already_unread` -> 200, **no emit** (nothing changed).
- `gone` / `ineligible` -> the caller's codes (S2.3, S3.1-S3.3).
- Every 200 carries a top-level `unreadCount` number (S4 - the client has no
  other typed source for it).

**Code note on the terminal `raced`.** Collapsing a second `raced` into
`ineligible` answers `thread_not_markable_unread` for a thread that IS markable
- it says the opposite of what happened. It is accepted because a double race is
vanishingly rare, the client treatment is identical (the retryable inline
message), and the honest alternative is a fifth status code nothing would
branch on. Put that reasoning in a comment; do not let a reader conclude the
mapping is a mistake.

## S2.3 RED + GREEN - the conversation route

Response shape: `{ conversation, unreadCount }`.

Tests (beside the existing `/read` tests, in `app/test/`):
- 200 on a read 1:1: `unreadCount` 1, one `conversation.updated` emitted.
- 404 unknown id.
- 409 CLOSED relay group.
- 409 for a 1:1 whose contact is soft-deleted (MU-2, via `isDeleted`).
- 200 for a `connecting` relay group; 200 for a `group_open` group text.
- 200 no-write for an already-unread eligible thread: `unreadCount` is the REAL
  count (5), the stored row is still 5, and NO event is emitted.
- 409 for a thread BOTH ineligible and unread (the ORDER test).
- 404 when the row disappears between read and write (drive via the harness fake).
- **MU-1 property**: a 200 that WROTE implies the stored row passes
  `isUnreadVisible`. Assert it explicitly - spec 9.1 requires it and the first
  draft of this plan omitted the task.

MU-2 uses the already-imported `isDeleted` (`api.ts:64`): resolve the contact via
`participant_phone` -> `contacts.findByPhone`, else `participant_email` ->
`contacts.findByEmail`. A thread with NO contact record is NOT deleted (an
untriaged unknown number is markable). Group threads skip MU-2 entirely.

## S2.4 Verify

`npm test -w app -- test/markUnread.test.ts` and the route test file;
`npm run typecheck`. Commit.

---

# S3 - The two fan-in inbox routes

Files: `app/src/routes/inbox.ts` + its route test file in `app/test/`.

## S3.1 `POST /api/inbox/unread` `{ phone }`

Response `{ ok: true, unreadCount }`. Tests:
- 400 missing/non-string phone; 400 non-E.164 (mirror `/read`'s shapes).
- 404 `no_conversation_for_phone`.
- **409 `contact_deleted` when the phone belongs to a soft-deleted contact.**
  This route's `/read` sibling deliberately has NO such check, so it will not be
  copied in by accident - zeroing unread on a deleted contact is harmless,
  SETTING it is what MU-2 forbids.
- 409 `no_markable_thread` when every candidate is ineligible.
- 200 flips ONLY the newest eligible thread when the number owns several;
  assert the others are untouched.

## S3.2 `POST /api/inbox/:contactId/unread`

Response `{ ok: true, unreadCount }`. Tests:
- 404 `contact_not_found`; 409 `contact_deleted`.
- 200 flips ONLY the newest eligible thread across a phone+email union, others
  asserted still 0.
- **200 does NOT select an open relay group** even when the contact's record
  carries the pool number (the `newestMarkable` filter).
- The same classification arms as S2.

## S3.3 The `gone` outcome on the fan-in routes

`gone` means THE SELECTED CONVERSATION vanished between selection and write - it
does NOT mean the contact is missing. So on the two fan-in routes it must NOT
map to `contact_not_found` (that code already means something else, and the
contact demonstrably exists: the route loaded it in step 1). Map `gone` to the
retryable **`409 no_markable_thread`**, which is exactly what it is - the chosen
thread is no longer markable. `contact_not_found` stays reserved for the step-1
lookup miss.

On the conversation route `gone` maps to `404 conversation_not_found`, where the
noun is correct.

## S3.4 Route-level race tests

Both fan-in routes need a test for the `raced` path (a concurrent reset between
write and re-read) and for `gone`. Drive both through the harness fake's
`setUnread`, which S1.5 requires to implement the condition. An earlier draft
specified the classifier's unit tests but no route-level exercise of these arms.

## S3.5 Registration and comments

Keep `POST /unread` above `POST /:contactId/unread`. Comment that this is
house-style belt-and-braces, NOT a live hazard - the paths are one and two
segments, exactly as `inbox.ts:1607-1610` records for the read pair.

Comment the GSI-lag dependency on both
(`docs/issues/markread-fanout-depends-on-stale-participant-gsi.md`): a fan-OUT
degrades gracefully under participant-GSI lag, a fan-IN "pick exactly one" does
not, so `409 no_markable_thread` is EXPECTED and RETRYABLE, not an error state.

## S3.6 Verify

Route tests green; `npm run typecheck`. Commit.

---

# S4 - API client

File: `dashboard/src/api/endpoints.ts` (+ the `index.ts` barrel if it
enumerates names).

Both functions return `number` - the authoritative count. `ConversationHeader`
has NO typed `unread_count` (it rides an index signature), so it cannot be the
source; that is why every route carries a top-level `unreadCount`.

```ts
/** POST /api/conversations/:id/unread - make the thread unread again so it
 *  resurfaces as a to-do. Returns the AUTHORITATIVE count: an already-unread
 *  thread answers 200 with its real count, NOT 1. */
export async function markConversationUnread(
  conversationId: string,
  signal?: AbortSignal,
): Promise<number> {
  const res = await request<{ conversation: unknown; unreadCount: number }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/unread`,
    { method: 'POST', ...(signal !== undefined && { signal }) },
  );
  return res.unreadCount;
}

/** POST /api/inbox/:contactId/unread (contact rows + the contact page) - or
 *  POST /api/inbox/unread { phone } (unknown rows). */
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

`npm run typecheck`. Commit.

---

# S5 - Inbox row action

Files: `dashboard/src/routes/inbox/InboxRow.tsx`, `useInbox.ts`, `Inbox.tsx`,
plus `InboxRow.test.tsx`, `useInbox.test.tsx`, `Inbox.test.tsx`.

## S5.1 The existing row test goes VACUOUS, not red

There is NO selector collision. `/mark .* read/i` has a LITERAL SPACE before
`read`, and "Mark Ada unread" has no space there ("un" precedes it), so the
existing idiom cannot match the new button. Verified:

```
/mark .* read/i.test('Mark Ada read')   === true
/mark .* read/i.test('Mark Ada unread') === false
```

Do NOT "fix" those selectors. An earlier draft of this plan mandated a
required-first rewrite of them across dashboard and e2e; it was based on a
misread of the regex and would have been pure churn.

The real problem is quieter. `InboxRow.test.tsx:78-81` ("omits the Mark read
action for already-read rows") keeps PASSING after this feature ships - but it
now passes while a "Mark unread" button sits in that exact slot, so it no longer
proves what its name claims. It goes vacuous rather than red, which is the
failure mode nobody notices.

Fix it by asserting MUTUAL EXCLUSION rather than absence, in S5.4's tests:
at `unreadCount === 0` assert "Mark unread" present AND "Mark read" absent; at
`unreadCount > 0` assert the reverse. Keep the existing test's regex as-is.

## S5.2 `InboxRow.tsx`

Add `onMarkUnread: (row: InboxRowData) => void` to `InboxRowProps`. Render
"Mark unread" when `unreadCount === 0`, "Mark read" when `> 0` - exactly one at
a time. `aria-label={`Mark ${row.name} unread`}`.

**Guard on `row.deleted`.** Do NOT ship the "this guard is dead code" comment the
first draft carried: review showed it is false. A deleted row normally implies
`unreadCount > 0`, but `useInbox.markRead` sets `unreadCount: 0` optimistically
and commits it, so on the `all` filter a deleted row CAN sit at 0 with the action
showing - and clicking it gets a silent 409. Guard, and comment why.

The closed-relay guard IS unreachable on a row (the relay source reads only the
`open` and `connecting` partitions, `inbox.ts:1396`); omit it and say so.

**Naming the render sites that must change** (`onMarkUnread` is required, so
these break typecheck in the same commit): `dashboard/src/routes/inbox/Inbox.tsx`
and any test-local render helper in `InboxRow.test.tsx`. Confirm with
`grep -rn "<InboxRow" dashboard/src`.

## S5.3 `useInbox.markUnread`

Add `markUnread: (row: InboxRowData) => void` to the `InboxState` interface AND
to the returned object - the first draft wired the call site without declaring
it. Mirror `markRead` (line ~306) with these differences:

- guard `if (row.unreadCount > 0) return;` plus `if (row.deleted === true) return;`
- resolve endpoint AND clear key in ONE branch per kind (the third branch
  catches rows BY PHONE across kinds, so a kind-derived key would mint
  `c:undefined`)
- `setPatch(key, { unreadCount: 1 })` for the optimistic paint
- `rollbackRowsCleared([clearKey])` - purges a stale pending CLEAR from a
  mark-read just performed. Do NOT call `noteRowsCleared`; no
  optimistic-increment layer is being added (non-goal 4)
- on success commit the RETURNED count:

```ts
      unread()
        .then((servedCount) => {
          genRef.current += 1;
          setBase((prev) =>
            prev.map((r) => (rowKey(r) === key ? { ...r, unreadCount: servedCount } : r)),
          );
        })
        .catch(() => {
          /* rollback: dropping the patch restores base's original count */
        })
        .finally(() => clearPatch(key, 'unreadCount'));
```

Comment that `rollbackRowsCleared` has no re-add, so on a rejected POST the
badge sits one ABOVE truth until the next reconcile (~300ms); accepted and
self-healing.

## S5.4 Tests

`useInbox.test.tsx` stubs `UnreadContext` wholesale, so the assertion available
there is **that `rollbackRowsCleared` was called with the right key** - not a
fetch-generation experiment. Do not attempt the generation seam in this file;
the first draft named a test that file cannot deliver.

`InboxRow.test.tsx` (the render list an earlier draft dropped):
- **mutual exclusion** (S5.1): at `unreadCount === 0`, "Mark unread" present AND
  "Mark read" absent; at `unreadCount > 0`, the reverse. Assert BOTH directions
  - an absence-only test goes vacuous rather than red.
- clicking "Mark unread" calls `onMarkUnread` once with the row.
- a `deleted` row at `unreadCount 0` renders NEITHER action.

`useInbox.test.tsx`:
- per-kind dispatch (relay_group / group_text -> `markConversationUnread`;
  contact -> `markInboxUnread({ contactId })`; phone fallback ->
  `markInboxUnread({ phone })`)
- optimistic patch to 1, then commits the SERVER's count: a stub resolving 5
  leaves the row at 5, not 1
- rejection drops the patch (row returns to 0)
- `rollbackRowsCleared` called with the key `markRead` would have minted
- a `deleted` row at `unreadCount 0` renders no action and `markUnread` no-ops

## S5.5 Verify

`npm test -w dashboard -- src/routes/inbox`; `npm run typecheck`. Commit.

---

# S6 - The auto-read latch and drain (MUST precede S7)

Files: `dashboard/src/routes/contact/useMarkContactRead.ts`,
`dashboard/src/routes/conversation/useMarkThreadRead.ts` (new),
`ConversationDetail.tsx` (its local `RelayGroupView`) and `GroupTextView.tsx`
(see S7 - `RelayGroupView` is NOT a file) (the components that own the mount
read), plus tests.

## S6.1 Contract

```ts
export interface AutoReadHandle {
  /** Suppress auto-read for the CURRENT identity, then wait for any in-flight
   *  auto-read to settle. Await this BEFORE issuing a mark-unread POST. */
  suppressAndDrain: () => Promise<void>;
}
```

**Memoize the returned object** (`useMemo` on `[suppressAndDrain]`, itself a
`useCallback`). An unstable identity flows into consumer effect deps and
POST-loops - the exact hazard `UnreadContext.tsx:82-88` documents.

## S6.2 `useMarkContactRead`

Currently returns `void`; return `AutoReadHandle`.

- `suppressedForRef: useRef<string | null>(null)` holds the IDENTITY suppressed,
  not a boolean. `markRead` returns early when
  `suppressedForRef.current === contactId`.
  **Keyed, not per-mount**: `/contacts/a` -> `/contacts/b` is a React Router
  param change, NOT a remount (`ContactDetail.tsx:214`), and `markRead`'s
  `[contactId]` dep refires for the new contact. A boolean ref would leave the
  NEXT contact never marked read for the rest of the visit.
- **RESET on identity change.** In the `[contactId]` effect, clear the ref when
  it holds a different id before running `markRead`. Without this, returning to
  a previously-suppressed contact later in the same session never marks it read -
  which contradicts spec 7.3 ("a fresh arrival IS reading it") and 10.3.
- `inFlightRef: useRef<{ id: string; promise: Promise<unknown> } | null>` - set
  when `markRead` issues its POST, cleared in `finally`, keyed so the drain can
  never await a previous contact's request.
- `suppressAndDrain`: set the latch, then await the in-flight promise for THIS
  id, **bounded** by `Promise.race` against
  `AUTO_READ_DRAIN_TIMEOUT_MS = 2000` (module scope).

Why await rather than abort: a client abort does not stop the server committing
the `resetUnread`, so aborting would HIDE the race. Why bounded: `request` has
no timeout of its own and the auto-read passes no signal, so an unbounded await
makes the button look dead - a worse and likelier failure than the narrow tail
race. On timeout proceed; the latch still suppresses the late response
client-side.

## S6.3 `useMarkThreadRead` (new)

`ConversationDetail.tsx:238-242` and `GroupTextView.tsx:259-263` hold the SAME
inline mount effect. Extract it into
`dashboard/src/routes/conversation/useMarkThreadRead.ts` with the same
latch/drain keyed on `conversationId`.

**Move the MOUNT EFFECT ONLY.** Do NOT copy `useMarkContactRead`'s other
triggers - no `visibilitychange`, no `onMessagePersisted`. Those belong to the
contact page's model; adding them here would change shipped behavior and break
the pinned ruling that this read fires blind on mount. "Identical shape" means
the same handle and drain, not the same trigger set.

**Preserve the existing comment block verbatim** - it records the deliberate
ruling that this read is UNWIRED from the badge's optimistic layer, pinned by
regression spies in `GroupTextView.test.tsx:27-31` and
`ConversationDetail.test.tsx:149-151`.

**No identity RESET here, unlike S6.2 - and say why in a comment.** The contact
page needs one because it re-renders the same component across a param change.
`ConversationDetail` does not: its loading branch (`:118-133`) unmounts the child
view while the new header loads, so a `conversationId` change gives
`useMarkThreadRead` a genuinely fresh mount and the ref starts null. That is a
load-bearing property of an unrelated component, so an optimization that keeps
the child mounted across the swap would silently resurrect the
suppressed-forever bug. Leave the reason in the code, not just here.

## S6.4 Tests

- TRIGGER: after `suppressAndDrain()`, a `message.persisted` event does NOT
  issue `markInboxRead`.
- **DRAIN - assert ORDER.** With a deferred in-flight fan-out,
  `suppressAndDrain()` does not resolve until it settles. A trigger-only test
  stays green while the ordering bug ships; this is the test that matters.
- BOUNDED: with an auto-read that never settles, `suppressAndDrain()` still
  resolves after the timeout (fake timers).
- KEYED: after suppressing on `a`, a param change to `b` DOES mark `b` read.
- RESET: returning to `a` after visiting `b` marks `a` read again.
- The existing `noteRowsCleared` spies must still pass unchanged.

Note for the builder: `useMarkContactRead`'s test probe currently exposes no
handle, and `markInboxRead` may need a hoisted mock. Update the probe rather
than working around it.

## S6.5 Verify

`npm test -w dashboard -- src/routes/contact src/routes/conversation`;
`npm run typecheck`. Commit.

---

# S7 - Thread header actions

Files: `dashboard/src/routes/conversation/ConversationDetail.tsx` (which CONTAINS
`RelayGroupView`), `dashboard/src/routes/conversation/GroupTextView.tsx`,
`dashboard/src/routes/contact/ContactDetail.tsx`,
`dashboard/src/routes/contact/ContactActionsMenu.tsx`, plus tests.

**Both group views, and note where they live.** `/conversations/:id` redirects a
plain 1:1 to the contact page, so that route renders one of two components, each
owning its own header and mount read:

- `RelayGroupView` - **NOT a file.** It is a non-exported local function inside
  `ConversationDetail.tsx` (props at `:169`, definition at `:175`, rendered at
  `:141`). Edit it in place; do not go looking for `RelayGroupView.tsx`, and do
  not extract it.
- `GroupTextView` - a real file, `GroupTextView.tsx`.

An earlier draft named only `ConversationDetail`, which would have shipped no
action for group texts. The draft that "fixed" it named `RelayGroupView.tsx`, a
file that does not exist. Both mistakes passed every test those drafts named.

Flow on both surfaces: `await handle.suppressAndDrain()`, then `await` the POST,
then `navigate('/inbox')`. Render a **pending state** while outstanding (assert
it - spec 9.1 requires it). On failure stay put.

**Error copy is new UI, not a reuse.** Neither surface has an existing inline
treatment for these codes. Add one: `409 no_markable_thread` renders
"Could not mark unread - try again" and LEAVES THE ACTION AVAILABLE (it is the
expected, retryable GSI-lag path, not an error the operator must reason about).
Any other failure uses the same inline treatment.

**No client-side already-unread guard on either surface.** The count guard is
condition clause 3. Neither surface can evaluate it: the conversation page's
header is fetched once per mount and is deterministically PRE-auto-read
(`ConversationDetail.tsx:81-87`, `:118-152`, `:148-151` - nothing re-reads it),
and the contact page has no unread datum at all (`useContact.ts:23-45`). Comment
the reasoning on both so nobody "improves" it back.

- **Group views**: "Mark unread" header action ->
  `markConversationUnread(conversationId)`. HIDDEN for a closed relay group -
  unlike the row, this guard IS live (reachable by deep link and from the
  contact's relay-groups card).
- **Contact page**: a "Mark unread" item in `ContactActionsMenu` (the kebab
  at `ContactDetail.tsx:658`) -> `markInboxUnread({ contactId })`. Hidden when
  the contact is soft-deleted. In the MENU, and specifically NOT in
  `ContactCommsPane` - that pane is shared with the tour and placement 1:1 tabs
  (`TourConversation.tsx:263`, `PlacementConversation.tsx:260`), so putting it
  there leaks the action onto surfaces non-goal 5 excludes.
  `ContactActionsMenu` gains required props; update every render site
  (`grep -rn "<ContactActionsMenu" dashboard/src`) in the same commit.

**Neither header action touches `UnreadContext`.** Neither auto-read records a
clear, so there is nothing to roll back. `ContactDetail.test.tsx` has NO
`UnreadContext` mock today, so for that surface ADD a spy rather than
"extending an existing" one.

Spec 9.2 step 4 drives the CONTACT page action; keep the e2e and this slice
consistent about it living in the kebab.

## S7 tests (spec 9.1's header assertions - do not skip)

An earlier draft of this plan lost this list in a rewrite, leaving six spec
assertions in no task at all - including the one the whole D2 arc rests on.

For BOTH surfaces (the local `RelayGroupView`, `GroupTextView`, and the contact
kebab):

1. **Calls `suppressAndDrain` BEFORE the POST.** This is the component-level
   wiring test for S6's drain; without it, S6 can be perfect and S7 can still
   fail to call it. Assert ORDER, not just that both happened.
2. Navigates to `/inbox` on success.
3. Does NOT navigate on rejection.
4. Renders the pending state while the drain/POST is outstanding.
5. A `409 no_markable_thread` renders "Could not mark unread - try again" and
   LEAVES THE ACTION AVAILABLE.
6. Visibility: the group action is absent for a closed relay group; the contact
   kebab item is absent for a soft-deleted contact.

Plus: neither surface calls into `UnreadContext`. `GroupTextView.test.tsx` and
`ConversationDetail.test.tsx` already have spies to extend;
`ContactDetail.test.tsx` has NO `UnreadContext` mock, so ADD one there.

---

# S8 - The Unread list truncation notice

Files: `dashboard/src/routes/inbox/Inbox.tsx`, `Inbox.test.tsx`.

Render when `inbox.status === 'ready' && inbox.truncated && inbox.serverRowCount > 0`,
reusing `styles.notice` (the group-text truncation treatment at
`Inbox.tsx:88-116`). Copy, with NO count:
"Showing the most recent unread. There are older unread threads not shown here."

Comment to carry: a truncated NON-EMPTY unread page ends silently today
(`hasMore` false, and the truncation banner is gated on the page having come
back EMPTY), so a capped list looks exactly like the end of the feed. Gate on
`serverRowCount`, NOT `rows.length` - both `truncated` and that count describe
the SERVER page while `rows` is the client-filtered list the Unread tab empties
as rows are marked read, so a rows-keyed notice would vanish mid-triage. The
condition is the exact complement of `serverEndedEarlyEmpty`, so the two can
never render together. No count in the copy because the operator clears rows
while the flag stands, so any number reaches zero with the notice still up.

Tests: renders on a non-empty truncated page; not on an untruncated page; not
alongside the empty/error surface; and **stays rendered after every visible row
is marked read** (the `serverRowCount` gate - a `rows`-keyed test would pass
while the regression ships).

---

# S9 - e2e

File: `e2e/tests/dashboard-next/inbox-mark-unread.spec.ts` (new).

**Starting state:** lean seeds every conversation `unread_count: 0` on purpose
(`app/src/lib/seed/lean.ts:23-25`), so the spec MUST manufacture unread with the
fake-Twilio inbound fixture (`sendAsParty`, as `inbox-nav-badge.spec.ts` does).

**Anchoring:** a row's count carries `aria-label="<n> unread"`
(`InboxRow.tsx:107-111`), the SAME accessible name as the nav badge
(`NavContents.tsx:66`); a bare `getByLabel('1 unread')` matches both and fails
strict mode (`inbox-nav-badge.spec.ts:15-21`). Address rows by href. Mind S5.1 -
the `/mark .* read/i` idiom appears in e2e too.

1. Drive an inbound; open the row (marks it read); return to the inbox; confirm
   no unread treatment.
2. Reveal the row's actions, click "Mark unread"; assert the row (by href) shows
   the unread treatment and a count of 1.
3. Switch to the Unread filter; assert the row is present.
4. From the contact page kebab, click "Mark unread"; assert the browser lands on
   the inbox with that row unread.

---

# S10 - Close out

1. Sync `main` into the branch ONCE, at this final step. If it conflicts with
   active work, ASK before resolving. Expect a conflict window in
   `app/src/routes/inbox.ts` and `app/src/repos/conversationsRepo.ts` from
   `feat/call-inbox-unread` if it has landed - report drift, do not chase it.
2. Gates BARE from `W:\tmp\inbox-mark-unread`, never piped: `npm run typecheck`,
   `npm test`, `npm run e2e`. Re-run either known flake once before blaming this
   change and report BOTH runs: `tour-reminders-panel-e2e-flake`,
   `conversationdetail-members-mock-suite-flake`.
3. `npm run issues` if any `docs/issues/` file was added.
4. Handback to `.superpowers/sdd/handback.md`: per-spec-item status, quoted exit
   codes on the final commit, drift, owed post-merge ops (expected: NONE).

## Watch items for the builder

- **Do not "fix" the relay close path.** It already zeroes unread and drops the
  flag inside `setRelayStatus` (`conversationsRepo.ts:1877-1878`); a reviewer
  wrongly reported otherwise by grepping only the route file.
- **Do not add an optimistic-increment layer to `UnreadContext`.** Non-goal 4.
- **Do not touch `last_activity_at`.** D4.
- **Do not put the contact action in `ContactCommsPane`.** Non-goal 5.
- **Do not add visibility/SSE triggers to the conversation-page read.** S6.3.
- **`unread_count` is sparse.** The `attribute_not_exists` half of clause 3 is
  not defensive padding.
- **Docker must be up for S1's red state to mean anything.**
