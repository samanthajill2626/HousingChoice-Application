# Research findings - dashboard copy, the Retry button, clocks and e2e

Read-only research, 2026-09-24, by an opus research subagent for the planner
session, at `main` @`685f2ede`. Punctuation normalized to ASCII; content as
reported. Paths under `dashboard/src/routes/contact/` unless stated.

## 1. How a one-to-one bubble's label and reason are built

- `presentDeliveryStatus` (`deliveryStatus.ts:122-148`) reads a table (`:39-57`);
  only `undelivered` and `failed` set `isFailure`; a quiet `sent` becomes "Sent -
  not confirmed" (`:79-83`, `:128`).
- `deliveryReason` (`:952-977`) checks, in order: `INTERNAL_CODE_REASONS`
  (`:913-935`, early return, no "(error N)" tail); the MMS map when `media`
  (`:815-818`); the RELAY map when `relay` (`:859-861`); the base
  `ERROR_CODE_REASONS` (`:777-784`, 30003 at `:778`); then the "(error N)" /
  "Delivery failed (error N)" template (`:974-976`). Order pinned by
  `deliveryStatus.test.ts:752-767`.
- Timeline call sites: one-to-one chip `Timeline.tsx:964-966`; reason `:980` (only
  `{ media }`); render `:1193-1204`; EmailCard `:1644-1645`; rollup `:1057-1080`;
  spoken summary `:605-614`; row `:1252-1286`.
- `TimelineMessage` (`dashboard/src/api/types.ts:2479-2557`) has
  `delivery_status`, `error_code`, `retry_of`, `relay_retry_*`, `imported`,
  `delivery_recipients`, `at` - no due-time field and no `retry_attempt`. The
  server projection is a fixed allowlist (`app/src/routes/contactTimeline.ts:406-463`,
  interface `:157-175`).
- A due-time field is read at `Timeline.tsx:980` against `bubbleNowMs`, which is
  derived later (`:1016`), so the order must change; the same field belongs in the
  Retry gate (`:1341`) and the ticker condition (`:859-899`).
- Caution: editing `ERROR_CODE_REASONS['30003']` also changes EmailCard, the
  broadcast badge (`dashboard/src/routes/broadcasts/DeliveryBadge.tsx:31`) and
  every native group-text leg.

## 2. Native group text

- Leg code: written by Conversations receipts (`app/src/services/groupReceipts.ts:448-458`);
  no retry is ever scheduled there. Message row: `rollUpAggregate` copies the worst
  leg's code (`:337-358`).
- The classic 30003 arm (`app/src/routes/webhooks/twilio.ts:3350-3369`) does
  enqueue `retrySend`, `sendMessage` refuses `group_text`
  (`app/src/services/sendMessage.ts:297-299`), and the chain stops
  (`app/src/jobs/retrySend.ts:208-217`).
- Dashboard: the rollup (`deliveryStatus.ts:466-473`), spoken summary
  (`Timeline.tsx:605`) and row (`:1252`) pass `relay: false`, so they get the base
  "will retry" copy; the message-level chip shows only when there is no rollup
  (`:1193`).
