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
// WHAT THIS DOES NOT FIX: a hard kill (Ctrl-C, SIGKILL, agent teardown, reboot)
// skips teardown, and the databases of DELETED worktrees / abandoned lanes are
// unreachable - DynamoDB Local exposes no way to enumerate or drop a database,
// only its tables under a key you already hold. Those are reclaimed ONLY by an
// operator stopping the container (scripts/db.mjs warns when it is stale).
// A leak here self-heals for any worktree still in use: the next run recreates
// the tables under the same key and the next clean exit removes them.
//
// CONCURRENCY: the key is per-worktree, so this can only ever affect its own
// worktree - never a neighbour's lane or suite. It does mean two SIMULTANEOUS
// vitest runs in ONE worktree would drop tables under each other; the repo
// already tells you not to do that.
//
// Guards mirror globalSetup exactly: local endpoints only (this must NEVER be
// able to drop tables against AWS), and fail-soft when Docker is down so
// pure-unit runs are unaffected.
import { DeleteTableCommand, ListTablesCommand } from '@aws-sdk/client-dynamodb';

import { testAccessKeyId } from '../../e2e/support/lane.mjs';
import { createDynamoClient } from '../src/lib/dynamo.js';
import { dropAllTables, isLocalEndpoint, LOCAL_DEFAULT_ENDPOINT } from '../scripts/db-create.js';

/**
 * Throwaway table families that `dropAllTables` structurally CANNOT see.
 *
 * It iterates the TABLES manifest under the DEFAULT `hc-local-` prefix, so it
 * drops exactly those 23. But ~38 suites mint their own per-run prefix
 * (`hc-test-<uuid>-`), `performanceSeed.integration.test.ts` uses
 * `hc-local-<lane>-`, and `seedHistory.test.ts` uses `hc-hist-<uuid>-`. None of
 * those are in the manifest, so every INTERRUPTED run leaks its tables forever.
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

/** Delete every residue table under the ACTIVE key. Returns how many went. */
async function sweepResidueTables(endpoint: string): Promise<number> {
  const client = createDynamoClient({ endpoint });
  let removed = 0;
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
  return removed;
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

    // Then the families the manifest cannot see - see RESIDUE_PREFIXES.
    const swept = await sweepResidueTables(endpoint);

    const shortKey = key.length > 12 ? `${key.slice(0, 12)}...` : key;
    console.log(
      `[globalTeardown] dropped hc-local- tables (key=${shortKey}): ${dropped}` +
        (swept > 0 ? `, plus ${swept} residue table(s) from interrupted runs` : ''),
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
