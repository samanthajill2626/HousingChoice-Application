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
  /**
   * Explicit sender number, E.164 (M1.7 relay fan-out): the pool number the
   * relay message must originate FROM. When set, the Twilio driver sends
   * `from` AS WELL AS messagingServiceSid (A2P compliance via the service's
   * sender pool, pinned to this specific number); when unset, the service
   * picks a sender (the 1:1 path is unchanged). Console driver echoes it.
   */
  from?: string;
}

/** Provisioned phone-number capabilities (M1.7). */
export interface PhoneNumberCapabilities {
  sms: boolean;
  voice: boolean;
}

export interface ProvisionPhoneNumberResult {
  phoneNumber: string;
  capabilities: PhoneNumberCapabilities;
  /** Provider resource SID (Twilio IncomingPhoneNumber PNxxx). */
  sid: string;
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
  /**
   * Provision a NEW phone number for a relay group (M1.7). MUST return a
   * voice+sms-capable number — M1.7 pre-wires the voice webhook so the M1.9
   * masked-calling bridge is a config flip, not a re-provision. Throws
   * VoiceCapabilityError when no voice-capable number is available, so a
   * misconfigured account fails at provision time, not at call time.
   */
  provisionPhoneNumber(opts: {
    voiceCapable: true;
    areaCode?: string;
  }): Promise<ProvisionPhoneNumberResult>;
  /**
   * Point a provisioned number's voice webhook at `voiceUrl` (M1.7 pre-wiring
   * for M1.9). The Twilio driver sets VoiceUrl on the IncomingPhoneNumber;
   * the console driver logs a no-op.
   */
  setVoiceWebhook(phoneNumber: string, voiceUrl: string): Promise<void>;
}

/** Twilio media host allowlist — MediaUrl{i} values always live here. */
const TWILIO_MEDIA_HOST = 'api.twilio.com';

/** Mirrored media size cap: anything bigger than this is refused, not streamed. */
export const MAX_MEDIA_CONTENT_LENGTH = 25 * 1024 * 1024; // 25 MB

/**
 * Typed refusal for media fetches the Twilio driver will not perform: a
 * non-Twilio/non-https URL (SSRF guard — webhook params are attacker-shaped
 * input and the fetch carries our basic-auth credentials) or an oversize
 * Content-Length. The webhook media loop treats this like any other
 * per-attachment failure: ERROR + continue.
 */
export class MediaFetchRefusedError extends Error {
  constructor(
    message: string,
    readonly reason: 'host_not_allowed' | 'too_large',
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Provisioning could not yield a voice-capable number (M1.7). A relay pool
 * number MUST be voice-capable (M1.9 masked calling rides the same number), so
 * a misconfigured account / exhausted inventory fails LOUD at provision time
 * rather than silently handing out an SMS-only number that breaks calling
 * later. The poolNumbers service surfaces it; the API route maps it to 503.
 */
export class VoiceCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

// ---------------------------------------------------------------------------
// Twilio driver — production path (Programmable Messaging REST).
// ---------------------------------------------------------------------------

/** A Twilio AvailablePhoneNumber search result row (the fields we read). */
export interface TwilioAvailableNumber {
  phoneNumber: string;
  capabilities?: { SMS?: boolean; sms?: boolean; voice?: boolean; MMS?: boolean };
}

/** A purchased Twilio IncomingPhoneNumber resource (the fields we read/update). */
export interface TwilioIncomingNumber {
  sid: string;
  phoneNumber: string;
  capabilities?: { sms?: boolean; voice?: boolean; mms?: boolean };
}

/** Minimal client surface so tests inject a fake — no network, ever. */
export interface TwilioClientLike {
  messages: {
    create(params: {
      to: string;
      from?: string;
      body?: string;
      mediaUrl?: string[];
      messagingServiceSid: string;
    }): Promise<{ sid: string; status: string; dateCreated: Date | null }>;
  };
  /**
   * Number provisioning (M1.7). Optional on the interface so the existing
   * message-only fakes in the M1.1 tests keep compiling; the real twilio SDK
   * provides all of these, and the driver guards with a clear error when a
   * fake omits them.
   */
  availablePhoneNumbers?: (country: string) => {
    local: {
      list(params: {
        voiceEnabled?: boolean;
        smsEnabled?: boolean;
        areaCode?: number;
        limit?: number;
      }): Promise<TwilioAvailableNumber[]>;
    };
  };
  incomingPhoneNumbers?: {
    create(params: {
      phoneNumber: string;
      smsUrl?: string;
      voiceUrl?: string;
    }): Promise<TwilioIncomingNumber>;
    list(params: { phoneNumber: string; limit?: number }): Promise<TwilioIncomingNumber[]>;
    (sid: string): { update(params: { voiceUrl?: string }): Promise<TwilioIncomingNumber> };
  };
}

/**
 * Twilio transient-throttle error codes (doc §9 "Send failures"): 429 (HTTP
 * Too Many Requests) and 30022 (Twilio "Rate exceeded"). These are the codes
 * the relay + broadcast fan-out classifiers back off on; the driver emits ONE
 * `send_throttled` marker per throttled send at this single provider-send
 * boundary so the metric counts each occurrence exactly once (no per-path
 * double-logging).
 */
const SEND_THROTTLE_CODES = new Set(['429', '30022']);

/** Best-effort provider error-code extraction (Twilio attaches `code`/`status`). */
function providerErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'number') return String(code);
    if (typeof code === 'string' && code.length > 0) return code;
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number') return String(status);
  }
  return undefined;
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
  /**
   * Public https base URL (the CloudFront domain) — used to pre-wire a newly
   * provisioned number's SmsUrl (inbound webhook) and VoiceUrl (M1.9 voice
   * bridge, M1.7 pre-wiring). When unset, provisioning still purchases the
   * number but skips webhook wiring with a WARN.
   */
  publicBaseUrl?: string;
  /** Injected fake in unit tests; defaults to the real twilio client. */
  client?: TwilioClientLike;
  logger?: Logger;
}

