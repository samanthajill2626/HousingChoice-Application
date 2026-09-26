# Planner review - spec conformance - feat/retry-send-window

Independent spec-conformance review for the planner (not the builder).
Read-only. Written 2026-09-26.

- Branch `feat/retry-send-window` at `56085389` in `W:\tmp\retry-send-window`,
  0 behind `main` @ `da04d0cb`. The code is identical to the gated commit
  `168585b2`: `git diff --name-only 168585b2..HEAD` lists only
  `build-handback.md` and `build-selfqa.md` in this folder.
- Authority: `docs/superpowers/specs/2026-09-24-retry-send-window-design.md`
  (draft 7.3). The plan (`docs/superpowers/plans/2026-09-25-retry-send-window.md`)
  was used only as a work map.
- All line citations are at HEAD `56085389` unless marked `main:`.

## Verdict

**CONFORMS.** Every item below is DELIVERED. The code implements each one, and
a test that asserts the actual mechanism pins it. Nothing is PARTIAL, MISSING
or DEVIATES. Findings: 0 BLOCKING, 0 HIGH, 0 MEDIUM, 3 LOW. None of the three
is a deviation from the spec as written: one is a gap in the spec's own
residual list, one is a surface outside the spec's scope, and one is a
sub-millisecond boundary nuance.

## Method

- I read the spec in full, every changed production file at HEAD, and its diff
  against `main`. For every new or changed test I checked the assertions
  against what the test claims to prove. Non-vacuity guards I confirmed:
  - the harness `append` allowlist pin (`app/test/twilioWebhookHarnessRetryFields.test.ts`);
  - spies proving that no second write follows a claim-time decline;
  - exact-literal slot equality between a claim-declined rung and a
    job-declined rung;
  - `toHaveProperty('automated', false)`, which fails if the flag is absent;
  - the "every code covered" floor on the refusal table;
  - the 30007 positive control in the e2e.
- I ran dashboard vitest only (no DynamoDB):
  - `src/routes/contact/Timeline.ticker.test.tsx`: 40/40 passed.
  - `src/routes/contact/Timeline.delivery.test.tsx`, `retryPromiseMirror.test.ts`
    and `relayWindowCloseMirror.test.ts`: 51/51 passed. Deviation from the
    brief: these three ran in ONE vitest invocation, not one at a time. No
    DynamoDB was involved.
- I did NOT run app vitest or e2e (brief). Those results are **log-verified
  from the builder's gate logs** (`.superpowers/gates/`), not re-run by me
  (UNVERIFIED by re-run):
  - `final-npm-test.exit` is `EXIT=0`: app 375/375 files, dashboard 195/195,
    e2e-unit 21, fake-twilio 34, fake-twilio-web 13, and 0 `[dynamoAdmin]` lines.
  - `final-e2e.exit` is `EXIT=0`: "279 passed (19.2m)", including
    `one-to-one-30003-retry.spec.ts:147` (ok 113),
    `relay-30003-retry.spec.ts:135` (ok 146) and `share-skip-fix.spec.ts`
    (ok 165, 166, 167).
  - `final-eslint.log` has exactly one error, pre-existing:
    `Timeline.tsx:1577` `react-hooks/set-state-in-effect`.
- ASCII: I checked the added lines of every added or modified file in
  `git diff main...HEAD` with `tr -d '\11\12\15\40-\176'`. Result: 0
  non-ASCII bytes in any file.

## Per-item table

### Section 1 - the invariant and its named exceptions

