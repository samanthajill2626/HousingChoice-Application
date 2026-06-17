# Inbox Frontend Implementation Plan (new dashboard `/inbox`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the entity-centric **Inbox** at `/inbox` in the `@housingchoice/dashboard` (:5174) workspace — one row per contact (or untriaged unknown number), filters, cursor paging, live updates, optimistic mark-read/assign, inline actions, and a live nav unread badge — replacing the current `Placeholder`, degrading honestly until the C8 backend lands.

**Architecture:** Mirror the existing surfaces (`today/`, `contacts/`). A data hook `useInbox(filter)` owns fetching/paging/optimistic-mutations/live-reconcile against the **C8 contract** (new `GET /api/inbox` + read/assign + the existing SSE stream). `Inbox.tsx` is the declarative page (header, filter tablist, list, states, Load more); `InboxRow.tsx` is the row + inline actions. A tiny app-level `UnreadProvider` feeds the nav badge from the same SSE stream. Verification is **unit tests only** (vitest) — no browser/e2e (deferred to a gated integration pass).

**Tech Stack:** React 19, react-router-dom, TypeScript strict (`noUncheckedIndexedAccess`), CSS Modules + `ui/tokens.css`, vitest + @testing-library/react (jsdom), the project's typed `request()` client and `useEventStream` SSE hook.

## Global Constraints

- **Contract = C8, verbatim.** Copy the C8 types (`InboxFilter`, `InboxChannel`, `InboxRow`, `InboxPage`) into `dashboard/src/api/types.ts` exactly as in `docs/superpowers/specs/2026-06-17-inbox-design.md` — do **not** invent, rename, or drop fields, and do **not** reuse `ConversationSummary`/`getConversations` for the inbox. New endpoints: `GET /api/inbox`, `POST /api/inbox/:contactId/read` (+ `POST /api/inbox/read {phone}` for unknowns), `POST /api/inbox/:contactId/assign {userId}`.
- **CSS Modules + design tokens only — NO hardcoded hex/px-colors.** Reuse/extend `dashboard/src/ui/tokens.css`. Existing tokens cover every need: accent (`--c-brand`), red count (`--c-danger` + `color-mix(... 12%, transparent)`, the Today `.urg` idiom), amber "Needs triage" chip (`--c-evt-amber-bg`/`-border`/`-text`), role dots (`--c-dot-tenant`/`-landlord`/`-unknown`), neutral chips (`--c-surface-2`/`--c-border`). Add a new token only if a real gap appears, and document it in `tokens.css`.
- **TypeScript strict + `noUncheckedIndexedAccess`.** Array index access is `T | undefined`; guard with `?? …`, `!`, or a check. No `any` (eslint `@typescript-eslint/no-explicit-any` is on) — use `unknown`. No unused vars/imports.
- **Tests use accessibility-first selectors** (`getByRole`/`getByLabel`/`findByRole`); assert navigation via `<Link>` `href`, never by mocking `useNavigate`. No `renderHook` — exercise hooks through a minimal `Probe` component. Mock the api barrel with `vi.mock('../../api/index.js', importActual-spread + override)`. Use `fireEvent` (NOT `@testing-library/user-event`, which is not a `dashboard` dependency). All in-repo import specifiers end in `.js`.
- **Copy/terminology:** human-facing copy says **"group text"**, never "relay"; tenant→"home", landlord/staff→"listing"; never "property". The Inbox copy here is contact/number-centric, so none of those nouns should appear — keep it clean.
- **Render user text safely:** `preview`/`name` render as React text children only. **Never** `dangerouslySetInnerHTML`.
- **No browser/e2e in this slice.** Autonomous verification = `npm test -w @housingchoice/dashboard`, `npm run typecheck -w @housingchoice/dashboard`, `npx eslint dashboard/`, `npm run build -w @housingchoice/dashboard`. All must be clean.

## Resolved decisions & contract notes (carry to the handoff summary)

1. **Live policy = debounced reconcile-refetch, not no-network patch-in-place.** The existing SSE `conversation.updated` event is **per-conversation and carries no `contactId`**, so it cannot soundly patch an *aggregated contact row*. The design spec authorizes treating "either event as 'something changed, reconcile'." So `useInbox` schedules a 300 ms debounced refetch of the current filter's first page on any `conversation.updated` (the proven `useToday` policy). **Contract note to flag:** true no-network patch-in-place (the spec's optimization) requires a **row-keyed `inbox.updated` SSE event** carrying the row key (contactId/phone) and the NEW aggregate `unreadCount`/`preview`/`lastActivityAt`/`assignment`. Recommend adding it to C8/BE7. Not a blocker; the reconcile path is correct today.
2. **Self-initiated mutations ARE optimistic** (we know the row key): mark-read and assign patch the row locally, are re-applied over a racing refetch while in flight, and **roll back on failure**.
3. **Type vs component name collision:** the C8 data type is `InboxRow`; the component is also `InboxRow` (`InboxRow.tsx`). Import the type aliased: `import type { InboxRow as InboxRowData } from '../../api/index.js'`.
4. **Row identity** `rowKey(row)` = `c:${contactId}` for contacts, `u:${phone}` for unknowns. Used for React keys, the optimistic patch map, and commit/rollback targeting.
5. **Navigation target:** contact rows → `/contacts/${contactId}`; unknown rows → `/contacts/unknown?phone=${encodeURIComponent(phone)}` (degrades to the existing Unknown list; deep-link is harmless and future-useful). Reply-box-not-auto-focused is a contact-page concern (out of scope here).
6. **Assign scope = "to me" / "unassign"** using the current user (`useAuth().me`). C8's assign takes a `userId`; an arbitrary-user picker needs a workspace-users list endpoint that is **not** in any contract — deferred. Optimistic assignment display name = the current user's email (`me.email`), reconciled to the server's `assignment.name` on the next fetch. **Contract note:** a users-list endpoint is required for assigning to someone other than yourself.
7. **Nav badge = count of unread rows**, owned by an app-level `UnreadProvider` that fetches `GET /api/inbox?filter=unread` and stays live via SSE (same mechanism as every other live surface). It is intentionally **not** cross-wired into `useInbox`'s optimistic state — one authoritative SSE-reconciled source avoids the divergent-count bug class. The first-page count is a soft cap; **contract note:** a lightweight unread-count (endpoint or response header) would make the badge exact beyond one page. Degrades to "no badge" on 404.
8. **"Filter counts" interpretation:** C8 returns no per-filter counts, so tabs carry **no numeric badges**. The state-sync requirement is satisfied by the **rendered list reconciling**: on the Unread filter, a row optimistically marked read drops out immediately and the "all caught up" empty state appears. If Cameron wants numeric tab counts, that needs a backend count contract — flag it.

---

## File structure

```
dashboard/src/api/types.ts                 (MODIFY) append the C8 block verbatim
dashboard/src/api/endpoints.ts             (MODIFY) add getInbox / markInboxRead / assignInbox
dashboard/src/routes/inbox/inboxFilters.ts (CREATE) filter tab model + empty-state copy
dashboard/src/routes/inbox/useInbox.ts     (CREATE) the data hook (fetch/filter/page/optimistic/live)
dashboard/src/routes/inbox/Inbox.tsx       (CREATE) the page (header, tablist, list, states, Load more)
dashboard/src/routes/inbox/Inbox.module.css(CREATE) page styles (tokens only)
dashboard/src/routes/inbox/InboxRow.tsx    (CREATE) the row + inline actions (hover/swipe)
dashboard/src/routes/inbox/InboxRow.module.css (CREATE) row styles (tokens only)
dashboard/src/app/UnreadContext.tsx        (CREATE) app-level unread-count provider for the nav badge
dashboard/src/app/nav.ts                    (MODIFY) NavLeaf gains badge?: 'inbox-unread'; tag the Inbox entry
dashboard/src/app/AppFrame.tsx              (MODIFY) NavLeafLink renders the badge from UnreadContext
dashboard/src/App.tsx                       (MODIFY) mount /inbox (Task 2) + wrap layout in UnreadProvider (Task 3)
+ matching *.test.ts(x) beside each new TS/TSX file
```

Test files: `inboxFilters.test.ts`, `useInbox.test.tsx`, `Inbox.test.tsx`, `InboxRow.test.tsx`, `UnreadContext.test.tsx`, plus additions to `App.test.tsx` / `AppFrame.test.tsx`.

---

## Task 1: Data layer (C8 contract + endpoints) + `useInbox` hook

