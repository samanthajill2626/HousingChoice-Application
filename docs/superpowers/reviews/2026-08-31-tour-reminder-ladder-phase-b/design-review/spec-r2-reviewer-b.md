# Spec R2 - adversarial design review (reviewer B, continued)

Spec under review:
`docs/superpowers/specs/2026-08-31-tour-reminder-ladder-phase-b-design.md` @`e272784f`
Diff reviewed: `7fc744a8..e272784f`. Repo read at `e272784f`; base `main` @`ec32170a`.
Prior round: `spec-r1-reviewer-b.md` (mine), `spec-r1-reviewer-a.md`,
`adjudications.md`.

The revision is a real improvement - M1, M3, M5, M6, M11, M12 are properly fixed
and I re-checked each. This report is almost entirely NEW findings, concentrated
on the two mechanisms invented during adjudication: the widened supersession
predicate (6.2) and the permanent `confirmation` entry in
`MANUAL_ONLY_REMINDER_KINDS` (3.1). Both are live send-path changes and neither
had a second reader.

Section 2 decisions are taken as settled throughout.

---

## 1. [BLOCKING] The FIRE-TIME half of the `en_route` exemption is unbounded in a way the arm-time half is not - a worker outage now texts the whole `en_route` backlog at whatever hour the worker returns

**Spec:** section 6, item 2 - "Fire-time backstop (the `isQuietTime(now, window)`
branch at `app/src/jobs/tourReminders.ts:910`): `en_route` is not deferred."
Section 6.1's "There is no floor" note addresses only the ARM-time consequence
(`scheduledAt - 1h`, so a 04:00 tour texts at 03:00).

**What is wrong.** The two sites do not serve the same population, and the spec
treats them as symmetric ("one without the other reopens the hole"). The
fire-time backstop's own docblock says what it is for:

`app/src/jobs/tourReminders.ts:904-909`

```
// QUIET-HOURS BACKSTOP (spec section 6), PRE-CLAIM. Normal rows are clamped
// at arm time, so this only fires for legacy rows and worker-downtime
// catch-up. Returning WITHOUT claiming leaves the row in listDue - it
// re-fires within one poll tick of quiet-end.
```

So exempting `en_route` at `:910` changes behaviour for exactly two populations,
and in BOTH of them the rung's dueAt was never chosen with the exemption in mind:

1. **Legacy rows** - pre-quiet-hours rows carrying an unclamped 04:00-UTC dueAt.
   These now fire at 04:00 instead of being held to quiet-end.
2. **Worker-downtime catch-up** - the one the docblock names first. Worker down
   21:00 to 06:00; at 06:00 `listDue('06:00')` returns the backlog; today
   `isQuietTime('06:00', window)` is true for the default 21:00-08:00 window
   (`app/src/lib/quietHours.ts:143-145`) and EVERYTHING waits until 08:00. With
   the exemption, every `en_route` in that backlog sends at 06:00.

At arm time an exempt `en_route` is bounded by construction: its dueAt is
`scheduledAt - 1h` (`app/src/jobs/tourReminders.ts:145-152`), so the worst case
is a text one hour before a tour, which is what Sam approved. At fire time
`now` is NOT bounded by the tour at all, and there is no gate that stops it:

I read `processReminderRow` (`:861-1109`) and `sendGroupReminder` (`:1180-1248`)
end to end. The pre-claim gates are `supersededInBatch` (`:888-902`),
`isQuietTime` (`:910-916`), target resolution (`:922-935`), the D7 pending-open
wait (`:952-964`, itself bounded BY TOUR START), the roster gate (`:976-1005`),
and compose (`:1025-1045`). **There is no "the tour has already happened" check
anywhere on the fire path.** `past_event` is arm-time only
(`app/src/repos/tourRemindersRepo.ts:47-50`). And nothing supersedes `en_route`:
it is the last rung in `REMINDER_KINDS`, and `no_show_checkin` is never armed.

