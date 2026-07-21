// Inbound-email ingestion (email-channel B2) - ONE channel-agnostic service
// consumed by both delivery mechanisms (prod: SES -> S3 -> SNS -> SQS worker
// consumer; local/e2e: fake-SES POST to the dev-gated webhook - both B4).
//
// Routing tiers, IN ORDER (plan Task B2; each pinned by a test):
//   0. HEAD the S3 object: > 30 MB -> quarantine row `parse_skipped:'oversize'`
//      - the raw bytes are NEVER loaded (DoS F17-1).
//   1. Idempotency, TWO LEVELS:
//      - Level 1 (delivery): an execution marker on the S3 OBJECT KEY
//        (`job#email#obj#<sha256(bucket/key)>`), claimed AFTER the fetch but
//        BEFORE parse - so a hostile mail that crashes the parser can never
//        drive an SQS redelivery loop (F17-3), while a TRANSIENT S3 failure
//        (head/fetch throw) stays retryable because nothing was claimed yet.
//      - Level 2 (mail identity): the RFC Message-ID. A fast-path
//        getByRfcMessageId pre-check catches the same mail redelivered under a
//        DIFFERENT object key; the append()'s transactional sid# pointer is
//        the authoritative arbiter for two CONCURRENT deliveries (the loser's
//        append dedupes and this returns 'duplicate').
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
 * DynamoDB items cap at 400 KB, so stored TEXT bodies are bounded (the raw
 * MIME ref keeps full fidelity) and an over-limit sanitized HTML is DROPPED
 * rather than truncated mid-markup (renderers fall back to the text body).
 */
export const INBOUND_EMAIL_MAX_STORED_TEXT_CHARS = 100_000;
export const INBOUND_EMAIL_MAX_STORED_HTML_CHARS = 200_000;

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
 * stamps unmatchedId/read:false (+ any TTL policy) and returns the id;
 * isBlocked resolves the `block#<address>` pointer rows (input is already
 * normalized lowercase).
 */
export interface NewUnmatchedEmail {
  status: 'unmatched' | 'quarantined' | 'dismissed';
  from: { name?: string; address: string };
  subject: string;
  /** First line(s) of the visible reply text, <= 180 chars, whitespace-collapsed. */
  snippet: string;
  /** Full plain-text body (bounded); '' for unparseable mail. */
  text: string;
  html_sanitized?: string;
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
  putUnmatched(row: NewUnmatchedEmail): Promise<{ unmatchedId: string }>;
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
  messages: Pick<MessagesRepo, 'append' | 'getByRfcMessageId' | 'putJobExecutionMarker'>;
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
 * Ingest one inbound mail notice end-to-end. Throws ONLY on transient
 * infrastructure failures BEFORE the idempotency claim (S3 head/fetch, marker
 * write) - those are safe for SQS to redeliver. Everything after the claim
 * resolves to an outcome (quarantine rows for hostile input), never a retry
 * loop.
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