**Files:**
- Modify: `dashboard/src/api/types.ts` (append the C8 block after the C6 block, ~line 557)
- Modify: `dashboard/src/api/endpoints.ts` (add the three inbox functions + their type imports)
- Create: `dashboard/src/routes/inbox/inboxFilters.ts`
- Create: `dashboard/src/routes/inbox/useInbox.ts`
- Test: `dashboard/src/routes/inbox/inboxFilters.test.ts`
- Test: `dashboard/src/routes/inbox/useInbox.test.tsx`

**Interfaces:**
- Consumes: `request` (client.ts), `ApiError`, `useEventStream` + `ConversationUpdatedEvent` (api barrel).
- Produces (later tasks rely on these EXACT names/types):
  - Types (from `api/index.js`): `InboxFilter = 'all'|'unread'|'unknown'|'mine'`, `InboxChannel = 'sms'|'mms'|'call'`, `InboxRow`, `InboxPage`.
  - Endpoints: `getInbox(params?: {filter?: InboxFilter; cursor?: string; limit?: number}, signal?) → Promise<InboxPage>`; `markInboxRead(target: {contactId: string} | {phone: string}, signal?) → Promise<void>`; `assignInbox(contactId: string, userId: string | null, signal?) → Promise<void>`.
  - `inboxFilters.ts`: `interface InboxFilterTab { filter: InboxFilter; label: string }`, `INBOX_FILTERS: InboxFilterTab[]`, `emptyCopy(filter: InboxFilter): { title: string; body: string }`.
  - `useInbox.ts`: `rowKey(row: InboxRowData): string`; `type InboxStatus = 'loading'|'pending'|'ready'|'error'`; `interface InboxState { status: InboxStatus; rows: InboxRow[]; hasMore: boolean; loadingMore: boolean; loadMore(): void; retry(): void; markRead(row): void; assign(row, userId: string|null, name: string): void }`; `useInbox(filter: InboxFilter): InboxState`.

