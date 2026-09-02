# Reader B - routes + dashboard + seeds worklist (plan Tasks 2, 8, 9-seeds, 12)

Base: worktree `W:\tmp\tour-reminder-ladder-phase-b`, branch `feat/tour-reminder-ladder-phase-b`, main @ec32170a.
Every line number below was located BY NAME and re-read in the live tree.

---

## 0. Anchor verification (plan -> truth)

| plan anchor | true anchor | verdict |
|---|---|---|
| `tourRemindersRepo.ts:38` ReminderSkipReason | decl `:38`, members `:39-78` (last `booked_too_late` `:78`) | OK |
| types.ts `TourReminderView.skipReason` `:1207-1223` | key `:1208`, union `:1209-1223` | OK (off by 1) |
| types.ts `REMINDER_SKIP_REASON_LABELS` `:1271` | `:1271-1284` | OK |
| types.ts `SEND_NOW_ERROR_COPY` `:1294` | `:1294-1338`; `sendNowErrorMessage` `:1341-1343` | OK |
| types.test.ts `SKIP_REASONS` `:95` | `:95-106`; label tests `:108-127` | OK |
| types.ts suppression union `:1144-1177` | union `:1144-1150`, `ScheduledSuppression` `:1153-1155`, `suppressionLead` `:1167-1171`, `suppressionNote` `:1175-1177` | OK |
| types.ts `REMINDER_SUPPRESSION_LABELS` `:1259-1268` | `:1259-1268` | OK |
| `DeadlinesNudgesCard.tsx:64` | `:64-73` | OK |
| route chip branch `:576-597` / `:589-597` | `paused` `:589`, ternary `:590-597`, view `:598-609` | OK |
| route quiet estimate `:558-564` | try `:558`, `evaluate(...)` `:561-564`, disjuncts `:562` | OK |
| `viewOf` `:336-345` | `:336-349` | OK |
| `TourReminderView` `:138` | `:138-152` | OK |
| `contactTimeline.ts` seam `:115` | docblock `:112-117`, field `:118` | OK |
| `routes/api.ts:389` seam | docblock `:391-397`, field `:398` (`:389` is the `*/` of unreadWalkLimit) | DRIFT, minor |
| `routes/tourReminders.ts:110` seam | docblock `:107-116`, field `:117` | OK |
| `dev.ts:404-422` divergence | comment `:404-418`, call `:419-422` | OK |
| `matrix.ts:987` "seeds a pending confirmation row" | `:983-992` seeds a **SENT** row (`sentAt: createdAt`) | **DRIFT, see D1** |
| `tours.spec.ts:283-287` cat-4 | comment `:282-286`, tick+assert `:287-288` | OK (off by 1) |
| `tour-roster.spec.ts:488-501` | block `:480-523` (assertion at `:516-523`) | DRIFT, range too short |
| `scheduled-visibility.spec.ts:234-259` / `:111-165` | `(c)` test `:217-260`; panel walk `:104-167` | OK approx |
| `steps.ts:2013-2046` tick helpers | `armedReminderDueAt` `:2019-2031`, `tickTourReminders` `:2039-2046`, docblock `:2033-2038` (`:2035` claim true) | OK |

---

## 1. Dashboard `dashboard/src/api/types.ts` - byte-exact

`ScheduledSuppressionReason` (`:1144-1150`):

```ts
export type ScheduledSuppressionReason =
  | 'sms_sending_disabled'
  | 'contact_opted_out'
  | 'manual_mode'
  | 'stale_stage'
  | 'quiet_hours'
  | 'paused';
```

`suppressionLead` (`:1167-1171`) / `suppressionNote` (`:1175-1177`):

```ts
export function suppressionLead(reason: ScheduledSuppressionReason): string {
  if (reason === 'quiet_hours') return 'Will wait';
  if (reason === 'paused') return 'Paused';
  return 'Will be skipped';
}
export function suppressionNote(reason: ScheduledSuppressionReason, label: string): string {
  return `${suppressionLead(reason)} ${EM_DASH} ${label}`;
}
```

`EM_DASH` is `:1158`: `const EM_DASH = String.fromCharCode(0x2014);` (module-private).

