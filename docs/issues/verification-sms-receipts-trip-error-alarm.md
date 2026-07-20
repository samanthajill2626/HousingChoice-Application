---
id: verification-sms-receipts-trip-error-alarm
title: Cell-verification SMS delivery receipts trip the unknown-provider-SID ERROR backstop (3 false alarm-feeding errors per code sent)
type: bug
severity: med
status: open
area: app
created: 2026-07-20
refs: app/src/routes/voiceApi.ts:167, app/src/routes/webhooks/twilio.ts:1252, app/src/adapters/messaging.ts:19
---

**Problem.** `POST /api/users/me/cell/verify-start` sends the verification code
DIRECTLY via the messaging adapter (deliberate - internal staff verification,
not consumer A2P messaging), so no message row / `sid#` pointer is ever
persisted. But the send goes out through the Twilio Messaging Service, whose
SERVICE-LEVEL status callback fires delivery receipts (queued/sent/delivered)
for every message it carries. Each receipt hits `/webhooks/twilio` /status,
misses `getByProviderSid` (twice, with the 2.5s retry), and lands in the
"closing the loop" backstop: `status callback for unknown provider SID after
retry - delivery outcome dropped`, logged at ERROR - which feeds the
hc-<env>-error-logs alarm.

Net effect: every legitimate cell verification (a normal Settings > Team flow,
and literally a go-live checklist step) produces THREE false-positive error-log
entries. Verified live on dev 2026-07-20: SMb14ec335571c2f07315c12267481f58d
("Your HousingChoice verification code is ...") produced exactly the three
dashboard errors under investigation; the code itself delivered fine.

**Suggested fix.** Have verify-start register the provider SID at send time as
a lightweight known-system-send marker (same pointer-partition convention as
`sid#` / `job#`, e.g. `syssid#<providerSid>`), and have the /status handler
check it before the ERROR backstop: a receipt matching a system send logs at
INFO ("system send receipt - no message row by design") and acks 200. Keeps the
backstop's guarantee (a genuinely orphaned conversation send still ERRORs)
without alarm noise from by-design non-conversation sends. Any future direct-
adapter send paths should use the same marker.
