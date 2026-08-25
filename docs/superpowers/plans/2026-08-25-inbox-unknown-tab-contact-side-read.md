# Unknown-tab contact-side read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the inbox Unknown tab read the contacts triage partition directly instead of walking every open conversation and hydrating a contact per row.

**Architecture:** `filter=unknown` gets its own branch in `aggregateInbox`, mirroring how `filter=unread` already returns before the open-partition pager. It queries `listByType('unknown')` - no status narrowing, no origin exclusion - re-checks each contact's role live, resolves threads through the existing `contactConversations` seam with a LOCAL catch, builds rows through the existing `buildContactRow`, sorts by `last_activity_at`, and caps. Contacts with no open non-relay thread produce no row and cost nothing further.

**Tech Stack:** TypeScript, Node 24, Vitest, DynamoDB (byTypeStatus GSI), Express.

**Spec:** [`docs/superpowers/specs/2026-08-25-inbox-unknown-tab-walk-design.md`](../specs/2026-08-25-inbox-unknown-tab-walk-design.md) - draft 4, four review rounds, both round-3 and round-4 reviewers returned BUILDABLE.

## Global Constraints

- **Measured cost being replaced:** 684 contact lookups across 24 partition Queries to return at most 8 rows (prod, 2026-08-25). The proposed read is 7 rows in 1 Query.
- **New/touched lines are ASCII-only.** Repo rule; applies to code, comments, test names and log strings.
- **Never pipe a gate command.** Gates run bare; read the verdict from the log.
- **Five completion gates**, bare, from this worktree: `npm run typecheck`, `npm test`, `npm run smoke`, `npm run e2e`, and `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`.
- **`npm test` needs DynamoDB Local** (`npm run db:start`).
- **Do NOT copy `excludeOrigin` from `today.ts`.** That exclusion is safe there only because it is a two-source union; this design deletes the second source. Copying it silently drops a group-roster member who later texts in.
- **Do NOT narrow on `status`.** A contact created as `unknown` defaults to `status: 'active'`, so narrowing to `needs_review` loses rows by construction.
- **Every guard added must be mutation-probed:** reintroduce the defect it claims to catch and watch the test fail.

---

## File Structure

| file | responsibility | change |
| --- | --- | --- |
| `app/src/routes/inbox.ts` | the `filter=unknown` branch, returning before the open-partition pager | modify |
| `app/test/inboxUnknownParity.test.ts` | row-set parity pin: the new read returns what the walk returned | create |
| `app/test/inboxUnknownCost.test.ts` | read-cost pin on a STARVED filter | create |
| `app/test/inboxFeed.test.ts` | add `listByType` to the call-count harness | modify |
| `app/test/contactTypeExhaustive.test.ts` | pin `ContactType`'s union so a new type fails loudly | create |
| `dashboard/src/routes/inbox/Inbox.tsx` | an empty triage queue renders the empty state, not the failure banner | modify |

Task 1 and Task 2 are pins written against TODAY's code and must pass BEFORE any behaviour changes. That ordering is the point: they are the only guards that can catch a row quietly disappearing.

---

### Task 1: Parity pin for `filter=unknown`, on a starved fixture

**Files:**
- Create: `app/test/inboxUnknownParity.test.ts`

**Interfaces:**
- Consumes: `aggregateInbox(opts, deps)` from `app/src/routes/inbox.ts`; `InboxRow`, `InboxRouterDeps` from the same module.
- Produces (all EXPORTED, because Tasks 2, 4 and 6 extend this same fixture and must not fork it): `makeDeps()`, `CONTACTS`, `CONVERSATIONS`, `rowKey(row)`.

**Why starved:** the pager breaks when the page FILLS, so a fixture where most rows match measures the cheap path. This fixture is 40 open conversations of which 3 are untriaged - the shape that exhausts the partition.

- [ ] **Step 1: Write the failing test**

Model the fixture on `app/test/inboxUnreadParity.test.ts` - copy its `makeDeps` shape and its `rowKey` helper rather than inventing new ones.

