# Build research R3 - live-tree drift check: reconcile job, fake-twilio, e2e, self-QA

- Date: 2026-09-26. Branch `feat/send-outcome-reconcile` @1280058f (plan revision 4, spec revision 11).
- Scope: plan Tasks 10, 11, 12 and 16, checked against the LIVE tree (no code under app/, dashboard/,
  fake-twilio/, e2e/ or scripts/ changed since a9f411f3). READ-ONLY reader; nothing else in the repo was touched.
- Severity: BLOCKING = the task cannot be executed as written or would fail its gate; FIX = a wrong
  name/anchor/pin/omission the implementer must be told; NOTE = a risk or awareness item.
- Byte-exact quotes the implementers need are in the gitignored reference
  `.superpowers/sdd/build-reconcile-e2e-reference.md`. The SDK-level fake-route rules are already in the sibling
  spike `build-research/spike-twilio-node-fake-routes.md` ("Task 11" rules 1-10, "Task 12" rules 1-4); they are
  cited here, not repeated.
- Counts: 3 BLOCKING (T10-1 and T12-4 share one root cause), 16 FIX, 17 NOTE.

## Task 10 - `send.reconcile`

**T10-1 BLOCKING - a relay-leg adoption (and every relay-leg close the job makes) emits nothing, so an open
relay thread never shows it.** The relay thread refetches ONLY on SSE
(`dashboard/src/routes/conversation/useRelayThread.ts:464-501`); `relayFanOut.ts` emits nothing itself (no
`emit(` in the file); the only relay slot-move emit is the status webhook's
(`app/src/routes/webhooks/twilio.ts:3287-3295`), and in `accept_then_drop` those receipts arrive before any
pointer exists and are dropped after one 2.5 s re-lookup (`twilio.ts:322`, `:3366`, `:3408-3420`) - or race the
lane's 2 s check. The plan says `afterClose: relay_leg -> nothing` (plan :1840) and the relay adopt step
(plan :1883) names no emit, although spec D15 lists "the SSE emits" among the adoption writes.
Corrected instruction: after each durable relay-leg slot write the job makes (an adoption whose
`adoptRelayRecipientIfUnsent` returned `adopted`, `closeUnresolved`, the `redrive_refused` close, the
`enqueue_failed` close) emit
`events.emit('message.persisted', { conversationId, tsMsgId: <source tsMsgId>, direction: <source row direction>, deliveryStatus: <the status just written> })`
(the webhook's shape, `twilio.ts:3290-3295`), and assert it in the unit tests over `world.emitted`. Without it
T12 spec 1 passes or fails on a timing race (T12-4).

**T10-2 FIX - `announceRootClose` is not reachable.** It is a closure inside the `relay.retryLeg` handler
(`app/src/jobs/relayRetryLeg.ts:477-484`), built from the handler's own `rootTsMsgId` and `rowDirection`
(`:303`, `:413`). Rebuild it in `sendReconcile.ts`: read the retry row with
`messagesRepo.getByTsMsgIdConsistent(conversationId, retryTsMsgId)` (`messagesRepo.ts:1473`) and emit
`message.persisted` with `tsMsgId: row.relay_retry_of`, `direction: row.direction`. The closure hard-codes
`deliveryStatus: 'failed'` because it is only called on failure closes (docblock `:469-476`); on a `found`
adoption pass the adopted status instead.

**T10-3 FIX - `resolveContact` is module-local.** It lives at `app/src/jobs/broadcastFanOut.ts:692-700`,
unexported, and is not in Task 7's export list (plan :1384), yet the lookup uses it (plan :1849). Either export it
from `broadcastFanOut.ts` as part of this task, or inline it: a `phone#` key yields its own number with no read;
otherwise `contacts.getById(contactKey, { consistentRead: true })` (`app/src/repos/contactsRepo.ts:604`) - the
existing helper reads eventually consistently.

**T10-4 FIX - `logSafeMemberKey` takes a MEMBER, not a key.** Signature
`logSafeMemberKey(member: { contactId?: string })` (`app/src/services/relayAnnouncements.ts:157-161`). `heldBy`'s
holder string is built from a `relaysid#` pointer's `memberKey` STRING (plan :1877); passing
`{ contactId: ptr.memberKey }` for a contact-less member logs `phone#+1...`. Build every holder / log field that
starts from a key string with `safeRecipientKey(key)` (Task 2); use `logSafeMemberKey` only on a roster member.

**T10-5 FIX - the job-set pin, named.** `grep -l registeredJobNames app/test` returns TWO files. The pin is
`app/test/registerHandlers.test.ts:19-35` (a sorted `toEqual` list - add `'send.reconcile'`);
`app/test/mediaMirrorJob.test.ts:94` is a `toContain` and needs nothing. Also add the name to the job list in the
`registerAllJobHandlers` docblock (`app/src/jobs/registerHandlers.ts:30-43`). Step 4's run and `git add` lines
take `test/registerHandlers.test.ts`. No other catalog enumerates job names (`worker.ts:268`, `:278` print
`registeredJobNames()` at runtime; no infra/alarm lists them).

**T10-6 NOTE - how "no run-once marker" is spelled.** `defineJobHandler(jobName, handler)`
(`app/src/jobs/jobs.ts:199-204`) has no option; the marker is OPT-IN inside each handler body
(`messages.putJobExecutionMarker(getContext()?.jobId, ...)`, e.g. `broadcastFanOut.ts:244-257`; interface
`messagesRepo.ts:1498-1505`). "Without the marker" = never call it; say why in the docblock (spec D11).
`EnqueueOptions` is `{ runAt?: Date }` only (`jobs.ts:91-93`) - the stub is right.

**T10-7 NOTE - consistent reads that exist, and one that does not.** The source/retry row read already has a
consistent variant, `getByTsMsgIdConsistent(conversationId, tsMsgId)` (`messagesRepo.ts:1473`; harness
`twilioWebhookHarness.ts:1350`) - use it rather than Task 6's `listByConversationConsistent` + find.
`conversationsRepo.getById` (`conversationsRepo.ts:550`) has NO consistent variant, so the roster phone (digest
check), `status === 'open'` and "member on roster" (re-drive pre-check) are eventually consistent. Safe for the
pre-check (the re-driven pass re-reads and re-filters), weaker for the digest; record it as accepted.

**T10-8 FIX - the unit-test queue machinery, exactly.** With no `scheduleTimer`,
`InProcessOutboundQueueAdapter` (`app/src/adapters/scheduler.ts:137-236`) records delayed envelopes in
`outbound.delayed` as `delaySeconds = ceil(ms / 1000)` (`jobs.ts:112-114`, `scheduler.ts:179`);
`deliverDelayed(dispatchJob)` drains TRANSITIVELY and rethrows a handler throw (`scheduler.ts:224-231`); an
immediate enqueue (every re-drive envelope, and any check whose delay rounds to 0 s - e.g. a record seeded with an
old `attemptedAt`) goes to `runDeferred`, needs `outbound.settle()`, and SWALLOWS a throw (`:190-205`).
Corrected test instructions: case 4 compares `item.delaySeconds` with `Math.ceil(reconcileDelayMs(...) / 1000)`
(seconds, +-1) or pins the clock (`configureJobsClock`, `jobs.ts:87-89`, plus `vi.setSystemTime`); case 19's
propagating throw is observable only through `deliverDelayed` on a DELAYED check; a full chain is
`deliverDelayed` -> `settle()` (the re-drive) -> `deliverDelayed` again. The one-at-a-time idiom is
`outbound.delayed.shift()` + `dispatchJob` (`app/test/broadcastFanOut.test.ts:660-666`).

**T10-9 NOTE - a close whose `afterClose` throws is never finished.** The flow closes the record first
(`closeFromReconcile` / `closeRedriven`) and runs `afterClose` last (plan :1836, :1893). If `finalize` (or the
emit) throws, the redelivery exits at "reconcile superseded" (plan :1832: the record is now `done`) and nobody
finalizes; the pass already deferred finalize because this slot was `queued`, so the broadcast stays `sending`
and the results page polls forever (`dashboard/src/routes/broadcasts/useBroadcastResults.ts:152-157`).
Corrected instruction: on the superseded exit, when `record.state === 'done'` and
`record.attemptedAt === payload.attemptedAt`, still run `afterClose` (finalize is conditional, emits are
harmless).

**T10-10 NOTE - an import cycle.** `sendReconcile.ts` (T10) imports `finalize`, `adoptBroadcastRecipient` and
`BROADCAST_SEND_JOB` (`broadcastFanOut.ts:90`), `RELAY_FANOUT_JOB` (`relayFanOut.ts:78`) and
`RELAY_RETRY_LEG_JOB` (`relayRetryLeg.ts:74`), while all three files import the stub from `sendReconcile.ts`
(T7-T9). ESM live bindings make this safe only if no imported value is read at module-evaluation time: no
top-level constant built from them. Keep every use inside a function (or move the job-name constants to a leaf).
`npm run smoke` runs the compiled output under plain node.

**T10-11 NOTE - on the lane a throw is not a retry.** A delayed in-process dispatch is
`setTimeout(() => { void dispatch(wire) })` (`app/src/index.ts:66-67`, `scheduler.ts:180-184`): a handler throw
becomes an `unhandledRejection` ERROR (`app/src/lib/errors.ts:128-131`) plus `job failed: send.reconcile`, and
is never redelivered - the chain dies with the record `reconciling` and the slot `queued`. "A throw is a real
retry" holds on SQS only; the e2e and self-QA must not depend on it.

**T10-12 NOTE - the inbox touch can move backwards.** `touchLastActivityPreservingStatus` is an unconditional
`SET last_activity_at` (condition `attribute_exists(conversationId)` only, `conversationsRepo.ts:1623-1645`); the
plan's `last_activity_at < m.createdAt` guard (plan :1883, and Task 7's broadcast adoption) is read-then-write and
regresses the inbox order if an inbound touch lands in between. Accept it in the handback (an atomic guard needs a
repo change outside Task 10's files).

**T10-13 NOTE - a second receipt window D15 does not name.** A relay receipt for the adopted SID that lands AFTER
`claimRelaySidPointer` and BEFORE `adoptRelayRecipientIfUnsent` (plan :1883) finds the pointer
(`twilio.ts:3346-3374`) and is applied; the adoption then reports `skipped` (still `found`), so the slot ends
without the adopted `sid` / `sentAt`, and a 30003 there starts the RSW ladder in parallel. D15 accepts only the
window "between the status read and the pointer write"; record this one as accepted too.

**T10-14 NOTE - order the redriven enqueue-failure close.** `enqueueOrClose`'s redriven arm (plan :1843) writes
the record (`closeRedriven`) and the slot (`ENQUEUE_FAILED_CODE`) with no stated order. Any pass may claim a
`redriven` record (D8); if one did, a slot close first would flip its `queued` slot to `failed` and refuse its
later `sent` write (prior `['queued']`). Corrected instruction: `closeRedriven` FIRST and write the slot only when
it returned true.

## Task 11 - fake-twilio routes and seams

**T11-1 FIX - the test fixtures are per-test factories.** Neither file has file-level `app` / `engine`: each test
calls `const { app, engine } = makeApp();` (`fake-twilio/test/rest.test.ts:11-15`;
`fake-twilio/test/control.test.ts:11-20`, which also returns `posted`). The sketches (plan :2093-2141) use bare
`app` / `engine`.

**T11-2 FIX - "newest first" must not be a `createdAt` sort.** Both files build the engine on
`new ManualClock('2026-06-15T00:00:00.000Z')` (`rest.test.ts:13`, `control.test.ts:15`), which never advances, so
the three creates in the list test share one `createdAt`; a stable descending sort returns `['one', 'two']`, not
the expected `['three', 'two']` (plan :2098). Order by REVERSE STORE ORDER: `store.thread(to).messages` is
append order (`fake-twilio/src/engine/store.ts:9-17`), newest-first when reversed on every clock.

**T11-3 FIX - the resource needs fields the store does not hold.** `ThreadMessage`
(`fake-twilio/src/engine/types.ts:36-51`) has no sent time and no messaging-service sid; the create handler reads
`MessagingServiceSid` (`routes/rest.ts:51`) but never passes it to the engine (`:53-58`). Corrected
instruction: `date_sent` = the stored `updatedAt` once `state !== 'queued'` (or stamp a `sentAt` on the first
transition, `engine.ts:479-481`) and an EXPLICIT `null` while queued (spike Task 11 rule 5);
`messaging_service_sid` stored on `ThreadMessage` through `recordOutboundFromApp`'s input, or `null`;
`error_code` = `Number(stored string)` or `null`; and the CREATE response's `date_created`
(`routes/rest.ts:67`, `new Date().toUTCString()`) must come from the stored `createdAt` (`engine.ts:429`) too -
the plan applies the one-clock rule to list/fetch only (plan :2085).

**T11-4 FIX - `next_page_uri` must repeat the filters.** Plan :2083 says "a path carrying PageToken"; a path
carrying ONLY the token makes page 2 unfiltered. Build it with `URLSearchParams` from `To`, `From`, `PageSize` and
`PageToken` (percent-encodes the `+`; spike Task 11 rule 3 and its Q1b trap), and answer the list with status
200 exactly (spike rule 1).

**T11-5 FIX - `getMessageBySid` has no route.** The e2e helper (plan :2080, :2088) needs one; the plan adds no
control route for it, and the REST fetch route Smart-Encodes the body and CONSUMES a `fail-list` arming for that
party. Either add `GET /control/messages/:sid` returning the raw stored message (via the new
`store.messageBySid`) or drop the helper - no Task 12 spec uses it (`getOutboundTo`,
`e2e/fixtures/fakeTwilio.ts:201-211`, is the proof-of-send read).

**T11-6 NOTE - `reject` and `drop_before_create` leave the delivery profile armed.** They return before
`recordOutboundFromApp`, so an armed `setDeliveryOutcome` profile (`engine.ts:463-464`) is not consumed and
applies to the NEXT create to that party (the re-drive), and a never-seen number is not auto-registered as a
persona (`engine.ts:414-420`). Say so on the control route; no spec should combine the two seams.

**T11-7 NOTE - reset and suite scope.** `reset()` (`engine.ts:173-187`) must clear both new maps (plan says so).
`/control/reset` runs once per suite (preflight; `e2e/fixtures/fakeTwilio.ts:381-386`), so an arming a failed
spec never consumed survives into later specs - every spec arms per-run-unique numbers.

## Task 12 - lane seam and the four specs

**T12-1 FIX - `consent_method: 'inbound_text'` is rejected.** A client may set only `HUMAN_CONSENT_METHODS`
(`app/src/routes/contacts.ts:280-292`; `app/src/lib/smsCompliance.ts:82-87`); `inbound_text` answers 400. Use
`PATCH /api/contacts/:id` with `{ consent_method: 'verbal_in_person', consent_at: <now ISO> }`, exactly as
`share-skip-fix.spec.ts:95-100` (`recordConsent`) and `broadcasts.spec.ts:54-57` do.

**T12-2 FIX - share-skip-fix anchors.** `share-skip-fix.spec.ts:255-290` is the body of its third test (a failing
recipient plus a normal one, `setDeliveryOutcome`, the Recipients reads; the test spans `:250-285`). The helpers
are `createUnitViaApi` `:50-71` (POST `/api/units` + PATCH `/api/units/:id/listing-status`
`{ toStatus: 'available', source: 'manual' }` - the send guard refuses a non-available unit), `createTenant`
`:80-93`, `recordConsent` `:95-100`, `shareViaApi` `:104-116` (the "seeds-only share": POST `/api/broadcasts`
`{ unitId, body_template: '[Address] [FlyerLink]', seedContactIds }`,
then POST `/api/broadcasts/:id/send` `{ recipientContactIds }`). All are file-local: copy them or extract them to
`e2e/support`.

**T12-3 FIX - the relay recipient list is not 'Recipients'.** On a conversation page it is
`getByRole('list', { name: 'Delivery by recipient' })` scoped to the bubble (`Timeline.tsx:487`, `:1323-1324`);
`'Recipients'` (plan :2162) is the broadcast results page. The bubble is
`page.getByText(<unique token>).first().locator('xpath=..')`, and the list renders only after clicking the body
(`relay-30003-retry.spec.ts:175-186`, `:276-296`); a member-authored source shows it only once its
`delivery_recipients` map is non-empty (`Timeline.tsx:1167-1170`).

**T12-4 BLOCKING - spec 1 cannot observe the adoption on an open page as the tree stands.** See T10-1: nothing
emits for a relay-leg adoption, and the dropped receipts either never emit or race the 2 s check. Fix it in Task
10 (the emit) and keep spec 1 un-reloaded (the relay-30003 spec's "NOT RELOADED" rule,
`relay-30003-retry.spec.ts:190-195`); do not paper over it with `page.reload()`.

**T12-5 FIX - spec 1's parties, intros and body.** `sendAsParty` rejects an unregistered `from`
(`fake-twilio/src/engine/engine.ts:200-201`); a member is auto-registered only when its intro lands
(`engine.ts:414-420`). Settle BOTH members' intros (`INTRO_NEEDLE = 'Use this group text'` and
`from === pool`, `relay-30003-retry.spec.ts:77`, `:109-124`) before arming B and sending as A - or
`registerParty(request, ...)` A first (`fakeTwilio.ts:220-231`). The helper signature is
`sendAsParty(request, { from, to, body })` (`fakeTwilio.ts:233-258`). The relayed copy carries the sender's name
(`composeRelayBody`, `relayFanOut.ts:1019`): count B's copy with `includes(token)`, not equality. Mint numbers the
relay-30003 way (`+15558...` with a file-unique uid start, `relay-30003-retry.spec.ts:80-90`).

