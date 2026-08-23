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

import { holdsLane, reserveLane } from './laneLease.mjs';

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
let worktreeIdentityCache;

function worktreeIdentity() {
  // Memoised: testAccessKeyId() is called once per test FILE
  // (app/test/setup/dynamoAccessKey.ts), and shelling out to git ~350 times
  // per run would be pure tax. The answer cannot change inside one process.
  if (worktreeIdentityCache !== undefined) return worktreeIdentityCache;
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const result = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: moduleDir,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    worktreeIdentityCache = result.trim();
  } catch {
    // Fallback: use the module's own resolved directory — stable per install.
    worktreeIdentityCache = path.dirname(fileURLToPath(import.meta.url));
  }
  return worktreeIdentityCache;
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

/**
 * The DynamoDB Local access key for ONE Vitest test FILE - its own database,
 * and therefore its own locks.
 *
 * WHY PER FILE. DynamoDB Local's SQLiteDBAccess carries two locks, and BOTH are
 * private final INSTANCE fields (verified 2026-08-21 by disassembling
 * DynamoDBLocal.jar, not by inference):
 *
 *   rowLockTable : ConcurrentMap<tableName, ReentrantReadWriteLock>
 *   queueLock    : ReentrantReadWriteLock       <- ONE PER DATABASE
 *
 * `LocalDynamoDBRequestHandler.getHandler()` keeps `Map<dbName, ...>` and builds
 * exactly one SQLiteDBAccess per database, where dbName is credential-derived
 * unless -sharedDb is on (ours is off). So a distinct access key means a
 * distinct SQLiteDBAccess, and therefore a disjoint set of lock objects.
 *
 * `beginTransaction()` takes `queueLock.writeLock().lock()` - UNTIMED - and
 * holds it until commit/rollback. Every message this codebase writes goes
 * through a TransactWriteItems (app/src/repos/messagesRepo.ts), so on one shared
 * key every suite's transactions serialise against every other suite's traffic.
 * Ops that then queue behind it blow the 10s `tryLock`
 * (LocalDBAccess.LOCK_WAIT_TIMEOUT_IN_SECONDS) and surface as
 * "InternalServerError: This action timed out because it too long waiting for a
 * lock". A per-worktree key does NOT help: all 53 integration suites in a
 * worktree share it. Their per-suite `hc-test-<uuid>-` prefixes only isolate the
 * OTHER lock (rowLockTable, keyed by table name) and do nothing for queueLock.
 *
 * DETERMINISTIC, NEVER RANDOM. DynamoDB Local can neither enumerate nor drop a
 * database, so a fresh key per RUN would strand one database per run forever
 * (docs/issues/dynamodb-local-cross-worktree-test-contention.md). Hashing the
 * file's stable id bounds the cost at one database per test file.
 *
 * MACHINE-WIDE, NOT PER WORKTREE (changed 2026-08-23). The first version folded
 * worktree identity into the hash, copying testAccessKeyId() reflexively. That
 * multiplied the one resource that never self-heals: a database is ~1.1 MiB of
 * container RSS that no API can ever release (restart is the only reclaim), so
 * per-worktree file keys cost ~50 databases / ~55 MiB for EVERY worktree ever
 * created since the last restart. Hashing only the file id caps the whole
 * machine at one database per test file, permanently.
 *
 * What that trades away: two worktrees running the SAME file at the SAME moment
 * share that one database's queueLock, so their transactions serialise during
 * the overlap - a transient pairwise slowdown, measured far below the failure
 * threshold (one database absorbed 8 sustained transaction writers + 8 put
 * writers with zero failures). What it does NOT trade away is data safety:
 * every unmarked container-writing suite mints a per-run random table prefix
 * (hc-test-<uuid>- and friends), so concurrent runs of one file write disjoint
 * tables - and the residue sweep only deletes on sight when no other vitest
 * run is live machine-wide (app/test/helpers/testRunRegistry.ts), age-gating
 * otherwise. app/test/setup/dynamoAccessKeyGuard.test.ts enforces the naming
 * invariant; do not weaken it without restoring worktree identity here.
 *
 * @param {string} testFileId  stable, normalised repo-relative test file path
 * @returns {string} e.g. "hcf1a2b3c"
 */
