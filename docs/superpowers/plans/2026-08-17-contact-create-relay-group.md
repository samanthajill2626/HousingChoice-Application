# Create a Relay Group from the Contact File - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `+ Create group` action to the "Relay groups" card on the tenant
and landlord contact files, which picks members, previews the exact intro that
will be sent, and creates a standalone relay group.

**Architecture:** One shared preview core in `rosterEdits.ts` serves the tour,
placement, and new standalone preview routes so they cannot drift. A new
`POST /api/relay-groups/preview` builds a `RosterPreview` from a client-supplied
member list (a standalone group has no stored roster before it exists). The
dashboard reuses the existing `RosterConfirmDialog` verbatim, gated by a new
optional `allowDefer` prop.

**Tech Stack:** TypeScript, Express, DynamoDB, React + React Router, Vitest,
Playwright.

**Spec:** `docs/superpowers/specs/2026-08-17-contact-create-relay-group-design.md`
READ IT FIRST AND KEEP IT OPEN. Its section 2 lists twelve verified facts about
current behavior that you must NOT re-derive, and several tasks below depend on
them.

## Global Constraints

- ASCII ONLY in every new or touched line of specs, plans, comments, test names,
  and seed strings. Verify: `tr -d '\11\12\15\40-\176' < FILE | wc -c` prints 0.
- Gates run BARE, never piped: `npm run typecheck`, `npm test`, `npm run e2e`.
  A pipe returns the tail command's exit code and hides a real failure.
- Playwright ONLY via `npm run e2e` from the e2e workspace. A stray root
  invocation targets the human's LIVE stack on :5174/:8080.
- Read a bare `git status` as a SEPARATE command before EVERY commit. Stage
  EXPLICIT paths only; never `git add -A`. Check `.git/MERGE_HEAD`.
- Every commit gets a `Co-Authored-By` trailer naming the authoring model.
- Never use PowerShell `Get-Content | -replace | Set-Content` on source files -
  it mojibakes BOM-less UTF-8. Use the Edit tool.
- NO new dependencies, NO schema/GSI changes, NO infra, NO deploys.
- Existing tour and placement preview tests MUST pass UNMODIFIED. They are the
  proof the owner path did not change. If one goes red, you broke the refactor -
  do not edit the test.
- OUT OF SCOPE, do not touch: `provisionForGroup` / `poolNumbers.ts` (another
  agent owns same-pair number reuse), any duplicate-open-group check, and the
  lean seed's Renee Carter contact type.
- Human-facing nouns: a unit is a "property" to staff and landlords, a "home" to
  tenants; `unit` in code. Never invent a new noun.

---

### Task 1: Extract the shared preview core

**Files:**
- Modify: `app/src/services/rosterEdits.ts` (`buildOpenPreview`, lines ~371-403)
- Test: `app/test/rosterEdits.test.ts` (CREATE - no such file exists today)

**Interfaces:**
- Produces: `buildOpenPreviewFromParts(parts: OpenPreviewParts, quiet: QuietHoursState): RosterPreview`
  and `export interface OpenPreviewParts { bodyMembers: PreviewBodyMember[]; recipients: PreviewRecipientRow[] }`
  where `PreviewBodyMember = { name?: string; memberKey: string }` and
  `PreviewRecipientRow = { name?: string; memberKey: string; reachability: RosterReachability }`.
- Consumes: existing private helpers `withQuietHours`, `toRecipient`,
  `composeIntroBody`, and the private `resolvedMemberKey` (rosterEdits.ts:155,
  returns `contactId ?? \`phone:${phone ?? ''}\``).

Read spec section 6.1. The two lists exist because the owner path genuinely has
two name sources (spec 2.5): the intro body composes from `resolveRoster`'s
members (stored names) while `recipients` comes from `describeRoster`'s view
(names backfilled from the contact). One flat list cannot carry both.

- [ ] **Step 1: Write the failing test**

