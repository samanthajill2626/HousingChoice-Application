# Research: tests, dashboard, e2e surface for the Unknown-tab contact-side read

READ-ONLY reconnaissance of `W:\tmp\inbox-unread-cluster` (branch
`feat/inbox-unread-cluster`, HEAD `1dde0bc9`, working tree CLEAN). Nothing was
modified; no tests, servers or containers were started.

Scope: plan
`docs/superpowers/plans/2026-08-25-inbox-unknown-tab-contact-side-read.md`
Tasks 2, 3, 5 (steps 8-10), 6, 7, 8, 9, plus the spec
`docs/superpowers/specs/2026-08-25-inbox-unknown-tab-walk-design.md`.

Everything below was read from the worktree today. Line numbers are CURRENT.

---

## 0. DRIFT FINDINGS (read this first)

**Headline: the plan's line citations are unusually accurate. Nothing has
drifted enough to break an edit.** The worktree is clean and the last three
commits are docs-only (`1dde0bc9`, `c7d5a9ff`, `0f763196`), so no code has
moved since the plan was written. The findings below are the complete list of
discrepancies, all minor, plus the places where the plan's PROSE (not its line
numbers) is wrong or incomplete.

### D-1. `inboxGroups.test.ts` filter=unknown test - plan cites ":357", correct but ambiguous

Plan Task 2 Step 4 says "the `filter=unknown` test at line 357". The `it(` line
IS 357; the assertions the plan cares about are at 368-369. Not drift, but the
plan's Task 5 Step 11 refers to "its `calls.groupLimits` pin" - that pin is at
line **368**, not 357.

### D-2. `unreadIndexFake.ts` LEK doc comment - plan cites ":104-116", actual is 104-117

The doc block opens at 104 and its closing `*/` is at **117** (line 116 is the
last prose line). The second citation `:180-187` is exact. Immaterial for
copying, but a builder quoting "104-116" into a new comment will cite a range
that stops one line short of the block.

### D-3. `twilioWebhookHarness.ts` carries a COMMENT that contradicts the plan's constraint

The plan's Global Constraints correctly state the fake applies the soft-delete
filter BEFORE `Limit`. **But the fake's own comment at lines 1692-1696 claims
the opposite** - "MODELS `Limit` AS DYNAMODB APPLIES IT (fix wave 2,
adversarial 6): the page is drawn FIRST and any FilterExpression is applied to
what came back". That comment is true ONLY for `excludeOrigin` (applied at
1702-1705, after the slice); it is FALSE for `deleted` and `status` (applied at
1689-1691, inside the `partition` construction, before the slice at 1701).

**Consequence for the build:** a builder who reads the harness before reading
the plan will conclude the plan's constraint is wrong and may "fix" the
harness - which the plan forbids. Flag this in the handback. Do not edit it.

### D-4. Plan's phrase "the harness has no sparse-status filter" - CONFIRMED, and it is the harness's THIRD infidelity

Confirmed: there is no `.filter((c) => c.status !== undefined)` anywhere in the
harness's `listByType`. The plan names this. Worth restating because it is the
one infidelity that changes ROW SETS rather than round-trip counts.

### D-5. `inbox.integration.test.ts` - the plan's "line ~427" is the START of the last `it`, which ENDS at 430

Plan Task 6 Step 3 says "after the last `it` (line ~427)". The last `it` is
`427-430`; the `describe` closes at **431**. Insert between 430 and 431.

### D-6. The issue's "UNKNOWN: STILL OPEN" bullet is 153-156 PLUS a nested sub-bullet at 157-163

Plan Task 9 says "its line 153 currently reads...". True, but replacing "the
status line" naively will orphan or clobber the nested
`- **CORRECTED 2026-08-25.**` sub-bullet at 157-163, which carries a standing
instruction ("that claim... is disproven above and must not be built"). See
section K for the exact structure.

### D-7. Plan is SILENT on a real hazard in `inboxFeed.test.ts` Task 2 Step 3

The plan tells the builder to add `listByType: 0, listByLastActivity: <n>` to
four whole-object literals and to "run, read, pin". Confirmed the four hits are
at 647, 727, 759, 800 exactly as the plan says. The plan's PREDICTION of `<n>`
(0 for the three unread tests, 1 for the unknown test at 736) is consistent
with what the fixtures imply, but note that the test at **800-807 is
`filter: 'unread'`**, not unknown - the plan's parenthetical "the `filter:
'unknown'` test at ~736 walks the pager once today" covers only 759-765. The
other three are all unread and should be 0.

### D-8. NOT drift, but the single sharpest correction to the plan's framing

The plan's Task 8 says the lean seed "seeds tenant/landlord/partner only". This
is CONFIRMED and stronger than stated: the lean seed has exactly THREE contacts
total. The `team_member` string that appears at `lean.ts:155-158` is
**historical commentary inside a comment**, not a seeded contact - Renee Carter
was retyped to `partner` on 2026-08-24 (`lean.ts:162`). So there is no
class-(c) row in the e2e world either, and the Unknown tab is empty in the lean
world BOTH before and after the flip.

---

## A. `app/test/inboxFeed.test.ts` (2344 lines)

### A.1 `InboxCallCounts` and `emptyCallCounts()` - CURRENT lines 63-79

Plan cites "~63-79". EXACT.

```ts
interface InboxCallCounts {          // 63
  queryUnreadPage: number;           // 64
  findByPhone: number;               // 65
  findByParticipantPhone: number;    // 66
  listByConversation: number;        // 67
  getPlacementById: number;          // 68
}                                    // 69
                                     // 70
function emptyCallCounts(): InboxCallCounts {  // 71
  return {                                     // 72
    queryUnreadPage: 0,                        // 73
    findByPhone: 0,                            // 74
    findByParticipantPhone: 0,                 // 75
    listByConversation: 0,                     // 76
    getPlacementById: 0,                       // 77
  };                                           // 78
}                                              // 79
```

### A.2 The `makeDeps` fake

**Signature (lines 86-91):**

```ts
function makeDeps(
  seed: Seed,
  calls?: InboxCallCounts,
  logger?: InboxRouterDeps['logger'],
  routerOpts?: { unreadWalkLimit?: number },
): InboxRouterDeps {
```

**CONFIRMED: the plan's Task 5 Step 9 call shape
`makeDeps({contacts, conversations, latestMessage, placements}, calls)` is
EXACTLY right.** `Seed` (33-61) declares `conversations`, `contacts`,
`latestMessage?`, `placements?` among its fields, and `calls` is positional
arg 2.

**`seed.contacts` EXISTS.** `Seed.contacts` is declared at line **39** with
type `ContactItem[]` (imported at line 29 from `../src/repos/contactsRepo.js`).
It is `ContactItem[]`, NOT readonly, so it satisfies the Task 1 helper's
`readonly ContactItem[]` parameter with no cast.

**Local names in scope inside the `contactsRepo` fake:** `seed` (param 1) and
`calls` (param 2) - both directly in scope, exactly as the plan's snippet
assumes. Also in scope: `ordered`, `participantView`, `contactByPhone`,
`logger`, `routerOpts`.

**`contactsRepo` block byte-exact - CURRENT lines 190-210** (plan cites
"190-210" - EXACT):

```ts
    contactsRepo: {
      async findByPhone(phone: string) {
        if (calls !== undefined) calls.findByPhone += 1;
        return contactByPhone(phone);
      },
      // A18 again: layer 2 falls through to this whenever findByPhone misses.
      async findByEmail(email: string) {
        return seed.contacts.find((c) => {
          if (c.phone_ref === true) return false;
          const emails = Array.isArray(c.emails) && c.emails.length > 0
            ? c.emails.map((e) => e.email)
            : typeof c.email === 'string'
              ? [c.email]
              : [];
          return emails.includes(email);
        });
      },
      async getById(contactId: string) {
        return seed.contacts.find((c) => c.contactId === contactId);
      },
    } as unknown as NonNullable<InboxRouterDeps['contactsRepo']>,
```

The plan says to add `listByType` "after `getById`" - that is after line 209,
before the `} as unknown as ...` on 210.

**`conversationsRepo.listByLastActivity` byte-exact - CURRENT lines 131-151**
(plan cites "~line 131" - EXACT):

```ts
      async listByLastActivity({
        limit,
        exclusiveStartKey,
      }: {
        status: string;
        limit?: number;
        exclusiveStartKey?: Record<string, unknown>;
      }) {
        const start =
          typeof exclusiveStartKey?.['idx'] === 'number'
            ? (exclusiveStartKey['idx'] as number) + 1
            : 0;
        const take = limit ?? 50;
        const window = ordered.slice(start, start + take);
        const endIdx = start + window.length - 1;
        const hasMore = start + window.length < ordered.length;
        return {
          items: window,
          ...(hasMore && { lastEvaluatedKey: { idx: endIdx } as Record<string, unknown> }),
        };
      },