/** Webhook paths a provisioned relay pool number is pre-wired to (M1.7). */
const SMS_WEBHOOK_PATH = '/webhooks/twilio/sms';
const VOICE_WEBHOOK_PATH = '/webhooks/twilio/voice';

export class TwilioMessagingDriver implements MessagingAdapter {
  private readonly client: TwilioClientLike;
  private readonly log: Logger;

  constructor(private readonly deps: TwilioMessagingDriverDeps) {
    // API key SID/secret + account SID — never the auth token (webhook-only).
    this.client = deps.client ?? twilio(deps.apiKeySid, deps.apiKeySecret, { accountSid: deps.accountSid });
    this.log = deps.logger ?? defaultLogger;
  }

  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    let message;
    try {
      message = await this.client.messages.create({
        to: params.to,
        ...(params.body !== undefined && { body: params.body }),
        ...(params.mediaUrls !== undefined && { mediaUrl: params.mediaUrls }),
        // The Messaging Service is the sender (A2P sender pool) AND carries the
        // service-level status callback — no per-message statusCallback needed.
        messagingServiceSid: this.deps.messagingServiceSid,
        // Relay fan-out (M1.7): pin the send to a specific pool number while
        // staying inside the A2P service (the number is in the service's sender
        // pool). Omitted for the 1:1 path — the service picks the sender.
        ...(params.from !== undefined && { from: params.from }),
      });
    } catch (err) {
      // Send-throttle marker (doc §9 "Send failures"): a 429/30022 at the
      // provider is a transient throttle. Emit ONE `send_throttled` marker
      // here — the single shared send boundary every path (relay/broadcast/
      // retry) funnels through — so the SendThrottled metric counts each
      // throttled send exactly once. IDs/codes only, never the body (PII).
      // The error is re-thrown unchanged so each caller's existing classify/
      // back-off logic is untouched (this only ADDS the countable signal).
      const code = providerErrorCode(err);
      if (code !== undefined && SEND_THROTTLE_CODES.has(code)) {
        this.log.warn(
          { event: 'send_throttled', errorCode: code },
          'twilio send throttled (429/30022) — transient rate limit',
        );
      }
      throw err;
    }
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

  async provisionPhoneNumber(opts: {
    voiceCapable: true;
    areaCode?: string;
  }): Promise<ProvisionPhoneNumberResult> {
    const available = this.client.availablePhoneNumbers;
    const incoming = this.client.incomingPhoneNumbers;
    if (!available || !incoming) {
      throw new Error('TwilioMessagingDriver: client lacks number-provisioning APIs');
    }
    // Search for a voice+sms-capable local number. A misconfigured account or
    // exhausted inventory returns none — fail loud (relay needs voice).
    const candidates = await available('US').local.list({
      voiceEnabled: true,
      smsEnabled: true,
      ...(opts.areaCode !== undefined && { areaCode: Number(opts.areaCode) }),
      limit: 1,
    });
    const candidate = candidates[0];
    if (!candidate) {
      throw new VoiceCapabilityError(
        'provisionPhoneNumber: no voice+sms-capable number available to purchase',
      );
    }
    // Pre-wire SmsUrl (inbound) + VoiceUrl (M1.9 bridge) at purchase time when
    // the public base URL is known.
    const base = this.deps.publicBaseUrl;
    const purchased = await incoming.create({
      phoneNumber: candidate.phoneNumber,
      ...(base !== undefined && {
        smsUrl: `${base}${SMS_WEBHOOK_PATH}`,
        voiceUrl: `${base}${VOICE_WEBHOOK_PATH}`,
      }),
    });
    const capabilities: PhoneNumberCapabilities = {
      sms: purchased.capabilities?.sms ?? candidate.capabilities?.sms ?? false,
      voice: purchased.capabilities?.voice ?? candidate.capabilities?.voice ?? false,
    };
    // Verify the purchased number really is voice-capable — never trust the
    // search filter alone (the purchase is the source of truth).
    if (!capabilities.voice) {
      throw new VoiceCapabilityError(
        `provisionPhoneNumber: purchased number ${purchased.sid} is not voice-capable`,
      );
    }
    if (base === undefined) {
      this.log.warn(
        { sid: purchased.sid },
        'provisioned number but PUBLIC_BASE_URL unset — webhooks NOT pre-wired',
      );
    }
    this.log.info({ sid: purchased.sid }, 'twilio phone number provisioned (voice+sms)');
    return { phoneNumber: purchased.phoneNumber, capabilities, sid: purchased.sid };
  }