```typescript
// app/test/inboxUnknownParity.test.ts
import { describe, expect, it } from 'vitest';
import { aggregateInbox, type InboxRouterDeps, type InboxRow } from '../src/routes/inbox.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';

const rowKey = (r: InboxRow): string =>
  r.kind === 'contact' ? `c:${r.contactId}` : r.kind === 'unknown' ? `u:${r.phone}` : `g:${r.name}`;

// 3 untriaged contacts among 40 open conversations. STARVED on purpose:
// a fixture that fills the page exercises the cheap path and proves nothing.
const CONTACTS: ContactItem[] = [
  { contactId: 'c-unk-1', type: 'unknown', status: 'needs_review', phone: '+15550001001' } as ContactItem,
  { contactId: 'c-unk-2', type: 'unknown', status: 'active', phone: '+15550001002' } as ContactItem,
  { contactId: 'c-unk-3', type: 'unknown', status: 'needs_review', phone: '+15550001003' } as ContactItem,
  ...Array.from({ length: 37 }, (_, i) => ({
    contactId: `c-tenant-${i}`,
    type: 'tenant',
    status: 'onboarding',
    phone: `+1555100${String(i).padStart(4, '0')}`,
  })) as ContactItem[],
];

const CONVERSATIONS: ConversationItem[] = CONTACTS.map((c, i) => ({
  conversationId: `conv-${c.contactId}`,
  type: c.type === 'unknown' ? 'unknown_1to1' : 'tenant_1to1',
  status: 'open',
  participant_phone: c.phone as string,
  participants: [{ contactId: c.contactId, phone: c.phone as string }],
  last_activity_at: `2026-08-${String(1 + (i % 27)).padStart(2, '0')}T12:00:00.000Z`,
})) as ConversationItem[];

function makeDeps(): InboxRouterDeps {
  return {
    conversationsRepo: {
      async listByLastActivity(opts: { status: string; limit?: number; exclusiveStartKey?: Record<string, unknown> }) {
        const sorted = CONVERSATIONS.filter((c) => c.status === opts.status).sort((a, b) =>
          (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? ''),
        );
        const start = opts.exclusiveStartKey === undefined ? 0 : Number(opts.exclusiveStartKey['i'] ?? 0);
        const items = sorted.slice(start, start + (opts.limit ?? 25));
        const next = start + items.length;
        return { items, ...(next < sorted.length ? { lastEvaluatedKey: { i: next } } : {}) };
      },
      async findByParticipantPhone(phone: string) {
        return CONVERSATIONS.filter((c) => c.participant_phone === phone);
      },
      async findByParticipantEmail() {
        return [];
      },
      async getById(conversationId: string) {
        return CONVERSATIONS.find((c) => c.conversationId === conversationId);
      },
    } as unknown as InboxRouterDeps['conversationsRepo'],
    contactsRepo: {
      async findByPhone(phone: string) {
        return CONTACTS.find((c) => c.phone === phone);
      },
      async findByEmail() {
        return undefined;
      },
      async listByType(type: string, opts?: { status?: string }) {
        const items = CONTACTS.filter(
          (c) => c.type === type && (opts?.status === undefined || c.status === opts.status),
        );
        return { items };
      },
      async getManyByIds(ids: string[]) {
        return new Map(CONTACTS.filter((c) => ids.includes(c.contactId)).map((c) => [c.contactId, c]));
      },
    } as unknown as InboxRouterDeps['contactsRepo'],
    messagesRepo: {
      async listByConversation() {
        return { items: [] };
      },
    } as unknown as InboxRouterDeps['messagesRepo'],
    placementsRepo: {
      async getById() {
        return undefined;
      },
    } as unknown as InboxRouterDeps['placementsRepo'],
  };
}

describe('filter=unknown row-set parity (pre-change pin)', () => {
  it('returns exactly the three untriaged contacts, including the `active` one', async () => {
    const page = await aggregateInbox({ filter: 'unknown', limit: 30 }, makeDeps());
    expect(page.rows.map(rowKey).sort()).toEqual(['c:c-unk-1', 'c:c-unk-2', 'c:c-unk-3']);
  });

  it('every returned row carries needsTriage true', async () => {
    const page = await aggregateInbox({ filter: 'unknown', limit: 30 }, makeDeps());
    for (const row of page.rows) expect(row.needsTriage).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and confirm it PASSES against today's code**

Run: `cd app && npx vitest run test/inboxUnknownParity.test.ts`
Expected: PASS. This is a pin on existing behaviour, not a red test. If it fails, the fixture is wrong - fix the fixture, never the assertion.

- [ ] **Step 3: Mutation-probe the pin**

Temporarily change `CONTACTS[1].type` from `'unknown'` to `'tenant'` and re-run. Expected: the first test FAILS with `c:c-unk-2` missing. Revert.

A pin that cannot go red is not a pin. This probe specifically proves the fixture covers the `(unknown, active)` class, which is the class a status-narrowed query would lose.

- [ ] **Step 4: Commit**

```bash
git add app/test/inboxUnknownParity.test.ts
git commit -m "test(inbox): pin the filter=unknown row set on a starved fixture"
```

---

### Task 2: Read-cost pin

**Files:**
- Modify: `app/test/inboxFeed.test.ts` (add `listByType` to `InboxCallCounts`)
- Create: `app/test/inboxUnknownCost.test.ts`

**Interfaces:**
- Consumes: `InboxCallCounts` from `app/test/inboxFeed.test.ts:63`, currently `{ queryUnreadPage, findByPhone, findByParticipantPhone, listByConversation, getPlacementById }`.
- Produces: a cost assertion later tasks must move in the right direction.

- [ ] **Step 1: Extend the call-count type**

In `app/test/inboxFeed.test.ts`, add one field to the interface at line 63 and to `emptyCallCounts()` at line 71:

```typescript
interface InboxCallCounts {
  queryUnreadPage: number;
  findByPhone: number;
  findByParticipantPhone: number;
  listByConversation: number;
  getPlacementById: number;
  listByType: number;
}
```

```typescript
function emptyCallCounts(): InboxCallCounts {
  return {
    queryUnreadPage: 0,
    findByPhone: 0,
    findByParticipantPhone: 0,
    listByConversation: 0,
    getPlacementById: 0,
    listByType: 0,
  };
}
```

- [ ] **Step 2: Write the cost test**

```typescript
// app/test/inboxUnknownCost.test.ts
import { describe, expect, it } from 'vitest';
import { aggregateInbox } from '../src/routes/inbox.js';
// Reuse Task 1's fixture verbatim - same 40 conversations, 3 untriaged - but
// count the reads. Import makeDeps and CONTACTS from the parity test rather
// than re-declaring them, so the two tests can never drift apart.
import { makeCountingDeps, counts } from './inboxUnknownParity.test.js';

