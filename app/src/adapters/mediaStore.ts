// MediaStore — the ONLY place the S3 SDK is imported (adapter rule).
//
// Inbound MMS media is mirrored from Twilio into the stack's private media
// bucket (s3_media module; MEDIA_BUCKET param). STREAMS ONLY (binding
// guideline 1): @aws-sdk/lib-storage's Upload consumes the Readable in
// bounded parts — no whole-body buffering, ever.
import { Readable } from 'node:stream';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { loadConfig, type AppConfig } from '../lib/config.js';

/** A streamed object read back from the media bucket (M1.9c recording serving). */
export interface MediaObject {
  body: Readable;
  contentType?: string;
  contentLength?: number;
}

/** Metadata for a stored object (outbound MMS: HeadObject before presigning). */
export interface MediaHead {
  contentType?: string;
  size?: number;
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
  /**
   * A time-limited, unauthenticated GET URL for `key` (outbound MMS: Twilio
   * fetches the media over the public internet). Presigned URLs are BEARER
   * TOKENS: never log them, never persist them as the source of truth. Signed
   * with the store's OWN client so endpoint/forcePathStyle/creds/region are
   * inherited (MinIO path-style parity). PRESIGN PER ATTEMPT (design Sec 4):
   * every send/relay/retry re-presigns fresh from the durable s3Key.
   */
  presign(key: string, ttlSeconds: number): Promise<string>;
  /**
   * HeadObject metadata for `key` (outbound MMS send-route validation: confirm
   * an uploaded attachment exists, and re-check its size + Content-Type before
   * presigning). Returns undefined when the key does not exist (404), mirroring
   * getStream's absent-object contract.
   */
  head(key: string): Promise<MediaHead | undefined>;
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
    try {
      await upload.done();
    } catch (err) {
      // Belt-and-suspenders: a destroyed/errored body stream (e.g. the upload
      // route aborting an over-size file) rejects done(); explicitly abort the
      // multipart upload too so no orphan partial object is ever committed.
      // Best-effort - swallow abort failures and rethrow the ORIGINAL error.
      await upload.abort().catch(() => {});
      throw err;
    }
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

  async presign(key: string, ttlSeconds: number): Promise<string> {
    // Reuse this.client (design/spike rule): a fresh client could reintroduce
    // the MinIO virtual-host/region mismatch. Sign `host` only (the SDK
    // default) so a plain fetch/GET with no extra headers verifies cleanly.
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttlSeconds,
    });
  }

  async head(key: string): Promise<MediaHead | undefined> {
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        ...(out.ContentType !== undefined && { contentType: out.ContentType }),
        ...(out.ContentLength !== undefined && { size: out.ContentLength }),
      };
    } catch (err) {
      // Absent object -> undefined (caller answers 400 unknown_attachment). A
      // HeadObject on a missing key throws NotFound (404); anything else
      // (auth/network) is a real error and re-thrown.
      if (
        typeof err === 'object' &&
        err !== null &&
        ((err as { name?: string }).name === 'NotFound' ||
          (err as { name?: string }).name === 'NoSuchKey' ||
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
  // Defense-in-depth (belt to loadConfig's MEDIA_S3_ENDPOINT prod guard): NEVER
  // attach the local endpoint + fixed dev credentials in production, even if a
  // caller hands in a config that bypassed loadConfig. The fixed creds must never
  // reach a real AWS S3Client.
  const useLocalEndpoint = Boolean(config.mediaS3Endpoint) && config.nodeEnv !== 'production';
  if (config.mediaS3Endpoint && config.nodeEnv === 'production') {
    throw new Error('createMediaStore: refusing local S3 endpoint + dev credentials in production.');
  }
  const client =
    deps.client ??
    new S3Client({
      region: config.awsRegion,
      ...(useLocalEndpoint
        ? {
            endpoint: config.mediaS3Endpoint,
            forcePathStyle: true,
            credentials: { accessKeyId: LOCAL_S3_ACCESS_KEY, secretAccessKey: LOCAL_S3_SECRET_KEY },
          }
        : {}),
    });
  return new S3MediaStore(config.mediaBucket, client);
}
