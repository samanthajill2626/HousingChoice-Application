---
id: press-0-team-escape-removed
title: The press-0 "reach the team" escape was removed from the relay whisper gate
type: decision
severity: med
status: resolved
area: app
created: 2026-08-06
resolved: 2026-08-06
refs: app/src/routes/webhooks/voice.ts, app/src/messages/catalog.ts, PHASE1_CHANGE_ORDER_1.md:9, PHASE1_CHANGE_ORDER_1.md:22, docs/superpowers/specs/2026-08-06-business-number-config-design.md
---

**Problem.** The masked relay whisper gate carried a second affordance beside the
press-1 accept: a callee on a masked relay leg could press 0 to "reach the team".
The whisper copy advertised it IN AUDIO - `voice.whisper_relay` read
`'You have a Housing Choice call from {callerLabel}. Press 1 to accept, or press
0 to reach the team.'` - so this was a real user-facing affordance, not dead
code. Pressing 0 emitted
`<Dial callerId="BUSINESS"><Number>BUSINESS</Number></Dial>`; when no business
number was configured it said `voice.team_unreachable` and hung up. The founder
bridge leg never offered it (the founder IS the team), which is why the two
whisper strings differed at all.

The affordance was UNPROVEN. Nothing tested that pressing 0 reached a human:
the only coverage asserted the shape of the returned TwiML (a `<Dial>` with the
right `callerId`), never the outcome of the resulting call. No test, e2e
scenario, or recorded dev call demonstrated a person answering.

UNVERIFIED MECHANISM - explicitly not established, recorded here only so the
next reader does not have to re-derive it. Because the emitted `<Dial>` targets
the business number FROM the business number, Twilio would place a call to a
number we own from a number we own. IF that re-enters
`POST /webhooks/twilio/voice`, the inbound echo guard drops any call whose
`From` is one of ours and answers with empty TwiML, and the member who pressed 0
would hear silence. That is standard-looking Twilio behavior but it was NOT
OBSERVED ON THIS STACK. Confirming it requires a live dev call. It was NOT a
prerequisite for the removal and it is NOT a claim that the feature was broken.

**Decision (2026-08-06).** Remove press-0 rather than repair it. Grounds, in
order of confidence:

1. The affordance is unproven (above) - there is no evidence it ever connected
   anyone, and no test that could tell us.
2. Repairing it correctly is NEW LOGIC ON A LIVE-CALL PATH. The right shape is
   an INTERNAL hand-off to founder triage, not a PSTN round-trip out to our own
   number - and that work landed days before a number port, on the one code path
   where a mistake is heard by a caller in real time.
3. It conflates "numbers we own" with "people we ring" - exactly the confusion
   the business-number configuration change exists to remove.

What was deleted: the `digits === '0'` branch in the whisper gate
(`app/src/routes/webhooks/voice.ts`), its `teamNumbers`/`teamCallerId` locals,
the ", or press 0 to reach the team" clause from `voice.whisper_relay`, and the
whole `voice.team_unreachable` catalog entry plus its member in the id union.
The catalog entry was DELETED rather than marked `dead: true` because `dead` is
reserved for an unreachable code path kept for completeness; here the code path
itself is gone, so a retained string has no referent.

Behavior now: `Digits='0'` is not special. It falls through to the existing
final branch and hangs up the bridged leg - byte-identical to a Gather timeout
or any other key, on both the relay and founder legs. `voice.whisper_relay` is
now byte-identical to `voice.whisper_founder`; both IDs are KEPT because they
address different contexts and are independently editable.

Traceability: press-0 is recorded as a signed deliverable in
`PHASE1_CHANGE_ORDER_1.md:9,22`. This issue exists so the removal reads as a
deliberate decision against that change order rather than an accidental
regression.

**If it is ever re-added,** two things must be settled first:

- The hand-off must be INTERNAL - route the leg to founder triage directly,
  not by dialing our own PSTN number and hoping the inbound webhook picks it
  up. That is the fix the second ground above defers.
- Decide how a MASKED relay member's identity appears in triage's non-masked
  call record. Relay legs exist precisely so participants never see each
  other's numbers; founder triage records a real caller. Handing one to the
  other without a rule either leaks a masked number into a normal call record
  or presents the founder with an unidentifiable caller.
