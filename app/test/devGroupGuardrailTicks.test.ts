// The two `__dev` seams S8's e2e specs bind to (T6.3 / T6.4).
//
// These exist because of worklist A16: a hermetic e2e lane runs a REAL worker
// process beside the app, so (a) a guardrail line a spec asserts has to be
// produced APP-side to reach /__dev/logtail, and (b) the tick and that worker
// share the same cadence records, so the tick needs a bypass or specs race it.
//
// The contract pinned here is exactly what S8 will write against: the paths,
// `force` DEFAULTING TO TRUE, the optional `duties` narrowing with its 400, ISO
// normalization of `now`, and the direct staleness check's response shape.
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createDevRouter } from '../src/routes/dev.js';
import type { RunGroupGuardrailsDeps } from '../src/jobs/groupGuardrails.js';
import type { GroupSendStalenessService } from '../src/services/groupSendStaleness.js';

const SECRET = 'test-origin-secret';
const cfg = () =>
  loadConfig({ NODE_ENV: 'test', DEV_AUTH_ENABLED: '1', CF_ORIGIN_SECRET: SECRET });

/** Settings fake modelling claimGroupPeriod's real condition. */
function makeSettings() {
  const rows = new Map<string, string>();
  return {
    rows,
    async getGroupTimestamp(id: string) {
      return rows.get(id);
    },
    async claimGroupPeriod(id: string, at: string, notBefore: string) {
      const stored = rows.get(id);
      if (stored !== undefined && stored > notBefore) return false;
      rows.set(id, at);
      return true;
    },
  };
}

function guardrailDeps() {
  const sweeps = { crossCheck: 0, staleness: 0 };
  const deps: RunGroupGuardrailsDeps = {
    settingsRepo: makeSettings() as never,
    crossCheck: {
      async sweepCrossCheckDeadlines() {
        sweeps.crossCheck += 1;
        return { scanned: 1, alarms: [] };
      },
    },
    staleness: {
      async sweepSendStaleness() {
        sweeps.staleness += 1;
        return { scanned: 0, alarmed: 0, noReceipt: 0, cleared: 0 };
      },
    },
    conversationsRepo: {
      async listGroupTexts() {
        return { items: [], truncated: false };
      },
    } as never,
  };
  return { deps, sweeps };
}

function appWith(over: {
  groupGuardrailDeps?: RunGroupGuardrailsDeps;
  groupStaleness?: GroupSendStalenessService;
}) {
  const config = cfg();
  return buildApp({ config, devRouter: createDevRouter({ config, ...over }) });
}

describe('POST /__dev/group-guardrails/tick', () => {
  it('is absent (404) when the dev router is not mounted', async () => {
    const app = buildApp({ config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET }) });
    const res = await request(app)
      .post('/__dev/group-guardrails/tick')
      .set('x-origin-verify', SECRET)
      .send();
    expect(res.status).toBe(404);
  });

  it('runs all four duties and reports what ran', async () => {
    const { deps, sweeps } = guardrailDeps();
    const res = await request(appWith({ groupGuardrailDeps: deps }))
      .post('/__dev/group-guardrails/tick')
      .send({ now: '2026-08-11T12:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect([...res.body.ran].sort()).toEqual([
      'channel_quiet',
      'crosscheck_sweep',
      'heartbeat',
      'send_staleness',
    ]);
    expect(sweeps).toEqual({ crossCheck: 1, staleness: 1 });
  });

  it('FORCE DEFAULTS TO TRUE - a spec that omits the flag cannot be no-opped by the worker', async () => {
    const { deps, sweeps } = guardrailDeps();
    const app = appWith({ groupGuardrailDeps: deps });

    await request(app).post('/__dev/group-guardrails/tick').send({ now: '2026-08-11T12:00:00.000Z' });
    const second = await request(app)
      .post('/__dev/group-guardrails/tick')
      .send({ now: '2026-08-11T12:00:01.000Z' });

    expect(second.body.ran).toContain('crosscheck_sweep');
    expect(sweeps.crossCheck).toBe(2);
  });

  it('force: false honors the cadence gate, so the gate itself stays testable', async () => {
    const { deps, sweeps } = guardrailDeps();
    const app = appWith({ groupGuardrailDeps: deps });

    await request(app)
      .post('/__dev/group-guardrails/tick')
      .send({ now: '2026-08-11T12:00:00.000Z', force: false });
    const second = await request(app)
      .post('/__dev/group-guardrails/tick')
      .send({ now: '2026-08-11T12:00:01.000Z', force: false });

    expect(second.body.ran).toEqual([]);
    expect(second.body.skipped).toContain('crosscheck_sweep');
    expect(sweeps.crossCheck).toBe(1);
  });

  it('narrows to the named duties', async () => {
    const { deps, sweeps } = guardrailDeps();
    const res = await request(appWith({ groupGuardrailDeps: deps }))
      .post('/__dev/group-guardrails/tick')
      .send({ duties: ['send_staleness'] });

    expect(res.body.ran).toEqual(['send_staleness']);
    expect(sweeps.crossCheck).toBe(0);
  });

  it('refuses an unknown duty rather than silently running everything', async () => {
    const { deps } = guardrailDeps();
    const res = await request(appWith({ groupGuardrailDeps: deps }))
      .post('/__dev/group-guardrails/tick')
      .send({ duties: ['not_a_duty'] });

    expect(res.status).toBe(400);
  });

  it('refuses an unparseable now', async () => {
    const { deps } = guardrailDeps();
    const res = await request(appWith({ groupGuardrailDeps: deps }))
      .post('/__dev/group-guardrails/tick')
      .send({ now: 'yesterday' });

    expect(res.status).toBe(400);
  });

  it('NORMALIZES now - the deadline partition is compared lexicographically', async () => {
    const { deps } = guardrailDeps();
    const res = await request(appWith({ groupGuardrailDeps: deps }))
      .post('/__dev/group-guardrails/tick')
      .send({ now: '2026-08-11T12:00:00Z' });

    expect(res.body.now).toBe('2026-08-11T12:00:00.000Z');
  });
});

describe('POST /__dev/group-send-staleness/check', () => {
  const staleness = (outcome: 'alarmed' | 'cleared' | 'missing') => {
    const checkMessage = vi.fn(async () => ({
      outcome,
      stuck: outcome === 'alarmed' ? [{ memberKey: 'phone#+15551110002', status: 'sent' }] : [],
    }));
    return {
      service: { checkMessage, sweepSendStaleness: vi.fn() } as unknown as GroupSendStalenessService,
      checkMessage,
    };
  };

  it('checks ONE message and reports the members still non-terminal', async () => {
    const { service, checkMessage } = staleness('alarmed');
    const res = await request(appWith({ groupStaleness: service }))
      .post('/__dev/group-send-staleness/check')
      .send({ conversationId: 'convGroup:x', tsMsgId: '2026-08-11T12:00:00.000Z#IM1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      outcome: 'alarmed',
      stuck: [{ memberKey: 'phone#+15551110002', status: 'sent' }],
    });
    expect(checkMessage).toHaveBeenCalledWith({
      conversationId: 'convGroup:x',
      tsMsgId: '2026-08-11T12:00:00.000Z#IM1',
    });
  });

  it('requires both key parts', async () => {
    const { service } = staleness('cleared');
    const res = await request(appWith({ groupStaleness: service }))
      .post('/__dev/group-send-staleness/check')
      .send({ conversationId: 'convGroup:x' });

    expect(res.status).toBe(400);
  });
});
