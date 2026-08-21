<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-08-18).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Inbox: mark a thread unread - design spec

Date: 2026-08-17
Branch: `feat/inbox-mark-unread`  Worktree: `W:\tmp\inbox-mark-unread`
Base: `main` @aa62b493
Design review: spec R1 complete (2 reviewers, 27 findings, 16 distinct);
adjudications at `.superpowers/design-review/adjudications.md`.

## 1. Problem

An operator reads an inbox thread, decides it needs follow-up later, and has no
way to put it back. Once read, a thread has no to-do affordance: the unread
badge, the Unread filter, and the Today unread pass are all one-way (inbound
message sets unread, human attention clears it).

The ask: mark a thread unread so it resurfaces as a to-do item. One message's
worth of unread - not a restoration of whatever the count used to be.

Precisely: the action's goal state is "this thread is unread". On a READ thread
that means `unread_count = 1`. On a thread that is ALREADY unread the goal state
already holds, so the action succeeds and writes nothing - it never overwrites a
genuine count of 5 with 1 (6.1 clause 3, 6.3).

## 2. Goal

Give the operator a "Mark unread" action that makes one conversation unread
(`unread_count = 1` when it was read; left alone when it already was), so its
inbox row shows the unread treatment, the row counts toward the nav badge, and
it appears under the Unread filter - reusing the unread primitives merged
2026-08-17 (`feat/inbox-unread-index`) with no new state model.

Two bounds on that goal, both established by review and both real:

- **The ~100-row cap (section 10.1).** All three unread surfaces are ordered
  newest-`last_activity_at`-first and capped. Because D4 forbids touching the
  timestamp, a thread marked unread re-enters at its OLD position, so past the
  cap it contributes to none of them. Accepted by the human at the spec gate on
  the grounds that newer unread is genuinely more pressing - conditional on the
  Unread list SAYING it is capped, which it does not do today (7.4).
- **Today covers 1:1 threads only.** Today's unread pass skips both group kinds
  (`app/src/routes/today.ts:698`), so marking a relay group or group text unread
  reaches the badge and the Unread filter but never Today.

## 3. Locked decisions (human rulings, 2026-08-17)

- **D1 - Surfaces.** The action appears in TWO places: the inbox row (the
  hover/focus/swipe action strip that already hosts "Mark read"), and the header
  of the thread pages an inbox row opens - the contact page (`/contacts/:id`)
  and the conversation page (`/conversations/:id`).
  Note `hrefFor` (`InboxRow.tsx:33-44`) has a THIRD arm: unknown rows route to
  the `/contacts/unknown?phone=` triage list. Unknown rows get the ROW action
  and no header action - an explicit scope call, not an omission. Note also that
  `/conversations/:id` redirects a plain 1:1 to the contact page
  (`ConversationDetail.tsx:155-159`), so that page only ever renders the two
  group kinds.
- **D2 - Auto-read collision: navigate away.** The thread-header action marks
  unread, then navigates to `/inbox`. (Revised by review: leaving the page is
  NOT sufficient on its own - see 7.3. The navigation is the UX; an
  identity-keyed latch plus a drain of the in-flight auto-read is the
  correctness mechanism.)
- **D3 - One thread.** A contact inbox row aggregates unread across every 1:1
  thread the contact owns (phone and email). Marking unread affects exactly ONE
  conversation - the newest ELIGIBLE thread as defined in 6.2 - setting it to
  `unread_count = 1` if it was read, and leaving an already-unread thread
  untouched. Never a fan-out, never a restored prior count. (Revised by
  review: the contact PAGE uses this same rule rather than a "current tab"
  rule, because the contact page has no channel tabs - see 7.3.)
- **D4 - Timestamps are not touched.** `last_activity_at` is never written by
  this feature. No presentation-level re-sorting of unread rows either. See the
  section 10.1 bound this implies.
- **D5 - Closed and deleted are out of bounds.** The server refuses to mark
  unread a closed relay group or any thread belonging to a soft-deleted contact.
  This preserves the two invariants ruled on 2026-08-16: a closed group can
  never sit unread-and-invisible in the `byUnread` index, and soft-deleting a
  contact draws a line under its unread.
- **D6 - Every surface is a TOGGLE** (ruled 2026-08-17, after the review loop
  closed). The inbox row already shows exactly one of "Mark read" / "Mark
  unread" by its count; the two headers do the same. Offering "Mark unread" on
  an already-unread thread is what creates the awkward case, so the fix is to
  not offer it rather than to handle the click better. The server's already-read
  condition and its 200-already-unread response STAY as the guarantee - a toggle
  reads client state, which can be stale. Full mechanism in 7.3.

## 4. The load-bearing invariants

`isUnreadVisible` (`app/src/lib/unreadFeed.ts:309-317`) is the single shared
definition of "unread the human should see" - used by the badge collector, the
unread feed, and Today. An unread row that is NOT visible under it is index
residue: it sits in the sparse `byUnread` partition forever and costs scan
budget on every badge read. That is the "residue wall" the previous mission
spent three fix waves bounding.

**INVARIANT MU-1.** A mark-unread write is permitted only on a conversation `c`
for which `isUnreadVisible({ ...c, unread_count: 1 })` is true. Concretely: not
a pointer-partition row; `relay_group` must be `open` or `connecting`;
`group_text` must be `group_open`; any other (1:1) type - including a legacy row
with no `type`, which `isOneToOneBucket` deliberately admits - must be `open`.

**INVARIANT MU-2.** A mark-unread write is refused when the target thread's
contact is soft-deleted, whatever MU-1 says. `isUnreadVisible` knows nothing
about contacts; the deleted-contact rule lives one layer up in
`collectUnreadRows`. A marked-unread thread on a deleted contact is either
invisible residue or drags a deleted contact back into the inbox. Both are
wrong (D5).