`TourReminderView` (`:1191-1228`) - fields in order: `reminderId`, `kind`, `dueAt`,
`state: 'upcoming' | 'sent' | 'canceled' | 'skipped'`, `sentAt?`, `canceledAt?`,
`skippedAt?`, `skipReason?`, `body: string`, `suppression?`. `skipReason` union (`:1208-1223`),
in order: `no_conversation | contact_missing | contact_no_phone | tour_missing |
quiet_hours_superseded | past_event | tenant_not_on_roster | roster_unavailable |
invalid_schedule | booked_too_late`. NO `overdue` key exists anywhere today (Task 12 is
purely additive; grep `overdue` in types.ts = 0 hits).

`REMINDER_SUPPRESSION_LABELS` (`:1259-1268`) - the map that renders the TOUR chip:

```ts
export const REMINDER_SUPPRESSION_LABELS: Readonly<
  Record<NonNullable<TourReminderView['suppression']>['reason'], string>
> = {
  sms_sending_disabled: 'SMS sending is off',
  contact_opted_out: 'contact opted out',
  manual_mode: 'manual mode',
  stale_stage: 'tour no longer at this stage',
  quiet_hours: 'quiet hours',
  paused: 'send manually',
};
```

`REMINDER_SKIP_REASON_LABELS` (`:1271-1284`) - ten entries, keyed off
`NonNullable<TourReminderView['skipReason']>`, so the three new tokens are a compile break here.

`SEND_NOW_ERROR_COPY` (`:1294-1338`) is module-private (`const`, not exported); the only
export is `sendNowErrorMessage` (`:1341-1343`), fallback string
`"Couldn't send that just now - please try again."`. Existing keys relevant to precedence:
`names_unavailable` (`:1317-1318`) ALREADY exists with cause-agnostic copy
`'Could not look up everything this message needs, so nothing was sent - please try again.'`
-> the plan's PERMANENT_REFUSALS test must NOT include it (it already differs from the
fallback, so the test would pass vacuously either way; the plan's comment says it is
deliberately absent, but the key IS present with copy - fix the comment).

`types.test.ts` shape: `SKIP_REASONS` `:95-106` is a plain `string[]` (deliberately not typed
against the union - the comment at `:87-94` says so). Three label tests: `:109` "carries a
staff-facing label for every reason the app can send" (loops SKIP_REASONS), `:118` exact-keys
(`Object.keys(...).sort()` vs `SKIP_REASONS.sort()`), `:122` "never puts a machine token in
front of staff" (`not.toContain('_')` over every label VALUE). The file already imports
`sendNowErrorMessage` (`:4`), so the new SEND_NOW describe needs no import change.

---

## 2. `app/src/services/scheduledSendSuppression.ts` + every consumer

Union (`:1-4`, byte-exact, note the two-per-line formatting):

```ts
export type ScheduledSuppressionReason =
  | 'sms_sending_disabled' | 'contact_opted_out' | 'manual_mode' | 'stale_stage'
  | 'quiet_hours' | 'paused';
export interface ScheduledSuppression { reason: ScheduledSuppressionReason; }
```

Evaluator precedence (`:43-60`): kill-switch -> opt-out -> manual -> stale_stage ->
**paused** -> quiet_hours -> undefined.

| consumer | file:line | breaks on widening? |
|---|---|---|
| evaluator return | `app/src/services/scheduledSendSuppression.ts:42` | no |
| tour route type import + field | `app/src/routes/tourReminders.ts:64,151,499,560,725` | no |
| timeline type import + field + closure | `app/src/routes/contactTimeline.ts:99,251,850` | no |
| placement-nudge route | `app/src/routes/placementNudges.ts:71,144,389` | no |
| dashboard union mirror | `dashboard/src/api/types.ts:1144,1153,1167,1175` | edit site |
| dashboard field uses | `dashboard/src/api/types.ts:1227,1534,2428` | no |
| **Record 1** `REMINDER_SUPPRESSION_LABELS` | `dashboard/src/api/types.ts:1259-1268` | **YES** |
| **Record 2** `SUPPRESSION_COPY` (timeline card) | `dashboard/src/routes/contact/ScheduledCard.tsx:19-33` | **YES** |
| **Record 3** `NUDGE_SUPPRESSION_LABELS` | `dashboard/src/routes/placements/DeadlinesNudgesCard.tsx:64-73` | **YES** |

