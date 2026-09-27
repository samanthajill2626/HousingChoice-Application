# S2c report - Task 9 (Slice B, part 3): the relay retry rung

Dispatch S2c of the SOR Stage 1 build. Implementer: Claude Opus 5.5 (1M context).
Worktree `W:\tmp\send-outcome-reconcile`, branch `feat/send-outcome-reconcile`,
base 829d49a7, HEAD d594b743, tree clean, nothing left running.

Record note: the implementer returned this report as TEXT (the harness refuses
report-file writes from implementer subagents); the orchestrator landed it
here, with its own checkpoint verification appended, per AGENTS.md.

## Commits

Both carry the Co-Authored-By trailer; staged added lines checked for
non-ASCII = 0 bytes; no MERGE_HEAD.

- `6bbe77a8 feat(relay-retry): the rung owns its send-attempt record, gates every foreign close on it, and handles each leg outcome explicitly`.
  Files: `app/src/jobs/relayRetryLeg.ts`, `app/src/jobs/relayFanOut.ts`,
  `app/test/relayRetryLeg.test.ts` (first test), `app/test/relayFanOut.test.ts`
  (legacy test 25 deleted, T9-6).
- `d594b743 test(relay-retry): pin every leg outcome the rung handles, the re-drive paths, and the record gate at all six foreign-close sites`.
  File: `app/test/relayRetryLeg.test.ts` (+54 tests; 72 -> 126).

## The rung flow as built (app/src/jobs/relayRetryLeg.ts at d594b743)

- Parser (:295-308) keeps `redrive` only when it is exactly `true` and
  rebuilds the payload field by field. `redrive: true` goes into the base log
  context (:475), so every line of a re-driven envelope carries it. Nothing
  decides on it; decisions come from the record.
- The attempts repo is built lazily (`sendAttempts ??= createSendAttemptsRepo`,
  :452) and pinned as `const attempts`. `rungOwner` = { kind 'relay_rung',
  relayConversationId, retryTsMsgId, memberKey = the row's stored
  `relay_retry_member_key` } (:619). `keyCtx` = ladder + recipientKey:
  safeRecipientKey(memberKey).
- `gateFor(attempts, owner, nowMs)` (:395) is copied from relayFanOut.ts,
  with the repo as a parameter.
- `closeUnlessOwned(code, write, extra)` (:691) is shared by all six gated
  sites. It returns true only when the close was written; the caller logs its
  own close line only then.
  - proceed: write as today (refuseGate or closeTerminally). If the record is
    `redriven`, closeRedriven through guardWrite with outcome enqueue_failed
    when code == enqueue_failed, else refused, cause = code (G7).
  - defer: WARN {gate:'defer', closeCode}, no write.
  - skip: INFO, no write.
  - taken_over: handOff(record.attemptedAt), then WARN, no write.
- The six sites: the four-gate refusal (:756); the window gate (:808); the
  transient cap (:975); the transient window reschedule (:1000); the transient
  re-enqueue failure (:1023, extra {err}); deadline_exceeded (:1047).
- The unit is called with `sendAttempts: attempts, owner: rungOwner`; it
  claims after the bounded acquire and before the presign.
- Exhaustive switch (:878) with a `never` default (:1117):
  - sent (:879): the inbox touch is wrapped (ERROR on failure), then INFO.
  - sent_unrecorded / handed_to_reconcile (:905): sent_unrecorded logs ERROR
    with providerSid and makes NO touch; handed_to_reconcile logs WARN with its
    reason; both call handOff(attemptRef.attemptedAt); no close, no emit. An
    attemptRef guard is kept: unreachable now, logs ERROR, covered via the
    override.
  - stranded (:939): ERROR only - no close, no enqueue, no emit.
  - transient (:955): the unchanged sub-ladder with the three gated closes.
    The re-enqueue payload is {relayConversationId, retryTsMsgId} and never
    carries redrive; `deferredByClaim: true` is added to its log lines.
  - deadline_exceeded: gated refuseGate(retry_window_closed).
  - skipped_terminal (:1060): INFO with its reason, nothing else.
  - rejected / refused / suppressed / filtered (:1071): ERROR 'ended
    terminally' + announceRootClose. The second-unknown `send_unconfirmed`
    `rejected` is not closed again.
- handOff (:641) never throws. It enqueues via
  enqueueSendReconcile({owner: toOwnerRef(rungOwner), attemptedAt, checkNo: 0},
  reconcileDelayMs(attemptedAt, 0, now)). If the enqueue fails:
  1. closeRelayRecipientIfUnsent failed / send_unconfirmed (FIRST);
  2. closeFromReconcile unresolved, cause enqueue_failed;
  3. ERROR {retryClaim:'reconcile_enqueue_failed'};
  4. announceRootClose.
- relayFanOut.ts: `sendAttempts` and `owner` are now REQUIRED. Removed:
  `tracked`, the legacy no-record unknown / sent_unrecorded returns without an
  attemptRef, and every `held !== undefined` guard; `held` is now built with
  `ref!` (the phase advances only after the claim sets it). The loop's
  attemptRef guard stays as a type narrowing, commented as unreachable.

