# Plan review R1 - reviewer B (adversarial)

Target: `docs/superpowers/plans/2026-08-31-tour-reminder-ladder-phase-b.md`
Against: `docs/superpowers/specs/2026-08-31-tour-reminder-ladder-phase-b-design.md`
Question answered: if a builder with NO context executes this plan LITERALLY, do
they produce the spec?

Every claim about existing behaviour below cites a file:line I opened in this
review. Anything I could not verify is marked UNVERIFIED.

---

## 1. [BLOCKING] The contact timeline's RENDERER never learns `discontinued` - the fourth unenumerated reader

**What is wrong.** Spec 3.1 makes `routes/contactTimeline.ts` the fourth
discontinued surface and calls it "the one that would have been missed". Plan
Task 8 duly makes the SERVER emit `{ reason: 'discontinued' }` there. It stops
at the wire. The client that renders that bucket is never touched.

**Evidence.**

- `dashboard/src/routes/contact/ScheduledCard.tsx:19-33` declares
  `const SUPPRESSION_COPY: Readonly<Record<NonNullable<TimelineScheduled['suppression']>['reason'], string>>`
  with exactly six keys. `ScheduledSuppression.reason` is the SHARED union
  (`dashboard/src/api/types.ts:1144-1155`), so Task 8's `| 'discontinued'`
  widening is a COMPILE ERROR here, not just a missing label.
- `ScheduledCard.tsx:57`:
  `if (item.suppression?.reason === 'paused') return 'Paused';` - the ONLY
  special case. Every other reason falls through to `fireTimeLabel`
  (`:41-46`), which renders `sending shortly` or `sends in Nh`.
- `ScheduledCard.tsx:48-51`'s own docblock states the rule this breaks: "Every
  string this line can carry is a PROMISE that the message goes out at a time."
- Plan Task 8's file list names only `dashboard/src/api/types.ts`,
  `RemindersPanel.tsx` and `DeadlinesNudgesCard.tsx:64`. `ScheduledCard.tsx`
  appears nowhere in the plan.

**What it implies.** Executed as written, a pending `confirmation` on a future
tour renders on the contact page as "sends in 3 days" or "sending shortly" - the
perpetual-"sending shortly" lie that spec 3.1 says the timeline read exists to
end, one surface further out. The compile error means the builder WILL touch the
file, so they will invent the copy and the branch with no direction from the
plan; and every plan-anchored reviewer downstream inherits an enumeration that
says three dashboard files when it is four.

