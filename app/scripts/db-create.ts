// db:create — create all 9 tables (lib/tables.ts) against DynamoDB Local.
//
// Idempotent: existing tables are skipped (logged), so re-running is always
// safe. Targets DYNAMODB_ENDPOINT (default http://localhost:8000) — this
// script NEVER creates tables in AWS; Terraform owns those (M0.4).
// Run from the repo root: `npm run db:create` (tsx).
import { createDynamoClient } from '../src/lib/dynamo.js';
import { tableName } from '../src/lib/config.js';
import { ensureTable } from '../src/lib/dynamoAdmin.js';
import { TABLES } from '../src/lib/tables.js';

export const LOCAL_DEFAULT_ENDPOINT = 'http://localhost:8000';

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

const endpoint = process.env.DYNAMODB_ENDPOINT ?? LOCAL_DEFAULT_ENDPOINT;
console.log(`db:create — ensuring ${TABLES.length} tables at ${endpoint}`);
try {
  await createAllTables(endpoint);
  console.log('db:create — done');
} catch (err) {
  console.error('db:create failed — is DynamoDB Local up? (npm run db:start)');
  console.error(err);
  process.exit(1);
}
