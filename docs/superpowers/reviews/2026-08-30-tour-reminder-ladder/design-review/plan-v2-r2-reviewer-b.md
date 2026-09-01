# Adversarial plan review - tour reminder ladder (plan v2, ROUND 2, reviewer B)

Plan: `docs/superpowers/plans/2026-08-26-tour-reminder-ladder.md` (revised, working
tree; HEAD is `6a9eb842`)
Spec: `docs/superpowers/specs/2026-08-26-tour-reminder-ladder-design.md` (frozen,
`bb4b0475`)
Also read: `.superpowers/design-review/plan-v2-r1-reviewer-a.md`

Round-1 verdict on the revision: it is a real improvement, not a patch job. All five
jointly-found issues are properly fixed, and every derivation I re-checked
independently - the new Task 7 case 9, the `max()` seed formula, the Test 1c/1d/1g
row counts, the `tour-no-show-checkin` re-derivation - is arithmetically correct.
What follows is what the revision still gets wrong, plus what all three of us missed
in round 1.

---

## 1. [HIGH] The no-show-checkin DRAFT is a FOURTH compose site, and Task 5's new
rule never reaches it - on the one path Phase A actually uses

Task 4 Step 8 routes `GET /:tourId/no-show-checkin-draft`
(`app/src/routes/tourReminders.ts:538-549`) through `resolveTourContactNames` +
`composeTourReminderBody`. Task 5 then enumerates the rule's consumers as "the send
path plus three hand-mirrored previews" (Task 2's predicate docblock, plan lines
276-285 and 616-619) and lists exactly three withhold sites: `bodyFor`,
`tourReminderBodyOrEmpty`, and the relayGroups IIFE (plan lines 1837-1868). Task 5's
**Files** block names only `bodyFor` inside `routes/tourReminders.ts`.

The draft handler is neither. And the predicate says this rung DOES need the failed
read: `needsTenantName = args.kind !== 'confirmation'` (plan line 628) is true for
`no_show_checkin`. So a throwing `contacts.getById(tour.tenantId)` on the draft path
returns `tenantReadFailed: true`, the composer renders
`Hi there! Do you need to reschedule?`, and the route answers 200 with it.

That text is then **prefilled into the founder's 1:1 composer and sent by hand** -
`e2e/tests/tour-no-show-checkin.spec.ts:92-102` is the flow. Under the pause,
manual sends are the only sends. So the single unenumerated site is the one where a
wrong-but-valid message reaches a tenant with no gate at all, which is precisely what
spec 6.3b exists to prevent.

