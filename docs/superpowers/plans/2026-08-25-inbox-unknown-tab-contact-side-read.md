# Inbox Unknown Tab: Contact-Side Read - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Unknown inbox tab's full open-partition walk (~684 contact
lookups across 24 Queries for at most 8 rows in prod) with a bounded read of the
`type=unknown` contact partition, plus a byUnread sweep for deleted-contact
resurfacing, so cost is proportional to rows RETURNED - and give the remaining
open-partition pager (filter=all) a raw-scan budget so no unbounded read
survives on the route.

**Architecture:** A new `filter === 'unknown'` branch in `aggregateInbox`
(`app/src/routes/inbox.ts`) returns before the open-partition pager, exactly as
the `groups` and `unread` branches already do. It reads the whole capped
`(type='unknown')` byTypeStatus partition through a new module-level collector
(`app/src/lib/unknownQueue.ts` - fill loop, result cap, truncation WARN), does a
live type re-check per contact, resolves each contact's open non-relay threads
by calling `conversationsForContact` DIRECTLY (so "query threw" and "filtered to
nothing" are different code paths), builds rows with the existing
`buildContactRow` closure, folds in soft-deleted resurfacing candidates from one
`collectUnreadRows` sweep, sorts in memory, and returns a single page
(`nextCursor: null`, never the `truncated` wire flag). A final task adds the
budget + cursor + truncated contract to the `filter=all` pager (spec section 5).

**Tech Stack:** TypeScript (Node 24, ESM `.js` import specifiers), Express 5,
DynamoDB (byTypeStatus GSI + byUnread sparse GSI), Vitest, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-08-25-inbox-unknown-tab-walk-design.md`
(APPROVED - do not re-litigate its decisions; this plan implements them).

## Global Constraints

- ASCII-only in every added line of tests, docs, log strings, and comments.
- Never rewrite files with `Get-Content | -replace | Set-Content`; use edit tools.
- Commit explicit paths only (never `git add -A`); read bare `git status` before
  every commit; end each commit message with a `Co-Authored-By:` trailer naming
  the authoring model, e.g. `Co-Authored-By: Claude <noreply@anthropic.com>`
  with your actual model name.
- Never pipe or `;`-chain a gate command; run gates bare and read the exit code.
- Do NOT start `npm run e2e`, `npm run e2e:session`, or any server/container
  during tasks 1-10; the e2e suite runs once, at the gates task, from this
  worktree (`W:\tmp\inbox-unread-cluster`).
- Never touch the human's live ports (`:5174` / `:8080`).
- Unit-test commands in this plan run from the app workspace:
  `cd W:\tmp\inbox-unread-cluster\app` first. Dashboard tests run from
  `W:\tmp\inbox-unread-cluster\dashboard`.
- Copy strings that are pinned elsewhere and must NOT change: the dashboard
  empty-state title `No unknown numbers` (`dashboard/src/routes/inbox/inboxFilters.ts:27`)
  is pinned by the perf route contract (`e2e/performance/routes.ts:583`,
  `e2e/performance/routes.test.ts:327`). Do not edit `inboxFilters.ts`.
- The wire endpoint stays `GET /api/inbox?filter=unknown&limit=...` - the perf
  harness pins exact query-key tuples; do not add or rename query params.
- Do not modify `app/test/helpers/twilioWebhookHarness.ts` - its `listByType`
  fake (line 1684) already exists and route tests depend on its current
  semantics.

## Load-bearing facts about the current code (verified 2026-08-25)

The executor of any task can rely on these; each was read from the worktree:

- `aggregateInbox` branches: `groups` returns at `inbox.ts:1034`, `unread` at
  `inbox.ts:1064`; the open-partition pager (`pager: for (;;)`) serves `all`
  AND `unknown` today, starting `inbox.ts:1474`. The cursor decode for both is
  gated `(filter === 'all' || filter === 'unknown')` at `inbox.ts:576-579`.
- `buildContactRow(contact, convs, maxConv, unreadSum, deleted)` is a CLOSURE
  inside `aggregateInbox` (`inbox.ts:742-828`). It returns `undefined` for
  exactly one reason: resurfacing hid a soft-deleted row. With `deleted=false`
  it always returns a row.
- `contactConversations` (`inbox.ts:634-658`) catches, logs
  `'inbox: contact conversations lookup failed (best-effort)'` and returns `[]`
  - it can NEVER carry the threw-vs-empty distinction. Requirement 4 is met by
  calling `conversationsForContact` (`app/src/lib/contactThreads.ts:38-54`,
  signature `conversationsForContact(contact, Pick<ConversationsRepo,
  'findByParticipantPhone' | 'findByParticipantEmail'>)`) directly with a local
  try/catch.
- `roleFromContact` (`inbox.ts:396-403`) falls anything that is not
  tenant/landlord/partner through to `'unknown'` - including `team_member`.
- `contactsRepo.listByType(type, opts)` (`app/src/repos/contactsRepo.ts:522`,
  opts at `:472-490`) returns `ContactsPage { items, lastEvaluatedKey? }`. Its
  `deleted` option is tri-state (default excludes deleted via a
  FilterExpression `attribute_not_exists(deleted_at)`; `true` returns ONLY
  deleted) - "both" is not expressible. `Limit` applies at the index BEFORE any
  FilterExpression, so a page thick with soft-deleted rows returns short (even
  empty) pages WITH a `lastEvaluatedKey`.
- The precedent read is `today.ts:843-940`: fill loop bounded by
  `TRIAGE_MAX_PAGES`, break on rows KEPT (`collected.length >=
  GROUP_FETCH_LIMIT`), hard cap on the RESULT via `slice` (`today.ts:894`), and
  a truncation WARN (`today.ts:884-889`). It uses `excludeOrigin` - which this
  design must NOT copy (spec section 3 class a).
- `collectUnreadRows` (`app/src/lib/unreadFeed.ts:478`) takes
  `{ conversations: Pick<ConversationsRepo,'queryUnreadPage'>, contacts:
  Pick<ContactsRepo,'findByPhone'|'findByEmail'>, messages:
  Pick<MessagesRepo,'listByConversation'>, logger? }` and
  `{ maxRows, budget, startAfter?, excludeContactIds?, wastedProbesBefore? }`,
  returning `CollectResult` with `candidates` (a DELETED contact appears only
  after its resurfacing probe passes), `truncated`, `remainingBudget`,
  `deletedProbes`, `wastedProbes`, `skippedDeletedThreads`. `BADGE_COUNT_CAP`
  is 100, `UNREAD_WALK_LIMIT` is 2000.
- `InboxPage.truncated` (`inbox.ts:147-152`) is documented as set on the
  `filter=unread` branch ONLY. The dashboard failure banner is gated by
  `serverEndedEarlyEmpty = inbox.serverRowCount === 0 && inbox.truncated`
  (`dashboard/src/routes/inbox/Inbox.tsx:42`, used at `:183`); the per-filter
  empty state renders at `Inbox.tsx:199` when rows are empty and that gate is
  false. So the unknown branch must NEVER set `truncated`, or a cleared triage
  queue renders as "We couldn't load your inbox".
- `messagesRepo.listByConversation(conversationId, { limit })` returns an ARRAY
  of `MessageItem` (see `inbox.ts:690` - `page[0]`), never `{ items }`.
- Exhaustiveness pattern: `satisfies Record<Union, true>` (`inbox.ts:439-448`).
  `ContactType = 'tenant' | 'landlord' | 'partner' | 'team_member' | 'unknown'`
  (`contactsRepo.ts:51`).
- Test fakes that lack `listByType` and DO exercise `filter=unknown` via
  `aggregateInbox`: `app/test/inboxFeed.test.ts` (makeDeps `contactsRepo` at
  190-210) and `app/test/inboxGroups.test.ts` (contactsRepo at 101-109). The
  route suite `app/test/inboxApi.test.ts` uses the webhook-harness world whose
  contactsRepo implements the FULL interface including `listByType` - only its
  EXPECTATIONS change. `app/test/inboxDiagnostics.test.ts` never calls
  `aggregateInbox` (it tests `lib/inboxDiagnostics.ts` helpers) - no change.
  `app/test/inboxUnreadParity.test.ts` only runs `filter: 'unread'` - no change.
- Tests that pin behavior this change REMOVES (each updated deliberately in
  Task 5/6, never left red): `inboxFeed.test.ts:591-613` (contactless number on
  the unknown tab), `inboxFeed.test.ts:736-766` (unknown filter runs the pager,
  `findByPhone: 1`), `inboxApi.test.ts:199-218` (contactless number is the
  unknown tab's one row), `inbox.integration.test.ts:323-330` (same, against
  real DynamoDB).
- `app/src/lib/seed/performance.ts` seeds ~1 CONTACT-BACKED unknown per 100
  contacts (`resolvedContactTypeCounts`, `buildContact` - status alternates
  needs_review/active) and wires `partner_1to1`/`unknown_1to1` conversations to
  those contacts (`oneToOneReference:797-800`), so
  `performanceSeed.integration.test.ts:414` (`unknown.rows.length > 0`) is
  expected to SURVIVE the flip. Task 6 verifies by running it; if it goes red,
  that is a real coverage regression to diagnose, not a test to relax.
- `useInbox` passes `pageData.truncated` through for every filter
  (`useInbox.ts:242,348`), so Task 9's `filter=all` truncation needs no
  dashboard change.

---

### Task 1: DynamoDB-faithful `listByType` test fake (shared helper)

**Files:**
- Create: `app/test/helpers/contactsPartitionFake.ts`
- Test: `app/test/contactsPartitionFake.test.ts`

**Interfaces:**
- Consumes: `ContactItem`, `ContactsPage`, `ListContactsOpts`, `isDeleted` from
  `app/src/repos/contactsRepo.ts` (existing).
- Produces: `listByTypeFromContacts(contacts: readonly ContactItem[], type:
  string, opts?: ListContactsOpts): ContactsPage` - used by Tasks 2, 3, 4, 5.

Why this exists: the mutation probes in later tasks are only real if the fake
honors the options under test. A fake that ignores `status` or `excludeOrigin`
makes the "do not narrow" probes vacuous, and a fake that applies the deleted
filter BEFORE `Limit` (as the webhook harness's does) can never produce the
short-page-with-LEK shape the fill loop exists for.

- [ ] **Step 1: Write the helper**

```ts
// app/test/helpers/contactsPartitionFake.ts
//
// Models contactsRepo.listByType the way DynamoDB executes it:
//   1. The partition is (type, optional status) - both are KEY conditions,
//      applied before paging.
//   2. `Limit` slices the page NEXT, from exclusiveStartKey.
//   3. The FilterExpressions - the soft-delete scope and `excludeOrigin` -
//      apply to the PAGE, so a filtered-out row still spends its page slot and
//      a short (even EMPTY) page can carry a lastEvaluatedKey.
// A fake that filters before slicing can never exercise the fill loop the
// unknown-queue read carries (docs/superpowers/specs/
// 2026-08-25-inbox-unknown-tab-walk-design.md, section 3 class d), and a fake
// that ignores `status`/`excludeOrigin` makes the "no narrowing" mutation
// probes vacuous. The webhook harness's own fake keeps its historical
// deleted-before-limit shape for the suites that depend on it; new tests use
// this one.
import {
  isDeleted,
  type ContactItem,
  type ContactsPage,
  type ListContactsOpts,
} from '../../src/repos/contactsRepo.js';

export function listByTypeFromContacts(
  contacts: readonly ContactItem[],
  type: string,
  opts: ListContactsOpts = {},
): ContactsPage {
  const partition = contacts
    // Pointer items carry no real type/status -> invisible to this GSI.
    .filter((c) => c.phone_ref !== true && c.email_ref !== true)
    .filter((c) => c.type === type)
    .filter((c) => (opts.status === undefined ? true : c.status === opts.status));
  const start =
    typeof opts.exclusiveStartKey?.['contactId'] === 'string'
      ? partition.findIndex((c) => c.contactId === opts.exclusiveStartKey?.['contactId']) + 1
      : 0;
  const limit = opts.limit ?? 50;
  const page = partition.slice(start, start + limit);
  const filtered = page
    .filter((c) => (opts.deleted === true ? isDeleted(c) : !isDeleted(c)))
    .filter((c) => opts.excludeOrigin === undefined || c.origin !== opts.excludeOrigin);
  const last = page[page.length - 1];
  const more = start + page.length < partition.length;
  return {
    items: filtered,
    ...(more && last !== undefined && { lastEvaluatedKey: { contactId: last.contactId } }),
  };
}
```

- [ ] **Step 2: Write the failing test**

```ts
// app/test/contactsPartitionFake.test.ts
// Pins the DynamoDB execution-order semantics of the shared listByType fake.
// If these drift, every mutation probe built on the fake goes vacuous - which
// is why the fake has its own suite.
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { listByTypeFromContacts } from './helpers/contactsPartitionFake.js';

function c(over: Partial<ContactItem> & { contactId: string }): ContactItem {
  return { type: 'unknown', status: 'needs_review', ...over };
}

describe('listByTypeFromContacts', () => {
  it('applies Limit BEFORE the deleted filter: a page of deleted rows is empty WITH a lastEvaluatedKey', () => {
    const seed = [
      c({ contactId: 'd1', deleted_at: '2026-08-01T00:00:00.000Z' }),
      c({ contactId: 'd2', deleted_at: '2026-08-01T00:00:00.000Z' }),
      c({ contactId: 'live' }),
    ];
    const page1 = listByTypeFromContacts(seed, 'unknown', { limit: 2 });
    expect(page1.items).toEqual([]);
    expect(page1.lastEvaluatedKey).toEqual({ contactId: 'd2' });
    const page2 = listByTypeFromContacts(seed, 'unknown', {
      limit: 2,
      exclusiveStartKey: page1.lastEvaluatedKey!,
    });
    expect(page2.items.map((x) => x.contactId)).toEqual(['live']);
    expect(page2.lastEvaluatedKey).toBeUndefined();
  });

  it('status narrows the PARTITION (key condition), before paging', () => {
    const seed = [
      c({ contactId: 'nr' }),
      c({ contactId: 'act', status: 'active' }),
    ];
    const page = listByTypeFromContacts(seed, 'unknown', { status: 'needs_review', limit: 10 });
    expect(page.items.map((x) => x.contactId)).toEqual(['nr']);
  });

  it('excludeOrigin filters the PAGE (spends slots), like the real FilterExpression', () => {
    const seed = [
      c({ contactId: 's1', origin: 'group_detection' }),
      c({ contactId: 's2', origin: 'group_detection' }),
      c({ contactId: 'real' }),
    ];
    const page1 = listByTypeFromContacts(seed, 'unknown', {
      limit: 2,
      excludeOrigin: 'group_detection',
    });
    expect(page1.items).toEqual([]);
    expect(page1.lastEvaluatedKey).toEqual({ contactId: 's2' });
  });

  it('deleted: true returns ONLY soft-deleted rows; the default returns only live ones', () => {
    const seed = [c({ contactId: 'live' }), c({ contactId: 'gone', deleted_at: '2026-08-01T00:00:00.000Z' })];
    expect(listByTypeFromContacts(seed, 'unknown', { deleted: true }).items.map((x) => x.contactId)).toEqual(['gone']);
    expect(listByTypeFromContacts(seed, 'unknown', {}).items.map((x) => x.contactId)).toEqual(['live']);
  });

  it('pointer items and other types are invisible to the partition', () => {
    const seed = [
      c({ contactId: 'ptr', phone_ref: true }),
      c({ contactId: 'ten', type: 'tenant' }),
      c({ contactId: 'unk' }),
    ];
    expect(listByTypeFromContacts(seed, 'unknown', {}).items.map((x) => x.contactId)).toEqual(['unk']);
  });
});
```

- [ ] **Step 3: Run the test, see it pass** (the helper is written first here
  because the suite pins an already-written pure function; there is no
  meaningful red state for a new pure helper plus its pins)

Run: `cd W:\tmp\inbox-unread-cluster\app; npx vitest run test/contactsPartitionFake.test.ts`
Expected: 5 passed.

- [ ] **Step 4: Commit**

```
git add app/test/helpers/contactsPartitionFake.ts app/test/contactsPartitionFake.test.ts
git commit -m "test(inbox): DynamoDB-faithful listByType fake for the unknown-queue work"
```

---

### Task 2: Teach the two aggregator fakes `listByType` (inert today)

**Files:**
- Modify: `app/test/inboxFeed.test.ts` (makeDeps `contactsRepo` block at ~190-210; `InboxCallCounts` at ~63-79)
- Modify: `app/test/inboxGroups.test.ts` (contactsRepo block at ~101-109)

**Interfaces:**
- Consumes: `listByTypeFromContacts` from Task 1.
- Produces: both suites' fakes answer `listByType` (Task 5's flip would
  otherwise TypeError every `filter: 'unknown'` test in them); inboxFeed's
  `InboxCallCounts` gains `listByType: number` and `listByLastActivity: number`
  for Task 5's cost pins.

Both changes are INERT under the current code (nothing calls `listByType` from
`aggregateInbox` yet) - the suites must stay green untouched otherwise. This is
the same trick `inboxUnreadParity.test.ts` used with `unread_flag`: the fixture
grows the capability BEFORE the code needs it, so the flip commit changes
expectations only.

- [ ] **Step 1: inboxFeed.test.ts - extend the counters**

In `InboxCallCounts` (~line 63) add two fields, and in `emptyCallCounts()` add
their zeros:

```ts
interface InboxCallCounts {
  queryUnreadPage: number;
  findByPhone: number;
  findByParticipantPhone: number;
  listByConversation: number;
  getPlacementById: number;
  listByType: number;
  listByLastActivity: number;
}

function emptyCallCounts(): InboxCallCounts {
  return {
    queryUnreadPage: 0,
    findByPhone: 0,
    findByParticipantPhone: 0,
    listByConversation: 0,
    getPlacementById: 0,
    listByType: 0,
    listByLastActivity: 0,
  };
}
```

- [ ] **Step 2: inboxFeed.test.ts - count listByLastActivity and add listByType**

Add the import at the top of the file (alongside the other helper imports):

```ts
import { listByTypeFromContacts } from './helpers/contactsPartitionFake.js';
```

In the `conversationsRepo` fake's `listByLastActivity` (~line 131), first line
of the function body:

```ts
        if (calls !== undefined) calls.listByLastActivity += 1;
```

In the `contactsRepo` fake (~line 190-210), add after `getById`:

```ts
      // Inert until the unknown tab's contact-side read lands (2026-08-25
      // design): aggregateInbox does not call this yet. Real DynamoDB
      // semantics via the shared helper so the later mutation probes
      // (status narrowing, excludeOrigin) can actually go red.
      async listByType(type: string, opts = {}) {
        if (calls !== undefined) calls.listByType += 1;
        return listByTypeFromContacts(seed.contacts, type, opts);
      },
```

- [ ] **Step 3: fix the two whole-object call assertions**

`expect(calls).toEqual({...})` at ~lines 727-733 and ~759-765 and ~800-807 are
EXHAUSTIVE literals - they now need the two new zero fields. Add
`listByType: 0, listByLastActivity: <n>` to each, where `<n>` is what the run
in Step 5 reports (the unread-filter tests never touch the pager, so expect 0
there; the `filter: 'unknown'` test at ~736 walks the pager once today, so
expect 1 there). Do not guess: run, read, pin.

- [ ] **Step 4: inboxGroups.test.ts - add listByType**

Add the import:

```ts
import { listByTypeFromContacts } from './helpers/contactsPartitionFake.js';
```

In the `contactsRepo` fake (~line 101), add after `getById` (the GroupSeed
contacts carry no `type` field, so the unknown partition is empty here - which
is exactly what the `filter=unknown` test at line 357 wants after the flip):

```ts
      async listByType(type: string, opts = {}) {
        return listByTypeFromContacts((seed.contacts ?? []) as never, type, opts);
      },
```

(The `as never` cast is acceptable inside this fake's existing
`as unknown as NonNullable<...>` envelope; the GroupSeed contact shape lacks
`type`, so the helper filters everything out.)

- [ ] **Step 5: Run both suites, green**

Run: `cd W:\tmp\inbox-unread-cluster\app; npx vitest run test/inboxFeed.test.ts test/inboxGroups.test.ts`
Expected: all pass. If a whole-object call assertion fails, transcribe the
actual counts into Step 3's literals (they are pins, not aspirations).

- [ ] **Step 6: Commit**

```
git add app/test/inboxFeed.test.ts app/test/inboxGroups.test.ts
git commit -m "test(inbox): fakes learn listByType (inert) ahead of the unknown-tab flip"
```

---

### Task 3: Parity baseline for the Unknown tab (pin the OLD behavior first)

**Files:**
- Create: `app/test/inboxUnknownParity.test.ts`

**Interfaces:**
- Consumes: `aggregateInbox`, `InboxRouterDeps` from `app/src/routes/inbox.ts`;
  `listByTypeFromContacts` (Task 1); `queryUnreadPageFromItems`,
  `unreadFlagFor` from `app/test/helpers/unreadIndexFake.js` (existing).
- Produces: the class-by-class row pins Task 5 amends AT the flip. This is the
  spec's "single most valuable test" (section 6): every failure mode in section
  3 is a row that quietly stops appearing.

This file is committed GREEN against the CURRENT pager-based unknown tab,
BEFORE `inbox.ts` is touched - a builder halfway through the rewrite cannot run
"the old code" anymore, so the pin has to exist first
(`inboxUnreadParity.test.ts` is the precedent). Rows whose fate the spec
CHANGES are marked in comments with the class letter and what the flip commit
must do to the pin.

- [ ] **Step 1: Write the file**

```ts
// app/test/inboxUnknownParity.test.ts
//
// PARITY BASELINE for the filter=unknown contact-side rewrite (design
// 2026-08-25). Captured against the PRE-REWRITE aggregateInbox (the open-
// partition pager) and committed on its own, before inbox.ts is touched.
//
// Section 3 of the design enumerates the coverage classes; each world below is
// one class. Pins marked "FLIP:" change AT the flip commit, deliberately, with
// the class letter; every other pin must survive byte-identical.
//
// The fixture fakes carry listByType (via the shared DynamoDB-faithful helper)
// and a tuple-ordered byUnread index NOW, while both are inert - so the flip
// commit changes EXPECTATIONS only, never fixtures (the unread parity file's
// unread_flag trick).
import { describe, expect, it } from 'vitest';
import { aggregateInbox, type InboxRouterDeps } from '../src/routes/inbox.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { MessageItem } from '../src/repos/messagesRepo.js';
import { listByTypeFromContacts } from './helpers/contactsPartitionFake.js';
import { queryUnreadPageFromItems, unreadFlagFor } from './helpers/unreadIndexFake.js';

interface World {
  contacts: ContactItem[];
  conversations: ConversationItem[];
  latestMessage?: Record<string, Partial<MessageItem>>;
}

function conv(
  over: Partial<ConversationItem> & { conversationId: string; last_activity_at: string },
): ConversationItem {
  return {
    status: 'open',
    type: 'unknown_1to1',
    ai_mode: 'auto',
    created_at: '2026-06-01T00:00:00.000Z',
    ...unreadFlagFor(over),
    ...over,
  };
}

function makeDeps(world: World): InboxRouterDeps {
  return {
    conversationsRepo: {
      async getById(id: string) {
        return world.conversations.find((c) => c.conversationId === id);
      },
      async queryUnreadPage(opts: { limit: number; exclusiveStartKey?: Record<string, unknown> }) {
        return queryUnreadPageFromItems(world.conversations, opts);
      },
      async listByLastActivity({ limit }: { status: string; limit?: number }) {
        const open = world.conversations
          .filter((c) => c.status === 'open')
          .sort((a, b) => (a.last_activity_at < b.last_activity_at ? 1 : -1));
        return { items: open.slice(0, limit ?? 50) };
      },
      async findByParticipantPhone(phone: string) {
        return world.conversations.filter((c) => c.participant_phone === phone);
      },
      async findByParticipantEmail(email: string) {
        return world.conversations.filter((c) => c.participant_email === email);
      },
      async listRelayGroups(status: string) {
        return {
          items: world.conversations.filter((c) => c.type === 'relay_group' && c.status === status),
          truncated: false,
        };
      },
      async listGroupTexts() {
        return { items: [], truncated: false };
      },
    } as unknown as NonNullable<InboxRouterDeps['conversationsRepo']>,
    contactsRepo: {
      async findByPhone(phone: string) {
        return world.contacts.find((c) => c.phone === phone);
      },
      async findByEmail(email: string) {
        return world.contacts.find((c) => c.email === email);
      },
      async getById(contactId: string) {
        return world.contacts.find((c) => c.contactId === contactId);
      },
      async listByType(type: string, opts = {}) {
        return listByTypeFromContacts(world.contacts, type, opts);
      },
    } as unknown as NonNullable<InboxRouterDeps['contactsRepo']>,
    messagesRepo: {
      async listByConversation(conversationId: string) {
        const latest = world.latestMessage?.[conversationId];
        return latest ? [latest as MessageItem] : [];
      },
    } as unknown as NonNullable<InboxRouterDeps['messagesRepo']>,
    placementsRepo: {
      async getById() {
        return undefined;
      },
    } as unknown as NonNullable<InboxRouterDeps['placementsRepo']>,
  };
}

describe('filter=unknown parity, class by class (design section 3)', () => {
  it('a type=unknown CONTACT with an open thread is a triage row (the core case - must survive the flip)', async () => {
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps({
      contacts: [{ contactId: 'c-unk', type: 'unknown', status: 'needs_review', phone: '+15550001001' }],
      conversations: [conv({ conversationId: 'cv-unk', participant_phone: '+15550001001', last_activity_at: '2026-06-12T10:00:00.000Z', unread_count: 1 })],
    }));
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      kind: 'contact',
      contactId: 'c-unk',
      role: 'unknown',
      needsTriage: true,
      phone: '+15550001001',
      unreadCount: 1,
      lastActivityAt: '2026-06-12T10:00:00.000Z',
    });
  });

  it('class f: a (type=unknown, status=active) contact is a triage row (must survive the flip)', async () => {
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps({
      contacts: [{ contactId: 'c-active', type: 'unknown', status: 'active', phone: '+15550001002' }],
      conversations: [conv({ conversationId: 'cv-active', participant_phone: '+15550001002', last_activity_at: '2026-06-12T09:00:00.000Z' })],
    }));
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-active']);
  });

  it('class a: a group-detection stub who later TEXTED is a triage row (must survive the flip - excludeOrigin must NOT be copied)', async () => {
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps({
      contacts: [{ contactId: 'c-stub', type: 'unknown', status: 'needs_review', origin: 'group_detection', phone: '+15550001003' }],
      conversations: [conv({ conversationId: 'cv-stub', participant_phone: '+15550001003', last_activity_at: '2026-06-12T08:00:00.000Z', unread_count: 2 })],
    }));
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-stub']);
  });

  it('class d: a soft-deleted unknown with an unread post-deletion inbound resurfaces, deleted:true (must survive the flip)', async () => {
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps({
      contacts: [{
        contactId: 'c-del',
        type: 'unknown',
        status: 'needs_review',
        phone: '+15550001004',
        deleted_at: '2026-06-10T00:00:00.000Z',
      }],
      conversations: [conv({ conversationId: 'cv-del', participant_phone: '+15550001004', last_activity_at: '2026-06-12T07:00:00.000Z', unread_count: 1 })],
      latestMessage: {
        'cv-del': { type: 'sms', direction: 'inbound', body: 'hello?', created_at: '2026-06-12T07:00:00.000Z' },
      },
    }));
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ contactId: 'c-del', deleted: true, needsTriage: true });
  });

  it('class e: a CONTACTLESS unknown number is a triage row today. FLIP: it leaves the queue (stays on All) - amend this pin at the flip commit', async () => {
    const world: World = {
      contacts: [],
      conversations: [conv({ conversationId: 'cv-noc', participant_phone: '+14049824978', last_activity_at: '2026-06-12T06:00:00.000Z', unread_count: 1 })],
    };
    const unknown = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps(world));
    expect(unknown.rows.map((r) => r.phone)).toEqual(['+14049824978']); // FLIP: becomes []
    const all = await aggregateInbox({ filter: 'all', limit: 25 }, makeDeps(world));
    expect(all.rows.map((r) => r.phone)).toEqual(['+14049824978']); // the mitigation - must survive
  });

  it('class c: a team_member with an open thread is a triage row today (the LATENT BUG). FLIP: absent, per the 2026-08-25 ruling - amend this pin at the flip commit', async () => {
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps({
      contacts: [{ contactId: 'c-team', type: 'team_member', status: 'active', phone: '+15550001005' }],
      conversations: [conv({ conversationId: 'cv-team', participant_phone: '+15550001005', last_activity_at: '2026-06-12T05:00:00.000Z', type: 'tenant_1to1' })],
    }));
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-team']); // FLIP: becomes []
  });

  it('a resolved tenant/landlord/partner is never a triage row (must survive the flip)', async () => {
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps({
      contacts: [
        { contactId: 'c-t', type: 'tenant', phone: '+15550001006' },
        { contactId: 'c-p', type: 'partner', phone: '+15550001007' },
      ],
      conversations: [
        conv({ conversationId: 'cv-t', participant_phone: '+15550001006', last_activity_at: '2026-06-12T04:00:00.000Z', type: 'tenant_1to1' }),
        conv({ conversationId: 'cv-p', participant_phone: '+15550001007', last_activity_at: '2026-06-12T03:00:00.000Z', type: 'partner_1to1' }),
      ],
    }));
    expect(page.rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, see it pass against the CURRENT code**

Run: `cd W:\tmp\inbox-unread-cluster\app; npx vitest run test/inboxUnknownParity.test.ts`
Expected: 7 passed. If the class (d) test fails, check the fixture's
`latestMessage.created_at` is AFTER `deleted_at` and the conversation carries
`unread_count > 0` - the resurfacing predicate needs both.

- [ ] **Step 3: Commit**

```
git add app/test/inboxUnknownParity.test.ts
git commit -m "test(inbox): parity baseline for the unknown tab, class by class, pre-flip"
```

---

### Task 4: The queue collector - `app/src/lib/unknownQueue.ts`

**Files:**
- Create: `app/src/lib/unknownQueue.ts`
- Test: `app/test/unknownQueue.test.ts`

**Interfaces:**
- Consumes: `ContactsRepo`, `ContactItem`, `ContactType` from
  `app/src/repos/contactsRepo.ts`; `Logger`, `logger as defaultLogger` from
  `app/src/lib/logger.ts`; `listByTypeFromContacts` (Task 1, tests only).
- Produces (Task 5 imports all of these):
  - `UNKNOWN_QUEUE_PAGE_SIZE = 100`, `UNKNOWN_QUEUE_MAX_PAGES = 10`,
    `UNKNOWN_QUEUE_MAX_ROWS = 200`
  - `UNKNOWN_TAB_TYPE_DECISIONS: Record<ContactType, 'queried' | 'excluded'>`
  - `collectUnknownTriageQueue(deps: { contacts: Pick<ContactsRepo,
    'listByType'>; logger?: Logger }, opts: { pageSize: number; maxPages:
    number; maxRows: number }): Promise<UnknownQueueResult>` where
    `UnknownQueueResult = { contacts: ContactItem[]; pagesWalked: number;
    truncated: boolean }`

- [ ] **Step 1: Write the failing tests**

```ts
// app/test/unknownQueue.test.ts
// The triage-partition collector: fill loop, result cap, truncation WARN, and
// the two protections the design REMOVES (status narrowing, excludeOrigin) as
// mutation probes that can actually go red - the fake honors both options.
import { describe, expect, it, vi } from 'vitest';
import {
  collectUnknownTriageQueue,
  UNKNOWN_QUEUE_MAX_PAGES,
  UNKNOWN_QUEUE_MAX_ROWS,
  UNKNOWN_QUEUE_PAGE_SIZE,
  UNKNOWN_TAB_TYPE_DECISIONS,
} from '../src/lib/unknownQueue.js';
import type { ContactItem, ContactType, ListContactsOpts } from '../src/repos/contactsRepo.js';
import { listByTypeFromContacts } from './helpers/contactsPartitionFake.js';

function unk(n: number, over: Partial<ContactItem> = {}): ContactItem {
  return {
    contactId: `c-unk-${String(n).padStart(3, '0')}`,
    type: 'unknown',
    status: 'needs_review',
    phone: `+1555${String(1_000_000 + n).padStart(7, '0')}`,
    ...over,
  };
}

function makeDeps(seed: ContactItem[]) {
  const calls: ListContactsOpts[] = [];
  const warn = vi.fn();
  const deps = {
    contacts: {
      async listByType(type: ContactType, opts: ListContactsOpts = {}) {
        calls.push(opts);
        return listByTypeFromContacts(seed, type, opts);
      },
    },
    logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
  };
  return { deps, calls, warn };
}

const WIDE = { pageSize: 100, maxPages: 10, maxRows: 200 };

describe('collectUnknownTriageQueue', () => {
  it('one Query when the partition fits a page - and it narrows on NOTHING (no status, no excludeOrigin, no deleted:true)', async () => {
    const { deps, calls, warn } = makeDeps([
      unk(1),
      unk(2, { status: 'active' }), // class f: the DEFAULT for a created unknown
      unk(3, { origin: 'group_detection' }), // class a: a stub who may have texted
      { contactId: 'c-ten', type: 'tenant', phone: '+15550009000' },
    ]);
    const result = await collectUnknownTriageQueue(deps, WIDE);
    expect(result.contacts.map((c) => c.contactId)).toEqual(['c-unk-001', 'c-unk-002', 'c-unk-003']);
    expect(result).toMatchObject({ pagesWalked: 1, truncated: false });
    expect(calls).toHaveLength(1);
    // THE PROBES. The fake honors these options, so re-adding either narrow
    // (spec section 3, classes a and f) empties the row set above AND flips
    // these two pins.
    expect(calls[0]!.status).toBeUndefined();
    expect(calls[0]!.excludeOrigin).toBeUndefined();
    expect(calls[0]!.deleted).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('fills PAST pages of soft-deleted residue: the loop breaks on rows KEPT, never rows read', async () => {
    // The deleted filter is a FilterExpression, applied after Limit - so pages
    // 1 and 2 come back EMPTY with a lastEvaluatedKey. Breaking on rows read
    // (or on an empty page) returns [] here, which is the today.ts:855-899
    // failure this loop exists to prevent: a short block that reads as
    // "nothing needs triage".
    const { deps } = makeDeps([
      unk(1, { deleted_at: '2026-08-01T00:00:00.000Z' }),
      unk(2, { deleted_at: '2026-08-01T00:00:00.000Z' }),
      unk(3, { deleted_at: '2026-08-01T00:00:00.000Z' }),
      unk(4, { deleted_at: '2026-08-01T00:00:00.000Z' }),
      unk(5),
      unk(6),
    ]);
    const result = await collectUnknownTriageQueue(deps, { pageSize: 2, maxPages: 5, maxRows: 10 });
    expect(result.contacts.map((c) => c.contactId)).toEqual(['c-unk-005', 'c-unk-006']);
    expect(result.truncated).toBe(false);
    expect(result.pagesWalked).toBe(3);
  });

  it('the page budget bounds a partition made entirely of residue - truncated + the WARN', async () => {
    const seed = Array.from({ length: 10 }, (_, i) => unk(i + 1, { deleted_at: '2026-08-01T00:00:00.000Z' }));
    seed.push(unk(99)); // one live contact, unreachable behind the wall
    const { deps, warn } = makeDeps(seed);
    const result = await collectUnknownTriageQueue(deps, { pageSize: 2, maxPages: 3, maxRows: 10 });
    expect(result.contacts).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.pagesWalked).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ pages: 3, kept: 0 });
  });

  it('hard-caps the RESULT, not just the read: the loop breaks on >=, so the last page can overshoot', async () => {
    const seed = Array.from({ length: 7 }, (_, i) => unk(i + 1));
    const { deps, warn } = makeDeps(seed);
    const result = await collectUnknownTriageQueue(deps, { pageSize: 3, maxPages: 10, maxRows: 4 });
    expect(result.contacts).toHaveLength(4); // not 6 - the slice is the cap
    expect(result.truncated).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a partition read that drains exactly at the cap is NOT truncated (no false WARN)', async () => {
    const seed = Array.from({ length: 4 }, (_, i) => unk(i + 1));
    const { deps, warn } = makeDeps(seed);
    const result = await collectUnknownTriageQueue(deps, { pageSize: 4, maxPages: 10, maxRows: 4 });
    expect(result.contacts).toHaveLength(4);
    expect(result.truncated).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('production constants are named and sane', () => {
    expect(UNKNOWN_QUEUE_PAGE_SIZE).toBe(100);
    expect(UNKNOWN_QUEUE_MAX_PAGES).toBe(10);
    expect(UNKNOWN_QUEUE_MAX_ROWS).toBe(200);
  });

  it('class g: every ContactType has a recorded tab decision, and only unknown is queried', () => {
    // The compile-time `satisfies Record<ContactType, ...>` on the map is the
    // real guard: adding a ContactType member without deciding its tab fate is
    // a typecheck failure, not a quietly narrowed queue.
    const queried = (Object.entries(UNKNOWN_TAB_TYPE_DECISIONS) as [ContactType, string][])
      .filter(([, decision]) => decision === 'queried')
      .map(([type]) => type);
    expect(queried).toEqual(['unknown']);
  });
});
```

- [ ] **Step 2: Run, see it fail**

Run: `cd W:\tmp\inbox-unread-cluster\app; npx vitest run test/unknownQueue.test.ts`
Expected: FAIL - `Cannot find module '../src/lib/unknownQueue.js'`.

- [ ] **Step 3: Write the module**

```ts
// app/src/lib/unknownQueue.ts
//
// The Unknown inbox tab's triage-partition read (design 2026-08-25,
// docs/superpowers/specs/2026-08-25-inbox-unknown-tab-walk-design.md).
//
// One bounded walk of the (type='unknown') byTypeStatus partition. The
// protections are copied from the today.ts:843-940 precedent WITH THEIR
// REASONS, keeping only the reasons that still hold (spec section 2):
//
//   KEPT - the fill loop: the repo's soft-delete scope is a FilterExpression,
//   applied AFTER `Limit`, and soft-deleted unknowns accumulate in this
//   partition FOREVER (softDelete touches neither type nor status; spam and
//   wrong numbers are exactly what an operator deletes from a triage queue).
//   So a page thick with residue returns short - even EMPTY - pages WITH a
//   lastEvaluatedKey, and a reader without the loop renders "nothing needs
//   triage" over a queue that has rows. The loop breaks on rows KEPT, never
//   rows read.
//
//   KEPT - the hard cap on the RESULT: the loop breaks on >=, so the last
//   page can overshoot; the slice is what actually bounds the response.
//
//   KEPT - the truncation WARN: a walk that ends with rows still behind it
//   must never end silently (the precedent's "loud problem turned silent").
//
//   NOT COPIED - `status: 'needs_review'`: a contact CREATED as unknown
//   defaults to status 'active' (routes/contacts.ts:881-884), so
//   (unknown, active) is the DEFAULT, not an edge case - class f. The type
//   alone is the queue: triage retypes the contact out of the partition.
//
//   NOT COPIED - `excludeOrigin: GROUP_DETECTION_ORIGIN`: today.ts can afford
//   that exclusion ONLY because it is a two-source union ("a real unknown
//   caller who TEXTED still surfaces through the conversation-row source").
//   This reader has no second source; a detection-minted stub keeps its origin
//   forever, so a roster member who later texts in would be silently dropped -
//   class a. And the exclusion buys nothing here: a threadless stub yields no
//   open thread and therefore no row anyway.
import { logger as defaultLogger, type Logger } from './logger.js';
import type { ContactItem, ContactsRepo, ContactType } from '../repos/contactsRepo.js';

/** Rows fetched per partition Query while filling the queue. */
export const UNKNOWN_QUEUE_PAGE_SIZE = 100;

/**
 * Sequential Queries ONE request may spend walking past soft-deleted residue.
 * The same bound shape as today.ts's TRIAGE_MAX_PAGES (10): up to
 * maxPages * pageSize rows read to keep a partition of residue from spinning.
 */
export const UNKNOWN_QUEUE_MAX_PAGES = 10;

/**
 * Hard cap on the queue RESULT. 200 = 2x the route's MAX_INBOX_LIMIT, and far
 * above the measured partitions (16 dev / 7 prod, 2026-08-25) - it exists so
 * the in-memory sort and per-row hydration stay bounded when the partition
 * grows, not because anyone expects to hit it soon.
 */
export const UNKNOWN_QUEUE_MAX_ROWS = 200;

/**
 * Class g (spec section 3): `roleFromContact` is a FALL-THROUGH (anything not
 * tenant/landlord/partner renders as 'unknown') while `listByType('unknown')`
 * is an EXACT MATCH - the two predicates agree only on the types that exist
 * today. This map forces the decision: adding a ContactType member without an
 * entry here is a TYPECHECK failure, so a new type can never silently be
 * "on the tab but absent from the query".
 *
 * team_member is 'excluded' BY RULING (2026-08-25, spec section 7): it is the
 * internal-staff bucket and does not belong in an outside-contact triage
 * queue. The old tab showed them (the fall-through); that was the bug.
 */
export const UNKNOWN_TAB_TYPE_DECISIONS = {
  tenant: 'excluded',
  landlord: 'excluded',
  partner: 'excluded',
  team_member: 'excluded',
  unknown: 'queried',
} as const satisfies Record<ContactType, 'queried' | 'excluded'>;

export interface UnknownQueueResult {
  /** At most `maxRows` live (non-deleted) unknown contacts, partition order -
   *  this index has NO activity dimension; the caller sorts after hydration. */
  contacts: ContactItem[];
  pagesWalked: number;
  /** Rows may remain behind this result: the page budget ran out with a
   *  lastEvaluatedKey still in hand, or the result cap cut the collection.
   *  Already WARNed here; the caller decides nothing else. */
  truncated: boolean;
}

export async function collectUnknownTriageQueue(
  deps: { contacts: Pick<ContactsRepo, 'listByType'>; logger?: Logger },
  opts: { pageSize: number; maxPages: number; maxRows: number },
): Promise<UnknownQueueResult> {
  const log = deps.logger ?? defaultLogger;
  const collected: ContactItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let pagesWalked = 0;
  let exhausted = false;
  for (let page = 0; page < opts.maxPages; page += 1) {
    pagesWalked = page + 1;
    const read = await deps.contacts.listByType('unknown', {
      limit: opts.pageSize,
      ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
    });
    collected.push(...read.items);
    exclusiveStartKey = read.lastEvaluatedKey;
    if (exclusiveStartKey === undefined) {
      exhausted = true;
      break;
    }
    // Break on rows KEPT, never rows read: a filtered (deleted) row spends a
    // page slot but must not spend the queue's budget-to-show.
    if (collected.length >= opts.maxRows) break;
  }
  const contacts = collected.slice(0, opts.maxRows);
  const truncated = !exhausted || contacts.length < collected.length;
  if (truncated) {
    // The precedent's WARN (today.ts:884-889): counts only, no PII.
    log.warn(
      { pages: pagesWalked, kept: contacts.length, collected: collected.length },
      'inbox: the unknown-queue walk ended with untriaged contacts still behind it - the triage queue shown is a floor',
    );
  }
  return { contacts, pagesWalked, truncated };
}
```

- [ ] **Step 4: Run, see it pass**

Run: `cd W:\tmp\inbox-unread-cluster\app; npx vitest run test/unknownQueue.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Typecheck** (the `satisfies` map and the Pick-typed deps are
  exactly what gate 1 checks and vitest's esbuild does not)

Run: `cd W:\tmp\inbox-unread-cluster; npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```
git add app/src/lib/unknownQueue.ts app/test/unknownQueue.test.ts
git commit -m "feat(inbox): bounded unknown-triage-queue collector with fill loop, cap, and WARN"
```

---

### Task 5: The flip - the `filter=unknown` branch in `aggregateInbox`

**Files:**
- Modify: `app/src/routes/inbox.ts` (imports; `InboxRouterDeps`; the cursor
  decode gate at ~576-579; a new branch after the `filter === 'unread'` branch
  ends at ~1454; the read-accounting comment at ~599-623)
- Create: `app/test/inboxUnknownTab.test.ts`
- Modify: `app/test/inboxUnknownParity.test.ts` (the two FLIP pins)
- Modify: `app/test/inboxFeed.test.ts` (tests at ~591-613 and ~736-766)
- Modify: `app/test/inboxApi.test.ts` (test at 199-218; one new cursor test)

This is one commit: the flip plus every expectation it changes, each named.
`app/test/inboxGroups.test.ts:357` needs NO edit - its assertions
(`calls.groupLimits === []`, `rows === []`) hold under the new branch, and its
fake gained `listByType` in Task 2. Run it anyway.

**Interfaces:**
- Consumes: `collectUnknownTriageQueue`, `UNKNOWN_QUEUE_PAGE_SIZE`,
  `UNKNOWN_QUEUE_MAX_PAGES`, `UNKNOWN_QUEUE_MAX_ROWS` from
  `app/src/lib/unknownQueue.js` (Task 4); existing in-file closures
  `buildContactRow`, `newestOf`, `unreadOf`, `dropped`, `drops`,
  `roleFromContact`; existing imports `conversationsForContact`,
  `collectUnreadRows`, `BADGE_COUNT_CAP`, `UNREAD_WALK_LIMIT`,
  `warnDeletedProbes`, `isDeleted`.
- Produces: the new wire behavior (single page, `nextCursor: null`, no
  `truncated` key, cursor -> 400) and three test seams on `InboxRouterDeps`:
  `unknownQueuePageSize?: number`, `unknownQueueMaxPages?: number`,
  `unknownQueueMaxRows?: number`. Task 6 and the e2e task rely on the wire
  behavior; Task 9 leaves this branch untouched.

- [ ] **Step 1: Write the failing behavior tests**

Create `app/test/inboxUnknownTab.test.ts`. Its `makeDeps` is self-contained
(do NOT import from another `.test.ts` - that re-registers the suite):

```ts
// app/test/inboxUnknownTab.test.ts
//
// The filter=unknown CONTACT-SIDE read (design 2026-08-25): behavior, coverage
// classes, failure discrimination, and the cost inversion. The parity file
// (inboxUnknownParity.test.ts) pins row CONTENT across the flip; this file
// pins the NEW mechanics - what is read, what is not, and what happens when a
// read fails.
import { describe, expect, it, vi } from 'vitest';
import {
  aggregateInbox,
  InboxBadRequestError,
  type InboxRouterDeps,
} from '../src/routes/inbox.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { MessageItem } from '../src/repos/messagesRepo.js';
import { listByTypeFromContacts } from './helpers/contactsPartitionFake.js';
import { queryUnreadPageFromItems, unreadFlagFor } from './helpers/unreadIndexFake.js';

interface Seed {
  contacts: ContactItem[];
  conversations: ConversationItem[];
  latestMessage?: Record<string, Partial<MessageItem>>;
  /** Make findByParticipantPhone THROW for exactly this phone (requirement 4). */
  threadLookupErrorPhone?: string;
  /** Override the listByType answer wholesale (the retype-race test). */
  listByTypeOverride?: (type: string) => { items: ContactItem[] };
}

interface Calls {
  listByType: number;
  listByLastActivity: number;
  listRelayGroups: number;
  listGroupTexts: number;
  queryUnreadPage: number;
  findByPhone: number;
  findByParticipantPhone: number;
}

function emptyCalls(): Calls {
  return {
    listByType: 0,
    listByLastActivity: 0,
    listRelayGroups: 0,
    listGroupTexts: 0,
    queryUnreadPage: 0,
    findByPhone: 0,
    findByParticipantPhone: 0,
  };
}

function conv(
  over: Partial<ConversationItem> & { conversationId: string; last_activity_at: string },
): ConversationItem {
  return {
    status: 'open',
    type: 'unknown_1to1',
    ai_mode: 'auto',
    created_at: '2026-06-01T00:00:00.000Z',
    ...unreadFlagFor(over),
    ...over,
  };
}

function makeDeps(
  seed: Seed,
  calls: Calls = emptyCalls(),
  logger?: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> },
  seams?: Pick<InboxRouterDeps, 'unknownQueueMaxRows' | 'unknownQueueMaxPages' | 'unknownQueuePageSize' | 'unreadWalkLimit'>,
): InboxRouterDeps {
  const log = logger ?? { info: vi.fn(), warn: vi.fn() };
  return {
    logger: { ...log, error: vi.fn(), debug: vi.fn() } as never,
    ...seams,
    conversationsRepo: {
      async getById(id: string) {
        return seed.conversations.find((c) => c.conversationId === id);
      },
      async queryUnreadPage(opts: { limit: number; exclusiveStartKey?: Record<string, unknown> }) {
        calls.queryUnreadPage += 1;
        return queryUnreadPageFromItems(seed.conversations, opts);
      },
      async listByLastActivity({ limit }: { status: string; limit?: number }) {
        calls.listByLastActivity += 1;
        const open = seed.conversations
          .filter((c) => c.status === 'open')
          .sort((a, b) => (a.last_activity_at < b.last_activity_at ? 1 : -1));
        return { items: open.slice(0, limit ?? 50) };
      },
      async findByParticipantPhone(phone: string) {
        calls.findByParticipantPhone += 1;
        if (seed.threadLookupErrorPhone === phone) throw new Error('participant GSI unavailable');
        return seed.conversations.filter((c) => c.participant_phone === phone);
      },
      async findByParticipantEmail(email: string) {
        return seed.conversations.filter((c) => c.participant_email === email);
      },
      async listRelayGroups(status: string) {
        calls.listRelayGroups += 1;
        return {
          items: seed.conversations.filter((c) => c.type === 'relay_group' && c.status === status),
          truncated: false,
        };
      },
      async listGroupTexts() {
        calls.listGroupTexts += 1;
        return { items: [], truncated: false };
      },
    } as unknown as NonNullable<InboxRouterDeps['conversationsRepo']>,
    contactsRepo: {
      async findByPhone(phone: string) {
        calls.findByPhone += 1;
        return seed.contacts.find((c) => c.phone === phone);
      },
      async findByEmail(email: string) {
        return seed.contacts.find((c) => c.email === email);
      },
      async getById(contactId: string) {
        return seed.contacts.find((c) => c.contactId === contactId);
      },
      async listByType(type: string, opts = {}) {
        calls.listByType += 1;
        if (seed.listByTypeOverride !== undefined) return seed.listByTypeOverride(type);
        return listByTypeFromContacts(seed.contacts, type, opts);
      },
    } as unknown as NonNullable<InboxRouterDeps['contactsRepo']>,
    messagesRepo: {
      async listByConversation(conversationId: string) {
        const latest = seed.latestMessage?.[conversationId];
        return latest ? [latest as MessageItem] : [];
      },
    } as unknown as NonNullable<InboxRouterDeps['messagesRepo']>,
    placementsRepo: {
      async getById() {
        return undefined;
      },
    } as unknown as NonNullable<InboxRouterDeps['placementsRepo']>,
  };
}

describe('filter=unknown - the contact-side read', () => {
  it('costs one partition Query, never the open-partition walk: 40 open threads, 1 unknown -> 1 listByType, 0 listByLastActivity, 0 findByPhone, 0 listRelayGroups', async () => {
    // THE STARVED FIXTURE (spec section 6): many open conversations, few
    // matches. Under the old pager this cost one findByPhone per conversation.
    // NOTHING here is unread ON PURPOSE: the resurfacing sweep resolves a
    // contact (findByPhone) for every VISIBLE unread index item, so an unread
    // fixture would make findByPhone count the sweep's O(unread) cost instead
    // of isolating the queue read. The sweep's own costs are pinned in the
    // class (d) tests below.
    const contacts: ContactItem[] = [{ contactId: 'c-unk', type: 'unknown', status: 'needs_review', phone: '+15550002000' }];
    const conversations: ConversationItem[] = [
      conv({ conversationId: 'cv-unk', participant_phone: '+15550002000', last_activity_at: '2026-06-12T12:00:00.000Z' }),
    ];
    for (let i = 0; i < 40; i += 1) {
      contacts.push({ contactId: `c-t-${i}`, type: 'tenant', phone: `+1555100${String(i).padStart(4, '0')}` });
      conversations.push(
        conv({
          conversationId: `cv-t-${i}`,
          type: 'tenant_1to1',
          participant_phone: `+1555100${String(i).padStart(4, '0')}`,
          last_activity_at: `2026-06-11T${String(10 + (i % 12)).padStart(2, '0')}:00:00.000Z`,
        }),
      );
    }
    const calls = emptyCalls();
    const page = await aggregateInbox({ filter: 'unknown', limit: 30 }, makeDeps({ contacts, conversations }, calls));
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-unk']);
    expect(calls.listByType).toBe(1);
    expect(calls.listByLastActivity).toBe(0); // the pager never runs
    expect(calls.findByPhone).toBe(0); // no per-conversation contact resolution
    expect(calls.queryUnreadPage).toBe(1); // the sweep: one Query on an empty index
    expect(calls.listRelayGroups).toBe(0); // nothing to filter away
    expect(calls.listGroupTexts).toBe(0);
  });

  it('returns a single page: nextCursor null and NO truncated key, even when the queue was cut', async () => {
    const contacts = Array.from({ length: 4 }, (_, i) => ({
      contactId: `c-u${i}`,
      type: 'unknown' as const,
      status: 'needs_review',
      phone: `+155500021${String(i).padStart(2, '0')}`,
    }));
    const conversations = contacts.map((c, i) =>
      conv({
        conversationId: `cv-u${i}`,
        participant_phone: c.phone!,
        last_activity_at: `2026-06-12T0${i}:00:00.000Z`,
      }),
    );
    const warn = vi.fn();
    const page = await aggregateInbox(
      { filter: 'unknown', limit: 30 },
      makeDeps({ contacts, conversations }, emptyCalls(), { info: vi.fn(), warn }, { unknownQueueMaxRows: 2 }),
    );
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
    // The wire flag belongs to the unread branch (InboxPage.truncated) - and
    // an empty page carrying it renders the dashboard FAILURE banner on a tab
    // whose normal state is an empty queue (requirement 5).
    expect('truncated' in page).toBe(false);
    expect('groupsTruncated' in page).toBe(false);
    // The collector's WARN is the truncation signal.
    expect(warn.mock.calls.some((c) => String(c[1]).includes('triage queue shown is a floor'))).toBe(true);
  });

  it('windows the sorted result to the request limit and WARNs about the rows it could not show', async () => {
    const contacts = Array.from({ length: 5 }, (_, i) => ({
      contactId: `c-w${i}`,
      type: 'unknown' as const,
      status: 'active',
      phone: `+155500022${String(i).padStart(2, '0')}`,
    }));
    const conversations = contacts.map((c, i) =>
      conv({
        conversationId: `cv-w${i}`,
        participant_phone: c.phone!,
        last_activity_at: `2026-06-12T0${i}:00:00.000Z`,
      }),
    );
    const warn = vi.fn();
    const page = await aggregateInbox(
      { filter: 'unknown', limit: 3 },
      makeDeps({ contacts, conversations }, emptyCalls(), { info: vi.fn(), warn }),
    );
    // Newest first, exactly `limit` rows.
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-w4', 'c-w3', 'c-w2']);
    expect(page.nextCursor).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[1]).includes('could not show every triage row'))).toBe(true);
  });

  it('rejects any cursor: the unknown feed mints none, so a cursor here is foreign (400 posture, not a wrong-partition Query)', async () => {
    const deps = makeDeps({ contacts: [], conversations: [] });
    const allCursor = Buffer.from(JSON.stringify({ idx: 0 }), 'utf8').toString('base64url');
    await expect(aggregateInbox({ filter: 'unknown', limit: 25, cursor: allCursor }, deps)).rejects.toBeInstanceOf(InboxBadRequestError);
    const unreadCursor = Buffer.from(
      JSON.stringify({ u: 1, a: '2026-06-12T10:00:00.000Z', c: 'cv-x', s: [] }),
      'utf8',
    ).toString('base64url');
    await expect(aggregateInbox({ filter: 'unknown', limit: 25, cursor: unreadCursor }, deps)).rejects.toBeInstanceOf(InboxBadRequestError);
  });

  it('requirement 4: a THROWN thread read withholds ONE row loudly - it neither 500s the tab nor impersonates an empty thread set', async () => {
    const seed: Seed = {
      contacts: [
        { contactId: 'c-ok', type: 'unknown', status: 'needs_review', phone: '+15550002300' },
        { contactId: 'c-broken', type: 'unknown', status: 'needs_review', phone: '+15550002301' },
        { contactId: 'c-empty', type: 'unknown', status: 'needs_review', phone: '+15550002302' }, // no threads at all
      ],
      conversations: [
        conv({ conversationId: 'cv-ok', participant_phone: '+15550002300', last_activity_at: '2026-06-12T10:00:00.000Z' }),
        conv({ conversationId: 'cv-broken', participant_phone: '+15550002301', last_activity_at: '2026-06-12T11:00:00.000Z' }),
      ],
      threadLookupErrorPhone: '+15550002301',
    };
    const info = vi.fn();
    const warn = vi.fn();
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps(seed, emptyCalls(), { info, warn }));
    // The page SERVES (no throw), minus exactly the broken row.
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-ok']);
    // The failure is its OWN code path: the specific WARN with the contactId...
    const failLine = warn.mock.calls.find((c) => String(c[1]).includes('thread read FAILED'));
    expect(failLine?.[0]).toMatchObject({ contactId: 'c-broken' });
    // ...and its OWN drop reason, distinct from the empty-thread-set drop. A
    // build that routes this through the best-effort contactConversations seam
    // (which returns [] for both) collapses these two counters into one and
    // goes red here.
    const assembled = info.mock.calls.find((c) => c[1] === 'inbox feed assembled')?.[0];
    expect(assembled?.drops).toMatchObject({ unknownThreadReadFailed: 1, unknownNoOpenThread: 1 });
    expect(assembled?.threadReadFailures).toBe(1);
  });

  it('class b: a contact whose only threads are closed or relay_group yields no row', async () => {
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps({
      contacts: [{ contactId: 'c-b', type: 'unknown', status: 'needs_review', phone: '+15550002400' }],
      conversations: [
        conv({ conversationId: 'cv-closed', participant_phone: '+15550002400', last_activity_at: '2026-06-12T10:00:00.000Z', status: 'closed' }),
        conv({ conversationId: 'cv-relay', participant_phone: '+15550002400', last_activity_at: '2026-06-12T11:00:00.000Z', type: 'relay_group' }),
      ],
    }));
    expect(page.rows).toEqual([]);
  });

  it('class d via byUnread: a soft-deleted unknown with a fresh post-deletion inbound resurfaces; outbound-only does not; a deleted team_member NEVER does', async () => {
    const seed: Seed = {
      contacts: [
        { contactId: 'c-res', type: 'unknown', status: 'needs_review', phone: '+15550002500', deleted_at: '2026-06-10T00:00:00.000Z' },
        { contactId: 'c-out', type: 'unknown', status: 'needs_review', phone: '+15550002501', deleted_at: '2026-06-10T00:00:00.000Z' },
        // The side-door probe: roleFromContact falls team_member through to
        // 'unknown', but the ruling (class c) keeps them out of the queue. A
        // sweep filtered on roleFromContact instead of type === 'unknown'
        // admits this row and goes red here.
        { contactId: 'c-team', type: 'team_member', status: 'active', phone: '+15550002502', deleted_at: '2026-06-10T00:00:00.000Z' },
      ],
      conversations: [
        conv({ conversationId: 'cv-res', participant_phone: '+15550002500', last_activity_at: '2026-06-12T10:00:00.000Z', unread_count: 1 }),
        conv({ conversationId: 'cv-out', participant_phone: '+15550002501', last_activity_at: '2026-06-12T11:00:00.000Z', unread_count: 1 }),
        conv({ conversationId: 'cv-team', participant_phone: '+15550002502', last_activity_at: '2026-06-12T12:00:00.000Z', unread_count: 1, type: 'tenant_1to1' }),
      ],
      latestMessage: {
        'cv-res': { type: 'sms', direction: 'inbound', body: 'still there?', created_at: '2026-06-12T10:00:00.000Z' },
        'cv-out': { type: 'sms', direction: 'outbound', body: 'scheduled straggler', created_at: '2026-06-12T11:00:00.000Z' },
        'cv-team': { type: 'sms', direction: 'inbound', body: 'colleague ping', created_at: '2026-06-12T12:00:00.000Z' },
      },
    };
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps(seed));
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ contactId: 'c-res', deleted: true, needsTriage: true });
  });

  it('sorts partition rows and resurfaced rows together, newest displayed activity first', async () => {
    const seed: Seed = {
      contacts: [
        { contactId: 'c-old', type: 'unknown', status: 'needs_review', phone: '+15550002600' },
        { contactId: 'c-new', type: 'unknown', status: 'active', phone: '+15550002601' },
        { contactId: 'c-mid', type: 'unknown', status: 'needs_review', phone: '+15550002602', deleted_at: '2026-06-10T00:00:00.000Z' },
      ],
      conversations: [
        conv({ conversationId: 'cv-old', participant_phone: '+15550002600', last_activity_at: '2026-06-12T08:00:00.000Z' }),
        conv({ conversationId: 'cv-new', participant_phone: '+15550002601', last_activity_at: '2026-06-12T12:00:00.000Z' }),
        conv({ conversationId: 'cv-mid', participant_phone: '+15550002602', last_activity_at: '2026-06-12T10:00:00.000Z', unread_count: 1 }),
      ],
      latestMessage: {
        'cv-mid': { type: 'sms', direction: 'inbound', body: 'hey', created_at: '2026-06-12T10:00:00.000Z' },
      },
    };
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps(seed));
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-new', 'c-mid', 'c-old']);
  });

  it('the live type re-check drops a stale-index row that no longer renders as unknown', async () => {
    // Models the retype race: the partition Query hands back an image whose
    // type has already moved on. roleFromContact says tenant -> not a triage
    // row, whatever partition it arrived from.
    const seed: Seed = {
      contacts: [],
      conversations: [conv({ conversationId: 'cv-x', participant_phone: '+15550002700', last_activity_at: '2026-06-12T10:00:00.000Z' })],
      listByTypeOverride: () => ({
        items: [{ contactId: 'c-retyped', type: 'tenant', phone: '+15550002700' } as ContactItem],
      }),
    };
    const info = vi.fn();
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps(seed, emptyCalls(), { info, warn: vi.fn() }));
    expect(page.rows).toEqual([]);
    const assembled = info.mock.calls.find((c) => c[1] === 'inbox feed assembled')?.[0];
    expect(assembled?.drops).toMatchObject({ unknownQueueRetyped: 1 });
  });
});
```

- [ ] **Step 2: Run, see it fail for the RIGHT reason**

Run: `cd W:\tmp\inbox-unread-cluster\app; npx vitest run test/inboxUnknownTab.test.ts`
Expected: FAIL - the cost test reports `listByLastActivity` 1 (the old pager
ran) and `listByType` 0; the cursor test resolves instead of rejecting; etc.
If it fails on a fixture TypeError instead, fix the fixture first.

- [ ] **Step 3: inbox.ts - imports and deps seams**

Add to the imports (the `unreadFeed.js` import block already carries
`BADGE_COUNT_CAP`, `collectUnreadRows`, `UNREAD_WALK_LIMIT`,
`warnDeletedProbes` - verify, they are all imported at `inbox.ts:86-96`):

```ts
import {
  collectUnknownTriageQueue,
  UNKNOWN_QUEUE_MAX_PAGES,
  UNKNOWN_QUEUE_MAX_ROWS,
  UNKNOWN_QUEUE_PAGE_SIZE,
} from '../lib/unknownQueue.js';
```

In `InboxRouterDeps` (after `unreadWalkLimit`):

```ts
  /**
   * TEST SEAMS for the unknown-tab queue read, mirroring unreadWalkLimit:
   * production leaves them undefined and takes the lib/unknownQueue.ts
   * constants; tests set them small so the fill-loop, cap and WARN postures
   * are reachable without 200-contact fixtures.
   */
  unknownQueuePageSize?: number;
  unknownQueueMaxPages?: number;
  unknownQueueMaxRows?: number;
```

- [ ] **Step 4: inbox.ts - the cursor decode gate**

At ~576-579, `filter=unknown` no longer pages the open partition, so it must
not decode an open-partition cursor:

```ts
  const startKey =
    filter === 'all' && cursor !== undefined ? decodeCursor(cursor) : undefined;
```

Also update the comment above it: only `all` pages the 'open' partition now;
`unknown` mints no cursor at all and 400s any it receives (its branch below).

- [ ] **Step 5: inbox.ts - the branch**

Insert AFTER the `filter === 'unread'` branch's closing `}` (~line 1454) and
BEFORE `const rows: InboxRow[] = [];`:

```ts
  // --- filter=unknown: the triage partition IS the feed (design 2026-08-25) --
  // The old read walked the ENTIRE open partition and paid one contact lookup
  // per conversation to find a handful of triage rows (~684 lookups across 24
  // Queries for at most 8 rows, measured in prod). This read queries the
  // (type='unknown') byTypeStatus partition and pays per row RETURNED. The
  // coverage decisions - what each class of row does under the new source -
  // are section 3 of docs/superpowers/specs/
  // 2026-08-25-inbox-unknown-tab-walk-design.md; the parity suite
  // (test/inboxUnknownParity.test.ts) pins them one by one.
  if (filter === 'unknown') {
    // The unknown feed is a single sorted window over a bounded queue: it
    // MINTS no cursor, so any cursor here is foreign (another filter's, or
    // tampered). 400, never a wrong-partition Query - the same namespacing
    // posture every other filter takes.
    if (cursor !== undefined) {
      throw new InboxBadRequestError('cursor does not match this filter');
    }

    const queue = await collectUnknownTriageQueue(
      { contacts, logger: log },
      {
        pageSize: deps.unknownQueuePageSize ?? UNKNOWN_QUEUE_PAGE_SIZE,
        maxPages: deps.unknownQueueMaxPages ?? UNKNOWN_QUEUE_MAX_PAGES,
        maxRows: deps.unknownQueueMaxRows ?? UNKNOWN_QUEUE_MAX_ROWS,
      },
    );

    let threadReadFailures = 0;
    /**
     * Requirement 4: "query threw" and "filtered to nothing" must be different
     * CODE PATHS. This calls conversationsForContact DIRECTLY - NOT the
     * best-effort contactConversations seam above, which catches and returns
     * [] for both - and catches locally: a failure withholds ONE row loudly
     * (WARN + its own drop counter) instead of 500ing the whole tab or
     * silently shrinking a triage queue. `undefined` = threw; `[]` = the
     * contact genuinely has no open non-relay thread.
     */
    const resolveOpenThreads = async (
      contact: ContactItem,
    ): Promise<ConversationItem[] | undefined> => {
      try {
        const all = await conversationsForContact(contact, conversations);
        return all.filter((c) => c.status === 'open' && c.type !== 'relay_group');
      } catch (err) {
        threadReadFailures += 1;
        dropped('unknownThreadReadFailed');
        log.warn(
          { err, contactId: contact.contactId },
          'inbox: unknown-queue thread read FAILED - a triage row is withheld from this page',
        );
        return undefined;
      }
    };

    const emitted = new Set<string>();
    const unknownRows: InboxRow[] = [];

    for (const contact of queue.contacts) {
      // The precedent's STATUS re-check does not carry over (the query no
      // longer narrows on status - class f); its honest replacement is a live
      // TYPE check with the same predicate the tab renders with. On a queried
      // partition item this equals `type === 'unknown'` (the partition key IS
      // the type), so it can only fire on a stale index image - and
      // team_member, which falls THROUGH roleFromContact to 'unknown', can
      // never be returned by listByType('unknown') in the first place
      // (class c ruling, 2026-08-25: internal staff are not triage).
      if (roleFromContact(contact) !== 'unknown') {
        dropped('unknownQueueRetyped');
        continue;
      }
      const open = await resolveOpenThreads(contact);
      if (open === undefined) continue; // threw - counted and WARNed above
      const maxConv = newestOf(open);
      // No open non-relay thread -> no row: threadless group-detection stubs
      // (class a - which is also why excludeOrigin buys nothing here) and
      // contacts whose only thread is relay or closed (class b).
      if (maxConv === undefined) {
        dropped('unknownNoOpenThread');
        continue;
      }
      const unreadSum = open.reduce((sum, c) => sum + unreadOf(c), 0);
      const row = await buildContactRow(contact, open, maxConv, unreadSum, false);
      // Unreachable with deleted=false (buildContactRow's single-cause
      // return); kept as the belt so a future deleted-path change here cannot
      // silently drop rows.
      if (row === undefined) {
        dropped('resurfaceHidden');
        continue;
      }
      emitted.add(contact.contactId);
      unknownRows.push(row);
    }

    // Class d - deleted-contact resurfacing. listByType's `deleted` option is
    // a TRI-STATE with no "both", so soft-deleted unknowns cannot come from
    // the partition read above - but a resurfacing row is UNREAD BY
    // DEFINITION, so the sparse byUnread index already carries it. ONE collect
    // on the unread branch's own budget and bounds - no second invented bound
    // (design requirement 3). Its per-request probe tripwire fires here like
    // it does on the badge path.
    const collected = await collectUnreadRows(
      { conversations, contacts, messages, logger: log },
      {
        maxRows: BADGE_COUNT_CAP,
        budget: deps.unreadWalkLimit ?? UNREAD_WALK_LIMIT,
      },
    );
    warnDeletedProbes(log, {
      probes: collected.deletedProbes,
      wasted: collected.wastedProbes,
      skipped: collected.skippedDeletedThreads,
    });
    for (const candidate of collected.candidates) {
      if (candidate.kind !== 'contact') continue;
      // TYPE, not roleFromContact: a deleted team_member's fresh inbound must
      // not re-enter the triage queue through this side door - the
      // fall-through renders team_member as 'unknown' (class c ruling).
      if (candidate.contact.type !== 'unknown') continue;
      // Live unknowns already came from the partition read; only soft-deleted
      // ones need this source. (The partition read excludes deleted rows, so
      // the two sources are disjoint - the emitted-set check is a belt.)
      if (!isDeleted(candidate.contact)) continue;
      if (emitted.has(candidate.contact.contactId)) continue;
      const open = await resolveOpenThreads(candidate.contact);
      if (open === undefined) continue;
      const maxConv = newestOf(open);
      if (maxConv === undefined) continue;
      const unreadSum = open.reduce((sum, c) => sum + unreadOf(c), 0);
      // Read since the index offered it: the resurfacing window has closed.
      if (unreadSum === 0) {
        dropped('deletedNoUnread');
        continue;
      }
      const row = await buildContactRow(candidate.contact, open, maxConv, unreadSum, true);
      if (row === undefined) {
        dropped('resurfaceHidden');
        continue;
      }
      emitted.add(candidate.contact.contactId);
      unknownRows.push(row);
    }
    if (collected.truncated) {
      // The sweep's answer is a floor - same posture as the collector's own
      // WARN, and NEVER the wire `truncated` flag (see the return below).
      log.warn(
        { scanned: (deps.unreadWalkLimit ?? UNREAD_WALK_LIMIT) - collected.remainingBudget },
        'inbox: the unknown-tab resurfacing sweep stopped early - the deleted-row set is a floor',
      );
    }

    // Requirement 2: the whole capped queue, sorted in memory, newest first -
    // the byTypeStatus index has no activity dimension, so index-order paging
    // would yield globally out-of-order pages.
    unknownRows.sort((a, b) =>
      a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0,
    );
    // The response window is the wire limit (route-clamped, dashboard sends
    // 30). Rows past it are NOT silently gone: the WARN below names the count,
    // and triage itself drains the queue newest-first, so the remainder
    // becomes reachable as rows are retyped away. No cursor - an offset page
    // over a mutating in-memory sort re-serves and skips rows, and the design
    // settled on cap-plus-WARN (requirement 2). The affordance gap is recorded
    // in docs/issues/inbox-filter-tabs-full-walk.md.
    const windowed = unknownRows.slice(0, limit);
    if (windowed.length < unknownRows.length) {
      log.warn(
        { shown: windowed.length, assembled: unknownRows.length, limit },
        'inbox: the unknown tab could not show every triage row - the queue is a floor',
      );
    }

    log.info(
      {
        filter,
        count: windowed.length,
        queueContacts: queue.contacts.length,
        queuePages: queue.pagesWalked,
        ...(queue.truncated && { queueTruncated: true }),
        ...(threadReadFailures > 0 && { threadReadFailures }),
        ...(collected.truncated && { resurfaceTruncated: true }),
        ...(Object.keys(drops).length > 0 && { drops }),
      },
      'inbox feed assembled',
    );
    // NEVER the `truncated` wire flag here: that field is the unread branch's
    // contract (see InboxPage.truncated), and an empty page carrying it
    // renders the dashboard's FAILURE banner - on a tab whose NORMAL state is
    // an empty, cleared queue (design requirement 5). Truncation on this
    // branch is a WARN, by design.
    return { rows: windowed, nextCursor: null };
  }
```

- [ ] **Step 6: inbox.ts - the read-accounting comment**

The block comment at ~599-623 says the accounting fields cover "filters `all`
and `unknown`". Update that sentence to name `all` only, and add one line: the
unknown branch returns through its own log line
(queueContacts/queuePages/threadReadFailures + the shared `drops`).

- [ ] **Step 7: Run the new suite, see it pass**

Run: `cd W:\tmp\inbox-unread-cluster\app; npx vitest run test/inboxUnknownTab.test.ts`
Expected: all pass.

- [ ] **Step 8: Amend the parity pins (the two FLIP rows)**

In `app/test/inboxUnknownParity.test.ts`:

- Class (e) test: change the unknown-tab pin to `[]` and update the test name
  and comment - the contactless number leaves the TRIAGE QUEUE, not the inbox;
  the `all`-tab assertion (the mitigation) stays and must still pass:

```ts
  it('class e: a CONTACTLESS unknown number leaves the triage queue (decided 2026-08-25) but stays on All - the accepted trade', async () => {
    // ...same world...
    expect(unknown.rows).toEqual([]);
    expect(all.rows.map((r) => r.phone)).toEqual(['+14049824978']);
  });
```

- Class (c) test: change the pin to `[]` and rename - the ruling closed the
  latent bug:

```ts
  it('class c: a team_member never enters the triage queue (RULED 2026-08-25 - the old tab showing them was the bug)', async () => {
    // ...same world...
    expect(page.rows).toEqual([]);
  });
```

Every OTHER parity test must pass UNCHANGED - if one fails, that is a coverage
regression in the branch, not a pin to update. Fix the branch.

- [ ] **Step 9: Update inboxFeed.test.ts's two changed pins**

Test at ~591-613 (`filter "unread" keeps only unreadCount>0; "unknown" keeps
only needsTriage`): the unread half is untouched; replace the unknown half -
the contactless number now has NO contact record, so the queue is empty, and
the row remains reachable under `all`:

```ts
    const unknown = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps(baseSeed));
    // Class e (design 2026-08-25): a contactless conversation leaves the
    // TRIAGE QUEUE - a queue built from contacts cannot see it - but stays
    // visible, replyable and reachable on the All tab.
    expect(unknown.rows).toEqual([]);
    const allAgain = await aggregateInbox({ filter: 'all', limit: 25 }, makeDeps(baseSeed));
    expect(allAgain.rows.some((r) => r.kind === 'unknown' && r.phone === '+14049824978')).toBe(true);
```

Test at ~736-766 (`rejects a resolved non-unknown contact before conversation
and message hydration`): rewrite as the new cost pin - the unknown filter
never walks the open partition at all:

```ts
  it('filter=unknown never walks the open partition: a tenant world costs one listByType and nothing per-conversation', async () => {
    const calls = emptyCallCounts();
    // unread_count is 0 here ON PURPOSE (the old test seeded 1): the
    // resurfacing sweep resolves a contact for every visible unread index
    // item, so an unread thread would put a findByPhone back on this page for
    // a reason unrelated to the partition walk this test pins.
    const page = await aggregateInbox(
      { filter: 'unknown', limit: 30 },
      makeDeps({
        contacts: [{ contactId: 'contact-tenant', type: 'tenant', phone: '+14045550105' }],
        conversations: [
          conv({
            conversationId: 'conv-tenant',
            participant_phone: '+14045550105',
            last_activity_at: '2026-06-12T10:00:00.000Z',
            unread_count: 0,
            placementId: 'placement-tenant',
          }),
        ],
        latestMessage: {
          'conv-tenant': { type: 'sms', direction: 'inbound', body: 'known tenant' },
        },
        placements: { 'placement-tenant': { stage: 'searching' } },
      }, calls),
    );

    expect(page.rows).toEqual([]);
    expect(calls).toEqual({
      // One byUnread probe: the deleted-resurfacing sweep (class d) rides the
      // sparse index; an empty index is one cheap Query.
      queryUnreadPage: 1,
      findByPhone: 0, // the per-conversation contact resolution is GONE
      findByParticipantPhone: 0,
      listByConversation: 0,
      getPlacementById: 0,
      listByType: 1, // the triage partition is the only read
      listByLastActivity: 0, // the open-partition pager never runs
    });
  });
```

NOTE the sweep makes `queryUnreadPage: 1` - if the run reports a different
count, read the branch (did the collect loop page?) before touching the pin.

Also re-run the two unknown-filter tests that must pass UNCHANGED:
~387-409 (partner excluded; rows `[]` both before and after) and ~411-436
(type=unknown contact appears; same rows) and ~519-543 (relay matrix; the
unknown pin `['+14049824978']` still holds because that phone's contact
`c-unk` IS type unknown in that seed).

- [ ] **Step 10: Update inboxApi.test.ts**

Test at 199-218: the seed has no contact for `+14049824978`, so the unknown
tab is now empty. Rewrite the unknown half to seed a real unknown CONTACT and
pin both fates:

```ts
    // Class e (design 2026-08-25): the contactless number leaves the triage
    // queue but stays on All. A type=unknown CONTACT is the queue's row shape.
    seedContact(world, { contactId: 'c-unk', type: 'unknown', status: 'needs_review', phone: '+14045550777' });
    seedConversation(world, 'conv-unk-contact', {
      participant_phone: '+14045550777',
      last_activity_at: '2026-06-12T10:00:00.000Z',
      type: 'unknown_1to1',
      unread_count: 1,
    });

    const unknown = await auth(request(app).get('/api/inbox?filter=unknown'));
    expect(unknown.status).toBe(200);
    expect(unknown.body.rows.every((r: { needsTriage: boolean }) => r.needsTriage)).toBe(true);
    expect(unknown.body.rows.map((r: { contactId?: string }) => r.contactId)).toEqual(['c-unk']);
    expect(unknown.body.rows.map((r: { phone?: string }) => r.phone)).toEqual(['+14045550777']);

    const all = await auth(request(app).get('/api/inbox'));
    expect(all.body.rows.some((r: { kind: string; phone?: string }) => r.kind === 'unknown' && r.phone === '+14049824978')).toBe(true);
```

(Keep the existing seeds; `seedContact`/`seedConversation` are this file's own
helpers - check their exact signatures at the top of the file and match them.)

Add one new route test next to the 400 tests (~line 250):

```ts
  it('400 on filter=unknown with any cursor (the unknown feed mints none)', async () => {
    const { app } = makeWebhookHarness();
    const foreign = Buffer.from(JSON.stringify({ idx: 0 }), 'utf8').toString('base64url');
    const res = await auth(request(app).get(`/api/inbox?filter=unknown&cursor=${foreign}`));
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 11: Run every touched app suite**

Run: `cd W:\tmp\inbox-unread-cluster\app; npx vitest run test/inboxUnknownTab.test.ts test/inboxUnknownParity.test.ts test/inboxFeed.test.ts test/inboxGroups.test.ts test/inboxApi.test.ts test/unknownQueue.test.ts`
Expected: all pass. inboxGroups needed no edits - if it is red, the branch is
reading something it should not (its `calls.groupLimits` pin proves the group
partition is untouched under filter=unknown).

- [ ] **Step 12: Typecheck**

Run: `cd W:\tmp\inbox-unread-cluster; npm run typecheck`
Expected: exit 0. (The new deps fields and the `Pick`-typed collector deps are
invisible to vitest's esbuild - this is the gate that checks them.)

- [ ] **Step 13: Commit**

```
git add app/src/routes/inbox.ts app/test/inboxUnknownTab.test.ts app/test/inboxUnknownParity.test.ts app/test/inboxFeed.test.ts app/test/inboxApi.test.ts
git commit -m "feat(inbox): filter=unknown reads the contact triage partition, not the open-partition walk"
```

---

### Task 6: Integration repin (real DynamoDB) + perf-seed verification

**Files:**
- Modify: `app/test/inbox.integration.test.ts` (test at 323-330; one new test
  at the END of the describe, after line 427's last `it`)

**Interfaces:**
- Consumes: the flipped wire behavior (Task 5); the suite's own `contacts`,
  `conversations` repo consts and its `seedConv` helper (lines 62-166); the
  suite runs only when DynamoDB Local answers (`npm run db:start` first).
- Produces: nothing downstream; this is the real-index proof.

- [ ] **Step 1: Ensure DynamoDB Local is up**

Run: `cd W:\tmp\inbox-unread-cluster; npm run db:start`
(Idempotent; requires Docker.)

- [ ] **Step 2: Repin the class (e) test at line 323**

```ts
  it('filter=unknown no longer lists the contactless number - it stays on the All tab (class e, design 2026-08-25)', async () => {
    const resp = await get('/api/inbox?filter=unknown');
    expect(resp.status).toBe(200);
    const { rows } = await resp.json() as { rows: Array<Record<string, unknown>> };
    // No unknown CONTACTS exist in this world yet - the queue is empty, and an
    // empty queue is a normal page, not an error shape.
    expect(rows).toEqual([]);

    const all = await get('/api/inbox');
    const allRows = (await all.json() as { rows: Array<Record<string, unknown>> }).rows;
    expect(allRows.some((r) => r['kind'] === 'unknown' && r['phone'] === PHONE_UNK)).toBe(true);
  });
```

- [ ] **Step 3: Add the queue test at the END of the describe**

Placed after the last `it` (line ~427) because it MUTATES the shared world (a
new contact + conversation) and the earlier split-proof paging test pins exact
page counts. Note that in a comment on the test itself.

```ts
  // LAST ON PURPOSE: this test adds a contact + conversation to the shared
  // world, and the split-proof paging test above pins exact page counts over
  // the original topology.
  it('filter=unknown lists a type=unknown CONTACT with an open thread, against the real byTypeStatus index', async () => {
    const PHONE_UNK2 = '+15561001099';
    await contacts.createIfAbsent({
      contactId: 'it-contact-unk',
      type: 'unknown',
      status: 'needs_review',
      phone: PHONE_UNK2,
    });
    await seedConv({ phone: PHONE_UNK2, lastActivityAt: '2026-06-17T09:00:00.000Z', type: 'unknown_1to1', unread: 1 });

    const resp = await get('/api/inbox?filter=unknown');
    expect(resp.status).toBe(200);
    const { rows, nextCursor } = await resp.json() as {
      rows: Array<Record<string, unknown>>;
      nextCursor: string | null;
      truncated?: boolean;
    };
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'contact',
      contactId: 'it-contact-unk',
      role: 'unknown',
      needsTriage: true,
      phone: PHONE_UNK2,
    });
    expect(nextCursor).toBeNull();
  });