describe('filter=unknown read cost on a STARVED filter', () => {
  it('pays no more than one contact read per returned row', async () => {
    counts.reset();
    await aggregateInbox({ filter: 'unknown', limit: 30 }, makeCountingDeps());

    // TODAY this fails: the walk hydrates a contact for all 40 open
    // conversations to return 3 rows. After the contact-side read it passes.
    expect(counts.findByPhone).toBeLessThanOrEqual(3);
  });

  it('reads the triage partition rather than the open partition', async () => {
    counts.reset();
    await aggregateInbox({ filter: 'unknown', limit: 30 }, makeCountingDeps());
    expect(counts.listByType).toBeGreaterThanOrEqual(1);
  });
});
```

Add these exports to `inboxUnknownParity.test.ts` so both tests share ONE
fixture and cannot drift apart:

```typescript
export const counts = {
  findByPhone: 0,
  listByType: 0,
  listByLastActivity: 0,
  reset(): void {
    counts.findByPhone = 0;
    counts.listByType = 0;
    counts.listByLastActivity = 0;
  },
};

export function makeCountingDeps(): InboxRouterDeps {
  const base = makeDeps();
  const convs = base.conversationsRepo as Record<string, unknown>;
  const cts = base.contactsRepo as Record<string, unknown>;
  const wrapConv = convs['listByLastActivity'] as (o: unknown) => Promise<unknown>;
  const wrapPhone = cts['findByPhone'] as (p: string) => Promise<unknown>;
  const wrapType = cts['listByType'] as (t: string, o?: unknown) => Promise<unknown>;
  convs['listByLastActivity'] = async (o: unknown) => {
    counts.listByLastActivity += 1;
    return wrapConv(o);
  };
  cts['findByPhone'] = async (phone: string) => {
    counts.findByPhone += 1;
    return wrapPhone(phone);
  };
  cts['listByType'] = async (t: string, o?: unknown) => {
    counts.listByType += 1;
    return wrapType(t, o);
  };
  return base;
}
```

Export the fixture from that file so Tasks 4 and 6 extend it rather than forking
it: `export function makeDeps`, `export const CONTACTS`, `export const
CONVERSATIONS`, `export const rowKey`. A second copy of this fixture is how the
two tests drift into disagreeing about what the tab shows.

- [ ] **Step 3: Run it and confirm it FAILS**

Run: `cd app && npx vitest run test/inboxUnknownCost.test.ts`
Expected: FAIL - `findByPhone` is 40, not <= 3, and `listByType` is 0.

This is the red test the implementation turns green. Record the actual number in the commit message; it is the before-figure the change is measured against.

- [ ] **Step 4: Commit**

```bash
git add app/test/inboxFeed.test.ts app/test/inboxUnknownCost.test.ts app/test/inboxUnknownParity.test.ts
git commit -m "test(inbox): pin the filter=unknown read cost (currently 40 reads for 3 rows)"
```

---

### Task 3: The contact-side read

**Files:**
- Modify: `app/src/routes/inbox.ts` - add a `filter === 'unknown'` branch that returns BEFORE the open-partition pager (mirror where the `filter=unread` branch returns).

**Interfaces:**
- Consumes: `contacts.listByType(type, opts)` -> `{ items: ContactItem[]; lastEvaluatedKey?: Record<string, unknown> }`; `contactConversations(contact) -> Promise<ConversationItem[]>` (`inbox.ts:634`); `buildContactRow(contact, convs, maxConv, unreadSum, deleted) -> Promise<InboxRow | undefined>` (`inbox.ts:742`); `roleFromContact(contact) -> 'tenant'|'landlord'|'partner'|'unknown'` (`inbox.ts:396`); `newestOf(convs)`; `unreadOf(conv)`.
- Produces: the `filter=unknown` page.

- [ ] **Step 1: Add the branch**

Place it immediately after the `filter=unread` branch returns, before `const rows: InboxRow[] = []`.

```typescript
  if (filter === 'unknown') {
    // Read the TRIAGE QUEUE directly instead of walking every open conversation
    // and hydrating a contact per row (design 2026-08-25). Cost becomes
    // proportional to rows RETURNED rather than to a partition that never
    // shrinks - nothing closes a 1:1 thread.
    //
    // NO status narrowing: a contact created as `unknown` defaults to
    // status 'active', so `status: 'needs_review'` would lose rows by
    // construction. NO excludeOrigin: that exclusion is safe in today.ts only
    // because it is a two-source union, and this read is the only source.
    const TRIAGE_PAGE = 100;
    const TRIAGE_MAX_PAGES = 10;
    const collected: ContactItem[] = [];
    let triageCursor: Record<string, unknown> | undefined;
    let triageTruncated = false;

    for (let page = 0; page < TRIAGE_MAX_PAGES; page += 1) {
      const read = await contacts.listByType('unknown', {
        limit: TRIAGE_PAGE,
        ...(triageCursor === undefined ? {} : { exclusiveStartKey: triageCursor }),
      });
      collected.push(...read.items);
      triageCursor = read.lastEvaluatedKey;
      if (triageCursor === undefined || collected.length >= limit) break;
    }
    // The page budget ran out with rows still behind it. Announce it: the
    // failure this guards is a SHORT BLOCK that reads as "nothing needs
    // triage" - a loud problem turned silent.
    if (triageCursor !== undefined && collected.length < limit) {
      triageTruncated = true;
      log.warn(
        { group: 'inbox:unknown', pages: TRIAGE_MAX_PAGES, found: collected.length },
        'inbox: the untriaged-contacts walk ran out of pages before filling the page - some untriaged contacts are NOT shown',
      );
    }

    const unknownRows: InboxRow[] = [];
    for (const contact of collected) {
      // LIVE role re-check. Replaces the precedent's status re-check, which does
      // not carry over now that the query does not narrow on status. It also
      // keeps the reader correct if a contact is retyped between the Query and
      // the render, and it is the same predicate the row builder uses.
      if (roleFromContact(contact) !== 'unknown') continue;

      // LOCAL catch, deliberately not the shared seam's. `contactConversations`
      // returns [] for BOTH "every thread filtered out" (normal) and "the query
      // threw" (a dropped triage row), so it cannot carry the distinction. A
      // swallowed failure here silently removes someone from a triage queue.
      let convs: ConversationItem[];
      try {
        convs = await contactConversations(contact);
      } catch (err) {
        log.error(
          { err, group: 'inbox:unknown' },
          'inbox: triage thread lookup FAILED - the row is omitted and the queue is under-reporting',
        );
        continue;
      }

      const maxConv = newestOf(convs);
      if (maxConv === undefined) continue; // no open non-relay thread -> no row
      const unreadSum = convs.reduce((sum, c) => sum + unreadOf(c), 0);
      const row = await buildContactRow(contact, convs, maxConv, unreadSum, false);
      if (row !== undefined) unknownRows.push(row);
    }

    // The byTypeStatus partition has no activity dimension - with `status`
    // supplied its range key is a constant - so paging it in activity order is
    // not a construction that exists. Read the whole capped queue, then sort.
    unknownRows.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
    const pageRows = unknownRows.slice(0, limit);

    log.info(
      {
        filter,
        count: pageRows.length,
        triageScanned: collected.length,
        truncated: triageTruncated,
      },
      'inbox feed assembled',
    );
    return {
      rows: pageRows,
      nextCursor: null,
      ...(triageTruncated && { truncated: true as const }),
    };
  }