Grep-verified: exactly three exhaustive `Record`s repo-wide
(`Record<ScheduledSuppressionReason` / `Record<NonNullable<...['suppression']>['reason']`).
The plan's count of three is CORRECT.

Equality-tested label FUNCTIONS the typecheck cannot see (all three need a `discontinued`
branch or they fall through to a fire-time promise):

- `dashboard/src/routes/tours/RemindersPanel.tsx:116-118` (plan names it)
- `dashboard/src/routes/contact/ScheduledCard.tsx:52-59` `scheduledLabel` (plan names it)
- `dashboard/src/routes/placements/DeadlinesNudgesCard.tsx:100-101` **(plan does NOT name it)** -
  identical `reason === 'paused'` equality then fallthrough. Unreachable today because no
  placement-nudge writer emits `discontinued`; safe to leave, but say so in the docblock.

Tone-class branches that also test `reason` by equality (cosmetic, not lies):
`RemindersPanel.tsx:401-404` (quiet_hours OR paused -> muted), `ScheduledCard.tsx:116`
(quiet_hours ONLY - already asymmetric with the panel), `DeadlinesNudgesCard.tsx:299-302`.

---

## 3. `app/src/routes/tourReminders.ts`

- `TourReminderView` `:138-152` - server twin; `state` at `:143`, `skipReason?: ReminderSkipReason` `:148`, `suppression?` `:151`.
- `stateOf` `:157-162` - canceled > sent > skipped > upcoming.
- `viewOf` `:336-349` - PATCH/send-now echo, NO suppression, conditional spreads at `:344-347`.
  Call sites: `:393` (409 echo), `:406` (200 echo), `:460` (sent), `:471` (409 refusal).
- GET projection `:598-609` (`view` object) inside the `.map` `:576-611`; sort `:613`; `next` `:616`.
- `hasUpcoming` `:497`; `suppressionOf` decl `:498-500`; `suppressionEstimateFailed` `:505`;
  guard `:506` `if (tour.tourType === 'self_guided' && hasUpcoming) {`.
- **`nowIso` is block-scoped at `:529`, INSIDE that guard** - confirms spec 8.2 / Task 12 step 2
  ("do NOT lift it"): a landlord_led GET has no `nowIso` at all.
- Quiet disjuncts `:561-564`:

```ts
        suppressionOf = (dueAt: string, paused: boolean): ScheduledSuppression | undefined =>
          evaluate(
            (dueAt > nowIso && isQuietTime(dueAt, window)) || (wallClockQuiet && dueAt <= nowIso),
            paused,
          );
```

- Chip / suppression derivation `:589-597` (quote in full):

```ts
        const paused = manualOnlyKinds.has(row.kind);
        const suppression =
          state !== 'upcoming'
            ? undefined
            : suppressionOf !== undefined
              ? suppressionOf(row.dueAt, paused)
              : paused
                ? ({ reason: 'paused' } as const)
                : undefined;
```

  The `self_guided` guard is `:506`; `suppressionOf` is left UNASSIGNED on a group-routed
  tour AND on a failed tenant read (`:565-571`) - the comment at `:541-549` says the
  defined-but-empty shape is forbidden. The plan's discontinued-first insertion is correct
  and MUST sit outside `suppressionOf` for exactly that reason.
- Send-now handler `:421-472`; `forceSendReminder` call `:437-443`; honest re-read `:446`;
  wire mapping `:466`:
  `const error = result.outcome === 'not_pending' ? 'reminder_not_pending' : result.reason;`
  then `res.status(409).json({ error, reminder: viewOf(after, afterBody) });` `:471`.
  CONFIRMED: a new refusal reason reaches the wire with **zero route edits**.
- `manualOnlyKinds` seam docblock `:107-116`, field `:117`, default `:173`
  (`deps.manualOnlyKinds ?? MANUAL_ONLY_REMINDER_KINDS`).
- Fifth `names_unavailable` producer already live: `:683-689` (no-show draft 409).

---

## 4. `app/src/routes/contactTimeline.ts`

