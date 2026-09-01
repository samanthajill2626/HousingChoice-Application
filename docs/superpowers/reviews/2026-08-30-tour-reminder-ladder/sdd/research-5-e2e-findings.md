> **FINDINGS HALF ONLY.** Extracted 2026-09-01 from `research-5-e2e.md`, which was 77-87%
> byte-exact quotation of code git holds at the commits cited here. Only the DRIFT
> (plan/spec vs the live tree) and GAPS (what the change breaks that the plan omits)
> sections are kept. The reference half was not committed.

## DRIFT

Plan/spec claims checked against the live tree. Confirmed-correct citations are listed only where the brief asked me to verify a specific claim.

**D1 — spec 13.1 `steps.ts:234` is off by two lines.**
Spec: "that is the 'wrong answer waiting to be used' the `TourTimes` docblock (`steps.ts:234`) already warns about".
Live: `steps.ts:234` is `` * (tick with no `now` fires it immediately). ``. The warning is `steps.ts:240`: `* removed rather than left as a wrong answer waiting to be used.`, inside the paragraph `:236-241`. Also, the docblock is `tourSchedule`'s, **not `TourTimes`'s** — `TourTimes`'s own docblock is the one-liner at `:210`. The plan (Task 9 Step 1) gets the range right (`:236-241`) and the ownership wrong the same way.

**D2 — the plan's `tour-roster.spec.ts` read-back cast has no `state` field; the proposed helper filters on one.**
Plan (Task 9 Step 2): `reminders: Array<{ kind: ReminderKind; dueAt: string; state: string }>` and `.find((r) => r.kind === kind && r.state === 'upcoming')`.
Live (`tour-roster.spec.ts:497-498`): `as { reminders: { kind: string; dueAt: string }[] }` and `.find((r) => r.kind === 'confirmation')`. The `state` discriminator is *added by the plan*, not "promoted" from the existing pattern. If `GET /api/tours/:id/reminders` does not emit `state` (or emits a different vocabulary than `'upcoming'`), the helper throws on every call. Unverified from the e2e side.

**D3 — the brief's (and, by omission, the plan's) path for `tour-roster.spec.ts` is wrong.**
Live path: `e2e/tests/tour-roster.spec.ts`, NOT `e2e/tests/scenarios/tour-roster.spec.ts`. The Task 9 commit list (`git add ...`) does not include it, which is correct — it isn't modified — but the spec/plan reader will look in the wrong directory.

**D4 — "Specs that drive ticks off `times.dayBefore`" (spec 13.1:919-921) is COMPLETE and byte-accurate.** `quiet-hours.spec.ts:293,318`, `scheduled-visibility.spec.ts:163,228`, `tours.spec.ts:134`. Verified exhaustively by grep: five, no more.

**D5 — booking-helper claims (the brief flags these specifically). All three are CORRECT, with one qualification.**
- `scheduled-visibility.spec.ts` books via `tourScheduleFullLadder()` — CONFIRMED, `:91` (`const times = tourScheduleFullLadder();` inside the shared `bookedSelfGuidedTour`, `:69-94`). Both `:163` and `:228` inherit it.
- `tours.spec.ts:134` books via `tourSchedule()` (48h) — CONFIRMED, `:128`.
- `quiet-hours.spec.ts` books via `tourSchedule()` — CONFIRMED, `:195`.
- QUALIFICATION on the plan's `scheduled-visibility.spec.ts` safety note: it says "at the day_before tick, morning_of (10:00 D) and en_route are not yet due". Under the *new* ladder `tourScheduleFullLadder(2)` books 14:00 local, so morning_of = `scheduledAt - 4h` = **10:00 D**, en_route = **13:00 D**, day_before = **19:30 D-1**. The chain holds. But `scheduled-visibility.spec.ts:186` reschedules with `tourSchedule(72)` — a *now-relative* 72h booking — and `:188-189` then assert panel states. That reschedule is NOT covered by the plan's safety analysis and is not in Task 9's file list of edits beyond the two tick lines.

