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
    beginFinalization: vi.fn<AiRunsRepo['beginFinalization']>(),
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
  return { app, repo, messages, world };
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

  it('a fractional limit never reaches the repo as Limit 0', async () => {
    // Math.floor(0.5) is 0, and the repo's `opts.limit ?? DEFAULT` does NOT
    // replace 0 - so this used to reach DynamoDB as Limit: 0, which is a
    // ValidationException -> 500 + an ERROR log on a read-only forensic page.
    const { app, repo } = makeWorld();
    await admin(app, '/api/ai-runs?limit=0.5').expect(200);
    expect(repo.listByEntity).toHaveBeenCalledWith('global', expect.objectContaining({ limit: 25 }));
  });

  it('falls back to the DEFAULT page size for a zero or negative limit', async () => {
    // This used to assert `limit: 1`, pinning a regression rather than catching
    // it: flooring `?limit=0` and `?limit=-5` to 1 served a ONE-row page, which
    // is the exact defect the empty-string case below was fixed for. An
    // unusable page size falls back to the default; it is not honored at its
    // nearest legal value. Dropping the `n < 1` guard in parseLimit turns this
    // red.
    for (const raw of ['0', '-5']) {
      const { app, repo } = makeWorld();
      await admin(app, `/api/ai-runs?limit=${raw}`).expect(200);
      expect(repo.listByEntity).toHaveBeenCalledWith('global', expect.objectContaining({ limit: 25 }));
    }
  });

  it('treats an EMPTY or whitespace limit as absent, not as one row per page', async () => {
    // conf P2-3 / adv P2: Number('') and Number(' ') are both 0, which IS an
    // integer, so the clamp's floor of 1 turned a bookmarked `?limit=` into a
    // one-row page. The sibling optionalParam already treats an empty value as
    // absent for before/from/to; limit means the same thing by the same rule.
    for (const raw of ['', '%20']) {
      const { app, repo } = makeWorld();
      await admin(app, `/api/ai-runs?limit=${raw}`).expect(200);
      expect(repo.listByEntity).toHaveBeenCalledWith('global', expect.objectContaining({ limit: 25 }));
    }
  });

  it('falls back to the default page size for a REPEATED limit', async () => {
    // limit keeps the clamp philosophy: a shape it cannot read is the default,
    // never a 400 and never one row. Pinned so the date-filter 400s below are
    // not "simplified" into covering limit too.
    const { app, repo } = makeWorld();
    await admin(app, '/api/ai-runs?limit=5&limit=7').expect(200);
    expect(repo.listByEntity).toHaveBeenCalledWith('global', expect.objectContaining({ limit: 25 }));
  });

  it('rejects a REPEATED date filter by name instead of silently dropping it', async () => {
    // adv P2: Express hands a duplicated param back as an ARRAY, which fails
    // every `typeof === 'string'` shape check below - so the filter used to
    // vanish and the route answered 200 with the WHOLE table, reading as "these
    // are your 2026-01-01+ runs". On a forensic surface an over-broad page is
    // at least as misleading as the empty one these 400s exist to prevent.
    const { app, repo } = makeWorld();
    for (const [q, code] of [
      ['from=2026-01-01&from=2026-01-02', 'invalid_from'],
      ['to=2026-01-01&to=2026-01-02', 'invalid_to'],
      [
        'before=2026-08-06T10:00:00.000Z%23run-9&before=2026-08-05T10:00:00.000Z%23run-8',
        'invalid_before',
      ],
    ] as const) {
      const res = await admin(app, `/api/ai-runs?${q}`).expect(400);
      expect(res.body.error).toBe(code);
    }
    expect(repo.listByEntity).not.toHaveBeenCalled();
  });

  it('rejects a malformed date filter by name instead of answering an empty page', async () => {
    const { app, repo } = makeWorld();
    for (const [q, code] of [
      ['from=not-a-date', 'invalid_from'],
      ['to=2026-13-45', 'invalid_to'],
      ['before=2026-08-06T10:00:00.000Z', 'invalid_before'],
    ] as const) {
      const res = await admin(app, `/api/ai-runs?${q}`).expect(400);
      expect(res.body.error).toBe(code);
    }
    expect(repo.listByEntity).not.toHaveBeenCalled();
  });

  it('rejects a date that ROLLS OVER instead of letting it filter a range nobody asked for', async () => {
    // Date.parse is not calendar validation: it rejects an out-of-range MONTH
    // (2026-13-01 -> NaN) but silently rolls over an out-of-range DAY.
    // 2026-02-30 parses to 2026-03-02, and 2026-02-29 to 2026-03-01 because
    // 2026 is not a leap year - so an impossible bound used to reach DynamoDB
    // and answer a plausible page for a range the operator never asked for, on
    // the one surface where that is least acceptable. Reverting isCalendarDate
    // to the bare Date.parse check turns this red.
    const { app, repo } = makeWorld();
    for (const [q, code] of [
      ['from=2026-02-30', 'invalid_from'],
      ['to=2026-02-29', 'invalid_to'],
      ['from=2026-04-31', 'invalid_from'],
    ] as const) {
      const res = await admin(app, `/api/ai-runs?${q}`).expect(400);
      expect(res.body.error).toBe(code);
    }
    expect(repo.listByEntity).not.toHaveBeenCalled();
  });

  it('accepts a REAL leap day', async () => {
    // The round-trip guard must not over-reject: 2024 is a leap year, so
    // 2024-02-29 is a real date and has to survive.
    const { app, repo } = makeWorld();
    await admin(app, '/api/ai-runs?from=2024-02-29').expect(200);
    expect(repo.listByEntity).toHaveBeenCalledWith('global', expect.objectContaining({ from: '2024-02-29' }));
  });

  it('treats an EMPTY filter as no filter rather than a malformed one', async () => {
    const { app, repo } = makeWorld();
    await admin(app, '/api/ai-runs?from=&to=&before=').expect(200);
    const [, opts] = repo.listByEntity.mock.calls[0]!;
    expect(opts).toEqual({ limit: 25 });
  });

  it('accepts a REAL paging cursor handed back from a first page', async () => {
    // `before` is an opaque sort key `<ISO>#<runId>`, NOT a bare timestamp -
    // Date.parse() on it is NaN, so an ISO-shaped validator would 400 every
    // Load-more click.
    const { app, repo } = makeWorld({ nextBefore: '2026-08-05T10:00:00.000Z#run-8' });
    const first = await admin(app, '/api/ai-runs').expect(200);
    const cursor = first.body.nextBefore as string;
    await admin(app, `/api/ai-runs?before=${encodeURIComponent(cursor)}`).expect(200);
    expect(repo.listByEntity).toHaveBeenLastCalledWith(
      'global',
      expect.objectContaining({ before: cursor }),
    );
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

  it('adds the current contact display fields to every matching run in one de-duplicated batch', async () => {
    const { app, world } = makeWorld({
      runs: [
        fullRun({ runId: 'run-1' }),
        fullRun({ runId: 'run-2', itemId: 'run#run-2' }),
      ],
    });
    world.contacts.push({
      contactId: 'contact-1',
      type: 'tenant',
      firstName: 'Ada',
      lastName: 'Lovelace',
      phone: '+14040100007',
      phones: [
        { phone: '+14040100008', primary: false },
        { phone: '+14040100007', primary: true },
      ],
    });
    const getDisplaysByIds = vi.fn(async (contactIds: string[]) =>
      new Map(contactIds.flatMap((contactId) => {
        const contact = world.contacts.find((candidate) => candidate.contactId === contactId);
        return contact === undefined ? [] : [[contactId, contact] as const];
      })),
    );
    Object.assign(world.contactsRepo, { getDisplaysByIds });

    const res = await admin(app, '/api/ai-runs').expect(200);

    expect(getDisplaysByIds).toHaveBeenCalledOnce();
    expect(getDisplaysByIds).toHaveBeenCalledWith(['contact-1']);
    expect(res.body.runs.map((run: Record<string, unknown>) => run['contact'])).toEqual([
      { firstName: 'Ada', lastName: 'Lovelace', phone: '+14040100007' },
      { firstName: 'Ada', lastName: 'Lovelace', phone: '+14040100007' },
    ]);
  });

  it('resolves a contact scope label even when that scope has no runs', async () => {
    const { app, world } = makeWorld({ runs: [] });
    world.contacts.push({
      contactId: 'contact-empty',
      type: 'tenant',
      phone: '+14040100009',
    });
    Object.assign(world.contactsRepo, {
      getDisplaysByIds: async (contactIds: string[]) => new Map(contactIds.flatMap((contactId) => {
        const contact = world.contacts.find((candidate) => candidate.contactId === contactId);
        return contact === undefined ? [] : [[contactId, contact] as const];
      })),
    });

    const res = await admin(app, '/api/ai-runs?scope=contacts%23contact-empty').expect(200);

    expect(res.body.runs).toEqual([]);
    expect(res.body.scopeContact).toEqual({ phone: '+14040100009' });
  });

  it('keeps the run list usable when contact display enrichment fails', async () => {
    const { app, world } = makeWorld();
    Object.assign(world.contactsRepo, {
      getDisplaysByIds: async () => { throw new Error('contacts unavailable'); },
    });

    const res = await admin(app, '/api/ai-runs').expect(200);

    expect(res.body.runs[0]).toMatchObject({ contactId: 'contact-1' });
    expect(res.body.runs[0].contact).toBeUndefined();
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

  it('returns contact display fields alongside the run without mutating the stored record', async () => {
    const { app, world } = makeWorld({
      runs: [fullRun({ rawText: '{"fields":{}}', windowMessages: [{ tsMsgId: 'a#1' }] })],
      storedMessages: { 'a#1': { type: 'sms', body: 'the real message' } },
    });
    world.contacts.push({
      contactId: 'contact-1',
      type: 'tenant',
      firstName: 'Grace',
      lastName: 'Hopper',
      phone: '+14040100010',
    });
    const res = await admin(app, '/api/ai-runs/run-1').expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['contact', 'run', 'window']);
    expect(res.body.contact).toEqual({
      firstName: 'Grace',
      lastName: 'Hopper',
      phone: '+14040100010',
    });
    expect(Object.keys(res.body.window)).toEqual(['messages']);
    expect(res.body.run.window.messages[0].text).toBeUndefined();
    expect(res.body.run.window.messages[0].available).toBeUndefined();
    expect(res.body.window.messages[0]).toMatchObject({ tsMsgId: 'a#1', available: true, text: 'the real message' });
    expect(res.body.window.messages[0].hash).toBe(res.body.run.window.messages[0].hash);
  });

  it('keeps run detail usable when its contact display read fails', async () => {
    const { app, world } = makeWorld();
    vi.spyOn(world.contactsRepo, 'getDisplayById').mockRejectedValueOnce(new Error('contacts unavailable'));

    const res = await admin(app, '/api/ai-runs/run-1').expect(200);

    expect(res.body.run.runId).toBe('run-1');
    expect(res.body.contact).toBeUndefined();
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

  it('reports a mismatch when the rehydrated message no longer renders to the stored hash', async () => {
    const { app } = makeWorld({
      runs: [fullRun({ windowMessages: [{ tsMsgId: 'a#1', capChars: 30_000, hash: 'deadbeef' }] })],
      storedMessages: { 'a#1': { type: 'sms', direction: 'inbound', created_at: '2026-08-06T10:00:00.000Z', body: 'changed text' } },
    });
    const res = await admin(app, '/api/ai-runs/run-1').expect(200);
    expect(res.body.window.messages[0].hashStatus).toBe('mismatch');
  });

  it('marks a full row without stored hash evidence unavailable', async () => {
    const { app } = makeWorld({
      runs: [fullRun({ windowMessages: [{ tsMsgId: 'a#1', capChars: 30_000, hash: undefined }] })],
      storedMessages: { 'a#1': { type: 'sms', direction: 'inbound', created_at: '2026-08-06T10:00:00.000Z', body: 'text' } },
    });
    const res = await admin(app, '/api/ai-runs/run-1').expect(200);
    expect(res.body.window.messages[0].hashStatus).toBe('unavailable');
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
