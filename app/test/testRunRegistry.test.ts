// Tests for helpers/testRunRegistry.ts - the machine-global "who else is
// testing right now?" registry that decides whether the residue sweep may
// delete on sight (solo) or must age-gate (concurrent).
//
// Everything here runs against a throwaway directory, never the real
// RUN_REGISTRY_DIR: these tests must not make a genuinely concurrent
// neighbour's sweep think the machine is quiet, nor register phantom runs
// that would age-gate it for no reason.
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MARKER_BACKSTOP_MS, otherLiveRuns, registerRun } from './helpers/testRunRegistry.js';

describe('testRunRegistry', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'hc-runreg-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('registerRun writes a marker named by pid, and unregister removes it', () => {
    const unregister = registerRun(dir);
    expect(readdirSync(dir)).toContain(String(process.pid));
    unregister();
    expect(readdirSync(dir)).not.toContain(String(process.pid));
  });

  it('does not count THIS process - a run is not its own neighbour', () => {
    const unregister = registerRun(dir);
    try {
      expect(otherLiveRuns(dir)).toBe(0);
    } finally {
      unregister();
    }
  });

  it('counts a marker whose pid is a live foreign process', () => {
    // process.ppid is the vitest worker's parent - alive by construction for
    // the duration of this test, and never equal to our own pid.
    writeFileSync(path.join(dir, String(process.ppid)), '');
    expect(otherLiveRuns(dir)).toBe(1);
  });

  it('ignores AND PRUNES a marker whose pid is dead', () => {
    // A real pid that has provably exited: spawnSync returns only after the
    // child is gone. Guarding with a live-pid fabrication (pid 4194305 etc.)
    // would be flakier than using a genuinely dead one.
    const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    expect(child.pid).toBeGreaterThan(0);
    // On the off chance the OS instantly recycled it onto a live process, the
    // assertion below would legitimately differ - vanishingly unlikely, and a
    // rerun clears it.
    writeFileSync(path.join(dir, String(child.pid)), '');

    expect(otherLiveRuns(dir)).toBe(0);
    // Pruned, not just skipped: dead markers must not accumulate.
    expect(readdirSync(dir)).not.toContain(String(child.pid));
  });

  it('the mtime backstop retires a marker even when its pid reads as alive', () => {
    // Pid recycling: a dead run's pid handed to some unrelated long-lived
    // process would otherwise pin the machine in age-gated mode forever. Use a
    // LIVE pid (our parent) with an ancient mtime - liveness says yes, the
    // backstop must say no.
    const marker = path.join(dir, String(process.ppid));
    writeFileSync(marker, '');
    const ancient = (Date.now() - MARKER_BACKSTOP_MS - 60_000) / 1000;
    utimesSync(marker, ancient, ancient);

    expect(otherLiveRuns(dir)).toBe(0);
    expect(readdirSync(dir)).not.toContain(String(process.ppid));
  });

  it('ignores names that are not pids - nothing joins a path into kill()', () => {
    writeFileSync(path.join(dir, 'not-a-pid'), '');
    writeFileSync(path.join(dir, '12abc'), '');
    expect(otherLiveRuns(dir)).toBe(0);
    // Non-pid names are ignored, not pruned: they are not ours to judge.
    expect(readdirSync(dir).sort()).toEqual(['12abc', 'not-a-pid']);
  });

  it('a missing directory means nobody has ever registered', () => {
    expect(otherLiveRuns(path.join(dir, 'never-created'))).toBe(0);
  });
});
