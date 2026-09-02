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

## Global Constraints

- **Gates, run bare from the worktree** (`W:\tmp\relay-30003-retry-lineage`):
  `npm run typecheck`, `npm test`, `npm run smoke`, `npm run e2e`, then
  `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx')`.
  Never pipe a gate command.
- **ASCII only** on every new or touched line - specs, tests, comments, log
  strings, seed strings, copy.
- **Commit explicit paths only.** Never `git add -A`. Read bare `git status`
  before every commit. Add
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **`npm test` needs DynamoDB Local** (`npm run db:start`).
- **Vendor SDK imports belong in `app/src/adapters`.** Services and jobs depend on
  interfaces.
- **All job traffic goes through `jobs.enqueue()` / `defineJobHandler()`** so
  correlation and trace context survive.
- **PII: phones are DATA, never log lines.** Use `logSafeMemberKey`
  (`app/src/services/relayAnnouncements.ts:152-161`) for anything member-shaped in
  a log. No phone number may enter a sort key.
- **Retry ladder constants:** 3 attempts, backoff 60s / 120s / 240s, matching
  `app/src/jobs/retrySend.ts:37,39-42`.
- **The trigger code is 30003 and only 30003.**
- **Hard fences - do not edit:** `app/src/services/relayAnnouncements.ts`
  behavior, `app/src/jobs/tourReminders.ts`, native group-text receipt behavior,
  the existing 1:1 retry/collapse path, `stalenessClockMs`, `ALLOWED_PRIOR`, and
  the rollup chip's `outbound` gate.

---

## File Structure

**Server - new**

- `app/src/jobs/relayRetryLeg.ts` - the retry job: payload, handler, gates,
  close codes, transient sub-ladder, backoff injection. One responsibility: turn
  a claimed retry row into one send or one truthful terminal state.
- `app/src/lib/relayRetryClaim.ts` - pure helpers: the digest, the provider-SID
  shape, the attempt arithmetic. Pure so the webhook and the job cannot disagree
  about identity, and so it is testable without DynamoDB.

**Server - modified**

- `app/src/repos/messagesRepo.ts` - five lineage fields on `MessageItem` and
  `NewMessage`; media-pointer suppression for retry rows; a consistent source
  read reachable from the webhook.
- `app/src/jobs/relayFanOut.ts` - extract the per-leg send body into an exported
  unit both the fan-out and the retry job call.
- `app/src/routes/webhooks/twilio.ts` - the claim inside
  `handleRelayRecipientStatus`, the SSE on claim, the `retryClaim` log field, the
  relay severity predicate.
- `app/src/repos/conversationsRepo.ts` - a status-preserving activity bump.
- `app/src/jobs/registerHandlers.ts` - register the new job.
- `app/src/routes/dev.ts` - the lane-local backoff override seam.

**Dashboard - modified**

- `dashboard/src/api/types.ts` - four wire fields on `TimelineMessage`.
- `dashboard/src/routes/conversation/useRelayThread.ts` - project them.
- `dashboard/src/lib/messageTransport.ts` - the funnel every projected entry
  passes through.
- `dashboard/src/routes/contact/relayRetryJoin.ts` - **new.** The thread-level
  join: retry rows in, effective `{status, errorCode, retryState}` per member key
  out. A separate file because it is pure, it is the heart of the display
  contract, and both `Timeline.tsx` and its tests need it without pulling in a
  4000-line component.
- `dashboard/src/routes/contact/deliveryStatus.ts` - the arithmetic, the
  composition, the new copy, the internal close codes.
- `dashboard/src/routes/contact/Timeline.tsx` - entries with keys, sibling
  plumbing, the four render positions, the `visible` filter, the ticker clause.
- `dashboard/src/routes/conversation/ConversationDetail.tsx`,
  `dashboard/src/routes/tours/TourConversation.tsx`,
  `dashboard/src/routes/placements/PlacementConversation.tsx` - all three relay
  Timeline hosts.

**E2E**

- `e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts` - UPDATED, never
  deleted. It is the checklist for the new copy.

---

## Task 1: Lineage fields and the retry-row append shape

**Files:**
- Modify: `app/src/repos/messagesRepo.ts` (`MessageItem` ~`:872-1000`,
  `NewMessage` ~`:640-1040`, `append` ~`:2100-2300`,
  `assertTransportPersistenceShape` `:895-940`, media pointers `:2286-2290`)
- Create: `app/src/lib/relayRetryClaim.ts`
- Test: `app/test/relayRetryClaim.test.ts`,
  `app/test/messagesRepoRetryLineage.integration.test.ts`

**Interfaces:**
- Produces:
  - `relayRetryDigest(rootTsMsgId: string, destinationE164: string): string` -
    first 16 hex chars of SHA-256 of `` `${rootTsMsgId}|${destinationE164}` ``.
  - `relayRetryProviderSid(digest: string, attempt: number): string` -
    `` `relayretry-${digest}-${attempt}` ``.
  - `MAX_RELAY_RETRY_ATTEMPTS = 3`, `relayRetryBackoffMs(attempt: number): number`
    (60000 * 2 ** (attempt - 1)).
  - `NewMessage` gains optional
    `relayRetryOf?: string`, `relayRetryMemberKey?: string`,
    `relayRetryAttempt?: number`, `relayRetryDestDigest?: string`,
    `relayRetryOriginDirection?: 'inbound' | 'outbound'`.
  - `MessageItem` gains the snake_case twins `relay_retry_of`,
    `relay_retry_member_key`, `relay_retry_attempt`, `relay_retry_dest_digest`,
    `relay_retry_origin_direction`.

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

/** Total retry attempts for one failed relay leg. Matches the 1:1 ladder
 *  (`jobs/retrySend.ts:37`) - spec D6. */
export const MAX_RELAY_RETRY_ATTEMPTS = 3;

/** 60s, 120s, 240s for attempts 1..3 - the 1:1 shape (`retrySend.ts:39-42`). */
export function relayRetryBackoffMs(attempt: number): number {
  return 60_000 * 2 ** (attempt - 1);
}

