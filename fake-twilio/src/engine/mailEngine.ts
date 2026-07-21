// fake-twilio/src/engine/mailEngine.ts
//
// The fake-SES engine: captures the app's outbound SESv2 SendEmail (raw MIME),
// string-scans the top-level headers we care about (To/Cc/Subject/Message-ID),
// stores the record, and emits a `mail.outbound` hub event. Constructed with the
// SAME shared EventHub as the messaging + call engines (server.ts) so its events
// reach the SSE stream by construction.
//
// A deliberately DUMB, deterministic test double: NO mailparser (ADJ-10 - it is an
// app-only dep, unreachable here), header parsing is a minimal string scan with
// just enough folding / addr-spec handling for the nodemailer-composed MIME the app
// sends. sesMessageId is a monotonic `ses-fake-<n>` counter so tests are stable.
import { randomUUID, randomBytes } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { EventHub } from './eventHub.js';
import { MailStore, type InboundEmailRecord, type StoredEmail } from './mailStore.js';

// ---- INBOUND (email-channel B4) -------------------------------------------------
//
// The fake delivers an inbound email by (1) hand-rolling a MIME message
// (buildInboundMime - NO mailparser/mail-composer, ADJ-10/D4), (2) writing it to
// MinIO INBOUND_MAIL_BUCKET (the SES receipt-rule S3 target), and (3) POSTing an
// SNS-shaped receipt notification to the app's dev webhook (/webhooks/ses/inbound)
// with the x-origin-verify header the app's origin-secret middleware requires.
//
// Fixed MinIO creds (D3): the inherited AWS_ACCESS_KEY_ID is a DynamoDB-Local lane
// key MinIO would 403, so the S3 client MUST pin the MinIO root creds explicitly and
// NEVER read ambient AWS_*. The fake cannot import the app's LOCAL_S3_* constants
// (separate workspace), so they are redefined here.
const LOCAL_S3_ACCESS_KEY = 'local';
const LOCAL_S3_SECRET_KEY = 'locallocal';

/** Where an omitted `to` lands - filler only (tier-6 routing keys on `from`; a
 *  reply-token spec passes an explicit relay+<token>@... address). */
const DEFAULT_INBOUND_TO = ['inbound@mail.local.test'];

/** A base64 attachment part of an inbound email. */
export interface InboundAttachment {
  filename: string;
  contentType: string;
  base64: string;
}

/** The control-plane inbound-send request (POST /control/send-inbound-email). */
export interface SendInboundOptions {
  from: string;
  to?: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: InboundAttachment[];
  spamVerdict?: 'PASS' | 'FAIL' | 'GRAY';
  virusVerdict?: 'PASS' | 'FAIL';
  // Optional threading headers (B8 reply-in-thread specs); additive/pass-through.
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
}

export interface SendInboundResult {
  bucket: string;
  key: string;
  posted: boolean;
  /** The app webhook's response status to the SNS POST. */
  appStatus: number;
  sesMessageId: string;
}

/** Minimal fetch shape (only .status is read) so a stub is injectable in tests. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number }>;

/** The inbound config + injectable I/O seams. */
export interface MailEngineInboundOptions {
  /** The app's real address; the SNS notification POSTs to `${appBaseUrl}/webhooks/ses/inbound`. */
  appBaseUrl: string;
  /** x-origin-verify secret the app's origin-secret middleware requires (CF_ORIGIN_SECRET). */
  originSecret: string;
  /** MinIO bucket the raw MIME is written to (INBOUND_MAIL_BUCKET). */
  bucket?: string;
  /** MinIO endpoint (MEDIA_S3_ENDPOINT) - the shared local S3. */
  s3Endpoint?: string;
  /** Test seam: object-putter (no MinIO in unit tests). */
  putObject?: (key: string, body: Buffer, contentType: string) => Promise<void>;
  /** Test seam: fetch (no network in unit tests). */
  fetchImpl?: FetchLike;
}

