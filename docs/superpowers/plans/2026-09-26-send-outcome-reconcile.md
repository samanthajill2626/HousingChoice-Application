# Send-Outcome Classification and Reconcile - Implementation Plan (Stage 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the throw-for-redelivery in both fan-outs and the relay retry rung with a classified send outcome, a per-recipient send-attempt record claimed before every provider call, and a `send.reconcile` job that resolves an ambiguous send by looking the message up at the provider - so every attempted recipient reaches a terminal state and nobody is ever texted twice.

**Architecture:** A pure classifier at the send boundary sorts a provider failure into `rejected` / `retryable` / `unknown`; `sendMessage` throws typed errors that carry the reconcile facts. A new `sendAttemptsRepo` keeps per-owner-per-recipient records (plus a recipient-keyed index) in the messages table, with every transition a conditional write keyed on the attempt. The send sites split each recipient into PREPARE / SEND / RECORD phases, claim the record before the provider call, and hand `unknown` outcomes to a `send.reconcile` job (no run-once marker; at-least-once enqueues; idempotent writes) whose per-owner handlers adopt, re-drive once, or close `unresolved`. The dashboard presents `send_unconfirmed` by code alone as "Not confirmed".

**Tech Stack:** TypeScript (Node 24, ESM), Express, DynamoDB (`@aws-sdk/lib-dynamodb`, DynamoDB Local for integration tests), twilio-node 6.0.2, Vitest, React 19 dashboard, Playwright e2e harness with the in-repo fake-twilio.

**Spec:** `docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md` (revision 9 @6ba1a78c). The plan argues from the spec; executors read both. Decision numbers below (D1, D8a, ...) are the spec's.

**Branch / worktree:** `feat/send-outcome-reconcile` at `W:\tmp\send-outcome-reconcile`, HEAD a9f411f3 merged with `main` @bd752bd0 (RSW and share-skip-fix Branch A included). This branch's ONE main sync is already done; Task 17 reports later drift, it does not re-merge.

**Research maps the tasks cite:** findings (tracked) in
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/research/plan-*-findings.md`;
byte-exact references (gitignored, worktree-local) in
`.superpowers/sdd/plan-send-sites-reference.md`, `plan-data-layer-reference.md`,
`plan-dashboard-reference.md`. Line numbers in this plan are at a9f411f3; re-derive
by reading before editing.

## Global Constraints

- ASCII-only in every line this branch ADDS or TOUCHES (code, comments, tests, docs, log strings). `broadcastFanOut.ts`, `relayFanOut.ts` and `sendMessage.ts` carry pre-existing U+2014 log strings; a touched log line is re-worded in ASCII (no test matches an em-dash string). Verify a file with `tr -d '\11\12\15\40-\176' < FILE | wc -c` only on NEW files; on pre-existing files check the diff's added lines.
- Never edit `app/src/routes/webhooks/twilio.ts` (fenced), `app/src/jobs/jobs.ts` (incl. `MAX_HOP_COUNT` 10), `app/src/adapters/sqsJobConsumer.ts`, or the run-once marker. Never edit `app/src/jobs/retrySend.ts` (its FILE is unchanged on this branch; its behavior changes only through D3's typed errors, which it rethrows as before).
- `SendRefusedError` and every subclass are never wrapped (D3). No new refusal code (a new code would force a row in `routes/api.ts:173 REFUSAL_STATUS`). No new `sendMessage` gate, so `app/test/helpers/sendRefusalCases.ts` gets no row.
- No new slot STATUS values (D10). Slot codes this branch writes: `send_unconfirmed`, `send_retryable`, `enqueue_failed`, `redrive_refused`, `sms_sending_disabled`, the provider's own rejection codes. Pending states live on the attempt record, never on a slot.
- Every coordination read is a strongly consistent primary-key read or Query on the base table; no GSI anywhere in the coordination path (D11).
- Classifier precedence (D1): a code the arms already recognise classifies by code whatever the status - `30007`, `30005`, `30006` are `rejected`; `429`, `30022` are `retryable`; then HTTP 5xx -> `unknown`; HTTP 4xx (not 429/20429) -> `rejected`; 429/20429 -> `retryable`; ENOTFOUND/ECONNREFUSED/EAI_AGAIN -> `retryable`; ECONNABORTED/ETIMEDOUT/ECONNRESET/EPIPE and anything else -> `unknown` (D2).
- Claim placement (D7a): relay unit claims AFTER the bounded token acquire and BEFORE the presign; broadcast pass claims immediately before `sendMessage`, after its fences.
- Claim TTL = `SEND_CLAIM_TTL_MS` = 30_000, the same constant the Twilio driver now passes as its request timeout (D8a).
- Reconcile: three checks at 5 s, 30 s, 240 s after the attempt (lane-overridable only when `JOBS_QUEUE_URL` is unset); window opens 60 s before the attempt start; list page size 1000, at most 5 pages; one re-drive per recipient; worst-case chain depth 8 of 10 hops (D13, D13a).
- Body matching uses the lossy normalization (Unicode NFKC, then letters and digits only); a normalized body shorter than 3 characters matches on media count instead (D13).
- Dashboard copy (D20-D23, exact): `send_unconfirmed` -> label `Not confirmed`, tone `danger`, `isFailure: false`, reason `Couldn't confirm whether this text went out` (no trailing period); `redrive_refused` -> `Wasn't resent: the group closed or the member left`; `sms_sending_disabled` -> `SMS sending is switched off, so nothing was sent`; `transient_cap` -> `Sending gave up after repeated temporary errors`; broadcast chip label `Not confirmed`; `last_error` for an all-unconfirmed share `Couldn't confirm any text went out`.
- The `unconfirmed` stats bucket is OPTIONAL in both `BroadcastStats` types, read as `?? 0`, its own chip in the audience sum, never part of `skippedTotal` (D22).
- E2E must never use the lean seed's switched-off tenant `contact-tenant-0002` / `conv-0002` as a recipient of anything automated (Sec 2a).
- Gates are run BARE, never piped, from the worktree: `npm run typecheck`, `npm test`, `npm run smoke`, `npm run e2e` (under `timeout 1500`), and `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` with an empty list SKIPPED. `npm test` needs DynamoDB Local (`npm run db:start`).
- Commit discipline: bare `git status` before every commit, check `.git/MERGE_HEAD` is absent, stage EXPLICIT paths, never `git add -A`; every commit ends with `Co-Authored-By: <the authoring model> <noreply@anthropic.com>`.
- Never merge to `main`, deploy, push secrets, run terraform, or clean up the worktree.

## Review Focus

Input classes the spec implies but no task's tests would otherwise exercise, most likely to bite first; each has a test added to the owning task below:

1. A Twilio `RestException` with `status: 400` and NO code (body unparseable) - must classify `rejected`, not `unknown` (Task 1).
2. A relay member whose phone number changed between the claim and the reconcile - the lookup must rule `unresolved`, never re-send to the new number (Task 9).
3. A `SendRefusedError` thrown by `sendMessage` for a recipient the broadcast pass has already CLAIMED (manual-mode flip mid-pass) - the record must close `done` / `refused`, the slot as today, no reconcile (Task 6).
4. A reconcile check that lists a candidate created 59 seconds BEFORE the attempt start (clock skew) - inside the 60 s lead, must be considered (Task 9).
5. A broadcast whose recipients are all `skipped` plus one `unconfirmed` - finalize must read `failed` with the prose `last_error`, not `sent` (Task 6).

---

## Work map (task order; slices are stoppable between)

- **Slice A - foundations, no behavior change:** T1 classifier + throttle marker; T2 fingerprint/digest helpers; T3 `sendMessage` typed errors; T4 adapter port `listMessages`/`getMessage` + driver timeout; T5 send-attempt record repo; T6 repo additions (conditional slot writes, consistent reads, SID claim, finalize flip, `unconfirmed` counter).
- **Slice B - the send sites:** T7 broadcast fan-out; T8 relay leg + fan-out loop; T9 relay retry rung.
- **Slice C - the reconcile job:** T10 `send.reconcile` (lookup + verdicts + owner handlers + registration).
- **Slice D - fake-twilio + e2e:** T11 fake routes and seam; T12 lane seams + e2e specs.
- **Slice E - dashboard:** T13 codes, copy, aging, join; T14 broadcast bucket, chip, badge, seeds.
- **Slice F - records, issues, gates:** T15 issue updates; T16 self-QA; T17 gates + handback.

Interfaces every task must agree on are stated once here and repeated in each task's Interfaces block.

### Shared interfaces (canonical)

```ts
// app/src/lib/sendOutcome.ts  (Task 1)
export type SendFailureKind = 'rejected' | 'retryable' | 'unknown';
export interface SendFailureClassification {
  kind: SendFailureKind;
  /** Provider code when present (e.g. '21211', '20429'), else the network code ('ECONNRESET'), else undefined. */
  code?: string;
  /** HTTP status when the error carried one. */
  status?: number;
}
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
export function hashRecipientKey(recipientKey: string): string;

// app/src/services/sendMessage.ts  (Task 3)
export class SendNotAttemptedError extends Error { constructor(message: string, readonly cause: unknown) }
export class ProviderSendFailedError extends Error {
  constructor(args: { classification: SendFailureClassification; cause: unknown; facts: SendAttemptFacts; attemptedAt: string });
  readonly classification: SendFailureClassification; readonly cause: unknown; readonly facts: SendAttemptFacts; readonly attemptedAt: string;
}
export class SendAcceptedNotRecordedError extends Error {
  constructor(args: { providerSid: string; providerTs: string; status: DeliveryStatus; cause: unknown; facts: SendAttemptFacts });
  readonly providerSid: string; readonly providerTs: string; readonly status: DeliveryStatus; readonly cause: unknown; readonly facts: SendAttemptFacts;
}

// app/src/adapters/messaging.ts  (Task 4)
export interface ProviderMessageSummary {
  providerSid: string;
  /** The provider's raw status string ('accepted', 'queued', 'sent', 'delivered', 'undelivered', 'failed', ...). */
  providerStatus: string;
  errorCode?: string;
  body: string;
  mediaCount: number;
  createdAt: string;   // ISO
  sentAt?: string;     // ISO
}
export interface ListMessagesArgs { to: string; from: string; pageSize: number; pageToken?: string; }
export interface ListMessagesPage { messages: ProviderMessageSummary[]; nextPageToken?: string; }
// added to MessagingAdapter:
listMessages(args: ListMessagesArgs): Promise<ListMessagesPage>;
getMessage(providerSid: string): Promise<ProviderMessageSummary | undefined>;
export const TWILIO_REQUEST_TIMEOUT_MS = SEND_CLAIM_TTL_MS;

// app/src/repos/sendAttemptsRepo.ts  (Task 5)
export type SendAttemptOwner =
  | { kind: 'broadcast'; broadcastId: string; contactKey: string }
  | { kind: 'relay_leg'; relayConversationId: string; sourceTsMsgId: string; memberKey: string }
  | { kind: 'relay_rung'; relayConversationId: string; retryTsMsgId: string; memberKey: string };
export type SendAttemptState = 'attempting' | 'reconciling' | 'redriven' | 'done';
export type SendAttemptOutcome =
  | 'sent' | 'rejected' | 'retryable' | 'refused' | 'adopted' | 'never_sent'
  | 'unresolved' | 'enqueue_failed' | 'redrive_refused';
export interface SendAttemptFacts {
  recipientDigest: string;
  sender?: string;
  bodyHash: string;
  bodyShort: boolean;
  mediaCount: number;
}
export interface SendAttemptRecord extends SendAttemptFacts {
  owner: SendAttemptOwner;
  state: SendAttemptState;
  attemptNo: number;
  attemptedAt: string;
  redriveCount: number;
  checkNo: number;
  sid?: string;
  outcome?: SendAttemptOutcome;
  cause?: string;
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
  closeRedriven(owner: SendAttemptOwner, result: { outcome: 'refused' | 'redrive_refused'; cause?: string }): Promise<boolean>;
  get(owner: SendAttemptOwner): Promise<SendAttemptRecord | undefined>;
  listByRecipient(sender: string, recipientDigest: string, sinceIso: string): Promise<SendAttemptRecord[]>;
}
export function ownerKey(owner: SendAttemptOwner): string;
export function createSendAttemptsRepo(deps?: RepoDeps): SendAttemptsRepo;

// app/src/jobs/sendReconcile.ts  (Task 10)
export const SEND_RECONCILE_JOB = 'send.reconcile';
export interface SendReconcilePayload {
  owner: SendAttemptOwner;
  attemptedAt: string;
  checkNo: number;            // 0 = first check
  continuation?: { senderKey: string; senderNameOverride?: string };  // relay_leg re-drive context
}
export async function enqueueSendReconcile(payload: SendReconcilePayload, delayMs: number): Promise<void>;
export function reconcileCheckDelaysMs(): readonly number[];   // lane-overridable
```

Re-drive marker on the three continuation payloads (Tasks 7-9): `redrive?: true`, carried by each parser.

---

## Slice A - foundations

### Task 1: The send-failure classifier and the widened throttle marker

**Files:**
- Create: `app/src/lib/sendOutcome.ts`
- Create: `app/test/sendOutcome.test.ts`
- Modify: `app/src/adapters/messaging.ts:543` (`SEND_THROTTLE_CODES`) and `:546-555` (`providerErrorCode` stays; the marker's set widens)
- Test: `app/test/messaging.test.ts` (add one case)

**Interfaces:**
- Consumes: nothing.
- Produces: everything under `app/src/lib/sendOutcome.ts` in the shared interfaces block.

- [ ] **Step 1: Write the failing classifier tests**

```ts
// app/test/sendOutcome.test.ts
import { describe, expect, it } from 'vitest';
import { classifySendFailure } from '../src/lib/sendOutcome.js';

function restException(status: number, code?: number | string, message = 'x'): Error {
  return Object.assign(new Error(message), { status, ...(code !== undefined && { code }) });
}
function axiosError(code: string): Error {
  return Object.assign(new Error(code), { code, isAxiosError: true });
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
    expect(classifySendFailure(restException(400))).toMatchObject({ kind: 'rejected', status: 400 });
    expect(classifySendFailure(restException(400)).code).toBeUndefined();
  });
  it('a connection that never opened is retryable', () => {
    for (const c of ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']) {
      expect(classifySendFailure(axiosError(c))).toMatchObject({ kind: 'retryable', code: c });
    }
  });
  it('a timeout or a dropped socket is unknown', () => {
    for (const c of ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE']) {
      expect(classifySendFailure(axiosError(c))).toMatchObject({ kind: 'unknown', code: c });
    }
  });
  it('anything it cannot place is unknown (D2), with no code', () => {
    expect(classifySendFailure(new Error('boom'))).toEqual({ kind: 'unknown' });
    expect(classifySendFailure(undefined)).toEqual({ kind: 'unknown' });
    expect(classifySendFailure('string')).toEqual({ kind: 'unknown' });
  });
  it('the adapter-level kill switch is rejected with the sms_sending_disabled token', async () => {
    const { SmsSendingDisabledError } = await import('../src/adapters/messaging.js');
    expect(classifySendFailure(new SmsSendingDisabledError('off'))).toEqual({ kind: 'rejected', code: 'sms_sending_disabled' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app; npx vitest run test/sendOutcome.test.ts`
Expected: FAIL - `Cannot find module '../src/lib/sendOutcome.js'`.

- [ ] **Step 3: Write the classifier**

```ts
// app/src/lib/sendOutcome.ts
// Send-outcome vocabulary (spec 2026-09-24-send-outcome-reconcile-design, D1-D2,
// D10, D13a). Pure: no I/O, no logging. The classifier reads BOTH the HTTP
// status and the code twilio-node attaches to a RestException, with one
// precedence rule: a code the send sites already recognise classifies by code
// whatever the status says or omits, so the existing arms keep their behavior
// and their status-less test fixtures.
import { SmsSendingDisabledError as AdapterSmsSendingDisabledError } from '../adapters/messaging.js';

export type SendFailureKind = 'rejected' | 'retryable' | 'unknown';

export interface SendFailureClassification {
  kind: SendFailureKind;
  code?: string;
  status?: number;
}

/** Slot codes this branch writes (D10). Dashboard mirrors are pinned by tests. */
export const SEND_UNCONFIRMED_CODE = 'send_unconfirmed';
export const SEND_RETRYABLE_CODE = 'send_retryable';
export const REDRIVE_REFUSED_CODE = 'redrive_refused';
export const SMS_SENDING_DISABLED_CODE = 'sms_sending_disabled';
export const TRANSIENT_CAP_CODE = 'transient_cap';
export const ENQUEUE_FAILED_CODE = 'enqueue_failed';

/** D8a: the claim TTL equals the provider request timeout the driver now pins. */
export const SEND_CLAIM_TTL_MS = 30_000;
/** D13a: three checks, the first no sooner than 5 s (the list lag). */
export const RECONCILE_CHECK_DELAYS_MS: readonly number[] = [5_000, 30_000, 240_000];
/** D13: the window opens this long before the attempt start (skew + 1 s resolution). */
export const RECONCILE_WINDOW_LEAD_MS = 60_000;
export const RECONCILE_LIST_PAGE_SIZE = 1000;
export const RECONCILE_MAX_PAGES = 5;
/** D9: consecutive unknown outcomes that end a pass early. */
export const OUTAGE_BRAKE_UNKNOWN_STREAK = 3;

/** Codes the fan-outs' existing arms own; they classify by code alone (D1). */
const KNOWN_REJECTED_CODES = new Set(['30007', '30005', '30006']);
const KNOWN_RETRYABLE_CODES = new Set(['429', '30022', '20429']);
const NETWORK_RETRYABLE = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']);

function codeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'number') return String(code);
  if (typeof code === 'string' && code.length > 0) return code;
  return undefined;
}

function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

export function classifySendFailure(err: unknown): SendFailureClassification {
  if (err instanceof AdapterSmsSendingDisabledError) {
    return { kind: 'rejected', code: SMS_SENDING_DISABLED_CODE };
  }
  const code = codeOf(err);
  const status = statusOf(err);
  const withMeta = (kind: SendFailureKind): SendFailureClassification => ({
    kind,
    ...(code !== undefined && { code }),
    ...(status !== undefined && { status }),
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

- [ ] **Step 4: Run the classifier tests**

Run: `cd app; npx vitest run test/sendOutcome.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Widen the throttle marker (D4) with a failing test first**

In `app/test/messaging.test.ts`, next to the existing `send_throttled` case (grep `send_throttled`), add:

```ts
it('fires the send_throttled marker on a real Twilio 20429 and not on ECONNREFUSED (D4)', async () => {
  const capture = createLogCapture();
  const mk = (err: unknown) =>
    new TwilioMessagingDriver({
      accountSid: 'AC1', apiKeySid: 'SK1', apiKeySecret: 's', messagingServiceSid: 'MG1', appEnv: 'test',
      logger: createLogger({ destination: capture.stream }),
      client: { messages: { create: async () => { throw err; } } } as never,
    });
  await expect(mk(Object.assign(new Error('rate'), { status: 429, code: 20429 })).sendMessage({ to: '+15550001111', body: 'x' })).rejects.toThrow('rate');
  await expect(mk(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })).sendMessage({ to: '+15550001111', body: 'x' })).rejects.toThrow('refused');
  const throttled = capture.lines.filter((l) => l.includes('"event":"send_throttled"'));
  expect(throttled).toHaveLength(1);
  expect(throttled[0]).toContain('"errorCode":"20429"');
});
```

Run: `cd app; npx vitest run test/messaging.test.ts -t "send_throttled marker on a real"`
Expected: FAIL - zero throttled lines.

- [ ] **Step 6: Widen the set**

In `app/src/adapters/messaging.ts:543` change
`const SEND_THROTTLE_CODES = new Set(['429', '30022']);` to
`const SEND_THROTTLE_CODES = new Set(['429', '20429', '30022']);` and extend its
doc comment: "20429 is the code twilio-node attaches to a real HTTP 429 (a
RestException carries `code` = Twilio code, `status` = HTTP status); the bare
`429` stays for the status-only fixtures."

Run: `cd app; npx vitest run test/messaging.test.ts test/sendOutcome.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git status
git add app/src/lib/sendOutcome.ts app/test/sendOutcome.test.ts app/src/adapters/messaging.ts app/test/messaging.test.ts
git commit -m "feat(send): classify provider send failures (rejected / retryable / unknown); count 20429 as a throttle" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 2: Fingerprint and digest helpers

**Files:**
- Create: `app/src/lib/sendFingerprint.ts`
- Create: `app/test/sendFingerprint.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeBodyForMatch`, `bodyFingerprint`, `recipientDigest`, `hashRecipientKey` (shared block).

- [ ] **Step 1: Write the failing tests, using the spike's exact strings**

```ts
// app/test/sendFingerprint.test.ts
import { describe, expect, it } from 'vitest';
import { bodyFingerprint, hashRecipientKey, normalizeBodyForMatch, recipientDigest } from '../src/lib/sendFingerprint.js';

