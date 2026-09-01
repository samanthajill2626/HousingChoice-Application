# Message transport fidelity implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or `superpowers:executing-plans` to
> implement this plan task by task. Track every checkbox in the mission ledger.

**Goal:** Make every carrier-message chip report normalized requested and actual
transport without changing delivery behavior: one value when they agree, requested
only while actual is pending, `REQUESTED -> ACTUAL` when they differ, and
`REQUESTED -> Mixed` only after a multi-recipient send has complete divergent
actual evidence.

**Architecture:** Preserve `MessageType` as the content/modality contract and add
an orthogonal versioned transport contract. Provider adapters classify immutable
requested intent before execution and normalize actual transport only from provider
evidence. Repositories persist message-level and per-recipient facts with
conditional child-field transitions. Every writer and projection carries those
facts unchanged. A pure dashboard presenter is the only place that turns them into
chip copy. Schema-absent history and schema-absent queued relay work stay on the
exact legacy path.

**Tech stack:** TypeScript, Express, DynamoDB document client, React 19, Vitest,
Testing Library, Playwright, the existing Twilio SDK, and the existing fake Twilio
engine. No new dependency, table, index, migration, backfill, feature flag, or
infrastructure change.

**Spec:**
`docs/superpowers/specs/2026-08-31-message-transport-fidelity-design.md` v6,
approved after the independent PASS recorded in
`docs/superpowers/reviews/2026-08-31-message-transport-fidelity/spec-review-independent-v6-findings.md`.

**Planning baseline:** The feature worktree was cut at `5ce9912f`. Current `main`
was inspected at `f27aabbf` and was 36 commits ahead during planning. The builder
must inspect both live worktree state and current `main` at Task 0, implement on the
feature branch, and perform the workflow's one allowed `main` sync only at the
final pre-handback step.

**Status:** Draft for adversarial plan review.

## Global constraints

- This is observability only. Do not change routing, eligibility, consent,
  suppression, provider selection, pacing, retries, send ordering, delivery status
  semantics, native-group membership, Twilio configuration, or any message body.
- Do not enable RCS. The current native group rail is authoritative Group MMS and
  therefore requests and observes `mms`. Future RCS behavior must fit the same
  contract without UI or repository changes.
- Keep `MessageType = 'sms' | 'mms' | 'call' | 'email'` and every current use of it
  for content, attachments, retry copy, rendering, and provider constraints.
  Transport fields are additive and independent.
- The only stored transport values are `sms`, `mms`, and `rcs`. `Unknown` and
  `Mixed` are presentation results, never persisted values.
- `transport_schema_version` is the sole compatibility discriminator. A missing
  version renders the current uppercase `type`; version 1 never falls back to
  `type` when evidence is missing.
- Do not migrate, backfill, or lazily upgrade old rows. Late callbacks may update
  delivery state on legacy rows but every transport-only write is a silent legacy
  compatibility no-op.
- Provider-specific fields may be interpreted only inside adapters. Services,
  jobs, repositories, API routes, dashboard code, imports, and seed code consume
  normalized transport values and never inspect Twilio field names or infer actual
  transport from body, attachments, `NumMedia`, delivery status, conversation
  kind, or legacy `type`.
- Twilio normalization follows the approved precedence exactly: explicit RCS
  evidence; inbound SM/MM SID only for an E.164 `To` with no channel prefix;
  outbound SMS/MMS SM/MM SID; RCS-requested SM/MM fallback only with a non-channel
  E.164 `From`; otherwise missing or conflict. Rule 4 applies only when there is no
  channel field. `From` E.164 plus `ChannelPrefix: rcs` is a conflict, not fallback.
- Treat `SM` and `MM` as Twilio Message-resource create-time classification. The
  implementation note must cite the Message resource SID pattern, the Twilio help
  article, and the live native-group evidence in
  `docs/superpowers/specs/2026-08-10-group-texting-spike-report.md:33`.
- Non-provider fixture SIDs such as `dev-*` are missing evidence, not unknown
  provider evidence. Emit evidence warnings only on authenticated provider traffic.
  Log only a channel scheme before the first colon, provider/message IDs, safe
  message keys, and `logSafeMemberKey` output; never log a phone number, raw
  `phone#<E164>` key, body, media URL, or complete channel address.
- Requested intent is immutable. Classification drift is warned and the existing
  send continues; do not rewrite the persisted request or add a refusal.
- Actual transport and delivery status are independent state machines. A callback
  that cannot advance status may still add actual evidence, and a callback with no
  evidence may still advance status.
- Actual transitions are absent to observed, same to idempotent, and `rcs` to
  `sms`/`mms` fallback. A later RCS observation after stored SMS/MMS on an
  RCS-requested send is stale and harmless. Refuse every other conflict.
- Aggregation transitions are absent to `planned`/`excluded`, `planned` to
  `attempted`/`excluded`, `excluded` to `planned` only before any attempt, and same
  to idempotent. `attempted` is terminal.
- Repository updates after append must target child fields and use DynamoDB
  conditions. Never rebuild a message or recipient slot from a stale read.
- A successful result clears a stale transient `errorCode`. SID and `sentAt` are
  absent-only. Status may remain `queued` while result metadata and actual
  transport land. Terminal delivery state must never regress.
- For version-1 relay work, complete all-current-member preflight before the first
  provider call. For schema-absent relay work, bypass every transport step and run
  the exact legacy path, including in-flight jobs, continuations, and held-message
  release.
- An `excluded` slot without a suppression code is intentionally absent from the
  delivery denominator and expanded rows. A source-time slot with no aggregation
  state remains counted until worker reconciliation. This is the one explicit
  carveout from otherwise unchanged delivery presentation.
- Optimistic carrier bubbles show no transport chip, even after POST success; only
  a server refetch may replace them with provider-backed transport fields.
- Imports remain schema-absent unless their source gains explicit provider evidence.
  Seeds and dev fixtures must declare transport explicitly and must not infer it
  from `type`.
- New and touched lines in code, tests, docs, prompts, labels, and test names are
  ASCII-only.
- Never deploy, mutate infrastructure, push secrets, edit a real `.env.*`, merge
  into `main`, or clean up the branch/worktree. Those remain human-owned.

## Work map

- **D1 - Domain and evidence:** canonical app unions, provider-agnostic state
  classifiers, Twilio evidence normalizer, and safe diagnostics.
- **D2 - Adapter contract:** two-stage immutable intent, late preparation, actual
  result, and authoritative Group MMS rail fact.
- **P1 - Persistence:** additive message/slot fields, conditional initialization,
  aggregation, actual evidence, and send-result operations.
- **W1 - Direct writers:** direct, broadcast, retry, inbound, and status callbacks.
- **W2 - Relay writers:** source-time intent, legacy compatibility, fan-out
  preflight, persisted announcements, suppression, continuation, and results.
- **W3 - Native group writers:** outbound Group MMS, inbound native group, and
  Conversations receipts.
- **W4 - Non-live writers:** imports, dev fixture, lean/live/matrix/performance
  seeds, and fake-provider callback shapes.
- **R1 - Readers:** conversation and contact timeline projections plus dashboard
  wire types and hook mappings.
- **U1 - Presentation:** pure message/recipient presenter, optimistic suppression,
  rollup denominator, expanded rows, and accessibility.
- **E1 - Real-flow proof:** hermetic browser coverage for pending, agreement,
  fallback, Mixed, inbound Unknown, native MMS, recipient rows, and legacy.
- **E2 - Completion:** one final `main` sync, all bare gates, independent review,
  fix wave, live hermetic self-QA, and merge-ready handback.

## Task 0: Reconcile the plan with live branch state

**Files:**

- Read `AGENTS.md`
- Read `.codex/feature-mission.profile.md`
- Read `documentation/FEATURE-DEVELOPMENT-WORKFLOW.md`
- Read the approved spec and all committed v6 review/adjudication artifacts
- Inspect every file named in Tasks 1-12
- Modify this plan only if current `main` changed a signature or path

- [ ] **Step 0.1: Prove worktree ownership and preserve concurrent work**

Run separately:

```powershell
git worktree list --porcelain
git status --short --branch
git rev-parse --verify -q MERGE_HEAD
git log --oneline --decorate -8
```

Expected: the worktree is `W:\tmp\message-transport-fidelity`, branch is
`feat/message-transport-fidelity`, there is no merge in progress, and every dirty
path is either an already committed mission artifact or explicitly accounted for.
Do not touch another worktree or unrelated dirty file.

