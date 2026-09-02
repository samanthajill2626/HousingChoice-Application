# Slice 1 - Task 1 (single-pass interpolate) + Task 2 (three tokens x six sites)

Common brief (READ FIRST): `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\implementer-brief-common.md`
Report path: `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\reports\slice-1.md`
Research: report C section 1 (Task 1); reports A s1-s2 and B s1 (Task 2).

Scope: plan Task 1 (all six steps, including closing the issue
`docs/issues/message-interpolate-token-reexpansion.md`) and plan Task 2 (all five steps).
Files: `app/src/messages/resolve.ts`, `app/test/messages/resolve.test.ts`,
`docs/issues/message-interpolate-token-reexpansion.md`, `app/src/repos/tourRemindersRepo.ts`,
`app/src/jobs/tourReminders.ts` (ForceSendRefusal union ONLY - at `:1299-1329`),
`dashboard/src/api/types.ts`, `dashboard/src/api/types.test.ts`. Nothing else.

Deltas over the plan (worklist s2 T1/T2 + rulings):
- T1: `resolve.test.ts` already imports describe/expect/it, resolveMessage, MESSAGE_CATALOG
  (`:5-8`) - append the `describe` blocks ONLY. The structural charset test iterates
  `MESSAGE_CATALOG` from `../../src/messages/catalog.js`. Keep every existing case.
- T1: the probe entry `relay.member_added` currently declares `['joined','members']` and is
  non-editable - use it as the plan says (Task 14 will switch the probe later; leave a
  one-line comment saying so, as the plan's comment does).
- T2: `ForceSendRefusal` gains ONLY `'tour_already_passed' | 'kind_retired'` with one-line
  docblocks; `names_unavailable` is already a member.
- T2 (R13): `SEND_NOW_ERROR_COPY.names_unavailable` ALREADY EXISTS (`types.ts:1317-1318`)
  with cause-agnostic copy. The new PERMANENT_REFUSALS test's comment must say
  "names_unavailable keeps its existing cause-agnostic copy (retrying is right advice)" -
  do NOT claim it is absent and do NOT add/alter that key.
- T2: labels use no underscore (the "never a machine token" test); exact label strings are
  in the plan's Interfaces block. `SEND_NOW_ERROR_COPY` additions verbatim from the plan.

Verify: `cd .../app && npx vitest run test/messages/ test/tourCopy.test.ts` (T1);
`cd .../dashboard && npx vitest run src/api/types.test.ts` (T2); `npm run typecheck` from
the root after T2. Commit T1 (two commits per the plan: fix + docs), then T2 (one commit).
