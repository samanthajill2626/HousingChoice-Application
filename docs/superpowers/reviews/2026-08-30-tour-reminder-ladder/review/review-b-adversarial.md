# Adversarial review B - feat/tour-reminder-ladder

Scope: merge base `440dc75e` -> `268554ef`, read fresh from the code and its
tests. Verification was done with throwaway `tsx` probes against the worktree's
own modules (in the session scratchpad, nothing written into the repo). No
suite was run - the e2e lane is held.

Seven findings: one HIGH, one MEDIUM, five LOW. Nothing BLOCKING.

---

## 1. HIGH - CONFIRMED - a `booked_too_late` rung still supersedes the confirmation, so an early same-day booking silently loses the confirmation and blames a rung that will never fire

`app/src/jobs/tourReminders.ts:406-412` (the `supersededBySlot` predicate),
interacting with the new `bookedTooLate` branch at `:362-383`.

### What breaks

`supersededBySlot` asks only two questions of the later rung: does its CLAMPED
`dueAt` equal mine, and is that `dueAt` before the tour start.

```ts
const supersededBySlot = REMINDER_KINDS.some((other) => {
  if (LADDER_ORDER.indexOf(other) <= myOrder) return false;
  const otherDue = dues.get(other);
  // The later rung must itself be armable (not past-event) to supersede.
  return otherDue === dueAt && otherDue < scheduledIso;
});
```

The comment says "the later rung must itself be armable" - but that check only
excludes rule (b), `past_event`. The new rule (e), `booked_too_late`, is
evaluated per-rung LATER in the same loop and is invisible to this predicate.
So a rung that has already been retired `booked_too_late` still counts as a
valid superseder, and the earlier rung is retired citing it.

Before this branch the same code was honest: `morning_of` was `08:00`
org-local (`git show 440dc75e:app/src/jobs/tourReminders.ts`, the `computeDueAt`
switch), i.e. exactly the quiet-hours clamp target, and there was no rule that
could retire it - a confirmation clamped onto its slot really was superseded by
a rung that fired. The retiming to `scheduledAt - 4h` plus rule (e) is what
turned the superseder into a corpse.

### Concrete input (reproduced)

Org defaults: quiet hours ON, `21:00-08:00`, `America/New_York`.

- tour `2026-07-23T14:00:00.000Z` (10:00 EDT)
- arm at `2026-07-23T09:00:00.000Z` (05:00 EDT - a 7am-ish same-day booking)

Probe output (real `armTourReminders` against an in-memory repo):

```
raw confirmation  = 2026-07-23T09:00:00.000Z
raw day_before    = 2026-07-22T23:30:00.000Z
raw morning_of    = 2026-07-23T10:00:00.000Z   (sched - 4h, 06:00 EDT, quiet)
raw en_route      = 2026-07-23T13:00:00.000Z

-> confirmation  dueAt=2026-07-23T12:00:00.000Z SKIPPED:quiet_hours_superseded
-> day_before    dueAt=2026-07-22T23:30:00.000Z SKIPPED:booked_too_late
-> morning_of    dueAt=2026-07-23T12:00:00.000Z SKIPPED:booked_too_late
-> en_route      dueAt=2026-07-23T13:00:00.000Z ARMED
```

Both the confirmation (05:00 EDT, quiet) and `morning_of` (06:00 EDT, quiet)
clamp to the same 08:00 EDT = `12:00Z`. `morning_of` is then retired
`booked_too_late` (same local date, `09:00Z > 14:00Z - 6h`). The confirmation
was already retired citing it.

The reachable band is not exotic: `now` inside the quiet window on the tour's
own local date (i.e. between local midnight and 08:00), a tour starting between
roughly 08:00 and 12:00 local, booked less than six hours out. A 07:00 booking
for a 10:00 same-day tour hits it. The evening side of the window is safe
(`localDateOf(now) !== tourLocalDate`, so rule (e) does not fire for
`morning_of`).

