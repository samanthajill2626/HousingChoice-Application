---
id: otlp-exporter-wiring
title: OTel SDK runs with no exporter in both envs — wire OTLP → CloudWatch
type: debt
severity: med
status: open
area: app/observability
created: 2026-06-11
refs: app/src/lib/otel.ts:10, app/src/lib/otel.ts:34
---

**Problem.** Neither `/hc/dev/app` nor `/hc/prod/app` sets `OTEL_SDK_DISABLED`, so the OTel
SDK starts and instruments http/express in both deployed envs — but `app/src/lib/otel.ts`
configures no `traceExporter`/`metricReader`, so traces/metrics are exported **nowhere**.
(Locally `OTEL_SDK_DISABLED=true` makes it a true no-op.) Verified 2026-06-11.

**Suggested fix.** Wire OTLP → CloudWatch Application Signals via the existing
`OTEL_EXPORTER_OTLP_ENDPOINT` seam (the `TODO(M0.4/M0.6)` markers in `app/src/lib/otel.ts`
flag the exact spots: `traceExporter`/`metricReader` → OTLP).

Migrated from the RUNBOOK "Security / hardening backlog"; the inline `otel.ts` TODOs are the
Tier-1 markers for the same item.
