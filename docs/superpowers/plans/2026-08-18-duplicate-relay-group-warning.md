# Duplicate Relay-Group Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an operator is about to open a relay group whose members exactly match a
group that is already live, the shared confirm dialog says so, names the existing
group, and links to it - then the operator decides and the duplicate is created if they
proceed.

**Architecture:** A pure detector service scans the two relay status partitions for an
exact phone-set match. The three preview routes construct a `findDuplicate` callback
over it; the two open preview builders invoke that callback and put the result on
`RosterPreview.duplicateOf`; the shared `RosterConfirmDialog` renders a warning block
when the field is present. Nothing refuses, nothing is acknowledged, and no create path
changes.

**Tech Stack:** TypeScript, Node 24, DynamoDB (single-table + sparse GSIs), Express 5,
Vitest, React 19, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-17-duplicate-relay-group-warning-design.md`
(r6). Read it before Task 1; every decision reference below (D1, D2a, D4, D6, D7) is a
section of that document.

## Global Constraints

- **NEVER modify `app/src/services/poolNumbers.ts` or `app/src/repos/poolNumbersRepo.ts`.**
  Pool-number allocation is deliberately unchanged (spec 1, 2.2).
- **Nothing refuses.** No 409, no acknowledgement flag, no override parameter, no change
  to any create/open/reopen route or to `jobs/rosterActions.ts` (spec D5, D7).
- **`onConfirm` keeps its exact current signature** `(force: boolean) => Promise<void>`.
- Match is **EXACT set equality of E.164 phones**. Supersets, subsets and partial
  overlaps must NOT warn (spec D1).
- Compare `participants[].phone` on the existing group. **Never `ever_member_phones`**
  (spec D2a).
- Previews carry **names, never phones** on the wire (doc section 9).
- ASCII only in every new or touched line, including comments and test names.
- Read a bare `git status` before EVERY commit. Stage explicit paths only; never
  `git add -A`. Every commit ends with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- The in-dashboard warning is UI text, NOT an outbound message - it does NOT go through
  the message catalog.
- No infra: no terraform, `secrets:push`, SSM writes, or deploys.
- Do NOT merge to `main`. Do NOT delete branches or worktrees.

## File Structure

| File | Responsibility |
|---|---|
| `app/src/services/relayGroupDuplicates.ts` (new) | The detector and its exact-set comparator. Only file that knows how a duplicate is found. |
| `app/test/relayGroupDuplicates.test.ts` (new) | Pins D1's three negatives, D4, D6's four cases, D2a's adjacent-field trap. |
| `app/src/services/rosterEdits.ts` | `RosterPreview.duplicateOf`; the `findDuplicate` trailing optional parameter on both open builders; `buildAddPreview` never sets it. |
| `app/src/routes/relayGroups.ts` | Standalone preview route constructs the callback. |
| `app/src/routes/tours.ts` | Tour preview route constructs the callback. |
| `app/src/routes/placements.ts` | Placement preview route constructs the callback. |
| `dashboard/src/api/types.ts` | Mirrored `DuplicateOpenGroup` + `RosterPreview.duplicateOf`. |
| `dashboard/src/routes/shared/RosterConfirmDialog.tsx` | The warning block. |
| `docs/issues/*.md` (5 new) | The gaps the spec deliberately does not build. |

---

### Task 1: The detector

**Files:**
- Create: `app/src/services/relayGroupDuplicates.ts`
- Test: `app/test/relayGroupDuplicates.test.ts`

**Interfaces:**
- Consumes: `ConversationsRepo.listRelayGroups(status)` from
  `app/src/repos/conversationsRepo.ts`, which returns
  `Promise<{ items: ConversationItem[]; truncated: boolean }>`.
- Produces: `DuplicateOpenGroup`, `samePhoneSet(a, b)`,
  `findOpenGroupWithSamePhones(deps, phones)`. Task 2 imports the type and the
  function; Task 3 imports the function; Task 4 mirrors the type by hand.

- [ ] **Step 1: Write the failing test**

Create `app/test/relayGroupDuplicates.test.ts`:

```ts
// The duplicate-relay-group detector (spec D1/D2a/D4/D6). Pure unit tests over a
// fake listRelayGroups - no DynamoDB, no network.
import { describe, expect, it, vi } from 'vitest';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  findOpenGroupWithSamePhones,
  samePhoneSet,
} from '../src/services/relayGroupDuplicates.js';

const logger = createLogger({ destination: createLogCapture().stream });

/** A relay group row with just the fields the detector reads. */
function group(
  conversationId: string,
  phones: string[],
  extra: Partial<ConversationItem> = {},
): ConversationItem {
  return {
    conversationId,
    participants: phones.map((phone) => ({ contactId: '', phone, name: `N${phone}` })),
    last_activity_at: '2026-08-18T00:00:00.000Z',
    ...extra,
  } as unknown as ConversationItem;
}

/** listRelayGroups fake: per-status items plus a per-status truncated flag. */
function repo(
  byStatus: Partial<Record<'open' | 'connecting' | 'closed', ConversationItem[]>>,
  truncated: Partial<Record<'open' | 'connecting' | 'closed', boolean>> = {},
) {
  return {
    listRelayGroups: vi.fn(async (status: 'open' | 'connecting' | 'closed') => ({
      items: byStatus[status] ?? [],
      truncated: truncated[status] ?? false,
    })),
  };
}

const A = '+15558000001';
const B = '+15558000002';
const C = '+15558000003';

describe('samePhoneSet', () => {
  it('is true for the same members in a different order', () => {
    expect(samePhoneSet(new Set([A, B]), new Set([B, A]))).toBe(true);
  });

  it('is false for a superset and for a subset', () => {
    expect(samePhoneSet(new Set([A, B]), new Set([A, B, C]))).toBe(false);
    expect(samePhoneSet(new Set([A, B, C]), new Set([A, B]))).toBe(false);
  });
});

