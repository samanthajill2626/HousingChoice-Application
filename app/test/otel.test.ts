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
import { buildOtelSdkConfig, startOtel } from '../src/lib/otel.js';

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
