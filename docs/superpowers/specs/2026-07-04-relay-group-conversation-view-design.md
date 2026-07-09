<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-07-08).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Relay-group conversation view

**Date:** 2026-07-04
**Status:** Approved design, ready for implementation
**Branch:** `feat/relay-group-view` (worktree `w:/tmp/relay-group-view`)
**Author:** Claude (brainstormed with Cameron)

---

## 1. Problem

Relay groups (the masked group-text feature — several people share one pool number,
a message from one participant fans out to the others) have **no conversation view
anywhere in the dashboard**. Every path to "see the group thread" dead-ends:

- The contact-page **"Group texts" card** rows link to the group's *owner* page
  (`/tours/:id` / `/placements/:id`) or render unlinked — neither renders the thread.
- **Tour detail**'s *"View group thread"* link points at `/inbox`, which lists only
  per-contact rows and never shows a relay thread.
- **Timeline** milestone pins of type `conversation` link to `/conversations/:id` — a
  route that doesn't exist (falls through to "Not found").

Meanwhile the backend is essentially complete: a relay group **is a single
conversation** (`type: 'relay_group'`), and read/send/roster/close/read-marking APIs
all exist. The gap is a **frontend view** plus **one backend slice** (surfacing relay
groups in the Inbox feed).

## 2. Goal & scope

Build a **relay-group conversation view** where an operator can **read** the group
transcript, **reply** (fans out to all members), and **manage** the group (add/remove
members, close/reopen). Surface relay groups **in the Inbox** as a new row kind, and
repoint the dead links at the new view.

**Confirmed decisions (Cameron):**
- **Placement:** relay groups appear in the **Inbox** (new row kind) AND have a
  dedicated view. (Not a separate top-level index.)
- **Capabilities v1:** read + reply + manage (roster add/remove, close/reopen).
- **Route:** **`/conversations/:conversationId`** — matches the backend's already-
  conversation-generic namespace, future-proofs a possible relay→native-group-text
  change (no "relay" misnomer in the URL), and resolves the existing
  `/conversations/:id` milestone dead-link for free.
- **Add-member input:** contact-search-first, with a raw-phone fallback.

**Non-goals:** a top-level "all relay groups" index/nav item; changing the relay
backend/fan-out; a generic 1:1 standalone conversation page (1:1s stay on the contact
page — see §3 dispatch).

## 3. Route & page dispatch

New authenticated route `` <Route path="conversations/:conversationId" element={<ConversationDetail/>} /> `` in `dashboard/src/App.tsx`.

`ConversationDetail` fetches the conversation header (`GET /api/conversations/:id`) and
**dispatches by `type`**:
- `type === 'relay_group'` (and any future group type) → render the **group view**
  (§4–§6 below).
- a plain **1:1** conversation → **redirect** to its owning contact
  (`/contacts/:contactId`), because 1:1 threads live on the contact page. (Resolve the
  contactId from the conversation's participant/owner; if it can't be resolved, show a
  minimal "open on the contact" fallback rather than a broken pane.)
- not found / not authorized → the standard not-found treatment.

This keeps the generic URL honest without duplicating the 1:1 timeline.

## 4. Shell — reuse the ContactDetail responsive pattern

The group view **reuses the proven `ContactDetail` shell** (do not invent a new
responsive pattern): a dark header band over a two-pane body, with a segmented toggle
at narrow widths.

- **Extract the shared shell.** `ContactDetail.module.css` already encodes the whole
  behavior — `.body` flex two-pane (`.left` / `.right`), the `.segMobile` toggle
  (`display:none` wide → `display:flex` at `max-width:860px`), `.body` →
  `flex-direction:column` at ≤860px, and `paneActive`/`paneHidden` swapping which pane
  shows. Lift this into a shared shell (e.g. `dashboard/src/ui/TwoPaneDetail` or a
  shared CSS module) that both `ContactDetail` and `ConversationDetail` consume, so the
  layout/breakpoint live in one place. Keep `ContactDetail` visually identical.
  *Fallback:* if a clean extraction proves risky, cloning the CSS module into the group
  view is acceptable — note the duplication so it can be unified later.
