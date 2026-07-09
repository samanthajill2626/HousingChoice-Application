---
id: relay-intro-dlr-unknown-sid-noise
title: Relay intro sends have no relaysid pointer, so their DLRs log unknown-SID ERRORs (alarm noise)
type: bug
severity: low
status: open
area: app
created: 2026-07-08
refs: app/src/jobs/relayFanOut.ts:504, app/src/routes/webhooks/twilio.ts:845
---

**Problem.** Relay-group INTRO sends go straight to the adapter with no delivery
bookkeeping. In `app/src/jobs/relayFanOut.ts` (~:504) the intro handler calls
`adapter.sendMessage({ to, from, body })` per member but, unlike the fan-out leg
(~:399-410), it does NOT persist a message, does NOT write a delivery_recipients
slot, and does NOT call `putRelaySidPointer`. So when Twilio posts status
callbacks (queued/sent/delivered/...) for those intro provider SIDs, POST
`/webhooks/twilio/status` (`app/src/routes/webhooks/twilio.ts`) finds nothing:
`getByProviderSid` misses, `getRelaySidPointer` misses (both on the first lookup
and after the retry), and every intro callback terminates in the level-50
"status callback for unknown provider SID after retry - delivery outcome dropped"
ERROR (~:845 region). That ERROR line feeds the `hc-<env>-error-logs` alarm, so
every relay intro (N members x several DLRs each) manufactures benign alarm
noise and buries genuine dropped-outcome ERRORs. Functionally harmless today
(intros carry no per-recipient delivery UI), but it is real alarm pollution.

**Suggested fix.** Options, roughly increasing in cost:
- Write a relaysid pointer for each intro leg that targets a no-op/tracked slot,
  so the DLR resolves and is recorded (or knowingly ignored) instead of ERRORing.
  Mirrors the fan-out leg's `putRelaySidPointer` + `markRecipient`.
- Give the intro its own tracked delivery slot on a persisted intro message so
  intro deliverability becomes observable (larger change; may be desirable for
  first-contact confidence).
- Cheapest: classify intro-origin SIDs (e.g. a pointer with an `intro: true` /
  no-op kind) and DOWNGRADE the terminal unknown-SID log from ERROR to INFO/WARN
  for those, keeping the alarm signal for genuinely-lost 1:1/fan-out outcomes.

Note the sibling race fix (fix/relay-dlr-pointer-retry) makes the /status retry
re-check the relaysid pointer for BOTH lookups; it does not create intro
pointers, so this noise is unaffected by that change.
