# Send-Outcome Classification and Reconcile - Implementation Plan (Stage 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 4** (after plan review rounds 1-3; adjudications in `docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/design-review/adjudications.md`, sections "Plan round 1", "Plan round 2" and "Plan round 3"). This document is self-contained: every test and every code block a task needs is IN that task.

**Goal:** Replace the throw-for-redelivery in both fan-outs and the relay retry rung with a classified send outcome, a per-recipient send-attempt record claimed before every provider call, and a `send.reconcile` job that resolves an ambiguous send by looking the message up at the provider - so every attempted recipient reaches a terminal state and nobody is ever texted twice.

**Architecture:** A pure classifier at the send boundary sorts a provider failure into `rejected` / `retryable` / `unknown`; `sendMessage` throws typed errors that carry the reconcile facts. A new `sendAttemptsRepo` keeps per-owner-per-recipient records (plus a recipient-keyed index) in the messages table, with every transition a conditional write keyed on the attempt. The send sites split each recipient into PREPARE / SEND / RECORD phases inside one outer per-recipient try/catch that tracks the phase, claim the record before the provider call, and hand `unknown` outcomes to a `send.reconcile` job (no run-once marker; at-least-once enqueues; idempotent writes) whose per-owner handlers adopt, re-drive once, or close `unresolved`. The dashboard presents `send_unconfirmed` by code alone as "Not confirmed".

**Tech Stack:** TypeScript (Node 24, ESM), Express, DynamoDB (`@aws-sdk/lib-dynamodb`, DynamoDB Local for integration tests), twilio-node 6.0.2, Vitest, React 19 dashboard, Playwright e2e harness with the in-repo fake-twilio.

**Spec:** `docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md` (revision 11). The plan argues from the spec; executors read both. Decision numbers (D1, D8a, ...) are the spec's.

**Declared deviations from the spec's wording (all deliberate, restated in the handback):**
1. D17's `createdAfter` is not a port argument; the job filters by `createdAt` after listing.
2. The dashboard's code constants live in `deliveryStatus.ts` and are pinned to the app's by a mirror test (the dashboard never imports app values at runtime).
3. A slot write made by a send site after its claim keeps the slot's existing guards (forward-only / allowed priors) and is NOT additionally fenced on the attempt record. The slot is written BEFORE the fenced `finishAttempt`; a lost fence (a `false` after the slot write - the record was taken over during a long send) is logged at WARN and the slot is NOT rolled back: the takeover's reconcile finds the SID through the pointer and repairs/adopts.
4. The continuation payloads (`broadcast.send` `recipientKeys`, `relay.fanOut` `recipientKeys` and `senderKey`) keep their pre-existing shapes, which carry `phone#` keys today. The NEW `send.reconcile` payload's OWNER field is phone-free (hashed recipient key); its optional `continuation.senderKey` is the fan-out's own sender key, carried verbatim because the re-drive envelope must repeat it, and is a `phone#` key for a contact-less sender. Test 21 is scoped to the owner field.

**Branch / worktree:** `feat/send-outcome-reconcile` at `W:\tmp\send-outcome-reconcile`, HEAD merged with `main` @bd752bd0 at a9f411f3 (RSW and share-skip-fix Branch A included). This branch's ONE main sync is already done; Task 17 reports later drift, it does not re-merge.

**One deliverable, not six.** The slices below are commit-and-review checkpoints, NOT shippable states: after Slice B a `send.reconcile` envelope is enqueued with no handler (the consumer deletes it as poison); before Slice E the dashboard renders `send_unconfirmed` as a failure with a retry hint. The branch is merge-ready only after Task 17.

**Research maps the tasks cite:** findings (tracked) in `docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/research/plan-*-findings.md`; byte-exact references (gitignored) in `.superpowers/sdd/plan-send-sites-reference.md`, `plan-data-layer-reference.md`, `plan-dashboard-reference.md`. Line numbers are at a9f411f3; re-derive by reading before editing. Test sketches name the seams to use; where a sketch names a fixture, USE THE FILE'S REAL FIXTURE NAMES (read the file first) - the sketch states the expectation, not the exact identifiers. Log-capture facts for tests: `createLogCapture().lines` are PARSED OBJECTS (not strings); `capture.atLevel(50)` takes the pino NUMERIC level (error = 50, warn = 40); match on `line.msg` and fields.

## Global Constraints

- ASCII-only in every line this branch ADDS or TOUCHES (code, comments, tests, docs, log strings). `broadcastFanOut.ts`, `relayFanOut.ts` and `sendMessage.ts` carry pre-existing U+2014 log strings; a touched log line is re-worded in ASCII (no test matches an em-dash string). Verify a NEW file with `tr -d '\11\12\15\40-\176' < FILE | wc -c`; on a pre-existing file check the diff's added lines. Unicode test strings are written as `\uXXXX` escapes.
- Never edit `app/src/routes/webhooks/twilio.ts` (fenced), `app/src/jobs/jobs.ts` (incl. `MAX_HOP_COUNT` 10), `app/src/adapters/sqsJobConsumer.ts`, or the run-once marker. Never edit `app/src/jobs/retrySend.ts`.
- `SendRefusedError` and every subclass are never wrapped (D3). No new refusal code. No new `sendMessage` gate, so `app/test/helpers/sendRefusalCases.ts` gets no row.
- No new slot STATUS values (D10). Slot codes this branch writes: `send_unconfirmed`, `send_retryable`, `enqueue_failed`, `redrive_refused`, `sms_sending_disabled`, the provider's own rejection codes. Pending states live on the attempt record, never on a slot.
- Every coordination read is a strongly consistent primary-key read or Query on the base table; no GSI anywhere in the coordination path (D11).
- Every DynamoDB expression lists EXACTLY the attribute names and values it uses - DynamoDB rejects an unused alias with a ValidationException (`app/test/aiRunsRepo.integration.test.ts:302-316`). Every helper in this plan builds its names/values per statement.
- Classifier precedence (D1): `30007`, `30005`, `30006` are `rejected` by code; `429`, `30022` are `retryable` by code; then HTTP 5xx -> `unknown`; HTTP 429 -> `retryable`; HTTP 4xx -> `rejected`; ENOTFOUND/ECONNREFUSED/EAI_AGAIN -> `retryable`; ECONNABORTED/ETIMEDOUT/ECONNRESET/EPIPE and anything else -> `unknown` (D2). A code of `0` is no code.
- Claim placement (D7a): relay unit claims AFTER the bounded token acquire and BEFORE the presign; broadcast pass claims immediately before `sendMessage`, after its fences. Each recipient runs inside ONE outer try/catch that tracks `phase` ('prepare' | 'sending' | 'record'); a throw at phase 'sending' or later is NEVER turned into a re-send.
- Every failure-arm write is made through `guardWrite(label, fn)`: it catches, logs ERROR `{ err, owner, recipientKey: safeRecipientKey(...), label }`, and never throws (D7a).
- Claim TTL = `SEND_CLAIM_TTL_MS` = 30_000, the same constant the Twilio driver passes as its request timeout (D8a).
- Reconcile: check k (0, 1, 2) runs at `attemptedAt + reconcileCheckDelaysMs()[k]` (defaults +5 s, +30 s, +240 s - offsets from the ATTEMPT); enqueue delay `max(0, thatTime - now)`; lane-overridable only when `JOBS_QUEUE_URL` is unset; window opens 60 s before the attempt; list page size 1000, at most 5 pages; one re-drive per recipient; worst-case chain depth 8 of 10 hops (D13, D13a).
- Body matching uses the lossy normalization (Unicode NFKC, letters and digits only); a normalized body shorter than 3 characters matches on media count instead (D13).
- The `send.reconcile` payload carries the HASHED recipient key, never a phone; every log line uses `safeRecipientKey` / `logSafeMemberKey` (D12, D18).
- D8 gate, uniformly through the module-local `gateFor(owner, nowMs)` (Task 7 defines it; Tasks 8 and 9 copy it): a pre-claim decline or a close by another writer PROCEEDS only when the recipient's attempt record is ABSENT, `done/retryable`, or `redriven` (any pass - a `redriven` record is claimable by any pass, so any pass's decline may close it through `closeRedriven`); a `done` record with any other outcome SKIPS (terminal, never carried forward); a stale `attempting` (older than the TTL) is TAKEN OVER and the record RETURNED so the CALLER hands off exactly once (the gate never enqueues); a fresh `attempting` or `reconciling` DEFERS (continuation-carried). A gate read that throws is a prepare-phase throw (deferred, no record).
- A recipient whose `handToReconcile` write is lost is STRANDED: deferred with no slot write, the record left `attempting`, and it COUNTS toward the outage streak (it is an unknown provider outcome whose bookkeeping failed). On broadcast the continuation's claim takes the stale record over (the 10 s + 20 s ladder clears the 30 s TTL); on relay the ladder (5 s + 10 s) does NOT clear it, so a stranded relay member or rung is deferred at the cap and left for the sweeper (spec D8a revision 11; Task 15 files it).
- A rejection with NO provider code (a 4xx whose body did not parse) writes NO slot code: the slot is `failed` with no `errorCode` (the badge reads `Delivery failed`); the record's `cause` keeps `String(status)`. An HTTP status is never a slot code (D10, D23). The kill switch's `sms_sending_disabled` IS a slot code (it has prose).
- A pre-claim deferral write on a broadcast slot goes through `recordRecipientOutcome` with an EMPTY stats delta and `['queued']` priors - never a blind `setRecipient` (it could revert a fence's `skipped` or a foreign attempt's `sent`).
- Dashboard copy (D20-D23, exact): `send_unconfirmed` -> label `Not confirmed`, tone `danger`, `isFailure: false`, reason `Couldn't confirm whether this text went out`; `redrive_refused` -> `Wasn't resent: the group closed or the member left`; `sms_sending_disabled` -> `SMS sending is switched off, so nothing was sent`; `transient_cap` -> `Sending gave up after repeated temporary errors`; chip label `Not confirmed`; `last_error` `Couldn't confirm any text went out`; a 21211 renders `Delivery failed (error 21211)`.
- The `unconfirmed` stats bucket is OPTIONAL in both `BroadcastStats` types, read as `?? 0`, its own chip in the audience sum, never in `skippedTotal` (D22).
- E2E never uses the lean seed's switched-off tenant `contact-tenant-0002` / `conv-0002` as a recipient of anything automated (Sec 2a).
- Gates run BARE from the worktree in a BASH shell: `npm run typecheck`, `npm test`, `npm run smoke`, `timeout 1500 npm run e2e`, `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` (empty list = skip). `npm test` needs DynamoDB Local (`npm run db:start`).
- Commit discipline: bare `git status` first, `.git/MERGE_HEAD` absent, EXPLICIT paths, never `git add -A`; every commit ends with `Co-Authored-By: <the authoring model> <noreply@anthropic.com>`.
- Never merge to `main`, deploy, push secrets, run terraform, or clean up the worktree.

## Review Focus

1. A Twilio `RestException` with `status: 400` and NO code - `rejected`, not `unknown` (Task 1, "a 4xx with no code").
2. A relay member whose phone changed between the claim and the reconcile - `unresolved`, never re-sent (Task 10, case 13).
3. A `SendRefusedError` for a recipient the broadcast pass has already CLAIMED - record `done/refused`, slot as today, no reconcile (Task 7, test 2).
4. A candidate created 59 s BEFORE the attempt start - inside the lead, considered (Task 10, case 13b).
5. All `skipped` plus one `unconfirmed` - finalize reads `failed` with the prose (Task 7, finalize test 2).

---

## Work map (task ORDER differs from the numbering)

Order: **T1, T2, T4, T5, T6** -> **T3** -> **T7, T8, T9** -> **T10** -> **T13, T14** -> **T11, T12** -> **T15, T16, T17**.

- **Slice A (no behavior change):** T1 classifier + `messagingErrors` leaf + throttle marker; T2 fingerprint/digest/key helpers; T4 adapter port + driver timeout + harness `sentDetails`; T5 send-attempt record repo + deps fields + registration-site wiring; T6 repo additions.
- **Slice B:** T3 `sendMessage` typed errors; T7 broadcast fan-out; T8 relay leg + loop; T9 relay retry rung.
- **Slice C:** T10 `send.reconcile`.
- **Slice E (before D):** T13 codes, copy, aging, join; T14 broadcast bucket, chip, badge, seeds.
- **Slice D:** T11 fake routes + seams; T12 lane seam + e2e.
- **Slice F:** T15 issues; T16 self-QA; T17 gates + handback.

### Shared interfaces (canonical; each task repeats what it consumes)

```ts
// app/src/adapters/messagingErrors.ts  (T1) - a LEAF
export class SmsSendingDisabledError extends Error { constructor(message: string) }
// messaging.ts: `export { SmsSendingDisabledError } from './messagingErrors.js';`

// app/src/lib/sendOutcome.ts  (T1) - imports ONLY messagingErrors.ts
export type SendFailureKind = 'rejected' | 'retryable' | 'unknown';
export interface SendFailureClassification { kind: SendFailureKind; code?: string; status?: number; }
export function classifySendFailure(err: unknown): SendFailureClassification;
export function isProviderCode(code: string | undefined): boolean;   // all digits -> a Twilio code, writable to a slot
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

// app/src/lib/sendFingerprint.ts  (T2)
export function normalizeBodyForMatch(body: string | undefined): string;
export interface BodyFingerprint { hash: string; short: boolean; }
export function bodyFingerprint(body: string | undefined): BodyFingerprint;
export function recipientDigest(sender: string | undefined, destinationE164: string): string;
export function hashRecipientKey(recipientKey: string): string;      // 'phone#...' -> 'phonehash#<32 hex>'; others unchanged
export function safeRecipientKey(recipientKey: string): string;      // logs: 'phone#...' -> 'phone#redacted'

// app/src/lib/guardWrite.ts  (T5)
export async function guardWrite(log: Logger, ctx: Record<string, unknown>, label: string, fn: () => Promise<unknown>): Promise<boolean>;  // true = fn resolved; false = it threw (ERROR logged)

// app/src/services/sendMessage.ts  (T3)
export class SendNotAttemptedError extends Error { constructor(message: string, readonly cause: unknown) }
export class ProviderSendFailedError extends Error {
  constructor(args: { classification: SendFailureClassification; cause: unknown; facts: SendAttemptFacts; attemptedAt: string });
  readonly classification; readonly cause; readonly facts; readonly attemptedAt;
  readonly code?: string | number;   // mirrors the cause's `code`
  readonly status?: number;          // mirrors the cause's `status`
}
export class SendAcceptedNotRecordedError extends Error {
  constructor(args: { providerSid: string; providerTs: string; status: DeliveryStatus; cause: unknown; facts: SendAttemptFacts });
  readonly providerSid; readonly providerTs; readonly status; readonly cause; readonly facts;
}

// app/src/adapters/messaging.ts  (T4)
export interface ProviderMessageSummary { providerSid: string; providerStatus: string; errorCode?: string; body: string; mediaCount: number; createdAt: string; sentAt?: string; }
export interface ListMessagesArgs { to: string; from: string; pageSize: number; pageToken?: string; }
export interface ListMessagesPage { messages: ProviderMessageSummary[]; nextPageToken?: string; }
// on MessagingAdapter:
listMessages(args: ListMessagesArgs): Promise<ListMessagesPage>;
getMessage(providerSid: string): Promise<ProviderMessageSummary | undefined>;
export const TWILIO_REQUEST_TIMEOUT_MS = SEND_CLAIM_TTL_MS;
// harness (T4): world.sentDetails: Array<{ params: SendMessageParams; sid: string; providerTs: string }>; world.providerMessages: ProviderMessageSummary[]; world.listPageSize: number (default 1000)

// app/src/repos/sendAttemptsRepo.ts  (T5)
export type SendAttemptOwner =
  | { kind: 'broadcast'; broadcastId: string; contactKey: string }
  | { kind: 'relay_leg'; relayConversationId: string; sourceTsMsgId: string; memberKey: string }
  | { kind: 'relay_rung'; relayConversationId: string; retryTsMsgId: string; memberKey: string };
export type SendAttemptState = 'attempting' | 'reconciling' | 'redriven' | 'done';
export type SendAttemptOutcome = 'sent' | 'rejected' | 'retryable' | 'refused' | 'adopted' | 'never_sent' | 'unresolved' | 'enqueue_failed' | 'redrive_refused';
export interface SendAttemptFacts { recipientDigest: string; sender?: string; bodyHash: string; bodyShort: boolean; mediaCount: number; }
export interface SendAttemptRecord extends SendAttemptFacts { owner: SendAttemptOwner; state: SendAttemptState; attemptNo: number; attemptedAt: string; redriveCount: number; checkNo: number; sid?: string; outcome?: SendAttemptOutcome; cause?: string; }
export interface AttemptRef { attemptNo: number; attemptedAt: string; }
export type ClaimResult =
  | { outcome: 'claimed'; record: SendAttemptRecord }
  | { outcome: 'takeover'; record: SendAttemptRecord }
  | { outcome: 'refused'; record: SendAttemptRecord; fresh: boolean };
export interface SendAttemptsRepo {
  claim(owner, facts, nowIso): Promise<ClaimResult>;
  finishAttempt(owner, ref: AttemptRef, result: { outcome: SendAttemptOutcome; sid?: string; cause?: string }): Promise<boolean>;
  handToReconcile(owner, ref: AttemptRef, sid?: string): Promise<boolean>;
  takeOver(owner, record: SendAttemptRecord): Promise<boolean>;
  recordCheck(owner, attemptedAt: string, checkNo: number): Promise<boolean>;
  markRedriven(owner, attemptedAt: string): Promise<boolean>;
  closeFromReconcile(owner, attemptedAt: string, result: { outcome: 'adopted' | 'unresolved' | 'enqueue_failed' | 'redrive_refused'; sid?: string; cause?: string }): Promise<boolean>;
  closeRedriven(owner, result: { outcome: 'refused' | 'redrive_refused' | 'enqueue_failed' | 'unresolved'; cause?: string }): Promise<boolean>;
  get(owner): Promise<SendAttemptRecord | undefined>;
  listByRecipient(sender: string, recipientDigest: string, sinceIso: string): Promise<SendAttemptRecord[]>;
}
export function ownerKey(owner: SendAttemptOwner): string;                       // the owner WITHOUT the recipient
export function attemptKey(owner: SendAttemptOwner): string;                     // `${ownerKey(owner)}|${hashRecipientKey(recipientKey)}` - the RECORD's identity; sibling filters compare THIS
export function createSendAttemptsRepo(deps?: RepoDeps): SendAttemptsRepo;

// module-local in broadcastFanOut.ts (T7), relayFanOut.ts (T8), relayRetryLeg.ts (T9) - same body, over `sendAttempts`
type GateResult =
  | { kind: 'proceed'; record?: SendAttemptRecord }     // absent, done/retryable, or redriven (the caller closes a redriven record with closeRedriven)
  | { kind: 'skip' }                                     // done with a terminal outcome
  | { kind: 'defer' }                                    // fresh attempting, reconciling, or a lost takeover
  | { kind: 'taken_over'; record: SendAttemptRecord };   // a stale attempting record now reconciling - the CALLER hands off
async function gateFor(owner: SendAttemptOwner, nowMs: number): Promise<GateResult>;
// T5 also adds `sendAttemptsRepo?: SendAttemptsRepo` to BroadcastSendJobDeps, RelayFanOutJobDeps, RelayRetryLegJobDeps and RegisterJobHandlersDeps (unused until T7-T9).

// app/src/jobs/relayFanOut.ts  (T8)
export interface RelayLegSendOutcome {
  kind: 'sent' | 'skipped_terminal' | 'suppressed' | 'refused' | 'filtered' | 'rejected' | 'transient' | 'deadline_exceeded' | 'sent_unrecorded' | 'handed_to_reconcile' | 'stranded';
  providerSid?: string; errorCode?: string;
  attemptRef?: AttemptRef;                 // on sent_unrecorded / handed_to_reconcile
  reason?: 'unknown' | 'takeover';         // on handed_to_reconcile
  deferredByClaim?: true;                  // on transient: a FOREIGN attempt owns the recipient; no slot written
}
// sendOneRelayLeg args gain: sendAttempts?: SendAttemptsRepo; owner?: SendAttemptOwner  (optional in T8; required in T9). No `redrive` arg: the gate and the claim treat a `redriven` record the same on every pass.

// app/src/jobs/sendReconcile.ts  (T7 stub; T10 handler)
export const SEND_RECONCILE_JOB = 'send.reconcile';
export type SendAttemptOwnerRef =
  | { kind: 'broadcast'; broadcastId: string; recipientKeyHash: string }
  | { kind: 'relay_leg'; relayConversationId: string; sourceTsMsgId: string; recipientKeyHash: string }
  | { kind: 'relay_rung'; relayConversationId: string; retryTsMsgId: string; recipientKeyHash: string };
export interface SendReconcilePayload { owner: SendAttemptOwnerRef; attemptedAt: string; checkNo: number; continuation?: { senderKey: string; senderNameOverride?: string }; }
export function toOwnerRef(owner: SendAttemptOwner): SendAttemptOwnerRef;
export function reconcileCheckDelaysMs(): readonly number[];                                   // lane-overridable
export function reconcileDelayMs(attemptedAt: string, checkNo: number, nowMs: number): number;   // max(0, attemptedAt + reconcileCheckDelaysMs()[checkNo] - nowMs)
export async function enqueueSendReconcile(payload: SendReconcilePayload, delayMs: number): Promise<void>;   // enqueue(SEND_RECONCILE_JOB, payload, { runAt: new Date(Date.now() + delayMs) }) - EnqueueOptions is { runAt } only (jobs.ts:91-93)
```

Re-drive marker on the three continuation payloads: `redrive?: true`, carried by each parser; a transient re-enqueue STRIPS it.

---

## Slice A - foundations

### Task 1: The classifier, the `messagingErrors` leaf, the widened throttle marker

**Files:**
- Create: `app/src/adapters/messagingErrors.ts`, `app/src/lib/sendOutcome.ts`, `app/test/sendOutcome.test.ts`
- Modify: `app/src/adapters/messaging.ts` (the class at :383-388 moves to the leaf; `SEND_THROTTLE_CODES` :543)
- Test: `app/test/messaging.test.ts`

**Interfaces:** Produces `messagingErrors.ts`'s `SmsSendingDisabledError`; everything under `sendOutcome.ts` in the shared block (incl. `isProviderCode`).

- [ ] **Step 1: Move the kill-switch error to a leaf (no behavior change)**

```ts
// app/src/adapters/messagingErrors.ts
// Errors the messaging adapter throws that other leaves must name without
// importing the adapter (lib/sendOutcome.ts). Keep this file dependency-free.
export class SmsSendingDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
```

In `messaging.ts` delete the class body at `:383-388`, add `import { SmsSendingDisabledError } from './messagingErrors.js';` and `export { SmsSendingDisabledError } from './messagingErrors.js';`. Run `npm run typecheck` -> 0.

- [ ] **Step 2: Failing classifier tests**

```ts
// app/test/sendOutcome.test.ts
import { describe, expect, it } from 'vitest';
import { SmsSendingDisabledError } from '../src/adapters/messagingErrors.js';
import { classifySendFailure, isProviderCode } from '../src/lib/sendOutcome.js';

const restException = (status: number, code?: number | string) => Object.assign(new Error('x'), { status, ...(code !== undefined && { code }) });
const networkError = (code: string) => Object.assign(new Error(code), { code });

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
    expect(classifySendFailure(restException(400))).toEqual({ kind: 'rejected', status: 400 });
  });
  it('a code of 0 is no code', () => {
    expect(classifySendFailure(restException(400, 0))).toEqual({ kind: 'rejected', status: 400 });
  });
  it('a connection that never opened is retryable', () => {
    for (const c of ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']) expect(classifySendFailure(networkError(c))).toMatchObject({ kind: 'retryable', code: c });
  });
  it('a timeout or a dropped socket is unknown', () => {
    for (const c of ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE']) expect(classifySendFailure(networkError(c))).toMatchObject({ kind: 'unknown', code: c });
  });
  it('anything it cannot place is unknown (D2), with no code', () => {
    expect(classifySendFailure(new Error('boom'))).toEqual({ kind: 'unknown' });
    expect(classifySendFailure(undefined)).toEqual({ kind: 'unknown' });
  });
  it('the adapter-level kill switch is rejected with the sms_sending_disabled token', () => {
    expect(classifySendFailure(new SmsSendingDisabledError('off'))).toEqual({ kind: 'rejected', code: 'sms_sending_disabled' });
  });
  it('isProviderCode is true for digits only', () => {
    expect(isProviderCode('20429')).toBe(true); expect(isProviderCode('ECONNREFUSED')).toBe(false); expect(isProviderCode(undefined)).toBe(false);
  });
});
```

Run: `cd app; npx vitest run test/sendOutcome.test.ts` -> FAIL (module missing).

- [ ] **Step 3: Write the classifier**

