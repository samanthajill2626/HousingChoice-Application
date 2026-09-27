# Send-Outcome Classification and Reconcile - Implementation Plan (Stage 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 2** (after plan review round 1 - 32 distinct findings accepted; adjudications in `docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/design-review/adjudications.md`, section "Plan round 1").

**Goal:** Replace the throw-for-redelivery in both fan-outs and the relay retry rung with a classified send outcome, a per-recipient send-attempt record claimed before every provider call, and a `send.reconcile` job that resolves an ambiguous send by looking the message up at the provider - so every attempted recipient reaches a terminal state and nobody is ever texted twice.

**Architecture:** A pure classifier at the send boundary sorts a provider failure into `rejected` / `retryable` / `unknown`; `sendMessage` throws typed errors that carry the reconcile facts. A new `sendAttemptsRepo` keeps per-owner-per-recipient records (plus a recipient-keyed index) in the messages table, with every transition a conditional write keyed on the attempt. The send sites split each recipient into PREPARE / SEND / RECORD phases inside one outer per-recipient try/catch, claim the record before the provider call, and hand `unknown` outcomes to a `send.reconcile` job (no run-once marker; at-least-once enqueues; idempotent writes) whose per-owner handlers adopt, re-drive once, or close `unresolved`. The dashboard presents `send_unconfirmed` by code alone as "Not confirmed".

**Tech Stack:** TypeScript (Node 24, ESM), Express, DynamoDB (`@aws-sdk/lib-dynamodb`, DynamoDB Local for integration tests), twilio-node 6.0.2, Vitest, React 19 dashboard, Playwright e2e harness with the in-repo fake-twilio.

**Spec:** `docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md` (revision 9 @6ba1a78c). The plan argues from the spec; executors read both. Decision numbers below (D1, D8a, ...) are the spec's. Where the plan deviates from the spec's WORDING it says so inline (two places: D17's `createdAfter` is not a port argument, the job filters; D20's dashboard code constants live in `deliveryStatus.ts`, pinned to the app by a mirror test).

**Branch / worktree:** `feat/send-outcome-reconcile` at `W:\tmp\send-outcome-reconcile`, HEAD merged with `main` @bd752bd0 at a9f411f3 (RSW and share-skip-fix Branch A included). This branch's ONE main sync is already done; Task 17 reports later drift, it does not re-merge.

**One deliverable, not six.** The slices below are commit-and-review checkpoints, NOT shippable states: after Slice B a `send.reconcile` envelope is enqueued with no handler (the consumer deletes it as poison); before Slice E the dashboard renders `send_unconfirmed` as a failure with a retry hint. The branch is merge-ready only after Task 17.

