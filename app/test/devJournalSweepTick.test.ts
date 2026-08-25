// POST /__dev/journal-sweep/tick - the app-side seam for the daily
// abandoned-journal sweep (log-hygiene spec 9.3).
//
// Same two reasons as its group-guardrail sibling, both from worklist A16: a
// hermetic e2e lane runs a REAL worker beside the app, so (a) a sweep line a
// spec asserts has to be produced APP-side to reach /__dev/logtail, and (b)
// the tick and that worker share the same cadence record, so without a bypass
// a spec silently no-ops whenever the worker had just claimed the day.
//
// The contract pinned here is what a spec will write against: the path, `force`
// DEFAULTING TO TRUE, ISO normalization of `now`, its 400, and the outcome
// counters riding the response body.
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createDevRouter } from '../src/routes/dev.js';
import type { JournalSweepDeps } from '../src/jobs/journalSweep.js';

const SECRET = 'test-origin-secret';
const cfg = () =>
  loadConfig({ NODE_ENV: 'test', DEV_AUTH_ENABLED: '1', CF_ORIGIN_SECRET: SECRET });

/** Settings fake modelling claimGroupPeriod's real condition. */
function makeSettings() {
  const rows = new Map<string, string>();
  let cursor: string | undefined;
  return {
    rows,
    async claimGroupPeriod(id: string, at: string, notBefore: string) {
      const stored = rows.get(id);
      if (stored !== undefined && stored > notBefore) return false;
      rows.set(id, at);
      return true;
    },
    async getJournalSweepCursor() {
      return cursor;
    },
    async putJournalSweepCursor(next: string | undefined) {
      cursor = next;
    },
  };
}

function sweepDeps() {
  const runs = { pages: 0, recoveries: 0 };
  const settings = makeSettings();
  const deps: JournalSweepDeps = {
    settingsRepo: settings as never,
    resolutionRepo: {
      async listActiveResolutionRows() {
        runs.pages += 1;
        return {
          rows: [
            {
              contactId: 'contact-abandoned',
              target: 'pets',
              // Lease long gone, claimed well past the 24h gate.
              leaseExpiresAt: '2026-08-01T00:00:00.000Z',
              claimedAt: '2026-08-01T00:00:00.000Z',
            },
          ],
        };
      },
      async listJournals() {
        return [];
      },
    },
    resolutionService: {
      async recoverAbandoned() {
        runs.recoveries += 1;
        return { recovered: 0, stateChanged: false };
      },
    },
    events: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), listenerCount: () => 0 } as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  };
  return { deps, runs, settings };
}

function appWith(journalSweepDeps: JournalSweepDeps) {
  const config = cfg();
  return buildApp({ config, devRouter: createDevRouter({ config, journalSweepDeps }) });
}

describe('POST /__dev/journal-sweep/tick', () => {
  it('is absent (404) when the dev router is not mounted', async () => {
    const app = buildApp({ config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET }) });
    const res = await request(app)
      .post('/__dev/journal-sweep/tick')
      .set('x-origin-verify', SECRET)
      .send();
    expect(res.status).toBe(404);
  });

  it('runs the sweep and reports the outcome counters', async () => {
    const { deps, runs } = sweepDeps();
    const res = await request(appWith(deps))
      .post('/__dev/journal-sweep/tick')
      .send({ now: '2026-08-25T12:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      ran: true,
      contactsVisited: 1,
      recovered: 0,
      deferred: false,
      persistentContacts: 0,
      failedContacts: 0,
    });
    expect(runs).toEqual({ pages: 1, recoveries: 1 });
  });

  it('FORCE DEFAULTS TO TRUE - a spec that omits the flag cannot be no-opped by the worker', async () => {
    const { deps, runs } = sweepDeps();
    const app = appWith(deps);

    await request(app).post('/__dev/journal-sweep/tick').send({ now: '2026-08-25T12:00:00.000Z' });
    const second = await request(app)
      .post('/__dev/journal-sweep/tick')
      .send({ now: '2026-08-25T12:00:01.000Z' });

    expect(second.body.ran).toBe(true);
    expect(runs.pages).toBe(2);
  });

  it('force: false honors the daily cadence gate, so the gate itself stays testable', async () => {
    const { deps, runs } = sweepDeps();
    const app = appWith(deps);

    await request(app)
      .post('/__dev/journal-sweep/tick')
      .send({ now: '2026-08-25T12:00:00.000Z', force: false });
    const second = await request(app)
      .post('/__dev/journal-sweep/tick')
      .send({ now: '2026-08-25T12:00:01.000Z', force: false });

    expect(second.body.ran).toBe(false);
    expect(runs.pages).toBe(1);
  });

  it('refuses an unparseable now', async () => {
    const { deps } = sweepDeps();
    const res = await request(appWith(deps))
      .post('/__dev/journal-sweep/tick')
      .send({ now: 'yesterday' });

    expect(res.status).toBe(400);
  });

  it('NORMALIZES now - the age gate compares parsed instants, the cadence compares ISO strings', async () => {
    const { deps, settings } = sweepDeps();
    await request(appWith(deps))
      .post('/__dev/journal-sweep/tick')
      .send({ now: '2026-08-25T12:00:00Z' });

    expect(settings.rows.get('journal_sweep_last_run_at')).toBe('2026-08-25T12:00:00.000Z');
  });
});
