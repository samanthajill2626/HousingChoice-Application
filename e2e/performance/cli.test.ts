import { describe, expect, it, vi } from 'vitest';
import { main, readPageStoreSnapshot, runProfiler, type CliRuntime } from './cli.js';
import type { RunConfig } from './config.js';

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
  it('degrades an unavailable auxiliary page snapshot to null without exposing the browser error', async () => {
    const read = vi.fn(async () => {
      throw new Error('private.person@example.test browser target closed');
    });

    await expect(readPageStoreSnapshot(read)).resolves.toBeNull();
    expect(read).toHaveBeenCalledOnce();
  });

  it('parse failures and print-config perform zero runtime, network, lifecycle, or browser work', async () => {
    const loadRuntime = vi.fn();
    await expect(runProfiler(['bad-target'], { loadRuntime, configDeps })).resolves.toBe(1);
    expect(loadRuntime).not.toHaveBeenCalled();

    const stdout = vi.fn();
    await expect(runProfiler(['hermetic', '--print-config'], { loadRuntime, configDeps, stdout })).resolves.toBe(0);
    expect(loadRuntime).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledOnce();
    expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({ target: 'hermetic' });
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
    await expect(runProfiler(['local', '--base-url=http://localhost:5174'], {
      configDeps,
      loadRuntime: vi.fn(async () => value),
    })).resolves.toBe(0);
    expect(events).toEqual([
      'local-proof', 'dashboard', 'auth-local', 'firewall', 'warmup',
      'collect', 'report', 'close-dashboard',
    ]);
    expect(value.startHermetic).not.toHaveBeenCalled();
    expect(value.reseedHermetic).not.toHaveBeenCalled();
    expect(value.cleanupHermetic).not.toHaveBeenCalled();
  });

  it('runs hosted headed login/admin/env proof/firewall/collect/report without seed or warmup', async () => {
    const events: string[] = [];
    const value = runtime(events);
    await expect(runProfiler(['hosted-dev', '--base-url=https://dev.example.test', '--headed'], {
      configDeps,
      loadRuntime: vi.fn(async () => value),
    })).resolves.toBe(0);
    expect(events).toEqual([
      'dashboard', 'auth-hosted', 'firewall', 'collect', 'report', 'close-dashboard',
    ]);
    expect(value.startHermetic).not.toHaveBeenCalled();
    expect(value.verifyLocal).not.toHaveBeenCalled();
    expect(value.reseedHermetic).not.toHaveBeenCalled();
    expect(value.warmup).not.toHaveBeenCalled();
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
