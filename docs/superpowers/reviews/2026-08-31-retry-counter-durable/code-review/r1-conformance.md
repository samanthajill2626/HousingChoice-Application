# M5 spec-conformance review - feat/retry-counter-durable @ d2d15b4e

Reviewer: spec-conformance (read-only). Merge base `1af02926`. Worktree
`W:\tmp\retry-counter-durable`, `git status` clean, no untracked residue.
Every verdict below was traced in the LIVE tree from the call site; slice
reports and issue prose were used to locate claims, never to substitute for
reading the code.

No test suite was run. Where a claim is empirical (RED-ON-MAIN, gate results)
the report says whose evidence it rests on.

---

## 1. Verdict table

### 1a. Work map

| item | verdict | anchor |
|---|---|---|
| S0+S1 claim on both repos | CONFORMS | `broadcastsRepo.ts:650`, `messagesRepo.ts:2789` |
| S0+S1 `fanout_attempt` on both item types | CONFORMS | `broadcastsRepo.ts:174`, `messagesRepo.ts:880` |
| S0+S1 all four fakes model real semantics | CONFORMS | harness `:1337`/`:2758`; two throwing stubs |
| S0+S1 DDB Local integration tests (concurrency, slot survival) | CONFORMS | `broadcastsRepo.integration.test.ts:400-598` |
| S5b both internal codes, four render positions, no tail | CONFORMS | `deliveryStatus.ts:696-698`, `:690-691` |
| S2 claim after derivation | CONFORMS | `broadcastFanOut.ts:314-334` |
| S2 three closes | CONFORMS | `:329`, `:580`, `:601` |
| S2 cap test rewritten not weakened (close A real + close B seeded) | CONFORMS | `broadcastFanOut.test.ts` close A / close B |
| S2 backoff asserted as literal adapter-observed values | CONFORMS | `delaysObserved` `[10, 20]` |
| S2 enqueue-failure seam is `configureOutboundQueue` | CONFORMS | delay-selective adapter, no `vi.mock` |
| S3 same shape | CONFORMS | `relayFanOut.ts:870-895`, `:1044`, `:1053`, `:1080` |
| S3 relay backoff ARGUMENT preserved as current pass | CONFORMS | `relayFanOut.ts:1073` |
| S3 `closeRelay` without finalize/stats | CONFORMS | `relayFanOut.ts:842-866` |
| S3 inbound-source close B with `delivery_recipients {}` | CONFORMS | `relayFanOut.test.ts` close B |
| S4 ladder at both read points | CONFORMS | `groupRail.ts:585`, `:638` |
| S4 own try/catch on point 1 | CONFORMS | `groupRail.ts:581-596` |
| S4 flag + `!wasAdopted` gates | CONFORMS | `:581`, `:636` |
| S4 three callers opted in | CONFORMS | `jobs/groupRail.ts:65`, `convertGroups.ts:436`, `rail-verify.ts:206` |
| S4 groupSend untouched | CONFORMS | absent from `git diff --name-only` |
| S4 no stale-list fallback | CONFORMS | `reReadUntilBound` does not catch; callers record failure |
| S5a relay 30003 override at three positions | CONFORMS | `Timeline.tsx:585`, `:914`, `:1065` |
| S5a tail kept for 30003 | CONFORMS | `RELAY_ERROR_CODE_REASONS` sits in the `mapped` chain |
| S5a group-text / 1:1 / email / badge unchanged | CONFORMS | four explicit pinning tests |
| S5a precedence pinned | CONFORMS | `deliveryStatus.ts:701-703` + two order tests |
| S6 sweep record | CONFORMS | `provider-status-sweep.md`, 52 sites |
| S6 comment corrections | CONFORMS | `broadcastFanOut.ts:534-545`, `relayFanOut.ts:990-1002` |
| S6 one out-of-region issue | CONFORMS | `provider-status-unenumerated-defaults.md` |
| S6 D12 throws untouched | CONFORMS | `broadcastFanOut.ts:545`, `relayFanOut.ts:1002` behaviourally identical |
| S6 in-region fix-or-file | **DEVIATED (recorded)** | second in-region exception, `isDeadRailState` - see F1 |
| S7 e2e spec with reveal-click + negatives | CONFORMS | `relay-30003-no-retry-promise.spec.ts:176-194` |
| S7 anchor Resolution incl. retrySend-needed-no-change | CONFORMS | anchor issue, "The third site named above" |
| S7 rail partial resolution | CONFORMS | `rail-binding-propagation-retry.md`, status stays `open` |
| S7 four filings | CONFORMS | adopt-path, refusal-noise, hub-row, twilio 30003 classification |
| S7 lineage five facts | CONFORMS | `relay-30003-retry-lineage.md`, five numbered facts |
| S7 `_CLUSTERS` M5 amended | CONFORMS | `_CLUSTERS.md` M5 AMENDED block |
| S7 spec D8 precision note | CONFORMS | spec `:122-126` |

