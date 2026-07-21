// B2 unit tests: the inbound-email ingestion service - EVERY routing tier
// (oversize head-skip, two-level idempotency, virus, blocklist, spam-unless-
// matched, token/references threading + new-address flag, known-contact
// threading + author honesty + SSE/extraction, unmatched side-door), the F17
// DoS list (30MB head cap, 30s parse race, 50-attachment cap, 25MB total
// attachment cap), and the Decision-4 pins (contactCapture NEVER called, no
// conversation/contact writes on the unmatched path). All deps are in-memory
// fakes/spies - no DynamoDB, no S3, no network.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import type { MediaStore } from '../src/adapters/mediaStore.js';
import type { EventBus } from '../src/lib/events.js';
import type { ParsedInboundEmail } from '../src/lib/emailMime.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { MessageItem, NewMessage } from '../src/repos/messagesRepo.js';
import {
  ingestInboundEmail,
  type InboundEmailDeps,
  type InboundEmailNotice,
  type NewUnmatchedEmail,
} from '../src/services/inboundEmail.js';
import { createLogCapture } from './helpers/logCapture.js';

const NOW = '2026-07-21T12:00:00.000Z';
const CRLF = '\r\n';

// ---------------------------------------------------------------------------
// Raw-MIME builder (hand-rolled - no new deps; mailparser round-trips it)
// ---------------------------------------------------------------------------

interface MimeOpts {
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  body?: string;
  html?: string;
  attachments?: { filename: string; contentType: string; base64: string }[];
}

