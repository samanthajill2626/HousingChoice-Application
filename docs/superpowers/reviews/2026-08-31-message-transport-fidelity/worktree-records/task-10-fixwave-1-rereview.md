# Task 10 fix-wave 1 rereview

## Verdict

PASS/CONFORMS. No P1, P2, or P3 findings in `c784ccaf` relative to
`0eca2d8b`.

## Cold review scope

Reviewed the pure transport presenter against design sections 9.3-9.4, then
swept every dashboard consumer of its exported helpers. The only non-test
consumer is `dashboard/src/routes/contact/deliveryStatus.ts`; it consumes the
unchanged inclusion/exclusion helpers for delivery counts and stale-leg
suppression, not `presentMessageTransport` or `presentRecipientTransport`.
Its state-absent delivery denominator remains deliberately separate from the
transport expected set, which is required by the design.

## Empirical evidence

`npm exec vitest --workspace=@housingchoice/dashboard -- run
src/lib/messageTransport.test.ts` exited 0: 1 file passed, 40 tests passed.

- State-absent slots are excluded from the transport expected set while
  `planned` and `attempted` slots participate (`messageTransport.ts:83-97`),
  including the distinct planned and source-time probes in the focused test.
- A complete uniform actual with no request renders the actual, a complete
  divergent set renders `Mixed`, and incomplete/no-participating sets fall back
  to the request or `Unknown` (`messageTransport.ts:99-108`). This matches the
  single-recipient no-request rule at `messageTransport.ts:126-128`.
- Message-level actual is ignored when a nonempty outbound slot map is present;
  inbound returns before aggregation and remains actual-only
  (`messageTransport.ts:119-125`).
- The `contact_opted_out` exclusion preserves requested-only display while
  other excluded slots return no transport (`messageTransport.ts:62-65`).
  The state writers produce the opted-out form with that exact code; a removed
  never-attempted slot is excluded without it. The downstream delivery helpers
  preserve the same split.
- Empty recipient maps retain the single-recipient path because aggregation is
  entered only for a nonempty map (`messageTransport.ts:125`).

## Prior findings closure

All three accepted P2s are closed: state-absent slots no longer block complete
transport aggregation, known actual without a requested value no longer becomes
`Unknown`, and opted-out rows preserve requested transport. The correction does
not introduce a conflicting condition in the delivery rollup or inbound source
path.
