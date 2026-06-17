# Inbox — Design Spec (new dashboard, :5174)

**Status:** Design locked 2026-06-17 (brainstormed + approved). Feeds the
implementation plan (writing-plans next).

**Context:** The new entity-centric dashboard
([2026-06-16-new-dashboard-design.md](./2026-06-16-new-dashboard-design.md)) has
Today, Contact (Tenant/Landlord), and Listing surfaces built and merged. The
`/inbox` route currently renders a `Placeholder`. This spec designs the real Inbox.

**Principle (from the parent design):** the Inbox is a **secondary communications
hub — a lens**, not the center. Contacts and Cases are the spine; communications
always live in a contact's context. The Inbox is where you go to triage/clear the
comms backlog and is especially valuable on the mobile PWA. It must NOT become a
parallel thread-reading surface (the legacy app's drift we are explicitly avoiding).

---

## Locked decisions (the interaction model)

1. **Rows are contacts, not threads.** Each row represents one **contact** (or one
   **unknown number** that hasn't been triaged), aggregating all of that contact's
   phone numbers/conversations into a single row.
2. **Opening a row navigates to the contact page.** The full timeline + reply box
   already live there. There is **no in-inbox reading pane and no quick-reply
   composer**. The reply box on the contact page is **not auto-focused** (avoids
   popping the mobile keyboard).
3. **Full comms lens, default `All`.** The Inbox can show every contact with comms,
   newest-activity-first. The default filter is **All**; the operator flips to
   **Unread**, **Unknown**, or **Assigned to me** as needed.
4. **Unknowns are inline**, in activity order, with an amber **"Needs triage"** chip
   (not segregated to a separate list). They route to the contact/triage view.
5. **Inline actions: Mark read + Assign.** Revealed on **hover** (desktop) or by
   **swipe** (mobile). A plain tap always navigates. Quick-reply is intentionally
   omitted for now (easy to add later).
6. **Calls blend in** with texts as one comms stream (channel shown per row).

---

## Route & components

- Route `/inbox` (nav entry already exists; replaces `Placeholder`).
- `Inbox.tsx` — page shell: header (title + search-later), filter tabs, list,
  pagination, empty/loading/error states.
- `InboxRow.tsx` — the locked row + hover/swipe actions.
- `useInbox.ts` — owns the list: first page, cursor pagination, live updates,
  optimistic mark-read. (Models the proven legacy `useInbox` live-update policy.)
- `inboxFilters.ts` — filter-tab state + query mapping.

Follows the existing surface structure (Today/Contacts) and design system (dark nav,
CSS-module + design tokens — **no hardcoded hex**, "group text" not "relay").

---

## Data — Contract `C8 — Inbox feed` (backend handoff, "BE7")

Copied verbatim into both the frontend `api/types.ts` and the backend serializer
(same interlock rule as C1–C7). The frontend **degrades gracefully** (honest
empty/pending) until the slice ships.

```ts
export type InboxFilter = 'all' | 'unread' | 'unknown' | 'mine';
export type InboxChannel = 'sms' | 'mms' | 'call';

export interface InboxRow {
  kind: 'contact' | 'unknown';
  contactId?: string;          // present when kind='contact'
  phone?: string;              // E.164; the number (esp. for unknown rows)
  name: string;                // contact name, or formatted number when unknown
  role?: 'tenant' | 'landlord' | 'unknown';
  caseContext?: { caseId: string; label: string };  // e.g. "Touring" — optional
  unreadCount: number;         // aggregate across ALL of the contact's numbers
  preview: string;             // latest item's text as a preview (UI shows one line, ellipsized)
  channel: InboxChannel;       // channel of the latest item
  direction: 'inbound' | 'outbound';   // 'outbound' → render "You: …"
  lastActivityAt: string;      // ISO; sort key (newest first)
  assignment?: { userId: string; name: string };   // the Assigned chip
  needsTriage: boolean;        // true for untriaged unknowns
}

export interface InboxPage {
  rows: InboxRow[];            // newest-activity-first; ONE row per contact
  nextCursor: string | null;
}
```

Endpoints:
- `GET /api/inbox?filter=all|unread|unknown|mine&cursor=&limit=` → `InboxPage`.
  Server-side aggregation (one row per contact, cross-number unread) + cursor paging.
- `POST /api/inbox/:contactId/read` → marks the contact's comms read. (Unknown rows
  keyed by phone: `POST /api/inbox/read { phone }` — backend's call on keying.)
- `POST /api/inbox/:contactId/assign { userId }` → set/clear assignment.

The backend may implement these over existing conversation/assignment storage; the
**wire shape above is the contract**. Reuse existing read/assignment semantics where
present rather than inventing parallel state.

---

## Live updates & nav badge

- Reuse SSE via `useEventStream`. On an inbox-affecting event for a row **already in
  the list**, patch in place (preview / unreadCount / lastActivityAt / assignment)
  and re-sort newest-first — no network call. For an **unknown/new** row (not in the
  loaded pages), debounce-coalesce a first-page refetch and merge over the head.
  (This is the legacy `useInbox` policy, which is correct and battle-tested.)
- **Nav Inbox badge = total unread rows**, kept live off the same stream.
- Backend emits an inbox-affecting event (a dedicated `inbox.updated`, or the
  existing `conversation.updated` the frontend maps) — backend's call; the frontend
  treats either as "something changed, reconcile."

---

## Semantics

- **Tap row → contact page**, reply box NOT auto-focused.
- **Opening a row marks that contact's comms read** (optimistic), like a messages
  app; reconciled by the server. The explicit **Mark read** action does the same
  without opening.
- **Assign** sets the assignment (to me or another workspace user); the **Assigned**
  chip reflects it and updates live.
- **Unknown rows** route to the contact/triage view. The triage UI itself lives with
  **Contacts ▸ Unknown** (out of scope here); the Inbox only surfaces + links.
- **Filters:** All (default) · Unread · Unknown · Assigned-to-me. **Cursor
  pagination** ("Load more"). Sort: `lastActivityAt` desc.
- **Unread emphasis:** unread rows get bold preview + left accent bar + red count;
  read rows render lighter.

---

## States & mobile

- **Empty (All):** "No conversations yet — inbound texts and calls show up here."
- **Empty (Unread, caught up):** "You're all caught up — switch to All to browse."
- **Loading:** row skeletons.
- **Error:** message + **Retry**.
- **Mobile:** the same list, responsive; inline actions become **swipe-to-reveal**.
  Deep PWA polish (install, push, offline) stays in the later mobile phase.

---

## Testing

- `useInbox` unit tests: filter→query, pagination, live patch vs debounced refetch,
  optimistic mark-read + reconcile.
- `InboxRow` rendering across states (contact / unknown / assigned / read / unread /
  channel variants).
- **e2e on :5174:** dev-login → `/inbox` → rows render → tap a row → lands on the
  contact page. **This is where we rebuild the dropped backend comms coverage** —
  the standing TODO to re-establish SMS/MMS/voice/intake round-trip e2e against the
  new Inbox (deleted with the legacy specs in `40bd4f0`).

---

## Non-goals

- No in-inbox thread/reading pane; no quick-reply composer (reply is on the contact
  page).
- No triage UI in the Inbox (lives with Contacts ▸ Unknown).
- No search yet (placeholder only); no bulk actions; no saved/custom filters.

---

## Dependencies & sequencing

- **Backend:** the `C8` slice (`GET /api/inbox` + read/assign + the SSE event). Goes
  to the backend agent as a self-contained handoff (builder → reviewer → adversarial
  review), like BE1–BE6. Frontend ships against the contract and degrades until it
  lands.
- **Frontend:** route + components + `useInbox` + states + tests, orchestrated
  (builder → reviewer → adversarial review), live-verified on :5174.
- Mockups captured during brainstorming (ephemeral, gitignored under
  `.superpowers/brainstorm/`); the locked decisions are recorded in this spec.
