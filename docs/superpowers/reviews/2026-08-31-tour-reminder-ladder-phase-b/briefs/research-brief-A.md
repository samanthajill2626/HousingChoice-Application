# Reader A - tour reminders JOB + repo + unit tests (plan Tasks 3, 5, 7, 10, 11)

Common brief: `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\research-brief-common.md`
Report path: `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\reports\research-A-job.md`

Files: `app/src/jobs/tourReminders.ts`, `app/src/repos/tourRemindersRepo.ts`,
`app/src/lib/rosterResolution.ts`, `app/test/tourReminders.test.ts`, and the
seven other app test files the plan's "Derived conversion inventory" names.

Deliver:
1. Anchors, true lines, quoted: `REMINDER_KINDS`, `LADDER_ORDER` + docblock,
   `MANUAL_ONLY_REMINDER_KINDS` + full docblock span, `computeDueAt`, the arm
   loop clamp line, `supersededBySlot`, `staleDayBefore`, `processReminderRow`
   full gate order (supersededInBatch, isQuietTime backstop, beforeStart/group-open-
   pending, roster gate, names compose) with lines, `claimSkipRow` + docblock,
   `resolveReminderTarget` signature + its tour fetch + tour-missing skip reason,
   `forceSendReminder` structure (where `refuse` is declared, order of row lookup /
   target resolution / compose / claim), `ForceSendRefusal` union byte-exact, both
   `ReminderNamesUnavailableError` catch sites, `rosterWaitExpired` import/usage,
   the poll's due-row filter and its `manualOnlyKinds` dep, `runDueTourReminders`
   deps shape (what is injectable).
2. `ReminderSkipReason` union byte-exact; `ReminderKind` union; the repo's key
   layout (PK/SK, table, GSIs) for the reminders rows - Task 4's Scan needs it;
   `create()` behaviour on a past dueAt (does it drop? plan says only
   armTourReminders drops).
3. TOURS REPO: is the getter `get` or `getById`? Quote the deps member name the
   job uses for tours (plan flags this trap).
4. THE CONFIRMATION CONVERSION INVENTORY (plan Task 5 step 1): grep
   `confirmation` in `app/test/tourReminders.test.ts` and the seven other files;
   classify EACH site: cat1 (immediate-send ride -> convert), cat2 (asserts it
   arms / ladder position -> Task 9 re-baseline), keep (union/computeDueAt/copy
   pins). Table: file:line, one-line what it does, category, and for cat1 the
   tour scheduledAt relationship to now (the 6.1a precondition: replacement
   dueAt must be < scheduledAt).
5. Every reader of `manualOnlyKinds` / `manualOnlyReminderKinds` /
   `MANUAL_ONLY_REMINDER_KINDS` app-wide (app/src, e2e) with lines - the plan
   names `routes/api.ts`, `routes/contactTimeline.ts`, `routes/tourReminders.ts`,
   `routes/dev.ts`; find any it missed.
6. Test rig idioms in `tourReminders.test.ts`: how a fake world is built
   (`createFakeWorld`?), how ticks are driven, how repos are stubbed to throw,
   quiet-hours config shape - 10-20 quoted lines a builder can copy.