**Enforcement is a CONDITIONAL WRITE, not a prior read.** MU-1's status/type
precondition rides `setUnread`'s own `ConditionExpression` (6.1). A read-then-
write would be TOCTOU: a relay close (`app/src/routes/relayGroups.ts:453` ->
`setRelayStatus`, which zeroes unread and REMOVEs the flag at
`conversationsRepo.ts:1877-1878`) committing between the route's load and its
write would leave permanent residue. Every other correctness-critical write in
this repo carries its precondition the same way (`setRelayStatus`,
`rosterMutate`, `claimRailCreation`).

**Residual, accepted:** MU-2 cannot ride the same condition, because contact
soft-delete mutates a DIFFERENT item (`app/src/routes/contacts.ts:1985` fans
`resetUnread` over `conversationsForContact`). A delete committing inside the
route's window can therefore still leave one marked-unread thread on a deleted
contact. Two things make this acceptable: the resurfacing probe hides such a row
from the inbox unless its newest message post-dates the deletion, and
`app/scripts/backfill-unread-flag.ts` is the existing recovery. Documented
rather than engineered around; a distributed transaction here is not warranted.

Client-side hiding of the action is a usability measure, never the guarantee.

## 4b. Delivered state (2026-08-17)

The inbox-ROW half of this spec was built on `feat/call-inbox-unread` and merged
into this branch at @e4890b98; that branch is now FROZEN. What shipped matches
D1/D3/D5 and D6's row half. Two implementation facts differ from what sections
6-7 originally described, and the sections below are written as the TARGET
state, not as a description of untouched ground:

- The three routes were built on `incrementUnread` with a route-level
  read-then-check-then-write. Section 6.1's `setUnread` conditional write is
  therefore a HARDENING step (plan H1, human-ruled), not new construction. It
  closes the TOCTOU; it does not change observable behavior, and the delivered
  route matrix must stay green through it.
- `POST /api/inbox/unread { phone }` shipped WITHOUT the MU-2 contact check.
  Plan H2 closes it (human-ruled). Until then MU-2 is enforced on two of three
  routes, which is exactly what section 4 forbids.
- No route returns a top-level `unreadCount`, and none needs to: every live
  count this spec relies on - including D6's toggle - comes from the
  `conversation.updated` SSE event, which carries `unread_count`.
- The row's unread action is labelled `Mark <name> as unread`. The "as" is
  deliberate so the two labels are not substrings of each other; new surfaces
  keep that shape.

## 5. Data model

No schema change. No new attribute. No migration. No backfill.

The feature writes the two attributes the merged unread design already owns:
`unread_count` and the sparse GSI hash `unread_flag`.

## 6. Server design

### 6.1 New repo primitive

`ConversationsRepo.setUnread(conversationId, eligibility): Promise<ConversationItem>`,
beside `incrementUnread` / `resetUnread` in
`app/src/repos/conversationsRepo.ts`.

`eligibility` is exactly one of:

- `{ bucket: 'relay_group' }` -> `type` must be `relay_group` AND status must be
  `open` or `connecting`
- `{ bucket: 'group_text' }`  -> `type` must be `group_text` AND status must be
  `group_open`
- `{ bucket: 'one_to_one' }`  -> status must be `open`, and the row's `type`
  must be absent or NOT one of `relay_group` / `group_text`

Every bucket carries a TYPE clause, not only `one_to_one`. Without it the
`relay_group` bucket's status predicate is satisfied by any open 1:1 thread
(`conversationsRepo.ts:117-119`), and the only thing keeping them apart would be
the route's own type read - the exact value the conditional write exists to
distrust. It is safe today only because the sole type-changing writer
(`convertRelayGroupToGroupText`, `conversationsRepo.ts:2311-2338`) also moves
status out of the admitted set. Do not depend on that coincidence.

Behavior:

- ONE `UpdateCommand`: `SET unread_count = :one, unread_flag = :flag` with
  `:one = 1` and `:flag = UNREAD_FLAG_VALUE`.
- `ConditionExpression`, three clauses ANDed:
  1. `attribute_exists(conversationId)`
  2. the bucket's type/status predicate above - MU-1 as a WRITE condition
     (section 4)
  3. `(attribute_not_exists(unread_count) OR unread_count = :zero)` - the
     ALREADY-READ precondition. `setUnread` is a `SET`, so writing it over a
     thread sitting at 5 is data loss. Section 4 says client-side hiding is
     never the guarantee; this is the clause that makes that true for the count
     as well as for eligibility. The UI does not RELY on it - every surface is a
     toggle showing only the action matching current state (7.2, 7.3) - but the
     UI's view of that state can be stale, and this clause is what makes a stale
     view harmless rather than destructive.
- A `ConditionalCheckFailedException` is AMBIGUOUS across those three clauses,
  so the route CLASSIFIES it with one re-read rather than guessing - see 6.3.
- `ReturnValues: 'ALL_NEW'`.
- `SET`, not `ADD`: the count is deterministically 1 (D3), and the counter and
  the index hash ride ONE write so the row can never be unread-but-unindexed -
  the property `incrementUnread` was built for.
- Accepted risk, same class the repo already documents at
  `conversationsRepo.ts:1541-1543` for `resetUnread`: `SET` is last-write-wins
  against an in-flight inbound `ADD`, so a `setUnread` racing a fresh inbound
  writes 1 where the truth is 2. The flag is correct either way and the row
  stays visible, so this is minor - but it is stated rather than assumed.
- Logs `conversation unread set` at info, mirroring `resetUnread`.

The bucket is chosen by the ROUTE from the item it read; the condition is what
makes that choice safe against a concurrent transition.

### 6.2 Eligible-thread selection (shared by both fan-in routes)