**D6 — the plan's 30-minute margin for `tours.spec.ts:134` is thinner than stated at one wall clock, and the honesty note names the wrong worst case.**
Plan: "at `justAfter(19:30 D-1)` the earliest other rung is morning_of at `tod-4h` on D, which is at least 20:00 D-1 - 30 minutes clear at the worst wall clock."
Live: `tourSchedule()` = `Date.now() + 48h` with `setSeconds(0,0)` (`steps.ts:243-244`) — the tour's local time-of-day equals the run's wall-clock time-of-day, minutes included. morning_of = tod − 4h. For the margin `morning_of > 19:30 D-1` to hold you need `tod > 23:30` on D‑1's clock i.e. tod ∈ (23:30, 24:00) ∪ … — no. Working it properly: morning_of lands on day **D** at `tod − 4h`; day_before lands 19:30 on **D‑1**. morning_of is later than the tick unless `tod − 4h` on D is ≤ 19:30:01 on D‑1, which is never (D > D‑1 by a full day; `tod − 4h` ≥ 20:00 D‑1 only when tod < 04:00, in which case `tod − 4h` is *the previous day*). Concretely: for `tod = 00:15`, morning_of = **20:15 on D‑1** → 45 min after the tick. For `tod = 23:45`, morning_of = 19:45 on **D** → ~24h clear. The genuine worst case is `tod → 23:30`+ε **rolling backwards**: at `tod = 23:31`, morning_of = 19:31 D‑1 → **60 seconds** of margin, not 30 minutes. The plan's "at least 20:00 D-1" is wrong for `tod` just above 23:30. This is a real, if narrow, wall-clock window where release supersession could retire the asserted `day_before`. (The tick is `dueAt + 1s`, so at `tod = 23:30:00` exactly they collide.)

**D7 — the plan's `quiet-hours.spec.ts` line ranges are exact.** Header `:21-38` ✔ (line 38 is the last contract line). `bookedSelfGuidedTour` `:179-198` ✔ (function only; docblock starts `:173`). Test (2) `:279-323` ✔. Test (3) `:325+` ✔ (325-352). Button pin `:348` ✔.

**D8 — Task 8's `REMINDER_KIND_LABELS` range `:202-208` is exact** (`:202` declaration through `:208` closing brace; docblock `:199-201`).

**D9 — Task 9's `steps.ts` ranges are exact.** `TourTimes:211-218` ✔, `tourSchedule:226-246` ✔ (docblock 226-241, body 242-246), `timesFor:269-281` ✔, `tourScheduleFullLadder` docblock `:248-261` ✔, morning_of paragraph `:236-241` ✔.

**D10 — Task 4 Step 11's `steps.ts` anchors are all exact.** composer import `:37` ✔, `TourReminderContext:140` ✔, `tourReminderContext:164` ✔, `tourReminderBody:173` ✔, `REMINDER_BODY_MARKERS:191` ✔, `ActiveTour:329` ✔, `teamCreatesTourFromInterest:1675` ✔, `this.activeTour =` **exactly one, `:1720`** ✔, `requireTourReminderContext:3457` ✔.

**D11 — Task 4 Step 11's spec anchors are exact.** `scheduled-visibility.spec.ts:129,148,221` ✔; the `:101` destructure is indeed `const { unit, times } = await bookedSelfGuidedTour(flow, 'Ladder');` ✔; `tour-comms-pane.spec.ts:230-236` ✔ and the stale comment at `:202-203` ✔.

