---
id: telemetry-phone-in-url-pii
title: Phone-bearing URL paths reach telemetry unredacted (OTel spans → X-Ray; request logger)
type: security
severity: med
status: resolved
area: app/observability
created: 2026-07-02
deferred: 2026-08-15
resolved: 2026-08-25
refs: app/src/lib/otel.ts, app/src/middleware/requestLogger.ts:33, app/src/routes/contacts.ts:1348, app/src/routes/relayGroups.ts:250
---

**Problem.** Found by the OTLP-wiring adversarial review (2026-07-02). Some API
routes carry a raw E.164 phone in the URL path (`/api/contacts/:id/phones/:phone`,
`/api/relay-groups/:id/members/:phone`). Two telemetry sinks pick that path up
unredacted:
1. **OTel HTTP spans** (new with the OTLP wiring): `HttpInstrumentation` records
   the request target as span attributes; once `OTEL_EXPORTER_OTLP_ENDPOINT` is
   set, those spans — phone included — ship to X-Ray. No redaction hook is
   configured.
2. **The request logger** (PRE-EXISTING): `middleware/requestLogger.ts` logs
   `req.path`, so the same phone already lands in CloudWatch logs today. The
   span issue widens an existing posture, it did not create it.

Both conflict with the repo's PII rule (doc §9: IDs/counts/markers only — never
phones). Inert for spans while the endpoint is unset.

**Gate LIFTED - accepted 2026-08-15 (Cameron).** Phone numbers reaching spans and
logs is acceptable at this stage, and the telemetry is wanted in production. Prod
therefore ships `OTEL_EXPORTER_OTLP_ENDPOINT` /
`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` wired exactly like dev at the M1.11 go-live -
this issue no longer blocks that. The exposure itself is unchanged and the fix below
is still worth doing; it is now ordinary backlog rather than a release gate.

Prior wording, for the record: "fix (at least the span side) BEFORE setting
`OTEL_EXPORTER_OTLP_ENDPOINT` in **prod**."

**Suggested fix.** Two layers:
- **Redact at the telemetry edge:** an `applyCustomAttributesOnSpan` (or
  equivalent) hook on `HttpInstrumentation` that masks E.164 segments in
  url/target attributes, and the same masking for `req.path` in
  requestLogger.ts (e.g. `+1404…` → `+1…07` or a stable hash).
- **Structural (better, more work):** stop putting phones in URLs — the two
  routes could take the phone in the BODY (or address by an opaque id),
  eliminating the class. Consider during the next touch of those routes.

**Related sighting (2026-08-03, relay area-code preference).** The same class
shows up on the OUTBOUND side: on a transport failure the twilio SDK re-throws
the raw axios error, whose own-enumerable `config.params` / `request` carry the
full request URL and query params, and pino's default `err` serializer copies
them into CloudWatch (`createLogger`'s redact list covers headers only). That
branch **sanitized the one path it created** - the ZIP-bearing
`AvailablePhoneNumbers` search in the twilio driver's `provisionPhoneNumber`,
which now re-throws a plain Error carrying only the message plus a code/status
(no `cause`, no reference to the original). Still exposed and tracked here: the
**purchase / messages** paths of the same driver (they leak whatever their own
params hold), and the bare `HttpInstrumentation` in `app/src/lib/otel.ts`, which
records **outgoing** request targets on client spans with no
`ignoreOutgoingRequestHook` - so once the OTLP endpoint is set those spans carry
the same URLs. A generic `err` serializer that strips `config`/`request`/
`response` would cover the log side of the whole class in one place.

**Resolution (2026-08-25).** Both named sinks are masked on `feat/log-hygiene`,
and the structural half is re-filed rather than closed.

`maskPhonesInText(text)` in `app/src/lib/phone.ts` masks every E.164-shaped run
in a string - a `+` or its URL-encoded `%2B`/`%2b` followed by 8 to 15 digits -
down to first digit + `...` + last two, so `/api/contacts/c1/phones/+14045551234`
logs as `/api/contacts/c1/phones/+1...34`. The 8-digit floor keeps short
non-phone tokens like `+123` intact, and phone-free text is returned unchanged.
It is SERVER-ONLY by design: `phone.ts` declares byte-parity intent with the
dashboard mirror, and a header note states that the mirror deliberately does NOT
gain this helper, because it masks log sinks and span attributes that only the
server has.

Log sinks: all 14 logger-payload `path:` fields now pass through the helper -
`lib/errors.ts` x3 (the express error handler), `middleware/requestLogger.ts` x2
(the "request received" and "request completed" lines),
`middleware/twilioSignature.ts` x6, plus `middleware/rateLimit.ts`,
`middleware/csrfOrigin.ts` and `middleware/originSecret.ts`. Closing the issue on
fewer would have been a false close. After the edit the only surviving `req.path`
reads in `app/src` are the three FUNCTIONAL ones (route prefix matching in
`app.ts`, and the `/health` / `/__dev/` checks in `originSecret.ts`), none of
which reaches a logger.

Spans: `buildOtelSdkConfig`'s `HttpInstrumentation` gains
`startIncomingSpanHook: maskIncomingSpanAttributes` and
`startOutgoingSpanHook: maskOutgoingSpanAttributes` (`app/src/lib/otel.ts`), both
EXPORTED pure functions unit-tested directly and wrapped no-op-safe. Outgoing
client spans are MASKED rather than ignored, so the twilio-driver request targets
the last paragraph names keep their span and lose their digits - no
`ignoreOutgoingRequestHook` was added. The hooks are SEMCONV-AWARE, because
returning an attribute the active mode never sets would FABRICATE it:
`OTEL_SEMCONV_STABILITY_OPT_IN` is parsed as a comma-separated list of WHOLE
tokens (so `http-anything` activates nothing), `http/dup` emits both families,
`http` emits the stable family only (`url.path`/`url.query` incoming, `url.full`
outgoing), and the default emits the old family only (`http.url`,
`http.target`). Hook attributes are assigned last by the instrumentation, so
they overwrite; the server span NAME uses the express route template and carries
no phone.

The related-sighting paragraph's own suggestion - "a generic `err` serializer
that strips `config`/`request`/`response`" - shipped on this same branch as
`app/src/lib/logSerializers.ts`, so the twilio driver's purchase and messages
paths no longer leak their params through a raw axios error either. See
[twilio-sdk-error-logs-leak-credentials](./twilio-sdk-error-logs-leak-credentials.md).

RE-FILED, not fixed: the "Structural (better, more work)" half of the suggested
fix. Phones still travel in URL PATHS, and masking is a sink-side defense -
anything that reads a raw path before our sinks (the CDN/load-balancer access-log
layer, any middleware mounted upstream of the masking, a stack or exception
message quoting the URL, browser history) still sees the number. That remainder
is now [phone-in-url-paths-structural](./phone-in-url-paths-structural.md) (low),
with the corrected surface list: six route paths across seven handlers, not the
two this file names.
