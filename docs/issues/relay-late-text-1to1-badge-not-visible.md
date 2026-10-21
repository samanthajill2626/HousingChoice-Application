---
id: relay-late-text-1to1-badge-not-visible
title: relay-number-lifecycle "late text" - the closed member's message never appears in their 1:1 timeline within 15s, twice under only moderate load
type: bug
severity: med
status: open
area: e2e
created: 2026-08-26
refs: e2e/tests/dashboard-next/relay-number-lifecycle.spec.ts:307
---

**Problem.** `relay-number-lifecycle.spec.ts:307` ("late text: a closed member
texting the kept number lands in their 1:1 with the provenance badge (group +
disjoint open group untouched)") fails waiting for the inbound body to render in
the contact's Communications pane:

```
Error: expect(locator).toBeVisible() failed
Locator: getByRole('region', { name: 'Communications and activity' })
           .getByText('late-1787711634917')
Expected: visible
Timeout: 15000ms
Error: element(s) not found
```

**Two sightings, both at MODERATE load** - which is why this is filed as a
defect rather than folded into the budget work:

| date | run | test duration | machine load |
|---|---|---|---|
| 2026-08-25 | budget verify, run 2 | 19.4s | ~1.1x baseline |
| 2026-08-26 | pressure round 4, suite B | 20.2s | **1.34x** baseline |

The concurrent budget campaign raised the scenario per-test caps and the suite
expect default precisely because several failures were tests running out of
clock. **This one is not that shape.** It fires its own 15s wait to completion
while the enclosing test has used only ~20s of a 60s cap, and it does so at
1.3x load, well below the ~1.95x that produced the clock-overrun failures. A
budget that expires with the test nowhere near its own ceiling is reporting a
missing event, not a slow one.

**Do NOT fix this by raising the timeout.** That is the exact move that would
mask it: the assertion is waiting on an inbound message arriving through the
relay path and rendering in the 1:1 timeline, which is a delivery + SSE
question. If the message never arrives, a larger budget only makes the failure
slower and rarer.

**Suggested investigation.**

- Establish whether the inbound was PERSISTED but not rendered (an SSE/refetch
  gap in the Communications pane) or never persisted at all (a relay routing
  gap on the kept number after the member is closed). The dev outbox / thread
  store gives the first half; the contact timeline API gives the second.
- The test's own framing matters: the message comes from a CLOSED member on a
  KEPT number, which is the branch where routing has the most conditions on it.
  See [`relay-number-lifecycle`](./relay-number-lifecycle.md) if that path has
  known edges.
- Capture a trace. `E2E_TRACE=1` is not on this branch, but `retries: 0` with
  `trace: 'on-first-retry'` means a gate failure carries NO network data, so
  the "persisted or not" question cannot be answered from a normal run's
  artifacts. See
  [`placement-detail-bundle-fetch-stall`](./placement-detail-bundle-fetch-stall.md)
  for how much that gap cost last time.

**Not yet known:** whether this reproduces solo. Both sightings were in full
suites; nobody has run it in isolation.

**Sighting 3 (2026-10-20, full gate run on `fix/contact-file-double-fetch`,
a dashboard-only branch; 364/365).** Same signature, same assertion. This
run's app log answers the first question above: the inbound WAS persisted -
into the CLOSED group, not into the sender's 1:1. App log timestamps (ms):

| t | line |
|---|---|
| 715547 | `PATCH /api/conversations/<group1>/close` received |
| 715552 | `relay status set` conv=group1 |
| 715558 | `relay group close/reopen via api` (the PATCH answered) |
| 715564 | `POST /webhooks/twilio/sms` received (the late text) |
| 715570 | `message appended` conv=group1 |
| 715574 | `twilio relay inbound message processed` conv=group1 |

No closed-intercept line was logged: the text took the ordinary group path
12 ms after the close committed, so the 1:1 timeline honestly showed
"No messages yet." and the dashboard was not at fault. `resolveRelayInbound`
classifies the sender from `getAllByPoolNumber`, a Query on the
`byPoolNumber` GSI (`app/src/repos/conversationsRepo.ts:2055`); a GSI read
that still returned group1 as `open` would classify the sender
`open_member` and produce exactly this filing. Whether DynamoDB Local's GSI
can lag a base-table write by that much is unverified - a leading
hypothesis, not a finding. The spec passed on its own straight afterwards
(`npm run e2e -w @housingchoice/e2e -- --grep "late text"`, 3.1 s), so
"reproduces solo" is now answered: not in one try; it needs the suite's
timing, as the two earlier sightings did.