- Seam: docblock `:112-117`, field `:118`, default `:1091`
  (`deps.manualOnlyReminderKinds ?? MANUAL_ONLY_REMINDER_KINDS`), threaded `:1308`.
- `quietFor` param decl `:804-807`; **built at the caller** `:1305-1306`:

```ts
          quietFor: (dueAt: string) =>
            (dueAt > nowIso && isQuietTime(dueAt, window)) || (wallClockQuiet && dueAt <= nowIso),
```

- `suppressionFor` closure `:845-862` (single formula, kind-blind, SHARED):

```ts
  const suppressionFor = (
    conv: ConversationItem | undefined,
    staleStage: boolean,
    dueAt: string,
    paused = false,
  ): ScheduledSuppression | undefined =>
    evaluateScheduledSendSuppression({ ... quietNow: quietFor(dueAt) });
```

- PLACEMENT-NUDGE call site `:880-885` (`nudgeItemsFor`) - must keep quiet suppression.
- REMINDER call site `:1001-1006` (inside `tourWalk`, `:963-...`):

```ts
          const suppression = suppressionFor(
            tenantConv,
            false,
            row.dueAt,
            manualOnlyReminderKinds.has(row.kind),
          );
```

  Plan PR2-5 is CORRECT: the `en_route` quiet exemption belongs at `:1001-1006` (e.g. a
  4th arg or a pre-computed `quiet` boolean), never inside `quietFor`/`suppressionFor`.
  The walk returns `[]` for group-routed tours (`:988`), so the discontinued short-circuit
  here is a simple pre-call branch, exactly as the plan says.
- App-side `TimelineScheduled` iface `:240-254` (`reminderKind?: ReminderKind` `:246`,
  `suppression?` `:251`).
- `MANUAL_ONLY_REMINDER_KINDS` import `:84`; there is NO separate discontinued read today.

---

## 5. Dashboard renderers

`RemindersPanel.tsx`
- imports `:32-38` (`sendNowErrorMessage`, `suppressionNote`, `REMINDER_KIND_LABELS`,
  `REMINDER_SKIP_REASON_LABELS`, `REMINDER_SUPPRESSION_LABELS`).
- `StateChip` `:81-128`: sent `:88`, canceled `:96`, skipped `:99-109` (uses
  `REMINDER_SKIP_REASON_LABELS[rung.skipReason]`, renders `Skipped - <reason>`),
  **paused equality** `:116-118`, then the fallthrough `:122-127`:

```ts
  if (rung.suppression?.reason === 'paused') {
    return <span className={`${styles.chip} ${styles.paused}`}>Paused</span>;
  }
  const text = sendRelative(rung.dueAt);
  return (
    <span className={`${styles.chip} ${styles.upcoming}`}>
      {text || 'Upcoming'}
    </span>
  );
```

  `sendRelative` (`dashboard/src/routes/placements/placementsFormat.ts:67-73`) returns
  `'sending shortly'` for any dueAt <= now - so TODAY an overdue rung already reads
  "sending shortly", which is what Task 12's Overdue chip replaces.
- Note line `:314-320` (`suppressionNote(reason, LABELS[reason] ?? reason)`), rendered
  `:392-409` with the muted/amber tone fork `:399-405`.
- `REMINDER_KIND_LABELS` still carries `confirmation: 'Confirmation'`
  (`types.ts:1247`) - Task 9 must NOT remove it (in-flight + seeded rows still render).

`ScheduledCard.tsx` (the contact-timeline card; also the RELAY-GROUP card, see D2)
- `SUPPRESSION_COPY` `:19-33` (Record 2).
- `fireTimeLabel` `:41-46`; `scheduledLabel` `:52-59` - the equality-then-fallthrough twin:

```ts
  if (item.suppression?.reason === 'paused') return 'Paused';
  return fireTimeLabel(item.at, now, timezone);
```

- note `:76-87`, rendered `:111-123`.
- It reads NO `skipReason` (bucket is pending-only) and no `overdue`.

`DeadlinesNudgesCard.tsx` - `NUDGE_SUPPRESSION_LABELS` `:64-73` (Record 3, one entry
`discontinued: 'turned off',`), `NUDGE_SKIP_REASON_LABELS` `:48-58` (nudge union, untouched),
paused chip `:100-101`, note `:245-249` (plain hyphen, per its copy contract).

