# Spec review R3-B (adversarial) - relay 30003 retry lineage, revision 3

Spec: `docs/superpowers/specs/2026-09-02-relay-30003-retry-lineage-design.md` (rev 3)
Adjudications read: `spec-r1-adjudications.md`, `spec-r2-adjudications.md`.
Tree: `W:\tmp\relay-30003-retry-lineage`, code identical to base `bb54fdaa`.

Everything below was opened and read in this worktree. Findings 1-8 CHANGE A
DECISION. Findings 9-13 are WORDING - seams and stale cross-references, no
mechanism moves. The two direct questions asked of this round are answered in
"Answers to the two questions" at the end, including the paths I attacked and
found SAFE.

---

# CHANGES-DECISION

## 1. [BLOCKING] D8's state gate never says where the post-write state comes from, and both available reads are eventually consistent - the naive build claims nothing, intermittently

**What is wrong.** D8 gates on "the leg's slot after this callback's write is
terminal AND its error code is 30003". Nothing in the handler holds that value,
and the two obvious ways to obtain it are both wrong.

**Evidence.**

- `updateRecipientDeliveryStatus` returns a bare `boolean`
  (`app/src/repos/messagesRepo.ts:3443`, returns `true` at `:3516`, `false` at
  `:3457`, `:3465`, `:3511`). It has no `ReturnValues`. So the handler learns
  only whether a transition happened - the thing D8 has just stopped gating on.
- The handler's own `source` read happens BEFORE the write
  (`twilio.ts:2449`, write at `:2466-2472`), and pre-write the slot is `sent` or
  `queued` - not terminal. Gating on the pre-write read never claims at all.
- A post-write re-read through `messages.getByTsMsgId` is an
  EVENTUALLY CONSISTENT `GetCommand` (`messagesRepo.ts:2960-2965`, no
  `ConsistentRead`). Issued microseconds after the update, it can legitimately
  return the pre-write item: slot `sent`, no error code, gate false, NO CLAIM.
  Nothing retries - the webhook 200s and the outcome is lost.
- The repo already knows this hazard and has the tool. A private
  `getMessageConsistent` exists (`messagesRepo.ts:1885`) and is used by six
  sibling recipient-slot mutators (`:3017`, `:3085`, `:3136`, `:3196`, `:3238`,
  `:3366`). `append`'s own dedupe path uses `getSidPointer(..., { consistent: true })`
  for exactly this reason, with the rationale written out at `:2310-2312`
  ("the read is strongly consistent so 'absent' is not a race"). D8 names none of
  them.
- Note `updateRecipientDeliveryStatus`'s OWN read at `:3447-3449` is also
  eventually consistent - it is one of the few slot mutators that does not use
  `getMessageConsistent`. Its write is still safe because it is conditioned on
  `delivery_recipients.#mk.#st = :prev` (`:3500`), but that guard protects the
  write, not a caller reading state back.

**What it implies.** The whole feature fails open-loop and intermittently: some
30003s claim, some silently do not, and nothing distinguishes them in a log. This
is worse than the transition gate it replaced, because the transition gate at
least had a deterministic answer.

The cheapest correct remedy is also free of a second read: the repo call already
holds the pre-write slot and knows exactly what it wrote, so returning the
effective post-write `{status, errorCode}` instead of a boolean is race-free by
construction. `messagesRepo.ts` is already in Sec 2's In-list. Failing that, D8
must say "strongly consistent re-read" and name `getMessageConsistent`. Either
way the spec has to decide it; a builder reading D8 today writes
`getByTsMsgId`.

## 2. [BLOCKING] `unconfirmed` covers only half the silence, so a rung that reached `sent` and never gets a receipt reads `retrying` for ever - and D18's new ticker clause then never terminates

**What is wrong.** D18 defines exactly one non-terminal escape: "`unconfirmed` is
a rung that has not reached `sent` within `STALE_SENT_AFTER_MS` ... measured from
the RETRY ROW's own `at`." D19's table has four states and no other one absorbs a
rung that DID reach `sent` and then went quiet. That rung is `retrying`, for ever.

**Evidence.**

