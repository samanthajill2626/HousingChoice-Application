# Plan R2 - adversarial review A (continued reviewer)

Plan: `docs/superpowers/plans/2026-08-31-tour-reminder-ladder-phase-b.md` @`b2d3a5c4`
Prior: R1 reviewer A (17), R1 reviewer B (17), adjudications `plan-adjudications-r1.md`
Diff reviewed: `git diff e0df9e50..b2d3a5c4` (plan + spec section 6 addendum)

Scope of this pass, in the order asked: (1) what the revision itself introduced,
(2) remedies that are wrong or incomplete for the finding they answer, (3)
executability start to finish. I did NOT re-verify closed R1 findings except
where the remedy created new text.

**Result: 5 findings. Two HIGH are in the revision's own new text (Task 13's
keep-green seam and Task 8's renderer enumeration); one HIGH is a copy defect
the P1 remedy created; one MEDIUM is a remedy that did not fully land in the
document; one MEDIUM is an under-specified seam in the P5 addendum's task step.**

Two of the coordinator's three low-confidence areas came back clean and are
recorded as such at the end, with proof, so nobody re-derives them.

---

## 1. [HIGH] Task 13's new interim `member_added` rewiring breaks four sites the inventory never lists - two of them e2e specs, and one app suite that no task runs

**What is wrong.** P6's remedy moved the member-added BODY CHANGE forward from
Task 14 to Task 13, so that call sites stay green. It does keep them
compiling - but the body itself changes at Task 13, and the plan's tripwire
inventory was written for the OLD schedule, when that string only changed in
Task 14 (where step 7 scoped the e2e work). The revision did not re-derive the
inventory against its own new schedule.

Task 13 step 2 (new): "`composeMemberAddedBody(newMemberName, memberNames)`
keeps its signature and internally becomes
`resolveMessage('relay.member_added', { name: joinedName(newMemberName) })` -
note the GROUP line no longer carries the connection sentence (founder copy);
the job/preview pins that asserted it are re-baselined HERE."

So at the Task 13 commit the shipped body goes from
`"Hey! Carol joined this group chat. You're now connected with ..."` to
`"Hey, adding Carol to the group."`. Every assertion on the substring
`joined this group chat` dies.

**Evidence - the sites, and whether any task covers them.**

| site | asserts | in Task 13 step 3's tripwire list? | in Task 13 step 4's run set? |
|---|---|---|---|
| `app/test/relayFanOut.test.ts:642` | `'Carol joined this group chat.'` (JOB case) | no - step 3 names only `:703-716` | yes |
| `app/test/relayFanOut.test.ts:662` | `'A new member joined this group chat.'` (JOB case) | no | yes |
| `app/test/toursApi.test.ts:3813` | `'Casey joined this group chat.'` | no - the inventory (plan line 71) names only `toursApi.test.ts:3989-3998,4096` | yes (file is in the run set) |
| `app/test/relayApi.test.ts:1046,:1052` | `'Bob joined this group chat.'`, and the same string on the persisted system row | no | **NO - `relayApi.test.ts` is in no task's run set** |
| `e2e/tests/dashboard-next/relay-group-view.spec.ts:161` | `'Leon joined this group chat'` in the DASHBOARD thread | no - file appears nowhere in plan or spec 10a.2 | n/a |
| `e2e/tests/dashboard-next/relay-group-view.spec.ts:172` | `'A new member joined this group chat'` - the `ANONYMOUS_JOINED_LABEL` path Task 13 DELETES | no | n/a |
| `e2e/tests/roster-quiet-hours.spec.ts:485-486` | `expectSentTo(req, tenant.phone, 'joined this group chat')` for two members | no | n/a |

**What it implies.** Spec 10a.2 presents its table as "the known FLOOR, not the
complete list. The plan derives the rest" - and the plan's derived inventory
(line 71) still does not contain these. Two whole e2e FILES that assert the
member-added copy are named in neither document. `relayApi.test.ts` goes red at
Task 13 and stays red through Task 14 (see finding 4), i.e. to the final gate.