Other dashboard readers of `suppression.reason` / `skipReason`: NONE beyond the three files
above (grep over `dashboard/src`). `RemindersPanel.tsx:103` is the ONLY `skipReason` reader.

---

## 6. `app/src/routes/dev.ts` tick route

Divergence block, byte-exact (`:404-422`):

```ts
    // DELIBERATE DIVERGENCE FROM PRODUCTION - read before trusting a tick.
    //
    // Production holds every auto-armed reminder kind back
    // (MANUAL_ONLY_REMINDER_KINDS, founder decision 2026-08-20), so the real
    // poll sends nothing on its own. This dev/e2e seam switches that off: its
    // entire job is to drive the send machinery deterministically, and
    // inheriting the hold-back would turn every tick into a silent no-op and
    // drop the whole reminder send path out of e2e coverage for as long as
    // "temporary" lasts. Mirrors the placement-nudge tick below exactly.
    //
    // SO: a green tick proves the machinery works, NOT that the reminder would
    // go out in production today - there it waits for a human. Applied HERE
    // rather than in tourReminderDeps() so an injected test/e2e deps object
    // cannot silently miss it. Delete this when the hold-back is lifted; do not
    // leave a permanent dev/prod fork.
    await runDueTourReminders(nowIso, {
      ...tourReminderDeps(),
      manualOnlyKinds: new Set(),
    });
```

The placement-nudge twin (`:609-623`, `manualOnlyKinds: new Set()` at `:622`) is
INDEPENDENT and must NOT be touched (`MANUAL_ONLY_NUDGE_KINDS` stays full).

`devGating.test.ts` expectations that depend on it:

| site | what it asserts | after T7/T9 |
|---|---|---|
| `:461-467` `CONFIRMATION_BODY` const | composed confirmation body | becomes UNUSED -> `no-unused-vars` on the IMPORT/const line (the exact gate-5 class the plan warns about) |
| `:521-523` docblock | "confirmation dueAt = FIXED_NOW" | FALSE after T9 |
| `:554-563` "fires the due rows at the supplied now" | tick at FIXED_NOW sends CONFIRMATION_BODY, `world.sent` length 1 | **BREAKS** - T7 excludes the kind, T9 stops arming it. Convert: first tick sends nothing; the earliest live rung is `day_before` @ `2026-07-14T23:30:00.000Z` |
| `:565-571` second tick | day_before body, `world.sent` length 2 | length becomes 1; re-derive |
| `:574-592` ms-normalization | `world.sent.map(b) === [DAY_BEFORE_BODY]` | assertion still PASSES; its comment `:586-591` ("confirmation is due in the SAME batch and is retired by release supersession") becomes false - rewrite |
| `:594-607`, `:609-619`, `:621-629` | wall-clock default / 400 / 404 | unaffected |

The tick harness (`:479-519`) injects `tourReminderDeps` but never `manualOnlyKinds`, so
deleting the override changes behaviour ONLY through the emptied production set - correct.

---

## 7. Seeds

| site | true lines | what it really is | action |
|---|---|---|---|
| `matrix.ts` ladder comment | `:879-881` "a SENT confirmation (armed at creation) + a PENDING day_before" | comment describing arm-time behaviour | rewrite (arming stopped) |
| `matrix.ts` row | `:983-992` `kind: 'confirmation', dueAt: createdAt, sentAt: createdAt` + comment `:983` "armed at creation and sent immediately - always terminal" | **SENT / historical**, on EVERY non-requested tour (12 rows) | **KEEP the row** (same class as cast.ts); the plan calls it "pending" - wrong (see D1) |
| `matrix.ts` invariants | `:893-895` "NO pending reminder has dueAt < now" | pinned in `seedMatrixCoherence.test.ts` | unaffected |
| `live.ts` header | `:9-12` "The four auto-armed rungs (confirmation, day_before ..., morning_of ..., en_route ...)" | comment | -> three |
| `live.ts` TOUR-A | `:504-513` ("confirmation is always armed at `now` (clamped out of quiet hours)") | comment | rewrite |
| `live.ts` TOUR-B | `:522-527` ("confirmation is armed now ... all FOUR auto-armed rungs arm") | comment | rewrite |
| `live.ts` TOUR-C | `:536-537` ("all FOUR auto-armed rungs arm") | comment | **plan omits this one** |
| `lean.ts` | `:420-427`, the confirmation clamp sentence at `:423` | comment on `quietHoursEnabled: false` (`:428-433`) | rewrite; the setting itself stays |
| `cast.ts` | `:769-772` comment, rows `:780-806` (confirmation `:781-789`, all `sentAt`) | historical SENT | KEEP, per plan |

