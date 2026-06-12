// MessagingAdapter — the ONLY place the Twilio SDK is imported (adapter rule).
//
// Twilio **Programmable Messaging** only — NOT the Conversations product
// (intentional deviation, README "Deviations" table 2026-06-12): every
// outbound send goes through the A2P Messaging Service
// (TWILIO_MESSAGING_SERVICE_SID); our DynamoDB conversations table is the
// only thread model.
//
// Auth: REST uses the API key SID/secret (+ account SID). The auth token is
// RESERVED for webhook HMAC validation (M1.1 Builder B) and never appears here.
//
// Status callbacks: the Messaging Service's service-level Delivery Status
// Callback URL (Integration settings) receives status webhooks (queued →
// sent → delivered/undelivered/failed, with error codes) for EVERY message
// sent through the service, so no per-message statusCallback parameter is
// passed — the per-message parameter exists only to OVERRIDE the service
// URL for a single message.
//
// Media: STREAMS ONLY (binding guideline 1) — getMediaStream() hands back a
// Readable piped straight from the HTTP response; nothing buffers whole
// bodies. Twilio media URLs need basic-auth on the first hop (the API-key
// pair works); undici drops the Authorization header on the cross-origin
// redirect to S3, which is exactly right.
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import twilio from 'twilio';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { DeliveryStatus } from '../repos/messagesRepo.js';

export interface SendMessageParams {
  /** Recipient phone, E.164. */
  to: string;
  body?: string;
  mediaUrls?: string[];
  /**
   * Caller-supplied dedupe key. Twilio Programmable Messaging has no
   * per-request idempotency token — DB-level dedupe by provider SID
   * (messagesRepo.append) is the real guard; drivers MAY use this for
   * deterministic fake SIDs (console driver does).
   */
  idempotencyKey?: string;
}

export interface SendMessageResult {
  /** Provider message SID (Twilio SMxxx/MMxxx). */
  providerSid: string;
  /** Initial delivery status, mapped onto our status machine. */
  status: DeliveryStatus;
  /** PROVIDER timestamp (ISO 8601) — the stable half of the messages SK. */
  providerTs: string;
}

export interface MessagingAdapter {
  sendMessage(params: SendMessageParams): Promise<SendMessageResult>;
  /** Streams-only media fetch (Builder B: MMS → S3 mirroring). */
  getMediaStream(mediaUrl: string): Promise<Readable>;
}

// ---------------------------------------------------------------------------
// Twilio driver — production path (Programmable Messaging REST).
// ---------------------------------------------------------------------------

/** Minimal client surface so tests inject a fake — no network, ever. */
export interface TwilioClientLike {
  messages: {
    create(params: {
      to: string;
      body?: string;
      mediaUrl?: string[];
      messagingServiceSid: string;
    }): Promise<{ sid: string; status: string; dateCreated: Date | null }>;
  };
}

/** Twilio MessageStatus → our delivery-status machine (unknowns stay queued). */
export function mapTwilioStatus(status: string): DeliveryStatus {
  switch (status) {
    case 'sent':
      return 'sent';
    case 'delivered':
    case 'read':
      return 'delivered';
    case 'undelivered':
      return 'undelivered';
    case 'failed':
    case 'canceled':
      return 'failed';
    default:
      // accepted | scheduled | queued | sending | anything new Twilio adds.
      return 'queued';
  }
}

export interface TwilioMessagingDriverDeps {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  messagingServiceSid: string;
  /** Injected fake in unit tests; defaults to the real twilio client. */
  client?: TwilioClientLike;
  logger?: Logger;
}

export class TwilioMessagingDriver implements MessagingAdapter {
  private readonly client: TwilioClientLike;
  private readonly log: Logger;

