# S1a report - Tasks 1, 2, 4 (Slice A, part 1)

Dispatch S1a of the SOR Stage 1 build. Implementer: Claude Opus 5.5 (1M context).
Worktree `W:\tmp\send-outcome-reconcile`, branch `feat/send-outcome-reconcile`,
started at c6ef540a. Inputs: plan rev 4 (Global Constraints, Shared interfaces,
Tasks 1, 2, 4), worklist section 0 (G1-G10), A11 and "S1a", findings T1-1..T1-3
and T4-1..T4-4, spike "Instructions for the build" (Task 1, Task 4), the
foundations reference sections 1-4, and spec D1, D2, D4, D8a, D17.

Method: strict TDD per task (failing test seen, then implementation, then
green), one commit per task, then a mutant spot-check on every non-trivial
guard. Each mutant was a reversible one-line edit, run, reversed, and proven
byte-identical to the pre-mutant file with `cmp` (no git checkout/restore).
Every mutant below was KILLED.

## Task 1 - classifier, `messagingErrors` leaf, throttle marker

Commit: `5008d9ee feat(send): classify provider send failures (rejected / retryable / unknown); count 20429 as a throttle`

Built:
- `app/src/adapters/messagingErrors.ts` (new, dependency-free leaf):
  `SmsSendingDisabledError`, with its JSDoc moved from `messaging.ts` (T1-1).
- `app/src/adapters/messaging.ts`: class body deleted; imports the leaf and
  re-exports it (`export { SmsSendingDisabledError } from './messagingErrors.js';`)
  at the class's former location, so `groupConversations.ts`, `groupSend.ts`
  and the tests keep importing it from `messaging.js`. `SEND_THROTTLE_CODES`
  is now `new Set(['429', '20429', '30022'])` (D4), with an added ASCII doc
  paragraph.
- `app/src/lib/sendOutcome.ts` (new): the plan's classifier and constants
  verbatim, plus doc comments. It imports ONLY `../adapters/messagingErrors.js`.
- `app/test/sendOutcome.test.ts` (new), `app/test/messaging.test.ts` (one new
  D4 test).

Deviations:
1. American spelling ("recognize") in the test title and comments, per the
   user's standing rule; the plan text says "recognise".
2. One extra test, "classifies the real SDK error shapes, whatever their name
   says (build spike Q6)". It covers a RestException 400/21211, the
   dropped-socket AxiosError (name 'Error', ECONNRESET, no status), the timeout
   AxiosError (name 'AxiosError', ECONNABORTED, 'timeout of 30000ms exceeded')
   and a 500/20500, and proves `name` never decides (spike Task 1 items 2-4).
   There are also extra assertions: a string '0' code, and `isProviderCode`
   on '', 'sms_sending_disabled', 'x20429' and '20429x'. 11 tests instead of
   the plan's 10.
3. The moved JSDoc is reworded to ASCII (its em dash is now a hyphen). It
   also gains a note that `services/sendMessage.ts` has a same-named
   `SendRefusedError` subclass that is never classified (T1-1).
4. The D4 test passes `level: 'info'` (G2/T1-2) and also asserts the marker
   is WARN (40).
5. NOT changed (T1-3: "changing only :543 needs neither"): the marker message
   `twilio send throttled (429/30022) - ...` (pre-existing em dash) still names
   only 429/30022, although it now also fires on 20429. The line's
   `errorCode` field is exact, and the SendThrottled metric filter keys on
   `$.event` only (`infra/modules/observability/main.tf:111`). Cosmetic.

Red -> green:
- Classifier RED: `Failed to load url ../src/lib/sendOutcome.js (resolved id: ../src/lib/sendOutcome.js) in W:/tmp/send-outcome-reconcile/app/test/sendOutcome.test.ts. Does the file exist?`
  GREEN: `test/sendOutcome.test.ts` 11 passed.
- Throttle RED: `AssertionError: expected [] to have a length of 1 but got +0`
  (the new D4 test). GREEN: messaging + sendOutcome, 2 files, 66 passed.
- Step 1 (leaf move, no behavior change): `npm run typecheck` exit 0.

