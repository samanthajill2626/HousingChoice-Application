# Plan R1 - adversarial review A

Plan: `docs/superpowers/plans/2026-08-31-tour-reminder-ladder-phase-b.md`
Spec: `docs/superpowers/specs/2026-08-31-tour-reminder-ladder-phase-b-design.md`
Question answered: if a builder with NO context executes this plan LITERALLY, do
they produce the spec?

Every claim about existing behaviour below cites a file:line I read in this
worktree. Anything I could not verify is marked UNVERIFIED.

---

## 1. [BLOCKING] `{tenantFirstName}` is never made TOTAL, so a nameless tenant THROWS inside the intro job after its idempotency claim

**What is wrong.** Spec 9.5 rules that a missing tenant first name KEEPS the
tour/placement variant and "degrades in-sentence the way Phase A already does
(`Hey there,`)". The plan's contract (Task 14 Interfaces) declares
`tenantFirstName?: string` as OPTIONAL on `RelayComposeInputs`, and Task 14 step
1's test list says only "missing tenant first name keeps the variant and
degrades in-sentence" - it names no value and asserts no output string.

**Evidence.**

- `app/src/lib/tourContacts.ts:13-14` - `TourContactNames.tenantFirstName?: string`
  is genuinely optional; a nameless or missing contact yields `undefined`.
- `app/src/messages/tourCopy.ts:77-83` - Phase A supplies the fallback at the
  COMPOSER, not at the resolver: `tenantFirstName: names.tenantFirstName ?? 'there'`.
  That is the whole of the "Hey there," behaviour the spec points at.
- `app/src/messages/resolve.ts:35-38` - a DECLARED token present in the template
  with no value THROWS when `strict` (a catalog DEFAULT). Spec 9.2a fixes every
  new relay entry at `editable: false`, so `strict` is always true for them.
