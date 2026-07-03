---
id: telemetry-phone-in-url-pii
title: Phone-bearing URL paths reach telemetry unredacted (OTel spans → X-Ray; request logger)
type: security
severity: med
status: open
area: app/observability
created: 2026-07-02
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

**Gate:** fix (at least the span side) BEFORE setting
`OTEL_EXPORTER_OTLP_ENDPOINT` in **prod**. Dev exposure is lower-stakes but the
same fix covers it.

**Suggested fix.** Two layers:
- **Redact at the telemetry edge:** an `applyCustomAttributesOnSpan` (or
  equivalent) hook on `HttpInstrumentation` that masks E.164 segments in
  url/target attributes, and the same masking for `req.path` in
  requestLogger.ts (e.g. `+1404…` → `+1…07` or a stable hash).
- **Structural (better, more work):** stop putting phones in URLs — the two
  routes could take the phone in the BODY (or address by an opaque id),
  eliminating the class. Consider during the next touch of those routes.
