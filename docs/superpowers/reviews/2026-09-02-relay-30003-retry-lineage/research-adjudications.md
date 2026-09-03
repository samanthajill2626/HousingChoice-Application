# Build-phase research adjudications - relay 30003 retry lineage

Orchestrator adjudication of the three read-only research passes run against
the live tree at `600dcac5` before any code was written:
`research-server-findings.md` (12), `research-dashboard-findings.md` (9),
`research-e2e-findings.md` (6). 27 findings, every one adjudicated below.

**No spec decision (D1-D23) changes.** Every accepted finding corrects plan
MECHANICS - a type that cannot compile, a harness helper that does not exist, a
process the plan named wrongly - or fills a gap the spec's own rule requires
filled. Where a decision below extends the spec's text it is marked
`EXTENDS` and is called out again in the handback for the human's eye.

Severity key: B = BLOCKING, M = MUST-HANDLE, N = NOTE. Task numbers are the
work map's (T1-T15 = plan Tasks 1-15).

## Server findings (S1-S12)

- **S1 (B) `sendOneRelayLeg`'s adapter type cannot compile.** ACCEPT. T3 and
  T11 declare `adapter: MessagingAdapter & CarrierMessageSender`
  (`app/src/jobs/relayFanOut.ts:946` is the precedent).
- **S2 (M) Task 11 step 6 re-closes slots the extraction already closed with a
  less specific code.** ACCEPT. On a `refused` / `filtered` / `suppressed`
  outcome the retry job writes NOTHING to the slot - the extracted body already
  wrote the specific terminal code - and only emits the D23 terminal ERROR. The
  job writes a slot itself in exactly three cases: a D9 gate refusal (before
  the send), `enqueue_failed` (webhook side, D14) and `transient_cap` (D10).
- **S2a (EXTENDS D23) the `retryClaim` vocabulary.** D23's rule is "every
  relay delivery-failure log line carries WHY no retry is running", but its
  seven listed values cannot describe four lines that rule covers: a relay
  failure whose code is not 30003 (30005, 30007, 21610), a callback that lost
  the create to a sibling (`deduped: true`), a 30003 whose slot already reads a
  different terminal code (the D8 30007 case), and the job's `filtered`
  outcome. Adding three values completes the enumeration without changing any
  severity decision: `code_not_retryable`, `already_claimed`,
  `slot_ineligible`. `enqueue_failed` is also a value (the plan's own Task 12
  test asserts it). The full union lives in `app/src/lib/relayRetryClaim.ts`
  as `RelayRetryClaimOutcome` so the webhook and the job cannot disagree.
  Severity mapping for the relay branch, stated once: ERROR iff
  `isTerminalDeliveryFailure(code)` (today's rule, unchanged - 30003 and 21610
  stay out of it) OR (code is 30003 AND the leg is a fan-out/team leg AND the
  outcome is neither `claimed` nor `already_claimed`); WARN otherwise. So
  21610 stays WARN, `fenced_announcement` stays WARN, `claimed` is WARN, and
  every terminal 30003 on a fan-out/team leg is ERROR - exactly the set the
  founder approved.
  **AMENDED by code-review-r1 F1: the WARN outcomes are `claimed`,
  `already_claimed`, `fenced_announcement` and `slot_ineligible`** - a leg whose
  slot already reads `delivered` or another terminal code did not end on 30003.
- **S3 (M) the post-send bump overwrites the inbox preview backwards.** ACCEPT.
  `touchLastActivityPreservingStatus(conversationId, preview: string |
  undefined, at)` and the retry job passes `undefined`: the founder's D16
  ruling is about ORDERING; the preview belongs to the thread's newest message,
  which a retry is not whenever anything arrived during the 60-240s backoff,
  and when nothing arrived the preview already reads this body. The T11 test
  asserts the preview argument is `undefined` and that a group closed
  mid-backoff stays closed. Spec D16 is unchanged (it never named the preview).
- **S4 (M) the existing SSE emit does not fire in the crash-recovery case and
  carries the retry row's id on rungs 2-3.** ACCEPT. The claim helper emits its
  own `message.persisted` for the ROOT on every successful claim, independent
  of `transitioned`; the existing emit is untouched. The duplicate on the
  ordinary rung-1 path is harmless: the dashboard consumer is a debounced
  full-page refetch that reads no payload (`useRelayThread.ts:449-455`).
