# Inbox — Design Spec (new dashboard, :5174)

**Status:** Design locked 2026-06-17. Backend **C8 complete + reviewed** on branch
`inbox-backend` (no schema change; 3 implementation flags surfaced + resolved here —
see Live updates / Semantics / Deferred); frontend in progress.

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
  assignment?: { userId: string; name: string };   // Assigned chip. NOTE: `name` may be an EMAIL today — UserItem has no display-name field (see Semantics / Deferred).
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
- `POST /api/inbox/:contactId/read` → marks the contact's comms read. **Unknown rows
  have no contactId — mark read via `POST /api/inbox/read { phone }`.**
- `POST /api/inbox/:contactId/assign { userId | null }` → set/clear assignment.
  **Contact rows only** — unknown rows are not assignable (you assign after triage).

The backend may implement these over existing conversation/assignment storage; the
**wire shape above is the contract**. Reuse existing read/assignment semantics where
present rather than inventing parallel state.

---

## Live updates & nav badge

- Reuse SSE via `useEventStream`, bound to the existing **`conversation.updated`**
  event (the backend reused it — no new event). **RESOLVED (C8):** the event carries
  `conversationId`, NOT `contactId`, and rows are contact-keyed — so surgical
  patch-in-place by row is not possible. The frontend treats every
  `conversation.updated` as "something changed → **debounced first-page refetch**"
  (coalesce bursts), which is the spec's blessed reconcile policy. (Per-contact
  patch-in-place is a future optimization needing `contactId` on the event — see
  Deferred.)
- **Nav Inbox badge = total unread rows**, kept live off the same stream (recomputed
  on refetch).

---

## Semantics

- **Tap row → contact page**, reply box NOT auto-focused.
- **Opening a row marks that contact's comms read** (optimistic), like a messages
  app; reconciled by the server. The explicit **Mark read** action does the same
  without opening.
- **Assign** sets the assignment (to me or another workspace user); the **Assigned**
  chip reflects it and updates live. The chip renders `assignment.name` (currently an
  **email** — UserItem has no name field; show **"You"** when it is the current
  user). A real display name is a tracked future enhancement (see Deferred).
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
- **Group texts (`relay_group`) are excluded from v1** (C8 `kind` is only
  `contact|unknown`). They WILL be added later — see Deferred / future.

---

## Deferred / future (tracked — do not lose)

- **Group texts in the Inbox — COMMITTED future work (Cameron: "we definitely want
  group texts included").** v1 excludes `relay_group` conversations because a group
  text has no single contact-row and no open-target yet (no group-conversation view;
  Cases page unbuilt). The intended treatment: a new `InboxRow` `kind: 'group'`
  opening to the related **Case**. Decide the exact shape when we design the **Cases
  pipeline**, then extend C8 with the new `kind`. Interim: group texts stay visible in
  legacy (:5173) until the new dashboard replaces it, so no coverage is lost meanwhile.
- **Real assignee display name.** Add a `name` attribute to `UserItem` (DynamoDB is
  schemaless — UserItem already has `[key]: unknown`, so NO table/GSI migration),
  sourced either from the Google **profile** name claim (needs `profile` added to the
  OAuth scope `'openid email'` + capture at activation; users re-consent on next
  login) or an **admin-entered** name at invite time. Email is the interim display.
  Non-blocking; the C8 wire shape (`assignment.name`) does not change either way.
- **Per-contact SSE patch-in-place.** Add `contactId` to `conversation.updated` to
  allow surgical row patching instead of debounced refetch (perf only, not needed at
  current scale).

## Dependencies & sequencing

- **Backend:** the `C8` slice (`GET /api/inbox` + read/assign + the SSE event). Goes
  to the backend agent as a self-contained handoff (builder → reviewer → adversarial
  review), like BE1–BE6. Frontend ships against the contract and degrades until it
  lands.
- **Frontend:** route + components + `useInbox` + states, orchestrated (builder →
  reviewer → adversarial review). Verified **autonomously with unit tests only** (no
  browser stack) — both worktrees defer the full browser hermetic stack to avoid the
  fixed-port collision.
- **Integration (gated):** after BOTH branches merge, the main session runs a single
  integration pass — the `/inbox` browser e2e, the live :5174 verification, and the
  SMS/MMS/voice/intake round-trip rebuild — **gated by the human's approval**. This
  is where the e2e (incl. the comms-coverage rebuild) actually lands.
- Mockups captured during brainstorming (ephemeral, gitignored under
  `.superpowers/brainstorm/`); the locked decisions are recorded in this spec.