function mime(opts: MimeOpts = {}): Buffer {
  const headers = [
    `From: ${opts.from ?? 'Alice Sender <alice@example.com>'}`,
    `To: ${opts.to ?? 'team@mail.test'}`,
    ...(opts.cc !== undefined ? [`Cc: ${opts.cc}`] : []),
    ...(opts.subject !== undefined ? [`Subject: ${opts.subject}`] : ['Subject: Hello there']),
    ...(opts.messageId !== undefined ? [`Message-ID: ${opts.messageId}`] : ['Message-ID: <in-1@example.com>']),
    ...(opts.inReplyTo !== undefined ? [`In-Reply-To: ${opts.inReplyTo}`] : []),
    ...(opts.references !== undefined ? [`References: ${opts.references}`] : []),
    'MIME-Version: 1.0',
  ];
  const body = opts.body ?? 'A plain text body';
  if (opts.attachments === undefined && opts.html === undefined) {
    return Buffer.from(
      [...headers, 'Content-Type: text/plain; charset=utf-8', '', body, ''].join(CRLF),
      'utf8',
    );
  }
  // Body section: text alone, or a multipart/alternative of text + html (so
  // mailparser treats the html as the ALTERNATIVE, not a second text part).
  const bodySection: string[] =
    opts.html === undefined
      ? ['Content-Type: text/plain; charset=utf-8', '', body]
      : [
          'Content-Type: multipart/alternative; boundary=AA',
          '',
          '--AA',
          'Content-Type: text/plain; charset=utf-8',
          '',
          body,
          '--AA',
          'Content-Type: text/html; charset=utf-8',
          '',
          opts.html,
          '--AA--',
        ];
  if (opts.attachments === undefined) {
    return Buffer.from([...headers, ...bodySection, ''].join(CRLF), 'utf8');
  }
  const parts: string[] = ['--BB', ...bodySection];
  for (const a of opts.attachments) {
    parts.push(
      '--BB',
      `Content-Type: ${a.contentType}`,
      `Content-Disposition: attachment; filename="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      a.base64,
    );
  }
  parts.push('--BB--', '');
  return Buffer.from(
    [...headers, 'Content-Type: multipart/mixed; boundary=BB', '', ...parts].join(CRLF),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// World harness
// ---------------------------------------------------------------------------

interface WorldOver {
  env?: Record<string, string>;
  raw?: Buffer;
  /** head()-reported size; defaults to raw.length. */
  rawSize?: number;
  /** The findByEmail-resolvable contact (matched on its email/emails). */
  contact?: Partial<ContactItem> | null;
  /** Seeded conversations (token/email/phone finders resolve from these). */
  conversations?: Partial<ConversationItem>[];
  isBlocked?: boolean;
  attachReturns?: string;
  appendDeduped?: boolean;
  /** Extra rfcId -> message index entries for getByRfcMessageId. */
  rfcIndex?: Record<string, Pick<MessageItem, 'conversationId' | 'tsMsgId'>>;
  /** Injected parse (DoS tests); default uses the real parseInboundMime. */
  parseMime?: (rawMime: Buffer) => Promise<ParsedInboundEmail>;
  /** null -> no media store configured. */
  mediaStore?: null;
  putThrowsOnFirst?: boolean;
  touchEmailThrows?: boolean;
}

function makeWorld(over: WorldOver = {}) {
  const capture = createLogCapture();
  const logger = createLogger({ destination: capture.stream });
  const config = loadConfig({
    NODE_ENV: 'test',
    CF_ORIGIN_SECRET: 's',
    EMAIL_SENDER_DOMAIN: 'mail.test',
    ...over.env,
  });

  const raw = over.raw ?? mime();

  // `contact: null` -> the sender is UNKNOWN; absent -> the default tenant.
  // Held in a mutable ref so the B3 link scenario (unknown -> linked ->
  // reingest) can flip it mid-test via setContact.
  const contactRef: { current: ContactItem | undefined } = {
    current:
      over.contact === null
        ? undefined
        : ({
            contactId: 'c1',
            type: 'tenant',
            email: 'alice@example.com',
            emails: [{ email: 'alice@example.com', primary: true }],
            firstName: 'Alice',
            lastName: 'Sender',
            ...over.contact,
          } as ContactItem),
  };

  const conversations: ConversationItem[] = (over.conversations ?? []).map(
    (c, i) =>
      ({
        conversationId: `conv-${i}`,
        status: 'open',
        last_activity_at: NOW,
        type: 'tenant_1to1',
        ai_mode: 'auto',
        created_at: NOW,
        ...c,
      }) as ConversationItem,
  );

  const markers = new Set<string>();
  const markerCalls: string[] = [];
  const appended: NewMessage[] = [];

  // Idempotent by raw_ref, modelling the real repo's deterministic-id
  // conditional put: same object -> same id + created:false; a NEW object ->
  // created:true (the first distinct object is 'um-1', preserving prior asserts).
  const unmatchedByRef = new Map<string, string>();
  const putUnmatched = vi.fn(async (row: NewUnmatchedEmail) => {
    const ref = `${row.raw_ref.bucket}/${row.raw_ref.key}`;
    const existing = unmatchedByRef.get(ref);
    if (existing !== undefined) return { unmatchedId: existing, created: false };
    const unmatchedId = `um-${unmatchedByRef.size + 1}`;
    unmatchedByRef.set(ref, unmatchedId);
    return { unmatchedId, created: true };
  });
  const isBlocked = vi.fn(async (_a: string) => over.isBlocked ?? false);

  const head = vi.fn(async (_key: string) => ({ size: over.rawSize ?? raw.length }));
  const getBytes = vi.fn(async (_key: string) => raw);

  const attachEmailToConversation = vi.fn(async (id: string, _email: string) => ({
    conversationId: over.attachReturns ?? id,
  }));
  const created: ConversationItem[] = [];
  const createOrGetByParticipantEmail = vi.fn(
    async (email: string, type: ConversationItem['type'], opts?: { contactId?: string; displayName?: string }) => {
      const item = {
        conversationId: 'conv-new',
        participant_email: email,
        status: 'open',
        last_activity_at: NOW,
        type,
        ai_mode: 'auto',
        created_at: NOW,
        ...(opts?.contactId !== undefined && {
          participants: [{ contactId: opts.contactId, phone: '' }],
        }),
      } as ConversationItem;
      created.push(item);
      return item;
    },
  );
  const incrementUnread = vi.fn(async (_id: string) => 1);
  const touchLastActivity = vi.fn(async (id: string, _preview: string | undefined, _ts: string) => {
    const found = conversations.find((c) => c.conversationId === id) ?? created[0];
    return { ...(found ?? { conversationId: id, type: 'tenant_1to1' }), conversationId: id, unread_count: 1 } as ConversationItem;
  });

  const putJobExecutionMarker = vi.fn(async (jobId: string, _conversationId: string) => {
    markerCalls.push(jobId);
    if (markers.has(jobId)) return false;
    markers.add(jobId);
    return true;
  });
  // The fix-wave fast-path READ (claimed only AFTER a terminal write).
  const getJobExecutionMarker = vi.fn(async (jobId: string) => markers.has(jobId));
  const append = vi.fn(async (m: NewMessage) => {
    if (over.appendDeduped) return { deduped: true, tsMsgId: 'dup#ts' };
    appended.push(m);
    return { deduped: false, tsMsgId: `${m.providerTs}#${m.providerSid}` };
  });
  const getByRfcMessageId = vi.fn(async (id: string) => {
    const hit = over.rfcIndex?.[id];
    if (hit) return hit as MessageItem;
    const prior = appended.find((m) => m.providerSid === id);
    if (prior) {
      return { conversationId: prior.conversationId, tsMsgId: `${prior.providerTs}#${prior.providerSid}` } as MessageItem;
    }
    return undefined;
  });

  const findByEmail = vi.fn(async (email: string) => {
    const contact = contactRef.current;
    if (!contact) return undefined;
    const addrs = [
      ...(typeof contact.email === 'string' ? [contact.email] : []),
      ...(Array.isArray(contact.emails) ? contact.emails.map((e) => e.email) : []),
    ].map((a) => a.toLowerCase());
    return addrs.includes(email.toLowerCase()) ? contact : undefined;
  });
  const getById = vi.fn(async (id: string) =>
    contactRef.current?.contactId === id ? contactRef.current : undefined,
  );
  const touchEmailLastSeen = vi.fn(async () => {
    if (over.touchEmailThrows) throw new Error('touch boom');
  });

  const scheduleExtraction = vi.fn(async () => {});
  const emit = vi.fn();
  const contactCapture = vi.fn(async () => undefined);

  const put = vi.fn(async (_key: string, _body: unknown, _ct?: string) => {
    if (over.putThrowsOnFirst && put.mock.calls.length === 1) throw new Error('put boom');
  });
  const mediaStore =
    over.mediaStore === null ? undefined : ({ put } as unknown as MediaStore);

  const deps = {
    config,
    logger,
    rawStore: { head, getBytes },
    unmatchedStore: { putUnmatched, isBlocked },
    conversations: {
      getById: async (id: string) =>
        conversations.find((c) => c.conversationId === id) ?? created.find((c) => c.conversationId === id),
      findByReplyToken: async (token: string) =>
        conversations.find((c) => (c as { email_reply_token?: string }).email_reply_token === token),
      findByParticipantEmail: async (email: string) =>
        conversations.filter((c) => c.participant_email?.toLowerCase() === email.toLowerCase()),
      findByParticipantPhone: async (phone: string) =>
        conversations.filter((c) => c.participant_phone === phone),
      attachEmailToConversation,
      createOrGetByParticipantEmail,
      incrementUnread,
      touchLastActivity,
    },
    messages: { append, getByRfcMessageId, putJobExecutionMarker, getJobExecutionMarker },
    contacts: { findByEmail, getById, touchEmailLastSeen },
    extraction: { scheduleExtraction },
    events: { emit } as unknown as EventBus,
    ...(mediaStore !== undefined ? { mediaStore } : {}),
    contactCapture,
    now: () => new Date(NOW),
    ...(over.parseMime !== undefined ? { parseMime: over.parseMime } : {}),
  } as unknown as InboundEmailDeps;

  return {
    deps,
    capture,
    raw,
    appended,
    markerCalls,
    putUnmatched,
    isBlocked,
    head,
    getBytes,
    attachEmailToConversation,
    createOrGetByParticipantEmail,
    incrementUnread,
    touchLastActivity,
    putJobExecutionMarker,
    getJobExecutionMarker,
    append,
    getByRfcMessageId,
    findByEmail,
    touchEmailLastSeen,
    scheduleExtraction,
    emit,
    contactCapture,
    put,
    setContact: (c: Partial<ContactItem> | undefined) => {
      contactRef.current = c === undefined ? undefined : ({ contactId: 'c1', type: 'tenant', ...c } as ContactItem);
    },
    /** Model a crash-before-marker window: wipe the object marker while the
     *  durable writes (sid# pointer / unmatched row) survive. */
    clearMarkers: () => markers.clear(),
  };
}

