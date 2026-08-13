# Thread History Paging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff reach conversation history older than the newest 50 entries, on all five surfaces that render the shared `<Timeline>`.

**Architecture:** A "Load older messages" button lives in `Timeline.tsx` behind three optional props, so one control serves every surface. Three data hooks gain `hasOlder` / `loadingOlder` / `loadOlder()` and page backwards through capabilities the servers already expose (`before` for messages, `nextCursor` for the contact timeline). Every fetch MERGES by id instead of replacing state, which is what keeps a live SSE refetch from punching a hole in loaded history.

**Tech Stack:** React 19 + TypeScript, Vitest + Testing Library (dashboard unit tests), Playwright (e2e), Express + DynamoDB (backend, unchanged by this plan).

**Spec:** `docs/superpowers/specs/2026-08-13-thread-history-paging-design.md`

## Global Constraints

- **Frontend only.** No route, repo, or schema changes. `app/` is not modified.
- **ASCII-only** on every new or touched line (comments, test names, copy, commit messages).
- **Page size is 50** (`THREAD_PAGE_SIZE`), matching the server default.
- **Button copy is exactly `Load older messages`**; the in-flight label is exactly `Loading...`.
- **Accessibility-first selectors** in tests: `getByRole` / `getByLabel`, never CSS classes. See `e2e/support/selectors.md`.
- **Never pipe a gate command.** Run `npm run typecheck`, `npm test`, `npm run e2e` bare and inspect the captured output afterwards.
- **Commit discipline:** run a bare `git status` as its own command before every commit, then commit with an explicit pathspec (`git commit -F - -- <paths>`). Never `git add -A`. Every commit gets a `Co-Authored-By` trailer naming the authoring model.
- **Worktree:** all work happens in `W:\tmp\thread-history-paging` on branch `feat/thread-history-paging`. Copy `.claude\settings.local.json` into it immediately after creation, or a background agent will stall on a permission prompt no one answers.
- **Per-file test command:** `npm test -w @housingchoice/dashboard -- <path>` from the worktree root.

---

### Task 0: Create the worktree

**Files:**
- Create: `W:\tmp\thread-history-paging` (worktree, branch `feat/thread-history-paging`)

**Interfaces:**
- Consumes: nothing.
- Produces: the working directory every later task runs in.

- [ ] **Step 1: Create the worktree from main**

```powershell
git worktree add W:\tmp\thread-history-paging -b feat/thread-history-paging main
```

- [ ] **Step 2: Copy local Claude settings in**

```powershell
copy .claude\settings.local.json W:\tmp\thread-history-paging\.claude\settings.local.json
```

- [ ] **Step 3: Install dependencies**

Run from `W:\tmp\thread-history-paging`:

```powershell
npm install
```

- [ ] **Step 4: Confirm a clean baseline**

Run: `npm run typecheck`
Expected: PASS. If it fails, stop - the baseline is broken and nothing below is trustworthy.

---

### Task 1: Shared paging helpers

The merge rule is the heart of this change (spec section 4.1), so it gets its own module and its own tests before any hook consumes it.

**Files:**
- Create: `dashboard/src/routes/shared/threadPaging.ts`
- Test: `dashboard/src/routes/shared/threadPaging.test.ts`

**Interfaces:**
- Consumes: `TimelineItem` from `dashboard/src/api/index.js`.
- Produces:
  - `THREAD_PAGE_SIZE: 50`
  - `mergeTimelineItems(prev: TimelineItem[], incoming: TimelineItem[]): TimelineItem[]`
  - `oldestMessageId(items: TimelineItem[]): string | undefined`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/src/routes/shared/threadPaging.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '../../api/index.js';
import { mergeTimelineItems, oldestMessageId, THREAD_PAGE_SIZE } from './threadPaging.js';

function msg(id: string, at: string, status = 'delivered'): TimelineItem {
  return {
    kind: 'message',
    id,
    at,
    conversationId: 'c1',
    tsMsgId: id,
    direction: 'inbound',
    author: 'contact',
    type: 'sms',
    body: id,
    delivery_status: status,
  } as TimelineItem;
}

describe('THREAD_PAGE_SIZE', () => {
  it('matches the server default page size', () => {
    expect(THREAD_PAGE_SIZE).toBe(50);
  });
});