describe('normalizeBodyForMatch (spec D13, Smart Encoding)', () => {
  const submitted = 'HC spike B ’quote’ dash—dash more… ignore';
  const stored = "HC spike B 'quote' dash-dash more... ignore";   // what the 2026-09-24 spike read back
  it('makes the submitted and the Smart-Encoded stored body equal', () => {
    expect(normalizeBodyForMatch(submitted)).toBe(normalizeBodyForMatch(stored));
    expect(bodyFingerprint(submitted).hash).toBe(bodyFingerprint(stored).hash);
  });
  it('keeps letters and digits only, NFKC first', () => {
    expect(normalizeBodyForMatch('ＨＣ 42!')).toBe('HC42');
    expect(normalizeBodyForMatch(undefined)).toBe('');
  });
  it('flags a body under three normalized characters as short', () => {
    expect(bodyFingerprint('👍').short).toBe(true);
    expect(bodyFingerprint('ok').short).toBe(true);
    expect(bodyFingerprint('yes').short).toBe(false);
  });
  it('a STOP auto-reply never matches a share body', () => {
    expect(bodyFingerprint('You have successfully been unsubscribed. Reply START to resubscribe.').hash)
      .not.toBe(bodyFingerprint('Hey Cameron, looking for a 1BR? 12 Main St is available.').hash);
  });
});

describe('recipientDigest / hashRecipientKey', () => {
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
  });
});
```

Run: `cd app; npx vitest run test/sendFingerprint.test.ts` -> FAIL (module missing).

- [ ] **Step 2: Implement**

```ts
// app/src/lib/sendFingerprint.ts
// Spec D12/D13: the facts a reconcile matches on. LOSSY on purpose - the
// Messaging Service has Smart Encoding on, and the 2026-09-24 spike showed the
// STORED body of a message with a curly quote, an em dash or an ellipsis comes
// back as ', - and ..., so an exact comparison would rule a real orphan
// "never sent" and re-send it.
import { createHash } from 'node:crypto';

/** Unicode NFKC, then letters and digits only (any script). */
export function normalizeBodyForMatch(body: string | undefined): string {
  if (body === undefined) return '';
  return body.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
}

export interface BodyFingerprint {
  /** sha256 hex of the normalized body. */
  hash: string;
  /** Fewer than 3 normalized characters: match on media count instead (D13). */
  short: boolean;
}

export function bodyFingerprint(body: string | undefined): BodyFingerprint {
  const normalized = normalizeBodyForMatch(body);
  return {
    hash: createHash('sha256').update(normalized).digest('hex'),
    short: normalized.length < 3,
  };
}

/** Owner-independent, keyed on the sender (D12): the same digest keys the recipient index (D8a). */
export function recipientDigest(sender: string | undefined, destinationE164: string): string {
  return createHash('sha256').update(`${sender ?? ''}|${destinationE164}`).digest('hex').slice(0, 32);
}

/** A recipient key that carries a phone is hashed before it lands in a key (D8a; relayRetryClaim precedent). */
export function hashRecipientKey(recipientKey: string): string {
  if (!recipientKey.startsWith('phone#')) return recipientKey;
  return `phonehash#${createHash('sha256').update(recipientKey).digest('hex').slice(0, 32)}`;
}
```

Run: `cd app; npx vitest run test/sendFingerprint.test.ts` -> PASS.

- [ ] **Step 3: Commit**

```powershell
git status
git add app/src/lib/sendFingerprint.ts app/test/sendFingerprint.test.ts
git commit -m "feat(send): lossy body fingerprint and owner-independent recipient digest for reconcile matching" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 3: Typed errors from `sendMessage` (D3)

**Files:**
- Modify: `app/src/services/sendMessage.ts` (errors block after `:191`; steps at `:332`, `:361`, `:431-439`, `:465-475`, `:479-519`, `:523-539`)
- Test: `app/test/sendMessage.test.ts` (extend `makeFakes` overrides at `:57-66` and add cases)

**Interfaces:**
- Consumes: `classifySendFailure`, `SendFailureClassification` (Task 1); `bodyFingerprint`, `recipientDigest` (Task 2); `SendAttemptFacts` shape (Task 5 defines the type; this task declares a structurally identical local type and Task 5 re-exports it - see Step 3).
- Produces: `SendNotAttemptedError`, `ProviderSendFailedError`, `SendAcceptedNotRecordedError` (shared block); the post-append swallow.

- [ ] **Step 1: Extend the fixture seams**

In `app/test/sendMessage.test.ts` `makeFakes` overrides (`:57-66`) add
`getByIdError?: unknown; findByPhoneError?: unknown; incrementError?: unknown; appendError?: unknown; touchError?: unknown; auditError?: unknown;`
and throw them at the matching fake methods (`conversationsRepo.getById` :104-200 area, `contactsRepo.findByPhone` :201-232, `incrementAutomatedSendCount`, `messagesRepo.append` :234-237, `touchLastActivity` :125-130, `auditRepo.append` :312-317). Each fake: `if (overrides.xError !== undefined) throw overrides.xError;` before its normal body.

- [ ] **Step 2: Write the failing tests**

```ts
describe('typed send errors (spec D3)', () => {
  const base = { conversationId: 'conv-1', body: 'Hey there' };
  it('a DB failure before the provider call is SendNotAttemptedError and sends nothing', async () => {
    const f = makeFakes({ findByPhoneError: new Error('dynamo down') });
    await expect(f.service(base)).rejects.toBeInstanceOf(SendNotAttemptedError);
    expect(f.sent).toHaveLength(0);
  });
  it('a refusal is NEVER wrapped', async () => {
    const f = makeFakes({ contact: { ...LIVE, sms_opt_out: true } });
    await expect(f.service(base)).rejects.toBeInstanceOf(SendRefusedError);
  });
  it('a provider throw becomes ProviderSendFailedError carrying the classification, the cause message and the facts', async () => {
    const f = makeFakes({ sendError: Object.assign(new Error('provider unavailable'), { status: 503, code: 20500 }) });
    const err = await f.service(base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderSendFailedError);
    const typed = err as ProviderSendFailedError;
    expect(typed.message).toContain('provider unavailable');
    expect(typed.classification).toMatchObject({ kind: 'unknown', code: '20500', status: 503 });
    expect(typed.facts.bodyHash).toBe(bodyFingerprint('Hey there').hash);
    expect(typed.facts.mediaCount).toBe(0);
    expect(typed.facts.recipientDigest).toBe(recipientDigest(f.env.BUSINESS_PHONE_NUMBER, '+15550001111'));
    expect(Date.parse(typed.attemptedAt)).not.toBeNaN();
    expect(f.appended).toHaveLength(0);
  });
  it('an append failure after acceptance is SendAcceptedNotRecordedError with the SID', async () => {
    const f = makeFakes({ appendError: new Error('TransactionInProgressException') });
    const err = await f.service(base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendAcceptedNotRecordedError);
    expect((err as SendAcceptedNotRecordedError).providerSid).toBe(f.sent[0]!.sid);
    expect((err as SendAcceptedNotRecordedError).status).toBe('sent');
  });
  it('a failure after the row is written does NOT throw: ERROR logged, conversation.updated skipped', async () => {
    const f = makeFakes({ touchError: new Error('touch down') });
    const outcome = await f.service(base);
    expect(outcome.tsMsgId).toBeDefined();
    expect(f.emitted.map((e) => e.event)).toEqual(['message.persisted']);
    expect(f.capture.atLevel('error').some((l) => l.includes('post-append step failed'))).toBe(true);
  });
  it('an audit failure after the row is written does NOT throw either', async () => {
    const f = makeFakes({ auditError: new Error('audit down') });
    await expect(f.service(base)).resolves.toMatchObject({ conversationId: 'conv-1' });
  });
});
```

(`LIVE` is the existing live-contact fixture in that file; the existing
`rejects.toThrow('provider unavailable')` pin at `:461-470` stays green because
the wrapper carries the cause's message.)

Run: `cd app; npx vitest run test/sendMessage.test.ts -t "typed send errors"` -> FAIL (classes undefined).

- [ ] **Step 3: Add the error classes and the wrapping**

After the refusal classes (`sendMessage.ts:191`) add:

```ts
/**
 * Spec D3. The three NON-refusal failure classes of a send, typed so an
 * adopter can act on WHERE the send failed. None extends SendRefusedError.
 * `SendAttemptFacts` is structurally the repos/sendAttemptsRepo type; declared
 * here too so this module stays a leaf.
 */
export interface SendAttemptFacts {
  recipientDigest: string;
  sender?: string;
  bodyHash: string;
  bodyShort: boolean;
  mediaCount: number;
}

/** A failure BEFORE the provider call - nothing was sent. Classified retryable. */
export class SendNotAttemptedError extends Error {
  constructor(message: string, readonly cause: unknown) {
    super(message);
    this.name = new.target.name;
  }
}

/** The provider call threw. Carries the D1 kind and the reconcile facts. */
export class ProviderSendFailedError extends Error {
  readonly classification: SendFailureClassification;
  readonly cause: unknown;
  readonly facts: SendAttemptFacts;
  readonly attemptedAt: string;
  constructor(args: { classification: SendFailureClassification; cause: unknown; facts: SendAttemptFacts; attemptedAt: string }) {
    const causeMessage = args.cause instanceof Error ? args.cause.message : String(args.cause);
    super(`provider send failed (${args.classification.kind}): ${causeMessage}`);
    this.name = new.target.name;
    this.classification = args.classification;
    this.cause = args.cause;
    this.facts = args.facts;
    this.attemptedAt = args.attemptedAt;
  }
}

/** Twilio accepted the message and the row write failed - the SID is known. */
export class SendAcceptedNotRecordedError extends Error {
  readonly providerSid: string;
  readonly providerTs: string;
  readonly status: DeliveryStatus;
  readonly cause: unknown;
  readonly facts: SendAttemptFacts;
  constructor(args: { providerSid: string; providerTs: string; status: DeliveryStatus; cause: unknown; facts: SendAttemptFacts }) {
    super(`send accepted by the provider but not recorded (${args.providerSid})`);
    this.name = new.target.name;
    this.providerSid = args.providerSid;
    this.providerTs = args.providerTs;
    this.status = args.status;
    this.cause = args.cause;
    this.facts = args.facts;
  }
}
```

Imports to add at the top: `import { classifySendFailure, type SendFailureClassification } from '../lib/sendOutcome.js';` and `import { bodyFingerprint, recipientDigest } from '../lib/sendFingerprint.js';`.

Then wrap ONLY the non-refusal throw points (every refusal throw stays untouched):

- `:332` `const conversation = await conversations.getById(conversationId);` -> `const conversation = await notAttempted(() => conversations.getById(conversationId), 'conversation read');`
- `:361` `contacts.findByPhone(participantPhone)` -> `notAttempted(() => contacts.findByPhone(participantPhone), 'contact read')`
- `:431` `incrementAutomatedSendCount(...)` -> wrapped the same way; `:433-439` the trip branch's `setMode` and `audit.append` -> wrapped (the `CircuitBreakerOpenError` throw at `:446` stays).
- `:465-474` `classifyMessageTransport` / `prepareMessageSend` -> wrapped.

with this helper inside `createSendMessageService` (above `return async function sendMessage`):

```ts
async function notAttempted<T>(run: () => Promise<T> | T, step: string): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof SendRefusedError) throw err;   // never wrap a refusal (D3)
    throw new SendNotAttemptedError(`send not attempted: ${step} failed`, err);
  }
}
```

Compute the facts right before the provider call (`:475`):

```ts
const facts: SendAttemptFacts = {
  recipientDigest: recipientDigest(sender, participantPhone),
  ...(sender !== undefined && { sender }),
  ...bodyFingerprint(body).hash !== undefined ? {} : {},
  bodyHash: bodyFingerprint(body).hash,
  bodyShort: bodyFingerprint(body).short,
  mediaCount: mediaUrls?.length ?? attachments?.length ?? 0,
};
const attemptedAt = new Date().toISOString();
let result: SendMessageResult;
try {
  result = await adapter.sendPreparedMessage(prepared);
} catch (err) {
  if (err instanceof SendRefusedError) throw err;
  throw new ProviderSendFailedError({ classification: classifySendFailure(err), cause: err, facts, attemptedAt });
}
```

(Compute `bodyFingerprint(body)` once into a local; the line above is written
out only to show the fields.) Wrap the append (`:479-519`):

```ts
let appended: AppendResult;
try {
  appended = await messages.append({ /* unchanged object */ });
} catch (err) {
  throw new SendAcceptedNotRecordedError({ providerSid: result.providerSid, providerTs: result.providerTs, status: result.status, cause: err, facts });
}
```

And the post-append steps (`:523-539`) become best-effort:

```ts
let touched: ConversationItem | undefined;
try {
  touched = await conversations.touchLastActivity(conversationId, body, result.providerTs);
} catch (err) {
  log.error({ err, conversationId, providerSid: result.providerSid, step: 'touchLastActivity' }, 'outbound message sent but a post-append step failed (best-effort)');
}
try {
  await audit.append(`conversations#${conversationId}`, 'message_sent', { providerSid: result.providerSid, automated, author });
} catch (err) {
  log.error({ err, conversationId, providerSid: result.providerSid, step: 'audit' }, 'outbound message sent but a post-append step failed (best-effort)');
}
events.emit('message.persisted', { conversationId, tsMsgId: appended.tsMsgId, direction: 'outbound', deliveryStatus: result.status });
if (touched !== undefined) events.emit('conversation.updated', toConversationUpdatedEvent(touched));
```

Update the docblock at the top of the file's step (4)-(6) comments to say the
steps after the append are best-effort (D3) and that the staff send route now
answers 201 where it answered 500 on such a failure.

- [ ] **Step 4: Run the file, then typecheck**

Run: `cd app; npx vitest run test/sendMessage.test.ts` -> PASS (the parity block `:936-970` still green: no refusal is wrapped).
Run: `npm run typecheck -w @housingchoice/app` -> exit 0.

- [ ] **Step 5: Commit**

```powershell
git status
git add app/src/services/sendMessage.ts app/test/sendMessage.test.ts
git commit -m "feat(send): typed non-refusal errors from sendMessage; post-append failures no longer fail a sent text" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 4: Adapter port - `listMessages` and `getMessage`; the pinned request timeout (D17, D8a)

**Files:**
- Modify: `app/src/adapters/messaging.ts` (`MessagingAdapter` :150-268; `TwilioClientLike` :423-432; driver constructor :623-637; add methods to `TwilioMessagingDriver` and `ConsoleMessagingDriver`)
- Modify the typed adapter fakes so typecheck stays green: `app/test/helpers/twilioWebhookHarness.ts:3766`, `app/test/scheduledSendSuppression.test.ts:355`, `app/test/sendMessage.test.ts:318`, `app/test/tourReminders.test.ts:2579`, `app/test/poolNumbers.test.ts:174,:213`, `app/test/relayWarm.test.ts:59`
- Test: `app/test/messaging.test.ts`

**Interfaces:**
- Consumes: `SEND_CLAIM_TTL_MS` (Task 1).
- Produces: `ProviderMessageSummary`, `ListMessagesArgs`, `ListMessagesPage`, the two port methods, `TWILIO_REQUEST_TIMEOUT_MS` (shared block). The console driver's module-level send log: `export function _consoleSentMessagesForTests(): ProviderMessageSummary[]` and `export function _resetConsoleSentMessagesForTests(): void`.

- [ ] **Step 1: Write the failing driver tests**

```ts
// app/test/messaging.test.ts (new describe)
describe('listMessages / getMessage (spec D17)', () => {
  const twilioDate = 'Fri, 25 Sep 2026 02:50:31 +0000';
  function resource(over: Record<string, unknown>) {
    return { sid: 'SM1', status: 'sent', body: 'hi', num_media: '0', error_code: null, date_created: twilioDate, date_sent: twilioDate, to: '+16175550100', from: '+15550009999', ...over };
  }
  it('lists one page by To and From at the requested page size and returns a next-page token', async () => {
    const pageCalls: unknown[] = [];
    const client = Object.assign((_sid: string) => ({ fetch: async () => { throw new Error('unused'); } }), {
      create: vi.fn(),
      page: async (params: unknown) => {
        pageCalls.push(params);
        return { instances: [resource({ sid: 'SM1' }), resource({ sid: 'SM2', status: 'queued', date_sent: null })], nextPageUrl: 'https://api.twilio.com/next?PageToken=PAabc' };
      },
      getPage: async (_url: string) => ({ instances: [resource({ sid: 'SM3' })], nextPageUrl: undefined }),
    });
    const driver = new TwilioMessagingDriver({ accountSid: 'AC1', apiKeySid: 'SK1', apiKeySecret: 's', messagingServiceSid: 'MG1', appEnv: 'test', client: { messages: client } as never });
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
  it('fetches one message by SID and maps a 404 to undefined', async () => {
    const client = Object.assign((sid: string) => ({
      fetch: async () => { if (sid === 'SMgone') throw Object.assign(new Error('nf'), { status: 404, code: 20404 }); return resource({ sid, error_code: 30003, status: 'undelivered' }); },
    }), { create: vi.fn() });
    const driver = new TwilioMessagingDriver({ accountSid: 'AC1', apiKeySid: 'SK1', apiKeySecret: 's', messagingServiceSid: 'MG1', appEnv: 'test', client: { messages: client } as never });
    expect(await driver.getMessage('SM9')).toMatchObject({ providerSid: 'SM9', providerStatus: 'undelivered', errorCode: '30003' });
    expect(await driver.getMessage('SMgone')).toBeUndefined();
  });
  it('pins the request timeout to SEND_CLAIM_TTL_MS', async () => {
    expect(TWILIO_REQUEST_TIMEOUT_MS).toBe(SEND_CLAIM_TTL_MS);
  });
});
```

Note: twilio-node's `MessageInstance` exposes camelCase (`dateCreated: Date`,
`numMedia: string`, `errorCode: number`); the test's fake returns the RAW
resource shape. Write the driver's mapper to accept BOTH (a `dateCreated` Date
or a `date_created` string), because the SDK `Page.instances` are
`MessageInstance` objects in production - see Step 2's `summarize`.

Run: `cd app; npx vitest run test/messaging.test.ts -t "listMessages"` -> FAIL.

- [ ] **Step 2: Implement the port and both drivers**

Add to `messaging.ts` after `SendMessageResult` (`:99-108`):

```ts
export interface ProviderMessageSummary {
  providerSid: string;
  providerStatus: string;
  errorCode?: string;
  body: string;
  mediaCount: number;
  createdAt: string;
  sentAt?: string;
}
export interface ListMessagesArgs { to: string; from: string; pageSize: number; pageToken?: string; }
export interface ListMessagesPage { messages: ProviderMessageSummary[]; nextPageToken?: string; }
```

Add to `MessagingAdapter`:

```ts
  /**
   * One page of the provider's messages TO a recipient FROM a sender, newest
   * first, at the requested page size (spec D17). The reconcile job walks
   * pages by `pageToken`; the driver filters nothing by date (the provider's
   * date filter is on SEND time - 2026-09-24 spike).
   */
  listMessages(args: ListMessagesArgs): Promise<ListMessagesPage>;
  /** One message by SID, or undefined when the provider has none (404). */
  getMessage(providerSid: string): Promise<ProviderMessageSummary | undefined>;
```

Export `export const TWILIO_REQUEST_TIMEOUT_MS = SEND_CLAIM_TTL_MS;` (import
from `../lib/sendOutcome.js` - `sendOutcome.ts` imports only the
`SmsSendingDisabledError` class from this module; keep that import a
`import type`-free VALUE import of the class and ensure no cycle at module
init: `sendOutcome.ts` uses the class only inside a function, so the cycle is
safe. To be strict, move `SmsSendingDisabledError` to a tiny
`app/src/adapters/messagingErrors.ts` re-exported from `messaging.ts`, and
import it from there in both files.)

Driver constructor: pass `timeout: TWILIO_REQUEST_TIMEOUT_MS` into the twilio
client options (`twilio(sid, secret, { accountSid, timeout, ...httpClient })`).

`TwilioClientLike.messages` gains optional members:
```ts
  messages: {
    create(...): Promise<...>;                                       // unchanged
    page?(params: { to?: string; from?: string; pageSize?: number; pageToken?: string }): Promise<{ instances: unknown[]; nextPageUrl?: string }>;
    getPage?(targetUrl: string): Promise<{ instances: unknown[]; nextPageUrl?: string }>;
  } & Partial<{ (sid: string): { fetch(): Promise<unknown> } }>;
```
(A callable-with-members intersection, the `MessageMediaResource` idiom at `:529-533`.)