So after a nine-hour outage, an `en_route` for a tour that ended last night sends
"she is headed that way shortly" at 06:00. The quiet-hours backstop was the only
thing standing between that backlog and a tenant's phone, and section 6 removes
it for the rung whose copy is the most time-sensitive in the ladder.

Section 4's sweep does not help: it is a one-time human run at unpause. The next
outage after it has no sweep behind it.

**Implies.** This is the single worst outcome in the spec and it is undecided.
The exemption needs a fire-time floor that the arm-time half gets for free - the
obvious one is "exempt `en_route` from quiet hours only while `now` is still
before `scheduledAt`", which delivers exactly what Sam approved (the 7am text for
the 8am tour) and delivers nothing else. Section 6 must rule, and section 6.1's
"no floor" note must say which floor it is talking about.

---

## 2. [BLOCKING] Section 3.1's guarantee is false on the human path, and the panel actively invites the operator to break it

**Spec:** section 3.1 - "With it, **no `confirmation` row fires** regardless of
when or by what code path it was armed". D1 - "Confirmation reminders are gone
entirely - not armed, not sent."

**What is wrong.** `MANUAL_ONLY_REMINDER_KINDS` gates ONE path. I read
`forceSendReminder` in full (`app/src/jobs/tourReminders.ts:1364-1549`): it
never reads `manualOnlyKinds` or `MANUAL_ONLY_REMINDER_KINDS`. The filter exists
only in the poll, at `:602-603`. That is by design and documented - the whole
point of the 2026-08-20 pause was that Send now keeps working
(`:589-596`) - but section 3.1 reuses that mechanism for a PERMANENT
discontinuation and inherits the escape hatch with it.

Worse, the panel tells the operator to use it. With the set reduced to
`{confirmation}`:

`app/src/routes/tourReminders.ts:589-597`

```
const paused = manualOnlyKinds.has(row.kind);
const suppression = state !== 'upcoming' ? undefined
  : suppressionOf !== undefined ? suppressionOf(row.dueAt, paused)
  : paused ? ({ reason: 'paused' } as const) : undefined;
```

`REMINDER_SUPPRESSION_LABELS.paused` is `'send manually'`
(`dashboard/src/api/types.ts:1267`), rendered by `RemindersPanel.tsx:114-118` as
the chip "Paused" over the note "Paused - send manually". So a pending
`confirmation` rung - a kind the spec says is GONE - displays as a working,
sendable rung with an instruction to send it by hand, and the Send now button
behind it works.

**Which rows reach that state?** Exactly the residue section 3.1 invented the
guard for: rows armed by the old deployed binary between the human's sweep and
the human's deploy (section 3.2). The sweep by construction ran before them, and
no second sweep is scheduled. They sit pending forever with a lying chip.

The copy is also wrong on its own terms. "Paused" and "send manually" were
written for a TEMPORARY hold-back (`app/src/jobs/tourReminders.ts:174-200`,
"do-not-remove-without-reading - FOUNDER DECISION, 2026-08-20, TEMPORARY"). The
same two surfaces render it for the third reader too:
`app/src/routes/contactTimeline.ts:1091` feeds `manualOnlyReminderKinds` into
the contact page's Upcoming bucket, and `app/src/routes/api.ts:938` threads the
override.

**Implies.** Reusing the pause set as a discontinuation guard is defensible;
inheriting its human escape hatch and its "send manually" copy is not. Section
3.1 must either (a) add a `confirmation` refusal to `forceSendReminder` and give
the panel a distinct chip, or (b) drop the "no confirmation row fires" claim and
say plainly that a human can still send one. Do not leave a builder to discover
that D1 and section 3.1 disagree with the code.

---

## 3. [HIGH] Section 10 still instructs the builder to delete the dev-tick override on a premise section 3.1 deleted

**Spec:** section 10, closing paragraph (unchanged from R1) - "Honour it: with
`MANUAL_ONLY_REMINDER_KINDS` **empty** the `manualOnlyKinds: new Set()` override
and its comment both go."

