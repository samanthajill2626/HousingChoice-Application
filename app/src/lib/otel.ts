// OpenTelemetry NodeSDK wiring (binding guideline 5: OTel, NOT the EOL X-Ray
// SDK). This module is loaded FIRST by both entrypoints, before express/http
// are imported, so instrumentation can patch them.
//
// Locally OTEL_SDK_DISABLED=true makes this a true no-op: the SDK packages
// are dynamically imported only when enabled, so the dev loop pays zero cost.
//
// Instrumentation is deliberately lean: http + express only.
//
// TODO(otlp-exporter-wiring): wire the OTLP exporter to CloudWatch Application Signals.
// Env seam already in place: OTEL_EXPORTER_OTLP_ENDPOINT (see .env.example).
// Until then the SDK starts with default (no-op) export config in AWS.

let started = false;

export async function startOtel(): Promise<void> {
  if (started) return;
  started = true;

  if ((process.env.OTEL_SDK_DISABLED ?? '').toLowerCase() === 'true') {
    // Local dev / tests: no-op. Do not load any OTel packages.
    return;
  }

  const [{ NodeSDK }, { HttpInstrumentation }, { ExpressInstrumentation }] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/instrumentation-http'),
    import('@opentelemetry/instrumentation-express'),
  ]);

  const sdk = new NodeSDK({
    serviceName: process.env.HC_PROCESS === 'worker' ? 'housingchoice-worker' : 'housingchoice-app',
    instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
    // TODO(otlp-exporter-wiring): traceExporter/metricReader → OTLP at
    // process.env.OTEL_EXPORTER_OTLP_ENDPOINT (CloudWatch Application Signals).
  });
  sdk.start();
}
