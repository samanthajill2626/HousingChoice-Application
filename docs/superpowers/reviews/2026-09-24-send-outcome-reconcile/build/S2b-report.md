# S2b report - Task 8 (Slice B, part 2): the relay leg and the fan-out loop

Dispatch S2b of the SOR Stage 1 build. Implementer: Claude Opus 5.5 (1M context).
Worktree `W:\tmp\send-outcome-reconcile`, branch `feat/send-outcome-reconcile`,
base 6cf9bc1e, HEAD 829d49a7, tree clean, no background process left running.

Record note: the implementer returned this report as TEXT (the harness now
refuses report-file writes from implementer subagents; see S2a). The
orchestrator landed it here from that text, with the orchestrator's own
checkpoint verification appended, per AGENTS.md ("Mission reasoning is
version-controlled").

## Commits

- `30b6e636 feat(relay): the leg claims before the send, tracks its phase, classifies the failure and hands unknown outcomes to reconcile; the loop brakes and closes through the record gate`
- `829d49a7 test(relay): pin the claim-time and cap-close takeovers and their lost fences, the record-phase lost hand-off, the best-effort attempt clock, and type the phone-only members`

Correction the implementer flagged: 30b6e636 on its own carries 3 TS2741
errors in `app/test/relayFanOut.test.ts` (phone-only participants typed
without `contactId`); 829d49a7 fixes them, so the PAIR is green. Only
`app/src/jobs/relayFanOut.ts` and `app/test/relayFanOut.test.ts` were
touched; `relayRetryLeg.ts` was not edited.

## The leg unit's phase map (app/src/jobs/relayFanOut.ts:1751-2258 at 829d49a7)

Outside the try (cannot throw): the terminal-slot skip returns
`skipped_terminal`.

PREPARE, before the claim. A throw here logs WARN 'prepare failed before the
claim' and returns `transient` / `send_retryable`. It writes NO slot (ruling
A3) and there is no record.
1. `isMemberSuppressed` (reads contacts and conversations).
2. Suppressed member on the tracked path: `gateFor` (`get`, plus `takeOver`
   when the record is stale):
   - skip -> `skipped_terminal`
   - defer -> `transient` + `deferredByClaim` (no write)
   - taken_over -> `handed_to_reconcile`, reason 'takeover', with the stale attemptRef
   - proceed -> steps 3-6
3. `setVersionedAggregationState(excluded)` (versioned rows only).
4. `persistRelayRecipientResult` writes failed / `contact_opted_out`.
5. `guardWrite(closeRedriven refused / contact_opted_out)`, only when the record is redriven.
6. `setRelayMemberOptedOut` (its own try/catch logs ERROR and continues), then returns `suppressed`.
7. `tokenBucket.acquire`. A bounded acquire that raises `TokenBucketBusyError`
   returns `deadline_exceeded` before any claim. Any other error is a
   pre-claim throw.
8. `claim`:
   - refused fresh -> `transient` + `deferredByClaim`
   - refused not fresh -> `skipped_terminal`
   - takeover -> `takeOver`; if false: INFO and `skipped_terminal`; if true: `handed_to_reconcile` / takeover

PREPARE, after the claim. A throw here logs WARN, then
`guardWrite(persist queued + send_retryable)`, then
`guardWrite(finishAttempt retryable)`, and returns `transient` /
`send_retryable`.
9. `setRelayRecipientAttemptedAt` (its own try/catch logs WARN and continues).
10. `presign`.
11. `prepareMessageSend`.
12. `setVersionedAggregationState(attempted)`.

SENDING - step 13, the provider call:
- `SendRefusedError`: slot failed/<code>, record refused -> `refused`.
- rejected 30007: slot and record written, ERROR -> `filtered`.
- other rejected: slot failed with the provider code or
  `sms_sending_disabled`; NO code for a code-less 4xx. The record is rejected
  with cause = code, or the status when there is no code -> `rejected`.
- retryable: slot queued with the provider code or `send_retryable`; record
  retryable -> `transient`.
- unknown without the args: WARN -> `handed_to_reconcile` / unknown with no
  attemptRef (removed in Task 9, which makes the args required).
- unknown with redriveCount >= 1: `closeRelayRecipientIfUnsent`
  failed/`send_unconfirmed`, then record unresolved / `second_unknown`, ERROR
  -> `rejected` / `send_unconfirmed`.
