# Thread History Paging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff reach conversation history older than the newest 50 entries, on all five surfaces that render the shared `<Timeline>`.

**Architecture:** A "Load older messages" button lives in `Timeline.tsx` behind ONE optional `paging` object prop, so one control serves every surface and a caller cannot supply half of it. Three data hooks gain `hasOlder` / `loadingOlder` / `loadOlder()` and page backwards through capabilities the servers already expose (`before` for messages, `nextCursor` for the contact timeline). Every fetch MERGES by id instead of replacing state, which is what keeps a live SSE refetch from punching a hole in loaded history.

**Tech Stack:** React 19 + TypeScript, Vitest + Testing Library (dashboard unit tests), Playwright (e2e), Express + DynamoDB (backend, unchanged by this plan).

**Spec:** `docs/superpowers/specs/2026-08-13-thread-history-paging-design.md`

**Revision:** v4, after adversarial review rounds 1-3 (round 3: 7 findings, all accepted; it also conceded round 2's single reject). Round 3's structural change: the four paging props became ONE `paging` object, because "passed together or not at all" as prose is exactly how tour and placement were left half-wired in v3. Earlier: v3, after rounds 1 and 2 (round 1: two reviewers, 37 findings, all accepted; round 2: 11 findings, 10 accepted, 1 rejected). Adjudications: `.superpowers/design-review/adjudications.md`. The root fixes are marked **[R1]**..**[R5]** where they appear. Round 2's headline correction is inside R1: the prepend anchor is now consumed on an explicit `olderPagesLoaded` counter from the hook, because BOTH earlier rules - "the count grew" and "the first rendered item changed" - were shown to fire without a prepend.

## Global Constraints

- **Frontend only.** No route, repo, or schema changes. `app/` is not modified.
- **ASCII-only** on every new or touched line (comments, test names, copy, commit messages).
- **Page size is 50** (`THREAD_PAGE_SIZE`), matching the server default.
- **Button copy is exactly `Load older messages`**; the in-flight label is exactly `Loading...`.
- **Accessibility-first selectors** in tests: `getByRole` / `getByLabel`, never CSS classes, EXCEPT where a test must reach the scroll container itself - see Task 6.
- **No fake timers.** `dashboard/src/test/setup.ts` pins the clock with a bare `vi.setSystemTime` and installs NO fake timers. Never call `vi.advanceTimersByTime*` in these suites; await a real `setTimeout` instead.
- **Never pipe a gate command.** Run `npm run typecheck`, `npm test`, `npm run e2e` bare and inspect the captured output afterwards.
- **Commit discipline:** run a bare `git status` as its own command before every commit, then commit with an explicit pathspec (`git commit -F - -- <paths>`). Never `git add -A`. A file you edited but did not list is silently left dirty - every task's pathspec below lists exactly the files that task edits. Every commit gets a `Co-Authored-By` trailer naming the authoring model.
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

There is deliberately NO `oldestMessageId` helper. **[R3]** The `before` bound is
tracked per hook from the RAW fetched page, never derived from mapped items -
see Task 3.

- [ ] **Step 1: Write the failing tests**

Create `dashboard/src/routes/shared/threadPaging.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '../../api/index.js';
import { mergeTimelineItems, THREAD_PAGE_SIZE } from './threadPaging.js';

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
  it('returns the incoming page, sorted, when there is nothing held', () => {
    const incoming = [msg('b', '2026-08-13T10:00:00.000Z'), msg('a', '2026-08-13T09:00:00.000Z')];
    expect(mergeTimelineItems([], incoming).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('returns what is held, sorted, when the incoming page is empty', () => {
    const prev = [msg('b', '2026-08-13T10:00:00.000Z'), msg('a', '2026-08-13T09:00:00.000Z')];
    expect(mergeTimelineItems(prev, []).map((i) => i.id)).toEqual(['a', 'b']);
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

  // No fast paths: the tie-break contract must hold on the FIRST page too, which
  // is the page every user sees.
  it('applies the id tie-break even when nothing is held yet', () => {
    const incoming = [msg('b', '2026-08-13T09:00:00.000Z'), msg('a', '2026-08-13T09:00:00.000Z')];
    expect(mergeTimelineItems([], incoming).map((i) => i.id)).toEqual(['a', 'b']);
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
 * on both sides so a fresher delivery status wins. Always returns chronological
 * order - there is deliberately no empty-side fast path, because the documented
 * ordering contract has to hold on the first page too.
 */
export function mergeTimelineItems(
  prev: TimelineItem[],
  incoming: TimelineItem[],
): TimelineItem[] {
  const byId = new Map<string, TimelineItem>();
  for (const item of prev) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort(compareItems);
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
- Modify: `dashboard/src/routes/contact/useContactTimeline.test.tsx:145,188` (two assertions)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `getConversationMessages(conversationId: string, opts?: { limit?: number; before?: string }, signal?: AbortSignal): Promise<Message[]>`

The signature moves to the `(id, opts, signal)` shape already used by `getTourActivity` and `getPlacementHistory` in the same file (located by name - an earlier revision cited `getContacts`, which takes `(params, signal)` with no leading id and is not the precedent). Exactly three non-test call sites; `tsc` rejects any missed one because `AbortSignal` is not assignable to the opts type. NOTE: `tsc` does NOT catch a test that pins the old call arity through a bare `vi.fn()` mock - there are four such files, and the full unit suite is what finds them.

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

In `dashboard/src/routes/conversation/useRelayThread.ts`, inside `fetchNow`:

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

- [ ] **Step 4: Fix the two existing assertions the new arity breaks**

`toHaveBeenCalledWith` is an exact arity match, and the spread mocks forward every argument, so the fallback call site's third argument breaks two live assertions.

In `dashboard/src/routes/contact/useContactTimeline.test.tsx`, at BOTH `:145` and `:188`, change:

```ts
    expect(getConversationMessages).toHaveBeenCalledWith('c1', expect.anything());
```

to:

```ts
    expect(getConversationMessages).toHaveBeenCalledWith('c1', {}, expect.anything());
```

- [ ] **Step 5: Run typecheck and the full unit suite**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm test`
Expected: PASS. If either assertion above was missed, the `useContactTimeline` suite fails with an argument mismatch naming `'c1'`.

- [ ] **Step 6: Commit**

Bare `git status` first, then:

```bash
git commit -F - -- dashboard/src/api/endpoints.ts dashboard/src/routes/conversation/useRelayThread.ts dashboard/src/routes/conversation/useGroupThread.ts dashboard/src/routes/contact/useContactTimeline.ts dashboard/src/routes/contact/useContactTimeline.test.tsx <<'EOF'
feat(api): add limit/before paging to getConversationMessages

The server has always supported both; the client function had no paging
parameters at all, so the capability was unreachable. Moves to the
(id, opts, signal) shape used by getTourActivity and getContacts, and
updates the two fallback-path assertions that pin the call arity.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: Page older history in `useRelayThread`

**Files:**
- Modify: `dashboard/src/routes/conversation/useRelayThread.ts`
- Create: `dashboard/src/routes/conversation/useRelayThread.test.tsx`

**Interfaces:**
- Consumes: `THREAD_PAGE_SIZE`, `mergeTimelineItems` from `../shared/threadPaging.js`; `getConversationMessages(id, opts, signal)` from Task 2.
- Produces: four new members on `RelayThreadState`, the same four every other hook exposes:
  - `hasOlder: boolean`
  - `loadingOlder: boolean`
  - `loadOlder: () => Promise<void>`
  - `olderPagesLoaded: number`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/src/routes/conversation/useRelayThread.test.tsx`:

```tsx
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../api/index.js';

const getConversationMessages = vi.fn();
const getConversationScheduled = vi.fn();
let lastHandlers: {
  onMessagePersisted?: (event?: { conversationId?: string }) => void;
} = {};

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

// Instants are built from a base epoch + i minutes so no fixture can produce an
// impossible clock reading like 10:60.
const BASE_MS = Date.parse('2026-08-13T10:00:00.000Z');
const MINUTE = 60_000;

function message(seq: number): Message {
  return {
    conversationId: 'c1',
    tsMsgId: `m${seq}`,
    provider_ts: new Date(BASE_MS + seq * MINUTE).toISOString(),
    direction: 'inbound',
    author: 'contact',
    type: 'sms',
    body: `m${seq}`,
    delivery_status: 'delivered',
  } as Message;
}

/** `count` messages ending at sequence `startSeq + count - 1`, NEWEST FIRST. */
function page(count: number, startSeq: number): Message[] {
  return Array.from({ length: count }, (_, i) => message(startSeq + count - 1 - i));
}

/** Let the hook's 300ms SSE debounce fire. Real timers - this suite has no fake
 *  timers, and the global setup installs none (dashboard/src/test/setup.ts). */
async function flushDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 350));
}

function Probe({ conversationId = 'c1' }: { conversationId?: string }): React.JSX.Element {
  const { status, items, hasOlder, loadingOlder, loadOlder, olderPagesLoaded } =
    useRelayThread(conversationId);
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="ids">{items.map((i) => i.id).join(',')}</span>
      <span data-testid="hasOlder">{String(hasOlder)}</span>
      <span data-testid="loadingOlder">{String(loadingOlder)}</span>
      <span data-testid="pages">{String(olderPagesLoaded)}</span>
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
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent(/^m8,m9,m10/));
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
      lastHandlers.onMessagePersisted?.({ conversationId: 'c1' });
      await flushDebounce();
    });

    await waitFor(() => {
      const ids = screen.getByTestId('ids').textContent ?? '';
      expect(ids).toContain('m8,m9,m10,m11,m12'); // no hole
      expect(ids).toContain('m61'); // the new tail landed
    });
  });

  // [R4] The guard is a REF, so it holds within a single render - two clicks in
  // one tick must produce ONE older request, not two.
  it('fires one older request for a double click', async () => {
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

  // The counter is <Timeline>'s prepend signal, so a bump WITHOUT a merge (or a
  // merge without a bump) silently breaks scroll anchoring on every surface.
  it('bumps olderPagesLoaded only when an older page actually merges', async () => {
    getConversationMessages.mockResolvedValueOnce(page(50, 10));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('pages')).toHaveTextContent('0'); // first load is not a prepend

    // An SSE refetch is not a prepend.
    getConversationMessages.mockResolvedValueOnce(page(50, 12));
    await act(async () => {
      lastHandlers.onMessagePersisted?.({ conversationId: 'c1' });
      await flushDebounce();
    });
    expect(screen.getByTestId('pages')).toHaveTextContent('0');

    // A merged older page IS.
    getConversationMessages.mockResolvedValueOnce(page(2, 8));
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    await waitFor(() => expect(screen.getByTestId('pages')).toHaveTextContent('1'));

    // A FAILED older page is not - nothing merged, so nothing may signal one.
    getConversationMessages.mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });
    await waitFor(() => expect(screen.getByTestId('loadingOlder')).toHaveTextContent('false'));
    expect(screen.getByTestId('pages')).toHaveTextContent('1');
  });

  // The ONLY thing standing between two threads' transcripts fusing.
  it('replaces rather than merges when the conversation changes', async () => {
    getConversationMessages.mockResolvedValueOnce(page(3, 100)); // m100..m102
    const { rerender } = render(<Probe conversationId="c1" />);
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('m100,m101,m102'));

    getConversationMessages.mockResolvedValueOnce(page(2, 200)); // m200, m201
    rerender(<Probe conversationId="c2" />);

    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('m200,m201'));
    expect(screen.getByTestId('ids')).not.toHaveTextContent('m100');
  });
});
```

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
   *  limit+1 read) is deferred, not rejected: spec section 4.4.
   *
   *  This holds ONLY because the bound below is derived from the same RAW page
   *  this count comes from - see oldestFetchedIdRef. */
  hasOlder: boolean;
  /** An older page is in flight - the control is disabled. */
  loadingOlder: boolean;
  /** Fetch and merge one older page. No-op while one is already in flight. */
  loadOlder: () => Promise<void>;
  /** Incremented ONLY when an older page has merged into `items`.
   *
   *  This is the renderer's only reliable signal that a PREPEND happened, and
   *  <Timeline> uses it to decide when to restore the scroll anchor. Nothing
   *  observable from the item list can replace it: an SSE append grows the list
   *  without a prepend, and the "Comms only" toggle changes the FIRST rendered
   *  item without one either (Timeline renders the filtered `visible`, not
   *  `items`). Spec section 4.5. */
  olderPagesLoaded: number;
