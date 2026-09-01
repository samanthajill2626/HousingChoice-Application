# Reviewer B - round 3, adversarial (read-only)

Branch `feat/tour-reminder-ladder-phase-b` @ee873111. Confined to fix wave 2
(f0c57238..ee873111), read against the live tree. No Playwright, no suites run.
Every `file:line` is against the tree at @ee873111.

Counts: **BLOCKING 0, MUST-FIX 0, SHOULD 1, NOTE 2.**

All six of my R2 items are closed. The sweep's abort/continue split is correct -
I traced all three exits and could not find a path that reports a clean pass
while having written nothing. The one SHOULD is about what the e2e phone fix
stopped asserting, not about what it asserts.

---

## 1. The sweep's new failure split - traced, and it holds

The coordinator asked three specific questions. Answers, with the trace.

**Does a WRITE failure really escape the loop with the PARTIAL report?** Yes.
`app/scripts/retire-paused-tour-reminders.ts:272` catches only
`ConditionalCheckFailedException` and re-throws everything else. That throw is
inside the `for` inside the `do...while` inside `scanAndRetire`, and the outer
per-row catch that used to swallow it is GONE - the remaining try at `:234-245`
wraps `tourFor` + `planReminderRetirement` only and its catch ends in `continue`.
So the throw propagates out of `scanAndRetire` into
`retirePausedTourReminders`'s wrapper (`:143-151`), which logs the PARTIAL
counters at ERROR (`:149`) - `result` is the caller's object, mutated in place,
so the counters are real - and re-throws. Pinned empirically by
`app/test/retirePausedTourReminders.test.ts:320`, which injects a `doc` rejecting
on `UpdateCommand`, asserts the promise REJECTS, and asserts that NEITHER planned
row was stamped (i.e. it aborted rather than continuing). The counterpart at
`:348` pins that a lost conditional check still does NOT abort, so "a write
failure aborts" cannot be misread as "any write error aborts".

**Is the corrupt-row path still isolated?** Yes, and the split is placed
correctly rather than by luck. The only row-shape defect that can reach DynamoDB
with an empty Key is on the PLAN side: `tourId` is a GSI hash key
(`app/src/lib/tables.ts:429`), so DynamoDB permits a row without one, and
`tourFor(raw.tourId)` -> `toursRepo.get(undefined | '')` is what throws. I chased
the mirror hazard on the WRITE side - a row with a missing or blank `reminderId`
would make `retire()` throw a ValidationException that now ABORTS the whole run,
which the new comment's "a write failure is ... not a property of the row at all"
would have been flatly wrong about. It is unreachable: `reminderId` is the
table's hash key (`app/src/lib/tables.ts:427`, type `S`), so DynamoDB itself
guarantees every scanned row carries a non-empty string. Cleared.

**`exitCode` on each of the three exits.**

| exit | path | log | `process.exitCode` |
|---|---|---|---|
| clean | `.then` -> `reportRetirementRun` `:299` falls through | INFO `done` (`:308`) | `0` (`:320`) |
| completed with failures (`failed > 0`) | same `.then` | WARN `COMPLETED WITH FAILURES` (`:302`) | `1` |
| abort (non-conditional write error) | wrapper `:145-150` re-throws -> CLI `.catch` | ERROR PARTIAL (`:149`) then ERROR FAILED (`:325`) | `1` (`:326`) |

Correct on all three, and the exit-code rule is genuinely tested rather than
asserted in prose: `reportRetirementRun` is exported precisely so the decision
sits somewhere a test can reach, and it is exercised at
`app/test/retirePausedTourReminders.test.ts:407,410` (corrupt row -> `1`, apply
AND dry run) and `:371` (clean conditional-loss run -> `0`). The dry-run-exits-1
choice matches the adjudication text; I have no objection to it - a dry run is
where an undecidable row should surface.

## 2. The new code, cold

Nothing else to report. What I checked and cleared:

- **`let action` outside the try.** `action` is assigned only in the try at
  `:236` whose catch `continue`s, and the `if (action === 'skip') continue` at
  `:246` narrows it to `'tour_already_passed' | 'kind_retired'` before
  `result.skippedOnCondition[action]` at `:273` - which has no `skip` key.
  Sound, and the typecheck gate would have caught either half.
- **R2-S2 (`DISCONTINUED_REMINDER_KINDS.has(row.kind)`,
  `app/scripts/retire-paused-tour-reminders.ts:89`).** A corrupt row with an
  absent `kind` gives `.has(undefined)` -> `false` -> `'skip'`. No new module
  edge: the script already imported `retiredByTourStart` from the same module.
  The structural test at `app/test/retirePausedTourReminders.test.ts:92` asserts
  the SOURCE (iterates the set) rather than the membership, which is the right
  shape for a guard whose point is a future second kind.
