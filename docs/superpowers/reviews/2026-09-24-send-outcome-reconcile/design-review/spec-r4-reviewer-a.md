# Spec review r4 - reviewer A (adversarial, final round)

Spec: `docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md`,
revision 4 (@bf2c5bf2). Also read: `adjudications.md` (the round-3 section).
Every code claim cites a file:line read in this worktree; anything not
verifiable is marked UNVERIFIED.

Moving coordination state out of the slot and into a per-recipient attempt
record is the right structure. It closes the round-3 class it targets:
code-in-slot, wholesale overwrites, the D7 regress race and the re-drive
marker. What remains are the RULES around the record. Findings marked
**DECISION** would change a decision in the spec; this is the last round, so
they go to the human.

---

## R4-1 [HIGH] DECISION (D8). The close gate treats a `done` record as closable, so a delivered relay leg can still be closed `failed/transient_cap`. The "no read needed" exemption for the retry gates and the opt-out arm is backwards

**What is wrong.**

1. **D8's gate lets `done/sent` through.** D8 lets a close proceed when the
   record is `done`, whatever the outcome. On relay, a SUCCESSFUL leg ends with
   record `done/sent` while its slot still reads `queued`. The relay success
   write is `status: result.status === 'queued' ? 'queued' : 'sent'`
   (`app/src/jobs/relayFanOut.ts:1455`), and the provider's create response is
   normally `accepted`, which maps to `queued`
   (`app/src/adapters/messaging.ts:558-573`;
   `research/spike-twilio-idempotency-output.txt`). The close loop's own
   terminal test does not cover it either: relay `isTerminal` is
   sent/delivered/failed only (`relayFanOut.ts:189-191`).

   The versioned `failed/transient_cap` write then advances `queued -> failed`
   (`app/src/repos/messagesRepo.ts:141`, `:3386-3413`). The delivered leg now
   reads failed, with a Retry offer, and its later `delivered` receipt is
   refused as a regression. Two routes reach it:
   - **A duplicate first-pass envelope.** Overlapping queued-message flushes
     are the producer named in
     `docs/issues/relay-fanout-active-pass-cap-close-race.md`. If it is capped
     at start, it runs close B over its whole `pending` set
     (`relayFanOut.ts:1114-1133`).
   - **A duplicate re-drive.** D11 says "The enqueue may happen twice". The
     second copy's claim is refused by the first's fresh `attempting` and it
     is "DEFERRED again". Its late rung claim (D13a) finds the ladder spent
     minutes ago and closes. By then the record reads `done/sent`, so D8
     lets the close through.

   On broadcast the same duplicate re-drive closes through a snapshot taken
   while the first copy was mid-send. `closeBroadcast` checks that pass-start
   snapshot (`app/src/jobs/broadcastFanOut.ts:282`) and writes with a blind
   `setRecipient` (`app/src/repos/broadcastsRepo.ts:602-640`), overwriting the
   `sent` slot.

