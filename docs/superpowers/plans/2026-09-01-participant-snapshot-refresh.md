# Participant Names: Resolve on Read - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every staff-facing surface renders a participant's CURRENT contact name, falling back to the stored snapshot, then the phone - with at most one batched contact read per page.

**Architecture:** One new pure module (`lib/participantNames.ts`) resolves a roster's names from a `getDisplaysByIds` map in memory. Each read boundary collects contact ids, does ONE batch read, and hands the existing label functions a fresher roster. Surfaces that already hold the contact (Today, People card, push, voice) just flip their precedence. No client changes except one empty-string guard.

**Tech Stack:** TypeScript, Express, Vitest (`app/test`), Playwright (`e2e`), DynamoDB Local.

**Spec:** `docs/superpowers/specs/2026-08-31-participant-snapshot-refresh-design.md`

**Revision:** v2, after plan review round 1 (adjudications at `docs/superpowers/reviews/2026-08-31-participant-snapshot-refresh/design-review/plan-adjudications.md`).

## Global Constraints

- The name chain is exactly: live contact name -> stored `participants[].name` / `participant_display_name` -> formatted phone.
- Batch reads use `contactsRepo.getDisplaysByIds`. Never `getById` per member. Never `findByPhone` on a request path. Never `requireComplete`.
- A soft-deleted contact (`isDeleted`) supplies NO name; fall to the stored snapshot.
- `participants[].phone` is never modified anywhere.
- Do not edit: `jobs/relayFanOut.ts`, `services/relayAnnouncements.ts`, `lib/unreadFeed.ts`, `jobs/tourReminders.ts`, `routes/api.ts` `GET /conversations/:id` (`:2004`) or `GET /group-members` (`:2020`). In `services/rosterEdits.ts` the ONLY permitted edits are the two comment docblocks named in Task 6; no code.
- New/touched lines in specs, issues, tests, comments and log strings are ASCII-only. Never rewrite a file with a PowerShell `Get-Content | Set-Content` pipeline.
- Commit explicit paths only (`git add <paths>`); never `git add -A`. Read `git status` before every commit. Every commit carries `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Run every gate BARE from `W:\tmp\participant-snapshot-refresh` - never piped.
- Line numbers below are as of `b702a81c` and were re-verified by two reviewers. If one does not match, find the symbol named beside it.
- A test marked PIN is expected to pass BEFORE the implementation; it guards a behavior the change must not break. Only tests marked RED are the TDD red step.

Worktree: `W:\tmp\participant-snapshot-refresh`, branch `feat/participant-snapshot-refresh`. All commands run from that directory; `cd app` where noted.

---

### Task 0: Install dependencies

The worktree has no `node_modules` (verified 2026-09-01). Nothing runs until this is done.

- [ ] **Step 1:** From the worktree root: `npm install`
- [ ] **Step 2:** `cd app && npx vitest run test/contactName.test.ts` - Expected: PASS (proves the toolchain works before any change).

No commit (nothing tracked changes).

---

### Task 1: `participantNames` module + widen `contactDisplayName`

**Files:**
- Create: `app/src/lib/participantNames.ts`
- Modify: `app/src/lib/contactName.ts:7` (delete import), `:50-73` (docblock + function)
- Test: `app/test/participantNames.test.ts` (new), `app/test/contactName.test.ts`

**Interfaces:**
- Produces:
  - `contactDisplayName(contact: { contactId: string; firstName?: unknown; lastName?: unknown } | undefined): string | undefined`. The `contactId` anchor is REQUIRED: without it the parameter is a TypeScript weak type (all-optional) and every existing `ContactItem` caller fails TS2559. `routes/units.ts:113-122` documents the same anchor for the same reason.
  - `collectRosterContactIds(convs: readonly Pick<ConversationItem, 'participants'>[]): string[]`
  - `resolveRosterNames(convs, contacts: Pick<ContactsRepo, 'getDisplaysByIds'>, log: Logger): Promise<ReadonlyMap<string, ContactDisplayItem>>` - never rejects; a throw yields an EMPTY map and one warn.
  - `withLiveNames(participants: readonly ConversationParticipant[] | undefined, names: ReadonlyMap<string, ContactDisplayItem>): ConversationParticipant[]`
  - `hydrateConversationRosters<T extends ConversationItem>(convs: readonly T[], contacts, log): Promise<T[]>`

- [ ] **Step 1: Write the tests** (RED)

`app/test/participantNames.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  collectRosterContactIds,
  hydrateConversationRosters,
  resolveRosterNames,
  withLiveNames,
} from '../src/lib/participantNames.js';
import type { ContactDisplayItem } from '../src/repos/contactsRepo.js';
import type { ConversationItem, ConversationParticipant } from '../src/repos/conversationsRepo.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';

const log = createLogger({ destination: createLogCapture().stream });

const display = (contactId: string, firstName?: string, lastName?: string, deleted_at?: string): ContactDisplayItem => ({
  contactId,
  ...(firstName !== undefined && { firstName }),
  ...(lastName !== undefined && { lastName }),
  ...(deleted_at !== undefined && { deleted_at }),
});

const roster: ConversationParticipant[] = [
  { contactId: 'c-1', phone: '+15550100001', name: 'Old One' },
  { contactId: 'c-2', phone: '+15550100002' },
  { contactId: '', phone: '+15550100003', name: 'Bare Phone' },
  { contactId: 'c-4', phone: '+15550100004', name: 'Stays Stored' },
];

describe('collectRosterContactIds', () => {
  it('collects unique non-empty contactIds across conversations', () => {
    const convs = [
      { participants: roster },
      { participants: [{ contactId: 'c-1', phone: '+1' }, { contactId: 'c-9', phone: '+2' }] },
      { participants: undefined },
    ];
    expect(collectRosterContactIds(convs).sort()).toEqual(['c-1', 'c-2', 'c-4', 'c-9']);
  });
});

describe('withLiveNames', () => {
  const names = new Map<string, ContactDisplayItem>([
    ['c-1', display('c-1', 'New', 'One')],
    ['c-2', display('c-2', ' Two ', '')],
    ['c-4', display('c-4', undefined, undefined)],
  ]);

  it('live name wins; stored name on map miss or empty live name; bare-phone untouched', () => {
    const out = withLiveNames(roster, names);
    expect(out.map((p) => p.name)).toEqual(['New One', 'Two', 'Bare Phone', 'Stays Stored']);
  });

  it('never touches phone and never mutates its input', () => {
    const before = JSON.stringify(roster);
    const out = withLiveNames(roster, names);
    expect(out.map((p) => p.phone)).toEqual(roster.map((p) => p.phone));
    expect(JSON.stringify(roster)).toBe(before);
    expect(out[0]).not.toBe(roster[0]);
  });

  it('a soft-deleted contact supplies no name', () => {
    const deleted = new Map([['c-1', display('c-1', 'Gone', 'Person', '2026-01-01T00:00:00.000Z')]]);
    expect(withLiveNames(roster, deleted)[0]?.name).toBe('Old One');
  });

  it('undefined participants -> empty array', () => {
    expect(withLiveNames(undefined, names)).toEqual([]);
  });
});

describe('resolveRosterNames / hydrateConversationRosters', () => {
  const conv = (conversationId: string, participants: ConversationParticipant[]): ConversationItem =>
    ({ conversationId, type: 'relay_group', status: 'open', participants, last_activity_at: 'x', created_at: 'x', ai_mode: 'manual' }) as ConversationItem;

  it('issues ONE batch with the unique ids and hydrates every row', async () => {
    const getDisplaysByIds = vi.fn(async (ids: string[]) =>
      new Map(ids.map((id) => [id, display(id, 'Live', id)] as const)),
    );
    const convs = [conv('a', roster), conv('b', [{ contactId: 'c-1', phone: '+1' }])];
    const out = await hydrateConversationRosters(convs, { getDisplaysByIds }, log);
    expect(getDisplaysByIds).toHaveBeenCalledTimes(1);
    expect(new Set(getDisplaysByIds.mock.calls[0]![0])).toEqual(new Set(['c-1', 'c-2', 'c-4']));
    expect(out[0]!.participants!.map((p) => p.name)).toEqual(['Live c-1', 'Live c-2', 'Bare Phone', 'Live c-4']);
    expect(out[1]!.participants![0]!.name).toBe('Live c-1');
    expect(out[0]).not.toBe(convs[0]);
  });

  it('a partial map leaves unresolved members on their stored names', async () => {
    const getDisplaysByIds = vi.fn(async () => new Map([['c-1', display('c-1', 'Live', 'One')]]));
    const out = await hydrateConversationRosters([conv('a', roster)], { getDisplaysByIds }, log);
    expect(out[0]!.participants!.map((p) => p.name)).toEqual(['Live One', undefined, 'Bare Phone', 'Stays Stored']);
  });

  it('a throwing batch yields an empty map and the input names, never a rejection', async () => {
    const getDisplaysByIds = vi.fn(async () => { throw new Error('ProvisionedThroughputExceededException'); });
    const names = await resolveRosterNames([conv('a', roster)], { getDisplaysByIds }, log);
    expect(names.size).toBe(0);
    const out = await hydrateConversationRosters([conv('a', roster)], { getDisplaysByIds }, log);
    expect(out[0]!.participants!.map((p) => p.name)).toEqual(roster.map((p) => p.name));
  });

  it('no ids -> no batch call', async () => {
    const getDisplaysByIds = vi.fn(async () => new Map());
    await resolveRosterNames([conv('a', [{ contactId: '', phone: '+1' }])], { getDisplaysByIds }, log);
    expect(getDisplaysByIds).not.toHaveBeenCalled();
  });
});
```

Append to `app/test/contactName.test.ts` (it already imports `contactDisplayName`, `describe`, `expect`, `it`):

```ts
import type { ContactDisplayItem } from '../src/repos/contactsRepo.js';

