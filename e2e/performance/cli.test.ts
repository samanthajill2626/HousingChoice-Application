import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  captureCdpClockAlignment,
  installProfilerProcessHandlers,
  main,
  performanceArtifactRoot,
  readPageStoreSnapshot,
  runProfiler,
  type CliRuntime,
} from './cli.js';
import type { RunConfig } from './config.js';
import { ROUTES } from './routes.js';
import type { SampleInstrumentation } from './collect.js';

function runtime(events: string[], overrides: Partial<CliRuntime> = {}): CliRuntime {
  const phase = <T>(name: string, value: T) => vi.fn(async () => {
    events.push(name);
    return value;
  });
  return {
    startHermetic: phase('start', { lane: 7 }),
    verifyHermetic: phase('verify', undefined),
    reseedHermetic: phase('reseed', undefined),
    openDashboard: phase('dashboard', { kind: 'dashboard' }),
    verifyLocal: phase('local-proof', undefined),
    authenticateHermetic: phase('auth-hermetic', { storageState: {} }),
    authenticateLocal: phase('auth-local', { storageState: {} }),
    authenticateHosted: phase('auth-hosted', { storageState: {} }),
    installFirewall: phase('firewall', undefined),
    warmup: phase('warmup', undefined),
    collect: phase('collect', { samples: [] }),
    report: phase('report', { exitCode: 0, status: 'written' }),
    closeDashboard: phase('close-dashboard', undefined),
    cleanupHermetic: phase('cleanup', { status: 'cleaned', lane: 7 }),
    ...overrides,
  };
}

const configDeps = {
  cwd: 'W:\\tmp\\page-performance-profiler',
  now: () => new Date('2026-08-12T12:00:00.000Z'),
  randomRouteOrderSeed: () => 42,
};

