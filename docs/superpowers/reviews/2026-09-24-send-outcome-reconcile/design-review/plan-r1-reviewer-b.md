# Plan review r1 - reviewer B (adversarial)

Plan: `docs/superpowers/plans/2026-09-26-send-outcome-reconcile.md` (HEAD df0b5353).
Spec: `docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md` rev 9.
Method: every claim below was checked against the repo at df0b5353 (file:line
cited); twilio-node 6.0.2 was read in the main checkout's `node_modules/twilio`.
Anything not verified is marked UNVERIFIED. Plan line numbers are "plan:NNN".

Question asked: if a builder with no context executes this plan literally, do
they produce the spec? No. One quoted repo implementation fails on its first
integration run, one spec rule is built by no task and strands recipients when
it matters, several tasks cannot pass their own gates in the stated order, and
the "slices are stoppable between" claim is false at every slice boundary.

---

## 1. [BLOCKING] Task 5 `transition()` sends unused ExpressionAttributeNames - every record transition is a ValidationException

What is wrong: `transition()` defaults `names` to the full nine-entry map `N`
(plan:1091, plan:1188) and every transition calls it without a names argument
(plan:1201-1228). Each transition uses only a subset: `recordCheck` uses
`#ck #st #at`; `markRedriven` uses `#st #rc #at`; `finishAttempt` without a sid
or cause uses `#st #oc #no #at`; `closeRedriven` uses `#st #oc` (+`#ca`).
DynamoDB (and DynamoDB Local) rejects any request whose
ExpressionAttributeNames contains a key the expressions do not reference
("Value provided in ExpressionAttributeNames unused in expressions"). So
finishAttempt, handToReconcile, takeOver, recordCheck, markRedriven,
closeFromReconcile and closeRedriven all throw on every call. `writeClaim`
happens to reference all nine names and survives, which makes the claim tests
pass and hides the fault behind the first transition assertion.

Same trap, second place: Task 6 describes `closeRelayRecipientIfUnsent` as two
UpdateCommands sharing one name list "`#dr` ... `#mk` ... `#st` ... `#ec` ...
`#sid`" (plan:1373); the second statement references only `#dr`/`#mk`, so a
builder who reuses the listed names object gets the same ValidationException.

Evidence: plan:1091, 1188-1196, 1201-1228, 1373. The existing repo builds a
names map per statement for exactly this reason (e.g.
`app/src/repos/messagesRepo.ts:3336-3345`, `:3502-3507` then conditional adds).

Implies: Task 5 Step 3 cannot reach PASS as written; the harness parity test
(Task 5 Step 4) cannot agree with a real repo that throws. Build names per
transition.

## 2. [HIGH] Task 3's `ProviderSendFailedError` hides the provider code and status - broadcast arms regress from Task 3 until Task 7 and every caller's error logs lose the code

What is wrong: spec D3 says `ProviderSendFailedError` "exposes the provider's
code and status (the existing arms read them through `errorCodeOf`)". The
plan's class (plan:603-618, shared block plan:99-102) carries them only under
`.classification`. `broadcastFanOut.ts` reads `errorCodeOf(err)`
(`app/src/jobs/broadcastFanOut.ts:561`, helper `:176-185`), which reads
`err.code` / `err.status` - both undefined on the wrapper. From Task 3 on, the
30007 arm (`:562`), the 30005/30006 arm (`:573`) and the 429/30022 deferral
(`:602`) never match; every provider error falls to `throw err` (`:620`) - the
anchor bug, now also for rate limits that used to defer.

