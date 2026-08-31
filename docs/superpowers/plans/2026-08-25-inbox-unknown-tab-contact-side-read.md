<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-08-27).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Inbox Unknown Tab: Contact-Side Read - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Unknown inbox tab's full open-partition walk (~684 contact
lookups across 24 Queries for at most 8 rows in prod) with a bounded read of the
`type=unknown` contact partition, plus a byUnread sweep for deleted-contact
resurfacing, so cost is proportional to the unread set and the rows RETURNED
instead of to an open partition that never shrinks.

**Architecture:** A new `filter === 'unknown'` branch in `aggregateInbox`
(`app/src/routes/inbox.ts`) returns before the open-partition pager, exactly as
the `groups` and `unread` branches already do. It reads the whole capped
`(type='unknown')` byTypeStatus partition through a new module-level collector
(`app/src/lib/unknownQueue.ts` - fill loop, result cap, truncation WARN, and a
type list DERIVED from the exhaustive per-ContactType decision map so the map is
load-bearing, not decorative), does a live type re-check per contact, resolves
each contact's open non-relay threads by calling `conversationsForContact`
DIRECTLY (so "query threw" and "filtered to nothing" are different code paths),
builds rows with the existing `buildContactRow` closure, folds in soft-deleted
resurfacing candidates from one `collectUnreadRows` sweep (budget-bounded, with
BOTH of the collector's early-stop flags - `capped` masks `truncated` - detected
and reported), sorts in memory, and returns a single page (`nextCursor: null`,
never the `truncated` wire flag).

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
- Do not modify `app/test/helpers/twilioWebhookHarness.ts`. Its `listByType`
  fake (line 1684) applies the soft-delete filter BEFORE `Limit` (unfaithful on
  that axis) and returns `lastEvaluatedKey` on "rows remain" rather than "Limit
  reached" (unfaithful on that axis too) - but it backs the `today.ts` triage
  suite, whose fill-loop pins are calibrated against those semantics, and
  re-ordering it moves pins in a suite this branch has no business touching.
  ACCEPTED CONSEQUENCES, stated so nobody rediscovers them: `inboxApi.test.ts`
  exercises the new branch through this unfaithful fake, so the route-level
  tests cannot produce the short-page-with-LEK shape; and the harness has no
  sparse-status filter either, so a status-less `type='unknown'` contact is
  VISIBLE through the route suite and INVISIBLE through the Task 1 helper -
  two suites, same input, opposite answers, with production siding with the
  helper. Task 4 covers the collector against the faithful helper and Task 6
  covers the real index.

## Out of scope (deliberately deferred)

- **Spec section 5's open-partition safety net** (a raw-scan budget + cursor +
  `truncated` contract for the `filter=all` pager) is DEFERRED by human ruling
  2026-08-25 - deferred, not dropped. Both plan reviewers showed that building
  it now ships section 5's own named gate unsolved: the spec says the banner
  problem "must be solved first", and a budget-stopped ZERO-ROW `filter=all`
  page carrying `truncated` hits the dashboard's non-filter-gated failure gate
  (`serverEndedEarlyEmpty = serverRowCount === 0 && truncated`, `Inbox.tsx:42`,
  banner at `:183`) and renders "We couldn't load your inbox." on an org where
  nothing failed. Whoever picks it up must solve that banner gate FIRST, and
  should know two traps found in review: the empty-page invariant nulls the
  cursor, so "Load more" cannot be the affordance in exactly that state; and
  replacing the pager loop's tail leaves the `moreChunks` binding at
  `inbox.ts:1481` unused (its only reader is the tail at `:1522`), which is a
  gate-5 `no-unused-vars` error unless the binding is deleted too. Task 9
  records the deferral in the issue registry.

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
  after its resurfacing probe passes), `truncated`, `capped`, `remainingBudget`,
  `deletedProbes`, `wastedProbes`, `skippedDeletedThreads`.
  `UNREAD_WALK_LIMIT` is 2000. CRITICAL FLAG SEMANTICS (`unreadFeed.ts:695-709`):
  `truncated = !capped && !state.scanExhausted` - so `capped` (the `maxRows`
  stop, set at `:674-677` counting ALL candidate kinds) MASKS `truncated`. Any
  caller that treats `truncated` alone as "the answer is a floor" is blind to
  the cap stop; both flags are floor signals.
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
- Test-fake LEK rule, pinned by the sibling helper this repo already ships
  (`app/test/helpers/unreadIndexFake.ts:104-116` and `:180-187`): DynamoDB
  returns `LastEvaluatedKey` whenever the page REACHED the Limit - "Limit
  reached", NOT "rows remain" - so a walk over exactly n * limit rows costs one
  MORE round trip than items-remaining modelling suggests, and call-count pins
  calibrated against the weaker model are one Query short of production. The
  webhook harness's `listByType` (`twilioWebhookHarness.ts:1707`) carries the
  items-remaining defect; the Task 1 helper must NOT copy it.