```

The plan's "first line of the function body" for the counter increment means
after line 138 (`}) {`), before line 139 (`const start =`).

**`conv()` helper signature - CURRENT lines 229-240ff:**

```ts
function conv(overrides: Partial<ConversationItem> & { conversationId: string; participant_phone: string; last_activity_at: string }): ConversationItem {
```

Note `participant_phone` is REQUIRED here (unlike the Task 3 parity file's own
`conv()`, which the plan defines with only `conversationId` +
`last_activity_at` required). The plan's Step 9 replacement passes all three.
OK.

Existing helper import precedent at line 31:
`import { queryUnreadPageFromItems, unreadFlagFor } from './helpers/unreadIndexFake.js';`

### A.3 `rg -n "expect\(calls\)\.toEqual" app/test/inboxFeed.test.ts` - FOUR hits

Grep output: `647:`, `727:`, `759:`, `800:`. **The plan's list (647-653,
727-733, 759-765, 800-807) is EXACT.** Full literals with ranges:

**Hit 1 - lines 647-653**, inside
`it('a read no-contact row is not in the unread index: no contact resolution, no message hydration', ...)`
(`filter: 'unread'`, starts 621). Preceded by the comment the plan quotes:

```ts
    // THE ZERO-UNREAD COST CONTRACT (spec 4.4/4.5): exactly ONE index query and
    // no hydration read of any kind. Whole-object toEqual, so a future read
    // cannot slip in unnoticed.
    expect(calls).toEqual({
      queryUnreadPage: 1,
      findByPhone: 0,
      findByParticipantPhone: 0,
      listByConversation: 0,
      getPlacementById: 0,
    });
```

**Hit 2 - lines 727-733**, inside
`it('a fully-read contact is not in the unread index: no contact, conversation, message or placement read', ...)`
(`filter: 'unread'`, starts 704):

```ts
    expect(calls).toEqual({
      queryUnreadPage: 1,
      findByPhone: 0,
      findByParticipantPhone: 0,
      listByConversation: 0,
      getPlacementById: 0,
    });
```

**Hit 3 - lines 759-765**, inside
`it('rejects a resolved non-unknown contact before conversation and message hydration', ...)`
(`filter: 'unknown'`, starts 736 - THIS is the test the plan rewrites):

```ts
    expect(calls).toEqual({
      queryUnreadPage: 0,
      findByPhone: 1,
      findByParticipantPhone: 0,
      listByConversation: 0,
      getPlacementById: 0,
    });
```

**Hit 4 - lines 800-807**, inside
`it('keeps a failed contact-conversation lookup excluded from unread without downstream hydration', ...)`
(`filter: 'unread'`, starts 768):

```ts
    expect(calls).toEqual({
      queryUnreadPage: 1,
      findByPhone: 1,
      findByParticipantPhone: 2,
      // Still NO downstream hydration: the drop happens before any of it.
      listByConversation: 0,
      getPlacementById: 0,
    });
```

Only hit 3 is a `filter: 'unknown'` test. Hits 1, 2, 4 are `filter: 'unread'`,
so `listByLastActivity` should pin to 0 in all three (the unread branch returns
before the pager); hit 3 is replaced wholesale by the plan's new cost pin.

### A.4 `rg -n "type: 'unknown'" app/test/inboxFeed.test.ts` - EXACTLY TWO hits. CONFIRMED.

**The plan's claim of exactly two sites, at ~415-421 and ~521, is CORRECT.**
Current lines: **417** and **521**.

**Site 1 - the `c-unk` / Alexis contact literal, lines 415-422** (the plan says
"~415-421"; the literal actually closes at 422). Full test 411-436:

```ts
  it('a type="unknown" CONTACT (untriaged inbound WITH a record) → needsTriage:true and appears under the "unknown" filter', async () => {
    // Regression: the seed models untriaged inbound as a type=unknown contact, so
    // findByPhone resolves it (needsTriage was hardcoded false for contact rows) →
    // it was excluded from the "unknown" filter even though it needs triage.
    const contact: ContactItem = {
      contactId: 'c-unk',
      type: 'unknown',
      firstName: 'Alexis',
      lastName: 'Monroe',
      phone: '+15550009999',
      phones: [{ phone: '+15550009999', primary: true }],
    };
    const deps = makeDeps({
      contacts: [contact],
      conversations: [
        conv({ conversationId: 'conv-u', participant_phone: '+15550009999', last_activity_at: '2026-06-12T10:00:00.000Z', unread_count: 1, type: 'unknown_1to1' }),
      ],
    });

    const all = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(all.rows[0]).toMatchObject({ kind: 'contact', contactId: 'c-unk', role: 'unknown', needsTriage: true });

    const unknown = await aggregateInbox({ filter: 'unknown', limit: 25 }, deps);
    expect(unknown.rows).toHaveLength(1);
    expect(unknown.rows[0]!.contactId).toBe('c-unk');
  });
```

Plan's edit: add `status: 'needs_review',` after `type: 'unknown',` (line 417).
Its assertions (434-435) then hold unchanged. NOTE this file's `conv()` does
NOT carry a `status` default for CONTACTS - only conversations - so the
sparseness rule genuinely bites here.

**Site 2 - the relay-matrix seed, line 521.** Full test 519-543:

```ts
  it('relay filter matrix: in "all"+"unread" (when unread>0); NEVER in "unknown"', async () => {
    const seed: Seed = {
      contacts: [{ contactId: 'c-unk', type: 'unknown', phone: '+14049824978' }],
      conversations: [
        relayConv({ conversationId: 'r-unread', pool_number: '+15550160001', last_activity_at: '2026-06-14T10:00:00.000Z', unread_count: 3,
          participants: [{ contactId: 'c-x', phone: '+15550000201', name: 'Keisha' }] }),
        relayConv({ conversationId: 'r-read', pool_number: '+15550160002', last_activity_at: '2026-06-13T10:00:00.000Z',
          participants: [{ contactId: 'c-y', phone: '+15550000202', name: 'Lars' }] }),
        conv({ conversationId: 'conv-unk', participant_phone: '+14049824978', last_activity_at: '2026-06-12T10:00:00.000Z', type: 'unknown_1to1', unread_count: 1 }),
      ],
    };

    const all = await aggregateInbox({ filter: 'all', limit: 25 }, makeDeps(seed));
    expect(all.rows.filter((r) => r.kind === 'relay_group').map((r) => r.conversationId).sort())
      .toEqual(['r-read', 'r-unread']);

    const unread = await aggregateInbox({ filter: 'unread', limit: 25 }, makeDeps(seed));
    // r-unread (unread 3) qualifies; r-read (unread 0) does not.
    expect(unread.rows.filter((r) => r.kind === 'relay_group').map((r) => r.conversationId)).toEqual(['r-unread']);

    const unknown = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps(seed));
    // NO relay row ever appears under "unknown" - only the untriaged 1:1.
    expect(unknown.rows.every((r) => r.kind !== 'relay_group')).toBe(true);
    expect(unknown.rows.map((r) => r.phone)).toEqual(['+14049824978']);
  });
```

Plan's edit at 521:
`{ contactId: 'c-unk', type: 'unknown', status: 'needs_review', phone: '+14049824978' }`.
The pin at 542 (`['+14049824978']`) then holds. NOTE 541
(`every((r) => r.kind !== 'relay_group')`) becomes vacuously true post-flip
(the unknown branch returns before the relay merge) - it will still PASS, but
it stops proving anything. Worth a comment.

### A.5 The two tests the plan rewrites

**(a) plan ~591-613 - CURRENT lines 591-613. EXACT.**

```ts
  it('filter "unread" keeps only unreadCount>0; "unknown" keeps only needsTriage', async () => {
    const baseSeed: Seed = {
      contacts: [
        { contactId: 'c-read', type: 'tenant', phone: '+15550000001' },
        { contactId: 'c-unread', type: 'tenant', phone: '+15550000002' },
      ],
      conversations: [
        conv({ conversationId: 'conv-read', participant_phone: '+15550000001', last_activity_at: '2026-06-10T10:00:00.000Z', unread_count: 0 }),
        conv({ conversationId: 'conv-unread', participant_phone: '+15550000002', last_activity_at: '2026-06-11T10:00:00.000Z', unread_count: 4 }),
        conv({ conversationId: 'conv-unk', participant_phone: '+14049824978', last_activity_at: '2026-06-09T10:00:00.000Z', type: 'unknown_1to1', unread_count: 1 }),
      ],
    };

    const unread = await aggregateInbox({ filter: 'unread', limit: 25 }, makeDeps(baseSeed));
    expect(unread.rows.every((r) => r.unreadCount > 0)).toBe(true);
    expect(unread.rows.map((r) => r.contactId ?? r.phone).sort()).toEqual(
      ['+14049824978', 'c-unread'].sort(),
    );

    const unknown = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps(baseSeed));
    expect(unknown.rows.every((r) => r.needsTriage)).toBe(true);
    expect(unknown.rows.map((r) => r.phone)).toEqual(['+14049824978']);
  });