describe('contactDisplayName accepts the display projection', () => {
  it('joins trimmed parts from a ContactDisplayItem', () => {
    const item: ContactDisplayItem = { contactId: 'c', firstName: ' Ada ', lastName: 'Lovelace ' };
    expect(contactDisplayName(item)).toBe('Ada Lovelace');
  });
});
```

Put the `import type` line with the file's other imports at the top.

- [ ] **Step 2: Verify RED**

Run: `cd app && npx vitest run test/participantNames.test.ts; npm run typecheck`
Expected: vitest FAILS (`participantNames.js` cannot be resolved). Typecheck FAILS on `contactName.test.ts` (`ContactDisplayItem` is not assignable to `ContactItem`). The contactName test is green at RUNTIME today because esbuild strips types - the typecheck is its red.

- [ ] **Step 3: Widen `contactDisplayName`**

In `app/src/lib/contactName.ts`: DELETE line 7 (`import type { ContactItem } from '../repos/contactsRepo.js';`) - its only use was this function's parameter, and an orphaned import fails gate 5 on a touched file. Then replace lines 50-73 with:

```ts
// contactDisplayName - THE trimmed "First Last" join for any surface that
// holds a contact, or the display projection of one.
//
// Accepts the MINIMAL shape both contact reads satisfy - a whole ContactItem
// (getById / getManyByIds) and the ContactDisplayItem projection
// (getDisplayById / getDisplaysByIds) - so a label-only batch read never has to
// widen to a whole-item read just to name someone. `contactId` is here only as
// the anchor that keeps TypeScript's weak-type check honest (the same trick as
// routes/units.ts displayNameOfContact); the name comes from the two optional
// fields.
//
// Consumers include the inbound-message and voice pushes and the participant
// name resolver in lib/participantNames.ts. Private copies of this derivation
// still exist in routes/inbox.ts and routes/today.ts and DIFFER from this one
// on purpose (an extra `contact.name` rung; outer-vs-part trimming); see
// docs/issues/consolidate-contact-display-name-helpers.md before re-pointing
// any of them.
//
// `firstName`/`lastName` are NOT declared string fields - they ride an index
// signature or are typed `unknown` - so both reads are defensive: a non-string
// value must never reach `.trim()`.

/** Trimmed first/last join, or undefined when the contact has no name. */
export function contactDisplayName(
  contact: { contactId: string; firstName?: unknown; lastName?: unknown } | undefined,
): string | undefined {
  if (contact === undefined) return undefined;
  const first = typeof contact.firstName === 'string' ? contact.firstName.trim() : '';
  const last = typeof contact.lastName === 'string' ? contact.lastName.trim() : '';
  const joined = [first, last].filter((p) => p.length > 0).join(' ');
  return joined.length > 0 ? joined : undefined;
}
```

- [ ] **Step 4: Create the module**

`app/src/lib/participantNames.ts`:

```ts
// participantNames - resolve a conversation roster's display names from the
// contacts it points at, IN MEMORY, at a read boundary.
//
// `participants[].name` is a write-time snapshot nothing refreshes (M1,
// 2026-08-31). Rather than trust it, each read boundary does ONE batched
// display-projection read for the page and hands the existing label functions
// (lib/groupTitle.ts, describeRoster, ...) a fresher array. Those functions do
// not change.
//
// THE CHAIN, per member: live contact name (non-deleted, non-empty) -> the
// stored snapshot -> nothing (the client renders the phone). A member with no
// contactId has nothing to resolve and is returned as-is.
//
// READ POSTURE: getDisplaysByIds is best-effort - a throttle returns a SHORT map
// and a thrown chunk is swallowed by the repo. Either way an unresolved member
// keeps its stored name, which is exactly today's behavior. This module never
// rejects; a repo throw degrades to "no names resolved" with one warn.
//
// PHONE IS NEVER TOUCHED. Routing, deliverability and removal all read the
// stored `participants[].phone`; this module only ever rewrites `name`.
//
// PII (doc section 9): ids and counts in logs, never names or phones.
import { contactDisplayName } from './contactName.js';
import type { Logger } from './logger.js';
import { isDeleted, type ContactDisplayItem, type ContactsRepo } from '../repos/contactsRepo.js';
import type { ConversationItem, ConversationParticipant } from '../repos/conversationsRepo.js';

/** The batch read this module needs - the display projection only. */
export type NameSource = Pick<ContactsRepo, 'getDisplaysByIds'>;

/** Unique, non-empty contactIds across every roster given. */
export function collectRosterContactIds(
  convs: readonly Pick<ConversationItem, 'participants'>[],
): string[] {
  const ids = new Set<string>();
  for (const conv of convs) {
    for (const p of conv.participants ?? []) {
      if (typeof p.contactId === 'string' && p.contactId.length > 0) ids.add(p.contactId);
    }
  }
  return [...ids];
}

/**
 * ONE batch read for a page of conversations. Never rejects: a repo throw
 * yields an empty map (every member keeps its stored name) and one warn.
 */
export async function resolveRosterNames(
  convs: readonly Pick<ConversationItem, 'participants'>[],
  contacts: NameSource,
  log: Logger,
): Promise<ReadonlyMap<string, ContactDisplayItem>> {
  const ids = collectRosterContactIds(convs);
  if (ids.length === 0) return new Map();
  try {
    return await contacts.getDisplaysByIds(ids);
  } catch (err) {
    log.warn({ err, contactCount: ids.length }, 'participant names: batch read failed - stored names stand');
    return new Map();
  }
}

/** PURE. A new roster with each member's name resolved per the chain above. */
export function withLiveNames(
  participants: readonly ConversationParticipant[] | undefined,
  names: ReadonlyMap<string, ContactDisplayItem>,
): ConversationParticipant[] {
  return (participants ?? []).map((p) => {
    if (typeof p.contactId !== 'string' || p.contactId.length === 0) return { ...p };
    const contact = names.get(p.contactId);
    if (contact === undefined || isDeleted(contact)) return { ...p };
    const live = contactDisplayName(contact);
    return live === undefined ? { ...p } : { ...p, name: live };
  });
}

/** resolveRosterNames + withLiveNames per row. New objects; input untouched. */
export async function hydrateConversationRosters<T extends ConversationItem>(
  convs: readonly T[],
  contacts: NameSource,
  log: Logger,
): Promise<T[]> {
  const names = await resolveRosterNames(convs, contacts, log);
  return convs.map((conv) => ({ ...conv, participants: withLiveNames(conv.participants, names) }));
}
```

- [ ] **Step 5: Verify GREEN**

Run: `cd app && npx vitest run test/participantNames.test.ts test/contactName.test.ts && npm run typecheck`
Expected: PASS, typecheck exit 0 (every existing `contactDisplayName(contact)` caller passes a `ContactItem`, which has `contactId: string`).

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/participantNames.ts app/src/lib/contactName.ts app/test/participantNames.test.ts app/test/contactName.test.ts
git commit -m "feat(names): participantNames resolver; contactDisplayName accepts the display projection"
```

---

### Task 2: Today - `who` from the memoized contact; close-nag names hydrated

**Files:**
- Modify: `app/src/routes/today.ts:778` (call site), `:994-1002` (close nag), `:1073-1080` (`whoOfConversation`), imports
- Modify: `dashboard/src/routes/today/buildToday.ts:106`
- Test: `app/test/todayApi.test.ts`

**Interfaces:**
- Consumes: `hydrateConversationRosters` (Task 1); `getContact` memo at `today.ts:357`; `nameFromContact` at `:222`; `oneToOneContactId` at `:1086`.
- Produces: `whoOfConversation(conv: ConversationItem, contact: ContactItem | undefined): string`.

- [ ] **Step 1: Write the tests**

Add to `app/test/todayApi.test.ts` inside the top-level `describe`, using its existing `seedConversation`, `seedTenant`, `getItems`, `authedGet`, `iso` helpers and `world`. Three are RED, three are PIN:

```ts
  describe('participant names resolve on read (M1)', () => {
    const seedUnreadTenantThread = (name: string | undefined, contactId = 't-renamed') =>
      seedConversation({
        conversationId: 'conv-renamed',
        participant_phone: '+15550107777',
        participants: [{ contactId, phone: '+15550107777' }],
        status: 'open',
        last_activity_at: iso(-30_000),
        type: 'tenant_1to1',
        ai_mode: 'auto',
        created_at: iso(-60_000),
        unread_count: 1,
        ...(name !== undefined && { participant_display_name: name }),
      });

    it('RED: a stale participant_display_name loses to the contact name', async () => {
      seedTenant('t-renamed', 'Renata', 'New');
      seedUnreadTenantThread('Old Name');
      const row = (await getItems()).find((i) => i.refId === 't-renamed');
      expect(row?.who).toBe('Renata New');
    });

    it('RED: no stored name plus a named contact shows the contact', async () => {
      seedTenant('t-renamed', 'Renata', 'New');
      seedUnreadTenantThread(undefined);
      const row = (await getItems()).find((i) => i.refId === 't-renamed');
      expect(row?.who).toBe('Renata New');
    });

    it('PIN: an unreadable contact keeps the stored name', async () => {
      seedUnreadTenantThread('Stored Name');
      const real = world.contactsRepo.getById.bind(world.contactsRepo);
      world.contactsRepo.getById = async (id) => {
        if (id === 't-renamed') throw new Error('ProvisionedThroughputExceededException');
        return real(id);
      };
      const row = (await getItems()).find((i) => i.refId === 't-renamed');
      expect(row?.who).toBe('Stored Name');
    });

    it('PIN: an unlinked thread (no contactId) still renders the formatted phone', async () => {
      seedUnreadTenantThread(undefined, '');
      const row = (await getItems()).find((i) => i.who === '(555) 010-7777');
      expect(row).toBeDefined();
    });

    it('PIN: resolving names adds NO contact reads - the deleted-check already memoized them', async () => {
      seedTenant('t-renamed', 'Renata', 'New');
      seedUnreadTenantThread('Old Name');
      const real = world.contactsRepo.getById.bind(world.contactsRepo);
      const reads: string[] = [];
      world.contactsRepo.getById = async (id) => { reads.push(id); return real(id); };
      await getItems();
      expect(reads.filter((id) => id === 't-renamed')).toHaveLength(1);
    });

    it('RED: relay close-nag member names come from the contacts', async () => {
      seedTenant('c-nag', 'Nadia', 'Nag');
      seedConversation({
        conversationId: 'relay-nag',
        participant_phone: '+15550190001',
        pool_number: '+15550190001',
        participants: [
          { contactId: 'c-nag', phone: '+15550100011', name: 'Old Nag' },
          { contactId: '', phone: '+15550100012' },
        ],
        status: 'open',
        // The harness's listRelayGroups filters on THIS field with THIS shape
        // (twilioWebhookHarness.ts:777) - the real byRelayStatus GSI hash.
        relay_status: 'relay_group#open',
        close_nag_next_at: iso(-1_000),
        last_activity_at: iso(-30_000),
        type: 'relay_group',
        ai_mode: 'manual',
        created_at: iso(-60_000),
      });
      const res = await authedGet('/api/today');
      const body = res.body as TodayResponse;
      const nag = body.relayCloseNags.find((n) => n.conversationId === 'relay-nag');
      expect(nag?.memberNames).toEqual(['Nadia Nag', '(555) 010-0012']);
    });
  });
```

