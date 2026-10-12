# Plan review R2 - reviewer B

Plan @1da54a3c (round-1 fold-in), worktree tree @469241f7 + docs. Read the
plan diff `59a725f2..1da54a3c`, the spec diff, both round-1 reports and the
adjudications, and re-checked the changed tasks against the merged tree.
Read-only: files and grep only; nothing run.

## Result

No BLOCKING, HIGH or MEDIUM finding. Four LOW findings, all in contingency
paths or in the operator commands of the new and rewritten tasks. One concession
(P5).

## 1. What we all missed: main's three commits against the plan

Nothing a task still assumes was broken by e27868bc, 794de277 or 5c0d3f6a:

- `git diff --stat 19607658 469241f7` touches none of `dashboard/src/routes/public/`,
  `app/src/routes/public.ts`, `app/src/app.ts`, the harness, `e2e/scenarios`,
  `e2e/tests/scenarios`, `STATUS-MODEL.md`, `sequence-diagram-to-test.md`,
  `scripts/e2e-session.mjs` or `e2e/support/selectors.md` (empty stat).
- `app/test/publicIntake.test.ts` now has 30 tests (main added one inside the
  flyer describe). The last six lines are unchanged (Task 1.3 anchor), and so is
  the first test (Task 2.3 anchors). The re-counted chain
  30 -> 37 -> 39 -> 45 -> 54 -> 58 is right.
- `public-pages.spec.ts`: the /join test is now :371-386. The Edit D anchor
  (:384-385) is still unique, there are still 6 tests, and main's additions (:159
  and :317 "Fits a N-bedroom voucher") load no /join and create no contact.
- RUNBOOK :450 is main's new heading. The Task 4.6 grep pattern prints 1 on
  this tree (verified).