```

- [ ] **Step 4: Implement the paging**

Add the import at the top of the file:

```ts
import { mergeTimelineItems, THREAD_PAGE_SIZE } from '../shared/threadPaging.js';
```

Add state and refs beside the existing ones (after `abortRef`):

```ts
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Bumped ONLY on a successful older-page merge - <Timeline>'s prepend signal.
  const [olderPagesLoaded, setOlderPagesLoaded] = useState(0);
  // [R4] The in-flight guard is a REF, not render state: two clicks in one tick
  // share a single render closure, so a state-based guard would let the second
  // through - firing a duplicate read that aborts the first and can strand the
  // button in a disabled state.
  const loadingOlderRef = useRef(false);
  // [R3] The `before` bound, taken from the RAW newest-first page (its LAST
  // element is its oldest). Never derived from the mapped items: buildRelayItems
  // drops calls and email, so a page can map to fewer rows - or none - and a
  // mapped-derived bound would leave a live button with nothing to page from.
  const oldestFetchedIdRef = useRef<string | null>(null);
  // Older-page fetches get their OWN controller: an SSE refetch aborts abortRef,
  // and must not cancel an in-flight "Load older" the operator just asked for.
  const olderAbortRef = useRef<AbortController | null>(null);
  // Which conversation the held items belong to, so the FIRST load of a thread
  // replaces state while every later load merges into it.
  const loadedIdRef = useRef<string | null>(null);
```

In `fetchNow`, pass the page size and replace the `setServerItems(buildRelayItems(messages))` line:

```ts
        getConversationMessages(conversationId, { limit: THREAD_PAGE_SIZE }, controller.signal),
```

```ts
      const fresh = buildRelayItems(messages);
      const isFirstLoad = loadedIdRef.current !== conversationId;
      loadedIdRef.current = conversationId;
      setServerItems((prev) => (isFirstLoad ? fresh : mergeTimelineItems(prev, fresh)));
      if (isFirstLoad) {
        // Only the FIRST load decides these: hasOlder describes the far end of
        // the thread, which a refetch of the newest page says nothing about, and
        // re-baselining the bound would discard pages already walked.
        oldestFetchedIdRef.current = messages[messages.length - 1]?.tsMsgId ?? null;
        setHasOlder(messages.length >= THREAD_PAGE_SIZE);
      }
```

Add `loadOlder` after `fetchNow`:

```ts
  const loadOlder = useCallback(async (): Promise<void> => {
    if (loadingOlderRef.current) return;
    const before = oldestFetchedIdRef.current;
    if (before === null) return;
    loadingOlderRef.current = true;
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
      const oldest = older[older.length - 1]?.tsMsgId;
      if (oldest !== undefined) oldestFetchedIdRef.current = oldest;
      setHasOlder(older.length >= THREAD_PAGE_SIZE);
      // Bump LAST and only here: this is what tells <Timeline> a prepend landed.
      setOlderPagesLoaded((n) => n + 1);
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      // A failed older-page read leaves hasOlder alone so the control stays and
      // the operator can retry. It must never error the whole thread: the
      // history they already have is still correct.
    } finally {
      loadingOlderRef.current = false;
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  }, [conversationId]);
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
    loadingOlderRef.current = false;
    oldestFetchedIdRef.current = null;
    olderAbortRef.current?.abort();
  }, [conversationId]);
```

Abort an in-flight older page on unmount too, mirroring the existing `abortRef` cleanup:

```ts
  useEffect(() => () => olderAbortRef.current?.abort(), []);