/** The ladder's identity: root message + DESTINATION handset (spec D5 - the
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

```ts
// app/test/messagesRepoRetryLineage.integration.test.ts (shape - follow the
// existing integration harness in app/test/messagesRepo*.integration.test.ts
// for table setup and teardown)

it('round-trips the five lineage values', async () => {
  const res = await messages.append({
    conversationId, providerSid: 'relayretry-abc0123456789def-1',
    providerTs: new Date().toISOString(), type: 'sms', direction: 'outbound',
    author: 'teammate', deliveryStatus: 'queued', body: 'hello',
    relayRetryOf: rootTsMsgId, relayRetryMemberKey: 'contact-1',
    relayRetryAttempt: 1, relayRetryDestDigest: 'abc0123456789def',
    relayRetryOriginDirection: 'outbound',
    deliveryRecipients: { 'contact-1': { status: 'queued' } },
  });
  const row = await messages.getByTsMsgId(conversationId, res.tsMsgId);
  expect(row?.relay_retry_of).toBe(rootTsMsgId);
  expect(row?.relay_retry_attempt).toBe(1);
  expect(row?.relay_retry_origin_direction).toBe('outbound');
});

// D3: the claim. A repeat of the SAME provider SID must DEDUPE, not throw -
// `append` attributes a dedupe to the sid pointer at index 1
// (messagesRepo.ts:2295-2306) and rethrows anything else (:2374-2388).
it('reports a duplicate provider SID as deduped, pointing at the winner', async () => {
  const sid = 'relayretry-abc0123456789def-1';
  const first = await messages.append({ ...base, providerSid: sid });
  const second = await messages.append({ ...base, providerSid: sid,
    providerTs: new Date(Date.now() + 5_000).toISOString() });
  expect(second.deduped).toBe(true);
  expect(second.tsMsgId).toBe(first.tsMsgId);
});

// D13: the gallery index must not grow per attempt.
it('writes no media-pointer rows for a retry row', async () => {
  const res = await messages.append({ ...base, type: 'mms',
    relayRetryOf: rootTsMsgId, relayRetryAttempt: 1,
    mediaAttachments: [{ s3Key: 'unit-media/x.jpg', contentType: 'image/jpeg' }] });
  await expect(mediaPointerCount(conversationId, res.tsMsgId)).resolves.toBe(0);
  const row = await messages.getByTsMsgId(conversationId, res.tsMsgId);
  expect(row?.media_attachments?.[0]?.s3Key).toBe('unit-media/x.jpg');
});

// D2: an inbound retry row mirrors an inbound original and must not carry a
// message-level requestedTransport (messagesRepo.ts:913-915), but its SLOT may.
it('accepts an inbound retry row whose slot carries a requested transport', async () => {
  await expect(messages.append({ ...base, direction: 'inbound', author: 'tenant',
    transportSchemaVersion: 1, relayRetryOf: rootTsMsgId, relayRetryAttempt: 1,
    deliveryRecipients: { 'contact-1': { status: 'queued',
      requestedTransport: 'sms', transportAggregationState: 'planned' } },
  })).resolves.toBeDefined();
});
```

- [ ] **Step 6: Run them and watch them fail**

Run: `cd app; npx vitest run test/messagesRepoRetryLineage.integration.test.ts`
Expected: FAIL - unknown properties on `NewMessage`; media pointers written.

- [ ] **Step 7: Add the fields and the pointer suppression**

Add the five optional fields to `NewMessage` and their snake_case twins to
`MessageItem`; persist them in `append` alongside the existing
`...(message.retryOf !== undefined && { retry_of: message.retryOf })` shape at
`:2158-2161`. Then guard the media-pointer items (`:2286-2290`):

```ts
// D13: a retry row re-sends attachments it already carries, so it must NOT add
// a second gallery tile per attempt - the pointer index IS the "Media from
// comms" gallery (:211-231). The durable s3Keys still ride the row so the retry
// can re-presign from them.
const isRelayRetryRow = message.relayRetryOf !== undefined;
...(isRelayRetryRow ? [] : mediaPointerItems(...)),
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
- Modify: `app/src/repos/messagesRepo.ts` (`MessagesRepo` interface `:1339`,
  the private `getMessageConsistent` `:1885-1897`, the factory return `:2085`)
- Test: `app/test/messagesRepoRetryLineage.integration.test.ts`

**Interfaces:**
- Produces: `getByTsMsgIdConsistent(conversationId: string, tsMsgId: string): Promise<MessageItem | undefined>`
  on the `MessagesRepo` interface.

Round 3 of the design review found the blocking version of this: D7 requires the
claim path to read the source consistently, and `getMessageConsistent` is a
PRIVATE closure that is not on the interface, so the webhook cannot call it.

- [ ] **Step 1: Write the failing test**

```ts
it('exposes a consistent read on the interface', async () => {
  const res = await messages.append({ ...base });
  // The contract under test is the SIGNATURE and the ConsistentRead, not a race
  // we cannot reproduce against DynamoDB Local. A unit-level spy on the
  // GetCommand input is what proves the flag; see the sibling assertion below.
  await expect(messages.getByTsMsgIdConsistent(conversationId, res.tsMsgId))
    .resolves.toMatchObject({ tsMsgId: res.tsMsgId });
});
```

Plus, in the existing mocked-client suite (follow
`app/test/messagesRepo.transport.test.ts` for the doc-client stub shape):

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

- [ ] **Step 3: Add it to the interface and the factory**

Reuse the existing private helper rather than writing a second `GetCommand`; add
the method to the `MessagesRepo` interface and return it from the factory.
**Do not** change `getByTsMsgId` - `twilio.ts:2449` runs on every relay status
callback and only needs `requestedTransport`, so making it consistent would
double a hot-path read to fix a rare one (D7).

- [ ] **Step 4: Run and watch it pass**

Run: `cd app; npx vitest run test/messagesRepoRetryLineage.integration.test.ts test/messagesRepo.transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/repos/messagesRepo.ts app/test/messagesRepoRetryLineage.integration.test.ts
git commit -m "feat(relay): expose a consistent message read for the retry claim path"
```

---

## Task 3: Extract the per-leg send unit

**Files:**
- Modify: `app/src/jobs/relayFanOut.ts` (the loop body `:1118-1269`)
- Test: existing `app/test/relayFanOut.test.ts` and
  `app/test/relayAnnouncements.test.ts` are the proof - this task adds no new
  behavior.

**Interfaces:**
- Produces:

```ts
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

**This is a behavior-preserving extraction.** D10 chose it over reusing
`relay.fanOut` with a one-member list, which would have needed four behavior
changes inside the hottest relay path. Move the body of the `for (const member of
recipients)` loop verbatim into the exported function; the loop becomes a call.
Keep `continue` semantics by mapping them onto `RelayLegSendOutcome.kind`.

The transient arm keeps writing the slot `queued` with its code and returns
`kind: 'transient'`; the fan-out's caller pushes onto `transientRemaining` exactly
as before. The retry job (Task 5) reads that same outcome and does something
different with it - that is the whole reason the outcome is a value rather than a
side effect.

- [ ] **Step 1: Establish the green baseline**

Run: `cd app; npx vitest run test/relayFanOut.test.ts test/relayAnnouncements.test.ts test/relayWebhook.test.ts test/relayApi.test.ts`
Expected: PASS. **Record the counts.** They must be identical after the move; a
changed count means the extraction changed behavior.

- [ ] **Step 2: Extract, without changing a line of logic**

Cut `:1118-1269`'s body into `sendOneRelayLeg`. The only permitted edits are
mechanical: parameters instead of closure captures, `return` instead of
`continue`, and the `payload`-derived arguments (`payload.relayConversationId`,
`payload.sourceTsMsgId`) becoming explicit.

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
- Test: `app/test/conversationsRepo.integration.test.ts` (follow the existing
  file's harness)

**Interfaces:**
- Produces: `touchLastActivityPreservingStatus(conversationId: string, preview: string | undefined, at: string): Promise<ConversationItem | undefined>`

D16: the retry's inbox bump must never write `status`. `touchLastActivity` sets
`status = 'open'` on any non-group-text conversation, and the bump runs 60-240
seconds after the open-group gate - so a group closed during the backoff would be
resurrected by its own retry.

- [ ] **Step 1: Write the failing test**

```ts
it('bumps activity without reopening a closed relay group', async () => {
  await conversations.setRelayStatus(conversationId, 'closed');
  const before = await conversations.getById(conversationId);
  await conversations.touchLastActivityPreservingStatus(
    conversationId, 'retry landed', new Date().toISOString());
  const after = await conversations.getById(conversationId);
  expect(after?.status).toBe('closed');
  expect(after?.last_activity_at).not.toBe(before?.last_activity_at);
});

it('leaves an open group open', async () => {
  await conversations.touchLastActivityPreservingStatus(
    conversationId, 'retry landed', new Date().toISOString());
  expect((await conversations.getById(conversationId))?.status).toBe('open');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd app; npx vitest run test/conversationsRepo.integration.test.ts -t "without reopening"`
Expected: FAIL - method missing.

- [ ] **Step 3: Implement**

An `UpdateCommand` setting `last_activity_at` and `last_message_preview` only -
no `#s = :open` - under the same item-existence condition the sibling uses.

```ts
/** D16. Activity bump that does NOT write `status`. `touchLastActivity` sets
 *  `status = 'open'` (:1531-1560); a relay retry lands 60-240s after its
 *  open-group gate, so using that one would reopen a group closed during the
 *  backoff, contradicting the "this group chat is now closed" message already
 *  sent. On a closed group this re-sorts it within the `closed` partition of the
 *  byLastActivity GSI (:632, :699), which is the intended, observable effect. */