describe('top-level profiler sequencing', () => {
  it('turns signals and fatal process events into a closed abort without retaining raw errors', () => {
    for (const event of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const) {
      const source = new EventEmitter();
      const controller = new AbortController();
      const detach = installProfilerProcessHandlers(controller, source as never);
      source.emit(event, new Error('private.person@example.test'));
      expect(controller.signal.aborted).toBe(true);
      expect(JSON.stringify(controller.signal.reason)).not.toContain('private.person');
      detach();
    }
  });

  it('aligns the Node clock to the midpoint of the CDP timestamp round trip', async () => {
    const send = vi.fn(async (method: string) => method === 'Performance.getMetrics'
      ? { metrics: [{ name: 'Timestamp', value: 123.5 }] }
      : {});
    const now = vi.fn()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(112);

    await expect(captureCdpClockAlignment({ send } as never, now)).resolves.toEqual({
      cdpOriginSeconds: 123.5,
      nodeOriginMs: 106,
    });
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      'Performance.enable',
      'Performance.getMetrics',
    ]);
  });

  it('anchors performance artifacts to the repository instead of the caller cwd', () => {
    expect(performanceArtifactRoot()).toMatch(/[\\/]e2e[\\/]\.artifacts[\\/]performance$/u);
    expect(performanceArtifactRoot()).not.toContain('e2e\\e2e');
  });

  it('disposes real sample adapters once across cancellation and later collector cleanup', async () => {
    const cliModule = await import('./cli.js') as typeof import('./cli.js') & {
      createRealInstrumentation?: (input: unknown) => SampleInstrumentation;
    };
    expect(cliModule.createRealInstrumentation).toBeTypeOf('function');
    if (cliModule.createRealInstrumentation === undefined) return;

    const detach = vi.fn(async () => undefined);
    const cdp = {
      send: vi.fn(async (method: string) => method === 'Performance.getMetrics'
        ? { metrics: [{ name: 'Timestamp', value: 1 }] }
        : {}),
      on: vi.fn(),
      detach,
    };
    const on = vi.fn();
    const off = vi.fn();
    const contextState = { token: null as { evidence(): []; } | null };
    const page = {
      rawPage: {
        context: () => ({ newCDPSession: vi.fn(async () => cdp) }),
        on,
        off,
        evaluate: vi.fn(async () => undefined),
      },
      contextState,
      firewall: {
        assertHealthy: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
      },
      baseUrl: 'http://127.0.0.1:9111',
    };
    class FakeNetworkCollector {
      beginSample(): void {}
    }
    const instrumentation = cliModule.createRealInstrumentation({
      route: ROUTES[0]!,
      mode: 'warm',
      repeat: 0,
      baseUrl: 'http://127.0.0.1:9111',
      readyTimeoutMs: 10,
      settleMs: 1,
      pollMs: 1,
      modules: {
        collect: { NetworkCollector: FakeNetworkCollector },
        firewall: { createFirewallRecordingToken: () => ({ evidence: () => [] }) },
        readiness: {
          waitForMeaningfulReady: async () => { throw new Error('readiness_failed'); },
        },
        routes: { expectedGets: () => [] },
      },
      requests: [],
    } as never);

    await instrumentation.beginSample({
      page: page as never,
      token: 'real-warm',
      route: ROUTES[0]!,
      branch: { kind: 'none' },
      mode: 'warm',
      repeat: 0,
      sourcePageUrl: '/',
      destinationPageUrl: '/',
    });
    expect(on).toHaveBeenCalledOnce();
    expect(contextState.token).not.toBeNull();

    await instrumentation.disposeSample();
    await instrumentation.disposeSample();
    await expect(instrumentation.collectSample({
      page: page as never,
      token: 'real-warm',
      route: ROUTES[0]!,
      branch: { kind: 'none' },
      mode: 'warm',
      repeat: 0,
    })).rejects.toThrowError('readiness_failed');

    expect(contextState.token).toBeNull();
    expect(off).toHaveBeenCalledOnce();
    expect(detach).toHaveBeenCalledOnce();
  });

  it('degrades an unavailable auxiliary page snapshot to null without exposing the browser error', async () => {
    const read = vi.fn(async () => {
      throw new Error('private.person@example.test browser target closed');
    });

    await expect(readPageStoreSnapshot(read)).resolves.toBeNull();
    expect(read).toHaveBeenCalledOnce();
  });

  it('parse failures and print-config perform zero runtime, network, lifecycle, or browser work', async () => {
    const loadRuntime = vi.fn();
    const invalidStdout = vi.fn();
    const invalidStderr = vi.fn();
    await expect(runProfiler(['hermetic', '--scale=101', '--baseline=invalid-config-sentinel.json'], {
      loadRuntime,
      configDeps,
      stdout: invalidStdout,
      stderr: invalidStderr,
    })).resolves.toBe(1);
    expect(loadRuntime).not.toHaveBeenCalled();
    expect(invalidStdout).not.toHaveBeenCalled();
    expect(invalidStderr.mock.calls).toEqual([['configuration_invalid\n']]);
    expect(JSON.stringify(invalidStderr.mock.calls)).not.toContain('invalid-config-sentinel');

    const stdout = vi.fn();
    await expect(runProfiler(['hermetic', '--print-config'], { loadRuntime, configDeps, stdout })).resolves.toBe(0);
    expect(loadRuntime).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledOnce();
    expect(stdout.mock.calls[0]![0].trim().split(/\r?\n/u)).toHaveLength(1);
    expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({ target: 'hermetic' });
  });

  it('prints only the resolved hermetic count manifest before runtime loading and startup', async () => {
    const events: string[] = [];
    const value = runtime(events);
    const expectedManifest = {
      scale: 1,
      contacts: 100,
      units: 25,
      placements: 50,
      tours: 50,
      conversations: 100,
      messagesPerConversation: 10,
      broadcasts: 10,
      recipientsPerBroadcast: 25,
      messageCount: 1000,
      requestedRecipientCount: 250,
      resolvedRecipientsPerBroadcast: 25,
      resolvedRecipientCount: 250,
      requestedRelayGroupCount: 20,
      relayGroupCount: 20,
      clippedRelayGroupCount: 0,
      fixedUnmatchedEmailCount: 4,
      physicalItemCount: 1339,
      totalItemCount: 1589,
    };
    const expectedLine = `performance_seed_counts=${JSON.stringify(expectedManifest)}\n`;
    const stdout = vi.fn((text: string) => events.push(`stdout:${text}`));
    const loadRuntime = vi.fn(async () => {
      events.push('load-runtime');
      return value;
    });

    await expect(runProfiler([
      'hermetic',
      '--scale=1',
      '--baseline=baseline-path-sentinel.json',
    ], { configDeps, loadRuntime, stdout })).resolves.toBe(0);

    expect(stdout.mock.calls).toEqual([[expectedLine]]);
    expect(events.slice(0, 3)).toEqual([
      `stdout:${expectedLine}`,
      'load-runtime',
      'start',
    ]);
    expect(JSON.parse(expectedLine.slice('performance_seed_counts='.length))).toEqual(expectedManifest);
    expect(expectedLine).not.toContain('anchor');
    expect(expectedLine).not.toContain('2026-08-12');
    expect(expectedLine).not.toContain('baseline-path-sentinel');
    expect(expectedLine).not.toContain('founder@example.com');
    expect(expectedLine).not.toContain('hermetic');
    expect(expectedLine).not.toContain('lean_tenant');
  });

  it('keeps the closed failure reason after the hermetic count line', async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    await expect(runProfiler(['hermetic'], {
      configDeps,
      stdout,
      stderr,
      loadRuntime: vi.fn(async () => {
        throw { reason: 'target_proof_failed', secret: 'runtime-secret-sentinel' };
      }),
    })).resolves.toBe(1);

    expect(stdout).toHaveBeenCalledOnce();
    expect(stdout.mock.calls[0]![0]).toMatch(/^performance_seed_counts=\{/u);
    expect(stderr.mock.calls).toEqual([['target_proof_failed\n']]);
    expect(JSON.stringify([stdout.mock.calls, stderr.mock.calls])).not.toContain('runtime-secret-sentinel');
  });

  it('runs hermetic parse/start/verify/reseed/dashboard/auth/firewall/warmup/collect/report/final cleanup', async () => {
    const events: string[] = [];
    const value = runtime(events);
    const exit = await runProfiler(['hermetic'], {
      configDeps,
      loadRuntime: vi.fn(async () => value),
    });
    expect(exit).toBe(0);
    expect(events).toEqual([
      'start', 'verify', 'reseed', 'dashboard', 'auth-hermetic', 'firewall',
      'warmup', 'collect', 'report', 'close-dashboard', 'cleanup',
    ]);
  });

  it('aborts an active hermetic phase on SIGINT and still runs owned cleanup', async () => {
    const events: string[] = [];
    const processEvents = new EventEmitter();
    const value = runtime(events, {
      verifyHermetic: vi.fn(async () => {
        events.push('verify');
        await new Promise<void>(() => undefined);
      }),
    });
    const stderr = vi.fn();
    const running = runProfiler(['hermetic'], {
      configDeps,
      loadRuntime: vi.fn(async () => value),
      processEvents: processEvents as never,
      stderr,
    });
    await vi.waitFor(() => expect(value.verifyHermetic).toHaveBeenCalledOnce());
    processEvents.emit('SIGINT');

    await expect(running).resolves.toBe(1);
    expect(events.at(-1)).toBe('cleanup');
    expect(stderr).toHaveBeenCalledWith('interrupted\n');
  });

  it('always cleans hermetic startup, profiling, report, browser, and privacy failures', async () => {
    for (const failure of ['verifyHermetic', 'reseedHermetic', 'openDashboard', 'authenticateHermetic', 'installFirewall', 'warmup', 'collect', 'report'] as const) {
      const events: string[] = [];
      const value = runtime(events, {
        [failure]: vi.fn(async () => {
          events.push(failure);
          throw new Error('private.person@example.test W:\\secret\\contact-123');
        }),
      });
      const stderr = vi.fn();
      const exit = await runProfiler(['hermetic'], {
        configDeps,
        loadRuntime: vi.fn(async () => value),
        stderr,
      });
      expect(exit, failure).toBe(1);
      expect(events.at(-1), failure).toBe('cleanup');
      expect(JSON.stringify(stderr.mock.calls)).not.toContain('private.person');
      expect(JSON.stringify(stderr.mock.calls)).not.toContain('contact-123');
    }
  });

  it('makes cleanup failure nonzero and prints only lane plus static recovery command', async () => {
    const events: string[] = [];
    const stderr = vi.fn();
    const value = runtime(events, {
      cleanupHermetic: vi.fn(async () => {
        events.push('cleanup');
        return { status: 'cleanup_failed', reason: 'cleanup_failed', lane: 7, recoveryCommand: 'npm run e2e:stop' };
      }),
    });
    await expect(runProfiler(['hermetic'], {
      configDeps,
      loadRuntime: vi.fn(async () => value),
      stderr,
    })).resolves.toBe(1);
    expect(stderr.mock.calls).toEqual([['cleanup_failed lane=7 recovery="npm run e2e:stop"\n']]);
  });

  it('runs local proof/TTY existing-user auth/firewall/warmup/collect/report without lifecycle or seed', async () => {
    const events: string[] = [];
    const value = runtime(events);
    const stdout = vi.fn();
    await expect(runProfiler(['local', '--base-url=http://localhost:5174'], {
      configDeps,
      loadRuntime: vi.fn(async () => value),
      stdout,
    })).resolves.toBe(0);
    expect(events).toEqual([
      'local-proof', 'dashboard', 'auth-local', 'firewall', 'warmup',
      'collect', 'report', 'close-dashboard',
    ]);
    expect(value.startHermetic).not.toHaveBeenCalled();
    expect(value.reseedHermetic).not.toHaveBeenCalled();
    expect(value.cleanupHermetic).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it('runs hosted headed login/admin/env proof/firewall/collect/report without seed or warmup', async () => {
    const events: string[] = [];
    const value = runtime(events);
    const stdout = vi.fn();
    await expect(runProfiler(['hosted-dev', '--base-url=https://dev.example.test', '--headed'], {
      configDeps,
      loadRuntime: vi.fn(async () => value),
      stdout,
    })).resolves.toBe(0);
    expect(events).toEqual([
      'dashboard', 'auth-hosted', 'firewall', 'collect', 'report', 'close-dashboard',
    ]);
    expect(value.startHermetic).not.toHaveBeenCalled();
    expect(value.verifyLocal).not.toHaveBeenCalled();
    expect(value.reseedHermetic).not.toHaveBeenCalled();
    expect(value.warmup).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it('returns zero for slower valid comparisons and nonzero for closed safety/auth/privacy/browser failures', async () => {
    const slower = runtime([], {
      report: vi.fn(async () => ({ exitCode: 0, status: 'written', comparison: 'slower' })),
    });
    await expect(runProfiler(['hermetic'], {
      configDeps,
      loadRuntime: vi.fn(async () => slower),
    })).resolves.toBe(0);

    for (const phase of ['verifyLocal', 'authenticateHosted', 'installFirewall', 'collect', 'report'] as const) {
      const value = runtime([], { [phase]: vi.fn(async () => { throw new Error('closed_failure'); }) });
      const argv = phase === 'verifyLocal'
        ? ['local', '--base-url=http://localhost:5174']
        : phase === 'authenticateHosted'
          ? ['hosted-dev', '--base-url=https://dev.example.test', '--headed']
          : ['hermetic'];
      await expect(runProfiler(argv, {
        configDeps,
        loadRuntime: vi.fn(async () => value),
      })).resolves.toBe(1);
    }
  });

  it('prints a fixed safe privacy failure record without candidate content', async () => {
    const stdout = vi.fn();
    const sensitiveValue = 'private.person@example.com';
    const value = runtime([], {
      report: vi.fn(async () => ({
        exitCode: 1,
        status: 'privacy_failure',
        directoryName: '20260812T123456789Z-33334444-quarantined',
        files: ['summary.json', 'report.md', sensitiveValue],
        reasonCategories: ['email_address', sensitiveValue],
      })),
    });

    await expect(runProfiler(['hermetic'], {
      configDeps,
      loadRuntime: vi.fn(async () => value),
      stdout,
    })).resolves.toBe(1);

    const output = stdout.mock.calls.map(([text]) => text as string).join('');
    expect(output).toContain('performance_report=20260812T123456789Z-33334444-quarantined\n');
    expect(output).toContain('performance_privacy_failure={"files":["report.md","summary.json"],"reasonCategories":["email_address"]}\n');
    expect(output).not.toContain(sensitiveValue);
  });

  it('propagates a finalized checkpoint mismatch report as nonzero without another lifecycle pass', async () => {
    const events: string[] = [];
    const value = runtime(events, {
      report: vi.fn(async () => {
        events.push('checkpoint-report');
        return { exitCode: 1, status: 'checkpoint_mismatch' };
      }),
    });
    await expect(runProfiler([
      'hermetic', '--scale=1', '--cold-repeats=1', '--warm-repeats=1', '--contract-checkpoint',
    ], { configDeps, loadRuntime: vi.fn(async () => value) })).resolves.toBe(1);
    expect(events).toContain('checkpoint-report');
    expect(events.at(-1)).toBe('cleanup');
  });

  it('main sets the supplied process exit code instead of throwing raw failures', async () => {
    const processLike = { exitCode: undefined as number | undefined };
    await main(['bad-target'], {
      processLike,
      loadRuntime: vi.fn(),
      configDeps,
    });
    expect(processLike.exitCode).toBe(1);
  });
});
