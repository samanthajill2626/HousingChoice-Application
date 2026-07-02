/**
 * e2e/support/lane.mjs — Port-lane resolver for the e2e hermetic stack.
 *
 * Pure ESM, no TypeScript syntax, no build step. Runs directly under Node.
 * CLI mode: `node e2e/support/lane.mjs` prints the resolved lane as JSON
 * (playwright.config.ts calls this via execSync as the sync bridge).
 *
 * Port scheme (BLOCK_BASE=9001, STRIDE=100):
 *   port = 9001 + L*100 + offset
 *   app      = +0
 *   dashboard = +10
 *   fake     = +20
 *   publicBase = +30
 *
 * Lane 0 = dev (8080/5174/8889/5173) — never returned by resolveLane.
 * Lanes 1..16 (MAX_LANES) are e2e lanes.
 */

import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BLOCK_BASE = 9001;
const STRIDE = 100;
const MAX_LANES = 16;

/** Offsets within a lane block */
const OFFSET_APP = 0;
const OFFSET_DASHBOARD = 10;
const OFFSET_FAKE = 20;
const OFFSET_PUBLIC_BASE = 30;

/** Ports that must NEVER appear in a resolved block (lane 0 + infra). */
const FORBIDDEN_PORTS = new Set([8080, 5174, 8889, 5173, 8000, 9000]);

// ---------------------------------------------------------------------------
// Port arithmetic
// ---------------------------------------------------------------------------

/**
 * Compute the four ports for a given lane (1..MAX_LANES).
 * @param {number} lane
 * @returns {{ app: number, dashboard: number, fake: number, publicBase: number }}
 */
function portsForLane(lane) {
  const base = BLOCK_BASE + lane * STRIDE;
  return {
    app: base + OFFSET_APP,
    dashboard: base + OFFSET_DASHBOARD,
    fake: base + OFFSET_FAKE,
    publicBase: base + OFFSET_PUBLIC_BASE,
  };
}

/**
 * Guard: assert none of the computed ports are in the forbidden set.
 * This should never fire given the scheme, but a regression is better
 * caught loudly than silently.
 * @param {{ app: number, dashboard: number, fake: number, publicBase: number }} ports
 * @param {number} lane
 */