```

- [ ] **Step 4: Run and watch it pass**

Run: `cd app; npx vitest run test/conversationsRepo.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/repos/conversationsRepo.ts app/test/conversationsRepo.integration.test.ts
git commit -m "feat(relay): status-preserving activity bump for retry sends"
```

---

## Task 5: The retry job

**Files:**
- Create: `app/src/jobs/relayRetryLeg.ts`
- Modify: `app/src/jobs/registerHandlers.ts`
- Test: `app/test/relayRetryLeg.test.ts`

**Interfaces:**
- Consumes: `sendOneRelayLeg` (Task 3), `relayRetryBackoffMs` /
  `MAX_RELAY_RETRY_ATTEMPTS` / `relayRetryDigest` (Task 1),
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
  | 'retry_group_closed'
  | 'retry_member_removed'
  | 'retry_number_changed'
  | 'retry_opted_out'
  | 'enqueue_failed'
  | 'transient_cap';

export function registerRelayRetryLegJobHandler(deps?: RelayRetryLegJobDeps): void;
export async function enqueueRelayRetryLeg(
  payload: RelayRetryLegPayload,
  attempt: number,
  deps?: { backoffMs?: (n: number) => number },
): Promise<void>;
```

The payload carries IDENTIFIERS ONLY - never the body, never a phone. The handler
re-reads the retry row, which is where D12 put the raw body and the exact leg
copy.

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
    status: 'failed',
    errorCode: code,
  });
  expect(enqueueSpy).not.toHaveBeenCalled();
  expect(errorLogs()).toContainEqual(
    expect.objectContaining({ retryClaim: 'gate_refused' }),
  );
});

