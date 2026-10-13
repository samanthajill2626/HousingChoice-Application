# Planner independent gates, round 2 (after fix wave 1)

Run by the planner on a quiet tree (the orchestrator stopped, no child, no
session live in this worktree), bare, each gate redirected to a log with its
exit code captured on the next line. Gates 1, 2, 3 and 5 ran first; gate 4
waited until another worktree's e2e suite had finished and TIME_WAIT sockets
drained below 600 (the ERR_NO_BUFFER_SPACE class).

- HEAD: f563e68d17eadea6d1c8a7d79115f36eee83ae68 (code identical to 0eb44652; f563e68d adds a record)

| Gate | Exit | Result |
|---|---|---|
| npm run typecheck | EXIT:0 | - |
| npm test | EXIT:0 | Test Files 440 + 239 + 22 + 34 + 13, all passed; no [dynamoAdmin] line |
| npm run smoke | EXIT:0 | smoke-dist: OK - 1655 import specifier(s) across 287 emitted file(s) |
| npx eslint <32 branch files> | EXIT:0 | no output (scripts/e2e-session.mjs is in the list but .mjs is not linted by the config) |
| timeout 2700 npm run e2e | EXIT:1 | 339 passed / 1 failed (30.4m); TIME_WAIT at start: 585 |
| the failing file alone: npm run e2e -w @housingchoice/e2e -- tests/scenarios/scheduled-visibility.spec.ts | EXIT:0 | 5 passed (43.8s) |

The gate-4 failure: `tests/scenarios/scheduled-visibility.spec.ts:177` (a)+(b) at
`e2e/scenarios/steps.ts:3666`, an entirely white document after the reminder's
proof-of-send step had already passed - the eighth sighting of the open
`e2e-blank-document-after-contact-navigation` (appended there). The branch does
not touch tour reminders, the contact page or its communications region; the
same file passed 5/5 alone straight after, and the orchestrator's gate 4 on the
same code (0eb44652) passed 340/340 on a quiet host. Classified ENVIRONMENTAL
(Windows socket-buffer exhaustion under concurrent suites), not a regression.
Artifacts preserved at `.superpowers/sdd/planner-e2e-results-1/` before the re-run.