- [ ] **Step 0.2: Refresh current-main signatures without syncing**

Use `git show main:<path>` and `git grep ... main -- <path>` for every file in the
work map. Confirm in particular the recently changed relay fan-out, announcement,
API, dev, seed, dashboard type, and e2e files. Record any plan drift in
`docs/superpowers/reviews/2026-08-31-message-transport-fidelity/implementation-drift-worklist.md`.
Do not merge or rebase here.

- [ ] **Step 0.3: Lock the provider evidence comments**

In the drift worklist, record these implementation references so no worker has to
reconstruct provider policy:

```text
RCS callback From:
https://www.twilio.com/docs/rcs/send-an-rcs-message

Status-callback fields and Message SID pattern:
https://www.twilio.com/docs/messaging/api/message-resource#twilios-request-to-the-statuscallback-url

Inbound webhook fields and ChannelMetadata:
https://www.twilio.com/docs/messaging/guides/webhook-request

SM/MM help article:
https://help.twilio.com/articles/223134387

Repo live Group MMS evidence:
docs/superpowers/specs/2026-08-10-group-texting-spike-report.md:33
```

The help article may remain JS-rendered and unquotable; use it only with the
Message-resource SID regex and repository spike evidence as corroboration.

- [ ] **Step 0.4: Commit only a real drift correction**

If Task 0 changes the plan or creates the drift worklist, verify `git diff --check`,
stage those explicit paths, and commit:

```text
docs: reconcile transport plan with current main

Co-Authored-By: Codex GPT-5 <noreply@openai.com>
```

If no correction is needed, create no empty artifact or commit.

## Task 1: Add the transport domain and Twilio evidence normalizer

**Files:**

- Create `app/src/lib/messageTransport.ts`
- Create `app/src/adapters/twilioMessageTransport.ts`
- Create `app/test/messageTransport.test.ts`
- Create `app/test/twilioMessageTransport.test.ts`

**Produces:**

```ts
export const TRANSPORT_SCHEMA_VERSION = 1 as const;
export const MESSAGE_TRANSPORTS = ['sms', 'mms', 'rcs'] as const;
export type MessageTransport = (typeof MESSAGE_TRANSPORTS)[number];
export type TransportAggregationState = 'planned' | 'attempted' | 'excluded';

export type TransportWriteDecision =
  | { kind: 'write'; transport: MessageTransport }
  | { kind: 'idempotent' }
  | { kind: 'stale-rcs-observation' }
  | { kind: 'conflict'; current: MessageTransport; attempted: MessageTransport };

export interface TwilioTransportEvidenceInput {
  direction: 'inbound' | 'outbound';
  requestedTransport?: MessageTransport;
  messageSid?: string;
  from?: string;
  to?: string;
  channelPrefix?: string;
  channelMetadata?: string;
  authenticatedProviderTraffic: boolean;
}

export type NormalizedTransportEvidence =
  | { kind: 'observed'; transport: MessageTransport; source: string }
  | { kind: 'missing'; source: string }
  | {
      kind: 'conflict';
      source: string;
      safeFacts: { sidPrefix?: string; fromScheme?: string; channelScheme?: string };
    };
```

- [ ] **Step 1.1: Write the provider-agnostic transition tests first**

Table-drive `decideActualTransportWrite(current, attempted, requested)` with:

```ts
[
  [undefined, 'sms', 'sms', { kind: 'write', transport: 'sms' }],
  ['mms', 'mms', 'mms', { kind: 'idempotent' }],
  ['rcs', 'sms', 'rcs', { kind: 'write', transport: 'sms' }],
  ['rcs', 'mms', 'rcs', { kind: 'write', transport: 'mms' }],
  ['sms', 'rcs', 'rcs', { kind: 'stale-rcs-observation' }],
  ['mms', 'rcs', 'rcs', { kind: 'stale-rcs-observation' }],
  ['sms', 'mms', 'sms', { kind: 'conflict', current: 'sms', attempted: 'mms' }],
  ['mms', 'sms', 'mms', { kind: 'conflict', current: 'mms', attempted: 'sms' }],
]
```

Table-drive the aggregation classifier for every allowed, same-value, and refused
transition. Pin that `attempted` never leaves `attempted`, and that `excluded` may
return to `planned` only when the slot has no actual evidence and was never
attempted.

- [ ] **Step 1.2: Write the Twilio precedence matrix before implementation**

Cover all of these independently:

- `From: rcs:sender` and valid `ChannelMetadata: {"type":"rcs"}` observe RCS.
- `ChannelPrefix: rcs` observes RCS only when `From` is absent or also channel
  addressed; `From: +1617...` plus `ChannelPrefix: rcs` is conflict.
- inbound `MM`/`SM` observes MMS/SMS only with E.164 `To` and no channel prefix;
  a rich-channel fact wins before SID inspection.
- outbound SMS/MMS request plus valid `MM`/`SM` observes the corresponding rail.
- RCS request plus `MM`/`SM` observes fallback only with E.164 `From`, no channel
  field, and no rich-channel evidence.
- RCS request plus SID alone stays missing.
- malformed `ChannelMetadata`, unknown non-empty prefixes, contradictory rich
  facts, invalid E.164 endpoints, and provider-shaped unknown SIDs return conflict
  or missing exactly as the spec defines.
- `dev-*`, `team-*`, `announcement-*`, and other non-`SM`/`MM` fixture SIDs return
  missing with no warning request.
- safe facts contain at most `SM`, `MM`, or another non-sensitive SID prefix and
  the scheme before the first colon; they never contain the address suffix.
- `authenticatedProviderTraffic: false` suppresses warning eligibility even for
  conflicting synthetic input.

- [ ] **Step 1.3: Run focused tests and prove red**

```powershell
npm run test -w @housingchoice/app -- test/messageTransport.test.ts test/twilioMessageTransport.test.ts
```

Expected: exit 1 because the modules do not exist.

- [ ] **Step 1.4: Implement the pure modules**

Keep `messageTransport.ts` free of Twilio vocabulary. In
`twilioMessageTransport.ts`, parse `ChannelMetadata` in a contained `try/catch`,
accept only `type === 'rcs'`, recognize Message-resource SIDs with
`/^(SM|MM)[0-9a-fA-F]{32}$/`, and use the existing E.164 helper rather than a new
phone parser. Return data; do not log inside the pure normalizer. The authenticated
webhook/adapter caller decides whether a conflict result warrants one structured
warning.

Do not treat `NumMedia`, attachment count, message `type`, or `MessageStatus` as
evidence. Comments beside SID parsing must include the four references locked in
Task 0 and state that SM/MM are Message-resource creation classification, not a
general delivery inference.

- [ ] **Step 1.5: Run focused tests and app typecheck**

```powershell
npm run test -w @housingchoice/app -- test/messageTransport.test.ts test/twilioMessageTransport.test.ts
npm run typecheck -w @housingchoice/app
```

Expected: both exit 0.

- [ ] **Step 1.6: Commit**

Stage the four explicit files and commit:

```text
feat: add normalized message transport evidence

Co-Authored-By: Codex GPT-5 <noreply@openai.com>
```

## Task 2: Introduce immutable adapter intents and actual results

**Files:**

- Modify `app/src/adapters/messaging.ts`
- Modify `app/src/adapters/groupConversations.ts`
- Modify `app/test/messaging.test.ts`
- Modify `app/test/groupConversationsAdapter.test.ts`
- Modify adapter fakes named by the Task 0 drift worklist

**Produces:**

```ts
export interface MessageTransportFacts {
  hasForwardableMedia: boolean;
}

export interface MessageTransportIntent {
  requestedTransport: MessageTransport;
}

export interface PreparedMessageSend extends MessageTransportIntent {
  params: SendMessageParams;
}

export interface CarrierMessageSender {
  classifyMessageTransport(facts: MessageTransportFacts): MessageTransportIntent;
  prepareMessageSend(
    intent: MessageTransportIntent,
    params: SendMessageParams,
  ): PreparedMessageSend;
  sendPreparedMessage(prepared: PreparedMessageSend): Promise<SendMessageResult>;
}

export interface SendMessageResult {
  providerSid: string;
  status: DeliveryStatus;
  providerTs: string;
  actualTransport?: MessageTransport;
}
```

Define the equivalent serializable intent/prepared-post types on the native-group
port. Keep `sendMessage(params)` and `postGroupMessage(input)` as compatibility
wrappers for existing non-chip callers; each wrapper delegates through its own
classify, prepare, and execute stages.