Section 3.1 - "**So `MANUAL_ONLY_REMINDER_KINDS` is NOT emptied.**"

**What is wrong.** These are the same paragraph of send-path configuration
described two incompatible ways in one document. The override is real
(`app/src/routes/dev.ts:404-421`) and its comment says "Delete this when the
hold-back is lifted; do not leave a permanent dev/prod fork." Under 3.1 the
hold-back is not lifted - it becomes permanent for one kind. Deleting the
override is arguably still right (it makes the e2e tick match prod for
`confirmation`), but the spec's stated REASON for deleting it is now false, and a
builder who notices the contradiction has no way to resolve it from the document.

This is an M4 remedy that was not propagated. Section 12's item-2 row WAS
updated ("The set is NOT emptied"); section 10 was not.

**Implies.** One of the two paragraphs is wrong. Say which, and re-derive the
dev-tick decision from 3.1's actual design rather than from the deleted premise.

---

## 4. [HIGH] The relay copy change has NO inventory, and the existing parity assertions are tripwires written for exactly this edit

M9 required a derived three-way inventory - but scoped it to `confirmation`
only (section 10). The relay half of the mission changes `relay.intro`'s
declared token, its composed output for tour- and placement-owned groups, and
`relay.member_added` entirely, and section 14 treats the existing suites as
passive coverage ("The existing 'no dead tokens' and label-completeness tests
cover the new entries"). They are not passive. Sites I opened:

**(a) `app/test/messages/catalog.test.ts:66-69` THROWS after the rename.**

```
expect(
  resolveMessage('relay.intro', { members: 'M.' }, { 'relay.intro': 'OVERRIDDEN' }),
).toBe(MESSAGE_CATALOG['relay.intro'].default.replace('{members}', 'M.'));
```

After 9.2 the default declares `names` and contains `{names}`. `relay.intro` is
non-editable so the override is ignored and `strict` is true, and a declared
token present in the template with no value THROWS
(`app/src/messages/resolve.ts:35-38`). This is the test that pins the
editable-flag invariant; it does not merely fail, it errors.

**(b) `e2e/tests/tour-roster.spec.ts:252-269` is a tripwire written for this
exact change.** It splits the catalog default on the LITERAL `'{members}'` and
asserts both halves are non-empty, with this failure message:

```
expect(
  introTail.length,
  'the relay.intro default has no copy AFTER {members} - endsWith below proves nothing',
).toBeGreaterThan(0);
```

and the comment above it: "An empty tail is also what 'the default lost its
`{members}` token entirely' looks like (split returns the whole string as the
head)." The rename produces precisely that. The same block then does
`startsWith(introHead)` / `endsWith(introTail)` against a **TOUR** preview
(`/api/tours/${tourId}/roster/preview-open`, `:248`), so 9.0's ruling breaks it a
second, independent time.

**(c) `e2e/scenarios/steps.ts:1887` and `:1930-1949`** both assert
`/You're now connected with/` - the first in the dashboard thread, the second
(`expectGroupIntros`) in EVERY member's fake thread, together with "every member
first name appears". Under 9.1 a tour- or placement-owned group's intro contains
neither the phrase nor the member list. These are shared steps, so every tour and
placement relay spec that calls them breaks.

**(d) Unit/route parity pins.** `app/test/toursApi.test.ts:3989-3998`
("preview-open returns the SERVER-composed intro body the fan-out will send",
asserted as `composeIntroBody(['Tina Tenant','Pat Manager'])`), `:4096`;
`app/test/placementsApi.test.ts:989`, `:1007`;
`app/test/relayGroupPreview.test.ts:151`, `:208`;
`app/test/relayFanOut.test.ts:703-716` (`composeMemberAddedBody` copy).

**Implies.** M9's "a count is not an inventory" applies with equal force to the
relay half and the spec does not say so. Section 10's requirement must be
extended, or section 9 must carry its own enumerated inventory. As written, the
plan will budget for the `confirmation` conversion and be surprised by this one.

