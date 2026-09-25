# Slice 1 re-review (round 2) - adjudications

Date: 2026-09-25. Build orchestrator. Re-reviewed HEAD `5a85a01e` (the slice-1 fix wave:
f0a6fbc0, 1ba49fc0, 9405d678, 5a85a01e) with a fresh reviewer briefed with both round-1
reports and the adjudications (`slice-1-review-r2.md`: 0 MUST-FIX, 2 SHOULD-FIX, 7 NOTE;
closure of the 14 round-1 items: 12 proven by mutation, 2 plausible - the CLI halves of
items 6 and 8, which only the lane rehearsal reaches). One adjudication challenged (round-1
item 4) and upheld below in the reviewer's favor.

The orchestrator also read the fix-wave diff itself (the transaction in `enable()`, the
`auditRepo` builder, `planRow`, the stage guards): no defect beyond the reviewer's list.
One observation, recorded: `transactPut`'s `attribute_not_exists(entityKey)` is evaluated
against the item with the SAME full key (entityKey + a random-suffixed `ts`), so it can
never fail in practice - a harmless belt-and-braces clause, not a guard against anything.

## Accepted - code (wave 2, one fresh implementer)

1. **R2-1 (SHOULD-FIX) - evidence precedence untested.** Every real trip carries BOTH the
   audit event and the send counter, but both fixtures seed the audited trip WITHOUT the
   counter, so a census that labels every trip `send_counter` passes. ACCEPT: `c-breaker`
   gets `outbound_minute_bucket` in the census fixture AND the fix-script fixture; the
   census asserts `evidence: 'audit_event'` with the event's instant for it, and
   `send_counter` only for `c-counter`.
2. **R2-2 (SHOULD-FIX) - a config-file `endpoint_url` (the `[default]` profile or a
   `services` dynamodb entry) still redirects a dev/prod run; the env-var refusal cannot
   see it.** ACCEPT - the reviewer's challenge of round-1 item 4 is upheld: pin an explicit
   `endpoint: https://dynamodb.<HC_REGION>.amazonaws.com` on the dev/prod client (an
   explicit endpoint outranks every ambient source), print it in `describe`, and KEEP the
   env-var refusal (a clear message beats a silent override). A stageClient test proves the
   client's resolved endpoint is that host (the reviewer's no-network probe pattern from
   `slice-1-review-r2.md`).
3. **R2-5 (NOTE) - an older audited trip hides a later trip whose append was lost (the
   evidence and time come out wrong; the row is still excluded).** ACCEPT (small): the
   census reports `trippedAt` as the LATER of the audited event's instant and the counter's
   minute bucket; evidence stays `audit_event` when an event exists. Documented on the
   `BreakerTrippedRow` type.
4. **R2-6 (NOTE) - a hand rollback to `manual` (an operator writing the field directly)
   would read as a breaker trip forever.** ACCEPT (wording): the invariant comment in
   `hasBreakerSendCounter` names it beside WP2, and the RUNBOOK's breaker paragraph says
   a row switched off BY HAND must be resumed with single mode (which ignores evidence).

## Accepted - wording (RUNBOOK, same wave)

5. **R2-7 / R2-8 / R2-9 - RUNBOOK step 3 overclaims:** "the bulk write also requires the
   counter to be absent" (false with `--include-breaker-tripped`); "the difference is
   `skippedOnCondition`" (false in a PARTIAL report); "nothing was written for the row that
   failed" (false after a timeout / 5xx: the transaction may have landed - the row is on
   WITH its event; a re-run reports it `alreadyOn`, which is correct). ACCEPT: each
   sentence rewritten to what is true.
6. **R2-4 - "the `mode_changed` item is the trip" is ambiguous now that `bulk_enable` and
   `operator_resume` events exist.** ACCEPT: "the `mode_changed` item whose reason is
   `breaker_trip`".
7. **R2-3 (NOTE) - the app's own write to a row during that row's transaction can fail
   once with `TransactionConflictException`.** ACCEPT (wording): the RUNBOOK's step 3
   advises a quiet moment and names the exposure (milliseconds per row).

## Recorded, not built

- The rehearsal (plan Task 5 Step 2) adds the two CLI refusal cases the reviewer asked
  for: a repeated `--env`, and `--include-breaker-tripped` with `--conversation` - both
  must exit 2 before any stage is resolved. Done by the orchestrator, counts in the slice
  report.
- The two "plausible" closures (the CLI halves of round-1 items 6 and 8) are proven by the
  rehearsal's refusal cases above and its stage-refusal run; a `main(argv, deps)`
  extraction stays deferred (A-7b).

## Rejected

None.

## Verification of wave 2

Wave 2 is fixture rows, one endpoint line, one time comparison and RUNBOOK sentences. Its
re-verification is the orchestrator's own: read the diff, run the three script suites and
the stageClient suite, then the lane rehearsal and the full gates on the final SHA. No
third review round is dispatched for it.
