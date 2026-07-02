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
// Fail-soft: if DynamoDB Local is unreachable (Docker down), a clear
// console.warn is emitted and setup returns — pure-unit test runs are
// unaffected. Integration tests that actually need the DB will skip or fail
// naturally via their own endpoint-reachability checks.
//
// Local-only guard: we refuse (skip with a console.warn) for any non-localhost
// endpoint. The guard is the point — this setup NEVER creates tables against
// AWS.

import { testAccessKeyId } from '../../e2e/support/lane.mjs';
import { createAllTables, isLocalEndpoint, LOCAL_DEFAULT_ENDPOINT } from '../scripts/db-create.js';

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

  // Reachability probe — if Docker is down, warn and bail so pure-unit runs pass.
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
  } catch {
    console.warn(
      `[globalSetup] DynamoDB Local not reachable at ${endpoint} — skipping table bootstrap. ` +
        `Integration tests will fail until Docker is running (npm run db:start).`,
    );
    return;
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

/** Vitest globalSetup entry point. */
export default async function setup(): Promise<void> {
  await ensureKeyedLocalTables();
}
