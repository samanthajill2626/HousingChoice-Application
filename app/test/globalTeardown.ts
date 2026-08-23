// Vitest globalTeardown - drops THIS worktree's hc-local- tables after the run,
// the counterpart to globalSetup.ts's ensureKeyedLocalTables.
//
// WHY (2026-08-16): nothing ever deleted these. DynamoDB Local runs -inMemory
// WITHOUT -sharedDb, so it keeps a separate database per (accessKeyId, region)
// - every worktree's vitest key (hctest<hash>) and every e2e lane key
// (hclane<L>) gets its own database of ~23 tables. Tables were created once and
// reused forever, so the count grew with every worktree and lane that had ever
// run and was only ever reclaimed by stopping the container. A container left
// up for 8 days accumulated enough to degrade every suite that touched it:
// integration tests timed out at their budget in full runs and passed solo in
// milliseconds. See docs/issues/dynamodb-local-cross-worktree-test-contention.md
// for the earlier -sharedDb variant of the same symptom.
//
// COST (measured on this machine, throwaway key): drop 99ms, cold create 197ms,
// idempotent re-ensure 52ms - so the net tax is ~244ms per run. Negligible
// against a multi-minute suite.
//
// A HARD KILL IS COVERED, from the OTHER end (2026-08-23). Ctrl-C, SIGKILL,
// agent teardown and reboot all skip this file entirely, so nothing it does can
// help the run that died. What closes that hole is `globalSetup` running the
// same ledger sweep BEFORE the next run - see sweepLedgerResidue below. The
// residue only ever harms the run that has to share a container with it, so
// cleaning on the way IN is what bounds the damage to one run.
//
// WHAT THIS STILL DOES NOT FIX: the databases of DELETED worktrees and
// abandoned lanes. DynamoDB Local exposes no way to enumerate or drop a
// database, only its tables under a key you already hold, and a deleted
// worktree takes its ledger with it. Those are reclaimed ONLY by an operator
// stopping the container (scripts/db.mjs warns when it is stale).
//
// CONCURRENCY (rewritten 2026-08-23, when per-file keys became MACHINE-WIDE).
// The worktree key is still private to this worktree, but the per-file keys the
// ledger records are now SHARED with every other worktree - a neighbour's
// concurrent run writes its (UUID-named, therefore unattributable) tables into
// the very databases this sweep visits. The sweep is kept safe by mode, not by
// key scoping: when no OTHER vitest run is live machine-wide
// (helpers/testRunRegistry.ts), every residue table is provably dead and is
// deleted immediately; when one IS live, tables younger than
// CONCURRENT_SPARE_MS are spared and age proves death instead. Deleting a live
// neighbour's table is therefore impossible in either mode - the failure mode
// of every race here is "cleanup happens later", never "data lost". Two
// SIMULTANEOUS vitest runs in ONE worktree still drop the worktree key's tables
// under each other; the repo already tells you not to do that.
//
// Guards mirror globalSetup exactly: local endpoints only (this must NEVER be
// able to drop tables against AWS), and fail-soft when Docker is down so
// pure-unit runs are unaffected.
import { DeleteTableCommand, DescribeTableCommand, ListTablesCommand } from '@aws-sdk/client-dynamodb';

import { testAccessKeyId } from '../../e2e/support/lane.mjs';
import { createDynamoClient } from '../src/lib/dynamo.js';
import { dropAllTables, isLocalEndpoint, LOCAL_DEFAULT_ENDPOINT } from '../scripts/db-create.js';
import { forgetLedgerKey, ledgerDir, readLedgerKeys } from './helpers/dynamoKeyLedger.js';
import { otherLiveRuns } from './helpers/testRunRegistry.js';

/**
 * Throwaway table families that `dropAllTables` structurally CANNOT see.
 *
 * It iterates the TABLES manifest under the DEFAULT `hc-local-` prefix, so it
 * drops exactly those 23. But ~38 suites mint their own per-run prefix
 * (`hc-test-<uuid>-`), `performanceSeed.integration.test.ts` uses
 * `hc-local-<lane>-`, and `seedHistory.test.ts` uses `hc-hist-<uuid>-`. None of
 * those are in the manifest, so without this sweep an interrupted run leaks its
 * tables forever - and since the prefixes carry a fresh uuid per RUN, every
 * interruption adds a new set rather than reusing the last one.
 *
 * That is not cosmetic. Measured 2026-08-23: a key carrying 116 such tables ran
 * the app suite in 607s with 9 failures (plain timeouts and SQLite write-lock
 * errors, ZERO assertion failures); the same commit on an empty key ran in 65s
 * with 0 failures. A required completion gate was red for pure residue.
 *
 * Safe by construction: this sweep runs INSIDE one access key's own database
 * (DynamoDB Local keys a separate database per accessKeyId), and the whole
 * teardown is hard-gated to a localhost endpoint. It cannot reach an e2e lane
 * (different key) or AWS.
 */
