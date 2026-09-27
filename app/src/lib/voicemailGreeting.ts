// app/src/lib/voicemailGreeting.ts
// The recorded voicemail greeting (spec 2026-09-26): ONE object under a fixed
// media-store key + ONE optional map on the org settings item. This file holds
// the pure pieces every surface shares - the routes (upload/remove/serve), the
// voice webhook (offer <Play>), the settings projection - so the limits and the
// format rules live in exactly one place.
import { Transform, type TransformCallback } from 'node:stream';

export const VOICEMAIL_GREETING_S3_KEY = 'settings/voicemail-greeting';
/** Decision 1: a 5 MB cap. Equals lib-storage's minimum part size, so an
 *  accepted greeting is sent to S3 as ONE PutObject after the stream ends. */
export const VOICEMAIL_GREETING_MAX_BYTES = 5 * 1024 * 1024;
/** Decision 3: the presigned <Play> URL is good for 10 minutes. */
export const VOICEMAIL_GREETING_PLAY_TTL_SECONDS = 600;
/** The WHOLE webhook lookup (GetItem + HeadObject + presign) must settle inside
 *  this budget or the caller hears the spoken prompt: neither the DynamoDB nor
 *  the S3 client carries a request timeout, and a hung call would otherwise
 *  hold the TwiML past Twilio's webhook budget. */
export const VOICEMAIL_GREETING_LOOKUP_BUDGET_MS = 2500;
export const VOICEMAIL_GREETING_MIME_TYPES: ReadonlySet<string> = new Set([
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
]);
export const VOICEMAIL_GREETING_REJECT_MESSAGE =
  'Upload an MP3 or WAV file. iPhone voice memos are M4A; export or convert the recording first.';
/** The display name rides a header (NOT the query string: the OTel span exports
 *  the query and the mutation catalog needs a literal path). URI-encoded so the
 *  header value is always ASCII. */
export const VOICEMAIL_GREETING_FILE_NAME_HEADER = 'x-greeting-file-name';
export const VOICEMAIL_GREETING_FILE_NAME_MAX_CHARS = 120;
export const VOICEMAIL_GREETING_SNIFF_BYTES = 12;

export type VoicemailGreetingFormat = 'mp3' | 'wav';
export type VoicemailGreetingContentType = 'audio/mpeg' | 'audio/wav';

export interface NormalizedGreetingType {
  contentType: VoicemailGreetingContentType;
  format: VoicemailGreetingFormat;
}

/** Map a declared Content-Type onto the canonical stored type, or undefined. */
export function normalizeGreetingContentType(raw: string | undefined): NormalizedGreetingType | undefined {
  if (typeof raw !== 'string') return undefined;
  const bare = (raw.split(';')[0] ?? '').trim().toLowerCase();
  if (bare === 'audio/mpeg') return { contentType: 'audio/mpeg', format: 'mp3' };
  if (bare === 'audio/wav' || bare === 'audio/x-wav') return { contentType: 'audio/wav', format: 'wav' };
  return undefined;
}

/**
 * Does the first few bytes look like the declared format? WAV: RIFF....WAVE.
 * MP3: an ID3v2 tag, or an MPEG audio frame sync (11 set bits) whose LAYER
 * bits are non-zero - layer `00` is reserved and is exactly what an ADTS AAC
 * frame carries, so an AAC file declared as MP3 is refused here.
 */
export function sniffGreetingHeader(head: Buffer, format: VoicemailGreetingFormat): boolean {
  if (format === 'wav') {
    return head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WAVE';
  }
  if (head.length < 3) return false;
  if (head.toString('latin1', 0, 3) === 'ID3') return true;
  const b0 = head[0] ?? 0;
  const b1 = head[1] ?? 0;
  return b0 === 0xff && (b1 & 0xe0) === 0xe0 && (b1 & 0x06) !== 0;
}

export type GreetingRejectReason = 'invalid_format' | 'too_large' | 'empty';

export class GreetingRejectedError extends Error {
  constructor(readonly reason: GreetingRejectReason) {
    super(`voicemail greeting rejected: ${reason}`);
    this.name = 'GreetingRejectedError';
  }
}

/**
 * A pass-through that holds back the first VOICEMAIL_GREETING_SNIFF_BYTES,
 * checks them against the declared format, and only then lets ANY byte
 * through; it also counts bytes and destroys itself the moment the cap is
 * exceeded. The route pipes the request into it and hands IT to
 * mediaStore.put, so the app never holds the file: on a refusal downstream
 * has seen either nothing (bad header) or a stream that errors before it
 * ends (too large), and lib-storage sends nothing to S3 either way.
 */
export class GreetingUploadGate extends Transform {
  bytesSeen = 0;
  private held: Buffer[] = [];
  private heldBytes = 0;
  private verified = false;

  constructor(private readonly opts: { format: VoicemailGreetingFormat; maxBytes: number }) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytesSeen += chunk.length;
    if (this.bytesSeen > this.opts.maxBytes) {
      callback(new GreetingRejectedError('too_large'));
      return;
    }
    if (this.verified) {
      callback(null, chunk);
      return;
    }
    this.held.push(chunk);
    this.heldBytes += chunk.length;
    if (this.heldBytes < VOICEMAIL_GREETING_SNIFF_BYTES) {
      callback();
      return;
    }
    const head = Buffer.concat(this.held);
    this.held = [];
    if (!sniffGreetingHeader(head, this.opts.format)) {
      callback(new GreetingRejectedError('invalid_format'));
      return;
    }
    this.verified = true;
    callback(null, head);
  }

  override _flush(callback: TransformCallback): void {
    if (this.verified) {
      callback();
      return;
    }
    if (this.bytesSeen === 0) {
      callback(new GreetingRejectedError('empty'));
      return;
    }
    const head = Buffer.concat(this.held);
    this.held = [];
    if (!sniffGreetingHeader(head, this.opts.format)) {
      callback(new GreetingRejectedError('invalid_format'));
      return;
    }
    this.verified = true;
    callback(null, head);
  }
}

/** The staff-facing display name: last path segment, no control characters,
 *  trimmed, capped by CODE POINTS (never splitting a surrogate pair), with a
 *  per-format fallback. Never logged. */
export function sanitizeGreetingFileName(raw: unknown, format: VoicemailGreetingFormat): string {
  const fallback = format === 'mp3' ? 'greeting.mp3' : 'greeting.wav';
  if (typeof raw !== 'string') return fallback;
  const segments = raw.split(/[\\/]/);
  const last = segments[segments.length - 1] ?? '';
  // C0 controls and DEL (U+0000-U+001F, U+007F). No eslint-disable here:
  // no-control-regex is not enabled under the repo's typescript-eslint preset,
  // and an unused directive would itself be reported.
  const cleaned = last.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned.length === 0) return fallback;
  return Array.from(cleaned).slice(0, VOICEMAIL_GREETING_FILE_NAME_MAX_CHARS).join('');
}

export class GreetingLookupTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} exceeded ${ms}ms`);
    this.name = 'GreetingLookupTimeoutError';
  }
}

/**
 * A plain race of `promise` against a timer. It carries NO flag: the caller
 * makes the abandoned work harmless by having it RETURN A RESULT and touch
 * nothing (the webhook's lookup returns what to play; only the caller emits
 * TwiML or logs, and only when the race resolved in time). A late rejection
 * of the abandoned promise is swallowed so it can never surface as unhandled;
 * the timer is cleared when the promise wins so nothing holds the loop.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new GreetingLookupTimeoutError(label, ms)), ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
