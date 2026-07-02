/**
 * Type declarations for e2e/support/lane.mjs
 *
 * Hand-written to give .ts importers (playwright.config.ts, fixtures, etc.)
 * accurate types without a build step.
 */

/** The four ports allocated to a single e2e lane. */
export interface LanePorts {
  /** Express/Node app server port */
  app: number;
  /** Vite dashboard dev-server port */
  dashboard: number;
  /** Fake-Twilio HTTP server port */
  fake: number;
  /** Public-facing base URL port (for webhook signing) */
  publicBase: number;
}

/** Fully-resolved lane descriptor returned by resolveLane(). */
export interface LaneResult {
  /** Lane number in [1, MAX_LANES] — never 0 */
  lane: number;
  ports: LanePorts;
  /** DynamoDB table prefix, e.g. "hc-local-3-" */
  tablePrefix: string;
  /** S3 / MinIO media bucket name, e.g. "hc-local-media-3" */
  mediaBucket: string;
}

/** Injectable port-availability probe (default: net.createServer bind test). */
export type PortProbe = (port: number, host: string) => Promise<boolean>;

/** Options for resolveLane(). */
export interface ResolveLaneOpts {
  /**
   * Custom port-availability probe. Defaults to a real TCP bind attempt.
   * Inject a mock in tests to simulate held/free ports without binding.
   */
  probe?: PortProbe;
  /**
   * Host to bind the probe on. Defaults to '127.0.0.1'.
   * Must match the host the e2e stack services bind on.
   */
  host?: string;
}

/**
 * Resolve the e2e lane for this worktree.
 *
 * - If E2E_LANE env var is set to a valid integer in [1, MAX_LANES], that
 *   lane is returned directly (no free-probe).
 * - E2E_LANE=0 or out-of-range throws a clear Error.
 * - Otherwise, a stable hash of the worktree identity determines the
 *   preferred lane; the resolver advances to the next free lane if any
 *   port in the preferred lane's block is held.
 * - Throws if all lanes 1..MAX_LANES are busy.
 */
export function resolveLane(opts?: ResolveLaneOpts): Promise<LaneResult>;

/**
 * Default port-availability probe: attempts to bind the port, resolves
 * true if free, false if EADDRINUSE or any other error.
 */
export function defaultProbe(port: number, host: string): Promise<boolean>;

// ---------------------------------------------------------------------------
// Internal exports (for tests)
// ---------------------------------------------------------------------------

export declare const BLOCK_BASE: 9001;
export declare const STRIDE: 100;
export declare const MAX_LANES: 16;

/**
 * Compute the four ports for a given lane (1..MAX_LANES).
 * port = 9001 + lane * 100 + offset
 */
export function portsForLane(lane: number): LanePorts;

/** Map a worktree identity string to a lane number in [1, MAX_LANES]. */
export function hashToLane(identity: string): number;

/** djb2 hash: string → positive integer (Uint32). */
export function djb2(s: string): number;
