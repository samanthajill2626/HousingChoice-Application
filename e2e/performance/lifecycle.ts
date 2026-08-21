import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { resolveLane as resolveRepositoryLane } from '../support/lane.mjs';
import { isAlive as processIsAlive, killTree as killProcessTree } from '../../scripts/lib/killTree.mjs';

const READY_PREFIX = '[e2e-session] ready';
const READY_LINE_LIMIT = 4_096;
const RECOVERY_COMMAND = 'npm run e2e:stop';
const OWNER_MARKER_RECOVERY_PATH = 'e2e/.artifacts/performance-session.json';

export function defaultPerformanceRepoRoot(moduleUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..', '..');
}

export type LifecycleFailureReason =
  | 'existing_session_live'
  | 'owner_marker_failed'
  | 'lane_zero_forbidden'
  | 'launcher_spawn_failed'
  | 'launcher_closed_before_ready'
  | 'launcher_start_timeout'
  | 'launcher_interrupted'
  | 'launcher_failed_before_ready'
  | 'profiler_existing_session_live'
  | 'profiler_app_port_occupied'
  | 'profiler_dashboard_port_occupied'
  | 'profiler_fake_port_occupied'
  | 'profiler_public_base_port_occupied'
  | 'profiler_ping_failed'
  | 'profiler_commit_identity_mismatch'
  | 'profiler_owner_identity_mismatch'
  | 'profiler_ipc_unavailable'
  | 'lane_state_mismatch'
  | 'pid_state_mismatch'
  | 'owned_launcher_reaped'
  | 'cleanup_failed';

export class SafeLifecycleError extends Error {
  readonly reason: LifecycleFailureReason;
  readonly lane?: number;
  readonly recoveryCommand?: typeof RECOVERY_COMMAND;
  readonly markerPath?: typeof OWNER_MARKER_RECOVERY_PATH;

  constructor(reason: LifecycleFailureReason, lane?: number) {
    super(reason);
    this.name = 'SafeLifecycleError';
    this.stack = undefined;
    this.reason = reason;
    if (lane !== undefined) this.lane = lane;
    if (reason === 'cleanup_failed') this.recoveryCommand = RECOVERY_COMMAND;
    if (reason === 'existing_session_live') this.markerPath = OWNER_MARKER_RECOVERY_PATH;
  }

  toJSON(): {
    reason: LifecycleFailureReason;
    lane?: number;
    recoveryCommand?: typeof RECOVERY_COMMAND;
    markerPath?: typeof OWNER_MARKER_RECOVERY_PATH;
  } {
    return {
      reason: this.reason,
      ...(this.lane !== undefined && { lane: this.lane }),
      ...(this.recoveryCommand !== undefined && { recoveryCommand: this.recoveryCommand }),
      ...(this.markerPath !== undefined && { markerPath: this.markerPath }),
    };
  }
}

export interface LifecycleLane {
  lane: number;
  ports: { app: number; dashboard: number; fake: number; publicBase: number };
  tablePrefix: string;
  mediaBucket: string;
  accessKeyId: string;
  /**
   * The lane lease resolveLane reserved. Optional because the injected test
   * doubles predate it; the real resolver always supplies one.
   */
  ownerToken?: string | null;
}

export interface LifecycleChild {
  readonly pid?: number;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'message', listener: (message: unknown) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  off(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: 'message', listener: (message: unknown) => void): this;
}

interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: boolean;
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'];
  windowsHide: true;
}

export interface LifecycleDeps {
  repoRoot?: string;
  artifactsDir?: string;
  resolveLane?: () => Promise<LifecycleLane>;
  spawnChild?: (executable: string, args: string[], options: SpawnOptions) => LifecycleChild;
  isAlive?: (pid: number) => boolean;
  killTree?: (pid: number) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  startupTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  cleanupPollMs?: number;
  ownerPid?: number;
  ownerToken?: () => string;
  processIdentity?: (pid: number) => string | null;
  signal?: AbortSignal;
}