- [ ] **Step 2.1: Add failing Messaging adapter contract tests**

Assert the Twilio driver:

- classifies text-only durable facts as requested SMS and forwardable media as
  requested MMS;
- returns a frozen/plain serializable intent with no URL, closure, or SDK object;
- preserves the exact intent through late preparation;
- calls `messages.create` only from `sendPreparedMessage`;
- normalizes `SM...`/`MM...` results for SMS/MMS requests into actual SMS/MMS;
- leaves actual absent when the result lacks valid evidence;
- keeps the compatibility wrapper's existing provider params and return fields.

Assert the console driver returns the requested transport as actual because the
console adapter itself is the provider boundary; it must not fabricate a Twilio SID
or invoke the Twilio normalizer.

- [ ] **Step 2.2: Add failing Group MMS port tests**

Assert the Twilio Conversations driver classifies requested MMS, prepares without
changing it, invokes the same existing Group MMS post, and returns actual MMS from
the authoritative rail fact. Assert a returned `ChannelMessageSid` may only
corroborate or conflict with MMS; it never originates the actual value. Preserve
all existing conversation, participant, media refusal, and error behavior.

- [ ] **Step 2.3: Run focused tests and prove red**

```powershell
npm run test -w @housingchoice/app -- test/messaging.test.ts test/groupConversationsAdapter.test.ts
```

Expected: exit 1 because the two-stage methods and actual result fields are absent.

- [ ] **Step 2.4: Implement with a narrow carrier-send surface**

Add `CarrierMessageSender` beside `MessagingAdapter` and type transport-aware
services against `MessagingAdapter & CarrierMessageSender`. Do not require every
voice/media-only test fake to implement irrelevant carrier methods. Update the real
Twilio and console drivers plus only the full adapter fakes identified by typecheck.

`prepareMessageSend` must receive freshly materialized URLs but must not reclassify
requested transport. `sendPreparedMessage` uses Task 1's normalizer. A normalizer
conflict emits one safe warning from the adapter with provider SID, safe scheme,
and requested transport; actual remains absent.

The Group MMS port mirrors the same sequence. Put its authoritative `mms` fact in
the provider adapter, not `groupSend.ts`, webhook code, or dashboard code.

- [ ] **Step 2.5: Run focused tests and app typecheck**

```powershell
npm run test -w @housingchoice/app -- test/messaging.test.ts test/groupConversationsAdapter.test.ts
npm run typecheck -w @housingchoice/app
```

Expected: both exit 0.

- [ ] **Step 2.6: Commit**

```text
refactor: expose carrier transport intents

Co-Authored-By: Codex GPT-5 <noreply@openai.com>
```

## Task 3: Add versioned persistence and conditional transport operations

**Files:**

- Modify `app/src/repos/messagesRepo.ts`
- Create `app/test/messagesRepo.transport.test.ts`
- Modify `app/test/helpers/twilioWebhookHarness.ts`
- Modify repository fakes reported by app typecheck

**Produces:**

```ts
// NewMessage camel-case input
transportSchemaVersion?: 1;
requestedTransport?: MessageTransport;
actualTransport?: MessageTransport;

// MessageItem persisted/wire names
transport_schema_version?: 1;
requested_transport?: MessageTransport;
actual_transport?: MessageTransport;

// RelayRecipientDelivery additions
requestedTransport?: MessageTransport;
actualTransport?: MessageTransport;
transportAggregationState?: TransportAggregationState;

export type TransportMutationOutcome =
  | 'updated'
  | 'idempotent'
  | 'stale'
  | 'conflict'
  | 'legacy_noop'
  | 'missing';

export interface RecipientSendResultPatch {
  status: RelayRecipientStatus;
  sid?: string;
  sentAt?: string;
  errorCode?: string;
  actualTransport?: MessageTransport;
}
```

Add repository methods with exact single-purpose behavior:

```ts
setMessageActualTransport(conversationId, tsMsgId, observed): Promise<TransportMutationOutcome>;
initializeRecipientDelivery(conversationId, tsMsgId, memberKey, slot): Promise<'created' | 'existing' | 'legacy_noop' | 'missing'>;
setRecipientTransportAggregationState(conversationId, tsMsgId, memberKey, next): Promise<TransportMutationOutcome>;
setRecipientActualTransport(conversationId, tsMsgId, memberKey, observed): Promise<TransportMutationOutcome>;
applyRecipientSendResult(conversationId, tsMsgId, memberKey, patch): Promise<TransportMutationOutcome>;
```

- [ ] **Step 3.1: Write DynamoDB Local contract tests first**

Use a unique test access key/table namespace and the real document client. Prove:

- append maps the three message fields and all three slot fields without changing
  legacy `type` or existing delivery fields;
- carrier fields are refused on call/email, version 1 is required when message-level
  transport fields exist, inbound requested is rejected, and actual values remain
  within the closed union;
- schema-absent messages return `legacy_noop` from every transport method without a
  warning-worthy error and without changing the row;
- missing source or slot returns `missing` distinctly;
- message actual and recipient actual implement every Task 1 state transition;
- aggregation implements every allowed/refused transition and `attempted` terminal;
- initialization creates only an absent slot and never replaces an existing slot;
- a conditional race is re-read and classified as updated/idempotent/stale/conflict,
  not returned as an unexamined DynamoDB error;
- simultaneous status, SID, error, timestamp, actual, and aggregation writes preserve
  each other because every update targets child fields;
- applying `{status:'queued', sid, sentAt, actualTransport}` to an already queued
  slot writes metadata and actual evidence even though status is unchanged;
- a more advanced status never regresses, absent SID/`sentAt` may still land, and a
  success removes a stale transient `errorCode`;
- continuation first success clears its old transient error, while a duplicate
  success preserves the first SID and first `sentAt` and is idempotent where no
  other field changes;
- terminal delivery error data cannot be overwritten by a stale transient result.

- [ ] **Step 3.2: Run focused repository tests and prove red**

Docker and DynamoDB Local are expected to be running. Verify reachability before
testing; do not ask the human to start them without checking.

```powershell
npm run test -w @housingchoice/app -- test/messagesRepo.transport.test.ts
```

Expected: exit 1 because the fields and methods do not exist. If the run fails on
DynamoDB reachability, diagnose the local service first. If it shows the documented
residue signature, rerun under a clean access key before attributing the failure.

- [ ] **Step 3.3: Implement additive append validation and conditional updates**

Keep the initial source slot map atomic in `append`. Every later v1 operation uses
one DynamoDB `UpdateExpression` scoped to the relevant child attributes and a
condition including `transport_schema_version = 1`. Because DynamoDB cannot safely
address arbitrary map keys without expression names, bind every path component via
`ExpressionAttributeNames`.

On conditional failure, perform one consistent re-read and classify through the
pure Task 1 transition functions. Do not retry a refused transition blindly. The
`legacy_noop` outcome belongs in this classification and must remain quiet.

`applyRecipientSendResult` assembles independent status and metadata clauses. A
same-status or already-advanced status does not block SID, `sentAt`, error cleanup,
or actual transport. Use `if_not_exists` for SID and `sentAt`; remove a stale
transient error on success; never replace `requestedTransport` or the slot object.

Mirror the public methods in the webhook harness fake with the same outcomes so
route/service tests exercise actual-vs-status independence rather than an
always-success stub.

- [ ] **Step 3.4: Run focused repository tests and app typecheck**

```powershell
npm run test -w @housingchoice/app -- test/messagesRepo.transport.test.ts
npm run typecheck -w @housingchoice/app
```

Expected: both exit 0.

- [ ] **Step 3.5: Commit**

```text
feat: persist versioned message transport facts

Co-Authored-By: Codex GPT-5 <noreply@openai.com>
```

## Task 4: Propagate direct sends, inbound messages, and status callbacks

**Files:**

- Modify `app/src/services/sendMessage.ts`
- Modify `app/src/routes/webhooks/twilio.ts`
- Modify `app/test/sendMessage.test.ts`
- Modify `app/test/twilioSmsWebhook.test.ts`
- Modify `app/test/twilioStatusWebhook.test.ts`
- Modify `app/test/relayWebhook.test.ts`
- Modify `app/test/groupTextWebhook.test.ts`
- Modify direct-send/broadcast/retry tests named by Task 0

- [ ] **Step 4.1: Write failing direct-send tests**