- **Header band:** ← back · group identity (*"Group text — 123 Maple tour"* from the
  owner + members) · status pill (Open / Closed) · header actions (Add member ·
  Close/Reopen · ⋯). Actions wrap to their own row at ≤860px (as ContactDetail's do).
- **Segmented toggle (≤860px):** **"Conversation | Details"** (the analog of
  ContactDetail's "Comms | Profile"); leads with **Conversation**. `aria-pressed` on
  each button.
- **LEFT pane = Conversation** (§5). **RIGHT pane = Details cards** (§6). Panes scroll
  independently; `min-height:0` on the column layout so the composer stays reachable
  (same as ContactDetail).

## 5. LEFT pane — transcript + composer (reuse `Timeline`)

Reuse the existing `Timeline` component; it already renders relay annotations
(opted-out recipient counts, `added/removed_from_group_text` milestone pins,
`relay_closed` send-failure copy).

- **Data:** a new `useRelayThread(conversationId)` hook (analogous to
  `useContactTimeline`) → `GET /api/conversations/:id/messages?limit&before`, mapped to
  `TimelineItem[]`. Feed `Timeline` a **fixed `conversationId`**, bypassing
  `resolveSingleConversation` (which is 1:1-only) — the group view always knows its one
  conversation.
- **Attribution:** each bubble shows the sender by `relay_sender_key` → the member's
  name (roster lookup); team-authored messages (`relay_sender_key === 'team'`) render as
  the team/brand sender. Inbound vs outbound by `direction`.
- **Per-member delivery:** outbound/relayed bubbles show a **"delivered N/M"** summary
  derived from the message's `delivery_recipients` map (N terminal-delivered of M
  fanned-out); a failed leg surfaces like the existing failure affordance. (Extend
  `Timeline`'s existing relay-annotation rendering — it already computes `optedOutCount`.)
- **Composer:** posts a **team reply** via `POST /api/conversations/:id/messages`
  (backend detects `relay_group` → `sendRelayTeamMessage`, fans out to all members).
  Optimistic send reusing the Timeline's add/resolve/fail pattern. **Disabled when the
  group is `closed`** (with a "closed" hint), mirroring the 1:1 refusal affordance.
- **Mark-read:** on view, call `POST /api/conversations/:id/read` to zero the group's
  unread counter (direct per-conversation read; simpler than the contact fan-out read).

## 6. RIGHT pane — Details cards

Three cards, styled with the existing `Card`/`KV`/`Row` primitives:

- **Group** — pool number (formatted), **owner** (linked tour/placement), status
  (Open/Closed), tag if present. Source: the `GET /api/conversations/:id` header.
- **Members** — roster from `GET /api/conversations/:id/members` (`{ members:
  ConversationParticipant[] }`), each shown by name + role (role derived from the
  member's contact type). **+ Add member** → a **contact-search-first** input (reuse
  `ContactSearchField`, resolving `contactId` + phone) with a **raw-phone fallback**
  (reuse `normalizeToE164`) → `POST /api/conversations/:id/members`. Each member row is
  **removable** (× → confirm) → `DELETE /api/conversations/:id/members/:phone`. Optimistic
  update guarded by the roster's `participants_version` (the API already enforces it;
  surface a conflict by refetching).
- **Actions** — **Close group** (confirm dialog; note it *releases the pool number*) →
  `PATCH /api/conversations/:id/close`. When closed, **Reopen** (confirm; note it
  *provisions a fresh pool number and re-intros members*). Reuse the existing
  `Modal`/confirm pattern.

## 7. Inbox integration (the one backend slice)

**Backend — `app/src/routes/inbox.ts`:** extend the `GET /api/inbox` feed to also emit
**relay-group rows**. Relay groups are conversations carrying `last_activity_at`,
`status`, `unread_count`, `last_message_preview`, so add them to the assembled feed:
- New `InboxRow` kind **`'relay_group'`** with: `conversationId`, a label (other member
  names, else tag, else formatted pool number, else "Group text"), `last_message_preview`,
  `unread_count`, `status`, `owner`.
- Merge-sorted with the existing contact/unknown rows by `last_activity_at` (newest
  first), honoring the existing cursor/limit paging.
- **Filters:** appears in **All** and **Unread**; **not** in **Unknown** (that's for
  un-triaged numbers); in **Assigned-to-me** only if the conversation is assigned.
- Mark-read for a relay row uses the existing `POST /api/conversations/:id/read`.

**Frontend — `dashboard/src/routes/inbox/`:** `useInbox` + `InboxRow` gain the
`'relay_group'` kind: a group glyph + *"Group text · With Keisha, Lars"* + preview +
unread badge, linking to **`/conversations/:conversationId`**. Extend the inbox wire
types (`dashboard/src/api/types.ts`) accordingly.

## 8. Repoint the dead links

All three now target the real route:
- `dashboard/src/routes/contact/GroupTextsCard.tsx` `groupLink()` → **`/conversations/:conversationId`** (the row's own conversationId) instead of the owner page.
- `dashboard/src/routes/tours/TourDetail.tsx` *"View group thread"* → **`/conversations/:groupThreadId`** instead of `/inbox`.
- `dashboard/src/routes/contact/Timeline.tsx` `milestoneHref` `case 'conversation'` →
  already `/conversations/:refId`; **no change needed** once the route exists (verify it
  resolves).

## 9. Backend touch-points (summary)

Already exist — **no change**: `GET /api/conversations/:id`, `GET …/messages`,
`POST …/messages` (fans out), `POST …/read`, `GET …/members`, `POST/DELETE …/members`,
`PATCH …/close`.
**New — one slice:** relay-group rows in `GET /api/inbox` (`inbox.ts`). Phase 0 must
confirm the exact `GET /api/conversations/:id` response fields the Group card needs
(owner, pool_number, status, tag, memberCount) and add any missing one to that header or
the members response.

## 10. Testing

- **Unit (dashboard):** `ConversationDetail` dispatch (relay renders view; 1:1
  redirects); the group view panes; the relay `InboxRow`; roster add (contact + raw
  phone) / remove; close/reopen confirms; composer disabled when closed.
- **Unit (app):** the `/api/inbox` relay-row assembly + filter behavior.
- **E2E:** open a relay group **from the Inbox** and **from a contact's Group-texts
  card**; read the transcript; **post a team reply and assert the fan-out** in the
  fake-phones outbox (`GET /__dev/outbox`); add a member (contact search) and a member
  by raw phone; remove a member; close the group and confirm the composer disables.
  **Use the `app/src/lib/seed/live.ts` relay group** (`conv-live-relay-group`, pool
  `+15550160001`) — it has a well-formed `participants` roster. The `cast.ts` relay
  fixtures have malformed `participants` (bare id strings) and will not roster-match;
  do not rely on them for roster/inbox flows.
- Follow accessibility-first selectors (`getByRole`/`getByLabel`): segmented toggle
  `aria-pressed`, roster list `aria-label`, reply box `aria-label`, per
  `e2e/support/selectors.md`.

## 11. Risks

- **Extracting the ContactDetail shell** could regress the contact page's responsive
  behavior. Mitigation: extract conservatively (shared CSS module / thin wrapper), keep
  `ContactDetail` visually identical, and re-run its existing tests + a manual mobile
  eyeball.
- **Inbox feed merge** — folding a second row source into the paged/cursored feed must
  not break paging or double-count unread. Mitigation: unit-test the merge + filters;
  keep the existing contact-row path untouched.
- **1:1 redirect resolution** — a `conversation` id whose contact can't be resolved must
  degrade gracefully (fallback link), not crash the route.
- **Reply on a closed group / delivery-state races** — composer must hard-disable when
  closed; "delivered N/M" reads from the live `delivery_recipients` and should update as
  callbacks land (the thread already refetches).