export function fileAccessKeyId(testFileId) {
  return `hcf${djb2(testFileId).toString(36)}`;
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
 * @typedef {{ lane: number, ports: { app: number, dashboard: number, fake: number, publicBase: number }, tablePrefix: string, mediaBucket: string, accessKeyId: string, ownerToken: string | null, needsReap: boolean }} LaneResult
 */

/** The real lease, injectable so unit tests never touch the machine registry. */
const defaultLease = { reserve: reserveLane, holds: holdsLane };

/**
 * Build the descriptor for a lane we have taken.
 * @param {number} lane
 * @param {string | null} ownerToken
 * @param {boolean} needsReap
 * @returns {LaneResult}
 */
function laneResult(lane, ownerToken, needsReap) {
  const ports = portsForLane(lane);
  assertNotForbidden(ports, lane);
  return {
    lane,
    ports,
    tablePrefix: `hc-local-${lane}-`,
    mediaBucket: `hc-local-media-${lane}`,
    accessKeyId: laneAccessKeyId(lane),
    ownerToken,
    needsReap,
  };
}

/**
 * Resolve the e2e lane for this worktree.
 *
 * OWNERSHIP IS THE GATE; THE PORT PROBE IS A HINT.
 * -----------------------------------------------
 * This used to select the first lane whose four ports probed FREE. That reads
 * "port busy" as one undifferentiated fact, which has two costs:
 *
 *   1. A lane whose owner died leaves orphans holding its ports. The probe
 *      skips it, run after run, and the lane leaks - nothing ever reclaims it.
 *   2. "Free" was never proof the lane was unowned, so the launcher's
 *      killPort() reap could tree-kill a NEIGHBOURING worktree's live Vite.
 *
 * With a machine-global lease those become two distinguishable cases:
 *
 *   - lease NOT acquirable -> a live owner is working here. Skip, touch nothing.
 *   - lease acquired       -> nobody owns this lane. Any process on its ports
 *                             is provably an orphan, so keep the lane and tell
 *                             the launcher to reap (`needsReap`).
 *
 * See docs/issues/e2e-lane-allocation-cross-worktree-race.md.
 *
 * @param {{
 *   probe?: (port: number, host: string) => Promise<boolean>,
 *   host?: string,
 *   ignoreEnv?: boolean,
 *   lease?: { reserve: (lane: number, opts?: any) => string | null, holds: (lane: number, token: string | null | undefined) => boolean },
 * }=} opts
 * @returns {Promise<LaneResult>}
 */
export async function resolveLane(opts = {}) {
  const probe = opts.probe ?? defaultProbe;
  const host = opts.host ?? '127.0.0.1';
  const lease = opts.lease ?? defaultLease;
  const identity = worktreeIdentity();

  // --- E2E_LANE override ---
  const envLane = opts.ignoreEnv === true ? undefined : process.env['E2E_LANE'];
  if (envLane !== undefined && envLane !== '') {
    const n = Number(envLane);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LANES) {
      throw new Error(
        `E2E_LANE=${envLane} is invalid. ` +
          `Must be an integer in [1, ${MAX_LANES}]. ` +
          `E2E_LANE=0 is explicitly forbidden — lane 0 is the dev stack (ports 8080/5174/8889/5173).`,
      );
    }

    // ADOPT, don't re-reserve. Playwright (and the profiler) resolve the lane in
    // ONE process and boot the session in ANOTHER, handing the token down as
    // E2E_LANE_TOKEN. Re-reserving here would refuse our own parent's lease and
    // wedge the standard `npm run e2e` path.
    // LANE.MJS DESCRIBES; THE LAUNCHER OWNS. A failure to take the lease is
    // reported as `ownerToken: null`, NOT thrown. Playwright re-loads its config
    // in every test WORKER, and each worker re-runs this file purely to learn
    // the lane's ports - a worker must never be able to fail the suite over
    // ownership of a lane its own session legitimately holds. The refusal lives
    // in scripts/e2e-session.mjs, which is the only process that actually boots
    // a stack and therefore the only one that needs to own the lane.
    const inherited = opts.ignoreEnv === true ? undefined : process.env['E2E_LANE_TOKEN'];
    const ownerToken =
      inherited !== undefined && inherited !== '' && lease.holds(n, inherited)
        ? inherited // adopt: our own parent reserved this lane and handed it down
        : lease.reserve(n, { gitDir: identity });
    // Ports may be busy here; we own the lane, so the launcher reaps.
    const needsReap = !(await isLaneFree(n, host, probe));
    return laneResult(n, ownerToken, needsReap);
  }

  // --- Hash-derived preferred lane + ownership walk ---
  const preferred = hashToLane(identity);

  for (let i = 0; i < MAX_LANES; i++) {
    const lane = ((preferred - 1 + i) % MAX_LANES) + 1; // stays in [1..MAX_LANES]
    const ownerToken = lease.reserve(lane, { gitDir: identity });
    if (ownerToken === null) continue; // a live owner holds it - leave them alone
    // We hold the lease, so nothing on these ports has an owner. Busy ports are
    // orphans of a dead run: keep the lane and reap them rather than leaking it.
    const needsReap = !(await isLaneFree(lane, host, probe));
    return laneResult(lane, ownerToken, needsReap);
  }

  throw new Error(
    `e2e lane resolver: all e2e lanes 1..${MAX_LANES} have a LIVE owner on this machine. ` +
      `Stop a running stack (npm run e2e:stop in that worktree) or wait for one to finish. ` +
      `Held lanes are listed under the lease directory; a lane whose owner died is reclaimed automatically.`,
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
