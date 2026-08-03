# Deleted-contact resurfacing - design

Date: 2026-08-03
Status: approved (brainstormed with Cameron; decisions recorded below)

## Problem

Contact deletion is a soft delete (`deleted_at` stamp; `DELETE /api/contacts/:id`).
Phone/email routing deliberately ignores the stamp (`findByPhone` /
`findByEmail`), so an inbound message from a deleted contact is stored on their
existing conversation - no duplicate contact is created. But every surface that
would show the message filters deleted contacts out (inbox hydration, Today
boards), and no webhook is deleted-aware. Result: a deleted contact who texts,
emails, or calls us again is silently ignored. Staff delete contacts for
"done with this person" or "texted us by accident" reasons - not spam - so a
returning contact is signal, not noise, and must be surfaced.

## Decisions (operator-approved, 2026-08-03)

1. **Resurface the original conversation** in the inbox - never a fake
   "new contact" row. Routing already maps the sender to their record; staff
   should see who it is with full history.
2. **Manual restore-to-reply.** The resurfaced thread is fully readable
   (including the new message) with no restore required. The composer is locked
   while the contact is deleted, with a restore affordance in its place.
   Restoring is a deliberate human choice; replying requires it.
3. **Row lifecycle: visible only while an unread post-deletion inbound exists.**
   Reading the thread (which zeroes `unread_count`) re-hides the contact -
   accidental texters cost one glance and no cleanup. If staff meant to restore
   and forgot, the contact remains findable in Contacts > Deleted, and the row
   resurfaces on the next inbound.
4. **Today board stays deleted-blind.** The inbox is the surface for this.
5. **Calls are out of scope here.** Calls never bump unread or last-activity
   for ANY contact today (tracked in
   `docs/issues/inbound-calls-invisible-in-inbox.md`). Build order: this
   feature first, then the calls issue - once missed calls bump unread, the
   resurfacing rule below picks them up automatically.

## Backend

**Surfacing (read-time; no new writes, no new state).** In the inbox
aggregator's `rowForConversation` (app/src/routes/inbox.ts, currently
`if (isDeleted(contact)) return undefined` at ~line 410), replace the
unconditional hide with:

- Compute the contact's open conversations + `unreadSum` (the code below that
  line already does this for live contacts; deleted contacts now share it).
- Hide when `unreadSum === 0` (fast path - costs one conversations query for a
  deleted contact encountered in the walk, nothing more).
- Otherwise apply the freshness rule PER CONVERSATION: **surface only when SOME
  open conversation of the contact has `unread > 0` AND that conversation's
  latest message is inbound AND newer than `deleted_at`**. Only unread threads
  are probed, the newest conversation's latest message is already in hand for
  row rendering (so it is reused, never re-read), and the walk short-circuits on
  the first qualifying thread. `DerivedLatest` gains the latest message's
  `created_at` to make the comparison possible; an absent `created_at` (no
  readable message row) never counts as new.
- A surfaced row is the normal `kind:'contact'` row plus a new optional
  `deleted: true` field (API contract + dashboard types).

Notes:

- The newest-conversation dedup and paging bookkeeping (`emittedContacts`,
  newest-of guard) apply to surfaced deleted rows exactly as to live rows.
- Unread from BEFORE the deletion does not resurface (inbound predates
  `deleted_at`) - deleting draws a line under the current state.
- Filters: surfaced rows pass `all` and `unread` naturally; `needsTriage`
  semantics unchanged.
- Restore needs no new wiring: the stamp clears, `isDeleted` goes false, the
  row renders as a normal contact. SSE contact-deleted/restored events already
  trigger dashboard refetches.
- Multi-conversation contacts: the surfacing DECISION is per conversation (see
  the bullet above), so a newer thread that is outbound-only or empty no longer
  buries an older thread's unread post-deletion inbound, and pre-deletion unread
  on one thread no longer pins the row up after the fresh inbound on another was
  read. (This supersedes the originally accepted "newest thread can mask an
  older one" degradation.) What still derives from the NEWEST conversation is
  PRESENTATION only - preview, channel, direction and `lastActivityAt` - so an
  empty newest thread renders the fallback preview while an older thread is what
  earned the row.
- Perf: zero added cost for non-deleted rows; deleted contacts cost 1-2 extra
  queries only when encountered in the page walk. The pager remains
  O(page size), never a scan (see
  `docs/issues/inbox-filter-tabs-full-walk.md` for the pre-existing filter-tab
  tail, which this feature does not worsen).

**Send guard (belt and braces for the locked composer).** 1:1 sends to a
deleted contact are refused with a 409 (`contact_deleted` reason), mirroring
the existing opt-out refusal pattern, in the SMS and email send paths the
dashboard composer uses. Broadcast targeting already excludes deleted contacts
(`listByHousingAuthority` filter). Relay-group sends are out of scope here, but
note the blind spot: deletion does NOTHING to relay-group membership today (a
deleted member still receives group sends and their group texts still relay) -
tracked as its own decision in
`docs/issues/relay-groups-ignore-member-deletion.md`.

## Dashboard

- **InboxRow:** render a "Deleted" chip when `row.deleted` is true, using the
  row's existing chip vocabulary. Row otherwise normal (name, preview, unread
  badge, recency sort). Click-through goes to the contact page as usual.
- **ContactDetail:** the deleted banner + Restore button already exist
  (ContactDetail.tsx ~651). New: when deleted, the composer is replaced with a
  notice ("This contact is deleted - restore them to reply") plus a Restore
  button wired to the existing `onRestore`. `canSend` also gates on
  `!deleted` so no send path renders live.

## Testing

- **Unit (inbox aggregator):** deleted contact with an unread post-deletion
  inbound surfaces with `deleted: true`; zeroed unread (read) re-hides;
  unread that predates deletion stays hidden; restore clears the flag on the
  next build; non-deleted rows unaffected.
- **Unit (send guard):** 1:1 SMS and email sends to a deleted contact return
  409; restore un-blocks.
- **E2E:** delete a seeded contact, drive a fake-Twilio inbound, assert the
  inbox row appears with the Deleted chip; open the thread and assert the new
  message + banner are visible and the composer is locked; restore and reply
  successfully. Second path: read without restoring, assert the row re-hides.

## Build notes

- Feature branch + worktree (no work on main), per operator instruction.
- The e2e harness's dev endpoints (`/auth/dev-login`, `/__dev/outbox`,
  fake-Twilio inbound) cover the whole flow hermetically.
