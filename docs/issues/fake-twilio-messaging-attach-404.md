---
id: fake-twilio-messaging-attach-404
title: fake-twilio has no Messaging Service attach route - every hermetic warm buy logs a swallowed post-buy job failure
type: debt
severity: low
status: open
area: fake-twilio
created: 2026-08-03
refs: app/src/adapters/messaging.ts:768, app/src/services/poolNumbers.ts:813, fake-twilio/src/routes/voiceRest.ts
---

**Problem.** `warmOneNumber` finishes a buy with
`adapter.attachToMessagingService(sid)` (start A2P registration). The fake
implements the number search + purchase + `/control/register-number` seams but
NOT the Messaging Service PhoneNumbers attach endpoint, so on the hermetic
stack every warm buy dies AFTER purchase + `createWarming` with
`RestException [HTTP 404] Failed to execute request` - `"msg":"job failed"`
then swallowed by the in-process dispatcher ("SQS producer cannot observe
consumer failure"). Observed 22 times inside a fully GREEN e2e run
(2026-08-03, area-code-preference gates) and again during live self-QA on a
session lane. Nothing user-visible breaks locally - the record is already
`warming`, promotion rides the `/control/register-number` -> Event Streams
seam, and the group opens fine - but (a) the warm job's success log
(`relay_number_warming` + `hintTier`) never fires on the hermetic stack, so
local log-based QA of the buy path silently loses its tail, and (b) 22
level-50 error lines per suite are noise that trains people to ignore red
logs. Prod/dev with real Twilio are unaffected.

**Suggested fix.** Teach the fake the attach route (accept
`POST /v1/Services/:serviceSid/PhoneNumbers` shape the twilio SDK emits
against the messaging API base, 201 + echo) so the warm job completes and the
success log fires locally; alternatively have the harness assert on and
whitelist this one known 404. First option is small and makes the fake's
provisioning lifecycle honest end-to-end.