**Research maps the tasks cite:** findings (tracked) in
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/research/plan-*-findings.md`;
byte-exact references (gitignored, worktree-local) in
`.superpowers/sdd/plan-send-sites-reference.md`, `plan-data-layer-reference.md`,
`plan-dashboard-reference.md`. Line numbers in this plan are at a9f411f3; re-derive
by reading before editing. Test sketches name the seams to use; where a sketch
names a fixture, USE THE FILE'S REAL FIXTURE NAMES (read the file first) - the
sketch states the expectation, not the exact identifiers.

## Global Constraints

- ASCII-only in every line this branch ADDS or TOUCHES (code, comments, tests, docs, log strings). `broadcastFanOut.ts`, `relayFanOut.ts` and `sendMessage.ts` carry pre-existing U+2014 log strings; a touched log line is re-worded in ASCII (no test matches an em-dash string). Verify a NEW file with `tr -d '\11\12\15\40-\176' < FILE | wc -c`; on a pre-existing file check the diff's added lines. Unicode test strings are written as `\uXXXX` escapes.
- Never edit `app/src/routes/webhooks/twilio.ts` (fenced), `app/src/jobs/jobs.ts` (incl. `MAX_HOP_COUNT` 10), `app/src/adapters/sqsJobConsumer.ts`, or the run-once marker. Never edit `app/src/jobs/retrySend.ts` (its FILE is unchanged on this branch; its behavior changes only through D3's typed errors, which it rethrows as before).
- `SendRefusedError` and every subclass are never wrapped (D3). No new refusal code (a new code would force a row in `routes/api.ts:173 REFUSAL_STATUS`). No new `sendMessage` gate, so `app/test/helpers/sendRefusalCases.ts` gets no row.
- No new slot STATUS values (D10). Slot codes this branch writes: `send_unconfirmed`, `send_retryable`, `enqueue_failed`, `redrive_refused`, `sms_sending_disabled`, the provider's own rejection codes. Pending states live on the attempt record, never on a slot.
- Every coordination read is a strongly consistent primary-key read or Query on the base table; no GSI anywhere in the coordination path (D11).
- Every DynamoDB expression lists EXACTLY the attribute names and values it uses - DynamoDB rejects an unused alias with a ValidationException (`app/test/aiRunsRepo.integration.test.ts:302-316` pins that behavior). Every repo helper in this plan builds its names/values per expression.
- Classifier precedence (D1): a code the arms already recognise classifies by code whatever the status - `30007`, `30005`, `30006` are `rejected`; `429`, `30022` are `retryable`; then HTTP 5xx -> `unknown`; HTTP 429 -> `retryable`; HTTP 4xx -> `rejected`; ENOTFOUND/ECONNREFUSED/EAI_AGAIN -> `retryable`; ECONNABORTED/ETIMEDOUT/ECONNRESET/EPIPE and anything else -> `unknown` (D2). A code of `0` (twilio-node's `TwilioServiceException` default) is no code.
- Claim placement (D7a): relay unit claims AFTER the bounded token acquire and BEFORE the presign; broadcast pass claims immediately before `sendMessage`, after its fences. Both loops wrap each recipient in ONE outer try/catch so nothing throws out of the loop (Task 7 / Task 8 state the arms).
- Claim TTL = `SEND_CLAIM_TTL_MS` = 30_000, the same constant the Twilio driver passes as its request timeout (D8a).
- Reconcile: check k (k = 0, 1, 2) runs at `attemptedAt + RECONCILE_CHECK_DELAYS_MS[k]` = +5 s, +30 s, +240 s (offsets from the ATTEMPT, not a running sum); the enqueue delay is `max(0, thatTime - now)`; lane-overridable only when `JOBS_QUEUE_URL` is unset; window opens 60 s before the attempt start; list page size 1000, at most 5 pages; one re-drive per recipient; worst-case chain depth 8 of 10 hops (D13, D13a).
- Body matching uses the lossy normalization (Unicode NFKC, then letters and digits only); a normalized body shorter than 3 characters matches on media count instead (D13).
- A payload or a log line never carries a recipient phone: the reconcile payload carries the HASHED recipient key (`hashRecipientKey`), and log lines use `logSafeMemberKey` / `safeRecipientKey` (D12, D18).
- Dashboard copy (D20-D23, exact): `send_unconfirmed` -> label `Not confirmed`, tone `danger`, `isFailure: false`, reason `Couldn't confirm whether this text went out` (no trailing period); `redrive_refused` -> `Wasn't resent: the group closed or the member left`; `sms_sending_disabled` -> `SMS sending is switched off, so nothing was sent`; `transient_cap` -> `Sending gave up after repeated temporary errors`; broadcast chip label `Not confirmed`; `last_error` for an all-unconfirmed share `Couldn't confirm any text went out`. A Twilio 21211 renders through the fallback, `Delivery failed (error 21211)` (the carrier map has no 21211 entry).
- The `unconfirmed` stats bucket is OPTIONAL in both `BroadcastStats` types, read as `?? 0`, its own chip in the audience sum, never part of `skippedTotal` (D22).
- E2E must never use the lean seed's switched-off tenant `contact-tenant-0002` / `conv-0002` as a recipient of anything automated (Sec 2a).
- Gates are run BARE, never piped, from the worktree, in a BASH shell (the Bash tool; PowerShell's `timeout` is timeout.exe and rejects these arguments): `npm run typecheck`, `npm test`, `npm run smoke`, `timeout 1500 npm run e2e`, and `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` with an empty list SKIPPED. `npm test` needs DynamoDB Local (`npm run db:start`).
- Commit discipline: bare `git status` before every commit, check `.git/MERGE_HEAD` is absent, stage EXPLICIT paths, never `git add -A`; every commit ends with `Co-Authored-By: <the authoring model> <noreply@anthropic.com>`.
- Never merge to `main`, deploy, push secrets, run terraform, or clean up the worktree.

## Review Focus

Input classes the spec implies but no task's tests would otherwise exercise, most likely to bite first; each has a named test in the owning task:

1. A Twilio `RestException` with `status: 400` and NO code (body unparseable) - must classify `rejected`, not `unknown` (Task 1, test "a 4xx with no code").
2. A relay member whose phone number changed between the claim and the reconcile - the lookup must rule `unresolved`, never re-send to the new number (Task 10, case 13).
3. A `SendRefusedError` thrown by `sendMessage` for a recipient the broadcast pass has already CLAIMED (manual-mode flip mid-pass) - the record must close `done` / `refused`, the slot as today, no reconcile (Task 7, test "a claimed recipient whose sendMessage refuses").
4. A reconcile check that lists a candidate created 59 seconds BEFORE the attempt start (clock skew) - inside the 60 s lead, must be considered (Task 10, case 13b).
5. A broadcast whose recipients are all `skipped` plus one `unconfirmed` - finalize must read `failed` with the prose `last_error`, not `sent` (Task 7, finalize test "all skipped plus one unconfirmed").

---

## Work map (task ORDER - it differs from the numbering)

Order: **T1, T2, T4, T5, T6** (foundations with no behavior change) -> **T3** (typed errors: a behavior change for every `sendMessage` caller, so it lands immediately before its first adopter) -> **T7, T8, T9** (the send sites) -> **T10** (the reconcile job) -> **T13, T14** (dashboard) -> **T11, T12** (fake + e2e, which need the dashboard chip) -> **T15, T16, T17**.

- **Slice A:** T1 classifier + throttle marker + the `messagingErrors` leaf; T2 fingerprint/digest helpers; T4 adapter port `listMessages`/`getMessage` + driver timeout; T5 send-attempt record repo + registration-site wiring; T6 repo additions (conditional slot writes and adoption writes, consistent reads, SID claim, finalize flip, `unconfirmed` counter).
- **Slice B:** T3 `sendMessage` typed errors; T7 broadcast fan-out; T8 relay leg + fan-out loop; T9 relay retry rung.
- **Slice C:** T10 `send.reconcile`.
- **Slice E (before D):** T13 codes, copy, aging, join; T14 broadcast bucket, chip, badge, seeds.
- **Slice D:** T11 fake routes and seams; T12 lane seams + e2e specs.
- **Slice F:** T15 issue updates; T16 self-QA; T17 gates + handback.

Interfaces every task must agree on are stated once here and repeated in each task's Interfaces block.

### Shared interfaces (canonical)

```ts
// app/src/adapters/messagingErrors.ts  (Task 1) - a LEAF: imports nothing from the app
export class SmsSendingDisabledError extends Error { constructor(message: string) }
// messaging.ts re-exports it: `export { SmsSendingDisabledError } from './messagingErrors.js';`

// app/src/lib/sendOutcome.ts  (Task 1) - imports ONLY from messagingErrors.ts
export type SendFailureKind = 'rejected' | 'retryable' | 'unknown';
export interface SendFailureClassification { kind: SendFailureKind; code?: string; status?: number; }
export function classifySendFailure(err: unknown): SendFailureClassification;
export const SEND_UNCONFIRMED_CODE = 'send_unconfirmed';
export const SEND_RETRYABLE_CODE = 'send_retryable';
export const REDRIVE_REFUSED_CODE = 'redrive_refused';
export const SMS_SENDING_DISABLED_CODE = 'sms_sending_disabled';
export const TRANSIENT_CAP_CODE = 'transient_cap';
export const ENQUEUE_FAILED_CODE = 'enqueue_failed';
export const SEND_CLAIM_TTL_MS = 30_000;
export const RECONCILE_CHECK_DELAYS_MS: readonly number[] = [5_000, 30_000, 240_000];
export const RECONCILE_WINDOW_LEAD_MS = 60_000;
export const RECONCILE_LIST_PAGE_SIZE = 1000;
export const RECONCILE_MAX_PAGES = 5;
export const OUTAGE_BRAKE_UNKNOWN_STREAK = 3;

// app/src/lib/sendFingerprint.ts  (Task 2)
export function normalizeBodyForMatch(body: string | undefined): string;
export interface BodyFingerprint { hash: string; short: boolean; }
export function bodyFingerprint(body: string | undefined): BodyFingerprint;
export function recipientDigest(sender: string | undefined, destinationE164: string): string;
export function hashRecipientKey(recipientKey: string): string;      // 'phone#...' -> 'phonehash#<32 hex>'; others unchanged
export function safeRecipientKey(recipientKey: string): string;      // for LOGS: 'phone#...' -> 'phone#redacted'

// app/src/services/sendMessage.ts  (Task 3)
export class SendNotAttemptedError extends Error { constructor(message: string, readonly cause: unknown) }
export class ProviderSendFailedError extends Error {
  constructor(args: { classification: SendFailureClassification; cause: unknown; facts: SendAttemptFacts; attemptedAt: string });
  readonly classification: SendFailureClassification; readonly cause: unknown; readonly facts: SendAttemptFacts; readonly attemptedAt: string;
  readonly code?: string | number;   // mirrors the cause's `code`, so errorCodeOf(err) keeps answering
  readonly status?: number;          // mirrors the cause's `status`
}
export class SendAcceptedNotRecordedError extends Error {
  constructor(args: { providerSid: string; providerTs: string; status: DeliveryStatus; cause: unknown; facts: SendAttemptFacts });
  readonly providerSid: string; readonly providerTs: string; readonly status: DeliveryStatus; readonly cause: unknown; readonly facts: SendAttemptFacts;
}

// app/src/adapters/messaging.ts  (Task 4)
export interface ProviderMessageSummary {
  providerSid: string;
  providerStatus: string;   // the provider's raw status string
  errorCode?: string;
  body: string;
  mediaCount: number;
  createdAt: string;        // ISO
  sentAt?: string;          // ISO
}
export interface ListMessagesArgs { to: string; from: string; pageSize: number; pageToken?: string; }   // no createdAfter: the JOB filters (plan deviation from D17's wording)
export interface ListMessagesPage { messages: ProviderMessageSummary[]; nextPageToken?: string; }
// added to MessagingAdapter:
listMessages(args: ListMessagesArgs): Promise<ListMessagesPage>;
getMessage(providerSid: string): Promise<ProviderMessageSummary | undefined>;
export const TWILIO_REQUEST_TIMEOUT_MS = SEND_CLAIM_TTL_MS;   // messaging.ts imports the constant from sendOutcome.ts; no cycle (sendOutcome imports only messagingErrors)

// app/src/repos/sendAttemptsRepo.ts  (Task 5)
export type SendAttemptOwner =
  | { kind: 'broadcast'; broadcastId: string; contactKey: string }
  | { kind: 'relay_leg'; relayConversationId: string; sourceTsMsgId: string; memberKey: string }
  | { kind: 'relay_rung'; relayConversationId: string; retryTsMsgId: string; memberKey: string };
export type SendAttemptState = 'attempting' | 'reconciling' | 'redriven' | 'done';
export type SendAttemptOutcome =
  | 'sent' | 'rejected' | 'retryable' | 'refused' | 'adopted' | 'never_sent'
  | 'unresolved' | 'enqueue_failed' | 'redrive_refused';
export interface SendAttemptFacts { recipientDigest: string; sender?: string; bodyHash: string; bodyShort: boolean; mediaCount: number; }
export interface SendAttemptRecord extends SendAttemptFacts {
  owner: SendAttemptOwner; state: SendAttemptState; attemptNo: number; attemptedAt: string;
  redriveCount: number; checkNo: number; sid?: string; outcome?: SendAttemptOutcome; cause?: string;
}
export interface AttemptRef { attemptNo: number; attemptedAt: string; }
export type ClaimResult =
  | { outcome: 'claimed'; record: SendAttemptRecord }
  | { outcome: 'takeover'; record: SendAttemptRecord }
  | { outcome: 'refused'; record: SendAttemptRecord; fresh: boolean };
export interface SendAttemptsRepo {
  claim(owner: SendAttemptOwner, facts: SendAttemptFacts, nowIso: string): Promise<ClaimResult>;
  finishAttempt(owner: SendAttemptOwner, ref: AttemptRef, result: { outcome: SendAttemptOutcome; sid?: string; cause?: string }): Promise<boolean>;
  handToReconcile(owner: SendAttemptOwner, ref: AttemptRef, sid?: string): Promise<boolean>;
  takeOver(owner: SendAttemptOwner, record: SendAttemptRecord): Promise<boolean>;
  recordCheck(owner: SendAttemptOwner, attemptedAt: string, checkNo: number): Promise<boolean>;
  markRedriven(owner: SendAttemptOwner, attemptedAt: string): Promise<boolean>;
  closeFromReconcile(owner: SendAttemptOwner, attemptedAt: string, result: { outcome: 'adopted' | 'unresolved' | 'enqueue_failed' | 'redrive_refused'; sid?: string; cause?: string }): Promise<boolean>;
  closeRedriven(owner: SendAttemptOwner, result: { outcome: 'refused' | 'redrive_refused' | 'enqueue_failed' | 'unresolved'; cause?: string }): Promise<boolean>;
  get(owner: SendAttemptOwner): Promise<SendAttemptRecord | undefined>;
  listByRecipient(sender: string, recipientDigest: string, sinceIso: string): Promise<SendAttemptRecord[]>;
}
export function ownerKey(owner: SendAttemptOwner): string;
export function createSendAttemptsRepo(deps?: RepoDeps): SendAttemptsRepo;

// app/src/jobs/registerHandlers.ts  (Task 5): RegisterJobHandlersDeps gains `sendAttemptsRepo?: SendAttemptsRepo`, passed to the three adopters and to send.reconcile.

// app/src/jobs/relayFanOut.ts  (Task 8) - the unit's outcome union and args
export interface RelayLegSendOutcome {
  kind: 'sent' | 'skipped_terminal' | 'suppressed' | 'refused' | 'filtered' | 'rejected' | 'transient' | 'deadline_exceeded' | 'sent_unrecorded' | 'handed_to_reconcile';
  providerSid?: string;
  errorCode?: string;
  attemptRef?: AttemptRef;            // on sent_unrecorded and handed_to_reconcile
  reason?: 'unknown' | 'takeover';    // on handed_to_reconcile
  deferredByClaim?: true;             // on transient: a FOREIGN fresh attempt owns the recipient; no slot was written
}
// sendOneRelayLeg args gain: sendAttempts?: SendAttemptsRepo; owner?: SendAttemptOwner; redrive?: boolean  (optional in Task 8; required from Task 9)

// app/src/jobs/sendReconcile.ts  (Task 7 creates the stub; Task 10 completes it)
export const SEND_RECONCILE_JOB = 'send.reconcile';
export interface SendReconcilePayload {
  owner: SendAttemptOwnerRef;          // the owner with its recipient key HASHED (see Task 10) - never a raw phone
  attemptedAt: string;
  checkNo: number;                     // 0 = first check
  continuation?: { senderKey: string; senderNameOverride?: string };   // relay_leg re-drive context
}
export type SendAttemptOwnerRef =
  | { kind: 'broadcast'; broadcastId: string; recipientKeyHash: string }
  | { kind: 'relay_leg'; relayConversationId: string; sourceTsMsgId: string; recipientKeyHash: string }
  | { kind: 'relay_rung'; relayConversationId: string; retryTsMsgId: string; recipientKeyHash: string };
export function toOwnerRef(owner: SendAttemptOwner): SendAttemptOwnerRef;
export async function enqueueSendReconcile(payload: SendReconcilePayload, delayMs: number): Promise<void>;
export function reconcileCheckDelaysMs(): readonly number[];   // lane-overridable
export function reconcileDelayMs(attemptedAt: string, checkNo: number, nowMs: number): number;   // max(0, attemptedAt + DELAYS[checkNo] - nowMs)
```

Re-drive marker on the three continuation payloads (Tasks 7-9): `redrive?: true`, carried by each parser; a transient re-enqueue STRIPS it.

---

## Slice A - foundations

### Task 1: The classifier, the `messagingErrors` leaf, the widened throttle marker

**Files:**
- Create: `app/src/adapters/messagingErrors.ts` (a leaf; imports nothing)
- Create: `app/src/lib/sendOutcome.ts`
- Create: `app/test/sendOutcome.test.ts`
- Modify: `app/src/adapters/messaging.ts` (delete the class at :383-388 and re-export it from the leaf; `SEND_THROTTLE_CODES` :543)
- Test: `app/test/messaging.test.ts` (one new case)

**Interfaces:**
- Consumes: nothing.
- Produces: `messagingErrors.ts`'s `SmsSendingDisabledError`; everything under `app/src/lib/sendOutcome.ts` in the shared block.

- [ ] **Step 1: Move the adapter's kill-switch error to a leaf (no behavior change)**

Create `app/src/adapters/messagingErrors.ts`:

```ts
// Errors the messaging adapter throws that other leaves must be able to name
// without importing the adapter (the classifier in lib/sendOutcome.ts). Keep
// this file dependency-free.
export class SmsSendingDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
```

In `messaging.ts` delete the class body at `:383-388` (keep its doc comment above a line `export { SmsSendingDisabledError } from './messagingErrors.js';` and add `import { SmsSendingDisabledError } from './messagingErrors.js';` for the driver's own `throw`). Run `npm run typecheck` -> 0 (every importer still resolves the name through `messaging.ts`).

- [ ] **Step 2: Write the failing classifier tests**

```ts
// app/test/sendOutcome.test.ts
import { describe, expect, it } from 'vitest';
import { SmsSendingDisabledError } from '../src/adapters/messagingErrors.js';
import { classifySendFailure } from '../src/lib/sendOutcome.js';

function restException(status: number, code?: number | string, message = 'x'): Error {
  return Object.assign(new Error(message), { status, ...(code !== undefined && { code }) });
}
function networkError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('classifySendFailure (spec D1/D2)', () => {
  it('a code the arms already recognise classifies by code whatever the status says', () => {
    expect(classifySendFailure({ code: 30007 })).toMatchObject({ kind: 'rejected', code: '30007' });
    expect(classifySendFailure({ code: 30005 })).toMatchObject({ kind: 'rejected', code: '30005' });
    expect(classifySendFailure({ code: 30006 })).toMatchObject({ kind: 'rejected', code: '30006' });
    expect(classifySendFailure({ code: 429 })).toMatchObject({ kind: 'retryable', code: '429' });
    expect(classifySendFailure({ code: '30022' })).toMatchObject({ kind: 'retryable', code: '30022' });
    expect(classifySendFailure(restException(500, 30007))).toMatchObject({ kind: 'rejected', code: '30007' });
  });
  it('HTTP 5xx is unknown even with a Twilio code', () => {
    expect(classifySendFailure(restException(503, 20500))).toMatchObject({ kind: 'unknown', code: '20500', status: 503 });
  });
  it('HTTP 4xx is rejected except the rate limit', () => {
    expect(classifySendFailure(restException(400, 21211))).toMatchObject({ kind: 'rejected', code: '21211', status: 400 });
    expect(classifySendFailure(restException(401, 20003))).toMatchObject({ kind: 'rejected', code: '20003' });
    expect(classifySendFailure(restException(429, 20429))).toMatchObject({ kind: 'retryable', code: '20429', status: 429 });
    expect(classifySendFailure(restException(429))).toMatchObject({ kind: 'retryable', status: 429 });
  });
  it('a 4xx with no code (unparseable body) is still rejected - Review Focus 1', () => {
    const c = classifySendFailure(restException(400));
    expect(c).toMatchObject({ kind: 'rejected', status: 400 });
    expect(c.code).toBeUndefined();
  });
  it('a code of 0 (TwilioServiceException default) is no code', () => {
    expect(classifySendFailure(restException(400, 0))).toEqual({ kind: 'rejected', status: 400 });
  });
  it('a connection that never opened is retryable', () => {
    for (const c of ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']) {
      expect(classifySendFailure(networkError(c))).toMatchObject({ kind: 'retryable', code: c });
    }
  });
  it('a timeout or a dropped socket is unknown', () => {
    for (const c of ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE']) {
      expect(classifySendFailure(networkError(c))).toMatchObject({ kind: 'unknown', code: c });
    }
  });
  it('anything it cannot place is unknown (D2), with no code', () => {
    expect(classifySendFailure(new Error('boom'))).toEqual({ kind: 'unknown' });
    expect(classifySendFailure(undefined)).toEqual({ kind: 'unknown' });
    expect(classifySendFailure('string')).toEqual({ kind: 'unknown' });
  });
  it('the adapter-level kill switch is rejected with the sms_sending_disabled token', () => {
    expect(classifySendFailure(new SmsSendingDisabledError('off'))).toEqual({ kind: 'rejected', code: 'sms_sending_disabled' });
  });
});
```

Run: `cd app; npx vitest run test/sendOutcome.test.ts` -> FAIL (module missing).

- [ ] **Step 3: Write the classifier**

```ts
// app/src/lib/sendOutcome.ts
// Send-outcome vocabulary (spec 2026-09-24-send-outcome-reconcile-design, D1-D2,
// D10, D13a). Pure: no I/O, no logging. Imports ONLY the adapter's error leaf,
// so adapters/messaging.ts may import this module's constants at init.
import { SmsSendingDisabledError } from '../adapters/messagingErrors.js';

export type SendFailureKind = 'rejected' | 'retryable' | 'unknown';
export interface SendFailureClassification { kind: SendFailureKind; code?: string; status?: number; }

export const SEND_UNCONFIRMED_CODE = 'send_unconfirmed';
export const SEND_RETRYABLE_CODE = 'send_retryable';
export const REDRIVE_REFUSED_CODE = 'redrive_refused';
export const SMS_SENDING_DISABLED_CODE = 'sms_sending_disabled';
export const TRANSIENT_CAP_CODE = 'transient_cap';
export const ENQUEUE_FAILED_CODE = 'enqueue_failed';
export const SEND_CLAIM_TTL_MS = 30_000;
export const RECONCILE_CHECK_DELAYS_MS: readonly number[] = [5_000, 30_000, 240_000];
export const RECONCILE_WINDOW_LEAD_MS = 60_000;
export const RECONCILE_LIST_PAGE_SIZE = 1000;
export const RECONCILE_MAX_PAGES = 5;
export const OUTAGE_BRAKE_UNKNOWN_STREAK = 3;

const KNOWN_REJECTED_CODES = new Set(['30007', '30005', '30006']);
const KNOWN_RETRYABLE_CODES = new Set(['429', '30022']);
const NETWORK_RETRYABLE = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']);

function codeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'number' && code !== 0) return String(code);
  if (typeof code === 'string' && code.length > 0 && code !== '0') return code;
  return undefined;
}
function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

export function classifySendFailure(err: unknown): SendFailureClassification {
  if (err instanceof SmsSendingDisabledError) return { kind: 'rejected', code: SMS_SENDING_DISABLED_CODE };
  const code = codeOf(err);
  const status = statusOf(err);
  const withMeta = (kind: SendFailureKind): SendFailureClassification => ({
    kind, ...(code !== undefined && { code }), ...(status !== undefined && { status }),
  });
  if (code !== undefined && KNOWN_REJECTED_CODES.has(code)) return withMeta('rejected');
  if (code !== undefined && KNOWN_RETRYABLE_CODES.has(code)) return withMeta('retryable');
  if (status !== undefined) {
    if (status >= 500) return withMeta('unknown');
    if (status === 429) return withMeta('retryable');
    if (status >= 400) return withMeta('rejected');
  }
  if (code !== undefined && NETWORK_RETRYABLE.has(code)) return withMeta('retryable');
  return withMeta('unknown');
}
```

Run: `cd app; npx vitest run test/sendOutcome.test.ts` -> PASS (9 tests).

- [ ] **Step 4: Widen the throttle marker (D4), failing test first**

In `app/test/messaging.test.ts`, next to the existing `send_throttled` case (grep `send_throttled` for the fixture idiom: the driver is built with `client: client as never` and a `createLogCapture()` whose `lines` are JSON strings), add a case that sends once with `Object.assign(new Error('rate'), { status: 429, code: 20429 })` and once with `Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })` thrown by `messages.create`, and asserts exactly ONE captured line contains `"event":"send_throttled"` and it contains `"errorCode":"20429"`.

Run: `cd app; npx vitest run test/messaging.test.ts -t "20429"` -> FAIL.

Change `:543` to `const SEND_THROTTLE_CODES = new Set(['429', '20429', '30022']);` and extend its comment ("20429 is the code twilio-node attaches to a real HTTP 429; the bare 429 stays for the status-only fixtures").

Run: `cd app; npx vitest run test/messaging.test.ts test/sendOutcome.test.ts` -> PASS.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/adapters/messagingErrors.ts app/src/adapters/messaging.ts app/src/lib/sendOutcome.ts app/test/sendOutcome.test.ts app/test/messaging.test.ts
git commit -m "feat(send): classify provider send failures (rejected / retryable / unknown); count 20429 as a throttle" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 2: Fingerprint, digest and key helpers

**Files:**
- Create: `app/src/lib/sendFingerprint.ts`
- Create: `app/test/sendFingerprint.test.ts`

**Interfaces:** Produces `normalizeBodyForMatch`, `bodyFingerprint`, `recipientDigest`, `hashRecipientKey`, `safeRecipientKey` (shared block).

- [ ] **Step 1: Failing tests, using the spike's exact strings (as escapes)**

```ts
// app/test/sendFingerprint.test.ts
import { describe, expect, it } from 'vitest';
import { bodyFingerprint, hashRecipientKey, normalizeBodyForMatch, recipientDigest, safeRecipientKey } from '../src/lib/sendFingerprint.js';

describe('normalizeBodyForMatch (spec D13, Smart Encoding)', () => {
  const submitted = 'HC spike B \u2019quote\u2019 dash\u2014dash more\u2026 ignore';
  const stored = "HC spike B 'quote' dash-dash more... ignore";   // what the 2026-09-24 spike read back
  it('makes the submitted and the Smart-Encoded stored body equal', () => {
    expect(normalizeBodyForMatch(submitted)).toBe(normalizeBodyForMatch(stored));
    expect(bodyFingerprint(submitted).hash).toBe(bodyFingerprint(stored).hash);
  });
  it('keeps letters and digits only, NFKC first', () => {
    expect(normalizeBodyForMatch('\uff28\uff23 42!')).toBe('HC42');
    expect(normalizeBodyForMatch(undefined)).toBe('');
  });
  it('flags a body under three normalized characters as short', () => {
    expect(bodyFingerprint('\u{1f44d}').short).toBe(true);
    expect(bodyFingerprint('ok').short).toBe(true);
    expect(bodyFingerprint('yes').short).toBe(false);
  });
  it('a STOP auto-reply never matches a share body', () => {
    expect(bodyFingerprint('You have successfully been unsubscribed. Reply START to resubscribe.').hash)
      .not.toBe(bodyFingerprint('Hey Cameron, looking for a 1BR? 12 Main St is available.').hash);
  });
});

describe('recipientDigest / hashRecipientKey / safeRecipientKey', () => {
  it('is keyed on the sender and owner-independent, 32 hex chars', () => {
    const a = recipientDigest('+15550009999', '+16175550100');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(recipientDigest('+15550009999', '+16175550100')).toBe(a);
    expect(recipientDigest('+15550001111', '+16175550100')).not.toBe(a);
    expect(recipientDigest(undefined, '+16175550100')).toMatch(/^[0-9a-f]{32}$/);
  });
  it('hashes a phone-bearing recipient key and leaves a contact id alone', () => {
    expect(hashRecipientKey('contact-1')).toBe('contact-1');
    expect(hashRecipientKey('phone#+16175550100')).toMatch(/^phonehash#[0-9a-f]{32}$/);
    expect(hashRecipientKey('phone#+16175550100')).toBe(hashRecipientKey('phone#+16175550100'));
  });
  it('redacts a phone-bearing key for logs', () => {
    expect(safeRecipientKey('phone#+16175550100')).toBe('phone#redacted');
    expect(safeRecipientKey('contact-1')).toBe('contact-1');
  });
});
```

Run: `cd app; npx vitest run test/sendFingerprint.test.ts` -> FAIL.

- [ ] **Step 2: Implement**

```ts
// app/src/lib/sendFingerprint.ts
// Spec D12/D13: the facts a reconcile matches on. LOSSY on purpose - the
// Messaging Service has Smart Encoding on, and the 2026-09-24 spike showed the
// STORED body of a message with a curly quote, an em dash or an ellipsis comes
// back as ', - and ..., so an exact comparison would rule a real orphan
// "never sent" and re-send it.
import { createHash } from 'node:crypto';

export function normalizeBodyForMatch(body: string | undefined): string {
  if (body === undefined) return '';
  return body.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
}
export interface BodyFingerprint { hash: string; short: boolean; }
export function bodyFingerprint(body: string | undefined): BodyFingerprint {
  const normalized = normalizeBodyForMatch(body);
  return { hash: createHash('sha256').update(normalized).digest('hex'), short: normalized.length < 3 };
}
/** Owner-independent, keyed on the sender (D12): the same digest keys the recipient index (D8a). */
export function recipientDigest(sender: string | undefined, destinationE164: string): string {
  return createHash('sha256').update(`${sender ?? ''}|${destinationE164}`).digest('hex').slice(0, 32);
}
/** A recipient key that carries a phone is hashed before it lands in a key or a payload (D8a, D12). */
export function hashRecipientKey(recipientKey: string): string {
  if (!recipientKey.startsWith('phone#')) return recipientKey;
  return `phonehash#${createHash('sha256').update(recipientKey).digest('hex').slice(0, 32)}`;
}
/** For LOG LINES (doc S9): never a phone. */
export function safeRecipientKey(recipientKey: string): string {
  return recipientKey.startsWith('phone#') ? 'phone#redacted' : recipientKey;
}
```

Run -> PASS. Commit:

```bash
git status
git add app/src/lib/sendFingerprint.ts app/test/sendFingerprint.test.ts
git commit -m "feat(send): lossy body fingerprint, owner-independent recipient digest, hashed and redacted recipient keys" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 4: Adapter port - `listMessages` and `getMessage`; the pinned request timeout (D17, D8a)

**Files:**
- Modify: `app/src/adapters/messaging.ts` (`MessagingAdapter` :150-268; `TwilioClientLike` :423-432; driver constructor :623-637; add methods to `TwilioMessagingDriver` and `ConsoleMessagingDriver`)
- Modify the typed adapter fakes: `app/test/helpers/twilioWebhookHarness.ts:3766`, `app/test/scheduledSendSuppression.test.ts:355`, `app/test/sendMessage.test.ts:318`, `app/test/tourReminders.test.ts:2579`, `app/test/poolNumbers.test.ts:174,:213`, `app/test/relayWarm.test.ts:59`
- Test: `app/test/messaging.test.ts`

**Interfaces:**
- Consumes: `SEND_CLAIM_TTL_MS` (Task 1).
- Produces: `ProviderMessageSummary`, `ListMessagesArgs`, `ListMessagesPage`, the two port methods, `TWILIO_REQUEST_TIMEOUT_MS`; console driver test seams `_consoleSentMessagesForTests()` / `_resetConsoleSentMessagesForTests()`; the harness adapter records `{ params, sid, providerTs }` on `world.sent` (additive - existing tests read `world.sent[i].to` etc. through `params`? NO: today `world.sent` holds `prepared.params` directly (`:3775-3783`), so keep the array's element shape as `params` PLUS add `sid` and `providerTs` properties onto the same object - `Object.assign({}, prepared.params, { sid, providerTs })`); the harness adapter's `listMessages` answers from `world.sent` plus `world.providerMessages: ProviderMessageSummary[]` (seedable), paginating at `world.listPageSize` (default 1000); `getMessage` looks both up by SID.

- [ ] **Step 1: Failing driver tests** - as in revision 1 (a callable fake `messages` with `page`, `getPage`, `create`, and `(sid) => ({ fetch })`), asserting: `page` called with `{ to, from, pageSize: 1000 }`; two summaries in order; `createdAt` ISO from an RFC 2822 string; `sentAt` undefined when `date_sent` is null; `nextPageToken` = `nextPageUrl`; `getPage(token)` for the second page; `getMessage` maps a 404 (`status 404` or `code 20404`) to undefined; `TWILIO_REQUEST_TIMEOUT_MS === SEND_CLAIM_TTL_MS`; and a page whose instances exceed the requested size logs ONE WARN `list page exceeded the requested size` (the D17 UNVERIFIED guard).

- [ ] **Step 2: Implement** - as in revision 1, with: `summarize()` accepting SDK instances (`dateCreated: Date`, `numMedia`, `errorCode`) and raw resources; the driver's `listMessages` WARNs when `page.instances.length > args.pageSize`; `client.messages.page`/`getPage` optional on `TwilioClientLike`; the constructor passes `timeout: TWILIO_REQUEST_TIMEOUT_MS`; the console driver's module-level log capped at 1000 entries (drop the oldest); `_consoleSentMessagesForTests` / `_resetConsoleSentMessagesForTests` exported.

- [ ] **Step 3: Typed fakes** - each listed fake gains `listMessages: async () => ({ messages: [] }), getMessage: async () => undefined`; the harness adapter as in Interfaces.

Run: `cd app; npx vitest run test/messaging.test.ts` -> PASS. `npm run typecheck` -> 0.

- [ ] **Step 4: Commit**

```bash
git status
git add app/src/adapters/messaging.ts app/test/messaging.test.ts app/test/helpers/twilioWebhookHarness.ts app/test/scheduledSendSuppression.test.ts app/test/sendMessage.test.ts app/test/tourReminders.test.ts app/test/poolNumbers.test.ts app/test/relayWarm.test.ts
git commit -m "feat(adapter): listMessages and getMessage on the messaging port; pin the Twilio request timeout to the claim TTL" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 5: The send-attempt record repo and its wiring (D8a, D11, D12)

**Files:**
- Create: `app/src/repos/sendAttemptsRepo.ts`
- Create: `app/test/sendAttemptsRepo.integration.test.ts` (DynamoDB Local)
- Modify: `app/src/lib/tables.ts:213-230` (add the two families to the TTL comment list)
- Modify: `app/src/jobs/registerHandlers.ts:46-73` (`RegisterJobHandlersDeps.sendAttemptsRepo?`; passed through - the adopters accept it from Task 7 on; until then the field is threaded but unused)
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (`world.sendAttempts`, `world.sendAttemptsRepo` modelling every condition; returned from `createFakeWorld()`)
- Create: `app/test/twilioWebhookHarnessSendAttempts.test.ts` (harness parity)
- Modify: EVERY test file that registers an adopted handler (find them: `grep -l -E "registerBroadcastSendJobHandler|registerRelayFanOutJobHandler|registerRelayRetryLegJobHandler|registerAllJobHandlers" app/test/*.ts app/test/**/*.ts`) so each passes `sendAttemptsRepo: world.sendAttemptsRepo` - the lazy default inside the handlers is a REAL DynamoDB repo (Task 7-9 add `sendAttempts ??= deps.sendAttemptsRepo ?? createSendAttemptsRepo(...)`), and a fake-world test that omits it would open a real connection on its first job run. Do this wiring NOW (the field is accepted and ignored until Tasks 7-9 read it) so no later task turns a green file red.

**Interfaces:**
- Consumes: `hashRecipientKey` (Task 2); `SEND_CLAIM_TTL_MS` (Task 1); `RepoDeps`.
- Produces: everything under `app/src/repos/sendAttemptsRepo.ts` in the shared block, plus `SEND_ATTEMPT_PARTITION_PREFIX = 'sendattempt#'`, `SEND_ATTEMPT_INDEX_PREFIX = 'sendattemptix#'`, `SEND_ATTEMPT_CLEANUP_MS = 30 * 24 * 60 * 60 * 1000`.

**Key shapes (messages table):**
- Record item: `conversationId = 'sendattempt#' + ownerKey(owner)`, `tsMsgId = hashRecipientKey(recipientKey)`; `ownerKey` is `broadcast#<broadcastId>` | `relay#<conversationId>#<sourceTsMsgId>` | `rung#<conversationId>#<retryTsMsgId>`; attributes `attempt_state` (never `state` - reserved), `attempt_no`, `attempted_at`, `redrive_count`, `check_no`, `sid?`, `outcome?`, `cause?`, `recipient_digest`, `sender` (null when unset), `body_hash`, `body_short`, `media_count`, `owner` (map), `expires_at` (epoch seconds, now + 30 d).
- Index item: `conversationId = 'sendattemptix#' + (sender ?? '-') + '#' + recipientDigest`, `tsMsgId = attemptedAt + '#' + ownerKey + '#' + hashedRecipientKey`; attributes `owner`, `attempted_at`, `body_hash`, `body_short`, `media_count`, `expires_at`. Written in the SAME TransactWrite as the claim; never updated (the record is read for live state).

**Every expression lists its own names and values.** The helper is:

```ts
async function transition(owner: SendAttemptOwner, expr: { update: string; condition: string; names: Record<string, string>; values: Record<string, unknown> }): Promise<boolean> {
  try {
    await doc.send(new UpdateCommand({ TableName: table, Key: recordKey(owner), UpdateExpression: expr.update, ConditionExpression: expr.condition, ExpressionAttributeNames: expr.names, ExpressionAttributeValues: expr.values }));
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}
```

and each method passes EXACTLY the aliases its strings use, e.g.:

```ts
finishAttempt: (owner, ref, result) => transition(owner, {
  update: `SET #st = :done, #oc = :oc${result.sid !== undefined ? ', #sid = :sid' : ''}${result.cause !== undefined ? ', #ca = :ca' : ''}`,
  condition: '#st = :attempting AND #no = :no AND #at = :at',
  names: { '#st': 'attempt_state', '#oc': 'outcome', '#no': 'attempt_no', '#at': 'attempted_at', ...(result.sid !== undefined && { '#sid': 'sid' }), ...(result.cause !== undefined && { '#ca': 'cause' }) },
  values: { ':done': 'done', ':oc': result.outcome, ':attempting': 'attempting', ':no': ref.attemptNo, ':at': ref.attemptedAt, ...(result.sid !== undefined && { ':sid': result.sid }), ...(result.cause !== undefined && { ':ca': result.cause }) },
}),
handToReconcile: (owner, ref, sid) => transition(owner, {
  update: `SET #st = :reconciling, #ck = :zero${sid !== undefined ? ', #sid = :sid' : ''}`,
  condition: '#st = :attempting AND #no = :no AND #at = :at',
  names: { '#st': 'attempt_state', '#ck': 'check_no', '#no': 'attempt_no', '#at': 'attempted_at', ...(sid !== undefined && { '#sid': 'sid' }) },
  values: { ':reconciling': 'reconciling', ':zero': 0, ':attempting': 'attempting', ':no': ref.attemptNo, ':at': ref.attemptedAt, ...(sid !== undefined && { ':sid': sid }) },
}),
takeOver: (owner, record) => transition(owner, {
  update: 'SET #st = :reconciling, #ck = :zero',
  condition: '#st = :attempting AND #no = :no AND #at = :at',
  names: { '#st': 'attempt_state', '#ck': 'check_no', '#no': 'attempt_no', '#at': 'attempted_at' },
  values: { ':reconciling': 'reconciling', ':zero': 0, ':attempting': 'attempting', ':no': record.attemptNo, ':at': record.attemptedAt },
}),
recordCheck: (owner, attemptedAt, checkNo) => transition(owner, {
  update: 'SET #ck = :ck',
  condition: '#st = :reconciling AND #at = :at AND (#ck = :prev OR #ck = :ck)',
  names: { '#st': 'attempt_state', '#ck': 'check_no', '#at': 'attempted_at' },
  values: { ':ck': checkNo, ':prev': checkNo - 1, ':reconciling': 'reconciling', ':at': attemptedAt },
}),
markRedriven: (owner, attemptedAt) => transition(owner, {
  update: 'SET #st = :redriven, #rc = :one',
  condition: '#st = :reconciling AND #at = :at AND #rc = :zero',
  names: { '#st': 'attempt_state', '#rc': 'redrive_count', '#at': 'attempted_at' },
  values: { ':redriven': 'redriven', ':one': 1, ':zero': 0, ':reconciling': 'reconciling', ':at': attemptedAt },
}),
closeFromReconcile: (owner, attemptedAt, result) => transition(owner, {
  update: `SET #st = :done, #oc = :oc${result.sid !== undefined ? ', #sid = :sid' : ''}${result.cause !== undefined ? ', #ca = :ca' : ''}`,
  condition: '#st = :reconciling AND #at = :at',
  names: { '#st': 'attempt_state', '#oc': 'outcome', '#at': 'attempted_at', ...(result.sid !== undefined && { '#sid': 'sid' }), ...(result.cause !== undefined && { '#ca': 'cause' }) },
  values: { ':done': 'done', ':oc': result.outcome, ':reconciling': 'reconciling', ':at': attemptedAt, ...(result.sid !== undefined && { ':sid': result.sid }), ...(result.cause !== undefined && { ':ca': result.cause }) },
}),
closeRedriven: (owner, result) => transition(owner, {
  update: `SET #st = :done, #oc = :oc${result.cause !== undefined ? ', #ca = :ca' : ''}`,
  condition: '#st = :redriven',
  names: { '#st': 'attempt_state', '#oc': 'outcome', ...(result.cause !== undefined && { '#ca': 'cause' }) },
  values: { ':done': 'done', ':oc': result.outcome, ':redriven': 'redriven', ...(result.cause !== undefined && { ':ca': result.cause }) },
}),
```

The claim's TransactWrite Update item lists, per branch (`absent` / `retryable` / `redriven`), exactly the names and values that branch's `ConditionExpression` and `UpdateExpression` use (write three small builders rather than one spread). `claim()`'s decision tree is as in revision 1 (optimistic create; then read; `done/retryable` and `redriven` advance with `attemptNo + 1`; `attempting` older than `SEND_CLAIM_TTL_MS` -> `takeover`; fresh `attempting` -> `refused fresh`; `reconciling` / other `done` -> `refused !fresh`). `get()` is a `ConsistentRead: true` GetCommand. `listByRecipient` is a consistent Query on the index partition (`tsMsgId >= :since`, `ScanIndexForward: false`, paged), resolving each hit's live record through `get()`.

- [ ] **Step 1: Failing integration tests** - the nine cases of revision 1 (create/refused-fresh; hashed sort key; `finishAttempt` fenced on attemptNo AND attemptedAt; a SID refuses later claims; retryable/redriven claimable with attemptNo advancing and redriveCount untouched; stale attempting = takeover and the late outcome write refused; recordCheck tolerant of its duplicate; closeFromReconcile / closeRedriven forward-only and idempotent; listByRecipient newest first since a bound) PLUS: `closeRedriven` accepts `enqueue_failed` and `unresolved`; and ONE test per transition that runs it against DynamoDB Local and asserts no ValidationException (the unused-alias trap) - the nine cases already exercise every method, so assert each returns a boolean rather than throwing.
- [ ] **Step 2: Implement** as above (`toRecord`, `ownerKey`, key helpers, `expiresAt`, the three claim builders, `transition`, `listByRecipient`); add both families to `tables.ts`'s TTL list; `RegisterJobHandlersDeps.sendAttemptsRepo?`.
- [ ] **Step 3: Harness fake + parity test** as in revision 1 (the fake applies the same conditions in memory; the parity test runs a scripted transition table against both, real half `describe.skipIf(!reachable)`).
- [ ] **Step 4: Wire every registration site** found by the grep to pass `sendAttemptsRepo: world.sendAttemptsRepo` (or the file's own world name). Run the whole app suite once here: `cd app; npx vitest run` -> all green (the field is ignored until Task 7).
- [ ] **Step 5: Typecheck, commit**

```bash
git status
git add app/src/repos/sendAttemptsRepo.ts app/test/sendAttemptsRepo.integration.test.ts app/src/lib/tables.ts app/src/jobs/registerHandlers.ts app/test/helpers/twilioWebhookHarness.ts app/test/twilioWebhookHarnessSendAttempts.test.ts <every test file the grep listed>
git commit -m "feat(repos): the per-recipient send-attempt record and its recipient index, every transition fenced on the attempt; test worlds wired" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 6: Repo additions the send sites and the reconcile job need (D8, D11, D13, D15, D16a, D22)