Driver methods:

```ts
  async listMessages(args: ListMessagesArgs): Promise<ListMessagesPage> {
    const messages = this.client.messages as unknown as {
      page?: (p: { to: string; from: string; pageSize: number }) => Promise<{ instances: unknown[]; nextPageUrl?: string }>;
      getPage?: (url: string) => Promise<{ instances: unknown[]; nextPageUrl?: string }>;
    };
    if (typeof messages.page !== 'function' || typeof messages.getPage !== 'function') {
      throw new Error('TwilioMessagingDriver: client lacks the messages page API');
    }
    const page = args.pageToken !== undefined
      ? await messages.getPage(args.pageToken)
      : await messages.page({ to: args.to, from: args.from, pageSize: args.pageSize });
    return {
      messages: page.instances.map(summarize),
      ...(page.nextPageUrl !== undefined && page.nextPageUrl !== null && { nextPageToken: page.nextPageUrl }),
    };
  }

  async getMessage(providerSid: string): Promise<ProviderMessageSummary | undefined> {
    if (typeof (this.client as { messages?: unknown }).messages !== 'function') {
      throw new Error('TwilioMessagingDriver: client lacks per-message resources');
    }
    const client = this.client as unknown as { messages(sid: string): { fetch(): Promise<unknown> } };
    try {
      return summarize(await client.messages(providerSid).fetch());
    } catch (err) {
      const e = err as { status?: unknown; code?: unknown };
      if (e.status === 404 || Number(e.code) === 20404) return undefined;
      throw err;
    }
  }
```

with the module-level mapper (accepts SDK instances and raw resources):

```ts
function isoOf(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value === 'string' && value.length > 0) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  return undefined;
}
function summarize(raw: unknown): ProviderMessageSummary {
  const m = raw as Record<string, unknown>;
  const createdAt = isoOf(m['dateCreated'] ?? m['date_created']) ?? new Date(0).toISOString();
  const sentAt = isoOf(m['dateSent'] ?? m['date_sent']);
  const errorCode = m['errorCode'] ?? m['error_code'];
  const numMedia = m['numMedia'] ?? m['num_media'];
  return {
    providerSid: String(m['sid'] ?? ''),
    providerStatus: String(m['status'] ?? ''),
    ...(errorCode !== null && errorCode !== undefined && Number.isFinite(Number(errorCode)) && { errorCode: String(errorCode) }),
    body: typeof m['body'] === 'string' ? m['body'] : '',
    mediaCount: Number.parseInt(String(numMedia ?? '0'), 10) || 0,
    createdAt,
    ...(sentAt !== undefined && { sentAt }),
  };
}
```

Console driver: keep a MODULE-LEVEL array `const consoleSent: ProviderMessageSummary[] = []` (about 18 adapter instances exist per process - data-layer findings MED); `sendPreparedMessage` pushes `{ providerSid, providerStatus: 'sent', body: params.body ?? '', mediaCount: params.mediaUrls?.length ?? 0, createdAt: providerTs, sentAt: providerTs, to, from }` (keep `to`/`from` in a parallel private map for filtering); `listMessages` filters by to/from newest-first and returns one page (no token); `getMessage` looks the SID up. Export `_consoleSentMessagesForTests()` / `_resetConsoleSentMessagesForTests()`.

Typed fakes: add to each listed fake
`listMessages: async () => ({ messages: [] }), getMessage: async () => undefined,`.
The harness fake (`twilioWebhookHarness.ts:3766`) instead answers from
`world.sent` (which records `prepared.params`) so Task 10's unit tests can
list what was sent: map each recorded send to a summary with `createdAt` = the
recorded providerTs and `providerStatus: 'queued'`; expose
`world.providerMessages: ProviderMessageSummary[]` for tests to seed extra
candidates (auto-replies, another owner's orphan).

- [ ] **Step 3: Run and typecheck**

Run: `cd app; npx vitest run test/messaging.test.ts` -> PASS.
Run: `npm run typecheck` -> exit 0 (every typed fake compiles).

- [ ] **Step 4: Commit**

```powershell
git status
git add app/src/adapters/messaging.ts app/src/adapters/messagingErrors.ts app/src/lib/sendOutcome.ts app/test/messaging.test.ts app/test/helpers/twilioWebhookHarness.ts app/test/scheduledSendSuppression.test.ts app/test/sendMessage.test.ts app/test/tourReminders.test.ts app/test/poolNumbers.test.ts app/test/relayWarm.test.ts
git commit -m "feat(adapter): listMessages and getMessage on the messaging port; pin the Twilio request timeout to the claim TTL" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 5: The send-attempt record repo (D8a, D11, D12)

**Files:**
- Create: `app/src/repos/sendAttemptsRepo.ts`
- Create: `app/test/sendAttemptsRepo.integration.test.ts` (DynamoDB Local)
- Modify: `app/src/lib/tables.ts:213-230` (add the two families to the TTL comment list)
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (add `world.sendAttempts: Map<string, SendAttemptRecord>` and `world.sendAttemptsRepo: SendAttemptsRepo` modelling every condition; returned from `createFakeWorld()`)
- Create: `app/test/twilioWebhookHarnessSendAttempts.test.ts` (harness parity: the fake and the real repo agree on a shared table of transitions - the `twilioWebhookHarnessRetryFields.test.ts` idiom)

**Interfaces:**
- Consumes: `hashRecipientKey` (Task 2); `RepoDeps` (`conversationsRepo.ts:530-536`); `getDocumentClient`, `tableName`.
- Produces: everything under `app/src/repos/sendAttemptsRepo.ts` in the shared block, plus `export const SEND_ATTEMPT_PARTITION_PREFIX = 'sendattempt#'`, `export const SEND_ATTEMPT_INDEX_PREFIX = 'sendattemptix#'`, `export const SEND_ATTEMPT_CLEANUP_MS = 30 * 24 * 60 * 60 * 1000`.

**Key shapes (messages table):**
- Record item: `conversationId = 'sendattempt#' + ownerKey(owner)`, `tsMsgId = hashRecipientKey(recipientKey)`, where `ownerKey` is `broadcast#<broadcastId>` | `relay#<conversationId>#<sourceTsMsgId>` | `rung#<conversationId>#<retryTsMsgId>`; attributes `attempt_state` (NOT `state` - reserved word), `attempt_no`, `attempted_at`, `redrive_count`, `check_no`, `sid?`, `outcome?`, `cause?`, `recipient_digest`, `sender?`, `body_hash`, `body_short`, `media_count`, `owner` (the owner object, marshalled as a map), `expires_at` (epoch seconds, now + 30 d).
- Index item: `conversationId = 'sendattemptix#' + sender + '#' + recipientDigest` (sender `'-'` when unset), `tsMsgId = attemptedAt + '#' + ownerKey + '#' + hashedRecipientKey`; attributes `owner`, `body_hash`, `body_short`, `media_count`, `attempted_at`, `expires_at`. Written in the SAME TransactWrite as the record's claim; never updated afterwards (the record is read for state).

- [ ] **Step 1: Write the failing integration tests (the transition table)**

```ts
// app/test/sendAttemptsRepo.integration.test.ts
// (skeleton per plan-data-layer-reference Sec 11: per-file table prefix, ensureTable('messages'), afterAll delete)
import { createSendAttemptsRepo, ownerKey, type SendAttemptOwner } from '../src/repos/sendAttemptsRepo.js';

const owner: SendAttemptOwner = { kind: 'broadcast', broadcastId: 'b-1', contactKey: 'phone#+16175550100' };
const facts = { recipientDigest: 'd'.repeat(32), sender: '+15550009999', bodyHash: 'h'.repeat(64), bodyShort: false, mediaCount: 0 };
const T0 = '2026-09-26T12:00:00.000Z';
const T1 = '2026-09-26T12:00:05.000Z';

describe.skipIf(!reachable)('sendAttemptsRepo (spec D8a/D11)', () => {
  it('creates and claims an absent record; a second claim in the TTL is refused fresh', async () => {
    const first = await repo.claim(owner, facts, T0);
    expect(first).toMatchObject({ outcome: 'claimed', record: { state: 'attempting', attemptNo: 1, attemptedAt: T0, redriveCount: 0, checkNo: 0 } });
    const second = await repo.claim(owner, facts, T1);
    expect(second).toMatchObject({ outcome: 'refused', fresh: true, record: { state: 'attempting' } });
  });
  it('hashes a phone-bearing recipient key into the sort key', async () => {
    await repo.claim(owner, facts, T0);
    const raw = await doc.send(new GetCommand({ TableName: table, Key: { conversationId: `sendattempt#${ownerKey(owner)}`, tsMsgId: 'phone#+16175550100' } }));
    expect(raw.Item).toBeUndefined();
    const hashed = await doc.send(new GetCommand({ TableName: table, Key: { conversationId: `sendattempt#${ownerKey(owner)}`, tsMsgId: hashRecipientKey('phone#+16175550100') } }));
    expect(hashed.Item).toMatchObject({ attempt_state: 'attempting', expires_at: expect.any(Number) });
  });
  it('finishAttempt is fenced on attemptNo and attemptedAt', async () => {
    const c = await repo.claim(owner, facts, T0);
    if (c.outcome !== 'claimed') throw new Error('claim');
    expect(await repo.finishAttempt(owner, { attemptNo: 1, attemptedAt: T1 }, { outcome: 'sent', sid: 'SM1' })).toBe(false);
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
    const again = await repo.claim(owner, facts, T1);
    expect(again).toMatchObject({ outcome: 'claimed', record: { attemptNo: 2, attemptedAt: T1 } });
    await repo.handToReconcile(owner, { attemptNo: 2, attemptedAt: T1 });
    expect(await repo.markRedriven(owner, T1)).toBe(true);
    expect(await repo.markRedriven(owner, T1)).toBe(false);   // redriveCount already 1
    const third = await repo.claim(owner, facts, '2026-09-26T12:01:00.000Z');
    expect(third).toMatchObject({ outcome: 'claimed', record: { attemptNo: 3, redriveCount: 1 } });
  });
  it('a stale attempting record (older than the TTL) is a takeover, not a send', async () => {
    await repo.claim(owner, facts, T0);
    const late = await repo.claim(owner, facts, '2026-09-26T12:00:31.000Z');
    expect(late).toMatchObject({ outcome: 'takeover', record: { state: 'attempting', attemptedAt: T0 } });
    expect(await repo.takeOver(owner, late.record)).toBe(true);
    expect(await repo.get(owner)).toMatchObject({ state: 'reconciling', attemptedAt: T0 });
    // the late outcome write from the original attempt is refused
    expect(await repo.finishAttempt(owner, { attemptNo: 1, attemptedAt: T0 }, { outcome: 'sent', sid: 'SM1' })).toBe(false);
  });
  it('recordCheck tolerates its own duplicate and refuses a skip', async () => {
    await repo.claim(owner, facts, T0);
    await repo.handToReconcile(owner, { attemptNo: 1, attemptedAt: T0 });
    expect(await repo.recordCheck(owner, T0, 1)).toBe(true);
    expect(await repo.recordCheck(owner, T0, 1)).toBe(true);
    expect(await repo.recordCheck(owner, T0, 3)).toBe(false);
    expect(await repo.recordCheck(owner, T1, 2)).toBe(false);  // other attempt
  });
  it('closeFromReconcile and closeRedriven are forward-only and idempotent', async () => {
    await repo.claim(owner, facts, T0);
    await repo.handToReconcile(owner, { attemptNo: 1, attemptedAt: T0 });
    expect(await repo.closeFromReconcile(owner, T0, { outcome: 'unresolved', cause: 'provider_unreachable' })).toBe(true);
    expect(await repo.closeFromReconcile(owner, T0, { outcome: 'adopted', sid: 'SM9' })).toBe(false);
    expect(await repo.get(owner)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'provider_unreachable' });
  });
  it('listByRecipient reads the index partition consistently, newest first, since a bound', async () => {
    const other: SendAttemptOwner = { kind: 'relay_leg', relayConversationId: 'conv-r', sourceTsMsgId: '2026-09-26T11:00:00.000Z#SMx', memberKey: 'contact-9' };
    await repo.claim(owner, facts, T0);
    await repo.claim(other, facts, T1);
    const rows = await repo.listByRecipient('+15550009999', facts.recipientDigest, '2026-09-26T11:59:00.000Z');
    expect(rows.map((r) => r.attemptedAt)).toEqual([T1, T0]);
    expect(rows.map((r) => r.owner.kind)).toEqual(['relay_leg', 'broadcast']);
    expect(await repo.listByRecipient('+15550009999', facts.recipientDigest, '2026-09-26T12:00:01.000Z')).toHaveLength(1);
  });
});
```

Run: `cd app; npx vitest run test/sendAttemptsRepo.integration.test.ts` -> FAIL (module missing). (`npm run db:start` first.)

- [ ] **Step 2: Implement the repo**

```ts
// app/src/repos/sendAttemptsRepo.ts
// The per-recipient SEND-ATTEMPT RECORD (spec D8a) and its recipient-keyed
// index (spec D8a, second family). Coordination state for a send lives HERE,
// never in the recipient slot: six writers share the slot and two rewrite it
// wholesale (retry-counter D2's lesson). Every transition is a conditional
// write fenced on the attempt (attemptNo + attemptedAt), so a stale writer
// cannot overwrite a newer attempt and a redelivered job converges (D11).
import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import { hashRecipientKey } from '../lib/sendFingerprint.js';
import { SEND_CLAIM_TTL_MS } from '../lib/sendOutcome.js';
import type { RepoDeps } from './conversationsRepo.js';

export const SEND_ATTEMPT_PARTITION_PREFIX = 'sendattempt#';
export const SEND_ATTEMPT_INDEX_PREFIX = 'sendattemptix#';
export const SEND_ATTEMPT_CLEANUP_MS = 30 * 24 * 60 * 60 * 1000;

export type SendAttemptOwner = /* shared block */;
export type SendAttemptState = 'attempting' | 'reconciling' | 'redriven' | 'done';
export type SendAttemptOutcome = /* shared block */;
export interface SendAttemptFacts { /* shared block */ }
export interface SendAttemptRecord extends SendAttemptFacts { /* shared block */ }
export interface AttemptRef { attemptNo: number; attemptedAt: string; }
export type ClaimResult = /* shared block */;
export interface SendAttemptsRepo { /* shared block */ }

export function ownerKey(owner: SendAttemptOwner): string {
  switch (owner.kind) {
    case 'broadcast': return `broadcast#${owner.broadcastId}`;
    case 'relay_leg': return `relay#${owner.relayConversationId}#${owner.sourceTsMsgId}`;
    case 'relay_rung': return `rung#${owner.relayConversationId}#${owner.retryTsMsgId}`;
  }
}
function recipientKeyOf(owner: SendAttemptOwner): string {
  return owner.kind === 'broadcast' ? owner.contactKey : owner.memberKey;
}
function recordKey(owner: SendAttemptOwner): { conversationId: string; tsMsgId: string } {
  return { conversationId: `${SEND_ATTEMPT_PARTITION_PREFIX}${ownerKey(owner)}`, tsMsgId: hashRecipientKey(recipientKeyOf(owner)) };
}
function indexPartition(sender: string | undefined, recipientDigest: string): string {
  return `${SEND_ATTEMPT_INDEX_PREFIX}${sender ?? '-'}#${recipientDigest}`;
}
function expiresAt(nowMs: number): number {
  return Math.floor((nowMs + SEND_ATTEMPT_CLEANUP_MS) / 1000);
}

// Aliased names: `state` is a DynamoDB reserved word, so the attribute is attempt_state.
const N = { '#st': 'attempt_state', '#no': 'attempt_no', '#at': 'attempted_at', '#rc': 'redrive_count', '#ck': 'check_no', '#sid': 'sid', '#oc': 'outcome', '#ca': 'cause', '#exp': 'expires_at' } as const;

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

