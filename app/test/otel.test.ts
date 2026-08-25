// OTLP exporter wiring (app/src/lib/otel.ts). These tests exercise the
// config-building seam ONLY — they never call sdk.start(), because starting
// the NodeSDK would patch http/express for the rest of the vitest process.
// buildOtelSdkConfig(env) takes env as an explicit parameter so the suite's
// own process.env is never consulted (no reliance on OTEL_SDK_DISABLED here).
//
// No network: constructing the OTLP/HTTP exporters does not open a socket, and
// we never flush. The child-process smoke test at the bottom of this file
// proves the real module boots in both modes without patching this process.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { metrics } from '@opentelemetry/sdk-node';
import {
  buildOtelSdkConfig,
  maskIncomingSpanAttributes,
  maskOutgoingSpanAttributes,
  startOtel,
} from '../src/lib/otel.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('buildOtelSdkConfig: endpoint gating', () => {
  it('endpoint SET → wires an OTLP trace exporter and a periodic OTLP metric reader', async () => {
    const config = await buildOtelSdkConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    });

    expect(config.traceExporter).toBeInstanceOf(OTLPTraceExporter);
    expect(config.metricReader).toBeInstanceOf(metrics.PeriodicExportingMetricReader);
    // Shut the reader down so its periodic-export timer does not linger as an
    // open handle for the rest of the run (no network: nothing was exported).
    await config.metricReader?.shutdown();
  });

  it('endpoint UNSET → no traceExporter / metricReader keys (today’s no-op export)', async () => {
    const config = await buildOtelSdkConfig({});

    expect('traceExporter' in config).toBe(false);
    expect('metricReader' in config).toBe(false);
  });

  it('endpoint EMPTY → treated as unset', async () => {
    const config = await buildOtelSdkConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: '' });

    expect('traceExporter' in config).toBe(false);
    expect('metricReader' in config).toBe(false);
  });

  it('endpoint WHITESPACE → treated as unset', async () => {
    const config = await buildOtelSdkConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: '   ' });

    expect('traceExporter' in config).toBe(false);
    expect('metricReader' in config).toBe(false);
  });

  it('endpoint MALFORMED → does not throw; logs and falls back to no exporters', async () => {
    // A wrong-but-unreachable endpoint fails async inside the exporter, never
    // at construction. A malformed VALUE ("not a url") is caught by the config
    // guard, which logs (console.error — pre-logger) and falls back to the
    // no-exporter config. Spy on console.error to assert the log AND keep the
    // test output pristine.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const config = await buildOtelSdkConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'not a url' });

      expect('traceExporter' in config).toBe(false);
      expect('metricReader' in config).toBe(false);
      expect(errSpy).toHaveBeenCalledOnce();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('buildOtelSdkConfig: service identity', () => {
  it('defaults to the app service name', async () => {
    const config = await buildOtelSdkConfig({});
    expect(config.serviceName).toBe('housingchoice-app');
  });

  it('HC_PROCESS=worker → worker service name', async () => {
    const config = await buildOtelSdkConfig({ HC_PROCESS: 'worker' });
    expect(config.serviceName).toBe('housingchoice-worker');
  });
});

// Log-hygiene spec section 4: the two EXPORTED span hooks that mask
// phone-bearing URL attributes. They are pure functions, so they are unit
// tested directly - the instrumentation wiring itself is asserted by nothing
// here, deliberately (starting the SDK would patch http for the whole run).
//
// The semconv cases are the load-bearing half: returning an attribute key the
// ACTIVE mode never sets would FABRICATE it onto the span, so each mode is
// pinned separately, including the two parser edge cases (an UPPERCASE token
// still activates stable mode; a token that merely CONTAINS 'http' does not).
function withSemconv(value: string | undefined, fn: () => void): void {
  const prev = process.env['OTEL_SEMCONV_STABILITY_OPT_IN'];
  if (value === undefined) delete process.env['OTEL_SEMCONV_STABILITY_OPT_IN'];
  else process.env['OTEL_SEMCONV_STABILITY_OPT_IN'] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env['OTEL_SEMCONV_STABILITY_OPT_IN'];
    else process.env['OTEL_SEMCONV_STABILITY_OPT_IN'] = prev;
  }
}

describe('span attribute masking hooks', () => {
  it('incoming (default): masks and emits ONLY the old family', () => {
    withSemconv(undefined, () => {
      const attrs = maskIncomingSpanAttributes({
        url: '/api/contacts/c1/phones/+14045551234?x=%2B15551230000',
        headers: { host: 'app.example.com' },
      } as never);
      expect(attrs).toEqual({
        'http.url': 'http://app.example.com/api/contacts/c1/phones/+1...34?x=%2B1...00',
        'http.target': '/api/contacts/c1/phones/+1...34?x=%2B1...00',
      });
    });
  });

  it('incoming (stable-only "http"): emits ONLY masked url.path/url.query', () => {
    withSemconv('http', () => {
      const attrs = maskIncomingSpanAttributes({
        url: '/a/+14045551234?x=1',
        headers: { host: 'h' },
      } as never);
      expect(attrs).toEqual({ 'url.path': '/a/+1...34', 'url.query': 'x=1' });
    });
  });

  it('incoming: a URL ending in a BARE ? emits url.path only - no fabricated empty query', () => {
    withSemconv('http', () => {
      const attrs = maskIncomingSpanAttributes({
        url: '/a?',
        headers: { host: 'h' },
      } as never);
      // The instrumentation gates url.query on a truthy search string, so the
      // key is ABSENT rather than empty. Asserting the whole object pins that.
      expect(attrs).toEqual({ 'url.path': '/a' });
      expect('url.query' in attrs).toBe(false);
    });
  });

  it('incoming ("http/dup"): emits BOTH families', () => {
    withSemconv('http/dup', () => {
      const attrs = maskIncomingSpanAttributes({
        url: '/a/+14045551234',
        headers: { host: 'h' },
      } as never) as Record<string, string>;
      expect(attrs['http.target']).toBe('/a/+1...34');
      expect(attrs['url.path']).toBe('/a/+1...34');
    });
  });

  it('an UPPERCASE token still activates stable mode (the parser lowercases)', () => {
    withSemconv('HTTP', () => {
      const attrs = maskIncomingSpanAttributes({
        url: '/a/+14045551234',
        headers: { host: 'h' },
      } as never) as Record<string, string>;
      expect(attrs['url.path']).toBe('/a/+1...34');
      expect(attrs['http.target']).toBeUndefined();
    });
  });

  it('a token that merely CONTAINS http activates nothing stable', () => {
    withSemconv('http-anything,database', () => {
      const attrs = maskIncomingSpanAttributes({
        url: '/a/+14045551234',
        headers: { host: 'h' },
      } as never) as Record<string, string>;
      expect(attrs['url.path']).toBeUndefined();
      expect(attrs['http.target']).toBe('/a/+1...34');
    });
  });

  it('outgoing (default): masks and emits ONLY the old family', () => {
    withSemconv(undefined, () => {
      const attrs = maskOutgoingSpanAttributes({
        hostname: 'api.twilio.com',
        path: '/2010-04-01/Messages.json?To=%2B15551230000',
        protocol: 'https:',
      } as never);
      expect(attrs).toEqual({
        'http.url': 'https://api.twilio.com/2010-04-01/Messages.json?To=%2B1...00',
        'http.target': '/2010-04-01/Messages.json?To=%2B1...00',
      });
    });
  });

  it('outgoing (stable-only "http"): emits ONLY masked url.full', () => {
    withSemconv('http', () => {
      const attrs = maskOutgoingSpanAttributes({
        hostname: 'h',
        path: '/p/+14045551234',
        protocol: 'https:',
      } as never);
      expect(attrs).toEqual({ 'url.full': 'https://h/p/+1...34' });
    });
  });

  it('never throws on malformed request objects (no-op-safe)', () => {
    expect(maskIncomingSpanAttributes({} as never)).toEqual({});
    expect(maskOutgoingSpanAttributes(undefined as never)).toEqual({});
  });

  it('re-applies the library signed-query redaction the overwrite would otherwise disable', () => {
    // getAbsoluteUrl REDACTS sig/Signature/AWSAccessKeyId/X-Goog-Signature
    // values before writing url attributes; hook attributes are assigned LAST,
    // so an unredacted reconstruction would WIN over the redacted one
    // (adversarial review, phase 6). The values here are clearly-fake.
    const attrs = maskOutgoingSpanAttributes({
      hostname: 'storage.example.com',
      path: '/obj?X-Goog-Signature=fakesig123&sig=fakesig456&keep=1&AWSAccessKeyId=AKIAFAKE&Signature=fakesig789',
      protocol: 'https:',
    } as never) as Record<string, string>;
    expect(attrs['http.url']).toBe(
      'https://storage.example.com/obj?X-Goog-Signature=REDACTED&sig=REDACTED&keep=1&AWSAccessKeyId=REDACTED&Signature=REDACTED',
    );
    expect(attrs['http.target']).not.toContain('fakesig');
    const incoming = maskIncomingSpanAttributes({
      url: '/cb?Signature=fakesig123&phone=%2B14045551234',
      headers: { host: 'h' },
    } as never) as Record<string, string>;
    expect(incoming['http.target']).toBe('/cb?Signature=REDACTED&phone=%2B1...34');
  });

  it('preserves a non-default outgoing port the way getAbsoluteUrl does', () => {
    const attrs = maskOutgoingSpanAttributes({
      hostname: 'localhost',
      port: 4566,
      path: '/x',
      protocol: 'http:',
    } as never) as Record<string, string>;
    expect(attrs['http.url']).toBe('http://localhost:4566/x');
    const defaultPort = maskOutgoingSpanAttributes({
      hostname: 'api.twilio.com',
      port: '443',
      path: '/x',
      protocol: 'https:',
    } as never) as Record<string, string>;
    expect(defaultPort['http.url']).toBe('https://api.twilio.com/x');
  });
});

describe('startOtel: disabled mode', () => {
  it('OTEL_SDK_DISABLED=true → resolves without loading the SDK', async () => {
    // process.env is mutated only for the duration of this call, then restored,
    // so the rest of the suite is unaffected. startOtel() must return before
    // importing any OTel package; if it tried to start the SDK it would patch
    // http for the whole process — which is exactly what we forbid.
    const prev = process.env.OTEL_SDK_DISABLED;
    process.env.OTEL_SDK_DISABLED = 'true';
    try {
      await expect(startOtel()).resolves.toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.OTEL_SDK_DISABLED;
      else process.env.OTEL_SDK_DISABLED = prev;
    }
  });
});

// Child-process boot smoke test: prove the real startOtel() boots cleanly with
// the endpoint pointed at an unreachable port AND with it unset, WITHOUT
// patching this vitest process. The child imports otel.ts, awaits startOtel(),
// prints a marker, and exits 0. A bad endpoint must fail async (never crash
// boot), so the child still exits 0.
describe('startOtel: boots in both modes (child process, unpatched)', () => {
  const child = path.join(here, 'helpers', 'otelBootChild.ts');

  function boot(env: Record<string, string>) {
    // `node --import tsx <child.ts>` — spawn node directly (cross-platform; a
    // .bin/tsx.cmd shim is EINVAL under spawnSync on Windows) with the tsx ESM
    // loader so the TypeScript child runs.
    return spawnSync(process.execPath, ['--import', 'tsx', child], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        // The child must run the REAL wiring path, never the disabled no-op.
        OTEL_SDK_DISABLED: 'false',
        ...env,
      },
    });
  }

  /**
   * Everything spawnSync knows about a failed child, for the assertion
   * messages. On 2026-08-21 both tests failed with empty stdout and the report
   * said only `expected '' to contain 'OTEL_BOOT_OK'` - while the machine-level
   * cause (the same run produced uv_os_get_passwd ENOMEM in a sibling suite,
   * i.e. resource exhaustion, not a code defect; unreproducible once the
   * machine recovered) sat in the unreported stderr/error fields. A child that
   * fails to SPAWN reports through `error`, one that dies reports through
   * `signal`/`stderr`; the assertion must show all of them or the next
   * environmental event costs another by-hand rerun.
   */
  function bootDiagnostics(res: ReturnType<typeof boot>): string {
    return (
      `status=${String(res.status)} signal=${String(res.signal)} ` +
      `spawnError=${res.error ? String(res.error) : '(none)'}\n` +
      `stderr:\n${res.stderr || '(empty)'}`
    );
  }

  it('endpoint SET to an unreachable port → boots and exits 0', () => {
    const res = boot({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' });
    expect(res.stdout, `no boot marker; ${bootDiagnostics(res)}`).toContain('OTEL_BOOT_OK');
    expect(res.status, bootDiagnostics(res)).toBe(0);
  });

  it('endpoint UNSET → boots and exits 0', () => {
    const res = boot({ OTEL_EXPORTER_OTLP_ENDPOINT: '' });
    expect(res.stdout, `no boot marker; ${bootDiagnostics(res)}`).toContain('OTEL_BOOT_OK');
    expect(res.status, bootDiagnostics(res)).toBe(0);
  });
});
