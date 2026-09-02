---
id: globalsetup-reenables-ttl-on-shared-tables
title: "globalSetup re-enables TTL on the shared hc-local- tables every npm test run, defeating DYNAMO_DISABLE_TTL for shared-table suites"
type: bug
severity: med
status: open
area: app/test-infra
created: 2026-09-01
refs: app/test/globalSetup.ts:90, app/vitest.config.ts:119, app/src/lib/dynamoAdmin.ts, app/src/lib/tables.ts:231
---

**Problem.** Probed directly on 2026-09-01 (npm-test-soundness mission,
records `docs/superpowers/reviews/2026-08-31-npm-test-soundness/measurements/s5-clean-key.md`):
calling the exported `ensureKeyedLocalTables()` in a process where
`DYNAMO_DISABLE_TTL` is UNSET - which is exactly the condition `globalSetup`
runs under - left `hc-local-messages` with `TimeToLiveStatus: ENABLED`
(attribute `expires_at`); the same call from a clean slate with the flag set
left it DISABLED. The control (`hc-local-contacts`, whose spec carries no
`ttlAttribute`) read DISABLED in both arms, which is what makes the contrast
meaningful - only 4 of the 22 specs carry `ttlAttribute`
(`app/src/lib/tables.ts:231`, `:246`, `:615`, `:648`).

Mechanism: `app/test/globalSetup.ts:90-92` records that vitest `test.env`
reaches WORKERS only, and sets only the credentials - so the
`DYNAMO_DISABLE_TTL: '1'` in `app/vitest.config.ts:119` never applies in the
globalSetup process, and `createAllTables` -> `ensureTable` ->
`enableTtlIfNeeded` turns the reaper on for the four TTL-bearing shared
tables before any test runs, on every `npm test`.

Why it matters: the immunity the long comment at `app/vitest.config.ts:89-118`
describes does NOT hold for suites that use the shared `hc-local-` tables. A
future shared-table suite that pins a past clock and writes a TTL-bearing row
re-arms exactly the time bomb that made `groupCrossCheck` rot on a date
(rows born already expired, reaped mid-test, misread as load flakiness). The
two marked shared-table suites today (`devOutbox.integration`,
`recordingMessaging.integration`) do not pin past clocks, so nothing is
failing right now - this is a tracked trap, not a live red.

**Suggested fix.** Make `ensureKeyedLocalTables` accept an explicit
`disableTtl` option that `globalSetup` sets for the vitest entry point (or
have the vitest globalSetup set `process.env.DYNAMO_DISABLE_TTL = '1'`
before `createAllTables`, respect-if-set like the credentials). Out of the
npm-test-soundness mission's scope by its spec ("filed rather than fixed").