## Deviations

1. G7's outcome rule is applied to the rung's own enqueue-failure close of a
   redriven record (enqueue_failed; refused otherwise). A4 only said "as
   refuseGate".
2. New retryClaim labels: 'code_not_retryable' for a provider rejected (the
   old catch-all would have said gate_refused); 'send_unconfirmed' for the
   second-unknown close; 'reconcile_enqueue_failed' for the hand-off failure.
3. handed_to_reconcile logs at WARN (no level was specified).
4. The skipped_terminal message is reworded and carries its reason.
5. A stale transient-arm comment ("A POST-send close") is fixed.
6. The whole-app run used `timeout 590` rather than 900, because the Bash
   tool's own ceiling is 600 s. The run took 171 s.
7. The root emit on a hand-off failure is unconditional, per the brief.

## T9 IDs applied

- T9-1: fresh `at` wherever a hand-off is observed; T0 only in the two
  redriven window/deadline tests; a G4 recording stub for delay-0 hand-offs.
- T9-2: every test calls seedRelay and register; the deadline tests use
  register({tokenBucket: await drainedBucket()}).
- T9-3: the enqueue-failure test drives the REAL unit (ECONNRESET) plus the
  delay-selective refusal seam.
- A4: the three transient-arm closes are gated.
- T9-5: the mirror test was run from dashboard/.
- T9-6: relayFanOut.test.ts is staged in the first commit.
- T9-7: the gate-read throw points are listed under residue below.

## First failing line

`app/test/relayRetryLeg.test.ts:1390` (at 6bbe77a8; :1433 at d594b743):
`expect(outbound.delayed.map((d) => d.envelope.jobName)).toEqual([SEND_RECONCILE_JOB]);`
It failed with "expected [] to deeply equal [ 'send.reconcile' ]": the old
catch-all logged ERROR and root-closed the rung instead of handing it off.

## Red -> green

- The -t run had 1 failed and 71 skipped.
- After the implementation, the three fast-gate files passed 263/263
  (relayRetryLeg 72, relayFanOut 137, relayRetryClaim.webhook 54).
- The final relayRetryLeg file has 126 tests.
- RSW pins: the base :549-566 and :1214-1257 are byte-identical (cmp against
  the 829d49a7 extracts) and green.

## Mutants (31 run, 31 killed; each restored and verified byte-identical with `cmp`)

- M1 sent-arm touch rethrows: 'a failed inbox touch after a sent leg ...'.
- M2 sent_unrecorded makes the touch: the sent_unrecorded override test and
  the real record-phase test.
- M3 no handOff in the hand-off arm, and M4 the hand-off arm announces a root
  close: each caught by 6 tests - the first test, the real unknown, both
  sent_unrecorded tests, the enqueue failure, and the unit takeover.
- M5 stranded arm closes: both stranded tests and the real lost hand-off.
- M6 re-enqueue carries redrive: 'a transient re-enqueue of a re-driven rung
  does not carry redrive'.
