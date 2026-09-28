# Reader C - manual Retry route, projection, dashboard, fenced line, e2e (FINDINGS)

Read-only research for the retry-send-adoption plan, at main@3dbb5740 (worktree
`W:\tmp\retry-send-adoption`). Spec: `docs/superpowers/specs/2026-09-27-retry-send-adoption-design.md`
(rev 5). Byte-exact quotes for everything cited here are in the REFERENCE file
`.superpowers/sdd/research/reader-c-reference.md` (gitignored). Nothing was run.

## 1. The manual Retry route (R6, R7) - `app/src/routes/api.ts`

Handler `api.ts:1567-1697`, mounted behind `manualSendLimiter` (shared 30/min
manual-send budget; a 429 `rate_limited` comes BEFORE the handler). Guards, in order:

1. `:1574-1578` `messages.getByProviderSid(providerSid)`; missing or other conversation -> 404 `message_not_found`.
2. `:1579-1582` not outbound -> 400 `not_outbound`.
3. `:1588-1591` `type === 'email'` -> 409 `not_retryable`.
4. `:1595-1598` status not `failed`/`undelivered` -> 409 `not_failed`.
5. `:1608-1611` RSW D10 time guard `isRetryPromiseLive(original.retry_due_at, Date.now())` -> 409 `retry_pending`.
6. (no further guard today) `:1619-1629` D14 recorded-recipient read `contacts.getById(recipient_contact_id)` (WARN when gone);
   `:1639-1673` media re-presign (`mediaStore.presign`) or raw `mediaUrls` replay;
   `:1675-1696` `sendMessage({...})` -> 201 `outcome`; `SendRefusedError` -> `REFUSAL_STATUS[err.code]` (`:171-204`); anything else rethrows.

The append call (`:1676-1688`) passes: `conversationId`, `body`, `mediaUrls`, `attachments`,
`automated: false`, `author: original.author === 'ai' ? 'ai' : 'teammate'`, `retryOf: original.tsMsgId`
(`:1685`), `recipient` (only when the recorded contact still exists). No `retryAttempt`,
no `retryWindowStart` (manual row starts its own window), no `broadcastId` today.
`SendMessageInput` already takes `broadcastId` (`services/sendMessage.ts:336`) and spreads it
into the append (`:658`); `retryRoot` is new.

Where the new guards go: between `:1611` (end of retry_pending) and `:1612` (D14 read), so
every existing 404/400/409 still answers first (rateLimit.test.ts:327-385 relies on the 404
being reached with no other side effect).

Deps: `ApiRouterDeps` is declared at `api.ts:282-410`; it has NO `sendAttemptsRepo`. The
router default-constructs every repo it is not given (`api.ts:562-640`, pattern
`deps.X ?? createX({ logger: deps.logger })`), and production passes NO api deps
(`app.ts:224`, `createApiRouter({ config, logger: log, ...deps.api })`; comment `api.ts:601-609`).
So add `sendAttemptsRepo?: SendAttemptsRepo` and `deps.sendAttemptsRepo ?? createSendAttemptsRepo({ logger: deps.logger })`
(factory `repos/sendAttemptsRepo.ts:319`; `get(owner)` is a ConsistentRead Get, `:323-326`).
No route reads the attempts repo today; only jobs do (broadcastFanOut.ts:320-330,
relayFanOut.ts:759-808, relayRetryLeg.ts:411-420, sendReconcile.ts:340; threaded by
registerHandlers.ts:37,60-77 - retrySend is NOT in that list yet).

