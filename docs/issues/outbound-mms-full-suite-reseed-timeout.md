---
id: outbound-mms-full-suite-reseed-timeout
title: Outbound MMS full-profile reseed can exhaust the full-suite test timeout
type: bug
severity: med
status: open
area: e2e/harness
created: 2026-08-21
refs: e2e/tests/dashboard-next/outbound-mms.spec.ts:163, e2e/playwright.config.ts:107
---

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