| item | verdict | evidence |
| --- | --- | --- |
| No automatic 30003 retry goes out more than 15 minutes after the original | DELIVERED | Scheduling, with the 60 s grace: relay claim `app/src/routes/webhooks/twilio.ts:2858-2881`; one-to-one decision `app/src/services/oneToOneRetryDecision.ts:123-132`; relay transient re-enqueue `app/src/jobs/relayRetryLeg.ts:719-743`. At send time, strict: relay job gate `relayRetryLeg.ts:586-606`; bounded acquire `app/src/jobs/relayFanOut.ts:1387-1405` fed by `relayRetryLeg.ts:653`, closed at `:674-692`; one-to-one job `app/src/jobs/retrySend.ts:236-254`, after the marker at `:209-226`. |
| The screen shows the decision WITH the failure; one write for one-to-one | DELIVERED | Decided before the write (`twilio.ts:3434-3443`). The stamp rides the one conditional update (`twilio.ts:3444-3449` -> `app/src/repos/messagesRepo.ts:2641-2665`, `SET ... retry_due_at = :r` under the forward-only condition). The emit comes after (`twilio.ts:3490-3499`). Test `app/test/twilioStatusWebhook.test.ts:437`: exactly one status write carries `{ retryDueAt }`, 0 annotates, and the one emit already sees status + stamp. |
| Relay leg: the claim decides at once; its SSE follows the rung write | DELIVERED | `twilio.ts:2841-2916` (open or closed slot), append `:2939-2941`, SSE after the append `:3002-3013`, `:3079`. Test `app/test/relayRetryClaim.webhook.test.ts:1282`: the append carried the closed slot; 0 root emits at the append, 1 after. |
| The one-to-one promise ends within `RETRY_PROMISE_GRACE_MS` + one tick after due, on the server's clock | DELIVERED | `dashboard/src/routes/contact/retryPromise.ts:16,26-31`. `dashboard/src/routes/contact/Timeline.tsx:791-795` (one predicate); the bubble at `:1041`, the ticker at `:919`, one server-clock snapshot at `:2200-2208`, interval at `:2209-2231`. Tests `dashboard/src/routes/contact/Timeline.ticker.test.tsx:999` and `:1043` (run by me: pass). |
| Exception: no usable origin is not windowed (D5) | DELIVERED | Claim `twilio.ts:2865-2868` + WARN after create `:2976-2990`. Job `relayRetryLeg.ts:586-591`, with no deadline at `:653`. One-to-one `oneToOneRetryDecision.ts:129-133`, `retrySend.ts:236-242`. Tests `relayRetryClaim.webhook.test.ts:1171,1202`; `app/test/relayRetryLeg.test.ts:613,1276`; `twilioStatusWebhook.test.ts:757,1664`. |
| Exception: a pending-reconcile promise stays up (section 5 req 3) | DELIVERED (relay) | A requirement on SOR, not code here. Carried as item 3 of "What SOR must carry" in `build-handback.md`. |
| Exception: a relay claim fault shows the plain failure until redelivery | DELIVERED | Preview reads sit inside the claim; a throw becomes `claim_failed` (`twilio.ts:3177-3179`). Test `relayRetryClaim.webhook.test.ts:1370`: 500, no rung, one ERROR, and the redelivery claims. |
| Exception: the relay slot is written before the claim decides | DELIVERED (accepted) | Post-write consistent read `twilio.ts:2738`, then preview reads `:2841-2849`. No code was expected. |

### Section 3 - decisions