  constructor(private readonly deps: TwilioMessagingDriverDeps) {
    // API key SID/secret + account SID — never the auth token (webhook-only).
    this.client = deps.client ?? twilio(deps.apiKeySid, deps.apiKeySecret, { accountSid: deps.accountSid });
    this.log = deps.logger ?? defaultLogger;
  }

  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    const message = await this.client.messages.create({
      to: params.to,
      ...(params.body !== undefined && { body: params.body }),
      ...(params.mediaUrls !== undefined && { mediaUrl: params.mediaUrls }),
      // The Messaging Service is the sender (A2P sender pool) AND carries the
      // service-level status callback — no per-message statusCallback needed.
      messagingServiceSid: this.deps.messagingServiceSid,
    });
    // Redacted by design: SID + lengths only — never the body (PII).
    this.log.info(
      {
        providerSid: message.sid,
        providerStatus: message.status,
        bodyLength: params.body?.length ?? 0,
        mediaCount: params.mediaUrls?.length ?? 0,
      },
      'twilio message created',
    );
    return {
      providerSid: message.sid,
      status: mapTwilioStatus(message.status),
      providerTs: (message.dateCreated ?? new Date()).toISOString(),
    };
  }

  async getMediaStream(mediaUrl: string): Promise<Readable> {
    const auth = Buffer.from(`${this.deps.apiKeySid}:${this.deps.apiKeySecret}`).toString('base64');
    const res = await fetch(mediaUrl, { headers: { authorization: `Basic ${auth}` } });
    if (!res.ok || !res.body) {
      throw new Error(`getMediaStream: ${res.status} ${res.statusText} fetching Twilio media`);
    }
    return Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
  }
}

// ---------------------------------------------------------------------------
// Console driver — local dev: no Twilio account, no network sends.
// ---------------------------------------------------------------------------

export class ConsoleMessagingDriver implements MessagingAdapter {
  private readonly log: Logger;

  constructor(deps: { logger?: Logger } = {}) {
    this.log = deps.logger ?? defaultLogger;
  }

  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    // Redacted by design: recipient + lengths only — never the body (PII).
    this.log.info(
      {
        to: params.to,
        bodyLength: params.body?.length ?? 0,
        mediaCount: params.mediaUrls?.length ?? 0,
      },
      'console messaging driver: message "sent"',
    );
    return {
      // Deterministic when an idempotencyKey is supplied, else random.
      providerSid: `SMconsole-${params.idempotencyKey ?? randomUUID()}`,
      status: 'sent',
      providerTs: new Date().toISOString(),
    };
  }

  async getMediaStream(mediaUrl: string): Promise<Readable> {
    // Local media needs no provider auth — plain streamed fetch.
    const res = await fetch(mediaUrl);
    if (!res.ok || !res.body) {
      throw new Error(`getMediaStream: ${res.status} ${res.statusText} fetching media`);
    }
    return Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
  }
}

// ---------------------------------------------------------------------------
// Factory — driver selection from config (MESSAGING_DRIVER).
// ---------------------------------------------------------------------------

export interface CreateMessagingAdapterDeps {
  config?: AppConfig;
  logger?: Logger;
  /** Test seam: injected into the Twilio driver. */
  twilioClient?: TwilioClientLike;
}

export function createMessagingAdapter(deps: CreateMessagingAdapterDeps = {}): MessagingAdapter {
  const config = deps.config ?? loadConfig();
  if (config.messagingDriver === 'console') {
    return new ConsoleMessagingDriver({ logger: deps.logger });
  }
  // loadConfig() fail-fasts these for MESSAGING_DRIVER=twilio; this guard
  // covers hand-built AppConfig objects.
  if (
    !config.twilioAccountSid ||
    !config.twilioApiKeySid ||
    !config.twilioApiKeySecret ||
    !config.twilioMessagingServiceSid
  ) {
    throw new Error('createMessagingAdapter: messagingDriver=twilio but twilio* config is incomplete');
  }
  return new TwilioMessagingDriver({
    accountSid: config.twilioAccountSid,
    apiKeySid: config.twilioApiKeySid,
    apiKeySecret: config.twilioApiKeySecret,
    messagingServiceSid: config.twilioMessagingServiceSid,
    client: deps.twilioClient,
    logger: deps.logger,
  });
}
