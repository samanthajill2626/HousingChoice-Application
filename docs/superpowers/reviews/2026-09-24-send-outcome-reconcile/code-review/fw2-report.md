# Fix wave FW2 - the send sites, the send wrapper, the dashboard

Implementer: Claude Opus 5.5 (1M context). Worktree `W:\tmp\send-outcome-reconcile`,
base 1066bf9f, HEAD af848977. All ten FW2 items (`r1-adjudications.md` section
3, under the human ruling in section 6) built, tested and committed; the tree
is clean; no background process running.

Record note: the implementer returned this report as TEXT (the harness refuses
report-file writes from implementer subagents); the orchestrator landed it
here with its checkpoint appended, per AGENTS.md.

## Commits (each: bare git status read, no MERGE_HEAD, explicit paths, 0 non-ASCII added bytes, typecheck EXIT=0 with 0 "error TS", Co-Authored-By trailer)

- `3393d6d9 refactor(lib): one shared D8 gate - gateFor and GateResult move to lib/sendAttemptGate.ts, used by the broadcast fan-out, the relay fan-out and the retry rung (code review ADV-10; FW2-8)`
- `e3b13f6d fix(jobs): ADV-1 site half - every send site re-arms its claim as the last step before the provider call and fails closed: a lost re-arm sends nothing, a throw defers (code review ADV-1; FW2-1, Cameron's minimal ruling)`
- `b339ee0d fix(jobs): a terminal failure arm closes the record only once its slot write resolved; a slot write that threw leaves the attempt open and the recipient carried (code review C-2 / R-e; FW2-2)`
- `f890d711 fix(broadcast): a fence write that throws reaches the unit's prepare catch - the recipient is deferred send_retryable and carried instead of being swallowed (code review C-3; FW2-3)`
- `c44216cd fix(jobs): a close of a redriven record by another writer closes the record FIRST and writes its slot only when that won - a pass that re-claimed it in between keeps it (code review C-4 / R-a; FW2-4)`
- `f4197f87 fix(relay): a re-drive pass closes a carried member who left the roster - redrive_refused / member_removed, the record first, then the slot (code review ADV-5; FW2-5)`
- `7b8c160c fix(broadcast): the record phase runs its best-effort follow-ups before the record's done/sent, so a record write that throws no longer loses the property rows (code review ADV-6; FW2-6)`
- `46d63140 fix(broadcast): every pass reads its snapshot strongly consistently - the first pass too, which runs milliseconds after the route's markSending (code review ADV-7; FW2-7)`
- `1f108103 fix(dashboard): the mixed relay chip joins the D20 sentence after the failed legs' reasons when a send_unconfirmed leg sits beside a real failure (code review C-6 / R-d; FW2-9)`
- `af848977 test(api): the staff send route answers 201, not 500, when the inbox touch fails after a successful send - through the REAL send wrapper (code review D-5; FW2-10)`

## The ADV-1 site half: size, and the ruling

It stayed within Cameron's ruling and did NOT stop. It is its own commit,
e3b13f6d, so it can be reverted or measured alone.

- Source: 3 files, +59 / -7 (`git show --stat e3b13f6d -- app/src`):
  broadcastFanOut.ts +23/-2, relayFanOut.ts +23/-5, sendMessage.ts +13/-0. Of
  the +59, 25 are non-comment code lines; no code line was removed (the 7
  deletions are comment rewrites).
- Tests: 4 files, +398 / -8 (the 8 deletions are three restated slot-clock
  pins - deviation 1).
- Nothing outside the ruling was added: one `rearm` call per site; one
  optional input on sendMessage; one local flag in the broadcast unit. No new
  error class, no new outcome kind (`reason: 'takeover'` on skipped_terminal is
  an existing field value, as the ruling specified), no new states, no retries,
  no DynamoDB client change. No other sendMessage caller changed.
- No new failure mode beyond the one the ruling expected: the re-arm's extra
  DynamoDB call can throw, and a throw takes the existing prepare deferral.
- rearm() is used by both sites.

## Per item (file:line at HEAD; the regression test; its failing line on the pre-fix code)