- `app/src/jobs/relayFanOut.ts:615-622` - the intro handler writes
  `putJobExecutionMarker` BEFORE composing. A throw after that marker means the
  redelivery is suppressed and the announcement is LOST, not retried. This is
  verbatim the failure mode spec 9.4 reasons about for `{name}` ("killing the
  job handler AFTER its `putJobExecutionMarker` claim, so the announcement is
  LOST rather than retried, and 500ing the add-preview route").

**What it implies.** The spec carefully made `{names}` (9.2) and `{name}` (9.4)
TOTAL and gave each a four-row / two-row table. It never extended that rule to
`{tenantFirstName}`, and the plan does not close the gap. A builder using this
repo's ubiquitous conditional-spread idiom
(`...(x !== undefined && { x })`, e.g. `app/src/jobs/tourReminders.ts:344-348`,
`app/src/routes/tourReminders.ts:344-347`) will produce exactly the omission that
throws. The defect is SHIPPABLE - it passes every test the plan specifies,
because no test pins the composed string for an absent tenant name - and it
destroys a relay intro rather than degrading it.

**Fix owed by the plan:** state the fallback VALUE (`'there'`, matching
`tourCopy.ts:81`) as part of the composer contract, and add an assertion on the
composed STRING for the nameless-tenant case in Task 14 step 1. Note that
`{propertyContactFirstName}` is NOT in the same class - 9.5 forces `variant:
'naked'` there - so the two must not be handled alike.

---

## 2. [BLOCKING] Emptying `MANUAL_ONLY_REMINDER_KINDS` turns the e2e stack's real worker into a live wall-clock sender; the plan never enumerates that surface

**What is wrong.** Every determinism argument in spec 10 and in plan Tasks 5, 6
and 10 is about the DEV TICK seam (`POST /__dev/tour-reminders/tick`) and
clock-travel `now` values. Nothing in the spec or the plan mentions that the e2e
stack also runs the PRODUCTION poll on a real interval, and that the poll is
inert today only because the manual-only set holds every auto-armed kind.

**Evidence.**

- `scripts/e2e-session.mjs:381` - `spawnNode('worker', ['--import', 'tsx',
  path.join('app', 'src', 'worker.ts')])`. The e2e lane boots a real worker
  process.
- `app/src/worker.ts:315-349` - `tourReminderDeps` is built with NO
  `manualOnlyKinds` member, and `startPoll('tour reminder', (now) =>
  runDueTourReminders(now, tourReminderDeps))`.
- `app/src/jobs/tourReminders.ts:602` - `const manualOnly = deps.manualOnlyKinds
  ?? MANUAL_ONLY_REMINDER_KINDS;`. So the e2e worker uses the PRODUCTION set,
  which today holds `confirmation, day_before, morning_of, en_route`
  (`:201-206`) - i.e. every auto-armed kind. The worker poll currently sends
  nothing, ever, in e2e.
- `scripts/e2e-session.mjs:249-252` - the hazard is already known and is
  currently mitigated by cadence alone: "WORKER_POLL_INTERVAL_MS is deliberately
  NOT lowered here: ... the worker polls real time - a fast cadence would let the
  worker race tick-driven specs for due rows (tick.processed assertions)."

**What it implies.** Task 7 ("MANUAL_ONLY emptied - the unpause") makes the
wall-clock worker a live sender in every e2e run, racing the dev tick for the
same `listDue` rows, on seeds that arm rungs relative to `now`
(`app/src/lib/seed/live.ts:506` "confirmation is always armed at `now`"). Task
7's verification is three app unit-test files (`test/tourReminders.test.ts
test/devGating.test.ts test/tourRemindersApi.test.ts`) and Task 6 step 3
explicitly declines to run e2e; the entire consequence lands unanalysed on the
final gate 4. Per AGENTS.md the named-flake list is now EMPTY, so any resulting
intermittency is a REGRESSION the builder must diagnose from scratch, and this
plan gives them no pointer to the mechanism.

The plan needs, at minimum: an enumeration of which seeded/spec-created rungs
become worker-sendable once the set is empty, and a decision on whether the e2e
lane pins `manualOnlyKinds` at the worker (which would itself be a new dev/prod
fork, so it is a real design question, not a mechanical fix).

---

## 3. [HIGH] The `'discontinued'` union widening breaks a THIRD exhaustive record - the one that actually renders the tour panel chip - and the plan names only the placement card

**What is wrong.** Spec 3.1a and plan Task 8 both treat
`dashboard/src/routes/placements/DeadlinesNudgesCard.tsx:64` as THE compile-
completeness site. There is a second, more consequential one, and the spec's own
standing hazard ("this review caught an unenumerated READER three separate
times") applies: this is the fourth.

**Evidence.**

- `dashboard/src/api/types.ts:1259-1268` -
  `export const REMINDER_SUPPRESSION_LABELS: Readonly<Record<NonNullable<TourReminderView['suppression']>['reason'], string>>`.
  `ScheduledSuppression.reason` is `ScheduledSuppressionReason`
  (`types.ts:1153-1155`), so this is an exhaustive `Record<ScheduledSuppressionReason, string>`
  and widening the union is a COMPILE ERROR here too.
- `dashboard/src/routes/tours/RemindersPanel.tsx:316-319` - the tour panel chip is
  `suppressionNote(rung.suppression.reason, REMINDER_SUPPRESSION_LABELS[rung.suppression.reason] ?? rung.suppression.reason)`.
  So this map is not "compile completeness only" - it is the operator-facing
  copy for the exact chip Task 8 is building.
- `dashboard/src/api/types.ts:1175-1177` - `suppressionNote` joins with
  `EM_DASH`. The plan's Task 8 instruction says the panel renders "No longer
  sent" and that "plain-hyphen copy rules apply". Neither is what ships: the
  rendered string is `<lead> <em dash> <label>`, and the plain-hyphen surface is
  the placements card, which composes its own note
  (`DeadlinesNudgesCard.tsx:247-249`, and the note at `types.ts:1173-1174`).
- `dashboard/src/routes/contact/ScheduledCard.tsx:78` - the contact timeline
  renders through the same `suppressionNote`, so Task 8's timeline change
  reaches this renderer too. The plan names no dashboard file for the timeline
  side.

**What it implies.** Executed literally, Task 8 fails typecheck at a site the
plan never mentions, and the builder then invents the missing label copy
unreviewed. The chip the spec describes ("reads 'no longer sent', never
'Paused'") cannot be produced by `suppressionLead` alone. The plan owes: the
`REMINDER_SUPPRESSION_LABELS.discontinued` string, the `ScheduledCard` reader,
and a corrected statement of what the rendered chip is.

---

## 4. [HIGH] Two tasks direct the send-now 409 wiring at the WRONG handler, and the shape they prescribe drops the field the panel needs

**What is wrong.** Task 3 step 6 and Task 7 step 2 both say to extend "the
send-now refusal mapping (the per-reason 409 handling around `:654-690`)" in
`app/src/routes/tourReminders.ts`, "following the `names_unavailable` pattern
exactly (`res.status(409).json({ error: 'tour_already_passed' })`)".

**Evidence.**

- `app/src/routes/tourReminders.ts:657-690` is the
  `GET /:tourId/no-show-checkin-draft` handler. Its `res.status(409).json({ error:
  'names_unavailable' })` at `:688` is a DIFFERENT endpoint with a different
  contract (`:651-656` documents its three terminal shapes).
- The real send-now handler is `:421-472`. It has NO per-reason mapping at all:
  `:466` `const error = result.outcome === 'not_pending' ? 'reminder_not_pending'
  : result.reason;` and `:471` `res.status(409).json({ error, reminder:
  viewOf(after, afterBody) });`. New `ForceSendRefusal` members are forwarded
  free of charge.
- `:418-420` states the contract the prescribed shape violates: "409 `{ error,
  reminder }` for every refusal or lost race, ALWAYS with the re-read (honest)
  view so the panel can correct itself".

**What it implies.** A builder following the instruction adds an early
`res.status(409).json({ error })` branch that omits `reminder`, silently
regressing the panel's self-correction for exactly the two new PERMANENT refusal
codes - the ones where the operator most needs the row's real state. The work is
also entirely unnecessary. Both tasks should instead say: nothing to wire, the
pass-through at `:466` already carries new reasons; the only owed edit is the
`SEND_NOW_ERROR_COPY` entry (Task 2), which is the site spec 4.3 already flags
as unenforced.

---

## 5. [HIGH] Task 13 leaves the relay intro AND member-added send paths throwing until Task 14, and its own steps contradict each other about it

**What is wrong.** Task 13 rewrites the two live relay catalog entries but
explicitly defers the composers that feed them to Task 14.

**Evidence.**

- Plan Task 13 Files: "`app/src/jobs/relayFanOut.ts:180-250` (`composeConnection-
  Sentence` -> name list; `composeIntroBody` / `composeMemberAddedBody`
  signatures in Task 14 - here only the pure list builder + `{name}` totality
  helper)".
- Plan Task 13 step 2: "rewrite `relay.intro` default to the spec 9.2 fenced text
  with `vars: ['names']` ... rewrite `relay.member_added` to `'Hey, adding {name}
  to the group.'` `vars: ['name']`".
- `app/src/jobs/relayFanOut.ts:217-221` - `composeIntroBody` calls
  `resolveMessage('relay.intro', { members: composeConnectionSentence(memberNames) })`.
  After Task 13 the entry declares `names` and the template contains `{names}`
  with no value supplied.
- `app/src/jobs/relayFanOut.ts:238-250` - `composeMemberAddedBody` calls
  `resolveMessage('relay.member_added', { joined, members })`. After Task 13 the
  entry declares `name`.
- `app/src/messages/resolve.ts:36-38` + `catalog.ts:303` (`editable: false`) -
  strict, so both are a THROW, not a degradation.
- `app/src/services/rosterEdits.ts:38` imports BOTH composers, so the preview
  routes throw too.

**What it implies.** At the Task 13 commit the app suite is red well beyond the
two files named, and the two live relay send paths are broken. The plan's own
steps disagree: step 3 concedes "job-level pins wait for Task 14", step 4 then
says "Run, PASS on the two files, commit" - and one of those two files is
`test/relayFanOut.test.ts`. Either Task 13 must also re-point both composers'
`resolveMessage` calls (trivial - one rename each) or Tasks 13 and 14 must be one
task. As written this breaks the between-commits green-ness the executing skill
depends on.

---

## 6. [HIGH] `e2e/tests/tour-roster.spec.ts` and `scheduled-visibility.spec.ts:225-259` are misclassified as cat-2, so nobody converts them

**What is wrong.** The plan's derived inventory (plan lines 68, 496, 604) and
spec 10a.1 both list `tour-roster.spec.ts:488-501` and
`scheduled-visibility.spec.ts:234-259` as category 2 ("arm-time / next-rung
semantics - Task 9 territory; leave green now"). Both are actually cat-1
immediate-send RIDES that additionally carry a cat-2 assertion.

**Evidence.**

- `e2e/tests/tour-roster.spec.ts:487-503` - the block's own comment says
  "TIMING-ROBUST BY CONSTRUCTION: the booking above armed the ladder and the
  `confirmation` rung's dueAt is the server's ARM-TIME instant, so it is already
  due". It then does `const confirmation = reminders.find((r) => r.kind ===
  'confirmation'); if (confirmation === undefined) throw new Error('the booking
  armed no confirmation rung');` and ticks 1s past that dueAt. The rung is being
  used purely as the due-now vehicle to make the poll RUN so a
  `tenant_not_on_roster` claim-skip chip appears (`:517-523`). Removing
  `confirmation` from `REMINDER_KINDS` makes this spec throw its own error, and
  the fix is a VEHICLE conversion, not a re-baseline.
- `e2e/tests/scenarios/scheduled-visibility.spec.ts:226-227` -
  `await flow.tickTourReminders(); await flow.expectReminderTo1to1('confirmation',
  tenant);` - a BARE tick (wall clock) that only fires anything because
  confirmation is due at arm time. `:258-259` repeats it after a reschedule. The
  same block also carries the cat-2 `expectReminderRung('confirmation', 'next')`
  at `:249`.

**What it implies.** Task 6 is instructed to leave both alone; Task 9 is told to
"re-baseline every red site by RE-DERIVING it ... arm-set assertions drop
`confirmation`". Neither instruction describes what these sites actually need,
and the second one is written for a different failure shape. Since these are two
of the four e2e sites the inventory calls out by line, the misclassification
propagates: any downstream plan-anchored reviewer inherits it. Note also that
after `confirmation` stops arming, EVERY bare `flow.tickTourReminders()` in the
suite becomes a no-op, because no rung is due at arm time any more - the plan
never states that consequence, and it is the single mechanical fact that decides
how many e2e sites are really cat 1.

---

## 7. [MEDIUM] Task 1 is written as a whole-file create over an existing 134-line test file, and Task 13 then breaks the pins it lands

**What is wrong.** Two separate problems on the same file.

**Evidence.**

- `app/test/messages/resolve.test.ts` EXISTS (134 lines). Plan Task 1 Files says
  "(create if absent; `ls app/test/messages/` first)" but step 1's code block is
  a complete file, header comment and imports included. Its existing coverage
  includes the very behaviours Task 1 must preserve
  (`resolve.test.ts:44-46` declared-token substitution, `:51-56` "substitutes
  every occurrence and only declared tokens", `:58-70` override degradation,
  `:72-76` strict default throw, `:78-80` declared-but-absent token).
- Task 1's probe is `relay.member_added` with vars `{ joined, members }`
  (`catalog.ts:305` confirms `vars: ['joined', 'members']`, which is what makes
  the re-expansion test red today). Task 13 step 2 rewrites that entry to
  `vars: ['name']`, which makes those Task-1 tests throw
  `missing interpolation var "name"`.
- The plan's tripwire inventory (plan line 71) and Task 13 step 3 ("any catalog
  test asserting `{members}`/`{joined}` declarations") do NOT name
  `app/test/messages/resolve.test.ts`. Task 1's inline note ("If Task 13 has
  already landed ... switch the probe id") points the wrong way in time: Task 1
  runs FIRST, so it is Task 13 that must do the switching, and Task 13 is not
  told to.

**What it implies.** Best case, the builder discovers the collision at Task 13
and re-targets. Worst case they delete or weaken the only regression pins for
the `interpolate` fix (spec 11 calls that coverage "not optional") to get the
suite green.

---

## 8. [MEDIUM] Two plan code blocks call `refuse(...)` before it exists

**Evidence.**

- Task 3 step 6: "In `forceSendReminder`, after target resolution succeeds and
  BEFORE compose/claim: `... return refuse('tour_already_passed');`". Target
  resolution ends at `app/src/jobs/tourReminders.ts:1416`.
- Task 7 step 2: "`forceSendReminder` refuses immediately after the row lookup:
  `if (DISCONTINUED_REMINDER_KINDS.has(row.kind)) return refuse('kind_retired');`".
  The row lookup is `:1373-1378`.
- `refuse` is a block-scoped `const` arrow declared at `:1420`. The file already
  records the constraint at `:1398`: "The `refuse` helper is declared below this
  point, so the return is inlined."

**What it implies.** Task 7's placement is a hard TDZ/compile error (the row
lookup is ~45 lines above the declaration). Task 3's stated range spans both a
valid and an invalid position. Typecheck catches it, but Task 7's TDD loop runs
vitest before typecheck, so the builder debugs a plan bug as if it were their
own.

Separately: Task 7's chosen position ("immediately after the row lookup") is a
BEHAVIOUR choice, not a placement detail - it refuses a discontinued kind even
when the tour is missing or the contact has no phone, ahead of every
`ReminderResolutionFailure`. That precedence is not stated in spec 3.1 and is
not tested by Task 7's step 1 list.

---

## 9. [MEDIUM] Task 3's gate code calls a repo method that does not exist, and falsifies a comment not on the rewrite list

**Evidence.**

- Plan Task 3 step 6: `const tour = await deps.toursRepo.getById(row.tourId);`.
  The method is `get`: `app/src/jobs/tourReminders.ts:807` `const tour = await
  deps.toursRepo.get(row.tourId);`, mirrored at
  `app/src/routes/tourReminders.ts:362,426,477,662`. The plan's mitigating
  instruction tells the builder to grep for the DEP name (`toursRepo`), not the
  method name.
- `app/src/jobs/tourReminders.ts:869-871` opens `processReminderRow` with "Both
  quiet-hours checks below run FIRST - above the tour fetch and above the
  group-route branch (which returns early)". Inserting the gate above
  `supersededInBatch` makes that false. Task 3 step 7's rewrite list names only
  the `beforeStart` docblock (`:944-951`) and `claimSkipRow`'s (`:640-643`).
- Behaviour change with no test: today a row that is `supersededInBatch` on a
  tour whose row is MISSING is claim-skipped `quiet_hours_superseded` (`:895-901`,
  the tour is never read on that path). After the hoist it is claim-skipped
  `tour_missing`. Neither the old nor the new outcome is pinned by any test the
  plan specifies.

---

## 10. [MEDIUM] Task 8's contact-timeline instruction does not match the code it points at, and misses that the surface excludes group-routed tours entirely

**Evidence.**

- Task 8 step 2: "Mirror the same discontinued-first branch in
  `contactTimeline.ts`'s reminder-card suppression derivation". The route chip it
  is mirroring is a four-arm ternary
  (`app/src/routes/tourReminders.ts:590-597`). The timeline derivation is a single
  call: `app/src/routes/contactTimeline.ts:1000-1005` -
  `const suppression = suppressionFor(tenantConv, false, row.dueAt,
  manualOnlyReminderKinds.has(row.kind));`. There is no branch to mirror; the
  call has to be restructured, and the plan gives no shape.
- `app/src/routes/contactTimeline.ts:987` - `if (!routes1to1) return [];`. The
  timeline's upcoming bucket contains NO tour reminders at all for group-routed
  (landlord_led / pm_team) tours. Spec 3.1's argument for this surface ("the
  perpetual-'sending shortly' lie ... one surface over") is therefore true only
  for 1:1-routed tours, and Task 8 step 1(b)'s test can only be written for that
  case. The plan states neither fact, so a builder writing the landlord_led half
  of the test (which Task 8 step 1(a) DOES require for the route) will find it
  vacuous here and may "fix" the walk.

---

## 11. [MEDIUM] `overdue` on `viewOf` also changes the send-now response; the plan (following the spec) calls it "the PATCH state-echo"

**Evidence.** `viewOf` (`app/src/routes/tourReminders.ts:336-349`) has three
callers, not one: the PATCH 409/200 echo (`:391` and the success path), and BOTH
send-now terminals (`:460` success, `:471` refusal). Spec 8.2 labels it "the
PATCH state-echo projection" and plan Task 12 step 1 specifies a PATCH
round-trip test only.

**What it implies.** A send-now REFUSAL now echoes `overdue: true` on a rung the
operator just failed to send - which is arguably the most useful place for the
flag, and is certainly a wire-shape change nobody reviewed or tested. The
enumeration spec 8.2 presents as complete ("There are TWO builders of
`TourReminderView`, not one") is complete on BUILDERS but not on RESPONSES.

---

## 12. [MEDIUM] The sweep script's mutating half has no test and no rehearsal, and Task 4 explicitly permits shipping it that way

**Evidence.** Plan Task 4 step 3: "a smoke of the script against a LOCAL lane
only if one is already warm - otherwise the planner tests plus typecheck suffice
for this task (the human proves it on real dev data at unpause time, spec 4.4)."
The tested surface is `planReminderRetirement`, a pure function. Untested:
the Scan paging, the `Map<tourId, TourItem|undefined>` tour cache, the
`ConditionExpression` (`attribute_not_exists(sentAt) AND ... canceledAt AND ...
skippedAt`), the `ConditionalCheckFailedException` catch, `--dry-run` writing
nothing, and the PII rule (spec 4.4: counts/tourIds/reminderIds only).

Note the repo key shape the Scan must respect:
`app/src/repos/tourRemindersRepo.ts:80-107` (PK `reminderId`, GSI hash
`_reminderPartition = 'reminders'`, GSI range `dueAt`). The plan does say "Check
the reminder rows' actual key/table layout ... BEFORE writing the Scan", which is
correct guidance but is not a test.

**What it implies.** The single highest-blast-radius artefact in the plan (a
conditional bulk write the human is told to run against PROD) is delivered with
its risky half unexercised. Spec 4.4 puts the "human runs it" rule in place for
authority reasons, not as a substitute for a hermetic rehearsal - and AGENTS.md
permits an agent to run it against a hermetic local lane. Task 4 should REQUIRE
the local-lane run, not make it conditional on a lane being "already warm".

---

## 13. [MEDIUM] Task 5's vehicle helper is a no-op wrapper whose only real content - the 6.1a precondition - is a comment, and Task 3's tests are told they may or may not have it

**Evidence.**

- Plan Task 5 Interfaces: `createDueReminder` is
  `return repo.create({ tourId, kind, dueAt });` - a pure passthrough. Spec
  10a.1's R3-7 precondition (`dueAt` must be `< tour.scheduledAt` or the new
  past-tour gate retires the row) lives only in the docblock. Nothing enforces
  it, so a fixture with a hardcoded absolute tour date silently produces rows the
  gate retires - the exact hazard spec 10a.1 raised.
- Plan Task 3 step 5 comment: "(Uses the Task 5 helper `createDueReminder` if
  already merged; otherwise `armTourReminders` with a near tour and a post-tour
  `now` works.)" Task 3 runs BEFORE Task 5 in the plan's own order, so the
  fallback is the real path - but the two fixtures produce different rows
  (armTourReminders drops past-due rows and applies booked_too_late /
  past_event / supersession at `app/src/jobs/tourReminders.ts:375-434`; `create`
  applies none of it). A TDD step whose fixture shape is left open is a step
  whose red state is not specified.