### Consequences

- The panel shows `Skipped - superseded by a later reminder` on the
  confirmation next to `Skipped - booked too late for this reminder` on the
  rung that allegedly superseded it. Two of the three rungs are gone and the
  stated reason for one of them is false.
- A skipped row is terminal: `forceSendReminder` returns `not_pending`
  (`app/src/jobs/tourReminders.ts:1371`), and `RemindersPanel` renders Send
  now / Cancel only for `upcoming` / `canceled`
  (`dashboard/src/routes/tours/RemindersPanel.tsx:346,359`). `uncancel`
  requires `attribute_exists(canceledAt)`. So the operator has **no way to send
  the confirmation at all** - the rung the branch's own comment calls "the rung
  with the strongest case for staying automatic".
- Today the manual-only pause means nothing auto-sends, so the practical loss
  is the Send-now button plus a lying chip. The moment
  `MANUAL_ONLY_REMINDER_KINDS` is emptied ("TO RESTORE: empty this set"), the
  tenant simply never receives a confirmation for that booking.

### The branch already ships this in the demo seed

`app/test/seedLive.test.ts` was rewritten in this diff to assert exactly the
broken shape and reads it as correct:

```
const pending = rows.filter((r) => r['skippedAt'] === undefined);
expect(pending.map((r) => r['kind']).sort()).toEqual(['en_route']);
...
expect(morningOf?.['skipReason']).toBe('booked_too_late');
const confirmation = rows.find((r) => r['kind'] === 'confirmation');
expect(confirmation?.['skipReason']).toBe('quiet_hours_superseded');
```

and the accompanying comment still explains the confirmation as "it is clamped
to 08:00 EDT, where it collides with morning_of and loses the slot to it" -
written as if `morning_of` were alive. It is not. Before this branch the same
assertion read `['en_route', 'morning_of']`, so the demo world really did send
an 08:00 rung.

Nothing in `app/test/tourReminders.test.ts` catches it either: every
booked-too-late case (1..9) arms with `quietOff`, so the confirmation never
clamps onto anything.

### What I would change

Make `supersededBySlot` ask "will the superseder actually fire", not "is it
merely not past-event". The cheapest correct shape is to decide every rung's
retirement in a first pass and let supersession consult that decision:

```ts
// pass 2a: decide retirements, no writes
const retired = new Map<ReminderKind, ReminderSkipReason>();
for (const kind of REMINDER_KINDS) { /* bookedTooLate / past-dueAt / past_event */ }
// pass 2b: supersession consults `retired`
const supersededBySlot = REMINDER_KINDS.some((other) =>
  LADDER_ORDER.indexOf(other) > myOrder &&
  dues.get(other) === dueAt &&
  !retired.has(other),
);
```

If a restructure is too much for this branch, the minimum is to exclude
`booked_too_late` superseders explicitly (the `bookedTooLate` expression is
already a pure function of `kind`, `raws`, `now`, `tourLocalDate` - hoist it
into a small helper and call it for `other` too). Either way, the confirmation
must survive when its superseder does not.

Add a test with quiet hours ON and `now` inside the window on the tour's own
local date - the whole booked-too-late suite currently uses `quietOff`, which
is precisely why the hole is open.

---

## 2. MEDIUM - CONFIRMED (composer) / PLAUSIBLE (end to end) - a `{token}` inside a contact's first name is expanded into the outbound SMS, and first names come from an unauthenticated public endpoint

`app/src/messages/resolve.ts:24-45` (`interpolate`) +
`app/src/messages/catalog.ts:99-103` (`TOUR_NAME_VARS`) +
`app/src/messages/tourCopy.ts:80-121`.

### What breaks

