// MediaStore — the ONLY place the S3 SDK is imported (adapter rule).
//
// Inbound MMS media is mirrored from Twilio into the stack's private media
// bucket (s3_media module; MEDIA_BUCKET param). STREAMS ONLY (binding
// guideline 1): @aws-sdk/lib-storage's Upload consumes the Readable in
// bounded parts — no whole-body buffering, ever.
import { Readable } from 'node:stream';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { loadConfig, type AppConfig } from '../lib/config.js';

/** A streamed object read back from the media bucket (M1.9c recording serving). */
export interface MediaObject {
  body: Readable;
  contentType?: string;
  contentLength?: number;
}

export interface MediaStore {
  /** Stream `body` into the media bucket at `key`. */
  put(key: string, body: Readable, contentType?: string): Promise<void>;
  /**
   * Stream an object back OUT of the media bucket by key (M1.9c: serving the
   * founder-bridge recording to the authed dashboard). STREAMS ONLY — the
   * Readable is piped straight from the S3 GetObject response body; nothing
   * buffers the whole object. Returns undefined when the key does not exist
   * (NoSuchKey) so the caller can answer 404. The s3:GetObject permission is
   * already granted on MEDIA_BUCKET (the ec2 IAM role) — no new infra.
   */
  getStream(key: string): Promise<MediaObject | undefined>;
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

  async getStream(key: string): Promise<MediaObject | undefined> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (out.Body === undefined) return undefined;
      // In Node the SDK's Body is a Readable (IncomingMessage) — stream it.
      return {
        body: out.Body as Readable,
        ...(out.ContentType !== undefined && { contentType: out.ContentType }),
        ...(out.ContentLength !== undefined && { contentLength: out.ContentLength }),
      };
    } catch (err) {
      // A missing object → undefined (caller answers 404). The S3 SDK throws
      // NoSuchKey (and sometimes a 404 NotFound) for an absent key; anything
      // else (auth/network) is a real error and re-thrown.
      if (
        typeof err === 'object' &&
        err !== null &&
        ((err as { name?: string }).name === 'NoSuchKey' ||
          (err as { name?: string }).name === 'NotFound' ||
          (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
      ) {
        return undefined;
      }
      throw err;
    }
  }
}

export interface CreateMediaStoreDeps {
  config?: AppConfig;
  /** Test seam — a fake S3 client. */
  client?: S3Client;
}

/**
 * Fixed credentials for the local S3-compatible store (MinIO). MinIO VALIDATES
 * credentials (unlike DynamoDB Local, which ignores them), so the client must
 * present exactly the container's root user/password — and must NOT fall back to
 * ambient AWS_* env, which would not match. Dev-only and not secret; the launcher
 * (scripts/s3.mjs) starts MinIO with the same pair.
 */
export const LOCAL_S3_ACCESS_KEY = 'local';
export const LOCAL_S3_SECRET_KEY = 'locallocal';

/**
 * Returns undefined when MEDIA_BUCKET is unset (local loop without S3: mirroring
 * is skipped — the webhook logs and keeps the provider URLs on the message).
 * When `mediaS3Endpoint` is set (local MinIO), the client targets it with
 * path-style addressing and fixed local creds; unset → real AWS (default
 * endpoint + instance-role credentials), unchanged.
 */
export function createMediaStore(deps: CreateMediaStoreDeps = {}): MediaStore | undefined {
  const config = deps.config ?? loadConfig();
  if (!config.mediaBucket) return undefined;
  const client =
    deps.client ??
    new S3Client({
      region: config.awsRegion,
      ...(config.mediaS3Endpoint
        ? {
            endpoint: config.mediaS3Endpoint,
            forcePathStyle: true,
            credentials: { accessKeyId: LOCAL_S3_ACCESS_KEY, secretAccessKey: LOCAL_S3_SECRET_KEY },
          }
        : {}),
    });
  return new S3MediaStore(config.mediaBucket, client);
}
