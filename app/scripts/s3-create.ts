// s3:create — create the local media bucket against MinIO (the storage sibling
// of db-create.ts). Idempotent: an existing bucket is skipped (logged), so
// re-running is always safe. Targets MEDIA_S3_ENDPOINT (default
// http://localhost:9000) — NEVER AWS; Terraform owns the real bucket (s3_media).
// Run from the repo root via tsx (the launchers invoke it after s3:start).
import { pathToFileURL } from 'node:url';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { LOCAL_S3_ACCESS_KEY, LOCAL_S3_SECRET_KEY } from '../src/adapters/mediaStore.js';

export const LOCAL_DEFAULT_ENDPOINT = 'http://localhost:9000';
export const LOCAL_DEFAULT_BUCKET = 'hc-local-media';

/** S3 errors that mean "the bucket already exists and is ours" — treat as success. */
function isAlreadyExists(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name;
  return name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists';
}

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
      // Not found (or transient) — fall through to create.
    }
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      console.log(`  created  ${bucket}`);
    } catch (err) {
      // Idempotent: a concurrent launcher (or a HeadBucket false-negative during
      // MinIO's liveness→readiness window) may have created it first. That's a
      // success, not a boot-aborting failure — TOCTOU between Head and Create.
      if (isAlreadyExists(err)) {
        console.log(`  exists   ${bucket} — created concurrently, skipped`);
        return;
      }
      throw err;
    }
  } finally {
    client.destroy();
  }
}

/** Retry ensureBucket a few times — MinIO's /health/live can flip green a beat
 *  before the S3 API is ready to take a CreateBucket (transient connection error). */
async function ensureBucketWithRetry(endpoint: string, bucket: string, attempts = 5): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await ensureBucket(endpoint, bucket);
      return;
    } catch (err) {
      if (i === attempts) throw err;
      console.log(`s3:create — bucket not ready yet (attempt ${i}/${attempts}); retrying…`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

// CLI entry — guarded so importing this module (e.g. in tests) has no side effect.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const endpoint = process.env.MEDIA_S3_ENDPOINT ?? LOCAL_DEFAULT_ENDPOINT;
  const bucket = process.env.MEDIA_BUCKET ?? LOCAL_DEFAULT_BUCKET;
  console.log(`s3:create — ensuring bucket ${bucket} at ${endpoint}`);
  try {
    await ensureBucketWithRetry(endpoint, bucket);
    console.log('s3:create — done');
  } catch (err) {
    console.error('s3:create failed — is MinIO up? (npm run s3:start)');
    console.error(err);
    process.exit(1);
  }
}
