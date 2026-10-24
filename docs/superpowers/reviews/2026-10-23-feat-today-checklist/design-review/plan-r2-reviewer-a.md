# Plan review r2 - reviewer A (continued; re-review charge)

Plan: `docs/superpowers/plans/2026-10-24-today-checklist.md` v2 @e04c578f
(diff 718194dc..HEAD read in full). Also read: `plan-adjudications.md`,
`plan-r1-amendments.md`, `plan-r1-reviewer-b.md`. Read-only; no tests run.

Mechanical re-check: the anchor script from round 1 over v2 finds 350
quoted `old:` anchors; the 45 that do not match HEAD are the same
earlier-task chains as in round 1, and every anchor the write-through added
or changed matches the tree (PR84 harness comment block,
`twilioWebhookHarness.ts:5590-5597`; PR81's voice.ts anchor, whose last line
occurs once, `voice.ts:840`; the founderTriage.test.ts anchor, unique at
`founderTriage.test.ts:599-605`). No write-through edit broke a later
anchor (the dropped `isUnitDeleted` alias has no later reader).

PR94 claim verified: api.ts builds its default `createSendMessageService`
with no `adapter` (`app/src/routes/api.ts:694-703`), so the service builds
its own from config (`app/src/services/sendMessage.ts:424`), which is the
console driver under the harness (`twilioWebhookHarness.ts:5631`); the
harness's `api.adapter: world.adapter` (`twilioWebhookHarness.ts:5688`)
reaches the originate route but not the send service. (The harness comment
there, "go through the SAME world adapter as the send service", is itself
false; harmless.) The console driver returns a real `providerTs`
(`app/src/adapters/messaging.ts:1371-1386`), so the persisted-row proof
works.

---

## 1. [HIGH] PR89's new routes.test source check can never go green: the Today copy is entity-encoded

What is wrong. S7.11's test (plan ~22717-22722) adds:
`for (const contract of today.terminal.error) expect(source.includes(contract.name!)).toBe(true)`
over the Today directory's non-test sources. Two of the three error names
are not in any source file as written:
- "We couldn't load your queue": Today.tsx carries it as JSX text with an
  entity, `We couldn&apos;t load your queue. Please try again.` (current tree
  `dashboard/src/routes/today/Today.tsx:285`; S5.6 keeps it, plan ~17681).
- "Some sections can't load right now.": S5.6 writes
  `Some sections can&apos;t load right now.` (plan ~17687).
Only "We couldn't load " is present with a real apostrophe (QuietShares.tsx
`{"We couldn't load quiet shares."}`, plan S5.5; UnavailableSection's
template literal, plan ~17380). The pre-PR89 test never checked the error
group's source, so this is new with the write-through.

Implication. S7.11 Step 3 GREEN fails at this loop. The only fixes are to
edit S5's dashboard source from inside S7 (rewrite the two strings as JS
string literals) or to change the check - and the plan forbids weakening a
test and gives S7 no licence to edit S5's files. The same encoding defeats
Step 4's re-cite grep (`grep -E "...We couldn't load|Some sections can't load"`,
plan ~22790): it cannot find the queue-error or fallback lines, so the
citation ranges it is meant to locate come back incomplete. Fix in the plan:
either S5.6 renders both lines as `{"..."}` string literals (as QuietShares
already does), or the source check also accepts the `&apos;` form.

## 2. [MEDIUM] Rulings that knowingly depart from the approved spec sit under "the spec wins on any doubt"

What is wrong. Plan section 1 is headed "Global constraints (from the spec;
the spec wins on any doubt)" (plan line 72). Round 1 added rulings that
deliberately diverge from the approved spec text, and the spec was not
amended (`git log 718194dc..HEAD -- docs/superpowers/specs/` is empty):
- PR91: W2 also skips a Retry of an `automated: true` row. The spec's W2 row
  (spec line 489) says "as W1, EXCEPT a retry of a share text"; spec 7.5's
  backfill says "(a staff Retry counts)". The adjudication records it as a
  DECISION CHANGED.
- PR93: stamping the `stranded` + `afterSend` arm, called "a deliberate
  widening of spec 7.3 W4" (W4 row: "sent or `sent_unrecorded`").
- PR88: one after-loop event per fan-out pass, called "the reading of" spec
  7.3's "ONE `conversation.updated` ... after its fan-out loop finishes".