What else the route must read (not in R6's text - see Discrepancies D4-D6):
- the `retrychild#` Query - a NEW `MessagesRepo` method (the router already holds `messages`);
- `conversations.getById(conversationId)` for R1's `phone#<participant_phone>` key when the row has no `recipient_contact_id`;
- for a pre-deploy pressed row (`retry_of`, no `retry_root`): the `retry_of` walk via
  `messages.getByTsMsgIdConsistent` (`messagesRepo.ts:1498`) to compute the append's `retryRoot`;
- constants: `MAX_SEND_RETRY_ATTEMPTS = 3` (`jobs/retrySend.ts:51`), `RETRY_SEND_WINDOW_MS`
  (`lib/retrySendWindow.ts:15`; module already imported at `api.ts:41`).

Suggested precedence (spec lists but does not rank): ... retry_pending (time) -> superseded
(any child) -> retry_unresolved (row belt `retry_outcome` or any `done/unresolved` record) ->
retry_pending (open, not stale record) -> proceed.

## 2. The route's tests - `app/test/apiRoutes.test.ts`

Retry describe `:428-758`, fixture `FAILED_ORIGINAL` `:431-440` (conv-1,
`2026-06-12T09:00:00.000Z#SMorig`, sms, `failed`, no recipient/lineage fields).
Factory `makeRetryApp(original, mediaStore?, contactsRepo?)` `:442-473`, via `buildApp`:

| dep | makeRetryApp | if the new route code calls it |
|---|---|---|
| messagesRepo | hand stub `{ getByProviderSid }` cast `as unknown as MessagesRepo` | any NEW method -> TypeError -> 500 (not DynamoDB) |
| sendMessageService | spy recording `SendMessageInput`, returns `SMretry` | fine |
| contactsRepo | only when the 3rd arg is passed | omitted -> real `createContactsRepo` (DynamoDB) - today only hit when `recipient_contact_id` is set |
| mediaStore | optional | omitted -> `createMediaStore({config})` = undefined without MEDIA_BUCKET |
| conversationsRepo | NOT passed | real DynamoDB repo (`api.ts:565`) |
| sendAttemptsRepo | (not a dep yet) | real DynamoDB repo once defaulted |
| auth usersRepo | `makeFakeUsersRepo([testUserItem()])` | fine |

Seeding: there is no world - the stub returns the `original` object as-is. The file's only
world-backed case is `:121-169` (`createFakeWorld()` + `world.conversationsRepo.createOrGetByParticipantPhone`,
`world.contacts.push`, the real send service over world fakes). The harness world has an
attempts fake: `world.sendAttempts` (Map keyed by `attemptKey(owner)`, seedable, `twilioWebhookHarness.ts:309-315`)
and `world.sendAttemptsRepo` (`:331-337`, impl `:4428`). `makeWebhookHarness`'s api block
(`:4923-5018`) passes NO `sendAttemptsRepo`.

Existing Retry cases (13): 201 re-send + retry_of `:475`; 404 unknown/other conv `:496`;
400 inbound `:509`; 409 not_failed x3 `:520`; D10 409 retry_pending (+30 s, -60 s) `:534`;
D10 201 after expiry / withdrawn sentinel `:551`; D10 not_failed answers first `:567`;
D14 recorded recipient passed `:583`; D14 recipient gone `:626`; 409 not_retryable email `:642`;
media re-presign `:665`; media dropped without store `:717`; raw mediaUrls replay `:742`.
Every 201-path case (7 of them) reaches the new guards and breaks unless the factory grows.

## 3. The projection - `app/src/routes/contactTimeline.ts`

Wire type `interface TimelineMessage` `:157-214` (not exported; union `TimelineItem` `:248`).
Mapper `toTimelineMessage(m, conversation, ourNumber)` `:413-474`. Fields that reach the
dashboard for an sms/mms row: `kind,id,at,conversationId,tsMsgId,direction,author,type`,
transport trio, `body`, `media_attachments`, `delivery_status` (`:447`), `error_code` (`:448`),
`retry_of` (`:449`), `retry_due_at` VERBATIM incl. the 1970 sentinel (`:452`),
`delivery_recipients`, `via_closed_group`, `imported`, `fromPhone/toPhone`, email fields.
NOT projected: `retry_attempt`, `retry_window_start`, `broadcast_id`, `recipient_contact_id`,
`automated`, `provider_sid` (the SID is the tsMsgId suffix).
Applied per thread at `:1261-1276` (`messages.listByConversation`); response `:1411-1416`
`{ items, nextCursor, upcoming, timezone? }`.
Add `retry_outcome?: 'unconfirmed'` to the interface after `:180` and
`...(m.retry_outcome === 'unconfirmed' && { retry_outcome: 'unconfirmed' as const })` after `:452`.
The chain COLLAPSE is not here - see D9. Test pattern: `app/test/contactTimeline.test.ts:367-403`
(stamps `world.messages[..].retry_due_at` directly, reads `/api/contacts/c-tenant/timeline`,
typed as the DASHBOARD `TimelineMessage` imported at `:39`, so `npm run typecheck` pins the
dashboard declaration).

## 4. The dashboard

- Type: `dashboard/src/api/types.ts:2520-2547` (`retry_of` `:2535`, `retry_due_at` `:2547`); add `retry_outcome?: RetryOutcome` there.
- `deliveryReason(errorCode, opts: DeliveryReasonOptions = {})` `deliveryStatus.ts:1133-1175`;
  options interface `:984-1001` (`media`, `relay`, `retryScheduled`) - add `retryUnconfirmed?`.
  Order today: internal-code map early return (`:1143-1144`), then promise (only when
  `retryScheduled && !relay`, `RETRY_SCHEDULED_REASONS` `:947-949` `'30003': 'Phone unreachable - will retry'`),
  media (`:930-933`), relay (`:975-977`), base (`:888-899`, `'30003': 'Phone unreachable'`);
  tail `` `${mapped} (error ${errorCode})` `` (`:1172-1174`). Insert the unconfirmed map ahead of the promise, skipped when `relay`.
- Tone/isFailure are NOT deliveryReason's: `presentDeliveryStatus` / `STATUS_PRESENTATION` `:39-57`
  (`undelivered`/`failed` = `danger`, `isFailure: true`) already give the spec's R5 tone. Nothing to write.
- 30003 tests: `deliveryStatus.test.ts:783-845` (relay drops promise; no promise without
  retryScheduled; promise with it; MMS keeps it; other codes unmoved; ASCII check `:840-845`
  with `EM_DASH` `:724`), `:864-881` (relay wins; relay copy == base).
- `retryPromise.ts:1-34` (`RETRY_PROMISE_GRACE_MS = 120_000`, `isRetryPromiseLive`), tests
  `retryPromise.test.ts:1-32`, mirror `retryPromiseMirror.test.ts:1-61`.
- Timeline (`routes/contact/Timeline.tsx`): `showsRetryPromise` `:791-795` (outbound, not email,
  isFailure, live stamp); used by the bubble `:1044` -> chip `:1058-1060`
  (`deliveryReason(msg.error_code, { media: isMms, retryScheduled: retryPromiseLive })` - the ONLY
  one-to-one call site; pass `retryUnconfirmed` here only) and by the ticker `:922` via `:2203-2211`.
  Retry button `:1426-1438`: `delivery?.isFailure && onRetry && !retryPromiseLive`, aria-label
  `Retry sending this message`, visible text U+21BB + `Retry`. Add `&& msg.retry_outcome !== 'unconfirmed'`.
- 409 copy: `sendFailureMessage(err)` `:88-139`, a `switch (err.code)` on `ApiError.code`
  (`api/client.ts:13-33`; code = the JSON `error`); `retry_pending` at `:134-135`
  "A retry is already scheduled for this message."; default "Couldn't send - please try again." (source uses U+2014).
  Add `superseded` and `retry_unresolved` cases beside it. Delivery path: see D10.
- Tests: `Timeline.test.tsx:931-948` (409 retry_pending copy via `onRetry` mockRejected
  `new ApiError(409,'retry_pending','retry_pending')`, reads `findByRole('alert')`), collapse
  `:950-1005`; `Timeline.delivery.test.tsx:609-672` (fixture `ONE_TO_ONE_30003` `:619-631`,
  `PROMISE_TEXT`/`PLAIN_TEXT` `:632-633`, `RETRY_BUTTON` `:634`).
- Mirror pattern: `*Mirror.test.ts` in `dashboard/src/routes/contact/` import app VALUES from
  `'../../../../app/src/lib/<leaf>.js'` and compare (`retryPromiseMirror.test.ts:17-22`,
  `sendOutcomeCodesMirror.test.ts:21-36`, also `relayWindowCloseMirror`, `mediaTypeMirror`). See D11.
- Tests run under vitest 3, jsdom, globals, `include: ['src/**/*.test.{ts,tsx}']`, `css: false`,
  15 s timeout (`dashboard/vite.config.ts:116-126`); the workspace (`@housingchoice/dashboard`) script `test` = `vitest run`.

## 5. The fenced webhook (`app/src/routes/webhooks/twilio.ts`) and isBroadcastRowFor

- `:322` `const STATUS_UNKNOWN_SID_RETRY_DELAY_MS = 2_500;` (seam `deps.statusUnknownSidRetryDelayMs`, `:702`; harness option `twilioWebhookHarness.ts:4752,5101`).
- `:3529` inside `if (transitioned)` (`:3520`): `if (typeof message.broadcast_id === 'string' && message.broadcast_id.length > 0)` -> `rollIntoBroadcast(...)`, errors ERROR at `:3543`.
- `rollIntoBroadcast` `:3853-3907`: returns early only for non-terminal non-`sent`; reads the broadcast, finds the slot by `conversationId + tsMsgId`, on a miss waits `statusRetryDelayMs`, re-reads, then `:3904`:
  `log.warn({ broadcastId, conversationId }, 'broadcast delivery rollup: no matching recipient slot <U+2014> ignored');`
  The R7 edit is `log.warn` -> `log.info` on that line (see D2 on the dash). Also a WARN at `:3882` ("broadcast not found") - untouched.
- twilio.ts never reads `retry_of` (only `relay_retry_of` `:2804-2805`, `:3318-3324`); the 30003 arm reads `message.retry_attempt` (`:3574`).
- `isBroadcastRowFor` is in `app/src/jobs/broadcastFanOut.ts:1296-1306`: true iff `row.broadcast_id === owner.broadcastId` AND (`recipient_contact_id` absent OR equals the owner's contact OR the row is the slot's tsMsgId). It never reads `retry_of`. See D1.

## 6. E2E

| spec | fixtures | arming | waits | log evidence | "one text" |
|---|---|---|---|---|---|
| `one-to-one-30003-retry.spec.ts` (290 lines, RSW) | Tasha `contact-tenant-0001` / `conv-0001` / `+15550100001` | `setDeliveryOutcome(fail, undelivered, 30003)` BEFORE the composer send (`:159-162`); afterAll re-arms `normal` + reseed (`:142-145`) | `expect.poll` 100 ms / 20 s on bubble text (`:175-190`); `Delivered` visible 45 s (`:235-238`) | none | `getOutboundTo({to})` filtered by body -> states `['undelivered','delivered']` (`:247-252`); stored rows via `GET /api/conversations/conv-0001/messages?limit=100` (`:109-114`) |
| `send-outcome-reconcile.spec.ts` (567, SOR) | fresh relay members + fresh consented tenants, `uniquePhone()` uid from 70 (`:90-94`, `:168-180`); never 0002 | `failNextSend` BEFORE the send (first create is the one under test), `failList(count 3)` (`:507-508`) | `expect.poll` on chips/rows 20-40 s | `readLogTail(since, event:'send_reconcile')` filtered on `owner` (`:226-243`); site lines by `contains` (`:247-254`) | `textsTo()` count by needle (`:130-133`) |
| `relay-30003-retry.spec.ts` | fresh relay numbers uid from 40 | setDeliveryOutcome | - | - | - |
| `share-skip-fix.spec.ts` | Dario 0002 + random `+1555xxxxxxx` tenants | setDeliveryOutcome 30007 | - | - | fake threads |

- Lane env: `scripts/e2e-session.mjs:283` `E2E_SEND_RETRY_BACKOFF_MS: '10000'` (flat for every attempt; read by `resolveSendRetryBackoffMs`, `jobs/retrySend.ts:110-117`), `:296` `E2E_SEND_RECONCILE_DELAYS_MS: '2000,4000,8000'` (read by `reconcileCheckDelaysMs`, `jobs/sendReconcile.ts:148-153`, delays are from `attemptedAt`). Both ignored when `JOBS_QUEUE_URL` is set; both reach only a FRESHLY booted lane.
- Fresh conversation recipe: `POST /api/contacts {type:'tenant', firstName, lastName, phone, voucherSize}` then `PATCH /api/contacts/:id {consent_method:'verbal_in_person', consent_at}` (SOR `:168-180`), then `POST /api/contacts/:id/conversation` -> `{ conversation: { conversationId } }` (`routes/contacts.ts:1926-1961`, idempotent; the composer calls the same via `ensureContactConversation`). A composer text carries no `recipient_contact_id`, so its R1 key is `phone#<participant_phone>`.
- App dev endpoints (`app/src/routes/dev.ts`): `GET /__dev/ping`, `GET /__dev/logtail?level&since&contains&event&limit` (WARN+ only, ring of 500, `logger.ts:49-51`; fixture throws when `capturing` is false), `POST /__dev/logtail/clear`, `POST /auth/dev-login`, `POST /__dev/reseed`, plus tick/fixture seams (tour-reminders, roster-actions, group-guardrails, journal-sweep, group-send-staleness, placement-nudges, extraction, relay/replay-intros). NO endpoint exposes send-attempt records.
- Fake endpoints (`fake-twilio/src/routes/control.ts`): `POST /control/delivery-outcome {partyNumber, profile}` `:81`, `POST /control/fail-next-send {partyNumber, mode, code?, count?}` `:109`, `POST /control/fail-list {partyNumber, count?}` `:124`, `POST /control/reset` `:133` (ONCE per suite, globalSetup only), `GET /control/threads` `:64`. Create behavior `rest.ts:152-185`: reject = 400 nothing recorded; drop_before_create = socket destroyed, nothing recorded, a pending delivery profile is NOT consumed; accept_then_drop = recorded (callbacks fire) then socket destroyed. List `rest.ts:201-208` consumes one fail-list per call with `To`. Fixtures: `e2e/fixtures/fakeTwilio.ts:201-211` (`getOutboundTo`), `:354-429`.
- Selectors (`e2e/support/selectors.md`): getByRole/getByLabel first; composer `getByRole('textbox', { name: 'Reply message' })` + `getByRole('button', { name: 'Send', exact: true })` (`:44-45`); bubble = `getByText(body, { exact: true }).locator('xpath=..')` and the one-to-one chip/Retry rule (`:50`); logtail rule (`:100`).

Recommended arming for items 17-19 (one fresh tenant per test): arm the 30003 profile, send,
wait for the promise chip (or poll `getOutboundTo` for the body), THEN arm
`failNextSend(accept_then_drop | drop_before_create)` (+ `failList(count: 3)` for 19) - all
inside the 10 s backoff. Budgets: ~20-30 s per test; use `test.slow()` (60 s default x3,
`playwright.config.ts:115-121`).

## 7. Copy governance

Not catalog-governed. `app/src/messages/catalog.ts:1-4` is "every automated/pinned message the
system SENDS" (member-facing SMS/voice). Staff-facing dashboard copy is plain literals by stated
rule: `deliveryStatus.ts:1017-1019` ("STAFF-FACING dashboard copy ... rather than in the app's
message catalog"), `:1094-1096` (SHARE_SKIP_REASONS "never the message catalog"); the 409
sentences are literals in `Timeline.tsx:88-139`. New copy: literals, ASCII, pinned by dashboard tests.

## 8. Every dashboard reader of `retry_due_at` / `retryDueAt`

- `api/types.ts:2547` - declaration on `TimelineMessage`.
- `routes/contact/Timeline.tsx:791-795` `showsRetryPromise` -> three consumers: chip copy `:1044`/`:1059`; Retry button `:1426`; ticker run condition `hasTickableLeg` `:922` via `tickerArmed` `:2203-2211`.
- `routes/contact/retryPromise.ts:29-34` `isRetryPromiseLive` (the only parser).
- NON-readers by design: `routes/conversation/useRelayThread.ts:101-143` (fixed field list drops it - relay/group views and the tour/placement GROUP tabs); `EmailCard` `Timeline.tsx:1730` (no options); share results row `broadcasts/broadcastFormat.ts:169` (`deliveryReason(errorCode)` bare).
- Comments/tests only: `api/serverClock.ts:3`, `deliveryStatus.ts:938,994-995,1149`, `Timeline.tsx:855,1057`, `Timeline.delivery.test.tsx:611-672`, `Timeline.ticker.test.tsx:141-155,993-1012`, `Timeline.email.test.tsx:91-108`, `retryPromise*.test.ts`, `deliveryStatus.test.ts:804`, `broadcastFormat.test.ts:183`, `StatChips.test.tsx:173`.
- Surfaces that render the one-to-one bubble with Retry: `ContactCommsPane` (`onRetry` `:304-308`, the ONLY Retry caller) under `ContactDetail.tsx:974` (contact page) and `ContactCommsTab.tsx:125` (tour/placement person tabs), both fed by `useContactTimeline` -> the server projection.

## 9. Fixture candidates (lean profile)

| candidate | contact | conversation | phone | verdict | used by |
|---|---|---|---|---|---|
| Tasha | `contact-tenant-0001` | `conv-0001` (tenant_1to1, auto) | `+15550100001` | NOT for fail-next-send/fail-list (shared number; armings survive to later specs) | 22 dashboard-next specs + 2 flows, incl. one-to-one-30003-retry, inbox*, outbound-mms, message-transport-fidelity |
| Dario | `contact-tenant-0002` | `conv-0002` (manual) | `+15550100004` | FORBIDDEN (spec, lean.ts:179-186) | share-skip-fix |
| Marcus (landlord) | `contact-landlord-0001` | none seeded (in the group text + connecting relay) | `+15550100002` | avoid: landlord of every test unit, group member | broadcasts, SOR, many |
| Renee (partner) | `contact-hastaff-0001` | none | `+15550100003` | unusable: no consent -> JIT refuses a person's send | - |
| FRESH tenant per test | POST /api/contacts + consent PATCH | POST /api/contacts/:id/conversation | `+15558<last4 Date.now()><uid>`, uid from 90 | RECOMMENDED | pattern: SOR `:90-94`, `:168-180` |

The lean seed has only TWO one-to-one threads (`app/src/lib/seed/lean.ts:255-288`).

## 10. Spec vs code discrepancies

- D1. `isBroadcastRowFor` is not in twilio.ts: `app/src/jobs/broadcastFanOut.ts:1296-1306`. It ignores `retry_of`: a retry row that copies the share's `broadcast_id` and names the same contact (or none) reads as THAT recipient's row ("mine") at both callers - `adoptBroadcastRecipient`'s dedupe (`broadcastFanOut.ts:1382-1392`, would move the slot onto the retry row's tsMsgId) and `sendReconcile.ts:595-603` `heldBy` for a broadcast owner. The rollup does NOT use it (slot match by conversationId+tsMsgId), so it always misses a retry row. State this in the handback (R7).
- D2. The give-up string at `twilio.ts:3904` contains U+2014, not " - " as the spec quotes. Decide: level-only (Q2's letter; leaves a non-ASCII touched line) or ASCII-ize the dash too (changes the message text). No test, doc or infra in the repo matches the string today.
- D3. The rollup runs on `sent` as well as `delivered`/`failed` (`twilio.ts:3872-3878`); a delivered share-retry text misses TWICE (sent, delivered): two 2.5 s waits in two callbacks and two INFO lines. "Once per receipt" holds only per transitioned callback.
- D4. R6's key derivation needs `conversation.participant_phone` for a row without `recipient_contact_id` - a conversation read the route does not do today, and R6 says nothing about a missing conversation / no phone / not one-to-one at the route (sendMessage would refuse later: 404 `conversation_not_found` or 409 channel refusal).
- D5. The route's `retryRoot` for a pre-deploy pressed row needs the `retry_of` walk (up to 3 `getByTsMsgIdConsistent`), beyond R6's "one Query + three gets".
- D6. R1 puts `retryRoot` on the `retry_send` owner while the key ignores it; `SendAttemptsRepo.get(owner)` (`sendAttemptsRepo.ts:146`, keyed by `recordKey` `:176-181`) forces the route to supply one. Either derive it (D5) or add a key-only read.
- D7. Only ONE attempt number can exist per pressed row: `(retry_attempt ?? 0) + 1` (`oneToOneRetryDecision.ts:125-129`; a manual row -> 1; a row at attempt 3 never gets a record). R6's 1..3 gets are safe; two always miss.
- D8. Item 15's "a fake that omitted them would default to real DynamoDB" is half true: `makeRetryApp`'s messagesRepo is a hand stub (a new method is a TypeError/500); conversationsRepo and the new sendAttemptsRepo DO default to real DynamoDB. "RSW's cases unchanged" means assertions unchanged - the factory must change. "60 newer unrelated rows" only means something with a world-backed messagesRepo.
- D9. The chain collapse is CLIENT-side (`Timeline.tsx:2060-2113`, `supersededIds` from every loaded row's `retry_of`), not in contactTimeline.ts. A retried row with two children (R6's residual fork) renders BOTH children.
- D10. There is no toast: `onRetrySurfaced` (`Timeline.tsx:2507-2514`) -> `sendFailureMessage` -> the text composer's `role="alert"` slot (`:2840-2844`), absent when the contact is deleted, a `readOnlyNote` replaces the composer, or the Email channel is selected (`:2693-2760`).
- D11. The mirror pattern compares runtime VALUES from import-free app leaves; a TS literal type has none. The app needs an exported const (suggest `lib/retrySendWindow.ts`, import-free, already mirrored) and the dashboard a hand copy; importing `repos/messagesRepo.ts` into the dashboard test would drag the AWS SDK in. Type-level alternative already in use: `app/test/contactTimeline.test.ts:39,394-397`.
- D12. R3/R9 log the unknown hand-off at INFO; SOR's fan-outs log theirs at WARN (`broadcastFanOut.ts:812`, `relayFanOut.ts:2256`) and the SOR e2e proves the seam by that WARN. The logtail keeps WARN+ only, so item 17 (adopted at check 0 = INFO) has NO log evidence the seam fired; use the stored retried row's REFRESHED `retry_due_at` (about `attemptedAt + 8 s + 120 s` on the lane vs the failure's `+10 s`) as the proof. Item 18 has the `never_sent` WARN at checkNo 2 (SOR shape); item 19 has WARNs at checks 0 and 1 plus ONE ERROR at 2 (`unresolved`, `provider_unreachable`).
- D13. `ownerRefLog` / `ownerLog` return `Record<string, string>` (`sendReconcile.ts:363,375`); the `retry_send` arm's `attempt` is a number. The e2e filter needs `owner.kind === 'retry_send'` and `owner.conversationId`.
- D14. RSW's own enqueue-failure withdrawal (`twilio.ts:3638-3641`, `annotateMessage({ retryDueAt: RETRY_PROMISE_WITHDRAWN_AT })`) writes the SAME sentinel with NO `retry_outcome`, and `Timeline.delivery.test.tsx:660-672` pins "WITHDRAWN ... offers Retry". "retry not confirmed" must key on `retry_outcome`, never on the sentinel.
- D15. The lean seed has no five one-to-one candidates (section 9); every line number the spec cites in this slice is current (`api.ts:1567/1608/1685`, `Timeline.tsx:134`, `twilio.ts:322/3529/3904`).

## 11. Traps for the builder

1. Arm fail-next-send / fail-list AFTER the original create is recorded: armed before the send, the ORIGINAL staff text consumes it (drop_before_create would drop the staff text itself). The 30003 profile is armed BEFORE the send.
2. accept_then_drop: the fake's callbacks reach the app before the adoption; the webhook re-looks the unknown SID once 2.5 s later and may log an unknown-SID ERROR (SOR spec `:64-74`). Scope every log assertion to `event: 'send_reconcile'` + the owner; never assert "no ERROR" globally.
3. The reconcile window (lead 60 s, `lib/sendOutcome.ts:32`) contains the ORIGINAL message (same body, ~10 s before the retry attempt). `heldBy` for `retry_send` must read it as `other` (held by the retried row, no matching `retry_of`/`retry_attempt`) so the lookup skips it; misread as free/mine, item 18 becomes `unidentified_candidate`/`sid_held_elsewhere` and item 17 could adopt the wrong SID.
4. Extend `makeRetryApp` (stub method, fake attempts repo, conversations stub) or move the new cases onto `createFakeWorld`; add `sendAttemptsRepo: world.sendAttemptsRepo` to `makeWebhookHarness`'s api block (`twilioWebhookHarness.ts:4923-5018`) or any world-backed route test reaches DynamoDB.
5. Keep the new route reads after the 404 guard; `rateLimit.test.ts:327-385` drives the route with no original.
6. New copy must be ASCII; extend the ASCII test (`deliveryStatus.test.ts:840-845`). The chip reads `Undelivered - Phone unreachable - retry not confirmed (error 30003)` (label + " - " + reason; the fake 30003 profile is `failState: 'undelivered'`).
7. Pass `retryUnconfirmed` only at `Timeline.tsx:1059`; the leg/row call sites (`:622`, `:1368`, `deliveryStatus.ts:541,843,873`) must not receive it. `RelayDeliveryOptions extends DeliveryReasonOptions` (`deliveryStatus.ts:436`), so the new flag becomes legal there too.
8. Do not reuse `NOT_CONFIRMED_PRESENTATION` (`deliveryStatus.ts:122-127`): it is `isFailure: false` and SOR's share meaning.
9. Update `e2e/support/selectors.md:50` (one-to-one chip + Retry row) with the new chip and the two 409 sentences.
10. Unit tests of the rollup: pass `statusUnknownSidRetryDelayMs` to `makeWebhookHarness` to skip the 2.5 s wait.
11. e2e: pick a uid range disjoint from 0/40/70 (e.g. 90); read stored rows through `GET /api/conversations/:id/messages?limit=100` (raw rows, so `retry_outcome`, `retry_root`, `retry_due_at` are visible); press the API with `page.request.post(.../messages/<provider_sid>/retry)`; boot the lane fresh (`e2e:restart` keeps old env).
12. The Retry button's visible text is U+21BB + "Retry"; address it only by its aria name.
