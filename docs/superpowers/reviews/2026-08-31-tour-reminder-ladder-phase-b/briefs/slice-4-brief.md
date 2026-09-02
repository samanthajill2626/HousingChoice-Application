# Slice 4 - Task 7 (DISCONTINUED_REMINDER_KINDS + the unpause) + Task 8 (discontinued on every read surface)

Common brief (READ FIRST): `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\implementer-brief-common.md`
Report path: `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\reports\slice-4.md`
Research: report A sections 1, 5, 6 (job anchors; EVERY manualOnlyKinds reader; rig idioms);
report B sections 1-6 (dashboard types, the three exhaustive Records, route chip branch,
timeline call site, renderers, dev.ts block); report D section 5.3 (`quiet-hours.spec.ts`
constants + the two assertion pairs). Prior slices: see `.superpowers/sdd/progress.md`
"Commits" and reports slice-2/slice-3 (the unit vehicle `createDueReminder` now exists in
`tourReminders.test.ts`; `devGating.test.ts` and guards g3/g3b are untouched so far).

Scope: plan Task 7 (steps 1-5) and plan Task 8 (steps 1-3, incl. 2a/2b). THIS IS THE UNPAUSE.

Binding deltas (worklist s1 rulings R2, R3, R4, R5, R15; s2 T7/T8):
- R4: the `kind_retired` force-send refusal is an INLINE
  `return { outcome: 'refused', reason: 'kind_retired' };` immediately after the row lookup
  / not-pending checks (`refuse` is declared later, out of scope). Precedence pinned by test:
  `kind_retired` > `tour_already_passed` > `names_unavailable`.
- Poll filter: `manualOnly.has(r.kind) || DISCONTINUED_REMINDER_KINDS.has(r.kind)`; keep the
  held-back log line, count both causes separately. NOT injectable via deps.
- `MANUAL_ONLY_REMINDER_KINDS` -> empty; REWRITE its whole docblock per plan T7 step 2.
- `routes/dev.ts`: delete the TOUR tick's divergence block + `manualOnlyKinds: new Set()`
  (~`:405-423`). The placement-nudge twin at ~`:622` is NOT yours - do not touch it. Fix the
  "60s" in its neighbouring comment (`~:429`) to 30s only if you touch that line anyway.
- Seam docblocks to rewrite (they now exist to let tests exercise pause-mode): `routes/api.ts
  ~:391-398`, `routes/contactTimeline.ts ~:112-118`, `routes/tourReminders.ts ~:107-117`,
  `app/test/helpers/twilioWebhookHarness.ts ~:3930-3936`.
- R5 (paused coverage PRESERVED via seams): `tourReminders.test.ts` manual-only describe
  (`~:3279-3385`) injects an explicit non-empty set via `runDueTourRemindersRaw`; its
  membership assertion (`~:3288-3295`) becomes: MANUAL_ONLY is EMPTY and DISCONTINUED holds
  exactly `confirmation`. `tourRemindersApi.test.ts ~:259,595,621,1546` and
  `contactTimeline.test.ts ~:1243-1264,1294-1320`: cases about PAUSED behaviour inject a set
  through the harness/seam; cases about the PRODUCTION DEFAULT flip to the true answer.
  Delete the now-no-op `NO_MANUAL_HOLD_BACK` wrappers (`tourReminders.test.ts:72-75`,
  `tourRemindersApi.test.ts:161-174`) and call the raw function.
- `devGating.test.ts ~:461-467,521-592`: first tick at FIXED_NOW sends NOTHING (confirmation
  excluded; day_before not yet due); the day_before tick (`2026-07-14T23:30Z`+) sends ONE;
  drop `CONFIRMATION_BODY` (it would become an unused const = a gate-5 error); re-derive the
  ms-normalization comment (`~:586-591`).
- `tourRemindersApi.test.ts ~:1051-1138` (send-now on an uncomposable CONFIRMATION now refuses
  `kind_retired` first): pin that precedence in one case; move the `invalid_schedule` case to a
  live kind so it still tests what it tested.