If `seedConversation`'s parameter type rejects `relay_status` / `close_nag_next_at`, cast the literal `as ConversationItem` the way the file's other callers do.

- [ ] **Step 2: Verify RED**

Run: `cd app && npx vitest run test/todayApi.test.ts -t "participant names"`
Expected: the three RED tests FAIL (`'Old Name'`, `'(555) 010-7777'`, `'Old Nag'`); the three PIN tests PASS.

- [ ] **Step 3: Implement**

`app/src/routes/today.ts:1073-1080`, replace `whoOfConversation` and its docblock:

```ts
/** Conversation `who`: the CONTACT's current name (already memoized by the
 *  deleted-contact gate, so this adds no read), else the stored snapshot, else
 *  the participant phone in staff-facing form (email-only threads carry
 *  neither -> ''). Uses this file's own nameFromContact so Unreplied and the
 *  placement/tour rows share one join rule. */
function whoOfConversation(conv: ConversationItem, contact: ContactItem | undefined): string {
  const live = nameFromContact(contact);
  if (live !== undefined) return live;
  if (typeof conv.participant_display_name === 'string' && conv.participant_display_name.length > 0) {
    return conv.participant_display_name;
  }
  return formatPhoneForDisplay(conv.participant_phone) ?? '';
}
```

`today.ts:778`, inside `for (const conv of unreadOneToOne) {` (a DIFFERENT loop from the index walk at `:742`; declare locally):

```ts
        const whoContactId = oneToOneContactId(conv);
        const who = whoOfConversation(
          conv,
          whoContactId !== undefined ? await getContact(whoContactId) : undefined,
        );
```

`today.ts:994-1002`, the close-nag loop. Replace from `for (const conv of openGroups) {` through the `memberNames` computation with:

```ts
      const dueGroups = openGroups.filter((conv) => {
        const nagDueAt = conv.close_nag_next_at;
        return typeof nagDueAt === 'string' && nagDueAt <= nowIso
          && typeof conv.pool_number === 'string' && conv.pool_number.length > 0;
      });
      // ONE batch for every due group's roster (lib/participantNames): the card
      // names people, and the stored roster names are a creation-time snapshot.
      for (const conv of await hydrateConversationRosters(dueGroups, contacts, log)) {
        const nagDueAt = conv.close_nag_next_at as string;
        const poolNumber = conv.pool_number as string;
        const memberNames = (conv.participants ?? []).map(
          (p) => p.name ?? formatPhoneForDisplay(p.phone) ?? p.contactId,
        );
```

Keep the rest of the loop body. Add the import beside the other `../lib/` imports:

```ts
import { hydrateConversationRosters } from '../lib/participantNames.js';
```

- [ ] **Step 4: Client guard**

`dashboard/src/routes/today/buildToday.ts:106`:

```ts
  const stored = conv.participant_display_name;
  return typeof stored === 'string' && stored.length > 0
    ? stored
    : formatPhone(conv.participant_phone ?? '');
```

- [ ] **Step 5: Verify GREEN**

Run: `cd app && npx vitest run test/todayApi.test.ts && npm run typecheck`
Expected: PASS for the whole file.

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/today.ts app/test/todayApi.test.ts dashboard/src/routes/today/buildToday.ts
git commit -m "feat(today): who resolves from the memoized contact; close-nag names hydrated"
```

---

### Task 3: Inbox group and relay rows

**Files:**
- Modify: `app/src/routes/inbox.ts:1154` (`relayRowFor`), `:1190` (`groupRowFor`), call sites `:1237`, `:1418`, `:2293`, `:2358`, imports
- Test: `app/test/inboxGroups.test.ts`; add an explicit `getDisplaysByIds` to the fakes in `app/test/inboxFeed.test.ts` and `app/test/inboxUnreadParity.test.ts`

**Interfaces:**
- Consumes: `resolveRosterNames`, `withLiveNames` (Task 1).
- Produces: `groupRowFor(conv, names: ReadonlyMap<string, ContactDisplayItem>): InboxRow`; `relayRowFor(conv, names): Promise<InboxRow>`.

- [ ] **Step 1: Write the tests** (RED)

`app/test/inboxGroups.test.ts` drives `aggregateInbox(opts, deps)` directly - no HTTP. Its `makeDeps(seed)` fakes `contactsRepo` with `findByPhone` / `getById` / `listByType` (`:102-117`); `groupConv(over)` builds a `group_text` row with a two-member default roster (`:132`); relay rows are raw literals (`:396-406`).

Add to the `Calls` interface: `displayBatches: string[][];` and initialise it in `makeDeps`: `const calls: Calls = { groupLimits: [], groupCursors: [], displayBatches: [] };`. Add to the `contactsRepo` fake:

```ts
      async getDisplaysByIds(contactIds: string[]) {
        calls.displayBatches.push([...contactIds]);
        return new Map(
          (seed.contacts ?? [])
            .filter((c) => contactIds.includes(c.contactId))
            .map((c) => [c.contactId, { contactId: c.contactId, firstName: c.name, phone: c.phone }] as const),
        );
      },
