# Relay 30003 retry lineage - design

Branch: `feat/relay-30003-retry-lineage`
Worktree: `W:\tmp\relay-30003-retry-lineage`
Base: `main` @ `bb54fdaa`
Issues closed: `relay-30003-retry-lineage` (med),
`relay-30003-classified-transient-retrying` (low)
Issue filed by this mission: `relay-member-key-collapses-two-phones-one-contact`

Read `docs/issues/relay-30003-retry-lineage.md` first, including its
"Design knowledge from M5" section. This document does not restate it; it
decides against it.

## 1. The contradiction

A relay group message fans out one physical send per member. When a carrier
rejects one leg with error 30003 (unreachable handset), that member never
receives the message and nothing tries again. The dashboard is truthful about
the failure - M5 removed the false "will retry" promise - so the current state
is a visible dead end: the operator is told plainly that one person was missed
and is offered nothing.

The server disagrees with itself about the same leg. `TRANSIENT_RETRYING_DELIVERY_CODES`
(`app/src/routes/webhooks/twilio.ts:286`) still classifies 30003 as "still
auto-retrying, not yet terminal", and that classification is the stated reason a
failed relay leg logs at WARN rather than ERROR - keeping it out of the
`hc-<env>-error-logs` alarm and the Recent Errors panel. No relay retry exists,
so the recorded justification is false. That is the second issue, and it is the
server-side half of the same contradiction: both halves are fixed here, together,
because making a retry real changes which of them is true.

**Why relay legs cannot reach the existing 1:1 ladder.** It is not merely that
the relay branch returns early. The 30003 arm (`twilio.ts:2711`) sits downstream
of a path that requires a persisted message row for the provider SID
(`:2590`), and a relay leg has none - it is a slot inside another message's
recipient map, reached through a `relaysid#` pointer. The ladder is
structurally unreachable, so this work branches inside
`handleRelayRecipientStatus` rather than extending that switch. `retrySend` is
also unusable directly: it re-sends through `sendMessage` to the conversation's
`participant_phone`, which on a relay group is the pool number, not a member.

## 2. Scope

**In:** `routes/webhooks/twilio.ts` (the relay branch and the severity
taxonomy), a new retry job under `jobs/`, an extracted per-leg send unit in
`jobs/relayFanOut.ts`, `repos/messagesRepo.ts` (lineage fields only),
`dashboard/src/routes/contact/deliveryStatus.ts`,
`dashboard/src/routes/contact/Timeline.tsx`,
`dashboard/src/routes/conversation/useRelayThread.ts`,
`dashboard/src/api/types.ts`, and
`e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts`.

**Out - hard fences:**

- `services/relayAnnouncements.ts` behavior and every announcement caller,
  including `jobs/tourReminders.ts`. Announcements are never retried
  (`relayAnnouncements.ts:169-171`); D5 fences them out rather than changing
  that.
- Native group-text receipts and the existing 1:1 retry/collapse behavior. The
  presenter is shared; that is not a reason to change them.
- The relay member-key scheme. One contact on two numbers still collapses into
  one delivery slot. Filed as
  `relay-member-key-collapses-two-phones-one-contact` on the founder's
  2026-09-02 ruling; D3 works around it and does not fix it.
- Any status-polling or missed-callback reconciliation sweep. The issue
  excludes it; Sec 9 records what that leaves exposed.
- `ALLOWED_PRIOR` and the forward-only status machine. Untouched - the whole
  point of D1 is that nothing needs promoting.

## 3. Decisions: the claim and the ladder

**D1. A retry is a NEW source message row, not a promotion of the failed leg.**
The failed slot is never rewritten. The retry row carries its own single-entry
recipient map whose leg runs `queued -> sent -> delivered` - transitions the
status machine already permits - so no exception to `ALLOWED_PRIOR` is created
and a late callback from an older attempt still cannot regress anything. This is
the decision that dissolves the state machine three of M5's review rounds failed
to converge, and it is only available because the founder approved a display
contract that permits a second bubble (Sec 5).

**D2. The row's creation IS the atomic claim.** `tsMsgId` is
`buildTsMsgId(providerTs, providerSid)` with the caller supplying both halves
(`messagesRepo.ts:195-198`), and `append` writes the row under
`attribute_not_exists(tsMsgId)` inside a transaction (`:2220`). A retry whose
provider SID is a deterministic function of (root message, destination, attempt
number) therefore claims by construction: a duplicate callback, a duplicate
queue delivery and two concurrent callbacks all lose the create and return
`deduped: true`.

This replaces the durable counter, the per-member map and the parent-seeding
problem that M5's constraint 4 anticipated - there is no nested map anywhere in
this design. It also satisfies M5's constraint 2 exactly: the gate is the
attempt record, never a slot transition, so the ladder cannot silently cap at
rung 1.