Create `app/test/rosterEdits.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildOpenPreviewFromParts,
  type OpenPreviewParts,
} from '../src/services/rosterEdits.js';

const QUIET_OFF = {
  nowIso: '2026-08-17T18:00:00.000Z',
  window: { startHour: 21, endHour: 8, timezone: 'America/New_York' },
};

describe('buildOpenPreviewFromParts', () => {
  it('counts a de-duplicated phone ONCE and by the FIRST member on it', () => {
    // Ada and Bo share a number; Ada is first and opted out. The phone is NOT
    // reachable just because Bo (later, same number) is - the de-dupe happens
    // BEFORE the reachable filter (spec 2.6). Guarding a silent behavior change
    // to the tour and placement previews.
    const parts: OpenPreviewParts = {
      bodyMembers: [{ name: 'Ada', memberKey: 'c-ada' }],
      recipients: [
        { name: 'Ada', memberKey: 'c-ada', reachability: 'opted_out' },
        { name: 'Bo', memberKey: 'c-bo', reachability: 'reachable' },
      ],
    };
    const preview = buildOpenPreviewFromParts(parts, QUIET_OFF);
    expect(preview.recipientCount).toBe(0);
    expect(preview.recipients).toHaveLength(2);
    expect(preview.deferred).toBe(false);
  });

  it('names only the body members in the intro, and lists every recipient', () => {
    const parts: OpenPreviewParts = {
      bodyMembers: [
        { name: 'Ada', memberKey: 'c-ada' },
        { name: 'Cy', memberKey: 'c-cy' },
      ],
      recipients: [
        { name: 'Ada Backfilled', memberKey: 'c-ada', reachability: 'reachable' },
        { name: 'Cy Backfilled', memberKey: 'c-cy', reachability: 'reachable' },
        { memberKey: 'phone:+15550100009', reachability: 'no_phone' },
      ],
    };
    const preview = buildOpenPreviewFromParts(parts, QUIET_OFF);
    expect(preview.body).toContain('Ada');
    expect(preview.body).toContain('Cy');
    expect(preview.body).not.toContain('Backfilled');
    expect(preview.recipients).toHaveLength(3);
    expect(preview.recipientCount).toBe(2);
  });

  it('reports quiet hours with the clamped end instant', () => {
    const preview = buildOpenPreviewFromParts(
      {
        bodyMembers: [{ name: 'Ada', memberKey: 'c-ada' }],
        recipients: [{ name: 'Ada', memberKey: 'c-ada', reachability: 'reachable' }],
      },
      { nowIso: '2026-08-17T03:00:00.000Z', window: QUIET_OFF.window },
    );
    expect(preview.deferred).toBe(true);
    expect(preview.quietEndsAt).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it and verify it FAILS**

Run: `cd W:/tmp/contact-create-relay-group && npx vitest run app/test/rosterEdits.test.ts`
Expected: FAIL - `buildOpenPreviewFromParts` is not exported.

- [ ] **Step 3: Add the core and re-point `buildOpenPreview` at it**

In `app/src/services/rosterEdits.ts`, ABOVE `buildOpenPreview`, add:

```ts
/** One member as the INTRO BODY composer sees them: phone-bearing and
 *  phone-de-duplicated, carrying the name the send path will actually use. */
export interface PreviewBodyMember {
  name?: string;
  memberKey: string;
}

/** One row the confirm dialog lists, with the DISPLAY name (which may be
 *  backfilled from the contact and so differ from the body name). */
export interface PreviewRecipientRow {
  name?: string;
  memberKey: string;
  reachability: RosterReachability;
}

/**
 * The two lists a caller resolves; see spec 6.1. They are separate because the
 * owner path composes the body from `resolveRoster` (stored names) and the
 * recipient list from `describeRoster` (backfilled names) - one field cannot
 * carry both.
 */
export interface OpenPreviewParts {
  bodyMembers: PreviewBodyMember[];
  recipients: PreviewRecipientRow[];
}

/**
 * THE ONE implementation of "what an open sends". The tour, placement, and
 * standalone preview routes all funnel through here so the body composition,
 * the recipient shape, the count rule, and the quiet-hours math cannot drift.
 *
 * COUNT RULE, preserved verbatim from the pre-refactor code: de-dupe by phone
 * FIRST (the caller does that when building `bodyMembers`), THEN keep the ones
 * whose key is reachable. A phone does not become reachable because a LATER
 * member on the same number is.
 */
export function buildOpenPreviewFromParts(
  parts: OpenPreviewParts,
  quiet: QuietHoursState,
): RosterPreview {
  const reachableKeys = new Set(
    parts.recipients.filter((r) => r.reachability === 'reachable').map((r) => r.memberKey),
  );
  const recipientCount = parts.bodyMembers.filter((m) => reachableKeys.has(m.memberKey)).length;
  return withQuietHours(
    composeIntroBody(parts.bodyMembers.map((m) => m.name)),
    parts.recipients.map(toRecipient),
    recipientCount,
    quiet,
  );
}
```

Then replace the tail of `buildOpenPreview` (everything from `const reachableKeys`
through the closing `};`) with:

```ts
  return {
    ok: true,
    preview: buildOpenPreviewFromParts(
      {
        bodyMembers: provisioned.map((m) => ({
          ...(m.name !== undefined && { name: m.name }),
          memberKey: resolvedMemberKey(m),
        })),
        recipients: view.members.map((m) => ({
          ...(m.name !== undefined && { name: m.name }),
          memberKey: m.memberKey,
          reachability: m.reachability,
        })),
      },
      quiet,
    ),
  };