describe('mergeTimelineItems', () => {
  it('returns the incoming page when there is nothing held', () => {
    const incoming = [msg('b', '2026-08-13T10:00:00.000Z')];
    expect(mergeTimelineItems([], incoming)).toBe(incoming);
  });

  it('returns what is held when the incoming page is empty', () => {
    const prev = [msg('b', '2026-08-13T10:00:00.000Z')];
    expect(mergeTimelineItems(prev, [])).toBe(prev);
  });

  it('unions both sides and sorts oldest to newest', () => {
    const prev = [msg('b', '2026-08-13T10:00:00.000Z')];
    const incoming = [msg('a', '2026-08-13T09:00:00.000Z')];
    expect(mergeTimelineItems(prev, incoming).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('prefers the incoming copy for an id present on both sides', () => {
    const prev = [msg('a', '2026-08-13T09:00:00.000Z', 'queued')];
    const incoming = [msg('a', '2026-08-13T09:00:00.000Z', 'delivered')];
    const merged = mergeTimelineItems(prev, incoming);
    expect(merged).toHaveLength(1);
    expect((merged[0] as { delivery_status: string }).delivery_status).toBe('delivered');
  });

  // The gap bug this whole rule exists to prevent (spec 4.1): the newest page is
  // "the newest N", not a fixed window, so a shifted window must not drop the
  // entries that fell out of it.
  it('keeps entries that fell out of the shifted newest window', () => {
    const held = [
      msg('m1', '2026-08-13T09:00:00.000Z'),
      msg('m2', '2026-08-13T09:01:00.000Z'),
      msg('m3', '2026-08-13T09:02:00.000Z'),
    ];
    // A refetch whose window moved forward: m1 and m2 are no longer in it.
    const shifted = [msg('m3', '2026-08-13T09:02:00.000Z'), msg('m4', '2026-08-13T09:03:00.000Z')];
    expect(mergeTimelineItems(held, shifted).map((i) => i.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('sorts entries with no timestamp last', () => {
    const prev = [msg('a', '2026-08-13T09:00:00.000Z')];
    const incoming = [msg('z', '')];
    expect(mergeTimelineItems(prev, incoming).map((i) => i.id)).toEqual(['a', 'z']);
  });

  it('breaks ties by id so the order is deterministic', () => {
    const prev = [msg('b', '2026-08-13T09:00:00.000Z')];
    const incoming = [msg('a', '2026-08-13T09:00:00.000Z')];
    expect(mergeTimelineItems(prev, incoming).map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('oldestMessageId', () => {
  it('returns the tsMsgId of the first message item', () => {
    const items = [msg('a', '2026-08-13T09:00:00.000Z'), msg('b', '2026-08-13T10:00:00.000Z')];
    expect(oldestMessageId(items)).toBe('a');
  });

  it('returns undefined when there are no message items', () => {
    expect(oldestMessageId([])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @housingchoice/dashboard -- src/routes/shared/threadPaging.test.ts`
Expected: FAIL - cannot resolve `./threadPaging.js`.

- [ ] **Step 3: Write the implementation**

Create `dashboard/src/routes/shared/threadPaging.ts`:

```ts
// Paging helpers shared by the three thread hooks (useRelayThread,
// useGroupThread, useContactTimeline).
//
// WHY MERGE INSTEAD OF REPLACE: the newest page is "the newest N entries", not a
// fixed window. If the operator has loaded older pages and new messages then
// arrive, the refetched newest page no longer contains the entries that fell out
// of the window - and those entries are not in any older page either, because
// they were never fetched as one. Replacing state would leave a HOLE in the
// middle of the transcript. Merging by id cannot, because nothing already seen is
// ever dropped.
//
// Accepted consequence: an entry deleted server-side lingers in an open thread
// until the operator navigates away. Messages are not deleted in this product,
// and a stale-but-present bubble is a far smaller defect than a hole in a
// transcript.
import type { TimelineItem } from '../../api/index.js';

/** Page size for thread history reads - the server's own default (app/src/routes/api.ts). */
export const THREAD_PAGE_SIZE = 50;

/** Chronological order: oldest first, entries with no timestamp last, ties broken
 *  by id so a merged set has ONE deterministic order regardless of arrival. */
function compareItems(a: TimelineItem, b: TimelineItem): number {
  if (a.at !== b.at) {
    if (a.at === '') return 1;
    if (b.at === '') return -1;
    return a.at.localeCompare(b.at);
  }
  return a.id.localeCompare(b.id);
}

/**
 * Union `prev` and `incoming` by item id, preferring the INCOMING copy for any id
 * on both sides so a fresher delivery status wins. Returns chronological order.
 */
export function mergeTimelineItems(
  prev: TimelineItem[],
  incoming: TimelineItem[],
): TimelineItem[] {
  if (prev.length === 0) return incoming;
  if (incoming.length === 0) return prev;
  const byId = new Map<string, TimelineItem>();
  for (const item of prev) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort(compareItems);
}

/**
 * The `before` bound for the next older page: the tsMsgId of the OLDEST message
 * currently held. Items are chronological, so that is the first message item.
 * Undefined when nothing pageable is held yet.
 */
export function oldestMessageId(items: TimelineItem[]): string | undefined {
  for (const item of items) {
    if (item.kind === 'message') return item.tsMsgId;
  }
  return undefined;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @housingchoice/dashboard -- src/routes/shared/threadPaging.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

Run a bare `git status` first, as its own command. Then:

```bash
git commit -F - -- dashboard/src/routes/shared/threadPaging.ts dashboard/src/routes/shared/threadPaging.test.ts <<'EOF'
feat(threads): add merge-by-id paging helpers for thread history

mergeTimelineItems unions by id and prefers the fresher copy, so a live
refetch whose newest-N window has shifted forward cannot drop the entries
that fell out of it. Replacing state would leave a hole in the transcript.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: Give `getConversationMessages` paging parameters

**Files:**
- Modify: `dashboard/src/api/endpoints.ts:478-490`
- Modify: `dashboard/src/routes/conversation/useRelayThread.ts:197` (call site only)
- Modify: `dashboard/src/routes/conversation/useGroupThread.ts:128` (call site only)
- Modify: `dashboard/src/routes/contact/useContactTimeline.ts:181` (call site only)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `getConversationMessages(conversationId: string, opts?: { limit?: number; before?: string }, signal?: AbortSignal): Promise<Message[]>`

The signature moves to the `(id, opts, signal)` shape already used by `getTourActivity` (endpoints.ts:2291) and `getContacts` (endpoints.ts:292). This is a breaking signature change with exactly three non-test call sites; `tsc` rejects any missed one because `AbortSignal` is not assignable to the opts type.

- [ ] **Step 1: Rewrite the endpoint function**

Replace `dashboard/src/api/endpoints.ts:478-490` with:

```ts
/** GET /api/conversations/:id/messages - newest-first page of a conversation's
 *  messages (the contact timeline FALLBACK's source). The server wraps the page
 *  under { messages }; we unwrap it here so callers get a plain Message[].
 *
 *  `before` is an EXCLUSIVE tsMsgId bound and pages BACKWARDS (older), which is
 *  how the thread hooks reach history beyond the newest page. `limit` is
 *  1..MAX_PAGE_LIMIT (100); the server REJECTS anything outside that range with
 *  a 400 rather than clamping it. Omitted = 50. */
export async function getConversationMessages(
  conversationId: string,
  opts: { limit?: number; before?: string } = {},
  signal?: AbortSignal,
): Promise<Message[]> {
  const res = await request<{ messages: Message[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      query: { limit: opts.limit, before: opts.before },
      ...(signal !== undefined && { signal }),
    },
  );
  return res.messages;
}
```

- [ ] **Step 2: Run typecheck to find every call site**

Run: `npm run typecheck`
Expected: FAIL with three errors, one per call site, each reporting that `AbortSignal` is not assignable to `{ limit?: number; before?: string }`.

- [ ] **Step 3: Update the three call sites**

In `dashboard/src/routes/conversation/useRelayThread.ts`, change the call inside `fetchNow`:

```ts
        getConversationMessages(conversationId, {}, controller.signal),
```

In `dashboard/src/routes/conversation/useGroupThread.ts`, inside `fetchNow`:

```ts
      const messages = await getConversationMessages(conversationId, {}, controller.signal);
```

In `dashboard/src/routes/contact/useContactTimeline.ts`, inside the fallback assembly:

```ts
        messages: await getConversationMessages(c.conversationId, {}, signal),
```

These stay behaviorally identical (an omitted `limit` is the server's 50). Tasks 3-5 replace the empty opts with real paging.

- [ ] **Step 4: Run typecheck and the full unit suite**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm test`
Expected: PASS. Existing tests mock `getConversationMessages` with `(...a: unknown[])` spreads, so the extra argument does not break them.

- [ ] **Step 5: Commit**

Bare `git status` first, then:

```bash
git commit -F - -- dashboard/src/api/endpoints.ts dashboard/src/routes/conversation/useRelayThread.ts dashboard/src/routes/conversation/useGroupThread.ts dashboard/src/routes/contact/useContactTimeline.ts <<'EOF'
feat(api): add limit/before paging to getConversationMessages

The server has always supported both; the client function had no paging
parameters at all, so the capability was unreachable. Moves to the
(id, opts, signal) shape used by getTourActivity and getContacts.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: Page older history in `useRelayThread`

**Files:**
- Modify: `dashboard/src/routes/conversation/useRelayThread.ts`
- Create: `dashboard/src/routes/conversation/useRelayThread.test.tsx`

**Interfaces:**
- Consumes: `THREAD_PAGE_SIZE`, `mergeTimelineItems`, `oldestMessageId` from `../shared/threadPaging.js`; `getConversationMessages(id, opts, signal)` from Task 2.
- Produces: three new members on `RelayThreadState`, the same three every other hook exposes:
  - `hasOlder: boolean`
  - `loadingOlder: boolean`
  - `loadOlder: () => Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/src/routes/conversation/useRelayThread.test.tsx`:

```tsx
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../api/index.js';

const getConversationMessages = vi.fn();
const getConversationScheduled = vi.fn();
let lastHandlers: { onMessagePersisted?: () => void } = {};

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getConversationMessages: (...a: unknown[]) => getConversationMessages(...a),
    getConversationScheduled: (...a: unknown[]) => getConversationScheduled(...a),
    useEventStream: (handlers: typeof lastHandlers) => {
      lastHandlers = handlers;
    },
  };
});

import { useRelayThread } from './useRelayThread.js';

function message(id: string, at: string): Message {
  return {
    conversationId: 'c1',
    tsMsgId: id,
    provider_ts: at,
    direction: 'inbound',
    author: 'contact',
    type: 'sms',
    body: id,
    delivery_status: 'delivered',
  } as Message;
}

/** A full page of `count` messages ending at `endMinute`, newest first. */
function page(count: number, startMinute: number): Message[] {
  return Array.from({ length: count }, (_, i) =>
    message(
      `m${startMinute + count - 1 - i}`,
      `2026-08-13T10:${String(startMinute + count - 1 - i).padStart(2, '0')}:00.000Z`,
    ),
  );
}

function Probe(): React.JSX.Element {
  const { status, items, hasOlder, loadingOlder, loadOlder } = useRelayThread('c1');
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="ids">{items.map((i) => i.id).join(',')}</span>
      <span data-testid="hasOlder">{String(hasOlder)}</span>
      <span data-testid="loadingOlder">{String(loadingOlder)}</span>
      <button type="button" onClick={() => void loadOlder()}>
        load older
      </button>
    </div>
  );
}

beforeEach(() => {
  getConversationMessages.mockReset();
  getConversationScheduled.mockReset().mockResolvedValue({ scheduled: [] });
  lastHandlers = {};
});

describe('useRelayThread paging', () => {
  it('reports hasOlder when the first page comes back full', async () => {
    getConversationMessages.mockResolvedValue(page(50, 0));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('hasOlder')).toHaveTextContent('true');
  });

  it('reports no older history when the first page is short', async () => {
    getConversationMessages.mockResolvedValue(page(3, 0));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('hasOlder')).toHaveTextContent('false');
  });

  it('requests the older page with a before bound and prepends it', async () => {
    getConversationMessages.mockResolvedValueOnce(page(50, 10)); // m10..m59
    getConversationMessages.mockResolvedValueOnce(page(2, 8)); // m8, m9
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });

    expect(getConversationMessages).toHaveBeenLastCalledWith(
      'c1',
      { limit: 50, before: 'm10' },
      expect.anything(),
    );
    await waitFor(() =>
      expect(screen.getByTestId('ids')).toHaveTextContent(/^m8,m9,m10/),
    );
    expect(screen.getByTestId('hasOlder')).toHaveTextContent('false');
  });

  // The gap bug (spec 4.1) at the hook level.
  it('keeps loaded older history when a live refetch shifts the newest window', async () => {
    getConversationMessages.mockResolvedValueOnce(page(50, 10)); // m10..m59
    getConversationMessages.mockResolvedValueOnce(page(2, 8)); // older: m8, m9
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent(/^m8,m9,m10/));

    // A new message arrives: the newest-50 window slides forward to m12..m61,
    // so m10 and m11 are no longer in it.
    getConversationMessages.mockResolvedValueOnce(page(50, 12));
    await act(async () => {
      lastHandlers.onMessagePersisted?.();
      await vi.advanceTimersByTimeAsync?.(400);
    });

    await waitFor(() => {
      const ids = screen.getByTestId('ids').textContent ?? '';
      expect(ids).toContain('m8,m9,m10,m11,m12'); // no hole
      expect(ids).toContain('m61'); // the new tail landed
    });
  });

  it('does not start a second older fetch while one is in flight', async () => {
    getConversationMessages.mockResolvedValueOnce(page(50, 10));
    let release: (v: Message[]) => void = () => {};
    getConversationMessages.mockReturnValueOnce(
      new Promise<Message[]>((resolve) => {
        release = resolve;
      }),
    );
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
      screen.getByRole('button', { name: 'load older' }).click();
    });
    expect(screen.getByTestId('loadingOlder')).toHaveTextContent('true');
    expect(getConversationMessages).toHaveBeenCalledTimes(2); // first page + ONE older

    await act(async () => {
      release([]);
    });
    await waitFor(() => expect(screen.getByTestId('loadingOlder')).toHaveTextContent('false'));
  });
});
```

Note on the SSE test: `useRelayThread` debounces refetches by 300ms. If the suite does not already run with fake timers, replace the `vi.advanceTimersByTimeAsync` line with `await new Promise((r) => setTimeout(r, 350))` and keep the assertion identical.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @housingchoice/dashboard -- src/routes/conversation/useRelayThread.test.tsx`
Expected: FAIL - `hasOlder`, `loadingOlder`, and `loadOlder` do not exist on `RelayThreadState`.

- [ ] **Step 3: Extend the state interface**

In `dashboard/src/routes/conversation/useRelayThread.ts`, add to `RelayThreadState` (after `upcomingTimezone`, before `addOptimistic`):

```ts
  /** Older history exists beyond the oldest entry currently held.
   *
   *  HEURISTIC, not an authoritative flag. GET /api/conversations/:id/messages
   *  returns a bare array with no `hasMore`, so a FULL page is read as "there is
   *  probably more". On a thread whose length is an exact multiple of the page
   *  size this shows the control once when nothing older exists; clicking it
   *  fetches an empty page and the control disappears. The label can therefore be
   *  briefly wrong, but only in the harmless direction - a full page always means
   *  more MAY exist and a short page always means the end was reached, so no
   *  history is ever unreachable. The honest fix (server returns hasMore from a
   *  limit+1 read) is deferred, not rejected: spec section 4.4. */
  hasOlder: boolean;
  /** An older page is in flight - the control is disabled. */
  loadingOlder: boolean;
  /** Fetch and merge one older page. No-op while one is already in flight. */
  loadOlder: () => Promise<void>;
```

- [ ] **Step 4: Implement the paging**

Add the import at the top of the file:

```ts
import { mergeTimelineItems, oldestMessageId, THREAD_PAGE_SIZE } from '../shared/threadPaging.js';
```

Add state and refs beside the existing ones (after `abortRef`):

```ts
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Older-page fetches get their OWN controller: an SSE refetch aborts abortRef,
  // and must not cancel an in-flight "Load older" the operator just asked for.
  const olderAbortRef = useRef<AbortController | null>(null);
  // Which conversation the held items belong to, so the FIRST load of a thread
  // replaces state while every later load merges into it.
  const loadedIdRef = useRef<string | null>(null);
```

Replace the body of `fetchNow`'s success path (currently `setServerItems(buildRelayItems(messages))`) with:

```ts
      const fresh = buildRelayItems(messages);
      const isFirstLoad = loadedIdRef.current !== conversationId;
      loadedIdRef.current = conversationId;
      setServerItems((prev) => (isFirstLoad ? fresh : mergeTimelineItems(prev, fresh)));
      // Only the FIRST load decides this: hasOlder describes the far end of the
      // thread, which a refetch of the newest page says nothing about.
      if (isFirstLoad) setHasOlder(messages.length >= THREAD_PAGE_SIZE);
```

and pass the page size on that same call:

```ts
        getConversationMessages(conversationId, { limit: THREAD_PAGE_SIZE }, controller.signal),
```

Add `loadOlder` after `fetchNow`:

```ts
  const loadOlder = useCallback(async (): Promise<void> => {
    if (loadingOlder) return;
    const before = oldestMessageId(serverItems);
    if (before === undefined) return;
    olderAbortRef.current?.abort();
    const controller = new AbortController();
    olderAbortRef.current = controller;
    setLoadingOlder(true);
    try {
      const older = await getConversationMessages(
        conversationId,
        { limit: THREAD_PAGE_SIZE, before },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setServerItems((prev) => mergeTimelineItems(prev, buildRelayItems(older)));
      setHasOlder(older.length >= THREAD_PAGE_SIZE);
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      // A failed older-page read leaves hasOlder alone so the control stays and
      // the operator can retry. It must never error the whole thread: the
      // history they already have is still correct.
    } finally {
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  }, [conversationId, loadingOlder, serverItems]);
```

Extend the existing conversation-reset effect so stale paging state cannot flash on a thread switch:

```ts
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPending([]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasOlder(false);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingOlder(false);
    olderAbortRef.current?.abort();
  }, [conversationId]);
```

Add the three members to the returned object:

```ts
    hasOlder,
    loadingOlder,
    loadOlder,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @housingchoice/dashboard -- src/routes/conversation/useRelayThread.test.tsx`
Expected: PASS, all five cases.

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

Bare `git status` first, then:

```bash
git commit -F - -- dashboard/src/routes/conversation/useRelayThread.ts dashboard/src/routes/conversation/useRelayThread.test.tsx <<'EOF'
feat(threads): page older history in useRelayThread

Adds hasOlder/loadingOlder/loadOlder and merges every fetch by id, so a
live refetch cannot drop entries that fell out of the shifted newest
window. hasOlder is a documented heuristic (spec 4.4).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: Page older history in `useGroupThread`

Same shape as Task 3, minus the scheduled bucket. The code is repeated rather than referenced because the implementer may be reading tasks out of order.

**Files:**
- Modify: `dashboard/src/routes/conversation/useGroupThread.ts`
- Create: `dashboard/src/routes/conversation/useGroupThread.test.tsx`

**Interfaces:**
- Consumes: `THREAD_PAGE_SIZE`, `mergeTimelineItems`, `oldestMessageId`; `buildRelayItems` from `./useRelayThread.js` (already imported).
- Produces: `hasOlder: boolean`, `loadingOlder: boolean`, `loadOlder: () => Promise<void>` on `GroupThreadState`.

- [ ] **Step 1: Write the failing tests**

Create `dashboard/src/routes/conversation/useGroupThread.test.tsx`:

```tsx
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../api/index.js';

const getConversationMessages = vi.fn();
let lastHandlers: { onMessagePersisted?: () => void } = {};

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getConversationMessages: (...a: unknown[]) => getConversationMessages(...a),
    useEventStream: (handlers: typeof lastHandlers) => {
      lastHandlers = handlers;
    },
  };
});

import { useGroupThread } from './useGroupThread.js';

function message(id: string, at: string): Message {
  return {
    conversationId: 'g1',
    tsMsgId: id,
    provider_ts: at,
    direction: 'inbound',
    author: 'contact',
    type: 'sms',
    body: id,
    delivery_status: 'delivered',
  } as Message;
}

function page(count: number, startMinute: number): Message[] {
  return Array.from({ length: count }, (_, i) =>
    message(
      `m${startMinute + count - 1 - i}`,
      `2026-08-13T10:${String(startMinute + count - 1 - i).padStart(2, '0')}:00.000Z`,
    ),
  );
}

function Probe(): React.JSX.Element {
  const { status, items, hasOlder, loadingOlder, loadOlder } = useGroupThread('g1');
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="ids">{items.map((i) => i.id).join(',')}</span>
      <span data-testid="hasOlder">{String(hasOlder)}</span>
      <span data-testid="loadingOlder">{String(loadingOlder)}</span>
      <button type="button" onClick={() => void loadOlder()}>
        load older
      </button>
    </div>
  );
}

beforeEach(() => {
  getConversationMessages.mockReset();
  lastHandlers = {};
});

describe('useGroupThread paging', () => {
  it('reports hasOlder when the first page comes back full', async () => {
    getConversationMessages.mockResolvedValue(page(50, 0));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('hasOlder')).toHaveTextContent('true');
  });

  it('reports no older history when the first page is short', async () => {
    getConversationMessages.mockResolvedValue(page(4, 0));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('hasOlder')).toHaveTextContent('false');
  });

  it('requests the older page with a before bound and prepends it', async () => {
    getConversationMessages.mockResolvedValueOnce(page(50, 10));
    getConversationMessages.mockResolvedValueOnce(page(2, 8));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });

    expect(getConversationMessages).toHaveBeenLastCalledWith(
      'g1',
      { limit: 50, before: 'm10' },
      expect.anything(),
    );
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent(/^m8,m9,m10/));
  });

  it('keeps loaded older history when a live refetch shifts the newest window', async () => {
    getConversationMessages.mockResolvedValueOnce(page(50, 10));
    getConversationMessages.mockResolvedValueOnce(page(2, 8));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent(/^m8,m9,m10/));

    getConversationMessages.mockResolvedValueOnce(page(50, 12));
    await act(async () => {
      lastHandlers.onMessagePersisted?.();
      await new Promise((r) => setTimeout(r, 350));
    });

    await waitFor(() => {
      const ids = screen.getByTestId('ids').textContent ?? '';
      expect(ids).toContain('m8,m9,m10,m11,m12');
      expect(ids).toContain('m61');
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @housingchoice/dashboard -- src/routes/conversation/useGroupThread.test.tsx`
Expected: FAIL - the three members do not exist on `GroupThreadState`.

- [ ] **Step 3: Extend the state interface**

In `dashboard/src/routes/conversation/useGroupThread.ts`, add to `GroupThreadState` after `refresh`:

```ts
  /** Older history exists beyond the oldest entry held. HEURISTIC: the messages
   *  route returns no `hasMore`, so a FULL page is read as "probably more". A
   *  thread that is an exact multiple of the page size shows the control once
   *  with nothing behind it; the click fetches an empty page and it disappears.
   *  Wrong only in the harmless direction - no history is ever unreachable.
   *  Spec section 4.4. */
  hasOlder: boolean;
  /** An older page is in flight - the control is disabled. */
  loadingOlder: boolean;
  /** Fetch and merge one older page. No-op while one is already in flight. */
  loadOlder: () => Promise<void>;
```

- [ ] **Step 4: Implement the paging**

Add the import:

```ts
import { mergeTimelineItems, oldestMessageId, THREAD_PAGE_SIZE } from '../shared/threadPaging.js';
```

Add state and refs after `abortRef`:

```ts
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Its own controller: an SSE refetch aborts abortRef and must not cancel an
  // in-flight "Load older" the operator just asked for.
  const olderAbortRef = useRef<AbortController | null>(null);
  const loadedIdRef = useRef<string | null>(null);
```

In `fetchNow`, replace the fetch and the `setServerItems(buildRelayItems(messages))` line with:

```ts
      const messages = await getConversationMessages(
        conversationId,
        { limit: THREAD_PAGE_SIZE },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const fresh = buildRelayItems(messages);
      const isFirstLoad = loadedIdRef.current !== conversationId;
      loadedIdRef.current = conversationId;
      setServerItems((prev) => (isFirstLoad ? fresh : mergeTimelineItems(prev, fresh)));
      if (isFirstLoad) setHasOlder(messages.length >= THREAD_PAGE_SIZE);
```

Add `loadOlder` after `fetchNow`:

```ts
  const loadOlder = useCallback(async (): Promise<void> => {
    if (loadingOlder) return;
    const before = oldestMessageId(serverItems);
    if (before === undefined) return;
    olderAbortRef.current?.abort();
    const controller = new AbortController();
    olderAbortRef.current = controller;
    setLoadingOlder(true);
    try {
      const older = await getConversationMessages(
        conversationId,
        { limit: THREAD_PAGE_SIZE, before },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setServerItems((prev) => mergeTimelineItems(prev, buildRelayItems(older)));
      setHasOlder(older.length >= THREAD_PAGE_SIZE);
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      // Keep hasOlder as-is so the control stays and the operator can retry; the
      // history already on screen is still correct.
    } finally {
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  }, [conversationId, loadingOlder, serverItems]);
```

Extend the conversation-reset effect:

```ts
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPending([]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasOlder(false);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingOlder(false);
    olderAbortRef.current?.abort();
  }, [conversationId]);
```

Add to the returned object:

```ts
    hasOlder,
    loadingOlder,
    loadOlder,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @housingchoice/dashboard -- src/routes/conversation/useGroupThread.test.tsx`
Expected: PASS, all four cases.

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

Bare `git status` first, then:

```bash
git commit -F - -- dashboard/src/routes/conversation/useGroupThread.ts dashboard/src/routes/conversation/useGroupThread.test.tsx <<'EOF'
feat(threads): page older history in useGroupThread

Same merge-by-id paging as the relay thread; group threads have no
scheduled bucket, so there is one read per page.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: Page older history in `useContactTimeline`

This hook has an authoritative `nextCursor`, so its `hasOlder` is exact rather than heuristic. Two constraints are specific to it: the `upcoming` bucket is first-page-only server-side, and the 404-assembled fallback cannot page at all.

**Files:**
- Modify: `dashboard/src/api/endpoints.ts:1174-1186` (add `cursor` to `getContactTimeline`)
- Modify: `dashboard/src/routes/contact/useContactTimeline.ts`
- Modify: `dashboard/src/routes/contact/useContactTimeline.test.tsx`

**Interfaces:**
- Consumes: `mergeTimelineItems` from `../shared/threadPaging.js`.
- Produces: `getContactTimeline(contactId, opts?: { kinds?: string; cursor?: string }, signal?)`; `hasOlder: boolean`, `loadingOlder: boolean`, `loadOlder: () => Promise<void>` on `ContactTimelineState`.

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/src/routes/contact/useContactTimeline.test.tsx`. Extend the existing `Probe` component to expose the new members:

```tsx
function PagingProbe({ contactId, kinds }: { contactId: string; kinds?: string }): React.JSX.Element {
  const { status, items, upcoming, hasOlder, loadingOlder, loadOlder } = useContactTimeline(
    contactId,
    kinds,
  );
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="ids">{items.map((i) => i.id).join(',')}</span>
      <span data-testid="upcoming">{upcoming.length}</span>
      <span data-testid="hasOlder">{String(hasOlder)}</span>
      <span data-testid="loadingOlder">{String(loadingOlder)}</span>
      <button type="button" onClick={() => void loadOlder()}>
        load older
      </button>
    </div>
  );
}

function timelineItem(id: string, at: string): TimelineItem {
  return {
    kind: 'message',
    id,
    at,
    conversationId: 'c1',
    tsMsgId: id,
    direction: 'inbound',
    author: 'contact',
    type: 'sms',
    body: id,
    delivery_status: 'delivered',
  } as TimelineItem;
}

describe('useContactTimeline paging', () => {
  it('reports hasOlder from the server cursor', async () => {
    getContactTimeline.mockResolvedValue({
      items: [timelineItem('a', '2026-08-13T10:00:00.000Z')],
      nextCursor: 'CURSOR1',
      upcoming: [],
    });
    render(<PagingProbe contactId="p1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('hasOlder')).toHaveTextContent('true');
  });

  it('reports no older history when the cursor is null', async () => {
    getContactTimeline.mockResolvedValue({
      items: [timelineItem('a', '2026-08-13T10:00:00.000Z')],
      nextCursor: null,
      upcoming: [],
    });
    render(<PagingProbe contactId="p1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('hasOlder')).toHaveTextContent('false');
  });

  it('sends the cursor AND the kinds filter on the older page', async () => {
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('b', '2026-08-13T10:00:00.000Z')],
      nextCursor: 'CURSOR1',
      upcoming: [],
    });
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('a', '2026-08-13T09:00:00.000Z')],
      nextCursor: null,
      upcoming: [],
    });
    render(<PagingProbe contactId="p1" kinds="message,call" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });

    expect(getContactTimeline).toHaveBeenLastCalledWith(
      'p1',
      { kinds: 'message,call', cursor: 'CURSOR1' },
      expect.anything(),
    );
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('a,b'));
    expect(screen.getByTestId('hasOlder')).toHaveTextContent('false');
  });

  it('keeps the first-page upcoming bucket when an older page arrives', async () => {
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('b', '2026-08-13T10:00:00.000Z')],
      nextCursor: 'CURSOR1',
      upcoming: [{ id: 's1' }, { id: 's2' }],
    });
    // The server gathers `upcoming` only when `cursor` is absent, so an older
    // page legitimately carries none. It must not blank the pinned section.
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('a', '2026-08-13T09:00:00.000Z')],
      nextCursor: null,
    });
    render(<PagingProbe contactId="p1" />);
    await waitFor(() => expect(screen.getByTestId('upcoming')).toHaveTextContent('2'));

    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });

    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('a,b'));
    expect(screen.getByTestId('upcoming')).toHaveTextContent('2');
  });

  it('reports no older history on the assembled fallback path', async () => {
    getContactTimeline.mockRejectedValue(new ApiError(404, 'not_found'));
    getConversations.mockResolvedValue({ conversations: [], nextCursor: null } as ConversationsPage);
    render(<PagingProbe contactId="p1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('hasOlder')).toHaveTextContent('false');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @housingchoice/dashboard -- src/routes/contact/useContactTimeline.test.tsx`
Expected: FAIL - the three members do not exist on `ContactTimelineState`.

- [ ] **Step 3: Add `cursor` to the endpoint**

Replace `dashboard/src/api/endpoints.ts:1174-1186` with:

```ts
export function getContactTimeline(
  contactId: string,
  opts: { kinds?: string; cursor?: string } = {},
  signal?: AbortSignal,
): Promise<ContactTimelinePage> {
  return request<ContactTimelinePage>(
    `/api/contacts/${encodeURIComponent(contactId)}/timeline`,
    {
      query: { kinds: opts.kinds, cursor: opts.cursor },
      ...(signal !== undefined && { signal }),
    },
  );
}
```

- [ ] **Step 4: Thread the cursor through `loadTimeline`**

In `dashboard/src/routes/contact/useContactTimeline.ts`, add `nextCursor` to the internal `TimelineData` interface:

```ts
  /** The server's cursor for the next OLDER page, or null at the end of history.
   *  Always null on the fallback path, which cannot page. */
  nextCursor: string | null;
```

Change `loadTimeline`'s signature and its server-path return:

```ts
async function loadTimeline(
  contactId: string,
  kinds: string | undefined,
  signal: AbortSignal,
  cursor?: string,
): Promise<{
  items: TimelineItem[];
  upcoming: TimelineScheduled[];
  upcomingTimezone: string | undefined;
  source: TimelineSource;
  nextCursor: string | null;
}> {
  try {
    const page = await getContactTimeline(
      contactId,
      {
        ...(kinds !== undefined && { kinds }),
        ...(cursor !== undefined && { cursor }),
      },
      signal,
    );
    return {
      items: normalizeServerItems(page.items),
      upcoming: page.upcoming ?? [],
      upcomingTimezone: page.timezone,
      source: 'server',
      nextCursor: page.nextCursor,
    };
  } catch (err) {
```

and add `nextCursor: null` to the fallback path's return object, beside `source: 'fallback'`.

- [ ] **Step 5: Implement the paging in the hook**

Add the import:

```ts
import { mergeTimelineItems } from '../shared/threadPaging.js';
```

Add `nextCursor: null` to the `useState<TimelineData>` initializer. Add beside it:

```ts
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Its own controller: the SSE refetch aborts abortRef and must not cancel an
  // in-flight "Load older".
  const olderAbortRef = useRef<AbortController | null>(null);
  const loadedIdRef = useRef<string | null>(null);
```

In `fetchNow`, replace the `setState({ status: 'ready', ... })` call with:

```ts
      const isFirstLoad = loadedIdRef.current !== contactId;
      loadedIdRef.current = contactId;
      setState((prev) => ({
        status: 'ready',
        items: isFirstLoad ? items : mergeTimelineItems(prev.items, items),
        upcoming,
        upcomingTimezone,
        source,
        // Only the FIRST load sets this. A refetch of the newest page says
        // nothing about the far end of history, and would otherwise resurrect a
        // cursor the operator has already paged past.
        nextCursor: isFirstLoad ? nextCursor : prev.nextCursor,
      }));
```

with `nextCursor` destructured from the `loadTimeline` result alongside the existing fields.

Add `loadOlder` after `fetchNow`:

```ts
  const loadOlder = useCallback(async (): Promise<void> => {
    if (loadingOlder) return;
    const cursor = stateRef.current.nextCursor;
    if (cursor === null) return;
    olderAbortRef.current?.abort();
    const controller = new AbortController();
    olderAbortRef.current = controller;
    setLoadingOlder(true);
    try {
      const older = await loadTimeline(contactId, kinds, controller.signal, cursor);
      if (controller.signal.aborted) return;
      setState((prev) => ({
        ...prev,
        items: mergeTimelineItems(prev.items, older.items),
        // `upcoming` is a FIRST-PAGE-ONLY bucket server-side (the route gathers
        // it only when `cursor` is absent), so an older page carries none. Keep
        // what the first page gave us rather than blanking the pinned section.
        nextCursor: older.nextCursor,
      }));
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      // Leave nextCursor intact so the control stays and the operator can retry.
    } finally {
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  }, [contactId, kinds, loadingOlder]);
```

`loadOlder` reads the cursor through a ref so it does not have to be recreated on
every item change. Add the ref beside the state:

```ts
  const stateRef = useRef(state);
  stateRef.current = state;
```

Extend the contact-reset effect:

```ts
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPending([]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingOlder(false);
    olderAbortRef.current?.abort();
  }, [contactId]);
```

Add to `ContactTimelineState` and to the returned object:

```ts
  /** Older history exists. EXACT here, unlike the conversation hooks: the
   *  timeline route returns a real nextCursor. Always false on the assembled
   *  fallback path, which has no cursor to page with. */
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
```

```ts
    hasOlder: state.nextCursor !== null,
    loadingOlder,
    loadOlder,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w @housingchoice/dashboard -- src/routes/contact/useContactTimeline.test.tsx`
Expected: PASS, including the pre-existing cases in that file.

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

Bare `git status` first, then:

```bash
git commit -F - -- dashboard/src/api/endpoints.ts dashboard/src/routes/contact/useContactTimeline.ts dashboard/src/routes/contact/useContactTimeline.test.tsx <<'EOF'
feat(threads): page older history in useContactTimeline

The server has always returned nextCursor and the hook discarded it. Now
kept and sent back with the active kinds filter. The first-page-only
upcoming bucket survives an older-page load; the assembled fallback path
reports no older history because it has no cursor.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 6: The "Load older messages" control and scroll anchoring

The trickiest part is scroll. To reach the control the operator must scroll UP, so `atBottomRef.current` is false, and the existing layout effect would read the prepend as growth and raise the "New messages" pill for content that landed ABOVE them.

**Files:**
- Modify: `dashboard/src/routes/contact/Timeline.tsx` (props at :183, scroll effect at :1132, JSX at :1247)
- Modify: `dashboard/src/routes/contact/Timeline.module.css`
- Modify: `dashboard/src/routes/contact/Timeline.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks (the props are supplied by callers in Task 7).
- Produces: three optional `TimelineProps` members - `hasOlder?: boolean`, `onLoadOlder?: () => void | Promise<void>`, `loadingOlder?: boolean`. Callers passing none are behaviorally unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/src/routes/contact/Timeline.test.tsx`. The file already has a `makeScrollable` helper (around :1081) that backs `scrollHeight` / `clientHeight` / `scrollTop` with real read-write values - reuse it.

```tsx
describe('Timeline load-older control', () => {
  it('does not render the control when the caller passes no paging props', () => {
    render(<Timeline status="ready" items={[]} source="server" canSend={false} />);
    expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull();
  });

  it('does not render the control when there is no older history', () => {
    render(
      <Timeline
        status="ready"
        items={[]}
        source="server"
        canSend={false}
        hasOlder={false}
        onLoadOlder={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull();
  });

  it('calls onLoadOlder when clicked', async () => {
    const onLoadOlder = vi.fn();
    const u = userEvent.setup();
    render(
      <Timeline
        status="ready"
        items={[]}
        source="server"
        canSend={false}
        hasOlder
        onLoadOlder={onLoadOlder}
      />,
    );
    await u.click(screen.getByRole('button', { name: 'Load older messages' }));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('disables the control while a page is in flight', () => {
    render(
      <Timeline
        status="ready"
        items={[]}
        source="server"
        canSend={false}
        hasOlder
        loadingOlder
        onLoadOlder={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Loading...' })).toBeDisabled();
  });

  it('holds the scroll anchor when older items prepend', async () => {
    const u = userEvent.setup();
    const { container, rerender } = render(
      <Timeline
        status="ready"
        items={[itemAt('b', '2026-08-13T10:00:00.000Z')]}
        source="server"
        canSend={false}
        hasOlder
        onLoadOlder={() => {}}
      />,
    );
    const stream = container.querySelector('[class*="stream"]') as HTMLElement;
    makeScrollable(stream, 500, 100);
    stream.scrollTop = 0; // scrolled to the top, where the control lives

    await u.click(screen.getByRole('button', { name: 'Load older messages' }));
    // The prepend grows the content ABOVE the viewport by 200px.
    setProp(stream, 'scrollHeight', 700);
    rerender(
      <Timeline
        status="ready"
        items={[itemAt('a', '2026-08-13T09:00:00.000Z'), itemAt('b', '2026-08-13T10:00:00.000Z')]}
        source="server"
        canSend={false}
        hasOlder={false}
        onLoadOlder={() => {}}
      />,
    );

    expect(stream.scrollTop).toBe(200); // the bubble they were reading stayed put
  });

  it('raises no "new messages" pill for a prepend', async () => {
    const u = userEvent.setup();
    const { container, rerender } = render(
      <Timeline
        status="ready"
        items={[itemAt('b', '2026-08-13T10:00:00.000Z')]}
        source="server"
        canSend={false}
        hasOlder
        onLoadOlder={() => {}}
      />,
    );
    const stream = container.querySelector('[class*="stream"]') as HTMLElement;
    makeScrollable(stream, 500, 100);
    stream.scrollTop = 0;

    await u.click(screen.getByRole('button', { name: 'Load older messages' }));
    setProp(stream, 'scrollHeight', 700);
    rerender(
      <Timeline
        status="ready"
        items={[itemAt('a', '2026-08-13T09:00:00.000Z'), itemAt('b', '2026-08-13T10:00:00.000Z')]}
        source="server"
        canSend={false}
        hasOlder={false}
        onLoadOlder={() => {}}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Jump to the newest messages' })).toBeNull();
  });

  it('still raises the pill for an APPEND while scrolled up', () => {
    const { container, rerender } = render(
      <Timeline
        status="ready"
        items={[itemAt('a', '2026-08-13T09:00:00.000Z')]}
        source="server"
        canSend={false}
      />,
    );
    const stream = container.querySelector('[class*="stream"]') as HTMLElement;
    makeScrollable(stream, 500, 100);
    stream.scrollTop = 40; // scrolled up, not at bottom
    stream.dispatchEvent(new Event('scroll'));

    setProp(stream, 'scrollHeight', 700);
    rerender(
      <Timeline
        status="ready"
        items={[itemAt('a', '2026-08-13T09:00:00.000Z'), itemAt('z', '2026-08-13T11:00:00.000Z')]}
        source="server"
        canSend={false}
      />,
    );

    expect(screen.getByRole('button', { name: 'Jump to the newest messages' })).toBeVisible();
  });
});
```

Add an `itemAt` helper beside the file's existing fixtures if one is not already present:

```tsx
function itemAt(id: string, at: string): TimelineItem {
  return {
    kind: 'message',
    id,
    at,
    conversationId: 'c1',
    tsMsgId: id,
    direction: 'inbound',
    author: 'contact',
    type: 'sms',
    body: id,
    delivery_status: 'delivered',
  } as TimelineItem;
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @housingchoice/dashboard -- src/routes/contact/Timeline.test.tsx`
Expected: FAIL - no button named "Load older messages"; the anchor and pill assertions fail.

- [ ] **Step 3: Add the props**

In `dashboard/src/routes/contact/Timeline.tsx`, add to `TimelineProps` (after `readOnlyNote`):

```ts
  /** Older history exists beyond the oldest rendered entry - render the
   *  "Load older messages" control above the stream. Absent on every caller that
   *  does not page, which leaves those timelines visually unchanged. */
  hasOlder?: boolean;
  /** Fetch one older page. The control records the scroll anchor before calling
   *  this, so the prepend does not move the reader. */
  onLoadOlder?: () => void | Promise<void>;
  /** An older page is in flight - the control is disabled and relabeled. */
  loadingOlder?: boolean;
```

Destructure them in the component body beside the other props.

- [ ] **Step 4: Add the anchor ref and click handler**

Beside the existing scroll refs (around :1100):

```ts
  // Set to the stream's scrollHeight immediately BEFORE an older page is
  // requested. The next layout pass that grows the content consumes it to keep
  // the bubble the operator was reading exactly where it was.
  const prependAnchorRef = useRef<number | null>(null);

  const handleLoadOlder = (): void => {
    const el = streamRef.current;
    prependAnchorRef.current = el ? el.scrollHeight : null;
    void onLoadOlder?.();
  };
```

- [ ] **Step 5: Consume the anchor in the layout effect**

In the `useLayoutEffect` at :1132, insert this block immediately after the `resetScrollKey` branch and BEFORE `const grew = count > prevCountRef.current;`:

```ts
    // A PREPEND (older history) is not "new below": the content landed above the
    // viewport, so restore the offset and never raise the pill for it.
    if (prependAnchorRef.current !== null) {
      const anchor = prependAnchorRef.current;
      prependAnchorRef.current = null;
      if (count > prevCountRef.current) {
        prevCountRef.current = count;
        el.scrollTop += el.scrollHeight - anchor;
        return;
      }
    }
```

Then add this effect below it, so an older page that comes back EMPTY (no growth,
so the layout effect may not run at all) cannot leave a stale anchor behind to
mis-handle a later append:

```ts
  // Clear a stale anchor once the load settles. Runs after paint, so the layout
  // effect above has already had its chance to consume it.
  useEffect(() => {
    if (loadingOlder !== true) prependAnchorRef.current = null;
  }, [loadingOlder]);
```

- [ ] **Step 6: Render the control**

In the JSX at :1247, insert as the FIRST child inside `<div className={styles.stream} ...>`, above the loading spinner:

```tsx
        {status === 'ready' && hasOlder === true && onLoadOlder !== undefined ? (
          <div className={styles.loadOlderRow}>
            <button
              type="button"
              className={styles.loadOlder}
              onClick={handleLoadOlder}
              disabled={loadingOlder === true}
            >
              {loadingOlder === true ? 'Loading...' : 'Load older messages'}
            </button>
          </div>
        ) : null}
```

- [ ] **Step 7: Add the styles**

Append to `dashboard/src/routes/contact/Timeline.module.css`, modeled on the
existing `.loadMore` in `routes/broadcasts/BroadcastsList.module.css`:

```css
.loadOlderRow {
  display: flex;
  justify-content: center;
  padding: var(--sp-2) 0 var(--sp-3);
}

.loadOlder {
  padding: var(--sp-1) var(--sp-3);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-pill);
  background: var(--c-surface);
  color: var(--c-text-muted);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  cursor: pointer;
}
.loadOlder:hover:not(:disabled) {
  border-color: var(--c-border-strong);
  color: var(--c-text);
}
.loadOlder:disabled {
  cursor: default;
  opacity: 0.6;
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -w @housingchoice/dashboard -- src/routes/contact/Timeline.test.tsx`
Expected: PASS, including every pre-existing scroll test in that file.

- [ ] **Step 9: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

Bare `git status` first, then:

```bash
git commit -F - -- dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/Timeline.module.css dashboard/src/routes/contact/Timeline.test.tsx <<'EOF'
feat(threads): add the Load older messages control to the shared Timeline

Three optional props, so callers that do not page are unchanged. The
prepend path records the scroll anchor before fetching and restores the
offset after layout, and never raises the "new messages" pill for content
that landed above the viewport.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 7: Wire the control into the five surfaces

**Files:**
- Modify: `dashboard/src/routes/conversation/ConversationDetail.tsx:465`
- Modify: `dashboard/src/routes/conversation/GroupTextView.tsx:434`
- Modify: `dashboard/src/routes/contact/ContactCommsPane.tsx:319`
- Verify (modify only if they drop the props): `dashboard/src/routes/tours/TourConversation.tsx:464`, `dashboard/src/routes/placements/PlacementConversation.tsx:320`

**Interfaces:**
- Consumes: `hasOlder` / `loadingOlder` / `loadOlder` from Tasks 3-5; the three `Timeline` props from Task 6.
- Produces: no new interfaces.

- [ ] **Step 1: Pass the props from the relay view**

In `ConversationDetail.tsx`, add to the `<Timeline>` element (the hook is already bound as `thread`):

```tsx
            hasOlder={thread.hasOlder}
            loadingOlder={thread.loadingOlder}
            onLoadOlder={thread.loadOlder}
```

- [ ] **Step 2: Pass the props from the group view**

In `GroupTextView.tsx`, on its `<Timeline>` element, using that file's hook binding name:

```tsx
            hasOlder={thread.hasOlder}
            loadingOlder={thread.loadingOlder}
            onLoadOlder={thread.loadOlder}
```

- [ ] **Step 3: Pass the props from the contact comms pane**

`ContactCommsPane` receives the hook state from its caller rather than owning it
(see that file's header comment). Pass through from the same state object it
already reads `status` and `items` from:

```tsx
        hasOlder={timeline.hasOlder}
        loadingOlder={timeline.loadingOlder}
        onLoadOlder={timeline.loadOlder}
```

Use the prop name that file actually binds; do not rename it.

- [ ] **Step 4: Verify the tour and placement hubs**

Open `TourConversation.tsx:464` and `PlacementConversation.tsx:320`. Both render
`<Timeline>` fed by `useRelayThread` and both also mount `ContactCommsTab`.
Confirm each forwards the three props to `<Timeline>`; add them in the same shape
as Step 1 if it does not. Do NOT assume the fix is inherited automatically -
inheritance holds for the hook, not for the JSX.

- [ ] **Step 5: Run the full unit suite**

Run: `npm test`
Expected: PASS. Existing view tests render these components with hooks that now
return the new members; none of them assert on the absence of a button.

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

Bare `git status` first, then commit with an explicit pathspec listing exactly
the files you touched:

```bash
git commit -F - -- dashboard/src/routes/conversation/ConversationDetail.tsx dashboard/src/routes/conversation/GroupTextView.tsx dashboard/src/routes/contact/ContactCommsPane.tsx <<'EOF'
feat(threads): wire Load older into the relay, group, and contact views

Tour and placement comms inherit the paging through useRelayThread and
ContactCommsTab; both were checked to forward the props.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 8: End-to-end proof

The spec's decision (section 5.2): the spec builds its own long thread rather
than touching the byte-stable lean seed world, and never calls
`POST /__dev/performance/reseed`, which would wipe the world out from under every
other spec in the run.

**Files:**
- Create: `e2e/tests/dashboard-next/thread-history-paging.spec.ts`

**Interfaces:**
- Consumes: `postInboundSms(request, { from, body, messageSid, to? })` from `e2e/fixtures/fakeTwilio.ts`; the dashboard URL helpers in `e2e/support/urls.ts`.
- Produces: nothing.

- [ ] **Step 1: Write the spec**

Create `e2e/tests/dashboard-next/thread-history-paging.spec.ts`. Follow the
existing specs in that directory for the dev-login and navigation preamble -
copy their imports and setup rather than inventing a new pattern.

```ts
import { expect, test } from '@playwright/test';
import { postInboundSms } from '../../fixtures/fakeTwilio.js';

// A fresh, unseeded number so this spec owns its conversation outright and
// perturbs no seeded fixture. 55 messages puts it past the 50-entry page.
const FROM = '+15005550199';
const TOTAL = 55;

test('staff can reach messages older than the newest page', async ({ page, request }) => {
  // 1. Build the long thread. Sequential, because each inbound must be deduped
  //    by a UNIQUE MessageSid and ordering is what the assertion depends on.
  for (let i = 0; i < TOTAL; i += 1) {
    const res = await postInboundSms(request, {
      from: FROM,
      body: `history probe ${i}`,
      messageSid: `SMhistory${String(i).padStart(4, '0')}`,
    });
    expect(res.status).toBe(200);
  }

  // 2. Open the conversation this created. Use the same dev-login +
  //    navigation preamble as the neighbouring specs in this directory.
  //    Navigate to the contact created by the inbound, then its comms thread.

  // 3. The newest page is present, the oldest message is NOT.
  await expect(page.getByText(`history probe ${TOTAL - 1}`)).toBeVisible();
  await expect(page.getByText('history probe 0')).toHaveCount(0);

  // 4. Reach the older page.
  const loadOlder = page.getByRole('button', { name: 'Load older messages' });
  await expect(loadOlder).toBeVisible();
  await loadOlder.click();

  // 5. The oldest message is now reachable and the control retires.
  await expect(page.getByText('history probe 0')).toBeVisible();
  await expect(loadOlder).toHaveCount(0);
});
```

Fill in step 2 with the real preamble from a neighbouring spec. Do not leave it
as a comment - the spec must actually navigate.

- [ ] **Step 2: Run the new spec alone first**

Run the e2e suite filtered to this spec, from the e2e workspace, per
`e2e/README.md`. Expected: PASS.

If the inbound messages do not appear, check `e2e/support/preflight.ts:132-136`
first: the fake-twilio dedup pointer is a known cause of an inbound that creates
the contact but drops the message.

- [ ] **Step 3: Commit**

Bare `git status` first, then:

```bash
git commit -F - -- e2e/tests/dashboard-next/thread-history-paging.spec.ts <<'EOF'
test(e2e): prove staff can reach history older than the newest page

Builds its own 55-message thread from a fresh number rather than touching
the byte-stable lean seed world.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 9: Gates and handback

**Files:**
- Modify: none (unless a gate fails).

**Interfaces:**
- Consumes: everything above.
- Produces: a merge-ready branch.

- [ ] **Step 1: Sync main into the branch, once**

Per the repo's one-sync rule, do this ONCE, here, at the final pre-handback step.
If `main` has advanced in a way that could conflict with active work, ask before
syncing rather than resolving blind.

```powershell
git merge main
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. Run it bare - never piped.

- [ ] **Step 3: Unit suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: End-to-end suite**

Run: `npm run e2e`
Expected: PASS.

Two known flakes must be re-run once before blaming this change, with BOTH runs
reported: `tour-reminders-panel-e2e-flake` and
`conversationdetail-members-mock-suite-flake`.

- [ ] **Step 5: Self-QA in a live session**

Start `npm run e2e:session` and drive the lane with the Playwright MCP. On a
thread with more than 50 entries, confirm by eye:

1. The control appears at the top of the stream and nowhere else.
2. Clicking it does not move the bubble you were reading.
3. No "New messages" pill appears from the prepend.
4. A live inbound message still appends and still raises the pill when you are
   scrolled up.
5. Loaded history survives that inbound - nothing vanishes from the middle.

- [ ] **Step 6: Report**

Report the branch, the commit count, the gate results verbatim, and anything
deliberately left out. Do not merge - merging to `main` requires explicit human
approval.

---

## Self-Review

**Spec coverage.** Section 4.1 merge rule - Task 1, applied in Tasks 3-5. Section
4.2 API client - Task 2. Section 4.3 hooks - Tasks 3, 4, 5. Section 4.4 heuristic
and its recorded trade-off - Task 3 Step 3 and Task 4 Step 3 (code comments),
plus the exact-cursor contrast in Task 5. Section 4.5 Timeline UI and anchoring -
Task 6. Section 4.6 plumbing - Task 7. Section 5.1 unit tests - Tasks 1, 3, 4, 5,
6. Section 5.2 e2e - Task 8. Section 5.3 gates - Task 9. Section 3 decision 6
(fallback shows no button) - Task 5 Step 1, final case. No spec section is
unimplemented.

**Type consistency.** The three hook members are named `hasOlder`,
`loadingOlder`, and `loadOlder` in every task and in `TimelineProps`
(`onLoadOlder` for the callback prop, deliberately distinct from the hook's
`loadOlder`). `THREAD_PAGE_SIZE`, `mergeTimelineItems`, and `oldestMessageId`
carry the same names in Task 1 and in every consumer.

**Known judgment calls left to the implementer.** Task 7 Step 3 says to use the
prop name `ContactCommsPane` already binds rather than guessing one, and Task 8
Step 1 requires the real navigation preamble from a neighbouring spec. Both are
"read the file and match it" instructions, not placeholders.
