# Retry-Send Adoption (Send-Outcome Stage 1b) - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 3** (after plan review rounds 1-2; adjudications in `docs/superpowers/reviews/2026-09-27-retry-send-adoption/design-review/adjudications.md`, sections "Plan round 1" and "Plan round 2"). This document is self-contained: every test and every code block a task needs is IN that task. Where a code block names a helper, that helper is defined in the task the block cites; where a sketch names a file-local test helper, the sketch defines it.

**Goal:** Move the one-to-one 30003 automatic retry (`messaging.retrySend`) onto the send-attempt record and the `send.reconcile` job, so a retry that errors after its guard is claimed is resolved (adopted, re-driven once, or closed `unresolved` with the retried row marked "retry not confirmed") instead of silently lost, and every retry row carries `retry_root` and `broadcast_id` for share-skip Branch B.

**Architecture:** The job drops the run-once marker and claims a per-(retried row, attempt) record before its provider call (re-armed by `sendMessage`'s `beforeProviderSend` hook) inside SOR's prepare/sending/record try/catch; its arms copy the broadcast pass's as built. `send.reconcile` gains a fourth owner kind (`retry_send`) at every dispatch site, adopts the retry text it finds as a fully attributed retry row, re-drives once inside the RSW window, or closes `unresolved` and withdraws the retried row's promise through a new conditional `annotateRetryPromise`. A new `retrychild#` pointer family, written in `messagesRepo.append`'s transaction for every row with `retryOf`, answers "does this row have a child?" with one consistent Query for the job's supersession check and the manual Retry route's `superseded` refusal. The route reads the attempt record by key; the dashboard renders `retry_outcome: 'unconfirmed'` and hides Retry.

**Tech Stack:** TypeScript (Node 24, ESM), Express, DynamoDB (`@aws-sdk/lib-dynamodb`, DynamoDB Local for integration tests), Vitest, React 19 dashboard, Playwright e2e harness with the in-repo fake-twilio.

**Spec:** `docs/superpowers/specs/2026-09-27-retry-send-adoption-design.md` (revision 5, approved as is). It reads on top of SOR (`docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md`, revision 12; section 12 is the as-built rule set) and RSW (`docs/superpowers/specs/2026-09-24-retry-send-window-design.md`). Decision numbers R1-R12 are this spec's; D-numbers are SOR's.

**Branch / worktree:** `feat/retry-send-adoption` at `W:\tmp\retry-send-adoption`, cut from `main@3dbb5740`. No main sync has been done; Task 9 REPORTS drift and does NOT merge main without the planner's word.

**One deliverable, not nine.** The slices below are commit-and-review checkpoints, NOT shippable states: after Task 2 the reconcile handles an owner no job produces yet; after Task 4 the job hands unknown outcomes to a reconcile that adopts them, but the dashboard still offers Retry on an `unconfirmed` row until Task 6. The branch is merge-ready only after Task 9.

**Research maps the tasks cite:** findings (tracked) in `docs/superpowers/reviews/2026-09-27-retry-send-adoption/research/reader-a-retry-job.md`, `reader-b-reconcile-repos.md`, `reader-c-route-dashboard-e2e.md`; byte-exact references (gitignored) in `.superpowers/sdd/research/reader-{a,b,c}-reference.md`. Line numbers below are at 3dbb5740; re-derive by reading before editing. Where a test sketch names a fixture, USE THE FILE'S REAL FIXTURE NAMES (read the file first). Log-capture facts for tests: `createLogCapture().lines` are PARSED OBJECTS; `capture.atLevel(50)` takes the pino NUMERIC level (error = 50, warn = 40, info = 30); match on `line.msg` and fields.

**Declared deviations from the spec's wording (deliberate; the handback restates them):**
1. R6 reads ONE attempt record per pressed row, not three: the webhook schedules exactly `(retry_attempt ?? 0) + 1` against a failed row (`app/src/services/oneToOneRetryDecision.ts:125-129`) and nothing else produces a `retry_send` record for that row, so the other two keys can never exist. Same answer, two fewer consistent reads.
2. R3's refused arm also takes the ADAPTER's kill switch: `classifySendFailure` sorts `app/src/adapters/messagingErrors.ts`'s `SmsSendingDisabledError` as `rejected` with code `sms_sending_disabled` (`app/src/lib/sendOutcome.ts:95`); the job records it `done/refused` cause `sms_sending_disabled` at WARN, as the spec's table means, not `done/rejected` at ERROR.
3. R2 step 1 reads the retried row CONSISTENTLY (`getByProviderSidConsistent`, `messagesRepo.ts:1327`) instead of "as today" (eventual): the R3 condition's `expect.retryDueAt` is taken from this read, and an eventual read could carry a stale promise.
4. R7's one fenced line is re-worded in ASCII as well as re-leveled: the source string carries a U+2014 (`twilio.ts:3904`), and every touched line must be ASCII. No test, doc or dashboard matches the string. The line becomes `log.info({ broadcastId, conversationId }, 'broadcast delivery rollup: no matching recipient slot - ignored')`.
5. R4's "`slotCloseOf(outcome)` maps `unresolved` to the WITHDRAW" is delivered in `closeSlot`'s `retry_send` arm keyed on the code (`slotCloseOf` takes no owner, `sendReconcile.ts:922`); the observable rule is identical, including the superseded-exit re-apply.
6. R3's "every `guardWrite` loss is logged at ERROR": `guardWrite` logs a THROW at ERROR and returns `true` for a write that resolved with a LOST fence (`app/src/lib/guardWrite.ts:8-10`). Every fenced write in this plan captures the fence answer inside the callback and logs the loss itself (the broadcast idiom, `broadcastFanOut.ts:598-614`).
7. `isBroadcastRowFor` (`app/src/jobs/broadcastFanOut.ts:1296-1306`, a second reader of `broadcast_id` the spec asks the handback to describe) gains `row.retry_of === undefined`: a share-RETRY row that now carries `broadcast_id` is never the share recipient's own slot row. This is a CODE change in a file the spec's "In" list does not name (defensive: as far as the plan can trace, unreachable today); the rollup in `twilio.ts` does not use it (it matches slots by conversationId + tsMsgId) and stays fenced.
8. Spec section 4 item 15's "200 on a stale `attempting` (31 s)" is a leftover of the claim-TTL bound that review round 3 replaced: R6 defines "stale" as older than `RETRY_SEND_WINDOW_MS` from `attemptedAt`, for every open state. The route follows R6; a 31 s `attempting` record answers 409 `retry_pending`, and the "stale" case is tested at `RETRY_SEND_WINDOW_MS + 1 s`.
9. R1's "one function the job, the facts and the adoption all call" for the media rule: the job's `planRetryMedia` decides the facts' `mediaCount` at claim time; the ADOPTION reads that answer back from the record instead of re-running the plan without the job's media store: `record.mediaCount > 0` -> the retried row's `media_attachments` ride the adopted row when it has them, else its raw `mediaUrls` (the internal/e2e seam the job replays) ride as `mediaUrls`; `record.mediaCount === 0` -> no media field at all. Same rule, one source of truth (the record), no second store dependency in the reconcile.

## Global Constraints

- ASCII-only in every line this branch ADDS or TOUCHES (code, comments, tests, docs, log strings). `retrySend.ts`, `sendMessage.ts`, `api.ts`, `twilio.ts` and `Timeline.tsx` carry pre-existing U+2014 strings; a touched log/copy line is re-worded in ASCII (tests match by substring or are updated). Verify a NEW file with `tr -d '\11\12\15\40-\176' < FILE | wc -c` (must print 0); on a pre-existing file check the diff's added lines the same way. Unicode test strings are written as `\uXXXX` escapes.
- FENCES: never edit `app/src/routes/webhooks/twilio.ts` except the ONE line in Task 7; never edit `app/src/jobs/jobs.ts` (incl. `MAX_HOP_COUNT` 10), `app/src/adapters/sqsJobConsumer.ts`, `app/src/services/oneToOneRetryDecision.ts`, or the marker helper `MessagesRepo.putJobExecutionMarker` (its other callers keep it; `retrySend` stops calling it).
- The retry job registers through `defineJobHandler` WITHOUT the run-once marker (R2): the claim is its duplicate guard. Nothing throws after the claim; a throw BEFORE the claim (steps 1-4b) is a real redelivery, and a redelivery re-runs reads only.
- Every DynamoDB expression lists EXACTLY the attribute names and values it uses - DynamoDB rejects an unused alias with a ValidationException (`app/test/aiRunsRepo.integration.test.ts:302-316`). `annotateRetryPromise` builds its names/values PER BRANCH (Task 1).
- Every coordination read is a strongly consistent primary-key Get or Query on the base table (the retried row, the `retrychild#` partition, the attempt record, the lineage walk); no GSI in the coordination path (D11). The conversation read is eventual (the relay owners' accepted residue).
- The `retry_send` record keys on the RETRIED ROW and the attempt: `ownerKey = retry#<conversationId>#<retriedTsMsgId>#<attempt>`; `retryRoot` is a FACT on the owner, never part of the key. `recipientKey` derives from immutable data on every run: the retried row's `recipient_contact_id`, else `phone#<conversation.participant_phone>`; never carried in the retry job's payload; the reconcile ref carries `recipientKeyHash` and the reconcile re-derives and compares.
- The chain has ZERO hop headroom under the fenced `MAX_HOP_COUNT` 10 (webhook 1, deferral 2, checks 3-5, re-drive 6, deferral 7, an accepted-not-recorded's checks 8-10): never add another self-enqueue to the retry chain.
- Import cycle `retrySend.ts` <-> `sendReconcile.ts`: every imported binding from the other module is used only INSIDE functions (the existing note, `sendReconcile.ts:43-47`); `npm run smoke` proves the compiled graph.
- Promise writes on the retried row go ONLY through `annotateRetryPromise` (conditional on `retry_due_at`): REFRESH on a deferral, an unknown hand-off, a takeover and a re-drive; WITHDRAW (`retry_due_at = RETRY_PROMISE_WITHDRAWN_AT` + `retry_outcome: 'unconfirmed'` in ONE write) only on `unresolved`. A success, a refusal, a rejection, a window close and a deferral cap write NO promise (RSW's expiry stands; the wontfix is respected). "Retry not confirmed" keys on `retry_outcome`, NEVER on the sentinel alone (RSW's enqueue-failure withdrawal writes the same sentinel with no outcome and must keep offering Retry).
- Log lines carry `conversationId`, `retryRoot`, `retriedTsMsgId`, `attempt`, the record outcome and cause, and the SID when known; recipient keys ONLY through `safeRecipientKey`; never a phone or a body (R9, D18). Levels: refusals WARN; a rejection, a window close, a second deferral, a failed re-schedule, a second unknown and an unresolved close ONE ERROR each; unknown hand-offs and takeovers INFO.
- Dashboard copy (exact, ASCII, plain literals - staff-facing copy is not catalog-governed, `deliveryStatus.ts:1017-1019`): reason `Phone unreachable - retry not confirmed` (the `(error 30003)` tail from the template); 409 `superseded` -> `A newer attempt already exists for this message.`; 409 `retry_unresolved` -> `This retry couldn't be confirmed - send a new message instead.`
- E2E never uses `contact-tenant-0002` / `conv-0002`, and never arms a fail seam on a shared seed number; every recipient is a fresh consented tenant on a per-run number (uid from 90). A lane must be booted FRESH; the two seams already exist in `scripts/e2e-session.mjs:283, :296`.
- Gates run BARE from the worktree in a BASH shell: `npm run typecheck`, `npm test`, `npm run smoke`, `timeout 1800 npm run e2e` (SOR's green runs of the 289-spec suite took 23.2 and 23.7 minutes; this branch adds three slow specs, so 1500 s is a false red - use 1800), `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` (empty list = skip; attribute errors by baseline comparison at the merge base). `npm test` needs DynamoDB Local (`npm run db:start`). Never commit during `npm run e2e`; never edit source while it runs. If `timeout` ever fires: `npm run e2e:stop`, then prove no listener survives on the lane's ports before re-running (an orphaned same-commit stack is adopted silently by the next run). A single spec runs ONLY as `npm run e2e -- <spec path>` (the e2e workspace), never a bare `npx playwright`.
- Commit discipline: bare `git status` first, `.git/MERGE_HEAD` absent, EXPLICIT paths, never `git add -A`; every commit ends with `Co-Authored-By: <the authoring model> <noreply@anthropic.com>`.
- Never merge to `main`, deploy, push secrets, run terraform, or clean up the worktree. Mission records (slice reports, reviews, self-QA, handback) are COMMITTED under `docs/superpowers/reviews/2026-09-27-retry-send-adoption/` as produced.

## Review Focus

1. A redelivery that arrives BEFORE the claim (a throw in steps 1-4b) re-runs the reads and sends nothing (Task 4, test 9); one that arrives while the first delivery is INSIDE its provider call is deferred by the gate on a fresh `attempting` record (test 6e) or refused `fresh` by the claim when it read before the other delivery claimed (test 6f); one that arrives after the first finished is skipped by the gate on the terminal record (test 6a).
2. The ORIGINAL message sits inside the reconcile's lookup window (same body, seconds before the retry attempt): `heldBy` must read it as `other` (its `sid#` row has no matching `retry_of`/`retry_attempt`), never `free` (which would make `unidentified_candidate`) nor `mine` (Task 2, test 10c).
3. RSW's enqueue-failure withdrawal - the sentinel with NO `retry_outcome` - must keep offering Retry and the plain 30003 copy (Task 6, the existing `Timeline.delivery.test.tsx:660-672` pin plus a new negative case).
4. A manual Retry row that itself fails 30003 starts a chain whose attempt-1 record keys on the MANUAL row and claims, although the root's chain already ran three attempts (Task 4, test 4b).
5. A `redriven` record whose re-driven job finds the window closed or a manual child closes `refused` - never left `redriven` for the sweeper (Task 4, test 4c for the manual child and test 11 (second half) for the closed window; Task 2, test 11).

---

## Work map (task ORDER = numbering)

Order: **T1** (repo additions + helpers, no behavior change) -> **T2** (the owner kind and the reconcile's fourth owner) -> **T3** (the lineage exclusion) -> **T4** (the job) -> **T5** (the manual Retry route) -> **T6** (projection + dashboard) -> **T7** (the one fenced line) -> **T8** (e2e) -> **T9** (issues, self-QA, drift, gates, handback).

- **T1** messagesRepo: `retryRoot`/`retry_root`, `retry_outcome`, the `retrychild#` pointer in `append` + `listRetryChildrenConsistent`, the conditional `annotateRetryPromise`; the harness fakes and the two parity suites; `sendMessage` passes `retryRoot`; the leaf constants and helpers (`RETRY_OUTCOME_UNCONFIRMED`, `MAX_SEND_RETRY_ATTEMPTS` moved to the leaf, `pinnedSender`, `retryChain.ts`, `retryPromiseWrites.ts`, `planRetryMedia`).
- **T2** `SendAttemptOwner` gains `retry_send`; every ref/key/log site; every reconcile dispatch site with `never` defaults; `adoptRetry`; the WITHDRAW in `closeSlot`; the re-drive with its window check and REFRESH; `isBroadcastRowFor`'s guard; the integration and parity cases.
- **T3** the sibling rule's lineage exclusion in `lookup`.
- **T4** `retrySend.ts` rewritten per R2/R3 (marker out, gates, claim, arms, `deferred`), its new deps and registration, the existing suite's 18 registration sites, the new `retrySendAttempt.test.ts`.
- **T5** the route's `superseded` / `retry_unresolved` / record-`retry_pending` guards, `retryRoot` + `broadcastId` on its append, `ApiRouterDeps.sendAttemptsRepo`, the harness api block, `apiRoutes.test.ts`.
- **T6** `contactTimeline.ts` projects `retry_outcome`; dashboard type, `deliveryReason`'s `retryUnconfirmed`, the hidden Retry, the two 409 sentences, the mirror test.
- **T7** `twilio.ts:3904` WARN -> INFO (ASCII) and its unit pin.
- **T8** `e2e/tests/dashboard-next/retry-send-adoption.spec.ts` (spec items 17-19) + `selectors.md`.
- **T9** issue notes, live self-QA, drift report, the five gates, handback.

### Shared interfaces (canonical; each task repeats what it consumes)

```ts
// app/src/lib/retrySendWindow.ts  (T1) - an import-free leaf, mirrored by the dashboard
export const MAX_SEND_RETRY_ATTEMPTS = 3;                       // MOVED here from jobs/retrySend.ts, which re-exports it
export const RETRY_OUTCOME_UNCONFIRMED = 'unconfirmed' as const;
export type RetryOutcome = typeof RETRY_OUTCOME_UNCONFIRMED;

// app/src/lib/outboundSender.ts  (T1) - an import-free leaf
export function pinnedSender(config: { businessPhoneNumber?: string | undefined }, from?: string): string | undefined; // from ?? config.businessPhoneNumber

// app/src/repos/messagesRepo.ts  (T1)
// NewMessage gains:      retryRoot?: string;
// MessageItem gains:     retry_root?: string;  retry_outcome?: RetryOutcome;
export const RETRY_CHILD_PARTITION_PREFIX = 'retrychild#';
export function retryChildPk(conversationId: string, parentTsMsgId: string): string;   // `retrychild#${conversationId}#${parentTsMsgId}`
export interface RetryChildPointer { tsMsgId: string; providerSid: string; retryAttempt?: number }
// MessagesRepo gains:
listRetryChildrenConsistent(conversationId: string, parentTsMsgId: string): Promise<RetryChildPointer[]>;
annotateRetryPromise(conversationId: string, tsMsgId: string,
  patch: { retryDueAt: string; retryOutcome?: RetryOutcome },
  expect: { retryDueAt: string | undefined }): Promise<boolean>;   // true = written; false = the condition failed (a moved promise or a missing row); anything else throws

// app/src/services/retryChain.ts  (T1)
export interface LineageReader { getByTsMsgIdConsistent(conversationId: string, tsMsgId: string): Promise<MessageItem | undefined> }
export async function resolveRetryRoot(messages: LineageReader, row: MessageItem): Promise<string>;           // spec section 0
export async function automaticAncestry(messages: LineageReader, retriedRow: MessageItem): Promise<MessageItem[]>; // R4: the walked AUTOMATIC rows, retriedRow first
export function retryRecipientKey(row: Pick<MessageItem, 'recipient_contact_id'>, conversation: Pick<ConversationItem, 'participant_phone'> | undefined): string | undefined; // R1
export type ConversationRetryDecline = 'conversation_missing' | 'group_text' | 'not_one_to_one';   // the webhook decision's own vocabulary (oneToOneRetryDecision.ts:54-60, :90-97)
export function conversationRetryDecline(conversation: Pick<ConversationItem, 'type' | 'participant_phone'> | undefined): ConversationRetryDecline | undefined; // R2 step 3

// app/src/services/retryPromiseWrites.ts  (T1)
export interface RetryPromiseDeps { messages: Pick<MessagesRepo, 'annotateRetryPromise' | 'getByTsMsgIdConsistent'>; events: EventBus; log: Logger }
export async function refreshRetryPromise(deps: RetryPromiseDeps, row: MessageItem, retryDueAt: string, ctx: Record<string, unknown>): Promise<boolean>;                 // R3 REFRESH: written -> emit; lost -> dropped (INFO); threw -> ERROR, false
export async function withdrawRetryPromise(deps: RetryPromiseDeps, row: MessageItem, ctx: Record<string, unknown>): Promise<'written' | 'already' | 'lost' | 'failed'>; // R3 WITHDRAW: a NO-OP ('already', no write, no emit) when `row` or the fresh re-read already holds the sentinel + outcome; otherwise conditional, retried ONCE from a fresh read

// app/src/jobs/retrySend.ts  (T1 adds; T4 uses)
export interface RetryMediaPlan { attachments?: MediaAttachment[]; rawMediaUrls?: string[]; mediaCount: number; droppedAttachments: boolean }
export function planRetryMedia(original: MessageItem, hasStore: boolean): RetryMediaPlan;   // R1 mediaCount, decided BEFORE the presign
// RetrySendPayload gains:  deferred?: true   (the parser CARRIES it; only the deferral re-enqueue sets it)

// app/src/repos/sendAttemptsRepo.ts  (T2)
// SendAttemptOwner gains:
| { kind: 'retry_send'; conversationId: string; retriedTsMsgId: string; attempt: number; recipientKey: string; retryRoot: string }
// ownerKey: `retry#${conversationId}#${retriedTsMsgId}#${attempt}`;  recipientKeyOf: owner.recipientKey

// app/src/jobs/sendReconcile.ts  (T2)
// SendAttemptOwnerRef gains:
| { kind: 'retry_send'; conversationId: string; retriedTsMsgId: string; attempt: number; retryRoot: string; recipientKeyHash: string }
export type RetrySendOwner = Extract<SendAttemptOwner, { kind: 'retry_send' }>;

// app/src/jobs/retrySend.ts  (T4)
export interface RetrySendJobDeps {
  sendMessage?: SendMessageService; messagesRepo?: MessagesRepo; mediaStore?: MediaStore; contactsRepo?: ContactsRepo;
  conversationsRepo?: ConversationsRepo;   // NEW - R2 step 3
  sendAttemptsRepo?: SendAttemptsRepo;     // NEW - the claim
  config?: AppConfig;                      // NEW - the sender the facts pin (pinnedSender)
  events?: EventBus;                       // NEW - the REFRESH / WITHDRAW emit
  now?: () => number; logger?: Logger;
}
```

New record causes this branch writes (free strings on the record's `cause`): `deferral_cap`, `manual_retry_superseded`, `retried_row_not_found`, plus the existing `retry_window_closed` (`RETRY_WINDOW_CLOSED_CODE`), `enqueue_failed`, `second_unknown`, `send_retryable`, provider codes and refusal codes.

---
## Slice A - foundations (no behavior change)

### Task 1: Repo additions, the fakes, the leaf constants and the chain helpers (R1, R3, R5, R7)

**Files:**
- Modify: `app/src/lib/retrySendWindow.ts` (add `MAX_SEND_RETRY_ATTEMPTS`, `RETRY_OUTCOME_UNCONFIRMED`, `RetryOutcome`; stays import-free)
- Modify: `app/src/jobs/retrySend.ts` (`MAX_SEND_RETRY_ATTEMPTS` becomes a re-export of the leaf's, `:51`; add `RetryMediaPlan` + `planRetryMedia`; `parseRetrySendPayload` carries `deferred: true`, `:66-84`)
- Create: `app/src/lib/outboundSender.ts` (`pinnedSender`)
- Modify: `app/src/services/sendMessage.ts` (`SendMessageInput.retryRoot?`, `:289-387`; `const sender = pinnedSender(config, from)` at `:589`; `...(retryRoot !== undefined && { retryRoot })` in the append input beside `retryWindowStart`, `:663-665`)
- Modify: `app/src/repos/messagesRepo.ts` (`NewMessage.retryRoot?` beside `retryWindowStart` `:754`; `MessageItem.retry_root?`, `retry_outcome?` beside `retry_due_at` `:1046-1056`; the item gains `retry_root` beside `retry_of` `:2541`; the `retrychild#` Put in `append`'s TransactItems; `retryChildPk`, `RetryChildPointer`, `listRetryChildrenConsistent`, `annotateRetryPromise` on the interface `:1498-1506` and the object `:3210-3232`)
- Create: `app/src/services/retryChain.ts`, `app/src/services/retryPromiseWrites.ts`
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (`FakeWorld.retryChildren`; fake `append` allowlist `:1224-1243` + the pointer; fake `listRetryChildrenConsistent`; fake `annotateRetryPromise` beside `annotateMessage` `:1469-1475`)
- Modify (typecheck): `app/test/sendMessage.test.ts:256-350` and `app/test/scheduledSendSuppression.test.ts:273-365` - each declares a FULL, uncast `const messagesRepo: MessagesRepo = { ... }` literal, and `tsconfig.test.json` includes `test/`, so both go red the moment the interface gains two required members. Each gains `async listRetryChildrenConsistent() { return []; }` and `async annotateRetryPromise() { return true; }` (the file's other unused members follow the same trivial-stub pattern; read them).
- Test: `app/test/messagesRepoRetryLineage.integration.test.ts` (extend - it is the RELAY lineage suite; its `retryRow` builder stamps relay fields and is NOT reused; the one-to-one helpers below are added file-locally), `app/test/twilioWebhookHarnessRetryFields.test.ts` (extend), `app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts` (extend `messagesAgree` `:754-773` + `MSG_CASES`), `app/test/sendMessage.test.ts:1085` ('passes retryOf, retryAttempt and retryWindowStart into the append, and none of them on a normal send' - gains `retryRoot`), `app/test/retrySendWindow.test.ts` (pin the two new constants), NEW `app/test/retryChain.test.ts`, NEW `app/test/retryPromiseWrites.test.ts`, NEW `app/test/retrySendMedia.test.ts`

**Interfaces:**
- Consumes: `buildTsMsgId` / `splitTsMsgId` (`messagesRepo.ts:201-216`); `mediaAttachmentsOf`; `RETRY_PROMISE_WITHDRAWN_AT`; `EventBus` (`lib/events.ts:331`); the `sendAppendTransaction` idiom (`messagesRepo.ts:2078-2269`); the `listByRecipient` paged consistent Query idiom (`sendAttemptsRepo.ts:585-615`).
- Produces: everything in the shared-interfaces block under T1.

- [ ] **Step 1: The leaf constants and `pinnedSender`.** In `retrySendWindow.ts` add, after `RETRY_PROMISE_WITHDRAWN_AT` (`:32`):

```ts
/** Total send attempts for one logical message are capped at 1 + this (owned here since retry-send-adoption; jobs/retrySend.ts re-exports it). */
export const MAX_SEND_RETRY_ATTEMPTS = 3;
/** retry-send-adoption R5: the retried row's retry_outcome when the reconcile ruled the retry `unresolved`. The dashboard hand-copies it (routes/contact/retryPromise.ts) - pinned by retryPromiseMirror.test.ts. */
export const RETRY_OUTCOME_UNCONFIRMED = 'unconfirmed' as const;
export type RetryOutcome = typeof RETRY_OUTCOME_UNCONFIRMED;
```

In `retrySend.ts` delete `export const MAX_SEND_RETRY_ATTEMPTS = 3;` (`:51`), add `MAX_SEND_RETRY_ATTEMPTS` to the existing `import { ... } from '../lib/retrySendWindow.js'` (`:33-37`) - the module's own `parseRetrySendPayload` reads it at `:80-81`, and a bare `export ... from` re-export creates NO local binding - and add the line `export { MAX_SEND_RETRY_ATTEMPTS };` so every existing importer (the fenced `oneToOneRetryDecision.ts:43`, the tests) keeps resolving through `jobs/retrySend.js`. Create `app/src/lib/outboundSender.ts`:

```ts
// The one-to-one sender pin (retry-send-adoption R1): the number a one-to-one
// text is sent FROM - an explicit `from` (a relay pool number), else the
// business number (config.businessPhoneNumber; undefined in an unpinned dev
// loop, where the Messaging Service picks). sendMessage and the retry job's
// attempt facts read it from THIS function so the record's `sender` is the
// number the provider call pins.
export function pinnedSender(config: { businessPhoneNumber?: string | undefined }, from?: string): string | undefined {
  return from ?? config.businessPhoneNumber;
}
```

`sendMessage.ts:589` becomes `const sender = pinnedSender(config, from);` (import added). Add to `retrySendWindow.test.ts`'s constants case: `expect(MAX_SEND_RETRY_ATTEMPTS).toBe(3); expect(RETRY_OUTCOME_UNCONFIRMED).toBe('unconfirmed');`.

- [ ] **Step 2: Failing repo tests (DynamoDB Local) in `messagesRepoRetryLineage.integration.test.ts`** - read the file first and use its `describe.skipIf(!reachable)`, table setup and `messages` (the real `MessagesRepo` it builds at `:35`; the file has no `repo`). Add these FILE-LOCAL helpers in a new nested `describe('one-to-one retry lineage (retry-send-adoption)')`:

```ts
  const ONE_CONV = `conv-1to1-${randomUUID().slice(0, 8)}`;
  const T0 = '2026-09-27T12:00:00.000Z';
  const T1 = '2026-09-27T12:01:00.000Z';
  const DUE_1 = '2026-09-27T12:02:00.000Z';
  const DUE_2 = '2026-09-27T12:03:00.000Z';
  /** One outbound one-to-one row in ONE_CONV; returns the stored row (consistent read). */
  async function appendOutbound(fields: { providerSid: string; providerTs: string } & Partial<NewMessage>): Promise<MessageItem> {
    const res = await messages.append({ conversationId: ONE_CONV, type: 'sms', direction: 'outbound', author: 'teammate', body: 'hello', deliveryStatus: 'undelivered', errorCode: '30003', ...fields });
    return (await messages.getByTsMsgIdConsistent(ONE_CONV, res.tsMsgId))!;
  }
```

One `it` each (in the sketches below `repo` reads as `messages` and `CONV` as `ONE_CONV`; `appendOutbound` takes ONE argument):

```ts
it('append persists retry_root beside retry_of and writes the retrychild# pointer in the same transaction', async () => {
  const parent = await appendOutbound(repo, { providerSid: 'SMroot1', providerTs: T0 });
  const child = await appendOutbound(repo, { providerSid: 'SMretry1', providerTs: T1, retryOf: parent.tsMsgId, retryAttempt: 1, retryRoot: parent.tsMsgId });
  expect((await repo.getByTsMsgIdConsistent(CONV, child.tsMsgId))).toMatchObject({ retry_of: parent.tsMsgId, retry_attempt: 1, retry_root: parent.tsMsgId });
  expect(await repo.listRetryChildrenConsistent(CONV, parent.tsMsgId)).toEqual([{ tsMsgId: child.tsMsgId, providerSid: 'SMretry1', retryAttempt: 1 }]);
});
it('a manual retry row (retryOf, no retryAttempt) writes a pointer with no retryAttempt; a row with no retryOf writes none', /* two appends; listRetryChildrenConsistent(CONV, parent) has one entry without retryAttempt; listRetryChildrenConsistent(CONV, child) is [] */);
it('a deduped append (same providerSid) writes no second pointer', /* append the same child twice -> deduped: true; the list still has ONE entry */);
it('the pointer read is a single consistent Query on the retrychild# partition', /* wrap the DynamoDB client (the file\'s doc client) with a spy on `send`; call listRetryChildrenConsistent; expect exactly one QueryCommand whose input has ConsistentRead: true and KeyConditionExpression on `:p` = retryChildPk(CONV, parent) and no FilterExpression */);
it('annotateRetryPromise writes only when retry_due_at still holds the expected value, and returns false otherwise', async () => {
  const row = await appendOutbound(repo, { providerSid: 'SMdue1', providerTs: T0 });
  // absent -> absent expected: written
  expect(await repo.annotateRetryPromise(CONV, row.tsMsgId, { retryDueAt: DUE_1 }, { retryDueAt: undefined })).toBe(true);
  // a stale expectation loses
  expect(await repo.annotateRetryPromise(CONV, row.tsMsgId, { retryDueAt: DUE_2 }, { retryDueAt: undefined })).toBe(false);
  expect(await repo.annotateRetryPromise(CONV, row.tsMsgId, { retryDueAt: DUE_2 }, { retryDueAt: 'wrong' })).toBe(false);
  // the current value wins
  expect(await repo.annotateRetryPromise(CONV, row.tsMsgId, { retryDueAt: DUE_2 }, { retryDueAt: DUE_1 })).toBe(true);
  // WITHDRAW writes both fields in one write
  expect(await repo.annotateRetryPromise(CONV, row.tsMsgId, { retryDueAt: RETRY_PROMISE_WITHDRAWN_AT, retryOutcome: 'unconfirmed' }, { retryDueAt: DUE_2 })).toBe(true);
  expect(await repo.getByTsMsgIdConsistent(CONV, row.tsMsgId)).toMatchObject({ retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' });
  // a missing row is false, not a throw
  expect(await repo.annotateRetryPromise(CONV, 'nope#SMnope', { retryDueAt: DUE_1 }, { retryDueAt: undefined })).toBe(false);
});
```

- [ ] **Step 3: Implement the repo.** In `append`'s item (`:2541`): `...(message.retryRoot !== undefined && { retry_root: message.retryRoot }),` beside `retry_of`. In the TransactItems, AFTER the email pointer and the due row and BEFORE the media pointers (index 1 must stay the `sid#` pointer and index 2 the `emailmsgid#` pointer - the dedupe attribution at `:2771` reads them by position), UNCONDITIONED (a redelivery cancels on the `sid#` condition first, exactly as the media pointers rely on):

```ts
              // retry-send-adoption R7: the retrychild# pointer - "does this row
              // have a child?" as ONE consistent Query, for the retry job's
              // supersession check and the manual Retry route. A pointer, never
              // state: written with the row, never updated, only by the
              // winning append (a dedupe cancels the whole transaction).
              ...(message.retryOf !== undefined
                ? [
                    {
                      Put: {
                        TableName: table,
                        Item: {
                          conversationId: retryChildPk(message.conversationId, message.retryOf),
                          tsMsgId,
                          provider_sid: message.providerSid,
                          ...(message.retryAttempt !== undefined && { retry_attempt: message.retryAttempt }),
                        },
                      },
                    },
                  ]
                : []),
```

`retryChildPk` beside the other pointer key helpers (`:2008-2038`): `export function retryChildPk(conversationId: string, parentTsMsgId: string): string { return \`${RETRY_CHILD_PARTITION_PREFIX}${conversationId}#${parentTsMsgId}\`; }`. `listRetryChildrenConsistent` copies `listByRecipient`'s paged loop (`sendAttemptsRepo.ts:585-615`): `QueryCommand({ TableName: table, KeyConditionExpression: 'conversationId = :p', ExpressionAttributeValues: { ':p': retryChildPk(conversationId, parentTsMsgId) }, ConsistentRead: true, ...(ExclusiveStartKey) })`, mapping each item to `{ tsMsgId: item.tsMsgId, providerSid: item.provider_sid, ...(typeof item.retry_attempt === 'number' && { retryAttempt: item.retry_attempt }) }`. `annotateRetryPromise` (beside `annotateMessage`, `:3210`), four branches, each listing exactly its aliases:

```ts
    async annotateRetryPromise(conversationId, tsMsgId, patch, expect) {
      const withdraw = patch.retryOutcome !== undefined;
      const expected = expect.retryDueAt !== undefined;
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId, tsMsgId },
            UpdateExpression: withdraw ? 'SET #due = :due, #ro = :ro' : 'SET #due = :due',
            ConditionExpression: expected
              ? 'attribute_exists(tsMsgId) AND #due = :expected'
              : 'attribute_exists(tsMsgId) AND attribute_not_exists(#due)',
            ExpressionAttributeNames: { '#due': 'retry_due_at', ...(withdraw && { '#ro': 'retry_outcome' }) },
            ExpressionAttributeValues: {
              ':due': patch.retryDueAt,
              ...(withdraw && { ':ro': patch.retryOutcome }),
              ...(expected && { ':expected': expect.retryDueAt }),
            },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
      log.info({ conversationId, tsMsgId, retryDueAt: patch.retryDueAt, ...(withdraw && { retryOutcome: patch.retryOutcome }) }, 'retry promise annotated');
      return true;
    },
```

(`ConditionalCheckFailedException` is already imported in this file for `updateDeliveryStatus`; verify.) `MessageAnnotations` (`:1233-1236`) gains NOTHING.

- [ ] **Step 4: The fakes and their pins.** `FakeWorld` gains `retryChildren: Map<string, RetryChildPointer[]>` (key = `retryChildPk(...)`). Fake `append`: in the allowlist add `...(message.retryRoot !== undefined && { retry_root: message.retryRoot }),`; after the dedupe check and the row push, when `message.retryOf !== undefined` push `{ tsMsgId, providerSid: message.providerSid, ...(retryAttempt) }` onto `retryChildren.get(retryChildPk(conversationId, retryOf))` (an explicit map written by `append`, like production - NOT derived from rows, so a row a test pushes straight into `world.messages` has no pointer, as in production). Fake `listRetryChildrenConsistent` returns a copy of the map entry (or `[]`). Fake `annotateRetryPromise`: find the row (none -> `false`); `item.retry_due_at !== expect.retryDueAt` -> `false`; else set `retry_due_at` and, when given, `retry_outcome`; `true`. Extend `twilioWebhookHarnessRetryFields.test.ts` with the same four expectations as Step 2 run against `createFakeWorld().messagesRepo` (retry_root carried; pointer written with/without retryAttempt and not for a deduped append; the four annotate branches; `retry_outcome` never written by `append`). Extend `twilioWebhookHarnessRepoAdditions.integration.test.ts`: `messagesAgree` also compares each row's `retry_root`, `retry_due_at`, `retry_outcome` and, for every `(conversationId, parentTsMsgId)` the script appended a child for, `listRetryChildrenConsistent` (sorted by tsMsgId); add `MSG_CASES` steps: append a parent, append an automatic child (retryOf + retryAttempt + retryRoot), append a manual child, re-append the automatic child (deduped), `annotateRetryPromise` x4 (absent/absent written, stale false, current true, withdraw true), `listRetryChildrenConsistent` on the parent and on a childless row.

- [ ] **Step 5: `retryChain.ts` and its failing tests** (`app/test/retryChain.test.ts`, over `createFakeWorld()`; rows appended through `world.messagesRepo.append` with real lineage):

```ts
// app/src/services/retryChain.ts
import { MAX_SEND_RETRY_ATTEMPTS } from '../lib/retrySendWindow.js';
export interface LineageReader { getByTsMsgIdConsistent(conversationId: string, tsMsgId: string): Promise<MessageItem | undefined> }

/** Spec section 0: the chain ROOT of `row` - its retry_root when it carries one; a row with no retry_of is its own root; a pre-deploy retry row is walked up retry_of (consistent reads, at most MAX_SEND_RETRY_ATTEMPTS hops); a broken link stops at the last row read. */
export async function resolveRetryRoot(messages: LineageReader, row: MessageItem): Promise<string> {
  let current = row;
  for (let hop = 0; hop < MAX_SEND_RETRY_ATTEMPTS; hop += 1) {
    if (typeof current.retry_root === 'string' && current.retry_root.length > 0) return current.retry_root;
    if (typeof current.retry_of !== 'string' || current.retry_of.length === 0) return current.tsMsgId;
    const parent = await messages.getByTsMsgIdConsistent(row.conversationId, current.retry_of);
    if (parent === undefined) return current.tsMsgId;
    current = parent;
  }
  return current.tsMsgId;
}

/** R4: the AUTOMATIC predecessors' rows - the walk from `retriedRow` up retry_of while each row carries retry_attempt; it stops at the first row without one (the root, or a manual row) and at a broken link. `retriedRow` itself is first when it is automatic. */
export async function automaticAncestry(messages: LineageReader, retriedRow: MessageItem): Promise<MessageItem[]> {
  const walked: MessageItem[] = [];
  let current: MessageItem | undefined = retriedRow;
  for (let hop = 0; hop < MAX_SEND_RETRY_ATTEMPTS && current !== undefined; hop += 1) {
    if (typeof current.retry_attempt !== 'number' || typeof current.retry_of !== 'string' || current.retry_of.length === 0) break;
    walked.push(current);
    current = await messages.getByTsMsgIdConsistent(retriedRow.conversationId, current.retry_of);
  }
  return walked;
}

/** R1: the recipient key of a retry attempt, from IMMUTABLE data - the retried row's recorded recipient, else the thread's number. Undefined when neither exists (the attempt is unaddressable). */
export function retryRecipientKey(row: Pick<MessageItem, 'recipient_contact_id'>, conversation: Pick<ConversationItem, 'participant_phone'> | undefined): string | undefined {
  if (typeof row.recipient_contact_id === 'string' && row.recipient_contact_id.length > 0) return row.recipient_contact_id;
  const phone = conversation?.participant_phone;
  return typeof phone === 'string' && phone.length > 0 ? `phone#${phone}` : undefined;
}

export type ConversationRetryDecline = 'conversation_missing' | 'group_text' | 'not_one_to_one';
/** R2 step 3: a DESIGNED decline, in the webhook decision's own vocabulary and with its own reading (services/oneToOneRetryDecision.ts:90-97: a group text is `group_text`; a relay group or a phone-less thread is `not_one_to_one`) - never a throw. */
export function conversationRetryDecline(conversation: Pick<ConversationItem, 'type' | 'participant_phone'> | undefined): ConversationRetryDecline | undefined {
  if (conversation === undefined) return 'conversation_missing';
  if (conversation.type === 'group_text') return 'group_text';
  if (conversation.type === 'relay_group' || typeof conversation.participant_phone !== 'string' || conversation.participant_phone.length === 0) return 'not_one_to_one';
  return undefined;
}
```

Tests: `resolveRetryRoot` - a row with `retry_root` returns it without a read (spy `getByTsMsgIdConsistent` not called); a root returns itself; a pre-deploy attempt-2 row (retry_of -> attempt-1 row -> root, no `retry_root` anywhere) returns the root's tsMsgId in two reads; a broken link (retry_of names a missing row) returns the last row read; a 4-deep chain stops after 3 hops. `automaticAncestry` - a root -> `[]`; a manual row -> `[]`; attempt-2 retried row (auto) over attempt-1 (auto) over root -> `[attempt2Row, attempt1Row]`; a chain whose parent is a MANUAL row -> `[theAutomaticRow]` only; a broken link -> the rows read so far. `retryRecipientKey` - contact id wins; phone fallback; neither -> undefined. `conversationRetryDecline` - each of the four `_1to1` types with a phone passes; `group_text` -> `group_text`; `relay_group` -> `not_one_to_one`; a `tenant_1to1` with no `participant_phone` -> `not_one_to_one`; missing -> `conversation_missing`.

- [ ] **Step 6: `retryPromiseWrites.ts` and its failing tests** (`app/test/retryPromiseWrites.test.ts` over the fake world + `createLogCapture`):

```ts
// app/src/services/retryPromiseWrites.ts
export interface RetryPromiseDeps { messages: Pick<MessagesRepo, 'annotateRetryPromise' | 'getByTsMsgIdConsistent'>; events: EventBus; log: Logger }

function emitPersisted(deps: RetryPromiseDeps, row: MessageItem): void {
  deps.events.emit('message.persisted', { conversationId: row.conversationId, tsMsgId: row.tsMsgId, direction: row.direction, deliveryStatus: row.delivery_status });
}

/** R3 REFRESH: one conditional write against the value `row` was read with. Lost -> dropped (the newer value stands, INFO). A throw is a failure-arm write failure: ERROR, false. */
export async function refreshRetryPromise(deps: RetryPromiseDeps, row: MessageItem, retryDueAt: string, ctx: Record<string, unknown>): Promise<boolean> {
  try {
    const won = await deps.messages.annotateRetryPromise(row.conversationId, row.tsMsgId, { retryDueAt }, { retryDueAt: row.retry_due_at });
    if (!won) { deps.log.info({ ...ctx, retryDueAt }, 'retry promise refresh dropped - a newer promise stands'); return false; }
    emitPersisted(deps, { ...row, retry_due_at: retryDueAt });
    return true;
  } catch (err) {
    deps.log.error({ err, ...ctx, retryDueAt, label: 'refreshRetryPromise' }, 'failure-arm write failed (best-effort); the attempt record decides');
    return false;
  }
}

const isWithdrawn = (row: Pick<MessageItem, 'retry_due_at' | 'retry_outcome'>): boolean =>
  row.retry_due_at === RETRY_PROMISE_WITHDRAWN_AT && row.retry_outcome === RETRY_OUTCOME_UNCONFIRMED;

/** R3 WITHDRAW (the Q1 ruling): retry_due_at = the sentinel AND retry_outcome = unconfirmed in ONE write, conditioned on the value read; a lost condition is retried ONCE from a fresh consistent read. A row that already holds both (the superseded exit's re-apply, R4) is a NO-OP: 'already', no write, no emit. */
export async function withdrawRetryPromise(deps: RetryPromiseDeps, row: MessageItem, ctx: Record<string, unknown>): Promise<'written' | 'already' | 'lost' | 'failed'> {
  const patch = { retryDueAt: RETRY_PROMISE_WITHDRAWN_AT, retryOutcome: RETRY_OUTCOME_UNCONFIRMED };
  try {
    if (isWithdrawn(row)) return 'already';
    if (await deps.messages.annotateRetryPromise(row.conversationId, row.tsMsgId, patch, { retryDueAt: row.retry_due_at })) { emitPersisted(deps, row); return 'written'; }
    const fresh = await deps.messages.getByTsMsgIdConsistent(row.conversationId, row.tsMsgId);
    if (fresh === undefined) { deps.log.error({ ...ctx }, 'retry promise withdrawal failed - the retried row is missing'); return 'failed'; }
    if (isWithdrawn(fresh)) return 'already';
    if (await deps.messages.annotateRetryPromise(row.conversationId, row.tsMsgId, patch, { retryDueAt: fresh.retry_due_at })) { emitPersisted(deps, fresh); return 'written'; }
    deps.log.error({ ...ctx }, 'retry promise withdrawal lost twice - a concurrent writer keeps moving the promise');
    return 'lost';
  } catch (err) {
    deps.log.error({ err, ...ctx, label: 'withdrawRetryPromise' }, 'failure-arm write failed (best-effort); the attempt record decides');
    return 'failed';
  }
}
```

Tests: refresh over a matching value writes and emits ONE `message.persisted` with the row's direction/status; refresh over a moved value returns false, writes nothing, emits nothing, one INFO; a throwing annotate returns false with one ERROR. Withdraw: `'written'` + emit; a STALE input row (the stored row moved once since it was read: pass a copy with the old `retry_due_at`) -> `'written'` after the re-read, ONE emit, two annotate calls; the CURRENT row already withdrawn -> `'already'`, ZERO annotate calls, no emit; a stale input row whose stored twin is already withdrawn -> `'already'` after one lost annotate, no emit; a writer that moves the promise between both attempts (the fake's `annotateRetryPromise` spied to return false twice while the stored row is not withdrawn) -> `'lost'`, one ERROR; a missing row -> `'failed'`.

- [ ] **Step 7: `planRetryMedia` and `deferred`.** In `retrySend.ts` add (exported):

```ts
export interface RetryMediaPlan { attachments?: MediaAttachment[]; rawMediaUrls?: string[]; mediaCount: number; droppedAttachments: boolean }
/** R1: what the retry WILL SEND, decided synchronously so the claim's mediaCount is known before the presign (retrySend.ts's media rule as built). */
export function planRetryMedia(original: MessageItem, hasStore: boolean): RetryMediaPlan {
  const attachments = mediaAttachmentsOf(original);
  if (attachments.length > 0) {
    return hasStore ? { attachments, mediaCount: attachments.length, droppedAttachments: false } : { mediaCount: 0, droppedAttachments: true };
  }
  if (original.mediaUrls !== undefined) return { rawMediaUrls: original.mediaUrls, mediaCount: original.mediaUrls.length, droppedAttachments: false };
  return { mediaCount: 0, droppedAttachments: false };
}
```

`RetrySendPayload` gains `deferred?: true`; the parser returns `{ providerSid, conversationId, attempt, ...(p.deferred === true && { deferred: true as const }) }`. Tests (`app/test/retrySendMedia.test.ts`): the four plan shapes; and in `twilioStatusWebhook.test.ts`'s parse case (`:1225-1232`) add: `expect(parseRetrySendPayload({ providerSid: 's', conversationId: 'c', attempt: 1, deferred: true })).toEqual({ providerSid: 's', conversationId: 'c', attempt: 1, deferred: true }); expect(parseRetrySendPayload({ providerSid: 's', conversationId: 'c', attempt: 1, deferred: false })).toEqual({ providerSid: 's', conversationId: 'c', attempt: 1 });`. The existing `retrySendBackoff.test.ts:105` exact-payload pin stays green (the webhook path never sets it).

- [ ] **Step 8: `sendMessage` passes `retryRoot`.** `SendMessageInput.retryRoot?: string` (doc: "retry-send-adoption R7: the chain root, persisted as retry_root beside retry_of; the automatic retry, the adoption and the manual Retry route all pass it"); destructure it; append input gains `...(retryRoot !== undefined && { retryRoot })`. Extend `app/test/sendMessage.test.ts:1085` ('passes retryOf, retryAttempt and retryWindowStart into the append, and none of them on a normal send') with `retryRoot: '2026-06-12T09:58:00.000Z#SMroot'` in and `retryRoot` on the captured append input out (the case already asserts the other three the same way), and its "none of them on a normal send" half with `retryRoot`. The two full-literal fakes (`sendMessage.test.ts:256`, `scheduledSendSuppression.test.ts:273`) gain the two stub members named in Files.

- [ ] **Step 9: Run, typecheck, commit**

Run: `cd app; npx vitest run test/messagesRepoRetryLineage.integration.test.ts test/twilioWebhookHarnessRetryFields.test.ts test/twilioWebhookHarnessRepoAdditions.integration.test.ts test/retryChain.test.ts test/retryPromiseWrites.test.ts test/retrySendMedia.test.ts test/retrySendWindow.test.ts test/retrySendBackoff.test.ts test/twilioStatusWebhook.test.ts test/sendMessage.test.ts test/scheduledSendSuppression.test.ts` -> PASS. `npm run typecheck` -> 0 (it includes `test/`). ASCII check on every new file.

```bash
git status
git add app/src/lib/retrySendWindow.ts app/src/lib/outboundSender.ts app/src/jobs/retrySend.ts app/src/services/sendMessage.ts app/src/repos/messagesRepo.ts app/src/services/retryChain.ts app/src/services/retryPromiseWrites.ts app/test/helpers/twilioWebhookHarness.ts app/test/messagesRepoRetryLineage.integration.test.ts app/test/twilioWebhookHarnessRetryFields.test.ts app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts app/test/retryChain.test.ts app/test/retryPromiseWrites.test.ts app/test/retrySendMedia.test.ts app/test/retrySendWindow.test.ts app/test/twilioStatusWebhook.test.ts app/test/sendMessage.test.ts app/test/scheduledSendSuppression.test.ts
git commit -m "feat(messages): retry_root and retry_outcome on the row, the retrychild# pointer family, the conditional annotateRetryPromise; the chain helpers, the promise writes and the retry media plan (retry-send-adoption T1)" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---
## Slice B - the reconcile's fourth owner

### Task 2: The `retry_send` owner kind everywhere, and the reconcile's handling of it (R1, R4, R12)

**Files:**
- Modify: `app/src/repos/sendAttemptsRepo.ts` (owner union `:50-53`; `ownerKey` `:152-161`; `recipientKeyOf` `:163-165` - a TERNARY today, becomes a `switch` with a `never` default)
- Modify: `app/src/jobs/sendReconcile.ts` (`SendAttemptOwnerRef` `:113-116`; `toOwnerRef` `:126-145`; `parseOwnerRef` `:174-198`; `Resolved` `:298-315`; `relayRowKey` `:280-282` and `adoptRelay`'s owner param `:651-656` narrowed to `Extract<SendAttemptOwner, { kind: 'relay_leg' | 'relay_rung' }>`; `ownerRefLog` / `ownerLog` `:362-384`; `resolve` `:473-507`; `currentPhone` `:516-535`; `heldBy` `:577-611`; `adopt` `:614-635`; `closeSlot` `:936-955`; `afterClose` `:967-993`; `enqueueRedrive` `:1078-1115`; `redriveRefusal` `:1123-1130`; `closeRedriveRefused` `:1140-1160`; `redrive` `:1170-1195`)
- Modify: `app/src/jobs/broadcastFanOut.ts` (`isBroadcastRowFor` `:1296-1306`)
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (`attemptRecipientKey` ternary `:4409-4410`)
- Test: `app/test/sendReconcile.test.ts` (new `describe('retry_send owner')`; the parser and `toOwnerRef` tables `:3007-3041`), `app/test/sendAttemptsRepo.integration.test.ts` (key shapes `:70-91`, the `rawRecord` ternary `:278`, one DynamoDB Local case), `app/test/twilioWebhookHarnessSendAttempts.integration.test.ts` (ternaries `:237`, `:534`; the three-kind case `:399-413` gains the fourth), `app/test/broadcastFanOut.test.ts` or `sendReconcile.test.ts` (`isBroadcastRowFor`'s guard; the latter already imports it `:19`)

**Interfaces:**
- Consumes: T1's `retryRecipientKey`, `withdrawRetryPromise`, `refreshRetryPromise`, `NewMessage.retryRoot`; `oneToOneRetryWindowOrigin`, `parseRetryWindowOrigin`, `retryFitsSendWindow`, `RETRY_JOB_GRACE_MS`, `RETRY_PROMISE_GRACE_MS`, `RETRY_WINDOW_CLOSED_CODE` (`lib/retrySendWindow.ts`); `enqueueSendRetry` (`jobs/retrySend.ts:127`, imported at module top, used inside a function); `mapTwilioStatus` (`adapters/messaging.ts:665`, already imported); `contactHoldsPhone`, `isDeleted` (`repos/contactsRepo.ts:376`, `:319`). NEW imports `sendReconcile.ts` does not have yet: `TRANSPORT_SCHEMA_VERSION` from `../lib/messageTransport.js` (as `broadcastFanOut.ts:65`) and `toConversationUpdatedEvent` from `../lib/events.js` (as `broadcastFanOut.ts:62`; the file imports only `appEvents` and `EventBus` from it today, `:56`).
- Produces: the owner union member, the ref member, `RetrySendOwner`, `parseOwnerRef`'s `retry_send` arm (`attempt` must be an integer in `1..MAX_SEND_RETRY_ATTEMPTS`), the reconcile's complete `retry_send` behavior, `isBroadcastRowFor`'s `retry_of` guard.

The exhaustiveness idiom (copy `relayFanOut.ts:1432-1435`): every `switch (owner.kind)` in `sendReconcile.ts` and the repo ends with `default: { const unhandled: never = <owner>; throw new Error(\`sendReconcile: unhandled owner kind ${String(unhandled)}\`); }` - a missed arm is a typecheck error, never a silent no-op (research: five sites are silent today).

- [ ] **Step 1: Failing key-shape and parser tests.** `sendAttemptsRepo.integration.test.ts` key cases (`:70-91`): `ownerKey({ kind: 'retry_send', conversationId: 'conv-1', retriedTsMsgId: 'T#SMa', attempt: 2, recipientKey: 'c-1', retryRoot: 'T0#SMroot' })` is `'retry#conv-1#T#SMa#2'`; `attemptKey` of it is `'retry#conv-1#T#SMa#2|c-1'` and, with `recipientKey: 'phone#+15550100001'`, `'retry#conv-1#T#SMa#2|' + hashRecipientKey('phone#+15550100001')`; the root is NOT in the key (two owners differing only in `retryRoot` share one `attemptKey`). `sendReconcile.test.ts` parser table: a `retry_send` ref round-trips through `toOwnerRef` -> JSON -> `parseSendReconcilePayload` (`attempt` stays a number; `retryRoot` carried; `recipientKeyHash = hashRecipientKey(recipientKey)`); `attempt: 0`, `attempt: 4`, `attempt: '1'` and a missing `retryRoot` each throw. `ownerLog` / `ownerRefLog` render `{ kind, conversationId, retriedTsMsgId, attempt: '2', retryRoot }` (strings only - the return type is `Record<string, string>`).

- [ ] **Step 2: Implement the union, the keys, the ref, the parser, the logs, the narrowings, the harness ternary and the three test ternaries.** `parseOwnerRef`'s arm:

```ts
    case 'retry_send': {
      const attempt = o['attempt'];
      if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1 || attempt > MAX_SEND_RETRY_ATTEMPTS) {
        throw new Error('sendReconcile: owner.attempt must be an attempt number');
      }
      return {
        kind: 'retry_send',
        conversationId: requiredText(o['conversationId'], 'owner.conversationId'),
        retriedTsMsgId: requiredText(o['retriedTsMsgId'], 'owner.retriedTsMsgId'),
        attempt,
        retryRoot: requiredText(o['retryRoot'], 'owner.retryRoot'),
        recipientKeyHash,
      };
    }
```

`Resolved` gains nothing new in shape: `row` = the RETRIED row (consistent), `conversation` = the thread (eventual), `key` = the recipient key. Run Step 1's tests -> PASS; `npm run typecheck` -> 0 (every switch now has its arm or its `never`).

- [ ] **Step 3: Failing reconcile tests** - a new `describe('retry_send owner (retry-send-adoption R4)')` in `sendReconcile.test.ts`, with these file-local helpers beside the relay ones (`:2014-2151`):

```ts
  const TENANT_PHONE = '+15550100077';
  const iso = (ms: number): string => new Date(ms).toISOString();
  /** The one-to-one thread's id - MINTED by the fake (`conv-<n>`, twilioWebhookHarness.ts:600-615), never hard-coded; set by seedOneToOne. */
  let retryConv = '';
  /** A one-to-one thread with a consented tenant; returns the contact and the conversation. */
  async function seedOneToOne(): Promise<{ contact: ContactItem; conversation: ConversationItem }> {
    const contact: ContactItem = { contactId: 'c-retry', type: 'tenant', status: 'active', phone: TENANT_PHONE, consent_method: 'inbound_text' };
    world.contacts.push(contact);
    const conversation = await world.conversationsRepo.createOrGetByParticipantPhone(TENANT_PHONE, 'tenant_1to1');
    retryConv = conversation.conversationId;
    return { contact, conversation };
  }
  /** An outbound row in that thread (the ROOT by default; pass retryOf/retryAttempt/retryRoot for a retry row). Returns the STORED row (the live object the fake keeps), so a test may stamp retry_due_at on it. */
  async function seedRow(sid: string, fields: Partial<NewMessage> & { providerTs?: string } = {}): Promise<MessageItem> {
    const { providerTs = iso(Date.now() - 30_000), ...rest } = fields;
    await world.messagesRepo.append({ conversationId: retryConv, providerSid: sid, providerTs, type: 'sms', direction: 'outbound', author: 'teammate', body: BODY, deliveryStatus: 'undelivered', errorCode: '30003', automated: false, recipientContactId: 'c-retry', ...rest });
    return world.messages.find((m) => m.provider_sid === sid)!;
  }
  const rOwner = (row: MessageItem, attempt: number, recipientKey = 'c-retry', retryRoot = row.retry_root ?? row.tsMsgId): SendAttemptOwner => ({ kind: 'retry_send', conversationId: row.conversationId, retriedTsMsgId: row.tsMsgId, attempt, recipientKey, retryRoot });
  const retryRow = (retriedTsMsgId: string, attempt: number) => world.messages.find((m) => m.retry_of === retriedTsMsgId && m.retry_attempt === attempt);
  const persistedFor = (tsMsgId: string) => world.emitted.filter((e) => e.event === 'message.persisted' && (e.payload as { tsMsgId: string }).tsMsgId === tsMsgId);
```

One `it` per case (the numbers are the spec's section 4):

```ts
it('10 a listed orphan adopts as the retry row sendMessage would have appended - full R4 field set, the pointer, one audit row, the emit, NO promise write', async () => {
  register();
  const { conversation } = await seedOneToOne();
  const root = await seedRow('SMroot', { providerTs: iso(Date.now() - 20_000) });
  const due = iso(Date.now() + 10_000);
  root.retry_due_at = due;
  const owner = rOwner(root, 1);
  const at = await reconciling(owner, factsFor(TENANT_PHONE));
  const orphan = plant({ providerSid: 'SMorphan-r', providerStatus: 'delivered', to: TENANT_PHONE });
  await runCheck(payloadOf(owner, at));
  const row = retryRow(root.tsMsgId, 1)!;
  expect(row).toMatchObject({ direction: 'outbound', author: 'teammate', body: BODY, delivery_status: 'delivered', provider_ts: orphan.createdAt, retry_of: root.tsMsgId, retry_attempt: 1, retry_window_start: root.provider_ts, retry_root: root.tsMsgId, automated: false, recipient_contact_id: 'c-retry' });
  expect(row).not.toHaveProperty('broadcast_id');
  expect(await world.messagesRepo.listRetryChildrenConsistent(retryConv, root.tsMsgId)).toEqual([{ tsMsgId: row.tsMsgId, providerSid: 'SMorphan-r', retryAttempt: 1 }]);
  expect(world.auditEvents.filter((e) => e.event_type === 'message_sent')).toHaveLength(1);
  expect(persistedFor(row.tsMsgId)).toHaveLength(1);
  expect(root.retry_due_at).toBe(due); // untouched: no promise write on adoption
  expect(root).not.toHaveProperty('retry_outcome');
  expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan-r' });
});
it('10a the adopted row copies broadcast_id from a share root and carries ai as ai', /* seedRow with broadcastId: 'bcast-9', author: 'ai' -> the retry row has broadcast_id 'bcast-9', author 'ai', automated true when the root had automated: true */);
it('10b recipient_contact_id is absent when the recorded contact is soft-deleted or no longer holds the number; media rides only when the facts say media went - the row\'s attachments, else its raw mediaUrls (deviation 9)', /* four sub-cases: contact.deleted_at set; contact.phone changed; root with media_attachments but record mediaCount 0 -> the adopted row has neither media_attachments nor mediaUrls and type sms; mediaCount 1 with attachments -> media_attachments and type mms; mediaCount 1 with raw mediaUrls only -> mediaUrls copied, no media_attachments, type mms */);
it('10c the ORIGINAL message inside the window is held by its own row (other) - never adopted as the retry, never an unidentified candidate (Review Focus 2)', async () => {
  // the root has a sid# row; plant its provider twin in the window beside the retry orphan
  register(); await seedOneToOne(); const root = await seedRow('SMroot', { providerTs: iso(Date.now() - 5_000) });
  const owner = rOwner(root, 1); const at = await reconciling(owner, factsFor(TENANT_PHONE));
  plant({ providerSid: 'SMroot', providerStatus: 'undelivered', errorCode: '30003', to: TENANT_PHONE, createdAt: root.provider_ts });
  plant({ providerSid: 'SMorphan-r', providerStatus: 'sent', to: TENANT_PHONE });
  await runCheck(payloadOf(owner, at));
  expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'adopted', sid: 'SMorphan-r' });
  expect(world.messages.filter((m) => m.provider_sid === 'SMroot')).toHaveLength(1); // no second row for the root
});
it('10d a redelivered check is idempotent: the same envelope twice adopts once (one row, one pointer, one audit)', /* dispatch the same wire twice, as case 2\'s registration test does */);
it('10e the known-SID path adopts the row sendMessage appended before a record-phase failure as a repair (mine) - no second row (spec 14)', /* seedRow('SMretry1', { retryOf: root.tsMsgId, retryAttempt: 1, retryRoot: root.tsMsgId }); reconciling(owner, facts, { sid: 'SMretry1' }); plant the provider twin; runCheck -> adoption 'skipped', record done/adopted, world.messages count unchanged */);
it('11 never_sent inside the window re-drives ONCE: a messaging.retrySend envelope with the retried row\'s providerSid, the attempt and NO deferred; the record redriven; the promise REFRESHED and emitted', async () => {
  register(); const got = recordJobs(RETRY_SEND_JOB);
  await seedOneToOne(); const root = await seedRow('SMroot', { providerTs: iso(Date.now() - 20_000) }); root.retry_due_at = iso(Date.now() + 10_000);
  const owner = rOwner(root, 1); const at = await reconciling(owner, factsFor(TENANT_PHONE));
  await runChain(payloadOf(owner, at));
  expect(got).toEqual([{ providerSid: 'SMroot', conversationId: retryConv, attempt: 1 }]);
  expect(await recordOf(owner)).toMatchObject({ state: 'redriven', redriveCount: 1 });
  expect(Date.parse(root.retry_due_at!)).toBeGreaterThanOrEqual(Date.now() + RETRY_JOB_GRACE_MS + RETRY_PROMISE_GRACE_MS - 5_000);
  expect(persistedFor(root.tsMsgId)).toHaveLength(1);
  expect(lines(40).filter((l) => l['verdict'] === 'never_sent')).toHaveLength(1);
});
it('11a never_sent OUTSIDE the window closes redrive_refused / retry_window_closed while reconciling, ONE ERROR, promise untouched, no enqueue', /* root.provider_ts = 16 min ago; runChain; record done/redrive_refused cause retry_window_closed; got is []; root.retry_due_at unchanged; exactly one ERROR line with cause retry_window_closed */);
it('11b never_sent with NO usable origin fails open: the re-drive is enqueued (RSW D5)', /* root.provider_ts = 'not a time'; runChain; got has one envelope */);
it('11c a re-drive enqueue that throws closes enqueue_failed with NO retry_outcome and the promise untouched', /* the file\'s queue-refusal seam (case 17); expect record done/enqueue_failed; root has no retry_outcome; retry_due_at unchanged; one ERROR */);
it('12 unresolved (fail-list on every check): the record closes FIRST, then ONE write sets retry_due_at = the sentinel AND retry_outcome = unconfirmed, one ERROR, no re-send; a redelivered check re-applies the withdrawal', async () => {
  register(); await seedOneToOne(); const root = await seedRow('SMroot'); root.retry_due_at = iso(Date.now() + 10_000);
  const owner = rOwner(root, 1); const at = await reconciling(owner, factsFor(TENANT_PHONE));
  world.adapter.listMessages = async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); };
  const annotate = vi.spyOn(world.messagesRepo, 'annotateRetryPromise');
  await runChain(payloadOf(owner, at));
  expect(await recordOf(owner)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'provider_unreachable' });
  expect(root).toMatchObject({ retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' });
  expect(annotate).toHaveBeenCalledTimes(1);
  expect(capture.atLevel(50)).toHaveLength(1);
  expect(persistedFor(root.tsMsgId)).toHaveLength(2); // the withdrawal's emit, then afterClose's
  // the superseded exit re-applies: strip the fields, redeliver the last check
  delete root.retry_outcome; root.retry_due_at = iso(Date.now() + 10_000);
  await runCheck({ owner: toOwnerRef(owner), attemptedAt: at, checkNo: 2 });
  expect(root).toMatchObject({ retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' });
});
it('12a a CONTACT-keyed attempt whose thread number changed or vanished is unresolved digest_mismatch and withdraws (the key is the contact id, so resolve succeeds and the digest decides)', /* two sub-cases on the default seedRow (recipientContactId 'c-retry'): conversation.participant_phone changed -> digest_mismatch + withdrawal; participant_phone deleted -> the SAME (currentPhone undefined -> digest_mismatch), record done/unresolved, root withdrawn */);
it('12a2 a PHONE-keyed attempt (no recorded recipient) whose thread number vanished is unaddressable: resolve returns undefined, INFO "owner recipient not found", the record stays reconciling for the sweeper', /* seedRow with recipientContactId: undefined and the owner keyed phone#TENANT_PHONE; delete conversation.participant_phone; runCheck; record still reconciling; one INFO; root untouched */);
it('12b a retried row that no longer exists leaves the record for the sweeper (INFO)', /* delete the row from world.messages; runCheck; record still reconciling; one INFO */);
it('12c the second unknown after one re-drive closes unresolved second_unknown and withdraws', /* record with redriveCount 1 (markRedriven then a fresh claim + handToReconcile - the file\'s case 20 recipe); runChain with an empty provider; record done/unresolved cause second_unknown; root withdrawn */);
it('isBroadcastRowFor never claims a share-RETRY row (retry_of set) for the share recipient', () => {
  const owner = { broadcastId: 'b-1', contactId: 'c-1', slotTsMsgId: undefined };
  expect(isBroadcastRowFor({ broadcast_id: 'b-1', recipient_contact_id: 'c-1', tsMsgId: 'x' }, owner)).toBe(true);
  expect(isBroadcastRowFor({ broadcast_id: 'b-1', recipient_contact_id: 'c-1', tsMsgId: 'x', retry_of: 'root' }, owner)).toBe(false);
});
```

`sendAttemptsRepo.integration.test.ts` (DynamoDB Local): one case claims a `retry_send` owner with a `phone#` key, re-arms it, hands it to reconcile, lists it by recipient beside a `broadcast` record to the same digest and sender, and reads the raw record (`rawRecord` gains the fourth-kind branch): the stored `owner` map carries all six fields. The parity suite's three-kind case (`:399-413`) gains a `retry_send` owner as the fourth participant.

- [ ] **Step 4: Implement the reconcile's owner.**

`resolve`:
```ts
    case 'retry_send': {
      const row = await c.messages.getByTsMsgIdConsistent(ref.conversationId, ref.retriedTsMsgId);
      if (row === undefined) return undefined;
      const conversation = await c.conversations.getById(ref.conversationId);
      const key = retryRecipientKey(row, conversation);
      if (key === undefined || hashRecipientKey(key) !== ref.recipientKeyHash) return undefined;
      const owner: RetrySendOwner = { kind: 'retry_send', conversationId: ref.conversationId, retriedTsMsgId: ref.retriedTsMsgId, attempt: ref.attempt, recipientKey: key, retryRoot: ref.retryRoot };
      return { owner, key, row, ...(conversation !== undefined && { conversation }) };
    }
```
`currentPhone`: `case 'retry_send': { const phone = r.conversation?.participant_phone; return typeof phone === 'string' && phone.length > 0 ? phone : undefined; }`.

`heldBy`: the `relaysid#` branch keeps its condition but names the two relay kinds explicitly (`o.kind === 'relay_leg' || o.kind === 'relay_rung'`); the `sid#` row branch gains, before the `other` return:
```ts
  if (r.owner.kind === 'retry_send') {
    const o = r.owner;
    if (row.conversationId === o.conversationId && row.retry_of === o.retriedTsMsgId && row.retry_attempt === o.attempt) return { kind: 'mine' };
  }
```
(`isBroadcastRowFor` gains `if (row.retry_of !== undefined) return false;` as its first line and its `Pick` gains `'retry_of'`.)

`adopt`: `case 'retry_send': return adoptRetry(c, r, r.owner, m);` with:
```ts
/** R4: append the retry row sendMessage would have appended - lineage, root, share attribution, the send's own flags - through the same append (so the retrychild# pointer rides the transaction). Idempotent: a dedupe onto OUR lineage is `skipped`, onto any other row is `other`. No slot, no finalize, no promise write. */
async function adoptRetry(c: Ctx, r: Resolved, o: RetrySendOwner, m: ProviderMessageSummary): Promise<Found | { kind: 'other' }> {
  const row = r.row;
  if (row === undefined) throw new Error('adoptRetry: the retried row was not resolved');
  const record = await c.attempts.get(o);
  const mediaWent = (record?.mediaCount ?? 0) > 0;
  // Deviation 9: what the JOB sent, read back from its record - the durable attachments when the row has them, else the raw mediaUrls seam it replays; nothing when the plan sent body only.
  const attachments = mediaWent ? mediaAttachmentsOf(row) : [];
  const rawMediaUrls = mediaWent && attachments.length === 0 && row.mediaUrls !== undefined && row.mediaUrls.length > 0 ? row.mediaUrls : undefined;
  const rowStatus = mapTwilioStatus(m.providerStatus);
  const failed = rowStatus === 'failed' || rowStatus === 'undelivered';
  const errorCode = failed ? m.errorCode : undefined;
  const type = m.mediaCount > 0 ? 'mms' : 'sms';
  const participantPhone = r.conversation?.participant_phone;
  let recipientContactId: string | undefined;
  if (!r.key.startsWith('phone#')) {
    const contact = await c.contacts.getById(r.key);
    if (contact !== undefined && !isDeleted(contact) && typeof participantPhone === 'string' && contactHoldsPhone(contact, participantPhone)) recipientContactId = contact.contactId;
  }
  const windowStart = oneToOneRetryWindowOrigin(row);
  const appended = await c.messages.append({
    conversationId: o.conversationId, providerSid: m.providerSid, providerTs: m.createdAt, type, direction: 'outbound',
    author: row.author === 'ai' ? 'ai' : 'teammate',
    ...(row.body !== undefined && { body: row.body }),
    ...(attachments.length > 0 && { mediaAttachments: attachments }),
    ...(rawMediaUrls !== undefined && { mediaUrls: rawMediaUrls }),
    deliveryStatus: rowStatus, ...(errorCode !== undefined && { errorCode }),
    transportSchemaVersion: TRANSPORT_SCHEMA_VERSION, requestedTransport: type,
    automated: row.automated ?? true,
    ...(recipientContactId !== undefined && { recipientContactId }),
    retryOf: o.retriedTsMsgId, retryAttempt: o.attempt,
    ...(typeof windowStart === 'string' && { retryWindowStart: windowStart }),
    retryRoot: o.retryRoot,
    ...(row.broadcast_id !== undefined && { broadcastId: row.broadcast_id }),
  });
  if (appended.deduped) {
    const existing = await c.messages.getByProviderSidConsistent(m.providerSid);
    if (existing === undefined) throw new Error(`adoptRetry: the row for ${m.providerSid} deduped but cannot be read back`);
    if (!(existing.conversationId === o.conversationId && existing.retry_of === o.retriedTsMsgId && existing.retry_attempt === o.attempt)) return { kind: 'other' };
  } else {
    try { await c.adopt.audit.append(`conversations#${o.conversationId}`, 'message_sent', { providerSid: m.providerSid, automated: row.automated ?? true, author: row.author === 'ai' ? 'ai' : 'teammate' }); }
    catch (err) { c.log.error({ err, ...ownerLog(o) }, 'send.reconcile: retry adoption audit row failed (best-effort)'); }
  }
  // The status-preserving inbox touch with no preview (adoptBroadcastRecipient's shape, broadcastFanOut.ts:1428-1439): never moves the inbox backwards. Best-effort.
  let touched: ConversationItem | undefined;
  try {
    const current = r.conversation ?? (await c.conversations.getById(appended.conversationId));
    if (current !== undefined && (current.last_activity_at ?? '') < m.createdAt) {
      touched = await c.conversations.touchLastActivityPreservingStatus(appended.conversationId, undefined, m.createdAt);
    }
  } catch (err) {
    c.log.error({ err, ...ownerLog(o) }, 'send.reconcile: retry adoption inbox touch failed (best-effort)');
  }
  c.events.emit('message.persisted', { conversationId: appended.conversationId, tsMsgId: appended.tsMsgId, direction: 'outbound', deliveryStatus: rowStatus });
  if (touched !== undefined) c.events.emit('conversation.updated', toConversationUpdatedEvent(touched));
  if (failed) c.log.warn({ ...ownerLog(o), sid: m.providerSid, deliveryStatus: rowStatus, errorCode }, 'send.reconcile: adopted terminal failure on a retry row - the 30003 ladder does not continue from it');
  return { kind: 'found', sid: m.providerSid, adoption: appended.deduped ? 'skipped' : 'adopted', status: rowStatus };
}
```

`closeSlot`: `case 'retry_send': { if (code === SEND_UNCONFIRMED_CODE && r.row !== undefined) await withdrawRetryPromise({ messages: c.messages, events: c.events, log: c.log }, r.row, { ...ownerLog(r.owner) }); return; }` (the `redrive_refused` and `enqueue_failed` codes write nothing - the promise expires, Retry stays available).

`afterClose`: `case 'retry_send': { if (r.row !== undefined) c.events.emit('message.persisted', { conversationId: r.owner.conversationId, tsMsgId: r.owner.retriedTsMsgId, direction: r.row.direction, deliveryStatus: r.row.delivery_status }); return; }`.

`enqueueRedrive`: `case 'retry_send': { if (r.row === undefined) throw new Error('sendReconcile: the retried row was not resolved'); await enqueueSendRetry({ providerSid: r.row.provider_sid, conversationId: r.owner.conversationId, attempt: r.owner.attempt }, new Date()); return; }` (no `deferred`; `runAt = now` is an immediate enqueue).

`redriveRefusal`: before the relay checks:
```ts
  if (r.owner.kind === 'retry_send') {
    if (r.row === undefined) return 'retried_row_not_found';
    const originMs = parseRetryWindowOrigin(oneToOneRetryWindowOrigin(r.row));
    if (originMs !== undefined && !retryFitsSendWindow({ originMs, nowMs: Date.now(), backoffMs: 0 })) return RETRY_WINDOW_CLOSED_CODE;
    return undefined;
  }
```
`closeRedriveRefused`: the outcome line is `c.log.error(...)` when `cause === RETRY_WINDOW_CLOSED_CODE` (R9: a window close is ONE ERROR), else the existing WARN.

`redrive`: `const enqueued = await enqueueOrClose(...); if (enqueued && r.owner.kind === 'retry_send' && r.row !== undefined) await refreshRetryPromise({ messages: c.messages, events: c.events, log: c.log }, r.row, new Date(Date.now() + RETRY_JOB_GRACE_MS + RETRY_PROMISE_GRACE_MS).toISOString(), { ...ownerLog(r.owner) });`.

- [ ] **Step 5: Run, typecheck, commit**

Run: `cd app; npx vitest run test/sendReconcile.test.ts test/sendAttemptsRepo.integration.test.ts test/twilioWebhookHarnessSendAttempts.integration.test.ts test/broadcastFanOut.test.ts test/relayFanOut.test.ts test/relayRetryLeg.test.ts` -> PASS. `npm run typecheck` -> 0.

```bash
git status
git add app/src/repos/sendAttemptsRepo.ts app/src/jobs/sendReconcile.ts app/src/jobs/broadcastFanOut.ts app/test/helpers/twilioWebhookHarness.ts app/test/sendReconcile.test.ts app/test/sendAttemptsRepo.integration.test.ts app/test/twilioWebhookHarnessSendAttempts.integration.test.ts
git commit -m "feat(reconcile): the retry_send owner - keyed on the retried row and the attempt; adopts the retry row with its lineage, root and share attribution, re-drives once inside the window, withdraws the promise on unresolved; every owner switch exhaustive (retry-send-adoption T2)" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 3: The lineage exclusion in the sibling rule (R4, R12)

**Files:**
- Modify: `app/src/jobs/sendReconcile.ts` (`lookup` `:751-907` - the sibling filter at `:787-796` and the `same_fingerprint_sibling` test at `:903`)
- Test: `app/test/sendReconcile.test.ts` (the `retry_send owner` describe from Task 2)

**Interfaces:**
- Consumes: T1's `automaticAncestry`; T2's owner and `Resolved.row`.
- Produces: `predecessorMatchers(c, r): Promise<Array<(owner: SendAttemptOwner) => boolean>>` (module-local).

- [ ] **Step 1: Failing tests (spec 13):**

```ts
it('13 attempt 1 adopted, then attempt 2 never_sent inside the sibling span is RE-DRIVEN - the predecessor record is lineage, not a sibling', async () => {
  register(); const got = recordJobs(RETRY_SEND_JOB);
  await seedOneToOne(); const root = await seedRow('SMroot', { providerTs: iso(Date.now() - 30_000) });
  // attempt 1: its record done/adopted with the retry row it adopted
  const a1 = rOwner(root, 1); const at1 = await reconciling(a1, factsFor(TENANT_PHONE), { at: iso(Date.now() - 20_000) });
  const r1 = await seedRow('SMretry1', { retryOf: root.tsMsgId, retryAttempt: 1, retryRoot: root.tsMsgId, providerTs: iso(Date.now() - 19_000) });
  expect(await world.sendAttemptsRepo.closeFromReconcile(a1, at1, { outcome: 'adopted', sid: 'SMretry1' })).toBe(true);
  // attempt 2 retries r1 and finds nothing
  const a2 = rOwner(r1, 2, 'c-retry', root.tsMsgId); const at2 = await reconciling(a2, factsFor(TENANT_PHONE));
  await runChain(payloadOf(a2, at2));
  expect(await recordOf(a2)).toMatchObject({ state: 'redriven' });
  expect(got).toHaveLength(1);
});
it('13a a share root adopted inside the span is lineage too; an UNRELATED share to the same tenant still blocks', /* root with broadcastId 'bcast-1'; a broadcast owner record { broadcastId: 'bcast-1', contactKey: 'c-retry' } done/adopted at -20 s -> attempt 1 never_sent re-drives; then a second broadcast record { broadcastId: 'bcast-2', contactKey: 'c-retry' } reconciling at -10 s -> a fresh attempt on another root is unresolved same_fingerprint_sibling */);
it('13b a MANUAL-retry chain under the same root still blocks (same root is not lineage), and the original chain\'s attempt against the manual row\'s PARENT is not the manual row\'s producer', /* root R; manual row M (retryOf R, no retryAttempt); the original chain\'s a1 = rOwner(R, 1) reconciling; the manual chain\'s attempt 1 = rOwner(M, 1) never_sent -> unresolved same_fingerprint_sibling (a1 is not excluded: automaticAncestry(M) is []) */);
it('13c the ancestry walk stops at a manual row and at a broken retry_of', /* attempt 2 whose retried row r1 has retry_of pointing at a missing row: automaticAncestry is [r1]; the r1 producer (rOwner(missingId, 1)) done/adopted at -20 s is excluded; runChain re-drives */);
```

- [ ] **Step 2: Implement.** In `lookup`, before the sibling filter, compute the matchers ASYNC (the walk reads rows):

```ts
/** R4 (the lineage exclusion): this attempt's PREDECESSORS - the records that produced the rows on its retry_of ancestry, and the share root's own record - can never hold this attempt's message; they are excluded from the sibling rule. Every other owner has none. */
async function predecessorMatchers(c: Ctx, r: Resolved): Promise<Array<(owner: SendAttemptOwner) => boolean>> {
  if (r.owner.kind !== 'retry_send' || r.row === undefined) return [];
  const o = r.owner;
  const matchers = (await automaticAncestry(c.messages, r.row)).map((walked) => (owner: SendAttemptOwner) =>
    owner.kind === 'retry_send' && owner.conversationId === o.conversationId && owner.retriedTsMsgId === walked.retry_of && owner.attempt === walked.retry_attempt);
  const broadcastId = r.row.broadcast_id;
  if (broadcastId !== undefined) matchers.push((owner) => owner.kind === 'broadcast' && owner.broadcastId === broadcastId && owner.contactKey === r.key);
  return matchers;
}
```
and in the filter: `const predecessors = await predecessorMatchers(c, r); ... .filter((s) => { ...; return attemptKey(s.owner) !== self && !predecessors.some((isPredecessor) => isPredecessor(s.owner)) && startMs >= siblingFromMs && startMs <= siblingToMs; })`. The exclusion applies to BOTH uses of `siblings` (the SID skip and the `same_fingerprint_sibling` test), which the single filtered list already guarantees.

- [ ] **Step 3: Run, commit**

Run: `cd app; npx vitest run test/sendReconcile.test.ts` -> PASS. `npm run typecheck` -> 0.

```bash
git status
git add app/src/jobs/sendReconcile.ts app/test/sendReconcile.test.ts
git commit -m "feat(reconcile): a retry attempt's predecessors - the records that produced its retry_of ancestry and the share root's own record - are lineage, never siblings (retry-send-adoption T3)" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---
## Slice C - the job

### Task 4: `messaging.retrySend` on the record (R1, R2, R3, R7 job side, R8, R9, R11, R12)

**Files:**
- Modify: `app/src/jobs/retrySend.ts` (`RetrySendJobDeps` `:131-150`; the handler `:153-352` rewritten; the `getContext` import goes; the marker call goes)
- Modify: `app/src/jobs/registerHandlers.ts` (`:59` passes `{ sendAttemptsRepo: deps.sendAttemptsRepo }`; the doc at `:31-36` says "four send handlers")
- Modify: `app/test/twilioStatusWebhook.test.ts` (18 registration sites: `:1271, :1330, :1371, :1397, :1429, :1459, :1493, :1517, :1586, :1622, :1650, :1670, :1695, :1728, :1759, :1804, :1837, :1877`; the marker cases `:1435-1503`; the window case's marker pin `:1602`; the recipient-read case `:1777`; the must-not-annotate pin `:1855-1898`)
- Create: `app/test/retrySendAttempt.test.ts` (the record cases; wall clock; the real reconcile registered beside the job where a case needs it)

**Interfaces:**
- Consumes: T1 (`planRetryMedia`, `pinnedSender`, `resolveRetryRoot`, `retryRecipientKey`, `conversationRetryDecline`, `refreshRetryPromise`, `withdrawRetryPromise`, `listRetryChildrenConsistent`, `getByProviderSidConsistent`, `deferred`); T2 (`RetrySendOwner`, `toOwnerRef`, `enqueueSendReconcile`, `reconcileDelayMs`, `reconcileCheckDelaysMs`); `gateFor` (`lib/sendAttemptGate.ts:30-39`); `guardWrite`; `bodyFingerprint`, `recipientDigest`, `safeRecipientKey`; the send errors (`sendMessage.ts:63-287`); `classifySendFailure`; `SEND_RETRYABLE_CODE`, `ENQUEUE_FAILED_CODE`, `SMS_SENDING_DISABLED_CODE` (`lib/sendOutcome.ts:14-19`); `retryFitsSendWindow`, `withinRetrySendWindow`, `RETRY_WINDOW_CLOSED_CODE`, `RETRY_PROMISE_GRACE_MS`.
- Produces: the job as specified; `RetrySendJobDeps` per the shared block; the registration with the attempts repo.

**The handler, in order (R2).** Steps 1-4b run BEFORE the claim and may throw (SQS redelivers - reads only). One outer try/catch around steps 6-8 with `phase` (`'prepare' | 'sending' | 'record'`); every failure-arm write through `guardWrite` with the fence answer captured; nothing throws after the claim.

```ts
export function registerRetrySendJobHandler(deps: RetrySendJobDeps = {}): void {
  const log = deps.logger ?? defaultLogger;
  const now = deps.now ?? Date.now;
  const nowIso = (): string => new Date(now()).toISOString();
  // lazy deps as today, plus:
  let conversations = deps.conversationsRepo; let attempts = deps.sendAttemptsRepo; let config = deps.config; const events = deps.events ?? appEvents;

  defineJobHandler(RETRY_SEND_JOB, async (rawPayload) => {
    const payload = parseRetrySendPayload(rawPayload);
    // Each lazy dep is bound to a CONST once resolved: the nested helpers below close over these (TypeScript does not narrow a `let` inside a nested function).
    const sendService = (sendMessage ??= createSendMessageService({ logger: deps.logger }));
    const messagesRepo = (messages ??= createMessagesRepo({ logger: deps.logger }));
    const conversationsRepo = (conversations ??= createConversationsRepo({ logger: deps.logger }));
    const attemptsRepo = (attempts ??= createSendAttemptsRepo({ logger: deps.logger }));
    const appConfig = (config ??= loadConfig());
    if (!mediaStoreInit) { mediaStore = createMediaStore(); mediaStoreInit = true; }
    const base: Record<string, unknown> = { providerSid: payload.providerSid, conversationId: payload.conversationId, attempt: payload.attempt };

    // 1. THE RETRIED ROW (consistent: the R3 condition expects the promise this read saw) and the chain facts.
    const retried = await messagesRepo.getByProviderSidConsistent(payload.providerSid);
    if (!retried) { log.warn(base, 'retrySend: original message not found - nothing to retry'); return; }
    if (retried.direction !== 'outbound') { log.warn(base, 'retrySend: original message is not outbound - refusing'); return; }
    const retryRoot = await resolveRetryRoot(messages, retried);
    const windowStart = oneToOneRetryWindowOrigin(retried);
    const originMs = parseRetryWindowOrigin(windowStart);
    const ctx = { ...base, retriedTsMsgId: retried.tsMsgId, retryRoot };

    // 2. RSW D14: the recorded recipient, by id (as today; a throw redelivers).
    ... unchanged block (retrySend.ts:190-201) ...

    // 3. THE CONVERSATION: the facts, and a designed decline (never a throw) for a thread the retry cannot address.
    const conversation = await conversationsRepo.getById(payload.conversationId);
    const decline = conversationRetryDecline(conversation);
    if (decline !== undefined) { log.warn({ ...ctx, reason: decline }, 'retrySend: conversation not retryable'); return; }
    const participantPhone = conversation!.participant_phone!;
    const recipientKey = retryRecipientKey(retried, conversation)!;   // defined: the decline above proved the phone
    const owner: RetrySendOwner = { kind: 'retry_send', conversationId: payload.conversationId, retriedTsMsgId: retried.tsMsgId, attempt: payload.attempt, recipientKey, retryRoot };
    const octx = { ...ctx, recipientKey: safeRecipientKey(recipientKey) };
    const promise: RetryPromiseDeps = { messages: messagesRepo, events, log };   // RetryPromiseDeps

    // 4. AN EXISTING ATTEMPT FIRST (SOR D8 through the shared gate; a stale attempting record is taken over HERE and handed off exactly once).
    const gate = await gateFor(attempts, owner, now());
    if (gate.kind === 'taken_over') { log.info({ ...octx, gate: gate.kind }, 'retrySend: a stale attempt was taken over into reconcile'); await handOff(owner, gate.record.attemptedAt, retried, octx); return; }
    if (gate.kind === 'defer') { log.info({ ...octx, gate: gate.kind }, 'retrySend: a concurrent delivery owns this attempt'); return; }
    if (gate.kind === 'skip') { log.info({ ...octx, gate: gate.kind }, 'retrySend: this attempt is already resolved'); return; }
    const redriven = gate.record?.state === 'redriven';
    // 4a. A MANUAL RETRY SUPERSEDES THE CHAIN: one consistent Query on the pointer partition.
    const children = await messagesRepo.listRetryChildrenConsistent(payload.conversationId, retried.tsMsgId);
    if (children.some((child) => child.retryAttempt === undefined)) {
      await declineBeforeClaim(owner, redriven, 'manual_retry_superseded', octx);
      log.info({ ...octx, cause: 'manual_retry_superseded' }, 'retrySend: a manual retry superseded this attempt');
      return;
    }
    // 4b. RSW D4: the strict window (fail-open on no origin, as today).
    if (originMs === undefined) log.warn(octx, 'retrySend: no usable window origin - sending without a window check (fail open)');
    else if (!withinRetrySendWindow({ originMs, nowMs: now() })) {
      await declineBeforeClaim(owner, redriven, RETRY_WINDOW_CLOSED_CODE, octx);
      log.error({ ...octx, retryDecision: 'window_closed', cause: RETRY_WINDOW_CLOSED_CODE }, 'retrySend: retry window closed - retry chain ended without sending');
      return;
    }

    // 5. CLAIM (SOR D8a) - the duplicate guard this job has instead of the run-once marker.
    const plan = planRetryMedia(retried, mediaStore !== undefined);
    const sender = pinnedSender(appConfig);
    const fp = bodyFingerprint(retried.body);
    const facts: SendAttemptFacts = { recipientDigest: recipientDigest(sender, participantPhone), ...(sender !== undefined && { sender }), bodyHash: fp.hash, bodyShort: fp.short, mediaCount: plan.mediaCount };
    const claim = await attemptsRepo.claim(owner, facts, nowIso());
    if (claim.outcome === 'refused') { log.info({ ...octx, state: claim.record.state, fresh: claim.fresh }, 'retrySend: claim refused - another delivery owns this attempt or it is resolved'); return; }
    if (claim.outcome === 'takeover') {
      if (await attemptsRepo.takeOver(owner, claim.record)) await handOff(owner, claim.record.attemptedAt, retried, octx);
      else log.info(octx, 'retrySend: takeover lost - another writer moved the stale attempt');
      return;
    }
    let ref: AttemptRef = { attemptNo: claim.record.attemptNo, attemptedAt: claim.record.attemptedAt };
    const secondUnknownWouldClose = claim.record.redriveCount >= 1;
    const secondDeferralWouldClose = payload.deferred === true;
    let phase: 'prepare' | 'sending' | 'record' = 'prepare';
    let takenOver = false;
    let outcome: SendMessageOutcome | undefined;
    try {
      // 6. PREPARE: the presign (the plan decided what goes; the URLs are minted here).
      const media = await presignRetryMedia(plan, mediaStore, log, octx);   // { mediaUrls?, attachments? } - the existing block (:267-301), fed by the plan
      // 7. SEND, re-arming the claim as the last step before the provider call.
      phase = 'sending';
      outcome = await sendService({
        conversationId: payload.conversationId,
        ...(retried.body !== undefined && { body: retried.body }),
        ...(media.mediaUrls !== undefined && { mediaUrls: media.mediaUrls }),
        ...(media.attachments !== undefined && { attachments: media.attachments }),
        automated: retried.automated ?? true,
        author: retried.author === 'ai' ? 'ai' : 'teammate',
        ...(recipient !== undefined && { recipient }),
        retryOf: retried.tsMsgId, retryAttempt: payload.attempt,
        ...(typeof windowStart === 'string' && { retryWindowStart: windowStart }),
        retryRoot,
        ...(retried.broadcast_id !== undefined && { broadcastId: retried.broadcast_id }),
        beforeProviderSend: async () => {
          const rearmed = await attemptsRepo.rearm(owner, ref, nowIso());
          if (rearmed === undefined) { takenOver = true; return false; }
          ref = rearmed; return true;
        },
      });
      // 8. RECORD: the row exists (sendMessage appended it with its lineage); close the attempt.
      phase = 'record';
      let fenced = false;
      const wrote = await guardWrite(log, octx, 'finishAttempt', async () => { fenced = await attemptsRepo.finishAttempt(owner, ref, { outcome: 'sent', sid: outcome!.providerSid }); });
      if (wrote && !fenced) log.warn({ ...octx, newProviderSid: outcome.providerSid }, 'retrySend: attempt fence lost after a recorded send; the takeover reconcile repairs');
      log.info({ ...octx, retryOf: retried.tsMsgId, newProviderSid: outcome.providerSid }, 'retrySend: message re-sent');
      return;
    } catch (err) {
      const held = ref;
      if (phase === 'record') { log.error({ err, ...octx }, 'retrySend: a record-phase step threw after the send - the attempt stays attempting for the sweeper'); return; }
      if (phase === 'prepare') { await deferOrEnd(owner, held, retried, SEND_RETRYABLE_CODE, err, octx); return; }
      if (err instanceof SendRefusedError) { await refuse(owner, held, err.code, octx); return; }   // the wrapper's kill switch (SmsSendingDisabledError extends SendRefusedError) lands here
      if (err instanceof SendNotAttemptedError) {
        if (takenOver) { log.info(octx, 'retrySend: attempt taken over before the send - not sent; the takeover owns it'); return; }
        await deferOrEnd(owner, held, retried, SEND_RETRYABLE_CODE, err, octx); return;
      }
      if (err instanceof SendAcceptedNotRecordedError) {
        log.error({ err, ...octx, sid: err.providerSid }, 'retrySend: sent_unrecorded - the retry was sent but not recorded; its SID goes to reconcile');
        await handToReconcile(owner, held, retried, octx, err.providerSid); return;
      }
      const classification: SendFailureClassification = err instanceof ProviderSendFailedError ? err.classification : { kind: 'unknown' };
      if (classification.kind === 'rejected') {
        if (classification.code === SMS_SENDING_DISABLED_CODE) { await refuse(owner, held, SMS_SENDING_DISABLED_CODE, octx); return; }   // deviation 2
        const cause = classification.code ?? (classification.status !== undefined ? String(classification.status) : undefined);
        await finish(owner, held, { outcome: 'rejected', ...(cause !== undefined && { cause }) }, octx);
        log.error({ ...octx, errorCode: classification.code, status: classification.status, outcome: 'rejected' }, 'retrySend: retry chain ended - provider rejected the retry');
        return;
      }
      if (classification.kind === 'retryable') { await deferOrEnd(owner, held, retried, classification.code ?? SEND_RETRYABLE_CODE, err, octx); return; }
      await onUnknown(owner, held, retried, secondUnknownWouldClose, err, octx);
    }
  });
```

The module-local helpers. They are declared INSIDE the handler, after the const bindings above (`sendService`, `messagesRepo`, `conversationsRepo`, `attemptsRepo`, `appConfig` - a nested function cannot narrow the outer `let`s, so every helper reads the consts), each with the full signature shown; `octx` is `Record<string, unknown>`:

```ts
    type Ctx = Record<string, unknown>;
    /** ONE fenced close: the write through guardWrite (a throw is logged ERROR there), the fence answer captured here (deviation 6). 'won' = resolved and the fence held; 'lost' = resolved but the fence failed (a takeover owns the record); 'failed' = the write threw. */
    async function finish(owner: RetrySendOwner, ref: AttemptRef, result: { outcome: SendAttemptOutcome; sid?: string; cause?: string }, octx: Ctx): Promise<'won' | 'lost' | 'failed'> {
      let won = false;
      const wrote = await guardWrite(log, octx, 'finishAttempt', async () => { won = await attemptsRepo.finishAttempt(owner, ref, result); });
      if (!wrote) return 'failed';
      if (!won) { log.info({ ...octx, outcome: result.outcome, cause: result.cause }, 'retrySend: attempt close lost its fence - the takeover owns the record'); return 'lost'; }
      return 'won';
    }

    /** A refusal: the record done/refused with the code; the promise expires on RSW's clock. WARN, as today. */
    async function refuse(owner: RetrySendOwner, ref: AttemptRef, code: string, octx: Ctx): Promise<void> {
      await finish(owner, ref, { outcome: 'refused', cause: code }, octx);
      log.warn({ ...octx, refusal: code, outcome: 'refused' }, 'retrySend: send refused - retry chain stopped');
    }

    /** A pre-claim decline on a redriven record closes it (SOR D8 rev 11); on done/retryable or absent nothing is written. */
    async function declineBeforeClaim(owner: RetrySendOwner, redriven: boolean, cause: string, octx: Ctx): Promise<void> {
      if (!redriven) return;
      let closed = false;
      const wrote = await guardWrite(log, octx, 'closeRedriven', async () => { closed = await attemptsRepo.closeRedriven(owner, { outcome: 'refused', cause }); });
      if (wrote && !closed) log.info({ ...octx, cause }, 'retrySend: decline not recorded - another delivery re-claimed the re-driven attempt');
    }

    /** R3 deferred: the attempt's SINGLE deferral. ENQUEUE FIRST, then release the record retryable, then REFRESH. A LOST release (a takeover owns the record - unreachable for a 429 that returned inside the claim TTL, kept for the fence's sake) refreshes nothing: the takeover's reconcile refreshes for itself. A THROWN release leaves the record `attempting` while the deferred job is live, so the promise IS refreshed (the bubble and the route's record guard then agree: no Retry, 409 retry_pending) and the strand is named - the deferred run meets its own stale record (a takeover past the TTL) or, on a lane whose backoff is under the TTL, defers and strands for the sweeper. Terminal (a second deferral, or a re-run past the window): done/refused - never claimable again. */
    async function deferOrEnd(owner: RetrySendOwner, ref: AttemptRef, retried: MessageItem, cause: string, err: unknown, octx: Ctx): Promise<void> {
      const backoffMs = resolveSendRetryBackoffMs(payload.attempt);
      const nowMs = now();
      if (secondDeferralWouldClose) {
        await finish(owner, ref, { outcome: 'refused', cause: 'deferral_cap' }, octx);
        log.error({ err, ...octx, cause: 'deferral_cap', outcome: 'refused' }, 'retrySend: retry deferred twice - chain ended'); return;
      }
      if (originMs !== undefined && !retryFitsSendWindow({ originMs, nowMs, backoffMs })) {
        await finish(owner, ref, { outcome: 'refused', cause: RETRY_WINDOW_CLOSED_CODE }, octx);
        log.error({ err, ...octx, cause: RETRY_WINDOW_CLOSED_CODE, outcome: 'refused' }, 'retrySend: a deferred re-run would land past the window - chain ended'); return;
      }
      const runAt = new Date(nowMs + backoffMs);
      try { await enqueueSendRetry({ providerSid: payload.providerSid, conversationId: payload.conversationId, attempt: payload.attempt, deferred: true }, runAt); }
      catch (enqueueErr) {
        await finish(owner, ref, { outcome: 'refused', cause: ENQUEUE_FAILED_CODE }, octx);
        log.error({ err: enqueueErr, ...octx, cause: ENQUEUE_FAILED_CODE, outcome: 'refused' }, 'retrySend: retry re-schedule failed - chain ended'); return;
      }
      const released = await finish(owner, ref, { outcome: 'retryable', cause }, octx);
      if (released === 'lost') return;   // the takeover owns the record and refreshes for itself (finish logged it)
      await refreshRetryPromise(promise, retried, runAt.toISOString(), octx);
      if (released === 'failed') {
        log.error({ err, ...octx, cause, runAt: runAt.toISOString() }, 'retrySend: retry re-scheduled but its record release threw - the record stays attempting; the deferred run will meet it (a takeover past the claim TTL, else a strand for the sweeper)');
        return;
      }
      log.warn({ err, ...octx, cause, runAt: runAt.toISOString(), outcome: 'retryable' }, 'retrySend: retry deferred - re-scheduled');
    }

    /** Enqueue check 0 (never throws): an enqueue failure closes the attempt unresolved and withdraws the promise (a send may have happened). Otherwise REFRESH to cover the schedule. */
    async function handOff(owner: RetrySendOwner, attemptedAt: string, retried: MessageItem, octx: Ctx): Promise<void> {
      try { await enqueueSendReconcile({ owner: toOwnerRef(owner), attemptedAt, checkNo: 0 }, reconcileDelayMs(attemptedAt, 0, now())); }
      catch (err) {
        let closed = false;
        const wrote = await guardWrite(log, octx, 'closeFromReconcile', async () => { closed = await attemptsRepo.closeFromReconcile(owner, attemptedAt, { outcome: 'unresolved', cause: ENQUEUE_FAILED_CODE }); });
        if (wrote && closed) await withdrawRetryPromise(promise, retried, octx);
        log.error({ err, ...octx, cause: ENQUEUE_FAILED_CODE, outcome: 'unresolved' }, wrote && closed ? 'retrySend: reconcile enqueue failed - attempt closed unresolved; the retry promise is withdrawn' : 'retrySend: reconcile enqueue failed and its close was lost or failed - the record decides'); return;
      }
      await refreshRetryPromise(promise, retried, new Date(Date.parse(attemptedAt) + reconcileCheckDelaysMs()[2]! + RETRY_PROMISE_GRACE_MS).toISOString(), octx);
      log.info({ ...octx, attemptedAt }, 'retrySend: retry outcome unknown - handed to reconcile');
    }

    /** Move to reconciling (with the SID when known) and hand off; the fence answer decides (the broadcast idiom). */
    async function handToReconcile(owner: RetrySendOwner, ref: AttemptRef, retried: MessageItem, octx: Ctx, sid?: string): Promise<void> {
      let handed = false;
      const wrote = await guardWrite(log, octx, 'handToReconcile', async () => { handed = await attemptsRepo.handToReconcile(owner, ref, sid); });
      if (wrote && handed) { await handOff(owner, ref.attemptedAt, retried, octx); return; }
      if (wrote) { log.info(octx, 'retrySend: hand-off fence lost - the takeover owns the record'); return; }
      // not written: the record stays attempting for the sweeper (guardWrite logged the ERROR)
    }

    /** R3 unknown: a second unknown after a re-drive closes unresolved and withdraws (SOR D13a); otherwise hand to reconcile. */
    async function onUnknown(owner: RetrySendOwner, ref: AttemptRef, retried: MessageItem, secondUnknownWouldClose: boolean, err: unknown, octx: Ctx): Promise<void> {
      if (secondUnknownWouldClose) {
        let closed = false;
        const wrote = await guardWrite(log, octx, 'finishAttempt', async () => { closed = await attemptsRepo.finishAttempt(owner, ref, { outcome: 'unresolved', cause: 'second_unknown' }); });
        if (wrote && closed) await withdrawRetryPromise(promise, retried, octx);
        log.error({ err, ...octx, cause: 'second_unknown', outcome: 'unresolved' }, 'retrySend: unknown send outcome after a re-drive - attempt closed unresolved; the retry promise is withdrawn'); return;
      }
      log.info({ err, ...octx }, 'retrySend: unknown send outcome - handing the attempt to reconcile');
      await handToReconcile(owner, ref, retried, octx);
    }
```

- [ ] **Step 1: The existing suite.** In `twilioStatusWebhook.test.ts` add ONE helper beside `wireJobs` (`:1544`) and route all 18 registration sites through it (each keeps its own `sendMessage` / `now` / `mediaStore` choice):

```ts
  /** Every dep the job reads, over the world's fakes - a registration missing one would lazily build a REAL DynamoDB repo. */
  function retryDeps(world: FakeWorld, logger: Logger, extra: Partial<RetrySendJobDeps> = {}): RetrySendJobDeps {
    return {
      messagesRepo: world.messagesRepo, contactsRepo: world.contactsRepo, conversationsRepo: world.conversationsRepo,
      sendAttemptsRepo: world.sendAttemptsRepo, events: world.events,
      config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: ORIGIN_SECRET, MESSAGING_DRIVER: 'console' }),
      logger, ...extra,
    };
  }
```
(The config carries no `BUSINESS_PHONE_NUMBER`, so `world.sent`'s exact `toEqual` pins - `{ to, body }` with no `from` - stay byte-identical; the record's `sender` is simply absent in this file.) Add `vi` to the file's vitest import (`:6`; the rewritten cases spy). Two exact `toEqual` pins on the SPY's captured `SendMessageInput` change shape and are re-pinned, not weakened: `:1706-1716` (the legacy-row case) becomes `expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ conversationId: seeded.conversationId, body: 'outbound body', automated: true, author: 'teammate', retryOf: seeded.tsMsgId, retryAttempt: 1, retryWindowStart: seeded.provider_ts, retryRoot: seeded.tsMsgId }); expect(typeof calls[0]!.beforeProviderSend).toBe('function'); expect(calls[0]).not.toHaveProperty('broadcastId');` - and any other `toEqual` on `calls` in the file (grep `expect(calls).toEqual`) is converted the same way. Rewrite the three marker cases:
  - `:1435-1474` -> `'DUPLICATE GUARD: a redelivered job (same jobId) meets the record - the gate skips the finished attempt, nothing is re-sent, and the delivery resolves'`: same setup; after the first dispatch `world.sent` has 1 and `world.sendAttempts.size` is 1 with `state: 'done', outcome: 'sent'`; the second dispatch resolves, `world.sent` stays 1, ONE INFO line has `msg === 'retrySend: this attempt is already resolved'` and `gate: 'skip'` (the step-4 gate answers BEFORE any claim, so no `claim refused` line exists), and `world.jobExecutionMarkers.size` is 0.
  - `:1476-1503` -> `'a throwing attempt-record read BEFORE the claim propagates as a handler failure (redelivery) - nothing sent, nothing claimed'`: `vi.spyOn(world.sendAttemptsRepo, 'get').mockRejectedValue(new Error('record read exploded'))`; `dispatchJob` rejects with it; `world.sent` is 0; `world.sendAttempts.size` is 0.
  - `:1583-1605` (window closed): replace the marker pin with `expect(world.sendAttempts.size).toBe(0)` (a decline holds no claim, RSW #6).
  - `:1748-1779` (recipient read throws): replace `jobExecutionMarkers.size` with `world.sendAttempts.size === 0`.
  - `:1855-1898` (must-not-annotate): also `world.messagesRepo.annotateRetryPromise = async () => { annotates += 1; return true; }` - `annotates` stays 0 on a success.
  - Every other site: unchanged assertions.

- [ ] **Step 2: Failing tests in `app/test/retrySendAttempt.test.ts`** - the world + jobs machinery as `sendReconcile.test.ts` builds it (`:1-113`: `_resetForTests`, `InMemorySchedulerAdapter`, `InProcessOutboundQueueAdapter`, `createFakeWorld`, a capture logger). WALL CLOCK throughout (`now` unset): rows seed relative to `Date.now()`, and the real reconcile (`registerSendReconcileJobHandler` over the same world, `sendReconcile.test.ts:99-113`) runs beside the job where a case says so. `OUR_NUMBER` (the harness constant) is `BUSINESS_PHONE_NUMBER` for BOTH the send service and the job, so the record has a `sender` and a reconcile can list. Helpers:

```ts
  const config = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: ORIGIN_SECRET, MESSAGING_DRIVER: 'console', BUSINESS_PHONE_NUMBER: OUR_NUMBER } as NodeJS.ProcessEnv);
  function wire(extra: Partial<RetrySendJobDeps> = {}): void {
    registerRetrySendJobHandler({ sendMessage: createSendMessageService({ config, logger, adapter: world.adapter, conversationsRepo: world.conversationsRepo, messagesRepo: world.messagesRepo, contactsRepo: world.contactsRepo, auditRepo: world.auditRepo, events: world.events }),
      messagesRepo: world.messagesRepo, contactsRepo: world.contactsRepo, conversationsRepo: world.conversationsRepo, sendAttemptsRepo: world.sendAttemptsRepo, config, events: world.events, logger, ...extra });
  }
  /** A failed 30003 one-to-one row (the retried row) with a live promise, in a consented tenant's thread. */
  async function seedRetried(sid: string, overrides: Partial<MessageItem> = {}): Promise<MessageItem> { /* world.contacts.push({ contactId: 'c-real', type: 'tenant', phone: TENANT_PHONE, consent_method: 'verbal_in_person' }) once; seedOutbound-style append with delivery_status 'undelivered', error_code '30003', provider_ts now - 30 s, retry_due_at now + 10 s, automated: false, recipient_contact_id: 'c-real', then Object.assign(overrides) */ }
  const ownerOf = (row: MessageItem, attempt: number, key = 'c-real'): SendAttemptOwner => ({ kind: 'retry_send', conversationId: row.conversationId, retriedTsMsgId: row.tsMsgId, attempt, recipientKey: key, retryRoot: row.retry_root ?? row.tsMsgId });
  const run = async (row: MessageItem, attempt = 1, extra: Partial<RetrySendPayload> = {}) => { await enqueue(RETRY_SEND_JOB, { providerSid: row.provider_sid, conversationId: row.conversationId, attempt, ...extra }); await outbound.settle(); };
  const iso = (ms: number): string => new Date(ms).toISOString();
  /** THIS attempt's facts, exactly as the job computes them at the claim (the 6e/6f seeds). */
  const factsFor = (row: MessageItem): SendAttemptFacts => { const fp = bodyFingerprint(row.body); return { recipientDigest: recipientDigest(OUR_NUMBER, TENANT_PHONE), sender: OUR_NUMBER, bodyHash: fp.hash, bodyShort: fp.short, mediaCount: 0 }; };
  /** A recording stub for a job the handler enqueues (sendReconcile.test.ts:199-205): an IMMEDIATE enqueue (delaySeconds 0 - e.g. check 0 for an attempt already older than 5 s) is dispatched at once by the in-process queue and never lands in `outbound.delayed`; without a handler that dispatch is swallowed with an ERROR (scheduler.ts:198-202). The recorder catches both the immediate and (after deliverDelayed) the delayed ones. */
  function recordJobs(jobName: string): unknown[] { const got: unknown[] = []; defineJobHandler(jobName, async (p) => { got.push(p); }); return got; }
  /** Every send.reconcile hand-off the job made: the delayed envelopes still queued plus the immediate ones the recorder took. Cases that need the REAL reconcile register it instead (registerReconcile) and use runChain. */
  const reconcileHandOffs = (recorded: unknown[]) => [...outbound.delayed.filter((d) => d.envelope.jobName === SEND_RECONCILE_JOB).map((d) => d.envelope.payload), ...recorded];
  const reconcileEnvelopes = () => outbound.delayed.filter((d) => d.envelope.jobName === SEND_RECONCILE_JOB);
  const retryEnvelopes = () => outbound.delayed.filter((d) => d.envelope.jobName === RETRY_SEND_JOB);
  /** The REAL reconcile over the same world (sendReconcile.test.ts:99-113) for the cases that drive a chain end to end (11 second half, 6b when it should run). */
  function registerReconcile(): void { registerSendReconcileJobHandler({ adapter: world.adapter, messagesRepo: world.messagesRepo, broadcastsRepo: world.broadcastsRepo, contactsRepo: world.contactsRepo, conversationsRepo: world.conversationsRepo, sendAttemptsRepo: world.sendAttemptsRepo, activityEventsRepo: world.activityEventsRepo, listingSendsRepo: world.listingSendsRepo, auditRepo: world.auditRepo, events: world.events, logger }); }
  /** Run every send.reconcile check the chain schedules, to its end (the sendReconcile.test.ts runNextCheck/runChain idiom, copied: splice the next SEND_RECONCILE_JOB item out of outbound.delayed, dispatchJob it, settle, repeat). */
  async function runReconcileChain(): Promise<void> { /* while (reconcileEnvelopes().length > 0) { const index = outbound.delayed.findIndex((d) => d.envelope.jobName === SEND_RECONCILE_JOB); const [item] = outbound.delayed.splice(index, 1); await dispatchJob(JSON.parse(JSON.stringify(item!.envelope))); await outbound.settle(); } */ }
  /** The fake's real send, captured once per test so a case can restore it after an override. */
  let originalSend: typeof world.adapter.sendPreparedMessage;
  beforeEach(() => { originalSend = world.adapter.sendPreparedMessage; });
  /** Every provider call, whatever the override answers - the count `world.sent` cannot give when the override throws. */
  const providerCalls = () => vi.spyOn(world.adapter, 'sendPreparedMessage');
  const unknownOn = () => { world.adapter.sendPreparedMessage = async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); }; };
  const rejectWith = (code: number) => { world.adapter.sendPreparedMessage = async () => { throw Object.assign(new Error(`rejected ${code}`), { code, status: 400 }); }; };   // a 4xx status is what makes a code `rejected` (sendOutcome.ts:107-110)
  const throttle = () => { world.adapter.sendPreparedMessage = async () => { throw Object.assign(new Error('too many'), { code: 20429, status: 429 }); }; };
  /** A plain outbound row in the retried row's thread (noise, or a child): a NewMessage the fake append accepts. */
  const outboundRow = (sid: string, atMs: number, conversationId: string): NewMessage => ({ conversationId, providerSid: sid, providerTs: new Date(atMs).toISOString(), type: 'sms', direction: 'outbound', author: 'teammate', body: `noise ${sid}`, deliveryStatus: 'delivered' });