```

Leave the `provisioned` / `seenPhones` loop above it EXACTLY as it is.

- [ ] **Step 4: Run the new test AND the existing preview tests**

Run: `cd W:/tmp/contact-create-relay-group && npx vitest run app/test/rosterEdits.test.ts app/test/relayApi.test.ts app/test/toursApi.test.ts`
Expected: ALL PASS. If a tour/placement preview test fails, the refactor is
wrong - fix the refactor, never the test.

- [ ] **Step 5: Commit**

```bash
git -C W:/tmp/contact-create-relay-group status
git -C W:/tmp/contact-create-relay-group add app/src/services/rosterEdits.ts app/test/rosterEdits.test.ts
git -C W:/tmp/contact-create-relay-group commit -m "refactor(relay): one shared preview core for all three open previews"
```

---

### Task 2: The standalone preview route

**Files:**
- Modify: `app/src/services/rosterEdits.ts` (add the standalone builder)
- Modify: `app/src/routes/relayGroups.ts` (new route + injectable clock)
- Test: `app/test/relayGroupPreview.test.ts` (CREATE)

**Interfaces:**
- Consumes: Task 1's `buildOpenPreviewFromParts` / `OpenPreviewParts`.
- Produces: `POST /api/relay-groups/preview` returning a `RosterPreview` AS THE
  BODY (not wrapped), matching the two owner-scoped preview routes.

Read spec 6.2 in full before writing code. Four things there are load-bearing
and easy to get wrong: names resolve via `resolveMemberName` (the SAME resolver
create uses, short-circuit included - a different resolver makes the dialog
disagree with the intro); suppression uses `isMemberSuppressed`, the real send
gate; `isMemberSuppressed` MUST NOT be wrapped in try/catch; and there is no
`no_phone` case because `parseRelayMember` guarantees a phone.

- [ ] **Step 1: Write the failing test**

Create `app/test/relayGroupPreview.test.ts` covering, at minimum:
- `POST /api/relay-groups/preview` with `{}` -> 400 `members (non-empty array) is required`
- with `{ members: [{ name: 'x' }] }` -> 400 naming `member.phone is required`
- two members, one with `sms_opt_out: true` -> that member IS listed in
  `recipients` with `reachability: 'opted_out'`, and `recipientCount` is 1
- two members SHARING a phone -> `recipients` has ONE row (create collapses
  them, so the dialog must not name someone who will never be a participant)
- a fixed clock inside quiet hours -> `deferred: true` with `quietEndsAt`
- a `contacts.getById` that rejects -> the request 5xxs and NO preview body is
  returned (fail closed; spec 6.2)
- the route provisions nothing: assert the pool-numbers fake was never called

Follow the existing harness style in `app/test/relayApi.test.ts` for building
the router with fakes.

- [ ] **Step 2: Run it and verify it FAILS**

Run: `cd W:/tmp/contact-create-relay-group && npx vitest run app/test/relayGroupPreview.test.ts`
Expected: FAIL - 404, the route does not exist.

- [ ] **Step 3: Add the standalone builder**

In `app/src/services/rosterEdits.ts`:

```ts
/**
 * Preview a STANDALONE relay-group open from an explicit member list.
 *
 * INPUT IS THE CLIENT'S LIST, deliberately - and this does NOT break the
 * "input is the owner only" rule the owner-scoped previews follow. That rule
 * exists so a client list can never disagree with a SERVER-RESOLVED roster;
 * a standalone group has no stored roster before it exists, so there is nothing
 * to disagree with. The caller MUST post the identical array to this preview
 * and to POST /api/relay-groups.
 *
 * REACHABILITY ASYMMETRY, intentional: this uses `isMemberSuppressed`, the real
 * send-time gate (contact flag + per-phone STOP record), while the owner path
 * keeps `describeRoster`'s narrower rule. The owner path is not changed here,
 * and that divergence is already filed
 * (docs/issues/relay-member-suppression-diverges-from-number-seam.md). Matching
 * the SEND is the entire point of a preview.
 */