Note the standing hazard the spec itself records (3.1: "this review caught an
unenumerated READER three separate times"). This is the fourth.

## 2. [BLOCKING] The send-now "per-reason 409 mapping" Tasks 3 and 7 are told to extend does not exist, and the cited lines are a different route

**What is wrong.** Plan Task 3 step 6, final paragraph: "In
`routes/tourReminders.ts`, extend the send-now refusal mapping (the per-reason
409 handling around `:654-690`) with `tour_already_passed` following the
`names_unavailable` pattern exactly (`res.status(409).json({ error:
'tour_already_passed' })`)." Task 7 step 2 repeats it for `kind_retired`. The
plan's file table also lists `app/src/routes/tourReminders.ts` under "Tasks 3,
8, 12: refusal wiring".

**Evidence.**

- The send-now handler is `app/src/routes/tourReminders.ts:421-472`. Its refusal
  branch is a single pass-through, `:465`:
  `const error = result.outcome === 'not_pending' ? 'reminder_not_pending' : result.reason;`
  then `:471` `res.status(409).json({ error, reminder: viewOf(after, afterBody) })`.
  There is NO per-reason mapping to extend; every `ForceSendRefusal` member
  already reaches the wire verbatim.
- `:654-690` is a different endpoint entirely:
  `router.get('/:tourId/no-show-checkin-draft', ...)` begins at `:661`, and the
  `res.status(409).json({ error: 'names_unavailable' })` at `:688` is that
  route's OWN refusal - the "names_unavailable pattern" the plan points at.

**What it implies.** A literal executor either adds dead code, or (worse) adds a
`tour_already_passed` / `kind_retired` branch into the no-show-checkin-draft
handler, where neither token can ever arise. The actual required work - nothing
on the route, plus the `SEND_NOW_ERROR_COPY` entries, which Task 2 does cover -
is obscured by an instruction written from a misread of the file.

## 3. [HIGH] `REMINDER_SUPPRESSION_LABELS` is a second exhaustive Record on the widened union and is absent from the plan

**What is wrong.** Spec 3.1a enumerates the consumers of the widened
`ScheduledSuppressionReason` and names exactly one exhaustive record
(`DeadlinesNudgesCard.tsx:64`). Plan Task 8 inherits that count. There are
THREE.

**Evidence.** `grep -rn "Record<NonNullable\|Record<ScheduledSuppressionReason" dashboard/src app/src`:

| site | what it is |
|---|---|
| `dashboard/src/api/types.ts:1259-1268` `REMINDER_SUPPRESSION_LABELS` | the TOUR PANEL's label map - not named in spec or plan |
| `dashboard/src/routes/contact/ScheduledCard.tsx:19-33` `SUPPRESSION_COPY` | finding 1 |
| `dashboard/src/routes/placements/DeadlinesNudgesCard.tsx:64` `NUDGE_SUPPRESSION_LABELS` | the one the spec names |

`dashboard/src/routes/tours/RemindersPanel.tsx:318` renders through
`REMINDER_SUPPRESSION_LABELS[rung.suppression.reason] ?? rung.suppression.reason`,
so this is the map that produces Task 8's required "No longer sent" chip text on
the tour panel.

**What it implies.** `npm run typecheck` blocks the branch until the builder adds
an entry, so the failure is loud - but the plan supplies no copy for it, so the
operator-facing string on the mission's headline surface is builder-invented.
Compare Task 8, which gives byte-exact copy for `suppressionLead` and for the
`DeadlinesNudgesCard` entry it does know about.

Also note the interaction with `RemindersPanel.tsx:113-121`: like ScheduledCard,
the panel's chip function special-cases only `'paused'` and otherwise falls
through to "sends in Nh" / "sending shortly". Task 8's prose ("MUST NOT render
the Paused chip or the send-manually note") addresses the suppression NOTE, not
that chip; only Task 12's aside ("the discontinued chip from Task 8 wins over
overdue") implies a chip branch exists at all.

## 4. [HIGH] The quiet-hours SUPPRESSION ESTIMATE is a third `en_route` site, and it is kind-blind

**What is wrong.** Spec 6 enumerates exactly two sites for the `en_route`
exemption - the arm-time clamp and the fire-time backstop - and says "It must be
built at BOTH sites; one without the other reopens the hole." Plan Task 10 builds
both. Neither document mentions the surface that PREDICTS quiet-hours deferral
for the panel, which is kind-blind and will now be wrong for `en_route`.

**Evidence.**

- `app/src/routes/tourReminders.ts:560-564`:
  `suppressionOf = (dueAt, paused) => evaluate((dueAt > nowIso && isQuietTime(dueAt, window)) || (wallClockQuiet && dueAt <= nowIso), paused)`
  - the quiet disjunction is computed from `dueAt` alone; `row.kind` is not in it.
- `app/src/routes/tourReminders.ts:527-528` states the formula is shared:
  "routes/placementNudges.ts and routes/contactTimeline.ts apply the same
  formula; this comment is the single explanation for all three."
- `app/src/routes/contactTimeline.ts:1005-1010` calls
  `suppressionFor(tenantConv, false, row.dueAt, manualOnlyReminderKinds.has(row.kind))`
  - same shape, same kind-blindness for the quiet flag.

**What it implies.** After Task 10, a `self_guided` tour at 04:00 arms an
unclamped `en_route` at 03:00 (spec 6.1: "There is no floor on the tour hour").
The rung WILL send at 03:00, and both the tour panel and the contact page will
have been chipping "Will wait - quiet hours" for it. That is a panel that lies in
the opposite direction from the one this mission is fixing, on precisely the
tours the exemption exists to serve. Neither the spec's section 6 enumeration nor
any plan task covers it, so no reviewer downstream will look for it.

## 5. [HIGH] Emptying `MANUAL_ONLY_REMINDER_KINDS` makes the e2e lane's background worker a live sender, and no task says so

**What is wrong.** Task 7 empties the set. The plan reasons about the poll, the
force-send, the two chip surfaces and the dev tick. It never states that the set
is also what makes the WORKER's wall-clock poll a guaranteed no-op in every
environment, e2e included.

**Evidence.**

- `app/src/worker.ts:349`:
  `startPoll('tour reminder', (now) => runDueTourReminders(now, tourReminderDeps));`
  - `tourReminderDeps` carries no `manualOnlyKinds`, so
  `app/src/jobs/tourReminders.ts:602` takes the module default.
- Today that default (`:201-206`) holds back all four auto-armed kinds, so the
  worker's poll cannot send. The ONLY sender in a hermetic lane is
  `POST /__dev/tour-reminders/tick`, whose `manualOnlyKinds: new Set()` override
  (`app/src/routes/dev.ts:419-422`) Task 7 step 3 deletes.
- E2E specs drive that seam with explicit clock travel
  (`e2e/scenarios/steps.ts:2036-2046`), which only works if nothing else fires
  rows between steps.

**What it implies.** After this branch, any seeded or armed rung whose `dueAt`
passes during a spec run can be sent, or claim-skipped by `supersededInBatch` /
the new past-tour gate, by the worker's own tick - concurrently with and
invisibly to the spec. That is a determinism change across the WHOLE e2e suite,
introduced by the one task nobody will suspect, and gate 4 is the first place it
shows. The plan owes at minimum an explicit statement of the risk and a decision
(the seam that would make it moot - a lane-level hold-back - is exactly what spec
10's "no dev/prod fork" rule forbids, so this needs a designed answer, not
silence).

## 6. [HIGH] Four tasks edit e2e specs and NOTHING runs e2e before the final gate

**What is wrong.** No task in the plan has an e2e run as a pass/fail step.

**Evidence.**

- Task 3 step 8 rewrites `e2e/tests/scenarios/tours.spec.ts:283-287`; step 9
  runs `test/tourReminders.test.ts` only.
- Task 6 step 3: "Do not run the full e2e suite here (gate-time); run the three
  touched specs once IF a lane is warm ... or defer to the gate."
- Task 9 step 2 rewrites `scheduled-visibility.spec.ts` and
  `tour-roster.spec.ts:488-501`; step 4 runs `cd app && npx vitest run` (app
  suite only).
- Task 12 step 3 adds an e2e assertion; step 4 runs
  `test/tourRemindersApi.test.ts`.
- Task 14 step 7 rewrites shared steps and adds a NEW e2e spec; step 8 runs five
  vitest files.

**What it implies.** Roughly a dozen e2e edits across four tasks with zero
observable verification until one ~18-minute gate run at the very end, at which
point failures cannot be attributed to a task. This is the "untestable steps"
failure mode directly: the steps have no pass/fail. Combined with finding 5 (a
new nondeterminism source landing in Task 7) the gate-4 failure mode is a
mixed-cause red suite with no bisect points.

## 7. [HIGH] Task 14 step 7's instruction for `tour-roster.spec.ts:252-269` is internally impossible

**What is wrong.** The plan says: "re-target the literal split from `'{members}'`
to `'{names}'` AND move its assertion to the tour-intro entry the preview now
returns (keep its guard-comment intent...)". Those two halves cannot both be
done.

**Evidence.**

- `e2e/tests/tour-roster.spec.ts:254-255`:
  `const [introHead = '', introTail = ''] = MESSAGE_CATALOG['relay.intro'].default.split('{members}');`
- `:256-268` then ASSERT both halves are non-empty, with failure messages naming
  the exact vacuity they guard: "the relay.intro default has no copy BEFORE
  {members} - startsWith below proves nothing".
- Spec 9.2a's table gives the tour-intro entries `vars` of
  `tenantFirstName, propertyContactFirstName, time, where` /
  `tenantFirstName, propertyContactFirstName, when, where`. Neither declares
  `{names}`, so `split('{names}')` on a tour-intro default returns the whole
  string as the head and an EMPTY tail - which is the exact condition
  `:262-266` fails on.
- Spec 9.1's fenced tour copy begins `Hey {tenantFirstName}!`, so any split on
  the first token also yields an empty head, failing `:257-260`.

**What it implies.** A builder following the instruction produces a test that
fails its own guards. The shell technique is not portable to an entry whose copy
starts with a token; the plan owes a different pin for this site (or a decision
to point it at the naked entry the standalone preview still returns - see
finding 9).

## 8. [MEDIUM] Task 3's hoist silently re-prioritises `tour_missing`, untested and unstated

**What is wrong.** Task 3 step 6's snippet moves the tour read AND the
`tour_missing` claim-skip to the top of `processReminderRow`, above
`supersededInBatch` and above the quiet-hours backstop. The plan justifies the
position for the past-tour gate only ("The tour read moves up here with it ...
so this is a hoist, not a second read") and never notices that `tour_missing`
moves with it.

**Evidence.**

- Today `tour_missing` is decided inside `resolveReminderTarget`
  (`app/src/jobs/tourReminders.ts:807-814`), which `processReminderRow` calls at
  `:922` - BELOW `supersededInBatch` (`:889-902`) and BELOW `isQuietTime`
  (`:910-916`).
- So today: a missing-tour row that is superseded in its batch retires
  `quiet_hours_superseded`; a missing-tour row due inside a quiet window is NOT
  claimed at all, it defers.
- After the plan's snippet both become `tour_missing`, and the quiet-window one
  retires instead of deferring.

**What it implies.** Two behaviour changes with no spec authority, no test in
Task 3 step 5's list, and no mention anywhere. Spec 6.1a's precedence table
(rows 1-6) never places `tour_missing`; the plan invents its position. If an
existing case pins the quiet-hours-defers-a-missing-tour-row behaviour it goes
red in Task 3 with no explanation attached (UNVERIFIED whether such a case
exists).

The safe shape - fetch the tour first but keep the `tour_missing` decision where
it is, letting `resolveReminderTarget` own it - is a one-line difference the plan
should state rather than leave to the builder.

## 9. [MEDIUM] `buildStandaloneOpenPreview` is an unenumerated fourth `composeIntroBody` caller, and the plan re-baselines its pins in the wrong direction

**What is wrong.** Spec 9.0 enumerates "EVERY call site of the two composers" as
four (two jobs, two previews). There is a fifth path, and it is the one with no
owner at all.

**Evidence.**

- `app/src/services/rosterEdits.ts:586-638` `buildStandaloneOpenPreview` takes an
  explicit member list (no `RosterOwner`) and returns
  `buildOpenPreviewFromParts(...)` at `:630`.
- `buildOpenPreviewFromParts:473` is where `composeIntroBody` is actually called;
  it has TWO callers, `:540` (`buildOpenPreview`, owner-scoped) and `:630`
  (standalone).
- `app/test/relayGroupPreview.test.ts:1-3` documents itself as
  "POST /api/relay-groups/preview (spec 6.2) - what creating a STANDALONE relay
  group WOULD send", and its pins at `:151` and `:208` assert
  `expect(res.body.body).toBe(composeIntroBody([...]))`.

**What it implies.** Task 14 step 5 tells the builder to thread `inputs` through
`OpenPreviewParts`; the standalone caller has no owner to derive them from and
will need `variant: 'naked'` supplied by hand - correct, but improvised. Worse,
Task 14 step 6 says of `relayGroupPreview.test.ts:151,208` that "each now expects
the OWNER-ROUTED body". For this file that is wrong: a standalone group has no
owner, the naked intro is byte-identical to today (spec 9.1), and the only change
these pins need is the composer's new first argument. An executor following the
instruction changes an expectation that must not change.

## 10. [MEDIUM] Task 14 step 6's new parity pin contradicts spec 9.6 for `member_added`

**What is wrong.** Step 6: "add one NEW pin per file for the parity contract
itself (preview body === what the job would compose for the same owner/roster)."

**Evidence.** Spec 9.0 rules the ADD preview shows the GROUP body; spec 9.6 rules
the member-added job's persisted `body` is the NEW MEMBER's copy, and Task 14
step 3 implements exactly that (`body` = new-member body, `bodyFor` returns the
group body for everyone else).

**What it implies.** Written as stated the pin is false for
`buildAddPreview` (the preview body and the job's `body` are deliberately
different strings). The pin has to be against the job's GROUP-leg body, i.e.
`bodyFor(someOtherMember)`, and the plan does not say so. A builder who writes
the pin literally either fails it and "fixes" the implementation the wrong way,
or quietly writes a weaker pin.

## 11. [MEDIUM] Task 7 places the `kind_retired` refusal where `refuse` is not yet declared

**What is wrong.** Task 7 step 2: "`forceSendReminder` refuses immediately after
the row lookup: `if (DISCONTINUED_REMINDER_KINDS.has(row.kind)) return refuse('kind_retired');`"

**Evidence.** The row lookup is `app/src/jobs/tourReminders.ts:1373-1378`.
`const refuse = (reason: ForceSendRefusal): ForceSendResult => {...}` is declared
at `:1420`. The file's own comment at `:1398` records the constraint: "The
`refuse` helper is declared below this point, so the return is inlined."

**What it implies.** `npm run typecheck` catches it (block-scoped use before
declaration), so it costs a cycle rather than shipping - but the plan quotes it
as literal code, and the codebase already documents the workaround one screen
above.

Related, same task pair: Task 7 refuses `kind_retired` BEFORE target resolution
while Task 3 refuses `tour_already_passed` AFTER it. For a pending
`confirmation` on a past tour the force-send answer is therefore `kind_retired`.
That is defensible, but it is a precedence the spec does not state and the plan
does not name.

## 12. [MEDIUM] Task 3's implementation snippet calls a repo method that does not exist

**Evidence.** Plan Task 3 step 6:
`const tour = await deps.toursRepo.getById(row.tourId);`. The real call is
`const tour = await deps.toursRepo.get(row.tourId);`
(`app/src/jobs/tourReminders.ts:807`). Task 14's resolver interface block makes
the same assumption for tours (`toursRepo: Pick<ToursRepo, 'getById'>`).

**What it implies.** Typecheck catches it. The plan does hedge ("Check
`RunDueTourRemindersDeps` for the tours repo member name"), but a plan that
supplies paste-ready code and a contradicting instruction in the same step
teaches the executor to trust the code block.

## 13. [MEDIUM] The full app suite is not run until Task 9, so Tasks 3-8 cannot be attributed

**What is wrong.** Per-task verification is "the named test file(s) for that
task" (Global Constraints). Task 3 runs one file; Task 5 runs eight; Task 7 runs
three; Task 8 runs three plus typecheck. The FIRST `cd app && npx vitest run`
(whole suite) in the plan is Task 9 step 4.

**What it implies.** Task 3 changes gate precedence inside `processReminderRow`
and Task 7 flips the poll from "sends nothing" to "sends everything". Both fan
out well past their named files (`tourRemindersApi`, `contactTimeline`,
`toursApi`, `relayApi`, `seedLive`, `devGating` all touch this machinery per the
plan's own conversion inventory). By the time the suite is run whole, five
commits have landed and a red file cannot be attributed to one. The commit
discipline the repo uses (commit verified work immediately) assumes each commit
is green.

## 14. [LOW] Task 1's step-1 snippet would overwrite an existing test file

**Evidence.** `app/test/messages/resolve.test.ts` EXISTS (130 lines, 16 cases
across `resolveMessage`, `settingsToOverrides`, `resolveWithSettings`). Task 1's
step 1 is presented as a whole file, headed `// app/test/messages/resolve.test.ts`
with its own `import` line; three of its five cases duplicate existing ones at
`:57` (override degrades), `:73` (strict default throws) and `:79` (declared var
absent from template). The file table hedges "(new file if absent; else extend)"
and step 1's prose says `ls app/test/messages/` first, but the artifact the
executor pastes is a full file.

**What it implies.** A literal paste deletes the `settingsToOverrides` and
`resolveWithSettings` coverage in the same commit that claims to ADD regression
coverage - and gate 2 would stay green, because nothing else pins those.

## 15. [LOW] `composeConnectionSentence` is referenced in comments the Task 13 rename will not find

**Evidence.** `app/src/lib/groupTitle.ts:60` and
`app/src/services/relayGroupDuplicates.ts:11` both name
`composeConnectionSentence` in prose. Task 13 step 2 says "rename; grep every
import" - imports only.

**What it implies.** Two stale cross-references to a function that no longer
exists, in files that reason about the same names-never-phones rule.

## 16. [LOW] Spec 15's five founder items have no owner in the plan

**Evidence.** The plan's self-review checklist maps "15 -> handback
(planner-side, not build work)". No task instructs the builder to carry them,
and Task 15 ("Docs closure") covers only the `tourCopy.ts` TODO re-point and the
ledger issue.

**What it implies.** The two items that are genuinely time-sensitive - the
`en_route` no-floor consequence (spec 6.1) and the missing sender identity on
Sam's two new intros, which spec 15 item 2 says must be raised BEFORE the first
such intro sends - depend entirely on the orchestrator remembering them.

## 17. [LOW] A shared e2e docblock becomes false and is on no task's list

**Evidence.** `e2e/scenarios/steps.ts:2032-2035`: "Omitting `now` uses the server
wall clock (fires the just-armed 'confirmation' rung)". After Task 9 nothing
arms `confirmation`, so the no-arg form fires nothing. `e2e/tests/scenarios/tours.spec.ts:279`
and `:299` are live callers of that form.

**What it implies.** Task 6 step 1 counts "2 steps.ts" confirmation sites, so a
careful grep finds it; the plan never names it, and a stale docblock on a SHARED
helper is what the next spec author reasons from.

---

## What I checked and did NOT find fault with

- Task 1's replacement `interpolate` preserves all three documented behaviours
  (`app/src/messages/resolve.ts:24-45`); the regex `[A-Za-z][A-Za-z0-9_]*`
  covers every token declared in `catalog.ts`; the callback replacement is
  correctly motivated (today's `split/join` at `:39,:42` really is `$`-immune).
- Task 1's four probe cases resolve correctly against the live catalog:
  `relay.member_added` is `'Hey! {joined} {members}'` with
  `vars: ['joined','members']` (`catalog.ts:299-306`), so the re-expansion case
  is genuinely RED pre-fix; `relay.media_only` is `editable: true`
  (`:309-316`), so the override probes work.
- Task 2's `SEND_NOW_ERROR_COPY` completeness test asserts against the exact
  live fallback string (`dashboard/src/api/types.ts:1342`), and the three new
  labels contain no underscore, so `types.test.ts`'s
  "never puts a machine token in front of staff" case passes.
- `retiredByTourStart`'s implementation and its five test rows are consistent,
  and the `no_show_checkin` exemption really is structural
  (`computeDueAt` `:153-154` returns `scheduled + 30m`).
- Spec 6.2's "no-op on an unclamped ladder" claim holds for every kind pair I
  worked through against `computeDueAt` (`:117-156`).
- The naked intro really is byte-identical under the `{members}` -> `{names}`
  rewrite for the NAMED branch (`relayFanOut.ts:199-206` +
  `catalog.ts:283-285`); the zero-others divergence is the one spec 9.2
  explicitly accepts.
- `dev.ts:622`'s second `manualOnlyKinds: new Set()` is the PLACEMENT-NUDGE
  tick, correctly out of scope.
- Every `docs/issues/` slug the plan writes to exists.
- Most `app/src/jobs/tourReminders.ts` line citations in the plan are accurate
  (`:158-164`, `:173-206`, `:235-240`, `:303-307`, `:412-417`, `:602-603`,
  `:888-902`, `:910-916`, `:956`, `:984-991`, `:1037-1043`, `:1205-1216`,
  `:1364`). The inaccurate ones are all in `routes/tourReminders.ts` (finding 2).
