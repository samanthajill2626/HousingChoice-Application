# Inbox: mark a thread unread - design spec

Date: 2026-08-17
Branch: `feat/inbox-mark-unread`  Worktree: `W:\tmp\inbox-mark-unread`
Base: `main` @aa62b493

## 1. Problem

An operator reads an inbox thread, decides it needs follow-up later, and has no
way to put it back. Once read, a thread has no to-do affordance: the unread
badge, the Unread filter, and the Today unread pass are all one-way (inbound
message sets unread, human attention clears it).

The ask: mark a thread unread again so it resurfaces as a to-do item. Exactly
one message's worth of unread - not a restoration of whatever the count used to
be.

## 2. Goal

Give the operator a "Mark unread" action that flips one conversation to
`unread_count = 1`, so its inbox row shows the unread treatment, the row counts
toward the nav badge, and it appears under the Unread filter and the Today
unread pass - reusing the unread primitives merged 2026-08-17
(`feat/inbox-unread-index`) with no new state model.

## 3. Locked decisions (human rulings, 2026-08-17)

- **D1 - Surfaces.** The action appears in TWO places: the inbox row (the
  hover/focus/swipe action strip that already hosts "Mark read"), and the
  header of the two thread destinations an inbox row opens - the contact page
  (`/contacts/:id`) and the conversation page (`/conversations/:id`).
- **D2 - Auto-read collision: navigate away.** The contact page marks every one
  of a contact's threads read on mount, on tab-visible, and on every persisted
  message; the relay-group view marks read on view. Rather than build a
  suppression flag, the thread-header action uses the Gmail model: mark unread,
  then navigate to `/inbox`. Leaving the page is what makes the flag stick.
  No suppression state is introduced anywhere.
