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
import type { Attributes } from '@opentelemetry/api';
// phone.ts is a zero-import, side-effect-free leaf, so importing it here does
// not violate this module's load-first contract above (nothing it pulls in can
// touch express/http before instrumentation patches them).
import { maskPhonesInText } from './phone.js';

let started = false;

// SPAN URL MASKING (log-hygiene spec section 4). Hook attributes are
// Object.assign'd LAST by the instrumentation, so a masked value OVERWRITES
// the raw one. SEMCONV: the instrumentation emits the OLD family
// (http.url/http.target) by default and the stable url.* family only under
// OTEL_SEMCONV_STABILITY_OPT_IN - emitting a key the active mode never sets
// would FABRICATE it, so the stable keys are gated on that env. No-op-safe:
// any failure returns {} and the span exports with raw attributes rather
// than not at all (the log sinks are masked independently).

/**
 * Which semconv attribute families the instrumentation emits, from
 * OTEL_SEMCONV_STABILITY_OPT_IN parsed as COMMA-SEPARATED WHOLE TOKENS
 * (matching the instrumentation's own parser - a token merely containing
 * 'http' activates nothing): 'http/dup' -> both; 'http' -> stable only;
 * default -> old only. Emitting a key the active mode never sets would
 * FABRICATE it onto the span.
 */
function activeFamilies(): { old: boolean; stable: boolean } {
  // Lowercased to match the instrumentation's own parser, which lowercases
  // every entry - OTEL_SEMCONV_STABILITY_OPT_IN=HTTP puts IT in stable
  // mode, so a case-sensitive match here would ship raw phones in url.*.
  const tokens = (process.env['OTEL_SEMCONV_STABILITY_OPT_IN'] ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase());
  if (tokens.includes('http/dup')) return { old: true, stable: true };
  if (tokens.includes('http')) return { old: false, stable: true };
  return { old: true, stable: false };
}

/** startIncomingSpanHook: masked overrides for the SERVER span's URL attributes. */
export function maskIncomingSpanAttributes(request: unknown): Attributes {
  try {
    const req = request as {
      url?: unknown;
      headers?: { host?: unknown };
      socket?: { encrypted?: unknown };
    };
    if (typeof req?.url !== 'string' || req.url.length === 0) return {};
    const families = activeFamilies();
    const masked = maskPhonesInText(req.url);
    const host = typeof req.headers?.host === 'string' ? req.headers.host : 'localhost';
    const scheme = req.socket?.encrypted === true ? 'https' : 'http';
    const out: Record<string, string> = {};
    if (families.old) {
      out['http.url'] = `${scheme}://${host}${masked}`;
      out['http.target'] = masked;
    }
    if (families.stable) {
      const q = masked.indexOf('?');
      out['url.path'] = q === -1 ? masked : masked.slice(0, q);
      // A URL ending in a BARE '?' has an empty query, and the instrumentation
      // gates url.query on a truthy `parsedUrl.search` - it emits the key not
      // at all. Emitting '' would FABRICATE an attribute onto the span, which
      // is the one thing these hooks exist to avoid.
      const query = q === -1 ? '' : masked.slice(q + 1);
      if (query.length > 0) out['url.query'] = query;
    }
    return out;
  } catch {
    return {};
  }
}

/** startOutgoingSpanHook: masked overrides for the CLIENT span's URL attributes. */
export function maskOutgoingSpanAttributes(request: unknown): Attributes {
  try {
    const req = request as { host?: unknown; hostname?: unknown; path?: unknown; protocol?: unknown };
    if (typeof req?.path !== 'string' || req.path.length === 0) return {};
    const families = activeFamilies();
    const path = maskPhonesInText(req.path);
    const host =
      typeof req.hostname === 'string' && req.hostname.length > 0
        ? req.hostname
        : typeof req.host === 'string' && req.host.length > 0
          ? req.host
          : 'unknown';
    const protocol = typeof req.protocol === 'string' ? req.protocol : 'https:';
    const full = `${protocol}//${host}${path}`;
    const out: Record<string, string> = {};
    if (families.old) {
      out['http.url'] = full;
      out['http.target'] = path;
    }
    if (families.stable) out['url.full'] = full;
    return out;
  } catch {
    return {};
  }
}

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
    instrumentations: [
      new HttpInstrumentation({
        startIncomingSpanHook: maskIncomingSpanAttributes,
        startOutgoingSpanHook: maskOutgoingSpanAttributes,
      }),
      new ExpressInstrumentation(),
    ],
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
