# Caseworkers branch B - Windows completion gates (2026-10-11)

Requested by `handback-local-2026-10-12.md` section 4. Run by the local
planner session (Claude Code, Windows) on the Windows dev machine.

| Item | Value |
| --- | --- |
| Branch / tip | `feat/caseworkers` @ `e77fc543` (fast-forwarded from `51a4868c`; `git diff --name-only 2f875cea HEAD` = two Markdown files under `docs/`) |
| Base | local `main` = `github/main` = merge base = `d8749158` (main has not moved) |
| Machine | Windows 11 Pro, Node v24.21.0, Git Bash (coreutils `timeout`) |
| Browser | repo-pinned Playwright 1.61.0, Chromium 149.0.7827.55 (revision 1228); no shim |
| AWS env | `Get-ChildItem env:AWS_*` empty - no exported key |
| Verdict | gates 1, 2, 3, 5 PASS; gate 4 NOT clean: 337 passed / 1 failed on a fresh stack (the failure is a second sighting of the open `e2e-blank-document-after-contact-navigation`; the file passes alone 3/3) |

## Gates

Each gate ran bare from `W:\tmp\caseworkers`, one at a time, output
redirected to a file, never piped.

| Gate | Command | Exit | Result | Duration |
| --- | --- | --- | --- | --- |
| 1 | `npm run typecheck` | 0 | all workspaces | 29 s |
| 2 | `npm test` | 0 | 740 files (437 + 234 + 22 + 34 + 13); tests 9137 passed + 1 skipped, 4380, 503, 275, 111; no `[dynamoAdmin]` line | 3 min 31 s |
| 3 | `npm run smoke` | 0 | `smoke-dist: OK - 1649 import specifier(s) across 286 emitted file(s)` | 5 s |
| 4 | `timeout 2700 npm run e2e` | see below | see below | see below |
| 5 | `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` (152 files; list non-empty, local `main` at the base) | 1 | exactly the 5 known base errors: `BroadcastComposer.tsx:204,229,248,263`, `ContactsList.tsx:184` (`react-hooks/set-state-in-effect`); none new - ratchet pass | 6 s |

## Gate 4 - three attempts

| Run | Stack | Exit | Outcome |
| --- | --- | --- | --- |
| A | DynamoDB Local container up since 2026-10-06 | 124 (timeout) | 319 passed in 45 min, then the 2700 s cap killed the stack; test 320 (`tenant-onboarding.spec.ts:52`) failed with `page.goto: Page crashed` at the kill instant - collateral, not a test failure |
| B | same, machine idle | stopped by hand | pace check after 52 matched tests: 2.52x the 2026-10-08 Windows run; stopped (tree-killed, `npm run e2e:stop`, lane ports confirmed free) |
| C | after `docker restart hc-dynamodb-local hc-s3-local` (Cameron's call) | 1 | **338 tests, 337 passed, 1 failed, 27.7 min** |

### Runs A/B: a 2.1-2.5x uniform slowdown (resolved by the stack restart)

- Per-test comparison against the builder's 2026-10-08 Windows run on this
  machine (`results.json`, 337 passed in 23.2 min): run A was 2.13x slower
  over 310 matched tests, evenly across all four quarters of the suite
  (2.43 / 2.40 / 1.85 / 2.19); run B 2.52x on an idle machine (CPU 6%, 35 GB
  free). Not transient machine load.
- Ruled out: the section 2B harness merge (it only changes how the one-time
  fake-UI build finds `npm-cli.js`); DynamoDB Local latency from a fresh
  client (ListTables 13 ms, DescribeTable median 2 ms, Scan-100 2-41 ms,
  PutItem / UpdateItem median 1 ms); its JVM (724 MB of a 2 GB heap, 0 full
  GCs, 20.7 s total GC over five days); log volume (about 30 lines/s);
  the VS Code Playwright test server (idle).
- Where the time went in run A (server `request completed` logs): write-heavy
  endpoints - `POST /status` average 1330 ms over 484 calls, `POST /sms`
  1038 ms, `POST /__dev/reseed` 3823 ms (max 20.5 s), `DELETE` 1629 ms - while
  simple reads stayed near 70 ms.
- After restarting both containers (DynamoDB Local keeps its data on tmpfs,
  so the restart wiped it; the S3 container keeps a Docker volume), run C's
  first 55 matched tests ran at 1.18x and the whole suite finished in
  27.7 min. The stack restart removed the slowdown; its root cause inside the
  long-running container (up five days, 100 databases, 564 MB on tmpfs) was
  not isolated.

### Run C: the one failure

- `tests/scenarios/post-tour-application.spec.ts:249` ("marked deviation -
  party backs out early at Awaiting receipt -> Lost"), 25.9 s:
  `expect(locator).toBeVisible()` on the contact page's Details section
  `getByText('Searching')`, 15 s timeout, element not found. The failure
  screenshot is an entirely WHITE document; the page snapshot is empty.
- The file passed alone 3/3 (`npm run e2e -w e2e --
  tests/scenarios/post-tour-application.spec.ts`: 5 passed in 1.5, 1.4,
  1.4 min) and passed in run A. Branch B does not touch this spec; it changes
  three wording lines in `e2e/scenarios/steps.ts`.
- Same signature as the open
  [e2e-blank-document-after-contact-navigation](../../../issues/e2e-blank-document-after-contact-navigation.md)
  (2026-10-08: a white document after contact navigation in
  `landlord-onboarding.spec.ts`, passing alone). This is a second sighting in
  a different scenario. No browser trace was captured (the gate does not set
  `E2E_TRACE=1`); screenshot and video are kept locally (below).
- Not treated as a pass. Per AGENTS.md there is no named-flake list; this is
  reported for Cameron's call.

## Preserved local evidence (not committed; Cameron's machine)

Under the planner session's scratchpad
(`C:\Users\Cameron\AppData\Local\Temp\claude\W--AI-Projects-Housing-Choice-HC-Application\eab7cc8f-b4a4-4165-b839-a90bf3693203\scratchpad\`):
`g1.log`, `g2.log`, `g3.log`, `g5.log`, `g4.log` (run A), `g4b.log` (run B),
`g4c.log` (run C), `g4-artifacts/` and `g4c-artifacts/` (test-results,
screenshot, video, results.json), `iso1-3.log`.

## Open for Cameron

1. Gate 4 is 337/338 on Windows. Options: accept with the second blank-document
   sighting recorded against its open issue, or re-run the full suite with
   `E2E_TRACE=1` to capture the trace that issue asks for.
2. The long-running DynamoDB Local container degraded write-heavy e2e traffic
   about 2.5x before the restart. Worth a line in the e2e README or an issue
   (restart wipes tmpfs data, so it stays Cameron's call).
3. Not done: the optional visual check (handback section 4.3).

## Addendum (2026-10-11, Cameron's decisions)

- The failing test alone: `npm run e2e -w e2e -- tests/scenarios/post-tour-application.spec.ts:249`
  -> exit 0, 1 passed (13.2 s).
- Item 1: filed for later review - the second sighting is appended to
  `docs/issues/e2e-blank-document-after-contact-navigation.md`.
- Item 2: filed - the sighting is appended to the existing
  `docs/issues/dynamodb-local-slows-after-sustained-concurrent-load.md`
  (the same never-released-databases problem; no duplicate issue).