export async function buildStandaloneOpenPreview(
  deps: {
    contacts: ContactsRepo;
    conversations: ConversationsRepo;
  },
  members: ConversationParticipant[],
  quiet: QuietHoursState,
): Promise<RosterPreview> {
  // De-dupe by phone, FIRST WINS - exactly what POST /api/relay-groups does, so
  // the dialog lists only people who will really be on the thread.
  const deduped: ConversationParticipant[] = [];
  const seenPhones = new Set<string>();
  for (const m of members) {
    if (seenPhones.has(m.phone)) continue;
    seenPhones.add(m.phone);
    deduped.push(m);
  }

  const rows: PreviewRecipientRow[] = [];
  const bodyMembers: PreviewBodyMember[] = [];
  for (const member of deduped) {
    const named = await resolveMemberName(deps.contacts, member);
    const suppressed = await isMemberSuppressed(deps.contacts, deps.conversations, member);
    const memberKey =
      member.contactId && member.contactId.length > 0
        ? member.contactId
        : `phone:${member.phone}`;
    rows.push({
      ...(named.name !== undefined && { name: named.name }),
      memberKey,
      reachability: suppressed ? 'opted_out' : 'reachable',
    });
    bodyMembers.push({
      ...(named.name !== undefined && { name: named.name }),
      memberKey,
    });
  }

  return buildOpenPreviewFromParts({ bodyMembers, recipients: rows }, quiet);
}
```

Add the imports it needs: `resolveMemberName` from `./relayMembers.js`,
`isMemberSuppressed` from `./relayAnnouncements.js`, and the
`ConversationParticipant` / `ConversationsRepo` types from
`../repos/conversationsRepo.js`. If importing `relayAnnouncements` into
`rosterEdits` creates a cycle, put `buildStandaloneOpenPreview` in a new
`app/src/services/relayGroupPreview.ts` instead and import the core from
`rosterEdits.js` - the core staying single is what matters, not the file.

- [ ] **Step 4: Add the route and the clock**

In `app/src/routes/relayGroups.ts`, add `getNow?: () => string` to
`RelayGroupsRouterDeps` (the router has NO clock today - spec 2.10), defaulting
to `() => new Date().toISOString()`, then add a `quietHoursState()` helper
mirroring the one in `routes/placements.ts:997-1002`:

```ts
  async function quietHoursState(): Promise<QuietHoursState> {
    return { nowIso: getNow(), window: await readQuietHoursWindow(settingsRepo, log) };
  }
```

Register the route IMMEDIATELY BEFORE the existing `POST /relay-groups` handler:

```ts
  // POST /api/relay-groups/preview - what creating this group WOULD send: the
  // server-composed relay.intro body, per-member deliverability, the distinct
  // reachable count, and the quiet state. Pure read: it provisions nothing,
  // touches no pool number, and never checks the provisioning kill-switch - a
  // preview must not be what discovers provisioning is disabled.
  router.post('/relay-groups/preview', async (req, res) => {
    const body = (req.body ?? {}) as { members?: unknown };
    if (!Array.isArray(body.members) || body.members.length === 0) {
      res.status(400).json({ error: 'members (non-empty array) is required' });
      return;
    }
    const members: ConversationParticipant[] = [];
    for (const raw of body.members) {
      const parsed = parseRelayMember(raw);
      if ('error' in parsed) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      members.push(parsed);
    }
    res.json(
      await buildStandaloneOpenPreview(
        { contacts, conversations },
        members,
        await quietHoursState(),
      ),
    );
  });