Assert text, media, broadcast-recipient, and unreachable-number retry paths:

- call adapter classification before preparation/execution;
- append schema version 1 and the immutable requested transport;
- append returned actual when present and leave it absent when missing;
- retain the exact existing `type`, media, delivery status, audit, SSE, and retry
  behavior;
- do not append a provisional row when preparation/provider send fails;
- on retry, create the existing new message row with its own requested and actual
  facts rather than copying actual from the failed predecessor.

- [ ] **Step 4.2: Write failing inbound/status webhook tests**

Through the signed webhook harness, cover ordinary 1:1, relay inbound, closed-group
inbound, native-group inbound, and unknown-conversation inbound branches. Assert:

- every new carrier row is version 1;
- ordinary inbound `SM` to E.164 stores actual SMS, `MM` stores MMS, explicit RCS
  evidence stores RCS, and missing/conflicting evidence leaves actual absent;
- inbound rows never store requested transport;
- native-group inbound stores actual MMS from the group rail even when text-only;
- status callbacks can add actual when delivery status is unchanged/refused;
- status can advance with no actual evidence;
- one SSE event is emitted when either state machine writes and none when both are
  no-ops;
- legacy rows still advance delivery state while transport returns `legacy_noop`;
- RCS-to-SMS fallback, stale post-fallback RCS, and other conflicts follow Task 1;
- warnings contain safe schemes/IDs only and never raw channel addresses or phones.

- [ ] **Step 4.3: Run focused tests and prove red**

```powershell
npm run test -w @housingchoice/app -- test/sendMessage.test.ts test/twilioSmsWebhook.test.ts test/twilioStatusWebhook.test.ts test/relayWebhook.test.ts test/groupTextWebhook.test.ts
```

Expected: exit 1 on absent transport fields and old callback behavior.

- [ ] **Step 4.4: Implement direct and webhook propagation**

In `sendMessage.ts`, classify from durable forwardable-media facts, prepare with the
existing fresh provider params, execute, and append `transportSchemaVersion: 1`,
`requestedTransport`, and any `actualTransport`. Keep legacy `type` selection exactly
where content behavior currently depends on it.

At the top of each authenticated Twilio webhook handler, construct the Task 1
normalizer input from `From`, `To`, `MessageSid`, `ChannelPrefix`, and
`ChannelMetadata`. Pass only normalized output downstream. Native group branches
use the group adapter's authoritative MMS evidence and may compare a receipt channel
SID only for corroboration/conflict.

Status callbacks call status and actual operations independently and combine their
outcomes before emitting SSE. A non-provider dev fixture never enters this warning
path.

- [ ] **Step 4.5: Run focused tests and app typecheck**

```powershell
npm run test -w @housingchoice/app -- test/sendMessage.test.ts test/twilioSmsWebhook.test.ts test/twilioStatusWebhook.test.ts test/relayWebhook.test.ts test/groupTextWebhook.test.ts
npm run typecheck -w @housingchoice/app
```

Expected: both exit 0.

- [ ] **Step 4.6: Commit**

```text
feat: record transport on direct message flows

Co-Authored-By: Codex GPT-5 <noreply@openai.com>
```

## Task 5: Make relay fan-out transport-aware without stranding legacy work

**Files:**

- Modify `app/src/routes/api.ts`
- Modify `app/src/jobs/relayFanOut.ts`
- Modify `app/src/services/relayQueuedMessages.ts` only if a current-main signature
  requires explicit propagation; do not change its release behavior
- Modify `app/test/relayApi.test.ts`
- Modify `app/test/relayFanOut.test.ts`
- Modify `app/test/relayQueuedMessages.test.ts` only if Task 0 finds direct transport
  propagation is required
- Modify continuation/queued-pending tests named by Task 0

**Source append contract for every version-1 relay source:**

```ts
transportSchemaVersion: 1,
requestedTransport: sourceIntent.requestedTransport,
deliveryRecipients: Object.fromEntries(
  roster.map((member) => [
    relayMemberKey(member),
    {
      status: 'queued',
      requestedTransport: sourceIntent.requestedTransport,
      // Source-time slots intentionally have no aggregation state. The worker's
      // all-current-member preflight owns planned/excluded reconciliation.
    },
  ]),
),
```

- [ ] **Step 5.1: Write failing source-creation tests**

In the real relay POST route tests, cover both open and connecting groups with text,
durable forwardable media, and media-store unavailable. Assert the route asks the
adapter to classify from durable attachments plus stable media-store availability,
never from legacy `type` or expiring URLs. Assert the source and every source-time
slot receive schema/requested fields before enqueue or held persistence.

Pin all unchanged behavior: queued versus `queued_pending`, source synthetic SID,
body/media fields, audit, SSE, enqueue payload, and no provider send in the route.

- [ ] **Step 5.2: Write the fan-out compatibility and preflight tests**

Use a deterministic fake roster and provider. Cover:

1. A schema-absent source executes the exact old path: no intent classification,
   initialization, aggregation, or transport writes; sends and whole-slot legacy
   results continue for an in-flight job, continuation, and `queued_pending` flush.
2. A version-1 source is read before any transport write, making the branch
   decidable without mutating legacy work.
3. Before the first send, every current member has an initialized queued slot with
   immutable requested intent and `planned` aggregation.
4. A never-attempted planned member absent from the current roster becomes
   `excluded`; an attempted member is untouched; a later rejoin may move excluded
   back to planned only under the state machine.
5. Any real v1 current-roster preflight failure aborts before provider call zero.
   `legacy_noop` is not a preflight failure.
6. Suppression moves a planned slot to excluded, keeps requested, records the
   existing suppression status/error, never records actual, and never calls the
   provider.
7. A nonsuppressed leg moves to attempted immediately before its provider call.
8. The worker reclassifies from the durable forwardable attachment set and current
   stable media-store availability. Drift emits one safe warning, preserves the
   source/slot request, and performs the existing body-only or media send.
9. Fresh presigned URLs are generated per leg only after the immutable intent is
   selected and immediately before preparation/execution.
10. Accepted-to-queued success writes SID, first `sentAt`, actual, and clears stale
    transient error without losing queued status. Failure writes existing status and
    error semantics. Duplicate/continuation calls preserve first SID/time and never
    replace the slot.
11. Callback pointer writes and continuation enqueue behavior are unchanged.
12. Raw `phone#<E164>` member keys are represented only by `logSafeMemberKey` in
    every new warning/result log.

- [ ] **Step 5.3: Run focused relay tests and prove red**

```powershell
npm run test -w @housingchoice/app -- test/relayApi.test.ts test/relayFanOut.test.ts
```

Expected: exit 1 because source transport fields, schema branch, preflight, and
child-field result writes are absent.

- [ ] **Step 5.4: Implement source intent before persistence**

In both open and connecting branches of `api.ts`, construct the adapter-owned intent
from the exact durable attachments the worker can replay and stable adapter/media
configuration. Seed requested transport on the source and slots. Do not put
transport in the job payload: the source row remains the durable authority.

- [ ] **Step 5.5: Implement a hard legacy/v1 branch in the worker**

Immediately after reading the source:

```ts
if (source.transport_schema_version !== TRANSPORT_SCHEMA_VERSION) {
  return runLegacyRelayFanOut(source, input, deps);
}
return runVersionedRelayFanOut(source, input, deps);
```

`runLegacyRelayFanOut` is the existing behavior extracted or retained without any
transport calls. `runVersionedRelayFanOut` performs one all-current-member preflight,
then processes legs. Do not duplicate provider/pacing/media logic: factor shared
execution helpers whose transport hooks are explicit, while keeping the absence of
hooks on the legacy branch mechanically testable.

Use `initializeRecipientDelivery` only for current members absent from the source
map. Reconcile stale never-attempted planned slots after current-member
initialization. Mark attempted in the same leg immediately before the provider
call. Apply results with `applyRecipientSendResult`; never call unconstrained
`setRecipientDelivery` for v1.

- [ ] **Step 5.6: Run focused tests and app typecheck**

```powershell
npm run test -w @housingchoice/app -- test/relayApi.test.ts test/relayFanOut.test.ts
npm run typecheck -w @housingchoice/app
```

Expected: both exit 0.

- [ ] **Step 5.7: Commit**

```text
feat: track transport across relay fanout

Co-Authored-By: Codex GPT-5 <noreply@openai.com>
```

## Task 6: Apply the same execution contract to persisted announcements

**Files:**

