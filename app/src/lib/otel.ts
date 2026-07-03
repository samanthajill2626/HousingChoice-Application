// OpenTelemetry NodeSDK wiring (binding guideline 5: OTel, NOT the EOL X-Ray
// SDK). This module is loaded FIRST by both entrypoints, before express/http
// are imported, so instrumentation can patch them.
//
// Locally OTEL_SDK_DISABLED=true makes this a true no-op: the SDK packages
// are dynamically imported only when enabled, so the dev loop pays zero cost.
//
// Export target is OTLP over HTTP, gated on OTEL_EXPORTER_OTLP_ENDPOINT (the
// standard env seam; the CloudWatch agent's OTLP receiver on the deploy host
// is the collector). When the endpoint is SET we add an OTLP/HTTP trace
// exporter and a periodic OTLP/HTTP metric reader; when UNSET (or empty /
// whitespace) we behave exactly as before — the SDK starts with no exporters
// (no-op export), so a deploy without the env stays harmless. The exporters
// are constructed with NO explicit url so they honor OTEL_EXPORTER_OTLP_ENDPOINT
// themselves (appending /v1/traces and /v1/metrics) — and ALSO honor the standard
// per-signal OTEL_EXPORTER_OTLP_{TRACES,METRICS}_ENDPOINT overrides. The deploy
// uses OTEL_EXPORTER_OTLP_METRICS_ENDPOINT to point metrics at the CloudWatch
// agent's SECOND OTLP port (the agent requires one port per otlp receiver
// section, so traces and metrics can't share the base :4318). The exporter
// packages are dynamically imported ONLY when the endpoint is set, preserving
// the zero-cost disabled path.
//
// Instrumentation is deliberately lean: http + express only.
//
// Sampling: the SDK's default sampler is kept; OTEL_TRACES_SAMPLER is the
// standard env seam to tune it (no sampling code here).

import type { NodeSDKConfiguration } from '@opentelemetry/sdk-node';

let started = false;

function endpointOf(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return raw ? raw : undefined;
}

/**
 * Build the NodeSDK options from `env`, WITHOUT starting the SDK or touching
 * the network. `startOtel()` consumes this; tests inspect it directly.
 *
 * Endpoint SET (non-empty) → adds an OTLP/HTTP `traceExporter` and a periodic
 * OTLP/HTTP `metricReader`. Endpoint UNSET / empty / whitespace → neither key
 * is present (today's no-op export). A MALFORMED endpoint value is caught here:
 * we log (console.error — this module runs pre-logger) and fall back to the
 * no-exporter config rather than throwing out of the boot path. A merely
 * wrong/unreachable endpoint is NOT malformed — it constructs fine and fails
 * async inside the exporter (logged there), never at boot.
 */
export async function buildOtelSdkConfig(
  env: NodeJS.ProcessEnv,
): Promise<Partial<NodeSDKConfiguration>> {
  const serviceName = env.HC_PROCESS === 'worker' ? 'housingchoice-worker' : 'housingchoice-app';

  const [{ HttpInstrumentation }, { ExpressInstrumentation }] = await Promise.all([
    import('@opentelemetry/instrumentation-http'),
    import('@opentelemetry/instrumentation-express'),
  ]);

  const config: Partial<NodeSDKConfiguration> = {
    serviceName,
    instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
  };

  const endpoint = endpointOf(env);
  if (!endpoint) return config;

  try {
    // Fail fast on a malformed value: a wrong-but-unreachable endpoint fails
    // async inside the exporter, but a value that is not even a URL would only
    // surface later as confusing export errors. Reject it here and fall back.
    new URL(endpoint);

    // Lazy: only load the exporter packages when we actually export. The
    // exporters read OTEL_EXPORTER_OTLP_ENDPOINT and append /v1/traces and
    // /v1/metrics themselves — no explicit url.
    const [{ OTLPTraceExporter }, { OTLPMetricExporter }, { metrics }] = await Promise.all([
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/exporter-metrics-otlp-http'),
      import('@opentelemetry/sdk-node'),
    ]);

    config.traceExporter = new OTLPTraceExporter();
    config.metricReader = new metrics.PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
    });
  } catch (err) {
    // Never crash boot on a bad endpoint: log and keep the no-exporter config.
    // console.error, not the logger — this module runs before the logger.
    console.error('[otel] invalid OTEL_EXPORTER_OTLP_ENDPOINT; exporting disabled:', err);
    delete config.traceExporter;
    delete config.metricReader;
  }

  return config;
}

export async function startOtel(): Promise<void> {
  if (started) return;
  started = true;

  if ((process.env.OTEL_SDK_DISABLED ?? '').toLowerCase() === 'true') {
    // Local dev / tests: no-op. Do not load any OTel packages.
    return;
  }

  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const config = await buildOtelSdkConfig(process.env);
  const sdk = new NodeSDK(config);
  sdk.start();
}
