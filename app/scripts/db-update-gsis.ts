// db:update-gsis - add MISSING GSIs to existing local tables, WITHOUT dropping
// them (design 2026-08-16 section 7.3).
//
// Why this exists: `ensureTable` is CREATE-ONLY - on ResourceInUseException it
// reports 'exists' and touches nothing - so a table created before a new GSI
// landed in lib/tables.ts NEVER gains that index. The only existing remedy is
// `db:create --reset`, which DROPS every table and would destroy the human's
// imported local dataset. This is the no-data-loss path: it diffs each live
// table's indexes against its TableSpec and CREATEs only what is missing.
//
// LOCAL ONLY, hard-gated to a localhost DynamoDB Local endpoint (the same guard
// db-create's --reset uses). In AWS the tables are owned by Terraform (M0.4):
// a deployed env gets its indexes from `npm run plan` / `npm run apply`, never
// from this script. Note this is the OPPOSITE posture to the backfills, which
// deliberately target the ambient env because the human runs them on dev/prod.
//
// Idempotent: a table that already carries every spec'd index is reported `ok`
// and left alone, so re-running is always safe.
//
// DynamoDB allows exactly ONE GSI create per UpdateTable call, so missing
// indexes are added one at a time, waiting for the table to go ACTIVE between
// creates.
//
// Run from the repo root: `npm run db:update-gsis` (tsx).
import {
  DescribeTableCommand,
  ResourceNotFoundException,
  UpdateTableCommand,
  waitUntilTableExists,
  type AttributeDefinition,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { tableName } from '../src/lib/config.js';
import { createDynamoClient } from '../src/lib/dynamo.js';
import { gsiInput } from '../src/lib/dynamoAdmin.js';
import { TABLES, type GsiSpec, type TableSpec } from '../src/lib/tables.js';
import { isLocalEndpoint, LOCAL_DEFAULT_ENDPOINT } from './db-create.js';

/**
 * The AttributeDefinitions UpdateTable needs for ONE new index.
 *
 * UpdateTable requires definitions covering the new index's key attributes -
 * and ONLY attributes that some key schema actually uses, so the whole-table
 * set `toCreateTableInput` passes is the wrong shape here (it would name
 * attributes belonging to other, already-existing indexes). Built from the same
 * `{ name, type }` KeyAttribute mapping CreateTable uses, so the two paths
 * cannot describe the same attribute differently.
 */
export function gsiAttributeDefinitions(gsi: GsiSpec): AttributeDefinition[] {
  const attrs = [gsi.hashKey, ...(gsi.rangeKey ? [gsi.rangeKey] : [])];
  return attrs.map((attr) => ({ AttributeName: attr.name, AttributeType: attr.type }));
}

/**
 * Send an UpdateTable, retrying DynamoDB Local's `InternalFailure`.
 *
 * LOCAL-ONLY HAZARD, not an API contract issue. Under concurrent load the
 * DynamoDB Local container answers UpdateTable with:
 *
 *   InternalFailure: The request processing has failed because of an unknown
 *   error, exception or failure.
 *
 * It is the container buckling, not a rejected request - the same call succeeds
 * moments later, and running the suite alone is green. The AWS SDK's default
 * retry policy does NOT cover this code, so it escapes to the caller and fails
 * whatever gate is running. That is suite B of
 * docs/issues/npm-test-dynamodb-local-contention.md, and it is one of the two
 * reasons `npm test` could not be trusted.
 *
 * Retrying is safe here specifically because this path is idempotent by
 * construction: `ensureGsis` re-reads the live index set and only creates what
 * is missing, so a retry of a call that actually succeeded finds the index
 * present and does nothing. Against real AWS this code is never reached
 * (hard-gated to a localhost endpoint), so the retry cannot mask a production
 * fault.
 */
async function sendWithInternalFailureRetry(
  client: DynamoDBClient,
  build: () => UpdateTableCommand,
  attempts = 4,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.send(build());
      return;
    } catch (err) {
      const name = (err as { name?: string }).name ?? '';
      const retryable = name === 'InternalFailure' || name === 'InternalServerError';
      if (!retryable || attempt >= attempts) throw err;
      // Linear backoff: the container needs a moment, not an exponential one.
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
}

export interface EnsureGsisResult {
  /** `<table>.<index>` for every index this run created. */
  added: string[];
  /** Physical names of tables that already carried every spec'd index. */
  unchanged: string[];
  /** Physical names of tables that do not exist yet (db:create owns those). */
  missingTables: string[];
}

/**
 * Wait until a just-created index reports ACTIVE.
 *
 * `waitUntilTableExists` is NOT sufficient here and the difference is not
 * theoretical: adding a GSI leaves the TABLE status ACTIVE while the INDEX
 * backfills, so the table waiter returns immediately and the very next
 * UpdateTable in the loop is rejected (a table may have only one index
 * building at a time). Verified against DynamoDB Local, which reports the
 * freshly created index as `CREATING` the instant the table waiter returns.
 */
async function waitUntilIndexActive(
  client: DynamoDBClient,
  physicalName: string,
  indexName: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  // Generous by design: a GSI create BACKFILLS the whole table, so on a local
  // table with real imported data - or on a busy DynamoDB Local shared with
  // other work - this legitimately takes minutes. Giving up early would leave
  // the operator thinking the index failed when it is still building.
  const timeoutMs = opts.timeoutMs ?? 900_000;
  const pollMs = opts.pollMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { Table } = await client.send(new DescribeTableCommand({ TableName: physicalName }));
    const status = (Table?.GlobalSecondaryIndexes ?? []).find(
      (gsi) => gsi.IndexName === indexName,
    )?.IndexStatus;
    if (status === 'ACTIVE') return;
    if (Date.now() >= deadline) {
      throw new Error(
        `db:update-gsis: ${physicalName}.${indexName} is still ${status ?? 'absent'} after ${timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** The index names currently live on a table, or undefined when it is absent. */
async function liveIndexNames(
  client: DynamoDBClient,
  physicalName: string,
): Promise<Set<string> | undefined> {
  try {
    const { Table } = await client.send(new DescribeTableCommand({ TableName: physicalName }));
    return new Set(
      (Table?.GlobalSecondaryIndexes ?? [])
        .map((gsi) => gsi.IndexName)
        .filter((name): name is string => typeof name === 'string'),
    );
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return undefined;
    throw err;
  }
}

/**
 * Add every GSI a spec declares but its live table lacks. Pure diff + create:
 * an index that already exists is never touched, and nothing is ever dropped
 * (an EXTRA live index the spec no longer declares is left alone - removing it
 * is a destructive decision this script deliberately does not make).
 */
export async function ensureGsis(
  client: DynamoDBClient,
  specs: readonly TableSpec[] = TABLES,
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = console.log,
): Promise<EnsureGsisResult> {
  const result: EnsureGsisResult = { added: [], unchanged: [], missingTables: [] };

  for (const spec of specs) {
    const physicalName = tableName(spec.baseName, env);
    const live = await liveIndexNames(client, physicalName);
    if (live === undefined) {
      result.missingTables.push(physicalName);
      log(`  absent   ${physicalName} - run db:create first`);
      continue;
    }

    const missing = spec.gsis.filter((gsi) => !live.has(gsi.indexName));
    if (missing.length === 0) {
      result.unchanged.push(physicalName);
      log(`  ok       ${physicalName}`);
      continue;
    }

    // ONE create per UpdateTable call, and the new INDEX (not just the table)
    // must finish before the next create is accepted.
    for (const gsi of missing) {
      await sendWithInternalFailureRetry(client, () =>
        new UpdateTableCommand({
          TableName: physicalName,
          AttributeDefinitions: gsiAttributeDefinitions(gsi),
          GlobalSecondaryIndexUpdates: [{ Create: gsiInput(gsi) }],
        }),
      );
      await waitUntilTableExists({ client, maxWaitTime: 120 }, { TableName: physicalName });
      await waitUntilIndexActive(client, physicalName, gsi.indexName);
      result.added.push(`${physicalName}.${gsi.indexName}`);
      log(`  added    ${physicalName}.${gsi.indexName}`);
    }
  }

  return result;
}

// CLI guard: only run as a script when invoked directly (not when imported by a
// test). The URL-normalizing form, copied from db-create.ts - it handles the
// Windows backslash argv this repo's dev loop produces.
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
  if (!isLocalEndpoint(endpoint)) {
    console.error(
      `db:update-gsis alters live table schemas and is only allowed against a localhost ` +
        `DynamoDB Local endpoint; refusing to run at ${endpoint}. In AWS, Terraform owns ` +
        `the indexes (npm run plan / npm run apply).`,
    );
    process.exit(1);
  }
  const client = createDynamoClient({ endpoint });
  try {
    console.log(`db:update-gsis - reconciling ${TABLES.length} tables at ${endpoint}`);
    const result = await ensureGsis(client);
    console.log(
      `db:update-gsis - done: ${result.added.length} index(es) added, ` +
        `${result.unchanged.length} table(s) already current, ` +
        `${result.missingTables.length} table(s) absent`,
    );
  } catch (err) {
    console.error('db:update-gsis failed - is DynamoDB Local up? (npm run db:start)');
    console.error(err);
    process.exit(1);
  } finally {
    client.destroy();
  }
}
