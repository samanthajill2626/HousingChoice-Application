// Table administration helpers built on lib/tables.ts — used by the dev-loop
// creation script (app/scripts/db-create.ts) and the integration tests.
//
// These are LOCAL/DEV tooling only: in AWS the tables are created and owned by
// Terraform (M0.4), which must mirror lib/tables.ts exactly. Nothing in the
// app's request path calls these.
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTimeToLiveCommand,
  ResourceInUseException,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
  type CreateTableCommandInput,
  type DynamoDBClient,
  type KeySchemaElement,
} from '@aws-sdk/client-dynamodb';
import type { GsiSpec, KeyAttribute, TableSpec } from './tables.js';

function keySchema(hashKey: KeyAttribute, rangeKey?: KeyAttribute): KeySchemaElement[] {
  return [
    { AttributeName: hashKey.name, KeyType: 'HASH' },
    ...(rangeKey ? [{ AttributeName: rangeKey.name, KeyType: 'RANGE' as const }] : []),
  ];
}

/** Every distinct attribute referenced by the table key or any GSI key. */
function attributeDefinitions(spec: TableSpec): CreateTableCommandInput['AttributeDefinitions'] {
  const attrs = new Map<string, KeyAttribute>();
  const add = (attr?: KeyAttribute): void => {
    if (attr) attrs.set(attr.name, attr);
  };
  add(spec.hashKey);
  add(spec.rangeKey);
  for (const gsi of spec.gsis) {
    add(gsi.hashKey);
    add(gsi.rangeKey);
  }
  return [...attrs.values()].map((a) => ({ AttributeName: a.name, AttributeType: a.type }));
}

/**
 * Pure converter: GsiSpec -> the index input shape. Exported because
 * app/scripts/db-update-gsis.ts passes the SAME object to UpdateTable's
 * `GlobalSecondaryIndexUpdates: [{ Create: ... }]`, and the two paths must
 * never drift on key schema or projection.
 */
export function gsiInput(
  gsi: GsiSpec,
): NonNullable<CreateTableCommandInput['GlobalSecondaryIndexes']>[number] {
  return {
    IndexName: gsi.indexName,
    KeySchema: keySchema(gsi.hashKey, gsi.rangeKey),
    // Projection ALL is part of the M0.3 contract (document-style items).
    Projection: { ProjectionType: 'ALL' },
  };
}

/** Pure converter: TableSpec -> CreateTable input (also unit-tested). */
export function toCreateTableInput(spec: TableSpec, physicalName: string): CreateTableCommandInput {
  return {
    TableName: physicalName,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: keySchema(spec.hashKey, spec.rangeKey),
    AttributeDefinitions: attributeDefinitions(spec),
    ...(spec.gsis.length > 0 ? { GlobalSecondaryIndexes: spec.gsis.map(gsiInput) } : {}),
    ...(spec.stream
      ? { StreamSpecification: { StreamEnabled: true, StreamViewType: spec.stream } }
      : {}),
  };
}

export type EnsureTableResult = 'created' | 'exists';

/**
 * Idempotently create the table (plus TTL setting) for a spec. Safe to re-run:
 * existing tables are left untouched and reported as 'exists'.
 */
export async function ensureTable(
  client: DynamoDBClient,
  spec: TableSpec,
  physicalName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnsureTableResult> {
  let result: EnsureTableResult = 'created';
  try {
    await client.send(new CreateTableCommand(toCreateTableInput(spec, physicalName)));
    await waitUntilTableExists({ client, maxWaitTime: 60 }, { TableName: physicalName });
  } catch (err) {
    if (!(err instanceof ResourceInUseException)) throw err;
    result = 'exists';
  }
  // TTL IS A TIME BOMB IN TESTS, so it is opt-OUT-able for them.
  //
  // A test that pins a PAST clock and writes a TTL-bearing row is writing a row
  // that is born already expired, because services derive `expires_at` from
  // their injected clock. DynamoDB Local really does reap, on its own schedule,
  // so the row vanishes mid-test and an assertion about its continued existence
  // fails - intermittently, and only from the date the pinned clock plus the
  // retention window falls behind real time.
  //
  // That is not hypothetical. groupCrossCheck.test.ts pinned 2026-08-11 with a
  // 7-day window, so from 2026-08-18 its dedupe markers were born expired and
  // "a DUPLICATE redelivery is deduped" began failing ~10% of runs - a suite
  // that had been stable for months started rotting on a date, and it was
  // misfiled as container contention for three days.
  // aiRunsRepo.integration.test.ts has the identical fuse set for 2026-11-04.
  //
  // No test anywhere asserts that TTL is ENABLED on a live table (the ai-runs
  // suite asserts the attribute VALUE, which does not need the reaper), so the
  // reaper buys tests nothing and costs them this. It stays ON everywhere else:
  // db:create, e2e lanes and every deployed path leave the flag unset.
  //
  // See docs/issues/npm-test-dynamodb-local-contention.md.
  const ttlDisabled = env['DYNAMO_DISABLE_TTL'] === '1';
  if (spec.ttlAttribute && !ttlDisabled) {
    await enableTtlIfNeeded(client, physicalName, spec.ttlAttribute);
  }
  return result;
}

async function enableTtlIfNeeded(
  client: DynamoDBClient,
  physicalName: string,
  ttlAttribute: string,
): Promise<void> {
  const { TimeToLiveDescription: ttl } = await client.send(
    new DescribeTimeToLiveCommand({ TableName: physicalName }),
  );
  if (ttl?.TimeToLiveStatus === 'ENABLED' || ttl?.TimeToLiveStatus === 'ENABLING') return;
  await client.send(
    new UpdateTimeToLiveCommand({
      TableName: physicalName,
      TimeToLiveSpecification: { AttributeName: ttlAttribute, Enabled: true },
    }),
  );
}

/** Delete a table, tolerating absence (integration-test cleanup). */
export async function deleteTableIfExists(
  client: DynamoDBClient,
  physicalName: string,
): Promise<void> {
  try {
    await client.send(new DeleteTableCommand({ TableName: physicalName }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }
}
