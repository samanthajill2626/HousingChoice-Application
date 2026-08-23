// Vitest `setupFiles` hook - gives each test FILE its own DynamoDB Local
// database, and therefore its own locks.
//
// WHY THIS EXISTS
// ---------------
// `npm test` is one of the required completion gates, and it was not reliably
// green: integration suites failed nondeterministically with
//
//   InternalServerError: This action timed out because it too long waiting for
//   a lock. This request will succeed in actual DynamoDB API
//
// The mechanism, read out of DynamoDBLocal.jar rather than guessed at
// (2026-08-21):
//
//   SQLiteDBAccess holds TWO locks, both private final INSTANCE fields:
//     rowLockTable : ConcurrentMap<tableName, ReentrantReadWriteLock>
//     queueLock    : ReentrantReadWriteLock          <- ONE PER DATABASE
//   LocalDynamoDBRequestHandler.getHandler() keeps one SQLiteDBAccess per
//   database name, which is credential-derived while -sharedDb is off.
//   beginTransaction() -> queueLock.writeLock().lock(), UNTIMED, held until
//   commit. Nearly every other operation also needs queueLock.
//   Data-plane and control-plane ops take getLockForTable(t).writeLock()
//   .tryLock(LOCK_WAIT_TIMEOUT_IN_SECONDS = 10) and throw the message above on
//   failure.
//
// Every message this codebase writes goes through a TransactWriteItems
// (app/src/repos/messagesRepo.ts), so on ONE access key every suite's
// transactions serialise against every other suite's traffic through a single
// queueLock. The per-suite `hc-test-<uuid>-` prefixes do NOT help: they only
// separate rowLockTable entries, which are keyed by table name.
//
// Measured on this machine, same total work, one database vs many
// (16 transaction writers + 48 put writers, 40s):
//   1 database  ->    181 transactions +    528 puts =    709 ops
//   64 databases ->   108 transactions + 11,810 puts = 11,918 ops   (~17x)
//
// WHY NOT SERIALISE THE INTEGRATION LANE INSTEAD
// ----------------------------------------------
// Measured and rejected: the DynamoDB-touching files are ~1990s of the ~2350s
// of total app test time, so --no-file-parallelism costs >= 33 minutes wall
// against ~5 minutes today. See docs/issues/npm-test-dynamodb-local-contention.md.
//
// THE OPT-IN, AND WHY IT IS AN OPT-IN
// -----------------------------------
// app/test/globalSetup.ts bootstraps the shared `hc-local-` tables ONCE, under
// the worktree key. A suite that reads THOSE tables must therefore keep the
// worktree key. Such a suite declares itself with the marker below, in its own
// source - an opt-OUT list living in this file would rot the moment someone
// adds suite 54. Find them with:
//
//   grep -rn "hc:dynamo-lane" app/test
//
// A suite that mints its own `hc-test-<uuid>-` prefix (nearly all of them)
// needs no marker and should not carry one.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'vitest';

import { fileAccessKeyId } from '../../../e2e/support/lane.mjs';

/**
 * A suite carrying this marker keeps the WORKTREE access key, so it can read
 * the shared `hc-local-` tables that globalSetup creates. Everything else gets
 * its own per-file database.
 */
export const SHARED_LOCAL_TABLES_MARKER = 'hc:dynamo-lane shared';

/** Repo root, resolved from this file: app/test/setup -> app/test -> app -> root. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Stable id for a test file: repo-relative, forward slashes, lower-cased.
 *
 * Lower-cased because Windows hands the same file back with inconsistent drive
 * letter case, and a key that changes with the casing would silently mint a
 * SECOND database for one file - exactly the unbounded growth the deterministic
 * hash exists to prevent.
 */
export function testFileId(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/').toLowerCase();
}

/** True when this suite has declared that it reads the shared hc-local- tables. */
export function optsIntoSharedLocalTables(absPath: string): boolean {
  try {
    return readFileSync(absPath, 'utf8').includes(SHARED_LOCAL_TABLES_MARKER);
  } catch {
    // Unreadable source is not a reason to hand back the shared key - that
    // would quietly restore the contention this hook exists to remove.
    return false;
  }
}

/**
 * Resolve the access key for one test file. Exported so the guard suite can
 * exercise the decision without booting vitest twice.
 */
export function accessKeyForTestFile(
  absPath: string,
  opts: { worktreeKey: string; explicitKey?: string | undefined },
): string {
  // An explicitly exported AWS_ACCESS_KEY_ID still wins - someone pointing the
  // suite at a specific database means it.
  if (opts.explicitKey !== undefined && opts.explicitKey !== '') return opts.explicitKey;
  if (optsIntoSharedLocalTables(absPath)) return opts.worktreeKey;
  return fileAccessKeyId(testFileId(absPath));
}

// --- the hook itself --------------------------------------------------------

// `workerState.filepath` is assigned before startTests() runs the setup files,
// and expect.getState().testPath is a live getter onto it.
const testPath = expect.getState().testPath;

if (typeof testPath !== 'string' || testPath === '') {
  // FAIL LOUD. Falling back to one shared key here would look like it worked
  // and quietly reinstate the write-lock contention across all 53 suites - the
  // failure mode is a slow intermittent red weeks later, with nothing pointing
  // back here.
  throw new Error(
    'dynamoAccessKey setup: vitest did not expose the current test file path ' +
      '(expect.getState().testPath). Per-file DynamoDB Local isolation cannot be ' +
      'applied, and falling back to one shared key would silently restore the ' +
      'lock contention this hook exists to remove. See ' +
      'docs/issues/npm-test-dynamodb-local-contention.md.',
  );
}

const worktreeKey = process.env.HC_TEST_WORKTREE_ACCESS_KEY;
if (worktreeKey === undefined || worktreeKey === '') {
  throw new Error(
    'dynamoAccessKey setup: HC_TEST_WORKTREE_ACCESS_KEY is unset. It is supplied ' +
      'by app/vitest.config.ts; this hook is not usable outside that config.',
  );
}

process.env.AWS_ACCESS_KEY_ID = accessKeyForTestFile(testPath, {
  worktreeKey,
  explicitKey: process.env.HC_TEST_EXPLICIT_ACCESS_KEY,
});
process.env.AWS_SECRET_ACCESS_KEY ??= 'local';
