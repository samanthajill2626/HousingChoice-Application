# S2a report - Tasks 3 and 7 (Slice B, part 1)

Dispatch S2a of the SOR Stage 1 build. Implementer: Claude Opus 5.5 (1M context).
Worktree `W:\tmp\send-outcome-reconcile`, branch `feat/send-outcome-reconcile`,
started at 649b577d. Scope: plan rev 4 Task 3 (typed `sendMessage` errors) and
Task 7 (the broadcast fan-out) WITHOUT `adoptBroadcastRecipient` (moved to S3,
worklist section 2a), with the worklist's S2a bullet: T3-1, T3-2, T7-1..T7-14.
Inputs: AGENTS.md (editing and commit discipline), spec rev 11 (Sec 1, D1-D3a,
D5-D9, D10, D13a, D16a, Sec 11), the plan (Global Constraints, Shared
interfaces, Review Focus, Tasks 3 and 7), worklist sections 0, 2 "S2a" and 2a,
`send-sites-drift-findings.md` (T3-*, T7-*, the invariant sweep), the spike's
"Cross-cutting" note, `build-send-sites-reference.md` sections 1-4 and 9, and
the S1a/S1b/S1c "Contract for downstream" sections.

Method: strict TDD. Task 3's ten new cases were seen red before the code
existed. For Task 7 the plan's test 1 was written FIRST and run against the
unchanged fan-out (only the new `sendReconcile.ts` stub existed) - it failed
as the brief requires. Task 7 then landed in two green increments, each with
its tests seen red first, plus two test-only commits that give every planned
mutant a killer. Then 74 one-line mutants, each an exact textual edit applied
by a scratch runner, run, written back from the ORIGINAL BYTES and proven
byte-identical with `cmp` (no git checkout / restore / stash).

Note: the harness refused this subagent's write of this report file; the
orchestrator committed it from the handback text.

## Commits

- `411b681c feat(send): typed non-refusal errors from sendMessage that keep the provider code readable; post-append failures no longer fail a sent text (D3)` - Task 3.
- `7fc1fa5b feat(broadcast): phase-tracked recipient units with a claim before every send, classified outcomes, reconcile hand-off, the outage brake and an idempotent finalize (D5-D9, D7a, D8a, D13a, D16a)` - Task 7 increment (a), with the new `app/src/jobs/sendReconcile.ts` stub.
- `f40f585f feat(broadcast): the cap-close behind the D8 gate, the re-drive pass and a consistent continuation snapshot (D8, D13a, D16)` - Task 7 increment (b).
- `a95fbd98 test(broadcast): pin the kill-switch slot token, the untyped-error fallback to unknown, the terminal key after a brake, each reached status in finalize, and a first pass's uncarried foreign attempt` - test only.
- `6cf9bc1e test(broadcast): the pre-claim deferral's WARN carries the key and the error; finalize decides on the consistent read` - test only.

Files touched: `app/src/services/sendMessage.ts`, `app/test/sendMessage.test.ts`,
`app/src/jobs/broadcastFanOut.ts`, `app/src/jobs/sendReconcile.ts` (new),
`app/test/broadcastFanOut.test.ts`. Nothing else. The only pre-existing test
lines changed are the plan's listed red pin (the `setRecipient` spy, now on
`recordRecipientOutcome`) and two `makeFakes` method bodies that gained seams.

## What was built

### Task 3 - `app/src/services/sendMessage.ts`

- `SendNotAttemptedError(message, cause)`,
  `ProviderSendFailedError({ classification, cause, facts, attemptedAt })`
  (own `code` / `status` mirrored from the cause; message
  `provider send failed (<kind>): <cause message>`, so the old
  `rejects.toThrow('provider unavailable')` pin stays green), and
  `SendAcceptedNotRecordedError({ providerSid, providerTs, status, cause, facts })`.
  None extends `SendRefusedError`.
- A local `notAttempted(run, step)` wraps ONLY the non-refusal throw points
  before the provider call and rethrows any `SendRefusedError` untouched:
  `'conversation read'`, `'contact read'`, `'breaker increment'`,
  `'breaker trip write'` (setMode + the mode_changed audit as one step; the
  `CircuitBreakerOpenError` throw stays outside) and `'transport preparation'`
  (classify + prepare as one step).
- The facts (`recipientDigest(sender, participantPhone)` with the file's own
  `sender = from ?? config.businessPhoneNumber`, `sender` only when set, the
  lossy body hash, `bodyShort`, `mediaCount = mediaUrls?.length ??
  attachments?.length ?? 0`) and `attemptedAt` are taken immediately before
  the provider call; a non-refusal provider throw becomes
  `ProviderSendFailedError` with `classifySendFailure(err)`.
- The append input is built as a `NewMessage` const (the object literal's
  lines are unchanged); an append failure is `SendAcceptedNotRecordedError`
  with the SID, timestamp and status.
- The inbox touch and the `message_sent` audit are each best-effort: ERROR
  `outbound message sent but a post-append step failed (best-effort)` with
  `step: 'touchLastActivity' | 'audit'`, the error under `err`; the send
  returns its normal result; `conversation.updated` is skipped when the touch
  failed. The staff send route therefore answers 201 where it answered 500.
