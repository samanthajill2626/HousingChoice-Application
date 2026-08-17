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

The ask: mark a thread unread so it resurfaces as a to-do item. Exactly one
message's worth of unread - not a restoration of whatever the count used to be.

## 2. Goal

Give the operator a "Mark unread" action that flips one conversation to
`unread_count = 1`, so its inbox row shows the unread treatment, the row counts
toward the nav badge, and it appears under the Unread filter - reusing the
unread primitives merged 2026-08-17 (`feat/inbox-unread-index`) with no new
state model.

Two bounds on that goal, both established by review and both real:

- **The ~100-row cap (section 10.1).** All three unread surfaces are ordered
  newest-`last_activity_at`-first and capped at 100. Because D4 forbids touching
  the timestamp, a thread marked unread re-enters at its OLD position. On an
  inbox with more than ~100 newer unread rows it contributes to none of them.
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
  NOT sufficient on its own - see 7.3. The navigation is the UX; a minimal
  per-mount latch is the correctness mechanism.)
- **D3 - One thread, count 1.** A contact inbox row aggregates unread across
  every 1:1 thread the contact owns (phone and email). Marking unread flips
  exactly ONE conversation to `unread_count = 1` - the newest ELIGIBLE thread as
  defined in 6.2. Never a fan-out, never a restored prior count. (Revised by
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

- `{ bucket: 'relay_group' }` -> status must be `open` or `connecting`
- `{ bucket: 'group_text' }`  -> status must be `group_open`
- `{ bucket: 'one_to_one' }`  -> status must be `open`, and the row's `type`
  must be absent or NOT one of `relay_group` / `group_text`

Behavior:

- ONE `UpdateCommand`: `SET unread_count = :one, unread_flag = :flag` with
  `:one = 1` and `:flag = UNREAD_FLAG_VALUE`.
- `ConditionExpression`: `attribute_exists(conversationId)` AND the bucket's
  type/status predicate above. This is MU-1 as a WRITE condition - the whole
  point (section 4). A `ConditionalCheckFailedException` means "unknown or no
  longer eligible" and the route maps it to 409.
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

Both fan-in routes pick ONE thread. The candidate filter must be the INBOX
READER's filter verbatim, not `conversationsForContact`'s raw union -
`contactThreads.ts:13-15` states that callers keep their own status/type
filters, and the contact row's set is
`all.filter(c => c.status === 'open' && c.type !== 'relay_group')`
(`app/src/routes/inbox.ts:516-517`). Filtering on MU-1 alone would admit an OPEN
relay group, so a contact whose record carries a pool number could click their
CONTACT row and light up the RELAY GROUP row instead.

Selection rule: filter to threads that are `status === 'open'` and in the 1:1
bucket (`isOneToOneBucket`), then take the newest by `last_activity_at`,
mirroring `newestOf`'s strict `>` (`inbox.ts:526-532`) so ties resolve to
first-encountered in query order - the same thread the row itself previews.

### 6.3 New endpoints

Three, each mirroring an existing mark-read route so the client's kind-dispatch
stays symmetric.

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
4. `setUnread` with the bucket derived from the item's type. A
   `ConditionalCheckFailedException` here is the race MU-1 exists to stop ->
   also `409 thread_not_markable_unread`.
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
   the read routes), map a condition failure to 409, emit
   `conversation.updated`, respond `{ ok: true }`.

**`POST /api/inbox/:contactId/unread`** (same file). Used by contact rows and
the contact page.

1. `contacts.getById`; `404 contact_not_found` if absent.
2. MU-2: soft-deleted contact -> `409 contact_deleted`.
3. `conversationsForContact(contact, conversations)` for the phone+email union,
   then 6.2's selection; `409 no_markable_thread` if nothing survives.
4. `setUnread` on that ONE thread, map a condition failure to 409, emit
   `conversation.updated`, respond `{ ok: true }`.

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

**No client-side D5 guards on the row, deliberately.** Review established that
both proposed guards are unreachable: a `deleted: true` row is emitted only when
some thread is unread (`inbox.ts:786`, `:645-647`), and a CLOSED relay group is
never an inbox row at all because the relay source reads only the `open` and
`connecting` partitions (`inbox.ts:1396`). Both states are mutually exclusive
with `unreadCount === 0`, so a guard would be dead code and a test for it would
prove nothing. Carry a comment saying so, so nobody restores it. D5 on this
surface is enforced by the server.

`useInbox` gains `markUnread(row)`, the mirror of `markRead`:

- Bail if `row.unreadCount > 0`, or if the row is unaddressable (do not fake
  success).
- Resolve the call per KIND in ONE branch that also mints the badge key, the
  shape `markRead` uses: multi-party -> `markConversationUnread` +
  `conversationClearKey`; contact -> `markInboxUnread({ contactId })` +
  `contactClearKey`; by-phone -> `markInboxUnread({ phone })` + `phoneClearKey`.
- Optimistic patch `setPatch(key, { unreadCount: 1 })`, committed to `base` on
  success and dropped on failure, as `markRead` does.
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

