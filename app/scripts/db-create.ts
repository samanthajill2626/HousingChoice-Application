// db:create — create all 9 tables (lib/tables.ts) against DynamoDB Local.
//
// Idempotent: existing tables are skipped (logged), so re-running is always
// safe. Targets DYNAMODB_ENDPOINT (default http://localhost:8000) — this
// script NEVER creates tables in AWS; Terraform owns those (M0.4).
// Run from the repo root: `npm run db:create` (tsx).
//
// --reset  DROP every table first, then recreate it empty — for a guaranteed
//          clean slate (no leftover items from a prior seed). DESTRUCTIVE, so
//          it is hard-gated to a localhost DynamoDB Local endpoint and refuses
//          to run against anything else. Used by `npm run dev -- --local`
//          (without --seeded) to start from zero.
import { waitUntilTableNotExists } from '@aws-sdk/client-dynamodb';
import { createDynamoClient } from '../src/lib/dynamo.js';
import { tableName } from '../src/lib/config.js';
import { ensureTable, deleteTableIfExists } from '../src/lib/dynamoAdmin.js';
import { TABLES } from '../src/lib/tables.js';

export const LOCAL_DEFAULT_ENDPOINT = 'http://localhost:8000';

/** True only for a DynamoDB Local endpoint on this machine. */
export function isLocalEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

export async function createAllTables(endpoint: string): Promise<void> {
  const client = createDynamoClient({ endpoint });
  try {
    for (const spec of TABLES) {
      const physicalName = tableName(spec.baseName);
      const result = await ensureTable(client, spec, physicalName);
      const detail = [
        `${spec.gsis.length} GSI${spec.gsis.length === 1 ? '' : 's'}`,
        ...(spec.stream ? [`stream ${spec.stream}`] : []),
        ...(spec.ttlAttribute ? [`TTL ${spec.ttlAttribute}`] : []),
      ].join(', ');
      console.log(
        result === 'created'
          ? `  created  ${physicalName} (${detail})`
          : `  exists   ${physicalName} — skipped`,
      );
    }
  } finally {
    client.destroy();
  }
}

/**
 * Drop every table (tolerating absence), waiting for each deletion to finish so
 * the immediate recreate can't race a still-deleting table. LOCAL ONLY — the
 * caller must guard the endpoint; this is destructive.
 */
export async function dropAllTables(endpoint: string): Promise<void> {
  const client = createDynamoClient({ endpoint });
  try {
    for (const spec of TABLES) {
      const physicalName = tableName(spec.baseName);
      await deleteTableIfExists(client, physicalName);
      await waitUntilTableNotExists({ client, maxWaitTime: 60 }, { TableName: physicalName });
      console.log(`  dropped  ${physicalName}`);
    }
  } finally {
    client.destroy();
  }
}

// CLI guard: only run as a script when invoked directly (not when imported as a
// module by globalSetup or other importers). Mirrors the pattern used in lane.mjs.
// This preserves the existing CLI behavior while making the exports importable
// without side effects.
const moduleUrl = import.meta.url;
let argvUrl: string | undefined;
try {
  argvUrl = process.argv[1]
    ? new URL(
        process.argv[1].startsWith('file:')
          ? process.argv[1]
          : `file:///${process.argv[1].replace(/\\/g, '/')}`,
      ).href
    : undefined;
} catch {
  argvUrl = undefined;
}

if (argvUrl && moduleUrl === argvUrl) {
  const endpoint = process.env.DYNAMODB_ENDPOINT ?? LOCAL_DEFAULT_ENDPOINT;
  const reset = process.argv.includes('--reset');
  try {
    if (reset) {
      if (!isLocalEndpoint(endpoint)) {
        throw new Error(
          `--reset is destructive and only allowed against a localhost DynamoDB Local ` +
            `endpoint; refusing to drop tables at ${endpoint}`,
        );
      }
      console.log(`db:create — RESET: dropping ${TABLES.length} tables at ${endpoint}`);
      await dropAllTables(endpoint);
    }
    console.log(`db:create — ensuring ${TABLES.length} tables at ${endpoint}`);
    await createAllTables(endpoint);
    console.log('db:create — done');
  } catch (err) {
    console.error('db:create failed — is DynamoDB Local up? (npm run db:start)');
    console.error(err);
    process.exit(1);
  }
}