```ts
// app/src/lib/sendOutcome.ts
// Send-outcome vocabulary (spec D1-D2, D10, D13a). Pure. Imports ONLY the
// adapter's error leaf, so adapters/messaging.ts may import these constants
// at module init without a cycle.
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

/** A Twilio numeric code, safe to write into a slot's errorCode (D6). */
export function isProviderCode(code: string | undefined): boolean {
  return code !== undefined && /^[0-9]+$/.test(code);
}
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
  const withMeta = (kind: SendFailureKind): SendFailureClassification => ({ kind, ...(code !== undefined && { code }), ...(status !== undefined && { status }) });
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

Run -> PASS (10 tests).

- [ ] **Step 4: Widen the throttle marker (D4), failing test first**

In `app/test/messaging.test.ts` (read how the existing `send_throttled` case builds the driver: `client: client as never`, `createLogCapture()`), add:

```ts
it('fires send_throttled on a real 20429 and not on ECONNREFUSED (D4)', async () => {
  const capture = createLogCapture();
  const driverThrowing = (err: unknown) => new TwilioMessagingDriver({
    accountSid: 'AC1', apiKeySid: 'SK1', apiKeySecret: 's', messagingServiceSid: 'MG1', appEnv: 'test',
    logger: createLogger({ destination: capture.stream }),
    client: { messages: { create: async () => { throw err; } } } as never,
  });
  await expect(driverThrowing(Object.assign(new Error('rate'), { status: 429, code: 20429 })).sendMessage({ to: '+15550001111', body: 'x' })).rejects.toThrow('rate');
  await expect(driverThrowing(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })).sendMessage({ to: '+15550001111', body: 'x' })).rejects.toThrow('refused');
  const throttled = capture.lines.filter((l) => (l as { event?: unknown }).event === 'send_throttled');
  expect(throttled).toHaveLength(1);
  expect((throttled[0] as { errorCode?: unknown }).errorCode).toBe('20429');
});
```

Run -> FAIL. Change `:543` to `new Set(['429', '20429', '30022'])` with a comment ("20429 is the code twilio-node attaches to a real HTTP 429; the bare 429 stays for status-only fixtures"). Run `cd app; npx vitest run test/messaging.test.ts test/sendOutcome.test.ts` -> PASS.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/adapters/messagingErrors.ts app/src/adapters/messaging.ts app/src/lib/sendOutcome.ts app/test/sendOutcome.test.ts app/test/messaging.test.ts
git commit -m "feat(send): classify provider send failures (rejected / retryable / unknown); count 20429 as a throttle" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 2: Fingerprint, digest and key helpers

**Files:** Create `app/src/lib/sendFingerprint.ts`, `app/test/sendFingerprint.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
// app/test/sendFingerprint.test.ts
import { describe, expect, it } from 'vitest';
import { bodyFingerprint, hashRecipientKey, normalizeBodyForMatch, recipientDigest, safeRecipientKey } from '../src/lib/sendFingerprint.js';

describe('normalizeBodyForMatch (spec D13, Smart Encoding)', () => {
  const submitted = 'HC spike B \u2019quote\u2019 dash\u2014dash more\u2026 ignore';
  const stored = "HC spike B 'quote' dash-dash more... ignore";   // the 2026-09-24 spike's stored body
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
  it('hashes a phone-bearing key, leaves a contact id alone, is stable', () => {
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

Run -> FAIL.

- [ ] **Step 2: Implement**

```ts
// app/src/lib/sendFingerprint.ts
// Spec D12/D13: the facts a reconcile matches on. LOSSY on purpose: the
// Messaging Service has Smart Encoding on, and the 2026-09-24 spike showed the
// STORED body of a message with a curly quote, an em dash or an ellipsis comes
// back as ', - and ... - an exact comparison would rule a real orphan "never
// sent" and re-send it.
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
export function recipientDigest(sender: string | undefined, destinationE164: string): string {
  return createHash('sha256').update(`${sender ?? ''}|${destinationE164}`).digest('hex').slice(0, 32);
}
export function hashRecipientKey(recipientKey: string): string {
  if (!recipientKey.startsWith('phone#')) return recipientKey;
  return `phonehash#${createHash('sha256').update(recipientKey).digest('hex').slice(0, 32)}`;
}
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
- Modify: `app/src/adapters/messaging.ts` (`MessagingAdapter` :150-268; `TwilioClientLike` :423-432; driver constructor :623-637; `TwilioMessagingDriver` and `ConsoleMessagingDriver` gain the methods)
- Modify the typed adapter fakes: `app/test/helpers/twilioWebhookHarness.ts:3766`, `app/test/scheduledSendSuppression.test.ts:355`, `app/test/sendMessage.test.ts:318`, `app/test/tourReminders.test.ts:2579`, `app/test/poolNumbers.test.ts:174,:213`, `app/test/relayWarm.test.ts:59`
- Test: `app/test/messaging.test.ts`

**Interfaces:** Consumes `SEND_CLAIM_TTL_MS`. Produces the shared block's port types and methods, `TWILIO_REQUEST_TIMEOUT_MS`, console seams `_consoleSentMessagesForTests()` / `_resetConsoleSentMessagesForTests()`, and the harness fields `world.sentDetails`, `world.providerMessages`, `world.listPageSize` (`world.sent` keeps its EXACT shape - `twilioStatusWebhook.test.ts:1275` pins it with `toEqual`).

- [ ] **Step 1: Failing driver tests**

```ts
// app/test/messaging.test.ts (new describe)
describe('listMessages / getMessage (spec D17)', () => {
  const twilioDate = 'Fri, 25 Sep 2026 02:50:31 +0000';
  const resource = (over: Record<string, unknown>) => ({ sid: 'SM1', status: 'sent', body: 'hi', num_media: '0', error_code: null, date_created: twilioDate, date_sent: twilioDate, to: '+16175550100', from: '+15550009999', ...over });
  const driverWith = (messages: unknown) => new TwilioMessagingDriver({ accountSid: 'AC1', apiKeySid: 'SK1', apiKeySecret: 's', messagingServiceSid: 'MG1', appEnv: 'test', client: { messages } as never });

  it('lists one page by To and From at the requested size and returns the next-page token', async () => {
    const pageCalls: unknown[] = [];
    const messages = Object.assign((_sid: string) => ({ fetch: async () => { throw new Error('unused'); } }), {
      create: vi.fn(),
      page: async (params: unknown) => { pageCalls.push(params); return { instances: [resource({ sid: 'SM1' }), resource({ sid: 'SM2', status: 'queued', date_sent: null })], nextPageUrl: 'https://api.twilio.com/next?PageToken=PAabc', _payload: { page_size: 1000 } }; },
      getPage: async (_url: string) => ({ instances: [resource({ sid: 'SM3' })], nextPageUrl: undefined, _payload: { page_size: 1000 } }),
    });
    const driver = driverWith(messages);
    const first = await driver.listMessages({ to: '+16175550100', from: '+15550009999', pageSize: 1000 });
    expect(pageCalls[0]).toMatchObject({ to: '+16175550100', from: '+15550009999', pageSize: 1000 });
    expect(first.messages.map((m) => m.providerSid)).toEqual(['SM1', 'SM2']);
    expect(first.messages[0]).toMatchObject({ providerStatus: 'sent', body: 'hi', mediaCount: 0, createdAt: '2026-09-25T02:50:31.000Z', sentAt: '2026-09-25T02:50:31.000Z' });
    expect(first.messages[1]!.sentAt).toBeUndefined();
    expect(first.nextPageToken).toBe('https://api.twilio.com/next?PageToken=PAabc');
    const second = await driver.listMessages({ to: '+16175550100', from: '+15550009999', pageSize: 1000, pageToken: first.nextPageToken });
    expect(second.messages.map((m) => m.providerSid)).toEqual(['SM3']);
    expect(second.nextPageToken).toBeUndefined();
  });
  it('WARNs when the provider page size differs from the requested one (the D17 UNVERIFIED guard)', async () => {
    const capture = createLogCapture();
    const messages = Object.assign((_sid: string) => ({ fetch: async () => undefined }), { create: vi.fn(), page: async () => ({ instances: [], nextPageUrl: undefined, _payload: { page_size: 50 } }), getPage: async () => ({ instances: [] }) });
    const driver = new TwilioMessagingDriver({ accountSid: 'AC1', apiKeySid: 'SK1', apiKeySecret: 's', messagingServiceSid: 'MG1', appEnv: 'test', logger: createLogger({ destination: capture.stream }), client: { messages } as never });
    await driver.listMessages({ to: '+16175550100', from: '+15550009999', pageSize: 1000 });
    expect(capture.atLevel(40).some((l) => (l as { msg?: string }).msg?.includes('page size differs'))).toBe(true);
  });
  it('fetches one message by SID and maps a 404 to undefined', async () => {
    const messages = Object.assign((sid: string) => ({ fetch: async () => { if (sid === 'SMgone') throw Object.assign(new Error('nf'), { status: 404, code: 20404 }); return resource({ sid, error_code: 30003, status: 'undelivered' }); } }), { create: vi.fn() });
    const driver = driverWith(messages);
    expect(await driver.getMessage('SM9')).toMatchObject({ providerSid: 'SM9', providerStatus: 'undelivered', errorCode: '30003' });
    expect(await driver.getMessage('SMgone')).toBeUndefined();
  });
  it('pins the request timeout to SEND_CLAIM_TTL_MS', () => { expect(TWILIO_REQUEST_TIMEOUT_MS).toBe(SEND_CLAIM_TTL_MS); });
  it('the console driver lists what it sent, capped at 1000', async () => {
    _resetConsoleSentMessagesForTests();
    const console_ = new ConsoleMessagingDriver();
    await console_.sendMessage({ to: '+16175550100', from: '+15550009999', body: 'a' });
    const page = await console_.listMessages({ to: '+16175550100', from: '+15550009999', pageSize: 10 });
    expect(page.messages).toHaveLength(1);
    expect(await console_.getMessage(page.messages[0]!.providerSid)).toMatchObject({ body: 'a' });
  });
});
```

Run -> FAIL.

- [ ] **Step 2: Implement**

Add the three interfaces after `SendMessageResult` (`:99-108`) and the two methods to `MessagingAdapter` (doc: "one page, newest first, at the requested size; the driver filters nothing by date - the provider's date filter is on SEND time"). `export const TWILIO_REQUEST_TIMEOUT_MS = SEND_CLAIM_TTL_MS;` (import from `../lib/sendOutcome.js`). Driver constructor: `twilio(sid, secret, { accountSid, timeout: TWILIO_REQUEST_TIMEOUT_MS, ...httpClient })`. `TwilioClientLike.messages` gains optional `page?` / `getPage?` and the callable `(sid) => { fetch }` (intersection, the `MessageMediaResource` idiom at `:529-533`).

```ts
function isoOf(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value === 'string' && value.length > 0) { const ms = Date.parse(value); return Number.isNaN(ms) ? undefined : new Date(ms).toISOString(); }
  return undefined;
}
function summarize(raw: unknown): ProviderMessageSummary {
  const m = raw as Record<string, unknown>;
  const errorCode = m['errorCode'] ?? m['error_code'];
  const numMedia = m['numMedia'] ?? m['num_media'];
  const sentAt = isoOf(m['dateSent'] ?? m['date_sent']);
  return {
    providerSid: String(m['sid'] ?? ''),
    providerStatus: String(m['status'] ?? ''),
    ...(errorCode !== null && errorCode !== undefined && Number(errorCode) > 0 && { errorCode: String(errorCode) }),
    body: typeof m['body'] === 'string' ? m['body'] : '',
    mediaCount: Number.parseInt(String(numMedia ?? '0'), 10) || 0,
    createdAt: isoOf(m['dateCreated'] ?? m['date_created']) ?? new Date(0).toISOString(),
    ...(sentAt !== undefined && { sentAt }),
  };
}
// TwilioMessagingDriver
async listMessages(args: ListMessagesArgs): Promise<ListMessagesPage> {
  const messages = this.client.messages as unknown as { page?: (p: { to: string; from: string; pageSize: number }) => Promise<PageLike>; getPage?: (url: string) => Promise<PageLike> };
  if (typeof messages.page !== 'function' || typeof messages.getPage !== 'function') throw new Error('TwilioMessagingDriver: client lacks the messages page API');
  const page = args.pageToken !== undefined ? await messages.getPage(args.pageToken) : await messages.page({ to: args.to, from: args.from, pageSize: args.pageSize });
  const providerPageSize = (page as { _payload?: { page_size?: unknown } })._payload?.page_size;
  if (typeof providerPageSize === 'number' && providerPageSize !== args.pageSize) {
    this.log.warn({ requested: args.pageSize, provider: providerPageSize }, 'twilio messages list: provider page size differs from the requested one');
  }
  return { messages: page.instances.map(summarize), ...(typeof page.nextPageUrl === 'string' && page.nextPageUrl.length > 0 && { nextPageToken: page.nextPageUrl }) };
}
async getMessage(providerSid: string): Promise<ProviderMessageSummary | undefined> {
  if (typeof (this.client as { messages?: unknown }).messages !== 'function') throw new Error('TwilioMessagingDriver: client lacks per-message resources');
  const client = this.client as unknown as { messages(sid: string): { fetch(): Promise<unknown> } };
  try { return summarize(await client.messages(providerSid).fetch()); }
  catch (err) { const e = err as { status?: unknown; code?: unknown }; if (e.status === 404 || Number(e.code) === 20404) return undefined; throw err; }
}
```

(`PageLike = { instances: unknown[]; nextPageUrl?: string | null; _payload?: { page_size?: unknown } }`.) Console driver: a module-level `consoleSent: Array<ProviderMessageSummary & { to: string; from?: string }>` capped at 1000 (shift the oldest); `sendPreparedMessage` pushes; `listMessages` filters `to`/`from`, newest first, one page (no token); `getMessage` finds by SID; export the two `_...ForTests` seams.

Typed fakes: each gains `listMessages: async () => ({ messages: [] }), getMessage: async () => undefined`. The harness adapter (`twilioWebhookHarness.ts:3766-3868`): keep `world.sent.push(prepared.params)` exactly; ALSO `world.sentDetails.push({ params: prepared.params, sid, providerTs })`; `listMessages` answers from `world.sentDetails` (mapped to summaries with `providerStatus: 'queued'`, `createdAt: providerTs`) plus `world.providerMessages`, filtered by `to`/`from`, newest first, paginated at `world.listPageSize` (default 1000) with an integer `pageToken`; `getMessage` searches both.

- [ ] **Step 3: Run, typecheck, commit**

Run: `cd app; npx vitest run test/messaging.test.ts test/twilioStatusWebhook.test.ts` -> PASS. `npm run typecheck` -> 0.

```bash
git status
git add app/src/adapters/messaging.ts app/test/messaging.test.ts app/test/helpers/twilioWebhookHarness.ts app/test/scheduledSendSuppression.test.ts app/test/sendMessage.test.ts app/test/tourReminders.test.ts app/test/poolNumbers.test.ts app/test/relayWarm.test.ts
git commit -m "feat(adapter): listMessages and getMessage on the messaging port; pin the Twilio request timeout to the claim TTL" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 5: The send-attempt record repo, `guardWrite`, the deps fields and the world wiring (D8a, D11, D12, D7a)

**Files:**
- Create: `app/src/repos/sendAttemptsRepo.ts`, `app/test/sendAttemptsRepo.integration.test.ts` (DynamoDB Local)
- Create: `app/src/lib/guardWrite.ts`, `app/test/guardWrite.test.ts`
- Modify: `app/src/lib/tables.ts:213-230` (add the two families to the TTL comment list)
- Modify: `app/src/jobs/broadcastFanOut.ts:187-205` (`BroadcastSendJobDeps.sendAttemptsRepo?: SendAttemptsRepo`), `app/src/jobs/relayFanOut.ts:636-672` (`RelayFanOutJobDeps.sendAttemptsRepo?`), `app/src/jobs/relayRetryLeg.ts:115-146` (`RelayRetryLegJobDeps.sendAttemptsRepo?`), `app/src/jobs/registerHandlers.ts:46-73` (`RegisterJobHandlersDeps.sendAttemptsRepo?`, passed to the three registrations). The fields are ACCEPTED AND IGNORED until Tasks 7-9 read them; they exist now so the test wiring below typechecks (the deps interfaces have no index signature - an unknown property is TS2353 and `tsconfig.test.json` typechecks `test/`).
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (`world.sendAttempts`, `world.sendAttemptIndex`, `world.sendAttemptsRepo`; returned from `createFakeWorld()`)
- Create: `app/test/twilioWebhookHarnessSendAttempts.test.ts` (harness parity)
- Modify: EVERY test file that registers an adopted handler - find them with `grep -l -E "registerBroadcastSendJobHandler|registerRelayFanOutJobHandler|registerRelayRetryLegJobHandler|registerAllJobHandlers" app/test/*.ts app/test/**/*.ts` - so each passes `sendAttemptsRepo: world.sendAttemptsRepo` (or the file's own world name). Why now: Tasks 7-9 add `sendAttempts ??= deps.sendAttemptsRepo ?? createSendAttemptsRepo(...)`, a REAL DynamoDB repo, and a fake-world test that omits the field would open a real connection on its first job run.

**Interfaces:**
- Consumes: `hashRecipientKey` (Task 2); `SEND_CLAIM_TTL_MS` (Task 1); `RepoDeps` (`conversationsRepo.ts:530-536`); `getDocumentClient`, `tableName`.
- Produces: everything under `app/src/repos/sendAttemptsRepo.ts` and `app/src/lib/guardWrite.ts` in the shared block, plus `SEND_ATTEMPT_PARTITION_PREFIX = 'sendattempt#'`, `SEND_ATTEMPT_INDEX_PREFIX = 'sendattemptix#'`, `SEND_ATTEMPT_CLEANUP_MS = 30 * 24 * 60 * 60 * 1000`; the four optional deps fields.

**Key shapes (messages table):**
- Record item: `conversationId = 'sendattempt#' + ownerKey(owner)`, `tsMsgId = hashRecipientKey(recipientKey)`; `ownerKey` is `broadcast#<broadcastId>` | `relay#<conversationId>#<sourceTsMsgId>` | `rung#<conversationId>#<retryTsMsgId>`; attributes `attempt_state` (never `state` - reserved), `attempt_no`, `attempted_at`, `redrive_count`, `check_no`, `sid?`, `outcome?`, `cause?`, `recipient_digest`, `sender` (`null` when unset - the DocumentClient needs `removeUndefinedValues`, so write `null` so the attribute exists), `body_hash`, `body_short`, `media_count`, `owner` (map), `expires_at` (epoch seconds, now + 30 d).
- Index item: `conversationId = 'sendattemptix#' + (sender ?? '-') + '#' + recipientDigest`, `tsMsgId = attemptedAt + '#' + ownerKey + '#' + hashedRecipientKey`; attributes `owner`, `attempted_at`, `body_hash`, `body_short`, `media_count`, `expires_at`. Written in the SAME TransactWrite as the claim; never updated (the record is read for live state).

- [ ] **Step 1: `guardWrite`, failing test first**

```ts
// app/test/guardWrite.test.ts
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { guardWrite } from '../src/lib/guardWrite.js';
import { createLogCapture } from './helpers/logCapture.js';

describe('guardWrite (spec D7a)', () => {
  it('returns true when the write resolves and logs nothing', async () => {
    const capture = createLogCapture();
    const log = createLogger({ destination: capture.stream });
    expect(await guardWrite(log, { owner: 'x' }, 'finishAttempt', async () => undefined)).toBe(true);
    expect(capture.atLevel(50)).toHaveLength(0);
  });
  it('returns false when the write throws, logs ERROR with the label and context, never throws', async () => {
    const capture = createLogCapture();
    const log = createLogger({ destination: capture.stream });
    expect(await guardWrite(log, { broadcastId: 'b-1', recipientKey: 'phone#redacted' }, 'handToReconcile', async () => { throw new Error('dynamo blip'); })).toBe(false);
    const errors = capture.atLevel(50);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ label: 'handToReconcile', broadcastId: 'b-1', recipientKey: 'phone#redacted' });
    expect(String(errors[0]!['msg'])).toContain('failure-arm write failed');
  });
});
```

```ts
// app/src/lib/guardWrite.ts
// Spec D7a: a write made from a FAILURE arm must never throw out of the
// recipient unit - a throw there is the anchor bug in its most likely form
// (a DB blip under the run-once marker). The record fence decides what the
// recipient's state is; a lost write is logged at ERROR and left to the
// stale-claim takeover.
type ErrorLogger = { error: (obj: Record<string, unknown>, msg: string) => void };

export async function guardWrite(log: ErrorLogger, ctx: Record<string, unknown>, label: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    log.error({ err, ...ctx, label }, 'failure-arm write failed (best-effort); the attempt record decides');
    return false;
  }
}
```

Run: `cd app; npx vitest run test/guardWrite.test.ts` -> PASS (2 tests).

- [ ] **Step 2: Failing integration tests (the transition table)**

```ts
// app/test/sendAttemptsRepo.integration.test.ts
// Skeleton per .superpowers/sdd/plan-data-layer-reference.md Sec 11: the per-file
// table prefix, ensureTable('messages') in beforeAll, delete in afterAll,
// `reachable` from the shared DynamoDB Local probe; `doc` and `table` are the
// file's own document client and table name.
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { hashRecipientKey } from '../src/lib/sendFingerprint.js';
import { createSendAttemptsRepo, ownerKey, type SendAttemptFacts, type SendAttemptOwner } from '../src/repos/sendAttemptsRepo.js';

// ONE owner and ONE index partition PER CASE: the table is created once per
// file and never reset between cases, so a shared owner would carry state
// from case to case (a done/sent record refuses every later claim).
let seq = 0;
let owner: SendAttemptOwner;
let facts: SendAttemptFacts;
beforeEach(() => {
  seq += 1;
  owner = { kind: 'broadcast', broadcastId: `b-${seq}`, contactKey: 'phone#+16175550100' };
  facts = { recipientDigest: `d${seq}`.padEnd(32, 'd'), sender: '+15550009999', bodyHash: 'h'.repeat(64), bodyShort: false, mediaCount: 0 };
});
const T0 = '2026-09-26T12:00:00.000Z';
const T1 = '2026-09-26T12:00:05.000Z';

describe.skipIf(!reachable)('sendAttemptsRepo (spec D8a/D11)', () => {
  it('creates and claims an absent record; a second claim inside the TTL is refused fresh', async () => {
    expect(await repo.claim(owner, facts, T0)).toMatchObject({ outcome: 'claimed', record: { state: 'attempting', attemptNo: 1, attemptedAt: T0, redriveCount: 0, checkNo: 0 } });
    expect(await repo.claim(owner, facts, T1)).toMatchObject({ outcome: 'refused', fresh: true, record: { state: 'attempting' } });
  });
  it('hashes a phone-bearing recipient key into the sort key', async () => {
    await repo.claim(owner, facts, T0);
    const raw = await doc.send(new GetCommand({ TableName: table, Key: { conversationId: `sendattempt#${ownerKey(owner)}`, tsMsgId: 'phone#+16175550100' } }));
    expect(raw.Item).toBeUndefined();
    const hashed = await doc.send(new GetCommand({ TableName: table, Key: { conversationId: `sendattempt#${ownerKey(owner)}`, tsMsgId: hashRecipientKey('phone#+16175550100') } }));
    expect(hashed.Item).toMatchObject({ attempt_state: 'attempting', expires_at: expect.any(Number) });
  });
  it('finishAttempt is fenced on attemptNo AND attemptedAt', async () => {
    await repo.claim(owner, facts, T0);
    expect(await repo.finishAttempt(owner, { attemptNo: 1, attemptedAt: T1 }, { outcome: 'sent', sid: 'SM1' })).toBe(false);
    expect(await repo.finishAttempt(owner, { attemptNo: 2, attemptedAt: T0 }, { outcome: 'sent', sid: 'SM1' })).toBe(false);
    expect(await repo.finishAttempt(owner, { attemptNo: 1, attemptedAt: T0 }, { outcome: 'sent', sid: 'SM1' })).toBe(true);
    expect(await repo.get(owner)).toMatchObject({ state: 'done', outcome: 'sent', sid: 'SM1' });
  });
  it('a record holding a SID refuses every later claim, whatever the slot says', async () => {
    await repo.claim(owner, facts, T0);
    await repo.finishAttempt(owner, { attemptNo: 1, attemptedAt: T0 }, { outcome: 'sent', sid: 'SM1' });
    expect(await repo.claim(owner, facts, T1)).toMatchObject({ outcome: 'refused', fresh: false });
  });
  it('done/retryable and redriven are claimable; attemptNo advances; redriveCount is untouched', async () => {
    await repo.claim(owner, facts, T0);
    await repo.finishAttempt(owner, { attemptNo: 1, attemptedAt: T0 }, { outcome: 'retryable', cause: '20429' });
    expect(await repo.claim(owner, facts, T1)).toMatchObject({ outcome: 'claimed', record: { attemptNo: 2, attemptedAt: T1 } });
    await repo.handToReconcile(owner, { attemptNo: 2, attemptedAt: T1 });
    expect(await repo.markRedriven(owner, T1)).toBe(true);
    expect(await repo.markRedriven(owner, T1)).toBe(false);   // redriveCount already 1
    expect(await repo.claim(owner, facts, '2026-09-26T12:01:00.000Z')).toMatchObject({ outcome: 'claimed', record: { attemptNo: 3, redriveCount: 1 } });
  });
  it('a stale attempting record (older than the TTL) is a takeover, not a send; the late outcome write is refused', async () => {
    await repo.claim(owner, facts, T0);
    const late = await repo.claim(owner, facts, '2026-09-26T12:00:31.000Z');
    expect(late).toMatchObject({ outcome: 'takeover', record: { state: 'attempting', attemptedAt: T0 } });
    if (late.outcome !== 'takeover') throw new Error('expected takeover');
    expect(await repo.takeOver(owner, late.record)).toBe(true);
    expect(await repo.get(owner)).toMatchObject({ state: 'reconciling', attemptedAt: T0, checkNo: 0 });
    expect(await repo.finishAttempt(owner, { attemptNo: 1, attemptedAt: T0 }, { outcome: 'sent', sid: 'SM1' })).toBe(false);
    expect(await repo.takeOver(owner, late.record)).toBe(false);   // idempotent: already reconciling
  });
  it('recordCheck tolerates its own duplicate and refuses a skip or another attempt', async () => {
    await repo.claim(owner, facts, T0);
    await repo.handToReconcile(owner, { attemptNo: 1, attemptedAt: T0 });
    expect(await repo.recordCheck(owner, T0, 1)).toBe(true);
    expect(await repo.recordCheck(owner, T0, 1)).toBe(true);
    expect(await repo.recordCheck(owner, T0, 3)).toBe(false);
    expect(await repo.recordCheck(owner, T1, 2)).toBe(false);
  });
  it('closeFromReconcile is forward-only and idempotent', async () => {
    await repo.claim(owner, facts, T0);
    await repo.handToReconcile(owner, { attemptNo: 1, attemptedAt: T0 });
    expect(await repo.closeFromReconcile(owner, T0, { outcome: 'unresolved', cause: 'provider_unreachable' })).toBe(true);
    expect(await repo.closeFromReconcile(owner, T0, { outcome: 'adopted', sid: 'SM9' })).toBe(false);
    expect(await repo.get(owner)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'provider_unreachable' });
  });
  it('closeRedriven accepts refused, redrive_refused, enqueue_failed and unresolved, once', async () => {
    for (const outcome of ['refused', 'redrive_refused', 'enqueue_failed', 'unresolved'] as const) {
      const o: SendAttemptOwner = { kind: 'broadcast', broadcastId: `b-${seq}-${outcome}`, contactKey: 'c-1' };
      await repo.claim(o, facts, T0);
      await repo.handToReconcile(o, { attemptNo: 1, attemptedAt: T0 });
      await repo.markRedriven(o, T0);
      expect(await repo.closeRedriven(o, { outcome, cause: 'x' })).toBe(true);
      expect(await repo.closeRedriven(o, { outcome, cause: 'x' })).toBe(false);
      expect(await repo.get(o)).toMatchObject({ state: 'done', outcome, cause: 'x' });
    }
  });
  it('listByRecipient reads the index partition consistently, newest first, since a bound', async () => {
    const other: SendAttemptOwner = { kind: 'relay_leg', relayConversationId: 'conv-r', sourceTsMsgId: '2026-09-26T11:00:00.000Z#SMx', memberKey: 'contact-9' };
    await repo.claim(owner, facts, T0);
    await repo.claim(other, facts, T1);
    const rows = await repo.listByRecipient('+15550009999', facts.recipientDigest, '2026-09-26T11:59:00.000Z');
    expect(rows.map((r) => r.attemptedAt)).toEqual([T1, T0]);
    expect(rows.map((r) => r.owner.kind)).toEqual(['relay_leg', 'broadcast']);
    expect(await repo.listByRecipient('+15550009999', facts.recipientDigest, '2026-09-26T12:00:01.000Z')).toHaveLength(1);
    expect(await repo.listByRecipient('+15550001111', facts.recipientDigest, T0)).toHaveLength(0);
  });
  it('a sender-less record indexes under the "-" partition', async () => {
    const { sender: _s, ...noSender } = facts;
    await repo.claim(owner, noSender, T0);
    expect(await repo.listByRecipient('-', facts.recipientDigest, T0)).toHaveLength(1);
  });
});
```

Every method above runs against DynamoDB Local, so an unused alias in any expression (a ValidationException) fails its case - that is the round-1 trap's regression test.

Run: `npm run db:start` (once); `cd app; npx vitest run test/sendAttemptsRepo.integration.test.ts` -> FAIL (module missing).

- [ ] **Step 3: Implement the repo**

```ts
// app/src/repos/sendAttemptsRepo.ts
// The per-recipient SEND-ATTEMPT RECORD (spec D8a) and its recipient-keyed
// index (spec D8a, second family). Coordination state for a send lives HERE,
// never in the recipient slot: six writers share the slot and two rewrite it
// wholesale. Every transition is a conditional write fenced on the attempt
// (attemptNo + attemptedAt), so a stale writer cannot overwrite a newer
// attempt and a redelivered job converges (D11). EVERY expression below lists
// exactly the aliases and values it uses - DynamoDB rejects an unused one.
import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { hashRecipientKey } from '../lib/sendFingerprint.js';
import { SEND_CLAIM_TTL_MS } from '../lib/sendOutcome.js';
import type { RepoDeps } from './conversationsRepo.js';

