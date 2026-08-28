---
id: e2e-typecheck-masks-ts6142
title: E2E spec import pulled dashboard JSX into typecheck
type: bug
severity: med
status: closed
area: build/typecheck
created: 2026-08-28
refs: e2e/tests/dashboard-next/relay-inbound-caller-identity.spec.ts, dashboard/src/routes/contact/format.ts
---

**Problem.** The relay caller identity E2E spec imported the dashboard contact
formatter. That formatter imported the dashboard API barrel, which re-exports
`EventStreamProvider.tsx`. The E2E TypeScript configuration intentionally has
no JSX setting, so its workspace typecheck failed with TS6142.

The E2E workspace typecheck passed on `main`, proving this was branch-caused
rather than baseline debt.

**Resolution.** `dashboard/src/routes/contact/format.ts` now imports its values
and types directly from the pure `dashboard/src/api/types.ts` module. The
formatter remains usable by the E2E assertion without pulling the `.tsx` API
barrel into the E2E compile graph. `npm run typecheck -w @housingchoice/e2e`
then exits zero.