interface MimePart {
  headers: string[];
  body: string;
}

const CRLF = '\r\n';

function randBoundary(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

/** Split base64 into <= 76-char lines (RFC 2045 line-length limit). */
function chunkBase64(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? [b64]).join(CRLF);
}

function renderPart(part: MimePart): string {
  return `${part.headers.join(CRLF)}${CRLF}${CRLF}${part.body}`;
}

function textPart(text: string): MimePart {
  return { headers: ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 7bit'], body: text };
}

function htmlPart(html: string): MimePart {
  return { headers: ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: 7bit'], body: html };
}

function attachmentPart(a: InboundAttachment): MimePart {
  return {
    headers: [
      `Content-Type: ${a.contentType}; name="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.filename}"`,
    ],
    body: chunkBase64(a.base64),
  };
}

function multipart(subtype: string, parts: MimePart[]): MimePart {
  const boundary = randBoundary(subtype);
  const chunks: string[] = [];
  for (const p of parts) {
    chunks.push(`--${boundary}`);
    chunks.push(renderPart(p));
  }
  chunks.push(`--${boundary}--`);
  return { headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`], body: chunks.join(CRLF) };
}

export interface BuildInboundMimeInput {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: InboundAttachment[];
  messageId: string;
  inReplyTo?: string;
  references?: string[];
}

/**
 * Hand-roll a valid MIME message (mailparser-parseable, but built WITHOUT any
 * library - ADJ-10). Structure: text/plain (no html/attachments) | multipart/
 * alternative[text,html] (html, no attachments) | multipart/mixed[content,
 * ...attachments] (attachments present, content = text or the alternative).
 * CRLF line endings throughout.
 */
export function buildInboundMime(input: BuildInboundMimeInput): string {
  const topHeaders: string[] = [`From: ${input.from}`, `To: ${input.to.join(', ')}`];
  if (input.cc !== undefined && input.cc.length > 0) topHeaders.push(`Cc: ${input.cc.join(', ')}`);
  topHeaders.push(`Subject: ${input.subject}`);
  topHeaders.push(`Message-ID: ${input.messageId}`);
  if (input.inReplyTo !== undefined) topHeaders.push(`In-Reply-To: ${input.inReplyTo}`);
  if (input.references !== undefined && input.references.length > 0) {
    topHeaders.push(`References: ${input.references.join(' ')}`);
  }
  topHeaders.push(`Date: ${new Date().toUTCString()}`);
  topHeaders.push('MIME-Version: 1.0');

  const attachments = input.attachments ?? [];
  const content: MimePart =
    input.html !== undefined ? multipart('alternative', [textPart(input.text), htmlPart(input.html)]) : textPart(input.text);
  const root: MimePart = attachments.length > 0 ? multipart('mixed', [content, ...attachments.map(attachmentPart)]) : content;

  return `${[...topHeaders, ...root.headers].join(CRLF)}${CRLF}${CRLF}${root.body}${CRLF}`;
}

/** Build the SNS-shaped receipt notification the app's parseSnsSesNotification reads. */
function buildSnsReceiptNotification(args: {
  bucket: string;
  key: string;
  spamVerdict: string;
  virusVerdict: string;
  sesMessageId: string;
}): Record<string, unknown> {
  const now = new Date().toISOString();
  const inner = {
    notificationType: 'Received',
    receipt: {
      timestamp: now,
      action: { type: 'S3', bucketName: args.bucket, objectKey: args.key },
      spamVerdict: { status: args.spamVerdict },
      virusVerdict: { status: args.virusVerdict },
    },
    mail: { messageId: args.sesMessageId, timestamp: now },
  };
  return {
    Type: 'Notification',
    MessageId: randomUUID(),
    TopicArn: 'arn:aws:sns:us-east-1:000000000000:fake-mail-inbound',
    Message: JSON.stringify(inner),
    Timestamp: now,
  };
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init) as Promise<{ status: number }>;



/** Unfold the TOP-LEVEL header block of a raw MIME string into one line per header.
 *  Headers end at the FIRST blank line; anything after (the body, including a MIME
 *  part's own `Content-Type: image/png`) is NOT scanned as a top-level header. RFC
 *  5322 folding: a line beginning with WSP (space/tab) continues the previous
 *  header, so it is joined back on. */
function topLevelHeaderLines(rawMime: string): string[] {
  const normalized = rawMime.replace(/\r\n/g, '\n');
  const blank = normalized.indexOf('\n\n');
  const headerBlock = blank === -1 ? normalized : normalized.slice(0, blank);
  const unfolded: string[] = [];
  for (const line of headerBlock.split('\n')) {
    const prevIndex = unfolded.length - 1;
    const prev = unfolded[prevIndex];
    if (/^[ \t]/.test(line) && prev !== undefined) {
      unfolded[prevIndex] = `${prev} ${line.trim()}`;
    } else {
      unfolded.push(line);
    }
  }
  return unfolded;
}

/** First header value matching `name` (case-insensitive), or undefined. */
function headerValue(lines: string[], name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    if (line.slice(0, idx).trim().toLowerCase() === lower) {
      return line.slice(idx + 1).trim();
    }
  }
  return undefined;
}

/** Comma-split an address header into bare addr-specs. Pulls the `<addr>` out of a
 *  `Name <addr>` form; otherwise takes the trimmed token. Empty entries dropped.
 *  Pragmatic (a display name containing a literal comma would over-split) - fine
 *  for a local test double; the app never composes such addresses in e2e. */
function splitAddresses(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  return value
    .split(',')
    .map((part) => {
      const inner = part.match(/<([^>]+)>/)?.[1];
      return (inner ?? part).trim();
    })
    .filter((addr) => addr.length > 0);
}

export interface MailEngineDeps {
  /** The shared event bus - `mail.outbound` events reach the SSE stream through it. */
  hub: EventHub;
  /** Injectable for tests; defaults to a fresh store. */
  store?: MailStore;
  /** Inbound (email-channel B4) config + I/O seams. Absent -> sendInbound throws. */
  inbound?: MailEngineInboundOptions;
}

export class MailEngine {
  private readonly hub: EventHub;
  private readonly store: MailStore;
  private readonly inbound: MailEngineInboundOptions | undefined;
  private seq = 0;
  private inSeq = 0;
  /** Memoized MinIO client (built on first real sendInbound; skipped when a
   *  putObject seam is injected, so unit tests never touch @aws-sdk). */
  private s3: S3Client | undefined;

  constructor(deps: MailEngineDeps) {
    this.hub = deps.hub;
    this.store = deps.store ?? new MailStore();
    this.inbound = deps.inbound;
  }

  /** Capture an outbound SESv2 SendEmail whose Content.Raw.Data is `rawMimeBase64`.
   *  Decodes it, string-scans the headers, stores the record, emits `mail.outbound`,
   *  and returns the stored record (its sesMessageId is echoed back as MessageId). */
  recordOutbound(rawMimeBase64: string): StoredEmail {
    const rawMime = Buffer.from(rawMimeBase64, 'base64').toString('utf8');
    const headers = topLevelHeaderLines(rawMime);
    const messageIdHeader = headerValue(headers, 'message-id');
    this.seq += 1;
    const email: StoredEmail = {
      sesMessageId: `ses-fake-${this.seq}`,
      rawMime,
      to: splitAddresses(headerValue(headers, 'to')),
      cc: splitAddresses(headerValue(headers, 'cc')),
      subject: headerValue(headers, 'subject') ?? '',
      ...(messageIdHeader !== undefined && { messageIdHeader }),
      receivedAt: new Date().toISOString(),
      state: 'sent',
    };
    this.store.add(email);
    this.hub.emit({ type: 'mail.outbound', mail: email });
    return email;
  }

  /** All captured emails, newest first (the `GET /control/emails` payload). */
  list(): StoredEmail[] {
    return this.store.list();
  }

  /** All inbound deliveries, newest first (`GET /control/inbound-emails`). */
  listInbound(): InboundEmailRecord[] {
    return this.store.listInbound();
  }

  /** The default MinIO putter - pins fixed local creds (never ambient AWS_*, D3). */
  private putObjectViaMinio(bucket: string): (key: string, body: Buffer, contentType: string) => Promise<void> {
    if (this.s3 === undefined) {
      this.s3 = new S3Client({
        region: process.env.AWS_REGION ?? 'us-east-1',
        ...(this.inbound?.s3Endpoint !== undefined && { endpoint: this.inbound.s3Endpoint }),
        forcePathStyle: true,
        credentials: { accessKeyId: LOCAL_S3_ACCESS_KEY, secretAccessKey: LOCAL_S3_SECRET_KEY },
      });
    }
    const client = this.s3;
    return async (key, body, contentType) => {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    };
  }

  /**
   * Deliver ONE inbound email: build MIME -> write to MinIO INBOUND_MAIL_BUCKET ->
   * POST the SNS-shaped receipt to the app webhook (with x-origin-verify). Returns
   * the bucket/key + the app's response status (surfaced for debuggability). Throws
   * when inbound is not configured or the bucket is unset (the control route -> 502).
   */
  async sendInbound(opts: SendInboundOptions): Promise<SendInboundResult> {
    const inbound = this.inbound;
    if (inbound === undefined) throw new Error('mail engine inbound is not configured');
    const bucket = inbound.bucket;
    if (bucket === undefined || bucket.length === 0) {
      throw new Error('INBOUND_MAIL_BUCKET is not set - cannot write inbound MIME to MinIO');
    }

    this.inSeq += 1;
    const to = opts.to ?? DEFAULT_INBOUND_TO;
    const messageId = opts.messageId ?? `<inbound-${this.inSeq}-${randomUUID()}@fake.inbound>`;
    const mime = buildInboundMime({
      from: opts.from,
      to,
      ...(opts.cc !== undefined && { cc: opts.cc }),
      subject: opts.subject,
      text: opts.text,
      ...(opts.html !== undefined && { html: opts.html }),
      ...(opts.attachments !== undefined && { attachments: opts.attachments }),
      messageId,
      ...(opts.inReplyTo !== undefined && { inReplyTo: opts.inReplyTo }),
      ...(opts.references !== undefined && { references: opts.references }),
    });
    const key = `inbound/${this.inSeq}-${randomUUID()}.eml`;
    const sesMessageId = `ses-inbound-${this.inSeq}`;

    // 1. Write the raw MIME to MinIO (the SES receipt-rule S3 target).
    const putObject = inbound.putObject ?? this.putObjectViaMinio(bucket);
    await putObject(key, Buffer.from(mime, 'utf8'), 'message/rfc822');

    // 2. POST the SNS-shaped receipt notification to the app's dev webhook.
    const snsBody = buildSnsReceiptNotification({
      bucket,
      key,
      spamVerdict: opts.spamVerdict ?? 'PASS',
      virusVerdict: opts.virusVerdict ?? 'PASS',
      sesMessageId,
    });
    const fetchImpl = inbound.fetchImpl ?? defaultFetch;
    const res = await fetchImpl(`${inbound.appBaseUrl}/webhooks/ses/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-origin-verify': inbound.originSecret },
      body: JSON.stringify(snsBody),
    });

    const record: InboundEmailRecord = {
      key,
      bucket,
      from: opts.from,
      to,
      subject: opts.subject,
      appStatus: res.status,
      receivedAt: new Date().toISOString(),
    };
    this.store.addInbound(record);
    this.hub.emit({ type: 'mail.inbound', mail: record });
    return { bucket, key, posted: true, appStatus: res.status, sesMessageId };
  }

  /** Clear the mail store - the DISJOINT `POST /control/reset-mail` surface. */
  reset(): void {
    this.store.reset();
  }
}
