# Plan review - round 3 (fresh reviewer, continued)

Reviewer: the round-2 FRESH plan reviewer, continued.
Reviewed at `6a9eb842` ("docs(review): round-2 adjudications and surgical
spec/plan corrections"), against the repo in `W:/tmp/tour-reminder-ladder`.
Method: `git show 6a9eb842` for both patched documents, then every claim about
existing behaviour re-verified at file:line. UNVERIFIED is marked.

I do not re-litigate my round-2 findings. The headline of this round is
different and worse than any single defect:

**THE PATCH LANDED IN THE SPEC AND NOT IN THE PLAN, REPEATEDLY.** Four adjudicated
corrections - the 6.2 helper reversal, the 8.1 skip-rule precedence, the 6.1
`nonEmpty` guard, and the 8.2 raw-dueAt decision - were written into the spec and
never propagated to the task that builds them. The plan now instructs a builder
to do the OPPOSITE of what the spec decides in three places. A patch-only round
is the right call after two bad rewrites, but a patch to a two-document system
has to be applied to BOTH documents, and nobody diffed the plan against the spec
afterwards.

Round 3 blocker count is not lower than round 2. Per the coordinator's own
stopping rule, that is the signal.

---

## 1. BLOCKING - spec 6.2's REVERSAL never reached the plan; Task 1 still commits the drive-by the spec forbids, and Task 12 assumes it did not

**What is wrong.** The patch reverses a round-1 ACCEPT. Spec 6.2 now reads:

> `app/src/lib/contactName.ts` does NOT export a first-name helper... it carries
> an explicit scope guard... So: put the first-name helper next to its consumer,
> in the new tour-contacts module (section 6.1), NOT in `contactName.ts`.

The plan was NOT patched. `git show 6a9eb842 -- <plan>` touches Task 4 Step 1,
Task 6 Steps 6-7, Task 8, Task 9, Task 11 Step 2 and Task 12 Steps 8-11. **Task 1
and the File Structure table are untouched**, and both still say the opposite:

- plan `:48` - `| app/src/lib/contactName.ts | contact name helpers | ADD contactFirstName() |`
- plan `:63-65` - "Files: Modify: `app/src/lib/contactName.ts`; Test: `app/test/contactName.test.ts`"
- plan `:80` - `import { contactFirstName } from '../src/lib/contactName.js';`
- plan `:121` - `git add app/src/lib/contactName.ts app/test/contactName.test.ts`

The scope guard is real and explicit: `app/src/lib/contactName.ts:52-60` -
"SCOPE GUARD: five PRIVATE copies of this derivation already exist... This export
is consumed by PUSH-COPY sites only... consolidating the older copies is tracked
in docs/issues/consolidate-contact-display-name-helpers.md - do not re-point them
here as a drive-by." That issue file exists.

The plan is now internally contradictory as well: Task 12 Step 10 (patched) says
"put a `TODO(<slug>)` marker on the new first-name helper for the
`consolidate-contact-display-name-helpers` issue it deliberately adds to" - which
only makes sense under the spec's relocation. Task 1 puts it in the very module
that issue exists to shrink.

**Implies.** A literal builder follows Task 1, violates a documented guard, and
Task 12 Step 10 then reads as nonsense. Patch Task 1, its test path, its import,
its commit paths, and File Structure row `:48`.

**Also unaddressed by the 6.2 patch:** Task 3 `:192` still consumes
`contactDisplayName` from that same module for `tenantName` /
`propertyContactName`. That is a NEW tour consumer of the export whose docblock
says "consumed by PUSH-COPY sites only" - so the sentence becomes false whichever
way the first-name half is resolved, and no task updates it. Either move the
full-name derivation next to the first-name one, or amend that docblock in the
same change.

---

## 2. BLOCKING - spec 8.1's rewritten skip-rule precedence did not land in Task 7; the task is byte-identical to the pre-patch version

**What is wrong.** Spec 8.1 was substantially rewritten by the patch:

> DECIDED: evaluate BOTH new skip rules BEFORE the past-dueAt check...
> PRECEDENCE... for `day_before` and `morning_of` the order is (1) the new
> booked-too-late rule, (2) past-dueAt, (3) past-event, (4) supersession /
> `staleDayBefore`. A rung retired by rule 1 is NOT re-examined...
> CONSEQUENCE the tests must pin: ... Named assertions at
> `tourReminders.test.ts:1211`, `:356` and `:397` do not merely need
> re-baselining - their POLARITY inverts.

Task 7 (plan `:530-579`) is in the untouched region of the diff. It still says,
in full: "Rule 1 must be evaluated BEFORE the existing past-dueAt branch at
`:266`". No rule 2. No four-level precedence. No polarity inversion. Its Step 1
fixtures are unchanged, so my round-2 finding that the CRITICAL ordering is
exercised by no fixture - ACCEPTED in the adjudications - is also unlanded.

I verified the polarity sites the spec names, and they are real and are exactly
as described:

- `app/test/tourReminders.test.ts:359` -
  `expect(byKind['day_before']).toBeUndefined();` under the comment "dropped by
  the pre-existing past-dueAt rule, which stays a SILENT skip" (`:355-358`).
- `app/test/tourReminders.test.ts:1211-1213` - "day_before = scheduledAt - 24h
  ... past-dueAt, the pre-existing SILENT skip (no row at all)" then
  `expect(rows.map((r) => r.kind)).not.toContain('day_before');`
- `app/test/tourReminders.test.ts:396-400` - the "Test 1g" comment block making
  the same claim.

Under rule 1 all three become `booked_too_late` ROWS. A builder working from the
PLAN alone never learns this and will "fix" three passing-shaped assertions by
flipping them, or delete them.

**Implies.** The single most consequential accepted blocker of round 2 is not in
the document that builds it. This is not a wording gap - `booked_too_late` for
the most-late booking is the decision, and the plan still specifies the version
that lets it vanish.

---

## 3. BLOCKING - Task 8's new item 1 instructs the builder to delete the `contact_missing` claim-skip (and settles round-2's DEFER: that path is UNREACHABLE)

**What is wrong.** The rewritten Task 8 (plan `:602-607`) reads:

> 1. The POLL distinguishing failure from ABSENCE. Today an absent contact is
>    `contact_missing` (a claim-skip) and a THROW is an escape. **After this task
>    an absent contact still sends, greeting "there"**; only a THROW leaves it
>    unclaimed. The absence-still-sends case is the one that is red today.

"An absent contact" here is unambiguously the TENANT contact, because
`contact_missing` is produced in exactly one place:

```
app/src/jobs/tourReminders.ts:647-654
  const contact = await deps.contactsRepo.getById(tour.tenantId);
  if (!contact) { ...; return { unresolvable: 'contact_missing', tenantId: ... }; }
```

Making that case "still send" is not implementable and is a regression:

- The 1:1 route derives the phone from that contact (`:657-664`) and the
  conversation from that phone (`:667-675`). With no contact there is no phone
  and no conversation - nothing to send TO. `contact_missing` is correct.
- It is a live `ReminderSkipReason` (`repos/tourRemindersRepo.ts:40`), a live
  `ForceSendRefusal` (`jobs/tourReminders.ts:1121` via
  `ReminderResolutionFailure`), and it has staff-facing copy
  (`dashboard/src/api/types.ts:1302`).

**This also SETTLES the round-2 DEFER** of my r1b #15, which I marked "may be".
It is not "may be" - it is settled, and against the plan:
`resolveReminderTarget` claim-skips at `processReminderRow:741-754`, which
returns BEFORE `composeBodyForRow` at `:846`. So on the 1:1 poll route the tenant
contact is ALWAYS defined at compose time and "absent tenant contact greets
there" is **unreachable by construction**.

The reachable absences - which is what Task 8 should say - are three, and all
three are genuinely new:

1. The GROUP route. `resolveReminderTarget:641-644` returns before the contact
   read, so `sendGroupReminder -> composeBodyForRow` has NO tenant contact in
   hand and must resolve one itself. This is the only route where an absent
   tenant contact reaches the composer.
2. A contact that EXISTS with no `firstName` (the index-signature field).
3. The PROPERTY contact - absent unit, empty roster, nameless landlord.

**Implies.** As written, a builder either breaks `contact_missing` or thrashes
against an unreachable state. Rescope item 1 to the three cases above and point
its fixture at the group route.

---

## 4. BLOCKING - Task 9's replacement vehicle cannot exist as described, and its "one vehicle" rule is unsatisfiable for `tours.spec.ts`

**What is wrong.** The patched Task 9 (plan `:669-673`) says:

> the natural candidate is an `en_route` rung on a tour booked **so the rung is
> already due**, driven by the dueAt read back from the API... Do not solve it
> five different ways in five specs.

Two defects.

**(a) A rung that is already due at ARM time is never written.** The arm loop:

```
app/src/jobs/tourReminders.ts:266-269
  if (dueAt < now) { log.info(...'skipped (dueAt in the past)'); continue; }
```

No row. So there is nothing for `tickTourReminders()` to fire. The sentence is
also internally incoherent: "driven by the dueAt read back from the API" means
passing an explicit synthetic `now`, at which point "already due" is irrelevant -
any future rung works.

The workable form, which neither document states, is much simpler and needs no
read-back at all: `en_route` is `scheduledAt - 1h`, a PURE offset that
`TourTimes.enRoute` already mirrors (`e2e/scenarios/steps.ts:276-277`, kept by
Task 11 Step 1). Replace each bare `tickTourReminders()` with
`tickTourReminders(justAfter(times.enRoute))`. It is the LAST auto-armed rung in
`LADDER_ORDER` (`jobs/tourReminders.ts:127-133`), so release supersession retires
the earlier rungs in the same batch and cannot retire it - which is the exact
property `quiet-hours.spec.ts:35-38` already requires of its anchor rung.

**(b) One vehicle cannot serve `tours.spec.ts`.** That spec fires TWO rungs in
sequence: bare tick -> `expectReminderInGroup('confirmation')` (`:130-133`), then
`justAfter(times.dayBefore)` -> `expectReminderInGroup('day_before')` (`:134-135`).
If the first tick becomes `justAfter(times.enRoute)`, the `day_before` rung is
already retired by supersession before `:134` runs. There is no rung EARLIER than
`day_before`, so no single vehicle preserves an ordered pair. That spec needs the
read-back method for `day_before` AND a second rung - i.e. exactly the "solve it
two ways" the instruction forbids.

**Also unnamed:** there are NINE bare `tickTourReminders()` calls, not the six the
plan's site table implies -
`scheduled-visibility.spec.ts:133,177,197`, `tours.spec.ts:130,184,228,264,284`,
and `tour-no-show-checkin.spec.ts:75` (see finding 19).

---

## 5. BLOCKING - Task 9 Step 6 demands a green app suite at a point where Task 4 deferred the re-baseline to Task 10, which runs later

**What is wrong.** New in the patch (plan `:691-693`):

> **Step 6: Run `cd app && npx vitest run` and get it green.** The e2e side is
> Task 11's...

But plan `:271-273`, unpatched, says of the composer call sites:

> Update them to compile only; **their expectation re-baseline is Task 10.**

And Task 10 - "Dashboard relabel and app-suite re-baseline" - runs AFTER Task 9.
Between Task 4 and Task 10 the app suite carries stale expectations that no task
before Task 10 is allowed to touch, for example:

- `app/test/toursApi.test.ts:1506` pins `'Hi! Do you need to reschedule?'`
  literally; Task 4 Step 3 changes that copy to `'Hi {tenantFirstName}! ...'`.
- Task 6 retimes `day_before`/`morning_of`, invalidating dueAt assertions in
  `tourReminders.test.ts` (`:350-360` etc.), `toursApi.test.ts:1410,1448,1592,2727`
  and `relayApi.test.ts:1476+` - none of which Task 6 or Task 7 is scoped to fix.

Task 9 Step 6 is therefore unachievable as stated. Two bad literal outcomes: the
builder stalls at a gate that cannot pass, or - far likelier - they start
re-baselining Task 10's expectations inside Task 9 and the "commit after every
task, explicit paths only" discipline dissolves.

**Implies.** This is a NEW contradiction created by the round-3 patch (Task 9
Step 6 did not exist before). Either scope Step 6 to the confirmation-STRUCTURAL
sites (`npx vitest run test/tourReminders.test.ts -t <...>`), or move Task 10
before Task 9.

---

## 6. HIGH - Task 11 Step 2's read-back method fixes the arithmetic and does NOT restore the quiet-hours timing contract; the rung that does is never named

**What is wrong.** The patched Step 2 (plan `:750-767`) gives the method - read
the armed `dueAt` back from the API - then adds a caveat that the
`quiet-hours.spec.ts` contract must be preserved and, if it cannot be, "change
WHICH RUNG that assertion drives".

The method does not preserve it, and the plan presents it as though it might.
The dependency is not the instant; it is the WINDOW:

```
e2e/tests/scenarios/quiet-hours.spec.ts:128-135
function windowAroundNow(): QuietPatch {
  const base = Date.now();
  return { quietHoursEnabled: true,
    quietHoursStart: orgLocalHhMm(new Date(base - 2 * 3_600_000)),
    quietHoursEnd:   orgLocalHhMm(new Date(base + 2 * 3_600_000)) };
}
```

The window is centred on the REAL wall clock, org-local. The DEFER tick must land
INSIDE it. Old timing: `dayBefore = sched - 24h` with `sched = wallclock + 48h`,
so the tick's org-local time-of-day equals the wall clock's - dead centre, at any
hour. That is precisely what `:27-30` documents. New timing: 19:30 org-local, a
FIXED clock time, inside `[wallclock-2h, wallclock+2h]` only when the suite runs
between ~17:30 and ~21:30. Reading `dueAt` back tells you 19:30 exactly and
changes nothing about that.

**The rung that restores it is `en_route`**, and the arithmetic is decisive:

| rung | new offset | tick time-of-day | inside [now-2h, now+2h]? |
| --- | --- | --- | --- |
| `day_before` | 19:30 org-local | fixed 19:30 | only 17:30-21:30 |
| `morning_of` | `sched - 4h` | `now - 4h` | NO (window reaches -2h) |
| `en_route` | `sched - 1h` | `now - 1h` | YES, always |

`en_route` also satisfies the spec's other stated requirement (`:35-38`, "the
assertions ride the LAST due rung... which nothing can supersede") because it is
last in `LADDER_ORDER`. And the RELEASE tick at `+5h` (`:318`) lands at `now+4h`,
outside the window, as required. `times.enRoute` already exists.

**Implies.** As written, the builder applies the read-back method to
`quiet-hours.spec.ts`, the suite goes green in their afternoon, and it becomes a
time-of-day flake in a repo whose AGENTS.md says a named-spec failure is a
regression, not something to re-run. Name the rung.

---

## 7. HIGH - spec 8.2's new raw-dueAt decision contradicts Task 7 Step 3, and its stated justification is half false

**What is wrong.** New in the spec:

> WHAT `dueAt` IS PERSISTED on a `booked_too_late` row must be stated, because
> the panel SORTS by it and picks "Next" from it: store the rung's RAW computed
> dueAt, unclamped...

Two problems.

**(a) The plan says the opposite.** Task 7 Step 3 (unpatched, plan `:571-572`):
"writing visible skipped rows shaped like the `past_event` branch at `:270`."
That branch writes the CLAMPED value:

```
app/src/jobs/tourReminders.ts:250   dues.set(kind, clampOutOfQuietHours(computeDueAt(...), window));
app/src/jobs/tourReminders.ts:263-278  const dueAt = dues.get(kind); ... create({ tourId, kind, dueAt, skipped: {...} })
```

A builder following the plan stores the clamped value; the spec decided raw.

**(b) "picks Next from it" is false.** `next` excludes skipped rows:

```
app/src/routes/tourReminders.ts:505  .sort((a, b) => (a.dueAt < b.dueAt ? -1 : ...));
app/src/routes/tourReminders.ts:508  const next = reminderViews.find((v) => v.state === 'upcoming');
```

A `booked_too_late` row has `state: 'skipped'`, so it can never be `next`. The
SORT half is true; the "Next" half is not. The DECISION still stands on ordering
grounds, but this is the second time in this review cycle that a correct
conclusion has shipped with an over-broad justification (the hook-cut was the
first, and the adjudications corrected it for exactly this reason). The written
reason is what the next reader re-derives from.

---

## 8. HIGH - spec 6.1's restored `nonEmpty()` guard names a PRIVATE function, and the plan still carries the guardless snippet

**What is wrong.** The patch restored the guard to spec 6.1:

```
unitContacts(unit).find((c) => c.primaryContact === true)?.contactId
  ?? nonEmpty(unit.landlordId)
```

`nonEmpty` is not importable:

```
app/src/lib/rosterResolution.ts:151   function nonEmpty(value: unknown): string | undefined {
```

Module-private, no `export`, and `grep -rn "export function nonEmpty" app/src`
returns nothing. A builder copying the snippet into the new `lib/tourContacts.ts`
gets a compile error, and the two obvious recoveries - exporting it, or copying
it - are a change to a shared module and a seventh local copy respectively.
Neither document chooses.

Meanwhile the PLAN was not patched: Task 3 `:226` still reads
`const propertyContactId = primary?.contactId ?? unit.landlordId;` - the exact
guardless form the spec now calls out by name ("an earlier revision of this
snippet dropped it"). Task 3's five listed test cases still contain no
empty-string-`landlordId` case.

---

## 9. HIGH - Task 11 Step 5 still threads only the tenant name; `tourType` and the property-contact name are owned by no task, and `tour-comms-pane.spec.ts` appears in no task

**What is wrong.** Spec 13.2 (new) names the problem:

> Also affected and easily missed: `tour-comms-pane.spec.ts` and
> `tourReminderContext`, which the required `tourType` and the threaded names
> both reach.

The plan was not patched. Task 11 Step 5 (`:786-789`) still says only "the SEEDED
tenant's first name". Task 4 Step 5 still says only "update the five call sites".
The concrete gaps:

- `e2e/scenarios/steps.ts:139-143` `TourReminderContext` has
  `{ scheduledAt, timezone, address? }` and must gain `tourType` (REQUIRED by
  Task 4) plus both names. `tourReminderContext(unit, times)` (`:163-165`) has no
  parameter for either.
- `e2e/tests/dashboard-next/tour-comms-pane.spec.ts:230-238` passes an INLINE
  object literal to `tourReminderBody`. Named in no task, no file table, and no
  commit path list. The e2e workspace does have a typecheck
  (`e2e/package.json` -> `tsc -p tsconfig.json`, run by root `npm run typecheck
  --workspaces`), so Task 4 Step 8 catches it - but Task 4 Step 9's commit paths
  ("the src files, the e2e helper, the six test files, and the two test suites")
  exclude every e2e spec, so the builder commits a half-fixed tree.
- Once finding 4's `en_route` vehicle is adopted in `tours.spec.ts`, that spec's
  expectations compose `tour.en_route_landlord_led`, which interpolates
  `{propertyContactFirstName}` - so the group-routing proof couples to the
  SEEDED LANDLORD's first name, which Step 5 does not mention at all.

---

## 10. HIGH - back-dating or reviving a tour now stamps a visible "booked too late" chip; an unenumerated mutation surface and an unstated consequence

**What is wrong.** Rule 1 fires at every ARM instant, and arming happens on three
paths, not two:

```
app/src/routes/tours.ts:349-354     POST /api/tours, whenever scheduledAt is supplied
app/src/routes/tours.ts:1168-1182   PATCH, when effectiveStatus==='scheduled' AND
                                    (scheduledAt changed OR status moved INTO 'scheduled')
```

Path 2's second trigger is a STATUS-ONLY REVIVAL from `canceled`/`no_show`,
re-arming against the STORED time with `now` = the revival instant. Nothing in
either document mentions revival's interaction with the new rules, though the
plan's Task 7 preamble does list it (`:547`).

The consequence nobody has stated: recording a tour after the fact - a normal
operator action, and one the harness performs
(`e2e/tests/tour-no-show-checkin.spec.ts:65-70` PATCHes `scheduledAt` to 26h ago
with `status: 'scheduled'`) - now writes a VISIBLE row reading
"Skipped - booked too late for this reminder" on the panel for a tour that was
never "booked late" at all. Previously the past-dueAt branch wrote nothing and
the panel showed a clean gap.

Spec 11 ("Behavioural consequences to state, not discover") lists two
consequences and not this one. Either scope rule 1 to exclude an arm whose `now`
is past `scheduledAt`, or state it.

---

## 11. MEDIUM - the segment gate is now load-bearing but composes with NO names, so it pins the fallback body and nothing states the name length the margin assumes

**What is wrong.** Task 12 Step 9 and spec section 5 both now treat
`tourCopy.test.ts:115` as a hard gate with "roughly NINETEEN characters" of
margin "with a first name". The gate as it stands:

```
app/test/tourCopy.test.ts:109-118
for (const kind of ['confirmation','day_before','morning_of','en_route'] as const) {
  const body = composeTourReminderBody({ ...base, kind, address: '350 Boulevard SE, Atlanta, GA 30312' });
  expect(body).not.toMatch(NON_ASCII);
  expect(analyzeSms(body).segments).toBe(1);
}
```

No `names`. After Task 4 that composes the FALLBACK - `Hey there,` - not a real
name. `there` is five characters, so the gate would happen to measure the same
length as the plan's `Alice` fixture and pass, while the production body for a
tenant named `Bartholomew` is six characters longer and for a 24-character name
is over the boundary. Nothing in either document says what name length the gate
is measured at, and the gate itself measures a name that never ships.

Fix: add `names` with a deliberately long realistic first name and say why, or
state the accepted maximum first-name length in the handback.

---

## 12. MEDIUM - Task 4 Step 1's "DELETE the existing old-copy expectations" is broad enough to take the segment gate and the UCS-2 test, and leaves both surviving `confirmation` entries with no copy assertion

**What is wrong.** The patched Step 1 (`:286-289`) says "DELETE the existing
old-copy expectations in `tourCopy.test.ts` as you go; leaving them means Step 7
cannot pass." Correct instinct - my round-2 finding - but the boundary is not
drawn. That file also contains two tests that are NOT old-copy expectations and
MUST survive:

- `:108-118` the ASCII + single-segment gate (finding 11, and the thing Task 12
  Step 9 depends on). It needs `tourType` ADDED, not deletion.
- `:120-129` the non-ASCII-address / UCS-2 anti-regression test, likewise.

And the inline replacement tests cover `day_before`, `morning_of` (x2),
`en_route` (x3 types), the degrade, the "there" fallback and `no_show_checkin` -
but NOT `confirmation` or `confirmation_no_address`. Task 4 Step 3 keeps both
entries in the catalog deliberately (spec 9.1, for in-flight rows). If the old
`:23-25` / `:54-56` expectations are deleted, those two entries end this change
with no copy assertion anywhere - only the matrix test's "does not throw".

---

## 13. MEDIUM - Task 8 item 2 asks for a new `ForceSendResult` OUTCOME; only a new reason TOKEN is needed, and a new outcome breaks the route's ternary

**What is wrong.** Plan `:610-612`: "Add a refusal outcome to `ForceSendResult`
and a reason token, and have the route render it."

`ForceSendResult` already has the refusal shape
(`jobs/tourReminders.ts:1123-1131`): `{ outcome: 'refused'; reason: ForceSendRefusal }`.
What is missing is only a token on `ForceSendRefusal` (`:1098-1121`). Adding a
FOURTH outcome shape, as instructed, breaks the route:

```
app/src/routes/tourReminders.ts:394
  const error = result.outcome === 'not_pending' ? 'reminder_not_pending' : result.reason;
```

Any non-`not_pending` outcome reaching that line must carry `.reason`.

Worth recording as verified-clean alongside it: the dashboard needs no change -
`sendNowErrorMessage` falls back to a generic sentence for an unknown code
(`dashboard/src/api/types.ts:1321-1323`), and `RemindersPanel.tsx:103` degrades
an unknown skip reason to a bare "Skipped".

---

## 14. MEDIUM - Task 5 is unpatched: still "eight existing reasons", and its red state is still the type-only one already accepted as never-red

**What is wrong.** Spec 8.2 was corrected to NINE reasons, naming
`invalid_schedule` (`repos/tourRemindersRepo.ts:64-71`;
`dashboard/src/api/types.ts:1216`, labelled `:1273`). Task 5 `:439` still says
"None of the eight existing reasons means this."

More consequentially, the adjudications ACCEPTED "Task 5's red state is type-only,
so vitest strips it and it is never red" - and Task 5 Steps 1-2 are unchanged:
"Write the failing tests - the union accepts it" / "Run and watch them fail."
The app-side half of that will be GREEN before the union exists, because vitest
runs through esbuild, which strips types without checking them (the plan's own
Global Constraints say so at `:34-36`). Add a `npm run typecheck` step to Task 5,
or state that the dashboard label test is the only genuinely red half.

---

## 15. MEDIUM - Task 10 still lists a test file the patched spec explicitly removed as unaffected

**What is wrong.** Spec 13 now says:

> `relayAnnouncements` was listed here in an earlier revision and is NOT affected
> - `:60` uses a literal body and a rung-derived tag string. Removed rather than
> left to waste someone's time.

Verified: `app/test/relayAnnouncements.test.ts:67` passes `kind: 'tour.day_before'`
as an announcement TAG, matching `announceGroupReminder`'s
`kind: \`tour.${row.kind}\`` (`jobs/tourReminders.ts:1081`) - a rung-derived
string, not a catalog id, and deliberately so per the comment at `:1079-1080`.

Task 10's file list (`:702`) still names `relayAnnouncements.test.ts`. The spec
removed it precisely so nobody would spend time there; the plan did not.

---

## 16. MEDIUM - the resolver-to-composer degrade join is still owned by no task and was never adjudicated

**What is wrong.** Spec 13 owes: "the property-contact fallback degrading to the
self-guided entry - covering BOTH zero-roster and zero-primary." Task 3 tests the
RESOLVER; Task 4 tests the COMPOSER's `!hasContactName` branch. Nothing tests the
join, and the join is where the defect would live, because the two "fallback"
cases the spec names take DIFFERENT code paths:

```
app/src/repos/unitsRepo.ts:295-303
  if (Array.isArray(unit.contacts) && unit.contacts.length > 0) return unit.contacts;
  if (typeof unit.landlordId === 'string' && unit.landlordId.length > 0)
    return [{ contactId: unit.landlordId, role: 'landlord', primaryContact: true }];
```

Zero-roster is satisfied INSIDE `unitContacts` (which synthesizes a
`primaryContact: true` row), so `primary?.contactId ?? ...` never reaches its
fallback. Only zero-primary-on-an-existing-roster exercises the `??`. A test
suite that covers "both" without knowing that covers one path twice.

This was my r1b #14. It appears in no ACCEPT, REJECT or DEFER row in the
adjudications - it was dropped, not ruled on. Cheapest fix: one Task 3 case
asserting the resolver's output for a zero-primary roster yields
`propertyContactFirstName: undefined`, and one Task 4 case feeding exactly that
shape and asserting `tour.en_route_self_guided`.

---

## 17. MEDIUM - Task 9 Step 5 inherits the seedLive edits without inheriting Task 6's Docker caution, so the drift guard silently skips at the task that changes it

**What is wrong.** The patch correctly moved `seedLive.test.ts:84` and `:219` to
Task 9 Step 5 and gave Task 6 Step 7 an explicit "with Docker UP... `describe
.skipIf(!reachable)` passes silently without it, and this file IS the drift
guard" (`:519-521`). Task 9 Step 6 says only "Run `cd app && npx vitest run` and
get it green" - no Docker caution.

`app/test/seedLive.test.ts:114` is `describe.skipIf(!reachable)`, and `:110-113`
warns on skip rather than failing. So the ONE task that edits the drift guard's
rung count can green a run in which the guard never executed. The caution belongs
in both places, or Task 9 Step 5 should require the file be run explicitly.

Also unenumerated in Step 5: `seedLive.test.ts:205-206`
(`expect(confirmation?.['skipReason']).toBe('quiet_hours_superseded')`) and
`:241`, both of which reference `confirmation` and both of which break.

---

## 18. LOW - the Self-Review was not patched, and now mis-cross-references the renumbered Task 12

**What is wrong.** The patch renumbered Task 12: the handback moved from Step 9
to Step 11 and Step 9 became the segment gate. The Self-Review (`:882-883`) still
says "Spec 9.3 ... is a consequence to state, carried by Task 12 **Step 9**" -
which now points at the segment-count gate.

It also still says "Spec 7.3 should be amended to say so" (`:879-880`) - the
amendment landed in round 2 - and its spec-coverage walk (`:865-872`) has no row
for the RESTORED spec 9.0 (three tour types / two wording buckets / routing),
which is a new spec section this round. The Self-Review is the plan's own
coverage proof; it currently proves coverage of a different document.

---

## 19. LOW - a fourth e2e spec is touched and is named in no document

**What is wrong.** `e2e/tests/tour-no-show-checkin.spec.ts` appears in no task,
no spec section, and no reviewer report. It is affected twice over:

- `:75` is a bare `tickTourReminders()` (the ninth, see finding 4). Its comment
  at `:71-73` - "Run the reminder poll past every armed rung's due time... The
  four legit rungs may land 1:1 (unasserted noise)" - is falsified: after Tasks 7
  and 9 that back-dated tour arms one visible `booked_too_late` row and nothing
  else, so the tick fires nothing and the absence assertion at `:76` passes
  vacuously.
- `:63-64` states "only the four remaining rungs; `no_show_checkin` is no longer
  auto-armed" - now three.

Low consequence (nothing goes red), which is exactly why it will survive as a
false comment on a spec that has quietly stopped proving its first half.

---

## 20. LOW - CONCEDING the REJECT on the "4 hours before" label, with one consequence to record

I contest nothing here. The reject is right and the reasoning is right: every
rung label is nominal under clamping, "Day before" has always carried the same
property, and `RemindersPanel.tsx:310` renders the label beside the row's ACTUAL
`dueAt`, so the operator has the real time in front of them. "Morning of" was
wrong at every setting; "4 hours before" is wrong only under a clamp. Different
category, correctly distinguished.

One consequence to record rather than argue: the label is also the accessible
name, `aria-label={\`Send ${kindLabel} reminder now\`}`
(`dashboard/src/routes/tours/RemindersPanel.tsx:347`), pinned as a contract at
`e2e/support/selectors.md:72`. After the relabel that button reads "Send 4 hours
before reminder now", which is grammatically rough for a screen reader. Task 12
Step 8 already owns updating selectors.md; whether the aria-label should read
differently from the visible label is a two-word decision worth making once,
deliberately, rather than discovering it in a screen-reader pass.

---

## Verified clean this round - recorded so nobody re-raises them

- **The inline Task 4 Step 1 tests are copy-correct against spec section 5.** I
  checked all six expectation strings character by character against spec
  `:97-102`, including the `pm_team`-takes-landlord-led case and the degrade. The
  `3:00 PM` rendering matches the existing fixture's own expectation for the same
  instant (`app/test/tourCopy.test.ts:29`).
- **`TOUR_TYPES` is a real export** (`app/src/lib/toursModel.ts:92`) and the
  matrix test's import resolves.
- **`docs/issues/consolidate-contact-display-name-helpers.md` exists**, so Task
  12 Step 10's `TODO(<slug>)` marker has a valid target.
- **The `booked_too_late` chip degrades safely on an old bundle** -
  `RemindersPanel.tsx:103` guards the label lookup, so a missing dashboard-side
  union entry renders "Skipped" rather than crashing (which is also why spec
  8.2's "change both, silently degrades" warning is the right framing).
- **Task 6 Steps 6-7 now leave `seedLive.test.ts` genuinely green**, as the patch
  claims. The twin at `:53-76` is a pure `computeDueAt` mirror; `:84-88`
  (`REMINDER_KINDS`) and `:219` (rung count) are untouched and still describe a
  five-kind ladder, which is still what the product arms until Task 9. My round-2
  blocker on this is correctly closed.
- **Task 8's "the obvious test is already green" warning is accurate** -
  `resolveReminderTarget:647` has no try/catch and the per-row catch at `:490-497`
  swallows the throw, leaving `sentAt` and `skippedAt` unset. Good catch, correctly
  written up.