- The carve-out tests (inferred - the comment above `RELAY_ERROR_CODE_REASONS`
  does not name them): `deliveryStatus.test.ts:419` ("keeps the retry promise on a
  native group-text rollup"), `deliveryStatus.test.ts:738` ("keeps the retry
  promise everywhere else - 1:1 and native group text"),
  `Timeline.delivery.test.tsx:516` ("keeps the retry promise on the SAME leg in a
  native GROUP TEXT"); related, `Timeline.delivery.test.tsx:577`.
- Every "will retry" assertion - positive: `StatChips.test.tsx:129`;
  `deliveryStatus.test.ts:426`, `:739-741`; `Timeline.delivery.test.tsx:528-536`,
  `:593`; `Timeline.email.test.tsx:114`. Negative: `Timeline.delivery.test.tsx:457`,
  `:506`, `:567`, `:980`, `:1051`, `:1074`; `deliveryStatus.test.ts:413`, `:730`.

## 3. The manual Retry button

- Gated on the message-level `delivery` (`Timeline.tsx:964`), never the rollup.
- Only `ContactCommsPane` wires `onRetry` (`ContactCommsPane.tsx:304-308`, `:338`),
  through `ContactDetail.tsx:974` and `ContactCommsTab.tsx:125` (the tour and
  placement 1:1 tabs). Group and relay hosts pass none (`GroupTextView.tsx:448`,
  `ConversationDetail.tsx:480`, `TourConversation.tsx:467`,
  `PlacementConversation.tsx:320`), and the contact timeline excludes group and
  relay threads (`app/src/routes/contactTimeline.ts:1232`) - so in practice the
  button appears on one-to-one bubbles only.
- On a 409, `onRetrySurfaced` (`Timeline.tsx:2400-2407`) calls
  `sendFailureMessage` (`:86-131`): `not_retryable` and `not_failed`
  (`app/src/routes/api.ts:1585-1594`) are unmapped and read the generic "Couldn't
  send" (`:130`); no refetch.
- A manual retry during the automatic backoff can double-send today: the route
  accepts any failed original (`api.ts:1592`), and `retrySend` never checks whether
  its message was superseded (`retrySend.ts:112-120`).

## 4. Clocks

- One thread clock `tickNow` (`Timeline.tsx:1805`) -> `bubbleClocks` (`:758-766`)
  -> the run condition `hasTickableLeg` (`:859-899`; its retry clause `:885-894`)
  -> `tickerArmed` (`:2101-2104`) -> a 60 s interval (`:741`), paused while hidden
  and bumped on focus (`:2105-2127`).
- One-to-one bubbles do NOT tick: `hasTickableLeg` returns false without
  `delivery_recipients` (`:867-868`), and the one-to-one chip reads an implicit
  `Date.now()` (`:1010-1012`); pinned by `Timeline.ticker.test.tsx:412-418` (run by
  `:481-496`).
- Reuse: a clause shaped like the relay retry clause (arm while now < T, stop at
  T), read against `bubbleNowMs`, with the clock-skew bound (`:791-797`). Harness:
  `startFakeClock` (`:103-109`), `spyOnIntervals` (`:111-119`), the ARMING and
  SILENT tables (`:259-496`), the retry-clause describe (`:723-921`). A promise can
  linger up to 60 s past T.

## 5. Relay terminal rungs

- The server writes `{failed, code}` on the rung (`app/src/jobs/relayRetryLeg.ts:449-480`);
  close codes are a union at `:91-97`. The join copies the last rung's code onto the
  leg with `retryState: 'terminal'` (`relayRetryJoin.ts:405-415`); the leg presenter
  falls through (`deliveryStatus.ts:713-714`) to "Undelivered" plus the internal
  copy (`:931-934`); the rollup counts it as failed (`:483-487`).
- A new `retry_window_closed` goes in `INTERNAL_CODE_REASONS` and the server union
  - needed only if the window refuses after a retry row exists; a claim-time
  refusal leaves no rung, and the leg already reads "Phone unreachable (error
  30003)".
- Tests that enumerate the codes: `deliveryStatus.test.ts:1648-1668`,
  `app/test/relayRetryLeg.test.ts:307ff` and `:996`. Terminal rendering:
  `Timeline.delivery.test.tsx:987-1011`, `relayRetryJoin.test.ts:187-198`,
  `TourConversation.test.tsx:967-974`, `PlacementConversation.test.tsx:651-658`.

## 6. E2E

- Only `e2e/tests/dashboard-next/relay-30003-retry.spec.ts` covers 30003 (the
  renamed no-retry-promise spec, `:18-23`). There is NO one-to-one retry spec,
  automatic or manual.
- The fake arms a 30003 via `/control/delivery-outcome` (`fake-twilio/src/control.ts:79-86`,
  profile type `types.ts:20-34`), one-shot per destination (`engine.ts:463-464`);
  the spec helper is `setDeliveryOutcome` (`e2e/fixtures/fakeTwilio.ts:354-373`);
  callbacks fire at 0, 150 and 300 ms (`delivery.ts:8-31`).
- The fake cannot send a delayed callback by itself. Workaround: the `stall`
  profile plus `postStatusCallback` (`e2e/fixtures/fakeTwilio.ts:107-145`, already
  used at `message-transport-fidelity.spec.ts:260`) posts a signed callback for any
  SID at any time.
- Lane overrides go in `childEnv` (`scripts/e2e-session.mjs:109-275`; the backoff
  precedent `:254-272`); `relayRetryLeg.ts:190-196` honors it only when
  `JOBS_QUEUE_URL` is unset and the value is a positive integer.
- An `E2E_RETRY_WINDOW_MS`-style override is feasible with the same guard, but one
  lane value serves every spec: it must stay well above the relay path (claim plus
  a 10 s rung; budgets at the spec's `:218` and `:249`) - below about 15 s it would
  refuse the relay rung - and the one-to-one backoff is a fixed 60/120/240 s with
  no lane override (`retrySend.ts:40-42`), so a window under about 60 s means no
  one-to-one retry ever happens in the lane.
- The one-to-one retry payload carries no root timestamp (`retrySend.ts:44-50`),
  and `retry_of` points only at the previous attempt (`:224-227`); relay rungs
  chain to the root.

## 7. Stale comments

- "NO RELAY RETRY EXISTS" above `RELAY_ERROR_CODE_REASONS`
  (`deliveryStatus.ts:824-829`) predates the relay ladder (`twilio.ts:2678-2686`,
  `relayRetryLeg.ts`, `relayRetryJoin.ts`, the `Retrying` and `Delivered on retry`
  labels at `deliveryStatus.ts:725-765`). The map's effect is still right.
- The same stale claim: `Timeline.tsx:973-979`, `:1272-1275`;
  `deliveryStatus.test.ts:721-737`; `Timeline.delivery.test.tsx:460-465`,
  `:509-515`, `:570-576`; `StatChips.test.tsx:121-127` (which says a broadcast
  recipient's 30003 is retried - UNVERIFIED; broadcast legs do go through
  `sendMessage`, `app/src/jobs/broadcastFanOut.ts:417`).