- e2e `quiet-hours.spec.ts ~:96-112,356-369,398-403`: EXACT inversion - QUIET_NOTE visible,
  PAUSED_NOTE absent at both pairs; delete `PAUSED_NOTE` and the manual-only precedence prose.
  No Playwright run; `cd .../e2e && npx tsc --noEmit -p .`.
- Task 8: widen `ScheduledSuppressionReason` (app `scheduledSendSuppression.ts:1-4` + dashboard
  `types.ts:1144-1150`) with `'discontinued'`. `suppressionLead('discontinued')` = `No longer
  sent`. Three exhaustive Records get `discontinued: 'turned off'`: `types.ts
  REMINDER_SUPPRESSION_LABELS`, `dashboard/src/routes/contact/ScheduledCard.tsx SUPPRESSION_COPY
  (:19-33)`, `DeadlinesNudgesCard.tsx NUDGE_SUPPRESSION_LABELS (:64-73)` (the last is compile
  completeness ONLY). Label FUNCTIONS get an explicit `discontinued` branch ABOVE `paused`:
  `RemindersPanel.tsx StateChip (~:116)` -> a "No longer sent" chip; `ScheduledCard.tsx
  scheduledLabel (~:52-59)` -> `'No longer sent'`; `DeadlinesNudgesCard.tsx (~:100-101)` ->
  same branch with a docblock saying no placement writer emits it today. Failing component
  tests first for the two reachable chips (`RemindersPanel.test.tsx` exists; add a
  ScheduledCard case where its test file lives, else create one following the panel test's
  idiom). R15: leave a one-line comment at the discontinued branch that the (later) overdue
  chip must sit BELOW it.
- Route chip branch (`routes/tourReminders.ts ~:589-597`): discontinued FIRST, outside
  `suppressionOf`, exactly the plan's ternary. Test for BOTH self_guided and landlord_led.
- Timeline (`routes/contactTimeline.ts ~:1001-1006`): a short-circuit ahead of `suppressionFor`
  (`DISCONTINUED_REMINDER_KINDS.has(row.kind) ? { reason: 'discontinued' } : suppressionFor(...)`).
- R3 (FIFTH surface): `routes/relayGroups.ts` GET `/api/conversations/:id/scheduled`
  (~`:266-336`) projects pending tour rungs with no suppression; add ONLY
  `...(DISCONTINUED_REMINDER_KINDS.has(row.kind) && { suppression: { reason: 'discontinued' } })`
  (check the projection's type admits `suppression` - the dashboard `TimelineScheduled` twin
  has `suppression?`); one API test in `relayGroups`' suite (find it by grep on the route path).
  Nothing else changes there.
- R2 (binding): `discontinued` outranks opt-out / kill switch / everything. Re-POINT (never
  re-baseline) the fixtures that used `confirmation` as a generic upcoming rung:
  `contactTimeline.test.ts ~:1218,1346-1350,1379,1402,1450,1478-1482,1518-1522,1555-1559,
  1595-1599,1621-1625,1645,1664,1687-1691` and `tourRemindersApi.test.ts ~:411-424,443-457,
  473-482` -> `day_before` / `morning_of`. Then ADD one case per surface (tour route, timeline)
  where a pending confirmation on an OPTED-OUT contact reads `discontinued`.
- Dashboard `types.test.ts`: `suppressionLead('discontinued')`, the label, and the
  no-stutter note check per plan T8 step 1(c).

Verify (in order): `cd .../app && npx vitest run test/tourReminders.test.ts test/devGating.test.ts
test/tourRemindersApi.test.ts test/contactTimeline.test.ts` after Task 7, then the FULL app suite
(`npx vitest run`, timeout 600000) - PASS before starting Task 8; after Task 8: the three named
files + `cd .../dashboard && npx vitest run` (full dashboard suite - the union widening fans
out) + `npm run typecheck` (root) + e2e tsc; then the FULL app suite AGAIN (Task 8 re-pointed
many fixtures). Commits: `feat(reminders): discontinued-kind guard; MANUAL_ONLY emptied - the
unpause` and `feat(reminders): discontinued reads on all read surfaces`.
