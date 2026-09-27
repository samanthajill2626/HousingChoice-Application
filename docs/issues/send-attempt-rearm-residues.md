---
id: send-attempt-rearm-residues
title: The pre-send re-arm narrows the stale-claim double text but does not close it - a stall inside the re-arm or a request that trickles past the window can still text twice - plus the re-arm's own small costs
type: bug
severity: low
status: open
area: app/messaging
created: 2026-09-27
updated: 2026-09-27
refs: app/src/repos/sendAttemptsRepo.ts:379, app/src/lib/dynamo.ts:61, app/src/jobs/broadcastFanOut.ts:917, app/src/jobs/relayFanOut.ts:2016, app/src/services/sendMessage.ts:549, app/src/services/sendMessage.ts:615, app/src/lib/sendOutcome.ts:41, app/src/adapters/messaging.ts:692, app/src/jobs/broadcastFanOut.ts:817, app/src/jobs/relayFanOut.ts:1983
---

**Background.** Code review round 1 of `feat/send-outcome-reconcile` (SOR)
found ADV-1: the attempt clock was stamped at the CLAIM, before unbounded
database work, so a live attempt could look stale (older than the 30 s claim
TTL) before it ever called the provider. A concurrent pass took it over, the
reconcile found nothing at the provider (it had not been called yet) and
ruled `never_sent`, the re-drive sent - and the stalled pass then resumed and
sent too. The branch fixed most of it:

- FW1-1 (commit `0dd5d4b7`) added `SendAttemptsRepo.rearm`
  (`app/src/repos/sendAttemptsRepo.ts:379-420`): a consistent Get (`:383`),
  then ONE TransactWrite (`:386-409`) that moves the record's `attempted_at`
  and `expires_at` to now only while it is still `attempting` with this
  attempt's `attemptNo` and `attemptedAt`, plus a NEW recipient-index item at
  the new time.
- FW2-1 (commit `e3b13f6d`) calls it as the LAST step before the provider
  call at every send site and fails closed: `undefined` (taken over) sends
  nothing and writes nothing; a throw takes the existing prepare deferral.
  Broadcast: through `sendMessage`'s `beforeProviderSend` hook
  (`app/src/services/sendMessage.ts:615-617`; the hook at
  `app/src/jobs/broadcastFanOut.ts:917-928`). Relay leg and rung:
  `app/src/jobs/relayFanOut.ts:2016-2025`.

