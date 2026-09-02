# Code review round 1 - adjudications (orchestrator, 2026-09-01)

Branch `feat/tour-reminder-ladder-phase-b` @7345dd36 (merge-base main @ec32170a).
Reviewers: A = spec conformance (`r1-conformance.md`), B = adversarial, plan-blind
(`r1-adversarial.md`). Totals: BLOCKING 0, MUST-FIX 4, SHOULD 10, NOTE 9.
Gates at the reviewed commit: typecheck 0, npm test 0 (app 347 + dashboard 183 + 3
other workspaces), smoke 0, eslint 0 new (9 pre-existing by baseline set-compare),
e2e 261/261 @66229715 (T15 = docs + one comment line).

Ruling key: FIX = goes to the fix wave. DOC = handled in documentation only.
RECORD = accepted as-is, stated here so it is not re-derived. REVERT = code removed.

## MUST-FIX - all four FIX

| id | finding | ruling |
|---|---|---|
| B-MF1 | `resolveRelayComposeInputs` has no past-tour guard: a tour-owned relay opened on (or quiet-hours-deferred past) a tour that has already started composes the tour intro ("...let us know when you're on the way") | FIX. Treat a past `scheduledAt` exactly as an absent one -> `variant:'naked'` (spec 9.5's rule; the tour copy assumes a future tour, the same reasoning as 6.1a). Unit test: tour owner with `scheduledAt` before `nowIso` -> naked; at/after `nowIso` -> tour variant. |
| B-MF2 | `next` (panel "Next" highlight + `aria-current`) is handed to a pending DISCONTINUED rung, i.e. every pause-era `confirmation` until the sweep runs | FIX. `routes/tourReminders.ts` next-pick excludes `suppression?.reason === 'discontinued'`. API test per B's sketch (pending confirmation earliest + later day_before -> `next.kind === 'day_before'`). |
| A-M1 | `devGating.test.ts:520-522,557-561,596-600` comments claim a `confirmation` row arms and that the first-tick no-op proves the discontinued guard; since T9 no such row exists, so the claim is vacuous | FIX. Re-derive the three comments; seed a `confirmation` row directly via the repo in that case so the discontinued-guard claim is REAL, or drop the claim. |
| A-M2 | Spec 14 requires a PLACEMENT relay intro e2e (legs in every member's fake thread + preview showing the same variant); only the tour walk exists | FIX. Extend `e2e/tests/relay-intro-variants.spec.ts` with a placement-owned walk mirroring the tour one (open via the placement roster route; assert `Excited to have you move into` + resolved street in every member's fake thread and in the preview). |

## SHOULD

| id | finding | ruling |
|---|---|---|
| B-S1 | Discontinued rung still renders an enabled "Send now" that can only 409 `kind_retired` | FIX. Gate the button on `state==='upcoming' && suppression?.reason !== 'discontinued'`; extend the existing discontinued panel test with `queryByRole('button', {name:/Send the/})` -> null. |
| B-S2 | Panel refetches every 20s forever on a discontinued past-due rung | FIX. Skip `suppression?.reason === 'discontinued'` rungs in `nextReminderRefetchDelay`'s loop; unit-test the delay function. |
| B-S3 | `tourRemindersRepo.ts` `uncancel` docblock says a restored past-due confirmation "fires on the next poll tick" - false twice (discontinued; past-tour gate) | FIX (comment): name both gates. |
| B-S4 | `rosterEdits.ts:19-24, :569-572` claim preview and send "cannot differ"; the resolver is clock-dependent (deferral across midnight / tour start flips the variant) | FIX (comment): "same ENTRY SET, resolved at send time". Do NOT thread the preview clock into the job (would pin a stale variant). |
| B-S5 | Sweep re-throws any non-conditional error out of the paging loop, discarding all counters; a row with a blank `tourId` reaches `toursRepo.get(undefined)` -> `ValidationException` -> whole run dies | FIX. Per-row try/catch -> `failed` counter (+ `reminderId` logged), continue; top-level catch logs the partial counters before `exitCode=1`. Integration test: one corrupt row does not abort the others. RUNBOOK sentence for the PARTIAL report. |
| B-S6 | Tour/placement intros are tenant-addressed ("Hey Alicia! ... meeting Marcus!") but go verbatim to the landlord too | DOC. Add to `founder-handback-items.md` "Added during the build" as item d. Founder wording - hers to rule on. |
| A-S3 | `steps.ts:2085-2087` `expectRungsRetiredPastTour` docblock says the 'upcoming' assertion "would pass either way" - false since R12's `/Skipped/` filter | FIX (comment). |
| A-S4 | `tours.spec.ts:261-264`: the `justAfter(times.enRoute)` tick retires `morning_of` by release supersession - documented, not asserted (spec 10 requires the assertion) | FIX. Assert `morning_of` is `skipped` / `quiet_hours_superseded` via the reminders API after that tick. |
| A-S5 | `retiredByTourStart` canonicalizes `scheduledAt` but compares the raw `row.dueAt` string | FIX. Compare `Date.parse(row.dueAt)` against `start`; unparseable dueAt -> false. Unit test with a non-canonical dueAt. |
| A-S6 | `DeadlinesNudgesCard.tsx` gained a `discontinued` `StateChip` branch beyond spec 3.1a's "ONE label entry ... compile completeness ONLY"; `ScheduledCard.tsx` muted-tone fork gained `discontinued` | SPLIT. **REVERT** the `DeadlinesNudgesCard` chip branch (keep the label entry) - spec 3.1a narrowed the exclusion on purpose and the branch is unreachable code on an excluded surface; this also moots B-N2. **KEEP** the `ScheduledCard` muted tone: that card renders an IN-SCOPE surface (the timeline's discontinued read) and muting matches the tour panel. |

## NOTE

| id | finding | ruling |
|---|---|---|
| B-N1 | member_added: if the joiner is removed between the add and the job, `added` is undefined, `bodyFor` matches nobody, and the persisted row is a body nobody received | FIX (one line): `body: added !== undefined ? newMemberBody : groupBody` - the persisted row is honest in the raced case. Test with the existing raced-remove fixture. |
| B-N2 | `DeadlinesNudgesCard` muted-tone fork omits `discontinued` | MOOT by A-S6's revert. |
| B-N3 | `viewOf`'s `overdue` is read by nobody (the panel refetches after PATCH) | RECORD. Wire-shape consistency per spec 8.2; harmless. |
| B-N4 | held-back poll log would double-count a kind present in BOTH sets | FIX (one line): count manual-only as `manualOnly.has(k) && !DISCONTINUED.has(k)`. |
| B-N5 | The unpause newly exercises `pollLoop`'s overlap-free `setInterval`; overlapping ticks are safe (conditional writes, A2P bucket) | RECORD; handback note. |
| B-N6 | Zero-others naked intro renders "1 other person" (the ONE deliberate copy change) | RECORD (spec 9.2). |
| A-N7 | Force-send: a THROWN target read refuses `names_unavailable` before the `tour_already_passed` gate can run (needs `target.tour`) | RECORD - structurally unavoidable; spec precedence holds wherever both are evaluable. |
| A-N8 | `interpolate` charset narrower than old split/join | RECORD - guarded by the structural catalog test. |
| A-N9 | timeline does not project `skipReason` | RECORD (already in the worklist's handback notes). |

## Re-review charge (round 2, on continuation of both reviewers)
In order: (1) what did round 1 MISS across the changed state; (2) the fix diff is NEW
code written under pressure - review it cold; (3) challenge any ruling above with
`file:line`; (4) only then, are the fixes real.