`seedLive.test.ts` pins (Task 9 + Task 10 fallout):

| line | pin | after the change |
|---|---|---|
| `:51` | local `ReminderKind` (all 5) | keep |
| `:55-84` | **hand-mirrored `computeDueAt`**, with `clampOutOfQuietHours(raw, QUIET_WINDOW)` unconditionally at `:83` | **Task 10 must mirror the en_route exemption here** - the docblock at `:73-78` says this clone "exists to catch drift, so it has to be moved in lockstep". Plan Task 10's file list omits it |
| `:86-95` | `REMINDER_KINDS = ['confirmation','day_before','morning_of','en_route']` | drop `'confirmation'` |
| `:168-184` | TOUR-A "has reminder rows" + comment `:176-181` naming the confirmation clamp | re-derive comment |
| `:186-221` | TOUR-A: test NAME says "confirmation is superseded"; `:217-218` asserts `confirmation.skipReason === 'quiet_hours_superseded'` | **BREAKS** - no confirmation row exists. Re-derive: pending set stays `['en_route']`, morning_of/day_before keep `booked_too_late` |
| `:232-259` | TOUR-B: title "has 3 reminder rungs armed" but `:251` asserts `toBe(4)` and `:253-258` the 4-kind pending set | title is ALREADY stale; after T9 count 3, set `['day_before','en_route','morning_of']` |
| `:261-292` | dueAt-drift loop over `REMINDER_KINDS`; `superseded` list `:278` empty | mechanically follows the array edit |
| `:457-478` | requested-tours-have-no-rows invariant | unaffected |

---

## 8. E2E inventory (Tasks 6 / 9 / 12; steps.ts mechanics = Reader D)

