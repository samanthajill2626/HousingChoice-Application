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

function gsiInput(gsi: GsiSpec): NonNullable<CreateTableCommandInput['GlobalSecondaryIndexes']>[number] {
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
): Promise<EnsureTableResult> {
  let result: EnsureTableResult = 'created';
  try {
    await client.send(new CreateTableCommand(toCreateTableInput(spec, physicalName)));
    await waitUntilTableExists({ client, maxWaitTime: 60 }, { TableName: physicalName });
  } catch (err) {
    if (!(err instanceof ResourceInUseException)) throw err;
    result = 'exists';
  }
  if (spec.ttlAttribute) {
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
