// Machine-global registry of LIVE vitest runs - who else is testing right now?
//
// WHY THIS EXISTS
// ---------------
// Per-file DynamoDB Local access keys became MACHINE-WIDE on 2026-08-23
// (e2e/support/lane.mjs fileAccessKeyId): every worktree running the same test
// file reaches the same database. That caps the never-reclaimable database
// count at one per test file for the whole machine - but it breaks the
// assumption the residue sweep (globalTeardown.ts sweepLedgerResidue) was
// written on, namely that every key it touches belongs to THIS worktree. Under
// shared keys, "delete every residue-prefixed table under this key" can reach a
// CONCURRENT neighbour's live tables: table names are per-run UUIDs, so residue
// from a killed run and a live neighbour's tables are indistinguishable by
// name.
//
// The registry answers the one question that makes sweeping safe: is any OTHER
// vitest run live on this machine? No -> every residue table is provably dead,
// sweep it all immediately (the pre-2026-08-23 behaviour, and the common case).
// Yes -> the sweep spares young tables and lets age prove death instead
// (globalTeardown.ts CONCURRENT_SPARE_MS).
//
// MECHANISM - mirrors e2e/support/laneLease.mjs deliberately: a directory under
// os.tmpdir() (machine-global by construction, and writable somewhere every
// checkout can reach, unlike a repo-relative path), one zero-byte marker named
// by pid, liveness via process.kill(pid, 0), and an mtime backstop against the
// OS recycling a dead run's pid onto an unrelated long-lived process.
//
// ORDERING CONTRACT (load-bearing - see globalSetup.ts): registerRun() MUST run
// before the process opens any DynamoDB client. A run only becomes visible to
// neighbours' sweeps through its marker, and its first throwaway table follows
// the marker by seconds (reachability probe, hc-local ensure, worker boot).
// The sweep re-checks otherLiveRuns() per KEY, so the visibility gap a table
// would need to slip through is the milliseconds between one readdir and one
// ListTables - orders of magnitude smaller than the seconds of head start the
// contract guarantees.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Machine-global marker directory. Same reasoning as laneLease's LEASE_DIR. */
export const RUN_REGISTRY_DIR = path.join(os.tmpdir(), 'hc-vitest-runs');

/**
 * Backstop for a marker whose dead pid the OS recycled onto an unrelated
 * process: no vitest run lasts anywhere near this long, so an older marker is
 * treated as dead no matter what kill(0) says. Mirrors laneLease's approach.
 */
export const MARKER_BACKSTOP_MS = 6 * 60 * 60 * 1000;

/** Is a pid alive? kill(pid, 0) throws ESRCH when it is not. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Announce this process as a live vitest run. Returns the unregister function;
 * call it as the LAST teardown step, so neighbours keep age-gating their sweeps
 * for as long as this run might still be writing.
 */
export function registerRun(dir: string = RUN_REGISTRY_DIR): () => void {
  const marker = path.join(dir, String(process.pid));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, '');
  } catch {
    // A registry we cannot write to must not break the run. The failure mode
    // is that neighbours cannot see us and may sweep in solo mode - the same
    // exposure as before the registry existed, not a new one.
  }
  return () => {
    try {
      rmSync(marker);
    } catch {
      // Already gone. Fine.
    }
  };
}

/**
 * How many OTHER live vitest runs this machine has right now. Dead markers are
 * pruned as they are found, so the directory stays bounded.
 *
 * Deliberately counts a marker it cannot stat as LIVE: when in doubt, the
 * caller sweeps conservatively (age-gated), which can only delay cleanup -
 * never delete a live neighbour's tables.
 */
export function otherLiveRuns(dir: string = RUN_REGISTRY_DIR, nowMs: number = Date.now()): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0; // No directory -> nobody has ever registered.
  }

  let live = 0;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;

    let expired = false;
    try {
      expired = nowMs - statSync(path.join(dir, name)).mtimeMs > MARKER_BACKSTOP_MS;
    } catch {
      continue; // Vanished between readdir and stat - a clean exit. Not live.
    }

    if (!expired && pidAlive(pid)) {
      live += 1;
    } else {
      try {
        rmSync(path.join(dir, name));
      } catch {
        // Another pruner got it first. Fine.
      }
    }
  }
  return live;
}
