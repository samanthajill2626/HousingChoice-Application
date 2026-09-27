# Plan review r2 - reviewer B (adversarial, continued)

Plan: `docs/superpowers/plans/2026-09-26-send-outcome-reconcile.md` revision 2
(@16dd3dda). Spec rev 9. Adjudications: `adjudications.md` "Plan round 1".
Method as round 1: every claim below was checked against the repo at 16dd3dda
(file:line cited). Anything not verified is marked UNVERIFIED. Plan line
numbers are "plan:NNN".

Order follows the brief: new problems first (1-9), then problems in the
rewritten material, then contests, then smaller items. Most of what matters in
this round sits in the NEW material: the per-recipient try/catch, the D8 gates
and the adoption writes. Those were written to answer round 1 and have not
been reviewed until now.

---

## 1. [HIGH] Relay unit: a failed SEND-failure-arm write is misread as a pre-send throw, and the member is re-sent

What is wrong: Task 8 nests the provider call's classification arms inside one
outer `try`. The outer `catch` decides "did the send happen?" with a single
test, "result assigned" (plan:783-797). An `unknown` provider error means a
message MAY exist. The `unknown` arm calls `handToReconcile(ref)` (plan:792).
If that write throws (a DynamoDB blip, a TransactionConflict), control reaches
the outer catch. `result` was never assigned, because the provider threw. The
catch therefore takes the "pre-send throw after the claim" branch:
`finishAttempt(ref, retryable)`, persist `queued`/`send_retryable`, return
`transient` (plan:796). The loop pushes the member into `transientRemaining`,
and the continuation re-claims (from `done`/`retryable`) and SENDS AGAIN. If
the first send landed, that is a double text. It breaks guarantee 1 ("Nobody is
texted twice") and D7a ("A failure-arm write ... that itself fails is logged at
ERROR ... the record keeps `attempting`"). The second-unknown close
(plan:791) has the same path, and a third attempt can follow.
`finishAttempt(retryable)` is conditioned only on
`state = attempting AND attemptNo AND attemptedAt` (plan:548-553). That is
exactly the state a failed `handToReconcile` leaves, so the release succeeds
as soon as the database recovers.

Evidence: plan:783-797. In today's code the send has its own try/catch
(`app/src/jobs/relayFanOut.ts:1429-1493`), and `let result` sits inside the
region the plan wraps.

Implies: the outer catch needs a phase marker, not "result assigned". A throw
from a SEND-phase failure arm must ERROR and return a kind the loop does not
defer (the record stays `attempting` for the sweeper, per D7a). Add a test in
which `handToReconcile` throws after an `unknown`, asserting no second provider
call.

## 2. [HIGH] Broadcast: the catch arms' own writes are unprotected, so a DB blip still throws out of the loop

What is wrong: Task 7's recipient unit is `try { ... } catch (err) { arms }`
with no protection around the arms (plan:685-725). Each arm writes:
- the pre-claim deferral's `setRecipient` (plan:711);
- `finishAttempt` (plan:713-719);
- `recordRecipientOutcome`;
- `handToReconcile` plus `handOff`, whose own catch writes twice more
  (plan:729).

A throw inside a `catch` block leaves the for loop. The job then throws under
the run-once marker: the anchor bug, in its most likely form. The pre-claim arm
exists precisely for "a DynamoDB read failed", and the write in that arm goes to
the same table under the same conditions. The plan promises "one outer
try/catch per recipient; nothing throws out" (plan:685, Global Constraints
plan:37); the pseudo-code does not deliver it. Task 8 does (its loop has "its
own outer try/catch per member", plan:800); Task 7 has no equivalent.

Also: the `else` arm's "outcome was assigned" test (plan:723) only works if
`outcome` is declared before the `try`, which the sketch never shows.

Implies: wrap each arm (or the whole catch body) so a failing arm write ERRORs
and continues, as D7a states, and hoist `outcome`. Add a test that makes the
deferral write throw and asserts the next recipient is still attempted.

## 3. [HIGH] Revision 2 points at "revision 1" content that is no longer in the file

What is wrong: 18 places say "as in revision 1" or "revision 1's cases"
(grep). Revision 1 exists only in git history, at a commit the plan never
names. Several of these references carry the ONLY statement of a task's tests
or implementation:
- Task 3 Step 2: "revision 1's six cases" (plan:662) - not listed. This is
  Sec 8 test 2, the D3 proof.
- Task 3 Step 3: "revision 1's classes and wrapping" (plan:663).
- Task 6 Step 1: "revision 1's six cases" (plan:631) and Step 3: "revision 1's
  three cases" (plan:633) - not listed. These are the tests for the D8/D11/D16a
  primitives (the reporting pointer claim, the conditional close, the consistent
  reads, the one-write slot+stats, the won-once finalize).
- Task 4 Steps 1-2 (plan:496-498) - partly listed.
- Task 8: "counts as revision 1" (plan:800).

Some of those revision-1 bodies are what round 1 flagged as wrong (the Task 3
sketch's `f.env` / `LIVE` / `status: 'sent'`; the Task 5 nine-alias helper).
Sending a builder back to them re-imports defects the round fixed.

Implies: inline the case lists and the implementation notes, or name the commit
and state which parts of revision 1 are superseded. As written the plan does
not stand alone.

## 4. [MEDIUM] Task 5 wires `sendAttemptsRepo` into handler deps that do not have the field yet: typecheck red at Task 5

What is wrong: Task 5 Step 4 makes every registration site pass
`sendAttemptsRepo: world.sendAttemptsRepo` (plan:521, 597), and
`registerHandlers.ts` "passes it through" (plan:170, 518). The three
deps interfaces gain `sendAttemptsRepo?` only in Tasks 7, 8 and 9
(plan:683, 767, 821). `BroadcastSendJobDeps` (`app/src/jobs/broadcastFanOut.ts:187-205`),
`RelayFanOutJobDeps` (`app/src/jobs/relayFanOut.ts:636-672`) and
`RelayRetryLegJobDeps` (`app/src/jobs/relayRetryLeg.ts:115-146`) have no index
signature. An object literal with an unknown property is TS2353 (excess
property check), and `app/tsconfig.test.json` typechecks `test/`. So Task 5
Step 5 (`npm run typecheck -> 0`) is red, and the three job files that would fix
it are not in Task 5's Files. Vitest does not typecheck, so Step 4's "whole
suite green" hides this.

Implies: Task 5 adds the optional field to the three deps interfaces (list the
files), or the wiring moves to Tasks 7-9.

## 5. [MEDIUM] D13's "SID another ATTEMPT already holds" is implemented only through pointers; the known-SID path then has no verdict for "held elsewhere"

What is wrong: spec D13 says to exclude "any candidate whose SID another attempt
or owner already holds - a `sid#` or `relaysid#` pointer ... or the `syssid#`
marker". Task 10's `heldBy` checks only pointers and markers (plan:885). A
sibling attempt can hold a SID on its RECORD before any pointer exists:
- `SendAcceptedNotRecordedError`: Twilio accepted, the append (and so the
  `sid#` pointer) failed, and the record goes `reconciling` with the SID
  (plan:715);
- a relay RECORD-phase slot-write failure (plan:795).

Scenario: a same-body attempt to the same tenant from the same sender
(re-sharing the same property inside the window). It lists that SID, finds no
pointer, matches the body and ADOPTS it: it appends the row stamped with its own
`broadcast_id`. The sibling's known-SID reconcile then runs `adoptKnown`, whose
append dedupes onto the other broadcast's row, giving `'other_owner'` /
`{ kind: 'other' }` (plan:897-902). Task 10's verdict switch has arms only for
`found`, `continue`, `never_sent` and `unresolved` (plan:860-864). The record
stays `reconciling` with no successor enqueued, and the sibling broadcast never
finalizes.

The plan also builds this path itself: Task 8 turns a `claimRelaySidPointer`
`'other'` into `sent_unrecorded` and hands it to reconcile (plan:793), and the
known-SID adoption meets `'other'` again. Task 8's test "the fan-out's
relaysid# claim reports other ..." (plan:802) drives straight into it.

Implies: `heldBy` must also consult the recipient index's sibling records' `sid`
(D8a built that index), and the known-SID path needs a defined verdict when the
SID belongs to someone else. D13 says the known-SID verdict "is found", so this
needs a spec ruling (probably `unresolved`) - a D13 decision gap, not only a
plan fix.

## 6. [MEDIUM] `setRelayRecipientAttemptedAt` repeats the unused-alias trap round 1 was about

What is wrong: Task 6 states ONE names list for a two-statement write:
"(1) `SET #dr.#mk = if_not_exists(#dr.#mk, :seed)` ... (2) `SET #dr.#mk.#at =
:at` ...; names `{ '#dr', '#mk', '#at': 'attemptedAt' }`" (plan:622).
Statement (1) never references `#at`, so a builder who passes the stated list
to (1) gets a ValidationException. The repo pins that behavior at
`app/test/aiRunsRepo.integration.test.ts:302-316`, and the plan cites the pin
itself at plan:35. Task 8 treats this write as best-effort ("WARN on
failure", plan:782), so the only symptom is that no relay slot ever gets
`attemptedAt`. D20a aging would never fire, and a legacy slot would never be
created at claim time. The Task 6 test would catch it, but only after the plan
itself led the builder into it, in the round that fixed this class.

Implies: state names per statement, as `closeRelayRecipientIfUnsent` now does
(plan:620).

## 7. [MEDIUM] Legacy relay adoption is not forward-only: a `queued` adoption regresses a `sent` slot (contests A14/B25 "fixed")

What is wrong: `adoptRelayRecipientIfUnsent`'s legacy write sets
`#dr.#mk.#st = :st` under `#dr.#mk.#st IN (:queued, :sent)` WHATEVER the target
status is (plan:621). Adoption targets `queued` for a provider status of
`accepted`, `queued` or `sending` (plan:905). Adoption claims the pointer
FIRST (plan:903), and after that the status webhook routes callbacks: a `sent`
callback moves the slot `queued -> sent` through
`updateRecipientDeliveryStatus` (a child-field write,
`app/src/repos/messagesRepo.ts:3684-3758`). The adoption write that follows
passes `IN (queued, sent)` and writes `queued` back - the regression D15
forbids ("a status callback that raced ahead of the adoption cannot be
regressed by it"). The repo's forward-only table is
`app/src/repos/messagesRepo.ts:133-141` (`queued` accepts only
`queued_pending`). The Task 6 test covers only a slot already `delivered`
(plan:631).

Implies: condition on `allowedPriorStatuses(target)` plus the same status (the
versioned path's rule), and add the `sent`-then-`queued` case. There is also
no create-if-absent branch: a legacy slot whose best-effort `attemptedAt` write
failed does not exist, adoption returns `missing` and throws (plan:903), and the
job retries five times to the DLQ.

## 8. [MEDIUM] The new D8 gates use a deny-list ("foreign OPEN attempt"); D8 is an allow-list

What is wrong: D8 lets a close proceed ONLY when the record is absent or
`done`/`retryable`. It takes over a stale `attempting` record and skips
everything else. The suppression-arm gate proceeds unless the record is
"attempting fresh / reconciling / (redriven and !redrive)" (plan:773), and the
rung's gate skips only "on a foreign open attempt" (plan:824). Two cases fall
through to an unconditional terminal write:
- `done`/`sent` with a `queued`+sid slot (a provider-queued success). The
  versioned write, `applyRecipientSendResult`, allows `failed` over `queued`
  and ignores `sid` (`app/src/repos/messagesRepo.ts:3485`, `:3509-3515`,
  `:141`), so a duplicate pass's suppression write or a duplicate rung's
  window close marks a sent leg `failed`. Task 8's own test "run the same
  envelope twice" (plan:802) is that duplicate pass.
- stale `attempting`: written over with no takeover and no reconcile.

`closeBroadcast` and `closeRelay` got the allow-list right (plan:733, 800).

Implies: the two new gates use the same allow-list as the closes.

## 9. [MEDIUM] The page-size guard checks the impossible direction (contests B11/A20 "partly")

What is wrong: the adjudicated fix WARNs when
`page.instances.length > args.pageSize` (plan:496-498). A provider does not
return more than it was asked for. The risk D13 names ("the driver asserts the
size it asked for is the size it got") is the opposite: a server-side cap, say
50 per page, silently shrinks the 5-page bound from 5000 messages to 250 and
turns ordinary histories into `page_bound` / `unresolved`. `instances.length`
cannot detect a cap on a short last page either. The hook is
`page._payload.page_size` (twilio-node `lib/base/Page.d.ts`, `_payload:
TPayload` with `page_size: number`), which the data-layer research named
(M4).

Implies: compare `_payload.page_size` with the requested size and WARN on any
difference. The test should use a fake page whose `page_size` is smaller than
requested.

## 10. [LOW] Task 4's harness change breaks an exact-shape pin nobody listed

Task 4 makes each `world.sent` element carry `sid` and `providerTs`
(plan:494). `app/test/twilioStatusWebhook.test.ts:1275` asserts
`expect(world.sent).toEqual([{ to: TENANT_PHONE, body: 'outbound body' }])`,
which fails on the extra properties. Task 5 Step 4's "whole suite green"
(plan:597) will then be red for a reason Task 5 did not introduce.

## 11. [LOW] A re-drive pass that defers before its claim at the cap strands its own `redriven` record

A pre-claim throw on a re-drive pass defers the key (plan:711) with the record
still `redriven`. The post-loop pass claim (plan:733) may return `capped`
(the unknown happened on the last rung; the re-drive is enqueued at
`fanout_attempt + 1`, plan:907). `closeBroadcast`'s gate then skips a
`redriven` record ("other states skip", plan:733). The slot stays `queued` and
the broadcast never finalizes. D8: "A pass that carries the re-drive marker
OWNS the `redriven` record for its recipient". The cap-close in that pass must
treat it as its own. The same applies to relay (plan:800).

## 12. [LOW] Broadcast fences are ungated while the plan's own deferral creates the case - a D8 enumeration gap

A continuation carries keys deferred by a FOREIGN fresh claim (plan:697). On
the next pass, the fences run first (plan:693) and write `skipped` blindly
(`app/src/jobs/broadcastFanOut.ts:396`, `:406`, `:422`, `:439`) over a
recipient whose foreign attempt may be mid-send. Spec D8 lists the relay
opt-out arm but not the broadcast fences, and says "Every other pre-claim
decline touches no record (the record is absent)". That premise is false for a
deferred-by-claim key. This touches D8's wording (a SPEC change: add the
broadcast fences to the gated list, or state the race as accepted).

## 13. [LOW] The "no phone in any payload" test contradicts the plan's own payloads; one log line logs the raw owner

Case 21 asserts "no `phone#+` substring in any enqueued payload for a
phone-keyed recipient" (plan:914). Two payloads the plan itself specifies
break that:
- the re-drive envelopes carry raw keys in `recipientKeys: [contactKey]` /
  `[memberKey]` (plan:907), and must, because the fan-out parsers filter by the
  raw key (`app/src/jobs/relayFanOut.ts:1042-1045`);
- the reconcile payload's `continuation.senderKey` is a member key, which is
  `phone#<E164>` for a contact-less sender (plan:189).

Global Constraint plan:41 is worded as absolute. Scope both to the
recipient-owner field. Separately, Task 7's
`ERROR 'recipient unit failed after the claim' { err, owner }` (plan:723) logs
the raw `owner`, which breaks plan:41 for phone-keyed recipients.

## 14. [LOW] Three "corrected" seam descriptions are still wrong

- Task 1 says `createLogCapture()` lines "are JSON strings" (plan:367). They
  are parsed objects (`app/test/helpers/logCapture.ts:6-11`); the existing
  case reads `l['event']` (`app/test/messaging.test.ts:384`).
- Task 3 says "its `capture.atLevel('error')` string lines" (plan:662).
  `atLevel` takes a number; the file uses `const ERROR = 50`
  (`app/test/sendMessage.test.ts:38`, `:820`).
- Task 12 says `createGroupOpen` returns "the member numbers/labels"
  (plan:1016). It returns `{ conversationId, status, pool_number }`
  (`e2e/fixtures/relayConnect.ts:37-41`, `:162-165`); the members are the
  caller's own input.

## 15. [LOW] `reconcileDelayMs` does not say it reads the lane-overridable delays

The shared block defines `reconcileDelayMs` as
"max(0, attemptedAt + DELAYS[checkNo] - nowMs)" (plan:198), and separately
`reconcileCheckDelaysMs()` "lane-overridable" (plan:197). If `DELAYS` is the
constant, the lane checks run at 5/30/240 s. Task 12's 40 s budgets
(plan:1021, 1023) then fail, because `never_sent` and `unresolved` land at
240 s. State that it reads `reconcileCheckDelaysMs()`.

## 16. [LOW] Contest B24: the adjudication says the takeover slot-write acceptance is "stated as accepted"; the plan states it nowhere

grep of the plan for the acceptance finds nothing. D8's last paragraph ("a send
site's post-claim closes ... are conditioned on the record's
`attemptNo`/`attemptedAt`") is a spec rule the plan departs from. The plan
lists only two deviations (plan:13) and this is not one of them. Record it in
plan:13 and in Task 15's residue issue.

## 17. [LOW] Contest A22/B22: Task 15 still omits two registry files

The spec's header table says this branch builds piece 1 of
`accepted-send-lost-when-append-fails` and "substantially" builds
`exactly-once-send-intent`. Task 15 (plan:1041-1048) updates neither
(`docs/issues/accepted-send-lost-when-append-fails.md` and
`docs/issues/exactly-once-send-intent.md` exist, both `status: open`).

## 18. [LOW] Duplicate contacts on one phone in one broadcast can both adopt the same message

A broadcast keys recipients by contactId
(`app/src/routes/broadcasts.ts:267-277`), so two contacts sharing a phone are
two recipients. Task 7 and Task 10 define "mine" by `broadcast_id` alone
(plan:683, 885). The sibling rule compares `ownerKey`, which excludes the
recipient (plan:894), so same-broadcast siblings never block each other. Two
`unknown` duplicates with one orphan both adopt it. Spec D11 compares
"its `broadcast_id` and the record's owner". The row's `recipient_contact_id`
is the discriminator.

## 19. [LOW] The D9 streak is not reset by skips

Spec D9: "Any other outcome between two unknowns - sent, rejected, retryable,
refused, a skip - resets the streak to zero." Task 7 resets the streak on
sent, refused, rejected, retryable and a pre-claim deferral (plan:707-719). It
does not reset on the fence skips or the `refused & !fresh` skip
(plan:692-698). The tests cover only "a sent between two unknowns"
(plan:739).

## Adjudications conceded (one line each)

- A15/B12's second half (the rung's gate writes staying on today's
  `persistRelayRecipientResult`): conceded. With a correct allow-list gate
  (finding 8) the record decides.
- A5/B4 (the leaf module): the fix is correct. `messagingErrors.ts` is
  dependency-free (plan:224-233) and `sendOutcome.ts` imports only it
  (plan:309).
- B2 (the wrapper's `code`/`status`, and T3 moved next to T7): correct.
  `errorCodeOf` and `summarizeError` read own properties
  (`app/src/lib/errors.ts:68-98`).
- A1/B3 (a second unknown after a re-drive): correct at the send sites
  (plan:720, 791) and in the job (plan:907). Test 9 and case 20 pin it.
- A8/B5 (Task 8 optional args, required from Task 9): typecheck is green at
  Task 8. The only other caller is `relayRetryLeg.ts:626-654`; no test calls
  the unit directly except the passthrough mock at
  `app/test/relayRetryLeg.test.ts:73-78`; the rung's if-chain compiles over the
  widened union.
- A3/B1 (Task 5 transitions): conceded fixed. Every alias and value in the
  seven transitions at plan:548-589 is used exactly as listed.