```

The plan replaces lines 610-612 only. `baseSeed` really does have NO contact
for `+14049824978` (contacts are only `c-read`/`c-unread`), so the plan's
"the queue is empty" reasoning holds.

**(b) plan ~736-766 - CURRENT lines 736-766. EXACT.** Quoted in full in A.3
hit 3's surrounding test; the body:

```ts
  it('rejects a resolved non-unknown contact before conversation and message hydration', async () => {
    const calls = emptyCallCounts();
    const page = await aggregateInbox(
      { filter: 'unknown', limit: 30 },
      makeDeps({
        contacts: [{ contactId: 'contact-tenant', type: 'tenant', phone: '+14045550105' }],
        conversations: [
          conv({
            conversationId: 'conv-tenant',
            participant_phone: '+14045550105',
            last_activity_at: '2026-06-12T10:00:00.000Z',
            unread_count: 1,
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
      queryUnreadPage: 0,
      findByPhone: 1,
      findByParticipantPhone: 0,
      listByConversation: 0,
      getPlacementById: 0,
    });
  });
```

The plan's replacement uses the IDENTICAL `makeDeps({...}, calls)` shape.
CONFIRMED valid.

### A.6 The unknown-filter test at plan ~387-409 - CURRENT lines 387-409. EXACT.

```ts
  it('a partner CONTACT -> kind:"contact", role:"partner", needsTriage:false (A2 parity)', async () => {
    const contact: ContactItem = {
      contactId: 'c-partner',
      type: 'partner',
      firstName: 'Casey',
      lastName: 'Worker',
      phone: '+15550008888',
      phones: [{ phone: '+15550008888', primary: true }],
    };
    const deps = makeDeps({
      contacts: [contact],
      conversations: [
        conv({ conversationId: 'conv-p', participant_phone: '+15550008888', last_activity_at: '2026-06-12T10:00:00.000Z', unread_count: 1, type: 'partner_1to1' }),
      ],
    });

    const all = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(all.rows[0]).toMatchObject({ kind: 'contact', contactId: 'c-partner', role: 'partner', needsTriage: false });

    // A resolved partner is NOT an untriaged unknown -> excluded from "unknown".
    const unknown = await aggregateInbox({ filter: 'unknown', limit: 25 }, deps);
    expect(unknown.rows).toHaveLength(0);
  });
```

Needs no edit: the partner contact carries no `status`, so it is invisible to
the sparse partition anyway, AND its type is not `unknown`. Rows `[]` both
before and after. The plan is right.

---

## B. `app/test/inboxGroups.test.ts` (445 lines)

### B.1 `contactsRepo` fake - CURRENT lines 101-109. Plan cites "101-109". EXACT.

```ts
    contactsRepo: {
      async findByPhone(phone: string) {
        const c = (seed.contacts ?? []).find((x) => x.phone === phone);
        return c ? { ...c, status: 'active' } : undefined;
      },
      async getById(contactId: string) {
        return (seed.contacts ?? []).find((x) => x.contactId === contactId);
      },
    } as unknown as NonNullable<InboxRouterDeps['contactsRepo']>,
```

Insert point for `listByType`: after line 108, before 109.

### B.2 Local seed name and type

The local is `seed`, typed `GroupSeed` (parameter of
`makeDeps(seed: GroupSeed)` at line 39). Its contacts field, line **31**:

```ts
  contacts?: { contactId: string; phone: string; name?: string }[];
```

**CONFIRMED the plan's `(seed.contacts ?? []) as never` is necessary and its
reasoning is exactly right:** the element type has NO `type` and NO `status`
field, so `listByTypeFromContacts` filters everything out twice over (the
sparse-status filter AND the type-equality filter). The unknown partition is
provably empty in this suite.

The file already imports helpers at line 21:
`import { queryUnreadPageFromItems, unreadFlagFor } from './helpers/unreadIndexFake.js';`

`makeDeps` returns `{ deps, calls }` (line 39, `Calls` interface at 34-37 with
`groupLimits` / `groupCursors`).

### B.3 The `filter=unknown` test - CURRENT lines 357-370. Plan cites ":357". EXACT.

```ts
  it('never reads the group partition under filter=unknown (needsTriage is always false)', async () => {
    const { deps, calls } = makeDeps({
      groups: [
        groupConv({
          conversationId: 'gt-1',
          last_activity_at: '2026-06-17T10:00:00.000Z',
          unread_count: 4,
        }),
      ],
    });
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, deps);
    expect(calls.groupLimits).toEqual([]);
    expect(page.rows).toEqual([]);
  });
```

The `calls.groupLimits` assertion is line **368**. Post-flip it stays green for
a STRONGER reason (the unknown branch returns before the group source gate),
which is exactly the plan's Task 5 Step 11 claim. This test needs no edit but
DOES require the `listByType` fake from Task 2 Step 4, or it TypeErrors.

---

## C. `app/test/inboxApi.test.ts` (1467 lines)

### C.1 The test at plan 199-218 - CURRENT lines 199-218. EXACT.

```ts
  it('filter=unread only unread; filter=unknown only needsTriage', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-read', type: 'tenant', phone: '+15550000001' });
    seedContact(world, { contactId: 'c-unread', type: 'tenant', phone: '+15550000002' });
    seedConversation(world, 'conv-read', { participant_phone: '+15550000001', last_activity_at: '2026-06-10T10:00:00.000Z', unread_count: 0 });
    seedConversation(world, 'conv-unread', { participant_phone: '+15550000002', last_activity_at: '2026-06-11T10:00:00.000Z', unread_count: 4 });
    seedConversation(world, 'conv-unk', { participant_phone: '+14049824978', last_activity_at: '2026-06-09T10:00:00.000Z', type: 'unknown_1to1', unread_count: 1 });

    const unread = await auth(request(app).get('/api/inbox?filter=unread'));
    expect(unread.status).toBe(200);
    expect(unread.body.rows.every((r: { unreadCount: number }) => r.unreadCount > 0)).toBe(true);
    expect(
      unread.body.rows.map((r: { contactId?: string; phone?: string }) => r.contactId ?? r.phone).sort(),
    ).toEqual(['+14049824978', 'c-unread'].sort());

    const unknown = await auth(request(app).get('/api/inbox?filter=unknown'));
    expect(unknown.status).toBe(200);
    expect(unknown.body.rows.every((r: { needsTriage: boolean }) => r.needsTriage)).toBe(true);
    expect(unknown.body.rows.map((r: { phone: string }) => r.phone)).toEqual(['+14049824978']);
  });
```

The plan's rewrite (Task 5 Step 10) inserts new seeds and replaces 214-217.
**CONFIRMED there is no contact for `+14049824978` in this seed.**

### C.2 EXACT helper signatures

**`auth` - lines 29-30 (a const arrow, NOT a function declaration):**

```ts
const auth = (req: request.Test) =>
  req.set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
```

**`World` type alias - line 32:**

```ts
type World = ReturnType<typeof createFakeWorld>;
```

**`seedConversation` - lines 34-53:**

```ts
function seedConversation(
  world: World,
  id: string,
  overrides: Partial<ConversationItem> & { participant_phone: string; last_activity_at: string },
): ConversationItem {
  const item: ConversationItem = {
    conversationId: id,
    status: 'open',
    type: 'tenant_1to1',
    ai_mode: 'auto',
    created_at: overrides.last_activity_at,
    // FLAG IFF COUNT>0, derived centrally (helpers/unreadIndexFake.ts): the
    // sparse byUnread index keys on `unread_flag`, so a fixture with unread and
    // no flag is invisible to every index-fed read. Overridable below.
    ...unreadFlagFor(overrides),
    ...overrides,
  };
  world.conversations.set(id, item);
  return item;
}
```

**NOTE:** the signature is `(world, id, overrides)` - **THREE positional args,
the id SECOND**. The plan's Task 5 Step 10 snippet writes
`seedConversation(world, 'conv-unk-contact', {...})` - CORRECT.

**`seedContact` - lines 55-58:**

```ts
function seedContact(world: World, contact: ContactItem): ContactItem {
  world.contacts.push(contact);
  return contact;
}
```

Takes a FULL `ContactItem`, so the plan's
`seedContact(world, { contactId: 'c-unk', type: 'unknown', status: 'needs_review', phone: '+14045550777' })`
type-checks. CONFIRMED.

**`makeWebhookHarness` usage:** imported at line 15 from
`./helpers/twilioWebhookHarness.js`. Two call forms are in use:
`makeWebhookHarness()` (destructuring `{ app }` or `{ app, world }`) and
`makeWebhookHarness({ world })` / `makeWebhookHarness({ world, unreadWalkLimit: 2 })`.
The plan's new 400 test uses `const { app } = makeWebhookHarness();` - matches
the style at 237, 245, 251.

### C.3 Where the 400 tests live - lines 236-254 (plan says "~250"). EXACT.

Three adjacent 400 tests. The nearest one to the plan's cited line 250, to
match style:

```ts
  it('400 on a malformed cursor (NOT 500)', async () => {          // 250
    const { app } = makeWebhookHarness();                          // 251
    const res = await auth(request(app).get('/api/inbox?cursor=not-base64-json!!!'));  // 252
    expect(res.status).toBe(400);                                  // 253
  });                                                              // 254
```

Siblings at 236-240 (`400 on an invalid filter value (NOT 500)`) and 244-248
(`400 on filter=mine now that conversation assignment is removed`). The plan's
new test slots in after 254. Note there is a `// --- S4: ...` section marker at
line 256, so insert between 254 and 255/256.

---

## D. `app/test/helpers/twilioWebhookHarness.ts` (4232 lines) - MUST NOT BE MODIFIED

### D.1 The `listByType` fake - CURRENT lines 1684-1712. Plan cites "line 1684". EXACT.

```ts
    async listByType(type, opts = {}) {                                        // 1684
      const partition = contacts                                               // 1685
        // BE1/A1: pointer items carry no real type/status -> invisible to this GSI.
        .filter((c) => c.phone_ref !== true && c.email_ref !== true)            // 1687
        .filter((c) => c.type === type)                                        // 1688
        .filter((c) => (opts.status === undefined ? true : c.status === opts.status))  // 1689
        // Soft-delete: default excludes deleted; deleted:true shows ONLY deleted.
        .filter((c) => (opts.deleted === true ? isDeleted(c) : !isDeleted(c))); // 1691
      // MODELS `Limit` AS DYNAMODB APPLIES IT (fix wave 2, adversarial 6): the
      // page is drawn FIRST and any FilterExpression is applied to what came
      // back, so a filtered-out row still spends a page slot. A fake that
      // filtered before slicing could never see the defect the Today fill loop
      // exists to close.
      const start = typeof opts.exclusiveStartKey?.['contactId'] === 'string'   // 1697
        ? partition.findIndex((c) => c.contactId === opts.exclusiveStartKey?.['contactId']) + 1
        : 0;
      const limit = opts.limit ?? 50;                                          // 1700
      const page = partition.slice(start, start + limit);                      // 1701
      const filtered =                                                          // 1702
        opts.excludeOrigin === undefined
          ? page
          : page.filter((c) => c.origin !== opts.excludeOrigin);               // 1705
      const last = page[page.length - 1];                                      // 1706
      const more = start + page.length < partition.length;                     // 1707
      return {                                                                  // 1708
        items: filtered,                                                        // 1709
        ...(more && last !== undefined && { lastEvaluatedKey: { contactId: last.contactId } }),
      };                                                                        // 1711
    },                                                                          // 1712
```

### D.2 The plan's two fidelity claims - BOTH CONFIRMED

1. **"applies the soft-delete filter BEFORE `Limit`" - CONFIRMED.** The
   `deleted` filter is line 1691, inside the `partition` chain; the `Limit`
   slice is line 1701. So soft-deleted rows never spend a page slot here.
2. **"returns `lastEvaluatedKey` on 'rows remain' rather than 'Limit reached'"
   - CONFIRMED at line 1707** (`more = start + page.length < partition.length`).
   The plan's separate citation of `twilioWebhookHarness.ts:1707` for "the
   items-remaining defect" is byte-exact on the right line.

### D.3 Does it honour `status` and `excludeOrigin`? BOTH YES.

- **`status`: YES**, line 1689 - and as a PARTITION-level narrow, which is the
  CORRECT modelling (it is a key condition on the real GSI). No infidelity here.
- **`excludeOrigin`: YES**, lines 1702-1705 - and applied to the PAGE, AFTER
  the slice, which is the FAITHFUL modelling of a FilterExpression. No
  infidelity here either.

So the mutation probes in Task 4 would NOT be vacuous against this fake for
those two options - but Task 4 uses the Task 1 helper anyway.

### D.4 THIRD infidelity, which the plan names in prose: no GSI sparseness

There is **no** `.filter((c) => c.status !== undefined)`. A `type='unknown'`
contact with NO `status` is VISIBLE through this fake and INVISIBLE through the
Task 1 helper. The plan states this. CONFIRMED.

### D.5 What the route suite (`inboxApi.test.ts`) will therefore see

Given the harness is frozen, the new unknown branch exercised through
`inboxApi.test.ts` will observe:

1. **No short-page-with-LEK from soft-delete residue is producible.** The fill
   loop's raison d'etre is unreachable through this suite. Route-level tests
   can pin rows and status codes, never fill-loop page counts.
2. **One FEWER Query than production on an exact page multiple.** A partition of
   exactly `pageSize` rows returns `more === false` here (no LEK), so the
   collector stops at 1 page; real DynamoDB hands back a LEK and costs a second
   Query. Any `pagesWalked` assertion written against this suite would be one
   round trip short. Do not pin page counts here - Task 4 (faithful helper) and
   Task 6 (real index) own that.
3. **A status-less `type='unknown'` seed WOULD return a row here** and would
   NOT in production. The plan's Task 5 Step 10 seed carries
   `status: 'needs_review'`, so the two suites agree on that fixture. Keep it
   that way; a future route test that omits `status` will pass here and fail on
   the real index.
4. `excludeOrigin` and `status` narrowing, if ever re-added to the collector,
   WOULD change results here too (both are honoured) - so the route suite is
   not blind to those regressions, merely redundant with Task 4.

---

## E. `app/test/helpers/unreadIndexFake.ts` (188 lines)

### E.1 Exact signatures

```ts
export function unreadFlagFor(source: {                       // 59
  unread_count?: unknown;                                     // 60
}): { unread_flag?: typeof UNREAD_FLAG_VALUE } {              // 61
```

```ts
export function queryUnreadPageFromItems(                     // 118
  items: Iterable<ConversationItem>,                          // 119
  opts: {                                                     // 120
    limit: number;                                            // 121
    exclusiveStartKey?: Record<string, unknown>;              // 122
    allowTieResume?: boolean;                                 // 140
  },                                                          // 141
): { items: ConversationItem[]; lastEvaluatedKey?: Record<string, unknown> } {  // 142
```

Note `items` is `Iterable<ConversationItem>`, so `world.conversations` (an
array) works, as does a `Map.values()`. The Task 3 parity snippet's
`queryUnreadPageFromItems(world.conversations, opts)` type-checks.

Also exported: `interface UnreadIndexKey extends Record<string, unknown>` at
lines 67-71. Module-internal (not exported): `compareUnreadDesc` (83-94),
`keyOf` (96-102).

### E.2 The LEK-rule doc comment - CURRENT lines 104-117 (plan cites ":104-116")

```
/**                                                                        104
 * One page of the byUnread index over an in-memory item collection.       105
 *                                                                         106
 * `limit` is honored exactly (the real Query's Limit), and `lastEvaluatedKey`  107
 * is returned whenever the page REACHED that limit - not merely when more rows 108
 * are known to remain. That is the service's rule, and the difference is   109
 * observable (adversarial A7): a walk over exactly n * limit rows costs one 110
 * MORE round trip than "items remaining" modelling suggests, and the       111
 * interleaving the route's cursor block is written for - a non-empty page  112
 * carrying a key, followed by an empty page with none - cannot occur at all 113
 * under the weaker model. Since the unit tests here assert on the NUMBER of 114
 * queryUnreadPage calls, an under-counting fake would calibrate every one of 115
 * those assertions one round trip short of production.                    116
 */                                                                        117
```

### E.3 The in-body rule - CURRENT lines 178-188 (plan cites ":180-187")

```ts
  const page = remaining.slice(0, opts.limit);                    // 178
  const last = page[page.length - 1];                             // 179
  // LIMIT REACHED, not "rows remain": DynamoDB stops at the Limit and hands  180
  // back the position it stopped at, so the caller has to ask again to learn 181
  // that the stream ended.                                       // 182
  const limitReached = page.length === opts.limit;                // 183
  return {                                                        // 184
    items: page,                                                  // 185
    ...(limitReached && last !== undefined && { lastEvaluatedKey: keyOf(last) }),  // 186
  };                                                              // 187
}                                                                 // 188
```

The Task 1 helper's LEK block is a direct structural copy of 178-187 with
`{ contactId: last.contactId }` in place of `keyOf(last)`. Consistent.

**Also worth knowing (the plan does not mention it):** this helper THROWS on a
resume key that lands inside a `last_activity_at` tie unless
`allowTieResume: true` (lines 153-168). Any new fixture that gives two
conversations the same `last_activity_at` AND pages the unread index will hit
a loud error, not a silent wrong answer. The Task 3 / Task 5 fixtures all use
distinct timestamps, so this is inert - keep it that way.

---

## F. `app/test/inbox.integration.test.ts` (431 lines)

### F.1 The test at plan 323-330 - CURRENT lines 323-330. EXACT.

```ts
  it('filter=unknown returns only needsTriage rows', async () => {
    const resp = await get('/api/inbox?filter=unknown');
    expect(resp.status).toBe(200);
    const { rows } = await resp.json() as { rows: Array<Record<string, unknown>> };
    expect(rows.every((r) => r['needsTriage'] === true)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['phone']).toBe(PHONE_UNK);
  });
```

### F.2 The repo consts - CURRENT lines 62-66

```ts
  const conversations = createConversationsRepo(repoDeps);   // 62
  const contacts = createContactsRepo(repoDeps);             // 63
  const audit = createAuditRepo(repoDeps);                   // 64
  const messages = createMessagesRepo(repoDeps);             // 65
  const events = createEventBus();                           // 66
```

Plan cites "lines 62-166" for the repos + `seedConv`. Accurate.

### F.3 `seedConv` helper - CURRENT lines 148-166

```ts
  /** Seed a minimal open conversation and set its last_activity_at + optional unread. */
  async function seedConv(opts: {
    phone: string;
    lastActivityAt: string;
    type?: string;
    unread?: number;
  }) {
    const conv = await conversations.createOrGetByParticipantPhone(
      opts.phone,
      (opts.type as never) ?? 'tenant_1to1',
    );
    await conversations.touchLastActivity(conv.conversationId, 'hey', opts.lastActivityAt);
    if (opts.unread && opts.unread > 0) {
      for (let i = 0; i < opts.unread; i++) {
        await conversations.incrementUnread(conv.conversationId);
      }
    }
    return (await conversations.getById(conv.conversationId))!;
  }
```

**CONFIRMED** the plan's Task 6 Step 3 call
`seedConv({ phone: PHONE_UNK2, lastActivityAt: '...', type: 'unknown_1to1', unread: 1 })`
matches this signature exactly (single options object, `type` is `string`).

### F.4 The `get()` helper - CURRENT lines 127-134

```ts
  /** Authed GET helper. */
  const get = (path: string) =>
    fetch(`${base}${path}`, {
      headers: {
        'x-origin-verify': ORIGIN_SECRET,
        cookie: TEST_SESSION_COOKIE,
      },
    });
```

Returns a raw `fetch` Response - the plan's `await resp.json() as {...}` and
`resp.status` are correct usage. (There is also a `post()` at 136-146.)

### F.5 `PHONE_UNK` - CURRENT line 193

```ts
  const PHONE_UNK = '+15561001005';        // 193
```

Siblings: `PHONE_A1 = '+15561001001'` (189), `PHONE_A2 = '+15561001002'` (190),
`PHONE_B = '+15561001003'` (191), `PHONE_C = '+15561001004'` (192). The plan's
new `PHONE_UNK2 = '+15561001099'` does not collide. CONFIRMED.

### F.6 The LAST `it` in the describe - CURRENT lines 427-430; describe closes at 431

```ts
  it('POST /read returns 404 when no conversation exists for the phone', async () => {   // 427
    const resp = await post('/api/inbox/read', { phone: '+15569999999' });               // 428
    expect(resp.status).toBe(404);                                                       // 429
  });                                                                                    // 430
});                                                                                      // 431
```

Insert the new test between 430 and 431.

### F.7 The split-proof paging test that pins page counts - CURRENT lines 336-373

```ts
  it('pages through the entire feed with limit=1 — each contact appears exactly once, no split, no duplicate', async () => {
    const collectedIds: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url = cursor
        ? `/api/inbox?limit=1&cursor=${encodeURIComponent(cursor)}`
        : '/api/inbox?limit=1';
      const resp = await get(url);
      expect(resp.status).toBe(200);
      const page = await resp.json() as {
        rows: Array<Record<string, unknown>>;
        nextCursor: string | null;
      };
      expect(page.rows.length).toBeLessThanOrEqual(1);

      for (const row of page.rows) {
        const id = (row['contactId'] ?? row['phone']) as string;
        collectedIds.push(id);
      }

      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20); // guard against infinite loops
    } while (cursor !== null);

    // Every contact/unknown appears exactly once — no split, no duplicate.
    const sorted = [...collectedIds].sort();
    const expectedSorted = [contactAId, contactBId, contactCId, PHONE_UNK].sort();
    expect(sorted).toEqual(expectedSorted);

    // We really paginated (at least 4 pages for 4 rows at limit=1).
    expect(pages).toBeGreaterThanOrEqual(4);

    // nextCursor is null at exhaustion.
    expect(cursor).toBeNull();
  });
```

**This is `filter=all`, so the flip does not touch it** - but it asserts an
EXACT 4-element set (line 365), so the plan's "place the new test LAST because
it mutates the shared world" is REQUIRED, not stylistic. Vitest runs `it`s in
declaration order within a file, so appending at 430/431 is sufficient.

**Also note:** the mark-read tests at 379-420 run AFTER the paging test and
zero out unread on conv-A1, conv-A2 and conv-UNK. By the time the new test at
the end runs, only conv-C still carries unread. That matters for the
resurfacing sweep's cost but not its result (conv-C's contact is a live tenant,
excluded by both the type check and the `isDeleted` check), so the new test's
`rows).toHaveLength(1)` holds.

---

## G. Perf seed - the highest-risk item. **VERDICT: PLAN CONFIRMED, the assertion SURVIVES.**

### G.1 The assertion - CURRENT line 414 (plan cites 414). EXACT.

Inside
`it('replaces lean group fixtures with exact generated native and relay workloads in its own lane', ...)`,
which starts at line **378**. Surrounding block, lines 402-416:

```ts
    const defaultInboxDeps = {                                    // 402
      conversationsRepo: readers.conversations,
      contactsRepo: readers.contacts,
      messagesRepo: readers.messages,
      placementsRepo: readers.placements,
    };                                                            // 407
    const all = await aggregateInbox({ filter: 'all', limit: 100 }, defaultInboxDeps);        // 408
    const unread = await aggregateInbox({ filter: 'unread', limit: 100 }, defaultInboxDeps);  // 409
    const unknown = await aggregateInbox({ filter: 'unknown', limit: 100 }, defaultInboxDeps);// 410
    const groups = await aggregateInbox({ filter: 'groups', limit: 100 }, defaultInboxDeps);  // 411
    expect(all.rows.length).toBeGreaterThan(0);                   // 412
    expect(unread.rows.length).toBeGreaterThan(0);                // 413
    expect(unknown.rows.length).toBeGreaterThan(0);               // 414
    expect(groups.rows).toHaveLength(defaultManifest.nativeGroups);// 415
    expect(groups.rows.every((row) => row.kind === 'group_text')).toBe(true);  // 416
```

The manifest under test is `resetPerformanceData({ config: configB, input: {}, anchor })`
(line 379) - i.e. **the DEFAULT manifest**, `input: {}`.

Note `defaultInboxDeps` passes the REAL repos, so `listByType` is the real
`contactsRepo.listByType` against real DynamoDB Local. This is a genuine
real-index proof.

### G.2 `resolvedContactTypeCounts` - `app/src/lib/seed/performance.ts:195-199`

```ts
function resolvedContactTypeCounts(contacts: number): ContactTypeCounts {
  const landlord = Math.floor((contacts * 4) / 100);
  const unknown = Math.floor(contacts / 100);
  return { tenant: contacts - landlord - unknown, landlord, unknown };
}
```

**Default `contacts` = 100** (`PERFORMANCE_SEED_BASE.contacts: 100`, line 37;
`scale` defaults to 1, line 254; `contacts = scaledOrOverride('contacts', input.contacts, PERFORMANCE_SEED_BASE.contacts, scale)`,
line 258).

So the default manifest yields:
- landlord = floor(400/100) = **4**
- unknown  = floor(100/100) = **1**
- tenant   = 100 - 4 - 1 = **95**

**EXACTLY ONE unknown contact in the default perf seed.** This is the single
most important number in this report - the assertion at line 414 rests on ONE
row, with no margin.

Type-to-index mapping, `contactTypeAndOrdinal` (lines 534-541):

```ts
  if (index < counts.tenant) return { type: 'tenant', ordinal: index };
  if (index < counts.tenant + counts.landlord) {
    return { type: 'landlord', ordinal: index - counts.tenant };
  }
  return { type: 'unknown', ordinal: index - counts.tenant - counts.landlord };
```

So the sole unknown is **index 95, ordinal 0**, contactId `perf-contact-00095`.

### G.3 `buildContact` - `performance.ts:543-578`

```ts
function buildContact(index: number, anchorMs: number, counts: ContactTypeCounts): ContactItem {
  const { type, ordinal } = contactTypeAndOrdinal(index, counts);
  const phone = contactPhone(index);
  const email = `perf-contact-${padded(index)}@example.test`;
  const status =
    type === 'tenant'
      ? TENANT_STATUSES[ordinal % TENANT_STATUSES.length]!
      : type === 'landlord'
        ? LANDLORD_STATUSES[ordinal % LANDLORD_STATUSES.length]!
        : ordinal % 2 === 0
          ? 'needs_review'
          : 'active';
  return {
    contactId: performanceId('contact', index),
    type,
    status,
    phone,
    phones: [{ phone, primary: true }],
    email,
    emails: [{ email, primary: true }],
    firstName: `Perf${padded(index)}`,
    lastName: 'Contact',
    created_at: at(anchorMs, -(index + 60) * MINUTE_MS),
    ...(type === 'tenant' && { /* housingAuthority, voucherSize, consent_* */ }),
    ...(type === 'landlord' && { /* consent_* */ }),
    ...(index % 7 === 0 && { deleted_at: at(anchorMs, -index * MINUTE_MS) }),
  } satisfies ContactItem;
}
```

Answering the four questions:

1. **Contact-backed? YES.** `perf-contact-00095` is a real `ContactItem` row.
2. **Carries a `status`? YES.** ordinal 0 -> `0 % 2 === 0` -> **`'needs_review'`**.
   So it IS indexed in the sparse `byTypeStatus` GSI. (The plan's prose "status
   alternates needs_review/active" is correct in general but with only ONE
   unknown there is no alternation - it is always `needs_review` at the default
   scale.)
3. **NOT soft-deleted? CORRECT - it is NOT deleted.** `95 % 7 = 4`, not 0.
   Corroborated independently by `resolvePerformanceSeedConfig`'s own
   arithmetic (lines 319-322):
   `deletedUnknownCount = deletedCount(95 + 4, 1) = floor(99/7) - floor(98/7) = 14 - 14 = 0`.
   **Zero deleted unknowns at the default scale.**
4. **Open non-relay 1:1 threads? YES, many.** See G.4.

### G.4 `oneToOneReference` wiring - `performance.ts:768-801`

```ts
function oneToOneType(index: number): ConversationType {                 // 768
  if (index === 1 || index === 2) return 'tenant_1to1';
  const types: readonly ConversationType[] = [
    'tenant_1to1',
    'landlord_1to1',
    'partner_1to1',
    'unknown_1to1',
  ];
  return types[index % types.length]!;
}

function oneToOneReference(                                             // 779
  index: number,
  type: ConversationType,
  tenants: readonly ContactReference[],
  landlords: readonly ContactReference[],
  unknowns: readonly ContactReference[],
): ContactReference {
  if (index === 1 && tenants[1]) return tenants[1];
  if (index === 2 && tenants[2]) return tenants[2];
  if (type === 'tenant_1to1') {
    return tenants[index % tenants.length] ?? { contactId: LEAN_TENANT_ID, phone: LEAN_TENANT_PHONE };
  }
  if (type === 'landlord_1to1') {
    return landlords[index % landlords.length] ?? {
      contactId: LEAN_LANDLORD_ID,
      phone: LEAN_LANDLORD_PHONE,
    };
  }
  return (                                                              // 797
    unknowns[index % unknowns.length] ??                                // 798
    tenants[index % tenants.length] ?? { contactId: LEAN_TENANT_ID, phone: LEAN_TENANT_PHONE }  // 799
  );                                                                    // 800
}                                                                       // 801
```

**Plan's citation `oneToOneReference:797-800` is EXACT.**

The final `return` (797-800) is the fall-through for BOTH `partner_1to1` AND
`unknown_1to1` - so both conversation types are wired to the unknowns array.
With `unknowns.length === 1`, `unknowns[index % 1]` is ALWAYS `unknowns[0]` =
`perf-contact-00095`.

Every generated conversation carries `status: 'open'` (`buildConversation`'s
`common`, line 823) and the 1:1 branch (835-844) sets
`participant_phone: participant.phone`, so `conversationsForContact` resolves
them by phone. None is `relay_group` (that is the `isRelay` branch, line 813:
`index % 5 === 0 && relayOrdinal < relayGroupCount`).

Default `conversations` = 100 (`PERFORMANCE_SEED_BASE.conversations: 100`).
Non-relay indices with `index % 4 === 3` (unknown_1to1) or `index % 4 === 2`
(partner_1to1, excluding index 2) all point at the single unknown - roughly 40
threads, ~32 of them surviving the relay carve-out. **Far more than the one
open thread the queue read needs.**

`generatedReferences` (678-685) filters ONLY on `contact.type === type` - it
does NOT exclude soft-deleted contacts, but that is moot here since the sole
unknown is not deleted.

### G.5 G VERDICT

**CONFIRM the plan.** `performanceSeed.integration.test.ts:414` is expected to
SURVIVE the flip unchanged. The default perf seed produces exactly **ONE**
unknown contact (`perf-contact-00095`), it is contact-backed, it carries
`status: 'needs_review'` (so it IS in the sparse `byTypeStatus` partition), it
is NOT soft-deleted, and it is the participant of ~32 open non-relay 1:1
threads. The contact-side read will return exactly **1** row, satisfying
`> 0`.

**Two caveats to carry into the build:**

- **The margin is ONE row.** Any change that drops the perf seed's contact
  count below 100, or that soft-deletes index 95, or that stops giving unknown
  contacts a `status`, takes this assertion straight to zero. If it goes red,
  the first thing to check is `resolvedContactTypeCounts(contacts).unknown`,
  not the branch.
- **A sibling assertion proves the formula and is UNAFFECTED:**
  `performanceSeed.integration.test.ts:282` reads
  `expect((await readers.contacts.listByType('unknown', { limit: 20 })).items).toEqual([]);`
  against the SMALL manifest (`manifest.contacts` is 22, line 267) - and
  `floor(22/100) === 0`, so zero unknowns there. That test calls the repo
  directly, never `aggregateInbox`, so the flip cannot touch it. Do not be
  alarmed by finding a `listByType('unknown') === []` assertion in this file.

---

## H. Dashboard

### H.1 `serverEndedEarlyEmpty` - `dashboard/src/routes/inbox/Inbox.tsx:36-42`

Plan cites `Inbox.tsx:42`. EXACT.

```ts
  // THE early-end condition, named once so the failure surface and the         // 36
  // empty-state below stay exact complements: the SERVER handed down no rows AND
  // said the unread feed ended early. Both halves are server statements - see  // 38
  // `InboxState.serverRowCount`. When it is false and the list is nonetheless  // 39
  // empty (every row marked read on a truncated page), "all caught up" is the  // 40
  // truth and the block below says so.                                          // 41
  const serverEndedEarlyEmpty = inbox.serverRowCount === 0 && inbox.truncated;  // 42
```

### H.2 The banner site - `Inbox.tsx:183-190`

Plan cites `:183`. EXACT.

```tsx
      {inbox.status === 'error' || (inbox.status === 'ready' && serverEndedEarlyEmpty) ? (   // 183
        <div className={styles.error} role="alert">                                          // 184
          <p>We couldn&apos;t load your inbox.</p>                                           // 185
          <button type="button" className={styles.retry} onClick={() => inbox.retry()}>      // 186
            Retry                                                                            // 187
          </button>                                                                          // 188
        </div>                                                                               // 189
      ) : null}                                                                              // 190
```

`role="alert"` is on line 184 - the anchor for both the Task 7 dashboard pin
and the Task 8 e2e `getByRole('alert')` assertions.

### H.3 The per-filter empty state render site - `Inbox.tsx:199-204`

Plan cites `:199`. EXACT.

```tsx
      {inbox.status === 'ready' && inbox.rows.length === 0 && !serverEndedEarlyEmpty ? (  // 199
        <div className={styles.empty}>                                                     // 200
          <p className={styles.emptyTitle}>{empty.title}</p>                               // 201
          <p className={styles.emptyBody}>{empty.body}</p>                                 // 202
        </div>                                                                             // 203
      ) : null}                                                                            // 204
```

`const empty = emptyCopy(filter);` is at line **29**. The `pending` state
renders its own block at 192-197 (different copy - "The inbox turns on with its
backend"), which is why Task 7's tests must set `status: 'ready'`.

The tab strip: `INBOX_FILTERS.map(...)` at line 61, with `role="tab"` at line
**65** and `aria-selected={filter === tab.filter}` at line **66**.

### H.4 `No unknown numbers` - `dashboard/src/routes/inbox/inboxFilters.ts:27`

Plan cites `inboxFilters.ts:27`. **EXACT. Do not edit this file.**

```ts
/** The honest empty-state copy per filter (spec §States & mobile). */   // 21
export function emptyCopy(filter: InboxFilter): { title: string; body: string } {  // 22
  switch (filter) {                                                       // 23
    case 'unread':                                                        // 24
      return { title: "You're all caught up", body: 'Switch to All to browse.' };  // 25
    case 'unknown':                                                       // 26
      return { title: 'No unknown numbers', body: 'Untriaged inbound numbers show up here.' };  // 27
```

The tab LABEL `'Unknown'` is at line **17**
(`{ filter: 'unknown', label: 'Unknown' },`) - the anchor for the e2e
`getByRole('tab', { name: 'Unknown' })`.

### H.5 `Inbox.test.tsx` scaffolding - CURRENT lines 7-64. Plan cites "lines 7-64". EXACT.

```tsx
let state: InboxState;                                                    // 7
let seenFilter: string | undefined;                                       // 8
const markRead = vi.fn();                                                 // 9
const markUnread = vi.fn();                                               // 10
const loadMore = vi.fn();                                                 // 11
const retry = vi.fn();                                                    // 12
                                                                          // 13
function baseState(over: Partial<InboxState> = {}): InboxState {          // 14
  return {                                                                // 15
    status: 'ready',                                                      // 16
    rows: [],                                                             // 17
    groupsTruncated: false,                                               // 18
    truncated: false,                                                     // 19
    serverRowCount: 0,                                                    // 20
    groupRowsShown: 0,                                                    // 21
    hasMore: false,                                                       // 22
    loadingMore: false,                                                   // 23
    loadMore,                                                             // 24
    retry,                                                                // 25
    markRead,                                                             // 26
    markUnread,                                                           // 27
    ...over,                                                              // 28
  };                                                                      // 29
}                                                                         // 30
                                                                          // 31
vi.mock('./useInbox.js', async () => {                                    // 32
  const actual = await vi.importActual<typeof import('./useInbox.js')>('./useInbox.js');
  return {                                                                // 34
    ...actual,                                                            // 35
    useInbox: (filter: string) => {                                       // 36
      seenFilter = filter;                                                // 37
      return state;                                                       // 38
    },                                                                    // 39
  };                                                                      // 40
});                                                                       // 41
import { Inbox } from './Inbox.js';                                       // 42
                                                                          // 43
function mkRow(over: Partial<InboxRowData> = {}): InboxRowData {          // 44
  return {                                                                // 45
    kind: 'contact',                                                      // 46
    contactId: 'c1',                                                      // 47
    name: 'Tasha Williams',                                               // 48
    unreadCount: 2,                                                       // 49
    preview: 'Hi',                                                        // 50
    channel: 'sms',                                                       // 51
    direction: 'inbound',                                                 // 52
    lastActivityAt: '2026-06-17T10:00:00.000Z',                           // 53
    needsTriage: false,                                                   // 54
    ...over,                                                              // 55
  };                                                                      // 56
}                                                                         // 57
function renderInbox(entry = '/inbox'): ReturnType<typeof render> {       // 58
  return render(                                                          // 59
    <MemoryRouter initialEntries={[entry]}>                               // 60
      <Inbox />                                                           // 61
    </MemoryRouter>,                                                      // 62
  );                                                                      // 63
}                                                                         // 64
                                                                          // 65
beforeEach(() => {                                                        // 66
  state = baseState();                                                    // 67
  seenFilter = undefined;                                                 // 68
  markRead.mockReset();                                                   // 69
  loadMore.mockReset();                                                   // 70
  retry.mockReset();                                                      // 71
});                                                                       // 72
afterEach(() => vi.restoreAllMocks());                                    // 73
```

**Does `baseState` accept an override object like `baseState({ truncated: true })`? YES.**
Line 14: `baseState(over: Partial<InboxState> = {})`, spread at line 28. The
plan's Task 7 snippet is valid verbatim. Precedent for exactly this idiom
already in the file at lines 77, 145, 313 and 328
(e.g. `state = baseState({ rows: [mkRow()], truncated: true, serverRowCount: 1, hasMore: true });`).

`renderInbox` takes a URL STRING with a default of `/inbox` - the plan's
`renderInbox('/inbox?filter=unknown')` is the existing idiom (see line 329).

Imports available at the top: `fireEvent, render, screen` from
`@testing-library/react` (line 1), `MemoryRouter` (2),
`afterEach, beforeEach, describe, expect, it, vi` from vitest (3). Task 7's
snippet uses only `describe/it/expect/screen` - all present. No new imports
needed.

### H.6 **DASHBOARD-CURSOR VERDICT: the new 400 posture is NOT a UI break. Definitive.**

The dashboard sends a cursor from exactly ONE place, and that place is
unreachable under `filter=unknown` once the branch returns `nextCursor: null`.

Evidence, `dashboard/src/routes/inbox/useInbox.ts`:

- **`:205`** - the first-page fetch:
  `const pageData = await getInbox({ filter, limit: PAGE_LIMIT }, controller.signal);`
  **NO cursor, ever.** This is the only request the Unknown tab will make.
- **`:320`** - the guard that opens `loadMore`:
  `if (cursor === null || loadingMore) return;`
- **`:340`** - the ONLY cursored call in the dashboard's inbox path:
  `getInbox({ filter, limit: PAGE_LIMIT, cursor }, controller.signal)`
  It is downstream of the `:320` guard, so it cannot fire with a null cursor.
- **`:126`** - `const [cursor, setCursor] = useState<string | null>(null);`
- **`:240` / `:344`** - the only two writers: `setCursor(pageData.nextCursor)`.
  With the branch returning `nextCursor: null`, `cursor` can only ever be
  `null` on this filter.
- **`:301`** - `setCursor(null)` on every filter change, so an All-tab cursor
  cannot survive a switch to Unknown.
- **`:546`** - `hasMore: cursor !== null`. So `hasMore` is permanently false on
  Unknown, and `Inbox.tsx` renders no "Load more" button (the button is gated on
  `hasMore`, per the existing pin at `Inbox.test.tsx:144-150`).

There is no URL-driven cursor either: `useInbox(filter)` takes only a filter,
and `Inbox.tsx:22` derives that filter from the URL via
`INBOX_FILTERS.some((t) => t.filter === raw) ? (raw as InboxFilter) : 'all'` -
no `cursor` search-param is read anywhere in `dashboard/src/routes/inbox/`.

**Conclusion:** a 400 on `filter=unknown&cursor=...` is unreachable from the
shipped dashboard. The only clients that could hit it are a hand-typed URL or a
future client change. Safe to ship. (It is still worth the route test the plan
adds - it pins the namespacing posture.)

Corroborating: `e2e/README.md:194` already records "with no cursor accepted as
profiler evidence" for the profiled Inbox surfaces.

---

## I. E2E - `e2e/tests/dashboard-next/unknown-caller-triage.spec.ts` (114 lines)

### I.1 **E2E-ASSUMPTION VERDICT: every single claimed import and helper exists EXACTLY as the plan states.**

| Plan's claim | Reality | Line |
| --- | --- | --- |
| `placeCall` from `../../fixtures/fakeVoice.js` | EXACT | 19 |
| `reseed` runs in `beforeEach` | EXACT - `test.beforeEach(async ({ request }) => { await reseed(request); });` | 20, 34-36 |
| `uniqueVoicePhone`, `NEXT` | EXACT - both from `../../fixtures/voiceSetup.js` | 21 |
| local `devLogin(page)` | EXACT - `async function devLogin(page: Page): Promise<void>` | 27-32 |
| `BUSINESS = '+15550009999'` | EXACT - `const BUSINESS = '+15550009999';` | 25 |

Also imported and available: `test, expect, type Page` from `@playwright/test`
(18) and `expectTodayReady` from `../../support/today.js` (22).

The file currently contains ONE test (38-113). The plan appends a second. The
`test.beforeEach` reseeds for both, so the new test gets a clean lean world.

Full current file (byte-exact) reproduced here for the builder's reference:

```ts
// e2e/tests/dashboard-next/unknown-caller-triage.spec.ts
//
// inbound-call-skips-contact-capture: an inbound CALL from a brand-new (unknown)
// number must leave the caller reachable everywhere an unknown TEXTER would be:
//
//   1. a needs_review stub contact exists -> Contacts > Unknown lists the caller
//   2. Today surfaces a needs_you_now "New unknown contact" row for them
//   3. the Inbox row deep-links to the CONTACT page (/contacts/:id), never the
//      phone-fallback list URL
//   4. the /contacts/unknown?phone= deep-link seeds the search box (the fallback
//      URL itself now lands somewhere useful)
//
// Driving notes: the call is placed via the fake-twilio voice control API from a
// per-run-unique phone with digit:null (the founder never accepts the whisper
// gate -> a MISSED business-line call, the exact shape of the live bug report).
// Capture happens at RING time (the /voice webhook), so assertions poll the
// contacts API for the stub before touching the UI.
import { test, expect, type Page } from '@playwright/test';
import { placeCall } from '../../fixtures/fakeVoice.js';
import { reseed } from '../../fixtures/reseed.js';
import { uniqueVoicePhone, NEXT } from '../../fixtures/voiceSetup.js';
import { expectTodayReady } from '../../support/today.js';

/** The app's business number in the e2e stack (BUSINESS_PHONE_NUMBER). */
const BUSINESS = '+15550009999';

async function devLogin(page: Page): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, { data: { email: 'va@example.com' } });
  expect(res.ok()).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);
}

test.beforeEach(async ({ request }) => {
  await reseed(request);
});

test('an inbound call from an unknown number is captured: Unknown list + Today + inbox contact deep-link', async ({
  page,
}) => {
  const api = page.request;
  await devLogin(page);

  const caller = uniqueVoicePhone();
  // digit:null = the founder never presses the whisper gate -> missed call.
  await placeCall(api, { from: caller, to: BUSINESS, scenario: { digit: null } });

  // (1) The stub contact exists: type unknown / needs_review, call-channel stamps.
  let stub: { contactId: string; phone?: string; status?: string } | undefined;
  await expect
    .poll(
      async () => {
        const res = await api.get(`${NEXT}/api/contacts?type=unknown`);
        if (!res.ok()) return false;
        const { contacts } = (await res.json()) as {
          contacts: Array<{ contactId: string; phone?: string; status?: string }>;
        };
        stub = contacts.find((c) => c.phone === caller);
        return stub !== undefined;
      },
      { timeout: 10_000 },
    )
    .toBeTruthy();
  expect(stub!.status).toBe('needs_review');

  // (2) Today: a needs_you_now row anchored to the captured CONTACT.
  const today = await api.get(`${NEXT}/api/today`);
  expect(today.status(), await today.text()).toBe(200);
  const { items } = (await today.json()) as {
    items: Array<{ group: string; refType: string; refId: string; who: string; why: string }>;
  };
  const row = items.find((i) => i.refId === stub!.contactId);
  expect(row, `no Today item for ${stub!.contactId}: ${JSON.stringify(items)}`).toBeDefined();
  expect(row!.group).toBe('needs_you_now');
  expect(row!.refType).toBe('contact');
  expect(row!.why).toBe('New unknown contact');

  // Today is a staff-facing display surface: the contact keeps E.164 storage,
  // but its phone-only identity is rendered in the existing NANP display form.
  expect(caller).toMatch(/^\+1\d{10}$/);
  const local = caller.slice(2);
  const callerDisplay = `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
  expect(row!.who).toBe(callerDisplay);

  await page.goto(`${NEXT}/`);
  const todayRow = page
    .getByRole('list', { name: 'Needs you now' })
    .getByRole('link')
    .filter({ hasText: callerDisplay })
    .filter({ hasText: 'New unknown contact' });
  await expect(todayRow).toBeVisible();
  await expect(todayRow).not.toContainText(caller);
  await expect(todayRow).toHaveAttribute('href', `/contacts/${stub!.contactId}`);

  // (3) The Inbox row for the caller links to the CONTACT page (never the
  // phone-fallback list URL) and carries the Needs-triage chip. Addressed by
  // href, NOT by preview copy: the row's preview is a race between the
  // missed-call auto-text body and the "Voicemail" stamp (call-inbox-unread),
  // and the old `hasText: 'Call'` only ever matched "...missed your call!" in
  // the auto-text - never the channel chip.
  await page.goto(`${NEXT}/inbox`);
  const inboxRow = page.locator(`a[href="/contacts/${stub!.contactId}"]`);
  await expect(inboxRow).toBeVisible();
  await expect(inboxRow).toContainText(/needs triage/i);

  // (4) The legacy ?phone= deep-link seeds the Unknown list's search box and
  // shows the captured caller's row.
  await page.goto(`${NEXT}/contacts/unknown?phone=${encodeURIComponent(caller)}`);
  await expect(page.getByRole('searchbox', { name: /search/i })).toHaveValue(caller);
  const rows = page.getByRole('list', { name: 'Unknown' }).getByRole('listitem');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByRole('link')).toHaveAttribute('href', `/contacts/${stub!.contactId}`);
});
```

### I.2 `GET /api/contacts?type=unknown` - REAL route, EXACT response shape

`app/src/routes/contacts.ts`:

- **:957** `const rawType = req.query['type'];`
- **:1003** `const page = await contacts.listByType(rawType, opts);`
- **:1005** `contacts: page.items,`

So the response is `{ contacts: [...], ... }`. **CONFIRMED** - and it is already
exercised by the shipping test at spec lines 53-57, so there is no risk here.

Note this route is itself a `listByType('unknown')` read, so the stub contact
must be INDEXED (carry a status) to appear - it does (`status: 'needs_review'`,
asserted at spec line 64), which is the same precondition the new inbox queue
read has. The existing poll is therefore a valid proxy for "the contact is in
the triage partition".

### I.3 The Unknown-tab row shape - `a[href="/contacts/<id>"]` containing /needs triage/i

**CONFIRMED, with in-file precedent.** The current spec already asserts exactly
this pair at **lines 102-104** against the ALL tab:

```ts
  const inboxRow = page.locator(`a[href="/contacts/${stub!.contactId}"]`);
  await expect(inboxRow).toBeVisible();
  await expect(inboxRow).toContainText(/needs triage/i);
