# Task 10 fix wave 1 report

## Commit

`c784ccafcb89b357458a9dd410d48889c99a2806 fix: preserve complete message transport presentation`

Files committed:

- `dashboard/src/lib/messageTransport.ts`
- `dashboard/src/lib/messageTransport.test.ts`

## TDD evidence

The first sandboxed focused test attempt exited 1 before executing tests because Vite
could not create `dashboard/node_modules/.vite-temp/...mjs` (`EPERM`). The same
focused command in the permitted worktree environment executed the tests and was red
as intended:

```
npm run test -w @housingchoice/dashboard -- src/lib/messageTransport.test.ts src/routes/contact/deliveryStatus.test.ts
Exit 1: 1 failed, 1 passed; 3 failed, 111 passed, 114 total.
```

The three failing regressions proved: state-absent slots blocked a complete
aggregate, actual-only outbound presentation returned `Unknown`, and an opted-out
recipient returned no requested transport.

After the narrow presenter changes, the same command was green:

```
Exit 0: 2 test files passed; 115 tests passed.
```

Additional checks:

```
npm run typecheck -w @housingchoice/dashboard
Exit 0

git diff --check
Exit 0
```

## Scope and constraints

- Expected aggregate slots are now only `planned` and `attempted`; state-absent and
  excluded slots do not affect completeness or actual aggregation.
- Requested-absent plus known actual now presents the actual for direct and complete
  uniform recipient cases. Both-absent remains `Unknown`.
- Only an excluded `contact_opted_out` recipient presents requested-only transport;
  an excluded row without that code still returns `null`.
- `deliveryStatus`, Timeline, e2e, and unrelated delivery behavior were not touched.
- The review adjudication calls for correcting the conflicting Task 10 plan table,
  but that records change was outside this fix wave's exact owned paths.
