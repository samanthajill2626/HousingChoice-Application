# Inbox Rows and Timestamps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: v1 - DRAFT, pending adversarial plan review
Date: 2026-09-25
Branch: `feat/inbox-rows-timestamps`
Worktree: `W:\tmp\inbox-rows-timestamps`
Base: `main` at `cd8e8ddd15158e532d452383015f4e57115ff1d1`

**Goal:** The inbox shows 100 conversations per page with auto-load on scroll,
a four-tier last-activity time on every row, an instant back-button restore
of page one and the scroll position, and a visible banner when a background
refresh fails.

**Architecture:** The dashboard's `useInbox` hook is rebuilt around one
authoritative `ListState` (head page + loaded pages) written only through
`commitList`, which mirrors state into a ref and saves a snapshot to a
module-level store keyed by operator, filter and page size. A pure merge module
decides how a head read applies (a complete page replaces the list, an
incomplete one merges in). A small observer hook drives auto-load from
intersection state and a commit epoch. The server's `filter=all` page prefetches
its per-row reads through promise-memoized caches without touching the decision
loop.

**Tech Stack:** React 19, TypeScript ESM, CSS Modules, react-router-dom 7,
Vitest + Testing Library (jsdom), Playwright, Express + DynamoDB Local (app).

**Spec:** `docs/superpowers/specs/2026-09-25-inbox-rows-timestamps-design.md`
(DRAFT 8). Every section number below refers to it.

## Global Constraints

- `DEFAULT_PAGE_LIMIT = 100`, `MAX_PAGE_LIMIT = 100` (client); the server's
  `MAX_INBOX_LIMIT` is 100 and is not changed. `limitFromParam` honors an
  integer 1..100 and FALLS BACK to 100 for anything else (spec 5.1).
- Time tiers (spec 3.2): same local day `2:14 PM`; previous local day
  `Yesterday`; earlier this local year `Sep 12`; other years `Sep 12, 2025`.
  Full stamp `Sep 12, 2026, 2:14 PM`. U+202F and U+00A0 in formatter output
  become U+0020. Unparseable input yields `''` and no `<time>` element.
- Narrow layout media query is exactly `@media (max-width: 767.98px)` (spec
  5.4). Desktop `<time>`: `min-width: 5rem`. `.head` one-line cap
  `max-width: 45%`, reset to `none` inside the narrow query. `.actions` is an
  absolute overlay with no layout width. The Inbox page root gets
  `overflow-anchor: none` (spec 5.2).
- Store key is `${operatorId}:${filter}:${limit}`; `operatorId` is
  `me.userId` or `'anon'`. The snapshot holds `head`, `tail`, `cursor`,
  `groupsTruncated`, `truncated`, `scrollTop` and NOT `autoLoadArmed` (spec 5.8).
- `IntersectionObserver` root margin `'400px 0px'`. `useAutoLoad` fires from
  an effect over `[intersecting, enabled, epoch]` only when
  `enabled && intersecting` and (intersecting just became true OR epoch
  changed since the last fire). `enabled = hasMore && autoLoadArmed &&
  !loadingMore` (spec 5.2).
- `pageEpoch` bumps ONLY on a committed head read and a committed `loadMore`
  page (spec 5.2).
- `headComplete := !truncated && (C === null || pagedP.length >= limit)` where
  `pagedP` excludes All-tab relay/group rows (spec 5.6).
- Banner copy is exactly `Couldn't refresh the inbox.` with a button whose
  accessible name is `Retry refresh`; `role="status"` (spec 5.7).
- `HYDRATE_CONCURRENCY = 8` (spec 5.10). The server decision loop, its
  telemetry and its cursor bookkeeping are byte-identical with prefetch on or
  off.
- Do NOT edit: `app/src/services/sendMessage.ts`,
  `app/src/services/scheduledSendSuppression.ts`, `app/src/routes/broadcasts.ts`,
  `app/src/repos/broadcastsRepo.ts`, `app/src/repos/messagesRepo.ts`,
  `app/src/repos/conversationsRepo.ts`, `app/src/jobs/broadcastFanOut.ts`,
  `app/src/jobs/retrySend.ts`, `app/src/jobs/relay*.ts`,
  `app/src/adapters/messaging.ts`, `app/src/routes/webhooks/twilio.ts`,
  `app/src/routes/api.ts`, `app/src/routes/contactTimeline.ts`,
  `app/src/lib/import/**`, `app/src/lib/seed/**`,
  `dashboard/src/routes/contact/Timeline.tsx`,
  `dashboard/src/routes/contact/deliveryStatus.ts`,
  `dashboard/src/routes/broadcasts/**`, `RUNBOOK.md`. Hub files
  `dashboard/src/api/types.ts`, `client.ts`, `endpoints.ts`: additive edits
  only (spec 4.2). If a task needs an excluded file, STOP and report.
- No wire-shape change to `InboxRow` / `InboxPage`. No message-catalog copy.
- New or touched lines are ASCII-only. Before every commit read bare
  `git status` and check `.git/MERGE_HEAD` is absent; stage only the explicit
  paths named by the task. Every commit ends with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Playwright runs only through the root `npm run e2e` (full) or
  `npm run e2e:session` (interactive); never against `:5174` / `:8080`. Do not
  run the full suite while an interactive session is live in this worktree.
- Gate commands are run BARE from `W:\tmp\inbox-rows-timestamps` (never piped).

## Review Focus

Inputs the spec implies but no task's tests would otherwise exercise, most
likely to bite first; each is pinned in the owning task below.

1. A row whose `lastActivityAt` is a valid ISO instant in a different UTC day
   than its local day (an evening text): the label must follow the LOCAL day
   (Task 1 pins it with a local-time constructor and an offset guard).
2. A snapshot saved under one operator restored by another in the same tab
   after sign-out: must never render (Task 3 pins the key and the AuthGate
   clear ordering).
3. A head read that returns ZERO rows with a cursor on the Unknown tab while
   rows are rendered: must change nothing and show no banner (Task 4 pins
   branch I; Task 5 pins `refreshFailed` false).
4. A `loadMore` that settles after the Inbox unmounted: must neither commit
   nor save (Task 5).
5. The sentinel returning after `hasMore` was false with a stale
   `intersecting = true`: must not fire before the observer reports (Task 6).

## File Structure

- Create `dashboard/src/routes/inbox/inboxTime.ts` - the two pure formatters.
- Create `dashboard/src/routes/inbox/inboxTime.test.ts`.
- Modify `dashboard/src/routes/inbox/InboxRow.tsx` - the `<time>` element.
- Modify `dashboard/src/routes/inbox/InboxRow.module.css` - time, head cap,
  actions overlay, narrow two-row grid.
- Modify `dashboard/src/routes/inbox/InboxRow.test.tsx`.
- Create `dashboard/src/routes/inbox/inboxListStore.ts` - the module store.
- Create `dashboard/src/routes/inbox/inboxListStore.test.ts`.
- Modify `dashboard/src/app/AuthContext.tsx` - additive `useOptionalAuth`.
- Modify `dashboard/src/app/AuthGate.tsx` - the store clear effect.
- Create `dashboard/src/app/AuthGate.test.tsx`.
- Create `dashboard/src/routes/inbox/inboxListMerge.ts` - `ListState`,
  `mergeHeadRead`, `appendPage`, `dedupeConversations`.
- Create `dashboard/src/routes/inbox/inboxListMerge.test.ts`.
- Modify `dashboard/src/routes/inbox/useInbox.ts` - the rebuilt hook.
- Modify `dashboard/src/routes/inbox/useInbox.test.tsx`.
- Create `dashboard/src/routes/inbox/useAutoLoad.ts` and
  `useAutoLoad.test.tsx`.
- Modify `dashboard/src/routes/inbox/Inbox.tsx`, `Inbox.module.css`,
  `Inbox.test.tsx` - limit param, operator id, sentinel, banner, scroll
  restore, groups link.
- Modify `app/src/routes/inbox.ts` - promise caches + prefetch window on the
  `filter=all` pager (separable; Task 8).
- Modify `app/test/inboxFeed.test.ts` - equivalence, cache and stop tests.
- Create `e2e/tests/dashboard-next/inbox-rows-timestamps.spec.ts`.
- Modify `docs/issues/inbox-reconcile-failure-blanks-list.md`,
  `docs/issues/seen-set-max-equals-max-inbox-limit.md`; create three
  follow-up issues (Task 10).
- Records go to `docs/superpowers/reviews/2026-09-25-inbox-rows-timestamps/`
  as produced; `.superpowers/` holds only ignored run state.

Task order: 1, 2, 3, 4, 5, 6, 7 (dashboard, each self-gating with
`npm run test -w @housingchoice/dashboard` and `npm run typecheck`), then 8
(server), 9 (Playwright), 10 (issues), 11 (gates). Task 8 can be dropped
without touching any other task (spec 5.10).

---

### Task 1: The time label formatter

**Files:**
- Create: `dashboard/src/routes/inbox/inboxTime.ts`
- Create: `dashboard/src/routes/inbox/inboxTime.test.ts`

**Interfaces:**
- Consumes: `isoOf(value: string): string` from `dashboard/src/lib/time.ts`.
- Produces: `formatInboxTime(iso: string, now: Date): string` and
  `formatInboxTimeFull(iso: string): string`, both exported; `''` for an
  unparseable instant.

- [ ] **Step 1: Write the failing tests**

Create `dashboard/src/routes/inbox/inboxTime.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatInboxTime, formatInboxTimeFull } from './inboxTime.js';

// Every instant is built with the LOCAL-time constructor so the tier logic is
// exercised in whatever zone the runner has (spec 5.3: local calendar days).
const now = new Date(2026, 8, 25, 15, 30); // Sep 25 2026 15:30 local
const iso = (d: Date): string => d.toISOString();

describe('formatInboxTime', () => {
  it('same local day -> clock time with a plain space before AM/PM', () => {
    expect(formatInboxTime(iso(new Date(2026, 8, 25, 14, 14)), now)).toBe('2:14 PM');
    expect(formatInboxTime(iso(new Date(2026, 8, 25, 0, 5)), now)).toBe('12:05 AM');
  });

  it('a minute after local midnight is today; a minute before is Yesterday', () => {
    expect(formatInboxTime(iso(new Date(2026, 8, 25, 0, 1)), now)).toBe('12:01 AM');
    expect(formatInboxTime(iso(new Date(2026, 8, 24, 23, 59)), now)).toBe('Yesterday');
  });

  it('the previous local day -> Yesterday regardless of hour', () => {
    expect(formatInboxTime(iso(new Date(2026, 8, 24, 9, 0)), now)).toBe('Yesterday');
  });

  it('earlier this local year -> month and day', () => {
    expect(formatInboxTime(iso(new Date(2026, 8, 12, 9, 0)), now)).toBe('Sep 12');
    expect(formatInboxTime(iso(new Date(2026, 0, 1, 0, 0)), now)).toBe('Jan 1');
  });

  it('another year -> month, day and year', () => {
    expect(formatInboxTime(iso(new Date(2025, 11, 31, 23, 59)), now)).toBe('Dec 31, 2025');
    expect(formatInboxTime(iso(new Date(2025, 8, 12, 9, 0)), now)).toBe('Sep 12, 2025');
  });

  it('two days ago is a date, never a weekday', () => {
    expect(formatInboxTime(iso(new Date(2026, 8, 23, 9, 0)), now)).toBe('Sep 23');
  });

  it('a future instant today is a clock time; a future day is a date', () => {
    expect(formatInboxTime(iso(new Date(2026, 8, 25, 23, 0)), now)).toBe('11:00 PM');
    expect(formatInboxTime(iso(new Date(2026, 8, 26, 1, 0)), now)).toBe('Sep 26');
  });

  // Review Focus 1: the local day, not the UTC day, decides the tier. Only
  // meaningful off UTC; skipped with a reason on a UTC runner.
  it('an instant whose UTC date differs from its local date follows the local date', (ctx) => {
    if (new Date(2026, 8, 25).getTimezoneOffset() === 0) {
      ctx.skip();
      return;
    }
    const lateLocal = new Date(2026, 8, 25, 23, 30);
    expect(formatInboxTime(iso(lateLocal), now)).toBe('11:30 PM');
  });

  it('accepts a #-suffixed sort key by normalizing it', () => {
    expect(formatInboxTime(`${iso(new Date(2026, 8, 25, 14, 14))}#abc`, now)).toBe('2:14 PM');
  });

  it('returns an empty string for an unparseable instant', () => {
    expect(formatInboxTime('not-a-date', now)).toBe('');
    expect(formatInboxTime('', now)).toBe('');
  });
});

