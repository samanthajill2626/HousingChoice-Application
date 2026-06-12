// MediaStore — the ONLY place the S3 SDK is imported (adapter rule).
//
// Inbound MMS media is mirrored from Twilio into the stack's private media
// bucket (s3_media module; MEDIA_BUCKET param). STREAMS ONLY (binding
// guideline 1): @aws-sdk/lib-storage's Upload consumes the Readable in
// bounded parts — no whole-body buffering, ever.
import type { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { loadConfig, type AppConfig } from '../lib/config.js';

export interface MediaStore {
  /** Stream `body` into the media bucket at `key`. */
  put(key: string, body: Readable, contentType?: string): Promise<void>;
}

export class S3MediaStore implements MediaStore {
  constructor(
    private readonly bucket: string,
    private readonly client: S3Client,
  ) {}

  async put(key: string, body: Readable, contentType?: string): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ...(contentType !== undefined && { ContentType: contentType }),
      },
    });
    await upload.done();
  }
}

export interface CreateMediaStoreDeps {
  config?: AppConfig;
  /** Test seam — a fake S3 client. */
  client?: S3Client;
}

/**
 * Returns undefined when MEDIA_BUCKET is unset (local loop: mirroring is
 * skipped — the webhook logs and keeps the provider URLs on the message).
 */
export function createMediaStore(deps: CreateMediaStoreDeps = {}): MediaStore | undefined {
  const config = deps.config ?? loadConfig();
  if (!config.mediaBucket) return undefined;
  const client = deps.client ?? new S3Client({ region: config.awsRegion });
  return new S3MediaStore(config.mediaBucket, client);
}
