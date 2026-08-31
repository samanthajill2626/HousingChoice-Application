# Plan design review - round 2 adjudications (TERMINAL)

Reviewer A continued. **5 findings - 5 ACCEPTED. No BLOCKING, no reversed
decision.** Two of the three low-confidence areas came back CLEAN with proof
recorded in the report (typecheck-as-enumerator holds for all three Records;
the quiet-formula consumer enumeration is complete at two tour surfaces - all
20 `isQuietTime` consumers classified). P18 stands unconstested.

## Terminal ruling

Trajectory: 21 merged findings -> 5, no BLOCKING, and every finding is
remedy-precision inside already-accepted rulings - no new design direction, no
surface added or removed, no invariant moved. By the stop rule this is the
terminal round: fold in and stop.

## PR2-1. ACCEPT [HIGH] - Task 13's interim member_added rewiring broke four unlisted sites; RESTRUCTURED so the interim state does not exist

Verified sites: `relayFanOut.test.ts:642,662`, `toursApi.test.ts:3813`,
`relayApi.test.ts:1046,1052` (a suite in NO task's run set),
`e2e/tests/dashboard-next/relay-group-view.spec.ts:161,172`,
`e2e/tests/roster-quiet-hours.spec.ts:485-486` - all pin the OLD
joined-this-group-chat copy, and the draft had them re-baselined TWICE (interim
copy at 13, split copy at 14).

**Remedy: Task 13 no longer touches `relay.member_added` at all.** It rewrites
`relay.intro` (byte-identical output - the seam the byte-identity pin already
proves) and ADDS the new entries; the member_added rewrite, `joinedName`,
`ANONYMOUS_JOINED_LABEL`'s deletion, and every member_added pin re-baseline move
to Task 14, where they land ONCE alongside the split. No interim copy state, no
double re-baseline, and `relayApi.test.ts` joins Task 14's run set. The
nameless-joiner e2e coverage (`relay-group-view.spec.ts:172` - the ONLY coverage
of that path) is retargeted to `a new member` in Task 14, preserving the
coverage the deletion would have orphaned.

## PR2-2. ACCEPT [HIGH] - the label MAPS were fixed; the label FUNCTIONS fall through

`RemindersPanel.tsx:116-118` returns the Paused chip on `reason === 'paused'`
EQUALITY and otherwise falls through to the "sends in Nh" fire-time promise -
so a `discontinued` reason renders the exact lie this mechanism exists to end.
`ScheduledCard.tsx` has the same shape. Task 8 now adds an explicit
`discontinued` branch ABOVE the paused branch in BOTH renderers, with a
failing-test-first step per renderer.

## PR2-3. ACCEPT [HIGH] - the prescribed copy stuttered

`suppressionLead('discontinued')` "No longer sent" + label "no longer sent"
renders "No longer sent - no longer sent". RULED: the label is `turned off` -
note form "No longer sent - turned off"; the RemindersPanel chip renders the
lead alone ("No longer sent"), matching how Paused renders. All three surfaces
get the same pair.

## PR2-4. ACCEPT [MEDIUM] - Task 14 step 8 gains the full app suite run

The P8 cadence landed on Tasks 3, 7, 9 and not 14. Without it, PR2-1's class of
red (a file outside the named run set) survives to gate 2. Added.

## PR2-5. ACCEPT [MEDIUM] - the timeline exemption's real seam is `quietFor`

The addendum pointed at the right file with the wrong frame: the timeline's
quiet evaluation is a kind-blind closure (`quietFor`, `contactTimeline.ts:1305`)
shared with the placement-nudge walk via `suppressionFor` (`:845`). Task 10
exempts at the REMINDER call site of that closure - never inside it, or
placement nudges lose their quiet suppression. Instruction rewritten with both
line anchors.

## Loop closed (plan)

Two rounds: 26 findings, 25 accepted, 1 accepted in part, 0 rejected. The
cross-document lesson held a fourth time - every round's worst findings sat in
text written during the previous adjudication - and the terminal round is the
first one whose findings are all remedy-precision.

Next: the mission block and the human launch gate.