- [ ] **Step 1: Append the C8 contract block to `types.ts`** (verbatim from the spec; match the file's `// --- Cn: … (§API Contract Cn) ---` comment style). Add at the end of the file:

```ts
// --- C8: Inbox feed (§API Contract C8) --------------------------------------
// Copied verbatim from the spec (2026-06-17-inbox-design.md §C8). The entity-
// centric inbox: ONE row per contact (or one untriaged unknown number),
// newest-activity-first, aggregating all of a contact's numbers. GET /api/inbox
// 404s until the BE7/C8 slice lands → useInbox degrades to an honest 'pending'.

export type InboxFilter = 'all' | 'unread' | 'unknown' | 'mine';
export type InboxChannel = 'sms' | 'mms' | 'call';

export interface InboxRow {
  kind: 'contact' | 'unknown';
  contactId?: string; // present when kind='contact'
  phone?: string; // E.164; the number (esp. for unknown rows)
  name: string; // contact name, or formatted number when unknown
  role?: 'tenant' | 'landlord' | 'unknown';
  caseContext?: { caseId: string; label: string }; // e.g. "Touring" — optional
  unreadCount: number; // aggregate across ALL of the contact's numbers
  preview: string; // latest item's text as a preview (UI shows one line, ellipsized)
  channel: InboxChannel; // channel of the latest item
  direction: 'inbound' | 'outbound'; // 'outbound' → render "You: …"
  lastActivityAt: string; // ISO; sort key (newest first)
  assignment?: { userId: string; name: string }; // the Assigned chip
  needsTriage: boolean; // true for untriaged unknowns
}

export interface InboxPage {
  rows: InboxRow[]; // newest-activity-first; ONE row per contact
  nextCursor: string | null;
}
```

- [ ] **Step 2: Add the inbox endpoints to `endpoints.ts`.** Extend the type-import block with `InboxFilter, InboxPage` (keep the list alphabetized: insert after `ContactType,`), then append this section at the end of the file:

```ts
// --- Inbox (/api/inbox) (§API Contract C8) ----------------------------------
// The entity-centric inbox feed + its read/assign mutations. GET 404s until the
// BE7/C8 backend slice lands → useInbox catches that and degrades to 'pending'.

/** GET /api/inbox — one page of inbox rows for a filter (newest-activity-first,
 *  one row per contact). Throws ApiError(404) until the backend slice lands. */
export function getInbox(
  params: { filter?: InboxFilter; cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<InboxPage> {
  return request<InboxPage>('/api/inbox', {
    query: { filter: params.filter, cursor: params.cursor, limit: params.limit },
    ...(signal !== undefined && { signal }),
  });
}

/** POST /api/inbox/:contactId/read (contact rows) — or POST /api/inbox/read
 *  { phone } (unknown rows, keyed by number) — mark the comms read. */
export function markInboxRead(
  target: { contactId: string } | { phone: string },
  signal?: AbortSignal,
): Promise<void> {
  if ('contactId' in target) {
    return request<void>(`/api/inbox/${encodeURIComponent(target.contactId)}/read`, {
      method: 'POST',
      ...(signal !== undefined && { signal }),
    });
  }
  return request<void>('/api/inbox/read', {
    method: 'POST',
    body: { phone: target.phone },
    ...(signal !== undefined && { signal }),
  });
}

/** POST /api/inbox/:contactId/assign { userId } — set (userId) or clear
 *  (userId=null) the contact row's assignment. */
export function assignInbox(
  contactId: string,
  userId: string | null,
  signal?: AbortSignal,
): Promise<void> {
  return request<void>(`/api/inbox/${encodeURIComponent(contactId)}/assign`, {
    method: 'POST',
    body: { userId },
    ...(signal !== undefined && { signal }),
  });
}
```

- [ ] **Step 3: Write `inboxFilters.ts`** (no test-first needed for the static model, but its test is Step 4):

```ts
// inboxFilters — the Inbox filter-tab model (tab order/labels) and the per-filter
// empty-state copy. Kept apart from the page so both are unit-testable in
// isolation. Filter values map 1:1 to the GET /api/inbox ?filter= query.
import type { InboxFilter } from '../../api/index.js';

export interface InboxFilterTab {
  filter: InboxFilter;
  label: string;
}

/** Tab order, left→right. 'all' is the default (first). */
export const INBOX_FILTERS: InboxFilterTab[] = [
  { filter: 'all', label: 'All' },
  { filter: 'unread', label: 'Unread' },
  { filter: 'unknown', label: 'Unknown' },
  { filter: 'mine', label: 'Assigned to me' },
];

/** The honest empty-state copy per filter (spec §States & mobile). */
export function emptyCopy(filter: InboxFilter): { title: string; body: string } {
  switch (filter) {
    case 'unread':
      return { title: "You're all caught up", body: 'Switch to All to browse.' };
    case 'unknown':
      return { title: 'No unknown numbers', body: 'Untriaged inbound numbers show up here.' };
    case 'mine':
      return { title: 'Nothing assigned to you', body: 'Rows you take ownership of show up here.' };
    case 'all':
      return {
        title: 'No conversations yet',
        body: 'Inbound texts and calls show up here.',
      };
  }
}
```

- [ ] **Step 4: Write + run `inboxFilters.test.ts`** (full code; expect PASS once Step 3 is in):

```tsx
import { describe, expect, it } from 'vitest';
import { INBOX_FILTERS, emptyCopy } from './inboxFilters.js';

describe('inboxFilters', () => {
  it('lists the four filters with All first (the default)', () => {
    expect(INBOX_FILTERS.map((t) => t.filter)).toEqual(['all', 'unread', 'unknown', 'mine']);
    expect(INBOX_FILTERS[0]?.label).toBe('All');
  });

  it('gives each filter distinct, non-empty empty-state copy', () => {
    const titles = INBOX_FILTERS.map((t) => emptyCopy(t.filter).title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const t of INBOX_FILTERS) {
      const c = emptyCopy(t.filter);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.body.length).toBeGreaterThan(0);
    }
  });

  it("the unread filter's copy points back to All", () => {
    expect(emptyCopy('unread').body).toMatch(/All/);
  });
});
```

Run: `npm test -w @housingchoice/dashboard -- inboxFilters` → Expected: PASS.

- [ ] **Step 5: Write the failing `useInbox.test.tsx`.** This is the slice's primary safety net — cover query mapping, ready/pending/error, pagination, optimistic mark-read (+commit, +rollback, +unread-filter drop), optimistic assign (+rollback), and SSE debounced reconcile/coalesce. Full code:

```tsx
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventStreamHandlers } from '../../api/index.js';
import { ApiError } from '../../api/index.js';
import type { InboxFilter, InboxPage, InboxRow } from '../../api/index.js';

const getInbox = vi.fn();
const markInboxRead = vi.fn();
const assignInbox = vi.fn();
let sse: EventStreamHandlers = {};

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getInbox: (...a: unknown[]) => getInbox(...a),
    markInboxRead: (...a: unknown[]) => markInboxRead(...a),
    assignInbox: (...a: unknown[]) => assignInbox(...a),
    useEventStream: (h: EventStreamHandlers) => {
      sse = h;
    },
  };
});

import { useInbox, rowKey } from './useInbox.js';

function mkRow(over: Partial<InboxRow> = {}): InboxRow {
  return {
    kind: 'contact',
    contactId: 'c1',
    name: 'Tasha Williams',
    unreadCount: 2,
    preview: 'Hi there',
    channel: 'sms',
    direction: 'inbound',
    lastActivityAt: '2026-06-17T10:00:00.000Z',
    needsTriage: false,
    ...over,
  };
}
function pageOf(rows: InboxRow[], nextCursor: string | null = null): InboxPage {
  return { rows, nextCursor };
}

// Minimal probe: render hook state + expose its actions as buttons we can click.
function Probe({ filter }: { filter: InboxFilter }): React.JSX.Element {
  const s = useInbox(filter);
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="count">{s.rows.length}</span>
      <span data-testid="unread">{s.rows.map((r) => r.unreadCount).join(',')}</span>
      <span data-testid="assigned">{s.rows.map((r) => r.assignment?.name ?? '-').join(',')}</span>
      <span data-testid="hasMore">{String(s.hasMore)}</span>
      <button onClick={() => s.loadMore()}>more</button>
      {s.rows.map((r) => (
        <span key={rowKey(r)}>
          <button onClick={() => s.markRead(r)}>read:{rowKey(r)}</button>
          <button onClick={() => s.assign(r, 'u9', 'Nav')}>assign:{rowKey(r)}</button>
          <button onClick={() => s.assign(r, null, '')}>unassign:{rowKey(r)}</button>
        </span>
      ))}
    </div>
  );
}

beforeEach(() => {
  getInbox.mockReset();
  markInboxRead.mockReset().mockResolvedValue(undefined);
  assignInbox.mockReset().mockResolvedValue(undefined);
  sse = {};
});
afterEach(() => vi.restoreAllMocks());

describe('useInbox', () => {
  it('passes the active filter as the ?filter= query and renders ready rows', async () => {
    getInbox.mockResolvedValue(pageOf([mkRow()]));
    render(<Probe filter="unread" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect((getInbox.mock.calls[0]?.[0] as { filter: InboxFilter }).filter).toBe('unread');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
  });

  it('degrades to pending (not error) when GET /api/inbox 404s', async () => {
    getInbox.mockRejectedValue(new ApiError(404, 'http_404', 'nope'));
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('pending'));
    expect(screen.getByTestId('count')).toHaveTextContent('0');
  });

  it('goes to error on a non-404 failure', async () => {
    getInbox.mockRejectedValue(new ApiError(500, 'http_500', 'boom'));
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
  });

  it('appends a page on loadMore and clears hasMore at the end', async () => {
    getInbox
      .mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], 'CUR'))
      .mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c2', lastActivityAt: '2026-06-17T09:00:00.000Z' })], null));
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('hasMore')).toHaveTextContent('true'));
    act(() => screen.getByRole('button', { name: 'more' }).click());
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
    expect(screen.getByTestId('hasMore')).toHaveTextContent('false');
    expect((getInbox.mock.calls[1]?.[0] as { cursor?: string }).cursor).toBe('CUR');
  });

  it('optimistically marks a row read and posts to the contact read endpoint', async () => {
    getInbox.mockResolvedValue(pageOf([mkRow({ contactId: 'c1', unreadCount: 3 })]));
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('3'));
    act(() => screen.getByRole('button', { name: 'read:c:c1' }).click());
    // Optimistic: unread drops to 0 immediately.
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('0'));
    expect(markInboxRead).toHaveBeenCalledWith({ contactId: 'c1' });
  });

  it('rolls back the optimistic mark-read when the request fails', async () => {
    getInbox.mockResolvedValue(pageOf([mkRow({ contactId: 'c1', unreadCount: 3 })]));
    markInboxRead.mockRejectedValue(new ApiError(500, 'http_500', 'no'));
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('3'));
    act(() => screen.getByRole('button', { name: 'read:c:c1' }).click());
    // Drops to 0 optimistically, then restores to 3 on failure.
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('3'));
  });

  it('drops a row out of the Unread filter the instant it is marked read', async () => {
    getInbox.mockResolvedValue(pageOf([mkRow({ contactId: 'c1', unreadCount: 1 })]));
    render(<Probe filter="unread" />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    act(() => screen.getByRole('button', { name: 'read:c:c1' }).click());
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
  });

  it('marks an unknown row read by phone', async () => {
    getInbox.mockResolvedValue(
      pageOf([mkRow({ kind: 'unknown', contactId: undefined, phone: '+15555550123', unreadCount: 1, needsTriage: true })]),
    );
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    act(() => screen.getByRole('button', { name: 'read:u:+15555550123' }).click());
    await waitFor(() => expect(markInboxRead).toHaveBeenCalledWith({ phone: '+15555550123' }));
  });

  it('optimistically assigns, posts userId, and rolls back on failure', async () => {
    getInbox.mockResolvedValue(pageOf([mkRow({ contactId: 'c1' })]));
    assignInbox.mockRejectedValueOnce(new ApiError(500, 'http_500', 'no'));
    render(<Probe filter="all" />);
    await waitFor(() => expect(screen.getByTestId('assigned')).toHaveTextContent('-'));
    act(() => screen.getByRole('button', { name: 'assign:c:c1' }).click());
    // Optimistic name shows, then rolls back to unassigned on failure.
    await waitFor(() => expect(screen.getByTestId('assigned')).toHaveTextContent('Nav'));
    await waitFor(() => expect(screen.getByTestId('assigned')).toHaveTextContent('-'));
    expect(assignInbox).toHaveBeenCalledWith('c1', 'u9');
  });

  it('refetches (coalesced) the current page on an SSE conversation.updated', async () => {
    getInbox.mockResolvedValue(pageOf([mkRow()]));
    render(<Probe filter="all" />);
    await waitFor(() => expect(getInbox).toHaveBeenCalledTimes(1));
    // Fire a burst — they coalesce into ONE debounced refetch.
    act(() => {
      sse.onConversationUpdated?.({
        conversationId: 'x',
        last_activity_at: '2026-06-17T11:00:00.000Z',
        unread_count: 1,
        type: 'tenant_1to1',
        assignment: null,
        participant_display_name: 'Tasha',
      });
      sse.onConversationUpdated?.({
        conversationId: 'y',
        last_activity_at: '2026-06-17T11:00:01.000Z',
        unread_count: 1,
        type: 'tenant_1to1',
        assignment: null,
        participant_display_name: 'Bo',
      });
    });
    await waitFor(() => expect(getInbox).toHaveBeenCalledTimes(2));
  });
});
```

Run: `npm test -w @housingchoice/dashboard -- useInbox` → Expected: FAIL (`useInbox` / `rowKey` not defined).

- [ ] **Step 6: Implement `useInbox.ts`** to pass:

```ts
// useInbox — owns the entity-centric inbox list for the active filter: the first
// page (GET /api/inbox), cursor "load more", optimistic mark-read / assign with
// rollback, and live updates. Degrades to an honest 'pending' state until the C8
// backend slice lands (GET /api/inbox 404s).
//
// Live-update policy: the SSE `conversation.updated` event is PER-CONVERSATION
// and carries no contactId, so it cannot soundly patch an aggregated CONTACT
// row. Per the design spec ("treat either event as 'something changed,
// reconcile'"), any inbox-affecting event schedules a debounced refetch of the
// current filter's first page — the proven useToday policy. A future row-keyed
// `inbox.updated` event would enable no-network patch-in-place (see the plan's
// contract notes). Self-initiated mark-read/assign ARE patched optimistically
// (we know the row), re-applied over a racing refetch while in flight, and
// rolled back on failure.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  assignInbox,
  getInbox,
  markInboxRead,
  useEventStream,
  type InboxFilter,
  type InboxRow as InboxRowData,
} from '../../api/index.js';

export type InboxStatus = 'loading' | 'pending' | 'ready' | 'error';

/** An in-flight optimistic mutation patch for one row (re-applied over refetches
 *  until the request settles). */
interface Pending {
  unreadCount?: number;
  assignment?: { userId: string; name: string } | null;
}

export interface InboxState {
  status: InboxStatus;
  rows: InboxRowData[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
  /** Optimistically mark a row's comms read (also called on row open). No-op if
   *  already read or the row can't be addressed. */
  markRead: (row: InboxRowData) => void;
  /** Optimistically set (userId) / clear (userId=null) a CONTACT row's
   *  assignment; `name` is the optimistic display name. No-op on unknown rows. */
  assign: (row: InboxRowData, userId: string | null, name: string) => void;
}

const PAGE_LIMIT = 30;
/** Debounce window (ms) for SSE-triggered reconcile-refetches — coalesces a
 *  burst of conversation.updated events into one refetch (matches useToday). */
const REFETCH_DEBOUNCE_MS = 300;

/** Stable identity for a row: contactId for contacts, phone for unknowns. */
export function rowKey(row: InboxRowData): string {
  return row.kind === 'contact' ? `c:${row.contactId ?? ''}` : `u:${row.phone ?? ''}`;
}

/** Newest-activity-first, matching the server's inbox ordering. */
function sortByActivity(rows: InboxRowData[]): InboxRowData[] {
  return [...rows].sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  );
}

export function useInbox(filter: InboxFilter): InboxState {
  const [status, setStatus] = useState<InboxStatus>('loading');
  const [base, setBase] = useState<InboxRowData[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // In-flight optimistic patches keyed by rowKey; re-applied over refetches.
  const [pending, setPending] = useState<Map<string, Pending>>(new Map());

  const abortRef = useRef<AbortController | null>(null);

  const fetchFirstPage = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const pageData = await getInbox({ filter, limit: PAGE_LIMIT }, controller.signal);
      if (controller.signal.aborted) return;
      setBase(pageData.rows);
      setCursor(pageData.nextCursor);
      setStatus('ready');
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        // C8 backend slice isn't live yet → honest pending state (not an error).
        setBase([]);
        setCursor(null);
        setStatus('pending');
        return;
      }
      setStatus('error');
    }
  }, [filter]);

  // Initial load + full reload whenever the filter changes.
  useEffect(() => {
    setStatus('loading');
    setBase([]);
    setCursor(null);
    setPending(new Map());
    void fetchFirstPage();
    return () => abortRef.current?.abort();
  }, [fetchFirstPage]);

  const retry = useCallback(() => {
    setStatus('loading');
    void fetchFirstPage();
  }, [fetchFirstPage]);

  const loadMore = useCallback(() => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    getInbox({ filter, limit: PAGE_LIMIT, cursor })
      .then((pageData) => {
        setBase((prev) => [...prev, ...pageData.rows]);
        setCursor(pageData.nextCursor);
      })
      .catch(() => {
        /* keep the cursor so the user can retry "Load more" */
      })
      .finally(() => setLoadingMore(false));
  }, [filter, cursor, loadingMore]);

  // --- SSE: debounced reconcile-refetch of the current filter's first page ---
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleRefetch = useCallback(() => {
    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = undefined;
      void fetchFirstPage();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchFirstPage]);

  useEffect(
    () => () => {
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    },
    [],
  );

  useEventStream({ onConversationUpdated: scheduleRefetch });

  // --- Optimistic mutations -------------------------------------------------
  const setPatch = useCallback((key: string, patch: Pending) => {
    setPending((prev) => {
      const next = new Map(prev);
      next.set(key, { ...next.get(key), ...patch });
      return next;
    });
  }, []);
  const clearPatch = useCallback((key: string) => {
    setPending((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const markRead = useCallback(
    (row: InboxRowData) => {
      if (row.unreadCount === 0) return;
      const key = rowKey(row);
      const target =
        row.kind === 'contact' && row.contactId !== undefined
          ? ({ contactId: row.contactId } as const)
          : row.phone !== undefined
            ? ({ phone: row.phone } as const)
            : undefined;
      if (target === undefined) return; // unaddressable → don't fake success
      setPatch(key, { unreadCount: 0 });
      markInboxRead(target)
        .then(() => {
          // Commit to base so clearing the patch doesn't reveal a stale count.
          setBase((prev) => prev.map((r) => (rowKey(r) === key ? { ...r, unreadCount: 0 } : r)));
        })
        .catch(() => {
          /* rollback: dropping the patch restores base's original count */
        })
        .finally(() => clearPatch(key));
    },
    [setPatch, clearPatch],
  );

  const assign = useCallback(
    (row: InboxRowData, userId: string | null, name: string) => {
      if (row.kind !== 'contact' || row.contactId === undefined) return;
      const key = rowKey(row);
      const optimistic = userId === null ? null : { userId, name };
      setPatch(key, { assignment: optimistic });
      assignInbox(row.contactId, userId)
        .then(() => {
          setBase((prev) =>
            prev.map((r) => (rowKey(r) === key ? { ...r, assignment: optimistic ?? undefined } : r)),
          );
        })
        .catch(() => {
          /* rollback */
        })
        .finally(() => clearPatch(key));
    },
    [setPatch, clearPatch],
  );

  // --- Assemble the displayed rows ------------------------------------------
  const patched = base.map((row) => {
    const p = pending.get(rowKey(row));
    if (p === undefined) return row;
    return {
      ...row,
      ...(p.unreadCount !== undefined && { unreadCount: p.unreadCount }),
      ...(p.assignment !== undefined && { assignment: p.assignment ?? undefined }),
    };
  });
  // On the Unread filter a row optimistically marked read drops out immediately,
  // so the list (and the "all caught up" empty state) stay in sync with the action.
  const visible = filter === 'unread' ? patched.filter((r) => r.unreadCount > 0) : patched;
  const rows = sortByActivity(visible);

  return { status, rows, hasMore: cursor !== null, loadingMore, loadMore, retry, markRead, assign };
}
```

- [ ] **Step 7: Run the hook + filter tests until green.**

Run: `npm test -w @housingchoice/dashboard -- inbox` → Expected: PASS (all `useInbox` + `inboxFilters` cases).
Also run the gates: `npm run typecheck -w @housingchoice/dashboard` and `npx eslint dashboard/src/routes/inbox dashboard/src/api` → Expected: clean.

- [ ] **Step 8: Commit.**

```bash
git add dashboard/src/api/types.ts dashboard/src/api/endpoints.ts dashboard/src/routes/inbox/inboxFilters.ts dashboard/src/routes/inbox/inboxFilters.test.ts dashboard/src/routes/inbox/useInbox.ts dashboard/src/routes/inbox/useInbox.test.tsx
git commit -m "feat(inbox): C8 contract + endpoints + useInbox hook (fetch/filter/page/optimistic/live)"
```

---

## Task 2: Inbox page + row + inline actions + route mount

**Files:**
- Create: `dashboard/src/routes/inbox/Inbox.tsx`, `Inbox.module.css`
- Create: `dashboard/src/routes/inbox/InboxRow.tsx`, `InboxRow.module.css`
- Modify: `dashboard/src/App.tsx` (add `'/inbox'` to `IMPLEMENTED`; import + mount `<Route path="inbox" element={<Inbox />} />`)
- Test: `dashboard/src/routes/inbox/InboxRow.test.tsx`, `dashboard/src/routes/inbox/Inbox.test.tsx`

**Interfaces:**
- Consumes: `useInbox`, `rowKey` (Task 1); `INBOX_FILTERS`, `emptyCopy` (Task 1); `InboxRow as InboxRowData`, `InboxChannel`, `InboxFilter` types; `Spinner` from `../../ui/index.js`; `useAuth` from `../../app/AuthContext.js` (for the current user → assign-to-me).
- Produces: `Inbox` (default page component, named export `Inbox`); `InboxRow` component with props `{ row: InboxRowData; currentUserId?: string; currentUserName: string; onOpen(row): void; onMarkRead(row): void; onAssign(row, userId: string|null, name: string): void }`.

- [ ] **Step 1: Write the failing `InboxRow.test.tsx`** (covers contact/unknown/assigned/read/unread/channel/direction variants, the link targets, the inline-action buttons, and "opening marks read"):

```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxRow as InboxRowData } from '../../api/index.js';
import { InboxRow } from './InboxRow.js';

function mkRow(over: Partial<InboxRowData> = {}): InboxRowData {
  return {
    kind: 'contact',
    contactId: 'c1',
    name: 'Tasha Williams',
    unreadCount: 2,
    preview: 'Is the 2BR still open?',
    channel: 'sms',
    direction: 'inbound',
    lastActivityAt: '2026-06-17T10:00:00.000Z',
    needsTriage: false,
    ...over,
  };
}

const onOpen = vi.fn();
const onMarkRead = vi.fn();
const onAssign = vi.fn();

function renderRow(row: InboxRowData): void {
  render(
    <MemoryRouter>
      <ul>
        <InboxRow
          row={row}
          currentUserId="me1"
          currentUserName="navi@example.com"
          onOpen={onOpen}
          onMarkRead={onMarkRead}
          onAssign={onAssign}
        />
      </ul>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  onOpen.mockReset();
  onMarkRead.mockReset();
  onAssign.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('InboxRow', () => {
  it('links a contact row to its contact page and shows name + preview', () => {
    renderRow(mkRow());
    const link = screen.getByRole('link', { name: /Tasha Williams/ });
    expect(link).toHaveAttribute('href', '/contacts/c1');
    expect(within(link).getByText(/Is the 2BR still open\?/)).toBeInTheDocument();
  });

  it('marks read when the row is opened (tap)', () => {
    renderRow(mkRow());
    fireEvent.click(screen.getByRole('link', { name: /Tasha Williams/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('prefixes outbound previews with "You:"', () => {
    renderRow(mkRow({ direction: 'outbound', preview: 'Sent you the flyer' }));
    expect(screen.getByText(/^You:/)).toBeInTheDocument();
  });

  it('shows an amber "Needs triage" chip on an unknown row and links to the triage list with the phone', () => {
    renderRow(
      mkRow({ kind: 'unknown', contactId: undefined, phone: '+15555550123', name: '(555) 555-0123', role: 'unknown', needsTriage: true }),
    );
    expect(screen.getByText(/Needs triage/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /555.*0123/ })).toHaveAttribute(
      'href',
      '/contacts/unknown?phone=%2B15555550123',
    );
  });

  it('shows the unread count and a Mark read action for unread rows', () => {
    renderRow(mkRow({ unreadCount: 3 }));
    expect(screen.getByText('3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /mark .* read/i }));
    expect(onMarkRead).toHaveBeenCalledTimes(1);
  });

  it('omits the Mark read action for already-read rows', () => {
    renderRow(mkRow({ unreadCount: 0 }));
    expect(screen.queryByRole('button', { name: /mark .* read/i })).not.toBeInTheDocument();
  });

  it('assigns to the current user from an unassigned contact row', () => {
    renderRow(mkRow({ assignment: undefined }));
    fireEvent.click(screen.getByRole('button', { name: /assign .* to me/i }));
    expect(onAssign).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'c1' }), 'me1', 'navi@example.com');
  });

  it('shows the Assigned chip and an Unassign action when assigned', () => {
    renderRow(mkRow({ assignment: { userId: 'me1', name: 'Navi' } }));
    expect(screen.getByText(/Navi/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /unassign/i }));
    expect(onAssign).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'c1' }), null, '');
  });

  it('offers no assign action on an unknown row (no contactId)', () => {
    renderRow(mkRow({ kind: 'unknown', contactId: undefined, phone: '+15555550123', name: '(555) 555-0123', needsTriage: true }));
    expect(screen.queryByRole('button', { name: /assign/i })).not.toBeInTheDocument();
  });

  it('shows a call channel label for call rows', () => {
    renderRow(mkRow({ channel: 'call', preview: 'Missed call' }));
    expect(screen.getByText(/call/i)).toBeInTheDocument();
  });
});
```

Run: `npm test -w @housingchoice/dashboard -- InboxRow` → Expected: FAIL (no `InboxRow`).

- [ ] **Step 2: Implement `InboxRow.tsx`.** The whole-row content is one `<Link>` (navigates + marks read on open); the action buttons are **siblings of** the Link (never nested inside the `<a>` — that would be invalid, inaccessible HTML), always present in the DOM (so keyboard/pointer users reach them; hover/`focus-within`/swipe only change their visibility). Pointer-swipe reveals the actions on touch; the buttons are the keyboard/pointer fallback.

```tsx
// InboxRow — one inbox row: a contact (or untriaged unknown number) aggregating
// its comms. The row body is a single Link (tap → contact page, and the page
// marks the comms read via onOpen); the Mark-read / Assign actions are SIBLINGS
// of the Link (never nested in the <a>), always in the DOM, revealed on hover /
// keyboard focus-within / swipe. Unread rows get a left accent bar, bold name +
// preview, and a red count. Unknown rows get an amber "Needs triage" chip and
// route to the triage list. No dangerouslySetInnerHTML — text renders as React
// children (XSS-safe).
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { InboxChannel, InboxRow as InboxRowData } from '../../api/index.js';
import styles from './InboxRow.module.css';

export interface InboxRowProps {
  row: InboxRowData;
  currentUserId?: string;
  currentUserName: string;
  onOpen: (row: InboxRowData) => void;
  onMarkRead: (row: InboxRowData) => void;
  onAssign: (row: InboxRowData, userId: string | null, name: string) => void;
}

const CHANNEL_LABEL: Record<InboxChannel, string> = {
  sms: 'Text',
  mms: 'Photo',
  call: 'Call',
};

/** The deep-link target: contact rows → the contact page; unknown rows → the
 *  Contacts ▸ Unknown triage list, deep-linked with the number. */
function hrefFor(row: InboxRowData): string {
  if (row.kind === 'contact' && row.contactId !== undefined) {
    return `/contacts/${row.contactId}`;
  }
  return `/contacts/unknown?phone=${encodeURIComponent(row.phone ?? '')}`;
}

export function InboxRow({
  row,
  currentUserId,
  currentUserName,
  onOpen,
  onMarkRead,
  onAssign,
}: InboxRowProps): React.JSX.Element {
  const unread = row.unreadCount > 0;
  const canAssign = row.kind === 'contact' && row.contactId !== undefined && currentUserId !== undefined;

  // Swipe-to-reveal (mobile). Keyboard/pointer users reach the same buttons via
  // Tab (focus-within reveals them in CSS); swipe is an ADDITIONAL affordance.
  const [revealed, setRevealed] = useState(false);
  const startX = useRef<number | null>(null);
  function onPointerDown(e: React.PointerEvent): void {
    startX.current = e.clientX;
  }
  function onPointerUp(e: React.PointerEvent): void {
    if (startX.current === null) return;
    const dx = e.clientX - startX.current;
    startX.current = null;
    if (dx <= -40) setRevealed(true);
    else if (dx >= 40) setRevealed(false);
  }

  return (
    <li
      className={`${styles.rowItem} ${revealed ? styles.revealed : ''}`}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <div className={`${styles.row} ${unread ? styles.unread : ''}`}>
        <Link className={styles.main} to={hrefFor(row)} onClick={() => onOpen(row)}>
          {row.role ? <span className={`${styles.dot} ${styles[`dot_${row.role}`] ?? ''}`} aria-hidden="true" /> : null}
          <span className={styles.head}>
            <span className={`${styles.name} ${unread ? styles.bold : ''}`}>{row.name}</span>
            <span className={styles.channel}>{CHANNEL_LABEL[row.channel]}</span>
            {row.caseContext ? <span className={styles.tag}>{row.caseContext.label}</span> : null}
            {row.needsTriage ? <span className={styles.triage}>Needs triage</span> : null}
            {row.assignment ? <span className={styles.assigned}>Assigned · {row.assignment.name}</span> : null}
          </span>
          <span className={`${styles.preview} ${unread ? styles.bold : ''}`}>
            {row.direction === 'outbound' ? `You: ${row.preview}` : row.preview}
          </span>
          {unread ? (
            <span className={styles.count} aria-label={`${row.unreadCount} unread`}>
              {row.unreadCount}
            </span>
          ) : null}
        </Link>

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
          ) : null}
          {canAssign ? (
            row.assignment ? (
              <button
                type="button"
                className={styles.action}
                onClick={() => onAssign(row, null, '')}
                aria-label={`Unassign ${row.name}`}
              >
                Unassign
              </button>
            ) : (
              <button
                type="button"
                className={styles.action}
                onClick={() => onAssign(row, currentUserId ?? '', currentUserName)}
                aria-label={`Assign ${row.name} to me`}
              >
                Assign to me
              </button>
            )
          ) : null}
        </div>
      </div>
    </li>
  );
}
```

- [ ] **Step 3: Write `InboxRow.module.css`** (tokens only). The unread accent bar uses `--c-brand`; the count uses the Today `.urg` red idiom; the triage chip uses the amber event tokens; role dots reuse the nav dot tokens. Actions are visually hidden until hover / `focus-within` / `.revealed`, but remain in the DOM and focusable.

```css
/* InboxRow — a contact/unknown comms row. All values from ui/tokens.css. */
.rowItem {
  list-style: none;
  margin-bottom: var(--sp-2);
}

.row {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}
.row:hover {
  border-color: var(--c-border-strong);
  box-shadow: var(--shadow-md);
}

/* Unread emphasis: a left accent bar. */
.unread {
  border-left: 3px solid var(--c-brand);
}

.main {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: var(--sp-3);
  min-width: 0;
  padding: var(--sp-3) var(--sp-4);
  text-decoration: none;
  color: inherit;
}
.main:focus-visible {
  outline: 2px solid var(--c-focus-ring);
  outline-offset: -2px;
}

.dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-pill);
  background: var(--c-text-subtle);
}
.dot_tenant {
  background: var(--c-dot-tenant);
}
.dot_landlord {
  background: var(--c-dot-landlord);
}
.dot_unknown {
  background: var(--c-dot-unknown);
}

.head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex: 0 0 auto;
}
.name {
  font-weight: var(--fw-medium);
  color: var(--c-text);
  white-space: nowrap;
}
.bold {
  font-weight: var(--fw-bold);
}
.channel {
  font-size: var(--fs-xs);
  color: var(--c-text-subtle);
}
.tag,
.assigned {
  padding: 1px var(--sp-2);
  border-radius: var(--radius-sm);
  background: var(--c-surface-2);
  border: 1px solid var(--c-border);
  color: var(--c-text-muted);
  font-size: var(--fs-xs);
  white-space: nowrap;
}
.triage {
  padding: 1px var(--sp-2);
  border-radius: var(--radius-sm);
  background: var(--c-evt-amber-bg);
  border: 1px solid var(--c-evt-amber-border);
  color: var(--c-evt-amber-text);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  white-space: nowrap;
}

.preview {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--c-text-muted);
  font-size: var(--fs-sm);
}

.count {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.25rem;
  padding: 0 var(--sp-2);
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--c-danger) 12%, transparent);
  color: var(--c-danger);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
}

/* Inline actions — present + focusable always; visible on hover / focus / swipe. */
.actions {
  display: flex;
  flex: 0 0 auto;
  gap: var(--sp-1);
  padding-right: var(--sp-3);
  opacity: 0;
  transition: opacity 0.12s ease;
}
.row:hover .actions,
.row:focus-within .actions,
.revealed .actions {
  opacity: 1;
}
.action {
  padding: var(--sp-1) var(--sp-2);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-text-muted);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  cursor: pointer;
}
.action:hover {
  border-color: var(--c-border-strong);
  color: var(--c-text);
}
.action:focus-visible {
  outline: 2px solid var(--c-focus-ring);
  outline-offset: 1px;
}
```

- [ ] **Step 4: Run `InboxRow` tests → green.**

Run: `npm test -w @housingchoice/dashboard -- InboxRow` → Expected: PASS.

- [ ] **Step 5: Write the failing `Inbox.test.tsx`** (drive the page through a mocked `useInbox`, like `Today.test.tsx` mocks `useToday`; also mock `useAuth`):

```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxRow as InboxRowData } from '../../api/index.js';
import type { InboxState } from './useInbox.js';

let state: InboxState;
const markRead = vi.fn();
const assign = vi.fn();
const loadMore = vi.fn();
const retry = vi.fn();

function baseState(over: Partial<InboxState> = {}): InboxState {
  return {
    status: 'ready',
    rows: [],
    hasMore: false,
    loadingMore: false,
    loadMore,
    retry,
    markRead,
    assign,
    ...over,
  };
}

vi.mock('./useInbox.js', async () => {
  const actual = await vi.importActual<typeof import('./useInbox.js')>('./useInbox.js');
  return { ...actual, useInbox: () => state };
});
vi.mock('../../app/AuthContext.js', () => ({
  useAuth: () => ({ me: { userId: 'me1', email: 'navi@example.com', role: 'va' } }),
}));

import { Inbox } from './Inbox.js';

function mkRow(over: Partial<InboxRowData> = {}): InboxRowData {
  return {
    kind: 'contact',
    contactId: 'c1',
    name: 'Tasha Williams',
    unreadCount: 2,
    preview: 'Hi',
    channel: 'sms',
    direction: 'inbound',
    lastActivityAt: '2026-06-17T10:00:00.000Z',
    needsTriage: false,
    ...over,
  };
}
function renderInbox(): void {
  render(
    <MemoryRouter>
      <Inbox />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  state = baseState();
  markRead.mockReset();
  assign.mockReset();
  loadMore.mockReset();
  retry.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('Inbox', () => {
  it('shows the Inbox heading and a spinner while loading', () => {
    state = baseState({ status: 'loading' });
    renderInbox();
    expect(screen.getByRole('heading', { level: 1, name: 'Inbox' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders the four filter tabs with All selected by default', () => {
    renderInbox();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows an honest pending state when the backend 404s', () => {
    state = baseState({ status: 'pending' });
    renderInbox();
    expect(screen.getByText(/backend|not.*available|turns on/i)).toBeInTheDocument();
  });

  it('shows an error message with a Retry button on error', () => {
    state = baseState({ status: 'error' });
    renderInbox();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('shows the All empty copy when ready with no rows', () => {
    state = baseState({ status: 'ready', rows: [] });
    renderInbox();
    expect(screen.getByText(/No conversations yet/i)).toBeInTheDocument();
  });

  it('renders rows and a Load more button when there is another page', () => {
    state = baseState({ rows: [mkRow()], hasMore: true });
    renderInbox();
    expect(screen.getByRole('link', { name: /Tasha Williams/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('switching to the Unread tab marks that tab selected', () => {
    renderInbox();
    fireEvent.click(screen.getByRole('tab', { name: 'Unread' }));
    expect(screen.getByRole('tab', { name: 'Unread' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opening a row calls markRead (opening marks read)', () => {
    state = baseState({ rows: [mkRow()] });
    renderInbox();
    fireEvent.click(screen.getByRole('link', { name: /Tasha Williams/ }));
    expect(markRead).toHaveBeenCalledTimes(1);
  });
});
```

Run: `npm test -w @housingchoice/dashboard -- Inbox.test` → Expected: FAIL (no `Inbox`).

- [ ] **Step 6: Implement `Inbox.tsx`.** Owns the filter state (`useState<InboxFilter>('all')`), renders the header + a `role="tablist"` of filter tabs, the states (loading/pending/error/empty/ready), the list, and Load more. Opening a row marks it read.

```tsx
// Inbox — the entity-centric communications hub (§2026-06-17-inbox-design). One
// row per contact (or untriaged unknown number), newest-activity-first, with All
// (default) / Unread / Unknown / Assigned-to-me filters. Opening a row navigates
// to the contact page AND marks its comms read (optimistic). Degrades to an
// honest pending state until the C8 backend lands. New design language (tokens +
// CSS Modules); state-sync handled in useInbox.
import { useState } from 'react';
import type { InboxFilter } from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { useAuth } from '../../app/AuthContext.js';
import { INBOX_FILTERS, emptyCopy } from './inboxFilters.js';
import { InboxRow } from './InboxRow.js';
import { rowKey, useInbox } from './useInbox.js';
import styles from './Inbox.module.css';

export function Inbox(): React.JSX.Element {
  const [filter, setFilter] = useState<InboxFilter>('all');
  const { me } = useAuth();
  const inbox = useInbox(filter);
  const empty = emptyCopy(filter);

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Inbox</h1>
      <p className={styles.sub}>Triage texts and calls — every row opens its contact.</p>

      <div className={styles.tabs} role="tablist" aria-label="Inbox filters">
        {INBOX_FILTERS.map((tab) => (
          <button
            key={tab.filter}
            type="button"
            role="tab"
            aria-selected={filter === tab.filter}
            className={`${styles.tab} ${filter === tab.filter ? styles.tabActive : ''}`}
            onClick={() => setFilter(tab.filter)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {inbox.status === 'loading' ? <Spinner center /> : null}

      {inbox.status === 'error' ? (
        <div className={styles.error} role="alert">
          <p>We couldn&apos;t load your inbox.</p>
          <button type="button" className={styles.retry} onClick={() => inbox.retry()}>
            Retry
          </button>
        </div>
      ) : null}

      {inbox.status === 'pending' ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>The inbox turns on with its backend</p>
          <p className={styles.emptyBody}>This view is wired and will fill in once the feed ships.</p>
        </div>
      ) : null}

      {inbox.status === 'ready' && inbox.rows.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{empty.title}</p>
          <p className={styles.emptyBody}>{empty.body}</p>
        </div>
      ) : null}

      {inbox.status === 'ready' && inbox.rows.length > 0 ? (
        <>
          <ul className={styles.rows} aria-label="Conversations">
            {inbox.rows.map((row) => (
              <InboxRow
                key={rowKey(row)}
                row={row}
                currentUserId={me?.userId}
                currentUserName={me?.email ?? 'You'}
                onOpen={inbox.markRead}
                onMarkRead={inbox.markRead}
                onAssign={inbox.assign}
              />
            ))}
          </ul>
          {inbox.hasMore ? (
            <button
              type="button"
              className={styles.loadMore}
              onClick={() => inbox.loadMore()}
              disabled={inbox.loadingMore}
            >
              {inbox.loadingMore ? 'Loading…' : 'Load more'}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 7: Write `Inbox.module.css`** (tokens only; the page/title/sub/empty/error mirror `Today.module.css`; the tablist is new):

```css
/* Inbox page — header, filter tablist, list, states. All values from tokens.css. */
.page {
  max-width: 880px;
}
.title {
  margin: 0;
  font-size: var(--fs-xl);
  font-weight: var(--fw-bold);
  color: var(--c-text);
  line-height: var(--lh-tight);
}
.sub {
  margin: var(--sp-1) 0 var(--sp-4);
  font-size: var(--fs-sm);
  color: var(--c-text-muted);
}

.tabs {
  display: flex;
  gap: var(--sp-2);
  margin-bottom: var(--sp-5);
  border-bottom: 1px solid var(--c-border);
}
.tab {
  padding: var(--sp-2) var(--sp-3);
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--c-text-muted);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  cursor: pointer;
}
.tab:hover {
  color: var(--c-text);
}
.tabActive {
  color: var(--c-brand);
  border-bottom-color: var(--c-brand);
}
.tab:focus-visible {
  outline: 2px solid var(--c-focus-ring);
  outline-offset: 2px;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.loadMore {
  display: block;
  width: 100%;
  margin-top: var(--sp-2);
  padding: var(--sp-3);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  background: var(--c-surface);
  color: var(--c-text-muted);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  cursor: pointer;
}
.loadMore:hover:not(:disabled) {
  border-color: var(--c-border-strong);
  color: var(--c-text);
}
.loadMore:disabled {
  cursor: default;
  opacity: 0.6;
}

.error {
  margin: var(--sp-4) 0;
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  background: var(--c-surface);
  color: var(--c-danger);
  font-size: var(--fs-sm);
}
.retry {
  margin-top: var(--sp-2);
  padding: var(--sp-1) var(--sp-3);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-surface);
  color: var(--c-text);
  font-size: var(--fs-sm);
  cursor: pointer;
}

