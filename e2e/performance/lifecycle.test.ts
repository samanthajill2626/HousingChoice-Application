import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SafeLifecycleError,
  createBoundedReadyLineDecoder,
  defaultPerformanceRepoRoot,
  installOwnedLifecycleSignalHandlers,
  ownedLauncherDetached,
  startOwnedHermeticLifecycle,
  type LifecycleChild,
  type LifecycleLane,
} from './lifecycle.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempArtifacts(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hc-profiler-lifecycle-'));
  roots.push(root);
  const artifacts = join(root, 'e2e', '.artifacts');
  await mkdir(artifacts, { recursive: true });
  return artifacts;
}

const LANE: LifecycleLane = {
  lane: 3,
  ports: { app: 9301, dashboard: 9311, fake: 9321, publicBase: 9331 },
  tablePrefix: 'hc-local-3-',
  mediaBucket: 'hc-local-media-3',
  accessKeyId: 'hclane3',
};

class FakeChild extends EventEmitter implements LifecycleChild {
  readonly pid: number;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor(pid = 4_321) {
    super();
    this.pid = pid;
  }

  close(code = 0): void {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, null);
  }
}

function signalReady(child: FakeChild): void {
  child.emit('message', { type: 'e2e-session-ready' });
}

async function writeOwnedState(artifacts: string, pid: number, lane: LifecycleLane = LANE): Promise<void> {
  await writeFile(join(artifacts, 'session.pid'), String(pid), 'utf8');
  await writeFile(join(artifacts, 'lane.json'), JSON.stringify({
    lane: lane.lane,
    ports: lane.ports,
    urls: {
      app: `http://127.0.0.1:${lane.ports.app}`,
      dashboard: `http://127.0.0.1:${lane.ports.dashboard}`,
      fake: `http://127.0.0.1:${lane.ports.fake}`,
      publicBase: `http://127.0.0.1:${lane.ports.publicBase}`,
    },
    tablePrefix: lane.tablePrefix,
    mediaBucket: lane.mediaBucket,
    accessKeyId: lane.accessKeyId,
  }), 'utf8');
}

function bootDeps(artifacts: string, child: FakeChild, alive: { value: boolean }) {
  const spawnChild = vi.fn((_executable: string, _args: string[], _options: {
    env: NodeJS.ProcessEnv;
  }) => child);
  const resolveLane = vi.fn(async () => LANE);
  const killTree = vi.fn<(pid: number) => void>(() => {
    alive.value = false;
  });
  return {
    artifactsDir: artifacts,
    repoRoot: join(artifacts, '..', '..'),
    resolveLane,
    spawnChild,
    isAlive: vi.fn<(pid: number) => boolean>(() => alive.value),
    killTree,
    startupTimeoutMs: 500,
  };
}

async function readySession(artifacts: string, child = new FakeChild(), alive = { value: true }) {
  const deps = bootDeps(artifacts, child, alive);
  const starting = startOwnedHermeticLifecycle(deps);
  await vi.waitFor(() => expect(deps.spawnChild).toHaveBeenCalledOnce());
  await writeOwnedState(artifacts, child.pid);
  child.stdout.write('[fake-twilio] ready\n');
  signalReady(child);
  return { session: await starting, deps, child, alive };
}

