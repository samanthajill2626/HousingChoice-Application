/**
 * e2e/support/laneLease.mjs - machine-global arbitration for e2e port lanes.
 *
 * Pure ESM, no TypeScript, no build step. Imported by lane.mjs (reserve) and
 * scripts/e2e-session.mjs (claim/release).
 *
 * WHY THIS IS NOT IN e2e/.artifacts/
 * ----------------------------------
 * `e2e/.artifacts/lane.json` and `session.pid` are repoRoot-relative, so they
 * are PER-WORKTREE. They can describe your own session and are structurally
 * incapable of arbitrating between two worktrees. A lane is a set of TCP
 * ports - a machine-global resource - so its registry has to be machine-global
 * too. Hence os.tmpdir().
 *
 * THE TWO-PHASE SHAPE, AND WHY IT IS NOT ONE PHASE
 * ------------------------------------------------
 * Nobody holds a lane in the process that resolves it. BOTH callers spawn
 * lane.mjs as a short-lived child and read its stdout:
 *   - e2e/playwright.config.ts  (execFileSync at config load)
 *   - scripts/e2e-session.mjs   (execFileSync at startup)
 * The resolver process exits immediately. A lease stamped with its pid would
 * be stale by pid-liveness the moment it was written, and the next probe would
 * reclaim it from its rightful owner - handing two worktrees the same lane,
 * which is the exact bug the lease exists to prevent.
 *
 * So: RESERVE (resolver, ephemeral pid, grace-window staleness) then CLAIM
 * (launcher, long-lived pid, pid-liveness staleness). The owner token is what
 * ties the two together, and it travels resolver stdout -> E2E_LANE_TOKEN.
 *
 * See docs/issues/e2e-lane-allocation-cross-worktree-race.md.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where the per-lane records live. One file per lane, machine-global. */
export const LEASE_DIR = path.join(os.tmpdir(), 'hc-e2e-lanes');

/**
 * How long a RESERVED (not yet claimed) lease is honoured before a dead
 * reserver makes it reclaimable.
 *
 * Floor is the gap between reserve and claim on the slowest path: Playwright
 * resolves the lane at config load, then boots the session under
 * `webServer.timeout` (180_000, e2e/playwright.config.ts). A window tighter
 * than that lets a second worktree steal a lane out from under a session that
 * is still legitimately booting.
 */
export const RESERVE_GRACE_MS = 240_000;

/** Backstop for a HELD lease whose pid was recycled by the OS. */
export const HELD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const TOKEN_PATTERN = /^[a-f0-9]{32}$/u;

/** @returns {string} a fresh 32-hex owner token (same shape as profilerOwnership). */
export function newOwnerToken() {
  return randomBytes(16).toString('hex');
}

/**
 * Validate an owner token, or throw. Mirrors profilerOwnership.profilerOwnerToken.
 * @param {unknown} value
 * @returns {string}
 */
export function assertOwnerToken(value) {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    throw new Error('lane_lease_token_invalid');
  }
  return value;
}

/**
 * @param {number} lane
 * @returns {string} absolute path to that lane's record
 */
export function leasePathFor(lane) {
  return path.join(LEASE_DIR, `lane-${lane}.json`);
}

/**
 * Is a pid alive? `kill(pid, 0)` throws ESRCH when it is not.
 * EPERM means it exists but belongs to someone else - alive for our purposes.
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM';
  }
}

/**
 * Read a lease record.
 *
 * Returns null ONLY when the file is absent. A present-but-unparseable file
 * comes back as `{ raw, record: null }` - deliberately, so the caller still has
 * the raw bytes to compare-before-delete against. Collapsing "corrupt" into
 * "absent" here would wedge the lane forever: the exclusive create would keep
 * failing with EEXIST while the reclaim path had nothing to compare on.
 * A half-written file must never cost a lane permanently.
 * @param {number} lane
 * @returns {{ raw: string, record: any } | null}
 */
export function readLease(lane) {
  const file = leasePathFor(lane);
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return { raw, record: JSON.parse(raw) };
  } catch {
    return { raw, record: null };
  }
}

/**
 * Is this record reclaimable - i.e. is its owner demonstrably gone?
 *
 * `held`     -> the launcher pid is dead (or the record is absurdly old).
 * `reserved` -> the resolver pid is dead AND the grace window has passed. The
 *               pid check alone is useless here: the resolver is EXPECTED to
 *               have exited, which is the whole reason the grace window exists.
 * @param {any} record
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isReclaimable(record, nowMs) {
  if (record === null || typeof record !== 'object') return true;
  if (record.state === 'held') {
    if (pidAlive(record.pid)) return false;
    return true;
  }
  if (record.state === 'reserved') {
    const reservedAt = Date.parse(record.reservedAt ?? '');
    if (Number.isNaN(reservedAt)) return true;
    if (pidAlive(record.reservedByPid) && nowMs - reservedAt < RESERVE_GRACE_MS) return false;
    return nowMs - reservedAt >= RESERVE_GRACE_MS;
  }
  // Unknown state - a future version's record, or garbage. Do NOT steal it.
  return false;
}

/**
 * Age out a HELD record whose pid was recycled onto an unrelated process.
 * @param {any} record
 * @param {number} nowMs
 * @returns {boolean}
 */
function heldTooLong(record, nowMs) {
  if (record?.state !== 'held') return false;
  const at = Date.parse(record.claimedAt ?? record.reservedAt ?? '');
  return !Number.isNaN(at) && nowMs - at >= HELD_MAX_AGE_MS;
}