`interpolate` walks `def.vars` **in declaration order** and does a plain
`split/join` per token. Every tour entry now declares six-plus tokens
(`TOUR_NAME_VARS` = `when, time, tenantFirstName, tenantName,
propertyContactFirstName, propertyContactName`, plus `where` / `addressLine`),
with the name tokens BEFORE `where` / `addressLine` and `tenantFirstName`
before `propertyContactName`. A token string substituted early is therefore
re-scanned by every later token in the list.

Before this branch the tour entries interpolated only `when` / `time` /
`where`, all derived from staff-entered or system data. Newly interpolating
contact-supplied names is what activates the hazard.

### Concrete input (reproduced)

Probe against the real `composeTourReminderBody`:

```
day_before, tenantFirstName = "{propertyContactName}":
  Hey Dana Ortiz, confirming your tour tomorrow at 3:00 PM. Does that still work for you?

day_before, tenantFirstName = "{where}", address supplied:
  Hey 412 Oak St Apt 2, confirming your tour tomorrow at 3:00 PM. Does that still work for you?

morning_of, tenantFirstName = "{addressLine}", address supplied:
  Hey Address is 412 Oak St Apt 2., looking forward to having you tour at 3:00 PM today. ...

en_route landlord_led, tenantFirstName = "{propertyContactName}":
  Hey Dana Ortiz, Dana will be headed that way shortly. ...
```

### Reachability

`app/src/routes/public.ts` - `POST /public/housing-fair`, unauthenticated -
accepts `firstName` as an arbitrary string, `trim()`ed and length-capped only
(`:106-110`), and creates/dedupes a tenant contact from it. That contact's
`firstName` is read live by `resolveTourContactNames`
(`app/src/lib/tourContacts.ts:39-43`) and handed straight to the composer. The
same is true of any AI-extracted `firstName` (the extraction decision targets
include `firstName`) and of staff free-text.

The leak is modest but real: `{propertyContactName}` renders the landlord's or
PM's full name into a tenant-facing SMS (and into the group-thread system
announcement), and `{where}` / `{addressLine}` render the unit street. It also
lands on the group route, where the message goes to every member.

`app/test/tourCopy.test.ts`'s exhaustive matrix asserts
`expect(body).not.toMatch(/\{[A-Za-z]/)`, but only over the fixed `NAMES`
fixture, so it cannot see this.

### What I would change

Substitute all declared tokens in a single pass rather than sequentially, so a
value can never be re-scanned:

```ts
out = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (m, token) =>
  allowed.includes(token) ? (vars?.[token] ?? throwOrEmpty(token)) : m);
```

That preserves both current behaviours (undeclared tokens left literal; strict
throw on a declared-but-missing var) and closes the reflection. A narrower
alternative is to strip `{` / `}` from resolved names in
`lib/tourContacts.ts`, but the single-pass fix protects every catalog entry,
not just the tour ones.

---

## 3. LOW - PLAUSIBLE - `{where}` is still declared on the entries that lost their `_no_address` twin, so re-adding it to a default throws a bare `Error` past every containment block

`app/src/messages/catalog.ts:143-181` (`tour.day_before`, `tour.morning_of`,
both `tour.en_route_*` all declare `where`) +
`app/src/messages/tourCopy.ts:118` (`...(street.length > 0 && { where: street })`).

The `_no_address` twin mechanism existed precisely so the addressless entry did
not declare `{where}`. This branch removed the twins for `day_before`,
`morning_of` and `en_route` but kept `where` in `vars` on the surviving single
entry - and `where` is only supplied when the street is non-empty. So the first
"pure string edit" that puts `{where}` back into one of those defaults makes
every addressless tour hit `interpolate`'s strict path and throw
`Error('resolveMessage: missing interpolation var "where"')`. That is neither
`UncomposableReminderError` nor `ReminderNamesUnavailableError`, so:

- `routes/tourReminders.ts:313-328`, `routes/contactTimeline.ts` and
  `routes/relayGroups.ts` all rethrow it -> 500 on the whole ladder read;
