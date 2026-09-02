# Live self-QA - relay 30003 chip, all three positions, real dashboard

Orchestrator-driven (never delegated), 2026-09-01, hermetic e2e:session lane 3
at app commit 08007e15 (`/__dev/ping` -> `{"dev":true,"lane":3,"appCommit":"08007e15"}`).
Playwright MCP over the bundled chromium; screenshots under the main checkout's
`.playwright-mcp/` (gitignored).

## What was driven

1. VA dev-login; created a fresh relay group (Alice SelfQA +15557300001,
   Bob SelfQA +15557300002) via POST /api/relay-groups -> CONNECTING.
2. Drove connect-when-ready for real: founder-admin session (separate cookie
   jar) polled /api/pool-numbers for the warming number EARMARKED to this
   conversation (+14040190001), fired the fake's /control/register-number,
   and the group opened on that number - the full multi-hop chain (register ->
   Event Streams webhook -> promote -> relay.numberReady -> assign+open).
3. Waited for the create-time intro fan-out to settle (both intros `delivered`
   in the fake's thread store) BEFORE arming - setDeliveryOutcome is one-shot
   keyed on destination, so arming earlier would have been consumed by the
   intro.
4. Armed `{ kind: 'fail', failState: 'undelivered', errorCode: '30003' }` for
   Alice; sent a team message through the REAL composer UI.

## What was measured (accessibility tree, not eyeball)

After the DLR landed ("1 failed" appeared without a reload - SSE path live):

- Rollup chip (position 1):
  `delivered 1/2 - 1 failed - Phone unreachable (error 30003)`
- Accessible name of the chip img (position 2, read from the a11y snapshot):
  `delivered 1 of 2, 1 failed, Phone unreachable (error 30003). Alice SelfQA:
  Undelivered, Phone unreachable (error 30003). Bob SelfQA: Delivered.`
- Per-recipient list (position 3): ABSENT before the bubble-body click
  (conditional reveal confirmed live); after the click,
  `list "Delivery by recipient"` renders Alice as
  `Undelivered - Phone unreachable (error 30003)` and Bob as `Delivered`.
- NEGATIVE: the string "will retry" appears NOWHERE in the bubble subtree -
  chip, accessible name, or row. The three positions agree (D21), the carrier
  code tail is intact (D22/5a), and the promise is gone (D19).

Screenshot: `.playwright-mcp/m5-selfqa-relay-30003-three-positions.png`
(main checkout, gitignored).

## Server-side check (the layer behind the render)

`/__dev/logtail?level=40` for the session held five lines:

- 2 boot-config warns (hermetic defaults - scheduler ARNs unset, in-process
  jobs). Expected.
- 1 level-50 `relay_connecting_stuck` for conversation `f65fe0e6-...` - a
  SEEDED lean-world connecting group whose warm number never registers in a
  session lane. Pre-existing seed behavior, not this branch's conversation
  and not this branch's code.
- 1 `relay_register_service_mismatch` warn from the fake register step.
  Pre-existing.
- OUR leg: `event: delivery_failed, errorCode: 30003, relay: true` at WARN -
  confirming live the fact filed as `relay-30003-classified-transient-retrying`:
  the log taxonomy still classifies a relay 30003 as transient-retrying (WARN,
  alarm-exempt) while the chip now truthfully promises nothing. Filed, fenced
  file, not fixed here.

## Not live-drivable, and why that is okay

The cap/enqueue-failure closes cannot be reached from the live lane (no dev
seam makes the queue fail, by design - spec Sec 7 e2e paragraph); they are
pinned at integration level with a RED-first proof (close C failed on the
untouched job in both suites). The rail ladder needs Twilio's async binding
timing, faked at the port seam in unit tests; the live lane's fake adapter
binds synchronously.

Verdict: PASS. Session stopped cleanly afterwards; lane ports verified free.