```

Then add a `describe`:

```ts
describe('roster names resolve on read (M1)', () => {
  it('titles group rows from the CONTACT names, one batch per page', async () => {
    const { deps, calls } = makeDeps({
      groups: [
        groupConv({
          conversationId: 'gt-1',
          last_activity_at: '2026-06-17T10:00:00.000Z',
          participants: [
            { contactId: 'c-ann', phone: '+14045550111', name: 'Ann Tenant' },
            { contactId: 'c-marcus', phone: '+14045550112' },
          ],
        }),
        groupConv({ conversationId: 'gt-2', last_activity_at: '2026-06-17T09:00:00.000Z' }),
      ],
      contacts: [
        { contactId: 'c-ann', phone: '+14045550111', name: 'Annika' },
        { contactId: 'c-marcus', phone: '+14045550112', name: 'Marc' },
      ],
    });
    const page = await aggregateInbox({ filter: 'groups', limit: 25 }, deps);
    expect(page.rows.map((r) => r.name)).toEqual(['With Annika & Marc', 'With Annika & Marc']);
    expect(calls.displayBatches).toHaveLength(1);
    expect(new Set(calls.displayBatches[0])).toEqual(new Set(['c-ann', 'c-marcus']));
  });

  it('titles a relay row from the contact name', async () => {
    const { deps } = makeDeps({
      relay: [
        {
          conversationId: 'relay-1',
          status: 'open',
          type: 'relay_group',
          pool_number: '+15550160001',
          participants: [{ contactId: 'c-ann', phone: '+14045550111', name: 'Ann Tenant' }],
          last_activity_at: '2026-06-17T22:00:00.000Z',
          created_at: '2026-06-17T22:00:00.000Z',
          ai_mode: 'manual',
        } as ConversationItem,
      ],
      contacts: [{ contactId: 'c-ann', phone: '+14045550111', name: 'Annika' }],
    });
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    const row = page.rows.find((r) => r.conversationId === 'relay-1');
    expect(row?.name).toBe('With Annika');
  });
});
```

(`groupConv`'s default roster is Ann Tenant + Marcus Landlord, so `gt-2` resolves to the same contacts.)

In `app/test/inboxFeed.test.ts` and `app/test/inboxUnreadParity.test.ts`, find each file's `contactsRepo` fake (`grep -n "contactsRepo" <file>`) and add an explicit `async getDisplaysByIds() { return new Map(); }`. This is honesty, not necessity: `resolveRosterNames` would swallow the `TypeError` of a missing method, and a suite must not go green by resolving zero names silently.

- [ ] **Step 2: Verify RED**

Run: `cd app && npx vitest run test/inboxGroups.test.ts -t "resolve on read"`
Expected: FAIL - `'With Ann & (404) 555-0112'` and `'With Ann'`.

- [ ] **Step 3: Implement**

Imports at the top of `app/src/routes/inbox.ts` (check whether `ContactDisplayItem` is already imported):

```ts
import { resolveRosterNames, withLiveNames } from '../lib/participantNames.js';
import type { ContactDisplayItem } from '../repos/contactsRepo.js';
```

`:1154` `relayRowFor`:

```ts
  const relayRowFor = async (
    conv: ConversationItem,
    names: ReadonlyMap<string, ContactDisplayItem>,
  ): Promise<InboxRow> => {
    // Names resolved at the boundary (lib/participantNames): the roster's
    // stored names are a creation-time snapshot; the label chain is unchanged.
    const label = relayThreadLabel({ ...conv, participants: withLiveNames(conv.participants, names) });
```

`:1190` `groupRowFor`:

```ts
  const groupRowFor = (
    conv: ConversationItem,
    names: ReadonlyMap<string, ContactDisplayItem>,
  ): InboxRow => ({
    kind: 'group_text',
    conversationId: conv.conversationId,
    name: groupThreadLabel(withLiveNames(conv.participants, names)),
```

`:1237`:
```ts
    const names = await resolveRosterNames(page.items, contacts, log);
    const groupRows = page.items.map((c) => groupRowFor(c, names));
```

`:1418` - this loop refreshes ONE candidate at a time by a point read (its design; see the comment at `:1391-1398`), so one batch per multi-party candidate rides beside that point read. Same order as today, bounded by the page limit. The spec's cost row says so.
```ts
        const names = await resolveRosterNames([fresh], contacts, log);
        return {
          row: candidate.kind === 'relay_group' ? await relayRowFor(fresh, names) : groupRowFor(fresh, names),
        };
```

`:2293` - one batch above the loop:
```ts
    const relayNames = await resolveRosterNames(relayItems, contacts, log);
    const relayRows: InboxRow[] = [];
    for (const conv of relayItems) {
      const row = await relayRowFor(conv, relayNames);
```

`:2358`:
```ts
    const groupNames = await resolveRosterNames(page.items, contacts, log);
    const groupRows = page.items.map((c) => groupRowFor(c, groupNames)).filter((row) => {
```

`filter=all` therefore pays two batches (relay partition, then group partition); the two reads are ~50 lines apart with the 1:1 pager between them, and the spec's cost row records it. `contacts` (`:715`) and `log` (`:713`) are in scope at all four sites - every one is inside `aggregateInbox` (`:709`).

- [ ] **Step 4: Verify GREEN**

Run: `cd app && npx vitest run test/inboxGroups.test.ts test/inboxApi.test.ts test/inboxFeed.test.ts test/inboxUnreadParity.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/inbox.ts app/test/inboxGroups.test.ts app/test/inboxFeed.test.ts app/test/inboxUnreadParity.test.ts
git commit -m "feat(inbox): group and relay row titles resolve names with one batch per page"
```

---

### Task 4: Contact page cards (relay groups, group threads)

**Files:**
- Modify: `app/src/routes/contacts.ts:1189-1230` (relay-groups loop), `:1278-1300` (group-threads loop), imports
- Test: `app/test/contactRelayGroups.test.ts`, `app/test/contactGroupThreads.test.ts`

**Interfaces:**
- Consumes: `resolveRosterNames`, `withLiveNames` (Task 1).

- [ ] **Step 1: Write the tests**

`app/test/contactRelayGroups.test.ts`, using its `seedContact`, `seedRelay`, `authedGet`, `world` (read `seedRelay`'s `opts` shape at `:60-95` and match it - it takes `{ status, ... }` and sets `relay_status` itself):

```ts
  it('RED: otherMemberNames come from the OTHER members contacts, not the stored snapshot', async () => {
    seedContact();
    world.contacts.push({ contactId: 'c-other', type: 'landlord', status: 'active', phone: LANDLORD_PHONE, firstName: 'Lena', lastName: 'Landlord' });
    seedRelay('rg-1', [
      { contactId: TENANT, phone: PHONE_A, name: 'Me' },
      { contactId: 'c-other', phone: LANDLORD_PHONE, name: 'Old Landlord' },
    ], { status: 'open' });
    const res = await authedGet(`/api/contacts/${TENANT}/relay-groups`);
    expect(res.status).toBe(200);
    expect(res.body.groups[0].otherMemberNames).toEqual(['Lena Landlord']);
  });

  it('RED: ONE batch per card, over exactly the ids of the groups this contact is in', async () => {
    seedContact();
    seedRelay('rg-open', [{ contactId: TENANT, phone: PHONE_A }, { contactId: 'c-in-open', phone: LANDLORD_PHONE }], { status: 'open' });
    seedRelay('rg-closed', [{ contactId: TENANT, phone: PHONE_A }, { contactId: 'c-in-closed', phone: '+15550100008' }], { status: 'closed' });
    seedRelay('rg-not-mine', [{ contactId: 'c-out', phone: '+15550100009' }], { status: 'open' });
    const real = world.contactsRepo.getDisplaysByIds.bind(world.contactsRepo);
    const batches: string[][] = [];
    world.contactsRepo.getDisplaysByIds = async (ids) => { batches.push([...ids]); return real(ids); };
    await authedGet(`/api/contacts/${TENANT}/relay-groups`);
    expect(batches).toHaveLength(1);
    expect(new Set(batches[0])).toEqual(new Set([TENANT, 'c-in-open', 'c-in-closed']));
  });
```

`app/test/contactGroupThreads.test.ts`, using its `seedContact`, `seedGroup`, `authedGet`, `world`:

```ts
  it('RED: title and otherMemberNames use the contact name over the stored snapshot', async () => {
    seedContact();
    world.contacts.push({ contactId: 'c-other', type: 'landlord', status: 'active', phone: OTHER_PHONE, firstName: 'Marcus', lastName: 'Renamed' });
    await seedGroup('gt-1', [
      { contactId: TENANT, phone: PHONE_A, name: 'Tasha Tenant' },
      { contactId: 'c-other', phone: OTHER_PHONE, name: 'Marcus Landlord' },
    ]);
    const res = await authedGet(`/api/contacts/${TENANT}/group-threads`);
    expect(res.status).toBe(200);
    expect(res.body.groups[0].title).toBe('With Marcus');
    expect(res.body.groups[0].otherMemberNames).toEqual(['Marcus Renamed']);
  });
```

- [ ] **Step 2: Verify RED**

Run: `cd app && npx vitest run test/contactRelayGroups.test.ts test/contactGroupThreads.test.ts -t "RED"`
Expected: FAIL - `'Old Landlord'`; `batches` length 0; `'Marcus Landlord'`.

- [ ] **Step 3: Implement**

Import in `app/src/routes/contacts.ts`:

```ts
import { resolveRosterNames, withLiveNames } from '../lib/participantNames.js';
```

Relay-groups route: the batch must sit OUTSIDE the three-status loop or the card costs three reads. Replace the block from `for (const status of ['open', 'connecting', 'closed'] as const) {` (`:1189`) through the closing brace of the inner `for (const conv of items)` with:

```ts
    // Read all three partitions first, THEN filter to this contact's groups,
    // THEN resolve names in ONE batch - never a batch per partition.
    const mine: { status: 'open' | 'connecting' | 'closed'; conv: ConversationItem }[] = [];
    for (const status of ['open', 'connecting', 'closed'] as const) {
      const { items, truncated } = await conversations.listRelayGroups(status);
      if (truncated) {
        // No silent truncation - the partition walk hit its page budget, so
        // groups with older last-activity were never considered.
        log.warn(
          { contactId, status },
          'contact relay-groups: partition walk hit the page budget - older groups not considered',
        );
      }
      for (const conv of items) {
        if ((conv.participants ?? []).some(isSelf)) mine.push({ status, conv });
      }
    }
    const names = await resolveRosterNames(mine.map((m) => m.conv), contacts, log);
    for (const { status, conv } of mine) {
      const roster = withLiveNames(conv.participants, names);
      // Staff chrome: each OTHER member renders their name, else their own
      // formatted phone, so the contact card stops silently dropping a
      // nameless person from a list the navigator is trying to act on.
      const others = relayMemberLabels(roster.filter((p) => !isSelf(p)));
```

and keep the rest of the original inner-loop body (`tag`, `otherMemberNames`, `groups.push({...})`) unchanged after it. `ConversationItem` is already imported in this file.

Group-threads route (`:1278-1284`): `const groups: GroupThreadRow[] = [];` already exists at `:1278` - keep it. Replace `for (const conv of items) { const roster = conv.participants ?? []; if (!roster.some(isSelf)) continue; const others = roster.filter((p) => !isSelf(p));` with:

```ts
    const mine = items.filter((conv) => (conv.participants ?? []).some(isSelf));
    const names = await resolveRosterNames(mine, contacts, log);
    for (const conv of mine) {
      const roster = withLiveNames(conv.participants, names);
      const others = roster.filter((p) => !isSelf(p));
```

`contacts` and `log` are the router consts at `:918-919`.

- [ ] **Step 4: Verify GREEN**

Run: `cd app && npx vitest run test/contactRelayGroups.test.ts test/contactGroupThreads.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/contacts.ts app/test/contactRelayGroups.test.ts app/test/contactGroupThreads.test.ts
git commit -m "feat(contacts): group cards resolve member names with one batch per card"
```

---

### Task 5: Relay members panel (batched, stored-name fallback) and the calls passthrough

**Files:**
- Modify: `app/src/routes/relayGroups.ts:39` (import list), `:483-505` (members route body)
- Modify: `app/src/routes/api.ts:2201`
- Test: `app/test/relayApi.test.ts` (two existing tests REWRITTEN + one new), `app/test/voiceWebhook.test.ts` (one new)

**Interfaces:**
- Consumes: `resolveRosterNames`, `withLiveNames`, `hydrateConversationRosters` (Task 1).

**THIS TASK REVERSES A RECORDED RULING.** `relayApi.test.ts:427` ("GET roster drops the creation-time name when the current contact is unnamed") and `:450` ("GET roster falls back to the roster phone, not a stale name, when contact lookup fails") pin the behavior Cameron overrode on 2026-08-31 (spec decision 2: the stored name is the middle rung). Both tests change TITLE, comment and expectation. Say so in the commit body and the handback.

- [ ] **Step 1: Rewrite the two pins and add the new tests**

`app/test/relayApi.test.ts:427-447` becomes:

```ts
  it('GET roster keeps the creation-time name when the current contact is unnamed (M1 ruling 2026-08-31)', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    world.contacts.push({
      contactId: 'c-alice',
      type: 'tenant',
      status: 'active',
      phone: ALICE,
    });
    const conversation = await world.conversationsRepo.createRelayGroup({
      poolNumber: '+15550300998',
      members: [{ contactId: 'c-alice', phone: ALICE, name: 'Old roster name' }],
    });

    const roster = await request(app)
      .get(`/api/conversations/${conversation.conversationId}/members`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(roster.status).toBe(200);
    // Contact name -> stored name -> (client renders the phone). An unnamed
    // contact no longer erases a name the operator had a moment ago.
    expect(roster.body.members).toEqual([{ contactId: 'c-alice', phone: ALICE, name: 'Old roster name' }]);
  });
```

`:450-469` becomes (the read is now the BATCH, so the injected failure goes there):

```ts
  it('GET roster keeps the stored name when the contact read fails (M1 ruling 2026-08-31)', async () => {
    world.contactsRepo.getDisplaysByIds = async () => {
      throw new Error('injected contact lookup failure');
    };
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const conversation = await world.conversationsRepo.createRelayGroup({
      poolNumber: '+15550300997',
      members: [{ contactId: 'c-alice', phone: ALICE, name: 'Old roster name' }],
    });

    const roster = await request(app)
      .get(`/api/conversations/${conversation.conversationId}/members`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(roster.status).toBe(200);
    expect(roster.body.members).toEqual([{ contactId: 'c-alice', phone: ALICE, name: 'Old roster name' }]);
  });
```

New, beside them (declare the two phones locally - `CAROL` and `POOL` are NOT module-scope constants in this file; only `ALICE`/`BOB` are, at `:34-35`):

```ts
  it('RED: GET roster resolves in ONE batch over the unique contact ids; no per-member getById', async () => {
    const CAROL_LOCAL = '+15550100003';
    const POOL_LOCAL = '+15550300996';
    const { app } = authedHarness(world, makeFakePoolNumbers());
    world.contacts.push({ contactId: 'c-live', type: 'tenant', status: 'active', phone: ALICE, firstName: 'Alicia', lastName: 'Live' });
    const conversation = await world.conversationsRepo.createRelayGroup({
      poolNumber: POOL_LOCAL,
      members: [
        { contactId: 'c-live', phone: ALICE, name: 'Old Alice' },
        { contactId: 'c-missing', phone: BOB, name: 'Stored Bob' },
        { contactId: '', phone: CAROL_LOCAL },
      ],
    });
    const batches: string[][] = [];
    const real = world.contactsRepo.getDisplaysByIds.bind(world.contactsRepo);
    world.contactsRepo.getDisplaysByIds = async (ids) => { batches.push([...ids]); return real(ids); };
    const getByIdSpy = vi.spyOn(world.contactsRepo, 'getById');

    const res = await request(app).get(`/api/conversations/${conversation.conversationId}/members`).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.members).toEqual([
      { contactId: 'c-live', phone: ALICE, name: 'Alicia Live' },
      { contactId: 'c-missing', phone: BOB, name: 'Stored Bob' },
      { contactId: '', phone: CAROL_LOCAL },
    ]);
    expect(batches).toHaveLength(1);
    expect(new Set(batches[0])).toEqual(new Set(['c-live', 'c-missing']));
    expect(getByIdSpy).not.toHaveBeenCalled();
  });
```

Add `vi` to the file's vitest import if absent. If `createRelayGroup` drops the bare-phone member or normalises the roster, read its fake in the harness and adjust the expected array to what it stores - the assertion is about NAMES, not roster shape.

`app/test/voiceWebhook.test.ts`, beside the `GET /api/calls/:callId` test near `:915`:

```ts
  it('RED: GET /api/calls/:callId hands back a roster with resolved names', async () => {
    const world = createFakeWorld();
    world.contacts.push({ contactId: 'c-bob', type: 'landlord', phone: BOB, firstName: 'Robert', lastName: 'Renamed' });
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });
    await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoiceParams());
    const res = await request(app).get('/api/calls/CAinbound0001').set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    const bob = (res.body.conversation.participants as { contactId: string; name?: string }[]).find((p) => p.contactId === 'c-bob');
    expect(bob?.name).toBe('Robert Renamed');
  });
```

- [ ] **Step 2: Verify RED**

Run: `cd app && npx vitest run test/relayApi.test.ts -t "GET roster" && npx vitest run test/voiceWebhook.test.ts -t "resolved names"`
Expected: the two rewritten pins and the new batch test FAIL (`name` absent; `getById` called); the calls test FAILS with `'Bob'`.

- [ ] **Step 3: Implement the members route**

`app/src/routes/relayGroups.ts:483-505` - replace from `const members = await Promise.all(` through `res.json({ members });` with:

```ts
    // The roster's stored name is a creation-time snapshot. Resolve every
    // member's CURRENT contact name in ONE batch (lib/participantNames):
    //   contact name (readable, non-deleted, non-empty)
    //   -> the stored roster name
    //   -> nothing, and the dashboard renders this current roster phone
    //      (recipientLabel / groupThread: "full name, else formatted number").
    // The middle rung is the 2026-08-31 ruling: a read blip used to drop a name
    // the operator had a moment ago and show a bare number instead.
    const names = await resolveRosterNames([conversation], contacts, log);
    const members = withLiveNames(conversation.participants, names);
    res.json({ members });
```

Remove `nameFromContact` from the import at `:39` (its only use was `:491`). Add:

```ts
import { resolveRosterNames, withLiveNames } from '../lib/participantNames.js';
```

- [ ] **Step 4: Implement the calls passthrough**

`app/src/routes/api.ts:2201`, `res.json({ call, conversation });` becomes:

```ts
    // The quick-reply seam renders member names off this roster; resolve them
    // (one batch over one roster, lib/participantNames) rather than hand the
    // client the creation-time snapshot.
    const [hydrated] = await hydrateConversationRosters([conversation], contacts, log);
    res.json({ call, conversation: hydrated });
```

Import `hydrateConversationRosters` from `'../lib/participantNames.js'`. `contacts` is `:635`, `log` is `:558`.

- [ ] **Step 5: Verify GREEN**

Run: `cd app && npx vitest run test/relayApi.test.ts test/voiceWebhook.test.ts test/relayGroupPreview.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/relayGroups.ts app/src/routes/api.ts app/test/relayApi.test.ts app/test/voiceWebhook.test.ts
git commit -m "feat(relay): members panel batches contact names and keeps the stored fallback; calls passthrough hydrated

REVERSES the 2026-07 ruling pinned by two relayApi tests ('drops the
creation-time name', 'falls back to the roster phone, not a stale name'):
per Cameron 2026-08-31 the stored name is the middle rung of the chain.
Both tests retitled and re-pinned."
```

---

### Task 6: People card precedence flip (+ the two `rosterEdits.ts` comments)

**Files:**
- Modify: `app/src/lib/rosterResolution.ts:556-564` (the comment block and the `const name =` expression; line `:565` `let sharesPhoneWithName` is NOT touched)
- Modify (COMMENTS ONLY): `app/src/services/rosterEdits.ts:440-441` and `:454-456`
- Test: `app/test/rosterResolution.test.ts`; re-baseline recipient names in `app/test/relayGroupPreview.test.ts`, `app/test/toursApi.test.ts`, `app/test/placementsApi.test.ts` ONLY if they fail.

- [ ] **Step 1: Write the test** (RED)

`app/test/rosterResolution.test.ts` has no `describeRoster` describe block (only `describeRosterActions` at `:522`). Add a new one after the `resolveRoster` blocks, using the file's `makeDeps`, `relayGroup`, `contact`, `TOUR` and importing `describeRoster` (already imported at `:16`):

```ts
describe('describeRoster - name precedence (M1)', () => {
  it('FACT mode: the contact name beats a stale stored roster name; a removed contact keeps the row name', async () => {
    const deps = makeDeps({
      conversations: {
        'conv-1': relayGroup('conv-1', [
          { contactId: 'c-tenant', phone: '+15550100001', name: 'Old Tina' },
          { contactId: 'c-gone', phone: '+15550100002', name: 'Gone Person' },
        ]),
      },
      units: { 'unit-1': { unitId: 'unit-1', landlordId: 'c-owner', status: 'available' } },
      contacts: {
        'c-tenant': contact('c-tenant', '+15550100001', 'Tina'),
        'c-gone': { ...contact('c-gone', '+15550100002', 'Deleted'), deleted_at: '2026-01-01T00:00:00.000Z' },
      },
    });
    const view = await describeRoster(deps, { ...TOUR, groupThreadId: 'conv-1' });
    expect(view.members.map((m) => m.name)).toEqual(['Tina Person', 'Gone Person']);
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `cd app && npx vitest run test/rosterResolution.test.ts -t "name precedence"`
Expected: FAIL - `['Old Tina', 'Gone Person']`.

- [ ] **Step 3: Implement**

`app/src/lib/rosterResolution.ts:556-564` - replace the comment and the `const name =` expression (leave `:565` `let sharesPhoneWithName` alone):

```ts
    // Display name: the CONTACT's current name first (we read it two
    // paragraphs up), then whatever the row itself stored. The stored name is
    // a creation-time snapshot; the card and the tabs must say "Tina Tenant"
    // today, not on the day the group was made. Display only: reachability
    // keeps the STORED phone, and a removed contact keeps the row's own name.
    const name =
      (!removed && contact !== undefined ? displayName(contact) : undefined) ?? nonEmpty(member.name);
```

`app/src/services/rosterEdits.ts:440-441` (comment only) becomes:

```ts
/** One row the confirm dialog lists, with the DISPLAY name - the contact's
 *  current name when readable, else the stored roster name - so it may differ
 *  from the body name. */
```

and `:454-456` (comment only): change `the recipient list from \`describeRoster\` (backfilled names)` to `the recipient list from \`describeRoster\` (contact-first names, stored name as the fallback)`.

- [ ] **Step 4: Run the suites this reaches**

Run: `cd app && npx vitest run test/rosterResolution.test.ts test/rosterEdits.test.ts test/relayGroupPreview.test.ts test/toursApi.test.ts test/placementsApi.test.ts`
Expected: PASS, or failures ONLY in preview `recipients[].name` expectations where a fixture's stored roster name differs from its contact's name. For each such failure: confirm the diff is in a recipient `name` (never in a `body` string), then update that expectation to the contact-derived name. If a `body` string changes, STOP - that is phase-b's territory - and report it.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/rosterResolution.ts app/src/services/rosterEdits.ts app/test/rosterResolution.test.ts
# plus any of the three preview test files you re-baselined
git commit -m "feat(roster): describeRoster prefers the contact name over the stored snapshot"
```

Name every re-baselined file and the count of moved expectations in the commit body.

---

### Task 7: Push sender label and voice masked label

**Files:**
- Modify: `app/src/routes/webhooks/twilio.ts:301-316`, `app/src/routes/webhooks/voice.ts:109-121`, `app/src/lib/voiceMasking.ts`
- Test: `app/test/voiceMasking.test.ts` (create if absent), `app/test/voiceWebhook.test.ts`, `app/test/inboundMessagePush.test.ts:495-524`

**Interfaces:**
- Produces: `shortNameFromFull(full: string | undefined): string | undefined` in `lib/voiceMasking.ts`.

**This changes SPOKEN content too.** `maskedPartyLabel` feeds both the persisted `call_party_label` (`voice.ts:985-986`) and the whisper's `callerLabel` (`:991` -> `:1044` query string -> `/whisper` `gather.say` at `:1307`). A callee will hear "Bob B." where they used to hear "Bob Builder". Spec S4 accepts that; pin it.

- [ ] **Step 1: Write the tests** (RED)

`app/test/voiceMasking.test.ts` (add to it if it exists):

```ts
import { describe, expect, it } from 'vitest';
import { shortNameFromFull } from '../src/lib/voiceMasking.js';

describe('shortNameFromFull', () => {
  it('masks a stored full name the way contactShortName masks a contact', () => {
    expect(shortNameFromFull('Bob Builder')).toBe('Bob B.');
    expect(shortNameFromFull('Bob')).toBe('Bob');
    expect(shortNameFromFull('  Ada   Lovelace-Byron ')).toBe('Ada L.');
    expect(shortNameFromFull('')).toBeUndefined();
    expect(shortNameFromFull(undefined)).toBeUndefined();
  });
});
```

`app/test/voiceWebhook.test.ts`, beside `persists a metadata-only, masked call entry`:

```ts
  it('RED: call_party_label prefers the CONTACT (masked) over the stored roster name', async () => {
    const world = createFakeWorld();
    world.contacts.push({ contactId: 'c-bob', type: 'landlord', phone: BOB, firstName: 'Robert', lastName: 'Renamed' });
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });
    await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoiceParams());
    const call = world.messages.find((m) => m.type === 'call')!;
    expect(call.call_party_label).toBe('Robert R.');
  });

  it('RED: a stored full name with no contact is masked in the persisted label AND the spoken whisper', async () => {
    const world = createFakeWorld();
    seedRelay(world, { participants: [
      { contactId: '', phone: ALICE, name: 'Alice Anderson' },
      { contactId: '', phone: BOB, name: 'Bob Builder' },
    ] });
    const { app } = makeWebhookHarness({ world });
    const res = await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoiceParams());
    const call = world.messages.find((m) => m.type === 'call')!;
    expect(call.call_party_label).toBe('Bob B.');
    // The whisper URL carries the CALLER's label - what the callee hears.
    expect(res.text).toContain(`callerLabel=${encodeURIComponent('Alice A.')}`);
  });
```

`app/test/inboundMessagePush.test.ts`, in the `'inbound message push - native group text'` describe (`:494`), after `'uses roster NAMES once the members are known contacts'`:

```ts
  it('RED: the body prefix prefers the CONTACT name over a stale roster name', async () => {
    const thread = world.conversations.get(GROUP_ID)!;
    thread.participants = (thread.participants ?? []).map((p) =>
      p.phone === SENDER ? { ...p, contactId: 'c-ana', name: 'Old Ana' } : p,
    );
    world.contacts.push({ contactId: 'c-ana', type: 'tenant', phone: SENDER, firstName: 'Ana', lastName: 'Reyes' });
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());

    expect(soleMessagePayload(world).body).toBe('Ana Reyes: hello, looking for a 2 bed');
  });
```

(`GROUP_ID`, `SENDER`, `SMS_PATH`, `groupParams`, `soleMessagePayload`, `world` are that describe's existing fixtures.) The push TITLE in this test stays whatever `groupThreadLabel` makes of the stored roster - the title is out of scope (spec section 3) - so assert only `.body`.

- [ ] **Step 2: Verify RED**

Run: `cd app && npx vitest run test/voiceMasking.test.ts test/voiceWebhook.test.ts test/inboundMessagePush.test.ts -t "RED|shortNameFromFull"`
Expected: FAIL - `shortNameFromFull` missing; labels `'Bob'`, `'Bob Builder'`, `Alice Anderson`; body `'Old Ana: ...'`.

- [ ] **Step 3: Implement**

`app/src/lib/voiceMasking.ts`, after `contactShortName`:

```ts
/**
 * The same "First L." mask applied to an already-joined name string (a stored
 * roster snapshot). A persisted or spoken masked label must never carry a
 * full surname, whichever rung supplied it.
 */
export function shortNameFromFull(full: string | undefined): string | undefined {
  if (typeof full !== 'string') return undefined;
  const parts = full.trim().split(/\s+/).filter((p) => p.length > 0);
  const first = parts[0];
  if (first === undefined) return undefined;
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  return last === undefined ? first : `${first} ${last.charAt(0)}.`;
}
```

`app/src/routes/webhooks/voice.ts:109-121`:

```ts
/**
 * A neutral, masked party label for a participant: the CONTACT's masked name
 * ("First L.", lib/voiceMasking) when the contact is readable, else the stored
 * roster name put through the same mask, else the role ("Tenant"/"Landlord"),
 * else the generic "the other party". NEVER the raw phone (PII, doc section 9),
 * and never an unmasked full name: this label is PERSISTED as call_party_label
 * AND spoken to the callee as the whisper's caller name. Contact-first since
 * 2026-09-01 (the roster name is a creation-time snapshot). `role` comes from
 * the reviewed contact type (honesty rule - only tenant/landlord claim a role).
 */
function maskedPartyLabel(member: ConversationParticipant | undefined, contact: ContactItem | undefined): string {
  const masked = contactShortName(contact) ?? shortNameFromFull(member?.name);
  if (masked !== undefined) return masked;
  if (contact?.type === 'tenant') return 'Tenant';
  if (contact?.type === 'landlord') return 'Landlord';
  return 'the other party';
}
```

Add `shortNameFromFull` to the existing `lib/voiceMasking.js` import in that file.

`app/src/routes/webhooks/twilio.ts:301-316`:

```ts
/**
 * The sender label for group/relay push bodies: contact display name ->
 * roster name -> formatted phone -> the raw From. Contact-first since
 * 2026-09-01 (the roster name is a creation-time snapshot). All three inputs
 * are already in scope at every persist point, so a push adds NO repo lookup to
 * the hot path. Pure, no I/O, no logging.
 */
function pushSenderLabel(
  rosterName: string | undefined,
  senderContact: ContactItem | undefined,
  from: string,
): string {
  const live = contactDisplayName(senderContact);
  if (live !== undefined) return live;
  const roster = typeof rosterName === 'string' ? rosterName.trim() : '';
  if (roster.length > 0) return roster;
  return formatPhoneForDisplay(from) ?? from;
}
```

- [ ] **Step 4: Verify GREEN**

Run: `cd app && npx vitest run test/voiceMasking.test.ts test/voiceWebhook.test.ts test/inboundMessagePush.test.ts test/founderTriage.test.ts test/voiceOutbound.test.ts && npm run typecheck`
Expected: PASS. Existing pins hold: `'Bob'` (single token), `'Tenant (Jane D.)'` and `'Unknown caller'` (from `pushCallerIdentity`, untouched), `'Alice: ...'` (no contact seeded for `c-alice`).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/voiceMasking.ts app/src/routes/webhooks/voice.ts app/src/routes/webhooks/twilio.ts app/test/voiceMasking.test.ts app/test/voiceWebhook.test.ts app/test/inboundMessagePush.test.ts
git commit -m "feat(push,voice): sender and party labels prefer the contact; masked label never unmasks (whisper included)"
```

---

### Task 8: Drift audit - group rosters

**Files:**
- Create: `app/src/lib/rosterDriftTally.ts`
- Modify: `app/scripts/measure-unread-contact-coverage.ts` (`auditDenorm` at `:473`; the `:785` skip is a DIFFERENT mode, `auditTabVsPartition`, and is not touched)
- Test: `app/test/rosterDriftTally.test.ts` (new)

**Interfaces:**
- Produces in `lib/rosterDriftTally.ts`:
  - `tallyRosterDrift(rosters, contacts: ReadonlyMap<string, ContactDisplayItem>): RosterDriftTally` with `rosters, members, withContactId, nameMissingButKnown, nameDrift, danglingContactId, deletedContact, noContactId`.
  - `collectGroupRosters(conversations: Pick<ConversationsRepo, 'listGroupTexts' | 'listRelayGroups'>): Promise<{ rosters: ConversationParticipant[][]; groupTextTruncated: boolean; relayTruncated: string[] }>` - the SOURCING that was the actual S5 defect, testable with fakes.

- [ ] **Step 1: Write the tests** (RED)

`app/test/rosterDriftTally.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { collectGroupRosters, tallyRosterDrift } from '../src/lib/rosterDriftTally.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';

describe('tallyRosterDrift', () => {
  it('classifies every member exactly once', () => {
    const tally = tallyRosterDrift(
      [
        [
          { contactId: 'c-ok', phone: '+1', name: 'Ada Ok' },
          { contactId: 'c-missing', phone: '+2' },
          { contactId: 'c-drift', phone: '+3', name: 'Old Name' },
          { contactId: 'c-dangling', phone: '+4', name: 'Ghost' },
          { contactId: 'c-deleted', phone: '+6', name: 'Was Here' },
          { contactId: '', phone: '+5', name: 'Bare' },
        ],
        [{ contactId: 'c-ok', phone: '+1', name: 'Ada Ok' }],
      ],
      new Map([
        ['c-ok', { contactId: 'c-ok', firstName: 'Ada', lastName: 'Ok' }],
        ['c-missing', { contactId: 'c-missing', firstName: 'Has', lastName: 'Name' }],
        ['c-drift', { contactId: 'c-drift', firstName: 'New', lastName: 'Name' }],
        ['c-deleted', { contactId: 'c-deleted', firstName: 'Re', lastName: 'Named', deleted_at: '2026-01-01T00:00:00.000Z' }],
      ]),
    );
    expect(tally).toEqual({
      rosters: 2, members: 7, withContactId: 6,
      nameMissingButKnown: 1, nameDrift: 1, danglingContactId: 1, deletedContact: 1, noContactId: 1,
    });
  });
});

describe('collectGroupRosters', () => {
  it('sources group_text pages AND every relay partition - the walk the old audit never did', async () => {
    const conv = (id: string, participants: { contactId: string; phone: string }[]): ConversationItem =>
      ({ conversationId: id, participants, type: 'group_text', status: 'group_open', last_activity_at: 'x', created_at: 'x', ai_mode: 'manual' }) as ConversationItem;
    const relayCalls: string[] = [];
    const out = await collectGroupRosters({
      async listGroupTexts(opts) {
        return opts?.cursor === undefined
          ? { items: [conv('gt-1', [{ contactId: 'a', phone: '+1' }])], nextCursor: 'page2', truncated: false }
          : { items: [conv('gt-2', [{ contactId: 'b', phone: '+2' }])], truncated: false };
      },
      async listRelayGroups(status) {
        relayCalls.push(status);
        return { items: [conv(`rg-${status}`, [{ contactId: status, phone: '+9' }])], truncated: status === 'closed' };
      },
    });
    expect(out.rosters).toHaveLength(5);
    expect(relayCalls).toEqual(['open', 'connecting', 'closed']);
    expect(out.relayTruncated).toEqual(['closed']);
    expect(out.groupTextTruncated).toBe(false);
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `cd app && npx vitest run test/rosterDriftTally.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement**

`app/src/lib/rosterDriftTally.ts`:

```ts
// rosterDriftTally - the pure count and the sourcing behind the --audit-denorm
// group pass in app/scripts/measure-unread-contact-coverage.ts. Counts only,
// never names.
//
// Sourcing is the part that was broken: the 1:1 walk reads the 'open'
// partition, which never returns a native group text (status `group_open`) or
// a closed relay group. Groups need listGroupTexts + listRelayGroups.
import { contactDisplayName } from './contactName.js';
import { isDeleted, type ContactDisplayItem } from '../repos/contactsRepo.js';
import type { ConversationParticipant, ConversationsRepo } from '../repos/conversationsRepo.js';

export interface RosterDriftTally {
  rosters: number;
  members: number;
  withContactId: number;
  /** contact has a name; the row stores none */
  nameMissingButKnown: number;
  /** both present and different */
  nameDrift: number;
  /** contactId present, no contact behind it (or the read did not return it) */
  danglingContactId: number;
  /** contact is soft-deleted: the read path deliberately leaves these alone */
  deletedContact: number;
  /** bare-phone member */
  noContactId: number;
}

export function tallyRosterDrift(
  rosters: readonly (readonly ConversationParticipant[])[],
  contacts: ReadonlyMap<string, ContactDisplayItem>,
): RosterDriftTally {
  const t: RosterDriftTally = {
    rosters: rosters.length, members: 0, withContactId: 0, nameMissingButKnown: 0,
    nameDrift: 0, danglingContactId: 0, deletedContact: 0, noContactId: 0,
  };
  for (const roster of rosters) {
    for (const p of roster) {
      t.members += 1;
      if (typeof p.contactId !== 'string' || p.contactId.length === 0) { t.noContactId += 1; continue; }
      t.withContactId += 1;
      const contact = contacts.get(p.contactId);
      if (contact === undefined) { t.danglingContactId += 1; continue; }
      if (isDeleted(contact)) { t.deletedContact += 1; continue; }
      const want = contactDisplayName(contact);
      const have = typeof p.name === 'string' && p.name.trim().length > 0 ? p.name.trim() : undefined;
      if (want !== undefined && have === undefined) t.nameMissingButKnown += 1;
      else if (want !== undefined && have !== undefined && want !== have) t.nameDrift += 1;
    }
  }
  return t;
}

/** Every group_text page plus all three relay partitions. */
export async function collectGroupRosters(
  conversations: Pick<ConversationsRepo, 'listGroupTexts' | 'listRelayGroups'>,
): Promise<{ rosters: ConversationParticipant[][]; groupTextTruncated: boolean; relayTruncated: string[] }> {
  const rosters: ConversationParticipant[][] = [];
  let groupTextTruncated = false;
  let cursor: string | undefined;
  do {
    const page = await conversations.listGroupTexts({ limit: 100, ...(cursor !== undefined && { cursor }) });
    for (const conv of page.items) rosters.push(conv.participants ?? []);
    groupTextTruncated ||= page.truncated;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  const relayTruncated: string[] = [];
  for (const status of ['open', 'connecting', 'closed'] as const) {
    const { items, truncated } = await conversations.listRelayGroups(status);
    for (const conv of items) rosters.push(conv.participants ?? []);
    if (truncated) relayTruncated.push(status);
  }
  return { rosters, groupTextTruncated, relayTruncated };
}
```

- [ ] **Step 4: Wire the script**

In `app/scripts/measure-unread-contact-coverage.ts`, add beside the other `../src/` imports:

```ts
import { collectGroupRosters, tallyRosterDrift } from '../src/lib/rosterDriftTally.js';
import type { ContactDisplayItem } from '../src/repos/contactsRepo.js';
```

Add after `auditDenorm` and call `await auditGroupRosters();` as the LAST line of `auditDenorm` (after its `console.log([...])`):

```ts
/**
 * The GROUP half of --audit-denorm. Sourcing lives in lib/rosterDriftTally so
 * it can be tested: the 1:1 walk above never sees a group_text or a closed
 * relay. Counts only, never names. A requested id the batch did not return is
 * reported separately from a genuinely dangling id, so a throttle never reads
 * as data corruption.
 */
async function auditGroupRosters(): Promise<void> {
  const { rosters, groupTextTruncated, relayTruncated } = await collectGroupRosters(conversations);
  const ids = new Set<string>();
  for (const roster of rosters) for (const p of roster) if (p.contactId !== '') ids.add(p.contactId);
  const idList = [...ids];
  const found = new Map<string, ContactDisplayItem>();
  for (let i = 0; i < idList.length; i += 100) {
    for (const [k, v] of await contacts.getDisplaysByIds(idList.slice(i, i + 100))) found.set(k, v);
  }
  const unreturned = idList.length - found.size;
  const t = tallyRosterDrift(rosters, found);
  console.log(
    [
      '',
      'Group roster names - drift audit',
      '================================',
      `  rosters walked          ${t.rosters}${groupTextTruncated ? '  (group_text walk TRUNCATED)' : ''}${relayTruncated.length > 0 ? `  (relay ${relayTruncated.join('/')} TRUNCATED)` : ''}`,
      `  members                 ${t.members}`,
      `    with contactId        ${t.withContactId}`,
      `      name MISSING, known ${t.nameMissingButKnown}  <- contact has a name; roster stores none`,
      `      name DIFFERS        ${t.nameDrift}  <- roster shows a different name than the contact`,
      `      soft-deleted        ${t.deletedContact}  <- the read path leaves these on the stored name`,
      `      dangling contactId  ${t.danglingContactId}  <- no contact returned for the id`,
      `    no contactId          ${t.noContactId}  <- bare-phone member; nothing to resolve`,
      '',
      `  ids requested ${idList.length}, returned ${found.size}, NOT RETURNED ${unreturned}` +
        (unreturned > 0 ? '  <- a short batch (throttle?) inflates "dangling"; re-run before trusting it' : ''),
      '',
    ].join('\n'),
  );
}
```

`conversations` and `contacts` are the script's module-level repos.

- [ ] **Step 5: Verify**

Run: `cd app && npx vitest run test/rosterDriftTally.test.ts && npm run typecheck`
Expected: PASS, typecheck 0.

Then, with DynamoDB Local up (`npm run db:start` from the root) and an e2e lane seeded with the `full` profile (`npm run e2e:session`), run the script ONCE against that lane the way its header comment documents (the lane's `DYNAMODB_ENDPOINT` and table prefix come from `scripts/e2e-session.mjs`'s output). Expected: both audit blocks print, `NOT RETURNED 0`, exit 0. Record the group block in `.superpowers/sdd/audit-lane.txt` (run state) - the same numbers go in the handback. Do NOT run it against any deployed environment.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/rosterDriftTally.ts app/test/rosterDriftTally.test.ts app/scripts/measure-unread-contact-coverage.ts
git commit -m "feat(audit): --audit-denorm walks group rosters from their own partitions"
```

---

### Task 9: E2E - a rename shows on Today, the group header, the contact card

**Files:**
- Modify: `e2e/scenarios/steps.ts` (two public additions)
- Create: `e2e/tests/scenarios/participant-names.spec.ts`

- [ ] **Step 1: Add the two public members**

In `e2e/scenarios/steps.ts`, next to `teamTriagesUnknownToTenant` (`:711`):

```ts
  /** [Team] Rename the active tenant via the contact page's edit form. */
  teamRenamesActiveTenant(t: Tenant, fields: { firstName: string; lastName: string }): Promise<void> {
    return step('Team renames the tenant', async () => {
      await this.openActiveContact(t);
      await this.editTenantIdentity(fields);
    });
  }
```

and next to `contactId()` (`:3531`):

```ts
  /** The active tour's relay-group conversation id (set by teamOpensTourGroup). */
  activeTourGroupId(): string {
    return this.requireActiveTourGroup().groupThreadId;
  }
```

- [ ] **Step 2: Write the spec**

`e2e/tests/scenarios/participant-names.spec.ts`:

```ts
// e2e/tests/scenarios/participant-names.spec.ts
//
// M1 (2026-08-31): a contact's name is resolved when a surface renders, not
// copied onto the conversation when it is created. One flow: open a tour relay
// group, rename the tenant, then assert the NEW name on the three surfaces the
// founder reported stale - Today, the group thread header, the Relay groups
// card on the contact file.
//
// The header assertion reads the `With ...` facts line, which the relay view
// builds from GET /conversations/:id/members (Task 5) - the thread-header
// passthrough itself is deliberately not hydrated (spec section 3).
import { expect, test } from '@playwright/test';
import { Scenario, freshLandlord, freshTenant, type Contact } from '../../scenarios/steps.js';
import { expectTodayReady } from '../../support/today.js';
import { useScenarioBudget } from '../../support/scenarioBudget.js';

useScenarioBudget();

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

test('renaming a contact shows on Today, the group header and the contact card', async ({ page, request }) => {
  const flow = new Scenario(page, request);
  await flow.login();
  const owner = freshLandlord('PNOwner');
  await flow.teamCreatesLandlord({ firstName: owner.firstName, lastName: owner.lastName, phone: owner.phone });
  const ownerId = flow.landlordId();
  const unit = await flow.seedAvailableUnit({ beds: 2, landlordId: ownerId });
  const tenant = freshTenant('PNTenant');
  await flow.teamCreatesTenant({ firstName: tenant.firstName, lastName: tenant.lastName, phone: tenant.phone });
  await flow.seedTenantSearching();
  await flow.tenantAsksToTour(unit);
  await flow.teamCreatesTourFromInterest(unit, 'Landlord-led');
  // No time booked, so the group opens on the naked intro (the default variant).
  await flow.teamOpensTourGroup();

  const renamed: Contact = { ...tenant, firstName: `${tenant.firstName}X`, lastName: 'Renamed', name: `${tenant.firstName}X Renamed` };
  await flow.teamRenamesActiveTenant(tenant, { firstName: renamed.firstName, lastName: renamed.lastName });

  // An unread 1:1 from the tenant puts them on Today's Unreplied list.
  await flow.tenantTexts(tenant, 'Is the tour still on?');

  // 1. Today names the person by the NEW name.
  await page.goto(`${NEXT}/today`);
  await expectTodayReady(page);
  await expect(page.getByText(renamed.name, { exact: false }).first()).toBeVisible({ timeout: 15_000 });

  // 2. The OWNER's contact file: its Relay groups card is named for the tenant.
  await flow.expectGroupOnContactFile(renamed, ownerId);

  // 3. The group thread header's facts line, after a fresh load.
  await page.goto(`${NEXT}/conversations/${flow.activeTourGroupId()}`);
  await expect(page.getByText(new RegExp(`^With .*${renamed.firstName}`))).toBeVisible({ timeout: 15_000 });
});
```

`tours.spec.ts:98-104` is the precedent for `new Scenario(page, request)` and this setup order.

- [ ] **Step 3: Run it alone first**

Run from the root: `npm run e2e -- --grep "renaming a contact"`. If the root script does not forward `--grep`, run the single spec the way `e2e/README.md` documents. Expected: PASS. Iterate on selectors only against the hermetic lane - never the human's `:5174`/`:8080`.

- [ ] **Step 4: Commit**

```bash
git add e2e/scenarios/steps.ts e2e/tests/scenarios/participant-names.spec.ts
git commit -m "test(e2e): a rename shows on Today, the group header and the contact card"
```

---

### Task 10: Issues, fixtures, the measurement number

**Files:**
- Modify: `docs/issues/today-shows-phone-instead-of-name.md`, `docs/issues/group-roster-name-snapshot-never-refreshed.md`, `docs/issues/relay-stale-participant-phone.md`, `docs/issues/consolidate-contact-display-name-helpers.md`, `docs/issues/today-contact-hydration-fan-out.md`
- Create: `docs/issues/staff-only-roster-name-readers-stale.md` (copy `docs/issues/_TEMPLATE.md`)

- [ ] **Step 1: Fixtures** - `grep -rn "Synthetic tenant\|Synthetic participant\|Synthetic landlord" app/test e2e app/scripts` returns nothing (verified by both plan reviewers). No fixture work. Say so in Step 4's commit body.

- [ ] **Step 2: The Today read count** - in `app/test/todayApi.test.ts`, temporarily wrap `world.contactsRepo.getById` in the test that seeds the most contacts (`grep -c "seedTenant(" ` per `it` block) and print the DISTINCT contactId count for one `GET /api/today`. Record the number as `N`. Do not commit the instrumentation.

- [ ] **Step 3: Stamp the issues** - append a `**Resolution (2026-09-01, feat/participant-snapshot-refresh).**` paragraph and set frontmatter `status` as noted:

- `today-shows-phone-instead-of-name` -> `status: closed`. "Today's `who` resolves from the contact the deleted-check already memoized (zero new reads), then the stored name, then the phone. `routes/today.ts` `whoOfConversation`."
- `group-roster-name-snapshot-never-refreshed` -> `status: closed`. "Every operator-facing roster surface resolves names from the contact at read time with one batch per page (`lib/participantNames.ts`): inbox rows, contact cards, relay members panel, People card, calls passthrough, push sender, voice party label and whisper. NOT covered, stated: the two group push TITLES (`routes/webhooks/twilio.ts` on the ack path), the close-group confirm dialogs at `PlacementDetail.tsx:370` / `TourDetail.tsx:451`, and bare-phone relay members. The outbound intro/member-added bodies were rewritten by `feat/tour-reminder-ladder-phase-b`."
- `relay-stale-participant-phone` -> `status: closed`. "Ruling 2026-08-31: documented behavior, no code change. To correct a member's number, remove and re-add them; the group re-announces them, which is correct because their number really did change. `participants[].phone` is never rewritten by any name-resolution path."
- `consolidate-contact-display-name-helpers` stays `open`. Replace the "six copies" paragraph with the corrected census: thirteen private copies (`routes/contacts.ts`, `routes/units.ts`, `lib/rosterResolution.ts`, `services/groupMembers.ts`, `services/inboundEmail.ts`, `services/relayMembers.ts`, `services/groupConvert.ts`, `routes/api.ts` x2, `routes/inbox.ts`, `routes/today.ts`, `jobs/placementNudges.ts`, `routes/placements.ts`); `routes/inbox.ts` has an extra `contact.name` rung and `routes/today.ts` trims the outer join only, so neither can be re-pointed blind; `lib/voiceMasking.ts contactShortName` is a different rule, not a copy; `contactDisplayName` now accepts `ContactDisplayItem` and is consumed by `lib/participantNames.ts` and `lib/rosterDriftTally.ts` as well as the pushes.
- `today-contact-hydration-fan-out` -> if `N` < 30, `status: closed` with "Measured 2026-09-01 in the todayApi harness: N distinct contacts per GET /api/today. Closed wontfix per the issue's own rule." Otherwise leave open and record `N`.

New `docs/issues/staff-only-roster-name-readers-stale.md`, severity `low`, area `app`: "Three staff-only readers still render the stored roster name: `services/groupSend.ts:253` `memberLabel` (consent/deleted refusal strings), `services/relayGroupDuplicates.ts:68` `rosterMembers` (duplicate-group warning), `routes/poolNumbersAdmin.ts` `serverLabel`. All are off the request hot path. Fix: `withLiveNames` over the roster with one `getDisplaysByIds`, per `lib/participantNames.ts`."

Then from the root: `npm run issues`.

- [ ] **Step 4: Commit**

```bash
git add docs/issues/today-shows-phone-instead-of-name.md docs/issues/group-roster-name-snapshot-never-refreshed.md docs/issues/relay-stale-participant-phone.md docs/issues/consolidate-contact-display-name-helpers.md docs/issues/today-contact-hydration-fan-out.md docs/issues/staff-only-roster-name-readers-stale.md
git commit -m "docs(issues): close the M1 name-snapshot issues; correct the helper census; file the staff-only readers"
```

---

### Task 11: Gates and handback

- [ ] **Step 1: Sync main** (once, only if it moved: `git rev-list --count HEAD..main`): `git merge main` from the worktree. Resolve nothing silently; if `app/src/routes/relayGroups.ts` or a preview test conflicts, keep BOTH sides' intent and re-run Task 6 Step 4.

- [ ] **Step 2: Run all five gates, bare, from the worktree, recording each exit code:**

```
npm run typecheck
npm test
npm run smoke
npm run e2e
npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')
```

If `npm test` is red on DynamoDB suites only (timeouts, write locks, zero assertion failures), re-run under a clean key first: `cd app && AWS_ACCESS_KEY_ID=hccleanrun001 npx vitest run`. For lint, attribute every reported error by running the same command at `main` on the same paths; only errors present now and absent there are yours.

- [ ] **Step 3: Handback** to `docs/superpowers/reviews/2026-08-31-participant-snapshot-refresh/handback.md`: the five exit codes, the e2e result line, the audit block from Task 8 Step 5, `N` from Task 10, the preview expectations re-baselined in Task 6 (file + count), the two relayApi tests Task 5 retitled, and current `main` drift. Do not merge.

---

## Self-review (v2)

- **Spec coverage.** S1 -> Task 2 (who, close-nag, client guard). S2 -> Tasks 3 (inbox), 4 (cards), 5 (members + calls). S3 -> Task 6, including the two `rosterEdits.ts` comments the spec names. S4 -> Task 7, whisper pinned. S5 -> Task 8 (`:510` only; `:785` is a different mode). Tests -> each task + Task 9. Issues -> Task 10. Gates -> Task 11. `contactDisplayName` widening + docblock + import removal -> Task 1. Dependencies -> Task 0.
- **Placeholders.** None. The one grep-and-copy step from v1 (group-push test) is now written out against `inboundMessagePush.test.ts:494-524`'s fixtures.
- **Type consistency.** `resolveRosterNames(convs, contacts, log)`, `withLiveNames(participants, names)`, `hydrateConversationRosters(convs, contacts, log)` are used with those names and argument orders in Tasks 2-5 and 8. `groupRowFor(conv, names)` / `relayRowFor(conv, names)` match their four call sites. `shortNameFromFull` and `collectGroupRosters` are defined before use. `contactDisplayName`'s parameter carries the `contactId` anchor at its only definition.
- **Cost accounting** matches the spec's section 3 table after the amendments: one batch per card (hoisted out of the status loop), two on `filter=all`, one per multi-party row on `filter=unread`.