The claim TTL, the takeover and the reconcile window are all measured from
the last re-arm now. What stays open, as recorded by review rounds 1 and 2 and
the fix waves (records under
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/code-review/`):

**1. The residual double-text window (round 2 A-1; CONFIRMED in the harness
with the stall simulated).** Round 1's adjudication said that with the re-arm
the missing DynamoDB request timeout "can no longer produce a second send";
round 2 WITHDREW that (`r2-adjudications.md` sections 2 and 4,
`r1-adjudications.md` section 7). The re-arm NARROWS the window to its own two
DynamoDB calls - the consistent Get and the TransactWrite - and does not close
it:

- The document client is built with no request timeout
  (`createDynamoClient`, `app/src/lib/dynamo.ts:61-79`, passes no request
  handler; the SDK's default request timeout is none), so either call can
  hang for as long as the socket does.
- Each site takes the re-arm's timestamp BEFORE the call (the `nowIso`
  argument, `broadcastFanOut.ts:921` and `relayFanOut.ts:2020`).
- A response stall AFTER the TransactWrite committed, of about 90 s or more:
  the record is re-armed but the pass is still waiting. Past 30 s a
  concurrent pass for the same recipient (an SQS redelivery - for example a
  relay first pass enqueued twice by a re-flushed `relay.numberReady`, round
  1's ADV-1) meets the record stale and takes it over; the reconcile's window
  ends 90 s after the stamp, so a message the stalled pass sends after that
  is invisible to it; the last check (+240 s) rules `never_sent` and the
  re-drive sends; the stalled pass sends too.
- A stall of about 90 s or more in the Get, BEFORE the commit: the
  TransactWrite commits a stamp that is already that old, so the record is
  stale the moment it is re-armed; a concurrent pass that meets it takes it
  over, and the message the re-armed pass then sends lands after the
  window's end (`RECONCILE_WINDOW_TRAIL_MS`,
  `app/src/lib/sendOutcome.ts:33-41`; the candidate filter at
  `app/src/jobs/sendReconcile.ts:847`), so the last check again rules
  `never_sent` and re-drives.
- Before the re-arm, a stall anywhere between the claim and the provider call
  was enough. The two-sided window (FW1-2) also lowered the stall this needs
  from about 210 s to about 90 s (round 2 A-1): the re-arm moved where the
  stall must happen, the window shortened how long it must last.

Preconditions: a DynamoDB call that hangs for about 90 s or more, AND a
concurrent pass for the same recipient. User-visible: the recipient gets the
same text twice.

Designed fixes (`r2-adjudications.md` section 2): (a) a request timeout on
the DynamoDB client (`requestTimeout` plus `throwOnRequestTimeout` on its
request handler) - a process-wide client change; or (b) take the re-arm's
stamp INSIDE `rearm`, after its Get, and re-check the elapsed time after the
TransactWrite, failing closed (release the attempt retryable, fenced) when
too much time has passed.

**2. The window's trailing edge assumes the provider creates the message
within 90 s of the re-arm (FW1 residue 4).** `RECONCILE_WINDOW_TRAIL_MS` is
`SEND_CLAIM_TTL_MS` + `RECONCILE_WINDOW_LEAD_MS` = 90 s
(`sendOutcome.ts:33-41`). The Twilio request timeout it leans on
(`TWILIO_REQUEST_TIMEOUT_MS`, `app/src/adapters/messaging.ts:683-692`, pinned
on the client at `:753` and `:757`) is an idle-socket timeout, not a bound on
the whole request (round 1 ADV-1: twilio-node's axios / https-agent timeout).
A request that keeps trickling bytes for more than 90 s can have its message
created after the window's end. If that attempt is then reconciled - its
outcome came back unknown, or a concurrent pass took the stale attempt over -
the lookup never sees the message, the last check rules `never_sent` and the
re-drive sends it again. Extreme, and the same trailing edge as item 1.

**3. The A2P token wait now holds the record `attempting` (round 2 F-3,
correcting FW2 residue 6).** FW2-6 runs the broadcast pass's best-effort
follow-ups before the record's `done`/`sent`: `afterSend`
(`broadcastFanOut.ts:949`, defined at `:817-832`) acquires the A2P token
(`:823`) before `finishAttempt` (`:950`). The bucket is shared first-come by
every SMS job in the worker (`app/src/jobs/registerHandlers.ts:50-78`; relay
draws one token per leg), so FW2's "well under 30 s at about 1/s" is NOT
guaranteed under load. A takeover of the already-sent recipient is harmless
in itself - the reconcile's adoption finds the slot moved, and the late
`finishAttempt` logs a lost fence at WARN (`:950-957`) - but a record held
open longer widens the takeover window item 1 depends on.

**4. A re-arm that commits and then throws (round 2 R2C-6).** When the
TransactWrite commits but the call still throws (its response lost past the
SDK's retries), the site defers on the PRE-re-arm ref: on broadcast the
hook's throw becomes a `SendNotAttemptedError` (`sendMessage.ts:615-617`)
and `deferClaimed` runs on the unreplaced ref (`broadcastFanOut.ts:1017-1027`;
the ref is replaced only at `:926`); on relay the post-claim prepare catch
does the same (`relayFanOut.ts:2085-2096`). The retryable release then fails
its fence (the record's `attemptedAt` moved), so the record stays
`attempting` on the re-armed clock while the slot reads `queued` /
`send_retryable` and the recipient is carried. Nothing is ever sent by it. On
relay the record is still fresh at the cap (the 5 s + 10 s ladder), so it is
[send-attempt-sweeper](./send-attempt-sweeper.md)'s; on broadcast it follows
the positions in that issue's Addendum 2026-09-27 (a pass-1 instance can be
taken over and is then re-driven once - correctly, since nothing went out;
later positions wait for the sweeper). "Harmless" only in the no-double-send
sense.

**5. The breaker counts before the re-arm (round 2 R2C-7).** `sendMessage`'s
automated-send breaker increments (`sendMessage.ts:549-573`, the increment at
`:551-554`) before the pre-send hook runs the re-arm (`:615-617`). A lost or
thrown re-arm on an AUTOMATED share spends a breaker count for a text never
sent. Bounded: at most once per pass on the 3-pass ladder, against a cap of
`SEND_BREAKER_MAX_PER_MINUTE` (default 10, `app/src/lib/config.ts:991`) per
conversation. A share the dashboard created is a person's send and is not
metered.

**6. The re-arm's own cost (FW1 residue 2, FW2 residue 2).** Every send now
makes a consistent Get and one two-item TransactWrite before the provider
call, plus a consistent Get when the condition fails (the belt,
`sendAttemptsRepo.ts:411-419`). A DynamoDB fault there defers the send - it
fails closed: a delay to the next continuation and, at the cap, the transient
close. Each attempt also leaves TWO recipient-index items (the claim's and the
re-arm's; both reaped only by the 30-day TTL), and `listByRecipient` makes
one consistent Get per index item (`sendAttemptsRepo.ts:585-615`) before it
dedupes to one row per record, so a reconcile's sibling read costs about
twice the reads per attempt in its span.

**7. Replay safety is unproven locally (FW1 residue 6).** The claim's and the
re-arm's TransactWrites rely on the SDK's auto-filled ClientRequestToken to
answer a replay of a committed transaction with success; DynamoDB Local
cannot show that behavior, so no test proves it. The re-arm carries a belt
either way: on a failed condition it re-reads and recognizes its own stamp
(`sendAttemptsRepo.ts:411-419`; FW1 deviation 2). The claim has no such belt
and relies on the token alone, which round 1's adversarial review judged
sound against real DynamoDB (`r1-adversarial.md`, "Looked at, sound").

**8. The relay slot's attempt clock is the claim instant, not the re-arm (FW2
residue 1; display only).** The leg stamps its slot's `attemptedAt` (spec
D20a) from the claim's ref (`relayFanOut.ts:1977-1991`, the write at
`:1983-1988`), and the re-arm later moves only the RECORD's clock (`:2020`);
nothing may run between the re-arm and the provider call, so the slot is not
re-stamped (FW2 deviation 1; the pins compare the slot clock with the claim's
instant). The dashboard ages a still-queued leg from the slot's clock
(`stalenessClockMs`, `dashboard/src/routes/contact/deliveryStatus.ts:287-301`;
the 15-minute budget at `:64`), so after a long stall between the claim and
the re-arm (the presign, the prepare, the aggregation write) the leg can read
"Queued - not confirmed" up to that stall's length early.

**Why none of this was fixed on the branch.** The human's standing ruling on
the branch (Cameron, 2026-09-27, `r1-adjudications.md` section 6): a double
text is annoying, NOT critical; he would rather risk one than take on new
failure points or a lot of redo - so the site half of the re-arm stayed
minimal, with no DynamoDB client timeout change, no extra retries, states or
machinery. Items 1, 4 and 5 were ruled RESIDUE in round 2
(`r2-adjudications.md` section 2), item 3 there as the correction of FW2's
residue; items 2, 6, 7 and 8 are the fix waves' own named residues
(`fw1-report.md`, `fw2-report.md`, "New residues").

**Related.** [send-attempt-sweeper](./send-attempt-sweeper.md),
[send-reconcile-hosted-dev-checks](./send-reconcile-hosted-dev-checks.md)
(a message held in the provider's queue past the last check reaches the same
double text by another road),
[throw-for-redelivery-defeated-by-job-marker](./throw-for-redelivery-defeated-by-job-marker.md),
[send-attempt-gate-then-close-window](./send-attempt-gate-then-close-window.md).

## Addendum 2026-09-27 - planner post-build review

Found by the planner's post-build review of `feat/send-outcome-reconcile`
(2026-09-27), adversarial finding L-6
(`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/planner-review/adversarial.md`).
Anchors at HEAD `91a66577`. Severity stays `low`.

9. **Two consistent reads per attempt that could go (cost, extends item 6).**
   - The claim re-reads the record after its own successful create
     (`mustGet`, `app/src/repos/sendAttemptsRepo.ts:424`) to return it,
     although it just wrote every field it would read back.
   - The re-arm's consistent Get (`:383`) exists only to copy the attempt's
     facts into the new recipient-index item (`indexItem(owner, record, ...)`,
     `:406`); the caller already holds those facts - it passed them to the
     claim moments earlier (broadcast `app/src/jobs/broadcastFanOut.ts:868-877`,
     relay `app/src/jobs/relayFanOut.ts:1941-1951`). The TransactWrite's own
     condition, not the Get, is what decides whether the re-arm applies
     (`:386-409`); a Get that finds no record returns early (`:384`), which the
     condition would also refuse.

   Passing the facts into `rearm` and building the claimed record from the
   write's inputs would remove both reads - two consistent reads on every
   happy-path send. The review's cost line: a broadcast recipient's happy
   path is about +4 DynamoDB round trips over main, a relay leg about +7
   (adversarial review, "Cost per recipient"). Cost only: no behavior,
   ordering or double-text change, and item 7's belt (the re-read after a
   FAILED condition, `:411-419`) is a different read and stays.