describe('formatInboxTimeFull', () => {
  it('renders month, day, year and clock time', () => {
    expect(formatInboxTimeFull(iso(new Date(2026, 8, 12, 14, 14)))).toBe('Sep 12, 2026, 2:14 PM');
  });
  it('returns an empty string for an unparseable instant', () => {
    expect(formatInboxTimeFull('nope')).toBe('');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `W:\tmp\inbox-rows-timestamps`:

```
npx vitest run src/routes/inbox/inboxTime.test.ts --root dashboard
```

Expected: FAIL - "Failed to resolve import "./inboxTime.js"".

- [ ] **Step 3: Write the formatter**

Create `dashboard/src/routes/inbox/inboxTime.ts`:

```ts
// inboxTime - the last-activity label on an inbox row (spec 5.3). Four tiers
// by LOCAL calendar day: today -> "2:14 PM", the previous day -> "Yesterday",
// earlier this year -> "Sep 12", other years -> "Sep 12, 2025". An
// unparseable instant answers '' (the formatTime contract in contact/format.ts)
// and the row renders no <time> at all.
//
// The en-US formatters may emit U+202F (narrow no-break space) before AM/PM on
// ICU 72+ hosts; app/src/lib/localTime.ts normalizes the same thing on the
// server. Every label here carries a plain U+0020 so tests, e2e regexes and
// copy-paste behave the same on every host.
import { isoOf } from '../../lib/time.js';

const NBSP_LIKE = /[\u202f\u00a0]/g;

function parse(iso: string): Date | undefined {
  const d = new Date(isoOf(iso));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function plainSpaces(s: string): string {
  return s.replace(NBSP_LIKE, ' ');
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** The tier label for a row's lastActivityAt, relative to `now` (local days). */
export function formatInboxTime(iso: string, now: Date): string {
  const d = parse(iso);
  if (d === undefined) return '';
  if (sameLocalDay(d, now)) {
    return plainSpaces(d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }));
  }
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameLocalDay(d, yesterday)) return 'Yesterday';
  if (d.getFullYear() === now.getFullYear()) {
    return plainSpaces(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  }
  return plainSpaces(
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
  );
}

/** The full stamp for the row's hover title, e.g. "Sep 12, 2026, 2:14 PM". */
export function formatInboxTimeFull(iso: string): string {
  const d = parse(iso);
  if (d === undefined) return '';
  return plainSpaces(
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }),
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```
npx vitest run src/routes/inbox/inboxTime.test.ts --root dashboard
```

Expected: PASS, 12 tests (11 on a UTC runner with 1 skipped).

- [ ] **Step 5: Commit**

Read bare `git status`; confirm `.git/MERGE_HEAD` is absent. Then:

```
git add dashboard/src/routes/inbox/inboxTime.ts dashboard/src/routes/inbox/inboxTime.test.ts
git commit -m "feat(inbox): four-tier last-activity time formatter

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 2: The row shows its time; the actions box becomes an overlay

**Files:**
- Modify: `dashboard/src/routes/inbox/InboxRow.tsx`
- Modify: `dashboard/src/routes/inbox/InboxRow.module.css`
- Modify: `dashboard/src/routes/inbox/InboxRow.test.tsx`

**Interfaces:**
- Consumes: `formatInboxTime`, `formatInboxTimeFull` (Task 1).
- Produces: a `<time class="time" dateTime=... title=...>` element as the last
  child of the row's link; CSS classes `time`, `head`, `actions` with the spec
  5.4 rules. Props of `InboxRow` are unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/src/routes/inbox/InboxRow.test.tsx`, inside the existing
`describe('InboxRow', ...)` block (before its closing `});`):

```ts
  describe('the last-activity time (spec 5.4)', () => {
    // setup.ts pins Date to 2026-07-01T12:00:00Z; the fixture row is
    // 2026-06-17, earlier the same year -> "Jun 17".
    it('renders a <time> with dateTime, a full-stamp title and the tier label', () => {
      renderRow(mkRow({ unreadCount: 0 }));
      const link = screen.getByRole('link', { name: /Tasha Williams/ });
      const time = link.querySelector('time');
      expect(time).not.toBeNull();
      expect(time).toHaveAttribute('dateTime', '2026-06-17T10:00:00.000Z');
      expect(time?.getAttribute('title')).toMatch(/^Jun 17, 2026, \d{1,2}:\d{2} [AP]M$/);
      expect(time).toHaveTextContent(/^Jun 17$/);
    });

    it('marks the time on an unread row and not on a read row', () => {
      renderRow(mkRow({ unreadCount: 3 }));
      const unreadTime = screen.getByRole('link', { name: /Tasha Williams/ }).querySelector('time');
      expect(unreadTime?.closest('div')?.className).toMatch(/unread/);
      cleanupAndRender(mkRow({ unreadCount: 0 }));
      const readTime = screen.getByRole('link', { name: /Tasha Williams/ }).querySelector('time');
      expect(readTime?.closest('div')?.className).not.toMatch(/unread/);
    });

    it('renders the time on relay_group and group_text rows too', () => {
      renderRow(
        mkRow({
          kind: 'relay_group',
          contactId: undefined,
          conversationId: 'conv-relay-1',
          name: 'With Ana & Ben',
          status: 'open',
          lastActivityAt: '2026-06-30T10:00:00.000Z',
        }),
      );
      expect(screen.getByRole('link', { name: /With Ana/ }).querySelector('time')).toHaveTextContent(
        /^Jun 30$/,
      );
      cleanupAndRender(
        mkRow({
          kind: 'group_text',
          contactId: undefined,
          conversationId: 'conv-group-1',
          name: 'Ana & Ben',
          lastActivityAt: '2025-12-18T10:00:00.000Z',
        }),
      );
      expect(screen.getByRole('link', { name: /Ana & Ben/ }).querySelector('time')).toHaveTextContent(
        /^Dec 18, 2025$/,
      );
    });

    it('renders NO <time> for an unparseable instant', () => {
      renderRow(mkRow({ lastActivityAt: 'garbage' }));
      expect(screen.getByRole('link', { name: /Tasha Williams/ }).querySelector('time')).toBeNull();
    });

    it('keeps the Mark read / Mark unread actions and their names', () => {
      renderRow(mkRow({ unreadCount: 1 }));
      expect(screen.getByRole('button', { name: 'Mark Tasha Williams read' })).toBeInTheDocument();
    });
  });
```

And add this helper next to `renderRow` (module scope):

```ts
import { cleanup } from '@testing-library/react';

function cleanupAndRender(row: InboxRowData): void {
  cleanup();
  renderRow(row);
}
```

(`cleanup` is already exported by `@testing-library/react`; merge it into the
existing import line rather than adding a second import of the same module.)

- [ ] **Step 2: Run the tests to verify they fail**

```
npx vitest run src/routes/inbox/InboxRow.test.tsx --root dashboard
```

Expected: FAIL - the first new test fails with `expected null not to be null`
(no `<time>` rendered yet).

- [ ] **Step 3: Render the time in the row**

In `dashboard/src/routes/inbox/InboxRow.tsx`:

Add the import after the `styles` import:

```ts
import { formatInboxTime, formatInboxTimeFull } from './inboxTime.js';
```

Inside `InboxRow`, after `const isMultiParty = isRelay || isGroupText;`:

```ts
  // The last-activity label (spec 5.3/5.4): computed at render; tests pin the
  // clock with vi.setSystemTime. An unparseable instant renders no element.
  const timeLabel = formatInboxTime(row.lastActivityAt, new Date());
  const timeFull = formatInboxTimeFull(row.lastActivityAt);
```

Replace the unread-count block (the `{unread ? (<span className={styles.count} ...>) : null}`
element) with the same block followed by the time element, so the link's
children end:

```tsx
          {unread ? (
            <span className={styles.count} aria-label={`${row.unreadCount} unread`}>
              {row.unreadCount}
            </span>
          ) : null}
          {timeLabel !== '' ? (
            <time className={styles.time} dateTime={row.lastActivityAt} title={timeFull}>
              {timeLabel}
            </time>
          ) : null}
        </Link>
```

- [ ] **Step 4: Restyle the row**

Replace the whole of `dashboard/src/routes/inbox/InboxRow.module.css` with:

```css
/* InboxRow - a contact/unknown/group comms row. All values from ui/tokens.css.
   Spec 5.4: one line on desktop with the time at the far right; two lines under
   the shell's narrow breakpoint; the actions box is an OVERLAY that takes no
   layout width so the times line up in one column on every row. */
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
.dot_partner {
  background: var(--c-dot-partner);
}
.dot_unknown {
  background: var(--c-dot-unknown);
}

/* The name can shrink on one line (spec 5.4): the cap resolves against the
   link, the head's flex container; chips and tags never shrink. */
.head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex: 0 1 auto;
  min-width: 0;
  max-width: 45%;
}
.name {
  font-weight: var(--fw-medium);
  color: var(--c-text);
  white-space: nowrap;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bold {
  font-weight: var(--fw-bold);
}
.channel {
  font-size: var(--fs-xs);
  color: var(--c-text-subtle);
  white-space: nowrap;
}
.tag {
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

/* Deleted-contact resurfacing: danger-tinted so the row reads as "deleted, but
   they messaged you". */
.deletedTag {
  padding: 1px var(--sp-2);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--c-danger) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-danger) 30%, transparent);
  color: var(--c-danger);
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

/* The last-activity time: a right-aligned column; 5rem holds "Dec 18, 2025". */
.time {
  flex: 0 0 auto;
  min-width: 5rem;
  text-align: right;
  white-space: nowrap;
  font-size: var(--fs-xs);
  color: var(--c-text-muted);
}
.unread .time {
  color: var(--c-text);
  font-weight: var(--fw-semibold);
}

/* Inline actions - an OVERLAY over the row's right end. Present + focusable
   always; visible on hover / focus-within / swipe. No layout width, so the
   time column is straight whatever button the row offers. */
.actions {
  position: absolute;
  right: var(--sp-3);
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  gap: var(--sp-1);
  padding-left: var(--sp-3);
  background: var(--c-surface);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}
.row:hover .actions,
.row:focus-within .actions,
.revealed .actions {
  opacity: 1;
  pointer-events: auto;
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

/* Narrow: the shell's own breakpoint (below it the sidebar is a drawer). Two
   rows: name/chips/time on top, preview/count below. */
@media (max-width: 767.98px) {
  .main {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-rows: auto auto;
    column-gap: var(--sp-2);
    row-gap: 2px;
    align-items: center;
  }
  .dot {
    grid-column: 1;
    grid-row: 1;
  }
  .head {
    grid-column: 2;
    grid-row: 1;
    max-width: none;
  }
  .time {
    grid-column: 3;
    grid-row: 1;
    min-width: 0;
  }
  .preview {
    grid-column: 2;
    grid-row: 2;
  }
  .count {
    grid-column: 3;
    grid-row: 2;
    justify-self: end;
  }
}
```

- [ ] **Step 5: Run the row tests to verify they pass**

```
npx vitest run src/routes/inbox/InboxRow.test.tsx --root dashboard
```

Expected: PASS (the 16 existing tests plus 5 new).

- [ ] **Step 6: Typecheck and commit**

```
npm run typecheck
```

Expected: exit 0. Then read bare `git status`, confirm no `MERGE_HEAD`, and:

```
git add dashboard/src/routes/inbox/InboxRow.tsx dashboard/src/routes/inbox/InboxRow.module.css dashboard/src/routes/inbox/InboxRow.test.tsx
git commit -m "feat(inbox): last-activity time on every row; actions become an overlay

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 3: The list store, the optional auth accessor, and the sign-out clear

**Files:**
- Create: `dashboard/src/routes/inbox/inboxListStore.ts`
- Create: `dashboard/src/routes/inbox/inboxListStore.test.ts`
- Modify: `dashboard/src/app/AuthContext.tsx` (additive)
- Modify: `dashboard/src/app/AuthGate.tsx`
- Create: `dashboard/src/app/AuthGate.test.tsx`

**Interfaces:**
- Consumes: `InboxFilter`, `InboxRow` types from `dashboard/src/api/index.js`;
  `AuthState`, `AuthProvider` from `AuthContext.tsx`.
- Produces:
  - `inboxListKey(operatorId: string, filter: InboxFilter, limit: number): string`
  - `interface InboxListSnapshot { head: InboxRow[]; tail: InboxRow[]; cursor: string | null; groupsTruncated: boolean; truncated: boolean; scrollTop: number }`
  - `saveInboxList(key, snapshot)`, `loadInboxList(key): InboxListSnapshot | undefined`, `clearInboxLists(): void`
  - `useOptionalAuth(): AuthState | undefined` (no throw without a provider)
  - `AuthGate` calls `clearInboxLists()` from a passive effect when `status` becomes `'anonymous'`.

- [ ] **Step 1: Write the failing store tests**

Create `dashboard/src/routes/inbox/inboxListStore.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { InboxRow } from '../../api/index.js';
import {
  clearInboxLists,
  inboxListKey,
  loadInboxList,
  saveInboxList,
  type InboxListSnapshot,
} from './inboxListStore.js';

function row(id: string): InboxRow {
  return {
    kind: 'contact',
    contactId: id,
    name: id,
    unreadCount: 0,
    preview: '',
    channel: 'sms',
    direction: 'inbound',
    lastActivityAt: '2026-06-17T10:00:00.000Z',
    needsTriage: false,
  };
}
function snap(over: Partial<InboxListSnapshot> = {}): InboxListSnapshot {
  return {
    head: [row('c1')],
    tail: [],
    cursor: null,
    groupsTruncated: false,
    truncated: false,
    scrollTop: 0,
    ...over,
  };
}

beforeEach(() => clearInboxLists());

describe('inboxListStore', () => {
  it('keys by operator, filter and limit', () => {
    expect(inboxListKey('u1', 'all', 100)).toBe('u1:all:100');
    expect(inboxListKey('u1', 'unread', 30)).not.toBe(inboxListKey('u2', 'unread', 30));
    expect(inboxListKey('u1', 'all', 100)).not.toBe(inboxListKey('u1', 'all', 50));
  });

  it('loads what was saved under the same key and nothing under another', () => {
    saveInboxList('u1:all:100', snap({ scrollTop: 420 }));
    expect(loadInboxList('u1:all:100')?.scrollTop).toBe(420);
    expect(loadInboxList('u2:all:100')).toBeUndefined();
    expect(loadInboxList('u1:unread:100')).toBeUndefined();
  });

  it('a later save replaces the earlier one', () => {
    saveInboxList('u1:all:100', snap({ head: [row('c1')] }));
    saveInboxList('u1:all:100', snap({ head: [row('c2')] }));
    expect(loadInboxList('u1:all:100')?.head.map((r) => r.contactId)).toEqual(['c2']);
  });

  it('clear empties every key', () => {
    saveInboxList('u1:all:100', snap());
    saveInboxList('u2:all:100', snap());
    clearInboxLists();
    expect(loadInboxList('u1:all:100')).toBeUndefined();
    expect(loadInboxList('u2:all:100')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the store tests to verify they fail**

```
npx vitest run src/routes/inbox/inboxListStore.test.ts --root dashboard
```

Expected: FAIL - "Failed to resolve import "./inboxListStore.js"".

- [ ] **Step 3: Write the store**

Create `dashboard/src/routes/inbox/inboxListStore.ts`:

```ts
// inboxListStore - the in-memory list snapshot that lets /inbox come back
// instantly after a navigation (spec 5.8). Module-level state, no React: it
// lives for the page session, is keyed by OPERATOR + filter + page size so one
// operator's rows can never restore for another, and is cleared by AuthGate
// when the session goes anonymous. autoLoadArmed is deliberately NOT part of
// the snapshot: a restore mounts unarmed and the first complete head read arms.
import type { InboxFilter, InboxRow } from '../../api/index.js';

export interface InboxListSnapshot {
  /** Server order, NOT narrowed, NOT sorted, pending patches folded in. */
  head: InboxRow[];
  tail: InboxRow[];
  cursor: string | null;
  groupsTruncated: boolean;
  truncated: boolean;
  scrollTop: number;
}

const store = new Map<string, InboxListSnapshot>();

export function inboxListKey(operatorId: string, filter: InboxFilter, limit: number): string {
  return `${operatorId}:${filter}:${limit}`;
}

export function saveInboxList(key: string, snapshot: InboxListSnapshot): void {
  store.set(key, snapshot);
}

export function loadInboxList(key: string): InboxListSnapshot | undefined {
  return store.get(key);
}

export function clearInboxLists(): void {
  store.clear();
}
```

- [ ] **Step 4: Run the store tests to verify they pass**

```
npx vitest run src/routes/inbox/inboxListStore.test.ts --root dashboard
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing AuthGate test**

Create `dashboard/src/app/AuthGate.test.tsx`:

```tsx
// The store clear must run AFTER the deleted subtree's cleanups (React deletes
// parent-first; a cleanup in a parent would run before a child's unmount save
// and the save would repopulate the store). A passive effect in the surviving
// AuthGate runs after every deleted child's cleanup. Proven here with a child
// that saves from a LAYOUT-effect cleanup, the same phase useInbox saves in.
import { act, render, screen } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from './AuthContext.js';
import { clearInboxLists, loadInboxList, saveInboxList } from '../routes/inbox/inboxListStore.js';

let auth: AuthState;
vi.mock('./AuthContext.js', async () => {
  const actual = await vi.importActual<typeof import('./AuthContext.js')>('./AuthContext.js');
  return { ...actual, useAuth: () => auth };
});
vi.mock('../routes/Login.js', () => ({ default: () => <div>login screen</div> }));

import { AuthGate } from './AuthGate.js';

function SavesOnUnmount(): React.JSX.Element {
  useLayoutEffect(
    () => () => {
      saveInboxList('u1:all:100', {
        head: [],
        tail: [],
        cursor: null,
        groupsTruncated: false,
        truncated: false,
        scrollTop: 7,
      });
    },
    [],
  );
  return <div>app</div>;
}

beforeEach(() => {
  clearInboxLists();
  auth = { status: 'authenticated', me: { userId: 'u1', email: 'a@b.c', role: 'admin' }, isAdmin: true, refresh: async () => {} };
});
afterEach(() => vi.restoreAllMocks());

describe('AuthGate', () => {
  it('clears the inbox list store after the authenticated subtree unmounts on sign-out', () => {
    const { rerender } = render(
      <AuthGate>
        <SavesOnUnmount />
      </AuthGate>,
    );
    expect(screen.getByText('app')).toBeInTheDocument();
    auth = { ...auth, status: 'anonymous', me: undefined, isAdmin: false };
    act(() => {
      rerender(
        <AuthGate>
          <SavesOnUnmount />
        </AuthGate>,
      );
    });
    expect(screen.getByText('login screen')).toBeInTheDocument();
    // The child's unmount save ran (layout cleanup) and the gate's passive
    // effect cleared it afterwards.
    expect(loadInboxList('u1:all:100')).toBeUndefined();
  });

  it('does not clear the store while authenticated', () => {
    saveInboxList('u1:all:100', { head: [], tail: [], cursor: null, groupsTruncated: false, truncated: false, scrollTop: 1 });
    render(
      <AuthGate>
        <div>app</div>
      </AuthGate>,
    );
    expect(loadInboxList('u1:all:100')?.scrollTop).toBe(1);
  });
});
```

If `Me` in `dashboard/src/api/types.ts` has fields beyond `userId`, `email`,
`role`, extend the fixture object to satisfy the type; do not change the type.

- [ ] **Step 6: Run the AuthGate test to verify it fails**

```
npx vitest run src/app/AuthGate.test.tsx --root dashboard
```

Expected: FAIL on the first test - `loadInboxList` still returns the saved
snapshot (nothing clears it).

- [ ] **Step 7: Add the optional accessor and the clear effect**

In `dashboard/src/app/AuthContext.tsx`, after `useAuth`:

```ts
/** The session when a provider is mounted, else undefined. For components and
 *  hooks that must render in tests without an <AuthProvider> (useInbox reads
 *  the operator id through this). */
export function useOptionalAuth(): AuthState | undefined {
  return useContext(AuthContext);
}
```

Replace `dashboard/src/app/AuthGate.tsx` with:

```tsx
// AuthGate - the session switch. While the /auth/me probe is in flight it shows
// a centered spinner; anonymous -> the Login screen; authenticated -> children
// (the AppFrame + routes). Lives between AuthProvider and the app so every
// authenticated surface can assume a logged-in principal.
//
// It also owns the inbox list store's lifetime (spec 5.8): when the session
// goes anonymous the store is cleared from a PASSIVE effect, which React runs
// after every deleted child's cleanup - so the Inbox's own unmount save (a
// layout cleanup) has already happened and cannot repopulate the store. A
// cleanup in a deleted parent (AppFrame) would run BEFORE that save.
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Spinner } from '../ui/index.js';
import Login from '../routes/Login.js';
import { clearInboxLists } from '../routes/inbox/inboxListStore.js';
import { useAuth } from './AuthContext.js';

export function AuthGate({ children }: { children: ReactNode }): React.JSX.Element {
  const { status } = useAuth();

  useEffect(() => {
    if (status === 'anonymous') clearInboxLists();
  }, [status]);

  if (status === 'loading') {
    return <Spinner center label="Loading your workspace" />;
  }
  if (status === 'anonymous') {
    return <Login />;
  }
  return <>{children}</>;
}
```

- [ ] **Step 8: Run the AuthGate test to verify it passes**

```
npx vitest run src/app/AuthGate.test.tsx --root dashboard
```

Expected: PASS, 2 tests.

- [ ] **Step 9: Typecheck and commit**

```
npm run typecheck
```

Expected: exit 0. Read bare `git status`, confirm no `MERGE_HEAD`, then:

```
git add dashboard/src/routes/inbox/inboxListStore.ts dashboard/src/routes/inbox/inboxListStore.test.ts dashboard/src/app/AuthContext.tsx dashboard/src/app/AuthGate.tsx dashboard/src/app/AuthGate.test.tsx
git commit -m "feat(inbox): per-operator list store, cleared by AuthGate on sign-out

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The pure list merge

**Files:**
- Create: `dashboard/src/routes/inbox/inboxListMerge.ts`
- Create: `dashboard/src/routes/inbox/inboxListMerge.test.ts`

**Interfaces:**
- Consumes: `InboxFilter`, `InboxPage`, `InboxRow` from the api index;
  `rowKey` is DEFINED HERE (moved from `useInbox.ts`, which re-exports it in
  Task 5 so existing imports keep working).
- Produces:
  ```ts
  export interface ListState {
    head: InboxRow[]; tail: InboxRow[]; cursor: string | null;
    groupsTruncated: boolean; truncated: boolean;
    autoLoadArmed: boolean; pageEpoch: number;
  }
  export function rowKey(row: InboxRow): string
  export function emptyListState(): ListState
  export function baseOf(state: ListState): InboxRow[]            // head ++ tail
  export function dedupeConversations(rows: InboxRow[], freshKeys: Set<string>): InboxRow[]
  export function mergeHeadRead(state: ListState, page: InboxPage, filter: InboxFilter, limit: number): ListState
  export function appendPage(state: ListState, page: InboxPage): ListState
  export function patchUnread(state: ListState, key: string, unreadCount: number): ListState
  ```

- [ ] **Step 1: Write the failing tests**

Create `dashboard/src/routes/inbox/inboxListMerge.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { InboxPage, InboxRow } from '../../api/index.js';
import {
  appendPage,
  baseOf,
  dedupeConversations,
  emptyListState,
  mergeHeadRead,
  patchUnread,
  rowKey,
  type ListState,
} from './inboxListMerge.js';

function contact(id: string, at = '2026-06-17T10:00:00.000Z', over: Partial<InboxRow> = {}): InboxRow {
  return {
    kind: 'contact',
    contactId: id,
    name: id,
    unreadCount: 0,
    preview: '',
    channel: 'sms',
    direction: 'inbound',
    lastActivityAt: at,
    needsTriage: false,
    ...over,
  };
}
function relay(conversationId: string, at = '2026-06-01T10:00:00.000Z'): InboxRow {
  return {
    kind: 'relay_group',
    conversationId,
    name: `With ${conversationId}`,
    unreadCount: 0,
    preview: '',
    lastActivityAt: at,
    needsTriage: false,
    status: 'open',
  };
}
function groupText(conversationId: string, at = '2026-06-01T09:00:00.000Z'): InboxRow {
  return {
    kind: 'group_text',
    conversationId,
    name: `Group ${conversationId}`,
    unreadCount: 0,
    preview: '',
    lastActivityAt: at,
    needsTriage: false,
  };
}
function page(rows: InboxRow[], nextCursor: string | null, extra: Partial<InboxPage> = {}): InboxPage {
  return { rows, nextCursor, ...extra };
}
function state(over: Partial<ListState> = {}): ListState {
  return { ...emptyListState(), ...over };
}
const ids = (rows: InboxRow[]): string[] => rows.map(rowKey);

describe('rowKey', () => {
  it('prefixes by kind and never collides across kinds', () => {
    expect(rowKey(contact('c1'))).toBe('c:c1');
    expect(rowKey(relay('x'))).toBe('g:x');
    expect(rowKey(groupText('x'))).toBe('gt:x');
    expect(rowKey({ ...contact('u'), kind: 'unknown', contactId: undefined, phone: '+15550001111' })).toBe('u:+15550001111');
  });
});

describe('mergeHeadRead - branch C (complete head)', () => {
  it('replaces head, tail and cursor and re-arms from the page', () => {
    const s = state({ head: [contact('old')], tail: [contact('t1')], cursor: 'OLD', autoLoadArmed: false, pageEpoch: 3 });
    const next = mergeHeadRead(s, page([contact('n1'), contact('n2')], 'NEW'), 'all', 2);
    expect(ids(next.head)).toEqual(['c:n1', 'c:n2']);
    expect(next.tail).toEqual([]);
    expect(next.cursor).toBe('NEW');
    expect(next.autoLoadArmed).toBe(true);
    expect(next.pageEpoch).toBe(4);
  });

  it('a complete head that ended the feed (null cursor) is complete even when short', () => {
    const s = state({ head: [contact('old')], tail: [contact('t1')], cursor: 'OLD' });
    const next = mergeHeadRead(s, page([contact('n1')], null), 'all', 100);
    expect(ids(baseOf(next))).toEqual(['c:n1']);
    expect(next.cursor).toBeNull();
  });

  it('on the All tab, additive rows do not count toward the limit', () => {
    const s = state({ head: [contact('old')], tail: [contact('t1')], cursor: 'OLD' });
    // limit 2, two contacts + one relay row = complete
    const next = mergeHeadRead(s, page([contact('n1'), relay('r1'), contact('n2')], 'NEW'), 'all', 2);
    expect(ids(next.head)).toEqual(['c:n1', 'g:r1', 'c:n2']);
    expect(next.tail).toEqual([]);
  });

  it('drops additive rows absent from the page, as today', () => {
    const s = state({ head: [contact('n1'), relay('r1')], cursor: null });
    const next = mergeHeadRead(s, page([contact('n1')], null), 'all', 100);
    expect(ids(baseOf(next))).toEqual(['c:n1']);
  });

  it('a zero-row page with no cursor and no truncation empties the list and disarms', () => {
    const s = state({ head: [contact('old')], cursor: null, autoLoadArmed: true });
    const next = mergeHeadRead(s, page([], null), 'unknown', 100);
    expect(baseOf(next)).toEqual([]);
    expect(next.autoLoadArmed).toBe(false);
  });

  it('Unknown queue order: a complete page is exactly the fresh page one', () => {
    const s = state({ head: [contact('a'), contact('b')], tail: [contact('c')], cursor: 'OLD' });
    const next = mergeHeadRead(s, page([contact('z'), contact('a')], 'NEW'), 'unknown', 2);
    expect(ids(baseOf(next))).toEqual(['c:z', 'c:a']);
    expect(next.cursor).toBe('NEW');
  });

  it('flags come from the page', () => {
    const s = state({ groupsTruncated: true, truncated: false });
    const next = mergeHeadRead(s, page([contact('n1')], null, { groupsTruncated: false }), 'all', 100);
    expect(next.groupsTruncated).toBe(false);
  });
});

describe('mergeHeadRead - branch I (incomplete head)', () => {
  it('a short page WITH a cursor merges its rows in and removes nothing; the old cursor is kept', () => {
    const s = state({ head: [contact('a'), contact('b')], tail: [contact('t1')], cursor: 'TAIL', autoLoadArmed: true, pageEpoch: 1 });
    const next = mergeHeadRead(s, page([contact('z'), contact('a')], 'SHORT'), 'unread', 100);
    expect(ids(next.head)).toEqual(['c:z', 'c:a', 'c:b']);
    expect(ids(next.tail)).toEqual(['c:t1']);
    expect(next.cursor).toBe('TAIL');
    expect(next.autoLoadArmed).toBe(true);
    expect(next.pageEpoch).toBe(2);
  });

  it('a truncated page is incomplete even when it ends with a null cursor (the Unread depth cap)', () => {
    const s = state({ head: [contact('a')], tail: [contact('t1')], cursor: null });
    const next = mergeHeadRead(s, page([contact('z')], null, { truncated: true }), 'unread', 100);
    expect(ids(baseOf(next))).toEqual(['c:z', 'c:a', 'c:t1']);
    expect(next.cursor).toBeNull();
    expect(next.truncated).toBe(true);
  });

  it('a zero-row budget exit with rows present changes nothing but the flags', () => {
    const s = state({ head: [contact('a')], tail: [contact('t1')], cursor: 'TAIL', autoLoadArmed: false });
    const next = mergeHeadRead(s, page([], 'BUDGET'), 'unknown', 100);
    expect(ids(baseOf(next))).toEqual(['c:a', 'c:t1']);
    expect(next.cursor).toBe('TAIL');
    expect(next.autoLoadArmed).toBe(false);
  });

  it('a zero-row budget exit on an EMPTY list takes the page as-is and its cursor', () => {
    const next = mergeHeadRead(emptyListState(), page([], 'BUDGET'), 'unknown', 100);
    expect(baseOf(next)).toEqual([]);
    expect(next.cursor).toBe('BUDGET');
    expect(next.autoLoadArmed).toBe(false);
  });

  it('a short page with a cursor on an EMPTY list arms from the page', () => {
    const next = mergeHeadRead(emptyListState(), page([contact('z')], 'BUDGET'), 'unread', 100);
    expect(next.autoLoadArmed).toBe(true);
  });

  it('on All, a short page still classifies by paged rows only', () => {
    const s = state({ head: [contact('a')], cursor: 'OLD' });
    // one contact + one relay at limit 2 is SHORT (pagedP.length 1 < 2) with a cursor
    const next = mergeHeadRead(s, page([contact('z'), relay('r1')], 'CUR'), 'all', 2);
    expect(ids(next.head)).toEqual(['c:z', 'g:r1', 'c:a']);
    expect(next.cursor).toBe('OLD');
  });
});

describe('dedupeConversations', () => {
  it('a group_text row in the fresh set drops the relay row of the same conversation', () => {
    const rows = [groupText('x', '2026-06-02T00:00:00.000Z'), relay('x'), contact('c1')];
    const out = dedupeConversations(rows, new Set(['gt:x']));
    expect(ids(out)).toEqual(['gt:x', 'c:c1']);
  });
  it('when neither row is fresh, the first occurrence wins', () => {
    const rows = [relay('x'), groupText('x')];
    expect(ids(dedupeConversations(rows, new Set()))).toEqual(['g:x']);
  });
  it('runs inside mergeHeadRead on both branches', () => {
    const s = state({ head: [relay('x')], cursor: null });
    const complete = mergeHeadRead(s, page([groupText('x')], null), 'all', 100);
    expect(ids(baseOf(complete))).toEqual(['gt:x']);
    const incomplete = mergeHeadRead(s, page([groupText('x')], 'CUR', { truncated: true }), 'all', 100);
    expect(ids(baseOf(incomplete))).toEqual(['gt:x']);
  });
});

describe('appendPage', () => {
  it('appends new rows to the tail, installs the cursor, bumps the epoch and arms', () => {
    const s = state({ head: [contact('a')], cursor: 'C1', pageEpoch: 5, autoLoadArmed: true });
    const next = appendPage(s, page([contact('b')], 'C2'));
    expect(ids(baseOf(next))).toEqual(['c:a', 'c:b']);
    expect(next.cursor).toBe('C2');
    expect(next.pageEpoch).toBe(6);
    expect(next.autoLoadArmed).toBe(true);
  });
  it('skips rows already present by rowKey and disarms when nothing new arrived', () => {
    const s = state({ head: [contact('a')], tail: [contact('b')], cursor: 'C1', autoLoadArmed: true });
    const next = appendPage(s, page([contact('b'), contact('a')], 'C2'));
    expect(ids(baseOf(next))).toEqual(['c:a', 'c:b']);
    expect(next.autoLoadArmed).toBe(false);
    expect(next.cursor).toBe('C2');
  });
  it('an empty page with a cursor disarms and keeps the new cursor', () => {
    const s = state({ head: [contact('a')], cursor: 'C1', autoLoadArmed: true });
    const next = appendPage(s, page([], 'C2'));
    expect(next.autoLoadArmed).toBe(false);
    expect(next.cursor).toBe('C2');
  });
  it('dedupes conversations across kinds, the appended row winning', () => {
    const s = state({ head: [relay('x')], cursor: 'C1' });
    const next = appendPage(s, page([groupText('x')], null));
    expect(ids(baseOf(next))).toEqual(['gt:x']);
  });
});

describe('patchUnread', () => {
  it('rewrites the unread count of one row in head or tail', () => {
    const s = state({ head: [contact('a', undefined, { unreadCount: 2 })], tail: [contact('b', undefined, { unreadCount: 1 })] });
    const next = patchUnread(s, 'c:b', 0);
    expect(next.tail[0]?.unreadCount).toBe(0);
    expect(next.head[0]?.unreadCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```
npx vitest run src/routes/inbox/inboxListMerge.test.ts --root dashboard
```

Expected: FAIL - "Failed to resolve import "./inboxListMerge.js"".

- [ ] **Step 3: Write the merge module**

Create `dashboard/src/routes/inbox/inboxListMerge.ts`:

```ts
// inboxListMerge - the PURE list model behind useInbox (spec 5.5 / 5.6).
//
// The list is head (the server's page one) ++ tail (rows loaded by "Load
// more"). A HEAD READ applies through mergeHeadRead:
//   branch C (complete page):   the list BECOMES the page; loaded pages drop
//                               and reload on scroll (Option B, decision 6).
//   branch I (incomplete page): the read stopped early (budget exit / truncated),
//                               so it merges in and removes nothing.
// A loadMore page applies through appendPage, deduplicated against the list.
// Both run dedupeConversations so a relay group converted in place to a group
// text (same conversationId, keys g:<id> vs gt:<id>) never renders twice.
//
// pageEpoch bumps ONLY here - on a committed head read or appended page -
// never on a mark-read patch; useAutoLoad keys its re-check on it (spec 5.2).
import type { InboxFilter, InboxPage, InboxRow } from '../../api/index.js';

export interface ListState {
  head: InboxRow[];
  tail: InboxRow[];
  cursor: string | null;
  groupsTruncated: boolean;
  truncated: boolean;
  autoLoadArmed: boolean;
  pageEpoch: number;
}

/** Stable identity for a row: conversationId for the two multi-party kinds,
 *  contactId for contacts, phone for unknowns. The four prefixes never collide -
 *  native group texts take `gt:` because `g:` is already relay's, and the
 *  trailing branch is the UNKNOWN case, so an unhandled kind would key as `u:`
 *  (empty phone) and collide with every other unhandled row. */
export function rowKey(row: InboxRow): string {
  if (row.kind === 'relay_group') return `g:${row.conversationId ?? ''}`;
  if (row.kind === 'group_text') return `gt:${row.conversationId ?? ''}`;
  return row.kind === 'contact' ? `c:${row.contactId ?? ''}` : `u:${row.phone ?? ''}`;
}

export function emptyListState(): ListState {
  return {
    head: [],
    tail: [],
    cursor: null,
    groupsTruncated: false,
    truncated: false,
    autoLoadArmed: false,
    pageEpoch: 0,
  };
}

export function baseOf(state: ListState): InboxRow[] {
  return [...state.head, ...state.tail];
}

function isAdditive(row: InboxRow, filter: InboxFilter): boolean {
  return filter === 'all' && (row.kind === 'relay_group' || row.kind === 'group_text');
}

function dedupeByRowKey(rows: InboxRow[]): InboxRow[] {
  const seen = new Set<string>();
  const out: InboxRow[] = [];
  for (const r of rows) {
    const k = rowKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** One row per conversationId across kinds: a row whose rowKey is in
 *  `freshKeys` beats one that is not; otherwise the first occurrence wins. */
export function dedupeConversations(rows: InboxRow[], freshKeys: Set<string>): InboxRow[] {
  const winner = new Map<string, InboxRow>();
  for (const r of rows) {
    if (r.conversationId === undefined) continue;
    const cur = winner.get(r.conversationId);
    if (cur === undefined) {
      winner.set(r.conversationId, r);
    } else if (!freshKeys.has(rowKey(cur)) && freshKeys.has(rowKey(r))) {
      winner.set(r.conversationId, r);
    }
  }
  return rows.filter((r) => r.conversationId === undefined || winner.get(r.conversationId) === r);
}

function splitByConversation(head: InboxRow[], tail: InboxRow[], freshKeys: Set<string>): { head: InboxRow[]; tail: InboxRow[] } {
  const kept = new Set(dedupeConversations([...head, ...tail], freshKeys).map(rowKey));
  return {
    head: head.filter((r) => kept.has(rowKey(r))),
    tail: tail.filter((r) => kept.has(rowKey(r))),
  };
}

/** Apply a committed head read (spec 5.6). */
export function mergeHeadRead(
  state: ListState,
  page: InboxPage,
  filter: InboxFilter,
  limit: number,
): ListState {
  const P = page.rows;
  const C = page.nextCursor;
  const truncated = page.truncated === true;
  const groupsTruncated = page.groupsTruncated === true;
  const pagedP = P.filter((r) => !isAdditive(r, filter));
  const headComplete = !truncated && (C === null || pagedP.length >= limit);
  const freshKeys = new Set(P.map(rowKey));
  const hadRows = state.head.length + state.tail.length > 0;

  if (headComplete) {
    const split = splitByConversation(P, [], freshKeys);
    return {
      head: split.head,
      tail: [],
      cursor: C,
      groupsTruncated,
      truncated,
      autoLoadArmed: P.length > 0,
      pageEpoch: state.pageEpoch + 1,
    };
  }

  // Branch I: merge in, remove nothing, keep the old cursor (including null)
  // when the list had rows; an empty list takes the read's cursor.
  const inP = freshKeys;
  const mergedHead = dedupeByRowKey([...P, ...state.head.filter((r) => !inP.has(rowKey(r)))]);
  const keptTail = state.tail.filter((r) => !inP.has(rowKey(r)));
  const split = splitByConversation(mergedHead, keptTail, freshKeys);
  return {
    head: split.head,
    tail: split.tail,
    cursor: hadRows ? state.cursor : C,
    groupsTruncated,
    truncated,
    autoLoadArmed: hadRows ? state.autoLoadArmed : P.length > 0,
    pageEpoch: state.pageEpoch + 1,
  };
}

/** Apply a committed loadMore page (spec 5.5): dedupe, install the cursor,
 *  bump the epoch, arm iff at least one NEW row arrived. */
export function appendPage(state: ListState, page: InboxPage): ListState {
  const present = new Set(baseOf(state).map(rowKey));
  const fresh = page.rows.filter((r) => !present.has(rowKey(r)));
  const freshKeys = new Set(fresh.map(rowKey));
  const split = splitByConversation(state.head, [...state.tail, ...fresh], freshKeys);
  return {
    ...state,
    head: split.head,
    tail: split.tail,
    cursor: page.nextCursor,
    truncated: page.truncated === true,
    autoLoadArmed: fresh.length > 0,
    pageEpoch: state.pageEpoch + 1,
  };
}

/** Rewrite one row's unreadCount wherever it sits. Not an epoch bump. */
export function patchUnread(state: ListState, key: string, unreadCount: number): ListState {
  const map = (rows: InboxRow[]): InboxRow[] =>
    rows.map((r) => (rowKey(r) === key ? { ...r, unreadCount } : r));
  return { ...state, head: map(state.head), tail: map(state.tail) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```
npx vitest run src/routes/inbox/inboxListMerge.test.ts --root dashboard
```

Expected: PASS, 22 tests.

- [ ] **Step 5: Commit**

Read bare `git status`, confirm no `MERGE_HEAD`, then:

```
git add dashboard/src/routes/inbox/inboxListMerge.ts dashboard/src/routes/inbox/inboxListMerge.test.ts
git commit -m "feat(inbox): pure list model - complete heads replace, incomplete heads merge

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 5: The rebuilt `useInbox` hook

**Files:**
- Modify: `dashboard/src/routes/inbox/useInbox.ts` (whole-file replacement)
- Modify: `dashboard/src/routes/inbox/useInbox.test.tsx`

**Interfaces:**
- Consumes: Task 3's store (`inboxListKey`, `loadInboxList`, `saveInboxList`,
  `InboxListSnapshot`), Task 4's merge module (`ListState`, `emptyListState`,
  `baseOf`, `mergeHeadRead`, `appendPage`, `patchUnread`, `rowKey`), the api
  index (`getInbox`, `ApiError`, `markInboxRead`, `markInboxUnread`,
  `markConversationRead`, `markConversationUnread`, `useEventStream`),
  `useUnread`, the unread key helpers.
- Produces:
  ```ts
  export const DEFAULT_PAGE_LIMIT = 100;
  export const MAX_PAGE_LIMIT = 100;
  export { rowKey } from './inboxListMerge.js';
  export function useInbox(filter: InboxFilter, limit?: number, operatorId?: string): InboxState
  export interface InboxState {  // today's fields plus:
    refreshFailed: boolean;
    autoLoadArmed: boolean;
    pageEpoch: number;
    restoredScrollTop: number | null;   // the snapshot's scrollTop when this mount restored, else null
    noteScrollTop: (top: number) => void;
  }
  ```
  `useInbox(filter)` with defaults keeps every existing caller and test working.

- [ ] **Step 1: Replace the hook**

Replace the whole of `dashboard/src/routes/inbox/useInbox.ts` with:

```ts
// useInbox - owns the entity-centric inbox list for the active filter: the
// head page (GET /api/inbox), cursor "load more", optimistic mark-read /
// mark-unread with rollback, live updates, and (spec 5.8) an instant restore
// from the module store when the page comes back after a navigation.
//
// ONE AUTHORITATIVE LIST. Every list mutation computes its next value from
// `listRef.current` synchronously and goes through `commitList`, which mirrors
// it into React state for rendering and saves a snapshot to the store while
// the list is `ready` and this instance is alive. No functional setState
// updater ever touches the list, so a saved snapshot is exactly what was
// committed. The pure merge rules live in inboxListMerge.ts.
//
// Live-update policy: the SSE `conversation.updated` event is PER-CONVERSATION
// and carries no contactId, so it cannot soundly patch an aggregated CONTACT
// row. Any inbox-affecting event schedules a debounced HEAD READ of the
// current filter (spec 5.6): a complete page one replaces the list; an
// incomplete one (a budget exit, a truncated page) merges in and removes
// nothing. A failed head read while rows are rendered keeps them and raises
// `refreshFailed` (the banner, spec 5.7).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ApiError,
  getInbox,
  markConversationRead,
  markConversationUnread,
  markInboxRead,
  markInboxUnread,
  useEventStream,
  type InboxFilter,
  type InboxRow as InboxRowData,
} from '../../api/index.js';
import { useUnread } from '../../app/UnreadContext.js';
import { contactClearKey, conversationClearKey, phoneClearKey } from '../../app/unreadKeys.js';
import {
  appendPage,
  baseOf,
  emptyListState,
  mergeHeadRead,
  patchUnread,
  rowKey,
  type ListState,
} from './inboxListMerge.js';
import {
  inboxListKey,
  loadInboxList,
  saveInboxList,
  type InboxListSnapshot,
} from './inboxListStore.js';

export { rowKey } from './inboxListMerge.js';

export type InboxStatus = 'loading' | 'pending' | 'ready' | 'error';

/** The page size the dashboard requests (spec 5.1). */
export const DEFAULT_PAGE_LIMIT = 100;
/** Mirrors the server's MAX_INBOX_LIMIT (app/src/routes/inbox.ts). */
export const MAX_PAGE_LIMIT = 100;

/** An in-flight optimistic mutation patch for one row (re-applied over
 *  head reads until the request settles). */
interface Pending {
  unreadCount?: number;
}

export interface InboxState {
  status: InboxStatus;
  rows: InboxRowData[];
  /** The server withheld group-text rows this filter would otherwise show (page
   *  one takes the newest 50; the partition walk has its own budget). */
  groupsTruncated: boolean;
  /** How many group-text rows are actually ON SCREEN for this filter. */
  groupRowsShown: number;
  /** The UNREAD feed ended for a NON-NATURAL reason. A statement about the
   *  LATEST head page read; replaced by each head read, reset per filter. */
  truncated: boolean;
  /** How many rows the SERVER has handed down for this filter (head + loaded
   *  pages), BEFORE the optimistic patches and the Unread narrowing. */
  serverRowCount: number;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
  markRead: (row: InboxRowData) => void;
  markUnread: (row: InboxRowData) => void;
  /** A background head read failed while rows were rendered (spec 5.7). */
  refreshFailed: boolean;
  /** Auto-load may fire (spec 5.2): the read that installed the live cursor
   *  chain delivered at least one row. */
  autoLoadArmed: boolean;
  /** Bumped by every committed head read and loaded page (never by a patch). */
  pageEpoch: number;
  /** The snapshot's scroll position when this mount restored from the store. */
  restoredScrollTop: number | null;
  /** The page reports the scroll container's scrollTop here (spec 5.8). */
  noteScrollTop: (top: number) => void;
}

/** Debounce window (ms) for SSE-triggered head reads - coalesces a burst of
 *  conversation.updated events into one read (matches useToday). */
const REFETCH_DEBOUNCE_MS = 300;

function countGroupRows(rows: InboxRowData[]): number {
  return rows.filter((r) => r.kind === 'group_text').length;
}

/** Newest-activity-first, matching the server's inbox ordering. */
function sortByActivity(rows: InboxRowData[]): InboxRowData[] {
  return [...rows].sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  );
}

function applyPatches(rows: InboxRowData[], pending: Map<string, Pending>): InboxRowData[] {
  return rows.map((row) => {
    const p = pending.get(rowKey(row));
    if (p === undefined) return row;
    return { ...row, ...(p.unreadCount !== undefined && { unreadCount: p.unreadCount }) };
  });
}

function snapshotOf(
  list: ListState,
  pending: Map<string, Pending>,
  scrollTop: number,
): InboxListSnapshot {
  return {
    head: applyPatches(list.head, pending),
    tail: applyPatches(list.tail, pending),
    cursor: list.cursor,
    groupsTruncated: list.groupsTruncated,
    truncated: list.truncated,
    scrollTop,
  };
}

function listFromSnapshot(s: InboxListSnapshot): ListState {
  return {
    head: s.head,
    tail: s.tail,
    cursor: s.cursor,
    groupsTruncated: s.groupsTruncated,
    truncated: s.truncated,
    // A restore mounts UNARMED (spec 5.2): the first complete head read arms.
    autoLoadArmed: false,
    pageEpoch: 0,
  };
}

export function useInbox(
  filter: InboxFilter,
  limit: number = DEFAULT_PAGE_LIMIT,
  operatorId = 'anon',
): InboxState {
  const initialKey = inboxListKey(operatorId, filter, limit);
  // Lazy init from the store: a restored list's FIRST render is already ready.
  const [restored] = useState<InboxListSnapshot | undefined>(() => loadInboxList(initialKey));
  const [status, setStatus] = useState<InboxStatus>(restored ? 'ready' : 'loading');
  const [list, setList] = useState<ListState>(() =>
    restored ? listFromSnapshot(restored) : emptyListState(),
  );
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pending, setPending] = useState<Map<string, Pending>>(new Map());
  const { noteRowsCleared, rollbackRowsCleared } = useUnread();

  // The authoritative list and its status, readable from any callback.
  const listRef = useRef<ListState>(list);
  const statusRef = useRef<InboxStatus>(status);
  // The pending patches, mirrored synchronously so the unmount save can see a
  // patch made in the same render that navigated away.
  const pendingRef = useRef<Map<string, Pending>>(new Map());
  // The store key the current state belongs to; captured at every save.
  const keyRef = useRef(initialKey);
  // The key whose state is already on screen (restored, or reset by the
  // filter effect): the effect resets only when the key CHANGES, which is
  // what lets a StrictMode replay and a restored mount skip the reset.
  const restoredKeyRef = useRef<string | null>(restored ? initialKey : null);
  // True between the mount effect's body and its cleanup: a request that
  // settles after unmount neither commits nor saves.
  const aliveRef = useRef(false);
  // The scroll container's last reported scrollTop (spec 5.8).
  const scrollTopRef = useRef(0);

  const abortRef = useRef<AbortController | null>(null);
  // Bumped on every committed optimistic mutation; a head read that started
  // before the commit (so it read pre-mutation server state) is then discarded
  // instead of clobbering the commit - unless the screen shows a spinner, in
  // which case nothing would re-issue it (see the guard in fetchHead).
  const genRef = useRef(0);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const filterGenRef = useRef(0);
  // Bumped whenever a head read COMMITS, so an in-flight loadMore can tell that
  // the list it was a continuation of has been replaced underneath it.
  const firstPageGenRef = useRef(0);
  const activeFilterRef = useRef(filter);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** The ONLY way this hook changes `status` - keeps `statusRef` atomic with it. */
  const applyStatus = useCallback((next: InboxStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  /** The ONLY writer of the list (spec 5.5). */
  const commitList = useCallback((next: ListState) => {
    listRef.current = next;
    setList(next);
    if (aliveRef.current && statusRef.current === 'ready') {
      saveInboxList(keyRef.current, snapshotOf(next, pendingRef.current, scrollTopRef.current));
    }
  }, []);

  const clearPendingRefetch = useCallback(() => {
    if (debounceRef.current !== undefined) {
      clearTimeout(debounceRef.current);
      debounceRef.current = undefined;
    }
  }, []);

  const fetchHead = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const gen = genRef.current;
    try {
      const pageData = await getInbox({ filter, limit }, controller.signal);
      if (controller.signal.aborted) return;
      // THE GENERATION GUARD PROTECTS A LIST, NOT A SPINNER: a pre-mutation page
      // is discarded only when a rendered list would be clobbered; while the
      // screen shows a spinner nothing else would re-issue it.
      if (gen !== genRef.current && statusRef.current === 'ready') return;
      // A page for a filter we have LEFT is refused, never installed.
      if (filter !== activeFilterRef.current) return;
      if (!aliveRef.current) return;
      firstPageGenRef.current += 1;
      // Ready BEFORE the commit so the commit's save sees a ready list.
      applyStatus('ready');
      setRefreshFailed(false);
      commitList(mergeHeadRead(listRef.current, pageData, filter, limit));
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      if (gen !== genRef.current || filter !== activeFilterRef.current) return;
      // Spec 5.7: with rows rendered, a failed head read (a 404 included: a
      // proxy or deploy-window 404 must not blank a healthy list) keeps the
      // rows and raises the banner.
      const rowsRendered = statusRef.current === 'ready' && baseOf(listRef.current).length > 0;
      if (rowsRendered) {
        setRefreshFailed(true);
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        // C8 backend slice isn't live yet -> honest pending state (not an error).
        firstPageGenRef.current += 1;
        commitList(emptyListState()); // status is not ready: nothing is saved
        applyStatus('pending');
        return;
      }
      applyStatus('error');
    }
  }, [filter, limit, applyStatus, commitList]);

  // Initial load / restore-and-reconcile / full reload on a key change. The
  // reset runs ONLY when the key differs from the one whose state is already
  // on screen (spec 5.8): a restored mount and a StrictMode replay of the same
  // key take the reconcile branch instead. `loading` is applied BEFORE the
  // empty commit so no empty snapshot is ever saved.
  useEffect(() => {
    const key = inboxListKey(operatorId, filter, limit);
    filterGenRef.current += 1;
    loadMoreAbortRef.current?.abort();
    activeFilterRef.current = filter;
    keyRef.current = key;
    clearPendingRefetch();
    if (key !== restoredKeyRef.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      applyStatus('loading');
      commitList(emptyListState());
      pendingRef.current = new Map();
      setPending(new Map());
      setRefreshFailed(false);
      scrollTopRef.current = 0;
    }
    setLoadingMore(false);
    restoredKeyRef.current = key;
    void fetchHead();
    return () => abortRef.current?.abort();
  }, [fetchHead, filter, limit, operatorId, clearPendingRefetch, applyStatus, commitList]);

  // Alive for exactly the mounted lifetime (true again after a StrictMode
  // replay); an in-flight loadMore is abandoned on unmount.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      loadMoreAbortRef.current?.abort();
    };
  }, []);

  // THE UNMOUNT SAVE (spec 5.8): a LAYOUT cleanup runs before the replacing
  // route's DOM commits, with the pending patches folded in and the last
  // reported scrollTop. Gated on `ready` only - it IS the unmount.
  useLayoutEffect(
    () => () => {
      if (statusRef.current !== 'ready') return;
      saveInboxList(
        keyRef.current,
        snapshotOf(listRef.current, pendingRef.current, scrollTopRef.current),
      );
    },
    [],
  );

  const noteScrollTop = useCallback((top: number) => {
    scrollTopRef.current = top;
  }, []);

  const retry = useCallback(() => {
    // With rows rendered the rows stay (no spinner); the banner clears when the
    // read commits and stays if it fails again (spec 5.7).
    const rowsRendered = statusRef.current === 'ready' && baseOf(listRef.current).length > 0;
    if (!rowsRendered) applyStatus('loading');
    void fetchHead();
  }, [fetchHead, applyStatus]);

  const loadMore = useCallback(() => {
    const cursor = listRef.current.cursor;
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    loadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;
    const gen = filterGenRef.current;
    const firstPageGen = firstPageGenRef.current;
    const filterStale = (): boolean => controller.signal.aborted || gen !== filterGenRef.current;
    const reconcileStale = (): boolean => firstPageGen !== firstPageGenRef.current;
    getInbox({ filter, limit, cursor }, controller.signal)
      .then((pageData) => {
        if (filterStale() || reconcileStale() || !aliveRef.current) return;
        commitList(appendPage(listRef.current, pageData));
      })
      .catch(() => {
        /* keep the cursor so the user can retry "Load more" */
      })
      .finally(() => {
        if (!filterStale() && aliveRef.current) setLoadingMore(false);
      });
  }, [filter, limit, loadingMore, commitList]);

  // --- SSE: debounced head read of the current filter ------------------------
  const scheduleRefetch = useCallback(() => {
    clearPendingRefetch();
    debounceRef.current = setTimeout(() => {
      debounceRef.current = undefined;
      void fetchHead();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchHead, clearPendingRefetch]);

  useEffect(() => clearPendingRefetch, [clearPendingRefetch]);

  useEventStream({ onConversationUpdated: scheduleRefetch });

  // --- Optimistic mutations (the patches are mirrored in pendingRef) --------
  const setPatch = useCallback((key: string, patch: Pending) => {
    const next = new Map(pendingRef.current);
    next.set(key, { ...next.get(key), ...patch });
    pendingRef.current = next;
    setPending(next);
  }, []);
  const clearPatch = useCallback((key: string, field: keyof Pending) => {
    const prev = pendingRef.current;
    const entry = prev.get(key);
    if (entry === undefined || !(field in entry)) return;
    const next = new Map(prev);
    const remaining = { ...entry };
    delete remaining[field];
    if (Object.keys(remaining).length === 0) next.delete(key);
    else next.set(key, remaining);
    pendingRef.current = next;
    setPending(next);
  }, []);

  const markRead = useCallback(
    (row: InboxRowData) => {
      if (row.unreadCount === 0) return;
      const key = rowKey(row);
      let resolved: { read: () => Promise<void>; clearKey: string } | undefined;
      if (row.kind === 'relay_group' || row.kind === 'group_text') {
        if (row.conversationId !== undefined) {
          const conversationId = row.conversationId;
          resolved = {
            read: () => markConversationRead(conversationId),
            clearKey: conversationClearKey(conversationId),
          };
        }
      } else if (row.kind === 'contact' && row.contactId !== undefined) {
        const contactId = row.contactId;
        resolved = { read: () => markInboxRead({ contactId }), clearKey: contactClearKey(contactId) };
      } else if (row.phone !== undefined) {
        const phone = row.phone;
        resolved = { read: () => markInboxRead({ phone }), clearKey: phoneClearKey(phone) };
      }
      if (resolved === undefined) return; // unaddressable - don't fake success
      const { read, clearKey } = resolved;
      // The filter EPOCH this mutation belongs to (an epoch, not an identity:
      // filter identities recur across A -> B -> A).
      const mutationGen = filterGenRef.current;
      setPatch(key, { unreadCount: 0 });
      noteRowsCleared([clearKey]);
      read()
        .then(() => {
          if (filterGenRef.current === mutationGen) genRef.current += 1;
          if (aliveRef.current) commitList(patchUnread(listRef.current, key, 0));
        })
        .catch(() => {
          rollbackRowsCleared([clearKey]);
        })
        .finally(() => clearPatch(key, 'unreadCount'));
    },
    [setPatch, clearPatch, noteRowsCleared, rollbackRowsCleared, commitList],
  );

  const markUnread = useCallback(
    (row: InboxRowData) => {
      if (row.unreadCount > 0) return;
      const key = rowKey(row);
      let flag: (() => Promise<void>) | undefined;
      if (row.kind === 'relay_group' || row.kind === 'group_text') {
        if (row.conversationId !== undefined) {
          const conversationId = row.conversationId;
          flag = () => markConversationUnread(conversationId);
        }
      } else if (row.kind === 'contact' && row.contactId !== undefined) {
        const contactId = row.contactId;
        flag = () => markInboxUnread({ contactId });
      } else if (row.phone !== undefined) {
        const phone = row.phone;
        flag = () => markInboxUnread({ phone });
      }
      if (flag === undefined) return;
      const mutationGen = filterGenRef.current;
      setPatch(key, { unreadCount: 1 });
      flag()
        .then(() => {
          if (filterGenRef.current === mutationGen) genRef.current += 1;
          if (aliveRef.current) commitList(patchUnread(listRef.current, key, 1));
        })
        .catch(() => {
          /* rollback: dropping the patch restores the original (read) count */
        })
        .finally(() => clearPatch(key, 'unreadCount'));
    },
    [setPatch, clearPatch, commitList],
  );

  // --- Assemble the displayed rows ------------------------------------------
  const base = baseOf(list);
  const patched = applyPatches(base, pending);
  // On the Unread filter a row optimistically marked read drops out immediately.
  const visible = filter === 'unread' ? patched.filter((r) => r.unreadCount > 0) : patched;
  const rows = sortByActivity(visible);

  return {
    status,
    rows,
    groupsTruncated: list.groupsTruncated,
    truncated: list.truncated,
    serverRowCount: base.length,
    groupRowsShown: countGroupRows(rows),
    hasMore: list.cursor !== null,
    loadingMore,
    loadMore,
    retry,
    markRead,
    markUnread,
    refreshFailed,
    autoLoadArmed: list.autoLoadArmed,
    pageEpoch: list.pageEpoch,
    restoredScrollTop: restored ? restored.scrollTop : null,
    noteScrollTop,
  };
}
```

- [ ] **Step 2: Run the existing hook tests**

```
npx vitest run src/routes/inbox/useInbox.test.tsx --root dashboard
```

Expected: the existing 36 tests PASS (the API of `useInbox(filter)` is
unchanged; `rowKey` is re-exported). If a test fails on module-level store
state leaking between cases, that is the order-dependence spec 7.1 warns
about: add the `clearInboxLists()` call from Step 3 first and re-run.

- [ ] **Step 3: Add the new hook tests**

In `dashboard/src/routes/inbox/useInbox.test.tsx`:

(a) Extend the api mock so `markInboxUnread` is controllable, and import the
store. Change the `vi.fn()` block at the top to:

```ts
const getInbox = vi.fn();
const markInboxRead = vi.fn();
const markInboxUnread = vi.fn();
const markConversationRead = vi.fn();
const noteRowsCleared = vi.fn();
const rollbackRowsCleared = vi.fn();
let sse: EventStreamHandlers = {};
```

and inside the `vi.mock('../../api/index.js', ...)` return object add
`markInboxUnread: (...a: unknown[]) => markInboxUnread(...a),` next to
`markInboxRead`.

(b) After the existing imports of `useInbox`/`Inbox`, add:

```ts
import { StrictMode } from 'react';
import { clearInboxLists, loadInboxList, saveInboxList } from './inboxListStore.js';
```

(c) In the top-level `beforeEach`, add as the first line:

```ts
  clearInboxLists();
```

and `markInboxUnread.mockReset().mockResolvedValue(undefined);` after the
`markInboxRead` line.

(d) Replace the `Probe` component with one that exposes the new state:

```tsx
function Probe({
  filter,
  limit,
  operatorId,
}: {
  filter: InboxFilter;
  limit?: number;
  operatorId?: string;
}): React.JSX.Element {
  const s = useInbox(filter, limit, operatorId);
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="count">{s.rows.length}</span>
      <span data-testid="ids">{s.rows.map((r) => rowKey(r)).join(',')}</span>
      <span data-testid="unread">{s.rows.map((r) => r.unreadCount).join(',')}</span>
      <span data-testid="hasMore">{String(s.hasMore)}</span>
      <span data-testid="groupsTruncated">{String(s.groupsTruncated)}</span>
      <span data-testid="truncated">{String(s.truncated)}</span>
      <span data-testid="serverRowCount">{String(s.serverRowCount)}</span>
      <span data-testid="groupRowsShown">{String(s.groupRowsShown)}</span>
      <span data-testid="loadingMore">{String(s.loadingMore)}</span>
      <span data-testid="refreshFailed">{String(s.refreshFailed)}</span>
      <span data-testid="armed">{String(s.autoLoadArmed)}</span>
      <span data-testid="epoch">{String(s.pageEpoch)}</span>
      <span data-testid="restoredScrollTop">{String(s.restoredScrollTop)}</span>
      <button onClick={() => s.loadMore()}>more</button>
      <button onClick={() => s.retry()}>retry</button>
      <button onClick={() => s.noteScrollTop(321)}>scroll</button>
      {s.rows.map((r) => (
        <span key={rowKey(r)}>
          <button onClick={() => s.markRead(r)}>read:{rowKey(r)}</button>
          <button onClick={() => s.markUnread(r)}>unread:{rowKey(r)}</button>
        </span>
      ))}
    </div>
  );
}
```

(e) Append a new `describe` block at the end of the file:

```tsx
describe('useInbox - page one persists (spec 5.5-5.8)', () => {
  const KEY = 'anon:all:2';
  function snapshot(rows: InboxRow[], cursor: string | null, scrollTop = 0) {
    return { head: rows, tail: [], cursor, groupsTruncated: false, truncated: false, scrollTop };
  }

  it('every head read and every page requests the hook limit', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], 'CUR'));
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c2' })], null));
    render(<Probe filter="all" limit={7} />);
    await waitFor(() => expect(screen.getByTestId('hasMore')).toHaveTextContent('true'));
    act(() => screen.getByRole('button', { name: 'more' }).click());
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
    expect((getInbox.mock.calls[0]?.[0] as { limit: number }).limit).toBe(7);
    expect((getInbox.mock.calls[1]?.[0] as { limit: number }).limit).toBe(7);
  });

  it('a store hit renders ready on the first paint, unarmed, and issues exactly one live head read under StrictMode', async () => {
    saveInboxList(KEY, snapshot([mkRow({ contactId: 'r1' }), mkRow({ contactId: 'r2' })], 'OLD', 55));
    let release: (v: InboxPage) => void = () => {};
    getInbox.mockImplementation(() => new Promise<InboxPage>((res) => { release = res; }));
    render(
      <StrictMode>
        <Probe filter="all" limit={2} />
      </StrictMode>,
    );
    expect(screen.getByTestId('status')).toHaveTextContent('ready');
    expect(screen.getByTestId('ids')).toHaveTextContent('c:r1,c:r2');
    expect(screen.getByTestId('armed')).toHaveTextContent('false');
    expect(screen.getByTestId('restoredScrollTop')).toHaveTextContent('55');
    // StrictMode issued two calls; the first was aborted by the simulated
    // cleanup. Exactly one is live: resolving it commits.
    const live = getInbox.mock.calls.filter((c) => !(c[1] as AbortSignal | undefined)?.aborted);
    expect(live).toHaveLength(1);
    act(() => release(pageOf([mkRow({ contactId: 'n1' }), mkRow({ contactId: 'n2' })], 'NEW')));
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('c:n1,c:n2'));
    expect(screen.getByTestId('armed')).toHaveTextContent('true');
  });

  it("the restore's complete head read replaces the whole restored list and issues no cursor request", async () => {
    const restoredRows = [mkRow({ contactId: 'r1' }), mkRow({ contactId: 'r2' }), mkRow({ contactId: 'r3' }), mkRow({ contactId: 'r4' })];
    saveInboxList(KEY, snapshot(restoredRows, 'TAIL'));
    getInbox.mockResolvedValue(pageOf([mkRow({ contactId: 'n1' }), mkRow({ contactId: 'r1' })], 'NEW'));
    render(<Probe filter="all" limit={2} />);
    expect(screen.getByTestId('count')).toHaveTextContent('4');
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('c:n1,c:r1'));
    expect(getInbox).toHaveBeenCalledTimes(1);
    expect((getInbox.mock.calls[0]?.[0] as { cursor?: string }).cursor).toBeUndefined();
  });

  it('a commit saves the committed value: a loaded page saves its rows AND its cursor together', async () => {
    getInbox
      .mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], 'C1'))
      .mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c2', lastActivityAt: '2026-06-17T09:00:00.000Z' })], 'C2'));
    render(<Probe filter="all" limit={1} />);
    await waitFor(() => expect(screen.getByTestId('hasMore')).toHaveTextContent('true'));
    expect(loadInboxList('anon:all:1')?.cursor).toBe('C1');
    act(() => screen.getByRole('button', { name: 'more' }).click());
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
    const saved = loadInboxList('anon:all:1');
    expect(saved?.tail.map((r) => r.contactId)).toEqual(['c2']);
    expect(saved?.cursor).toBe('C2');
  });

  it('a reset writes no snapshot: switching filters leaves the new key empty until its page commits', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], null));
    let release: (v: InboxPage) => void = () => {};
    const { rerender } = render(<Probe filter="all" limit={2} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    getInbox.mockImplementation(() => new Promise<InboxPage>((res) => { release = res; }));
    rerender(<Probe filter="unread" limit={2} />);
    expect(screen.getByTestId('status')).toHaveTextContent('loading');
    expect(loadInboxList('anon:unread:2')).toBeUndefined();
    expect(loadInboxList(KEY)?.head.map((r) => r.contactId)).toEqual(['c1']);
    act(() => release(pageOf([mkRow({ contactId: 'u1' })], null)));
    await waitFor(() => expect(loadInboxList('anon:unread:2')).toBeDefined());
  });

  it('a loadMore that settles after unmount neither commits nor saves', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], 'C1'));
    let release: (v: InboxPage) => void = () => {};
    const { unmount } = render(<Probe filter="all" limit={1} />);
    await waitFor(() => expect(screen.getByTestId('hasMore')).toHaveTextContent('true'));
    getInbox.mockImplementation(() => new Promise<InboxPage>((res) => { release = res; }));
    act(() => screen.getByRole('button', { name: 'more' }).click());
    unmount();
    const before = loadInboxList('anon:all:1');
    await act(async () => {
      release(pageOf([mkRow({ contactId: 'c2' })], 'C2'));
      await Promise.resolve();
    });
    expect(loadInboxList('anon:all:1')).toEqual(before);
    expect(before?.cursor).toBe('C1');
  });

  it('is alive again after a StrictMode replay: a later page commit saves', async () => {
    getInbox
      .mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], 'C1'))
      .mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], 'C1'))
      .mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c2', lastActivityAt: '2026-06-17T09:00:00.000Z' })], null));
    render(
      <StrictMode>
        <Probe filter="all" limit={1} />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByTestId('hasMore')).toHaveTextContent('true'));
    act(() => screen.getByRole('button', { name: 'more' }).click());
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
    expect(loadInboxList('anon:all:1')?.cursor).toBeNull();
  });

  it('the unmount save folds in a pending patch made in the same act and the reported scrollTop', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1', unreadCount: 2 })], null));
    let settle: () => void = () => {};
    markInboxRead.mockImplementation(() => new Promise<void>((res) => { settle = res; }));
    const { unmount } = render(<Probe filter="all" limit={2} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    act(() => {
      screen.getByRole('button', { name: 'scroll' }).click();
      screen.getByRole('button', { name: 'read:c:c1' }).click();
      unmount();
    });
    const saved = loadInboxList(KEY);
    expect(saved?.head[0]?.unreadCount).toBe(0);
    expect(saved?.scrollTop).toBe(321);
    settle();
  });

  it('loadMore dedupes against the list by rowKey and by conversationId across kinds, and arms only on new rows', async () => {
    const relay = mkRow({ kind: 'relay_group', contactId: undefined, conversationId: 'x', name: 'With x', status: 'open' });
    const group = { ...relay, kind: 'group_text' as const, status: undefined };
    getInbox
      .mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' }), relay], 'C1'))
      .mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' }), group], 'C2'))
      .mockResolvedValueOnce(pageOf([], 'C3'));
    render(<Probe filter="all" limit={1} />);
    await waitFor(() => expect(screen.getByTestId('hasMore')).toHaveTextContent('true'));
    act(() => screen.getByRole('button', { name: 'more' }).click());
    await waitFor(() => expect(screen.getByTestId('epoch')).toHaveTextContent('2'));
    expect(screen.getByTestId('ids')).toHaveTextContent('c:c1,gt:x');
    expect(screen.getByTestId('armed')).toHaveTextContent('true');
    act(() => screen.getByRole('button', { name: 'more' }).click());
    await waitFor(() => expect(screen.getByTestId('epoch')).toHaveTextContent('3'));
    expect(screen.getByTestId('armed')).toHaveTextContent('false');
    expect(screen.getByTestId('hasMore')).toHaveTextContent('true');
  });

  it('pageEpoch bumps on head and page commits, not on a mark-read commit, a reset or a failure', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1', unreadCount: 1 })], 'C1'));
    render(<Probe filter="all" limit={1} />);
    await waitFor(() => expect(screen.getByTestId('epoch')).toHaveTextContent('1'));
    act(() => screen.getByRole('button', { name: 'read:c:c1' }).click());
    await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('0'));
    expect(screen.getByTestId('epoch')).toHaveTextContent('1');
    getInbox.mockRejectedValueOnce(new ApiError(500, 'http_500', 'boom'));
    act(() => screen.getByRole('button', { name: 'more' }).click());
    await waitFor(() => expect(screen.getByTestId('loadingMore')).toHaveTextContent('false'));
    expect(screen.getByTestId('epoch')).toHaveTextContent('1');
  });

  it('a failed background head read with rows rendered keeps the rows and raises refreshFailed; a 404 does the same', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], null));
    render(<Probe filter="all" limit={2} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    getInbox.mockRejectedValueOnce(new ApiError(500, 'http_500', 'boom'));
    act(() => sse.onConversationUpdated?.({ conversationId: 'conv-1' } as never));
    await waitFor(() => expect(screen.getByTestId('refreshFailed')).toHaveTextContent('true'), { timeout: 2000 });
    expect(screen.getByTestId('status')).toHaveTextContent('ready');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    getInbox.mockRejectedValueOnce(new ApiError(404, 'http_404', 'gone'));
    act(() => screen.getByRole('button', { name: 'retry' }).click());
    await waitFor(() => expect(getInbox).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId('status')).toHaveTextContent('ready');
    expect(screen.getByTestId('refreshFailed')).toHaveTextContent('true');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
  });

  it('Retry with rows rendered never shows the spinner and clears the banner when the read commits', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], null));
    render(<Probe filter="all" limit={2} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    getInbox.mockRejectedValueOnce(new ApiError(500, 'http_500', 'boom'));
    act(() => sse.onConversationUpdated?.({ conversationId: 'conv-1' } as never));
    await waitFor(() => expect(screen.getByTestId('refreshFailed')).toHaveTextContent('true'), { timeout: 2000 });
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c9' })], null));
    act(() => screen.getByRole('button', { name: 'retry' }).click());
    expect(screen.getByTestId('status')).toHaveTextContent('ready');
    await waitFor(() => expect(screen.getByTestId('refreshFailed')).toHaveTextContent('false'));
    expect(screen.getByTestId('ids')).toHaveTextContent('c:c9');
  });

  // Review Focus 3: a zero-row budget exit with rows rendered is not a failure.
  it('an incomplete head read (zero rows with a cursor) changes nothing and raises no banner', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], 'C1'));
    render(<Probe filter="unknown" limit={2} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    getInbox.mockResolvedValueOnce(pageOf([], 'BUDGET'));
    act(() => sse.onConversationUpdated?.({ conversationId: 'conv-1' } as never));
    await waitFor(() => expect(getInbox).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await waitFor(() => expect(screen.getByTestId('epoch')).toHaveTextContent('2'));
    expect(screen.getByTestId('refreshFailed')).toHaveTextContent('false');
    expect(screen.getByTestId('ids')).toHaveTextContent('c:c1');
    expect(screen.getByTestId('hasMore')).toHaveTextContent('true');
  });

  it('a failed initial load with no rows still yields error', async () => {
    getInbox.mockRejectedValue(new ApiError(500, 'http_500', 'boom'));
    render(<Probe filter="all" limit={2} />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    expect(screen.getByTestId('refreshFailed')).toHaveTextContent('false');
  });

  it('keys the store by operator: another operator never sees the saved list', async () => {
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c1' })], null));
    const { unmount } = render(<Probe filter="all" limit={2} operatorId="u1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    unmount();
    getInbox.mockResolvedValueOnce(pageOf([mkRow({ contactId: 'c2' })], null));
    render(<Probe filter="all" limit={2} operatorId="u2" />);
    expect(screen.getByTestId('status')).toHaveTextContent('loading');
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('c:c2'));
  });
});
```

The SSE helper `sse.onConversationUpdated` is the handler captured by the
file's existing `useEventStream` mock; the `as never` cast avoids building a
full `ConversationUpdatedEvent` (the hook ignores the payload). The banner
waits use a 2000 ms timeout because the head read is debounced 300 ms.

- [ ] **Step 4: Run the hook tests**

```
npx vitest run src/routes/inbox/useInbox.test.tsx --root dashboard
```

Expected: PASS, 36 existing + 15 new. A failing existing test named in the
output is a regression in the rewrite, not a test to edit: fix the hook.

- [ ] **Step 5: Run the whole dashboard suite and typecheck**

```
npm run test -w @housingchoice/dashboard
npm run typecheck
```

Expected: both exit 0. `Inbox.test.tsx` mocks `useInbox`, so its cases pass
unchanged until Task 7 extends them.

- [ ] **Step 6: Commit**

Read bare `git status`, confirm no `MERGE_HEAD`, then:

```
git add dashboard/src/routes/inbox/useInbox.ts dashboard/src/routes/inbox/useInbox.test.tsx
git commit -m "feat(inbox): rebuild useInbox around one committed list with a restore-and-reconcile store

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The auto-load observer hook

**Files:**
- Create: `dashboard/src/routes/inbox/useAutoLoad.ts`
- Create: `dashboard/src/routes/inbox/useAutoLoad.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface AutoLoadObserver { observe(el: Element): void; disconnect(): void }
  export type AutoLoadObserverFactory = (onChange: (intersecting: boolean) => void, root: Element | null) => AutoLoadObserver | undefined;
  export function useAutoLoad(opts: {
    sentinel: Element | null;      // the sentinel node, or null while it is not rendered
    root: Element | null;          // the scroll container
    enabled: boolean;
    epoch: number;
    onLoad: () => void;
    observerFactory?: AutoLoadObserverFactory;   // tests inject one; default wraps IntersectionObserver
  }): void
  ```

- [ ] **Step 1: Write the failing tests**

Create `dashboard/src/routes/inbox/useAutoLoad.test.tsx`:

```tsx
import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoLoad, type AutoLoadObserverFactory } from './useAutoLoad.js';

// A hand-driven observer: tests flip intersection through `fire`.
let fire: (intersecting: boolean) => void = () => {};
let created = 0;
let disconnected = 0;
const factory: AutoLoadObserverFactory = (onChange) => {
  created += 1;
  fire = onChange;
  return { observe: () => {}, disconnect: () => { disconnected += 1; } };
};

const onLoad = vi.fn();

function Harness({ enabled, epoch, withSentinel = true }: { enabled: boolean; epoch: number; withSentinel?: boolean }): React.JSX.Element {
  const [sentinel, setSentinel] = useState<Element | null>(null);
  useAutoLoad({ sentinel, root: null, enabled, epoch, onLoad, observerFactory: factory });
  return withSentinel ? <div ref={setSentinel} data-testid="sentinel" /> : <div />;
}

beforeEach(() => {
  onLoad.mockReset();
  created = 0;
  disconnected = 0;
});
afterEach(() => vi.restoreAllMocks());

describe('useAutoLoad', () => {
  it('creates one observer per sentinel mount and fires once when intersection begins while enabled', () => {
    const { rerender } = render(<Harness enabled epoch={1} />);
    expect(created).toBe(1);
    act(() => fire(true));
    expect(onLoad).toHaveBeenCalledTimes(1);
    rerender(<Harness enabled epoch={1} />);
    expect(created).toBe(1);
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('does not fire while disabled, and does not fire when only enabled changes', () => {
    const { rerender } = render(<Harness enabled={false} epoch={1} />);
    act(() => fire(true));
    expect(onLoad).not.toHaveBeenCalled();
    // The failed-page shape: enabled flips true with no crossing and no epoch change.
    rerender(<Harness enabled epoch={1} />);
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('fires again on an epoch change while still intersecting, and not on an epoch change while not intersecting', () => {
    const { rerender } = render(<Harness enabled epoch={1} />);
    act(() => fire(true));
    expect(onLoad).toHaveBeenCalledTimes(1);
    rerender(<Harness enabled epoch={2} />);
    expect(onLoad).toHaveBeenCalledTimes(2);
    act(() => fire(false));
    rerender(<Harness enabled epoch={3} />);
    expect(onLoad).toHaveBeenCalledTimes(2);
  });

  it('a leave-and-re-enter fires again at the same epoch', () => {
    render(<Harness enabled epoch={1} />);
    act(() => fire(true));
    act(() => fire(false));
    act(() => fire(true));
    expect(onLoad).toHaveBeenCalledTimes(2);
  });

  // Review Focus 5: the sentinel unmounting resets intersection.
  it('resets intersection when the sentinel unmounts, so a returning sentinel waits for its observer', () => {
    const { rerender } = render(<Harness enabled epoch={1} />);
    act(() => fire(true));
    expect(onLoad).toHaveBeenCalledTimes(1);
    rerender(<Harness enabled={false} epoch={1} withSentinel={false} />);
    expect(disconnected).toBe(1);
    rerender(<Harness enabled epoch={2} withSentinel />);
    // New observer, no callback yet: nothing fires from the stale true.
    expect(created).toBe(2);
    expect(onLoad).toHaveBeenCalledTimes(1);
    act(() => fire(true));
    expect(onLoad).toHaveBeenCalledTimes(2);
  });

  it('installs nothing when the factory yields no observer (jsdom without IntersectionObserver)', () => {
    const none: AutoLoadObserverFactory = () => undefined;
    function Bare(): React.JSX.Element {
      const [s, setS] = useState<Element | null>(null);
      useAutoLoad({ sentinel: s, root: null, enabled: true, epoch: 1, onLoad, observerFactory: none });
      return <div ref={setS} />;
    }
    render(<Bare />);
    expect(onLoad).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```
npx vitest run src/routes/inbox/useAutoLoad.test.tsx --root dashboard
```

Expected: FAIL - "Failed to resolve import "./useAutoLoad.js"".

- [ ] **Step 3: Write the hook**

Create `dashboard/src/routes/inbox/useAutoLoad.ts`:

```ts
// useAutoLoad - fires `onLoad` when the list's sentinel scrolls into the
// 400px margin (spec 5.2). ONE observer per sentinel mount; its callback only
// records intersection state. The load itself fires from an EFFECT over
// [intersecting, enabled, epoch], so `onLoad` is always the current loadMore
// (no stale closure), and it fires exactly when intersection BEGINS or the
// list's page epoch CHANGES while intersecting. A change of `enabled` alone
// (a failed page re-enabling the button; hasMore appearing without a commit)
// never fires. Intersection is reset when the sentinel unmounts, so a
// returning sentinel waits for its own observer's first report.
import { useEffect, useRef, useState } from 'react';

export interface AutoLoadObserver {
  observe(el: Element): void;
  disconnect(): void;
}
export type AutoLoadObserverFactory = (
  onChange: (intersecting: boolean) => void,
  root: Element | null,
) => AutoLoadObserver | undefined;

const ROOT_MARGIN = '400px 0px';

const defaultFactory: AutoLoadObserverFactory = (onChange, root) => {
  if (typeof IntersectionObserver === 'undefined') return undefined;
  const io = new IntersectionObserver(
    (entries) => {
      const last = entries[entries.length - 1];
      if (last !== undefined) onChange(last.isIntersecting);
    },
    { root, rootMargin: ROOT_MARGIN },
  );
  return { observe: (el) => io.observe(el), disconnect: () => io.disconnect() };
};

export function useAutoLoad(opts: {
  sentinel: Element | null;
  root: Element | null;
  enabled: boolean;
  epoch: number;
  onLoad: () => void;
  observerFactory?: AutoLoadObserverFactory;
}): void {
  const { sentinel, root, enabled, epoch, onLoad, observerFactory } = opts;
  const [intersecting, setIntersecting] = useState(false);
  // The epoch at the last fire; -1 = never fired.
  const lastFiredEpochRef = useRef(-1);
  const wasIntersectingRef = useRef(false);

  useEffect(() => {
    if (sentinel === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIntersecting(false);
      return;
    }
    const observer = (observerFactory ?? defaultFactory)(setIntersecting, root);
    if (observer === undefined) return;
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
      setIntersecting(false);
    };
  }, [sentinel, root, observerFactory]);

  useEffect(() => {
    const began = intersecting && !wasIntersectingRef.current;
    wasIntersectingRef.current = intersecting;
    if (!enabled || !intersecting) return;
    if (began || epoch !== lastFiredEpochRef.current) {
      lastFiredEpochRef.current = epoch;
      onLoad();
    }
  }, [intersecting, enabled, epoch, onLoad]);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```
npx vitest run src/routes/inbox/useAutoLoad.test.tsx --root dashboard
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

Read bare `git status`, confirm no `MERGE_HEAD`, then:

```
git add dashboard/src/routes/inbox/useAutoLoad.ts dashboard/src/routes/inbox/useAutoLoad.test.tsx
git commit -m "feat(inbox): intersection-driven auto-load keyed on the page epoch

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 7: The Inbox page - limit param, sentinel, banner, scroll restore

**Files:**
- Modify: `dashboard/src/routes/inbox/Inbox.tsx` (whole-file replacement)
- Modify: `dashboard/src/routes/inbox/Inbox.module.css` (append)
- Modify: `dashboard/src/routes/inbox/Inbox.test.tsx`

**Interfaces:**
- Consumes: `useInbox(filter, limit, operatorId)` + `DEFAULT_PAGE_LIMIT`,
  `MAX_PAGE_LIMIT` (Task 5); `useAutoLoad` (Task 6); `useOptionalAuth`
  (Task 3); `useNavigationType`, `useSearchParams` from react-router-dom.
- Produces: `export function limitFromParam(raw: string | null): number`;
  the page renders a `role="status"` banner with a `Retry refresh` button,
  an `aria-hidden` sentinel while `hasMore`, and restores or zeroes the
  scroll container per spec 5.8.

- [ ] **Step 1: Write the failing tests**

In `dashboard/src/routes/inbox/Inbox.test.tsx`:

(a) Replace the `useInbox` mock so it records all three arguments, and give
`baseState` the new fields:

```ts
let seenFilter: string | undefined;
let seenLimit: number | undefined;
let seenOperator: string | undefined;
const noteScrollTop = vi.fn();
```

```ts
function baseState(over: Partial<InboxState> = {}): InboxState {
  return {
    status: 'ready',
    rows: [],
    groupsTruncated: false,
    truncated: false,
    serverRowCount: 0,
    groupRowsShown: 0,
    hasMore: false,
    loadingMore: false,
    loadMore,
    retry,
    markRead,
    markUnread,
    refreshFailed: false,
    autoLoadArmed: false,
    pageEpoch: 0,
    restoredScrollTop: null,
    noteScrollTop,
    ...over,
  };
}
```

```ts
    useInbox: (filter: string, limit: number, operatorId: string) => {
      seenFilter = filter;
      seenLimit = limit;
      seenOperator = operatorId;
      return state;
    },
```

and in `beforeEach` add `seenLimit = undefined; seenOperator = undefined; noteScrollTop.mockReset();`.

(b) Add these imports at the top:

```ts
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Inbox, limitFromParam } from './Inbox.js';
```

(replacing the existing `import { Inbox } from './Inbox.js';`).

(c) Append a new `describe` block:

```tsx
describe('Inbox - page size, banner, sentinel, scroll (spec 5.1/5.2/5.7/5.8)', () => {
  it.each([
    [null, 100],
    ['', 100],
    ['0', 100],
    ['-5', 100],
    ['abc', 100],
    ['1000', 100],
    ['1.5', 100],
    ['1', 1],
    ['12', 12],
    ['100', 100],
  ])('limitFromParam(%j) -> %i', (raw, expected) => {
    expect(limitFromParam(raw)).toBe(expected);
  });

  it('passes the URL limit (or the default) and the anon operator to the hook', () => {
    renderInbox('/inbox?limit=12');
    expect(seenLimit).toBe(12);
    expect(seenOperator).toBe('anon');
    cleanup();
    renderInbox('/inbox');
    expect(seenLimit).toBe(100);
  });

  it('renders the refresh banner with a Retry refresh button that calls retry, only while ready', () => {
    state = baseState({ rows: [mkRow()], serverRowCount: 1, refreshFailed: true });
    renderInbox();
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent("Couldn't refresh the inbox.");
    fireEvent.click(screen.getByRole('button', { name: 'Retry refresh' }));
    expect(retry).toHaveBeenCalledTimes(1);
    // The rows are still rendered under the banner.
    expect(screen.getByRole('link', { name: /Tasha Williams/ })).toBeInTheDocument();
    cleanup();
    state = baseState({ status: 'error', refreshFailed: true });
    renderInbox();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('renders the sentinel only while hasMore', () => {
    state = baseState({ rows: [mkRow()], serverRowCount: 1, hasMore: true });
    const { container } = renderInbox();
    expect(container.querySelector('[data-autoload-sentinel]')).not.toBeNull();
    cleanup();
    state = baseState({ rows: [mkRow()], serverRowCount: 1, hasMore: false });
    const { container: c2 } = renderInbox();
    expect(c2.querySelector('[data-autoload-sentinel]')).toBeNull();
  });

  it('the groups notice link and the tab switch both preserve a tuned limit', () => {
    state = baseState({ rows: [mkRow()], serverRowCount: 1, groupsTruncated: true, groupRowsShown: 1 });
    renderInbox('/inbox?limit=12');
    expect(screen.getByRole('link', { name: 'See all group texts' })).toHaveAttribute('href', '/inbox?limit=12&filter=groups');
    fireEvent.click(screen.getByRole('tab', { name: 'Unread' }));
    expect(seenFilter).toBe('unread');
    expect(seenLimit).toBe(12);
  });

  it('restores the saved scroll position on a POP arrival and zeroes it on a PUSH arrival', () => {
    const scroller = document.scrollingElement as HTMLElement;
    scroller.scrollTop = 999;
    state = baseState({ rows: [mkRow()], serverRowCount: 1, restoredScrollTop: 500 });
    // A MemoryRouter's initial entry is a POP navigation.
    renderInbox('/inbox');
    expect(scroller.scrollTop).toBe(500);
    expect(noteScrollTop).toHaveBeenCalledWith(500);
    cleanup();
    noteScrollTop.mockReset();
    scroller.scrollTop = 999;
    function PushToInbox(): React.JSX.Element {
      const navigate = useNavigate();
      useEffect(() => {
        navigate('/inbox');
      }, [navigate]);
      return <div />;
    }
    render(
      <MemoryRouter initialEntries={['/elsewhere']}>
        <Routes>
          <Route path="/elsewhere" element={<PushToInbox />} />
          <Route path="/inbox" element={<Inbox />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
    expect(scroller.scrollTop).toBe(0);
    expect(noteScrollTop).toHaveBeenCalledWith(0);
  });
});
```

Add `Routes, Route` to the `react-router-dom` import and `cleanup` to the
`@testing-library/react` import.

- [ ] **Step 2: Run the page tests to verify they fail**

```
npx vitest run src/routes/inbox/Inbox.test.tsx --root dashboard
```

Expected: FAIL - `limitFromParam` is not exported (the first case throws).

- [ ] **Step 3: Replace the page**

Replace the whole of `dashboard/src/routes/inbox/Inbox.tsx` with:

```tsx
// Inbox - the entity-centric communications hub. One row per contact (or
// untriaged unknown number, or group thread), newest-activity-first, with
// All (default) / Unread / Unknown / Groups filters. Opening a row navigates
// to its page AND marks its comms read (optimistic). State-sync lives in
// useInbox; this file owns the URL (filter + limit), the DOM the auto-load
// observer needs (the sentinel and the scroll container), the refresh-failure
// banner, and the scroll restore after a navigation (spec 5.1/5.2/5.7/5.8).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigationType, useSearchParams } from 'react-router-dom';
import type { InboxFilter } from '../../api/index.js';
import { useOptionalAuth } from '../../app/AuthContext.js';
import { Spinner } from '../../ui/index.js';
import { INBOX_FILTERS, emptyClearedCopy, emptyCopy, emptyMoreCopy } from './inboxFilters.js';
import { InboxRow } from './InboxRow.js';
import { useAutoLoad } from './useAutoLoad.js';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, rowKey, useInbox } from './useInbox.js';
import styles from './Inbox.module.css';

/** The filter query param is the SOURCE OF TRUTH for the active tab, so
 *  `/inbox?filter=groups` is a real, shareable deep link and the back button
 *  steps through filters. An unrecognized value degrades to All. */
function filterFromParam(raw: string | null): InboxFilter {
  return INBOX_FILTERS.some((t) => t.filter === raw) ? (raw as InboxFilter) : 'all';
}

/** The page size from `?limit=`: an integer 1..MAX_PAGE_LIMIT is honored;
 *  anything else falls back to the default (the same rule the server applies
 *  below its range). The server clamps again regardless. */
export function limitFromParam(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DEFAULT_PAGE_LIMIT;
  if (!/^\d+$/.test(raw.trim())) return DEFAULT_PAGE_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_LIMIT) return DEFAULT_PAGE_LIMIT;
  return n;
}

/** The nearest ancestor that scrolls vertically, else the document's
 *  scrolling element (jsdom, or a page that scrolls the window). */
function scrollParentOf(el: Element | null): Element | null {
  let cur = el?.parentElement ?? null;
  while (cur !== null) {
    const overflowY = getComputedStyle(cur).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return cur;
    cur = cur.parentElement;
  }
  return document.scrollingElement;
}

export function Inbox(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const filter = filterFromParam(params.get('filter'));
  const limit = limitFromParam(params.get('limit'));
  const operatorId = useOptionalAuth()?.me?.userId ?? 'anon';
  const navigationType = useNavigationType();
  const inbox = useInbox(filter, limit, operatorId);

  // THE EMPTY COPY DEPENDS ON WHETHER THE SERVER PAGE CAME BACK EMPTY WITH MORE
  // BEHIND IT, not on the filter alone (see emptyMoreCopy / emptyClearedCopy).
  // Both halves are server statements: `serverRowCount`, never `rows`.
  const empty = inbox.hasMore
    ? inbox.serverRowCount === 0
      ? emptyMoreCopy()
      : emptyClearedCopy()
    : emptyCopy(filter);
  const groupRowCount = inbox.groupRowsShown;
  const groupNoun = groupRowCount === 1 ? 'group text' : 'group texts';
  // The SERVER handed down no rows AND said the unread feed ended early.
  const serverEndedEarlyEmpty = inbox.serverRowCount === 0 && inbox.truncated;

  const selectFilter = useCallback(
    (next: InboxFilter) => {
      // 'all' is the default, so it stays OUT of the URL; a tuned limit rides along.
      const search: Record<string, string> = {};
      const tuned = params.get('limit');
      if (tuned !== null) search['limit'] = tuned;
      if (next !== 'all') search['filter'] = next;
      setParams(search, { replace: false });
    },
    [params, setParams],
  );
  const groupsHref = (() => {
    const search = new URLSearchParams();
    const tuned = params.get('limit');
    if (tuned !== null) search.set('limit', tuned);
    search.set('filter', 'groups');
    return `/inbox?${search.toString()}`;
  })();

  // --- The DOM the observer and the scroll restore need ----------------------
  const listRef = useRef<HTMLUListElement>(null);
  const [sentinel, setSentinel] = useState<Element | null>(null);
  const [scrollRoot, setScrollRoot] = useState<Element | null>(null);
  const restoredRef = useRef(false);
  const noteScrollTop = inbox.noteScrollTop;

  // Resolve the scroll container once the list exists; keep its scrollTop
  // reported to the hook through a passive listener.
  useLayoutEffect(() => {
    if (listRef.current === null) return;
    const root = scrollParentOf(listRef.current);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setScrollRoot(root);
  }, [inbox.rows.length > 0]);

  useEffect(() => {
    if (scrollRoot === null) return;
    const onScroll = (): void => noteScrollTop(scrollRoot.scrollTop);
    scrollRoot.addEventListener('scroll', onScroll, { passive: true });
    return () => scrollRoot.removeEventListener('scroll', onScroll);
  }, [scrollRoot, noteScrollTop]);

  // Scroll restore (spec 5.8): once, on the first render that has rows AND a
  // resolved container. POP (back/forward) restores the saved position; any
  // other store-backed arrival sets 0 explicitly (the container keeps the
  // previous page's offset otherwise, and a restored list is tall enough not
  // to clamp it).
  useLayoutEffect(() => {
    if (restoredRef.current || scrollRoot === null || inbox.rows.length === 0) return;
    restoredRef.current = true;
    if (inbox.restoredScrollTop === null) return;
    const target = navigationType === 'POP' ? inbox.restoredScrollTop : 0;
    scrollRoot.scrollTop = target;
    noteScrollTop(target);
  }, [scrollRoot, inbox.rows.length, inbox.restoredScrollTop, navigationType, noteScrollTop]);

  useAutoLoad({
    sentinel,
    root: scrollRoot,
    enabled: inbox.hasMore && inbox.autoLoadArmed && !inbox.loadingMore,
    epoch: inbox.pageEpoch,
    onLoad: inbox.loadMore,
  });

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Inbox</h1>
      <p className={styles.sub}>Triage texts and calls - every row opens its contact.</p>

      <div className={styles.tabs} role="tablist" aria-label="Inbox filters">
        {INBOX_FILTERS.map((tab) => (
          <button
            key={tab.filter}
            type="button"
            role="tab"
            aria-selected={filter === tab.filter}
            className={`${styles.tab} ${filter === tab.filter ? styles.tabActive : ''}`}
            onClick={() => selectFilter(tab.filter)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Spec 5.7: a background head read failed while rows were rendered. The
          rows stay; this is a status, not an alert (nothing was lost). */}
      {inbox.refreshFailed && inbox.status === 'ready' ? (
        <div className={styles.banner} role="status">
          <span>Couldn&apos;t refresh the inbox.</span>
          <button type="button" className={styles.retry} onClick={() => inbox.retry()}>
            Retry refresh
          </button>
        </div>
      ) : null}

      {inbox.groupsTruncated ? (
        <p className={styles.notice}>
          {groupRowCount === 0 ? (
            'Not all group texts are shown here.'
          ) : (
            <>
              Showing the latest {groupRowCount} {filter === 'unread' ? 'unread ' : ''}
              {groupNoun}.
            </>
          )}
          {filter !== 'groups' ? (
            <>
              {' '}
              <Link to={groupsHref}>
                {filter === 'unread'
                  ? 'Browse all group texts (read and unread)'
                  : 'See all group texts'}
              </Link>
            </>
          ) : null}
        </p>
      ) : null}

      {filter === 'unread' &&
      inbox.status === 'ready' &&
      inbox.truncated &&
      inbox.serverRowCount > 0 ? (
        <p className={styles.notice}>
          Showing the most recent unread. There are older unread threads not shown here.
        </p>
      ) : null}

      {inbox.status === 'loading' ? <Spinner center /> : null}

      {inbox.status === 'error' || (inbox.status === 'ready' && serverEndedEarlyEmpty) ? (
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

      {inbox.status === 'ready' && inbox.rows.length === 0 && !serverEndedEarlyEmpty ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{empty.title}</p>
          <p className={styles.emptyBody}>{empty.body}</p>
        </div>
      ) : null}

      {inbox.status === 'ready' && inbox.rows.length > 0 ? (
        <ul className={styles.rows} aria-label="Conversations" ref={listRef}>
          {inbox.rows.map((row) => (
            <InboxRow
              key={rowKey(row)}
              row={row}
              onOpen={inbox.markRead}
              onMarkRead={inbox.markRead}
              onMarkUnread={inbox.markUnread}
            />
          ))}
        </ul>
      ) : null}

      {/* The auto-load sentinel (spec 5.2): rendered only while there is more;
          the button below stays the accessible affordance. */}
      {inbox.status === 'ready' && inbox.hasMore ? (
        <div ref={setSentinel} className={styles.sentinel} aria-hidden="true" data-autoload-sentinel="" />
      ) : null}

      {/* LOAD MORE IS GATED ON `hasMore` ALONE, NOT ON THE PAGE HAVING ROWS: the
          Unknown tab's deliberate empty-page-with-a-cursor must stay clickable. */}
      {inbox.status === 'ready' && inbox.hasMore ? (
        <button
          type="button"
          className={styles.loadMore}
          onClick={() => inbox.loadMore()}
          disabled={inbox.loadingMore}
        >
          {inbox.loadingMore ? 'Loading...' : 'Load more'}
        </button>
      ) : null}
    </div>
  );
}
```

Note the subtitle: the previous file used a non-ASCII dash in "Triage texts
and calls - every row opens its contact." Keep the sentence but with the
ASCII hyphen above (the touched line must be ASCII). `inbox.spec.ts` does not
assert the subtitle. The "Loading..." button label likewise uses three ASCII
periods instead of the previous ellipsis character; no spec asserts it.

- [ ] **Step 4: Style the banner, the sentinel and the page root**

In `dashboard/src/routes/inbox/Inbox.module.css`, change the `.page` rule to:

```css
.page {
  /* Full-width: the list fills the AppFrame content area (which already pads the
   * gutters). No max-width cap - this nav page spans the whole window.
   * overflow-anchor: none on the PAGE ROOT (spec 5.2): it is the scroll
   * container's only child while the inbox is mounted, so excluding its whole
   * subtree from anchor selection leaves the scroller no anchor candidate, and
   * an inserted row or page pushes the sentinel DOWN instead of the browser
   * raising scrollTop to hold something in place (which would let auto-load
   * chain). On the <ul> alone the Load more button would become the anchor. */
  overflow-anchor: none;
}
```

and append:

```css
/* Spec 5.7: the refresh-failure banner. Quiet, not the error surface. */
.banner {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin: 0 0 var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  background: var(--c-surface-2);
  color: var(--c-text-muted);
  font-size: var(--fs-sm);
}
.banner .retry {
  margin-top: 0;
}

/* Spec 5.2: the auto-load sentinel. One pixel tall so it has a box to observe. */
.sentinel {
  height: 1px;
}
```

- [ ] **Step 5: Run the page tests, the whole dashboard suite and typecheck**

```
npx vitest run src/routes/inbox/Inbox.test.tsx --root dashboard
npm run test -w @housingchoice/dashboard
npm run typecheck
```

Expected: PASS (36 existing + 16 new in `Inbox.test.tsx`), then exit 0, exit 0.

- [ ] **Step 6: Commit**

Read bare `git status`, confirm no `MERGE_HEAD`, then:

```
git add dashboard/src/routes/inbox/Inbox.tsx dashboard/src/routes/inbox/Inbox.module.css dashboard/src/routes/inbox/Inbox.test.tsx
git commit -m "feat(inbox): page-size param, auto-load sentinel, refresh banner, scroll restore

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 8 (separable): Server prefetch on the `filter=all` pager

**Files:**
- Modify: `app/src/routes/inbox.ts` (the `aggregateInbox` closure: the three
  per-request caches, `rowForConversation`'s contact lookup, the pager loop)
- Modify: `app/test/inboxFeed.test.ts`

**Interfaces:**
- Consumes: `deps.contactsRepo.findByPhone/findByEmail`,
  `deps.messagesRepo.listByConversation`, `conversationsForContact`,
  `newestOf` (all existing).
- Produces: `InboxRouterDeps.inboxPrefetch?: boolean` (default on; tests pass
  `false` for the comparison arm); `HYDRATE_CONCURRENCY = 8` exported.
  Rows, order, cursor and the `inbox feed assembled` counts are identical
  with prefetch on and off.

If the equivalence test cannot be made green without changing the decision
loop's order or telemetry, STOP: revert this task's edits, leave a note in
the ledger, and file `docs/issues/inbox-all-page-hydration-sequential.md`
(spec 9). Tasks 1-7 and 9-11 do not depend on this task.

- [ ] **Step 1: Extend the test harness with a per-phone lookup failure**

In `app/test/inboxFeed.test.ts`, add to `interface Seed`:

```ts
  /** Make `contactsRepo.findByPhone` throw for ONE phone (the prefetch
   *  equivalence fixture: the sequential path skips the email lookup on it). */
  findByPhoneError?: { phone: string; error: Error };
```

and in `makeDeps`'s `contactsRepo.findByPhone`, before the return:

```ts
        if (seed.findByPhoneError !== undefined && seed.findByPhoneError.phone === phone) {
          throw seed.findByPhoneError.error;
        }
```

Also let `makeDeps` pass the prefetch switch through: change its
`routerOpts` parameter type to
`{ unreadWalkLimit?: number; inboxPrefetch?: boolean }` and add, next to the
`unreadWalkLimit` spread in the returned object:

```ts
    ...(routerOpts?.inboxPrefetch !== undefined && { inboxPrefetch: routerOpts.inboxPrefetch }),
```

- [ ] **Step 2: Write the failing tests**

Append to `app/test/inboxFeed.test.ts`:

```ts
describe('aggregateInbox - prefetch equivalence (spec 5.10)', () => {
  function captureLogger(): { logger: InboxRouterDeps['logger']; info: ReturnType<typeof vi.fn> } {
    const info = vi.fn();
    return {
      info,
      logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    };
  }
  function assembled(info: ReturnType<typeof vi.fn>): unknown {
    return info.mock.calls.find((c) => c[1] === 'inbox feed assembled')?.[0];
  }
  async function bothWays(
    seed: Seed,
    opts: { filter: 'all'; limit: number; cursor?: string },
  ): Promise<{ on: InboxPage; off: InboxPage; onLine: unknown; offLine: unknown; onCalls: InboxCallCounts; offCalls: InboxCallCounts }> {
    const onLog = captureLogger();
    const offLog = captureLogger();
    const onCalls = emptyCallCounts();
    const offCalls = emptyCallCounts();
    const on = await aggregateInbox(opts, makeDeps(seed, onCalls, onLog.logger, { inboxPrefetch: true }));
    const off = await aggregateInbox(opts, makeDeps(seed, offCalls, offLog.logger, { inboxPrefetch: false }));
    return { on, off, onLine: assembled(onLog.info), offLine: assembled(offLog.info), onCalls, offCalls };
  }
  /** Multi-number contacts, a relay group, an unknown number, a soft-deleted
   *  resurfacing contact, and a phone whose lookup throws. */
  function mixedSeed(): Seed {
    const base = splitSeed();
    return {
      ...base,
      contacts: [
        ...base.contacts,
        { contactId: 'c-del', type: 'tenant', phone: '+15550000090', deleted_at: '2026-06-05T00:00:00.000Z' },
      ],
      conversations: [
        ...base.conversations,
        relayConv({ conversationId: 'conv-relay', last_activity_at: '2026-06-09T12:00:00.000Z' }),
        conv({ conversationId: 'conv-unknown', participant_phone: '+15550000099', last_activity_at: '2026-06-08T12:00:00.000Z', unread_count: 1 }),
        conv({ conversationId: 'conv-del', participant_phone: '+15550000090', last_activity_at: '2026-06-07T12:00:00.000Z', unread_count: 1 }),
        conv({ conversationId: 'conv-throw', participant_phone: '+15550000098', participant_email: 'throw@example.com', last_activity_at: '2026-06-06T12:00:00.000Z' }),
      ],
      latestMessage: {
        'conv-1-new': { direction: 'inbound', body: 'newest', created_at: '2026-06-10T10:00:00.000Z' },
        'conv-unknown': { direction: 'inbound', body: 'who dis', created_at: '2026-06-08T12:00:00.000Z' },
        'conv-del': { direction: 'inbound', body: 'after delete', created_at: '2026-06-07T12:00:00.000Z' },
      },
      findByPhoneError: { phone: '+15550000098', error: new Error('lookup boom') },
    };
  }

  it('page one is identical with prefetch on and off: rows, order, cursor, assembled counts', async () => {
    const r = await bothWays(mixedSeed(), { filter: 'all', limit: 4 });
    expect(r.on.rows).toEqual(r.off.rows);
    expect(r.on.nextCursor).toEqual(r.off.nextCursor);
    expect(r.onLine).toEqual(r.offLine);
  });

  it('page two (cursor) is identical with prefetch on and off', async () => {
    const first = await aggregateInbox({ filter: 'all', limit: 4 }, makeDeps(mixedSeed()));
    const r = await bothWays(mixedSeed(), { filter: 'all', limit: 4, cursor: first.nextCursor! });
    expect(r.on.rows).toEqual(r.off.rows);
    expect(r.on.nextCursor).toEqual(r.off.nextCursor);
    expect(r.onLine).toEqual(r.offLine);
  });

  it('a failing conversation-set lookup produces the same page both ways', async () => {
    const seed = { ...mixedSeed(), participantConversationLookupError: new Error('convs boom') };
    const r = await bothWays(seed, { filter: 'all', limit: 25 });
    expect(r.on.rows).toEqual(r.off.rows);
    expect(r.onLine).toEqual(r.offLine);
  });

  it('the promise caches issue ONE read per key: repo call counts match the sequential path', async () => {
    const r = await bothWays(mixedSeed(), { filter: 'all', limit: 25 });
    // Every conversation the loop consumed was prefetched through the same
    // caches, so no key was read twice. Counts may only differ by conversations
    // the loop never reached (none here at limit 25).
    expect(r.onCalls.findByPhone).toBe(r.offCalls.findByPhone);
    expect(r.onCalls.findByParticipantPhone).toBe(r.offCalls.findByParticipantPhone);
    expect(r.onCalls.listByConversation).toBe(r.offCalls.listByConversation);
  });

  it('a throwing phone lookup skips the email lookup on both paths (the pair operation is memoized)', async () => {
    const seed = mixedSeed();
    seed.contacts.push({ contactId: 'c-email', type: 'tenant', email: 'throw@example.com' });
    const r = await bothWays(seed, { filter: 'all', limit: 25 });
    // Sequentially the throw aborted the whole lookup, so conv-throw is an
    // UNKNOWN row (its phone) rather than c-email's row. Prefetch must agree.
    const unknownRow = r.off.rows.find((row) => row.phone === '+15550000098');
    expect(unknownRow?.kind).toBe('unknown');
    expect(r.on.rows).toEqual(r.off.rows);
  });

  it('the stop flag ends scheduling when the page fills: reads stay near the page size, not the chunk', async () => {
    const contacts: ContactItem[] = [];
    const conversations: ConversationItem[] = [];
    for (let i = 0; i < 60; i++) {
      const phone = `+1555010${String(i).padStart(4, '0')}`;
      contacts.push({ contactId: `c-${i}`, type: 'tenant', phone });
      conversations.push(conv({ conversationId: `conv-${i}`, participant_phone: phone, last_activity_at: `2026-06-01T10:${String(59 - i).padStart(2, '0')}:00.000Z` }));
    }
    const calls = emptyCallCounts();
    await aggregateInbox({ filter: 'all', limit: 1 }, makeDeps({ contacts, conversations }, calls, undefined, { inboxPrefetch: true }));
    // The loop consumed ONE conversation. At most HYDRATE_CONCURRENCY chains
    // were in flight when it stopped scheduling, so the latest-message reads
    // are bounded by 1 + 8, not by the 25-conversation chunk.
    expect(calls.listByConversation).toBeLessThanOrEqual(9);
  });
});
```

`ContactItem` with `deleted_at` and `email`: if the type requires other
fields, add the minimum the type demands; do not change the type.

- [ ] **Step 3: Run the new tests to verify they fail**

```
cd app
npx vitest run test/inboxFeed.test.ts -t "prefetch equivalence"
cd ..
```

Expected: the equivalence tests PASS trivially (no prefetch exists yet, both
arms are sequential) except the stop-flag test, which FAILS only once
prefetch exists; and TypeScript complains about `inboxPrefetch` in
`routerOpts`. That is the expected red: the switch is not defined. (Run from
the `app` directory because the app suite needs DynamoDB Local only for the
integration files; `inboxFeed.test.ts` is in-memory and runs without it.)

- [ ] **Step 4: Add the switch and the promise caches**

In `app/src/routes/inbox.ts`:

(a) In `InboxRouterDeps`, after `unknownQueuePageSize`, add:

```ts
  /**
   * TEST SEAM (spec 5.10): `false` runs the `filter=all` pager without the
   * prefetch pass, so a test can prove the page is identical either way.
   * Production leaves it undefined (on).
   */
  inboxPrefetch?: boolean;
```

(b) Export the concurrency constant near `FETCH_BATCH`:

```ts
/**
 * How many per-row read chains the `filter=all` prefetch keeps in flight
 * (spec 5.10). The decision loop is untouched; this only decides how many of
 * its awaits resolve immediately.
 */
export const HYDRATE_CONCURRENCY = 8;
```

(c) Replace the value cache declaration
`const contactConvsCache = new Map<string, ConversationItem[]>();` with:

```ts
  // Per-request memoization as PROMISES (spec 5.10): a miss stores the
  // in-flight promise before awaiting it, so two callers for one key share one
  // read and the prefetch pass below can warm every cache the decision loop
  // reads. Each promise resolves to the degraded fallback the sequential path
  // produced - never a rejection - with the same WARN.
  const contactConvsCache = new Map<string, Promise<ConversationItem[]>>();
  const contactLookupCache = new Map<string, Promise<ContactItem | undefined>>();
  const latestRawCache = new Map<string, Promise<MessageItem | undefined>>();
```

(d) Replace the `contactConversations` function body with:

```ts
  const contactConversations = (contact: ContactItem): Promise<ConversationItem[]> => {
    const cached = contactConvsCache.get(contact.contactId);
    if (cached !== undefined) return cached;
    const read = (async (): Promise<ConversationItem[]> => {
      let list: ConversationItem[] = [];
      try {
        // Resolve across BOTH phones AND emails so a mixed contact's unread SUM
        // + newest-conversation choice include email-only threads. OPEN 1:1s
        // only; a native group text can never appear here (it writes neither
        // participant key and lives in `group_open`).
        const all = await conversationsForContact(contact, conversations);
        list = all.filter((c) => c.status === 'open' && c.type !== 'relay_group');
      } catch (err) {
        log.warn({ err, contactId: contact.contactId }, 'inbox: contact conversations lookup failed (best-effort)');
      }
      return list;
    })();
    contactConvsCache.set(contact.contactId, read);
    return read;
  };
```

(the unread branch's `contactConvsCache.delete(candidate.contactId)` keeps
working: deleting the promise forces the next caller to re-read).

(e) Add, after `contactConversations`:

```ts
  /** EXACTLY the contact lookup `rowForConversation` used to do inline: phone
   *  first, then email only if the phone found nothing, ONE try/catch (an
   *  error in either sets undefined with a WARN and skips the rest). Memoized
   *  as the PAIR so the prefetch and the loop take the same branches. */
  const resolveContact = (
    phone: string | undefined,
    email: string | undefined,
  ): Promise<ContactItem | undefined> => {
    const key = `${phone ?? ''}|${email ?? ''}`;
    const cached = contactLookupCache.get(key);
    if (cached !== undefined) return cached;
    const read = (async (): Promise<ContactItem | undefined> => {
      let contact: ContactItem | undefined;
      try {
        if (phone !== undefined) contact = await contacts.findByPhone(phone);
        if (!contact && email !== undefined) contact = await contacts.findByEmail(email);
      } catch (err) {
        log.warn({ err }, 'inbox: contact lookup failed (best-effort)');
        contact = undefined;
      }
      return contact;
    })();
    contactLookupCache.set(key, read);
    return read;
  };

  /** The RAW latest-message read, memoized per conversation. Derivation
   *  against a conversation image happens in latestMessageOf, so two images
   *  of one conversation never share a derived preview. */
  const latestRaw = (conversationId: string): Promise<MessageItem | undefined> => {
    const cached = latestRawCache.get(conversationId);
    if (cached !== undefined) return cached;
    const read = (async (): Promise<MessageItem | undefined> => {
      try {
        const page = await messages.listByConversation(conversationId, { limit: 1 });
        return page[0];
      } catch (err) {
        log.warn({ err, conversationId }, 'inbox: latest-message hydration failed (best-effort)');
        return undefined;
      }
    })();
    latestRawCache.set(conversationId, read);
    return read;
  };
```

(f) Replace `latestMessageOf`'s body with:

```ts
  const latestMessageOf = async (
    conversationId: string,
    conv: ConversationItem,
  ): Promise<DerivedLatest> => deriveLatest(await latestRaw(conversationId), conv);
```

(g) In `rowForConversation`, replace the inline lookup block

```ts
    let contact: ContactItem | undefined;
    try {
      if (phone !== undefined) contact = await contacts.findByPhone(phone);
      if (!contact && email !== undefined) contact = await contacts.findByEmail(email);
    } catch (err) {
      log.warn({ err }, 'inbox: contact lookup failed (best-effort)');
      contact = undefined;
    }
```

with:

```ts
    const contact: ContactItem | undefined = await resolveContact(phone, email);
```

- [ ] **Step 5: Add the prefetch pass to the pager**

Add, just above the `pager: for (;;) {` loop:

```ts
  /**
   * THE PREFETCH PASS (spec 5.10). Warms the three caches for a chunk's
   * conversations with a bounded window, so the sequential decision loop
   * below performs the same awaits in the same order and most of them resolve
   * immediately. It reads only through the caches, never writes any loop
   * state, and stops scheduling as soon as the loop is done with the chunk
   * (chains already in flight finish and are discarded).
   */
  const startPrefetch = (items: ConversationItem[]): { stop: () => void } => {
    let stopped = false;
    const queue = items.filter((c) => c.type !== 'relay_group' && c.type !== 'group_text');
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!stopped && next < queue.length) {
        const c = queue[next]!;
        next += 1;
        try {
          const contact = await resolveContact(c.participant_phone, c.participant_email);
          if (stopped) return;
          if (contact !== undefined) {
            const convs = await contactConversations(contact);
            if (stopped) return;
            const newest = newestOf(convs) ?? c;
            await latestRaw(newest.conversationId);
          } else {
            await latestRaw(c.conversationId);
          }
        } catch {
          // The caches never reject; defensive only.
        }
      }
    };
    for (let w = 0; w < HYDRATE_CONCURRENCY; w++) void worker();
    return {
      stop: () => {
        stopped = true;
      },
    };
  };
```

Then wrap the per-chunk consumption so the pass starts per chunk and stops
whatever way the chunk ends. Change:

```ts
    for (let i = 0; i < chunk.items.length; i++) {
      const conv = chunk.items[i]!;
      const row = await rowForConversation(conv);
```

to:

```ts
    const prefetch = deps.inboxPrefetch !== false ? startPrefetch(chunk.items) : undefined;
    try {
    for (let i = 0; i < chunk.items.length; i++) {
      const conv = chunk.items[i]!;
      const row = await rowForConversation(conv);
```

and close the `try` immediately after the inner `for` loop's closing brace
(before `if (!moreChunks) {`):

```ts
    }
    } finally {
      prefetch?.stop();
    }
```

(A `break pager` inside the `try` still runs the `finally`.) Reformat the
indentation with the repo's Prettier settings after the edit so the block
reads naturally; the structure is what matters.

`MessageItem` must be imported as a type in `inbox.ts` if it is not already
(it is used by `latestMessageOf` today, so it is).

- [ ] **Step 6: Run the feed tests and the full app unit suite**

```
cd app
npx vitest run test/inboxFeed.test.ts
cd ..
npm run typecheck
```

Expected: PASS (every existing case plus the 6 new), typecheck exit 0. If
any EXISTING `inboxFeed`/`inboxApi`/`inboxGroups`/`inboxUnread` case fails,
the prefetch changed a branch: diagnose before touching a test.

- [ ] **Step 7: Commit**

Read bare `git status`, confirm no `MERGE_HEAD`, then:

```
git add app/src/routes/inbox.ts app/test/inboxFeed.test.ts
git commit -m "perf(inbox): prefetch per-row reads on the all-tab pager through promise caches

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 9: The Playwright spec

**Files:**
- Create: `e2e/tests/dashboard-next/inbox-rows-timestamps.spec.ts`

**Interfaces:**
- Consumes: `reseed` (`e2e/fixtures/reseed.js`), `registerParty`,
  `sendAsParty` (`e2e/fixtures/fakeTwilio.js`), `expectTodayReady`
  (`e2e/support/today.js`), `NARROW_360`, `WIDE_RESTORE`,
  `expectNoHorizontalOverflow` (`e2e/support/viewport.js`); the dashboard
  built by Tasks 1-7 (the `data-autoload-sentinel` attribute, the
  `Retry refresh` button, the `Conversations` list, `<time>` elements).

- [ ] **Step 1: Write the spec**

Create `e2e/tests/dashboard-next/inbox-rows-timestamps.spec.ts`:

```ts
// Sam's improvements item #17 (spec docs/superpowers/specs/2026-09-25-inbox-rows-
// timestamps-design.md, section 7.3): a last-activity time on every inbox row,
// page size from ?limit=, auto-load on scroll, page one and the scroll position
// surviving a live update and the back button, and the refresh-failure banner.
//
// Hermetic e2e:session only. Every test RESEEDS first (and after, so the unread
// rows it mints never poison a later spec's "nothing unread" baseline) and mints
// its parties with run-unique numbers. Under filter=all at ?limit=N the lean
// world renders N contact rows PLUS the seeded group text and the connecting
// relay group; the counts below say "+ 2" for those.
//
// Request-log assertions count FINISHED inbox page requests (StrictMode issues
// and aborts one extra head read on every mount; an aborted request never
// reaches `requestfinished`). networkidle is never awaited: the SSE stream is
// an open request, so it would never settle.
//
// The auto-load DISARM on an empty page with a cursor (the Unknown tab's budget
// exit) is proven in the unit tests only; the lean world cannot cheaply produce
// that server state.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { reseed } from '../../fixtures/reseed.js';
import { registerParty, sendAsParty } from '../../fixtures/fakeTwilio.js';
import { expectTodayReady } from '../../support/today.js';
import { NARROW_360, WIDE_RESTORE, expectNoHorizontalOverflow } from '../../support/viewport.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const APP = process.env['E2E_APP_URL'] ?? 'http://127.0.0.1:9001';
const ORIGIN_SECRET = process.env['CF_ORIGIN_SECRET'] ?? 'dev-placeholder-not-a-secret';
const apiHeaders = { 'x-origin-verify': ORIGIN_SECRET };

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** Mint `n` fresh tenants, each with one inbound text, newest last. Returns
 *  their labels in send order. */
async function seedParties(request: APIRequestContext, n: number, stamp: string): Promise<string[]> {
  const labels: string[] = [];
  for (let i = 0; i < n; i++) {
    const number = `+1555${stamp.slice(-4)}${String(i).padStart(3, '0')}`;
    const label = `Party ${stamp} ${String(i).padStart(2, '0')}`;
    await registerParty(request, { label, role: 'tenant', number });
    await sendAsParty(request, { from: number, body: `hello from ${label}` });
    labels.push(label);
  }
  return labels;
}

interface SeenInboxRequest {
  url: string;
  cursor: boolean;
}
/** Every FINISHED page request to GET /api/inbox (not the badge count, not a
 *  read POST), in completion order. */
function trackInboxRequests(page: Page): SeenInboxRequest[] {
  const seen: SeenInboxRequest[] = [];
  page.on('requestfinished', (req) => {
    if (req.method() !== 'GET') return;
    const u = new URL(req.url());
    if (!u.pathname.endsWith('/api/inbox')) return;
    seen.push({ url: req.url(), cursor: u.searchParams.has('cursor') });
  });
  return seen;
}

const rows = (page: Page) => page.getByRole('list', { name: 'Conversations' }).getByRole('listitem');
const loadMore = (page: Page) => page.getByRole('button', { name: 'Load more' });
const scroller = (page: Page) => page.locator('main');

async function scrollToBottom(page: Page): Promise<void> {
  await scroller(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
}

test.describe('inbox rows and timestamps', () => {
  test.beforeEach(async ({ page, request }) => {
    await reseed(request);
    await devLogin(page);
  });
  test.afterEach(async ({ request }) => {
    await reseed(request);
  });

  test('1. every row shows its last-activity time', async ({ page, request }) => {
    const stamp = `${Date.now()}`.slice(-6);
    const [label] = await seedParties(request, 1, stamp);
    await page.goto(`${NEXT}/inbox`);
    const fresh = page.getByRole('link', { name: new RegExp(label!) });
    await expect(fresh).toBeVisible({ timeout: 15_000 });

    // The row's <time> carries the exact instant the API reports and a
    // clock-time label (the inbound is "today").
    const res = await page.request.get(`${APP}/api/inbox?limit=100`, { headers: apiHeaders });
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { rows: { name: string; lastActivityAt: string }[] };
    const apiRow = body.rows.find((r) => r.name === label);
    expect(apiRow).toBeDefined();
    const time = fresh.locator('time');
    await expect(time).toHaveAttribute('datetime', apiRow!.lastActivityAt);
    await expect(time).toHaveText(/^\d{1,2}:\d{2} [AP]M$/);

    // The lean seed's June rows show a date (year-agnostic so the spec survives
    // January): the 1:1 and the group text.
    await expect(page.getByRole('link', { name: /Tasha Nguyen/ }).locator('time')).toHaveText(
      /^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$/,
    );
    const groupRow = page.getByRole('link', { name: /Group text/ }).first();
    await expect(groupRow.locator('time')).toHaveText(/^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$/);
  });

  test('2. paging, then a live update refreshes page one and auto-load rebuilds the rest', async ({ page, request }) => {
    test.slow();
    const stamp = `${Date.now()}`.slice(-6);
    await seedParties(request, 3, stamp);
    const seen = trackInboxRequests(page);
    await page.goto(`${NEXT}/inbox?limit=2`);

    // Page one: the two newest contacts + the two multi-party rows.
    await expect(rows(page)).toHaveCount(4, { timeout: 15_000 });
    await expect(loadMore(page)).toBeVisible();

    // Scroll to the bottom: at limit=2 every page is short in pixels, so the
    // epoch rule chains to the end BY DESIGN (spec 5.2): 3 parties + Tasha + 2.
    await scrollToBottom(page);
    await expect(rows(page)).toHaveCount(6, { timeout: 15_000 });
    await expect(loadMore(page)).toHaveCount(0);

    // A live update: a fourth party texts. The list is never detached, the
    // head read replaces page one, and auto-load rebuilds the pages from the
    // fresh chain.
    const listHandle = await page.getByRole('list', { name: 'Conversations' }).elementHandle();
    const mark = seen.length;
    const [label4] = await seedParties(request, 1, `${stamp.slice(1)}4`);
    await expect(page.getByRole('link', { name: new RegExp(label4!) })).toBeVisible({ timeout: 15_000 });
    await expect(rows(page)).toHaveCount(7, { timeout: 15_000 });
    await expect(loadMore(page)).toHaveCount(0);
    expect(await listHandle!.evaluate((el) => el.isConnected)).toBe(true);

    // ORDER: exactly one head read after the inbound, and every cursor request
    // after it (none between the inbound and the head read).
    const after = seen.slice(mark);
    expect(after.filter((r) => !r.cursor)).toHaveLength(1);
    expect(after[0]?.cursor).toBe(false);
    expect(after.slice(1).every((r) => r.cursor)).toBe(true);

    // At the DEFAULT limit a page one holds everything: a further inbound adds
    // its row at the top, removes nothing, and issues no cursor request.
    await page.goto(`${NEXT}/inbox`);
    await expect(rows(page)).toHaveCount(7, { timeout: 15_000 });
    const mark2 = seen.length;
    const [label5] = await seedParties(request, 1, `${stamp.slice(1)}5`);
    await expect(page.getByRole('link', { name: new RegExp(label5!) })).toBeVisible({ timeout: 15_000 });
    await expect(rows(page)).toHaveCount(8);
    await expect(rows(page).first().getByRole('link')).toHaveText(new RegExp(label5!));
    await page.waitForTimeout(1000);
    expect(seen.slice(mark2).filter((r) => r.cursor)).toHaveLength(0);
  });

  test('3. the back button restores the list and the scroll position, then reconciles once', async ({ page, request }) => {
    test.slow();
    await page.setViewportSize({ width: 1280, height: 400 });
    const stamp = `${Date.now()}`.slice(-6);
    await seedParties(request, 6, stamp);
    const seen = trackInboxRequests(page);

    // Everything fits in page one at limit=10: 7 contacts + 2.
    await page.goto(`${NEXT}/inbox?limit=10`);
    await expect(rows(page)).toHaveCount(9, { timeout: 15_000 });
    await scrollToBottom(page);
    const saved = await scroller(page).evaluate((el) => el.scrollTop);
    expect(saved).toBeGreaterThan(0);

    const mark = seen.length;
    await rows(page).last().getByRole('link').click();
    await page.waitForURL(/\/(contacts|conversations)\//);
    await page.goBack();
    await page.waitForURL(/\/inbox/);
    // Restored instantly: the rows are there and the position is back. A fresh
    // mount would sit at 0 behind a spinner.
    await expect(rows(page)).toHaveCount(9);
    const restored = await scroller(page).evaluate((el) => el.scrollTop);
    expect(Math.abs(restored - saved)).toBeLessThanOrEqual(8);
    // Exactly one head read followed the return, and no cursor request.
    await expect.poll(() => seen.slice(mark).filter((r) => !r.cursor).length, { timeout: 10_000 }).toBe(1);
    await page.waitForTimeout(800);
    expect(seen.slice(mark).filter((r) => r.cursor)).toHaveLength(0);
    await expect(rows(page)).toHaveCount(9);

    // The Option B trade, pinned deliberately: at limit=2 the restore shows all
    // rows instantly, then the head read rebuilds from page one and auto-load
    // reloads the rest (one head read, THEN cursor requests).
    await page.goto(`${NEXT}/inbox?limit=2`);
    await expect(rows(page)).toHaveCount(4, { timeout: 15_000 });
    await scrollToBottom(page);
    await expect(rows(page)).toHaveCount(9, { timeout: 15_000 });
    await expect(loadMore(page)).toHaveCount(0);
    const mark2 = seen.length;
    await rows(page).last().getByRole('link').click();
    await page.waitForURL(/\/(contacts|conversations)\//);
    await page.goBack();
    await page.waitForURL(/\/inbox/);
    await expect(rows(page)).toHaveCount(9);
    await expect.poll(() => seen.slice(mark2).length, { timeout: 15_000 }).toBeGreaterThan(1);
    await expect(rows(page)).toHaveCount(9, { timeout: 15_000 });
    await expect(loadMore(page)).toHaveCount(0, { timeout: 15_000 });
    const after = seen.slice(mark2);
    expect(after[0]?.cursor).toBe(false);
    expect(after.filter((r) => !r.cursor)).toHaveLength(1);
    expect(after.slice(1).every((r) => r.cursor)).toBe(true);
  });

  test('4. the time fits at phone width, in the tightest one-line band, and ordinary names are not ellipsized wide', async ({ page, request }) => {
    const stamp = `${Date.now()}`.slice(-6);
    const longLabel = `Bartholomew Montgomery-Fitzgerald-Longname ${stamp}`;
    const longNumber = `+1555${stamp.slice(-4)}999`;
    await registerParty(request, { label: longLabel, role: 'tenant', number: longNumber });
    await sendAsParty(request, { from: longNumber, body: 'a long name' });
    const [plain] = await seedParties(request, 1, stamp);

    async function timeInsideRow(link: ReturnType<Page['getByRole']>, where: string): Promise<{ row: { x: number; y: number; width: number; height: number }; time: { x: number; y: number; width: number; height: number } }> {
      const li = link.locator('xpath=ancestor::li[1]');
      const row = await li.boundingBox();
      const time = await link.locator('time').boundingBox();
      expect(row, `${where}: row box`).not.toBeNull();
      expect(time, `${where}: time box`).not.toBeNull();
      expect(time!.width, `${where}: time has width`).toBeGreaterThan(0);
      expect(time!.x + time!.width, `${where}: time inside row (right edge)`).toBeLessThanOrEqual(row!.x + row!.width + 1);
      expect(time!.x, `${where}: time inside row (left edge)`).toBeGreaterThanOrEqual(row!.x - 1);
      return { row: row!, time: time! };
    }

    await page.setViewportSize(NARROW_360);
    await page.goto(`${NEXT}/inbox`);
    const longRow = page.getByRole('link', { name: new RegExp(longLabel) });
    await expect(longRow).toBeVisible({ timeout: 15_000 });
    await expectNoHorizontalOverflow(page, 'inbox at 360');
    const narrow = await timeInsideRow(longRow, 'narrow');
    // Two-line layout: the time sits in the row's top half.
    expect(narrow.time.y + narrow.time.height).toBeLessThanOrEqual(narrow.row.y + narrow.row.height / 2 + 2);

    // The tightest one-line band: sidebar open, content about 480px.
    await page.setViewportSize({ width: 768, height: 720 });
    await expect(longRow).toBeVisible();
    await timeInsideRow(longRow, 'one-line at 768');

    await page.setViewportSize(WIDE_RESTORE);
    const plainName = page.getByRole('link', { name: new RegExp(plain!) }).getByText(plain!, { exact: true });
    await expect(plainName).toBeVisible();
    expect(await plainName.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });

  test('5. a failed background refresh keeps the rows and shows a banner whose Retry clears it', async ({ page, request }) => {
    const stamp = `${Date.now()}`.slice(-6);
    await seedParties(request, 1, stamp);
    await page.goto(`${NEXT}/inbox`);
    await expect(rows(page)).toHaveCount(4, { timeout: 15_000 });

    // Fail HEAD reads only (no cursor in the query); leave the badge count alone.
    const failHead = (url: URL): boolean => url.pathname.endsWith('/api/inbox') && !url.searchParams.has('cursor');
    await page.route(failHead, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }));
    const [label2] = await seedParties(request, 1, `${stamp.slice(1)}2`);
    const banner = page.getByRole('status').filter({ hasText: "Couldn't refresh the inbox." });
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(rows(page)).toHaveCount(4);
    await expect(page.getByRole('link', { name: new RegExp(label2!) })).toHaveCount(0);

    await page.unroute(failHead);
    await banner.getByRole('button', { name: 'Retry refresh' }).click();
    await expect(banner).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole('link', { name: new RegExp(label2!) })).toBeVisible();
    await expect(rows(page)).toHaveCount(5);
  });

  test('6. auto-load does not chain at the group wall: one cursor request per scroll', async ({ page, request }) => {
    test.slow();
    await page.setViewportSize({ width: 1280, height: 400 });
    const stamp = `${Date.now()}`.slice(-6);
    await seedParties(request, 30, stamp);
    const seen = trackInboxRequests(page);

    // A 12-row page is taller than the viewport plus the 400px margin, so a
    // committed page pushes the sentinel out of the margin (spec 5.2).
    await page.goto(`${NEXT}/inbox?limit=12`);
    await expect(rows(page)).toHaveCount(14, { timeout: 15_000 });
    const mark = seen.length;
    await scrollToBottom(page);
    await expect(rows(page)).toHaveCount(26, { timeout: 15_000 });
    await page.waitForTimeout(1500);
    expect(seen.slice(mark).filter((r) => r.cursor)).toHaveLength(1);
    await expect(rows(page)).toHaveCount(26);

    await scrollToBottom(page);
    await expect(rows(page)).toHaveCount(33, { timeout: 15_000 });
    await expect(loadMore(page)).toHaveCount(0);
    await page.waitForTimeout(800);
    expect(seen.slice(mark).filter((r) => r.cursor)).toHaveLength(2);
  });
});
```

Counts in test 6 assume 30 parties + Tasha = 31 contacts at 12 per page
(12, 12, 7) plus the 2 multi-party rows: 14, 26, 33. If the measured row
height makes a 12-row page shorter than 800px (viewport + margin), raise
`limit` and the party count together and recompute the three counts.

- [ ] **Step 2: Run the spec alone in a session lane**

From `W:\tmp\inbox-rows-timestamps` (never against the human's live ports):

```
npm run e2e:session
```

wait for the lane to report ready, then in a second shell:

```
npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/inbox-rows-timestamps.spec.ts
```

Expected: 6 passed. A count mismatch in test 6 is the row-height note above;
a timing failure in test 2 or 3 is a real ordering defect, not a flake (see
AGENTS.md: there is no named-flake list).

Then stop the session:

```
npm run e2e:stop
```

- [ ] **Step 3: Commit**

Read bare `git status`, confirm no `MERGE_HEAD`, then:

```
git add e2e/tests/dashboard-next/inbox-rows-timestamps.spec.ts
git commit -m "test(e2e): inbox rows, timestamps, auto-load, back-button restore and the refresh banner

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 10: Issue registry updates

**Files:**
- Modify: `docs/issues/inbox-reconcile-failure-blanks-list.md`
- Modify: `docs/issues/seen-set-max-equals-max-inbox-limit.md`
- Create: `docs/issues/contact-timeline-time-format-differs-from-inbox.md`
- Create: `docs/issues/inbox-labels-do-not-roll-over-at-midnight.md`
- Create: `docs/issues/inbox-unread-page-hydration-sequential.md`

(`docs/issues/inbox-loaded-pages-survive-refresh.md` already exists on the
branch, committed with the spec.)

- [ ] **Step 1: Resolve the reconcile-failure decision**

In `docs/issues/inbox-reconcile-failure-blanks-list.md` set the frontmatter
`status: resolved` and add `resolved: 2026-09-25` after `created:`; then add,
directly under the frontmatter:

```markdown
**Resolution (2026-09-25).** Ruled by Cameron and built on
`feat/inbox-rows-timestamps` (spec
`docs/superpowers/specs/2026-09-25-inbox-rows-timestamps-design.md`, section
5.7): a head read that fails while rows are rendered keeps the rows and sets
`refreshFailed`; `Inbox.tsx` renders a `role="status"` banner ("Couldn't
refresh the inbox.") with a `Retry refresh` button that re-reads without a
spinner. A 404 in that state is treated the same way. A failed read with no
rows rendered keeps the previous error/pending surfaces. Option 1 of the
list below, with the failure made visible (what option 3 wanted preserved).
```

- [ ] **Step 2: Update the seen-set issue's reachability paragraph**

In `docs/issues/seen-set-max-equals-max-inbox-limit.md`, replace the sentence
beginning `Nothing ships broken. The dashboard pages at 30` (and its
citation) with:

```markdown
Nothing ships broken, but the margin is now live: since
`feat/inbox-rows-timestamps` (2026-09-25) the dashboard requests `limit=100`
(`dashboard/src/routes/inbox/useInbox.ts`, `DEFAULT_PAGE_LIMIT`), which is
exactly `SEEN_SET_MAX`. The strict `>` comparison keeps page two reachable
(a 100-row page one seeds a 100-id seen-set, not `> 100`), and the two
ordering tests at `app/test/inboxFeed.test.ts:1397` and `:1417` still cover
the cap; the pinning boundary test proposed below is now worth landing.
This stays `debt`, and stays `low`.
```

and set `updated: 2026-09-25` in the frontmatter.

- [ ] **Step 3: File the three follow-ups**

Create `docs/issues/contact-timeline-time-format-differs-from-inbox.md`:

```markdown
---
id: contact-timeline-time-format-differs-from-inbox
title: The contact timeline prints "9:14a" while the inbox prints "9:14 AM"
type: improvement
severity: low
status: open
area: dashboard
created: 2026-09-25
refs: dashboard/src/routes/contact/format.ts, dashboard/src/routes/inbox/inboxTime.ts
---

**Problem.** Two clock formats in one dashboard. `contact/format.ts`
(`formatTime`) renders "9:14a" on the timeline and its call cards;
`inbox/inboxTime.ts` renders "9:14 AM" on inbox rows, chosen because the
inbox is the screen Sam compares to her phone (spec
`2026-09-25-inbox-rows-timestamps-design.md`, decision 5). A new staffer sees
both.

**Suggested fix.** Decide once (the phone convention is the recommendation)
and align `formatTime` / `formatTimeWithSeconds` / their accessible names,
updating the timeline specs that pin the short form.
```

Create `docs/issues/inbox-labels-do-not-roll-over-at-midnight.md`:

```markdown
---
id: inbox-labels-do-not-roll-over-at-midnight
title: An inbox row's time label rolls from "2:14 PM" to "Yesterday" only on the next re-render
type: debt
severity: low
status: open
area: dashboard/inbox
created: 2026-09-25
refs: dashboard/src/routes/inbox/InboxRow.tsx, dashboard/src/routes/inbox/inboxTime.ts
---

**Problem.** `InboxRow` computes its label at render time from `new Date()`.
A page left open across local midnight keeps showing a clock time for rows
that are now "Yesterday" until anything re-renders the list (a live update,
a navigation). The contact timeline's day dividers accept the same thing.
Accepted in the spec (section 4.2) rather than adding a periodic re-render.

**Suggested fix.** If it ever matters: one interval in `Inbox.tsx` that bumps
a `now` state at the next local midnight and every midnight after, passed to
`InboxRow` as a prop.
```

Create `docs/issues/inbox-unread-page-hydration-sequential.md`:

```markdown
---
id: inbox-unread-page-hydration-sequential
title: The Unread and Unknown inbox pages hydrate one row at a time; at limit=100 that is up to 100 sequential reads per refresh
type: debt
severity: low
status: open
area: app/inbox
created: 2026-09-25
refs: app/src/routes/inbox.ts
---

**Problem.** `feat/inbox-rows-timestamps` raised the dashboard's page size
to 100 and prefetched the `filter=all` pager's per-row reads through
promise-memoized caches (spec section 5.10). The `filter=unread` and
`filter=unknown` branches were left sequential: each row still awaits its
latest-message read (and, on Unread, its contact hydration) in turn. Unread
is a triage set that is usually far short of 100 rows, and `?limit=` tunes
it, so this was accepted.

**Suggested fix.** If a measured Unread page is slow for Sam, apply the same
prefetch pass to the unread candidates: the caches are already shared
closures, so only the window and the `stop` flag are new.
```

- [ ] **Step 4: Regenerate the index and commit**

```
npm run issues
```

(regenerates the gitignored `docs/issues/INDEX.md`; nothing to stage from
it). Read bare `git status`, confirm no `MERGE_HEAD`, then:

```
git add docs/issues/inbox-reconcile-failure-blanks-list.md docs/issues/seen-set-max-equals-max-inbox-limit.md docs/issues/contact-timeline-time-format-differs-from-inbox.md docs/issues/inbox-labels-do-not-roll-over-at-midnight.md docs/issues/inbox-unread-page-hydration-sequential.md
git commit -m "docs(issues): resolve the reconcile-failure decision; file the inbox follow-ups

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Gates, perf self-QA and live self-QA

**Files:** none new. Run from `W:\tmp\inbox-rows-timestamps`, bare, never
piped; capture output to a file under `.superpowers/` by redirection only
AFTER the command exits (the orchestrator's manual owns the exact capture
shape).

- [ ] **Step 1: Sync `main` once**

```
git fetch origin
git merge main
```

Resolve conflicts preserving both sides' intent; if `main` moved files this
plan edits, re-run the affected task's tests before continuing.

- [ ] **Step 2: The five gates**

```
npm run typecheck
npm test
npm run smoke
npm run e2e
npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')
```

Expected: exit 0 for each. `npm test` needs DynamoDB Local (`npm run db:start`
first). `npm run e2e` must not run while an `e2e:session` lane is live in
this worktree; use a hard outer timeout of 1500 s and read the verdict from
the captured log. Gate 5: if it reports errors, run the same command on the
same paths at the merge base and diff; only errors present now and absent
there are yours (AGENTS.md, gate 5). `.mjs`/`.js` files exit 0 unchecked.

- [ ] **Step 3: The perf harness self-QA (spec 5.11)**

```
npm run perf:pages
```

Expected: the hermetic run reports its inbox self-QA invariants satisfied
(one initial page request per inbox sample, no `cursor` request). A
violation on a warm inbox sample means a harness flow visited `/inbox`
twice: report it rather than editing the harness.

- [ ] **Step 4: Live self-QA in a session lane**

```
npm run e2e:session
```

Drive the lane with the Playwright MCP (bundled Chromium, `--isolated`,
dev-login first). Prove, with screenshots under `.playwright-mcp/`:

1. `/inbox` at 1280 wide: times right-aligned in one column; hover a row: the
   overlay covers the time; a group text row and the relay row show times.
2. Phone width (360): two-line rows, time top right, no horizontal scroll.
3. Send an inbound through the fake while scrolled mid-list: the list does
   not jump to the top; the new row appears at the top.
4. Open a row, press back: the list and position are back without a spinner.
5. `/inbox?limit=2`: auto-load appends on scroll; Load more disappears at the
   end.

Then `npm run e2e:stop`. Write the self-QA notes to
`docs/superpowers/reviews/2026-09-25-inbox-rows-timestamps/self-qa.md`
(the record) and commit them.

- [ ] **Step 5: Handback**

Per the profile: bare gate exit codes, the live Playwright result, reviewer
findings and adjudications, current `main` drift, owed operator actions
(none expected: no infra, no deps, no env). Never merge.

---

## Self-review (planner, 2026-09-25)

**Spec coverage.** 5.1 -> Tasks 5, 7. 5.2 -> Tasks 6, 7 (`overflow-anchor`
on the page root), 9 (test 6). 5.3 -> Task 1. 5.4 -> Task 2 (+ Task 9 test
4). 5.5/5.6 -> Tasks 4, 5. 5.7 -> Tasks 5, 7 (+ Task 9 test 5). 5.8 -> Tasks
3, 5, 7 (+ Task 9 test 3). 5.9 -> no code change; Task 9 test 6 is its
proof. 5.10 -> Task 8. 5.11 -> Task 11 step 3. Section 9 -> Task 10.
Invariants 1-10 -> pinned in Tasks 4, 5, 6, 7, 8, 9.

**Placeholder scan.** No TBD/TODO; every code step carries the code; the two
"if the type demands more fields" notes are conditional on facts a builder
reads in the type, not deferrals.

**Type consistency.** `useInbox(filter, limit, operatorId)` (Task 5) matches
Task 7's call and Task 5's tests; `InboxState` fields `refreshFailed`,
`autoLoadArmed`, `pageEpoch`, `restoredScrollTop`, `noteScrollTop` are used
by Task 7 exactly as named; `useAutoLoad`'s option names (`sentinel`,
`root`, `enabled`, `epoch`, `onLoad`, `observerFactory`) match Tasks 6 and
7; the store's `InboxListSnapshot` fields match Tasks 3 and 5; the merge
module's exports match Tasks 4 and 5; `inboxPrefetch` and
`HYDRATE_CONCURRENCY` match Task 8's code and tests.

**Review Focus.** Items 1-5 are pinned in Tasks 1, 3, 5, 5 and 6 as
listed at the top.

**Known judgment calls for the plan reviewers.** (a) Task 7 resolves the
scroll container by walking `getComputedStyle().overflowY`, falling back to
`document.scrollingElement`; jsdom reports no computed overflow, so the unit
test asserts against the document's scrolling element. (b) Task 8's
equivalence fixtures reuse `splitSeed()`; a builder must confirm
`ContactItem` accepts `deleted_at` and `email` as written. (c) Task 9 test 6's
counts assume a 12-row page taller than 800px at the desktop row height.