- **R2-S1 (`startedAt <= Date.parse(nowIso)`,
  `app/src/jobs/relayFanOut.ts:410`) now matches `retiredByTourStart`'s
  `nowMs >= start`** (`app/src/jobs/tourReminders.ts:201`) exactly. The test at
  `app/test/relayFanOut.test.ts:1179` pins it from BOTH sides (at `TOUR_AT` ->
  naked; one millisecond earlier -> `tour_today`), and its cross-reference to
  "a case named 'exactly AT the tour start'" is real -
  `app/test/tourReminders.test.ts:161`. I checked every other `nowIso` fixture in
  that describe (`:1147`, `:1164`, `:1171`, `:1193`) - none straddles the
  boundary, so no sibling case changed meaning silently. I also re-checked the
  third possible answerer of "has the tour started": `armTourReminders`'s
  `past_event` drop asks a different question (does the rung LAND after the
  tour), and the D7 wait's `beforeStart = now < scheduledAt` is the exact
  complement. The "one instant, one answer" claim now holds.
- **B NOTE-4.** All three operands are instants; unparseable `now` -> `false`
  (`app/src/jobs/tourReminders.ts:199-201`); the dead `startIso` local is gone
  (zero references left in the file). Two tests
  (`app/test/tourReminders.test.ts:218,227`), the first using an offset-bearing
  `now` that text order would have decided the wrong way.
- **R2-S3 (`hasUpcoming`, `app/src/routes/tourReminders.ts:520`).** `hasUpcoming`
  has exactly one consumer (`:531`), so excluding discontinued rungs cannot lose
  anything else. No correctness change: the `discontinued` short-circuit sits
  ABOVE `suppressionOf` in the projection ladder, and a tour with a discontinued
  rung AND a live one still has `hasUpcoming === true`, so the live rung keeps
  its estimate. The test at `app/test/tourRemindersApi.test.ts:881` spies on the
  one repo call reachable ONLY through the estimate, carries a real anti-vacuity
  half (adding a live `day_before` makes the count non-zero), and restores the
  spy in a `finally`.
- **B NOTE-6 (`app/scripts`... `e2e/scenarios/steps.ts:2124`).** One private
  `expectRungsSkipped`, two named wrappers (`:2096`, `:2112`), both call sites
  unchanged. The `step()` labels are byte-identical to the previous ones for both
  verbs, so no e2e trace text moved.
- **R2-S4's docblock sentence** landed at
  `dashboard/src/routes/tours/RemindersPanel.tsx:69-73`, stating the
  rendering-vs-wire-union distinction. That closes my R2 NOTE-2 as a RECORD.

## 3. SHOULD

### S-R3-1 - the placement e2e now asserts two hardcoded threads and nothing about membership, so "every member's fake thread must be asserted" rests on a prose comment

**Claim.** The fix deleted `rosterPhones` (correctly - it read a field the wire
shape does not serve) and replaced it with a literal two-element loop. What is
asserted per member is now strong: each of the two minted phones must receive the
byte-exact preview body FROM the group's pool number. What is gone is the
completeness half - nothing checks that those two ARE the roster. The ruling's
words were "Every member's fake thread must be asserted"; that is now carried by
a comment rather than an assertion.

**Evidence.**
- `e2e/tests/relay-intro-variants.spec.ts:357` -
  `for (const phone of [tenant.phone, owner.phone])`.
- `e2e/tests/relay-intro-variants.spec.ts:355-356` - the claim in prose: "The
  placement's default roster is the tenant plus the unit's landlord-of-record,
  so these two ARE every member."
- I verified the claim is TRUE for this fixture:
  `createAvailableUnit` (`e2e/tests/relay-intro-variants.spec.ts:84-106`) creates
  a unit with `landlordId` and no unit contacts, so `unitContacts` falls back to
  the synthetic single landlord row (`app/src/repos/unitsRepo.ts:300`) and the
  default roster is exactly {tenant, landlord}. So the walk is correct TODAY -
  it is fixture-dependent and unasserted, not wrong.
- The exposure: add a PM to the placement default roster (the tour walk in the
  same file already puts one on the property), and this walk stays green while a
  member's leg goes unasserted - the same silence the deleted helper produced,
  arrived at from the other direction.