```

Do NOT catch errors from `buildStandaloneOpenPreview`. `isMemberSuppressed`
throws on a repo failure by design so callers fail CLOSED; letting it propagate
to the error middleware is the correct behavior (spec 6.2).

- [ ] **Step 5: Run the tests**

Run: `cd W:/tmp/contact-create-relay-group && npx vitest run app/test/relayGroupPreview.test.ts app/test/relayApi.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C W:/tmp/contact-create-relay-group status
git -C W:/tmp/contact-create-relay-group add app/src/services/rosterEdits.ts app/src/routes/relayGroups.ts app/test/relayGroupPreview.test.ts
git -C W:/tmp/contact-create-relay-group commit -m "feat(relay): POST /api/relay-groups/preview for a standalone open"
```

---

### Task 3: Cross-path parity tests

**Files:**
- Modify: `app/test/rosterEdits.test.ts`

Read spec section 7. Both fixture constraints are load-bearing FOR DIFFERENT
REASONS and neither may be dropped: no suppressed members (the two paths use
different reachability rules by design, and the count is DERIVED from
reachability), and no shared phones (only the standalone side de-duplicates).

- [ ] **Step 1: Write the parity test**

Add a `describe('owner vs standalone parity')` block that runs the SAME member
set through `buildOpenPreview` (with a fake owner roster) and
`buildStandaloneOpenPreview`, using a fixture with NO suppressed members and NO
shared phones, and asserts `body`, `recipients`, `recipientCount`, `deferred`
and `quietEndsAt` are all equal.

Add TWO separate tests for the excluded cases, each asserting the difference is
the INTENDED one:
- a member suppressed only by a per-phone STOP record: standalone reports
  `opted_out`, the owner path reports `reachable`
- a shared-phone roster: the owner path lists BOTH members in `recipients`, the
  standalone path lists ONE

- [ ] **Step 2: Run and verify**

Run: `cd W:/tmp/contact-create-relay-group && npx vitest run app/test/rosterEdits.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git -C W:/tmp/contact-create-relay-group status
git -C W:/tmp/contact-create-relay-group add app/test/rosterEdits.test.ts
git -C W:/tmp/contact-create-relay-group commit -m "test(relay): pin owner/standalone preview parity and its two intended divergences"
```

---

### Task 4: Make partner contacts visible

**Files:**
- Modify: `dashboard/src/routes/contacts/useContacts.ts:55-66`
- Modify: `dashboard/src/routes/contacts/useContacts.test.tsx:56-82`

Read spec 6.5's "INCLUDED FIX". `partner` (a caseworker or agency contact)
became a first-class `ContactType` on 2026-07-21 and was never added to the
fan-out, whose own comment claims it covers every audience type.

- [ ] **Step 1: Update the two pinned assertions FIRST**

In `useContacts.test.tsx`, the `all` case (~line 56) and the `deleted` case
(~line 70) each assert `toHaveBeenCalledTimes(3)` and
`toEqual(['landlord', 'tenant', 'unknown'])`. Change both to `4` and
`['landlord', 'partner', 'tenant', 'unknown']` (the array is `.sort()`ed, so
`partner` lands second). Update the `count` assertion in the `all` case from
`'3'` to `'4'`.

These are DELIBERATE updates to pinned assertions, not test loosening. Do not
weaken them to `expect.arrayContaining` or similar.

- [ ] **Step 2: Run and verify they FAIL**

Run: `cd W:/tmp/contact-create-relay-group && npx vitest run dashboard/src/routes/contacts/useContacts.test.tsx`
Expected: FAIL - still 3 calls.

- [ ] **Step 3: Widen both filters**

In `useContacts.ts`, change `TYPES_FOR.all` and `TYPES_FOR.deleted` to
`['tenant', 'landlord', 'partner', 'unknown']`, and correct the comment so it
names `partner` explicitly. `deleted` widens too: a soft-deleted partner the
Deleted view cannot list is unrestorable, because `restoreContact` is only
reachable from the contact page and that page only from this list.

- [ ] **Step 4: Run the whole dashboard suite**

Run: `cd W:/tmp/contact-create-relay-group && npx vitest run dashboard/src`
Expected: PASS. Eight surfaces consume this hook; if another test asserts the
narrower set, update it deliberately and note it in the commit body.

- [ ] **Step 5: Commit**

```bash
git -C W:/tmp/contact-create-relay-group status
git -C W:/tmp/contact-create-relay-group add dashboard/src/routes/contacts/useContacts.ts dashboard/src/routes/contacts/useContacts.test.tsx
git -C W:/tmp/contact-create-relay-group commit -m "fix(contacts): include partner in the all and deleted fan-outs"
```

---

### Task 5: `allowDefer` on the shared confirm dialog

**Files:**
- Modify: `dashboard/src/routes/shared/RosterConfirmDialog.tsx`
- Modify: `dashboard/src/routes/shared/RosterConfirmDialog.test.tsx`

Read spec 6.7. The prop MUST default to `true`; TourDetail, PlacementDetail and
PeopleCard all render this dialog and none of them may change behavior.

- [ ] **Step 1: Write the failing tests**

Add: with `allowDefer={false}` and a `deferred: true` preview, the footer has
exactly `Cancel` and the `confirmLabel` button (NO "Send now anyway", NO
"... at 8:00 AM"), the quiet-hours warning line STILL renders, and confirming
calls `onConfirm` with `false`. Add a second test that the DEFAULT (prop unset)
still renders the three-button quiet layout.

- [ ] **Step 2: Run and verify FAIL**

Run: `cd W:/tmp/contact-create-relay-group && npx vitest run dashboard/src/routes/shared/RosterConfirmDialog.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `RosterConfirmDialogProps`:

```ts
  /** False when the confirming endpoint CANNOT defer (a standalone relay create
   *  has no owner row to hold a pending action). The quiet-hours warning still
   *  renders; the deferral button does not, because no backend row can keep
   *  that promise. Defaults to true - tour and placement are unaffected.
   *  TODO(standalone-relay-group-quiet-hours-deferral): */
  allowDefer?: boolean;
```

Destructure with `allowDefer = true`. Introduce
`const canDefer = preview.deferred && allowDefer;` and use `canDefer` for BOTH
the "Send now anyway" button and the `defaultLabel` choice. Keep the quiet-hours
warning gated on `preview.deferred` alone so it still renders. Author NO new
button copy.

- [ ] **Step 4: Run and verify PASS**