Synthetic provider SIDs are already routine (`team-<uuid>` at `api.ts:1803`,
`system-<uuid>` at `relayAnnouncements.ts:228`). Two constraints on the shape:
`splitTsMsgId` splits on the FIRST `#` (`messagesRepo.ts:204-209`), and a raw
member key may itself contain `#`; and a phone number must never enter a sort
key. The SID is therefore `relayretry-<digest>-<n>`, where `<digest>` is a
short hex digest of the root `tsMsgId` and the destination E164, and `<n>` is
the attempt number.

**D3. The ladder is keyed on the DESTINATION PHONE, taken from the callback's
`To`.** `params['To']` is in scope at the relay branch (`twilio.ts:2457`), is
the member's own handset for this send path (`relayFanOut.ts:1168` through
`adapters/messaging.ts:677`), and is discarded today. Keying on the destination
rather than on `relayMemberKey` means a retry is never ambiguous about which
handset it is retrying, even where two of a contact's numbers have collapsed
into one slot. No new slot field is needed: the destination is captured onto the
retry row at claim time, and each subsequent rung reads its own callback.

**D4. Attempt numbering, cap and backoff match the 1:1 policy exactly**: up to
three retries at 60s, 120s and 240s. Matching rather than diverging is what lets
this inherit the standing quiet-hours position unchanged -
`quiet-hours-ungated-automated-paths` already recommends accepting automatic
delivery retries as an explicit exemption because the ladder puts the last
attempt about seven minutes after the original send. That decision does not need
reopening, and this design does not reopen it.

**D5. The fence is the source row's `relay_sender_key`, and it must not be
`system`.** The `relaysid#` pointer carries no kind field
(`messagesRepo.ts:3543-3565`), so a pointer-keyed retry would reach announcement
legs - and `sendRelayAnnouncement` is imported by `jobs/tourReminders.ts:1646`
among four callers. `SYSTEM_SENDER_KEY` has exactly one writer
(`relayAnnouncements.ts:239`), which is the single append behind all four, so
the test cleanly separates fan-out and team legs from announcement legs. The
handler already reads the source row, so this costs nothing extra. A retry row
inherits the original's sender key, so its own failures continue the same chain.

**D6. The trigger is narrow**: a delivery-status callback resolved through the
relay pointer, reporting a failure, carrying error code 30003, passing D5, with
rungs remaining. Nothing else claims a retry. A synchronous 30003 at send time
takes the existing fan-out paths and is not in scope.

**D7. The retry row carries four lineage fields**: the root message id, the
member key of the leg being retried, the destination E164, and the attempt
number. The member key is what the presenter joins on - it must match the
original's slot map. The destination is the claim identity and the
changed-number gate. Both are needed; they are not redundant.

**D8. The per-leg send is EXTRACTED from the fan-out and shared, not
reimplemented.** The loop body at `relayFanOut.ts:1118-1269` now carries the
transport-fidelity machinery merged on 2026-09-02 - the prepare/send split, the
aggregation-state writes, the refusal and transient-code arms. A retry job that
reimplemented it would fork code that is hours old. The extraction is
behavior-preserving and the existing relay suites are its proof.

Reusing `relay.fanOut` itself with a one-member recipient list was considered
and rejected: on a synthetic single-recipient source it double-prefixes the
body (`composeRelayBody`, `:992-998`), can silently send nothing when the
sender-key filter removes the target (`:1019`), re-reads the source through a
five-row window rather than a point get (`:771-779`), and drops the retry
silently on a closed group (`:757`). Four behavior changes inside the hottest
relay path, inherited by every ordinary send, to save one extraction.

**D9. Every attempt re-runs the relay send gates, and a refusal ends the
chain.** Before sending: the group is still open; the member is still on the
roster at the SAME destination this leg was sent to; the member is not
suppressed or opted out. A refusal writes a terminal state on the retry leg with
a close code that says which gate refused, and claims no further rung. This is
what makes acceptance criterion 8 true, and the changed-number comparison is the
reason D3 captures the destination.

**D10. The retry sends the original outbound representation verbatim.** The
composed body - sender prefix included - is stored on the retry row and sent as
stored, never recomposed. Recomposition would silently rewrite the prefix if a
member's display name changed between attempts.

**D11. Attachments are re-presigned on every attempt.** A presigned URL is
never replayed (`relayFanOut.ts:1160-1167`, `retrySend.ts:148`).

**D12. An enqueue failure closes the retry leg terminally**, with a close code
distinct from cap-exhausted. Reusing one code would tell an operator retries ran
when none did - M5's D10, and the reason `relayFanOut` closes on
`enqueue_failed` while `retrySend` does nothing. `closeRelay` is a nested
closure (`relayFanOut.ts:1060`) and is not reusable from outside without
extraction; this design writes the close directly rather than extracting it.