2. **The exemption is backwards.** D8 exempts the relay retry job's gate
   refusals and the relay opt-out arm ("they run before that job's own claim,
   and a foreign open attempt then refuses the claim ... so they need no read
   of their own"). But those arms WRITE a terminal slot before the claim:
   - `refuseGate` (`app/src/jobs/relayRetryLeg.ts:449-467`);
   - the suppression write (`relayFanOut.ts:1324-1331`).

   So a second rung, or a duplicate envelope, overwrites the first sender's
   in-flight slot, and only then is its own claim refused. The refusal
   arrives after the damage.

**What it implies.** Sec 2's claim that D8 "narrows" the deferred race does not
hold for completed-but-`queued` legs, which are the common relay success. The
decision should be:
- a close proceeds only when the record is absent or `done/retryable`;
- a record holding a SID, or any other terminal outcome, refuses it;
- the gate refusals and the opt-out arm read the record too, or run after the
  claim;
- close writes are conditional on the slot still being `queued` with no SID
  (broadcast: `setRecipient(..., ['queued'])`).

---

## R4-2 [HIGH] DECISION (D13). "Identical bodies may adopt each other's messages, which changes no delivery and no count" is false for the cases that motivated it: media-only relay legs and emoji-only bodies

**What is wrong.** Every media-only relay leg carries the same body,
`'{name} sent an attachment.'` (`app/src/messages/catalog.ts:463-465`), and the
same media count. The attachments differ: they are presigned per leg from each
source's own `media_attachments` (`relayFanOut.ts:1360-1368`). Emoji-only
messages normalize to the sender's name, three letters or more, so the
media-count fallback never engages.

D13's claim rule only guarantees that no two attempts adopt the SAME message.
Walk through the case with ONE orphan and two ambiguous legs:
1. Member X gets legs M1 (photo A, never created at Twilio) and M2 (photo B,
   created as O2) during an outage.
2. R1 lists, O2 matches, and R1 claims it.
3. R2 then sees O2's pointer resolving elsewhere and excludes it
   (D13, "held by another attempt").
4. R2 has no claimable match, rules `never_sent`, and re-drives M2.

X receives photo B twice and photo A never, while M1's leg reads delivered. Sec
8 test 8 only exercises the both-orphans case ("each adopt one of two orphans
and neither re-drives"), where the swap really is harmless. A 50/50 on which
reconcile claims first decides the outcome.

**What it implies.** A normalized body plus a media count identifies content
only for text. The decision needs one of:
- (a) when another OPEN attempt (record `attempting`/`reconciling`) for the
  same recipient and sender has the same normalized body and media count, the
  verdict is `unresolved`, never adoption and never `never_sent`;
- (b) media identity in the match. Twilio's per-message Media list gives
  content type and size, not content (UNVERIFIED whether that is enough).

(a) is mechanical: the records carry the body hash and the media count.

---

## R4-3 [MEDIUM] DECISION (D8/D11 ordering). The reconcile job's own closes cannot satisfy D8 and D11 together; either it skips its own close or a crash strands the slot

D8 applies its record read to "the reconcile job's own `redrive_refused`,
`enqueue_failed` and `unresolved` closes ... skips the recipient if the record
is in any state but `done`". At the moment of those verdicts the record is
`reconciling` (or `redriven`), the job's OWN state.

- **Read first:** the job skips its own close. The slot never closes.
- **Transition the record to `done` first, then close the slot:** a crash
  between the two leaves record `done` and slot `queued`. D11 then says "a
  duplicate finds `done` and writes nothing", so the redelivery never writes
  the slot either. A broadcast recipient stays `queued` for ever, so D16a
  never finalizes.

D7's pass-side "an enqueue that throws transitions the record to `done` /
`unresolved` and closes the slot the same way" has the same gap.

The rule should be:
- a writer's own close is exempt from D8 and conditions on ITS record state
  plus `attemptedAt`;
- it writes the slot first (forward-only, idempotent), then the record;
- a duplicate that finds `done` with its own `attemptedAt` and outcome
  re-applies the slot write. RECORD phase and adoption already order things
  this way (slot, then record); the closes do not.

## R4-4 [MEDIUM] Contest of round-3 #8 (conceded): the takeover TTL is longer than the whole continuation ladder, so "never a silent skip" is false for exactly the conceded scenario

The concession: "a FRESH foreign claim makes the continuation DEFER the
recipient again ... and a STALE one (older than the claim TTL) is taken over
... never a silent skip". The TTL is 90 seconds (D8a). The ladders are much
shorter:
- broadcast waits 10 s then 20 s (`broadcastFanOut.ts:86-94`);
- relay waits 5 s then 10 s, and "pass 3 reaches the cap"
  (`relayFanOut.ts:92-101`).

Take a record left `attempting` because its release or deferral write failed
(D7a's residue, and the case #8 was about). Every continuation finds it fresh
and defers. The third pass hits the cap, close A/B reads `attempting`, and D8
SKIPS it. The recipient is never sent, never reconciled and never closed, and
its broadcast stays `sending` (D16a). No send site ever revisits it after the
cap, so the takeover never runs. The fix must not depend on a
revisit: on a failed release the site can retry the release, or a capped close
that meets an `attempting` record older than the TTL can take it over itself
(it is a send site's peer). Otherwise Sec 1 should say plainly that this
residue strands the whole broadcast.

## R4-5 [MEDIUM] "Walk every page up to 20" makes busy pairs permanently `unresolved`

D13 walks EVERY page, and exhausting 20 pages is `unresolved`. The page size is
left to the plan (D17), and twilio-node's default page size is 50 (UNVERIFIED
for this call site). At 50 per page the bound is 1000 messages per To/From
pair, which busy pairs exceed:
- pool numbers multiplex across groups and are reused
  (`app/src/adapters/messaging.ts:608-616`), so an active member on a
  long-lived pool number passes it;
- so does a long-running tenant on the business number.

For those pairs EVERY ambiguous send is `unresolved`, so the busiest members
get a permanent "Not confirmed", and every check costs 20 list calls. The spec
should fix the page size (Twilio's maximum is 1000, UNVERIFIED for the list
endpoint used) or restore an early stop once the first hosted-dev run verifies
creation order.

## R4-6 [MEDIUM] "The D9 brake defers only recipients that have no attempt yet" strands the braked remainder of every continuation pass

In a continuation, every carried recipient already HAS a record (`done/retryable`
from the earlier pass). Read literally, D8's brake rule does not defer them.
After three consecutive `unknown` outcomes the remainder is dropped from the
transient set: no pass lists them again, no close touches them, and D16a never
finalizes the broadcast. The intended rule is presumably "not yet attempted IN
THIS PASS, and record absent or `done/retryable`". Say that.

## R4-7 [LOW] The `redriven` claim rules contradict each other, and one re-drive state is undefined

- D8a allows a claim "from `redriven` (the re-drive pass)" and refuses one "from
  `redriven` while a re-drive is already in flight". Once `redriven` is
  written, a re-drive is by definition in flight, and the record cannot tell
  the re-drive continuation from any other claimant without a token in the
  payload. Allowing the claim to anyone is safe (still one send), so the
  refusal clause should go.
- There is no rule for a `never_sent` verdict when `redriveCount` is already 1.
  That happens when the re-drive came back `retryable` and its ladder attempt
  came back `unknown`. D13a covers only "a re-drive attempt whose outcome is
  `unknown`".
- `retrySend` has no continuation, so "a refused claim is DEFERRED again" has
  no meaning for the 1:1 owner.

## R4-8 [LOW] D15 contradicts D11 on when the broadcast row append runs

D11: "Adoption first CLAIMS the message: the `sid#` row append". D15 lists "the
message row ... (this is the SID claim)" among the writes "gated on the slot
write having moved". The append must come first, as D11 says. The dedupe
result it relies on already exists: `append` returns
`{ deduped: true, tsMsgId }` from the pointer on a duplicate SID
(`messagesRepo.ts:2441-2465`). The relay counterpart does not:
`putRelaySidPointer` swallows the conditional failure and returns nothing
(`messagesRepo.ts:3685-3706`). The plan must change it to report a lost claim.

## R4-9 [LOW] The record's key shape is left to the plan, but its identity carries a phone and a `#`

The record is keyed per owner and recipient, and recipient keys fall back to
`phone#<E164>` (`messagesRepo.ts:193-197`; broadcast `broadcastsRepo.ts:163-165`).
The codebase rule for any destination that lands in a key is to hash it:
"a phone number must never appear" in a key, and `splitTsMsgId` splits on the
first `#` (`app/src/lib/relayRetryClaim.ts:20-24`). The spec should bind the
plan to a hashed recipient component. It should also give the family a TTL
horizon: it grows by one item per relay leg and per broadcast recipient, and
the messages table already has TTL on `expires_at`.

## R4-10 [LOW] D8's safety rests on "absent record = no attempt"; a batched read breaks that silently

A close over up to 1500 broadcast recipients (`broadcastsRepo.ts:54-66`) will
tempt a BatchGet of the records. BatchGet returns unprocessed keys as simply
missing, so an in-flight recipient reads as "no record" and is closed. This is
the codebase's recorded batch-read-absence trap. D8 should require per-key
consistent reads, or a batch read that fails on unprocessed keys.

---

## Adjudications

| round-3 # | ruling | response |
|---|---|---|
| 8 | CONCEDE, "never a silent skip" | CONTESTED (R4-4): TTL 90 s is longer than either ladder, so the conceded scenario ends in a skip at the cap. |
| 5 | ACCEPT, "changes no delivery and no count" | CONTESTED (R4-2): false for media-only and emoji-only bodies. |
| 4 | ACCEPT, the gate and opt-out exemption | CONTESTED (R4-1, part 2): those arms write before the claim. |
| 1-3, 6, 7, 9-14 | ACCEPT | The record structure resolves them as stated. Not re-litigated, except where R4-1, R4-5 and R4-7 test the new rules. |

## Checked and found sound

- **D7's record-first order** (record `reconciling`, then enqueue, no slot
  write while reconciling) removes the round-3 regress race.
- **D11's `attemptedAt`-keyed conditions.** A stale writer and an older payload
  write nothing. The takeover keeps the old `attemptedAt`, so its chain's
  conditions line up.
- **D16a's slot-only open-check.** Reconciling, re-driven and in-flight
  recipients are all `queued`. I found no case where a slot is terminal while
  an open attempt can still change it, other than the R4-1 closes.
- **D13a's late rung claim.** It matches the retry-counter semantics: the rung
  is spent only by a pass that has something to defer, and a capped late claim
  runs the close-A path. The existing "unreachable by construction" branch
  (`broadcastFanOut.ts:587-594`) must be replaced by that claim.
- **D20a against `deliveryStatus.ts:228-255`.** A relay success writes `sentAt`,
  so `attemptedAt` is consulted only for truly unsent legs, and the held-message
  case keeps no clock. Relay retry rungs age from the row clock and are
  unaffected.
- **The 1:1 owner's "this owner".** Once the record is keyed on (original,
  rung), the original message's own SID resolves to another owner and is
  excluded. The round-3 60-second-window concern is gone.
