# Planner independent gates (2026-10-12)

Run by the planner on a quiet tree (no orchestrator, no child, no e2e session
live), bare, each gate redirected to a log with its exit code captured on the
next line (`.superpowers/sdd/planner-gates.sh`).

- HEAD: 7d5e36c621d9237536012ef2573ccc676913f11d (code identical to 15c1676f; later commits are records)
- Window: 2026-10-12T22:45:01Z to 2026-10-12T23:12:32Z

| Gate | Exit | Result |
|---|---|---|
| npm run typecheck | EXIT:0 | - |
| npm test | EXIT:0 | Test Files 440 (app) + 239 (dashboard) + 22 (e2e) + 34 (fake-twilio) + 13 (fake-twilio-web), all passed; no [dynamoAdmin] line |
| npm run smoke | EXIT:0 | smoke-dist: OK - 1655 import specifier(s) across 287 emitted file(s) |
| timeout 2700 npm run e2e | EXIT:0 | 340 passed (25.0m) |
| npx eslint <24 branch files> | EXIT:0 | no output; note: scripts/e2e-session.mjs is in the list and the config lints .ts/.tsx only, so that one path was not linted |