```

Add the three members to the returned object:

```ts
    hasOlder,
    loadingOlder,
    loadOlder,
    olderPagesLoaded,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @housingchoice/dashboard -- src/routes/conversation/useRelayThread.test.tsx`
Expected: PASS, all seven cases.

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
window. The in-flight guard is a ref so a double click fires once, and the
before bound comes from the raw page so a fully-mapped-away page cannot
strand a live button. hasOlder is a documented heuristic (spec 4.4).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: Page older history in `useGroupThread`

Same shape as Task 3 with two REAL differences, not just the missing scheduled bucket. The code is repeated rather than referenced because the implementer may be reading tasks out of order.

**The differences that matter:**

1. **SSE events are FILTERED here.** `useGroupThread` wires `onThreadEvent`, which returns early unless `event.conversationId` matches. `useRelayThread` binds `scheduleRefetch` directly and takes no argument. A test that fires `onMessagePersisted()` with no payload throws a TypeError in this hook and silently no-ops after a fix. Always pass `{ conversationId }`.
2. **`refresh()` must REPLACE, not merge.** The error-state retry would otherwise union a stale transcript into a fresh one.

**Files:**
- Modify: `dashboard/src/routes/conversation/useGroupThread.ts`
- Create: `dashboard/src/routes/conversation/useGroupThread.test.tsx`

**Interfaces:**
- Consumes: `THREAD_PAGE_SIZE`, `mergeTimelineItems`; `buildRelayItems` from `./useRelayThread.js` (already imported).
- Produces: `hasOlder: boolean`, `loadingOlder: boolean`, `loadOlder: () => Promise<void>` on `GroupThreadState`.

- [ ] **Step 1: Write the failing tests**

Create `dashboard/src/routes/conversation/useGroupThread.test.tsx`:

```tsx
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../api/index.js';

const getConversationMessages = vi.fn();
let lastHandlers: {
  onMessagePersisted?: (event: { conversationId?: string }) => void;
} = {};

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

const BASE_MS = Date.parse('2026-08-13T10:00:00.000Z');
const MINUTE = 60_000;

function message(seq: number): Message {
  return {
    conversationId: 'g1',
    tsMsgId: `m${seq}`,
    provider_ts: new Date(BASE_MS + seq * MINUTE).toISOString(),
    direction: 'inbound',
    author: 'contact',
    type: 'sms',
    body: `m${seq}`,
    delivery_status: 'delivered',
  } as Message;
}

function page(count: number, startSeq: number): Message[] {
  return Array.from({ length: count }, (_, i) => message(startSeq + count - 1 - i));
}

async function flushDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 350));
}

function Probe({ conversationId = 'g1' }: { conversationId?: string }): React.JSX.Element {
  const { status, items, hasOlder, loadingOlder, loadOlder, olderPagesLoaded } =
    useGroupThread(conversationId);
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="ids">{items.map((i) => i.id).join(',')}</span>
      <span data-testid="hasOlder">{String(hasOlder)}</span>
      <span data-testid="loadingOlder">{String(loadingOlder)}</span>
      <span data-testid="pages">{String(olderPagesLoaded)}</span>
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

  // NOTE the payload: this hook FILTERS by conversationId (onThreadEvent).
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
      lastHandlers.onMessagePersisted?.({ conversationId: 'g1' });
      await flushDebounce();
    });

    await waitFor(() => {
      const ids = screen.getByTestId('ids').textContent ?? '';
      expect(ids).toContain('m8,m9,m10,m11,m12');
      expect(ids).toContain('m61');
    });
    // One merged older page, and the SSE refetch did not add a phantom one.
    expect(screen.getByTestId('pages')).toHaveTextContent('1');
  });

  it('ignores an SSE event for a DIFFERENT conversation', async () => {
    getConversationMessages.mockResolvedValueOnce(page(3, 0));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    await act(async () => {
      lastHandlers.onMessagePersisted?.({ conversationId: 'someone-else' });
      await flushDebounce();
    });
    expect(getConversationMessages).toHaveBeenCalledTimes(1);
  });

  // [R4] Same ref guard as the relay hook - tested here too, because the guard
  // was copied and a copied guard is an untested guard.
  it('fires one older request for a double click', async () => {
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
    expect(getConversationMessages).toHaveBeenCalledTimes(2); // first page + ONE older

    await act(async () => {
      release([]);
    });
    await waitFor(() => expect(screen.getByTestId('loadingOlder')).toHaveTextContent('false'));
  });

  it('replaces rather than merges when the conversation changes', async () => {
    getConversationMessages.mockResolvedValueOnce(page(3, 100));
    const { rerender } = render(<Probe conversationId="g1" />);
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('m100,m101,m102'));

    getConversationMessages.mockResolvedValueOnce(page(2, 200));
    rerender(<Probe conversationId="g2" />);

    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('m200,m201'));
    expect(screen.getByTestId('ids')).not.toHaveTextContent('m100');
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
  /** Incremented ONLY when an older page has merged - <Timeline>'s prepend
   *  signal. Nothing observable from the item list can replace it: an append
   *  grows the list without a prepend, and the "Comms only" toggle changes the
   *  first RENDERED item without one. Spec section 4.5. */
  olderPagesLoaded: number;
```

- [ ] **Step 4: Implement the paging**

Add the import:

```ts
import { mergeTimelineItems, THREAD_PAGE_SIZE } from '../shared/threadPaging.js';
```

Add state and refs after `abortRef`:

```ts
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Bumped ONLY on a successful older-page merge - <Timeline>'s prepend signal.
  const [olderPagesLoaded, setOlderPagesLoaded] = useState(0);
  // [R4] Ref, not state: two clicks in one tick share one render closure.
  const loadingOlderRef = useRef(false);
  // [R3] The bound comes from the RAW newest-first page, never from mapped items.
  const oldestFetchedIdRef = useRef<string | null>(null);
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
      if (isFirstLoad) {
        oldestFetchedIdRef.current = messages[messages.length - 1]?.tsMsgId ?? null;
        setHasOlder(messages.length >= THREAD_PAGE_SIZE);
      }
```

Add `loadOlder` after `fetchNow`:

```ts
  const loadOlder = useCallback(async (): Promise<void> => {
    if (loadingOlderRef.current) return;
    const before = oldestFetchedIdRef.current;
    if (before === null) return;
    loadingOlderRef.current = true;
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
      const oldest = older[older.length - 1]?.tsMsgId;
      if (oldest !== undefined) oldestFetchedIdRef.current = oldest;
      setHasOlder(older.length >= THREAD_PAGE_SIZE);
      // Bump LAST and only here: this is what tells <Timeline> a prepend landed.
      setOlderPagesLoaded((n) => n + 1);
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      // Keep hasOlder as-is so the control stays and the operator can retry; the
      // history already on screen is still correct.
    } finally {
      loadingOlderRef.current = false;
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  }, [conversationId]);
```

Make `refresh` a REPLACE by clearing the loaded-id first:

```ts
  const refresh = useCallback(() => {
    setStatus('loading');
    // The retry must REPLACE, not union a stale transcript into a fresh read.
    loadedIdRef.current = null;
    void fetchNow();
  }, [fetchNow]);
```

Extend the conversation-reset effect and add the unmount abort:

```ts
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPending([]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasOlder(false);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingOlder(false);
    loadingOlderRef.current = false;
    oldestFetchedIdRef.current = null;
    olderAbortRef.current?.abort();
  }, [conversationId]);

  useEffect(() => () => olderAbortRef.current?.abort(), []);
```

Add to the returned object:

```ts
    hasOlder,
    loadingOlder,
    loadOlder,
    olderPagesLoaded,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @housingchoice/dashboard -- src/routes/conversation/useGroupThread.test.tsx`
Expected: PASS, all seven cases.

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

Bare `git status` first, then:

```bash
git commit -F - -- dashboard/src/routes/conversation/useGroupThread.ts dashboard/src/routes/conversation/useGroupThread.test.tsx <<'EOF'
feat(threads): page older history in useGroupThread

Same merge-by-id paging as the relay thread. Group threads have no
scheduled bucket, filter SSE events by conversationId, and their refresh()
retry now replaces rather than merging a stale transcript.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: Page older history in `useContactTimeline`

This hook has an authoritative `nextCursor`, so its `hasOlder` is exact rather than heuristic. Three constraints are specific to it: the `upcoming` bucket is first-page-only server-side, the 404-assembled fallback cannot page at all, and the cursor must NOT become part of the hook's public state.

