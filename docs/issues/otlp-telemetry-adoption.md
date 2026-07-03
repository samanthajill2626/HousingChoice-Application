---
id: otlp-telemetry-adoption
title: Decide + build HOW we use OTLP telemetry (spec pass beyond the base wiring)
type: improvement
severity: low
status: open
area: app/observability
created: 2026-07-03
refs: docs/superpowers/specs/2026-07-02-otlp-exporter-wiring-design.md, app/src/lib/otel.ts
---

**Problem.** The OTLP wiring shipped ([[otlp-exporter-wiring]], merged
2026-07-02): app + worker export **traces → X-Ray** and **metrics → CloudWatch
(`CWAgent` namespace)** when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. But that wiring
auto-instruments **http + express ONLY**, and we have **not decided or designed
how we actually USE the resulting telemetry** to answer operational questions.
The design doc explicitly deferred this (its §4 "Out of scope": custom
spans/metrics beyond auto-instrumentation, sampling tuning, alarm wiring on the
new metrics, log-correlation work) — but a now-historical design doc's
out-of-scope list is not a tracked to-do. This issue makes that follow-on
explicit so it isn't lost.

Today's gap concretely: DynamoDB and SQS calls appear only as generic HTTPS
client spans (no table/queue/op attributes); there are no business-level spans;
no sampling policy; no dashboards or alarms on the new metrics; and no defined
notion of what "good" telemetry should let us answer.

**Suggested fix (a design/spec pass first, then incremental build).** Decide:

1. **What questions telemetry must answer** — the flows that matter (dashboard
   API latency; the async delivery path = jobs → relay fan-out / broadcasts;
   Twilio/Google outbound health), and any latency budgets / SLOs.
2. **Instrumentation depth** — add `@opentelemetry/instrumentation-aws-sdk` so
   DynamoDB/SQS become first-class spans; consider manual spans around key
   business ops (job dispatch, relay fan-out, placement/tour transitions). Keep
   version-matched to the installed `@opentelemetry/*` 0.219 line.
3. **Cross-process trace continuity** — the jobs envelope already carries
   `traceparent`; ensure the worker **continues** the originating trace rather
   than starting a fresh one, so app→worker shows as one trace.
4. **Sampling** — pick a policy before prod volume (the `OTEL_TRACES_SAMPLER`
   env seam exists; default samples everything).
5. **Metrics + alarms** — which RED metrics (rate/errors/duration) matter;
   dashboards; and alarm wiring on the new `CWAgent`-namespace metrics (the
   design doc deferred this).
6. **Log ↔ trace correlation** — pino logs carry `correlationId`; decide whether
   to also stamp `trace_id`/`span_id` so you can pivot between X-Ray and
   CloudWatch Logs.
7. **Cost / retention** — X-Ray trace + metric volume cost and retention windows.

**Dependency / gate.** [[telemetry-phone-in-url-pii]] (open) is a hard **prod
gate**: phone-bearing URL paths reach span attributes unredacted, so telemetry
must NOT be enabled in prod until that redaction lands. Any adoption work that
turns telemetry on in prod is blocked on it.