.empty {
  margin-top: var(--sp-6);
  padding: var(--sp-6);
  text-align: center;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  background: var(--c-surface);
}
.emptyTitle {
  margin: 0 0 var(--sp-1);
  font-size: var(--fs-lg);
  font-weight: var(--fw-semibold);
  color: var(--c-text);
}
.emptyBody {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--c-text-muted);
}
```

- [ ] **Step 8: Mount the route in `App.tsx`.** Add the import `import { Inbox } from './routes/inbox/Inbox.js';` (beside the other route imports), add `'/inbox',` to the `IMPLEMENTED` set, and add an explicit route in the Communications position (after the `listings` route):

```tsx
{/* Communications ▸ Inbox (replaces the generated placeholder). */}
<Route path="inbox" element={<Inbox />} />
```

- [ ] **Step 9: Run the page tests + the existing `App.test.tsx` (placeholder count may assert) → green.**

Run: `npm test -w @housingchoice/dashboard -- "Inbox|App"` → Expected: PASS. If `App.test.tsx` asserts a specific set of placeholder routes, update that expectation to reflect `/inbox` now being a real route (mirror how `/listings` is treated).
Run the gates: `npm run typecheck -w @housingchoice/dashboard`, `npx eslint dashboard/src` → clean.

- [ ] **Step 10: Commit.**

```bash
git add dashboard/src/routes/inbox/Inbox.tsx dashboard/src/routes/inbox/Inbox.module.css dashboard/src/routes/inbox/Inbox.test.tsx dashboard/src/routes/inbox/InboxRow.tsx dashboard/src/routes/inbox/InboxRow.module.css dashboard/src/routes/inbox/InboxRow.test.tsx dashboard/src/App.tsx
git commit -m "feat(inbox): Inbox page + row + inline actions + filter tabs; mount /inbox"
```

---

## Task 3: Live nav unread badge

**Files:**
- Create: `dashboard/src/app/UnreadContext.tsx`, `dashboard/src/app/UnreadContext.test.tsx`
- Modify: `dashboard/src/app/nav.ts` (add `badge?: 'inbox-unread'` to `NavLeaf`; tag the Inbox entry)
- Modify: `dashboard/src/app/AppFrame.tsx` (render the badge from `useUnread()` on the tagged leaf)
- Modify: `dashboard/src/App.tsx` (wrap the authenticated layout element in `<UnreadProvider>`)
- Modify/add: `dashboard/src/app/AppFrame.test.tsx` (badge render test)

**Interfaces:**
- Consumes: `getInbox` (Task 1), `useEventStream`, `ApiError`.
- Produces: `UnreadProvider` (component) and `useUnread(): { unread: number | null }` (null = unknown/pending → no badge). `NavLeaf.badge?: 'inbox-unread'`.

- [ ] **Step 1: Write the failing `UnreadContext.test.tsx`:**

```tsx
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventStreamHandlers, InboxPage, InboxRow } from '../api/index.js';
import { ApiError } from '../api/index.js';

