# Spec review r3 - reviewer A (adversarial)

Spec: `docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md`,
revision 3 (@5d4ee649). Also read: `adjudications.md` (the round-2 section),
`research/spike-twilio-service-settings-output.txt`,
`research/spike-twilio-smart-encoding-output.txt`. Every code claim cites a
file:line read in this worktree; anything not verifiable is marked UNVERIFIED.

The new material (D8a, D11, D13, D7, D16a, D20a/D21) is reviewed first. Most
findings below are in text that did not exist in round 2.

---

## R3-1 [BLOCKING] On relay, a SUCCESSFUL send leaves the slot claimable, so D8a does not stop a second pass or a second re-drive from texting the member again

**What is wrong.** D8a's claim condition is "the slot is `queued` and its code
is not `send_attempting` and not `send_unconfirmed`". D8a says the claim is
"released by the outcome write ... (`sent`, `failed` with a code, ...)". On
relay, success is usually NOT `sent`:

- The relay success write is `status: result.status === 'queued' ? 'queued' : 'sent'`
  (`app/src/jobs/relayFanOut.ts:1455`).
- `result.status` is `mapTwilioStatus(create.status)`, and `accepted`/`queued`
  map to `queued` (`app/src/adapters/messaging.ts:558-573`).
- The spike's create responses were `status: 'accepted'` both times
  (`research/spike-twilio-idempotency-output.txt`), so `queued` is the normal
  case.
- On a versioned row, that success write REMOVES the claim code
  (`isSuccessfulDeliveryStatus('queued')` is true,
  `app/src/repos/messagesRepo.ts:148-150`, and the remove branch is at
  `:3440-3452`).
- A relay `queued` slot is non-terminal (`isTerminal` is sent/delivered/failed
  only, `relayFanOut.ts:189-191`).

So right after a delivered-in-flight send, the slot reads `queued`, no code,
with a SID: exactly what D8a lets the next send site claim. D15 reproduces the
state: "the relay paths keep `queued` for a provider `queued`".

**What it implies.** Both producers the spec names re-send:
- **D11's twice-enqueued re-drive.** "The enqueue may therefore happen twice;
  the send claim (D8a) makes the second continuation a no-op." It does not.
  If re-drive R2 runs after R1's success write, it claims and sends.
- **Duplicate relay envelopes.** Overlapping `relayQueuedMessages` flushes
  (`docs/issues/relay-fanout-active-pass-cap-close-race.md`) do the same.

