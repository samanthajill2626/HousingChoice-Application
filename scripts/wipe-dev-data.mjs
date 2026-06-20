// Wipe the DEPLOYED AWS **dev** environment back to an empty, clean slate —
// deleting DATA only, never infrastructure or secrets. Powers:
//
//   npm run wipe:dev              DRY RUN (default) — list exactly what WOULD be
//                                 deleted (counts only), touch nothing.
//   npm run wipe:dev -- --yes     EXECUTE the wipe (destructive).
//   npm run wipe:dev -- --help    usage.
//
// What it WIPES (in the pinned HousingChoice dev account, hc-dev-*):
//   - DynamoDB: every ITEM in the 14 app tables (the tables themselves stay —
//     they are Terraform-managed with deletion_protection on; we only clear rows).
//   - S3: every OBJECT **and version + delete-marker** in the media bucket
//     (the bucket is versioned; the bucket itself stays).
//   - SQS: the jobs queue + its DLQ are PURGED.
//   - CloudWatch Logs: the log STREAMS in the app/worker groups are deleted
//     (the log GROUPS stay — they are Terraform-managed).
//
// After the wipe (and ONLY then), it RE-INVITES the operator
// (cameron@abt-industries.com, admin) so login still works — auth is invite-
// gated, and the wipe empties the users table. No other seed/fixture data.
//
// What it NEVER touches (PRESERVE):
//   - SSM Parameter Store (/hc/dev/app/* — Twilio/Google/VAPID/session secrets
//     AND the Terraform-managed config). These are deployment artifacts, not data.
//   - Any Terraform-managed resource DEFINITION (tables, bucket, queues, log
//     groups, IAM, EC2, CloudFront, …). We delete CONTENTS, not resources.
//   - prod. The target env is HARD-PINNED to `dev`; there is no prod path here.
//
// Safety rails:
//   - assertHousingChoiceAccount() FIRST — every client is bound to the named
//     `housingchoice` profile and we refuse unless the caller resolves to the
//     pinned HC account (Cameron's default chain is an UNRELATED account).
//   - DRY RUN is the DEFAULT; deleting requires an explicit `--yes`.
//   - Only the KNOWN 14 app tables are targeted (never "all hc-dev-*"), so a TF
//     lock/state table or anything else can't be caught in the blast radius.
//   - Missing resources (env not deployed) are skipped with a note, never fatal.
//   - PII: we log COUNTS and resource names only — never item bodies, S3 keys,
//     or message contents.

import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

import {
  DynamoDBClient,
  DescribeTableCommand,
  ScanCommand,
  BatchWriteItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  S3Client,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import {
  SQSClient,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
} from '@aws-sdk/client-sqs';
import {
  CloudWatchLogsClient,
  DescribeLogStreamsCommand,
  DeleteLogStreamCommand,
} from '@aws-sdk/client-cloudwatch-logs';

import { assertHousingChoiceAccount, hcCredentials, HC_REGION } from './lib/hcAws.mjs';
import {
  buildInvitedAuditItem,
  buildInvitedUserItem,
  userIdForEmail,
} from './lib/userInviteCore.mjs';

// HARD-PINNED to dev. There is deliberately no prod path in this script.
const ENV = 'dev';
const TABLE_PREFIX = `hc-${ENV}-`;

// The 14 application tables (base names) — keep in sync with
// app/src/lib/tables.ts. We target THIS explicit set (never "all hc-dev-*") so
// the wipe can never touch a Terraform state/lock table or any non-app table.
const APP_TABLE_BASENAMES = [
  'contacts',
  'units',
  'conversations',
  'messages',
  'matches',
  'cases',
  'invoices',
  'users',
  'audit_events',
  'settings',
  'pool_numbers',
  'broadcasts',
  'activity_events',
  'listing_sends',
];

const QUEUE_NAMES = [`hc-${ENV}-jobs`, `hc-${ENV}-jobs-dlq`];
const LOG_GROUPS = [`/hc/${ENV}/app`, `/hc/${ENV}/worker`];

// After a wipe empties the users table, re-invite the operator so they can log
// back in (auth is invite-gated — a Google login is refused without an existing
// record). Mirrors `npm run user:invite -- dev <email> admin` exactly (same
// item shape + audit event), reusing scripts/lib/userInviteCore.mjs.
const SEED_USER = { email: 'cameron@abt-industries.com', role: 'admin' };

function usage() {
  process.stdout.write(
    `wipe-dev-data — empty the deployed AWS **dev** data stores (data only, never infra/secrets)\n\n` +
      `  npm run wipe:dev            DRY RUN (default): list what would be deleted, change nothing\n` +
      `  npm run wipe:dev -- --yes   EXECUTE the wipe (destructive)\n` +
      `  npm run wipe:dev -- --help  this help\n\n` +
      `Target is hard-pinned to the '${ENV}' env in the pinned HousingChoice account.\n`,
  );
}

/** Guard: never operate on anything that isn't an hc-dev-* name. */
function assertDevName(name) {
  if (!name.startsWith(TABLE_PREFIX) && !name.startsWith(`/hc/${ENV}/`) && !name.startsWith(`hc-${ENV}-`)) {
    throw new Error(`SAFETY: refusing to touch non-dev resource "${name}".`);
  }
  if (name.includes('-prod-') || name.includes('/hc/prod/')) {
    throw new Error(`SAFETY: refusing to touch a PROD-looking resource "${name}".`);
  }
}

// ── DynamoDB ────────────────────────────────────────────────────────────────
async function wipeTableItems(ddb, tableName, execute) {
  assertDevName(tableName);
  let keyNames;
  try {
    const { Table } = await ddb.send(new DescribeTableCommand({ TableName: tableName }));
    keyNames = Table.KeySchema.map((k) => k.AttributeName);
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') return { skipped: true, count: 0 };
    throw err;
  }
  // Project ONLY the key attributes (no PII pulled), aliased so reserved words
  // (e.g. `status`) are safe.
  const names = Object.fromEntries(keyNames.map((n, i) => [`#k${i}`, n]));
  const projection = Object.keys(names).join(', ');

  let ExclusiveStartKey;
  let count = 0;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: projection,
        ExpressionAttributeNames: names,
        Limit: 1000,
        ...(ExclusiveStartKey && { ExclusiveStartKey }),
      }),
    );
    const items = page.Items ?? [];
    count += items.length;
    if (execute) {
      for (let i = 0; i < items.length; i += 25) {
        await batchDelete(ddb, tableName, items.slice(i, i + 25));
      }
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return { skipped: false, count };
}

