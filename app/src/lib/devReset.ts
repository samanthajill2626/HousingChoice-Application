// Dev-only: wipe the hermetic local DynamoDB to a clean, freshly-seeded slate.
// HARD safety guard: refuses to run against anything but a hc-local- + local
// endpoint stack, so it can never touch dev-cloud or prod tables even if the
// gated endpoint were somehow reached.
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { seedAll, seedInboundVoiceLineFromFounderCell } from './seedData.js';
import { tableName, type AppConfig } from './config.js';
import { createDynamoClient, createDocumentClient } from './dynamo.js';
import { TABLES } from './tables.js';
import { OUTBOX_TABLE_BASE } from '../adapters/recordingMessaging.js';
import { logger as defaultLogger, type Logger } from './logger.js';

async function clearTable(
  doc: DynamoDBDocumentClient,
  client: ReturnType<typeof createDynamoClient>,
  physical: string,
): Promise<void> {
  let keyNames: string[];
  try {
    const desc = await client.send(new DescribeTableCommand({ TableName: physical }));
    keyNames = (desc.Table?.KeySchema ?? []).map((k) => k.AttributeName!).filter(Boolean);
  } catch {
    return; // table doesn't exist (e.g. outbox never created) — nothing to clear
  }
  let startKey: Record<string, unknown> | undefined;
  do {
    const scan = await doc.send(new ScanCommand({ TableName: physical, ExclusiveStartKey: startKey }));
    const items = scan.Items ?? [];
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25).map((it) => ({
        DeleteRequest: { Key: Object.fromEntries(keyNames.map((k) => [k, it[k]])) },
      }));
      if (batch.length === 0) continue;
      let requestItems: typeof batch = batch;
      for (let attempt = 0; attempt < 5 && requestItems.length > 0; attempt++) {
        const res = await doc.send(new BatchWriteCommand({ RequestItems: { [physical]: requestItems } }));
        requestItems = (res.UnprocessedItems?.[physical] ?? []) as typeof batch;
      }
    }
    startKey = scan.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
}

export async function resetLocalData(deps: { config: AppConfig; logger?: Logger }): Promise<void> {
  const { config } = deps;
  const log = deps.logger ?? defaultLogger;
  const prefix = tableName(''); // the TABLE_PREFIX
  // Safety guard: only allow reseed against a hermetic local DynamoDB stack.
  // The prefix must be the lane-0 dev prefix (hc-local-) OR a per-lane e2e
  // prefix (hc-local-<N>- where N is a positive integer). This prevents
  // accidental resets against dev-cloud or production tables.
  const isHermeticPrefix = prefix === 'hc-local-' || /^hc-local-\d+-$/.test(prefix);
  if (!config.dynamodbEndpoint || !isHermeticPrefix) {
    throw new Error(
      `resetLocalData refused: not a hermetic local stack (endpoint=${config.dynamodbEndpoint ?? 'unset'}, prefix=${prefix}).`,
    );
  }
  const client = createDynamoClient({ config });
  const doc = createDocumentClient({ config });
  const bases = [...TABLES.map((t) => t.baseName), OUTBOX_TABLE_BASE];
  for (const base of bases) {
    await clearTable(doc, client, tableName(base));
  }
  const count = await seedAll(config.dynamodbEndpoint);
  // Voice Phase 1 (spec §6): migrate FOUNDER_CELL → the inbound-voice-line
  // holder on the data model (idempotent; no-op when founderCell is unset).
  const stampedInboundLine = await seedInboundVoiceLineFromFounderCell(
    config.dynamodbEndpoint,
    config.founderCell,
  );
  log.info(
    { tables: bases.length, seeded: count, inboundVoiceLineStamped: stampedInboundLine },
    'resetLocalData: cleared + reseeded',
  );
}