/**
 * COMPARE-BEFORE-DELETE removal. Re-reads the record and unlinks only if it is
 * byte-identical to what the caller saw. The same idiom scripts/e2e-stop.mjs
 * already uses for session.pid / lane.json: between our decision to reclaim and
 * the unlink, the rightful owner may have rewritten it.
 * @param {number} lane
 * @param {string} expectedRaw
 * @returns {boolean} true if we removed it
 */
export function removeIfUnchanged(lane, expectedRaw) {
  const file = leasePathFor(lane);
  try {
    if (readFileSync(file, 'utf8') !== expectedRaw) return false;
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Phase 1 - RESERVE a lane, atomically.
 *
 * `flag: 'wx'` is an exclusive create: it fails with EEXIST rather than
 * truncating, on both Windows and POSIX. That single syscall is the mutual
 * exclusion; everything else here is staleness policy.
 *
 * @param {number} lane
 * @param {{ gitDir?: string, ownerToken?: string, nowMs?: number }=} opts
 * @returns {string | null} the owner token on success, null if someone else holds it
 */
export function reserveLane(lane, opts = {}) {
  const ownerToken = opts.ownerToken ?? newOwnerToken();
  const nowMs = opts.nowMs ?? Date.now();
  mkdirSync(LEASE_DIR, { recursive: true });

  const body = JSON.stringify(
    {
      version: 1,
      lane,
      ownerToken,
      state: 'reserved',
      reservedByPid: process.pid,
      reservedAt: new Date(nowMs).toISOString(),
      gitDir: opts.gitDir ?? null,
    },
    null,
    2,
  );

  try {
    writeFileSync(leasePathFor(lane), body, { flag: 'wx' });
    return ownerToken;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
  }

  // Occupied. Reclaim ONLY if the holder is demonstrably gone, and only via
  // compare-before-delete so we never unlink a record that changed under us.
  const existing = readLease(lane);
  if (existing === null) {
    // Vanished between the failed create and this read. One retry; if that also
    // loses, treat the lane as taken rather than looping.
    try {
      writeFileSync(leasePathFor(lane), body, { flag: 'wx' });
      return ownerToken;
    } catch {
      return null;
    }
  }

  // `record: null` means the file is present but unparseable. isReclaimable
  // says true for that, so the compare-before-delete below clears it and we
  // retry - a corrupt record costs one reclaim, not the lane.
  if (!isReclaimable(existing.record, nowMs) && !heldTooLong(existing.record, nowMs)) return null;
  if (!removeIfUnchanged(lane, existing.raw)) return null;

  try {
    writeFileSync(leasePathFor(lane), body, { flag: 'wx' });
    return ownerToken;
  } catch {
    return null;
  }
}

/**
 * Phase 2 - CLAIM a reserved lane for a long-lived process.
 *
 * Rewrites the record to `held` with THIS process's pid, but only when the
 * on-disk token matches the one handed to us. A mismatch means the lease was
 * reclaimed and re-reserved by someone else while we were booting, and
 * proceeding would put two stacks on one lane.
 *
 * Re-entrant by design: claiming a lease this process already holds is a no-op
 * success, so the Playwright -> session handoff can call it more than once.
 *
 * @param {number} lane
 * @param {string} ownerToken
 * @param {{ nowMs?: number, appCommit?: string | null }=} opts
 * @returns {boolean} true if we now hold it
 */
export function claimLane(lane, ownerToken, opts = {}) {
  assertOwnerToken(ownerToken);
  const existing = readLease(lane);
  if (existing === null) return false;
  if (existing.record?.ownerToken !== ownerToken) return false;
  if (existing.record.state === 'held' && existing.record.pid === process.pid) return true;

  const nowMs = opts.nowMs ?? Date.now();
  const body = JSON.stringify(
    {
      ...existing.record,
      state: 'held',
      pid: process.pid,
      claimedAt: new Date(nowMs).toISOString(),
      appCommit: opts.appCommit ?? existing.record.appCommit ?? null,
    },
    null,
    2,
  );
  try {
    writeFileSync(leasePathFor(lane), body);
    return true;
  } catch {
    return false;
  }
}

/**
 * Do we currently hold this lane under this token? The gate for anything
 * destructive - reaping a port, dropping a lane's tables.
 * @param {number} lane
 * @param {string | null | undefined} ownerToken
 * @returns {boolean}
 */
export function holdsLane(lane, ownerToken) {
  if (typeof ownerToken !== 'string' || !TOKEN_PATTERN.test(ownerToken)) return false;
  const existing = readLease(lane);
  return existing !== null && existing.record?.ownerToken === ownerToken;
}

/**
 * Release a lane we hold. Compare-before-delete on the TOKEN, so a release can
 * never remove a lease that now belongs to someone else.
 * @param {number} lane
 * @param {string | null | undefined} ownerToken
 * @returns {boolean} true if we removed it
 */
export function releaseLane(lane, ownerToken) {
  if (typeof ownerToken !== 'string' || !TOKEN_PATTERN.test(ownerToken)) return false;
  const existing = readLease(lane);
  if (existing === null || existing.record?.ownerToken !== ownerToken) return false;
  return removeIfUnchanged(lane, existing.raw);
}

// NOTE: an earlier draft carried stampSchemaHash/readSchemaHash here, to let a
// boot detect that a lane's tables predated a GSI change. They were removed
// unused: the repo already ships `db:update-gsis`, which diffs each live table
// against its TableSpec and adds only what is missing, with no data loss. The
// stale-lane fix is to CALL that in the e2e boot path (scripts/e2e-session.mjs)
// - a fingerprint cache in front of it would add a second source of truth about
// schema currency, and the one that can be wrong.
