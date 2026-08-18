// backfill:relay-optout-flag - one-time, IDEMPOTENT backfill bringing legacy
// conversation rows onto the byRelayOptOut invariant (2026-08-18):
// `relay_optout_flag` exists IFF the row is an OPEN relay group whose
// `relay_opted_out_members` map is non-empty.
//
// The sparse byRelayOptOut GSI is keyed on `relay_optout_flag`, so a relay group
// that gained an opted-out member BEFORE this index existed carries no flag and
// is invisible to Today's "opted out of a relay group" attention pass until it
// is stamped. This stamps them. It also removes a flag from any row that
// should not carry one (a closed group, an empty map) so a stray flag never
// sits on the index costing a read per Today load.
//
// Rows already in the right state are skipped, and every write is CONDITIONAL
// on the state the planner decided from, so re-running is always safe and a
// concurrent run (or the runtime's own writes) cannot be double-applied.
//
// Targets DYNAMODB_ENDPOINT (default DynamoDB Local) and resolves the physical
// table via lib/config.tableName (respects TABLE_PREFIX) - the same posture as
// backfill-unread-flag.ts, deliberately: no local-only guard, this is an ops
// script the human runs against dev and prod per the RUNBOOK with the target
// environment set on purpose.
//
// PII: logs COUNTS and conversationIds only.
//
// Run (from repo root, tsx): `tsx app/scripts/backfill-relay-optout-flag.ts`
//   --dry-run   scan + report the plan (counts only); write NOTHING.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { getDocumentClient } from '../src/lib/dynamo.js';
import { logger } from '../src/lib/logger.js';
import { RELAY_OPTOUT_FLAG_VALUE, type ConversationItem } from '../src/repos/conversationsRepo.js';

export type RelayOptOutBackfillAction = 'stamp' | 'remove' | 'skip';

/**
 * What one row needs. PURE, so it is unit-testable without DynamoDB:
 *   - an OPEN relay group with a non-empty map and no flag -> stamp;
 *   - any row carrying the flag that is not that -> remove;
 *   - everything else -> skip.
 */
export function planRelayOptOutBackfill(row: Partial<ConversationItem>): RelayOptOutBackfillAction {
  const map = row.relay_opted_out_members;
  const nonEmpty = map !== undefined && map !== null && Object.keys(map).length > 0;
  const shouldFlag = row.type === 'relay_group' && row.status === 'open' && nonEmpty;
  const flagged = row.relay_optout_flag === RELAY_OPTOUT_FLAG_VALUE;
  if (shouldFlag && !flagged) return 'stamp';
  if (!shouldFlag && flagged) return 'remove';
  return 'skip';
}

export interface RelayOptOutBackfillResult {
  scanned: number;
  stamped: number;
  removed: number;
  skipped: number;
  /** Writes whose condition failed because the row moved under the run. */
  skippedOnCondition: { stamp: number; remove: number };
}

export async function backfillRelayOptOutFlag(
  opts: { dryRun?: boolean; doc?: DynamoDBDocumentClient; env?: NodeJS.ProcessEnv } = {},
): Promise<RelayOptOutBackfillResult> {
  const doc = opts.doc ?? getDocumentClient();
  const env = opts.env ?? process.env;
  const table = tableName('conversations', env);
  const dryRun = opts.dryRun === true;
  const result: RelayOptOutBackfillResult = {
    scanned: 0,
    stamped: 0,
    removed: 0,
    skipped: 0,
    skippedOnCondition: { stamp: 0, remove: 0 },
  };

  const stamp = async (conversationId: unknown): Promise<void> => {
    await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { conversationId },
        UpdateExpression: 'SET relay_optout_flag = :flag',
        // The state the decision was made from: still an OPEN relay group,
        // still carrying a non-empty map, still unflagged. A row that closed or
        // emptied under the run is left alone (the runtime already handled it).
        ConditionExpression:
          'attribute_exists(conversationId) AND attribute_not_exists(relay_optout_flag) AND #t = :relay AND #s = :open AND size(relay_opted_out_members) > :zero',
        ExpressionAttributeNames: { '#t': 'type', '#s': 'status' },
        ExpressionAttributeValues: {
          ':flag': RELAY_OPTOUT_FLAG_VALUE,
          ':relay': 'relay_group',
          ':open': 'open',
          ':zero': 0,
        },
      }),
    );
  };

  const remove = async (conversationId: unknown): Promise<void> => {
    await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { conversationId },
        UpdateExpression: 'REMOVE relay_optout_flag',
        // Only while it is STILL wrongly flagged: not open, or map empty/absent.
        ConditionExpression:
          'attribute_exists(conversationId) AND attribute_exists(relay_optout_flag) AND ' +
          '(#s <> :open OR attribute_not_exists(relay_opted_out_members) OR size(relay_opted_out_members) = :zero)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':open': 'open', ':zero': 0 },
      }),
    );
  };

  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: table,
        // Only rows that can matter: relay groups (any status) and any row that
        // carries the flag. Everything else is skipped server-side.
        FilterExpression: '#t = :relay OR attribute_exists(relay_optout_flag)',
        ExpressionAttributeNames: { '#t': 'type' },
        ExpressionAttributeValues: { ':relay': 'relay_group' },
        ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );
    for (const raw of (page.Items ?? []) as ConversationItem[]) {
      result.scanned += 1;
      const action = planRelayOptOutBackfill(raw);
      if (action === 'skip') {
        result.skipped += 1;
        continue;
      }
      if (dryRun) {
        if (action === 'stamp') result.stamped += 1;
        else result.removed += 1;
        continue;
      }
      try {
        if (action === 'stamp') {
          await stamp(raw.conversationId);
          result.stamped += 1;
        } else {
          await remove(raw.conversationId);
          result.removed += 1;
        }
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        result.skippedOnCondition[action] += 1;
        logger.info({ conversationId: raw.conversationId, action }, 'backfill:relay-optout-flag - row moved under the run; skipped');
      }
    }
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  return result;
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('backfill-relay-optout-flag.ts');
if (invokedDirectly) {
  const dryRun = process.argv.includes('--dry-run');
  logger.info({ dryRun }, 'backfill:relay-optout-flag - starting');
  backfillRelayOptOutFlag({ dryRun })
    .then((result) => {
      logger.info(
        { ...result, dryRun },
        `backfill:relay-optout-flag - done${dryRun ? ' (DRY RUN - nothing written)' : ''}`,
      );
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'backfill:relay-optout-flag - FAILED');
      process.exitCode = 1;
    });
}