export type LifecycleCleanupResult =
  | { status: 'cleaned'; lane: number }
  | {
      status: 'cleanup_failed';
      reason: 'cleanup_failed';
      lane: number;
      recoveryCommand: typeof RECOVERY_COMMAND;
    };

export interface OwnedHermeticLifecycle {
  readonly childPid: number;
  readonly ownerToken: string;
  readonly lane: number;
  readonly ports: LifecycleLane['ports'];
  readonly tablePrefix: string;
  readonly appBaseUrl: string;
  readonly dashboardBaseUrl: string;
  assertAlive(): void;
  waitForClose(): Promise<void>;
  cleanup(): Promise<LifecycleCleanupResult>;
}

export interface BoundedReadyLineDecoder {
  push(chunk: Uint8Array): void;
  end(): void;
  bufferedChars(): number;
}

export function createBoundedReadyLineDecoder(onReady: () => void): BoundedReadyLineDecoder {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let discarding = false;

  const consume = (text: string): void => {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset);
      if (discarding) {
        if (newline < 0) return;
        discarding = false;
        buffer = '';
        offset = newline + 1;
        continue;
      }

      const end = newline < 0 ? text.length : newline;
      const segment = text.slice(offset, end);
      const remaining = READY_LINE_LIMIT - buffer.length;
      if (segment.length > remaining) {
        buffer += segment.slice(0, remaining);
        discarding = true;
      } else {
        buffer += segment;
      }

      if (newline < 0) return;
      if (!discarding) {
        const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
        if (line.startsWith(READY_PREFIX)) onReady();
      }
      buffer = '';
      discarding = false;
      offset = newline + 1;
    }
  };

  return {
    push(chunk): void {
      consume(decoder.decode(chunk, { stream: true }));
    },
    end(): void {
      consume(decoder.decode());
    },
    bufferedChars(): number {
      return buffer.length;
    },
  };
}