- `unitFields.ts` / `unitsRepo.ts` (`clearable_number`, `acceptedVoucherSizes`)
  change no type the plan's test fixtures build (`{ unitId, landlordId, status,
  beds }` is still a valid `UnitItem`).

## 2. The changed tasks

Verified correct:

- Task 4.5 `main(argv, cli?)`:
  - It narrows `parsed` and `skip` after the usage return.
  - `stage` is definitely assigned before `finally`.
  - Every test call matches `CliDeps`. `StageTarget` and `StageClientOpts` are
    exported (`app/scripts/lib/stageClient.ts:51`, `:65`).
  - The usage cases parse as claimed, e.g. `--skip ''` reaches
    `parseSkipList('')` -> undefined (`stageClient.ts:197-200`).
- The Task 4.5 child test will run under vitest on Windows from app/:
  - The `node --import tsx` form is the working precedent at
    `app/test/otel.test.ts:276-283`.
  - `npm test` runs the app workspace with cwd `app/` (root `package.json:39`),
    so `tsx` resolves upward to the root devDependency (`package.json:83`).
  - In the child, `invokedDirectly` is true through the `endsWith` arm.
  - No module in the import graph starts a transport or interval (pino is
    created without a transport, `app/src/lib/logger.ts:254-257`), so the child
    exits with `process.exitCode = 2`.
  - RED is right too: without an entry block the child exits 0.
- Task 6.3a's seeding script cannot reach the live local stack:
  - `lane >= 1` is enforced.
  - The prefix and key are both derived from L and come from the same
    `resolveStageClient` (`stageClient.ts:122-141`).
  - `holdsLane(lane, token)` matches `e2e/support/laneLease.mjs:301-305`, and a
    direct `npm run e2e:session` holds a string token (`e2e/support/lane.mjs:387-396`).
  - The ping fields exist: `lane` comes from `E2E_LANE`, which the launcher
    passes to its children (`scripts/e2e-session.mjs:299`;
    `app/src/routes/dev.ts:207-231`), and `/__dev/*` is exempt from the
    origin-secret validator (`app/src/middleware/originSecret.ts:44-47`).
  - Root `"type": "module"` makes its top-level await legal under tsx.
  - Clean-slate really clears contacts (`scripts/e2e-session.mjs:547-559`), so
    the only candidates are the rehearsal rows.
- Task 6.3a's expected outputs are what the S4 code prints:
  - `leadLine`, `REASON_TEXT` and the header/count lines (Task 4.2) produce the
    Steps 5-7 text exactly: sort by sign-up date, left-out order, the
    unknown-skip line, and no warning (the lean list has Atlanta and no
    `lastRewrite`).
  - The seed's `created  ...` and `--verify` lines match its own `console.log`
    formats.
  - `--lane 0` is a usage error (`stageClient.ts:96`, `:210`).
- S5 readiness grep `\[e2e-session\] ready .*app :[0-9]+ ` matches only
  `scripts/e2e-session.mjs:766`; the log prefix is `[e2e-session] `, `:307-309`.
- The RED swap source 469241f7 has `dashboard/src/routes/public/` identical to
  19607658.

### F1 [LOW] The gate-4 tree-kill (P8) looks for processes the stack's root does not match

What is wrong. Task 6.2 gate 4 says to find "the processes whose command line
contains `W:\tmp\join-housing-authority`" and `taskkill /T` them. Those command
lines are relative:

- the launcher is `node scripts/e2e-session.mjs` (`e2e/playwright.config.ts:189`;
  root `package.json:42`);
- the app and worker are `node --import tsx app\src\index.ts|worker.ts`, spawned
  with cwd = the repo (`scripts/e2e-session.mjs:348-356`, `:422-425`).

Only Vite carries the absolute path (`viteBin`, `:38`). So the instruction finds
Vite, and `/T` from Vite leaves the launcher, app and worker running.

What it implies. P8 is plausible but not correct as written. The port check
that follows would expose the survivors, but the builder has no working remedy
in the text. Kill by the launcher's PID instead: `launcherPid` in
`e2e/.artifacts/lane.json` or `e2e/.artifacts/session.pid`, then
`taskkill /PID <pid> /T /F`. Or simply run `npm run e2e:stop`, which reads that
file.

### F2 [LOW] Task 6.3a Step 2's curl fallback will get a 403

What is wrong. The fallback POSTs to `<urls.app>/public/housing-fair` with no
`x-origin-verify` header. The app refuses that
(`app/src/middleware/originSecret.ts:49-52`). Only the Vite proxy stamps the
placeholder (`dashboard/vite.config.ts:28-30`).

What it implies. If the MCP is unavailable, the step prints a 403, not
`{"ok":true}` / `HTTP 200`. Step 8's marker line then reads NOT FOUND. Post to
`<urls.dashboard>/public/housing-fair` instead, or add
`-H "x-origin-verify: dev-placeholder-not-a-secret"`.

### F3 [LOW] Task 6.3a's write command depends on a hand-typed `<L>`

What is wrong. The seeding script is guarded four ways, but the command that
writes (Step 6 `--apply`) is retyped by the builder with `<L>` substituted.
Drop `--lane` and it is a bare `--env local`, which is the human's live local
stack; the backfill itself has no guard against that, by design. The "STOP on an
unexpected contactId" rule covers only Step 5's dry run, which is typed
separately.

What it implies. One typo turns the rehearsal's only write onto live data. Read
L inside each command, in the same Bash call, e.g.
`L=$(node -p "require('./e2e/.artifacts/lane.json').lane") && npx tsx app/scripts/backfill-join-housing-authority.ts --env local --lane "$L" ...`.

### F4 [LOW] The lint baseline worktree (P7, and gate 5) has no node_modules, so it cannot lint

What is wrong. Task 3.2 (new) and Task 6.2 gate 5 attribute lint errors by
running `npx eslint` inside a fresh `git worktree add --detach`. Nothing
installs dependencies there:

- `npx` finds no local eslint, and with no TTY `npm exec` assumes `--yes`, so it
  fetches an unpinned eslint from the network;
- that eslint then cannot load `eslint.config.mjs`, whose `typescript-eslint` and
  `eslint-plugin-react-hooks` imports (`eslint.config.mjs:2-3`) resolve from the
  throwaway tree, which has none.

What it implies. This is a contingency path only (the files the branch touches
are expected lint-clean), but if it fires it produces no baseline. The obvious
workaround, linking node_modules across worktrees, is a recorded incident in
this repo. Name a working method: `npm ci` in the throwaway, or lint the base
copies from the feature worktree with `git show <base>:<path>` written beside the
file, so the same config block applies.

## 3. Contesting the adjudications

- P5: conceded. Both edges are one-shot or unreachable: no writer sets
  `deleted_at: ''`, the only literal writes are seed stamps
  (`app/src/lib/seed/performance.ts:578,607`), restore REMOVEs it, and the race
  lasts only while the one-time run runs. That makes them design limits for the
  spec, not tracked work.
- P1, P2, P3, P4, P6: correct as applied (section 2).
- P7: plausible only (F4). P8: plausible only (F1).