- Type imports (T3-2): `SendMessageResult`, `AppendResult`,
  `ConversationItem`, plus `NewMessage` and the `SendAttemptFacts` TYPE import
  (the module stays a runtime leaf of the attempt-record repo).
  `sendRefusalCases.ts` gets no row: no new gate.

### Task 7 - `app/src/jobs/sendReconcile.ts` (stub)

Exactly the plan's stub, no handler: `SEND_RECONCILE_JOB`,
`SendAttemptOwnerRef`, `SendReconcilePayload`, `toOwnerRef`,
`reconcileCheckDelaysMs`, `reconcileDelayMs`, `enqueueSendReconcile`
(`enqueue(SEND_RECONCILE_JOB, payload, { runAt })` - never `delaySeconds`).

### Task 7 - `app/src/jobs/broadcastFanOut.ts`

- Module level: `gateFor(attempts, owner, nowMs)` (G6 / T7-4: the repo is a
  parameter), `GateResult`, `BroadcastOwner`, the fence table
  (`NO_CONTACT_FENCE` + `fenceFor(contact)` in today's order),
  `UNCONFIRMED_LAST_ERROR` / `ALL_FAILED_LAST_ERROR`, and the exported D16a
  `finalize`. `errorCodeOf` and `TRANSIENT_CODES` are deleted (T7-10).
- In the handler: `sendAttempts ??= createSendAttemptsRepo(...)` and the pins
  `attempts`, `contactStore`, `conversationStore`, `send`, `businessNumber`
  beside the existing `repo` / `snapshot` pins (T7-4).
- The recipient unit is `runRecipient(contactKey)` - ONE try/catch that tracks
  `phase`, returning `'unknown' | 'other'` so the loop owns the D9 streak (the
  brake is a flag read at the top of the loop). Its failure arms are small
  closures (`declineAtFence`, `handToReconcile`, `handOff`, `deferClaimed`,
  `onRejected`, `onUnknown`, `afterSend`), each total.

The unit's phase map as implemented - every await, its phase, and what its
failure does ("guarded" = `guardWrite(log, { broadcastId, recipientKey },
<label>, fn)`, which logs ERROR and never throws):

| # | await | phase | on a throw / on its answer |
|---|---|---|---|
| 1 | `resolveContact` (contacts `getById` / `findByPhone`) | prepare | throw -> guarded deferSlot (`recordRecipientOutcome(queued/send_retryable, {}, ['queued'])`), carried, WARN `prepare failed - recipient deferred to the continuation` |
| 2 | fence gate: `gateFor` -> `attempts.get` (consistent), `attempts.takeOver` (stale only) | prepare | throw -> as 1. skip -> INFO, nothing. defer -> carried on a continuation only, INFO. taken_over -> `handOff`. proceed -> guarded `fenceWrite` (today's `setRecipient` + `bumpStats` + tick), plus guarded `closeRedriven(refused, <fence code>)` for a redriven record |
| 3 | `conversations.createOrGetByParticipantPhone` | prepare | throw -> as 1 |
| 4 | `attempts.claim(owner, facts, now)`; facts `recipientDigest(config.businessPhoneNumber, conversation.participant_phone ?? contact.phone)` (T7-13), sender, body hash, `mediaCount: 0` | prepare | throw -> as 1. refused -> no write; carried only when fresh AND a continuation (T7-11); INFO. takeover -> row 5 |
| 5 | `attempts.takeOver(owner, staleRecord)` | prepare | throw -> as 1. won -> `handOff`. lost -> INFO `takeover lost` |
| 6 | `sendMessage(...)` (unchanged args) | sending | SendRefusedError -> guarded `refusedSlot` (today's skipped write + bucket bump + tick) + guarded `finishAttempt(refused, cause = code)`. SendNotAttemptedError -> `deferClaimed(send_retryable)`: guarded deferSlot, carried, guarded `finishAttempt(retryable)`. SendAcceptedNotRecordedError -> ERROR `sent_unrecorded` + `handToReconcile(ref, err.providerSid)`. ProviderSendFailedError rejected -> `onRejected`; retryable -> WARN + `deferClaimed(provider code or send_retryable)`; unknown, and ANY other error (D2) -> `onUnknown`, counted by the brake |
| 7 | `repo.recordRecipientOutcome(sent + conversationId + tsMsgId, {sent:1, queued:-1}, ['queued'])`, then the tick | record | throw -> ERROR `sent_unrecorded` (with `providerSid`) + `handToReconcile(ref, outcome.providerSid)`; never classified, never re-sent (D3a) |
| 8 | `attempts.finishAttempt(sent, sid)` | record | throw -> as 7. `false` -> WARN `attempt fence lost after the slot write; the takeover reconcile repairs` (plan deviation 3) |
| 9 | `afterSend`: `tokenBucket.acquire(1)`, `activityEvents.record`, `listingSends.recordSend` | record | each in its own try/catch: the NEW acquire wrap WARNs; the milestone and listing-send catches stay ERROR (T7-5); none throws |

The arms:
- `onRejected`: 30007 / 30005 / 30006 keep today's writes (guarded
  `rejectSlot`: `setRecipient` failed + code, `bumpStats`, tick; 30005/30006
  also `setFlag(sms_unreachable)` in its own try/catch); any other rejection
  writes `recordRecipientOutcome(failed[, errorCode], {failed:1, queued:-1},
  ['queued'])` + tick, the slot code being the provider code or
  `sms_sending_disabled` and NEVER an HTTP status (a code-less 4xx writes no
  errorCode); then guarded `finishAttempt(rejected, cause = code ?? String(status))`.
- `onUnknown`: on an attempt whose record has `redriveCount >= 1` (D13a):
  guarded `closeUnconfirmed` (`closeRecipientIfQueued(send_unconfirmed,
  'unconfirmed')` + tick), guarded `finishAttempt(unresolved,
  'second_unknown')`, one ERROR with `cause: 'second_unknown'`, no reconcile.
  Otherwise WARN `unknown send outcome - recipient handed to reconcile` (with
  `err`) + `handToReconcile(ref)`.
- `handToReconcile(owner, ref, sid?)` (G5 / T7-8): the fence's answer is
  captured inside the guarded closure; `wrote && handed` -> `handOff`;
  `wrote && !handed` -> INFO `hand-off fence lost - the takeover owns the
  record`, no hand-off, not carried; `!wrote` -> STRANDED: carried, no slot
  write, the record stays `attempting`.
- `handOff(owner, attemptedAt)`: `enqueueSendReconcile({ owner:
  toOwnerRef(owner), attemptedAt, checkNo: 0 }, reconcileDelayMs(attemptedAt,
  0, now))`; an enqueue that throws closes the slot FIRST (guarded
  `closeUnconfirmed`), then the record (guarded `closeFromReconcile(unresolved,
  cause enqueue_failed)`), and ERRORs. Total.
- The loop: the terminal skip runs BEFORE the brake check (T7-12); once braked
  every non-terminal key is carried unconditionally (D9); an unknown (handed,
  stranded, fence-lost, or the second-unknown close) adds 1 to the streak,
  anything else resets it; after the loop one WARN `event: 'outage_brake'`
  with `untried` and `deferred`.
- Pass level (increment b): the snapshot is `getByIdConsistent` whenever
  `recipientKeys` is set; `redrive?: true` is parsed and carried; a re-drive
  pass claims no rung up front and, only with a transient remainder, claims
  one after the loop and takes the same missing / capped / claimed branches
  (the old "unreachable" guard stays for the impossible case); the
  continuation payload keeps its shape and never carries `redrive`.
- `closeBroadcast(keys, code, cause?)` keeps its `code` parameter (T7-3 / G7):
  per key, inside its OWN try/catch (ERROR `label: 'capClose'`, continue -
  T7-9), `gateFor`: taken_over -> `handOff`; skip / defer -> INFO; proceed ->
  `closeRecipientIfQueued(code, 'failed')` + tick and, for a redriven record,
  guarded `closeRedriven(code === enqueue_failed ? 'enqueue_failed' :
  'refused', cause: code)`. Then today's one ERROR line and `finalize`.
- `finalize` (D16a): consistent read; returns (INFO with the `open` count)
  while any slot is `queued`; the status from the recipients map (`failed`
  only when nothing reached sent / sending / delivered AND something failed
  or is unconfirmed); `last_error` "Couldn't confirm any text went out" when
  no real failure, else "all recipients failed"; `finalizeStatus` from
  `sending`; only the winner writes the unit audit row, emits the terminal
  tick and logs `broadcast send finalized` (now with `unconfirmed`).
- No broadcast slot ever gets `attemptedAt`; the five slot `toEqual` pins are
  untouched and green.

## Deviations from the plan / worklist, and why

1. The unit is an inner function (`runRecipient`) plus small total closures,
   not one inline block with `continue`s. Same phases, arms, writes and
   orders; the D9 streak is updated in ONE place from the unit's return value,
   so no `continue` can forget it.
2. The second-unknown close counts toward the brake (the unit returns
   `'unknown'`); the plan's sketch left the streak untouched there. D9 counts
   every unknown provider outcome. Only reachable with `redriveCount >= 1`,
   so no practical effect today.
3. Extra `broadcast.updated` ticks where a conditional write moved stats and
   the sketches named none: the generic rejected arm, the second-unknown close
   and `handOff`'s enqueue-failure close (S2's rule: a tick after every stats
   move). The retryable arm emits nothing (T7-14), as pinned.
4. Log fields: every line of the unit uses the plan's ctx
   `{ broadcastId, recipientKey: safeRecipientKey(key) }`; pre-existing lines
   that logged a raw `contactKey` now log `recipientKey` (redacted for a phone
   key) and were re-worded ASCII. INFO lines were added for the silent arms (a
   refused claim, a fence skip / defer, a lost takeover, a cap-close that
   leaves a recipient to its own attempt); the unknown arm WARNs with `err`.
   The generic rejected arm logs `errorCode` + `status`, NOT `err` (a Twilio
   4xx message can carry the phone number).
5. `deferClaimed` has ONE write order for the post-claim prepare arm, the
   SendNotAttemptedError arm and the retryable arm: slot first, then the
   record (the plan listed finishAttempt first for the prepare arm). Both are
   safe behind the `['queued']` prior; slot-first is the own-close rule. The
   post-claim prepare arm is defensive: nothing runs between the claim and
   `phase = 'sending'` today.
6. Tests beyond the plan (only in the two named test files). sendMessage: the
   wrapping table (conversation read, breaker increment, trip write,
   transport), a refusal inside a wrapped step and at the provider, the facts
   variants (no sender, explicit `from`, media, short body), the adapter kill
   switch's classification; two extra `makeFakes` seams (`setModeError`,
   `classifyError`). broadcast: 3 asserts the WARN, 4d split in two, 5d (G5
   lost fence), 7c (lost claim-path takeover), 7d (reconciling not carried),
   7e (T7-11 first pass), 10b (SendNotAttemptedError), 11b / 11c / 11d (fence
   gate arms), 13b (known arms close the record rejected), 13c (kill-switch
   token), 14 (an untyped error is unknown), 8b (lost cap-close takeover), 8c
   (capClose catch), 9e (redriven close enqueue_failed), 9f (post-loop claim
   ORDER via `invocationCallOrder`), 9g (re-drive send claims no rung), the
   parser, the consistent snapshot, and finalize cases (reached by each
   status, a real failure beside unconfirmed, skips alone, queued defers, the
   consistent read). Test 8 adds a done/retryable key (closed) to the plan's
   five.