**Files:**
- Modify: `app/src/repos/messagesRepo.ts` (interface :1307-1912; `AppendResult` :1259-1264 and both return sites :2558 dedupe / :2598-2632 fresh; impl near :2035-2062, :3178-3201, :3661-3682, :3784-3821, :3855-3861; `RelayRecipientDelivery` :159-169 gains `attemptedAt?: string`)
- Modify: `app/src/repos/broadcastsRepo.ts` (`BroadcastStats` :85-125 gains `unconfirmed?: number`; `deriveBroadcastStats` :254-306; `zeroStats` :309-321; interface :344-442; impl :454-457, :497-523, :671-717, :760-801)
- Modify the typed repo fakes: `app/test/helpers/twilioWebhookHarness.ts` (:1080 messages, :2902 broadcasts), `app/test/sendMessage.test.ts:233`, `app/test/scheduledSendSuppression.test.ts:273`
- Tests to extend: `app/test/relayRepos.integration.test.ts`, `app/test/broadcastsRepo.integration.test.ts`, `app/test/deriveBroadcastStats.test.ts`
- Tests that go RED from `AppendResult.conversationId` and must be updated in this task: the exact-shape `toEqual`s at `app/test/messaging.integration.test.ts:137, :141, :152, :155` and `app/test/groupSendRepo.integration.test.ts:240` (add `conversationId`), and any harness fake `append` returning `{ deduped, tsMsgId }` (add the field); `app/test/broadcastApi.test.ts:1269-1279` (results stats full `toEqual` gains `unconfirmed: 0`).

