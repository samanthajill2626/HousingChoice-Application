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
import { Readable, Transform } from 'node:stream';
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

/**
 * Outbound call origination params (M1.9a). The INBOUND masked bridge needs no
 * REST call — it answers Twilio's inbound webhook with <Dial> TwiML. This is
 * the seam for the OUTBOUND legs: press-0 → team and the later founder-bridge.
 * `twimlUrl` is the voice webhook URL Twilio fetches to drive the new call;
 * `from` MUST be a number we own (a pool number for masked calls — NEVER the
 * real caller's number).
 */
export interface InitiateCallParams {
  to: string;
  from: string;
  /** Absolute https URL Twilio fetches for the new call's TwiML. */
  twimlUrl: string;
  /** Deterministic-fake CallSid hint for the console driver (no network). */
  idempotencyKey?: string;
}

export interface InitiateCallResult {
  /** Provider call SID (Twilio CAxxx). */
  callSid: string;
}

export interface MessagingAdapter {
  sendMessage(params: SendMessageParams): Promise<SendMessageResult>;
  /** Streams-only media fetch (Builder B: MMS → S3 mirroring). */
  getMediaStream(mediaUrl: string): Promise<Readable>;
  /**
   * Streams-only RECORDING-media fetch (M1.9c founder-bridge call recording):
   * the recordingStatusCallback hands us a RecordingUrl on api.twilio.com that
   * needs the same basic-auth first hop + the same SSRF allowlist + size cap as
   * MMS media (RecordingUrl is webhook-shaped input). Identical guarantees to
   * getMediaStream; a distinct method only so call-recording media can be wired
   * independently (and so the `.mp3` suffix convention below is documented). PII
   * (doc §9): the bytes are the call audio — never log the URL/content.
   */
  getRecordingStream(recordingUrl: string): Promise<Readable>;
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
  /**
   * Originate an OUTBOUND call (M1.9a). NOT used by the inbound masked bridge
   * (that answers with <Dial> TwiML) — this is the seam for press-0 → team and
   * the later founder-bridge. The Twilio driver calls client.calls.create; the
   * console driver returns a deterministic `CAconsole-*` CallSid, no network.
   * PII (doc §9): the driver logs the CallSid only, never the to/from numbers.
   */
  initiateCall(params: InitiateCallParams): Promise<InitiateCallResult>;
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
 * Wrap a media Readable in a byte-COUNTING cap (FIX 3). The Content-Length
 * header is a cheap early-out but is unreliable: a chunked / Content-Length-less
 * response (common once Twilio 302-redirects the media to S3) would otherwise
 * stream UNBOUNDED into our bucket. This Transform tracks the running byte total
 * and, the moment it exceeds `maxBytes`, aborts the in-flight fetch (so the
 * socket closes — no more bytes pulled) and fails the stream with the same
 * `too_large` refusal the header check raises. Bytes already seen are bounded by
 * `maxBytes + one chunk`; nothing past the cap is ever written downstream.
 */
function capStreamBySize(source: Readable, maxBytes: number, controller: AbortController, op: string): Readable {
  let total = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        // Stop pulling more bytes from the network, then fail the pipeline with
        // the typed refusal (destroys `counter`; the pipe tears down `source`).
        controller.abort();
        callback(
          new MediaFetchRefusedError(
            `${op}: streamed bytes exceeded the ${maxBytes}-byte cap`,
            'too_large',
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
  // If the SOURCE errors (e.g. the abort above surfaces as an AbortError on the
  // underlying body), propagate it so the consumer's pipe rejects rather than
  // hanging. An AbortError AFTER we've already failed `counter` with the typed
  // refusal is redundant — swallow it so it can't become an unhandled 'error'.
  source.on('error', (err) => {
    if (!counter.destroyed) counter.destroy(err);
  });
  return source.pipe(counter);
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
   * Outbound call origination (M1.9a). Optional on the interface so the
   * existing message-only fakes keep compiling; the real twilio SDK provides
   * it, and the driver guards with a clear error when a fake omits it.
   */
  calls?: {
    create(params: { to: string; from: string; url: string }): Promise<{ sid: string }>;
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

  async initiateCall(params: InitiateCallParams): Promise<InitiateCallResult> {
    const calls = this.client.calls;
    if (!calls) {
      throw new Error('TwilioMessagingDriver: client lacks the calls API');
    }
    // from MUST be a number we own (a pool number for masked calls) — the
    // caller guarantees this; the masked-call invariant is never the real
    // caller's number. PII: log the CallSid only, never to/from.
    const call = await calls.create({ to: params.to, from: params.from, url: params.twimlUrl });
    this.log.info({ callSid: call.sid }, 'twilio call initiated');
    return { callSid: call.sid };
  }

  async getMediaStream(mediaUrl: string): Promise<Readable> {
    return this.fetchTwilioMediaStream(mediaUrl, 'getMediaStream');
  }

  async getRecordingStream(recordingUrl: string): Promise<Readable> {
    // M1.9c: the founder-bridge recording media. RecordingUrl comes off the
    // recordingStatusCallback (api.twilio.com/.../Recordings/RExxxx) — same
    // basic-auth first hop + SSRF allowlist + size cap as MMS media. We request
    // a concrete media representation by suffixing `.mp3` (Twilio serves the
    // dual-channel recording as MP3); without a suffix Twilio returns an XML
    // metadata doc, not the audio. The suffix is added only when one is absent
    // so a callback that already carries an extension is honored.
    const withExt = /\.(mp3|wav)$/i.test(recordingUrl) ? recordingUrl : `${recordingUrl}.mp3`;
    return this.fetchTwilioMediaStream(withExt, 'getRecordingStream');
  }

  /**
   * Shared authenticated, SSRF-guarded, size-capped streaming fetch for any
   * Twilio media URL (MMS attachments AND call recordings). STREAMS ONLY — the
   * Readable is piped straight from the HTTP response; nothing buffers whole
   * bodies (binding guideline 1). PII (doc §9): never log the URL or the bytes.
   */
  private async fetchTwilioMediaStream(mediaUrl: string, op: string): Promise<Readable> {
    // SSRF guard FIRST — before any credentials are attached: the URL comes off
    // a webhook form (MediaUrl{i} / RecordingUrl), so an exact-host https-only
    // allowlist keeps a forged URL from pointing our authenticated fetch
    // anywhere else.
    const url = new URL(mediaUrl);
    if (url.protocol !== 'https:' || url.hostname !== TWILIO_MEDIA_HOST) {
      throw new MediaFetchRefusedError(
        `${op}: refusing media URL outside https://${TWILIO_MEDIA_HOST} (got ${url.protocol}//${url.hostname})`,
        'host_not_allowed',
      );
    }
    const auth = Buffer.from(`${this.deps.apiKeySid}:${this.deps.apiKeySecret}`).toString('base64');
    const controller = new AbortController();
    // REDIRECT NOTE (accepted): api.twilio.com 302-redirects media/recordings to
    // a signed S3 URL, and fetch follows that redirect WITHOUT us re-validating
    // the redirect's host against the allowlist (the allowlist only gates the
    // FIRST hop above). This is accepted because (a) undici strips the
    // Authorization header on the cross-origin redirect, so our basic-auth
    // credentials never leave api.twilio.com, and (b) FIX 3's byte-counting cap
    // below bounds how much a redirected response can stream regardless of where
    // it lands. So a hijacked redirect can neither exfiltrate our creds nor write
    // an unbounded object into S3.
    const res = await fetch(url, {
      headers: { authorization: `Basic ${auth}` },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`${op}: ${res.status} ${res.statusText} fetching Twilio media`);
    }
    // Size cap, layer 1 (cheap early-out): refuse up front when the response
    // ADVERTISES an oversize Content-Length, before streaming a byte.
    const contentLength = Number(res.headers.get('content-length') ?? 0);
    if (contentLength > MAX_MEDIA_CONTENT_LENGTH) {
      controller.abort();
      throw new MediaFetchRefusedError(
        `${op}: Content-Length ${contentLength} exceeds the ${MAX_MEDIA_CONTENT_LENGTH}-byte cap`,
        'too_large',
      );
    }
    // Size cap, layer 2 (the authority — FIX 3): a chunked / Content-Length-less
    // response (common via the S3 redirect) would bypass the header check, so
    // enforce the cap on the ACTUAL byte stream. The counter aborts the fetch +
    // fails the stream with the same `too_large` refusal once the running total
    // exceeds the cap — nothing past the cap is ever written into S3.
    const source = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
    return capStreamBySize(source, MAX_MEDIA_CONTENT_LENGTH, controller, op);
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

  async getRecordingStream(recordingUrl: string): Promise<Readable> {
    // Local loop: no real Twilio voice / no real recording media. Plain
    // streamed fetch (parity with getMediaStream) so a simulated callback that
    // points at a local fixture still streams; the console driver is never used
    // against api.twilio.com.
    const res = await fetch(recordingUrl);
    if (!res.ok || !res.body) {
      throw new Error(`getRecordingStream: ${res.status} ${res.statusText} fetching recording`);
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

  async initiateCall(params: InitiateCallParams): Promise<InitiateCallResult> {
    // NEVER hits Twilio: a deterministic fake CallSid (CAconsole-*), mirroring
    // the sendMessage SMconsole-* convention. PII: never log to/from.
    this.log.info({ callSid: `CAconsole-${params.idempotencyKey ?? 'x'}` }, 'console messaging driver: call "initiated"');
    return { callSid: `CAconsole-${params.idempotencyKey ?? randomUUID()}` };
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
