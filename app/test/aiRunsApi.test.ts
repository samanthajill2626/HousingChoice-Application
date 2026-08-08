// Admin-only AI run-log API contract (design 2026-08-06 section 9).
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { TEST_ADMIN_COOKIE, TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';
import type { AiRunRecord, AiRunsRepo } from '../src/repos/aiRunsRepo.js';
import type { MessageItem } from '../src/repos/messagesRepo.js';
import type { RunWindow, RunWindowMessage } from '../src/services/extraction/runTypes.js';

const admin = (app: ReturnType<typeof makeWebhookHarness>['app'], path: string) =>
  request(app).get(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_ADMIN_COOKIE);
const va = (app: ReturnType<typeof makeWebhookHarness>['app'], path: string) =>
  request(app).get(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

type FullRunOptions = Partial<AiRunRecord> & { windowMessages?: Partial<RunWindowMessage>[] };

function fullRun(options: FullRunOptions = {}): AiRunRecord {
  const { windowMessages, ...overrides } = options;
  const defaultWindow: RunWindow = {
    detail: 'full',
    cursor: '2026-08-06T10:00:00.000Z#msg-1',
    windowCappedAtLimit: false,
    windowParams: {
      newMessageCharCap: 30_000,
      seenMessageCharCap: 30_000,
      windowCharBudget: 60_000,
      maxTranscriptMessages: 50,
      maxTranscriptAgeDays: 30,
      truncationMarker: '...[truncated]',
    },
    messages: (windowMessages ?? [{ tsMsgId: 'a#1' }]).map((message) => ({
      tsMsgId: 'a#1',
      type: 'sms',
      direction: 'inbound',
      tier: 'new',
      chars: 16,
      hash: 'deadbeef',
      ...message,
    })),
    excluded: [],
  };
  return {
    itemId: 'run#run-1',
    runId: 'run-1',
    startedAt: '2026-08-06T10:00:00.000Z',
    finishedAt: '2026-08-06T10:00:01.000Z',
    durationMs: 1_000,
    conversationId: 'conv-1',
    contactId: 'contact-1',
    trigger: 'sms',
    outcome: 'applied',
    driver: 'fake',
    model: 'fake-model',
    decisions: {},
    notedLines: 0,
    expires_at: 0,
    window: Object.hasOwn(overrides, 'window') ? overrides.window : defaultWindow,
    ...overrides,
  };
}

function makeWorld(options: {
  runs?: AiRunRecord[];
  expiredRunIds?: string[];
  storedMessages?: Record<string, Partial<MessageItem>>;
  nextBefore?: string;
} = {}) {
  const runs = options.runs ?? [fullRun()];
  const expired = new Set(options.expiredRunIds ?? []);
  const repo = {
    putRun: vi.fn<AiRunsRepo['putRun']>(),
    getRun: vi.fn<AiRunsRepo['getRun']>(async (runId) => runs.find((run) => run.runId === runId)),
    listByEntity: vi.fn<AiRunsRepo['listByEntity']>(async () => ({
      entries: runs.map((run) =>
        expired.has(run.runId)
          ? { runId: run.runId, sortKey: `${run.startedAt}#${run.runId}`, expired: true as const }
          : { runId: run.runId, sortKey: `${run.startedAt}#${run.runId}`, expired: false as const, run },
      ),
      ...(options.nextBefore !== undefined && { nextBefore: options.nextBefore }),
    })),
    setVerdict: vi.fn<AiRunsRepo['setVerdict']>(),
  } satisfies AiRunsRepo;
  const world = createFakeWorld();
  world.aiRuns = repo;
  const messages = vi.fn(async (_conversationId: string, ids: string[]) =>
    new Map(
      ids.flatMap((id) => {
        const stored = options.storedMessages?.[id];
        return stored === undefined ? [] : [[id, { tsMsgId: id, ...stored } as MessageItem] as const];
      }),
    ),
  );
  vi.spyOn(world.messagesRepo, 'getManyByTsMsgIds').mockImplementation(messages);
  const { app } = makeWebhookHarness({ world });
  return { app, repo, messages };
}

describe('GET /api/ai-runs', () => {
  it('403s a VA - client-side guarding alone is not authorization', async () => {
    const { app } = makeWorld();
    await va(app, '/api/ai-runs').expect(403);
  });

  it('defaults to the global scope, newest-first, page size 25', async () => {
    const { app, repo } = makeWorld();
    await admin(app, '/api/ai-runs').expect(200);
    expect(repo.listByEntity).toHaveBeenCalledWith('global', expect.objectContaining({ limit: 25 }));
  });

  it('accepts the four scope forms and rejects anything else', async () => {
    const { app } = makeWorld();
    for (const scope of ['global', 'outcome#applied', 'conversations#conv-1', 'contacts#c1']) {
      await admin(app, `/api/ai-runs?scope=${encodeURIComponent(scope)}`).expect(200);
    }
    for (const bad of ['units#u1', 'outcome#nonsense', 'contacts#', 'DROP TABLE', 'global#x']) {
      await admin(app, `/api/ai-runs?scope=${encodeURIComponent(bad)}`).expect(400);
    }
  });

  it('passes before/from/to through, caps limit at 100, and preserves a next pointer', async () => {
    const { app, repo } = makeWorld({ nextBefore: '2026-08-05T10:00:00.000Z#run-8' });
    const res = await admin(
      app,
      '/api/ai-runs?before=2026-08-06T10:00:00.000Z%23run-9&from=2026-08-01&to=2026-08-07&limit=500',
    ).expect(200);
    expect(repo.listByEntity).toHaveBeenCalledWith('global', {
      before: '2026-08-06T10:00:00.000Z#run-9', from: '2026-08-01', to: '2026-08-07', limit: 100,
    });
    expect(res.body.nextBefore).toBe('2026-08-05T10:00:00.000Z#run-8');
  });

  it('projects a summary row, never raw text or decision values', async () => {
    const { app } = makeWorld({
      runs: [fullRun({
        rawText: 'SECRET',
        decisions: { pets: { proposedOp: 'write', proposedValue: 'SECRET', outcome: 'wrote', verdict: 'auto_applied' } },
      })],
    });
    const res = await admin(app, '/api/ai-runs').expect(200);
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
    expect(res.body.runs[0].decisionCounts).toEqual({
      wrote: 1, suggested: 0, dropped: 0, no_finding: 0, not_addressed: 0, pending: 0,
    });
  });

  it('renders a TTLd pointer as an expired row rather than erroring', async () => {
    const { app } = makeWorld({ expiredRunIds: ['run-1'] });
    const res = await admin(app, '/api/ai-runs').expect(200);
    expect(res.body.runs).toEqual([expect.objectContaining({ runId: 'run-1', expired: true })]);
  });
});

describe('GET /api/ai-runs/:runId', () => {
  it('403s a VA', async () => {
    const { app } = makeWorld();
    await va(app, '/api/ai-runs/run-1').expect(403);
  });

  it('404s an unknown or already-TTLd run', async () => {
    const { app } = makeWorld();
    await admin(app, '/api/ai-runs/nope').expect(404);
  });

  it('returns exactly the two-key envelope and does not mutate the stored run', async () => {
    const { app } = makeWorld({
      runs: [fullRun({ rawText: '{"fields":{}}', windowMessages: [{ tsMsgId: 'a#1' }] })],
      storedMessages: { 'a#1': { type: 'sms', body: 'the real message' } },
    });
    const res = await admin(app, '/api/ai-runs/run-1').expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['run', 'window']);
    expect(Object.keys(res.body.window)).toEqual(['messages']);
    expect(res.body.run.window.messages[0].text).toBeUndefined();
    expect(res.body.run.window.messages[0].available).toBeUndefined();
    expect(res.body.window.messages[0]).toMatchObject({ tsMsgId: 'a#1', available: true, text: 'the real message' });
    expect(res.body.window.messages[0].hash).toBe(res.body.run.window.messages[0].hash);
  });

  it('returns the complete record including raw text and decision values to an admin', async () => {
    const { app } = makeWorld({
      runs: [fullRun({ rawText: '{"fields":{}}', decisions: { pets: { proposedOp: 'write', proposedValue: 'cat', outcome: 'wrote', verdict: 'auto_applied' } } })],
    });
    const res = await admin(app, '/api/ai-runs/run-1').expect(200);
    expect(res.body.run.rawText).toBe('{"fields":{}}');
    expect(res.body.run.decisions.pets.proposedValue).toBe('cat');
  });

  it('rehydrates the whole window in one batched read', async () => {
    const { app, messages } = makeWorld({
      runs: [fullRun({ windowMessages: [{ tsMsgId: 'a#1' }, { tsMsgId: 'b#1' }] })],
      storedMessages: { 'a#1': { type: 'sms', body: 'first' }, 'b#1': { type: 'sms', body: 'second' } },
    });
    const res = await admin(app, '/api/ai-runs/run-1').expect(200);
    expect(messages).toHaveBeenCalledTimes(1);
    expect(messages).toHaveBeenCalledWith('conv-1', ['a#1', 'b#1']);
    expect(res.body.window.messages[0]).toMatchObject({ available: true, text: 'first' });
  });

  it('reads call text from transcript and leaves deleted messages unavailable', async () => {
    const { app } = makeWorld({
      runs: [fullRun({ windowMessages: [{ tsMsgId: 'call#1', type: 'call' }, { tsMsgId: 'gone#1' }] })],
      storedMessages: { 'call#1': { type: 'call', transcript: 'Client: I need a 2 bedroom' } as MessageItem },
    });
    const res = await admin(app, '/api/ai-runs/run-1').expect(200);
    expect(res.body.window.messages[0]).toMatchObject({ available: true, text: 'Client: I need a 2 bedroom' });
    expect(res.body.window.messages[1]).toMatchObject({ available: false });
    expect(res.body.window.messages[1].text).toBeUndefined();
    expect(res.body.window.messages[1].hash).toBeDefined();
    expect(res.body.window.messages[1].chars).toBeDefined();
  });

  it('degrades the whole window when the batch read throws', async () => {
    const { app, messages } = makeWorld();
    messages.mockRejectedValueOnce(new Error('ddb down'));
    const res = await admin(app, '/api/ai-runs/run-1').expect(200);
    expect(res.body.window.messages[0]).toMatchObject({ available: false });
  });

  it('returns an empty window block for a run that never computed one', async () => {
    const { app } = makeWorld({ runs: [fullRun({ window: undefined })] });
    const res = await admin(app, '/api/ai-runs/run-1').expect(200);
    expect(res.body.window).toEqual({ messages: [] });
  });
});