`app/test/broadcastFanOut.test.ts` drives the REAL `sendMessage` wrapper with
errors injected below it (`:811-813` 30007, `:831-833` 30005, `alwaysRateLimits`
`:183-188`, `:614`), so those tests go red at Task 3. Task 3 Step 4 runs only
`test/sendMessage.test.ts` and typecheck (plan:718-719), so it commits red.
Separately, `summarizeError` (`app/src/lib/errors.ts:68-98`) reads `code` and
`status` off the thrown error for every log line; the wrapper erases both for
every sendMessage caller (retrySend, tour reminders, nudges, missed-call text,
the staff route's 500 path) permanently, not just until Task 7.

Implies: expose `code` and `status` on the wrapper (spec D3), and add
`test/broadcastFanOut.test.ts` to Task 3's run list.

## 3. [HIGH] D13a "a re-drive that comes back unknown closes unresolved with no second reconcile" is built by no task - the plan strands that recipient forever

What is wrong: spec D13a: "a re-drive attempt whose outcome is `unknown` again
goes to `done` / `unresolved` directly, with no second reconcile, so a
`never_sent` verdict with `redriveCount` already 1 cannot arise." No send-site
task implements it: Task 7's `unknown` arm always does
`handToReconcile` + enqueue (plan:1481-1483); Task 8's unit always returns
`handed_to_reconcile` (plan:1647); `redriveCount` appears nowhere in Tasks 7-9
(grep of the plan: only the type, the repo and Task 5's test). The second chain
then runs, reaches `never_sent`, and Task 10's broadcast handler does
"`markRedriven` (false -> a duplicate: return)" (plan:1839); the relay path is
the same (plan:1841). Result: record `reconciling` forever, slot `queued`
forever, and under the new D16a finalize (plan:1495, defers while any slot is
`queued`) the broadcast never leaves `sending`. The D16 ERROR cause "second
unknown after a re-drive" is never logged. On the relay path the extra chain
also spends hops 9-11 and may hit `MAX_HOP_COUNT` (`app/src/jobs/jobs.ts:167`).

The self-review maps Sec 8 intention 10 to T10 (plan:2258); Task 10's 18 cases
(plan:1850-1868) contain no such case.

Implies: the send sites (Tasks 7, 8, and the rung in 9) must branch on the
claimed record's `redriveCount >= 1` for an `unknown` outcome, closing
`done`/`unresolved` + `send_unconfirmed`; and a test must pin it.

## 4. [HIGH] The sendOutcome <-> messaging import cycle is not "safe": messaging.ts evaluates a sendOutcome const at module init

What is wrong: Task 1 makes `app/src/lib/sendOutcome.ts` import
`SmsSendingDisabledError` from `../adapters/messaging.js` (plan:276). Task 4
adds `export const TWILIO_REQUEST_TIMEOUT_MS = SEND_CLAIM_TTL_MS;` to
messaging.ts, importing from sendOutcome.ts (plan:824-831). The plan argues the
cycle is safe because "sendOutcome.ts uses the class only inside a function".
The hazard is on the other side: when sendOutcome.ts is the FIRST module
loaded, Node evaluates messaging.ts first, and its top-level
`TWILIO_REQUEST_TIMEOUT_MS = SEND_CLAIM_TTL_MS` reads an uninitialized const
(TDZ ReferenceError under Node ESM; under vitest's SSR transform either the
same error or a silent `undefined` - UNVERIFIED which). `app/test/sendOutcome.test.ts`
(Task 1) imports sendOutcome.js first, so it can break at Task 4, and Task 4
Step 3 does not rerun it. Any production module that imports sendOutcome before
anything that pulls messaging.ts is exposed the same way; whether one exists
depends on import order the plan does not control (UNVERIFIED).

The fix is offered as optional ("To be strict, move ... to messagingErrors.ts"),
yet Task 4's commit stages `app/src/adapters/messagingErrors.ts`
unconditionally (plan:930): a builder who skipped the option fails `git add`.

Second consequence: Task 13's mirror test imports
`app/src/lib/sendOutcome.js` from the dashboard (plan:2111). Without the split,
that pulls messaging.ts (twilio, `node:crypto`, `node:stream`, app config, pino)
into the dashboard's vitest run and its `tsc -p tsconfig.json` (lib DOM,
`types` restricted to vite/vitest/jest-dom - `dashboard/tsconfig.json`). The one
cross-workspace precedent imports a zero-import leaf
(`app/src/lib/retrySendWindow.ts`, no imports).

Implies: make the leaf-errors split mandatory in Task 1 (sendOutcome.ts must
stay dependency-free), and say why.

## 5. [HIGH] Task 8 cannot pass its own typecheck: the new required unit args break relayRetryLeg.ts until Task 9

What is wrong: Task 8 gives `sendOneRelayLeg` required args `sendAttempts:
SendAttemptsRepo` and `owner: SendAttemptOwner` (plan:1622). Its other caller is
`app/src/jobs/relayRetryLeg.ts:626-654`, which Task 8 does not touch (Task 8
Files, plan:1615). Task 8 Step 3 requires `npm run typecheck -> 0`
(plan:1679) - impossible. At runtime between the two tasks, the rung passes no
repo: `app/test/relayRetryLeg.test.ts:73-78` forwards to the real unit, and
`app/test/relayRetryClaim.webhook.test.ts` exercises it too.

Implies: either Task 8 edits the rung's call site (and owns the owner build) or
the args are optional with a stated default; the plan must pick.

## 6. [HIGH] "Slices are stoppable between" (plan:53) is false at every boundary

- After Slice A: finding 2 - broadcast 30007/30005/429 arms stop matching and
  every provider error throws out of the loop.
- After Slice B: the sites enqueue `send.reconcile`, but its handler is
  registered only in Task 10. `validateEnvelope` throws
  `MalformedJobEnvelopeError` for an unregistered name
  (`app/src/jobs/jobs.ts:257-261`); the SQS consumer DELETES such a message as
  poison (`app/src/adapters/sqsJobConsumer.ts:160-171`). Every `unknown`
  recipient is left `reconciling`/`queued` permanently and the broadcast never
  finalizes (D16a defers on a queued slot) - worse than today for that
  recipient.
- Task 7 itself depends on Task 10: its test "finalizes when the verdict lands"
  runs "Task 10's handler" (plan:1587), and Task 7 Step 3 expects the whole
  file to PASS (plan:1601). Task 7 also creates the stub `sendReconcile.ts`
  (plan:1453) but its behavior block uses an undefined `delay0` - the constant
  from Task 1 or the lane-overridable `reconcileCheckDelaysMs()` from Task 10
  (plan:1782). With the constant, the lane override never shortens check 1.
- After Slice C without Slice E: `send_unconfirmed` is not in
  `INTERNAL_CODE_REASONS` (`dashboard/src/routes/contact/deliveryStatus.ts:927-958`),
  so every surface renders "Delivery failed (error send_unconfirmed)"
  (`:1040-1042`), failure-toned, and the broadcast row offers "open
  conversation to retry" (`dashboard/src/routes/broadcasts/BroadcastResults.tsx:48`,
  `:63-67`) - the manual double-send D20 exists to prevent.

