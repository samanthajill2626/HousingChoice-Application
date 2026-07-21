// Inbound-email ingestion (email-channel B2) - ONE channel-agnostic service
// consumed by both delivery mechanisms (prod: SES -> S3 -> SNS -> SQS worker
// consumer; local/e2e: fake-SES POST to the dev-gated webhook - both B4).
//
// Routing tiers, IN ORDER (plan Task B2; each pinned by a test):
//   0. HEAD the S3 object: > 30 MB -> quarantine row `parse_skipped:'oversize'`
//      - the raw bytes are NEVER loaded (DoS F17-1).
//   1. Idempotency - DURABLE-WRITE-FIRST; the object marker is a fast path ONLY
//      (fix-wave B; the old claim-before-write traded a retry-loop guard for
//      silent mail loss on any post-claim store failure). The terminal durable
//      write is the source of truth and each is INDEPENDENTLY idempotent:
//        - threaded: append()'s transactional sid# pointer (INBOUND providerSid
//          == the RFC id) dedupes a redelivery; side effects run only on a
//          fresh append (deduped=false).
//        - side-door: putUnmatched writes a DETERMINISTIC id
//          (um-<sha256(bucket/key)>) via a conditional put; a redelivery is a
//          no-op (created=false) and the SSE is skipped.
//      The S3 OBJECT-KEY marker (`job#email#obj#<sha256(bucket/key)>`) is
//      claimed AFTER that terminal write (terminal-write-THEN-marker) and only
//      lets a clean redelivery skip the head/fetch/parse work. Correctness
//      NEVER rests on it: a process kill BETWEEN the durable write and the
//      marker leaves no marker, so the redelivery re-runs and CONVERGES on the
//      idempotent write (no double side effect, no lost mail); a kill BEFORE
//      the durable write also leaves no marker -> up to maxReceiveCount(5)
//      receives -> the DLQ (visible + alarmed), never a silent drop.
//      Level-2 fast path: a getByRfcMessageId pre-check still short-circuits the
//      same mail redelivered under a DIFFERENT object key.
//   2. virusVerdict FAIL -> quarantined (row stored; attachments NEVER copied).
//   3. Sender blocklist -> 'blocked' (row stored dismissed).
//   4. spamVerdict FAIL/GRAY -> quarantined UNLESS tier 5/6 matches (a known
//      contact or token/references hit beats the verdict - real mail from a
//      flaky mail server must not die).
//   5. Reply token in To/Cc OR In-Reply-To/References hit -> thread there. A
//      From-address NOT on the resolved contact threads flagged
//      `email_new_address: true` and author 'unknown' (honesty rule) - the
//      address is NEVER auto-attached (Decision 4: adding is a staff action).
//   6. findByEmail(From) -> the contact's thread: existing open email thread,
//      else the primary-phone 1:1, else createOrGetByParticipantEmail. The
//      attachEmailToConversation claim arbiter's returned conversationId is
//      where the message actually lands.
//   7. Else -> unmatched store row + `unmatched_email.updated` SSE. NO
//      contact, NO conversation, NO contactCapture, NO Today input.
//
// PII (plan F18): raw MIME refs are never presigned or served; addresses,
// subjects, and bodies NEVER appear in logs - bucket/key/outcome/ids only.
//
// Concurrency note (DoS F17-4): this function is intentionally exported PLAIN;
// B4's worker dispatch wraps it in a semaphore(2) (the mmsMedia transcode-gate
// pattern) so hostile parse bursts can't pile up CPU in the worker.
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  parseInboundMime,
  sanitizeEmailHtml,
  visibleReplyText,
  extractReplyToken,
  type ParsedInboundEmail,
} from '../lib/emailMime.js';
import { normalizeEmailAddress } from '../lib/email.js';
import { toConversationUpdatedEvent, type EventBus } from '../lib/events.js';
import { EMAIL_MAX_TOTAL_BYTES, normalizeStoredMediaType } from '../lib/mediaTypes.js';
import type { MediaStore } from '../adapters/mediaStore.js';
import { contactEmails, contactPhones, type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
import type { ConversationItem, ConversationsRepo, ConversationType } from '../repos/conversationsRepo.js';
import type { MediaAttachment, MessageAuthor, MessagesRepo, NewMessage } from '../repos/messagesRepo.js';
import type { ExtractionRepo } from '../repos/extractionRepo.js';
import type { ContactCaptureService } from './contactCapture.js';

/** Raw objects over this are quarantined UNFETCHED (plan F17 DoS point 1). */
export const INBOUND_EMAIL_MAX_RAW_BYTES = 30 * 1024 * 1024;
/** Parser wall-clock bound (plan F17 DoS point 3). */
export const INBOUND_EMAIL_PARSE_TIMEOUT_MS = 30_000;
/** Parsed-attachment count cap: first N kept + truncated note (F17 point 2). */
export const INBOUND_EMAIL_MAX_ATTACHMENTS = 50;
/** In-Reply-To/References lookups are bounded (hostile 1000-ref headers). */
export const INBOUND_EMAIL_MAX_REFERENCE_LOOKUPS = 10;
/** Unmatched-row snippet bound (B3 list rendering). */
export const UNMATCHED_SNIPPET_MAX_CHARS = 180;
/**
 * DynamoDB items cap at 400 KB. Stored content is bounded by UTF-8 BYTE size,
 * never character length: a multibyte (e.g. CJK) body is ~3x its char count, so
 * a char-length cap can still overflow 400 KB and make the put THROW - the
 * fix-wave BLOCKER, where a thrown put dropped mail on redelivery. `text` is
 * truncated at a safe char boundary; an over-cap sanitized HTML is DROPPED
 * (never cut mid-markup) with a stored `html_skipped:'oversize'` note; `subject`
 * is truncated. The three caps sum to ~302 KB, leaving margin under 400 KB for
 * the row's other fields. The raw MIME ref always keeps full fidelity.
 */
export const INBOUND_EMAIL_MAX_STORED_TEXT_BYTES = 100 * 1024;
export const INBOUND_EMAIL_MAX_STORED_HTML_BYTES = 200 * 1024;
export const INBOUND_EMAIL_MAX_STORED_SUBJECT_BYTES = 2 * 1024;

/** The SQS/dev-route notification the delivery mechanisms (B4) hand us. */
export interface InboundEmailNotice {
  bucket: string;
  key: string;
  spamVerdict?: 'PASS' | 'FAIL' | 'GRAY';
  virusVerdict?: 'PASS' | 'FAIL';
}

export type InboundEmailOutcome = 'threaded' | 'unmatched' | 'quarantined' | 'duplicate' | 'blocked';

export interface IngestResult {
  outcome: InboundEmailOutcome;
  /** The conversation the message landed in (outcome 'threaded'). */
  conversationId?: string;
  tsMsgId?: string;
  /** The stored row (outcomes 'unmatched' | 'quarantined' | 'blocked'). */
  unmatchedId?: string;
}

/**
 * Minimal raw-MIME reader over the INBOUND mail bucket. Structurally satisfied
 * by the MediaStore adapter - B4 wires `createInboundMailRawStore()` (the
 * adapters/mediaStore.ts factory over config.inboundMailBucket); tests inject
 * a two-method fake.
 */
export interface InboundRawStore {
  head(key: string): Promise<{ contentType?: string; size?: number } | undefined>;
  getBytes(key: string): Promise<Buffer | undefined>;
}

/**
 * The row this service stores for every non-threaded outcome. B3's
 * unmatchedEmailRepo implements `UnmatchedEmailStore` VERBATIM: putUnmatched
 * stores under a DETERMINISTIC id derived from raw_ref (a conditional put) so a
 * redelivery of the same S3 object is idempotent, stamps read:false (+ any TTL
 * policy), and returns { unmatchedId, created }; isBlocked resolves the
 * `block#<address>` pointer rows (input is already normalized lowercase).
 */
export interface NewUnmatchedEmail {
  status: 'unmatched' | 'quarantined' | 'dismissed';
  from: { name?: string; address: string };
  subject: string;
  /** First line(s) of the visible reply text, <= 180 chars, whitespace-collapsed. */
  snippet: string;
  /** Full plain-text body (bounded by UTF-8 bytes); '' for unparseable mail. */
  text: string;
  html_sanitized?: string;
  /** Set when the sanitized HTML was over the byte cap and DROPPED (renderers
   *  fall back to `text`; the raw MIME keeps the original formatting). */
  html_skipped?: 'oversize';
  raw_ref: { bucket: string; key: string };
  /** Metadata ONLY - unmatched mail never copies bytes to the media bucket. */
  attachments_meta: { filename: string; contentType: string; size: number }[];
  spam_verdict?: 'PASS' | 'FAIL' | 'GRAY';
  virus_verdict?: 'PASS' | 'FAIL';
  received_at: string;
  /** Set when the raw mail was never parsed (oversize / parser failure). */
  parse_skipped?: 'oversize' | 'parse_failed';
}

export interface UnmatchedEmailStore {
  /**
   * Store one non-threaded row under a DETERMINISTIC id derived from raw_ref (a
   * conditional put) so a redelivery of the SAME S3 object is idempotent.
   * `created` is false when the row already existed - the caller then skips the
   * SSE and reports 'duplicate'. This is what makes a marker-less crash
   * redelivery converge instead of double-writing (or dropping) the mail.
   */
  putUnmatched(row: NewUnmatchedEmail): Promise<{ unmatchedId: string; created: boolean }>;
  isBlocked(address: string): Promise<boolean>;
}

export interface InboundEmailDeps {
  config: Pick<AppConfig, 'emailSenderDomain' | 'aiExtractionEnabled' | 'aiExtractionDebounceMs'>;
  logger?: Logger;
  rawStore: InboundRawStore;
  unmatchedStore: UnmatchedEmailStore;
  conversations: Pick<
    ConversationsRepo,
    | 'getById'
    | 'findByReplyToken'
    | 'findByParticipantEmail'
    | 'findByParticipantPhone'
    | 'attachEmailToConversation'
    | 'createOrGetByParticipantEmail'
    | 'incrementUnread'
    | 'touchLastActivity'
  >;
  messages: Pick<
    MessagesRepo,
    'append' | 'getByRfcMessageId' | 'putJobExecutionMarker' | 'getJobExecutionMarker'
  >;
  contacts: Pick<ContactsRepo, 'findByEmail' | 'getById' | 'touchEmailLastSeen'>;
  extraction: Pick<ExtractionRepo, 'scheduleExtraction'>;
  events: EventBus;
  /** The MEDIA bucket store - threaded attachments only. Absent -> attachments
   *  are skipped (marked attachments_truncated); the raw ref keeps fidelity. */
  mediaStore?: MediaStore;
  /**
   * NEVER invoked (spec Decision 4: email ingestion must not auto-capture
   * contacts). Accepted as a dep ONLY so tests can inject a spy and pin the
   * invariant against future regressions - do not wire or call it.
   */
  contactCapture?: ContactCaptureService;
  now?: () => Date;
  /** Test seam for the DoS paths; defaults to lib/emailMime.parseInboundMime. */
  parseMime?: (raw: Buffer) => Promise<ParsedInboundEmail>;
}

export interface IngestOptions {
  /**
   * B3's link/create-contact re-ingest: skip the LEVEL-1 object-key marker
   * (already claimed by the original delivery) so the stored raw mail can
   * re-enter the tiers after a human attached the address to a contact.
   * Level-2 rfc dedupe still applies, so a double-link cannot double-thread.
   */
  reingest?: boolean;
}

/** Strip RFC angle brackets: `<id@host>` -> `id@host` (pointers use BARE ids). */
function bareRfcId(id: string): string {
  const m = /^<(.*)>$/.exec(id.trim());
  return m ? m[1]! : id.trim();
}

/** S3-key-safe form of an RFC id for attachment key paths. */
function rfcIdSafe(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** UTF-8 byte length of a string. */
function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Truncate `s` to at most `maxBytes` UTF-8 bytes WITHOUT splitting a multibyte
 * code point - back up over any trailing continuation bytes (10xxxxxx) so the
 * cut lands on a whole-character boundary. Bounds every stored text field so an
 * assembled item can never overflow DynamoDB's 400 KB ceiling (the fix-wave
 * BLOCKER: a char-length cap let a CJK body exceed 400 KB and throw on put).
 */
function truncateToBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Bound a caught error for logging (plan F18 hardening): the error NAME plus a
 * 200-char message slice, never the raw third-party object - a library error
 * could echo input bytes (addresses/subject/body) into its message/fields.
 */
function errFields(err: unknown): { errName: string; errMessage: string } {
  if (err instanceof Error) return { errName: err.name, errMessage: err.message.slice(0, 200) };
  return { errName: 'NonError', errMessage: String(err).slice(0, 200) };
}

/** The author-honesty rule (mirrors the twilio inbound append + A2 partner). */
function authorForContactType(type: string | undefined): MessageAuthor {
  return type === 'tenant' || type === 'landlord' || type === 'partner' ? type : 'unknown';
}

/** Conversation typing honesty (mirrors twilio.ts conversationTypeFor). */
function conversationTypeForContact(contact: ContactItem): ConversationType {
  switch (contact.type) {
    case 'landlord':
      return 'landlord_1to1';
    case 'tenant':
      return 'tenant_1to1';
    case 'partner':
      return 'partner_1to1';
    default:
      return 'unknown_1to1';
  }
}

/** contacts.ts displayNameOf, replicated: trimmed first/last join or undefined. */
function displayNameOf(contact: ContactItem): string | undefined {
  const first = typeof contact['firstName'] === 'string' ? contact['firstName'].trim() : '';
  const last = typeof contact['lastName'] === 'string' ? contact['lastName'].trim() : '';
  const joined = [first, last].filter((p) => p.length > 0).join(' ');
  return joined.length > 0 ? joined : undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Ingest one inbound mail notice end-to-end. Terminal durable writes come FIRST
 * and are each idempotent; the object marker is claimed only AFTER (a fast-path
 * dedupe). A throw (transient S3/DynamoDB error) BEFORE the terminal write
 * propagates to SQS - redelivered, and after maxReceiveCount to the DLQ - so
 * mail is NEVER silently dropped. Hostile input (parse crash/timeout, verdicts)
 * still resolves to a quarantine row, not a retry loop.
 */
export async function ingestInboundEmail(
  notice: InboundEmailNotice,
  deps: InboundEmailDeps,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const log = deps.logger ?? defaultLogger;
  const now = deps.now ?? (() => new Date());
  const parse = deps.parseMime ?? parseInboundMime;
  const { bucket, key } = notice;
  const receivedAt = now().toISOString();
  const objMarkerId = `email#obj#${createHash('sha256').update(`${bucket}/${key}`).digest('hex')}`;

  // The object marker is a FAST-PATH dedupe, claimed ONLY after a terminal
  // durable write (terminal-write-THEN-marker). Correctness rests on the
  // durable writes' own idempotency, so a crash before this call just re-runs
  // the redelivery (which converges). Reingest deliberately re-enters the tiers
  // and never touches the marker.
  const claimObjectMarker = async (): Promise<void> => {
    if (opts.reingest) return;
    await deps.messages.putJobExecutionMarker(objMarkerId, '');
  };

  const quarantineRow = async (
    row: NewUnmatchedEmail,
    outcome: 'quarantined' | 'blocked' | 'unmatched',
  ): Promise<IngestResult> => {
    // Terminal durable write FIRST - idempotent by the deterministic id.
    const { unmatchedId, created } = await deps.unmatchedStore.putUnmatched(row);
    // SSE only on a FRESH row (created) and only for feed-visible statuses:
    // dismissed (blocked) rows never surface, and an existing row already
    // emitted on its first delivery.
    if (created && row.status !== 'dismissed') {
      deps.events.emit('unmatched_email.updated', { unmatchedId });
    }
    // THEN the fast-path marker (a crash before this simply re-runs; the
    // deterministic id makes the re-put a no-op, so no double row / SSE).
    await claimObjectMarker();
    if (!created) {
      log.info({ bucket, key, outcome }, 'inbound email row already stored - idempotent redelivery');
      return { outcome: 'duplicate', unmatchedId };
    }
    log.info({ bucket, key, outcome }, 'inbound email stored outside the timeline');
    return { outcome, unmatchedId };
  };

  const preParseRow = (parseSkipped: 'oversize' | 'parse_failed'): NewUnmatchedEmail => ({
    status: 'quarantined',
    from: { address: '' },
    subject: '',
    snippet: '',
    text: '',
    raw_ref: { bucket, key },
    attachments_meta: [],
    ...(notice.spamVerdict !== undefined && { spam_verdict: notice.spamVerdict }),
    ...(notice.virusVerdict !== undefined && { virus_verdict: notice.virusVerdict }),
    received_at: receivedAt,
    parse_skipped: parseSkipped,
  });

  // ---- Fast-path dedupe: the marker exists ONLY after a prior delivery
  // resolved to a terminal write, so skip straight to 'duplicate' (no head /
  // fetch / parse). A reingest bypasses it to re-enter the tiers deliberately.
  if (!opts.reingest && (await deps.messages.getJobExecutionMarker(objMarkerId))) {
    log.info({ bucket, key }, 'inbound email duplicate delivery suppressed (object marker fast path)');
    return { outcome: 'duplicate' };
  }

  // ---- Tier 0: HEAD size cap - the raw bytes of an oversize mail are never
  // loaded into this process (F17-1). The terminal quarantine row is idempotent
  // (deterministic id), so a redelivered oversize notice no-ops on re-put.
  const head = await deps.rawStore.head(key);
  if (head?.size !== undefined && head.size > INBOUND_EMAIL_MAX_RAW_BYTES) {
    log.warn({ bucket, key, size: head.size }, 'inbound email oversize - quarantined unfetched');
    return quarantineRow(preParseRow('oversize'), 'quarantined');
  }

  // ---- Fetch. A transient S3 failure throws here BEFORE any durable write, so
  // SQS redelivers (and eventually DLQs) - never a silent drop.
  const raw = await deps.rawStore.getBytes(key);
  if (raw === undefined) {
    // SES wrote this object; a missing read is transient/misconfig - throw so
    // SQS retries (and eventually DLQs) rather than silently dropping mail.
    throw new Error('inbound email raw object missing');
  }

  // ---- Parse, bounded (30s race + the in-parser 2MB HTML cap; F17-2/3). A
  // parser crash/timeout resolves to a quarantine row (idempotent), never a
  // retry loop.
  let parsed: ParsedInboundEmail;
  try {
    parsed = await withTimeout(parse(raw), INBOUND_EMAIL_PARSE_TIMEOUT_MS, 'inbound email parse timeout');
  } catch (err) {
    log.error({ bucket, key, ...errFields(err) }, 'inbound email parse failed - quarantined');
    return quarantineRow(preParseRow('parse_failed'), 'quarantined');
  }

  // ---- DoS-2: cap the parsed attachment list (first 50 + truncated note).
  const truncatedByCount = parsed.attachments.length > INBOUND_EMAIL_MAX_ATTACHMENTS;
  const attachments = truncatedByCount
    ? parsed.attachments.slice(0, INBOUND_EMAIL_MAX_ATTACHMENTS)
    : parsed.attachments;

  const rfcId = bareRfcId(parsed.rfcMessageId);
  const fromNorm = normalizeEmailAddress(parsed.from.address);
  // Every stored text field is bounded by UTF-8 BYTES (never char length) so an
  // assembled item can never overflow DynamoDB's 400 KB ceiling and throw.
  const bodyText = truncateToBytes(visibleReplyText(parsed.text), INBOUND_EMAIL_MAX_STORED_TEXT_BYTES);
  const subjectCapped = truncateToBytes(parsed.subject, INBOUND_EMAIL_MAX_STORED_SUBJECT_BYTES);
  const sanitizedHtmlRaw = parsed.html !== undefined ? sanitizeEmailHtml(parsed.html) : undefined;
  // Over-cap HTML is DROPPED whole (never cut mid-markup) with a stored note;
  // renderers fall back to `text` and the raw MIME keeps the original.
  const htmlOversize =
    sanitizedHtmlRaw !== undefined && byteLength(sanitizedHtmlRaw) > INBOUND_EMAIL_MAX_STORED_HTML_BYTES;
  const sanitizedHtml = sanitizedHtmlRaw !== undefined && !htmlOversize ? sanitizedHtmlRaw : undefined;

  const parsedRow = (status: NewUnmatchedEmail['status']): NewUnmatchedEmail => ({
    status,
    from: {
      address: fromNorm,
      ...(parsed.from.name !== undefined && { name: parsed.from.name }),
    },
    subject: subjectCapped,
    snippet: bodyText.replace(/\s+/g, ' ').trim().slice(0, UNMATCHED_SNIPPET_MAX_CHARS),
    text: truncateToBytes(parsed.text, INBOUND_EMAIL_MAX_STORED_TEXT_BYTES),
    ...(sanitizedHtml !== undefined && { html_sanitized: sanitizedHtml }),
    ...(htmlOversize && { html_skipped: 'oversize' as const }),
    raw_ref: { bucket, key },
    attachments_meta: attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
    })),
    ...(notice.spamVerdict !== undefined && { spam_verdict: notice.spamVerdict }),
    ...(notice.virusVerdict !== undefined && { virus_verdict: notice.virusVerdict }),
    received_at: receivedAt,
  });

  // ---- Tier 1 level 2 (fast path): the same MAIL redelivered under another
  // object key. The append()'s sid# pointer stays the authoritative arbiter
  // for concurrent races (see the threaded path below).
  const existing = await deps.messages.getByRfcMessageId(rfcId);
  if (existing) {
    // The mail is already durably threaded (a prior delivery under another
    // key) - claim THIS object's marker so its own redeliveries fast-path.
    await claimObjectMarker();
    log.info({ bucket, key }, 'inbound email duplicate rfc id suppressed (already threaded)');
    return { outcome: 'duplicate' };
  }

  // ---- Tier 2: virus verdict - quarantine, attachments never copied.
  if (notice.virusVerdict === 'FAIL') {
    return quarantineRow(parsedRow('quarantined'), 'quarantined');
  }

  // ---- Tier 3: sender blocklist (a human said never again - beats matching).
  if (fromNorm.length > 0 && (await deps.unmatchedStore.isBlocked(fromNorm))) {
    return quarantineRow(parsedRow('dismissed'), 'blocked');
  }

  // ---- Resolve tiers 5/6 candidates FIRST (tier 4 needs to know whether a
  // match beats the spam verdict).
  // Tier 5a: a reply token among the recipient addresses.
  let resolvedConversation: ConversationItem | undefined;
  const token = extractReplyToken([...parsed.to, ...parsed.cc], deps.config.emailSenderDomain ?? '');
  if (token !== undefined) {
    resolvedConversation = await deps.conversations.findByReplyToken(token);
  }
  // Tier 5b: In-Reply-To, then References NEWEST-first (the last reference is
  // the direct parent), lookups bounded against hostile mega-headers.
  if (resolvedConversation === undefined) {
    const candidates = [
      ...(parsed.inReplyTo !== undefined ? [parsed.inReplyTo] : []),
      ...[...parsed.references].reverse(),
    ]
      .map(bareRfcId)
      .filter((id) => id.length > 0)
      .slice(0, INBOUND_EMAIL_MAX_REFERENCE_LOOKUPS);
    for (const candidate of candidates) {
      const match = await deps.messages.getByRfcMessageId(candidate);
      if (match) {
        resolvedConversation = await deps.conversations.getById(match.conversationId);
        if (resolvedConversation) break;
      }
    }
  }
  // Tier 6 candidate: the sender is a known contact address.
  const contact = fromNorm.length > 0 ? await deps.contacts.findByEmail(fromNorm) : undefined;

  // ---- Tier 4: spam verdict - only unknown, unmatched senders die to it.
  const spamFlagged = notice.spamVerdict === 'FAIL' || notice.spamVerdict === 'GRAY';
  if (spamFlagged && resolvedConversation === undefined && contact === undefined) {
    return quarantineRow(parsedRow('quarantined'), 'quarantined');
  }

  // ---- Shared threaded-append pipeline (tiers 5 + 6).
  const thread = async (
    conversationId: string,
    author: MessageAuthor,
    flagNewAddress: boolean,
    threadContact: ContactItem | undefined,
  ): Promise<IngestResult> => {
    // Attachments stream to the MEDIA bucket first so the append carries the
    // durable keys in one write. Caps: 50 (above) + 25MB total per message.
    const stored: MediaAttachment[] = [];
    let truncated = truncatedByCount;
    if (attachments.length > 0) {
      if (deps.mediaStore === undefined) {
        truncated = true;
        log.warn(
          { bucket, key, conversationId, count: attachments.length },
          'inbound email attachments skipped - no media store configured',
        );
      } else {
        let totalBytes = 0;
        for (const [i, a] of attachments.entries()) {
          if (totalBytes + a.content.length > EMAIL_MAX_TOTAL_BYTES) {
            truncated = true;
            continue;
          }
          const s3Key = `media/${conversationId}/${rfcIdSafe(rfcId)}/${i}`;
          const contentType = normalizeStoredMediaType(a.contentType);
          try {
            await deps.mediaStore.put(s3Key, Readable.from(a.content), contentType);
            totalBytes += a.content.length;
            stored.push({ s3Key, contentType, filename: a.filename });
          } catch (err) {
            // Degrade per-attachment (the twilio mirror precedent): the mail
            // must still thread; the raw ref keeps fidelity.
            truncated = true;
            log.error(
              { bucket, key, conversationId, index: i, ...errFields(err) },
              'inbound email attachment store failed - skipped',
            );
          }
        }
      }
    }

    const providerTs = receivedAt; // inbound receipt time (twilio precedent)
    const message: NewMessage = {
      conversationId,
      providerSid: rfcId, // INBOUND convention: the sid# pointer IS the threading lookup
      providerTs,
      type: 'email',
      direction: 'inbound',
      author,
      deliveryStatus: 'delivered',
      ...(bodyText.length > 0 && { body: bodyText }),
      subject: subjectCapped,
      email_from: fromNorm,
      email_to: parsed.to.map(normalizeEmailAddress),
      email_cc: parsed.cc.map(normalizeEmailAddress),
      email_message_id: parsed.rfcMessageId, // bracketed RFC fidelity
      ...(sanitizedHtml !== undefined && { email_html_sanitized: sanitizedHtml }),
      email_raw_ref: { bucket, key },
      ...(flagNewAddress && { email_new_address: true }),
      ...(stored.length > 0 && { mediaAttachments: stored }),
      ...(truncated && { attachments_truncated: true }),
    };
    const appended = await deps.messages.append(message);
    if (appended.deduped) {
      // A concurrent delivery of the same rfc id won the sid#-pointer race -
      // the winner runs the side effects; this delivery is a duplicate. The
      // mail is durably threaded, so claim this object's fast-path marker.
      await claimObjectMarker();
      log.info({ bucket, key, conversationId }, 'inbound email append deduped (concurrent delivery)');
      return { outcome: 'duplicate' };
    }

    // Mirror the twilio inbound block: unread increment BEFORE the touch so
    // the ALL_NEW snapshot carries the fresh count into conversation.updated;
    // side-effect failures never fail the ingest (the message is persisted).
    let touched: ConversationItem | undefined;
    try {
      await deps.conversations.incrementUnread(conversationId);
      touched = await deps.conversations.touchLastActivity(
        conversationId,
        bodyText.length > 0 ? bodyText : undefined,
        providerTs,
      );
    } catch (err) {
      log.error(
        { bucket, key, conversationId, ...errFields(err) },
        'inbound email unread/touch failed - message persisted, inbox stale',
      );
    }
    deps.events.emit('message.persisted', {
      conversationId,
      tsMsgId: appended.tsMsgId,
      direction: 'inbound',
      deliveryStatus: 'delivered',
    });
    if (touched) {
      deps.events.emit('conversation.updated', toConversationUpdatedEvent(touched));
    }

    // Address freshness - only for a VERIFIED sender address (on the contact).
    if (threadContact !== undefined) {
      try {
        await deps.contacts.touchEmailLastSeen(threadContact.contactId, fromNorm, providerTs);
      } catch (err) {
        log.error(
          { bucket, key, conversationId, ...errFields(err) },
          'inbound email lastSeen touch failed - stale',
        );
      }
    }

    // Conversation fact extraction: the EXACT twilio predicate - tenant/unknown
    // 1:1 only, kill-switch gated, sliding debounce, best-effort.
    if (
      deps.config.aiExtractionEnabled &&
      (touched?.type === 'tenant_1to1' || touched?.type === 'unknown_1to1')
    ) {
      try {
        await deps.extraction.scheduleExtraction(
          conversationId,
          'email',
          new Date(now().getTime() + deps.config.aiExtractionDebounceMs).toISOString(),
        );
      } catch (err) {
        log.warn(
          { bucket, key, conversationId, ...errFields(err) },
          'inbound email extraction schedule failed',
        );
      }
    }

    // Terminal-write-THEN-marker: all durable writes + side effects are done,
    // so claim the object marker to fast-path this object's future redeliveries.
    await claimObjectMarker();
    log.info({ bucket, key, conversationId, outcome: 'threaded' }, 'inbound email threaded');
    return { outcome: 'threaded', conversationId, tsMsgId: appended.tsMsgId };
  };

  // ---- Tier 5: token/references threading.
  if (resolvedConversation !== undefined) {
    // Is the From-address on the resolved conversation's known set? (its
    // participant_email, or any address of its roster contact, or the tier-6
    // contact when it IS the roster contact.)
    const rosterContactId = resolvedConversation.participants?.[0]?.contactId;
    const rosterContact =
      rosterContactId !== undefined && rosterContactId.length > 0
        ? await deps.contacts.getById(rosterContactId)
        : undefined;
    let known =
      resolvedConversation.participant_email !== undefined &&
      normalizeEmailAddress(resolvedConversation.participant_email) === fromNorm;
    if (!known && rosterContact !== undefined) {
      known = contactEmails(rosterContact).some((e) => normalizeEmailAddress(e.email) === fromNorm);
    }
    if (!known && contact !== undefined && rosterContactId !== undefined) {
      known = contact.contactId === rosterContactId;
    }
    // Honesty rule: an unverified address never claims contact authorship. The
    // address is flagged, NEVER auto-attached (staff add it via the UI chip).
    const author = known ? authorForContactType((rosterContact ?? contact)?.type) : 'unknown';
    return thread(
      resolvedConversation.conversationId,
      author,
      !known,
      known ? (rosterContact ?? contact) : undefined,
    );
  }

  // ---- Tier 6: known contact.
  if (contact !== undefined) {
    // Resolve the target thread: existing open email thread for this address,
    // else the contact's primary-phone open 1:1 (plan: "resolve via contact
    // primary phone thread"), else create the email-keyed 1:1 (ADJ-9 opts).
    const not1to1 = (c: ConversationItem) => c.type === 'relay_group' || c.status !== 'open';
    let target: ConversationItem | undefined = (
      await deps.conversations.findByParticipantEmail(fromNorm)
    ).find((c) => !not1to1(c));
    if (target === undefined) {
      const phones = contactPhones(contact);
      const primaryPhone = phones.find((p) => p.primary) ?? phones[0];
      if (primaryPhone !== undefined) {
        target = (await deps.conversations.findByParticipantPhone(primaryPhone.phone)).find(
          (c) => !not1to1(c),
        );
      }
    }
    let conversationId: string;
    if (target !== undefined) {
      // THE claim arbiter: append into ITS answer (the claim may live elsewhere).
      const attached = await deps.conversations.attachEmailToConversation(
        target.conversationId,
        fromNorm,
      );
      conversationId = attached.conversationId;
    } else {
      const displayName = displayNameOf(contact);
      const created = await deps.conversations.createOrGetByParticipantEmail(
        fromNorm,
        conversationTypeForContact(contact),
        {
          contactId: contact.contactId,
          ...(displayName !== undefined && { displayName }),
        },
      );
      conversationId = created.conversationId;
    }
    return thread(conversationId, authorForContactType(contact.type), false, contact);
  }

  // ---- Tier 7: unmatched side-door. NO contact, NO conversation, NO capture
  // (Decision 4) - the row + SSE is the whole write set.
  return quarantineRow(parsedRow('unmatched'), 'unmatched');
}
