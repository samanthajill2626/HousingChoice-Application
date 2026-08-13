import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as sessionState from '../../scripts/lib/sessionState.mjs';

const { removeOwnedSessionState } = sessionState;

type SessionStateApi = {
  probeLaneOwner: (options: {
    laneState: Record<string, unknown>;
    fetchImpl: typeof fetch;
  }) => Promise<{ confirmed: boolean; reason: string }>;
  inspectSessionLiveness: (options: {
    laneState: Record<string, unknown>;
    pidText: string | null;
    isAliveFn: (pid: number) => boolean;
    fetchImpl: typeof fetch;
  }) => Promise<{ launcherAlive: boolean; ownerConfirmed: boolean; live: boolean }>;
};

const sessionStateApi = sessionState as unknown as SessionStateApi;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('persistent e2e session state', () => {
  it('removes only the matching launcher pid and retains lane.json for e2e:stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hc-e2e-session-state-'));
    roots.push(root);
    const pidFile = join(root, 'session.pid');
    const laneFile = join(root, 'lane.json');
    await writeFile(pidFile, '4321', 'utf8');
    await writeFile(laneFile, JSON.stringify({ launcherPid: 4321, lane: 3 }), 'utf8');

    removeOwnedSessionState({ pidFile, launcherPid: 4321 });

    await expect(readFile(pidFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(laneFile, 'utf8'))).toEqual({ launcherPid: 4321, lane: 3 });
  });

  it('confirms a lane owner only when ping lane and table prefix match', async () => {
    const laneState = {
      lane: 3,
      tablePrefix: 'hc-local-3-',
      urls: { app: 'http://127.0.0.1:8103' },
    };
    const matchingFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      dev: true,
      lane: 3,
      tablePrefix: 'hc-local-3-',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const mismatchedFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      dev: true,
      lane: 4,
      tablePrefix: 'hc-local-4-',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(sessionStateApi.probeLaneOwner({
      laneState,
      fetchImpl: matchingFetch,
    })).resolves.toEqual({ confirmed: true, reason: 'confirmed' });
    await expect(sessionStateApi.probeLaneOwner({
      laneState,
      fetchImpl: mismatchedFetch,
    })).resolves.toEqual({ confirmed: false, reason: 'mismatch' });
  });

  it('reports liveness from a matching launcher or a confirmed app owner', async () => {
    const laneState = {
      launcherPid: 4321,
      lane: 3,
      tablePrefix: 'hc-local-3-',
      urls: { app: 'http://127.0.0.1:8103' },
    };
    const confirmedFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      dev: true,
      lane: 3,
      tablePrefix: 'hc-local-3-',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const unreachableFetch = vi.fn().mockRejectedValue(new Error('unreachable'));

    await expect(sessionStateApi.inspectSessionLiveness({
      laneState,
      pidText: '4321',
      isAliveFn: () => true,
      fetchImpl: unreachableFetch,
    })).resolves.toEqual({ launcherAlive: true, ownerConfirmed: false, live: true });
    await expect(sessionStateApi.inspectSessionLiveness({
      laneState,
      pidText: '4321',
      isAliveFn: () => false,
      fetchImpl: confirmedFetch,
    })).resolves.toEqual({ launcherAlive: false, ownerConfirmed: true, live: true });
    await expect(sessionStateApi.inspectSessionLiveness({
      laneState,
      pidText: '9999',
      isAliveFn: () => true,
      fetchImpl: unreachableFetch,
    })).resolves.toEqual({ launcherAlive: false, ownerConfirmed: false, live: false });
  });
});
