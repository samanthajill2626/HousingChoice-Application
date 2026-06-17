# Inbox Backend (Contract C8 / "BE7") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a contact-aggregated Inbox feed to the Express backend — `GET /api/inbox` (one row per contact, filters, split-proof cursor paging), `POST /api/inbox/:contactId/read` (+ unknown-by-phone), `POST /api/inbox/:contactId/assign`, and confirm the live SSE event the frontend binds to.

**Architecture:** Reuse the existing conversation storage and SSE bus — do NOT fork them. A thin router (`app/src/routes/inbox.ts`) delegates to an injectable, unit-testable async aggregator `aggregateInbox(opts, deps)` in the same file. The aggregator scans `conversationsRepo.listByLastActivity` newest-first, resolves each conversation's number → contact (pointer-aware), groups all of a contact's conversations into one row, and pages over the raw conversation stream while emitting a contact row exactly once (at the contact's newest conversation), so a contact never splits across pages. Mutations are contact-keyed thin wrappers over the existing per-conversation `resetUnread`/`setAssignment`, fanned out across the contact's conversations; each fan-out already emits `conversation.updated`, which is the inbox-affecting SSE event the frontend reconciles against.

**Tech Stack:** TypeScript (strict), Express, DynamoDB (single-table-ish repos), Vitest + supertest, in-process `appEvents` bus + `GET /api/events` SSE. Node 24.

## Global Constraints

- **Terminology (CLAUDE.md + GLOSSARY):** one entity = `unit` in code; never "property". Human copy: "group text" **not** "relay". Code uses `unit`/`contact`/`conversation`.
- **C8 wire shapes are the contract — implement VERBATIM, do not rename/invent fields.** The frontend imports the identical shapes. (Defined in `docs/superpowers/specs/2026-06-17-inbox-design.md` §"Data — Contract C8".)
- **Auth + origin-verify on every `/api` route** — the inbox router mounts inside the existing authed `/api` chain (origin-secret → CSRF-origin → session → `requireAuth()`); no new auth surface. Requesting user id = `(req as AuthedRequest).user!.userId`.
- **DynamoDB Local / hermetic only.** Never touch real AWS. No `.env` edits (none needed). No browser stack (`e2e:session`) — verification is unit + API + DynamoDB-Local integration only.
- **TypeScript strict; match existing code style; route handlers thin; aggregation unit-testable in isolation (plain async function, no req/res).**
- **Reuse, don't duplicate:** `conversationsRepo.listByLastActivity` / `resetUnread` / `setAssignment`; `contactsRepo.findByPhone` (pointer-aware) + `contactPhones()`; `appEvents` + `conversation.updated`; the `today.ts` aggregation precedent (name cache, best-effort name hydration that degrades to id, never 500).

## C8 wire shapes (copy verbatim into `inbox.ts`)

```ts
export type InboxFilter = 'all' | 'unread' | 'unknown' | 'mine';
export type InboxChannel = 'sms' | 'mms' | 'call';

export interface InboxRow {
  kind: 'contact' | 'unknown';
  contactId?: string;          // present when kind='contact'
  phone?: string;              // E.164; the number (esp. for unknown rows)
  name: string;                // contact name, or formatted number when unknown
  role?: 'tenant' | 'landlord' | 'unknown';
  caseContext?: { caseId: string; label: string };  // e.g. "Touring" — optional
  unreadCount: number;         // aggregate across ALL of the contact's numbers
  preview: string;             // latest item's text as a preview (UI shows one line, ellipsized)
  channel: InboxChannel;       // channel of the latest item
  direction: 'inbound' | 'outbound';   // 'outbound' → render "You: …"
  lastActivityAt: string;      // ISO; sort key (newest first)
  assignment?: { userId: string; name: string };   // the Assigned chip
  needsTriage: boolean;        // true for untriaged unknowns
}

export interface InboxPage {
  rows: InboxRow[];            // newest-activity-first; ONE row per contact
  nextCursor: string | null;
}
```

## Key design decisions (baked in — the adversarial reviewer will check these)

1. **One row per contact via the "newest-conversation" rule (stateless across pages).** Scan `listByLastActivity({status:'open'})` DESC. For each conversation, resolve `participant_phone` → contact via `contactsRepo.findByPhone` (pointer-aware). Emit a `kind:'contact'` row **iff this conversation is the contact's newest** (max `last_activity_at` across all the contact's conversations). Otherwise skip (the contact is already represented by a newer conversation). Because each contact has exactly one newest conversation, it is emitted on exactly one page — **no split, no duplicate, no cross-page state needed.**
2. **Cross-number aggregation.** When emitting a contact row, gather ALL the contact's conversations (one per number) by `contactPhones(contact)` → `conversationsRepo.findByParticipantPhone(phone)` per number; `unreadCount` = sum of their `unread_count`; `lastActivityAt`/`preview`/`channel`/`direction` come from the newest of them. Cache per-contact within a request to avoid refetching when older conversations of the same contact appear later.
3. **Unknown rows.** A `participant_phone` that resolves to no contact → one `kind:'unknown'` row per number, `needsTriage:true`, `name` = formatted number, `role:'unknown'`, `contactId` omitted. No aggregation (a number is its own row).
4. **Relay groups are EXCLUDED.** `type === 'relay_group'` conversations are "group texts", not a single contact; C8 has no row `kind` for them. Skip them. **(Contract note — flag in handoff: C8 has no group-text row kind; group texts are out of the contact-aggregated inbox by construction.)**
5. **channel/direction/preview of the latest item** are NOT stored on the conversation. Derive at read time from the newest message on the representative conversation via `messagesRepo` (latest message for the conversation): `channel` = `call` if it is a call record, else `mms` if it has media, else `sms`; `direction` = the message's direction; `preview` = `conversation.last_message_preview` (already denormalized/truncated). This is one bounded lookup per **emitted** row (≤ `limit` per page), not per conversation — acceptable; document it. If no message is found, default `channel:'sms'`, `direction:'inbound'` and use the conversation preview.
6. **`role`** = map `contact.type`: `tenant`→`tenant`, `landlord`→`landlord`, everything else (`pm`/`team_member`/`unknown`/absent)→`unknown`.
7. **`name`** = best resolved contact name: prefer the contact's stored display name, else the conversation's `participant_display_name`, else the formatted phone. Reuse the same resolution `today.ts` uses (`whoOfConversation` precedent).
8. **`caseContext`** = when the representative conversation has `caseId`, fetch the case (best-effort, cached) and set `{ caseId, label }` where `label` is the case's stage rendered as a human label (reuse `today.ts`'s stage→label mapping if present; otherwise the raw stage string). Omit when no case or lookup fails.
9. **`assignment`** = when the representative conversation has `assignment` (a userId string), resolve the user's name via the users repo (best-effort, cached) → `{ userId, name }`. Omit when unassigned.
10. **Filters:** `all` = everything; `unread` = `unreadCount > 0`; `unknown` = `needsTriage === true`; `mine` = the representative conversation's `assignment === req.user.userId`. **Filters apply AFTER aggregation** (a contact's "unread/mine/assignment" is a property of the aggregated row). Page size still counts emitted+filtered rows (see cursor below).
11. **Cursor:** opaque base64url of the underlying `listByLastActivity` `LastEvaluatedKey` (the raw conversation-stream position) AFTER the last consumed conversation on the page. Consume raw conversations until `limit` rows have passed the filter (or the stream is exhausted); `nextCursor` encodes the raw LEK at that point (or `null` when exhausted). Resume decodes it into `exclusiveStartKey`. Default `limit` = 25, clamp 1..100.
12. **Mutations are contact-keyed:**
    - `POST /api/inbox/:contactId/read` → fetch the contact, fan out `resetUnread` across ALL the contact's conversations (each emits `conversation.updated`). 404 if the contact does not exist. Returns `{ ok: true }`.
    - `POST /api/inbox/read { phone }` → for an **unknown** number (no contact): `resetUnread` on that number's conversation. 404 if no conversation for the phone. Returns `{ ok: true }`. (Keying decision: contacts by `:contactId`, unknowns by `{phone}` — documented in handoff.)
    - `POST /api/inbox/:contactId/assign { userId | null }` → fan out `setAssignment(convId, userId|null)` across ALL the contact's conversations (each emits `conversation.updated` + writes the existing `assignment_changed` audit). 404 if contact missing. Returns `{ ok: true }`.
