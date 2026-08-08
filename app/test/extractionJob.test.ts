// Extraction job unit tests (conversation-fact-extraction T7).
//
// Unit-style: injected FAKE repos + a recording FAKE driver + the REAL apply.ts
// with stub deps + FIXED ISO clock strings (no wall-clock, no DynamoDB). Pins
// runDueExtractions' claim/isolation/backoff semantics.
//
// Covers (plan T7 Step 1):
//   happy path       - writes cursor + calls apply with a CHRONOLOGICAL transcript
//   claim-false      - skips silently (no driver, no complete)
//   landlord contact - completes without a driver call (nothing to extract)
//   no-new-client    - completes with the SAME cursor without a driver call
//   driver throw     - fail() with a doubled nextDueAt (exponential backoff)
//   5th failure      - parks (nextDueAt null) at MAX_EXTRACTION_ATTEMPTS
//   refusal error    - ExtractionRefusedError follows the same failure path
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_EXTRACTION_ATTEMPTS,
  NEW_MESSAGE_CHAR_CAP,
  SEEN_MESSAGE_CHAR_CAP,
  TRUNCATION_MARKER,
  WINDOW_CHAR_BUDGET,
  runDueExtractions,
  type ExtractionJobDeps,
} from '../src/jobs/extraction.js';
import type { DueExtractionItem, ExtractionRepo, PutSuggestionResult } from '../src/repos/extractionRepo.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { MessageItem } from '../src/repos/messagesRepo.js';
import { FakeExtractionDriver } from '../src/adapters/extractionFake.js';
import {
  type ExtractionDriver,
  type ExtractionInput,
} from '../src/adapters/extraction.js';
import type { ApplyDeps } from '../src/services/extraction/apply.js';
import { createLogger, type Logger } from '../src/lib/logger.js';
import type { AiRunRecordInput } from '../src/repos/aiRunsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const NOW = '2026-07-17T00:00:00.000Z';
/** The job's WALL clock for run-record timestamps - deliberately DIFFERENT from
 *  NOW, so a test can prove the record does not use the poll clock. */
const WALL_NOW = '2026-07-17T09:30:00.000Z';
const DEBOUNCE = 30_000;

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

// A stable-ordered tsMsgId: `<providerTs>#<sid>` (lexicographically sortable).
function msg(seconds: number, direction: 'inbound' | 'outbound', body: string): MessageItem {
  const ts = `2026-07-16T12:00:${String(seconds).padStart(2, '0')}.000Z`;
  return {
    conversationId: 'conv1',
    tsMsgId: `${ts}#s${seconds}`,
    type: 'sms',
    direction,
    author: direction === 'inbound' ? 'tenant' : 'teammate',
    body,
    provider_sid: `s${seconds}`,
    provider_ts: ts,
    delivery_status: 'delivered',
    created_at: ts,
  };
}

// A stored call carrying a transcript. Mirrors msg()'s tsMsgId shape with a
// `#c<seconds>` suffix so calls and texts remain distinctly, stably sortable.
// toUtterances parses `transcript` (never the call's direction), so direction
// here only exercises the freshness gate's inbound-vs-completed branches.
function callMsg(
  seconds: number,
  direction: 'inbound' | 'outbound',
  transcript: string,
  transcriptStatus: MessageItem['transcript_status'],
): MessageItem {
  const ts = `2026-07-16T12:00:${String(seconds).padStart(2, '0')}.000Z`;
  return {
    conversationId: 'conv1',
    tsMsgId: `${ts}#c${seconds}`,
    type: 'call',
    direction,
    author: direction === 'inbound' ? 'tenant' : 'teammate',
    provider_sid: `c${seconds}`,
    provider_ts: ts,
    delivery_status: 'delivered',
    created_at: ts,
    transcript,
    transcript_status: transcriptStatus,
  };
}

// A stored email message (email-channel B2). tsMsgId suffix `#e<seconds>` keeps
// emails distinctly sortable beside texts (#s) and calls (#c). Carries a
// subject so the email-arm tests can pin "BODY only - subject NEVER leaks
// into the transcript".
function emailMsg(
  seconds: number,
  direction: 'inbound' | 'outbound',
  body: string,
  subject: string,
): MessageItem {
  const ts = `2026-07-16T12:00:${String(seconds).padStart(2, '0')}.000Z`;
  return {
    conversationId: 'conv1',
    tsMsgId: `${ts}#e${seconds}`,
    type: 'email',
    direction,
    author: direction === 'inbound' ? 'tenant' : 'teammate',
    body,
    subject,
    email_from: direction === 'inbound' ? 'tenant@x.test' : 'team@mail.test',
    provider_sid: `e${seconds}`,
    provider_ts: ts,
    delivery_status: 'delivered',
    created_at: ts,
  };
}

function tenantContact(): ContactItem {
  return { contactId: 'c1', type: 'tenant', status: 'onboarding', phone: '+15551230001' } as ContactItem;
}

function tenantContactWith(overrides: Partial<ContactItem>): ContactItem {
  return { ...tenantContact(), ...overrides } as ContactItem;
}

function landlordContact(): ContactItem {
  return { contactId: 'c1', type: 'landlord', status: 'interested', phone: '+15551230001' } as ContactItem;
}

function unknownContact(): ContactItem {
  return { contactId: 'c1', type: 'unknown', status: 'needs_review', phone: '+15551230001' } as ContactItem;
}

function convWith(contactId: string): ConversationItem {
  return {
    conversationId: 'conv1',
    participant_phone: '+15551230001',
    status: 'open',
    last_activity_at: NOW,
    type: 'tenant_1to1',
    ai_mode: 'off',
    participants: [{ contactId, phone: '+15551230001' }],
    created_at: NOW,
  } as unknown as ConversationItem;
}

function makeRepo(dueRows: DueExtractionItem[], claimResult = true): ExtractionRepo {
  const put = vi.fn(
    async (s: Parameters<ExtractionRepo['putSuggestion']>[0]): Promise<PutSuggestionResult> => ({
      item: {
        ...s,
        itemId: `sugg#${s.ownerContactId}#${s.target}`,
        _pendingPartition: 'pending',
        createdAt: NOW,
      },
    }),
  );
  return {
    scheduleExtraction: vi.fn(async () => {}),
    listDue: vi.fn(async () => dueRows),
    claim: vi.fn(async () => claimResult),
    complete: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    getDue: vi.fn(async () => undefined),
    putSuggestion: put,
    getSuggestion: vi.fn(async () => undefined),
    listSuggestionsByContact: vi.fn(async () => []),
    deleteSuggestion: vi.fn(async () => {}),
    listPending: vi.fn(async () => []),
    putDismissal: vi.fn(async () => {}),
    hasDismissal: vi.fn(async () => false),
  } satisfies ExtractionRepo;
}