---

## 14. [LOW] Task 1's verification instruction cannot verify what it claims

**Evidence.** Plan Task 1 step 3: "verify with `grep -o \"vars: \\[[^]]*\\]\"
app/src/messages/catalog.ts before assuming" that every declared token matches
`[A-Za-z][A-Za-z0-9_]*`. Seven catalog entries build `vars` by SPREAD -
`app/src/messages/catalog.ts:132,144,152,161,169,180,190` are all
`vars: [...TOUR_NAME_VARS, ...]` - so that grep returns the spread expression and
never shows a single tour token name. The tokens are defined in `TOUR_NAME_VARS`,
which the suggested command does not read.

(The charset conclusion happens to hold - I checked
`catalog.ts:289,305,315,351,435,447,455,591` and the `TOUR_NAME_VARS` consumers
in `tourCopy.ts:77-83` - but the plan's stated method does not establish it.)

---

## 15. [LOW] Task 14's preview-route inventory is wrong in both directions

**Evidence.** `grep -rn "buildOpenPreview\|buildAddPreview" app/src/routes`
returns exactly four call sites in TWO files: `app/src/routes/tours.ts:936,967`
and `app/src/routes/placements.ts:1262,1292`. There are TWO
`RosterResolutionDeps` construction sites: `tours.ts:520` and
`placements.ts:923`. The plan's Files list names a "standalone preview route"
that does not exist, and step 5 says "update the three preview routes'
construction sites".

Related, unstated: `RosterResolutionDeps` is declared in
`app/src/lib/rosterResolution.ts:128` and is also consumed by
`app/src/jobs/rosterActions.ts` (`:60,:130`) and by `rosterEdits.ts:248`. Adding
REQUIRED `tours`/`placements`/`settings` members widens every constructor and
every test double. The plan grants latitude ("or thread a second deps arg -
follow whichever the routes can wire with least churn") but does not flag that
the natural reading (extend the shared interface) has a blast radius outside the
two routes it names.

---

## 16. [LOW] Spec section 15's five founder-owed items are assigned to nobody

**Evidence.** Plan self-review checklist: "15 -> handback (planner-side, not
build work)." No task records them anywhere in the repo. Spec 6.1 says "BOTH of
these go in the handback (section 15)" about the `en_route` exemption's two
consequences, and spec 15 item 2 carries an explicit SEQUENCING requirement
("she can be asked BEFORE the first tour or placement intro ever sends - not
after"). With Task 15 closing the ledger issue as `resolved` and no artefact
carrying items 1-5, the sender-identity question and the "no floor on the tour
hour" disclosure can be lost between the build handback and the human.

---

## 17. [LOW] Task 7 empties the set but leaves the injection seam's stated PURPOSE unreconciled

**Evidence.** `app/src/routes/tourReminders.ts:107-116` documents the
`manualOnlyKinds` seam as existing because "with the production default every
upcoming rung chips `paused` and the quiet-hours preview below becomes
unobservable. The quiet-hours suite passes an EMPTY set to keep exercising that
formula". With the production set empty, that seam is a no-op identical to the
default. Task 7 step 4's rewrite list (`routes/api.ts:389`,
`contactTimeline.ts:115`, `tourReminders.ts:110`) is about comments claiming
"production holds everything back", and does not mention that the quiet-hours
suite's reason for passing an empty set has evaporated - which is a live question
for Task 10 step 3's re-read of `e2e/tests/scenarios/quiet-hours.spec.ts`.

---

## Coverage walk - spec decisions to tasks

Every spec section 2 decision has a task. D1 -> T7+T9; D2 -> T2+T4; D3 -> T5+T6;
D4 -> T11; D5 -> T12; D6 -> T15 (via spec 12's table); D7 -> T10; D8 -> T13+T14;
D9 -> T13; D10 -> T14; D11 -> T14; D12 -> T1; D13 -> T4's RUNBOOK entry.

Gaps found are not missing TASKS, they are missing CONTENT inside tasks
(findings 1, 3, 4, 10, 11, 16 above). The one whole-decision gap is spec 15,
finding 16.

Sections I checked and found genuinely delivered: 4.5 (nothing owed), 5 (catalog
entries stay - T9 step 1 says so), 6.2's no-op regression test (T10 step 1 test
4), 7.2's force-send-unchanged rule (T11 step 2), 9.6's `persist: false`
degradation (T14 step 4), 9.7 (correctly not in scope), 12 item 9 (T15).