const RESIDUE_PREFIXES = [
  /^hc-test-/, // per-suite throwaway prefixes
  /^hc-hist-/, // seedHistory
  /^hc-local-\d+-/, // performanceSeed's lane-shaped prefix (NOT plain hc-local-)
];

/**
 * How young a residue table must be to be SPARED when another vitest run is
 * live machine-wide. A live neighbour's tables are at most as old as its
 * in-flight run (~2-5 min for the app suite), so an hour is a >10x margin; a
 * genuinely dead run's residue crosses the threshold soon after and the next
 * sweep takes it. Raising this only delays cleanup; lowering it toward a real
 * run's duration is what would make the sweep dangerous again.
 */
export const CONCURRENT_SPARE_MS = 60 * 60 * 1000;

/**
 * Delete residue tables under the ACTIVE key.
 *
 * `spareYoungerThanMs` is the concurrency guard (2026-08-23, machine-wide
 * per-file keys): residue is unattributable by NAME (per-run UUID prefixes), so
 * when another run is live the only safe proof of death is AGE, read from
 * DescribeTable's CreationDateTime. 0 means solo mode - delete everything, the
 * behaviour from before keys were shared. A candidate whose age cannot be read
 * is SPARED in gated mode: never delete what you cannot age.
 */
async function sweepResidueTables(
  endpoint: string,
  opts: { spareYoungerThanMs?: number } = {},
): Promise<{ removed: number; spared: number }> {
  const spareYoungerThanMs = opts.spareYoungerThanMs ?? 0;
  const client = createDynamoClient({ endpoint });
  let removed = 0;
  let spared = 0;
  try {
    let exclusiveStartTableName: string | undefined;
    const doomed: string[] = [];
    do {
      const res = await client.send(
        new ListTablesCommand(
          exclusiveStartTableName !== undefined ? { ExclusiveStartTableName: exclusiveStartTableName } : {},
        ),
      );
      for (const name of res.TableNames ?? []) {
        if (RESIDUE_PREFIXES.some((re) => re.test(name))) doomed.push(name);
      }
      exclusiveStartTableName = res.LastEvaluatedTableName;
    } while (exclusiveStartTableName !== undefined);

    for (const name of doomed) {
      if (spareYoungerThanMs > 0) {
        try {
          const d = await client.send(new DescribeTableCommand({ TableName: name }));
          const createdMs = d.Table?.CreationDateTime?.getTime();
          if (createdMs === undefined || Date.now() - createdMs < spareYoungerThanMs) {
            spared += 1;
            continue;
          }
        } catch {
          spared += 1; // Cannot age it -> cannot prove it dead -> spare it.
          continue;
        }
      }
      try {
        await client.send(new DeleteTableCommand({ TableName: name }));
        removed += 1;
      } catch {
        // A table another process is already dropping is not our problem.
      }
    }
  } finally {
    client.destroy();
  }
  return { removed, spared };
}