The two e2e files matter more than the count suggests:
`relay-group-view.spec.ts:172` is the ONLY coverage of the nameless-joiner path,
which is exactly the path Task 13 re-implements (`ANONYMOUS_JOINED_LABEL` ->
`joinedName`, spec 9.4's totality table). Deleting the label and leaving its only
e2e assertion unnamed means the `'a new member'` value ships with its rename
unproven until somebody reads a red e2e log at Task 14.

**Owed:** add these seven sites to Task 13 step 3, and say plainly that the
member-added body changes TWICE (Task 13 group-only, Task 14 per-recipient), so
`relayFanOut.test.ts:630-662`, `toursApi.test.ts:3813` and
`placementsApi.test.ts:1007` are re-baselined in 13 and again in 14.

---

## 2. [HIGH] P1's remedy enumerates the three Records (the loud half) and misses the two label FUNCTIONS that silently fall through to a fire-time promise

**What is wrong.** Task 8's new preamble makes `npm run typecheck` the
enumerator: "every red site is a reader; fix each". That is true of the
`Record`s. It is NOT true of the two functions that decide what the chip SAYS,
because both index by equality against `'paused'` and fall through otherwise -
no compile error, no test, and the fall-through is the exact lie the mission
exists to end.

**Evidence.**

- `dashboard/src/routes/tours/RemindersPanel.tsx:110-127`. The chip function's
  only suppression branch is `:117` `if (rung.suppression?.reason === 'paused')
  return <span ...>Paused</span>;`. Everything else reaches `:123`
  `const text = sendRelative(rung.dueAt);` and renders the amber
  "sends in Nh" / "sending shortly". Its own docblock at `:110-116` states the
  rule: "The fire-time wording below is a promise, so it must not be reached
  here - a chip reading 'sending shortly' above a line reading 'Paused' is
  precisely the perpetual-'sending shortly' lie this feature exists to end, and
  the chip is what gets read first."
- `dashboard/src/routes/contact/ScheduledCard.tsx:56-59`
  `function scheduledLabel(...) { if (item.suppression?.reason === 'paused')
  return 'Paused'; return fireTimeLabel(item.at, now, timezone); }`, with
  `fireTimeLabel:41-46` returning `'sending shortly'` or `sends in Nh`. Its
  docblock at `:48-51` carries the same rule verbatim.

**What the revised plan says.** Task 8 step 2b: "`RemindersPanel.tsx`: the
suppression chip for `discontinued` renders 'No longer sent' (plain-hyphen copy
rules apply) and MUST NOT render the Paused chip or the send-manually note. The
timeline scheduled card: its record gains the entry and its comment lines (which
explain each reason's lead) gain one for discontinued (terminal)."

Two problems. First, the prohibition is aimed at the wrong hazard - nothing
would render "Paused" for a `discontinued` reason, since both branches test
`=== 'paused'`; the live hazard is the fire-time fall-through, and it is not
named. Second, for the timeline the instruction is explicitly scoped to "its
record ... and its comment lines" - `scheduledLabel` is not mentioned, so a
literal executor ships a contact-page card reading "sends in 3 days" over a note
saying the message is no longer sent.

**What it implies.** This is the same class as the finding P1 accepted, one
level down: the enumeration covered the sites the compiler names and stopped.
Task 12's aside ("The discontinued chip from Task 8 wins over overdue") presumes
a chip branch that Task 8 never explicitly orders. The owed text is one line per
renderer: add a `discontinued` branch ABOVE the fire-time fall-through in
`RemindersPanel`'s chip function and in `ScheduledCard`'s `scheduledLabel`, and
say that typecheck cannot find these two because they are equality tests, not
exhaustive maps.

---

## 3. [HIGH] The copy the P1 remedy prescribes stutters on all three surfaces: "No longer sent - no longer sent"

**What is wrong.** The revision specifies the lead and the label independently
and they are the same words.

**Evidence.**

- Task 8 step 2 (unchanged): "`suppressionLead`: add
  `if (reason === 'discontinued') return 'No longer sent';`".
- Task 8's new preamble: "`REMINDER_SUPPRESSION_LABELS` (`discontinued: 'no
  longer sent'` - the tour chip pairs `suppressionLead` + this label)", and step
  2b: "`DeadlinesNudgesCard.tsx:64`: `discontinued: 'no longer sent',`".
- `dashboard/src/api/types.ts:1175-1177`
  `suppressionNote(reason, label) { return `${suppressionLead(reason)} ${EM_DASH} ${label}`; }`.
- `dashboard/src/routes/tours/RemindersPanel.tsx:314-319` renders
  `suppressionNote(rung.suppression.reason, REMINDER_SUPPRESSION_LABELS[...])`.
- `dashboard/src/routes/contact/ScheduledCard.tsx:78` renders through the same
  `suppressionNote`.
- `dashboard/src/routes/placements/DeadlinesNudgesCard.tsx:247-249` composes
  `${suppressionLead(reason)} - ${NUDGE_SUPPRESSION_LABELS[reason]}`.

So the shipped note is **"No longer sent - No longer sent"** (em dash on the two
tour/timeline surfaces, plain hyphen on the placements card). Every existing
pair is lead-plus-DISTINCT-label: `paused` -> "Paused - send manually"
(`types.ts:1270`), `quiet_hours` -> "Will wait - quiet hours" (`:1269`).

The plan's own parenthetical ("the tour chip pairs `suppressionLead` + this
label") shows the composition was seen and the duplicate value specified anyway.
Nothing catches it: Task 8 step 1(c)'s new assertion is only that
`REMINDER_SUPPRESSION_LABELS['discontinued']` "is defined and underscore-free".

**Secondary, same edit.** The three records deliberately word the same reason
per audience - `stale_stage` is `'tour no longer at this stage'`
(`types.ts:1265`), `'no longer applies'` (`ScheduledCard.tsx:25`) and
`'stage moved on'` (`DeadlinesNudgesCard.tsx:68`). Prescribing one identical
string for all three is a departure from that pattern, unremarked.

**Owed:** a label that completes the lead rather than repeating it (the
mechanical fix is a label naming the CAUSE, e.g. `'confirmation texts were
retired'` / `'this reminder was retired'`, with the placement card's
compile-only entry free to be terser), and an assertion on the composed
`suppressionNote('discontinued', ...)` string rather than on the label's mere
existence.

---

## 4. [MEDIUM] P8's remedy landed on three of the four tasks it names; Task 14 never runs the full app suite, so finding 1's `relayApi.test.ts` stays red to the final gate

**What is wrong.** Adjudication P8 states: "Full app unit suite now runs at the
end of Tasks 3, 7, 9 and 14." The plan text implements it at 3, 7 and 9 only.

**Evidence.**

- Task 3 step 9 (new): "then the FULL app suite (`cd app && npx vitest run`)" - yes.
- Task 7 step 5 (new): "then the FULL app suite (`cd app && npx vitest run`)" - yes.
- Task 9 step 4: `cd app && npx vitest run` - yes (pre-existing).
- Task 14 step 8 (revised): "`cd app && npx vitest run test/relayFanOut.test.ts
  test/toursApi.test.ts test/placementsApi.test.ts test/relayGroupPreview.test.ts
  test/messages/catalog.test.ts` - PASS. Then the FULL e2e suite" - **five named
  files plus e2e; no full app suite.**

**What it implies.** After Task 9 the plan never runs the whole app suite again.
Tasks 10, 11, 12, 13 and 14 all run named files only. `app/test/relayApi.test.ts`
- red from Task 13 per finding 1 - is therefore invisible for five commits and
surfaces at gate 2, which is precisely the attribution failure P8 was accepted to
fix. Adding `cd app && npx vitest run` to Task 14 step 8 closes both this and
finding 1's blind spot in one line, and it is the cheapest of the run additions
the revision already made.

---

## 5. [MEDIUM] The P5 addendum's timeline exemption points at the right file and the wrong frame: the seam is a kind-blind closure two frames up, shared with the placement-nudge walk

**What is wrong.** Task 10 step 3 (new) says: "Exempt `en_route` from the QUIET
disjuncts ... at BOTH tour surfaces that compute the estimate:
`routes/tourReminders.ts` and `routes/contactTimeline.ts`". On the route that is
a local edit. On the timeline it is a signature change to a shared helper, and
the plan does not say so.

**Evidence.**

- `app/src/routes/tourReminders.ts:560-564` - `suppressionOf` is built inline in
  the handler and already receives `dueAt` per row; adding a kind is local. Fine.
- `app/src/routes/contactTimeline.ts:1298-1306` - the quiet flag is a closure
  over `dueAt` ALONE, handed down as a gather parameter:
  `quietFor: (dueAt: string) => (dueAt > nowIso && isQuietTime(dueAt, window)) || (wallClockQuiet && dueAt <= nowIso)`,
  passed into `gatherUpcoming({...})`.
- `app/src/routes/contactTimeline.ts:845` - `const suppressionFor = (` is the
  helper built from `quietFor` INSIDE the gather, and it has **two** call sites:
  `:880` (the PLACEMENT-NUDGE walk) and `:1001` (the tour-reminder walk). Neither
  passes a kind.

**What it implies.** The builder must widen `quietFor` (or `suppressionFor`) to
carry the rung kind, which touches the nudge walk's call site too - benign,
since no nudge kind is `en_route`, but it is a shared-signature change three
frames from where the plan points, in a function whose gather params are a
declared interface. R1 reviewer B's evidence cited `:1005-1010` (the CALL), and
the adjudication inherited that frame. One sentence naming `quietFor` at `:1305`
and `suppressionFor` at `:845`, plus "the nudge call site at `:880` passes a
kind that is never exempt", removes the guesswork.

Note the exemption must also stay out of the OTHER disjunct's siblings: the plan
correctly says "not from the whole evaluator - opt-out / kill-switch /
manual-mode reasons still apply", and `evaluateScheduledSendSuppression`
(`app/src/services/scheduledSendSuppression.ts:43-60`) ranks `quiet_hours` last,
so suppressing only the `quietNow` input is the right shape. No fault there.

---

## Checked and CLEAR - recorded so nobody re-derives them

**Coordinator's area 2 - "is a compile error actually guaranteed for all three
Records, or does one index with a widening that stays green?" YES, guaranteed,
for all three, at Task 8 step 3 and at gate 1.**

- `package.json:50` `"typecheck": "npm run typecheck --workspaces --if-present"`
  and `package.json:9-15` lists `dashboard` as a workspace with its own
  `"typecheck": "tsc -p tsconfig.json --noEmit"` (`dashboard/package.json:10`).
  So the root gate really does typecheck the dashboard - the failure mode where
  the enumerator silently skips the three dashboard records does not exist.
- All three declarations are exhaustive `Record`s over the widened union:
  `dashboard/src/api/types.ts:1259-1261`
  (`Record<NonNullable<TourReminderView['suppression']>['reason'], string>`),
  `dashboard/src/routes/contact/ScheduledCard.tsx:19-21`
  (`Record<NonNullable<TimelineScheduled['suppression']>['reason'], string>`),
  `dashboard/src/routes/placements/DeadlinesNudgesCard.tsx:64`
  (`Record<ScheduledSuppressionReason, string>`). The `?? reason` widening at the
  READ sites (`RemindersPanel.tsx:318`, `DeadlinesNudgesCard.tsx:248`) does not
  soften the DECLARATIONS.
- App side: `grep` for `ScheduledSuppressionReason` in `app/src` returns only
  `services/scheduledSendSuppression.ts:1-4`. No exhaustive switch or record over
  it anywhere in `app/`, so the app half of the widening is additive.
- The one non-exhaustive per-reason table I found,
  `dashboard/src/routes/contact/ScheduledCard.test.tsx:135-141`, is a hand-listed
  three-row `cases` array, so it stays green and is correctly not an enumerator
  hit.

The gap is not the Records. It is the two equality-tested label functions -
finding 2.

**Coordinator's area 3 - "does the shared quiet formula have another consumer?"
NO. The enumeration of two tour surfaces is COMPLETE.** Every `isQuietTime`
consumer in `app/src`, classified:

- estimate surfaces: `routes/tourReminders.ts:530,562` (tour panel),
  `routes/contactTimeline.ts:1298,1306` (timeline), `routes/placementNudges.ts:385-387`
  (nudges - no `en_route` kind exists, correctly untouched).
- send/arm paths, not estimates: `jobs/tourReminders.ts:319,910` (Task 10 already
  covers `:910`), `jobs/placementNudges.ts:585`, `lib/quietHours.ts:154`
  (`clampOutOfQuietHours`, which spec 6 forbids changing).
- relay-open DEFERRAL previews, a different mechanism entirely:
  `routes/tours.ts:759,1362`, `routes/placements.ts:1177,1504`,
  `services/rosterEdits.ts:359`.

No fourth reminder-estimate surface exists. The addendum's count of three
(two tour + nudges-excluded) is right.

**Coordinator's area 1, the half that works.** P6's keep-green seam DOES hold for
the intro: `composeIntroBody`'s rewiring is byte-identical on the named-roster
branch (`jobs/relayFanOut.ts:199-206` produces the same sentence the new
`relay.intro` default embeds around `{names}`), so the shared e2e steps that
assert it stay green through Task 13 - `e2e/scenarios/steps.ts:1887`
(`/You're now connected with/` in the dashboard thread) and `expectGroupIntros`
at `:1930-1949` (the same regex in every member's fake thread). The seam breaks
only on the member-added half, which is finding 1.

Also clear: `app/test/rosterActionsPoll.test.ts:297-316` asserts only the
RECIPIENT set for the member-added fan-out (`world.sent.map((s) => s.to)`), never
the body, so it survives Task 13 despite its comment naming the join notice.

**Executability (question 3).** Task order still satisfies spec 3.2. The two
forward references the revision touched both resolve: Task 3's tests are now
self-sufficient (P16) so the Task 3-before-Task 5 order is fine, and Task 13's
cross-reference to Task 1's probe id is now stated in Task 13 step 3 rather than
only inside Task 1's code comment (P12). Green-ness between commits is intact
everywhere except the Task 13 -> Task 14 window, where findings 1 and 4 leave
`relayApi.test.ts` red and unobserved.
