# Task 10 independent review

Reviewed commit: `be6f2f7f` against `a738948b`

Result: FINDINGS -- three P2 specification-conformance defects.

## P2 -- State-absent slots wrongly block a completed aggregate

- Location: `dashboard/src/lib/messageTransport.ts:78-90`
- Contract: design spec section 9.4, lines 670-674: only `planned` and
  `attempted` slots are the expected set; state-absent slots do not participate.
- Consequence: after all participating attempted legs have actual evidence, a
  source-time/state-absent slot keeps the main chip at requested-only rather
  than showing the proven actual or `Mixed`. This makes a completed relay send
  look indefinitely pending.
- Proof: the probe passed a complete attempted `RCS -> SMS` leg plus a
  state-absent queued source-time slot and returned `RCS`. The code adds every
  non-excluded slot to `expected` and then requires every one to be
  `attempted`, so the state-absent slot necessarily makes `complete` false.
  The new test at `dashboard/src/lib/messageTransport.test.ts:172-204` locks in
  that contrary result.

## P2 -- Uniform recipient evidence with no request is rendered as Unknown

- Location: `dashboard/src/lib/messageTransport.ts:448-450`
- Contract: design spec section 9.3, lines 652-657, says request-absent plus
  actual-known renders actual only; section 9.4, line 674, applies that
  single-recipient table to one distinct completed recipient actual.
- Consequence: malformed-but-versioned outbound records lose a known normalized
  fact. A completed attempted MMS leg with no requested field displays
  `Unknown` instead of `MMS`.
- Proof: the focused presenter probe passed one attempted leg with
  `actualTransport: 'mms'` and no message request; it returned `Unknown`.
  The `actual` is known at line 448, but the combined request-absent guard at
  line 449 discards it. The Task 10 plan's table at
  `docs/superpowers/plans/2026-09-01-message-transport-fidelity.md:1290`
  conflicts with the approved specification and should be corrected alongside
  the implementation/test expectation.

## P2 -- An opted-out row loses its required requested-transport label

- Location: `dashboard/src/lib/messageTransport.ts:59-62`
- Contract: design spec section 9.4, lines 685-691: an excluded
  `contact_opted_out` row remains visible, keeps its suppression copy, and
  renders requested transport only. Only an excluded member without the
  suppression code is omitted.
- Consequence: Task 11 will keep the opted-out recipient and its explanation
  but append no transport label, so its requested intent is hidden even though
  it is an explicit required recipient-row fact.
- Proof: the focused presenter probe passed
  `{ status: 'failed', errorCode: 'contact_opted_out', requestedTransport:
  'rcs', transportAggregationState: 'excluded' }` and received `null`.
  `includedRecipientEntries` correctly retains the row at lines 49-56, but
  `presentRecipientTransport` unconditionally returns `null` for every
  excluded state. The new test at
  `dashboard/src/lib/messageTransport.test.ts:287-297` locks in this broad
  hide rule.

## Confirmed / sweep notes

- No P1 found. The presenter consumes normalized dashboard API facts only; it
  imports no provider/Twilio symbols and contains no media, type, SID, or
  conversation-kind transport inference.
- Inbound precedence is correct: `dashboard/src/lib/messageTransport.ts:112-116`
  returns actual-only before recipient aggregation, so relay fan-out slots do
  not replace an inbound source chip.
- The shared inclusion helper accepts both records and arrays
  (`messageTransport.ts:49-56`); `presentRelayDelivery` safely uses the array
  form (`deliveryStatus.ts:407-408`).
- The delivery denominator and stale helpers honor the narrow hide rule:
  `deliveryStatus.ts:252`, `334`, `407-408`, and `540`. Opted-out delivery copy
  remains before the hide check at `deliveryStatus.ts:528-540`.
- Current Timeline rows and their direct `Object.entries`/`Object.values`
  readers remain unfiltered at `Timeline.tsx:784-789`, `858-860`, and
  `882-907`; the approved plan explicitly assigns their use of the shared
  helper, recipient-row filtering, disclosure, and ticker alignment to Task
  11. This is a required downstream integration item, not a Task 10 scope
  finding.

## Focused verification

`npm run test -w @housingchoice/dashboard -- src/lib/messageTransport.test.ts src/routes/contact/deliveryStatus.test.ts`

Exit 0: 2 test files passed; 112 tests passed.

The one-line `tsx` presenter probe produced:

```json
{"stateAbsentPlusCompleteAttempt":"RCS","uniformNoRequest":"Unknown","optedOutRecipientTransport":null}
```