---

## 5. [HIGH] Section 9.3's shared resolver cannot serve the OPEN preview - it is called before the conversation exists

**Spec:** section 9.3 - "one exported async resolver - **conversation** ->
`getOwner` -> tour or placement -> ... all four call sites in 9.0 go through it,
so the preview cannot drift from the job by construction rather than by
discipline."

**What is wrong.** Two of the four call sites have no conversation to pass.

`app/src/services/rosterEdits.ts:508` (`buildOpenPreview`) takes
`(deps: RosterResolutionDeps, owner: RosterOwner, ...)` - a `RosterOwner`, not a
conversation - and there is a SECOND builder feeding the same helper
(`buildOpenPreviewFromParts` is called at `:540` and `:630`). Its callers are
`app/src/routes/tours.ts:936`, `app/src/routes/placements.ts:1262`, and the
standalone path. The route is a PRE-provisioning preview: `tour-roster.spec.ts:247`
records that "preview-open 409s `relay_already_provisioned` once a thread exists",
so by construction there is no `ConversationItem` and `getOwner(conv)` cannot be
called.

The `intro_body` the operator edits is stored on that same pre-provisioning call
(`app/src/repos/conversationsRepo.ts:1902`), so this is not a corner: it is the
main authoring path for precedence rule 1.

**Implies.** The resolver must take the OWNER (`{type,id}`), not the
conversation, with the JOB doing `getOwner(conv)` above it and the preview
passing its `RosterOwner` straight through. That is a one-line change to 9.3 and
it is the difference between "cannot drift by construction" and a shared function
two of four callers cannot call.

---

## 6. [HIGH] `{name}` on `relay.member_added` has the identical totality hole M12 just fixed for `{names}`, and it is a live crash

**Spec:** 9.4 - "`{name}` is the FIRST name, matching the 2026-08-20 decision and
the name list." 9.2a declares `relay.member_added` `vars: ['name']`,
`editable: false`.

**What is wrong.** The current composer has an explicit nameless-member fallback
that the new copy discards:

`app/src/jobs/relayFanOut.ts:222,250-262`

```
/** Neutral joined label when the added member has no resolved name (never a phone). */
const ANONYMOUS_JOINED_LABEL = 'A new member';
...
const who = newMemberName && newMemberName.trim().length > 0
  ? firstNameOnly(newMemberName)
  : ANONYMOUS_JOINED_LABEL;
```

The nameless case is reachable on both callers: the job passes `added?.name`
from a roster participant (`:683-686`), and `buildAddPreview` passes
`candidate.name`, which is optional on `RosterCandidate`
(`app/src/services/rosterEdits.ts:640-646`). A relay member can be a bare phone
with no contact row - that is what `ANONYMOUS_JOINED_LABEL` exists for, and its
comment says "never a phone".