- Modify `app/src/services/relayAnnouncements.ts`
- Modify `app/test/relayAnnouncements.test.ts`
- Modify announcement callers/fakes only where typecheck requires the new carrier
  adapter surface

- [ ] **Step 6.1: Write failing persisted-announcement tests**

Cover a persisted intro/system announcement with two recipients and assert:

- the source row is version 1 with requested SMS and queued slots carrying requested
  SMS plus `planned` aggregation;
- suppression moves the slot to excluded before any send and preserves the existing
  suppression result/error contract without actual;
- a provider-bound leg becomes attempted immediately before the call;
- accepted-to-queued result still records SID, first `sentAt`, actual, and clears a
  stale transient error;
- duplicate execution preserves first SID/time and all concurrent child fields;
- the message-level rollup can complete from the recipient slots;
- safe logging never includes a raw phone number or `phone#` key.

Also prove `persist: false` replay/legs-only announcements retain their current
behavior and do not create a message-level aggregation object merely to support a
chip that does not exist.

- [ ] **Step 6.2: Run the focused test and prove red**

```powershell
npm run test -w @housingchoice/app -- test/relayAnnouncements.test.ts
```

Expected: exit 1 because persisted announcements do not carry transport state.

- [ ] **Step 6.3: Implement using the Task 2 and Task 3 contracts**

Classify intent once before persisted append. Seed planned slots, apply excluded
for suppressed recipients, move to attempted immediately before the provider call,
prepare with the per-recipient body/current params, and write results through
`applyRecipientSendResult`. Do not invent a separate announcement aggregation
state machine or fork presentation behavior.

Extend `logSafeMemberKey` only if the current helper cannot safely accept every
announcement member-key shape. Its output may include a contact ID or a stable hash,
never a phone or address.

- [ ] **Step 6.4: Run focused tests and app typecheck**

```powershell
npm run test -w @housingchoice/app -- test/relayAnnouncements.test.ts
npm run typecheck -w @housingchoice/app
```

Expected: both exit 0.

- [ ] **Step 6.5: Commit**

```text
feat: track transport on relay announcements

Co-Authored-By: Codex GPT-5 <noreply@openai.com>
```

## Task 7: Record authoritative Group MMS on native group flows

**Files:**

- Modify `app/src/services/groupSend.ts`
- Modify `app/src/services/groupReceipts.ts`
- Modify `app/src/routes/webhooks/twilio.ts` native-group branches as needed after
  Task 4
- Modify `app/test/groupSend.test.ts`
- Modify `app/test/groupReceipts.test.ts`
- Modify `app/test/groupConversationsWebhook.test.ts`
- Modify `app/test/groupSendRepo.integration.test.ts`

- [ ] **Step 7.1: Write failing outbound Group MMS tests**

Assert a text-only native-group send still appends legacy `type: 'sms'` for existing
content behavior but stores schema version 1, requested MMS, and actual MMS on the
message. Every nonsuppressed recipient slot stores requested/actual MMS and
attempted; every suppressed slot stores requested MMS, excluded, and no actual.
Media remains unsupported exactly as today.

Pin member-count/refusal, Conversations provisioning, participant, post, delivery
status, sender attribution, audit, and SSE behavior as unchanged.

- [ ] **Step 7.2: Write failing native-group inbound and receipt tests**

Assert:

- an inbound native-group row stores schema version 1 and actual MMS, with no
  requested value, regardless of body-only content or `SM`/`MM` ambiguity;
- outbound and inbound rail facts come from the group adapter, not `type` or
  `OtherRecipients` in a generic normalizer;
- a receipt's channel SID may corroborate MMS and may produce a safe conflict
  warning, but never originates or overwrites the authoritative MMS value;
- receipt delivery status and actual transport remain independent;
- an SSE event fires when status or actual changes, not when both no-op;
- existing participant/channel pointer matching remains unchanged.

- [ ] **Step 7.3: Run focused tests and prove red**

```powershell
npm run test -w @housingchoice/app -- test/groupSend.test.ts test/groupReceipts.test.ts test/groupConversationsWebhook.test.ts test/groupSendRepo.integration.test.ts
```

Expected: exit 1 on missing Group MMS transport fields.

- [ ] **Step 7.4: Implement group propagation**

Use the group adapter's intent/prepared-post/result contract. `groupSend.ts` persists
the returned normalized intent/result; it does not contain the string `mms` as a
rail inference. Seed slots with required queued delivery status, then planned,
attempted, or excluded as the actual execution path dictates.

In `groupReceipts.ts`, compare optional channel SID evidence to the already
authoritative MMS fact only. Any Twilio SID rule used for corroboration lives in the
Twilio adapter normalizer. Keep receipt lookup and delivery transitions intact.

- [ ] **Step 7.5: Run focused tests and app typecheck**

```powershell
npm run test -w @housingchoice/app -- test/groupSend.test.ts test/groupReceipts.test.ts test/groupConversationsWebhook.test.ts test/groupSendRepo.integration.test.ts
npm run typecheck -w @housingchoice/app
```

Expected: both exit 0.

- [ ] **Step 7.6: Commit**

```text
feat: identify native group messages as MMS

Co-Authored-By: Codex GPT-5 <noreply@openai.com>
```

## Task 8: Make non-live data and fake callbacks explicit

**Files:**

- Modify `app/src/lib/import/apply.ts`
- Modify import tests named by Task 0
- Create `app/src/lib/seed/messageTransport.ts`
- Modify `app/src/lib/seed/lean.ts`
- Modify `app/src/lib/seed/live.ts`
- Modify `app/src/lib/seed/matrix.ts`
- Modify `app/src/lib/seed/performance.ts` or the current-main performance seed
  builder path identified in Task 0
- Modify seed tests including `app/test/seedData.test.ts`, `app/test/seedLive.test.ts`,
  `app/test/seedMatrix.test.ts`, `app/test/performanceSeed.test.ts`, and
  `app/test/performanceSeed.integration.test.ts`
- Modify `app/src/routes/dev.ts`
- Create `app/test/devMessageTransportFixture.test.ts`
- Modify `fake-twilio/src/engine/signer.ts`
- Modify `fake-twilio/test/signer.test.ts`
- Modify `e2e/fixtures/fakeTwilio.ts`

**Explicit seed helper:**

```ts
type SeedCarrierTransport =
  | { kind: 'legacy' }
  | {
      kind: 'versioned';
      requested?: MessageTransport;
      actual?: MessageTransport;
      recipients?: Record<string, {
        requestedTransport?: MessageTransport;
        actualTransport?: MessageTransport;
        transportAggregationState?: TransportAggregationState;
      }>;
    };

function withSeedTransport(
  message: SeedMessage,
  declaration: SeedCarrierTransport,
): SeedMessage;
```

- [ ] **Step 8.1: Pin import compatibility before changing helpers**

Add a regression test for new imports after deployment: imported SMS history remains
schema-absent, keeps legacy `type: 'sms'`, and gains no requested/actual fields
because the export has no provider-attributable evidence. Do not make imports
render `Unknown`.

- [ ] **Step 8.2: Write failing seed contract tests**

Require every seeded carrier message to use `withSeedTransport` with an explicit
declaration. Test these named worlds:

- ordinary outbound SMS: requested/actual SMS;
- ordinary inbound SMS: actual SMS only;
- text-only native group: outbound requested/actual MMS and inbound actual MMS even
  when `type: 'sms'`;
- pending outbound RCS: requested RCS, actual absent;
- fallback: requested RCS, actual SMS;
- completed multi-recipient divergence: requested RCS with attempted actual RCS and
  SMS legs, producing a future `Mixed` UI case;
- new unresolved inbound: version 1 with actual absent;
- explicit legacy row: no version or transport fields;
- performance-generated ordinary carrier and native group rows with explicit SMS
  or MMS facts, never inference from `type`.

Update byte-stable seed expectations once and only once after deliberate new fields
are accepted. A profile with no message rows should prove zero generated rows rather
than gaining artificial fixtures.

- [ ] **Step 8.3: Write failing dev-fixture and fake-signer tests**

Extend `/__dev/extraction/message-fixture` with validated explicit inputs:

```ts
transport?: {
  mode: 'legacy' | 'versioned';
  requested?: MessageTransport;
  actual?: MessageTransport;
};
```

Default to a deliberate versioned inbound SMS fixture for existing e2e use, while
allowing `mode: 'legacy'`, pending RCS, fallback, and unresolved inbound. Reject
invalid call/email or inbound-requested combinations. Keep `dev-*` SID and the lack
of a pointer item.