```

- [ ] **Step 2: Run both pins**

Run: `cd app && npx vitest run test/inboxUnknownParity.test.ts test/inboxUnknownCost.test.ts`
Expected: BOTH PASS. Parity unchanged (same three rows, including the `active` one); cost now `findByPhone <= 3` and `listByType >= 1`.

If parity goes red, the read is losing rows - do not adjust the pin.

- [ ] **Step 3: Run the whole inbox suite for collateral**

Run: `cd app && npx vitest run test/inbox`
Expected: PASS. Any failure here is a surface the design did not enumerate; report it rather than patching the test.

- [ ] **Step 4: Mutation-probe the two guards this task adds**

Probe A - the live role check: change `if (roleFromContact(contact) !== 'unknown') continue;` to `if (false) continue;`, add a `team_member` contact with an open thread to the parity fixture, re-run. Expected: parity FAILS with an extra row. Revert both.

Probe B - the local catch: make the fixture's `findByParticipantPhone` throw for one contact. Expected: that row is absent AND an error is logged. Confirm the log line says the queue is under-reporting, not "best-effort". Revert.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/inbox.ts
git commit -m "feat(inbox): read the Unknown tab from the contacts triage partition"
```

---

### Task 4: Deleted-contact resurfacing

**Files:**
- Modify: `app/src/routes/inbox.ts` - the `filter === 'unknown'` branch from Task 3.