13. **SSE:** **Reuse the existing `conversation.updated` event** — it already fires on new inbound, on read (`resetUnread`), and on assignment (`setAssignment`); the contact-keyed fan-out emits one per affected conversation. **No new event.** Document for the frontend: bind the inbox to `conversation.updated` and treat it as "something changed, reconcile" (the spec's blessed policy). **Contract note (flag, do not build):** `conversation.updated` carries `conversationId`, not `contactId`; surgical patch-in-place keyed by contact would need a `contactId` on the event — a future addition, deferred (the spec explicitly allows reconcile-via-refetch).

---

## File Structure

- **Create** `app/src/routes/inbox.ts` — C8 wire types (verbatim) + `InboxRouterDeps` + exported `aggregateInbox(opts, deps)` (the unit-testable aggregator) + `createInboxRouter(deps)` (thin handlers). Mirrors `app/src/routes/today.ts` structure (exported wire types, deps interface defaulting to real repos, name/case caches, best-effort hydration).
- **Modify** the api-router mount site (where `today` mounts, in `app/src/routes/api.ts` — find `today` mount) — mount `createInboxRouter()` at `/inbox` inside the authed `/api` router.
- **Create** `app/test/inboxFeed.test.ts` — unit tests for `aggregateInbox` with injected fakes (aggregation, dedup/newest-rule, cross-number unread sum, unknown rows, relay exclusion, channel/direction derivation, filters, cursor paging/no-split).
- **Create** `app/test/inboxApi.test.ts` — supertest over `makeWebhookHarness()` fake world (auth-gated 401/403, GET shape + filters, read fan-out, assign fan-out, unknown read-by-phone, 404s, malformed cursor → 400 not 500).
- **Create** `app/test/inbox.integration.test.ts` — DynamoDB-Local integration (`describe.skipIf(!reachable)`), real repos, seed conversations/contacts, assert aggregation + mutations over real queries.

---

### Task 1: Inbox read model + `GET /api/inbox` (types, aggregator, route, filters, cursor)

**Files:**
- Create: `app/src/routes/inbox.ts`
- Modify: `app/src/routes/api.ts` (mount `/inbox` where `today` mounts)
- Test: `app/test/inboxFeed.test.ts` (unit, aggregator), `app/test/inboxApi.test.ts` (GET portion)

**Interfaces:**
- Consumes (existing — verbatim signatures from the codebase):
  - `conversationsRepo.listByLastActivity({ status, limit?, exclusiveStartKey? }): Promise<{ items: ConversationItem[]; lastEvaluatedKey?: Record<string, unknown> }>`
  - `conversationsRepo.findByParticipantPhone(phone: string): Promise<ConversationItem[]>`
  - `contactsRepo.findByPhone(phone: string): Promise<ContactItem | undefined>`
  - `contactsRepo.getById(contactId: string): Promise<ContactItem | undefined>`
  - `contactPhones(contact): ContactPhone[]` (from `contactsRepo.ts`)
  - `messagesRepo` — find the "latest message for a conversation" query (inspect `app/src/repos/messagesRepo.ts`; reuse whatever the BE2 timeline used). `MessageItem` carries `direction` and a media/channel signal and a call marker.
  - `casesRepo.getById(caseId)` and the `today.ts` stage→label mapping (reuse).
  - the users repo `getById(userId)` (find it — `sessionMiddleware` reads a users table; the harness exposes `fakeUsers`).
  - `ConversationItem`, `ContactItem`, `ContactPhone`, `AuthedRequest`, `appEvents` — import from their modules.
- Produces (later tasks + frontend rely on these exact names/types):
  - `export type InboxFilter`, `InboxChannel`; `export interface InboxRow`, `InboxPage` (verbatim above).
  - `export interface InboxRouterDeps { logger?; conversationsRepo?; contactsRepo?; messagesRepo?; casesRepo?; usersRepo?; }` (all optional, default to real repos).
  - `export async function aggregateInbox(opts: { filter: InboxFilter; limit: number; cursor?: string; userId: string }, deps: InboxRouterDeps): Promise<InboxPage>`
  - `export function createInboxRouter(deps?: InboxRouterDeps): Router`

- [ ] **Step 1 — Read the precedents first.** Read `app/src/routes/today.ts` in full (deps pattern, name cache, `whoOfConversation`, stage→label, mount), `app/src/repos/conversationsRepo.ts` (`listByLastActivity`, `findByParticipantPhone`, `ConversationItem`), `app/src/repos/contactsRepo.ts` (`findByPhone`, `contactPhones`, `ContactItem`, `ContactPhone`), `app/src/repos/messagesRepo.ts` (latest-message-for-conversation query; `MessageItem` direction/media/call fields), and `app/test/conversationHubApi.test.ts` + `app/test/helpers/twilioWebhookHarness.ts` (how the fake world seeds conversations/messages/contacts and exposes repos). Note exact signatures.

- [ ] **Step 2 — Write the failing unit test** `app/test/inboxFeed.test.ts`. Drive the aggregator directly with hand-built fakes (no Express). Cover, each as its own `it`:

```ts
import { describe, expect, it } from 'vitest';
import { aggregateInbox, type InboxRouterDeps } from '../src/routes/inbox.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';

// Build a minimal deps object backed by in-memory arrays/maps. Helper:
function makeDeps(seed: {
  conversations: ConversationItem[];
  contacts: ContactItem[];
  // optional: latest message per conversationId for channel/direction
  latestMessage?: Record<string, { direction: 'inbound' | 'outbound'; channel: 'sms' | 'mms' | 'call' }>;
  users?: Record<string, { name: string }>;
  cases?: Record<string, { stage: string }>;
}): InboxRouterDeps {
  // conversationsRepo.listByLastActivity → conversations sorted DESC by last_activity_at,
  //   honoring limit + exclusiveStartKey (encode position by index for the fake).
  // conversationsRepo.findByParticipantPhone(phone) → conversations with that participant_phone.
  // contactsRepo.findByPhone(phone) → contact whose phones include phone (pointer-aware emulation:
  //   match against each contact's phones[] / scalar phone), else undefined.
  // contactsRepo.getById, messagesRepo latest, casesRepo.getById, usersRepo.getById accordingly.
  // ...return the deps object.
}

describe('aggregateInbox — one row per contact (C8)', () => {
  it('one contact with two numbers → ONE row; unreadCount sums across numbers; newest activity wins', async () => {
    // contact c-1 with +1...01 (unread 2, older) and +1...02 (unread 3, newer)
    const page = await aggregateInbox({ filter: 'all', limit: 25, userId: 'u-1' }, deps);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ kind: 'contact', contactId: 'c-1', unreadCount: 5 });
    expect(page.rows[0].lastActivityAt).toBe(/* the +1...02 timestamp */);
  });

  it('unknown number (no contact) → kind:"unknown", needsTriage:true, name=formatted number, role:"unknown"', async () => { /* ... */ });

  it('relay_group conversations are excluded from the feed', async () => { /* ... */ });

  it('rows are newest-activity-first', async () => { /* ... */ });

  it('derives channel/direction from the latest message (mms when media; call when call record; else sms)', async () => { /* ... */ });

  it('filter "unread" keeps only unreadCount>0; "unknown" keeps only needsTriage; "mine" keeps only rows assigned to userId', async () => { /* ... */ });

  it('caseContext present {caseId,label} when the representative conversation has a caseId', async () => { /* ... */ });

  it('assignment resolves {userId,name} from the users repo when assigned; omitted when unassigned', async () => { /* ... */ });
});

describe('aggregateInbox — cursor paging (split-proof)', () => {
  it('a contact emitted on page 1 (its newest conv) does NOT reappear on page 2 even though it has an older conv in the page-2 window', async () => {
    // Seed: contact c-1 newest conv at T10; an OLDER c-1 conv at T3.
    //  several other contacts' convs at T9..T4 so the page boundary falls between them.
    const p1 = await aggregateInbox({ filter: 'all', limit: 3, userId: 'u-1' }, deps);
    const p2 = await aggregateInbox({ filter: 'all', limit: 3, cursor: p1.nextCursor!, userId: 'u-1' }, deps);
    const ids = [...p1.rows, ...p2.rows].map(r => r.contactId);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate contact across pages
  });

  it('nextCursor is null when the conversation stream is exhausted', async () => { /* ... */ });

  it('paging yields every contact exactly once across all pages', async () => { /* ... */ });
});
```

- [ ] **Step 3 — Run the unit test, verify it fails.** `npm test -w @housingchoice/app -- inboxFeed` → FAIL (`aggregateInbox` not exported).

- [ ] **Step 4 — Implement `app/src/routes/inbox.ts`.** Put the C8 wire types verbatim at the top. Then `InboxRouterDeps` (defaulting to the real repos, like `TodayRouterDeps`). Then `aggregateInbox`:
  - Decode `cursor` (base64url JSON) → `exclusiveStartKey` (catch malformed → throw a 400-mapped error; reuse the project's bad-request error so the handler returns 400 not 500).
  - Loop: pull batches via `listByLastActivity({ status:'open', limit: FETCH_BATCH, exclusiveStartKey })`. For each conversation in order:
    - `relay_group` → skip.
    - Resolve contact via `findByPhone(participant_phone)`.
      - **No contact** → emit an `unknown` row (apply filter; if it passes, push). Mark this raw conversation as the consume-boundary.
      - **Contact** → if already emitted this contact in THIS page (per-request `Set`), skip. Else gather the contact's conversations (cache by contactId): `contactPhones(contact)` → `findByParticipantPhone` per number; compute `maxConv` (newest `last_activity_at`) and `unreadSum`. If the current conversation is NOT `maxConv` → skip (represented by a newer conv on an earlier/this page). If it IS `maxConv` → build the row (resolve name/role/caseContext/assignment, derive channel/direction from the latest message on `maxConv`), apply filter; if it passes, push and add to the emitted set.
    - Track the raw `lastEvaluatedKey` as the consume-boundary after each consumed conversation.
    - Stop when `rows.length === limit` (set `nextCursor` from the current consume-boundary LEK) or the stream is exhausted (`nextCursor = null`).
  - Best-effort hydration (name/case/user) wrapped in try/catch → degrade to id / omit, never throw (mirror `today.ts`).
  - Return `{ rows, nextCursor }`.

  Then `createInboxRouter(deps)` — `GET /` handler: parse `filter` (default `all`, validate against the 4 values → else 400), `limit` (default 25, clamp 1..100), `cursor`; read `userId` from `(req as AuthedRequest).user!.userId`; call `aggregateInbox`; `res.json(page)`. Map the malformed-cursor / bad-filter errors to 400.

- [ ] **Step 5 — Mount the router.** In `app/src/routes/api.ts`, where the `today` router is mounted inside the authed `/api` router, add `apiRouter.use('/inbox', createInboxRouter(deps))` following the exact same pattern/deps-injection the `today` mount uses.

- [ ] **Step 6 — Run the unit test, verify it passes.** `npm test -w @housingchoice/app -- inboxFeed` → PASS.

- [ ] **Step 7 — Write the failing API test** `app/test/inboxApi.test.ts` (supertest + `makeWebhookHarness()`), GET portion. Seed the fake world's `conversations`/`contacts`/`messages` directly (mirror `conversationHubApi.test.ts`). Auth helper: `.set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE)`.

```ts
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

const auth = (req: request.Test) =>
  req.set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

describe('GET /api/inbox (C8)', () => {
  it('401 without a session cookie', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app).get('/api/inbox').set('x-origin-verify', ORIGIN_SECRET);
    expect(res.status).toBe(401);
  });
  it('403 without the origin-verify header', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app).get('/api/inbox').set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(403);
  });
  it('returns InboxPage with one row per contact, newest-first', async () => { /* seed; assert shape matches C8 keys exactly */ });
  it('filter=unread returns only unread rows; filter=unknown only needsTriage; filter=mine only rows assigned to the session user', async () => { /* ... */ });
  it('400 on an invalid filter value and on a malformed cursor (NOT 500)', async () => { /* ... */ });
});
```

- [ ] **Step 8 — Run it, fix until green.** `npm test -w @housingchoice/app -- inboxApi` → PASS.

- [ ] **Step 9 — Typecheck.** `npm run typecheck -w @housingchoice/app` → clean.

- [ ] **Step 10 — Commit.**

```bash
git add app/src/routes/inbox.ts app/src/routes/api.ts app/test/inboxFeed.test.ts app/test/inboxApi.test.ts
git commit -m "feat(api): GET /api/inbox contact-aggregated feed (C8) with filters + split-proof cursor"
```

---

### Task 2: Mutations (`read`, `assign`) + SSE confirmation + integration tests

**Files:**
- Modify: `app/src/routes/inbox.ts` (add the three mutation handlers to `createInboxRouter`)
- Test: `app/test/inboxApi.test.ts` (extend), `app/test/inbox.integration.test.ts` (create)

**Interfaces:**
- Consumes (existing — verbatim):
  - `conversationsRepo.resetUnread(conversationId): Promise<ConversationItem>` (throws `ConditionalCheckFailedException` for unknown id)
  - `conversationsRepo.setAssignment(conversationId, userId | null): Promise<{ conversation; previousAssigneeUserId }>`
  - `conversationsRepo.findByParticipantPhone(phone): Promise<ConversationItem[]>`
  - `contactsRepo.getById(contactId)`, `contactPhones(contact)`
  - `appEvents.emit('conversation.updated', toConversationUpdatedEvent(item))` — the canonical emit (confirm `resetUnread`/`setAssignment` already emit at their existing endpoints; the inbox fan-out emits per affected conversation the same way).
- Produces: `POST /:contactId/read`, `POST /read` (body `{phone}`), `POST /:contactId/assign` (body `{userId: string|null}`) on the inbox router; each returns `{ ok: true }`.

- [ ] **Step 1 — Write failing API tests** (extend `app/test/inboxApi.test.ts`):

```ts
describe('POST /api/inbox/:contactId/read (C8)', () => {
  it('resets unread across ALL the contact\'s conversations and emits conversation.updated per conversation', async () => {
    const { app, world } = makeWebhookHarness();
    // seed contact c-1 with two numbers, two conversations each with unread>0
    const res = await auth(request(app).post('/api/inbox/c-1/read'));
    expect(res.status).toBe(200);
    // assert both conversations now unread_count 0, and world.emitted has conversation.updated for both
  });
  it('404 when the contact does not exist', async () => { /* ... */ });
});

describe('POST /api/inbox/read { phone } — unknown number', () => {
  it('resets unread on the unknown number\'s conversation (200)', async () => { /* ... */ });
  it('404 when no conversation exists for the phone', async () => { /* ... */ });
});

describe('POST /api/inbox/:contactId/assign (C8)', () => {
  it('sets assignment across all the contact\'s conversations; null clears it; emits conversation.updated', async () => { /* ... */ });
  it('404 when the contact does not exist; 400 on a malformed body', async () => { /* ... */ });
});
```

- [ ] **Step 2 — Run, verify fail.** `npm test -w @housingchoice/app -- inboxApi` → FAIL (routes 404).

- [ ] **Step 3 — Implement the three handlers** in `createInboxRouter`:
  - `POST /:contactId/read`: `getById(contactId)` → 404 if absent; gather conversations across `contactPhones`→`findByParticipantPhone`; `await Promise.all` `resetUnread` for each that has `unread_count > 0` (skip already-zero to avoid redundant writes/events); `res.json({ ok: true })`.
  - `POST /read` (no `:contactId`): validate `{phone}` (E.164-ish; else 400); `findByParticipantPhone(phone)` → 404 if none; `resetUnread` each; `{ ok: true }`. **Mount this BEFORE `/:contactId/read`** is not required (different path depth: `/read` vs `/:contactId/read`), but ensure `/read` is its own route, not captured by `/:contactId`.
  - `POST /:contactId/assign`: validate body `{userId: string | null}` (missing key → 400); `getById` → 404; gather conversations; `setAssignment(convId, userId)` for each; `{ ok: true }`. (Each `setAssignment` site that the existing PATCH uses also writes the `assignment_changed` audit + emits `conversation.updated`; replicate that emit/audit per conversation here, reusing the existing helper if the existing endpoint factored one out — otherwise emit `conversation.updated` per conversation as the existing PATCH does.)
  - Confirm whether `resetUnread`/`setAssignment` themselves emit, or whether the existing endpoints emit after calling them. **Match the existing endpoints' emit/audit behavior exactly** so the inbox fan-out produces identical events.

- [ ] **Step 4 — Run API tests, fix until green.** `npm test -w @housingchoice/app -- inboxApi` → PASS.

- [ ] **Step 5 — Create the DynamoDB-Local integration test** `app/test/inbox.integration.test.ts`, gated like `app/test/conversationHub.integration.test.ts`:

```ts
// header mirrors conversationHub.integration.test.ts: endpointReachable() + describe.skipIf(!reachable)
```
  Seed (real repos): a contact with two numbers + two conversations (unread on both), an unknown number conversation, optionally a relay_group; then over real HTTP/Dynamo assert: GET aggregates to one contact row with summed unread + an unknown row + relay excluded; `filter` variants; `read` zeroes unread on both of the contact's conversations; `assign`/unassign sets/clears; cursor paging across a seeded set yields each contact once.

- [ ] **Step 6 — Run the integration test against DynamoDB Local.** Ensure Dynamo is up: `npm run db:start && npm run db:create` (from repo root; do NOT seed-collide with another worktree — if port 8000 busy, another run is active, coordinate/skip). Then `npm test -w @housingchoice/app -- inbox.integration` → PASS (or self-skips if Dynamo absent — but for this slice, RUN it green).

- [ ] **Step 7 — Full suite + typecheck.** `npm test -w @housingchoice/app` (entire app suite green) and `npm run typecheck -w @housingchoice/app` clean.

- [ ] **Step 8 — Commit.**

```bash
git add app/src/routes/inbox.ts app/test/inboxApi.test.ts app/test/inbox.integration.test.ts
git commit -m "feat(api): inbox mark-read + assign (contact-keyed fan-out) over conversation.updated SSE (C8)"
```

---

## Self-Review (run before declaring done)

- **Spec coverage:** every C8 endpoint + every `InboxRow`/`InboxPage` field has a task and a test. Filters (all/unread/unknown/mine), cursor (split-proof), read (contact + unknown-by-phone), assign (set + clear), SSE (`conversation.updated` confirmed) — all covered.
- **Contract conformance sweep:** diff the emitted JSON keys against the C8 types — exact names, no extras, no renames. `kind`, `contactId?`, `phone?`, `name`, `role?`, `caseContext?{caseId,label}`, `unreadCount`, `preview`, `channel`, `direction`, `lastActivityAt`, `assignment?{userId,name}`, `needsTriage`; page `{rows, nextCursor}`.
- **Adversarial focus (the final whole-branch review will hunt these):** authz (no cross-workspace read/mutate — the feed is workspace-global like the existing conversation list; `mine` uses the session user; confirm no user-supplied id can widen scope), aggregation correctness (multi-number contact, unknown rows, empty inbox, unread math), pagination (no split contact, stable/opaque cursor, exhaustion → null), SSE (event fires on every relevant change; no stale/dupe), N+1/perf (per-emitted-row message/case/user lookups are bounded to page size and cached per request), terminology (no "property"/"relay" in code or copy).
- **Contract notes to surface in the handoff (do NOT silently diverge):** (a) relay_group/group-texts are excluded (C8 has no group row kind); (b) `conversation.updated` reused as the inbox SSE event — carries `conversationId` not `contactId`, so the frontend reconciles via refetch (surgical per-contact patch would need a future `contactId` on the event).
