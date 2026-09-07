# S3 build report: browser recovery and API failure contracts

## Contract and implementation

S3 adds no production dashboard or API transport code. The new API characterization
test pins the existing `request()` behavior: HTML 502 and 504 responses after one
POST become status-bearing `ApiError`s with synthetic `http_<status>` codes and no
parsed body. It also preserves the three JSON 503 refusal codes used by relay and
push UI decisions, plus successful JSON parsing.

The browser spec renders the actual S1 Terraform template through
`renderMaintenancePage()` and reads its actual JSON catalog with
`readMaintenanceCopy()`. It does not use a hand-authored document. Eight hermetic
browser cases cover 502 and 504, original GET and form POST navigations, and 320px
and 1280px widths. They assert the marker, all rendered copy, title, action target,
asset-free document, shared overflow measurement, 200 percent text enlargement,
keyboard focus outline, and a safe unqueried GET `/` recovery with no POST replay.

The route fulfillments are exact test-owned hermetic URLs. They prove local browser
behavior only; they do not emulate or prove hosted CloudFront error substitution,
distribution propagation, or AWS activation.

## Focused checks

- The first unprivileged dashboard test invocation exited 1 before Vitest began:
  Vite could not open its temporary worktree cache with `EPERM`. The same requested
  command with the isolated worktree cache permission exited 0: `3 passed` files and
  `59 passed` tests, including `client.maintenance.test.ts` with `6 passed` cases.
- `npm run typecheck -w @housingchoice/dashboard`: exit 0.
- `npm run typecheck -w @housingchoice/e2e`: exit 0, including the final rerun after
  the brand-copy assertion was added.
- `npm run e2e -- tests/dashboard-next/maintenance-page.spec.ts`: exit 0, `8 passed`
  in 20.7 seconds on hermetic lane 14. The first identical run before the one-line
  brand assertion also exited 0 with `8 passed` in 32.0 seconds.

The API test is intentionally a characterization test and was expected to pass
against the existing client. It does not manufacture a red transport state or alter
the client to satisfy an artificial TDD step. The real red-before-implementation
proof for the newly rendered document remains in S1.
