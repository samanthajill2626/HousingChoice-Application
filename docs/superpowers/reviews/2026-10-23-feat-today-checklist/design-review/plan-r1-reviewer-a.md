# Plan review r1 - reviewer A (adversarial, plan-blind)

Plan: `docs/superpowers/plans/2026-10-24-today-checklist.md` (v1).
Spec: `docs/superpowers/specs/2026-10-23-today-checklist-design.md` (r6).
Tree: `feat/today-checklist` @718194dc (code identical to main @970a29b9).

Method: walked every spec section to a task; grepped the app, dashboard and
e2e for every writer of an outbound row, every reader of the Today groups /
headings / wire, and every `last_heard_from_at` site; ran a script over all
347 quoted `old:` anchors against the tree (the 45 that do not match HEAD
are all text an earlier task in the plan creates; the chains I followed -
S1.2 -> S2.1 sendMessage stub, S3.1 -> S3.3 W7 marker, S4.3 -> S4.7 imports,
S4.4 -> S4.5 test text - are intact). Spot-checked that the fixtures and
helpers the tests call exist (`e2e/support/urls.ts` `dashboardUrl`,
`/__dev/listing-send-fixture`, `isPointerConversation` export and its CLI
guard, harness `heardFromTouches` / event recorder, RUNBOOK anchors).

Overall: coverage of spec 2-10 is complete or explicitly deferred; the
writer table W1-W8 and the no-stamp table match every outbound append I
could find (`direction: 'outbound'` in app/src: api.ts relay posts,
sendMessage, sendEmailMessage, groupSend, originateCall, relayAnnouncements,
broadcastFanOut, sendReconcile, dev.ts; `adapter.sendMessage` direct calls
are the relay legs and the staff cell-verify code, voiceApi.ts:251, which
is not a contact send). Nothing below is BLOCKING. Findings follow, most
consequential first.

---

## 1. [MEDIUM] Founder-triage inbound call is misclassified as "touch first"; spec 8's fix is withheld

What is wrong. Spec 8 says the plan "checks each [inbound path] and adds
the same post-stamp `contact.updated` where the order is wrong". The S2
inbound order table (plan ~5898) records the founder-triage inbound call
(`app/src/routes/webhooks/voice.ts:834`) as "touch first / none", relying on
"conversation.updated from the Dial summary's stampCallActivity", and S2.6
says explicitly "It needs no change" (plan ~5476-5481).

Evidence. The same handler's own comment says the Dial summary is not
guaranteed: "A caller who abandons during the ring produces no Dial summary
(docs/issues/voice-caller-abandon-no-dial-summary.md)"
(`voice.ts:790-797`). At ring time the handler emits only
`message.persisted` (`voice.ts:809-814`), which Today does not subscribe to
(`dashboard/src/routes/today/useToday.ts` useEventStream block). The issue
`docs/issues/voice-caller-abandon-no-dial-summary.md` is `status: open` and
says it is unverified whether Twilio calls the Dial action on an abandon.
Even on an answered call, the only event Today hears arrives at call END.

