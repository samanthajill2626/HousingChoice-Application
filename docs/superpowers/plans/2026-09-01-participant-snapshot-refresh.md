# Participant Names: Resolve on Read - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every staff-facing surface renders a participant's CURRENT contact name, falling back to the stored snapshot, then the phone - with at most one batched contact read per page.

**Architecture:** One new pure module (`lib/participantNames.ts`) resolves a roster's names from a `getDisplaysByIds` map in memory. Each read boundary collects contact ids, does ONE batch read, and hands the existing label functions a fresher roster. Surfaces that already hold the contact (Today, People card, push, voice) just flip their precedence. No client changes except one empty-string guard.

**Tech Stack:** TypeScript, Express, Vitest (`app/test`), Playwright (`e2e`), DynamoDB Local.

**Spec:** `docs/superpowers/specs/2026-08-31-participant-snapshot-refresh-design.md`

## Global Constraints

- The name chain is exactly: live contact name -> stored `participants[].name` / `participant_display_name` -> formatted phone.
- Batch reads use `contactsRepo.getDisplaysByIds`. Never `getById` per member. Never `findByPhone` on a request path. Never `requireComplete`.
- A soft-deleted contact (`isDeleted`) supplies NO name; fall to the stored snapshot.
- `participants[].phone` is never modified anywhere.
- Do not edit: `jobs/relayFanOut.ts`, `services/rosterEdits.ts` source (its test pins may move), `services/relayAnnouncements.ts`, `lib/unreadFeed.ts`, `jobs/tourReminders.ts`, `routes/api.ts` `GET /conversations/:id` (`:2004`) or `GET /group-members` (`:2020`).
- New/touched lines in specs, issues, tests, comments and log strings are ASCII-only. Never rewrite a file with a PowerShell `Get-Content | Set-Content` pipeline.
- Commit explicit paths only (`git add <paths>`); never `git add -A`. Read `git status` before every commit. Every commit carries `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Run every gate BARE from `W:\tmp\participant-snapshot-refresh` - never piped.
- Line numbers below are as of `b702a81c`. If one does not match, find the symbol named beside it.

Worktree: `W:\tmp\participant-snapshot-refresh`, branch `feat/participant-snapshot-refresh`. All commands run from that directory; `cd app` where noted.

---

### Task 1: `participantNames` module + widen `contactDisplayName`

**Files:**
- Create: `app/src/lib/participantNames.ts`
- Modify: `app/src/lib/contactName.ts:50-73`
- Test: `app/test/participantNames.test.ts` (new)

**Interfaces:**
- Produces:
  - `contactDisplayName(contact: { firstName?: unknown; lastName?: unknown } | undefined): string | undefined` (widened; existing callers unchanged)
  - `collectRosterContactIds(convs: readonly Pick<ConversationItem, 'participants'>[]): string[]`
  - `resolveRosterNames(convs, contacts: Pick<ContactsRepo, 'getDisplaysByIds'>, log: Logger): Promise<ReadonlyMap<string, ContactDisplayItem>>` - never rejects; a throw yields an EMPTY map and a warn.
  - `withLiveNames(participants: readonly ConversationParticipant[] | undefined, names: ReadonlyMap<string, ContactDisplayItem>): ConversationParticipant[]`
  - `hydrateConversationRosters<T extends ConversationItem>(convs: readonly T[], contacts, log): Promise<T[]>` - `resolveRosterNames` + `withLiveNames` per row, new objects.

- [ ] **Step 1: Write the failing tests**

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

Also append to `app/test/contactName.test.ts`:

```ts
import type { ContactDisplayItem } from '../src/repos/contactsRepo.js';

describe('contactDisplayName accepts the display projection', () => {
  it('joins trimmed parts from a ContactDisplayItem', () => {
    const item: ContactDisplayItem = { contactId: 'c', firstName: ' Ada ', lastName: 'Lovelace ' };
    expect(contactDisplayName(item)).toBe('Ada Lovelace');
  });
});
```

(Keep the file's existing imports; `contactDisplayName` is already imported there.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd app && npx vitest run test/participantNames.test.ts test/contactName.test.ts`
Expected: FAIL - `participantNames.js` cannot be resolved; the contactName test fails typecheck-free at runtime only if you also run `npm run typecheck` (it will: `ContactDisplayItem` is not assignable to `ContactItem`).

- [ ] **Step 3: Widen `contactDisplayName`**

Replace `app/src/lib/contactName.ts:50-73` with:

```ts
// contactDisplayName - THE trimmed "First Last" join for any surface that
// holds a contact (or the display projection of one).
//
// Accepts the MINIMAL shape both contact reads satisfy - a whole ContactItem
// (getById / getManyByIds) and the ContactDisplayItem projection
// (getDisplayById / getDisplaysByIds) - so a label-only batch read never has to
// widen to a whole-item read just to name someone.
//
// Consumers (2026-09-01): the inbound-message and voice pushes, and the
// participant-name resolver in lib/participantNames.ts (inbox rows, contact
// cards, relay members, Today's relay close-nag). Private copies of this
// derivation still exist in routes/inbox.ts and routes/today.ts and DIFFER from
// this one on purpose (an extra `contact.name` rung; outer-vs-part trimming);
// see docs/issues/consolidate-contact-display-name-helpers.md before
// re-pointing any of them.
//
// `firstName`/`lastName` are NOT declared string fields - they ride an index
// signature or are typed `unknown` - so both reads are defensive: a non-string
// value must never reach `.trim()`.

/** Trimmed first/last join, or undefined when the contact has no name. */
export function contactDisplayName(
  contact: { firstName?: unknown; lastName?: unknown } | undefined,
): string | undefined {
  if (contact === undefined) return undefined;
  const first = typeof contact.firstName === 'string' ? contact.firstName.trim() : '';
  const last = typeof contact.lastName === 'string' ? contact.lastName.trim() : '';
  const joined = [first, last].filter((p) => p.length > 0).join(' ');
  return joined.length > 0 ? joined : undefined;
}
```

The `ContactItem` type import at the top of the file is still used by `parseContactName`'s neighbours? Check: if `ContactItem` is now unused, delete the import line (`import type { ContactItem } ...`) or `npm run lint` on the file will flag it.

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

- [ ] **Step 5: Run to verify they pass**