  async setVoiceWebhook(phoneNumber: string, voiceUrl: string): Promise<void> {
    const incoming = this.client.incomingPhoneNumbers;
    if (!incoming) {
      throw new Error('TwilioMessagingDriver: client lacks number-provisioning APIs');
    }
    // Look the number up by E.164 to get its resource SID, then update VoiceUrl.
    const matches = await incoming.list({ phoneNumber, limit: 1 });
    const match = matches[0];
    if (!match) {
      throw new Error('setVoiceWebhook: no IncomingPhoneNumber resource for the given number');
    }
    await incoming(match.sid).update({ voiceUrl });
    this.log.info({ sid: match.sid }, 'twilio voice webhook set');
  }

  async getMediaStream(mediaUrl: string): Promise<Readable> {
    // SSRF guard FIRST — before any credentials are attached: MediaUrl{i}
    // comes off a webhook form, so an exact-host https-only allowlist keeps
    // a forged URL from pointing our authenticated fetch anywhere else.
    const url = new URL(mediaUrl);
    if (url.protocol !== 'https:' || url.hostname !== TWILIO_MEDIA_HOST) {
      throw new MediaFetchRefusedError(
        `getMediaStream: refusing media URL outside https://${TWILIO_MEDIA_HOST} (got ${url.protocol}//${url.hostname})`,
        'host_not_allowed',
      );
    }
    const auth = Buffer.from(`${this.deps.apiKeySid}:${this.deps.apiKeySecret}`).toString('base64');
    const controller = new AbortController();
    const res = await fetch(url, {
      headers: { authorization: `Basic ${auth}` },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`getMediaStream: ${res.status} ${res.statusText} fetching Twilio media`);
    }
    // Size cap: refuse oversize media up front instead of streaming 25MB+
    // into S3 (MMS media is carrier-capped far below this anyway).
    const contentLength = Number(res.headers.get('content-length') ?? 0);
    if (contentLength > MAX_MEDIA_CONTENT_LENGTH) {
      controller.abort();
      throw new MediaFetchRefusedError(
        `getMediaStream: Content-Length ${contentLength} exceeds the ${MAX_MEDIA_CONTENT_LENGTH}-byte cap`,
        'too_large',
      );
    }
    return Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
  }
}

// ---------------------------------------------------------------------------
// Console driver — local dev: no Twilio account, no network sends.
// ---------------------------------------------------------------------------

export class ConsoleMessagingDriver implements MessagingAdapter {
  private readonly log: Logger;
  /**
   * Monotonic counter for deterministic fake provisioned numbers (M1.7) so
   * tests are stable: each call yields a fresh +1555-prefixed E.164. Instance-
   * scoped — a fresh driver per app/test starts the sequence over.
   */
  private provisionCounter = 0;

  constructor(deps: { logger?: Logger } = {}) {
    this.log = deps.logger ?? defaultLogger;
  }

  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    // Redacted by design: recipient + lengths only — never the body (PII).
    this.log.info(
      {
        to: params.to,
        ...(params.from !== undefined && { from: params.from }),
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

  async provisionPhoneNumber(opts: {
    voiceCapable: true;
    areaCode?: string;
  }): Promise<ProvisionPhoneNumberResult> {
    // NEVER hits Twilio: a deterministic, always voice+sms-capable fake. The
    // areaCode (when supplied) is honored as a prefix hint so tests can assert
    // it threads through; voiceCapable is always satisfied (the fake has voice).
    this.provisionCounter += 1;
    const seq = String(this.provisionCounter).padStart(4, '0');
    const prefix = opts.areaCode !== undefined ? `+1${opts.areaCode}` : '+1555010';
    const phoneNumber = `${prefix}${seq}`.slice(0, 15); // E.164, stable per-call
    this.log.info({ sid: `PNconsole-${seq}` }, 'console messaging driver: phone number "provisioned"');
    return {
      phoneNumber,
      capabilities: { sms: true, voice: true },
      sid: `PNconsole-${seq}`,
    };
  }

  async setVoiceWebhook(phoneNumber: string, voiceUrl: string): Promise<void> {
    // No-op locally — there is no real number to wire. PII: never log the
    // number or the URL host beyond confirming the wiring path ran.
    void phoneNumber;
    void voiceUrl;
    this.log.info({ wired: true }, 'console messaging driver: voice webhook "set" (no-op)');
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
    ...(config.publicBaseUrl !== undefined && { publicBaseUrl: config.publicBaseUrl }),
    client: deps.twilioClient,
    logger: deps.logger,
  });
}