```

- [ ] **Step 4: Run the integration suite**

Run: `cd W:\tmp\inbox-unread-cluster\app; npx vitest run test/inbox.integration.test.ts`
Expected: all pass. If DynamoDB suites are broadly red, re-run under a clean
access key before blaming the change:
`cd W:\tmp\inbox-unread-cluster\app; $env:AWS_ACCESS_KEY_ID='hccleanrun001'; npx vitest run test/inbox.integration.test.ts`
(then remove the env var: `Remove-Item Env:AWS_ACCESS_KEY_ID`).

- [ ] **Step 5: Run the perf-seed suite UNCHANGED and read the unknown assertion**

Run: `cd W:\tmp\inbox-unread-cluster\app; npx vitest run test/performanceSeed.integration.test.ts`
Expected: PASS with no edits - the perf seed's unknowns are CONTACT-backed
(`lib/seed/performance.ts` `buildContact` / `oneToOneReference`), so
`unknown.rows.length > 0` (line 414) holds under the contact-side read. If it
goes red on that line, that is a REAL coverage regression in the branch (or a
deleted/threadless-only unknown population in the seed) - diagnose, do not
weaken the assertion.

- [ ] **Step 6: Commit**

```
git add app/test/inbox.integration.test.ts
git commit -m "test(inbox): integration pins for the contact-side unknown tab on the real index"
```

---

### Task 7: Dashboard pin - the empty Unknown tab is an empty state, not a failure

**Files:**
- Modify: `dashboard/src/routes/inbox/Inbox.test.tsx` (append a describe)

**Interfaces:**
- Consumes: the file's existing `state` / `baseState()` / `renderInbox(entry:
  string)` scaffolding (lines 7-64; `renderInbox` takes a URL STRING, and
  `useInbox` is mocked to return `state`).
- Produces: the client-side half of requirement 5, pinned. No production
  dashboard code changes in this task - the server contract (never `truncated`
  on unknown) is what keeps the banner off, and the second test documents that
  dependency in the place a future client dev will look.

- [ ] **Step 1: Append the tests**

```tsx
describe('the Unknown tab empty state (contact-side read, 2026-08-25)', () => {
  it('an empty ready page renders the honest empty copy, never the failure banner', () => {
    state = baseState();
    renderInbox('/inbox?filter=unknown');
    expect(screen.getByText('No unknown numbers')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an empty page the server calls truncated DOES banner - which is why the unknown branch must never set the flag (requirement 5)', () => {
    // This pins the DEPENDENCY, not a wish: serverEndedEarlyEmpty is not
    // filter-gated (Inbox.tsx:42), so the server-side rule "no truncated on
    // filter=unknown" (routes/inbox.ts, the unknown branch's return) is what
    // keeps a cleared triage queue from rendering as a load failure.
    state = baseState({ truncated: true });
    renderInbox('/inbox?filter=unknown');
    expect(screen.queryByText('No unknown numbers')).toBeNull();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run**

Run: `cd W:\tmp\inbox-unread-cluster\dashboard; npx vitest run src/routes/inbox/Inbox.test.tsx`
Expected: all pass (both behaviors already exist client-side; the value is the
pin plus the pointer at the server rule).

- [ ] **Step 3: Commit**

```
git add dashboard/src/routes/inbox/Inbox.test.tsx
git commit -m "test(dashboard): pin the Unknown tab's empty-state-vs-banner gate (requirement 5)"
```

---

### Task 8: E2E - the Unknown tab as a triage queue

**Files:**
- Modify: `e2e/tests/dashboard-next/unknown-caller-triage.spec.ts` (add one test)

**Interfaces:**
- Consumes: that spec's existing imports and helpers - `placeCall` from
  `../../fixtures/fakeVoice.js`, `reseed` (runs in `beforeEach`),
  `uniqueVoicePhone`, `NEXT`, the local `devLogin(page)` and
  `BUSINESS = '+15550009999'`. The lean seed contains ZERO unknown contacts
  (`app/src/lib/seed/lean.ts` seeds tenant/landlord/partner only), so the tab
  starts empty. A missed inbound call mints a `(unknown, needs_review)` contact
  AND a 1:1 thread (the missed-call auto-text), which is exactly the queue's
  row shape.
- Produces: the user-facing proof, executed by gate 4 (`npm run e2e`) in Task 11.
  DO NOT run the e2e suite or start a lane in this task - write the spec only.

- [ ] **Step 1: Append the test**

```ts
test('the Unknown tab is the contact triage queue: an honest empty state, then the captured caller', async ({
  page,
}) => {
  const api = page.request;
  await devLogin(page);

  // (1) Empty queue = the NORMAL zero state: the per-filter empty copy, and
  // never the load-failure banner (design requirement 5).
  await page.goto(`${NEXT}/inbox?filter=unknown`);
  await expect(page.getByRole('tab', { name: 'Unknown' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('No unknown numbers')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  // (2) A missed call from a fresh number mints an (unknown, needs_review)
  // contact plus its 1:1 thread (the missed-call auto-text).
  const caller = uniqueVoicePhone();
  await placeCall(api, { from: caller, to: BUSINESS, scenario: { digit: null } });
  let stubId: string | undefined;
  await expect
    .poll(
      async () => {
        const res = await api.get(`${NEXT}/api/contacts?type=unknown`);
        if (!res.ok()) return false;
        const { contacts } = (await res.json()) as { contacts: Array<{ contactId: string; phone?: string }> };
        stubId = contacts.find((c) => c.phone === caller)?.contactId;
        return stubId !== undefined;
      },
      { timeout: 10_000 },
    )
    .toBeTruthy();

  // (3) The Unknown tab now lists the caller, as a CONTACT row deep-linking to
  // the contact page - the contact-side read (design 2026-08-25).
  await page.goto(`${NEXT}/inbox?filter=unknown`);
  const row = page.locator(`a[href="/contacts/${stubId}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(/needs triage/i);
  await expect(page.getByText('No unknown numbers')).toHaveCount(0);
});
```

- [ ] **Step 2: Typecheck only (no lane, no suite run here)**

Run: `cd W:\tmp\inbox-unread-cluster; npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```
git add e2e/tests/dashboard-next/unknown-caller-triage.spec.ts
git commit -m "test(e2e): Unknown tab shows the captured caller and an honest empty state"
```

---

### Task 9: The safety net - budget the filter=all open-partition pager (spec section 5)

**Files:**
- Modify: `app/src/routes/inbox.ts` (the `InboxPage.truncated` doc comment at
  ~147-152; `InboxRouterDeps`; a constant near `FETCH_BATCH` ~205; the pager
  loop at ~1474-1528; the final return at ~1655)
- Create: `app/test/inboxOpenBudget.test.ts`

**Interfaces:**
- Consumes: the pager's existing `rawScanned` counter and `encodeCursor`;
  `useInbox` already forwards `pageData.truncated` for every filter
  (`useInbox.ts:242,348`), and the dashboard's `serverEndedEarlyEmpty` gate
  plus Load-more give an honest surface with NO client change.
- Produces: `OPEN_WALK_LIMIT = 2000` (exported), `InboxRouterDeps.openWalkLimit?:
  number` (test seam), and `truncated: true` + a minted cursor on a
  budget-stopped `filter=all` page. This is a DELIBERATE extension of the
  `InboxPage.truncated` contract - same meaning ("the feed ended for a
  non-natural reason"), one new producer - never a repurpose; the doc comment
  is updated in the same commit and the unknown/groups exclusions stay.

- [ ] **Step 1: Write the failing tests**

```ts
// app/test/inboxOpenBudget.test.ts
// Spec section 5: the open-partition pager (now serving filter=all only) gets
// the budget + cursor + truncated contract the unread branch already has. An
// unbounded read should not exist even while it is cheap.
import { describe, expect, it } from 'vitest';
import { aggregateInbox, type InboxRouterDeps } from '../src/routes/inbox.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';

interface Seed {
  contacts: ContactItem[];
  conversations: ConversationItem[];
  /** The participant GSIs' image when it must differ from the base table. */
  participantProjection?: ConversationItem[];
}

function conv(
  over: Partial<ConversationItem> & { conversationId: string; participant_phone: string; last_activity_at: string },
): ConversationItem {
  return { status: 'open', type: 'tenant_1to1', ai_mode: 'auto', created_at: over.last_activity_at, ...over };
}

function makeDeps(seed: Seed, openWalkLimit?: number): InboxRouterDeps {
  const ordered = [...seed.conversations]
    .filter((c) => c.status === 'open')
    .sort((a, b) => (a.last_activity_at < b.last_activity_at ? 1 : -1));
  const participantView = seed.participantProjection ?? seed.conversations;
  return {
    ...(openWalkLimit !== undefined && { openWalkLimit }),
    conversationsRepo: {
      async getById(id: string) {
        return seed.conversations.find((c) => c.conversationId === id);
      },
      async queryUnreadPage() {
        return { items: [] };
      },
      async listByLastActivity({ limit, exclusiveStartKey }: { status: string; limit?: number; exclusiveStartKey?: Record<string, unknown> }) {
        const start = typeof exclusiveStartKey?.['idx'] === 'number' ? (exclusiveStartKey['idx'] as number) + 1 : 0;
        const take = limit ?? 50;
        const window = ordered.slice(start, start + take);
        const hasMore = start + window.length < ordered.length;
        return {
          items: window,
          ...(hasMore && { lastEvaluatedKey: { idx: start + window.length - 1 } as Record<string, unknown> }),
        };
      },
      async findByParticipantPhone(phone: string) {
        return participantView.filter((c) => c.participant_phone === phone);
      },
      async findByParticipantEmail(email: string) {
        return participantView.filter((c) => c.participant_email === email);
      },
      async listRelayGroups() {
        return { items: [], truncated: false };
      },
      async listGroupTexts() {
        return { items: [], truncated: false };
      },
    } as unknown as NonNullable<InboxRouterDeps['conversationsRepo']>,
    contactsRepo: {
      async findByPhone(phone: string) {
        return seed.contacts.find((c) => c.phone === phone);
      },
      async findByEmail() {
        return undefined;
      },
      async getById(contactId: string) {
        return seed.contacts.find((c) => c.contactId === contactId);
      },
      async listByType() {
        return { items: [] };
      },
    } as unknown as NonNullable<InboxRouterDeps['contactsRepo']>,
    messagesRepo: {
      async listByConversation() {
        return [];
      },
    } as unknown as NonNullable<InboxRouterDeps['messagesRepo']>,
    placementsRepo: {
      async getById() {
        return undefined;
      },
    } as unknown as NonNullable<InboxRouterDeps['placementsRepo']>,
  };
}

/** 30 open conversations all owned by ONE contact: 1 row, 29 drops - a page
 *  that cannot fill, which is the only world where the budget matters. */
function oneContactManyThreads(): Seed {
  const phone = '+15550003000';
  const conversations = Array.from({ length: 30 }, (_, i) =>
    conv({
      conversationId: `cv-${String(i).padStart(2, '0')}`,
      participant_phone: phone,
      last_activity_at: `2026-06-12T${String(23 - (i % 24)).padStart(2, '0')}:${String(59 - i).padStart(2, '0')}:00.000Z`,
    }),
  );
  return {
    contacts: [{ contactId: 'c-one', type: 'tenant', phone }],
    conversations,
  };
}

describe('filter=all open-partition budget (spec section 5)', () => {
  it('the budget stops the walk at a chunk boundary: truncated + a cursor that RESUMES', async () => {
    // limit 5 -> chunkSize max(5, DEFAULT_INBOX_LIMIT 25) = 25: chunk one
    // scans 25 raw rows >= budget 25 with more behind -> stop, mint, flag.
    const page1 = await aggregateInbox({ filter: 'all', limit: 5 }, makeDeps(oneContactManyThreads(), 25));
    expect(page1.rows).toHaveLength(1);
    expect(page1.truncated).toBe(true);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await aggregateInbox(
      { filter: 'all', limit: 5, cursor: page1.nextCursor! },
      makeDeps(oneContactManyThreads(), 25),
    );
    // The remaining 5 raw rows are all older threads of the already-shown
    // contact: no rows, natural end, no flag.
    expect(page2.rows).toEqual([]);
    expect(page2.nextCursor).toBeNull();
    expect('truncated' in page2).toBe(false);
  });

  it('zero rows + budget spent: the flag stands and the cursor is nulled (empty-page invariant)', async () => {
    // The ghost-projection trick from inboxFeed.test.ts:334-363: the contact
    // resolves through a participant image containing a NEWER thread the
    // partition walk never offers, so every walked conversation drops as
    // notNewestConv and the page is empty while supply remains.
    const seed = oneContactManyThreads();
    seed.participantProjection = [
      ...seed.conversations,
      conv({ conversationId: 'cv-ghost', participant_phone: '+15550003000', last_activity_at: '2026-06-30T00:00:00.000Z' }),
    ];
    const page = await aggregateInbox({ filter: 'all', limit: 5 }, makeDeps(seed, 25));
    expect(page.rows).toEqual([]);
    expect(page.truncated).toBe(true);
    // rows empty -> null cursor: the dashboard's Load-more hangs off rows, and
    // an empty truncated page must keep its error-state posture instead.
    expect(page.nextCursor).toBeNull();
  });

  it('without the seam the default budget never trips on a small world', async () => {
    const page = await aggregateInbox({ filter: 'all', limit: 5 }, makeDeps(oneContactManyThreads()));
    expect(page.rows).toHaveLength(1);
    expect('truncated' in page).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});
```

- [ ] **Step 2: Run, see it fail**

Run: `cd W:\tmp\inbox-unread-cluster\app; npx vitest run test/inboxOpenBudget.test.ts`
Expected: FAIL - `page1.truncated` undefined, `page1.nextCursor` null (the
walk ran to exhaustion).

- [ ] **Step 3: Implement**

In `inbox.ts`:

(a) Constant, next to `FETCH_BATCH` (~line 205):

```ts
/**
 * Raw open-partition conversations ONE filter=all request may scan (spec
 * section 5 of the 2026-08-25 unknown-tab design - the safety net). The same
 * shape as UNREAD_WALK_LIMIT: a request budget, not a per-chunk allowance.
 * Checked at CHUNK boundaries, so the real ceiling is this plus one chunk.
 */
export const OPEN_WALK_LIMIT = 2000;
```

(b) Deps seam, after the unknown-queue seams:

```ts
  /** TEST SEAM mirroring unreadWalkLimit, for the filter=all pager's budget. */
  openWalkLimit?: number;
```

(c) The pager loop (~1474-1528). Before the loop:

```ts
  const openBudget = deps.openWalkLimit ?? OPEN_WALK_LIMIT;
  let openTruncated = false;
```

Replace the loop's tail (currently `if (!moreChunks) { nextCursor = null;
break; } chunkStartKey = chunk.lastEvaluatedKey;`) with:

```ts
    const lek = chunk.lastEvaluatedKey;
    if (lek === undefined) {
      // Walked the whole stream without filling the page -> no more rows.
      nextCursor = null;
      break;
    }
    if (rawScanned >= openBudget) {
      // THE SAFETY NET (design section 5): stop at the CHUNK boundary - the
      // chunk's LEK is already the exact resume key, so no mid-chunk boundary
      // recovery is needed - mint the cursor (the position is paid for; see
      // the unread branch's budget exit for the precedent), and name the end
      // non-natural.
      nextCursor = encodeCursor(lek);
      openTruncated = true;
      break;
    }
    chunkStartKey = lek;
```

(`moreChunks` at ~1481 remains for the mid-chunk page-fill boundary logic; only
the loop tail changes.)

(d) After BOTH merge blocks (relay ~1530-1587 and groups ~1589-1631), before
the final `log.info`:

```ts
  // Empty-page invariant, shared with the unread branch (spec 4.5 step 2): an
  // empty rows array implies a null cursor - the dashboard's Load-more hangs
  // off rows, and an empty truncated page must keep its error-state posture
  // rather than offer a Load more the client has nothing to hang off.
  if (rows.length === 0) nextCursor = null;
```

(e) The final log line gains `...(openTruncated && { truncated: true }),` and
the return becomes:

```ts
  return {
    rows,
    nextCursor,
    ...(groupsTruncated && { groupsTruncated: true }),
    ...(openTruncated && { truncated: true as const }),
  };
```

(f) Update the `InboxPage.truncated` doc comment (~147-152) - a DELIBERATE
contract extension, not a repurpose:

```ts
  /** TRUE when a feed ended for a NON-NATURAL reason - the request's scan
   *  budget expired before the page filled, or (unread only) the SEEN_SET_MAX
   *  depth cap ended paging. Producers: the `filter=unread` branch (spec 4.5
   *  step 3) and, since the 2026-08-25 safety net, the `filter=all`
   *  open-partition pager's own budget. NEVER set on `unknown` (its normal
   *  state is an empty, cleared queue, and the dashboard renders
   *  empty-plus-truncated as the failure banner - design requirement 5) or on
   *  `groups` (`groupsTruncated` is its signal). Absent means the feed ended
   *  because it ran out of rows, which is the ordinary case. */
```

- [ ] **Step 4: Run the new suite AND the neighbors the pager change could disturb**

Run: `cd W:\tmp\inbox-unread-cluster\app; npx vitest run test/inboxOpenBudget.test.ts test/inboxFeed.test.ts test/inboxApi.test.ts test/inboxGroups.test.ts test/inboxUnknownTab.test.ts test/inboxUnknownParity.test.ts`
Expected: all pass (the default budget of 2000 is far above every fixture, so
only the seam-driven tests see the new exits).

- [ ] **Step 5: Typecheck, then commit**

Run: `cd W:\tmp\inbox-unread-cluster; npm run typecheck`
Expected: exit 0.

```
git add app/src/routes/inbox.ts app/test/inboxOpenBudget.test.ts
git commit -m "feat(inbox): budget the filter=all open-partition walk (spec section 5 safety net)"
```

---

### Task 10: Docs - close the issue's unknown item, record the ruling and the remainder

**Files:**
- Modify: `docs/issues/inbox-filter-tabs-full-walk.md`

**Interfaces:**
- Consumes: the issue's existing structure (its line 153 currently reads
  "UNKNOWN: STILL OPEN. `filter=unknown` still walks `byLastActivity` ...").
- Produces: the in-repo record; `npm run issues` regenerates the gitignored
  INDEX (nothing to commit from that).

- [ ] **Step 1: Edit the issue** (ASCII only; edit tool, never a PowerShell
  rewrite). Three additions:

1. Replace the "UNKNOWN: STILL OPEN" status line with a dated resolution:
   `filter=unknown` now reads the `(type='unknown')` byTypeStatus partition
   (branch `feat/inbox-unread-cluster`, design
   `docs/superpowers/specs/2026-08-25-inbox-unknown-tab-walk-design.md`):
   bounded fill loop (`UNKNOWN_QUEUE_MAX_PAGES` x `UNKNOWN_QUEUE_PAGE_SIZE`),
   hard result cap (`UNKNOWN_QUEUE_MAX_ROWS`), truncation WARN, deleted-contact
   resurfacing via one byUnread sweep, and NO status narrowing or excludeOrigin
   (spec section 3, classes f and a). The `filter=all` pager gained the
   `OPEN_WALK_LIMIT` budget + cursor + `truncated` contract (spec section 5),
   so no unbounded read remains on the route.
2. Record the class (c) ruling so it does not ride only on the spec: a
   `team_member` contact no longer appears on the Unknown tab (`roleFromContact`
   falls internal staff through to 'unknown', which put colleagues in the
   operator's triage queue; RULED 2026-08-25 that they do not belong there; the
   contact-side read excludes them by construction and
   `UNKNOWN_TAB_TYPE_DECISIONS` in `app/src/lib/unknownQueue.ts` pins the
   decision per ContactType).
3. Name the deliberate remainder: rows past the request `limit` (dashboard: 30)
   are WARNed (`inbox: the unknown tab could not show every triage row`) and
   become reachable as triage drains the queue newest-first, but the tab has no
   Load-more affordance for them; contactless conversations (class e, measured
   zero) surface on the All tab only. Reopen here if either trade goes wrong.

- [ ] **Step 2: Regenerate the index**

Run: `cd W:\tmp\inbox-unread-cluster; npm run issues`
Expected: exit 0 (INDEX.md is gitignored).

- [ ] **Step 3: Commit**

```
git add docs/issues/inbox-filter-tabs-full-walk.md
git commit -m "docs(issues): unknown-tab walk resolved by the contact-side read; team_member ruling recorded"
```

---

### Task 11: Completion gates

**Files:** none (verification only; fix-forward anything red, in the task where
it belongs).

**Interfaces:**
- Consumes: everything above, from the worktree `W:\tmp\inbox-unread-cluster`.
- Produces: the merge-ready evidence. Sync `main` into the branch ONCE before
  the gates (ask the human first if `main` has advanced into conflict with
  this work); report later drift rather than chasing it.

- [ ] **Step 1: Sync main once**

```
git -C W:\tmp\inbox-unread-cluster fetch origin
git -C W:\tmp\inbox-unread-cluster merge origin/main
```

Preserve both sides' intent in any conflict; if the merge looks contentious,
STOP and ask.

- [ ] **Step 2: Gate 1 - typecheck**

Run (from `W:\tmp\inbox-unread-cluster`): `npm run typecheck`
Expected: exit 0. Bare command, never piped.

- [ ] **Step 3: Gate 2 - unit/integration**

Ensure Docker + DynamoDB Local: `npm run db:start`
Run: `npm test`
Expected: exit 0. If DynamoDB suites are red, re-run under a clean access key
(`cd app; $env:AWS_ACCESS_KEY_ID='hccleanrun001'; npx vitest run`) before
attributing anything to this branch - a residue-carrying key fails ~9 files on
timeouts with zero assertion failures.

- [ ] **Step 4: Gate 3 - smoke**

Run: `npm run smoke`
Expected: exit 0 (proves the compiled ESM import graph - the new
`../lib/unknownQueue.js` specifier included - resolves under plain node).

- [ ] **Step 5: Gate 4 - e2e**

Run: `npm run e2e`
Expected: exit 0, including the new Unknown-tab test in
`unknown-caller-triage.spec.ts`. Do not run this concurrently with any
interactive session in this worktree. A named-spec failure is a REGRESSION to
diagnose, not something to re-run and excuse.

- [ ] **Step 6: Gate 5 - lint the branch's own files**

Run (PowerShell, from the worktree):
`npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`

- If the file list is EMPTY, skip the gate (do not let eslint go repo-wide).
- Attribute any errors by BASELINE COMPARISON (same command, same paths, at the
  merge base), never by line number: anything present now and absent there is
  yours and is blocking; name the pre-existing rest in the handback.

- [ ] **Step 7: Hand back**

Report: gates run with exit codes, the coverage-class pin changes (e and c) as
deliberate spec decisions with their parity-test locations, the
`InboxPage.truncated` contract extension (Task 9), and the perf-seed suite's
unchanged pass (Task 6 Step 5). Do not merge to `main`; that is the human's
call.

---

## Self-review notes (already applied)

- Spec coverage: requirement 1 -> Tasks 4+5 (no narrowing, live type check,
  named page size/cap); requirement 2 -> Task 5 (in-memory sort, window, WARN);
  requirement 3 -> Task 5 sweep (byUnread, badge-path bounds, no second bound);
  requirement 4 -> Task 5 `resolveOpenThreads` + its discrimination test;
  requirement 5 -> Task 5 (no `truncated` on unknown) + Task 7 pins; section 5
  -> Task 9; section 6 testing demands -> Tasks 3 (parity), 5 (starved fixture,
  read counts not wall-clock, class pins, loud-failure pin), mutation probes
  throughout; section 7 ruling -> `UNKNOWN_TAB_TYPE_DECISIONS`, the sweep's
  type check, Task 10's issue note.
- Deliberately NOT copied from the precedent, with reasons in code comments:
  `excludeOrigin` (class a - single-source reader) and the status re-check
  (replaced by the live type check). Both carry probes that go red if re-added,
  because the fakes honor the options.
- Names used consistently across tasks: `collectUnknownTriageQueue`,
  `UNKNOWN_QUEUE_PAGE_SIZE/MAX_PAGES/MAX_ROWS`, `UNKNOWN_TAB_TYPE_DECISIONS`,
  `listByTypeFromContacts`, drop reasons `unknownQueueRetyped` /
  `unknownThreadReadFailed` / `unknownNoOpenThread` / `deletedNoUnread` /
  `resurfaceHidden`, seams `unknownQueuePageSize/MaxPages/MaxRows`,
  `openWalkLimit`, constant `OPEN_WALK_LIMIT`.