```

The rendering component is `InboxRow`, mounted from
`dashboard/src/routes/inbox/Inbox.tsx:209-210` inside
`<ul className={styles.rows} aria-label="Conversations">` (line 208). Since the
post-flip Unknown row is the same `kind: 'contact'` row shape produced by the
same `buildContactRow` closure, the href and the triage chip are identical.
**The plan's Task 8 assertions are a copy of an assertion that already passes
today on a different tab - the lowest-risk part of the build.**

The tab assertion `getByRole('tab', { name: 'Unknown' })` +
`toHaveAttribute('aria-selected', 'true')` is backed by `Inbox.tsx:65-66`
(`role="tab"`, `aria-selected={filter === tab.filter}`) and the label
`'Unknown'` at `inboxFilters.ts:17`. CONFIRMED.

### I.4 `app/src/lib/seed/lean.ts` seeds ZERO unknown contacts - **CONFIRMED, emphatically**

The lean `SEED.contacts` array (lines 80-171) contains **exactly THREE** contacts:

1. `IDS.tenant` - `type: 'tenant'`, `status: 'placing'` (lines 81-127)
2. `IDS.landlord` - `type: 'landlord'`, `status: 'active'` (lines 128-150)
3. `IDS.haStaffer` (Renee Carter) - `type: 'partner'`, `status: 'active'` (lines 151-170)

`grep -n "type: 'unknown'"` over `lean.ts` returns **NOTHING**. The only two
occurrences of the string "unknown" in the file are:
- **:77** - `Record<string, Record<string, unknown>[]>` (a TypeScript type)
- **:92** - a COMMENT: "so they never pollute the triage queue
  (type='unknown', status='needs_review')"

**Bonus finding (see D-8):** `grep -n "team_member"` returns only lines 155 and
158, both inside the COMMENT explaining that Renee was RETYPED from
`team_member` to `partner` on 2026-08-24 (`type: 'partner'` at line 162). So
there is no `team_member` contact in the lean world either, and no class-(c)
row for the e2e Unknown tab to lose. **The Unknown tab is empty in the lean
world both BEFORE and AFTER the flip** - the plan's "the tab starts empty"
premise is correct, and the empty-state assertion in Task 8 step (1) is safe.

### I.5 Two small risks the plan does not name

- The plan's new test re-implements the `/api/contacts?type=unknown` poll
  inline rather than factoring it out of the existing test. Duplication, not a
  defect - but if the poll shape ever changes, two sites must move.
- The plan's step (1) asserts the empty state BEFORE placing the call, in a
  test that runs after `test.beforeEach`'s reseed. Reseeding logs the browser
  out (per AGENTS.md), and `devLogin(page)` is called first in the plan's
  snippet - correct ordering. No issue.

---

## J. `e2e/performance/routes.ts` and `routes.test.ts`

### J.1 `routes.ts:583` - the pinned Unknown route entry. Plan cites `:583`. EXACT.

```ts
  row({ surfaceId: 'inbox-unknown', label: 'Inbox: Unknown', pathTemplate: '/inbox', coldTarget: Object.freeze({ kind: 'static' as const, path: '/inbox?filter=unknown' }), behaviorFamily: 'inbox', source: INBOX_SOURCE('Unknown', inboxGets('inbox_page_unknown')), destinationSelected: inboxDestinationSelected('Unknown'), terminal: inboxTerminal('No unknown numbers'), gets: inboxGets('inbox_page_unknown'), surfaceScaleBearing: true, loadScaleBearing: true }),
