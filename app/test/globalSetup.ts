// Vitest globalSetup — ensures the standard hc-local- DynamoDB tables exist
// under THIS worktree's per-key test database before any test runs.
//
// Background: DynamoDB Local keeps a SEPARATE database per (accessKeyId,
// region) — each worktree's vitest runs use their own `hctest<hash>` key
// (app/vitest.config.ts). A fresh worktree therefore starts with an EMPTY
// database; tests that touch the standard hc-local- tables (e.g. reseed)
// fail with ResourceNotFoundException until the tables exist.
//
// This file makes `npm test` self-serve: the first run against a fresh
// worktree key auto-creates the tables (idempotent — ensureTable skips
// existing). No manual db:create step needed.
//
// FAIL-LOUD (changed 2026-08-21): if DynamoDB Local is unreachable this THROWS
// and the run stops. It used to warn and continue, which meant `npm test` could
// exit 0 while 631 tests across 46 `skipIf(!reachable)` suites never ran. Set
// ALLOW_SKIP_DYNAMO_TESTS=1 for a deliberate unit-only pass.
//
// Local-only guard: we refuse (skip with a console.warn) for any non-localhost
// endpoint. The guard is the point — this setup NEVER creates tables against
// AWS.

import { testAccessKeyId } from '../../e2e/support/lane.mjs';
import { createAllTables, isLocalEndpoint, LOCAL_DEFAULT_ENDPOINT } from '../scripts/db-create.js';
import { dropKeyedLocalTables } from './globalTeardown.js';

/**
 * Core logic, exported so tests can call it directly (e.g. with a fresh
 * throwaway key to verify table creation and idempotency).
 *
 * @param opts.endpoint  DynamoDB Local URL (defaults to process.env.DYNAMODB_ENDPOINT)
 * @param opts.key       AWS_ACCESS_KEY_ID to use (defaults to the worktree test key)
 */
export async function ensureKeyedLocalTables(opts: {
  endpoint?: string;
  key?: string;
} = {}): Promise<void> {
  const endpoint = opts.endpoint ?? process.env.DYNAMODB_ENDPOINT ?? LOCAL_DEFAULT_ENDPOINT;

  // Safety: never create tables against a non-local endpoint.
  if (!isLocalEndpoint(endpoint)) {
    console.warn(
      `[globalSetup] Non-local DynamoDB endpoint (${endpoint}) — skipping auto-bootstrap. ` +
        `This setup is for DynamoDB Local only.`,
    );
    return;
  }

  // Reachability probe. FAILS THE RUN by default when DynamoDB Local is down.
  //
  // This used to warn and return, which made `npm test` a liar: 46 suites carry
  // `describe.skipIf(!reachable)`, so with Docker down **631 tests silently do
  // not run and the gate still exits 0**. `npm test` is one of the three
  // required completion gates (AGENTS.md), and a gate that quietly omits a
  // third of the app suite is worse than one that fails - it is the shape that
  // lets a real regression through while everything looks green.
  //
  // Docker is already a hard requirement of this repo (e2e needs it, and
  // AGENTS.md says so), so requiring it for the integration lane costs nobody
  // anything they did not already have. What changes is that the cost of NOT
  // having it is now visible.
  //
  // Deliberately an opt-OUT, not an opt-in: someone running a focused unit-only
  // pass can set ALLOW_SKIP_DYNAMO_TESTS=1 and take responsibility for the gap.
  // The default is to tell the truth.
  //
  // See docs/issues/unread-index-integration-coverage-requires-local-dynamo.md.
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
  } catch {
    if (process.env.ALLOW_SKIP_DYNAMO_TESTS === '1') {
      console.warn(
        `[globalSetup] DynamoDB Local not reachable at ${endpoint}, and ` +
          `ALLOW_SKIP_DYNAMO_TESTS=1 is set. SKIPPING the integration lane: ` +
          `631 tests across 46 suites will NOT run, and a green result does not ` +
          `cover them.`,
      );
      return;
    }
    throw new Error(
      `DynamoDB Local is not reachable at ${endpoint}, so the integration lane ` +
        `cannot run - 46 suites (~631 tests) would silently skip and this gate ` +
        `would still report green.\n\n` +
        `  Fix:  npm run db:start\n` +
        `  Or:   ALLOW_SKIP_DYNAMO_TESTS=1 npm test   (unit-only, and you own the gap)\n`,
    );
  }

  // Set the credentials so createDynamoClient() (called by createAllTables)
  // picks up the right key. vitest test.env applies to workers, not globalSetup,
  // so we must set process.env ourselves here (respect-if-set pattern).
  const key = opts.key ?? process.env.AWS_ACCESS_KEY_ID ?? testAccessKeyId();
  const prevKey = process.env.AWS_ACCESS_KEY_ID;
  const prevSecret = process.env.AWS_SECRET_ACCESS_KEY;

  process.env.AWS_ACCESS_KEY_ID = key;
  process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? 'local';

  try {
    // createAllTables is idempotent (ensureTable skips existing tables) and
    // logs one line per table. Suppress the per-table noise and replace it
    // with a single concise summary.
    const origLog = console.log;
    const tableLines: string[] = [];
    console.log = (...args: unknown[]) => {
      const msg = args.join(' ');
      // Only suppress the db-create per-table lines (start with two spaces).
      if (msg.startsWith('  ')) {
        tableLines.push(msg.trimStart());
      } else {
        origLog(...args);
      }
    };

    try {
      await createAllTables(endpoint);
    } finally {
      console.log = origLog;
    }

    const created = tableLines.filter((l) => l.startsWith('created')).length;
    const existed = tableLines.filter((l) => l.startsWith('exists')).length;
    const shortKey = key.length > 12 ? `${key.slice(0, 12)}…` : key;
    console.log(
      `[globalSetup] ensured hc-local- tables (key=${shortKey}): ` +
        `${created} created, ${existed} already existed`,
    );
  } finally {
    // Restore original env values.
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

/**
 * Vitest globalSetup entry point.
 *
 * Returns the TEARDOWN function. Vitest has no `globalTeardown` config option -
 * it takes the teardown from whatever globalSetup returns (a `globalTeardown`
 * key in vitest.config.ts is accepted silently and never runs; verified
 * 2026-08-16 when the tables survived a run). See globalTeardown.ts for why the
 * drop exists and what it deliberately does not reclaim.
 */
export default async function setup(): Promise<() => Promise<void>> {
  await ensureKeyedLocalTables();
  return async () => {
    await dropKeyedLocalTables();
  };
}