interface Harness {
  deps: ExtractionJobDeps;
  repo: ExtractionRepo;
  seen: ExtractionInput[];
  contactsUpdate: ReturnType<typeof vi.fn>;
  runs: AiRunRecordInput[];
  aiRuns: { putRun: ReturnType<typeof vi.fn>; setVerdict: ReturnType<typeof vi.fn> };
  applyEvents: { emit: ReturnType<typeof vi.fn> };
}

function makeHarness(opts: {
  dueRows: DueExtractionItem[];
  messages?: MessageItem[];
  contact?: ContactItem | undefined;
  conversation?: ConversationItem | undefined;
  claimResult?: boolean;
  driver?: ExtractionDriver;
  aiRuns?: { putRun: ReturnType<typeof vi.fn>; setVerdict: ReturnType<typeof vi.fn> };
  logger?: Logger;
}): Harness {
  const repo = makeRepo(opts.dueRows, opts.claimResult ?? true);
  const seen: ExtractionInput[] = [];
  const fake = new FakeExtractionDriver();
  const driver: ExtractionDriver =
    opts.driver ?? {
      kind: 'fake',
      extract: async (input: ExtractionInput) => {
        seen.push(input);
        return fake.extract(input);
      },
    };

  const contactsUpdate = vi.fn(async () => ({}) as ContactItem);
  const runs: AiRunRecordInput[] = [];
  const aiRuns = opts.aiRuns ?? {
    putRun: vi.fn(async (r: AiRunRecordInput) => {
      runs.push(r);
      return { ...r, itemId: `run#${r.runId}`, expires_at: 0 };
    }),
    setVerdict: vi.fn(async () => true),
  };
  const contacts = {
    getById: vi.fn(async () => opts.contact),
    findByPhone: vi.fn(async () => undefined),
    update: contactsUpdate,
    addPhone: vi.fn(async () => ({}) as ContactItem),
  };

  // Hoisted so a test can make it THROW. apply.ts calls this emit OUTSIDE any
  // try, and processRow deliberately does not wrap applyExtraction - so an emit
  // throw is one of the few paths that actually reaches runDueExtractions'
  // backstop. See Task 20.
  const applyEvents = { emit: vi.fn() };
  const applyDeps: ApplyDeps = {
    contacts,
    extraction: repo,
    audit: { append: vi.fn(async () => undefined) },
    events: applyEvents,
    logger: opts.logger ?? silentLogger,
    now: () => NOW,
  };

  const deps: ExtractionJobDeps = {
    repo,
    aiRuns,
    now: () => WALL_NOW,
    conversations: { getById: vi.fn(async () => opts.conversation) },
    messages: { listByConversation: vi.fn(async () => opts.messages ?? []) },
    contacts,
    driver,
    applyDeps,
    config: { aiExtractionDebounceMs: DEBOUNCE },
    logger: opts.logger ?? silentLogger,
  };

  return { deps, repo, seen, contactsUpdate, runs, aiRuns, applyEvents };
}