Both fan-in routes pick ONE thread. The candidate filter must track the INBOX
READER's, not `conversationsForContact`'s raw union - `contactThreads.ts:13-15`
states that callers keep their own status/type filters, and the contact row's
set is `all.filter(c => c.status === 'open' && c.type !== 'relay_group')`
(`app/src/routes/inbox.ts:516-517`). Filtering on MU-1 alone would admit an OPEN
relay group, so a contact whose record carries a pool number could click their
CONTACT row and light up the RELAY GROUP row instead.

Selection rule: filter to threads that are `status === 'open'` AND in the 1:1
bucket (`isOneToOneBucket`), then take the newest by `last_activity_at`,
mirroring `newestOf`'s strict `>` (`inbox.ts:526-532`) so ties resolve to
first-encountered in query order - the same thread the row itself previews.

This is deliberately STRICTER than the reader's literal predicate, not a
paraphrase of it: `isOneToOneBucket` excludes `group_text` as well as
`relay_group`. The two sets are identical today (a `group_text` carries status
`group_open`, never `open`, and `contactThreads.ts:17-23` states a group thread
can never be returned by `conversationsForContact` at all), so this is a
future-proofing choice, taken because that same comment warns that "if a future
change ever gives a group thread a participant key, EVERY caller of this
function needs a type filter first". A negative bucket test survives that change;
an enumerated `!== 'relay_group'` does not.

### 6.3 New endpoints

Three, each mirroring an existing mark-read route so the client's kind-dispatch
stays symmetric.

**Shared: classifying a condition failure.** `setUnread`'s condition has three
clauses (6.1) and DynamoDB does not say which one failed, so every route handles
a `ConditionalCheckFailedException` by re-reading the item ONCE and answering,
**in this order**:

1. item absent -> **depends on whether the CLIENT named that conversation.**
   - Conversation route: `404 conversation_not_found`, aligned with the `/read`
     route it mirrors (`app/src/routes/api.ts:2041-2045`).
   - The two FAN-IN routes: `409 no_markable_thread` (retryable). The client
     named a contact or a phone, not a conversation; the selected thread is an
     internal detail. Answering 404 there would assert that the CONTACT is
     missing, which is false - the route loaded it one step earlier.
     `contact_not_found` and `no_conversation_for_phone` stay reserved for the
     step-1 lookup miss.
2. item INELIGIBLE by type/status -> `409 thread_not_markable_unread`.
3. item eligible and `unread_count > 0` -> **`200` success, no write.** The
   operator asked for "this thread is unread" and it already is; the goal state
   holds. With D6's toggle this should be RARE - the UI does not offer the
   action in that state - but the client's view can be stale by a round trip,
   and answering an error for a goal state that already holds would be wrong.
4. item eligible and `unread_count` is 0 or absent -> **RACED**: the row was
   concurrently reset between the write and this re-read. Reporting 200 would
   claim "unread" about a row reading 0. Retry the write ONCE, then classify
   again without a second retry.

**Eligibility is checked BEFORE the count, and the order is load-bearing.** An
ineligible-AND-unread thread is a real state, not a hypothetical: a closed relay
group can be re-flagged unread by an inbound, which is the open issue
`docs/issues/inbound-reflags-closed-relay-group.md`. Classifying on the count
first would answer 200 for exactly that residue row - reporting success for a
thread the feature is supposed to refuse.

**Every route returns the authoritative resulting count** (`{ conversation }`
already carries it; the two fan-in routes return `{ ok: true, unreadCount }`).
The client commits THAT value rather than assuming 1 - otherwise the 200-no-write
arm leaves an optimistic `1` committed against a server truth of 5, with no
event to reconcile it. The no-write arm emits no `conversation.updated`, because
nothing changed; the returned count is what keeps the client honest.

Cost: on the SUCCESS path, nothing extra. On a condition failure, one re-read.
In the rare `raced` case (the row was concurrently reset between the write and
the re-read) the route retries the write once and may re-classify, so the worst
case is two reads and two writes - still bounded, and only on a contended row.

**`POST /api/conversations/:conversationId/unread`** (`app/src/routes/api.ts`,
beside the existing `/read`). Used by relay-group rows, group-text rows, and the
conversation page.

1. Load the conversation; `404 conversation_not_found` if absent.
2. MU-1 pre-check on the read item (fail fast with a clear error): if
   `isUnreadVisible({ ...conv, unread_count: 1 })` is false, respond
   `409 thread_not_markable_unread`.
3. MU-2: for a 1:1 thread, resolve the participant's contact; if soft-deleted,
   respond `409 thread_not_markable_unread`. A group thread has no single owning
   contact and skips this step.
4. `setUnread` with the bucket derived from the item's type; classify a
   condition failure per the shared rule above.
5. Emit `conversation.updated` with `toConversationUpdatedEvent(conversation)`;
   respond `{ conversation }`.

**`POST /api/inbox/unread` `{ phone }`** (`app/src/routes/inbox.ts`). Used by
unknown-number rows, which carry no contactId.

1. Same E.164 validation and `400` shapes as `POST /api/inbox/read`.
2. `findByParticipantPhone`; `404 no_conversation_for_phone` when empty.
3. **MU-2:** resolve the phone's contact (`contacts.findByPhone`); if it exists
   and is soft-deleted, respond `409 contact_deleted`. This step is what the
   route it mirrors does NOT have, deliberately: zeroing unread on a deleted
   contact is harmless, SETTING it is exactly what MU-2 forbids. The route is
   reachable for such a phone because `useInbox`'s third dispatch branch is the
   kind-free `else if (row.phone !== undefined)`
   (`dashboard/src/routes/inbox/useInbox.ts:336-339`).