const getInbox = vi.fn();
let sse: EventStreamHandlers = {};

vi.mock('../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../api/index.js')>('../api/index.js');
  return {
    ...actual,
    getInbox: (...a: unknown[]) => getInbox(...a),
    useEventStream: (h: EventStreamHandlers) => {
      sse = h;
    },
  };
});

import { UnreadProvider, useUnread } from './UnreadContext.js';

function row(): InboxRow {
  return {
    kind: 'contact',
    contactId: 'c1',
    name: 'A',
    unreadCount: 1,
    preview: 'x',
    channel: 'sms',
    direction: 'inbound',
    lastActivityAt: '2026-06-17T10:00:00.000Z',
    needsTriage: false,
  };
}
function pageOf(n: number): InboxPage {
  return { rows: Array.from({ length: n }, row), nextCursor: null };
}
function Probe(): React.JSX.Element {
  const { unread } = useUnread();
  return <span data-testid="unread">{unread === null ? 'null' : String(unread)}</span>;
}
function renderProvider(): void {
  render(
    <UnreadProvider>
      <Probe />
    </UnreadProvider>,
  );
}

beforeEach(() => {
  getInbox.mockReset();
  sse = {};
});
afterEach(() => vi.restoreAllMocks());

describe('UnreadProvider', () => {
  it('fetches the unread feed and exposes the row count', async () => {
    getInbox.mockResolvedValue(pageOf(3));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('3'));
    expect((getInbox.mock.calls[0]?.[0] as { filter: string }).filter).toBe('unread');
  });

  it('exposes null (no badge) when the backend 404s', async () => {
    getInbox.mockRejectedValue(new ApiError(404, 'http_404', 'nope'));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('null'));
  });

  it('refetches on an SSE conversation.updated', async () => {
    getInbox.mockResolvedValueOnce(pageOf(1)).mockResolvedValueOnce(pageOf(5));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('1'));
    act(() => {
      sse.onConversationUpdated?.({
        conversationId: 'x',
        last_activity_at: '2026-06-17T11:00:00.000Z',
        unread_count: 1,
        type: 'tenant_1to1',
        assignment: null,
        participant_display_name: 'A',
      });
    });
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('5'));
  });
});
```

Run: `npm test -w @housingchoice/dashboard -- UnreadContext` → Expected: FAIL (no `UnreadProvider`).

- [ ] **Step 2: Implement `UnreadContext.tsx`:**

```tsx
// UnreadContext — the single, app-level source of truth for the nav Inbox unread
// badge. Fetches GET /api/inbox?filter=unread (one row per unread contact → the
// badge count) and stays live off the SSE stream (debounced reconcile-refetch,
// same policy as every other live surface). Independent of the Inbox page's
// useInbox so there is ONE authoritative count (no divergent-count bugs).
// Degrades to null (no badge) until the C8 backend lands.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiError, getInbox, useEventStream } from '../api/index.js';