### 1b. Spec Sec 7 proofs

| # | verdict | satisfying test |
|---|---|---|
| 1 | CONFORMS | `broadcastsRepo.integration.test.ts` - "the count SURVIVES a wholesale recipient-slot write" x2 |
| 2 | CONFORMS | same file - "8 CONCURRENT claims take 8 DISTINCT pass numbers, exactly 1..8" x2 |
| 3 | CONFORMS | `broadcastFanOut.test.ts` / `relayFanOut.test.ts` "close C ..."; RED recorded |
| 4 | CONFORMS | closes A/B/C in both suites; B is first-pass (broadcast) and inbound-with-`{}` (relay) |
| 5 | CONFORMS | send counts 3 + `delaysObserved` `[10,20]` / `[5,10]` |
| 6 | CONFORMS | `broadcastFanOut.test.ts` "leaves the broadcast sending" (extended) |
| 7 | CONFORMS | redelivery tests + "ALL already terminal claims no rung" in both suites |
| 8 | CONFORMS | integration - "written BEFORE this branch ... claims at 1 - D4, spec 7.8" x2 |
| 9 | PARTIAL (permitted) | 8 service cases + 2 caller cases; groupSend half proven by GREP per RULING |
| 10 | CONFORMS | `deliveryStatus.test.ts`, `Timeline.delivery.test.tsx`, `Timeline.email.test.tsx`, `StatChips.test.tsx` |
| 11 | CONFORMS | four positions incl. `DeliveryBadge` |
| E2E | CONFORMS | `e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts` |

No proof was found to be satisfied vacuously. Details in section 3.

### 1c. Hard fences

| fence | verdict |
|---|---|
| `routes/webhooks/twilio.ts` | CONFORMS - not in the diff |
| `repos/conversationsRepo.ts` | CONFORMS - not in the diff |
| `jobs/tourReminders.ts` | CONFORMS - not in the diff |
| `routes/contacts.ts` | CONFORMS - not in the diff |
| `routes/today.ts` | CONFORMS - not in the diff |
| `lib/rosterResolution.ts` | CONFORMS - not in the diff |
| `services/groupSend.ts` | CONFORMS - not in the diff |
| D7 timing unchanged (3 passes; 10s/20s and 5s/10s asserted literally) | CONFORMS |
| D11 relay backoff not normalised | CONFORMS |
| D12 throws untouched (behavior) | CONFORMS |
| ASCII of added lines | CONFORMS in code; NOTE N3 for review records |
| No `git add -A` residue | CONFORMS - tree clean, 68 files all in scope |

---

## 2. MUST-FIX

**None.** No finding requires a code change before merge.

---

## 3. Findings detail

### F1. S6 shipped a SECOND in-region exception - DEVIATED (recorded), intent honored

Spec Sec 9: "inside a region this branch already edits, fix it ... **One
in-region exception, named in advance**" (the D12 throws). Slice 6 declined a
second in-region site, `isDeadRailState` at `app/src/services/groupRail.ts:290-293`
with consumers `:493` and `:544`, and filed it in
`provider-status-unenumerated-defaults` instead.