// D5 + D9: the destination digest exists for exactly this. A member whose phone
// changed must never silently receive an old message at the new number.
it('compares the DIGEST, not the current phone, on the changed-number gate', async () => {
  await changeMemberPhone('+15558675399');
  await runHandler(payload);
  expect(sendSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Write the failing send and ladder tests**

```ts
it('sends exactly one leg to the failed member and bumps activity', async () => {
  await runHandler(payload);
  expect(sendSpy).toHaveBeenCalledTimes(1);
  expect(sendSpy.mock.calls[0][0]).toMatchObject({ to: memberPhone });
  expect(bumpSpy).toHaveBeenCalledTimes(1);
});

// D12: the row stores the RAW body; the LEG carries the composed copy, sent
// verbatim even if the sender's display name changed between attempts.
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

// D10: a transient send error re-enqueues the SAME rung and consumes no retry
// rung. Ending the chain on a 429 would be the wrong answer for the one code
// that most means "try again".
it('re-enqueues the same rung on a transient send error', async () => {
  sendSpy.mockResolvedValueOnce({ kind: 'transient', errorCode: '429' });
  await runHandler(payload);
  expect(enqueueSpy).toHaveBeenCalledWith(
    RELAY_RETRY_LEG_JOB,
    expect.objectContaining({ retryTsMsgId }),
    expect.anything(),
  );
  const row = await messages.getByTsMsgId(conversationId, retryTsMsgId);
  expect(row?.relay_retry_attempt).toBe(1);
});

it('closes with transient_cap when the retry row pass budget caps', async () => {
  await exhaustFanoutPasses(retryTsMsgId);
  sendSpy.mockResolvedValueOnce({ kind: 'transient', errorCode: '429' });
  await runHandler(payload);
  expect(slotOf(retryTsMsgId)).toMatchObject({
    status: 'failed',
    errorCode: 'transient_cap',
  });
  expect(errorLogs()).toContainEqual(
    expect.objectContaining({ retryClaim: 'cap_exhausted' }),
  );
});
```

- [ ] **Step 4: Run them and watch them fail**

Run: `cd app; npx vitest run test/relayRetryLeg.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 5: Implement the handler**

The order is load-bearing and each line of it answers a review finding:

1. `putJobExecutionMarker(getContext()?.jobId, conversationId)` - return early if
   it has already run (D4).
2. Re-read the retry row and its root. Close and return if either is missing.
3. Gates in order: group still open; member still on the roster;
   `relayRetryDigest(rootTsMsgId, member.phone)` still equals
   `row.relay_retry_dest_digest`; member not suppressed (`isMemberSuppressed`,
   `relayAnnouncements.ts:64`). Any refusal writes its close code, logs ERROR
   with `retryClaim: 'gate_refused'`, and RETURNS (D9, D23).
4. `sendOneRelayLeg(...)` with the row's stored leg copy and freshly presigned
   media.
5. Branch on the outcome:
   - `sent` - write the slot and a `relaysid#` pointer for the NEW SID pointing
     at the RETRY row and its member key; then
     `touchLastActivityPreservingStatus` (D16). No push, no unread change.
   - `transient` - `claimFanoutPass` on the RETRY row. `claimed` re-enqueues the
     SAME rung at `fanOutBackoffMs(claim.attempt)`; `capped` closes
     `transient_cap` and logs the terminal ERROR (D10).
   - `refused` / `filtered` / `suppressed` - close with the matching code, log
     ERROR, stop.
6. Register the handler in `registerHandlers.ts` beside the relay registrar.

- [ ] **Step 6: Run and watch them pass**

Run: `cd app; npx vitest run test/relayRetryLeg.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src/jobs/relayRetryLeg.ts app/src/jobs/registerHandlers.ts app/test/relayRetryLeg.test.ts
git commit -m "feat(relay): the 30003 retry job - gates, ladder and terminal closes"
```

---

## Task 6: The claim in the status webhook

**Files:**
- Modify: `app/src/routes/webhooks/twilio.ts` (inside
  `handleRelayRecipientStatus` `:2442-2561`)
- Test: `app/test/relayWebhook.test.ts`, `app/test/twilioStatusWebhook.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2 and 5.
- Produces: no new exports. The claim is internal to the handler.

- [ ] **Step 1: Write the failing claim tests**

```ts
// D8. The gate is the SLOT'S POST-WRITE STATE plus THIS callback's code - never
// whether this callback transitioned the slot. Read D8 before editing: a
// transition gate is unreachable-by-justification AND makes a crash between the
// slot write and the claim permanently unrecoverable.
it('claims exactly one retry for a forward 30003 on a fan-out leg', async () => {
  await postStatus({
    MessageSid: legSid,
    MessageStatus: 'undelivered',
    ErrorCode: '30003',
    To: memberPhone,
  });
  const retries = (await listMessages(conversationId))
    .filter((r) => r.relay_retry_of === rootTsMsgId);
  expect(retries).toHaveLength(1);
  expect(retries[0].relay_retry_attempt).toBe(1);
  expect(retries[0].relay_retry_origin_direction).toBe('outbound');
  expect(enqueueSpy).toHaveBeenCalledTimes(1);
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
});

it('claims nothing when the source row cannot be read', async () => {
  consistentReadSpy.mockResolvedValueOnce(undefined);
  await postStatus(failure);
  expect(retryRows()).toHaveLength(0);
  expect(errorLogs()).toContainEqual(
    expect.objectContaining({ retryClaim: 'source_unreadable' }),
  );
});

// D5
it.each([
  [undefined, 'to_missing'],
  ['not-a-number', 'to_malformed'],
])('claims nothing for To=%s', async (to, expected) => {
  await postStatus({ ...failure, To: to });
  expect(retryRows()).toHaveLength(0);
  expect(errorLogs()).toContainEqual(expect.objectContaining({ retryClaim: expected }));
});

it('stops at the cap', async () => {
  for (let i = 0; i < 5; i += 1) await postFailureForLatestAttempt();
  expect(retryRows()).toHaveLength(3);
});

// D16: without this the chip reads "1 failed" for the whole first backoff.
it('emits message.persisted when the claim lands', async () => {
  await postStatus(failure);
  expect(emitSpy).toHaveBeenCalledWith(
    'message.persisted',
    expect.objectContaining({ tsMsgId: rootTsMsgId }),
  );
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
   `retryClaim: 'source_unreadable'` with its own message, and return (D7, D23).
3. Fence: `source.relay_sender_key` present AND not `SYSTEM_SENDER_KEY`; else
   `retryClaim: 'fenced_announcement'`.
4. Validate `params['To']` as E164 - `to_missing` / `to_malformed`.
5. Slot check: terminal, and its `errorCode` is `30003` or absent.
6. Attempt arithmetic: `source.relay_retry_attempt ?? 0`, next = +1, capped at
   `MAX_RELAY_RETRY_ATTEMPTS` - else `cap_exhausted`.
7. `append` the retry row, mirroring `direction`, `author`, `relay_sender_key`,
   `type` and the transport MODE from the ROOT (D2), storing the five lineage
   values, the raw body, the leg copy and the seeded slot. `deduped: true` means
   another callback won - claim nothing further.
8. `enqueueRelayRetryLeg`. On throw, close the retry leg `enqueue_failed` and log
   the terminal ERROR (D14).
9. Emit `message.persisted` for the ROOT (D16).

- [ ] **Step 4: Run and watch them pass**

Run: `cd app; npx vitest run test/relayWebhook.test.ts test/twilioStatusWebhook.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/webhooks/twilio.ts app/test/relayWebhook.test.ts
git commit -m "feat(relay): claim a 30003 retry from the relay status callback"
```

---

## Task 7: The severity taxonomy and the retryClaim cause field

**Files:**
- Modify: `app/src/routes/webhooks/twilio.ts` (`:294-314`, and the relay failure
  log at `:2500-2511`)
- Test: `app/test/twilioStatusWebhook.test.ts`

This closes `relay-30003-classified-transient-retrying`.

- [ ] **Step 1: Write the failing tests**

```ts
// D23
it('logs WARN while a retry is claimed and ERROR once terminal', async () => {
  await postStatus(failure);
  expect(warnLogs()).toContainEqual(expect.objectContaining({ retryClaim: 'claimed' }));
  await exhaustLadder();
  expect(errorLogs()).toContainEqual(
    expect.objectContaining({ retryClaim: 'cap_exhausted' }),
  );
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

// The 1:1 and native group-text paths are fenced and must not move.
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
`retryClaim` to the existing failure object (`:2501-2510`) and give
`source_unreadable` its own message string. Then rewrite the shared set's comment
so it stops asserting something the repo has already disproven for group text
(`sendMessage.ts:294-297` - a group-text 30003 retry is enqueued and never
sends), naming the exception and pointing at
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

## Task 8: The wire fields

**Files:**
- Modify: `dashboard/src/api/types.ts` (`TimelineMessage` ~`:2474+`),
  `dashboard/src/routes/conversation/useRelayThread.ts` (`toTimelineMessage`
  `:69-135`), `dashboard/src/lib/messageTransport.ts:43-56`
- Test: `dashboard/src/routes/conversation/useRelayThread.test.tsx`

**Interfaces:**
- Produces: `TimelineMessage` gains
  `relay_retry_of?: string`, `relay_retry_member_key?: string`,
  `relay_retry_attempt?: number`, `relay_retry_origin_direction?: 'inbound' | 'outbound'`.

Four fields, not five: the destination DIGEST stays server-side. D11 - the
`/conversations/:id/messages` route returns stored rows as-is
(`app/src/routes/api.ts:2148-2199`), so anything on the row reaches every browser
whatever the projector forwards, and the digest has no client use.

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

it('never projects the destination digest', () => {
  const item = toTimelineMessage({ ...rawRow, relay_retry_dest_digest: 'abc0123456789def' });
  expect(item).not.toHaveProperty('relay_retry_dest_digest');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd dashboard; npx vitest run src/routes/conversation/useRelayThread.test.tsx -t lineage`
Expected: FAIL - fields undefined on the projected item.

- [ ] **Step 3: Add the type fields and project them**

- [ ] **Step 4: Run and watch it pass**

Run: `cd dashboard; npx vitest run src/routes/conversation/useRelayThread.test.tsx src/lib/messageTransport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/api/types.ts dashboard/src/routes/conversation/useRelayThread.ts dashboard/src/lib/messageTransport.ts dashboard/src/routes/conversation/useRelayThread.test.tsx
git commit -m "feat(dashboard): carry relay retry lineage to the relay thread"
```

---

## Task 9: The thread-level retry join

**Files:**
- Create: `dashboard/src/routes/contact/relayRetryJoin.ts`
- Test: `dashboard/src/routes/contact/relayRetryJoin.test.ts`

**Interfaces:**
- Produces:

```ts
export type RelayRetryState =
  | 'retrying'
  | 'delivered-on-retry'
  | 'terminal'
  | 'unconfirmed';

export interface EffectiveRelayLeg {
  /** Only values `DeliveryStatus` already admits - NEVER a retry state. */
  status: DeliveryStatus;
  errorCode?: string;
  retryState?: RelayRetryState;
}

/** Lineage half - memoizable on `items`. */
export function indexRelayRetries(
  items: readonly TimelineItem[],
): Map<string, RelayRetryRow[]>;   // keyed `${rootTsMsgId}|${memberKey}`

/** Time-derived half - MUST be recomputed against `nowMs`. */
export function projectRelayLegs(args: {
  entries: readonly [string, RelayRecipientDelivery][];
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
`presentDeliveryStatus` returns null outside it
(`deliveryStatus.ts:128-141`), so an overloaded `status: 'retrying'` renders as no
state at all and drops the leg from both rollup counters.

- [ ] **Step 1: Write the failing state-machine tests**

```ts
const BUDGET = 15 * 60 * 1000;   // STALE_SENT_AFTER_MS

it('is retrying while a claimed rung is live', () => {
  const legs = project({ retryRows: [queuedRetry({ atMs: now - 1_000 })] });
  expect(legs.get(memberKey)).toMatchObject({ retryState: 'retrying' });
});

it('is delivered-on-retry once any rung delivered', () => {
  const legs = project({ retryRows: [failedRetry(1), deliveredRetry(2)] });
  expect(legs.get(memberKey)).toMatchObject({
    status: 'delivered', retryState: 'delivered-on-retry',
  });
});

// D19 + the forward-only machine: a delivered retry cannot be un-delivered by a
// later failed rung arriving out of order.
it('keeps delivered-on-retry when an older rung reports failure afterwards', () => {
  const legs = project({ retryRows: [deliveredRetry(1), failedRetry(2)] });
  expect(legs.get(memberKey)).toMatchObject({ retryState: 'delivered-on-retry' });
});

it('is terminal at the cap, keeping the carrier reason', () => {
  const legs = project({ retryRows: [failedRetry(1), failedRetry(2), failedRetry(3)] });
  expect(legs.get(memberKey)).toMatchObject({
    status: 'undelivered', errorCode: '30003', retryState: 'terminal',
  });
});

// D19: the close code is PROJECTED onto the original, because the refused retry
// row has no bubble of its own to carry it.
it('projects a gate refusal code onto the original leg', () => {
  const legs = project({ retryRows: [refusedRetry('retry_number_changed')] });
  expect(legs.get(memberKey)).toMatchObject({
    errorCode: 'retry_number_changed', retryState: 'terminal',
  });
});

// D18, half one: the stranded claim - created, never sent.
it('is unconfirmed when a rung never reached sent inside the budget', () => {
  const legs = project({
    retryRows: [queuedRetry({ atMs: now - BUDGET - 1 })], nowMs: now,
  });
  expect(legs.get(memberKey)).toMatchObject({ retryState: 'unconfirmed' });
});

// D18, half two: sent, no receipt. Specifying only half one is how "retrying"
// became a permanent lie for the third time in this design's review.
it('is unconfirmed when a sent rung got no receipt inside the budget', () => {
  const legs = project({
    retryRows: [sentRetry({ sentAtMs: now - BUDGET - 1 })], nowMs: now,
  });
  expect(legs.get(memberKey)).toMatchObject({ retryState: 'unconfirmed' });
});

it('leaves a leg with no retry rows completely untouched', () => {
  const legs = project({ retryRows: [] });
  expect(legs.get(memberKey)).toEqual({ status: 'undelivered', errorCode: '30003' });
  expect(legs.get(memberKey)?.retryState).toBeUndefined();
});

// D5: one contact on two numbers collapses into ONE slot today. The join must
// not invent a second one.
it('keys strictly on the member key the retry row names', () => {
  const legs = project({ retryRows: [deliveredRetry(1, { memberKey: 'other' })] });
  expect(legs.get(memberKey)?.retryState).toBeUndefined();
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd dashboard; npx vitest run src/routes/contact/relayRetryJoin.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement both functions**

`indexRelayRetries` buckets every item carrying `relay_retry_of` by
`${relay_retry_of}|${relay_retry_member_key}`. `projectRelayLegs` walks the
entries, and for each member key with retry rows resolves in this order:
delivered wins permanently; else any live rung inside the budget is `retrying`;
else a rung past the budget with no terminal outcome is `unconfirmed`; else
`terminal`, taking the close code from the last rung when it carries one and
otherwise leaving the original's carrier code.

- [ ] **Step 4: Run and watch them pass**

Run: `cd dashboard; npx vitest run src/routes/contact/relayRetryJoin.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/routes/contact/relayRetryJoin.ts dashboard/src/routes/contact/relayRetryJoin.test.ts
git commit -m "feat(dashboard): derive per-member relay retry state from thread lineage"
```

---

## Task 10: The presenter

**Files:**
- Modify: `dashboard/src/routes/contact/deliveryStatus.ts`
  (`presentRelayDelivery` `:394-456`, `presentLegDelivery` `:508-545`,
  `INTERNAL_CODE_REASONS` `:688-692`, `RelayDeliveryOptions` `:351`)
- Test: `dashboard/src/routes/contact/deliveryStatus.test.ts`

**Interfaces:**
- Consumes: `EffectiveRelayLeg` (Task 9).
- Produces: `presentRelayDelivery` accepts `EffectiveRelayLeg[]`;
  `presentLegDelivery` accepts an `EffectiveRelayLeg`.

- [ ] **Step 1: Write the failing chip tests**

```ts
// D19's table, at the chip.
it.each([
  ['retrying',            'delivered 3/4 - 1 retrying'],
  ['delivered-on-retry',  'delivered 4/4 - 1 on retry'],
  ['unconfirmed',         'delivered 3/4 - 1 not confirmed'],
])('renders %s as %s', (retryState, label) => {
  expect(presentRelayDelivery(legsWith(retryState), relayOpts)?.label).toBe(label);
});

it('keeps today exact string when the cap is exhausted', () => {
  const chip = presentRelayDelivery(legsWith('terminal'), relayOpts);
  expect(`${chip?.label} - ${chip?.reason}`)
    .toBe('delivered 3/4 - 1 failed - Phone unreachable (error 30003)');
});

// D19: a bubble can hold more than one state at once. The chip composes, in a
// fixed order, omitting zero-count categories.
it('composes a failed leg and a retrying leg in one label', () => {
  expect(presentRelayDelivery(mixedLegs, relayOpts)?.label)
    .toBe('delivered 2/4 - 1 failed, 1 retrying');
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
// D19's second table - the row and recital grammar. Neither position can express
// these today; `retryState` is what gives them an input they can render.
it.each([
  ['retrying',           'Retrying - Phone unreachable (error 30003)'],
  ['delivered-on-retry', 'Delivered on retry'],
])('renders the per-recipient row for %s', (retryState, text) => {
  expect(rowTextOf(presentLegDelivery(legWith(retryState), 'relay'))).toBe(text);
});
```

- [ ] **Step 3: Run and watch them fail**

Run: `cd dashboard; npx vitest run src/routes/contact/deliveryStatus.test.ts -t retry`
Expected: FAIL.

- [ ] **Step 4: Implement**

Subtract `retrying`, `delivered-on-retry` and `unconfirmed` legs from the `failed`
bucket before the `failed > 0` branch (`:416`) - it is the FIRST branch, so an
unsubtracted leg wins over every new state. Add the retrying count to the
composed label. Add the `on retry` suffix to the delivered count. Scope every new
string behind a retry-aware option on `RelayDeliveryOptions`. Add the four codes
to `INTERNAL_CODE_REASONS`.

- [ ] **Step 5: Run and watch them pass**

Run: `cd dashboard; npx vitest run src/routes/contact/deliveryStatus.test.ts`
Expected: PASS, including every pre-existing case.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/routes/contact/deliveryStatus.ts dashboard/src/routes/contact/deliveryStatus.test.ts
git commit -m "feat(dashboard): render relay retry states at the chip and the row"
```

---

## Task 11: Timeline plumbing, render rules and the ticker

**Files:**
- Modify: `dashboard/src/routes/contact/Timeline.tsx` - the entries call `:937`,
  `MessageBubble`/`StreamItem` props `:814-835` and `:1538-1552`,
  `recipientSummaryName` sites `:959-968` and `:993-1004`, the per-recipient row
  `:1112-1115`, the `visible` memo `:1787-1799`, `hasTickableLeg` `:798-812`
- Test: `dashboard/src/routes/contact/Timeline.delivery.test.tsx`,
  `Timeline.test.tsx`, `Timeline.ticker.test.tsx`

- [ ] **Step 1: Write the failing three-position test**

```ts
// M5's D21: one flag feeds the rollup, the recital and the row, and the whole
// content of D21 is that they cannot disagree. Patch the chip alone and the
// other two keep reciting "Undelivered - Phone unreachable (error 30003)".
it('shows delivered-on-retry at the chip, the recital AND the row', async () => {
  renderRelayThread({ items: [originalWithFailedLeg, deliveredRetryRow] });
  const rollup = screen.getByRole('img');
  expect(rollup).toHaveTextContent('delivered 2/2 - 1 on retry');
  expect(rollup).toHaveAccessibleName(/Relay Unreachable: Delivered on retry/);
  await userEvent.click(screen.getByText(BODY));
  expect(within(screen.getByRole('list', { name: 'Delivery by recipient' }))
    .getByText(/Delivered on retry/)).toBeVisible();
});

// D20 + Sec 2: an INBOUND source has no chip, but it DOES have the recital and
// the rows - the only delivery information a screen-reader user gets from that
// bubble. Leaving them stale would be strictly worse than today.
it('updates the inbound recital when a member-originated leg recovers', () => {
  renderRelayThread({ items: [inboundOriginalWithFailedLeg, deliveredRetryRow] });
  expect(screen.getByRole('group')).toHaveAccessibleName(/Delivered on retry/);
  expect(screen.queryByRole('img')).toBeNull();
});
```

- [ ] **Step 2: Write the failing render-predicate tests**

```ts
// D20
it('renders a delivered retry as a second bubble on an outbound original', () => {
  renderRelayThread({ items: [outboundOriginal, deliveredRetryRow] });
  expect(screen.getAllByText(BODY)).toHaveLength(2);
});

it.each([
  ['a failed retry', failedRetryRow],
  ['a queued retry', queuedRetryRow],
  ['a retry of an INBOUND original', deliveredRetryOfInboundRow],
])('renders no second bubble for %s', (_n, row) => {
  renderRelayThread({ items: [outboundOriginal, row] });
  expect(screen.getAllByText(BODY)).toHaveLength(1);
});

// D20: the original must NEVER be hidden. Stamping `retry_of` would add it to
// supersededIds and delete it - the contract inverted by one field.
it('never hides the original', () => {
  renderRelayThread({ items: [outboundOriginal, deliveredRetryRow] });
  expect(screen.getByText(ORIGINAL_MARKER)).toBeVisible();
});

// D22: paging is newest-first, so a retry can render before its original loads.
it('renders an orphaned retry honestly', () => {
  renderRelayThread({ items: [deliveredRetryRow] });
  expect(screen.getByRole('img')).toHaveTextContent('delivered 1/1 on retry');
});
```

- [ ] **Step 3: Write the failing ticker tests**

```ts
// D18: severing from stalenessClockMs severs from the ONLY clock advance. The
// original's failed leg is terminal and can never arm the ticker, and D20 keeps
// the retry row out of `visible` - so without an explicit clause `tickNow` is
// frozen and "retrying" is computed once, for ever.
it('keeps the ticker armed for a live retry with no other activity', () => {
  renderRelayThread({ items: [outboundOriginal, queuedRetryRow] });
  expect(tickerArmed()).toBe(true);
});

it('flips retrying to not confirmed as the clock passes the budget', () => {
  const { advance } = renderRelayThread({ items: [outboundOriginal, queuedRetryRow] });
  expect(screen.getByRole('img')).toHaveTextContent('1 retrying');
  act(() => advance(STALE_SENT_AFTER_MS + 1_000));
  expect(screen.getByRole('img')).toHaveTextContent('1 not confirmed');
});

// The fifth non-termination in a predicate whose docblock enumerates four
// shipped bugs on this axis. It must terminate.
it('disarms the ticker once the retry resolves', () => {
  renderRelayThread({ items: [outboundOriginal, deliveredRetryRow] });
  expect(tickerArmed()).toBe(false);
});
```

- [ ] **Step 4: Run and watch them fail**

Run: `cd dashboard; npx vitest run src/routes/contact/Timeline.delivery.test.tsx src/routes/contact/Timeline.ticker.test.tsx`
Expected: FAIL.

- [ ] **Step 5: Implement**

Compute `indexRelayRetries` once at thread level beside `visible`, memoized on
`items`; call `projectRelayLegs` per bubble against `bubbleNowMs`. Pass entries
WITH their keys (`:937` currently discards them). Thread the projected legs
through `MessageBubble` and `StreamItem`. Point all four reason sites at the
projected legs. Extend the `visible` filter with the D20 predicate, and
`hasTickableLeg` with the retry clause - **and extend its docblock from four
non-terminations to five.**

- [ ] **Step 6: Run and watch them pass**

Run: `cd dashboard; npx vitest run src/routes/contact/`
Expected: PASS, including every pre-existing Timeline case.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/Timeline.delivery.test.tsx dashboard/src/routes/contact/Timeline.test.tsx dashboard/src/routes/contact/Timeline.ticker.test.tsx
git commit -m "feat(dashboard): relay retry states at every position, with a live ticker"
```

---

## Task 12: All three relay Timeline hosts

**Files:**
- Modify: `dashboard/src/routes/conversation/ConversationDetail.tsx:480`,
  `dashboard/src/routes/tours/TourConversation.tsx:467`,
  `dashboard/src/routes/placements/PlacementConversation.tsx:320`
- Test: `dashboard/src/routes/conversation/ConversationDetail.test.tsx` plus a
  case in each host's suite

D21 said "one relay render surface" and that was wrong - `useRelayThread` feeds
three. A build that threads the retry rows through `ConversationDetail` alone
leaves the tour and placement transcripts rendering the pre-change copy: two
readers that disagree with the new rule.

**The tour host passes a MILESTONE-MERGED item list** (`TourConversation.tsx:463-467`),
not `thread.items`, so its sibling set differs and the filter must be correct
against a mixed list.

- [ ] **Step 1: Write one failing test per host**

```ts
it('renders delivered-on-retry in the tour conversation transcript', () => {
  renderTourConversation({ items: [outboundOriginal, deliveredRetryRow, milestone] });
  expect(screen.getByRole('img')).toHaveTextContent('delivered 2/2 - 1 on retry');
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd dashboard; npx vitest run src/routes/tours src/routes/placements src/routes/conversation`
Expected: FAIL on the tour and placement hosts.

- [ ] **Step 3: Implement, then re-run**

Run: `cd dashboard; npx vitest run src/routes/tours src/routes/placements src/routes/conversation`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/routes/conversation/ConversationDetail.tsx dashboard/src/routes/tours/TourConversation.tsx dashboard/src/routes/placements/PlacementConversation.tsx
git commit -m "feat(dashboard): relay retry states on all three Timeline hosts"
```

---

## Task 13: The hermetic browser proof

**Files:**
- Modify: `e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts`,
  `app/src/routes/dev.ts` (backoff override seam), the e2e lane env
- Test: the spec itself

**Rename the file to `relay-30003-retry.spec.ts`** and UPDATE its assertions. Its
negative assertions (`not.toContainText('will retry')`) all survive; its positive
strings are the checklist for the new copy. Never delete it.

The 60-second first rung needs the backoff injectable. There is no precedent for
a worker-side dev seam - the backoffs are bare module functions - so the value
comes through the retry job's deps, with the lane supplying it. **This is
configuration, not structural absence**; production keeps 60/120/240.

- [ ] **Step 1: Add the backoff seam and prove it is lane-only**

A unit assertion that the override is ignored unless the dev seams are enabled,
so a misconfigured deployment cannot shorten a real ladder.

- [ ] **Step 2: Update the spec**

Keep its `createGroupOpen` arrangement and its intro-settle barriers verbatim -
they are load-bearing and hard-won. Then:

```ts
// The fake's delivery arming is ONE-SHOT per destination number, so the retry
// naturally lands clean as the NEXT message to that handset. That is the whole
// flow: arm one failure, and the ladder does the rest.
await setDeliveryOutcome(request, {
  partyNumber: unreachable.phone,
  profile: { kind: 'fail', failState: 'undelivered', errorCode: '30003' },
});

// ... team send ...

// 1. The chip goes retrying WITHOUT waiting a backoff interval (D16's SSE).
await expect(rollup).toContainText('1 retrying', { timeout: 30_000 });
await expect(rollup).not.toContainText('will retry');

// 2. The retry lands and the ORIGINAL becomes truthful.
await expect(rollup).toContainText('delivered 2/2 - 1 on retry', { timeout: 60_000 });

// 3. A SECOND bubble, addressed to the one member.
const bubbles = page.getByText(token);
await expect(bubbles).toHaveCount(2);

// 4. All three positions agree (D21).
await expect(rollup).toHaveAccessibleName(
  new RegExp(`${unreachable.name}: Delivered on retry`));
await bubbleBody.click();
await expect(failedRow).toContainText('Delivered on retry');

// 5. NO DUPLICATE SEND. The reachable member got the body exactly once - this is
// acceptance criterion 4 and the one a green chip cannot prove.
const reachableMsgs = await getOutboundTo(request, { to: reachable.phone });
expect(reachableMsgs.filter((m) => (m.body ?? '').includes(token))).toHaveLength(1);
```

- [ ] **Step 3: Run it**

Run: `npm run e2e -- --grep "relay-30003"` from the e2e workspace.
Expected: PASS. Never run Playwright from the repo root.

- [ ] **Step 4: Commit**

```bash
git add e2e/tests/dashboard-next/relay-30003-retry.spec.ts app/src/routes/dev.ts
git commit -m "test(e2e): prove one failed relay leg retries to delivered without duplicating"
```

---

## Task 14: Close the issues

**Files:**
- Modify: `docs/issues/relay-30003-retry-lineage.md`,
  `docs/issues/relay-30003-classified-transient-retrying.md`,
  `docs/issues/quiet-hours-ungated-automated-paths.md`

- [ ] **Step 1: Stamp both closed issues**

`status: resolved`, `resolved: 2026-09-02`, and a
`**Resolution (2026-09-02).**` paragraph naming what shipped and where. Walk all
nine acceptance criteria of the lineage issue and say which task proves each.

- [ ] **Step 2: Annotate, do NOT close, the quiet-hours decision**

Relay retries now exist and inherit its item-3 recommendation unchanged (the
~7-minute bound). The decision itself stays open.

- [ ] **Step 3: Leave both filed issues OPEN**

`relay-member-key-collapses-two-phones-one-contact` and
`relay-inbound-source-has-no-delivery-rollup` are separate work by the founder's
ruling. Confirm the workaround notes in the first still read true against what
shipped.

- [ ] **Step 4: Regenerate the index and commit**

```bash
npm run issues
git add docs/issues/
git commit -m "docs(issues): close the relay 30003 retry lineage pair"
```

---

## Self-Review

**Spec coverage.** Every decision maps to a task: D1-D3 to Tasks 1 and 6; D4 to
Task 5; D5 to Tasks 1, 5 and 6; D6 to Task 1; D7-D8 to Tasks 2 and 6; D9-D14 to
Task 5; D15 to Task 10; D16 to Tasks 4, 5 and 6; D17 to Task 8; D18-D19 to Tasks
9, 10 and 11; D20-D22 to Task 11; D23 to Task 7. All twenty test intentions in
Sec 7 appear as named steps. Sec 8's four obligations are Task 14.

**Placeholders.** None. Every code step carries real assertions; the two
extraction steps (Task 3) deliberately carry no new code because a
behavior-preserving move whose proof is an unchanged test count is the deliverable.

**Type consistency.** `EffectiveRelayLeg` and `RelayRetryState` are defined once
in Task 9 and consumed by name in Tasks 10 and 11. `RelayLegSendOutcome` is
defined in Task 3 and consumed in Task 5. The five stored lineage names are fixed
in Task 1; Task 8 projects four of them and names the one it withholds.

**Ordering.** Tasks 1-7 are server and stand alone; 8-12 are dashboard and depend
only on Task 1's field names, so the two halves can proceed in parallel after
Task 1. Task 13 needs both. No task leaves a stated guarantee violated between
commits: until Task 6 nothing claims, and until Task 11 nothing renders a retry
state - the display simply reads as it does on `main`.
