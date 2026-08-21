/**
 * Unit tests for e2e/support/lane.mjs
 *
 * Run via the app workspace's `vitest run` (no special config needed — vitest
 * picks up all test/**​/*.test.ts files). The lane module is pure ESM and
 * importable directly via a relative path from this workspace.
 *
 * Tests cover:
 *  1. Hash stability — same worktree → same preferred lane across calls
 *  2. E2E_LANE env override honored
 *  3. E2E_LANE=0 rejected; out-of-range rejected
 *  4. Free-probe: pre-bind a port, assert resolver bumps to next free lane
 *  5. Lane 0 ports (8080/5174/8889/5173) never appear in any resolved block
 *  6. 8000/9000 never appear in any resolved block
 *  7. Cap exceeded: all lanes busy → clear Error thrown
 */

import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Import the module under test (pure ESM .mjs — vitest handles this fine)
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const laneModulePath = path.resolve(here, '../../e2e/support/lane.mjs');

// Dynamically import to get the named exports
type LaneMjs = typeof import('../../e2e/support/lane.mjs');

let lane: LaneMjs;

// We load the module once here. Because ESM modules are cached, resolveLane
// reads process.env at call time (not import time), so env manipulation works.
before: {
  // top-level await is allowed in ESM vitest test files
}

// Use a helper to get the module — loaded once via dynamic import below.
async function getLane(): Promise<LaneMjs> {
  if (!lane) {
    lane = (await import(laneModulePath)) as LaneMjs;
  }
  return lane;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Bind a TCP port on 127.0.0.1, return the server + a close() function.
 * Throws if binding fails so tests fail clearly rather than silently.
 */
function bindPort(port: number): Promise<{ close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

/** Probe that reports all ports as free */
const allFreeProbe = async () => true;

/** Probe that reports all ports as held */
const allBusyProbe = async () => false;

/**
 * An in-memory stand-in for the machine-global lane lease.
 *
 * MUST be injected into every resolveLane() call in this file. The real lease
 * writes to os.tmpdir()/hc-e2e-lanes, so a unit test using it would RESERVE
 * real lanes on the developer's machine - `npm test` could then steal a lane
 * out from under a live `npm run e2e` in a neighbouring worktree. Lease
 * semantics are covered by e2e/support/laneLease.test.ts against the real
 * filesystem; this file is about lane SELECTION.
 *
 * @param held - lanes to report as owned by someone else (never acquirable)
 */
function fakeLease(held: number[] = []) {
  const busy = new Set(held);
  const tokens = new Map<number, string>();
  return {
    reserve: (lane: number) => {
      if (busy.has(lane)) return null;
      const token = lane.toString(16).padStart(32, '0');
      tokens.set(lane, token);
      return token;
    },
    holds: (lane: number, token: string | null | undefined) =>
      token !== null && token !== undefined && tokens.get(lane) === token,
  };
}

/** The common case: every lane is unowned and acquirable. */
const freeLease = () => fakeLease();

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('lane.mjs', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env['E2E_LANE'];
    delete process.env['E2E_LANE'];
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env['E2E_LANE'];
    } else {
      process.env['E2E_LANE'] = savedEnv;
    }
  });

  // -------------------------------------------------------------------------
  // 1. Hash stability
  // -------------------------------------------------------------------------

  describe('hash stability', () => {
    it('djb2 is deterministic across calls for the same string', async () => {
      const { djb2 } = await getLane();
      const s = '/workspaces/housing/.git/worktrees/feat-lane';
      expect(djb2(s)).toBe(djb2(s));
      expect(djb2(s)).toBe(djb2(s)); // third call
    });

    it('hashToLane always returns a value in [1, MAX_LANES]', async () => {
      const { hashToLane, MAX_LANES } = await getLane();
      const inputs = [
        '/some/worktree/.git/worktrees/x',
        '/another/path',
        'short',
        '',
        'a'.repeat(200),
      ];
      for (const input of inputs) {
        const l = hashToLane(input);
        expect(l).toBeGreaterThanOrEqual(1);
        expect(l).toBeLessThanOrEqual(MAX_LANES);
      }
    });

    it('hashToLane is stable across repeated calls for same identity', async () => {
      const { hashToLane } = await getLane();
      const id = '/w/tmp/e2e-lanes/.git/worktrees/feat-e2e-port-lane-isolation';
      const first = hashToLane(id);
      expect(hashToLane(id)).toBe(first);
      expect(hashToLane(id)).toBe(first);
    });

    it('resolveLane returns the same lane on repeated calls (no env, no held ports)', async () => {
      const { resolveLane } = await getLane();
      const a = await resolveLane({ probe: allFreeProbe, lease: freeLease() });
      const b = await resolveLane({ probe: allFreeProbe, lease: freeLease() });
      expect(a.lane).toBe(b.lane);
    });
  });

  // -------------------------------------------------------------------------
  // 2. E2E_LANE override
  // -------------------------------------------------------------------------

  describe('E2E_LANE override', () => {
    it('honors E2E_LANE=3 whatever the probe says - the probe only sets needsReap', async () => {
      // CHANGED with the lane lease. The override used to skip probing entirely.
      // It now probes, but NOT to choose the lane: E2E_LANE is still obeyed
      // exactly. The probe answers a different question - are there orphans on
      // this lane's ports that the launcher should reap?
      const { resolveLane } = await getLane();
      process.env['E2E_LANE'] = '3';
      const busy = vi.fn(async () => false);
      const result = await resolveLane({ probe: busy, lease: freeLease() });
      expect(result.lane).toBe(3);
      expect(result.needsReap).toBe(true);

      const free = vi.fn(async () => true);
      const clean = await resolveLane({ probe: free, lease: freeLease() });
      expect(clean.lane).toBe(3);
      expect(clean.needsReap).toBe(false);
    });

    it('adopts an inherited E2E_LANE_TOKEN instead of re-reserving', async () => {
      // The standard `npm run e2e` path: playwright.config.ts reserves the lane
      // in one process and hands the token to the session in another. Without
      // adoption the session would refuse its own parent's lease.
      const { resolveLane } = await getLane();
      const lease = freeLease();
      const parentToken = lease.reserve(4)!;
      process.env['E2E_LANE'] = '4';
      process.env['E2E_LANE_TOKEN'] = parentToken;
      const result = await resolveLane({ probe: allFreeProbe, lease });
      expect(result.ownerToken).toBe(parentToken);
    });

    it('refuses an E2E_LANE held by another live owner', async () => {
      const { resolveLane } = await getLane();
      process.env['E2E_LANE'] = '6';
      delete process.env['E2E_LANE_TOKEN'];
      await expect(resolveLane({ probe: allFreeProbe, lease: fakeLease([6]) })).rejects.toThrow(
        /held by another live run/i,
      );
    });

    it('returns correct ports for overridden lane', async () => {
      const { resolveLane, portsForLane } = await getLane();
      process.env['E2E_LANE'] = '5';
      const result = await resolveLane({ probe: allFreeProbe, lease: freeLease() });
      const expected = portsForLane(5);
      expect(result.ports).toEqual(expected);
    });

    it('returns correct tablePrefix and mediaBucket for overridden lane', async () => {
      const { resolveLane } = await getLane();
      process.env['E2E_LANE'] = '7';
      const result = await resolveLane({ probe: allFreeProbe, lease: freeLease() });
      expect(result.tablePrefix).toBe('hc-local-7-');
      expect(result.mediaBucket).toBe('hc-local-media-7');
    });
  });

  // -------------------------------------------------------------------------
  // 3. E2E_LANE validation — 0 and out-of-range rejected
  // -------------------------------------------------------------------------

  describe('E2E_LANE validation', () => {
    it('rejects E2E_LANE=0 with a clear error mentioning lane 0 is forbidden', async () => {
      const { resolveLane } = await getLane();
      process.env['E2E_LANE'] = '0';
      await expect(resolveLane({ probe: allFreeProbe, lease: freeLease() })).rejects.toThrow(/0.*forbidden|forbidden.*0/i);
    });

    it('rejects E2E_LANE=0 with a clear error', async () => {
      const { resolveLane } = await getLane();
      process.env['E2E_LANE'] = '0';
      await expect(resolveLane({ probe: allFreeProbe, lease: freeLease() })).rejects.toThrow(/E2E_LANE/);
    });

    it('rejects E2E_LANE=17 (above MAX_LANES)', async () => {
      const { resolveLane } = await getLane();
      process.env['E2E_LANE'] = '17';
      await expect(resolveLane({ probe: allFreeProbe, lease: freeLease() })).rejects.toThrow(/E2E_LANE/);
    });

    it('rejects E2E_LANE=-1 (negative)', async () => {
      const { resolveLane } = await getLane();
      process.env['E2E_LANE'] = '-1';
      await expect(resolveLane({ probe: allFreeProbe, lease: freeLease() })).rejects.toThrow(/E2E_LANE/);
    });

    it('rejects E2E_LANE=abc (non-numeric)', async () => {
      const { resolveLane } = await getLane();
      process.env['E2E_LANE'] = 'abc';
      await expect(resolveLane({ probe: allFreeProbe, lease: freeLease() })).rejects.toThrow(/E2E_LANE/);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Free-probe: pre-bind a port, assert bumps to next free lane
  // -------------------------------------------------------------------------

  describe('lane selection - ownership is the gate, the probe is a hint', () => {
    it('KEEPS a lane whose ports are busy when nobody owns it, and asks for a reap', async () => {
      // THE BEHAVIOUR CHANGE. This used to bump to the next lane. Bumping is
      // what leaked lanes: a worktree that died left orphans on its ports, the
      // probe skipped that lane run after run, and nothing ever reclaimed it.
      // Acquiring the lease PROVES no live owner exists, so those orphans are
      // reclaimable and the lane is usable.
      const { resolveLane } = await getLane();
      delete process.env['E2E_LANE'];
      const preferred = await resolveLane({ probe: allFreeProbe, lease: freeLease() });

      const result = await resolveLane({ probe: allBusyProbe, lease: freeLease() });
      expect(result.lane).toBe(preferred.lane);
      expect(result.needsReap).toBe(true);
    });

    it('bumps past a lane whose lease a live owner holds', async () => {
      // The ONLY reason to bump now: someone else is genuinely working there.
      const { resolveLane } = await getLane();
      delete process.env['E2E_LANE'];
      const preferred = await resolveLane({ probe: allFreeProbe, lease: freeLease() });

      const result = await resolveLane({
        probe: allFreeProbe,
        lease: fakeLease([preferred.lane]),
      });
      expect(result.lane).not.toBe(preferred.lane);
      expect(result.needsReap).toBe(false);
    });

    it('does not bump for a REAL held port when the lane is unowned', async () => {
      const { resolveLane } = await getLane();
      delete process.env['E2E_LANE'];
      const preferred = await resolveLane({ probe: allFreeProbe, lease: freeLease() });
      const server = await bindPort(preferred.ports.app);
      try {
        const result = await resolveLane({ lease: freeLease() });
        expect(result.lane).toBe(preferred.lane);
        expect(result.needsReap).toBe(true);
      } finally {
        await server.close();
      }
    });

    it('surfaces the owner token so the launcher can claim and later release', async () => {
      const { resolveLane } = await getLane();
      delete process.env['E2E_LANE'];
      const result = await resolveLane({ probe: allFreeProbe, lease: freeLease() });
      expect(result.ownerToken).toMatch(/^[a-f0-9]{32}$/);
    });
  });

  // -------------------------------------------------------------------------
  // 5 & 6. Forbidden ports never appear
  // -------------------------------------------------------------------------

  describe('forbidden ports', () => {
    const FORBIDDEN = [8080, 5174, 8889, 5173, 8000, 9000];

    it('lane 0 ports (8080/5174/8889/5173) never appear in any resolved block', async () => {
      const { resolveLane, MAX_LANES } = await getLane();
      // Check all lanes 1..MAX_LANES via the free probe override
      for (let l = 1; l <= MAX_LANES; l++) {
        process.env['E2E_LANE'] = String(l);
        const result = await resolveLane({ probe: allFreeProbe, lease: freeLease() });
        for (const port of Object.values(result.ports)) {
          expect(FORBIDDEN).not.toContain(port);
        }
      }
    });

    it('8000/9000 (DynamoDB/MinIO) never appear in any resolved block', async () => {
      const { portsForLane, MAX_LANES } = await getLane();
      for (let l = 1; l <= MAX_LANES; l++) {
        const ports = portsForLane(l);
        for (const port of Object.values(ports)) {
          expect(port).not.toBe(8000);
          expect(port).not.toBe(9000);
        }
      }
    });

    it('no resolved block port is in the forbidden set [8080,5174,8889,5173,8000,9000]', async () => {
      const { portsForLane, MAX_LANES } = await getLane();
      const forbidden = new Set([8080, 5174, 8889, 5173, 8000, 9000]);
      for (let l = 1; l <= MAX_LANES; l++) {
        const ports = portsForLane(l);
        for (const port of Object.values(ports) as number[]) {
          expect(forbidden.has(port)).toBe(false);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // 7. Cap exceeded: all lanes busy → clear Error
  // -------------------------------------------------------------------------

  describe('cap exceeded', () => {
    // Exhaustion is now about OWNERSHIP, not ports. Busy ports on an unowned
    // lane are reclaimable, so they can no longer exhaust the resolver - only
    // sixteen genuinely live owners can.
    const allLanesHeld = () => fakeLease(Array.from({ length: 16 }, (_, i) => i + 1));

    it('throws a clear actionable error when every lane has a LIVE owner', async () => {
      const { resolveLane } = await getLane();
      delete process.env['E2E_LANE'];
      await expect(resolveLane({ probe: allFreeProbe, lease: allLanesHeld() })).rejects.toThrow(
        /all e2e lanes 1\.\.16 have a LIVE owner/i,
      );
    });

    it('error message points at e2e:stop and says dead owners self-heal', async () => {
      const { resolveLane } = await getLane();
      delete process.env['E2E_LANE'];
      await expect(resolveLane({ probe: allFreeProbe, lease: allLanesHeld() })).rejects.toThrow(
        /e2e:stop[\s\S]*reclaimed automatically/i,
      );
    });

    it('busy ports alone NEVER exhaust the resolver any more', async () => {
      const { resolveLane } = await getLane();
      delete process.env['E2E_LANE'];
      const result = await resolveLane({ probe: allBusyProbe, lease: freeLease() });
      expect(result.needsReap).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 8. Port arithmetic sanity checks
  // -------------------------------------------------------------------------

  describe('portsForLane', () => {
    it('lane 1 → 9101/9111/9121/9131', async () => {
      const { portsForLane } = await getLane();
      expect(portsForLane(1)).toEqual({ app: 9101, dashboard: 9111, fake: 9121, publicBase: 9131 });
    });

    it('lane 2 → 9201/9211/9221/9231', async () => {
      const { portsForLane } = await getLane();
      expect(portsForLane(2)).toEqual({ app: 9201, dashboard: 9211, fake: 9221, publicBase: 9231 });
    });

    it('lane 16 → 10601/10611/10621/10631', async () => {
      const { portsForLane } = await getLane();
      expect(portsForLane(16)).toEqual({
        app: 10601,
        dashboard: 10611,
        fake: 10621,
        publicBase: 10631,
      });
    });

    it('all lanes produce tablePrefix and mediaBucket with lane number', async () => {
      const { resolveLane, MAX_LANES } = await getLane();
      for (let l = 1; l <= MAX_LANES; l++) {
        process.env['E2E_LANE'] = String(l);
        const result = await resolveLane({ probe: allFreeProbe, lease: freeLease() });
        expect(result.tablePrefix).toBe(`hc-local-${l}-`);
        expect(result.mediaBucket).toBe(`hc-local-media-${l}`);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 9. Per-lane / per-worktree DynamoDB Local access keys
  // -------------------------------------------------------------------------

  describe('access keys (per-lane DynamoDB Local databases)', () => {
    it('laneAccessKeyId is hclane<L> — alphanumeric only (DynamoDB Local rejects - and _)', async () => {
      const { laneAccessKeyId, MAX_LANES } = await getLane();
      for (let l = 1; l <= MAX_LANES; l++) {
        const key = laneAccessKeyId(l);
        expect(key).toBe(`hclane${l}`);
        expect(key).toMatch(/^[A-Za-z0-9]+$/);
      }
    });

    it('resolveLane returns accessKeyId matching the lane (E2E_LANE override branch)', async () => {
      const { resolveLane } = await getLane();
      process.env['E2E_LANE'] = '4';
      const result = await resolveLane({ probe: allFreeProbe, lease: freeLease() });
      expect(result.accessKeyId).toBe('hclane4');
    });

    it('resolveLane returns accessKeyId matching the lane (free-probe branch)', async () => {
      const { resolveLane } = await getLane();
      delete process.env['E2E_LANE'];
      const result = await resolveLane({ probe: allFreeProbe, lease: freeLease() });
      expect(result.accessKeyId).toBe(`hclane${result.lane}`);
    });

    it('testAccessKeyId is deterministic, alphanumeric, and never collides with a lane key', async () => {
      const { testAccessKeyId } = await getLane();
      const key = testAccessKeyId();
      expect(testAccessKeyId()).toBe(key); // stable across calls
      expect(key).toMatch(/^hctest[a-z0-9]+$/);
      expect(key.startsWith('hclane')).toBe(false);
    });
  });
});