function assertNotForbidden(ports, lane) {
  for (const [name, port] of Object.entries(ports)) {
    if (FORBIDDEN_PORTS.has(port)) {
      throw new Error(
        `lane.mjs: port scheme regression — lane ${lane} ${name} port ${port} ` +
          `collides with a forbidden port (${[...FORBIDDEN_PORTS].join(', ')}). ` +
          `This is a bug in the port-scheme constants.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Deterministic hash  →  preferred lane [1..MAX_LANES]
// ---------------------------------------------------------------------------

/**
 * djb2 hash of a string → positive integer.
 * Simple, deterministic, no dependencies.
 * @param {string} s
 * @returns {number}
 */
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    // Use unsigned right-shift to keep positive; >>> 0 coerces to Uint32.
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Derive the worktree identity string used for lane hashing.
 * Primary: `git rev-parse --git-common-dir` (stable for worktrees of the
 *   same repo — each worktree has a distinct .git file pointing to a unique
 *   gitdir, but --git-common-dir returns the shared object store path, which
 *   is common to all worktrees of the same repo; however, for a worktree,
 *   `--absolute-git-dir` gives the WORKTREE-specific gitdir).
 *
 * We want worktree-specific identity (two worktrees of the same repo need
 * different lanes), so we use `--absolute-git-dir` which returns the
 * per-worktree gitdir (e.g. .git/worktrees/feat-xxx).
 *
 * Fallback: the abs path of this file's directory (still deterministic
 * across calls for the same checkout).
 * @returns {string}
 */
function worktreeIdentity() {
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const result = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: moduleDir,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return result.trim();
  } catch {
    // Fallback: use the module's own resolved directory — stable per install.
    return path.dirname(fileURLToPath(import.meta.url));
  }
}

/**
 * Map a worktree identity string to a lane in [1..MAX_LANES].
 * @param {string} identity
 * @returns {number} lane in [1..MAX_LANES]
 */
function hashToLane(identity) {
  const h = djb2(identity);
  // Map to [0, MAX_LANES-1] then shift to [1, MAX_LANES]
  return (h % MAX_LANES) + 1;
}

// ---------------------------------------------------------------------------
// Per-lane / per-worktree DynamoDB Local access keys
// ---------------------------------------------------------------------------
// Without -sharedDb, DynamoDB Local keeps a SEPARATE database (and SQLite
// write lock) per (accessKeyId, region) pair — that is the whole isolation
// mechanism (docs/issues/dynamodb-local-cross-worktree-test-contention.md).
// Keys MUST be alphanumeric: once -sharedDb is off the key is validated and
// '-' or '_' raise UnrecognizedClientException (verified 2026-07-02 against a
// throwaway container). Lane 0 (npm run dev -- --local) is NOT named here —
// it rides the 'local' credential fallback in app/src/lib/dynamo.ts.

/**
 * The DynamoDB Local access key for an e2e lane — its own local database.
 * @param {number} lane
 * @returns {string} e.g. "hclane3"
 */
export function laneAccessKeyId(lane) {
  return `hclane${lane}`;
}

/**
 * The DynamoDB Local access key for THIS worktree's Vitest integration runs —
 * isolated from every e2e lane (different prefix) and from other worktrees
 * (identity-hashed). Deterministic per worktree, alphanumeric (base36).
 * @returns {string} e.g. "hctest1a2b3c"
 */
export function testAccessKeyId() {
  return `hctest${djb2(worktreeIdentity()).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Free-probe
// ---------------------------------------------------------------------------

/**
 * Check whether a single TCP port on the given host is available (not bound).
 * Injectable for testing — you can pass a different probe function.
 * @param {number} port
 * @param {string} host
 * @returns {Promise<boolean>} true if the port is free
 */
export function defaultProbe(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EADDRINUSE') {
        resolve(false);
      } else {
        // Any other error (EACCES, etc.) — treat as occupied to be safe.
        resolve(false);
      }
    });
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Check whether ALL four ports in a lane block are free.
 * @param {number} lane
 * @param {string} host
 * @param {(port: number, host: string) => Promise<boolean>} probe
 * @returns {Promise<boolean>}
 */
async function isLaneFree(lane, host, probe) {
  const ports = portsForLane(lane);
  const results = await Promise.all(
    Object.values(ports).map((p) => probe(p, host)),
  );
  return results.every(Boolean);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {{ lane: number, ports: { app: number, dashboard: number, fake: number, publicBase: number }, tablePrefix: string, mediaBucket: string, accessKeyId: string }} LaneResult
 */

/**
 * Resolve the e2e lane for this worktree.
 *
 * @param {{
 *   probe?: (port: number, host: string) => Promise<boolean>,
 *   host?: string,
 * }=} opts
 * @returns {Promise<LaneResult>}
 */
export async function resolveLane(opts = {}) {
  const probe = opts.probe ?? defaultProbe;
  const host = opts.host ?? '127.0.0.1';

  // --- E2E_LANE override ---
  const envLane = process.env['E2E_LANE'];
  if (envLane !== undefined && envLane !== '') {
    const n = Number(envLane);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LANES) {
      throw new Error(
        `E2E_LANE=${envLane} is invalid. ` +
          `Must be an integer in [1, ${MAX_LANES}]. ` +
          `E2E_LANE=0 is explicitly forbidden — lane 0 is the dev stack (ports 8080/5174/8889/5173).`,
      );
    }
    const ports = portsForLane(n);
    assertNotForbidden(ports, n);
    return {
      lane: n,
      ports,
      tablePrefix: `hc-local-${n}-`,
      mediaBucket: `hc-local-media-${n}`,
      accessKeyId: laneAccessKeyId(n),
    };
  }

  // --- Hash-derived preferred lane + free-probe ---
  const identity = worktreeIdentity();
  const preferred = hashToLane(identity);

  // Walk from preferred lane, wrapping around, until we find a free one.
  for (let i = 0; i < MAX_LANES; i++) {
    const lane = ((preferred - 1 + i) % MAX_LANES) + 1; // stays in [1..MAX_LANES]
    if (await isLaneFree(lane, host, probe)) {
      const ports = portsForLane(lane);
      assertNotForbidden(ports, lane);
      return {
        lane,
        ports,
        tablePrefix: `hc-local-${lane}-`,
        mediaBucket: `hc-local-media-${lane}`,
        accessKeyId: laneAccessKeyId(lane),
      };
    }
  }

  throw new Error(
    `e2e lane resolver: all e2e lanes 1..${MAX_LANES} are busy — every lane has at least one port held. ` +
      `Free a running stack (npm run e2e:stop) or explicitly pick a lane with E2E_LANE=<n> (1..${MAX_LANES}).`,
  );
}

// ---------------------------------------------------------------------------
// Exports for introspection (also used by tests)
// ---------------------------------------------------------------------------

export { BLOCK_BASE, STRIDE, MAX_LANES, portsForLane, hashToLane, djb2 };

// ---------------------------------------------------------------------------
// CLI mode — `node e2e/support/lane.mjs` prints JSON to stdout
// ---------------------------------------------------------------------------

// Detect direct invocation: compare the resolved URL of this module against
// process.argv[1] (normalized to a file URL for cross-platform safety).
const moduleUrl = import.meta.url;
let argvUrl;
try {
  // argv[1] may be a path or already a URL; normalize to a file URL string.
  argvUrl = process.argv[1]
    ? new URL(
        process.argv[1].startsWith('file:')
          ? process.argv[1]
          : `file:///${process.argv[1].replace(/\\/g, '/')}`,
      ).href
    : undefined;
} catch {
  argvUrl = undefined;
}

if (argvUrl && moduleUrl === argvUrl) {
  resolveLane()
    .then((result) => {
      process.stdout.write(JSON.stringify(result) + '\n');
    })
    .catch((err) => {
      process.stderr.write(`lane.mjs: ${err.message}\n`);
      process.exit(1);
    });
}