  const quarantineRow = async (
    row: NewUnmatchedEmail,
    outcome: 'quarantined' | 'blocked' | 'unmatched',
  ): Promise<IngestResult> => {
    const { unmatchedId } = await deps.unmatchedStore.putUnmatched(row);
    // Dismissed (blocked) rows are invisible to the B6 feeds - no refetch hint.
    if (row.status !== 'dismissed') {
      deps.events.emit('unmatched_email.updated', { unmatchedId });
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

  // ---- Tier 0: HEAD size cap - the raw bytes of an oversize mail are never
  // loaded into this process (F17-1). Claim the object marker BEFORE the row
  // write so a redelivered oversize notice no-ops instead of double-rowing.
  const head = await deps.rawStore.head(key);
  if (head?.size !== undefined && head.size > INBOUND_EMAIL_MAX_RAW_BYTES) {
    if (!opts.reingest) {
      const first = await deps.messages.putJobExecutionMarker(objMarkerId, '');
      if (!first) {
        log.info({ bucket, key }, 'inbound email duplicate delivery suppressed (object marker)');
        return { outcome: 'duplicate' };
      }
    }
    log.warn({ bucket, key, size: head.size }, 'inbound email oversize - quarantined unfetched');
    return quarantineRow(preParseRow('oversize'), 'quarantined');
  }

  // ---- Fetch (still BEFORE the marker: a transient S3 failure must stay
  // retryable; nothing has been claimed yet).
  const raw = await deps.rawStore.getBytes(key);
  if (raw === undefined) {
    // SES wrote this object; a missing read is transient/misconfig - throw so
    // SQS retries (and eventually DLQs) rather than silently dropping mail.
    throw new Error('inbound email raw object missing');
  }

  // ---- Tier 1 level 1: claim the delivery (object key) marker BEFORE parse.
  // From here on, hostile input resolves to an outcome - never an SQS retry.
  if (!opts.reingest) {
    const first = await deps.messages.putJobExecutionMarker(objMarkerId, '');
    if (!first) {
      log.info({ bucket, key }, 'inbound email duplicate delivery suppressed (object marker)');
      return { outcome: 'duplicate' };
    }
  }

  // ---- Parse, bounded (30s race + the in-parser 2MB HTML cap; F17-2/3).
  let parsed: ParsedInboundEmail;
  try {
    parsed = await withTimeout(parse(raw), INBOUND_EMAIL_PARSE_TIMEOUT_MS, 'inbound email parse timeout');
  } catch (err) {
    log.error({ bucket, key, err }, 'inbound email parse failed - quarantined');
    return quarantineRow(preParseRow('parse_failed'), 'quarantined');
  }

  // ---- DoS-2: cap the parsed attachment list (first 50 + truncated note).
  const truncatedByCount = parsed.attachments.length > INBOUND_EMAIL_MAX_ATTACHMENTS;
  const attachments = truncatedByCount
    ? parsed.attachments.slice(0, INBOUND_EMAIL_MAX_ATTACHMENTS)
    : parsed.attachments;

  const rfcId = bareRfcId(parsed.rfcMessageId);
  const fromNorm = normalizeEmailAddress(parsed.from.address);
  const bodyText = visibleReplyText(parsed.text).slice(0, INBOUND_EMAIL_MAX_STORED_TEXT_CHARS);
  const sanitizedHtmlRaw = parsed.html !== undefined ? sanitizeEmailHtml(parsed.html) : undefined;
  const sanitizedHtml =
    sanitizedHtmlRaw !== undefined && sanitizedHtmlRaw.length <= INBOUND_EMAIL_MAX_STORED_HTML_CHARS
      ? sanitizedHtmlRaw
      : undefined;

  const parsedRow = (status: NewUnmatchedEmail['status']): NewUnmatchedEmail => ({
    status,
    from: {
      address: fromNorm,
      ...(parsed.from.name !== undefined && { name: parsed.from.name }),
    },
    subject: parsed.subject,
    snippet: bodyText.replace(/\s+/g, ' ').trim().slice(0, UNMATCHED_SNIPPET_MAX_CHARS),
    text: parsed.text.slice(0, INBOUND_EMAIL_MAX_STORED_TEXT_CHARS),
    ...(sanitizedHtml !== undefined && { html_sanitized: sanitizedHtml }),
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
            log.error({ bucket, key, conversationId, index: i, err }, 'inbound email attachment store failed - skipped');
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
      subject: parsed.subject,
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
      // the winner runs the side effects; this delivery is a duplicate.
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
      log.error({ bucket, key, conversationId, err }, 'inbound email unread/touch failed - message persisted, inbox stale');
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
        log.error({ bucket, key, conversationId, err }, 'inbound email lastSeen touch failed - stale');
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
        log.warn({ bucket, key, conversationId, err }, 'inbound email extraction schedule failed');
      }
    }

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