Extend fake Twilio inputs:

```ts
interface BuildInboundSmsInput {
  // existing fields
  channelPrefix?: string;
  channelMetadata?: Record<string, unknown> | string;
}

interface BuildStatusInput {
  // existing fields
  from?: string;
  to?: string;
  channelPrefix?: string;
  channelMetadata?: Record<string, unknown> | string;
}
```

Assert the fake emits no SMS/MMS `ChannelPrefix`; only explicit rich-channel cases
may emit `rcs`. Standard SMS/MMS callbacks include realistic E.164 endpoints and
valid SM/MM SIDs. JSON metadata is serialized exactly once. Extend
`postInboundSms` with the same optional controls.

- [ ] **Step 8.4: Run focused tests and prove red**

```powershell
npm run test -w @housingchoice/app -- test/seedData.test.ts test/seedLive.test.ts test/seedMatrix.test.ts test/performanceSeed.test.ts test/performanceSeed.integration.test.ts test/importApply.integration.test.ts test/devMessageTransportFixture.test.ts
npm run test -w @housingchoice/fake-twilio -- test/signer.test.ts
```

Expected: exit 1 on absent explicit declarations and callback controls.

- [ ] **Step 8.5: Implement declarations, not inference**

`withSeedTransport` validates the declaration and only copies explicitly supplied
facts. It must never read `message.type`, body, attachments, `NumMedia`, or
conversation kind. Native-group seed call sites pass MMS because the seed author is
declaring a known provider rail, not because the helper derives it.

Keep importer output schema-absent. Update the dev fixture through the same domain
validation used by `messagesRepo` even though it writes directly. The fake emits
shape-faithful provider payloads; it does not call app code or import the app's
normalizer.

- [ ] **Step 8.6: Run focused tests and workspace typechecks**

```powershell
npm run test -w @housingchoice/app -- test/seedData.test.ts test/seedLive.test.ts test/seedMatrix.test.ts test/performanceSeed.test.ts test/performanceSeed.integration.test.ts test/importApply.integration.test.ts test/devMessageTransportFixture.test.ts
npm run test -w @housingchoice/fake-twilio -- test/signer.test.ts
npm run typecheck -w @housingchoice/app
npm run typecheck -w @housingchoice/fake-twilio
npm run typecheck -w @housingchoice/e2e
```

Expected: all exit 0.

- [ ] **Step 8.7: Commit**

```text
test: make transport evidence explicit in fixtures

Co-Authored-By: Codex GPT-5 <noreply@openai.com>
```

## Task 9: Carry transport through every authenticated projection and dashboard type

**Files:**

- Modify `app/src/routes/contactTimeline.ts`
- Modify `app/src/routes/api.ts` conversation-message projection only if current
  main does more than raw passthrough
- Modify `app/test/contactTimeline.test.ts`
- Modify conversation-message API tests named by Task 0
- Modify `dashboard/src/api/types.ts`
- Modify `dashboard/src/api/types.test.ts`
- Modify `dashboard/src/routes/contact/buildTimelineFallback.ts`
- Modify `dashboard/src/routes/contact/buildTimelineFallback.test.ts`
- Modify `dashboard/src/routes/conversation/useRelayThread.ts`
- Modify `dashboard/src/routes/conversation/useRelayThread.test.tsx`
- Modify `dashboard/src/routes/conversation/useGroupThread.ts`
- Modify `dashboard/src/routes/conversation/useGroupThread.test.tsx`
- Modify `dashboard/src/routes/contact/useContactTimeline.ts`
- Modify `dashboard/src/routes/contact/useContactTimeline.test.tsx`

- [ ] **Step 9.1: Write failing server projection tests**

For both contact timeline and fixed-conversation message reads, seed:

- a versioned direct outbound message;
- a versioned unresolved inbound message;
- a versioned relay source with requested/actual/aggregation slot facts;
- a schema-absent legacy row;
- a call and an email.

Assert the authenticated JSON carries all three message-level transport fields and
all three slot fields unchanged when present, omits them when absent, and does not
derive anything from `type`. Calls/email gain nothing. If the conversation endpoint
is raw passthrough on current main, lock that fact with a regression test rather
than adding an unnecessary mapper.

- [ ] **Step 9.2: Write failing dashboard type/mapping tests**

Mirror the app contract exactly:

```ts
export const MESSAGE_TRANSPORTS = ['sms', 'mms', 'rcs'] as const;
export type MessageTransport = (typeof MESSAGE_TRANSPORTS)[number];
export type TransportAggregationState = 'planned' | 'attempted' | 'excluded';

interface MessageTransportFields {
  transport_schema_version?: 1;
  requested_transport?: MessageTransport;
  actual_transport?: MessageTransport;
}
```

Extend `Message`, `TimelineMessage`, and `RelayRecipientDelivery`. Add a parity test
that imports the dashboard constant and compares it to a literal exhaustive tuple;
the app owns its equivalent test. Do not introduce a dashboard import from `app/`.

For contact fallback, relay mapper, group mapper, newest-page merge, older-page
merge, and SSE refetch, assert message/slot facts survive exactly. Optimistic items
must carry `optimistic: true` and no transport fields. `resolveOptimistic` updates
the real ID/status but keeps `optimistic: true`; only server refetch removes that
item and introduces provider-backed transport.

- [ ] **Step 9.3: Run focused tests and prove red**

```powershell
npm run test -w @housingchoice/app -- test/contactTimeline.test.ts
npm run test -w @housingchoice/dashboard -- src/api/types.test.ts src/routes/contact/buildTimelineFallback.test.ts src/routes/contact/useContactTimeline.test.tsx src/routes/conversation/useRelayThread.test.tsx src/routes/conversation/useGroupThread.test.tsx
```

Expected: exit 1 because transport and optimistic fields are not projected/mapped.

- [ ] **Step 9.4: Implement transparent projection**

Add optional transport fields to the existing mapping objects beside `type` and
`delivery_recipients`. Copy values only; do not normalize, aggregate, uppercase,
or substitute defaults. Add `optimistic?: boolean` only to the local
`TimelineMessage` shape, never to persisted/API `Message`.

Audit all hosts that reuse Timeline bubbles through these hooks. A grep for
`type: m.type`, `delivery_recipients`, and optimistic `kind: 'message'` must end with
every mapper classified in the drift worklist as changed or intentionally raw.

- [ ] **Step 9.5: Run focused tests and typechecks**

```powershell
npm run test -w @housingchoice/app -- test/contactTimeline.test.ts
npm run test -w @housingchoice/dashboard -- src/api/types.test.ts src/routes/contact/buildTimelineFallback.test.ts src/routes/contact/useContactTimeline.test.tsx src/routes/conversation/useRelayThread.test.tsx src/routes/conversation/useGroupThread.test.tsx
npm run typecheck -w @housingchoice/app
npm run typecheck -w @housingchoice/dashboard
```

Expected: all exit 0.

- [ ] **Step 9.6: Commit**

```text
feat: project message transport to the dashboard

Co-Authored-By: Codex GPT-5 <noreply@openai.com>
```

## Task 10: Implement the pure chip and aggregation presenter

**Files:**

- Create `dashboard/src/lib/messageTransport.ts`
- Create `dashboard/src/lib/messageTransport.test.ts`
- Modify `dashboard/src/routes/contact/deliveryStatus.ts`
- Modify `dashboard/src/routes/contact/deliveryStatus.test.ts`

**Produces:**

```ts
export interface PresentMessageTransportInput {
  type: MessageType;
  direction: 'inbound' | 'outbound';
  optimistic?: boolean;
  transportSchemaVersion?: 1;
  requestedTransport?: MessageTransport;
  actualTransport?: MessageTransport;
  recipients?: Record<string, RelayRecipientDelivery>;
}

export function presentMessageTransport(input: PresentMessageTransportInput): string | null;

export function presentRecipientTransport(
  slot: RelayRecipientDelivery,
): string | null;

export function isRecipientExcludedFromPresentation(
  slot: RelayRecipientDelivery,
): boolean;
```

- [ ] **Step 10.1: Write the complete message-chip matrix first**

Use table-driven tests for these outcomes:

