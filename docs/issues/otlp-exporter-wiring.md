---
id: otlp-exporter-wiring
title: OTel SDK runs with no exporter in both envs — wire OTLP → CloudWatch
type: debt
severity: med
status: resolved
resolved: 2026-07-02
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

**Resolution (2026-07-02, branch feat/otlp-exporter-wiring).** The full OTLP export pipeline is
now wired end-to-end:

- **App/worker** (`app/src/lib/otel.ts`): `OTLPTraceExporter` and `OTLPMetricExporter` are
  activated when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; unset ⇒ no exporters (harmless); local
  hermetic keeps `OTEL_SDK_DISABLED=true`.
- **CloudWatch agent** (`infra/modules/ec2/main.tf`): two OTLP receivers on distinct ports —
  traces `http 0.0.0.0:4318` → AWS X-Ray; metrics `http 0.0.0.0:4320` → CloudWatch metrics
  (`CWAgent` namespace). The `XRayTraces` IAM statement (mirroring `AWSXRayDaemonWriteAccess`)
  was added to the instance role; existing `PutMetricData` / `CWAgent` grant already covered
  metrics.
- **Compose** (`docker-compose.yml`): `extra_hosts: host.docker.internal:host-gateway` on app
  and worker so containers reach the host agent.
- **Env vars** (`.env.dev.example`, `.env.prod.example`): `OTEL_EXPORTER_OTLP_ENDPOINT` and
  `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` set and documented; must be pushed via `secrets:push`.

Operator apply steps (Terraform, agent config SSM update, env merge + deploy, console
verification, troubleshooting) live in RUNBOOK.md → [OTLP wiring — apply and
verify](../../RUNBOOK.md#otlp-wiring--apply-and-verify).