7. `AdoptDeps` (T7-14) is NOT defined here: it is the deps type of
   `adoptBroadcastRecipient`, which moved to S3 with its only consumer.
8. Test 5c follows T7-2; its drain removes the one `broadcast.send` envelope
   by index (the stranded case enqueues no reconcile envelope).

No instruction contradicted the live code outside what the worklist covers;
no unexpected importer or cycle appeared (`sendReconcile.ts` imports
`jobs.ts`, `sendFingerprint`, `sendOutcome` and a type; `broadcastFanOut.ts`
uses its imports only inside function bodies, so Task 10's handler importing
back from `broadcastFanOut.ts` stays cycle-safe at module init); no existing
test outside the plan's listed red pin went red.

## The "fails on main" line

The plan's test 1, run against the UNCHANGED fan-out (only the stub existed):

```
FAIL  test/broadcastFanOut.test.ts > broadcast.send (M1.8a) > unknown send errors (spec D7, D7a, D8a, D9, D13a) - the first test must fail on main > 1 an unknown error on recipient 3 of 5 leaves 4 and 5 attempted, 3 handed to reconcile, no throw
AssertionError: expected [ 'queued', 'queued' ] to deeply equal [ 'sent', 'sent' ]
 > test/broadcastFanOut.test.ts:1260:74
```

