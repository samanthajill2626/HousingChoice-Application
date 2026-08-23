// Which DynamoDB Local databases did this worktree's tests actually TOUCH?
//
// WHY THIS EXISTS
// ---------------
// `app/test/setup/dynamoAccessKey.ts` gives every test FILE its own access key,
// and DynamoDB Local keeps a separate database per (accessKeyId, region). That
// removed the shared write lock - but it also put every leaked throwaway table
// (`hc-test-<uuid>-`, `hc-hist-<uuid>-`, `hc-local-<lane>-`) somewhere
// `globalTeardown` could no longer reach, because the teardown runs under ONE
// key: the worktree key. Measured 2026-08-23 on a CLEAN, GREEN, uninterrupted
// run: a suite that skips its own drop leaves its tables behind permanently.
//
// WHY NOT JUST SWEEP EVERY PER-FILE KEY
// -------------------------------------
// Because asking is not free. Measured 2026-08-23 against the shared container:
//
//   ListTables x400 under FRESH keys        1590ms, container RSS +235 MiB
//   ListTables x400 more under FRESH keys   1575ms, container RSS +456 MiB
//   ListTables x400 under those SAME keys    925ms, container RSS +1 MiB
//
// A ListTables under a key nobody has used MATERIALISES that database, at
// roughly 0.6-1.1 MiB that `-inMemory` only reclaims when the container stops.
// A worktree has ~327 test files and only ~53 of them touch DynamoDB, so a
// blind walk of every per-file key would permanently allocate ~200 MiB per
// worktree to look for tables that cannot exist - re-creating the exact
// unbounded growth the per-file keys were introduced to bound.
//
// SO: RECORD, DO NOT GUESS
// ------------------------
// `app/src/lib/dynamo.ts` drops a zero-byte marker named after the access key
// the moment it builds a client against a local endpoint - one write per
// (process, key), gated on the env var below, which only `app/vitest.config.ts`
// ever sets. The sweep then visits exactly the databases that were really used,
// all of which are already materialised, so it costs nothing extra.
//
// The ledger is pruned as it is swept, so it stays bounded and a stale marker
// from a deleted test file cannot make a future run re-materialise its database.
// A marker therefore survives only an INTERRUPTED run - which is precisely the
// case the next run needs to clean up.
//
// SCOPE NOTE (2026-08-23): the LEDGER is per-worktree, but the per-file KEYS it
// records are machine-wide (e2e/support/lane.mjs fileAccessKeyId) - the same
// key names appear in every worktree's ledger, and the databases behind them
// are shared. That is why the sweep itself is mode-gated on whether another
// vitest run is live (helpers/testRunRegistry.ts) rather than free to delete
// on sight; see globalTeardown.ts sweepLedgerResidue.
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Env var carrying the ledger directory. Set ONLY by app/vitest.config.ts. */
export const LEDGER_ENV_VAR = 'HC_TEST_DYNAMO_KEY_LEDGER';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * `app/test/.artifacts/dynamo-keys` - gitignored, and inside the worktree so it
 * is scoped exactly the way the access keys are.
 */
export function ledgerDir(): string {
  return path.resolve(HERE, '..', '.artifacts', 'dynamo-keys');
}

/**
 * Access keys recorded since the last sweep.
 *
 * The alphanumeric filter is a safety gate, not cosmetics: these names are
 * joined onto a path and handed to DeleteTable. DynamoDB Local rejects a
 * non-alphanumeric access key anyway once `-sharedDb` is off (see
 * `e2e/support/lane.mjs`), so nothing legitimate is excluded.
 */
export function readLedgerKeys(dir: string = ledgerDir()): string[] {
  try {
    return readdirSync(dir).filter((name) => /^[A-Za-z0-9]+$/.test(name));
  } catch {
    // No directory means no run has recorded anything. Not an error.
    return [];
  }
}

/** Drop one marker. Best-effort: a marker that is already gone is a success. */
export function forgetLedgerKey(key: string, dir: string = ledgerDir()): void {
  if (!/^[A-Za-z0-9]+$/.test(key)) return;
  try {
    rmSync(path.join(dir, key));
  } catch {
    // Already gone, or never existed.
  }
}
