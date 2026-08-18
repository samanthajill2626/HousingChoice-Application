// backfill:media-pointers - one-time, IDEMPOTENT backfill of the media pointer
// index (messagesRepo MEDIA POINTERS, 2026-08-18) from the messages that
// already carry attachments.
//
// The "Media from comms" gallery now reads `media#<conversationId>` pointer
// rows instead of scanning messages; the runtime writes them with every new
// attachment (append / annotateMessage), so this exists only for attachments
// stored BEFORE the index did. Every message carrying `media_attachments` or
// the legacy `media_s3_keys` gets one pointer per stored position - plain
// puts, keyed deterministically, so re-running rewrites the same rows.
//
// Targets DYNAMODB_ENDPOINT (default DynamoDB Local) and resolves the physical
// table via lib/config.tableName (respects TABLE_PREFIX) - the same posture as
// the sibling backfills: no local-only guard, this is an ops script the human
// runs against dev and prod per the RUNBOOK with the target environment set on
// purpose.
//
// PII: logs COUNTS and ids only - never keys' contents, bodies or numbers.
//
// Run (from repo root, tsx): `tsx app/scripts/backfill-media-pointers.ts`
//   --dry-run   scan + report the plan (counts only); write NOTHING.
import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { getDocumentClient } from '../src/lib/dynamo.js';
import { logger } from '../src/lib/logger.js';
import {
  createMessagesRepo,
  mediaAttachmentsOf,
  type MessageItem,
  type MessagesRepo,
} from '../src/repos/messagesRepo.js';

export interface MediaPointerBackfillResult {
  /** Message rows carrying at least one attachment. */
  messages: number;
  /** Pointer rows written (or, on a dry run, that would be). */
  pointers: number;
}

export async function backfillMediaPointers(
  opts: {
    dryRun?: boolean;
    doc?: DynamoDBDocumentClient;
    env?: NodeJS.ProcessEnv;
    messagesRepo?: Pick<MessagesRepo, 'putMediaPointers'>;
  } = {},
): Promise<MediaPointerBackfillResult> {
  const doc = opts.doc ?? getDocumentClient();
  const env = opts.env ?? process.env;
  const table = tableName('messages', env);
  const messages = opts.messagesRepo ?? createMessagesRepo({ doc, env });
  const dryRun = opts.dryRun === true;
  const result: MediaPointerBackfillResult = { messages: 0, pointers: 0 };

  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: table,
        // Only message rows with something to index. Pointer/claim rows in the
        // synthetic partitions carry neither attribute, so they never match.
        FilterExpression: 'attribute_exists(media_attachments) OR attribute_exists(media_s3_keys)',
        ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );
    for (const raw of (page.Items ?? []) as MessageItem[]) {
      const attachments = mediaAttachmentsOf(raw);
      if (attachments.length === 0) continue;
      result.messages += 1;
      result.pointers += attachments.length;
      if (dryRun) continue;
      await messages.putMediaPointers(raw.conversationId, raw.tsMsgId, attachments);
    }
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  return result;
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('backfill-media-pointers.ts');
if (invokedDirectly) {
  const dryRun = process.argv.includes('--dry-run');
  logger.info({ dryRun }, 'backfill:media-pointers - starting');
  backfillMediaPointers({ dryRun })
    .then((result) => {
      logger.info(
        { ...result, dryRun },
        `backfill:media-pointers - done${dryRun ? ' (DRY RUN - nothing written)' : ''}`,
      );
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'backfill:media-pointers - FAILED');
      process.exitCode = 1;
    });
}
