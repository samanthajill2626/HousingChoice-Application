import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LEASE_DIR,
  RESERVE_GRACE_MS,
  claimLane,
  holdsLane,
  isReclaimable,
  leasePathFor,
  newOwnerToken,
  readLease,
  readSchemaHash,
  releaseLane,
  reserveLane,
  stampSchemaHash,
} from './laneLease.mjs';

// These tests exercise the REAL filesystem, deliberately: the mutual exclusion
// being tested IS `writeFileSync(..., { flag: 'wx' })`, and a mocked fs would
// test the mock. They use lane numbers far outside the real 1..16 range, so
// they can never collide with a live session on this machine.
const TEST_LANE_BASE = 900;
let nextLane = TEST_LANE_BASE;
const touched = new Set<number>();

function freshLane(): number {
  const lane = nextLane++;
  touched.add(lane);
  return lane;
}

/** A pid that is definitely dead: spawn something trivial and let it exit. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  if (typeof result.pid !== 'number') throw new Error('could not obtain a dead pid');
  return result.pid;
}

function writeRecord(lane: number, record: unknown): string {
  mkdirSync(LEASE_DIR, { recursive: true });
  const raw = JSON.stringify(record, null, 2);
  writeFileSync(leasePathFor(lane), raw);
  return raw;
}

afterEach(() => {
  for (const lane of touched) rmSync(leasePathFor(lane), { force: true });
  touched.clear();
});

describe('laneLease - reserve', () => {
  it('reserves a free lane and returns a 32-hex owner token', () => {
    const lane = freshLane();
    const token = reserveLane(lane);
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    const lease = readLease(lane);
    expect(lease?.record.state).toBe('reserved');
    expect(lease?.record.reservedByPid).toBe(process.pid);
  });

  it('REFUSES a lane already reserved by a live process - the whole point', () => {
    const lane = freshLane();
    expect(reserveLane(lane)).not.toBeNull();
    // Same pid, inside the grace window: the first reservation still stands.
    expect(reserveLane(lane)).toBeNull();
  });

  it('refuses a lane HELD by a live launcher', () => {
    const lane = freshLane();
    writeRecord(lane, {
      version: 1,
      lane,
      ownerToken: newOwnerToken(),
      state: 'held',
      pid: process.pid,
      claimedAt: new Date().toISOString(),
    });
    expect(reserveLane(lane)).toBeNull();
  });

  it('reclaims a lane HELD by a dead launcher', () => {
    const lane = freshLane();
    writeRecord(lane, {
      version: 1,
      lane,
      ownerToken: newOwnerToken(),
      state: 'held',
      pid: deadPid(),
      claimedAt: new Date().toISOString(),
    });
    expect(reserveLane(lane)).not.toBeNull();
    expect(readLease(lane)?.record.reservedByPid).toBe(process.pid);
  });

  it('does NOT reclaim a reserved lane inside the grace window, even with a dead reserver', () => {
    // This is the regression that matters: the resolver process is EXPECTED to
    // exit immediately (playwright.config.ts and e2e-session.mjs both spawn
    // lane.mjs as a short-lived child), so a pid check alone would let the next
    // probe steal a lane out from under a session that is still booting.
    const lane = freshLane();
    writeRecord(lane, {
      version: 1,
      lane,
      ownerToken: newOwnerToken(),
      state: 'reserved',
      reservedByPid: deadPid(),
      reservedAt: new Date().toISOString(),
    });
    expect(reserveLane(lane)).toBeNull();
  });

  it('reclaims a reserved lane once the grace window has passed', () => {
    const lane = freshLane();
    const stale = new Date(Date.now() - RESERVE_GRACE_MS - 1_000).toISOString();
    writeRecord(lane, {
      version: 1,
      lane,
      ownerToken: newOwnerToken(),
      state: 'reserved',
      reservedByPid: deadPid(),
      reservedAt: stale,
    });
    expect(reserveLane(lane)).not.toBeNull();
  });

  it('leaves an unknown-state record alone rather than stealing it', () => {
    // Forward compatibility: a record written by a newer version must not be
    // treated as garbage to be reclaimed.
    const lane = freshLane();
    writeRecord(lane, { version: 99, lane, ownerToken: newOwnerToken(), state: 'quiesced' });
    expect(reserveLane(lane)).toBeNull();
  });

  it('treats a corrupt record as absent rather than wedging the lane forever', () => {
    const lane = freshLane();
    mkdirSync(LEASE_DIR, { recursive: true });
    writeFileSync(leasePathFor(lane), '{ not json');
    expect(reserveLane(lane)).not.toBeNull();
  });
});

describe('laneLease - claim', () => {
  it('flips a reservation to held with the claiming pid', () => {
    const lane = freshLane();
    const token = reserveLane(lane)!;
    expect(claimLane(lane, token, { appCommit: 'abc1234' })).toBe(true);
    const lease = readLease(lane);
    expect(lease?.record.state).toBe('held');
    expect(lease?.record.pid).toBe(process.pid);
    expect(lease?.record.appCommit).toBe('abc1234');
    // The token survives the transition - it is what release compares on.
    expect(lease?.record.ownerToken).toBe(token);
  });

  it('refuses a token that does not match the record', () => {
    const lane = freshLane();
    reserveLane(lane);
    expect(claimLane(lane, newOwnerToken())).toBe(false);
    expect(readLease(lane)?.record.state).toBe('reserved');
  });

  it('is re-entrant, so the Playwright -> session handoff can claim twice', () => {
    const lane = freshLane();
    const token = reserveLane(lane)!;
    expect(claimLane(lane, token)).toBe(true);
    expect(claimLane(lane, token)).toBe(true);
  });

  it('refuses to claim a lane with no record at all', () => {
    expect(claimLane(freshLane(), newOwnerToken())).toBe(false);
  });

  it('rejects a malformed token loudly', () => {
    expect(() => claimLane(freshLane(), 'nope')).toThrow('lane_lease_token_invalid');
  });
});

describe('laneLease - hold and release', () => {
  it('holdsLane answers true only for the real token', () => {
    const lane = freshLane();
    const token = reserveLane(lane)!;
    expect(holdsLane(lane, token)).toBe(true);
    expect(holdsLane(lane, newOwnerToken())).toBe(false);
    expect(holdsLane(lane, undefined)).toBe(false);
  });

  it('release removes only our own lease', () => {
    const lane = freshLane();
    const token = reserveLane(lane)!;
    expect(releaseLane(lane, newOwnerToken())).toBe(false);
    expect(existsSync(leasePathFor(lane))).toBe(true);
    expect(releaseLane(lane, token)).toBe(true);
    expect(existsSync(leasePathFor(lane))).toBe(false);
  });

  it('releases on the TOKEN, not on the exact bytes we wrote', () => {
    // The token is the ownership proof, and the record legitimately changes
    // shape under us: reserve -> claim rewrites state/pid/claimedAt, and
    // stampSchemaHash rewrites it again. A release that compared whole bytes
    // against what reserve wrote could never release a lane that was claimed,
    // which is every real lane.
    const lane = freshLane();
    const token = reserveLane(lane)!;
    claimLane(lane, token);
    stampSchemaHash(lane, token, 'sha-9999');
    expect(JSON.parse(readFileSync(leasePathFor(lane), 'utf8')).ownerToken).toBe(token);
    expect(releaseLane(lane, token)).toBe(true);
    expect(existsSync(leasePathFor(lane))).toBe(false);
  });

  it('will not release a lane that was reclaimed and re-reserved by someone else', () => {
    // The real hazard the token guards against: our lease went stale, another
    // worktree took the lane, and our late shutdown must not free THEIR lane.
    const lane = freshLane();
    const ourToken = reserveLane(lane)!;
    releaseLane(lane, ourToken);
    const theirToken = reserveLane(lane)!;
    expect(theirToken).not.toBe(ourToken);
    expect(releaseLane(lane, ourToken)).toBe(false);
    expect(existsSync(leasePathFor(lane))).toBe(true);
    expect(holdsLane(lane, theirToken)).toBe(true);
  });
});

describe('laneLease - schema fingerprint', () => {
  it('round-trips a schema hash for the lease holder', () => {
    const lane = freshLane();
    const token = reserveLane(lane)!;
    expect(readSchemaHash(lane)).toBeNull();
    expect(stampSchemaHash(lane, token, 'sha-1234')).toBe(true);
    expect(readSchemaHash(lane)).toBe('sha-1234');
  });

  it('refuses to stamp a lane we do not hold', () => {
    const lane = freshLane();
    reserveLane(lane);
    expect(stampSchemaHash(lane, newOwnerToken(), 'sha-1234')).toBe(false);
    expect(readSchemaHash(lane)).toBeNull();
  });
});

describe('laneLease - isReclaimable policy', () => {
  const now = Date.parse('2026-08-21T12:00:00.000Z');

  it('treats a null record as reclaimable', () => {
    expect(isReclaimable(null, now)).toBe(true);
  });

  it('holds a reserved record whose reserver is alive and recent', () => {
    expect(
      isReclaimable(
        { state: 'reserved', reservedByPid: process.pid, reservedAt: new Date(now).toISOString() },
        now,
      ),
    ).toBe(false);
  });

  it('reclaims a reserved record with an unparseable timestamp', () => {
    expect(isReclaimable({ state: 'reserved', reservedByPid: process.pid, reservedAt: 'x' }, now)).toBe(true);
  });
});