Both surfaces follow D2 - `await` the POST, then `navigate('/inbox')`; on
failure stay put and surface the surface's existing inline error treatment.
Both are offered ONLY when the thread is currently read: `setUnread` is a `SET`,
so offering it at `unread_count = 5` would silently destroy a real count.

**The auto-read latch (D2, revised).** Navigating away is not sufficient on its
own. `useMarkContactRead.ts:20-50` fires uncancelled on mount, on
`visibilitychange`, and on EVERY org-wide `message.persisted` SSE event, with no
AbortController; `ConversationDetail.tsx:238-242` and `GroupTextView.tsx:259-263`
fire the same way from a mount effect. Unmounting stops future triggers, not one
already in flight or one that fires during the await - so the action would
intermittently no-op with a success response, the worst failure shape for a
to-do affordance.

Mechanism: each auto-read site gains a per-mount `suppressedRef`. The mark-unread
handler sets it BEFORE issuing the POST, and the auto-read callback returns early
while it is set. It is never cleared within the mount (the operator's explicit
action outranks every automatic trigger for the rest of the visit), and a fresh
mount starts clean - which is correct, because arriving at the thread again IS
reading it.

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

Both header actions also call `rollbackRowsCleared` for their key, for the 7.2
reason: on the contact page the mount fan-out has ALREADY marked the row read,
so a pending clear is typically outstanding at the moment the operator clicks.

### 7.4 Nav badge and Today

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
- `setUnread` sets `unread_count = 1` AND `unread_flag`, from a read thread and
  from an already-unread thread (idempotent to 1, never incremented).
- `setUnread` throws `ConditionalCheckFailedException` for an unknown id.
- **The condition bites:** `setUnread` with `{ bucket: 'relay_group' }` against
  a thread whose status is `closed` throws rather than writing. Same for
  `one_to_one` against a `closed` thread, and for a `one_to_one` bucket against
  a row whose `type` is `relay_group`. This is the MU-1 test that matters - the
  route-level pre-check cannot be trusted to prove it.
- Legacy row with NO `type` and status `open` is accepted under
  `{ bucket: 'one_to_one' }` (matches `isOneToOneBucket`'s negative test).
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
- MU-1 as a property: for every route, a 200 response implies the written row
  passes `isUnreadVisible`.

Dashboard:
- `InboxRow` renders "Mark unread" iff `unreadCount === 0`, never alongside
  "Mark read".
- `useInbox.markUnread`: per-kind endpoint dispatch, optimistic patch to 1,
  rollback on rejection, and `rollbackRowsCleared` called with the same key
  `markRead` would have used.
- Mark-read-then-mark-unread: assert the pending clear is purged by driving the
  FETCH-GENERATION seam (resolve a `getUnreadCount` and assert the displayed
  count), NOT a clock. A clock-driven test passes with or without the call.
- The auto-read latch: with the contact page mounted, invoking the header action
  and then firing a `message.persisted` event does NOT issue `markInboxRead`.
  Same shape for the conversation page's mount-effect read.
- Both header actions navigate to `/inbox` on success and do NOT navigate on
  rejection; both are absent when the thread is already unread; the conversation
  page action is absent for a closed relay group; the contact page action is
  absent for a soft-deleted contact.

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
4. From the contact page, click the header "Mark unread"; assert the browser
   lands on the inbox with that row unread.

### 9.3 Gates

`npm run typecheck`, `npm test`, `npm run e2e` - bare, from
`W:\tmp\inbox-mark-unread`, per AGENTS.md.

## 10. Accepted boundaries and risks

### 10.1 The ~100-row cap (raised to the human at the spec gate)

All three unread surfaces read `byUnread` newest-`last_activity_at`-first
(`conversationsRepo.ts:1569-1581`) and cap at 100: `BADGE_COUNT_CAP`
(`unreadFeed.ts:55`), `SEEN_SET_MAX` (`inbox.ts:231`), `TODAY_UNREAD_CAP`
(`today.ts:179`). D4 forbids touching the timestamp, so a marked-unread thread
re-enters at its old position. Past ~100 newer unread rows it contributes to
none of the three - i.e. the feature is weakest exactly on a backlogged inbox,
which is when a to-do affordance matters most. Consequence of an explicit human
ruling; stated here rather than engineered around.

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

### 10.4 Other watch items

- **Index residue (MU-1).** The reason the eligibility gate is a conditional
  write rather than a prior read (section 4). Attack this first in review.
- **The contact-delete race.** Section 4's residual paragraph: not closable by a
  condition on the conversation item. Probe + backfill are the mitigations.
- **`feat/call-inbox-unread` is unmerged and adjacent.** It makes inbound calls
  and voicemails mark threads unread, touching `incrementUnread` callers and
  `inbox.ts`. Different code paths, but expect a conflict window in `inbox.ts`
  and `conversationsRepo.ts`. Cut from `main`; report drift, do not chase it.

## 11. Post-merge obligations

None expected. No dependency, no schema, no GSI, no infrastructure, no
configuration, no backfill.