4. Apply 6.2's selection; `409 no_markable_thread` if nothing survives.
5. `setUnread` on that ONE thread (NOT a fan-out - the deliberate asymmetry with
   the read routes), classify a condition failure per the shared rule, emit
   `conversation.updated`, respond `{ ok: true, unreadCount }`.

**`POST /api/inbox/:contactId/unread`** (same file). Used by contact rows and
the contact page.

1. `contacts.getById`; `404 contact_not_found` if absent.
2. MU-2: soft-deleted contact -> `409 contact_deleted`.
3. `conversationsForContact(contact, conversations)` for the phone+email union,
   then 6.2's selection; `409 no_markable_thread` if nothing survives.
4. `setUnread` on that ONE thread, classify a condition failure per the shared
   rule, emit `conversation.updated`, respond `{ ok: true, unreadCount }`.

**Both fan-in routes depend on the eventually-consistent participant GSIs**
(`byParticipantPhone` / `byParticipantEmail`), whose lag is an open filed defect
(`docs/issues/mark-read-fanout-stale-gsi-skip.md`, which absorbed the separately
filed `markread-fanout-depends-on-stale-participant-gsi` on 2026-08-21). A fan-OUT
degrades gracefully under it; a fan-IN "pick exactly one" does not. Two
consequences, both accepted rather than engineered around (the inbox reader
carries a lag discriminator and a one-shot retry for this, `inbox.ts:976-1041`;
that machinery is not warranted for a manual, repeatable, single-row action):

- In the window just after an inbound, "newest" can resolve to a thread other
  than the one the row previews. Same contact, same row lights up; only D3's
  choice of WHICH thread is affected.
- The set can come back empty or all-ineligible for a row the operator is
  looking at, producing `409 no_markable_thread`. This 409 is EXPECTED and
  RETRYABLE, not an error state: both surfaces render "Could not mark unread -
  try again" via a NEW inline error treatment (neither surface has an existing
  one for these codes - see 7.3), and the action
  stays available. It must not be reported as a failure the operator has to
  reason about.

Registration order: keep `POST /unread` above `POST /:contactId/unread` for
consistency with the existing `/read` pair. This is house-style belt-and-braces,
NOT a live hazard - the paths are one and two segments, so Express cannot
confuse them at any order, exactly as `inbox.ts:1607-1610` already records.

### 6.4 SSE

Every route emits `conversation.updated`, as the mark-read routes do. That is
what makes other open dashboards, the nav badge, and Today pick the change up
live. No new event type.

## 7. Client design

### 7.1 API client (`dashboard/src/api/endpoints.ts`)

- `markConversationUnread(conversationId, signal?)` -> `POST /api/conversations/:id/unread`
- `markInboxUnread({ contactId } | { phone }, signal?)` -> the two inbox routes

### 7.2 Inbox row (`InboxRow.tsx`, `useInbox.ts`)

`InboxRow` already renders an actions strip revealed on hover / focus-within /
swipe, containing "Mark read" when `unreadCount > 0`. Add the symmetric case:
when `unreadCount === 0`, render "Mark unread" in the same slot, with
`aria-label={`Mark ${row.name} unread`}`. Exactly one of the two actions is
present at any time.

**One client-side guard on the row: `deleted`. Not the closed-relay one.**
(Corrected during plan review - the earlier claim that BOTH guards were dead
code was half wrong.)

- **`row.deleted` -> guard, and keep it.** A deleted row is normally emitted only
  when some thread is unread (`inbox.ts:786`, `:645-647`), which would make the
  guard unreachable. But `useInbox.markRead` sets `unreadCount: 0` optimistically
  and COMMITS it to `base`, so on the `all` filter a deleted row can genuinely
  sit at 0 with the action showing. Clicking it earns a silent 409.
- **Closed relay group -> no guard.** That one IS unreachable on a row: the relay
  source reads only the `open` and `connecting` partitions (`inbox.ts:1396`).
  Say so in a comment so nobody adds it. (The conversation PAGE guard is live -
  see 7.3.)

D5 on this surface remains server-enforced; the `deleted` guard is a usability
measure that avoids a pointless round trip.

`useInbox` gains `markUnread(row)`, the mirror of `markRead`:

- Bail if `row.unreadCount > 0`, or if the row is unaddressable (do not fake
  success).
- Resolve the call per KIND in ONE branch that also mints the badge key, the
  shape `markRead` uses: multi-party -> `markConversationUnread` +
  `conversationClearKey`; contact -> `markInboxUnread({ contactId })` +
  `contactClearKey`; by-phone -> `markInboxUnread({ phone })` + `phoneClearKey`.
- Optimistic patch `setPatch(key, { unreadCount: 1 })`, dropped on failure, as
  `markRead` does. On success commit the count the SERVER returned (6.3), not a
  hardcoded 1 - the already-unread arm can legitimately answer 5.
- **Call `rollbackRowsCleared([clearKey])`** to purge a pending CLEAR for the
  same row. Do NOT add a "note set" counterpart. Mechanism, corrected by review:
  `UnreadContext` expires a pending clear on the first count fetch that STARTED
  after it (`UnreadContext.tsx:123-135`), and `conversation.updated` guarantees
  such a fetch on a 300ms debounce; the 10s TTL is only the no-reconcile
  backstop (`:53-55`). So the drift window is ~300ms plus a round trip, not 10s
  - small, but the clear is genuinely stale the moment the row goes unread
  again, and purging it is free. The badge's increment then arrives with the
  reconcile. No optimistic-increment layer is added to `UnreadContext`
  (non-goal 4).
- **Failure branch:** `rollbackRowsCleared` only deletes; there is no re-add. On
  a rejected POST the badge therefore sits one ABOVE the truth until the next
  reconcile. Accepted (it self-heals within the same ~300ms window and the
  alternative is re-noting a clear for a row that may legitimately be unread),
  but stated so it is not rediscovered as a bug.