/** Run `fn` with AWS_ACCESS_KEY_ID pinned to `key`, then restore the environment. */
async function withAccessKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prevKey = process.env.AWS_ACCESS_KEY_ID;
  const prevSecret = process.env.AWS_SECRET_ACCESS_KEY;
  process.env.AWS_ACCESS_KEY_ID = key;
  process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? 'local';
  try {
    return await fn();
  } finally {
    if (prevKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = prevKey;
    if (prevSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = prevSecret;
  }
}

/**
 * Sweep residue out of every database a test file actually opened.
 *
 * `app/test/setup/dynamoAccessKey.ts` gives each test FILE its own access key,
 * so a suite's throwaway tables land in a database this teardown's own key
 * cannot see. The ledger names the databases that were really used - see
 * `app/test/helpers/dynamoKeyLedger.ts` for why they are RECORDED rather than
 * enumerated (walking all ~327 per-file keys would materialise a database for
 * each, at ~0.6-1.1 MiB apiece that -inMemory keeps until the container stops).
 *
 * Markers are dropped as they are swept, so the ledger stays bounded: a marker
 * outlives its run only when that run was interrupted, which is exactly when
 * the next run needs to find it.
 *
 * Callers must have already checked `isLocalEndpoint(endpoint)`.
 */
export async function sweepLedgerResidue(
  endpoint: string,
  opts: { dir?: string; spareYoungerThanMs?: number } = {},
): Promise<{ keys: number; tables: number; spared: number }> {
  const dir = opts.dir ?? ledgerDir();
  const keys = readLedgerKeys(dir);
  let tables = 0;
  let sparedTotal = 0;
  for (const key of keys) {
    // MODE, decided per key rather than once (2026-08-23, machine-wide file
    // keys): these databases are shared with every other worktree, so residue
    // can only be deleted on sight while NO other vitest run is live. The
    // per-key re-check shrinks the race window to the milliseconds between one
    // registry readdir and one ListTables; a starting run registers its marker
    // seconds before it can create its first table (the ordering contract in
    // helpers/testRunRegistry.ts). An explicit spareYoungerThanMs (tests) wins.
    const spareYoungerThanMs =
      opts.spareYoungerThanMs ?? (otherLiveRuns() > 0 ? CONCURRENT_SPARE_MS : 0);
    let spared = 0;
    try {
      const swept = await withAccessKey(key, () =>
        sweepResidueTables(endpoint, { spareYoungerThanMs }),
      );
      tables += swept.removed;
      spared = swept.spared;
      sparedTotal += swept.spared;
    } catch {
      // One unreachable database must not abandon the rest of the sweep.
      continue;
    }
    // Keep the marker while anything was spared: a spared table is a LIVE
    // neighbour's (or unageable), and forgetting the key here would orphan it
    // if that neighbour dies before its own teardown - the ledger is the only
    // map anyone has of which databases hold residue.
    if (spared === 0) forgetLedgerKey(key, dir);
  }
  return { keys: keys.length, tables, spared: sparedTotal };
}

/**
 * Core logic, exported so tests can call it directly against a throwaway key.
 *
 * @param opts.endpoint  DynamoDB Local URL (defaults to process.env.DYNAMODB_ENDPOINT)
 * @param opts.key       AWS_ACCESS_KEY_ID to use (defaults to the worktree test key)
 */
export async function dropKeyedLocalTables(opts: {
  endpoint?: string;
  key?: string;
} = {}): Promise<void> {
  const endpoint = opts.endpoint ?? process.env.DYNAMODB_ENDPOINT ?? LOCAL_DEFAULT_ENDPOINT;

  // Safety: this function DELETES. Never let it point at anything but local.
  if (!isLocalEndpoint(endpoint)) {
    console.warn(
      `[globalTeardown] Non-local DynamoDB endpoint (${endpoint}) - refusing to drop tables. ` +
        `This teardown is for DynamoDB Local only.`,
    );
    return;
  }

  // Reachability probe - a stopped container has already discarded everything
  // (-inMemory), so there is nothing to drop and nothing to warn loudly about.
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
  } catch {
    return;
  }

  // vitest test.env applies to workers, not to globalSetup/globalTeardown, so
  // set the credentials here the same way globalSetup does (respect-if-set).
  const key = opts.key ?? process.env.AWS_ACCESS_KEY_ID ?? testAccessKeyId();
  const prevKey = process.env.AWS_ACCESS_KEY_ID;
  const prevSecret = process.env.AWS_SECRET_ACCESS_KEY;

  process.env.AWS_ACCESS_KEY_ID = key;
  process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? 'local';

  try {
    // dropAllTables logs one indented line per table; swallow those and print a
    // single summary, mirroring globalSetup's output shape.
    const origLog = console.log;
    let dropped = 0;
    console.log = (...args: unknown[]) => {
      const msg = args.join(' ');
      if (msg.startsWith('  ')) dropped += 1;
      else origLog(...args);
    };

    try {
      await dropAllTables(endpoint);
    } finally {
      console.log = origLog;
    }

    // Then the families the manifest cannot see - see RESIDUE_PREFIXES. Scoped
    // to THIS key's database - the WORKTREE key or a test's own throwaway key,
    // both private to their creator even now that per-FILE keys are shared -
    // so this stays in solo mode (no age gate). The per-file sweep is NOT
    // private: it reaches shared databases, so it lives in globalSetup's
    // run-level entry points with the mode logic. See sweepPerFileResidue.
    const swept = await sweepResidueTables(endpoint);

    const shortKey = key.length > 12 ? `${key.slice(0, 12)}...` : key;
    console.log(
      `[globalTeardown] dropped hc-local- tables (key=${shortKey}): ${dropped}` +
        (swept.removed > 0 ? `, plus ${swept.removed} residue table(s) from interrupted runs` : ''),
    );
  } catch (err) {
    // Best-effort: a teardown failure must never turn a green run red. The
    // tables simply persist and the next run reuses them, exactly as before.
    console.warn(`[globalTeardown] table cleanup failed (harmless, tables persist): ${String(err)}`);
  } finally {
    if (prevKey === undefined) {
      delete process.env.AWS_ACCESS_KEY_ID;
    } else {
      process.env.AWS_ACCESS_KEY_ID = prevKey;
    }
    if (prevSecret === undefined) {
      delete process.env.AWS_SECRET_ACCESS_KEY;
    } else {
      process.env.AWS_SECRET_ACCESS_KEY = prevSecret;
    }
  }
}

/** Vitest globalTeardown entry point. */
export default async function teardown(): Promise<void> {
  await dropKeyedLocalTables();
}