```

Cases (the numbers are the SPEC's section 4 items; each is one `it`; the deferral family is item 4 with suffixes):

```ts
it('1 FAILS ON MAIN: an unknown provider error (a dropped socket) no longer rethrows - the job returns, the record is reconciling, one send.reconcile envelope carries the retry_send owner with no phone, and the retried row\'s promise is refreshed and emitted', async () => {
  wire(); unknownOn(); const recorded = recordJobs(SEND_RECONCILE_JOB);
  const row = await seedRetried('SMroot1');
  const before = row.retry_due_at!;
  await run(row);
  expect(await world.sendAttemptsRepo.get(ownerOf(row, 1))).toMatchObject({ state: 'reconciling', attemptNo: 1, sender: OUR_NUMBER, mediaCount: 0 });
  const handOffs = reconcileHandOffs(recorded); expect(handOffs).toHaveLength(1);   // a fresh attempt's check 0 is +5 s: it sits in outbound.delayed
  expect(handOffs[0]).toMatchObject({ owner: { kind: 'retry_send', conversationId: row.conversationId, retriedTsMsgId: row.tsMsgId, attempt: 1, retryRoot: row.tsMsgId, recipientKeyHash: 'c-real' }, checkNo: 0 });
  expect(JSON.stringify(handOffs[0])).not.toContain('phone#+');
  expect(Date.parse(row.retry_due_at!)).toBeGreaterThan(Date.parse(before) + RETRY_PROMISE_GRACE_MS);
  expect(world.emitted.filter((e) => e.event === 'message.persisted' && (e.payload as { tsMsgId: string }).tsMsgId === row.tsMsgId)).toHaveLength(1);
  expect(capture.atLevel(30).some((l) => l['msg'] === 'retrySend: retry outcome unknown - handed to reconcile')).toBe(true);
  expect(capture.atLevel(50)).toHaveLength(0);
});
it('1b a phone-keyed recipient (no recorded contact) hashes: the envelope carries recipientKeyHash = hashRecipientKey(phone#...) and never the number', /* seedRetried with recipient_contact_id deleted; assert the hash and the absence of TENANT_PHONE in the envelope JSON */);
it('2 a rejected retry (21211 with a 4xx status): record done/rejected cause 21211, no retry row, the retried row\'s 30003 and promise untouched, ONE ERROR', /* rejectWith(21211); assert; world.messages.filter(retry_of) is [] */);
it('2a the adapter\'s kill switch (sms_sending_disabled, classified rejected) records done/refused at WARN (deviation 2)', /* throw the adapter\'s SmsSendingDisabledError from sendPreparedMessage */);
it('3 a refused retry (the contact opted out during the backoff): record done/refused cause contact_opted_out, promise untouched, WARN, no send', /* world.contacts[0].sms_opt_out = true before run */);
it('4 a 429 is deferred ONCE: the same payload re-enqueued with deferred: true at the RSW backoff, record done/retryable, the promise refreshed to the run time and emitted; the re-claimed run sends once', async () => {
  wire(); throttle();
  const row = await seedRetried('SMroot1');
  await run(row);
  const [again] = retryEnvelopes(); expect(again!.envelope.payload).toEqual({ providerSid: 'SMroot1', conversationId: row.conversationId, attempt: 1, deferred: true });
  expect(again!.delaySeconds).toBe(Math.round(resolveSendRetryBackoffMs(1) / 1000));
  expect(await world.sendAttemptsRepo.get(ownerOf(row, 1))).toMatchObject({ state: 'done', outcome: 'retryable', cause: '20429' });
  expect(Date.parse(row.retry_due_at!)).toBeGreaterThanOrEqual(Date.now() + resolveSendRetryBackoffMs(1) - 5_000);
  // the deferred run claims from done/retryable and sends (the fake's real send restored)
  world.adapter.sendPreparedMessage = originalSend; await outbound.deliverDelayed(dispatchJob);
  expect(world.sent).toHaveLength(1);
  expect(await world.sendAttemptsRepo.get(ownerOf(row, 1))).toMatchObject({ state: 'done', outcome: 'sent', attemptNo: 2 });
});
it('4-cap a 429 on a deferred payload ends the chain: record done/refused cause deferral_cap, ERROR, no third enqueue, promise untouched; a redelivery of that job is skipped by the gate and never reaches the provider', async () => {
  wire(); throttle(); const calls = providerCalls();
  const row = await seedRetried('SMroot1'); const before = row.retry_due_at!;
  await run(row, 1, { deferred: true });
  expect(await world.sendAttemptsRepo.get(ownerOf(row, 1))).toMatchObject({ state: 'done', outcome: 'refused', cause: 'deferral_cap', attemptNo: 1 });
  expect(retryEnvelopes()).toHaveLength(0); expect(row.retry_due_at).toBe(before); expect(capture.atLevel(50)).toHaveLength(1);
  expect(calls).toHaveBeenCalledTimes(1);
  await run(row, 1, { deferred: true });   // the redelivery
  expect(calls).toHaveBeenCalledTimes(1);   // the provider was NOT called again (world.sent would be 0 either way - the throttle throws before the fake records)
  expect(await world.sendAttemptsRepo.get(ownerOf(row, 1))).toMatchObject({ attemptNo: 1 });
  expect(capture.atLevel(30).filter((l) => l['gate'] === 'skip')).toHaveLength(1);
});
it('4-window a deferral whose run time falls past the window ends the chain done/refused cause retry_window_closed', /* row.provider_ts = now - 14.5 min (inside the window at job time; the 60 s backoff lands past it) */);
it('4-redriven a re-DRIVEN run\'s first 429 still gets its deferral (the re-drive payload carries no deferred)', /* seed the record redriven (claim + handToReconcile + markRedriven, as sendReconcile.test.ts case 15b seeds it); run(row) with throttle -> record done/retryable, one deferred envelope */);
it('4-lost a LOST release after the deferral enqueue (the fence failed: a takeover owns the record) refreshes NOTHING and logs no re-scheduled line; a THROWN release still refreshes the promise (the deferred job is live) and names the strand at ERROR', /* sub-case 1: vi.spyOn(world.sendAttemptsRepo, 'finishAttempt').mockResolvedValueOnce(false); throttle; run -> one deferred envelope (enqueued first), retry_due_at unchanged, no WARN "re-scheduled", one INFO "close lost its fence". Sub-case 2: mockRejectedValueOnce(new Error('release exploded')); run -> one deferred envelope, retry_due_at REFRESHED to the run time, the record still attempting, one ERROR from guardWrite and one ERROR "record release threw", no WARN "re-scheduled" */);
it('4b records are per RETRIED ROW: a manual Retry row that fails 30003 starts a chain whose attempt-1 record keys on the manual row and CLAIMS, although the root\'s chain already ran three attempts (Review Focus 4)', /* three done records on the root (attempts 1-3); a manual row M (retry_of root, no retry_attempt, undelivered 30003, promise live); run(M, 1) -> record for ownerOf(M, 1) done/sent; world.sent 1 */);
it('4c a manual retry supersedes the chain: with a MANUAL child of the retried row already appended the job declines at INFO before claiming - on a first run (no record), on a deferral re-run (done/retryable, nothing written) and on a re-drive (redriven closed refused); the check is ONE listRetryChildrenConsistent call and finds the row among 60 newer unrelated rows; an AUTOMATIC child does not trigger it', async () => {
  wire(); const row = await seedRetried('SMroot1'); const t = Date.now();
  await world.messagesRepo.append({ ...outboundRow('SMmanual', t + 1_000, row.conversationId), retryOf: row.tsMsgId, automated: false });
  for (let i = 0; i < 60; i += 1) await world.messagesRepo.append(outboundRow(`SMnoise${i}`, t + 2_000 + i, row.conversationId));
  const list = vi.spyOn(world.messagesRepo, 'listRetryChildrenConsistent'); const thread = vi.spyOn(world.messagesRepo, 'listByConversationConsistent');
  await run(row); expect(world.sent).toHaveLength(0); expect(await world.sendAttemptsRepo.get(ownerOf(row, 1))).toBeUndefined();
  expect(list).toHaveBeenCalledTimes(1); expect(thread).not.toHaveBeenCalled();
  // done/retryable: nothing written
  ... seed done/retryable; run(row, 1, { deferred: true }); record unchanged ...
  // redriven: closed refused
  ... seed redriven; run(row); record { state: 'done', outcome: 'refused', cause: 'manual_retry_superseded' } ...
  // an automatic child alone does not decline
  ... fresh row2 with an automatic child (retryOf row2, retryAttempt 1); run(row2) sends ...
});
it('4d an existing attempt is resolved BEFORE the window: a stale attempting record (31 s) with the window already closed is taken over into reconcile, not logged window_closed; a deferral re-run whose run time slipped past the window declines retry window closed and sends nothing (RSW #1)', /* sub-case 1: recordJobs(SEND_RECONCILE_JOB) first (the hand-off is IMMEDIATE, as in 6b); seed the stale claim on a row whose provider_ts is 16 min ago; run(row) -> record reconciling, one recorded hand-off, NO 'window_closed' ERROR, providerCalls() 0. Sub-case 2: a done/retryable record; row.provider_ts 16 min ago; run(row, 1, { deferred: true }) -> the 'retry window closed' ERROR, nothing written (record still done/retryable), providerCalls() 0 */);
it('4e a conversation that is missing, a group text, a relay group, or a thread without a participant phone is a WARN decline with no record and no throw - in the decision\'s vocabulary', /* four sub-cases; the WARN carries reason conversation_missing / group_text / not_one_to_one / not_one_to_one */);
it('5 accepted-not-recorded (the append throws): record reconciling WITH the SID, one envelope, one provider call, ERROR sent_unrecorded', /* vi.spyOn(world.messagesRepo, 'append').mockRejectedValueOnce(new Error('append exploded')); record.sid === world.sentDetails[0].sid */);
it('6a the duplicate guard, sequential: the same envelope dispatched twice makes ONE provider call - the second delivery meets the finished record at the gate (skip) (Review Focus 1)', /* the wire-twice recipe from twilioStatusWebhook.test.ts; record done/sent; one INFO with gate 'skip'; providerCalls() 1 */);
it('6b a stale attempting record (31 s) is taken over into reconcile by the redelivered job, with the same recipientKey derived again', /* const recorded = recordJobs(SEND_RECONCILE_JOB); await world.sendAttemptsRepo.claim(ownerOf(row, 1), factsFor(row), iso(Date.now() - 31_000)); run(row) -> record reconciling; reconcileHandOffs(recorded) has ONE payload (check 0 of a 31 s-old attempt is delay 0 - IMMEDIATE, so it lands in `recorded`, never in outbound.delayed) whose owner.recipientKeyHash is 'c-real'; providerCalls() 0; the retried row's retry_due_at refreshed */);
it('6c a lost re-arm sends nothing and writes nothing', /* vi.spyOn(world.sendAttemptsRepo, 'rearm').mockResolvedValueOnce(undefined); run -> world.sent 0; record still attempting (the claim) - and the INFO "taken over before the send" */);
it('6d putJobExecutionMarker is never called by this job', /* spy; run a success and an unknown; not called */);
it('6e the duplicate guard, concurrent (the gate): a FRESH attempting record (5 s old - another delivery is inside its provider call) defers this one - nothing sent, nothing written, INFO "a concurrent delivery owns this attempt" (Review Focus 1)', /* await world.sendAttemptsRepo.claim(ownerOf(row, 1), facts, iso(Date.now() - 5_000)) directly (facts as the job computes them: sender OUR_NUMBER, the body's fingerprint, mediaCount 0); run(row) -> providerCalls() 0; the record unchanged (attemptedAt as seeded, state attempting); one INFO with gate 'defer' */);
it('6f the duplicate guard, concurrent (the claim race): a delivery that read NO record at the gate but loses the claim to a concurrent winner is refused FRESH and sends nothing (Review Focus 1)', /* the same seeded fresh claim, plus vi.spyOn(world.sendAttemptsRepo, 'get').mockResolvedValueOnce(undefined) so the gate reads "absent" - the claim then answers refused with fresh: true; run(row) -> providerCalls() 0; one INFO "claim refused" carrying fresh: true; the seeded record untouched */);
it('7 a successful retry: record done/sent with the SID; the retry row carries retry_of, retry_attempt, retry_window_start (the root\'s send), retry_root, automated false, recipient_contact_id and (share root) broadcast_id; the retried row\'s retry_due_at is NOT written', /* two rows: a plain root and a root with broadcast_id; assert; annotateRetryPromise spy not called */);
it('8 attempt 2: the retried row is the attempt-1 retry row; the record keys on THAT row with attempt 2; retry_root on the new row equals the root; a pre-deploy retried row (retry_of, no retry_root) yields the root through retry_of', /* seed root + r1 (retry_of root, retry_attempt 1, NO retry_root); run(r1, 2) -> record ownerOf(r1, 2) with retryRoot root.tsMsgId; the new row retry_root === root.tsMsgId, retry_window_start === root.provider_ts */);
it('9 reads before the claim: a closed window with no record leaves no record; a conversation read that throws leaves no record and rethrows; a no-origin row fails open with the WARN', /* three sub-cases; the throwing read uses vi.spyOn(world.conversationsRepo, 'getById').mockRejectedValueOnce and dispatches a delayed envelope directly, as twilioStatusWebhook.test.ts:1777 does */);
it('11 (second half) the reconcile\'s never_sent re-drive runs through THIS handler: it claims from redriven (attemptNo 2) and sends once; a re-driven job whose window closed at job time closes its redriven record refused', /* wire(); registerReconcile(); unknownOn(); run(row) (check 0 is +5 s: queued); world.adapter.sendPreparedMessage = originalSend; world.providerMessages stays empty; await runReconcileChain() (checks 0-2 find nothing -> never_sent -> the re-drive is an IMMEDIATE messaging.retrySend enqueue, drained by settle inside runReconcileChain); world.sent 1; record done/sent attemptNo 2 redriveCount 1. Sub-case 2: seed the record redriven directly (claim + handToReconcile + markRedriven) on a row whose provider_ts is 16 min ago; run(row) -> record done/refused cause retry_window_closed, providerCalls() 0 */);
it('R9 every line THE JOB writes names the owner, and no line anywhere carries a phone or a body', /* after the unknown run: every captured line whose msg starts with 'retrySend:' has retryRoot, retriedTsMsgId and attempt (the jobs.ts machinery's own lines - 'job enqueued', 'job succeeded' - carry conversationId from the logger mixin and are NOT held to this); no captured line's JSON contains TENANT_PHONE or the body text */);
```

- [ ] **Step 3: Implement the job** as written above (the marker block `:203-227` and the `getContext` import are deleted; `presignRetryMedia` is the existing media block `:267-301` reading the plan; every log string re-worded in ASCII). `registerHandlers.ts:59` -> `registerRetrySendJobHandler({ sendAttemptsRepo: deps.sendAttemptsRepo });` and the doc comment says four send handlers.

- [ ] **Step 4: Run, typecheck, lint, commit**

Run: `cd app; npx vitest run test/retrySendAttempt.test.ts test/twilioStatusWebhook.test.ts test/retrySendBackoff.test.ts test/sendReconcile.test.ts test/registerHandlers*.test.ts` (find the registration pin with `grep -l registerAllJobHandlers app/test`) -> PASS. `npm run typecheck` -> 0. `npx eslint app/src/jobs/retrySend.ts app/test/retrySendAttempt.test.ts` -> 0 new errors (the orphaned `getContext` import would be lint-red, not typecheck-red: `noUnusedLocals` is off).

```bash
git status
git add app/src/jobs/retrySend.ts app/src/jobs/registerHandlers.ts app/test/twilioStatusWebhook.test.ts app/test/retrySendAttempt.test.ts
git commit -m "feat(jobs): messaging.retrySend claims a send-attempt record instead of the run-once marker - gates on the existing attempt, a manual child and the window before it claims; re-arms before the provider call; refuses, rejects, defers once, or hands an unknown outcome to send.reconcile with the promise refreshed (retry-send-adoption T4)" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---
## Slice D - the route, the projection and the dashboard