```

Supporting definitions:

```ts
function inboxGets(requestClass: Extract<InboxRequestClass, `inbox_page_${string}`>): readonly EndpointContract[] {  // 291
  return Object.freeze([required('/api/inbox', ['filter', 'limit'], requestClass)]);                                 // 292
}                                                                                                                    // 293
```

```ts
function inboxTerminal(emptyTitle: string): TerminalContract {          // 399
  return terminal(                                                      // 400
    [locator('list', 'Conversations')],                                 // 401
    [locator('text', emptyTitle)],                                      // 402
    [L.alert],                                                          // 403
    [locator('tablist', 'Inbox filters')],                              // 404
  );                                                                    // 405
}                                                                       // 406
```

```ts
const INBOX_SOURCE = (label: string, gets: readonly EndpointContract[]) =>   // 564
  source('/inbox', L.inbox, tab(label), gets, INBOX_ALL_SOURCE_TERMINAL, INBOX_ALL_SOURCE_SELECTED);  // 565
```

Also relevant, `routes.ts:16`: `'inbox_page_unknown',` (the request class
member) and `:53`:
`export type InboxFilterQuery = 'unread' | 'unknown' | 'groups';`.

**The `inboxTerminal` contract is a hard constraint on requirement 5:** the
Unknown surface must end in EXACTLY ONE of `list "Conversations"`,
`text "No unknown numbers"`, or `alert`. A cleared queue that lit the failure
banner would satisfy TWO branches (alert) and change which branch fires -
breaking the perf harness, not merely the UX. This is a third, independent
enforcement of "the unknown branch must never set `truncated`".

### J.2 `routes.test.ts:327` - the mirror pin. Plan cites `:327`. EXACT.

```ts
      {                                                                                                    // 323
        surfaceId: 'inbox-unknown', pathTemplate: '/inbox', coldTarget: { kind: 'static', path: '/inbox?filter=unknown' },  // 324
        sourceTarget: { path: '/inbox', query: { kind: 'absent' } },                                        // 325
        action: { kind: 'tab', name: 'Unknown' },                                                           // 326
        terminal: ['No unknown numbers'],                                                                   // 327
      },                                                                                                    // 328