| Case | Expected |
| --- | --- |
| optimistic carrier row, any fields | `null` |
| schema absent SMS/MMS | existing `SMS`/`MMS` |
| schema absent call/email | existing `CALL`/`EMAIL` |
| v1 inbound actual SMS/MMS/RCS | `SMS`/`MMS`/`RCS` |
| v1 inbound actual absent | `Unknown` |
| v1 inbound malformed requested present | ignore requested |
| v1 outbound requested SMS/MMS/RCS, actual absent | requested uppercase |
| v1 outbound requested equals actual | one uppercase value |
| v1 outbound request differs from actual | `REQUESTED -> ACTUAL` |
| v1 outbound request absent, actual present/absent | `Unknown` |

Then cover recipient aggregation:

- only `attempted` slots participate in actual-completeness and distinct-actual
  aggregation;
- `planned` means incomplete and keeps the requested-only chip;
- `excluded` never participates;
- source-time state-absent slots remain in delivery presentation but do not claim a
  completed transport observation;
- all attempted actual values equal request => one requested value;
- all attempted actual values equal another rail => `REQUESTED -> ACTUAL`;
- all participating legs complete with multiple actual values =>
  `REQUESTED -> Mixed`;
- any participating attempted leg missing actual => requested only, never premature
  `Mixed`;
- an inbound relay source ignores outbound recipient aggregation for the main chip.

For per-recipient rows, assert requested-only pending, one value on agreement,
arrow on disagreement, actual-only only when that is the only honest value, null for
excluded, and `Unknown` for a malformed versioned slot with neither fact.

- [ ] **Step 10.2: Write the delivery-denominator carveout tests**

Extend `presentRelayDelivery`, `presentLegDelivery`, and any staleness/timer helper
tests. Assert:

- `transportAggregationState: 'excluded'` plus no suppression code is absent from
  rollup counts, expanded rows, stale timers, and opted-out counts;
- `excluded` plus `contact_opted_out` keeps the existing opted-out note/copy and is
  not converted into a generic hidden member;
- a source-time state-absent queued slot remains counted, preserving existing
  presentation until worker preflight reconciles it;
- no existing delivery label/tone changes for included slots.

- [ ] **Step 10.3: Run focused tests and prove red**

```powershell
npm run test -w @housingchoice/dashboard -- src/lib/messageTransport.test.ts src/routes/contact/deliveryStatus.test.ts
```

Expected: exit 1 because the presenter and excluded-state semantics do not exist.

- [ ] **Step 10.4: Implement one pure source of chip copy**

The presenter must not import Twilio types, inspect provider IDs, infer from media,
or read conversation kind. It consumes normalized API facts only. Keep uppercase
and arrow formatting inside this module so `Timeline.tsx` cannot reconstruct the
policy.

Use one shared `includedRecipientEntries` filter from the pure module in delivery
rollups and UI rows. Preserve the special opted-out presentation before applying
the excluded-without-code hide rule.

- [ ] **Step 10.5: Run focused tests and dashboard typecheck**

```powershell
npm run test -w @housingchoice/dashboard -- src/lib/messageTransport.test.ts src/routes/contact/deliveryStatus.test.ts
npm run typecheck -w @housingchoice/dashboard
```

Expected: both exit 0.

- [ ] **Step 10.6: Commit**

```text
feat: present requested and actual transports

Co-Authored-By: Codex GPT-5 <noreply@openai.com>
```

## Task 11: Render message and recipient transport in every Timeline host

**Files:**

- Modify `dashboard/src/routes/contact/Timeline.tsx`
- Modify `dashboard/src/routes/contact/Timeline.test.tsx`
- Modify `dashboard/src/routes/contact/Timeline.module.css` only if existing layout
  classes cannot place recipient transport without ambiguity
- Modify `dashboard/src/routes/conversation/ConversationDetail.test.tsx`
- Modify `dashboard/src/routes/conversation/GroupTextView.test.tsx`
- Modify `e2e/support/selectors.md` if the accessible row contract changes

- [ ] **Step 11.1: Write failing component tests first**

Render the shared Timeline through direct, relay, and native-group hosts. Assert:

- optimistic carrier bubbles have no transport chip before or after POST success;
- server-refetched pending RCS displays `RCS`;
- agreement displays one value and fallback displays `RCS -> SMS`;
- complete divergent relay legs display `RCS -> Mixed`, while one attempted leg
  missing actual stays `RCS`;
- new unresolved inbound displays `Unknown`;
- schema-absent rows retain the existing uppercase legacy label;
- text-only native group displays `MMS`, not `SMS`;
- call/email labels and all delivery chips remain unchanged;
- inbound relay main chip uses inbound actual only, while its expanded rows show
  each outbound leg's requested/actual presentation;
- expanded outbound and inbound-relay rows expose transport in accessible text;
- excluded-without-code rows do not render; opted-out rows retain their existing
  explanation; source-time state-absent slots still render;
- duplicate recipient names remain distinguishable by the existing accessible row
  identity/number rules.

- [ ] **Step 11.2: Run focused component tests and prove red**

```powershell
npm run test -w @housingchoice/dashboard -- src/routes/contact/Timeline.test.tsx src/routes/conversation/ConversationDetail.test.tsx src/routes/conversation/GroupTextView.test.tsx
```

Expected: exit 1 because Timeline still uses `msg.type.toUpperCase()` and recipient
rows have no transport presentation.

- [ ] **Step 11.3: Replace inline transport inference**

Replace:

```ts
const transport = msg.type.toUpperCase();
```

with one `presentMessageTransport` call using the mapped fields and optimistic
marker. Do not add local fallback logic around a `null` result.

Build recipient entries through the shared inclusion filter. Change `showRecipients`
so it permits an inbound relay source with outbound slots while preserving the
existing queued-pending and no-map guards. Append each row's
`presentRecipientTransport(slot)` text next to its existing delivery text with a
stable separator and accessible name; do not replace status or member identity.

Update `hasTickableLeg`, opted-out counting, rollup, row ordering, and disclosure
summary to consume the same filtered entries. This prevents a hidden excluded row
from continuing to buy a timer or denominator entry.

- [ ] **Step 11.4: Run focused tests and dashboard typecheck**

```powershell
npm run test -w @housingchoice/dashboard -- src/routes/contact/Timeline.test.tsx src/routes/conversation/ConversationDetail.test.tsx src/routes/conversation/GroupTextView.test.tsx
npm run typecheck -w @housingchoice/dashboard
```

Expected: both exit 0.

- [ ] **Step 11.5: Run focused hermetic browser QA before committing**

From this worktree only, start an isolated session:

```powershell
npm run e2e:session
```

Use the Playwright browser control to dev-login, open direct, relay, and native
group threads supplied by the explicit seed/dev fixtures, and verify the component
matrix above at desktop and the existing narrow viewport. Save screenshots under
`.playwright-mcp/`. If backend code changed after session start, use
`npm run e2e:restart`; use `npm run e2e:reseed` only when a clean world is required,
then authenticate again. Finish with:

```powershell
npm run e2e:stop
```

Do not use ports 5174/8080 and do not run a full suite concurrently.

- [ ] **Step 11.6: Commit**

```text
feat: show requested and actual message transports

Co-Authored-By: Codex GPT-5 <noreply@openai.com>
```

## Task 12: Add hermetic end-to-end transport fidelity coverage

**Files:**

- Create `e2e/tests/dashboard-next/message-transport-fidelity.spec.ts`
- Modify `e2e/fixtures/fakeTwilio.ts` only if Task 8 did not expose every required
  signed callback control
- Modify e2e seed/dev helpers used by the new spec

- [ ] **Step 12.1: Write the browser spec before relying on manual proof**

One accessibility-first spec must prove these server-backed states:

1. Direct outbound SMS agreement renders one `SMS`.
2. Pending requested RCS renders `RCS` until a signed actual-evidence callback or
   refetch supplies actual.
3. RCS fallback renders `RCS -> SMS`.
4. Complete multi-recipient divergence renders `RCS -> Mixed` and expanded rows
   show their individual transports.
5. An incomplete attempted recipient keeps requested-only rather than premature
   `Mixed`.
6. New inbound explicit SMS/MMS/RCS renders the actual rail only.
7. New unresolved inbound renders `Unknown`.
8. A text-only native group message renders `MMS`.
9. A schema-absent fixture retains the legacy chip.
10. An inbound relay source retains its inbound main chip while expanded outbound
    legs report their own requested/actual rail.
11. An optimistic bubble has no chip until it is replaced by server data.
12. Excluded-without-code recipients are absent while source-time state-absent and
    opted-out rows retain their intended presentation.