- The sent-but-silent case is real, is the reason today's staleness feature
  exists, and is documented as a shipped production incident: `STALE_SENT_AFTER_MS`
  (`deliveryStatus.ts:58`) and `STALE_SENT_PRESENTATION`'s docblock at `:60-72`
  ("An over-budget MMS is discarded by the carrier with NO receipt and NO error
  code ... the row sits at `sent` forever ... That is exactly how the 2026-08-19
  drop went unnoticed").
- Today that case is handled for a relay leg by `stalenessClockMs`'s `sent` row
  (`deliveryStatus.ts:215-216`) feeding `isStaleLeg`. D18 severs from that helper
  - correctly, for the `queued` half - and re-implements only the `queued` half.
- Consequence one, display: the chip reads `1 retrying` indefinitely for a rung
  the carrier never reported. That is the M5 falsehood this branch exists to
  remove, arriving through the new state machine rather than through the error
  code.
- Consequence two, termination: D18 now makes a live retry ARM the ticker
  (`hasTickableLeg` gains a retry-state clause). `hasTickableLeg`'s docblock
  enumerates FOUR shipped non-terminations it exists to close
  (`Timeline.tsx:1799-1815` and `:780-797`), and the termination proof is that
  the predicate flips false. A `retrying` state with no upper bound never flips,
  so the interval runs for the life of the mount - the fifth. The docblock's own
  clause 1 is precisely this failure ("a STALE leg stays non-terminal for ever,
  so the interval would run permanently on exactly the threads this feature
  targets").

**What it implies.** `unconfirmed` must be defined over BOTH shapes - a rung that
has not reached `sent`, and a rung that reached `sent` and has been quiet - both
measured against `STALE_SENT_AFTER_MS`. That also gives the ticker clause the
bound it needs to terminate, so the two consequences close together. Without it
the design ships the exact falsehood it was written to kill, and re-opens a class
of bug the presenter has four scars from.

## 3. [HIGH] The projected `{status, errorCode}` cannot overload `status` - doing so renders `retrying` as NO state, silently, at two of the three positions

**What is wrong.** D19 says the join "produces an effective `{status, errorCode}`
per member key" and that `presentRelayDelivery`, `orderRecipientRows` and every
`recipientSummaryName` call consume it. The names `status` and `errorCode` are
the slot's own field names, so a builder will widen the slot's `status`. Every
downstream consumer is exhaustive over `DeliveryStatus` and fails SILENTLY on a
value outside it.

**Evidence.**

- `RelayDeliverySlot.status` is typed `DeliveryStatus`
  (`deliveryStatus.ts:151-152`), whose members are
  `queued_pending|queued|sent|delivered|undelivered|failed`
  (`messagesRepo.ts:120-126`).
- `presentDeliveryStatus` is an OWN-PROPERTY lookup that returns null for
  anything else, deliberately (`deliveryStatus.ts:128-141`).
- `presentLegDelivery` returns that null unchanged (`:544`), and a null leg
  renders the member's name and NO state chip - stated as its contract at
  `:505-507`, implemented at `Timeline.tsx:1120-1122` and `:1134`. So `retrying`
  and `delivered-on-retry` produce a row and a recital entry with the person's
  name and nothing else.
- `presentRelayDelivery` counts only `s.status === 'delivered'` and
  `s.status === 'failed' || 'undelivered'` (`deliveryStatus.ts:410-413`), with
  `total = fanned.length` (`:414`). A `retrying` value is in `total` and in
  neither bucket, so `failed` is 0, the `failed > 0` branch at `:416` is skipped,
  and the chip falls to the NEUTRAL `delivered 3/4` at `:456` - not D19's
  `delivered 3/4 - 1 retrying` in danger tone.

**What it implies.** The failure mode is silent at both positions: no throw, no
type error at the boundary if `status` is widened, just a chip that undercounts
and rows that say nothing. The retry state must be a SEPARATE discriminated field
carried alongside the real `DeliveryStatus`, and `presentLegDelivery` and
`presentRelayDelivery` must branch on it BEFORE their existing lookups. D19's
current wording actively points the other way.

## 4. [HIGH] D18's ticker clause forces the join to the THREAD level, which contradicts where D18 and D19 place it

**What is wrong.** D18 says "`hasTickableLeg` gains a retry-state clause". D18 and
D19 both place the join at the presenter - "The presenter is given the recipient
ENTRIES ... and the retry rows that reference this message", i.e. inside
`MessageBubble`. `hasTickableLeg` cannot see anything computed there.

**Evidence.**

- `hasTickableLeg(msg, tickNow)` takes a single item (`Timeline.tsx:798`), and
  `tickerArmed` maps it over `visible` with no other input
  (`Timeline.tsx:1851-1854`).
- `visible` is the memo D20 puts the retry-row filter in
  (`Timeline.tsx:1787-1799`), so by the time `tickerArmed` runs, the retry rows
  have been REMOVED. The clause must therefore attach to the ORIGINAL's item and
  be fed the retry rows separately.
- `hasTickableLeg`'s docblock states the invariant a sixth clause must preserve:
  "The gate mirrors what the bubble actually RENDERS: a leg nothing presents
  cannot change any pixel, so it must not buy an interval. FIVE clauses carry
  that mirror, and each one names a real rendering decision made elsewhere"
  (`Timeline.tsx:780-797`).

**What it implies.** The join has to be computed ONCE per thread over `items`,
above both `visible` and `MessageBubble`, and passed down to both the ticker
predicate and the bubble. That is a different shape from the one D18/D19
describe, it changes what `Timeline` owns, and it is the third consumer of the
projected set after the five render sites D19 enumerates. Say so, or the build
computes the join per bubble and the ticker clause has nothing to read.

## 5. [MEDIUM] The retry job's transport MODE is unspecified, and the original can legitimately be a LEGACY row

**What is wrong.** D10 extracts a loop body that branches on `transport.kind`
throughout, and D2 mandates a schema-1 retry row - but nothing says which mode the
retry job runs, or what happens when the ORIGINAL is schema-absent.

**Evidence.**

- The fan-out picks its mode from the SOURCE row's schema:
  `relayFanOut.ts:791-795` routes to `runLegacyRelayFanOut` whenever
  `sourceMessage.transport_schema_version !== TRANSPORT_SCHEMA_VERSION`.
- Legacy relay sources are not hypothetical: the transport-fidelity work merged
  on 2026-09-02, so every relay source row written before it is legacy, and those
  legs carry `relaysid#` pointers and still produce callbacks.
- `updateRecipientDeliveryStatus` has NO schema guard (`messagesRepo.ts:3443-3466`
  checks only slot existence and `ALLOWED_PRIOR`), so a legacy leg reaches
  terminal/30003 exactly like a versioned one and passes D8's gate.
- If the retry job mirrored the original into `transport.kind === 'legacy'`, the
  extracted body's `persistRelayRecipientResult` takes the `markRecipient` branch
  (`relayFanOut.ts:1436-1439`) -> `setRecipientDelivery`, a BLIND WHOLE-SLOT write
  (`:1450-1463`) that erases the `transportAggregationState: 'planned'` and
  `requestedTransport` D2 has just mandated; and `setVersionedAggregationState` is
  skipped entirely (guarded at `:1179`).

**What it implies.** The rule is one sentence and the plan needs it: the transport
mode is derived from the RETRY row, which D2 fixes at schema 1, never from the
original. Otherwise a 30003 on any pre-merge relay message produces a retry row
whose seeded slot is written blind and whose aggregation state is meaningless -
and the D2 paragraph that finding R2-3 bought is silently bypassed.

## 6. [MEDIUM] A legitimate 30003 does NOT always leave the slot terminal-plus-30003, so the state gate can refuse a real first failure

**What is wrong.** D8 assumes terminal-plus-30003 is the signature of a 30003
failure. The error code is written only by a COMMITTED transition, so a prior
code-less terminal callback poisons the test.

**Evidence.** `updateRecipientDeliveryStatus` appends the `errorCode` clause only
`if (errorCode !== undefined)` (`messagesRepo.ts:3477-3481`), and only when the
update commits - the `ALLOWED_PRIOR` check at `:3459-3466` returns `false` before
any write otherwise. `ALLOWED_PRIOR` admits `undelivered` and `failed` only from
`queued`/`sent` (`messagesRepo.ts:129-138`). So:

- callback 1: `failed` with no `ErrorCode` (the handler already anticipates this
  shape - `twilio.ts:2693-2698` notes "a failed/canceled callback may carry no
  error code"). Slot -> `failed`, no code.
- callback 2: `undelivered` with `ErrorCode` 30003. Current status `failed` is not
  in the allowed set, so nothing commits and the 30003 is never written.
- D8's gate reads terminal-plus-no-code and refuses. The retry is lost silently.

**What it implies.** This is the honest answer to "is there a path where a
legitimate first failure does not leave the slot in that state" - yes, and it does
not need a legacy row or a race, only two callbacks in an order the handler
already documents as possible. The gate should read the code from the CALLBACK
(which is authoritative about this event) and the terminality from the SLOT
(which is authoritative about the chain), rather than taking both from the slot.
That also removes the dependence on whether the code happened to be persisted.

## 7. [MEDIUM] D7's fail-closed fence plus D23 turns a transient read miss into both a lost retry and a false alarm, and Sec 9 does not record it

**What is wrong.** D7 correctly makes the fence positive so a read miss cannot
claim against a tour-reminder rung. The other side of that trade is not recorded.

**Evidence.** The source read is a single unretried, eventually-consistent
`getByTsMsgId` (`twilio.ts:2449`; `messagesRepo.ts:2960-2965`). On a miss D7
refuses to claim; the handler then `res.status(200).end()` (`twilio.ts:2560`), so
Twilio will not redeliver. Under D23 the leg is terminal with no chain, so it also
logs ERROR.

**What it implies.** One DynamoDB blip permanently loses a retry AND raises an
alarm that says a tenant was unreachable when the truth is that we could not read
a row. Sec 9's residual list has the stranded claim and the earlier
slot-write window but not this one. Either the source read gets the one retry the
same handler already uses for the pointer lookup (`twilio.ts:2540-2557` waits and
re-reads), or the exposure is written down.

## 8. [MEDIUM] D23 leaves the middle undecided: a fan-out leg whose claim was DECLINED for a non-terminal reason

**What is wrong.** D23 now has three explicit buckets - WARN while claimed, ERROR
once terminal, WARN for the fenced announcement legs. A fan-out or team leg whose
claim was declined for a reason that is not about the chain falls in none of them.

**Evidence.** Two such reasons are decisions of this very spec: D5's "missing or
malformed `To` means DO NOT CLAIM", and D7's fail-closed source read (finding 7).
Both produce a fan-out leg, passing no fence, with no retry and no chain. D23's
founder-facing bound is "the increase is bounded to the legs a retry ladder
actually ran for" - which is precisely the set these are NOT in.

**What it implies.** As written the rule is ambiguous exactly where the alarm
volume estimate the founder is signing off depends on it. Decide it: I would put
both at ERROR (a leg that will never be retried IS a dead end for a tenant, which
is D23's own argument) and say so in the sign-off paragraph, rather than leave the
builder to infer it from "terminal".

---

# WORDING

## 9. [LOW] Sec 5 still says the message-level chip is excluded while D19 lists it as a projection consumer - and that site is unreachable for any retry state

Sec 5's opening keeps "the message-level chip stays excluded", but D19's
five-site list includes "the message-level chip's accessible name
(`Timeline.tsx:978-989`)". Both cannot be the rule. Worth resolving in D19's
favour with a note that the site is inert here: `messageChipName` is reached only
when `showRecipients && deliveredSummary === null`, which the code's own comment
says "only happens when every leg opted out" (`Timeline.tsx:975-977`) - and an
opted-out leg was never sent, so it has no `relaysid#` pointer
(`relayFanOut.ts:1127-1156` returns before `:1263`) and can never carry a retry.
Saying so stops a builder hunting a test case that cannot exist.

## 10. [LOW] D11 and D17 disagree on how many lineage fields reach the client

D11 (rev 3) says "five lineage values; four reach the wire" and enumerates them.
D17 still says "**Three** lineage fields are added to `TimelineMessage` and to the
relay projector" - the sentence was not edited when the original's direction
became a fifth stored value. D11's enumeration is the one to keep.

## 11. [LOW] D9 and D14 cite "the terminal ERROR of D22"; the severity decision is D23

`D9` (line 271) and `D14` (line 355) both say "emits the terminal ERROR of D22".
D22 is the orphaned-bubble decision; the severity decision is D23, which D10
(line 298) cites correctly. Stale from the renumbering.

## 12. [LOW] Sec 7's test list is numbered 1..12, 15, 16, 13, 14

The two tests added this round were appended in place rather than renumbered, so
the list runs 12, 15, 16, 13, 14. Test intentions are the plan's traceability
handles; a duplicated or out-of-order index is how one gets dropped.

## 13. [LOW] Sec 2's In-list omits the module every projected entry funnels through

`includedRecipientEntries` and `isRecipientExcludedFromPresentation` live in
`dashboard/src/lib/messageTransport.ts:43-56`, and every consumer of the projected
set passes through them (`Timeline.tsx:802`, `:902`; `deliveryStatus.ts:407`).
They are generic over `RecipientPresentationFields` (`:49`), so a widened
projected type probably flows without an edit - but "probably" is what an In-list
exists to settle, and the file is not on it.

---

# Answers to the two questions

**(a) Attacking D8's state gate.** I could NOT find a path where the slot reads
terminal-plus-30003 and a claim is wrong. The cases I tested:

- A repeated or redelivered callback on a slot that is permanently
  terminal/30003 DOES re-pass the gate every time - but the claim is neutralised
  by D3, because the same root, destination and attempt yield the same digest and
  the create loses. Verified against `append`'s index-1 attribution
  (`messagesRepo.ts:2295-2306`).
- The 30007-then-30003 contradiction is closed as D8 claims: the slot keeps
  30007, because the second callback cannot transition and so never writes its
  code (`messagesRepo.ts:3459-3466`, `:3477-3481`).
- A `delivered` slot carrying a stale 30003 is unreachable: `delivered` is
  admitted only from `queued`/`sent` (`messagesRepo.ts:129-138`), so nothing can
  follow an `undelivered`/30003.
- A concurrent callback for a DIFFERENT member is safe. Writes are child-field
  SETs on distinct `delivery_recipients.#mk` paths, each conditioned on
  `delivery_recipients.#mk.#st = :prev` (`messagesRepo.ts:3474-3476`, `:3500`),
  and the gate reads only its own member's slot. No cross-member interference.
- A blind whole-slot `setRecipientDelivery` cannot corrupt the gate on the
  callback path: the callback always goes through
  `updateRecipientDeliveryStatus`, and `markRecipient`/`setRecipientDelivery` is
  reached only from the fan-out's legacy branch (`relayFanOut.ts:1436-1463`).
  That branch matters for finding 5, not for the gate.

The failures I DID find are the other direction - a legitimate failure that does
not reach the gate's state (finding 6) or whose state cannot be read reliably
(finding 1). The gate's SHAPE is right; its inputs are unspecified.

**(b) Can the inbound recital express the new states?** YES, conditional on
finding 3. `recipientSummaryName` takes `rows: RecipientRow[]`
(`Timeline.tsx:573-581`) built by `orderRecipientRows(recipientEntries, relayRoster)`
(`:520-534`, called `:941`), so a projection applied to `recipientEntries` reaches
the inbound call site (`:993-1004`) with no further plumbing - its other argument,
`headline`, is the constant `RECIPIENT_LIST_LABEL`, which needs nothing from the
join. The recital then derives per row through `presentLegDelivery` and
`deliveryReason` (`:593-597`), which is the same pair the visible row uses - so
one projection genuinely serves both, exactly as D19 claims. The only thing that
breaks it is overloading `status`, which makes both positions render the member's
name and nothing else. Fix finding 3 and the inbound half of the contract works.

---

# Verdict on the round-2 fixes

Correct, not merely plausible: the seeded slot (D2, matches
`messagesRepo.ts:3112-3126` exactly), the fifth lineage value and the filter's
location (D11/D20), the fenced-legs-keep-WARN decision (D23), the new
`conversationsRepo` bump method and its GSI note (D16, matches `:632`, `:699`,
`:1531-1578`), the transient sub-ladder's four parts (D10), the partial-digest
honesty (D5), and the row/recital grammar restored to D19.

Correct in shape but incomplete: the state gate (findings 1 and 6), the ticker
clause (findings 2 and 4), and the project-once-onto-entries shape (finding 3).
All three are the same class - a mechanism named without its inputs - and all
three are cheap to close in prose.

I have no remaining disagreement with any adjudication from rounds 1 or 2.
