# Plan review r1 - relay inbound caller identity

## 1. [HIGH] The prescribed lookup-failure log can disclose the external caller number

### What is wrong

Task 2 tells the builder to catch the new `contacts.findByPhone` failure and log
the caught value as `{ err, callSid: CallSid }`. That does not meet the approved
rule that the external phone never reaches logs. `err` is not a safe operational
summary: an error message can include the exact lookup input. The plan also says
the test should establish that no phone reaches the error log, but it never
requires a rejecting error whose message includes the caller number, nor an
assertion over the harness log capture. A literal implementation can therefore
pass every listed test while leaking a number on the only new failure path.

### Evidence

- Plan Task 2 requires `log.warn({ err, callSid: CallSid }, ...)` at
  `docs/superpowers/plans/2026-08-28-relay-inbound-caller-identity.md:321-326`.
- The same plan requires the failure case to have no phone in the error log but
  gives no adversarial error payload or log-capture assertion at
  `docs/superpowers/plans/2026-08-28-relay-inbound-caller-identity.md:265-267`.
- The approved spec explicitly makes phone logging a non-goal at
  `docs/superpowers/specs/2026-08-28-relay-inbound-caller-identity-design.md:545-547`.
- The live error serializer emits `err.message` verbatim:
  `app/src/lib/logSerializers.ts:33-58`; the logger binds that serializer to the
  `err` key at `app/src/lib/logger.ts:181-192`. Thus
  `new Error('lookup +16175550198 failed')` reaches the log line.
- The existing webhook harness already has an injectable captured pino
  destination at `app/test/helpers/twilioWebhookHarness.ts:3957-3979`, so this
  can be proved rather than assumed.

### What it implies

The plan needs a phone-free error summary (or no caught error object) and a route
test that makes `findByPhone` reject with an error containing the test E.164,
then asserts the captured serialized log contains no raw or formatted phone.
Without that, the new best-effort path violates the spec's PII boundary whenever
its dependency reports the attempted key in its message.

## 2. [MEDIUM] The real append contract never proves the required reason-only anonymous row

### What is wrong

The approved contract permits a non-member refusal with only
`relay_refusal_reason` when caller ID cannot be normalized. The plan's real
repository test only exercises a valid row that includes phone and contact ID;
its only no-phone invalid case deliberately also includes a contact ID. Its
anonymous-caller assertion runs through the in-memory webhook harness, which
Task 1 expressly says does not own the runtime rejection contract. Therefore an
implementation that accidentally requires a phone in the real append validator
will pass all listed repository and route tests while production drops anonymous
refusal rows through the existing append-error boundary.

### Evidence

- The spec requires that a non-normalizable caller store the reason but neither
  phone nor contact ID at
  `docs/superpowers/specs/2026-08-28-relay-inbound-caller-identity-design.md:447-449`
  and describes caller-ID-unavailable presentation at
  `docs/superpowers/specs/2026-08-28-relay-inbound-caller-identity-design.md:432-433`.
- Plan Task 1's sole positive repository input contains both phone and contact
  ID at `docs/superpowers/plans/2026-08-28-relay-inbound-caller-identity.md:123-139`.
  The listed no-phone invalid vector still has a contact ID at
  `docs/superpowers/plans/2026-08-28-relay-inbound-caller-identity.md:151-160`.
- The anonymous test is only a webhook/harness case at
  `docs/superpowers/plans/2026-08-28-relay-inbound-caller-identity.md:258-267`.
  The plan expressly limits the fake to persistence mapping and assigns the
  rejection contract to the real repository at
  `docs/superpowers/plans/2026-08-28-relay-inbound-caller-identity.md:223-226`.
- The live fake `messagesRepo.append` currently pushes its item without calling
  any shared validation at `app/test/helpers/twilioWebhookHarness.ts:1054-1062`.
- The live voice handler's refusal append is inside an error boundary
  (`app/src/routes/webhooks/voice.ts:904-975`), so a validator rejecting this
  shape would leave the TwiML successful but persist no call row.

### What it implies

Task 1 needs a positive real-repository `reason: 'non_member'`-only append case
that asserts the transaction contains the reason and neither external phone nor
contact ID. That is the only test that proves the production validator accepts
the anonymous-caller state specified for the feature.

## Attacked without finding

The plan names the existing message endpoint and existing app test seams; both
exist (`app/src/routes/api.ts:2112-2132`, `app/test/repos.test.ts:77-180`, and
`app/test/conversationHubApi.test.ts:255`). It also correctly uses the supported
exact phone contact endpoint (`app/src/routes/contacts.ts:943-958`) and the E2E
workspace invocation (`package.json:40`, `e2e/package.json:6`). I found no
separate plan/spec conflict in those areas.
