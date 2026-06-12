// One-time (but always-safe-to-re-run) account bootstrap: the two Terraform
// state buckets. This is the ONLY infrastructure not managed by Terraform —
// the backend bucket must exist before `terraform init` can run (the classic
// chicken-and-egg), so it lives here: codified, idempotent, account-guarded.
// Everything else is Terraform (infra/).
//
//   npm run bootstrap          create/enforce both state buckets
//   npm run bootstrap:check    read-only: report what would be done
//
// Per bucket it enforces: existence, versioning ON (state history is the
// rollback safety net), full public-access block, SSE-S3 encryption, and
// project tags. Safe to re-run anytime; each setting is set-if-different.

import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketVersioningCommand,
  PutPublicAccessBlockCommand,
  PutBucketEncryptionCommand,
  PutBucketTaggingCommand,
} from '@aws-sdk/client-s3';
import {
  assertHousingChoiceAccount,
  hcCredentials,
  stateBucketName,
  HC_REGION,
  HC_PROFILE,
  STACK_ENVS,
} from './lib/hcAws.mjs';

const checkOnly = process.argv.includes('--check');

const s3 = new S3Client({ region: HC_REGION, credentials: hcCredentials() });

async function bucketExists(bucket) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (err) {
    const status = err.$metadata?.httpStatusCode;
    if (status === 404) return false;
    if (status === 403) {
      throw new Error(
        `Bucket ${bucket} exists but is NOT owned by this account (403). ` +
          `Bucket names are global — investigate before continuing.`,
      );
    }
    throw err;
  }
}

async function ensureBucket(env) {
  const bucket = stateBucketName(env);
  const exists = await bucketExists(bucket);

  if (checkOnly) {
    console.log(
      exists
        ? `  [check] ${bucket} — exists; settings would be re-enforced`
        : `  [check] ${bucket} — MISSING; would create + enforce settings`,
    );
    return;
  }

  if (!exists) {
    // us-east-1 must not send a LocationConstraint.
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`  created   ${bucket}`);
  } else {
    console.log(`  exists    ${bucket}`);
  }

  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: 'Enabled' },
    }),
  );
  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
  await s3.send(
    new PutBucketEncryptionCommand({
      Bucket: bucket,
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
    }),
  );
  await s3.send(
    new PutBucketTaggingCommand({
      Bucket: bucket,
      Tagging: {
        TagSet: [
          { Key: 'Project', Value: 'housingchoice' },
          { Key: 'Stack', Value: `hc-${env}` },
          { Key: 'ManagedBy', Value: 'scripts/bootstrap.mjs' },
        ],
      },
    }),
  );
  console.log(`            versioning ✓  public-access-block ✓  sse-s3 ✓  tags ✓`);
}

const identity = await assertHousingChoiceAccount();
console.log(
  `${checkOnly ? '[CHECK MODE — read-only] ' : ''}account ${identity.Account} via profile "${HC_PROFILE}" (${identity.Arn})`,
);
console.log(`Terraform state buckets (${HC_REGION}):`);
for (const env of STACK_ENVS) {
  await ensureBucket(env);
}
console.log(checkOnly ? 'Check complete — nothing was changed.' : 'Bootstrap complete.');