**D13. The inbox bump follows the SEND, not the claim.** Nothing in `append`
touches last activity, SSE, unread counts or push - those are explicit
caller-side calls (`api.ts:1845`, `relayAnnouncements.ts:248`), and the fan-out
makes none of them. So the bump is placed after a successful send, on the
founder's 2026-09-02 ruling that a retry which actually sends may bump the
thread. A claimed retry that is refused at a gate bumps nothing.

## 4. Decisions: what a retry looks like on the wire

**D14. Three lineage fields are added to `TimelineMessage` and to the relay
projector.** The raw row's unknown top-level fields do NOT survive to the
client: every projector spreads a fixed field list
(`contactTimeline.ts:406-464`, `useRelayThread.ts:69-135`,
`buildTimelineFallback.ts:64-104`). The precedent for adding one is
`imported_from`. `RelayRecipientDelivery` is NOT changed - no per-leg retry
state is stored on a slot, which is what keeps D1's promise that the failed slot
is never rewritten.

## 5. Decisions: the display contract

Approved by the founder on 2026-09-02, before this document. The rollup chip,
its accessible-name recital and the per-recipient row move together (M5's D21);
the message-level chip stays excluded.

**D15. Four end states.**

| Situation | Original bubble | Retry bubble |
|---|---|---|
| Retry claimed, chain live | `delivered 3/4 - 1 retrying` | none |
| A retry delivered | `delivered 4/4 - 1 on retry` | `delivered 1/1 on retry` |
| Cap exhausted, or a gate refused | `delivered 3/4 - 1 failed - Phone unreachable (error 30003)` | none |
| Retry sent, no receipt inside the budget | `delivered 3/4 - 1 not confirmed` | none |

The exhausted string is today's, unchanged. Per-recipient rows and the
accessible name recite the same fact in their own grammar
(`Retrying - Phone unreachable (error 30003)`, `Delivered on retry`).

**D16. A retry row renders ONLY when its leg delivered.** A failed attempt
records durably but earns no bubble: the thread shows what reached someone, and
a failed retry reached no one, so showing it would state the same failure twice.
This is a new predicate, NOT a reuse of `retry_of` - the existing collapse rule
hides the PREDECESSOR (`Timeline.tsx:1788-1800`), which would hide the original
and invert the contract.

**D17. "Retrying" appears only where a retry was actually claimed.** It is
derived from the presence of a live retry row, never from the error code. A leg
awaiting a retry must also be subtracted from the failed count, or the chip
would read `1 failed` and `1 retrying` at once.

**D18. A retry that never reaches `sent` falls to not-confirmed, aged from the
retry row's own creation time.** The existing rule refuses to age a `queued` leg
with no send clock (`deliveryStatus.ts:216-222`) because that shape is ambiguous
- a connect-when-ready hold and a fan-out that never ran are byte-identical. For
a retry row that ambiguity does not exist: we created it and enqueued it, so a
leg still `queued` past the budget means the send did not happen. Without this,
a retry claimed but never sent would read "retrying" forever - the same
indefinite promise M5 removed, one level down.

**D19. An orphaned retry bubble reads honestly.** Thread history pages 50
newest-first (`threadPaging.ts:30`), so a retry can render before its original
has loaded. The `on retry` suffix is what keeps that bubble from reading as a
phantom second send. The reverse case - original loaded, retry not - falls back
to today's copy: stale, not false.

**D20. The presenter takes recipient ENTRIES and the referencing retry rows.**
The call site currently discards member keys
(`Timeline.tsx:937`), and a lineage join needs them. Sibling thread items must
be threaded down through `MessageBubble` and `StreamItem`, which receive none
today. `RelayDeliveryOptions` is already an extensible bag chosen for this
(`deliveryStatus.ts:351`).

**D21. There is one relay render surface.** The contact pane never renders a
relay bubble - the server excludes `relay_group` (`contactTimeline.ts:1232`) and
the fallback filters it (`useContactTimeline.ts:191-196`). The contract lives
solely in the conversation thread. No Retry affordance is reachable on a relay
message today, by two independent mechanisms, and this design adds none:
retrying is automatic.

## 6. Decisions: the log taxonomy

**D22. The severity call becomes attempt-aware instead of code-aware.** A relay
leg logs at WARN while a retry is actually claimed - genuinely transient,
genuinely being retried - and at ERROR once the chain is terminal: cap
exhausted, a gate refused, or no retry was claimed at all. The shared
`TRANSIENT_RETRYING_DELIVERY_CODES` set keeps its current meaning for the 1:1
and native-group-text paths, which this branch does not touch; the relay branch
gets its own predicate and its own recorded reason.

**This raises alarm volume and is the one decision that needs the founder's
sign-off at the spec gate.** A terminally undelivered relay leg would begin
reaching `hc-<env>-error-logs` and the Recent Errors panel, where today it is
silent. The alternative - keep WARN and rewrite the comment to say "a single
relay leg is not alarm-worthy at this volume" - is honest and cheaper, and the
issue offers both. The recommendation is attempt-aware, because after this
change a terminal relay failure is a real dead end for a real tenant and nothing
else will surface it.

## 7. What must be proven

Test intentions. The plan owns seams and mechanics.

1. A forward relay 30003 callback claims exactly one retry and enqueues it.
   **Must fail on `main`** - nothing is claimed there.
2. A duplicate callback, a duplicate queue delivery, and two concurrent
   callbacks each produce exactly one send. The claim is the create, so this is
   a test of the create losing.
3. The ladder reaches rung 3 and stops. **This is M5's constraint 2**: the test
   must assert three retries, not "a retry happened" - a design gated on the
   slot transition passes the weaker assertion.
4. An announcement leg claims nothing, including a tour-reminder rung.
5. A gate refusal - group closed, member removed, number changed, opted out -
   sends nothing, ends the chain, and leaves truthful copy. The changed-number
   case must be its own test: it is the one D3 exists for.
6. An enqueue failure still reaches a terminal state, with a close code
   distinct from cap-exhausted.
7. Other members receive no duplicate send, on every rung.
8. A delivered retry cannot be regressed by a late callback from an older
   attempt.
9. MMS retries re-presign and preserve the original body byte for byte,
   including the sender prefix, when the sender's display name has changed
   between attempts.
10. Presenter: all four states of D15 at all three positions, plus the
    subtraction in D17 and the ageing in D18. A retry row that has not delivered
    renders no bubble.
11. The log severity is WARN while claimed and ERROR when terminal, and the 1:1
    and native-group-text paths are unchanged.

**E2E (hermetic).** `relay-30003-no-retry-promise.spec.ts` is UPDATED, not
replaced - it is the checklist for what the new copy must satisfy, and its
negative assertions all survive. The flow: arm one leg to fail 30003, send,
watch the chip go retrying, let the retry land, and assert the original reads
`delivered 2/2 - 1 on retry` beside a second bubble reading
`delivered 1/1 on retry`, with the reachable member having received the body
exactly once. The fake's delivery arming is one-shot per destination
(`fixtures/fakeTwilio.ts`), so the retry naturally lands clean as the next
message to that handset. The 60-second first rung needs a lane-local backoff
override, gated exactly as the other dev seams are and structurally absent in
deployed environments.

## 8. Post-merge obligations

No infrastructure, dependency, environment or migration work. Every new field is
optional and self-creating; a message row written before this branch has no
lineage fields and reads as an original.

Owed at handback:

1. Both issues closed with Resolution stamps; `npm run issues` re-run.
2. `relay-member-key-collapses-two-phones-one-contact` left OPEN, with this
   branch's two workarounds recorded in it (already written).
3. The `quiet-hours-ungated-automated-paths` decision NOT closed, but annotated:
   relay retries now exist and inherit its item-3 recommendation unchanged.

## 9. Risks and residual exposures

**A crash between the claim and the enqueue strands a retry.** The row exists,
nothing sends, and a duplicate callback correctly declines to claim again. The
leg then sits `queued` - which D18 renders as not-confirmed rather than as a
permanent "retrying", so the display stays honest, but the send is genuinely
lost. Closing this needs the reconciliation sweep the issue puts out of scope.
Recorded, not fixed.

**The member-key collapse is worked around, not fixed.** Where two of a
contact's numbers share one slot, the retry knows exactly which handset it is
retrying but displays against a slot that already conflated two legs. The
display was already wrong in that case; this does not make it worse.

**The first observable `To` arrives at `sent`.** The fake emits no callback for
the initial `queued` transition (`fake-twilio/src/engine/engine.ts:500-501`),
which is fine for a failure callback but means nothing in-repo exercises a
callback with `To` absent. The claim path must treat a missing `To` as "do not
claim" rather than assuming one.

## 10. Alternatives rejected

**In-place promotion** - a per-member attempt map on the source row, an explicit
scoped exception to `ALLOWED_PRIOR`, effective status stored on the slot. This
is the issue file's own suggested fix and what M5 could not converge. It
requires the nested-map seeding pattern, an exception to a rule that exists to
stop late callbacks un-failing legs, and it yields one bubble - contradicting
the approved display contract. Rejected on all three counts.

**Reuse `relay.fanOut` with a one-member list** - see D8.

**A dedicated claim item** (a `relayretry#` row with a conditional `ADD`,
mirroring the `relaysid#` pointer) - a clean fallback if deterministic message
keys had not been available. They are, so the retry row is the claim and there
is no second item to keep consistent with it.