**T12-6 FIX - test budgets.** The default per-test timeout is 60 s (`e2e/playwright.config.ts:115`, `:121`).
`createGroupOpen` alone can poll 30 s + 60 s (`e2e/fixtures/relayConnect.ts:111-112`, `:148-151`) before two
15 s intro settles and the 20 s assertion: spec 1 needs `test.slow()` (as `relay-30003-retry.spec.ts:139`).
Specs 2 and 4 (a 40 s poll plus unit, tenant and share setup) should take `test.slow()` too.

**T12-7 NOTE - no parallel collision; the risk is sequential.** `workers: 1`, `fullyParallel: false`
(`playwright.config.ts:140-141`), so two workers never arm one number at once; an unconsumed arming outlives its
spec instead (T11-7).

**T12-8 NOTE - "fresh lane" must be proven.** The stale-stack guard compares the launch COMMIT
(`scripts/e2e-session.mjs`, `E2E_APP_COMMIT: gitSha`), so an uncommitted `childEnv` edit is invisible to it and
`reuseExistingServer` adopts an older lane running the production delays (5/30/240 s) - specs 2 and 4 then time
out. Run `npm run e2e:stop` and prove the lane's ports free before the first run of the new spec.

**T12-9 NOTE - childEnv neighbours.** `E2E_RELAY_RETRY_BACKOFF_MS` is at `scripts/e2e-session.mjs:272`,
`E2E_SEND_RETRY_BACKOFF_MS` at `:282`; the latter's comment (`:273-281`) says "share-skip-fix Branch B and
send-outcome-reconcile reuse it" - correct that sentence when adding `E2E_SEND_RECONCILE_DELAYS_MS`.