Implication. A literal builder who meets the conflict has a written rule
that says the spec wins, so PR91's gate can be dropped as a "doubt". The
pipeline's later spec-conformance review will also report all three as
deviations. PR91 in particular changes a behavior Cameron approved at the
spec gate (W2's exception list) on the planner's say-so. Either amend the
spec (W2 row, 7.5 bullet, W4 row, the 7.3 event sentence) through the
human, or have section 1 say that the named rulings deliberately override
the cited spec lines and list them as items for Cameron at the launch gate.

## 3. [LOW] The S7.12 ContactUpdatedEvent doc comment was not written through for PR81 or PR91

What is wrong. The comment S7.12 writes (plan ~22858-22879) still says "Two
INBOUND paths emit it too ... services/inboundEmail.ts and the masked relay
call paths" and names "the staff Retry of a non-share row". After PR81, the
founder-triage inbound call (`voice.ts` ~834) is a third inbound emitter.
After PR91, an automated row's Retry does not emit. The S2 cross-slice note
that feeds S7 (plan ~3095-3099) has the same omission, and S7.12's commit
message says "the two inbound post-touch emits". The comment also says
these paths emit "because their conversation.updated fires before that
touch", which is wrong for the masked and founder calls: they emit no
conversation.updated at that point.

Implication. The one place spec 7.3 requires the emitter list to be
recorded ships inaccurate at merge. PR83 promised the write-through covered
every ruling.

## 4. [LOW] PR91's live gate checks only the pressed row, so a second Retry of an automated text still stamps

What is wrong. The Retry route always appends `automated: false`
(`api.ts:1877`), and the dashboard offers Retry only on a chain's newest row
(the R6 comment, `api.ts:1746-1752`). Suppose a staff Retry of a failed
missed-call auto text fails too, and staff press Retry again. The pressed
row is now the first manual retry row, stored `automated: false`, so
`original.automated !== true` holds and the second press stamps. The
backfill agrees by construction: `isSystemCopy` judges the retried row's
own `automated` flag and body (plan ~19124-19128), and a missed-call body
matches neither body set.

Implication. This is the B3 leak one hop later: rare, and live and backfill
agree. If the gate is meant to hold, judge the chain root (`retry_root`, which
the route already reads, `api.ts` ~1771-1783) rather than the pressed row.
Otherwise record it beside PR91's accepted Send-now residue.

## 5. [LOW] PR82's mutation-check instruction, taken literally, makes the test fail for the wrong reason

What is wrong. S4.1 Step 4 (plan ~8713-8720) says to "temporarily change
`buildFollowUps`'s first line to
`await collectWaitingFollowUps(deps, { consistentRead: true })`". After 3e,
that first line is `const { rows, truncated } = await collectWaitingFollowUps(deps);`.
A literal replacement drops the destructuring, so `rows` is undefined, the
route 500s, and the case fails on `expect(before.status).toBe(200)` - not on
`call.opts?.consistentRead`, which is the failure the step tells the builder
to confirm.

Implication. Say "add `{ consistentRead: true }` as the second argument of
that call". Otherwise the recorded red run does not prove what WI1 needs.

---

## Contested adjudications

- PR88 (my A7): concede. Continuation passes carry only deferred members
  (`relayFanOut.ts:1508-1640`), so the pass count is bounded. The remaining
  objection is procedural: it is a spec deviation without the human's
  sign-off (finding 2).
- PR90 (my A9 / B1): concede. A GSI cannot be read consistently, and adding
  a second refetch is a scope call. The WI8 rewrite now names the right reads
  (`toursRepo.ts:442-457` byStatus; `followUps.ts:150` byUnit;
  `listingSendsRepo` is a base-table Query).
- PR92, PR93 (B's): no position. PR92's cost follows from spec 4's mandated
  filter order. PR93's widening is defensible; see finding 2 for the
  procedure.

## Write-through changes checked and found correct

- PR81: the founderTriage case goes RED for the stated reason (no
  `contact.updated`; the redelivery answers 'skipped' because the harness
  fake is forward-only on `>=`, `twilioWebhookHarness.ts:2633-2647`).
  `events` is in router scope (`voice.ts:371`). The helpers `founderHarness`,
  `bizVoiceParams` and `CALLER` exist (`founderTriage.test.ts:52,89,113`).
- PR87: `signedTwilioPost` takes an `Express` (`twilioWebhookHarness.ts:5905-5910`)
  and `buildApp` returns one (`app/src/app.ts:106`). An implementation that
  touches before `sendTwiml` records `false` and fails, so the probe closes
  round-1 A6.
- PR91 (live): `MessageItem.automated` exists (`messagesRepo.ts:768`). The
  Retry route has no refusal that an automated original would trip
  (`api.ts:1715-1760`). `makeRetryApp(original: unknown)` accepts the spread.
- PR91 (backfill): the two new cases trace to the stated counts. The retry
  check runs before the body exclusions, so NR lands in
  `retry_of_system_copy`, not `excluded_nudge_body`. Page-first indexing
  covers the same-page case. `GROUP_THREAD_TYPES` and
  `MESSAGE_CATALOG['nudge.receipt_check']` exist (`app/src/messages/catalog.ts:206`).
- PR84 step 3e list: only four api.ts call sites use the default service
  (`api.ts:1084,1213,1564,1872`); the R6 harness case exists
  (`apiRoutes.test.ts:1369`); `seedSendNowTour` and `seedSendNowNudge` seed
  consent and are in the describes the new cases join
  (`tourRemindersApi.test.ts:1659-1661`, `placementNudgesApi.test.ts:616`).
- PR78 helper guard: `StageClient` exposes `endpoint` and `prefix`
  (`app/scripts/lib/stageClient.ts:76-87`).
- PR86: `unitsRepo.getById` returns soft-deleted items
  (`unitsRepo.ts:1264-1273`). Both new S4.3 cases go red on an undefined
  `unitLabel`.
