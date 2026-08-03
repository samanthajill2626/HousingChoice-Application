// Wipe the DEPLOYED AWS **dev** environment back to an empty, clean slate —
// deleting DATA only, never infrastructure or secrets. Powers:
//
//   npm run wipe:dev              DRY RUN (default) — list exactly what WOULD be
//                                 deleted (counts only), touch nothing.
//   npm run wipe:dev -- --yes     EXECUTE the wipe (destructive).
//   npm run wipe:dev -- --help    usage.
//
// What it WIPES (in the pinned HousingChoice dev account, hc-dev-*), in order:
//   - SQS FIRST: the jobs queue + DLQ and the inbound-mail queue + DLQ are
//     PURGED — before the tables, so a queued job can't be dispatched mid-wipe
//     and repopulate tables the scan already passed. (A message the worker
//     ALREADY holds can still land one late write; the closing restart plus a
//     re-run covers that residue.)
//   - DynamoDB: every ITEM in every app table — the set comes from the
//     generated infra/envs/dev/tables.auto.tfvars.json, so a newly added table
//     can never be silently missed (the tables themselves stay — they are
//     Terraform-managed with deletion_protection on; we only clear rows).
//   - S3: every OBJECT **and version + delete-marker** in the media bucket AND
//     the inbound-mail raw-MIME bucket (both versioned; the buckets stay).
//     NOTE: CloudFront caches /unit-media/* for up to 7 days — wiped photos can
//     keep serving from the edge until the TTL lapses (no invalidation here).
//   - CloudWatch Logs: the log STREAMS in the app/worker/system groups are
//     deleted (the log GROUPS stay — they are Terraform-managed).
//
// It then RE-INVITES the operators (cameron@abt-industries.com and
// sam@housingchoice.org, both admin) so login still works — auth is
// invite-gated, and the wipe empties the users table. The re-invite is
// attempted EVEN IF an earlier phase failed (a partial wipe must never leave
// dev unloggable-into). No other seed/fixture data.
//
// Finally it RESTARTS the app+worker containers on the hc-dev-app instance
// (SSM Run Command -> `docker compose restart`). This is REQUIRED, not
// cosmetic: docker's awslogs driver creates its log stream once at container
// start and never recreates it, so after the stream wipe a running container
// ships NO logs until restarted. The restart also drops any in-memory state
// referencing wiped rows. If the restart step fails, the script exits nonzero
// and tells you to restart manually (npm run deploy:dev also does it).
//
// A note on Twilio: pool_numbers rows are wiped like all data, but the
// purchased Twilio numbers themselves are untouched (still owned, billed and
// webhooked). Recover the rows afterwards with `npm run pool:audit -- dev
// --reimport` (scripts/poolNumbersAudit.mjs reconciles Twilio's inventory
// against the table); without it a fresh relay group buys a NEW number.
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
//   - DRY RUN is the DEFAULT; deleting requires an explicit `--yes` (and an
//     explicit `--dry-run` wins over `--yes`, so combining them stays safe).
//   - Only the KNOWN app tables (from the generated tfvars) are targeted (never
//     "all hc-dev-*"), so a TF lock/state table or anything else can't be
//     caught in the blast radius.
//   - Missing resources (env not deployed) are skipped with a note, never fatal.
//   - PII: we log COUNTS and resource names only — never item bodies, S3 keys,
//     or message contents.

import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

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
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';

import { assertHousingChoiceAccount, hcCredentials, HC_REGION } from './lib/hcAws.mjs';
import {
  buildInvitedAuditItem,
  buildInvitedUserItem,
  normalizeEmail,
  userIdForEmail,
} from './lib/userInviteCore.mjs';

// HARD-PINNED to dev. There is deliberately no prod path in this script.
const ENV = 'dev';
const TABLE_PREFIX = `hc-${ENV}-`;

// The application tables (base names) — read from the GENERATED Terraform
// tfvars for this env, which `npm run gen:tables` derives from
// app/src/lib/tables.ts and `npm run plan`/`drift` keep honest. Deriving the
// set (instead of hand-listing it) means a newly added table can never be
// silently missed by the wipe (this bit us: the list was 14 while tables.ts
// had grown to 20). Still an EXPLICIT known set (never "all hc-dev-*"), so a
// TF state/lock table or any non-app table can't be caught in the blast radius.
const APP_TABLE_BASENAMES = Object.keys(
  JSON.parse(
    readFileSync(new URL(`../infra/envs/${ENV}/tables.auto.tfvars.json`, import.meta.url), 'utf8'),
  ).tables,
).sort();

