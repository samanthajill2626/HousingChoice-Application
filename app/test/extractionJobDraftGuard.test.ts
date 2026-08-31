// F5: the run-log DRAFT ASSEMBLY is strictly best-effort.
//
// Design 2026-08-06 section 8: "The recorder is strictly best-effort: wrapped in
// try/catch, logged, swallowed. It must never fail an extraction run, re-arm a
// due row, or burn a retry attempt. Observability that can break what it
// observes is worse than none."
//
// Four unguarded builders sat on the extraction path (buildLightRunWindow on the
// pre-gate HOT path, buildFullRunWindow, and buildDecisions on both the failure
// arm and - worst - AFTER applyExtraction committed the contact write). A throw
// from any of them unwound into runDueExtractions' per-row backstop, which
// stamped outcome 'failed', called repo.fail(), burned an attempt and re-armed
// the row, so the next poll re-extracted the same window (a second billed model
// call) even though the run had already succeeded.
//
// These tests make each builder throw and assert the RUN is unaffected.
import { describe, expect, it, vi } from 'vitest';

const builders = vi.hoisted(() => ({ light: false, full: false, decisions: false }));

vi.mock('../src/services/extraction/runWindow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/extraction/runWindow.js')>();
  return {
    ...actual,
    buildLightRunWindow: (input: Parameters<typeof actual.buildLightRunWindow>[0]) => {
      if (builders.light) throw new Error('light window builder exploded');
      return actual.buildLightRunWindow(input);
    },
    buildFullRunWindow: (input: Parameters<typeof actual.buildFullRunWindow>[0]) => {
      if (builders.full) throw new Error('full window builder exploded');
      return actual.buildFullRunWindow(input);
    },
  };
});

vi.mock('../src/services/extraction/decisions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/extraction/decisions.js')>();
  return {
    ...actual,
    buildDecisions: (input: Parameters<typeof actual.buildDecisions>[0]) => {
      if (builders.decisions) throw new Error('decision builder exploded');
      return actual.buildDecisions(input);
    },
  };
});

const { runDueExtractions } = await import('../src/jobs/extraction.js');
import type { ExtractionJobDeps } from '../src/jobs/extraction.js';
import type { DueExtractionItem, ExtractionRepo, PutSuggestionResult } from '../src/repos/extractionRepo.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { MessageItem } from '../src/repos/messagesRepo.js';
import { FakeExtractionDriver } from '../src/adapters/extractionFake.js';
import type { ApplyDeps } from '../src/services/extraction/apply.js';
import type { Logger } from '../src/lib/logger.js';
import type { AiRunRecordInput } from '../src/repos/aiRunsRepo.js';

const NOW = '2026-07-17T00:00:00.000Z';
const WALL_NOW = '2026-07-17T09:30:00.000Z';
const DEBOUNCE = 30_000;

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

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