interface UnreadValue {
  /** Count of unread rows, or null when unknown/pending (render no badge). */
  unread: number | null;
}

const UnreadCtx = createContext<UnreadValue>({ unread: null });
const REFETCH_DEBOUNCE_MS = 300;
const BADGE_LIMIT = 100;

export function UnreadProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [unread, setUnread] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchCount = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const page = await getInbox({ filter: 'unread', limit: BADGE_LIMIT }, controller.signal);
      if (controller.signal.aborted) return;
      setUnread(page.rows.length);
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      // 404 (slice not live) or any error → no badge rather than a wrong number.
      setUnread(null);
    }
  }, []);

  useEffect(() => {
    void fetchCount();
    return () => abortRef.current?.abort();
  }, [fetchCount]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleRefetch = useCallback(() => {
    if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = undefined;
      void fetchCount();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchCount]);

  useEffect(
    () => () => {
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current);
    },
    [],
  );

  useEventStream({ onConversationUpdated: scheduleRefetch });

  return <UnreadCtx.Provider value={{ unread }}>{children}</UnreadCtx.Provider>;
}

export function useUnread(): UnreadValue {
  return useContext(UnreadCtx);
}
```

- [ ] **Step 3: Run `UnreadContext` tests → green.**

Run: `npm test -w @housingchoice/dashboard -- UnreadContext` → Expected: PASS.

- [ ] **Step 4: Tag the Inbox nav entry.** In `nav.ts`, add to `NavLeaf`:

```ts
  /** Marks a leaf that renders a live count badge (resolved from context, not
   *  the static model). Currently only the Inbox unread count. */
  badge?: 'inbox-unread';