**Files:**
- Modify: `dashboard/src/api/endpoints.ts:1174-1186` (add `cursor` to `getContactTimeline`)
- Modify: `dashboard/src/routes/contact/useContactTimeline.ts`
- Modify: `dashboard/src/routes/contact/useContactTimeline.test.tsx`

**Interfaces:**
- Consumes: `mergeTimelineItems` from `../shared/threadPaging.js`.
- Produces: `getContactTimeline(contactId, opts?: { kinds?: string; cursor?: string }, signal?)`; `hasOlder: boolean`, `loadingOlder: boolean`, `loadOlder: () => Promise<void>` on `ContactTimelineState`.

**[R5] Do NOT add `nextCursor` to `TimelineData`.** `ContactTimelineState extends TimelineData` (useContactTimeline.ts:64), so anything added there becomes a required member of the hook's PUBLIC return type - `typecheck` fails, and "fixing" it by returning the cursor publicly leaks an opaque server token onto the state object that `ContactCommsPane` and `ContactCommsTab` pass around. The cursor lives in a ref instead, written only inside async callbacks (never during render, which the enabled `react-hooks/refs` rule forbids).

- [ ] **Step 1: Write the failing tests**

APPEND to `dashboard/src/routes/contact/useContactTimeline.test.tsx`. Do NOT modify the existing `Probe` component - roughly two dozen pre-existing assertions depend on its test ids. Add a SECOND probe alongside it.

```tsx
function PagingProbe({
  contactId,
  kinds,
}: {
  contactId: string;
  kinds?: string;
}): React.JSX.Element {
  const {
    status,
    items,
    upcoming,
    upcomingTimezone,
    hasOlder,
    loadingOlder,
    loadOlder,
    olderPagesLoaded,
  } = useContactTimeline(contactId, kinds);
  return (
    <div>
      <span data-testid="p-status">{status}</span>
      <span data-testid="p-ids">{items.map((i) => i.id).join(',')}</span>
      <span data-testid="p-upcoming">{upcoming.length}</span>
      <span data-testid="p-tz">{upcomingTimezone ?? 'none'}</span>
      <span data-testid="p-hasOlder">{String(hasOlder)}</span>
      <span data-testid="p-loadingOlder">{String(loadingOlder)}</span>
      <span data-testid="p-pages">{String(olderPagesLoaded)}</span>
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
    await waitFor(() => expect(screen.getByTestId('p-status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('p-hasOlder')).toHaveTextContent('true');
  });

  it('reports no older history when the cursor is null', async () => {
    getContactTimeline.mockResolvedValue({
      items: [timelineItem('a', '2026-08-13T10:00:00.000Z')],
      nextCursor: null,
      upcoming: [],
    });
    render(<PagingProbe contactId="p1" />);
    await waitFor(() => expect(screen.getByTestId('p-status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('p-hasOlder')).toHaveTextContent('false');
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
    await waitFor(() => expect(screen.getByTestId('p-status')).toHaveTextContent('ready'));

    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });

    expect(getContactTimeline).toHaveBeenLastCalledWith(
      'p1',
      { kinds: 'message,call', cursor: 'CURSOR1' },
      expect.anything(),
    );
    await waitFor(() => expect(screen.getByTestId('p-ids')).toHaveTextContent('a,b'));
    expect(screen.getByTestId('p-hasOlder')).toHaveTextContent('false');
  });

  it('keeps the first-page upcoming bucket AND its timezone when an older page arrives', async () => {
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('b', '2026-08-13T10:00:00.000Z')],
      nextCursor: 'CURSOR1',
      upcoming: [{ id: 's1' }, { id: 's2' }],
      timezone: 'America/Chicago',
    });
    // The server gathers `upcoming` only when `cursor` is absent, so an older
    // page legitimately carries none. It must not blank the pinned section.
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('a', '2026-08-13T09:00:00.000Z')],
      nextCursor: null,
    });
    render(<PagingProbe contactId="p1" />);
    await waitFor(() => expect(screen.getByTestId('p-upcoming')).toHaveTextContent('2'));

    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
    });

    await waitFor(() => expect(screen.getByTestId('p-ids')).toHaveTextContent('a,b'));
    expect(screen.getByTestId('p-upcoming')).toHaveTextContent('2');
    expect(screen.getByTestId('p-tz')).toHaveTextContent('America/Chicago');
    // The merged older page is <Timeline>'s prepend signal.
    expect(screen.getByTestId('p-pages')).toHaveTextContent('1');
  });

  it('reports no older history on the assembled fallback path', async () => {
    getContactTimeline.mockRejectedValue(new ApiError(404, 'not_found', 'nope'));
    getConversations.mockResolvedValue({ conversations: [], nextCursor: null } as ConversationsPage);
    render(<PagingProbe contactId="p1" />);
    await waitFor(() => expect(screen.getByTestId('p-status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('p-hasOlder')).toHaveTextContent('false');
  });

  // [R4] The ref guard, tested here too rather than assumed from the copy.
  it('fires one older request for a double click', async () => {
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('b', '2026-08-13T10:00:00.000Z')],
      nextCursor: 'CURSOR1',
      upcoming: [],
    });
    let release: (v: unknown) => void = () => {};
    getContactTimeline.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    render(<PagingProbe contactId="p1" />);
    await waitFor(() => expect(screen.getByTestId('p-status')).toHaveTextContent('ready'));

    await act(async () => {
      screen.getByRole('button', { name: 'load older' }).click();
      screen.getByRole('button', { name: 'load older' }).click();
    });
    expect(getContactTimeline).toHaveBeenCalledTimes(2); // first page + ONE older

    await act(async () => {
      release({ items: [], nextCursor: null });
    });
    await waitFor(() => expect(screen.getByTestId('p-loadingOlder')).toHaveTextContent('false'));
  });

  it('replaces rather than merges when the kinds filter changes', async () => {
    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('a', '2026-08-13T09:00:00.000Z')],
      nextCursor: null,
      upcoming: [],
    });
    const { rerender } = render(<PagingProbe contactId="p1" />);
    await waitFor(() => expect(screen.getByTestId('p-ids')).toHaveTextContent('a'));

    getContactTimeline.mockResolvedValueOnce({
      items: [timelineItem('z', '2026-08-13T11:00:00.000Z')],
      nextCursor: null,
      upcoming: [],
    });
    rerender(<PagingProbe contactId="p1" kinds="message" />);

    await waitFor(() => expect(screen.getByTestId('p-ids')).toHaveTextContent('z'));
    expect(screen.getByTestId('p-ids')).not.toHaveTextContent('a');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @housingchoice/dashboard -- src/routes/contact/useContactTimeline.test.tsx`
Expected: FAIL - the three members do not exist on `ContactTimelineState`. The pre-existing cases in the file must still pass.

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

- [ ] **Step 4: Return the cursor from `loadTimeline` WITHOUT touching `TimelineData`**

In `dashboard/src/routes/contact/useContactTimeline.ts`, widen only `loadTimeline`'s
return type - leave the `TimelineData` interface exactly as it is:

```ts
async function loadTimeline(
  contactId: string,
  kinds: string | undefined,
  signal: AbortSignal,
): Promise<{
  items: TimelineItem[];
  upcoming: TimelineScheduled[];
  upcomingTimezone: string | undefined;
  source: TimelineSource;
  nextCursor: string | null;
}> {
```

Add `nextCursor: page.nextCursor` to the server-path return object, and
`nextCursor: null` to the fallback path's return object (the fallback cannot page).

- [ ] **Step 5: Implement the paging in the hook**

Add the import:

```ts
import { mergeTimelineItems } from '../shared/threadPaging.js';
```

Add beside the existing state:

```ts
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Bumped ONLY on a successful older-page merge - <Timeline>'s prepend signal.
  const [olderPagesLoaded, setOlderPagesLoaded] = useState(0);
  // [R4] Ref guard, as in the conversation hooks.
  const loadingOlderRef = useRef(false);
  // [R5] The cursor is NOT part of TimelineData: ContactTimelineState extends it,
  // so anything added there becomes a public member. A ref written only inside
  // async callbacks also stays clear of the react-hooks/refs render-purity rule.
  const cursorRef = useRef<string | null>(null);
  const olderAbortRef = useRef<AbortController | null>(null);
  // [R3-analogue] Keyed on contact AND kinds: fetchNow depends on both, so a
  // kinds change is a NEW feed - merging the filtered page into the unfiltered
  // one would make the filter look broken and strand the cursor.
  const loadedKeyRef = useRef<string | null>(null);
```