function dueRow(overrides: Partial<DueExtractionItem> = {}): DueExtractionItem {
  return {
    itemId: 'due#conv1',
    conversationId: 'conv1',
    channel: 'sms',
    dueAt: '2026-07-16T23:59:00.000Z',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('runDueExtractions', () => {
  it('stamps every utterance with the tsMsgId of the message it came from', async () => {
    // Design 6.1: without this the run log cannot attribute rendered output back
    // to a message, so no per-message hash is possible. A call transcript
    // produces MANY utterances - all carry the call row's tsMsgId.
    const sms = msg(10, 'inbound', 'hello');
    const call = callMsg(20, 'inbound', 'Staff: how can I help\nClient: I need a 2 bedroom', 'completed');
    const h = makeHarness({
      dueRows: [dueRow()],
      messages: [call, sms], // listByConversation returns NEWEST-first
      contact: tenantContact(),
      conversation: convWith('c1'),
    });

    await runDueExtractions(NOW, h.deps);

    expect(h.seen[0]!.transcript.map((u) => u.tsMsgId)).toEqual([
      sms.tsMsgId,
      call.tsMsgId,
      call.tsMsgId,
    ]);
  });

  it('happy path: runs the driver on a chronological transcript, writes the field, advances the cursor', async () => {
    const messages = [
      // newest-first, as listByConversation returns
      msg(3, 'inbound', 'EXTRACT:{"fields":{"pets":{"op":"write","value":"yes"}}}'),
      msg(2, 'outbound', 'do you have pets?'),
      msg(1, 'inbound', 'hi there'),
    ];
    const h = makeHarness({
      dueRows: [dueRow()],
      messages,
      contact: tenantContact(),
      conversation: convWith('c1'),
    });

    const out = await runDueExtractions(NOW, h.deps);

    expect(out).toEqual({ processed: 1, failed: 0 });
    // Transcript handed to the driver is CHRONOLOGICAL (oldest first).
    expect(h.seen).toHaveLength(1);
    const texts = h.seen[0]!.transcript.map((u) => u.text);
    expect(texts[0]).toBe('hi there');
    expect(texts[texts.length - 1]).toContain('EXTRACT:');
    expect(h.seen[0]!.transcript[0]!.speaker).toBe('client');
    expect(h.seen[0]!.transcript[1]!.speaker).toBe('staff');
    // The write landed (pets) via apply.
    expect(h.contactsUpdate).toHaveBeenCalledWith('c1', expect.objectContaining({ pets: 'yes' }));
    // Cursor advanced to the newest message's tsMsgId; no failure.
    expect(h.repo.complete).toHaveBeenCalledWith('conv1', messages[0]!.tsMsgId, NOW);
    expect(h.repo.fail).not.toHaveBeenCalled();
  });

  it('claim lost: skips the row silently (no driver, no complete)', async () => {
    const h = makeHarness({
      dueRows: [dueRow()],
      messages: [msg(1, 'inbound', 'EXTRACT:{"fields":{"pets":{"op":"write","value":"yes"}}}')],
      contact: tenantContact(),
      conversation: convWith('c1'),
      claimResult: false,
    });

    const out = await runDueExtractions(NOW, h.deps);

    expect(out).toEqual({ processed: 0, failed: 0 });
    expect(h.seen).toHaveLength(0);
    expect(h.repo.complete).not.toHaveBeenCalled();
    expect(h.repo.fail).not.toHaveBeenCalled();
  });

  it('landlord contact: completes without a driver call', async () => {
    const landlord = { contactId: 'c1', type: 'landlord', phone: '+15551230001' } as ContactItem;
    const h = makeHarness({
      dueRows: [dueRow()],
      messages: [msg(1, 'inbound', 'EXTRACT:{"fields":{"pets":{"op":"write","value":"yes"}}}')],
      contact: landlord,
      conversation: convWith('c1'),
    });

    const out = await runDueExtractions(NOW, h.deps);

    expect(out).toEqual({ processed: 0, failed: 0 });
    expect(h.seen).toHaveLength(0);
    // completes with the row's (absent) cursor -> ''
    expect(h.repo.complete).toHaveBeenCalledWith('conv1', '', NOW);
  });

  it('partner contact: completes without a driver call (excluded like landlord)', async () => {
    const partner = { contactId: 'c1', type: 'partner', phone: '+15551230001' } as ContactItem;
    const h = makeHarness({
      dueRows: [dueRow()],
      messages: [msg(1, 'inbound', 'EXTRACT:{"fields":{"pets":{"op":"write","value":"yes"}}}')],
      contact: partner,
      conversation: convWith('c1'),
    });

    const out = await runDueExtractions(NOW, h.deps);

    expect(out).toEqual({ processed: 0, failed: 0 });
    expect(h.seen).toHaveLength(0);
    expect(h.repo.complete).toHaveBeenCalledWith('conv1', '', NOW);
  });

  it('no new client messages since the cursor: completes with the same cursor, no driver', async () => {
    // Only a staff message is newer than the cursor; the sole client message
    // is AT the cursor (not newer).
    const client = msg(1, 'inbound', 'hi');
    const staff = msg(2, 'outbound', 'hello');
    const h = makeHarness({
      dueRows: [dueRow({ cursor: client.tsMsgId })],
      messages: [staff, client], // newest-first
      contact: tenantContact(),
      conversation: convWith('c1'),
    });

    const out = await runDueExtractions(NOW, h.deps);

    expect(out).toEqual({ processed: 0, failed: 0 });
    expect(h.seen).toHaveLength(0);
    expect(h.repo.complete).toHaveBeenCalledWith('conv1', client.tsMsgId, NOW);
  });

  it('driver failure: fails with a doubled nextDueAt (exponential backoff)', async () => {
    const failing: ExtractionDriver = {
      kind: 'fake',
      extract: async () => ({
        ok: false, meta: { driver: 'fake' }, failure: 'driver', message: 'driver boom',
      }),
    };
    const h = makeHarness({
      dueRows: [dueRow({ attempts: 1 })], // 2^1 = doubled backoff
      messages: [msg(1, 'inbound', 'EXTRACT:{"fields":{"pets":{"op":"write","value":"yes"}}}')],
      contact: tenantContact(),
      conversation: convWith('c1'),
      driver: failing,
    });

    const out = await runDueExtractions(NOW, h.deps);

    expect(out).toEqual({ processed: 0, failed: 1 });
    // now + DEBOUNCE * 2^1 = now + 60s
    const expected = new Date(Date.parse(NOW) + DEBOUNCE * 2).toISOString();
    expect(h.repo.fail).toHaveBeenCalledWith('conv1', expect.stringContaining('driver boom'), expected);
    expect(h.repo.complete).not.toHaveBeenCalled();
  });

  it('final failure parks the item (nextDueAt null)', async () => {
    const failing: ExtractionDriver = {
      kind: 'fake',
      extract: async () => ({
        ok: false, meta: { driver: 'fake' }, failure: 'driver', message: 'still failing',
      }),
    };
    const h = makeHarness({
      dueRows: [dueRow({ attempts: MAX_EXTRACTION_ATTEMPTS - 1 })], // attempts+1 >= MAX -> park
      messages: [msg(1, 'inbound', 'EXTRACT:{"fields":{"pets":{"op":"write","value":"yes"}}}')],
      contact: tenantContact(),
      conversation: convWith('c1'),
      driver: failing,
    });

    const out = await runDueExtractions(NOW, h.deps);

    expect(out).toEqual({ processed: 0, failed: 1 });
    expect(h.repo.fail).toHaveBeenCalledWith('conv1', expect.any(String), null);
  });

  it('refusal error follows the failure path', async () => {
    const refusing: ExtractionDriver = {
      kind: 'fake',
      extract: async () => ({
        ok: false, meta: { driver: 'fake' }, failure: 'refusal', message: 'declined',
      }),
    };
    const h = makeHarness({
      dueRows: [dueRow()], // attempts undefined -> 2^0 backoff, not parked
      messages: [msg(1, 'inbound', 'EXTRACT:{"fields":{"pets":{"op":"write","value":"yes"}}}')],
      contact: tenantContact(),
      conversation: convWith('c1'),
      driver: refusing,
    });

    const out = await runDueExtractions(NOW, h.deps);

    expect(out).toEqual({ processed: 0, failed: 1 });
    const expected = new Date(Date.parse(NOW) + DEBOUNCE).toISOString();
    expect(h.repo.fail).toHaveBeenCalledWith('conv1', expect.stringContaining('declined'), expected);
  });

  it('call transcript: parses the four line forms into voice utterances', async () => {
    // One completed call whose transcript exercises every prefix branch:
    //   Staff: / Client: -> prefix STRIPPED, role known;
    //   Speaker N:       -> speaker 'unknown', prefix KEPT (model tracks turns);
    //   unprefixed       -> voicemail: the client speaking.
    // A voice-channel due row bypasses the freshness gate so assembly runs.
    const transcript = [
      'Staff: how can I help',
      'Client: I have two kids',
      'Speaker 1: legacy unattributed line',
      'left a voicemail about a 2 bed',
    ].join('\n');
    const call = callMsg(2, 'inbound', transcript, 'completed');
    const h = makeHarness({
      dueRows: [dueRow({ channel: 'voice' })],
      messages: [call],
      contact: tenantContact(),
      conversation: convWith('c1'),
    });

    await runDueExtractions(NOW, h.deps);

    expect(h.seen).toHaveLength(1);
    // Every utterance shares the call row's created_at and is channel 'voice'.
    expect(h.seen[0]!.transcript).toEqual([
      { tsMsgId: call.tsMsgId, speaker: 'staff', text: 'how can I help', at: call.created_at, channel: 'voice' },
      { tsMsgId: call.tsMsgId, speaker: 'client', text: 'I have two kids', at: call.created_at, channel: 'voice' },
      { tsMsgId: call.tsMsgId, speaker: 'unknown', text: 'Speaker 1: legacy unattributed line', at: call.created_at, channel: 'voice' },
      { tsMsgId: call.tsMsgId, speaker: 'client', text: 'left a voicemail about a 2 bed', at: call.created_at, channel: 'voice' },
    ]);
  });

  it('email message: ONE utterance, channel email, trimmed BODY only - the subject never leaks (B2)', async () => {
    // An email-channel due row does NOT bypass the freshness gate (unlike
    // voice/triage); the inbound email itself clears it.
    const mail = emailMsg(2, 'inbound', 'I have a voucher for a 2 bed', 'Voucher question');
    const h = makeHarness({
      dueRows: [dueRow({ channel: 'email' })],
      messages: [mail],
      contact: tenantContact(),
      conversation: convWith('c1'),
    });

    await runDueExtractions(NOW, h.deps);

    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]!.transcript).toEqual([
      { tsMsgId: mail.tsMsgId, speaker: 'client', text: 'I have a voucher for a 2 bed', at: mail.created_at, channel: 'email' },
    ]);
    // BODY only: the subject is metadata, never transcript content.
    const allText = h.seen[0]!.transcript.map((u) => u.text).join(' ');
    expect(allText).not.toContain('Voucher question');
  });

  it('email message: an OUTBOUND email maps speaker staff (adversarial Q3 pin)', async () => {
    const inboundSms = msg(1, 'inbound', 'checking in'); // clears the freshness gate
    const reply = emailMsg(2, 'outbound', 'Sending the listing over now', 'Re: listing');
    const h = makeHarness({
      dueRows: [dueRow({ channel: 'email' })],
      messages: [reply, inboundSms], // newest-first, as listByConversation returns
      contact: tenantContact(),
      conversation: convWith('c1'),
    });

    await runDueExtractions(NOW, h.deps);

    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]!.transcript).toEqual([
      { tsMsgId: inboundSms.tsMsgId, speaker: 'client', text: 'checking in', at: inboundSms.created_at, channel: 'sms' },
      { tsMsgId: reply.tsMsgId, speaker: 'staff', text: 'Sending the listing over now', at: reply.created_at, channel: 'email' },
    ]);
  });

  it('channel-mixed window: an SMS and a transcribed call interleave chronologically', async () => {
    const sms1 = msg(1, 'inbound', 'hi there');
    const call = callMsg(2, 'inbound', ['Client: I have a voucher', 'Staff: which authority'].join('\n'), 'completed');
    const sms3 = msg(3, 'outbound', 'thanks');
    const h = makeHarness({
      dueRows: [dueRow()], // sms row; the inbound sms1 clears the freshness gate
      messages: [sms3, call, sms1], // newest-first, as listByConversation returns
      contact: tenantContact(),
      conversation: convWith('c1'),
    });

    await runDueExtractions(NOW, h.deps);

    expect(h.seen).toHaveLength(1);
    const t = h.seen[0]!.transcript;
    expect(t.map((u) => u.text)).toEqual(['hi there', 'I have a voucher', 'which authority', 'thanks']);
    expect(t.map((u) => u.speaker)).toEqual(['client', 'client', 'staff', 'staff']);
    expect(t.map((u) => u.channel)).toEqual(['sms', 'voice', 'voice', 'sms']);
    // The call's two utterances both carry the call row's created_at, slotted
    // between the two texts (the window is chronological by `at`).
    expect(t.map((u) => u.at)).toEqual([sms1.created_at, call.created_at, call.created_at, sms3.created_at]);
  });

  it('incomplete or empty-transcript calls contribute zero utterances', async () => {
    const sms = msg(1, 'inbound', 'hello'); // inbound sms clears the freshness gate
    const pending = callMsg(2, 'outbound', 'Client: ignored while pending', 'pending');
    const emptyCompleted = callMsg(3, 'outbound', '', 'completed');
    const h = makeHarness({
      dueRows: [dueRow()],
      messages: [emptyCompleted, pending, sms], // newest-first
      contact: tenantContact(),
      conversation: convWith('c1'),
    });

    await runDueExtractions(NOW, h.deps);

    expect(h.seen).toHaveLength(1);
    // Only the SMS survives; neither the pending nor the empty-completed call
    // adds anything.
    expect(h.seen[0]!.transcript).toEqual([{ tsMsgId: sms.tsMsgId, speaker: 'client', text: 'hello', at: sms.created_at, channel: 'sms' }]);
  });

  it('voice due item: runs even when the newest call row is OLDER than the cursor (freshness bypass)', async () => {
    // The cursor is lexicographically GREATER than the call's tsMsgId
    // (`...:05...#s5` > `...:01...#c1`), so on an SMS row this would early-exit.
    // The voice channel bypasses the gate: the transcript persists minutes after
    // the call row, so an earlier SMS run may already have advanced the cursor.
    const call = callMsg(1, 'inbound', 'left a voicemail: I need a 2 bedroom', 'completed');
    const h = makeHarness({
      dueRows: [dueRow({ channel: 'voice', cursor: '2026-07-16T12:00:05.000Z#s5' })],
      messages: [call],
      contact: tenantContact(),
      conversation: convWith('c1'),
    });

    const out = await runDueExtractions(NOW, h.deps);

    expect(out).toEqual({ processed: 1, failed: 0 });
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]!.transcript).toEqual([
      { tsMsgId: call.tsMsgId, speaker: 'client', text: 'left a voicemail: I need a 2 bedroom', at: call.created_at, channel: 'voice' },
    ]);
    expect(h.repo.fail).not.toHaveBeenCalled();
    // Cursor is MONOTONIC: the call's tsMsgId (`...:01...#c1`) is older than the
    // cursor (`...:05...#s5`), so complete() must KEEP the cursor, never regress it
    // to the older call row (which would make a later SMS run re-examine messages).
    expect(h.repo.complete).toHaveBeenCalledWith('conv1', '2026-07-16T12:00:05.000Z#s5', NOW);
  });

  it('triage due item: runs even with NOTHING newer than the cursor (post-triage re-read of the existing window)', async () => {
    // The whole window is at/behind the cursor - an SMS row would early-exit
    // (no new client content). The 'triage' channel bypasses the gate: a human
    // just flipped the contact to tenant, so tenant-only facts the apply layer
    // ignored for the unknown type are now applicable and the window must be
    // re-read as-is.
    const sms = msg(1, 'inbound', 'my voucher is a 3 bedroom');
    const h = makeHarness({
      dueRows: [dueRow({ channel: 'triage', cursor: sms.tsMsgId })],
      messages: [sms],
      contact: tenantContact(),
      conversation: convWith('c1'),
    });

    const out = await runDueExtractions(NOW, h.deps);

    expect(out).toEqual({ processed: 1, failed: 0 });
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]!.transcript).toEqual([
      { tsMsgId: sms.tsMsgId, speaker: 'client', text: 'my voucher is a 3 bedroom', at: sms.created_at, channel: 'sms' },
    ]);
    // The profile reflects the POST-triage type, so tenant-only fields apply.
    expect(h.seen[0]!.profile.contactType).toBe('tenant');
  });

  it('sms due item: still early-exits when only staff + an incomplete call are newer than the cursor', async () => {
    // The sole client message is AT the cursor; the only newer items are a staff
    // text and an outbound PENDING call - neither counts as new client content.
    const client = msg(1, 'inbound', 'hi');
    const staff = msg(2, 'outbound', 'hello');
    const pendingCall = callMsg(3, 'outbound', 'Client: not counted yet', 'pending');
    const h = makeHarness({
      dueRows: [dueRow({ cursor: client.tsMsgId })],
      messages: [pendingCall, staff, client], // newest-first
      contact: tenantContact(),
      conversation: convWith('c1'),
    });

    const out = await runDueExtractions(NOW, h.deps);

    expect(out).toEqual({ processed: 0, failed: 0 });
    expect(h.seen).toHaveLength(0);
    expect(h.repo.complete).toHaveBeenCalledWith('conv1', client.tsMsgId, NOW);
  });

  it('sms due item: a fresh completed-transcript call triggers a run with no new inbound SMS', async () => {
    // The client SMS is AT the cursor; the newer completed call is OUTBOUND, so
    // it counts as client content ONLY via the completed-transcript branch (it
    // carries the client's speech regardless of the call row's stored direction).
    const client = msg(1, 'inbound', 'hi');
    const staff = msg(2, 'outbound', 'hello');
    const call = callMsg(3, 'outbound', 'Client: my voucher got approved', 'completed');
    const h = makeHarness({
      dueRows: [dueRow({ cursor: client.tsMsgId })],
      messages: [call, staff, client], // newest-first
      contact: tenantContact(),
      conversation: convWith('c1'),
    });

    const out = await runDueExtractions(NOW, h.deps);

    expect(out).toEqual({ processed: 1, failed: 0 });
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]!.transcript).toEqual([
      { tsMsgId: client.tsMsgId, speaker: 'client', text: 'hi', at: client.created_at, channel: 'sms' },
      { tsMsgId: staff.tsMsgId, speaker: 'staff', text: 'hello', at: staff.created_at, channel: 'sms' },
      { tsMsgId: call.tsMsgId, speaker: 'client', text: 'my voucher got approved', at: call.created_at, channel: 'voice' },
    ]);
  });

  it('voice due item: an EMPTY window completes without throwing (bypass guard)', async () => {
    // A voice run BYPASSES the client-freshness early-exit, so an empty window (no
    // messages survived the 30-day / newest-50 cutoff) must NOT fall through to
    // fresh[fresh.length - 1] and throw - it completes with the existing cursor and
    // reports nothing processed (never a spurious failure/park).
    const h = makeHarness({
      dueRows: [dueRow({ channel: 'voice', cursor: '2026-07-16T12:00:05.000Z#s5' })],
      messages: [], // empty transcript window
      contact: tenantContact(),
      conversation: convWith('c1'),
    });

    const out = await runDueExtractions(NOW, h.deps);

    expect(out).toEqual({ processed: 0, failed: 0 });
    expect(h.seen).toHaveLength(0);
    expect(h.repo.fail).not.toHaveBeenCalled();
    expect(h.repo.complete).toHaveBeenCalledWith('conv1', '2026-07-16T12:00:05.000Z#s5', NOW);
  });

  it('profile carries the formatted current address when the contact has one', async () => {
    const contact = {
      ...tenantContact(),
      address: { line1: '1 Main St', city: 'Atlanta', state: 'GA' },
    } as ContactItem;
    const h = makeHarness({
      dueRows: [dueRow()],
      messages: [msg(1, 'inbound', 'hi there')],
      contact,
      conversation: convWith('c1'),
    });

    await runDueExtractions(NOW, h.deps);

    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]!.profile.address).toBe('1 Main St, Atlanta, GA');
  });

  it('profile omits address when the contact has none', async () => {
    const h = makeHarness({
      dueRows: [dueRow()],
      messages: [msg(1, 'inbound', 'hi there')],
      contact: tenantContact(),
      conversation: convWith('c1'),
    });

    await runDueExtractions(NOW, h.deps);

    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]!.profile.address).toBeUndefined();
  });

  it('REGRESSION: a driver failure still burns exactly one attempt and re-arms with backoff', async () => {
    // The ExtractionCall widening must not move backoff/park/attempts by one
    // millisecond. Pin the CURRENT numbers so Task 19's rewrite cannot drift
    // them either.
    const failing: ExtractionDriver = {
      kind: 'fake',
      extract: async () => ({
        ok: false, meta: { driver: 'fake' }, failure: 'driver', message: 'driver boom',
      }),
    };
    const h = makeHarness({
      dueRows: [dueRow({ attempts: 2 })],
      messages: [msg(10, 'inbound', 'hello')],
      contact: tenantContact(),
      conversation: convWith('c1'),
      driver: failing,
    });

    const out = await runDueExtractions(NOW, h.deps);

    expect(out).toEqual({ processed: 0, failed: 1 });
    expect(h.repo.fail).toHaveBeenCalledTimes(1);
    const [conversationId, message, nextDueAt] = (h.repo.fail as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(conversationId).toBe('conv1');
    expect(message).toContain('driver boom');
    // attempts=2 -> backoff = DEBOUNCE * 2^2, NOT parked (MAX is 5).
    expect(nextDueAt).toBe(new Date(Date.parse(NOW) + DEBOUNCE * 4).toISOString());
    expect(h.repo.complete).not.toHaveBeenCalled();
  });
});

