---
id: fake-twilio-messaging-attach-404
title: fake-twilio has no Messaging Service attach route - every hermetic warm buy logs a swallowed post-buy job failure
type: debt
severity: low
status: resolved
area: fake-twilio
created: 2026-08-03
resolved: 2026-08-23
refs: app/src/adapters/messaging.ts:768, app/src/services/poolNumbers.ts:813, fake-twilio/src/routes/voiceRest.ts
---

**Resolution (2026-08-23, `fix/test-suite-wave3`).** Took the first option: the
fake now serves the Messaging Service sender-pool surface the adapter actually
calls - `POST/GET /v1/Services/:sid/PhoneNumbers` and `DELETE .../:pn` - with
attachment state on the NumberRegistry, so the warm job completes and its
success log (`relay_number_warming` + hintTier) fires on the hermetic stack.

Contract details that matter, both pinned in fake-twilio/test/voiceRest.test.ts
(15/15):

- Re-attach answers 400 code 21710, because `attachToMessagingService` BRANCHES
  on that code (idempotent no-op for a redelivered warm job). A fake that
  answered 201 twice would leave that branch dead locally.
- The GET list carries the twilio page shape (`phone_numbers` + `meta.key`,
  `next_page_url: null`) because the DETACH path resolves an E.164 to its PN
  sid through the SDK's `.list()`.
- Unknown sid: 404/20404. One service per number; another service's list and
  DELETE cannot see or remove it.

Path-collision note for the one-origin fake: Conversations also lives under
`/v1/Services/:sid/...` but never uses a `/PhoneNumbers` leaf, so exact routes
cannot collide.

Verified at the gate level by the branch's full `npm run e2e`: the run's log
carries ZERO `attachToMessagingService` RestException lines (wave2's baseline
run had them on every warm buy).


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
