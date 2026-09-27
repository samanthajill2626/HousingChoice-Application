# Plan draft A - findings (Tasks 1, 3, 4, 5, 6)

Drafted 2026-09-25 against `feat/retry-send-window` @`fd38ba73` (spec draft 7,
skeleton `.superpowers/plan-drafts/skeleton.md`). Tasks are in
`.superpowers/plan-drafts/slice-A.md`. Every code citation below was re-read at
that HEAD. Findings cite code by file:line and quote none of it.

## 1. Contract

- **No CONTRACT CHANGE.** Every name and type in the skeleton's Task 1, 3 and
  4-6 contracts is used exactly as written: the four constants and five helpers
  of `retrySendWindow.ts`; `RelayRetryGateCode`, `RelayRetryGateResult` and
  `evaluateRelayRetryGates(args)`; `'window_closed'` (13 -> 14 outcomes);
  `'gate_refused'` in the WARN set; `closeClaimedRetryLeg(conversationId,
  retryTsMsgId, memberKey, versioned, requestedTransport, code)`;
  `relayRetryWindowStart` on the append; `'retry_window_closed'` in
  `RelayRetryCloseCode`; `sendOneRelayLeg`'s `sendDeadlineMs?: number` with the
  contract's exact acquire expression.
- **`deadline_exceeded` placement (the drafter's call, per the skeleton; the
  handback template in Task 21 asks for it):** `RelayLegSendOutcome` is an
  interface whose `kind` is a string union (`app/src/jobs/relayFanOut.ts:1227-1231`),
  not a discriminated union of objects. `'deadline_exceeded'` joins that `kind`
  union and carries neither `providerSid` nor `errorCode`. No exhaustive switch
  reads the union: only the fan-out loop (`relayFanOut.ts:1159-1160`) and the
  retry job (`app/src/jobs/relayRetryLeg.ts:601-703`) consume it.
- **The refused gate result carries no member - no change needed.** The job's
  `retry_number_changed` and `retry_opted_out` WARN lines logged
  `logSafeMemberKey(member)` (`relayRetryLeg.ts:532`, `:542`, `:551`); after the
  extraction they log `logSafeStoredMemberKey(memberKey)` (`:256-258`). The value
  is identical for every member matched by key: `relayMemberKey` yields the
  contactId or `phone#<E164>` (`app/src/repos/messagesRepo.ts:193-197`), which
  render as the contactId or `phone-only-member` either way
  (`app/src/services/relayAnnouncements.ts:157-161`).
- **One module-private addition beyond the contract:**
  `RelayRetryClaimResult.closeCode?` (`app/src/routes/webhooks/twilio.ts:387-392`),
  so the failure marker carries the code a claim-time close wrote, as the
  orchestrator's brief asked ("WARN, log carries closeCode").

## 2. Decisions the spec leaves open (confirm or change)

- **F1 (medium) - a claim-time close that THROWS.** Spec D3 and section 9
  ("Stranded claim-time close") cover only an abrupt kill between the rung's
  append and its close. The plan guards the close separately, exactly as the
  enqueue-failure close is guarded (code review R2 W2, `twilio.ts:2852-2890`):
  the outcome stays `gate_refused` / `window_closed`, the callback still answers
  200, the marker carries no `closeCode`, and one ERROR line names the rung left
  open. A redelivery cannot repair it: its deduped append returns before any
  close (D3). The rung then sits at `queued`, never enqueued - "Retrying" until
  the join's staleness rule ages it (`relayRetryLeg.ts:413-417` describes that
  rule). Letting the throw reach `claim_failed` would be worse: a 5xx whose
  redelivery answers `already_claimed` and still leaves the rung open. Recommend
  widening section 9's residual to "a kill or a failed close write" under
  `relay-retry-stranded-claim-window`.
- **F2 (low) - the transient re-check's predicate.** D4 (spec lines 249-251)
  and test intention 3 say the transient re-enqueue "re-checks and closes ...
  once past the window" without naming the check. The plan treats a re-enqueue as
  a SCHEDULING decision and applies the claim's rule - `retryFitsSendWindow` with
  the transient backoff (5 s / 10 s) and the 60 s grace - at
  `relayRetryLeg.ts:643-646`, closing through `closeTerminally` (a post-send
  close, like the `transient_cap` branch at `:627-641`). The alternative is the
  strict job-time check on `now + backoff`. Either keeps the invariant, because
  every send is still bounded by the strict job-time gate and the bounded
  acquire; the choice only moves when a doomed rung closes, by up to 60 s.
- **F3 (low) - the D5 WARN at the claim.** Logged only for a rung the claim
  creates (a deduped duplicate returns first), and only when every gate passes
  (a gate decline never evaluates the window). The carried origin is normalized
  to ISO; an unparseable rung-1 origin is NOT carried, so rungs 2-3 of that
  ladder report `windowOrigin: 'missing'`, not `'unparseable'`. The job's own D5
  WARN fires on every execution of an unwindowed rung, transient re-runs
  included.

## 3. Behavior deltas (accepted by the skeleton; named so review sees them)

- **F4 (low) - the pool-number throw moves.** The job checked "open group with
  no pool number -> throw" between gate 1 and gate 2 (`relayRetryLeg.ts:510-515`).
  The skeleton keeps the throw after a non-refused evaluator result, so an open,
  pool-less group whose member is ALSO removed, re-numbered or opted out now
  closes the rung with that gate's code instead of throwing, and the suppression
  read now runs before the throw. No existing test covers the throw.