- `jobs/tourReminders.ts:1023-1040` rethrows it into the per-row catch -> the
  rung is never claimed and re-lists every tick forever.

The catalog comment actively invites the edit ("declaring is what lets a future
wording change be a pure string edit") and `app/test/tourCopy.test.ts` pins
`morning_of declares BOTH where and addressLine (spec 6.4: where stays for
future edits)`.

Mitigation that exists: the exhaustive compose matrix in `tourCopy.test.ts`
iterates the `no-addr` branch and would go red. That is why this is LOW rather
than MEDIUM. Still worth either dropping `where` from the three
`addressLine`-era entries or passing `where: street` unconditionally (empty
string when absent) so the failure mode is a missing clause, not a throw.

---

## 4. LOW - CONFIRMED - the `booked_too_late` operator label is false on the reschedule and revival paths, and the code comment misquotes it

`app/src/jobs/tourReminders.ts:352-355` says:

> `now` is the ARM instant, so a reschedule or a status revival re-evaluates
> both rules against THAT moment (spec 11 - which is why the operator label
> says the reminder was armed too late, not that the operator was slow).

The actual label is `dashboard/src/api/types.ts:1280`:

```
booked_too_late: 'booked too late for this reminder',
```

which says the opposite of what the comment claims it says. The branch's own
tests demonstrate the misattribution: `app/test/toursApi.test.ts` case 7b
revives a tour booked days earlier and asserts `booked_too_late` on both rungs.
A navigator reading "booked too late for this reminder" on a tour booked a week
ago, on a canceled-then-restored tour, will not connect it to the revival.

Either fix the label ("armed too late for this reminder" / "reminder armed too
close to its send time") or fix the comment. Right now one of the two is wrong
wherever a reader lands.

---

## 5. LOW - CONFIRMED - three comments now assert timings the retiming removed

None of these are in the diff; all three were made false by it.

- `app/src/repos/settingsRepo.ts:133-135` - "IANA org timezone ... also used by
  the `morning_of` tour reminder". `morning_of` is now a pure
  `scheduledAt - 4h` UTC offset and reads no timezone; `day_before` is the rung
  that anchors to the org zone. A reader tracing "who depends on the org
  timezone" is sent to the wrong rung.
- `dashboard/src/api/types.ts:125-126` - the same sentence, duplicated.
- `e2e/tests/scenarios/scheduled-visibility.spec.ts:87-90` - still explains the
  fixed 14:00 booking by "a pre-08:00 tour whose morning_of is born skipped
  (past_event)". That mechanism cannot recur (the branch's own issue update
  says so); the fixed hour is now load-bearing for a different reason, which
  `e2e/scenarios/steps.ts:303-322` documents but this comment does not.

---

## 6. LOW - PLAUSIBLE - `resolveTourContactNames` mirrors the roster default-rung rule but drops its de-dupe, and it names the UNIT's contact rather than the tour's actual roster

`app/src/lib/tourContacts.ts:88-107` documents itself as reproducing
"the established rule (lib/rosterResolution.ts:273-275)". Two divergences:

1. `rosterResolution.ts:280` skips the property contact when it IS the tenant
   (`if (propertyContactId !== tenantId)`). The copy has no such guard, so a
   unit whose primary contact is the tour's own tenant composes
   `Hey Alice, Alice will be headed that way shortly.` Rare, but it is exactly
   the kind of thing a hand-duplicated rule loses.
2. It always resolves the UNIT's primary contact / landlord of record, never
   the tour's resolved roster. For a `landlord_led` tour whose relay roster was
   edited (the owner removed, a PM added - the case
   `rosterResolution.resolveRoster` exists to serve), the en_route copy names
   somebody who is not on the thread it is sent into. The catalog comment
   asserts the unit's primary contact "is what makes the sentence true for a
   PM-run tour", which holds only while the roster equals the unit default.

If (2) is a deliberate ruling, say so at `tourContacts.ts` rather than at the
catalog entry, because `tourContacts.ts` is where the next reader will look for
the roster it did not consult.

---

## 7. LOW - CONFIRMED - each re-arm of a short-horizon tour now appends two permanent skipped rows, and `TourTimes.morningOf` is a new unread mirror

Two small consequences of the change that nothing in the diff addresses.

**(a) Skipped-row accumulation.** `routes/tours.ts:1177-1182` does
`cancelTourReminders` + `armTourReminders` on every reschedule and every
explicit move into `scheduled`. `cancelForTour` deliberately leaves skipped
rows alone (they are already terminal), and `armTourReminders` now WRITES rows
where it used to write nothing. So each re-arm of a same-day / next-morning
tour adds a fresh `booked_too_late` `day_before` and `morning_of` to the panel
forever. Three reschedules leave six terminal skipped rows plus the canceled
ones, sorted ahead of the live ladder because their `dueAt` is in the past.
The old silent drop kept that noise out. Worth at least deciding whether the
panel should collapse duplicate terminal rows per kind.

**(b) Dead mirror.** `e2e/scenarios/steps.ts:270,346` adds `morningOf` to
`TourTimes` as a hand-written mirror of `computeDueAt('morning_of')`. Nothing
reads it (`grep -rn "morningOf" e2e/` returns only the declaration, the
assignment and two docblocks). The very docblock that adds it explains that
`morning_of` was previously REMOVED from this struct because it "was never read
by any spec, so it was removed rather than left as a wrong answer waiting to be
used" - and the field it replaces, `dayBefore`, was removed for the same
reason. Either give it a reader or drop it.

---

## Checked and clean

Stated plainly so the next reviewer does not redo it:

- The five `composeTourReminderBody` call sites in `app/src` all pass the new
  required `tourType` / `names` (the compiler enforces it), and
  `tourCopyCallSites.test.ts` now allows zero direct `resolveMessage('tour.*')`
  - the `no_show_checkin` exemption was correctly removed along with its
  justification.
- No stale reference anywhere outside `docs/` to the four deleted catalog ids
  or to the pre-rewrite copy strings.
- The three duplicated `body: ''` preview copies
  (`routes/tourReminders.ts` `bodyFor`, `routes/contactTimeline.ts`
  `tourReminderBodyOrEmpty`, `routes/relayGroups.ts`) carry the same two rules
  in the documented order, and the group thread renders through the SAME
  `ScheduledCard` the contact timeline does
  (`ConversationDetail.tsx:480` -> `Timeline.tsx:2079`), so the new
  "Preview unavailable" sentence covers all three surfaces.
- `createFakeWorld`'s `tourRemindersRepo.create` was genuinely drifted from the
  real repo (it dropped `input.skipped`); this branch fixes it, which is what
  makes the arm-time skip reasons assertable off DynamoDB Local at all.
- `assessNamesReadFailure`'s derived table matches the catalog templates I read
  by hand for all five kinds x three tour types, and the "tripwire" test really
  does pin the dead `tokenBlanked` disjunct.
- `nextReminderRefetchDelay` skips non-`upcoming` rows, so past-dated
  `booked_too_late` rows cannot drive the panel's self-refetch timer.
- `shiftLocalDate` is zone-free string arithmetic and the DST cases in
  `computeDueAt.test.ts` are correct (I re-derived the spring-forward pair).
- `matrix.ts`'s `canceledAt = max(sched - 6h, dayBeforeDueAt + 1h)` keeps
  `createdAt <= dueAt <= canceledAt <= scheduledAt` for every time-of-day
  (the minimum `dayBefore -> tour` gap is 4.5h, at a 00:00-local tour).
- The `hasText: '4 hours before'` collision analysis in
  `e2e/scenarios/steps.ts:3488-3499` holds: no tour catalog default contains
  "hour", and `sendRelative` emits `Nh`, not `N hours`.