- unknown otherwise: WARN, then the G5 hand-off:
  - handed -> `handed_to_reconcile` / unknown + attemptRef
  - fence lost -> INFO, `skipped_terminal` with reason 'unknown'
  - threw -> `stranded`
- Every write in these arms goes through guardWrite; the slot is written
  before the record.

RECORD:
14. `persistRelayRecipientResult` (the slot).
15. `claimRelaySidPointer`; 'other' logs ERROR and the leg stays sent.
16. `finishAttempt(sent)`; false logs WARN (plan deviation 3).
A throw in 14-16 logs ERROR `sent_unrecorded` {providerSid}. Without the args
it returns `sent_unrecorded` with no attemptRef. With them it runs the G5
hand-off with the SID:
- handed -> `sent_unrecorded` + attemptRef
- fence lost -> `skipped_terminal`
- threw -> `stranded` + `afterSend`

## The loop's per-member path (relayFanOut.ts:1328-1427 at 829d49a7)

- A terminal slot is skipped: never carried, streak untouched.
- Once braked, every remaining member is carried with no slot write.
- The unit is called with `sendAttempts` and the relay_leg owner, then:
  - `sent` counts.
  - `transient` is carried, except `deferredByClaim` on a FIRST pass.
  - `stranded` is carried.
  - `handed_to_reconcile` and `sent_unrecorded` call `handOff` (ERROR if there is no attemptRef).
  - Every other kind: nothing.
  - A `default: never` check makes the switch exhaustive.
- An outer catch turns any throw into ERROR plus carried.
- The streak comes from `isUnknownOutcome` (:1603): it counts
  `handed_to_reconcile` / unknown, `stranded` without afterSend, `rejected` /
  `send_unconfirmed`, and `skipped_terminal` / unknown.
- `handOff` (:1196) never throws. If the enqueue fails: slot
  `send_unconfirmed`, record unresolved / `enqueue_failed`, ERROR.
- `closeRelay` (:1244) keeps its `code` parameter. For each member, inside
  its own try/catch (label capClose):
  - taken_over -> `handOff`
  - skip / defer -> INFO
  - proceed -> `closeRelayRecipientIfUnsent(failed, code)`, and for a redriven
    record `closeRedriven` (enqueue_failed when code is enqueue_failed, else
    refused; cause = code)

## Deviations, and why

1. After the claim, every failure arm writes the slot BEFORE the record. The
   plan's pre-send arm listed the record first; plan deviation 3 and the
   broadcast twin both put the slot first.