Run: `cd W:/tmp/contact-create-relay-group && npx vitest run dashboard/src/routes/shared/RosterConfirmDialog.test.tsx dashboard/src/routes/tours dashboard/src/routes/placements`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C W:/tmp/contact-create-relay-group status
git -C W:/tmp/contact-create-relay-group add dashboard/src/routes/shared/RosterConfirmDialog.tsx dashboard/src/routes/shared/RosterConfirmDialog.test.tsx
git -C W:/tmp/contact-create-relay-group commit -m "feat(relay): allowDefer on RosterConfirmDialog for endpoints that cannot defer"
```

---

### Task 6: API client functions

**Files:**
- Modify: `dashboard/src/api/endpoints.ts`
- Test: `dashboard/src/api/endpoints.test.ts`

**Interfaces:**
- Produces: `previewRelayGroup(members: RelayGroupMemberInput[], signal?: AbortSignal): Promise<RosterPreview>`
  and `createRelayGroup(members: RelayGroupMemberInput[], tag?: string): Promise<{ conversation: ConversationHeader }>`,
  with `export interface RelayGroupMemberInput { phone: string; contactId?: string; name?: string }`.
- Consumes: `request<T>(path, options)` from `../api/client.js` (options take
  `method`, `body`, `query`, `signal`).

Note the dashboard type is `ConversationHeader`; there is no `ConversationItem`
in the dashboard. Check that its `status` union admits `'connecting'` - the
server sends it and Task 8 branches on it. If only the DOCBLOCK omits it, widen
the docblock, not the behavior; if the union itself omits it, add it.

- [ ] **Step 1: Write the failing tests**

Assert `previewRelayGroup` POSTs to `/api/relay-groups/preview` with
`{ members }` and no `tag`, and that `createRelayGroup` POSTs to
`/api/relay-groups` with `{ members, tag }`, omitting `tag` when undefined.
Follow the existing `createTourRelay` tests in the same file.

- [ ] **Step 2: Run, verify FAIL, implement, verify PASS**

Run: `cd W:/tmp/contact-create-relay-group && npx vitest run dashboard/src/api/endpoints.test.ts`

```ts
/** A relay-group member as POST /api/relay-groups and its preview accept it. */
export interface RelayGroupMemberInput {
  phone: string;
  contactId?: string;
  name?: string;
}

/** POST /api/relay-groups/preview - what creating this group WOULD send.
 *  Returns the RosterPreview as the body, like the owner-scoped previews. */
export async function previewRelayGroup(
  members: RelayGroupMemberInput[],
  signal?: AbortSignal,
): Promise<RosterPreview> {
  return request<RosterPreview>('/api/relay-groups/preview', {
    method: 'POST',
    body: { members },
    ...(signal !== undefined && { signal }),
  });
}

/** POST /api/relay-groups - create the group. Pass the IDENTICAL `members`
 *  array that was previewed (spec 6.2). */
export async function createRelayGroup(
  members: RelayGroupMemberInput[],
  tag?: string,
): Promise<{ conversation: ConversationHeader }> {
  return request<{ conversation: ConversationHeader }>('/api/relay-groups', {
    method: 'POST',
    body: { members, ...(tag !== undefined && tag.length > 0 && { tag }) },
  });
}
```

Export both from `dashboard/src/api/index.ts` if that barrel exists.

- [ ] **Step 3: Commit**

```bash
git -C W:/tmp/contact-create-relay-group status
git -C W:/tmp/contact-create-relay-group add dashboard/src/api/endpoints.ts dashboard/src/api/endpoints.test.ts
git -C W:/tmp/contact-create-relay-group commit -m "feat(relay): dashboard client for the relay-group preview and create"
```

---

### Task 7: The card action

**Files:**
- Modify: `dashboard/src/routes/contact/GroupTextsCard.tsx`
- Modify: `dashboard/src/routes/contact/GroupTextsCard.test.tsx`

- [ ] **Step 1: Write the failing tests**

Assert the card renders a button named `+ Create group` when `onCreate` is
provided and fires it on click, and renders NO such button when `onCreate` is
absent.

- [ ] **Step 2: Run FAIL, implement, run PASS**

Add the optional prop and pass it as the `Card`'s `aside`:

```tsx
  /** When set, the card heading offers "+ Create group". */
  onCreate?: () => void;
```

```tsx
    <Card
      title="Relay groups"
      {...(onCreate !== undefined && {
        aside: (
          <CardAction onClick={onCreate} label="Create a relay group">
            + Create group
          </CardAction>
        ),
      })}
    >