describe('findOpenGroupWithSamePhones - D1, the product rule', () => {
  it('matches an OPEN group with exactly the same phones', async () => {
    const conversations = repo({ open: [group('conv-1', [A, B])] });
    const found = await findOpenGroupWithSamePhones(
      { conversations, log: logger },
      new Set([A, B]),
    );
    expect(found?.conversationId).toBe('conv-1');
    expect(found?.partition).toBe('open');
  });

  it('does NOT match when the proposed roster is a SUPERSET', async () => {
    const conversations = repo({ open: [group('conv-1', [A, B])] });
    expect(
      await findOpenGroupWithSamePhones({ conversations, log: logger }, new Set([A, B, C])),
    ).toBeUndefined();
  });

  it('does NOT match when the proposed roster is a SUBSET', async () => {
    const conversations = repo({ open: [group('conv-1', [A, B, C])] });
    expect(
      await findOpenGroupWithSamePhones({ conversations, log: logger }, new Set([A, B])),
    ).toBeUndefined();
  });

  it('does NOT match on a partial overlap', async () => {
    const conversations = repo({ open: [group('conv-1', [A, B])] });
    expect(
      await findOpenGroupWithSamePhones({ conversations, log: logger }, new Set([A, C])),
    ).toBeUndefined();
  });
});

describe('findOpenGroupWithSamePhones - D4, which partitions count', () => {
  it('matches a CONNECTING group', async () => {
    const conversations = repo({ connecting: [group('conv-c', [A, B])] });
    const found = await findOpenGroupWithSamePhones(
      { conversations, log: logger },
      new Set([A, B]),
    );
    expect(found?.conversationId).toBe('conv-c');
    expect(found?.partition).toBe('connecting');
  });

  it('SKIPS an imported connecting row - it is an unconverted carrier group text', async () => {
    const conversations = repo({
      connecting: [group('conv-imported', [A, B], { imported_from: 'quo' } as Partial<ConversationItem>)],
    });
    expect(
      await findOpenGroupWithSamePhones({ conversations, log: logger }, new Set([A, B])),
    ).toBeUndefined();
  });

  it('never reads the closed partition', async () => {
    const conversations = repo({ closed: [group('conv-closed', [A, B])] });
    expect(
      await findOpenGroupWithSamePhones({ conversations, log: logger }, new Set([A, B])),
    ).toBeUndefined();
    expect(conversations.listRelayGroups).not.toHaveBeenCalledWith('closed');
  });
});

describe('findOpenGroupWithSamePhones - the tie-break', () => {
  it('prefers an OPEN match over a CONNECTING one EVEN WHEN connecting is newer', async () => {
    const conversations = repo({
      open: [group('conv-open', [A, B], { last_activity_at: '2026-08-01T00:00:00.000Z' })],
      connecting: [group('conv-conn', [A, B], { last_activity_at: '2026-08-18T00:00:00.000Z' })],
    });
    const found = await findOpenGroupWithSamePhones(
      { conversations, log: logger },
      new Set([A, B]),
    );
    expect(found?.conversationId).toBe('conv-open');
  });

  it('takes the newest WITHIN a status', async () => {
    const conversations = repo({
      open: [
        group('conv-old', [A, B], { last_activity_at: '2026-08-01T00:00:00.000Z' }),
        group('conv-new', [A, B], { last_activity_at: '2026-08-17T00:00:00.000Z' }),
      ],
    });
    const found = await findOpenGroupWithSamePhones(
      { conversations, log: logger },
      new Set([A, B]),
    );
    expect(found?.conversationId).toBe('conv-new');
  });
});

describe('findOpenGroupWithSamePhones - D6, a match always wins', () => {
  it('returns a match found in a walk that ALSO truncated', async () => {
    const conversations = repo({ open: [group('conv-1', [A, B])] }, { open: true });
    const found = await findOpenGroupWithSamePhones(
      { conversations, log: logger },
      new Set([A, B]),
    );
    expect(found?.conversationId).toBe('conv-1');
  });

  it('returns an OPEN match when the CONNECTING walk truncated', async () => {
    const conversations = repo({ open: [group('conv-1', [A, B])] }, { connecting: true });
    const found = await findOpenGroupWithSamePhones(
      { conversations, log: logger },
      new Set([A, B]),
    );
    expect(found?.conversationId).toBe('conv-1');
  });

  it('returns undefined when there is NO match and a walk truncated', async () => {
    const conversations = repo({ open: [group('conv-1', [A, C])] }, { open: true });
    expect(
      await findOpenGroupWithSamePhones({ conversations, log: logger }, new Set([A, B])),
    ).toBeUndefined();
  });

  it('swallows a thrown Query and returns undefined rather than propagating', async () => {
    const conversations = {
      listRelayGroups: vi.fn(async () => {
        throw new Error('dynamo exploded');
      }),
    };
    await expect(
      findOpenGroupWithSamePhones({ conversations, log: logger }, new Set([A, B])),
    ).resolves.toBeUndefined();
  });
});

describe('findOpenGroupWithSamePhones - D2a, the adjacent-field trap', () => {
  it('compares participants, NOT ever_member_phones', async () => {
    // A group whose PROVENANCE is {A,B} but whose live roster is {A,C}. Comparing
    // ever_member_phones would match; comparing participants must not.
    const row = group('conv-drifted', [A, C], {
      ever_member_phones: new Set([A, B]),
    } as Partial<ConversationItem>);
    const conversations = repo({ open: [row] });
    expect(
      await findOpenGroupWithSamePhones({ conversations, log: logger }, new Set([A, B])),
    ).toBeUndefined();
  });
});

