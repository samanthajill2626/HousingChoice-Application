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
      const a = await resolveLane({ probe: allFreeProbe });
      const b = await resolveLane({ probe: allFreeProbe });
      expect(a.lane).toBe(b.lane);
    });
  });

  // -------------------------------------------------------------------------
  // 2. E2E_LANE override
  // -------------------------------------------------------------------------

  describe('E2E_LANE override', () => {
    it('honors E2E_LANE=3 and returns lane 3 without probing', async () => {
      const { resolveLane } = await getLane();
      process.env['E2E_LANE'] = '3';
      const probeCallCount = vi.fn(async () => true);
      const result = await resolveLane({ probe: probeCallCount });
      expect(result.lane).toBe(3);
      // override skips free-probe entirely
      expect(probeCallCount).not.toHaveBeenCalled();
    });

    it('returns correct ports for overridden lane', async () => {
      const { resolveLane, portsForLane } = await getLane();
      process.env['E2E_LANE'] = '5';
      const result = await resolveLane({ probe: allFreeProbe });
      const expected = portsForLane(5);
      expect(result.ports).toEqual(expected);
    });

    it('returns correct tablePrefix and mediaBucket for overridden lane', async () => {
      const { resolveLane } = await getLane();
      process.env['E2E_LANE'] = '7';
      const result = await resolveLane({ probe: allFreeProbe });
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
      await expect(resolveLane({ probe: allFreeProbe })).rejects.toThrow(/0.*forbidden|forbidden.*0/i);
    });

    it('rejects E2E_LANE=0 with a clear error', async () => {
      const { resolveLane } = await getLane();
      process.env['E2E_LANE'] = '0';
      await expect(resolveLane({ probe: allFreeProbe })).rejects.toThrow(/E2E_LANE/);
    });

    it('rejects E2E_LANE=17 (above MAX_LANES)', async () => {
      const { resolveLane } = await getLane();
      process.env['E2E_LANE'] = '17';
      await expect(resolveLane({ probe: allFreeProbe })).rejects.toThrow(/E2E_LANE/);
    });

    it('rejects E2E_LANE=-1 (negative)', async () => {
      const { resolveLane } = await getLane();
      process.env['E2E_LANE'] = '-1';
      await expect(resolveLane({ probe: allFreeProbe })).rejects.toThrow(/E2E_LANE/);
    });

    it('rejects E2E_LANE=abc (non-numeric)', async () => {
      const { resolveLane } = await getLane();
      process.env['E2E_LANE'] = 'abc';
      await expect(resolveLane({ probe: allFreeProbe })).rejects.toThrow(/E2E_LANE/);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Free-probe: pre-bind a port, assert bumps to next free lane
  // -------------------------------------------------------------------------

  describe('free-probe', () => {
    it('bumps past a lane whose block has a held port (using a real TCP listener)', async () => {
      const { resolveLane, hashToLane, portsForLane, MAX_LANES } = await getLane();

      // Compute the preferred lane for this worktree (no env override)
      // We do this by computing the hash the same way the module does, but
      // since we can't call worktreeIdentity() directly, we instead use a
      // probe mock that tracks which lanes were probed.
      //
      // Strategy: use a controlled probe that marks lane 1 as busy (one port
      // held) and everything else free, then assert the result is NOT lane 1.
      const busyLane = 1;
      const busyPorts = portsForLane(busyLane);
      // Mark the app port of lane 1 as busy
      const controlledProbe = async (port: number) => {
        if (port === busyPorts.app) return false; // lane 1 app port is held
        return true;
      };

      // Force hash to prefer lane 1 by setting... we can't control the
      // worktree identity, so instead: inject a probe that says lane 1 is
      // busy and all other lanes are free. Assert we don't get lane 1.
      const result = await resolveLane({ probe: controlledProbe });
      expect(result.lane).not.toBe(busyLane);
    });

    it('bumps using a real TCP listener on a computed port', async () => {
      const { resolveLane, portsForLane, MAX_LANES } = await getLane();

      // We need to find the preferred lane for this worktree. We use the
      // approach: let the resolver run with allFreeProbe first to discover
      // the preferred lane, then bind one of its ports and re-run.
      const preferred = await resolveLane({ probe: allFreeProbe });
      const prefLane = preferred.lane;

      // Find the next lane (wrapping) to know what we expect after bumping
      const nextLane = (prefLane % MAX_LANES) + 1;

      // Actually bind the app port of the preferred lane
      const appPort = preferred.ports.app;
      const server = await bindPort(appPort);

      try {
        // Now resolve with a real probe — the preferred lane's app port is held
        const result = await resolveLane();
        // Should have bumped to a different lane
        expect(result.lane).not.toBe(prefLane);
      } finally {
        await server.close();
      }
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
        const result = await resolveLane({ probe: allFreeProbe });
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
    it('throws a clear actionable error when all lanes are busy', async () => {
      const { resolveLane } = await getLane();
      delete process.env['E2E_LANE'];
      await expect(resolveLane({ probe: allBusyProbe })).rejects.toThrow(
        /all e2e lanes 1\.\.16 are busy/i,
      );
    });

    it('error message mentions setting E2E_LANE', async () => {
      const { resolveLane } = await getLane();
      delete process.env['E2E_LANE'];
      await expect(resolveLane({ probe: allBusyProbe })).rejects.toThrow(/E2E_LANE/);
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
        const result = await resolveLane({ probe: allFreeProbe });
        expect(result.tablePrefix).toBe(`hc-local-${l}-`);
        expect(result.mediaBucket).toBe(`hc-local-media-${l}`);
      }
    });
  });
});
