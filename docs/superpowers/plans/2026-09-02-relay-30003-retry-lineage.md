# Relay 30003 Retry Lineage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A relay fan-out leg that a carrier rejects with error 30003 is retried
up to three times to that member alone, with durable per-attempt lineage, and the
dashboard tells the truth about it at every position that renders delivery.

**Architecture:** A retry is a NEW source message row addressed to just the failed
member, not a promotion of the failed leg. Its own recipient slot runs
`queued -> sent -> delivered`, which the forward-only status machine already
permits, so no exception to `ALLOWED_PRIOR` is created. The row's `sid#` pointer
create IS the atomic claim; a job-execution marker defeats duplicate queue
deliveries. The dashboard derives a per-member `retryState` at thread level by
joining forward to those rows.

**Tech Stack:** TypeScript, Node 24, DynamoDB (single-table), Express, SQS-backed
job queue, React + Vite dashboard, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-02-relay-30003-retry-lineage-design.md`
(revision 6, approved 2026-09-02 after four adversarial review rounds). **Read it
first.** This plan argues from it and does not restate its reasoning; where a step
says "per D<n>", that decision carries the reasoning and the counter-arguments
already rejected.

Revision 4, after plan review rounds 1 (two reviewers, 42 findings), 2 (12
findings) and 3 (7 findings, one changing a decision). Adjudications:
`docs/superpowers/reviews/2026-09-02-relay-30003-retry-lineage/plan-r1-adjudications.md`.

## Global Constraints

- **Gates, run bare from the worktree** (`W:\tmp\relay-30003-retry-lineage`):
  `npm run typecheck`, `npm test`, `npm run smoke`, `npm run e2e`, then
  `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx')`.
  Never pipe a gate command.
- **ASCII only** on every new or touched line.
- **Commit explicit paths only.** Never `git add -A`. Read bare `git status`
  before every commit. Add
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **`npm test` needs DynamoDB Local** (`npm run db:start`).
- **Vendor SDK imports belong in `app/src/adapters`.**
- **All job traffic goes through `jobs.enqueue()` / `defineJobHandler()`.**
- **PII: phones are DATA, never log lines.** Use `logSafeMemberKey`
  (`app/src/services/relayAnnouncements.ts:152-161`). No phone number may enter a
  sort key.
- **Retry ladder:** 3 attempts, 60s / 120s / 240s, matching
  `app/src/jobs/retrySend.ts:37,39-42`.
- **The trigger code is 30003 and only 30003.**
- **Hard fences - do not edit:** `app/src/services/relayAnnouncements.ts`
  behavior, `app/src/jobs/tourReminders.ts`, native group-text receipt behavior,
  the existing 1:1 retry/collapse path, `stalenessClockMs`, `ALLOWED_PRIOR`, and
  the rollup chip's `outbound` gate.

## Execution order and why it is this order

**The display filter lands BEFORE the first retry row can exist.** Plan review
round 1 found that the reverse order violates a stated guarantee for the whole gap
between them: the moment the server starts appending retry rows, every relay
thread renders them as ordinary bubbles - up to three duplicates per failed leg -
and an inbound retry duplicates the member's own message, the exact outcome D20
exists to prevent. A filter with no rows to filter is a harmless no-op; rows with
no filter are a visible defect.

**And the whole display lands before ANY of it.** Round 2 found that moving only
the filter forward relocated the incoherent window rather than closing it: with
the claim before the presenter, a delivered retry passes the filter and renders
`Delivered 1/1` in success green beside an original still reading
`1 failed - Phone unreachable (error 30003)` - two bubbles contradicting each
other about one message.

So the order is: **Tasks 1-4** server groundwork that changes no behavior;
**Tasks 5-10** the entire display, inert because no retry row exists yet;
**Tasks 11-13** the server side that starts creating them; then the browser proof
and the issue closures. Tasks 1-4 and 5-10 are independent and may run in
parallel. Everything from Task 11 depends on both halves.

---

## File Structure

**Server - new**

- `app/src/jobs/relayRetryLeg.ts` - the retry job: payload, handler, gates, close
  codes, transient sub-ladder, backoff injection.
- `app/src/lib/relayRetryClaim.ts` - pure helpers: the digest, the provider-SID
  shape, the attempt arithmetic. Pure so the webhook and the job cannot disagree
  about identity, and so it is testable without DynamoDB.

**Server - modified**

- `app/src/repos/messagesRepo.ts` - six lineage values on `MessageItem` and
  `NewMessage`; media-pointer suppression for retry rows; a consistent source read
  on the interface.
- `app/src/jobs/relayFanOut.ts` - extract the per-leg send body into an exported
  unit both the fan-out and the retry job call; export `RelayTransportMode`.
- `app/src/routes/webhooks/twilio.ts` - the claim, the SSE on claim, the
  `retryClaim` log field, the relay severity predicate, and one condition on
  `flagPlacementAttention` so a ladder escalates once rather than once per rung.
- `app/src/repos/conversationsRepo.ts` - a status-preserving activity bump.
- `app/src/jobs/registerHandlers.ts` - register the new job and read the backoff
  override (WORKER-side, not `dev.ts`).

**Dashboard - modified**

- `dashboard/src/api/types.ts`, `dashboard/src/routes/conversation/useRelayThread.ts`
  - four wire fields.
- `dashboard/src/routes/contact/relayRetryJoin.ts` - **new.** The thread-level
  join. A separate file because it is pure, it is the heart of the display
  contract, and both `Timeline.tsx` and its tests need it without pulling in a
  4000-line component.
- `dashboard/src/routes/contact/deliveryStatus.ts` - arithmetic, composition, copy,
  internal close codes.
- `dashboard/src/routes/contact/Timeline.tsx` - entries with keys, sibling
  plumbing, the four live reason positions, the `visible` filter, the ticker
  clause.

**E2E**

- `e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts` -> renamed to
  `relay-30003-retry.spec.ts` with `git mv`. Its negative assertions survive; its
  positive strings are the checklist for the new copy.

---

## Task 1: Lineage fields and the retry-row append shape

**Files:**
- Modify: `app/src/repos/messagesRepo.ts` (`MessageItem` ~`:872-1000`,
  `NewMessage` ~`:640-1040`, `append` ~`:2100-2300`, media pointers `:2286-2290`)
- Create: `app/src/lib/relayRetryClaim.ts`
- Test: `app/test/relayRetryClaim.test.ts`,
  `app/test/messagesRepoRetryLineage.integration.test.ts`

**Interfaces:**
- Produces:
  - `relayRetryDigest(rootTsMsgId: string, destinationE164: string): string` -
    first 16 hex chars of SHA-256 of `` `${rootTsMsgId}|${destinationE164}` ``.
  - `relayRetryProviderSid(digest: string, attempt: number): string` -
    `` `relayretry-${digest}-${attempt}` ``.
  - `MAX_RELAY_RETRY_ATTEMPTS = 3`, `relayRetryBackoffMs(attempt: number): number`.
  - `NewMessage` gains `relayRetryOf?`, `relayRetryMemberKey?`,
    `relayRetryAttempt?`, `relayRetryDestDigest?`, `relayRetryOriginDirection?`,
    `relayRetryLegBody?`; `MessageItem` gains the snake_case twins.

**SIX stored values, not five.** D12 splits the body: the ROW stores the raw body
(what is persisted, previewed and inherited by the inbox preview) and
`relay_retry_leg_body` stores the exact composed leg copy, sent verbatim so a
sender renamed between attempts cannot rewrite what was already sent. Round 1
found the plan consuming this field in two tasks without ever creating it.

- [ ] **Step 1: Write the failing identity tests**

```ts
// app/test/relayRetryClaim.test.ts
import { describe, expect, it } from 'vitest';
import {
  MAX_RELAY_RETRY_ATTEMPTS,
  relayRetryBackoffMs,
  relayRetryDigest,
  relayRetryProviderSid,
} from '../src/lib/relayRetryClaim.js';

describe('relayRetryClaim identity', () => {
  it('is deterministic for the same root, destination and attempt', () => {
    const d = relayRetryDigest('2026-09-02T10:00:00.000Z#SM123', '+15558675309');
    expect(relayRetryDigest('2026-09-02T10:00:00.000Z#SM123', '+15558675309')).toBe(d);
    expect(relayRetryProviderSid(d, 1)).toBe(relayRetryProviderSid(d, 1));
  });

  it('separates ladders by destination and by attempt', () => {
    const root = '2026-09-02T10:00:00.000Z#SM123';
    const a = relayRetryDigest(root, '+15558675309');
    const b = relayRetryDigest(root, '+15558675310');
    expect(a).not.toBe(b);
    expect(relayRetryProviderSid(a, 1)).not.toBe(relayRetryProviderSid(a, 2));
  });

  // D3: the SID becomes the second half of a sort key that splits on the FIRST
  // '#', and a phone in a sort key is a PII leak. Both are structural.
  it('emits no "#" and no phone digits from the destination', () => {
    const sid = relayRetryProviderSid(
      relayRetryDigest('2026-09-02T10:00:00.000Z#SM123', '+15558675309'),
      2,
    );
    expect(sid).not.toContain('#');
    expect(sid).not.toContain('5558675309');
    expect(sid).toMatch(/^relayretry-[0-9a-f]{16}-[1-3]$/);
  });

  it('matches the 1:1 ladder policy', () => {
    expect(MAX_RELAY_RETRY_ATTEMPTS).toBe(3);
    expect([1, 2, 3].map(relayRetryBackoffMs)).toEqual([60_000, 120_000, 240_000]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd app; npx vitest run test/relayRetryClaim.test.ts`
Expected: FAIL - cannot resolve `../src/lib/relayRetryClaim.js`.

- [ ] **Step 3: Write the module**