It is recorded, and prominently: `provider-status-sweep.md` section 5 opens by
naming it as "a second in-region exception, and unlike D12's it was not named in
advance, so the reasoning is recorded in full", then traces both consumers. The
reasoning is sound and traced rather than asserted: consumer A's `true` arm is a
Twilio resource DELETE whose safety argument is written at `:483-486` and does
not survive an unknown state; consumer B is the exposed polarity but cannot be
flipped alone without re-opening the permanent-refusal loop that fix wave 4's H1
removed (`groupSend.ts:412-424` -> `ensureGroupRail` -> adopt -> fail). Spec
Sec 10 tells a sweep not to redesign a subsystem, and this is that.

Verdict: DEVIATED(recorded), honors spec intent. No action.

### F2. Proof 9's groupSend half is a grep, not a test - permitted by RULING

Spec 7.9 asks that "the two `groupSend` callers behave exactly as on `main`".
The service suite proves the mechanism half properly ("with the flag ABSENT
neither read ladders, on the very create path the flag changes" - it asserts the
FLAG path, not merely `wasAdopted`, which is what the plan demanded). The other
half - that `groupSend` in fact passes no flag - is verified by grep and recorded
in `slice-4.md:180-181`, which is exactly what worklist RULING S4 permits ("read-only
assertion via a groupSend test if one exists, else by grep in the slice report").
Independently confirmed here: `services/groupSend.ts` does not appear in
`git diff --name-only 1af02926..HEAD`, so it cannot pass a flag that did not
exist before the branch.

Verdict: PARTIAL by design, permitted, adequately evidenced. No action.

### F3. The claim primitive is not vacuous anywhere it matters

Traced rather than credited:

- Both `claimFanoutPass` bodies use a conditional `ADD` with `ReturnValues:
  'UPDATED_NEW'` and disambiguate `ConditionalCheckFailedException` with a
  `ConsistentRead: true` `GetCommand` - not the eventually-consistent
  `getById` / `getByTsMsgId` the plan flagged as the trap
  (`broadcastsRepo.ts:664-681`, `messagesRepo.ts:2812-2833`).
- The existence predicate is asymmetric as ruled: `attribute_exists(broadcastId)`
  vs `attribute_exists(tsMsgId)` (the RANGE key). The messages missing-case test
  exercises BOTH a live conversation with an absent `tsMsgId` and an absent
  partition, which is what makes the range-key predicate meaningful.
- Both harness fakes REFUSE at cap and return the unchanged count, and the
  broadcasts fake reads/writes `broadcasts.get(id)` rather than the shallow copy
  `getById` returns - so the close-B seeding in `broadcastFanOut.test.ts` is
  honored rather than silently ignored. A rubber-stamp fake would have made
  every cap test pass vacuously; it does not exist here.
- Proof 1 uses `setRecipientDelivery` (wholesale slot SET), not
  `updateRecipientDeliveryStatus` (child-field SET), and the test says in-line
  why - the latter would be green against the very slot-resident design D2
  forbids.

### F4. D6's two properties both hold at the call site

Traced from the handler, not from the plan's prose:

- The claim sits BELOW the job-execution-marker return and below the not-found
  return in both files (`broadcastFanOut.ts:314` is after `:228`/`:239`;
  `relayFanOut.ts:870` is after all six early returns ending `:792`).
- The `pending` guard is computed from the same point-in-time snapshot the
  in-loop terminal skip reads (`relayFanOut.ts:870-872` maps through
  `relayMemberKey` against `snapshot.delivery_recipients`), so an all-terminal
  pass claims nothing. Both suites assert the counter stays ABSENT on that path.
- The one bounded departure - a pass whose recipients are all non-terminal but
  all SKIPPED inside the loop still spends a rung - is stated in the plan itself
  (2a, "Known bounded deviation from D6"), so it is a design-level acceptance,
  not a build deviation.

### F5. D7/D11 verified against the ASSERTED literals, not the derivation

- Broadcast: `broadcastBackoffMs(nextAttempt)` retained (`:591`), close A at
  `claim.attempt >= MAX_BROADCAST_ATTEMPTS` (`:577`). On `main` the cap fired at
  `(payload.attempt ?? 1) + 1 > 3`, i.e. `payload.attempt >= 3`. Identical
  trigger, identical argument.
- Relay: `fanOutBackoffMs(claim.attempt)` (`:1073`) where `main` passed
  `payload.attempt ?? 1`. `claim.attempt` equals the envelope's attempt on every
  production path, so the value is unchanged and the deliberate broadcast/relay
  difference is preserved, not normalised.
- Both suites assert `delaySeconds` as observed by the queue adapter
  (`[10, 20]` and `[5, 10]`), never `broadcastBackoffMs(n)` / `fanOutBackoffMs(n)`.
  The pass COUNT is asserted separately (3 sends / 3 sends to BOB), so a ladder
  shifted a step cannot hide.
- The `deliverDelayed` transitive-drain trap was handled: both close-A tests
  shift one continuation at a time. A single `deliverDelayed` would have run
  passes 2 and 3 together and erased both delays.

### F6. D12 is genuinely untouched

The only change at both `throw` sites is the comment above them
(`broadcastFanOut.ts:534-545`, `relayFanOut.ts:990-1002`). The corrected text is
factually right and was independently confirmed by the sweep against
`jobs/jobs.ts:188` and `retrySend.ts:122-128`. Both carry the tier-1
`TODO(throw-for-redelivery-defeated-by-job-marker):` marker.

### F7. The dashboard override reaches exactly three positions and no fourth

Traced from each render site rather than from the table:

- rollup: `Timeline.tsx:914` passes `relay: isRelayLeg` into
  `presentRelayDelivery`, which forwards its whole opts bag to `deliveryReason`
  (`deliveryStatus.ts:415`). `RelayDeliveryOptions extends DeliveryReasonOptions`
  (`:344`), so the flag arrives.
- accessible name: `Timeline.tsx:585` inside `recipientSummaryName`, whose
  `rosterKind` parameter is already in scope (`:568`).
- per-recipient row: `Timeline.tsx:1065`.
- message-level 1:1 bubble `:864` passes NO relay flag and carries a comment
  saying that is a decision, with D20 as the reason - correct, because that site
  reads the MESSAGE's `error_code`, which on this surface is the native
  group-text aggregate whose 30003 retry is real.
- `EmailCard` and `DeliveryBadge` are untouched; `DeliveryBadge` calls
  `deliveryReason(errorCode)` with no options, so the relay map cannot reach it
  while the internal-code map still does - which is what makes proof 11's fourth
  position real and proof 10's badge exclusion free.
- Precedence is media-first, relay-second, base-last (`:701-703`) and is pinned
  by tests even though nothing observable depends on it today.

### F8. INTERNAL_CODE_REASONS entries genuinely carry no tail

`deliveryReason` early-returns the internal reason at `:690-691`, before the
`mapped` chain and before the `(error <code>)` template at `:704-706`. Both new
strings are therefore tail-free by construction at every position, and the tests
assert the absence of `(error ` and of the raw token in all four.

### F9. The e2e spec proves what it claims

- Lean lane via `createGroupOpen`, with the create-time intro SETTLED on both
  members before `setDeliveryOutcome` is armed - the one-shot destination-keyed
  fixture would otherwise be spent on the intro and the spec would pass green
  against a broken build.
- The positive assertion runs first with a 60s budget; the negatives follow. An
  ordering that asserted the negative first would pass on any build.
- The per-recipient list is asserted `toHaveCount(0)` BEFORE the reveal click,
  which is what makes the post-click assertions meaningful.
- The delivered member is a control row, so the override is shown to be scoped
  to a failed leg.
- Recorded deviation (slice-7 #3): no separate browser-level RED run. The
  pre-fix rendered string is captured in `.superpowers/gates/s5a-red.log` and the
  position-1 assertion is a strict substring `main` cannot satisfy. Accepted.

---

## 4. NOTES (judgment calls, no action required)

**N1. A comment in `broadcastFanOut.ts:563` is now slightly off.** It reads
"Beyond the cap -> mark those failed"; after this change the close fires AT the
cap (`claim.attempt >= MAX_BROADCAST_ATTEMPTS`), not beyond it. Slice 2 recorded
leaving it (deviation 4) and handed it to slice 6's comment sweep; slice 6
corrected only the two false jobId comments, so the handoff quietly lapsed. The
line is pre-existing and pre-existing non-ASCII, so touching it has its own
cost. Cosmetic; flagged so the next editor does not read it as a mechanism claim.

**N2. `presentRelayDelivery` gained a boolean `relay`, not the `rosterKind` the
plan's wording named.** Recorded as a judgement call in `slice-5a.md` section 6,
with the reasoning that it mirrors `media` exactly - which is literally what the
plan asked for ("consulted the way `media` already selects
`MMS_ERROR_CODE_REASONS`") - and keeps a product enum out of a function whose
contract is "code plus hints". Behaviorally identical at all six call sites.
Conforms to D19/D21; only the plan's noun differs.

**N3. Non-ASCII on added lines exists ONLY in design-review records.** A byte
scan of every added line in the branch diff finds 35 non-ASCII lines, all in
`docs/superpowers/reviews/.../design-review/*.md` (7 files), and all of them
quotations of live product strings under discussion (the 30003 em dash) or
ellipses inside quoted code. `app/`, `dashboard/`, `e2e/`, `docs/issues/`, the
spec and the plan are 100% ASCII on added lines. AGENTS.md enumerates specs,
plans, prompts, issues, labels, comments, seed strings and test names - review
records are not in that list, and quoting an em-dashed string accurately is
arguably the point. Recorded, not raised.

**N4. `rail-verify.ts`'s opt-in is largely inert and is said so three times.**
RULING groupRail #2 required the flag anyway as the D16 contract; the slice
report and the issue update both state the inertness and name the single path
(dead-adoptee delete-and-recreate) where it bites. Conforms.

**N5. The operator log message changed on both fan-outs.** From
"transient retry cap reached - remaining recipients marked failed" to
"fan-out closed - remaining recipients marked failed", with the reason moved
into a `closeCode` binding. Recorded in both slice reports with the grep that
proved nothing depends on the old string. Correct: three closes share the line,
so the cap-specific wording would have been false for two of them. Operators or
dashboards keying on the old message would need to be re-pointed - worth a line
in the handback, not a fix.

**N6. The unreachable-by-construction guard is a fourth CALL SITE, not a fourth
close.** `broadcastFanOut.ts:565-573` and `relayFanOut.ts:1038-1046` close with
`transient_cap` if `claim` is somehow not `claimed` at the continuation. Both
slice reports name it and explain why closing beats falling through (falling
through would finalize with recipients still queued - the exact failure the
slice removes). It has no production trigger, so it does not disturb the D8
three-closes accounting.

---

## 5. Could not verify

1. **Gate results (`typecheck`, `npm test`, `smoke`, `e2e`, eslint).** Out of
   charge and the full e2e gate is running on this machine; no suite was run
   here. Gate verdicts rest on the orchestrator's evidence, not on this review.
2. **RED-ON-MAIN for close C is second-hand.** The failure output is quoted
   verbatim in `slice-2.md` section 3 (`expected 'queued' to be 'failed'`,
   exit 1, 5 failed / 23 passed) and `slice-3.md` section 3. The shape is
   exactly right and the method used - run the new tests against the untouched
   job, rather than the worklist's comment-out-the-fix alternative - is stronger
   than what was asked for. Not independently re-run.
3. **The e2e spec's runtime behavior.** Read for construction only; the suite
   was not driven. Its selectors match `selectors.md`'s updated contract and
   `Timeline.tsx`'s live reveal gate, which is as far as a static read goes.
4. **DynamoDB Local concurrency case (proof 2) actually racing.** The test fires
   8 parallel claims and asserts exactly `1..8`; whether the local emulator
   serialises them differently from real DynamoDB is unknowable from a read.
   The implementation is a single conditional `ADD`, which is the correct
   primitive regardless.