In `fetchNow`, destructure `nextCursor` from `loadTimeline` and replace the `setState({...})` call:

```ts
      const loadedKey = `${contactId}|${kinds ?? ''}`;
      const isFirstLoad = loadedKeyRef.current !== loadedKey;
      loadedKeyRef.current = loadedKey;
      if (isFirstLoad) {
        // Only the FIRST load of a feed sets these; a refetch of the newest page
        // says nothing about the far end and must not resurrect a cursor the
        // operator has already paged past.
        cursorRef.current = nextCursor;
        setHasOlder(nextCursor !== null);
      }
      setState((prev) => ({
        status: 'ready',
        items: isFirstLoad ? items : mergeTimelineItems(prev.items, items),
        upcoming,
        upcomingTimezone,
        source,
      }));
```

Add `loadOlder` after `fetchNow`. It calls `getContactTimeline` DIRECTLY, never
`loadTimeline`: that helper's 404 branch assembles the whole inbox fallback, which
on an older page would fan out across every conversation and merge a
messages-only re-assembly into a `source: 'server'` timeline.

```ts
  const loadOlder = useCallback(async (): Promise<void> => {
    if (loadingOlderRef.current) return;
    const cursor = cursorRef.current;
    if (cursor === null) return;
    loadingOlderRef.current = true;
    olderAbortRef.current?.abort();
    const controller = new AbortController();
    olderAbortRef.current = controller;
    setLoadingOlder(true);
    try {
      const page = await getContactTimeline(
        contactId,
        {
          ...(kinds !== undefined && { kinds }),
          cursor,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      cursorRef.current = page.nextCursor;
      setHasOlder(page.nextCursor !== null);
      setState((prev) => ({
        ...prev,
        // `upcoming` / `upcomingTimezone` are a FIRST-PAGE-ONLY bucket server-side
        // (the route gathers them only when `cursor` is absent), so an older page
        // carries none. The spread keeps what the first page gave us rather than
        // blanking the pinned section.
        items: mergeTimelineItems(prev.items, normalizeServerItems(page.items)),
      }));
      // Bump LAST and only here: this is what tells <Timeline> a prepend landed.
      setOlderPagesLoaded((n) => n + 1);
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      // Leave the cursor intact so the control stays and the operator can retry.
    } finally {
      loadingOlderRef.current = false;
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  }, [contactId, kinds]);
```

Extend the contact-reset effect and add the unmount abort. Two details this hook
gets wrong if it is written from the conversation hooks by analogy:

- It must clear `hasOlder` and `cursorRef` too. `ContactDetail.tsx:115-118`
  states outright that a `contactId` change re-renders the SAME component
  instance with no remount, so anything not reset by hand LEAKS across contacts.
  A click landing in that window would merge a page fetched on contact A's
  cursor boundary into contact B and leave B holding A's cursor.
- It must key on `kinds` as well. `fetchNow` depends on `[contactId, kinds]`, so
  a filter change is a new feed; keying the reset on `contactId` alone would
  leave an in-flight older page un-aborted and the guard un-cleared, re-siting
  the same defect inside `loadOlder`.

```ts
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPending([]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingOlder(false);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasOlder(false);
    loadingOlderRef.current = false;
    cursorRef.current = null;
    olderAbortRef.current?.abort();
  }, [contactId, kinds]);

  useEffect(() => () => olderAbortRef.current?.abort(), []);
```

Note `setPending([])` now also runs on a `kinds` change. That is correct: an
optimistic bubble belongs to the feed it was sent from, and `fetchNow` is
re-running anyway.

Add to `ContactTimelineState` and to the returned object:

```ts
  /** Older history exists. EXACT here, unlike the conversation hooks: the
   *  timeline route returns a real nextCursor. Always false on the assembled
   *  fallback path, which has no cursor to page with. */
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
  /** Incremented ONLY when an older page has merged - <Timeline>'s prepend
   *  signal. Spec section 4.5. */
  olderPagesLoaded: number;
```

```ts
    hasOlder,
    loadingOlder,
    loadOlder,
    olderPagesLoaded,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w @housingchoice/dashboard -- src/routes/contact/useContactTimeline.test.tsx`
Expected: PASS, including every pre-existing case in that file.

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: PASS. A failure naming `nextCursor` on `ContactTimelineState` means the cursor was added to `TimelineData` after all - move it back to the ref.

- [ ] **Step 8: Commit**

Bare `git status` first, then:

```bash
git commit -F - -- dashboard/src/api/endpoints.ts dashboard/src/routes/contact/useContactTimeline.ts dashboard/src/routes/contact/useContactTimeline.test.tsx <<'EOF'
feat(threads): page older history in useContactTimeline

The server has always returned nextCursor and the hook discarded it. Now
held in a ref (not on the public state) and sent back with the active kinds
filter. loadOlder calls getContactTimeline directly so a 404 cannot pull
the inbox fallback into a server timeline. The first-page-only upcoming
bucket survives an older-page load; the assembled fallback reports no older
history because it has no cursor.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 6: The "Load older messages" control and scroll anchoring

The trickiest part is scroll. To reach the control the operator must scroll UP, so `atBottomRef.current` is false, and the existing layout effect would read the prepend as growth and raise the "New messages" pill for content that landed ABOVE them.

**Files:**
- Modify: `dashboard/src/routes/contact/Timeline.tsx` (props at :183, scroll refs at :1100, layout effect at :1132, JSX at :1246)
- Modify: `dashboard/src/routes/contact/Timeline.module.css`
- Modify: `dashboard/src/routes/contact/Timeline.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks (the object is supplied by callers in Task 7).
- Produces: an exported `TimelinePaging` interface and ONE optional `TimelineProps` member, `paging?: TimelinePaging`. Callers passing nothing are behaviorally unchanged.

```ts
export interface TimelinePaging {
  hasOlder: boolean;
  loadingOlder: boolean;
  olderPagesLoaded: number;
  onLoadOlder: () => void | Promise<void>;
}
```

One object, not four sibling props. The four are meaningless apart -
`loadingOlder` is what disarms a stale anchor and `olderPagesLoaded` is what
consumes it, so a caller that passes `hasOlder` and `onLoadOlder` alone gets a
control whose anchor can never fire. As four independently optional props that
contract can only be prose, and prose is exactly how the tour and placement
surfaces were left half-wired in the previous revision. As one object the
compiler enforces it.

- [ ] **Step 1: Write the failing tests**

APPEND a new top-level describe to `dashboard/src/routes/contact/Timeline.test.tsx`.

Three harness facts this block must respect, all of which the file already
demonstrates:

- `setProp` / `makeScrollable` / `wrap` / `stream` are declared INSIDE
  `describe('Timeline stick-to-bottom')` (:1078-:1107). A sibling describe cannot
  see them, so this block declares its own under different names.
- `userEvent` is NOT imported in this file. Use `fireEvent.click`, which is.
- The scroll container is `.stream`; `.streamWrap` is its positioning parent and
  matches `[class*="stream"]` FIRST. Always exclude it.
- The block below uses the `TimelinePaging` type, so add it to the file's
  existing `import { Timeline } from './Timeline.js';` line as
  `import { Timeline, type TimelinePaging } from './Timeline.js';`.