function notice(over: Partial<InboundEmailNotice> = {}): InboundEmailNotice {
  return {
    bucket: 'inbound-bucket',
    key: 'obj/key-1',
    spamVerdict: 'PASS',
    virusVerdict: 'PASS',
    ...over,
  };
}

function objMarkerId(bucket: string, key: string): string {
  return `email#obj#${createHash('sha256').update(`${bucket}/${key}`).digest('hex')}`;
}

function unmatchedRows(w: ReturnType<typeof makeWorld>): NewUnmatchedEmail[] {
  return w.putUnmatched.mock.calls.map((c) => c[0] as NewUnmatchedEmail);
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tier 0 - oversize head-skip (DoS 1)
// ---------------------------------------------------------------------------

describe('tier 0: oversize head-skip', () => {
  it('quarantines an object over 30MB WITHOUT ever fetching the raw bytes', async () => {
    const w = makeWorld({ rawSize: 30 * 1024 * 1024 + 1 });
    const out = await ingestInboundEmail(notice(), w.deps);
    expect(out.outcome).toBe('quarantined');
    expect(w.getBytes).not.toHaveBeenCalled();
    const row = unmatchedRows(w)[0]!;
    expect(row.status).toBe('quarantined');
    expect(row.parse_skipped).toBe('oversize');
    expect(row.raw_ref).toEqual({ bucket: 'inbound-bucket', key: 'obj/key-1' });
    expect(w.emit).toHaveBeenCalledWith('unmatched_email.updated', { unmatchedId: 'um-1' });
  });

  it('a redelivered oversize notice no-ops via the object-key marker (no second row)', async () => {
    const w = makeWorld({ rawSize: 31 * 1024 * 1024 });
    await ingestInboundEmail(notice(), w.deps);
    const again = await ingestInboundEmail(notice(), w.deps);
    expect(again.outcome).toBe('duplicate');
    expect(w.putUnmatched).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tier 1 - two-level idempotency
// ---------------------------------------------------------------------------

describe('tier 1: two-level idempotency', () => {
  it('claims the object-key marker (job email#obj#sha256(bucket/key)) AFTER the durable write; a same-key redelivery duplicates via the fast path with no second append', async () => {
    const w = makeWorld({});
    const first = await ingestInboundEmail(notice(), w.deps);
    expect(first.outcome).toBe('threaded');
    expect(w.markerCalls).toContain(objMarkerId('inbound-bucket', 'obj/key-1'));
    const second = await ingestInboundEmail(notice(), w.deps);
    expect(second.outcome).toBe('duplicate');
    expect(w.append).toHaveBeenCalledTimes(1);
    expect(w.putUnmatched).not.toHaveBeenCalled();
  });

  it('the same rfc Message-ID delivered under a DIFFERENT key -> duplicate (level 2, cross-delivery)', async () => {
    const w = makeWorld({});
    const first = await ingestInboundEmail(notice({ key: 'obj/key-1' }), w.deps);
    expect(first.outcome).toBe('threaded');
    const second = await ingestInboundEmail(notice({ key: 'obj/key-2' }), w.deps);
    expect(second.outcome).toBe('duplicate');
    expect(w.append).toHaveBeenCalledTimes(1);
  });

  it('a concurrent append that dedupes on the sid pointer resolves to duplicate with NO side effects', async () => {
    const w = makeWorld({ appendDeduped: true });
    const out = await ingestInboundEmail(notice(), w.deps);
    expect(out.outcome).toBe('duplicate');
    expect(w.incrementUnread).not.toHaveBeenCalled();
    expect(w.emit).not.toHaveBeenCalledWith('message.persisted', expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Fix-wave B - durable-write-first idempotency (the BLOCKER rework): the object
// marker is claimed AFTER a terminal durable write, so a store failure (or a
// process kill) can never convert a safe SQS redelivery into silent mail loss.
// ---------------------------------------------------------------------------

describe('fix-wave B: durable-write-first idempotency', () => {
  it('putUnmatched throwing once does NOT lose the mail - the redelivery stores it (no pre-write marker)', async () => {
    const w = makeWorld({ contact: null });
    w.putUnmatched.mockRejectedValueOnce(new Error('throttled'));
    // The throw propagates (transient DynamoDB error) - SQS keeps the message.
    await expect(ingestInboundEmail(notice(), w.deps)).rejects.toThrow('throttled');
    // No marker was claimed (the throw beat the marker), so the redelivery re-runs.
    const again = await ingestInboundEmail(notice(), w.deps);
    expect(again.outcome).toBe('unmatched');
    expect(w.putUnmatched).toHaveBeenCalledTimes(2); // retried, NOT suppressed as duplicate
  });

  it('append throwing once does NOT lose the mail - the redelivery threads it', async () => {
    const w = makeWorld({});
    w.append.mockRejectedValueOnce(new Error('throttled'));
    await expect(ingestInboundEmail(notice(), w.deps)).rejects.toThrow('throttled');
    const again = await ingestInboundEmail(notice(), w.deps);
    expect(again.outcome).toBe('threaded');
    expect(w.append).toHaveBeenCalledTimes(2);
  });

  it('a marker-less redelivery (crash after the durable write) converges via level-2 rfc dedupe - no doubled side effects, no loss', async () => {
    const w = makeWorld({});
    const first = await ingestInboundEmail(notice(), w.deps);
    expect(first.outcome).toBe('threaded');
    // Model the crash window: the sid# pointer (append) survived, the marker did not.
    w.clearMarkers();
    const again = await ingestInboundEmail(notice(), w.deps);
    expect(again.outcome).toBe('duplicate'); // getByRfcMessageId catches it
    expect(w.append).toHaveBeenCalledTimes(1); // no second append
    expect(w.incrementUnread).toHaveBeenCalledTimes(1); // side effects NOT doubled
  });

  it('a same-key redelivery does NOT double side effects (marker fast path short-circuits)', async () => {
    const w = makeWorld({});
    await ingestInboundEmail(notice(), w.deps);
    await ingestInboundEmail(notice(), w.deps);
    expect(w.append).toHaveBeenCalledTimes(1);
    expect(w.incrementUnread).toHaveBeenCalledTimes(1);
    expect(w.emit.mock.calls.filter((c) => c[0] === 'message.persisted')).toHaveLength(1);
  });

  it('claims the object marker only AFTER the durable append (terminal-write-then-marker)', async () => {
    const w = makeWorld({});
    await ingestInboundEmail(notice(), w.deps);
    const appendOrder = w.append.mock.invocationCallOrder[0]!;
    const markerOrder = w.putJobExecutionMarker.mock.invocationCallOrder[0]!;
    expect(markerOrder).toBeGreaterThan(appendOrder);
  });

  it('claims the object marker only AFTER the durable putUnmatched (quarantine terminal write)', async () => {
    const w = makeWorld({ contact: null });
    await ingestInboundEmail(notice(), w.deps);
    const putOrder = w.putUnmatched.mock.invocationCallOrder[0]!;
    const markerOrder = w.putJobExecutionMarker.mock.invocationCallOrder[0]!;
    expect(markerOrder).toBeGreaterThan(putOrder);
  });

  it('a multibyte HTML body over the byte cap degrades to absent (html_skipped) without throwing', async () => {
    // 200k CJK chars ~ 600 KB UTF-8: under a 200k CHAR cap, over the 200 KB BYTE
    // cap AND the DynamoDB 400 KB item ceiling - the exact BLOCKER trigger.
    // (U+4E2D built via String.fromCodePoint so the added source line is ASCII.)
    const cjk = String.fromCodePoint(0x4e2d); // one CJK char, 3 UTF-8 bytes
    const bigHtml = '<p>' + cjk.repeat(200_000) + '</p>';
    const w = makeWorld({
      contact: null,
      parseMime: async () => fakeParsed({ html: bigHtml, text: 'short body' }),
    });
    const out = await ingestInboundEmail(notice(), w.deps);
    expect(out.outcome).toBe('unmatched');
    const row = unmatchedRows(w)[0]!;
    expect(row.html_sanitized).toBeUndefined(); // dropped, not stored oversize
    expect(row.html_skipped).toBe('oversize'); // with the honest note
    // The assembled row stays well under the DynamoDB 400 KB item ceiling.
    expect(Buffer.byteLength(JSON.stringify(row), 'utf8')).toBeLessThan(400 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Tier 2 - virus verdict
// ---------------------------------------------------------------------------

describe('tier 2: virus verdict', () => {
  it('virusVerdict FAIL -> quarantined; attachments are NEVER copied to the media bucket (even for a known contact)', async () => {
    const w = makeWorld({
      raw: mime({ attachments: [{ filename: 'x.pdf', contentType: 'application/pdf', base64: 'JVBERg==' }] }),
    });
    const out = await ingestInboundEmail(notice({ virusVerdict: 'FAIL' }), w.deps);
    expect(out.outcome).toBe('quarantined');
    expect(w.put).not.toHaveBeenCalled();
    expect(w.append).not.toHaveBeenCalled();
    const row = unmatchedRows(w)[0]!;
    expect(row.status).toBe('quarantined');
    expect(row.virus_verdict).toBe('FAIL');
    expect(row.attachments_meta).toEqual([
      { filename: 'x.pdf', contentType: 'application/pdf', size: 4 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tier 3 - sender blocklist
// ---------------------------------------------------------------------------

describe('tier 3: sender blocklist', () => {
  it('a blocked sender -> blocked; the row is stored dismissed; nothing threads', async () => {
    const w = makeWorld({
      raw: mime({ from: 'Spammy <SPAM@Evil.Test>' }),
      isBlocked: true,
    });
    const out = await ingestInboundEmail(notice(), w.deps);
    expect(out.outcome).toBe('blocked');
    expect(w.isBlocked).toHaveBeenCalledWith('spam@evil.test'); // normalized
    const row = unmatchedRows(w)[0]!;
    expect(row.status).toBe('dismissed');
    expect(w.append).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tier 4 - spam verdict, beaten by a match
// ---------------------------------------------------------------------------

describe('tier 4: spam verdict', () => {
  it('spam FAIL from an unknown sender -> quarantined with the verdict recorded', async () => {
    const w = makeWorld({ contact: null });
    const out = await ingestInboundEmail(notice({ spamVerdict: 'FAIL' }), w.deps);
    expect(out.outcome).toBe('quarantined');
    const row = unmatchedRows(w)[0]!;
    expect(row.status).toBe('quarantined');
    expect(row.spam_verdict).toBe('FAIL');
  });

  it('spam GRAY from a KNOWN contact still threads (the tier-6 match beats the verdict)', async () => {
    const w = makeWorld({});
    const out = await ingestInboundEmail(notice({ spamVerdict: 'GRAY' }), w.deps);
    expect(out.outcome).toBe('threaded');
    expect(w.putUnmatched).not.toHaveBeenCalled();
  });

  it('spam FAIL with a valid reply token still threads (the tier-5 match beats the verdict)', async () => {
    const w = makeWorld({
      contact: null,
      raw: mime({ from: 'stranger@x.test', to: 'relay+TOK1@mail.test' }),
      conversations: [{ conversationId: 'conv-tok', email_reply_token: 'TOK1' } as Partial<ConversationItem>],
    });
    const out = await ingestInboundEmail(notice({ spamVerdict: 'FAIL' }), w.deps);
    expect(out.outcome).toBe('threaded');
    expect(w.appended[0]!.conversationId).toBe('conv-tok');
  });
});

// ---------------------------------------------------------------------------
// Tier 5 - reply-token / references threading
// ---------------------------------------------------------------------------

describe('tier 5: token/references threading', () => {
  it('a reply token in To threads into the token conversation with full email content', async () => {
    const w = makeWorld({
      raw: mime({
        to: 'relay+TOK1@mail.test',
        subject: 'Re: tour',
        body: ['Works for me!', '', 'On Mon, Team wrote:', '> does 3pm work?'].join('\n'),
        html: '<p>Works for me!</p><script>x()</script>',
      }),
      conversations: [
        {
          conversationId: 'conv-tok',
          email_reply_token: 'TOK1',
          participants: [{ contactId: 'c1', phone: '' }],
        } as Partial<ConversationItem>,
      ],
    });
    const out = await ingestInboundEmail(notice(), w.deps);
    expect(out.outcome).toBe('threaded');
    const m = w.appended[0]!;
    expect(m.conversationId).toBe('conv-tok');
    expect(m.type).toBe('email');
    expect(m.direction).toBe('inbound');
    expect(m.deliveryStatus).toBe('delivered');
    expect(m.providerSid).toBe('in-1@example.com'); // BARE rfc id (sid# ptr = threading lookup)
    expect(m.email_message_id).toBe('<in-1@example.com>'); // bracketed RFC fidelity
    expect(m.body).toBe('Works for me!'); // visible reply text only
    expect(m.subject).toBe('Re: tour');
    expect(m.email_from).toBe('alice@example.com');
    expect(m.email_to).toEqual(['relay+tok1@mail.test']);
    expect(m.email_raw_ref).toEqual({ bucket: 'inbound-bucket', key: 'obj/key-1' });
    expect(m.email_html_sanitized).toContain('Works for me!');
    expect(m.email_html_sanitized).not.toContain('<script');
    expect(m.email_new_address).toBeUndefined(); // c1 owns alice@example.com
    expect(m.author).toBe('tenant');
  });

  it('In-Reply-To resolves via getByRfcMessageId with the angle brackets STRIPPED', async () => {
    const w = makeWorld({
      contact: null,
      raw: mime({ from: 'stranger@x.test', inReplyTo: '<hc-9@mail.test>' }),
      conversations: [{ conversationId: 'conv-ref' } as Partial<ConversationItem>],
      rfcIndex: { 'hc-9@mail.test': { conversationId: 'conv-ref', tsMsgId: 't1' } },
    });
    const out = await ingestInboundEmail(notice(), w.deps);
    expect(out.outcome).toBe('threaded');
    expect(w.getByRfcMessageId).toHaveBeenCalledWith('hc-9@mail.test');
    expect(w.appended[0]!.conversationId).toBe('conv-ref');
  });

  it('References fall back when In-Reply-To misses, trying the NEWEST reference first', async () => {
    const w = makeWorld({
      contact: null,
      raw: mime({
        from: 'stranger@x.test',
        inReplyTo: '<missing@x.test>',
        references: '<old@mail.test> <hc-8@mail.test>',
      }),
      conversations: [{ conversationId: 'conv-ref' } as Partial<ConversationItem>],
      rfcIndex: { 'hc-8@mail.test': { conversationId: 'conv-ref', tsMsgId: 't1' } },
    });
    const out = await ingestInboundEmail(notice(), w.deps);
    expect(out.outcome).toBe('threaded');
    const lookups = w.getByRfcMessageId.mock.calls.map((c) => c[0]);
    // newest (last) reference is tried before the older one; the older is never needed
    expect(lookups).toContain('hc-8@mail.test');
    expect(lookups).not.toContain('old@mail.test');
  });

  it('a NEW from-address on the resolved thread appends flagged email_new_address, author unknown, and does NOT attach or touch the address', async () => {
    const w = makeWorld({
      contact: { emails: [{ email: 'other@person.test', primary: true }], email: 'other@person.test' },
      raw: mime({ from: 'brand-new@else.test', to: 'relay+TOK1@mail.test' }),
      conversations: [
        {
          conversationId: 'conv-tok',
          email_reply_token: 'TOK1',
          participants: [{ contactId: 'c1', phone: '' }],
        } as Partial<ConversationItem>,
      ],
    });
    const out = await ingestInboundEmail(notice(), w.deps);
    expect(out.outcome).toBe('threaded');
    const m = w.appended[0]!;
    expect(m.email_new_address).toBe(true);
    expect(m.author).toBe('unknown'); // honesty: the address is unverified
    expect(w.attachEmailToConversation).not.toHaveBeenCalled(); // adding is a staff action later
    expect(w.touchEmailLastSeen).not.toHaveBeenCalled();
  });

  it('a KNOWN from-address arriving via token keeps contact-type authorship (no flag)', async () => {
    const w = makeWorld({
      contact: { type: 'landlord' },
      raw: mime({ to: 'relay+TOK1@mail.test' }),
      conversations: [
        {
          conversationId: 'conv-tok',
          email_reply_token: 'TOK1',
          participants: [{ contactId: 'c1', phone: '' }],
          type: 'landlord_1to1',
        } as Partial<ConversationItem>,
      ],
    });
    const out = await ingestInboundEmail(notice(), w.deps);
    expect(out.outcome).toBe('threaded');
    expect(w.appended[0]!.author).toBe('landlord');
    expect(w.appended[0]!.email_new_address).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tier 6 - known-contact threading
// ---------------------------------------------------------------------------

describe('tier 6: known-contact threading', () => {
  it('threads into the existing open EMAIL conversation, appending into the ARBITER-returned conversationId', async () => {
    const w = makeWorld({
      conversations: [
        { conversationId: 'conv-e', participant_email: 'alice@example.com' } as Partial<ConversationItem>,
      ],
      attachReturns: 'conv-elsewhere',
    });
    const out = await ingestInboundEmail(notice(), w.deps);
    expect(out.outcome).toBe('threaded');
    expect(w.attachEmailToConversation).toHaveBeenCalledWith('conv-e', 'alice@example.com');
    // the claim arbiter redirected - the append follows ITS answer
    expect(w.appended[0]!.conversationId).toBe('conv-elsewhere');
  });

  it('falls back to the contact primary-phone 1:1 thread when no email thread exists', async () => {
    const w = makeWorld({
      contact: { phone: '+15550100001', phones: [{ phone: '+15550100001', primary: true }] },
      conversations: [
        { conversationId: 'conv-p', participant_phone: '+15550100001', type: 'tenant_1to1' } as Partial<ConversationItem>,
      ],
    });
    const out = await ingestInboundEmail(notice(), w.deps);
    expect(out.outcome).toBe('threaded');
    expect(w.attachEmailToConversation).toHaveBeenCalledWith('conv-p', 'alice@example.com');
    expect(w.appended[0]!.conversationId).toBe('conv-p');
    expect(w.createOrGetByParticipantEmail).not.toHaveBeenCalled();
  });

  it('creates via createOrGetByParticipantEmail with {contactId, displayName} when the contact has no open 1:1', async () => {
    const w = makeWorld({});
    const out = await ingestInboundEmail(notice(), w.deps);
    expect(out.outcome).toBe('threaded');
    expect(w.createOrGetByParticipantEmail).toHaveBeenCalledWith('alice@example.com', 'tenant_1to1', {
      contactId: 'c1',
      displayName: 'Alice Sender',
    });
    expect(w.appended[0]!.conversationId).toBe('conv-new');
  });

  it('author honesty: a partner contact appends author partner (partner_1to1 on create)', async () => {
    const w = makeWorld({ contact: { type: 'partner' } });
    await ingestInboundEmail(notice(), w.deps);
    expect(w.createOrGetByParticipantEmail).toHaveBeenCalledWith(
      'alice@example.com',
      'partner_1to1',
      expect.anything(),
    );
    expect(w.appended[0]!.author).toBe('partner');
  });

  it('author honesty: an unknown-typed contact appends author unknown (unknown_1to1 on create)', async () => {
    const w = makeWorld({ contact: { type: 'unknown' } });
    await ingestInboundEmail(notice(), w.deps);
    expect(w.createOrGetByParticipantEmail).toHaveBeenCalledWith(
      'alice@example.com',
      'unknown_1to1',
      expect.anything(),
    );
    expect(w.appended[0]!.author).toBe('unknown');
  });

  it('mirrors the twilio inbound block: unread increment, touch, message.persisted + conversation.updated SSE', async () => {
    const w = makeWorld({});
    await ingestInboundEmail(notice(), w.deps);
    expect(w.incrementUnread).toHaveBeenCalledWith('conv-new');
    expect(w.touchLastActivity).toHaveBeenCalledWith('conv-new', 'A plain text body', NOW);
    expect(w.emit).toHaveBeenCalledWith('message.persisted', {
      conversationId: 'conv-new',
      tsMsgId: expect.stringContaining('in-1@example.com'),
      direction: 'inbound',
      deliveryStatus: 'delivered',
    });
    expect(w.emit).toHaveBeenCalledWith(
      'conversation.updated',
      expect.objectContaining({ conversationId: 'conv-new', unread_count: 1 }),
    );
  });

  it('touches the address lastSeen best-effort (a throw never fails the ingest)', async () => {
    const w = makeWorld({ touchEmailThrows: true });
    const out = await ingestInboundEmail(notice(), w.deps);
    expect(out.outcome).toBe('threaded');
    expect(w.touchEmailLastSeen).toHaveBeenCalledWith('c1', 'alice@example.com', NOW);
  });

  it('schedules email extraction for a tenant 1:1 with the configured debounce', async () => {
    const w = makeWorld({ env: { AI_EXTRACTION_DEBOUNCE_MS: '30000' } });
    await ingestInboundEmail(notice(), w.deps);
    expect(w.scheduleExtraction).toHaveBeenCalledWith(
      'conv-new',
      'email',
      new Date(Date.parse(NOW) + 30_000).toISOString(),
    );
  });

  it('schedules for an unknown 1:1, but NOT for landlord or partner threads', async () => {
    const unknown = makeWorld({ contact: { type: 'unknown' } });
    await ingestInboundEmail(notice(), unknown.deps);
    expect(unknown.scheduleExtraction).toHaveBeenCalled();

    const landlord = makeWorld({ contact: { type: 'landlord' } });
    await ingestInboundEmail(notice(), landlord.deps);
    expect(landlord.scheduleExtraction).not.toHaveBeenCalled();

    const partner = makeWorld({ contact: { type: 'partner' } });
    await ingestInboundEmail(notice(), partner.deps);
    expect(partner.scheduleExtraction).not.toHaveBeenCalled();
  });

  it('does not schedule extraction when the kill switch is off', async () => {
    const w = makeWorld({ env: { AI_EXTRACTION_ENABLED: 'false' } });
    await ingestInboundEmail(notice(), w.deps);
    expect(w.scheduleExtraction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tier 7 - unmatched side-door
// ---------------------------------------------------------------------------

describe('tier 7: unmatched', () => {
  it('an unknown sender lands in the unmatched store: NO contact, NO conversation, NO capture, meta-only attachments', async () => {
    const w = makeWorld({
      contact: null,
      raw: mime({
        from: 'Newbie <newbie@somewhere.test>',
        subject: 'Looking for a 2 bed',
        body: 'Hi, do you have anything available?',
        html: '<p>Hi, do you have anything <b>available</b>?</p>',
        attachments: [{ filename: 'voucher.pdf', contentType: 'application/pdf', base64: 'JVBERg==' }],
      }),
    });
    const out = await ingestInboundEmail(notice(), w.deps);
    expect(out.outcome).toBe('unmatched');
    const row = unmatchedRows(w)[0]!;
    expect(row.status).toBe('unmatched');
    expect(row.from).toEqual({ name: 'Newbie', address: 'newbie@somewhere.test' });
    expect(row.subject).toBe('Looking for a 2 bed');
    expect(row.snippet).toBe('Hi, do you have anything available?');
    expect(row.text).toContain('Hi, do you have anything available?');
    expect(row.html_sanitized).toContain('available');
    expect(row.raw_ref).toEqual({ bucket: 'inbound-bucket', key: 'obj/key-1' });
    expect(row.attachments_meta).toEqual([
      { filename: 'voucher.pdf', contentType: 'application/pdf', size: 4 },
    ]);
    // Decision 4 pins:
    expect(w.contactCapture).not.toHaveBeenCalled();
    expect(w.append).not.toHaveBeenCalled();
    expect(w.attachEmailToConversation).not.toHaveBeenCalled();
    expect(w.createOrGetByParticipantEmail).not.toHaveBeenCalled();
    expect(w.put).not.toHaveBeenCalled(); // meta only - no media-bucket copy
    expect(w.emit).toHaveBeenCalledWith('unmatched_email.updated', { unmatchedId: 'um-1' });
    expect(w.emit).not.toHaveBeenCalledWith('message.persisted', expect.anything());
    expect(w.emit).not.toHaveBeenCalledWith('conversation.updated', expect.anything());
  });

  it('caps the snippet at 180 chars', async () => {
    const w = makeWorld({ contact: null, raw: mime({ body: 'x'.repeat(500) }) });
    await ingestInboundEmail(notice(), w.deps);
    expect(unmatchedRows(w)[0]!.snippet.length).toBeLessThanOrEqual(180);
  });

  it('reingest: true skips the object marker so a human-linked mail can re-enter tier 6', async () => {
    const w = makeWorld({ contact: null });
    const first = await ingestInboundEmail(notice(), w.deps);
    expect(first.outcome).toBe('unmatched');
    // Without the flag, the claimed object marker blocks any re-run.
    const blocked = await ingestInboundEmail(notice(), w.deps);
    expect(blocked.outcome).toBe('duplicate');
    // B3 link flow: the address lands on a contact, then the SAME notice
    // re-enters the tiers with reingest.
    w.setContact({
      email: 'alice@example.com',
      emails: [{ email: 'alice@example.com', primary: true }],
    });
    const relinked = await ingestInboundEmail(notice(), w.deps, { reingest: true });
    expect(relinked.outcome).toBe('threaded');
    expect(w.append).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Threaded attachments - storage, caps, degradation
// ---------------------------------------------------------------------------

function fakeParsed(over: Partial<ParsedInboundEmail> = {}): ParsedInboundEmail {
  return {
    rfcMessageId: '<fake-1@x.test>',
    references: [],
    from: { address: 'alice@example.com', name: 'Alice' },
    to: ['team@mail.test'],
    cc: [],
    subject: 'S',
    text: 'body',
    attachments: [],
    ...over,
  };
}

describe('threaded attachments', () => {
  it('streams attachments to media/<conversationId>/<rfcSafe>/<i> with normalized type + preserved filename', async () => {
    const w = makeWorld({
      raw: mime({
        attachments: [
          { filename: 'lease agreement.pdf', contentType: 'application/pdf', base64: 'JVBERg==' },
          { filename: 'weird.bin', contentType: 'application/x-weird', base64: 'AAAA' },
        ],
      }),
    });
    const out = await ingestInboundEmail(notice(), w.deps);
    expect(out.outcome).toBe('threaded');
    const keys = w.put.mock.calls.map((c) => c[0] as string);
    expect(keys[0]).toMatch(/^media\/conv-new\/in-1_example\.com\/0$/);
    expect(keys[1]).toMatch(/^media\/conv-new\/in-1_example\.com\/1$/);
    const m = w.appended[0]!;
    expect(m.mediaAttachments).toEqual([
      { s3Key: keys[0], contentType: 'application/pdf', filename: 'lease agreement.pdf' },
      { s3Key: keys[1], contentType: 'application/octet-stream', filename: 'weird.bin' },
    ]);
    expect(m.attachments_truncated).toBeUndefined();
  });

  it('skips attachments past the 25MB per-message total and marks attachments_truncated', async () => {
    const w = makeWorld({
      parseMime: async () =>
        fakeParsed({
          attachments: [
            { filename: 'big.pdf', contentType: 'application/pdf', content: Buffer.alloc(20 * 1024 * 1024), size: 20 * 1024 * 1024 },
            { filename: 'straw.pdf', contentType: 'application/pdf', content: Buffer.alloc(10 * 1024 * 1024), size: 10 * 1024 * 1024 },
          ],
        }),
    });
    const out = await ingestInboundEmail(notice(), w.deps);
    expect(out.outcome).toBe('threaded');
    expect(w.put).toHaveBeenCalledTimes(1);
    const m = w.appended[0]!;
    expect(m.mediaAttachments).toHaveLength(1);
    expect(m.attachments_truncated).toBe(true);
  });

  it('caps parsed attachments at 50: first 50 stored + truncated note (DoS 2)', async () => {
    const w = makeWorld({
      parseMime: async () =>
        fakeParsed({
          attachments: Array.from({ length: 51 }, (_, i) => ({
            filename: `f${i}.txt`,
            contentType: 'text/plain',
            content: Buffer.from('x'),
            size: 1,
          })),
        }),
    });
    await ingestInboundEmail(notice(), w.deps);
    expect(w.put).toHaveBeenCalledTimes(50);
    expect(w.appended[0]!.attachments_truncated).toBe(true);
  });

  it('threads WITHOUT stored attachments when no media store is configured (marked truncated)', async () => {
    const w = makeWorld({
      mediaStore: null,
      raw: mime({ attachments: [{ filename: 'x.pdf', contentType: 'application/pdf', base64: 'JVBERg==' }] }),
    });
    const out = await ingestInboundEmail(notice(), w.deps);
    expect(out.outcome).toBe('threaded');
    expect(w.appended[0]!.mediaAttachments).toBeUndefined();
    expect(w.appended[0]!.attachments_truncated).toBe(true);
  });

  it('a single failed attachment put is skipped; the rest still store and the message persists', async () => {
    const w = makeWorld({
      putThrowsOnFirst: true,
      raw: mime({
        attachments: [
          { filename: 'a.pdf', contentType: 'application/pdf', base64: 'JVBERg==' },
          { filename: 'b.pdf', contentType: 'application/pdf', base64: 'JVBERg==' },
        ],
      }),
    });
    const out = await ingestInboundEmail(notice(), w.deps);
    expect(out.outcome).toBe('threaded');
    expect(w.appended[0]!.mediaAttachments).toHaveLength(1);
    expect(w.appended[0]!.mediaAttachments![0]!.filename).toBe('b.pdf');
  });
});

// ---------------------------------------------------------------------------
// M1: sender-controlled stored-array caps (To/Cc/References/attachment
// filenames) - long Cc headers + References chains are ROUTINE on forwarded /
// mailing-list mail; an uncapped stored item would overflow DynamoDB's 400 KB
// ceiling and THROW on append, DLQ'ing legitimate mail. Overflow NEVER throws.
// ---------------------------------------------------------------------------

const CC_500 = Array.from({ length: 500 }, (_, i) => `cc${i}@example.com`);
const REFS_200 = Array.from({ length: 200 }, (_, i) => `<ref${i}@example.com>`);
const LONG_FILENAME = `${'x'.repeat(20_000)}.pdf`;
const FILENAME_BYTE_CAP = 8 * 1024;

describe('M1: stored-array caps', () => {
  it('threaded path: caps To/Cc + References (last-N) + attachment filenames, marks headers_truncated, never throws', async () => {
    const w = makeWorld({
      parseMime: async () =>
        fakeParsed({
          cc: CC_500,
          references: REFS_200,
          attachments: [
            { filename: LONG_FILENAME, contentType: 'application/pdf', content: Buffer.from('x'), size: 1 },
          ],
        }),
    });
    const out = await ingestInboundEmail(notice(), w.deps);
    expect(out.outcome).toBe('threaded'); // stored successfully - no throw
    const m = w.appended[0]!;
    // Cc bounded by the element-count cap (50); the byte cap is not reached.
    expect(m.email_cc!.length).toBe(50);
    // References keeps the LAST N ids (the direct-parent end the lookup walks).
    expect(m.email_references).toEqual(REFS_200.slice(-10));
    // The long attachment filename is byte-bounded on the stored mediaAttachment.
    expect(Buffer.byteLength(m.mediaAttachments![0]!.filename ?? '', 'utf8')).toBeLessThanOrEqual(FILENAME_BYTE_CAP);
    expect(m.headers_truncated).toBe(true);
  });

  it('unmatched path: caps attachment-filename bytes on the stored row + marks headers_truncated, never throws', async () => {
    const w = makeWorld({
      contact: null, // unknown sender -> tier 7 unmatched side-door
      parseMime: async () =>
        fakeParsed({
          cc: CC_500,
          references: REFS_200,
          attachments: [
            { filename: LONG_FILENAME, contentType: 'application/pdf', content: Buffer.from('x'), size: 1 },
          ],
        }),
    });
    const out = await ingestInboundEmail(notice(), w.deps);
    expect(out.outcome).toBe('unmatched'); // stored successfully - no throw
    const row = w.putUnmatched.mock.calls[0]![0] as NewUnmatchedEmail;
    expect(Buffer.byteLength(row.attachments_meta[0]!.filename, 'utf8')).toBeLessThanOrEqual(FILENAME_BYTE_CAP);
    expect(row.headers_truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Parse hardening (DoS 3)
// ---------------------------------------------------------------------------

describe('parse hardening', () => {
  it('a parser throw quarantines as parse_failed; the pre-claimed marker makes redelivery no-op', async () => {
    const w = makeWorld({
      parseMime: async () => {
        throw new Error('hostile input');
      },
    });
    const out = await ingestInboundEmail(notice(), w.deps);
    expect(out.outcome).toBe('quarantined');
    const row = unmatchedRows(w)[0]!;
    expect(row.status).toBe('quarantined');
    expect(row.parse_skipped).toBe('parse_failed');
    const again = await ingestInboundEmail(notice(), w.deps);
    expect(again.outcome).toBe('duplicate');
    expect(w.putUnmatched).toHaveBeenCalledTimes(1);
  });

  it('a hung parser is cut off by the 30s race and quarantined as parse_failed', async () => {
    vi.useFakeTimers();
    const w = makeWorld({
      parseMime: () => new Promise<ParsedInboundEmail>(() => {}),
    });
    const pending = ingestInboundEmail(notice(), w.deps);
    await vi.advanceTimersByTimeAsync(30_000);
    const out = await pending;
    expect(out.outcome).toBe('quarantined');
    expect(unmatchedRows(w)[0]!.parse_skipped).toBe('parse_failed');
  });
});

// ---------------------------------------------------------------------------
// PII posture (F18)
// ---------------------------------------------------------------------------

describe('PII posture', () => {
  it('never logs addresses, subjects, or bodies (ids/keys only)', async () => {
    const w = makeWorld({
      raw: mime({
        from: 'Secret Person <secret.person@private.test>',
        subject: 'Very private subject',
        body: 'A very private body line',
      }),
    });
    await ingestInboundEmail(notice(), w.deps);
    const wUnmatched = makeWorld({
      contact: null,
      raw: mime({ from: 'other.secret@private.test', subject: 'Hush', body: 'Hidden text' }),
    });
    await ingestInboundEmail(notice({ key: 'obj/key-9' }), wUnmatched.deps);
    for (const capture of [w.capture, wUnmatched.capture]) {
      const all = JSON.stringify(capture.lines);
      expect(all).not.toContain('private.test');
      expect(all).not.toContain('Very private subject');
      expect(all).not.toContain('private body');
      expect(all).not.toContain('Hush');
      expect(all).not.toContain('Hidden text');
    }
  });
});