```

### J.3 The EXACT query-key tuple - `routes.test.ts:101`

```ts
  'inbox-unknown': ['/api/inbox?filter&limit#required#inbox_page_unknown'],   // 101
```

Siblings for context (99, 100, 102):

```ts
  'inbox-all': ['/api/inbox?filter&limit#required#inbox_page_all'],           // 99
  'inbox-unread': ['/api/inbox?filter&limit#required#inbox_page_unread'],     // 100
  'inbox-unknown': ['/api/inbox?filter&limit#required#inbox_page_unknown'],   // 101
  'inbox-groups': ['/api/inbox?filter&limit#required#inbox_page_groups'],     // 102
```

**The tuple is exactly `filter` + `limit`.** Adding or renaming any query param
on this endpoint breaks this pin. The plan's Global Constraint ("do not add or
rename query params") is correctly derived. Note the branch's new 400-on-cursor
posture does NOT touch this - `cursor` was never in the tuple.

`routes.test.ts:30-32` also enumerates the full surface-ID list including
`'inbox-unknown'`, and `:503` filters
`['inbox-unread', 'inbox-unknown', 'inbox-groups']`. Neither needs an edit.

### J.4 `e2e/README.md:185-201` - Task 9 Step 2's expected "NO edit" is CORRECT

The section reads (relevant lines):

```
### Inbox workload and passive measurement                                   185
                                                                             186