const QUEUE_NAMES = [
  `hc-${ENV}-jobs`,
  `hc-${ENV}-jobs-dlq`,
  `hc-${ENV}-inbound-mail`,
  `hc-${ENV}-inbound-mail-dlq`,
];
// app + worker (pino) and the host system log (rsyslog via the CW agent).
const LOG_GROUPS = [`/hc/${ENV}/app`, `/hc/${ENV}/worker`, `/hc/${ENV}/system`];

// After a wipe empties the users table, re-invite the operators so they can log
// back in (auth is invite-gated — a Google login is refused without an existing
// record). Mirrors `npm run user:invite -- dev <email> admin` exactly (same
// item shape + audit event), reusing scripts/lib/userInviteCore.mjs.
// normalizeEmail at the definition edge: login resolves via the byEmail GSI
// with a normalized value, so a mixed-case entry here would store a record
// that exists but can never be logged into (user:invite normalizes the same
// way in parseUserInviteArgs).
const SEED_USERS = [
  { email: 'cameron@abt-industries.com', role: 'admin' },
  { email: 'sam@housingchoice.org', role: 'admin' },
].map((u) => ({ ...u, email: normalizeEmail(u.email) }));

function usage() {
  process.stdout.write(
    `wipe-dev-data — empty the deployed AWS **dev** data stores (data only, never infra/secrets)\n\n` +
      `  npm run wipe:dev            DRY RUN (default): list what would be deleted, change nothing\n` +
      `  npm run wipe:dev -- --yes   EXECUTE the wipe (destructive), then restart app+worker\n` +
      `  npm run wipe:dev -- --dry-run  force a dry run (wins over --yes)\n` +
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
    if (requests.length && attempt < 5) await sleep(100 * 2 ** attempt); // backoff on throttle
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
      // DeleteObjects does NOT throw on per-object failures — with Quiet:true
      // the response body is exactly the Errors array. Swallowing it means an
      // undeletable object survives every wipe while we report "complete", so
      // surface it (codes only — never keys, per the PII rule).
      const res = await s3.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
      );
      const errors = res.Errors ?? [];
      if (errors.length) {
        const codes = [...new Set(errors.map((e) => e.Code))].join(', ');
        throw new Error(`${errors.length} object(s) failed to delete in ${bucket} (codes: ${codes})`);
      }
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
  do {
    let page;
    try {
      page = await logs.send(
        new DescribeLogStreamsCommand({ logGroupName: group, limit: 50, ...(nextToken && { nextToken }) }),
      );
    } catch (err) {
      // Group-missing means "env not deployed" — but ONLY on the first page.
      // Previously the whole loop shared one catch, so a mid-run error (e.g. a
      // stream reaped by retention between Describe and Delete) aborted the
      // group and was mis-reported as "(not found — skipped)".
      if (err.name === 'ResourceNotFoundException' && count === 0 && !nextToken) {
        return { skipped: true, count: 0 };
      }
      throw err;
    }
    const streams = page.logStreams ?? [];
    count += streams.length;
    if (execute) {
      for (const s of streams) {
        try {
          await logs.send(new DeleteLogStreamCommand({ logGroupName: group, logStreamName: s.logStreamName }));
        } catch (err) {
          // Stream already gone (retention reaped it mid-run) — not a failure.
          if (err.name !== 'ResourceNotFoundException') throw err;
        }
      }
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return { skipped: false, count };
}

// ── Re-invite the operators (so login works after the users table is emptied) ──
async function inviteSeedUser(ddb, identity, execute, seedUser) {
  const usersTable = `${TABLE_PREFIX}users`;
  const auditTable = `${TABLE_PREFIX}audit_events`;
  assertDevName(usersTable);
  assertDevName(auditTable);
  const userId = userIdForEmail(seedUser.email);
  if (!execute) return { skipped: false, userId, already: false, dryRun: true };

  const nowIso = new Date().toISOString();
  // Conditional put — idempotent: if the record somehow already exists, no-op
  // (never stomp an existing role/status/epoch), exactly like user:invite.
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: usersTable,
        Item: buildInvitedUserItem({ userId, email: seedUser.email, role: seedUser.role, nowIso }),
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
    email: seedUser.email,
    role: seedUser.role,
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

// ── Container restart (SSM Run Command on the hc-dev-app instance) ───────────
// REQUIRED after the log-stream wipe: docker's awslogs driver creates its
// stream once at container start and never recreates it, so a running
// container ships NO logs after the wipe until restarted. Also drops any
// in-memory state referencing wiped rows. Mirrors scripts/deploy.mjs (same
// SSM Run Command mechanism), minus the image roll.
const INSTANCE_NAME = `hc-${ENV}-app`; // infra/modules/ec2: tags.Name

async function findAppInstance(ec2) {
  const res = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: 'tag:Name', Values: [INSTANCE_NAME] },
        { Name: 'instance-state-name', Values: ['running'] },
      ],
    }),
  );
  return (res.Reservations ?? []).flatMap((r) => r.Instances ?? [])[0]?.InstanceId;
}

