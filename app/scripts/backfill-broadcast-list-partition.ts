// backfill:broadcast-list-partition — one-time, IDEMPOTENT backfill stamping
// `_listPartition = 'broadcasts'` (the byCreated GSI hash) on every broadcast
// row created BEFORE the byCreated migration (2026-07-08, the team-wide list).
// Un-stamped rows are invisible to the dashboard's Broadcasts list (all tabs)
// — they stay readable by id and via byUnit — so run this once per env right
// after the byCreated GSI is applied.
//
// Rows that ALREADY carry `_listPartition` are skipped, and the write itself is
// conditional on the attribute still being absent — re-running is always safe.
//
// Targets DYNAMODB_ENDPOINT (default DynamoDB Local). Against a deployed env it
// resolves the physical table via lib/config.tableName (respects TABLE_PREFIX).
//
// PII: logs COUNTS and broadcastIds only — never bodies/audiences/recipients.
//
// Run (from repo root, tsx): `tsx app/scripts/backfill-broadcast-list-partition.ts`
//   --dry-run   scan + report the plan (counts only); write NOTHING.
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { getDocumentClient } from '../src/lib/dynamo.js';
import { logger } from '../src/lib/logger.js';
import { LIST_PARTITION } from '../src/repos/broadcastsRepo.js';

interface BackfillResult {
  scanned: number;
  updated: number;
  skipped: number;
}

/**
 * Scan the broadcasts table and stamp `_listPartition` on every row that lacks
 * it. When dryRun, counts what WOULD be written but writes nothing.
 */
export async function backfillBroadcastListPartition(
  opts: { dryRun?: boolean } = {},
): Promise<BackfillResult> {
  const doc = getDocumentClient();
  const table = tableName('broadcasts');
  const dryRun = opts.dryRun === true;

  const result: BackfillResult = { scanned: 0, updated: 0, skipped: 0 };
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const { Items, LastEvaluatedKey } = await doc.send(
      new ScanCommand({
        TableName: table,
        ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );
    for (const item of (Items ?? []) as Array<Record<string, unknown>>) {
      result.scanned += 1;
      // Idempotent: never touch a row that is already stamped.
      if (item['_listPartition'] === LIST_PARTITION) {
        result.skipped += 1;
        continue;
      }
      if (!dryRun) {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { broadcastId: item['broadcastId'] },
            UpdateExpression: 'SET #p = :p',
            // Belt-and-braces idempotency at the WRITE (a concurrent run can't
            // double-stamp): only set while the attribute is still absent.
            ConditionExpression: 'attribute_not_exists(#p)',
            ExpressionAttributeNames: { '#p': '_listPartition' },
            ExpressionAttributeValues: { ':p': LIST_PARTITION },
          }),
        );
      }
      result.updated += 1;
    }
    exclusiveStartKey = LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  return result;
}

// --- Runnable entrypoint (skipped when imported by tests) ------------------
// tsx runs this file as the process entry; import.meta guards the side effects.
const isEntrypoint =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('backfill-broadcast-list-partition.ts');
if (isEntrypoint) {
  const dryRun = process.argv.includes('--dry-run');
  logger.info({ dryRun }, 'backfill:broadcast-list-partition — starting');
  backfillBroadcastListPartition({ dryRun })
    .then((r) => {
      logger.info(
        { scanned: r.scanned, updated: r.updated, skipped: r.skipped, dryRun },
        `backfill:broadcast-list-partition — done${dryRun ? ' (DRY RUN — nothing written)' : ''}`,
      );
    })
    .catch((err) => {
      logger.error({ err }, 'backfill:broadcast-list-partition — FAILED');
      process.exit(1);
    });
}