**Interfaces:**
- Consumes: the branch from Task 3; `collectUnreadRows` / the `byUnread` walk this route already uses.
- Produces: resurfaced rows carrying `deleted: true`.

**Why this exists:** the pager RESURFACES a soft-deleted contact while an unread post-deletion inbound exists (2026-08-03 spec), and `listByType` excludes deleted rows by default. Its `deleted` option is a tri-state with no "both", so "all unknown contacts, deleted included" is not expressible in one Query. Prod measured 4 soft-deleted contacts in this partition; without this task they silently stop resurfacing.

- [ ] **Step 1: Write the failing test**

Add to `app/test/inboxUnknownParity.test.ts`:

```typescript
// A soft-deleted unknown contact whose thread carries an unread inbound that
// arrived AFTER deleted_at. listByType excludes it (deleted rows are suppressed
// by default), so only the byUnread path can find it.
const DELETED_CONTACT = {
  contactId: 'c-deleted-1',
  type: 'unknown',
  status: 'needs_review',
  phone: '+15550009001',
  deleted_at: '2026-08-01T00:00:00.000Z',
} as unknown as ContactItem;

const DELETED_CONV = {
  conversationId: 'conv-c-deleted-1',
  type: 'unknown_1to1',
  status: 'open',
  participant_phone: '+15550009001',
  participants: [{ contactId: 'c-deleted-1', phone: '+15550009001' }],
  last_activity_at: '2026-08-20T12:00:00.000Z',
  unread_count: 1,
  unread_flag: 'unread',
} as unknown as ConversationItem;

function makeDepsWithDeletedResurfacing(): InboxRouterDeps {
  const deps = makeDeps();
  const cts = deps.contactsRepo as Record<string, unknown>;
  const convs = deps.conversationsRepo as Record<string, unknown>;
  // listByType must NOT return it - that is the whole point of the task.
  cts['getManyByIds'] = async (ids: string[]) =>
    new Map(ids.includes('c-deleted-1') ? [['c-deleted-1', DELETED_CONTACT]] : []);
  cts['findByPhone'] = async (phone: string) =>
    phone === '+15550009001' ? DELETED_CONTACT : undefined;
  convs['findByParticipantPhone'] = async (phone: string) =>
    phone === '+15550009001' ? [DELETED_CONV] : [];
  convs['queryUnreadPage'] = async () => ({ items: [DELETED_CONV] });
  return deps;
}

it('resurfaces a soft-deleted unknown contact that has an unread post-deletion inbound', async () => {
  const page = await aggregateInbox({ filter: 'unknown', limit: 30 }, makeDepsWithDeletedResurfacing());
  const resurfaced = page.rows.find((r) => r.kind === 'contact' && r.contactId === 'c-deleted-1');
  expect(resurfaced).toBeDefined();
  expect(resurfaced?.deleted).toBe(true);
});
```

- [ ] **Step 2: Run it and confirm it FAILS**

Run: `cd app && npx vitest run test/inboxUnknownParity.test.ts -t resurfaces`
Expected: FAIL - `resurfaced` is undefined, because `listByType` excluded the deleted contact.

- [ ] **Step 3: Implement via `byUnread`, not a second partition walk**

A resurfacing row is UNREAD BY DEFINITION, and this route already consumes the
sparse `byUnread` index - bounded, unlike a second `deleted: true` walk over a
partition that grows forever. Reuse the unread branch's existing budget and
`truncated` contract; do NOT invent a second bound. It is O(all unread), not
O(resurfacing candidates), and arrives with two bounds to honour: `maxRows`
counts all candidates, and the deleted-probe limit reports `truncated`.

Add inside the `filter === 'unknown'` branch, after the `collected` loop and
before the row build, and add each resurfaced contact to `collected` so it flows
through the SAME row-building path (the `deleted` flag is the only difference):