**T12-10 NOTE - login and reseed helpers are file-local.** `devLogin` is re-declared per spec (`page.goto('/')`,
"Continue as dev user", `expectTodayReady` from `e2e/support/today.ts:43`); `e2e/fixtures/reseed.ts` posts a
RELATIVE `/__dev/reseed`; the relay specs use a local `reseedLean` in `beforeEach` and `afterAll`
(`relay-30003-retry.spec.ts:93-96`, `:126-133`).

**T12-11 NOTE - the commit list.** Step 3's `git add` (plan :2179) names `e2e/support/broadcastSelectors.ts`,
`broadcasts.spec.ts` and `selectors.md` unconditionally; `git add` of a path that does not exist fails the
command. Add only what changed.

## Task 16 - live self-QA

**T16-1 BLOCKING - the fixture seam cannot write a slot's `attemptedAt`.** `POST /__dev/extraction/message-fixture`
(`app/src/routes/dev.ts:831`) accepts per recipient only `status`, `errorCode`, `requested`, `actual`,
`aggregationState`, and REBUILDS the slot as `{ status, errorCode? }` (`dev.ts:938-959`) - any other field is
dropped. Recipients are accepted only under `transport.mode: 'versioned'` (legacy refuses them,
`dev.ts:884-890`); an outbound fixture must carry `transport.requested`, an inbound one must not
(`dev.ts:982-988`). The lean seed has no OPEN relay group (`app/src/lib/seed/lean.ts:66-77`: one connecting
group, no pool number). Corrected instruction, one of: (a) extend the seam to accept `attemptedAt` (an ISO string
checked with `Date.parse`) per recipient and carry it into `deliveryRecipients[memberKey]` (`dev.ts:956-959`) -
add `app/src/routes/dev.ts` and a seam test to a task's file list; or (b) plant the fixture, then set
`delivery_recipients.<memberKey>.attemptedAt` with one `UpdateCommand` against the lane's DynamoDB Local
`hc-local-<L>-messages` table from a scratch script. Either way create an open group first (the `createGroupOpen`
sequence), and plant the row on it.