```

Import `CardAction` from `./Card.js`. Do NOT modify `CardAction` itself - it has
no `disabled` or `title` prop and is used across many surfaces.

Run: `cd W:/tmp/contact-create-relay-group && npx vitest run dashboard/src/routes/contact/GroupTextsCard.test.tsx`

- [ ] **Step 3: Commit**

```bash
git -C W:/tmp/contact-create-relay-group status
git -C W:/tmp/contact-create-relay-group add dashboard/src/routes/contact/GroupTextsCard.tsx dashboard/src/routes/contact/GroupTextsCard.test.tsx
git -C W:/tmp/contact-create-relay-group commit -m "feat(relay): + Create group action on the Relay groups card"
```

---

### Task 8: The create-relay-group modal

**Files:**
- Create: `dashboard/src/routes/contact/CreateRelayGroupModal.tsx`
- Create: `dashboard/src/routes/contact/CreateRelayGroupModal.module.css`
- Test: `dashboard/src/routes/contact/CreateRelayGroupModal.test.tsx`

**Interfaces:**
- Consumes: Task 6's `previewRelayGroup` / `createRelayGroup` /
  `RelayGroupMemberInput`, Task 5's `allowDefer`, the existing `Modal`,
  `ContactSearchField`, and `RosterConfirmDialog`.
- Produces: `CreateRelayGroupModal({ contact, candidates, onClose })`.

READ SPEC 6.5 AND 6.6 IN FULL BEFORE WRITING THIS FILE. It is the task with the
most rules and every one of them came from a review finding. The critical ones:

1. THREE-STATE MACHINE, exactly one modal mounted: `picking` / `confirming` /
   `connecting`. Two stacked `Modal`s both register a document Escape handler,
   so one keypress would close both and silently discard the member list.
2. Member state lives in THIS component, so `confirming` -> `picking` (Cancel)
   restores the selection intact.
3. The seeded contact is LOCKED and cannot be removed. Its phone is
   `contact.phones?.find((p) => p.primary)?.phone ?? contact.phone` - `phones`
   is OPTIONAL, the optional chain is required to typecheck.
4. NEVER forward `ContactSearchField`'s `value.name` as a member name. That
   value IS `contactDisplayName`'s output, which falls back to a FORMATTED PHONE
   NUMBER - it would print a phone in the preview and embed one in the outbound
   intro. Build the name from the resolved `Contact`'s `firstName`/`lastName`
   only, send it only when non-empty, and render `Unnamed number` (the dialog's
   exact string) when there is none.
5. Only a COMMITTED pick (`contactId` set) may be added; free text never is.
6. Filter candidates that are already added, have no resolvable phone, or SHARE
   a phone with an added member.
7. `Create group` disabled below 2 rows.
8. Post the IDENTICAL members array to preview and to create.
9. A failed PREVIEW shows its error in the picker and never opens the confirm
   dialog.
10. On `status === 'connecting'`: do NOT navigate; go to the `connecting` state
    showing a notice that names the UNSENT INTRO plus one `Go to the group`
    button. On any other status: navigate to `/conversations/:conversationId`.

- [ ] **Step 1: Write the failing tests**

Cover each numbered rule above. At minimum: seeds the contact and cannot remove
it; blocks Create at one row; refuses uncommitted free text; filters
already-added, phone-less, and same-phone candidates; sends no `name` for a
nameless contact and renders `Unnamed number`; previews before confirming;
posts identical arrays to both calls; Cancel from confirm restores the picker
with the selection; a connecting create shows the unsent-intro notice and does
NOT navigate; an open create navigates; a failed preview keeps the picker open.

- [ ] **Step 2: Run FAIL, implement, run PASS**

Run: `cd W:/tmp/contact-create-relay-group && npx vitest run dashboard/src/routes/contact/CreateRelayGroupModal.test.tsx`

Match the styling conventions of `PhoneManager.module.css` / `ContactEditForm.module.css`.

- [ ] **Step 3: Commit**

```bash
git -C W:/tmp/contact-create-relay-group status
git -C W:/tmp/contact-create-relay-group add dashboard/src/routes/contact/CreateRelayGroupModal.tsx dashboard/src/routes/contact/CreateRelayGroupModal.module.css dashboard/src/routes/contact/CreateRelayGroupModal.test.tsx
git -C W:/tmp/contact-create-relay-group commit -m "feat(relay): create-relay-group modal with preview, confirm, and connecting states"
```

---

### Task 9: Wire it into the contact files

**Files:**
- Modify: `dashboard/src/routes/contact/TenantFile.tsx`
- Modify: `dashboard/src/routes/contact/LandlordFile.tsx`
- Modify: `dashboard/src/routes/contact/ContactDetail.tsx`
- Test: `dashboard/src/routes/contact/files.test.tsx`

`ContactDetail` already holds `editCandidates` (`useContacts('all')` minus the
current contact, line ~327) and `navigate`. It owns the modal state and passes
`onCreateRelayGroup` down. `PartnerFile` and `UnknownFile` do not render
`GroupTextsCard` and are NOT touched.

- [ ] **Step 1: Write the failing test**

In `files.test.tsx`, assert TenantFile and LandlordFile render the
`+ Create group` action when `onCreateRelayGroup` is passed and fire it.

- [ ] **Step 2: Run FAIL, implement, run PASS**

Add `onCreateRelayGroup?: () => void` to both files' props, forward it to
`GroupTextsCard` as `onCreate`, then in `ContactDetail` add
`const [creatingRelayGroup, setCreatingRelayGroup] = useState(false);`, pass
`onCreateRelayGroup={() => setCreatingRelayGroup(true)}` to both, and render
`<CreateRelayGroupModal contact={contact} candidates={editCandidates} onClose={() => setCreatingRelayGroup(false)} />`
alongside the existing `editing` / `managingPhones` modals.

Run: `cd W:/tmp/contact-create-relay-group && npx vitest run dashboard/src/routes/contact`

- [ ] **Step 3: Commit**

```bash
git -C W:/tmp/contact-create-relay-group status
git -C W:/tmp/contact-create-relay-group add dashboard/src/routes/contact/TenantFile.tsx dashboard/src/routes/contact/LandlordFile.tsx dashboard/src/routes/contact/ContactDetail.tsx dashboard/src/routes/contact/files.test.tsx
git -C W:/tmp/contact-create-relay-group commit -m "feat(relay): wire the create-group action into the tenant and landlord files"
```

---

### Task 10: E2E

**Files:**
- Create: `e2e/tests/dashboard-next/contact-create-relay-group.spec.ts`

Read spec section 7's E2E paragraph. THE TRAP: in the hermetic lane every fresh
pair lands CONNECTING (`e2e/fixtures/relayConnect.ts:9-26`), and connecting does
NOT navigate. Asserting a conversation page right after confirm WILL fail.

- [ ] **Step 1: Write the spec**

Dev-login, open the seeded tenant's contact page, click `+ Create group`, add
the seeded landlord, confirm, then assert the MODAL's unsent-intro notice. Then
import `driveConnectingGroupToOpen` from `../../fixtures/relayConnect.js`, drive
the group open, follow `Go to the group`, and assert the conversation renders.
Use `getByRole` / `getByLabel` selectors per `e2e/support/selectors.md`.

- [ ] **Step 2: Run it**

Run: `cd W:/tmp/contact-create-relay-group && npm run e2e`
Expected: PASS. Re-run once before blaming this change for a failure in
`tour-reminders-panel` or `conversationdetail-members-mock-suite`; both are
known flakes and both runs must be reported.

- [ ] **Step 3: Commit**

```bash
git -C W:/tmp/contact-create-relay-group status
git -C W:/tmp/contact-create-relay-group add e2e/tests/dashboard-next/contact-create-relay-group.spec.ts
git -C W:/tmp/contact-create-relay-group commit -m "test(e2e): create a relay group from the contact file"
```

---

### Task 11: File the follow-up issues

**Files:**
- Create six files under `docs/issues/`, each from `docs/issues/_TEMPLATE.md`

Spec section 9 has the full text for each. Slugs:
`standalone-relay-group-quiet-hours-deferral`,
`relay-confirm-dialog-overstates-tier3-send`,
`relay-intro-editable-but-never-overridden`,
`relay-provisioning-stale-comments`,
`relay-preview-lists-members-provisioning-drops`,
`lean-seed-ha-staffer-should-be-partner`.

Items 2-6 are PRE-EXISTING defects this review surfaced, not regressions from
this change. Say so in each.

- [ ] **Step 1: Write them, regenerate the index, commit**

```bash
cd W:/tmp/contact-create-relay-group && npm run issues
```

`docs/issues/INDEX.md` is gitignored - never hand-maintain it.

```bash
git -C W:/tmp/contact-create-relay-group status
git -C W:/tmp/contact-create-relay-group add docs/issues/standalone-relay-group-quiet-hours-deferral.md docs/issues/relay-confirm-dialog-overstates-tier3-send.md docs/issues/relay-intro-editable-but-never-overridden.md docs/issues/relay-provisioning-stale-comments.md docs/issues/relay-preview-lists-members-provisioning-drops.md docs/issues/lean-seed-ha-staffer-should-be-partner.md
git -C W:/tmp/contact-create-relay-group commit -m "docs(issues): file the six follow-ups from the create-relay-group review"
```

---

### Task 12: Final gates

- [ ] **Step 1: Sync main ONCE**

```bash
git -C W:/tmp/contact-create-relay-group merge main
```

Preserve both sides' intent. If it conflicts with active work, STOP and ask.
Report later drift rather than re-merging repeatedly.

- [ ] **Step 2: Run all three gates BARE and record the real exit codes**

```bash
cd W:/tmp/contact-create-relay-group && npm run typecheck
cd W:/tmp/contact-create-relay-group && npm test
cd W:/tmp/contact-create-relay-group && npm run e2e
```

Never pipe them. Quote the actual exit codes in the handback.

- [ ] **Step 3: ASCII check every file you touched**

```bash
cd W:/tmp/contact-create-relay-group && git diff main...HEAD --name-only
```

Then for each, `tr -d '\11\12\15\40-\176' < FILE | wc -c` must print 0.

- [ ] **Step 4: Hand back. Do NOT merge.** The human merges.