| site | intent (one line) | cat |
|---|---|---|
| `scheduled-visibility.spec.ts:113-114` | panel walk: confirmation is the highlighted NEXT rung right after booking | 2 (redesign to `day_before` as next) |
| `..:163-166` | tick (wall clock) -> confirmation SENT, day_before still upcoming | 2 (redesign; needs a future tick) |
| `..:226-230` (test `(c)`, `:217-260`) | fire confirmation, read panel states before the reschedule | 2 |
| `..:247-250` | after reschedule: old day_before canceled, fresh confirmation is NEXT | 2 (the plan's named redesign) |
| `..:258-259` | the re-armed confirmation fires -> proof of re-arm | 2 (proof strategy dies with the kind) |
| `..:186-195` | Upcoming card asserted via `expectUpcomingItem`; comment `:188` says the line reads "Paused" | 4 (T7 flips it back to a fire time) |
| `tours.spec.ts:130-133` | landlord_led: tick -> confirmation lands in the GROUP + shows in the dashboard group thread | 1 |
| `..:198-200` | pm_team: tick -> confirmation in the group | 1 |
| `..:242-244` | self_guided: tick -> confirmation 1:1 from the app number | 1 |
| `..:278-280` | landlord_led w/o group: tick -> confirmation via the 1:1 fallback | 1 |
| `..:282-288` | ticks past the tour (`justAfter(times.noShowCheckin)`); comment says earlier rungs fire, asserts the no_show body is ABSENT | **4** (plan's cat-4 anchor; absence assertion still passes, the COMMENT is what is false, and the retirement wants asserting) |
| `..:290-300` | no-show -> reschedule -> tick -> a fresh confirmation proves the RE-ARM | **2, redesign** - same dead proof strategy as scheduled-visibility `(c)`; **plan does not list it** |
| `tour-roster.spec.ts:480-523` | roster removal -> the ladder itself shows the pause: reads the ladder API, finds the `confirmation` rung, ticks 1s past its arm-time dueAt, asserts `Skipped - tenant not on this roster's roster` chip | **2, redesign** (see D5) |
| `quiet-hours.spec.ts:367-369` | day_before row chips PAUSED_NOTE, QUIET_NOTE absent | **4, T7** - inverts |
| `quiet-hours.spec.ts:396-403` | Send-now test: same PAUSED/QUIET assertion pair | **4, T7** - inverts |

`tours.spec.ts:282-288` quoted (the cat-4 block, true lines):

```ts
  // The tenant never shows. The no-show check-in is no longer auto-armed - it is
  // a MANUAL send now (tour-no-show-checkin.spec.ts), so ticking past its OLD due
  // time fires the earlier rungs (unasserted) but never the check-in body. ABSENCE,
  // so this rides the kind-distinctive MARKER: an exact composed string that were
  // ever mis-composed would make "nothing arrived" pass for the wrong reason.
  await flow.tickTourReminders(justAfter(times.noShowCheckin));
  await flow.expectNoOutboxMessageContaining(tenant, REMINDER_BODY_MARKERS.no_show_checkin);
```

Vehicle available for cat-1 conversions (verified): `flow.armedReminderDueAt(kind)`
(`steps.ts:2019-2031`, requires an `upcoming` rung) + `flow.tickTourReminders(justAfter(...))`
(`:2039-2046`). Falsified docblock line `steps.ts:2035`:
`* now` uses the server wall clock (fires the just-armed 'confirmation' rung);`.

---

## DRIFT FLAGS

**D1 - `matrix.ts:987` seeds a SENT confirmation, not a pending one.**
Plan Task 9 step 3 says "matrix.ts:987 seeds a pending confirmation row directly - rows
seeded to demo the PANEL keep the row (it now demos the 'no longer sent' chip)". The row is
`sentAt: createdAt` (`:983-992`) on all 12 non-requested matrix tours - terminal history,
exactly like `cast.ts`. It cannot demo a discontinued chip (terminal rungs carry no
suppression, `routes/tourReminders.ts:591`). **Do instead:** KEEP the row unchanged, rewrite
only the comments at `:879-881` and `:983`. If the mission wants a live "no longer sent"
demo row, it must be a NEW pending row - which then breaks the matrix invariant "NO pending
reminder has dueAt < now" unless dated forward.

**D2 - a FOURTH pending-rung read surface the plan never names:
`app/src/routes/relayGroups.ts` GET `/api/conversations/:id/scheduled` (`:195-342`).**
It projects pending tour-reminder rungs (`:266-336`) with `reminderKind` and NO suppression
field at all, and the dashboard renders it through the SAME `ScheduledCard`
(`useRelayThread` -> `Timeline.tsx:2102-2107`, fed from `ConversationDetail.tsx:483`,
`TourConversation.tsx:470`, `PlacementConversation.tsx:323`). A pause-era pending
`confirmation` therefore keeps promising "sends in Nh" in every relay group thread after
Tasks 7-9. The spec's "four read surfaces" list (poll, forceSend, tour route, timeline)
is missing this one. Decide: add a discontinued-only suppression to that projection, or
record it as an accepted gap in the handback.

**D3 - Task 8's discontinued short-circuit silently INVERTS the evaluator's precedence,
and ~10 existing tests use `confirmation` as their generic "an upcoming rung" fixture.**
`app/test/contactTimeline.test.ts` creates pending confirmation rows at
`:1218, 1346-1350, 1379, 1402, 1450, 1478-1482, 1518-1522, 1555-1559, 1595-1599, 1621-1625,
1645, 1664, 1687-1691` and then asserts a suppression that is NOT discontinued:
`:1230` (undefined), `:1456` (contact_opted_out), `:1499` (quiet_hours), `:1535`
(quiet_hours), `:1572` (undefined), `:1605` (undefined), `:1631` (contact_opted_out).
Same shape in `app/test/tourRemindersApi.test.ts` at `:411-412 / :424`, `:443-444 / :456`,
`:473-474 / :482`. All of these FLIP to `{ reason: 'discontinued' }` - including two cases
whose whole point is that opt-out outranks quiet hours. Two things follow: (a) the builder
must re-point those fixtures to `day_before`/`morning_of`, not re-baseline them; (b) the
mission must state deliberately that `discontinued` outranks `contact_opted_out` and
`sms_sending_disabled` - a real precedence decision the plan never argues.

**D4 - Task 7 (MANUAL_ONLY emptied) breaks paused assertions the plan does not list.**
`app/test/tourRemindersApi.test.ts:258-259` (states test, production default),
`:578-596` and `:598-622` (the "manual-only hold-back" describe, `makeWebhookHarness()`
with no override), `:1485-1546` case 10 ("every rung still `paused`");
`app/test/contactTimeline.test.ts:1242-1264` and `:1294-1320` (both import
`MANUAL_ONLY_REMINDER_KINDS` as the "PRODUCTION hold-back" fixture - the first FAILS, the
second silently goes vacuous); and e2e `quiet-hours.spec.ts:368-369` and `:402-403`, whose
own docblock (`:100-106`) says PAUSED_NOTE "stays as the assertion the specs return to the
moment MANUAL_ONLY_REMINDER_KINDS is emptied" - i.e. both pairs must invert to QUIET_NOTE.
Plan Task 7's file list names only `tourReminders.test.ts` + `devGating.test.ts`, and
`quiet-hours.spec.ts` appears only under Task 10.

**D5 - `tour-roster.spec.ts:480-523` cannot simply be "rebuilt on a live kind".**
Its proof needs a rung that is (a) armed, (b) already due, (c) claim-skippable. Only
`confirmation` (dueAt = arm instant) satisfied that. The block's own comment (`:490-494`)
explicitly forbids the obvious replacement - "The tick is global, but at ~now it fires only
what the worker's own 60s poll would have fired anyway; **a far-future `now` never belongs
here**" - which is exactly what `justAfter(armedReminderDueAt('day_before'))` (~4 days out,
tour booked at +5d) would be. Task 9 step 2a must give this block a real strategy (e.g.
book near-term so `day_before`/`en_route` is due, or drive the skip through Send now).

**D6 - `steps.ts:3432` label regex will accept the discontinued lie.**
`await expect(card.getByText(/^sends |^sending shortly$|^Paused$/)).toBeVisible();` -
a `discontinued` card falls through `scheduledLabel` to a fire time and still MATCHES, so
the e2e passes on the exact wrong string. After Task 8 step 2b adds the "No longer sent"
branch, the regex must gain that alternative or `scheduled-visibility.spec.ts:192` breaks.
Cross-ref Reader D (steps.ts owner).

**D7 - `SEND_NOW_ERROR_COPY.names_unavailable` already exists (`types.ts:1317-1318`).**
Task 2 step 2's comment says "names_unavailable is deliberately absent: there the generic
retry sentence is the right advice". It is NOT absent; it carries a cause-agnostic sentence
added 2026-08-26. The test as written still passes, but the comment is false - reword, and
do not "add" the key.

**D8 - Task 10's en_route exemption has a fourth mirror: `app/test/seedLive.test.ts:55-84`.**
Its hand-written `computeDueAt` clone clamps EVERY kind at `:83` and its own docblock
(`:73-78`) demands lockstep movement. Task 10's Files list omits it; step 5 only runs the file.

**D9 - `overdue` (Task 12) lands on `TourReminderView` only.**
`TimelineScheduled` (`types.ts:2418-2430`, app twin `contactTimeline.ts:240-254`) has no
`overdue`, and `ScheduledCard.fireTimeLabel` (`:41-46`) keeps saying "sending shortly" for
a past dueAt. Either state that asymmetry deliberately in the spec or extend the flag.
Also confirm the Task 8 discontinued chip beats the Task 12 overdue chip in
`RemindersPanel.StateChip` - both are inserted above `:122`, so ORDER is load-bearing.

**D10 - minor anchor corrections:** `routes/api.ts` seam is `:391-398` (plan says `:389`);
`tour-roster.spec.ts` block is `:480-523` (plan says `:488-501`, which excludes the
assertion); `matrix.ts` comment is `:879-881` (plan says `:880`); `live.ts` needs `:536-537`
added to the plan's `:9,506-523`.