Run: `cd app && npx vitest run test/participantNames.test.ts test/contactName.test.ts && npm run typecheck`
Expected: PASS, typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/participantNames.ts app/src/lib/contactName.ts app/test/participantNames.test.ts app/test/contactName.test.ts
git commit -m "feat(names): participantNames resolver; contactDisplayName accepts the display projection"
```

---

### Task 2: Today - `who` from the memoized contact; close-nag names hydrated

**Files:**
- Modify: `app/src/routes/today.ts:776-778` (call site), `:994-1002` (close nag), `:1072-1080` (`whoOfConversation`)
- Test: `app/test/todayApi.test.ts`

**Interfaces:**
- Consumes: `hydrateConversationRosters` (Task 1). `getContact` memo at `today.ts:357`, `nameFromContact` at `:222`, `oneToOneContactId` at `:1086`.
- Produces: `whoOfConversation(conv: ConversationItem, contact: ContactItem | undefined): string`.

- [ ] **Step 1: Write the failing tests**

Add to `app/test/todayApi.test.ts` inside the top-level `describe`, using its existing `seedConversation`, `seedTenant`, `getItems`, `iso` helpers and `world`:

```ts
  describe('participant names resolve on read (M1)', () => {
    const seedUnreadTenantThread = (name: string | undefined) =>
      seedConversation({
        conversationId: 'conv-renamed',
        participant_phone: '+15550107777',
        participants: [{ contactId: 't-renamed', phone: '+15550107777' }],
        status: 'open',
        last_activity_at: iso(-30_000),
        type: 'tenant_1to1',
        ai_mode: 'auto',
        created_at: iso(-60_000),
        unread_count: 1,
        ...(name !== undefined && { participant_display_name: name }),
      });

    it('a stale participant_display_name loses to the contact name', async () => {
      seedTenant('t-renamed', 'Renata', 'New');
      seedUnreadTenantThread('Old Name');
      const row = (await getItems()).find((i) => i.refId === 't-renamed');
      expect(row?.who).toBe('Renata New');
    });

    it('a thread with no stored name and a named contact shows the contact', async () => {
      seedTenant('t-renamed', 'Renata', 'New');
      seedUnreadTenantThread(undefined);
      const row = (await getItems()).find((i) => i.refId === 't-renamed');
      expect(row?.who).toBe('Renata New');
    });

    it('an unreadable contact keeps the stored name', async () => {
      seedUnreadTenantThread('Stored Name');
      const real = world.contactsRepo.getById.bind(world.contactsRepo);
      world.contactsRepo.getById = async (id) => {
        if (id === 't-renamed') throw new Error('ProvisionedThroughputExceededException');
        return real(id);
      };
      const row = (await getItems()).find((i) => i.refId === 't-renamed');
      expect(row?.who).toBe('Stored Name');
    });

    it('resolving names adds NO contact reads - the deleted-check already memoized them', async () => {
      seedTenant('t-renamed', 'Renata', 'New');
      seedUnreadTenantThread('Old Name');
      const real = world.contactsRepo.getById.bind(world.contactsRepo);
      const reads: string[] = [];
      world.contactsRepo.getById = async (id) => { reads.push(id); return real(id); };
      await getItems();
      expect(reads.filter((id) => id === 't-renamed')).toHaveLength(1);
    });

    it('relay close-nag member names come from the contacts', async () => {
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
        relay_status: 'open',
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

If `seedConversation` in this file rejects unknown keys, check its signature (`grep -n "const seedConversation" app/test/todayApi.test.ts`) and pass the object through `as ConversationItem` the way its other callers do. If the harness's `listRelayGroups('open')` needs `relay_status` to find the row, keep that attribute; check `grep -n "listRelayGroups" app/test/helpers/twilioWebhookHarness.ts`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd app && npx vitest run test/todayApi.test.ts -t "participant names"`
Expected: FAIL - `who` is `'Old Name'` / `'(555) 010-7777'`; the close-nag test gets `'Old Nag'`.

- [ ] **Step 3: Implement**

`app/src/routes/today.ts:1072-1080`, replace `whoOfConversation`:

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

`today.ts:778`, the one call site, becomes:

```ts
        const ownerId = oneToOneContactId(conv);
        const who = whoOfConversation(conv, ownerId !== undefined ? await getContact(ownerId) : undefined);
```

(`ownerId` may already be declared in that loop from the deleted check at `:742`; if so, reuse it and drop the redeclaration.)

`today.ts:994-1002`, the close-nag loop: collect first, hydrate once, then map. Replace the `for (const conv of openGroups)` loop head and the `memberNames` computation:

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

Keep the rest of the loop body as it is. Add the import near the other `../lib/` imports:

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

- [ ] **Step 5: Run to verify they pass**

Run: `cd app && npx vitest run test/todayApi.test.ts && npm run typecheck`
Expected: PASS (the whole file - the pre-existing `who: '(555) 010-9999'` pins reference contacts never seeded, so they still hold).

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/today.ts app/test/todayApi.test.ts dashboard/src/routes/today/buildToday.ts
git commit -m "feat(today): who resolves from the memoized contact; close-nag names hydrated"
```

---

### Task 3: Inbox group and relay rows

**Files:**
- Modify: `app/src/routes/inbox.ts:1154` (`relayRowFor`), `:1190` (`groupRowFor`), call sites `:1237`, `:1418`, `:2293`, `:2358`
- Test: `app/test/inboxGroups.test.ts`

**Interfaces:**
- Consumes: `resolveRosterNames`, `withLiveNames` (Task 1).
- Produces: `groupRowFor(conv, names: ReadonlyMap<string, ContactDisplayItem>)`, `relayRowFor(conv, names)` (still async).

- [ ] **Step 1: Write the failing tests**

`app/test/inboxGroups.test.ts` - its `makeDeps` fakes `contactsRepo` with `findByPhone`/`getById`/`listByType` only. Add `getDisplaysByIds` to that fake (around `:102-117`), recording calls:

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

Add `displayBatches: string[][]` to the `Calls` interface and initialise it `displayBatches: []`. The seed's `contacts[].name` doubles as `firstName` here.

Then add tests (find the file's existing group-row test to copy `makeDeps` + request wiring from):

```ts
  it('titles a group row from the CONTACT names, one batch per page', async () => {
    const { deps, calls } = makeDeps({
      groups: [
        groupText('gt-1', [
          { contactId: 'c-a', phone: '+15550100001', name: 'Old A' },
          { contactId: 'c-b', phone: '+15550100002' },
        ]),
        groupText('gt-2', [{ contactId: 'c-a', phone: '+15550100001', name: 'Old A' }]),
      ],
      contacts: [
        { contactId: 'c-a', phone: '+15550100001', name: 'Ada' },
        { contactId: 'c-b', phone: '+15550100002', name: 'Bo' },
      ],
    });
    const res = await get(deps, '/api/inbox?filter=groups');
    const names = (res.body.rows as { conversationId: string; name: string }[]).map((r) => r.name);
    expect(names).toEqual(['With Ada & Bo', 'With Ada']);
    expect(calls.displayBatches).toHaveLength(1);
    expect(new Set(calls.displayBatches[0])).toEqual(new Set(['c-a', 'c-b']));
  });

  it('a relay row title uses the contact names too', async () => {
    const { deps } = makeDeps({
      relay: [relayGroup('rg-1', [{ contactId: 'c-a', phone: '+15550100001', name: 'Old A' }])],
      contacts: [{ contactId: 'c-a', phone: '+15550100001', name: 'Ada' }],
    });
    const res = await get(deps, '/api/inbox?filter=all');
    const row = (res.body.rows as { conversationId: string; name: string }[]).find((r) => r.conversationId === 'rg-1');
    expect(row?.name).toBe('With Ada');
  });
```

`groupText(...)`, `relayGroup(...)` and `get(...)` are whatever this file already uses to build a `ConversationItem` per kind and issue an authed request - read the file's first two tests and reuse their helpers verbatim (they exist under some name; do not invent a parallel harness). If `filter=all` does not include relay rows in this suite, use the filter its existing relay test uses.

- [ ] **Step 2: Run to verify they fail**

Run: `cd app && npx vitest run test/inboxGroups.test.ts`
Expected: the two new tests FAIL with `'With Old A & (555) 010-0002'` and `'With Old A'`.

- [ ] **Step 3: Implement**

Import at the top of `app/src/routes/inbox.ts`:

```ts
import { resolveRosterNames, withLiveNames } from '../lib/participantNames.js';
import type { ContactDisplayItem } from '../repos/contactsRepo.js';
```

(`ContactDisplayItem` may already be imported; check.)

`:1154` `relayRowFor` - add the map parameter and use it for the label:

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

Call sites:

`:1237`:
```ts
    const names = await resolveRosterNames(page.items, contacts, log);
    const groupRows = page.items.map((c) => groupRowFor(c, names));
```

`:1418`:
```ts
        const names = await resolveRosterNames([fresh], contacts, log);
        return {
          row: candidate.kind === 'relay_group' ? await relayRowFor(fresh, names) : groupRowFor(fresh, names),
        };
```

`:2293` - hoist one batch above the loop:
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

`contacts` and `log` are the router-scoped consts at `:715` and its logger; both are in scope at every site above (all four are inside the router created at `:715`).

- [ ] **Step 4: Run to verify they pass**

Run: `cd app && npx vitest run test/inboxGroups.test.ts test/inboxApi.test.ts test/inboxFeed.test.ts test/inboxUnreadParity.test.ts && npm run typecheck`
Expected: PASS. If a sibling inbox suite's fake `contactsRepo` lacks `getDisplaysByIds`, add the same fake there (return an empty `Map`) - `resolveRosterNames` tolerates a throw, but a missing method is a `TypeError` inside the try and is ALSO tolerated; still add it so the suite is honest.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/inbox.ts app/test/inboxGroups.test.ts
git commit -m "feat(inbox): group and relay row titles resolve names with one batch per page"
```

---

### Task 4: Contact page cards (relay groups, group threads)

**Files:**
- Modify: `app/src/routes/contacts.ts:1186-1230` (relay-groups), `:1279-1300` (group-threads)
- Test: `app/test/contactRelayGroups.test.ts`, `app/test/contactGroupThreads.test.ts`

**Interfaces:**
- Consumes: `resolveRosterNames`, `withLiveNames` (Task 1).

- [ ] **Step 1: Write the failing tests**

`app/test/contactRelayGroups.test.ts`, using its `seedContact`, `seedRelay`, `authedGet`, `world`:

```ts
  it('otherMemberNames come from the OTHER members contacts, not the stored snapshot', async () => {
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

  it('ids are batched only for groups this contact is in', async () => {
    seedContact();
    seedRelay('rg-mine', [{ contactId: TENANT, phone: PHONE_A }, { contactId: 'c-in', phone: LANDLORD_PHONE }], { status: 'open' });
    seedRelay('rg-not-mine', [{ contactId: 'c-out', phone: '+15550100009' }], { status: 'open' });
    const real = world.contactsRepo.getDisplaysByIds.bind(world.contactsRepo);
    const batches: string[][] = [];
    world.contactsRepo.getDisplaysByIds = async (ids) => { batches.push([...ids]); return real(ids); };
    await authedGet(`/api/contacts/${TENANT}/relay-groups`);
    expect(batches.flat()).not.toContain('c-out');
  });
```

Check `seedRelay`'s third-argument shape in the file (`opts: { status ... }`) and match it.

`app/test/contactGroupThreads.test.ts`, using its `seedContact`, `seedGroup`, `authedGet`, `world`:

```ts
  it('title and otherMemberNames use the contact name over the stored snapshot', async () => {
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

- [ ] **Step 2: Run to verify they fail**

Run: `cd app && npx vitest run test/contactRelayGroups.test.ts test/contactGroupThreads.test.ts`
Expected: the three new tests FAIL (`'Old Landlord'`, `'c-out'` present, `'Marcus Landlord'`).

- [ ] **Step 3: Implement**

Import in `app/src/routes/contacts.ts`:

```ts
import { resolveRosterNames, withLiveNames } from '../lib/participantNames.js';
```

Relay-groups route (`:1186-1230`): split the loop into match-then-hydrate. Replace `for (const conv of items) { const roster = conv.participants ?? []; if (!roster.some(isSelf)) continue; ...` with:

```ts
      const mine = items.filter((conv) => (conv.participants ?? []).some(isSelf));
      // ONE batch for the groups this contact is actually in - collected AFTER
      // the membership filter so a page of other people's groups costs nothing.
      const names = await resolveRosterNames(mine, contacts, log);
      for (const conv of mine) {
        const roster = withLiveNames(conv.participants, names);
```

and keep the rest of the body unchanged (`others`, `tag`, `groups.push(...)` all read `roster`).

Group-threads route (`:1279-1300`), same shape:

```ts
    const mine = items.filter((conv) => (conv.participants ?? []).some(isSelf));
    const names = await resolveRosterNames(mine, contacts, log);
    const groups: GroupThreadRow[] = [];
    for (const conv of mine) {
      const roster = withLiveNames(conv.participants, names);
      const others = roster.filter((p) => !isSelf(p));
```

`contacts` is the route-scoped contacts repo (check the name at the top of `createContactsRouter`; it is what `contacts.getById(contactId)` at `:1172` uses).

- [ ] **Step 4: Run to verify they pass**

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
- Modify: `app/src/routes/relayGroups.ts:469-505`, `app/src/routes/api.ts:2185-2201`
- Test: `app/test/relayApi.test.ts`, `app/test/voiceWebhook.test.ts` (calls route)

**Interfaces:**
- Consumes: `resolveRosterNames`, `withLiveNames`, `hydrateConversationRosters` (Task 1).

- [ ] **Step 1: Write the failing tests**

`app/test/relayApi.test.ts` - find the `describe` around `:1420` that tests `GET /api/conversations/:id/members` (the 404 test) and add beside it, reusing `authedHarness(world, makeFakePoolNumbers())`, `SECRET`, `TEST_SESSION_COOKIE`:

```ts
  it('GET /members: contact name wins, stored name stands on a read failure, batched', async () => {
    const { app } = authedHarness(world, makeFakePoolNumbers());
    world.contacts.push({ contactId: 'c-live', type: 'tenant', status: 'active', phone: ALICE, firstName: 'Alicia', lastName: 'Live' });
    world.conversations.set('conv-members', {
      conversationId: 'conv-members', participant_phone: POOL, pool_number: POOL, status: 'open',
      last_activity_at: new Date().toISOString(), type: 'relay_group', ai_mode: 'manual', created_at: new Date().toISOString(),
      participants: [
        { contactId: 'c-live', phone: ALICE, name: 'Old Alice' },
        { contactId: 'c-missing', phone: BOB, name: 'Stored Bob' },
        { contactId: '', phone: CAROL },
      ],
    });
    const batches: string[][] = [];
    const real = world.contactsRepo.getDisplaysByIds.bind(world.contactsRepo);
    world.contactsRepo.getDisplaysByIds = async (ids) => { batches.push([...ids]); return real(ids); };
    const getByIdSpy = vi.spyOn(world.contactsRepo, 'getById');

    const res = await request(app).get('/api/conversations/conv-members/members').set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.members).toEqual([
      { contactId: 'c-live', phone: ALICE, name: 'Alicia Live' },
      { contactId: 'c-missing', phone: BOB, name: 'Stored Bob' },
      { contactId: '', phone: CAROL },
    ]);
    expect(batches).toHaveLength(1);
    expect(getByIdSpy).not.toHaveBeenCalled();
  });
```

Use the file's own constants for phones (`ALICE`, `BOB`, `CAROL`, `POOL` exist near its top - confirm with `grep -n "^const " app/test/relayApi.test.ts | head`). If `vi` is not imported there, add it to the vitest import.

`app/test/voiceWebhook.test.ts` - beside the existing `GET /api/calls/:callId` test near `:915`, add:

```ts
  it('GET /api/calls/:callId hands back a roster with resolved names', async () => {
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

- [ ] **Step 2: Run to verify they fail**

Run: `cd app && npx vitest run test/relayApi.test.ts -t "GET /members" && npx vitest run test/voiceWebhook.test.ts -t "resolved names"`
Expected: FAIL - members: `name` absent for `c-missing` and `getById` called; calls: `'Bob'`.

- [ ] **Step 3: Implement the members route**

`app/src/routes/relayGroups.ts:469-505` - replace the `Promise.all(...)` block through `res.json({ members })` with:

```ts
    // The roster's stored name is a creation-time snapshot. Resolve every
    // member's CURRENT contact name in ONE batch (lib/participantNames):
    //   contact name (readable, non-deleted, non-empty)
    //   -> the stored roster name
    //   -> nothing, and the dashboard renders this current roster phone
    //      (recipientLabel / groupThread: "full name, else formatted number").
    // The middle rung is new (2026-09-01): a read blip used to drop a name the
    // operator had a moment ago and show a bare number instead.
    const names = await resolveRosterNames([conversation], contacts, log);
    const members = withLiveNames(conversation.participants, names);
    res.json({ members });
```

Add the import and remove `nameFromContact` from the `../services/relayMembers.js` import list at `:39` if this was its only use (`grep -n nameFromContact app/src/routes/relayGroups.ts`).

```ts
import { resolveRosterNames, withLiveNames } from '../lib/participantNames.js';
```

- [ ] **Step 4: Implement the calls passthrough**

`app/src/routes/api.ts:2201`, `res.json({ call, conversation })` becomes:

```ts
    // The quick-reply seam renders member names off this roster; resolve them
    // (one batch over one roster, lib/participantNames) rather than hand the
    // client the creation-time snapshot.
    const [hydrated] = await hydrateConversationRosters([conversation], contacts, log);
    res.json({ call, conversation: hydrated });
```

Import: `import { hydrateConversationRosters } from '../lib/participantNames.js';`. `contacts` is the router const at `:635`.

- [ ] **Step 5: Run to verify they pass**

Run: `cd app && npx vitest run test/relayApi.test.ts test/voiceWebhook.test.ts test/relayGroupPreview.test.ts && npm run typecheck`
Expected: PASS. If an existing members-route test asserted that a nameless-contact member comes back WITHOUT `name`, it now gets the stored name - update that expectation and say so in the commit body.

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/relayGroups.ts app/src/routes/api.ts app/test/relayApi.test.ts app/test/voiceWebhook.test.ts
git commit -m "feat(relay): members panel batches contact names and keeps the stored fallback; calls passthrough hydrated"
```

---

### Task 6: People card precedence flip

**Files:**
- Modify: `app/src/lib/rosterResolution.ts:556-565`
- Test: `app/test/rosterResolution.test.ts`; re-baseline recipient names in `app/test/relayGroupPreview.test.ts`, `app/test/toursApi.test.ts`, `app/test/placementsApi.test.ts` ONLY if they fail.

- [ ] **Step 1: Write the failing test**

`app/test/rosterResolution.test.ts`, in the `describeRoster` describe block, using its `makeDeps`, `relayGroup`, `contact`, `TOUR`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run test/rosterResolution.test.ts -t "beats a stale"`
Expected: FAIL - `['Old Tina', 'Gone Person']`.

- [ ] **Step 3: Implement**

`app/src/lib/rosterResolution.ts:556-565` - replace the comment and expression:

```ts
    // Display name: the CONTACT's current name first (we read it two
    // paragraphs up), then whatever the row itself stored. The stored name is
    // a creation-time snapshot; the card and the tabs must say "Tina Tenant"
    // today, not on the day the group was made. Display only: reachability
    // keeps the STORED phone, and a removed contact keeps the row's own name.
    const name =
      (!removed && contact !== undefined ? displayName(contact) : undefined) ?? nonEmpty(member.name);
```

- [ ] **Step 4: Run the suites this reaches**

Run: `cd app && npx vitest run test/rosterResolution.test.ts test/rosterEdits.test.ts test/relayGroupPreview.test.ts test/toursApi.test.ts test/placementsApi.test.ts`
Expected: PASS, or failures ONLY in preview `recipients[].name` expectations where a fixture's stored roster name differs from its contact's name. For each such failure: confirm the diff is in a recipient `name` (never in a `body` string), then update that expectation to the contact-derived name. If a `body` string changes, STOP - that is phase-b's territory and this task must not touch it; report it.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/rosterResolution.ts app/test/rosterResolution.test.ts
# plus any of the three preview test files you re-baselined:
git commit -m "feat(roster): describeRoster prefers the contact name over the stored snapshot"
```

Name every re-baselined file and the count of moved expectations in the commit body.

---

### Task 7: Push sender label and voice masked label

**Files:**
- Modify: `app/src/routes/webhooks/twilio.ts:301-316`, `app/src/routes/webhooks/voice.ts:109-121`, `app/src/lib/voiceMasking.ts`
- Test: `app/test/voiceMasking.test.ts` (create if absent), `app/test/voiceWebhook.test.ts`, the group-push test in whichever file covers `emitMessagePush` for group threads (`grep -rln "pushSenderLabel\|group.*push" app/test`)

**Interfaces:**
- Produces: `shortNameFromFull(full: string | undefined): string | undefined` in `lib/voiceMasking.ts` - `'Bob'` -> `'Bob'`, `'Bob Builder'` -> `'Bob B.'`, `'  '` -> `undefined`.

- [ ] **Step 1: Write the failing tests**

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

`app/test/voiceWebhook.test.ts`, beside the `persists a metadata-only, masked call entry` test:

```ts
  it('call_party_label prefers the CONTACT (masked) over the stored roster name, and masks the stored name too', async () => {
    const world = createFakeWorld();
    world.contacts.push({ contactId: 'c-bob', type: 'landlord', phone: BOB, firstName: 'Robert', lastName: 'Renamed' });
    seedRelay(world);
    const { app } = makeWebhookHarness({ world });
    await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoiceParams());
    const call = world.messages.find((m) => m.type === 'call')!;
    expect(call.call_party_label).toBe('Robert R.');
  });

  it('a stored full name with no contact is masked, never persisted whole', async () => {
    const world = createFakeWorld();
    seedRelay(world, { participants: [
      { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
      { contactId: '', phone: BOB, name: 'Bob Builder' },
    ] });
    const { app } = makeWebhookHarness({ world });
    await signedTwilioPost(app, '/webhooks/twilio/voice', inboundVoiceParams());
    const call = world.messages.find((m) => m.type === 'call')!;
    expect(call.call_party_label).toBe('Bob B.');
  });
```

Group push: in the test file that covers the group inbound push (find with the grep above; it asserts a push body like `"<sender>: <text>"`), add a case where the sender's roster `name` is stale and the contact has a different name, asserting the CONTACT name in the push body. Copy that file's existing group-push test and change the two names.

- [ ] **Step 2: Run to verify they fail**

Run: `cd app && npx vitest run test/voiceMasking.test.ts test/voiceWebhook.test.ts -t "masked|call_party_label prefers|stored full name"`
Expected: FAIL - `shortNameFromFull` missing; labels `'Bob'` and `'Bob Builder'`.

- [ ] **Step 3: Implement**

`app/src/lib/voiceMasking.ts`, after `contactShortName`:

```ts
/**
 * The same "First L." mask applied to an already-joined name string (a stored
 * roster snapshot). A persisted masked label must never carry a full surname,
 * whichever rung supplied it.
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
 * and never an unmasked full name - this label is PERSISTED as
 * call_party_label. Contact-first since 2026-09-01: the roster name is a
 * creation-time snapshot. `role` comes from the reviewed contact type (honesty
 * rule - only tenant/landlord claim a role).
 */
function maskedPartyLabel(member: ConversationParticipant | undefined, contact: ContactItem | undefined): string {
  const masked = contactShortName(contact) ?? shortNameFromFull(member?.name);
  if (masked !== undefined) return masked;
  if (contact?.type === 'tenant') return 'Tenant';
  if (contact?.type === 'landlord') return 'Landlord';
  return 'the other party';
}
```

Import `shortNameFromFull` from `'../../lib/voiceMasking.js'` alongside `contactShortName` (already imported there; check the exact path used).

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

- [ ] **Step 4: Run to verify they pass**

Run: `cd app && npx vitest run test/voiceMasking.test.ts test/voiceWebhook.test.ts test/founderTriage.test.ts test/voiceOutbound.test.ts && npx vitest run test/inboxFeed.test.ts && npm run typecheck`
Expected: PASS. The existing `call_party_label` pins (`'Bob'`, `'Tenant (Jane D.)'`, `'Unknown caller'`) hold: `'Bob'` is a single token, and the other two come from `pushCallerIdentity`, untouched.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/voiceMasking.ts app/src/routes/webhooks/voice.ts app/src/routes/webhooks/twilio.ts app/test/voiceMasking.test.ts app/test/voiceWebhook.test.ts
# plus the group-push test file you extended
git commit -m "feat(push,voice): sender and party labels prefer the contact; masked label never unmasks"
```

---

### Task 8: Drift audit - group rosters

**Files:**
- Create: `app/src/lib/rosterDriftTally.ts`
- Modify: `app/scripts/measure-unread-contact-coverage.ts` (`auditDenorm`, `:473-600`)
- Test: `app/test/rosterDriftTally.test.ts` (new)

**Interfaces:**
- Produces: `tallyRosterDrift(rosters: readonly (readonly ConversationParticipant[])[], contacts: ReadonlyMap<string, ContactDisplayItem>): RosterDriftTally` with fields `rosters, members, withContactId, nameMissingButKnown, nameDrift, danglingContactId, noContactId`.

- [ ] **Step 1: Write the failing test**

`app/test/rosterDriftTally.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { tallyRosterDrift } from '../src/lib/rosterDriftTally.js';

describe('tallyRosterDrift', () => {
  it('classifies every member exactly once', () => {
    const tally = tallyRosterDrift(
      [
        [
          { contactId: 'c-ok', phone: '+1', name: 'Ada Ok' },
          { contactId: 'c-missing', phone: '+2' },
          { contactId: 'c-drift', phone: '+3', name: 'Old Name' },
          { contactId: 'c-dangling', phone: '+4', name: 'Ghost' },
          { contactId: '', phone: '+5', name: 'Bare' },
        ],
        [{ contactId: 'c-ok', phone: '+1', name: 'Ada Ok' }],
      ],
      new Map([
        ['c-ok', { contactId: 'c-ok', firstName: 'Ada', lastName: 'Ok' }],
        ['c-missing', { contactId: 'c-missing', firstName: 'Has', lastName: 'Name' }],
        ['c-drift', { contactId: 'c-drift', firstName: 'New', lastName: 'Name' }],
      ]),
    );
    expect(tally).toEqual({
      rosters: 2,
      members: 6,
      withContactId: 5,
      nameMissingButKnown: 1,
      nameDrift: 1,
      danglingContactId: 1,
      noContactId: 1,
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run test/rosterDriftTally.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement the tally**

`app/src/lib/rosterDriftTally.ts`:

```ts
// rosterDriftTally - the pure count behind the --audit-denorm group pass in
// app/scripts/measure-unread-contact-coverage.ts. Counts only, never names.
import { contactDisplayName } from './contactName.js';
import type { ContactDisplayItem } from '../repos/contactsRepo.js';
import type { ConversationParticipant } from '../repos/conversationsRepo.js';

export interface RosterDriftTally {
  rosters: number;
  members: number;
  withContactId: number;
  /** contact has a name; the row stores none */
  nameMissingButKnown: number;
  /** both present and different */
  nameDrift: number;
  /** contactId present, no contact behind it */
  danglingContactId: number;
  /** bare-phone member */
  noContactId: number;
}

export function tallyRosterDrift(
  rosters: readonly (readonly ConversationParticipant[])[],
  contacts: ReadonlyMap<string, ContactDisplayItem>,
): RosterDriftTally {
  const t: RosterDriftTally = {
    rosters: rosters.length, members: 0, withContactId: 0, nameMissingButKnown: 0,
    nameDrift: 0, danglingContactId: 0, noContactId: 0,
  };
  for (const roster of rosters) {
    for (const p of roster) {
      t.members += 1;
      if (typeof p.contactId !== 'string' || p.contactId.length === 0) { t.noContactId += 1; continue; }
      t.withContactId += 1;
      const contact = contacts.get(p.contactId);
      if (contact === undefined) { t.danglingContactId += 1; continue; }
      const want = contactDisplayName(contact);
      const have = typeof p.name === 'string' && p.name.trim().length > 0 ? p.name.trim() : undefined;
      if (want !== undefined && have === undefined) t.nameMissingButKnown += 1;
      else if (want !== undefined && have !== undefined && want !== have) t.nameDrift += 1;
    }
  }
  return t;
}
```

- [ ] **Step 4: Wire the script**

In `app/scripts/measure-unread-contact-coverage.ts`, add the import next to the other `../src/` imports:

```ts
import { tallyRosterDrift } from '../src/lib/rosterDriftTally.js';
```

Add a function after `auditDenorm` and call it at the END of `auditDenorm` (after its `console.log([...])`), with `await auditGroupRosters();`:

```ts
/**
 * The GROUP half of --audit-denorm. The 1:1 walk above reads the 'open'
 * partition, which never returns a native group text (status `group_open`) or
 * a closed relay group, so groups need their own sources: listGroupTexts plus
 * listRelayGroups for every relay status. Counts only, never names.
 */
async function auditGroupRosters(): Promise<void> {
  const rosters: ConversationParticipant[][] = [];
  const ids = new Set<string>();
  const take = (items: ConversationItem[]): void => {
    for (const conv of items) {
      const roster = conv.participants ?? [];
      rosters.push(roster);
      for (const p of roster) if (p.contactId !== '') ids.add(p.contactId);
    }
  };
  let cursor: string | undefined;
  let groupTruncated = false;
  do {
    const page = await conversations.listGroupTexts({ limit: 100, ...(cursor !== undefined && { cursor }) });
    take(page.items);
    groupTruncated ||= page.truncated;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  const relayTruncated: string[] = [];
  for (const status of ['open', 'connecting', 'closed'] as const) {
    const { items, truncated } = await conversations.listRelayGroups(status);
    take(items);
    if (truncated) relayTruncated.push(status);
  }
  const idList = [...ids];
  const contacts$ = new Map<string, ContactDisplayItem>();
  for (let i = 0; i < idList.length; i += 100) {
    for (const [k, v] of await contacts.getDisplaysByIds(idList.slice(i, i + 100))) contacts$.set(k, v);
  }
  const t = tallyRosterDrift(rosters, contacts$);
  console.log(
    [
      '',
      'Group roster names - drift audit',
      '================================',
      `  rosters walked          ${t.rosters}${groupTruncated ? '  (group_text walk TRUNCATED)' : ''}${relayTruncated.length > 0 ? `  (relay ${relayTruncated.join('/')} TRUNCATED)` : ''}`,
      `  members                 ${t.members}`,
      `    with contactId        ${t.withContactId}`,
      `      name MISSING, known ${t.nameMissingButKnown}  <- contact has a name; roster stores none`,
      `      name DIFFERS        ${t.nameDrift}  <- roster shows a different name than the contact`,
      `      dangling contactId  ${t.danglingContactId}  <- no contact behind the id`,
      `    no contactId          ${t.noContactId}  <- bare-phone member; nothing to resolve`,
      '',
    ].join('\n'),
  );
}
```

Import `ConversationParticipant`, `ConversationItem` and `ContactDisplayItem` types if the script does not already (check its import block). `conversations` and `contacts` are the script's module-level repos.

- [ ] **Step 5: Run to verify**

Run: `cd app && npx vitest run test/rosterDriftTally.test.ts && npm run typecheck`
Expected: PASS, typecheck 0.

Then, with DynamoDB Local up (`npm run db:start` from the root) and an e2e lane seeded (`npm run e2e:session`, `full` profile), run the script once against that lane to prove it executes end to end - the lane's `DYNAMODB_ENDPOINT` and table prefix are what `scripts/e2e-session.mjs` prints; pass them the way the script's header comment documents. Expected: the two audit blocks print and the process exits 0. Record the group block's numbers in `.superpowers/sdd/audit-lane.txt` (run state, not a record). Do NOT run it against any deployed environment - that is the handback's owner, per the spec.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/rosterDriftTally.ts app/test/rosterDriftTally.test.ts app/scripts/measure-unread-contact-coverage.ts
git commit -m "feat(audit): --audit-denorm walks group rosters from their own partitions"
```

---

### Task 9: E2E - rename propagates to Today, the group header, the contact card

**Files:**
- Modify: `e2e/scenarios/steps.ts` (one new public step)
- Create: `e2e/tests/scenarios/participant-names.spec.ts`

- [ ] **Step 1: Add the step**

In `e2e/scenarios/steps.ts`, next to `teamTriagesUnknownToTenant` (`:711`), add a public wrapper (the identity editor is private):

```ts
  /** [Team] Rename the active tenant via the contact page's edit form. */
  teamRenamesActiveTenant(t: Tenant, fields: { firstName: string; lastName: string }): Promise<void> {
    return step('Team renames the tenant', async () => {
      await this.openActiveContact(t);
      await this.editTenantIdentity(fields);
    });
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
import { expect, test } from '@playwright/test';
import { Scenario, freshLandlord, freshTenant, type Contact } from '../../scenarios/steps.js';
import { expectTodayReady } from '../../support/today.js';
import { useScenarioBudget } from '../../support/scenarioBudget.js';

useScenarioBudget();

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

test('renaming a contact shows on Today, the group header and the contact card', async ({ page }) => {
  const flow = new Scenario(page);
  await flow.login();
  const owner = freshLandlord('PNOwner');
  await flow.teamCreatesLandlord({ firstName: owner.firstName, lastName: owner.lastName, phone: owner.phone });
  const ownerId = flow.landlordId();
  const unit = await flow.seedAvailableUnit({ beds: 2, landlordId: ownerId });
  const tenant = freshTenant('PNTenant');
  await flow.teamCreatesTenant({ firstName: tenant.firstName, lastName: tenant.lastName, phone: tenant.phone });
  await flow.seedTenantSearching();
  await flow.tenantAsksToTour(unit);
  await flow.teamOpensTourGroup('tour');

  const renamed: Contact = { ...tenant, firstName: `${tenant.firstName}X`, lastName: 'Renamed', name: `${tenant.firstName}X Renamed` };
  await flow.teamRenamesActiveTenant(tenant, { firstName: renamed.firstName, lastName: renamed.lastName });

  // An unread 1:1 from the tenant puts them on Today's Unreplied list.
  await flow.tenantTexts(tenant, 'Is the tour still on?');

  // 1. Today: the row names the person by the NEW name.
  await page.goto(`${NEXT}/today`);
  await expectTodayReady(page);
  await expect(page.getByText(renamed.name, { exact: false }).first()).toBeVisible({ timeout: 15_000 });

  // 2. The contact file's Relay groups card (from the OWNER's file, so the
  //    tenant is one of the "others" the row is named for).
  await flow.expectGroupOnContactFile(renamed, ownerId);

  // 3. The group thread header, after a fresh load.
  const groupId = flow.requireActiveTourGroup().groupThreadId;
  await page.goto(`${NEXT}/conversations/${groupId}`);
  await expect(page.getByRole('heading', { name: new RegExp(renamed.firstName) })).toBeVisible({ timeout: 15_000 });
});
```

`requireActiveTourGroup` is private on `Scenario` today - if so, expose a one-line public `activeTourGroupId(): string` beside `contactId()` (`:3531`) and use it. The `'tour'` variant argument to `teamOpensTourGroup` matches phase-b's `RelayIntroVariant`; if the tour has no time set the group opens as `'naked'` - check `teamOpensTourGroup`'s own docblock and pass the variant it will actually send, or the intro assertion inside that step fails for a reason unrelated to names.

- [ ] **Step 3: Run it alone first**

Run from the root: `npm run e2e -- --grep "renaming a contact"` - if the root script eats `--grep` (it does on some versions; see `docs/issues`), run the e2e workspace's own runner the way `e2e/README.md` documents for a single spec.
Expected: PASS. Iterate on selectors only against the hermetic lane, never `:5174`/`:8080` of the human's stack.

- [ ] **Step 4: Commit**

```bash
git add e2e/scenarios/steps.ts e2e/tests/scenarios/participant-names.spec.ts
git commit -m "test(e2e): a rename shows on Today, the group header and the contact card"
```

---

### Task 10: Issues, fixtures, and the measurement number

**Files:**
- Modify: `docs/issues/today-shows-phone-instead-of-name.md`, `docs/issues/group-roster-name-snapshot-never-refreshed.md`, `docs/issues/relay-stale-participant-phone.md`, `docs/issues/consolidate-contact-display-name-helpers.md`, `docs/issues/today-contact-hydration-fan-out.md`
- Create: `docs/issues/staff-only-roster-name-readers-stale.md`

- [ ] **Step 1: Fixtures**

`grep -rn "Synthetic tenant\|Synthetic participant\|Synthetic landlord" app/test e2e` returned nothing at plan time. Re-run it; if still nothing, no fixture work exists and this step is done - say so in the commit body of Step 4.

- [ ] **Step 2: The Today read count**

In `app/test/todayApi.test.ts`, temporarily instrument `world.contactsRepo.getById` in the largest existing Today scenario (the one that seeds the most contacts - find it by `grep -c "seedTenant(" ` per `it` block) and print the DISTINCT contactId count for one `GET /api/today`. Record the number; do not commit the instrumentation. That number is `N` for the issue below.

- [ ] **Step 3: Stamp the issues**

Append a `**Resolution (2026-09-01, feat/participant-snapshot-refresh).**` paragraph to each, and set frontmatter `status: closed` where noted:

- `today-shows-phone-instead-of-name` - `status: closed`. "Today's `who` now resolves from the contact the deleted-check already memoized (zero new reads), then the stored name, then the phone. `routes/today.ts` `whoOfConversation`."
- `group-roster-name-snapshot-never-refreshed` - `status: closed`. "Every operator-facing roster surface resolves names from the contact at read time with one batch per page (`lib/participantNames.ts`): inbox rows, contact cards, relay members panel, People card, calls passthrough, push sender, voice party label. NOT covered, stated: the two group push TITLES (`routes/webhooks/twilio.ts` `groupThreadLabel`/`relayThreadLabel` on the ack path), the close-group confirm dialogs at `PlacementDetail.tsx:370` / `TourDetail.tsx:451`, and bare-phone relay members. The outbound intro/member-added bodies were rewritten by `feat/tour-reminder-ladder-phase-b`."
- `relay-stale-participant-phone` - `status: closed`. "Ruling 2026-08-31: documented behavior, no code change. To correct a member's number, remove and re-add them; the group re-announces them, which is correct because their number really did change. `participants[].phone` is never rewritten by any name-resolution path."
- `consolidate-contact-display-name-helpers` - stays `open`. Replace the "six copies" paragraph with the corrected census: thirteen private copies (`routes/contacts.ts`, `routes/units.ts`, `lib/rosterResolution.ts`, `services/groupMembers.ts`, `services/inboundEmail.ts`, `services/relayMembers.ts`, `services/groupConvert.ts`, `routes/api.ts` x2, `routes/inbox.ts`, `routes/today.ts`, `jobs/placementNudges.ts`, `routes/placements.ts`); note that `routes/inbox.ts` has an extra `contact.name` rung and `routes/today.ts` trims the outer join only, so neither can be re-pointed blind; note `lib/voiceMasking.ts contactShortName` is a different rule, not a copy; note `contactDisplayName` now accepts `ContactDisplayItem` and has a fourth consumer (`lib/participantNames.ts`).
- `today-contact-hydration-fan-out` - if `N` from Step 2 is under 30, `status: closed` with "Measured 2026-09-01 in the todayApi harness: N distinct contacts per GET /api/today. Closed wontfix per the issue's own rule." Otherwise leave open and record `N`.

New `docs/issues/staff-only-roster-name-readers-stale.md` (copy `_TEMPLATE.md`), severity `low`, area `app`: "Three staff-only readers still render the stored roster name: `services/groupSend.ts:253` `memberLabel` (consent/deleted refusal strings), `services/relayGroupDuplicates.ts:68` `rosterMembers` (duplicate-group warning), `routes/poolNumbersAdmin.ts` `serverLabel`. All are off the request hot path and none share a rendered thread with a hydrated surface. Fix: `withLiveNames` over the roster with one `getDisplaysByIds`, per `lib/participantNames.ts`."

Then: `npm run issues` from the root.

- [ ] **Step 4: Commit**

```bash
git add docs/issues/today-shows-phone-instead-of-name.md docs/issues/group-roster-name-snapshot-never-refreshed.md docs/issues/relay-stale-participant-phone.md docs/issues/consolidate-contact-display-name-helpers.md docs/issues/today-contact-hydration-fan-out.md docs/issues/staff-only-roster-name-readers-stale.md
git commit -m "docs(issues): close the M1 name-snapshot issues; correct the helper census; file the staff-only readers"
```

---

### Task 11: Gates

- [ ] **Step 1: Sync main** (once, only if it moved): `git fetch && git merge main` from the worktree. Resolve nothing silently; if `app/src/routes/relayGroups.ts` or the preview test files conflict, keep BOTH sides' intent and re-run Task 6 Step 4.

- [ ] **Step 2: Run all five gates, bare, from the worktree, and record the exit code of each:**

```
npm run typecheck
npm test
npm run smoke
npm run e2e
npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')
```

If `npm test` is red on DynamoDB suites only (timeouts, write locks, zero assertion failures), re-run under a clean key first: `cd app && AWS_ACCESS_KEY_ID=hccleanrun001 npx vitest run`. For lint, attribute every reported error by running the same command at `main` on the same paths; only errors present now and absent there are yours.

- [ ] **Step 3: Handback** to `docs/superpowers/reviews/2026-08-31-participant-snapshot-refresh/handback.md`: the five exit codes, the e2e result line, the audit numbers from Task 8 Step 5, `N` from Task 10, the list of preview expectations re-baselined in Task 6, and current `main` drift (`git rev-list --count HEAD..main`). Do not merge.

---

## Self-review

- **Spec coverage.** S1 (Today `who`, close-nag, client guard) -> Task 2. S2 inbox -> Task 3; contact cards -> Task 4; relay members + calls -> Task 5. S3 -> Task 6. S4 -> Task 7. S5 -> Task 8. Tests section -> each task's Step 1 plus Task 9. Issues -> Task 10. Gates -> Task 11. `contactDisplayName` widening + docblock -> Task 1. Spec's "Out" list: nothing here touches the thread header, `/group-members`, relayFanOut, or client code beyond `buildToday.ts:106`.
- **Placeholders.** None: every step has code or an exact command. Two steps are conditional on discovery (Task 6 Step 4 re-baselines, Task 10 Step 1 fixtures) and say exactly what to do in each branch.
- **Type consistency.** `resolveRosterNames(convs, contacts, log)` / `withLiveNames(participants, names)` / `hydrateConversationRosters(convs, contacts, log)` are used with those names and argument orders in Tasks 2-5 and 8. `groupRowFor(conv, names)` and `relayRowFor(conv, names)` match between Task 3's definition and its four call sites. `shortNameFromFull` is defined in Task 7 before use.