function safeInteger(value: string): number | null {
  const normalized = value.trim();
  if (!/^[1-9][0-9]*$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readPid(path: string): Promise<number | null> {
  try {
    return safeInteger(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactPorts(value: unknown, expected: LifecycleLane['ports']): boolean {
  const ports = object(value);
  return ports !== null
    && ports['app'] === expected.app
    && ports['dashboard'] === expected.dashboard
    && ports['fake'] === expected.fake
    && ports['publicBase'] === expected.publicBase;
}

async function readLaneState(path: string): Promise<Record<string, unknown> | null> {
  try {
    return object(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

function exactLaneState(
  value: Record<string, unknown> | null,
  expected: LifecycleLane,
  launcherPid: number,
): boolean {
  if (value === null) return false;
  return value['launcherPid'] === launcherPid
    && value['lane'] === expected.lane
    && exactPorts(value['ports'], expected.ports)
    && value['tablePrefix'] === expected.tablePrefix;
}

function defaultSpawn(executable: string, args: string[], options: SpawnOptions): LifecycleChild {
  return spawn(executable, args, options) as LifecycleChild;
}

export function ownedLauncherDetached(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

function defaultKillOwnedLauncher(pid: number): void {
  if (process.platform === 'win32') {
    killProcessTree(pid);
    return;
  }
  process.kill(-pid, 'SIGTERM');
}

interface OwnerMarker {
  path: string;
  text: string;
}

function markerRecord(value: unknown): { pid: number; pidIdentity: string } | null {
  const record = object(value);
  return record !== null
    && Number.isSafeInteger(record['pid'])
    && (record['pid'] as number) > 0
    && typeof record['pidIdentity'] === 'string'
    && /^[A-Za-z0-9:._+-]{1,128}$/u.test(record['pidIdentity'])
      ? { pid: record['pid'] as number, pidIdentity: record['pidIdentity'] }
      : null;
}

function defaultProcessIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const command = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p) { $p.CreationDate.ToUniversalTime().ToString("o") }`;
      const value = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
      return /^[A-Za-z0-9:._+-]{1,128}$/u.test(value) ? value : null;
    }
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
      const startTicks = fields[19];
      return startTicks !== undefined && /^[0-9]+$/u.test(startTicks) ? `linux-${startTicks}` : null;
    }
    const value = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim().replace(/\s+/gu, '_');
    return /^[A-Za-z0-9:._+-]{1,128}$/u.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function acquireOwnerMarker(input: {
  artifactsDir: string;
  pid: number;
  isAlive: (pid: number) => boolean;
  processIdentity: (pid: number) => string | null;
}): Promise<OwnerMarker> {
  await mkdir(input.artifactsDir, { recursive: true });
  const path = join(input.artifactsDir, 'performance-session.json');
  const pidIdentity = input.processIdentity(input.pid);
  if (pidIdentity === null) throw new SafeLifecycleError('owner_marker_failed');
  const text = `${JSON.stringify({ pid: input.pid, pidIdentity })}\n`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { path, text };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new SafeLifecycleError('owner_marker_failed');
      }
      let existingText: string;
      try {
        existingText = await readFile(path, 'utf8');
      } catch {
        continue;
      }
      let existing: { pid: number; pidIdentity: string } | null = null;
      try {
        existing = markerRecord(JSON.parse(existingText));
      } catch {
        // Malformed stale state is safe to replace only after compare-before-delete.
      }
      if (existing !== null && input.isAlive(existing.pid)) {
        const liveIdentity = input.processIdentity(existing.pid);
        if (liveIdentity === null || liveIdentity === existing.pidIdentity) {
          throw new SafeLifecycleError('existing_session_live');
        }
      }
      try {
        if (await readFile(path, 'utf8') === existingText) await rm(path);
      } catch {
        // A concurrent marker replacement wins; the next exclusive create decides.
      }
    }
  }
  throw new SafeLifecycleError('owner_marker_failed');
}

async function removeIfMatchingMarker(marker: OwnerMarker): Promise<void> {
  try {
    if (await readFile(marker.path, 'utf8') === marker.text) await rm(marker.path);
  } catch {
    // A concurrent replacement or prior cleanup wins.
  }
}

async function removeIfMatchingPid(path: string, pid: number): Promise<void> {
  if (await readPid(path) !== pid) return;
  try {
    await rm(path);
  } catch {
    // A concurrent state replacement wins; cleanup never broad-deletes.
  }
}

async function removeIfMatchingLane(path: string, lane: number, launcherPid: number): Promise<void> {
  const state = await readLaneState(path);
  if (state?.['lane'] !== lane || state['launcherPid'] !== launcherPid) return;
  try {
    await rm(path);
  } catch {
    // A concurrent state replacement wins; cleanup never broad-deletes.
  }
}

interface CleanupContext {
  pid: number;
  lane: number;
  pidFile: string;
  laneFile: string;
  isAlive: (pid: number) => boolean;
  killTree: (pid: number) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
  marker: OwnerMarker;
}

async function cleanupOwnedChild(input: CleanupContext): Promise<LifecycleCleanupResult> {
  try {
    input.killTree(input.pid);
  } catch {
    // Completion is decided by liveness polling, not the helper's return channel.
  }
  const startedAt = input.now();
  for (;;) {
    let alive = true;
    try {
      alive = input.isAlive(input.pid);
    } catch {
      alive = true;
    }
    if (!alive) {
      await removeIfMatchingPid(input.pidFile, input.pid);
      await removeIfMatchingLane(input.laneFile, input.lane, input.pid);
      await removeIfMatchingMarker(input.marker);
      return { status: 'cleaned', lane: input.lane };
    }
    const elapsed = Math.max(0, input.now() - startedAt);
    if (elapsed >= input.timeoutMs) {
      return {
        status: 'cleanup_failed',
        reason: 'cleanup_failed',
        lane: input.lane,
        recoveryCommand: RECOVERY_COMMAND,
      };
    }
    await input.sleep(Math.min(input.pollMs, input.timeoutMs - elapsed));
  }
}

function waitForReady(child: LifecycleChild, timeoutMs: number, signal?: AbortSignal): {
  ready: Promise<void>;
  closed: Promise<void>;
  isClosed: () => boolean;
} {
  let closed = false;
  let settleClosed!: () => void;
  const closedPromise = new Promise<void>((resolveClosed) => {
    settleClosed = resolveClosed;
  });

  let settleReady!: () => void;
  let failReady!: (error: SafeLifecycleError) => void;
  const readyPromise = new Promise<void>((resolveReady, rejectReady) => {
    settleReady = resolveReady;
    failReady = rejectReady;
  });
  let ready = false;
  const timer = setTimeout(() => {
    if (!ready && !closed) failReady(new SafeLifecycleError('launcher_start_timeout'));
  }, timeoutMs);
  const onAbort = (): void => {
    if (ready || closed) return;
    clearTimeout(timer);
    failReady(new SafeLifecycleError('launcher_interrupted'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted === true) onAbort();
  const onMessage = (message: unknown): void => {
    const value = object(message);
    if (value?.['type'] === 'e2e-session-failed') {
      const reason = value['reason'];
      const allowed = new Set<LifecycleFailureReason>([
        'launcher_failed_before_ready',
        'profiler_existing_session_live',
        'profiler_app_port_occupied',
        'profiler_dashboard_port_occupied',
        'profiler_fake_port_occupied',
        'profiler_public_base_port_occupied',
        'profiler_ping_failed',
        'profiler_commit_identity_mismatch',
        'profiler_owner_identity_mismatch',
        'profiler_ipc_unavailable',
      ]);
      if (typeof reason !== 'string' || !allowed.has(reason as LifecycleFailureReason) || ready || closed) return;
      ready = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      failReady(new SafeLifecycleError(reason as LifecycleFailureReason));
      return;
    }
    if (value?.['type'] !== 'e2e-session-ready') return;
    if (ready || closed) return;
    ready = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    settleReady();
  };
  child.on('message', onMessage);
  child.stdout?.on('data', () => {
    // Deliberately drain and discard every byte through child close.
  });
  child.stderr?.on('data', () => {
    // Deliberately drain and discard every byte through child close.
  });

  const onError = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    settleClosed();
    if (!ready) failReady(new SafeLifecycleError('launcher_spawn_failed'));
  };
  const onClose = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    settleClosed();
    if (!ready) failReady(new SafeLifecycleError('launcher_closed_before_ready'));
  };
  child.on('error', onError);
  child.on('close', onClose);

  return { ready: readyPromise, closed: closedPromise, isClosed: () => closed };
}

export async function startOwnedHermeticLifecycle(
  deps: LifecycleDeps = {},
): Promise<OwnedHermeticLifecycle> {
  const repoRoot = resolve(deps.repoRoot ?? defaultPerformanceRepoRoot());
  const artifactsDir = resolve(deps.artifactsDir ?? join(repoRoot, 'e2e', '.artifacts'));
  const pidFile = join(artifactsDir, 'session.pid');
  const laneFile = join(artifactsDir, 'lane.json');
  const isAlive = deps.isAlive ?? processIsAlive;
  const processIdentity = deps.processIdentity ?? defaultProcessIdentity;
  const killTree = deps.killTree ?? defaultKillOwnedLauncher;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  const ownerToken = deps.ownerToken?.() ?? randomBytes(16).toString('hex');
  if (!/^[a-f0-9]{32}$/u.test(ownerToken)) throw new SafeLifecycleError('owner_marker_failed');
  const marker = await acquireOwnerMarker({
    artifactsDir,
    pid: deps.ownerPid ?? process.pid,
    isAlive,
    processIdentity,
  });
  const existingPid = await readPid(pidFile);
  if (existingPid !== null && isAlive(existingPid)) {
    await removeIfMatchingMarker(marker);
    throw new SafeLifecycleError('existing_session_live');
  }

  let lane: LifecycleLane;
  try {
    lane = await (deps.resolveLane ?? (() => resolveRepositoryLane({ ignoreEnv: true }) as Promise<LifecycleLane>))();
  } catch (error) {
    await removeIfMatchingMarker(marker);
    throw error;
  }
  if (!Number.isSafeInteger(lane.lane) || lane.lane <= 0) {
    await removeIfMatchingMarker(marker);
    throw new SafeLifecycleError('lane_zero_forbidden');
  }
  const spawnChild = deps.spawnChild ?? defaultSpawn;
  let child: LifecycleChild;
  try {
    child = spawnChild(
      process.execPath,
      [join(repoRoot, 'scripts', 'e2e-session.mjs')],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          E2E_LANE: String(lane.lane),
          E2E_PROFILER_OWNER_TOKEN: ownerToken,
          // Same handoff as playwright.config.ts: we reserved the lane lease in
          // THIS process but the session is the long-lived owner, so pass the
          // token down for it to adopt and claim. Distinct from
          // E2E_PROFILER_OWNER_TOKEN, which proves the child app is OURS; this
          // one proves the LANE is ours.
          ...(lane.ownerToken ? { E2E_LANE_TOKEN: lane.ownerToken } : {}),
        },
        detached: ownedLauncherDetached(),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      },
    );
  } catch {
    await removeIfMatchingMarker(marker);
    throw new SafeLifecycleError('launcher_spawn_failed', lane.lane);
  }
  const retainedPid = child.pid;
  if (!Number.isSafeInteger(retainedPid) || (retainedPid ?? 0) <= 0) {
    await removeIfMatchingMarker(marker);
    throw new SafeLifecycleError('launcher_spawn_failed', lane.lane);
  }
  const pid = retainedPid as number;

  const cleanupContext: CleanupContext = {
    pid,
    lane: lane.lane,
    pidFile,
    laneFile,
    isAlive,
    killTree,
    now,
    sleep,
    timeoutMs: deps.cleanupTimeoutMs ?? 10_000,
    pollMs: deps.cleanupPollMs ?? 100,
    marker,
  };
  const childState = waitForReady(child, deps.startupTimeoutMs ?? 300_000, deps.signal);
  try {
    await childState.ready;
    const state = await readLaneState(laneFile);
    if (!exactLaneState(state, lane, pid)) {
      throw new SafeLifecycleError('lane_state_mismatch', lane.lane);
    }
    if (await readPid(pidFile) !== pid) {
      throw new SafeLifecycleError('pid_state_mismatch', lane.lane);
    }
  } catch (error) {
    const cleanup = await cleanupOwnedChild(cleanupContext);
    if (cleanup.status === 'cleanup_failed') {
      throw new SafeLifecycleError('cleanup_failed', lane.lane);
    }
    if (error instanceof SafeLifecycleError) {
      if (error.lane === undefined) throw new SafeLifecycleError(error.reason, lane.lane);
      throw error;
    }
    throw new SafeLifecycleError('launcher_spawn_failed', lane.lane);
  }

  let cleanupPromise: Promise<LifecycleCleanupResult> | null = null;
  return Object.freeze({
    childPid: pid,
    ownerToken,
    lane: lane.lane,
    ports: Object.freeze({ ...lane.ports }),
    tablePrefix: lane.tablePrefix,
    appBaseUrl: `http://127.0.0.1:${lane.ports.app}`,
    dashboardBaseUrl: `http://127.0.0.1:${lane.ports.dashboard}`,
    assertAlive(): void {
      if (childState.isClosed() || !isAlive(pid)) {
        throw new SafeLifecycleError('owned_launcher_reaped', lane.lane);
      }
    },
    waitForClose(): Promise<void> {
      return childState.closed;
    },
    cleanup(): Promise<LifecycleCleanupResult> {
      cleanupPromise ??= cleanupOwnedChild(cleanupContext);
      return cleanupPromise;
    },
  });
}

export interface LifecycleSignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export function installOwnedLifecycleSignalHandlers(
  lifecycle: Pick<OwnedHermeticLifecycle, 'cleanup'>,
  signals: LifecycleSignalSource = process,
  onResult: (result: LifecycleCleanupResult) => void = () => undefined,
): () => void {
  let started = false;
  const handle = (): void => {
    if (started) return;
    started = true;
    void lifecycle.cleanup().then(onResult);
  };
  signals.on('SIGINT', handle);
  signals.on('SIGTERM', handle);
  return () => {
    signals.off('SIGINT', handle);
    signals.off('SIGTERM', handle);
  };
}