async function restartContainers(ec2, ssm, execute) {
  const instanceId = await findAppInstance(ec2);
  if (!instanceId) return { skipped: true };
  if (!execute) return { skipped: false, instanceId, dryRun: true };

  const { Command } = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: 'AWS-RunShellScript',
      Comment: 'hc wipe:dev container restart',
      Parameters: {
        commands: ['cd /opt/hc && docker compose restart app worker'],
        executionTimeout: ['600'],
      },
    }),
  );

  // Poll to a terminal status (client-side cap ~10 min; executionTimeout has
  // the on-instance side covered).
  for (let attempt = 0; attempt < 120; attempt++) {
    await sleep(5000);
    let inv;
    try {
      inv = await ssm.send(
        new GetCommandInvocationCommand({ CommandId: Command.CommandId, InstanceId: instanceId }),
      );
    } catch (err) {
      if (err.name === 'InvocationDoesNotExist') continue; // normal right after send
      throw err;
    }
    if (['Pending', 'InProgress', 'Delayed'].includes(inv.Status)) continue;
    if (inv.Status !== 'Success') {
      const stderr = (inv.StandardErrorContent ?? '').trim().slice(0, 500);
      throw new Error(`SSM restart command ${inv.Status}${stderr ? `: ${stderr}` : ''}`);
    }
    return { skipped: false, instanceId };
  }
  throw new Error('SSM restart command did not reach a terminal status within 10 minutes');
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
  // --dry-run WINS over --yes: the flag was previously parsed but ignored, so
  // `--yes --dry-run` silently executed a full wipe. Never again.
  const execute = Boolean(values.yes) && !values['dry-run'];
  const mode = execute ? 'EXECUTE (destructive)' : 'DRY RUN (no changes)';

  // 1) Account guard — refuse unless the named profile is the pinned HC account.
  const identity = await assertHousingChoiceAccount();
  const accountId = identity.Account;
  const creds = hcCredentials();
  const cfg = { region: HC_REGION, credentials: creds };

  const buckets = [
    `hc-${ENV}-media-${accountId}`, // infra/modules/s3_media: hc-{env}-media-{accountId}
    `hc-${ENV}-inbound-mail-${accountId}`, // infra/modules/inbound_mail: SES raw-MIME bucket
  ];

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
  const ec2 = new EC2Client(cfg);
  const ssm = new SSMClient(cfg);

  // All wipe phases run inside ONE try so a failure anywhere still falls
  // through to the operator re-invite — a partial wipe (users table emptied,
  // then a later phase throws) must never leave dev unloggable-into.
  let wipeError = null;
  try {
    // SQS FIRST (quiesce): purge queued jobs BEFORE the tables, so a pending
    // job envelope can't be dispatched mid-wipe and write fresh rows behind
    // the table scans. (A message the worker already holds can still land one
    // late write; the closing restart + a re-run covers that residue.)
    process.stdout.write('\nSQS queues (purge — first, so queued jobs cannot repopulate wiped tables):\n');
    for (const name of QUEUE_NAMES) {
      const r = await purgeQueue(sqs, name, execute);
      process.stdout.write(line(name, r) + (r.skipped ? '' : ' message(s)') + '\n');
    }

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
    process.stdout.write('\nS3 buckets (objects + versions + delete-markers):\n');
    for (const bucket of buckets) {
      const s3r = await wipeBucket(s3, bucket, execute);
      process.stdout.write(line(bucket, s3r) + '\n');
    }

    // CloudWatch Logs
    process.stdout.write('\nCloudWatch log streams (groups kept):\n');
    for (const group of LOG_GROUPS) {
      const r = await wipeLogStreams(logs, group, execute);
      process.stdout.write(line(group, r) + (r.skipped ? '' : ' stream(s)') + '\n');
    }
  } catch (err) {
    wipeError = err;
    process.stdout.write(`\n!! wipe phase FAILED (${err.message}) — continuing to the operator re-invite\n`);
  }

  // Re-invite the operators — ALWAYS attempted (idempotent conditional put),
  // even after a wipe-phase failure, so login keeps working.
  process.stdout.write('\nOperator re-invite (so login works after the wipe):\n');
  let inviteError = null;
  for (const seedUser of SEED_USERS) {
    let inv;
    try {
      inv = await inviteSeedUser(ddb, identity, execute, seedUser);
    } catch (err) {
      inviteError = err;
      process.stdout.write(
        `  - ${seedUser.email}: FAILED (${err.message}) — ` +
          `run: npm run user:invite -- ${ENV} ${seedUser.email} ${seedUser.role}\n`,
      );
      continue;
    }
    if (inv.dryRun) {
      process.stdout.write(`  - would invite ${seedUser.email} as '${seedUser.role}' (${inv.userId})\n`);
    } else if (inv.already) {
      process.stdout.write(`  - ${seedUser.email} already exists (${inv.userId}) — left unchanged\n`);
    } else {
      process.stdout.write(`  - invited ${seedUser.email} as '${seedUser.role}' (${inv.userId})\n`);
    }
  }
  if (wipeError) throw wipeError;
  if (inviteError) throw inviteError;

  // Container restart — REQUIRED, not cosmetic: the awslogs driver's streams
  // are create-once, so after the stream wipe the running containers ship no
  // logs until restarted (and in-memory state may reference wiped rows).
  process.stdout.write('\nContainer restart (app+worker — log shipping is dead until they restart):\n');
  try {
    const r = await restartContainers(ec2, ssm, execute);
    if (r.skipped) {
      process.stdout.write(`  - ${INSTANCE_NAME}: (no running instance found — skipped)\n`);
    } else if (r.dryRun) {
      process.stdout.write(
        `  - would restart app+worker on ${INSTANCE_NAME} (${r.instanceId}) via SSM Run Command\n`,
      );
    } else {
      process.stdout.write(`  - restarted app+worker on ${INSTANCE_NAME} (${r.instanceId})\n`);
    }
  } catch (err) {
    process.exitCode = 1;
    process.stdout.write(
      `  - RESTART FAILED (${err.message})\n` +
        `    Data wipe itself succeeded, but app/worker ship NO CloudWatch logs until restarted.\n` +
        `    Restart manually: npm run deploy:dev (rolls + restarts), or on the instance: ` +
        `cd /opt/hc && docker compose restart app worker\n`,
    );
  }

  process.stdout.write(
    `\nPreserved (never touched): SSM Parameter Store /hc/${ENV}/app/* (secrets + config), ` +
      `and all Terraform-managed resources (tables, bucket, queues, log groups, IAM, …).\n`,
  );
  process.stdout.write(
    execute
      ? `\n✓ Wipe complete. Clean slate — no fixture data, only the re-invited operators ` +
          `(${SEED_USERS.map((u) => u.email).join(', ')}) so login works (activates on first Google sign-in).\n`
      : `\nDRY RUN only — nothing was changed. Re-run with --yes to execute.\n`,
  );
  // Purchased Twilio relay numbers survive the wipe with no DB record — until
  // they are re-imported, inbound relay SMS on them won't route and the next
  // relay group buys ANOTHER number. Always worth a look after a wipe.
  process.stdout.write(
    execute
      ? `\nNext: the wipe does NOT touch Twilio — any purchased relay numbers now have no\n` +
          `pool_numbers record (unroutable; a new relay group would buy another number).\n` +
          `Review and restore them with:\n` +
          `  npm run pool:audit -- ${ENV}              (read-only report)\n` +
          `  npm run pool:audit -- ${ENV} --reimport   (re-create the missing rows)\n`
      : `\nNote: a real wipe leaves purchased Twilio relay numbers with no pool_numbers\n` +
          `record — review/restore afterwards with: npm run pool:audit -- ${ENV} [--reimport]\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`\nwipe-dev-data FAILED: ${err.message}\n`);
  process.exitCode = 1;
});
