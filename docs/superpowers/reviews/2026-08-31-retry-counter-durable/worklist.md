# Worklist - feat/retry-counter-durable (merged from six research readers)

Tree: W:\tmp\retry-counter-durable @ 5cf1da0b (main@1af02926 merged at 8c8b7100).
Spec: docs/superpowers/specs/2026-08-31-retry-counter-durable-design.md (D1-D23)
Plan: docs/superpowers/plans/2026-09-01-retry-counter-durable.md
Findings (tracked): docs/superpowers/reviews/2026-08-31-retry-counter-durable/research/*.md
Reference (ignored, byte-exact): .superpowers/sdd/research/*-reference.md

Every line number below is from the LIVE tree at 5cf1da0b and was verified by
a reader. Orchestrator RULINGS are marked [RULING]; they resolve spec/plan vs
tree discrepancies and are binding on the implementer. Deviate only by
STOP-and-report.

---

## Global

- Commit discipline (AGENTS.md, verbatim): read bare `git status` before EVERY
  commit and check `.git/MERGE_HEAD`; stage and commit EXPLICIT paths only,
  never `git add -A`; every commit carries
  `Co-Authored-By: <model name> <noreply@anthropic.com>`; new/touched lines are
  ASCII-only (verify with a byte scan of the diff's added lines); never rewrite
  a source file with `Get-Content | -replace | Set-Content` - use the Edit tool.
- Absolute paths in every shell command; `cd W:\tmp\retry-counter-durable`
  explicitly every time (cwd resets between calls).
- Fast gates after every commit: `npm run typecheck` (from the worktree root)
  and the touched vitest files (`cd W:\tmp\retry-counter-durable\app; npx vitest run <file>...`).
  DynamoDB Local is up on :8000 (container hc-dynamodb-local). Do NOT run the
  full `npm test` / `npm run e2e` - the orchestrator owns those.
- Do NOT touch: routes/webhooks/twilio.ts (entirely), repos/conversationsRepo.ts,
  jobs/tourReminders.ts, routes/contacts.ts, routes/today.ts,
  lib/rosterResolution.ts, services/groupSend.ts (:381, :425).
- The `as unknown as MessagesRepo` casts in emailEvents/rateLimit/
  relayProvisioning/sendEmailMessage tests are NOT implementations - leave them.
- Slice reports: docs/superpowers/reviews/2026-08-31-retry-counter-durable/build/slice-<n>.md,
  committed as their own commit after the code. Findings-kind only (what the
  tree held, what deviated, what was verified) - no code quotation.

---

## S0+S1 - claim primitive (one build step)

Files: app/src/repos/messagesRepo.ts, app/src/repos/broadcastsRepo.ts,
NEW app/src/repos/fanoutClaim.ts, app/test/helpers/twilioWebhookHarness.ts,
app/test/scheduledSendSuppression.test.ts, app/test/sendMessage.test.ts,
app/test/broadcastsRepo.integration.test.ts.

[RULING] Shared result type in NEW `app/src/repos/fanoutClaim.ts` (neither repo
imports the other; a tiny type-only module avoids duplicating the union):
```ts
export type FanoutClaimResult =
  | { outcome: 'claimed'; attempt: number }
  | { outcome: 'capped'; attempt: number }
  | { outcome: 'missing' };
```

Signatures:
- BroadcastsRepo: `claimFanoutPass(broadcastId: string, cap: number): Promise<FanoutClaimResult>`
- MessagesRepo:   `claimFanoutPass(conversationId: string, tsMsgId: string, cap: number): Promise<FanoutClaimResult>`
  (the SOURCE MESSAGE key; the relay caller passes `payload.relayConversationId`
  + `payload.sourceTsMsgId` - there is NO `payload.conversationId`, relay F6)

Attribute: `fanout_attempt?: number` on BroadcastItem (broadcastsRepo.ts,
which already carries `[key: string]: unknown` at :172) and on MessageItem
beside `retry_attempt` at messagesRepo.ts:873.

[RULING] Implementation copies the in-file precedent `messagesRepo.ts:3131-3155`
(conditional ADD on a top-level scalar, `ReturnValues: 'UPDATED_NEW'`, value
read off `Attributes`, `instanceof ConditionalCheckFailedException`,
disambiguation by a `ConsistentRead: true` GetCommand as at :1800-1802) - NOT
the conversationsRepo sites the plan cites (they use ALL_NEW). Alias the
attribute (`'#fa': 'fanout_attempt'`) like every conditional ADD in that file.
Existence predicate is NOT symmetric (repos F5): messages
`attribute_exists(tsMsgId)`; broadcasts `attribute_exists(broadcastId)`.
Condition: `attribute_exists(<key>) AND (attribute_not_exists(#fa) OR #fa < :cap)`.
On ConditionalCheckFailedException: consistent GET; item absent -> `missing`;
present -> `capped` with `attempt: item.fanout_attempt ?? 0`. If UPDATED_NEW
returns no `fanout_attempt`, throw (precedent usersRepo.ts:543-546). Do NOT
reuse `getById` / `getByTsMsgId` - both are eventually consistent.

Fakes (all four must have the property; repos F3):
- twilioWebhookHarness.ts:1054 (messages) and :2663 (broadcasts): MODEL the
  real semantics - find the stored item, `missing` if absent (do NOT throw the
  synthesized ConditionalCheckFailedException the other broadcast methods use),
  `capped` if `(item.fanout_attempt ?? 0) >= cap`, else increment IN PLACE on
  the stored object and return `claimed`. The broadcasts fake's `getById`
  returns a shallow COPY (:2688-2691) - the claim must read/write
  `broadcasts.get(id)` (the map entry), so a test seeding
  `world.broadcasts.get('bcast-1')!.fanout_attempt = 3` is honored. The
  messages fake stores by reference in `world.messages[]` (:208).
- scheduledSendSuppression.test.ts:261 and sendMessage.test.ts:210: may
  `throw new Error('claimFanoutPass not implemented in this fake')`.

Integration tests [RULING repos F2]: EXTEND `app/test/broadcastsRepo.integration.test.ts`
(it already builds BOTH repos and BOTH tables, :54-63) rather than create a
messages suite; widen its header comment (:1-11) and describe title (:47) so the
new cases are on-topic. It mints its own `hc-test-<uuid>-` prefix - do not add
the shared-lane marker. Cases, for BOTH repos:
1. claim on an item with no attribute -> `{claimed, 1}`.
2. seeded at cap-1 -> `claimed` (attempt == cap); then at cap -> `capped`
   with attempt == cap.
3. missing item -> `missing`.
4. N (>= 8) concurrent claims on one fresh item -> the returned attempt numbers
   are all distinct and exactly 1..N (cap >= N).
5. counter survives a slot write (D2, spec 7.1): claim, then
   `setRecipientDelivery` (messages) / `setRecipient` (broadcasts), re-read
   (GetCommand) -> `fanout_attempt` intact. Say IN THE TEST why these two
   writers and not `updateRecipientDeliveryStatus`: the latter writes child
   fields only (messagesRepo.ts:2820-2837) and would be green against a
   slot-resident counter (repos F4).
6. an item written before this branch (no attribute) claims at 1 (D4) - this
   is case 1; name it so the spec 7.8 mapping is explicit.

Gate: `npm run typecheck` green; `npx vitest run test/broadcastsRepo.integration.test.ts test/broadcastFanOut.test.ts test/relayFanOut.test.ts test/scheduledSendSuppression.test.ts test/sendMessage.test.ts` green (the fan-out tests must still pass - nothing calls the claim yet).

---

## S5b - internal codes (BEFORE S2)

File: dashboard/src/routes/contact/deliveryStatus.ts (INTERNAL_CODE_REASONS)
+ its tests; e2e/support/selectors.md:49 (documented row-string contract,
dashboard F5).

INTERNAL_CODE_REASONS is consulted FIRST and early-returns at :633-634, before
the media chain and before the `(error <code>)` template - entries get NO tail
automatically and are immune to `media`/relay scoping. One string per code must
read correctly BOTH as an aggregate summary (rollup, badge) and on a single
recipient's row.

[RULING broadcast #8] `enqueue_failed` also fires from the MAX_HOP_COUNT guard
and the no-adapter guard (jobs.ts:167-171, :119-123), so its copy must NOT
promise a cause. Copy (plain operator prose, ASCII):
- `transient_cap`: "Sending gave up after repeated carrier deferrals"
- `enqueue_failed`: "Sending could not be scheduled"
(Adjust wording to match the neighbouring entries' register; keep the meaning:
retries exhausted vs never scheduled - D10.)

Tests: both codes render as prose with no tail in FOUR positions (dashboard F3):
relay rollup (deliveryStatus.ts:416), accessible-name recital
(Timeline.tsx:582), per-recipient row (Timeline.tsx:1045), broadcast badge
(DeliveryBadge.tsx:31). Mirror the existing tests in deliveryStatus.test.ts /
Timeline.test.tsx / DeliveryBadge test (see dashboard-e2e-reference.md).

---

## S2 - broadcastFanOut

File: app/src/jobs/broadcastFanOut.ts; test app/test/broadcastFanOut.test.ts.
Anchors EXACT: payload parse :109-110 (attempt defaults to 1, so `?? 1` at :479
is dead), lazy repo :189/:198, marker :228 return, not-found :239 return,
recipient derivation :250-256, send loop :263-461, unknown-error throw :459
with false comment :456-458, continuation :476-510 (cap branch :480-495,
enqueue :496-507, `return` :509), trailing finalize :512-513. Local
`isTerminal` at :123. MAX_BROADCAST_ATTEMPTS = 3; broadcastBackoffMs(n) =
5000 * 2^(n-1) and the continuation passes nextAttempt -> 10s then 20s.

Claim (plan 2a) immediately after :256, before :263, guarded by
`pending = keys.filter((k) => !isTerminal(broadcast.recipients?.[k]?.status))`.
`let claim: FanoutClaimResult | undefined` in handler scope. `missing` ->
log.warn + return. `capped` -> closeBroadcast(pending, 'transient_cap'); return.

closeBroadcast INSIDE the handler closure after `const repo = broadcasts` pin
(plan 2c). Body lifted from :481-495: per key not already terminal ->
recordRecipient({status:'failed', errorCode: code}), bumpStats({failed:1,
queued:-1}), emitBroadcastProgress; then the operator log.error parameterised
by reason; then finalize once.

Continuation (plan 2b): delete `if (nextAttempt > MAX_BROADCAST_ATTEMPTS)`;
close A = `if (claim.attempt >= MAX_BROADCAST_ATTEMPTS)` ->
closeBroadcast(transientRemaining, 'transient_cap'); return. Wrap enqueue in
try/catch -> close C closeBroadcast(transientRemaining, 'enqueue_failed');
return. KEEP the `return` at :509. Backoff stays broadcastBackoffMs(nextAttempt).

[RULING broadcast #1] Assert backoff as the adapter-observed integer
`delaySeconds` 10 then 20 (runAt NEVER reaches the adapter - jobs.ts:112-124
converts it). This is the literal-value assertion the plan wants; do not
re-derive from broadcastBackoffMs. Model: the existing assertion at :525-531.
[RULING broadcast #2] The throwing seam is DELAY-SELECTIVE:
```ts
configureOutboundQueue({ async enqueue(env, opts) {
  if ((opts?.delaySeconds ?? 0) > 0) throw new Error('queue down');
  return outbound.enqueue(env, opts);
}});
```
(a globally throwing adapter kills the test's own enqueueImmediate entry).
[RULING broadcast #3] `deliverDelayed` drains TRANSITIVELY and empties
`delayed[]` (scheduler.ts:223-229). Drive close A one pass at a time: snapshot
`outbound.delayed.map(d => d.delaySeconds)` before each drain, or shift one
item and dispatch it yourself. No test in this file has driven a second pass.
[RULING broadcast #4] Count sends with the throwing stub's own vi.fn counter -
`world.sent` is empty when the messaging adapter is stubbed (:388-390).
[RULING broadcast #5] The RED-ON-MAIN close-C test sits on PASS 1
(enqueueImmediate + settle): runDeferred catches the throw (scheduler.ts:198-203),
deliverDelayed does not. Prove it red at the merge base: `git stash` is not
available mid-slice, so prove it by temporarily reverting ONLY the close-C
try/catch (comment it out), run, observe red, restore - and record that in the
slice report.

Tests (plan 2d, corrected):
- REWRITE :383-401 ("429 capped at MAX_BROADCAST_ATTEMPTS") as close A driven
  for real: three passes each deferring -> keep all four existing assertions
  (failed, transient_cap, stats.failed === 1, status failed) AND add: no fourth
  enqueue (delayed snapshot empty after pass 3), stats.queued === 0, send count
  === 3 (vi.fn), delaySeconds observed [10, 20], one log.error.
- Close B: seed `world.broadcasts.get('bcast-1')!.fanout_attempt = 3`, dispatch
  one first-pass envelope -> same terminal shape, ZERO sends.
- Close C (RED-ON-MAIN): delay-selective throwing adapter, pass 1 defers ->
  broadcast finalized failed, recipient failed/enqueue_failed, stats.queued 0,
  status not `sending`.
- Extend :354-381 ("leaves the broadcast sending") - it already asserts the
  pass-1 continuation; add that `fanout_attempt === 1` on the stored item.
- Same-jobId redelivery claims nothing (fanout_attempt unchanged) and sends
  nothing; an all-terminal pass claims nothing (fanout_attempt absent) and
  falls through to finalize.
"Stats reconciled" (repos F7) = the PERSISTED counters bumpStats moves
(`bcast.stats.failed`, `bcast.stats.queued`), plus every slot terminal.
D8 carve-out (broadcast #7): the D12 unknown-error throw at :459 is a fourth
exit and is NOT closed here - say so in the slice report.

---

## S3 - relayFanOut

File: app/src/jobs/relayFanOut.ts; test app/test/relayFanOut.test.ts.
The handler :697-967 is BYTE-IDENTICAL to main@5ce9912f at +369 (relay F1);
tour reminders never enter it (F2). Anchors: payload parse :131-165 (attempt
defaults to 1, F4), `let messages` :645 / `??=` :701, six early returns :717,
:729, :742 (AF-2 status gate), :747, :758, :792 - all above the derivation;
recipient derivation :803-807 (`recipients` is ConversationParticipant[]);
in-loop terminal skip :813-817 keyed by `relayMemberKey(m)`; opt-out skip :824;
unknown-error throw :904 with false comment :901-903; continuation :934-966
(`if` :938, nextAttempt :939, cap branch :940-951, enqueue :952-965, backoff
arg :964 = `payload.attempt ?? 1`). Local `isTerminal` :168. `markRecipient`
:1124 already passes `payload.relayConversationId`. MAX_FANOUT_ATTEMPTS = 3;
fanOutBackoffMs(CURRENT pass) -> 5s then 10s; the 20s rung is unreachable.

Claim after :807, before the loop, guarded by (relay F7):
`const pending = recipients.filter((m) => !isTerminal(sourceMessage.delivery_recipients?.[relayMemberKey(m)]?.status))`
Key: `messages.claimFanoutPass(payload.relayConversationId, payload.sourceTsMsgId, MAX_FANOUT_ATTEMPTS)`.
closeRelay(memberKeys: string[], code) inside the handler after `const repo = messages`
pin: per non-terminal key markRecipient({status:'failed', errorCode: code}) +
the existing log.error. NO finalize/bumpStats/progress (none exist). Call
sites pass `pending.map(relayMemberKey)` / `transientRemaining` (already keys -
confirm by reading :938).
Continuation: delete the `nextAttempt > MAX` test; close A on
`claim.attempt >= MAX_FANOUT_ATTEMPTS`; try/catch enqueue -> close C
`enqueue_failed`; backoff `fanOutBackoffMs(claim.attempt)` (same value as today).
[RULING relay F5] Comment-only: correct the "5/10/20s" claims at :935 (inside
the edited block) and the docblock at :77 to state 5s then 10s, third rung
unreachable because the cap closes on pass 3. No timing change (D7, D11).
[RULING relay F10] The inbound fixture MUST seed `delivery_recipients: {}`
(production does at twilio.ts:598; the harness fake tolerates absence, the real
repo would not). Add it to `seedSource` or a variant for the close-B case.

Tests (NEW - there is no relay cap test today, F3; :481-506 is the only
continuation test and it survives):
- close A driven for real over three passes on a team-send source: every
  pending slot failed/transient_cap, send count 3 (vi.fn), delaySeconds
  observed [5, 10], no fourth enqueue, one log.error.
- close B on a relay INBOUND source whose `delivery_recipients` is `{}`
  (spec 7.4): seed `fanout_attempt = 3` on the world.messages item, dispatch a
  first-pass envelope (no recipientKeys) -> every roster-derived member slot
  failed/transient_cap, zero sends.
- close C (RED-ON-MAIN) on pass 1 with the delay-selective throwing adapter.
- same-jobId redelivery claims nothing; all-terminal pass claims nothing.
- extend :481-506: `fanout_attempt === 1` after pass 1; delaySeconds 5.
Seam: configureOutboundQueue (already used at :118, :925, :1473); never
vi.mock('./jobs.js').

---

## S4 - groupRail ladder

Files: app/src/services/groupRail.ts, app/src/jobs/groupRail.ts:59,
app/scripts/rail-verify.ts:198-201, app/src/lib/import/convertGroups.ts:429-432;
tests app/test/groupRailService.test.ts (+ groupRailJob.test.ts:40 and
importConvertGroups.test.ts:158 fakes must capture the WHOLE request, groupRail #8).
try/catch map: try#1 :400-473 (adopt :452-454 sets wasAdopted; create :456-463
sets participants at :462); bare :474-490; try#2 :491-501 (the `??=` read; its
catch :493-501 is the pattern to mirror); BARE :502-521 (participantMap :506,
missing :507 - LADDER POINT 1 LIVES HERE IN NO TRY); try#3 :522-549 (repair
:523, post-repair read :538 = LADDER POINT 2, recompute :539-540); bare
:550-595 (final mismatch recordRailFailure :558; author block :578-584); try#4
:596-616; bare :617-646 (setTwilioConversation :619-625 stores `participantMap`).
Binding drop happens in buildParticipantMap groupRail.ts:227 (empty address),
not in the adapter.

[RULING groupRail #1] Ladder point 1 gets its OWN try/catch whose catch mirrors
:493-501 exactly (summary reason, `group_rail_ensure_failed` warn,
recordRailFailure, return failed). A throw must never escape and leak the
rail_creating claim (D16's own criterion). Never swallow and continue with the
stale list (plan 4d, D15).
[RULING groupRail #3] The ladder reassigns `participants`, `participantMap`
AND `missing` together at both points.
[RULING groupRail #4] Keep the assignments in ensureGroupRail's own scope: the
ladder helper RETURNS the new participant list; the handler assigns. A closure
that assigns `participants` drops TS narrowing at :578 and fails gate 1.
Deps: `sleep?: (ms: number) => Promise<void>` on GroupRailServiceDeps,
default real timer (precedent in group-rail-reference.md). Flag:
`awaitBindingPropagation?: boolean` on GroupRailRequest; passed `true` by the
three callers; groupSend untouched. Ladder: up to 2 re-reads at 500ms then
1500ms, stop when `missing` empties, gated on flag AND !wasAdopted at BOTH
points.
[RULING groupRail #2] rail-verify.ts still passes the flag (spec D16 contract)
even though it can only reach the laddered path via delete-and-recreate; the
slice report and the S7 issue update say so.
Tests (plan 4c + groupRail #8): fixture returns SHORT then FULL; headline case
asserts addParticipants NOT called and no recordRailFailure; genuinely unbound
member still repairs; post-repair read ladders; adopt path ladders on neither
read (count fetchParticipants calls, no sleep); flag absent -> no ladder on
either read (assert the flag path, not just wasAdopted); ladder re-read throw
-> rail failure recorded, result failed, no throw escapes; author block:
`staleAuthors` behavior when a re-read reveals a projected participant (the
create-path `authorPresent` cannot change - groupRail #3); the three callers
pass the flag and groupSend's request objects (read-only assertion via a
groupSend test if one exists, else by grep in the slice report).
Cost note (groupRail #7): both points can fire -> up to +4s and 4 reads per
rail; record in slice report, no bound added (spec names the rungs as tunable).

---

## S5a - relay 30003 override

Files: deliveryStatus.ts (presentRelayDelivery :387-416 gains rosterKind from
its caller Timeline.tsx:894; deliveryReason :628-640), Timeline.tsx (:582,
:1045 override when relay; :849 and :1390 unchanged), tests, selectors.md:49.
[RULING dashboard F2] Precedence in the `??` chain: media map FIRST, relay
map SECOND, base last. Add a relay+MMS 30003 case so the interaction is pinned.
The relay entry KEEPS the `(error 30003)` tail and drops only the retry
promise. Do NOT copy the em dash from the 1:1 entry (:ERROR_CODE_REASONS 30003)
into any new line.
rosterKind's operative default is Timeline.tsx:1519 (dashboard F1);
ConversationDetail/TourConversation/PlacementConversation inherit relay by
omission (intended - they are relay views). Pin group-text THROUGH <Timeline>
with explicit `rosterKind: 'group_text'` (pattern Timeline.test.tsx:1314-1346),
not by rendering MessageBubble.
Tests: relay 30003 at all three relay positions with tail intact and no "will
retry"; group-text pinned explicitly; 1:1 (:849), email (:1390) and badge
unchanged; :849 pinned - a relay bubble whose slot carries 30003 leaves the
message-level chip alone (dashboard F4).

---

## S6 - provider-status sweep (after 2, 3, 4)

Draft enumeration: docs/superpowers/reviews/2026-08-31-retry-counter-durable/research/provider-status-enumeration.md
(52 sites: 16 in-region, 7 fenced twilio.ts, 29 out). Finalize into
provider-status-sweep.md. In-region: the two D12 throws (filed, not fixed);
groupRail isDeadRailState :259-262 with TWO consumers :433 and :484 (groupRail
#9) - disposition decided in S6 with S4 landed. Out-of-region: file ONE issue
covering adapters/messaging.ts:545-547 (mapTwilioStatus default 'queued' - root
of the class), voice.ts:1631-1637, and the fenced twilio.ts inheritors.
Correct the two false comments: broadcastFanOut.ts:456-458 (:457) and
relayFanOut.ts:901-903 (:903) - comment-only.

---

## S7 - e2e + closure

E2E [RULING dashboard F6/F7]: prefer the LEAN lane via `createGroupOpen`
(e2e/fixtures/relayConnect.ts:162-186), SETTLE the create-time intro first
(pattern relay-open-stop.spec.ts:141-145), then arm
`setDeliveryOutcome(request, { partyNumber: <member>, profile: { kind: 'fail', failState: 'undelivered', errorCode: '30003' } })`
(one-shot, keyed on DESTINATION), team-send into the group, then assert at all
three positions: rollup chip, accessible name, and the per-recipient row AFTER
clicking the bubble body to reveal it (Timeline.tsx:1028 `showRecipients && revealed`;
assert `toHaveCount(0)` before the reveal as group-text-per-recipient-delivery.spec.ts:134-138
does). The proving assertion is the NEGATIVE `not.toContainText('will retry')`
at every position plus the presence of `(error 30003)`. Fallback host if the
lean settle proves unreliable: relay-group-view.spec.ts (full profile).
Resolutions: retry-counter-in-envelope (note retrySend.ts:74 needed no change);
rail-binding-propagation-retry PARTIAL naming groupSend :381/:425 + the
rail-verify inertness + adopt (D17) + refusal log noise (D18).
Filings: adopt-path exposure (D17); refusal log noise (D18,
adapters/groupConversations.ts:563-566); closeRelay and the hub row - there is
NO rollup on the relay path, a team-send hub sits at `queued` forever
(relay F9; `ALLOWED_PRIOR.failed` permits a forward transition) and taking it
would reach a FIFTH render position Timeline.tsx:849 (dashboard F3);
twilio.ts:286 still classifies relay 30003 as transient-retrying (dashboard F8,
fenced -> file); the S6 out-of-region issue.
relay-30003-retry-lineage: append the five design facts (spec Sec 8 obl. 5).
_CLUSTERS.md M5 amended. spec D8 precision note: every exit EXCEPT the D12
throw. `npm run issues`.