```

and change the Inbox entry to:

```ts
      { to: '/inbox', label: 'Inbox', icon: 'inbox', badge: 'inbox-unread' },
```

- [ ] **Step 5: Render the badge in `AppFrame.tsx`.** Import `useUnread`, read it inside `NavLeafLink`, and render a count when the leaf is tagged and the count is positive:

```tsx
import { useUnread } from './UnreadContext.js';
// ...
function NavLeafLink({ item }: { item: NavLeaf }): React.JSX.Element {
  const Icon = item.icon ? NAV_ICONS[item.icon] : undefined;
  const { unread } = useUnread();
  const badge = item.badge === 'inbox-unread' && unread !== null && unread > 0 ? unread : null;
  return (
    <NavLink to={item.to} end={item.end ?? false} className={linkClass}>
      {Icon ? (
        <span className={styles.icon}>
          <Icon />
        </span>
      ) : null}
      <span className={styles.linkLabel}>{item.label}</span>
      {badge !== null ? (
        <span className={styles.badge} aria-label={`${badge} unread`}>
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </NavLink>
  );
}
```

Add a `.badge` rule to `AppFrame.module.css` (tokens only — red count pill, pinned right):

```css
.badge {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.1rem;
  padding: 0 var(--sp-1);
  border-radius: var(--radius-pill);
  background: var(--c-danger);
  color: var(--c-text-inverse);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
}
```

(If `.linkLabel` doesn't already allow a trailing element to push right, the `margin-left:auto` on `.badge` handles it. Verify the nav link is `display:flex`; the existing `.link`/`.icon`/`.linkLabel` layout in `AppFrame.module.css` is flex — confirm and adjust only if needed, tokens only.)

- [ ] **Step 6: Wrap the authenticated layout in `UnreadProvider`.** In `App.tsx`, import `UnreadProvider` and wrap the `AppFrame` layout element so both the nav (badge) and the routed Inbox live under it:

```tsx
import { UnreadProvider } from './app/UnreadContext.js';
// ...
<Route
  element={
    <UnreadProvider>
      <AppFrame />
    </UnreadProvider>
  }
>
```

- [ ] **Step 7: Add an `AppFrame` badge test.** Append to `dashboard/src/app/AppFrame.test.tsx` (mock `useUnread`; if AppFrame tests already mock the api/auth, follow that file's existing setup — add only the badge assertions):

```tsx
// At the top, alongside the file's other vi.mock calls:
vi.mock('./UnreadContext.js', () => ({
  UnreadProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useUnread: () => ({ unread: 4 }),
}));

// In the describe block:
it('shows the Inbox unread badge from the unread provider', () => {
  // render AppFrame the same way the other tests in this file do (MemoryRouter +
  // the file's auth setup), then:
  expect(screen.getByLabelText('4 unread')).toBeInTheDocument();
});
```

Note: if `AppFrame.test.tsx` renders via `App` or a custom harness, match that harness exactly; the only new assertion is the badge `getByLabelText('4 unread')`. If mocking `useUnread` per-test is cleaner than the module mock, use `vi.spyOn` on the imported module instead — match the file's established style.

- [ ] **Step 8: Run the full dashboard suite + gates → green.**

Run: `npm test -w @housingchoice/dashboard` → Expected: PASS (all files).
Run: `npm run typecheck -w @housingchoice/dashboard` → clean.
Run: `npx eslint dashboard/` → clean.
Run: `npm run build -w @housingchoice/dashboard` → succeeds.

- [ ] **Step 9: Commit.**

```bash
git add dashboard/src/app/UnreadContext.tsx dashboard/src/app/UnreadContext.test.tsx dashboard/src/app/nav.ts dashboard/src/app/AppFrame.tsx dashboard/src/app/AppFrame.module.css dashboard/src/app/AppFrame.test.tsx dashboard/src/App.tsx
git commit -m "feat(inbox): live nav unread badge (UnreadProvider, SSE-fed, degrade-on-404)"
```

---

## Final whole-branch adversarial review

After all three tasks pass, run the adversarial whole-branch review (superpowers:requesting-code-review) with the mandate from the handoff §"Adversarial review": **state-sync / live-update correctness** (row + nav badge + filter list all reconcile after mark-read/assign/new-inbound), **SSE race conditions** (patch vs debounced refetch coalescing; stale-response clobber via the abort guard), **optimistic-update rollback** on failed mutation, **accessibility** (roles/labels/focus; the inline actions are reachable by keyboard, not nested in the `<a>`; swipe has a pointer/keyboard fallback), **mobile swipe** correctness, **contract drift vs C8** (field names/shapes verbatim), **XSS** in preview/name rendering (no `dangerouslySetInnerHTML`), and **terminology** ("relay"→"group text"; no "property"). Confirm each finding is real before fixing; drop pedantic ones. Then re-run all four gates.

---

## Self-review (run against the spec before execution)

- **Spec coverage:** rows-are-contacts ✓ (C8 `kind`/one-row-per-contact); opening→contact page, no reading pane/composer ✓ (`hrefFor` + `onOpen`); default All + Unread/Unknown/Mine ✓ (`INBOX_FILTERS`, `filter` query); unknowns inline w/ amber "Needs triage" ✓ (`InboxRow` triage chip); inline Mark-read/Assign hover+swipe ✓; opening marks read ✓; calls blend in ✓ (`channel`); cursor pagination ✓ (`loadMore`/`hasMore`); unread emphasis ✓ (accent bar + bold + red count); live updates ✓ (SSE reconcile); nav badge ✓ (`UnreadProvider`); empty/loading/error/pending states ✓; degrade-on-404 ✓. Non-goals respected (no reading pane/composer/triage UI/search). 
- **Placeholder scan:** none — every step has real code/commands.
- **Type consistency:** `InboxRow`(data) vs `InboxRow`(component) resolved via `InboxRowData` alias; `rowKey`, `InboxState`, `useInbox(filter)`, `getInbox/markInboxRead/assignInbox`, `INBOX_FILTERS/emptyCopy`, `UnreadProvider/useUnread`, `NavLeaf.badge` are used consistently across tasks.
- **Deferred (noted, not built):** `/inbox` browser e2e, live :5174 pass, comms round-trip rebuild — all to the gated integration pass. Contract flags: row-keyed `inbox.updated` SSE event; unread-count endpoint/header; workspace-users list for arbitrary assignment; numeric tab counts.