**D12 — the plan's host-zone honesty note cites `scheduled-visibility.spec.ts:124-126`; the actual text spans `:123-126`.** Live:
```
  // its org-local date and time (spec section 8). Composed by the app's own
  // composer, so a copy change moves both sides together. NOTE: no zone-
  // DISTINGUISHING claim is made here - this box runs on America/New_York too,
  // so the browser and the org zone agree and only the TEXT is provable; the
  // composing-zone half is pinned by the app's unit tests.
```
(`:122-126`). Minor, but the sentence the plan leans on starts at `:123`, and note that it says the box **runs on** America/New_York — it is an observation, not the load-bearing "assume host zone == ORG_TIMEZONE" contract the plan describes it as. There is no assertion anywhere in `e2e/` enforcing the host TZ.

**D13 — Task 8 Step 4's grep instruction under-scopes.** It says `grep -rn "reminder now" e2e/ dashboard/src/`. In `e2e/` that returns `quiet-hours.spec.ts:348` **and** `tour-comms-pane.spec.ts:42` (a prose rule quoting the template). The latter is documentation that goes stale silently — it is not in any file list.

**D14 — Task 4 Step 11's claim "`activeTenant` is the tenant" holds, but only by ordering luck.** `teamCreatesLandlord` (`steps.ts:1088`) **also writes `this.activeTenant`** (`:1106-1111`) with the LANDLORD's name. It happens to be safe today because every tour-creating spec creates the landlord first: `tours.spec.ts:79` before `:87`; `post-tour-application.spec.ts:78` before `:86`; `approval-and-move-in.spec.ts:101` before `:109`; `relay-number-lifecycle.spec.ts:268` before `:275`; the rest create no landlord at all. The plan's parenthetical ("the tour is always created from the tenant's file, so `activeTenant` is the tenant") states the conclusion without naming the landlord writer that makes it fragile. Any future spec that creates the landlord last silently stamps the landlord's first name into every reminder body assertion.

**D15 — spec 13.2's `tour-no-show-checkin.spec.ts:63-75` range covers the tick but the falsified prose starts earlier.** The file-header claim "arms the reminder ladder" is `:6-8`, and Half 1's "The four legit rungs may land 1:1" is `:71-74`. The plan's Step 5 names `:28-31` and `:64` only.

---

## GAPS — e2e surface this change breaks that the plan omits

**G1 — the timing contract's supersession bullet (`quiet-hours.spec.ts:35-38`) is falsified and the plan does not rewrite it as such.**
```
//   - Only ONE rung of the tour is ever due in an asserted tick: release
//     supersession retires an earlier rung when a LATER rung of the same tour is
//     due in the same batch, so the assertions ride the LAST due rung
//     (day_before), which nothing can supersede.
```
`day_before` is the LAST due rung today because it is `scheduledAt − 24h` on a 48h booking with morning_of at 08:00 org-local the tour day and en_route at −1h — no. It is the FIRST. The claim as written was already loose, but after the retiming `day_before` (19:30 D‑1) is unambiguously the EARLIEST rung and is therefore exactly the one release supersession can retire. Task 9 Step 4's rewrite instruction covers "both anchorings" but says nothing about replacing this bullet's supersession argument, which is the bullet that justifies asserting on `day_before` at all.