- **F5 (info) - `gate_refused` newly reaches the marker.** The union declared it
  (`app/src/lib/relayRetryClaim.ts:51`) but only the job's own lines used it
  (`relayRetryLeg.ts:502`, `:525`, `:542`, `:551`); the claim never returned it,
  so adding it to the WARN set (`twilio.ts:439-444`) changes no existing marker.
  The doc bullet at `twilio.ts:423-428` said a gate refusal ERRORs - stale since
  the Q1 ruling; the plan rewrites it.
- **F6 (info) - added reads, 30003 relay claims only.** The preview adds a
  conversation GetItem, a contact GetItem (or phone lookup) and a
  byParticipantPhone GSI query (`relayAnnouncements.ts:64-100`) per claimed
  leg. At rung 1 for a member sender the conversation is read twice
  (`composeRelayLegCopy`, `twilio.ts:590-616`, reads it too); left as two reads
  to keep that helper's signature. Every read throws into `claim_failed`.

## 4. Precision notes on the spec

- **F7 (low) - "one SSE for the root" (test intention 2).** On a transitioning
  rung-1 callback the tail's existing emit (`twilio.ts:3092-3101`) also
  addresses the root, because `ptr.tsMsgId` IS the root at rung 1 - two root
  emits, exactly as on today's claimed path. The plan proves the claim's OWN
  emit fires once and after the close in the crash-recovery shape, where
  nothing transitions (the existing idiom, `relayRetryClaim.webhook.test.ts:760-775`).
- **F8 (info) - clock injection (D13).** Satisfied for the pure helpers
  (Task 1). The claim and the job read `Date.now()` directly, as they already do
  for `providerTs` and `runAt` (`twilio.ts:2770`, `relayRetryLeg.ts:232`); their
  tests seed origins relative to the wall clock with margins of 30 s or more. A
  `now` seam on `TwilioWebhookDeps` / `RelayRetryLegJobDeps` would be a contract
  addition; not added.
- **F9 (info) - citation drift.** The spec and skeleton cite
  `closeRetryLegEnqueueFailed` as `twilio.ts:627-660`; it ends at `:658`
  (`:659-664` is `captureContact`). `isTerminalRelayLegFailure` is `:433-445`.

## 5. Handoffs to other slices

- **F10 (medium) - Task 10 (B2): the relay bullet of `twilio.ts:316-341`.** Its
  RELAY paragraph (`:333-338`) lists relay WARN as "a rung actually claimed" or
  `slot_settled`; after Task 4 `gate_refused` is WARN too. Task 10 rewrites that
  block for D11/D12, so it should add the clause; this slice does not edit it,
  to avoid two edits in one comment.
- **F11 (info) - Task 10 (B2): one import.** Task 4 adds a
  `lib/retrySendWindow.js` import to `twilio.ts` (after `:145`); Task 10 folds
  `RETRY_PROMISE_WITHDRAWN_AT` into it (B2's own F2 already plans this).
- **F12 (medium) - Tasks 16/17 (slice C): the relay join.** Test intentions 2
  and 3's screen halves ("reads that gate's Not retried copy at once"; "renders
  that leg as Phone unreachable (error 30003)") are not in this slice, which
  proves the data. Because the claim-time close writes the same slot the job's
  refusal writes (Task 4's Bob/Carol comparison and the literal both Task 4 and
  Task 5 pin), the join's terminal step (`dashboard/src/routes/contact/relayRetryJoin.ts:405-415`)
  needs ONE rule for `retry_window_closed`, whichever end closed the rung.
- **F13 (info) - Task 2 (B1): consumed as written.** Task 4's origin tests
  assert `relay_retry_window_start` on the rung, so a harness append that drops
  it fails them loudly rather than vacuously. The job reads
  `MessageItem.relay_retry_window_start` as `string | undefined`.
- **F14 (info) - send-outcome-reconcile, section 5 requirements 5 and 6.** The
  bounded acquire sits in `sendOneRelayLeg` BEFORE the presign, the `attempted`
  aggregation write (`relayFanOut.ts:1380-1382`) and the provider call, and its
  timeout is a RETURNED terminal outcome, closed by the job through
  `refuseGate`. Reconcile's prepare / send / record split must keep it terminal
  and ahead of its per-recipient attempt-record claim, or finish that record as
  a terminal non-send. The job's window gate runs before `sendOneRelayLeg`, so a
  window decline never holds a claim.

## 6. Observations outside scope

- **F15 (info) - `tokenBucket.ts:106-110`** frames a bounded acquire as the
  INTERACTIVE caller's tool; after Task 6 a background job passes a bound too.
  The sentence ("every pre-existing caller") stays literally true, so it is left
  unedited.
- **F16 (info) - `app/test/helpers/logCapture.ts:10`** documents `atLevel` as
  "at or above" a level; the implementation (`:36-38`) is an exact match. The
  plan's assertions rely on the exact match, as the existing suites do. Could be
  filed as a doc fix.
- **F17 (info) - pre-existing non-ASCII.** `app/test/relayFanOut.test.ts:1` and
  `:6` and `app/src/jobs/relayFanOut.ts:1643` carry non-ASCII characters; no
  task touches those lines, and every quoted "old" block in the slice is ASCII.
