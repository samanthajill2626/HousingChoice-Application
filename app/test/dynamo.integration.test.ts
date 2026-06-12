// M0.3 integration test against DynamoDB Local.
//
// Self-skipping: when nothing answers at DYNAMODB_ENDPOINT (default
// http://localhost:8000), the whole suite is skipped with a notice so
// `npm test` stays green without Docker. Start the container with
// `npm run db:start` to make this suite run for real.
//
// When live: creates all 9 tables under a throwaway hc-test-<random>- prefix,
// verifies idempotent re-create, writes a contact, queries it back via the
// byPhone GSI, then deletes the throwaway tables.
import { randomUUID } from 'node:crypto';
import { QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec, TABLES } from '../src/lib/tables.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

async function endpointReachable(): Promise<boolean> {
  try {
    // DynamoDB Local answers any HTTP request (400 for a bare GET) once up.
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

const reachable = await endpointReachable();
if (!reachable) {
  console.warn(
    `[dynamo.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('DynamoDB Local integration (throwaway prefix)', () => {
  // Throwaway prefix so this suite never touches hc-local-* dev data.
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });

  beforeAll(async () => {
    for (const spec of TABLES) {
      const result = await ensureTable(client, spec, tableName(spec.baseName, testEnv));
      expect(result).toBe('created');
    }
  }, 120_000);

  afterAll(async () => {
    for (const spec of TABLES) {
      await deleteTableIfExists(client, tableName(spec.baseName, testEnv));
    }
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('ensureTable is idempotent (re-run reports exists, no error)', async () => {
    const contacts = getTableSpec('contacts');
    await expect(ensureTable(client, contacts, tableName('contacts', testEnv))).resolves.toBe(
      'exists',
    );
  });

  it('puts a contact and finds it via the byPhone GSI', async () => {
    const table = tableName('contacts', testEnv);
    const contact = {
      contactId: 'contact-it-0001',
      type: 'tenant',
      status: 'active',
      phone: '+15550109999',
      first_name: 'Integration',
      last_name: 'Test',
    };
    await doc.send(new PutCommand({ TableName: table, Item: contact }));

    const { Items } = await doc.send(
      new QueryCommand({
        TableName: table,
        IndexName: 'byPhone',
        KeyConditionExpression: 'phone = :p',
        ExpressionAttributeValues: { ':p': contact.phone },
      }),
    );
    expect(Items).toHaveLength(1);
    expect(Items?.[0]).toMatchObject(contact); // projection ALL -> full item
  });
});
