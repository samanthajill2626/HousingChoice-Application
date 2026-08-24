---
id: outbound-mms-full-suite-reseed-timeout
title: Outbound MMS full-profile reseed can exhaust the full-suite test timeout
type: bug
severity: med
status: resolved
area: e2e/harness
created: 2026-08-21
resolved: 2026-08-24
refs: e2e/tests/dashboard-next/outbound-mms.spec.ts:163, e2e/playwright.config.ts:107
---

**Resolution (2026-08-24): instrumented, measured, and the sighting's era
explained.** The one occurrence came from the same sick 2026-08-21 gate run as
two since-resolved machine-exhaustion issues. The instrumentation this issue
asked for landed (clearMs/seedMs on every reseed log line), and its first
full-suite baseline showed the WORST reseed at ~3.6s against the 30s budget -
an 8x margin under normal load. No budget was changed, honoring this issue's
own warning. Zero recurrences since, including two heavily contended runs.
REOPEN IF a reseed timeout recurs - it will now arrive carrying its own phase
breakdown, which is precisely what this issue existed to demand.


**First healthy-machine measurement (2026-08-23, `fix/test-suite-wave3` gate
run, 253/253 green, 17.3m).** The instrumentation's first full-suite numbers:
across every reseed in the run, the WORST case was clearMs=870 + seedMs=2728,
i.e. ~3.6s total against the 30s budget - an 8x margin under normal full-suite
load. This strongly supports the environmental reading: the 2026-08-21 sighting
came from the same degraded gate run that produced two since-resolved
machine-exhaustion issues (`otel-child-boot-stdout-missing`,
`performance-config-npm-cmd-enomem`). Stays open until a loaded recurrence
either does not happen for a while or arrives carrying its phase breakdown.


**Instrumented (2026-08-23, `fix/test-suite-wave3`) - still open, awaiting a
loaded-suite measurement.** The suggested first step is done: `resetLocalData`
now logs `clearMs` and `seedMs` alongside its existing summary line, so the
next reseed that runs long under full-suite load names its own bottleneck
(table clearing vs seeding vs a competing job holding the request) instead of
dying as a bare 30s timeout. No budget was changed - per this issue's own
warning, a justified budget comes AFTER the phases are measured, and masking a
stuck reseed with a bigger timeout would be worse than the flake.


**Problem.** In a bare `npm run e2e` on feature head `709a5263`, the team group MMS
media case exhausted the 30-second test timeout inside `beforeEach` while awaiting
`POST /__dev/reseed?profile=full`. Playwright then disposed the request context. The
test never reached the MMS send or media assertions. The complete run finished with
250 passing and three failing tests in 27.1 minutes and showed unusually slow work
elsewhere in the hermetic stack.

The outbound-MMS spec, full reseed helper, media path, relay fan-out, fake-provider
path, and dashboard send path are byte-identical between base `165a267b` and feature
head `709a5263`. The exact failed case passed alone in 19.7 seconds (6.6 seconds in
the test body), so the evidence points to full-suite load or lane state rather than
an environment-identity regression.

**Suggested fix.** Capture phase timings for full-profile reseed during a loaded
suite and identify whether table clearing, seeding, or a competing job holds the
request. Give the setup its own justified budget only after ruling out a stuck
reseed; do not mask a product-path timeout by broadly increasing every test timeout.
