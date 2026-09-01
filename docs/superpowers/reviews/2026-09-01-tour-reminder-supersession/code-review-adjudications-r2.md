# Code-review adjudications - phase 4, round 2

Inputs: conformance Round 2 (1 BLOCKING R2-1, 2 MINOR, 1 NOTE), adversarial
Round 2 (1 MAJOR NEW-1, 3 MINOR, 2 NOTE, challenges C1-C5). Round-1 items: 18 of
21 CLOSED by both reviewers; B1 STILL-OPEN via NEW-1/R2-1; M1 preview half
re-opened via C3.

## The design change this round forces

Round 1's fix guarded the sweep with a check-then-act read. Round 2 broke it
twice: the read is eventually consistent (NEW-1 - a single uncontended
reschedule can take the loser branch, return the OLD time, and disarm the tour
with no emit), and the TERMINAL branch never got the guard at all (R2-1 -
reproduced, two 200s, zero rows, zero logs). C1's challenge is accepted: an end
state of "a live scheduled tour with zero reachable rungs and no signal" is the
defect itself, not an acceptable residue, and check-then-act cannot remove it.

**Adjudication: replace the guard with a TRANSACTIONAL GENERATION SWEEP.**
`deleteSupersededForTour(tourId, expectedPointer)` (parameter REQUIRED) deletes
each candidate row inside its own `TransactWriteItems` of two elements:
`ConditionCheck` that the TOUR's `currentLadderId` still equals
`expectedPointer`, plus the `Delete` conditioned `attribute_not_exists(sentAt)`.
Candidates are the listed rows whose `ladderId !== expectedPointer`. On a
cancellation: pointer-check failure aborts the REMAINING sweep (a newer writer
owns the ladder - log.info and stop); a Delete-condition failure (the row was
claimed mid-sweep) skips that row and continues (log.debug). No interleaving can
now delete a row while the pointer names another generation - the winner's
pointer write itself invalidates every in-flight loser transact. No reads on the
happy path (NEW-6 resolved); no window to accept (C1 resolved); DynamoDB Local
proof required; the fake mirrors the semantics synchronously.

Caller order changes (spec re-amended first):
- Re-arm: patch(rotation) -> arm(L) -> CAS(rotation -> L) -> IF WON
  sweep(tourId, L); IF LOST no sweep, log.error, and build the response from a
  CONSISTENT re-read (NEW-5: never overwrite the response with an unvalidated
  eventually-consistent read; add the opt-in consistent-read flag to
  `toursRepo.get`, the `contactsRepo.ts:781` idiom).
- Terminal transition: patch(final rotation) -> sweep(tourId, rotation).
  R2-1's branch gets the same machinery as everyone else, plus the missing
  failure log; the stale "no-try/catch posture" comment is corrected.
- Conversion: finalize(rotatedLadderId) -> sweep(tourId, rotatedLadderId).
Old-generation rows a lost re-arm leaves behind remain the named, accepted
earlier[]-until-next-sweep residue (unchanged from the original spec).

## Other verdicts

- **NEW-2 + C3 (grace keyed on last-touched-by-anything). ACCEPT-FIX.**
  `claimConversion` additionally writes `conversionClaimedAt`;
  `releaseConversionClaim` REMOVEs it with the sentinel; grace =
  `max(dueAt, conversionClaimedAt)` (absent -> fall back to the updatedAt
  basis, defensive only). Restores the cap M1's preview acceptance leaned on.
- **NEW-3 (panel promises a rung whose only Send-now answer is 409).
  ACCEPT-FIX, widened to all three surfaces**: `conversion_in_progress` joins
  `ScheduledSuppressionReason`; the panel GET, contactTimeline and relayGroups
  short-circuit on the `pending:` sentinel (each already holds the tour),
  rendering the rung suppressed rather than promised; the panel's Send-now
  button hides for it. Full census walk (both probes' surface map applies;
  NOT in PERMANENT_REFUSALS, NOT a skip reason, refetch delay does NOT skip it -
  the state resolves). This CLOSES M1's preview half outright, superseding the
  round-1 ACCEPT-RECORD.
- **NEW-4 + R2-2 + C4 (repeat explicit terminal PATCH still sweeps).
  ACCEPT-FIX**: the terminal branch additionally requires
  `patchedStatus !== currentStatus` (the reviewer's original transition rule).
  R2-3's correction of the "harmless" claim is recorded as accurate.
- **NEW-5. ACCEPT-FIX** (folded into the sweep redesign above).
- **NEW-6. RESOLVED** by the redesign (no unconditional reads remain).
- **R2-4 (superseded echo body '' renders as outage copy). ACCEPT-RECORD** -
  unreachable today (both callers refetch); noted for any future echo consumer.
- **C2. ACCEPTED AS AN ADJUDICATION ERROR**: round 1 directed the B1 regression
  test to park at the sweep, which sat inside the then-accepted window; the
  implementer's parking point was the faithful one. Recorded.
- **C5 agreements recorded**; N1-N4 and the S5 `names_unavailable` residue stand.

## Spec amendments (committed with this file)

3.2: step 2 rewritten to the transactional sweep + new caller order; terminal
transition wording now "carries a terminal status it does not already hold".
3.3: grace basis = `conversionClaimedAt`; the three preview surfaces DO consult
the sentinel (`conversion_in_progress` suppression); Send now hides during a
claim. Acceptance 8's amended clause is now deliverable with no accepted window.