export const SEND_ATTEMPT_PARTITION_PREFIX = 'sendattempt#';
export const SEND_ATTEMPT_INDEX_PREFIX = 'sendattemptix#';
export const SEND_ATTEMPT_CLEANUP_MS = 30 * 24 * 60 * 60 * 1000;

export type SendAttemptOwner =
  | { kind: 'broadcast'; broadcastId: string; contactKey: string }
  | { kind: 'relay_leg'; relayConversationId: string; sourceTsMsgId: string; memberKey: string }
  | { kind: 'relay_rung'; relayConversationId: string; retryTsMsgId: string; memberKey: string };
export type SendAttemptState = 'attempting' | 'reconciling' | 'redriven' | 'done';
export type SendAttemptOutcome = 'sent' | 'rejected' | 'retryable' | 'refused' | 'adopted' | 'never_sent' | 'unresolved' | 'enqueue_failed' | 'redrive_refused';
export interface SendAttemptFacts { recipientDigest: string; sender?: string; bodyHash: string; bodyShort: boolean; mediaCount: number; }
export interface SendAttemptRecord extends SendAttemptFacts {
  owner: SendAttemptOwner; state: SendAttemptState; attemptNo: number; attemptedAt: string; redriveCount: number; checkNo: number;
  sid?: string; outcome?: SendAttemptOutcome; cause?: string;
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

export function ownerKey(owner: SendAttemptOwner): string {
  switch (owner.kind) {
    case 'broadcast': return `broadcast#${owner.broadcastId}`;
    case 'relay_leg': return `relay#${owner.relayConversationId}#${owner.sourceTsMsgId}`;
    case 'relay_rung': return `rung#${owner.relayConversationId}#${owner.retryTsMsgId}`;
  }
}
function recipientKeyOf(owner: SendAttemptOwner): string { return owner.kind === 'broadcast' ? owner.contactKey : owner.memberKey; }
/** The RECORD's identity (owner AND recipient). Sibling comparisons use this, never ownerKey alone: two contacts on one phone in one broadcast are two records. */
export function attemptKey(owner: SendAttemptOwner): string { return `${ownerKey(owner)}|${hashRecipientKey(recipientKeyOf(owner))}`; }
function recordKey(owner: SendAttemptOwner): { conversationId: string; tsMsgId: string } {
  return { conversationId: `${SEND_ATTEMPT_PARTITION_PREFIX}${ownerKey(owner)}`, tsMsgId: hashRecipientKey(recipientKeyOf(owner)) };
}
function indexPartition(sender: string | undefined, recipientDigest: string): string { return `${SEND_ATTEMPT_INDEX_PREFIX}${sender ?? '-'}#${recipientDigest}`; }
function expiresAt(nowMs: number): number { return Math.floor((nowMs + SEND_ATTEMPT_CLEANUP_MS) / 1000); }

function toRecord(item: Record<string, unknown>): SendAttemptRecord {
  return {
    owner: item['owner'] as SendAttemptOwner,
    state: item['attempt_state'] as SendAttemptState,
    attemptNo: Number(item['attempt_no']),
    attemptedAt: String(item['attempted_at']),
    redriveCount: Number(item['redrive_count'] ?? 0),
    checkNo: Number(item['check_no'] ?? 0),
    ...(typeof item['sid'] === 'string' && { sid: item['sid'] }),
    ...(typeof item['outcome'] === 'string' && { outcome: item['outcome'] as SendAttemptOutcome }),
    ...(typeof item['cause'] === 'string' && { cause: item['cause'] }),
    recipientDigest: String(item['recipient_digest']),
    ...(typeof item['sender'] === 'string' && { sender: item['sender'] }),
    bodyHash: String(item['body_hash']),
    bodyShort: item['body_short'] === true,
    mediaCount: Number(item['media_count'] ?? 0),
  };
}

interface Expr { update: string; condition: string; names: Record<string, string>; values: Record<string, unknown>; }

export function createSendAttemptsRepo(deps: RepoDeps = {}): SendAttemptsRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('messages', deps.env);

  async function get(owner: SendAttemptOwner): Promise<SendAttemptRecord | undefined> {
    const { Item } = await doc.send(new GetCommand({ TableName: table, Key: recordKey(owner), ConsistentRead: true }));
    return Item === undefined ? undefined : toRecord(Item);
  }

  // The claim's record Update: one builder per starting state, each listing ONLY what its strings use.
  const CLAIM_SET = 'SET #st = :attempting, #no = :no, #at = :at, #exp = :exp, #owner = :owner, #rd = :rd, #sender = :sender, #bh = :bh, #bs = :bs, #mc = :mc, #rc = if_not_exists(#rc, :zero), #ck = :zero REMOVE #sid, #oc, #ca';
  const CLAIM_NAMES = { '#st': 'attempt_state', '#no': 'attempt_no', '#at': 'attempted_at', '#exp': 'expires_at', '#owner': 'owner', '#rd': 'recipient_digest', '#sender': 'sender', '#bh': 'body_hash', '#bs': 'body_short', '#mc': 'media_count', '#rc': 'redrive_count', '#ck': 'check_no', '#sid': 'sid', '#oc': 'outcome', '#ca': 'cause' };
  function claimValues(owner: SendAttemptOwner, facts: SendAttemptFacts, nowIso: string, attemptNo: number): Record<string, unknown> {
    return { ':attempting': 'attempting', ':no': attemptNo, ':at': nowIso, ':exp': expiresAt(Date.parse(nowIso)), ':owner': owner, ':rd': facts.recipientDigest, ':sender': facts.sender ?? null, ':bh': facts.bodyHash, ':bs': facts.bodyShort, ':mc': facts.mediaCount, ':zero': 0 };
  }
  function claimExpr(from: 'absent' | 'retryable' | 'redriven', owner: SendAttemptOwner, facts: SendAttemptFacts, nowIso: string, prev?: SendAttemptRecord): Expr {
    const attemptNo = (prev?.attemptNo ?? 0) + 1;
    const base = claimValues(owner, facts, nowIso, attemptNo);
    switch (from) {
      case 'absent':
        return { update: CLAIM_SET, condition: 'attribute_not_exists(tsMsgId)', names: CLAIM_NAMES, values: base };
      case 'retryable':
        return { update: CLAIM_SET, condition: '#st = :done AND #oc = :retryable AND #no = :prevNo', names: CLAIM_NAMES, values: { ...base, ':done': 'done', ':retryable': 'retryable', ':prevNo': prev!.attemptNo } };
      case 'redriven':
        return { update: CLAIM_SET, condition: '#st = :redriven AND #no = :prevNo', names: CLAIM_NAMES, values: { ...base, ':redriven': 'redriven', ':prevNo': prev!.attemptNo } };
    }
  }
  // (#st, #no, #oc appear in every CLAIM_SET, so the condition's use of them adds no unused alias;
  //  :done/:retryable/:redriven/:prevNo are added only by the branch whose condition names them.)