### 7.3 Thread headers

**D6 - the header is a TOGGLE, like the row** (human ruling, 2026-08-17, after
the review loop closed). The row already shows exactly one of "Mark read" /
"Mark unread" according to the row's count. The headers do the same. Showing
"Mark unread" on a thread that is already unread is the situation that creates
the contention in the first place; the fix is not to handle the click better but
to not offer it.

The server's already-read condition (6.1 clause 3) and the 200-already-unread
arm (6.3) STAY. They are the guarantee; the toggle is the UI. A toggle driven by
a possibly-stale client view is exactly why the write still needs its own
precondition.

**Where the live count comes from.** An earlier draft dropped the client rule on
the grounds that neither header could evaluate it. That was wrong about the
mechanism available: `ConversationUpdatedEvent` carries `unread_count`
(`dashboard/src/api/types.ts:1488`, built with `?? 0` at
`app/src/lib/events.ts:89`), and every mark-read and mark-unread write emits it.
So both surfaces can hold a LIVE count rather than the frozen one:

- **Conversation page.** Seed from the header's raw `unread_count` at mount
  (it rides `ConversationHeader`'s index signature - read it defensively, it is
  not a typed field), then update on `onConversationUpdated` for this
  `conversationId`. The mount auto-read emits that event itself, so the page
  learns its post-read count without a re-fetch - which is precisely the
  staleness the earlier draft could not get past.
- **Contact page.** No unread datum exists, and none is added. Derive instead:
  the mount fan-out marks EVERY thread of the contact read, so once it resolves
  successfully the contact is read. Track a local `hasUnread`, set false on a
  successful fan-out, and set true by any `onConversationUpdated` carrying
  `unread_count > 0` for a conversation in the contact's timeline. When the
  fan-out was skipped (background tab) or failed, state is UNKNOWN - show "Mark
  unread", the safe default, and let the server refuse if it is wrong.

**Navigation is asymmetric, deliberately.** "Mark unread" navigates to `/inbox`
(D2 - it means "I am done here, put this back on my list"). "Mark read" does
NOT navigate; marking read while reading is not a departure. Both render the
same inline error treatment on failure (NEW UI - neither surface has an existing
one for these codes).

"Mark read" on the header calls the EXISTING read endpoints
(`markConversationRead` / `markInboxRead`), not anything new. In practice it
appears rarely, since arriving marks the thread read - but it is exactly right
in the cases that made the earlier design awkward: a backgrounded tab where the
auto-read was skipped, or a failed fan-out.

**The auto-read latch (D2, revised).** Navigating away is not sufficient on its
own. `useMarkContactRead.ts:20-50` fires uncancelled on mount, on
`visibilitychange`, and on EVERY org-wide `message.persisted` SSE event, with no
AbortController; `ConversationDetail.tsx:238-242` and `GroupTextView.tsx:259-263`
fire the same way from a mount effect. Unmounting stops future triggers, not one
already in flight or one that fires during the await - so the action would
intermittently no-op with a success response, the worst failure shape for a
to-do affordance.

Mechanism, in two parts - the second is what actually closes the race:

1. **Latch.** Each auto-read site gains a `suppressed` ref; the auto-read
   callback returns early while it is set. It is KEYED to the identity it
   protects. On the CONTACT page it is reset whenever `contactId` changes; the
   conversation page needs no reset, for the reason in part 2 below. It is NOT
   per-mount:
   `/contacts/a` -> `/contacts/b` is a React Router param change, not a remount
   (`ContactDetail.tsx:214`, and `useMarkContactRead`'s own `[contactId]`
   dependency at `useMarkContactRead.ts:20-37` refires for the new contact). A
   component-scoped ref would leave the NEXT contact's comms never marked read
   for the rest of the visit - a silent regression of shipped behavior, reachable
   from this spec's own "on failure stay put" path plus any relationship link.
2. **Drain.** Setting a flag cannot recall a POST already on the wire, and the
   read fan-out is the heavier write (`inbox.ts:1661-1675` does a lookup plus a
   `resetUnread` per thread), so last-writer-wins would frequently be the
   fan-out. The mark-unread handler therefore awaits the in-flight auto-read
   before issuing its own POST (latch first, then drain, then POST). Awaiting
   rather than aborting is deliberate: a client-side abort does not stop the
   server from committing the `resetUnread`, so it would hide the race instead
   of closing it.

   **Shape.** `useMarkContactRead` currently returns `void`; it returns a handle
   `{ suppressAndDrain(): Promise<void> }` instead. The conversation page has no
   equivalent hook - the mount read is inline in two components
   (`ConversationDetail.tsx:238-242`, `GroupTextView.tsx:259-263`) - so that
   effect is extracted into one small shared hook exposing the same handle,
   which both components mount. The drain's in-flight ref is keyed the same way
   the latch is, so it can never order against a request belonging to a previous
   `contactId` on the contact page. The conversation page needs NO reset:
   `ConversationDetail` renders its loading branch (`:107-113`) while a new
   header loads, which unmounts the child view, so a `conversationId` change
   already gives the hook a fresh mount. That is a load-bearing property of an
   unrelated component and belongs in a comment there.

   **Bounded.** The drain awaits with a short timeout (the request has no
   timeout of its own in `client.ts` and the auto-read passes no signal), and
   the button renders a pending state while draining. On timeout the handler
   proceeds anyway: an unbounded await would make the button look dead, which is
   a worse and more likely failure than the narrow race it would be avoiding.
   The latch still suppresses the late response client-side; only the server-side
   ordering is unprotected in that tail case, and it is bounded by the timeout.

Without part 2 the ordering bug ships, and it will surface first as an e2e flake
(9.2 step 4 clicks within tens of milliseconds of mount) - the failure shape most
likely to be re-run away rather than diagnosed.