export function createSendAttemptsRepo(deps: RepoDeps = {}): SendAttemptsRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('messages', deps.env);
  const log = deps.logger ?? defaultLogger;

  async function get(owner: SendAttemptOwner): Promise<SendAttemptRecord | undefined> {
    const { Item } = await doc.send(new GetCommand({ TableName: table, Key: recordKey(owner), ConsistentRead: true }));
    return Item === undefined ? undefined : toRecord(Item);
  }

  /** The claim's transaction: a conditional create-or-advance on the record plus an index put. */
  async function writeClaim(owner: SendAttemptOwner, facts: SendAttemptFacts, nowIso: string, from: 'absent' | 'retryable' | 'redriven', prev?: SendAttemptRecord): Promise<boolean> {
    const key = recordKey(owner);
    const nowMs = Date.parse(nowIso);
    const attemptNo = (prev?.attemptNo ?? 0) + 1;
    const condition =
      from === 'absent' ? 'attribute_not_exists(tsMsgId)'
      : from === 'retryable' ? '#st = :done AND #oc = :retryable AND #no = :prevNo'
      : '#st = :redriven AND #no = :prevNo';
    try {
      await doc.send(new TransactWriteCommand({ TransactItems: [
        { Update: {
          TableName: table, Key: key,
          UpdateExpression: 'SET #st = :attempting, #no = :no, #at = :at, #exp = :exp, #owner = :owner, recipient_digest = :rd, sender = :sender, body_hash = :bh, body_short = :bs, media_count = :mc, #rc = if_not_exists(#rc, :zero), #ck = :zero REMOVE #sid, #oc, #ca',
          ConditionExpression: condition,
          ExpressionAttributeNames: { ...N, '#owner': 'owner' },
          ExpressionAttributeValues: {
            ':attempting': 'attempting', ':no': attemptNo, ':at': nowIso, ':exp': expiresAt(nowMs), ':owner': owner,
            ':rd': facts.recipientDigest, ':sender': facts.sender ?? null, ':bh': facts.bodyHash, ':bs': facts.bodyShort, ':mc': facts.mediaCount, ':zero': 0,
            ...(from === 'retryable' && { ':done': 'done', ':retryable': 'retryable', ':prevNo': prev!.attemptNo }),
            ...(from === 'redriven' && { ':redriven': 'redriven', ':prevNo': prev!.attemptNo }),
          },
        } },
        { Put: {
          TableName: table,
          Item: {
            conversationId: indexPartition(facts.sender, facts.recipientDigest),
            tsMsgId: `${nowIso}#${ownerKey(owner)}#${key.tsMsgId}`,
            owner, attempted_at: nowIso, body_hash: facts.bodyHash, body_short: facts.bodyShort, media_count: facts.mediaCount, expires_at: expiresAt(nowMs),
          },
        } },
      ] }));
      return true;
    } catch (err) {
      if (err instanceof TransactionCanceledException || err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  async function claim(owner, facts, nowIso): Promise<ClaimResult> {
    // Optimistic create first (the common case), then read-and-decide.
    if (await writeClaim(owner, facts, nowIso, 'absent')) {
      return { outcome: 'claimed', record: (await get(owner))! };
    }
    const record = await get(owner);
    if (record === undefined) {
      // Lost a create race; the winner's record is fresh by definition.
      return { outcome: 'refused', record: (await get(owner))!, fresh: true };
    }
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
      if (ageMs > SEND_CLAIM_TTL_MS) return { outcome: 'takeover', record };
      return { outcome: 'refused', record, fresh: true };
    }
    return { outcome: 'refused', record, fresh: false };   // reconciling, or done with a terminal outcome
  }

  /** One fenced transition: UpdateCommand with the condition; false on CCF. */
  async function transition(owner: SendAttemptOwner, update: string, condition: string, values: Record<string, unknown>, names: Record<string, string> = N): Promise<boolean> {
    try {
      await doc.send(new UpdateCommand({ TableName: table, Key: recordKey(owner), UpdateExpression: update, ConditionExpression: condition, ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  return {
    claim,
    get,
    finishAttempt: (owner, ref, result) => transition(owner,
      `SET #st = :done, #oc = :oc${result.sid !== undefined ? ', #sid = :sid' : ''}${result.cause !== undefined ? ', #ca = :ca' : ''}`,
      '#st = :attempting AND #no = :no AND #at = :at',
      { ':done': 'done', ':oc': result.outcome, ':attempting': 'attempting', ':no': ref.attemptNo, ':at': ref.attemptedAt, ...(result.sid !== undefined && { ':sid': result.sid }), ...(result.cause !== undefined && { ':ca': result.cause }) }),
    handToReconcile: (owner, ref, sid) => transition(owner,
      `SET #st = :reconciling, #ck = :zero${sid !== undefined ? ', #sid = :sid' : ''}`,
      '#st = :attempting AND #no = :no AND #at = :at',
      { ':reconciling': 'reconciling', ':zero': 0, ':attempting': 'attempting', ':no': ref.attemptNo, ':at': ref.attemptedAt, ...(sid !== undefined && { ':sid': sid }) }),
    takeOver: (owner, record) => transition(owner,
      'SET #st = :reconciling, #ck = :zero',
      '#st = :attempting AND #no = :no AND #at = :at',
      { ':reconciling': 'reconciling', ':zero': 0, ':attempting': 'attempting', ':no': record.attemptNo, ':at': record.attemptedAt }),
    recordCheck: (owner, attemptedAt, checkNo) => transition(owner,
      'SET #ck = :ck',
      '#st = :reconciling AND #at = :at AND (#ck = :prev OR #ck = :ck)',
      { ':ck': checkNo, ':prev': checkNo - 1, ':reconciling': 'reconciling', ':at': attemptedAt }),
    markRedriven: (owner, attemptedAt) => transition(owner,
      'SET #st = :redriven, #rc = :one',
      '#st = :reconciling AND #at = :at AND #rc = :zero',
      { ':redriven': 'redriven', ':one': 1, ':zero': 0, ':reconciling': 'reconciling', ':at': attemptedAt }),
    closeFromReconcile: (owner, attemptedAt, result) => transition(owner,
      `SET #st = :done, #oc = :oc${result.sid !== undefined ? ', #sid = :sid' : ''}${result.cause !== undefined ? ', #ca = :ca' : ''}`,
      '#st = :reconciling AND #at = :at',
      { ':done': 'done', ':oc': result.outcome, ':reconciling': 'reconciling', ':at': attemptedAt, ...(result.sid !== undefined && { ':sid': result.sid }), ...(result.cause !== undefined && { ':ca': result.cause }) }),
    closeRedriven: (owner, result) => transition(owner,
      `SET #st = :done, #oc = :oc${result.cause !== undefined ? ', #ca = :ca' : ''}`,
      '#st = :redriven',
      { ':done': 'done', ':oc': result.outcome, ':redriven': 'redriven', ...(result.cause !== undefined && { ':ca': result.cause }) }),
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

(Write the `...` type bodies out in full from the shared block; the literal
`/* shared block */` markers above are for this plan's brevity, not for the
file. `':sender': facts.sender ?? null` needs the DocumentClient's
`removeUndefinedValues`; use `null` so the attribute exists.)

Add `sendattempt#` (record, 30 d) and `sendattemptix#` (index, 30 d) to the
TTL family list comment in `app/src/lib/tables.ts:213-230`.

- [ ] **Step 3: Run the integration tests**

Run: `cd app; npx vitest run test/sendAttemptsRepo.integration.test.ts` -> PASS (9 tests).

- [ ] **Step 4: The harness fake and its parity test**

Add to `twilioWebhookHarness.ts`: `sendAttempts: Map<string, SendAttemptRecord>` keyed by `${ownerKey}|${hashedRecipientKey}` plus an `sendAttemptIndex: Array<{ partition; sortKey; owner }>`; a `sendAttemptsRepo: SendAttemptsRepo` whose methods apply the SAME conditions in memory (compare state, attemptNo, attemptedAt, checkNo, redriveCount exactly as the expressions do; return false where the real one returns false; `claim` decides `takeover` by the same TTL). Export both from `createFakeWorld()`.

Create `app/test/twilioWebhookHarnessSendAttempts.test.ts` on the
`twilioWebhookHarnessRetryFields.test.ts` idiom: a table of scripted
transition sequences (claim / finishAttempt / handToReconcile / takeOver /
recordCheck / markRedriven / closeFromReconcile / closeRedriven / claim again)
run against BOTH the fake and the real repo (the real half `describe.skipIf(!reachable)`),
asserting identical boolean results and identical `get()` records (minus
`expiresAt`).

Run: `cd app; npx vitest run test/twilioWebhookHarnessSendAttempts.test.ts` -> PASS.

- [ ] **Step 5: Typecheck, commit**

Run: `npm run typecheck` -> exit 0.

```powershell
git status
git add app/src/repos/sendAttemptsRepo.ts app/test/sendAttemptsRepo.integration.test.ts app/src/lib/tables.ts app/test/helpers/twilioWebhookHarness.ts app/test/twilioWebhookHarnessSendAttempts.test.ts
git commit -m "feat(repos): the per-recipient send-attempt record and its recipient index, every transition fenced on the attempt" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 6: Repo additions the send sites and the reconcile job need (D8, D11, D13, D15, D16a, D22)

**Files:**
- Modify: `app/src/repos/messagesRepo.ts` (interface :1307-1912; impl near :2035-2062, :3178-3201, :3661-3682, :3784-3821, :3855-3861; `AppendResult` :1259-1264 and the dedupe branch :2525-2558; `RelayRecipientDelivery` :159-169 gains `attemptedAt?: string`)
- Modify: `app/src/repos/broadcastsRepo.ts` (`BroadcastStats` :85-125 gains `unconfirmed?: number`; `deriveBroadcastStats` :254-306; `zeroStats` :309-321; interface :344-442; impl :454-457, :497-523, :671-717, :760-801)
- Modify the typed repo fakes: `app/test/helpers/twilioWebhookHarness.ts` (:1080 messages, :2902 broadcasts), `app/test/sendMessage.test.ts:233`, `app/test/scheduledSendSuppression.test.ts:273`
- Test: `app/test/relayRepos.integration.test.ts`, `app/test/broadcastsRepo.integration.test.ts`, `app/test/deriveBroadcastStats.test.ts`

**Interfaces:**
- Consumes: `SEND_UNCONFIRMED_CODE` (Task 1).
- Produces (messagesRepo):
  - `getByProviderSidConsistent(sid): Promise<MessageItem | undefined>`
  - `getRelaySidPointerConsistent(providerSid): Promise<{ conversationId; tsMsgId; memberKey } | undefined>`
  - `getSystemSidMarkerConsistent(providerSid): Promise<{ kind: string } | undefined>`
  - `listByConversationConsistent(conversationId, opts?): Promise<MessageItem[]>`
  - `claimRelaySidPointer(providerSid, ref): Promise<'created' | 'mine' | 'other'>` (conditional put; on CCF a consistent read compares the ref)
  - `closeRelayRecipientIfUnsent(conversationId, tsMsgId, memberKey, delivery: RelayRecipientDelivery): Promise<'closed' | 'skipped_sent' | 'missing'>` - absent slot OR (`queued` AND no `sid`); legacy AND versioned rows (the versioned write goes through the same expression - it is a close, forward-only from `queued`, with the slot's requestedTransport preserved via `if_not_exists`)
  - `setRelayRecipientAttemptedAt(conversationId, tsMsgId, memberKey, attemptedAt): Promise<void>` - create-if-absent (`SET #dr.#mk = if_not_exists(#dr.#mk, :seed)` first, then `SET #dr.#mk.attemptedAt = :at`; two commands, the second conditioned on `attribute_exists(#dr.#mk)`), never touching other fields
  - `AppendResult` gains `conversationId: string` (the dedupe branch returns `ptr.ref_conversationId`; the fresh branch returns the input's)
- Produces (broadcastsRepo):
  - `getByIdConsistent(broadcastId): Promise<BroadcastItem | undefined>`
  - `recordRecipientOutcome(broadcastId, contactKey, recipient: BroadcastRecipient, statsDelta: Partial<BroadcastStats>, allowedPriorStatuses: ReadonlyArray<BroadcastRecipient['status']>): Promise<{ moved: boolean; item?: BroadcastItem }>` - ONE UpdateCommand: `SET recipients.#ck = :rec, #updatedAt = :now ADD stats.#a :va, ...` conditioned on `recipients.#ck.#status IN (...)`; CCF -> `{ moved: false }`
  - `closeRecipientIfQueued(broadcastId, contactKey, errorCode, statsBucket: 'failed' | 'unconfirmed'): Promise<{ moved: boolean; item?: BroadcastItem }>` = `recordRecipientOutcome(..., { status: 'failed', errorCode }, { [bucket]: 1, queued: -1 }, ['queued'])`
  - `finalizeStatus(broadcastId, status: 'sent' | 'failed', lastError?): Promise<{ won: boolean; item: BroadcastItem }>` - conditioned on `#s = :sending`; on CCF a consistent read returns `{ won: false, item }`
  - `deriveBroadcastStats` routes `failed` + `send_unconfirmed` to `unconfirmed`; `zeroStats` includes `unconfirmed: 0`

- [ ] **Step 1: Failing integration tests (relay side)**

In `app/test/relayRepos.integration.test.ts` add a describe `send-outcome additions`:

```ts
it('claimRelaySidPointer reports created / mine / other', async () => {
  const ref = { conversationId: 'conv-1', tsMsgId: 'ts-1', memberKey: 'c-1' };
  expect(await messages.claimRelaySidPointer('SM1', ref)).toBe('created');
  expect(await messages.claimRelaySidPointer('SM1', ref)).toBe('mine');
  expect(await messages.claimRelaySidPointer('SM1', { ...ref, memberKey: 'c-2' })).toBe('other');
  expect(await messages.getRelaySidPointerConsistent('SM1')).toEqual(ref);
});
it('closeRelayRecipientIfUnsent closes an absent legacy slot and a queued sid-less slot, skips a queued slot with a sid', async () => {
  // legacy row with an empty map
  await messages.append({ ...legacySource, deliveryRecipients: {} });
  expect(await messages.closeRelayRecipientIfUnsent('conv-1', legacyTs, 'c-1', { status: 'failed', errorCode: 'transient_cap' })).toBe('closed');
  await messages.setRecipientDelivery('conv-1', legacyTs, 'c-2', { status: 'queued', sid: 'SM7', sentAt: now });
  expect(await messages.closeRelayRecipientIfUnsent('conv-1', legacyTs, 'c-2', { status: 'failed', errorCode: 'transient_cap' })).toBe('skipped_sent');
  expect((await messages.getByTsMsgIdConsistent('conv-1', legacyTs))!.delivery_recipients!['c-2']).toMatchObject({ status: 'queued', sid: 'SM7' });
  expect(await messages.closeRelayRecipientIfUnsent('conv-1', 'nope', 'c-1', { status: 'failed', errorCode: 'x' })).toBe('missing');
});
it('closeRelayRecipientIfUnsent on a versioned row keeps requestedTransport and is forward-only', async () => {
  await messages.append({ ...versionedSource, deliveryRecipients: { 'c-1': { status: 'queued', requestedTransport: 'sms', transportAggregationState: 'planned' } } });
  expect(await messages.closeRelayRecipientIfUnsent('conv-1', versionedTs, 'c-1', { status: 'failed', errorCode: 'transient_cap' })).toBe('closed');
  const slot = (await messages.getByTsMsgIdConsistent('conv-1', versionedTs))!.delivery_recipients!['c-1'];
  expect(slot).toMatchObject({ status: 'failed', errorCode: 'transient_cap', requestedTransport: 'sms' });
  expect(await messages.closeRelayRecipientIfUnsent('conv-1', versionedTs, 'c-1', { status: 'failed', errorCode: 'other' })).toBe('skipped_sent');
});
it('setRelayRecipientAttemptedAt creates an absent legacy slot and never touches an existing slot's other fields', async () => {
  await messages.setRelayRecipientAttemptedAt('conv-1', legacyTs, 'c-3', T0);
  expect((await messages.getByTsMsgIdConsistent('conv-1', legacyTs))!.delivery_recipients!['c-3']).toEqual({ status: 'queued', attemptedAt: T0 });
  await messages.setRelayRecipientAttemptedAt('conv-1', legacyTs, 'c-2', T1);
  expect((await messages.getByTsMsgIdConsistent('conv-1', legacyTs))!.delivery_recipients!['c-2']).toMatchObject({ status: 'queued', sid: 'SM7', attemptedAt: T1 });
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

- [ ] **Step 2: Implement the messagesRepo additions**

- `getByProviderSidConsistent`: `getSidPointer(sid, { consistent: true })` then a `GetCommand` with `ConsistentRead: true`.
- `getRelaySidPointerConsistent` / `getSystemSidMarkerConsistent`: the existing Gets with `ConsistentRead: true`.
- `listByConversationConsistent`: the existing Query (`:3178-3194`) with `ConsistentRead: true`.
- `claimRelaySidPointer`: the existing put (`:3784-3806`) but on CCF do `getRelaySidPointerConsistent(providerSid)` and return `'mine'` when all three ref fields equal, else `'other'`. Leave `putRelaySidPointer` in place (its other caller is `relayAnnouncements.ts:354`, Stage 2).
- `closeRelayRecipientIfUnsent`:
  ```
  UpdateExpression: 'SET #dr.#mk = :closed'
  ConditionExpression: 'attribute_exists(tsMsgId) AND (attribute_not_exists(#dr.#mk) OR (#dr.#mk.#st = :queued AND attribute_not_exists(#dr.#mk.#sid)))'
  ```
  where `:closed` is `{ ...delivery, ...(existing requestedTransport preserved) }` - because a single SET cannot both read and keep sibling fields, do it as two statements: first try `SET #dr.#mk.#st = :failed, #dr.#mk.#ec = :ec` conditioned on `attribute_exists(#dr.#mk) AND #dr.#mk.#st = :queued AND attribute_not_exists(#dr.#mk.#sid)` (keeps every other field: `requestedTransport`, `attemptedAt`); on CCF try `SET #dr.#mk = :closedFresh` conditioned on `attribute_exists(tsMsgId) AND attribute_not_exists(#dr.#mk)`; on a second CCF, a consistent read decides `'missing'` (no row) vs `'skipped_sent'`. Names: `#dr` delivery_recipients, `#mk` memberKey, `#st` status, `#ec` errorCode, `#sid` sid.
- `setRelayRecipientAttemptedAt`: `SET #dr.#mk = if_not_exists(#dr.#mk, :seed)` with `:seed = { status: 'queued' }` conditioned on `attribute_exists(tsMsgId)`, then `SET #dr.#mk.#at = :at` conditioned on `attribute_exists(#dr.#mk)`; swallow nothing but CCF on the second (log WARN).
- `AppendResult.conversationId`: return `message.conversationId` on the fresh path; `ptr.ref_conversationId` on the dedupe path (`:2543-2558`).
- `RelayRecipientDelivery.attemptedAt?: string` with a doc line: "OUR attempt clock (D8a), best-effort; a wholesale write may drop it; never a provider timestamp."

Update the three typed MessagesRepo fakes with faithful in-memory versions (the harness's `closeRelayRecipientIfUnsent` must model the absent / queued-no-sid / skip cases; `claimRelaySidPointer` must model created / mine / other over `world.relaySidPointers`).

Run: `cd app; npx vitest run test/relayRepos.integration.test.ts` -> PASS.

- [ ] **Step 3: Failing tests (broadcast side)**

In `app/test/broadcastsRepo.integration.test.ts`:

```ts
it('recordRecipientOutcome writes the slot and bumps stats in ONE conditional write', async () => {
  const r = await broadcasts.recordRecipientOutcome('b-1', 'c-1', { status: 'sent', conversationId: 'conv-1', tsMsgId: 'ts-1' }, { sent: 1, queued: -1 }, ['queued']);
  expect(r.moved).toBe(true);
  expect(r.item!.stats).toMatchObject({ sent: 1, queued: 0 });
  const again = await broadcasts.recordRecipientOutcome('b-1', 'c-1', { status: 'failed', errorCode: 'x' }, { failed: 1, queued: -1 }, ['queued']);
  expect(again).toEqual({ moved: false });
  expect((await broadcasts.getByIdConsistent('b-1'))!.stats).toMatchObject({ sent: 1, failed: 0 });
});
it('closeRecipientIfQueued bumps the unconfirmed bucket, creating it on a legacy stats map', async () => {
  const r = await broadcasts.closeRecipientIfQueued('b-legacy', 'c-1', 'send_unconfirmed', 'unconfirmed');
  expect(r.item!.stats.unconfirmed).toBe(1);
});
it('finalizeStatus wins once', async () => {
  const a = await broadcasts.finalizeStatus('b-1', 'sent');
  const b = await broadcasts.finalizeStatus('b-1', 'failed', 'late');
  expect(a.won).toBe(true);
  expect(b).toMatchObject({ won: false, item: { status: 'sent' } });
});
```

And in `app/test/deriveBroadcastStats.test.ts` extend the full-object `toEqual` (`:43-53`) with `unconfirmed: 0` and add:

```ts
it('routes a failed slot carrying send_unconfirmed to unconfirmed and to no other bucket (D22)', () => {
  const s = deriveBroadcastStats({ recipients: recips([['a', { status: 'failed', errorCode: 'send_unconfirmed' }], ['b', { status: 'failed', errorCode: '30007' }]]), stats: zeroStats() });
  expect(s).toMatchObject({ unconfirmed: 1, failed: 1, audience: 2 });
});
```
and extend the 50-slot invariant (`:93-123`) so the sum includes `unconfirmed`.

Run: `cd app; npx vitest run test/broadcastsRepo.integration.test.ts test/deriveBroadcastStats.test.ts` -> FAIL.

- [ ] **Step 4: Implement the broadcastsRepo additions**

- `BroadcastStats.unconfirmed?: number` with the doc "closed `failed` slots carrying `send_unconfirmed`; optional - persisted rows predate it, readers default 0".
- `deriveBroadcastStats`: in the `failed` arm, `if (slot.errorCode === SEND_UNCONFIRMED_CODE) unconfirmed += 1; else failed += 1;` and return `unconfirmed`. `zeroStats` adds `unconfirmed: 0`.
- `getByIdConsistent`: the `getById` closure with `ConsistentRead: true`.
- `recordRecipientOutcome`: build `SET recipients.#ck = :rec, #updatedAt = :now` plus `ADD stats.#k0 :v0, ...` for every non-zero delta, `ConditionExpression: 'attribute_exists(broadcastId) AND recipients.#ck.#status IN (:ps0, ...)'`, `ReturnValues: 'ALL_NEW'`; CCF -> `{ moved: false }`.
- `closeRecipientIfQueued`: as specified, delegating.
- `finalizeStatus`: `flipStatus`'s expression with `ConditionExpression: 'attribute_exists(broadcastId) AND #s = :sending'`, `ReturnValues: 'ALL_NEW'`; on CCF a consistent read -> `{ won: false, item }` (throw if the item is missing).

Typed BroadcastsRepo fakes: add the four methods (harness :2902) modelling the priors and the `sending` condition.

Run: `cd app; npx vitest run test/broadcastsRepo.integration.test.ts test/deriveBroadcastStats.test.ts test/broadcastApi.test.ts` -> PASS after also adding `unconfirmed: 0` to the two full-object stats `toEqual`s in `app/test/broadcastApi.test.ts:1269-1279` (results) - the list summary `toMatchObject` (:1290-1296) needs nothing.

- [ ] **Step 5: Typecheck, commit**

Run: `npm run typecheck` -> exit 0.

```powershell
git status
git add app/src/repos/messagesRepo.ts app/src/repos/broadcastsRepo.ts app/test/relayRepos.integration.test.ts app/test/broadcastsRepo.integration.test.ts app/test/deriveBroadcastStats.test.ts app/test/broadcastApi.test.ts app/test/helpers/twilioWebhookHarness.ts app/test/sendMessage.test.ts app/test/scheduledSendSuppression.test.ts
git commit -m "feat(repos): conditional recipient closes, consistent reads, a reporting SID claim, an idempotent finalize flip and the unconfirmed bucket" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Slice B - the send sites

### Task 7: The broadcast fan-out (D5-D9, D7a, D8, D8a, D13a, D16a)

**Files:**
- Modify: `app/src/jobs/broadcastFanOut.ts` (parser :124-143; handler :218-688; `closeBroadcast` :287-324; loop :373-622; continuation :642-683; `finalize` :723-771; module header comment :1-33 and the `TODO(throw-for-redelivery-defeated-by-job-marker)` comment :609-620 are rewritten)
- Test: `app/test/broadcastFanOut.test.ts`

**Interfaces:**
- Consumes: `classifySendFailure`, codes and constants (Task 1); `bodyFingerprint`, `recipientDigest` (Task 2); the typed errors (Task 3); `SendAttemptsRepo` (Task 5); `recordRecipientOutcome`, `closeRecipientIfQueued`, `finalizeStatus`, `getByIdConsistent` (Task 6); `enqueueSendReconcile`, `SendReconcilePayload` (Task 10 - a stub is fine until Task 10 lands: this task creates `app/src/jobs/sendReconcile.ts` with ONLY the constant, the payload type and `enqueueSendReconcile`, which Task 10 completes).
- Produces: `BroadcastSendPayload.redrive?: true` (parsed); `BroadcastSendJobDeps.sendAttemptsRepo?: SendAttemptsRepo`; the handler behavior below.

**Behavior to build (the recipient unit, per D7a):**

```
for each contactKey in keys:
  slot terminal? -> continue                                           (unchanged)
  PREPARE: resolveContact; the five fences (unchanged writes, pre-claim);
           createOrGetByParticipantPhone; renderBody
  facts = { recipientDigest: recipientDigest(config.businessPhoneNumber, contact.phone),
            sender?: config.businessPhoneNumber, ...bodyFingerprint(body), mediaCount: 0 }
  CLAIM: c = sendAttempts.claim(owner, facts, nowIso)
     refused & fresh   -> if payload.recipientKeys (a continuation): keep in transientRemaining (defer again); else skip; continue
     refused & !fresh  -> skip; continue
     takeover          -> sendAttempts.takeOver(owner, c.record) -> enqueueSendReconcile({owner, attemptedAt: c.record.attemptedAt, checkNo: 0}, delay0); on enqueue throw: closeRecipientIfQueued(...'send_unconfirmed','unconfirmed') + closeFromReconcile(unresolved, 'enqueue_failed'); continue
     claimed           -> ref = { attemptNo, attemptedAt }
  SEND: outcome = sendMessage({...})   // unchanged args
  RECORD (success): recordRecipientOutcome(slot sent + conversationId/tsMsgId, { sent: 1, queued: -1 }, ['queued']) -> emit progress from item
                    -> finishAttempt(ref, { outcome: 'sent', sid: outcome.providerSid })
                    -> best-effort: tokenBucket.acquire (wrapped), milestone, listing-send (unchanged)
          if recordRecipientOutcome or finishAttempt THROWS: 'sent_unrecorded': ERROR {sid}; handToReconcile(ref, sid); enqueueSendReconcile(checkNo 0, delay0); continue
  catch (err):
     SendRefusedError      -> slot skipped + bump (unchanged) ; finishAttempt(ref, { outcome: 'refused', cause: err.code }); streak = 0; continue
     SendNotAttemptedError -> D6: slot queued + 'send_retryable' (setRecipient, blind as today), push transientRemaining; finishAttempt(ref, { outcome: 'retryable', cause: 'send_retryable' }); streak = 0; continue
     ProviderSendFailedError -> switch classification.kind:
        rejected: existing 30007 / 30005-30006 arms by code (unchanged writes), else slot failed + code via recordRecipientOutcome(...,{failed:1,queued:-1},['queued']); finishAttempt(ref,{outcome:'rejected',cause:code}); streak=0
        retryable: slot queued + (code ?? 'send_retryable'); push transientRemaining; finishAttempt(ref,{outcome:'retryable',cause}); streak=0
        unknown:   handToReconcile(ref) ; enqueueSendReconcile({owner, attemptedAt: ref.attemptedAt, checkNo: 0}, delay0)
                   on enqueue throw: closeRecipientIfQueued('send_unconfirmed','unconfirmed') + closeFromReconcile(unresolved,'enqueue_failed'); ERROR
                   else WARN 'handed to reconcile'; streak += 1; if streak >= OUTAGE_BRAKE_UNKNOWN_STREAK: brake
     SendAcceptedNotRecordedError -> ERROR 'sent_unrecorded'; handToReconcile(ref, err.providerSid); enqueueSendReconcile(checkNo 0); continue
     any other error (a failure-arm write that threw, etc.) -> ERROR with owner+recipient; continue   (never throw out)
BRAKE: remaining untried keys (this pass) -> transientRemaining; WARN { braked: n }; break
```

Pass-level changes:
- Snapshot read `:259` -> `getByIdConsistent` when `payload.recipientKeys !== undefined` (a continuation or a re-drive; D16); the first pass keeps `getById`.
- Up-front claim `:349-364`: skipped when `payload.redrive === true`; after the loop, a re-drive pass with a non-empty `transientRemaining` claims then (`claimFanoutPass`) and takes the existing cap/enqueue branches; with an empty remainder it goes straight to `finalize`.
- The "unreachable by construction" guard `:643-651` becomes reachable only for a re-drive pass and must NOT close: replace with `if (claim === undefined) { claim = await repo.claimFanoutPass(...); handle missing/capped as the up-front branch does }`.
- A re-drive pass's PRE-CLAIM declines (the five fences) also call `sendAttempts.closeRedriven(owner, { outcome: 'refused', cause: <fence code> })` (D8: the re-drive pass owns its `redriven` record).
- `closeBroadcast` (D8): for each key, `rec = await sendAttempts.get(owner)`; `absent` or `done/retryable` -> `closeRecipientIfQueued(id, key, code, 'failed')`, emit progress if moved; `attempting` older than `SEND_CLAIM_TTL_MS` -> `takeOver` + enqueue reconcile (the enqueue-failure path closes `unresolved`); any other state -> skip (INFO). Then the existing ERROR line and `finalize`.
- `finalize` (D16a): `fresh = getByIdConsistent`; if any slot status is `queued` -> return (INFO `finalize deferred - recipients still open`); decide from the map: `const s = deriveBroadcastStats(fresh)`, `reachedAny = s.sent + s.sending + s.delivered > 0`, `failedAny = s.failed + (s.unconfirmed ?? 0) > 0`; `status = !reachedAny && failedAny ? 'failed' : 'sent'`; `lastError = status === 'failed' ? (s.failed === 0 ? "Couldn't confirm any text went out" : 'all recipients failed') : undefined`; `{ won, item } = finalizeStatus(id, status, lastError)`; only when `won`: the `broadcast_sent` unit audit row, the terminal emit and the INFO line (which gains `unconfirmed`).
- Continuation enqueue payload (`:661-673`) is unchanged except that it never lists a recipient whose record is `reconciling` (they are never in `transientRemaining` by construction).
- The module header comment (`:1-33`) is rewritten to describe the three phases, the claim, the reconcile hand-off and the brake; the `TODO(throw-for-redelivery-defeated-by-job-marker)` block is deleted.
- Lazy deps: `sendAttempts ??= deps.sendAttemptsRepo ?? createSendAttemptsRepo({ logger: deps.logger })`.

- [ ] **Step 1: Write the failing tests (extend `app/test/broadcastFanOut.test.ts`)**

Use the file's own machinery (`seedTenant`, `seedBroadcast`, `wireHandler`, `outbound`, `capturingLogger`; see reference 8.1). `wireHandler` now passes `sendAttemptsRepo: world.sendAttemptsRepo`.

```ts
describe('unknown send errors (spec D7, D8a, D9, D13a) - must fail on main', () => {
  function unknownOn(keys: Set<string>) {
    world.adapter.sendPreparedMessage = async (prepared) => {
      if (keys.has(prepared.params.to)) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return { providerSid: `SM-${prepared.params.to}`, status: 'sent', providerTs: new Date().toISOString() };
    };
  }
  it('an unknown error on recipient 3 of 5 leaves 4 and 5 attempted, 3 handed to reconcile, no throw', async () => {
    const tenants = [1, 2, 3, 4, 5].map((i) => seedTenant(world, { contactId: `t-${i}`, phone: `+1555010000${i}` }));
    seedBroadcast(world, tenants);
    unknownOn(new Set(['+15550100003']));
    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();
    const b = world.broadcasts.get('bcast-1')!;
    expect(b.recipients['t-4']!.status).toBe('sent');
    expect(b.recipients['t-5']!.status).toBe('sent');
    expect(b.recipients['t-3']).toEqual({ status: 'queued' });               // untouched while reconciling
    const rec = await world.sendAttemptsRepo.get({ kind: 'broadcast', broadcastId: 'bcast-1', contactKey: 't-3' });
    expect(rec).toMatchObject({ state: 'reconciling', attemptNo: 1, checkNo: 0 });
    const reconcile = outbound.delayed.find((d) => d.envelope.jobName === SEND_RECONCILE_JOB);
    expect(reconcile?.envelope.payload).toMatchObject({ owner: { kind: 'broadcast', broadcastId: 'bcast-1', contactKey: 't-3' }, checkNo: 0 });
    expect(reconcile?.delaySeconds).toBe(5);
    expect(b.status).toBe('sending');                                         // not finalized while one is open
  });
  it('a claimed recipient whose sendMessage refuses closes done/refused, slot skipped, no reconcile - Review Focus 3', async () => {
    const [t] = [seedTenant(world, { contactId: 't-1', phone: '+15550100001' })];
    seedBroadcast(world, [t]);
    world.conversations.get(/* t-1's conv */)!.ai_mode = 'manual';   // automated share -> ManualModeError inside sendMessage
    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' }); await outbound.settle();
    expect(world.broadcasts.get('bcast-1')!.recipients['t-1']).toMatchObject({ status: 'skipped', errorCode: 'manual_mode' });
    expect(await world.sendAttemptsRepo.get({ kind: 'broadcast', broadcastId: 'bcast-1', contactKey: 't-1' })).toMatchObject({ state: 'done', outcome: 'refused', cause: 'manual_mode' });
    expect(outbound.delayed.some((d) => d.envelope.jobName === SEND_RECONCILE_JOB)).toBe(false);
  });
  it('three consecutive unknowns brake the pass; the untried remainder is deferred, not attempted (D9)', async () => {
    const tenants = [1, 2, 3, 4, 5, 6].map((i) => seedTenant(world, { contactId: `t-${i}`, phone: `+1555010000${i}` }));
    seedBroadcast(world, tenants);
    unknownOn(new Set(['+15550100001', '+15550100002', '+15550100003']));
    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' }); await outbound.settle();
    const b = world.broadcasts.get('bcast-1')!;
    expect(['t-4', 't-5', 't-6'].map((k) => b.recipients[k]!.status)).toEqual(['queued', 'queued', 'queued']);
    const cont = outbound.delayed.find((d) => d.envelope.jobName === BROADCAST_SEND_JOB);
    expect(cont?.envelope.payload).toMatchObject({ recipientKeys: ['t-4', 't-5', 't-6'], attempt: 2 });
    expect(logger.capture.atLevel('warn').some((l) => l.includes('outage brake'))).toBe(true);
  });
  it('a sent outcome between two unknowns resets the streak', async () => { /* 1 unknown, 1 sent, 1 unknown, 1 sent, 1 unknown -> no brake, all five attempted */ });
  it('three rejected in a row do not brake', async () => { /* 30007 on 1-3, sent on 4-5 */ });
  it('a record-phase failure after a successful send hands the SID to reconcile and never re-sends (D7a)', async () => {
    const [t] = [seedTenant(world, { contactId: 't-1', phone: '+15550100001' })];
    seedBroadcast(world, [t]);
    const real = world.broadcastsRepo.recordRecipientOutcome.bind(world.broadcastsRepo);
    world.broadcastsRepo.recordRecipientOutcome = async () => { throw new Error('dynamo hiccup'); };
    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' }); await outbound.settle();
    world.broadcastsRepo.recordRecipientOutcome = real;
    expect(world.sent).toHaveLength(1);
    const rec = await world.sendAttemptsRepo.get({ kind: 'broadcast', broadcastId: 'bcast-1', contactKey: 't-1' });
    expect(rec).toMatchObject({ state: 'reconciling', sid: world.sent[0]!.sid });
    expect(logger.capture.atLevel('error').some((l) => l.includes('sent_unrecorded'))).toBe(true);
  });
  it('a SendAcceptedNotRecordedError from sendMessage does the same', async () => { /* world.messagesRepo.append throws; expect reconciling + sid */ });
  it('a reconcile enqueue that throws closes the recipient unresolved on the spot', async () => {
    /* configureOutboundQueue that throws for delaySeconds > 0 (reference 8.1 queue refusal seam); expect slot failed/send_unconfirmed, stats.unconfirmed 1, record done/unresolved cause enqueue_failed, finalize deferred? no - all terminal -> finalized 'failed' with the prose last_error */
  });
  it('two passes for the same recipient produce ONE provider call (D8a)', async () => {
    /* claim once via world.sendAttemptsRepo.claim(owner, facts, now) to simulate an in-flight pass, then run the pass: recipient is skipped (deferred), world.sent is empty for it */
  });
  it('a stale attempting record is taken over into reconcile by the next pass', async () => {
    /* claim with attemptedAt 31 s ago; run a continuation pass for that key; expect record reconciling with the OLD attemptedAt and a reconcile enqueued */
  });
  it('a cap-close skips reconciling recipients and closes only records that are absent or done/retryable (D8)', async () => {
    /* seed fanout_attempt at the cap; one key reconciling, one key with no record; run; expect only the second closed transient_cap */
  });
  it('a re-drive pass claims no ladder rung up front and its fence closes the redriven record done/refused (D13a, D8)', async () => {
    /* seed record state redriven for t-1 and fanout_attempt at cap; run { broadcastId, recipientKeys: ['t-1'], attempt: 4, redrive: true } with the contact opted out -> slot skipped opted_out, record done/refused cause opted_out; claimFanoutPass NOT called */
  });
});

describe('finalize (spec D16a)', () => {
  it('N callers produce one flip, one audit row, one terminal emit', async () => { /* call finalize twice via two passes on an all-terminal broadcast; count world.audit rows of type broadcast_sent === 1; terminal emits === 1 */ });
  it('all skipped plus one unconfirmed finalizes failed with the prose - Review Focus 5', async () => {
    /* recipients: three skipped (opted out) + one failed/send_unconfirmed; run a pass; expect status 'failed', last_error "Couldn't confirm any text went out" */
  });
  it('decides from the recipients map even when the persisted failed counter is stale', async () => { /* set stats.failed = 99 on a broadcast whose slots are all delivered; expect 'sent' */ });
  it('does not finalize while a recipient is reconciling and finalizes when the verdict lands', async () => { /* run Task 10's handler on the enqueued reconcile with a listing that finds the orphan; expect status 'sent' after */ });
});
```

(Each `/* ... */` body is written out in full by the implementer, using the
seams named; the expectations are stated.) Also fix the existing `finalize
log` `toMatchObject` (`:368-379`) to include `unconfirmed: 0`.

Run: `cd app; npx vitest run test/broadcastFanOut.test.ts` -> the new describes FAIL (the first test fails on `main` by construction: recipients 4 and 5 stay `queued`).

- [ ] **Step 2: Implement** per the behavior block above. Keep every existing arm's writes and log lines where the spec says "unchanged"; ASCII-fy any log line you touch (`{U+2014}` -> `-`).

- [ ] **Step 3: Run the file and typecheck**

Run: `cd app; npx vitest run test/broadcastFanOut.test.ts` -> PASS (all existing tests still green; the five `toEqual` slot pins `:324, :359, :432-437, :495, :513` are untouched because broadcast slots get no `attemptedAt`).
Run: `npm run typecheck` -> exit 0.

- [ ] **Step 4: Commit**

```powershell
git status
git add app/src/jobs/broadcastFanOut.ts app/src/jobs/sendReconcile.ts app/test/broadcastFanOut.test.ts
git commit -m "feat(broadcast): classified send outcomes, a claim before every send, reconcile hand-off, the outage brake and an idempotent finalize" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 8: The relay leg and the fan-out loop (D5-D9, D7a, D8, D8a, D13a)

**Files:**
- Modify: `app/src/jobs/relayFanOut.ts` (parser :152-186; `RelayLegSendOutcome` :1234-1245; `sendOneRelayLeg` :1270-1514; `runRelayFanOutExecution` :1002-1203 incl. `closeRelay` :1081-1110; `RelayFanOutJobDeps` :636-672; `RelayFanOutExecutionDeps` :960-970; header comment)
- Test: `app/test/relayFanOut.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 5, 6; `enqueueSendReconcile` (Task 7's stub).
- Produces:
  - `RelayLegSendOutcome.kind` gains `'rejected' | 'sent_unrecorded' | 'handed_to_reconcile'`; `sent_unrecorded` carries `providerSid`; `handed_to_reconcile` carries `attemptRef: AttemptRef`; `rejected` carries `errorCode`.
  - `sendOneRelayLeg` args gain `sendAttempts: SendAttemptsRepo` and `owner: SendAttemptOwner` (the CALLER builds the owner: the fan-out `{ kind: 'relay_leg', ... }`, the rung `{ kind: 'relay_rung', ... }`), and `redrive?: boolean` (a re-drive pass owns its `redriven` record).
  - `RelayFanOutPayload.redrive?: true` (parsed).
  - `RelayFanOutJobDeps.sendAttemptsRepo?`; `RelayFanOutExecutionDeps.sendAttempts`.

**The unit's phases (per D7a, claim placement fixed):**

```
terminal skip (unchanged)
suppression arm (unchanged; PRE-CLAIM) - when args.redrive: also sendAttempts.closeRedriven(owner, { outcome: 'refused', cause: 'contact_opted_out' })
acquire (unchanged, incl. deadline_exceeded return - PRE-CLAIM; when args.redrive and deadline_exceeded: caller closes the redriven record, see Task 9)
facts = { recipientDigest: recipientDigest(poolNumber, member.phone), sender: poolNumber, ...bodyFingerprint(legBody), mediaCount: legMediaUrls?.length ?? 0 }
CLAIM: c = sendAttempts.claim(owner, facts, nowIso)
   refused fresh -> return { kind: 'transient', errorCode: 'send_retryable' }?  NO - a foreign fresh claim means DEFER: return { kind: 'deferred_foreign' }... keep the union small: return { kind: 'transient', errorCode: SEND_RETRYABLE_CODE, deferredByClaim: true } and write NO slot (the other attempt owns it)
   refused !fresh -> return { kind: 'skipped_terminal' }
   takeover -> takeOver; return { kind: 'handed_to_reconcile', attemptRef: { attemptNo: c.record.attemptNo, attemptedAt: c.record.attemptedAt } }
   claimed -> ref
best-effort: setRelayRecipientAttemptedAt(...)   (D8a; WARN on failure)
presign (unchanged); params; prepare; aggregation 'attempted' (unchanged)   - a throw here: finishAttempt(ref, retryable, cause 'send_retryable'); persist queued + 'send_retryable'; return { kind: 'transient', errorCode: SEND_RETRYABLE_CODE }
SEND (unchanged call)
catch:
  SendRefusedError -> unchanged slot write; finishAttempt(ref, refused, err.code); return refused
  classify(err):
    rejected: 30007 -> unchanged arm + finishAttempt(rejected,'30007'); return filtered
              else   -> persist failed + code (sms_sending_disabled for the adapter kill switch); finishAttempt(rejected, code); return { kind: 'rejected', errorCode: code }
    retryable: persist queued + (code ?? 'send_retryable'); finishAttempt(retryable, code); return transient
    unknown:   handToReconcile(ref); return { kind: 'handed_to_reconcile', attemptRef: ref }   // the CALLER enqueues (it has the owner context)
RECORD (success): persistRelayRecipientResult (unchanged, FIRST) then claimRelaySidPointer (SECOND; 'other' -> ERROR 'relaysid pointer held by another owner' and treat as sent_unrecorded);
                  then finishAttempt(ref, { outcome: 'sent', sid })
   a throw in RECORD -> ERROR 'sent_unrecorded' {sid}; handToReconcile(ref, sid); return { kind: 'sent_unrecorded', providerSid: sid, attemptRef: ref }
```

The fan-out loop (`:1139-1161`):
- counts `sent`, `transient` (unchanged), and now `handed_to_reconcile` / `sent_unrecorded` -> `enqueueSendReconcile({ owner, attemptedAt: outcome.attemptRef.attemptedAt, checkNo: 0, continuation: { senderKey: payload.senderKey, ...(payload.senderNameOverride && { senderNameOverride }) } }, delay0)`; on enqueue throw -> `closeRelayRecipientIfUnsent(..., { status: 'failed', errorCode: SEND_UNCONFIRMED_CODE })` + `closeFromReconcile(owner, attemptedAt, { outcome: 'unresolved', cause: 'enqueue_failed' })` + ERROR.
- D9 streak on `handed_to_reconcile` from an `unknown` (not from `sent_unrecorded`); any other kind resets; brake defers the untried remainder into `transientRemaining` with a WARN.
- A `transient` with `deferredByClaim` is pushed to `transientRemaining` without a slot write.
- `closeRelay` (D8): per key read the record; absent / done-retryable -> `closeRelayRecipientIfUnsent(..., { status: 'failed', errorCode: code })` (log `skipped_sent` at INFO); stale attempting -> takeOver + reconcile enqueue; others skip.
- Up-front pass claim skipped when `payload.redrive`; post-loop claim only with a remainder (as Task 7); the `claim?.outcome !== 'claimed'` guard `:1176-1179` replaced the same way.
- Snapshot for a continuation/re-drive: `listByConversationConsistent` (`:786`) and `getByTsMsgIdConsistent` in `readVersionedSource` when `payload.recipientKeys !== undefined` (thread a `consistent` flag through `RelayFanOutExecutionDeps`).
- Early returns (`:772-778`, `:790-794`, `:1023-1027`) on a re-drive pass: before returning, `closeRedriven(owner, { outcome: 'redrive_refused', cause })` for each `payload.recipientKeys` member and `closeRelayRecipientIfUnsent(..., { status: 'failed', errorCode: REDRIVE_REFUSED_CODE })` (the D16 sendability pre-check lives in Task 10; this is the belt to its braces).

- [ ] **Step 1: Failing tests (extend `app/test/relayFanOut.test.ts`)**

Mirror Task 7's describe for relay with the file's fixtures (`seedRelay`, `seedSource` legacy, `seedTeamSource` versioned; error injection via `world.adapter.sendMessage` for legacy and `sendPreparedMessage` for versioned - reference 8.2):

- unknown on member 2 of 4 (legacy AND versioned): members 3, 4 sent; member 2's slot untouched (`queued` placeholder, or absent on legacy) except `attemptedAt`; record `reconciling`; a `send.reconcile` envelope with `owner.kind 'relay_leg'`, `continuation.senderKey 'c-alice'`; **must fail on main**;
- a relay success that left the slot `queued` with a sid refuses a second claim (run the same envelope twice with different jobIds - dispatch the SAME payload through `enqueueImmediate` twice); one provider call;
- the token-bucket describe (`:2325-2370`) still asserts `[[1],[1]]` - the claim sits AFTER the acquire;
- `closeRelay` on a legacy row with an empty map still creates failed slots for absent records (close B pin `:999-1037` stays green) and skips a member whose record is `reconciling`;
- adapter kill switch (`SmsSendingDisabledError` from the adapter) -> slot `failed` + `sms_sending_disabled`, record `done/rejected`;
- the record-phase failure (make `world.messagesRepo.claimRelaySidPointer` throw once) -> `sent_unrecorded`, record `reconciling` with the sid, one reconcile envelope;
- brake and streak-reset cases as in Task 7;
- a re-drive pass (`redrive: true`, one member, record seeded `redriven`, `fanout_attempt` at cap) sends without claiming a rung; the same with the member opted out closes the record `done/refused`.

- [ ] **Step 2: Implement** per the phase block. Rewrite the unit's docblock (`:1234-1268`) and the module header to the three-phase model; delete the `throw err` at `:1492`.

- [ ] **Step 3: Run, typecheck, commit**

Run: `cd app; npx vitest run test/relayFanOut.test.ts` -> PASS. `npm run typecheck` -> 0.

```powershell
git status
git add app/src/jobs/relayFanOut.ts app/test/relayFanOut.test.ts
git commit -m "feat(relay): the leg claims before the send, classifies the failure and hands unknown outcomes to reconcile; the loop brakes and closes through the record gate" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 9: The relay retry rung (D7a exception, D8, D16, Sec 2a RSW #1/#5/#6/#7)

**Files:**
- Modify: `app/src/jobs/relayRetryLeg.ts` (parser :252-263; deps :115-146; the send call :626-654; the outcome chain :657-803; `refuseGate` :487-505 and the window/gate sites :542-558, :586-606, :674-692)
- Test: `app/test/relayRetryLeg.test.ts`

**Interfaces:**
- Consumes: Task 8's unit args (`sendAttempts`, `owner`, `redrive`) and outcome kinds; Task 5; Task 6; `enqueueSendReconcile`.
- Produces: `RelayRetryLegPayload.redrive?: true` (parsed); `RelayRetryLegJobDeps.sendAttemptsRepo?`.

- [ ] **Step 1: Failing tests (extend `app/test/relayRetryLeg.test.ts`)** using the `legSend.override` seam (reference 8.3):

```ts
it('handed_to_reconcile enqueues send.reconcile for the rung and neither closes nor emits', async () => {
  legSend.override = async () => ({ kind: 'handed_to_reconcile', attemptRef: { attemptNo: 1, attemptedAt: T0 } });
  const row = seedRetryRow(world, { attempt: 1 });
  await runHandler(payloadFor(row));
  expect(outbound.delayed.map((d) => d.envelope.jobName)).toEqual([SEND_RECONCILE_JOB]);
  expect(outbound.delayed[0]!.envelope.payload).toMatchObject({ owner: { kind: 'relay_rung', retryTsMsgId: row.tsMsgId, memberKey: BOB_KEY }, attemptedAt: T0, checkNo: 0 });
  expect(persistedEmits()).toEqual([]);
  expect(errorLogs()).toEqual([]);
});
it('sent_unrecorded enqueues reconcile with the SID and defers the inbox touch to adoption', async () => { /* expect no touchLastActivityPreservingStatus call; reconcile enqueued */ });
it('rejected closes nothing further (the unit wrote the slot) and emits the root close', async () => {
  legSend.override = async () => ({ kind: 'rejected', errorCode: '21211' });
  /* expect announceRootClose emit once, ERROR 'ended terminally' with legOutcome 'rejected', no throw */
});
it('a reconcile enqueue that throws closes the rung unresolved', async () => { /* queue refusal seam; expect slot failed/send_unconfirmed via closeRelayRecipientIfUnsent, record done/unresolved cause enqueue_failed, root close emit */ });
it('a re-driven rung (redrive: true, record redriven) declined by the window gate closes the record done/refused with retry_window_closed (RSW #1, D8)', async () => {
  const row = seedRetryRow(world, { attempt: 1, windowStart: minutesAgo(20) });
  await world.sendAttemptsRepo.claim(rungOwner(row), facts, T0); await world.sendAttemptsRepo.handToReconcile(rungOwner(row), { attemptNo: 1, attemptedAt: T0 }); await world.sendAttemptsRepo.markRedriven(rungOwner(row), T0);
  await runHandler({ ...payloadFor(row), redrive: true });
  expect(slotOf(row)).toMatchObject({ status: 'failed', errorCode: 'retry_window_closed' });
  expect(await world.sendAttemptsRepo.get(rungOwner(row))).toMatchObject({ state: 'done', outcome: 'refused', cause: 'retry_window_closed' });
});
it('a re-driven rung whose deadline expires during the acquire closes retry_window_closed and the record done/refused (RSW #5)', async () => { /* drainedBucket(); redrive: true; expect the RSW pins (no attempted write, no claimFanoutPass) AND record done/refused */ });
it('a foreign fresh attempt on the rung skips the send (the unit returns transient deferredByClaim) and re-enqueues the same rung once', async () => { /* claim with another attemptedAt now; expect no provider call, same-rung re-enqueue via the transient sub-ladder */ });
it('the outcome chain is exhaustive - an unknown kind is a typecheck error, not a runtime fall-through', () => { /* compile-time: a `never` assertion in the switch; the test asserts the module exports the kind list length */ });
```

The RSW pins (`:557-566`, `:1214-1256`) must stay byte-identical in their assertions: the claim sits after the acquire, and the deadline close still writes exactly the pinned slot shape (the `attemptedAt` best-effort write happens AFTER the claim, so a deadline close never sees it).

- [ ] **Step 2: Implement**

- Parser carries `redrive`.
- Build `owner = { kind: 'relay_rung', relayConversationId, retryTsMsgId, memberKey }` and pass `sendAttempts`, `owner`, `redrive: payload.redrive === true` to `sendOneRelayLeg`.
- `refuseGate` and the window close (`:542-558`, `:586-606`, `:674-692`): when `payload.redrive === true`, also `sendAttempts.closeRedriven(owner, { outcome: 'refused', cause: code })` (the re-drive pass owns its record, D8); otherwise, before writing, `rec = sendAttempts.get(owner)` and skip the close with a WARN when the record is in any state but absent / `done`-`retryable` (RSW #6 through D8's gate; RSW's claim-time declines never reach here because the webhook appends them closed and never enqueues).
- Outcome chain: turn the if-chain into a `switch (outcome.kind)` with arms for `sent` (wrap the touch in try/catch, ERROR on failure), `sent_unrecorded` (ERROR, enqueue reconcile with `checkNo 0`, NO touch), `handed_to_reconcile` (enqueue reconcile), `transient` (unchanged sub-ladder; a `deferredByClaim` transient skips the slot write - it already skipped - and takes the same re-enqueue), `deadline_exceeded` (unchanged + redriven close), `skipped_terminal` (unchanged), `rejected` / `refused` / `suppressed` / `filtered` (the ERROR + `announceRootClose`), and `default: { const never: never = outcome.kind; throw new Error(String(never)); }`.
- Reconcile enqueue failure: `closeRelayRecipientIfUnsent(conversationId, retryTsMsgId, memberKey, { status: 'failed', errorCode: SEND_UNCONFIRMED_CODE })`, `closeFromReconcile(owner, attemptedAt, { outcome: 'unresolved', cause: 'enqueue_failed' })`, ERROR, `announceRootClose()`.

- [ ] **Step 3: Run, typecheck, commit**

Run: `cd app; npx vitest run test/relayRetryLeg.test.ts test/relayWindowCloseMirror.test.ts` -> PASS (re-run the whole relay job file after the merge, per RSW #5).

```powershell
git status
git add app/src/jobs/relayRetryLeg.ts app/test/relayRetryLeg.test.ts
git commit -m "feat(relay-retry): the rung owns its re-driven record, handles the reconcile outcomes explicitly and closes exhaustively" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Slice C - the reconcile job

### Task 10: `send.reconcile` (D11-D16)

**Files:**
- Modify: `app/src/jobs/sendReconcile.ts` (the stub from Task 7 becomes the job)
- Modify: `app/src/jobs/registerHandlers.ts:46-73` (register it; `defineJobHandler` throws on a duplicate name, and `app/test/relayRetryLeg.test.ts` imports `registerAllJobHandlers`)
- Modify: `app/src/jobs/broadcastFanOut.ts` (export `finalize` and a `adoptBroadcastRecipient` helper the job calls; see Interfaces)
- Create: `app/test/sendReconcile.test.ts` (unit, fake world)
- Create: `app/test/sendReconcile.integration.test.ts` (DynamoDB Local: adoption idempotency over the real repos)

**Interfaces:**
- Consumes: Tasks 1-6; `enqueue` (jobs.ts); `mapTwilioStatus` (messaging.ts:558); `finalize` and the broadcast success-path writes (Task 7 exports them); relay writes (`persistRelayRecipientResult`, `claimRelaySidPointer`, `closeRelayRecipientIfUnsent`); `touchLastActivityPreservingStatus` (conversationsRepo:677); `isMemberSuppressed` (relayAnnouncements).
- Produces: `SEND_RECONCILE_JOB`, `SendReconcilePayload`, `enqueueSendReconcile`, `reconcileCheckDelaysMs`, `registerSendReconcileJobHandler(deps)`; `SendReconcileJobDeps { adapter?, messagesRepo?, broadcastsRepo?, contactsRepo?, conversationsRepo?, sendAttemptsRepo?, activityEventsRepo?, listingSendsRepo?, auditRepo?, events?, logger?, config? }`.
- Task 7 exports from `broadcastFanOut.ts`: `export async function finalize(...)` (already a function; export it) and `export async function adoptBroadcastRecipient(deps, args: { broadcastId, contactKey, providerSid, providerTs, providerStatus, errorCode?, body, mediaCount }): Promise<'adopted' | 'other_owner' | 'skipped_sent'>` - the D15 write set for a broadcast recipient, reusable by the job: it resolves the contact and conversation (the same reads the pass makes), appends the message row (`automated: broadcast.created_via !== 'dashboard'`, `recipientContactId` only when `contactHoldsPhone`), then the slot via `recordRecipientOutcome` (status per D15, `carrierSentAt` from `sentAt`, `conversationId`+`tsMsgId`), the audit row, the emits, and - only when adopted as `sent`/`delivered` - the milestone and the listing-send row.

**The job:**

```ts
// app/src/jobs/sendReconcile.ts
// send.reconcile (spec Sec 5). NO run-once marker: every write is idempotent
// or conditional on the attempt record (D11), so a throw here is a genuine
// SQS retry and five failures reach the DLQ. Enqueues are at-least-once.
export const SEND_RECONCILE_JOB = 'send.reconcile';
export interface SendReconcilePayload { owner: SendAttemptOwner; attemptedAt: string; checkNo: number; continuation?: { senderKey: string; senderNameOverride?: string } }

const RECONCILE_DELAYS_ENV_KEY = 'E2E_SEND_RECONCILE_DELAYS_MS';   // lane-only, comma list, topology-guarded
export function reconcileCheckDelaysMs(): readonly number[] {
  const queueUrl = process.env['JOBS_QUEUE_URL'];
  if (typeof queueUrl === 'string' && queueUrl.length > 0) return RECONCILE_CHECK_DELAYS_MS;
  const raw = process.env[RECONCILE_DELAYS_ENV_KEY];
  if (raw === undefined) return RECONCILE_CHECK_DELAYS_MS;
  const parsed = raw.split(',').map((s) => Number.parseInt(s.trim(), 10));
  return parsed.length === RECONCILE_CHECK_DELAYS_MS.length && parsed.every((n) => Number.isInteger(n) && n > 0) ? parsed : RECONCILE_CHECK_DELAYS_MS;
}
export async function enqueueSendReconcile(payload: SendReconcilePayload, delayMs: number): Promise<void> {
  await enqueue(SEND_RECONCILE_JOB, payload, { runAt: new Date(Date.now() + delayMs) });
}
```

Handler flow (`registerSendReconcileJobHandler`):

```
payload = parse(raw)   // owner shape validated per kind; attemptedAt ISO; checkNo integer >= 0
record = sendAttempts.get(owner)
if (!record || record.state !== 'reconciling' || record.attemptedAt !== payload.attemptedAt) -> INFO 'reconcile superseded' ; return   (D11: a payload for an older attempt writes nothing)
if (!(await sendAttempts.recordCheck(owner, payload.attemptedAt, payload.checkNo + 1))) -> INFO 'check already recorded' ; return
verdict = record.sid !== undefined ? await adoptKnown(record) : await lookup(record, payload.checkNo)
switch (verdict.kind):
  'found'      -> applyAdoption(owner, record, verdict.message)            (D15; owner-specific; idempotent; then closeFromReconcile(adopted, sid))
  'continue'   -> next = payload.checkNo + 1; if next < delays.length: enqueue same payload with checkNo next at delays[next] (measured from the ATTEMPT: delay = max(0, attemptedAt + cumulative - now)); else unreachable (lookup returns a verdict at the last check)
  'never_sent' -> redrive(owner, record, payload.continuation)             (D16)
  'unresolved' -> closeUnresolved(owner, record, verdict.cause)            (one ERROR)
any THROW from the owner writes or from our own record writes propagates (genuine retry)
any enqueue THROW inside the job -> catch -> the verdict was never_sent ? closeEnqueueFailed : closeUnresolved(cause 'enqueue_failed')
```

`lookup(record, checkNo)` (D13):

```
sender = record.sender; if (!sender) -> { kind: 'unresolved', cause: 'no_sender' }
currentPhone = await currentRecipientPhone(owner)   // broadcast: resolveContact(contactKey).phone (D12: the contact); relay_leg/rung: the roster member's phone (conversationsRepo.getById -> participants; a phone# key = its own number)
if (!currentPhone || recipientDigest(sender, currentPhone) !== record.recipientDigest) -> { kind: 'unresolved', cause: 'digest_mismatch' }
windowStart = attemptedAt - RECONCILE_WINDOW_LEAD_MS
candidates = []; pages = 0; token = undefined
loop: try { page = await adapter.listMessages({ to: currentPhone, from: sender, pageSize: RECONCILE_LIST_PAGE_SIZE, pageToken: token }) } catch (err) { providerError = err; break }
      pages += 1; for m of page.messages: if (Date.parse(m.createdAt) >= windowStart) candidates.push(m)
      token = page.nextPageToken; if (!token) break; if (pages >= RECONCILE_MAX_PAGES) -> { kind: 'unresolved', cause: 'page_bound' }
if (providerError) -> isLast(checkNo) ? { kind: 'unresolved', cause: 'provider_unreachable' } : { kind: 'continue' }
for m of candidates (oldest first):
   held = await heldByAnother(m.providerSid, owner)     // sid# (consistent) -> the row's owner (broadcast_id / conversation) ; relaysid# (consistent) -> ref ; syssid# marker
   if held === 'mine' -> return { kind: 'found', message: m, repair: true }
   if held === 'other' -> continue
   if !matches(record, m) -> unmatched.push(m); continue
   claimed = await claimCandidate(owner, m)            // broadcast/1:1: adoption's append dedupe decides later; relay: claimRelaySidPointer -> 'created' | 'mine' | 'other'
   if claimed === 'other' -> continue
   return { kind: 'found', message: m }
// no claimable match
if (!isLast(checkNo)) -> { kind: 'continue' }
if (unmatched.length > 0) -> { kind: 'unresolved', cause: 'unidentified_candidate' }
siblings = await sendAttempts.listByRecipient(sender, record.recipientDigest, isoOf(windowStart))
if (siblings.some((s) => s is not this owner && s.bodyHash === record.bodyHash && s.mediaCount === record.mediaCount && (s.state !== 'done' || s.outcome === 'adopted' || s.outcome === 'sent'))) -> { kind: 'unresolved', cause: 'same_fingerprint_sibling' }
-> { kind: 'never_sent' }

matches(record, m): record.bodyShort ? m.mediaCount === record.mediaCount : bodyFingerprint(m.body).hash === record.bodyHash
```

Owner handlers (D15/D16):

- **broadcast** `found`: `adoptBroadcastRecipient(...)` (Task 7's export) -> `'adopted'` -> `closeFromReconcile(adopted, sid)` -> `finalize(...)`; `'other_owner'` -> treat the candidate as held by another (continue the candidate loop - so `adoptBroadcastRecipient` is called inside the loop for the broadcast owner, not after); `'skipped_sent'` (the slot already moved - a repair) -> `closeFromReconcile(adopted, sid)`.
  `never_sent`: `markRedriven` (false -> a duplicate: return) -> `enqueue(BROADCAST_SEND_JOB, { broadcastId, recipientKeys: [contactKey], attempt: (broadcast.fanout_attempt ?? 0) + 1, redrive: true }, immediate)`.
  `unresolved`: `closeRecipientIfQueued(broadcastId, contactKey, SEND_UNCONFIRMED_CODE, 'unconfirmed')` -> `closeFromReconcile(unresolved, cause)` -> ERROR -> `finalize`.
- **relay_leg** `found`: `claimRelaySidPointer` already won in the loop; `persistRelayRecipientResult(messages, legPayload, memberKey, { status: statusFor(m), sid, sentAt: m.sentAt ?? m.createdAt, errorCode? }, transport)` with `transport` from the SOURCE row's `transport_schema_version` (read consistently); `closeFromReconcile(adopted, sid)`. `never_sent`: sendability pre-check (`conversation.status === 'open'`, member on roster, source row present) else `closeRelayRecipientIfUnsent(... REDRIVE_REFUSED_CODE)` + `closeFromReconcile(redrive_refused)`; then `markRedriven` -> `enqueue(RELAY_FANOUT_JOB, { relayConversationId, sourceTsMsgId, senderKey: continuation.senderKey, senderNameOverride?, recipientKeys: [memberKey], attempt: (source.fanout_attempt ?? 0) + 1, redrive: true }, immediate)`; a missing `continuation` (should not happen) -> `redrive_refused` with cause `no_continuation`. `unresolved`: `closeRelayRecipientIfUnsent(... SEND_UNCONFIRMED_CODE)` -> `closeFromReconcile` -> ERROR.
- **relay_rung**: as relay_leg on the RETRY row (`legPayload.sourceTsMsgId = retryTsMsgId`), plus the preserving inbox touch on adoption (`touchLastActivityPreservingStatus(conversationId, undefined, nowIso)` only when `conversation.last_activity_at < m.createdAt`), and `never_sent` re-enqueues `RELAY_RETRY_LEG_JOB` with `{ relayConversationId, retryTsMsgId, redrive: true }` immediately; every close emits the root close the way the rung does (`message.persisted` on `relay_retry_of` with `deliveryStatus: 'failed'`).

`statusFor(m)` per owner: provider `accepted|queued|sending|sent` -> broadcast `sent` (`carrierSentAt` = `m.sentAt` when the provider status is `sent`), relay `queued` for `queued`/`accepted`/`sending` else `sent`; `delivered|read` -> `delivered`; `undelivered` -> broadcast `failed` + code, relay `undelivered` + code; `failed|canceled` -> `failed` + code. The broadcast owner's 30005/30006 arm (`contacts.setFlag(contactId, 'sms_unreachable')`) applies on an adopted failure with those codes; relay records the code only. Adoption WARNs `adopted terminal failure - webhook side effects skipped` naming the code.

Logging (D16): `found` INFO `{ owner, sid, repair }`; `never_sent` WARN; `unresolved` ERROR `{ owner, recipientKey (log-safe), cause }` exactly once; every line carries `event: 'send_reconcile'`.

- [ ] **Step 1: Failing unit tests (`app/test/sendReconcile.test.ts`)** over `createFakeWorld()` + the real jobs envelope (Task 7's machinery), seeding `world.providerMessages` for the harness adapter's `listMessages`:

Cases (one `it` each, asserting the record, the slot(s), the enqueues and the log level):
1. known SID -> fetch (spy `getMessage`), no `listMessages` call, adopted with the fetched status; digest check skipped.
2. listed orphan `delivered` -> broadcast slot `delivered` with `carrierSentAt`, message row appended with `automated: true` (no `created_via`) and `recipient_contact_id` when the contact holds the phone; milestone + listing-send written; record `done/adopted`; broadcast finalized `sent`.
3. listed orphan `undelivered` 30005 on a broadcast -> slot `failed` `30005`, contact flagged `sms_unreachable`, NO milestone, NO listing-send row; on a relay leg -> slot `undelivered` `30005`, no flag.
4. empty at check 0, populated at check 1 -> `continue` then adopted; the check-1 envelope's delay measured from the attempt.
5. candidate held by ANOTHER owner (seed a `sid#` pointer for a row with a different `broadcast_id`) -> excluded; held by THIS owner -> `found` repair.
6. the spike's Smart-Encoded body matches its submitted body; a media-only message matches on media count.
7. two attempts with identical text bodies and two orphans -> each adopts one (relay: `claimRelaySidPointer` decides), neither re-drives.
8. two MEDIA attempts with the same fingerprint and ONE orphan -> one adopted, the other `unresolved` cause `same_fingerprint_sibling` at the last check, never a re-drive.
9. a STOP auto-reply in the window -> ignored at checks 0-1, `unresolved` cause `unidentified_candidate` at check 2.
10. a multi-page list is walked (harness adapter paginates at a small size the test sets); the bound exceeded -> `unresolved` cause `page_bound`.
11. empty window through all three checks -> `never_sent`; broadcast re-drive envelope `{ recipientKeys: [k], redrive: true }`; a second `never_sent` delivery -> `markRedriven` false, no second enqueue.
12. adapter throws on every check -> `unresolved` cause `provider_unreachable`, exactly one ERROR.
13. digest mismatch (contact phone changed) -> `unresolved` cause `digest_mismatch` - Review Focus 2; a candidate created 59 s before the attempt IS considered - Review Focus 4.
14. a payload for an older `attemptedAt` writes nothing; a redelivered check (same payload twice) records once and enqueues at most one extra successor that converges.
15. relay `never_sent` on a closed group -> `redrive_refused` slot + record, no enqueue; on an open group -> a `relay.fanOut` envelope with `redrive: true`, `senderKey` from the continuation.
16. relay_rung adoption touches the inbox the preserving way and emits the root close on every close.
17. an enqueue that throws after `never_sent` closes `enqueue_failed` (Retry stays); after any other verdict `unresolved` cause `enqueue_failed`.
18. `reconcileCheckDelaysMs` honors the lane env only when `JOBS_QUEUE_URL` is unset.

- [ ] **Step 2: Failing integration test (`app/test/sendReconcile.integration.test.ts`)**: over the REAL repos on DynamoDB Local, run the same `found` adoption twice for a relay leg and for a broadcast recipient and assert one pointer, one message row, one slot move, one stats bump, one record transition; and that an adoption cannot regress a slot a receipt already advanced (write the slot `delivered` via `updateRecipientDeliveryStatus` first, then adopt as `sent` -> slot stays `delivered`).

- [ ] **Step 3: Implement** the job, the registration, Task 7's two exports, and the harness adapter's paginating `listMessages` (page size from `world.listPageSize`, default 1000).

- [ ] **Step 4: Run, typecheck, commit**

Run: `cd app; npx vitest run test/sendReconcile.test.ts test/sendReconcile.integration.test.ts test/broadcastFanOut.test.ts test/relayFanOut.test.ts test/relayRetryLeg.test.ts` -> PASS. `npm run typecheck` -> 0.

```powershell
git status
git add app/src/jobs/sendReconcile.ts app/src/jobs/registerHandlers.ts app/src/jobs/broadcastFanOut.ts app/test/sendReconcile.test.ts app/test/sendReconcile.integration.test.ts app/test/helpers/twilioWebhookHarness.ts
git commit -m "feat(jobs): send.reconcile - look an ambiguous send up at the provider, adopt it, re-drive it once, or close it unresolved" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Slice D - fake-twilio and e2e

### Task 11: fake-twilio - Messages list and fetch routes, the fail-next-send seam (D19)

**Files:**
- Modify: `fake-twilio/src/routes/rest.ts` (the create handler :33-70; add GET list and GET fetch)
- Modify: `fake-twilio/src/routes/control.ts` (add `POST /control/fail-next-send`)
- Modify: `fake-twilio/src/engine/engine.ts` (`recordOutboundFromApp` :404-536; add `takeFailNextSend(partyNumber)`, `setFailNextSend(input)`, `getMessageBySid(sid)`, `listMessagesTo(to, from)`), `fake-twilio/src/engine/store.ts` (by-SID getter :7), `fake-twilio/src/engine/types.ts`
- Test: `fake-twilio/test/rest.test.ts`, `fake-twilio/test/control.test.ts`
- Modify: `e2e/fixtures/fakeTwilio.ts` (add `failNextSend(request, input)` and `getMessageBySid(request, sid)` helpers)

**Interfaces:**
- Produces:
  - `GET /2010-04-01/Accounts/:accountSid/Messages.json?To=&From=&PageSize=&PageToken=` -> Twilio list JSON `{ messages: [...], next_page_uri, page, page_size, first_page_uri, previous_page_uri, uri, start, end }`, newest first; `PageToken` is the fake's own opaque cursor (the offset); `next_page_uri` is a PATH with `PageToken=` (the SDK resolves it to an absolute URL and calls `getPage`; the redirecting HTTP client rewrites only the origin - reference Sec 5).
  - `GET /2010-04-01/Accounts/:accountSid/Messages/:sid.json` -> one resource, or 404 `{ code: 20404, message, more_info, status: 404 }`.
  - Resource shape: `sid, status, to, from, body (SMART-ENCODED at serialization: U+2018/U+2019 -> ', U+201C/U+201D -> ", U+2013/U+2014 -> -, U+2026 -> ..., NBSP -> space), num_media (string), error_code (int or null), date_created, date_sent (RFC 2822 or null), messaging_service_sid, direction`.
  - `POST /control/fail-next-send` body `{ partyNumber: string; mode: 'reject' | 'drop_before_create' | 'accept_then_drop'; code?: number; count?: number }` (default count 1) -> `{ ok: true }`; consumed by the NEXT `count` creates TO that party: `reject` answers `400 { code: code ?? 21211, message: 'fail-next-send', more_info, status: 400 }` without recording; `drop_before_create` destroys the socket without recording; `accept_then_drop` records the message (callbacks fire as normal) and destroys the socket without responding.
  - `e2e/fixtures/fakeTwilio.ts`: `failNextSend(request, { partyNumber, mode, code?, count? })`, `getMessageBySid(request, sid): Promise<FakeMessageResource | undefined>`.
- Store: `ThreadMessage` gains `createdAt` already (`:36-51` has it); add `errorCode` already there; add a private `bySid` getter `messageBySid(sid)`; keep ONE `date_created` per message (the stored `createdAt`), never re-derived at serialization.

- [ ] **Step 1: Failing fake tests**

```ts
// fake-twilio/test/rest.test.ts (new cases)
it('lists messages by To and From newest first with Twilio paging', async () => {
  for (const b of ['one', 'two', 'three']) await request(app).post('/2010-04-01/Accounts/ACtest/Messages.json').type('form').send({ To: '+16175550100', From: '+15550009999', Body: b });
  const page1 = await request(app).get('/2010-04-01/Accounts/ACtest/Messages.json').query({ To: '+16175550100', From: '+15550009999', PageSize: 2 });
  expect(page1.status).toBe(200);
  expect(page1.body.messages.map((m: { body: string }) => m.body)).toEqual(['three', 'two']);
  expect(page1.body.next_page_uri).toMatch(/PageToken=/);
  const page2 = await request(app).get(page1.body.next_page_uri);
  expect(page2.body.messages.map((m: { body: string }) => m.body)).toEqual(['one']);
  expect(page2.body.next_page_uri).toBeNull();
  expect(page1.body.messages[0]).toMatchObject({ num_media: '0', error_code: null, direction: 'outbound-api' });
  expect(typeof page1.body.messages[0].date_created).toBe('string');
});
it('stores the Smart-Encoded body the way Twilio does', async () => {
  const submitted = 'HC ’q’ d—d m…';
  const created = await request(app).post('/2010-04-01/Accounts/ACtest/Messages.json').type('form').send({ To: '+16175550100', From: '+15550009999', Body: submitted });
  expect(created.body.body).toBe(submitted);                    // the create response echoes
  const fetched = await request(app).get(`/2010-04-01/Accounts/ACtest/Messages/${created.body.sid}.json`);
  expect(fetched.body.body).toBe("HC 'q' d-d m...");            // fetch and list are re-encoded
});
it('fetch of an unknown SID is a Twilio 404', async () => {
  const r = await request(app).get('/2010-04-01/Accounts/ACtest/Messages/SMnope.json');
  expect(r.status).toBe(404); expect(r.body).toMatchObject({ code: 20404, status: 404 });
});
```

```ts
// fake-twilio/test/control.test.ts (new cases)
it('fail-next-send reject answers a Twilio 4xx and records nothing', async () => {
  await request(app).post('/control/fail-next-send').send({ partyNumber: '+16175550100', mode: 'reject', code: 21211 }).expect(200);
  const r = await request(app).post('/2010-04-01/Accounts/ACtest/Messages.json').type('form').send({ To: '+16175550100', From: '+15550009999', Body: 'x' });
  expect(r.status).toBe(400); expect(r.body.code).toBe(21211);
  expect(engine.listThreads().find((t) => t.partyNumber === '+16175550100')?.messages ?? []).toHaveLength(0);
  await request(app).post('/2010-04-01/Accounts/ACtest/Messages.json').type('form').send({ To: '+16175550100', From: '+15550009999', Body: 'y' }).expect(201);   // consumed
});
it('accept_then_drop records the message and drops the connection', async () => {
  await request(app).post('/control/fail-next-send').send({ partyNumber: '+16175550100', mode: 'accept_then_drop' }).expect(200);
  await expect(request(app).post('/2010-04-01/Accounts/ACtest/Messages.json').type('form').send({ To: '+16175550100', From: '+15550009999', Body: 'z' })).rejects.toThrow(/socket hang up|ECONNRESET|aborted/);
  expect(engine.listThreads().find((t) => t.partyNumber === '+16175550100')!.messages.map((m) => m.body)).toEqual(['z']);
});
it('drop_before_create records nothing and drops the connection', async () => { /* same shape, thread empty */ });
```

Run: `npm run test -w @housingchoice/fake-twilio` -> the new cases FAIL.

- [ ] **Step 2: Implement**

- `engine/types.ts`: `export type FailNextSendMode = 'reject' | 'drop_before_create' | 'accept_then_drop'; export interface FailNextSendInput { partyNumber: string; mode: FailNextSendMode; code?: number; count?: number }`.
- `engine/engine.ts`: `private readonly failNextSend = new Map<string, { mode; code?; remaining: number }>()`; `setFailNextSend(input)`; `takeFailNextSend(partyNumber): { mode; code? } | undefined` (decrements, deletes at 0); `getMessageBySid(sid): ThreadMessage | undefined` (via a new `store.messageBySid`); `listMessagesTo(to: string, from: string): ThreadMessage[]` = the thread's outbound messages with `from === from`, newest first by `createdAt` then insertion; `reset()` clears the map.
- `engine/store.ts`: `messageBySid(sid)` returning from `bySid`.
- `routes/rest.ts`: a `smartEncode(body)` helper (the mapping above; exported for the test); in the create handler, after `To` validation: `const fail = engine.takeFailNextSend(to); if (fail?.mode === 'reject') { res.status(400).json({ code: fail.code ?? 21211, message: 'fail-next-send: rejected by the fake', more_info: 'https://www.twilio.com/docs/errors/21211', status: 400 }); return; } if (fail?.mode === 'drop_before_create') { req.socket.destroy(); return; }` ... after `recordOutboundFromApp`: `if (fail?.mode === 'accept_then_drop') { req.socket.destroy(); return; }`. Add `toMessageResource(m: ThreadMessage): TwilioMessageResource` (`body: smartEncode(m.body ?? '')`, `num_media: String(m.mediaUrls?.length ?? 0)`, `error_code: m.errorCode ? Number(m.errorCode) : null`, `date_created: new Date(m.createdAt).toUTCString()`, `date_sent: m.state === 'queued' ? null : new Date(m.updatedAt).toUTCString()`, `status: m.state`, `direction: 'outbound-api'`, `to`, `from`, `sid`, `messaging_service_sid: 'MGfake'`). GET list: parse `To`, `From`, `PageSize` (default 50, max 1000), `PageToken` (integer offset, default 0); slice; `next_page_uri` = `/2010-04-01/Accounts/${accountSid}/Messages.json?To=...&From=...&PageSize=...&PageToken=${offset + size}` or `null`. GET fetch: 404 shape when unknown.
- `routes/control.ts`: `router.post('/control/fail-next-send', (req, res) => { try { engine.setFailNextSend(req.body as FailNextSendInput); res.status(200).json({ ok: true }); } catch (err) { res.status(400).json({ error: (err as Error).message }); } });` with input validation (partyNumber E.164 string, mode in the set, count positive integer).
- `e2e/fixtures/fakeTwilio.ts`: the two helpers on the `setDeliveryOutcome` pattern (`:354`).

- [ ] **Step 3: Run the fake's suite, commit**

Run: `npm run test -w @housingchoice/fake-twilio` -> PASS.

```powershell
git status
git add fake-twilio/src/routes/rest.ts fake-twilio/src/routes/control.ts fake-twilio/src/engine/engine.ts fake-twilio/src/engine/store.ts fake-twilio/src/engine/types.ts fake-twilio/test/rest.test.ts fake-twilio/test/control.test.ts e2e/fixtures/fakeTwilio.ts
git commit -m "feat(fake-twilio): Messages list and fetch with Smart-Encoded bodies; a fail-next-send control seam" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 12: Lane seams and the three e2e specs (D13a, D19, Sec 8)

**Files:**
- Modify: `scripts/e2e-session.mjs` `childEnv` (beside `:272-282`): add `E2E_SEND_RECONCILE_DELAYS_MS: '2000,4000,8000'` with a comment naming this branch and the topology guard.
- Create: `e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts`
- Modify: `e2e/support/selectors.md` only if a new role/label is introduced (the "Not confirmed" chip is a `<dt>` inside `Delivery stats`; the recipient row text is `Not confirmed - Couldn't confirm whether this text went out`).

**Interfaces:**
- Consumes: Task 11's helpers; `createGroupOpen`, `sendAsParty`, `getOutboundTo`, `listThreads`, `setDeliveryOutcome` (fixtures); the dev-login and reseed helpers; the broadcasts spec's `statValue` / `statusPill` helpers (`e2e/tests/dashboard-next/broadcasts.spec.ts:269-287` - extract them into `e2e/support/broadcastSelectors.ts` if they are file-local, and import from there).
- Produces: three `test()`s under one `describe`, each reseeding `lean` and logging in after, none using `conv-0002` / `contact-tenant-0002` (use Tasha, `conv-0001`, and tenants the spec creates via the API).

- [ ] **Step 1: Write the specs**

```ts
// e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts
test.describe('send outcome reconcile (spec Sec 8 e2e)', () => {
  test.beforeEach(async ({ request, page }) => { await reseedLean(request); await devLogin(page); });

  test('accept_then_drop on a relay leg ends adopted as delivered (the fake\'s early callbacks were dropped)', async ({ page, request }) => {
    const group = await createGroupOpen(request, { members: [/* two ad-hoc parties */] });
    await failNextSend(request, { partyNumber: group.members[1].number, mode: 'accept_then_drop' });
    await sendAsParty(request, { from: group.members[0].number, to: group.poolNumber, body: 'Hello from the sender' });
    // the leg to member 1 was created by the fake, the app saw ECONNRESET -> reconcile
    await page.goto(`/conversations/${group.conversationId}`);
    const row = page.getByRole('list', { name: 'Delivery by recipient' }).getByRole('listitem').filter({ hasText: group.members[1].label });
    await expect(row).toContainText('Delivered', { timeout: 20_000 });      // adopted at check 0 or 1 (2 s / 4 s lane delays)
    const sent = await getOutboundTo(request, { to: group.members[1].number });
    expect(sent).toHaveLength(1);                                             // never re-sent
  });

  test('drop_before_create on a broadcast recipient is re-driven once and the share finishes sent', async ({ page, request }) => {
    const tenant = await createTenantWithConsent(request, { phone: '+15550107001' });
    await failNextSend(request, { partyNumber: '+15550107001', mode: 'drop_before_create' });
    const broadcast = await createAndSendShare(request, { seedContactIds: [tenant.contactId], body: 'A property for you' });
    await page.goto(`/broadcasts/${broadcast.broadcastId}`);
    await expect.poll(() => statValue(page, 'Delivered'), { timeout: 40_000 }).toBe(1);   // never_sent at check 2 (8 s) -> re-drive -> delivered
    await expect(statusPill(page, 'Sent')).toBeVisible();
    expect(await getOutboundTo(request, { to: '+15550107001' })).toHaveLength(1);
  });

  test('reject with 21211 marks the recipient failed with that code and the rest of the audience sent', async ({ page, request }) => {
    const [a, b] = await Promise.all([createTenantWithConsent(request, { phone: '+15550107002' }), createTenantWithConsent(request, { phone: '+15550107003' })]);
    await failNextSend(request, { partyNumber: '+15550107002', mode: 'reject', code: 21211 });
    const broadcast = await createAndSendShare(request, { seedContactIds: [a.contactId, b.contactId], body: 'A property for you' });
    await page.goto(`/broadcasts/${broadcast.broadcastId}`);
    await expect.poll(() => statValue(page, 'Failed')).toBe(1);
    await expect.poll(() => statValue(page, 'Delivered')).toBe(1);
    const list = page.getByRole('list', { name: 'Recipients' });
    await expect(list.getByText(/Number is invalid \(error 21211\)/)).toBeVisible();
    await expect(page.getByLabel('Delivery stats').getByText('Not confirmed')).toBeVisible();   // the chip exists, value 0
  });
});
```

(`reseedLean`, `devLogin`, `createTenantWithConsent`, `createAndSendShare` are
the names of the existing helpers in `e2e/support` / `e2e/fixtures` - use the
real names found there; `createTenantWithConsent` must set
`consent_method: 'inbound_text'` so the share is not skipped.)

- [ ] **Step 2: Run the single spec on a fresh lane, then the full suite**

Run (from the repo root of the WORKTREE): `npm run e2e:session` ... drive the spec with the Playwright MCP, or `timeout 1500 npm run e2e` for the whole suite. A running lane must be BOOTED FRESH to pick up the `childEnv` change (`e2e:restart` keeps the launcher's old env).
Expected: 3 passed; no other spec regresses (the broadcasts spec's terminal-buckets poll `toEqual({ delivered, sent: 0, sending: 0, queued: 0 })` stays green because it names only those four keys).

- [ ] **Step 3: Commit**

```powershell
git status
git add scripts/e2e-session.mjs e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts e2e/support/broadcastSelectors.ts e2e/tests/dashboard-next/broadcasts.spec.ts
git commit -m "test(e2e): prove adoption, re-drive and rejection end to end through the fake's fail-next-send seam" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Slice E - dashboard

### Task 13: Codes, copy, aging and the join (D20, D20a, D21, D23)

**Files:**
- Modify: `dashboard/src/routes/contact/deliveryStatus.ts` (`RelayDeliverySlot` :157-163 gains `attemptedAt?: string`; `stalenessClockMs` :228-255; `presentRelayDelivery` K/J :483-505 and the reason join :567-570; `presentLegDelivery` :668-770; `INTERNAL_CODE_REASONS` :927-958)
- Modify: `dashboard/src/api/types.ts:1753-1773` (`RelayRecipientDelivery.attemptedAt?: string`, mirror comment)
- Create: `dashboard/src/routes/contact/sendOutcomeCodesMirror.test.ts` (the `relayWindowCloseMirror.test.ts` idiom)
- Test: `dashboard/src/routes/contact/deliveryStatus.test.ts`, `Timeline.delivery.test.tsx`, `Timeline.ticker.test.tsx`, `relayRetryJoin.test.ts`, `useRelayThread.test.tsx`

**Interfaces:**
- Consumes: the app constants from `app/src/lib/sendOutcome.ts` (mirror test only - the dashboard never imports app VALUES at runtime; the mirror test imports them the way `relayWindowCloseMirror.test.ts` does).
- Produces: `export const SEND_UNCONFIRMED_CODE = 'send_unconfirmed'`, `REDRIVE_REFUSED_CODE`, `SEND_RETRYABLE_CODE`, `SMS_SENDING_DISABLED_CODE` in `deliveryStatus.ts`; `NOT_CONFIRMED_PRESENTATION: DeliveryPresentation = { label: 'Not confirmed', tone: 'danger', isFailure: false, reason: "Couldn't confirm whether this text went out" }`.

- [ ] **Step 1: Failing tests**

```ts
// deliveryStatus.test.ts (new describes)
describe('send_unconfirmed (spec D20/D21)', () => {
  it('presents by code alone on a failed, an undelivered and a queued slot', () => {
    for (const status of ['failed', 'undelivered'] as const) {
      expect(presentLegDelivery({ status, errorCode: 'send_unconfirmed' }, 'relay')).toEqual({ label: 'Not confirmed', tone: 'danger', isFailure: false, reason: "Couldn't confirm whether this text went out" });
    }
    expect(presentLegDelivery({ status: 'queued', errorCode: 'send_unconfirmed' }, 'relay')).toEqual({ label: 'Not confirmed', tone: 'danger', isFailure: false, reason: "Couldn't confirm whether this text went out" });
  });
  it('the rollup counts it under not confirmed, never failed, with the reason', () => {
    const p = presentRelayDelivery([{ status: 'delivered' }, { status: 'failed', errorCode: 'send_unconfirmed' }], { relay: true });
    expect(p).toEqual({ label: 'delivered 1/2 - 1 not confirmed', tone: 'danger', isFailure: false, reason: "Couldn't confirm whether this text went out" });
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
});
describe('a queued leg ages from attemptedAt when it has no sentAt (D20a)', () => {
  it('stales after the budget and can go stale', () => {
    const slot = { status: 'queued' as const, attemptedAt: new Date(L0).toISOString() };
    expect(isStaleLeg(slot, undefined, NOW)).toBe(true);
    expect(canEverGoStale(slot, undefined, L0 + 1000)).toBe(true);
    expect(presentLegDelivery(slot, 'relay', undefined, NOW)).toEqual(STALE_QUEUED_EXPECTATION);
  });
  it('a queued leg with neither clock still never stales (row 4 of the S3 table)', () => {
    expect(isStaleLeg({ status: 'queued' }, undefined, NOW)).toBe(false);
  });
  it('sentAt wins over attemptedAt', () => { /* sentAt fresh, attemptedAt ancient -> not stale */ });
});
```

Update the copy pins for `transient_cap` (`deliveryStatus.test.ts:377, :781, :839, :876, :894`; `Timeline.delivery.test.tsx:388, :396-397, :423`; `StatChips.test.tsx:152`; `broadcastFormat.test.ts:153`) to the new wording; add a `Timeline.delivery.test.tsx` three-position case for an `undelivered` root leg whose terminal rung code is `send_unconfirmed` (chip `delivered 1/2 - 1 not confirmed - Couldn't confirm whether this text went out`, accessible name `/Lars Landlord: Not confirmed, Couldn't confirm whether this text went out/`, revealed row `Not confirmed - Couldn't confirm whether this text went out`); a `Timeline.ticker.test.tsx` ARMING case for a queued leg with `attemptedAt` and no `sentAt`; a `relayRetryJoin.test.ts` case that a terminal rung closed `send_unconfirmed` projects `{ errorCode: 'send_unconfirmed', retryState: 'terminal' }` with the original's status; a `useRelayThread.test.tsx` passthrough assertion for `attemptedAt`.

The mirror test:

```ts
// dashboard/src/routes/contact/sendOutcomeCodesMirror.test.ts
import { REDRIVE_REFUSED_CODE as APP_REDRIVE_REFUSED_CODE, SEND_RETRYABLE_CODE as APP_SEND_RETRYABLE_CODE, SEND_UNCONFIRMED_CODE as APP_SEND_UNCONFIRMED_CODE, SMS_SENDING_DISABLED_CODE as APP_SMS_SENDING_DISABLED_CODE } from '../../../../app/src/lib/sendOutcome.js';
import { deliveryReason, REDRIVE_REFUSED_CODE, SEND_RETRYABLE_CODE, SEND_UNCONFIRMED_CODE, SMS_SENDING_DISABLED_CODE } from './deliveryStatus.js';
describe('send-outcome codes mirror the app constants', () => {
  it.each([[SEND_UNCONFIRMED_CODE, APP_SEND_UNCONFIRMED_CODE], [REDRIVE_REFUSED_CODE, APP_REDRIVE_REFUSED_CODE], [SEND_RETRYABLE_CODE, APP_SEND_RETRYABLE_CODE], [SMS_SENDING_DISABLED_CODE, APP_SMS_SENDING_DISABLED_CODE]])('%s', (dash, app) => expect(dash).toBe(app));
  it('every closed code has prose and the transient one renders as queued', () => {
    for (const c of [APP_SEND_UNCONFIRMED_CODE, APP_REDRIVE_REFUSED_CODE, APP_SMS_SENDING_DISABLED_CODE]) {
      const r = deliveryReason(c); expect(r).toBeDefined(); expect(r).not.toContain('(error ');
    }
    expect(deliveryReason(APP_SEND_RETRYABLE_CODE)).toBeUndefined();   // transient: no reason, the slot renders as queued
  });
});
```

Run: `npm run test -w @housingchoice/dashboard -- src/routes/contact` -> the new cases FAIL.

- [ ] **Step 2: Implement**

- Constants + `NOT_CONFIRMED_PRESENTATION` exported from `deliveryStatus.ts`.
- `INTERNAL_CODE_REASONS`: add the three entries; change `transient_cap` to `'Sending gave up after repeated temporary errors'`; `deliveryReason` returns `undefined` for `send_retryable` (add an explicit early return so it never prints `Delivery failed (error send_retryable)`).
- `presentLegDelivery`: insert, right after the `contact_opted_out` arm (`:689-700`), `if (slot.errorCode === SEND_UNCONFIRMED_CODE) return { ...NOT_CONFIRMED_PRESENTATION };` (code alone, any status, carries its own reason - D20).
- `presentRelayDelivery`: `failedLegs` excludes `s.errorCode === SEND_UNCONFIRMED_CODE`; `notConfirmedLegs` includes any leg with that code; the branch-2 reason join includes those legs (the `unconfirmedRetryLegs` filter at `:567-569` widens to `retryStateOf(s) === 'unconfirmed' || s.errorCode === SEND_UNCONFIRMED_CODE`).
- `stalenessClockMs`: `case 'queued': return legClock ?? parseWireClock(slot.attemptedAt);` and rewrite the doc table row and the `:213-224` rationale (drop the false "server staleness alarm" sentence; say `attemptedAt` is OUR attempt clock, best-effort).
- Types: `attemptedAt?: string` on `RelayDeliverySlot` and on `RelayRecipientDelivery` (api/types.ts) with the mirror note.
- `relayRetryJoin.ts`: no logic change (`withDecidingRung` already keeps unnamed fields); only the test.

- [ ] **Step 3: Run, typecheck, commit**

Run: `npm run test -w @housingchoice/dashboard -- src/routes/contact src/routes/conversation` -> PASS. `npm run typecheck -w @housingchoice/dashboard` -> 0.

```powershell
git status
git add dashboard/src/routes/contact/deliveryStatus.ts dashboard/src/api/types.ts dashboard/src/routes/contact/sendOutcomeCodesMirror.test.ts dashboard/src/routes/contact/deliveryStatus.test.ts dashboard/src/routes/contact/Timeline.delivery.test.tsx dashboard/src/routes/contact/Timeline.ticker.test.tsx dashboard/src/routes/contact/relayRetryJoin.test.ts dashboard/src/routes/conversation/useRelayThread.test.tsx
git commit -m "feat(dashboard): Not confirmed by code alone, the new internal codes' copy, and a queued leg that ages from its attempt clock" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 14: The broadcast bucket, chip, badge, hint and seeds (D22)

**Files:**
- Modify: `dashboard/src/api/types.ts:2906-2929` (`BroadcastStats.unconfirmed?: number`), `:2955-2984` nothing (broadcast slots carry no `attemptedAt`)
- Modify: `dashboard/src/routes/broadcasts/broadcastFormat.ts` (`presentRecipientStatus` :126-142 gains `errorCode?: string`; `shareRecipientReason` :151-161 unchanged in logic - the internal map answers), `StatChips.tsx:27-36`, `DeliveryBadge.tsx:34` (pass `errorCode`), `BroadcastResults.tsx:63-67` (hint suppressed for `send_unconfirmed`)
- Modify: `app/src/lib/seed/matrix.ts:1229-1231, :1252` and `app/src/lib/seed/performance.ts:995-1009` (`unconfirmed: 0`)
- Test: `StatChips.test.tsx`, `broadcastFormat.test.ts`, `BroadcastResults.test.tsx`, `app/test/performanceSeed.test.ts` (unchanged assertions; run it)

- [ ] **Step 1: Failing tests**

```ts
// StatChips.test.tsx
it('renders a Not confirmed chip after Failed, danger only when above zero, and keeps the audience sum', () => {
  render(<StatChips stats={stats({ audience: 4, delivered: 2, failed: 1, unconfirmed: 1 })} />);
  expect(labels()).toEqual(['Recipients', 'Delivered', 'Sent', 'Sending', 'Queued', 'Failed', 'Not confirmed', 'Skipped']);
  expect(chipValue(list, 'Not confirmed')).toBe(1);
});
it('a legacy stats object without the bucket renders 0', () => { /* stats({}) has no unconfirmed -> chip 0, no danger class */ });
// broadcastFormat.test.ts
it('presentRecipientStatus keys on send_unconfirmed before status', () => {
  expect(presentRecipientStatus('failed', undefined, 'send_unconfirmed')).toEqual({ label: 'Not confirmed', tone: 'danger', isFailure: false, reason: "Couldn't confirm whether this text went out" });
  expect(presentRecipientStatus('failed', undefined, '30007').isFailure).toBe(true);
});
it('shareRecipientReason answers the internal map for a failed send_unconfirmed row', () => {
  expect(shareRecipientReason('failed', 'send_unconfirmed')).toBe("Couldn't confirm whether this text went out");
});
it('skippedTotal never includes unconfirmed', () => { expect(skippedTotal(stats({ unconfirmed: 5 }))).toBe(0); });
// BroadcastResults.test.tsx
it('an unconfirmed row reads Not confirmed with its reason and offers no retry hint', async () => {
  /* results({ recipients: { c1: { status: 'failed', errorCode: 'send_unconfirmed', firstName: 'Ana' } } }); expect row text 'Not confirmed' + reason; expect no link named /open conversation to retry/ */
});
```

Run: `npm run test -w @housingchoice/dashboard -- src/routes/broadcasts` -> FAIL.

- [ ] **Step 2: Implement**

- `BroadcastStats.unconfirmed?: number` (dashboard type; doc: closed failed slots carrying `send_unconfirmed`; optional; readers `?? 0`).
- `StatChips.tsx`: insert `{ label: 'Not confirmed', value: stats.unconfirmed ?? 0, tone: 'danger' }` after Failed; the header doc's balance line gains `+ Not confirmed`.
- `presentRecipientStatus(status, carrierSentAt?, errorCode?)`: first line `if (errorCode === SEND_UNCONFIRMED_CODE) return { ...NOT_CONFIRMED_PRESENTATION };` (import both from `deliveryStatus.ts`).
- `DeliveryBadge.tsx:34`: `presentRecipientStatus(status, carrierSentAt, errorCode)`; the reason renders as today (`shareRecipientReason` -> `deliveryReason` -> the internal map).
- `BroadcastResults.tsx:63-67`: `const failed = row.status === 'failed' && row.errorCode !== 'send_unconfirmed';` for the HINT only; keep the red styling and failed-first sort on `row.status === 'failed'` (D20: a danger-toned row sorted first is right) - so split the two booleans (`failedStyle` vs `showRetryHint`).
- Seeds: add `unconfirmed: 0` to the three stats literals; `app/test/performanceSeed.test.ts` is unaffected (asserts audience only) - run it.

- [ ] **Step 3: Run, typecheck, commit**

Run: `npm run test -w @housingchoice/dashboard -- src/routes/broadcasts` and `cd app; npx vitest run test/performanceSeed.test.ts test/deriveBroadcastStats.test.ts` -> PASS. `npm run typecheck` -> 0.

```powershell
git status
git add dashboard/src/api/types.ts dashboard/src/routes/broadcasts/broadcastFormat.ts dashboard/src/routes/broadcasts/StatChips.tsx dashboard/src/routes/broadcasts/DeliveryBadge.tsx dashboard/src/routes/broadcasts/BroadcastResults.tsx dashboard/src/routes/broadcasts/StatChips.test.tsx dashboard/src/routes/broadcasts/broadcastFormat.test.ts dashboard/src/routes/broadcasts/BroadcastResults.test.tsx app/src/lib/seed/matrix.ts app/src/lib/seed/performance.ts
git commit -m "feat(dashboard): the Not confirmed bucket and chip, the unconfirmed recipient row without a retry hint, seeds carry the bucket" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

## Slice F - records, self-QA, gates

### Task 15: Issue registry updates owed by the design (Sec 2, Sec 9)

**Files:**
- Modify: `docs/issues/fanout-close-path-robustness-residues.md` (dated section: the D7a failure-arm write that itself fails is this issue's "throwing close" class one step earlier; cite the new arms by file:line)
- Modify: `docs/issues/fanout-pass-setup-throw-strands-pass.md` (dated section: the relay retry rung's pre-claim throws - the row read, the lineage check, the conversation read, a suppression read that rejects, the no-pool throw - and a re-drive continuation's early returns, which strand a `redriven` record; cite by file:line at HEAD)
- Modify: `docs/issues/manual-retry-double-send-residual-windows.md` (dated note beside gap 5: the status webhook's `closeRetryLegEnqueueFailed` is a close by another writer the D8 gate cannot cover - fenced file)
- Modify: `docs/issues/send-attempt-sweeper.md` (dated section: the record's exact key shapes, states and clocks as built, so the sweeper's author reads them from the registry)
- Modify: `docs/issues/throw-for-redelivery-defeated-by-job-marker.md` (dated section: built on this branch for both fan-outs and the relay retry rung; the `TODO(throw-for-redelivery-defeated-by-job-marker)` markers are gone from the tree; status still `open` - it closes at merge, when the human sets `status: resolved` and `resolved:` in the same commit as the merge or right after)

- [ ] **Step 1: Write the sections** (ASCII; cite code by file:line; do not paste code). Run `npm run issues` (regenerates the gitignored INDEX; must exit 0).
- [ ] **Step 2: Commit**

```powershell
git status
git add docs/issues/fanout-close-path-robustness-residues.md docs/issues/fanout-pass-setup-throw-strands-pass.md docs/issues/manual-retry-double-send-residual-windows.md docs/issues/send-attempt-sweeper.md docs/issues/throw-for-redelivery-defeated-by-job-marker.md
git commit -m "docs(issues): record the residues this branch leaves and the record shapes the sweeper will read" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 16: Live self-QA on a hermetic lane (the profile's harness)

- [ ] **Step 1:** `npm run e2e:session` on a FRESH lane (the `childEnv` seam must be picked up), dev-login, reseed `lean`.
- [ ] **Step 2:** Drive the three D19 scenarios by hand with the Playwright MCP and the fake's control routes, and record in `docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/self-qa.md` (screenshots under `.playwright-mcp/`):
  - relay `accept_then_drop`: the group thread's per-recipient row reads `Delivered` for the affected member within the lane's reconcile delays; the fake's thread shows ONE outbound to that member; the worker log has one `send_reconcile` INFO `found`.
  - broadcast `drop_before_create`: the results page's `Delivered` chip reaches the audience; `Not confirmed` chip 0; the pill `Sent`; ONE outbound in the fake.
  - broadcast with the fake stopped mid-run (kill the fake process for the three checks): the recipient row reads `Not confirmed - Couldn't confirm whether this text went out`, the `Not confirmed` chip 1, no `open conversation to retry` hint, the pill `Failed` with the prose `last_error` when it was the only recipient; exactly one ERROR line in the worker log.
  - a relay leg left `queued` with `attemptedAt` (stop the worker between the claim and the send by pausing the process) reads `Queued - not confirmed` after 15 minutes of ticker time (advance the browser clock or wait).
- [ ] **Step 3:** `npm run e2e:stop`. Commit the record.

```powershell
git status
git add docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/self-qa.md
git commit -m "docs(reviews): live self-QA - adoption, re-drive, unresolved and the attempt-clock aging on a hermetic lane" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 17: Drift report, complete gates, handback

- [ ] **Step 1: Drift, not a re-merge.** The branch's one main sync is done (a9f411f3). Run `git -C W:\tmp\send-outcome-reconcile rev-list --count HEAD..main` and `git log --oneline HEAD..main`; list the drift in the handback. Re-merge ONLY if the planner says so.
- [ ] **Step 2: Run the five gates BARE from the worktree, each its own command, under a hard outer timeout for the two long ones:**

```powershell
npm run typecheck
npm test
npm run smoke
timeout 1500 npm run e2e
npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')
```

Report every real exit code and count. If `npm test` is red on DynamoDB Local suites: re-run the failing FILE alone more than once, run the full suite at the branch's merge base, compare failing FILES, report both runs (AGENTS.md). Any `[dynamoAdmin]` line in the output is a real container fault - capture `err.$metadata.httpStatusCode` and `attempts` first. Attribute lint errors by BASELINE COMPARISON on the same paths at the merge base; only new ones block.
- [ ] **Step 3: Handback** at `.superpowers/sdd/handback.md` AND committed as `docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/handback.md`: the work map with commits, per-spec-decision conformance table (D1-D23 incl. D3a, D7a, D8a, D13a, D16a, D20a), the quoted gate exit codes and counts, the self-QA pointer, reviewer findings and adjudications (from the orchestrator's own review), the drift list, the residues recorded in Sec 1 with their issue links, and post-merge obligations: NONE infra; the human sets `throw-for-redelivery-defeated-by-job-marker` resolved at merge; Stage 1b (the `retrySend` adoption) is the next worktree; the first hosted-dev run verifies the list walk's order/page bound and the prod service's Smart Encoding (Sec 10). State explicitly: UNMERGED (human gate).

---

## Self-review (planner, against spec revision 9)

- Spec coverage: D1-D2 T1; D3/D3a T3 (+T7/T8 for D3a's rule at the sites); D4 T1; D5-D7 T7/T8/T9; D7a T7/T8/T9; D8 T6 (writes) + T7/T8/T9 (gates); D8a T5 (record) + T7/T8 (claims) + T6 (attemptedAt write); D9 T7/T8; D10 T1/T13; D11 T5/T10; D12 T2/T5/T10; D13/D13a T10 (+T4 port, +T11 fake); D14 - recorded, no task (Sec 1 residue; T15 files the sweeper shape); D15 T10 (+T7's `adoptBroadcastRecipient`); D16 T10; D16a T6 (flip) + T7 (finalize); D17 T4; D18 T10's log lines; D19 T11; D20/D20a/D21/D23 T13; D22 T6/T14; Sec 8 tests 1-16 map to T1(1,13), T3(2), T7(3,4,5,6,7,11,16), T8(3,5,6,7), T9(12), T10(8,9,10,11), T13(14), T14(15); Sec 8 e2e T12; Sec 9 T15; Sec 10 T17.
- Placeholder scan: the `/* ... */` bodies in T7's and T10's test lists state the expectation each test asserts and the seam it uses; the implementer writes the bodies. No "TBD"/"add error handling".
- Type consistency: `AttemptRef`, `SendAttemptOwner`, `ClaimResult`, `SendReconcilePayload`, the outcome kinds and the code constants are defined once (shared block) and used by name in T5-T10, T13-T14.
- Review Focus: RF1 T1 test; RF2 T10 case 13; RF3 T7 test 2; RF4 T10 case 13; RF5 T7 finalize test 2.
