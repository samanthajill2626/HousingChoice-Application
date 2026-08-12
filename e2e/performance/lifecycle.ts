import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { resolveLane as resolveRepositoryLane } from '../support/lane.mjs';
import { isAlive as processIsAlive, killTree as killProcessTree } from '../../scripts/lib/killTree.mjs';

const READY_PREFIX = '[e2e-session] ready';
const READY_LINE_LIMIT = 4_096;
const RECOVERY_COMMAND = 'npm run e2e:stop';

export type LifecycleFailureReason =
  | 'existing_session_live'
  | 'lane_zero_forbidden'
  | 'launcher_spawn_failed'
  | 'launcher_closed_before_ready'
  | 'launcher_start_timeout'
  | 'lane_state_mismatch'
  | 'pid_state_mismatch'
  | 'owned_launcher_reaped'
  | 'cleanup_failed';

export class SafeLifecycleError extends Error {
  readonly reason: LifecycleFailureReason;
  readonly lane?: number;
  readonly recoveryCommand?: typeof RECOVERY_COMMAND;

  constructor(reason: LifecycleFailureReason, lane?: number) {
    super(reason);
    this.name = 'SafeLifecycleError';
    this.stack = undefined;
    this.reason = reason;
    if (lane !== undefined) this.lane = lane;
    if (reason === 'cleanup_failed') this.recoveryCommand = RECOVERY_COMMAND;
  }

  toJSON(): { reason: LifecycleFailureReason; lane?: number; recoveryCommand?: typeof RECOVERY_COMMAND } {
    return {
      reason: this.reason,
      ...(this.lane !== undefined && { lane: this.lane }),
      ...(this.recoveryCommand !== undefined && { recoveryCommand: this.recoveryCommand }),
    };
  }
}

export interface LifecycleLane {
  lane: number;
  ports: { app: number; dashboard: number; fake: number; publicBase: number };
  tablePrefix: string;
  mediaBucket: string;
  accessKeyId: string;
}

export interface LifecycleChild {
  readonly pid?: number;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  off(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: false;
  stdio: ['ignore', 'pipe', 'pipe'];
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

function exactLaneState(value: Record<string, unknown> | null, expected: LifecycleLane): boolean {
  if (value === null) return false;
  return value['lane'] === expected.lane
    && exactPorts(value['ports'], expected.ports)
    && value['tablePrefix'] === expected.tablePrefix;
}

function defaultSpawn(executable: string, args: string[], options: SpawnOptions): LifecycleChild {
  return spawn(executable, args, options) as LifecycleChild;
}

async function removeIfMatchingPid(path: string, pid: number): Promise<void> {
  if (await readPid(path) !== pid) return;
  try {
    await rm(path);
  } catch {
    // A concurrent state replacement wins; cleanup never broad-deletes.
  }
}

async function removeIfMatchingLane(path: string, lane: number): Promise<void> {
  const state = await readLaneState(path);
  if (state?.['lane'] !== lane) return;
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
      await removeIfMatchingLane(input.laneFile, input.lane);
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

function waitForReady(child: LifecycleChild, timeoutMs: number): {
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
  const decoder = createBoundedReadyLineDecoder(() => {
    if (ready || closed) return;
    ready = true;
    clearTimeout(timer);
    settleReady();
  });
  child.stdout?.on('data', (chunk: Buffer | Uint8Array | string) => {
    decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  });
  child.stdout?.on('end', () => decoder.end());
  child.stderr?.on('data', () => {
    // Deliberately drain and discard every byte through child close.
  });

  const onError = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    settleClosed();
    if (!ready) failReady(new SafeLifecycleError('launcher_spawn_failed'));
  };
  const onClose = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
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
  const repoRoot = resolve(deps.repoRoot ?? process.cwd());
  const artifactsDir = resolve(deps.artifactsDir ?? join(repoRoot, 'e2e', '.artifacts'));
  const pidFile = join(artifactsDir, 'session.pid');
  const laneFile = join(artifactsDir, 'lane.json');
  const isAlive = deps.isAlive ?? processIsAlive;
  const killTree = deps.killTree ?? killProcessTree;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  const existingPid = await readPid(pidFile);
  if (existingPid !== null && isAlive(existingPid)) {
    throw new SafeLifecycleError('existing_session_live');
  }

  const lane = await (deps.resolveLane ?? (() => resolveRepositoryLane() as Promise<LifecycleLane>))();
  if (!Number.isSafeInteger(lane.lane) || lane.lane <= 0) {
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
        env: { ...process.env, E2E_LANE: String(lane.lane) },
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
  } catch {
    throw new SafeLifecycleError('launcher_spawn_failed', lane.lane);
  }
  const retainedPid = child.pid;
  if (!Number.isSafeInteger(retainedPid) || (retainedPid ?? 0) <= 0) {
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
  };
  const childState = waitForReady(child, deps.startupTimeoutMs ?? 300_000);
  try {
    await childState.ready;
    const state = await readLaneState(laneFile);
    if (!exactLaneState(state, lane)) {
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