| item | verdict | evidence |
| --- | --- | --- |
| D1 window = 15 min | DELIVERED | `app/src/lib/retrySendWindow.ts:15`. Grace 60 s `:22`, promise grace 2 min `:29`. Pinned by `app/test/retrySendWindow.test.ts:23-31`. |
| D2 one-to-one origin: `provider_ts`, carried as `retry_window_start` on every automatic retry row | DELIVERED | `retrySendWindow.ts:65-70` (`retry_window_start ?? provider_ts`, raw) -> `retrySend.ts:236,326` -> `app/src/services/sendMessage.ts:492` -> `messagesRepo.ts:2343-2345`. Tests `twilioStatusWebhook.test.ts:1640,1855`; the e2e spec's assert 6 (`retry_window_start == original.provider_ts`). |
| D2 relay origin: the slot's `sentAt`, carried as `relay_retry_window_start`, never re-derived | DELIVERED | `twilio.ts:2858-2860` (the root leg reads `slot.sentAt`, rungs 2-3 copy the carried value), `:2957-2961`; `messagesRepo.ts:2372-2376`; job `relayRetryLeg.ts:325`. Tests `relayRetryClaim.webhook.test.ts:865,993,1139,1171`. |
| D2 a manual Retry never copies the origin | DELIVERED | `app/src/routes/api.ts:1671-1684` sends no `retryWindowStart` and no `retryAttempt`. `app/test/apiRoutes.test.ts:531` pins this with exact `toEqual`. |
| D3 step 1: gate preview through the job's own evaluator, in the job's order | DELIVERED | `app/src/lib/relayRetryGates.ts:41-73`. Claim `twilio.ts:2841-2849`; job `relayRetryLeg.ts:532-558`. The same `isMemberSuppressed` (`services/relayAnnouncements.js`, imported at `twilio.ts:85` and `relayRetryLeg.ts:62`). Tests `app/test/relayRetryGates.test.ts`; `relayRetryClaim.webhook.test.ts:926,956`. |
| D3 the job's pool-number check follows the four gates | DELIVERED | `relayRetryLeg.ts:559-568`. Tests `relayRetryLeg.test.ts:444,466,584`. |
| D3 a declined rung is APPENDED closed in the claim's one append (refuseGate shape), nothing enqueued, `gate_refused` WARN | DELIVERED | `twilio.ts:2882-2916,2939-2941,3002-3013`; WARN set `twilio.ts:468-481` (`:479`). Tests `relayRetryClaim.webhook.test.ts:926,1026`; `:1227` (field-by-field equality with a job-refused rung, versioned and legacy); `:1282` (no second write). |
| D3 step 2: a window decline is appended closed `retry_window_closed`, outcome `window_closed`, ERROR | DELIVERED | `twilio.ts:2869-2881,3011`. Test `relayRetryClaim.webhook.test.ts:1071`: exactly one ERROR, 0 WARN failure lines, no enqueue, and the three refusal writers are never called. Also `:1139`. |
| D3 step 3: otherwise open and enqueued, as today | DELIVERED | `twilio.ts:2894-2904,3017-3024`; test `:865`. |
| D3 a duplicate callback -> `already_claimed` via the SID dedupe; never changes a rung | DELIVERED | `twilio.ts:2972-2974`; tests `:1329` (open rung) and `:1350` (closed rung). |
| D3 a failed preview read = `claim_failed`; the root slot is untouched; the job re-runs the gates | DELIVERED | Test `:1370`. `slotOf(root)` is asserted in `:865,926,1026,1071`. Job gates run at send time: `relayRetryLeg.ts:532`. |
| D3 `closeRetryLegEnqueueFailed` unchanged and still the claim's only close | DELIVERED | `twilio.ts:663` onward; no diff hunk touches it (hunk list checked). |
| D3a order: group_text -> send-path refusals -> cap -> window -> retry | DELIVERED | `oneToOneRetryDecision.ts:86-140`. It adds `conversation_missing` (WARN, per D9) and `not_one_to_one` (the send path's channel guard) ahead of the refusals. Tests `app/test/oneToOneRetryDecision.test.ts:198,215,285`. |
| D3a step 2: the send path's predicates in its order, and ONE table drives the preview, parity and decision tests | DELIVERED | `app/src/services/sendRefusalPreview.ts:42-71` against `sendMessage.ts:334-409`. Kill switch; opt-out across conversation / phone contact / recipient; `isDeleted` on recipient ?? phone contact; JIT consent for a person's send; manual mode for an automated send. Table `app/test/helpers/sendRefusalCases.ts:68-173`. Parity through the REAL wrapper `app/test/sendMessage.test.ts:936-971`; decision `oneToOneRetryDecision.test.ts:368-384`; coverage floor `app/test/sendRefusalPreview.test.ts:35`. |
| D3a cap ERROR as today; window ERROR | DELIVERED | `oneToOneRetryDecision.ts:123-132`. Arm `twilio.ts:3557-3565` (the pre-existing exhausted line) and `:3566-3582`. Test `twilioStatusWebhook.test.ts:664` (DECLINES rows `window_closed` and `cap_exhausted`: ERROR, no stamp, no enqueue). |
| D3a logs and the enqueue happen only on the transition | DELIVERED | `twilio.ts:3542,3555`. Tests `:505` (redelivery), `:808` (Review Focus 1), `:834` (Review Focus 2). |
| D3a failure semantics: a failed read or missing origin fails OPEN and is shown | DELIVERED | `oneToOneRetryDecision.ts:78-121,133`; arm WARNs `twilio.ts:3593-3603`. Tests `oneToOneRetryDecision.test.ts:296,310,331`; `twilioStatusWebhook.test.ts:735,757`. |
| D4 relay job: the window is the LAST gate, strict, closed via `refuseGate` | DELIVERED | `relayRetryLeg.ts:586-606`. Tests `relayRetryLeg.test.ts:359-407` (gate-table row: ERROR, one root SSE, no send), `:548,567,584`. |
| D4 bounded acquire: a distinct outcome before the `attempted` write, closed via `refuseGate`, never transient, never left `queued`; the fan-out stays unbounded | DELIVERED | `relayFanOut.ts:1234-1242,1325,1387-1405`; `relayRetryLeg.ts:653,674-692`. Tests `relayRetryLeg.test.ts:1215` (versioned and legacy: no `attempted` write, no `claimFanoutPass`, closed slot, ERROR, one SSE), `:1258,1276`; `app/test/relayFanOut.test.ts:2354`. |
| D4 the transient re-enqueue re-checks with the scheduling rule | DELIVERED | `relayRetryLeg.ts:719-743`. Tests `relayRetryLeg.test.ts:635,663`. |
| D4 one-to-one job: strict check before `sendMessage`; ends the chain | DELIVERED | `retrySend.ts:236-254`. Tests `twilioStatusWebhook.test.ts:1581`; `:1613` (exact and strict boundary, injected clock); `:1640`. |
| D5 missing origin fails open; the relay field is OPTIONAL in the lineage check | DELIVERED | `relayRetryLeg.ts:285-299` (`windowStart` sits outside the `missing` list at `:307`), `:325`. See the section 1 row. |
| D6 lineage written at append; nothing annotated afterwards | DELIVERED | Inputs `sendMessage.ts:238-262`; append `sendMessage.ts:486-497` -> `messagesRepo.ts:2338-2352`; job `retrySend.ts:316-327`. The annotate-lineage path is removed (`messagesRepo.ts:1228-1240,3010-3019`). Tests `sendMessage.test.ts:1007,1029`; `twilioStatusWebhook.test.ts:1855` (annotates == 0); `app/test/messaging.integration.test.ts:213`. |
| D7 the stamp in the same conditional write; enqueue after; a failed enqueue is withdrawn (`annotateMessage` + emit); projection and type | DELIVERED | `messagesRepo.ts:1324-1335,2633-2680`; `twilio.ts:3444-3449,3604-3638`; `app/src/routes/contactTimeline.ts:180,452`; `dashboard/src/api/types.ts:2508`. Tests `twilioStatusWebhook.test.ts:437,777`; `messaging.integration.test.ts:255,313`; `app/test/contactTimeline.test.ts:367`. |
| D8 rule: a 30003 promises only while `retry_due_at` is live, never from the count | DELIVERED | `Timeline.tsx:791-795,1041,1055-1057`. Tests `Timeline.delivery.test.tsx:595,610,622`. |
| D8 reason API: `retryScheduled` checked ahead of media and base; `relay` wins; tail appended | DELIVERED | `dashboard/src/routes/contact/deliveryStatus.ts:836-838,889,1033-1042`. Tests `deliveryStatus.test.ts:743,753,764,817`. |
| D8 the relay map stays; the one-to-one chip never passes `relay` | DELIVERED | `deliveryStatus.ts:864-866`; `Timeline.tsx:1056` (only `media` + `retryScheduled`). Test `Timeline.delivery.test.tsx:595` renders with the DEFAULT `rosterKind`. |
| D8 base wording on legs, rollups, rows, declined/exhausted/manual bubbles | DELIVERED | `deliveryStatus.ts:782`. Tests `deliveryStatus.test.ts:421,743`; `Timeline.delivery.test.tsx:511,610`; `Timeline.email.test.tsx:95`. |
| D8 server-clock estimate from the `Date` header on every response | DELIVERED | `dashboard/src/api/client.ts:125`; `dashboard/src/api/serverClock.ts:38-49`. Tests `dashboard/src/api/serverClock.test.ts:26-95` and `:96` onward (ok, refused, before the body is parsed, missing header). |
| D8 the ticker arms on the same clock; expiry without reload within one tick | DELIVERED | `Timeline.tsx:919,2200-2231`. Tests `Timeline.ticker.test.tsx:999,1043`, plus silent cases for no stamp / expired / withdrawn. |
| D8 share results row: under-promises on this branch | DELIVERED | `dashboard/src/routes/broadcasts/broadcastFormat.ts` and `DeliveryBadge.tsx` unchanged. Tests `StatChips.test.tsx:135`, `broadcastFormat.test.ts:160`. |
| D8 new and touched copy is ASCII | DELIVERED | `deliveryStatus.test.ts:788`; the tr check above. |
| D8 relay: a window decline carries no display code; gate declines keep their copy; fallback entry exists | DELIVERED | `dashboard/src/routes/contact/relayRetryJoin.ts:104,420-429`; `deliveryStatus.ts:945-957`. Tests `relayRetryJoin.test.ts:217,240`; `Timeline.delivery.test.tsx:1056,1092`; `deliveryStatus.test.ts:1715`; `relayWindowCloseMirror.test.ts` (run: pass). |
| D9 log levels | DELIVERED | ERROR: relay claim `window_closed` is not in the WARN set (`twilio.ts:468-481`; test `:1071` counts exactly one ERROR); relay job `relayRetryLeg.ts:596-605,682-690,731-741`; one-to-one arm `twilio.ts:3566-3582` (level from the decision); job `retrySend.ts:243-253`. WARN: D3a skips, `conversation_missing`, `gate_refused`, `already_claimed`, origin gaps, failed reads. A failed enqueue keeps the arm-catch ERROR (`twilio.ts:3802-3806`; test `:777`). The one-to-one marker and `isTerminalDeliveryFailure` values are unchanged (`twilio.ts:3478-3488`). |
| D10 Retry hidden; 409 `retry_pending` after `not_failed`; mapped copy; grace mirrored and pinned; nothing else | DELIVERED | `Timeline.tsx:1423`; `api.ts:1591-1608`; `Timeline.tsx:134-135`; `retryPromise.ts:16` + `retryPromiseMirror.test.ts` (run: pass). Tests `apiRoutes.test.ts:482,499,515`; `Timeline.test.tsx:931`. No reverse guard in `retrySend.ts`. |
| D11 native group text: no retry scheduled; carve-out tests INVERTED, not deleted | DELIVERED | `oneToOneRetryDecision.ts:90-92`. The fail-open backstop `sendMessage.ts:346-348` is unchanged. Inversions: `deliveryStatus.test.ts:421` (was `main:419`) and `:743` (was `main:738`); `Timeline.delivery.test.tsx:511` (was `main:516`); the `main:577` message-chip test became `:595/:610`. Webhook `twilioStatusWebhook.test.ts:2183`. |
| D12 comments that lied are corrected | DELIVERED | `deliveryStatus.ts:840-866` (relay map), `:868-890` (options doc), `:1013-1032` (order). `twilio.ts:324-357` (carve-out), `:3694`, `:3754` (group-text arms). `Timeline.tsx:1042-1054` (chip), `:1349-1354` (legs). D6 comments: `sendMessage.ts:207-262`, `messagesRepo.ts:725-768,2336-2341`, `retrySend.ts:9-14` (the post-send annotate block is gone). Test/doc comments: `deliveryStatus.test.ts`, `Timeline.delivery.test.tsx`, `StatChips.test.tsx`, `e2e/tests/dashboard-next/relay-30003-retry.spec.ts:18-27`, `e2e/support/selectors.md:49`. |
| D13 clock seams and exact boundaries; wall-clock tests keep >= 30 s margins | DELIVERED | Helpers `retrySendWindow.test.ts:113-160`; decision (`nowMs`) `oneToOneRetryDecision.test.ts:262`; job (`now` dep) `twilioStatusWebhook.test.ts:1613`. Relay tests use `minutesAgo(1 / 12.5 / 14 / 14.5 / 16)`; each boundary has >= 30 s of margin. |
| D13 lane seam `E2E_SEND_RETRY_BACKOFF_MS`, honored only without `JOBS_QUEUE_URL`, set in the lane `childEnv` | DELIVERED | `retrySend.ts:92-117`; `scripts/e2e-session.mjs:273-282`. Tests `app/test/retrySendBackoff.test.ts:67-111` (incl. the production-topology ignore at `:81`, and the arm on the seam at `:111`). |
| D13 e2e texts `conv-0001`, never `conv-0002` | DELIVERED | `e2e/tests/dashboard-next/one-to-one-30003-retry.spec.ts:65-69`. |
| D13 `E2E_RETRY_SEND_WINDOW_MS` (conditional) | DELIVERED (n/a) | Conditional ("If an e2e needs a short window"). None does; not built. |
| D13 fixtures moved / new relay fixtures carry `sentAt` | DELIVERED | `twilioStatusWebhook.test.ts:55-73` (realistic `provider_ts`), `:2200`. The old relay fixtures have no `sentAt` and pass D5 unchanged; the new window tests seed `sentAt` (`relayRetryClaim.webhook.test.ts:865` onward). |
| D14 `sendMessage` records `automated` (false included) on every append, and `recipient_contact_id` when named | DELIVERED | `sendMessage.ts:315,496-497`; `messagesRepo.ts:2349-2352`. Tests `sendMessage.test.ts:981,993`. |
| D14 the retry follows the original's flag and recipient; pre-deploy row = automated; a missing recipient -> phone + WARN; the read comes BEFORE the marker | DELIVERED | `retrySend.ts:189-200` (before the marker at `:209-226`), `:321-323`. Decision `oneToOneRetryDecision.ts:100-118`. Tests `twilioStatusWebhook.test.ts:1690,1719,1748,1781` (no manual_mode refusal, 0 breaker counts, `automated:false` audit), `:1825`, `:686,707`. |
| D14 the manual Retry passes the recorded recipient and stays `automated:false` | DELIVERED | `api.ts:1609-1622,1677,1683`. Tests `apiRoutes.test.ts:531,574`. |

### Section 4 - every surface

| surface | verdict | evidence |
| --- | --- | --- |
| Writers of automatic retries | DELIVERED | Relay claim/enqueue including the closed append (`twilio.ts:2841-3024`). Relay send and transient re-enqueue plus the bounded acquire (`relayRetryLeg.ts:626-761`, `relayFanOut.ts:1387-1405`). One-to-one enqueue (`twilio.ts:3604-3615`, `retrySend.ts:127-129`, the explicit `runAt`). One-to-one send and lineage (`retrySend.ts:316-327` -> `sendMessage.ts:486-497` -> `messagesRepo.ts:2338-2352`). Handler registration (`app/src/jobs/registerHandlers.ts:45-58`) is unchanged and needs no change: the new deps build lazily (`retrySend.ts:192`). Lane overrides as above. The manual route: see D10/D14. |
| Where the checks and reads land | DELIVERED | Claim preview `twilio.ts:2841-2881`; job gates `relayRetryLeg.ts:532-606`; the one-to-one decision before the status write `twilio.ts:3434-3449`, sharing the send path's predicates (`sendRefusalPreview.ts:22-25`); the arm's enqueue after (`:3604`). Job reads of the original and the recipient come before the marker (`retrySend.ts:174-200`). |
| Readers of retry lineage | DELIVERED | Changed only where required: `readRetryLineage` (`relayRetryLeg.ts:285-326`), annotate (`messagesRepo.ts:3010-3019`), projection (`contactTimeline.ts:452`), the join's terminal step (`relayRetryJoin.ts:420-429`). Watch items confirmed unchanged: `twilio.ts` escalation gate on `relay_retry_of` (`:3305-3309`); `useRelayThread` (drops the new fields; harmless); the Timeline `retry_of` supersession. |
| The promise's clock | DELIVERED | The `Date` route (`client.ts:125`); the chip reason and the Retry gate read the thread's server-clock snapshot (`Timeline.tsx:1041,1056,1423`), NOT the browser-based `bubbleNowMs` (`Timeline.tsx:767-773`), which would violate D8; the ticker arming (`:919,2200-2208`). |
| Readers of the 30003 copy | DELIVERED | Only `Timeline.tsx:1056` passes `retryScheduled`. Every other `deliveryReason` caller reads plain: `broadcastFormat.ts:158`, `deliveryStatus.ts:469,732,762`, `Timeline.tsx:622,1365,1727` (EmailCard). Tests listed under D8/D11. |
| Vocabulary | DELIVERED | `RelayRetryCloseCode` gains the code (`relayRetryLeg.ts:109-113`) and the gate table gains a row (`relayRetryLeg.test.ts:359`). The claim-outcome union's exhaustive test goes 13 -> 14 (`app/test/relayRetryClaim.test.ts:51`). The WARN set gains `gate_refused` (`twilio.ts:479`). The internal-code copy test gains the fallback (`deliveryStatus.test.ts:1715`). `selectors.md:49-50` documents the prose family. |
| Repository and test doubles | DELIVERED | `updateDeliveryStatus` option (`messagesRepo.ts:1324-1335,2641-2665`); other callers unchanged (`emailEvents.ts:177,182`, `groupReceipts.ts:354`, `relayQueuedMessages.ts:89`, `sendEmailMessage.ts:477,510`). Harness twins `app/test/helpers/twilioWebhookHarness.ts:1130-1171` (append allowlist), `:1232-1242` (status), `:1365-1366` (annotate), pinned by `twilioWebhookHarnessRetryFields.test.ts`. |
| Seeds and dev seams | DELIVERED | No seed or dev-route file changed. `app/src/lib/seed` has no retry-field or `createSendMessageService` writes (grep). |

### Section 6 - test intentions

| intention | verdict | evidence |
| --- | --- | --- |
| 1 window helpers | DELIVERED | `retrySendWindow.test.ts:113-128` (grace, exact +/- 1 ms), `:150-158` (strict at exactly 15 min), `:33-67` (unparseable -> undefined). |
| 2 relay claim | DELIVERED | `relayRetryClaim.webhook.test.ts:926` (4 gates, rung 1), `:993` (rungs 2-3), `:1026` (team send), `:956` (two gates), `:976` (gate before window), `:1071` (window), `:1227` (same data as the job), `:1329/:1350` (duplicates), `:1370` (read failure), `:865` (claims as today), `:1139` (carried origin). Dashboard copy at once: `Timeline.delivery.test.tsx:1092` (fresh rung). |
| 3 relay job | DELIVERED | `relayRetryLeg.test.ts:359-407` (ERROR, one root SSE, no send), `Timeline.delivery.test.tsx:1056` (join renders the plain 30003), `relayRetryLeg.test.ts:1215` (bounded acquire), `:635` (transient past the window), `:613` (pre-deploy rung, WARN), `relayFanOut.test.ts:2354` (fan-out unbounded). |
| 4 one-to-one status path | DELIVERED | `twilioStatusWebhook.test.ts:437,505`; `:664` DECLINES (conversation_missing, not_one_to_one, kill switch, opt-out, deleted recipient, manual_mode automated, no consent person, window, cap); `:2183` (group_text); `:686` (a person's send on a manual thread); `:707` (recorded recipient judged); `:735/:757` (fail open); `:777` (failed enqueue). The conversation-read fail-open is proven at the decision (`oneToOneRetryDecision.test.ts:296`) with the same arm branch as `:735`. The one-table parity is as for D3a. |
| 5 one-to-one job | DELIVERED | `twilioStatusWebhook.test.ts:1581,1613,1640,1664,1690,1719,1748,1781,1825,1855`. |
| 6 manual route | DELIVERED | `apiRoutes.test.ts:482,499,515,531,574`. |
| 6a sendMessage flags | DELIVERED | `sendMessage.test.ts:981,993,1007,1029`; `messaging.integration.test.ts:213` (real repo). |
| 7 dashboard | DELIVERED | `deliveryStatus.test.ts:743-826,1715`; `Timeline.delivery.test.tsx:595-633` (DEFAULT rosterKind); `Timeline.ticker.test.tsx:999,1043` (fast/slow +/- 10 min); `Timeline.test.tsx:931`; the inverted group-text tests; `retryPromiseMirror.test.ts`. The Timeline files and both mirror files were re-run by me: pass. |
| 8 e2e | DELIVERED (log-verified) | `one-to-one-30003-retry.spec.ts:147-290` (conv-0001; the promise is sampled from the send with no plain failure first; no Retry at the same instant; 409 `retry_pending`; the retry replaces the bubble; the carrier sees exactly two legs; lineage; a 30007 positive control). Passed in `final-e2e.log` (ok 113), with the relay spec (ok 146) and share-skip-fix (ok 165-167). Not re-run. |

### Section 5 - couplings this branch owns

| coupling | verdict | evidence |
| --- | --- | --- |
| Branch A: persist and reuse the I8 recipient | DELIVERED | `sendMessage.ts:497`; `retrySend.ts:189-200,323`; `oneToOneRetryDecision.ts:102-105`; `api.ts:1612-1622,1683`. |
| Branch A: `SHARE_SKIP_REASONS` untouched; the share row reads plain | DELIVERED | No diff hunk in that map; `broadcastFormat.ts` unchanged; `broadcastFormat.test.ts:160`. |
| Branch A: staff shares' retries follow the original send | DELIVERED | `broadcastFanOut.ts:463-472` passes `automated: !staffShare` and `recipient`, so both are recorded, and D14 reads them back. |
| Branch A: the e2e never uses `conv-0002` | DELIVERED | e2e spec `:65-69`. |
| Branch B: the D8 rule is set; the seam is built for reuse | DELIVERED | D8 rows; `scripts/e2e-session.mjs:273-282`; relayed in `build-handback.md`. |
| SOR req 5: a deadline timeout is terminal | DELIVERED | `relayRetryLeg.ts:674-692` (never the transient branch); pinned by `relayRetryLeg.test.ts:1215`. |
| SOR req 7: this branch's terminal-step special case has its own test | DELIVERED | `relayRetryJoin.ts:424`; `relayRetryJoin.test.ts:217`; code mirror `relayWindowCloseMirror.test.ts`. |
| SOR reqs 1-4 and 6; the joint gap | DELIVERED (relay) | Forward requirements; relayed in `build-handback.md` "What SOR must carry" 1-7; the joint gap is recorded as gap 4 of `docs/issues/manual-retry-double-send-residual-windows.md`. |

### Section 9 residuals and the header table

| item | verdict | evidence |
| --- | --- | --- |
| Manual double send - filed | DELIVERED | `docs/issues/manual-retry-double-send-residual-windows.md` (new, low, open): gaps 1-3 = section 9, gap 4 = the section 5 joint gap, gap 5 added by the build review. |
| Pending reconcile copy - accepted | DELIVERED | Spec section 9; relayed as SOR items 3-4. |
| A promise with nothing behind it - accepted cases | DELIVERED | Breaker not previewed (`sendRefusalPreview.ts:18-20`); fail-open then refused (`oneToOneRetryDecision.ts:106-121`); D4 job decline (`retrySend.ts:243-254`); provider failure (a rethrow after the marker, unchanged); enqueue plus correction both failed (`twilio.ts:3627-3636`); a crash between the write and the enqueue (structural). See LOW finding 1 for the class section 9 omits. |
| Relay claim fault; slot before claim; a human action reversed in the backoff; no usable origin | DELIVERED | `twilio.ts:3177-3179`; `:2738,2841`; a closed append plus dedupe (`:2939-2941,2972-2974`); D5 rows. |
| A text sent before this deploy | DELIVERED | `automated ?? true` (`oneToOneRetryDecision.ts:117`, `retrySend.ts:321`). Tests `oneToOneRetryDecision.test.ts:166-170`, `twilioStatusWebhook.test.ts:1690`. |
| Header table: close `group-text-30003-leg-retry-promise-unverified`; annotate `ai-mode-switch-gates-all-automation` item 3 and `quiet-hours-ungated-automated-paths` item 3; `relay-retry-stranded-claim-window` unaffected | DELIVERED | `status: resolved` plus a resolution block; both annotations are dated 2026-09-26; the stranded-claim issue is untouched, as the spec says. |

### Section 7 - copy strings (exact)

| string | verdict | evidence |
| --- | --- | --- |
| "Phone unreachable (error 30003)" | DELIVERED | `deliveryStatus.ts:782` `'Phone unreachable'` + template `:1041` `${mapped} (error ${errorCode})`. The relay map entry is identical (`:865`). |
| "Phone unreachable - will retry (error 30003)" | DELIVERED | `deliveryStatus.ts:837` + the same template; ASCII hyphen. |
| "A retry is already scheduled for this message." | DELIVERED | `Timeline.tsx:134-135`. |
| "Not retried - message too old" | DELIVERED | `deliveryStatus.ts:957`, no tail (the internal map returns early at `:1009-1010`). |
| The four gate strings are unchanged | DELIVERED | `deliveryStatus.ts:945-948` are byte-identical to `main:931-934`: "Not retried - group closed" / "no longer in this group" / "number changed since" / "opted out". |

## Findings

1. **LOW - spec section 9 omits one class of "a promise with nothing behind it" (a records gap, not a code deviation).**
   - What: A one-to-one retry the JOB refuses because something changed DURING
     the backoff is not in the spec's accepted list:
     - the member texts STOP;
     - the kill switch is turned off;
     - manual mode is set on an automated original's thread;
     - the contact is soft-deleted;
     - a person's original loses its consent.

     Neither are the job's missing-original / not-outbound exits. These cases
     keep "will retry" and hide Retry until `retry_due_at` + 2 min + one tick.
   - Evidence: `retrySend.ts:175-182` and `:328-337` return without rewriting
     `retry_due_at` or emitting. Section 9 accepts only the breaker, a
     fail-open read, the D4 window decline and provider failure. Self-QA S2
     measured 170 s. The branch filed it as
     `docs/issues/one-to-one-retry-promise-outlives-job-decline.md`, group (b),
     and raised it as open question 1 in `build-handback.md`.
   - Implication: It stays within the section 1 invariant's bound and follows
     D3a/D7 as written, so it does not block this merge. Section 9 claims to
     list what it accepts, and this class is filed but not accepted or ruled.
     It needs Cameron's call (spec gate answer 3 bears on it): either accept it
     into section 9 as a records edit, or schedule the issue's small fix.

2. **LOW - the contact timeline's 404 client fallback never carries `retry_due_at` (outside the spec's named surfaces).**
   - What: `dashboard/src/routes/contact/buildTimelineFallback.ts:27-106` is
     used by `useContactTimeline.ts:174-219` only when `/timeline` answers 404.
     It builds items without `retry_due_at`; `error_code` and `retry_of` were
     already missing there before this branch.
   - Evidence: The item literal at `buildTimelineFallback.ts:64-102` has no
     such field. D7 names only the contact-timeline projection
     (`contactTimeline.ts:452`). The handback records this as note A3.
   - Implication: On that path a live promise is not shown and Retry is offered
     during the wait. A press gets 409 `retry_pending` and its mapped sentence,
     so nothing is sent twice. It under-promises and never lies. No conformance
     impact.

3. **LOW - a sub-millisecond boundary gap between the relay job's window gate and its bounded acquire.**
   - What: The gate is inclusive (`nowMs <= origin + 15 min`,
     `relayRetryLeg.ts:592`). The acquire gets
     `timeoutMs = Math.max(0, deadline - Date.now())` (`relayFanOut.ts:1399`),
     and `TokenBucket.acquire` with `timeoutMs: 0` always throws once it
     reaches the front of the queue, even when tokens are available
     (`app/src/lib/tokenBucket.ts:138,173-176`). A rung whose gate passes in
     the window's last millisecond therefore closes `retry_window_closed`
     instead of sending.
   - Implication: The gap is about 1 ms wide and errs toward NOT sending late,
     the invariant's direction. No test pins the relay job at its exact
     boundary (D13 deliberately uses >= 30 s margins for wall-clock code). No
     action is needed; recorded for completeness.

## Observations (no action; consistent with the spec)

- **By design (D9), a late relay 30003's marker is now ERROR (`window_closed`)
  where it used to be WARN (`claimed`), and a late one-to-one 30003 adds one
  ERROR decision line.** Thresholds are unchanged, per the ruling. This is
  handback watch item Q2 (ErrorLogs: 5 errors in 5 minutes).
- The fix wave removed `MessageAnnotations.retryOf` / `retryAttempt`. The plan
  had chosen to keep them; removing them enforces D6 (lineage only at append),
  and typecheck proves there is no caller. This is a plan deviation, not a spec
  deviation.
- The decision adds two declines the spec does not name: `not_one_to_one` (a
  relay_group or phone-less thread) and `conversation_missing`. Both are WARN,
  both match the send path's own channel guards, and D9 already lists the
  second at WARN.
- The deploy-time mixed-version effects (old tabs, and retries the old webhook
  scheduled without a stamp) are outside the spec. The handback deploy note and
  `optional-call-outcome-breaks-already-loaded-bundles` record them.