This is enumerable from the spec: section 10 lists it separately ("Plus the
composer-bypassing no-show draft at `routes/tourReminders.ts:548`"), and the plan
DOES enumerate it in Task 4 - it drops it in Task 5. That is the feature's signature
failure mode (a fix landed in one copy and missed in another) reappearing inside the
fix for that failure mode.

Fix: one more `namesReadFailureBlocksCompose` consumer in the draft handler. What it
should DO on a block is a design call - `body: ''` gives the operator an empty
composer with no explanation, so a 409/`names_unavailable` shape (the same token
Task 5 already adds) is probably right, and would need a dashboard call-site check.
Either way, five consumers, not four.

## 2. [HIGH] `resolveTenantSuppression` still 500s the panel on the very read the
withhold is built to survive - and it makes the withhold unreachable on
`self_guided` tours

Spec 6.3b, verbatim:

> READ paths (the three preview surfaces) degrade to the absence fallbacks and MUST
> NOT throw. Each catches only `UncomposableReminderError` (`routes/tourReminders.ts:245`,
> `routes/contactTimeline.ts:727`, `routes/relayGroups.ts:262`), so an escaping repo
> error 500s the whole bucket.

Task 5's own `composeInputsOf` docblock asserts the requirement is met: "Read paths
must never 500 the ladder over a name" (plan line 1223). It is not.

`GET /api/tours/:tourId/reminders` calls `composeInputsOf` at `:417-418` (which now
swallows a throwing tenant read into `tenantReadFailed`), and then at `:458` calls

```ts
const evaluate = await resolveTenantSuppression(tour, config, contacts, conversations);
```

whose first statement is a **bare, uncaught** `await contacts.getById(tour.tenantId)`
(`app/src/routes/tourReminders.ts:540-541`). The handler is a plain
`async (req, res) =>` on Express `^5.2.1` (`app/package.json`), so a rejection goes
straight to the error handler: **500 for the whole ladder.**

Two consequences:

- The guard is gated on `tour.tourType === 'self_guided' && hasUpcoming` (`:428`).
  So for the DOMINANT tour type, a contacts outage 500s the panel before the withhold
  can matter - the feature Task 5 builds is unreachable there for tenant-read
  failures. It only functions on `landlord_led` / `pm_team` panels, where
  `suppressionOf` is never computed.
- No test notices, because both fixtures step around it: Task 4 Step 13 case 2 pins a
  `self_guided` tour whose **landlord** read throws (plan lines 1548-1555), and Task 5
  case 5 uses the `landlord_led` shared fixture. Neither throws the TENANT read on a
  `self_guided` tour.

Pre-existing, yes. But spec 6.3b names this exact hazard as an obligation of THIS
change, and the plan claims delivery. Either contain `resolveTenantSuppression` (a
try/catch that degrades to "no estimate", matching the existing best-effort posture)
or strike the claim from the docblock and record the gap - do not ship a plan whose
own comment is false.

## 3. [MEDIUM] The failure-scope predicate is a hand-maintained mirror of the catalog
copy, with nothing binding the two

`namesReadFailureBlocksCompose` (plan lines 621-634) encodes a needs-table:

```ts
const needsTenantName = args.kind !== 'confirmation';
const needsPropertyContact = args.kind === 'en_route' && args.tourType !== 'self_guided';
```

Both facts are read off the SHIPPED COPY, and the plan says so ("The needs table it
encodes, derived from the new copy", line 279-285). But spec section 6's entire token
contract exists so that a future wording change is *"a pure string edit"* - "Passing
all four makes a future wording change a pure string edit" - and every tour entry now
DECLARES all four name tokens precisely to enable that.

So the change the token contract is designed to make cheap is the change that
silently breaks the failure semantics. Add `{tenantFirstName}` to
`tour.confirmation` - a plausible Phase B edit, since that rung is under active
reconsideration - and the predicate still reports `needsTenantName: false`. A failed
tenant read then composes `Hey there, your tour is set for ...` and **sends it**:
the wrong-but-valid message 6.3b forbids, arrived at through the one edit the spec
told people was safe. Nothing fails: not typecheck, not `catalog.test.ts`, not the
exhaustive matrix (which never varies the failure flags).

This is the same drift class the spec names for the three hand-mirrored compose
blocks - the plan solved that one by centralizing on a shared predicate, then
introduced a new hand-mirror one layer down.

The guard is cheap, and Task 4's matrix already walks the exact space
(kind x tourType). Assert, for every pair, that the predicate's two `needs` booleans
agree with whether `MESSAGE_CATALOG[idFor(kind, hasStreet, hasName, tourType)].default`
actually contains `{tenantFirstName}` / `{propertyContactFirstName}`. That makes the
needs-table catalog-derived in test even while it stays hand-written in code.

## 4. [MEDIUM] The uniform `body: ''` withhold overrides an explicit spec instruction
in four of the five blocked cells, where nothing conflicts with it

*(Answering the coordinator's question on SPEC CONCERNS #1 directly.)*

Spec 6.3b: "READ paths ... **degrade to the absence fallbacks** and MUST NOT throw."
Spec 6.3a: "(absence fallbacks, **never a different ENTRY**)."

Those two only collide where the absence fallback IS a different entry. Enumerate the
cells the predicate blocks:

| blocked cell | absence fallback | different ENTRY? |
| --- | --- | --- |
| `en_route` x {`landlord_led`,`pm_team`} x (property\|unit) read failed | self-guided wording | **YES** |
| `day_before` x tenant read failed | `Hey there,` | no - same entry |
| `morning_of` x tenant read failed | `Hey there,` | no |
| `en_route`/`self_guided` x tenant read failed | `Hey there,` | no |
| `no_show_checkin` x tenant read failed | `Hi there!` | no |

For row 1 the plan's `body: ''` is the right and probably only answer. For rows 2-5
there is no conflict at all: 6.3b's instruction stands unopposed, and the plan
overrides it on a preview/send-agreement argument the spec never made - indeed 6.3b
deliberately gives read and send DIFFERENT postures ("READ paths degrade ... SEND
paths leave the rung UNCLAIMED"), so it had already accepted that they disagree
under failure.

The cost is concrete and asymmetric. On a tenant-read blip, `composeInputsOf` sets
`tenantReadFailed` once per request, so **every rung except `confirmation` renders a
blank body** - the panel reads as broken rather than as degraded. The spec's answer
would have shown `Hey there, confirming your tour tomorrow at 3:00 PM`, which is a
truthful preview of the copy shape and of what a retry will send.

The plan's SPEC CONCERNS #1 offers only an all-or-nothing alternative ("a one-branch
removal in Task 5"). The narrower split - withhold when the failure corrupts the
ENTRY CHOICE, degrade when it only blanks a TOKEN - is not on the table, and it costs
one extra boolean on the predicate's return. That is the reading the two spec
sentences actually support together.

I do not think this blocks the build. I think it is a decision presented as a
deduction, and it should be ruled on the narrow question ("blank the whole ladder, or
show `Hey there,` and blank only the landlord-led `en_route`?") rather than accepted
as forced.

## 5. [MEDIUM] Task 5 guard g3's fixture cannot exercise what it claims, and a
builder "fixing" it will invent a code path

g3 (plan lines 1711-1716): "`confirmation` force-send with the UNIT read and the
PROPERTY-CONTACT read **both** throwing - outcome `'sent'`."

Those two cannot both be true. `resolveTourContactNames` only attempts the
property-contact read inside `if (args.unit !== undefined)` (plan line 567), and
`composeBodyForRow` leaves `unit` as `undefined` when its own read throws (Task 4
Step 6, plan lines 1174-1182). With the unit read throwing, `propertyReadFailed` is
structurally always `false`.

The guard still proves the thing that matters (`unitReadFailed` + `confirmation`
composes and sends), so this is not a correctness hole - but a builder who writes the
test literally and finds `propertyReadFailed === false` has two bad options, and the
tempting one is to "fix" `resolveTourContactNames` so it reports a property failure it
never attempted. Restate g3 as two cases, or as "the unit read throwing (which is
also what suppresses the property read)".

## 6. [LOW] Task 5's shared fixture has two unstated preconditions on the 1:1
fallback path

The fixture is "a `landlord_led` tour with NO `groupThreadId` (group unusable, so
delivery falls back to the tenant 1:1)". That fallback runs two gates BEFORE compose,
neither of which the plan mentions:

- the D7 pending-open wait (`jobs/tourReminders.ts:770-782`), which for a
  non-`self_guided` tour returns WITHOUT claiming when
  `deps.pendingRosterActionsRepo` reports a pending `open_group` - producing exactly
  the observable state case 1 asserts (nothing sent, no `sentAt`, no `skippedAt`)
  under a DIFFERENT warn;
- `tenantRosterGate` (`:812`), whose `'unavailable'` branch also returns unclaimed,
  and whose `roster_unavailable` token is also a `ForceSendRefusal`.

Both are safe here in fact - `tourReminders.test.ts`'s `runDeps` omits
`pendingRosterActionsRepo`, and `memberFromContact` catches its own read throw
(`app/src/lib/rosterResolution.ts:166-171`) so `c-boom` cannot make the roster
unreadable - but that is two non-obvious facts a builder is not told, and Step 2 asks
them to confirm the red is "not a broken fixture". Case 1 is saved by asserting the
exact warn string; cases 2 and 4 assert the exact refusal reason, so a roster-driven
outcome fails rather than false-passes. State the preconditions anyway.

## 7. [LOW] Task 5 widens `bodyFor` a second time and never says which callers move

Task 4 Step 7 says `bodyFor` "gains `names: TourContactNames` after `address`" and
updates the GET/PATCH/send-now handlers. Task 5 Step 3 then adds three more
parameters (`flags.tenantReadFailed` / `propertyReadFailed` / `unitReadFailed`) but
its Files line reads only "`app/src/routes/tourReminders.ts` (`bodyFor`)". The five
call sites (`:323`, `:335`, `:379`, `:496`, and the PATCH 409 path) all need a second
edit in Task 5. Typecheck catches it; the omission just means Task 5's Step 4 run is
where it surfaces rather than its plan text.

---

## Contesting the adjudications

**The `en_route` marker.** The adopted fix is `"when you're on the way"` (plan lines
1477-1487). I byte-checked both new defaults: `tour.en_route_self_guided` ends
`...can you please text me when you're on the way?` and
`tour.en_route_landlord_led` ends `...Can you please text here when you're on the
way?`. The fragment is a verbatim substring of both, so spec 13's every-variant
invariant holds - the coordinator's concession is correct. The reason the longer
fragment is preferred over the bare `on the way` tail is also right and is now
written into the code comment: markers back ABSENCE assertions, and
`e2e/tests/scenarios/tours.spec.ts:139` relays a tenant-authored on-my-way text, which
a three-word marker would collide with. **I have no separate objection to the adopted
fix.** One note for the record: `no_show_checkin`'s marker
(`'Do you need to reschedule?'`) is likewise still present in both the named and
`there` variants, so that entry survives the D2 reversal unchanged.

**SPEC CONCERNS #1** - see finding 4. The reframing as a RESOLUTION is honest and the
"if the spec owner intended X, that is a one-branch removal" escape hatch is the right
shape. My objection is that the resolution is broader than the conflict that forces
it, and the alternative it offers is the wrong granularity.

**SPEC CONCERNS #2** - now correct, and correctly bounded. The scoping to "what the
copy needs" is the right call: 6.3b's blanket sentence read literally does reverse two
documented invariants, and the plan now edits BOTH docblocks in the same change (Task
5 Step 3, plan lines 1786-1794), which is what my r1 finding 2 asked for. The
unbounded re-list is now Phase B ledger item (7) with the `tourRemindersRepo.ts:56-64`
citation - that is the right home for it, since a plan appendix is not read at
unpause. Accepted.

**SPEC CONCERNS #4** - the framing correction is right; I verified it independently.
`seedLive.test.ts:204,207` already pins a `confirmation` stamped
`quiet_hours_superseded` by a `morning_of` that today is silently dropped, so the
behaviour predates this change. One precision the plan understates: in TOUR-A
specifically the superseding `morning_of` becomes a VISIBLE `booked_too_late` row
after Task 7, so this is not "easier to notice" - it is certain to be seen in the
dev/demo world from the first reseed. Ledger item (8) is still the right disposition.

**SPEC CONCERNS #5(c)** (new this round) - correct and worth having. Spec 9.1's
closing "Remove `confirmation` from `REMINDER_KINDS` only" really is the edit section
2 forbids, and a builder is told to read the spec fully first. Good catch by the
author; it was a miss in both round-1 reports.

---

## Coordinator's four verification questions, answered

**Does Task 5 actually deliver spec 6.3a?** For the memo half, YES - my r1 finding 1
is properly closed: the `failed` carrier now has four real consumers and is no longer
dead plumbing, and "never a different ENTRY" is satisfied trivially because no entry is
rendered when blocked. For the read-path half, PARTIALLY - see findings 1, 2 and 4:
one compose site never consults the rule, the panel 500s before the rule can run on
`self_guided`, and the rule is broader than 6.3b sanctions on four of five cells.

**Guards g1-g3 and the two docblock carve-outs.** g1 and g2 are reachable and will be
green: with `world.unitsRepo.getById` throwing, `resolveRoster` catches the unit read
(`rosterResolution.ts:258-266`) and returns a `'default'` roster containing the
tenant, so `tenantRosterGate` answers `'on'` and compose proceeds - g2's "still SENDS,
without an address" holds. g1's expected body `rungBody('day_before', scheduledAt)`
resolves to the `Hey there,` variant, which is correct because
`app/test/tourReminders.test.ts` contains ZERO `firstName` occurrences (re-verified
this round), and `rungBody`'s `self_guided` default is value-safe for `day_before`
because that entry does not fork on tour type. g3 is over-specified - finding 5. Both
docblock carve-outs are named with line numbers and are the right two.

**Task 7 case 9's derivation - VERIFIED CORRECT, independently.** quietOff, tour
`2026-07-23T19:00:00.000Z` (15:00 EDT), `now = 2026-07-23T18:30:00.000Z` (14:30 EDT):
`confirmation` dueAt `18:30Z` is neither `< now` nor `>= scheduledIso` (18:30 < 19:00)
and collides with no other slot, so it ARMS; `day_before` raw `Jul 22 23:30Z` with a
rule-1 cutoff of `Jul 22 19:30Z` is booked-too-late; `morning_of` raw `15:00Z` is
same-day (`localDateOf` both Jul 23) and past the `13:00Z` cutoff, so booked-too-late;
`en_route` raw `18:00Z < now` with no rule guarding it hits the untouched branch at
`jobs/tourReminders.ts:266` and writes NO row. Three rows total - exactly as stated.
The asserted log string `'tour reminder skipped (dueAt in the past)'` is byte-exact
against `:267`. The case genuinely repays the coverage debt: `en_route` is the
branch's surviving witness and nothing intercepts it.

**Task 10's `canceledAt = max(sched - 6h, dueAt + 1h)` - HOLDS at every wall clock.**
`dueAt <= canceledAt` by construction. `createdAt <= dueAt` still holds
(`createdMs = scheduledMs - (2+rep) * DAY_MS`, i.e. 3-5 days out, versus a dueAt ~1 day
out). And `canceledAt < scheduledAt` survives, which the old comment promised: when the
tour's local time-of-day `T >= 02:30`, `sched - 6h >= 20:30` on D-1 and the max picks
it; when `T < 02:30` the max picks `20:30 D-1`, which is still before any `T` on day D.
At the coherence test's pinned `NOW` (`2026-07-03T12:00:00.000Z` = 08:00 EDT,
`seedMatrixCoherence.test.ts:29`) the max picks `sched - 6h` exactly as today, so the
suite sees no churn. `HOUR_MS`, `iso()` and `dayBeforeDueAt` are all in scope at
`matrix.ts:995`.

**The `export type { TourContactNames } from '../lib/tourContacts.js'` re-export -
RESOLVES, and creates no layering problem.** `tourContacts.ts` exports the interface;
an explicit `export type ... from` is erased at emit by `tsc` regardless of
`isolatedModules`/`verbatimModuleSyntax` (neither of which is set -
`tsconfig.base.json` has no occurrence of either), and esbuild/tsx erase it
syntactically. The e2e bundle therefore never pulls `unitContacts` ->
`repos/unitsRepo.js` -> AWS SDK. `namesReadFailureBlocksCompose` stays a VALUE export
of that same server-only module and is imported only by `jobs/` and `routes/`, which
is correct.

---

## What I re-verified this round and found CORRECT (do not redo)

- `armedReminderDueAt`'s `${NEXT}` resolves: `e2e/scenarios/steps.ts:43` defines it,
  and the promoted pattern is real at `e2e/tests/tour-roster.spec.ts:495-501`.
- `tour-comms-pane.spec.ts`'s local `createContact` returns a `Party` carrying
  `firstName` (`:78-105`), so Task 4 Step 11's `names: { tenantFirstName: tenant.firstName }`
  compiles at `:230`.
- `scheduled-visibility.spec.ts` Part A's `:101` destructure really is
  `const { unit, times } = ...`; the plan now says to add `tenant`. My r1 finding 12 is
  closed.
- `tours.spec.ts` sets `activeTenant` before `teamCreatesTourFromInterest`
  (`searchingTenantOwnerUnit` calls `teamCreatesTenant` at `:87-91`), and the plan
  records `tenantFirstName` at tour-creation time, so later `activeTenant` mutations
  cannot poison a body composed afterwards. There is exactly ONE
  `this.activeTour = ...` site (`steps.ts:1720`).
- Reminder-writer enumeration is COMPLETE: three `tourRemindersRepo.create` calls, all
  inside `armTourReminders` (`jobs/tourReminders.ts:274, 298, 311`); three raw seed
  writers (`seed/{cast,live,matrix}.ts`); `armTourReminders` has exactly two production
  callers (`routes/tours.ts:350`, `:1178`) plus three seed calls
  (`seed/live.ts:505,516,526`) and zero callers in `app/scripts`, `e2e`, `scripts` or
  `dashboard`. `routes/api.ts:903` is a comment, not a third arm site.
- No second staff-facing rung-label surface exists: `REMINDER_KIND_LABELS` has one
  consumer (`RemindersPanel.tsx:310`), and `ScheduledCard.tsx` labels by SOURCE
  (`tour_reminder: 'Tour reminder'`), not by kind. `dashboard/src/api/types.ts:2391`
  inlines the kind union on `TimelineScheduled` but renders no label from it.
- `routes/placements.ts:716` reads reminders only to `cancelTourReminders` - unaffected.
- Test 1c's row counts: 4 rows / 3 unskipped after the retime (confirmation `Jan 19
  15:00Z`; day_before `Jan 20 00:30Z`, outside the window and not `staleDayBefore`
  since its local date is Jan 19 vs the tour's Jan 20; morning_of `Jan 20 23:00Z`;
  en_route clamped to `Jan 21 13:00Z` >= the `Jan 21 03:00Z` start -> `past_event`).
  Test 1d: 4 rows / 3 unskipped. Test 1g's `:462` array becomes
  `['confirmation','day_before']` in creation order (`REMINDER_KINDS` order, no
  `.sort()` on that assertion). All three match the plan.
- The `tour-no-show-checkin.spec.ts` `:64` re-derivation is now CORRECT: a 26h-past
  `scheduledAt` always crosses at least one local midnight, so rule 2's `sameDay` never
  fires; `morning_of`/`en_route` raws are past and write no row; `day_before` is
  `booked_too_late`; `confirmation`'s dueAt (the arm instant) is `>= scheduledIso`, so
  it is born `past_event` and NOTHING is pending. My r1 finding 11 is closed.
- Task 9 Step 4's split anchoring is right, and reviewer A's finding 1 is correctly
  adopted: test (3) never ticks and needs the WALL CLOCK inside the window for the
  bypass to mean anything, so keeping `windowAroundNow()` there is necessary.
  Test (2)'s fixed `[17:30, 21:30)` works because the panel's quiet flag is per-ROW -
  `(dueAt > now && isQuietTime(dueAt, window)) || (wallClockQuiet && dueAt <= now)`
  (`routes/tourReminders.ts:459-461`) - and the rung's 19:30 org-local dueAt is future
  and inside the window at any hour. `orgLocalHhMm` correctly survives.
- Task 3's precision fix is right: `REMINDER_SKIP_REASON_LABELS` is
  `Readonly<Record<NonNullable<TourReminderView['skipReason']>, string>>`
  (`dashboard/src/api/types.ts:1262-1263`), so half-adding hard-fails typecheck while
  omitting the union entirely degrades silently. My r1 finding 15 is closed.
- Task 8 Step 1 now covers the second aria template's pins at
  `RemindersPanel.test.tsx:418, 424, 433`. My r1 finding 11 is closed.
- Task 4 Step 8 now deletes the orphaned `resolveMessage` import at
  `routes/tourReminders.ts:43` and re-derives the existing draft pin at
  `toursApi.test.ts:1494-1508` IN THIS TASK's commit. My r1 findings 3 and 4 are closed.
- Task 7 case 8's negative half now uses
  `stubSettingsRepo({ quietHoursEnabled: false, quietHoursStart: '19:00' })` with the
  reason spelled out. My r1 finding 8 / A5 is closed.
- Task 5 case 7 now asserts per-unit NAME correctness on the contact timeline, having
  corrected the false claim that the walk carries only `self_guided` tours
  (`contactTimeline.ts:883-899` includes non-`self_guided` tours with an unusable
  group). My r1 finding 5 is closed.