function makeRepo(dueRows: DueExtractionItem[]): ExtractionRepo {
  const put = vi.fn(
    async (s: Parameters<ExtractionRepo['putSuggestion']>[0]): Promise<PutSuggestionResult> => ({
      item: { ...s, itemId: `sugg#${s.ownerContactId}#${s.target}`, _pendingPartition: 'pending', createdAt: NOW },
    }),
  );
  return {
    scheduleExtraction: vi.fn(async () => {}),
    requestManualExtraction: vi.fn(async () => {}),
    listDue: vi.fn(async () => dueRows),
    claim: vi.fn(async () => true),
    complete: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    getDue: vi.fn(async () => undefined),
    putSuggestion: put,
    getSuggestion: vi.fn(async () => undefined),
    listSuggestionsByContact: vi.fn(async () => []),
    deleteSuggestion: vi.fn(async () => {}),
    deleteSuggestionIfCurrent: vi.fn(async () => true),
    deleteTypeSuggestionIfCurrentAtContactRevision: vi.fn(
      async () => 'suggestion_changed_or_absent' as const,
    ),
    restoreSuggestionIfAbsent: vi.fn(async () => true),
    listPending: vi.fn(async () => []),
    putDismissal: vi.fn(async () => {}),
    hasDismissal: vi.fn(async () => false),
  } satisfies ExtractionRepo;
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

function makeHarness(opts: { dueRows: DueExtractionItem[]; messages: MessageItem[] }) {
  const repo = makeRepo(opts.dueRows);
  const logger = makeLogger();
  const fake = new FakeExtractionDriver();
  const contactsUpdate = vi.fn(async () => ({}) as ContactItem);
  const runs: AiRunRecordInput[] = [];
  const contacts = {
    getById: vi.fn(async () => tenantContact()),
    findByPhone: vi.fn(async () => undefined),
    update: contactsUpdate,
    addPhone: vi.fn(async () => ({}) as ContactItem),
  };
  const applyDeps: ApplyDeps = {
    contacts,
    extraction: repo,
    audit: { append: vi.fn(async () => undefined) },
    events: { emit: vi.fn() },
    logger,
    now: () => NOW,
  };
  const deps: ExtractionJobDeps = {
    repo,
    aiRuns: {
      beginFinalization: vi.fn(async () => true),
      putRun: vi.fn(async (r: AiRunRecordInput) => {
        runs.push(r);
        return { ...r, itemId: `run#${r.runId}`, expires_at: 0 };
      }),
      setVerdict: vi.fn(async () => true),
    },
    events: { emit: vi.fn() },
    now: () => WALL_NOW,
    conversations: { getById: vi.fn(async () => convWith('c1')) },
    messages: { listByConversation: vi.fn(async () => opts.messages) },
    contacts,
    driver: { kind: 'fake', extract: async (input) => fake.extract(input) },
    applyDeps,
    config: { aiExtractionDebounceMs: DEBOUNCE },
    logger,
  };
  return { deps, repo, runs, logger, contactsUpdate };
}

describe('draft assembly is best-effort (F5)', () => {
  it('a throwing light window builder leaves a no_new_client SKIP a skip', async () => {
    // The hot path: buildLightRunWindow runs on EVERY poll of EVERY due row,
    // before the no-new-client gate. Unguarded, the single most common outcome
    // in the system turns into a failure that burns an attempt.
    builders.light = true;
    try {
      const messages = [msg(2, 'outbound', 'any pets?'), msg(1, 'outbound', 'hi there')];
      const h = makeHarness({ dueRows: [dueRow()], messages });

      const out = await runDueExtractions(NOW, h.deps);

      expect(out).toEqual({ processed: 0, failed: 0 });
      expect(h.repo.complete).toHaveBeenCalledWith('conv1', '', NOW);
      expect(h.repo.fail).not.toHaveBeenCalled();
      expect(h.runs).toHaveLength(1);
      expect(h.runs[0]!.outcome).toBe('skipped');
      expect(h.runs[0]!.skipReason).toBe('no_new_client');
      expect(h.runs[0]!.error).toBeUndefined();
      expect(h.runs[0]!.window).toBeUndefined();
    } finally {
      builders.light = false;
    }
  });

  it('a throwing full window builder still runs the model and applies the result', async () => {
    builders.full = true;
    try {
      const messages = [msg(3, 'inbound', 'EXTRACT:{"fields":{"pets":{"op":"write","value":"yes"}}}')];
      const h = makeHarness({ dueRows: [dueRow()], messages });

      const out = await runDueExtractions(NOW, h.deps);

      expect(out).toEqual({ processed: 1, failed: 0 });
      expect(h.contactsUpdate).toHaveBeenCalledWith('c1', expect.objectContaining({ pets: 'yes' }));
      expect(h.repo.complete).toHaveBeenCalledWith('conv1', messages[0]!.tsMsgId, NOW);
      expect(h.repo.fail).not.toHaveBeenCalled();
      expect(h.runs[0]!.outcome).toBe('applied');
      expect(h.runs[0]!.error).toBeUndefined();
      // The earlier LIGHT window survives - it built successfully from the same
      // data, and a run log that keeps it is strictly better than one that does
      // not. Only the failed FULL build is dropped; no partial window is stored.
      expect(h.runs[0]!.window?.detail).toBe('light');
    } finally {
      builders.full = false;
    }
  });

  it('a throwing decision builder AFTER the contact write never burns an attempt', async () => {
    // The worst site: applyExtraction has already committed. Unguarded, the
    // throw skipped repo.complete (cursor not advanced), the backstop stamped
    // outcome 'failed', repo.fail() burned an attempt and re-armed the row, and
    // the next poll re-billed the model for the same window.
    builders.decisions = true;
    try {
      const messages = [msg(3, 'inbound', 'EXTRACT:{"fields":{"pets":{"op":"write","value":"yes"}}}')];
      const h = makeHarness({ dueRows: [dueRow({ attempts: 2 })], messages });

      const out = await runDueExtractions(NOW, h.deps);

      expect(out).toEqual({ processed: 1, failed: 0 });
      expect(h.contactsUpdate).toHaveBeenCalledWith('c1', expect.objectContaining({ pets: 'yes' }));
      // Cursor ADVANCED, so the next poll does not re-extract the same window.
      expect(h.repo.complete).toHaveBeenCalledWith('conv1', messages[0]!.tsMsgId, NOW);
      expect(h.repo.fail).not.toHaveBeenCalled();
      expect(h.runs).toHaveLength(1);
      expect(h.runs[0]!.outcome).toBe('applied');
      expect(h.runs[0]!.error).toBeUndefined();
      // Degraded envelope: no decisions table, everything else intact.
      expect(h.runs[0]!.decisions).toEqual({});
      expect(h.runs[0]!.window?.detail).toBe('full');
      expect(h.runs[0]!.rawText).toBe('{"fields":{"pets":{"op":"write","value":"yes"}}}');
    } finally {
      builders.decisions = false;
    }
  });

  it('logs the degraded assembly with ids only - never a body, phone or value', async () => {
    builders.decisions = true;
    try {
      const messages = [msg(3, 'inbound', 'EXTRACT:{"fields":{"pets":{"op":"write","value":"yes"}}}')];
      const h = makeHarness({ dueRows: [dueRow()], messages });

      await runDueExtractions(NOW, h.deps);

      const warned = h.logger.warn.mock.calls.find(
        (call) => typeof call[1] === 'string' && call[1].includes('(best-effort)'),
      );
      expect(warned).toBeDefined();
      expect(Object.keys(warned![0] as Record<string, unknown>).sort()).toEqual(
        ['conversationId', 'err', 'runId'],
      );
    } finally {
      builders.decisions = false;
    }
  });
});