Implies: either delete the stoppability claim and state the minimum shippable
cut (A+B+C+E together), or reorder so the registered job and the dashboard
copy land before the sites start producing the new states.

## 7. [HIGH] A pre-claim FAILURE (not a decline) in the recipient unit is unhandled or strands the broadcast

What is wrong: spec D7a: "Nothing in any phase throws out of the loop." Its
PREPARE row names the contact and conversation reads, the relay suppression
check and the claim itself. Task 7's pseudo-code places those reads before the
claim, with no try shown around them, and its only catch-all is "any other
error ... -> ERROR with owner+recipient; continue" (plan:1485). If that
catch-all covers a failed `resolveContact` / `createOrGetByParticipantPhone`
(`app/src/jobs/broadcastFanOut.ts:379`, `:451`) or a failed `claim()`, the
recipient is left `queued`, outside `transientRemaining`, with no record. The
rebuilt finalize then defers for ever (plan:1495, "any slot status is `queued`
-> return"). The same DynamoDB blip that today strands the pass by throwing
(the anchor issue) now strands it silently. Task 8 states no loop-level catch
at all (plan:1628-1660): a throw from `isMemberSuppressed`
(`app/src/jobs/relayFanOut.ts:1351`), from `claim()`, or from a failure-arm
write such as `persistRelayRecipientResult` still leaves `sendOneRelayLeg` and
the fan-out loop under the marker - the anchor bug, unchanged on relay.

Implies: the plan must state what a pre-claim failure does (the natural answer
is D6: defer as `retryable`, no record) and must put a per-recipient catch
around the whole relay unit call in the loop, matching Task 7.

## 8. [HIGH] 14 test files register the adopted handlers; the plan wires the new repo into 3

What is wrong: Tasks 7-9 add a lazily built `sendAttemptsRepo`, defaulting to
`createSendAttemptsRepo()` - a real DynamoDB client (plan:1498, 1624, 1695).
Only `broadcastFanOut.test.ts`, `relayFanOut.test.ts` and
`relayRetryLeg.test.ts` are updated to inject `world.sendAttemptsRepo`. These
also register a fan-out, broadcast or rung handler over a fake world without
the repo: `broadcastApi.test.ts:93`, `relayWebhook.test.ts:91/349/682`,
`devRelayReplay.test.ts`, `inboundMessagePush.test.ts`, `mmsMedia.test.ts`,
`placementsApi.test.ts`, `placementsRelay.test.ts`, `relayApi.test.ts`,
`relayOwner.integration.test.ts`, `relayQueuedMessages.test.ts`,
`relayRetryClaim.webhook.test.ts`, `rosterActionsPoll.test.ts`,
`toursApi.test.ts` (grep of `registerBroadcastSendJobHandler|registerRelayFanOutJobHandler|registerRelayRetryLegJobHandler|registerAllJobHandlers`).
Every one that reaches a send now claims against a real table that its fake
world never created. (UNVERIFIED which files reach a send rather than only
`relay.intro`.) Each task's single-file PASS hides this until Task 17's
`npm test`.

Implies: enumerate the files and give each an injected repo, or give the
fake-world helpers a single registration path that injects it.

## 9. [MEDIUM] The enqueue_failed close after `never_sent` cannot be written with the Task 5 API

What is wrong: spec D11 says `never_sent` moves the record to `redriven`
BEFORE enqueuing the re-drive; the plan agrees (plan:1839, 1841). When that
enqueue throws, D13a requires `done` / `enqueue_failed` (Task 10 case 17,
plan:1867). But the record is now `redriven`: `closeFromReconcile` is
conditioned on `#st = :reconciling` (plan:1223), and `closeRedriven`'s outcome
type is `'refused' | 'redrive_refused'` (plan:166). No method can write it. The
plan also never says the broadcast path calls `finalize` after this close, so
if this was the last open slot the broadcast stays `sending`.

Implies: widen `closeRedriven`, or order the enqueue before `markRedriven`
with a stated reason; say finalize is called.

## 10. [MEDIUM] Recipient phones reach logs and job payloads through `owner`

What is wrong: `SendAttemptOwner` carries the raw recipient key
(`contactKey` / `memberKey`), which is `phone#<E164>` for a contact-less
broadcast recipient or relay member (`app/src/jobs/broadcastFanOut.ts:692-699`;
`relayMemberKey`). Task 10 logs `found INFO { owner, sid, repair }` and
`unresolved ERROR { owner, recipientKey (log-safe), cause }` (plan:1846); the
second makes a log-safe key pointless beside a raw one. Spec D18: "The lookup
never logs a body or a phone." The relay code has deliberate discipline here
(`logSafeMemberKey`, `logSafeStoredMemberKey` at
`app/src/jobs/relayRetryLeg.ts:272-274`). The payload (plan:175-180) also
carries the raw key (D12: "Never a body or a recipient phone"); relay
continuation payloads already carry phone keys today, so the payload half is
pre-existing practice, but the log half is new.

Implies: log a hashed or log-safe owner (the record key is already hashed via
`hashRecipientKey`); state whether the payload rule is waived for the relay
precedent.

## 11. [MEDIUM] D13/D17's page-size assertion and UNVERIFIED record are not built

What is wrong: spec D13 says "the driver asserts the size it asked for is the
size it got", and D17 says list order and page size are "recorded by the plan as
UNVERIFIED against real Twilio until the first hosted-dev run". Task 4's
`listMessages` (plan:849-864) asserts nothing. The hook exists: twilio-node's
`Page._payload.page_size` (`node_modules/twilio/lib/base/Page.d.ts`,
`_payload: TPayload` with `page_size: number`). The plan never uses the word
UNVERIFIED. The port also drops D17's `createdAfter` argument; filtering moves
to the job (plan:815-818, 1815) without saying it deviates.

Implies: add the assertion, with a test against a page that returns fewer
than asked, and record the two UNVERIFIED items where Sec 10's owed check
will read them.

## 12. [MEDIUM] The relay opt-out arm is not D8-gated

What is wrong: spec D8 names "the relay opt-out arm (which write the slot
before that job's own claim)" among the other-writer closes that must read the
record and proceed only when it is absent or `done`/`retryable`. Task 8 leaves
it "unchanged; PRE-CLAIM" for non-re-drive passes (plan:1630). A duplicate or
overlapping pass can then write `failed`/`contact_opted_out` over a slot whose
attempt is being reconciled. On a versioned row `applyRecipientSendResult`
preserves the first terminal code
(`app/src/repos/messagesRepo.ts:3496-3498`, `:3556-3559`), so the adoption can
never correct it.

## 13. [MEDIUM] The test sketches do not match the repo's seams: two builders will write different tests, and some are red for the wrong reason

- Task 1 (plan:367): `capture.lines` holds parsed objects
  (`app/test/helpers/logCapture.ts:6-11`); `l.includes(...)` neither typechecks
  (`app/tsconfig.test.json` covers tests) nor runs.
- Task 3 (plan:532-565): `LIVE` does not exist in `app/test/sendMessage.test.ts`
  (grep); `Fakes` has no `env` (`:41-55`); `f.sent[0]!.sid` - `sent` is
  `SendMessageParams[]` (no sid); `capture.atLevel('error')` takes a number
  (`logCapture.ts:11`); the fake adapter returns `status: 'queued'`
  (`sendMessage.test.ts:338-340`), so `status toBe('sent')` fails against a
  correct implementation.
- Task 7 (plan:1532-1563): `logger.capture` does not exist (the file's `logger`
  is a pino Logger; `capturingLogger()` returns `{capture, logger}`,
  `app/test/broadcastFanOut.test.ts:165-168`); `world.sent[0]!.sid` again; the
  manual-mode test mutates a conversation that `createOrGetByParticipantPhone`
  only creates during the pass. More important: `testConfig` sets no
  `BUSINESS_PHONE_NUMBER` (`:45-53`; `app/src/lib/config.ts:1168-1169` leaves it
  undefined), so every claim has `sender` undefined and every reconcile in
  these unit tests ends `unresolved` / `no_sender` (plan:1809). "finalizes when
  the verdict lands ... expect status 'sent'" (plan:1587) cannot pass. The
  research warned about this (plan-send-sites-findings C4); the plan does not
  carry it.
- Task 4 (plan:914-919): the harness adapter records only `prepared.params`
  (`app/test/helpers/twilioWebhookHarness.ts:3776`); there is no "recorded
  providerTs" or sid for its `listMessages` to answer from.

## 14. [MEDIUM] The e2e sketches (Task 12) are wrong against the repo

- `createGroupOpen(page, members)` returns `{ conversationId, status,
  pool_number }` (`e2e/fixtures/relayConnect.ts:162-186`); the sketch calls
  `createGroupOpen(request, { members })` and reads `group.members[1].number`,
  `.label` and `group.poolNumber`.
- `createTenantWithConsent`, `createAndSendShare` and `devLogin` exist nowhere in
  `e2e/` (grep); the plan calls them "existing helpers". `reseedLean` is
  file-local in two specs. Writing share-creation-and-send over the API is
  real work the plan does not scope.
- The relay per-recipient list renders only when the bubble is revealed
  (`dashboard/src/routes/contact/Timeline.tsx:1323-1324`); the sketch never
  clicks.
- `getOutboundTo` counts every outbound to the party
  (`e2e/fixtures/fakeTwilio.ts:201-212`). The group's relay intro to that
  member makes `toHaveLength(1)` fail, and arming `fail-next-send` right after
  `createGroupOpen` can be consumed by the intro instead of the relay leg
  (an unadopted Stage 2 send site).
- 21211 is not in `ERROR_CODE_REASONS`
  (`dashboard/src/routes/contact/deliveryStatus.ts:777-785`), so it renders
  "Delivery failed (error 21211)", not "Number is invalid (error 21211)".
- The broadcast badge joins label and reason with U+2014
  (`dashboard/src/routes/broadcasts/DeliveryBadge.tsx`, the `' - '` span is an
  em dash), while plan:1978 and plan:2228 quote an ASCII hyphen.

## 15. [MEDIUM] Unenumerated readers that go red: AppendResult, the job-name registry, the chip order

- `AppendResult` gains a required `conversationId` (plan:1306). The email-pointer
  dedupe return at `app/src/repos/messagesRepo.ts:2598` is not named (the plan
  names only `:2543-2558`). Exact-shape assertions break:
  `app/test/messaging.integration.test.ts:137,141,152,155` and
  `app/test/groupSendRepo.integration.test.ts:240`. Fakes returning the old
  shape exist in `groupSend.test.ts:257`, `inboundEmail.test.ts:232-234`,
  `emailEvents.test.ts:389` and `sendEmailMessage.test.ts:79` (whether each is
  typed against `AppendResult` is UNVERIFIED).
- `app/test/registerHandlers.test.ts:19-35` pins the COMPLETE registered job
  set; Task 10 registers `send.reconcile` without naming this test.
- `dashboard/src/routes/broadcasts/StatChips.test.tsx:75-86` pins the
  seven-chip order. Task 14 adds a new order test but does not update the old
  one.

## 16. [MEDIUM] Sec 8 intentions the self-review maps to a task, but no task tests

- 8.4 "a prepare-phase failure defers as `retryable` and releases the record":
  no case in Task 7 (no `SendNotAttemptedError` test) or Task 8 (no
  presign/aggregation-throw test).
- 8.12 "RSW's window close refuses a recipient with a FOREIGN open attempt":
  Task 9 tests the claim path (plan:1723), not the pre-claim window gate.
- 8.6: Task 7's cap-close sketch covers only `reconciling` and absent
  (plan:1573-1575). A fresh `attempting` record, a `redriven` record and the
  stale takeover at the cap are untested.
- 8.7 "three `retryable` do not brake" and 8.11 "verdict-then-pass ordering
  finalizes once" have no case.
- 8.3 for the rung is proven only through `legSend.override` (plan:1701),
  which bypasses the unit, so "record `reconciling`, slot untouched" is never
  observed for the rung.

## 17. [MEDIUM] Task 10's lookup control flow contradicts itself for the broadcast owner

What is wrong: the `lookup` pseudo-code returns `found` on the first matching
candidate once a claim that is a no-op for broadcast succeeds (plan:1823-1825).
The broadcast owner note then says `adoptBroadcastRecipient` must run INSIDE
the candidate loop so that `'other_owner'` continues to the next candidate
(plan:1838). Both cannot be followed. Spec D11/D13 require "takes the next
candidate" when the append dedupes onto another owner's row. Two builders will
build two different loops. One of them adopts nothing when the oldest matching
candidate belongs to a sibling share.

## 18. [MEDIUM] Relay `mediaCount` is computed before the presign, so it is always 0

What is wrong: the relay unit computes the facts from `legMediaUrls?.length ?? 0`
before the claim, and the claim precedes the presign (plan:1632-1639; the
presign is `app/src/jobs/relayFanOut.ts:1406-1413`). `legMediaUrls` does not
exist yet, so every relay record says 0 media. D8a requires "the media count of
THIS attempt". The D13 same-fingerprint rule and the short-body media match then
read a wrong fact. Use `mediaStore !== undefined ? sourceMedia.length : 0`.

## 19. [LOW] D15 `carrierSentAt` rule contradicts Task 10 case 2, and broadcast adoption omits the inbox touch

`statusFor` sets `carrierSentAt` only "when the provider status is `sent`"
(plan:1844). Case 2 expects a `delivered` adoption WITH `carrierSentAt`
(plan:1852). Spec D15 says "take the provider's `date_sent` when it has one".
D15 also lists the status-preserving inbox touch among the writes the success
path makes; `adoptBroadcastRecipient`'s write list (plan:1763) omits it.

## 20. [LOW] Check-delay arithmetic is ambiguous

"delay = max(0, attemptedAt + cumulative - now)" (plan:1799) reads as a sum
(5+30+240 s). The spec says checks land at about 5 s, 30 s and 4 min after the
attempt, and the e2e comment (plan:2008, "check 2 (8 s)") assumes offsets.
Name the rule: offset from the attempt.

## 21. [LOW] The same-fingerprint sibling rule is wider than the spec

The plan counts a sibling whose outcome is `sent` (plan:1830). Spec D13 counts
only one that is "open or was adopted". A `sent` sibling holds its own SID, so
its message is already excluded as held. Counting it turns a true
`never_sent` into `unresolved` whenever an identical share reached the same
tenant inside the window. That is the safe direction, but it is not what the
spec says, and no test covers it.

## 22. [LOW] Registry drift and a partial residue fix

The spec's header table says this branch builds piece 1 of
`accepted-send-lost-when-append-fails` and "substantially" builds
`exactly-once-send-intent`. Task 15 updates neither file. Separately, Task 8
closes three re-drive early returns (plan:1660), but Sec 9 and Task 15 file
"a re-drive continuation's early returns" as residue. `relayFanOut.ts:761-765`
and `:779-783` stay unclosed, so the issue text will be half true.

## 23. [LOW] The classifier treats twilio-node's default code 0 as a code

`TwilioServiceException` defaults `code` to 0 (plan-data-layer-findings M4).
`codeOf` returns `'0'` (plan:313), so a 4xx writes slot code `'0'`, which
renders "Delivery failed (error 0)".

## 24. [LOW] Takeover edge cases in the loops

A takeover returns `handed_to_reconcile` (plan:1636), so it counts toward the
D9 unknown streak even though it is not an unknown outcome of this pass. A
`takeOver()` that returns false (someone else took over first) is not handled
at plan:1468 or plan:1636; the result is a duplicate chain, which converges but
costs hops. The own-attempt slot writes (`rejected`, `refused`) are not
conditioned on the record's `attemptNo`/`attemptedAt` (spec D8, last
paragraph). So a late 4xx after a takeover writes a terminal slot while the
takeover's reconcile rules `never_sent` and re-drives into a terminal slot,
stranding a `redriven` record.

## 25. [LOW] Legacy relay adoption can regress a raced receipt

Task 10 adopts a relay leg through `persistRelayRecipientResult` (plan:1841).
On a legacy row that is `markRecipient`'s wholesale SET
(`app/src/jobs/relayFanOut.ts:1651-1653`,
`app/src/repos/messagesRepo.ts:3661-3682`), after the pointer is already
claimed. A status callback that lands in between is overwritten. The Task 10
Step 2 "cannot regress" test would fail on a legacy row. Practical exposure is
small (relay sources are versioned since 2026-09-02,
`app/src/routes/webhooks/twilio.ts:904`), but the plan should say
versioned-only or make the legacy write conditional.

## 26. [LOW] Some self-QA steps cannot be performed as written

"Stop the worker between the claim and the send by pausing the process"
(plan:2229) and "kill the fake process for the three checks" (plan:2228) are
not steps a builder can perform reliably on a hermetic lane. Killing the fake
may also take down the lane. Give a seam instead, such as a fake mode that
fails list calls.
