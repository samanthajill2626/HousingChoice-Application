# OTLP exporter wiring — OTel traces/metrics actually export somewhere

**Date:** 2026-07-02 · **Status:** design (ready for implementation plan)
**Resolves:** `docs/issues/otlp-exporter-wiring.md` (med).

## 1. Why

In both deployed envs the OTel SDK starts and instruments http/express — and
exports **nowhere**: `app/src/lib/otel.ts` configures no `traceExporter` /
`metricReader` (the `TODO(M0.4/M0.6)` markers flag the exact seams). We pay the
instrumentation overhead and get zero observability from it. Locally
`OTEL_SDK_DISABLED=true` keeps it a true no-op (unchanged).

## 2. Design

**Wire the two TODO seams to OTLP, gated on the endpoint env:**

- When `OTEL_EXPORTER_OTLP_ENDPOINT` is SET: configure an OTLP **HTTP** trace
  exporter and an OTLP HTTP metric reader (periodic export) pointed at it.
  OTLP/HTTP (4318) over gRPC (4317) — fewer native deps, plays well with the
  CloudWatch agent's OTLP receiver.
- When UNSET: behave exactly as today (SDK may start, no exporters) — deploys
  without the env stay harmless; NO hard requirement introduced.
- New dependencies: `@opentelemetry/exporter-trace-otlp-http` (+ the metrics
  exporter package for the installed OTel SDK version — match the existing
  `@opentelemetry/*` versions in app/package.json to avoid version-skew
  runtime errors). **Dep change ⇒ note `npm install` needed after merge.**

**Receiving end:** the CloudWatch agent (already installed + running on the dev
host) receives OTLP when its config enables the OTLP receiver. Deliverables:
- The agent-config addition (wherever the repo manages it — check how the
  CloudWatch agent config landed in the cloudwatch-host-metrics work; extend
  that artifact) enabling the OTLP receiver on localhost:4318, forwarding to
  CloudWatch (Application Signals / X-Ray traces + EMF metrics per the agent's
  supported pipeline).
- If the agent config is operator-applied, write the exact steps into RUNBOOK
  (Claude owns RUNBOOK) — the OPERATOR applies infra/agent changes and deploys.

**Env, template-first:** add `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`
to `.env.dev.example` + `.env.prod.example` (commented or set — set, since dev's
agent is ready); `.env.example` (local) stays disabled via OTEL_SDK_DISABLED.
The operator merges into real `.env.dev`/`.env.prod` + `secrets:push` + deploy.

**Service identity:** set a stable OTel `service.name` (e.g. `hc-app` /
`hc-worker` — check what otel.ts already sets; keep or add) so traces are
findable in the console.

## 3. Testing / verification

- **Unit:** otel bootstrap with the endpoint set constructs exporters (mock /
  inspect config); unset → no exporters (today's behavior). No network in tests.
- **Hermetic:** e2e/dev keep `OTEL_SDK_DISABLED=true` — assert the suite still
  boots green (no accidental hard dependency on the endpoint).
- **Deployed (operator, documented in RUNBOOK):** after dev deploy — hit a few
  routes, then confirm traces/metrics appear in CloudWatch (X-Ray traces /
  Application Signals or the EMF namespace the agent pipeline emits to). Include
  the exact console path + a troubleshooting note (agent OTLP receiver running?
  endpoint env present in SSM?).

## 4. Out of scope

Custom spans/metrics beyond auto-instrumentation, sampling tuning (default
sampler fine for dev; leave a comment + env seam if trivial), alarm wiring on
the new metrics, log-correlation work.