The window is until the carrier's `sent` receipt lands: sub-second to
minutes, and wider under A2P queueing. Sec 1 guarantee 1 ("two passes, two
continuations or two re-drives for one recipient produce one send") is false on
relay. Fix: the claim condition must also require that no send has been
recorded: `attribute_not_exists(sid)` on relay slots and
`attribute_not_exists(tsMsgId)` on broadcast slots.

---

## R3-2 [HIGH] `send_unconfirmed` names two different states, and three decisions key on the code alone: an unresolved recipient keeps its broadcast `sending` for ever

The code marks a slot that is `queued` (reconcile pending) AND a slot that is
`failed` (the terminal `unresolved` verdict, D16 table: "slot `failed` with
`send_unconfirmed`"). Three rules read only the code:

- **D16a:** `finalize` "returns without writing if any slot is non-terminal or
  carries `send_attempting`, `send_unconfirmed` or `send_redrive`". Every
  broadcast with even one `unresolved` recipient therefore NEVER finalizes: the
  anchor symptom. That contradicts Sec 8 test 11 ("a broadcast with only
  skipped, failed and unconfirmed recipients finalizes `failed`") and makes
  D16a's own terminal-status rule ("at least one is failed or unconfirmed")
  unreachable for the unconfirmed half.
- **D11 bullet 3:** the `never_sent` flip applies "on the condition that it reads
  `send_unconfirmed` or already `send_redrive`". A `failed`/`send_unconfirmed`
  terminal slot "reads `send_unconfirmed`", so a duplicate chain (explicitly
  allowed by D11 bullet 2) that rules `never_sent` after the first chain's
  re-drive closed `unresolved` flips a TERMINAL slot back to `queued`/
  `send_redrive`. It re-drives a second time, breaking D13a's one-re-drive bound
  and reopening a closed recipient.
- **D21:** K "excludes slots carrying `send_unconfirmed`, whatever their status;
  they join J". A `queued` leg in its reconcile minutes counts as "N not
  confirmed" (danger) on the chip, while D20 says the same leg's row "renders
  exactly as a queued slot renders today" ("Sending..."). The chip and the row
  disagree, which `deliveryStatus.ts:553-563` (code review R3, X3) exists to
  prevent.

**What it implies.** Every rule must key on status AND code:
- the open-check: `queued` with those codes;
- the flip condition: `queued` + `send_unconfirmed|send_redrive`;
- J: `failed` + `send_unconfirmed` (keeping "whatever status" only for the
  join-projected root, which is `undelivered`).

---

## R3-3 [HIGH] D7 and D11 contradict each other about a slot that never received `send_unconfirmed`; one reading strands the recipient, the other double-texts

D7: "the job's verdict conditions tolerate a slot that never received the code
(D11), so a slot write that fails after the enqueue still resolves". Such a slot
still reads `send_attempting` (the claim). D11's `never_sent` flip accepts only
`send_unconfirmed` or `send_redrive`.

- **Build it to D11.** The failed-D7-write recipient is ruled `never_sent`,
  cannot be flipped, is never re-driven, and sits `send_attempting` until a
  sweeper that does not exist. D16a also refuses to finalize its broadcast.
- **Build it to D7** (accept `send_attempting`). The flip then also accepts a
  LIVE claim. Chain A rules `never_sent`, flips, enqueues R1, and R1 claims
  (`send_attempting`, new `attemptedAt`) and is mid-send. A duplicate chain B
  (D11 bullet 2) rules `never_sent`, flips R1's live claim to `send_redrive`,
  and enqueues R2, which wins a fresh claim and sends: two texts.

The payload already carries the attempt start (D12). The safe rule: a verdict may
act on `send_attempting` only when `attemptedAt` EQUALS the payload's attempt
start, i.e. this attempt's own abandoned claim, never a newer one.

---

## R3-4 [HIGH] D8's "skip" and D8a's protection are enforced only by the claim write; every other writer can overwrite a slot someone else holds

D8a is a server-side condition on ONE write. Every writer that terminal-closes
or defers a slot it did not claim is not conditioned on the claim:

- **`closeBroadcast` / `closeRelay`.** Today their "skip" is a SNAPSHOT test
  (`broadcastFanOut.ts:282`, `relayFanOut.ts:1087`) followed by a blind
  `setRecipient` (`app/src/repos/broadcastsRepo.ts:602-640`, no status list
  passed at `broadcastFanOut.ts:283`) or `applyRecipientSendResult`. The latter
  advances `queued -> failed` whatever the code (`messagesRepo.ts:3386-3413`).
- **D9's brake.** It writes `queued` + a code onto every recipient "not yet
  attempted" by THIS pass, including one a concurrent duplicate pass has
  claimed. That releases the live claim, so the continuation re-claims and
  sends again.
- **The relay suppression arm.** It runs before the claim and writes
  `failed`/`contact_opted_out` (`relayFanOut.ts:1324-1331`).
- **The relay retry job's `refuseGate` / `closeTerminally`**
  (`app/src/jobs/relayRetryLeg.ts:449-480`), reachable by a twice-enqueued rung
  (D16, D11).

In the relay-duplicate case (the deferred race, which Sec 2 says D8 "narrows"),
the capped pass's close writes `failed`/`transient_cap` over the other pass's
live claim. The sender's success write then arrives, and on a versioned row it
is rejected as stale (`failed` is terminal). A delivered text shows as failed
with a Retry offer.

**What it implies.** D8 must say every write to a slot the writer does not hold
is CONDITIONAL on the code not being `send_attempting` / `send_unconfirmed`,
server-side. "Skip" read as a snapshot check narrows nothing.

---

## R3-5 [HIGH] Identical normalized bodies still defeat D13's identification, and relay produces them routinely

D13's rule (require a body match after NFKC plus letters-and-digits) fixes the
auto-reply case. It does not fix round-2 finding 2 when two OURS-looking
messages normalize alike:

- Every media-only relay leg reads `'{name} sent an attachment.'`
  (`app/src/messages/catalog.ts:463-465`). A member who sends three photos
  produces three relay messages whose legs to X all normalize to
  "Samsentanattachment".
- Emoji-only and punctuation-only relay messages ("Sam: <thumbs-up emoji>", "Sam: ?!")
  normalize to the sender's name, which is 3 or more letters and so passes the
  length guard.

**How the failure plays out.** Take an outage with legs M1 (not created at
Twilio) and M2 (created, orphan O2) to X:
1. R1 sees exactly one matching unheld candidate, O2, rules `found`, and
   adopts it.
2. R2 sees O2 held by another owner, excludes it, finds no candidate and
   rules `never_sent`.
3. R2 re-drives M2. X gets M2's attachment twice and M1's never; M1's leg
   reads delivered.

With both orphans present, "Several: `found` with the earliest" makes two
concurrent reconciles adopt the SAME earliest SID. The relay pointer is "a plain
put" (D11), so the last writer wins, and the other orphan's receipts are
dropped for ever. Guarantee 1's "the verdict never adopts a message it cannot
identify as ours" is false whenever the body does not identify.

**What it implies.**
- Bound the window's upper edge near the attempt start plus the provider
  timeout, not "now".
- Treat a match that is not unique among candidates, or whose normalized
  body equals another pending owner's for the same recipient and sender, as
  `unresolved`.

---

## R3-6 [HIGH] `retrySend` still has no send claim, and D11's at-least-once model depends on one

D11 is safe only because "the send claim (D8a) makes the second continuation a
no-op". D8a gives the claim to "both slot types" (broadcast, relay). The 1:1
owner gets a conditional deferral record on the original row (D12, D16), which
dedupes the ENQUEUE decision, not the SEND. Under D11's model a redelivered
verdict re-runs, sees its own deferral already recorded, and must choose:

- **re-enqueue.** Two deferred rungs run, each with a fresh jobId and its own
  marker (`app/src/jobs/retrySend.ts:129-146`), and both call `sendMessage`:
  a double text.
- **not re-enqueue.** A throw between the deferral write and the enqueue
  ends the chain silently. That is round-2 finding 1, unfixed for 1:1.

Sec 8 test 12 ("a duplicate deferral is refused by the row condition") tests the
record, not the send. The 1:1 owner needs a D8a-shaped send claim on the original
row (e.g. `retry_attempting` with the rung and `attemptedAt`), taken by the
retrySend handler before `sendMessage`.

---

## R3-7 [MEDIUM] The page walk stops on an order the spec itself marks UNVERIFIED

D13 walks "EVERY page until a whole page is older than the window". That stop
rule is correct only if the list is ordered by creation time. D17 records the
order as UNVERIFIED, and the SDK's only date filter is DateSent. If unsent
(null DateSent) messages sort after sent ones, then on a pair with recent sent
history the first page can be "older than the window" while the queued orphan
sits on a later page. The walk stops, the verdict is `never_sent`, and the
recipient is texted twice. The spec's own justification ("one recipient/sender
pair holds few messages") argues for walking ALL pages, which removes the
ordering dependency at the cost it already calls small. The premise is also
false for the pairs that matter: pool numbers multiplex across groups and are
reused (`messaging.ts:608-616`), and a long-running tenant has every 1:1 ever
sent to them.

## R3-8 [MEDIUM] Contest of round-2 #14 (accepted in part): with D8a in place, a failed failure-arm write is no longer "left for the sweeper", it strands the recipient immediately and the whole broadcast

D7a: "A failure-arm write ... that itself fails ... the slot keeps whatever it
held". After D8a, what it holds is `send_attempting`. For a D6 deferral whose
write failed:
1. The continuation runs 10 seconds later (`broadcastFanOut.ts:92-94`).
2. Its claim meets a `send_attempting` younger than the 30-second staleness
   threshold, so it loses the claim. D7a says a lost claim is "a skip, not a
   failure".
3. The key is not re-deferred, so no later pass lists it.
4. D16a refuses to finalize a broadcast holding a `send_attempting` slot.

The broadcast is therefore `sending` for ever. Before D8a, the same failed
write left a plain `queued` slot that the continuation simply retried. The
adjudication's residue statement ("left for the sweeper") understates a
regression the claim introduced. Fix: a pass may re-take a claim whose
`attemptedAt` is one it wrote. At minimum, name the finalize consequence in
Sec 1.

## R3-9 [MEDIUM] D7's slot write is unconditional and runs after the enqueue, so a fast adoption can be regressed

For the commonest `unknown` (a 30-second timeout), the attempt start plus 5
seconds is already past when D7 enqueues, so check 1 runs at once. If it adopts
before the pass's `queued`/`send_unconfirmed` write lands, that write overwrites
the adopted `sent` slot:
- on broadcast, `setRecipient` is a blind wholesale set (`broadcastsRepo.ts:602-640`);
- on legacy relay, `setRecipientDelivery` is blind
  (`messagesRepo.ts:3562-3582`).

The chain is then finished, so the slot stays `send_unconfirmed` with no owner,
and D16a never finalizes. This is unlikely in production (DynamoDB retries under
throttling widen it). In the in-process lane, where dispatch is `setImmediate`
(`app/src/adapters/scheduler.ts:193-203`), it is a flake. The D7 write must be
conditional on the pass's own claim (`send_attempting` with its `attemptedAt`).

## R3-10 [MEDIUM] The claim erases the re-drive marker, so D13a's "at most ONE re-drive" is unenforceable

A re-drive's claim overwrites `send_redrive` with `send_attempting` (D8a writes
the code). Suppose that re-drive's process dies mid-send. D8a's stale-claim rule
hands the slot to reconcile "as `unknown`". The slot then reads
`send_unconfirmed`, and the second chain's `never_sent` flip accepts it: a
second re-drive, a third attempt, and more hops than D13a budgets (the numberReady
path is already at 8). The one-re-drive bound needs its own attribute (a re-drive
count) that the claim does not overwrite.

## R3-11 [MEDIUM] "Unidentified candidate -> `unresolved`" has no timing, and applied early it wrecks outage bursts

D13 rules `never_sent` only "through the whole window" but gives no timing for
the unidentified rule. In the outage burst (M1 created as O1, M2 not created,
different bodies), R2's first check sees O1 unheld, because R1 has not adopted
it yet. That is an "unidentified candidate", so R2 would close `unresolved`
although M2 was never sent. By R2's last check R1 has adopted O1 and it is
excluded, so the correct verdict (`never_sent`, re-drive) is available only at
the end. State that unidentified candidates decide only at the final check.

## R3-12 [LOW] D11's "re-running the whole adoption is safe" is not true of every write D15 requires

The `listing_sent` milestone and the audit row use random IDs
(`app/src/repos/activityEventsRepo.ts:125-141`,
`app/src/repos/auditRepo.ts:60-80`). Unless they are gated on "the slot write
moved" like the stats bump, every re-run and every duplicate chain's `found`
duplicates them. On a `sent_unrecorded` recipient the pass may already have
written the milestone best-effort (D7a) before the adoption writes it again.
Conversely, a RECORD-phase stats-bump failure (D7a lists it) is never repaired:
the adoption's bump is gated on the slot moving, and it already moved.

## R3-13 [LOW] Contest of round-2 #8 (rejected in part): one case still closes `unresolved` although the platform knows the text was never sent

The adjudication says "A recipient ruled `never_sent` that cannot be re-driven
closes with `transient_cap` or `redrive_refused`, both of which keep the Retry
offer". D13a says otherwise: "Any enqueue that throws inside the reconcile job
... closes the recipient `unresolved`", and that includes the re-drive enqueue
right after a `never_sent`. That recipient reads "Couldn't confirm whether this
text went out" with no Retry, though the verdict was "never sent". Close it
`enqueue_failed`, which exists (`deliveryStatus.ts:913-916`) and keeps the Retry.
The rest of #8 is conceded: the new copy is true for the other causes.

## R3-14 [LOW] Smaller defects in the revised text

- D12's digest check is stated globally ("a mismatch is `unresolved`"). On the
  known-SID path it would turn a known-sent adoption into `unresolved`. The
  fetch needs no number, so the digest check belongs to the list path only.
- D8a's staleness threshold is "the provider's timeout". On broadcast the claim
  is taken before `sendMessage` and spans its pre-provider reads, the call of up
  to 30 seconds, the append's retries and its tail (`sendMessage.ts:278-448`),
  so a live claim can look dead and be handed to reconcile mid-send.
- Legacy relay sources: the inbound path seeds an EMPTY `delivery_recipients`
  map (`routes/webhooks/twilio.ts:856-871`), and only the versioned path
  preflights slots (`relayFanOut.ts:1048-1077`). D8a's "slot is `queued`"
  condition fails on an absent slot, so every legacy leg would be skipped.
  Legacy covers only sources written before 2026-09-02.
- A 1:1 media-only retry (`original.body` undefined, `retrySend.ts:202`)
  normalizes to empty and is always `unresolved` (D13's three-character rule),
  even when the list plainly holds the message. MMS 30003 is a common retry.
- "A re-drive continuation claims no pass". The existing branch that runs when
  there is no claim closes `transient_cap` at once (`broadcastFanOut.ts:587-594`,
  "unreachable by construction" today). "A transient outcome inside it joins
  the ladder as usual" needs a claim at that point; the spec should name it.
- The relay retry rung's success path also performs the status-preserving
  touch (`relayRetryLeg.ts:602-610`). D15's relay adoption list omits it.

---

## Adjudications

| round-2 # | ruling | response |
|---|---|---|
| 8 (reject multiplicity) | REJECT in part | CONTESTED in one case (R3-13); otherwise conceded. |
| 14 (accept in part) | ACCEPT in part | CONTESTED (R3-8): D8a turns the residue into an immediate strand plus an unfinalizable broadcast. |
| 1-7, 9-13, 15-20 | ACCEPT | Not re-litigated. Their fixes are reviewed above as new material (R3-1 to R3-7, R3-9, R3-10, R3-12). |

## Checked and sound

- D20a against `deliveryStatus.ts:228-255`. The new row slots into
  `stalenessClockMs`, so `isStaleLeg` and `canEverGoStale` stay in agreement.
  The held-message case keeps no clock, because the claim is taken only at
  send time. `attemptedAt` reaches the dashboard because
  `contactTimeline.ts:443` passes `delivery_recipients` through whole.
- D8a's release on versioned relay failure and deferral writes:
  `applyRecipientSendResult` replaces the code on `queued -> failed` and on
  `queued -> queued` with a new code (`messagesRepo.ts:3434-3460`). The release
  holds; only the success case is a problem (R3-1).
- D16a's liveness argument holds once R3-2's open-check is fixed. Slots only
  move forward, and the webhook's rollup only moves `sent` slots.
- D13a's revised arithmetic (8 of 10) is correct.