// Input-size caps (2026-07-20 cost-control slice): tiered per-MESSAGE char caps
// keyed off the cursor (unprocessed = generous, already-seen = tight) plus a
// whole-window budget, so one long transcript/email cannot re-bill its full
// text on every subsequent run.
describe('transcript input caps', () => {
  const pad = (label: string, len: number): string => label + 'x'.repeat(len - label.length);

  it('a NEW (post-cursor) long sms is clamped to NEW_MESSAGE_CHAR_CAP head+tail with a marker', async () => {
    const body = 'H'.repeat(20_000) + 'M'.repeat(15_000) + 'T'.repeat(10_000); // 45k
    const m = msg(1, 'inbound', body);
    const h = makeHarness({
      dueRows: [dueRow()], // no cursor -> everything is unprocessed (tier 1)
      messages: [m],
      contact: tenantContact(),
      conversation: convWith('c1'),
    });

    await runDueExtractions(NOW, h.deps);

    expect(h.seen).toHaveLength(1);
    const text = h.seen[0]!.transcript[0]!.text;
    expect(text.length).toBeLessThanOrEqual(NEW_MESSAGE_CHAR_CAP);
    expect(text).toContain(TRUNCATION_MARKER);
    expect(text.startsWith('H'.repeat(100))).toBe(true);
    expect(text.endsWith('T'.repeat(100))).toBe(true);
  });

  it('a NEW sms under the cap passes through untouched', async () => {
    const body = 'A'.repeat(25_000);
    const h = makeHarness({
      dueRows: [dueRow()],
      messages: [msg(1, 'inbound', body)],
      contact: tenantContact(),
      conversation: convWith('c1'),
    });

    await runDueExtractions(NOW, h.deps);

    expect(h.seen[0]!.transcript[0]!.text).toBe(body);
  });

  it('an already-processed (at/below cursor) long sms is clamped to SEEN_MESSAGE_CHAR_CAP', async () => {
    const old = msg(1, 'inbound', 'H'.repeat(6_000) + 'T'.repeat(4_000)); // 10k, seen
    const fresh = msg(2, 'inbound', 'new short message');
    const h = makeHarness({
      dueRows: [dueRow({ cursor: old.tsMsgId })],
      messages: [fresh, old], // listByConversation returns newest-first
      contact: tenantContact(),
      conversation: convWith('c1'),
    });

    await runDueExtractions(NOW, h.deps);

    expect(h.seen).toHaveLength(1);
    const [oldUtt, freshUtt] = h.seen[0]!.transcript;
    expect(oldUtt!.text.length).toBeLessThanOrEqual(SEEN_MESSAGE_CHAR_CAP);
    expect(oldUtt!.text).toContain(TRUNCATION_MARKER);
    expect(oldUtt!.text.startsWith('H'.repeat(50))).toBe(true);
    expect(oldUtt!.text.endsWith('T'.repeat(50))).toBe(true);
    expect(freshUtt!.text).toBe('new short message'); // tier 1, untouched
  });

  it('an already-processed call transcript clamps at LINE granularity, keeping attribution', async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 60; i += 1) {
      const role = i % 2 === 1 ? 'Staff' : 'Client';
      lines.push(`${role}: ${pad(`line-${i} `, 90)}`);
    }
    const call = callMsg(1, 'inbound', lines.join('\n'), 'completed'); // ~5.9k chars of text
    const fresh = msg(2, 'inbound', 'hello again');
    const h = makeHarness({
      dueRows: [dueRow({ cursor: call.tsMsgId })],
      messages: [fresh, call],
      contact: tenantContact(),
      conversation: convWith('c1'),
    });

    await runDueExtractions(NOW, h.deps);

    const callUtts = h.seen[0]!.transcript.filter((u) => u.channel === 'voice');
    const total = callUtts.reduce((n, u) => n + u.text.length, 0);
    expect(total).toBeLessThanOrEqual(SEEN_MESSAGE_CHAR_CAP);
    expect(callUtts.length).toBeGreaterThan(2); // line granularity, not one blob
    // Head kept from the start, tail kept from the end, middle dropped.
    expect(callUtts[0]!.text).toContain('line-1 ');
    expect(callUtts[callUtts.length - 1]!.text).toContain('line-60');
    // Attribution survives: every kept line still parsed to a known speaker.
    expect(callUtts.every((u) => u.speaker === 'staff' || u.speaker === 'client')).toBe(true);
    // Exactly one marker.
    expect(callUtts.filter((u) => u.text.includes(TRUNCATION_MARKER))).toHaveLength(1);
  });

  it('the whole-window budget drops the OLDEST messages beyond WINDOW_CHAR_BUDGET', async () => {
    const olds: MessageItem[] = [];
    for (let i = 1; i <= 35; i += 1) {
      olds.push(msg(i, 'inbound', pad(`B${i} `, 2_000))); // exactly at the seen-cap, no clamp
    }
    const newest = msg(36, 'inbound', 'hi');
    const h = makeHarness({
      dueRows: [dueRow({ cursor: olds[olds.length - 1]!.tsMsgId })],
      messages: [newest, ...[...olds].reverse()], // newest-first
      contact: tenantContact(),
      conversation: convWith('c1'),
    });

    await runDueExtractions(NOW, h.deps);

    const transcript = h.seen[0]!.transcript;
    // Newest-first fill: 'hi' (2) + 29 * 2000 = 58,002 fits; the 30th old would
    // exceed 60,000 -> the oldest 6 messages drop.
    expect(transcript).toHaveLength(30);
    expect(transcript[0]!.text.startsWith('B7 ')).toBe(true); // chronological, oldest kept = B7
    expect(transcript[transcript.length - 1]!.text).toBe('hi');
  });
});

