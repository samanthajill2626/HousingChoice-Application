# Slice 6 - Task 10 (en_route quiet-hours exemption at THREE sites + widened supersession) + Task 11 (names bound at BOTH sites) + Task 12 (`overdue` flag)

Common brief (READ FIRST): `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\implementer-brief-common.md`
Report path: `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\reports\slice-6.md`
Research: report A section 1 (arm loop clamp, `supersededBySlot`, `LADDER_ORDER` docblock,
`isQuietTime` backstop, both `ReminderNamesUnavailableError` catch sites, `rosterWaitExpired`),
section 6 (rig idioms, stub-to-throw pattern, `DEFER_WARN`); report B sections 3-5 (the
route's quiet-estimate disjuncts, `nowIso` block-scoping, `viewOf` + GET projection, the
timeline's `quietFor`/`suppressionFor` and its REMINDER call site vs the placement-nudge call
site, `RemindersPanel.StateChip` shape, `sendRelative`), section 7 (`seedLive.test.ts:55-84`
hand-mirrored `computeDueAt`). Line numbers have drifted since - locate by NAME. Read
reports slice-4 and slice-5 for what already moved (discontinued chip is in `StateChip`
ABOVE paused with a comment reserving the overdue slot BELOW it).

Scope: plan Task 10 (steps 1-5), Task 11 (steps 1-3), Task 12 (steps 1-4). Three commits.

Binding deltas (worklist s1 R14, R15; s2 T10/T11/T12; spec 6, 6.2, 7, 8):
- T10 arm-time: `dues.set(kind, kind === 'en_route' ? raw : clampOutOfQuietHours(raw, window))`
  with the founder-decision comment; `clampOutOfQuietHours` itself UNTOUCHED (shared helper).
  Fire-time backstop: `if (row.kind !== 'en_route' && isQuietTime(now, window))` + a sentence
  that the past-tour gate above bounds the catch-up backlog. `supersededBySlot`: the plan's
  exact widened predicate `otherDue !== undefined && otherDue <= dueAt && otherDue < scheduledIso`
  with its comment; REWRITE the `LADDER_ORDER` docblock (the "clamping can only push an
  EARLIER rung forward" sentence is now false and is what a reader would use to revert the
  predicate). `supersededInBatch` UNTOUCHED. The four tests in plan T10 step 1 written fully,
  including the 08:30 double-send REGRESSION and the unclamped-ladder NO-OP pin.
- T10 THIRD SITE (spec 6 addendum): exempt `en_route` from the QUIET disjuncts ONLY (opt-out /
  kill switch / manual mode still apply) at `routes/tourReminders.ts` (`suppressionOf`'s
  `evaluate(... quiet ...)` - pass `false` for the quiet operand when `row.kind === 'en_route'`,
  by threading the kind or a pre-computed boolean) AND at `routes/contactTimeline.ts`'s
  REMINDER call site of `suppressionFor` inside the tour walk - NEVER inside `quietFor` or
  `suppressionFor` themselves (they are shared with the placement-nudge walk). Failing tests
  first in `tourRemindersApi.test.ts` and `contactTimeline.test.ts`: a pending `en_route`
  with dueAt inside the window carries NO `quiet_hours` suppression while its `day_before`
  sibling does.
- R14: `app/test/seedLive.test.ts` hand-mirrors `computeDueAt` and clamps EVERY kind; mirror
  the exemption there (its docblock demands lockstep) and re-derive any dueAt pin that moves.
- T10 step 4: re-read `e2e/tests/scenarios/quiet-hours.spec.ts` against the exemption
  (`day_before` is not exempt, so its two tests should be unaffected - confirm and say so;
  if any comment reasons about `en_route` and quiet hours, re-derive it). No Playwright.
- T11: both catch sites gain the bound with the plan's exact shape (`rosterWaitExpired(row.dueAt,
  now)` -> `claimSkipRow(row, 'names_unavailable', now, deps, tour.tenantId)`); keep the
  inside-the-hour `log.warn` string VERBATIM (`DEFER_WARN` is asserted at test `~:3497`);
  replace the ledger-item-7 acceptance comment at the GROUP site. Tests for EACH route
  (self_guided/1:1 and landlord_led/group) x (a) inside the hour re-lists, (b) past the hour
  claim-skips once, (c) force-send still refuses `names_unavailable` and never retires. Use the
  file's stub-to-throw idiom (report A s6) and drive with `now = dueAt + 61min` (rungs must
  still be BEFORE the tour - pick fixtures accordingly, the gate is live).
- T12: `overdue?: boolean` on `TourReminderView` (app + dashboard) with spec 8.1's docblock
  verbatim; BOTH builders (`viewOf` for PATCH echo, the GET projection) compute their OWN
  `nowIso` (`new Date().toISOString()`) - the GET route's existing `nowIso` is block-scoped
  inside the `self_guided && hasUpcoming` branch; do NOT lift it; `state === 'upcoming' &&
  row.dueAt < nowIso`, conditional-spread omitted when false. Route tests: GET past-due upcoming
  -> `overdue: true`; future -> no key; sent/skipped -> no key; PATCH cancel/restore echo
  computes it identically. Panel: on an upcoming rung with `overdue`, replace the
  "sending shortly"/"sends in" promise with an amber `Overdue` chip; when a suppression note
  exists the note still renders alongside (composition per existing patterns, plain hyphens);
  the chip sits BELOW the discontinued branch and ABOVE paused (R15) - pin ORDER with a
  component test (discontinued + overdue -> "No longer sent"). Dashboard `RemindersPanel.test.tsx`
  cases first.
- T12 step 3: ONE e2e assertion in an existing `scheduled-visibility.spec.ts` case where a rung
  can be driven past its dueAt WITHOUT ticking and still be pending. Derive whether that is
  reachable with far-future fixtures under a live 30s worker: it is NOT (a past-dueAt pending
  rung is exactly what the worker sends). Two acceptable routes: (a) the quiet-hours spec's
  deferred day_before (test (2): after the in-window tick it is pending AND past-due - it IS
  overdue by construction) - add the `Overdue` chip assertion THERE, beside QUIET_NOTE; or (b)
  skip the e2e assertion and say so. Prefer (a); if you take (b), record why.
- Spec 8.2 exclusions stand: no `overdue` on the timeline or the relay scheduled view.

Verify: `cd .../app && npx vitest run test/tourReminders.test.ts test/tourRemindersApi.test.ts
test/contactTimeline.test.ts test/seedLive.test.ts` after each task; `cd .../dashboard && npx
vitest run src/routes/tours src/api` after T12; `npm run typecheck` (root); `cd .../e2e && npx tsc
--noEmit -p .`; then the FULL app suite once at the end (timeout 600000). Commits:
`feat(reminders): en_route quiet-hours exemption; supersession predicate widened`,
`feat(reminders): one-hour names bound at both unclaimed-return sites`,
`feat(reminders): derived overdue flag on both view builders`.