- `byTypeStatus` is `hash: type, range: status` (`app/src/lib/tables.ts:90-93`)
  and `ContactItem.status` is OPTIONAL - a GSI does not index an item missing a
  key attribute, so a status-less `type='unknown'` contact is invisible to
  `listByType` entirely. Every current write path sets a status
  (`contactCapture.ts:79-81`, `groupMembers.ts:111-112`, `groupConvert.ts:339-340`,
  `routes/contacts.ts:881-884`, `lib/import/apply.ts:884-899`), so this is a
  fake-fidelity rule, not a shipping defect.

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
//   1. The GSI is SPARSE: byTypeStatus is (hash: type, range: status), and an
//      item missing a key attribute is not indexed - a status-less contact is
//      invisible here no matter its type (lib/tables.ts:90-93).
//   2. The partition is (type, optional status) - both are KEY conditions,
//      applied before paging.
//   3. `Limit` slices the page NEXT, from exclusiveStartKey.
//   4. The FilterExpressions - the soft-delete scope and `excludeOrigin` -
//      apply to the PAGE, so a filtered-out row still spends its page slot and
//      a short (even EMPTY) page can carry a lastEvaluatedKey.
//   5. `lastEvaluatedKey` is returned whenever the page REACHED the Limit -
//      "Limit reached", NOT "rows remain". That is the service's rule (see
//      helpers/unreadIndexFake.ts:104-116, which documents and guards this
//      exact trap): a walk over exactly n * limit rows costs one MORE round
//      trip than items-remaining modelling suggests, and call-count pins built
//      on the weaker model are one Query short of production.
//
// FAKE-ONLY CAVEAT on rule 5: `limit ?? 50` SYNTHESIZES a Limit for a caller
// that passes none, so an un-limited call over a partition of exactly 50+ rows
// reports "Limit reached" and mints a LEK where the real repo omits `Limit`
// entirely and pages at 1MB. Inert for every current caller (the collector
// always passes pageSize); pass an explicit `limit` in any new test that
// walks a partition of 50 or more.
// A fake that filters before slicing can never exercise the fill loop the
// unknown-queue read carries (docs/superpowers/specs/
// 2026-08-25-inbox-unknown-tab-walk-design.md, section 3 class d), and a fake
// that ignores `status`/`excludeOrigin` makes the "no narrowing" mutation
// probes vacuous. The webhook harness's own fake keeps its historical
// deleted-before-limit, items-remaining shape for the suites calibrated
// against it (the today.ts triage pins); new tests use this one.
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
    // SPARSE index: no range-key attribute, no index entry (rule 1).
    .filter((c) => c.status !== undefined)
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
  // LIMIT REACHED, not "rows remain" (rule 5): the service stops at the Limit
  // and hands back the position; the caller must ask again to learn the
  // stream ended.
  const limitReached = page.length === limit;
  return {
    items: filtered,
    ...(limitReached && last !== undefined && { lastEvaluatedKey: { contactId: last.contactId } }),
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

  it('LEK means "Limit reached", not "rows remain": an exact-multiple partition costs one extra empty page', () => {
    // The service's rule (unreadIndexFake.ts:104-116): a page that reached the
    // Limit hands back a key even when it was also the end - the caller pays
    // one more Query to learn the stream ended. An items-remaining fake makes
    // every call-count pin one Query short of production.
    const seed = [c({ contactId: 'a' }), c({ contactId: 'b' })];
    const page1 = listByTypeFromContacts(seed, 'unknown', { limit: 2 });
    expect(page1.items.map((x) => x.contactId)).toEqual(['a', 'b']);
    expect(page1.lastEvaluatedKey).toEqual({ contactId: 'b' });
    const page2 = listByTypeFromContacts(seed, 'unknown', {
      limit: 2,
      exclusiveStartKey: page1.lastEvaluatedKey!,
    });
    expect(page2.items).toEqual([]);
    expect(page2.lastEvaluatedKey).toBeUndefined();
  });

  it('the GSI is sparse: a status-less contact is not indexed at all', () => {
    const statusless: ContactItem = { contactId: 'no-status', type: 'unknown' };
    const seed = [statusless, c({ contactId: 'indexed' })];
    expect(listByTypeFromContacts(seed, 'unknown', {}).items.map((x) => x.contactId)).toEqual(['indexed']);
  });
});
```

- [ ] **Step 3: Run the test, see it pass** (the helper is written first here
  because the suite pins an already-written pure function; there is no
  meaningful red state for a new pure helper plus its pins)

Run: `cd W:\tmp\inbox-unread-cluster\app; npx vitest run test/contactsPartitionFake.test.ts`
Expected: 7 passed.

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

- [ ] **Step 3: fix EVERY whole-object call assertion - find them by grep, not by this list**

Run `rg -n "expect\(calls\).toEqual" app/test/inboxFeed.test.ts` and update
every hit. As of this writing there are FOUR - ~lines 647-653, 727-733,
759-765, 800-807 (the first one's own comment says why it is whole-object: "so
a future read cannot slip in unnoticed") - but the grep is the authority; a
line list in a plan goes stale. Each literal now needs the two new zero fields:
add `listByType: 0, listByLastActivity: <n>`, where `<n>` is what the run in
Step 5 reports (the unread-filter tests never touch the pager, so expect 0
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
    and the DERIVED `UNKNOWN_QUEUE_TYPES: readonly ContactType[]` (what the
    collector queries and the sweep admits - the map is load-bearing through it)
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
  UNKNOWN_QUEUE_TYPES,
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
  const calls: Array<{ type: ContactType } & ListContactsOpts> = [];
  const warn = vi.fn();
  const deps = {
    contacts: {
      async listByType(type: ContactType, opts: ListContactsOpts = {}) {
        calls.push({ type, ...opts });
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
    // THE MAP DRIVES THE READ: the queried partitions are exactly
    // UNKNOWN_QUEUE_TYPES, which is derived from UNKNOWN_TAB_TYPE_DECISIONS -
    // flipping a type to 'queried' in the map changes this pin, which is what
    // makes the exhaustiveness guard load-bearing rather than decorative.
    expect(calls.map((c) => c.type)).toEqual([...UNKNOWN_QUEUE_TYPES]);
    // THE PROBES. The fake honors these options, so re-adding either narrow
    // (spec section 3, classes a and f) empties the row set above AND flips
    // these pins.
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
    // FOUR pages, not three: page 3 returns the last two live rows AT the
    // Limit, so the service hands back a key and page 4 is the empty read that
    // proves the stream ended (the LEK rule, unreadIndexFake.ts:104-116). An
    // items-remaining fake would report 3 here and calibrate the suite one
    // round trip short of production.
    expect(result.pagesWalked).toBe(4);
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

  it('a partition that drains BELOW the page size is not truncated (no false WARN)', async () => {
    const seed = Array.from({ length: 4 }, (_, i) => unk(i + 1));
    const { deps, warn } = makeDeps(seed);
    const result = await collectUnknownTriageQueue(deps, { pageSize: 5, maxPages: 10, maxRows: 4 });
    expect(result.contacts).toHaveLength(4);
    expect(result.truncated).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('an EXACT page-multiple partition that fills the cap is CONSERVATIVELY truncated - the LEK in hand makes "nothing behind it" unknowable', async () => {
    // Page 1 returns all 4 rows AT the Limit, so the service hands back a key;
    // the cap is also full, so the collector stops without paying the extra
    // Query that would prove emptiness. It reports a floor that happens to be
    // exact - the accepted trade (UnknownQueueResult.truncated doc). A fake
    // returning no LEK here would pin the OPPOSITE of production behaviour.
    const seed = Array.from({ length: 4 }, (_, i) => unk(i + 1));
    const { deps, warn } = makeDeps(seed);
    const result = await collectUnknownTriageQueue(deps, { pageSize: 4, maxPages: 10, maxRows: 4 });
    expect(result.contacts).toHaveLength(4);
    expect(result.truncated).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('production constants are named and sane', () => {
    expect(UNKNOWN_QUEUE_PAGE_SIZE).toBe(100);
    expect(UNKNOWN_QUEUE_MAX_PAGES).toBe(10);
    expect(UNKNOWN_QUEUE_MAX_ROWS).toBe(200);
  });

  it('class g: every ContactType has a recorded tab decision, only unknown is queried, and the derived type list agrees', () => {
    // The compile-time `satisfies Record<ContactType, ...>` on the map is the
    // decision guard: adding a ContactType member without deciding its tab
    // fate is a typecheck failure. UNKNOWN_QUEUE_TYPES is the ENFORCEMENT: it
    // is derived from the map and is what the collector queries (pinned by the
    // calls assertion in the first test) and what the resurfacing sweep
    // admits, so the decision and the behaviour cannot drift apart.
    const queried = (Object.entries(UNKNOWN_TAB_TYPE_DECISIONS) as [ContactType, string][])
      .filter(([, decision]) => decision === 'queried')
      .map(([type]) => type);
    expect(queried).toEqual(['unknown']);
    expect([...UNKNOWN_QUEUE_TYPES]).toEqual(queried);
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
 * AND IT IS LOAD-BEARING, not a decoration: `UNKNOWN_QUEUE_TYPES` below is
 * DERIVED from it and is what the collector queries and what the resurfacing
 * sweep admits - so a type mapped 'queried' here IS queried, and a decorative
 * drift between the map and the behaviour cannot exist.
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

/** The partitions the triage queue reads - derived, never hand-listed. */
export const UNKNOWN_QUEUE_TYPES: readonly ContactType[] = (
  Object.entries(UNKNOWN_TAB_TYPE_DECISIONS) as [ContactType, 'queried' | 'excluded'][]
)
  .filter(([, decision]) => decision === 'queried')
  .map(([type]) => type);

export interface UnknownQueueResult {
  /**
   * At most `maxRows` live (non-deleted) queue contacts, in PARTITION order -
   * this index has NO activity dimension (its range key is `status`), so when
   * the cap or the page budget cuts this list, the cut is ARBITRARY with
   * respect to recency: the newest untriaged contact can be among the hidden
   * rows. The caller's newest-first sort orders only what survived the cut.
   */
  contacts: ContactItem[];
  pagesWalked: number;
  /**
   * Rows may remain behind this result: the page budget ran out with a
   * lastEvaluatedKey still in hand, or the result cap cut the collection.
   * CONSERVATIVE at exact page multiples: the service returns a LEK whenever
   * the Limit was reached, so a partition of exactly n * pageSize rows ends
   * with a key in hand and "nothing behind it" is unknowable without paying
   * another Query - a spurious floor claim is accepted over that cost.
   * Already WARNed here; the caller decides nothing else.
   */
  truncated: boolean;
}

/**
 * LOUD BY CONTRACT: this collector does not catch. inbox.ts's norm is
 * best-effort hydration, but a failed triage-partition Query must NOT degrade
 * to an empty queue - "no unknown contacts" and "the query broke" would be
 * indistinguishable, and the failure mode is the entire triage queue silently
 * vanishing behind a healthy-looking empty state. Same posture, same reason as
 * the inbox group source (inbox.ts readGroupSource); the route's 500 is the
 * honest answer.
 */
export async function collectUnknownTriageQueue(
  deps: { contacts: Pick<ContactsRepo, 'listByType'>; logger?: Logger },
  opts: { pageSize: number; maxPages: number; maxRows: number },
): Promise<UnknownQueueResult> {
  const log = deps.logger ?? defaultLogger;
  const collected: ContactItem[] = [];
  // NOTE on the multi-partition generality (round-3 review): with exactly one
  // 'queried' type in the map today, the second-partition path below is
  // UNEXERCISED - no test drives it, and the cap-with-types-remaining guard is
  // dead code until a second type is mapped. Whoever maps one must also know:
  // `maxPages` bounds EACH partition's walk, so the total read ceiling becomes
  // types.length * maxPages * pageSize, while `pagesWalked` (and the WARN's
  // `pages` field) is the REQUEST total across partitions - a request total
  // reported against a per-partition bound. Add a two-type test then.
  let pagesWalked = 0;
  let exhaustedAll = true;
  const types = [...UNKNOWN_QUEUE_TYPES];
  for (let t = 0; t < types.length; t += 1) {
    let exclusiveStartKey: Record<string, unknown> | undefined;
    let exhausted = false;
    // `maxPages` bounds each PARTITION's walk (one partition exists today).
    for (let page = 0; page < opts.maxPages; page += 1) {
      pagesWalked += 1;
      const read = await deps.contacts.listByType(types[t]!, {
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
    if (!exhausted) exhaustedAll = false;
    if (collected.length >= opts.maxRows) {
      // Cap hit with partitions still unvisited -> rows remain by definition.
      if (t < types.length - 1) exhaustedAll = false;
      break;
    }
  }
  const contacts = collected.slice(0, opts.maxRows);
  const truncated = !exhaustedAll || contacts.length < collected.length;
  if (truncated) {
    // The precedent's WARN (today.ts:884-889): counts only, no PII. The copy
    // names the ordering caveat because the operator-facing list LOOKS
    // newest-first while the hidden rows were chosen by index order.
    log.warn(
      { pages: pagesWalked, kept: contacts.length, collected: collected.length },
      'inbox: the unknown-queue walk ended with untriaged contacts still behind it - the cut is in index order, so the newest untriaged contact may be among the hidden rows',
    );
  }
  return { contacts, pagesWalked, truncated };
}
```