Mutants (all killed; caught by):
- M1 known-rejected-code arm commented out -> "a code the arms already recognize classifies by code whatever the status says".
- M2 known-retryable-code arm commented out -> same test.
- M3 5xx arm commented out -> "HTTP 5xx is unknown even with a Twilio code" and "classifies the real SDK error shapes ...".
- M3b `status >= 500` -> `status > 500` -> "classifies the real SDK error shapes ..." (the 500/20500 case).
- M4 `status === 429` arm commented out -> "HTTP 4xx is rejected except the rate limit".
- M5 `status >= 400` arm commented out -> "HTTP 4xx is rejected except the rate limit", "a 4xx with no code (unparseable body) is still rejected - Review Focus 1", "a code of 0 is no code", "classifies the real SDK error shapes ...".
- M6 network-retryable arm commented out -> "a connection that never opened is retryable".
- M7 kill-switch arm commented out -> "the adapter-level kill switch is rejected with the sms_sending_disabled token".
- M8 numeric code-0 guard (`code !== 0` -> `code !== -1`) -> "a code of 0 is no code".
- M9 `isProviderCode` regex anchors dropped -> "isProviderCode is true for digits only".
- T1-M10 `'20429'` removed from `SEND_THROTTLE_CODES` -> "fires send_throttled on a real 20429 and not on ECONNREFUSED (spec D4)".
- T1-M11 `'ECONNREFUSED'` added to `SEND_THROTTLE_CODES` -> same test.

Fast gates after the commit: `npx vitest run test/sendOutcome.test.ts test/messaging.test.ts test/twilioHttpClient.test.ts test/twilioStatusWebhook.test.ts`
(sendFingerprint.test.ts did not exist yet) exit 0, 4 files, 147 passed;
`npm run typecheck` exit 0.

## Task 2 - fingerprint, digest and key helpers

Commit: `94831e84 feat(send): lossy body fingerprint, owner-independent recipient digest, hashed and redacted recipient keys`

Built: `app/src/lib/sendFingerprint.ts` (the plan's five functions and
`BodyFingerprint`, verbatim, plus doc comments) and
`app/test/sendFingerprint.test.ts` (the plan's tests verbatim, reformatted).

Deviations: none in behavior. Incident: the Write tool turned two of the test
file's Unicode escape strings (the curly quote / em dash / ellipsis line and
the fullwidth "HC" line) into real characters (18 non-ASCII bytes; the known
trap). A small Node script (scratchpad) converted every non-ASCII character
back into its escape sequence. The committed file is 0 bytes by the tr check,
and the staged added lines are 0.

Red -> green: RED `Error: Cannot find module '../src/lib/sendFingerprint.js' imported from 'W:/tmp/send-outcome-reconcile/app/test/sendFingerprint.test.ts'`.
GREEN: 7 passed.

Mutants (all killed):
- T2-M1 NFKC dropped -> "keeps letters and digits only, NFKC first".
- T2-M2 short threshold `< 3` -> `<= 3` -> "flags a body under three normalized characters as short".
- T2-M3 `hashRecipientKey` prefix guard commented out -> "hashes a phone-bearing key, leaves a contact id alone, is stable".
- T2-M4 digest no longer keyed on the sender -> "is keyed on the sender and owner-independent, 32 hex chars".
- T2-M5 `safeRecipientKey` never redacts -> "redacts a phone-bearing key for logs".

Fast gates after the commit: vitest (all five fast-gate files) exit 0,
5 files, 154 passed; `npm run typecheck` exit 0.

## Task 4 - `listMessages` / `getMessage`, the pinned request timeout

Commit: `d47e3487 feat(adapter): listMessages and getMessage on the messaging port; pin the Twilio request timeout to the claim TTL`

Built:
- `app/src/adapters/messaging.ts`:
  - `ProviderMessageSummary`, `ListMessagesArgs` and `ListMessagesPage` go
    after `SendMessageResult`.
  - `MessagingAdapter.listMessages` / `getMessage`, with docs.
  - `TWILIO_REQUEST_TIMEOUT_MS = SEND_CLAIM_TTL_MS`, documented "never set
    autoRetry" (spike item 8).
  - Local call-site views `MessagePageLike`, `MessageListResource` and
    `MessageFetchResource` beside `MessageMediaResource`. `TwilioClientLike`
    is UNCHANGED, with no call signature and no optional page/getPage (T4-1).
  - The plan's `isoOf` / `summarize`.
  - The Twilio driver's `listMessages` (with the page-size WARN) and
    `getMessage` (undefined only on 404 / 20404).
  - Console driver: a module-level capped store, the two `_...ForTests`
    seams, `listMessages` and `getMessage`.
  - Constructor: `twilio(sid, secret, { accountSid, timeout: TWILIO_REQUEST_TIMEOUT_MS, httpClient?: createRedirectingHttpClient({ baseUrl, timeout: TWILIO_REQUEST_TIMEOUT_MS }) })`
    (A11).