- **D3 - One thread, count 1.** A contact inbox row aggregates unread across
  every 1:1 thread the contact owns (phone and email). Marking that row unread
  flips exactly ONE conversation to `unread_count = 1` - the contact's newest
  eligible thread, which is the thread the row already previews. From the
  contact page, the target is instead the thread the operator is actually
  viewing (the open channel tab's conversation). Never a fan-out, never a
  restored prior count.
- **D4 - Timestamps are not touched.** `last_activity_at` is never written by
  this feature. The row keeps its position in the All list; the badge, the
  Unread filter, and Today are the to-do surfaces. No presentation-level
  re-sorting of unread rows either.
- **D5 - Closed and deleted are out of bounds.** The action is not offered on a
  closed relay group or on a resurfaced soft-deleted-contact row, and the server
  refuses those targets. This preserves the two invariants ruled on 2026-08-16:
  a closed group can never sit unread-and-invisible in the `byUnread` index, and
  soft-deleting a contact draws a line under its unread.

## 4. The load-bearing invariant

`isUnreadVisible` (`app/src/lib/unreadFeed.ts`) is the single shared definition
of "unread the human should see" - used by the badge collector, the unread feed,
and Today. Every unread row that is NOT visible under it is index residue: it
sits in the sparse `byUnread` partition forever, costs scan budget on every
badge read, and is exactly the "residue wall" the previous mission spent three
fix waves bounding.

**INVARIANT MU-1.** A mark-unread write is permitted only on a conversation `c`
for which `isUnreadVisible({ ...c, unread_count: 1 })` is true. Concretely:
not a pointer-partition row; `relay_group` must be `open` or `connecting`;
`group_text` must be `group_open`; any other (1:1) type must be `open`.

**INVARIANT MU-2.** A mark-unread write is refused when the target thread's
contact is soft-deleted, whatever MU-1 says. `isUnreadVisible` does not know
about contacts; the deleted-contact resurfacing rule lives one layer up in
`collectUnreadRows`, and a marked-unread thread on a deleted contact would
either be invisible residue or would drag a deleted contact back into the
inbox. Both are wrong (D5).

Both invariants are enforced SERVER-SIDE. Client-side hiding of the action is a
usability measure, never the guarantee.

## 5. Data model

No schema change. No new attribute. No migration. No backfill.

The feature writes the two attributes the merged unread design already owns:
`unread_count` and the sparse GSI hash `unread_flag`.

## 6. Server design

### 6.1 New repo primitive

`ConversationsRepo.setUnread(conversationId): Promise<ConversationItem>`, beside
`incrementUnread` / `resetUnread` in `app/src/repos/conversationsRepo.ts`.

- ONE `UpdateCommand`: `SET unread_count = :one, unread_flag = :flag` with
  `:one = 1` and `:flag = UNREAD_FLAG_VALUE`.
- `ConditionExpression: attribute_exists(conversationId)`; throws
  `ConditionalCheckFailedException` for an unknown conversation, matching
  `resetUnread`.
- `ReturnValues: 'ALL_NEW'`.
- `SET`, not `ADD`: the count is deterministically 1 (D3), and the counter and
  the index hash ride ONE write so the row can never be unread-but-unindexed -
  the same property `incrementUnread` was built for.
- Logs `conversation unread set` at info, mirroring `resetUnread`.

`setUnread` performs NO eligibility checking. Like `queryUnreadPage`, it stays a
mechanical write; MU-1 and MU-2 are enforced by the route layer, which is where
the contact and status context lives.

### 6.2 New endpoints

Three, each the exact mirror of an existing mark-read route, so the client's
kind-dispatch stays symmetric.

**`POST /api/conversations/:conversationId/unread`** (`app/src/routes/api.ts`,
beside the existing `/read`). Used by relay-group rows, group-text rows, and
both thread-header surfaces.

1. Load the conversation; `404 conversation_not_found` if absent.
2. MU-1: if `isUnreadVisible({ ...conv, unread_count: 1 })` is false, respond
   `409 { error: 'thread_not_markable_unread' }`.
3. MU-2: for a 1:1 thread, resolve the participant's contact; if soft-deleted,
   respond `409 { error: 'thread_not_markable_unread' }`. A group thread has no
   single owning contact and skips this step.
4. `setUnread`, emit `conversation.updated` with
   `toConversationUpdatedEvent(conversation)`, respond `{ conversation }`.

**`POST /api/inbox/unread` `{ phone }`** (`app/src/routes/inbox.ts`, registered
BEFORE `/:contactId/unread`, mirroring the `/read` ordering note). Used by
unknown-number rows, which carry no contactId.

1. Same E.164 validation and `400` shapes as `POST /api/inbox/read`.
2. `findByParticipantPhone`; `404 no_conversation_for_phone` when empty.
3. Filter to MU-1-eligible threads; pick the newest by `last_activity_at`.
   `409 no_markable_thread` if none survive.
4. `setUnread` on that ONE thread (NOT a fan-out - this is the D3 asymmetry with
   the read routes, and it is deliberate), emit `conversation.updated`, respond
   `{ ok: true }`.

**`POST /api/inbox/:contactId/unread`** (same file). Used by contact rows.

1. `contacts.getById`; `404 contact_not_found` if absent.
2. MU-2: soft-deleted contact -> `409 contact_deleted`.
3. `conversationsForContact(contact, conversations)` for the phone+email union,
   filtered to MU-1-eligible threads; pick the newest by `last_activity_at`.
   `409 no_markable_thread` if none survive.
4. `setUnread` on that ONE thread, emit `conversation.updated`, respond
   `{ ok: true }`.

Note on step 3 in both fan-in routes: "newest eligible" must be computed from
the SAME candidate set the inbox row was built from, so the flagged thread is
the one the operator saw previewed. `conversationsForContact` is that set for
contacts (it is what the read fan-out uses), and `findByParticipantPhone` is it
for unknown numbers.

### 6.3 SSE

Every route emits `conversation.updated`, exactly as the mark-read routes do.
That is what makes other open dashboards, the nav badge (`UnreadContext`
reconcile), and the Today page pick the change up live. No new event type.

## 7. Client design

### 7.1 API client (`dashboard/src/api/endpoints.ts`)

Mirror the three existing functions:

- `markConversationUnread(conversationId, signal?)` -> `POST /api/conversations/:id/unread`
- `markInboxUnread({ contactId } | { phone }, signal?)` -> the two inbox routes

### 7.2 Inbox row (`InboxRow.tsx`, `useInbox.ts`)

`InboxRow` already renders an actions strip revealed on hover / focus-within /
swipe, containing "Mark read" when `unreadCount > 0`. Add the symmetric case:
when `unreadCount === 0`, render "Mark unread" in the same slot, with
`aria-label={`Mark ${row.name} unread`}`. Exactly one of the two actions is
present at any time.

Hidden per D5 when `row.deleted === true`, or when
`row.kind === 'relay_group' && row.status === 'closed'`.

`useInbox` gains `markUnread(row)`, built as the mirror of `markRead`:

- Bail if `row.unreadCount > 0`, if the D5 guards apply, or if the row is
  unaddressable (do not fake success).
- Resolve the call per KIND in ONE branch that also mints the badge key, the
  same shape `markRead` uses: multi-party -> `markConversationUnread` +
  `conversationClearKey`; contact -> `markInboxUnread({ contactId })` +
  `contactClearKey`; by-phone -> `markInboxUnread({ phone })` + `phoneClearKey`.
- Optimistic patch `setPatch(key, { unreadCount: 1 })`, committed to `base` on
  success and dropped on failure, exactly as `markRead` does.
- **Call `rollbackRowsCleared([clearKey])`, and do NOT call any "note set"
  counterpart.** This matters: `UnreadContext` holds a 10-second pending-CLEAR
  for a row the operator just marked read, and that clear subtracts from the
  badge. Marking the same row unread inside that window would otherwise leave
  the badge one below the truth until the TTL expired.
  `rollbackRowsCleared` purges the stale clear; the badge's own increment then
  arrives via the normal `conversation.updated` reconcile (~300ms debounce).
  No new optimistic-increment layer is added to `UnreadContext` - non-goal 4.

### 7.3 Thread headers

Two surfaces, per D1, both following the D2 model - `await` the POST, then
`navigate('/inbox')`; on failure stay put and surface the existing inline error
treatment for that surface.

- **Conversation page** (`/conversations/:id`, relay groups and group texts):
  a "Mark unread" header action. Hidden when the thread is a closed relay group
  (D5). Calls `markConversationUnread(conversationId)`.
- **Contact page** (`/contacts/:id`): a "Mark unread" action on the comms
  header. It targets the conversation of the OPEN channel tab (D3), so it calls
  `markConversationUnread(thatConversationId)` - not the contact fan-in route.
  Hidden when the contact is soft-deleted (D5), and when the open tab has no
  conversation yet.

Because the action navigates away, no auto-read suppression is needed: the
contact page's `useMarkContactRead` and the group view's on-view mark-read both
unmount before they can refire.

### 7.4 Nav badge and Today

No change to either. Both read the server's index-backed count, so a
mark-unread reaches them through `conversation.updated` for free. The only
client-side touch is the `rollbackRowsCleared` call in 7.2.

## 8. Non-goals

1. **Per-message unread.** There is no message-level read model, and none is
   introduced. Unread remains a per-conversation counter.
2. **Restoring the prior count** (an unread watermark). Explicitly rejected in
   brainstorming: meaningless after a couple of read/unread cycles.
3. **Reordering.** No `last_activity_at` write, and no unread-first sort in the
   inbox list (D4).
4. **An optimistic-increment layer in `UnreadContext`.** The clear layer stays
   clear-only; mark-unread relies on the SSE reconcile for the badge.
5. **Tour and placement conversation panes.** They are reached from a tour or
   placement workflow, not from the inbox, so D2's navigate-to-inbox would be
   wrong there and a stay-put variant would reopen the auto-read question.
6. **Unmatched-email rows.** They have a separate unread model
   (`POST /api/unmatched-email/:id/read`) and its own badge; out of scope.
7. **Bulk mark-unread / multi-select.** One row at a time.
8. **Undo / toast.** The reverse action ("Mark read") is already present on the
   row the operator lands on.

## 9. Verification

### 9.1 Unit / integration (`npm test`)

Repo:
- `setUnread` sets `unread_count = 1` AND `unread_flag`, from a read thread and
  from an already-unread thread (idempotent to 1, not incremented).
- `setUnread` throws `ConditionalCheckFailedException` for an unknown id.
- Round trip: `setUnread` then `queryUnreadPage` returns the row;
  `resetUnread` then `queryUnreadPage` does not.

Routes:
- `POST /api/conversations/:id/unread` 200 + emitted `conversation.updated`;
  404 unknown; 409 for a CLOSED relay group; 409 for a 1:1 thread whose contact
  is soft-deleted; 200 for a `connecting` relay group and a `group_open` group
  text (MU-1 admits both).
- `POST /api/inbox/unread` 400 bad/missing phone, 404 no conversation, 409 when
  every candidate is ineligible, 200 flipping ONLY the newest eligible thread
  when the number owns several.
- `POST /api/inbox/:contactId/unread` 404 unknown contact, 409 deleted contact,
  200 flipping ONLY the newest eligible thread across a phone+email union - and
  a case proving the OTHER threads stay at 0 (the D3 asymmetry with the read
  fan-out).
- MU-1 as a property: for every route, a 200 response implies the written row
  passes `isUnreadVisible`.

Dashboard:
- `InboxRow` renders "Mark unread" iff `unreadCount === 0`, and never alongside
  "Mark read"; hidden on a deleted row and on a closed relay-group row.
- `useInbox.markUnread`: per-kind endpoint dispatch, optimistic patch to 1,
  rollback on rejection, and `rollbackRowsCleared` called with the same key
  `markRead` would have used.
- Mark-read-then-mark-unread inside the pending-clear window leaves the badge
  at the server's number (the 7.2 regression).
- The two header actions call the conversation endpoint and navigate to
  `/inbox` on success; on rejection they do not navigate.

### 9.2 e2e (`npm run e2e`)

One spec, accessibility-first selectors, on the `lean` profile:

1. Open the inbox, open a contact row (which marks it read), return to the
   inbox, confirm the row shows no unread treatment.
2. Reveal the row's actions, click "Mark unread"; assert the row shows the
   unread treatment and a count of 1.
3. Switch to the Unread filter and assert the row is present.
4. From the contact page, click the header "Mark unread" and assert the browser
   lands on the inbox with that row unread.

### 9.3 Gates

`npm run typecheck`, `npm test`, `npm run e2e` - bare, from
`W:\tmp\inbox-mark-unread`, per AGENTS.md.

## 10. Risks and watch items

- **Index residue (MU-1).** The whole reason the eligibility check is
  server-side and shared with `isUnreadVisible` rather than re-derived. Any
  reviewer should attack this first.
- **Deleted-contact resurfacing.** A marked-unread thread on a live contact is
  fine; MU-2 keeps deleted contacts out. Note the existing resurfacing probe
  compares the thread's newest message `createdAt` against the deletion time, so
  even if MU-2 were bypassed the row would usually stay hidden - that is a
  second line of defense, not the guarantee.
- **The pending-clear window (7.2).** Called out because the badge's optimistic
  layer is subtract-only and this is the first feature that can move the count
  the other way.
- **`feat/call-inbox-unread` is unmerged and adjacent.** It makes inbound calls
  and voicemails mark threads unread, touching `incrementUnread` callers and
  `inbox.ts`. Different code paths, but expect a merge conflict window in
  `inbox.ts` and `conversationsRepo.ts`. Cut from `main`; report drift, do not
  chase it.
- **Route ordering.** `POST /api/inbox/unread` must be registered before
  `POST /api/inbox/:contactId/unread`, or the literal segment is swallowed by
  the parameter. Note that `/unread-count` already exists on this router.

## 11. Post-merge obligations

None expected. No dependency, no schema, no GSI, no infrastructure, no
configuration, no backfill.
