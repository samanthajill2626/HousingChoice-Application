# Reader B - READ SURFACES: routes + dashboard + seeds (plan Tasks 2, 8, 9-seeds, 12)

Common brief: `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\research-brief-common.md`
Report path: `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\reports\research-B-surfaces.md`

Files: `app/src/routes/tourReminders.ts`, `app/src/routes/contactTimeline.ts`,
`app/src/routes/dev.ts`, `app/src/routes/api.ts`, `app/src/services/scheduledSendSuppression.ts`,
`dashboard/src/api/types.ts`, `dashboard/src/api/types.test.ts`,
`dashboard/src/routes/tours/RemindersPanel.tsx`, the contact timeline scheduled
card (`grep -rln "suppressionNote\|TimelineScheduled\|paused" dashboard/src/routes/contact/`),
`dashboard/src/routes/placements/DeadlinesNudgesCard.tsx`, seeds
`app/src/lib/seed/{matrix,live,lean,cast}.ts`, tests `app/test/tourRemindersApi.test.ts`,
`app/test/contactTimeline.test.ts`, `app/test/seedLive.test.ts`, `app/test/devGating.test.ts`.

Deliver:
1. Dashboard `types.ts`: byte-exact `TourReminderView` (incl. `skipReason` union
   and `state`), `REMINDER_SKIP_REASON_LABELS`, `SEND_NOW_ERROR_COPY` + exported
   `sendNowErrorMessage`, `ScheduledSuppressionReason` wire union,
   `suppressionLead`, `suppressionNote`, `REMINDER_SUPPRESSION_LABELS`; and in
   `types.test.ts` the `SKIP_REASONS` array + how the label tests are shaped.
2. App `scheduledSendSuppression.ts` union byte-exact + EVERY consumer of
   `ScheduledSuppressionReason` app+dashboard (exhaustive `Record`s especially -
   the plan says three; find them all).
3. `routes/tourReminders.ts`: `TourReminderView` type, `stateOf`, `viewOf`
   (PATCH echo), GET projection block, the chip/suppression derivation branch
   (quote it fully), `suppressionOf` construction and the `self_guided` guard,
   `hasUpcoming`, next-rung pick, the quiet-hours estimate disjuncts, the
   send-now handler and how `result.reason` reaches the wire, the
   `manualOnlyKinds` injection seam docblock.
4. `routes/contactTimeline.ts`: its own `MANUAL_ONLY_REMINDER_KINDS` read and the
   full consuming expression; `quietFor` closure and `suppressionFor` and the
   REMINDER call site vs the placement-nudge call site (plan PR2-5 says exempt
   at the reminder call site only). Quote.
5. Dashboard renderers: `RemindersPanel.tsx` chip logic around `paused` and the
   "sends in Nh" fallthrough (quote); the timeline `ScheduledCard` equivalent;
   `DeadlinesNudgesCard.tsx` record. Any OTHER dashboard reader of
   `suppression.reason` or `skipReason` (grep).
6. `routes/dev.ts` tick route: the DELIBERATE DIVERGENCE block byte-exact, and
   `devGating.test.ts` expectations that depend on it.
7. Seeds: every `confirmation` site in matrix/live/lean/cast with the surrounding
   comment intent (panel demo vs to-be-ticked vs historical sent); what
   `seedLive.test.ts` pins about arm results (dueAts, pending sets).
8. E2E inventory for Tasks 6/9/12 (cross-check with Reader D who owns steps.ts
   mechanics): grep `confirmation` in `e2e/tests/scenarios/scheduled-visibility.spec.ts`,
   `e2e/tests/scenarios/tours.spec.ts`, `e2e/tests/tour-roster.spec.ts`; classify
   each (cat1 convert / cat2 redesign / cat4 behaviour-changes-green) with a
   one-line intent; quote `tours.spec.ts` ~283-287.