**Interfaces:**
- Consumes: `SEND_UNCONFIRMED_CODE` (Task 1).
- Produces (messagesRepo):
  - `getByProviderSidConsistent(sid)`, `getRelaySidPointerConsistent(providerSid)`, `getSystemSidMarkerConsistent(providerSid)`, `listByConversationConsistent(conversationId, opts?)` - consistent twins.
  - `claimRelaySidPointer(providerSid, ref): Promise<'created' | 'mine' | 'other'>`.
  - `closeRelayRecipientIfUnsent(conversationId, tsMsgId, memberKey, delivery: { status: 'failed'; errorCode: string }): Promise<'closed' | 'skipped_sent' | 'missing'>` - two statements: (1) `SET #dr.#mk.#st = :failed, #dr.#mk.#ec = :ec` with `ConditionExpression: 'attribute_exists(tsMsgId) AND attribute_exists(#dr.#mk) AND #dr.#mk.#st = :queued AND attribute_not_exists(#dr.#mk.#sid)'`, names `{ '#dr': 'delivery_recipients', '#mk': memberKey, '#st': 'status', '#ec': 'errorCode', '#sid': 'sid' }`, values `{ ':failed': 'failed', ':ec': errorCode, ':queued': 'queued' }`; on CCF (2) `SET #dr.#mk = :fresh` with `ConditionExpression: 'attribute_exists(tsMsgId) AND attribute_not_exists(#dr.#mk)'`, names `{ '#dr', '#mk' }`, values `{ ':fresh': { status: 'failed', errorCode } }`; on a second CCF a consistent read decides `'missing'` vs `'skipped_sent'`. Works on legacy and versioned rows alike (child fields; a versioned row's `requestedTransport` and `transportAggregationState` survive).
  - `adoptRelayRecipientIfUnsent(conversationId, tsMsgId, memberKey, patch: { status: DeliveryStatus; sid: string; sentAt: string; errorCode?: string }): Promise<'adopted' | 'skipped' | 'missing'>` - on a versioned row delegates to `applyRecipientSendResult` (`updated` -> adopted; `idempotent`/`stale`/`conflict` -> skipped; else missing); on a legacy row a child-field `SET #dr.#mk.#st = :st, #dr.#mk.#sid = if_not_exists(#dr.#mk.#sid, :sid), #dr.#mk.#sa = if_not_exists(#dr.#mk.#sa, :sa)[, #dr.#mk.#ec = :ec]` conditioned on `attribute_exists(#dr.#mk) AND #dr.#mk.#st IN (:queued, :sent)` - never `markRecipient`'s wholesale SET (D15: a raced receipt is never regressed).
  - `setRelayRecipientAttemptedAt(conversationId, tsMsgId, memberKey, attemptedAt): Promise<void>` - (1) `SET #dr.#mk = if_not_exists(#dr.#mk, :seed)` conditioned on `attribute_exists(tsMsgId)` (`:seed = { status: 'queued' }`), (2) `SET #dr.#mk.#at = :at` conditioned on `attribute_exists(#dr.#mk)`; names `{ '#dr', '#mk', '#at': 'attemptedAt' }`; a CCF on (2) is WARNed and swallowed (best-effort).
  - `AppendResult` gains `conversationId: string` (fresh: the input's; dedupe: `ptr.ref_conversationId`).
- Produces (broadcastsRepo):
  - `getByIdConsistent(broadcastId)`.
  - `recordRecipientOutcome(broadcastId, contactKey, recipient: BroadcastRecipient, statsDelta: Partial<BroadcastStats>, allowedPriorStatuses: ReadonlyArray<BroadcastRecipient['status']>): Promise<{ moved: boolean; item?: BroadcastItem }>` - ONE UpdateCommand `SET recipients.#ck = :rec, #updatedAt = :now ADD stats.#a0 :v0[, ...]` with `ConditionExpression: 'attribute_exists(broadcastId) AND recipients.#ck.#status IN (:ps0, ...)'`, names `{ '#ck': contactKey, '#updatedAt': 'updated_at', '#status': 'status', '#a0': <bucket>, ... }` only for the buckets present with a non-zero delta, `ReturnValues: 'ALL_NEW'`; CCF -> `{ moved: false }`.
  - `closeRecipientIfQueued(broadcastId, contactKey, errorCode, statsBucket: 'failed' | 'unconfirmed')` = `recordRecipientOutcome(..., { status: 'failed', errorCode }, { [statsBucket]: 1, queued: -1 }, ['queued'])`.
  - `finalizeStatus(broadcastId, status: 'sent' | 'failed', lastError?): Promise<{ won: boolean; item: BroadcastItem }>` - `flipStatus`'s expression with `ConditionExpression: 'attribute_exists(broadcastId) AND #s = :sending'` (values `{ ':status', ':now', ':sending': 'sending'[, ':err'] }`), `ReturnValues: 'ALL_NEW'`; on CCF a consistent read -> `{ won: false, item }`.
  - `deriveBroadcastStats` routes `failed` + `send_unconfirmed` to `unconfirmed`; `zeroStats` includes `unconfirmed: 0`.

- [ ] **Step 1: Failing relay-side tests** - revision 1's six cases plus: `adoptRelayRecipientIfUnsent` on a legacy row adopts from `queued`, keeps an earlier `sentAt`, and returns `skipped` when a receipt already moved the slot to `delivered` (write it first with `updateRecipientDeliveryStatus`); on a versioned row returns `adopted` once and `skipped` on the re-run.
- [ ] **Step 2: Implement the messagesRepo additions** as in Interfaces; update the three typed fakes (the harness's `closeRelayRecipientIfUnsent` / `adoptRelayRecipientIfUnsent` / `claimRelaySidPointer` model the absent / queued-no-sid / delivered / mine / other cases).
- [ ] **Step 3: Failing broadcast-side tests** - revision 1's three cases plus the `deriveBroadcastStats` bucket test and the 50-slot invariant widened; update the RED pins listed under Files.
- [ ] **Step 4: Implement the broadcastsRepo additions**; update the typed BroadcastsRepo fakes.
- [ ] **Step 5: Run the touched suites and typecheck**

Run: `cd app; npx vitest run test/relayRepos.integration.test.ts test/broadcastsRepo.integration.test.ts test/deriveBroadcastStats.test.ts test/broadcastApi.test.ts test/messaging.integration.test.ts test/groupSendRepo.integration.test.ts` -> PASS. `npm run typecheck` -> 0.

- [ ] **Step 6: Commit**

```bash
git status
git add app/src/repos/messagesRepo.ts app/src/repos/broadcastsRepo.ts app/test/relayRepos.integration.test.ts app/test/broadcastsRepo.integration.test.ts app/test/deriveBroadcastStats.test.ts app/test/broadcastApi.test.ts app/test/messaging.integration.test.ts app/test/groupSendRepo.integration.test.ts app/test/helpers/twilioWebhookHarness.ts app/test/sendMessage.test.ts app/test/scheduledSendSuppression.test.ts
git commit -m "feat(repos): conditional recipient closes and adoptions, consistent reads, a reporting SID claim, an idempotent finalize flip and the unconfirmed bucket" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Slice B - the send sites

### Task 3: Typed errors from `sendMessage` (D3) - lands immediately before Task 7

**Files:**
- Modify: `app/src/services/sendMessage.ts` (errors block after `:191`; steps at `:332`, `:361`, `:431-439`, `:465-475`, `:479-519`, `:523-539`)
- Test: `app/test/sendMessage.test.ts` (extend `makeFakes` overrides at `:57-66`; add cases)

**Interfaces:**
- Consumes: `classifySendFailure` (Task 1); `bodyFingerprint`, `recipientDigest` (Task 2); `SendAttemptFacts` (Task 5 - import the TYPE from `../repos/sendAttemptsRepo.js`; a type import keeps this module a leaf at runtime).
- Produces: `SendNotAttemptedError`, `ProviderSendFailedError` (with own `code` and `status` mirroring the cause), `SendAcceptedNotRecordedError`; the post-append swallow. Behavior change for EVERY caller: a non-refusal throw is now one of these three classes, and a post-append failure no longer throws (the staff send route answers 201 where it answered 500). `retrySend.ts` is unchanged and rethrows these as before; the broadcast arms keep matching because `errorCodeOf(err)` still reads `code`/`status` off the wrapper.

- [ ] **Step 1: Extend the fixture seams** in `makeFakes` (read `:57-66` and the fake methods first; add `getByIdError`, `findByPhoneError`, `incrementError`, `appendError`, `touchError`, `auditError` overrides thrown at the matching fake methods).
- [ ] **Step 2: Failing tests** - revision 1's six cases, using the file's real fixtures (its live-contact fixture name, its `env` object, its `capture.atLevel('error')` string lines), plus: `ProviderSendFailedError` exposes `code` and `status` equal to the cause's (`expect(err.code).toBe(20500); expect(err.status).toBe(503)`), and `errorCodeOf`-style reading (`(err as { code?: unknown }).code`) works.
- [ ] **Step 3: Implement** - revision 1's classes and wrapping (`notAttempted()` helper that never wraps a `SendRefusedError`; facts computed ONCE from `bodyFingerprint(body)`, `recipientDigest(sender, participantPhone)`, `mediaCount = mediaUrls?.length ?? attachments?.length ?? 0`; `ProviderSendFailedError` sets `this.code = (cause as {code?}).code` and `this.status = (cause as {status?}).status` when present; the append wrapped into `SendAcceptedNotRecordedError`; the touch/audit swallowed with ERROR `outbound message sent but a post-append step failed (best-effort)`; `conversation.updated` emitted only when the touch succeeded). Update the file's step comments.
- [ ] **Step 4: Run, typecheck, commit**

Run: `cd app; npx vitest run test/sendMessage.test.ts` -> PASS (parity block `:936-970` green). `npm run typecheck` -> 0.

```bash
git status
git add app/src/services/sendMessage.ts app/test/sendMessage.test.ts
git commit -m "feat(send): typed non-refusal errors from sendMessage that keep the provider code readable; post-append failures no longer fail a sent text" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 7: The broadcast fan-out (D5-D9, D7a, D8, D8a, D13a, D16a)

**Files:**
- Modify: `app/src/jobs/broadcastFanOut.ts` (parser :124-143; handler :218-688; `closeBroadcast` :287-324; loop :373-622; continuation :642-683; `finalize` :723-771; the header comment and the `TODO(throw-for-redelivery-defeated-by-job-marker)` block :609-620 are rewritten)
- Create: `app/src/jobs/sendReconcile.ts` (STUB: `SEND_RECONCILE_JOB`, `SendReconcilePayload`, `SendAttemptOwnerRef`, `toOwnerRef`, `enqueueSendReconcile`, `reconcileCheckDelaysMs`, `reconcileDelayMs` - Task 10 adds the handler)
- Test: `app/test/broadcastFanOut.test.ts`

**Interfaces:**
- Consumes: Tasks 1-6; the stub above.
- Produces: `BroadcastSendPayload.redrive?: true` (parsed); `BroadcastSendJobDeps.sendAttemptsRepo?: SendAttemptsRepo` (lazy default `createSendAttemptsRepo`); `export async function finalize(...)` (already a function; export it) and `export async function adoptBroadcastRecipient(deps: AdoptDeps, args: { broadcastId: string; contactKey: string; providerSid: string; providerTs: string; providerStatus: string; errorCode?: string; body: string; mediaCount: number; sentAt?: string }): Promise<'adopted' | 'other_owner' | 'skipped'>` - the D15 write set, called by Task 10 INSIDE its candidate loop: resolves the contact and the conversation (the reads the pass makes), appends the row (`automated: broadcast.created_via !== 'dashboard'`, `recipientContactId` only when `contactHoldsPhone`); an append that dedupes onto a row whose `broadcast_id` differs -> `'other_owner'`; then the slot via `recordRecipientOutcome` (status per D15; `carrierSentAt` = `sentAt` when present; `conversationId`+`tsMsgId`; `['queued']` prior) -> `moved: false` -> `'skipped'`; when moved: stats bump (same write), the audit row (its `automated` from the same rule), the preserving inbox touch (`touchLastActivityPreservingStatus(conversationId, undefined, providerTs)` only when the conversation's `last_activity_at` < `providerTs`), the emits, and - only for an adopted `sent`/`delivered` - the milestone and the listing-send row; the 30005/30006 unreachable flag on an adopted failure with those codes.

**The recipient unit (one outer try/catch per recipient; nothing throws out):**

```
for (const contactKey of keys) {
  const owner = { kind: 'broadcast', broadcastId, contactKey };
  let ref: AttemptRef | undefined;
  try {
    slot terminal? -> continue
    PREPARE (pre-claim): resolveContact; the five fences (writes unchanged; on a REDRIVE pass each fence also closeRedriven(owner, { outcome: 'refused', cause: <fence code> }));
                         createOrGetByParticipantPhone; renderBody
    facts = { recipientDigest: recipientDigest(config.businessPhoneNumber, contact.phone), sender?: config.businessPhoneNumber, ...bodyFingerprint(body), mediaCount: 0 }
    CLAIM: c = await sendAttempts.claim(owner, facts, nowIso)
      refused & fresh:  if payload.recipientKeys -> transientRemaining.push(contactKey) (defer again); continue   (no slot write)
      refused & !fresh: continue
      takeover:         if (!(await sendAttempts.takeOver(owner, c.record))) { INFO; continue }
                        await handOff(owner, c.record.attemptedAt) ; continue          // handOff = enqueueSendReconcile or close unresolved on enqueue throw; NOT counted toward the brake
      claimed:          ref = { attemptNo, attemptedAt }; secondUnknownWouldClose = c.record.redriveCount >= 1
    SEND: outcome = await sendMessage({...unchanged...})
    RECORD: r = await recordRecipientOutcome(id, contactKey, { conversationId, tsMsgId, status: 'sent' }, { sent: 1, queued: -1 }, ['queued'])
            if (r.moved) emitBroadcastProgress(r.item)
            await sendAttempts.finishAttempt(owner, ref, { outcome: 'sent', sid: outcome.providerSid })
            best-effort (each in its own try/catch): tokenBucket.acquire(1); milestone; listing-send
            sentCount += 1; streak = 0
  } catch (err) {
    if (ref === undefined) {                       // a PRE-CLAIM throw: nothing sent, no record
      if (err instanceof SendRefusedError) { unreachable pre-claim; treat as below }
      defer: setRecipient(id, contactKey, { status: 'queued', errorCode: SEND_RETRYABLE_CODE }); transientRemaining.push(contactKey); WARN 'prepare failed - deferred'; streak = 0; continue
    }
    if (err instanceof SendRefusedError) { slot skipped + bump (unchanged); finishAttempt(ref, { outcome: 'refused', cause: err.code }); streak = 0; continue }
    if (err instanceof SendNotAttemptedError) { setRecipient queued + SEND_RETRYABLE_CODE; transientRemaining.push; finishAttempt(ref, { outcome: 'retryable', cause: SEND_RETRYABLE_CODE }); streak = 0; continue }
    if (err instanceof SendAcceptedNotRecordedError) { ERROR 'sent_unrecorded' {sid}; handToReconcile(ref, err.providerSid); handOff(owner, ref.attemptedAt); continue }   // not counted toward the brake
    if (err instanceof ProviderSendFailedError) switch (err.classification.kind) {
      rejected:  code = err.classification.code; existing 30007 / 30005-30006 arms by code (writes unchanged) else recordRecipientOutcome(failed + code, { failed: 1, queued: -1 }, ['queued']); finishAttempt(ref, { outcome: 'rejected', cause: code ?? String(err.classification.status) }); streak = 0; continue
      retryable: setRecipient queued + (code ?? SEND_RETRYABLE_CODE)  // NEVER a network string: code is defined only for provider codes; a network code maps to SEND_RETRYABLE_CODE
                 transientRemaining.push; finishAttempt(ref, { outcome: 'retryable', cause: ... }); streak = 0; continue
      unknown:   if (secondUnknownWouldClose) { closeRecipientIfQueued(id, contactKey, SEND_UNCONFIRMED_CODE, 'unconfirmed'); finishAttempt(ref, { outcome: 'unresolved', cause: 'second_unknown' }); ERROR; continue }   // D13a
                 handToReconcile(ref); handOff(owner, ref.attemptedAt); streak += 1; if (streak >= OUTAGE_BRAKE_UNKNOWN_STREAK) { brake }
    }
    else { ERROR 'recipient unit failed after the claim' { err, owner }; if the send is known to have happened (a RECORD-phase throw: outcome was assigned) -> handToReconcile(ref, outcome.providerSid) + handOff; else finishAttempt(ref, { outcome: 'retryable', cause: 'send_retryable' }) + defer; continue }
  }
}
BRAKE: for every key not yet attempted in this pass -> transientRemaining; WARN { event: 'outage_brake', deferred: n }; break
```

`handOff(owner, attemptedAt)`: `try { await enqueueSendReconcile({ owner: toOwnerRef(owner), attemptedAt, checkNo: 0 }, reconcileDelayMs(attemptedAt, 0, Date.now())) } catch (err) { closeRecipientIfQueued(id, contactKey, SEND_UNCONFIRMED_CODE, 'unconfirmed'); sendAttempts.closeFromReconcile(owner, attemptedAt, { outcome: 'unresolved', cause: 'enqueue_failed' }); ERROR }`.

For `retryable`, the code written is the PROVIDER code when `classification.code` is a Twilio code (all digits) and `SEND_RETRYABLE_CODE` otherwise (a network string like `ECONNREFUSED` never reaches a slot - D6).

Pass-level changes (as revision 1, restated): consistent snapshot for continuations/re-drives; the up-front pass claim skipped on `redrive`; the post-loop claim only with a remainder; the `claim === undefined` guard claims instead of closing; `closeBroadcast` gated per D8 (absent / done-retryable -> conditional close; stale attempting -> takeOver + handOff; other states skip with INFO); `finalize` per D16a (consistent read; any `queued` slot -> deferred INFO; decision from the map; prose `last_error`; `finalizeStatus`; audit + emit + INFO only when won, INFO gains `unconfirmed`); `sendAttempts` lazy default; header comment rewritten; the TODO block deleted; ASCII log lines.

- [ ] **Step 1: Failing tests (extend `app/test/broadcastFanOut.test.ts`)** - use the file's fixtures (`seedTenant`, `seedBroadcast`, `wireHandler` now passing `sendAttemptsRepo: world.sendAttemptsRepo`; reconcile-related cases wire `testConfig({ ...env, BUSINESS_PHONE_NUMBER: '+15550009999' })` so the record has a sender; provider errors injected on `world.adapter.sendPreparedMessage`; enqueues read from `outbound.delayed`; the queue-refusal seam from `:735-740`). Named tests:
  1. `an unknown error on recipient 3 of 5 leaves 4 and 5 attempted, 3 handed to reconcile, no throw` - **must fail on main**; asserts slot 3 untouched (`{ status: 'queued' }`), record `reconciling`, one `send.reconcile` envelope with `owner.recipientKeyHash === hashRecipientKey('t-3')`, `checkNo: 0`, `delaySeconds: 5`, broadcast still `sending`.
  2. `a claimed recipient whose sendMessage refuses closes done/refused, slot skipped, no reconcile` (Review Focus 3; flip the conversation to manual so the automated share refuses).
  3. `a prepare-phase throw defers the recipient as send_retryable with no record` (make `createOrGetByParticipantPhone` throw once; slot `{ status: 'queued', errorCode: 'send_retryable' }`, continuation lists it, no record) - Sec 8 test 4.
  4. `three consecutive unknowns brake the pass; the untried remainder is deferred` and `a sent between two unknowns resets the streak` and `three rejected do not brake` and `three retryable do not brake`.
  5. `a record-phase failure after a successful send hands the SID to reconcile and never re-sends` and `a SendAcceptedNotRecordedError does the same` (Sec 8 test 4).
  6. `a reconcile enqueue that throws closes the recipient unresolved on the spot` (slot failed/send_unconfirmed, `stats.unconfirmed` 1, record done/unresolved cause enqueue_failed, broadcast finalized `failed` with the prose).
  7. `two passes for the same recipient produce ONE provider call` (seed a fresh claim; run; deferred, no send) and `a stale attempting record is taken over into reconcile` (attemptedAt 31 s ago; expect record reconciling with the OLD attemptedAt, one reconcile envelope, NOT counted toward the brake).
  8. `a cap-close closes only records that are absent or done/retryable and takes over a stale attempting one` (three keys: none / fresh attempting / stale attempting / reconciling; assert each).
  9. `a re-drive pass claims no ladder rung up front and its fence closes the redriven record done/refused` and `a re-drive attempt that comes back unknown closes unresolved with no second reconcile` (record `redriveCount: 1`; Sec 8 test 10).
  10. `a retryable with a network code writes send_retryable, never the network string` (ECONNREFUSED -> slot code `send_retryable`).
  11. finalize: `N callers produce one flip, one audit row, one terminal emit`; `all skipped plus one unconfirmed finalizes failed with the prose` (Review Focus 5); `decides from the recipients map when the persisted failed counter is stale`; `pass-then-verdict and verdict-then-pass both finalize exactly once` (drive Task 10's handler - this test is WRITTEN here but marked `it.skip` until Task 10, and un-skipped in Task 10's commit).
  12. Update the RED pins: `finalize log` `toMatchObject` (`:368-379`) gains `unconfirmed: 0`; the `setRecipient` spy at `:1075-1109` ("records the sent recipient slot BEFORE acquiring") now spies `recordRecipientOutcome`.

- [ ] **Step 2: Implement** per the unit block and the pass-level list.
- [ ] **Step 3: Run the file, typecheck** -> PASS (the five `toEqual` slot pins at `:324, :359, :432-437, :495, :513` untouched). `npm run typecheck` -> 0.
- [ ] **Step 4: Commit**

```bash
git status
git add app/src/jobs/broadcastFanOut.ts app/src/jobs/sendReconcile.ts app/test/broadcastFanOut.test.ts
git commit -m "feat(broadcast): classified send outcomes, a claim before every send, reconcile hand-off, the outage brake and an idempotent finalize" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 8: The relay leg and the fan-out loop (D5-D9, D7a, D8, D8a, D13a)

**Files:**
- Modify: `app/src/jobs/relayFanOut.ts` (parser :152-186; `RelayLegSendOutcome` :1234-1245; `sendOneRelayLeg` :1270-1514; `runRelayFanOutExecution` :1002-1203 incl. `closeRelay` :1081-1110; `RelayFanOutJobDeps` :636-672; `RelayFanOutExecutionDeps` :960-970; header)
- Test: `app/test/relayFanOut.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 5, 6; the Task 7 stub.
- Produces: the shared block's `RelayLegSendOutcome` and the OPTIONAL unit args `sendAttempts?`, `owner?`, `redrive?` ("absent = the pre-claim legacy path: no claim, no record, and an unknown error is returned as `handed_to_reconcile` with NO attemptRef" - the rung passes none until Task 9, which then makes them required); `RelayFanOutPayload.redrive?: true`; `RelayFanOutJobDeps.sendAttemptsRepo?`; `RelayFanOutExecutionDeps.sendAttempts` and `consistent: boolean`.

**The unit (claim after the acquire, before the presign; one outer try/catch around everything after the terminal skip):**

```
terminal skip (unchanged)
suppression arm: BEFORE its writes, if sendAttempts && owner: rec = get(owner); if rec exists and is a FOREIGN open attempt (attempting fresh / reconciling / (redriven and !redrive)) -> return { kind: 'transient', errorCode: SEND_RETRYABLE_CODE, deferredByClaim: true }   (D8 gate)
                 writes unchanged; when redrive: closeRedriven(owner, { outcome: 'refused', cause: 'contact_opted_out' }); return suppressed
acquire (unchanged; deadline_exceeded returns BEFORE any claim)
facts = { recipientDigest: recipientDigest(poolNumber, member.phone), sender: poolNumber, ...bodyFingerprint(legBody), mediaCount: hasMedia && mediaStore ? sourceMedia.length : 0 }
CLAIM (when sendAttempts && owner): c = claim(owner, facts, nowIso)
   refused fresh  -> return { kind: 'transient', errorCode: SEND_RETRYABLE_CODE, deferredByClaim: true }   (no slot write)
   refused !fresh -> return { kind: 'skipped_terminal' }
   takeover       -> if (!(await takeOver(owner, c.record))) return { kind: 'skipped_terminal' }; return { kind: 'handed_to_reconcile', reason: 'takeover', attemptRef: { attemptNo: c.record.attemptNo, attemptedAt: c.record.attemptedAt } }
   claimed        -> ref; secondUnknownWouldClose = c.record.redriveCount >= 1
best-effort setRelayRecipientAttemptedAt (WARN on failure)
try {
  presign; params; prepare; aggregation 'attempted'                       // a throw here -> catch below with sent === false
  SEND
  catch (send):
    SendRefusedError -> unchanged slot write; finishAttempt(refused, err.code); return refused
    classify: rejected -> 30007: unchanged arm; finishAttempt(rejected,'30007'); return filtered
                          else persist failed + code (SMS_SENDING_DISABLED_CODE for the kill switch); finishAttempt(rejected, code); return { kind: 'rejected', errorCode: code }
              retryable -> code = digits ? classification.code : SEND_RETRYABLE_CODE; persist queued + code; finishAttempt(retryable, code); return transient
              unknown   -> if secondUnknownWouldClose: closeRelayRecipientIfUnsent(... SEND_UNCONFIRMED_CODE); finishAttempt(unresolved,'second_unknown'); return { kind: 'rejected', errorCode: SEND_UNCONFIRMED_CODE }   // terminal; the caller counts it as closed
                           handToReconcile(ref); return { kind: 'handed_to_reconcile', reason: 'unknown', attemptRef: ref }
  RECORD: persistRelayRecipientResult (unchanged, FIRST); claimRelaySidPointer (SECOND; 'other' -> ERROR + treat as sent_unrecorded); finishAttempt(sent, sid); return sent
} catch (err) {
  if the send happened (result assigned): ERROR 'sent_unrecorded'; handToReconcile(ref, sid); return { kind: 'sent_unrecorded', providerSid: sid, attemptRef: ref }
  else (a pre-send throw after the claim): finishAttempt(ref, { outcome: 'retryable', cause: SEND_RETRYABLE_CODE }); persist queued + SEND_RETRYABLE_CODE; return transient
}
```

The fan-out loop: counts as revision 1; `handed_to_reconcile` / `sent_unrecorded` -> `handOff` (enqueue with `owner: toOwnerRef(owner)`, `continuation: { senderKey, senderNameOverride? }`; enqueue throw -> `closeRelayRecipientIfUnsent(... SEND_UNCONFIRMED_CODE)` + `closeFromReconcile(unresolved, 'enqueue_failed')` + ERROR); the D9 streak counts only `handed_to_reconcile` with `reason: 'unknown'`; a `transient` with `deferredByClaim` joins `transientRemaining` with no slot write; a `rejected` with `SEND_UNCONFIRMED_CODE` counts as closed; the loop's own outer try/catch per member turns any other throw into ERROR + continue; `closeRelay` gated per D8 (absent / done-retryable -> `closeRelayRecipientIfUnsent`; stale attempting -> takeOver + handOff; others skip); the up-front pass claim skipped on `redrive`, the post-loop claim only with a remainder, the `claim?.outcome !== 'claimed'` guard claims instead of closing; consistent snapshot reads when `payload.recipientKeys !== undefined`; early returns on a re-drive pass close each carried member's record `redrive_refused` and its slot `REDRIVE_REFUSED_CODE`; the transient continuation payload never carries `redrive`.

- [ ] **Step 1: Failing tests (extend `app/test/relayFanOut.test.ts`)** - revision 1's cases (unknown on member 2 of 4 on legacy AND versioned, **must fail on main**; a `queued`+sid success refuses a second claim; the token-bucket `[[1],[1]]` pin; close B pin + a reconciling member skipped; the adapter kill switch; the record-phase failure; brake + streak-reset + three-retryable; the re-drive pass) plus: `a foreign open attempt on the suppression arm defers the member instead of writing a terminal slot` (D8 gate); `a re-drive attempt that comes back unknown closes unresolved` (D13a); `mediaCount on the record equals the source media count when a store exists and 0 without one`; `the fan-out's relaysid# claim reports other and the leg is handed to reconcile as sent_unrecorded`; `a pre-send throw after the claim (presign fails) releases the record done/retryable and defers`.
- [ ] **Step 2: Implement**; rewrite the unit docblock and the module header; delete `throw err` at `:1492`.
- [ ] **Step 3: Run, typecheck, commit**

```bash
git status
git add app/src/jobs/relayFanOut.ts app/test/relayFanOut.test.ts
git commit -m "feat(relay): the leg claims before the send, classifies the failure and hands unknown outcomes to reconcile; the loop brakes and closes through the record gate" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 9: The relay retry rung (D7a exception, D8, D16, Sec 2a RSW #1/#5/#6/#7)

**Files:**
- Modify: `app/src/jobs/relayRetryLeg.ts` (parser :252-263; deps :115-146; the gate/window sites :532-558, :586-606; the send call :626-654; the outcome chain :657-803; `refuseGate` :487-505)
- Modify: `app/src/jobs/relayFanOut.ts` (make `sendAttempts`, `owner` REQUIRED on the unit now that both callers pass them; delete the "absent = legacy path" branch)
- Test: `app/test/relayRetryLeg.test.ts`

**Interfaces:**
- Consumes: Task 8's unit; Tasks 5, 6; the stub.
- Produces: `RelayRetryLegPayload.redrive?: true`; `RelayRetryLegJobDeps.sendAttemptsRepo?`.

- [ ] **Step 1: Failing tests** - revision 1's cases (handed_to_reconcile enqueues for the rung with `owner.kind 'relay_rung'` and `recipientKeyHash`; sent_unrecorded defers the touch; rejected emits the root close; enqueue throw closes unresolved; re-driven rung declined by the window gate closes the record done/refused with `retry_window_closed`; re-driven deadline_exceeded closes the record (RSW pins byte-identical); a foreign fresh attempt defers via the transient sub-ladder) plus: `a foreign open attempt makes refuseGate skip its write with a WARN` (Sec 8 test 12's "RSW window close refuses a recipient with a FOREIGN open attempt"); `a transient re-enqueue of a re-driven rung does not carry redrive`; the compile-time exhaustiveness is a `never` assertion in the switch (no runtime test).
- [ ] **Step 2: Implement** - parser; owner + deps threading; the D8 read before `refuseGate`'s and the window close's writes (skip + WARN on a foreign open attempt; `closeRedriven(refused, code)` on a re-drive pass); the exhaustive `switch` with arms for every kind (incl. `rejected` -> the ERROR + `announceRootClose`; `handed_to_reconcile` -> handOff with `owner: toOwnerRef(rungOwner)`; `sent_unrecorded` -> ERROR + handOff, no touch; `sent` -> the touch wrapped); the transient re-enqueue strips `redrive`; enqueue-failure close as Task 8.
- [ ] **Step 3: Run, typecheck, commit**

Run: `cd app; npx vitest run test/relayRetryLeg.test.ts test/relayWindowCloseMirror.test.ts test/relayFanOut.test.ts` -> PASS. `npm run typecheck` -> 0.

```bash
git status
git add app/src/jobs/relayRetryLeg.ts app/src/jobs/relayFanOut.ts app/test/relayRetryLeg.test.ts
git commit -m "feat(relay-retry): the rung owns its re-driven record, gates its pre-claim closes, handles every outcome kind explicitly" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Slice C - the reconcile job

### Task 10: `send.reconcile` (D11-D16)

**Files:**
- Modify: `app/src/jobs/sendReconcile.ts` (the stub becomes the job)
- Modify: `app/src/jobs/registerHandlers.ts` (register; pass `sendAttemptsRepo`; update the job-set test that pins the registered names - find it with `grep -l registeredJobNames app/test`)
- Create: `app/test/sendReconcile.test.ts` (unit, fake world), `app/test/sendReconcile.integration.test.ts` (DynamoDB Local)
- Modify: `app/test/broadcastFanOut.test.ts` (un-skip the pass/verdict ordering test from Task 7)

**Interfaces:**
- Consumes: Tasks 1-9; `enqueue`; `mapTwilioStatus`; `finalize` and `adoptBroadcastRecipient` (Task 7); `adoptRelayRecipientIfUnsent`, `claimRelaySidPointer`, `closeRelayRecipientIfUnsent`, the consistent reads (Task 6); `touchLastActivityPreservingStatus`; `isMemberSuppressed`.
- Produces: `registerSendReconcileJobHandler(deps: SendReconcileJobDeps)`, `SendReconcileJobDeps { adapter?, messagesRepo?, broadcastsRepo?, contactsRepo?, conversationsRepo?, sendAttemptsRepo?, activityEventsRepo?, listingSendsRepo?, auditRepo?, events?, logger?, config? }`.

**Owner resolution.** The payload's `SendAttemptOwnerRef` carries `recipientKeyHash`. The handler resolves the raw key: broadcast - `getByIdConsistent(broadcastId)` and the key `k` in `recipients` with `hashRecipientKey(k) === recipientKeyHash`; relay - the source/retry row (consistent) and the key in `delivery_recipients`, else the roster member whose `hashRecipientKey(relayMemberKey(m))` matches (a legacy row may have no slot yet). No match -> INFO `owner recipient not found` and return (the record, if any, is left for the sweeper - a Sec 1 residue).

**Handler flow:**

```
payload = parse(raw); owner = resolve(payload.owner) ; record = sendAttempts.get(owner)
if (!record || record.state !== 'reconciling' || record.attemptedAt !== payload.attemptedAt) -> INFO 'reconcile superseded'; return
if (!(await sendAttempts.recordCheck(owner, payload.attemptedAt, payload.checkNo + 1))) -> INFO 'check already recorded'; return
verdict = record.sid !== undefined ? await adoptKnown(record) : await lookup(owner, record, payload.checkNo)
switch (verdict.kind):
  found      -> (adoption already applied inside lookup/adoptKnown for owners whose claim IS the adoption write; see below) closeFromReconcile(owner, attemptedAt, { outcome: 'adopted', sid }); INFO; afterClose(owner)
  continue   -> next = payload.checkNo + 1 (always < 3 here); enqueueSendReconcile({ ...payload, checkNo: next }, reconcileDelayMs(attemptedAt, next, Date.now()))
  never_sent -> redrive(owner, record, payload.continuation)
  unresolved -> closeUnresolved(owner, record, verdict.cause)
afterClose(owner): broadcast -> finalize(...); relay_rung -> announceRootClose
```

`enqueueOrClose(run)` wraps EVERY enqueue in the job: on throw, if the record is `redriven` (a `never_sent` whose re-drive enqueue failed) -> `closeRedriven(owner, { outcome: 'enqueue_failed', cause })`, slot `ENQUEUE_FAILED_CODE` (broadcast `closeRecipientIfQueued(..., 'failed')`; relay `closeRelayRecipientIfUnsent`), ERROR, `afterClose`; otherwise -> `closeUnresolved(cause 'enqueue_failed')`.

`lookup(owner, record, checkNo)` (D13):

```
sender = record.sender; if (!sender) -> unresolved 'no_sender'
currentPhone = currentRecipientPhone(owner)   // broadcast: resolveContact(contactKey)?.phone; relay: the roster member's phone or a phone# key's number
if (!currentPhone || recipientDigest(sender, currentPhone) !== record.recipientDigest) -> unresolved 'digest_mismatch'
windowStartMs = Date.parse(record.attemptedAt) - RECONCILE_WINDOW_LEAD_MS
candidates = []; pages = 0; token = undefined; providerError = undefined
do { try { page = await adapter.listMessages({ to: currentPhone, from: sender, pageSize: RECONCILE_LIST_PAGE_SIZE, pageToken: token }) } catch (err) { providerError = err; break }
     pages += 1; candidates.push(...page.messages.filter((m) => Date.parse(m.createdAt) >= windowStartMs))
     token = page.nextPageToken; if (token !== undefined && pages >= RECONCILE_MAX_PAGES) return unresolved 'page_bound'
} while (token !== undefined)
if (providerError) return isLast(checkNo) ? unresolved 'provider_unreachable' : continue
unmatched = []
for m of candidates sorted by createdAt ascending:
   held = await heldBy(m.providerSid)      // consistent: sid# pointer -> the row (its broadcast_id / conversationId) ; relaysid# -> ref ; syssid# marker -> 'system'
   if (held === 'system' || held === 'other') continue
   if (held === 'mine') return await adopt(owner, record, m, { repair: true })
   if (!matches(record, m)) { unmatched.push(m); continue }
   r = await adopt(owner, record, m, { repair: false })      // the adoption's OWN claim decides: broadcast = the row append (dedupe -> 'other_owner' unless the row is ours); relay = claimRelaySidPointer ('other' -> continue)
   if (r.kind === 'found') return r ; else continue
if (!isLast(checkNo)) return continue
if (unmatched.length > 0) return unresolved 'unidentified_candidate'
siblings = await sendAttempts.listByRecipient(sender, record.recipientDigest, new Date(windowStartMs).toISOString())
if (siblings.some((s) => ownerKey(s.owner) !== ownerKey(owner) && s.bodyHash === record.bodyHash && s.mediaCount === record.mediaCount && (s.state !== 'done' || s.outcome === 'adopted'))) return unresolved 'same_fingerprint_sibling'
return never_sent
matches(record, m) = record.bodyShort ? m.mediaCount === record.mediaCount : bodyFingerprint(m.body).hash === record.bodyHash
adoptKnown(record) = m = await adapter.getMessage(record.sid); if (!m) throw new Error('known SID not found at the provider')   // a genuine retry
                     return adopt(owner, record, m, { repair: false })
```

`adopt(owner, record, m, opts)` per owner (D15), each idempotent as a whole:
- **broadcast**: `r = await adoptBroadcastRecipient(deps, { broadcastId, contactKey, providerSid: m.providerSid, providerTs: m.createdAt, providerStatus: m.providerStatus, errorCode: m.errorCode, body: m.body, mediaCount: m.mediaCount, sentAt: m.sentAt })`; `'other_owner'` -> `{ kind: 'other' }`; `'adopted' | 'skipped'` -> `{ kind: 'found', sid }`.
- **relay_leg / relay_rung**: `c = await claimRelaySidPointer(m.providerSid, { conversationId, tsMsgId: sourceTsMsgId | retryTsMsgId, memberKey })`; `'other'` -> `{ kind: 'other' }`; then `adoptRelayRecipientIfUnsent(conversationId, tsMsgId, memberKey, { status: relayStatusFor(m), sid, sentAt: m.sentAt ?? m.createdAt, errorCode? })` (`skipped`/`adopted` both `found`; `missing` -> throw); relay_rung additionally `touchLastActivityPreservingStatus(conversationId, undefined, m.createdAt)` when the conversation's `last_activity_at < m.createdAt`; an adopted terminal failure WARNs `adopted terminal failure - webhook side effects skipped` naming the code.

`statusFor`: provider `accepted|queued|sending|sent` -> broadcast `sent`, relay `queued` for `accepted|queued|sending` else `sent`; `delivered|read` -> `delivered`; `undelivered` -> broadcast `failed` + code, relay `undelivered` + code; `failed|canceled` -> `failed` + code. `carrierSentAt` (broadcast) / `sentAt` (relay) from `m.sentAt` whenever present.

`redrive(owner, record, continuation)` (D16): broadcast -> `markRedriven` (false -> if `record.redriveCount >= 1` then `closeUnresolved('second_unknown')` else return) -> `enqueueOrClose(enqueue(BROADCAST_SEND_JOB, { broadcastId, recipientKeys: [contactKey], attempt: (b.fanout_attempt ?? 0) + 1, redrive: true }))`; relay_leg -> pre-check (conversation open, member on roster, source present) else `closeRelayRecipientIfUnsent(... REDRIVE_REFUSED_CODE)` + `closeFromReconcile(redrive_refused, cause)`; `markRedriven` as above; `enqueueOrClose(enqueue(RELAY_FANOUT_JOB, { relayConversationId, sourceTsMsgId, senderKey: continuation.senderKey, senderNameOverride?, recipientKeys: [memberKey], attempt: (source.fanout_attempt ?? 0) + 1, redrive: true }))` (no `continuation` -> `redrive_refused` cause `no_continuation`); relay_rung -> the pre-check, then `enqueueOrClose(enqueue(RELAY_RETRY_LEG_JOB, { relayConversationId, retryTsMsgId, redrive: true }))`.

`closeUnresolved(owner, record, cause)`: broadcast `closeRecipientIfQueued(id, key, SEND_UNCONFIRMED_CODE, 'unconfirmed')`; relay `closeRelayRecipientIfUnsent(..., { status: 'failed', errorCode: SEND_UNCONFIRMED_CODE })`; then `closeFromReconcile(owner, attemptedAt, { outcome: 'unresolved', cause })` (or `closeRedriven` when the record is `redriven`); ONE ERROR `{ event: 'send_reconcile', verdict: 'unresolved', cause, owner: <kind + ids>, recipientKey: safeRecipientKey(key) }`; `afterClose`.

Logging (D16/D18): `found` INFO, `never_sent` WARN, `unresolved` ERROR; never a body or phone.

- [ ] **Step 1: Failing unit tests (`app/test/sendReconcile.test.ts`)** over `createFakeWorld()` + the jobs envelope; the harness adapter's `listMessages` answers from `world.sent` (Task 4) plus `world.providerMessages`; reconcile-related worlds set `BUSINESS_PHONE_NUMBER` so records have a sender. Cases 1-18 of revision 1, renumbered and tightened:
  1 known SID via `getMessage` (spy: no `listMessages`, no digest check); 2 listed `delivered` orphan adopts on a broadcast (row `automated: true`, `recipient_contact_id` when held, `carrierSentAt` set, milestone + listing-send written, finalized `sent`); 3 `undelivered` 30005 adoption (broadcast: `failed` + flag, no milestone; relay: `undelivered` + code, no flag); 4 empty at check 0, populated at check 1 (delay of the check-1 envelope = `reconcileDelayMs(attemptedAt, 1, now)`); 5 held by ANOTHER owner excluded, held by THIS owner repairs; 5b a `syssid#` candidate is excluded; 6 Smart-Encoded body matches; media-only matches on count; 7 two text attempts, two orphans -> each adopts one; 8 two MEDIA attempts, one orphan -> one adopted, the other `unresolved` `same_fingerprint_sibling` at the last check; 9 STOP auto-reply -> `continue` at checks 0-1, `unresolved` `unidentified_candidate` at check 2; 10 page walk (`world.listPageSize = 2`) and `page_bound`; 11 empty window -> `never_sent`, one re-drive envelope with `redrive: true`, a second `never_sent` delivery enqueues nothing; 12 adapter throws on every check -> `unresolved` `provider_unreachable`, exactly one ERROR; 13 digest mismatch -> `unresolved` (Review Focus 2); 13b a candidate created 59 s before the attempt is considered (Review Focus 4); 14 older `attemptedAt` writes nothing; a redelivered check records once and converges; 14b `unresolved` delivered twice writes once; 15 relay `never_sent` on a closed group -> `redrive_refused`; on an open group -> a `relay.fanOut` envelope with `redrive: true` and the continuation's `senderKey`; 16 relay_rung adoption touches the inbox the preserving way and every close emits the root close; 17 an enqueue throw after `never_sent` closes `enqueue_failed` (record via `closeRedriven`, slot `enqueue_failed`, finalize runs); after any other verdict `unresolved` `enqueue_failed`; 18 `reconcileCheckDelaysMs` honors `E2E_SEND_RECONCILE_DELAYS_MS` only when `JOBS_QUEUE_URL` is unset; 19 a known-SID `getMessage` throw propagates (a genuine retry); 20 `markRedriven` false on a `redriveCount >= 1` record closes `unresolved` `second_unknown`; 21 the payload carries only the hashed recipient key (assert no `phone#+` substring in any enqueued payload for a phone-keyed recipient) and the handler resolves it.
- [ ] **Step 2: Failing integration test** - revision 1's (adoption twice = one pointer/row/slot move/bump/transition; adoption cannot regress a receipt).
- [ ] **Step 3: Implement** the job, registration (+ the job-set pin), un-skip Task 7's ordering test.
- [ ] **Step 4: Run, typecheck, commit**

Run: `cd app; npx vitest run test/sendReconcile.test.ts test/sendReconcile.integration.test.ts test/broadcastFanOut.test.ts test/relayFanOut.test.ts test/relayRetryLeg.test.ts` and the registerHandlers test -> PASS. `npm run typecheck` -> 0.

```bash
git status
git add app/src/jobs/sendReconcile.ts app/src/jobs/registerHandlers.ts app/test/sendReconcile.test.ts app/test/sendReconcile.integration.test.ts app/test/broadcastFanOut.test.ts <the registerHandlers test file>
git commit -m "feat(jobs): send.reconcile - look an ambiguous send up at the provider, adopt it, re-drive it once, or close it unresolved" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Slice E - dashboard (before Slice D: the e2e reads the chip)

### Task 13: Codes, copy, aging and the join (D20, D20a, D21, D23)

**Files:**
- Modify: `dashboard/src/routes/contact/deliveryStatus.ts` (`RelayDeliverySlot` :157-163 gains `attemptedAt?: string`; `stalenessClockMs` :228-255; `presentRelayDelivery` K/J :483-505 and the reason join :567-570; `presentLegDelivery` :668-770; `INTERNAL_CODE_REASONS` :927-958; `deliveryReason` :1006)
- Modify: `dashboard/src/api/types.ts:1753-1773` (`RelayRecipientDelivery.attemptedAt?: string`, mirror comment)
- Create: `dashboard/src/routes/contact/sendOutcomeCodesMirror.test.ts`
- Tests to extend: `deliveryStatus.test.ts`, `Timeline.delivery.test.tsx`, `Timeline.ticker.test.tsx`, `relayRetryJoin.test.ts`, `useRelayThread.test.tsx`
- Tests that go RED and are updated here: the `transient_cap` copy pins at `deliveryStatus.test.ts:377, :781, :839, :876, :894`, `Timeline.delivery.test.tsx:388, :396-397, :423` (and `StatChips.test.tsx:152`, `broadcastFormat.test.ts:153` in Task 14).

**Interfaces:**
- Consumes: the app constants (mirror test only; the dashboard imports app VALUES only in `*Mirror.test.ts` files, the `relayWindowCloseMirror.test.ts` idiom - `app/src/lib/sendOutcome.ts` imports only the adapter's error leaf, which has no Node types, so the dashboard tsconfig compiles it).
- Produces: `SEND_UNCONFIRMED_CODE`, `REDRIVE_REFUSED_CODE`, `SEND_RETRYABLE_CODE`, `SMS_SENDING_DISABLED_CODE` exported from `deliveryStatus.ts`; `NOT_CONFIRMED_PRESENTATION: DeliveryPresentation = { label: 'Not confirmed', tone: 'danger', isFailure: false, reason: "Couldn't confirm whether this text went out" }`.

- [ ] **Step 1: Failing tests** - as revision 1: `send_unconfirmed` presents by code alone on `failed`, `undelivered` AND `queued` slots; the rollup counts it under J with the reason; no trailing period; the four internal codes' prose (`it.each`); `send_retryable` yields no reason; D20a aging (`queued` + `attemptedAt`, no `sentAt` -> stale after the budget; neither clock -> never; `sentAt` wins); the three-position Timeline case for an `undelivered` root leg whose terminal rung code is `send_unconfirmed`; a ticker ARMING case for `queued` + `attemptedAt`; a `relayRetryJoin` terminal projection case; a `useRelayThread` passthrough assertion for `attemptedAt`; the mirror test (four constants equal the app's; prose for the three closed codes; `undefined` for `send_retryable`).
- [ ] **Step 2: Implement** - constants + `NOT_CONFIRMED_PRESENTATION`; `INTERNAL_CODE_REASONS` entries (`send_unconfirmed`, `redrive_refused`, `sms_sending_disabled`; `transient_cap` re-worded); `deliveryReason` returns `undefined` for `send_retryable`; `presentLegDelivery` code arm right after the `contact_opted_out` arm; `presentRelayDelivery`'s K excludes the code, J includes it, branch-2's reason join includes those legs; `stalenessClockMs` `queued` -> `legClock ?? parseWireClock(slot.attemptedAt)` with the doc table and the `:213-224` rationale rewritten (no "server staleness alarm"); the two type mirrors.
- [ ] **Step 3: Run, typecheck, commit**

Run: `npm run test -w @housingchoice/dashboard -- src/routes/contact src/routes/conversation` -> PASS. `npm run typecheck -w @housingchoice/dashboard` -> 0.

```bash
git status
git add dashboard/src/routes/contact/deliveryStatus.ts dashboard/src/api/types.ts dashboard/src/routes/contact/sendOutcomeCodesMirror.test.ts dashboard/src/routes/contact/deliveryStatus.test.ts dashboard/src/routes/contact/Timeline.delivery.test.tsx dashboard/src/routes/contact/Timeline.ticker.test.tsx dashboard/src/routes/contact/relayRetryJoin.test.ts dashboard/src/routes/conversation/useRelayThread.test.tsx
git commit -m "feat(dashboard): Not confirmed by code alone, the new internal codes' copy, and a queued leg that ages from its attempt clock" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 14: The broadcast bucket, chip, badge, hint and seeds (D22)

**Files:**
- Modify: `dashboard/src/api/types.ts:2906-2929` (`BroadcastStats.unconfirmed?: number`)
- Modify: `dashboard/src/routes/broadcasts/broadcastFormat.ts` (`presentRecipientStatus` :126-142 gains `errorCode?: string`), `StatChips.tsx:27-36` (chip after Failed; header doc), `DeliveryBadge.tsx:34` (pass `errorCode`), `BroadcastResults.tsx:47-89` (split `failed` into `failedStyle` for the class + sort and `showRetryHint` = `failed && errorCode !== 'send_unconfirmed' && contactId !== undefined`)
- Modify: `app/src/lib/seed/matrix.ts:1229-1231, :1252` and `app/src/lib/seed/performance.ts:995-1009` (`unconfirmed: 0`)
- Tests to extend: `StatChips.test.tsx` (the label ORDER pin `:75-86` gains `'Not confirmed'` after `'Failed'`; the `transient_cap` pin `:152`), `broadcastFormat.test.ts` (`:153` pin; new cases), `BroadcastResults.test.tsx`; run `app/test/performanceSeed.test.ts`.

- [ ] **Step 1: Failing tests** - as revision 1 (chip order and value; legacy stats without the bucket -> 0 and no danger class; `presentRecipientStatus('failed', undefined, 'send_unconfirmed')` -> `NOT_CONFIRMED_PRESENTATION`; `shareRecipientReason('failed', 'send_unconfirmed')` -> the prose; `skippedTotal` never includes it; an unconfirmed row reads `Not confirmed` with its reason, has the failed styling and sorts first, and offers NO retry hint).
- [ ] **Step 2: Implement** as listed.
- [ ] **Step 3: Run, typecheck, commit**

Run: `npm run test -w @housingchoice/dashboard -- src/routes/broadcasts`; `cd app; npx vitest run test/performanceSeed.test.ts test/deriveBroadcastStats.test.ts` -> PASS. `npm run typecheck` -> 0.

```bash
git status
git add dashboard/src/api/types.ts dashboard/src/routes/broadcasts/broadcastFormat.ts dashboard/src/routes/broadcasts/StatChips.tsx dashboard/src/routes/broadcasts/DeliveryBadge.tsx dashboard/src/routes/broadcasts/BroadcastResults.tsx dashboard/src/routes/broadcasts/StatChips.test.tsx dashboard/src/routes/broadcasts/broadcastFormat.test.ts dashboard/src/routes/broadcasts/BroadcastResults.test.tsx app/src/lib/seed/matrix.ts app/src/lib/seed/performance.ts
git commit -m "feat(dashboard): the Not confirmed bucket and chip, the unconfirmed recipient row without a retry hint, seeds carry the bucket" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Slice D - fake-twilio and e2e (after Slice E)

### Task 11: fake-twilio - Messages list and fetch routes, the fail-next-send and fail-list seams (D19)

**Files:**
- Modify: `fake-twilio/src/routes/rest.ts` (the create handler :33-70; add GET list and GET fetch)
- Modify: `fake-twilio/src/routes/control.ts` (add `POST /control/fail-next-send` and `POST /control/fail-list`)
- Modify: `fake-twilio/src/engine/engine.ts` (`recordOutboundFromApp` :404-536; add `setFailNextSend`, `takeFailNextSend(partyNumber)`, `setFailList`, `takeFailList(partyNumber)`, `getMessageBySid(sid)`, `listMessagesTo(to, from)`; `reset()` clears both maps), `fake-twilio/src/engine/store.ts` (`messageBySid`), `fake-twilio/src/engine/types.ts`
- Test: `fake-twilio/test/rest.test.ts`, `fake-twilio/test/control.test.ts`
- Modify: `e2e/fixtures/fakeTwilio.ts` (add `failNextSend(request, input)`, `failList(request, input)`, `getMessageBySid(request, sid)` on the `setDeliveryOutcome` pattern at `:354`)

**Interfaces (produced):**
- `GET /2010-04-01/Accounts/:accountSid/Messages.json?To=&From=&PageSize=&PageToken=` -> `{ messages: [...], next_page_uri (path with PageToken, or null), page, page_size, first_page_uri, previous_page_uri, uri, start, end }`, newest first; `PageToken` = the fake's integer offset; default page size 50, max 1000.
- `GET /2010-04-01/Accounts/:accountSid/Messages/:sid.json` -> one resource, or `404 { code: 20404, message, more_info, status: 404 }`.
- Resource: `sid, status, to, from, body (SMART-ENCODED at serialization: U+2018/U+2019 -> ', U+201C/U+201D -> ", U+2013/U+2014 -> -, U+2026 -> ..., U+00A0 -> space), num_media (string), error_code (int or null), date_created (RFC 2822 from the stored createdAt - ONE clock per message), date_sent (RFC 2822 or null while queued), messaging_service_sid, direction: 'outbound-api'`. The create response still echoes the submitted body.
- `POST /control/fail-next-send { partyNumber, mode: 'reject' | 'drop_before_create' | 'accept_then_drop', code?, count? }` -> `{ ok: true }`; consumed by the next `count` creates TO that party: `reject` -> `400 { code: code ?? 21211, message: 'fail-next-send: rejected by the fake', more_info, status: 400 }` and nothing recorded; `drop_before_create` -> `req.socket.destroy()` and nothing recorded; `accept_then_drop` -> recorded (callbacks fire as normal), then `req.socket.destroy()` with no response.
- `POST /control/fail-list { partyNumber, count? }` -> the next `count` list OR fetch calls whose `To` (list) or resource `to` (fetch) is that party answer `500 { code: 20500, message: 'fail-list: provider unavailable', more_info, status: 500 }`. This is how the e2e and the self-QA drive `unresolved` deterministically.
- `e2e/fixtures/fakeTwilio.ts`: `failNextSend`, `failList`, `getMessageBySid`.

- [ ] **Step 1: Failing fake tests** - revision 1's cases (list newest first with paging; Smart-Encoded storage vs the echoing create; 404 shape; `reject` recorded nothing and is consumed; `accept_then_drop` records and drops; `drop_before_create`) plus `fail-list makes the next list and fetch for that party answer 500, then recovers`.
- [ ] **Step 2: Implement** as in Interfaces (the `smartEncode` helper exported for the test; `toMessageResource`; the create handler's hook points before and after `recordOutboundFromApp`; the two control routes with input validation; the engine maps keyed by party number; `reset()` clears them).
- [ ] **Step 3: Run, commit**

Run: `npm run test -w @housingchoice/fake-twilio` -> PASS.

```bash
git status
git add fake-twilio/src/routes/rest.ts fake-twilio/src/routes/control.ts fake-twilio/src/engine/engine.ts fake-twilio/src/engine/store.ts fake-twilio/src/engine/types.ts fake-twilio/test/rest.test.ts fake-twilio/test/control.test.ts e2e/fixtures/fakeTwilio.ts
git commit -m "feat(fake-twilio): Messages list and fetch with Smart-Encoded bodies; fail-next-send and fail-list control seams" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 12: Lane seams and the four e2e specs (D13a, D19, Sec 8)

**Files:**
- Modify: `scripts/e2e-session.mjs` `childEnv` (beside `:272-282`): `E2E_SEND_RECONCILE_DELAYS_MS: '2000,4000,8000'` with a comment naming this branch and the topology guard.
- Create: `e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts`
- Possibly modify: `e2e/support/selectors.md` (a new role/label, if any is introduced - the chip is a `<dt>` inside `getByLabel('Delivery stats')`; a recipient row is text inside `getByRole('list', { name: 'Recipients' })`).

**Before writing a line, READ these and use their real names and shapes:** `e2e/fixtures/relay.ts` (or wherever `createGroupOpen` lives - `grep -rn "createGroupOpen" e2e/`; note its real signature and what it returns: the conversation id, the pool number, the member numbers/labels), `e2e/fixtures/fakeTwilio.ts` (`sendAsParty`, `getOutboundTo`, `listThreads`, Task 11's helpers), the login/reseed helpers under `e2e/support` (`grep -rn "dev-login\|reseed" e2e/support e2e/fixtures`), the broadcasts spec (`e2e/tests/dashboard-next/broadcasts.spec.ts:269-287` `statValue` / `statusPill` - extract to `e2e/support/broadcastSelectors.ts` if file-local; and how that spec CREATES and SENDS a share through the API - reuse its helper or its request sequence), and `share-skip-fix.spec.ts:255-290` (how it creates a tenant WITH consent, how it reads the Recipients list). Every intro/announcement text a relay group sends on creation must be SETTLED (poll `getOutboundTo` for the intro) before arming a fail seam, or the seam consumes the intro instead of the leg.

**The four specs (intent; the builder writes them against the real helpers):**

1. `accept_then_drop on a relay leg ends adopted as delivered` - create an open two-member group (settle its intros); arm `failNextSend({ partyNumber: <member B's number>, mode: 'accept_then_drop' })`; `sendAsParty({ from: <member A>, to: <pool number>, body: 'Hello from the sender' })`; open `/conversations/<id>`, CLICK the member-authored bubble to reveal the recipient rows (the per-recipient list appears only after the reveal; the team-sent rollup chip is not present on a member-authored source), and expect member B's row to read `Delivered` within 20 s (adopted at the 2 s or 4 s check); `getOutboundTo(B)` has exactly ONE message with that body (never re-sent).
2. `drop_before_create on a broadcast recipient is re-driven once and the share finishes sent` - create a consented tenant (the share-skip-fix spec's recipe; NOT `contact-tenant-0002`); arm `drop_before_create` for its number; create and send a seeds-only share to it; on `/broadcasts/<id>` poll `statValue('Delivered')` to 1 within 40 s (never_sent at the third check, 8 s, then the re-drive); `statusPill('Sent')` visible; `getOutboundTo(tenant)` has ONE message.
3. `reject with 21211 marks the recipient failed with that code and the rest sent` - two consented tenants; `reject` (code 21211) for the first; send the share; `statValue('Failed')` 1, `statValue('Delivered')` 1; the Recipients list shows `Failed` and `Delivery failed (error 21211)` (the fallback copy - the carrier map has no 21211 entry); the `Not confirmed` chip exists with value 0.
4. `fail-list for the whole window ends Not confirmed` - one consented tenant; arm `drop_before_create` AND `failList({ partyNumber, count: 3 })`; send the share; `statValue('Not confirmed')` 1 within 40 s; the row reads `Not confirmed` and `Couldn't confirm whether this text went out`; the header pill `Failed`; `role=alert` text `Couldn't confirm any text went out`; no link named `/open conversation to retry/`.

- [ ] **Step 1: Write the specs.** A running lane must be BOOTED FRESH to pick up the `childEnv` change (`e2e:restart` keeps the launcher's old env).
- [ ] **Step 2: Run the spec on a fresh lane, then the full suite** (`timeout 1500 npm run e2e` in bash). Expected: 4 passed; no other spec regresses (the broadcasts spec's terminal-buckets poll names only `delivered/sent/sending/queued`).
- [ ] **Step 3: Commit**

```bash
git status
git add scripts/e2e-session.mjs e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts e2e/support/broadcastSelectors.ts e2e/tests/dashboard-next/broadcasts.spec.ts e2e/support/selectors.md
git commit -m "test(e2e): prove adoption, re-drive, rejection and an unresolved send end to end through the fake's seams" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Slice F - records, self-QA, gates

### Task 15: Issue registry updates owed by the design (Sec 2, Sec 9)

**Files (dated sections, ASCII, code cited by file:line at HEAD, never pasted):**
- `docs/issues/fanout-close-path-robustness-residues.md` - the D7a failure-arm write that itself fails is this issue's "throwing close" class one step earlier; cite the new arms.
- `docs/issues/fanout-pass-setup-throw-strands-pass.md` - the relay retry rung's pre-claim throws (the row read, the lineage check, the conversation read, a suppression read that rejects, the no-pool throw); cite.
- `docs/issues/relay-continuation-early-return-strands-slots.md` - a RE-DRIVE continuation's early returns now close the carried member's record `redrive_refused` and its slot (Task 8); the ordinary transient continuation's early returns still strand, as filed.
- `docs/issues/manual-retry-double-send-residual-windows.md` - a dated note beside gap 5: the status webhook's `closeRetryLegEnqueueFailed` is a close by another writer the D8 gate cannot cover (fenced file).
- `docs/issues/send-attempt-sweeper.md` - the record's exact key shapes, states, clocks and the index family as BUILT, so the sweeper's author reads them from the registry.
- `docs/issues/throw-for-redelivery-defeated-by-job-marker.md` - built on this branch for both fan-outs and the relay retry rung; the `TODO(throw-for-redelivery-defeated-by-job-marker)` markers are gone from the tree; `status` stays `open` (the human sets it resolved at merge).
- `docs/issues/retry-send-lost-under-job-marker.md` - a dated note: Stage 1 landed the core it will adopt; nothing else.

- [ ] **Step 1: Write the sections; run `npm run issues` (regenerates the gitignored INDEX; must exit 0).**
- [ ] **Step 2: Commit**

```bash
git status
git add docs/issues/fanout-close-path-robustness-residues.md docs/issues/fanout-pass-setup-throw-strands-pass.md docs/issues/relay-continuation-early-return-strands-slots.md docs/issues/manual-retry-double-send-residual-windows.md docs/issues/send-attempt-sweeper.md docs/issues/throw-for-redelivery-defeated-by-job-marker.md docs/issues/retry-send-lost-under-job-marker.md
git commit -m "docs(issues): record the residues this branch leaves and the record shapes the sweeper will read" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 16: Live self-QA on a hermetic lane (the profile's harness)

- [ ] **Step 1:** `npm run e2e:session` on a FRESH lane (the `childEnv` seam must be picked up), dev-login, reseed `lean`.
- [ ] **Step 2:** Drive four scenarios by hand with the Playwright MCP and the fake's control routes; record them in `docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/self-qa.md` (screenshots under `.playwright-mcp/`):
  - relay `accept_then_drop`: after the reveal click, the affected member's row reads `Delivered` within the lane's delays; the fake's thread shows ONE outbound to that member; the worker log has one `send_reconcile` INFO `found`.
  - broadcast `drop_before_create`: `Delivered` reaches the audience; `Not confirmed` 0; the pill `Sent`; ONE outbound in the fake.
  - broadcast `drop_before_create` + `fail-list` x3: the row reads `Not confirmed - Couldn't confirm whether this text went out`, the `Not confirmed` chip 1, no `open conversation to retry` hint, the pill `Failed` with the prose alert when it was the only recipient; exactly one ERROR line in the worker log.
  - a relay leg left `queued` with `attemptedAt` and no `sentAt`: seed it through the hermetic message-fixture seam (`routes/dev.ts` message fixture, `plan-send-sites-findings.md` D3 "Dev seams") with an `attemptedAt` 16 minutes before the dashboard's pinned clock; the row reads `Queued - not confirmed` immediately (no waiting).
- [ ] **Step 3:** `npm run e2e:stop`. Commit the record.

```bash
git status
git add docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/self-qa.md
git commit -m "docs(reviews): live self-QA - adoption, re-drive, unresolved and the attempt-clock aging on a hermetic lane" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 17: Drift report, complete gates, handback

- [ ] **Step 1: Drift, not a re-merge.** `git rev-list --count HEAD..main` and `git log --oneline HEAD..main` from the worktree; list the drift in the handback. Re-merge ONLY if the planner says so.
- [ ] **Step 2: Run the five gates BARE from the worktree in a BASH shell, each its own command:**

```bash
npm run typecheck
npm test
npm run smoke
timeout 1500 npm run e2e
npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')
```

Report every real exit code and count. If `npm test` is red on DynamoDB Local suites: re-run the failing FILE alone more than once, run the full suite at the branch's merge base, compare failing FILES, report both runs (AGENTS.md). Any `[dynamoAdmin]` line is a real container fault - capture `err.$metadata.httpStatusCode` and `attempts` first. Attribute lint errors by BASELINE COMPARISON on the same paths at the merge base; only new ones block.
- [ ] **Step 3: Handback** at `.superpowers/sdd/handback.md` AND committed as `docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/handback.md`: the work map with commits; a per-decision conformance table (D1-D23 incl. D3a, D7a, D8a, D13a, D16a, D20a, and Sec 2a's RSW #1/#5/#6/#7); the quoted gate exit codes and counts; the self-QA pointer; reviewer findings and adjudications from the orchestrator's own review; the drift list; the residues Sec 1 records with their issue links; the two plan deviations from the spec's wording (D17's `createdAfter`; the dashboard code constants); post-merge obligations: NONE infra; the human sets `throw-for-redelivery-defeated-by-job-marker` resolved at merge; Stage 1b (the `retrySend` adoption) is the next worktree; the first hosted-dev run verifies the list walk's order and page bound and the prod service's Smart Encoding (Sec 10). State explicitly: UNMERGED (human gate).

---

## Self-review (planner, against spec revision 9) - coverage by NAMED test

| spec | task(s) | proof |
|---|---|---|
| D1, D2 | T1 | `classifySendFailure` describe (9 tests incl. Review Focus 1, code 0) |
| D3, D3a | T3; T7/T8 (the arms) | `typed send errors` describe; T7 tests 2, 5; T8 "record-phase failure" |
| D4 | T1 | "fires send_throttled on 20429 and not on ECONNREFUSED" |
| D5, D6 | T7 tests 4 (three rejected), 10 (network code -> send_retryable); T8 kill-switch + retryable cases | |
| D7, D7a | T7 tests 1, 3, 5; T8 unknown-on-member-2, pre-send-throw-after-claim, record-phase; T9 handed/sent_unrecorded arms | |
| D8 | T7 test 8 (cap-close: absent / fresh / stale / reconciling); T8 close B + reconciling member + suppression-arm gate; T9 refuseGate gate | |
| D8a | T5 integration (9 + widened closeRedriven); T7 test 7 (one provider call; takeover); T8 queued+sid refuses a second claim; T6 `setRelayRecipientAttemptedAt` | |
| D9 | T7 test 4 (brake, streak reset, three rejected, three retryable); T8 brake cases | |
| D10 | T1 constants; T13 mirror | |
| D11 | T5 transitions; T10 cases 14, 14b; T10 integration | |
| D12 | T2 digest/hash/safe; T10 cases 13, 21 | |
| D13 | T10 cases 5, 5b, 6, 7, 8, 9, 10, 12, 13b | |
| D13a | T7 test 9 (re-drive claims no rung; second unknown closes); T10 cases 4, 18, 20; T8 re-drive cases | |
| D14 | recorded, not built (Sec 1 residue; T15 files the shapes) | |
| D15 | T10 cases 1, 2, 3, 16; T10 integration (idempotent; no regression); T6 `adoptRelayRecipientIfUnsent` | |
| D16 | T10 cases 11, 15, 17, 19 | |
| D16a | T6 `finalizeStatus`; T7 finalize tests (N callers; all-skipped+unconfirmed = Review Focus 5; stale counter; ordering un-skipped in T10) | |
| D17 | T4 driver tests (+ page-size WARN); deviation noted (no `createdAfter`) | |
| D18 | T10 case 21 (no phone in payloads); log assertions in cases 12, 16 | |
| D19 | T11 fake tests; T12 specs 1-4; T16 | |
| D20, D20a, D21, D23 | T13 describes + Timeline three-position + ticker ARMING + join + mirror | |
| D22 | T6 derive + T14 chip/order/badge/hint/seeds | |
| Sec 2a RSW #1/#5/#6/#7 | T9 window-gate on a re-driven rung; deadline pins; foreign-attempt skip; T13 join keeps both codes | |
| Sec 8 e2e | T12 specs 1-4 | |
| Sec 9 | T15 | |

Placeholder scan: every test sketch names its expectation and its seam; none says "add tests" or "similar to". Type consistency: `AttemptRef`, `SendAttemptOwner`, `SendAttemptOwnerRef`, `ClaimResult`, `RelayLegSendOutcome`, `SendReconcilePayload`, the outcome kinds and the code constants are defined once in the shared block and used by name in T5-T10, T13-T14. Review Focus: RF1 T1; RF2 T10 case 13; RF3 T7 test 2; RF4 T10 case 13b; RF5 T7 finalize test.