- M7 record closed before slot, M8 no root close, M27 wrong slot code, M28
  wrong record outcome (all in handOff's failure path): 'a reconcile enqueue
  that throws ...'.
- M9 no redriven close, and M15 redriven defers: 8 tests each (the window and
  deadline redriven tests plus the matrix 'redriven' arm at all 6 sites).
- M10 the enqueue-failed redriven close records 'refused': the matrix
  'redriven' test at the re-enqueue failure site.
- M11 fresh/reconciling proceeds: 12 matrix defer tests.
- M12 terminal proceeds: 6 matrix skip tests.
- M13 done/retryable skips: "the unit's own retryable on the last pass ... (A4)".
- M14 takeover not handed off: 6 matrix taken_over tests.
- Site-bypass mutants (the site calls the write directly, skipping the gate):
  M16 four-gate site 5 tests; M17 window gate 6; M18 deadline 6; M19 cap 5;
  M20 window reschedule 5; M21 re-enqueue failure 5.
- M22 the keep line drops err: 2 matrix defer tests.
- M23 terminal arm without root close: 3 tests.
- M24 skipped_terminal announces: 2 tests.
- M25 parser drops redrive: 3 tests.
- M26 rejected ends silently: 2 tests.
- M29 hand-off carries a continuation: 11 tests.
- M30 TTL comparison inverted: 12 tests.
- M31 a deferredByClaim transient writes a slot: 13 tests.

## Gates

- App fast gate (relayRetryLeg, relayFanOut, relayRetryClaim.webhook): exit 0,
  317 passed.
- Dashboard mirror (`relayWindowCloseMirror.test.ts`, run from dashboard/):
  exit 0, 3 passed.
- `npm run typecheck`: exit 0, 0 `error TS` lines.
- Whole app workspace: exit 0. 381 files; 7492 passed, 2 skipped. Both skips
  predate this dispatch: staticSmoke, and the it.skip in broadcastFanOut.test.ts
  waiting on Task 10. 171 s, 0 `[dynamoAdmin]` lines.
- eslint on the 4 files: exit 0, no output (the baseline was also clean).

## Contract for Task 10 (byte-exact copy in the gitignored `.superpowers/sdd/S2c-reference.md`)

- Hand-off payload: {owner:{kind:'relay_rung', relayConversationId,
  retryTsMsgId, recipientKeyHash: hashRecipientKey(storedMemberKey)},
  attemptedAt, checkNo:0}. It has NO continuation key. Its delay is
  reconcileDelayMs(attemptedAt, 0, now); a takeover is delay 0.
- Re-drive: call markRedriven first, then enqueue relay.retryLeg with payload
  EXACTLY {relayConversationId, retryTsMsgId, redrive:true}. Do not use
  enqueueRelayRetryLeg: it applies the 60/120/240 s ladder.
- What a re-driven rung does on each path:
  - The four gates, the window gate, and a send deadline hit during the
    acquire (before the claim): each closes the slot as today, emits the root
    close, closes the record done/refused with the gate code as cause, and
    logs its line.
  - No pool number: it THROWS and the record stays redriven (residue).
  - A non-busy acquire throw is a pre-claim transient with no slot write. It
    then takes the sub-ladder on the retry row's own fanout_attempt, which the
    re-drive does NOT reset. If capped, the close proceeds on the redriven
    record (transient_cap, record refused). Otherwise it re-enqueues without
    redrive, and the next pass claims the record.
  - The claim moves redriven -> attempting (attemptNo+1, redriveCount stays 1).
    Then: sent -> done/sent plus the touch; retryable -> done/retryable, then
    the sub-ladder; rejected/refused/filtered -> the unit closes it, the rung
    logs ERROR and emits the root; unknown -> the second-unknown close (slot
    failed/send_unconfirmed, record done/unresolved cause second_unknown; the
    rung logs ERROR retryClaim send_unconfirmed and emits; no second
    reconcile); record-phase failure -> sent_unrecorded, reconciling WITH the
    SID, then a handOff (a known-SID chain).
  - A duplicate live envelope is a transient deferredByClaim (re-enqueue, or a
    gated close that defers).
  - A claim that finds the record done or reconciling gives skipped_terminal.
  - A stale attempt found at the claim is taken over and handed off at once.
- Root emit: message.persisted {conversationId, tsMsgId: row.relay_retry_of,
  direction: row.direction, deliveryStatus:'failed'}. It is not exported;
  Task 10 rebuilds it (A1 / T10-2).
- Adoption must make the touch that sent_unrecorded skipped:
  touchLastActivityPreservingStatus(conv, undefined, now).
- Labels: every line has event 'relay_retry_leg' (plus redrive:true on a
  re-drive). Keep lines: gate defer|skip|taken_over with closeCode. retryClaim
  values: reconcile_enqueue_failed, code_not_retryable, send_unconfirmed,
  gate_refused, window_closed, cap_exhausted, enqueue_failed. legOutcome on the
  hand-off, stranded and terminal lines. guardWrite labels: closeUnconfirmed,
  closeFromReconcile, closeRedriven.

## Residues for the registry (throw points outside the unit, all after the run-once marker; each strands the rung, and a redriven record stays redriven)

- Pre-existing, in relayRetryLeg.ts: the consistent row read and not-found
  throw (:496-498); the lineage throw (:361); the conversation read (:743);
  the gate evaluator's suppression reads (:744); the no-pool throw (:780);
  claimFanoutPass (:967); the proceed writes in refuseGate (:586, :591) and
  closeTerminally (:607).
- NEW (T9-7): gateFor's attempts.get (:396) and takeOver (:401), reached from
  the six sites (:756, :808, :975, :1000, :1023, :1047).
- The unit itself is total and never throws.

## Concerns

1. Race window on the gated closes. Proceed writes today's close
   (persistRelayRecipientResult: wholesale on legacy rows, forward-only on
   versioned), not D8's conditional closeRelayRecipientIfUnsent. The gate read
   and that write are not atomic, so a claim that lands between them can still
   be overwritten. The window is one consistent read. The plan's "write as
   today" and refuseGate's pinned slot shape (with 'excluded') held the
   implementer to this. Worth a registry entry, or a conditional twin of
   refuseGate's writes.
2. When a hand-off enqueue fails, the root emit fires even if the slot close
   answered skipped_sent (a sent_unrecorded slot that already has a SID). The
   record closes unresolved while the slot still reads queued+sid.
3. RelayLegSendOutcome.attemptRef stays optional because it is a shared
   interface. That is why the two now-unreachable guards remain.

## Orchestrator checkpoint

Verified at d594b743: protected files untouched; 0 non-ASCII bytes in the
added lines; `npm run typecheck` EXIT=0 with 0 `error TS` lines;
`relayRetryLeg.test.ts` + `relayFanOut.test.ts` + `relayRetryClaim.webhook.test.ts`
re-run EXIT=0 (317 passed). Concern 1 joins the gate-then-close family (R-b)
for the review phase; concern 2 is noted for the review phase (a hand-off
failure after a KNOWN send closes the record `unresolved` while the slot keeps
its sid - the send happened, so the record outcome misstates it).