**G2 — `bookedSelfGuidedTour` in `quiet-hours.spec.ts` returns no `unit`.**
Task 9 Step 4 changes it to `tourScheduleFullLadder(2)`; Task 4 Step 11 threads `names` into `tourReminderContext(unit, times, …)` at the three `scheduled-visibility` sites. If any quiet-hours assertion ever needs a spec-composed body (and D2's `state`-field risk may force a fallback), the helper's `Promise<{ tenant: Contact; times: TourTimes }>` (`:183`) has to widen. Not named anywhere.

**G3 — `scheduled-visibility.spec.ts:186` reschedules with `tourSchedule(72)` and then asserts panel states at `:188-189`.**
`tourSchedule(72)` is now-relative (tod at 72h out), so the re-armed `day_before` is 19:30 on the day before that tour and `morning_of` is `tod − 4h`. `:188` asserts the OLD `day_before` row is `'canceled'` and `:189` the fresh `confirmation` is `'next'`. `expectReminderRung` disambiguates duplicate labels only by state chip (`steps.ts:3368-3384`). With the ladder retimed, the "next" ordering among fresh rungs can change for some `tod` — specifically, with `confirmation` dueAt = arm-time now, it stays earliest, so `:189` survives; but this reschedule path is entirely absent from Task 9's analysis, which only discusses `:163` and `:228`.

**G4 — `scheduled-visibility.spec.ts:106-109` asserts the WHOLE ladder upcoming, including `morning_of` at `:108`.**
Under the new ladder with `tourScheduleFullLadder()` (14:00 D+2): day_before 19:30 D‑1, morning_of 10:00 D, en_route 13:00 D — all future, all upcoming. Fine on arithmetic. **But `:108` also becomes the only e2e site whose row-locator text changes** (`'Morning of'` → `'4 hours before'`), and it resolves through `REMINDER_KIND_LABELS.morning_of` so it is silently covered by Task 8 Step 4. Worth confirming rather than assuming: `filter({ hasText: '4 hours before' })` must not collide with any other row text in that card. Nothing in `e2e/` pins the card's other copy, so this is a "verify in the browser" item nobody owns.

**G5 — `scheduled-visibility.spec.ts:110-118` asserts `no_show_checkin` has ZERO rows.**
Spec 13.2 says `booked_too_late` "writes a VISIBLE row where the old past-dueAt branch wrote none, so those ladders get LONGER". `no_show_checkin` is manual-only and never armed, so the count-0 assertion should hold — but if the new skip machinery writes rows for kinds it previously skipped silently, this is the assertion that flips. Task 9 does not list `:110-118` as something to re-derive.

**G6 — `tour-comms-pane.spec.ts:230-237` asserts `toHaveCount(1)` on the `day_before` Upcoming card, and Task 4 Step 11 only threads its arguments.**
The count is the fragile part, not the body. The tour is created at `now + 48h` at an arbitrary time-of-day (`:204`). Post-retiming, `day_before` is 19:30 on D‑1 (always future for a +48h tour, so the card exists) — but `morning_of` is now `scheduledAt − 4h`, which is `now + 44h`, and it renders its OWN Upcoming card. If the new `morning_of` copy ever shares a prefix with the `day_before` copy the `hasText` filter would match two cards. New copy: day_before `"Hey {tenantFirstName}, confirming your tour tomorrow at {time}. Does that still work for you?"` vs morning_of `"Hey {tenantFirstName}, looking forward to having you tour at {time} today. Does that still work for you? {addressLine}"` — they **share the tail "Does that still work for you?"** and the head "Hey <Name>,". `hasText` with a full composed `day_before` body is a substring test on the whole card text, and the day_before body is not a substring of the morning_of body (the middles differ), so `toHaveCount(1)` holds. But this is now a near-miss that nothing guards, and Task 4 does not flag it.

**G7 — the two copies of the no-show marker will drift.**
`steps.ts:196` (`REMINDER_BODY_MARKERS.no_show_checkin`) and `tour-no-show-checkin.spec.ts:32` (`CHECKIN_PHRASE`) are independent literals of the same string. Task 9 Step 5 rewrites the spec's *comment* about the phrase but leaves two copies. Under the new copy `Hi {tenantFirstName}! Do you need to reschedule?` both still match, but the plan's own Step 5 asks half 2 to assert the exact prefill `` `Hi ${tenant.firstName}! Do you need to reschedule?` `` — which makes `CHECKIN_PHRASE` half-dead (still used at `:76` and `:117`) while a third literal appears at `:97-99`. Nobody consolidates.

**G8 — `tour-no-show-checkin.spec.ts:117` filters the sent-copy count with `.includes(CHECKIN_PHRASE)`, and the *manual* send is now name-bearing.**
`toBe(1)` counts outbound messages containing the phrase. If Half 1's tick now writes a **visible `booked_too_late` `day_before` row** (spec 13.2 / plan Step 5's own derivation) and the panel's force-send is never pressed, no extra copy is sent — fine. But the plan's Step 5 rewrite asserts "NOTHING is pending, and the wall-clock tick fires NOTHING". That claim needs `confirmation`'s dueAt (= arm instant) to be born `past_event` rather than fired by the very next tick at `:75`. The spec asserts `expectNoOutboxMessageContaining(tenant, CHECKIN_PHRASE)` only — it never asserts the *other four* rungs sent nothing, so a wrong derivation here fails silently rather than loudly. Nothing in the plan adds that guard.