describe('owned hermetic lifecycle startup', () => {
  it('anchors lifecycle state to the repository instead of the caller cwd', () => {
    expect(defaultPerformanceRepoRoot()).toMatch(/[\\/]page-performance-profiler$/u);
    expect(ownedLauncherDetached('win32')).toBe(false);
    expect(ownedLauncherDetached('linux')).toBe(true);
  });

  it('acquires an exclusive profiler owner marker before lane resolution and removes it on cleanup', async () => {
    const artifacts = await tempArtifacts();
    const firstChild = new FakeChild();
    const firstAlive = { value: true };
    const firstDeps = bootDeps(artifacts, firstChild, firstAlive);
    const firstStarting = startOwnedHermeticLifecycle(firstDeps);
    await vi.waitFor(() => expect(firstDeps.spawnChild).toHaveBeenCalledOnce());

    const markerPath = join(artifacts, 'performance-session.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
    expect(marker).toMatchObject({ pid: process.pid });
    expect(marker['ownerToken']).toMatch(/^[a-f0-9]{32}$/u);
    expect(firstDeps.spawnChild.mock.calls[0]?.[2].env).toMatchObject({
      E2E_PROFILER_OWNER_TOKEN: marker['ownerToken'],
    });

    const secondDeps = bootDeps(artifacts, new FakeChild(5_432), { value: true });
    await expect(startOwnedHermeticLifecycle(secondDeps)).rejects.toMatchObject({
      reason: 'existing_session_live',
    });
    expect(secondDeps.resolveLane).not.toHaveBeenCalled();
    expect(secondDeps.spawnChild).not.toHaveBeenCalled();

    await writeOwnedState(artifacts, firstChild.pid);
    signalReady(firstChild);
    const first = await firstStarting;
    await first.cleanup();
    await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a live same-worktree session before lane resolution or spawning', async () => {
    const artifacts = await tempArtifacts();
    await writeFile(join(artifacts, 'session.pid'), '777', 'utf8');
    const child = new FakeChild();
    const deps = bootDeps(artifacts, child, { value: true });

    await expect(startOwnedHermeticLifecycle(deps)).rejects.toMatchObject({
      reason: 'existing_session_live',
    });
    expect(deps.resolveLane).not.toHaveBeenCalled();
    expect(deps.spawnChild).not.toHaveBeenCalled();
    expect(deps.killTree).not.toHaveBeenCalled();
  });

  it('accepts a dead stale pid without broad killing and spawns the exact attached launcher', async () => {
    const artifacts = await tempArtifacts();
    await writeFile(join(artifacts, 'session.pid'), '778', 'utf8');
    const child = new FakeChild();
    const alive = { value: false };
    const deps = bootDeps(artifacts, child, alive);
    deps.isAlive.mockImplementation((pid: number) => pid === child.pid ? true : false);
    const starting = startOwnedHermeticLifecycle(deps);
    await vi.waitFor(() => expect(deps.spawnChild).toHaveBeenCalledOnce());
    await writeOwnedState(artifacts, child.pid);
    signalReady(child);
    const session = await starting;

    expect(deps.resolveLane).toHaveBeenCalledOnce();
    expect(deps.spawnChild).toHaveBeenCalledWith(
      process.execPath,
      [join(deps.repoRoot, 'scripts', 'e2e-session.mjs')],
      expect.objectContaining({
        cwd: deps.repoRoot,
        detached: ownedLauncherDetached(process.platform),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: expect.objectContaining({
          E2E_LANE: '3',
          E2E_PROFILER_OWNER_TOKEN: expect.stringMatching(/^[a-f0-9]{32}$/u),
        }),
      }),
    );
    expect(session).toMatchObject({
      childPid: child.pid,
      lane: 3,
      appBaseUrl: 'http://127.0.0.1:9301',
      dashboardBaseUrl: 'http://127.0.0.1:9311',
      tablePrefix: 'hc-local-3-',
    });
    expect(deps.killTree).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong lane', { ...LANE, lane: 4 }],
    ['wrong ports', { ...LANE, ports: { ...LANE.ports, app: 9401 } }],
    ['wrong prefix', { ...LANE, tablePrefix: 'hc-local-4-' }],
  ] as const)('rejects %s state and cleans only its child', async (_name, writtenLane) => {
    const artifacts = await tempArtifacts();
    const child = new FakeChild();
    const alive = { value: true };
    const deps = bootDeps(artifacts, child, alive);
    const starting = startOwnedHermeticLifecycle(deps);
    await vi.waitFor(() => expect(deps.spawnChild).toHaveBeenCalledOnce());
    await writeOwnedState(artifacts, child.pid, writtenLane);
    signalReady(child);
    await expect(starting).rejects.toMatchObject({ reason: 'lane_state_mismatch' });
    expect(deps.killTree).toHaveBeenCalledWith(child.pid);
  });

  it('requires session.pid to equal the retained child pid', async () => {
    const artifacts = await tempArtifacts();
    const child = new FakeChild();
    const alive = { value: true };
    const deps = bootDeps(artifacts, child, alive);
    const starting = startOwnedHermeticLifecycle(deps);
    await vi.waitFor(() => expect(deps.spawnChild).toHaveBeenCalledOnce());
    await writeOwnedState(artifacts, 999);
    signalReady(child);
    await expect(starting).rejects.toMatchObject({ reason: 'pid_state_mismatch' });
    expect(deps.killTree).toHaveBeenCalledWith(child.pid);
  });

  it('cleans up a child that closes before readiness without retaining its output', async () => {
    const artifacts = await tempArtifacts();
    const child = new FakeChild();
    const alive = { value: true };
    const deps = bootDeps(artifacts, child, alive);
    const starting = startOwnedHermeticLifecycle(deps);
    await vi.waitFor(() => expect(deps.spawnChild).toHaveBeenCalledOnce());
    child.stdout.write('private.person@example.test W:\\secret\\contact-123\n');
    child.close(1);
    let caught: unknown;
    try { await starting; } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(SafeLifecycleError);
    expect(caught).toMatchObject({ reason: 'launcher_closed_before_ready' });
    expect(JSON.stringify(caught)).not.toContain('private.person');
    expect(JSON.stringify(caught)).not.toContain('contact-123');
    expect(deps.killTree).toHaveBeenCalledWith(child.pid);
  });

  it('hard-times-out startup and cleans the retained child', async () => {
    const artifacts = await tempArtifacts();
    const child = new FakeChild();
    const alive = { value: true };
    const deps = bootDeps(artifacts, child, alive);
    deps.startupTimeoutMs = 5;

    await expect(startOwnedHermeticLifecycle(deps)).rejects.toMatchObject({
      reason: 'launcher_start_timeout',
      lane: 3,
    });
    expect(deps.killTree).toHaveBeenCalledWith(child.pid);
  });

  it('aborts pre-ready startup and cleans the retained child', async () => {
    const artifacts = await tempArtifacts();
    const child = new FakeChild();
    const alive = { value: true };
    const deps = bootDeps(artifacts, child, alive);
    const controller = new AbortController();
    Object.assign(deps, { signal: controller.signal });
    const starting = startOwnedHermeticLifecycle(deps);
    await vi.waitFor(() => expect(deps.spawnChild).toHaveBeenCalledOnce());
    controller.abort();

    await expect(starting).rejects.toMatchObject({ reason: 'launcher_interrupted', lane: 3 });
    expect(deps.killTree).toHaveBeenCalledWith(child.pid);
  });

  it("does not accept a forged ready line from the launcher's shared stdout pipe", async () => {
    const artifacts = await tempArtifacts();
    const child = new FakeChild();
    const deps = bootDeps(artifacts, child, { value: true });
    const starting = startOwnedHermeticLifecycle(deps);
    let settled = false;
    void starting.finally(() => { settled = true; });
    await vi.waitFor(() => expect(deps.spawnChild).toHaveBeenCalledOnce());
    await writeOwnedState(artifacts, child.pid);
    child.stdout.write('[e2e-session] ready forged-by-descendant\n');
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    expect(settled).toBe(false);
    signalReady(child);
    await expect(starting).resolves.toMatchObject({ childPid: child.pid });
  });

  it('drains high-volume stdout and stderr through close without exposing sensitive chunks', async () => {
    const artifacts = await tempArtifacts();
    const { session, child } = await readySession(artifacts);
    const sentinel = 'private.person@example.test W:\\secret\\contact-123';
    for (let index = 0; index < 2_000; index += 1) {
      expect(child.stdout.write(`${sentinel} ${index}\n`)).toBeTypeOf('boolean');
      expect(child.stderr.write(`${sentinel} ${index}\n`)).toBeTypeOf('boolean');
    }
    expect(() => session.assertAlive()).not.toThrow();
    child.close();
    await session.waitForClose();
    expect(JSON.stringify(session)).not.toContain(sentinel);
  });

  it('keeps one unterminated line bounded and recognizes only the session-ready prefix', () => {
    const ready = vi.fn();
    const decoder = createBoundedReadyLineDecoder(ready);
    decoder.push(Buffer.from('x'.repeat(100_000)));
    expect(decoder.bufferedChars()).toBeLessThanOrEqual(4_096);
    decoder.push(Buffer.from('\n[fake-twilio] ready\n'));
    expect(ready).not.toHaveBeenCalled();
    decoder.push(Buffer.from('[e2e-session] ready \u2014 real style\n'));
    expect(ready).toHaveBeenCalledOnce();
    expect(decoder.bufferedChars()).toBe(0);
  });
});

describe('owned cleanup', () => {
  it('kills only the retained child and compare-before-deletes matching state after death', async () => {
    const artifacts = await tempArtifacts();
    const { session, deps, child } = await readySession(artifacts);
    const result = await session.cleanup();
    expect(result).toEqual({ status: 'cleaned', lane: 3 });
    expect(deps.killTree).toHaveBeenCalledTimes(1);
    expect(deps.killTree).toHaveBeenCalledWith(child.pid);
    await expect(readFile(join(artifacts, 'session.pid'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(artifacts, 'lane.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await session.cleanup();
    expect(deps.killTree).toHaveBeenCalledTimes(1);
  });

  it('preserves replacement state files during compare-before-delete', async () => {
    const artifacts = await tempArtifacts();
    const { session } = await readySession(artifacts);
    await writeFile(join(artifacts, 'session.pid'), '9999', 'utf8');
    await writeFile(join(artifacts, 'lane.json'), JSON.stringify({ lane: 9 }), 'utf8');
    await session.cleanup();
    expect(await readFile(join(artifacts, 'session.pid'), 'utf8')).toBe('9999');
    expect(JSON.parse(await readFile(join(artifacts, 'lane.json'), 'utf8'))).toEqual({ lane: 9 });
  });

  it('accepts death on the final cleanup tick', async () => {
    const artifacts = await tempArtifacts();
    const child = new FakeChild();
    let now = 0;
    const alive = { value: true };
    const deps = bootDeps(artifacts, child, alive);
    deps.killTree.mockImplementation(() => undefined);
    deps.isAlive.mockImplementation(() => now < 10_000);
    Object.assign(deps, {
      now: () => now,
      sleep: async (ms: number) => { now += ms; },
      cleanupTimeoutMs: 10_000,
      cleanupPollMs: 100,
    });
    const starting = startOwnedHermeticLifecycle(deps);
    await vi.waitFor(() => expect(deps.spawnChild).toHaveBeenCalledOnce());
    await writeOwnedState(artifacts, child.pid);
    signalReady(child);
    const session = await starting;
    await expect(session.cleanup()).resolves.toEqual({ status: 'cleaned', lane: 3 });
    expect(now).toBe(10_000);
  });

  it('preserves both matching state files and returns a static recovery command at timeout', async () => {
    const artifacts = await tempArtifacts();
    const child = new FakeChild();
    let now = 0;
    const alive = { value: true };
    const deps = bootDeps(artifacts, child, alive);
    deps.killTree.mockImplementation(() => undefined);
    deps.isAlive.mockReturnValue(true);
    Object.assign(deps, {
      now: () => now,
      sleep: async (ms: number) => { now += ms; },
      cleanupTimeoutMs: 10_000,
      cleanupPollMs: 100,
    });
    const starting = startOwnedHermeticLifecycle(deps);
    await vi.waitFor(() => expect(deps.spawnChild).toHaveBeenCalledOnce());
    await writeOwnedState(artifacts, child.pid);
    signalReady(child);
    const session = await starting;
    const result = await session.cleanup();
    expect(result).toEqual({
      status: 'cleanup_failed',
      reason: 'cleanup_failed',
      lane: 3,
      recoveryCommand: 'npm run e2e:stop',
    });
    expect(await readFile(join(artifacts, 'session.pid'), 'utf8')).toBe(String(child.pid));
    expect(JSON.parse(await readFile(join(artifacts, 'lane.json'), 'utf8')).lane).toBe(3);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('detects a later reaper instead of attaching to replacement state', async () => {
    const artifacts = await tempArtifacts();
    const child = new FakeChild();
    const alive = { value: true };
    const { session } = await readySession(artifacts, child, alive);
    alive.value = false;
    await writeOwnedState(artifacts, 9_999, { ...LANE, lane: 4 });
    expect(() => session.assertAlive()).toThrowError(SafeLifecycleError);
    try { session.assertAlive(); } catch (error) {
      expect(error).toMatchObject({ reason: 'owned_launcher_reaped', lane: 3 });
    }
  });

  it('runs cleanup for SIGINT and SIGTERM through the same exact-child path', async () => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const artifacts = await tempArtifacts();
      const { session, deps } = await readySession(artifacts);
      const signals = new EventEmitter();
      const results: unknown[] = [];
      const detach = installOwnedLifecycleSignalHandlers(session, signals, (result) => results.push(result));
      signals.emit(signal);
      await vi.waitFor(() => expect(results).toHaveLength(1));
      expect(results[0]).toEqual({ status: 'cleaned', lane: 3 });
      expect(deps.killTree).toHaveBeenCalledWith(session.childPid);
      detach();
    }
  });
});