```typescript
    // RESURFACING (2026-08-03 spec). `listByType` suppresses soft-deleted rows
    // and its `deleted` option is a tri-state with no "both", so "all unknown
    // contacts, deleted included" is not one Query. A resurfacing row is unread
    // BY DEFINITION, so the sparse byUnread index is the bounded source.
    const seenIds = new Set(collected.map((c) => c.contactId));
    const resurfaced: ContactItem[] = [];
    const unreadWalk = await collectUnreadRows(
      { conversations, contacts, messages, logger: log },
      // UNREAD_WALK_LIMIT is already imported at inbox.ts:90; the route also
      // honours a `deps.unreadWalkLimit` override so a test can shrink it.
      { maxRows: limit, budget: deps.unreadWalkLimit ?? UNREAD_WALK_LIMIT },
    );
    for (const candidate of unreadWalk.candidates) {
      if (candidate.kind !== 'contact') continue;
      const c = candidate.contact;
      if (seenIds.has(c.contactId)) continue;
      // Only DELETED unknowns belong here: a live unknown already came back
      // from listByType above, and a deleted non-unknown is not a triage row.
      const isDeleted = (c as { deleted_at?: unknown }).deleted_at !== undefined;
      if (!isDeleted || roleFromContact(c) !== 'unknown') continue;
      seenIds.add(c.contactId);
      resurfaced.push(c);
    }
```

Then, in the row-building loop, pass the `deleted` flag through rather than
hardcoding `false`:

```typescript
    for (const contact of [...collected, ...resurfaced]) {
      // ...role check, local catch, maxConv as in Task 3...
      const isDeleted = (contact as { deleted_at?: unknown }).deleted_at !== undefined;
      const row = await buildContactRow(contact, convs, maxConv, unreadSum, isDeleted);
      if (row !== undefined) unknownRows.push(row);
    }
```

`buildContactRow` already owns the resurfacing PREDICATE for a deleted contact
(`inbox.ts:756` onward: surface only while some conversation is unread and its
newest message is an inbound from after the deletion) and returns `undefined`
when it does not hold. Do not re-implement that rule here - passing `deleted`
correctly is the whole job.

- [ ] **Step 4: Run the test to verify it passes, then the suite**

Run: `cd app && npx vitest run test/inboxUnknownParity.test.ts` then `cd app && npx vitest run test/inbox`
Expected: PASS.

- [ ] **Step 5: Mutation-probe**

Remove the resurfacing lookup. Expected: the new test fails. Revert.

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/inbox.ts app/test/inboxUnknownParity.test.ts
git commit -m "feat(inbox): resurface soft-deleted unknowns via byUnread, not a second partition walk"
```

---

### Task 5: Pin `ContactType` exhaustiveness

**Files:**
- Create: `app/test/contactTypeExhaustive.test.ts`

**Why:** `roleFromContact` is a FALL-THROUGH (anything not tenant/landlord/partner is `'unknown'`) while `listByType('unknown')` is an EXACT MATCH. They agree only on the types that exist today. `ContactType` is a closed union with an open plan to extend it, so a new type silently re-creates the bug this design just removed - present on the tab, absent from the query.

- [ ] **Step 1: Write the test**

```typescript
// app/test/contactTypeExhaustive.test.ts
import { describe, expect, it } from 'vitest';
import type { ContactType } from '../src/repos/contactsRepo.js';

// If you are here because you ADDED a ContactType: the Unknown inbox tab reads
// `listByType('unknown')` (an exact match) while `roleFromContact` treats any
// unrecognised type as 'unknown' (a fall-through). A new type is therefore on
// the tab and absent from the query unless you decide otherwise. Decide, then
// update this list.
const KNOWN_TYPES: readonly ContactType[] = ['tenant', 'landlord', 'partner', 'team_member', 'unknown'];

