# S2 report - direct writers, inbound order fixes, tour-create events

S2_BASE: c831f78d. Commits, in order: 3ffa9abd (S2.1), bdb22011 (S2.1a),
004136ce (S2.2), f290e66d (S2.2a), 416c336f (S2.3), 48050f1c (S2.4),
e6f180da (S2.5), 8b2c326f (S2.6), b3155b5d (S2.7). Line numbers below are
at b3155b5d.

## What the tree held that the plan got wrong

- No anchor drift. Every S2.1-S2.7 old text matched verbatim and uniquely
  (the Edit tool enforces uniqueness); the plan's line hints were off only by
  the lines S1 and earlier S2 tasks added.
- C1 (PR46): W8 gates on direction alone - `app/src/routes/dev.ts:856-878`
  (`touchFixtureReachedOut`); the transcript seam's author stays 'unknown'.
- C2 (PR47): `oneToOneThreadContactId` returns undefined for relay_group /
  group_text (`app/src/lib/heardFrom.ts:103-119`); `attributeInbound` returns
  before step 3 on those types, so its behavior is unchanged
  (`heardFrom.ts:65-87`, delegation at `:94`).
- C3 (PR48): the W6 tests build a second app with `buildApp` over the same
  world (`app/test/voiceOutbound.test.ts`, `gateApp`); no harness edit.
- C4 (PR49): the three extra `tour.updated` count pins moved as planned (see
  Deliberate test changes).
- C5 (PR50) plus WL-2: FOUR exact call-shape pins gained
  `staffOutreach: true` - the plan's three in apiRoutes plus
  `app/test/groupSendRoute.test.ts:186` (WL-2, D2-1). No other whole-object
  pin on the 1:1 or Retry send input exists (re-grep of app/test).
- C6 (PR51): W1/W2 stamp at `result.providerTs`
  (`app/src/services/sendMessage.ts:770-778`).
- C7 (PR52): `UnitsRouterDeps.events?: EventBus`
  (`app/src/routes/units.ts:174`), router-scope local `eventBus` (`:603`).
- C8 (PR53): both poll cases assert at the input seam (no `staffOutreach`,
  no `systemCopy`) and on the world.
- WL-3 (D2-2): the 1f (all three), 1k and 1m cases went RED on a 500, not on
  the stamp / marker. Confirmed the cause with a throwaway probe test (written,
  run, deleted; never committed): `SendNotAttemptedError: send not attempted:
  contact read failed` from the pre-3a default send service's own real
  contacts repo. No DynamoDB seeding, spy or assertion change; all five went
  green after 3a / 3b / 3c / 3c2.
- WL-4 (E1-1): the bridged masked-call case also asserts no callee is stamped
  (`app/test/voiceWebhook.test.ts:898-901`). No-stamp row: masked relay
  member-to-member bridge (voice.ts ~1243 at main; the `vr.dial` /
  `dial.number` per callee at `:1275-1297` now): no stamp.
- Process note, no content divergence: the S2.4 test block exceeded the Bash
  tool's ~10 KB command cap as a heredoc (the shell rejected it before running;
  nothing was written), so it was appended from a scratch file with the
  plan's exact text.

## Inbound order table (PR15, spec 8)