```tsx
describe('Timeline load-older control', () => {
  function setNum(el: HTMLElement, name: string, value: number): void {
    Object.defineProperty(el, name, { configurable: true, value });
  }

  /** Back scrollHeight/clientHeight with fixed values and scrollTop with a real
   *  read/write slot, so the layout effect's arithmetic is observable. */
  function stubScroll(el: HTMLElement, scrollHeight: number, clientHeight = 100): void {
    setNum(el, 'scrollHeight', scrollHeight);
    setNum(el, 'clientHeight', clientHeight);
    let top = 0;
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
  }

  /** The SCROLL CONTAINER, excluding the .streamWrap positioning parent. */
  function streamEl(): HTMLElement {
    return document.querySelector('[class*="stream"]:not([class*="Wrap"])') as HTMLElement;
  }

  function item(id: string, at: string): TimelineItem {
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

  const OLD = item('a', '2026-08-13T09:00:00.000Z');
  const MID = item('b', '2026-08-13T10:00:00.000Z');
  const NEW = item('z', '2026-08-13T11:00:00.000Z');

  /** The paging object, defaulted to "older history exists, nothing in flight".
   *  All four members always travel together - that is the whole point of the
   *  object, so no test may hand-build a partial one. */
  function pagingProps(over: Partial<TimelinePaging> = {}): TimelinePaging {
    return {
      hasOlder: true,
      loadingOlder: false,
      olderPagesLoaded: 0,
      onLoadOlder: vi.fn(),
      ...over,
    };
  }

  function renderTimeline(props: Partial<React.ComponentProps<typeof Timeline>>) {
    return render(
      <MemoryRouter>
        <Timeline status="ready" items={[MID]} source="server" canSend={false} {...props} />
      </MemoryRouter>,
    );
  }

  it('does not render the control when the caller passes no paging object', () => {
    renderTimeline({});
    expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull();
  });

  it('does not render the control when there is no older history', () => {
    renderTimeline({ paging: pagingProps({ hasOlder: false }) });
    expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull();
  });

  it('calls onLoadOlder when clicked', () => {
    const onLoadOlder = vi.fn();
    renderTimeline({ paging: pagingProps({ onLoadOlder }) });
    fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('disables the control while a page is in flight', () => {
    renderTimeline({ paging: pagingProps({ loadingOlder: true }) });
    expect(screen.getByRole('button', { name: 'Loading...' })).toBeDisabled();
  });

  it('holds the scroll anchor when older items prepend', () => {
    const { rerender } = renderTimeline({ paging: pagingProps() });
    const el = streamEl();
    stubScroll(el, 500, 100);
    el.scrollTop = 0;
    // A real scroll event is required: assigning .scrollTop fires none in jsdom,
    // and atBottomRef defaults to TRUE, so without this the unfixed code takes
    // the pin-to-bottom branch and the test cannot go red.
    fireEvent.scroll(el);

    fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
    setNum(el, 'scrollHeight', 700); // the prepend grew content ABOVE by 200px
    rerender(
      <MemoryRouter>
        <Timeline
          status="ready"
          items={[OLD, MID]}
          source="server"
          canSend={false}
          paging={pagingProps({ hasOlder: false, olderPagesLoaded: 1 })}
        />
      </MemoryRouter>,
    );

    expect(el.scrollTop).toBe(200); // the bubble they were reading stayed put
  });

  it('raises no "new messages" pill for a prepend', () => {
    const { rerender } = renderTimeline({ paging: pagingProps() });
    const el = streamEl();
    stubScroll(el, 500, 100);
    el.scrollTop = 0;
    fireEvent.scroll(el);

    fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
    setNum(el, 'scrollHeight', 700);
    rerender(
      <MemoryRouter>
        <Timeline
          status="ready"
          items={[OLD, MID]}
          source="server"
          canSend={false}
          paging={pagingProps({ hasOlder: false, olderPagesLoaded: 1 })}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('button', { name: 'Jump to the newest messages' })).toBeNull();
  });

  it('still raises the pill for an APPEND while scrolled up', () => {
    const { rerender } = renderTimeline({});
    const el = streamEl();
    stubScroll(el, 500, 100);
    el.scrollTop = 40;
    fireEvent.scroll(el);

    setNum(el, 'scrollHeight', 700);
    rerender(
      <MemoryRouter>
        <Timeline status="ready" items={[MID, NEW]} source="server" canSend={false} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Jump to the newest messages' })).toBeVisible();
  });

  // [R1] The anchor is consumed only when the HOOK reports a merged older page.
  // An SSE append landing while the older page is in flight must not steal it.
  //
  // NOTE the initial render passes loadingOlder={false}: the control is only
  // named "Load older messages" while it is NOT loading, so a test that renders
  // with loadingOlder={true} cannot find or click it.
  it('does not consume the anchor when an append lands mid-flight', () => {
    const { rerender } = renderTimeline({ paging: pagingProps() });
    const el = streamEl();
    stubScroll(el, 500, 100);
    el.scrollTop = 0;
    fireEvent.scroll(el);

    fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));

    // An inbound message appends BELOW while the older page is still in flight.
    // The counter has NOT moved, so the anchor must survive.
    setNum(el, 'scrollHeight', 600);
    rerender(
      <MemoryRouter>
        <Timeline
          status="ready"
          items={[MID, NEW]}
          source="server"
          canSend={false}
          paging={pagingProps({ loadingOlder: true })}
        />
      </MemoryRouter>,
    );
    // The reader must NOT have been scrolled by content that landed below them,
    // and the pill for it must be raised.
    expect(el.scrollTop).toBe(0);
    expect(screen.getByRole('button', { name: 'Jump to the newest messages' })).toBeVisible();

    // NOW the older page lands: the counter moves. The anchor was re-baselined to
    // the post-append height, so only the prepended 200px moves the reader.
    setNum(el, 'scrollHeight', 800);
    rerender(
      <MemoryRouter>
        <Timeline
          status="ready"
          items={[OLD, MID, NEW]}
          source="server"
          canSend={false}
          paging={pagingProps({ hasOlder: false, olderPagesLoaded: 1 })}
        />
      </MemoryRouter>,
    );
    expect(el.scrollTop).toBe(200);
  });

  // The "Comms only" toggle changes the FIRST rendered item with no prepend at
  // all, because Timeline renders the filtered `visible`, not `items`. It must
  // not be mistaken for one.
  it('does not consume the anchor when a filter change alters the first item', () => {
    const milestone = {
      kind: 'milestone',
      id: 'ms1',
      at: '2026-08-13T08:00:00.000Z',
      type: 'placement_opened',
      label: 'Placement opened',
    } as TimelineItem;
    renderTimeline({ items: [milestone, MID], paging: pagingProps() });
    const el = streamEl();
    stubScroll(el, 500, 100);
    el.scrollTop = 0;
    fireEvent.scroll(el);

    fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));

    // ORDER MATTERS. Clicking "Comms only" re-renders from Timeline's own state,
    // so THAT is the layout pass a first-item-keyed rule would consume on. The
    // shrunk height must be in place BEFORE the click, or the delta is 0 and the
    // test passes under a broken rule as happily as a correct one.
    setNum(el, 'scrollHeight', 400);
    fireEvent.click(screen.getByRole('button', { name: 'Comms only' }));

    // Hiding the milestone dropped the first RENDERED item with no page merged.
    // Counter-keyed: untouched. First-item-keyed: 500 -> 400 would have moved it.
    expect(el.scrollTop).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @housingchoice/dashboard -- src/routes/contact/Timeline.test.tsx`
Expected: FAIL - no button named "Load older messages". Every pre-existing case in the file must still pass. A `ReferenceError` here means the block is using a helper it did not declare; fix the test, not the component.

- [ ] **Step 3: Add the props**

In `dashboard/src/routes/contact/Timeline.tsx`, add to `TimelineProps` (after `readOnlyNote`):

```ts
  /** History paging. Absent on every caller that does not page, which leaves
   *  those timelines visually unchanged. All four members travel together by
   *  construction - see TimelinePaging. */
  paging?: TimelinePaging;
```

and declare the interface above `TimelineProps`:

```ts
/** What a paging caller must supply for the "Load older messages" control.
 *
 *  These four are one unit, not four options. `onLoadOlder` fetches,
 *  `hasOlder` decides whether the control renders, `loadingOlder` disables it
 *  AND disarms a stale scroll anchor, and `olderPagesLoaded` is what tells the
 *  layout pass a prepend actually landed. Supplying a subset yields a control
 *  whose scroll anchoring silently never fires. */
export interface TimelinePaging {
  hasOlder: boolean;
  loadingOlder: boolean;
  /** The hook's count of older pages MERGED so far - monotonic, NEVER reset for
   *  the life of the hook instance. The renderer only compares it to the value
   *  it last saw, so any reset to 0 would read as a fresh prepend and fire a
   *  bogus scroll restore. */
  olderPagesLoaded: number;
  onLoadOlder: () => void | Promise<void>;
}
```