- **S5 (M) the extraction's parameter list is short.** ACCEPT all four:
  `sendOneRelayLeg` takes a `payload: RelayFanOutPayload`-shaped envelope (the
  retry job builds one for the RETRY row: `sourceTsMsgId` is the retry row's
  key, `attempt` is the transient pass number); `hasMedia` is derived inside
  from `sourceMedia.length > 0` with the `hasMedia && mediaStore` guard kept
  (the fan-out's outside-the-loop media-without-store ERROR stays where it is);
  the outcome's `kind` lets the fan-out rebuild `transientRemaining` and
  `sentCount` so its completion log is byte-identical; the body parameter is
  named `legBody` and documented as the COMPOSED leg copy.
- **S6 (N) D13's "would triple a photo in the gallery" is not true at the
  live tree** (the only `listMediaPointers` reader excludes relay threads by
  name, `routes/contacts.ts:1374-1379`). ACCEPT the correction; BUILD the
  suppression anyway (unconditioned writes, by-name exclusion, durable
  garbage). T1 proves it by a direct `listMediaPointers` read, not through the
  gallery endpoint.
- **S7 (N) `mediaPointerCount` does not exist.** ACCEPT: T1 uses
  `messages.listMediaPointers(conv, { limit })` filtered on the deterministic
  SID, the idiom of `mediaPointers.integration.test.ts`.
- **S8 (N) `messagesRepo.transport.test.ts` is not a mocked-client suite.**
  ACCEPT: the `ConsistentRead` flag assertion follows
  `app/test/repos.test.ts:98-115` / `createAppendHarness` (a pure doc-client
  stub recording `cmd.input`).
- **S9 (N) exact typed-fake lists.** ACCEPT: `MessagesRepo` breaks in
  `test/helpers/twilioWebhookHarness.ts:1061`,
  `test/scheduledSendSuppression.test.ts:265`, `test/sendMessage.test.ts:223`;
  `ConversationsRepo` breaks in `test/contactCapture.test.ts:146`,
  `test/helpers/twilioWebhookHarness.ts:507`,
  `test/scheduledSendSuppression.test.ts:154`, `test/sendMessage.test.ts:102`.
  Gate 1 (`npm run typecheck`) is the proof the list is complete.
- **S10 (N) `enqueue`'s delay option is `runAt: Date`; `defineJobHandler`
  throws on re-registration.** ACCEPT; T11's tests use `_resetForTests()`
  between registrations.
- **S11 (N) return type.** ACCEPT: `touchLastActivityPreservingStatus` returns
  `Promise<ConversationItem>` like its sibling (a missing row throws from the
  condition, as documented at `conversationsRepo.ts:641-643`).
- **S12 (N) citation drift, six anchors.** ACCEPT; the byte-exact values are in
  the gitignored worklists and every implementer brief points there.
- **Part C (server) swept clean** - AI extraction, unread feed, unread counts,
  the queued-message flush, the fan-out's five-row window, `retry_of`'s only
  server reader, `relay_sender_key`, the other `delivery_recipients` readers,
  the escalation discriminator, `GET /messages` as-is. Recorded so the
  adversarial reviewer can spend its sweep elsewhere.

## Dashboard findings (D1-D9)

- **D1 (B) `EffectiveRelayLeg extends RelayDeliverySlot` cannot carry
  `requestedTransport` / `actualTransport` / `sid`.** ACCEPT:
  `EffectiveRelayLeg extends RelayRecipientDelivery` (the wire type, all eight
  fields; structurally a `RelayDeliverySlot`, so every presenter caller keeps
  compiling); `projectRelayLegs` SPREADS the original slot and overlays only
  what it decides; T6's preservation test asserts `sid`, `sentAt`,
  `deliveredAt`, `transportAggregationState`, `requestedTransport` AND
  `actualTransport` - the two the plan's test omitted are the ones
  `presentRecipientTransport` would silently turn into `Unknown`.
- **D2 (M) `hasTickableLeg` carries three counts and one is already wrong on
  main.** ACCEPT: T9 makes EVERY count in `Timeline.tsx` true after the change
  (`:749` "Four distinct non-terminations" above five items; `:781-782` "FIVE
  clauses"; `:1806` "the four non-terminations") - the new retry-state clause
  is added to each list with one line saying what it closes. The ticker test
  header (`Timeline.ticker.test.tsx:11`) is narrative history of review rounds
  and is left alone unless it states a predicate count.
- **D3 (M) `rerender` with a props bag is a type error.** ACCEPT: T9 adds a
  local element-returning helper (precedent `Timeline.test.tsx:39-57`
  `imageTimeline`) and calls RTL's `rerender(element)`.
- **D4 (M) the tour host test does not match its harness.** ACCEPT: T10 feeds
  RAW snake_case wire rows through `getConversationMessages.mockResolvedValue`,
  calls `renderConvo(props)` with `makeChannels({ group: { conversationId:
  'g1', ... } })` so the Group pane mounts, and uses no `mockThread`.
- **D5 (M) the tour suite mocks no roster read, so the recital is empty
  there.** ACCEPT: T10 mocks `getConversation`, `getConversationMembers` and
  `getConversationScheduled` following `PlacementConversation.test.tsx:42-44,
  :169-172`, so the tour test is a true host test; it asserts the chip text and
  the bubble count (the plan's two assertions) and may assert the recital once
  the roster is mocked.
- **D6-D8 (N) citation drift.** ACCEPT; worklists carry the exact anchors.
  D20's predicate narrows on `i.kind === 'message'` first, as the existing
  `visible` memo does (`Timeline.tsx:1791`, `:1797`), because the tour host's
  merged list holds `milestone` items with no `tsMsgId`.
- **D9 (N) a history page of only hidden retry rows renders "No messages
  yet."** ACCEPT as a recorded residual, not a change: the same shape already
  exists for a page of only `retry_of`-superseded 1:1 rows, and both the
  `before` bound and `hasOlder` read the raw page so paging still works.
  Goes in the handback beside Sec 9's paging-dilution residual.
- **Part C (dashboard) swept clean** - every surface that could misbehave
  derives from `visible`; every raw-`items` reader is a paging bound that must
  count hidden rows. Three hazards closed by decisions, each with one reopen
  point: `retry_of` off the retry row (`Timeline.tsx:1791-1797`); D9's refusal
  writes `retry_opted_out` never `contact_opted_out` (`deliveryStatus.ts:408`
  would null the whole rollup); D13's pointer suppression is the gallery's only
  defence (`useContactMedia.ts:39-41` dedupes on `providerSid:index`).

## E2E / harness findings (E1-E6)

- **E1 (M) the retry job runs IN-PROCESS in the APP in the hermetic lane, not
  in the spawned worker.** ACCEPT: the seam's PLACEMENT stands
  (`app/src/jobs/registerHandlers.ts`, called by both `index.ts:56` and
  `worker.ts:112`), the plan's REASON was wrong. T14 sets
  `E2E_RELAY_RETRY_BACKOFF_MS` as a literal in `childEnv`
  (`scripts/e2e-session.mjs:109-256`), which both `startApp` and `startWorker`
  inherit in `npm run e2e` and `npm run e2e:session` alike. Precedent:
  `E2E_LANE` / `E2E_APP_COMMIT` (`:243`, `:255`), never in any `.env*`.
  Corollary for self-QA: the job's log lines DO reach `GET /__dev/logtail`.
- **E2 (M) rung 1 is enqueued by the WEBHOOK, so a registration-scoped backoff
  never reaches it.** ACCEPT: `registerRelayRetryLegJobHandler(deps)` stores the
  resolved `backoffMs` in module scope and `enqueueRelayRetryLeg` defaults to
  it (explicit `deps` still win); T14's unit test asserts the fallback to
  60/120/240 on BOTH the free enqueue and the handler's re-enqueue when the env
  var is absent or malformed.
- **E3 (M) `e2e/support/selectors.md:49` pins the copy D15/D19 change.**
  ACCEPT: T14 extends that row with the two relay row strings (`Retrying -
  Phone unreachable (error 30003)`, `Delivered on retry`) and the four
  `retry_*` internal codes, and rewrites "must not promise a retry" to the
  post-D19 rule (no `will retry`; a claimed retry says `Retrying`). The native
  group-text half is fenced and untouched.
- **E4 (N) `relay-inbound-source-has-no-delivery-rollup.md:60-62` says the
  retry "renders nothing" for inbound.** ACCEPT: T15 corrects the sentence (no
  CHIP; the rows and the `inboundRecipientName` recital DO carry the states);
  the issue stays OPEN.
- **E5 (N) `relay-member-key-collapses-two-phones-one-contact.md:63-65` says
  the destination is recorded "on the leg".** ACCEPT: T15 rewrites it to the
  retry ROW's digest of `<root tsMsgId>|<destination E164>` compared by the
  job before sending; the issue stays OPEN.
- **E6 (N) D4's duplicate-DELIVERY guard cannot be exercised in the lane** (the
  in-process adapter runs a job once and swallows a throw,
  `adapters/scheduler.ts:180-204`). ACCEPT as a handback note: the marker is
  unit-proven only; a green e2e is not evidence for it, and a thrown retry
  handler in the lane is an ERROR line plus a lost rung, not a crash.
- **Both load-bearing harness assumptions HOLD**: the fake's status callback
  carries `To` (`fake-twilio/src/engine/signer.ts:219`, from
  `engine.ts:505`), and arming is one-shot per destination
  (`engine.ts:463-464`). The local queue honors `runAt` through a real
  in-process timer (`adapters/scheduler.ts:180-184`).

## Orchestrator additions

- **A1 - the leg copy's sender name at claim time.** `relayBody` is
  `composeRelayBody(senderName, body)` with `senderName =
  payload.senderNameOverride ?? senderMember?.name` (`relayFanOut.ts:998`,
  `:990-1000`). The claim path composes the leg copy ONCE at rung 1 - resolving
  the sender from the roster by `relay_sender_key`, and using whatever the
  source row itself carries if the original send used an override - and every
  later rung copies `relay_retry_leg_body` verbatim (D12). T12's implementer
  reads the override's origin in the team-send path and reports what it used.
- **A2 - the plan is not rewritten.** These adjudications are the delta; a
  five-line note at the top of the plan points here. Every implementer brief
  carries the relevant lines of this file and the gitignored worklists.
