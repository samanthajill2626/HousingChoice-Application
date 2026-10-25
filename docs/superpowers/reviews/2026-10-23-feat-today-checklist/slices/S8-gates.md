# S8 - gate results (feat/today-checklist)

- Gates run: 2026-10-25 15:22:45Z - 16:08:22Z (gates 1-4, one detached
  battery), gate 5 right after; Windows host, Node v24.21.0.
- Tree under test: HEAD f082374f (the self-QA record commit; every code
  commit is below it). main synced: main @970a29b9 already contained (HEAD..main
  0) - no merge commit; npm ci after the merge: no (nothing merged).
- DynamoDB Local: up (container hc-dynamodb-local; `npm run db:start` not run -
  the container was already up and the e2e launcher runs its own start check).
  Exported AWS_* names: none.
- No e2e stack of this worktree alive before the run (session.pid absent; lane
  12 / 13 ports free).

| # | Gate | Command (bare) | Exit | Result (from the log) |
|---|---|---|---|---|
| 1 | typecheck | npm run typecheck | 0 | no errors (app, dashboard, e2e, fake-twilio, fake-twilio-web) |
| 2 | test | env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npm test | 0 | app: Test Files 533 passed (533), Tests 11406 passed / 1 skipped (11407); dashboard: 270 passed (270), 5573 passed (5573); e2e workspace: 22 passed (22), 509 passed (509); fake-twilio: 34 passed (34), 275 passed (275); fake-twilio-web: 13 passed (13), 111 passed (111) |
| 3 | smoke | npm run smoke | 0 | "smoke-dist: OK - 1747 import specifier(s) across 303 emitted file(s) resolve under plain Node." |
| 4 | e2e | timeout 2700 npm run e2e | 0 | "377 passed (40.9m)" - no failed, no flaky, no skipped |
| 5 | eslint, branch files | npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs') | 1 | 116 files; exactly 1 error, pre-existing (below); 0 errors attributable to this branch |

- [dynamoAdmin] lines in gate 2: none.
- Re-runs: none. Gate 4 ran once and passed; at 40.9 minutes it was more
  than twice the 17.8-minute run1 at c7705789 (same 2700 s cap), so it came
  within about 4 minutes of the timeout - a slower host, not a failure, but
  worth knowing before the planner's own run.
- Pre-existing lint errors (baseline-attributed, not this branch's):
  dashboard/src/routes/tours/useTours.ts:128:5 react-hooks/set-state-in-effect
  (useClosedTours). The merge-base copy (970a29b9, through the branch's
  eslint.config.mjs, `--stdin --stdin-filename`) reports the identical error
  at 128:5 (worklist WL-14).
- Lint coverage hole: app/scripts/seed-smoke.mjs is in the list and is
  checked by no rule (the config lints .ts / .tsx only).
- Earlier battery (run1, at c7705789, before the review fix waves): all four
  gates 0 (app 533 / 11389, dashboard 268 / 5544, e2e 376 passed in 17.8m).
  The final result above is the one that counts: it names HEAD f082374f,
  which contains every fix wave (FW1-FW5).