- [ ] **Step 4: Run, see it pass**

Run: `cd W:\tmp\inbox-unread-cluster\app; npx vitest run test/unknownQueue.test.ts`
Expected: 8 passed.

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
  `UNKNOWN_QUEUE_MAX_PAGES`, `UNKNOWN_QUEUE_MAX_ROWS`, `UNKNOWN_QUEUE_TYPES`
  from `app/src/lib/unknownQueue.js` (Task 4); existing in-file closures
  `buildContactRow`, `newestOf`, `unreadOf`, `dropped`, `drops`,
  `roleFromContact`; existing imports `conversationsForContact`,
  `collectUnreadRows`, `UNREAD_WALK_LIMIT`, `warnDeletedProbes`,
  `warnUnreadScanned`, `isDeleted`.
- Produces: the new wire behavior (single page, `nextCursor: null`, no
  `truncated` key, cursor -> 400) and four test seams on `InboxRouterDeps`:
  `unknownQueuePageSize?: number`, `unknownQueueMaxPages?: number`,
  `unknownQueueMaxRows?: number`, `unknownSweepBudget?: number` (the sweep's
  own seam, so unread-branch tests that shrink `unreadWalkLimit` can never
  silently reshape the Unknown tab). Task 6 and the e2e task rely on the wire
  behavior.

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
  listByConversation: number;
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
    listByConversation: 0,
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
  seams?: Pick<
    InboxRouterDeps,
    'unknownQueueMaxRows' | 'unknownQueueMaxPages' | 'unknownQueuePageSize' | 'unknownSweepBudget'
  >,
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
        calls.listByConversation += 1;
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

  it('a cap-cut queue: single page, no truncated key, WARNed - and the cut is INDEX order, so the newest rows can be the hidden ones', async () => {
    // Partition order here is contactId order (c-u0..c-u3) while activity
    // order is the REVERSE (c-u3 newest). The collector cap keeps the first
    // maxRows in PARTITION order - the byTypeStatus range key is `status`,
    // which has no recency dimension - so the two NEWEST contacts are exactly
    // the hidden ones, and the rendered list is "newest-first of what
    // survived", NOT "the newest of the queue". This is the documented,
    // deliberate limitation of cap-plus-WARN (spec requirement 2); the WARN
    // copy names it, and this pin is what keeps anyone from quietly claiming
    // otherwise.
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
        last_activity_at: `2026-06-12T0${i}:00:00.000Z`, // c-u3 is the newest
      }),
    );
    const warn = vi.fn();
    const page = await aggregateInbox(
      { filter: 'unknown', limit: 30 },
      makeDeps({ contacts, conversations }, emptyCalls(), { info: vi.fn(), warn }, { unknownQueueMaxRows: 2 }),
    );
    // Kept: c-u0 and c-u1 (partition order), then sorted newest-first.
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-u1', 'c-u0']);
    expect(page.nextCursor).toBeNull();
    // The wire flag belongs to the unread branch (InboxPage.truncated) - and
    // an empty page carrying it renders the dashboard FAILURE banner on a tab
    // whose normal state is an empty queue (requirement 5).
    expect('truncated' in page).toBe(false);
    expect('groupsTruncated' in page).toBe(false);
    // The collector's WARN is the truncation signal, and its copy carries the
    // index-order caveat.
    expect(
      warn.mock.calls.some((c) => String(c[1]).includes('untriaged contacts still behind it')),
    ).toBe(true);
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

  it('a CAPPED sweep is a floor and says so - capped MASKS truncated in CollectResult, so the branch must read both flags', async () => {
    // The sweep pins maxRows to its budget (requirement 3: no second bound),
    // so shrinking the seam makes the CAP the stop: two visible unread
    // candidates fill maxRows before the third index item - the deleted
    // unknown - is ever scanned. collectUnreadRows then returns capped: true
    // and truncated: FALSE (truncated = !capped && !scanExhausted,
    // unreadFeed.ts) - a branch that reads only `truncated` is silent here,
    // and the class-(d) row vanishes with no trace. That silence is the
    // round-2 blocking finding; this probe goes red if the `|| capped` is
    // ever dropped.
    const seed: Seed = {
      contacts: [
        { contactId: 'c-t1', type: 'tenant', phone: '+15550002800' },
        { contactId: 'c-t2', type: 'tenant', phone: '+15550002801' },
        { contactId: 'c-del', type: 'unknown', status: 'needs_review', phone: '+15550002802', deleted_at: '2026-06-10T00:00:00.000Z' },
      ],
      conversations: [
        conv({ conversationId: 'cv-t1', type: 'tenant_1to1', participant_phone: '+15550002800', last_activity_at: '2026-06-12T12:00:00.000Z', unread_count: 1 }),
        conv({ conversationId: 'cv-t2', type: 'tenant_1to1', participant_phone: '+15550002801', last_activity_at: '2026-06-12T11:00:00.000Z', unread_count: 1 }),
        conv({ conversationId: 'cv-del', participant_phone: '+15550002802', last_activity_at: '2026-06-12T10:00:00.000Z', unread_count: 1 }),
      ],
      latestMessage: {
        'cv-del': { type: 'sms', direction: 'inbound', body: 'hello?', created_at: '2026-06-12T10:00:00.000Z' },
      },
    };
    const info = vi.fn();
    const warn = vi.fn();
    const page = await aggregateInbox(
      { filter: 'unknown', limit: 25 },
      makeDeps(seed, emptyCalls(), { info, warn }, { unknownSweepBudget: 2 }),
    );
    // The deleted unknown sits past the cap: it does NOT resurface this page.
    expect(page.rows).toEqual([]);
    // ...but that is REPORTED, never silent: the floor WARN fires and names
    // the cap as the stop.
    const floorWarn = warn.mock.calls.find((c) =>
      String(c[1]).includes('resurfacing sweep stopped early'),
    );
    expect(floorWarn?.[0]).toMatchObject({ capped: true });
    const assembled = info.mock.calls.find((c) => c[1] === 'inbox feed assembled')?.[0];
    expect(assembled?.resurfaceCapped).toBe(true);
  });

  it('a failed triage-partition Query is LOUD: the branch propagates (route 500), never an empty queue impersonating health', async () => {
    // The module norm is best-effort, but "no unknown contacts" and "the
    // query broke" must not be indistinguishable - the failure mode is the
    // whole triage queue silently vanishing behind a healthy empty state.
    // Same posture, same reason as the group source (inbox.ts
    // readGroupSource).
    const seed: Seed = {
      contacts: [],
      conversations: [],
      listByTypeOverride: () => {
        throw new Error('byTypeStatus unavailable');
      },
    };
    await expect(
      aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps(seed)),
    ).rejects.toThrow('byTypeStatus unavailable');
  });

  it('THE READ THAT SHIPS: one partition Query plus a byUnread sweep whose contact reads scale with the VISIBLE UNREAD set', async () => {
    // The starved pin above zeroes the unread index to isolate the queue
    // read; this one prices the whole configuration production runs - the
    // spec-accepted O(all unread) sweep included (requirement 3) - so the
    // branch's cost claim is on the record, not assumed. Fixture: one live
    // queue row (no unread), two unread tenant threads, one deleted unknown
    // with a fresh post-deletion inbound.
    const seed: Seed = {
      contacts: [
        { contactId: 'c-unk', type: 'unknown', status: 'needs_review', phone: '+15550002900' },
        { contactId: 'c-t1', type: 'tenant', phone: '+15550002901' },
        { contactId: 'c-t2', type: 'tenant', phone: '+15550002902' },
        { contactId: 'c-del', type: 'unknown', status: 'needs_review', phone: '+15550002903', deleted_at: '2026-06-10T00:00:00.000Z' },
      ],
      conversations: [
        conv({ conversationId: 'cv-q', participant_phone: '+15550002900', last_activity_at: '2026-06-12T13:00:00.000Z' }),
        conv({ conversationId: 'cv-t1', type: 'tenant_1to1', participant_phone: '+15550002901', last_activity_at: '2026-06-12T12:00:00.000Z', unread_count: 1 }),
        conv({ conversationId: 'cv-t2', type: 'tenant_1to1', participant_phone: '+15550002902', last_activity_at: '2026-06-12T11:00:00.000Z', unread_count: 2 }),
        conv({ conversationId: 'cv-del', participant_phone: '+15550002903', last_activity_at: '2026-06-12T10:00:00.000Z', unread_count: 1 }),
      ],
      latestMessage: {
        'cv-del': { type: 'sms', direction: 'inbound', body: 'still there?', created_at: '2026-06-12T10:00:00.000Z' },
      },
    };
    const calls = emptyCalls();
    const info = vi.fn();
    const page = await aggregateInbox(
      { filter: 'unknown', limit: 25 },
      makeDeps(seed, calls, { info, warn: vi.fn() }),
    );
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-unk', 'c-del']);
    // The queue read: one partition Query, no open-partition walk.
    expect(calls.listByType).toBe(1);
    expect(calls.listByLastActivity).toBe(0);
    // The sweep: one index page (3 visible items), then ONE contact
    // resolution PER VISIBLE UNREAD ITEM - cv-t1, cv-t2, cv-del - which is
    // the O(all unread) term the design accepts and this pin makes visible.
    expect(calls.queryUnreadPage).toBe(1);
    expect(calls.findByPhone).toBe(3);
    // Thread resolution: the queue row and the resurfaced row (one distinct
    // phone each).
    expect(calls.findByParticipantPhone).toBe(2);
    // Message reads: the collector's resurfacing probe on cv-del, plus one
    // latest-message hydration per rendered row (cv-q, cv-del).
    expect(calls.listByConversation).toBe(3);
    // And the cost is ON THE LOG, unconditionally: the assembled line carries
    // the sweep's raw-scan volume even when nothing stopped early - the one
    // per-request signal for the O(visible unread) term growing in production.
    const assembled = info.mock.calls.find((c) => c[1] === 'inbox feed assembled')?.[0];
    expect(assembled?.sweepScanned).toBe(3);
    // If any of these counts move, find WHICH read moved and why before
    // repinning - each number above names its buyer.
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
`collectUnreadRows`, `UNREAD_WALK_LIMIT`, `warnDeletedProbes` AND
`warnUnreadScanned` - verify, they are all imported at `inbox.ts:86-96`; the
branch does NOT use `BADGE_COUNT_CAP`, deliberately - see the sweep comment in
Step 5; it stays imported for `countUnreadRows`, so nothing orphans):

```ts
import {
  collectUnknownTriageQueue,
  UNKNOWN_QUEUE_MAX_PAGES,
  UNKNOWN_QUEUE_MAX_ROWS,
  UNKNOWN_QUEUE_PAGE_SIZE,
  UNKNOWN_QUEUE_TYPES,
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
  /**
   * TEST SEAM for the unknown tab's resurfacing sweep (production:
   * UNREAD_WALK_LIMIT). Deliberately NOT `unreadWalkLimit`: that seam belongs
   * to the unread branch, and a route test shrinking it to reach the unread
   * `truncated` posture must never silently reshape the Unknown tab's sweep.
   */
  unknownSweepBudget?: number;
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

    // LOUD BY CONTRACT, like the group source (readGroupSource above): the
    // module norm is best-effort hydration, but a failed triage-partition
    // Query is NOT swallowed - "no unknown contacts" and "the query broke"
    // must not be indistinguishable, because the failure mode is the entire
    // triage queue silently vanishing behind a healthy-looking empty state.
    // collectUnknownTriageQueue does not catch; the throw propagates to the
    // route's 500.
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
    // on the shared unread-request budget, and NO second bound (design
    // requirement 3): `maxRows` is pinned to the budget itself - a walk of N
    // raw items can emit at most N candidates - so the budget is the ONE stop
    // that matters, and no third caller's cap (the badge's BADGE_COUNT_CAP
    // counts ALL candidate kinds) can silently crowd deleted unknowns out of
    // the sweep. Its per-request probe tripwire fires here like it does on the
    // badge path.
    //
    // THE PRICE OF THAT COMPLETENESS, on the record (round-3 review): with no
    // candidate cap, the sweep runs to the budget - up to UNREAD_WALK_LIMIT
    // (2000) raw index items, ONE findByPhone per VISIBLE item, on every
    // Unknown page load. The CROSSOVER is at roughly the open partition's own
    // size: the walk this design removed paid ~684 contact lookups (one per
    // open 1:1 conversation, prod 2026-08-25), so past ~700 visible unread
    // threads this tab costs MORE contact reads than the read it replaced,
    // with a hard worst case of ~2000 (~3x). Accepted because the QUANTITY is
    // better even when the constant is worse: open conversations never shrink
    // (nothing closes a 1:1), while unread DRAINS as the operator triages - a
    // backlogged org pays more than a caught-up one, the exact inversion of
    // the pathology the spec measured. The scan tripwire below is the early
    // signal; docs/issues/inbox-filter-tabs-full-walk.md records where to
    // reopen this.
    const sweepBudget = deps.unknownSweepBudget ?? UNREAD_WALK_LIMIT;
    const collected = await collectUnreadRows(
      { conversations, contacts, messages, logger: log },
      { maxRows: sweepBudget, budget: sweepBudget },
    );
    warnDeletedProbes(log, {
      probes: collected.deletedProbes,
      wasted: collected.wastedProbes,
      skipped: collected.skippedDeletedThreads,
    });
    // The raw-scan tripwire, same threshold the rest of the route uses
    // (UNREAD_WALK_WARN, 500). The in-walk warn inside the collector fires for
    // a single collect too, but this branch follows the unread branch's
    // convention (inbox.ts:1351) so the request-level signal is explicit at
    // the caller - the two bind to ONE module-scope limiter, so a request that
    // trips both emits one line, never two.
    warnUnreadScanned(log, sweepBudget - collected.remainingBudget);
    for (const candidate of collected.candidates) {
      if (candidate.kind !== 'contact') continue;
      // TYPE MEMBERSHIP against the derived queue-type list, never
      // roleFromContact: a deleted team_member's fresh inbound must not
      // re-enter the triage queue through this side door - the fall-through
      // renders team_member as 'unknown' (class c ruling) - and a future type
      // mapped 'queried' in UNKNOWN_TAB_TYPE_DECISIONS is admitted here the
      // moment it is admitted to the partition read, with no second list to
      // update.
      if (!UNKNOWN_QUEUE_TYPES.includes(candidate.contact.type)) continue;
      // Live unknowns already came from the partition read; only soft-deleted
      // ones need this source. (The partition read excludes deleted rows, so
      // the two sources are disjoint - the emitted-set check is a belt.)
      if (!isDeleted(candidate.contact)) continue;
      if (emitted.has(candidate.contact.contactId)) continue;
      const open = await resolveOpenThreads(candidate.contact);
      if (open === undefined) continue;
      const maxConv = newestOf(open);
      // Counted, unlike a bare continue: this branch's log line exists to make
      // zero-row pages diagnosable, and a resurfacing candidate lost to a
      // closed-or-relay-only thread set is a drop like any other.
      if (maxConv === undefined) {
        dropped('resurfaceNoOpenThread');
        continue;
      }
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
    if (collected.truncated || collected.capped) {
      // BOTH flags are floor signals, and `capped` MASKS `truncated` in
      // CollectResult (truncated = !capped && !scanExhausted, unreadFeed.ts) -
      // reading `truncated` alone made a capped sweep silently drop class-(d)
      // rows past the cap, the round-2 blocking finding. The WARN names which
      // stop it was. NEVER the wire `truncated` flag (see the return below).
      log.warn(
        {
          scanned: sweepBudget - collected.remainingBudget,
          ...(collected.capped && { capped: true }),
          ...(collected.truncated && { truncated: true }),
        },
        'inbox: the unknown-tab resurfacing sweep stopped early - the deleted-row set is a floor',
      );
    }

    // Requirement 2: the whole KEPT queue, sorted in memory, newest first -
    // the byTypeStatus index has no activity dimension, so index-order paging
    // would yield globally out-of-order pages. TWO different cuts can hide
    // rows, and they are NOT the same claim: this WINDOW cut (below) really is
    // newest-first, so what it hides is the older tail and triage drains
    // toward it; the COLLECTOR's cap/page-budget cut (already WARNed inside
    // collectUnknownTriageQueue) is in INDEX order, so past
    // UNKNOWN_QUEUE_MAX_ROWS untriaged contacts the hidden rows are arbitrary
    // with respect to recency and the newest inbound can be among them. The
    // sort orders what SURVIVED; it cannot repair what the collector never
    // read.
    unknownRows.sort((a, b) =>
      a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0,
    );
    // The response window is the wire limit (route-clamped, dashboard sends
    // 30). Rows past it are NOT silently gone: the WARN below names the count,
    // and - for THIS cut only, see above - triage drains the queue
    // newest-first, so the remainder becomes reachable as rows are retyped
    // away. No cursor - an offset page over a mutating in-memory sort
    // re-serves and skips rows, and the design settled on cap-plus-WARN
    // (requirement 2). The affordance gap is recorded in
    // docs/issues/inbox-filter-tabs-full-walk.md.
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
        // UNCONDITIONAL, like the unread branch's `scanned` (inbox.ts:1434):
        // this is the one cost that grows with backlog, and a sweep that
        // drains 1500 items NORMALLY is exactly the curve an operator needs to
        // see per request, not only past the 500-item tripwire.
        sweepScanned: sweepBudget - collected.remainingBudget,
        ...(collected.truncated && { resurfaceTruncated: true }),
        ...(collected.capped && { resurfaceCapped: true }),
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

- [ ] **Step 6: inbox.ts - retire every comment and arm the flip invalidates**

This file's comments are its design record; a flip that leaves them stale is
how the next reader re-derives a wrong model. Four sites, all in the same
commit as the flip:

1. The read-accounting block at ~599-623 says the fields cover "filters `all`
   and `unknown`". Name `all` only, and add one line: the unknown branch
   returns through its own log line (queueContacts / queuePages /
   threadReadFailures / resurfaceTruncated / resurfaceCapped + the shared
   `drops`).
2. `passesFilter`'s `case 'unknown': return row.needsTriage;` (~710-711)
   becomes unreachable exactly as the `'unread'` arm above it did. Give it the
   SAME kind of keep-comment the unread arm carries (~703-709): unreachable
   since the 2026-08-25 contact-side read (the unknown branch returns before
   any caller of this runs) but NOT removable - the switch is exhaustive over
   InboxFilter with no `default:`, and re-adding a `default:` is exactly how a
   new filter ships as a silent no-op.
3. `rowForConversation`: its header (~836-838) says "THE OPEN-PARTITION PATH
   ONLY (filters `all` and `unknown`)" - change to `filter=all` only, noting
   `unknown` moved to the contact-side branch on 2026-08-25. Mark its two
   unknown-filter arms as DEAD ARMS kept deliberately, mirroring the unread
   dead-arm comments already in the function: the `filter === 'unknown' &&
   role !== 'unknown'` guard at ~901 (which also retires the
   `unknownFilterRole` drop counter - say so, so a log reader does not grep
   for a counter that can no longer fire) and the `filter === 'unread'`-style
   wording around them.
4. The relay-merge drop comment at ~1571-1576 ("On filter=unknown this arm
   rejects EVERY relay row...") describes a state the flip makes impossible -
   the unknown branch returns before the relay merge runs. Rewrite it to say
   the arm now guards FUTURE filters that reach the merge, and that
   `filteredRelay` can no longer fire under `unknown`. Same for the group
   source gate at ~1599-1601 (`filter !== 'unknown'`): the gate is now
   belt-and-braces behind the branch's early return - keep it, but say that.

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
regression in the branch, not a pin to update. Fix the branch. ONE known
exception class, so this rule does not misdirect you: a `type: 'unknown'`
FIXTURE that carries no `status` is invisible to the queue read BY DESIGN (the
helper's GSI-sparseness rule) - that is a fixture to complete, not a branch
bug; Step 9 names the two known sites in inboxFeed.test.ts. The parity file's
own fixtures all carry a status already.

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

Then give the file's two `type: 'unknown'` fixtures an indexed `status` -
**this is a required edit, not a red to diagnose in the branch.** DECISION
(round 3, both reviewers): the helper's GSI-sparseness rule STAYS - it is real
DynamoDB behaviour (`byTypeStatus` range key is `status`; an item missing a key
attribute is not indexed) and the helper is positioned as the authority on
partition semantics - so the two pre-existing status-less fixtures must gain
the field production always writes. A status-less unknown contact is not a
shape any write path produces (see the facts block), so these fixtures were
always slightly wrong; the sparseness rule just made it observable. Under the
OLD pager they resolved through `findByPhone`, which ignores `status`; under
the contact-side read a row must be INDEXED to exist, which is the point.

`grep -n "type: 'unknown'" app/test/inboxFeed.test.ts` returns exactly two
sites; add `status: 'needs_review'` to both contact literals:

- ~415-421 (the `c-unk` contact with firstName Alexis): add
  `status: 'needs_review',` after `type: 'unknown',`. Its test's assertions
  (`unknown.rows` length 1, `contactId === 'c-unk'`) then pass unchanged.
- ~521 (the relay-matrix seed): change to
  `{ contactId: 'c-unk', type: 'unknown', status: 'needs_review', phone: '+14049824978' }`.
  Its pin `['+14049824978']` then holds - because the contact is type unknown
  AND indexed. "IS type unknown" alone stopped being sufficient when the
  sparseness rule landed.

After those two edits, re-run the remaining unknown-filter test that needs no
edit at all: ~387-409 (partner excluded; rows `[]` both before and after).

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
- Produces: the user-facing proof, executed by gate 4 (`npm run e2e`) in Task 10.
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

### Task 9: Docs - close the issue's unknown item, record the ruling, the remainder, and the deferral

**Files:**
- Modify: `docs/issues/inbox-filter-tabs-full-walk.md`
- Check, likely NO edit: `e2e/README.md` (round-3 review read lines 184-195:
  the profiled shape `GET /api/inbox?filter=unknown&limit=30` is unchanged by
  the flip and nothing there claims the tab pages or mints a cursor - so the
  expected outcome of Step 2 is "no edit needed")

**Interfaces:**
- Consumes: the issue's existing structure (its line 153 currently reads
  "UNKNOWN: STILL OPEN. `filter=unknown` still walks `byLastActivity` ...").
- Produces: the in-repo record; `npm run issues` regenerates the gitignored
  INDEX (nothing to commit from that).

- [ ] **Step 1: Edit the issue** (ASCII only; edit tool, never a PowerShell
  rewrite). Four additions:

1. Replace the "UNKNOWN: STILL OPEN" status line with a dated resolution:
   `filter=unknown` now reads the `(type='unknown')` byTypeStatus partition
   (branch `feat/inbox-unread-cluster`, design
   `docs/superpowers/specs/2026-08-25-inbox-unknown-tab-walk-design.md`):
   bounded fill loop (`UNKNOWN_QUEUE_MAX_PAGES` x `UNKNOWN_QUEUE_PAGE_SIZE`),
   hard result cap (`UNKNOWN_QUEUE_MAX_ROWS`), truncation WARN, deleted-contact
   resurfacing via one byUnread sweep (budget-bounded; BOTH collector stop
   flags - `capped` and `truncated` - are floor signals), and NO status
   narrowing or excludeOrigin (spec section 3, classes f and a).
2. Record the class (c) ruling so it does not ride only on the spec: a
   `team_member` contact no longer appears on the Unknown tab (`roleFromContact`
   falls internal staff through to 'unknown', which put colleagues in the
   operator's triage queue; RULED 2026-08-25 that they do not belong there; the
   contact-side read excludes them by construction and
   `UNKNOWN_TAB_TYPE_DECISIONS` in `app/src/lib/unknownQueue.ts` - which
   DERIVES the queried-type list, so the decision is enforced, not decorative).
3. Name the deliberate remainder, precisely: rows past the request `limit`
   (dashboard: 30) are WARNed and become reachable as triage drains the queue
   newest-first - that claim holds for the WINDOW cut only; the collector's
   `UNKNOWN_QUEUE_MAX_ROWS` cap cuts in INDEX order with no recency guarantee,
   so past ~200 untriaged contacts the newest inbound can be among the hidden
   rows (WARNed, with the index-order caveat in the copy). No Load-more
   affordance exists for either cut. Contactless conversations (class e,
   measured zero) surface on the All tab only.

   The SWEEP's ceiling and crossover, so a future reader comparing "684
   before" finds the after-number: the resurfacing sweep is O(visible unread),
   one contact read per visible unread index item, hard-capped at
   `UNREAD_WALK_LIMIT` (2000) raw items per Unknown page load - so past
   roughly 700 visible unread threads (the size of the open partition whose
   ~684-lookup walk this design removed) the tab costs MORE contact reads than
   the read it replaced, worst case ~3x. Accepted deliberately: unread drains
   with triage while the open partition only grows, so the bound is on a
   self-limiting quantity. Signals: the unconditional `sweepScanned` log field
   per request, and the shared 500-item scan tripwire.

   Also record the capped-sweep residual (forced by approved requirements 2
   and 5 together, not fixable here): a sweep stopped early can leave the tab
   rendering the ordinary "No unknown numbers" empty state over a knowingly
   incomplete answer - the wire must not carry `truncated` (the dashboard
   would render the failure banner over a normal empty queue), so the floor
   WARN and the `resurfaceCapped`/`resurfaceTruncated` log fields are the only
   signals. Reopen here if any of these trades goes wrong.
4. Record the DEFERRAL (human ruling 2026-08-25): spec section 5's
   open-partition safety net - a raw-scan budget + cursor + `truncated`
   contract for the `filter=all` pager - is deferred, NOT built on this
   branch. Its own named gate is unsolved: an empty budget-stopped
   `filter=all` page carrying `truncated` renders the dashboard's
   non-filter-gated failure banner (`Inbox.tsx:42` / `:183`) on an org where
   nothing failed, and the spec says that must be solved FIRST. Note the two
   review-found traps for whoever picks it up: the empty-page invariant nulls
   the cursor, so Load-more cannot be the affordance in that state; and
   replacing the pager loop's tail orphans the `moreChunks` binding at
   `inbox.ts:1481` (a gate-5 no-unused-vars error unless deleted with it).

- [ ] **Step 2: Check e2e/README.md - expected outcome: NO edit**

Lines ~184-195 describe the profiled Unknown surface. The profiled request
shape (`GET /api/inbox?filter=unknown&limit=30`, no cursor) is UNCHANGED, and
round-3 review found nothing there that calls the tab a pager or claims it
mints a cursor - so expect to change NOTHING. Edit only if you find a sentence
the flip made false (the Unknown feed now mints no cursor and answers 400 to
any cursor); do not invent an edit to justify the check, and stage the file
only if you actually changed it.

- [ ] **Step 3: Regenerate the index**

Run: `cd W:\tmp\inbox-unread-cluster; npm run issues`
Expected: exit 0 (INDEX.md is gitignored).

- [ ] **Step 4: Commit**

```
git add docs/issues/inbox-filter-tabs-full-walk.md
git commit -m "docs(issues): unknown-tab walk resolved by the contact-side read; section-5 safety net deferred with its gate named"
```

(Add `e2e/README.md` to the `git add` ONLY if Step 2 actually changed it.)

---

### Task 10: Completion gates

**Files:** none (verification only; fix-forward anything red, in the task where
it belongs).

**Interfaces:**
- Consumes: everything above, from the worktree `W:\tmp\inbox-unread-cluster`.
- Produces: the merge-ready evidence. Sync `main` into the branch ONCE before
  the gates (ask the human first if `main` has advanced into conflict with
  this work); report later drift rather than chasing it.

- [ ] **Step 1: Sync main once - LOCAL main, not origin/main**

```
git -C W:\tmp\inbox-unread-cluster merge main
```

LOCAL `main` on purpose (round-3 review): in this repo the shared working
`main` checkout is ~83 commits AHEAD of `origin/main`, so `merge origin/main`
merges an ancestor, reports "Already up to date", and silently skips the gate
precondition while appearing to satisfy it. No `git fetch` either - it is not
needed for a local-main sync and can block a non-interactive session on a
credential prompt. Verify the merge actually brought something in (or that
`git merge-base --is-ancestor main HEAD` already holds) rather than trusting
"Already up to date".

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

Report: gates run with exit codes; the coverage-class pin changes (e and c) as
deliberate spec decisions with their parity-test locations; the section-5
deferral (human ruling, recorded in the issue with its unsolved gate named);
the sweep's cost model as pinned by the read-that-ships test (one partition
Query plus an O(visible-unread) contact-resolution sweep - the spec-accepted
trade from requirement 3, ceiling `UNREAD_WALK_LIMIT` = 2000 raw items with a
crossover near ~700 visible unread threads, past which the tab out-costs the
~684-lookup walk it replaced - worst case ~3x, on a quantity that drains with
triage where the old one only grew); and the perf-seed suite's unchanged pass
(Task 6 Step 5).

OFFER, do not run: the end-to-end price on DEPLOYED data can be re-measured
with the corrected instrument the spec's numbers came from -
`npx tsx app/scripts/measure-unread-contact-coverage.ts --confirm
--audit-tab-vs-partition --no-status-narrow` (the script exists and accepts
those flags). It reads deployed environments, so it is HUMAN-INVOKED: put the
command in the handback for Cameron to run (or run it only on his explicit
per-run go), and note that the branch's cost claim rests on the unit pins
until that measurement is taken.

Do not merge to `main`; that is the human's call.

---

## Self-review notes (updated after round-2 review)

- Spec coverage: requirement 1 -> Tasks 4+5 (no narrowing, live type check,
  named page size/cap); requirement 2 -> Task 5 (in-memory sort, window, WARN -
  with the collector-cap ordering caveat stated where the sort runs);
  requirement 3 -> Task 5 sweep (shared budget, maxRows pinned to the budget so
  no third caller's bound is inherited, `capped || truncated` both read as
  floor signals); requirement 4 -> Task 5 `resolveOpenThreads` + its
  discrimination test, and the partition read's LOUD posture stated explicitly
  (the one read whose failure must not impersonate an empty queue); requirement
  5 -> Task 5 (no `truncated` on unknown) + Task 7 pins; section 5 -> DEFERRED
  by human ruling 2026-08-25 (see "Out of scope", recorded in the issue by Task
  9); section 6 testing demands -> Tasks 3 (parity), 5 (starved fixture PLUS
  the read-that-ships cost pin, read counts not wall-clock, class pins,
  loud-failure pin), mutation probes throughout; section 7 ruling ->
  `UNKNOWN_TAB_TYPE_DECISIONS` driving `UNKNOWN_QUEUE_TYPES` (load-bearing, not
  decorative), the sweep's membership check, Task 9's issue note.
- Deliberately NOT copied from the precedent, with reasons in code comments:
  `excludeOrigin` (class a - single-source reader) and the status re-check
  (replaced by the live type check). Both carry probes that go red if re-added,
  because the fakes honor the options - and the fakes follow the service's LEK
  rule ("Limit reached", unreadIndexFake.ts:104-116), so call-count pins are
  calibrated to production round trips.
- Names used consistently across tasks: `collectUnknownTriageQueue`,
  `UNKNOWN_QUEUE_PAGE_SIZE/MAX_PAGES/MAX_ROWS`, `UNKNOWN_TAB_TYPE_DECISIONS`,
  `UNKNOWN_QUEUE_TYPES`, `listByTypeFromContacts`, drop reasons
  `unknownQueueRetyped` / `unknownThreadReadFailed` / `unknownNoOpenThread` /
  `deletedNoUnread` / `resurfaceHidden` / `resurfaceNoOpenThread`, log fields
  `resurfaceTruncated` / `resurfaceCapped` / `sweepScanned` (unconditional),
  seams `unknownQueuePageSize/MaxPages/MaxRows` and `unknownSweepBudget`.
- Round-3 fold: the two status-less `type: 'unknown'` fixtures in
  inboxFeed.test.ts gain `status: 'needs_review'` in Task 5 Step 9 (sparseness
  KEPT - the helper stays the authority on partition semantics); the sweep's
  ceiling (2000) and ~700-unread crossover are recorded in the branch comment,
  the issue, and the handback; `warnUnreadScanned` fires at the caller and
  `sweepScanned` logs unconditionally; the main sync uses LOCAL `main`.