async function batchDelete(ddb, tableName, keys) {
  let requests = keys.map((Key) => ({ DeleteRequest: { Key } }));
  for (let attempt = 0; attempt < 6 && requests.length; attempt++) {
    const res = await ddb.send(new BatchWriteItemCommand({ RequestItems: { [tableName]: requests } }));
    const unprocessed = res.UnprocessedItems?.[tableName] ?? [];
    requests = unprocessed;
    if (requests.length) await sleep(100 * 2 ** attempt); // backoff on throttle
  }
  if (requests.length) throw new Error(`BatchWrite left ${requests.length} unprocessed items on ${tableName}`);
}

// ── S3 (versioned bucket: objects + versions + delete-markers) ───────────────
async function wipeBucket(s3, bucket, execute) {
  assertDevName(bucket);
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return { skipped: true, count: 0 };
    throw err;
  }
  let KeyMarker;
  let VersionIdMarker;
  let count = 0;
  let truncated = true;
  while (truncated) {
    const page = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        MaxKeys: 1000,
        ...(KeyMarker && { KeyMarker }),
        ...(VersionIdMarker && { VersionIdMarker }),
      }),
    );
    const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map((v) => ({
      Key: v.Key,
      VersionId: v.VersionId,
    }));
    count += objects.length;
    if (execute && objects.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
    }
    truncated = Boolean(page.IsTruncated);
    KeyMarker = page.NextKeyMarker;
    VersionIdMarker = page.NextVersionIdMarker;
  }
  return { skipped: false, count };
}

// ── SQS (purge) ──────────────────────────────────────────────────────────────
async function purgeQueue(sqs, name, execute) {
  assertDevName(name);
  let url;
  try {
    ({ QueueUrl: url } = await sqs.send(new GetQueueUrlCommand({ QueueName: name })));
  } catch (err) {
    if (err.name === 'QueueDoesNotExist' || err.name === 'AWS.SimpleQueueService.NonExistentQueue') {
      return { skipped: true, count: 0 };
    }
    throw err;
  }
  const attrs = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages'] }),
  );
  const count = Number(attrs.Attributes?.ApproximateNumberOfMessages ?? 0);
  if (execute) await sqs.send(new PurgeQueueCommand({ QueueUrl: url }));
  return { skipped: false, count };
}

// ── CloudWatch Logs (delete streams, keep the group) ─────────────────────────
async function wipeLogStreams(logs, group, execute) {
  assertDevName(group);
  let nextToken;
  let count = 0;
  try {
    do {
      const page = await logs.send(
        new DescribeLogStreamsCommand({ logGroupName: group, limit: 50, ...(nextToken && { nextToken }) }),
      );
      const streams = page.logStreams ?? [];
      count += streams.length;
      if (execute) {
        for (const s of streams) {
          await logs.send(new DeleteLogStreamCommand({ logGroupName: group, logStreamName: s.logStreamName }));
        }
      }
      nextToken = page.nextToken;
    } while (nextToken);
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') return { skipped: true, count: 0 };
    throw err;
  }
  return { skipped: false, count };
}

