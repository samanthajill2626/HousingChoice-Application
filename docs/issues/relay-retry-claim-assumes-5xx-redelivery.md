---
id: relay-retry-claim-assumes-5xx-redelivery
title: The relay 30003 retry claim answers 5xx on a fault and counts on Twilio redelivering the status callback, but Twilio's default retry policy never redelivers a 5xx
type: bug
severity: med
status: open
area: app/messaging-relay
created: 2026-09-26
refs: app/src/routes/webhooks/twilio.ts, app/src/lib/relayRetryClaim.ts, docs/issues/relay-retry-stranded-claim-window.md
---

**Problem.** When the relay 30003 retry claim throws - its consistent re-read of
the source row, the sender-roster read in `composeRelayLegCopy`, or the claim's
`append` - the webhook records `claim_failed`, answers 500, and its comments say
"Twilio still redelivers", so a redelivered callback re-runs the claim (the
claim's gate is the slot's POST-write state precisely so a redelivery can claim;
see the comments around `claimRelayRetry` and its call site in
`app/src/routes/webhooks/twilio.ts`). Twilio does not do that by default. Its
webhook connection overrides document a default retry policy of `ct` - retry
only on a TCP connect or TLS handshake failure - with a default retry count of
1 (https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides,
"Default: ct"). An HTTP 500 is never redelivered unless the status callback URL
carries `#rp=5xx` (or `rp=all`), and nothing in the repo sets one. So one
transient DynamoDB fault during a relay 30003 claim loses that member's retry
ladder for good: the leg stays a plain 30003 failure and no rung is ever
claimed.

Found by the plan-blind adversarial re-review of `feat/retry-send-window`
(2026-09-26). That branch removed the fault surface it had added - its new
claim-time gate preview now FAILS OPEN (the rung is claimed open; the retry job
re-runs every gate) - but the claim's other reads and its append predate it and
still rely on the redelivery.

**Suggested fix.** Either make the redelivery real - add a connection override
with `rp=5xx` to the status callback URLs the app builds (every status callback
is already idempotent on redelivery: the forward-only status writes and the
claim's SID-deduped append) and pin it with a test - or stop depending on it:
answer 200 after a claim fault and schedule a claim retry through the jobs
queue. Also correct the "Twilio still redelivers" comments, and re-check the
one-to-one status path's own 5xx paths against the same default.
