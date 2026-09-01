# Spec round 1 - adjudications

Two independent adversarial reviewers, plan-blind, opus, read-only.
Reports: `spec-r1-reviewer-a.md` (19 findings), `spec-r1-reviewer-b.md` (22).

Counts: **17 ACCEPT, 6 REJECT, 2 DEFER.** The two reviewers converged
independently on the four defects that mattered most, which is why they are
treated as settled rather than as claims.

## Blocking - accepted, and they change the design

### A1 / B1 - the counter is erased every pass. ACCEPT.

**Verified.** `setRecipientDelivery` writes `SET delivery_recipients.#mk = :d`
(messagesRepo.ts:2777-2785) - a blind WHOLE-SLOT set. `setRecipient`
(broadcastsRepo.ts:584-605) does the same for the broadcast slot. The fan-out
calls these on every pass, so an `attempt` field living inside the slot is
overwritten with every status write. The fix as specified would have been a
**no-op that looked correct** - the counter would read 1 forever, which is the
exact failure mode the branch exists to remove.

Both reviewers found this independently. It is the single most valuable finding
of the round.

**Resolution.** The counter moves OUT of the slot into a **sibling top-level
map** on the same item (`fanout_attempts.<key>`, `retry_attempts.<key>`), which
no whole-slot writer touches. This also avoids editing two shared writers whose
child-field discipline was itself the subject of a prior fix wave.

### A2 / B2 - "a delivered attempt wins permanently" is undeliverable. ACCEPT.

**Verified.** `ALLOWED_PRIOR.delivered = ['queued', 'sent']`
(messagesRepo.ts:120-129). There is no `undelivered` predecessor. Once attempt 1
writes `undelivered`, attempt 2's `delivered` callback is rejected as a
regression by the very machine Sec 4.7 said it was keeping. The spec asserted a
guarantee its own mechanism forbids.

**Resolution.** A scoped, explicit lineage transition rather than a blanket
loosening of `ALLOWED_PRIOR` (which would let ANY caller regress a terminal).
A new repo method resolves `undelivered -> delivered` conditionally, and ONLY
when a lineage attempt records a delivered result. Forward-only stays intact for
every other caller.

### A3 / B3 - broadcastFanOut already finalizes. ACCEPT.

**Verified.** The cap branch calls `await finalize(...)` before returning
(broadcastFanOut.ts, cap branch ~:493). My Sec 3.5 called the missing finalize
"the single most user-visible defect in the bundle". **That was wrong**, and as
written it would have produced a double-finalize regression.

What is actually true and stays: if `enqueue` throws, NO path reaches finalize,
so the broadcast stays "Sending". The fix is to route an enqueue failure into
the EXISTING cap-close, not to add a second finalize.

### A4 / B4 - one field, two retry budgets. ACCEPT.

The fan-out continuation ladder and the 30003 retry ladder are different ladders
with different caps and different backoffs. Sharing one `attempt` field lets
continuations silently consume the 30003 chain's retries.

**Resolution.** Two separate counters, two separate caps.

### A5 - "changed destination - refuse" has nothing to compare against. ACCEPT.

The slot carries no destination phone. `relayMemberKey` is `contactId` OR
`phone#<E164>` (messagesRepo.ts:152-158), so the destination is recoverable only
for phone-keyed members - precisely the members whose phone cannot have changed.
For contactId-keyed members, the case the rule exists for, there is nothing
stored.

**Resolution.** The lineage attempt record stores `sentTo` (E164). The rule
becomes checkable.

### A6 / B14 - atomic ADD prevents a duplicate NUMBER, not a duplicate TEXT. ACCEPT.

The 1:1 path gates its retry on `if (transitioned && ErrorCode)` - the
forward-only transition is what makes a duplicate callback a no-op. The relay
branch has no such gate in the spec, so a redelivered 30003 callback could claim
a second attempt.

**Resolution.** The relay retry claim is gated on the slot transition having
actually happened, mirroring the 1:1 path.

### A7 / B6 - the 1:1 site is in scope with no defined change, and Sec 1 misdescribes it. ACCEPT.

**Verified.** The 1:1 count is ALREADY durable: the webhook reads
`message.retry_attempt` (twilio.ts 30003 branch) and the handler stamps it onto
the new message. Sec 1's blanket "every capped retry loop puts the count in the
envelope" is false for this site.

**Resolution.** Sec 1's claim is scoped to the two fan-outs. `retrySend`'s real
and much smaller gap - a throwing `enqueueSendRetry` leaves a chain that never
retries behind a chip that promises one - is stated as its own item, fixed by
the honest chip plus a guarded producer-side enqueue. No counter move there.

### B5 - the "immediate close" contradicts a deliberate policy. ACCEPT.

Sharp, and unique to B. I called the structural guarantee and the immediate
close "complementary"; they are in tension. If the counter already advanced
durably, closing on the first enqueue blip **discards remaining retries** the
design just made reachable.

**Resolution** - the split the spec should have made:

- **Consumer-side** (inside a job: fan-out continuations): let the handler
  THROW. SQS redelivers, the durable counter is already advanced, the cap is
  reachable. Do not close early.
- **Producer-side** (inside the webhook: no redelivery exists): close
  immediately, because nothing will ever come back.

### B16 - the rail ladder sits in a staff HTTP request. ACCEPT.