describe('ContactType union', () => {
  it('has not gained a member without the Unknown-tab read being reconsidered', () => {
    expect([...KNOWN_TYPES].sort()).toEqual(
      ['landlord', 'partner', 'team_member', 'tenant', 'unknown'].sort(),
    );
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd app && npx vitest run test/contactTypeExhaustive.test.ts`
Expected: PASS.

- [ ] **Step 3: Mutation-probe**

Add a fake member to `KNOWN_TYPES` and re-run. Expected: FAIL. Revert. (The type annotation also makes an unknown string a compile error, so `npm run typecheck` is the second half of this guard.)

- [ ] **Step 4: Commit**

```bash
git add app/test/contactTypeExhaustive.test.ts
git commit -m "test(contacts): pin the ContactType union against silent Unknown-tab drift"
```

---

### Task 6: Pin the remaining coverage classes

**Files:**
- Modify: `app/test/inboxUnknownParity.test.ts`

**Why:** the design enumerates seven coverage classes and its testing section
requires each be pinned. Tasks 1, 4 and 5 cover (f), (d) and (g). Classes (a),
(b), (c) and (e) are currently covered only by mutation probes during a build,
and those vanish when the build ends. Every one of them is a row that quietly
stops appearing - the failure this whole design is organised around.

**Interfaces:**
- Consumes: `makeDeps`, `CONTACTS`, `rowKey` from Task 1 (exported there).

- [ ] **Step 1: Write the class tests**

```typescript
describe('filter=unknown coverage classes', () => {
  // (a) A group-detection stub with NO 1:1 thread yields no row - WITHOUT
  // needing excludeOrigin to achieve it. That is precisely why the exclusion is
  // not copied: a stub that LATER TEXTS has a thread and SHOULD appear.
  it('(a) a threadless group-detection stub yields no row', async () => {
    const deps = makeDeps();
    const cts = deps.contactsRepo as Record<string, unknown>;
    const stub = { contactId: 'c-stub', type: 'unknown', status: 'needs_review',
      origin: 'group_detection' } as unknown as ContactItem;
    cts['listByType'] = async () => ({ items: [stub] });
    const page = await aggregateInbox({ filter: 'unknown', limit: 30 }, deps);
    expect(page.rows.map(rowKey)).not.toContain('c:c-stub');
  });

  it('(a) a group-detection stub that LATER TEXTED does yield a row', async () => {
    const deps = makeDeps();
    const cts = deps.contactsRepo as Record<string, unknown>;
    const convs = deps.conversationsRepo as Record<string, unknown>;
    const texted = { contactId: 'c-stub-texted', type: 'unknown', status: 'needs_review',
      origin: 'group_detection', phone: '+15550007777' } as unknown as ContactItem;
    const conv = { conversationId: 'conv-stub-texted', type: 'unknown_1to1', status: 'open',
      participant_phone: '+15550007777',
      participants: [{ contactId: 'c-stub-texted', phone: '+15550007777' }],
      last_activity_at: '2026-08-24T12:00:00.000Z' } as unknown as ConversationItem;
    cts['listByType'] = async () => ({ items: [texted] });
    convs['findByParticipantPhone'] = async (ph: string) => (ph === '+15550007777' ? [conv] : []);
    const page = await aggregateInbox({ filter: 'unknown', limit: 30 }, deps);
    expect(page.rows.map(rowKey)).toContain('c:c-stub-texted');
  });

  // (b) A contact whose only thread is a relay group yields no row.
  it('(b) a contact whose only thread is a relay group yields no row', async () => {
    const deps = makeDeps();
    const cts = deps.contactsRepo as Record<string, unknown>;
    const convs = deps.conversationsRepo as Record<string, unknown>;
    const relayOnly = { contactId: 'c-relay', type: 'unknown', status: 'needs_review',
      phone: '+15550008888' } as unknown as ContactItem;
    const relayConv = { conversationId: 'conv-relay', type: 'relay_group', status: 'open',
      participant_phone: '+15550008888',
      participants: [{ contactId: 'c-relay', phone: '+15550008888' }],
      last_activity_at: '2026-08-24T12:00:00.000Z' } as unknown as ConversationItem;
    cts['listByType'] = async () => ({ items: [relayOnly] });
    convs['findByParticipantPhone'] = async () => [relayConv];
    const page = await aggregateInbox({ filter: 'unknown', limit: 30 }, deps);
    expect(page.rows.map(rowKey)).not.toContain('c:c-relay');
  });

  // (c) team_member is INTERNAL STAFF and does not belong in a triage queue
  // (founder ruling 2026-08-25). roleFromContact falls it through to 'unknown',
  // so today's walk shows it and the contact-side read must not.
  it('(c) a team_member contact never appears', async () => {
    const deps = makeDeps();
    const cts = deps.contactsRepo as Record<string, unknown>;
    const staff = { contactId: 'c-staff', type: 'team_member', status: 'active',
      phone: '+15550006666' } as unknown as ContactItem;
    cts['listByType'] = async (t: string) => ({ items: t === 'unknown' ? [] : [staff] });
    const page = await aggregateInbox({ filter: 'unknown', limit: 30 }, deps);
    expect(page.rows.map(rowKey)).not.toContain('c:c-staff');
  });

  // (e) A conversation with a phone and NO contact is ACCEPTED AS LOST from this
  // tab by design - it stays visible on `all`, which keeps the pager. Pinned so
  // the loss stays a DECISION rather than becoming a surprise.
  it('(e) a contactless conversation does not appear on the triage tab', async () => {
    const deps = makeDeps();
    const convs = deps.conversationsRepo as Record<string, unknown>;
    const orphan = { conversationId: 'conv-orphan', type: 'unknown_1to1', status: 'open',
      participant_phone: '+15550005555',
      last_activity_at: '2026-08-24T12:00:00.000Z' } as unknown as ConversationItem;
    const prev = convs['listByLastActivity'] as (o: unknown) => Promise<{ items: ConversationItem[] }>;
    convs['listByLastActivity'] = async (o: unknown) => {
      const page = await prev(o);
      return { ...page, items: [orphan, ...page.items] };
    };
    const page = await aggregateInbox({ filter: 'unknown', limit: 30 }, deps);
    expect(page.rows.map(rowKey)).not.toContain('u:+15550005555');
  });
});
```

- [ ] **Step 2: Run them**

Run: `cd app && npx vitest run test/inboxUnknownParity.test.ts`
Expected: PASS, every class.

If `(a) a group-detection stub that LATER TEXTED` fails, someone copied
`excludeOrigin` - the blocker the design spends a whole section on.

- [ ] **Step 3: Mutation-probe the two that can silently invert**

Probe (c): remove the `roleFromContact(contact) !== 'unknown'` guard from Task 3
and have `listByType('unknown')` return the staff contact. Expected: the
team_member test FAILS. Revert.

Probe (a): add `excludeOrigin: GROUP_DETECTION_ORIGIN` to the `listByType` call.
Expected: the LATER TEXTED test FAILS. Revert. This is the cheapest available
guard against the design's headline mistake being re-made by a future reader who
finds `today.ts` first.

- [ ] **Step 4: Commit**

```bash
git add app/test/inboxUnknownParity.test.ts
git commit -m "test(inbox): pin the Unknown-tab coverage classes a, b, c and e"
```

---

### Task 7: The empty state must not read as a failure

**Files:**
- Modify: `dashboard/src/routes/inbox/Inbox.tsx` - the failure banner at the `serverEndedEarlyEmpty` / error arm.

**Why:** a CLEARED triage queue is the NORMAL zero-row state for this tab, and the inbox failure banner is not filter-gated. Getting this wrong reproduces the precedent's own worst outcome: a surface that says nothing needs attention when it simply could not tell.

- [ ] **Step 1: Write the failing test**

```typescript
it('an empty Unknown tab shows the empty state, not the failure banner', () => {
  renderInbox({ filter: 'unknown', status: 'ready', rows: [], serverRowCount: 0 });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText(/nothing needs triage/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it and confirm it FAILS**

Run: `cd dashboard && npx vitest run src/routes/inbox/Inbox.test.tsx -t "empty Unknown tab"`
Expected: FAIL - the banner renders.

- [ ] **Step 3: Gate the banner on the filter**

`Inbox.tsx` renders the failure banner on a zero-row ready page without checking
which tab is showing. The Unknown tab's normal state is zero rows, so gate it:

```tsx
{/* A cleared triage queue is the NORMAL zero-row state for this tab, so the
    "we could not load your inbox" banner must not fire on it. The banner
    exists for a page that ended early with nothing, which the contact-side
    read cannot produce. */}
{inbox.status === 'ready' && inbox.rows.length === 0 && filter === 'unknown' ? (
  <p className="inbox-empty">{t('inbox.unknown.empty')}</p>
) : (
  existingEmptyOrErrorBranch
)}
```

Add the copy through the message catalog rather than inline - repo rule: new
automated user-facing copy goes through the catalog. Register
`inbox.unknown.empty` with the text "Nothing needs triage right now." and read
it through the catalog helper the dashboard already uses for inbox copy.

- [ ] **Step 4: Run to verify, then mutation-probe**

Remove the filter gate. Expected: the test fails. Revert.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/routes/inbox/Inbox.tsx dashboard/src/routes/inbox/Inbox.test.tsx
git commit -m "fix(inbox): an empty triage queue is not a failure"
```

---

### Task 8: Gates and handback

- [ ] **Step 1: Sync main once**

```bash
git merge main --no-edit
```

- [ ] **Step 2: Run all five gates BARE, capturing output**

```bash
npm run typecheck
npm test
npm run smoke
npm run e2e
npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')
```

Never pipe them. `npm run e2e` takes ~20 minutes - run it in the background and read the verdict from the LOG, not from a wrapper's exit code. Never commit while it runs.

- [ ] **Step 3: Re-measure against real data**

Ask the human to run, and record the result in the handback:

```
npx tsx app/scripts/measure-unread-contact-coverage.ts --confirm --audit-tab-vs-partition --no-status-narrow
```

Expected: SETS RECONCILE (dev) and RECONCILE WITH ONE REQUIREMENT (prod). A new unexplained loss means the build dropped a class.

- [ ] **Step 4: Handback**

Report bare gate exit codes, the before/after read counts from Task 2, and any coverage class whose behaviour changed.

---

## Out of scope

- **The budget + cursor + `truncated` safety net** on the remaining open-partition pager (design section 5). It carries its own gate - as specified it would light the unfiltered inbox failure banner on an empty All page - and it is not needed to close this issue.
- [`today-shows-phone-instead-of-name`](../../issues/today-shows-phone-instead-of-name.md) and [`group-roster-name-snapshot-never-refreshed`](../../issues/group-roster-name-snapshot-never-refreshed.md) - found during this work, both their own defects.
- Retyping stale `conv.type` rows. Nothing in this design reads that field.