**T16-2 FIX - wrong process, wrong sink.** With `JOBS_QUEUE_URL` unset a job runs in the process that ENQUEUED it
(`app/src/index.ts:42-67`, `app/src/worker.ts:112-137`); `broadcast.send` (the send route) and `relay.fanOut`
(the `/sms` webhook) are enqueued by the APP, so every `send_reconcile` line is in the APP log - "the worker log"
(plan :2213, :2215) is wrong. `GET /__dev/logtail` is APP-only and WARN+ERROR only (`dev.ts:226-265`;
`app/src/lib/logger.ts:51`, `:115`): the `unresolved` ERROR is visible there
(`?level=error&event=send_reconcile`), the INFO `found` line is NOT. To see it, boot the lane with
`E2E_CHILD_LOG_DIR=<dir>` and read `<dir>/app.log` (`scripts/e2e-session.mjs:331-344`), or read the launcher's
forwarded stdout. Give the `found` INFO `event: 'send_reconcile'` too so both levels grep alike.

**T16-3 NOTE - scenario 1 inherits T10-1.** On an already-open page the member's row reads `Delivered` only after
a refetch; with the T10-1 emit it updates live.

**T16-4 NOTE - counting ERROR lines.** Count scenario 3's line with the `event=send_reconcile` filter. A relay
`accept_then_drop` also yields up to two `status callback for unknown provider SID after retry` ERRORs
(`twilio.ts:3408-3420`) - expected (spec D19), not a regression.