**FW2-1 (ADV-1).** sendMessage.ts:386 adds the input `beforeProviderSend`;
sendMessage.ts:615 runs it after every gate and the facts, before `attemptedAt`
and `adapter.sendPreparedMessage` - `false` throws `SendNotAttemptedError('send
not attempted: the attempt was taken over', undefined)`, a throw is wrapped by
`notAttempted` (step 'pre-send hook'). broadcastFanOut.ts:887-895: the hook
re-arms and replaces `ref`; `undefined` sets `takenOver`; at :985 the existing
SendNotAttemptedError arm checks the flag (INFO, no write, not carried),
otherwise the existing deferClaimed runs on the pre-re-arm ref.
relayFanOut.ts:2020-2025: rearm after the `attempted` aggregation write, before
phase 'sending'; `undefined` returns skipped_terminal/'takeover' with an INFO;
a throw falls into the existing post-claim prepare catch (deferred
send_retryable, released retryable on the pre-re-arm ref, fenced). Every later
fenced write uses the returned ref. Tests: "ADV-1 (zz-adv-6): a pass stalled
between its claim and the send - taken over, reconciled never_sent and
re-driven meanwhile - resumes and does NOT send ..." on relay and broadcast,
through the REAL send.reconcile chain; failing lines relay `expected [
'+15550100002', '+15550100002' ] to deeply equal [ '+15550100002' ]`, broadcast
`expected [ '+15550100001', '+15550100001' ] to deeply equal [ '+15550100001' ]`
(both fail at the post-resume assertion; the re-drive half of each passed).
Also the lost-re-arm, throwing-re-arm and call-order tests per site, the rung's
lost re-arm, and 4 hook-contract tests in sendMessage.test.ts (failing lines
`expected [...] to have a length of +0 but got 1`, `expected "rearm" to be
called 1 times, but got 0 times`, `expected [] to deeply equal [ 'prepared=1
sent=0' ]`, `... to be an instance of SendNotAttemptedError`). The comment FW1
flagged (relayFanOut.ts, now :1400) was false (a long pass or a queue delay can
outlast the TTL); it now says the record ages from its re-arm, a later pass
past the TTL takes it over, one that meets it fresh defers it, and a record
still fresh at the cap is left for the sweeper.

**FW2-2 (C-2 / R-e).** Broadcast: onRejected :677/:731 (the
30007/30005/30006 arms included), the refusal arm :964/:972 and the
second-unknown close :752/:761 carry the recipient with the record left
attempting; handOff :556/:565 leaves the record reconciling and does not carry
it (no pass can act on a reconciling record). Relay: the refused, filtered and
rejected arms (:2148, :2170, :2198) and the second-unknown close (:2240) return
`stranded` (the loop carries it); the loop's handOff (:1220/:1228) and the
rung's handOff (relayRetryLeg.ts:617/:623, no root emit) leave the record
reconciling. The deferral arms are unchanged. Tests: "C-2 (probe P1): a 21211
whose reject-slot write throws leaves the record attempting ..." plus twins
for the 30007 arm, the refusal arm, the second unknown and the hand-off close;
the relay has an it.each over 21211 / 30007 / refusal plus the second-unknown
and hand-off tests; the rung has its hand-off twin. Failing lines: `expected
{...(13)} to match object { state: 'attempting', attemptNo: 1 }` (the record
was done/rejected); rung `... to match object { state: 'reconciling',
attemptNo: 1 }`.

**FW2-3 (C-3).** broadcastFanOut.ts:642-653: the fence's slot write and its
stats bump leave guardWrite, so a throw reaches the prepare catch (deferSlot +
carry); the `fenceWrite` label is gone. Test: "C-3 (probe P2): a fence write
that throws reaches the prepare catch ...", drained through the continuation to
finalize. Failing line: `expected { status: 'queued' } to deeply equal {
status: 'queued', errorCode: 'send_retryable' }`.