Destructure `paging` in the component body beside the other props.

- [ ] **Step 4: Add the anchor ref and click handler**

Beside the existing scroll refs (around :1100):

```ts
  // [R1] Armed immediately BEFORE an older page is requested, and consumed only
  // when the HOOK reports a merged older page (olderPagesLoaded changed). The
  // signal has to come from the hook: an SSE append grows the list without a
  // prepend, and the "Comms only" toggle changes the first RENDERED item without
  // one, so neither the item count nor the first item id can stand in for it.
  const prependAnchorRef = useRef<number | null>(null);
  const seenOlderPagesRef = useRef(paging?.olderPagesLoaded ?? 0);

  const handleLoadOlder = (): void => {
    const el = streamRef.current;
    // With no scroll container there is nothing to anchor TO. Arming with 0
    // would later scroll by the entire content height.
    prependAnchorRef.current = el ? el.scrollHeight : null;
    void paging?.onLoadOlder();
  };
```

- [ ] **Step 5: Consume the anchor in the layout effect**

Rewrite the `useLayoutEffect` at :1132 as:

```ts
  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    const count = clusters.reduce((n, c) => n + c.items.length, 0);
    const merged = paging?.olderPagesLoaded ?? 0;
    const prepended = merged !== seenOlderPagesRef.current;
    seenOlderPagesRef.current = merged;
    if (prevKeyRef.current !== resetScrollKey) {
      // Switched conversations -> open on the newest item, no carried-over pill.
      prevKeyRef.current = resetScrollKey;
      prevCountRef.current = count;
      atBottomRef.current = true;
      prependAnchorRef.current = null;
      el.scrollTop = el.scrollHeight;
      setHasNewBelow(false);
      return;
    }
    const anchor = prependAnchorRef.current;
    if (anchor !== null && prepended) {
      // The prepend landed: restore the offset so the bubble the operator was
      // reading does not move, and never treat it as "new below".
      prependAnchorRef.current = null;
      prevCountRef.current = count;
      el.scrollTop += el.scrollHeight - anchor;
      return;
    }
    const grew = count > prevCountRef.current;
    prevCountRef.current = count;
    if (anchor !== null) {
      // Something ELSE changed the height while the older page is in flight - an
      // append, a filter toggle, a retry collapse. Re-baseline so the eventual
      // restore delta counts only the prepended content.
      prependAnchorRef.current = el.scrollHeight;
    }
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setHasNewBelow(false);
    } else if (grew) {
      setHasNewBelow(true);
    }
  }, [clusters, resetScrollKey, paging?.olderPagesLoaded]);
```

`paging?.olderPagesLoaded` MUST be in the dep array: the merge and the counter
bump land in the same commit, but a render where only the counter changed must
still be able to consume the anchor.

The consume branch `return`s before the pill logic and absorbs the new count into
`prevCountRef`. That is deliberate for the prepend itself, and it is also the
mechanism behind the accepted residual in spec 4.5: if an append and the prepend
land in the SAME batched render, the appended message's pill is swallowed as well
as its height being counted. Neither loses content, and both require an inbound
message to arrive inside the older page's flight window.

Then add a settle effect below it, so an older page that returns NOTHING (or whose
entries are all filtered out by "Comms only" / retry-collapse, which means the
layout effect may not run at all) cannot leave a stale anchor armed:

```ts
  // Clear a stale anchor once the load settles. Runs after paint, so the layout
  // effect above has already had its chance to consume it.
  useEffect(() => {
    if (paging?.loadingOlder !== true) prependAnchorRef.current = null;
  }, [paging?.loadingOlder]);
```

- [ ] **Step 6: Render the control OUTSIDE the scroll container**

In the JSX at :1246, insert the control as the FIRST child of `.streamWrap`,
ABOVE `<div className={styles.stream}>` - not inside it:

```tsx
      <div className={styles.streamWrap}>
        {status === 'ready' && paging?.hasOlder === true ? (
          <div className={styles.loadOlderRow}>
            <button
              type="button"
              className={styles.loadOlder}
              onClick={handleLoadOlder}
              disabled={paging.loadingOlder}
            >
              {paging.loadingOlder ? 'Loading...' : 'Load older messages'}
            </button>
          </div>
        ) : null}
        <div className={styles.stream} ref={streamRef} onScroll={handleStreamScroll}>
```

[R2] It must stay OUTSIDE `.stream`. Inside, it would contribute to
`el.scrollHeight` and then unmount in the same commit as the final prepend (the
pass where `hasOlder` flips false), so the restored offset would under-shoot by
the control's own height on the last "Load older" of every thread.

- [ ] **Step 7: Add the styles**

Append to `dashboard/src/routes/contact/Timeline.module.css`, modeled on the
existing `.loadMore` in `routes/broadcasts/BroadcastsList.module.css`:

```css
.loadOlderRow {
  display: flex;
  justify-content: center;
  padding: var(--sp-2) 0;
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
control sits outside the scroll container so its own unmount cannot skew
the restored offset, and the prepend anchor is keyed to the first rendered
item id so a live message arriving mid-flight cannot consume it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 7: Wire the control into the five surfaces

**All five files need edits.** Nothing inherits the control at the JSX layer: tour
and placement mount `useRelayThread` and `ContactCommsTab`, so they inherit the
paging at the HOOK layer, but each renders `<Timeline>` directly and hand-lists
every prop. `ContactCommsPane` is the one genuine single-edit win - it receives the
whole `ContactTimelineState` and all three of its owners pass it whole.

**Files:**
- Modify: `dashboard/src/routes/conversation/ConversationDetail.tsx:465`
- Modify: `dashboard/src/routes/conversation/GroupTextView.tsx:434`
- Modify: `dashboard/src/routes/contact/ContactCommsPane.tsx:319`
- Modify: `dashboard/src/routes/tours/TourConversation.tsx:464`
- Modify: `dashboard/src/routes/placements/PlacementConversation.tsx:320`

**Interfaces:**
- Consumes: `hasOlder` / `loadingOlder` / `loadOlder` / `olderPagesLoaded` from Tasks 3-5; the `paging?: TimelinePaging` prop from Task 6.
- Produces: no new interfaces.

Every site passes the SAME shape, so `tsc` rejects a half-wired surface:

```tsx
              paging={{
                hasOlder: <state>.hasOlder,
                loadingOlder: <state>.loadingOlder,
                olderPagesLoaded: <state>.olderPagesLoaded,
                onLoadOlder: <state>.loadOlder,
              }}
```

- [ ] **Step 1: Pass the props from the relay view**

In `ConversationDetail.tsx`, add to the `<Timeline>` element (the hook is already bound as `thread`):

```tsx
            paging={{
              hasOlder: thread.hasOlder,
              loadingOlder: thread.loadingOlder,
              olderPagesLoaded: thread.olderPagesLoaded,
              onLoadOlder: thread.loadOlder,
            }}
```

- [ ] **Step 2: Pass the props from the group view**

In `GroupTextView.tsx`, on its `<Timeline>` element, using that file's hook binding name:

```tsx
            paging={{
              hasOlder: thread.hasOlder,
              loadingOlder: thread.loadingOlder,
              olderPagesLoaded: thread.olderPagesLoaded,
              onLoadOlder: thread.loadOlder,
            }}
```

- [ ] **Step 3: Pass the props from the contact comms pane**

`ContactCommsPane` receives the hook state from its caller rather than owning it.
Pass through from the same state object it already reads `status` and `items`
from, using the prop name that file actually binds - do not rename it:

```tsx
        paging={{
          hasOlder: timeline.hasOlder,
          loadingOlder: timeline.loadingOlder,
          olderPagesLoaded: timeline.olderPagesLoaded,
          onLoadOlder: timeline.loadOlder,
        }}
```

- [ ] **Step 4: Pass the paging object from the tour hub**

`TourConversation.tsx:464` renders `<Timeline>` directly with `thread` bound from
`useRelayThread`. Add the same `paging={{ ... }}` object as Step 1, all four
members.

- [ ] **Step 5: Pass the paging object from the placement hub**

`PlacementConversation.tsx:320` has the same shape. Add the same `paging={{ ... }}`
object, all four members.

- [ ] **Step 6: Run the full unit suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

Bare `git status` first, confirm no listed file is left dirty, then:

```bash
git commit -F - -- dashboard/src/routes/conversation/ConversationDetail.tsx dashboard/src/routes/conversation/GroupTextView.tsx dashboard/src/routes/contact/ContactCommsPane.tsx dashboard/src/routes/tours/TourConversation.tsx dashboard/src/routes/placements/PlacementConversation.tsx <<'EOF'
feat(threads): wire Load older into all five Timeline surfaces