## Invariant sweep

(a) Consumers of the fake's message store: the fake-phones UI (`/control/threads` + the SSE
`message.appended` / `message.updated` events), e2e `getOutboundTo` / `listThreads`, relay-group inference
(`groups.observeOutboundLeg`, `engine.ts:448`), the Conversations emulation (listens for the reset event) and
the dispatch-error ring. None is perturbed PROVIDED Smart Encoding happens at serialization only, `reject` /
`drop_before_create` return before `recordOutboundFromApp`, and `reset()` clears the new maps. Residue:
T11-5 (a REST-fetch-backed helper consumes `fail-list`), T11-6 (an armed delivery profile survives a
reject/drop).

(b) State the reconcile job writes, and its other writers:

| state | other writers | covered? |
|---|---|---|
| attempt record | send sites (claim, finish, hand-off, takeover), cap-closes (`closeRedriven`) | yes, state + `attemptedAt` fenced; T10-14 orders the redriven enqueue-failure close |
| broadcast slot + stats | the pass, fences, cap-close, the receipt rollup | yes: the rollup matches by `tsMsgId` and reloads once after 2.5 s (`twilio.ts:3887-3907`), so a receipt between the adoption's append and its slot write lands after the slot; adoption priors `['queued']` |
| relay slot | the pass, the webhook (via pointer), the rung's closes, cap-close | T10-13 (receipt between pointer claim and slot write) |
| `sid#` row, `relaysid#` pointer | `sendMessage`; the fan-out; announcements' blind `putRelaySidPointer` | yes (append dedupes; the pointer claim reports created/mine/other) |
| inbox touch | inbound webhook, the rung's success path | T10-12 (read-then-write) |
| milestone, listing-send, audit | the pass after a send | yes, adoption writes them only when the slot moved |
| broadcast status | every `finalize` caller | yes (`finalizeStatus` conditional); T10-9 (a throw after the record close skips it) |
| live views | webhook emits only | T10-1 / T10-2 (relay emits missing / unreachable) |