**FW2-4 (C-4 / R-a).** For a proceed gate on a redriven record, closeRedriven
runs FIRST and the slot is written only when it returned true; `false` logs an
INFO "re-claimed" and writes nothing. Five sites: closeBroadcast
(broadcastFanOut.ts:436-444); the fences (:646); closeRelay
(relayFanOut.ts:1280-1288); the suppression arm (:1875-1880, returns
skipped_terminal); the rung's closeUnlessOwned (relayRetryLeg.ts:681-697,
`gate: 'reclaimed'`). Tests: per site, the race (the gate reads the record
redriven, then another pass claims it before the close; failing lines
`expected { status: 'failed', ... } to deeply equal { status: 'queued' }` /
`... to be undefined`); the record-before-slot order (failing line `expected 3
to be less than 2`); the rung matrix gains the race case at all 6 sites, and its
"after the slot" test is restated record-first with an order assertion.

**FW2-5 (ADV-5).** relayFanOut.ts:1146-1148: a re-drive pass closes the
carried keys no longer on the roster via closeRedriveRefused(...,
'member_removed') - the record first, then the slot. Test: "ADV-5 (zz-adv-2): a
re-drive pass closes a carried member who left the roster after the reconcile
saw them ..." (the real chain; the member leaves right after markRedriven).
Failing line: `expected {...(11)} to match object { state: 'done', ... }` (the
record stayed redriven). Guard test: an ordinary continuation closes nothing.