| Path | Touch | Live event Today hears | Order before S2 | S2 action |
|---|---|---|---|---|
| 1:1 SMS inbound | routes/webhooks/twilio.ts:2695 | conversation.updated :2768 | touch first | none |
| relay member inbound | twilio.ts:961 (handleRelayInbound) | conversation.updated :1076 | touch first | none |
| closed-group inbound (sender's 1:1) | twilio.ts:1388 | conversation.updated :1421 | touch first | none |
| group text inbound | twilio.ts:2192 | conversation.updated :2225 | touch first | none |
| founder-triage inbound call | routes/webhooks/voice.ts:855 (ring) | none at ring time (message.persisted only, :830); the Dial summary's stampCallActivity (:2086) is not guaranteed - an abandoned ring has none | no event | contact.updated after a written touch (S2.6, PR81) - voice.ts:863 |
| masked relay call, refused | voice.ts:1148 | none (announceCallStamp emits message.persisted only, :1422-1427) | no event | contact.updated after a written touch (S2.6) - voice.ts:1154 |
| masked relay call, bridged | voice.ts:1249 | none | no event | contact.updated after a written touch (S2.6) - voice.ts:1255 |
| inbound email (and the unmatched re-ingest) | services/inboundEmail.ts:833 | conversation.updated :770 | emit BEFORE touch | contact.updated after a written touch (S2.6) - inboundEmail.ts:840 |
| Quo import | lib/import/apply.ts:535 | none (batch, historical) | n/a | none |
| dev fixtures | routes/dev.ts:838 | none | n/a | none (PR15) |

R-6 (WORKLIST, recorded here as worded there):
- R-6 (E1-8) On the four "touch first" inbound paths (twilio.ts 1:1, relay,
  group, closed group) the conversation.updated fires only on a fresh
  append with a successful touchLastActivity; a heard-from touch on a
  redelivery or a failed touchLastActivity has no event. Pre-existing; the
  S2 inbound-order table records it.

## WI2 - sendMessage contacts wiring

- Before (c831f78d `app/src/routes/api.ts:693-709`): `sseHeartbeatMs`
  (:693); `sendMessage = deps.sendMessageService ?? createSendMessageService({
  config, logger, conversationsRepo, messagesRepo, auditRepo, events })`
  (:694-703) with NO `contactsRepo`, so the service default-constructed
  `createContactsRepo({ logger: deps.logger })` (`sendMessage.ts:427`); then
  comments (:704-708); then `const contacts = deps.contactsRepo ??
  createContactsRepo(...)` (:709), handed to groupSend, sendEmail and every
  sub-router below.
- After (`api.ts:699-711`): `sseHeartbeatMs` (:699); `const contacts = ...`
  (:700, the SAME expression); `sendMessage = ... createSendMessageService({
  ..., contactsRepo: contacts, ... })` (:701-711). Nothing between the old and
  new positions referenced `contacts` (comments only), so every other
  consumer gets the same repo object as before. Production: one fewer client
  object. Tests: the default send service now reads an injected
  `deps.contactsRepo` (the harness passes `world.contactsRepo`).
- PR84 list, re-verified on the tree (harness suites that reach the /api
  router's DEFAULT 1:1 send service, i.e. no injected sendMessageService):
  `apiRoutes.test.ts` - the R6 case (~:1439, refused 409 before the send) and
  the 1f describe (:1730); `tourRemindersApi.test.ts` - the 1k case only
  (~:1766; every other send-now POST's harness injects makeSendSpy);
  `placementNudgesApi.test.ts` - the 1m case only (~:703). Not on that path:
  rateLimit, groupSendRoute, retrySendAttempt routeApp (injected services);
  relayApi, relayQueuedMessages (relay_group threads take the relay branch);
  broadcastFanOut, missedCallAutoText, retrySendAttempt jobs, publicIntake
  (their own services over the world fakes). Grep candidates that post no
  send route: broadcastApi, contactTimeline, conversationHubApi (GET only),
  retrySendBackoff, twilioStatusWebhook.
- Red-case rule: no case went red on a consent / opt-out / deleted refusal;
  no consent was seeded. The harness comment
  (`app/test/helpers/twilioWebhookHarness.ts:5645-5654`) now describes what
  the default service reads.

## W2 Retry gate (PR104, replacing PR91)

W2 stamps only when `original.broadcast_id === undefined &&
original.automated !== true && original.system_copy !== true`
(api.ts:1913-1915); the Retry passes `systemCopy: true` when the retried row
is automated or system copy (api.ts:1906-1908); `forceSendReminder`
(tourReminders.ts:2008) and `forceSendNudge` (placementNudges.ts:864) pass
`systemCopy: true`; the repo writes `system_copy` only when true
(messagesRepo.ts:2655; NewMessage.systemCopy :777, MessageItem.system_copy
:1090).
- PR91's residue (a staff Retry of a reminder / nudge Send-now row stamps):
  closed by PR104.
- PR100's residue (a second staff Retry of a failed automated text stamps):
  closed by PR104 (a Retry of a Retry inherits the marker).
- [PR107] The marker also survives the machine resends of a chain: the
  automatic 30003 retry (retrySend.ts:567) and the reconcile's retry
  adoption (sendReconcile.ts:947) carry it beside `automated`; the
  end-to-end case (Send-now row -> automatic retry -> staff Retry of the
  newest row) stamps nothing (retrySendAttempt.test.ts:1570).
- [PR106] The harness messages fake maps `systemCopy` true-only like the
  real repo (twilioWebhookHarness.ts:1330, pinned by
  twilioWebhookHarnessRetryFields.test.ts); the harness Retry and Send-now
  cases assert the marker on the rows the routes wrote.
- PR108 (accepted residue, plan section 4): a failed Send-now row, or a
  manual Retry of an automated text, written BEFORE the deploy carries no
  `system_copy`, so a staff Retry of it after the deploy stamps (W2 judges
  the pressed row). Rare and ages out of Quiet shares within 14 days.
- R-1 (WORKLIST, recorded here as worded there):
  - R-1 (E1-2) W2 gate keeps `original.automated !== true` (matches spec 7.5's
    backfill "automated not true"). Residue, recorded beside PR108 in the S2
    report: a failed automated row written before retry-send-window
    (2026-09-24) carries no `automated` field, so a staff Retry of it after
    this deploy stamps, and so does a Retry of that Retry. Rare (Retry only on
    failed chain-newest rows; every such row predates 2026-09-24) and ages out
    of Quiet shares in 14 days.

## WI3 - the whisper-gate no-await rule

Line-by-line read of the outbound accept branch at b3155b5d
(`app/src/routes/webhooks/voice.ts:1733-1800`):
- `:1737` `const dialAt = new Date().toISOString();` - the ONLY new line
  before the press-1 stamp; synchronous.
- `:1741-1744` the unchanged `await messages.updateCallStatus(parentCallSid,
  { callStatus: 'in-progress', answeredAt: dialAt })` - the press-1 stamp
  point (`answeredAt: dialAt` replaces the inline `new Date()`).
- `:1745-1793` (announceCallStamp, vr.dial, dial.number, log.info): no added
  line. Nothing new is awaited or read between the press-1 stamp and
  `sendTwiml`.
- `:1794` `sendTwiml(res, vr);` then `:1799`
  `afterResponse(stampOutboundDial({ contacts, log, events }, target.contactId, dialAt));`
  - one synchronous call that starts the promise, not awaited - then
  `return;`.
- Mechanical half (PR87): "PR87: the work reaches afterResponse only once the
  TwiML is sent ..." is green with `handOffSawFinished` = [true] and
  `touchSawFinished` = [true]; "the response does not wait for the stamp"
  answers the `<Dial>` with the touch parked. Refusal branches (unresolved
  target, voice opt-out, timeout), the inbound-leg press-1 and originate
  stamp nothing (5 PIN cases).

## WI4 - events per send operation (counted, not just present)

| Writer | Test | Events after the stamp |
|---|---|---|
| W1 staff text | sendMessage.test.ts (order pinned exactly: message.persisted, conversation.updated, contact.updated); apiRoutes.test.ts harness case | 1 contact.updated, after conversation.updated |
| W1 multi-batch MMS | apiRoutes.test.ts harness case | 1 contact.updated for N > 1 batches (one touch, at the first batch's providerTs) |
| W2 staff Retry | apiRoutes.test.ts harness case | 1 (plain); 0 (share text); 0 (automated row); 0 (system-copy row, PR104) |
| W3 email | sendEmailMessage.test.ts | 1 contact.updated, the last event (names.at(-1)); 0 on adapter throw, skipped, failed or rejecting stamp |
| W6 outbound press-1 | voiceOutbound.test.ts | 1 contact.updated; 0 on refusals, inbound leg, no-contact number, throwing stamp |
| W8 dev fixtures | devTranscriptFixture / devMessageTransportFixture | 1 contact.updated on appEvents; 0 on a failed / skipped stamp, inbound, relay thread |
| inbound email (PR15) | inboundEmail.test.ts | 1 contact.updated per written touch, after conversation.updated; 0 skipped / failed / deduped |
| masked calls (PR15) | voiceWebhook.test.ts | refused 1; bridged 1, then 0 on the skipped redelivery; unmatched caller 0 |
| founder-triage call (PR81) | founderTriage.test.ts | 1 per written touch; 0 on the skipped redelivery |
| tour create (PR16) | toursApi / listingSendOutcomeApi | 1 tour.updated per create (scheduled and requested POST, Interested create); 0 on a refused create, an Interested that finds a tour, Not interested, Undo |

All counts read from the green runs listed under Gate results.

## Deliberate test changes (never weakened)

- apiRoutes.test.ts:85 (was :84), :735 (was ~:709-719), :890 (was
  ~:860-870) - `staffOutreach: true` added (C5, PR50).
- groupSendRoute.test.ts:186 (was :185) - `staffOutreach: true` added
  (WL-2, D2-1), with a one-line ASCII comment citing W1 / PR10.
- toursApi.test.ts:1399-1406 - INVERTED: create now emits (PR16); exact
  payload pinned.
- toursApi.test.ts:1418-1420 (reschedule 1 -> 2), :585-589 (concurrent
  change: 0 -> exactly the create's payload); toursReopenApi.test.ts:492-493
  (1 -> 2) - counts include the create's emit (C4, PR49).
- sendReconcile.test.ts:3155 - case 10's absent-field list gains
  'system_copy' (stricter, PR107).
- tourRemindersApi / placementNudgesApi "200s with the re-read sent view"
  cases gain `systemCopy === true` and no-`staffOutreach` assertions
  (additive, PR104 1n).
- sendMessage.test.ts - S1's throwing `touchLastReachedOut` stub replaced by
  a recording fake (PR7 exception, plan 1d); a `contact.updated` listener
  added to the fake bus.
- Consent seeded under the S2.2 red-case rule: none [PR84].

## Gate results

- `npm run typecheck` (bare, root): exit 0 after every task commit (S2.1,
  S2.1a, S2.2, S2.2a, S2.3, S2.4, S2.5, S2.6, S2.7) and at S2.8.
- App workspace once (`cd app; npx vitest run`, redirected to a log, hard
  outer timeout): exit 0; Test Files 531 passed (531); Tests 11271 passed |
  1 skipped (11272); duration 123.67s. No red file, so no re-run. No
  `[dynamoAdmin]` line (the only matches are the `dynamoAdminRetry.test.ts`
  file name). AWS_* variables: none exported.
- eslint on the slice's 38 changed .ts files (`git diff --name-only
  --diff-filter=d c831f78d..HEAD`): exit 0, no output. No baseline needed.
- ASCII: `git diff -U0 c831f78d..HEAD | grep '^+' | tr ...` = 0. No `\u`
  escape added in any touched file.
- WI9: no seed file in `git diff --stat c831f78d..HEAD` (lib/seed,
  performanceSeed.ts, db-seed.ts, seedData.ts and lib/events.ts all
  unchanged). The only `twilioWebhookHarness.ts` hunks are S2.1a's
  `system_copy` mapping line plus comment (:1329-1330) and S2.2's comment
  rewrite (:5647-5653).

## Risks and follow-ups

- R-2 (WORKLIST, recorded here as worded there):
  - R-2 (E1-4) W6 stamps the contact `findByPhone` resolves for the target
    phone (first match on a duplicated number - findByPhone's documented
    risk, the same ambiguity W1 has). Not changed: writing
    recipient_contact_id on call rows would change how call rows attribute
    on shared threads, outside this spec. S2 report.
- Q-1 (WORKLIST, open for Cameron): W3 stamps only the To contact
  (`sendEmailMessage.ts:489`); a CC'd contact is not stamped. Built as
  specced.
- `app/test/emailEvents.test.ts:351` builds the real email send service over
  a casted contacts fake with no `touchLastReachedOut`; under W3 the stamp
  throws inside `recordStaffOutreach`, which answers 'failed' and writes one
  ERROR `{ contactId }` line to that test's log. The test stays green and the
  best-effort rule holds; the fake was not edited (outside the plan's list).
- The production `afterResponse` default (`voice.ts:396-405`) only guards a
  rejection; `stampOutboundDial` (`:1366-1384`) never rejects
  (`recordStaffOutreach` never throws; the emit is in its own try).
- The harness comment at `twilioWebhookHarness.ts:5645-5654` was rewritten
  in S2.2 (PR84) and matches what the default send service now reads
  (`world.contactsRepo`).

## S2 contract later slices rely on

- `SendMessageInput.staffOutreach?: true` (`sendMessage.ts:409`) and
  `SendMessageInput.systemCopy?: true` (`:416`, persisted at `:708`).
- `NewMessage.systemCopy?: boolean` (`messagesRepo.ts:777`) ->
  `MessageItem.system_copy?: boolean` (`:1090`), true-only append mapping
  (`:2655`); harness twin (`twilioWebhookHarness.ts:1330`). S6 reads
  `system_copy`.
- `TwilioVoiceWebhookDeps.afterResponse?: (work: Promise<void>) => void`
  (`voice.ts:362`, default `:396`), reachable through
  `buildApp({ webhooks: { afterResponse } })`; `resolveOutboundTarget`
  returns `contactId?` (`:1339`, `:1354`); local `stampOutboundDial`
  (`:1366`).
- `UnitsRouterDeps.events?: EventBus` (`units.ts:174`), passed from
  `api.ts:1034`.
- New export `oneToOneThreadContactId(thread, lookup)` (`heardFrom.ts:103`).
- `DevRouterDeps.heardFromRepos.contactsRepo` Pick gains
  `'touchLastReachedOut'` (`dev.ts:162`).
- `api.ts:700` - the router's `contacts` is built before the send service
  (S4 PR24 anchors on current api.ts text).