describe('runDueExtractions - the run log envelope', () => {
  const WROTE_PETS = 'EXTRACT:{"fields":{"pets":{"op":"write","value":"two cats","reason":"said so"}}}';

  it('writes EXACTLY ONE record per run on the success path', async () => {
    const h = makeHarness({ dueRows: [dueRow()], messages: [msg(10, 'inbound', WROTE_PETS)], contact: tenantContact(), conversation: convWith('c1') });
    await runDueExtractions(NOW, h.deps);
    expect(h.aiRuns.putRun).toHaveBeenCalledTimes(1);
    expect(h.runs[0]).toMatchObject({ outcome: 'applied', trigger: 'sms', driver: 'fake' });
    expect(h.runs[0]!.decisions['pets']).toMatchObject({ outcome: 'wrote', verdict: 'auto_applied' });
  });

  it('stamps REAL WALL-CLOCK timestamps from now(), never the simulated poll clock', async () => {
    const h = makeHarness({ dueRows: [dueRow()], messages: [msg(10, 'inbound', WROTE_PETS)], contact: tenantContact(), conversation: convWith('c1') });
    await runDueExtractions(NOW, h.deps);
    expect(h.runs[0]!.startedAt).toBe(WALL_NOW);
    expect(h.runs[0]!.startedAt).not.toBe(NOW);
    expect(h.runs[0]!.finishedAt).toBe(WALL_NOW);
    expect(h.runs[0]!.durationMs).toBe(0);
  });

  it('records a run of pure DROPS as no_op, not applied', async () => {
    const h = makeHarness({
      dueRows: [dueRow()],
      messages: [msg(10, 'inbound', 'EXTRACT:{"fields":{"voucherSize":{"op":"write","value":"2"}}}')],
      contact: unknownContact(), conversation: convWith('c1'),
    });
    await runDueExtractions(NOW, h.deps);
    expect(h.runs[0]!.outcome).toBe('no_op');
    expect(h.runs[0]!.decisions['voucherSize']).toMatchObject({ outcome: 'dropped', dropReason: 'wrong_contact_type', verdict: 'not_presented' });
  });

  it('records a no_new_client SKIP with a LIGHT window - ids and cursor, no bytes', async () => {
    const seen = msg(10, 'inbound', 'older');
    const h = makeHarness({ dueRows: [dueRow({ cursor: seen.tsMsgId })], messages: [seen], contact: tenantContact(), conversation: convWith('c1') });
    await runDueExtractions(NOW, h.deps);
    const w = h.runs[0]!.window!;
    expect(h.runs[0]).toMatchObject({ outcome: 'skipped', skipReason: 'no_new_client' });
    expect(w.detail).toBe('light');
    expect(w.cursor).toBe(seen.tsMsgId);
    expect(w.messages.map((m) => m.tsMsgId)).toEqual([seen.tsMsgId]);
    expect(w.messages[0]!.hash).toBeUndefined();
    expect(w.messages[0]!.chars).toBeUndefined();
    expect(w.windowParams).toBeUndefined();
    expect(h.runs[0]!.decisions).toEqual({});
    expect(h.seen).toHaveLength(0);
  });

  it('records a FULL window - hashes, caps, params - once the model is called', async () => {
    const sms = msg(10, 'inbound', WROTE_PETS);
    const h = makeHarness({ dueRows: [dueRow()], messages: [sms], contact: tenantContact(), conversation: convWith('c1') });
    await runDueExtractions(NOW, h.deps);
    const w = h.runs[0]!.window!;
    expect(w.detail).toBe('full');
    expect(w.windowParams).toBeDefined();
    expect(w.messages[0]).toMatchObject({ tsMsgId: sms.tsMsgId, tier: 'new', truncated: false });
    expect(w.messages[0]!.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(w.totalChars).toBeGreaterThan(0);
  });

  it('records no_contact and ineligible_type with NO window (they exit before the fetch)', async () => {
    const noContact = makeHarness({ dueRows: [dueRow()], conversation: convWith('c1'), contact: undefined });
    await runDueExtractions(NOW, noContact.deps);
    expect(noContact.runs[0]).toMatchObject({ outcome: 'skipped', skipReason: 'no_contact' });
    expect(noContact.runs[0]!.window).toBeUndefined();
    const landlord = makeHarness({ dueRows: [dueRow()], conversation: convWith('c1'), contact: landlordContact() });
    await runDueExtractions(NOW, landlord.deps);
    expect(landlord.runs[0]).toMatchObject({ outcome: 'skipped', skipReason: 'ineligible_type' });
    expect(landlord.runs[0]!.window).toBeUndefined();
  });

  it('records empty_window when nothing survived the cutoffs', async () => {
    const h = makeHarness({ dueRows: [dueRow({ channel: 'voice' })], messages: [], contact: tenantContact(), conversation: convWith('c1') });
    await runDueExtractions(NOW, h.deps);
    expect(h.runs[0]).toMatchObject({ outcome: 'skipped', skipReason: 'empty_window' });
    expect(h.runs[0]!.window!.detail).toBe('light');
  });

  it('records NOTHING for a lost claim - the sliding debounce is not a run', async () => {
    const h = makeHarness({ dueRows: [dueRow()], claimResult: false, contact: tenantContact(), conversation: convWith('c1') });
    await runDueExtractions(NOW, h.deps);
    expect(h.aiRuns.putRun).not.toHaveBeenCalled();
  });

  it('names the failing stage: refusal / parse / driver, and still records window + decisions', async () => {
    for (const failure of ['refusal', 'parse', 'driver'] as const) {
      const h = makeHarness({
        dueRows: [dueRow()], messages: [msg(10, 'inbound', 'hello')], contact: tenantContact(), conversation: convWith('c1'),
        driver: { kind: 'fake', extract: async () => ({ ok: false, meta: { driver: 'fake', rawText: '{broken' }, failure, message: `${failure} boom` }) },
      });
      await runDueExtractions(NOW, h.deps);
      expect(h.runs[0]).toMatchObject({ outcome: 'failed', error: { kind: failure } });
      expect(h.runs[0]!.window!.detail).toBe('full');
      expect(Object.keys(h.runs[0]!.decisions)).toHaveLength(12);
      expect(h.runs[0]!.rawText).toBe('{broken');
    }
  });

  it('names error.kind repo when a WRAPPED repository read throws', async () => {
    const h = makeHarness({ dueRows: [dueRow()], contact: tenantContact(), conversation: convWith('c1') });
    (h.deps.messages.listByConversation as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ddb down'));
    const out = await runDueExtractions(NOW, h.deps);
    expect(out).toEqual({ processed: 0, failed: 1 });
    expect(h.runs[0]).toMatchObject({ outcome: 'failed', error: { kind: 'repo', message: 'ddb down' } });
    expect(h.runs[0]!.window).toBeUndefined();
  });

  it('a SKIP-path complete() throw is failed/complete, keeps the skipReason, and still calls repo.fail', async () => {
    const seen = msg(10, 'inbound', 'older');
    const h = makeHarness({ dueRows: [dueRow({ cursor: seen.tsMsgId })], messages: [seen], contact: tenantContact(), conversation: convWith('c1') });
    (h.repo.complete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('complete boom'));
    const out = await runDueExtractions(NOW, h.deps);
    expect(out).toEqual({ processed: 0, failed: 1 });
    expect(h.repo.fail).toHaveBeenCalledTimes(1);
    expect(h.runs[0]).toMatchObject({ outcome: 'failed', skipReason: 'no_new_client', error: { kind: 'complete' } });
  });

  it('a SUCCESS-path complete() throw still records the run that mutated the contact', async () => {
    const h = makeHarness({ dueRows: [dueRow()], messages: [msg(10, 'inbound', WROTE_PETS)], contact: tenantContact(), conversation: convWith('c1') });
    (h.repo.complete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('complete boom'));
    await runDueExtractions(NOW, h.deps);
    expect(h.aiRuns.putRun).toHaveBeenCalledTimes(1);
    expect(h.runs[0]).toMatchObject({ outcome: 'failed', error: { kind: 'complete' } });
    expect(h.runs[0]!.decisions['pets']).toMatchObject({ outcome: 'wrote' });
  });

  it('stamps attempts and parked onto error - only runDueExtractions knows them', async () => {
    const h = makeHarness({
      dueRows: [dueRow({ attempts: 4 })], messages: [msg(10, 'inbound', 'hello')], contact: tenantContact(), conversation: convWith('c1'),
      driver: { kind: 'fake', extract: async () => ({ ok: false, meta: { driver: 'fake' }, failure: 'driver', message: 'boom' }) },
    });
    await runDueExtractions(NOW, h.deps);
    expect(h.runs[0]!.error).toEqual({ kind: 'driver', message: 'boom', attempts: 4, parked: true });
  });

  it('records driver, model, usage and promptFingerprint from the call meta', async () => {
    const h = makeHarness({
      dueRows: [dueRow()], messages: [msg(10, 'inbound', 'hello')], contact: tenantContact(), conversation: convWith('c1'),
      driver: { kind: 'anthropic', extract: async () => ({ ok: true, meta: { driver: 'anthropic', model: 'claude-opus-4-8', rawText: '{"fields":{}}', usage: { inputTokens: 100, outputTokens: 20 }, promptFingerprint: 'abc123def456' }, result: { fields: {} } }) },
    });
    await runDueExtractions(NOW, h.deps);
    expect(h.runs[0]).toMatchObject({ driver: 'anthropic', model: 'claude-opus-4-8', usage: { inputTokens: 100, outputTokens: 20 }, promptFingerprint: 'abc123def456', rawText: '{"fields":{}}' });
  });

  it('records profileFieldsPopulated - names only, never a profile snapshot', async () => {
    const h = makeHarness({ dueRows: [dueRow()], messages: [msg(10, 'inbound', 'hello')], contact: tenantContactWith({ firstName: 'Ann', voucherSize: 2 }), conversation: convWith('c1') });
    await runDueExtractions(NOW, h.deps);
    const fields = h.runs[0]!.profileFieldsPopulated!;
    expect(fields).toContain('firstName');
    expect(fields).toContain('voucherSize');
    expect(fields.join(',')).not.toContain('Ann');
  });
});

describe('runDueExtractions - run log backstop and isolation', () => {
  it('the BACKSTOP genuinely executes and writes the SAME draft, never a fresh one', async () => {
    const h = makeHarness({
      dueRows: [dueRow()],
      messages: [msg(10, 'inbound', 'EXTRACT:{"fields":{"pets":{"op":"suggest","value":"two cats"}}}')],
      contact: tenantContactWith({ pets: 'a dog' }), conversation: convWith('c1'),
    });
    h.applyEvents.emit.mockImplementationOnce(() => { throw new TypeError('unexpected defect in the event bus'); });
    const out = await runDueExtractions(NOW, h.deps);
    expect(out).toEqual({ processed: 0, failed: 1 });
    expect(h.aiRuns.putRun).toHaveBeenCalledTimes(1);
    expect(h.runs[0]!.error).toMatchObject({ kind: 'repo', message: /unexpected defect/ });
    expect(h.repo.complete).not.toHaveBeenCalled();
    const stamped = (h.repo.putSuggestion as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { runId?: string };
    expect(stamped.runId).toBeDefined();
    expect(h.runs[0]!.runId).toBe(stamped.runId);
    expect(h.runs[0]!.window!.detail).toBe('full');
    expect(h.runs[0]!.rawText).toContain('two cats');
    expect(h.runs[0]!.decisions).toEqual({});
    expect(h.repo.fail).toHaveBeenCalledTimes(1);
  });

  it('an UNWRAPPED throw on one row never aborts the rest of the batch', async () => {
    const h = makeHarness({
      dueRows: [dueRow({ conversationId: 'conv1' }), dueRow({ conversationId: 'conv2' })],
      messages: [msg(10, 'inbound', 'EXTRACT:{"fields":{"pets":{"op":"suggest","value":"two cats"}}}')],
      contact: tenantContactWith({ pets: 'a dog' }), conversation: convWith('c1'),
    });
    h.applyEvents.emit.mockImplementationOnce(() => { throw new TypeError('unexpected defect in the event bus'); });
    const out = await runDueExtractions(NOW, h.deps);
    expect(out.failed).toBe(1);
    expect(out.processed).toBe(1);
    expect(h.aiRuns.putRun).toHaveBeenCalledTimes(2);
  });

  it('a throwing run-log write leaves the extraction outcome, cursor and attempts untouched', async () => {
    const h = makeHarness({
      dueRows: [dueRow()],
      messages: [msg(10, 'inbound', 'EXTRACT:{"fields":{"pets":{"op":"write","value":"two cats"}}}')],
      contact: tenantContact(), conversation: convWith('c1'),
      aiRuns: { putRun: vi.fn(async () => { throw new Error('ai_runs is on fire'); }), setVerdict: vi.fn(async () => true) },
    });
    const out = await runDueExtractions(NOW, h.deps);
    expect(out).toEqual({ processed: 1, failed: 0 });
    expect(h.repo.complete).toHaveBeenCalledTimes(1);
    expect(h.repo.fail).not.toHaveBeenCalled();
    expect(h.contactsUpdate).toHaveBeenCalled();
  });

  it('PII GUARD: no run-path error object ever carries rawText or a decision value', async () => {
    const capture = createLogCapture();
    const h = makeHarness({
      dueRows: [dueRow()],
      messages: [msg(10, 'inbound', 'EXTRACT:{"fields":{"pets":{"op":"write","value":"SECRETVALUE"}}}')],
      contact: tenantContact(), conversation: convWith('c1'),
      logger: createLogger({ destination: capture.stream, level: 'debug' }),
    });
    (h.repo.complete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('complete boom'));
    await runDueExtractions(NOW, h.deps);
    const logged = JSON.stringify(capture.lines);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged).toContain('extraction poll: row failed');
    expect(logged).not.toContain('SECRETVALUE');
    expect(logged).not.toContain('EXTRACT:');
    expect(JSON.stringify(h.runs[0])).toContain('SECRETVALUE');
  });
});