- **Conversation page** (`/conversations/:id`, relay groups and group texts):
  a "Mark unread" header action calling `markConversationUnread(conversationId)`.
  Hidden when the thread is a closed relay group - unlike the inbox row, this
  guard IS live, because a closed relay group is reachable here by deep link and
  from the contact's relay-groups card.
- **Contact page** (`/contacts/:id`): a "Mark unread" action calling
  `markInboxUnread({ contactId })` - the fan-in route, same rule as the contact
  inbox row.

  Revised by review: the earlier "target the open channel tab" rule had no
  referent. The contact page has no channel tabs - `ContactDetail.tsx:83` types
  the only tab-like state as `Pane = 'comms' | 'profile'`, a narrow-width layout
  toggle, and the pane renders ONE blended person-centric timeline. Its only
  per-conversation state is `selectedConvId` (`ContactCommsPane.tsx:83,136`), a
  phone-keyed REPLY target that is null for a contact with no thread yet and can
  never address an email-only thread.

  Placement: the action goes in `ContactDetail`'s own header band, NOT in
  `ContactCommsPane`. The pane is shared with the tour and placement 1:1 tabs
  (`ContactDetail.tsx:14-15`, `TourConversation.tsx:263`,
  `PlacementConversation.tsx:260`), so putting it there would leak the action
  onto the surfaces non-goal 5 excludes.

  Hidden when the contact is soft-deleted (D5).

**Neither header action touches `UnreadContext`.** No `rollbackRowsCleared`, no
`noteRowsCleared`. Both pages' auto-reads are DELIBERATELY unwired from the
badge's optimistic layer - they fire blind on mount with no unread knowledge -
and that ruling is pinned by regression spies
(`GroupTextView.tsx:248-257` with `GroupTextView.test.tsx:27-31`, and
`ConversationDetail.test.tsx:149-151`). So no pending clear is ever outstanding
from them, and there is nothing to roll back. `rollbackRowsCleared` belongs to
`useInbox` alone (7.2), which is the only surface here that records clears.

### 7.4 The Unread list's truncation notice (human ruling, spec gate)

The Unread feed pages 30 rows at a time and reaches ~120+ unread rows before
`SEEN_SET_MAX` ends it with `nextCursor: null` AND `truncated: true`
(`inbox.ts:217-231`). Today, a NON-EMPTY truncated page ends SILENTLY: `hasMore`
is false so no "Load more" renders, and the truncated banner in `Inbox.tsx`
is gated on `serverEndedEarlyEmpty` - i.e. it fires only when the page came back
with no rows at all. A partially-filled truncated list therefore looks exactly
like the end of the feed.

That is a pre-existing gap in the merged unread work, not one this feature
introduces. It is in scope here by the human's explicit ruling at the spec gate:
a cap is acceptable, but only if the list SAYS it is capped, and this feature's
whole point is putting things into that list.

Add a notice to the Unread list, rendered when
`inbox.truncated && inbox.serverRowCount > 0`:

- Gate on `serverRowCount`, NOT `rows.length` - the same adversarial-4 lesson
  the existing banner records: `truncated` and `serverRowCount` both describe
  the SERVER page, while `rows` is the client-filtered list that empties as the
  operator marks rows read. Keyed on `rows`, the notice would vanish mid-triage.
- The condition is the exact complement of `serverEndedEarlyEmpty`
  (`serverRowCount === 0 && truncated`), so the notice and the empty/error
  surface can never render together.
- Reuse the existing `styles.notice` treatment the group-text truncation already
  uses (`Inbox.tsx:88-116`).
- **No count in the copy.** That same block records why: on the Unread filter
  the operator clears rows while the server's flag stands, so any count reaches
  zero with the notice still rendering. Copy states the fact without a number,
  e.g. "Showing the most recent unread. There are older unread threads not shown
  here."

This does not change D4 and adds no server work - `truncated` is already on the
wire.

### 7.5 Nav badge and Today

No code change to either. Both read the server's index-backed count, so a
mark-unread reaches them through `conversation.updated`.

Two consequences for Today, established by review and accepted (see 10.2):
Today classifies rather than merely counting, and its labels assume unread means
an unanswered inbound.

## 8. Non-goals

1. **Per-message unread.** Unread remains a per-conversation counter.
2. **Restoring the prior count** (an unread watermark).
3. **Reordering.** No `last_activity_at` write, no unread-first sort (D4).
4. **An optimistic-increment layer in `UnreadContext`.** The clear layer stays
   clear-only; the badge increment rides the SSE reconcile.
5. **Tour and placement conversation panes.** No ACTION there. Note this does
   not exempt them from the WRITE - see 10.3.
6. **Unmatched-email rows.** Separate unread model and badge; out of scope.
7. **Bulk mark-unread / multi-select.** One row at a time.
8. **Undo / toast.** The reverse action is on the row the operator lands on.
9. **Suppressing Today's "Unreplied" classification** (10.2) - it needs a marker
   attribute, i.e. a schema change.

## 9. Verification

### 9.1 Unit / integration (`npm test`)

Repo:
- `setUnread` sets `unread_count = 1` AND `unread_flag` on a READ thread.
- **`setUnread` REFUSES an already-unread thread** (condition clause 3): a
  thread at `unread_count = 5` throws and is left at 5. This replaces the
  earlier "idempotent to 1" assertion, which pinned the data loss as correct.
