# Retry send window build - spec-conformance review

Reviewer: independent spec-conformance reviewer (read-only on the tree).
Branch `feat/retry-send-window`, worktree `W:\tmp\retry-send-window`, HEAD
`c2322857`, merge base `da04d0cb`. Inputs: spec draft 7.3
(`docs/superpowers/specs/2026-09-24-retry-send-window-design.md`), plan v3
(`docs/superpowers/plans/2026-09-25-retry-send-window.md`, Tasks 1-20; Task 21 is
the orchestrator's and is out of scope), the build worklist
(`.superpowers/sdd/build-worklist.md`) and the six slice reports. Every citation
below is `file:line` in the LIVE tree at `c2322857` unless it says "base" (the
merge base `da04d0cb`).

## 1. Verdict

**CONFORMS WITH GAPS** - no code defect found; one test-coverage gap against the
spec and four documentation/coverage nits.

- Work map (Tasks 1-20): 20 CONFORMS, 0 PARTIAL, 0 MISSING.
- Spec decisions (15 rows, D1-D14 with D3a): 14 CONFORMS, 1 PARTIAL (D13), 0 MISSING.
- Section 4 surfaces: 45 listed locations, 45 covered, 0 uncovered.
- Section 6 test intentions (1-8 plus 6a, 9 rows): 9 covered; 1 clause of intention 2
  asserted in only some cases (NIT); 1 clause of intention 4 pinned at unit level only.
- Section 7 copy: 4 of 4 approved strings byte-exact and ASCII; 4 of 4 gate strings
  unchanged; "hidden" is NOT RENDERED.
- Review Focus 1-5: 5 of 5 pinned.
- Deviations: every declared deviation is benign or an improvement; 0 undeclared
  code divergences from the plan.
- Findings: 0 BLOCKER, 0 MAJOR, 1 MINOR, 4 NIT.

### Method (how each claim below was established)

- Plan-to-tree extraction (scratch scripts, not committed): every fenced block of
  the plan (370 fences, 331 of them code or doc text rather than shell) was
  checked for verbatim presence in the branch's changed
  files. Every "New"/"with:"/"Create" block is present, except blocks later tasks
  or worklist items deliberately rewrote (each traced in section 8). The 17
  `Create` files were diffed whole: 14 byte-identical, 3 differ only by worklist
  items O3/O4 (source comment), O1 + Step 8b additions (decision test), D5 (clock
  test).
- Tree-to-plan scan: every ADDED line of `git diff -U0 da04d0cb...HEAD` (6163
  lines, excluding `docs/superpowers`) was checked against the set of all plan
  block lines. 159 lines are in no plan block; every one is a worklist-directed
  change, a dated doc line, the two issue files filed at the spec stage
  (`613752d1`, `1c0c7ab3`), or the two comment fixes of `152d3120` (section 8).
- ASCII: 0 non-ASCII bytes in the 6163 added lines; the four approved strings
  checked byte-by-byte (section 6). No British spellings in added lines.
- Empirical: one throwaway app file (`app/test/zz-review-conf-probes.test.ts`,
  3 cases, 3 passed, DELETED) and three existing dashboard files run singly
  (`Timeline.delivery.test.tsx` 45 passed, `Timeline.email.test.tsx` 8 passed,
  `StatChips.test.tsx` 14 passed). No `npm test`, no e2e, no Playwright.

## 2. Work map (plan Tasks 1-20)

| Task | Status | Evidence (live) | Notes |
| --- | --- | --- | --- |
| T1 window constants and pure helpers | CONFORMS | `app/src/lib/retrySendWindow.ts:15` (15 min), `:22` (60 s grace), `:29` (2 min promise grace), `:32` (withdrawn stamp), `:36-40` parse, `:43-49` scheduling check, `:52-54` strict job check, `:57-59` deadline, `:63-68` server liveness; test `app/test/retrySendWindow.test.ts` | Source and test byte-identical to the plan. |
| T2 repository fields and harness twins | CONFORMS | `app/src/repos/messagesRepo.ts:725-760` (NewMessage retryOf doc, retryAttempt, retryWindowStart, automated, recipientContactId), `:795` relayRetryWindowStart, `:1039-1053` and `:1071` MessageItem, `:1237` MessageAnnotations.retryDueAt, `:1332` interface option, `:2334-2350` append, `:2371-2375` relay origin, `:2631-2680` updateDeliveryStatus (one conditional write), `:3020-3024` annotateMessage; harness `app/test/helpers/twilioWebhookHarness.ts:1140-1148`, `:1169-1171`, `:1232-1242`, `:1367-1368` | Tests: `twilioWebhookHarnessRetryFields.test.ts:36-137`, `messaging.integration.test.ts:215-327`, `messagesRepoRetryLineage.integration.test.ts:248`. |
| T3 one gate evaluator; pool-number throw after the gates | CONFORMS | `app/src/lib/relayRetryGates.ts:41-73`; job `app/src/jobs/relayRetryLeg.ts:529-565` | Tests `relayRetryGates.test.ts:54-153`, `relayRetryLeg.test.ts:417-486`. |
| T4 relay claim decides at once | CONFORMS | outcome union `app/src/lib/relayRetryClaim.ts:59`, `:94` (14 values); `app/src/routes/webhooks/twilio.ts:2839-2879` (gate preview, origin, window), `:2892-2915` (rung slot), `:2939`, `:2955-2960` (append incl. origin), `:2964-2972` (dedupe), `:2974-2989` (D5 WARN), `:3000-3012` (decline exit, no enqueue), `:474-478` (WARN set gains gate_refused), `:3251-3253` (closeCode on marker) | Tests `relayRetryClaim.test.ts` (fourteen), `relayRetryClaim.webhook.test.ts:859-1376`. |
| T5 relay job window gate, optional lineage field, transient re-check | CONFORMS | `app/src/jobs/relayRetryLeg.ts:106-110` (close code), `:296`, `:322` (optional windowStart), `:583-603` (window gate, ERROR), `:722-740` (transient re-check, ERROR) | Plus worklist R2 comment `:578-582` and pin `relayRetryLeg.test.ts:584`. |
| T6 bounded token-bucket acquire | CONFORMS | `app/src/jobs/relayFanOut.ts:1226-1245` (outcome `deadline_exceeded`), `:1325` (param), `:1387-1404` (bounded acquire before presign/attempted/provider), job `relayRetryLeg.ts:650`, `:671-689` | Tests `relayRetryLeg.test.ts:1214-1288`, `relayFanOut.test.ts:2325-2368`. |
| T7 pure send-refusal preview + parity | CONFORMS | `app/src/services/sendRefusalPreview.ts:42-71`; table `app/test/helpers/sendRefusalCases.ts:68-173` (24 rows) | Parity `app/test/sendMessage.test.ts:936-978`; decision parity `app/test/oneToOneRetryDecision.test.ts:368-384`. |
| T8 send wrapper records flags and lineage at append | CONFORMS | `app/src/services/sendMessage.ts:207-217` (automated doc), `:240-262` (retryOf/retryAttempt/retryWindowStart docs), `:320-321`, `:490-497` | Tests `sendMessage.test.ts:980-1041`. |
| T9 one-to-one backoff seam and explicit-runAt enqueue | CONFORMS | `app/src/jobs/retrySend.ts:88-113` (seam, JOBS_QUEUE_URL guard), `:123-125` (enqueue at runAt); `scripts/e2e-session.mjs:282` | Task 9's temporary `twilio.ts` call site was replaced by Task 10 (worklist O2); nothing of it survives. Test `retrySendBackoff.test.ts`. |
| T10 one-to-one decision before the failure is written | CONFORMS | `app/src/services/oneToOneRetryDecision.ts:61-137`; webhook `twilio.ts:3426-3447` (decide, then one conditional write), `:3547-3640` (30003 arm), `:322-356` (taxonomy comment), `:3692-3704` (group-text comment) | O1-O6 applied (section 8). Tests `oneToOneRetryDecision.test.ts`, `twilioStatusWebhook.test.ts:437-866`, `:2148-2198`. |
| T11 one-to-one job: window and the original send | CONFORMS | `app/src/jobs/retrySend.ts:9-14`, `:138-144`, `:185-196` (recipient read before marker), `:205-222` (marker), `:231-249` (strict window), `:311-322` (send with lineage and flags; no annotate) | Tests `twilioStatusWebhook.test.ts:1533-1862`. See finding 1 (D13 boundary pin, a spec-vs-plan gap, not a plan deviation). |
| T12 manual Retry 409 and recorded recipient | CONFORMS | `app/src/routes/api.ts:43`, `:1590-1596` (not-failed first), `:1597-1609` (409 `retry_pending`), `:1610-1625` (recipient read), `:1677`, `:1683` | Tests `apiRoutes.test.ts:482-588`. |
| T13 contact timeline projects retry_due_at | CONFORMS | `app/src/routes/contactTimeline.ts:174-180`, `:450-452`; `dashboard/src/api/types.ts:2497-2508` | Test `contactTimeline.test.ts:367`. Worklist R1 applied `types.ts:2301-2308`, `:2510-2524`. |
| T14 server-clock estimate and promise predicate | CONFORMS | `dashboard/src/api/serverClock.ts:31-54`; `dashboard/src/api/client.ts:8`, `:120-125`; `dashboard/src/routes/contact/retryPromise.ts:16`, `:26-31` | Tests `serverClock.test.ts` (15 incl. D5 case at `:50`), `retryPromise.test.ts`, `retryPromiseMirror.test.ts`. |
| T15 deliveryReason promises only when scheduled | CONFORMS | `dashboard/src/routes/contact/deliveryStatus.ts:777-782` (base), `:824-838` (RETRY_SCHEDULED_REASONS), `:840-866` (relay map and doc), `:868-890` (options), `:949-956` (fallback), `:1012-1037` (chain) | Tests `deliveryStatus.test.ts:421`, `:725-822`, `:1706-1730`. |
| T16 relay join: window decline carries no display code | CONFORMS | `dashboard/src/routes/contact/relayRetryJoin.ts:96-103`, `:414-427`, `:441-443` | Tests `relayRetryJoin.test.ts:213-246`, `Timeline.delivery.test.tsx:1056-1110`. |
| T17 Timeline: live promise, Retry hidden, ticker, 409 copy | CONFORMS | `dashboard/src/routes/contact/Timeline.tsx:54-55`, `:130-135`, `:776-796`, `:849-861`, `:907-924`, `:959`, `:985-990`, `:1035-1056`, `:1343-1352`, `:1418-1433`, `:1802`, `:1820-1835`, `:2141-2144`, `:2188-2206`, `:2636` | Tests `Timeline.delivery.test.tsx:503-633`, `Timeline.ticker.test.tsx:448-474`, `:985-1076`, `Timeline.test.tsx:931`. |
| T18 every other 30003 reader reads the plain failure | CONFORMS | `dashboard/src/routes/broadcasts/StatChips.test.tsx:128-139`, `broadcastFormat.test.ts:156-160`, `Timeline.email.test.tsx:89-115` | Sweep evidence in slice 4 report; `retryScheduled` passed at exactly one site (`Timeline.tsx:1054`). |
| T19 one-to-one e2e | CONFORMS | `e2e/tests/dashboard-next/one-to-one-30003-retry.spec.ts:1-290` | Byte-identical to the plan; conv-0001 only (`:65-69`); slice 5 lane runs 1/1 and 5/5 passed. The full-suite gate is the orchestrator's. |
| T20 issues, selectors, relay spec comment | CONFORMS | `docs/issues/group-text-30003-leg-retry-promise-unverified.md:6-37`, `quiet-hours-ungated-automated-paths.md:9-68`, `ai-mode-switch-gates-all-automation.md:9-76`, `manual-retry-double-send-residual-windows.md:9-55`, `e2e/support/selectors.md:48-50`, `e2e/tests/dashboard-next/relay-30003-retry.spec.ts:18-27`; `relay-retry-stranded-claim-window.md` untouched | Only dates differ from the plan (2026-09-26, the plan's Dates rule) and F2's revision string. |

The plan's four deliberate mid-build states are all CLOSED:

1. T4-T16 unmapped `retry_window_closed`: closed by the fallback copy
   (`deliveryStatus.ts:956`) and the join (`relayRetryJoin.ts:423`).
2. T15-T18 four red dashboard tests: closed (the four tests now read
   `Timeline.delivery.test.tsx:511`, `:595`, `Timeline.email.test.tsx:95`,
   `StatChips.test.tsx:135`; the three files re-run green by this reviewer).
3. T10-T14 code-keyed over-promise: closed (`deliveryStatus.ts:782` promises
   nothing; the promise needs `retryScheduled`, passed only at `Timeline.tsx:1054`).
4. T12-T17 visible Retry and generic 409 copy: closed (`Timeline.tsx:1421`,
   `:134-135`).

## 3. Spec decisions

| Decision | Status | Evidence | Notes |
| --- | --- | --- | --- |
| D1 window = 15 min | CONFORMS | `retrySendWindow.ts:15`; test `retrySendWindow.test.ts:150-158` | |
| D2 origin | CONFORMS | One-to-one: `retry_window_start ?? provider_ts` at the decision (`oneToOneRetryDecision.ts:125`) and the job (`retrySend.ts:231`), carried at append (`retrySend.ts:321`). Relay: rung 1 = root member slot `sentAt`, rungs 2-3 copy `relay_retry_window_start`, never re-derived (`twilio.ts:2856-2858`, `:2955-2960`). Manual Retry never copies it (`api.ts:1672-1684`) | Tests `relayRetryClaim.webhook.test.ts:1119`, `:1151`; `twilioStatusWebhook.test.ts:1605`, `:1820`; `apiRoutes.test.ts:531`; `oneToOneRetryDecision.test.ts:277`. |
| D3 relay claim decides at once | CONFORMS | Cap first (`twilio.ts:2799-2801`, unchanged); gates through the job's own evaluator in the job's order (`:2839-2847`, `relayRetryGates.ts:53-72`); then the window with the resolved rung backoff (`:2867-2879`); a decline is APPENDED closed in the one append (`:2892-2915`, `:2939`), never enqueued (`:3000-3012`); outcome `gate_refused` WARN (`:477`) / `window_closed` ERROR; dedupe answers `already_claimed` (`:2964-2972`); read failure is `claim_failed` (unchanged catch `:3174-3178`); root slot untouched; root SSE after the write (`:2991-2998`); pool-number throw now follows the gates (`relayRetryLeg.ts:556-565`) | Test coverage: intention 2 (section 5). |
| D3a one-to-one decision before the write | CONFORMS | `oneToOneRetryDecision.ts:74-136` in order: conversation (missing WARN `:83-85`), group_text WARN `:86-88`, not one-to-one WARN `:89-92`, reads `:96-105`, preview (the send path's predicates, `sendRefusalPreview.ts:50-70`, automated `?? true` `:113`, recorded recipient `:98-101`), cap ERROR `:119-122`, window ERROR `:123-128`; fail open on a thrown read or missing origin `:129-136`; logs and enqueue only on the transition (`twilio.ts:3540`, `:3553`) | Parity over ONE table: `sendMessage.test.ts:936`, `oneToOneRetryDecision.test.ts:368`. |
| D4 check again right before sending | CONFORMS | Relay: last gate after opt-out (`relayRetryLeg.ts:583-603`, strict `withinRetrySendWindow`), deadline into the unit (`:650`), bounded acquire returns `deadline_exceeded` before the presign, the `attempted` write and the provider call (`relayFanOut.ts:1387-1404`), closed through `refuseGate`, never transient (`relayRetryLeg.ts:671-689`); transient re-enqueue re-checked with the scheduling rule (`:722-740`); fan-out passes no deadline (`relayFanOut.ts:1140-1154`). One-to-one: strict check before `sendMessage` (`retrySend.ts:231-249`) | Tests `relayRetryLeg.test.ts:355-366`, `:635`, `:663`, `:1214`, `:1258`; `relayFanOut.test.ts:2354`; `twilioStatusWebhook.test.ts:1581`. |
| D5 missing/unparseable origin fails open | CONFORMS | Claim WARN (`twilio.ts:2863-2866`, `:2974-2989`); job WARN, field optional in the lineage check (`relayRetryLeg.ts:296`, `:322`, `:584-588`); one-to-one arm WARN (`twilio.ts:3596-3600`); job WARN (`retrySend.ts:233-237`); no fallback from an unparseable `retry_window_start` to `provider_ts` (`oneToOneRetryDecision.ts:125`) | Tests `relayRetryClaim.webhook.test.ts:1151`, `:1178`; `relayRetryLeg.test.ts:610`, `:1276`; `twilioStatusWebhook.test.ts:757`, `:1629`; `oneToOneRetryDecision.test.ts:331`. |
| D6 lineage written with the row | CONFORMS | `retrySend.ts:319-321` into the send; `sendMessage.ts:490-492` into the append; `messagesRepo.ts:2339-2343`; the post-send `annotateMessage` is gone from `retrySend.ts` (no call in the file) | Test `twilioStatusWebhook.test.ts:1820` (annotates == 0). |
| D7 decision written with the failure | CONFORMS | `twilio.ts:3442-3447` (one `updateDeliveryStatus` call with `retryDueAt` = runAt), `messagesRepo.ts:2631-2680` (SET in the same conditional UpdateCommand); transition emit `twilio.ts:3488-3497`; enqueue at the same runAt `:3602-3611`; failed enqueue rewrites to `RETRY_PROMISE_WITHDRAWN_AT` and emits `:3612-3636`; projection `contactTimeline.ts:450-452`; dashboard type `types.ts:2508` | Tests `twilioStatusWebhook.test.ts:437`, `:777`; `messaging.integration.test.ts:257`, `:280`, `:303`, `:315`. |
| D8 what the screen says | CONFORMS | Rule and reason API: `deliveryStatus.ts:1033-1037` (`retryScheduled` first, skipped when `relay`), `:836-838`, `:782`, `:865`; chip passes no `relay` (`Timeline.tsx:1040-1056`); server clock from the `Date` header of every response (`client.ts:120-125`, `serverClock.ts:38-49`); bubble and ticker read one snapshot (`Timeline.tsx:2198-2206`, `:1039`, `:919`); share row untouched (`broadcastFormat.ts:158`, no options); relay window decline has no display code (`relayRetryJoin.ts:423`), fallback copy (`deliveryStatus.ts:956`) | Tests: intention 7 (section 5). |
| D9 logging | CONFORMS | See the D9 detail table below. | |
| D10 manual Retry guard | CONFORMS | Hidden, not disabled (`Timeline.tsx:1421`); server 409 after not-failed (`api.ts:1590-1609`); copy mapped (`Timeline.tsx:134-135`); one grace value mirrored and pinned (`retryPromise.ts:16`, `retryPromiseMirror.test.ts:40-61`) | Tests `apiRoutes.test.ts:482`, `:499`, `:515`; `Timeline.test.tsx:931`. |
| D11 native group text | CONFORMS | Decision declines `group_text` at WARN whenever the read succeeds (`oneToOneRetryDecision.ts:86-88`); base wording on leg/rollup/row (`deliveryStatus.ts:782`); carve-out tests INVERTED, not deleted (`deliveryStatus.test.ts:421`, `:743`; `Timeline.delivery.test.tsx:511`, `:595-633`; `twilioStatusWebhook.test.ts:2148`) | |
| D12 comments that now lie | CONFORMS | See the D12 detail table below. | |
| D13 test seams and fixtures | PARTIAL | Clock inputs: helpers (`nowMs`), decision (`nowMs`, `oneToOneRetryDecision.ts:66`), job (`deps.now`, `retrySend.ts:143`, `:155`). Exact boundaries pinned for the helpers (`retrySendWindow.test.ts:194-249`) and the decision (`oneToOneRetryDecision.test.ts:262-275`) but NOT for the job: its window tests use 16-minute origins only (`twilioStatusWebhook.test.ts:1581-1627`). Lane seam `E2E_SEND_RETRY_BACKOFF_MS` guarded by `JOBS_QUEUE_URL` (`retrySend.ts:106-113`, `e2e-session.mjs:282`); e2e uses conv-0001 only; fixtures moved to realistic times (`twilioStatusWebhook.test.ts:57-87`); new relay fixtures carry `sentAt`; wall-clock margins >= 30 s | Finding 1. The job's behavior at the boundary is correct (throwaway probe). |
| D14 retry follows the original send | CONFORMS | `automated` on every append, recipient id when named (`sendMessage.ts:496-497`); retry sent with the original's flag (`?? true`) and recorded recipient (`retrySend.ts:316-318`); recipient read before the marker (`:185-196`); gone recipient falls back with WARN (`:190-195`, `api.ts:1616-1624`); manual Retry passes the recipient, stays `automated: false` (`api.ts:1677`, `:1683`); flag doc says "how a send is gated" (`sendMessage.ts:207-217`) | Tests `twilioStatusWebhook.test.ts:686`, `:707`, `:1655-1818`; `sendMessage.test.ts:981-1041`; `apiRoutes.test.ts:531`, `:574`. |

### D9 detail - every level the spec and plan require

| Line | Required | Live | Pinned by |
| --- | --- | --- | --- |
| Relay claim `window_closed` | ERROR via `isTerminalRelayLegFailure` | not in the WARN set `twilio.ts:466-478`, emitted `:3264` | `relayRetryClaim.webhook.test.ts:1103-1111` (exactly one ERROR) |
| Relay job window close (gate) | ERROR | `relayRetryLeg.ts:593-601` | `relayRetryLeg.test.ts:355-366` via `:369-407` |
| Relay job bounded-acquire timeout | ERROR | `relayRetryLeg.ts:679-687` | `relayRetryLeg.test.ts:1245-1252` |
| Relay job transient re-check close | ERROR (a window decline) | `relayRetryLeg.ts:728-738` | `relayRetryLeg.test.ts:650-658` |
| One-to-one arm `window_closed` | one ERROR naming it | `twilio.ts:3571-3579` (`retryDecision`) | `twilioStatusWebhook.test.ts:640-650` via `:664-684` |
| One-to-one job `window_closed` | one ERROR naming it | `retrySend.ts:238-248` | `twilioStatusWebhook.test.ts:1598-1600` |
| Exhausted retries | ERROR, as today (line byte-identical to base) | `twilio.ts:3555-3563` | `twilioStatusWebhook.test.ts:527`, `:651-661` |
| D3a skip (incl. exhausted thread) | WARN, refusal first | `oneToOneRetryDecision.ts:115`; `twilio.ts:3578-3579` | DECLINES rows `twilioStatusWebhook.test.ts:575-639`; order `oneToOneRetryDecision.test.ts:285` |
| Missing conversation (one-to-one) | WARN | `oneToOneRetryDecision.ts:83-85` | `twilioStatusWebhook.test.ts:555-564` |
| Claim `gate_refused` | WARN | `twilio.ts:477` | `relayRetryClaim.webhook.test.ts:948-951`, `:1015-1022`, `:1056-1059` |
| `already_claimed` | WARN | `twilio.ts:474` | `relayRetryClaim.webhook.test.ts:1324-1326`, `:1345-1347` |
| Missing/unparseable origin | WARN at all four sites | claim `twilio.ts:2976-2988`; job `relayRetryLeg.ts:585-588`; arm `twilio.ts:3596-3600`; job `retrySend.ts:233-237` | `relayRetryClaim.webhook.test.ts:1168-1175`, `:1193-1202`; `relayRetryLeg.test.ts:625-632`; `twilioStatusWebhook.test.ts:770-774`, `:1648-1652` |
| Failed read in the one-to-one decision | WARN, then schedules | `twilio.ts:3591-3595` | `twilioStatusWebhook.test.ts:735-755`; decision `oneToOneRetryDecision.test.ts:296`, `:310` |
| Failed read in the relay preview | existing `claim_failed`, ERROR, 5xx | `twilio.ts:3174-3178`, `:3351-3372` (5xx path unchanged) | `relayRetryClaim.webhook.test.ts:1350-1375` |
| Failed one-to-one enqueue | today's arm ERROR | rethrow `twilio.ts:3635`, catch `:3803` | `twilioStatusWebhook.test.ts:802-804` |
| Per-callback `delivery_failed` marker | unchanged | one-to-one `twilio.ts:3476-3486` with `isTerminalDeliveryFailure` values unchanged (`:357-358`, `:368`); relay `:3217-3265` (adds only a `closeCode` field) | `twilioStatusWebhook.test.ts:2148-2198`, `:2203-2215` |
| Alarm thresholds | unchanged | no `infra/` change in the branch diff | - |

### D12 detail - every location the spec lists as "now lies"

| Cited (base) | Live state |
| --- | --- |
| `deliveryStatus.ts:824-858` "NO RELAY RETRY EXISTS" and "1:1 entry ... byte-for-byte" | Rewritten: relay map doc `deliveryStatus.ts:840-866` says the map exists because `relay` fences a relay leg off `retryScheduled`; the byte-for-byte claim is gone. |
| `deliveryStatus.ts:863-876` (relay option doc) | Rewritten `:868-890` (three flags; `relay` WINS over `retryScheduled`; `retryScheduled` doc added). |
| `deliveryStatus.ts:959-969` (order comment) | Rewritten `:1012-1030` (promise first, media, relay, base). |
| `twilio.ts:316-341` (30003 carve-out, "the one path where the promise holds") | Rewritten `twilio.ts:322-356` ("THE 30003 CARVE-OUT GOVERNS THE MARKER, NOT A PROMISE"). |
| `twilio.ts:3422-3429` ("ARE REACHABLE HERE") | Reworded `twilio.ts:3692-3704` ("MAY REACH THIS ARM - UNVERIFIED"); the "lookup below finds no contact" clause corrected in `152d3120`. |
| `twilio.ts:3477-3479` | Reworded `twilio.ts:3752-3755`. |
| `Timeline.tsx:973-979` | Rewritten `Timeline.tsx:1040-1052`; keeps "DELIBERATELY no `relay` flag", now because `relay` would switch off the promise. |
| `Timeline.tsx:1272-1275` | Rewritten `Timeline.tsx:1347-1352`. |
| `sendMessage.ts:235-241` | Rewritten `sendMessage.ts:240-247` (the automatic retry passes retryOf with the lineage). |
| `messagesRepo.ts:725-731` | Rewritten `messagesRepo.ts:725-733`. |
| `messagesRepo.ts:2262-2265` | Rewritten `messagesRepo.ts:2334-2338`. |
| `retrySend.ts:9-10` | Rewritten `retrySend.ts:9-14`. |
| `retrySend.ts:221-225` | Removed with the post-send annotate; `retrySend.ts:308-310` states the D6 append. |
| `deliveryStatus.test.ts:721-737`, `:744-751`, `:762-763` | Rewritten `deliveryStatus.test.ts:725-747`, `:795-802`, `:812-816`. |
| `Timeline.delivery.test.tsx:460-465`, `:509-515`, `:570-576` | Rewritten `Timeline.delivery.test.tsx:455-459`, `:503-510`, `:566-575` (worklist D3: cited by symbol). |
| `StatChips.test.tsx:120-127` | Rewritten `StatChips.test.tsx:128-134`. |
| `e2e/tests/dashboard-next/relay-30003-retry.spec.ts:18-22` | Rewritten `:18-27` (comment-only). |
| `e2e/support/selectors.md:49` | Rewritten `:48-49`; new one-to-one row `:50`. |

Outside the D12 list, two stale statements remain (findings 2 and 3) and one
comment is now incomplete (finding 5).

## 4. Section 4 surfaces

| Surface (spec section 4) | Covered | Evidence |
| --- | --- | --- |
| Relay claim and enqueue (`twilio.ts:2781`, `:2842`), declined rung appended closed | yes | `twilio.ts:2892-2939`, `:3000-3021` |
| Relay send and transient re-enqueue (`relayRetryLeg.ts:575`, `:643-646`) | yes | `relayRetryLeg.ts:623-651`, `:722-744` |
| `sendOneRelayLeg` acquire gains an optional deadline (`relayFanOut.ts:1360`) | yes | `relayFanOut.ts:1325`, `:1387-1404` (tokenBucket.ts untouched; its bounded `acquire` `:136-206` reused) |
| One-to-one enqueue (`twilio.ts:3364`) | yes | `twilio.ts:3602-3611` |
| One-to-one send and lineage (`retrySend.ts:200-229`) | yes | `retrySend.ts:311-322` |
| `sendMessage` input and append (`:194-253`, `:422-452`), `automated` and `recipient_contact_id` on EVERY one-to-one send | yes | `sendMessage.ts:207-275`, `:305-321`, `:482-497` |
| `NewMessage` / append / `MessageItem` (`messagesRepo.ts:638+`, `:2224-2284`, `:970-1166`) | yes | `messagesRepo.ts:725-795`, `:2334-2375`, `:1039-1071` |
| Handler registration (`registerHandlers.ts:47`, `:60`) | yes | unchanged `registerHandlers.ts:47`, `:60`; new job deps optional and lazy (`retrySend.ts:138-155`) |
| Lane backoff overrides (`e2e-session.mjs:254-272`) | yes | `scripts/e2e-session.mjs:272`, `:273-282` |
| Manual route checks, recipient read, send (`api.ts:1571-1595`, `:1642-1651`) | yes | `api.ts:1590-1625`, `:1670-1684` |
| Relay claim checks incl. preview reads (`twilio.ts:2759-2781`) | yes | `twilio.ts:2839-2879` |
| Relay job gates (`relayRetryLeg.ts:491-555`) | yes | `relayRetryLeg.ts:529-603` |
| One-to-one decision before the status write (`twilio.ts:3251`), its three reads, shared predicates | yes | `twilio.ts:3426-3447`; `oneToOneRetryDecision.ts:74-116`; `sendRefusalPreview.ts:22-25` imports the send path's own predicates |
| Arm's enqueue after it (`:3350-3369`) | yes | `twilio.ts:3547-3640` |
| Job reads of the original and recipient before the marker (`retrySend.ts:112-146`) | yes | `retrySend.ts:170-196` then marker `:205` |
| Lineage readers, server: `twilio.ts:2757`, `:2761`, `:2776`, `:2825` | yes | `twilio.ts:2799-2805`, `:2815-2820`, `:2945-2960` |
| `twilio.ts:3129` (relay escalation gate), `messagesRepo.ts:2335` (media-pointer guard) | yes (watch items, unchanged) | `twilio.ts:3303-3306` |
| `twilio.ts:3353` (the arm reads `retry_attempt`) | yes | `oneToOneRetryDecision.ts:119`; `twilio.ts:3554` |
| `relayRetryLeg.ts:268-292`, `:372` | yes | `relayRetryLeg.ts:284-325`, `:403-406` (origin OPTIONAL) |
| `messagesRepo.ts:2265-2284`, `:2912-2918` | yes | `messagesRepo.ts:2334-2375`, `:3004-3026` |
| `contactTimeline.ts:442` | yes | `contactTimeline.ts:449-452` |
| Dashboard `types.ts:2308-2315`, `:2509-2515` (watch) and `:2494` | yes | fields unchanged; comments corrected (R1) `types.ts:2301-2308`, `:2510-2524`; `retry_due_at` `:2497-2508` |
| `useRelayThread.ts:101-142` (watch) | yes | unchanged; drops `retry_due_at` (harmless, keeps a fail-open group stamp off screen) |
| `relayRetryJoin.ts:135-164`, `:453` (watch), `:405-415` (terminal step) | yes | terminal step `relayRetryJoin.ts:414-427` |
| `Timeline.tsx:885`, `:1077`, `:1975-1984`, `:2004-2019` (watch) | yes | unchanged; the `retry_of` collapse still hides the superseded original |
| API client headers (`client.ts:92-126`) | yes | `client.ts:120-125` notes `Date` on every response |
| Chip reason call and Retry gate (`Timeline.tsx:980`, `:1341`) reading a server clock | yes | `Timeline.tsx:1039`, `:1054`, `:1421` via the `promiseNowMs` prop, not the later `bubbleNowMs` |
| Ticker arming predicate (`:859-899`, `:2101-2104`) | yes | `Timeline.tsx:907-924`, `:2198-2206` |
| 30003 copy readers `deliveryStatus.ts:778`, `:859-861` | yes | `:782`, `:865` |
| Timeline chip, reason, rollup, row, spoken summary | yes | only the chip passes `retryScheduled` (`Timeline.tsx:1054`); legs pass `relay` or nothing |
| EmailCard | yes | `Timeline.tsx:1725` (no options) |
| Property-send results row (`DeliveryBadge.tsx:36`, `broadcastFormat.ts:151-161`) | yes | `broadcastFormat.ts:158` (no options) |
| StatChips | yes | `StatChips.test.tsx:135` |
| Tests: D11 set, `deliveryStatus.test.ts:761-767`, `StatChips.test.tsx:129`, `Timeline.email.test.tsx:114`, `Timeline.delivery.test.tsx:528-536`, `:593`, `broadcastFormat.test.ts` | yes | all rewritten (sections 2, 3) |
| No-tail fallback in `INTERNAL_CODE_REASONS` above `SHARE_SKIP_REASONS` (untouched) | yes | `deliveryStatus.ts:956`, `SHARE_SKIP_REASONS` `:970` not in any hunk |
| `RelayRetryCloseCode` + its gate table gain `retry_window_closed` | yes | `relayRetryLeg.ts:106-110`; `relayRetryLeg.test.ts:355-366` |
| `RelayRetryClaimOutcome` exhaustive test 13 -> 14 | yes | `relayRetryClaim.test.ts:51` |
| WARN set gains `gate_refused` | yes | `twilio.ts:477` |
| Internal-code copy test gains the fallback | yes | `deliveryStatus.test.ts:1715` |
| `selectors.md:49` documents the prose family | yes | `e2e/support/selectors.md:49-50` |
| `updateDeliveryStatus` optional `retry_due_at` in the SAME conditional update; other callers unchanged | yes | `messagesRepo.ts:2631-2680`, interface `:1326-1333` |
| Harness twin `updateDeliveryStatus` honors `retryDueAt` ONLY on a transition | yes | `twilioWebhookHarness.ts:1232-1242` (returns false before writing on unknown SID or refused prior status; sets `retry_due_at` only after the transition); pinned `twilioWebhookHarnessRetryFields.test.ts:94-124` |
| Harness `annotateMessage` honors `retryDueAt` | yes | `twilioWebhookHarness.ts:1367-1368`; pinned `:126-136` |
| Harness `append` allowlist carries every new append-time field | yes | `retry_attempt` `:1140`, `retry_window_start` `:1141-1143`, `automated` (false included) `:1144`, `recipient_contact_id` `:1145-1147`, `relay_retry_window_start` `:1169-1171` (`retry_of` pre-existing `:1133`); pinned `twilioWebhookHarnessRetryFields.test.ts:36-92`. No new test passes vacuously through a fallback: the carried-origin and follows-the-send assertions read these fields back (`relayRetryClaim.webhook.test.ts:875`, `twilioStatusWebhook.test.ts:1783`, `:1854-1860`). |
| Seeds and dev seams: none added | yes | no `app/src/lib/seed` file in the branch diff |

## 5. Section 6 test intentions

**Intention 1 - window helper.** Scheduling only with the grace to spare:
`retrySendWindow.test.ts:194-229`. Strict job boundary at exactly 15 minutes:
`:231-243`, `:245-250`. Unparseable origin fails open (returns undefined, never
throws): `:160-192`. COVERED.

**Intention 2 - relay claim.** COVERED; one clause partial (finding 4).

| Clause | Pinned by |
| --- | --- |
| Four gates each create the rung closed with that gate's code | `relayRetryClaim.webhook.test.ts:925` (it.each over `claimGateCases` `:890-923`) |
| Nothing enqueued | `:945`, `:1013`, `:1055` |
| One SSE for the root | `:1258-1307` (gate and window decline; crash-recovery shape isolates the claim's emit, fired after the one write) |
| Outcome `gate_refused` (WARN) | `:948-951` |
| Leg reads "Not retried - ..." at once | `Timeline.delivery.test.tsx:1092` (claim-time shape: row `queued`, slot failed); `relayRetryJoin.test.ts:240` |
| At rung 1 | `:925` |
| At rungs 2-3 | `:992` (it.each [2, 3]) |
| For a team send alike | `:1026` |
| Two gates: the one the job checks first | `:956`; `relayRetryGates.test.ts:128` |
| Window: rung closed `retry_window_closed`, nothing enqueued, `window_closed` ERROR | `:1062` (legacy and versioned) |
| Leg reads "Phone unreachable (error 30003)" | `Timeline.delivery.test.tsx:1056`; `relayRetryJoin.test.ts:217`, `:225` |
| Claim-time closed rung holds the job refusal's data | `:1206` (field-by-field vs a job-closed rung); window shape `relayRetryLeg.test.ts:548` (identical literal to `:1087-1095`) |
| Duplicate for an open rung -> `already_claimed`, changes nothing | `:1309` |
| Duplicate for a closed rung -> `already_claimed`, changes nothing | `:1330` |
| Preview read failure -> `claim_failed` (ERROR, 5xx) | `:1350` |
| Every gate passing inside the window claims as today | `:865` |
| Rung 2 measures from the carried origin (harness append preserves it) | `:1119`; harness `twilioWebhookHarnessRetryFields.test.ts:57` |
| Root slot unchanged in every case | asserted at `:887`, `:952`, `:1114` (legacy only); not in the versioned window, rungs 2-3, team, two-gate or duplicate cases - finding 4 |

**Intention 3 - relay job.** COVERED.

| Clause | Pinned by |
| --- | --- |
| Past the window: `retry_window_closed`, ERROR, one root SSE, no send | `relayRetryLeg.test.ts:355-366` via `:369-407` |
| Join renders it "Phone unreachable (error 30003)" | `relayRetryJoin.test.ts:217`; `Timeline.delivery.test.tsx:1056` |
| Bounded acquire timeout closes through `refuseGate`, no send, never transient, never left `queued` | `:1214-1256` (both transports; no `attempted` write, no pass claimed) |
| Transient pass past the window closes instead of re-enqueueing | `:635`; control `:663` |
| Pre-deploy rung without the field still runs (WARN) | `:610` |
| Fan-out acquire unbounded as before | `relayFanOut.test.ts:2354`; no-origin rung unbounded `relayRetryLeg.test.ts:1276` |

**Intention 4 - one-to-one status path.** COVERED.

| Clause | Pinned by |
| --- | --- |
| Stamp in the same conditional write, one SSE carries both, then enqueue | `twilioStatusWebhook.test.ts:437` |
| Redelivery writes, logs, enqueues nothing more | `:505` |
| `group_text`: no stamp, no enqueue (WARN) | `:2148` |
| Opted-out, kill-switched, soft-deleted recipient, manual mode (automated), no consent (person) - WARN | DECLINES `:575-639` via `:664`; contact-level opt-out via the shared table `oneToOneRetryDecision.test.ts:368` |
| Person's original on a manual-mode thread stamps and enqueues | `:686` |
| Recorded recipient judged; soft-deleted duplicate does not decline | `:707`; worklist O6 makes the `contact_deleted` row prove the recorded-recipient path (`:601-617`) |
| Failed contact read stamps and enqueues (WARN) | `:735` |
| Failed conversation read stamps and enqueues (WARN) | decision unit `oneToOneRetryDecision.test.ts:296`; the webhook wiring has no committed test, proven by the throwaway probe (stamp, enqueue, one `read_failed` WARN) |
| Missing origin stamps and enqueues (WARN) | `:757` |
| Exhausted: ERROR as today, no stamp | `:527`; `:651-661` |
| Past the window: no stamp, no enqueue (ERROR) | `:640-650` |
| Failed enqueue rewrites to an expired time and emits | `:777` |
| One table drives decision and send path | `sendMessage.test.ts:936`; `oneToOneRetryDecision.test.ts:368` |

**Intention 5 - one-to-one job.** COVERED.

| Clause | Pinned by |
| --- | --- |
| Past the window ends without sending | `twilioStatusWebhook.test.ts:1581`, `:1605` |
| New row carries `retry_of`, `retry_attempt`, `retry_window_start` at append; nothing annotated | `:1820`; send input `:1655` |
| Person's original: `automated: false`, not refused `manual_mode`, not breaker-counted, recorded recipient | `:1746` |
| Automated original re-sent automated | `:1790` |
| Row without `automated`: automated, no recipient | `:1655` |
| Gone recipient falls back to the phone lookup (WARN) | `:1684` |
| Failed recipient read throws before the marker (redelivered) | `:1713` |
| Each retry row records its `automated` and `recipient_contact_id` | `:1746`, `:1790`, `:1820` |

**Intention 6 - manual route.** 409 before `retry_due_at + grace`, allowed after:
`apiRoutes.test.ts:482`, `:499`; not-failed still first `:515`; no
`retry_window_start` (send input exact) `:531` and at append
`sendMessage.test.ts:1029`; recorded recipient, `automated: false` `:531`, gone
recipient `:574`. COVERED.

**Intention 6a - `sendMessage`.** `automated` true, false and the default false:
`sendMessage.test.ts:981`; `recipient_contact_id` only when named `:993`; lineage
passed through `:1007`. COVERED.

**Intention 7 - dashboard.** COVERED.

| Clause | Pinned by |
| --- | --- |
| `retryScheduled` + 30003 + no relay promises | `deliveryStatus.test.ts:753` |
| Ahead of the media map (MMS still promises) | `:764` (worklist D6 retitle: pins only that `media: true` does not suppress it) |
| Relay never promises, even with `retryScheduled` | `:817` |
| Without it no surface promises | `:743`; EmailCard `Timeline.email.test.tsx:95`; share row `StatChips.test.tsx:135`, `broadcastFormat.test.ts:160`; group text `deliveryStatus.test.ts:421`, `Timeline.delivery.test.tsx:511` |
| No-tail fallback copy present | `deliveryStatus.test.ts:1715` via `:1718`, `:1726` |
| Live stamp, DEFAULT `rosterKind`: promise, no Retry | `Timeline.delivery.test.tsx:595`, MMS `:601` |
| No stamp / expired / withdrawn / unparseable: plain failure and Retry | `:610`, `:622` |
| Ticker arms on the same server clock; promise drops after due + grace without reload | `Timeline.ticker.test.tsx:999`; silent rows `:461`, `:466`, `:471` |
| Fast browser clock included; 10 minutes fast/slow show the same real duration | `:1043` (0, +10 min, -10 min) |
| `retry_pending` maps to its message | `Timeline.test.tsx:931` |
| Native group-text tests inverted | `deliveryStatus.test.ts:421`, `:743`; `Timeline.delivery.test.tsx:511`, `:566-633` |
| Mirrored grace pinned | `retryPromiseMirror.test.ts:40-61` |

**Intention 8 - e2e.** conv-0001 only (`one-to-one-30003-retry.spec.ts:65-69`);
promise with no Retry at the same instant (`:174-205`); the retry's own bubble
replaces the failed one (`:235-243`); plus the server 409 on a stale-tab press
(`:227-231`), the stored lineage (`:259-275`) and a 30007 positive control
(`:280-289`). Relay spec and `share-skip-fix.spec.ts` still pass per slice 5
(5 passed); the full-suite gate is the orchestrator's (in progress). COVERED.

## 6. Section 7 copy

| Approved string | Where rendered | Byte-exact / ASCII |
| --- | --- | --- |
| `Phone unreachable (error 30003)` | base entry `deliveryStatus.ts:782` (`'Phone unreachable'`) + template tail `:1039-1041`; relay map `:865` reads the same; every leg, rollup, row, EmailCard, share row | yes; line checked 0 non-ASCII bytes; em dash removed |
| `Phone unreachable - will retry (error 30003)` | `RETRY_SCHEDULED_REASONS` `deliveryStatus.ts:837` + tail; only via the one-to-one chip `Timeline.tsx:1054` | yes; ASCII hyphen; `deliveryStatus.test.ts:788-793` pins ASCII |
| `A retry is already scheduled for this message.` | `Timeline.tsx:135` (`sendFailureMessage`, 409 `retry_pending`) | yes |
| `Not retried - message too old` | `deliveryStatus.ts:956` (`INTERNAL_CODE_REASONS`); no current surface renders it (the join drops the code, `relayRetryJoin.ts:423`) | yes |
| Gate copy `Not retried - group closed` / `no longer in this group` / `number changed since` / `opted out` | `deliveryStatus.ts:945-948` region, unchanged | unchanged |

"Hidden" means NOT RENDERED: the Retry button is conditionally rendered
(`Timeline.tsx:1421`, `{... && !retryPromiseLive ? (<button ...>) : null}`); no
`disabled` attribute is used. Accessible name kept: `aria-label="Retry sending
this message"` (`Timeline.tsx:1429`). Chip grammar `<label> - <reason>` kept.

## 7. Review Focus 1-5 (plan header)

| # | Case | Pinned by |
| --- | --- | --- |
| 1 | 30003 after `delivered`: nothing stamped, enqueued or logged | `twilioStatusWebhook.test.ts:808` |
| 2 | Two concurrent deliveries: one stamp, one enqueue | `twilioStatusWebhook.test.ts:834` |
| 3 | Rung 2 after a pre-deploy rung 1: claimed OPEN with one gap WARN | `relayRetryClaim.webhook.test.ts:1151` |
| 4 | Manual-Retry row that fails 30003: attempt 1, fresh window, person's send on a manual-mode thread | `oneToOneRetryDecision.test.ts:352` (title double-quoted per worklist O1) |
| 5 | `MessageStatus: failed` treated like `undelivered` | `twilioStatusWebhook.test.ts:851` |

## 8. Deviations

Declared (slice reports) - each verified in the tree:

| Deviation | Where | Classification |
| --- | --- | --- |
| Step 0 skipped (orchestrator ran `npm ci`, `db:start`) | slice 1 | benign |
| Commit trailers name the session model | all slices | benign (plan text was a placeholder) |
| R2: pool-number throw kept ahead of the window gate, comment + pin | `relayRetryLeg.ts:578-582`; `relayRetryLeg.test.ts:579-608` | improvement (pins an order the spec leaves implicit) |
| O2: imports folded, Task 9 call site replaced | `twilio.ts:120-124`, `:149-153` | benign (one import per module; no Task 9 residue) |
| O3/O4: decision header comments reworded | `oneToOneRetryDecision.ts:9-13`, `:29-38` | improvement (accurate order and fail-open scope; no code change) |
| O1: Review Focus 4 title double-quoted | `oneToOneRetryDecision.test.ts:352` | benign |
| O6: `contact_deleted` row pushes a live contact first | `twilioStatusWebhook.test.ts:601-609` | improvement (the row now proves the recorded-recipient path) |
| R1: types.ts counts (six -> seven) | `dashboard/src/api/types.ts:2301-2308`, `:2510-2524` | improvement (comment accuracy) |
| D3: test comments cite by symbol | `Timeline.delivery.test.tsx:503-510`, `:566-575` | improvement |
| D5: extra receipt-instant clock case | `serverClock.test.ts:50-57` | improvement (kills an ignore-the-parameter implementation) |
| D6: two tests retitled to what they pin | `deliveryStatus.test.ts:759-764`; `Timeline.delivery.test.tsx:601` | improvement (honest titles) |
| D8: chip comment on the group-text stamp | `Timeline.tsx:1047-1052` | improvement (the plan's "gets no stamp" was false under D3a fail-open) |
| `152d3120` (a): `retry_due_at` doc nuance | `types.ts:2502-2507` | improvement |
| `152d3120` (b): 30005/30006 "lookup below" clause | `twilio.ts:3697-3700` | improvement (the group branch breaks before the lookup) |
| Dates 2026-09-26 instead of 2026-09-25 | the four edited issues | benign (plan's Dates rule) |
| F2: revision 6 @`b93ab376` | `manual-retry-double-send-residual-windows.md:50` | benign (spec 7.3 wording) |
| Extra test files in slice runs; background e2e runs with EXIT lines; extra port-free proofs | slices 3b, 5 | benign (coverage/hygiene only) |
| Pre-existing lint error moved `Timeline.tsx:1495` -> `:1575` | slice 4 | benign (baseline-attributed; for Task 21) |

Undeclared: **none in code.** The tree-to-plan scan found no added line outside
the plan's blocks other than the items above. Every "New" block of Tasks 1-20 is
present verbatim or superseded by a later task/worklist item as listed.

Accepted residual carried for the handback (worklist D7, slice 5): the server
clock estimate can step back about a second between responses, so a refetch
landing right after the expiring tick can re-show "will retry" for up to one
more 60-second tick - within D8's stated error bound. Not a finding.

Observations (not findings):

- The bounded acquire computes `timeoutMs = max(0, deadline - now)`
  (`relayFanOut.ts:1399`); at exactly `origin + 15:00` the strict gate passes but
  `acquire(1, { timeoutMs: 0 })` refuses even with a token available
  (`tokenBucket.ts:171-176`), so that 0-ms edge closes `retry_window_closed`
  instead of sending. Errs toward not sending late; benign.
- For a rung-1 decline in the normal (transitioning) shape the handler tail's own
  slot-transition emit also addresses the root (pre-existing, `twilio.ts:3267-3276`);
  "one SSE for the root" is the claim's emit and is pinned in the crash-recovery
  shape. Unchanged behavior, not a finding.
- `dashboard/src/routes/contact/buildTimelineFallback.ts:64-100` (the legacy
  messages-only fallback) carries no `retry_due_at` - nor `error_code` or
  `retry_of`; it predates the server timeline and is out of this spec's scope.
- Two untracked files from another reviewer appeared in the tree during this
  review (`app/test/zz-review-adv-refused-promise.test.ts`,
  `app/test/zz-review-adv-withdrawn-promise.test.ts`); not this reviewer's, left
  untouched, and gone again by the time this file was written.

## 9. Findings

1. **MINOR - CONFIRMED - test-coverage** -
   `app/test/twilioStatusWebhook.test.ts:1581-1627`. Spec D13 requires the
   one-to-one job's tests (like the helpers' and the decision's) to "pin exact
   boundaries"; the job's window tests use only 16-minute origins, so nothing
   committed fails if the job's check drifts to a non-strict or off-by-grace
   comparison at the edge. The plan's Task 11 never asked for it, so this is a
   spec-versus-plan gap, not a build deviation. The behavior is correct: a
   throwaway probe with the file's own pattern (`deps.now = JOB_NOW`,
   `provider_ts = JOB_NOW - RETRY_SEND_WINDOW_MS`) sent once, and with one more
   millisecond sent nothing (3/3 passed, file deleted). Smallest fix: add a
   two-row `it.each` after `:1603` with those two origins, asserting 1 and 0
   sends.
2. **NIT - CONFIRMED - docs** -
   `docs/issues/relay-hub-message-delivery-status-never-terminal.md:55-57`, `:64-66`.
   This open issue still argues that the message-level chip must not take the
   relay flag because "the native-group-text aggregate, whose 30003 retry is
   real ... genuinely retries", and that a carrier code there "would print the
   base copy, retry promise included". Both are false after D8/D11 (the base
   copy promises nothing; no group text retries; the real reason now is that
   `relay` would switch off the one-to-one promise). Same class as D12's list,
   not on it. Smallest fix: a dated note under the WARNING paragraph.
3. **NIT - CONFIRMED - docs** - `RUNBOOK.md:341`. Lists "the 30003 retry" among
   the automated texts the one-to-one wrapper refuses on a `manual` row. Since
   D14 the retry of a PERSON'S text goes out as a person's send and is not
   refused; only an automated original's retry is. Smallest fix: "the 30003
   retry of an automated text".
4. **NIT - CONFIRMED - test-coverage** -
   `app/test/relayRetryClaim.webhook.test.ts:1113`. Intention 2 ends "the slot on
   the root is unchanged in every case"; it is asserted in the pass, rung-1 gate
   and legacy window cases (`:887`, `:952`, `:1114`) but skipped for the
   versioned window case (`if (!versioned)`) and absent from the rungs 2-3, team,
   two-gate, gate-before-window and duplicate cases. The claim writes no root
   slot on any branch (only the rung's append `twilio.ts:2916-2963` and the
   unchanged enqueue-failure close), so this is coverage only. Smallest fix:
   assert the versioned root slot equals its pre-claim value in `:1062`.
5. **NIT - CONFIRMED - comment** - `dashboard/src/routes/contact/Timeline.tsx:1013`.
   "Failures expose a reason (when error_code is present) + Retry" is no longer
   unconditional: Retry is not rendered while a one-to-one promise is live
   (`:1421`). The gate's own comment (`:1418-1420`) is right; this summary line
   was outside the edit regions (slice 4 left it on purpose). Smallest fix:
   "+ Retry (unless an automatic retry is still promised, D10)".