**Why not MUST-FIX.** The substance of A-M2 - the previewed copy reaching every
member's phone from the masked number - is genuinely proven for both real
members. This is a latent coverage hole, not a product defect, and the tour walk
has the same shape.

**Proposed fix (one line, using a field the route DOES serve).** After the open:
```
const { members } = await (await req.get(`${NEXT}${ownerPath}/roster`)).json();
expect(members.map((m) => m.phoneLast4).sort())
  .toEqual([tenant.phone.slice(-4), owner.phone.slice(-4)].sort());
```
`RosterMemberView.phoneLast4` (`app/src/lib/rosterResolution.ts:352`) is exactly
what that shape exposes, so this restores "the server names its own members"
without re-introducing the impossible read. Keep the minted-phone loop as-is.

## 4. NOTE

- **N-R3-1 - R2-S2 generalized the code and left the literal in both prose
  descriptions of the same rule.** `app/scripts/retire-paused-tour-reminders.ts:22`
  still opens population B with "every pending `confirmation`, regardless of tour
  date", and `RUNBOOK.md:292` says "**`kind_retired`** - every pending
  `confirmation`." Both are true today (the set holds exactly that kind) and both
  are the drift R2-S2 was raised about, now living one layer up: discontinue a
  second kind and the code sweeps it while the header and the operator's runbook
  say it does not. Two words each - "every pending rung of a DISCONTINUED kind
  (`DISCONTINUED_REMINDER_KINDS`, today: `confirmation`)".
- **N-R3-2 - `overdue` is the one `'upcoming'` predicate still counting a
  discontinued rung, and that is fine.** Three of the four were fixed across the
  two waves (`next` by B-MF2, `nextReminderRefetchDelay` by B-S2, `hasUpcoming` by
  R2-S3); `overdue = state === 'upcoming' && dueAt < now`
  (`app/src/routes/tourReminders.ts:352` and the list twin) still sets
  `overdue: true` on a past-due discontinued rung. Harmless and already pinned -
  every renderer short-circuits on `discontinued` first (the panel chip order,
  and `RemindersPanel.test.tsx`'s "a discontinued rung that is ALSO overdue still
  reads 'No longer sent'"). Recorded ONLY so the next reader who greps for the
  other three fixes does not file the fourth as an oversight; `overdue` is
  additive by design and its combination with `discontinued` is tested.

## 5. B NOTE-3's RECORD ruling - not contested

Agreed, and I want that on the record rather than passed over in silence. Closing
it honestly means moving the persisted-body decision below the roster loop in
`sendRelayAnnouncement`, which inverts its persist-before-send order - and that
order is load-bearing for the live-surface events and the delivery-slot seeding
(`app/src/services/relayAnnouncements.ts`). Trading a documented ordering
invariant for a sub-second copy race on a message nobody reads twice is a worse
deal than the residual. The handback NOTE is the right home.

## 6. Verdicts on my R2 items

| id | verdict | evidence |
|---|---|---|
| MF-R2-1 | **CLOSED** | The impossible read and its `as` cast are deleted; both members' fake threads are asserted byte-exact from the pool number (`e2e/tests/relay-intro-variants.spec.ts:357-359`). Residual is S-R3-1, which is a different (weaker) finding, not the same one. |
| MF-R2-2 | **CLOSED, all three parts** | Traced above: (a) plan-side isolation `:234-245`, (b) write-side abort `:272` reaching the PARTIAL wrapper `:143-151`, (c) `failed > 0` -> WARN + exit 1 `:299-309`. Three tests, covering both classes and the conditional-check boundary between them. The PARTIAL report is genuinely re-armed - the write path is what reaches it. |
| NOTE-1 | **CLOSED** (comment) | `app/src/jobs/relayFanOut.ts:353-359` scopes the guard to precedence 2-4, states the "a human chose it" rationale, and names the one reachable case (a `connecting` group straddling the start). |
| NOTE-4 | **CLOSED** | `app/src/jobs/tourReminders.ts:199-201`; `startIso` removed; two tests. |
| NOTE-5 | **CLOSED** (comment) | `app/src/jobs/relayFanOut.ts:403-408` names the fail-OPEN and why a never-throw resolver takes that direction. |
| NOTE-6 | **CLOSED** | `e2e/scenarios/steps.ts:2124`; wrappers at `:2096`/`:2112`; call sites and step labels unchanged. |
| NOTE-2 (R2-S4, RECORD) | **DONE** | `dashboard/src/routes/tours/RemindersPanel.tsx:69-73`. |
| NOTE-3 | **accepted residual** | Not contested - see section 5. |