**FW2-6 (ADV-6).** broadcastFanOut.ts:916: afterSend (the token, the
milestone, the listing-send row) runs after the slot write and BEFORE
finishAttempt(sent). Test: "ADV-6 (zz-adv-1): a record close that throws after
the slot moved no longer loses the property rows ...". Failing line: `expected
[] to have a length of 1 but got +0` (no listing_sent milestone). IDEMPOTENCY
FINDING: `listingSends.recordSend` IS idempotent (an UpdateItem upsert keyed by
unitId+contactId; a repeat refreshes sentAt); `activityEvents.record` is NOT
(every call Puts a new row with a random `evt-<uuid>` sort key, so a repeat
duplicates the "Property sent" milestone). The adoption half is therefore NOT
built.

**FW2-7 (ADV-7).** broadcastFanOut.ts:370: every pass reads with
getByIdConsistent. Tests: "ADV-7: a FIRST pass milliseconds after the route
marked the share sending still sends ..." (failing line `expected [] to deeply
equal [ '+15550100001' ]`); the pinned test restated as "every pass reads its
snapshot strongly consistently - the first pass too" (failing line `expected
"getByIdConsistent" to be called 1 times, but got 0 times`).

**FW2-8 (ADV-10).** NEW app/src/lib/sendAttemptGate.ts (GateResult :10,
gateFor :30); the three copies deleted. No behavior change and no new test: the
helper gains no logic; the existing gate tests passed unchanged, and 7 gate
mutants were killed.

**FW2-9 (C-6 / R-d).** dashboard/src/routes/contact/deliveryStatus.ts:622:
branch 1 joins the send_unconfirmed legs' D20 sentence AFTER the failed legs'
reasons; only the code speaks (a stale leg, even one carrying a transient code,
adds nothing). Test: the pin at deliveryStatus.test.ts:1922 restated, with a
dedupe case and a stale-transient guard; no Timeline.delivery pin changed (none
covers the mixed case). Failing line: `- "reason": "Carrier filtered the
message (error 30007); Couldn't confirm whether this text went out" / +
"reason": "Carrier filtered the message (error 30007)"`.

**FW2-10 (D-5).** app/test/apiRoutes.test.ts:125 "answers 201 with the
outcome when the inbox touch fails after a successful send" (the real wrapper
over the fake world). It passes on the current code by construction - coverage
of behavior that shipped in S2a; its teeth: mutant K01 restores main's rethrow
in the touch catch and gives `expected 500 to be 201`.

## Deviations, and why

1. Three slot-clock pins restated (FW2-1): the relay slot's D20a attempt
   clock stays the CLAIM instant, because nothing may run between the re-arm
   and the provider call. The pins (relay test 1 both branches, relay test 7
   twice, the rung's "an unknown send on the real unit") now compare the slot
   clock with the claim's `nowIso` instead of the record's re-armed
   attemptedAt; they pass on both the old and the new code - not a redesign.
2. INFO wording: the lost re-arm logs a new INFO, "attempt taken over before
   the send - not sent; the takeover owns it" (the claim path's "takeover lost"
   describes a different event).
3. Hand-off failures are not carried (FW2-2): the record is reconciling and no
   pass can act on it - the adjudication's "where a pass can still act".
4. Log lines on the failure paths (FW2-2): new accurate ERROR wording for the
   failed-close paths; the refusal and rejection slot-write ERRORs now carry
   `refusal` / `errorCode` (on relay the stranded path skips the arm's outcome
   line); on broadcast the known arms' outcome lines are still logged, preceded
   by the guardWrite ERROR, and their "recipient failed" text overstates on
   that path.
5. Relay stranded rejections count toward the outage brake (FW2-2): a
   `stranded` rejection or refusal counts toward D9 (`stranded` without
   afterSend); the broadcast twin, carried with 'other', does not - a
   double-fault asymmetry, now noted in the isUnknownOutcome doc.
6. Where a closeRedriven throw lands (FW2-3/FW2-4): in the fence and the
   suppression arm closeRedriven is now UNGUARDED, a PREPARE write, so a throw
   goes to the prepare catch (defer + carry), consistent with C-3; in the
   cap-closes it goes to the per-key catch; on the rung it stays guarded
   (unguarded it would throw out of the job).
7. FW2-6 adoption half skipped (the idempotency finding).
8. FW2-7 test adaptation: the harness fake's getByIdConsistent delegates
   through getById (FW1's file, not changed); the behavioral test gives the
   consistent read its own implementation, and the pinned test drops a
   "getById not called" assertion the fake cannot express.
9. FW2-7 red check: the revised tests were proven red by writing HEAD's source
   bytes (read with git show into scratch) into place, then writing back the
   fixed bytes; `cmp` confirmed; no git checkout, restore or stash was used.

## Mutants

56 one-line mutants, all KILLED; each run by a scratch runner that writes back
the ORIGINAL bytes in `finally` (and on a signal) and checks them byte-for-byte
against a pristine copy; `cmp` OK after every batch; no commit ever contained a
mutant.

| group | mutants | what they mutate | killed by |
|---|---|---|---|
| FW2-1 | A01-A05 (relay) | the undefined check dropped, ref not replaced, return transient, re-arm skipped, reason dropped | the zz-adv-6 test, kill-switch test 5, the lost re-arm test, the rung lost re-arm test |
| FW2-1 | S01-S03 (sendMessage) | hook answer inverted, hook not wrapped, plain Error thrown | the hook tests, the broadcast throwing re-arm, zz-adv-6 |
| FW2-1 | B01-B05 (broadcast) | flag not set, ref not replaced, flag ignored, hook answers true, hook not passed | zz-adv-6, brake test 4a |
| FW2-2 | C01-C07 (broadcast) | record close unconditional, carry dropped, second-unknown gate, refusal gate, message ternary, refusal ctx | the P1 / refusal / second-unknown / hand-off tests |
| FW2-2 | R01-R07 (relay), G01 (rung) | each stranded return dropped, `skipped_terminal` returned instead, hand-off gate, refusal ctx | the relay P1 it.each rows, second-unknown, hand-off; G01 the rung hand-off test |
| FW2-3 | F01 | fence write swallowed | P2 |
| FW2-4 | D01-D10 | record close dropped or its result ignored per site; suppression returns transient; the rung's gates | the race and order tests, 9a / 9c, the rung matrix, RSW #1 |
| FW2-5 | E01-E03 | guard off, wrong cause, inverted filter | zz-adv-2, 9a |
| FW2-6 | H01-H02 | follow-ups dropped; the old order restored | the listing tests, zz-adv-1 |
| FW2-7 | I01 | the old conditional read | both ADV-7 tests |
| FW2-8 | L01-L07 | each gateFor arm | existing tests across all three sites |
| FW2-9 | J01-J03 | join dropped, stale legs joined, order reversed | the restated pin and the stale-transient guard |
| FW2-10 | K01 | main's rethrow | `expected 500 to be 201` |

## Gates (exit codes)

- Fast gate (sendMessage, broadcastFanOut, relayFanOut, relayRetryLeg,
  sendReconcile, apiRoutes): EXIT=0, 6 files, 630 passed.
- Dashboard (`npm run test -w @housingchoice/dashboard -- src/routes/contact`):
  EXIT=0, 67 files, 1333 tests.
- `npm run typecheck`: EXIT=0, 0 "error TS".
- `npm run smoke`: EXIT=0, "1481 import specifier(s) across 259 emitted
  file(s)" (FW1 had 258; the extra file is the new gate module).
- Whole app workspace (foreground, `timeout 590 npx vitest run`): EXIT=0 -
  383 files; 7666 passed, 1 skipped (staticSmoke, environmental); 254.2 s; 0
  "[dynamoAdmin]" lines.
- Neighbour check: 25 other files that drive the fan-outs or the wrapper, run
  after FW2-1: EXIT=0, 1151 passed.
- eslint on all 12 touched .ts/.tsx files: EXIT=0, nothing reported.
- ASCII: 0 non-ASCII bytes in the added lines across 1066bf9f..HEAD.
- Protected and FW1 files: 0 diff lines in twilio.ts, jobs.ts,
  sqsJobConsumer.ts, retrySend.ts, registerHandlers.ts, sendAttemptsRepo.ts,
  sendReconcile.ts, sendOutcome.ts, the harness, and docs/.

## New residues (for FW3)

1. Relay slot clock (FW2-1): the relay slot's D20a clock is the claim instant,
   not the re-arm; after a long pre-send stall the leg can read "Queued - not
   confirmed" up to the stall's length early (display only).
2. Re-arm cost (FW2-1): every send now costs 1 consistent Get + 1 TransactWrite
   (FW1 residue 2, now live); a DynamoDB fault at the re-arm defers the send,
   failing closed.
3. Rejected recipient with a failed slot write (FW2-2): it is left attempting
   and carried; at the broadcast cap it is taken over, and the reconcile (the
   provider holds nothing for a synchronous rejection) rules never_sent and
   re-drives once - a second provider call for a rejected send (for 30007 it
   re-offers filtered content); on relay the ladder never clears the TTL, so it
   goes to the sweeper (a double fault).
4. A won record close whose slot write then throws (FW2-3/4): a fence, the
   suppression arm, a cap-close and the rung - the record ends done/refused
   while the slot stays open; the next gate SKIPs it, and nothing re-applies
   the slot (FW1-4's re-apply covers only the reconcile's own closes); the
   broadcast then defers finalize (a double fault).
5. Rung closeRedriven throw (FW2-4): a guarded throw leaves the record
   redriven and the retry leg queued (the T9-7 stranding class).
6. Bucket wait holds the record (FW2-6): the token acquire now runs before
   finishAttempt, so a contended bucket keeps the record attempting through the
   wait (well under 30 s at about 1/s).
7. Adoption half and replay risk (FW2-6): the adoption half is unbuilt - if the
   process dies between the slot write and the follow-ups, the adoption finds
   the slot moved and the rows are lost; it needs an idempotent milestone write
   (for example a deterministic eventId).
8. Asymmetry and a stale contract: deviation 5 (relay stranded rejections count
   toward the brake); the S2a label list is stale (`fenceWrite` no longer exists).

## Concerns

1. e2e not run (per the brief); no e2e spec reads the slot attempt clock (a grep
   of e2e/ for attemptedAt returned nothing), but the orchestrator's e2e gate
   should confirm the re-arm under the lane.
2. Stall simulated, not waited: the zig-zag tests simulate the 31 s stall by
   claiming at a past instant (a spy on claim) rather than waiting; the record
   state is equivalent.
3. Machine load: the app run was clean; no DynamoDB-backed file failed.
4. Scratch: only under the session scratchpad `FW2\`.

## Orchestrator checkpoint

Verified at af848977: the 12 in-scope files only (no protected, FW1-owned,
harness or docs file); 0 non-ASCII bytes in the added lines; `npm run
typecheck` EXIT=0 with 0 `error TS`; the ADV-1 site half measured from the
commit itself (`git show --numstat e3b13f6d`: source broadcastFanOut.ts
+23/-2, relayFanOut.ts +23/-5, sendMessage.ts +13/-0; tests
broadcastFanOut.test.ts +157/-0, relayFanOut.test.ts +153/-6,
relayRetryLeg.test.ts +23/-2, sendMessage.test.ts +65/-0) and the relay hunk
read - one re-arm, undefined -> skipped_terminal/'takeover' with an INFO, a
throw into the existing prepare catch - within Cameron's ruling.