Drive provider evidence only through signed fake-Twilio endpoints or the explicitly
gated dev fixture. Do not use synthetic `ChannelPrefix: sms`; the real provider does
not send it. Use `getByRole`, `getByLabel`, or the documented row selectors; do not
locate chips by CSS class.

- [ ] **Step 12.2: Prove the new spec fails for an intentional missing state**

Run the targeted spec through the e2e workspace script:

```powershell
npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/message-transport-fidelity.spec.ts
```

Expected: exit 1 before the final fixture/assertion wiring is complete. If npm does
not forward the file argument on current main, use an interactive `e2e:session` for
the red/green inner loop and record that constraint; do not invoke root Playwright.

- [ ] **Step 12.3: Complete only the hermetic fixture wiring required by the spec**

Keep all new controls structurally absent in deployed environments. Use unique
provider SIDs per callback and realistic `SM`/`MM` values. Do not seed requested or
actual transport through a body/media inference. After reseed, authenticate again.

- [ ] **Step 12.4: Run the targeted spec green**

```powershell
npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/message-transport-fidelity.spec.ts
```

Expected: exit 0 with all 12 proof points represented. Stop and diagnose any named
spec failure; there is no approved flake list for this behavior.

- [ ] **Step 12.5: Commit**

```text
test: cover message transport fidelity end to end

Co-Authored-By: Codex GPT-5 <noreply@openai.com>
```

## Task 13: Audit invariants, sync once, and run completion gates

**Files:**

- Modify implementation/tests only for defects found by the audit
- Create
  `docs/superpowers/reviews/2026-08-31-message-transport-fidelity/implementation-self-review.md`
- Create
  `docs/superpowers/reviews/2026-08-31-message-transport-fidelity/live-self-qa.md`
- Create handback/review artifacts required by the feature-mission orchestrator

- [ ] **Step 13.1: Run exhaustive mutation/reader greps**

Classify every result in the self-review; no unexplained hit may remain:

```powershell
rg -n "messages\.append\(|messageBatch\.put\(|PutCommand.*messages|delivery_recipients|setRecipientDelivery|updateRecipientDeliveryStatus|setRecipientDeliverySid" app/src app/test
rg -n "type\.toUpperCase\(|delivery_recipients|TimelineMessage|toTimelineMessage|buildTimeline|optimistic:" dashboard/src
rg -n "MessageSid|ChannelPrefix|ChannelMetadata|NumMedia|actual_transport|requested_transport|transport_schema_version" app/src fake-twilio/src e2e
rg -n "type:\s*'(sms|mms)'" app/src/lib/seed app/src/routes/dev.ts app/src/lib/import
```

For each message mutation, identify: legacy or v1, requested-intent source,
actual-evidence source, callback behavior, and tests. For each reader/renderer,
identify: raw passthrough or explicit field propagation, optimistic behavior, and
legacy/versioned presentation. Confirm there is no UI/provider inference and no
new migration path.

- [ ] **Step 13.2: Run focused regression bundles after audit fixes**

Run each workspace command separately, using the exact test files touched by the
final diff in addition to these anchors:

```powershell
npm run test -w @housingchoice/app -- test/messageTransport.test.ts test/twilioMessageTransport.test.ts test/messagesRepo.transport.test.ts test/sendMessage.test.ts test/relayFanOut.test.ts test/relayAnnouncements.test.ts test/groupSend.test.ts test/groupReceipts.test.ts test/twilioSmsWebhook.test.ts test/twilioStatusWebhook.test.ts test/relayWebhook.test.ts test/groupTextWebhook.test.ts
npm run test -w @housingchoice/dashboard -- src/lib/messageTransport.test.ts src/routes/contact/deliveryStatus.test.ts src/routes/contact/Timeline.test.tsx src/routes/contact/useContactTimeline.test.tsx src/routes/conversation/useRelayThread.test.tsx src/routes/conversation/useGroupThread.test.tsx
npm run test -w @housingchoice/fake-twilio -- test/signer.test.ts
npm run typecheck -w @housingchoice/app
npm run typecheck -w @housingchoice/dashboard
npm run typecheck -w @housingchoice/fake-twilio
npm run typecheck -w @housingchoice/e2e
```

Expected: every command exits 0.

- [ ] **Step 13.3: Request the workflow's final main sync once**

Inspect drift first:

```powershell
git fetch --all --prune
git log --oneline --left-right HEAD...main
git status --short --branch
```

If `main` advanced and the sync could conflict with active work, stop for human
direction as required by `AGENTS.md`. Otherwise merge or rebase current `main` into
the feature branch once, preserve both sides' intent, and record the sync commit in
the self-review. Never merge the feature branch into `main`.

- [ ] **Step 13.4: Run the five bare completion gates after sync**

Run separately from the feature worktree. Do not pipe or chain them:

```powershell
npm run typecheck
npm test
npm run smoke
npm run e2e
```

Then compute touched lintable files from the final branch:

```powershell
git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs'
```

If the list is non-empty, pass exactly that list to `npx eslint`. If it is empty,
skip ESLint rather than invoking a repo-wide lint. Attribute any reported error by
running the same path list at the merge base and comparing outputs; only new errors
are blocking. Record command, exit code, duration, and any baseline attribution.

If plain `npm test` first shows the documented DynamoDB residue signature, rerun
from `app` with `AWS_ACCESS_KEY_ID=hccleanrun001 npx vitest run` before blaming the
branch, then follow the repository's baseline-comparison rules. Do not use
`ALLOW_SKIP_DYNAMO_TESTS=1` for completion.

- [ ] **Step 13.5: Run post-gate independent implementation review**

The build-orchestrator dispatches the independent review required by the feature
mission only after all bare gates are green. The reviewer must adversarially verify:

- provider-evidence precedence and safe logging;
- hard legacy relay compatibility;
- same-status metadata writes and concurrency;
- all writer/reader coverage;
- native Group MMS authority;
- optimistic suppression and pure presentation;
- excluded denominator behavior;
- no delivery/routing change;
- no placeholder or test weakening.

Record findings and adjudications in separate committed files under the mission
review directory. Apply accepted fixes with targeted red/green proof, rerun every
affected targeted check, then rerun any full gate whose covered code changed.

- [ ] **Step 13.6: Perform live hermetic self-QA after review fixes**

Start one `e2e:session`, authenticate, and manually exercise direct, relay, and
native-group surfaces at desktop and narrow viewport. Verify the exact chip matrix,
recipient disclosures, pending-to-actual refetch, and unchanged send behavior. Save
evidence under `.playwright-mcp/` and record observations in `live-self-qa.md`.
Stop the session. Do not compete with any review agent's suite and do not use the
human's live ports.

- [ ] **Step 13.7: Verify repository hygiene and commit the final records**

```powershell
git diff --check
git status --short --branch
git rev-parse --verify -q MERGE_HEAD
```

Run an added-lines ASCII check over `main...HEAD` and a placeholder scan for
`TODO`, `FIXME`, `HACK`, `placeholder`, `not implemented`, skipped/focused tests,
and weakened assertions. Any intentional pre-existing hit must be named in the
self-review.

Stage only explicit review/self-QA paths and commit:

```text
docs: record transport fidelity handback

Co-Authored-By: Codex GPT-5 <noreply@openai.com>
```

Expected final state: clean feature worktree, no merge in progress, all bare gates
green on the synced branch, independent review resolved, live hermetic QA recorded,
and no merge/deploy/cleanup action taken.

## Acceptance traceability

| Approved acceptance area | Owning tasks |
| --- | --- |
| Requested/actual storage without changing `MessageType` | 1-4 |
| Conservative Twilio evidence and unresolved actual | 1, 2, 4, 8 |
| SMS/MMS direct, broadcast, retry | 2, 4 |
| Relay source, fan-out, continuations, queued holds | 3, 5 |
| Persisted announcements | 3, 6 |
| Native Group MMS outbound/inbound/receipts | 2, 7 |
| Imports remain legacy; no migration | 3, 8 |
| Seeds/performance/dev fixtures explicit | 8 |
| API and dashboard projection | 9 |
| Exact chip matrix and Mixed completeness | 10, 11 |
| Recipient rows and excluded denominator | 10, 11 |
| Optimistic chip suppression | 9, 11, 12 |
| Signed fake provider and real browser proof | 8, 12 |
| Safe logging and conditional concurrency | 1, 3, 5, 6, 13 |
| Full feature-mission gates/review/self-QA | 13 |
