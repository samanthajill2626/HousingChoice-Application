// T6.3 - the cadenced guardrail duties.
//
// The cadence is the whole point of this file. The worker polls every 60s and
// hermetic e2e lanes run a REAL worker beside the app (worklist A16), so a duty
// that acted per poll would either spam or - worse - race a spec's `__dev` tick
// for the same due rows. What is proven here: exactly one action per elapsed
// period across ALL callers, and a `force` bypass that a spec can rely on.
import { describe, it, expect, vi } from 'vitest';
import {
  GROUP_DUTY_PERIOD_MS,
  GROUP_GUARDRAIL_DUTIES,
  runGroupGuardrails,
  type RunGroupGuardrailsDeps,
} from '../src/jobs/groupGuardrails.js';
import {
  GROUP_CROSSCHECK_LAST_EVENT_AT_ID,
  GROUP_RAILED_INBOUND_LAST_AT_ID,
} from '../src/repos/settingsRepo.js';

const T0 = '2026-08-11T12:00:00.000Z';

/** A settings fake that models claimGroupPeriod's ConditionExpression exactly. */
function makeSettings(seed: Record<string, string> = {}) {
  const rows = new Map<string, string>(Object.entries(seed));
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

function makeDeps(over: Partial<RunGroupGuardrailsDeps> = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const sweeps = { crossCheck: 0, staleness: 0 };
  const deps: RunGroupGuardrailsDeps = {
    settingsRepo: makeSettings() as never,
    crossCheck: {
      async sweepCrossCheckDeadlines() {
        sweeps.crossCheck += 1;
        return { scanned: 0, alarms: [] };
      },
    },
    staleness: {
      async sweepSendStaleness() {
        sweeps.staleness += 1;
        return { scanned: 0, alarmed: 0, cleared: 0 };
      },
    },
    conversationsRepo: {
      async listGroupTexts() {
        return { items: [], truncated: false };
      },
    } as never,
    logger: log as never,
    ...over,
  };
  return { deps, log, sweeps };
}

describe('guardrail cadence', () => {
  it('runs every duty on a cold stack', async () => {
    const { deps } = makeDeps();
    const outcome = await runGroupGuardrails(T0, deps);
    expect(outcome.ran.sort()).toEqual([...GROUP_GUARDRAIL_DUTIES].sort());
    expect(outcome.skipped).toEqual([]);
  });

  it('acts ONCE PER PERIOD, not once per poll', async () => {
    const { deps, sweeps } = makeDeps();

    // Five polls a minute apart - the worker's real cadence over five minutes.
    for (let minute = 0; minute < 5; minute += 1) {
      await runGroupGuardrails(
        new Date(Date.parse(T0) + minute * 60_000).toISOString(),
        deps,
      );
    }
    expect(sweeps.crossCheck).toBe(1);

    // One more poll, now past the five-minute period: it acts again.
    await runGroupGuardrails(
      new Date(Date.parse(T0) + GROUP_DUTY_PERIOD_MS.crosscheck_sweep + 1000).toISOString(),
      deps,
    );
    expect(sweeps.crossCheck).toBe(2);
  });

  it('the DAILY duties do not act on a five-minute poll', async () => {
    const { deps } = makeDeps();
    await runGroupGuardrails(T0, deps);

    const later = await runGroupGuardrails(
      new Date(Date.parse(T0) + 6 * 60_000).toISOString(),
      deps,
    );
    expect(later.ran).toEqual(['crosscheck_sweep', 'send_staleness']);
    expect(later.skipped).toEqual(['channel_quiet', 'heartbeat']);
  });

  it('FORCE bypasses a period another caller already claimed (A16)', async () => {
    const { deps, sweeps } = makeDeps();
    // The worker polled one second ago and took the period.
    await runGroupGuardrails(T0, deps);
    expect(sweeps.crossCheck).toBe(1);

    const forced = await runGroupGuardrails(
      new Date(Date.parse(T0) + 1000).toISOString(),
      deps,
      { force: true },
    );
    expect(forced.ran).toContain('crosscheck_sweep');
    expect(sweeps.crossCheck).toBe(2);
  });

  it('a FORCED run still stamps the period, so the worker does not repeat it', async () => {
    const { deps, sweeps } = makeDeps();
    await runGroupGuardrails(T0, deps, { force: true });
    expect(sweeps.staleness).toBe(1);

    // The worker's very next unforced poll finds the period taken.
    const polled = await runGroupGuardrails(
      new Date(Date.parse(T0) + 60_000).toISOString(),
      deps,
    );
    expect(polled.skipped).toContain('send_staleness');
    expect(sweeps.staleness).toBe(1);
  });

  it('runs only the named duties when asked', async () => {
    const { deps, sweeps } = makeDeps();
    const outcome = await runGroupGuardrails(T0, deps, { duties: ['send_staleness'] });
    expect(outcome.ran).toEqual(['send_staleness']);
    expect(sweeps.crossCheck).toBe(0);
  });
});

describe('cross-check channel quiet', () => {
  it('WARNs when railed inbound is recent and the cross-check recorded nothing', async () => {
    const settings = makeSettings({
      [GROUP_RAILED_INBOUND_LAST_AT_ID]: '2026-08-11T09:00:00.000Z',
    });
    const { deps, log } = makeDeps({ settingsRepo: settings as never });

    const outcome = await runGroupGuardrails(T0, deps, { duties: ['channel_quiet'] });

    expect(outcome.results.channel_quiet).toMatchObject({ quiet: true });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'group_crosscheck_channel_quiet' }),
      'cross-check channel quiet',
    );
  });

  it('stays silent when BOTH channels saw traffic', async () => {
    const settings = makeSettings({
      [GROUP_RAILED_INBOUND_LAST_AT_ID]: '2026-08-11T09:00:00.000Z',
      [GROUP_CROSSCHECK_LAST_EVENT_AT_ID]: '2026-08-11T09:00:01.000Z',
    });
    const { deps, log } = makeDeps({ settingsRepo: settings as never });

    const outcome = await runGroupGuardrails(T0, deps, { duties: ['channel_quiet'] });

    expect(outcome.results.channel_quiet).toMatchObject({ quiet: false });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('stays silent when there was no railed inbound to cross-check', async () => {
    const { deps, log } = makeDeps();
    const outcome = await runGroupGuardrails(T0, deps, { duties: ['channel_quiet'] });
    expect(outcome.results.channel_quiet).toMatchObject({ quiet: false });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('stays silent when the railed inbound is older than the window', async () => {
    const settings = makeSettings({
      [GROUP_RAILED_INBOUND_LAST_AT_ID]: '2026-08-01T09:00:00.000Z',
    });
    const { deps, log } = makeDeps({ settingsRepo: settings as never });
    const outcome = await runGroupGuardrails(T0, deps, { duties: ['channel_quiet'] });
    expect(outcome.results.channel_quiet).toMatchObject({ quiet: false });
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('group inbound heartbeat', () => {
  /**
   * One group thread. `createdAt` is the MIGRATION/detection instant (an
   * inbound-derived signal); `lastActivityAt` is bumped by every group SEND and
   * must NEVER be able to quiet this duty - that is the whole point of the fix.
   */
  const groupThread = (createdAt: string, lastActivityAt = '2026-08-11T11:59:00.000Z') =>
    ({
      async listGroupTexts() {
        return {
          items: [
            {
              conversationId: 'convGroup:x',
              created_at: createdAt,
              last_activity_at: lastActivityAt,
            },
          ],
          truncated: false,
        };
      },
    }) as never;

  it('WARNs after seven silent days while group threads exist', async () => {
    const { deps, log } = makeDeps({
      conversationsRepo: groupThread('2026-08-01T12:00:00.000Z'),
    });

    const outcome = await runGroupGuardrails(T0, deps, { duties: ['heartbeat'] });

    expect(outcome.results.heartbeat).toMatchObject({ quiet: true });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'group_inbound_heartbeat_quiet' }),
      'no group-origin inbound in seven days while group threads are active',
    );
  });

  // THE DEFECT THIS PINS (fix wave 4, C4). The duty used to fall back to the
  // newest thread's `last_activity_at`, which every group SEND bumps. So the
  // exact failure mechanism 3 exists to catch - detection breaks, carrier group
  // messages start filing as 1:1s, staff keep replying into the group threads -
  // kept the fallback fresh forever and the WARN could never fire. Only INBOUND
  // signals may quiet it.
  it('still WARNs while STAFF REPLIES keep last_activity_at fresh', async () => {
    const { deps, log } = makeDeps({
      // Migrated long ago; no railed inbound at all; but a staff member sent
      // into the thread a minute ago.
      conversationsRepo: groupThread('2026-08-01T12:00:00.000Z', '2026-08-11T11:59:00.000Z'),
    });

    const outcome = await runGroupGuardrails(T0, deps, { duties: ['heartbeat'] });

    expect(outcome.results.heartbeat).toMatchObject({ quiet: true });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'group_inbound_heartbeat_quiet' }),
      'no group-origin inbound in seven days while group threads are active',
    );
  });

  it('stays silent when railed INBOUND arrived inside the window', async () => {
    const settings = makeSettings({
      [GROUP_RAILED_INBOUND_LAST_AT_ID]: '2026-08-10T12:00:00.000Z',
    });
    const { deps, log } = makeDeps({
      settingsRepo: settings as never,
      conversationsRepo: groupThread('2026-08-01T12:00:00.000Z'),
    });
    const outcome = await runGroupGuardrails(T0, deps, { duties: ['heartbeat'] });
    expect(outcome.results.heartbeat).toMatchObject({ quiet: false });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('a freshly migrated stack with no replies yet does NOT warn on day one', async () => {
    // Every thread was just converted; nobody has texted back. The liveness
    // record is absent because no railed inbound has arrived. The grace comes
    // from thread CREATION, not from activity.
    const { deps, log } = makeDeps({
      conversationsRepo: groupThread('2026-08-11T11:00:00.000Z'),
    });
    const outcome = await runGroupGuardrails(T0, deps, { duties: ['heartbeat'] });
    expect(outcome.results.heartbeat).toMatchObject({ quiet: false });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('stays silent on a stack with no group threads at all', async () => {
    const { deps, log } = makeDeps();
    const outcome = await runGroupGuardrails(T0, deps, { duties: ['heartbeat'] });
    expect(outcome.results.heartbeat).toMatchObject({ threads: 0, quiet: false });
    expect(log.warn).not.toHaveBeenCalled();
  });
});