with the job's `ProviderSendFailedError` thrown out of the loop and swallowed
by the in-process queue (`in-process deferred dispatch failed (swallowed - SQS
producer cannot observe consumer failure)`) - the anchor bug.

## Red -> green evidence

- Task 3: RED `Tests 10 failed | 69 passed (79)` (the ten new cases); GREEN
  `79 passed (79)`. The 17 test files that build the send service (761 tests)
  were green before the commit.
- Task 7 increment (a): RED `Tests 35 failed | 38 passed | 1 skipped (74)`
  (the new cases, the missing `finalize` export, the retargeted spy pin);
  GREEN `73 passed | 1 skipped (74)` with zero `deferred dispatch failed`
  lines in the run (nothing threw out of any job).
- Task 7 increment (b): RED `Tests 10 failed | 75 passed | 1 skipped (86)`;
  9f was then strengthened to assert the claim ORDER and failed on (a)
  (`expected 1 to be greater than 2`); GREEN `85 passed | 1 skipped (86)`.
- Final: `test/sendMessage.test.ts` 79 passed; `test/broadcastFanOut.test.ts`
  90 passed, 1 skipped (the planned `it.skip` for Task 10).

## Mutants (all 74 KILLED; both source files restored byte-identical, `cmp` clean)

| id | decision line | result (tests red) | first catching test |
|---|---|---|---|
| G1 | gate: absent record proceeds | KILLED (9) | skips an opted-out recipient (skipped_opted_out++), NO token spent,... |
| G2 | gate: done/retryable proceeds | KILLED (4) | close A: 429 capped at MAX_BROADCAST_ATTEMPTS (ladder driven for re... |
| G3 | gate: done/terminal skips | KILLED (2) | 11b a fenced recipient whose record is terminal is skipped |
| G4 | gate: redriven proceeds | KILLED (4) | 9a a re-drive pass claims no ladder rung up front ... |
| G5 | gate: stale vs fresh TTL comparison | KILLED (3) | 11 a foreign fresh attempt on a fenced recipient defers the fence |
| G6 | gate: a lost takeover defers | KILLED (1) | 8b a cap-close takeover whose fence is lost leaves the recipient alone |
| G7 | gate: fresh attempting / reconciling defers | KILLED (2) | 11 a foreign fresh attempt on a fenced recipient defers the fence |
| P1 | catch: phase 'prepare' arm | KILLED (6) | 3 a prepare-phase throw defers the recipient as send_retryable |
| P2 | catch: phase 'record' arm | KILLED (1) | 5a a record-phase failure after a successful send hands the SID ... |
| P3 | unit: phase = 'record' before the record writes | KILLED (1) | 5a (as above) |
| P4 | unit: phase = 'sending' before sendMessage | KILLED (20) | share-skip-fix D7: a manual-mode refusal is skipped ... |
| P5 | catch: pre-claim vs post-claim prepare arm | KILLED (1) | 3 a prepare-phase throw defers the recipient as send_retryable |
| U1 | second unknown: redriveCount threshold | KILLED (1) | 9b a re-drive attempt that comes back unknown closes unresolved |
| U2 | second unknown: the close arm | KILLED (1) | 9b (as above) |
| K1 | brake: threshold | KILLED (2) | 4a three consecutive unknowns brake the pass |
| K2 | brake: any other outcome resets the streak | KILLED (2) | 4b a sent between two unknowns resets the streak |
| K3 | brake: an unknown counts | KILLED (2) | 4a (as above) |
| K4 | brake: the untried remainder is deferred | KILLED (2) | 4a (as above) |
| K5 | brake: terminal skip BEFORE the brake check (T7-12) | KILLED (1) | 4a (as above) |
| S1 | stranded: a lost handToReconcile write carries the recipient | KILLED (2) | 4e a stranded unknown counts toward the brake |
| W1 | G5: hand off only when wrote && handed | KILLED (1) | 5d a handToReconcile whose FENCE is lost ... |
| W2 | G5: a lost fence is not stranded | KILLED (1) | 5d (as above) |
| C1 | slotCode: an HTTP status never reaches a slot | KILLED (1) | 13 a 4xx with no code writes failed with NO errorCode |
| C2 | slotCode: the kill-switch token is kept | KILLED (1) | 13c the adapter kill switch fails the recipient with its prose token |
| C3 | retryable slotCode: a network string never reaches a slot | KILLED (1) | 10 a retryable with a network code writes send_retryable |
| D1 | deferral: ['queued'] prior only | KILLED (1) | 3c the deferral never reverts a skipped slot |
| F1 | finalize: any queued slot defers | KILLED (5) | 1 an unknown error on recipient 3 of 5 ... |
| F2 | finalize: a reached recipient keeps sent | KILLED (3) | finalize: one dispatched (sending) recipient keeps the share sent |
| F3 | finalize: skips alone are sent | KILLED (4) | share-skip-fix I1: the SMS kill switch still refuses a DASHBOARD share |
| F4 | finalize: last_error prose | KILLED (5) | 6 a reconcile enqueue that throws closes the recipient unresolved |
| F5 | finalize: delivered counts as reached | KILLED (1) | finalize: one delivered recipient keeps the share sent |
| F6 | finalize: sending counts as reached | KILLED (1) | finalize: one dispatched (sending) recipient keeps the share sent |
| F7 | finalize: carrier-sent counts as reached | KILLED (1) | finalize: one carrier-confirmed sent recipient keeps the share sent |
| F8 | finalize: unconfirmed counts as failed | KILLED (3) | 6 (as above) |
| F9 | finalize: only the winner audits and emits | KILLED (1) | finalize: N callers produce one flip, one audit row, one terminal emit |
| F10 | finalize: consistent read | KILLED (1) | finalize: decides from the recipients map when the persisted failed counter is stale |
| R1 | cap-close: redriven closes enqueue_failed on close C | KILLED (1) | 9e a re-drive pass whose continuation enqueue is refused ... |
| R2 | cap-close: a redriven record is closed | KILLED (2) | 9c a re-drive pass that defers before its claim and hits the cap ... |
| R3 | fence: a redriven record is closed refused | KILLED (2) | 9a (as above) |
| CC1 | cap-close: per-key catch (T7-9) | KILLED (1) | 8c a cap-close whose gate read throws for one recipient ... |
| CC2 | cap-close: a takeover is handed off | KILLED (1) | 8 a cap-close closes only records that are absent or done/retryable ... |
| CC3 | cap-close: live / terminal records are left alone | KILLED (2) | 8 (as above) |
| FG1 | fence: a terminal record skips | KILLED (1) | 11b a fenced recipient whose record is terminal is skipped |
| FG2 | fence: a stale record is taken over, not fenced | KILLED (1) | 11c a fenced recipient whose record is stale is taken over |
| FG3 | fence: a deferred fence is carried on a continuation | KILLED (1) | 11 a foreign fresh attempt on a fenced recipient defers the fence |
| CL1 | claim: a first pass does not carry (T7-11) | KILLED (1) | 7e a FIRST pass does not carry a recipient a foreign fresh attempt owns |
| CL2 | claim: a refused !fresh claim is not carried | KILLED (1) | 7d a continuation that meets a reconciling record skips it |
| CL3 | claim: hand off only a won takeover | KILLED (2) | 7b a stale attempting record is taken over into reconcile ... |
| L1 | re-drive: no rung claimed up front | KILLED (4) | 9a (as above) |
| L2 | snapshot: consistent on a continuation | KILLED (1) | a continuation reads its snapshot strongly consistently ... |
| L3 | parser: redrive only when true | KILLED (1) | the payload parser carries redrive: true and nothing else |
| L4 | re-drive: the post-loop claim, never a close for want of one | KILLED (3) | 9c (as above) |
| H1 | hand-off failure: the unconfirmed bucket | KILLED (1) | 6 (as above) |
| H2 | hand-off failure: the record closes unresolved | KILLED (1) | 6 (as above) |
| H3 | hand-off: check 0 | KILLED (3) | 1 (as above) |
| H4 | hand-off: check 0 runs ~5 s after the attempt | KILLED (7) | 1 (as above) |
| RP1 | record: done/sent carries the SID | KILLED (1) | 9g a re-drive pass whose recipient sends claims no rung and finalizes |
| RF1 | refusal: record done/refused | KILLED (1) | 2 a claimed recipient whose sendMessage refuses closes done/refused |
| RJ1 | rejected: the record keeps its cause | KILLED (3) | 13 (as above) |
| SA1 | SendAcceptedNotRecordedError: the SID goes with it | KILLED (1) | 5b a SendAcceptedNotRecordedError from sendMessage does the same |
| SN1 | SendNotAttemptedError: deferred, never unknown | KILLED (1) | 10b a SendNotAttemptedError after the claim defers send_retryable |
| SM1 | D3: a refusal inside a wrapped step is never wrapped | KILLED (1) | a refusal thrown INSIDE a wrapped step, or by the provider call, passes through unwrapped |
| SM2 | D3: a refusal from the provider call is never wrapped | KILLED (1) | (as above) |
| SM3 | D3: conversation.updated skipped after a failed touch | KILLED (1) | a failure after the row is written does NOT throw ... |
| SM4 | facts: digest over the sender | KILLED (3) | a provider throw becomes ProviderSendFailedError carrying ... |
| SM5 | facts: media count | KILLED (1) | the facts follow the send: no business number means no sender ... |
| SM6 | wrapper mirrors status | KILLED (1) | a provider throw becomes ProviderSendFailedError carrying ... |
| SM7 | wrapper mirrors code | KILLED (2) | (as above) |
| SM8 | D3: an append failure is SendAcceptedNotRecordedError | KILLED (1) | an append failure after acceptance is SendAcceptedNotRecordedError with the SID |
| SM9 | D3: the audit row is best-effort | KILLED (1) | an audit failure after the row is written does NOT throw either |
| SM10 | D3: the inbox touch is best-effort | KILLED (1) | a failure after the row is written does NOT throw ... |
| SM11 | facts: the sender | KILLED (3) | a provider throw becomes ProviderSendFailedError carrying ... |
| SM12 | D1: the provider failure is classified | KILLED (3) | (as above) |
| SM13 | D3: the conversation read is wrapped | KILLED (1) | every other pre-provider step is wrapped the same way ... |

## Gates (exit codes)

- Fast gates: `cd app && npx vitest run test/sendMessage.test.ts test/broadcastFanOut.test.ts`
  -> exit 0, `Test Files 2 passed (2)`, `Tests 169 passed | 1 skipped (170)`.
- `npm run typecheck` (root) -> exit 0 (also after every code commit).
- Whole app workspace, foreground: `cd app && timeout 900 npx vitest run`
  -> EXIT=0, `Test Files 381 passed (381)`, `Tests 7382 passed | 2 skipped (7384)`,
  `Duration 149.58s`. Zero `[dynamoAdmin]` lines in the log. The two skips:
  the environmental `staticSmoke` case (no dashboard build) and the planned
  `it.skip` pass/verdict ordering test.
- `npx eslint app/src/jobs/broadcastFanOut.ts app/src/jobs/sendReconcile.ts app/src/services/sendMessage.ts app/test/broadcastFanOut.test.ts app/test/sendMessage.test.ts`
  (worktree root) -> exit 0, nothing reported.
- ASCII: every commit's staged added lines checked with
  `git diff --cached -U0 | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c` -> 0;
  the new `sendReconcile.ts` -> 0.

## Contract for downstream

`app/src/jobs/sendReconcile.ts` (stub; Task 10 adds the handler):
- `SEND_RECONCILE_JOB = 'send.reconcile'`.
- `type SendAttemptOwnerRef` = broadcast `{ kind, broadcastId, recipientKeyHash }` |
  relay_leg `{ kind, relayConversationId, sourceTsMsgId, recipientKeyHash }` |
  relay_rung `{ kind, relayConversationId, retryTsMsgId, recipientKeyHash }`.
- `interface SendReconcilePayload { owner: SendAttemptOwnerRef; attemptedAt: string; checkNo: number; continuation?: { senderKey: string; senderNameOverride?: string } }`.
- `toOwnerRef(owner: SendAttemptOwner): SendAttemptOwnerRef` (recipient key
  through `hashRecipientKey`).
- `reconcileCheckDelaysMs(): readonly number[]` - `E2E_SEND_RECONCILE_DELAYS_MS`
  ("a,b,c", exactly three finite non-negative ints) only when `JOBS_QUEUE_URL`
  is unset or empty; else `[5000, 30000, 240000]`.
- `reconcileDelayMs(attemptedAt, checkNo, nowMs)` =
  `max(0, attemptedAt + delays[checkNo] - nowMs)`.
- `enqueueSendReconcile(payload, delayMs)` ->
  `enqueue(SEND_RECONCILE_JOB, payload, { runAt: new Date(Date.now() + delayMs) })`.
- Its imports are used only inside function bodies (cycle-safe when Task 10
  imports `broadcastFanOut.ts` back).

`app/src/jobs/broadcastFanOut.ts`:
- `export async function finalize(broadcasts: BroadcastsRepo, events: EventBus, broadcastId: string, log: Logger, audit: AuditRepo): Promise<void>`
  - consistent read; a missing broadcast WARNs and returns; any `queued` slot
  -> INFO `broadcastFanOut: finalize deferred - recipients still open`
  (`open`) and returns; else `finalizeStatus(sent | failed, last_error?)`;
  a loser INFOs `finalize already done - nothing to write`; only the winner
  writes `units#<unitId>` `broadcast_sent { broadcastId, tenantCount }`
  (best-effort), emits `broadcast.updated`, and logs `broadcast send
  finalized` with the derived buckets incl. `unconfirmed`. Throws only when
  the read or the flip throws. Call it after your own writes.
- `BroadcastSendPayload = { broadcastId: string; recipientKeys?: string[]; attempt?: number; redrive?: true }`;
  `parseBroadcastSendPayload` keeps `redrive: true` only when the payload's
  `redrive === true`.
- The continuation this file enqueues: `{ broadcastId, attempt: nextAttempt, recipientKeys }`
  (raw keys - plan deviation 4), never `redrive`, `runAt` = the backoff.
- The RE-DRIVE envelope Task 10 must enqueue after `markRedriven(owner,
  attemptedAt)` returned true: `enqueue(BROADCAST_SEND_JOB, { broadcastId,
  recipientKeys: [contactKey], attempt: <any int >= 1, advisory>, redrive: true })`.
  That pass reads its snapshot consistently, claims no rung up front, claims
  the redriven record (attemptNo + 1, redriveCount stays 1), and: a second
  unknown closes unresolved (slot failed/send_unconfirmed, stats.unconfirmed,
  record done/unresolved cause second_unknown, one ERROR, no reconcile); a
  fence closes the record done/refused cause <fence code>; a pre-claim
  deferral + a capped post-loop claim closes transient_cap and the record
  done/refused cause transient_cap; a refused continuation enqueue closes
  enqueue_failed and the record done/enqueue_failed; a send finalizes.
- The reconcile hand-off payload for a broadcast recipient:
  `{ owner: { kind: 'broadcast', broadcastId, recipientKeyHash: hashRecipientKey(contactKey) }, attemptedAt: <the record's attemptedAt>, checkNo: 0 }`,
  no `continuation`; delay `reconcileDelayMs(attemptedAt, 0, now)` (0 - an
  immediate dispatch - for a takeover of a stale record).
- `resolveContact`, `emitBroadcastProgress`, `firstNameOf`, `recordRecipient`,
  `gateFor` stay module-local (T10-3 exports `resolveContact`).

Log events / labels a reconcile or a reviewer will grep (all `broadcastFanOut: ...`
with `broadcastId` + `recipientKey` through `safeRecipientKey`):
- WARN `event: 'outage_brake'` `{ broadcastId, untried, deferred, attempt }`.
- ERROR `sent_unrecorded - recipient sent but not recorded; its SID goes to reconcile` `{ err, providerSid }`.
- WARN `unknown send outcome - recipient handed to reconcile` `{ err }`.
- ERROR `unknown send outcome after a re-drive - recipient closed unresolved (send_unconfirmed)` `{ err, cause: 'second_unknown' }`.
- ERROR `reconcile enqueue failed - recipient closed unresolved (send_unconfirmed)` `{ err, cause: 'enqueue_failed' }`.
- INFO `hand-off fence lost - the takeover owns the record`; INFO `takeover lost - another writer moved the stale attempt`;
  INFO `claim refused - another attempt owns the recipient or it is resolved` `{ state, fresh }`;
  INFO `fence not written - the recipient attempt is terminal` / `fence deferred - another attempt owns the recipient` `{ fence }`;
  INFO `close left the recipient to its own attempt` `{ gate, closeCode }`.
- WARN `attempt fence lost after the slot write; the takeover reconcile repairs` `{ providerSid }`;
  WARN `prepare failed - recipient deferred to the continuation` `{ err }`;
  WARN `send not attempted - recipient deferred to the continuation` `{ err }`;
  WARN `transient send error - deferring recipient to the continuation` `{ errorCode, attempt }`;
  WARN `send rejected by the provider - recipient failed, NOT retried` `{ errorCode, status }`.
- guardWrite labels (ERROR `failure-arm write failed (best-effort); the attempt record decides`, field `label`):
  `deferSlot`, `finishAttempt`, `handToReconcile`, `closeUnconfirmed`,
  `closeFromReconcile`, `closeRedriven`, `fenceWrite`, `refusedSlot`,
  `rejectSlot`. The cap-close's per-key ERROR carries `label: 'capClose'`
  (`closing one recipient failed; the rest still close`).
- INFO `broadcast send pass complete` gains `handed`.

What Task 10 must provide:
- `export async function adoptBroadcastRecipient(...)` (D15) and its
  `AdoptDeps` in `broadcastFanOut.ts`, per the plan's pass-level bullet.
- Un-skip `it.skip('pass-then-verdict and verdict-then-pass both finalize exactly once')`
  in `describe('finalize (spec D16a)')` of `app/test/broadcastFanOut.test.ts`.
- The `send.reconcile` handler; `markRedriven` before every re-drive enqueue;
  `finalize(...)` after its own writes.
- If S3 registers the real handler in `broadcastFanOut.test.ts`, the
  test-local `recordReconciles()` helper (`defineJobHandler(SEND_RECONCILE_JOB, ...)`)
  must not run in the same test (a duplicate registration throws).

## Residues for the issue registry (throw points left outside the unit; line numbers at 6cf9bc1e)

The recipient unit is total. Left outside it, all after the run-once marker:
- `app/src/jobs/broadcastFanOut.ts:391-394` the snapshot read,
  `:496-499` the unit read, `:521` the up-front `claimFanoutPass` - the Sec 9
  per-PASS setup residue (unchanged class).
- `:1093` the NEW post-loop `claimFanoutPass` of a re-drive pass: a throw
  strands the re-drive's remainder (a record `redriven` or `done/retryable`
  beside a `queued` / `send_retryable` slot) for the sweeper.