Implication. A quiet-share person who calls in and hangs up during the ring
moves `last_heard_from_at` with no event Today hears, so they stay listed on
an open Today page (spec 6.1 drop-off "they send a message, call or
email"). The masked relay call paths get the fix in S2.6 for exactly this
reason; the founder-triage path has the same shape and should get the same
post-touch `contact.updated` (when 'written'). The committed S2 report table
would also record a false "touch first" claim.

## 2. [LOW] The WI1 "tab reads without consistentRead" pin is vacuous under the binding element shape

What is wrong. S4.1 step 1d (plan ~8172-8173) asserts
`for (const opts of world.recipientDisplayCalls) expect(opts?.consistentRead).toBeUndefined()`,
treating each entry as the opts object. S1.3 (plan ~1821) records entries
as `{ contactIds, opts? }`, and PR60 says S1's shape binds and the S4
builder "adapts the three assertions". But this case is labelled (PIN) and
expected GREEN at RED time (plan ~8186-8187); with S1's shape
`entry.consistentRead` is always undefined, so it is green whatever the tab
passes. Nothing in the run tells the builder this one needs adapting (the
S4.7 `toMatchObject({ requireComplete: true, consistentRead: true })` at
~12439 goes red and will be noticed; this one never does).

Implication. The only route-level guard that the Follow up tab keeps its
eventually-consistent read (spec 6.1 "the Follow up tab keeps its current
read") can ship asserting nothing. Fix the slice text to read
`call.opts?.consistentRead` rather than relying on PR60.

## 3. [LOW] S2.2 changes which contacts repo the default send service's gates read in tests, without analysis

What is wrong. PR9 / S2.2 pass the router's `contacts` into
`createSendMessageService` (plan ~3816-3857). The WI2 record (plan
~3916-3927) argues "every other consumer gets the same repo object" -
true, and in production the behavior is identical. But in every harness
suite the default send service used to resolve `findByPhone` against a real
DynamoDB Local repo (harness comment `twilioWebhookHarness.ts:5591-5596`);
after S2.2 it reads `world.contactsRepo`. The opt-out, deleted and JIT
consent gates (`app/src/services/sendMessage.ts:487-535`) then judge the
world's contacts, which can refuse a send that used to go out (a world
contact holding the thread's phone with no `consent_method`) or vice versa.

Evidence. UNVERIFIED that any existing case flips: the harness suites that
POST a 1:1 send or Retry without injecting `sendMessageService` are in
`apiRoutes.test.ts` (and send-now cases in `tourRemindersApi` /
`placementNudgesApi`); the S2.2 GREEN list covers those, so a flip would be
seen. The gap is that the plan predicts "Expect all green" with no reasoning
about gate outcomes, and gives the builder no rule for a red that appears
(fix the fixture's consent? that can read as weakening).

Implication. Add one sentence: the gates now judge `world.contacts`; a case
that goes red because its world contact lacks consent is a fixture that
relied on the old real-DynamoDB miss, and the fix is to seed consent on that
contact, named in the S2 report.

## 4. [LOW] Two handback obligations the spec names are delivered by no task

What is wrong. Spec 7.5: "the handback lists it [the backfill run] as a
post-merge obligation". Spec 10: "Tracker #31: record the Oct 23 decisions
and Sam's option C pick when the build ends." The plan pushes both outward:
S6 notes "S8 handback: the RUNBOOK entry ... is a post-merge obligation"
(plan ~17748-17750); S7 notes the tracker is "the planner's handback item
(Google Docs connector)" (plan ~19934-19936). But S8.4's two report
templates (plan ~23460-23500) contain neither line, and no task writes a
handback.

Implication. A builder executing literally hands back without the
post-merge backfill obligation (the RUNBOOK entry exists, but nothing tells
the merger it is owed - the backfill must run AFTER the deploy, spec 7.5) and
without flagging the tracker update. Add both lines to the S8 report
template.

## 5. [LOW] PR25 drops a deleted property's address; the spec's formula keeps it

What is wrong. Spec 3 defines `unitLabel` as `formatAddress(unit.address)
|| unitId` and says only "a failed unit lookup degrades to the unitId".
PR25 (plan ~385-389) also returns the unitId for a "missing/deleted unit".
`unitsRepo.getById` returns soft-deleted items with their address intact
(`app/src/repos/unitsRepo.ts:1264-1273`; `isDeleted` is a separate test,
`:587-589`).

Implication. A requested or today's tour on a soft-deleted property shows a
raw `unit-...` id on Today instead of the address the spec formula yields.
Small, but it is a ruling that deviates from the spec with no stated reason.

## 6. [LOW] W6 tests prove the stamp does not block the TwiML, not that it starts after it

What is wrong. Spec 7.3 W6: the stamp runs "AFTER the TwiML response is
sent"; spec 9: "The W6 stamp is asserted to run after the TwiML is sent,
through a seam the test can await". The S2.4 cases (plan ~4313-4348) prove
(a) the work is handed to `afterResponse` and (b) a parked stamp does not
hold the `<Dial>` response. An implementation that starts the un-awaited
`touchLastReachedOut` BEFORE `sendTwiml` passes every case.

Implication. The ordering guarantee rests only on WI3's human read of the
diff. One assertion closes it: in the injected `afterResponse`, record
`res.headersSent`/a response-finished flag (or check that the fake touch was
not yet called when the response body was produced).

## 7. [LOW] Relay continuation passes each emit an after-loop event; only recorded, never ruled

What is wrong. Spec 7.3: a relay or group post emits "ONE
`conversation.updated` for the thread after its fan-out loop finishes" and
"bounds the extra events at one per staff send". PR17 places the emit at the
end of each fan-out PASS (`relayFanOut.ts` "relay fan-out complete" log,
~1632), and WI5 (plan ~141-143) concedes "each fan-out continuation pass is
its own job and may emit its own after-loop event" - record only.

Implication. A post with transient-deferred members emits one event per
pass. Probably harmless (continuations exist only for deferred members,
`relayFanOut.ts:1508-1640`), but it is a spec deviation no ruling accepts;
either rule it accepted or say so in PR17.

## 8. [LOW] PR77's TODAY_TERMINAL has no terminal for "checklist empty, a section unavailable"

What is wrong. PR77 (plan ~644-646) sets the perf terminal to the seven
checklist lists, "All caught up" and the queue load-error alert
(`e2e/performance/routes.ts:396-403` matches "We couldn't load your queue",
`contains`). When every checklist section is empty and Quiet shares or Tours
to book is unavailable (or the load is the fallback), the page shows only
"We couldn't load quiet shares." / "Some sections can't load right now."
and At a glance - none of which is a terminal. S5's own note (plan
~13254-13257) included the fallback line; PR77 drops it.

Implication. A perf sample on that page state reads as an unknown /
ready_timeout. Add the per-section unavailable alerts and the fallback line
as terminals.

## 9. [LOW] WI8 omits the tours GSIs that the live Tours to book / Quiet shares promise depends on

What is wrong. Spec 8 promises that after a tour create's new `tour.updated`
"a new request appears in Tours to book and the person leaves Quiet shares
live". The refetch reads `tours.listByStatus('requested')` (byStatus GSI,
`app/src/repos/toursRepo.ts:442-457`) and the core's `tours.listByUnit`
(a GSI) - neither can be read consistently. WI8 (plan ~149-151) lists only
units and listing-sends as eventually consistent.

Implication. On a slow index propagation the 300 ms debounced refetch can
miss the new tour and nothing refetches again. Not fixable without a
consistent base-table read; record it in WI8 and the spec 6.5 cost issue so
nobody reads the e2e pass (DynamoDB Local is always consistent) as proof.

## 10. [LOW] PR78's lane-helper guard is not in the helper's code

What is wrong. PR78 (plan ~647-650) approves the S7.15 helper on the
condition that "it refuses to run unless the endpoint host is
localhost/127.0.0.1 AND the table prefix is the lane's `hc-local-<L>-`
prefix". The helper code given verbatim (plan ~22800-22826) checks only
`parseLane` and then writes (`REMOVE last_reached_out_at`) through
`resolveStageClient('local', {}, { lane })`; it never inspects the endpoint
host or `stage.prefix`.

Implication. A builder copying the code ships a data-writing helper without
the guard the approval required. The step-3 lane checks the task runs
beforehand mitigate it, but the helper itself should assert both before the
UpdateCommand.

---

Checked and found sound (so a later reviewer need not re-derive):
- Every `buildFollowUps` caller (`routes/broadcasts.ts:1410`) keeps the
  byte-identical tab; `getRecipientDisplaysByIds` callers in `units.ts`
  project explicit fields, so the added projection attribute reaches no
  other wire.
- No contact re-creation path (merge / conversion) exists that would drop
  the new field; `contactsRepo.update` is a SET/REMOVE UpdateItem.
- All `/api/today` readers (`app/scripts/seed-smoke.mjs`,
  `e2e/performance/*`, the listed e2e specs, `contactSoftDelete`,
  `aiRunVerdicts`) are covered or unaffected; the `Placements` / `Tours to
  book` headings collide with no exact page-heading locator.
- Backfill row rules match the writers' real row shapes (broadcast adoption
  rows carry `broadcastId`, `broadcastFanOut.ts:1409-1422`; the automatic
  retry adoption carries `retryAttempt`, `sendReconcile.ts:923-943`; the
  intro row body is exactly `intro_body`, `relayAnnouncements.ts:229-242`;
  `intro_body` is retained on the thread, `conversationsRepo.ts:2022`).