**G9 — `selectors.md:73` (placement nudges) diverges from `:72` after Task 8.**
`RemindersPanel.tsx:347` becomes `` `Send the ${kindLabel} reminder now` `` while `DeadlinesNudgesCard.tsx:273` stays `` `Send ${label} nudge now` ``, and `:284` (`` `${...'Cancel':'Restore'} ${label} nudge` ``) stays without "the". Two sibling ladders with deliberately parallel accessible-name grammar (selectors.md says "Same strict-mode caveat as the reminder button") now read differently. Task 8 does not decide whether that is intentional; `DeadlinesNudgesCard.test.tsx:177, 287, 308, 309, 319` pin the nudge form and would need to move too if consistency is wanted.

**G10 — `e2e/performance/*` pins the reminders endpoints as required routes.**
`e2e/performance/routes.ts:335` (`required('/api/tours/:tourId/reminders')`), `routes.test.ts:139`, `collect.ts:63`, `collect.test.ts:453-456`, `templates.ts:52-54`, `mutationCatalog.ts:148-149`, `firewall.test.ts:132-141`, `redact.test.ts:39`. None of these are in any task's file list. They pin route *shapes*, not bodies, so the change should be inert — but if the response gains a `state` field (D2) or a new skip reason surfaces, the perf contract ledger (`CONTRACT_SOURCE_LEDGER.background.tourReminders`, `collect.ts:63`) is a fingerprint over source that will move and can fail `collect.test.ts`. Nobody owns that.

**G11 — the harness's only app import is a VALUE import, and Task 4 Step 11 adds two type-only ones "to keep the bundle AWS-free".**
`steps.ts:37` already pulls `composeTourReminderBody` as a runtime value. The AWS-free property therefore rests entirely on `app/src/messages/tourCopy.ts` staying pure — the comment at `:33-36` says so explicitly and names the historical split (`resolve.ts` → `resolveWithSettings.ts`). Task 4 adds a `TourContactNames` re-export to that same module. If the re-export is implemented by re-exporting from `app/src/lib/tourContacts.ts` (which the plan itself warns "drags the AWS SDK into the e2e bundle") **as a value or via a non-`export type` form**, the existing value import at `:37` pulls it in transitively. The plan guards the *harness* side ("never import from `app/src/lib/tourContacts.js` here") but not the *tourCopy.ts* side, which is the one that actually matters given `:37`.

**G12 — no e2e coverage exists, or is planned, for the two things spec 13 says are new and e2e-visible:** the `booked_too_late` skip reason's operator label in the panel, and the `quietHoursStart <= 19:30` retirement + warn. `steps.ts` has no skip-reason label mirror at all (`REMINDER_SKIP_REASON_LABELS` is imported by `tour-roster.spec.ts:63` from somewhere else — worth reader 2/3 confirming its home); `expectReminderRung`'s state union (`steps.ts:3374`) is `'upcoming' | 'sent' | 'canceled' | 'next'` with **no `'skipped'` member**, so no Scenario verb can even assert a skipped rung today. `tour-roster.spec.ts:521` hand-rolls it with `toContainText(\`Skipped - ${REMINDER_SKIP_REASON_LABELS.tenant_not_on_roster}\`)`. Any Phase-A e2e proof of `booked_too_late` needs that verb widened, and no task does it.