- `setUnread` throws `ConditionalCheckFailedException` for an unknown id.
- **The condition bites, all three buckets:** `{ bucket: 'relay_group' }`
  against a `closed` thread throws; `{ bucket: 'one_to_one' }` against a
  `closed` thread throws; `{ bucket: 'one_to_one' }` against a row whose `type`
  is `relay_group` throws; `{ bucket: 'relay_group' }` against an OPEN 1:1
  thread throws (the type clause added in 6.1 - without it this case would
  silently pass); and `{ bucket: 'group_text' }` accepts `group_open` while
  throwing on a row whose status is plain `open`. Do not skip `group_text` - it
  is the bucket whose contract changed most and the one with the odd status
  literal.
- Legacy row with NO `type` and status `open` is accepted under
  `{ bucket: 'one_to_one' }` (matches `isOneToOneBucket`'s negative test).
- **A thread with NO `unread_count` attribute at all is ACCEPTED.** The
  attribute is genuinely sparse (`unread_count?: number`,
  `conversationsRepo.ts:171`) - a thread that never received an inbound has
  never had it written. This pins the `attribute_not_exists(unread_count)` half
  of clause 3; a bare `unread_count = :zero` would 409 those threads forever,
  and nothing else in the suite would catch it.
- Round trip: `setUnread` then `queryUnreadPage` returns the row; `resetUnread`
  then `queryUnreadPage` does not.

Routes:
- `POST /api/conversations/:id/unread`: 200 + emitted `conversation.updated`;
  404 unknown; 409 for a CLOSED relay group; 409 for a 1:1 thread whose contact
  is soft-deleted; 200 for a `connecting` relay group and for a `group_open`
  group text.
- `POST /api/inbox/unread`: 400 bad/missing phone; 404 no conversation;
  **409 when the phone belongs to a soft-deleted contact** (the MU-2 gap review
  found); 409 when every candidate is ineligible; 200 flipping ONLY the newest
  eligible thread when the number owns several.
- `POST /api/inbox/:contactId/unread`: 404 unknown contact; 409 deleted contact;
  200 flipping ONLY the newest eligible thread across a phone+email union, with
  the OTHER threads asserted still at 0 (the D3 asymmetry with the read
  fan-out); **200 does NOT select an open relay group** even when the contact's
  record carries the pool number (the 6.2 filter).
- MU-1 as a property: for every route, a 200 response that WROTE implies the
  written row passes `isUnreadVisible`. (Scoped to the writing arm - the
  already-unread arm answers 200 with no written row, so the unscoped form the
  earlier draft carried is not a true statement.)
- **Condition-failure classification** (6.3), for every route: a conversation
  deleted between the route's read and its write answers 404 on the
  CONVERSATION route and a retryable 409 on the two fan-in routes (6.3 clause
  1); an already-unread
  thread answers 200 WITHOUT writing (assert the count is unchanged, not reset
  to 1, and that the response carries the real count); an ineligible
  type/status answers 409; and - the ORDER test - a thread that is BOTH
  ineligible AND unread (a closed relay group re-flagged by an inbound) answers
  409, not 200.

Dashboard:
- `InboxRow` renders "Mark unread" iff `unreadCount === 0`, never alongside
  "Mark read".
- `useInbox.markUnread`: per-kind endpoint dispatch, optimistic patch to 1,
  rollback on rejection, and `rollbackRowsCleared` called with the same key
  `markRead` would have used.
- Mark-read-then-mark-unread: assert `rollbackRowsCleared` was called with the
  right key. (Revised during plan review: an earlier draft demanded this be
  proved through the FETCH-GENERATION seam, but `useInbox.test.tsx` stubs
  `UnreadContext` wholesale by design, so that seam is not reachable from the
  file that owns this test. The spy assertion is what that file can actually
  prove; the generation behavior is `UnreadContext`'s own, already covered by
  `UnreadContext.test.tsx`.)
- The auto-read latch, TRIGGER path: with the contact page mounted, invoking the
  header action and then firing a `message.persisted` event does NOT issue
  `markInboxRead`. Same shape for the conversation page's mount-effect read.
- The auto-read latch, DRAIN path (the one that actually matters): with a mount
  fan-out still in flight, invoking the header action does not issue its POST
  until that request settles. Assert ORDER, not just absence - a trigger-only
  test stays green while the in-flight ordering bug ships.
- The latch is keyed, not per-mount: after a FAILED mark-unread on
  `/contacts/a`, a param change to `/contacts/b` DOES mark b read.
- The drain is BOUNDED: with an auto-read that never settles, the action still
  issues its POST after the timeout and the button shows a pending state
  meanwhile rather than appearing dead.
- `useInbox.markUnread` commits the SERVER's returned count, not 1: an
  already-unread thread answering 5 leaves the row showing 5.
- Neither header surface calls `noteRowsCleared` or `rollbackRowsCleared` -
  extend the existing regression spies rather than adding new ones.
- "Mark unread" navigates to `/inbox` on success and does NOT navigate on
  rejection; the conversation page action is absent for a closed relay group;
  the contact page action is absent for a soft-deleted contact.
- **The header TOGGLE (D6)**, on both surfaces:
  - at a live count of 0, "Mark unread" is shown and "Mark read" is absent;
    at a count > 0, the reverse. Assert BOTH directions, as on the row - an
    absence-only test goes vacuous rather than red.
  - the count is LIVE: a surface seeded at 0 that then receives an
    `onConversationUpdated` carrying `unread_count: 3` flips to "Mark read"
    WITHOUT a re-fetch. This is the assertion that proves the toggle is not
    reading the frozen mount value.
  - the conversation page seeds its count from the mount header and survives
    that field being absent (it is untyped, on an index signature) - an absent
    count is treated as 0, never as `NaN` or a crash.
  - the contact page treats a SKIPPED or FAILED mount fan-out as unknown and
    shows "Mark unread"; a successful fan-out shows "Mark unread"; an
    `onConversationUpdated` with `unread_count > 0` for one of the contact's
    timeline conversations flips it to "Mark read".
  - "Mark read" calls the EXISTING read endpoint and does NOT navigate.
- A `409 no_markable_thread` renders the retryable inline message and leaves the
  action available (the GSI-lag path, 6.3).
- The Unread truncation notice (7.4): renders when the server page is non-empty
  AND `truncated`; does NOT render on an untruncated page; does NOT render
  alongside the empty/error surface; and STAYS rendered after the operator marks
  every visible row read (the `serverRowCount`-not-`rows.length` gate - a test
  keyed on `rows` would pass while the regression it guards ships).

### 9.2 e2e (`npm run e2e`)

One spec, accessibility-first selectors, `lean` profile.

Starting state: lean seeds every conversation `unread_count: 0` on purpose
(`app/src/lib/seed/lean.ts:23-25`), so the spec must MANUFACTURE unread with the
fake-Twilio inbound fixture (`sendAsParty`, as `inbox-nav-badge.spec.ts` does)
rather than assuming a seeded unread thread.

**Anchoring:** an inbox row's count carries `aria-label="<n> unread"`
(`InboxRow.tsx:107-111`), the SAME accessible name as the nav badge
(`NavContents.tsx:66`). A bare `getByLabel('1 unread')` matches both and fails
strict mode - a trap the existing suite documents
(`inbox-nav-badge.spec.ts:15-21`). Address rows by href.

1. Drive an inbound to a seeded contact; open the row (which marks it read);
   return to the inbox and confirm no unread treatment on that row.
2. Reveal the row's actions, click "Mark unread"; assert the row (anchored by
   href) shows the unread treatment and a count of 1.