- `finalize` (`:1197`, called at `:491` inside `closeBroadcast` and at
  `:1149`): its consistent read and `finalizeStatus` flip can throw and leave
  the broadcast `sending` with every slot terminal or owned elsewhere.
- A `takeOver` that throws AFTER it applied (the gate at `:249-256` via `:448`
  / `:640`, or the claim path at `:888`): the record is `reconciling` with no
  chain; the recipient is deferred (`queued` / `send_retryable`, carried) but
  the next pass's claim refuses it (`reconciling` is not fresh) and skips it -
  a stranded `reconciling` record (the D14 sweeper class).
- The gate-then-close window (`:448` -> `:457`, `:640` -> `:654`): between
  the gate's read (absent / done-retryable / redriven) and the conditional
  slot write, a concurrent pass could claim the recipient and be mid-send; a
  broadcast slot's `queued` prior cannot see an in-flight send (spec D8
  accepts this for broadcast slots; same family as
  `relay-fanout-active-pass-cap-close-race`). Needs two passes carrying one
  key at once (e.g. an ordinary continuation still carrying a key that a
  re-drive pass is sending).
- Only through that window: the record phase's `recordRecipientOutcome`
  (`:921`) answers `moved: false`; the record goes done/sent while the slot
  keeps the other writer's terminal status with no `conversationId` /
  `tsMsgId` for receipts to roll up.