// ── Re-invite the operator (so login works after the users table is emptied) ──
async function inviteSeedUser(ddb, identity, execute) {
  const usersTable = `${TABLE_PREFIX}users`;
  const auditTable = `${TABLE_PREFIX}audit_events`;
  assertDevName(usersTable);
  assertDevName(auditTable);
  const userId = userIdForEmail(SEED_USER.email);
  if (!execute) return { skipped: false, userId, already: false, dryRun: true };

  const nowIso = new Date().toISOString();
  // Conditional put — idempotent: if the record somehow already exists, no-op
  // (never stomp an existing role/status/epoch), exactly like user:invite.
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: usersTable,
        Item: buildInvitedUserItem({ userId, email: SEED_USER.email, role: SEED_USER.role, nowIso }),
        ConditionExpression: 'attribute_not_exists(userId)',
      }),
    );
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return { skipped: false, userId, already: true };
    throw err;
  }

  // user_invited audit event (auditRepo conventions; actor = the IAM principal).
  const a = buildInvitedAuditItem({
    userId,
    email: SEED_USER.email,
    role: SEED_USER.role,
    invitedBy: identity.Arn,
    nowIso,
    suffix: randomUUID().slice(0, 8),
  });
  await ddb.send(
    new PutItemCommand({
      TableName: auditTable,
      Item: {
        entityKey: { S: a.entityKey },
        ts: { S: a.ts },
        event_type: { S: a.event_type },
        payload: {
          M: {
            email: { S: a.payload.email },
            role: { S: a.payload.role },
            invited_by: { S: a.payload.invited_by },
          },
        },
      },
    }),
  );
  return { skipped: false, userId, already: false };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function line(label, r) {
  if (r.skipped) return `  - ${label}: (not found — skipped)`;
  return `  - ${label}: ${r.count}`;
}

async function main() {
  const { values } = parseArgs({
    options: { yes: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } },
    allowPositionals: false,
  });
  if (values.help) {
    usage();
    return;
  }
  const execute = Boolean(values.yes);
  const mode = execute ? 'EXECUTE (destructive)' : 'DRY RUN (no changes)';

  // 1) Account guard — refuse unless the named profile is the pinned HC account.
  const identity = await assertHousingChoiceAccount();
  const accountId = identity.Account;
  const creds = hcCredentials();
  const cfg = { region: HC_REGION, credentials: creds };

  const bucket = `hc-${ENV}-media-${accountId}`; // infra/modules/s3_media: hc-{env}-media-{accountId}

  process.stdout.write(
    `\nwipe-dev-data — ${mode}\n` +
      `  account : ${accountId} (pinned HousingChoice)\n` +
      `  region  : ${HC_REGION}\n` +
      `  env     : ${ENV}  (prefix ${TABLE_PREFIX})\n\n` +
      (execute ? 'Deleting data now…\n' : 'Listing what WOULD be deleted (pass --yes to execute):\n'),
  );

  const ddb = new DynamoDBClient(cfg);
  const s3 = new S3Client(cfg);
  const sqs = new SQSClient(cfg);
  const logs = new CloudWatchLogsClient(cfg);

  // DynamoDB
  process.stdout.write('\nDynamoDB items:\n');
  let ddbTotal = 0;
  for (const base of APP_TABLE_BASENAMES) {
    const tableName = `${TABLE_PREFIX}${base}`;
    const r = await wipeTableItems(ddb, tableName, execute);
    ddbTotal += r.count;
    process.stdout.write(line(tableName, r) + '\n');
  }
  process.stdout.write(`  = ${ddbTotal} item(s) across ${APP_TABLE_BASENAMES.length} tables\n`);

  // S3
  process.stdout.write('\nS3 media bucket (objects + versions + delete-markers):\n');
  const s3r = await wipeBucket(s3, bucket, execute);
  process.stdout.write(line(bucket, s3r) + '\n');

  // SQS
  process.stdout.write('\nSQS queues (purge):\n');
  for (const name of QUEUE_NAMES) {
    const r = await purgeQueue(sqs, name, execute);
    process.stdout.write(line(name, r) + (r.skipped ? '' : ' message(s)') + '\n');
  }

  // CloudWatch Logs
  process.stdout.write('\nCloudWatch log streams (groups kept):\n');
  for (const group of LOG_GROUPS) {
    const r = await wipeLogStreams(logs, group, execute);
    process.stdout.write(line(group, r) + (r.skipped ? '' : ' stream(s)') + '\n');
  }

  // Re-invite the operator so login works after the users wipe.
  process.stdout.write('\nOperator re-invite (so login works after the wipe):\n');
  const inv = await inviteSeedUser(ddb, identity, execute);
  if (inv.dryRun) {
    process.stdout.write(`  - would invite ${SEED_USER.email} as '${SEED_USER.role}' (${inv.userId})\n`);
  } else if (inv.already) {
    process.stdout.write(`  - ${SEED_USER.email} already exists (${inv.userId}) — left unchanged\n`);
  } else {
    process.stdout.write(`  - invited ${SEED_USER.email} as '${SEED_USER.role}' (${inv.userId})\n`);
  }

  process.stdout.write(
    `\nPreserved (never touched): SSM Parameter Store /hc/${ENV}/app/* (secrets + config), ` +
      `and all Terraform-managed resources (tables, bucket, queues, log groups, IAM, …).\n`,
  );
  process.stdout.write(
    execute
      ? `\n✓ Wipe complete. Clean slate — no fixture data, only the re-invited operator ` +
          `(${SEED_USER.email}) so login works (activates on first Google sign-in).\n`
      : `\nDRY RUN only — nothing was changed. Re-run with --yes to execute.\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`\nwipe-dev-data FAILED: ${err.message}\n`);
  process.exitCode = 1;
});
