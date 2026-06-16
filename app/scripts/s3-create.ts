// s3:create — create the local media bucket against MinIO (the storage sibling
// of db-create.ts). Idempotent: an existing bucket is skipped (logged), so
// re-running is always safe. Targets MEDIA_S3_ENDPOINT (default
// http://localhost:9000) — NEVER AWS; Terraform owns the real bucket (s3_media).
// Run from the repo root via tsx (the launchers invoke it after s3:start).
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { LOCAL_S3_ACCESS_KEY, LOCAL_S3_SECRET_KEY } from '../src/adapters/mediaStore.js';

export const LOCAL_DEFAULT_ENDPOINT = 'http://localhost:9000';
export const LOCAL_DEFAULT_BUCKET = 'hc-local-media';

export async function ensureBucket(endpoint: string, bucket: string): Promise<void> {
  const client = new S3Client({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: LOCAL_S3_ACCESS_KEY, secretAccessKey: LOCAL_S3_SECRET_KEY },
  });
  try {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      console.log(`  exists   ${bucket} — skipped`);
      return;
    } catch {
      // Not found (or no access) — fall through to create.
    }
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`  created  ${bucket}`);
  } finally {
    client.destroy();
  }
}

const endpoint = process.env.MEDIA_S3_ENDPOINT ?? LOCAL_DEFAULT_ENDPOINT;
const bucket = process.env.MEDIA_BUCKET ?? LOCAL_DEFAULT_BUCKET;
console.log(`s3:create — ensuring bucket ${bucket} at ${endpoint}`);
try {
  await ensureBucket(endpoint, bucket);
  console.log('s3:create — done');
} catch (err) {
  console.error('s3:create failed — is MinIO up? (npm run s3:start)');
  console.error(err);
  process.exit(1);
}
