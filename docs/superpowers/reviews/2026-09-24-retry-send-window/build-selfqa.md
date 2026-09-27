# Retry send window build - live self-QA (build orchestrator)

Branch `feat/retry-send-window` @ `168585b2` (the commit every final gate ran
on). Driven 2026-09-26 by the build orchestrator on a fresh hermetic lane:
`npm run e2e:session` in `W:\tmp\retry-send-window`, lane 6 (app :9601,
dashboard :9611, fake-twilio :9621, public base :9631), lean seed, dev-login as
the seeded VA. Never the human's :5174 / :8080. Never Dario Reyes
(`contact-tenant-0002`, `+15550100004`).

Tooling: the project Playwright MCP could not start (its `chrome-for-testing`
binary is not installed on this machine; installing it is a download, so it was
not done); the Claude Playwright plugin MCP drove the lane instead. Every
measurement below is page text and accessible names read in the browser, API
rows read through the same session, the app's own log lines, and the fake's
control API - no screenshots (the delivery ticker re-renders under them). A
page-side sampler (250 ms, then 200 ms) recorded each CHANGE of a bubble's text,
its Retry buttons and its rollup image's accessible name with wall-clock time,
so a flip time does not depend on the polling cadence. The page was never
reloaded in any scenario: every state arrived over SSE or the ticker.

## S1 - one-to-one 30003: the promise arrives with the failure, Retry is hidden and refused, the retry replaces the bubble - PASS

Tasha Nguyen (`contact-tenant-0001`, `conv-0001`), a composer send (a person's
send), her handset armed `fail` / `undelivered` / `30003` once.

| t after send | observed |
| --- | --- |
| 0.8 s | bubble: "Undelivered - Phone unreachable - will retry (error 30003)"; the plain "Phone unreachable (error 30003)" was never sampled first (50 ms cadence) |
| 0.8 s | the promised bubble holds 0 "Retry sending this message" buttons |
| 0.8 s | stored original: `undelivered`, `30003`, `provider_ts` 18:07:29.000Z, `retry_due_at` 18:07:40.203Z (11.2 s later: the 10 s lane backoff over a second-truncated send time), `automated: false` |
| 0.8 s | API responses carry a `Date` header and no `Cache-Control` (the server-clock source, D8) |
| 0.8 s | `POST .../messages/<sid>/retry` -> `409 {"error":"retry_pending"}` |
| 12.2 s | one bubble for the body, "Delivered", 0 Retry buttons |
| 12.2 s | stored rows for the body: 2. The retry: `retry_of` = the original's `tsMsgId`, `retry_attempt` 1, `retry_window_start` = the original's `provider_ts`, `automated: false`, `delivered`, sent 18:07:40.000Z (not before its stamped run time) |

## S2 - a STOP during the backoff: the job refuses, and the promise outlives it until the ticker expires it - PASS (behaves as filed)

This is the path the build review filed as
`docs/issues/one-to-one-retry-promise-outlives-job-decline.md` (adversarial
F2, adjudication A2, re-review F1). No e2e spec exercises the ticker's EXPIRY of
a live promise; this is its live proof.

| wall clock (UTC) | observed |
| --- | --- |
| 18:08:34.545 | composer send to Tasha, armed 30003 |
| 18:08:35.213 | bubble: "Undelivered - Phone unreachable - will retry (error 30003)", 0 Retry buttons; `retry_due_at` 18:08:44.842Z |
| 18:08:35.244 | Tasha texts STOP (fake `send-as-party`); app log "contact flag set" `sms_opt_out`, audit `sms_opt_out_recorded` |
| 18:08:44.878 | the retry job runs (due 18:08:44.842) and refuses: WARN "retrySend: send refused - retry chain stopped", `refusal: contact_opted_out`. Nothing sent: the fake holds only the original (`undelivered` 30003) and the STOP |
| 18:10:44.842 | the promise expires on the server's terms (`retry_due_at` + `RETRY_PROMISE_GRACE_MS`) |
| 18:11:35.221 | the ticker re-renders the bubble: "Undelivered - Phone unreachable (error 30003)" with 1 Retry button - 50.4 s after expiry, inside the 60 s tick |

Measured: the screen kept promising a retry for 170 s after the job had given
up (bounded by the grace plus one tick, as the issue states). The expiry path
itself is correct: no reload, one flip, straight to the plain failure with
Retry.

## S3 - native group text: a 30003 leg reads the plain failure and never promises (D11) - PASS

The lean seed's native group text (`3cf913ac-62ad-5f5d-9aa4-40edc3ac8e55`,
Tasha + Marcus Bell `+15550100002`), after a reseed; Marcus's handset armed
30003; a team send.

- 1.8 s after the send the bubble read "delivered 0/2 - 1 failed - Phone
  unreachable (error 30003)"; the rollup's accessible name: "... Marcus Bell:
  Undelivered, Phone unreachable (error 30003), MMS." Sampled for 16 s: "will
  retry" never appeared; 0 Retry buttons; the stored row carries no
  `retry_due_at` (its only delivery keys are `delivery_recipients` and
  `delivery_status`).
- Observation, not a finding: Tasha's leg stayed "Sending..." because S2's STOP
  put her on the FAKE's suppression list, which a lane reseed does not reset;
  the fake then creates no leg and sends no receipt for her by design
  (`fake-twilio/src/engine/conversationsEngine.ts`, "SKIPPED, not failed").
  Untouched by this branch (`git diff main...HEAD -- fake-twilio` is empty).

## S4 - relay: a claim-time GATE decline shows "Not retried - group closed" at once (D3, Cameron's gate answer 2) - PASS

A fresh two-member relay group (contactless members `+15558713158` "QA Stalled
3158" and `+15558723158` "QA Normal 3158"), driven open on pool
`+14040190001`, intros settled on both. Member A's handset armed `stall` at
`sent`; a team send; the group CLOSED; then a signed `undelivered` / 30003
status callback for A's leg (`SM00000000000000000000000003e08764`) posted to the
lane app (HMAC-SHA1 as `e2e/fixtures/fakeTwilio.ts` signs it, the lane's
hermetic token).

| wall clock (UTC) | observed |
| --- | --- |
| 18:12:48.001 | rollup: "delivered 1 of 2. QA Stalled 3158: Sent, SMS ... QA Normal 3158: Delivered ..." |
| 18:13:00.751 | callback -> 200 |
| 18:13:00.801 | app WARN "twilio relay-recipient delivery failed (undelivered/failed)", `retryClaim: gate_refused`, `closeCode: retry_group_closed`, `retryAttempt: 1`, `errorCode: 30003`; no `relay.retryLeg` job enqueued |
| 18:13:01.215 | bubble: "delivered 1/2 - 1 failed - Not retried - group closed"; rollup: "... QA Stalled 3158: Undelivered, Not retried, group closed, SMS ..." - straight from "Sent", never "Retrying" (0.46 s after the callback) |

## Not driven live (proven below this layer on purpose, spec D13)

The one-to-one and relay WINDOW declines (they need an origin 15 minutes old),
the retry cap, the D3a preview refusals, the person's-send retry on a
manual-mode thread, the bounded A2P acquire - each pinned by the unit and
integration suites named in the handback.

## Lane hygiene

`npm run e2e:stop` EXIT=0: launcher 44680 and its children stopped, lane 6
tables (`hc-local-6-*`) dropped, the lease released; a port probe then found
9601, 9611, 9621 and 9631 all free. The browser console across the run showed
only the pre-login `401 /auth/me`, the deliberate S1 `409`, and SSE reconnect
attempts after the lane was stopped.