- `app/src/adapters/twilioHttpClient.ts` (A11): `RedirectingHttpClientOpts.timeout?: number`;
  `new RequestClient({ timeout: opts.timeout })` (undefined keeps the SDK
  30000, so `groupConversations.ts:455` needs no edit).
- `app/test/helpers/twilioWebhookHarness.ts`:
  - `FakeWorld` declares `sentDetails`, `providerMessages` and `listPageSize`
    (T4-2); `listPageSize` goes through a get/set bridge on the returned
    literal.
  - BOTH `sendPreparedMessage` and `sendMessage` push `sentDetails`, and
    `world.sent` pushes are unchanged (T4-3; the
    `twilioStatusWebhook.test.ts:1275` pin stays green).
  - A new provider-view overlay backs the fake `listMessages` / `getMessage`.
- Typed fakes gained `listMessages` / `getMessage` (the plan's benign
  defaults, in each file's syntax): `scheduledSendSuppression.test.ts`,
  `sendMessage.test.ts`, `tourReminders.test.ts`, `poolNumbers.test.ts` and
  `relayWarm.test.ts`.
- Tests: `app/test/messaging.test.ts` (two new describes) and
  `app/test/twilioHttpClient.test.ts` (one new describe).

Deviations:
1. `world.providerMessages` element type is the exported
   `FakeProviderMessage = ProviderMessageSummary & { to: string; from: string }`,
   not the plan's bare `ProviderMessageSummary[]`. The plan's own instruction
   "filtered by to/from" cannot work without the parties on each planted
   message, and `ProviderMessageSummary` has no parties. Names are unchanged;
   the element type is widened.
2. Harness overlay semantics (not in the plan): a planted entry whose
   `providerSid` equals a sent message's SID REPLACES that sent message in
   both list and fetch. That is how a test moves a sent message's provider
   state (e.g. to 'delivered', for "adopted with the fetched status").
   - Ordering: newest `createdAt` first; ties go to the later send/plant.
   - Paging: at `world.listPageSize` whatever `args.pageSize` says (as
     planned). The token is an integer offset string; a non-integer token
     throws.
   - A send without `from` never matches a list by sender.
3. Console `listMessages` returns ALL matches, newest first, with no token.
   It does not slice to `pageSize`, because slicing without a token would
   drop messages silently. The store is capped at 1000, equal to
   `RECONCILE_LIST_PAGE_SIZE`, so the reconcile's page always holds every
   match.
   - Console summaries: `providerStatus: 'sent'`, `sentAt` = `createdAt` =
     the returned `providerTs`.
   - A send without `from` is stored without one and never matches a list
     by sender.
4. Tests beyond the plan's five cases:
   (a) the list test also asserts NO WARN when the sizes match (kills an
   always-warn mutant);
   (b) `listMessages` throws on a client without the page API (an empty page
   would read as "never sent");
   (c) a STRING '20404' with no status maps to undefined;
   (d) a 5xx and an ECONNABORTED timeout both RETHROW from `getMessage`;
   (e) `getMessage` throws on a message-only fake;
   (f) the real SDK instance shape (camelCase, Date objects, `numMedia` as a
   string) maps correctly;
   (g) the spike item 5 plumbing test, plus two assertions the spike did not
   list. The pinned value (30000) EQUALS the SDK default, so
   `httpClient.defaultTimeout` alone cannot see a missing plumb (spike Q5).
   The test therefore also asserts the production client's own `timeout`
   field, and uses a PASS-THROUGH `vi.mock` spy on
   `createRedirectingHttpClient` in `messaging.test.ts` to see the options the
   driver hands it (behavior identical for every test in the file);
   (h) in `twilioHttpClient.test.ts`: `defaultTimeout` comes from
   `opts.timeout` (default 30000), and a stall server with `timeout: 200`
   rejects with ECONNABORTED in under 2 s;
   (i) a "harness fake adapter: the list / fetch port" describe (three tests)
   in `messaging.test.ts`, with the harness imported lazily. The project's
   precedent is a dedicated harness self-test file, but new files were outside
   this dispatch's file fence. Its WHY comment says the reconcile tests would
   otherwise pass vacuously on a broken fake.
5. The typed-fake list in the plan was complete (re-verified by grep across
   app/src, app/test, app/scripts, e2e and fake-twilio).

Red -> green: RED 16 failed | 56 passed (72) in messaging + twilioHttpClient.
For example: `TypeError: driver.listMessages is not a function`, and
`AssertionError: expected 30002 to be less than 2000` (the stall ran the
SDK's full 30 s default).
GREEN: 2 files, 72 passed; `npm run typecheck` exit 0.
Extra regression run of every touched typed-fake file plus the harness-heavy
fan-out suites: scheduledSendSuppression, sendMessage, tourReminders,
poolNumbers, relayWarm, broadcastFanOut, relayFanOut, relayRetryLeg and
twilioStatusWebhook. Result: exit 0, 9 files, 560 passed, and no
`[dynamoAdmin]` line.

Mutants (all killed):
- T4-M1 page-size WARN condition flipped (`!==` -> `===`) -> "WARNs when the provider page size differs ..." and "lists one page by To and From ... returns the next-page token" (no-WARN assertion).
- T4-M1b WARN never fires -> "WARNs when the provider page size differs ...".
- T4-M2 404 mapping deleted -> "fetches one message by SID and maps a 404 to undefined" and "maps a STRING 20404 with no status to undefined as well".
- T4-M2b status-only 404 check -> "maps a STRING 20404 with no status to undefined as well".
- T4-M2c every failure mapped to undefined -> `rethrows every other lookup failure: a 5xx or a timeout is never "not found"`.
- T4-M3a `timeout` dropped from the `twilio()` options -> "the pinned timeout reaches the SDK client on both paths (spec D8a; build spike Q5)".
- T4-M3b `timeout` dropped from the `createRedirectingHttpClient` call -> same test (the pass-through spy).
- T4-M3c `twilioHttpClient.ts` builds `new RequestClient()` -> "takes its request timeout from opts.timeout, defaulting to the SDK 30000" and "a stalled request rejects with ECONNABORTED at the passed timeout, not the SDK default".
- T4-M3d `TWILIO_REQUEST_TIMEOUT_MS` unpinned (20_000) -> "pins the request timeout to SEND_CLAIM_TTL_MS".
- T4-M4a harness `sendMessage` stops pushing `sentDetails` -> all three harness tests.
- T4-M4b sent message wins over a planted one with its SID -> "getMessage finds a sent or a planted SID; a planted entry replaces the sent one with its SID".
- T4-M4c harness ignores `listPageSize` -> "lists sent and planted messages by To and From, newest first, paged at world.listPageSize".
- T4-M5 console cap deleted -> "the console driver lists what it sent, newest first, by To and From, capped at 1000".

Fast gates after the commit: `npx vitest run test/sendOutcome.test.ts test/sendFingerprint.test.ts test/messaging.test.ts test/twilioHttpClient.test.ts test/twilioStatusWebhook.test.ts`
exit 0, 5 files, 170 passed; `npm run typecheck` exit 0.

Lint preview (gate 5 is the orchestrator's): `npx eslint` on all 15 files
this dispatch touched exits 0 with 0 errors. There is 1 PRE-EXISTING warning:
an unused eslint-disable directive at `app/test/messaging.test.ts:635`. It was
:621 at c6ef540a and only moved with the new imports.

## Contract for downstream

`app/src/adapters/messagingErrors.ts` (leaf, imports nothing):
- `export class SmsSendingDisabledError extends Error { constructor(message: string) }`
  (re-exported by `adapters/messaging.ts`).

`app/src/lib/sendOutcome.ts` (imports only the leaf):
- `export type SendFailureKind = 'rejected' | 'retryable' | 'unknown';`
- `export interface SendFailureClassification { kind: SendFailureKind; code?: string; status?: number; }`
- `export function classifySendFailure(err: unknown): SendFailureClassification;`
  Returns `{ kind: 'rejected', code: 'sms_sending_disabled' }` for the leaf
  class. Otherwise `code` (a string; numeric codes stringified, 0 / '0'
  omitted) and `status` appear only when present on the error.
- `export function isProviderCode(code: string | undefined): boolean;` (`/^[0-9]+$/`)
- `SEND_UNCONFIRMED_CODE = 'send_unconfirmed'`, `SEND_RETRYABLE_CODE = 'send_retryable'`,
  `REDRIVE_REFUSED_CODE = 'redrive_refused'`, `SMS_SENDING_DISABLED_CODE = 'sms_sending_disabled'`,
  `TRANSIENT_CAP_CODE = 'transient_cap'`, `ENQUEUE_FAILED_CODE = 'enqueue_failed'`,
  `SEND_CLAIM_TTL_MS = 30_000`, `RECONCILE_CHECK_DELAYS_MS: readonly number[] = [5_000, 30_000, 240_000]`,
  `RECONCILE_WINDOW_LEAD_MS = 60_000`, `RECONCILE_LIST_PAGE_SIZE = 1000`,
  `RECONCILE_MAX_PAGES = 5`, `OUTAGE_BRAKE_UNKNOWN_STREAK = 3`.

`app/src/lib/sendFingerprint.ts`:
- `normalizeBodyForMatch(body: string | undefined): string`
- `interface BodyFingerprint { hash: string; short: boolean }` and `bodyFingerprint(body: string | undefined): BodyFingerprint`
- `recipientDigest(sender: string | undefined, destinationE164: string): string` (32 hex)
- `hashRecipientKey(recipientKey: string): string` ('phone#...' -> 'phonehash#<32 hex>', others unchanged)
- `safeRecipientKey(recipientKey: string): string` ('phone#...' -> 'phone#redacted', others unchanged)

`app/src/adapters/messaging.ts`:
- `interface ProviderMessageSummary { providerSid: string; providerStatus: string; errorCode?: string; body: string; mediaCount: number; createdAt: string; sentAt?: string }`
  (`providerStatus` RAW; use `mapTwilioStatus`).
- `interface ListMessagesArgs { to: string; from: string; pageSize: number; pageToken?: string }`
- `interface ListMessagesPage { messages: ProviderMessageSummary[]; nextPageToken?: string }`
- `MessagingAdapter.listMessages(args: ListMessagesArgs): Promise<ListMessagesPage>` and
  `MessagingAdapter.getMessage(providerSid: string): Promise<ProviderMessageSummary | undefined>`.
  - Twilio `getMessage` resolves undefined ONLY on 404 / 20404 (either field,
    code string-tolerant) and throws otherwise.
  - Twilio `listMessages` throws on a client without the page API.
  - Twilio `nextPageToken` is the ABSOLUTE `https://api.twilio.com/...` URL:
    keep it in memory within one check, never in a payload (spike item 7).
- `export const TWILIO_REQUEST_TIMEOUT_MS = SEND_CLAIM_TTL_MS;`
  It reaches `twilio()` (production) and `createRedirectingHttpClient`
  (lane). `createRedirectingHttpClient(opts: { baseUrl: string; timeout?: number })`.
- Console seams: `_consoleSentMessagesForTests(): Array<ProviderMessageSummary & { to: string; from?: string }>`
  returns a copy, oldest first. `_resetConsoleSentMessagesForTests(): void`.
  The store is module-level, shared by every console driver in the process,
  capped at 1000.

Harness (`app/test/helpers/twilioWebhookHarness.ts`):
- `export type FakeProviderMessage = ProviderMessageSummary & { to: string; from: string };`
- `world.sentDetails: { params: SendMessageParams; sid: string; providerTs: string }[]`:
  every send from either adapter method, in order; `params` is the SAME
  object `world.sent` holds.
- `world.providerMessages: FakeProviderMessage[]`: push to plant.
  - A planted SID equal to a sent SID replaces that send.
  - Sends appear in the provider view as `providerStatus: 'queued'`,
    `createdAt: providerTs`, no `sentAt`, no `errorCode`.
- `world.listPageSize: number` (default 1000): set it with
  `world.listPageSize = 2`. The get/set bridge reaches the adapter closure.
  Tokens are integer offsets ('2', '4', ...).
- To make a lookup FAIL in a test, overwrite the method on the adapter object,
  e.g. `world.adapter.listMessages = async () => { throw err; }`. No seam was
  added.

## Concerns for the orchestrator

1. Deviation 1 of Task 4 (the `providerMessages` element type carries
   `to` / `from`) and the planted-replaces-sent overlay are contract points
   the S3 (Task 10) implementer must know. Both are in the contract above.
2. `messaging.test.ts` now `vi.mock`s `../src/adapters/twilioHttpClient.js`
   for the whole file with a pass-through spy. It is behavior-identical, but
   a future test in that file comparing function identity would see the spy.
3. There is no dedicated committed self-test FILE for the harness fake. Its
   tests live in `messaging.test.ts`, because of the file fence. The
   orchestrator may want them moved into a `twilioWebhookHarness*.test.ts`
   file later.
4. The throttle marker's message text still reads "(429/30022)" (cosmetic,
   see Task 1 deviation 5).
5. Spec D17's sentence "the narrow TwilioClientLike seam gains optional
   messages.list and messages(sid).fetch" is superseded here by T4-1 (local
   asserted views). Recorded for the drift report.
6. The branch now has three code commits beyond c6ef540a plus this report.
   No background process is left running. The throwaway mutant/escape
   scripts and outputs live only in the session scratchpad.