Under 9.4, `{name}` with no value in a strict non-editable DEFAULT does not
degrade - it THROWS (`app/src/messages/resolve.ts:35-38`). Section 9.2 solved
exactly this for `{names}` ("`{names}` is TOTAL - it never returns the empty
string", with a four-row table) and did not generalize the rule one entry over.

Consequence: the member-added JOB throws (a failing handler, redelivered against
a `putJobExecutionMarker` that has already been claimed at `:678-684`, so the
announcement is lost, not retried), and the add-preview route 500s.

**Implies.** Give `{name}` the same totality rule and the same table row, and say
what the neutral phrase is - "A new member" reads correctly in Sam's sentence
("Hey, adding A new member to the group") only if it is lower-cased to "a new
member". That is a copy decision, not a builder's guess.

---

## 7. [MEDIUM] Section 8.2's implementation note is wrong on all three paths it covers

**Spec:** 8.2 - "`viewOf` is sync and takes its body from the handler; `overdue`
needs only `row.dueAt` and a `now`, so the handler passes **the same `nowIso` it
already computes**. No new I/O on either path."

**What is wrong.** No handler computes one it can pass.

- The GET list handler's `nowIso` is declared at
  `app/src/routes/tourReminders.ts:529`, INSIDE
  `if (tour.tourType === 'self_guided' && hasUpcoming) {` (`:506`). The view map
  begins at `:575`, outside that block. It must be hoisted. Reviewer A found this
  in R1 (their #5, "Minor mechanical detail"); the remedy text re-asserts it as
  though it were true.
- The PATCH handler (`:353-408`) computes no `now`: it inlines
  `new Date().toISOString()` into the `cancel` call at `:374` and nothing else.
- The send-now handler (`:421-472`) likewise inlines it at `:440`.

The conclusion ("no new I/O") is right, and the fix is trivial. But this is the
third time this spec has asserted a mechanism that is not in the file, and the
adjudication treated the citation-accuracy problem as closed (M18).

---

## 8. [MEDIUM] Section 4.2's population-B rationale contradicts section 3.1

**Spec:** 4.2 still reads - "Population B ... an in-flight confirmation for a
FUTURE tour would otherwise survive both the sweep and the kind removal and
**fire on the first tick after unpause**."

3.1 - "no `confirmation` row fires regardless of when or by what code path it was
armed ... the sweep becomes panel cleanup rather than a deadline."

**What is wrong.** 3.1's guard makes 4.2's stated justification false. Population
B is still worth doing - as panel cleanup, which is 3.1's own word - but its
rationale was not rewritten when the design changed underneath it. A reader who
starts at section 4 comes away believing the guard is not there; a reader who
starts at section 3 wonders why population B exists at all. The spec's whole
value here is being the one place the send-side story is coherent.

---

## 9. [MEDIUM] The ruled predicate `otherDue <= dueAt` does not typecheck, and the guard it needs is a behavioural decision

**Spec:** 6.2 - "RULED: generalize the predicate from equality to
`otherDue <= dueAt`."

**What is wrong.** `dues` is a `Map<ReminderKind, string>`
(`app/src/jobs/tourReminders.ts:302`), so `dues.get(other)` is
`string | undefined`. Equality tolerates that - `undefined === dueAt` is a valid
comparison and safely false. `undefined <= dueAt` is a TypeScript error
(possibly-undefined operand), so the builder MUST add a guard, and the polarity
is load-bearing: a missing entry must NOT supersede.

Today it happens to be unreachable (Pass 1 fills `dues` for every kind in
`REMINDER_KINDS` at `:303-307` and `supersededBySlot` iterates the same list at
`:412`), so the guard is defensive. But the spec states a one-token change to a
line that will not compile as written, on the mission's only rule change.

---

## 10. [MEDIUM] The widening falsifies the `LADDER_ORDER` docblock - which is the exact text a future reader will use to "fix" the predicate back

**Spec:** 6.2 rules the widening; 3.1 correctly instructs rewriting the
`MANUAL_ONLY_REMINDER_KINDS` docblock. Nothing is said about this one:

`app/src/jobs/tourReminders.ts:158-164`

```
/**
 * Ladder order by proximity to the event. Supersession keeps the LATEST rung of
 * a colliding pair: clamping can only push an EARLIER rung forward onto a later
 * one's slot, and when it does, the earlier rung's copy is the stale one
 * ("your tour is tomorrow" landing on tour day). Exported for the fire-time
 * backstop's batch check.
 */
```

Both sentences become false. "Supersession keeps the LATEST rung of a colliding
pair" - after the exemption it keeps the ladder-later rung, which in the 08:30
case is the chronologically EARLIER one (07:30 `en_route` survives, 08:00
`morning_of` is retired). "Clamping can only push an EARLIER rung forward onto a
later one's slot" - clamping is no longer the only thing that moves a rung
relative to the ladder; the exemption is.

This is the same class as `app/src/messages/tourCopy.ts:135-137` ("Phase B
disposes of both entries"), which R1 flagged and which section 5 supersedes but
still does not instruct correcting. Here the stakes are higher: this docblock is
the stated justification for the predicate, so a reader who trusts it will read
the widened comparison as a bug.

---

## 11. [MEDIUM] Section 10 keeps the sentences M9 and M10 were accepted to remove

The revision ADDED the three-way inventory requirement and the clock-travel
warning, and left the contradicted text standing beside them:

- `:775` still reads "The sites convert **mechanically**." Reviewer A's #7 asked
  for that word specifically; M9 accepted the finding. Six lines later `:781`
  says "A clock-travel tick is NOT behaviour-neutral, and the converted specs
  must expect that."
- `:770` still reads "Those **~40 sites** test the SEND path" - the ledger count
  that `:744-745` now describes as "the ledger's counts, which this spec
  inherited without re-deriving and which are materially incomplete."
- `:778-779` still gives the OLD residual-risk statement ("the residual risk of
  clock-travel ticks is that a future `now` also fires seeded rows") immediately
  above the paragraph that identifies the real one.

A builder reading top-to-bottom hits the superseded claim first. Delete rather
than append.

---

## 12. [LOW] M18's "all citations re-derived against the worktree" was not executed

Four survive, three of them named in R1:

- 7.2: "`names_unavailable` ALREADY exists in the force-send REFUSAL union
  (`app/src/jobs/tourReminders.ts:1478`)". The union member is declared at
  `:1328`; `:1478` is a use site. (Reviewer A had this right in their
  "Claims that HOLD".)
- 9.6: "`sendRelayAnnouncement` (`app/src/services/relayAnnouncements.ts:190-294`)".
  The function opens at `:147`.
- 10: "`e2e/scenarios/steps.ts:2033-2046`". The `armedReminderDueAt` /
  `tickTourReminders` pair spans `:2013-2046`.
- 4.3 site 2: "the dashboard wire union - `dashboard/src/api/types.ts:1191`
  (`TourReminderView`)". `:1191` opens the interface; the `skipReason` union is
  `:1207-1223`. 8.1 uses the same `:1191` for a different field, which is fine
  there and misleading here.

---

## 13. [LOW] 9.2a's metadata table omits the `MessageId` union

Five new ids need a line in `app/src/messages/catalog.ts:40-70` before they can
be keys in `MESSAGE_CATALOG`. The compiler catches it, but 9.2a presents itself
as the complete "so a builder does not guess" table and every other constraint on
it is listed.

---

## 14. [LOW] M8: I concede the remedy rejection, and note one sequencing consequence

**Conceded.** The adjudication rejected inventing sender-identity copy for Sam.
My R1 finding never asked for that - it asked for "an explicit ruling and a
founder handback line (section 15), the way section 6.1 got one", and 9.1's "Two
notes on the founder copy" plus section 15 item 2 is exactly that. Correctly
disposed.

**One observation, not a re-argument.** Section 15 item 2 says "Her copy ships as
written unless she says otherwise." Section 3.2 already has a human-gated deploy
step between merge and any tenant seeing this copy. So the question can be
answered BEFORE first contact rather than after, at no cost to the schedule. If
the intent is genuinely "ship and ask", that is a decision worth stating; if it
is an accident of where the item was filed, moving it ahead of step 3 is free.

---

## Answers to the three questions asked about the widened predicate

Checked directly, because the adjudication reasoned about them alone.

**Does `otherDue <= dueAt` hurt `day_before`?** No. I could not construct a case
where the widening retires a `day_before` that equality did not. `day_before`'s
anchor is 19:30 on the day BEFORE the tour's local date
(`app/src/jobs/tourReminders.ts:128-138`), and `morning_of` / `en_route` are
`scheduledAt - 4h` / `- 1h` on the tour day. For `morning_of` to precede
`day_before` you would need `scheduledAt - 4h < 19:30 (prev day)`, i.e.
`scheduledAt < 23:30 (prev day)` - impossible, since `scheduledAt` is on the tour
date. When `day_before` DOES clamp forward onto the tour morning it lands on the
window END, which is where `morning_of` clamps too, so equality already fired -
and `staleDayBefore` (`:418-419`) retires it independently in every one of those
cases anyway.

**Does a `quietHoursStart` of '19:00' break it?** No. With start 19:00 the 19:30
anchor is inside the window, so `day_before` clamps with `bumpDay = 1`
(`app/src/lib/quietHours.ts:160`) onto the TOUR day's window end. `staleDayBefore`
then retires it 100% of the time - which is exactly what the existing warn at
`:318-329` predicts and names. The widened predicate reaches the same verdict by
a second route; the outcome is unchanged.

**Does `no_show_checkin` cause trouble?** No, at either site. At arm time
`supersededBySlot` iterates `REMINDER_KINDS` (`:412`), which excludes it
(`:231-240`), so it can never be a superseder there despite its `LADDER_ORDER`
index of 4. At fire time `supersededInBatch` iterates the actual batch, so it
would only matter if a PENDING `no_show_checkin` row could be due - and none can
be: nothing arms it, the draft route composes on the fly
(`app/src/routes/tourReminders.ts:657-703`), and the one seed that writes such a
row writes it SENT (`app/src/lib/seed/matrix.ts:884`, "no_show adds a **sent**
no_show_checkin at scheduledAt + 30m"; `:1044` confirms a no-show tour otherwise
carries none). `listDue` filters `sentAt` (`app/src/repos/tourRemindersRepo.ts:220-221`).

**Does keeping `confirmation` in the manual-only set break the batch feed?** No,
and this is worth recording because the code anticipated it. The comment at
`app/src/jobs/tourReminders.ts:596-601` warns that the manual-only-FILTERED array
is what feeds `supersededInBatch`, and that this "matters on a PARTIAL restore" -
which is now what this is. It is benign here: `confirmation` is index 0 in
`LADDER_ORDER`, the earliest, so it can only ever be the SUPERSEDED rung, never a
superseder. Filtering it out of `dueRows` therefore removes nothing from any
other rung's calculation. Say so in the spec so the next reader does not
re-derive it.

---

## Round-1 findings I re-checked as properly closed

- **B1 / M2** - the widening is sound in the direction it was ruled. I verified
  6.2's regression claim ("on an unclamped ladder the rungs are strictly
  increasing, so the widened predicate is false for every pair"): it holds, and
  more strongly than stated. Clamping only ever moves a dueAt LATER
  (`clampOutOfQuietHours`, `app/src/lib/quietHours.ts:153-163`), so a
  ladder-later rung can only land strictly BEFORE an earlier one if it is the
  exempt `en_route`. The widening therefore adds behaviour in exemption-affected
  cases and nowhere else. In-flight rows armed by the old code are also safe: on
  those the equality already fired and `morning_of` was born skipped, so no
  double-send is carried over.
- **B3 / M1** - both sites named by line in the 7.0 table, invented symbol gone.
- **B2, B5a / M3** - 9.0's call-site table and the preview ruling are right, and
  the `buildAddPreview` docblock correction is called out. Finding 5 above is
  about the resolver's SIGNATURE, not the ruling.
- **B7 / M6** - four sites per token, three tokens, false safety-net claim
  deleted. Correct.
- **B8 / M5** - both `TourReminderView` builders now in scope with an explicit
  exclusion table for the other two renderers. Correct; finding 7 is about the
  note attached to it.
- **B11 / M11** - the function-replacement mandate and the `$&`/`$1` regression
  are exactly right.
- **B12 / M12** - the `{names}` totality table is correct and complete for that
  token. Finding 6 is that its rule was not generalized to `{name}`.
- **B10 / M10**, **B13 / M16**, **B14 / M15**, **B16 / M17** - all properly
  incorporated. 9.2a's `vars` lists check out against
  `app/test/messages/catalog.test.ts:35-41` and `:43-52`: every declared token
  appears in its default and no default carries an undeclared one, and the
  `{time}` / `{when}` split across the two tour variants is what makes that true.