- By design (T7-11): a first pass does not carry a fence `defer` (`:646`) or
  a fresh refused claim (`:878`); the owning attempt resolves the recipient.

## Concerns for the orchestrator

1. This report could not be written by the subagent (the harness refused
   report files from subagents); it was handed back as text.
2. The gate-then-close window above is real but narrow; worth naming beside
   `relay-fanout-active-pass-cap-close-race` when Task 15 files residues.
3. `closeBroadcast`'s operator ERROR text still reads "remaining recipients
   marked failed" although some may now be left to their own attempt (an INFO
   names each); the text is matched by the close tests (`'fan-out closed'`)
   and was left unchanged.
4. The D3 behavior change (a post-append failure answers 201 on the staff
   send route, not 500) is proven in `sendMessage.test.ts` only; no route test
   was in this dispatch's scope.
5. `resolveContact` still reads eventually (`getById`); T10-3 is S3's.
6. Scratch material (mutant runner, per-batch results, logs, pristine copies)
   lives only in the session scratchpad `...\scratchpad\S2a\`. Byte-exact
   excerpts are in the gitignored `.superpowers/sdd/S2a-reference.md`.

## Orchestrator checkpoint (added when landing this record)

Verified at 6cf9bc1e by the orchestrator: protected files untouched; 0
non-ASCII bytes in the added lines; `test/sendMessage.test.ts` +
`test/broadcastFanOut.test.ts` re-run EXIT=0 (169 passed, 1 skipped) with
zero swallowed dispatch failures; the unit, the gate, the cap-close, the
hand-off, the G5 rule and the brake loop read in full. Review items the
orchestrator carried forward: (R-a) `closeBroadcast` closes the SLOT before
`closeRedriven` for a redriven gate - a record-first order (slot only when
`closeRedriven` returned true) would fence a concurrent re-claim; (R-b) the
gate-then-close window above.