**Verified.** `ensureGroupRail` is called INLINE from `groupSend`
(groupSend.ts:381, and healRail at :425), which is reached from the send route
(api.ts:1361). A ladder of delayed re-reads would sit inside a staff send.

**Resolution.** The inline backstop does NOT ladder and does NOT repair: a
member Twilio did not refuse is treated as attached. The ladder applies on the
job and import paths only.

### A11 / B8 - Sec 5.2 contradicts Sec 5.3. ACCEPT.

5.2 says a still-unbound member is logged and we proceed; 5.3 says a rail still
short after the ladder "is still a failure". Both cannot hold.

**Resolution.** 5.2 wins and is stated once: a member the create did not refuse
is attached on Twilio's 200. Unbound-after-ladder is logged, never
`rail_failed`. `rail_failed` requires a repair refusal.

## Accepted, non-blocking

- **A8 / B7** - the context-aware 30003 copy has no wire field and no per-leg
  render site. ACCEPT, and it simplifies the fence: the chip stops promising a
  retry **unconditionally** (`Phone unreachable`, code exposed). The
  retry-aware variant needs lineage on the wire, which is T-DELIVERY-CHIPS'
  job. This both honors the fence and stops the lie today.
- **A9 / B9** - E2E test 11 would have to wait out a 60s module constant.
  ACCEPT. The hermetic flow drives job execution directly and asserts lineage
  transitions; it does not wait on wall-clock backoff.
- **A10** - `senderNameOverride` is team-only, so it cannot carry a
  member-authored sender label. ACCEPT: the retry stores the resolved sender
  label on the lineage attempt at first send and replays that.
- **B10 / A14** - `attempts` as an indexed LIST cannot be created by nested
  child-field updates and defeats the child-write race argument. ACCEPT:
  lineage is a MAP keyed by attempt number, so each attempt is an independent
  child path.
- **B11** - the pointer's new `n` needs a read-compat rule. ACCEPT: an absent
  `n` means attempt 1.
- **B12** - `missing` decided by an eventually-consistent follow-up read, and
  `missing` skips the close. ACCEPT: the disambiguating read is strongly
  consistent, and `missing` is logged and treated as nothing-to-advance only
  when the slot genuinely does not exist.
- **B13** - the new job is never registered or metered. ACCEPT: it registers in
  `registerHandlers.ts` and goes through the same breaker/token-bucket metering
  as the fan-out.
- **B15** - Sec 8's message-catalog sentence collides with the convention of the
  file it edits. ACCEPT: `ERROR_CODE_REASONS` is dashboard presentation, not
  automated send copy; the catalog rule does not apply. Sentence removed.
- **A12** - relayFanOut's existing off-by-one continuation backoff sits inside
  the edit. ACCEPT as a stated watch item: preserve current timing exactly, do
  not silently "fix" it in this branch.
- **A15 / A16 / B19 / B22** - factual corrections to the spec text (the em-dash
  quote, the `(error 30003)` tail, the omitted slot fields, Sec 10 vs Sec 6).
  ACCEPT, all precision edits.

## Rejected

- **A13** - "relayFanOut's cap-close emits no refresh event, against Sec 4.7".
  REJECT. Sec 4.7's rule governs the RETRY lineage's effective status, not the
  pre-existing fan-out cap path. Adding an event there is a behavior change this
  branch was not asked for and would land in T-DELIVERY-CHIPS' surface.
- **A17** - use `RELAY_PRESIGN_TTL_SECONDS` rather than `retrySend`'s constant.
  REJECT as stated - no such constant exists to point at; the relay legs presign
  inline. The spec will name the value explicitly instead.
- **A18 / B21** - `ReturnValues: 'UPDATED_NEW'` on a nested path. REJECT as a
  finding, ACCEPT as a note: B marked it UNVERIFIED and it is an implementation
  detail, not a design decision. The revision drops the counter to a top-level
  map anyway (A1), which moots it.
- **A19 / B20** - the slot type is shared with native group text and mirrored in
  `dashboard/src/api/types.ts`. REJECT as a fence violation: the sibling-map
  resolution (A1) means the slot type does not change, so neither surface is
  touched. Retained as a watch item.
- **B17** - "the new rail authority is vacuous on the bulk create path". REJECT.
  The create path returns per-member `failures`
  (groupConversations.ts:539-569); that is exactly the authority the revision
  relies on, and it is not vacuous. B did not show a create path that returns no
  failures list.
- **B18** - Sec 6's audit is unbounded and collides with the fences. REJECT the
  collision claim: the spec already says findings outside the anchor files are
  FILED, not fixed. Bounding accepted as a precision edit (the audit enumerates
  provider-status branches; it does not re-audit the whole app).

## Deferred to the issue registry

- **B5's second half** - whether a transient enqueue blip should ever be able to
  fail a recipient permanently anywhere in the codebase. Beyond M5.
- **A19/B20's mirrored dashboard type** - the hand-mirrored
  `dashboard/src/api/types.ts` is a drift hazard independent of this branch.

## What changed as a result

Four decisions moved, not merely precision edits:

1. The counter's home moved from inside the slot to a sibling map (A1/B1).
2. "Delivered wins" gained an explicit scoped transition instead of relying on
   a machine that forbids it (A2/B2).
3. The immediate-close rule split into consumer-side (throw) and producer-side
   (close) (B5).
4. The dashboard fix became unconditional rather than context-aware, which is
   both smaller and more honest (A8/B7).

Round 2 is warranted.