The profiler ranks four independent Inbox surface IDs: `inbox-all`,          187
`inbox-unread`, `inbox-unknown`, and `inbox-groups`. Their cold URLs are `/inbox`,  188
`/inbox?filter=unread`, `/inbox?filter=unknown`, and `/inbox?filter=groups`.  189
Their exact initial page requests are respectively                           190
`GET /api/inbox?filter=all&limit=30`,                                        191
`GET /api/inbox?filter=unread&limit=30`,                                     192
`GET /api/inbox?filter=unknown&limit=30`, and                                193
`GET /api/inbox?filter=groups&limit=30`, with no cursor accepted as profiler evidence.  194
```

Nothing here calls the Unknown tab a pager or claims it mints a cursor - line
194 explicitly says "with no cursor accepted as profiler evidence". Lines
198-201 describe the tab-activation warm sample and the one-terminal-branch
rule, both unchanged by the flip. **Expected outcome confirmed: NO edit
needed.** Do not stage this file.

---

## K. `docs/issues/inbox-filter-tabs-full-walk.md`

### K.1 The "UNKNOWN: STILL OPEN" line - CURRENT line 153. Plan cites 153. EXACT.

Surrounding structure, lines 144-168, so an editor can place the four additions
correctly:

```
**Update (2026-08-16) - HALF of this is fixed; the issue STAYS OPEN for the       144
other half.**                                                                    145
                                                                                 146