3. Switch to the Unread filter; assert the row is present.
4. From the contact page, open the actions kebab and click "Mark unread"
   (it is a menu item, not a bare header button - 7.3); assert the browser
   lands on the inbox with that row unread.

### 9.3 Gates

`npm run typecheck`, `npm test`, `npm run e2e` - bare, from
`W:\tmp\inbox-mark-unread`, per AGENTS.md.

## 10. Accepted boundaries and risks

### 10.1 The ~100-row cap (RULED at the human's spec gate: accepted)

All three unread surfaces read `byUnread` newest-`last_activity_at`-first
(`conversationsRepo.ts:1569-1581`) and cap at 100: `BADGE_COUNT_CAP`
(`unreadFeed.ts:55`), `SEEN_SET_MAX` (`inbox.ts:231`), `TODAY_UNREAD_CAP`
(`today.ts:179`). D4 forbids touching the timestamp, so a marked-unread thread
re-enters at its old position. Past the cap it contributes to none of the three
- i.e. the feature is weakest exactly on a backlogged inbox.

RULED at the spec gate: ACCEPTED, on the grounds that when a backlog exists the
newer unread genuinely is more pressing, so a capped to-do list is the right
product answer rather than a compromise. The precise shape matters and was
checked before ruling: the Unread PAGE is not a hard 100 - it pages 30 at a time
to ~120+ rows (`SEEN_SET_MAX` bounds cursor SIZE, a CloudFront URL limit, not
rows). Only the BADGE is a hard 100 floor. The acceptance was made conditional
on the list disclosing the cap, which is 7.4.

### 10.2 Today will label marked-unread threads "Unreplied"

`today.ts:794-826` groups every unread 1:1 as `why: 'Unreplied'`, and
`today.ts:769-793` groups unread unknowns as `why: 'New unknown contact'` with
`attention: true`. Neither consults message direction. Under the previous model
unread meant "inbound arrived and nobody looked", which made both labels true by
construction. Marking unread a thread the operator has already answered - the
archetypal case - therefore shows "Unreplied" on a shared board. Suppressing it
requires a marker attribute distinguishing marked-unread from inbound-unread,
i.e. a schema change (non-goal 9).

### 10.3 The flag is erased by any later incidental view

The read fan-out is CONTACT-WIDE (`inbox.ts:1661-1675`). The latch in 7.3
protects the visit in which the operator marks unread; it cannot protect later
ones. A second dashboard parked on that contact, or a later visit to that
person's tour or placement 1:1 tab (`ContactCommsTab`, which runs the same
fan-out and is mounted by `TourConversation.tsx:263` /
`PlacementConversation.tsx:260`), clears the to-do - and clears it for every
thread that contact owns, not just the flagged one. Making the flag survive that
requires per-thread read semantics, a different feature.

Two further readers inherit this without needing their own rule: the tour and
placement 1:1 tabs render unread dots off the same per-conversation count, so a
marked-unread thread simply shows as unread there (correct, and it is those same
tabs' auto-read that erases it); and `buildToday`'s client-side fallback carries
the same "Unreplied" phrasing as 10.2, though it is dead on the live server path.

### 10.4 Other watch items

- **Index residue (MU-1).** The reason the eligibility gate is a conditional
  write rather than a prior read (section 4). Attack this first in review.
- **The contact-delete race.** Section 4's residual paragraph: not closable by a
  condition on the conversation item. Probe + backfill are the mitigations.
- **Participant-GSI lag on the fan-in routes** (6.3). An open filed defect that
  this feature newly depends on for thread SELECTION rather than just fan-out.
  Accepted; the 409 is specified as retryable.
- **The auto-read drain** (7.3 part 2). The correctness of the whole
  thread-header surface rests on it, and a trigger-only test cannot see it.
- **`feat/call-inbox-unread` is unmerged and adjacent.** It makes inbound calls
  and voicemails mark threads unread, touching `incrementUnread` callers and
  `inbox.ts`. Different code paths, but expect a conflict window in `inbox.ts`
  and `conversationsRepo.ts`. Cut from `main`; report drift, do not chase it.

## 11. Post-merge obligations

None expected. No dependency, no schema, no GSI, no infrastructure, no
configuration, no backfill.