Tour and placement inherit the paging at the hook layer but render
<Timeline> directly, so they need the props passed explicitly - they are
the operator's most-open pages and would otherwise ship without the
control.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 8: End-to-end proof

The spec's decision (section 5.2): the spec builds its own long thread rather
than touching the byte-stable lean seed world, and never calls
`POST /__dev/performance/reseed`, which would wipe the world out from under every
other spec in the run.

**It must target a RELAY GROUP, not a 1:1.** `/conversations/:id` REDIRECTS a
plain 1:1 to its owning contact page (the `<Navigate>` fall-through at
`ConversationDetail.tsx:155-159`; :5-8 is only the file-header comment), which runs
`useContactTimeline` - the authoritative-cursor path. Proving paging there would
leave `before` paging and the section 4.4 heuristic, the riskier half of the
change, with no end-to-end coverage at all. A relay group renders `useRelayThread`
directly at its own URL.

Accepted coverage gap, stated rather than hidden: the contact-timeline cursor path
is covered by unit tests only (Task 5).

**Files:**
- Create: `e2e/tests/dashboard-next/thread-history-paging.spec.ts`

**Interfaces:**
- Consumes: `createGroupOpen(page, members)` from `e2e/fixtures/relayConnect.ts:162`, which returns `{ conversationId, status: 'open', pool_number }`; `postInboundSms(request, { from, body, messageSid, to? })` from `e2e/fixtures/fakeTwilio.ts:54`.
- Produces: nothing.

- [ ] **Step 1: Write the spec**

Create `e2e/tests/dashboard-next/thread-history-paging.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test';
import { createGroupOpen } from '../../fixtures/relayConnect.js';
import { postInboundSms } from '../../fixtures/fakeTwilio.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

// Per-run-unique identifiers are MANDATORY here, not stylistic. The hermetic
// launcher reuses its DynamoDB container across boots and never clears it, so
// `sid#<providerSid>` inbound-dedup pointers accumulate forever
// (e2e/support/preflight.ts). A hardcoded MessageSid makes every run after the
// first silently DROP its inbounds, and a hardcoded number reuses the previous
// run's conversation so the message count keeps growing.
let seq = 0;
function uniquePhone(): string {
  seq += 1;
  return `+1555${`${Date.now()}`.slice(-5)}${String(seq).padStart(2, '0')}`;
}
function uniqueSid(tag: string): string {
  seq += 1;
  return `SMhist${tag}${Date.now()}${seq}`;
}

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

const TOTAL = 55; // > the 50-entry page, so exactly one older page exists

test('staff can reach relay-group messages older than the newest page', async ({ page }) => {
  // The default per-test budget is 30s with retries: 0, and createGroupOpen's
  // FRESH path alone polls up to 30s for a warming pool number and then up to
  // 60s for the group to open - before this spec sends 55 inbounds.
  test.setTimeout(180_000);
  await devLogin(page);

  // TWO members: every existing createGroupOpen caller passes two or three, and
  // the fixture describes the fresh path as "a fresh pair".
  const member = uniquePhone();
  const landlord = uniquePhone();
  const group = await createGroupOpen(page, [
    { phone: member, name: 'History Probe' },
    { phone: landlord, name: 'History Landlord' },
  ]);

  // Build the long thread. Sequential: each inbound needs a unique SID and the
  // ORDER is what the assertions depend on.
  for (let i = 0; i < TOTAL; i += 1) {
    const res = await postInboundSms(page.request, {
      from: member,
      to: group.pool_number,
      body: `history probe ${i}`,
      messageSid: uniqueSid(`${i}`),
    });
    expect(res.status, `inbound ${i} accepted`).toBe(200);
  }

  await page.goto(`${NEXT}/conversations/${group.conversationId}`);

  // The newest page is present; the oldest message is beyond it.
  await expect(page.getByText(`history probe ${TOTAL - 1}`)).toBeVisible();
  await expect(page.getByText('history probe 0')).toHaveCount(0);

  const loadOlder = page.getByRole('button', { name: 'Load older messages' });
  await expect(loadOlder).toBeVisible();
  await loadOlder.click();

  // The oldest message is now reachable and the control has retired for good -
  // assert on BOTH labels, since an in-flight control is merely relabeled.
  await expect(page.getByText('history probe 0')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load older messages' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Loading...' })).toHaveCount(0);
});
```

- [ ] **Step 2: Run the new spec alone first**

Run the e2e suite filtered to this spec, from the e2e workspace, per
`e2e/README.md`. Expected: PASS.

If the inbound messages do not appear, check `e2e/support/preflight.ts` first:
the fake-twilio dedup pointer is a known cause of an inbound that creates the
contact but drops the message. If `createGroupOpen` times out waiting for the
group to open, that is the multi-hop connect chain under parallel load, not this
change - it has a 60s poll for exactly that reason.

- [ ] **Step 3: Commit**

Bare `git status` first, then:

```bash
git commit -F - -- e2e/tests/dashboard-next/thread-history-paging.spec.ts <<'EOF'
test(e2e): prove staff can reach history older than the newest page

Targets a relay group, whose URL renders useRelayThread directly - the
before-paging path with the heuristic hasOlder. A 1:1 would redirect to the
contact page and only exercise the cursor path. Builds its own 55-message
thread with per-run-unique ids rather than touching the lean seed world.

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
`main` is moving under an active import mission, so expect drift. If syncing could
conflict with active work, ask before resolving blind.

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

1. The control appears above the stream and nowhere else.
2. Clicking it does not move the bubble you were reading.
3. No "New messages" pill appears from the prepend.
4. A live inbound message still appends and still raises the pill when you are
   scrolled up.
5. Loaded history survives that inbound - nothing vanishes from the middle.
6. **The overlap case:** click "Load older messages" and, while it is in flight,
   have a live inbound land. The reader must not jump, the inbound must raise its
   own pill, and the older page must then land without moving the reader further
   than the prepended content. This is the case unit tests cover but only a live
   run proves.
7. Switch to a different thread and back: no transcript from the first thread
   appears in the second.

- [ ] **Step 6: Report**

Report the branch, the commit count, the gate results verbatim, and anything
deliberately left out (the contact-timeline e2e gap from Task 8 is one). Do not
merge - merging to `main` requires explicit human approval.

---

## Self-Review

**Spec coverage.** Section 4.1 merge rule - Task 1, applied in Tasks 3-5. Section
4.2 API client - Task 2. Section 4.3 hooks, including the raw-page bound and the
`refresh()` replace - Tasks 3, 4, 5. Section 4.4 heuristic and its recorded
trade-off - Task 3 Step 3 and Task 4 Step 3 (code comments), with the
exact-cursor contrast in Task 5. Section 4.5 Timeline UI, out-of-container
placement, and id-keyed anchoring - Task 6. Section 4.6 plumbing, all five files
- Task 7. Section 5.1 unit tests - Tasks 1, 3, 4, 5, 6. Section 5.2 e2e - Task 8.
Section 5.3 gates - Task 9. Section 3 decision 6 (fallback shows no button) -
Task 5 Step 1. No spec section is unimplemented.

**Type consistency.** The three hook members are named `hasOlder`,
`loadingOlder`, and `loadOlder` in every task and in `TimelineProps`
(`onLoadOlder` for the callback prop, deliberately distinct from the hook's
`loadOlder`). `THREAD_PAGE_SIZE` and `mergeTimelineItems` carry the same names in
Task 1 and in every consumer. The cursor is `cursorRef` in Task 5 only and never
appears on any public type.

**Known judgment calls left to the implementer.** Task 7 Step 3 says to use the
prop name `ContactCommsPane` already binds rather than guessing one. Task 8 Step
2's failure triage names the two known causes rather than prescribing a fix.
Both are "read the file and match it" instructions, not placeholders.