- **UNREAD: RESOLVED.** The inbox-unread-index feature                           147
  (`docs/superpowers/specs/2026-08-16-inbox-unread-index-design.md`, branch      148
  `feat/inbox-unread-index`) took the escalation rather than the cheap           149
  pre-filter: `filter=unread` no longer walks `byLastActivity` at all. It reads  150
  the new sparse `byUnread` GSI, so the tab hydrates only rows that are actually 151
  unread. Same read model backs the nav badge and Today's unread sections.       152
- **UNKNOWN: STILL OPEN.** `filter=unknown` still walks `byLastActivity` and     153
  still needs the contact to decide `needsTriage`, so its walk is still          154
  O(open conversations) when matches are sparse. This issue tracks the unknown   155
  tab from here on.                                                              156
  - **CORRECTED 2026-08-25.** This bullet originally read "STILL OPEN,           157
    unchanged" and repeated the "hydrates every open conversation" cost. Both    158
    were already wrong when written: `39c1aa41` had moved the role check ahead   159
    of hydration two days earlier, on 2026-08-14. The walk survives; the         160
    hydration does not. See the cost-model correction above. The bullet's        161
    closing claim - that "a triage flag or second sparse index remains the       162
    escalation" - is disproven above and must not be built.                      163
                                                                                 164
**MEASURED 2026-08-25 on both deployed environments. It is worse than filed,     165
and `medium` -> `high`.** One Unknown-tab page render, replicating the pager     166
exactly (`--audit-unknown-page` on                                               167
`app/scripts/measure-unread-contact-coverage.ts`):                               168
```

### K.2 Placement guidance for Task 9's four additions

- **Addition 1** (replace the status line) targets the top-level bullet at
  **153-156**. **Do NOT delete 157-163** - that nested `CORRECTED 2026-08-25`
  sub-bullet carries a standing "must not be built" instruction about the
  triage-flag/second-index escalation, which stays true and stays relevant.
  Either keep it nested under the new resolution bullet, or promote it. The
  plan does not say; flag it for the builder.
- **Additions 2, 3 and 4** (the class-(c) ruling, the deliberate remainder +
  sweep ceiling, and the section-5 deferral) are new prose with no existing
  anchor. The natural home is a new dated block. Note the file already
  establishes a `**MEASURED 2026-08-25 ...**` block at 165 and a
  `**RE-MEASURED 2026-08-25 ...**` block at 175, and a
  `**Drift audit, same day ...**` at 187 - so a new `**RESOLVED 2026-08-25 ...**`
  block appended after the measurement blocks matches the file's own idiom.
- ASCII-only on every added line (the file is already ASCII on these lines;
  note the `->` and `x` idioms used rather than arrows/multiplication signs).

---

## Appendix: cross-cutting notes for the builder

1. **The four `expect(calls).toEqual` literals (A.3) are the only whole-object
   pins in `inboxFeed.test.ts`.** Three are `filter: 'unread'` and need only
   the two new zero fields; one (759-765) is replaced outright.
2. **Task 2's `listByType` fake in `inboxFeed.test.ts` must go inside the
   `contactsRepo` object literal (after line 209), where `seed` and `calls` are
   both in lexical scope.** They are.
3. **Task 3's parity file defines its own `World`, `conv()` and `makeDeps()`** -
   it does NOT reuse `inboxFeed.test.ts`'s. No collision.
4. **Nothing in `dashboard/` needs a production-code change** for requirement
   5. The banner gate (`Inbox.tsx:42/183`) and the empty state
   (`Inbox.tsx:199`) already behave correctly; the server contract (never
   `truncated` on unknown) is the whole fix, and Task 7 pins the dependency.
5. **Three independent surfaces enforce "no `truncated` on unknown":** the
   dashboard banner gate (`Inbox.tsx:42`), Task 7's pin, and the perf harness's
   one-terminal-branch contract (`routes.ts:399-406` +
   `routes.test.ts:327`). Breaking it fails in three places, which is good.
6. **The perf-seed assertion (G) rests on ONE seeded contact.** It is the
   thinnest margin in the build. Diagnose from
   `resolvedContactTypeCounts(100).unknown === 1` if it goes red.