describe('findOpenGroupWithSamePhones - the wire rule', () => {
  it('returns member NAMES and never a phone', async () => {
    const conversations = repo({ open: [group('conv-1', [A, B])] });
    const found = await findOpenGroupWithSamePhones(
      { conversations, log: logger },
      new Set([A, B]),
    );
    expect(JSON.stringify(found)).not.toContain(A);
    expect(JSON.stringify(found)).not.toContain(B);
    expect(found?.memberNames).toHaveLength(2);
  });

  it('renders a nameless participant as Unknown', async () => {
    const row = {
      conversationId: 'conv-1',
      participants: [{ contactId: '', phone: A }, { contactId: '', phone: B, name: 'Bee' }],
      last_activity_at: '2026-08-18T00:00:00.000Z',
    } as unknown as ConversationItem;
    const conversations = repo({ open: [row] });
    const found = await findOpenGroupWithSamePhones(
      { conversations, log: logger },
      new Set([A, B]),
    );
    expect(found?.memberNames).toEqual(['Unknown', 'Bee']);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd app && npx vitest run test/relayGroupDuplicates.test.ts`
Expected: FAIL - cannot resolve `../src/services/relayGroupDuplicates.js`.

- [ ] **Step 3: Write the implementation**

Create `app/src/services/relayGroupDuplicates.ts`:

```ts
// Duplicate relay-group detection (spec 2026-08-17-duplicate-relay-group-warning).
//
// ONE question: is there already a LIVE relay group whose members are EXACTLY the
// members of the group about to be opened? Used only to populate a preview warning -
// nothing here refuses anything, and a miss costs a confusing week rather than a
// misdelivered message (spec 2.1), which is why every failure mode here is silence.
//
// PII (doc section 9): a preview carries NAMES, never phones. DuplicateOpenGroup
// therefore holds display names only, and the log lines carry ids and counts.
import type { ConversationItem, ConversationsRepo } from '../repos/conversationsRepo.js';
import type { Logger } from '../lib/logger.js';

/** The live group a proposed roster duplicates. Names only - never phones. */
export interface DuplicateOpenGroup {
  conversationId: string;
  /**
   * The PARTITION the match was found in, not the row's own `status` field. Those
   * can skew: touchLastActivity leaves a re-flagged closed group at status 'open'
   * with relay_status 'relay_group#closed' (spec 7).
   */
  partition: 'open' | 'connecting';
  /** Display names of the existing group's members, for the warning copy. */
  memberNames: string[];
}

/** The statuses a live group can be in. Closed groups are NOT duplicates. */
const LIVE_PARTITIONS = ['open', 'connecting'] as const;

/** Exact set equality (spec D1). Supersets and subsets are NOT matches. */
export function samePhoneSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const phone of a) if (!b.has(phone)) return false;
  return true;
}

/**
 * The phones of a group's CURRENT roster (spec D2a).
 *
 * Deliberately `participants`, never `ever_member_phones` - the latter sits directly
 * beside it on ConversationItem with OPPOSITE semantics (add-only burn provenance a
 * member remove never clears), so it answers "who was ever here" rather than "who is
 * on this thread". Comparing it would warn about groups whose live roster does not
 * match at all.
 */
function rosterPhones(conv: ConversationItem): Set<string> {
  const out = new Set<string>();
  for (const member of conv.participants ?? []) {
    if (typeof member.phone === 'string' && member.phone.length > 0) out.add(member.phone);
  }
  return out;
}

/**
 * True for a row the IMPORTER wrote (spec D4). It writes type 'relay_group' with
 * relay_status 'relay_group#connecting' for unconverted carrier group texts, which
 * are not relay groups we provisioned - warning "a relay group already exists" about
 * one would be false in every clause.
 *
 * `imported_from` is NOT a declared field on ConversationItem; it rides the
 * `[key: string]: unknown` index signature, so this is a keyed read, not a property
 * access.
 */
function isImported(conv: ConversationItem): boolean {
  return typeof conv['imported_from'] === 'string';
}

/** Newest-activity-first, for picking among several matches in one partition. */
function byNewestActivity(a: ConversationItem, b: ConversationItem): number {
  const at = typeof a.last_activity_at === 'string' ? a.last_activity_at : '';
  const bt = typeof b.last_activity_at === 'string' ? b.last_activity_at : '';
  if (at === bt) return 0;
  return at < bt ? 1 : -1;
}

function toDuplicate(
  conv: ConversationItem,
  partition: 'open' | 'connecting',
): DuplicateOpenGroup {
  return {
    conversationId: conv.conversationId,
    partition,
    // A nameless participant renders as 'Unknown'. NEVER fall back to the phone -
    // doc section 9 forbids it on the wire.
    memberNames: (conv.participants ?? []).map((m) =>
      typeof m.name === 'string' && m.name.length > 0 ? m.name : 'Unknown',
    ),
  };
}

/**
 * Find a LIVE relay group whose roster phones equal `phones` exactly.
 *
 * A MATCH ALWAYS WINS (spec D6). A group found before a walk truncated or threw is
 * still returned - a duplicate we actually saw is not made less true by failing to
 * finish looking. `undefined` means "no match was found"; when the search was ALSO
 * incomplete that is logged as a WARN rather than changing the answer.
 *
 * NEVER THROWS. The preview routes that call this deliberately do not catch, so an
 * escaping error would take down the whole confirm dialog. That posture is correct
 * for member SUPPRESSION, which changes who receives a message; a missing duplicate
 * warning changes nobody's delivery, so this swallows its own errors instead.
 *
 * TIE-BREAK: prefer an OPEN match over a CONNECTING one, and only then take the
 * newest. Ranking purely by activity hands the warning to a just-created connecting
 * shell - stamp of now, never texted - over a real open thread that happens to be
 * quiet.
 */
export async function findOpenGroupWithSamePhones(
  deps: { conversations: Pick<ConversationsRepo, 'listRelayGroups'>; log: Logger },
  phones: Set<string>,
): Promise<DuplicateOpenGroup | undefined> {
  if (phones.size === 0) return undefined;
  let incomplete = false;

  for (const partition of LIVE_PARTITIONS) {
    let items: ConversationItem[] = [];
    try {
      const page = await deps.conversations.listRelayGroups(partition);
      items = page.items;
      if (page.truncated) incomplete = true;
    } catch (err) {
      // Silence, not a broken dialog. See the NEVER THROWS note above.
      deps.log.warn({ err, partition }, 'duplicate relay-group scan failed - no warning shown');
      incomplete = true;
      continue;
    }

    const matches = items
      .filter((conv) => !isImported(conv))
      .filter((conv) => samePhoneSet(rosterPhones(conv), phones));

    if (matches.length > 0) {
      const winner = [...matches].sort(byNewestActivity)[0]!;
      if (matches.length > 1) {
        deps.log.warn(
          { partition, matchCount: matches.length, conversationId: winner.conversationId },
          'several live relay groups share this exact roster - warning names the newest',
        );
      }
      return toDuplicate(winner, partition);
    }
  }

  if (incomplete) {
    deps.log.warn(
      { event: 'relay_duplicate_scan_incomplete' },
      'duplicate relay-group scan was incomplete and found nothing - no warning shown',
    );
  }
  return undefined;
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `cd app && npx vitest run test/relayGroupDuplicates.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

Read a bare `git status` first, then:

```bash
git add app/src/services/relayGroupDuplicates.ts app/test/relayGroupDuplicates.test.ts
git commit -m "feat(relay): detect a live group with exactly these members

Scans the open and connecting relay partitions for an exact phone-set match.
Exact equality only - a superset or subset is a different conversation for a
different reason, so warning about it would cry wolf on ordinary operation.

Compares participants, never the adjacent ever_member_phones, which is add-only
provenance answering a different question. Skips imported rows, which are
unconverted carrier group texts rather than relay groups we provisioned. Prefers
an open match over a connecting one so a just-created shell cannot outrank a
live thread. Never throws: the preview routes do not catch, and a failed lookup
means no warning rather than no dialog.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Carry the duplicate on the preview

**Files:**
- Modify: `app/src/services/rosterEdits.ts`
- Test: `app/test/rosterEdits.test.ts` (existing - append)

**Interfaces:**
- Consumes: `DuplicateOpenGroup` from Task 1.
- Produces: `RosterPreview.duplicateOf?: DuplicateOpenGroup`; a TRAILING OPTIONAL
  parameter `findDuplicate?: (phones: Set<string>) => Promise<DuplicateOpenGroup | undefined>`
  on BOTH `buildOpenPreview` and `buildStandaloneOpenPreview`, and a `duplicateOf?`
  field on `OpenPreviewParts`. Task 3 supplies the callback.

Signatures after this task, exactly:

```ts
export async function buildOpenPreview(
  deps: RosterResolutionDeps,
  owner: RosterOwner,
  quiet: QuietHoursState,
  findDuplicate?: (phones: Set<string>) => Promise<DuplicateOpenGroup | undefined>,
): Promise<RosterPreviewOutcome>

export async function buildStandaloneOpenPreview(
  deps: { contacts: ContactsRepo; conversations: ConversationsRepo },
  members: ConversationParticipant[],
  quiet: QuietHoursState,
  findDuplicate?: (phones: Set<string>) => Promise<DuplicateOpenGroup | undefined>,
): Promise<RosterPreview>
```

- [ ] **Step 1: Write the failing tests**

Append to `app/test/rosterEdits.test.ts`, INSIDE the existing
`describe('owner vs standalone parity', ...)` block so it inherits that block's
`beforeEach` (which seeds `world` with contacts for `ALICE` and `BOB`). It reuses that
file's existing `ownerFixture(world, participants)` helper, its `ALICE` / `BOB`
constants and its `QUIET_OFF` constant - do not introduce new fixtures.

```ts
  describe('duplicate warning (spec 5)', () => {
    const DUP = {
      conversationId: 'conv-existing',
      partition: 'open' as const,
      memberNames: ['Dana Reed', 'Marcus Bell'],
    };
    const members: ConversationParticipant[] = [
      { contactId: 'c-alice', phone: ALICE },
      { contactId: 'c-bob', phone: BOB },
    ];

    it('standalone: sets duplicateOf when the callback resolves a group', async () => {
      const preview = await buildStandaloneOpenPreview(
        { contacts: world.contactsRepo, conversations: world.conversationsRepo },
        members,
        QUIET_OFF,
        async () => DUP,
      );
      expect(preview.duplicateOf).toEqual(DUP);
    });

    it('standalone: omits duplicateOf when the callback resolves undefined', async () => {
      const preview = await buildStandaloneOpenPreview(
        { contacts: world.contactsRepo, conversations: world.conversationsRepo },
        members,
        QUIET_OFF,
        async () => undefined,
      );
      expect(preview.duplicateOf).toBeUndefined();
    });

    it('standalone: omitting the callback yields no duplicateOf and does not throw', async () => {
      const preview = await buildStandaloneOpenPreview(
        { contacts: world.contactsRepo, conversations: world.conversationsRepo },
        members,
        QUIET_OFF,
      );
      expect(preview.duplicateOf).toBeUndefined();
    });

    it('standalone: passes the callback the DEDUPED phone set it previews', async () => {
      const seen: Set<string>[] = [];
      await buildStandaloneOpenPreview(
        { contacts: world.contactsRepo, conversations: world.conversationsRepo },
        // ALICE twice - the second slot is dropped by the de-dupe, so the callback
        // must see two phones, not three. Nothing else pins WHAT is compared.
        [...members, { contactId: 'c-alice', phone: ALICE }],
        QUIET_OFF,
        async (phones) => {
          seen.push(phones);
          return undefined;
        },
      );
      expect(seen).toHaveLength(1);
      expect([...seen[0]!].sort()).toEqual([ALICE, BOB].sort());
    });

    it('owner: sets duplicateOf and receives the same deduped set', async () => {
      const { deps, owner } = ownerFixture(world, members);
      const seen: Set<string>[] = [];
      const outcome = await buildOpenPreview(deps, owner, QUIET_OFF, async (phones) => {
        seen.push(phones);
        return DUP;
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.preview.duplicateOf).toEqual(DUP);
      expect([...seen[0]!].sort()).toEqual([ALICE, BOB].sort());
    });

    it('owner: omitting the callback yields no duplicateOf', async () => {
      const { deps, owner } = ownerFixture(world, members);
      const outcome = await buildOpenPreview(deps, owner, QUIET_OFF);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.preview.duplicateOf).toBeUndefined();
    });

    it('the serialized preview contains NO phone numbers', async () => {
      const preview = await buildStandaloneOpenPreview(
        { contacts: world.contactsRepo, conversations: world.conversationsRepo },
        members,
        QUIET_OFF,
        async () => DUP,
      );
      const wire = JSON.stringify(preview);
      expect(wire).not.toContain(ALICE);
      expect(wire).not.toContain(BOB);
    });
  });
```

The `buildAddPreview` guarantee is proven by CONSTRUCTION rather than by a test here:
that function is not modified and never receives a `findDuplicate`, so it has nothing
to set. If `app/test/rosterEdits.test.ts` grows an add-preview case later, asserting
`duplicateOf` is undefined there is a cheap belt-and-braces addition.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd app && npx vitest run test/rosterEdits.test.ts -t "duplicate warning"`
Expected: FAIL - `buildStandaloneOpenPreview` takes 3 arguments, and `duplicateOf` is
not a property of `RosterPreview`.

- [ ] **Step 3: Add the field and the parameter**

In `app/src/services/rosterEdits.ts`:

Add the import beside the other service imports:

```ts
import type { DuplicateOpenGroup } from './relayGroupDuplicates.js';
```

Add the field to `RosterPreview` (currently ending at `quietEndsAt?: string;`):

```ts
  /**
   * A LIVE relay group with EXACTLY these members already exists (spec D1). Absent
   * when there is none AND when detection could not tell - the dialog cannot
   * distinguish those, by design: both mean "say nothing".
   */
  duplicateOf?: DuplicateOpenGroup;
```

Add the field to `OpenPreviewParts`:

```ts
export interface OpenPreviewParts {
  bodyMembers: PreviewBodyMember[];
  recipients: PreviewRecipientRow[];
  /** Set by the two OPEN builders; the ADD preview never sets it (spec 5). */
  duplicateOf?: DuplicateOpenGroup;
}
```

In `buildOpenPreviewFromParts`, thread it onto the result. It currently returns
`withQuietHours(...)` directly; wrap that:

```ts
  const preview = withQuietHours(
    composeIntroBody(parts.bodyMembers.map((m) => m.name)),
    parts.recipients.map(toRecipient),
    recipientCount,
    quiet,
  );
  return parts.duplicateOf === undefined
    ? preview
    : { ...preview, duplicateOf: parts.duplicateOf };
```

- [ ] **Step 4: Wire both open builders**

The shared type, declared once above `buildOpenPreview`:

```ts
/**
 * Resolve the duplicate warning for a proposed roster (spec 5). Injected rather
 * than imported so neither builder needs a ConversationsRepo with listRelayGroups
 * nor a Logger - the preview ROUTES hold both and construct this. Omitted, the
 * preview simply carries no warning, which is the correct degradation for a
 * feature that never refuses.
 *
 * The phones are passed IN because the deduped set does not exist until the
 * builder has resolved the roster: a caller has nothing to compute it from.
 */
export type FindDuplicateFn = (
  phones: Set<string>,
) => Promise<DuplicateOpenGroup | undefined>;
```

In `buildOpenPreview`, add the trailing parameter and use the ALREADY-BUILT
`provisioned` list (which is the deduped, phone-bearing set):

```ts
export async function buildOpenPreview(
  deps: RosterResolutionDeps,
  owner: RosterOwner,
  quiet: QuietHoursState,
  findDuplicate?: FindDuplicateFn,
): Promise<RosterPreviewOutcome> {
```

Immediately before its `return { ok: true, preview: buildOpenPreviewFromParts(...) }`:

```ts
  // Do NOT wrap this in try/catch. Error swallowing belongs to the detector, which
  // is the only layer that knows a failed lookup means silence rather than a broken
  // preview; a second catch here would also hide a genuine bug in a test stub.
  const duplicateOf =
    findDuplicate === undefined
      ? undefined
      : await findDuplicate(new Set(provisioned.map((m) => m.phone as string)));
```

and add `...(duplicateOf !== undefined && { duplicateOf })` to the parts object.

In `buildStandaloneOpenPreview`, add the same trailing parameter and, after the
`deduped` loop completes:

```ts
  const duplicateOf =
    findDuplicate === undefined
      ? undefined
      : await findDuplicate(new Set(deduped.map((m) => m.phone)));
```

and add `...(duplicateOf !== undefined && { duplicateOf })` to its parts object.

`buildAddPreview` is NOT changed - it never passes `duplicateOf`, so the ADD dialog has
nothing to render. That is where the no-warning-on-add guarantee lives; a renderer
cannot enforce it.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd app && npx vitest run test/rosterEdits.test.ts`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck` (expect exit 0). Read a bare `git status`, then:

```bash
git add app/src/services/rosterEdits.ts app/test/rosterEdits.test.ts
git commit -m "feat(relay): carry a duplicate warning on the open previews

RosterPreview gains an optional duplicateOf, and both open builders gain a
trailing optional findDuplicate callback that RECEIVES the deduped phone set.
The phones are passed in because that set does not exist until the builder has
resolved the roster - a caller has nothing to compute a duplicate from, which is
why the two earlier shapes for this parameter were unbuildable.

Injected rather than imported so neither builder needs listRelayGroups or a
Logger; buildStandaloneOpenPreview has no Logger in its deps at all. Omitting the
callback yields a preview with no warning, which is the right degradation for a
feature that never refuses.

buildAddPreview is untouched and so never sets the field - that is where the
no-warning-on-add guarantee lives, since a renderer cannot enforce it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire the three preview routes

**Files:**
- Modify: `app/src/routes/relayGroups.ts` (the `/relay-groups/preview` handler)
- Modify: `app/src/routes/tours.ts:930`
- Modify: `app/src/routes/placements.ts:1260`
- Test: `app/test/relayGroupPreview.test.ts` (existing - append)

**Interfaces:**
- Consumes: `findOpenGroupWithSamePhones` (Task 1), `FindDuplicateFn` (Task 2).
- Produces: all three preview endpoints serve `duplicateOf`.

- [ ] **Step 1: Write the failing test**

Append to `app/test/relayGroupPreview.test.ts`:

```ts
it('POST /api/relay-groups/preview warns when a live group has exactly these members', async () => {
  // Seed an OPEN relay group with the same two phones the preview asks about.
  await conversations.createRelayGroup({
    poolNumber: '+15550190999',
    members: [
      { contactId: '', phone: '+15558000001', name: 'Dana Reed' },
      { contactId: '', phone: '+15558000002', name: 'Marcus Bell' },
    ],
    owner: { type: null },
  });

  const res = await request(app)
    .post('/api/relay-groups/preview')
    .send({
      members: [
        { phone: '+15558000001', name: 'Dana Reed' },
        { phone: '+15558000002', name: 'Marcus Bell' },
      ],
    })
    .expect(200);

  expect(res.body.duplicateOf).toBeDefined();
  expect(res.body.duplicateOf.partition).toBe('open');
  expect(res.body.duplicateOf.memberNames).toHaveLength(2);
  expect(JSON.stringify(res.body)).not.toContain('+15558000001');
});

it('POST /api/relay-groups/preview does NOT warn for a superset roster', async () => {
  await conversations.createRelayGroup({
    poolNumber: '+15550190998',
    members: [
      { contactId: '', phone: '+15558000001', name: 'Dana Reed' },
      { contactId: '', phone: '+15558000002', name: 'Marcus Bell' },
    ],
    owner: { type: null },
  });

  const res = await request(app)
    .post('/api/relay-groups/preview')
    .send({
      members: [
        { phone: '+15558000001', name: 'Dana Reed' },
        { phone: '+15558000002', name: 'Marcus Bell' },
        { phone: '+15558000003', name: 'Third Person' },
      ],
    })
    .expect(200);

  expect(res.body.duplicateOf).toBeUndefined();
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `cd app && npx vitest run test/relayGroupPreview.test.ts -t "duplicateOf"`
Expected: FAIL - `res.body.duplicateOf` is undefined in the first case.

- [ ] **Step 3: Wire `relayGroups.ts`**

Add the import:

```ts
import { findOpenGroupWithSamePhones } from '../services/relayGroupDuplicates.js';
```

Change the preview handler's call to pass the callback as the fourth argument:

```ts
    res.json(
      await buildStandaloneOpenPreview(
        { contacts, conversations },
        members,
        await quietHoursState(),
        (phones) => findOpenGroupWithSamePhones({ conversations, log }, phones),
      ),
    );
```

- [ ] **Step 4: Wire `tours.ts` and `placements.ts`**

Both files get the same import:

```ts
import { findOpenGroupWithSamePhones } from '../services/relayGroupDuplicates.js';
```

In `tours.ts`, the preview call becomes:

```ts
    const preview = await buildOpenPreview(
      rosterDeps,
      rosterOwnerOf(tour),
      await quietHoursState(),
      (phones) => findOpenGroupWithSamePhones({ conversations, log }, phones),
    );
```

In `placements.ts`, identically:

```ts
    const preview = await buildOpenPreview(
      rosterDeps,
      rosterOwnerOf(item),
      await quietHoursState(),
      (phones) => findOpenGroupWithSamePhones({ conversations, log }, phones),
    );
```

Both routers already hold `conversations` (the full repo) and `log` in scope at these
call sites. Do NOT add the callback to any OTHER `buildOpenPreview` or
`buildAddPreview` call - the ADD previews and any non-preview caller stay unwarned.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd app && npx vitest run test/relayGroupPreview.test.ts`
Expected: PASS.

- [ ] **Step 6: Full app suite, typecheck, commit**

Run: `cd app && npx vitest run` (expect exit 0), then `npm run typecheck` (exit 0).
Read a bare `git status`, then:

```bash
git add app/src/routes/relayGroups.ts app/src/routes/tours.ts app/src/routes/placements.ts app/test/relayGroupPreview.test.ts
git commit -m "feat(relay): serve the duplicate warning from all three preview routes

Each route constructs the detector callback from the conversations repo and
logger it already holds, and passes it into the preview builder. The detector is
constructed in the routes and invoked in the builders; neither half knows the
other's job.

Scope is all three open paths deliberately. From a tenant's or landlord's side
the conversation is the item, not the tour - they are talking to a person, and it
does not matter what about - so the same pair touring two properties should not
quietly become two threads.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Render the warning

**Files:**
- Modify: `dashboard/src/api/types.ts` (mirror the type + field)
- Modify: `dashboard/src/routes/shared/RosterConfirmDialog.tsx`
- Modify: `dashboard/src/routes/shared/RosterConfirmDialog.module.css` (if the file
  exists; otherwise use the existing class conventions in the component)
- Test: `dashboard/src/routes/shared/RosterConfirmDialog.test.tsx` (existing - append)

**Interfaces:**
- Consumes: the wire shape from Task 3.
- Produces: nothing downstream. `onConfirm` is UNCHANGED.

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/src/routes/shared/RosterConfirmDialog.test.tsx`:

```tsx
describe('duplicate warning', () => {
  const withDuplicate = (partition: 'open' | 'connecting'): RosterPreview => ({
    body: 'You are connected.',
    recipients: [{ name: 'Dana Reed', reachability: 'reachable' }],
    recipientCount: 1,
    deferred: false,
    duplicateOf: {
      conversationId: 'conv-existing',
      partition,
      memberNames: ['Dana Reed', 'Marcus Bell'],
    },
  });

  it('names the existing group and links to it', () => {
    render(
      <RosterConfirmDialog
        title="Open the relay group?"
        preview={withDuplicate('open')}
        confirmLabel="Open relay group"
        deferLabel="Open"
        onConfirm={async () => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/already have an open relay group/i)).toBeInTheDocument();
    expect(screen.getByText(/Dana Reed and Marcus Bell/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /view (the )?existing group/i });
    expect(link).toHaveAttribute('href', '/conversations/conv-existing');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('uses the connecting wording when the match is connecting', () => {
    render(
      <RosterConfirmDialog
        title="Open the relay group?"
        preview={withDuplicate('connecting')}
        confirmLabel="Open relay group"
        deferLabel="Open"
        onConfirm={async () => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/relay group being connected/i)).toBeInTheDocument();
  });

  it('renders nothing when there is no duplicate', () => {
    render(
      <RosterConfirmDialog
        title="Open the relay group?"
        preview={{ body: 'x', recipients: [], recipientCount: 0, deferred: false }}
        confirmLabel="Open relay group"
        deferLabel="Open"
        onConfirm={async () => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(/already have/i)).not.toBeInTheDocument();
  });

  it('does not change the confirm contract - onConfirm still receives only force', async () => {
    const onConfirm = vi.fn(async () => {});
    render(
      <RosterConfirmDialog
        title="Open the relay group?"
        preview={withDuplicate('open')}
        confirmLabel="Open relay group"
        deferLabel="Open"
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open relay group' }));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `cd dashboard && npx vitest run src/routes/shared/RosterConfirmDialog.test.tsx`
Expected: FAIL - no warning text, and `duplicateOf` is not on the client `RosterPreview`.

- [ ] **Step 3: Mirror the type**

In `dashboard/src/api/types.ts`, above `RosterPreview`:

```ts
/**
 * A live relay group with EXACTLY the members being proposed (server-detected).
 * Names only - the wire never carries member phones.
 */
export interface DuplicateOpenGroup {
  conversationId: string;
  partition: 'open' | 'connecting';
  memberNames: string[];
}
```

and inside `RosterPreview`, after `quietEndsAt?: string;`:

```ts
  /** A live group with exactly these members already exists. Absent when none
   *  does AND when the server could not tell - both mean "say nothing". */
  duplicateOf?: DuplicateOpenGroup;
```

- [ ] **Step 4: Render the block**

In `RosterConfirmDialog.tsx`, immediately above the recipient list, add:

```tsx
      {preview.duplicateOf !== undefined ? (
        <div className={styles.duplicateWarning} role="status">
          <p>
            <strong>{formatNames(preview.duplicateOf.memberNames)}</strong>{' '}
            {preview.duplicateOf.partition === 'connecting'
              ? 'already have a relay group being connected.'
              : 'already have an open relay group.'}
          </p>
          <p>
            {preview.duplicateOf.partition === 'connecting'
              ? 'That group is still waiting on a number, and this one will get a second - so they would end up with two numbers for one conversation and no way to tell which one you are watching.'
              : 'This group will get its own separate number, so they would have two numbers for one conversation and no way to tell which one you are watching.'}
          </p>
          <a
            href={`/conversations/${preview.duplicateOf.conversationId}`}
            target="_blank"
            rel="noreferrer"
          >
            View the existing group
          </a>
        </div>
      ) : null}
```

and add the helper above the component:

```tsx
/** "A", "A and B", "A, B and C" - the warning names who is already grouped. */
function formatNames(names: string[]): string {
  if (names.length === 0) return 'These people';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}
```

COPY RULES, from spec 5 - do not restate them in other words:
- Never say messages may go to the wrong thread. They will not; routing is
  deterministic, and an operator who checks and finds the claim false will discount the
  next warning too.
- Make NO claim about pool accounting - not "buys", not "consumes a number". What a
  duplicate costs the pool is genuinely variable.
- The link is NOT the primary action and opens in a new tab: navigating the current tab
  away discards the half-built group the operator is standing in.
- The dialog's own buttons, including the quiet-hours defer/send-now pair, keep their
  existing labels, positions and behavior.

Style `.duplicateWarning` to match the component's existing warning treatment (the
quiet-hours notice is the precedent in this file).

- [ ] **Step 5: Run and verify they pass**

Run: `cd dashboard && npx vitest run src/routes/shared/RosterConfirmDialog.test.tsx`
Expected: PASS.

- [ ] **Step 6: Full dashboard suite, typecheck, commit**

Run: `cd dashboard && npx vitest run` (exit 0), then `npm run typecheck` (exit 0).
Read a bare `git status`, then:

```bash
git add dashboard/src/api/types.ts dashboard/src/routes/shared/RosterConfirmDialog.tsx dashboard/src/routes/shared/RosterConfirmDialog.module.css dashboard/src/routes/shared/RosterConfirmDialog.test.tsx
git commit -m "feat(relay): warn in the confirm dialog when this group already exists

Names who already has a group, says what the second one costs them, and links to
it in a new tab - the link is deliberately not the primary action, because
navigating away would discard the half-built group the operator is standing in.

The copy makes no claim that messages could go to the wrong thread. They cannot:
the two groups sit on different numbers and routing is deterministic. It also
makes no claim about pool accounting, which is genuinely variable. What is always
true is two numbers between the same people, so that is what it says.

onConfirm is unchanged. Nothing is refused and nothing is acknowledged.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: End-to-end proof

**Files:**
- Modify: `e2e/tests/dashboard-next/relay-group-view.spec.ts` (or the relay spec whose
  fixtures best fit; do NOT modify `e2e/fixtures/relayConnect.ts`)

**Interfaces:**
- Consumes: `createGroupOpen` from `e2e/fixtures/relayConnect.ts`, READ-ONLY.

- [ ] **Step 1: Write the spec**

```ts
test('a second group for the same pair warns, and is still created', async ({ page }) => {
  await devLogin(page);

  const tenant = { phone: uniquePhone(), name: 'Dup Tenant' };
  const landlord = { phone: uniquePhone(), name: 'Dup Landlord' };

  // createGroupOpen drives the connect-when-ready sequence: in the hermetic lane a
  // fresh pair lands CONNECTING with no pool number (twilio driver, K=0, seeded pool
  // numbers are console-tagged), and the helper registers the warmed number.
  const first = await createGroupOpen(page, [tenant, landlord]);
  expect(first.status).toBe('open');

  // Preview the SAME pair again - the server must report the duplicate.
  const preview = await page.request.post('/api/relay-groups/preview', {
    data: { members: [tenant, landlord] },
  });
  expect(preview.ok()).toBeTruthy();
  const body = await preview.json();
  expect(body.duplicateOf, 'an identical live pair must be reported').toBeTruthy();
  expect(body.duplicateOf.conversationId).toBe(first.conversationId);

  // Nothing is refused: creating it anyway succeeds (spec D5).
  const created = await page.request.post('/api/relay-groups', {
    data: { members: [tenant, landlord] },
  });
  expect(created.status(), 'the duplicate is created, not refused').toBe(201);
});

test('a superset roster does NOT warn', async ({ page }) => {
  await devLogin(page);

  const tenant = { phone: uniquePhone(), name: 'Superset Tenant' };
  const landlord = { phone: uniquePhone(), name: 'Superset Landlord' };
  const third = { phone: uniquePhone(), name: 'Superset Third' };

  await createGroupOpen(page, [tenant, landlord]);

  const preview = await page.request.post('/api/relay-groups/preview', {
    data: { members: [tenant, landlord, third] },
  });
  const body = await preview.json();
  // Without this, a regression to containment-matching passes every other test.
  expect(body.duplicateOf, 'a superset is a different conversation').toBeUndefined();
});
```

- [ ] **Step 2: Run the suite**

Run: `npm run e2e`
Expected: exit 0. Re-run ONCE on a failure in `tour-reminders-panel-e2e-flake` or
`conversationdetail-members-mock-suite-flake` and report BOTH runs.

- [ ] **Step 3: Commit**

Read a bare `git status`, then commit the spec file only.

---

### Task 6: File the deliberate gaps

**Files:**
- Create: five files under `docs/issues/`, each copied from `docs/issues/_TEMPLATE.md`.

- [ ] **Step 1: Write the issues**

One file each, `type: improvement` unless noted, `severity: low`, `status: open`,
`area: app`, `created: 2026-08-18`:

1. `relay-single-live-conversation-per-pair.md` (`type: decision`) - if a pair should
   only ever have one live conversation, the eventual right behavior is to route new
   context INTO the existing group rather than warn about a second. Much larger product
   change; deliberately not built.
2. `relay-duplicate-across-contact-handsets.md` - the same two humans reached on
   DIFFERENT numbers will not match, because the comparison is by phone (spec D3).
3. `relay-duplicate-via-roster-removal.md` - removing C from a live `{A,B,C}` beside a
   live `{A,B}` lands on an existing set without creating anything, so no preview runs.
4. `relay-duplicate-via-reopen.md` - reopening a closed `{A,B}` beside a live `{A,B}`
   creates the state with no warning. There IS a confirm modal
   (`dashboard/src/routes/conversation/ConversationDetail.tsx:680-710`); what reopen
   lacks is a preview endpoint to call the detector from.
5. `relay-duplicate-detection-scan-cost.md` (`type: debt`) - each preview walks both
   live partitions to exhaustion, and the no-match case always pays the maximum. The
   perf workload already drives both affected endpoints against the 1,000-group seed.

- [ ] **Step 2: Regenerate the index and commit**

Run: `npm run issues`
Read a bare `git status`, then commit the five files (NOT the gitignored
`docs/issues/INDEX.md`).

---

### Task 7: Final gates

- [ ] **Step 1: Sync main into the branch ONCE**

```bash
git -C "W:/tmp/relay-number-reuse" merge main
```

Resolve any conflict preserving both sides' intent. If `main` has advanced in a way
that conflicts with active work elsewhere, STOP and ask before syncing.

- [ ] **Step 2: Run the three gates BARE, from the worktree**

Never pipe them - a pipe returns the tail command's exit code and hides a real failure.

```
npm run typecheck
npm test
npm run e2e
```

Record the REAL exit code of each. For `npm test`, the known-flaky
`app/test/groupCrossCheck.test.ts` and `unreadIndexRepo.integration.test.ts` must be
re-run once before being blamed on this change, with BOTH runs reported.

- [ ] **Step 3: Hand back**

Report quoted exit codes, the reviewer findings and their adjudication, and a
single-line PowerShell merge command. Do NOT merge.

---

## Self-Review

**Spec coverage.** D1 -> Task 1 Steps 1/3 and Task 5. D2 -> Task 2 Step 4 (the deduped
set) and its argument test. D2a -> Task 1's adjacent-field test. D4 -> Task 1's
partition tests and the imported-row skip. D5 (nothing refuses) -> Task 4's
onConfirm-unchanged test and Task 5's 201 assertion. D6 -> Task 1's four cases.
D7 (preview only) -> Task 3 Step 4's "do NOT add the callback to any other call".
Spec 5's copy rules -> Task 4 Step 4. Spec 6 (cost) -> issue 5. Spec 8 (gaps) -> Task 6.

**Placeholders.** None: every code step carries runnable code, every run step names the
exact command and expected result.

**Type consistency.** `DuplicateOpenGroup` is defined once in Task 1, imported by
Task 2, mirrored by hand in Task 4 with identical field names and the same
`'open' | 'connecting'` union. `FindDuplicateFn` is declared in Task 2 and used in
Task 3. `findOpenGroupWithSamePhones` keeps one signature throughout.

**Test fixtures verified, not assumed.** Task 2's tests were first written against
invented helpers (`standaloneDeps()`, `quietState()`), which do not exist. They are now
written against what `app/test/rosterEdits.test.ts` actually has: the `ownerFixture`
helper at :116, the `ALICE`/`BOB` constants at :101-102, the `QUIET_OFF` constant at
:27, and the `world` seeded by the parity block's `beforeEach`. That is why Task 2 says
to append INSIDE that describe block rather than at file scope.