```ts
// app/src/lib/relayRetryClaim.ts
import { createHash } from 'node:crypto';

/** Total retry attempts for one failed relay leg - the 1:1 ladder's cap
 *  (`jobs/retrySend.ts:37`), spec D6. */
export const MAX_RELAY_RETRY_ATTEMPTS = 3;

/** 60s, 120s, 240s for attempts 1..3 (`retrySend.ts:39-42`). */
export function relayRetryBackoffMs(attempt: number): number {
  return 60_000 * 2 ** (attempt - 1);
}

/** The ladder's identity: root message + DESTINATION handset (D5 - the
 *  destination, not the member key, because one contactId on two numbers
 *  collapses into one member key). Hashed, never raw: this value ends up inside
 *  a sort key, where a phone number must never appear, and `splitTsMsgId`
 *  (`messagesRepo.ts:204-209`) splits on the FIRST '#'. */
export function relayRetryDigest(rootTsMsgId: string, destinationE164: string): string {
  return createHash('sha256').update(`${rootTsMsgId}|${destinationE164}`).digest('hex').slice(0, 16);
}

/** The synthetic provider SID whose `sid#` pointer IS the atomic claim (D3). */
export function relayRetryProviderSid(digest: string, attempt: number): string {
  return `relayretry-${digest}-${attempt}`;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd app; npx vitest run test/relayRetryClaim.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing persistence tests**

Follow `app/test/mediaPointers.integration.test.ts` for table setup, teardown
and - for this task hardest assertion - how to count media-pointer rows.

```ts
it('round-trips the six lineage values', async () => {
  const res = await messages.append({
    conversationId,
    providerSid: 'relayretry-abc0123456789def-1',
    providerTs: new Date().toISOString(),
    type: 'sms', direction: 'outbound', author: 'teammate',
    deliveryStatus: 'queued',
    body: 'the original text',
    relayRetryOf: rootTsMsgId,
    relayRetryMemberKey: 'contact-1',
    relayRetryAttempt: 1,
    relayRetryDestDigest: 'abc0123456789def',
    relayRetryOriginDirection: 'outbound',
    relayRetryLegBody: 'Sam: the original text',
    deliveryRecipients: { 'contact-1': { status: 'queued' } },
  });
  const row = await messages.getByTsMsgId(conversationId, res.tsMsgId);
  expect(row?.relay_retry_of).toBe(rootTsMsgId);
  expect(row?.relay_retry_attempt).toBe(1);
  expect(row?.relay_retry_origin_direction).toBe('outbound');
  // D12: the ROW keeps the raw body; the LEG copy is a separate field.
  expect(row?.body).toBe('the original text');
  expect(row?.relay_retry_leg_body).toBe('Sam: the original text');
});

// D3: the claim. A repeat of the SAME provider SID must DEDUPE, not throw -
// `append` attributes a dedupe to the sid pointer at index 1 (:2295-2306) and
// rethrows anything else (:2374-2388).
it('reports a duplicate provider SID as deduped, pointing at the winner', async () => {
  const sid = 'relayretry-abc0123456789def-1';
  const first = await messages.append({ ...base, providerSid: sid });
  const second = await messages.append({
    ...base, providerSid: sid,
    providerTs: new Date(Date.now() + 5_000).toISOString(),
  });
  expect(second.deduped).toBe(true);
  expect(second.tsMsgId).toBe(first.tsMsgId);
});

// D13: the gallery index must not grow per attempt.
it('writes no media-pointer rows for a retry row', async () => {
  const res = await messages.append({
    ...base, type: 'mms', relayRetryOf: rootTsMsgId, relayRetryAttempt: 1,
    mediaAttachments: [{ s3Key: 'unit-media/x.jpg', contentType: 'image/jpeg' }],
  });
  await expect(mediaPointerCount(conversationId, res.tsMsgId)).resolves.toBe(0);
  const row = await messages.getByTsMsgId(conversationId, res.tsMsgId);
  expect(row?.media_attachments?.[0]?.s3Key).toBe('unit-media/x.jpg');
});

// D2, VERSIONED original: slot seeded `planned` or the first send throws at
// relayFanOut.ts:1418-1424.
it('accepts a versioned retry row whose slot is seeded planned', async () => {
  await expect(messages.append({
    ...base, transportSchemaVersion: 1,
    relayRetryOf: rootTsMsgId, relayRetryAttempt: 1,
    deliveryRecipients: { 'contact-1': {
      status: 'queued', requestedTransport: 'sms', transportAggregationState: 'planned' } },
  })).resolves.toBeDefined();
});

// D2, INBOUND original: no MESSAGE-level requestedTransport (:913-915), but the
// SLOT may carry one (:922-937). The distinction is easy to invert.
it('accepts an inbound retry row whose slot carries a requested transport', async () => {
  await expect(messages.append({
    ...base, direction: 'inbound', author: 'tenant', transportSchemaVersion: 1,
    relayRetryOf: rootTsMsgId, relayRetryAttempt: 1,
    deliveryRecipients: { 'contact-1': {
      status: 'queued', requestedTransport: 'sms', transportAggregationState: 'planned' } },
  })).resolves.toBeDefined();
});

// D2, LEGACY original: no transport fields anywhere. Every relay source written
// before 2026-09-02 is legacy, so this is the ORDINARY case for an old message.
it('accepts a legacy retry row with no transport fields', async () => {
  await expect(messages.append({
    ...base, relayRetryOf: rootTsMsgId, relayRetryAttempt: 1,
    deliveryRecipients: { 'contact-1': { status: 'queued' } },
  })).resolves.toBeDefined();
});
```

- [ ] **Step 6: Run them and watch them fail**

Run: `cd app; npx vitest run test/messagesRepoRetryLineage.integration.test.ts`
Expected: FAIL - unknown properties on `NewMessage`; media pointers written.

- [ ] **Step 7: Add the fields and the pointer suppression**

Add the six optional fields to `NewMessage` and their snake_case twins to
`MessageItem`; persist them in `append` following the existing
`...(message.retryOf !== undefined && { retry_of: message.retryOf })` shape at
`:2158-2161`. Then guard the media-pointer items, **keeping whatever
transaction-item wrapper the surrounding code already uses** - read `:2286-2290`
before editing rather than copying a shape from this plan:

```ts
// D13: a retry row re-sends attachments it already carries, so it must NOT add
// a second gallery tile per attempt - the pointer index IS the "Media from
// comms" gallery (:211-231). The durable s3Keys still ride the row so the retry
// can re-presign from them.
const isRelayRetryRow = message.relayRetryOf !== undefined;
```

- [ ] **Step 8: Run them and watch them pass**

Run: `cd app; npx vitest run test/messagesRepoRetryLineage.integration.test.ts test/relayRetryClaim.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add app/src/lib/relayRetryClaim.ts app/src/repos/messagesRepo.ts app/test/relayRetryClaim.test.ts app/test/messagesRepoRetryLineage.integration.test.ts
git commit -m "feat(relay): retry lineage fields and the deterministic claim identity"
```

---

## Task 2: Expose a consistent source read

**Files:**
- Modify: `app/src/repos/messagesRepo.ts` (`MessagesRepo` interface `:1339`, the
  private `getMessageConsistent` `:1885-1897`, the factory return `:2085`)
- Modify: every test file that builds a `MessagesRepo` object literal (Step 3)
- Test: `app/test/messagesRepoRetryLineage.integration.test.ts`

**Interfaces:**
- Produces: `getByTsMsgIdConsistent(conversationId: string, tsMsgId: string): Promise<MessageItem | undefined>`

D7 requires the claim path to read the source consistently, and
`getMessageConsistent` is a PRIVATE closure not on the interface.

- [ ] **Step 1: Write the failing tests**

```ts
it('exposes a consistent read on the interface', async () => {
  const res = await messages.append({ ...base });
  await expect(messages.getByTsMsgIdConsistent(conversationId, res.tsMsgId))
    .resolves.toMatchObject({ tsMsgId: res.tsMsgId });
});
```

Plus, in the mocked-client suite (follow `app/test/messagesRepo.transport.test.ts`
for the doc-client stub shape) - the flag is the actual contract:

```ts
it('sets ConsistentRead on the consistent read and not on the plain one', async () => {
  await repo.getByTsMsgIdConsistent('c1', 't1');
  expect(sentInput()).toMatchObject({ ConsistentRead: true });
  await repo.getByTsMsgId('c1', 't1');
  expect(sentInput().ConsistentRead).toBeUndefined();
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd app; npx vitest run test/messagesRepoRetryLineage.integration.test.ts -t consistent`
Expected: FAIL - `getByTsMsgIdConsistent is not a function`.

- [ ] **Step 3: Add it to the interface, the factory, and every typed fake**

Reuse the existing private helper; do NOT write a second `GetCommand`. **Do not**
change `getByTsMsgId` - `twilio.ts:2449` runs on every relay status callback and
only needs `requestedTransport`, so making it consistent would double a hot-path
read to fix a rare one (D7).

Adding a method to the interface breaks every test file that builds a
`MessagesRepo` object literal, and `npm run typecheck` is gate 1. Find them and
fix them in this same commit:

```bash
cd app; grep -rln "MessagesRepo" test/ | xargs grep -ln "getByTsMsgId"
```

- [ ] **Step 4: Run the typecheck and the suites**

Run: `npm run typecheck`
Expected: exit 0.
Run: `cd app; npx vitest run test/messagesRepoRetryLineage.integration.test.ts test/messagesRepo.transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/repos/messagesRepo.ts app/test/
git commit -m "feat(relay): expose a consistent message read for the retry claim path"
```

---

## Task 3: Extract the per-leg send unit

**Files:**
- Modify: `app/src/jobs/relayFanOut.ts` (the loop body `:1118-1269`; export
  `RelayTransportMode` from `:957`)
- Test: existing `app/test/relayFanOut.test.ts` and
  `app/test/relayAnnouncements.test.ts` are the proof - this task adds no new
  behavior.

**Interfaces:**
- Produces:

```ts
export type { RelayTransportMode };   // needed by the retry job's signature

export interface RelayLegSendOutcome {
  kind: 'sent' | 'skipped_terminal' | 'suppressed' | 'refused' | 'filtered' | 'transient';
  providerSid?: string;
  errorCode?: string;
}

export async function sendOneRelayLeg(args: {
  messages: MessagesRepo;
  conversations: ConversationsRepo;
  contacts: ContactsRepo;
  adapter: MessagingAdapter;
  mediaStore?: MediaStore;
  log: Logger;
  tokenBucket?: TokenBucket;
  conversationId: string;
  sourceTsMsgId: string;
  poolNumber: string;
  member: ConversationParticipant;
  body: string;
  sourceMedia: MediaAttachment[];
  transport: RelayTransportMode;
  currentSource: MessageItem;
}): Promise<RelayLegSendOutcome>;
```

**This is a behavior-preserving extraction** (D10), chosen over reusing
`relay.fanOut` with a one-member list, which would have needed four behavior
changes inside the hottest relay path. Move the body of the
`for (const member of recipients)` loop verbatim; the loop becomes a call. Map
`continue` onto `RelayLegSendOutcome.kind`.

**The extracted unit already writes the slot AND the `relaysid#` pointer**
(`:1250-1267`). Its callers must not write them again.

- [ ] **Step 1: Establish the green baseline**

Run: `cd app; npx vitest run test/relayFanOut.test.ts test/relayAnnouncements.test.ts test/relayWebhook.test.ts test/relayApi.test.ts`
Expected: PASS. **Record the counts.** They must be identical afterwards; a
changed count means the extraction changed behavior.

- [ ] **Step 2: Extract, without changing a line of logic**

Permitted edits are mechanical only: parameters instead of closure captures,
`return` instead of `continue`, `payload`-derived values becoming explicit
arguments, and exporting `RelayTransportMode`.

- [ ] **Step 3: Run the same four suites**

Run: `cd app; npx vitest run test/relayFanOut.test.ts test/relayAnnouncements.test.ts test/relayWebhook.test.ts test/relayApi.test.ts`
Expected: PASS with the SAME counts as Step 1.

- [ ] **Step 4: Commit**

```bash
git add app/src/jobs/relayFanOut.ts
git commit -m "refactor(relay): extract sendOneRelayLeg so the retry job can reuse it"
```

---

## Task 4: The status-preserving activity bump

**Files:**
- Modify: `app/src/repos/conversationsRepo.ts` (beside `touchLastActivity`
  `:1531-1578`)
- Create: `app/test/conversationsRepoActivityBump.integration.test.ts`. Neither
  `conversationsRepo.integration.test.ts` nor `messagesRepo.integration.test.ts`
  exists. The conversations-repo harness is
  `app/test/relayRepos.integration.test.ts`, which already constructs relay
  conversations and drives `setRelayStatus` (`:97`, `:222`, `:389`). Do NOT copy
  `mediaPointers.integration.test.ts` here - it builds a messages repo and never
  constructs a conversation.

**Interfaces:**
- Produces: `touchLastActivityPreservingStatus(conversationId: string, preview: string | undefined, at: string): Promise<ConversationItem | undefined>`

D16: `touchLastActivity` sets `status = 'open'` on any non-group-text
conversation, and the retry's bump runs 60-240 seconds after the open-group gate -
so a group closed during the backoff would be resurrected by its own retry.

- [ ] **Step 1: Write the failing tests**

```ts
// `setRelayStatus` takes THREE required arguments including `expectedCurrent`
// (conversationsRepo.ts:850-854); calling it with two makes Step 2's red a
// typecheck error on the wrong symbol instead of the missing method.
it('bumps activity without reopening a closed relay group', async () => {
  await conversations.setRelayStatus(conversationId, 'closed', 'open');
  const before = await conversations.getById(conversationId);
  await conversations.touchLastActivityPreservingStatus(
    conversationId, 'the original text', new Date().toISOString());
  const after = await conversations.getById(conversationId);
  expect(after?.status).toBe('closed');
  expect(after?.last_activity_at).not.toBe(before?.last_activity_at);
});

it('leaves an open group open', async () => {
  await conversations.touchLastActivityPreservingStatus(
    conversationId, 'the original text', new Date().toISOString());
  expect((await conversations.getById(conversationId))?.status).toBe('open');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd app; npx vitest run test/conversationsRepoActivityBump.integration.test.ts`
Expected: FAIL - method missing.

- [ ] **Step 3: Implement**

An `UpdateCommand` setting `last_activity_at` and `last_message_preview` only - no
`#s = :open` - under the same item-existence condition the sibling uses. Add it to
the `ConversationsRepo` interface and fix every typed fake (the Task 2 Step 3
sweep, for `ConversationsRepo`).

```ts
/** D16. Activity bump that does NOT write `status`. `touchLastActivity` sets
 *  `status = 'open'` (:1531-1560); a relay retry lands 60-240s after its
 *  open-group gate, so using that one would reopen a group closed during the
 *  backoff, contradicting the "this group chat is now closed" message already
 *  sent. On a closed group this re-sorts it within the `closed` partition of the
 *  byLastActivity GSI (:632, :699), which is the intended, observable effect. */
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm run typecheck`, then
`cd app; npx vitest run test/conversationsRepoActivityBump.integration.test.ts`
Expected: exit 0, then PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/repos/conversationsRepo.ts app/test/
git commit -m "feat(relay): status-preserving activity bump for retry sends"
```

---

## Task 5: The wire fields

**Files:**
- Modify: `dashboard/src/api/types.ts` (`TimelineMessage` ~`:2474+`),
  `dashboard/src/routes/conversation/useRelayThread.ts` (`toTimelineMessage`
  `:69-135`)
- Test: `dashboard/src/routes/conversation/useRelayThread.test.tsx`

**Interfaces:**
- Produces: `TimelineMessage` gains `relay_retry_of?: string`,
  `relay_retry_member_key?: string`, `relay_retry_attempt?: number`,
  `relay_retry_origin_direction?: 'inbound' | 'outbound'`.

Four wire fields of the six stored. The destination DIGEST and the LEG BODY stay
server-side: D11 - `/conversations/:id/messages` returns stored rows as-is
(`app/src/routes/api.ts:2148-2199`), so anything on the row reaches every browser
whatever the projector forwards, and neither has a client use.

`dashboard/src/lib/messageTransport.ts` needs NO change. It is a READER to be
aware of - `presentMessageTransport`'s aggregate (`:78-96`) will now see
single-entry maps from retry rows - not a file to edit.

- [ ] **Step 1: Write the failing projector test**

```ts
// The projectors spread a FIXED field list, so an unlisted field is dropped
// before render even though it crossed the wire. `imported_from`
// (useRelayThread.ts:133) is the precedent for adding one.
it('projects the four retry lineage fields', () => {
  const item = toTimelineMessage({
    ...rawRow,
    relay_retry_of: '2026-09-02T10:00:00.000Z#SM1',
    relay_retry_member_key: 'contact-1',
    relay_retry_attempt: 2,
    relay_retry_origin_direction: 'outbound',
  });
  expect(item).toMatchObject({
    relay_retry_of: '2026-09-02T10:00:00.000Z#SM1',
    relay_retry_member_key: 'contact-1',
    relay_retry_attempt: 2,
    relay_retry_origin_direction: 'outbound',
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd dashboard; npx vitest run src/routes/conversation/useRelayThread.test.tsx -t lineage`
Expected: FAIL - fields undefined on the projected item.

- [ ] **Step 3: Add the type fields and project them**

- [ ] **Step 4: Run and watch it pass**

Run: `cd dashboard; npx vitest run src/routes/conversation/useRelayThread.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/api/types.ts dashboard/src/routes/conversation/useRelayThread.ts dashboard/src/routes/conversation/useRelayThread.test.tsx
git commit -m "feat(dashboard): carry relay retry lineage to the relay thread"
```

---

## Task 6: The thread-level retry join

**Files:**
- Create: `dashboard/src/routes/contact/relayRetryJoin.ts`
- Test: `dashboard/src/routes/contact/relayRetryJoin.test.ts`

**Interfaces:**
- Produces:

```ts
export type RelayRetryState =
  | 'retrying' | 'delivered-on-retry' | 'terminal' | 'unconfirmed';

/** A retry row as the join sees it. */
export interface RelayRetryRow {
  tsMsgId: string;
  atMs: number;
  relay_retry_of: string;
  relay_retry_member_key: string;
  relay_retry_attempt: number;
  relay_retry_origin_direction?: 'inbound' | 'outbound';
  leg: RelayDeliverySlot | undefined;   // its own single-entry slot
}

/** EXTENDS the slot - it does not replace it. Consumers need `sentAt`,
 *  `deliveredAt`, `transportAggregationState`, `requestedTransport` and
 *  `actualTransport`: `includedRecipientEntries` (deliveryStatus.ts:407),
 *  `isStaleLeg` (:415), `recipientRowTime` (Timeline.tsx:499) and the row's
 *  transport line (:1118-1119) all read them, and the same presenter serves the
 *  FENCED native group-text product. */
export interface EffectiveRelayLeg extends RelayDeliverySlot {
  retryState?: RelayRetryState;
}

/** Lineage half - memoizable on `items`. */
export function indexRelayRetries(
  items: readonly TimelineItem[],
): Map<string, RelayRetryRow[]>;   // keyed `${rootTsMsgId}|${memberKey}`

/** Time-derived half - MUST be recomputed against `nowMs`. */
export function projectRelayLegs(args: {
  entries: readonly (readonly [string, RelayDeliverySlot])[];
  rootTsMsgId: string;
  retries: Map<string, RelayRetryRow[]>;
  nowMs: number | undefined;
}): Map<string, EffectiveRelayLeg>;
```

**Two functions, not one, and that is the point (D18/D19).** A single
`useMemo(..., [items])` would freeze the time-derived half and restore both
failures the ticker clause exists to prevent, while looking correct in every test
that asserts a final state.

`retryState` is a SEPARATE field. `DeliveryStatus` is a closed union and
`presentDeliveryStatus` returns null outside it (`deliveryStatus.ts:128-141`), so
an overloaded `status: 'retrying'` renders as no state at all and drops the leg
from both rollup counters.

- [ ] **Step 1: Write the failing state-machine tests**

```ts
import { STALE_SENT_AFTER_MS } from './deliveryStatus.js';   // :58 - D18 reuses the
// module's ONLY budget so two staleness horizons cannot drift apart.

it('is retrying while a claimed rung is live', () => {
  const legs = project({ retryRows: [queuedRetry({ atMs: now - 1_000 })], nowMs: now });
  expect(legs.get(memberKey)).toMatchObject({ retryState: 'retrying' });
});

it('is delivered-on-retry once any rung delivered', () => {
  const legs = project({ retryRows: [failedRetry(1), deliveredRetry(2)], nowMs: now });
  expect(legs.get(memberKey)).toMatchObject({
    status: 'delivered', retryState: 'delivered-on-retry',
  });
});

// A delivered retry cannot be un-delivered by a later failed rung arriving out
// of order.
it('keeps delivered-on-retry when an older rung reports failure afterwards', () => {
  const legs = project({ retryRows: [deliveredRetry(1), failedRetry(2)], nowMs: now });
  expect(legs.get(memberKey)).toMatchObject({ retryState: 'delivered-on-retry' });
});

it('is terminal at the cap, keeping the carrier reason', () => {
  const legs = project({
    retryRows: [failedRetry(1), failedRetry(2), failedRetry(3)], nowMs: now });
  expect(legs.get(memberKey)).toMatchObject({
    status: 'undelivered', errorCode: '30003', retryState: 'terminal',
  });
});

// D19: the close code is PROJECTED onto the original, because the refused retry
// row has no bubble of its own to carry it.
it('projects a gate refusal code onto the original leg', () => {
  const legs = project({ retryRows: [refusedRetry('retry_number_changed')], nowMs: now });
  expect(legs.get(memberKey)).toMatchObject({
    errorCode: 'retry_number_changed', retryState: 'terminal',
  });
});

// D18, half one: the stranded claim - created, never sent.
it('is unconfirmed when a rung never reached sent inside the budget', () => {
  const legs = project({
    retryRows: [queuedRetry({ atMs: now - STALE_SENT_AFTER_MS - 1 })], nowMs: now });
  expect(legs.get(memberKey)).toMatchObject({ retryState: 'unconfirmed' });
});

// D18, half two: sent, no receipt. Specifying only half one is how "retrying"
// nearly became a permanent lie for the third time in this design's review.
it('is unconfirmed when a sent rung got no receipt inside the budget', () => {
  const legs = project({
    retryRows: [sentRetry({ sentAtMs: now - STALE_SENT_AFTER_MS - 1 })], nowMs: now });
  expect(legs.get(memberKey)).toMatchObject({ retryState: 'unconfirmed' });
});

// The slot must survive the projection intact - four consumers read these.
it('preserves every slot field it did not decide', () => {
  const legs = project({ retryRows: [deliveredRetry(1)], nowMs: now });
  expect(legs.get(memberKey)).toMatchObject({
    sentAt: expect.any(String), transportAggregationState: 'attempted',
  });
});

it('leaves a leg with no retry rows completely untouched', () => {
  const legs = project({ retryRows: [], nowMs: now });
  expect(legs.get(memberKey)).toEqual(originalSlot);
  expect(legs.get(memberKey)?.retryState).toBeUndefined();
});

// D5: one contact on two numbers collapses into ONE slot today. The join must
// not invent a second one.
it('keys strictly on the member key the retry row names', () => {
  const legs = project({
    retryRows: [deliveredRetry(1, { memberKey: 'other' })], nowMs: now });
  expect(legs.get(memberKey)?.retryState).toBeUndefined();
});

// Rungs 2 and 3 chain to the ROOT, never to the previous retry row - otherwise
// they orphan from this key and from the changed-number digest.
it('indexes every rung under the ROOT key', () => {
  const idx = indexRelayRetries([retryRow(1), retryRow(2), retryRow(3)]);
  expect(idx.get(`${rootTsMsgId}|${memberKey}`)).toHaveLength(3);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd dashboard; npx vitest run src/routes/contact/relayRetryJoin.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement both functions**

`indexRelayRetries` buckets every item carrying `relay_retry_of` by
`${relay_retry_of}|${relay_retry_member_key}`. `projectRelayLegs` spreads the
ORIGINAL slot and overlays only what it decides, resolving in this order:
delivered wins permanently; else any live rung inside the budget is `retrying`;
else a rung past either horizon with no terminal outcome is `unconfirmed`; else
`terminal`, taking the close code from the last rung when it carries one and
otherwise leaving the original's carrier code.

- [ ] **Step 4: Run and watch them pass**

Run: `cd dashboard; npx vitest run src/routes/contact/relayRetryJoin.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/routes/contact/relayRetryJoin.ts dashboard/src/routes/contact/relayRetryJoin.test.ts
git commit -m "feat(dashboard): derive per-member relay retry state from thread lineage"
```

---

## Task 7: The render filter, before any retry row can exist

**Files:**
- Modify: `dashboard/src/routes/contact/Timeline.tsx` (the `visible` memo
  `:1787-1799`)
- Test: `dashboard/src/routes/contact/Timeline.test.tsx`

**This task sits here on purpose.** The server starts appending retry rows in
Task 12. If the filter arrived after that, every relay thread would render up to
three unfiltered duplicate bubbles in between, and an inbound retry would
duplicate the member's own message - the exact outcome D20 exists to prevent. A
filter with no rows to filter is a no-op; rows with no filter are a visible
defect.

- [ ] **Step 1: Write the failing predicate tests**

```ts
// D20: renders ONLY when the leg delivered AND the original was outbound. Both
// read from the retry row's OWN lineage, so the predicate never depends on the
// original being loaded (D22 - paging is newest-first).
it('renders a delivered retry of an outbound original', () => {
  renderTimeline({ items: [outboundOriginal, deliveredRetryRow] });
  expect(screen.getAllByText(BODY)).toHaveLength(2);
});

it.each([
  ['a failed retry', failedRetryRow],
  ['a queued retry', queuedRetryRow],
  ['a retry of an INBOUND original', deliveredRetryOfInboundRow],
])('renders no second bubble for %s', (_n, row) => {
  renderTimeline({ items: [outboundOriginal, row] });
  expect(screen.getAllByText(BODY)).toHaveLength(1);
});

// D20: the original must NEVER be hidden. Stamping `retry_of` would add it to
// supersededIds and delete it - the contract inverted by one field.
it('never hides the original', () => {
  renderTimeline({ items: [outboundOriginal, deliveredRetryRow] });
  expect(screen.getByText(ORIGINAL_MARKER)).toBeVisible();
});

// D22: a retry can render before its original loads.
it('renders an orphaned delivered retry', () => {
  renderTimeline({ items: [deliveredRetryRow] });
  expect(screen.getByText(BODY)).toBeVisible();
});

// The existing 1:1 collapse is FENCED and must not move.
it('leaves the existing retry_of collapse untouched', () => {
  renderTimeline({ items: [failed1to1, retryOf1to1] });
  expect(screen.getAllByText(BODY)).toHaveLength(1);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd dashboard; npx vitest run src/routes/contact/Timeline.test.tsx -t retry`
Expected: FAIL - every retry row renders.

- [ ] **Step 3: Extend the `visible` memo**

Add the D20 predicate ALONGSIDE the existing `supersededIds` rule, not inside it -
the existing rule hides a PREDECESSOR, this one hides the row itself.

**Read delivered-ness from the retry row OWN slot** -
`msg.delivery_recipients?.[msg.relay_retry_member_key]?.status === 'delivered'` -
together with `msg.relay_retry_origin_direction === 'outbound'`. Do NOT route this
through Task 6's join: `visible` would then depend on the time-derived half, and a
memo over `items` would freeze it. The filter is a pure function of the row.

- [ ] **Step 4: Run and watch them pass**

Run: `cd dashboard; npx vitest run src/routes/contact/Timeline.test.tsx`
Expected: PASS, including every pre-existing case.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/Timeline.test.tsx
git commit -m "feat(dashboard): hide retry rows that earn no bubble, before any exist"
```

---

## Task 8: The presenter

**Files:**
- Modify: `dashboard/src/routes/contact/deliveryStatus.ts`
  (`presentRelayDelivery` `:394-456`, `presentLegDelivery` `:508-545`,
  `INTERNAL_CODE_REASONS` `:688-692`, `RelayDeliveryOptions` `:351`)
- Test: `dashboard/src/routes/contact/deliveryStatus.test.ts`

**Interfaces:**
- Consumes: `EffectiveRelayLeg` (Task 6).
- Produces: `presentRelayDelivery` and `presentLegDelivery` accept
  `EffectiveRelayLeg` (which extends `RelayDeliverySlot`, so every existing
  caller keeps compiling).

- [ ] **Step 1: Write the failing chip tests**

```ts
// D19's table, at the chip.
it.each([
  ['retrying',           'delivered 3/4 - 1 retrying'],
  ['delivered-on-retry', 'delivered 4/4 - 1 on retry'],
  ['unconfirmed',        'delivered 3/4 - 1 not confirmed'],
])('renders %s as %s', (retryState, label) => {
  expect(presentRelayDelivery(legsWith(retryState), relayOpts)?.label).toBe(label);
});

it('keeps today exact string when the cap is exhausted', () => {
  const chip = presentRelayDelivery(legsWith('terminal'), relayOpts);
  expect(`${chip?.label} - ${chip?.reason}`)
    .toBe('delivered 3/4 - 1 failed - Phone unreachable (error 30003)');
});

// D19: a bubble can hold more than one state at once. Fixed order, zero-count
// categories omitted.
it('composes a failed leg and a retrying leg in one label', () => {
  expect(presentRelayDelivery(mixedLegs, relayOpts)?.label)
    .toBe('delivered 2/4 - 1 failed, 1 retrying');
});

// The retry `unconfirmed` and the pre-existing staleness "not confirmed" share
// one label slot; they must stay DISJOINT counts, never double-counted.
it('counts a stale ORIGINAL leg and an unconfirmed RETRY leg once each', () => {
  expect(presentRelayDelivery(staleAndUnconfirmed, relayOpts)?.label)
    .toBe('delivered 2/4 - 2 not confirmed');
});

// D19: the shared success label serves native group text and the broadcasts
// routes and must not move.
it('leaves the all-delivered label untouched without a retry', () => {
  expect(presentRelayDelivery(allDelivered, relayOpts)?.label).toBe('Delivered 4/4');
});

// D15: an unmapped internal code prints as a fake carrier error.
it.each([
  ['retry_group_closed',   'Not retried - group closed'],
  ['retry_member_removed', 'Not retried - no longer in this group'],
  ['retry_number_changed', 'Not retried - number changed since'],
  ['retry_opted_out',      'Not retried - opted out'],
])('renders %s as prose with no (error N) tail', (code, copy) => {
  expect(deliveryReason(code, { relay: true })).toBe(copy);
});
```

- [ ] **Step 2: Write the failing row tests**

```ts
// D19's second table - the row and recital grammar.
it.each([
  ['retrying',           'Retrying - Phone unreachable (error 30003)'],
  ['delivered-on-retry', 'Delivered on retry'],
])('renders the per-recipient row for %s', (retryState, text) => {
  expect(rowTextOf(presentLegDelivery(legWith(retryState), 'relay'))).toBe(text);
});

// The FENCED product must not move. There is no way to import a `main` build, so
// the real proof is that every PRE-EXISTING group-text case in this file still
// passes unchanged - Step 5 runs them. Do not invent a `presentLegDeliveryOnMain`.
it('leaves a native group-text leg with no retryState untouched', () => {
  expect(presentLegDelivery(groupTextLeg, 'group_text'))
    .toMatchObject({ label: 'Undelivered', isFailure: true });
});
```

- [ ] **Step 3: Run and watch them fail**

Run: `cd dashboard; npx vitest run src/routes/contact/deliveryStatus.test.ts -t retry`
Expected: FAIL.

- [ ] **Step 4: Implement**

Subtract `retrying`, `delivered-on-retry` and `unconfirmed` legs from the `failed`
bucket before the `failed > 0` branch (`:416`) - it is the FIRST branch, so an
unsubtracted leg wins over every new state. Add the retrying count to the
composed label; add the `on retry` suffix to the delivered count; fold retry
`unconfirmed` into the existing not-confirmed count without double-counting a leg
that is also `isStaleLeg`. Scope every new string behind a retry-aware option on
`RelayDeliveryOptions`. Add the four codes to `INTERNAL_CODE_REASONS`.

- [ ] **Step 5: Run and watch them pass**

Run: `cd dashboard; npx vitest run src/routes/contact/deliveryStatus.test.ts`
Expected: PASS, including every pre-existing case.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/routes/contact/deliveryStatus.ts dashboard/src/routes/contact/deliveryStatus.test.ts
git commit -m "feat(dashboard): render relay retry states at the chip and the row"
```

---

## Task 9: Timeline positions and the ticker

**Files:**
- Modify: `dashboard/src/routes/contact/Timeline.tsx` - the entries call `:937`,
  `MessageBubble`/`StreamItem` props `:814-835` and `:1538-1552`, the
  `recipientSummaryName` sites `:959-968` and `:993-1004`, the per-recipient row
  `:1112-1115`, `hasTickableLeg` `:798-812`, the run-condition comment `:1806`
- Test: `dashboard/src/routes/contact/Timeline.delivery.test.tsx`,
  `Timeline.ticker.test.tsx`

- [ ] **Step 1: Write the failing three-position test**

```ts
// M5's D21: one flag feeds the rollup, the recital and the row, and the whole
// content of D21 is that they cannot disagree. Patch the chip alone and the
// other two keep reciting "Undelivered - Phone unreachable (error 30003)".
it('shows delivered-on-retry at the chip, the recital AND the row', async () => {
  renderTimeline({ items: [outboundOriginalWithFailedLeg, deliveredRetryRow] });
  const rollup = screen.getByRole('img');
  expect(rollup).toHaveTextContent('delivered 2/2 - 1 on retry');
  expect(rollup).toHaveAccessibleName(/Relay Unreachable: Delivered on retry/);
  await userEvent.click(screen.getByText(BODY));
  expect(within(screen.getByRole('list', { name: 'Delivery by recipient' }))
    .getByText(/Delivered on retry/)).toBeVisible();
});

// Sec 2 + D18: an INBOUND source has no chip, but it DOES have the recital
// (inboundRecipientName, :993-1004) and the rows - the only delivery information
// a screen-reader user gets from that bubble. Leaving them stale would be
// strictly worse than today.
it('updates the inbound recital when a member-originated leg recovers', () => {
  renderTimeline({ items: [inboundOriginalWithFailedLeg, deliveredRetryRow] });
  expect(screen.getByRole('group')).toHaveAccessibleName(/Delivered on retry/);
  expect(screen.queryByRole('img')).toBeNull();
});
```

- [ ] **Step 2: Write the failing ticker tests**

Use the harness the ticker suite already establishes -
`Timeline.ticker.test.tsx:98-119,157-203` spies `window.setInterval` /
`clearInterval` and captures the id; its own comments explain why
`vi.getTimerCount()` is unusable here. Do not invent a `tickerArmed()`.

```ts
// D18: severing from stalenessClockMs severs from the ONLY clock advance. The
// original's failed leg is terminal and can never arm the ticker, and D20 keeps
// the retry row out of `visible` - so without an explicit clause `tickNow` is
// frozen and "retrying" is computed once, for ever.
it('arms the interval for a live retry with no other activity', () => {
  renderTimeline({ items: [outboundOriginal, queuedRetryRow] });
  expect(setIntervalSpy).toHaveBeenCalled();
});

it('flips retrying to not confirmed as the clock passes the budget', () => {
  renderTimeline({ items: [outboundOriginal, queuedRetryRow] });
  expect(screen.getByRole('img')).toHaveTextContent('1 retrying');
  act(() => { vi.advanceTimersByTime(STALE_SENT_AFTER_MS + 1_000); });
  expect(screen.getByRole('img')).toHaveTextContent('1 not confirmed');
});

// The new clause must TERMINATE. This is a different assertion from
// "unconfirmed eventually appears" and both are required.
it('clears the interval once the retry resolves', () => {
  const { rerender } = renderTimeline({ items: [outboundOriginal, queuedRetryRow] });
  rerender({ items: [outboundOriginal, deliveredRetryRow] });
  expect(clearIntervalSpy).toHaveBeenCalledWith(capturedTickerId);
});
```

- [ ] **Step 3: Run and watch them fail**

Run: `cd dashboard; npx vitest run src/routes/contact/Timeline.delivery.test.tsx src/routes/contact/Timeline.ticker.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Implement**

Compute `indexRelayRetries` once at thread level beside `visible`, memoized on
`items`; call `projectRelayLegs` per bubble against `bubbleNowMs`. Pass entries
WITH their keys (`:937` currently discards them). Thread the projected legs
through `MessageBubble` and `StreamItem`. Point the rollup, the rollup recital,
the inbound recital and the per-recipient row at the projected legs - **not** the
message-level chip's accessible name (`:978-989`), which reads `msg.error_code`
and is inert for relay by construction.

`hasTickableLeg` takes `(item, tickNow)` today and is called from the
`tickerArmed` memo over `visible` (`:1851-1854`). D20 removes retry rows from
`visible`, so the predicate cannot find a live retry by itself: give it a third
parameter carrying Task 6 thread-level retry index
(`hasTickableLeg(item, tickNow, retries)`) and pass it at that call site. This is
the one clause whose absence reintroduces BOTH the frozen display and a
non-terminating interval.
Extend BOTH counts in the comments: the docblock's "FIVE clauses carry that
mirror" and the run-condition comment at `:1806` ("the four non-terminations").

- [ ] **Step 5: Run and watch them pass**

Run: `cd dashboard; npx vitest run src/routes/contact/`
Expected: PASS, including every pre-existing Timeline case.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/Timeline.delivery.test.tsx dashboard/src/routes/contact/Timeline.ticker.test.tsx
git commit -m "feat(dashboard): relay retry states at every position, with a live ticker"
```

---

## Task 10: Verify all three relay Timeline hosts

**Files:**
- Test only: `dashboard/src/routes/tours/TourConversation.test.tsx`,
  `dashboard/src/routes/placements/PlacementConversation.test.tsx`

**This is a VERIFICATION task, not an implementation one.** Plan review found the
original version was a no-op with a fake red state: all three hosts already feed
the same shared `<Timeline>`, so Task 9 covers them. It still earns its own gate,
because **the tour host passes a MILESTONE-MERGED item list**
(`TourConversation.tsx:463-467`) rather than `thread.items` - so Task 7's filter
and Task 6's join must be correct against a MIXED list, which no other host
exercises.

If either host is already green at Step 1, say so in the commit message rather
than inventing a change.

- [ ] **Step 1: Write the host tests**

Follow the host suite OWN harness: `TourConversation.test.tsx` defines
`renderConvo(props)` (`:178`) and drives content through
`vi.mock('../../api/index.js')` (`:44`), not an `items` prop. There is no
`renderTourConversation({items})`.

```ts
it('renders delivered-on-retry in the tour transcript, beside milestones', async () => {
  mockThread([outboundOriginal, deliveredRetryRow]);   // via the api mock at :44
  renderConvo();
  expect(await screen.findByRole('img')).toHaveTextContent('delivered 2/2 - 1 on retry');
});

it('hides a failed retry among merged milestone items', async () => {
  mockThread([outboundOriginal, failedRetryRow]);
  renderConvo();
  expect(await screen.findAllByText(BODY)).toHaveLength(1);
});
```

- [ ] **Step 2: Run them**

Run: `cd dashboard; npx vitest run src/routes/tours src/routes/placements`
Expected: PASS if the shared component covers them; a real FAIL means the merged
list broke the filter, which is the defect this task exists to catch.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/routes/tours/ dashboard/src/routes/placements/
git commit -m "test(dashboard): pin relay retry rendering on the tour and placement hosts"
```

---

## Task 11: The retry job

**Files:**
- Create: `app/src/jobs/relayRetryLeg.ts`
- Modify: `app/src/jobs/registerHandlers.ts`
- Test: `app/test/relayRetryLeg.test.ts`

**Interfaces:**
- Consumes: `sendOneRelayLeg`, `RelayTransportMode` (Task 3);
  `relayRetryDigest`, `relayRetryBackoffMs`, `MAX_RELAY_RETRY_ATTEMPTS` (Task 1);
  `touchLastActivityPreservingStatus` (Task 4).
- Produces:

```ts
export const RELAY_RETRY_LEG_JOB = 'relay.retryLeg';

export interface RelayRetryLegPayload {
  relayConversationId: string;
  /** The RETRY row's own key. Identifiers only - the handler re-reads. */
  retryTsMsgId: string;
}

export type RelayRetryCloseCode =
  | 'retry_group_closed' | 'retry_member_removed'
  | 'retry_number_changed' | 'retry_opted_out'
  | 'enqueue_failed' | 'transient_cap';

export interface RelayRetryLegJobDeps {
  /** D6 / Sec 7: injected so the e2e lane can shorten the ladder. Defaults to
   *  relayRetryBackoffMs. Configuration, NOT structural absence. */
  backoffMs?: (attempt: number) => number;
  /** The fan-out's transient sub-ladder backoff (fanOutBackoffMs). */
  transientBackoffMs?: (pass: number) => number;
}

export function registerRelayRetryLegJobHandler(deps?: RelayRetryLegJobDeps): void;
export async function enqueueRelayRetryLeg(
  payload: RelayRetryLegPayload, attempt: number,
  deps?: Pick<RelayRetryLegJobDeps, 'backoffMs'>,
): Promise<void>;
```

The payload carries IDENTIFIERS ONLY - never the body, never a phone. The handler
re-reads the retry row, which is where D12 put the raw body and the leg copy.

- [ ] **Step 1: Write the failing duplicate-delivery test**

```ts
// D4: the create defeats duplicate CALLBACKS; only a job-execution marker
// defeats duplicate DELIVERIES. relayFanOut.ts:732-744 and retrySend.ts:129-146
// are the shape - retrySend's comment spells out the stake: it "would TEXT THE
// HUMAN AGAIN".
it('sends nothing on a redelivered job', async () => {
  await runHandler(payload);
  sendSpy.mockClear();
  await runHandler(payload);
  expect(sendSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Write the failing gate tests**

```ts
// D9. Each gate refuses, sends nothing, ends the chain, and writes its OWN code.
it.each([
  ['closed group',   () => closeGroup(),        'retry_group_closed'],
  ['removed member', () => removeMember(),      'retry_member_removed'],
  ['changed number', () => changeMemberPhone(), 'retry_number_changed'],
  ['opted out',      () => suppressMember(),    'retry_opted_out'],
])('refuses on %s and closes with %s', async (_name, arrange, code) => {
  await arrange();
  await runHandler(payload);
  expect(sendSpy).not.toHaveBeenCalled();
  const row = await messages.getByTsMsgId(conversationId, retryTsMsgId);
  expect(row?.delivery_recipients?.[memberKey]).toMatchObject({
    status: 'failed', errorCode: code,
  });
  expect(enqueueSpy).not.toHaveBeenCalled();
  expect(errorLogs()).toContainEqual(
    expect.objectContaining({ retryClaim: 'gate_refused' }));
});

// D5 + D9: the destination digest exists for exactly this. A member whose phone
// changed must never silently receive an old message at the new number.
it('compares the DIGEST, not the current phone, on the changed-number gate', async () => {
  await changeMemberPhone('+15558675399');
  await runHandler(payload);
  expect(sendSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Write the failing send, bump and ladder tests**

```ts
it('sends exactly one leg to the failed member', async () => {
  await runHandler(payload);
  expect(sendSpy).toHaveBeenCalledTimes(1);
  expect(sendSpy.mock.calls[0][0]).toMatchObject({ to: memberPhone });
});

// D16: the bump must be the STATUS-PRESERVING one. A call count cannot tell the
// two apart, so assert the group stays closed - the actual hazard.
it('bumps a closed group without reopening it', async () => {
  await closeGroupAfterClaim();          // closed during the backoff window
  await runHandlerWithGatesStubbedOpen();
  expect(await statusOf(conversationId)).toBe('closed');
  expect(touchLastActivitySpy).not.toHaveBeenCalled();
});

// D12 + review finding 11: the bump previews the RAW body. Passing the leg copy
// would rewrite the inbox row to "Sam: ..." for a message already previewed raw.
it('previews the raw body, not the composed leg copy', async () => {
  await runHandler(payload);
  expect(bumpSpy.mock.calls[0][1]).toBe('the original text');
});

// D12: the LEG carries the composed copy, sent verbatim even after a rename.
it('sends the stored leg copy verbatim after a sender rename', async () => {
  await renameSender('Samantha');
  await runHandler(payload);
  expect(sendSpy.mock.calls[0][0].body).toBe('Sam: the original text');
});

// D13
it('re-presigns attachments on every attempt', async () => {
  await runHandler(payload);
  expect(presignSpy).toHaveBeenCalledTimes(1);
});

// D2: the transport MODE mirrors the ORIGINAL. Every relay source written before
// 2026-09-02 is legacy, so this is the ordinary case for an old message - and
// getting it wrong throws at relayFanOut.ts:1436-1439 on the first send.
it('drives a legacy retry row down the legacy path', async () => {
  await seedLegacyRetryRow();
  await runHandler(payload);
  expect(sendOneRelayLegSpy.mock.calls[0][0].transport).toMatchObject({ kind: 'legacy' });
});

it('drives a versioned retry row down the versioned path', async () => {
  await seedVersionedRetryRow();
  await runHandler(payload);
  expect(sendOneRelayLegSpy.mock.calls[0][0].transport).toMatchObject({ kind: 'versioned' });
});

// D10: a transient send error re-enqueues the SAME rung and consumes no retry
// rung. Ending the chain on a 429 would be the wrong answer for the one code
// that most means "try again".
it('re-enqueues the same rung on a transient send error', async () => {
  sendOneRelayLegSpy.mockResolvedValueOnce({ kind: 'transient', errorCode: '429' });
  await runHandler(payload);
  expect(enqueueSpy).toHaveBeenCalledWith(
    RELAY_RETRY_LEG_JOB, expect.objectContaining({ retryTsMsgId }), expect.anything());
  const row = await messages.getByTsMsgId(conversationId, retryTsMsgId);
  expect(row?.relay_retry_attempt).toBe(1);
});

it('closes with transient_cap when the retry row pass budget caps', async () => {
  await exhaustFanoutPasses(retryTsMsgId);   // claimFanoutPass on the RETRY row
  sendOneRelayLegSpy.mockResolvedValueOnce({ kind: 'transient', errorCode: '429' });
  await runHandler(payload);
  expect(slotOf(retryTsMsgId)).toMatchObject({
    status: 'failed', errorCode: 'transient_cap' });
  expect(errorLogs()).toContainEqual(
    expect.objectContaining({ retryClaim: 'cap_exhausted' }));
});
```

Every helper above maps onto an existing harness, and these mappings were
verified: `runHandler` follows `app/test/relayFanOut.test.ts` `dispatchJob`
invocation; `slotOf` and `exhaustFanoutPasses` follow the same file
`claimFanoutPass` usage; the log collector is `createLogCapture()` as used at
`app/test/twilioStatusWebhook.test.ts:861`, which KEEPS the returned handle - the
call sites in `relayWebhook.test.ts` (`:85`, `:345`, `:678`) discard it and are
the wrong ones to copy.

**Mocking boundary.** `sendSpy` is the ADAPTER, so `sendOneRelayLeg` runs for
real and writes the slot and the `relaysid#` pointer. `sendOneRelayLegSpy` mocks
the MODULE, so neither write happens. Use the adapter spy for the gate, bump and
send tests; use the module spy only for the transient-outcome tests, which need
an outcome the adapter cannot produce on demand.

- [ ] **Step 4: Run them and watch them fail**

Run: `cd app; npx vitest run test/relayRetryLeg.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 5: Implement the handler**

The order is load-bearing and each line answers a review finding:

1. `putJobExecutionMarker(getContext()?.jobId, conversationId)` - return early if
   it has already run (D4).
2. Re-read the RETRY row. `relay_retry_of` always names the root, but the job
   needs it only as a STRING for the digest - do NOT require the root ROW to be
   readable, which would add a close path for a row nothing else needs.
3. Resolve the transport MODE from the RETRY ROW ITSELF. It was seeded to mirror
   the root at creation time (D2, Task 1), and `sendOneRelayLeg` writes THIS row,
   whose own schema is what `applyRecipientSendResult` checks
   (`messagesRepo.ts:3240`).

   **The mode is not just a flag.** `RelayTransportMode`'s versioned arm carries a
   `MessageTransportIntent` (`relayFanOut.ts:957-959`) that the fan-out COMPUTES
   via `adapter.classifyMessageTransport` (`:974-978`) and never stores - and
   `row.requested_transport` is undefined on an inbound retry row by D2, so
   reading it is not the answer either. The retry job classifies afresh from the
   retry row's own type and media, exactly as the fan-out does for a source.
4. Gates in order: group still open; member still on the roster;
   `relayRetryDigest(rootTsMsgId, member.phone)` still equals
   `row.relay_retry_dest_digest`; member not suppressed (`isMemberSuppressed`,
   `relayAnnouncements.ts:64`). Any refusal writes its close code, logs ERROR
   with `retryClaim: 'gate_refused'`, and RETURNS (D9, D23).
5. `sendOneRelayLeg(...)` with `row.relay_retry_leg_body` and freshly presigned
   media. **It writes the slot and the `relaysid#` pointer itself** - do not
   write either again here.
6. Branch on the outcome:
   - `sent` - `touchLastActivityPreservingStatus(conversationId, row.body, now)`
     (D16: raw body, status preserved). No push, no unread change.
   - `transient` - `claimFanoutPass` on the RETRY row. `claimed` re-enqueues the
     SAME rung at `transientBackoffMs(claim.attempt)`; `capped` closes
     `transient_cap` and logs the terminal ERROR (D10).
   - `refused` / `filtered` / `suppressed` - close with the matching code, log
     ERROR, stop.
7. Register in `registerHandlers.ts` beside the relay registrar.

- [ ] **Step 6: Run and watch them pass**

Run: `cd app; npx vitest run test/relayRetryLeg.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src/jobs/relayRetryLeg.ts app/src/jobs/registerHandlers.ts app/test/relayRetryLeg.test.ts
git commit -m "feat(relay): the 30003 retry job - gates, ladder and terminal closes"
```

---

## Task 12: The claim in the status webhook

**Files:**
- Modify: `app/src/routes/webhooks/twilio.ts` (inside
  `handleRelayRecipientStatus` `:2442-2561`, plus ONE condition at the
  `flagPlacementAttention` call site `:2526` - the function itself is unchanged)
- Test: `app/test/relayWebhook.test.ts`, `app/test/twilioStatusWebhook.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2 and 11.
- Produces: no new exports.

- [ ] **Step 1: Write the failing claim tests**

```ts
// D8. The gate is the SLOT'S POST-WRITE STATE plus THIS callback's code - never
// whether this callback transitioned the slot. Read D8 before editing: a
// transition gate is unreachable-by-justification AND makes a crash between the
// slot write and the claim permanently unrecoverable.
it('claims exactly one retry for a forward 30003 on a fan-out leg', async () => {
  await postStatus({ MessageSid: legSid, MessageStatus: 'undelivered',
    ErrorCode: '30003', To: memberPhone });
  const retries = retryRows();
  expect(retries).toHaveLength(1);
  expect(retries[0].relay_retry_attempt).toBe(1);
  expect(retries[0].relay_retry_origin_direction).toBe('outbound');
  expect(enqueueSpy).toHaveBeenCalledTimes(1);
});

// Sec 7 intention 11, server half: the ONE field that would delete the original
// bubble (Timeline.tsx:1787-1799 hides the PREDECESSOR).
it('never stamps retry_of on the retry row', async () => {
  await postStatus(failure);
  expect(retryRows()[0].retry_of).toBeUndefined();
});

// Rungs 2 and 3 chain to the ROOT, not to the previous rung.
it('points every rung at the root message', async () => {
  await postFailureForLatestAttempt();
  await postFailureForLatestAttempt();
  expect(retryRows().map((r) => r.relay_retry_of))
    .toEqual([rootTsMsgId, rootTsMsgId, rootTsMsgId]);
});

it('claims nothing twice for a duplicate callback', async () => {
  await postStatus(failure);
  await postStatus(failure);
  expect(retryRows()).toHaveLength(1);
  expect(enqueueSpy).toHaveBeenCalledTimes(1);
});

// D8, and this is the test a transition gate FAILS - it is why the gate reads
// state. Simulate the crash by writing the slot, then replaying the callback.
it('RECOVERS a claim lost to a crash between the slot write and the claim', async () => {
  await writeSlotTerminal(memberKey, { status: 'undelivered', errorCode: '30003' });
  await postStatus(failure);
  expect(retryRows()).toHaveLength(1);
});

// D8: reachable - `canceled` maps to failed with NO code
// (adapters/messaging.ts:567-569), which blocks the 30003 from reaching the slot.
it('claims when a code-less terminal callback landed first', async () => {
  await postStatus({ ...failure, MessageStatus: 'canceled', ErrorCode: undefined });
  await postStatus(failure);
  expect(retryRows()).toHaveLength(1);
});

it('claims nothing when the slot already reads a different terminal code', async () => {
  await writeSlotTerminal(memberKey, { status: 'failed', errorCode: '30007' });
  await postStatus(failure);
  expect(retryRows()).toHaveLength(0);
});

// D7. The fence is POSITIVE - a negative one passes on an unreadable source and
// reaches the tour-reminder ladder.
it('claims nothing for an announcement leg', async () => {
  await postStatus({ ...failure, MessageSid: announcementLegSid });
  expect(retryRows()).toHaveLength(0);
  expect(warnLogs()).toContainEqual(
    expect.objectContaining({ retryClaim: 'fenced_announcement' }));
});

it('claims nothing when the source row cannot be read, with its own message', async () => {
  consistentReadSpy.mockResolvedValueOnce(undefined);
  await postStatus(failure);
  expect(retryRows()).toHaveLength(0);
  const line = errorLogs().find((l) => l.retryClaim === 'source_unreadable');
  expect(line).toBeDefined();
  expect(line.msg).not.toBe('twilio relay-recipient delivery failed (undelivered/failed)');
});

// D5
it.each([[undefined, 'to_missing'], ['not-a-number', 'to_malformed']])(
  'claims nothing for To=%s', async (to, expected) => {
    await postStatus({ ...failure, To: to });
    expect(retryRows()).toHaveLength(0);
    expect(errorLogs()).toContainEqual(expect.objectContaining({ retryClaim: expected }));
  });

it('stops at the cap', async () => {
  for (let i = 0; i < 5; i += 1) await postFailureForLatestAttempt();
  expect(retryRows()).toHaveLength(3);
});

// Sec 7 intention 7, on EVERY rung. The e2e proves rung 1 in a browser; only a
// unit test can walk the whole ladder, and "no duplicate send" is the criterion
// a green chip cannot establish.
it('never sends to any other member, on any rung', async () => {
  for (let i = 0; i < 5; i += 1) await postFailureForLatestAttempt();
  const others = sendSpy.mock.calls.filter((c) => c[0].to !== memberPhone);
  expect(others).toHaveLength(0);
  expect(sendSpy.mock.calls.filter((c) => c[0].to === memberPhone)).toHaveLength(3);
});

// D14: Sec 7 intention 6. The enqueue lives HERE, so its failure closes here.
it('closes the retry leg enqueue_failed when the enqueue throws', async () => {
  enqueueSpy.mockRejectedValueOnce(new Error('queue down'));
  await postStatus(failure);
  expect(slotOf(retryRows()[0].tsMsgId)).toMatchObject({
    status: 'failed', errorCode: 'enqueue_failed' });
  expect(errorLogs()).toContainEqual(
    expect.objectContaining({ retryClaim: 'enqueue_failed' }));
});

// D16: without this the chip reads "1 failed" for the whole first backoff.
it('emits message.persisted when the claim lands', async () => {
  await postStatus(failure);
  expect(emitSpy).toHaveBeenCalledWith('message.persisted',
    expect.objectContaining({ tsMsgId: rootTsMsgId }));
});

// flagPlacementAttention (:2522-2528) escalates to a human on a failed leg. Two
// wrong answers were considered and rejected before this one.
//
// DEFERRING it until the chain is terminal would DELETE the escalation for three
// of the four terminal outcomes: gate refusal, enqueue failure and transient cap
// all end inside the JOB with no further callback, and the function is a closure
// inside `createTwilioWebhookRouter` (:412) that the job cannot reach.
//
// Leaving it ENTIRELY alone is not "unchanged behavior" either, which is the
// trap: every rung's callback re-enters this same handler, so a three-rung ladder
// escalates FOUR times. Each call rewrites `attention.at` with a fresh timestamp
// (:420), re-emits `placement.updated` (:427) and logs another
// `placement_escalation` (:428) - so the triage clock a human reads resets at
// +60s, +180s and +420s, and the leg looks newly-failed each time.
//
// So: escalate on the ROOT's callback only. Exactly one escalation per failed
// leg, at the same moment as today, and no clock resets.
it('escalates once on the first 30003, exactly as today', async () => {
  await postStatus(failure);
  expect(flagPlacementAttentionSpy).toHaveBeenCalledTimes(1);
});

// The regression this exists to prevent. One callback cannot see it - the whole
// ladder must run.
it('does not re-escalate on any rung of the ladder', async () => {
  for (let i = 0; i < 5; i += 1) await postFailureForLatestAttempt();
  expect(flagPlacementAttentionSpy).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd app; npx vitest run test/relayWebhook.test.ts -t claim`
Expected: FAIL - no retry rows are ever created.

- [ ] **Step 3: Implement the claim**

Inside `handleRelayRecipientStatus`, after the existing slot write and before the
`return`:

1. Skip unless `ErrorCode === '30003'` and `mapped` is a failure.
2. `getByTsMsgIdConsistent` (Task 2) for the source. Absent - log
   `retryClaim: 'source_unreadable'` with its OWN message, and return (D7, D23).
3. Fence: `source.relay_sender_key` present AND not `SYSTEM_SENDER_KEY`; else
   `retryClaim: 'fenced_announcement'`.
4. Validate `params['To']` as E164 - `to_missing` / `to_malformed`.
5. Slot check: terminal, and its `errorCode` is `30003` or absent.
6. Attempt arithmetic: `source.relay_retry_attempt ?? 0`, next = +1, capped at
   `MAX_RELAY_RETRY_ATTEMPTS` - else `cap_exhausted`. **The ROOT is
   `source.relay_retry_of ?? source.tsMsgId`**, so every rung points at the root.
7. `append` the retry row, mirroring `direction`, `author`, `relay_sender_key`,
   `type` and the transport MODE from the ROOT (D2), storing the six lineage
   values, the raw body, the leg copy and the mode-appropriate seeded slot.
   `deduped: true` means another callback won - claim nothing further.
8. `enqueueRelayRetryLeg`. On throw, close the retry leg `enqueue_failed` and log
   the terminal ERROR (D14).
9. Emit `message.persisted` for the ROOT (D16).
10. Skip `flagPlacementAttention` (`:2526`) when the source row is itself a retry
    row (`relay_retry_of !== undefined`). The root's own callback still escalates
    at exactly the moment it does today; the rungs no longer reset the triage
    clock. See the two tests above for why neither deferring it nor leaving it
    untouched is correct.

- [ ] **Step 4: Run and watch them pass**

Run: `cd app; npx vitest run test/relayWebhook.test.ts test/twilioStatusWebhook.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/webhooks/twilio.ts app/test/relayWebhook.test.ts
git commit -m "feat(relay): claim a 30003 retry from the relay status callback"
```

---

## Task 13: The severity taxonomy and the retryClaim cause field

**Files:**
- Modify: `app/src/routes/webhooks/twilio.ts` (`:294-314`, the relay failure log
  `:2500-2511`)
- Test: `app/test/twilioStatusWebhook.test.ts`

This closes `relay-30003-classified-transient-retrying`.

- [ ] **Step 1: Write the failing tests**

```ts
// Each case gets a FRESH log collector - a shared one makes
// `expect(errorLogs()).toHaveLength(0)` order-dependent.
beforeEach(() => resetLogCollector());

// D23
it('logs WARN while a retry is claimed and ERROR once terminal', async () => {
  await postStatus(failure);
  expect(warnLogs()).toContainEqual(expect.objectContaining({ retryClaim: 'claimed' }));
  await exhaustLadder();
  expect(errorLogs()).toContainEqual(
    expect.objectContaining({ retryClaim: 'cap_exhausted' }));
});

// D23: the 21610 carve-out survives. A purely attempt-aware predicate would
// alarm on the platform correctly honoring STOP.
it('keeps 21610 at WARN on a relay leg', async () => {
  await postStatus({ ...failure, ErrorCode: '21610' });
  expect(errorLogs()).toHaveLength(0);
});

// D23: announcement legs keep WARN - alarming a tour rung is out of scope.
it('keeps an announcement leg at WARN', async () => {
  await postStatus({ ...failure, MessageSid: announcementLegSid });
  expect(errorLogs()).toHaveLength(0);
});

// The 1:1 and native group-text paths are FENCED and must not move.
it('leaves the 1:1 and group-text severity unchanged', async () => {
  await postDirectStatus({ ErrorCode: '30003' });
  expect(errorLogs()).toHaveLength(0);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd app; npx vitest run test/twilioStatusWebhook.test.ts -t severity`
Expected: FAIL - every relay 30003 is WARN today and no line carries `retryClaim`.

- [ ] **Step 3: Implement**

Give the relay branch its own predicate rather than editing the shared set. Add
`retryClaim` to the existing failure object (`:2501-2510`). Then rewrite the
shared set's comment so it stops asserting something the repo has disproven for
group text (`sendMessage.ts:294-297` - a group-text 30003 retry is enqueued and
never sends), naming the exception and pointing at
`group-text-30003-leg-retry-promise-unverified`.

- [ ] **Step 4: Run and watch them pass**

Run: `cd app; npx vitest run test/twilioStatusWebhook.test.ts test/relayWebhook.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/webhooks/twilio.ts app/test/twilioStatusWebhook.test.ts
git commit -m "fix(relay): attempt-aware severity and a retryClaim cause on every failure line"
```

---

## Task 14: The hermetic browser proof

**Files:**
- Rename: `e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts` ->
  `e2e/tests/dashboard-next/relay-30003-retry.spec.ts` (`git mv`)
- Modify: `app/src/jobs/registerHandlers.ts` (the backoff override read), the e2e
  lane env
- Test: the spec itself

**Use `git mv`.** Staging only the new path under a no-`git add -A` rule leaves
the old file tracked and running, with positive assertions the new copy
contradicts - gate 4 goes red on the branch's own leftover.

**The backoff seam is WORKER-side, not `dev.ts`.** The retry job runs in the
separately spawned worker (`scripts/e2e-session.mjs:381`); `app/src/routes/dev.ts`
is app-side and cannot reach it. Read `E2E_RELAY_RETRY_BACKOFF_MS` at handler
registration and pass it as `deps.backoffMs`. **This is configuration, not
structural absence** - the spec says so plainly; production keeps 60/120/240.

- [ ] **Step 1: Add the backoff seam**

```ts
// registerHandlers.ts - the lane shortens the ladder so a browser test does not
// wait 60s for rung 1. Ignored unless the value parses to a positive integer, so
// a stray env var cannot silently shorten a real ladder.
const override = Number.parseInt(process.env['E2E_RELAY_RETRY_BACKOFF_MS'] ?? '', 10);
registerRelayRetryLegJobHandler(
  Number.isInteger(override) && override > 0 ? { backoffMs: () => override } : undefined,
);
```

Unit-assert both arms in `app/test/relayRetryLeg.test.ts`: an absent or malformed
value leaves 60/120/240 intact.

- [ ] **Step 2: Rename and update the spec**

Keep its `createGroupOpen` arrangement and its intro-settle barriers verbatim -
they are load-bearing and hard-won. Keep every `not.toContainText('will retry')`.

**The existing file uses `page.getByText(token)` as a SINGLE element** for
`toBeVisible`, `xpath=..` and `.click()`. Asserting a count of 2 on that same
locator throws under strict mode, so the updated spec needs distinct locators:

```ts
const bubbles = page.getByText(token);          // the COUNT locator
const original = bubbles.first();                // the one we click into
const originalBubble = original.locator('xpath=..');
const rollup = originalBubble.getByRole('img');

// 1. The chip goes retrying WITHOUT waiting a backoff interval (D16's SSE).
await expect(rollup).toContainText('1 retrying', { timeout: 30_000 });
await expect(rollup).not.toContainText('will retry');

// 2. The retry lands and the ORIGINAL becomes truthful.
await expect(rollup).toContainText('delivered 2/2 - 1 on retry', { timeout: 60_000 });

// 3. A SECOND bubble, addressed to the one member.
await expect(bubbles).toHaveCount(2);

// 4. All three positions agree (D21).
await expect(rollup).toHaveAccessibleName(
  new RegExp(`${unreachable.name}: Delivered on retry`));
await original.click();
await expect(failedRow).toContainText('Delivered on retry');

// 5. NO DUPLICATE SEND. The reachable member got the body exactly once - this is
// acceptance criterion 4, and the one a green chip cannot prove.
const reachableMsgs = await getOutboundTo(request, { to: reachable.phone });
expect(reachableMsgs.filter((m) => (m.body ?? '').includes(token))).toHaveLength(1);
```

The fake's delivery arming is ONE-SHOT per destination number
(`fixtures/fakeTwilio.ts`), so arming one failure is the whole setup: the retry
lands clean as the NEXT message to that handset.

- [ ] **Step 3: Run it**

Run, from the e2e workspace: `npm run e2e -- --grep "relay leg"`

`--grep` matches the TEST TITLE, not the filename, so grep a phrase from the
title. Never run Playwright from the repo root - a stray invocation can target
the human's live lane.

- [ ] **Step 4: Commit**

```bash
git add e2e/tests/dashboard-next/relay-30003-retry.spec.ts app/src/jobs/registerHandlers.ts app/test/relayRetryLeg.test.ts
git rm e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts
git commit -m "test(e2e): prove one failed relay leg retries to delivered without duplicating"
```

---

## Task 15: Close the issues

**Files:**
- Modify: `docs/issues/relay-30003-retry-lineage.md`,
  `docs/issues/relay-30003-classified-transient-retrying.md`,
  `docs/issues/quiet-hours-ungated-automated-paths.md`

- [ ] **Step 1: Stamp both closed issues**

`status: resolved`, `resolved: 2026-09-02`, and a `**Resolution (2026-09-02).**`
paragraph naming what shipped and where. Walk all NINE acceptance criteria of the
lineage issue and name the task that proves each.

- [ ] **Step 2: Annotate, do NOT close, the quiet-hours decision**

Relay retries now exist and inherit its item-3 recommendation unchanged (the
~7-minute bound). The decision itself stays open.

- [ ] **Step 3: Confirm the two filed issues still read true**

`relay-member-key-collapses-two-phones-one-contact` and
`relay-inbound-source-has-no-delivery-rollup` are already filed and stay OPEN by
the founder's ruling. Do not re-file them. Check that the first one's recorded
workarounds still describe what actually shipped, and that the second names all
three hosts.

- [ ] **Step 4: Regenerate the index and commit**

```bash
npm run issues
git add docs/issues/
git commit -m "docs(issues): close the relay 30003 retry lineage pair"
```

---

## Self-Review

**Spec coverage.** D1-D3 -> Tasks 1, 12. D4 -> Task 11. D5 -> Tasks 1, 11, 12.
D6 -> Tasks 1, 14. D7-D8 -> Tasks 2, 12. D9 -> Task 11. D10 -> Tasks 3, 11.
D11 -> Tasks 1, 5. D12 -> Tasks 1, 11. D13 -> Tasks 1, 11. D14 -> Task 12 (the
enqueue lives there, so its failure closes there). D15 -> Task 8. D16 -> Tasks 4,
11, 12. D17 -> Task 5. D18 -> Tasks 6, 9. D19 -> Tasks 6, 8, 9. D20 -> Task 7.
D21-D22 -> Tasks 7, 9. D23 -> Tasks 12, 13.

All twenty Sec 7 intentions have a named step, including the five the plan
reviews found missing or thin: 6 (enqueue failure, Task 12), 7 (no duplicate send
on EVERY rung, Task 12), 11's server half (no `retry_of`, Task 12), 18 (legacy
mirroring, Tasks 1 and 11), and 19 (`retryClaim` values, Tasks 12 and 13).
Sec 8's four obligations are Task 15.

**Placeholders.** None. The two tasks with no new production code - Task 3
(behavior-preserving extraction) and Task 10 (host verification) - say so
explicitly and state what their deliverable is instead.

**Type consistency.** `RelayRetryState`, `RelayRetryRow` and `EffectiveRelayLeg`
are defined once in Task 6 and consumed by name in Tasks 8 and 9.
`EffectiveRelayLeg` EXTENDS `RelayDeliverySlot`, so every existing presenter
caller keeps compiling. `RelayLegSendOutcome` and the re-exported
`RelayTransportMode` are defined in Task 3 and consumed in Task 11. The six stored
lineage names are fixed in Task 1; Task 5 projects four and names the two it
withholds.

**Ordering.** Tasks 1-4 (server groundwork, no behavior change) and Tasks 5-10
(the whole display) are independent and may run in parallel. **Every display task
lands before Task 12** - the claim. Round 1 found the filter arriving five tasks
after the rows it filters; round 2 found that moving only the filter relocated the
incoherent window instead of closing it, since a delivered retry would render
`Delivered 1/1` beside an original still reading `1 failed`. Both are closed by
putting the entire display first.

Between any two commits the PRODUCT is coherent, and now for a reason that does
not depend on reading the task list carefully: **before Task 12 no retry row
exists anywhere**, so every display task is provably inert - its tests construct
rows by hand, and production has none to render.

The BRANCH is a different matter and the claim does not extend to it: the pinning
e2e still asserts `delivered 1/2 - 1 failed` until Task 14 renames and rewrites
it, so gate 4 is red from Task 8 until then. That is not fixable by ordering - the
spec it pins and the presenter it tests cannot both be right mid-branch - so run
gate 4 at Task 14 and at the end, not between.