  async function writeClaim(owner: SendAttemptOwner, facts: SendAttemptFacts, nowIso: string, from: 'absent' | 'retryable' | 'redriven', prev?: SendAttemptRecord): Promise<boolean> {
    const key = recordKey(owner);
    const expr = claimExpr(from, owner, facts, nowIso, prev);
    try {
      await doc.send(new TransactWriteCommand({ TransactItems: [
        { Update: { TableName: table, Key: key, UpdateExpression: expr.update, ConditionExpression: expr.condition, ExpressionAttributeNames: expr.names, ExpressionAttributeValues: expr.values } },
        { Put: { TableName: table, Item: {
          conversationId: indexPartition(facts.sender, facts.recipientDigest),
          tsMsgId: `${nowIso}#${ownerKey(owner)}#${key.tsMsgId}`,
          owner, attempted_at: nowIso, body_hash: facts.bodyHash, body_short: facts.bodyShort, media_count: facts.mediaCount, expires_at: expiresAt(Date.parse(nowIso)),
        } } },
      ] }));
      return true;
    } catch (err) {
      if (err instanceof TransactionCanceledException || err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  async function claim(owner: SendAttemptOwner, facts: SendAttemptFacts, nowIso: string): Promise<ClaimResult> {
    if (await writeClaim(owner, facts, nowIso, 'absent')) return { outcome: 'claimed', record: (await get(owner))! };
    const record = await get(owner);
    if (record === undefined) return { outcome: 'refused', record: (await get(owner))!, fresh: true };   // lost a create race; the winner is fresh
    if (record.state === 'done' && record.outcome === 'retryable') {
      if (await writeClaim(owner, facts, nowIso, 'retryable', record)) return { outcome: 'claimed', record: (await get(owner))! };
      return { outcome: 'refused', record: (await get(owner))!, fresh: true };
    }
    if (record.state === 'redriven') {
      if (await writeClaim(owner, facts, nowIso, 'redriven', record)) return { outcome: 'claimed', record: (await get(owner))! };
      return { outcome: 'refused', record: (await get(owner))!, fresh: true };
    }
    if (record.state === 'attempting') {
      const ageMs = Date.parse(nowIso) - Date.parse(record.attemptedAt);
      return ageMs > SEND_CLAIM_TTL_MS ? { outcome: 'takeover', record } : { outcome: 'refused', record, fresh: true };
    }
    return { outcome: 'refused', record, fresh: false };   // reconciling, or done with a terminal outcome
  }

  async function transition(owner: SendAttemptOwner, expr: Expr): Promise<boolean> {
    try {
      await doc.send(new UpdateCommand({ TableName: table, Key: recordKey(owner), UpdateExpression: expr.update, ConditionExpression: expr.condition, ExpressionAttributeNames: expr.names, ExpressionAttributeValues: expr.values }));
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  return {
    claim,
    get,
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
    async listByRecipient(sender, recipientDigest, sinceIso) {
      const out: SendAttemptRecord[] = [];
      let startKey: Record<string, unknown> | undefined;
      do {
        const page = await doc.send(new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'conversationId = :p AND tsMsgId >= :since',
          ExpressionAttributeValues: { ':p': indexPartition(sender, recipientDigest), ':since': sinceIso },
          ScanIndexForward: false, ConsistentRead: true, Limit: 100,
          ...(startKey !== undefined && { ExclusiveStartKey: startKey }),
        }));
        for (const item of page.Items ?? []) {
          const rec = await get(item['owner'] as SendAttemptOwner);   // the record holds the live state
          if (rec !== undefined) out.push(rec);
        }
        startKey = page.LastEvaluatedKey;
      } while (startKey !== undefined);
      return out;
    },
  };
}
```

`listByRecipient(sender, ...)` takes the literal `'-'` for a sender-less partition (the callers pass `record.sender ?? '-'`). Add `sendattempt#` (record, 30 d) and `sendattemptix#` (index, 30 d) to the TTL family list comment in `app/src/lib/tables.ts:213-230`.

Run: `cd app; npx vitest run test/sendAttemptsRepo.integration.test.ts` -> PASS (11 tests).

- [ ] **Step 4: The deps fields**

Add `sendAttemptsRepo?: SendAttemptsRepo;` (type import from `../repos/sendAttemptsRepo.js`) to `BroadcastSendJobDeps`, `RelayFanOutJobDeps`, `RelayRetryLegJobDeps` and `RegisterJobHandlersDeps`; `registerAllJobHandlers` passes `sendAttemptsRepo: deps.sendAttemptsRepo` into the three registrations. Nothing reads it yet. `npm run typecheck` -> 0.

- [ ] **Step 5: The harness fake and its parity test**

In `twilioWebhookHarness.ts` add `sendAttempts: Map<string, SendAttemptRecord>` keyed by `${ownerKey(owner)}|${hashRecipientKey(recipientKey)}`, `sendAttemptIndex: Array<{ partition: string; sortKey: string; owner: SendAttemptOwner }>`, and `sendAttemptsRepo: SendAttemptsRepo` whose methods apply the SAME conditions in memory: compare `state`, `attemptNo`, `attemptedAt`, `checkNo`, `redriveCount` exactly as the expressions do, return `false` where the real one returns `false`, decide `takeover` by the same TTL, and hold `sender` as `undefined` when unset (the real one stores `null` and `toRecord` drops it - `get()` results must be equal). Export all three from `createFakeWorld()`.

Create `app/test/twilioWebhookHarnessSendAttempts.test.ts` on the `twilioWebhookHarnessRetryFields.test.ts` idiom: a table of scripted transition sequences (claim / finishAttempt / handToReconcile / takeOver / recordCheck / markRedriven / closeFromReconcile / closeRedriven / claim again, including the stale-takeover and the refused-fresh sequences) run against BOTH the fake and the real repo (the real half `describe.skipIf(!reachable)`), asserting identical boolean results and identical `get()` records.

Run: `cd app; npx vitest run test/twilioWebhookHarnessSendAttempts.test.ts` -> PASS.

- [ ] **Step 6: Wire every registration site** the grep found to pass `sendAttemptsRepo: world.sendAttemptsRepo`. Run the whole app suite once here: `cd app; npx vitest run` -> all green (the field is ignored until Task 7).

- [ ] **Step 7: Typecheck, commit**

```bash
npm run typecheck
git status
git add app/src/repos/sendAttemptsRepo.ts app/test/sendAttemptsRepo.integration.test.ts app/src/lib/guardWrite.ts app/test/guardWrite.test.ts app/src/lib/tables.ts app/src/jobs/broadcastFanOut.ts app/src/jobs/relayFanOut.ts app/src/jobs/relayRetryLeg.ts app/src/jobs/registerHandlers.ts app/test/helpers/twilioWebhookHarness.ts app/test/twilioWebhookHarnessSendAttempts.test.ts <every test file the grep listed>
git commit -m "feat(repos): the per-recipient send-attempt record and its recipient index, every transition fenced on the attempt; guardWrite; deps fields; test worlds wired" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 6: Repo additions the send sites and the reconcile job need (D8, D11, D13, D15, D16a, D22)

**Files:**
- Modify: `app/src/repos/messagesRepo.ts` (interface :1307-1912; `AppendResult` :1259-1264 and both return sites :2558 dedupe / :2598-2632 fresh; impl near :2035-2062, :3178-3201, :3661-3682, :3784-3821, :3855-3861; `RelayRecipientDelivery` :159-169 gains `attemptedAt?: string`; the forward-only table :133-141)
- Modify: `app/src/repos/broadcastsRepo.ts` (`BroadcastStats` :85-125 gains `unconfirmed?: number`; `deriveBroadcastStats` :254-306; `zeroStats` :309-321; interface :344-442; impl :454-457, :497-523, :671-717, :760-801)
- Modify the typed repo fakes: `app/test/helpers/twilioWebhookHarness.ts` (:1080 messages, :2902 broadcasts), `app/test/sendMessage.test.ts:233`, `app/test/scheduledSendSuppression.test.ts:273`
- Tests to extend: `app/test/relayRepos.integration.test.ts`, `app/test/broadcastsRepo.integration.test.ts`, `app/test/deriveBroadcastStats.test.ts`
- Tests that go RED from `AppendResult.conversationId` and are updated in this task: the exact-shape `toEqual`s at `app/test/messaging.integration.test.ts:137, :141, :152, :155` and `app/test/groupSendRepo.integration.test.ts:240` (add `conversationId`), any harness fake `append` returning `{ deduped, tsMsgId }` (add the field); `app/test/broadcastApi.test.ts:1269-1279` (the results stats full `toEqual` gains `unconfirmed: 0`).

**Interfaces:**
- Consumes: `SEND_UNCONFIRMED_CODE` (Task 1).
- Produces (messagesRepo):
  - `getByProviderSidConsistent(sid)`, `getRelaySidPointerConsistent(providerSid)`, `getSystemSidMarkerConsistent(providerSid)`, `listByConversationConsistent(conversationId, opts?)` - consistent twins of the existing reads.
  - `claimRelaySidPointer(providerSid, ref: { conversationId; tsMsgId; memberKey }): Promise<'created' | 'mine' | 'other'>` - the existing conditional put (`:3784-3806`); on CCF a `getRelaySidPointerConsistent` compares all three ref fields -> `'mine'` / `'other'`. `putRelaySidPointer` stays (its other caller `relayAnnouncements.ts:354` is Stage 2).
  - `closeRelayRecipientIfUnsent(conversationId, tsMsgId, memberKey, delivery: { status: 'failed'; errorCode: string }): Promise<'closed' | 'skipped_sent' | 'missing'>` - two statements, each with its OWN names/values: (1) `SET #dr.#mk.#st = :failed, #dr.#mk.#ec = :ec`, condition `attribute_exists(tsMsgId) AND attribute_exists(#dr.#mk) AND #dr.#mk.#st = :queued AND attribute_not_exists(#dr.#mk.#sid)`, names `{ '#dr': 'delivery_recipients', '#mk': memberKey, '#st': 'status', '#ec': 'errorCode', '#sid': 'sid' }`, values `{ ':failed': 'failed', ':ec': errorCode, ':queued': 'queued' }` (keeps `requestedTransport`, `attemptedAt`, every sibling field); on CCF (2) `SET #dr.#mk = :fresh`, condition `attribute_exists(tsMsgId) AND attribute_not_exists(#dr.#mk)`, names `{ '#dr': 'delivery_recipients', '#mk': memberKey }`, values `{ ':fresh': { status: 'failed', errorCode } }`; on a second CCF a consistent read decides `'missing'` (no row) vs `'skipped_sent'`. Legacy and versioned rows alike.
  - `adoptRelayRecipientIfUnsent(conversationId, tsMsgId, memberKey, patch: { status: DeliveryStatus; sid: string; sentAt: string; errorCode?: string }): Promise<'adopted' | 'skipped' | 'missing'>` - delegate FIRST to `applyRecipientSendResult` (`updated` -> `adopted`; `idempotent`/`stale`/`conflict` -> `skipped`; `missing` -> `missing`; `legacy_noop` (`messagesRepo.ts:3481`) -> the LEGACY branch below - that result IS the discriminator, no extra read). On a LEGACY row, FORWARD-ONLY (D15: a raced receipt is never regressed): (a) seed an absent slot: `SET #dr.#mk = if_not_exists(#dr.#mk, :seed)`, condition `attribute_exists(tsMsgId)`, names `{ '#dr': 'delivery_recipients', '#mk': memberKey }`, values `{ ':seed': { status: 'queued' } }` - CCF -> `'missing'`; (b) `SET #dr.#mk.#st = :st, #dr.#mk.#sid = if_not_exists(#dr.#mk.#sid, :sid), #dr.#mk.#sa = if_not_exists(#dr.#mk.#sa, :sa)[, #dr.#mk.#ec = :ec]`, condition `attribute_exists(#dr.#mk) AND #dr.#mk.#st IN (:p0, :p1, ...)` where the priors are `allowedPriorStatuses(patch.status)` - the file's own forward-only table at `:133-141` (use its real helper name) - PLUS `patch.status` itself (same-status idempotence); names `{ '#dr', '#mk', '#st': 'status', '#sid': 'sid', '#sa': 'sentAt'[, '#ec': 'errorCode'] }`, values `{ ':st', ':sid', ':sa'[, ':ec'], ':p0'.. }`; CCF -> `'skipped'`. Never `markRecipient`'s wholesale SET.
  - `setRelayRecipientAttemptedAt(conversationId, tsMsgId, memberKey, attemptedAt): Promise<void>` - two statements, each with its OWN names/values: (1) `SET #dr.#mk = if_not_exists(#dr.#mk, :seed)`, condition `attribute_exists(tsMsgId)`, names `{ '#dr': 'delivery_recipients', '#mk': memberKey }`, values `{ ':seed': { status: 'queued' } }`; (2) `SET #dr.#mk.#at = :at`, condition `attribute_exists(#dr.#mk)`, names `{ '#dr': 'delivery_recipients', '#mk': memberKey, '#at': 'attemptedAt' }`, values `{ ':at': attemptedAt }`; a CCF on either is WARNed and swallowed (best-effort); anything else throws.
  - `AppendResult` gains `conversationId: string` (fresh: the input's; dedupe: `ptr.ref_conversationId`).
  - `RelayRecipientDelivery.attemptedAt?: string` with the doc line "OUR attempt clock (D8a), best-effort; a wholesale write may drop it; never a provider timestamp."
- Produces (broadcastsRepo):
  - `getByIdConsistent(broadcastId)`.
  - `recordRecipientOutcome(broadcastId, contactKey, recipient: BroadcastRecipient, statsDelta: Partial<BroadcastStats>, allowedPriorStatuses: ReadonlyArray<BroadcastRecipient['status']>): Promise<{ moved: boolean; item?: BroadcastItem }>` - ONE UpdateCommand `SET recipients.#ck = :rec, #updatedAt = :now ADD stats.#a0 :v0[, stats.#a1 :v1 ...]` with condition `attribute_exists(broadcastId) AND recipients.#ck.#status IN (:ps0[, :ps1 ...])`, names `{ '#ck': contactKey, '#updatedAt': 'updated_at', '#status': 'status', '#a0': <bucket> ... }` ONLY for buckets present with a non-zero delta, values likewise (an EMPTY delta omits the `ADD` clause entirely - the slot-only write the pre-claim deferral uses), `ReturnValues: 'ALL_NEW'`; CCF -> `{ moved: false }`.
  - `closeRecipientIfQueued(broadcastId, contactKey, errorCode, statsBucket: 'failed' | 'unconfirmed')` = `recordRecipientOutcome(..., { status: 'failed', errorCode }, { [statsBucket]: 1, queued: -1 }, ['queued'])`.
  - `finalizeStatus(broadcastId, status: 'sent' | 'failed', lastError?): Promise<{ won: boolean; item: BroadcastItem }>` - `flipStatus`'s expression with condition `attribute_exists(broadcastId) AND #s = :sending` (values `{ ':status', ':now', ':sending': 'sending'[, ':err'] }`), `ReturnValues: 'ALL_NEW'`; on CCF a consistent read -> `{ won: false, item }` (throw if missing).
  - `deriveBroadcastStats` routes `failed` + `send_unconfirmed` to `unconfirmed`; `zeroStats` includes `unconfirmed: 0`.

- [ ] **Step 1: Failing relay-side tests**

In `app/test/relayRepos.integration.test.ts` add a describe `send-outcome additions` (use the file's real source-row fixtures for a legacy and a versioned row; `T0`/`T1` ISO strings):

```ts
it('claimRelaySidPointer reports created / mine / other', async () => {
  const ref = { conversationId: 'conv-1', tsMsgId: 'ts-1', memberKey: 'c-1' };
  expect(await messages.claimRelaySidPointer('SM1', ref)).toBe('created');
  expect(await messages.claimRelaySidPointer('SM1', ref)).toBe('mine');
  expect(await messages.claimRelaySidPointer('SM1', { ...ref, memberKey: 'c-2' })).toBe('other');
  expect(await messages.getRelaySidPointerConsistent('SM1')).toEqual(ref);
});
it('closeRelayRecipientIfUnsent closes an absent legacy slot and a queued sid-less slot, skips a queued slot with a sid', async () => {
  await messages.append({ ...legacySource, deliveryRecipients: {} });
  expect(await messages.closeRelayRecipientIfUnsent('conv-1', legacyTs, 'c-1', { status: 'failed', errorCode: 'transient_cap' })).toBe('closed');
  await messages.setRecipientDelivery('conv-1', legacyTs, 'c-2', { status: 'queued', sid: 'SM7', sentAt: T0 });
  expect(await messages.closeRelayRecipientIfUnsent('conv-1', legacyTs, 'c-2', { status: 'failed', errorCode: 'transient_cap' })).toBe('skipped_sent');
  expect((await messages.getByTsMsgIdConsistent('conv-1', legacyTs))!.delivery_recipients!['c-2']).toMatchObject({ status: 'queued', sid: 'SM7' });
  expect(await messages.closeRelayRecipientIfUnsent('conv-1', 'nope', 'c-1', { status: 'failed', errorCode: 'x' })).toBe('missing');
});
it('closeRelayRecipientIfUnsent on a versioned row keeps requestedTransport and is forward-only', async () => {
  await messages.append({ ...versionedSource, deliveryRecipients: { 'c-1': { status: 'queued', requestedTransport: 'sms', transportAggregationState: 'planned' } } });
  expect(await messages.closeRelayRecipientIfUnsent('conv-1', versionedTs, 'c-1', { status: 'failed', errorCode: 'transient_cap' })).toBe('closed');
  expect((await messages.getByTsMsgIdConsistent('conv-1', versionedTs))!.delivery_recipients!['c-1']).toMatchObject({ status: 'failed', errorCode: 'transient_cap', requestedTransport: 'sms' });
  expect(await messages.closeRelayRecipientIfUnsent('conv-1', versionedTs, 'c-1', { status: 'failed', errorCode: 'other' })).toBe('skipped_sent');
});
it('setRelayRecipientAttemptedAt seeds an absent legacy slot and never touches an existing slot's other fields', async () => {
  await messages.setRelayRecipientAttemptedAt('conv-1', legacyTs, 'c-3', T0);
  expect((await messages.getByTsMsgIdConsistent('conv-1', legacyTs))!.delivery_recipients!['c-3']).toEqual({ status: 'queued', attemptedAt: T0 });
  await messages.setRelayRecipientAttemptedAt('conv-1', legacyTs, 'c-2', T1);
  expect((await messages.getByTsMsgIdConsistent('conv-1', legacyTs))!.delivery_recipients!['c-2']).toMatchObject({ status: 'queued', sid: 'SM7', attemptedAt: T1 });
  await expect(messages.setRelayRecipientAttemptedAt('conv-1', 'nope', 'c-1', T0)).resolves.toBeUndefined();   // best-effort: WARN, no throw
});
it('adoptRelayRecipientIfUnsent on a legacy row is forward-only and seeds an absent slot', async () => {
  expect(await messages.adoptRelayRecipientIfUnsent('conv-1', legacyTs, 'c-9', { status: 'queued', sid: 'SM9', sentAt: T0 })).toBe('adopted');   // absent -> seeded -> adopted
  expect((await messages.getByTsMsgIdConsistent('conv-1', legacyTs))!.delivery_recipients!['c-9']).toMatchObject({ status: 'queued', sid: 'SM9', sentAt: T0 });
  expect(await messages.adoptRelayRecipientIfUnsent('conv-1', legacyTs, 'c-9', { status: 'sent', sid: 'SM9', sentAt: T1 })).toBe('adopted');
  expect((await messages.getByTsMsgIdConsistent('conv-1', legacyTs))!.delivery_recipients!['c-9']).toMatchObject({ status: 'sent', sentAt: T0 });   // the earlier sentAt is kept
  expect(await messages.adoptRelayRecipientIfUnsent('conv-1', legacyTs, 'c-9', { status: 'queued', sid: 'SM9', sentAt: T1 })).toBe('skipped');    // sent -> queued is a regression
  expect((await messages.getByTsMsgIdConsistent('conv-1', legacyTs))!.delivery_recipients!['c-9']!.status).toBe('sent');
  expect(await messages.adoptRelayRecipientIfUnsent('conv-1', legacyTs, 'c-9', { status: 'sent', sid: 'SM9', sentAt: T1 })).toBe('adopted');     // same status: idempotent
  await messages.updateRecipientDeliveryStatus(/* the file's call shape */ 'conv-1', legacyTs, 'c-9', 'delivered', T1);
  expect(await messages.adoptRelayRecipientIfUnsent('conv-1', legacyTs, 'c-9', { status: 'sent', sid: 'SM9', sentAt: T1 })).toBe('skipped');
  expect(await messages.adoptRelayRecipientIfUnsent('conv-1', 'nope', 'c-9', { status: 'sent', sid: 'SM9', sentAt: T1 })).toBe('missing');
});
it('adoptRelayRecipientIfUnsent on a versioned row adopts once and skips the re-run', async () => {
  await messages.append({ ...versionedSource, deliveryRecipients: { 'c-1': { status: 'queued', requestedTransport: 'sms', transportAggregationState: 'planned' } } });
  expect(await messages.adoptRelayRecipientIfUnsent('conv-1', versionedTs, 'c-1', { status: 'sent', sid: 'SM1', sentAt: T0 })).toBe('adopted');
  expect(await messages.adoptRelayRecipientIfUnsent('conv-1', versionedTs, 'c-1', { status: 'sent', sid: 'SM1', sentAt: T0 })).toBe('skipped');
});
it('the consistent reads exist and agree with their eventual twins', async () => {
  expect(await messages.getByProviderSidConsistent('SMabsent')).toBeUndefined();
  expect(await messages.getSystemSidMarkerConsistent('SMabsent')).toBeUndefined();
  expect(await messages.listByConversationConsistent('conv-1', { limit: 5 })).toEqual(await messages.listByConversation('conv-1', { limit: 5 }));
});
it('append reports the conversation of a deduped row', async () => {
  const first = await messages.append(row);
  const dup = await messages.append({ ...row, conversationId: 'conv-other' });
  expect(dup).toEqual({ deduped: true, tsMsgId: first.tsMsgId, conversationId: 'conv-1' });
});
```

Run: `cd app; npx vitest run test/relayRepos.integration.test.ts -t "send-outcome additions"` -> FAIL.

- [ ] **Step 2: Implement the messagesRepo additions** as in Interfaces: `getByProviderSidConsistent` = `getSidPointer(sid, { consistent: true })` then a `GetCommand` with `ConsistentRead: true`; the other two consistent Gets; `listByConversationConsistent` = the Query at `:3178-3194` with `ConsistentRead: true`; `claimRelaySidPointer`; `closeRelayRecipientIfUnsent`; `adoptRelayRecipientIfUnsent`; `setRelayRecipientAttemptedAt`; `AppendResult.conversationId` (fresh path returns `message.conversationId`; dedupe path `:2543-2558` returns `ptr.ref_conversationId`); `RelayRecipientDelivery.attemptedAt?`. Update the three typed MessagesRepo fakes with faithful in-memory versions: the harness's `closeRelayRecipientIfUnsent` models absent / queued-no-sid / queued-with-sid / missing; `adoptRelayRecipientIfUnsent` models the forward-only table and the seed; `claimRelaySidPointer` models created / mine / other over `world.relaySidPointers`; the consistent twins delegate to the eventual ones.

Run: `cd app; npx vitest run test/relayRepos.integration.test.ts` -> PASS.

- [ ] **Step 3: Failing broadcast-side tests**

In `app/test/broadcastsRepo.integration.test.ts` (use the file's seeded broadcast with a `queued` recipient `c-1`):

```ts
it('recordRecipientOutcome writes the slot and bumps stats in ONE conditional write', async () => {
  const r = await broadcasts.recordRecipientOutcome('b-1', 'c-1', { status: 'sent', conversationId: 'conv-1', tsMsgId: 'ts-1' }, { sent: 1, queued: -1 }, ['queued']);
  expect(r.moved).toBe(true);
  expect(r.item!.stats).toMatchObject({ sent: 1, queued: 0 });
  const again = await broadcasts.recordRecipientOutcome('b-1', 'c-1', { status: 'failed', errorCode: 'x' }, { failed: 1, queued: -1 }, ['queued']);
  expect(again).toEqual({ moved: false });
  expect((await broadcasts.getByIdConsistent('b-1'))!.stats).toMatchObject({ sent: 1, failed: 0 });
});
it('recordRecipientOutcome with a single-bucket delta lists only that bucket', async () => {
  const r = await broadcasts.recordRecipientOutcome('b-1', 'c-1', { status: 'skipped', errorCode: 'opted_out' }, { skipped_opted_out: 1 }, ['queued']);
  expect(r.moved).toBe(true);   // an unused alias would be a ValidationException here
});
it('recordRecipientOutcome with an EMPTY delta writes the slot only, under the priors', async () => {
  const r = await broadcasts.recordRecipientOutcome('b-1', 'c-1', { status: 'queued', errorCode: 'send_retryable' }, {}, ['queued']);
  expect(r.moved).toBe(true);
  expect(r.item!.recipients['c-1']).toEqual({ status: 'queued', errorCode: 'send_retryable' });
  expect(r.item!.stats.queued).toBe(1);   // untouched
  expect(await broadcasts.recordRecipientOutcome('b-1', 'c-1', { status: 'queued', errorCode: 'send_retryable' }, {}, ['sent'])).toEqual({ moved: false });
});
it('closeRecipientIfQueued bumps the unconfirmed bucket, creating it on a legacy stats map', async () => {
  const r = await broadcasts.closeRecipientIfQueued('b-legacy', 'c-1', 'send_unconfirmed', 'unconfirmed');
  expect(r.item!.stats.unconfirmed).toBe(1);
  expect(r.item!.recipients['c-1']).toMatchObject({ status: 'failed', errorCode: 'send_unconfirmed' });
});
it('finalizeStatus wins once', async () => {
  const a = await broadcasts.finalizeStatus('b-1', 'sent');
  const b = await broadcasts.finalizeStatus('b-1', 'failed', 'late');
  expect(a.won).toBe(true);
  expect(b).toMatchObject({ won: false, item: { status: 'sent' } });
});
```

In `app/test/deriveBroadcastStats.test.ts` extend the full-object `toEqual` (`:43-53`) with `unconfirmed: 0`, extend the 50-slot invariant (`:93-123`) so the sum includes `unconfirmed`, and add:

```ts
it('routes a failed slot carrying send_unconfirmed to unconfirmed and to no other bucket (D22)', () => {
  const s = deriveBroadcastStats({ recipients: recips([['a', { status: 'failed', errorCode: 'send_unconfirmed' }], ['b', { status: 'failed', errorCode: '30007' }]]), stats: zeroStats() });
  expect(s).toMatchObject({ unconfirmed: 1, failed: 1, audience: 2 });
});
```

Update the RED pins listed under Files. Run: `cd app; npx vitest run test/broadcastsRepo.integration.test.ts test/deriveBroadcastStats.test.ts` -> FAIL.

- [ ] **Step 4: Implement the broadcastsRepo additions**: `BroadcastStats.unconfirmed?: number` (doc: "closed `failed` slots carrying `send_unconfirmed`; optional - persisted rows predate it, readers default 0"); `deriveBroadcastStats`'s `failed` arm `if (slot.errorCode === SEND_UNCONFIRMED_CODE) unconfirmed += 1; else failed += 1;`; `zeroStats` gains `unconfirmed: 0`; `getByIdConsistent`; `recordRecipientOutcome`; `closeRecipientIfQueued`; `finalizeStatus`. Typed BroadcastsRepo fakes gain the four methods modelling the priors and the `sending` condition.

- [ ] **Step 5: Run the touched suites and typecheck**

Run: `cd app; npx vitest run test/relayRepos.integration.test.ts test/broadcastsRepo.integration.test.ts test/deriveBroadcastStats.test.ts test/broadcastApi.test.ts test/messaging.integration.test.ts test/groupSendRepo.integration.test.ts` -> PASS. `npm run typecheck` -> 0.

- [ ] **Step 6: Commit**

```bash
git status
git add app/src/repos/messagesRepo.ts app/src/repos/broadcastsRepo.ts app/test/relayRepos.integration.test.ts app/test/broadcastsRepo.integration.test.ts app/test/deriveBroadcastStats.test.ts app/test/broadcastApi.test.ts app/test/messaging.integration.test.ts app/test/groupSendRepo.integration.test.ts app/test/helpers/twilioWebhookHarness.ts app/test/sendMessage.test.ts app/test/scheduledSendSuppression.test.ts
git commit -m "feat(repos): conditional recipient closes and forward-only adoptions, consistent reads, a reporting SID claim, an idempotent finalize flip and the unconfirmed bucket" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Slice B - the send sites

### Task 3: Typed errors from `sendMessage` (D3) - lands immediately before Task 7

**Files:**
- Modify: `app/src/services/sendMessage.ts` (errors block after `:191`; steps at `:332`, `:361`, `:431-439`, `:465-475`, `:479-519`, `:523-539`)
- Test: `app/test/sendMessage.test.ts` (extend `makeFakes` overrides at `:57-66`; add cases; the file's log capture is `f.capture` and its ERROR level constant is `const ERROR = 50` at `:39`; the fixture conversation's `participant_phone` is `+15550100001` at `:68`; `Fakes` (`:41-55`) has NO `env` - read what BUSINESS_PHONE_NUMBER the fixture config carries and what SID the fake adapter returns, and use those)

**Interfaces:**
- Consumes: `classifySendFailure`, `SendFailureClassification` (Task 1); `bodyFingerprint`, `recipientDigest` (Task 2); `SendAttemptFacts` (Task 5 - `import type { SendAttemptFacts } from '../repos/sendAttemptsRepo.js'`; a type import keeps this module a runtime leaf).
- Produces: `SendNotAttemptedError`, `ProviderSendFailedError` (with own `code` and `status` mirroring the cause's), `SendAcceptedNotRecordedError`; the post-append swallow. Behavior change for EVERY caller: a non-refusal throw is now one of these three classes and a post-append failure no longer throws (the staff send route answers 201 where it answered 500). `retrySend.ts` is unchanged and rethrows these as before; the broadcast arms keep matching because `errorCodeOf(err)` (`app/src/jobs/broadcastFanOut.ts:176-185`) reads `code`/`status` off the wrapper's own properties.

- [ ] **Step 1: Extend the fixture seams**

In `makeFakes` overrides (`:57-66`) add `getByIdError?: unknown; findByPhoneError?: unknown; incrementError?: unknown; appendError?: unknown; touchError?: unknown; auditError?: unknown;` and throw them at the matching fake methods (`conversationsRepo.getById`, `contactsRepo.findByPhone`, `incrementAutomatedSendCount`, `messagesRepo.append` :234-237, `touchLastActivity` :125-130, `auditRepo.append` :312-317): `if (overrides.xError !== undefined) throw overrides.xError;` before each normal body.

- [ ] **Step 2: Failing tests**

```ts
describe('typed send errors (spec D3)', () => {
  // `base`, the live-contact fixture, `f.sent`, `f.appended`, `f.emitted`, the configured BUSINESS_PHONE_NUMBER
  // and the fake adapter's SID are the file's real names/values - read makeFakes first.
  const base = { conversationId: 'conv-1', body: 'Hey there' };
  it('a DB failure before the provider call is SendNotAttemptedError and sends nothing', async () => {
    const f = makeFakes({ findByPhoneError: new Error('dynamo down') });
    await expect(f.service(base)).rejects.toBeInstanceOf(SendNotAttemptedError);
    expect(f.sent).toHaveLength(0);
  });
  it('a refusal is NEVER wrapped', async () => {
    const f = makeFakes({ contact: { ...<the live contact fixture>, sms_opt_out: true } });
    await expect(f.service(base)).rejects.toBeInstanceOf(SendRefusedError);
  });
  it('a provider throw becomes ProviderSendFailedError carrying the classification, the cause message, the facts, and the cause code/status as own properties', async () => {
    const f = makeFakes({ sendError: Object.assign(new Error('provider unavailable'), { status: 503, code: 20500 }) });
    const err = await f.service(base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderSendFailedError);
    const typed = err as ProviderSendFailedError;
    expect(typed.message).toContain('provider unavailable');
    expect(typed.classification).toMatchObject({ kind: 'unknown', code: '20500', status: 503 });
    expect(typed.code).toBe(20500);
    expect(typed.status).toBe(503);
    expect((typed as { code?: unknown }).code).toBe(20500);   // what errorCodeOf reads
    expect(typed.facts.bodyHash).toBe(bodyFingerprint('Hey there').hash);
    expect(typed.facts.mediaCount).toBe(0);
    expect(typed.facts.recipientDigest).toBe(recipientDigest(<the configured BUSINESS_PHONE_NUMBER>, '+15550100001'));
    expect(Date.parse(typed.attemptedAt)).not.toBeNaN();
    expect(f.appended).toHaveLength(0);
  });
  it('an append failure after acceptance is SendAcceptedNotRecordedError with the SID', async () => {
    const f = makeFakes({ appendError: new Error('TransactionInProgressException') });
    const err = await f.service(base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendAcceptedNotRecordedError);
    expect((err as SendAcceptedNotRecordedError).providerSid).toBe(<the SID the fake adapter returns>);
  });
  it('a failure after the row is written does NOT throw: ERROR logged, conversation.updated skipped', async () => {
    const f = makeFakes({ touchError: new Error('touch down') });
    const outcome = await f.service(base);
    expect(outcome.tsMsgId).toBeDefined();
    expect(f.emitted.map((e) => e.event)).toEqual(['message.persisted']);
    expect(f.capture.atLevel(ERROR).some((l) => String(l['msg']).includes('post-append step failed'))).toBe(true);
  });
  it('an audit failure after the row is written does NOT throw either', async () => {
    const f = makeFakes({ auditError: new Error('audit down') });
    await expect(f.service(base)).resolves.toMatchObject({ conversationId: 'conv-1' });
  });
});
```

The existing `rejects.toThrow('provider unavailable')` pin at `:461-470` stays green because the wrapper's message carries the cause's. Run: `cd app; npx vitest run test/sendMessage.test.ts -t "typed send errors"` -> FAIL.

- [ ] **Step 3: Add the error classes and the wrapping**

After the refusal classes (`:191`):

```ts
/**
 * Spec D3. The three NON-refusal failure classes of a send, typed so an
 * adopter can act on WHERE the send failed. None extends SendRefusedError.
 */
export class SendNotAttemptedError extends Error {
  constructor(message: string, readonly cause: unknown) { super(message); this.name = new.target.name; }
}
export class ProviderSendFailedError extends Error {
  readonly classification: SendFailureClassification;
  readonly cause: unknown;
  readonly facts: SendAttemptFacts;
  readonly attemptedAt: string;
  /** Mirrors of the cause's own `code` / `status`, so errorCodeOf(err) keeps reading a Twilio code off the wrapper. */
  readonly code?: string | number;
  readonly status?: number;
  constructor(args: { classification: SendFailureClassification; cause: unknown; facts: SendAttemptFacts; attemptedAt: string }) {
    const causeMessage = args.cause instanceof Error ? args.cause.message : String(args.cause);
    super(`provider send failed (${args.classification.kind}): ${causeMessage}`);
    this.name = new.target.name;
    this.classification = args.classification; this.cause = args.cause; this.facts = args.facts; this.attemptedAt = args.attemptedAt;
    const c = args.cause as { code?: unknown; status?: unknown } | null;
    if (c !== null && typeof c === 'object') {
      if (typeof c.code === 'string' || typeof c.code === 'number') this.code = c.code;
      if (typeof c.status === 'number') this.status = c.status;
    }
  }
}
export class SendAcceptedNotRecordedError extends Error {
  readonly providerSid: string; readonly providerTs: string; readonly status: DeliveryStatus; readonly cause: unknown; readonly facts: SendAttemptFacts;
  constructor(args: { providerSid: string; providerTs: string; status: DeliveryStatus; cause: unknown; facts: SendAttemptFacts }) {
    super(`send accepted by the provider but not recorded (${args.providerSid})`);
    this.name = new.target.name;
    this.providerSid = args.providerSid; this.providerTs = args.providerTs; this.status = args.status; this.cause = args.cause; this.facts = args.facts;
  }
}
```

Imports: `import { classifySendFailure, type SendFailureClassification } from '../lib/sendOutcome.js';`, `import { bodyFingerprint, recipientDigest } from '../lib/sendFingerprint.js';`, `import type { SendAttemptFacts } from '../repos/sendAttemptsRepo.js';`.

Wrap ONLY the non-refusal throw points (every refusal throw stays untouched) with this helper inside `createSendMessageService`:

```ts
async function notAttempted<T>(run: () => Promise<T> | T, step: string): Promise<T> {
  try { return await run(); }
  catch (err) {
    if (err instanceof SendRefusedError) throw err;   // never wrap a refusal (D3)
    throw new SendNotAttemptedError(`send not attempted: ${step} failed`, err);
  }
}
```

- `:332` `conversations.getById(conversationId)` -> `notAttempted(() => conversations.getById(conversationId), 'conversation read')`;
- `:361` `contacts.findByPhone(participantPhone)` -> wrapped, `'contact read'`;
- `:431` `incrementAutomatedSendCount(...)` -> wrapped; `:433-439` the trip branch's `setMode` and `audit.append` -> wrapped (the `CircuitBreakerOpenError` throw at `:446` stays);
- `:465-474` `classifyMessageTransport` / `prepareMessageSend` -> wrapped.

Right before the provider call (`:475`):

```ts
const fp = bodyFingerprint(body);
const facts: SendAttemptFacts = { recipientDigest: recipientDigest(sender, participantPhone), ...(sender !== undefined && { sender }), bodyHash: fp.hash, bodyShort: fp.short, mediaCount: mediaUrls?.length ?? attachments?.length ?? 0 };
const attemptedAt = new Date().toISOString();
let result: SendMessageResult;
try { result = await adapter.sendPreparedMessage(prepared); }
catch (err) {
  if (err instanceof SendRefusedError) throw err;
  throw new ProviderSendFailedError({ classification: classifySendFailure(err), cause: err, facts, attemptedAt });
}
```

(`sender` is whatever local the file already derives for the From number - read `:400-475`.) Wrap the append (`:479-519`):

```ts
let appended: AppendResult;
try { appended = await messages.append({ /* the object exactly as today */ }); }
catch (err) { throw new SendAcceptedNotRecordedError({ providerSid: result.providerSid, providerTs: result.providerTs, status: result.status, cause: err, facts }); }
```

The post-append steps (`:523-539`) become best-effort:

```ts
let touched: ConversationItem | undefined;
try { touched = await conversations.touchLastActivity(conversationId, body, result.providerTs); }
catch (err) { log.error({ err, conversationId, providerSid: result.providerSid, step: 'touchLastActivity' }, 'outbound message sent but a post-append step failed (best-effort)'); }
try { await audit.append(`conversations#${conversationId}`, 'message_sent', { providerSid: result.providerSid, automated, author }); }
catch (err) { log.error({ err, conversationId, providerSid: result.providerSid, step: 'audit' }, 'outbound message sent but a post-append step failed (best-effort)'); }
events.emit('message.persisted', { conversationId, tsMsgId: appended.tsMsgId, direction: 'outbound', deliveryStatus: result.status });
if (touched !== undefined) events.emit('conversation.updated', toConversationUpdatedEvent(touched));
```

Update the file's step (4)-(6) comments: the steps after the append are best-effort (D3); the staff send route answers 201 where it answered 500.

- [ ] **Step 4: Run, typecheck, commit**

Run: `cd app; npx vitest run test/sendMessage.test.ts` -> PASS (parity block `:936-970` green: no refusal is wrapped). `npm run typecheck` -> 0.

```bash
git status
git add app/src/services/sendMessage.ts app/test/sendMessage.test.ts
git commit -m "feat(send): typed non-refusal errors from sendMessage that keep the provider code readable; post-append failures no longer fail a sent text" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 7: The broadcast fan-out (D5-D9, D7a, D8, D8a, D13a, D16a)

**Files:**
- Modify: `app/src/jobs/broadcastFanOut.ts` (parser :124-143; handler :218-688; `closeBroadcast` :287-324; loop :373-622; continuation :642-683; `finalize` :723-771; the header comment :1-33 and the `TODO(throw-for-redelivery-defeated-by-job-marker)` block :609-620 are rewritten; the file's `enqueue` named import at `:88`)
- Create: `app/src/jobs/sendReconcile.ts` (STUB: `SEND_RECONCILE_JOB`, `SendReconcilePayload`, `SendAttemptOwnerRef`, `toOwnerRef`, `enqueueSendReconcile`, `reconcileCheckDelaysMs`, `reconcileDelayMs` - Task 10 adds the handler)
- Test: `app/test/broadcastFanOut.test.ts` (fixtures `seedTenant`, `seedBroadcast`, `wireHandler`, `outbound`, `capture` = `createLogCapture()` whose `.lines` / `.atLevel(50)` are parsed objects; the queue-refusal seam at `:735-740`; provider errors injected by REPLACING `world.adapter.sendPreparedMessage` - the override's own call count is the only honest send count (`:172-176`); enqueues read from `outbound.delayed`; the `outbound.delayed.shift()` idiom at `:660-665` drains ONE named envelope)

**Interfaces:**
- Consumes: Tasks 1-6; the stub.
- Produces: `BroadcastSendPayload.redrive?: true` (parsed, and carried by the parser); `BroadcastSendJobDeps.sendAttemptsRepo?` is read (lazy default `createSendAttemptsRepo({ logger })`); `export async function finalize(...)` (already a function; export it); `export async function adoptBroadcastRecipient(deps: AdoptDeps, args: { broadcastId: string; contactKey: string; providerSid: string; providerTs: string; providerStatus: string; errorCode?: string; body: string; mediaCount: number; sentAt?: string }): Promise<'adopted' | 'other_owner' | 'skipped'>` - the D15 write set, called by Task 10 INSIDE its candidate loop.

**The stub (`sendReconcile.ts`):**

```ts
import { enqueue } from './jobs.js';   // the named import broadcastFanOut.ts:88 uses; EnqueueOptions is { runAt?: Date } ONLY (jobs.ts:91-93)
export const SEND_RECONCILE_JOB = 'send.reconcile';
export type SendAttemptOwnerRef =
  | { kind: 'broadcast'; broadcastId: string; recipientKeyHash: string }
  | { kind: 'relay_leg'; relayConversationId: string; sourceTsMsgId: string; recipientKeyHash: string }
  | { kind: 'relay_rung'; relayConversationId: string; retryTsMsgId: string; recipientKeyHash: string };
export interface SendReconcilePayload { owner: SendAttemptOwnerRef; attemptedAt: string; checkNo: number; continuation?: { senderKey: string; senderNameOverride?: string }; }
export function toOwnerRef(owner: SendAttemptOwner): SendAttemptOwnerRef {
  switch (owner.kind) {
    case 'broadcast': return { kind: 'broadcast', broadcastId: owner.broadcastId, recipientKeyHash: hashRecipientKey(owner.contactKey) };
    case 'relay_leg': return { kind: 'relay_leg', relayConversationId: owner.relayConversationId, sourceTsMsgId: owner.sourceTsMsgId, recipientKeyHash: hashRecipientKey(owner.memberKey) };
    case 'relay_rung': return { kind: 'relay_rung', relayConversationId: owner.relayConversationId, retryTsMsgId: owner.retryTsMsgId, recipientKeyHash: hashRecipientKey(owner.memberKey) };
  }
}
/** Lane-overridable ONLY when no real queue is configured (the hermetic e2e lane). */
export function reconcileCheckDelaysMs(): readonly number[] {
  const raw = process.env['E2E_SEND_RECONCILE_DELAYS_MS'];
  if (raw === undefined || (process.env['JOBS_QUEUE_URL'] ?? '') !== '') return RECONCILE_CHECK_DELAYS_MS;
  const parsed = raw.split(',').map((s) => Number.parseInt(s.trim(), 10));
  return parsed.length === 3 && parsed.every((n) => Number.isFinite(n) && n >= 0) ? parsed : RECONCILE_CHECK_DELAYS_MS;
}
/** Check k runs at attemptedAt + delays[k]; never negative. Reads the LANE delays. */
export function reconcileDelayMs(attemptedAt: string, checkNo: number, nowMs: number): number {
  return Math.max(0, Date.parse(attemptedAt) + reconcileCheckDelaysMs()[checkNo]! - nowMs);
}
export async function enqueueSendReconcile(payload: SendReconcilePayload, delayMs: number): Promise<void> {
  await enqueue(SEND_RECONCILE_JOB, payload, { runAt: new Date(Date.now() + delayMs) });
}
```

**The D8 gate helper (module-local in `broadcastFanOut.ts`; Tasks 8 and 9 copy the SAME body into their files). It never enqueues; the caller hands off:**

```ts
type GateResult =
  | { kind: 'proceed'; record?: SendAttemptRecord }
  | { kind: 'skip' }
  | { kind: 'defer' }
  | { kind: 'taken_over'; record: SendAttemptRecord };
/** Spec D8 (revision 11): a pre-claim decline or a close by another writer touches the slot ONLY when the record cannot belong to a live attempt. */
async function gateFor(owner: SendAttemptOwner, nowMs: number): Promise<GateResult> {
  const rec = await sendAttempts.get(owner);
  if (rec === undefined) return { kind: 'proceed' };
  if (rec.state === 'done') return rec.outcome === 'retryable' ? { kind: 'proceed', record: rec } : { kind: 'skip' };   // terminal: never carried forward
  if (rec.state === 'redriven') return { kind: 'proceed', record: rec };                                                // any pass may close a redriven record (closeRedriven)
  if (rec.state === 'attempting' && nowMs - Date.parse(rec.attemptedAt) > SEND_CLAIM_TTL_MS) {
    return (await sendAttempts.takeOver(owner, rec)) ? { kind: 'taken_over', record: rec } : { kind: 'defer' };
  }
  return { kind: 'defer' };   // fresh attempting, reconciling
}
```

A gate read that THROWS is caught by the recipient unit's outer catch at phase `'prepare'` (deferred, no record). On `proceed` with `record?.state === 'redriven'` the caller ALSO runs `guardWrite(log, ctx, 'closeRedriven', () => sendAttempts.closeRedriven(owner, { outcome: 'refused', cause: <the decline's code> }))`.

**The recipient unit (ONE outer try/catch; the phase decides the catch; every failure-arm write through `guardWrite`; the brake is a FLAG read at the top of the loop, never a bare `break` from inside the switch):**

```
let braked = false;
for (const contactKey of keys) {
  if (braked) { transientRemaining.push(contactKey); continue; }            // BRAKE: every key not yet attempted is deferred
  const owner: SendAttemptOwner = { kind: 'broadcast', broadcastId, contactKey };
  const ctx = { broadcastId, recipientKey: safeRecipientKey(contactKey) };
  let phase: 'prepare' | 'sending' | 'record' = 'prepare';
  let ref: AttemptRef | undefined;
  let outcome: SendMessageOutcome | undefined;     // hoisted: the catch reads it
  let secondUnknownWouldClose = false;
  const deferSlot = () => recordRecipientOutcome(broadcastId, contactKey, { status: 'queued', errorCode: SEND_RETRYABLE_CODE }, {}, ['queued']);   // never a blind setRecipient
  const brakeIfDue = () => { streak += 1; if (streak >= OUTAGE_BRAKE_UNKNOWN_STREAK) braked = true; };
  try {
    slot terminal? -> continue
    PREPARE: resolveContact
    FENCES (each of the five, in today's order): before the fence's write, g = await gateFor(owner, now)
        skip       -> streak = 0; continue                                                                  (terminal record; no slot write, not carried)
        defer      -> if (payload.recipientKeys) transientRemaining.push(contactKey); streak = 0; continue   (no slot write)
        taken_over -> await handOff(owner, g.record.attemptedAt); streak = 0; continue                       (NOT toward the brake)
        proceed    -> the fence's write UNCHANGED (through guardWrite); if (g.record?.state === 'redriven') guardWrite(closeRedriven(owner, { outcome: 'refused', cause: <fence code> })); streak = 0; continue
    createOrGetByParticipantPhone; renderBody
    facts = { recipientDigest: recipientDigest(config.businessPhoneNumber, contact.phone), ...(config.businessPhoneNumber && { sender: config.businessPhoneNumber }), bodyHash, bodyShort (from bodyFingerprint(body)), mediaCount: 0 }
    CLAIM: c = await sendAttempts.claim(owner, facts, nowIso)
        refused & fresh  -> if (payload.recipientKeys) transientRemaining.push(contactKey); streak = 0; continue   (no slot write)
        refused & !fresh -> streak = 0; continue
        takeover         -> if (await sendAttempts.takeOver(owner, c.record)) await handOff(owner, c.record.attemptedAt); else INFO 'takeover lost'; streak = 0; continue
        claimed          -> ref = { attemptNo: c.record.attemptNo, attemptedAt: c.record.attemptedAt }; secondUnknownWouldClose = c.record.redriveCount >= 1
    phase = 'sending'
    outcome = await sendMessage({ ...unchanged args... })
    phase = 'record'
    RECORD: r = await recordRecipientOutcome(broadcastId, contactKey, { conversationId, tsMsgId, status: 'sent' }, { sent: 1, queued: -1 }, ['queued'])
            if (r.moved) emitBroadcastProgress(r.item)
            if (!(await sendAttempts.finishAttempt(owner, ref, { outcome: 'sent', sid: outcome.providerSid }))) log.warn({ ...ctx }, 'attempt fence lost after the slot write; the takeover reconcile repairs')   (deviation 3)
            best-effort, each in its own try/catch (WARN): tokenBucket.acquire(1); milestone; listing-send
            sentCount += 1; streak = 0
  } catch (err) {
    if (phase === 'prepare' && ref === undefined) {                                   // nothing sent, no record
      await guardWrite(log, ctx, 'deferSlot', deferSlot); transientRemaining.push(contactKey); log.warn({ err, ...ctx }, 'prepare failed - deferred'); streak = 0; continue
    }
    if (phase === 'prepare') {                                                        // claimed, threw before the send (defensive: the claim is the last prepare step)
      await guardWrite(log, ctx, 'finishAttempt', () => sendAttempts.finishAttempt(owner, ref!, { outcome: 'retryable', cause: SEND_RETRYABLE_CODE }));
      await guardWrite(log, ctx, 'deferSlot', deferSlot); transientRemaining.push(contactKey); streak = 0; continue
    }
    if (phase === 'record') {                                                         // the send HAPPENED; a record write threw
      log.error({ err, ...ctx, providerSid: outcome!.providerSid }, 'sent_unrecorded: recipient sent but not recorded');
      if (await guardWrite(log, ctx, 'handToReconcile', () => sendAttempts.handToReconcile(owner, ref!, outcome!.providerSid))) await handOff(owner, ref!.attemptedAt);
      else transientRemaining.push(contactKey);                                       // stranded after a KNOWN send: deferred, record attempting
      streak = 0; continue                                                            // the provider answered: resets the streak
    }
    // phase === 'sending': the provider call threw (sendMessage throws only typed errors and refusals)
    if (err instanceof SendRefusedError) { slot skipped + bump UNCHANGED (through guardWrite); await guardWrite(..., 'finishAttempt', () => finishAttempt(owner, ref!, { outcome: 'refused', cause: err.code })); streak = 0; continue }
    if (err instanceof SendNotAttemptedError) { guardWrite(deferSlot); transientRemaining.push; guardWrite(finishAttempt(retryable, SEND_RETRYABLE_CODE)); streak = 0; continue }
    if (err instanceof SendAcceptedNotRecordedError) { ERROR 'sent_unrecorded'; if (await guardWrite(..., () => handToReconcile(owner, ref!, err.providerSid))) await handOff(owner, ref!.attemptedAt); else transientRemaining.push(contactKey); streak = 0; continue }
    const classification = err instanceof ProviderSendFailedError ? err.classification : { kind: 'unknown' as const };   // anything else at 'sending' is unknown (D2); the reconcile decides
    switch (classification.kind) {
      case 'rejected': {
        const code = classification.code;
        const slotCode = isProviderCode(code) || code === SMS_SENDING_DISABLED_CODE ? code : undefined;   // an HTTP status NEVER reaches a slot (D10/D23)
        '30007' / '30005' / '30006' take today's arms (writes unchanged, through guardWrite)
        else guardWrite(recordRecipientOutcome(broadcastId, contactKey, { status: 'failed', ...(slotCode && { errorCode: slotCode }) }, { failed: 1, queued: -1 }, ['queued']));
        guardWrite(finishAttempt(owner, ref!, { outcome: 'rejected', cause: code ?? String(classification.status) })); streak = 0; continue
      }
      case 'retryable': {
        const slotCode = isProviderCode(classification.code) ? classification.code! : SEND_RETRYABLE_CODE;   // a network string NEVER reaches a slot (D6)
        guardWrite(recordRecipientOutcome(... { status: 'queued', errorCode: slotCode }, {}, ['queued'])); transientRemaining.push(contactKey); guardWrite(finishAttempt(retryable, slotCode)); streak = 0; continue
      }
      case 'unknown': {
        if (secondUnknownWouldClose) { guardWrite(closeRecipientIfQueued(broadcastId, contactKey, SEND_UNCONFIRMED_CODE, 'unconfirmed')); guardWrite(finishAttempt(owner, ref!, { outcome: 'unresolved', cause: 'second_unknown' })); log.error(...); continue }   // D13a
        if (await guardWrite(log, ctx, 'handToReconcile', () => sendAttempts.handToReconcile(owner, ref!))) await handOff(owner, ref!.attemptedAt);
        else transientRemaining.push(contactKey);                                     // stranded: deferred, record attempting
        brakeIfDue(); continue                                                         // handed AND stranded both count (an unknown provider outcome either way)
      }
    }
  }
}
if (braked) log.warn({ event: 'outage_brake', deferred: transientRemaining.length, broadcastId }, 'outage brake: consecutive unknown send outcomes; the remainder is deferred');
```

`handOff(owner, attemptedAt)`: `try { await enqueueSendReconcile({ owner: toOwnerRef(owner), attemptedAt, checkNo: 0 }, reconcileDelayMs(attemptedAt, 0, Date.now())) } catch (err) { await guardWrite(log, ctx, 'closeUnconfirmed', () => closeRecipientIfQueued(broadcastId, contactKey, SEND_UNCONFIRMED_CODE, 'unconfirmed')); await guardWrite(log, ctx, 'closeFromReconcile', () => sendAttempts.closeFromReconcile(owner, attemptedAt, { outcome: 'unresolved', cause: ENQUEUE_FAILED_CODE })); log.error({ err, ...ctx }, 'reconcile enqueue failed - recipient closed unresolved') }`. `handOff` never throws.

Nothing in the catch can throw: every write is guarded and `handOff` is total. A stranded recipient is DEFERRED with no slot write; on broadcast the continuation's claim finds the record `attempting` (fresh -> deferred again; stale after 30 s -> takeover -> reconcile - the 10 s + 20 s ladder clears the TTL); at the cap the cap-close gate takes a stale one over and defers a fresh one (the Sec 1 sweeper residue).

**Pass-level changes:**
- Snapshot read `:259` -> `getByIdConsistent` when `payload.recipientKeys !== undefined` (a continuation or a re-drive); the first pass keeps `getById`.
- Up-front claim `:349-364`: skipped when `payload.redrive === true`; after the loop, a re-drive pass with a non-empty `transientRemaining` claims then (`claimFanoutPass`) and takes the existing cap/enqueue branches; with an empty remainder it goes straight to `finalize`.
- The "unreachable by construction" guard `:643-651` becomes reachable only on a re-drive pass and must NOT close: `if (claim === undefined) { claim = await repo.claimFanoutPass(...); handle missing/capped as the up-front branch does }`.
- `closeBroadcast` (D8, the cap-close): for each key, `g = await gateFor(owner, now)`: `proceed` -> `closeRecipientIfQueued(broadcastId, key, TRANSIENT_CAP_CODE, 'failed')`, emit progress if moved, and if `g.record?.state === 'redriven'` `guardWrite(closeRedriven(owner, { outcome: 'refused', cause: TRANSIENT_CAP_CODE }))` (a redriven record is closed by whichever pass reaches the cap - R2 #11, R3 #17); `taken_over` -> `await handOff(owner, g.record.attemptedAt)`; `skip` / `defer` -> skip with INFO. Then the existing ERROR line and `finalize`.
- `finalize` (D16a): `fresh = await getByIdConsistent(broadcastId)`; if any slot status is `queued` -> INFO `finalize deferred - recipients still open`, return; `s = deriveBroadcastStats(fresh)`; `reachedAny = s.sent + s.sending + s.delivered > 0`; `failedAny = s.failed + (s.unconfirmed ?? 0) > 0`; `status = !reachedAny && failedAny ? 'failed' : 'sent'`; `lastError = status === 'failed' ? (s.failed === 0 ? "Couldn't confirm any text went out" : 'all recipients failed') : undefined`; `{ won, item } = await finalizeStatus(broadcastId, status, lastError)`; only when `won`: the `broadcast_sent` unit audit row, the terminal emit, the INFO line (gains `unconfirmed`).
- The continuation payload (`:661-673`) is unchanged in shape (it carries raw `recipientKeys` today - deviation 4); a transient continuation never carries `redrive` (the gate and the claim do not need it: a `redriven` record is closable/claimable by any pass).
- `adoptBroadcastRecipient` (D15, exported): resolves the contact and the conversation (the reads the pass makes); appends the row (`automated: broadcast.created_via !== 'dashboard'`; `recipientContactId` only when `contactHoldsPhone`); on `deduped`, read the row (`getByProviderSidConsistent`): `row.broadcast_id !== broadcastId` -> `'other_owner'`; `row.broadcast_id === broadcastId` AND `row.recipient_contact_id !== undefined` AND `row.recipient_contact_id !== <this contact>` AND the owner's slot does not already carry that `tsMsgId` -> `'other_owner'` (two contacts on one phone in one share); otherwise mine. Then the slot via `recordRecipientOutcome` (status per D15's table; `carrierSentAt = sentAt` when present; `conversationId` + `tsMsgId`; `['queued']` prior) -> `moved: false` -> `'skipped'`; when moved: the stats bump (same write), the audit row (its `automated` from the same rule), the preserving inbox touch (`touchLastActivityPreservingStatus(conversationId, undefined, providerTs)` only when the conversation's `last_activity_at < providerTs`), the emits, and - only for an adopted `sent`/`delivered` - the milestone and the listing-send row; the 30005/30006 unreachable flag on an adopted failure with those codes.
- Lazy deps: `sendAttempts ??= deps.sendAttemptsRepo ?? createSendAttemptsRepo({ logger: deps.logger })`. Header comment rewritten (three phases, the claim, the hand-off, the brake); the TODO block deleted; every touched log line ASCII.

- [ ] **Step 1: Failing tests** (`wireHandler` passes `sendAttemptsRepo: world.sendAttemptsRepo`; reconcile-related cases build their config with `BUSINESS_PHONE_NUMBER: '+15550009999'` so the record has a sender - read how the file builds `config`). At Task 7 NO `send.reconcile` handler exists, so a test that lets `outbound` deliver such an envelope gets `MalformedJobEnvelopeError` (`jobs.ts:257-261`): every test that produces one drains ONLY the `broadcast.send` envelopes it needs (the `:660-665` shift idiom) and asserts the reconcile envelope by inspection. The enqueue delay is asserted the way the harness exposes `runAt` (read `outbound.delayed`'s entry shape - the broadcast continuation tests already assert a delay).

```ts
describe('unknown send errors (spec D7, D7a, D8a, D9, D13a) - the first test must fail on main', () => {
  // The override REPLACES the adapter and records nothing: its own call count is the only honest send count.
  const sends: string[] = [];
  function unknownOn(phones: Set<string>) {
    world.adapter.sendPreparedMessage = async (prepared) => {
      sends.push(prepared.params.to);
      if (phones.has(prepared.params.to)) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return { providerSid: `SM-${prepared.params.to}`, status: 'sent', providerTs: new Date().toISOString() };
    };
  }
  const ownerOf = (k: string) => ({ kind: 'broadcast' as const, broadcastId: 'bcast-1', contactKey: k });
  it('1 an unknown error on recipient 3 of 5 leaves 4 and 5 attempted, 3 handed to reconcile, no throw', async () => {
    const tenants = [1, 2, 3, 4, 5].map((i) => seedTenant(world, { contactId: `t-${i}`, phone: `+1555010000${i}` }));
    seedBroadcast(world, tenants);
    unknownOn(new Set(['+15550100003']));
    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' }); await outbound.settle();
    const b = world.broadcasts.get('bcast-1')!;
    expect([b.recipients['t-4']!.status, b.recipients['t-5']!.status]).toEqual(['sent', 'sent']);
    expect(b.recipients['t-3']).toEqual({ status: 'queued' });
    expect(await world.sendAttemptsRepo.get(ownerOf('t-3'))).toMatchObject({ state: 'reconciling', attemptNo: 1, checkNo: 0 });
    const reconcile = outbound.delayed.find((d) => d.envelope.jobName === SEND_RECONCILE_JOB);
    expect(reconcile?.envelope.payload).toMatchObject({ owner: { kind: 'broadcast', broadcastId: 'bcast-1', recipientKeyHash: hashRecipientKey('t-3') }, checkNo: 0 });
    <assert the envelope runs about 5 s after the attempt, in the harness's own delay field>;
    expect(b.status).toBe('sending');
  });
  it('2 a claimed recipient whose sendMessage refuses closes done/refused, slot skipped, no reconcile - Review Focus 3', async () => {
    const t = seedTenant(world, { contactId: 't-1', phone: '+15550100001' }); seedBroadcast(world, [t]);
    <flip t-1's conversation to manual mode so the automated share refuses>;
    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' }); await outbound.settle();
    expect(world.broadcasts.get('bcast-1')!.recipients['t-1']).toMatchObject({ status: 'skipped', errorCode: 'manual_mode' });
    expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'done', outcome: 'refused', cause: 'manual_mode' });
    expect(outbound.delayed.some((d) => d.envelope.jobName === SEND_RECONCILE_JOB)).toBe(false);
  });
  it('3 a prepare-phase throw defers the recipient as send_retryable with no record', /* createOrGetByParticipantPhone throws once for t-1: slot { status: 'queued', errorCode: 'send_retryable' }, the continuation lists t-1, no record, no throw, t-2 still attempted */);
  it('3b a deferral write that itself throws is logged and the next recipient is still attempted (D7a)', /* createOrGetByParticipantPhone throws once for t-1 AND world.broadcastsRepo.recordRecipientOutcome throws once (the deferral): one ERROR with label 'deferSlot', t-2 sent, no throw out of the job */);
  it('3c the deferral never reverts a skipped slot', /* t-1 opted out: its fence wrote `skipped`; make the fence's stats bump throw so the unit falls into the prepare catch; the slot stays `skipped` (the ['queued'] prior refuses) */);
  it('4a three consecutive unknowns brake the pass; the untried remainder is deferred, not attempted (D9)', async () => {
    const tenants = [1, 2, 3, 4, 5, 6].map((i) => seedTenant(world, { contactId: `t-${i}`, phone: `+1555010000${i}` })); seedBroadcast(world, tenants);
    unknownOn(new Set(['+15550100001', '+15550100002', '+15550100003']));
    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' }); await outbound.settle();
    const b = world.broadcasts.get('bcast-1')!;
    expect(['t-4', 't-5', 't-6'].map((k) => b.recipients[k]!.status)).toEqual(['queued', 'queued', 'queued']);
    expect(sends).toHaveLength(3);
    expect(outbound.delayed.find((d) => d.envelope.jobName === BROADCAST_SEND_JOB)?.envelope.payload).toMatchObject({ recipientKeys: ['t-4', 't-5', 't-6'], attempt: 2 });
    expect(capture.atLevel(40).some((l) => l['event'] === 'outage_brake')).toBe(true);
  });
  it('4b a sent between two unknowns resets the streak', /* unknown, sent, unknown, sent, unknown -> no brake, sends.length 5 */);
  it('4c a fence skip between two unknowns resets the streak (D9: a skip resets)', /* unknown, opted-out, unknown, opted-out, unknown -> no brake */);
  it('4d three rejected do not brake; three retryable do not brake', /* 30007 x3 then sent x2; ECONNREFUSED x3 then sent x2 */);
  it('4e a stranded unknown counts toward the brake', /* unknownOn(t-1..t-3) AND handToReconcile throws every time: braked after t-3, t-4.. deferred */);
  it('5a a record-phase failure after a successful send hands the SID to reconcile and never re-sends (D7a)', async () => {
    const t = seedTenant(world, { contactId: 't-1', phone: '+15550100001' }); seedBroadcast(world, [t]);
    const real = world.broadcastsRepo.recordRecipientOutcome.bind(world.broadcastsRepo);
    world.broadcastsRepo.recordRecipientOutcome = async () => { throw new Error('dynamo hiccup'); };
    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' }); await outbound.settle();
    world.broadcastsRepo.recordRecipientOutcome = real;
    expect(world.sent).toHaveLength(1);
    expect(await world.sendAttemptsRepo.get(ownerOf('t-1'))).toMatchObject({ state: 'reconciling', sid: world.sentDetails[0]!.sid });
    expect(capture.atLevel(50).some((l) => String(l['msg']).includes('sent_unrecorded'))).toBe(true);
  });
  it('5b a SendAcceptedNotRecordedError from sendMessage does the same', /* world.messagesRepo.append throws once; expect reconciling + sid, one provider call */);
  it('5c an unknown whose handToReconcile write throws strands the recipient: NO second provider call, record still attempting, deferred (R2 #1)', async () => {
    <unknownOn(t-1); world.sendAttemptsRepo.handToReconcile throws once>;
    /* run the first pass; drain ONLY the broadcast.send continuation (the shift idiom) after advancing the fake clock past SEND_CLAIM_TTL_MS; expect sends.filter(to t-1).length === 1 across both passes, an ERROR with label 'handToReconcile', and after the continuation the record is 'reconciling' via takeover with the ORIGINAL attemptedAt and ONE send.reconcile envelope */
  });
  it('6 a reconcile enqueue that throws closes the recipient unresolved on the spot', /* the queue-refusal seam; expect slot failed/send_unconfirmed, stats.unconfirmed 1, record done/unresolved cause enqueue_failed, broadcast finalized 'failed' with last_error "Couldn't confirm any text went out" */);
  it('7a two passes for the same recipient produce ONE provider call (D8a)', /* claim once via world.sendAttemptsRepo.claim(owner, facts, now) then run the pass: deferred, sends has no t-1 */);
  it('7b a stale attempting record is taken over into reconcile by the next pass', /* claim with attemptedAt 31 s ago; run a continuation for that key (drain only broadcast.send); expect reconciling with the OLD attemptedAt, one reconcile envelope, NOT toward the brake */);
  it('8 a cap-close closes only records that are absent or done/retryable, skips a terminal one, and takes over a stale attempting one (D8)', /* fanout_attempt at the cap; keys: none / fresh attempting / stale attempting / reconciling / done-sent -> closed transient_cap / skipped / reconciling + envelope / skipped / skipped */);
  it('9a a re-drive pass claims no ladder rung up front and its fence closes the redriven record done/refused', /* record redriven for t-1, fanout_attempt at cap, contact opted out; run { broadcastId, recipientKeys: ['t-1'], attempt: 4, redrive: true }; expect slot skipped opted_out, record done/refused cause opted_out, claimFanoutPass NOT called */);
  it('9b a re-drive attempt that comes back unknown closes unresolved with no second reconcile (D13a)', /* record redriveCount 1 + redriven; unknown; expect slot failed/send_unconfirmed, stats.unconfirmed 1, record done/unresolved cause second_unknown, no send.reconcile envelope */);
  it('9c a re-drive pass that defers before its claim and hits the cap closes its OWN redriven record (R2 #11)', /* record redriven; createOrGetByParticipantPhone throws once; fanout_attempt at the cap -> the cap-close writes transient_cap AND the record closes done/refused cause transient_cap */);
  it('9d a redriven record reached by an ORDINARY continuation (no marker) whose fence trips closes done/refused (R3 #17)', /* record redriven for t-1, contact opted out; run { broadcastId, recipientKeys: ['t-1'], attempt: 2 } WITHOUT redrive; expect slot skipped, record done/refused cause opted_out */);
  it('10 a retryable with a network code writes send_retryable, never the network string', /* ECONNREFUSED -> slot { status: 'queued', errorCode: 'send_retryable' } */);
  it('11 a foreign fresh attempt on a fenced recipient defers the fence instead of writing skipped (D8, R2 #12)', /* claim t-1 with another attempt now; opt t-1 out; run a continuation for t-1: slot untouched (queued), key carried forward */);
  it('12 every log line for a phone-keyed recipient names it redacted', /* a phone#-keyed recipient through the unknown arm; assert no capture line's JSON contains 'phone#+' */);
  it('13 a 4xx with no code writes failed with NO errorCode; the record cause keeps the status (R3 #13)', /* Object.assign(new Error('bad'), { status: 400 }) -> slot { status: 'failed' } with no errorCode key, record done/rejected cause '400' */);
});
describe('finalize (spec D16a)', () => {
  it('N callers produce one flip, one audit row, one terminal emit', ...);
  it('all skipped plus one unconfirmed finalizes failed with the prose - Review Focus 5', /* three skipped opted_out + one failed/send_unconfirmed -> status 'failed', last_error "Couldn't confirm any text went out" */);
  it('decides from the recipients map when the persisted failed counter is stale', /* stats.failed = 99, all slots delivered -> 'sent' */);
  it.skip('pass-then-verdict and verdict-then-pass both finalize exactly once', /* drives Task 10's handler; un-skipped in Task 10 */);
});
```

Also update the RED pins: the `finalize log` `toMatchObject` (`:368-379`) gains `unconfirmed: 0`; the `setRecipient` spy at `:1075-1109` ("records the sent recipient slot BEFORE acquiring") now spies `recordRecipientOutcome`.

Run: `cd app; npx vitest run test/broadcastFanOut.test.ts` -> the new describes FAIL (test 1 fails on `main` by construction: recipients 4 and 5 stay `queued`).

- [ ] **Step 2: Implement** per the unit block and the pass-level list.
- [ ] **Step 3: Run the file, typecheck** -> PASS (the five `toEqual` slot pins at `:324, :359, :432-437, :495, :513` untouched). `npm run typecheck` -> 0.
- [ ] **Step 4: Commit**

```bash
git status
git add app/src/jobs/broadcastFanOut.ts app/src/jobs/sendReconcile.ts app/test/broadcastFanOut.test.ts
git commit -m "feat(broadcast): classified send outcomes, a claim before every send, phase-tracked recipient units, reconcile hand-off, the outage brake and an idempotent finalize" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 8: The relay leg and the fan-out loop (D5-D9, D7a, D8, D8a, D13a)

**Files:**
- Modify: `app/src/jobs/relayFanOut.ts` (parser :152-186; `RelayLegSendOutcome` :1234-1245; `sendOneRelayLeg` :1270-1514; `runRelayFanOutExecution` :1002-1203 incl. `closeRelay` :1081-1110; `RelayFanOutExecutionDeps` :960-970; header)
- Test: `app/test/relayFanOut.test.ts` (fixtures `seedRelay`, `seedSource` legacy, `seedTeamSource` versioned; error injection via `world.adapter.sendMessage` for a legacy source and `sendPreparedMessage` for a versioned one - `.superpowers/sdd/plan-send-sites-reference.md` Sec 8.2; the token-bucket describe at `:2325-2370`; the close-B pin at `:999-1037`; count provider calls through the override, as Task 7 does; drain only the envelopes a test needs - no `send.reconcile` handler exists until Task 10)

**Interfaces:**
- Consumes: Tasks 1, 2, 5, 6; the Task 7 stub.
- Produces: the shared block's `RelayLegSendOutcome` (new kinds `rejected`, `sent_unrecorded`, `handed_to_reconcile`, `stranded`; `attemptRef`, `reason`, `deferredByClaim`) and the OPTIONAL unit args `sendAttempts?`, `owner?` - "absent = the pre-claim legacy path: no claim, no record; an unknown error returns `handed_to_reconcile` with NO attemptRef" (the rung passes none until Task 9, which makes them required); `RelayFanOutPayload.redrive?: true`; `RelayFanOutExecutionDeps.sendAttempts` and `consistent: boolean`; the module-local `gateFor` (Task 7's body, over the relay owner) and `handOff` (loop scope - it holds `payload.senderKey`).

**The unit (ONE outer try/catch around EVERYTHING after the terminal skip - the suppression read, the gate, the token acquire and the claim are prepare steps (spec D7a table) and a throw in any of them DEFERS the member; the claim sits AFTER the bounded acquire and BEFORE the presign; the phase decides the catch; every failure-arm write through `guardWrite`; the unit never enqueues - it returns kinds and the loop hands off):**

```
terminal skip (unchanged)
let phase: 'prepare' | 'sending' | 'record' = 'prepare'; let ref: AttemptRef | undefined; let result: SendMessageResult | undefined; let secondUnknownWouldClose = false
try {
  suppression arm (when sendAttempts && owner): g = await gateFor(owner, now)
      skip       -> return { kind: 'skipped_terminal' }                                                  (terminal record; not carried)
      defer      -> return { kind: 'transient', errorCode: SEND_RETRYABLE_CODE, deferredByClaim: true }   (no slot write)
      taken_over -> return { kind: 'handed_to_reconcile', reason: 'takeover', attemptRef: { attemptNo: g.record.attemptNo, attemptedAt: g.record.attemptedAt } }
      proceed    -> the arm's writes UNCHANGED; if (g.record?.state === 'redriven') guardWrite(closeRedriven(owner, { outcome: 'refused', cause: 'contact_opted_out' })); return suppressed
  acquire (unchanged; deadline_exceeded RETURNS before any claim - RSW #5)
  facts = { recipientDigest: recipientDigest(poolNumber, member.phone), sender: poolNumber, bodyHash, bodyShort (bodyFingerprint(legBody)), mediaCount: hasMedia && mediaStore ? sourceMedia.length : 0 }
  CLAIM (when sendAttempts && owner): c = await sendAttempts.claim(owner, facts, nowIso)
      refused fresh  -> return { kind: 'transient', errorCode: SEND_RETRYABLE_CODE, deferredByClaim: true }
      refused !fresh -> return { kind: 'skipped_terminal' }
      takeover       -> if (!(await sendAttempts.takeOver(owner, c.record))) return { kind: 'skipped_terminal' }; return { kind: 'handed_to_reconcile', reason: 'takeover', attemptRef: { attemptNo: c.record.attemptNo, attemptedAt: c.record.attemptedAt } }
      claimed        -> ref = {...}; secondUnknownWouldClose = c.record.redriveCount >= 1
  best-effort: try { await setRelayRecipientAttemptedAt(conversationId, tsMsgId, memberKey, ref.attemptedAt) } catch (err) { WARN }
  presign; params; prepare; aggregation 'attempted'
  phase = 'sending'
  result = await <the provider call as today>
  phase = 'record'
  persistRelayRecipientResult (unchanged, FIRST); claimRelaySidPointer (SECOND: 'other' -> ERROR, then continue as recorded - the reconcile's known-SID path rules sid_held_elsewhere if it ever matters)
  if (!(await finishAttempt(owner, ref, { outcome: 'sent', sid }))) WARN 'attempt fence lost after the slot write; the takeover reconcile repairs'   (deviation 3)
  return sent
} catch (err) {
  if (phase === 'prepare' && ref === undefined) {   // a pre-claim throw: suppression read, gate, acquire, claim - nothing sent, no record
    guardWrite(persist queued + SEND_RETRYABLE_CODE); return { kind: 'transient', errorCode: SEND_RETRYABLE_CODE }
  }
  if (phase === 'prepare') {                        // a pre-send throw after the claim (presign, prepare)
    guardWrite(finishAttempt(owner, ref, { outcome: 'retryable', cause: SEND_RETRYABLE_CODE })); guardWrite(persist queued + SEND_RETRYABLE_CODE); return { kind: 'transient', errorCode: SEND_RETRYABLE_CODE }
  }
  if (phase === 'record') {                         // the send HAPPENED; a record write threw
    ERROR 'sent_unrecorded' { providerSid }
    return (await guardWrite(handToReconcile(owner, ref, result!.providerSid))) ? { kind: 'sent_unrecorded', providerSid: result!.providerSid, attemptRef: ref } : { kind: 'stranded', afterSend: true }
  }
  // phase === 'sending'
  if (err instanceof SendRefusedError) { guardWrite(the unchanged slot write); guardWrite(finishAttempt(refused, err.code)); return refused }
  const classification = classifySendFailure(err)
  switch (classification.kind) {
    rejected:  '30007' -> the unchanged filtered arm; guardWrite(finishAttempt(rejected, '30007')); return filtered
               else code = classification.code; slotCode = isProviderCode(code) || code === SMS_SENDING_DISABLED_CODE ? code : undefined   (an HTTP status NEVER reaches a slot)
               guardWrite(persist failed + slotCode (no errorCode when undefined)); guardWrite(finishAttempt(rejected, code ?? String(classification.status))); return { kind: 'rejected', errorCode: slotCode }
    retryable: code = isProviderCode(classification.code) ? classification.code : SEND_RETRYABLE_CODE; guardWrite(persist queued + code); guardWrite(finishAttempt(retryable, code)); return { kind: 'transient', errorCode: code }
    unknown:   if (secondUnknownWouldClose) { guardWrite(closeRelayRecipientIfUnsent(..., { status: 'failed', errorCode: SEND_UNCONFIRMED_CODE })); guardWrite(finishAttempt(unresolved, 'second_unknown')); ERROR; return { kind: 'rejected', errorCode: SEND_UNCONFIRMED_CODE } }   // D13a: terminal, the caller counts it closed
               return (await guardWrite(handToReconcile(owner, ref))) ? { kind: 'handed_to_reconcile', reason: 'unknown', attemptRef: ref } : { kind: 'stranded' }
  }
}
```

`RelayLegSendOutcome` gains `afterSend?: true` on `stranded` (a lost hand-off after a KNOWN send; the loop resets the streak for it). A throw at phase `'sending'` or later is NEVER released as retryable (R2 #1): a lost hand-off returns `stranded` with the record left `attempting`. Without `sendAttempts`/`owner` (the legacy path until Task 9) the unit skips the gate, the claim, the `attemptedAt` write and every record write, and an unknown returns `{ kind: 'handed_to_reconcile', reason: 'unknown' }` with no `attemptRef`.

**The fan-out loop:**
- `handed_to_reconcile` / `sent_unrecorded` -> `handOff(owner, attemptRef.attemptedAt)` ONCE, here in the loop (the unit never enqueues): enqueue `{ owner: toOwnerRef(owner), attemptedAt, checkNo: 0, continuation: { senderKey: payload.senderKey, senderNameOverride? } }` at `reconcileDelayMs(attemptedAt, 0, now)`; on throw `guardWrite(closeRelayRecipientIfUnsent(... SEND_UNCONFIRMED_CODE))` + `guardWrite(closeFromReconcile(owner, attemptedAt, { outcome: 'unresolved', cause: ENQUEUE_FAILED_CODE }))` + ERROR. Counts as closed for the pass. A `handed_to_reconcile` with NO `attemptRef` (the legacy path) is logged at ERROR and counted closed (Task 9 removes the path).
- The D9 streak: `handed_to_reconcile` with `reason: 'unknown'` and `stranded` WITHOUT `afterSend` INCREMENT it (an unknown provider outcome either way); EVERY other kind resets it to zero. Braking is a flag read at the top of the loop: the remaining members are deferred with no slot write, then WARN `{ event: 'outage_brake' }`.
- `transient` with `deferredByClaim` and `stranded` both join `transientRemaining` with NO slot write; the transient continuation carries them. On relay the 5 s + 10 s ladder does NOT clear the 30 s TTL, so a stranded member is deferred again at the cap and left for the sweeper (spec D8a revision 11).
- A `rejected` with `SEND_UNCONFIRMED_CODE` counts as closed.
- The loop's own outer try/catch per member turns any other throw into ERROR + `transientRemaining.push(memberKey)` (deferred, never dropped, never out of the job).
- `closeRelay` (D8, the cap-close): per member `g = await gateFor(owner, now)`: `proceed` -> `closeRelayRecipientIfUnsent(conversationId, tsMsgId, memberKey, { status: 'failed', errorCode: TRANSIENT_CAP_CODE })` and if `g.record?.state === 'redriven'` `guardWrite(closeRedriven(owner, { outcome: 'refused', cause: TRANSIENT_CAP_CODE }))`; `taken_over` -> `await handOff(owner, g.record.attemptedAt)` (with the continuation); `skip` / `defer` -> skip with INFO.
- The up-front pass claim is skipped on `redrive`; the post-loop claim runs only with a remainder; the `claim?.outcome !== 'claimed'` guard claims instead of closing; consistent snapshot reads when `payload.recipientKeys !== undefined`; a re-drive pass's early returns close each carried member's record `redrive_refused` (`closeRedriven`) and its slot `REDRIVE_REFUSED_CODE` (`closeRelayRecipientIfUnsent`); the transient continuation payload never carries `redrive`.
- Every log line names the member through the file's `logSafeMemberKey`.

- [ ] **Step 1: Failing tests (extend `app/test/relayFanOut.test.ts`)** - mirror Task 7's describe for relay (`ownerOf(memberKey)` = `{ kind: 'relay_leg', relayConversationId, sourceTsMsgId, memberKey }`):
  1. `an unknown on member 2 of 4 leaves 3 and 4 sent, 2 handed to reconcile, no throw` on a LEGACY and on a VERSIONED source (two `it`s) - member 2's slot untouched except `attemptedAt` (absent on a legacy row -> `{ status: 'queued', attemptedAt }` from the seed); record `reconciling`; a `send.reconcile` envelope with `owner.kind 'relay_leg'`, `owner.recipientKeyHash === hashRecipientKey(memberKey)`, `continuation.senderKey` the sender's key; **must fail on main**.
  2. `a queued+sid success refuses a second claim: the same payload dispatched twice makes one provider call`.
  3. the token-bucket describe (`:2325-2370`) still asserts `[[1],[1]]` (the claim sits AFTER the acquire).
  4. `closeRelay on a legacy row with an empty map still creates failed slots for absent records` (close-B pin `:999-1037` green) `and skips a member whose record is reconciling, skips a done/sent one, and takes over a stale attempting one (ONE reconcile envelope, carrying the continuation)`.
  5. `the adapter kill switch writes sms_sending_disabled and the record done/rejected`.
  6. `a record-phase failure (claimRelaySidPointer throws once) returns sent_unrecorded: record reconciling with the sid, one reconcile envelope, one provider call`.
  7. `an unknown whose handToReconcile throws returns stranded: NO second provider call, record still attempting, member carried in the transient continuation, ERROR logged, counted toward the brake` (R2 #1, R3 #16).
  8. `brake after three unknowns; a sent resets; a suppressed (opted-out) member resets; three retryable do not brake`.
  9. `a re-drive pass (redrive: true, one member, record redriven, fanout_attempt at cap) sends without claiming a rung; with the member opted out it closes the record done/refused`.
  10. `a re-drive attempt that comes back unknown closes unresolved` (D13a).
  11. `a foreign open attempt on the suppression arm defers the member instead of writing a terminal slot; a done/sent record (queued+sid slot) makes the arm return skipped_terminal and is NOT carried forward` (D8 allow-list, R2 #8, R3 #10).
  12. `mediaCount on the record equals the source media count when a store exists and 0 without one`.
  13. `a pre-send throw after the claim (presign fails) releases the record done/retryable and defers`.
  14. `a re-drive pass that defers before its claim and hits the cap closes its own redriven record transient_cap` (R2 #11).
  15. `a pre-claim throw (isMemberSuppressed throws once) defers the member: carried on the continuation and SENT there` (R3 #4).
  16. `a redriven record reached by an ordinary continuation (no marker) whose member is opted out closes done/refused` (R3 #17).
  17. `a 4xx with no code writes failed with no errorCode` (R3 #13).

- [ ] **Step 2: Implement**; rewrite the unit docblock (`:1234-1268`) and the module header to the three-phase model; delete `throw err` at `:1492`; every touched log line ASCII.
- [ ] **Step 3: Run, typecheck, commit**

Run: `cd app; npx vitest run test/relayFanOut.test.ts` -> PASS. `npm run typecheck` -> 0.

```bash
git status
git add app/src/jobs/relayFanOut.ts app/test/relayFanOut.test.ts
git commit -m "feat(relay): the leg claims before the send, tracks its phase, classifies the failure and hands unknown outcomes to reconcile; the loop brakes and closes through the record gate" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 9: The relay retry rung (D7a exception, D8, D16, Sec 2a RSW #1/#5/#6/#7)

**Files:**
- Modify: `app/src/jobs/relayRetryLeg.ts` (parser :252-263; the gate/window sites :532-558, :586-606, :674-692; the send call :626-654; the outcome chain :657-803; `refuseGate` :487-505)
- Modify: `app/src/jobs/relayFanOut.ts` (make `sendAttempts`, `owner` REQUIRED on the unit now that both callers pass them; delete the "absent = legacy path" branch and its tests' expectations)
- Test: `app/test/relayRetryLeg.test.ts` (the `legSend.override` seam at `:75-78`; `seedRetryRow` :162, `payloadFor` :263, `runHandler` :267, `slotOf` :277, `BOB_KEY` :95, `minutesAgo` :106; the RSW pins at `:557-566` and `:1214-1256`); `app/test/relayWindowCloseMirror.test.ts` (must stay green)

**Interfaces:**
- Consumes: Task 8's unit and kinds; Tasks 5, 6; the stub.
- Produces: `RelayRetryLegPayload.redrive?: true`; `RelayRetryLegJobDeps.sendAttemptsRepo?` is read; the rung's `rungOwner = { kind: 'relay_rung', relayConversationId, retryTsMsgId, memberKey }`; the rung's own module-local `gateFor` (Task 7's body) and `handOff` (no `continuation`).

- [ ] **Step 1: Failing tests**

```ts
const T0 = '2026-09-26T12:00:00.000Z';
const facts = { recipientDigest: 'd'.repeat(32), sender: POOL, bodyHash: 'h'.repeat(64), bodyShort: false, mediaCount: 0 };
const rungOwner = (row: MessageItem) => ({ kind: 'relay_rung' as const, relayConversationId: CONV, retryTsMsgId: row.tsMsgId, memberKey: BOB_KEY });

it('handed_to_reconcile enqueues send.reconcile for the rung with the hashed key and neither closes nor emits', async () => {
  legSend.override = async () => ({ kind: 'handed_to_reconcile', reason: 'unknown', attemptRef: { attemptNo: 1, attemptedAt: T0 } });
  const row = seedRetryRow(world, { attempt: 1 });
  await runHandler(payloadFor(row));
  expect(outbound.delayed.map((d) => d.envelope.jobName)).toEqual([SEND_RECONCILE_JOB]);
  expect(outbound.delayed[0]!.envelope.payload).toMatchObject({ owner: { kind: 'relay_rung', retryTsMsgId: row.tsMsgId, recipientKeyHash: hashRecipientKey(BOB_KEY) }, attemptedAt: T0, checkNo: 0 });
  expect(persistedEmits()).toEqual([]);
  expect(errorLogs()).toEqual([]);
});
it('sent_unrecorded enqueues reconcile with the SID and defers the inbox touch to adoption', /* legSend.override -> { kind: 'sent_unrecorded', providerSid: 'SM1', attemptRef }; expect no touchLastActivityPreservingStatus call, one reconcile envelope, one ERROR */);
it('stranded neither closes nor enqueues; ERROR only', /* legSend.override -> { kind: 'stranded' }; expect no envelope, no emit, one ERROR naming the rung */);
it('rejected closes nothing further (the unit wrote the slot) and emits the root close', /* { kind: 'rejected', errorCode: '21211' }; expect announceRootClose once, ERROR 'ended terminally' with legOutcome 'rejected', no throw */);
it('a reconcile enqueue that throws closes the rung unresolved', /* the queue-refusal seam; expect slot failed/send_unconfirmed via closeRelayRecipientIfUnsent, record done/unresolved cause enqueue_failed, root close emit */);
it('a re-driven rung declined by the window gate closes the record done/refused with retry_window_closed (RSW #1, D8)', async () => {
  const row = seedRetryRow(world, { attempt: 1, windowStart: minutesAgo(20) });
  await world.sendAttemptsRepo.claim(rungOwner(row), facts, T0);
  await world.sendAttemptsRepo.handToReconcile(rungOwner(row), { attemptNo: 1, attemptedAt: T0 });
  await world.sendAttemptsRepo.markRedriven(rungOwner(row), T0);
  await runHandler({ ...payloadFor(row), redrive: true });
  expect(slotOf(row.tsMsgId)).toMatchObject({ status: 'failed', errorCode: 'retry_window_closed' });
  expect(await world.sendAttemptsRepo.get(rungOwner(row))).toMatchObject({ state: 'done', outcome: 'refused', cause: 'retry_window_closed' });
});
it('a re-driven rung whose deadline expires during the acquire closes retry_window_closed and the record done/refused (RSW #5)', /* the file's drained-bucket helper; redrive: true; the RSW pins (no attempted write, no claimFanoutPass) AND record done/refused */);
it('a foreign fresh attempt on the rung skips the send (transient deferredByClaim) and re-enqueues the same rung once', /* claim rungOwner with another attempt now; expect no provider call, one same-rung re-enqueue through the transient sub-ladder, no slot write */);
it('a foreign open attempt makes refuseGate and the window close skip their writes with a WARN (RSW #6 through D8)', /* record reconciling; window closed; expect no slot write, one WARN, no emit */);
it('a done/sent record makes the window close skip its write (D8 allow-list)', /* record done/sent with a queued+sid slot; window closed; expect the slot unchanged, INFO */);
it('a stale attempting record at the window close is taken over into reconcile', /* record attempting 31 s old; window closed; expect record reconciling, ONE reconcile envelope (owner relay_rung, no continuation), no slot write */);
it('a transient re-enqueue of a re-driven rung does not carry redrive', /* legSend.override -> transient; payload redrive: true; expect the re-enqueued payload has no redrive */);
```

The RSW pins (`:557-566`, `:1214-1256`) stay byte-identical: the claim sits after the acquire, so a deadline close never sees an `attemptedAt`. The exhaustiveness of the chain is a compile-time `never` (no runtime test).

- [ ] **Step 2: Implement**
  - The parser carries `redrive`.
  - Build `rungOwner`; pass `sendAttempts`, `owner: rungOwner` to `sendOneRelayLeg`; `sendAttempts ??= deps.sendAttemptsRepo ?? createSendAttemptsRepo(...)`.
  - `refuseGate` and the window close (`:532-558`, `:586-606`, `:674-692`): `g = await gateFor(rungOwner, now)`; `proceed` -> the write as today, and if `g.record?.state === 'redriven'` `guardWrite(closeRedriven(rungOwner, { outcome: 'refused', cause: <code> }))`; `defer` -> skip the write with a WARN and return; `skip` -> INFO and return; `taken_over` -> `await handOff(rungOwner, g.record.attemptedAt)`, WARN, return. (RSW's claim-time declines never reach here: the webhook appends them closed and never enqueues.)
  - The outcome chain becomes `switch (outcome.kind)` with arms for `sent` (the touch wrapped in try/catch, ERROR on failure), `sent_unrecorded` (ERROR; `handOff`; NO touch), `handed_to_reconcile` (`handOff`), `stranded` (ERROR; nothing else), `transient` (the unchanged sub-ladder; a `deferredByClaim` transient skips the slot write and takes the same re-enqueue; the re-enqueue payload never carries `redrive`), `deadline_exceeded` (unchanged, plus `closeRedriven` when the record is `redriven`), `skipped_terminal` (unchanged), `rejected` / `refused` / `suppressed` / `filtered` (the ERROR + `announceRootClose`), and `default: { const never: never = outcome.kind; throw new Error(String(never)); }`.
  - `handOff(rungOwner, attemptedAt)` as Task 8's with `owner: toOwnerRef(rungOwner)` and no `continuation`; its enqueue-failure path closes the slot `SEND_UNCONFIRMED_CODE` and the record `unresolved`/`enqueue_failed`, ERROR, `announceRootClose()`.
  - In `relayFanOut.ts` make the two args required and delete the legacy branch.

- [ ] **Step 3: Run, typecheck, commit**

Run: `cd app; npx vitest run test/relayRetryLeg.test.ts test/relayWindowCloseMirror.test.ts test/relayFanOut.test.ts` -> PASS. `npm run typecheck` -> 0.

```bash
git status
git add app/src/jobs/relayRetryLeg.ts app/src/jobs/relayFanOut.ts app/test/relayRetryLeg.test.ts
git commit -m "feat(relay-retry): the rung owns its re-driven record, gates its pre-claim closes on the record, handles every outcome kind explicitly" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
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
- Consumes: Tasks 1-9; `enqueue` (`{ runAt }` only); `attemptKey`, `ownerKey` (Task 5); `mapTwilioStatus`; `finalize` and `adoptBroadcastRecipient` (Task 7); `adoptRelayRecipientIfUnsent`, `claimRelaySidPointer`, `closeRelayRecipientIfUnsent`, the consistent reads (Task 6); `touchLastActivityPreservingStatus`; `isMemberSuppressed`; `listByRecipient` (Task 5).
- Produces: `registerSendReconcileJobHandler(deps: SendReconcileJobDeps)`, `SendReconcileJobDeps { adapter?, messagesRepo?, broadcastsRepo?, contactsRepo?, conversationsRepo?, sendAttemptsRepo?, activityEventsRepo?, listingSendsRepo?, auditRepo?, events?, logger?, config? }`. The handler is registered through `defineJobHandler` WITHOUT the run-once marker (D11): every write below is idempotent, so a throw is a real retry.

**Owner resolution.** The payload's `SendAttemptOwnerRef` carries `recipientKeyHash`. The handler resolves the raw key: broadcast - `getByIdConsistent(broadcastId)` and the key `k` in `recipients` with `hashRecipientKey(k) === recipientKeyHash`; relay - the source/retry row (consistent) and the key in `delivery_recipients`, else the roster member whose `hashRecipientKey(relayMemberKey(m))` matches (a legacy row may have no slot yet). No match -> INFO `owner recipient not found` and return (the record, if any, is left for the sweeper - a Sec 1 residue).

**Handler flow:**

```
payload = parse(raw); owner = resolve(payload.owner); record = await sendAttempts.get(owner)
if (!record || record.state !== 'reconciling' || record.attemptedAt !== payload.attemptedAt) -> INFO 'reconcile superseded'; return
if (!(await sendAttempts.recordCheck(owner, payload.attemptedAt, payload.checkNo + 1))) -> INFO 'check already recorded'; return
verdict = record.sid !== undefined ? await adoptKnown(owner, record) : await lookup(owner, record, payload.checkNo)
switch (verdict.kind):
  found      -> closeFromReconcile(owner, attemptedAt, { outcome: 'adopted', sid: verdict.sid }); INFO; afterClose(owner)
  continue   -> next = payload.checkNo + 1 (always < 3 here); enqueueOrClose(() => enqueueSendReconcile({ ...payload, checkNo: next }, reconcileDelayMs(attemptedAt, next, Date.now())))
  never_sent -> redrive(owner, record, payload.continuation)
  unresolved -> closeUnresolved(owner, record, verdict.cause)
afterClose(owner): broadcast -> finalize(...); relay_rung -> announceRootClose; relay_leg -> nothing
```

`enqueueOrClose(run)` wraps EVERY enqueue in the job: on throw, if the record is `redriven` (a `never_sent` whose re-drive enqueue failed) -> `closeRedriven(owner, { outcome: 'enqueue_failed', cause })`, slot `ENQUEUE_FAILED_CODE` (broadcast `closeRecipientIfQueued(..., 'failed')`; relay `closeRelayRecipientIfUnsent`), ERROR, `afterClose`; otherwise -> `closeUnresolved(owner, record, ENQUEUE_FAILED_CODE)`.

`lookup(owner, record, checkNo)` (D13):

```
sender = record.sender; if (!sender) -> unresolved 'no_sender'
currentPhone = currentRecipientPhone(owner)   // broadcast: resolveContact(contactKey)?.phone; relay: the roster member's phone or a phone# key's number
if (!currentPhone || recipientDigest(sender, currentPhone) !== record.recipientDigest) -> unresolved 'digest_mismatch'
windowStartMs = Date.parse(record.attemptedAt) - RECONCILE_WINDOW_LEAD_MS
siblings = await sendAttempts.listByRecipient(sender, record.recipientDigest, new Date(windowStartMs).toISOString())   // consistent; read ONCE per check
isSibling = (s) => attemptKey(s.owner) !== attemptKey(owner)      // RECORD identity (owner + recipient): two contacts on one phone in one broadcast ARE siblings (R3 #5)
siblingSids = new Set(siblings.filter((s) => isSibling(s) && s.sid !== undefined).map((s) => s.sid))
candidates = []; pages = 0; token = undefined; providerError = undefined
do { try { page = await adapter.listMessages({ to: currentPhone, from: sender, pageSize: RECONCILE_LIST_PAGE_SIZE, pageToken: token }) } catch (err) { providerError = err; break }
     pages += 1; candidates.push(...page.messages.filter((m) => Date.parse(m.createdAt) >= windowStartMs))
     token = page.nextPageToken; if (token !== undefined && pages >= RECONCILE_MAX_PAGES) return unresolved 'page_bound'
} while (token !== undefined)
if (providerError) return isLast(checkNo) ? unresolved 'provider_unreachable' : continue
unmatched = []
for m of candidates sorted by createdAt ascending:
   if (siblingSids.has(m.providerSid)) continue                    // a sibling ATTEMPT holds it on its record (R2 #5)
   held = await heldBy(owner, m.providerSid)                       // consistent: { kind: 'system' } | { kind: 'other', holder } | { kind: 'mine' } | { kind: 'free' } (below)
   if (held.kind === 'system' || held.kind === 'other') continue
   if (held.kind === 'mine') { r = await adopt(owner, record, m); return r.kind === 'other' ? unresolved 'sid_held_elsewhere' (holder from a fresh heldBy) : r }   // repair: the row exists, the slot may not; a race to `other` is never re-sent
   if (!matches(record, m)) { unmatched.push(m); continue }
   r = await adopt(owner, record, m)                               // the adoption's OWN claim decides (below)
   if (r.kind === 'found') return r; else continue
if (!isLast(checkNo)) return continue
if (unmatched.length > 0) return unresolved 'unidentified_candidate'
if (siblings.some((s) => isSibling(s) && s.bodyHash === record.bodyHash && s.mediaCount === record.mediaCount && (s.state !== 'done' || s.outcome === 'adopted'))) return unresolved 'same_fingerprint_sibling'
return never_sent
matches(record, m) = record.bodyShort ? m.mediaCount === record.mediaCount : bodyFingerprint(m.body).hash === record.bodyHash
```

`heldBy(owner, sid)` returns `{ kind: 'system' } | { kind: 'other'; holder: string } | { kind: 'mine' } | { kind: 'free' }` where `holder` is a log-safe description of the other owner (`broadcast#<id>` / `relay#<conversationId>#<tsMsgId>#<logSafeMemberKey>` / `syssid:<kind>`): `getSystemSidMarkerConsistent(sid)` -> `system`; `getRelaySidPointerConsistent(sid)` -> for a relay owner all three ref fields equal -> `mine`, else `other`; `getByProviderSidConsistent(sid)` -> for a broadcast owner: `row.broadcast_id === broadcastId` AND (`row.recipient_contact_id === undefined` OR `row.recipient_contact_id === <the owner's contact id>` OR the owner's slot `tsMsgId === row.tsMsgId`) -> `mine`, else `other` (R2 #18); for a relay owner a `sid#` row that is not ours -> `other`; nothing -> `free`.

`adoptKnown(owner, record)`: `held = await heldBy(owner, record.sid)`; `other` or `system` -> `unresolved 'sid_held_elsewhere'` with `heldBy: held.holder` on the ERROR (spec D13 revision 10: the line names BOTH owners; never re-sent); `m = await adapter.getMessage(record.sid)`; `!m` -> `throw new Error('known SID not found at the provider')` (a genuine retry); `r = await adopt(owner, record, m)`; `r.kind === 'other'` -> `unresolved 'sid_held_elsewhere'` (re-read `heldBy` for the holder); else `r`.

`adopt(owner, record, m)` per owner (D15), each idempotent as a whole:
- **broadcast**: `r = await adoptBroadcastRecipient(deps, { broadcastId, contactKey, providerSid: m.providerSid, providerTs: m.createdAt, providerStatus: m.providerStatus, errorCode: m.errorCode, body: m.body, mediaCount: m.mediaCount, sentAt: m.sentAt })`; `'other_owner'` -> `{ kind: 'other' }`; `'adopted' | 'skipped'` -> `{ kind: 'found', sid }`.
- **relay_leg / relay_rung**: `c = await claimRelaySidPointer(m.providerSid, { conversationId, tsMsgId: sourceTsMsgId | retryTsMsgId, memberKey })`; `'other'` -> `{ kind: 'other' }`; then `adoptRelayRecipientIfUnsent(conversationId, tsMsgId, memberKey, { status: relayStatusFor(m), sid, sentAt: m.sentAt ?? m.createdAt, errorCode? })` (`skipped`/`adopted` both `found`; `missing` -> throw); relay_rung additionally `touchLastActivityPreservingStatus(conversationId, undefined, m.createdAt)` when the conversation's `last_activity_at < m.createdAt`; an adopted terminal failure WARNs `adopted terminal failure - webhook side effects skipped` naming the code.

`statusFor`: provider `accepted|queued|sending|sent` -> broadcast `sent`, relay `queued` for `accepted|queued|sending` else `sent`; `delivered|read` -> `delivered`; `undelivered` -> broadcast `failed` + code, relay `undelivered` + code; `failed|canceled` -> `failed` + code. `carrierSentAt` (broadcast) / `sentAt` (relay) from `m.sentAt` whenever present.

`redrive(owner, record, continuation)` (D16) - EVERY owner runs `markRedriven` before its enqueue (a re-driven pass meets a `redriven` record, never a `reconciling` one - R3 #1):
- broadcast -> `markRedriven(owner, attemptedAt)` (false -> if `record.redriveCount >= 1` then `closeUnresolved('second_unknown')` else return) -> `enqueueOrClose(() => enqueue(BROADCAST_SEND_JOB, { broadcastId, recipientKeys: [contactKey], attempt: (b.fanout_attempt ?? 0) + 1, redrive: true }))`;
- relay_leg -> pre-check (conversation open, member on roster, source present) else `closeRelayRecipientIfUnsent(... REDRIVE_REFUSED_CODE)` + `closeFromReconcile(owner, attemptedAt, { outcome: 'redrive_refused', cause })` + `afterClose`; `markRedriven` as above; `enqueueOrClose(() => enqueue(RELAY_FANOUT_JOB, { relayConversationId, sourceTsMsgId, senderKey: continuation.senderKey, senderNameOverride?, recipientKeys: [memberKey], attempt: (source.fanout_attempt ?? 0) + 1, redrive: true }))` (no `continuation` -> `redrive_refused` cause `no_continuation`);
- relay_rung -> the same pre-check (conversation open, member on roster, the retry row present) else the same `redrive_refused` close; `markRedriven` as above; `enqueueOrClose(() => enqueue(RELAY_RETRY_LEG_JOB, { relayConversationId, retryTsMsgId, redrive: true }))`.
(The continuation payloads carry raw keys - deviation 4.)

`closeUnresolved(owner, record, cause)`: broadcast `closeRecipientIfQueued(id, key, SEND_UNCONFIRMED_CODE, 'unconfirmed')`; relay `closeRelayRecipientIfUnsent(..., { status: 'failed', errorCode: SEND_UNCONFIRMED_CODE })`; then `closeFromReconcile(owner, attemptedAt, { outcome: 'unresolved', cause })` (or `closeRedriven` when the record is `redriven`); ONE ERROR `{ event: 'send_reconcile', verdict: 'unresolved', cause, owner: <kind + ids>, recipientKey: safeRecipientKey(key) }`; `afterClose`.

Logging (D16/D18): `found` INFO, `never_sent` WARN, `unresolved` ERROR; never a body or a phone; every recipient key through `safeRecipientKey`.

- [ ] **Step 1: Failing unit tests (`app/test/sendReconcile.test.ts`)** over `createFakeWorld()` + the jobs envelope (the machinery Task 7's tests use); the harness adapter's `listMessages` answers from `world.sentDetails` (Task 4) plus `world.providerMessages`, paginated at `world.listPageSize`; reconcile-related worlds set `BUSINESS_PHONE_NUMBER` so records have a sender. One `it` per case, each asserting the record, the slot(s), the enqueues and the log level:
  1. known SID via `getMessage` (spy: no `listMessages`, no digest check) -> adopted with the fetched status.
  2. listed `delivered` orphan adopts on a broadcast: row `automated: true`, `recipient_contact_id` when the contact holds the phone, `carrierSentAt` set, milestone + listing-send written, record `done/adopted`, finalized `sent`.
  3. `undelivered` 30005 adoption: broadcast -> slot `failed` `30005`, contact flagged, no milestone, no listing-send; relay leg -> slot `undelivered` `30005`, no flag.
  4. empty at check 0, populated at check 1 -> `continue` then adopted; the check-1 envelope's delay equals `reconcileDelayMs(attemptedAt, 1, now)`.
  5. a candidate held by ANOTHER owner (a `sid#` pointer to a row with a different `broadcast_id`) is excluded; held by THIS owner -> `found` repair.
  5b. a `syssid#` candidate is excluded.
  5c. a candidate whose SID sits on a SIBLING RECORD (a sibling attempt `reconciling` with that `sid`, no pointer yet) is excluded (R2 #5).
  5d. a known SID whose pointer resolves to another owner -> `unresolved` `sid_held_elsewhere`, no send, no re-drive, and the ERROR line names both owners (`heldBy`) (spec D13 rev 10).
  5e. two contacts sharing one phone in ONE broadcast, one orphan: the first adopts, the second's candidate reads `other` (the row's `recipient_contact_id`) and it ends `unresolved` `same_fingerprint_sibling` at the last check (R2 #18).
  6. the spike's Smart-Encoded body matches its submitted body; a media-only message matches on media count.
  7. two text attempts, two orphans -> each adopts one (relay: `claimRelaySidPointer` decides), neither re-drives.
  8. two MEDIA attempts with the same fingerprint and ONE orphan -> one adopted, the other `unresolved` `same_fingerprint_sibling` at the last check, never a re-drive.
  9. a STOP auto-reply in the window -> `continue` at checks 0-1, `unresolved` `unidentified_candidate` at check 2.
  10. a multi-page list is walked (`world.listPageSize = 2`); the bound exceeded -> `unresolved` `page_bound`.
  11. empty through all three checks -> `never_sent`; broadcast re-drive envelope `{ recipientKeys: [k], redrive: true }`; a second `never_sent` delivery -> `markRedriven` false, no second enqueue.
  12. adapter throws on every check -> `unresolved` `provider_unreachable`, exactly one ERROR.
  13. digest mismatch (the contact's phone changed) -> `unresolved` `digest_mismatch` - Review Focus 2.
  13b. a candidate created 59 s BEFORE the attempt is considered - Review Focus 4.
  14. a payload for an older `attemptedAt` writes nothing; a redelivered check (same payload twice) records once and converges.
  14b. `unresolved` delivered twice writes once.
  15. relay `never_sent` on a closed group -> `redrive_refused` slot + record, no enqueue; on an open group -> the record `redriven` and a `relay.fanOut` envelope with `redrive: true` and the continuation's `senderKey`.
  15b. relay_rung `never_sent` on an open group -> the record `redriven` and a `relay.retryLeg` envelope `{ relayConversationId, retryTsMsgId, redrive: true }`; deliver it through Task 9's handler: the re-driven rung CLAIMS (from `redriven`, attemptNo 2) and sends once; on a closed group -> `redrive_refused` (R3 #1).
  15c. `heldBy` for a broadcast owner: a row with the same `broadcast_id` but another `recipient_contact_id` is `other` with a `holder`; the same row with the owner's contact id is `mine`.
  16. relay_rung adoption touches the inbox the preserving way and every close emits the root close.
  17. an enqueue throw after `never_sent` closes `enqueue_failed` (record via `closeRedriven`, slot `enqueue_failed`, finalize runs); after any other verdict `unresolved` `enqueue_failed`.
  18. `reconcileCheckDelaysMs` honors `E2E_SEND_RECONCILE_DELAYS_MS` only when `JOBS_QUEUE_URL` is unset; `reconcileDelayMs` reads it.
  19. a known-SID `getMessage` throw propagates (a genuine retry).
  20. `markRedriven` false on a `redriveCount >= 1` record closes `unresolved` `second_unknown`.
  21. the `send.reconcile` payload carries only the hashed recipient key (assert no `phone#+` substring in any `send.reconcile` envelope for a phone-keyed recipient - the continuation payloads are out of scope, deviation 4) and the handler resolves it; no log line contains `phone#+`.
- [ ] **Step 2: Failing integration test (`app/test/sendReconcile.integration.test.ts`)** over the REAL repos on DynamoDB Local: run the same `found` adoption twice for a relay leg and for a broadcast recipient and assert one pointer, one message row, one slot move, one stats bump, one record transition; and that an adoption cannot regress a slot a receipt already advanced (write the slot `delivered` via `updateRecipientDeliveryStatus` first, then adopt as `sent` -> the slot stays `delivered`).
- [ ] **Step 3: Implement** the job, the registration (+ the job-set pin), un-skip Task 7's ordering test.
- [ ] **Step 4: Run, typecheck, commit**

Run: `cd app; npx vitest run test/sendReconcile.test.ts test/sendReconcile.integration.test.ts test/broadcastFanOut.test.ts test/relayFanOut.test.ts test/relayRetryLeg.test.ts <the registerHandlers test>` -> PASS. `npm run typecheck` -> 0.

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
- Tests that go RED and are updated here: the `transient_cap` copy pins at `deliveryStatus.test.ts:377, :781, :839, :876, :894`, `Timeline.delivery.test.tsx:388, :396-397, :423` (`StatChips.test.tsx:152`, `broadcastFormat.test.ts:153` in Task 14).

**Interfaces:**
- Consumes: the app constants in the mirror test ONLY (the `relayWindowCloseMirror.test.ts` idiom; `app/src/lib/sendOutcome.ts` imports only the adapter's error leaf, which has no Node types, so the dashboard tsconfig compiles it).
- Produces: `SEND_UNCONFIRMED_CODE`, `REDRIVE_REFUSED_CODE`, `SEND_RETRYABLE_CODE`, `SMS_SENDING_DISABLED_CODE` exported from `deliveryStatus.ts` (deviation 2); `NOT_CONFIRMED_PRESENTATION: DeliveryPresentation = { label: 'Not confirmed', tone: 'danger', isFailure: false, reason: "Couldn't confirm whether this text went out" }`.

- [ ] **Step 1: Failing tests**

```ts
// deliveryStatus.test.ts (new describes; L0 / NOW / STALE_QUEUED_EXPECTATION are the file's staleness fixtures - read them)
describe('send_unconfirmed (spec D20/D21)', () => {
  it('presents by code alone on a failed, an undelivered and a queued slot', () => {
    for (const status of ['failed', 'undelivered', 'queued'] as const) {
      expect(presentLegDelivery({ status, errorCode: 'send_unconfirmed' }, 'relay')).toEqual({ label: 'Not confirmed', tone: 'danger', isFailure: false, reason: "Couldn't confirm whether this text went out" });
    }
  });
  it('the rollup counts it under not confirmed, never failed, with the reason', () => {
    expect(presentRelayDelivery([{ status: 'delivered' }, { status: 'failed', errorCode: 'send_unconfirmed' }], { relay: true }))
      .toEqual({ label: 'delivered 1/2 - 1 not confirmed', tone: 'danger', isFailure: false, reason: "Couldn't confirm whether this text went out" });
  });
  it('the reason has no trailing period (the accessible name adds its own)', () => {
    expect(deliveryReason('send_unconfirmed')).toBe("Couldn't confirm whether this text went out");
  });
});
describe('internal codes this branch adds (D23)', () => {
  it.each([
    ['send_unconfirmed', "Couldn't confirm whether this text went out"],
    ['redrive_refused', "Wasn't resent: the group closed or the member left"],
    ['sms_sending_disabled', 'SMS sending is switched off, so nothing was sent'],
    ['transient_cap', 'Sending gave up after repeated temporary errors'],
  ])('%s renders as prose with no (error N) tail', (code, copy) => {
    expect(deliveryReason(code)).toBe(copy);
    expect(deliveryReason(code, { relay: true })).toBe(copy);
  });
  it('send_retryable yields no reason (the slot renders as queued)', () => { expect(deliveryReason('send_retryable')).toBeUndefined(); });
  it('an unmapped provider code keeps the fallback', () => { expect(deliveryReason('21211')).toBe('Delivery failed (error 21211)'); });
});
describe('a queued leg ages from attemptedAt when it has no sentAt (D20a)', () => {
  it('stales after the budget', () => {
    const slot = { status: 'queued' as const, attemptedAt: new Date(L0).toISOString() };
    expect(isStaleLeg(slot, undefined, NOW)).toBe(true);
    expect(canEverGoStale(slot, undefined, L0 + 1000)).toBe(true);
    expect(presentLegDelivery(slot, 'relay', undefined, NOW)).toEqual(STALE_QUEUED_EXPECTATION);
  });
  it('a queued leg with neither clock still never stales', () => { expect(isStaleLeg({ status: 'queued' }, undefined, NOW)).toBe(false); });
  it('sentAt wins over attemptedAt', () => { /* sentAt fresh (NOW - 1000), attemptedAt ancient -> not stale */ });
});
```

Update the `transient_cap` copy pins listed under Files to the new wording; add a `Timeline.delivery.test.tsx` three-position case for an `undelivered` root leg whose terminal rung code is `send_unconfirmed` (chip `delivered 1/2 - 1 not confirmed - Couldn't confirm whether this text went out`; accessible name `/Lars Landlord: Not confirmed, Couldn't confirm whether this text went out/`; revealed row `Not confirmed - Couldn't confirm whether this text went out`); a `Timeline.ticker.test.tsx` ARMING case for a queued leg with `attemptedAt` and no `sentAt`; a `relayRetryJoin.test.ts` case that a terminal rung closed `send_unconfirmed` projects `{ errorCode: 'send_unconfirmed', retryState: 'terminal' }` with the original's status; a `useRelayThread.test.tsx` passthrough assertion for `attemptedAt`.

```ts
// dashboard/src/routes/contact/sendOutcomeCodesMirror.test.ts
import { REDRIVE_REFUSED_CODE as APP_REDRIVE_REFUSED_CODE, SEND_RETRYABLE_CODE as APP_SEND_RETRYABLE_CODE, SEND_UNCONFIRMED_CODE as APP_SEND_UNCONFIRMED_CODE, SMS_SENDING_DISABLED_CODE as APP_SMS_SENDING_DISABLED_CODE } from '../../../../app/src/lib/sendOutcome.js';
import { deliveryReason, REDRIVE_REFUSED_CODE, SEND_RETRYABLE_CODE, SEND_UNCONFIRMED_CODE, SMS_SENDING_DISABLED_CODE } from './deliveryStatus.js';
describe('send-outcome codes mirror the app constants', () => {
  it.each([[SEND_UNCONFIRMED_CODE, APP_SEND_UNCONFIRMED_CODE], [REDRIVE_REFUSED_CODE, APP_REDRIVE_REFUSED_CODE], [SEND_RETRYABLE_CODE, APP_SEND_RETRYABLE_CODE], [SMS_SENDING_DISABLED_CODE, APP_SMS_SENDING_DISABLED_CODE]])('%s', (dash, app) => expect(dash).toBe(app));
  it('every closed code has prose and the transient one renders as queued', () => {
    for (const c of [APP_SEND_UNCONFIRMED_CODE, APP_REDRIVE_REFUSED_CODE, APP_SMS_SENDING_DISABLED_CODE]) { const r = deliveryReason(c); expect(r).toBeDefined(); expect(r).not.toContain('(error '); }
    expect(deliveryReason(APP_SEND_RETRYABLE_CODE)).toBeUndefined();
  });
});
```

Run: `npm run test -w @housingchoice/dashboard -- src/routes/contact` -> the new cases FAIL.

- [ ] **Step 2: Implement** - constants + `NOT_CONFIRMED_PRESENTATION`; `INTERNAL_CODE_REASONS` entries (`send_unconfirmed`, `redrive_refused`, `sms_sending_disabled`; `transient_cap` re-worded); `deliveryReason` returns `undefined` for `send_retryable` (an explicit early return so it never prints `Delivery failed (error send_retryable)`); `presentLegDelivery`: right after the `contact_opted_out` arm (`:689-700`) `if (slot.errorCode === SEND_UNCONFIRMED_CODE) return { ...NOT_CONFIRMED_PRESENTATION };`; `presentRelayDelivery`: `failedLegs` excludes the code, `notConfirmedLegs` includes any leg with it, the branch-2 reason join (`:567-569`) widens to `retryStateOf(s) === 'unconfirmed' || s.errorCode === SEND_UNCONFIRMED_CODE`; `stalenessClockMs`: `case 'queued': return legClock ?? parseWireClock(slot.attemptedAt);` with the doc table row and the `:213-224` rationale rewritten (drop the false "server staleness alarm" sentence; `attemptedAt` is OUR attempt clock, best-effort); the two type mirrors; `relayRetryJoin.ts` needs no logic change (`withDecidingRung` keeps unnamed fields).
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
- Modify: `dashboard/src/routes/broadcasts/broadcastFormat.ts` (`presentRecipientStatus` :126-142 gains `errorCode?: string`), `StatChips.tsx:27-36` (the chip after Failed; the header doc's balance line gains `+ Not confirmed`), `DeliveryBadge.tsx:34` (pass `errorCode`), `BroadcastResults.tsx:47-89` (split `failed` into `failedStyle` for the class + sort and `showRetryHint = failed && errorCode !== 'send_unconfirmed' && contactId !== undefined`)
- Modify: `app/src/lib/seed/matrix.ts:1229-1231, :1252` and `app/src/lib/seed/performance.ts:995-1009` (`unconfirmed: 0`)
- Tests to extend: `StatChips.test.tsx` (the label ORDER pin `:75-86` gains `'Not confirmed'` after `'Failed'`; the `transient_cap` pin `:152`), `broadcastFormat.test.ts` (`:153` pin; new cases), `BroadcastResults.test.tsx`; run `app/test/performanceSeed.test.ts`.

- [ ] **Step 1: Failing tests**

```ts
// StatChips.test.tsx
it('renders a Not confirmed chip after Failed, danger only above zero, and keeps the audience sum', () => {
  render(<StatChips stats={stats({ audience: 4, delivered: 2, failed: 1, unconfirmed: 1 })} />);
  expect(labels()).toEqual(['Recipients', 'Delivered', 'Sent', 'Sending', 'Queued', 'Failed', 'Not confirmed', 'Skipped']);
  expect(chipValue(list, 'Not confirmed')).toBe(1);
});
it('a legacy stats object without the bucket renders 0 with no danger class', /* stats({}) has no unconfirmed */);
// broadcastFormat.test.ts
it('presentRecipientStatus keys on send_unconfirmed before status', () => {
  expect(presentRecipientStatus('failed', undefined, 'send_unconfirmed')).toEqual({ label: 'Not confirmed', tone: 'danger', isFailure: false, reason: "Couldn't confirm whether this text went out" });
  expect(presentRecipientStatus('failed', undefined, '30007').isFailure).toBe(true);
});
it('shareRecipientReason answers the internal map for a failed send_unconfirmed row', () => { expect(shareRecipientReason('failed', 'send_unconfirmed')).toBe("Couldn't confirm whether this text went out"); });
it('skippedTotal never includes unconfirmed', () => { expect(skippedTotal(stats({ unconfirmed: 5 }))).toBe(0); });
// BroadcastResults.test.tsx
it('an unconfirmed row reads Not confirmed with its reason, keeps the failed styling and sort, and offers no retry hint', /* results with { c1: { status: 'failed', errorCode: 'send_unconfirmed', firstName: 'Ana' }, c2: { status: 'delivered' } }: row text 'Not confirmed' + reason; c1 sorted first; no link named /open conversation to retry/ */);
```

Run: `npm run test -w @housingchoice/dashboard -- src/routes/broadcasts` -> FAIL.

- [ ] **Step 2: Implement** as listed under Files (`presentRecipientStatus`'s first line `if (errorCode === SEND_UNCONFIRMED_CODE) return { ...NOT_CONFIRMED_PRESENTATION };`, importing both from `deliveryStatus.ts`; the chip `{ label: 'Not confirmed', value: stats.unconfirmed ?? 0, tone: 'danger' }`; the three seed literals).
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
- `GET /2010-04-01/Accounts/:accountSid/Messages.json?To=&From=&PageSize=&PageToken=` -> `{ messages: [...], next_page_uri (a path carrying PageToken, or null), page, page_size, first_page_uri, previous_page_uri, uri, start, end }`, newest first; `PageToken` = the fake's integer offset; default page size 50, max 1000; `page_size` echoes the effective size.
- `GET /2010-04-01/Accounts/:accountSid/Messages/:sid.json` -> one resource, or `404 { code: 20404, message, more_info, status: 404 }`.
- Resource: `sid, status, to, from, body (SMART-ENCODED at serialization: U+2018/U+2019 -> ', U+201C/U+201D -> ", U+2013/U+2014 -> -, U+2026 -> ..., U+00A0 -> space), num_media (string), error_code (int or null), date_created (RFC 2822 from the stored createdAt - ONE clock per message), date_sent (RFC 2822 or null while queued), messaging_service_sid, direction: 'outbound-api'`. The create response still echoes the submitted body.
- `POST /control/fail-next-send { partyNumber, mode: 'reject' | 'drop_before_create' | 'accept_then_drop', code?, count? }` -> `{ ok: true }`; consumed by the next `count` (default 1) creates TO that party: `reject` -> `400 { code: code ?? 21211, message: 'fail-next-send: rejected by the fake', more_info, status: 400 }` and nothing recorded; `drop_before_create` -> `req.socket.destroy()` and nothing recorded; `accept_then_drop` -> recorded (callbacks fire as normal), then `req.socket.destroy()` with no response.
- `POST /control/fail-list { partyNumber, count? }` -> the next `count` list OR fetch calls whose `To` (list) or resource `to` (fetch) is that party answer `500 { code: 20500, message: 'fail-list: provider unavailable', more_info, status: 500 }`. This is how the e2e and the self-QA drive `unresolved` deterministically.
- `e2e/fixtures/fakeTwilio.ts`: `failNextSend`, `failList`, `getMessageBySid`.

- [ ] **Step 1: Failing fake tests**

```ts
// fake-twilio/test/rest.test.ts (new cases; `app` and `engine` are the file's fixtures)
it('lists messages by To and From newest first with Twilio paging', async () => {
  for (const b of ['one', 'two', 'three']) await request(app).post('/2010-04-01/Accounts/ACtest/Messages.json').type('form').send({ To: '+16175550100', From: '+15550009999', Body: b });
  const page1 = await request(app).get('/2010-04-01/Accounts/ACtest/Messages.json').query({ To: '+16175550100', From: '+15550009999', PageSize: 2 });
  expect(page1.status).toBe(200);
  expect(page1.body.messages.map((m: { body: string }) => m.body)).toEqual(['three', 'two']);
  expect(page1.body.page_size).toBe(2);
  expect(page1.body.next_page_uri).toMatch(/PageToken=/);
  const page2 = await request(app).get(page1.body.next_page_uri);
  expect(page2.body.messages.map((m: { body: string }) => m.body)).toEqual(['one']);
  expect(page2.body.next_page_uri).toBeNull();
  expect(page1.body.messages[0]).toMatchObject({ num_media: '0', error_code: null, direction: 'outbound-api' });
  expect(typeof page1.body.messages[0].date_created).toBe('string');
});
it('stores the Smart-Encoded body the way Twilio does', async () => {
  const submitted = 'HC \u2019q\u2019 d\u2014d m\u2026';
  const created = await request(app).post('/2010-04-01/Accounts/ACtest/Messages.json').type('form').send({ To: '+16175550100', From: '+15550009999', Body: submitted });
  expect(created.body.body).toBe(submitted);
  const fetched = await request(app).get(`/2010-04-01/Accounts/ACtest/Messages/${created.body.sid}.json`);
  expect(fetched.body.body).toBe("HC 'q' d-d m...");
});
it('fetch of an unknown SID is a Twilio 404', async () => {
  const r = await request(app).get('/2010-04-01/Accounts/ACtest/Messages/SMnope.json');
  expect(r.status).toBe(404); expect(r.body).toMatchObject({ code: 20404, status: 404 });
});
```

```ts
// fake-twilio/test/control.test.ts (new cases)
it('fail-next-send reject answers a Twilio 4xx, records nothing, and is consumed', async () => {
  await request(app).post('/control/fail-next-send').send({ partyNumber: '+16175550100', mode: 'reject', code: 21211 }).expect(200);
  const r = await request(app).post('/2010-04-01/Accounts/ACtest/Messages.json').type('form').send({ To: '+16175550100', From: '+15550009999', Body: 'x' });
  expect(r.status).toBe(400); expect(r.body.code).toBe(21211);
  expect(engine.listThreads().find((t) => t.partyNumber === '+16175550100')?.messages ?? []).toHaveLength(0);
  await request(app).post('/2010-04-01/Accounts/ACtest/Messages.json').type('form').send({ To: '+16175550100', From: '+15550009999', Body: 'y' }).expect(201);
});
it('accept_then_drop records the message and drops the connection', async () => {
  await request(app).post('/control/fail-next-send').send({ partyNumber: '+16175550100', mode: 'accept_then_drop' }).expect(200);
  await expect(request(app).post('/2010-04-01/Accounts/ACtest/Messages.json').type('form').send({ To: '+16175550100', From: '+15550009999', Body: 'z' })).rejects.toThrow(/socket hang up|ECONNRESET|aborted/);
  expect(engine.listThreads().find((t) => t.partyNumber === '+16175550100')!.messages.map((m) => m.body)).toEqual(['z']);
});
it('drop_before_create records nothing and drops the connection', /* same shape; the thread stays empty */);
it('fail-list makes the next list and fetch for that party answer 500, then recovers', async () => {
  const created = await request(app).post('/2010-04-01/Accounts/ACtest/Messages.json').type('form').send({ To: '+16175550100', From: '+15550009999', Body: 'w' });
  await request(app).post('/control/fail-list').send({ partyNumber: '+16175550100', count: 2 }).expect(200);
  expect((await request(app).get('/2010-04-01/Accounts/ACtest/Messages.json').query({ To: '+16175550100', From: '+15550009999' })).status).toBe(500);
  expect((await request(app).get(`/2010-04-01/Accounts/ACtest/Messages/${created.body.sid}.json`)).status).toBe(500);
  expect((await request(app).get('/2010-04-01/Accounts/ACtest/Messages.json').query({ To: '+16175550100', From: '+15550009999' })).status).toBe(200);
});
```

Run: `npm run test -w @housingchoice/fake-twilio` -> the new cases FAIL.

- [ ] **Step 2: Implement** (the `smartEncode` helper exported for the test; `toMessageResource`; the create handler's hook points before and after `recordOutboundFromApp`; the two control routes with input validation; the engine maps keyed by party number; `reset()` clears them).
- [ ] **Step 3: Run, commit**

Run: `npm run test -w @housingchoice/fake-twilio` -> PASS.

```bash
git status
git add fake-twilio/src/routes/rest.ts fake-twilio/src/routes/control.ts fake-twilio/src/engine/engine.ts fake-twilio/src/engine/store.ts fake-twilio/src/engine/types.ts fake-twilio/test/rest.test.ts fake-twilio/test/control.test.ts e2e/fixtures/fakeTwilio.ts
git commit -m "feat(fake-twilio): Messages list and fetch with Smart-Encoded bodies; fail-next-send and fail-list control seams" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 12: Lane seams and the four e2e specs (D13a, D19, Sec 8)

**Files:**
- Modify: `scripts/e2e-session.mjs` `childEnv` (beside `:272-282`): `E2E_SEND_RECONCILE_DELAYS_MS: '2000,4000,8000'` with a comment naming this branch and the `JOBS_QUEUE_URL` guard.
- Create: `e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts`
- Possibly modify: `e2e/support/selectors.md` (only if a new role/label is introduced - the chip is a `<dt>` inside `getByLabel('Delivery stats')`; a recipient row is text inside `getByRole('list', { name: 'Recipients' })`).

**Before writing a line, READ these and use their real names and shapes:** `e2e/fixtures/relayConnect.ts` - `createGroupOpen(page, members: RelayMember[])` returns `{ conversationId, status, pool_number }` ONLY; the member numbers and labels are the CALLER's own input, so the spec keeps its own `members` array and registers any ad-hoc party itself the way the file's other callers do; `e2e/fixtures/fakeTwilio.ts` (`sendAsParty`, `getOutboundTo`, `listThreads`, Task 11's helpers); the login/reseed helpers under `e2e/support` (`grep -rn "dev-login\|reseed" e2e/support e2e/fixtures`); the broadcasts spec's `statValue` / `statusPill` (`e2e/tests/dashboard-next/broadcasts.spec.ts:269-287`; extract to `e2e/support/broadcastSelectors.ts` if file-local) and how it CREATES and SENDS a share through the API (reuse its helper or its request sequence); `share-skip-fix.spec.ts:255-290` (how it creates a tenant WITH consent - `consent_method: 'inbound_text'` - and reads the Recipients list). Every intro/announcement a relay group sends on creation must be SETTLED (poll `getOutboundTo` for the intro) before arming a fail seam, or the seam consumes the intro instead of the leg.

**The four specs (intent; the builder writes them against the real helpers):**

1. `accept_then_drop on a relay leg ends adopted as delivered` - create an open two-member group (settle its intros); arm `failNextSend({ partyNumber: <member B's number>, mode: 'accept_then_drop' })`; `sendAsParty({ from: <member A>, to: <the pool number>, body: 'Hello from the sender' })`; open `/conversations/<id>`, CLICK the member-authored bubble to reveal the recipient rows (the per-recipient list appears only after the reveal; the team-sent rollup chip is not present on a member-authored source), expect member B's row to read `Delivered` within 20 s (adopted at the 2 s or 4 s check); `getOutboundTo(B)` has exactly ONE message with that body.
2. `drop_before_create on a broadcast recipient is re-driven once and the share finishes sent` - a consented tenant (NOT `contact-tenant-0002`); arm `drop_before_create` for its number; create and send a seeds-only share to it; on `/broadcasts/<id>` poll `statValue('Delivered')` to 1 within 40 s (never_sent at the third check, 8 s, then the re-drive); `statusPill('Sent')` visible; `getOutboundTo(tenant)` has ONE message.
3. `reject with 21211 marks the recipient failed with that code and the rest sent` - two consented tenants; `reject` (code 21211) for the first; send the share; `statValue('Failed')` 1, `statValue('Delivered')` 1; the Recipients list shows `Failed` and `Delivery failed (error 21211)`; the `Not confirmed` chip exists with value 0.
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
- `docs/issues/fanout-close-path-robustness-residues.md` - the D7a failure-arm write that itself fails is this issue's "throwing close" class one step earlier; now every such write goes through `guardWrite` and a lost hand-off is DEFERRED (stranded) for the continuation's takeover; cite the arms. Also the declared deviation 3: a send site's post-claim slot write keeps only the slot's own guards (not fenced on the record).
- `docs/issues/fanout-pass-setup-throw-strands-pass.md` - the relay retry rung's pre-claim throws (the row read, the lineage check, the conversation read, a suppression read that rejects, the no-pool throw); cite.
- `docs/issues/relay-continuation-early-return-strands-slots.md` - a RE-DRIVE continuation's early returns now close the carried member's record `redrive_refused` and its slot (Task 8); the ordinary transient continuation's early returns still strand, as filed.
- `docs/issues/manual-retry-double-send-residual-windows.md` - a dated note beside gap 5: the status webhook's `closeRetryLegEnqueueFailed` is a close by another writer the D8 gate cannot cover (fenced file).
- `docs/issues/send-attempt-sweeper.md` - the record's exact key shapes, states, clocks and the index family as BUILT, plus the three residues the sweeper resolves: a fresh `attempting` record at the cap-close; a STRANDED relay member or rung (a lost `handToReconcile`) - the relay ladder (5 s + 10 s) and the rung's sub-ladder never outlast the 30 s TTL, so no continuation takes it over (spec D8a revision 11); and an orphan record whose owner recipient cannot be resolved.
- `docs/issues/throw-for-redelivery-defeated-by-job-marker.md` - built on this branch for both fan-outs and the relay retry rung; the `TODO(throw-for-redelivery-defeated-by-job-marker)` markers are gone from the tree; `status` stays `open` (the human sets it resolved at merge).
- `docs/issues/retry-send-lost-under-job-marker.md` - a dated note: Stage 1 landed the core it will adopt; nothing else.
- `docs/issues/accepted-send-lost-when-append-fails.md` - piece 1 built: `SendAcceptedNotRecordedError` carries the SID and the fan-outs hand it to reconcile, which adopts it; the non-adopting callers (Stage 2 sites) still lose it; cite.
- `docs/issues/exactly-once-send-intent.md` - substantially built by the send-attempt record (the claim-before-send, the fence, the takeover); what remains is the sweeper and the Stage 2 sites; cite.

- [ ] **Step 1: Write the sections; run `npm run issues` (regenerates the gitignored INDEX; must exit 0).**
- [ ] **Step 2: Commit**

```bash
git status
git add docs/issues/fanout-close-path-robustness-residues.md docs/issues/fanout-pass-setup-throw-strands-pass.md docs/issues/relay-continuation-early-return-strands-slots.md docs/issues/manual-retry-double-send-residual-windows.md docs/issues/send-attempt-sweeper.md docs/issues/throw-for-redelivery-defeated-by-job-marker.md docs/issues/retry-send-lost-under-job-marker.md docs/issues/accepted-send-lost-when-append-fails.md docs/issues/exactly-once-send-intent.md
git commit -m "docs(issues): record the residues this branch leaves and the record shapes the sweeper will read" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 16: Live self-QA on a hermetic lane (the profile's harness)

- [ ] **Step 1:** `npm run e2e:session` on a FRESH lane (the `childEnv` seam must be picked up), dev-login, reseed `lean`.
- [ ] **Step 2:** Drive four scenarios by hand with the Playwright MCP and the fake's control routes; record them in `docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/self-qa.md` (screenshots under `.playwright-mcp/`):
  - relay `accept_then_drop`: after the reveal click, the affected member's row reads `Delivered` within the lane's delays; the fake's thread shows ONE outbound to that member; the worker log has one `send_reconcile` INFO `found`.
  - broadcast `drop_before_create`: `Delivered` reaches the audience; `Not confirmed` 0; the pill `Sent`; ONE outbound in the fake.
  - broadcast `drop_before_create` + `fail-list` x3: the row reads `Not confirmed - Couldn't confirm whether this text went out`, the `Not confirmed` chip 1, no `open conversation to retry` hint, the pill `Failed` with the prose alert when it was the only recipient; exactly one ERROR line in the worker log.
  - a relay leg left `queued` with `attemptedAt` and no `sentAt`: seed it through the hermetic message-fixture seam (`routes/dev.ts` message fixture; `plan-send-sites-findings.md` D3 "Dev seams") with a WALL-CLOCK `attemptedAt` 16 minutes in the past (the lane pins no clock; the dashboard's staleness budget is wall-clock); the row reads `Queued - not confirmed` immediately.
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
- [ ] **Step 3: Handback** at `.superpowers/sdd/handback.md` AND committed as `docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/handback.md`: the work map with commits; a per-decision conformance table (D1-D23 incl. D3a, D7a, D8a, D13a, D16a, D20a, and Sec 2a's RSW #1/#5/#6/#7); the quoted gate exit codes and counts; the self-QA pointer; reviewer findings and adjudications from the orchestrator's own review; the drift list; the residues Sec 1 records with their issue links; the FOUR declared deviations from the spec's wording (this plan's header); post-merge obligations: NONE infra; the human sets `throw-for-redelivery-defeated-by-job-marker` resolved at merge; Stage 1b (the `retrySend` adoption) is the next worktree; the first hosted-dev run verifies the list walk's order and page bound and the prod service's Smart Encoding (Sec 10). State explicitly: UNMERGED (human gate).

---

## Self-review (planner, against spec revision 11) - coverage by NAMED test

| spec | task(s) | proof |
|---|---|---|
| D1, D2 | T1 | `classifySendFailure` describe (10 tests incl. Review Focus 1, code 0) |
| D3, D3a | T3; T7/T8 (the arms) | `typed send errors` describe (6); T7 tests 2, 5a, 5b; T8 case 6 |
| D4 | T1 | "fires send_throttled on a real 20429 and not on ECONNREFUSED" |
| D5, D6 | T7 tests 4d, 10, 13; T8 cases 5, 17 + the retryable arm | |
| D7, D7a | T7 tests 1, 3, 3b, 3c, 5a, 5b, 5c; T8 cases 1, 6, 7, 13, 15; T9 handed / sent_unrecorded / stranded arms; T5 `guardWrite` | |
| D8 | T7 tests 8, 9c, 9d, 11; T8 cases 4, 11, 14, 16; T9 refuseGate / window-close gates (foreign open, done/sent, stale takeover) | |
| D8a | T5 integration (11, one owner per case); T7 tests 7a, 7b; T8 case 2; T6 `setRelayRecipientAttemptedAt` | |
| D9 | T7 tests 4a-4e; T8 cases 7, 8 | |
| D10 | T1 constants; T13 mirror; T7 test 13 (no HTTP status on a slot) | |
| D11 | T5 transitions; T10 cases 14, 14b; T10 integration | |
| D12 | T2 digest/hash/safe; T7 test 12; T10 cases 13, 21 | |
| D13 | T10 cases 5, 5b, 5c, 5d, 5e, 6, 7, 8, 9, 10, 12, 13b, 15c | |
| D13a | T7 tests 9a, 9b; T8 cases 9, 10; T10 cases 4, 18, 20 | |
| D14 | recorded, not built (Sec 1 residue; T15 files the shapes and the relay strand) | |
| D15 | T10 cases 1, 2, 3, 16; T10 integration; T6 `adoptRelayRecipientIfUnsent` (legacy forward-only + versioned + the legacy_noop discriminator) | |
| D16 | T10 cases 11, 15, 15b, 17, 19 | |
| D16a | T6 `finalizeStatus`; T7 finalize tests (N callers; Review Focus 5; stale counter; ordering un-skipped in T10) | |
| D17 | T4 driver tests (+ the page-size WARN on a SMALLER provider page); deviation 1 | |
| D18 | T10 case 21; T7 test 12; log assertions in T10 cases 12, 16 | |
| D19 | T11 fake tests (incl. fail-list); T12 specs 1-4; T16 | |
| D20, D20a, D21, D23 | T13 describes + Timeline three-position + ticker ARMING + join + mirror | |
| D22 | T6 derive + T14 chip/order/badge/hint/seeds | |
| Sec 2a RSW #1/#5/#6/#7 | T9 window-gate on a re-driven rung; deadline pins; foreign-attempt skip; T13 join keeps both codes | |
| Sec 8 e2e | T12 specs 1-4 | |
| Sec 9 | T15 (nine files) | |

Placeholder scan: every test sketch names its expectation and its seam; none says "add tests", "similar to" or "as in revision N". Type consistency: `AttemptRef`, `SendAttemptOwner`, `SendAttemptOwnerRef`, `ClaimResult`, `RelayLegSendOutcome`, `SendReconcilePayload`, `guardWrite`, `gateFor`'s three results, the outcome kinds and the code constants are defined once (the shared block, T5, T7) and used by name in T5-T10, T13-T14. Review Focus: RF1 T1; RF2 T10 case 13; RF3 T7 test 2; RF4 T10 case 13b; RF5 T7 finalize test.
