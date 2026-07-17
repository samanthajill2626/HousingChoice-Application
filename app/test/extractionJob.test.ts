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
  runDueExtractions,
  type ExtractionJobDeps,
} from '../src/jobs/extraction.js';
import type { DueExtractionItem, ExtractionRepo, SuggestionItem } from '../src/repos/extractionRepo.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { MessageItem } from '../src/repos/messagesRepo.js';
import { FakeExtractionDriver } from '../src/adapters/extractionFake.js';
import {
  ExtractionRefusedError,
  type ExtractionDriver,
  type ExtractionInput,
} from '../src/adapters/extraction.js';
import type { ApplyDeps } from '../src/services/extraction/apply.js';
import type { Logger } from '../src/lib/logger.js';

const NOW = '2026-07-17T00:00:00.000Z';
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

function tenantContact(): ContactItem {
  return { contactId: 'c1', type: 'tenant', status: 'onboarding', phone: '+15551230001' } as ContactItem;
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
    async (s: Parameters<ExtractionRepo['putSuggestion']>[0]): Promise<SuggestionItem> => ({
      ...s,
      itemId: `sugg#${s.ownerContactId}#${s.target}`,
      _pendingPartition: 'pending',
      createdAt: NOW,
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
  } satisfies ExtractionRepo;
}

interface Harness {
  deps: ExtractionJobDeps;
  repo: ExtractionRepo;
  seen: ExtractionInput[];
  contactsUpdate: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: {
  dueRows: DueExtractionItem[];
  messages?: MessageItem[];
  contact?: ContactItem | undefined;
  conversation?: ConversationItem | undefined;
  claimResult?: boolean;
  driver?: ExtractionDriver;
}): Harness {
  const repo = makeRepo(opts.dueRows, opts.claimResult ?? true);
  const seen: ExtractionInput[] = [];
  const fake = new FakeExtractionDriver();
  const driver: ExtractionDriver =
    opts.driver ??
    ({
      kind: 'fake',
      extract: async (input: ExtractionInput) => {
        seen.push(input);
        return fake.extract(input);
      },
    } as ExtractionDriver);

  const contactsUpdate = vi.fn(async () => ({}) as ContactItem);
  const contacts = {
    getById: vi.fn(async () => opts.contact),
    findByPhone: vi.fn(async () => undefined),
    update: contactsUpdate,
    addPhone: vi.fn(async () => ({}) as ContactItem),
  };

  const applyDeps: ApplyDeps = {
    contacts,
    extraction: repo,
    audit: { append: vi.fn(async () => undefined) },
    events: { emit: vi.fn() },
    logger: silentLogger,
    now: () => NOW,
  };

  const deps: ExtractionJobDeps = {
    repo,
    conversations: { getById: vi.fn(async () => opts.conversation) },
    messages: { listByConversation: vi.fn(async () => opts.messages ?? []) },
    contacts,
    driver,
    applyDeps,
    config: { aiExtractionDebounceMs: DEBOUNCE },
    logger: silentLogger,
  };

  return { deps, repo, seen, contactsUpdate };
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

  it('driver throw: fails with a doubled nextDueAt (exponential backoff)', async () => {
    const throwing = {
      kind: 'fake',
      extract: async () => {
        throw new Error('driver boom');
      },
    } as unknown as ExtractionDriver;
    const h = makeHarness({
      dueRows: [dueRow({ attempts: 1 })], // 2^1 = doubled backoff
      messages: [msg(1, 'inbound', 'EXTRACT:{"fields":{"pets":{"op":"write","value":"yes"}}}')],
      contact: tenantContact(),
      conversation: convWith('c1'),
      driver: throwing,
    });

    const out = await runDueExtractions(NOW, h.deps);

    expect(out).toEqual({ processed: 0, failed: 1 });
    // now + DEBOUNCE * 2^1 = now + 60s
    const expected = new Date(Date.parse(NOW) + DEBOUNCE * 2).toISOString();
    expect(h.repo.fail).toHaveBeenCalledWith('conv1', expect.stringContaining('driver boom'), expected);
    expect(h.repo.complete).not.toHaveBeenCalled();
  });

  it('final failure parks the item (nextDueAt null)', async () => {
    const throwing = {
      kind: 'fake',
      extract: async () => {
        throw new Error('still failing');
      },
    } as unknown as ExtractionDriver;
    const h = makeHarness({
      dueRows: [dueRow({ attempts: MAX_EXTRACTION_ATTEMPTS - 1 })], // attempts+1 >= MAX -> park
      messages: [msg(1, 'inbound', 'EXTRACT:{"fields":{"pets":{"op":"write","value":"yes"}}}')],
      contact: tenantContact(),
      conversation: convWith('c1'),
      driver: throwing,
    });

    const out = await runDueExtractions(NOW, h.deps);

    expect(out).toEqual({ processed: 0, failed: 1 });
    expect(h.repo.fail).toHaveBeenCalledWith('conv1', expect.any(String), null);
  });

  it('refusal error follows the failure path', async () => {
    const refusing = {
      kind: 'fake',
      extract: async () => {
        throw new ExtractionRefusedError('declined');
      },
    } as unknown as ExtractionDriver;
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
});
