# S4 build research - findings (backfill script + RUNBOOK)

Live-tree drift check of plan Tasks 4.1-4.6 against W:/tmp/join-housing-authority @34e79ec7
(main 5c0d3f6a merged in; no drift in the S4 files since 469241f7). Evidence:
`.superpowers/sdd/build-research/S4-reference.md`.

No BLOCKER or MAJOR. Every API the S4 code calls exists with the assumed signature, every
audit payload shape matches its writer, the RUNBOOK anchor is found once, the per-file
DynamoDB key scheme and the guard tests accept the new test file, and the CLI exit-code tests
(including the child process) can execute as written.

## S4-F1 - MINOR - the no-container behavior the slice header describes is not what happens

- Plan: slice header, line 4824 (also the RED/GREEN steps of Tasks 4.1-4.5, e.g. 5048, 6094).
- Live: app/test/globalSetup.ts:66-87 (fetch at 70, `throw new Error(` at 81), and the fail-loud
  note at 14-17.
- What is wrong: the header says that from Task 4.3 the DynamoDB Local tests "SKIP when no
  container answers on :8000 (the console shows `[backfillJoinHousingAuthority] SKIPPED - no
  DynamoDB Local`)". With no container, vitest's globalSetup THROWS before any test file loads
  ("DynamoDB Local is not reachable ... Fix: npm run db:start"), so the whole targeted run fails;
  the file's SKIPPED line can only appear under ALLOW_SKIP_DYNAMO_TESTS=1 (which AR-5 reserves
  for the S1-S2 fake-only files). It also applies from Task 4.1, not 4.3: even the pure-rule RED
  in 4.1 ("Failed to load url ...") would instead show the globalSetup error if the container
  is down. No wrong result follows (a run without the container is never green either way).
- Correction: replace the header sentence with: "Every run of this file needs DynamoDB Local
  from Task 4.1 on: without it app/test/globalSetup.ts throws before the file loads (`DynamoDB
  Local is not reachable ...`). Check `docker ps` first (AR-5); start it with `npm run db:start`
  from `W:\tmp\join-housing-authority` only when no container is running. The file's own
  `[backfillJoinHousingAuthority] SKIPPED - no DynamoDB Local` line appears only under
  ALLOW_SKIP_DYNAMO_TESTS=1, and such a run is never GREEN."

## S4-F2 - MINOR - the RUNBOOK cost line undercounts the audit-history Queries

- Plan: Task 4.6 new section, the "Cost:" paragraph, line 7293.
- Live: app/src/repos/auditRepo.ts:122-141 (one Query per call, no cursor); the plan's own
  `readWholeHistory` (plan 6060-6077) reads until a page comes back EMPTY, as spec D10 requires.
- What is wrong: "per candidate one audit-history Query per 100 events" - every candidate not
  named in `--skip` costs one Query per 100 events PLUS one final Query that comes back empty
  (a candidate with no history: exactly one). The "seconds at today's volume" conclusion stands.
- Correction: in the new RUNBOOK section, change "then per candidate one audit-history Query
  per 100 events" to "then per candidate not named in `--skip` one audit-history Query per 100
  events plus one that comes back empty".