2. A `deferredByClaim` member is carried only by a continuation. This mirrors
   the broadcast (T7-11) and spec D8a ("a refused claim on a recipient a
   continuation carries"). On relay the ladder cannot outlast the 30 s TTL
   anyway.
3. G5 lost fence: the unknown arm returns `skipped_terminal` with reason
   'unknown', which counts toward the brake (broadcast parity). The
   record-phase arm returns plain `skipped_terminal`, which resets. This
   widens the documented use of `reason`; no field name or type changed.
4. Alignment (i) of the brief: a second-unknown close counts toward the streak.
5. A record-phase failure on the argless path returns `sent_unrecorded` with
   no attemptRef (the plan did not say).
6. `setVersionedAggregationState` gained an optional trailing
   `consistent = false`. The preflight passes it on continuations and
   re-drives. The unit's own 'attempted' conflict re-read stays eventual.
7. Re-drive early returns also cover 'nothing relayed' and the post-loop claim
   'missing'. The causes written are `conversation_not_found`,
   `group_not_open`, `no_pool_number`, `source_not_found`, `nothing_to_relay`,
   `source_vanished`.
8. The loop checks for a terminal slot before the brake (the T7-12 twin).
9. The completion INFO line gains `handed`.
10. Plan test 12 is split: 12 in the media describe, 12b in the main describe.

## Fails on main

`AssertionError: expected [ '+15550100002', '+15550100003' ] to deeply equal [ Array(4) ]`

Both plan-1 tests failed on the unmodified code (versioned=false and
versioned=true). Only plan-1 was run against the old code; the other new
tests fail there by construction, not by a run.

## Red -> green

- RED: 2 failed | 82 skipped (test 1, run with a filter).
- GREEN after the implementation: 155 passed across the two files.
- The relay file then went 133 -> 136 -> 138 tests as pins were added.
  Final: 209 passed across relayFanOut + relayRetryLeg.

## Mutants (62 run; every restore checked byte-identical with `cmp`)

61 were killed. The 62nd (H3) turned out to be equivalent (the write still
ran); H3b replaces it and was killed. Each mutant with the test that caught it:
- gateFor arms: G1 absent->defer (test 4), G2 done->proceed (4, 11b), G3
  done/retryable->skip (11f), G4 redriven->defer (9b, 14), G5 TTL inverted (4,
  7), G6 a lost takeover fence reports taken_over (4c), G7 fresh/reconciling
  proceed (4, 7).
- Unit phases: P1 no 'sending' (1), P2 no 'record' (6, 8g), P3 the pre-claim
  deferral writes a slot (15, 15b), P4 the post-claim deferral does not
  release the record (media SOR 13).
- Unit arms: U1 and U2 the second-unknown close (10, 8f); U3 an unknown turned
  into a re-send (1); U4 G5 (8h); U5 and U6 the suppression gate (11a, 9b/16);
  U7 and U8 the slotCode rule (5, 17); U9 a claim-time takeover with a lost
  fence (4e); U10 and U12 refused-claim fresh vs not fresh (7/11e, 6); U11
  mediaCount (12b); U13 and U14 suppression-arm takeover/skip (11c, 11b); U15
  the code-less 4xx cause (17); U16 a network string on the slot (18); U17
  finishAttempt(sent) (2); U18 the record-phase lost fence (6b); U19 and U20
  the attempt clock and its best-effort catch (1, 6c).
- Ordering: O1 claim-after-acquire (the token-bucket "acquire throws" test and
  the deadline test); O2 the record-phase order (6, 21).
- Streak and brake: L1 (8a), L2 afterSend counted (8g), L3 stranded not
  counted (7b), L4 second unknown not counted (8f), L5 takeover counted (4d),
  L6 threshold (8a, 7b), L7 no reset (8b, 8c, 8g).
- Loop carry: L8 (8a), L9 and L10 (11d, 11a/11e), L11 (7).
- handOff: H1 no continuation (1, 4), H2 and H3b the enqueue-failure closes (20).
- closeRelay: C1 and C2 the redriven close outcome (9d, 14), C3 (9d), C4 (4), C5 (4, 4c).
- Re-drive: R1 up-front claim not skipped (9a), R2 (9g), R3 closeRedriven-first
  (9f), R4 slot-before-record (9e), R5 (9e), R6 no post-loop claim (9c).
- Snapshot: S1 and S2 (24, 24b).
The runner and per-mutant logs are in the session scratchpad `S2b\`.

## Gates

- `npx vitest run test/relayFanOut.test.ts test/relayRetryLeg.test.ts` -> exit
  0, 209 passed. relayRetryLeg.test.ts stayed green and was not edited.
- `npm run typecheck` -> exit 0 with 0 `error TS` in the log. All 5
  workspaces completed.
- Whole app workspace -> EXIT=0. Test Files 381 passed (381), Tests 7438
  passed | 2 skipped (7440), 185.89s. The skips are broadcastFanOut.test.ts
  (S2a's Task 10 `it.skip`) and staticSmoke (no dashboard build). No
  `[dynamoAdmin]` line.
- `npx eslint app/src/jobs/relayFanOut.ts app/test/relayFanOut.test.ts` ->
  exit 0, nothing reported. Both files were already clean at 6cf9bc1e.
- Staged added lines contained 0 non-ASCII bytes in both commits.

## Contract for downstream

**The outcome type.** `RelayLegSendOutcome.kind` is one of: sent,
skipped_terminal, suppressed, refused, filtered, rejected, transient,
deadline_exceeded, sent_unrecorded, handed_to_reconcile, stranded. Optional
fields: `providerSid`, `errorCode`, `attemptRef`, `reason` ('unknown' |
'takeover'), `deferredByClaim` (true), `afterSend` (true).

**The unit's args.** It gains `sendAttempts?: SendAttemptsRepo; owner?:
SendAttemptOwner`. Pass both or neither; one alone is treated as the legacy
path. (Task 9 made both required.)

**What Task 9 (the rung) must do.**
- Pass `sendAttempts` and `owner: { kind: 'relay_rung', relayConversationId,
  retryTsMsgId, memberKey }`, and make both required.
- handOff for `handed_to_reconcile` (either reason) and for `sent_unrecorded`
  (with no inbox touch).
- `stranded`, with or without afterSend: ERROR only.
- `rejected` / `send_unconfirmed`: the unit has already closed the slot and
  the record. Do not close again.
- `skipped_terminal` with reason 'unknown': nothing to do.
- A pre-claim `transient` wrote NO slot.
- `deadline_exceeded` never holds a record.
- Copy gateFor from relayFanOut.ts:1661-1670.

**Hand-off payload.** Enqueued with `enqueueSendReconcile`:
`{ owner: { kind: 'relay_leg', relayConversationId, sourceTsMsgId, recipientKeyHash: hashRecipientKey(memberKey) }, attemptedAt, checkNo: 0, continuation: { senderKey, senderNameOverride? } }`.
It runs at `reconcileDelayMs(attemptedAt, 0, now)`, which is 0 for a stale
takeover. For a takeover, attemptedAt is the stale attempt's.

**Log events and labels.**
- guardWrite labels: closeRedriven, deferSlot, finishAttempt, refusedSlot,
  rejectSlot, closeUnconfirmed, handToReconcile, closeFromReconcile,
  redriveRefusedSlot.
- closeRelay per-member failures: label capClose.
- WARN event 'outage_brake' with {conversationId, tsMsgId, untried, deferred, attempt}.
- Context fields: `memberKey: logSafeMemberKey(member)` when the member is
  known, `recipientKey: safeRecipientKey(key)` when only the key is.

**Re-drive envelope for Task 10.** After `markRedriven`, enqueue `relay.fanOut` with:
`{ relayConversationId, sourceTsMsgId, senderKey: continuation.senderKey, senderNameOverride?, recipientKeys: [<the RAW member key from the record's owner>], attempt, redrive: true }`.

**What the re-drive pass then does.**
- Reads the source consistently and makes no up-front rung claim.
- The claim moves the record from redriven to attempting; a second unknown
  closes send_unconfirmed / unresolved.
- A retryable remainder claims a rung after the loop; the continuation it
  enqueues carries no `redrive`.
- Capped or refused remainders close through the gate, and the redriven
  record closes refused or enqueue_failed.
- An opted-out member closes refused / contact_opted_out.
- Early returns close the record redrive_refused FIRST, and the slot only
  when that close returned true.

## Residues for the registry (line numbers at 829d49a7)

1. Throw points left outside the unit, in relayFanOut.ts:
   - handler: :830 (execution marker), :842 (conversation read), :876-877 (source read)
   - :1091 (classifyMessageTransport)
   - :1117 (resolveMessage)
   - :1146 preflight, which can throw at :2286, :2295, :2352
     (readVersionedSource) and :2384 (setVersionedAggregationState). These
     can strand a re-drive pass's redriven record.
   - :1305 (up-front claim) and :1459 (post-loop claim)
   - the lazy repo constructors
2. The relay strand: a stranded member is deferred at the cap and left for
   the sweeper (pinned by test 7).
3. The new closes join A8's "relay fan-out closes emit nothing" class.
4. An ordinary continuation that returns early leaves a redriven record redriven.
5. Until Task 9, the rung's argless path let `handed_to_reconcile`,
   `rejected`, `sent_unrecorded` and `stranded` fall into its "ended
   terminally" ERROR + announceRootClose tail, and the slot was left queued
   (Task 9 closed this).

## Concerns

1. The root `npm run typecheck` returned exit 0 once (04:23) while its log
   contained 3 `error TS` lines. That log's timestamp was later than the next
   command in the same chain, so tsc's output landed after npm had already
   returned. Two later probes with a deliberate error both exited 2. Gates
   should grep for `error TS`, not trust the exit code alone.
2. `reason` on `skipped_terminal` widens the documented use of a
   shared-interface field.
3. Byte-exact quotes of the unit, the loop, the gate and the handler are in
   the gitignored `.superpowers/sdd/S2b-reference.md`.

## Orchestrator checkpoint

Verified at 829d49a7: protected files and `relayRetryLeg.ts` untouched; 0
non-ASCII bytes in the added lines; `npm run typecheck` EXIT=0 with 0
`error TS` lines (78 s); `relayFanOut.test.ts` + `relayRetryLeg.test.ts`
re-run EXIT=0 (209 passed). The loop, `handOff` and `closeRelay` read in full.
Adopted as gate practice from concern 1: the typecheck gate is the exit code
AND `grep -c "error TS"` = 0 on its captured log. Review item carried forward:
(R-a) `closeRelay`, like `closeBroadcast`, closes the SLOT before
`closeRedriven` for a redriven gate; a concurrent re-claim between the two can
leave a versioned slot `failed` after a real send - record-first with the slot
close only when `closeRedriven` returned true closes it for redriven records.