### Task 5: The manual Retry route reads the record (R6, R7 route side)

**Files:**
- Modify: `app/src/routes/api.ts` (`ApiRouterDeps` `:282-410` gains `sendAttemptsRepo?: SendAttemptsRepo`; the default-construction block `:562-640` gains `const sendAttempts = deps.sendAttemptsRepo ?? createSendAttemptsRepo({ logger: deps.logger });`; the Retry handler `:1567-1697`: the new guards between `:1611` and `:1612`, the append gains `retryRoot` and `broadcastId` at `:1685`)
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (`makeWebhookHarness`'s api block `:4923-5018` gains `sendAttemptsRepo: world.sendAttemptsRepo`)
- Test: `app/test/apiRoutes.test.ts` (`makeRetryApp` `:442-473` grows; the Retry describe `:428-758`)

**Interfaces:**
- Consumes: T1's `listRetryChildrenConsistent`, `resolveRetryRoot`, `retryRecipientKey`, `NewMessage.retryRoot` (through `SendMessageInput.retryRoot`); T2's owner; `RETRY_SEND_WINDOW_MS`, `MAX_SEND_RETRY_ATTEMPTS`, `RETRY_OUTCOME_UNCONFIRMED` (`lib/retrySendWindow.ts`); `SendAttemptsRepo.get` (a consistent Get, `sendAttemptsRepo.ts:323-326`).
- Produces: 409 `{ error: 'superseded' }`, 409 `{ error: 'retry_unresolved' }`, the record-based 409 `retry_pending`; the route's append carries `retryRoot` and `broadcastId`.

Guard order after RSW's `retry_pending` (the existing 404 / 400 / 409 answers stay first - `rateLimit.test.ts:327-385` drives the route with no original):

```ts
    // retry-send-adoption R6: ANY child supersedes the press - a stale tab or a direct call on a row the collapse no longer offers.
    const children = await messages.listRetryChildrenConsistent(conversationId, original.tsMsgId);
    if (children.length > 0) { res.status(409).json({ error: 'superseded' }); return; }
    // R6: the attempt RECORD, read by key (the ONE attempt number the webhook can have scheduled against this row - deviation 1) with the R1 key from the same immutable data; the row's own retry_outcome is a belt.
    const conversation = await conversations.getById(conversationId);
    const recipientKey = retryRecipientKey(original, conversation);
    const retryRoot = await resolveRetryRoot(messages, original);
    const attempt = (original.retry_attempt ?? 0) + 1;
    const record = recipientKey !== undefined && attempt <= MAX_SEND_RETRY_ATTEMPTS
      ? await sendAttempts.get({ kind: 'retry_send', conversationId, retriedTsMsgId: original.tsMsgId, attempt, recipientKey, retryRoot })
      : undefined;
    if (original.retry_outcome === RETRY_OUTCOME_UNCONFIRMED || (record?.state === 'done' && record.outcome === 'unresolved')) {
      res.status(409).json({ error: 'retry_unresolved' }); return;
    }
    if (record !== undefined && record.state !== 'done' && Date.now() - Date.parse(record.attemptedAt) <= RETRY_SEND_WINDOW_MS) {
      res.status(409).json({ error: 'retry_pending' }); return;
    }
```
and in the `sendMessage` call: `retryRoot,` and `...(original.broadcast_id !== undefined && { broadcastId: original.broadcast_id }),`. (`conversations` is the router's existing conversations repo - verify its local name at `:565`.)

- [ ] **Step 1: The factory.** `makeRetryApp(original, opts: { mediaStore?; contactsRepo?; children?: RetryChildPointer[]; parent?: MessageItem; conversation?: Partial<ConversationItem>; world?: FakeWorld } = {})`: the messagesRepo stub gains `listRetryChildrenConsistent: async () => opts.children ?? []` and `getByTsMsgIdConsistent: async (_c, id) => (opts.parent?.tsMsgId === id ? opts.parent : undefined)`; api deps gain `conversationsRepo: { getById: async () => ({ conversationId: 'conv-1', type: 'tenant_1to1', participant_phone: '+15550100001', ...opts.conversation }) } as unknown as ConversationsRepo` and `sendAttemptsRepo: (opts.world ?? createFakeWorld()).sendAttemptsRepo`. Keep the two existing optional positional args working by converting the 13 existing call sites to the options object (a mechanical sweep). Records are seeded on the world's fake before the request: `const world = createFakeWorld(); await world.sendAttemptsRepo.claim(owner, facts, at); ...` with `const owner = { kind: 'retry_send', conversationId: 'conv-1', retriedTsMsgId: FAILED_ORIGINAL.tsMsgId, attempt: 1, recipientKey: 'phone#+15550100001', retryRoot: FAILED_ORIGINAL.tsMsgId }` (no `recipient_contact_id` on the fixture, so the key is the phone key).

- [ ] **Step 2: Failing route tests (spec 15)** - one `it` each, all with the `.set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE)` idiom:

```ts
it('R6: 409 superseded when the pressed row has ANY child - an automatic retry row, or a manual one', /* children: [{ tsMsgId: 'x', providerSid: 'SMx', retryAttempt: 1 }] -> 409 { error: 'superseded' }, calls 0; children: [{ tsMsgId: 'y', providerSid: 'SMy' }] -> the same */);
it('R6: the superseded check is ONE consistent Query on the pointer family, never a thread scan', /* spy the stub\'s listRetryChildrenConsistent (called once) and assert the stub has no listByConversation at all (it would throw a TypeError) */);
it('R6: 409 retry_unresolved on a done/unresolved record read by KEY - with or without retry_outcome on the row - and the route\'s read has no time bound of its own (a 45-day-old record still refuses here; in production the record\'s 30-day expires_at reaps it and the row\'s retry_outcome belt is the only guard after that - Task 9 records the residue)', /* seed claim + handToReconcile + closeFromReconcile(unresolved) with at = 45 days ago; two originals: FAILED_ORIGINAL and { ...FAILED_ORIGINAL, retry_outcome: 'unconfirmed' } */);
it('R6: 409 retry_unresolved on the row belt alone (retry_outcome: unconfirmed, no record)', /* no records; original with retry_outcome */);
it('R6: 409 retry_pending on a fresh attempting record, a pending reconciling record and an in-window redriven record', /* three worlds; attemptedAt = now - 30 s */);
it('R6: 200/201 on a stale attempting record (RETRY_SEND_WINDOW_MS + 1 s old), a done/sent, a done/retryable, a done/refused and a done/enqueue_failed', /* five worlds; expect 201 and calls.length 1 */);
it('R6: the record is read at attempt (retry_attempt ?? 0) + 1 - a pressed attempt-1 retry row reads attempt 2 (deviation 1)', /* original { ...FAILED_ORIGINAL, retry_of: 'T#SMroot', retry_attempt: 1, retry_root: 'T#SMroot' }; seed done/unresolved at attempt 2 -> 409 retry_unresolved; seeded at attempt 1 instead -> 201 */);
it('R7: the route\'s append carries retryRoot and broadcastId', /* original with broadcast_id 'b-1' and retry_root 'T#SMroot' -> calls[0] toMatchObject({ retryOf: original.tsMsgId, retryRoot: 'T#SMroot', broadcastId: 'b-1' }); a plain original -> retryRoot = its own tsMsgId, no broadcastId */);
it('R7: a pre-deploy pressed row (retry_of, no retry_root) walks retry_of for the root', /* parent = a root row; original { ...FAILED_ORIGINAL, retry_of: parent.tsMsgId } -> calls[0].retryRoot === parent.tsMsgId */);
it('RSW\'s cases are unchanged: the time guard still answers before the record; an expired or withdrawn promise with no record passes', /* the existing D10 cases stay green through the grown factory - no new assertions */);
```
TWO existing exact `toEqual` pins on `calls` gain `retryRoot: '2026-06-12T09:00:00.000Z#SMorig'`: the `re-sends the original body + carries retry_of` case (`:475-494`) and the D14 recorded-recipient case (`:614-623`, the one with `recipient: real`). Grep `expect(calls).toEqual` in the file for any third.

- [ ] **Step 3: Implement** (the guards, the deps, the harness api block).

- [ ] **Step 4: Run, typecheck, commit**

Run: `cd app; npx vitest run test/apiRoutes.test.ts test/rateLimit.test.ts test/contactTimeline.test.ts` -> PASS. `npm run typecheck` -> 0.

```bash
git status
git add app/src/routes/api.ts app/test/helpers/twilioWebhookHarness.ts app/test/apiRoutes.test.ts
git commit -m "feat(api): the manual Retry route refuses a superseded press (any child), an unresolved retry (the record by key, the row as a belt) and a pending attempt inside the window; its append carries retry_root and broadcast_id (retry-send-adoption T5)" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 6: "Retry not confirmed" on the projection and the dashboard (R5, R6 copy, R10)

**Files:**
- Modify: `app/src/routes/contactTimeline.ts` (`TimelineMessage` `:157-214` gains `retry_outcome?: 'unconfirmed'` after `:180`; `toTimelineMessage` `:413-474` gains `...(m.retry_outcome === RETRY_OUTCOME_UNCONFIRMED && { retry_outcome: RETRY_OUTCOME_UNCONFIRMED })` after the `retry_due_at` line `:452`)
- Modify: `dashboard/src/api/types.ts` (`TimelineMessage` `:2520-2547`: `retry_outcome?: RetryOutcome;` with `export type RetryOutcome = typeof RETRY_OUTCOME_UNCONFIRMED` imported from `routes/contact/retryPromise.ts` - or declare `'unconfirmed'` inline and pin it in the mirror; choose the import so there is ONE dashboard literal)
- Modify: `dashboard/src/routes/contact/retryPromise.ts` (add `export const RETRY_OUTCOME_UNCONFIRMED = 'unconfirmed' as const;` with the MIRROR doc comment)
- Modify: `dashboard/src/routes/contact/retryPromiseMirror.test.ts` (a case: the dashboard constant equals the app's `RETRY_OUTCOME_UNCONFIRMED` from `app/src/lib/retrySendWindow.ts`)
- Modify: `dashboard/src/routes/contact/deliveryStatus.ts` (`DeliveryReasonOptions` `:984-1001` gains `retryUnconfirmed?: boolean`; a new map `RETRY_UNCONFIRMED_REASONS = { '30003': 'Phone unreachable - retry not confirmed' }` beside `RETRY_SCHEDULED_REASONS` `:947-949`; `deliveryReason` `:1133-1175` consults it FIRST, skipped when `relay`)
- Modify: `dashboard/src/routes/contact/Timeline.tsx` (the one-to-one chip call `:1059` gains `retryUnconfirmed: msg.retry_outcome === RETRY_OUTCOME_UNCONFIRMED`; the Retry button condition `:1426` gains `&& msg.retry_outcome !== RETRY_OUTCOME_UNCONFIRMED`; `sendFailureMessage` `:88-139` gains two cases)
- Test: `app/test/contactTimeline.test.ts` (beside `:367-403`), `dashboard/src/routes/contact/deliveryStatus.test.ts` (beside `:777-845`), `dashboard/src/routes/contact/Timeline.delivery.test.tsx` (beside `:609-672`), `dashboard/src/routes/contact/Timeline.test.tsx` (beside `:931-948`)

**Interfaces:**
- Consumes: T1's `RETRY_OUTCOME_UNCONFIRMED`; T5's two 409 codes.
- Produces: the projection field; the copy; the hidden Retry; the two sentences.

- [ ] **Step 1: Failing tests.**

`contactTimeline.test.ts`: `'retry-send-adoption R5: projects retry_outcome on a retried row the reconcile ruled unresolved, and nothing on one without'` - stamp `world.messages[...].retry_due_at = RETRY_PROMISE_WITHDRAWN_AT; ...retry_outcome = 'unconfirmed'`; the response item (typed as `DashboardTimelineMessage`) has `retry_outcome: 'unconfirmed'`; a plain row has no such property.

`deliveryStatus.test.ts`:
```ts
  it('retry-send-adoption R5: retryUnconfirmed reads "retry not confirmed" and outranks retryScheduled; relay outranks both; no other code moves', () => {
    expect(deliveryReason('30003', { retryUnconfirmed: true })).toBe('Phone unreachable - retry not confirmed (error 30003)');
    expect(deliveryReason('30003', { retryUnconfirmed: true, retryScheduled: true })).toBe('Phone unreachable - retry not confirmed (error 30003)');
    expect(deliveryReason('30003', { retryUnconfirmed: true, media: true })).toBe('Phone unreachable - retry not confirmed (error 30003)');
    expect(deliveryReason('30003', { retryUnconfirmed: true, relay: true })).toBe('Phone unreachable (error 30003)');
    expect(deliveryReason('30007', { retryUnconfirmed: true })).toBe('Carrier filtered the message (error 30007)');
    expect(deliveryReason('30003', { retryUnconfirmed: false })).toBe('Phone unreachable (error 30003)');
  });
```
and the ASCII case (`:840-845`) gains `deliveryReason('30003', { retryUnconfirmed: true })`.

`Timeline.delivery.test.tsx` (beside the `ONE_TO_ONE_30003` fixture):
```ts
  const UNCONFIRMED_TEXT = 'Undelivered - Phone unreachable - retry not confirmed (error 30003)';
  it('retry-send-adoption R5: an unresolved retry reads "retry not confirmed" and hides Retry - the sentinel stamp included', () => {
    renderTimeline({ items: [{ ...ONE_TO_ONE_30003, retry_due_at: '1970-01-01T00:00:00.000Z', retry_outcome: 'unconfirmed' }], onRetry: vi.fn() });
    expect(screen.getByText(UNCONFIRMED_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(/will retry/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', RETRY_BUTTON)).not.toBeInTheDocument();
  });
  it('retry-send-adoption R5: the sentinel WITHOUT retry_outcome (RSW\'s enqueue-failure withdrawal) still reads the plain failure and offers Retry (Review Focus 3)', () => {
    renderTimeline({ items: [{ ...ONE_TO_ONE_30003, retry_due_at: '1970-01-01T00:00:00.000Z' }], onRetry: vi.fn() });
    expect(screen.getByText(PLAIN_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', RETRY_BUTTON)).toBeInTheDocument();
  });
```
`Timeline.test.tsx` (beside `:931-948`): two cases with `new ApiError(409, 'superseded', 'superseded')` -> the alert reads `A newer attempt already exists for this message.`; `new ApiError(409, 'retry_unresolved', 'retry_unresolved')` -> `This retry couldn't be confirmed - send a new message instead.`; neither contains `Couldn't send`.

`retryPromiseMirror.test.ts`: `expect(RETRY_OUTCOME_UNCONFIRMED).toBe(APP_RETRY_OUTCOME_UNCONFIRMED)` (both imports named as the file's pattern).

- [ ] **Step 2: Implement.** In `deliveryReason` the chain becomes:
```ts
  const mapped =
    (opts.retryUnconfirmed === true && opts.relay !== true ? ownReason(RETRY_UNCONFIRMED_REASONS, errorCode) : undefined) ??
    (opts.retryScheduled === true && opts.relay !== true ? ownReason(RETRY_SCHEDULED_REASONS, errorCode) : undefined) ??
    ... unchanged ...
```
with a doc line: "retry-send-adoption R5: the unconfirmed retry outranks the promise (an unresolved retry has no promise left), and relay outranks both." `sendFailureMessage` gains, beside `retry_pending`:
```ts
      // retry-send-adoption R6: a press on a row the collapse no longer offers (a stale tab), and a retry the platform could not confirm.
      case 'superseded':
        return 'A newer attempt already exists for this message.';
      case 'retry_unresolved':
        return "This retry couldn't be confirmed - send a new message instead.";
```
The Retry button: `{delivery?.isFailure && onRetry && !retryPromiseLive && msg.retry_outcome !== RETRY_OUTCOME_UNCONFIRMED ? (`. The chip call passes `retryUnconfirmed` ONLY at `:1059` (the leg/row call sites `:622`, `:1368` and `deliveryStatus.ts:541, :843, :873` do not).

- [ ] **Step 3: Run, typecheck, commit**

Run: `cd app; npx vitest run test/contactTimeline.test.ts` and `cd dashboard; npx vitest run src/routes/contact/deliveryStatus.test.ts src/routes/contact/Timeline.delivery.test.tsx src/routes/contact/Timeline.test.tsx src/routes/contact/retryPromiseMirror.test.ts src/routes/contact/retryPromise.test.ts` -> PASS. `npm run typecheck` -> 0 (the app test imports the dashboard type).

```bash
git status
git add app/src/routes/contactTimeline.ts app/test/contactTimeline.test.ts dashboard/src/api/types.ts dashboard/src/routes/contact/retryPromise.ts dashboard/src/routes/contact/retryPromiseMirror.test.ts dashboard/src/routes/contact/deliveryStatus.ts dashboard/src/routes/contact/deliveryStatus.test.ts dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/Timeline.delivery.test.tsx dashboard/src/routes/contact/Timeline.test.tsx
git commit -m "feat(dashboard): a retried row the reconcile ruled unresolved reads 'retry not confirmed' with no Retry; the two 409 sentences; retry_outcome projected and mirrored (retry-send-adoption T6)" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 7: The one fenced line (R7)

**Files:**
- Modify: `app/src/routes/webhooks/twilio.ts` - EXACTLY the line at `:3904` (inside `rollIntoBroadcast`, the give-up after the re-read); nothing else in the file.
- Test: the rollup's existing miss case - find it with `grep -rn "no matching recipient slot" app/test` (if none exists, add ONE case to `app/test/twilioStatusWebhook.test.ts`'s broadcast rollup describe: a delivered receipt for a row stamped `broadcast_id` whose broadcast has no slot for its tsMsgId, with `statusUnknownSidRetryDelayMs: 0` passed to `makeWebhookHarness` so the 2.5 s wait is skipped).

- [ ] **Step 1: Failing test.** The give-up line is captured at level 30 (INFO), never 40, with `broadcastId` and `conversationId` on it and the ASCII message `broadcast delivery rollup: no matching recipient slot - ignored`.
- [ ] **Step 2: The edit.** `log.warn({ broadcastId, conversationId }, 'broadcast delivery rollup: no matching recipient slot <U+2014> ignored')` -> `log.info({ broadcastId, conversationId }, 'broadcast delivery rollup: no matching recipient slot - ignored')`. `git diff --stat` shows ONE line changed in `twilio.ts`; the added line is ASCII.
- [ ] **Step 3: Run, commit**

Run: `cd app; npx vitest run test/twilioStatusWebhook.test.ts` -> PASS.

```bash
git status
git add app/src/routes/webhooks/twilio.ts app/test/twilioStatusWebhook.test.ts
git commit -m "fix(webhooks): the broadcast rollup's no-slot give-up logs at INFO (a retried share text is not a prod warning until Branch B teaches the rollup) - the one fenced-file line (retry-send-adoption T7)" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

---
## Slice E - end to end, records, gates

### Task 8: The e2e spec (section 4, items 17-19; R11)

**Files:**
- Create: `e2e/tests/dashboard-next/retry-send-adoption.spec.ts`
- Modify: `e2e/support/selectors.md` (`:50`: the one-to-one chip's third reading `retry not confirmed`, and the two 409 sentences in the composer's `role="alert"` slot)
- No lane change: `E2E_SEND_RETRY_BACKOFF_MS` (`10000`) and `E2E_SEND_RECONCILE_DELAYS_MS` (`2000,4000,8000`) already sit in `scripts/e2e-session.mjs:283, :296`. A running lane must be booted FRESH (`e2e:restart` keeps the launcher's old env) - the seams only reach a fresh boot.

**Before writing a line, READ and reuse:** `e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts` (`uniquePhone`/`reseedLean` `:90-100`, `createConsentedTenant` `:157-180`, `reconcileLines`/`siteLines` `:216-263`, the `beforeEach`/`afterAll` reseed hooks) - copy the helpers file-locally with `uid` starting at **90** (SOR's start at 70, the relay specs at 0 and 40: a shared uid range would let a same-second run mint another file's number); `e2e/tests/dashboard-next/one-to-one-30003-retry.spec.ts` (`devLogin`, `storedRows`, `bubblesWithBody`, the 30003 profile arming `:159-162`, the `StoredMessage` shape `:42-56` - add `retry_root`, `retry_outcome`, `broadcast_id`); `e2e/fixtures/fakeTwilio.ts` (`setDeliveryOutcome`, `failNextSend`, `failList`, `getOutboundTo`); `e2e/fixtures/groupText.ts` (`readLogTail`). The conversation for a fresh tenant: `POST /api/contacts/:id/conversation` -> `{ conversation: { conversationId } }` (`routes/contacts.ts:1926-1961`). The staff text goes through the API send route (`POST /api/conversations/:conversationId/messages` with `{ body }` - read `app/src/routes/api.ts`'s send route for the exact body shape), not the composer, so the arming window is deterministic.

**Arming order (the trap):** arm the 30003 profile BEFORE the staff send (it is consumed by that create); arm `failNextSend` (and `failList`) AFTER the original's create landed (poll `getOutboundTo` for the body) and BEFORE the retry fires (10 s): armed earlier, the ORIGINAL consumes it. Under `accept_then_drop` the fake's callbacks reach the app before the adoption and the webhook may log one unknown-SID ERROR: scope every log assertion to `event: 'send_reconcile'` and `owner.kind === 'retry_send' && owner.conversationId === conversationId`; never assert "no ERROR" globally. The unknown hand-off is INFO (R9), which the logtail (WARN+) cannot see: item 17's proof that the seam fired is the retried row's REFRESHED `retry_due_at` (about `attemptedAt + 8 s + 120 s`, versus the failure's `+10 s`).

**The three tests (`test.slow()` each; one fresh consented tenant each; `reseedLean` before each and after all):**

```ts
const BODY_17 = 'Adoption check - please confirm your tour';
test('17 a 30003 one-to-one retry armed accept_then_drop is adopted: the retry bubble reads Delivered, the tenant received exactly ONE retry text, the retry row carries its lineage and root, the promise was refreshed', async ({ page, request }) => {
  test.slow();
  await devLogin(page);
  const tenant = await createConsentedTenant(page.request, `Adopt${stamp}`);
  const conversationId = await conversationFor(page.request, tenant.contactId);
  await setDeliveryOutcome(request, { partyNumber: tenant.phone, profile: { kind: 'fail', failState: 'undelivered', errorCode: '30003' } });
  const since = new Date().toISOString();
  await sendStaffText(page.request, conversationId, BODY_17);
  const original = await pollRow(request, conversationId, (m) => m.body === BODY_17 && m.error_code === '30003' && typeof m.retry_due_at === 'string');
  await failNextSend(request, { partyNumber: tenant.phone, mode: 'accept_then_drop' });
  const retry = await pollRow(request, conversationId, (m) => m.retry_of === original.tsMsgId && m.delivery_status === 'delivered', 40_000);
  expect(retry).toMatchObject({ retry_attempt: 1, retry_root: original.tsMsgId, retry_window_start: original.provider_ts, automated: false });
  const texts = (await getOutboundTo(request, { to: tenant.phone, since })).filter((m) => m.body === BODY_17);
  expect(texts).toHaveLength(2); // the original (undelivered) and ONE retry
  const refreshed = await pollRow(request, conversationId, (m) => m.tsMsgId === original.tsMsgId);
  expect(Date.parse(refreshed.retry_due_at!)).toBeGreaterThan(Date.parse(original.retry_due_at!) + 60_000);
  await page.goto(`${NEXT}/contacts/${tenant.contactId}`);
  await expect(bubblesWithBody(page, BODY_17).filter({ hasText: 'Delivered' })).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByText(/will retry/)).toHaveCount(0);
});
test('18 armed drop_before_create: never_sent at the third check, ONE re-drive, the retry bubble Delivered, one retry text', /* the same setup with mode 'drop_before_create'; the retry row appears within 10 s backoff + 8 s check 2 + re-drive (poll 45 s); reconcileLines(request, since, ownerMatches) toEqual([{ level: 40, checkNo: 2, verdict: 'never_sent', cause: null }]); outbound texts with the body: 2 */);
test('19 drop_before_create plus fail-list x3: the retried row reads "retry not confirmed" with no Retry, the API answers 409 retry_unresolved, exactly one send_reconcile ERROR for that owner, no retry text', async ({ page, request }) => {
  ... setup; after the original: failNextSend drop_before_create; failList({ partyNumber: tenant.phone, count: 3 }) ...
  const closed = await pollRow(request, conversationId, (m) => m.tsMsgId === original.tsMsgId && m.retry_outcome === 'unconfirmed', 45_000);
  expect(closed.retry_due_at).toBe('1970-01-01T00:00:00.000Z');
  await expect.poll(() => reconcileLines(request, since, (o) => o['kind'] === 'retry_send' && o['conversationId'] === conversationId), { timeout: 10_000 }).toEqual([
    { level: 40, checkNo: 0, verdict: null, cause: null },
    { level: 40, checkNo: 1, verdict: null, cause: null },
    { level: 50, checkNo: 2, verdict: 'unresolved', cause: 'provider_unreachable' },
  ]);
  const press = await page.request.post(`${NEXT}/api/conversations/${conversationId}/messages/${original.provider_sid}/retry`);
  expect(press.status()).toBe(409); expect(await press.json()).toEqual({ error: 'retry_unresolved' });
  await page.goto(`${NEXT}/contacts/${tenant.contactId}`);
  const bubble = bubblesWithBody(page, BODY_19).filter({ hasText: 'Phone unreachable - retry not confirmed (error 30003)' });
  await expect(bubble).toHaveCount(1, { timeout: 15_000 });
  await expect(bubble.getByRole('button', { name: 'Retry sending this message' })).toHaveCount(0);
  expect((await getOutboundTo(request, { to: tenant.phone, since })).filter((m) => m.body === BODY_19)).toHaveLength(1);
});
```
`pollRow(api, conversationId, pick, timeout = 30_000)` polls `GET /api/conversations/:id/messages?limit=100` (raw rows, newest first) every 500 ms with `expect.poll`. `conversationFor` POSTs `/api/contacts/:id/conversation`. `sendStaffText` POSTs the send route (`POST /api/conversations/:conversationId/messages` with `{ body }`). EVERY app API call (`pollRow`, `conversationFor`, `sendStaffText`, `createConsentedTenant`, the Retry press) goes through `page.request` (the session `devLogin` established - the bare `request` fixture carries no cookie, and the routes are authed); the bare `request` fixture is for the FAKE (`setDeliveryOutcome`, `failNextSend`, `failList`, `getOutboundTo`) and the logtail only. In the sketches above read `pollRow(request, ...)` as `pollRow(page.request, ...)`.

- [ ] **Step 1: Write the spec and the `selectors.md` note.**
- [ ] **Step 2: Boot a FRESH lane and run the spec alone, then the full suite.** Stop any running lane (`npm run e2e:stop`; prove the lane's ports are free), then run the new spec alone through the e2e workspace: `npm run e2e -- tests/dashboard-next/retry-send-adoption.spec.ts` -> 3 passed; then `timeout 1800 npm run e2e` in bash -> 292 passed (289 + 3), no other spec regresses. If `timeout` fires: `npm run e2e:stop`, prove the ports free, and re-run - never let the next run adopt an orphaned stack. If a test is timing-flaky at the lane's 10 s / 2-4-8 s, raise the poll budget, never weaken an assertion.
- [ ] **Step 3: Commit**

```bash
git status
git add e2e/tests/dashboard-next/retry-send-adoption.spec.ts e2e/support/selectors.md
git commit -m "test(e2e): a 30003 retry adopted, re-driven once, and closed unresolved with 'retry not confirmed' - end to end through the fake's seams (retry-send-adoption T8)" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

### Task 9: Issue notes, live self-QA, drift, gates, handback (spec sections 5-6)

**Files (dated sections, ASCII, code cited by file:line at HEAD, never pasted):**
- `docs/issues/retry-send-lost-under-job-marker.md` - built on this branch (the marker out, the claim in, the reconcile's fourth owner); `status` stays `open` - the human sets it resolved at merge.
- `docs/issues/accepted-send-lost-when-append-fails.md` - piece 2 built: the retry job hands `SendAcceptedNotRecordedError` to reconcile with its SID, which adopts it as a repair.
- `docs/issues/manual-retry-double-send-residual-windows.md` - a dated section mapping its numbered gaps (1-5) to R6 by the spec's own reading (R6, "The two halves together"): the late job (gap 1), the pending outcome (gap 3) and the enqueue-after-SQS-accepted job (gap 5) are closed by the job's step 4a (the late job declines when a manual row exists) and the record guard; the unresolved retry (gap 4) is closed by `retry_unresolved`; the stale render (gap 2) is closed by `superseded` for a row with a child and otherwise stays; the two residuals the spec names stay open: a manual send IN FLIGHT while the job passes 4a and claims (a two-child fork whose chains then run independently), and manual-vs-manual.
- `docs/issues/broadcast-30003-retry-never-updates-slot.md` - attribution and the root pointer landed (every retry row carries `broadcast_id` and `retry_root`; the `retrychild#` family); matching is Branch B's; the interim rollup cost: a transitioned receipt for a share-retry row misses the slot, waits 2.5 s, misses again and logs INFO - TWICE for a delivered text (the rollup runs on `sent` and `delivered`); `isBroadcastRowFor` now ignores retry rows (deviation 7 - a code change, stated).
- `docs/issues/send-attempt-sweeper.md` - the `retry_send` owner's key shape and its strand cases: a fence write that throws leaves `attempting` with the promise refreshed until it expires; a lost `handToReconcile`; a RE-DRIVEN job that declines at step 1 or 3 (retried row missing or not outbound; conversation missing, group or phone-less - practically unreachable, the reconcile just read both) leaves its record `redriven`, which the route reads as `retry_pending` for 15 minutes; the `retrychild#` family beside the others (no `expires_at` - message rows have none). Also the TTL residue: the record's `expires_at` is set only at claim and re-arm (+30 days, `SEND_ATTEMPT_CLEANUP_MS`), so after 30 days the route's `retry_unresolved` refusal rests on the row's `retry_outcome` belt alone; a lost WITHDRAW then leaves an unresolved row manually retryable.
- `docs/issues/send-reconcile-job-residues.md` - the fourth owner inherits every listed residue; the lineage walk adds up to three consistent reads per check beside the unbounded sibling read (item 17); pre-deploy children have no pointer: step 4a misses them for the 15 minutes a chain can straddle the deploy, and the ROUTE's `superseded` check misses a pre-deploy child for good (a stale tab on a pre-deploy superseded row behaves as it did before this branch - not a regression).
- `docs/issues/one-to-one-retry-promise-outlives-job-decline.md` - UNTOUCHED (wontfix respected).

- [ ] **Step 1: Write the sections; `npm run issues` -> exit 0. Commit.**

```bash
git status
git add docs/issues/retry-send-lost-under-job-marker.md docs/issues/accepted-send-lost-when-append-fails.md docs/issues/manual-retry-double-send-residual-windows.md docs/issues/broadcast-30003-retry-never-updates-slot.md docs/issues/send-attempt-sweeper.md docs/issues/send-reconcile-job-residues.md
git commit -m "docs(issues): what retry-send-adoption closes and leaves - the anchor built, the residual windows mapped, the attribution half landed, the sweeper's fourth owner" -m "Co-Authored-By: <model> <noreply@anthropic.com>"
```

- [ ] **Step 2: Live self-QA on a hermetic lane** (`npm run e2e:session` FRESH; dev-login; reseed `lean`; the Playwright MCP): drive item 19 by hand and record it in `docs/superpowers/reviews/2026-09-27-retry-send-adoption/self-qa.md` (screenshots under `.playwright-mcp/`): the chip reads `Undelivered - Phone unreachable - retry not confirmed (error 30003)`, no Retry, the composer's alert on an API press reads the `retry_unresolved` sentence (drive it from the page's own fetch or note the 409 body), the app log's ONE `send_reconcile` ERROR for the owner, the fake's thread holds ONE text. Then item 17 for the seam proof (the refreshed `retry_due_at`). `npm run e2e:stop`. Commit the record.

- [ ] **Step 3: Drift, not a re-merge.** `git rev-list --count HEAD..main` and `git log --oneline HEAD..main`; list the drift in the handback. Re-merge ONLY if the planner says so.

- [ ] **Step 4: The five gates, BARE, from the worktree, in a BASH shell, each its own command, on a QUIET tree** (restart DynamoDB Local first: `npm run db:stop; npm run db:start`):

```bash
npm run typecheck
npm test
npm run smoke
timeout 1800 npm run e2e
npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')
```
Report every real exit code and count. If `timeout` fires on the e2e: `npm run e2e:stop`, prove the lane's ports are free, and re-run once on a quiet tree before calling it red. If `npm test` is red on DynamoDB Local suites: re-run the failing FILE alone more than once, run the full suite at the merge base, compare failing FILES, report both. Any `[dynamoAdmin]` line is a real container fault - capture `err.$metadata.httpStatusCode` and `attempts` first. Attribute lint errors by BASELINE COMPARISON on the same paths at the merge base; only new ones block.

- [ ] **Step 5: Handback** at `.superpowers/sdd/handback.md` AND committed as `docs/superpowers/reviews/2026-09-27-retry-send-adoption/handback.md`: the work map with commits; a per-decision conformance table (R1-R12 and section 0, plus SOR D8/D8a/D13/D15/D16 as inherited); the NINE declared deviations; the quoted gate exit codes and counts; the self-QA pointer; the orchestrator's own review findings and adjudications; the drift list; the residues with their issue links; what `isBroadcastRowFor` does with a retry row (deviation 7); post-merge: NONE infra; the human sets `retry-send-lost-under-job-marker` resolved at merge; share-skip Branch B starts after this merges and reads R10. State explicitly: UNMERGED (human gate).

---

## Self-review (planner, against spec revision 5) - coverage by NAMED test

| spec | task(s) | proof |
|---|---|---|
| Sec 0 (two names; the root rule) | T1 `resolveRetryRoot` cases; T4 test 8; T5 "pre-deploy pressed row" | |
| Q1 ruling (unresolved -> not confirmed, withdrawn, no Retry) | T2 test 12; T5 `retry_unresolved` cases; T6 unconfirmed cases; T8 test 19 | |
| Q2 ruling (twilio.ts fenced but one line) | T7; Global Constraints fence | |
| Branch B's requirement (broadcast_id + retry_root on every retry row) | T4 test 7 (automatic); T2 tests 10/10a (adopted); T5 R7 cases (manual) | |
| Wontfix respected (no early withdrawal) | T4 tests 2, 3, 4-cap, 7 (promise untouched / annotate spy 0); T2 tests 11a, 11c | |
| R1 owner kind, keys, facts, ref, `deferred` | T2 Step 1 key/parser cases; T4 tests 1, 1b, 4; T1 Step 7 parser cases | |
| R2 order, gates, claim, marker removal | T4 tests 4b, 4c, 4d, 4e, 6a-6f, 9; the rewritten marker cases | |
| R3 arms | T4 tests 1, 2, 2a, 3, 4, 4-cap, 4-window, 4-redriven, 4-lost, 5, 6c; T1 `retryPromiseWrites` cases | |
| R4 resolve / digest / heldBy / adopt / never_sent / unresolved / re-apply / afterClose | T2 tests 10-10e, 11-11c, 12-12c | |
| R4 lineage exclusion | T3 tests 13-13c | |
| R5 row field, projection, copy, hidden Retry | T6 (four files); T1 Step 3 (`annotateRetryPromise` withdraw) | |
| R6 superseded / retry_unresolved / retry_pending by record | T5 Step 2 cases; T6 the two sentences; T8 test 19's 409 | |
| R7 pointer family, retry_root, broadcast_id, the one line, `isBroadcastRowFor` | T1 Steps 2-4; T2 `isBroadcastRowFor` case; T4 test 7; T5 R7 cases; T7 | |
| R8 (decision unchanged) | no edit to `oneToOneRetryDecision.ts` (fence); T4 test 8 proves the adopted/sent row's `retry_attempt` + `retry_window_start` | |
| R9 logging | T4 test "R9"; T2 test 12 (ONE ERROR); T3/T2 levels | |
| R10 contract | T4 test 7 + T2 test 10 field sets; T2 test 12 the withdrawal shape; `listByRecipient` in T2's integration case | |
| R11 seams | T8 (existing lane values); T4 test 4's delay pin through `resolveSendRetryBackoffMs` | |
| R12 deviations from SOR | T4 test 6b (takeover by the own redelivery); T2 tests 12 (record first), 11 (afterClose = the retried row's emit) | |
| Sec 4 repo cases | T1 Step 2 (DynamoDB Local), Step 4 (fakes + parity); T2 Step 3 (attempts integration + parity) | |
| Sec 4 e2e 17-19 | T8 | |
| Sec 5 issues | T9 Step 1 (six files) | |

Placeholder scan: every test sketch names its expectation and its seam; none says "add tests", "similar to" or "as in Task N" without the code beside it; every file-local helper a sketch uses (`appendOutbound`, `seedOneToOne`, `seedRow`, `iso`, `retryDeps`, `wire`, `seedRetried`, `outboundRow`, `originalSend`, `providerCalls`, `pollRow`, `conversationFor`, `sendStaffText`) is defined in the task that uses it. Type consistency: `RetrySendOwner`, `RetryChildPointer`, `RetryMediaPlan`, `RetryPromiseDeps`, `LineageReader`, `ConversationRetryDecline`, the two 409 codes and the copy strings are defined once (the shared block, T1, T2) and used by name in T2-T8. Review Focus: RF1 T4 6a/6e/6f/9; RF2 T2 10c; RF3 T6 the sentinel-without-outcome case; RF4 T4 4b; RF5 T4 4c/4d and T2 11.
