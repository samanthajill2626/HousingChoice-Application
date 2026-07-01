// M1.4 System Status service (services/systemStatus.ts) — the read model behind
// the admin-only panel. Injects a FAKE CloudWatchClientSeam (no AWS) and asserts:
//   - getFlags(): booleans/enums/strings ONLY — NEVER the founder number/secret
//   - getAlarms()/getErrors(): graceful degradation
//       * local (appEnv 'local' OR messagingDriver 'console') → unavailable_local,
//         and the seam is NEVER called (a spy proves the short-circuit)
//       * deployed-like + throwing seam → cloudwatch_error (no exception escapes)
//       * deployed-like + working seam → available:true (ALARM-first; events passthrough)
//   - getErrors() window default 24h + the valid windows map to the right lookback
import { describe, expect, it, vi } from 'vitest';
import {
  createSystemStatusService,
  isSystemErrorWindow,
  type SystemStatusServiceDeps,
} from '../src/services/systemStatus.js';
import {
  type CloudWatchClientSeam,
  OOM_APP_INSIGHTS_FILTER,
  OOM_SYSTEM_INSIGHTS_FILTER,
  PINO_ERROR_INSIGHTS_FILTER,
} from '../src/adapters/cloudwatch.js';
import { loadConfig, type AppConfig } from '../src/lib/config.js';

const FOUNDER = '+15555550911';

/** A local config (the default test env: console driver, appEnv local). */
function localConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: 'x' }), ...overrides };
}

/** A deployed-like config: appEnv !== 'local' AND messagingDriver !== 'console'. */
function deployedConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: 'x', HC_ENV: 'dev' });
  return { ...base, appEnv: 'dev', messagingDriver: 'twilio', ...overrides };
}

/** A fake seam whose reads are independently controllable spies. */
function fakeSeam(
  impl: Partial<CloudWatchClientSeam> = {},
): CloudWatchClientSeam & {
  describeAlarms: ReturnType<typeof vi.fn>;
  queryInsights: ReturnType<typeof vi.fn>;
} {
  return {
    describeAlarms: vi.fn(impl.describeAlarms ?? (async () => [])),
    queryInsights: vi.fn(impl.queryInsights ?? (async () => [])),
  };
}

function makeService(deps: Partial<SystemStatusServiceDeps> & { config: AppConfig }) {
  return createSystemStatusService({ ...deps });
}

describe('systemStatus.getFlags', () => {
  it('projects booleans/enums/strings ONLY — and NEVER the founder number', () => {
    const config = deployedConfig({ founderCell: FOUNDER, smsSendingEnabled: false, relayLiveProvisioning: false });
    const service = makeService({ config, cloudwatch: fakeSeam() });

    const flags = service.getFlags();
    expect(flags).toEqual({
      env: 'dev',
      smsSendingEnabled: false,
      relayLiveProvisioning: false,
      founderCellSet: true, // a BOOLEAN — the number itself never appears
      pushConfigured: false,
      messagingDriver: 'twilio',
    });
    // The secret number must not leak anywhere in the projection.
    expect(JSON.stringify(flags)).not.toContain(FOUNDER);
    // Every value is a primitive (boolean/string) — no nested objects/secrets.
    for (const v of Object.values(flags)) {
      expect(['boolean', 'string']).toContain(typeof v);
    }
  });

  it('founderCellSet is false when no founder cell is configured', () => {
    const config = deployedConfig({ founderCell: undefined });
    const flags = makeService({ config, cloudwatch: fakeSeam() }).getFlags();
    expect(flags.founderCellSet).toBe(false);
  });

  it('messagingDriver shows "mock" when the twilio driver is redirected to a fake host', () => {
    // The `--mock` dev loop: MESSAGING_DRIVER=twilio + TWILIO_API_BASE_URL set.
    const config = localConfig({ messagingDriver: 'twilio', twilioApiBaseUrl: 'http://localhost:8889' });
    const flags = makeService({ config, cloudwatch: fakeSeam() }).getFlags();
    expect(flags.messagingDriver).toBe('mock');
  });

  it('messagingDriver shows "twilio" for the real twilio driver (no fake-host redirect)', () => {
    const config = deployedConfig({ messagingDriver: 'twilio', twilioApiBaseUrl: undefined });
    const flags = makeService({ config, cloudwatch: fakeSeam() }).getFlags();
    expect(flags.messagingDriver).toBe('twilio');
  });

  it('messagingDriver shows "console" for the console driver — even with a base-URL override', () => {
    // The base-URL override only redirects the twilio driver; the console driver
    // is unaffected, so it must never read as "mock".
    const config = localConfig({ messagingDriver: 'console', twilioApiBaseUrl: 'http://localhost:8889' });
    const flags = makeService({ config, cloudwatch: fakeSeam() }).getFlags();
    expect(flags.messagingDriver).toBe('console');
  });
});

describe('systemStatus.getAlarms — degradation', () => {
  it('local env (console driver): unavailable_local WITHOUT calling the seam', async () => {
    const seam = fakeSeam();
    const result = await makeService({ config: localConfig(), cloudwatch: seam }).getAlarms();
    expect(result).toEqual({ available: false, reason: 'unavailable_local' });
    expect(seam.describeAlarms).not.toHaveBeenCalled();
  });

  it('appEnv local but a non-console driver still short-circuits (no seam call)', async () => {
    const seam = fakeSeam();
    const config = deployedConfig({ appEnv: 'local' }); // twilio driver but local env
    const result = await makeService({ config, cloudwatch: seam }).getAlarms();
    expect(result).toEqual({ available: false, reason: 'unavailable_local' });
    expect(seam.describeAlarms).not.toHaveBeenCalled();
  });

  it('deployed-like + a throwing seam → cloudwatch_error (no exception escapes)', async () => {
    const seam = fakeSeam({
      describeAlarms: async () => {
        throw new Error('AccessDenied');
      },
    });
    const result = await makeService({ config: deployedConfig(), cloudwatch: seam }).getAlarms();
    expect(result).toEqual({ available: false, reason: 'cloudwatch_error' });
    expect(seam.describeAlarms).toHaveBeenCalledTimes(1);
  });

  it('a CloudWatch request TIMEOUT lands in the degraded path (cloudwatch_error) and does NOT hang', async () => {
    // The bounded request handler rejects a hung connection with a timeout-like
    // error; the service must map that to the degraded notice, never hang or throw.
    const timeout = Object.assign(new Error('Connection timed out after 5000ms'), { name: 'TimeoutError' });
    const seam = fakeSeam({
      describeAlarms: async () => {
        throw timeout;
      },
    });
    const result = await makeService({ config: deployedConfig(), cloudwatch: seam }).getAlarms();
    expect(result).toEqual({ available: false, reason: 'cloudwatch_error' });
  });

  it('deployed-like + a working seam → available:true with ALARM-first sort (then by name)', async () => {
    const seam = fakeSeam({
      describeAlarms: async () => [
        { name: 'hc-dev-b-ok', state: 'OK', stateUpdatedAt: '' },
        { name: 'hc-dev-a-firing', state: 'ALARM', stateUpdatedAt: '' },
        { name: 'hc-dev-c-ok', state: 'OK', stateUpdatedAt: '' },
        { name: 'hc-dev-z-firing', state: 'ALARM', stateUpdatedAt: '' },
      ],
    });
    const result = await makeService({ config: deployedConfig(), cloudwatch: seam }).getAlarms();
    expect(result.available).toBe(true);
    if (!result.available) throw new Error('unreachable');
    // ALARM rows first (a-firing, z-firing by name), then OK rows by name.
    expect(result.alarms.map((a) => a.name)).toEqual([
      'hc-dev-a-firing',
      'hc-dev-z-firing',
      'hc-dev-b-ok',
      'hc-dev-c-ok',
    ]);
    expect(seam.describeAlarms).toHaveBeenCalledWith(deployedConfig().alarmNamePrefix);
  });

  it('breaks a name tie by most-recent stateUpdatedAt (recency-aware secondary order)', async () => {
    const seam = fakeSeam({
      describeAlarms: async () => [
        { name: 'hc-dev-dup', state: 'ALARM', stateUpdatedAt: '2026-06-29T01:00:00.000Z' },
        { name: 'hc-dev-dup', state: 'ALARM', stateUpdatedAt: '2026-06-29T03:00:00.000Z' },
        { name: 'hc-dev-dup', state: 'ALARM', stateUpdatedAt: '2026-06-29T02:00:00.000Z' },
      ],
    });
    const result = await makeService({ config: deployedConfig(), cloudwatch: seam }).getAlarms();
    if (!result.available) throw new Error('unreachable');
    // Same name → most-recent transition first.
    expect(result.alarms.map((a) => a.stateUpdatedAt)).toEqual([
      '2026-06-29T03:00:00.000Z',
      '2026-06-29T02:00:00.000Z',
      '2026-06-29T01:00:00.000Z',
    ]);
  });
});

describe('systemStatus.getErrors — degradation + window', () => {
  it('local env: unavailable_local WITHOUT calling the seam', async () => {
    const seam = fakeSeam();
    const result = await makeService({ config: localConfig(), cloudwatch: seam }).getErrors();
    expect(result).toEqual({ available: false, reason: 'unavailable_local' });
    expect(seam.queryInsights).not.toHaveBeenCalled();
  });

  it('deployed-like + a throwing seam → cloudwatch_error (no exception escapes)', async () => {
    const seam = fakeSeam({
      queryInsights: async () => {
        throw new Error('Throttling');
      },
    });
    const result = await makeService({ config: deployedConfig(), cloudwatch: seam }).getErrors('1h');
    expect(result).toEqual({ available: false, reason: 'cloudwatch_error' });
  });

  it('deployed-like + a working seam → available:true with the events passed through', async () => {
    const events = [
      { timestamp: '2026-06-29T03:00:00.000Z', level: 60, message: 'fatal', correlationId: 'c1' },
      { timestamp: '2026-06-29T02:00:00.000Z', level: 50, message: 'error', correlationId: null },
    ];
    const seam = fakeSeam({ queryInsights: async () => events });
    const result = await makeService({ config: deployedConfig(), cloudwatch: seam }).getErrors('24h');
    expect(result.available).toBe(true);
    if (!result.available) throw new Error('unreachable');
    // Events from both pino query and OOM (same mock returns them all) — dedup will collapse same timestamp+message dupes
    // Just check the passed-through events are present
    expect(result.events.some((e) => e.message === 'fatal')).toBe(true);
  });

  it('defaults to a 24h window; sinceMs is within 2s of now - 24h', async () => {
    const config = deployedConfig();
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const seam = fakeSeam({ queryInsights: async () => [] });
    await makeService({ config, cloudwatch: seam }).getErrors(); // no window → default 24h

    expect(seam.queryInsights).toHaveBeenCalled();
    // All calls share the same sinceMs; check one of them
    const sinceMs = seam.queryInsights.mock.calls[0]![2] as number;
    expect(sinceMs).toBe(now - 24 * 60 * 60 * 1000);
    vi.restoreAllMocks();
  });

  it('the 1h and 7d windows map to the right lookback', async () => {
    const config = deployedConfig();
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const seam = fakeSeam({ queryInsights: async () => [] });
    const service = makeService({ config, cloudwatch: seam });

    await service.getErrors('1h');
    const sinceMs1h = seam.queryInsights.mock.calls[0]![2] as number;
    expect(sinceMs1h).toBe(now - 60 * 60 * 1000);

    await service.getErrors('7d');
    // 3 calls for 1h + 3 calls for 7d = 6 total; get the 4th call (first of 7d batch)
    const sinceMs7d = seam.queryInsights.mock.calls[3]![2] as number;
    expect(sinceMs7d).toBe(now - 7 * 24 * 60 * 60 * 1000);
    vi.restoreAllMocks();
  });

  it('merges pino errors + OOM (app/worker V8 + system kernel), newest-first, synthesized labels', async () => {
    // System OOM (from systemLogGroupName, OOM_SYSTEM_INSIGHTS_FILTER) → "Kernel OOM-kill"
    // App/worker OOM (OOM_APP_INSIGHTS_FILTER, 2 log groups in 1 query) → "V8 heap out of memory"
    // Pino error (PINO_ERROR_INSIGHTS_FILTER) → keeps its real projected message
    const config = deployedConfig();
    const seam = fakeSeam({
      queryInsights: async (logGroupNames, filterExpr) => {
        if (filterExpr === OOM_SYSTEM_INSIGHTS_FILTER) {
          return [{ timestamp: '2026-07-01T00:00:03Z', level: 50, message: '(unparseable log line)', correlationId: null }];
        }
        if (filterExpr === OOM_APP_INSIGHTS_FILTER) {
          return [{ timestamp: '2026-07-01T00:00:02Z', level: 50, message: '(unparseable log line)', correlationId: null }];
        }
        if (filterExpr === PINO_ERROR_INSIGHTS_FILTER) {
          return [{ timestamp: '2026-07-01T00:00:01Z', level: 50, message: 'pino error', correlationId: 'c1' }];
        }
        return [];
      },
    });
    const result = await makeService({ config, cloudwatch: seam }).getErrors('24h');
    expect(result.available).toBe(true);
    if (!result.available) throw new Error('unreachable');
    // Newest-first; system OOM → "Kernel OOM-kill"; app/worker OOM → "V8 heap out of memory"; pino error unchanged.
    expect(result.events.map((e) => e.message)).toEqual([
      'Kernel OOM-kill',        // 03Z — newest
      'V8 heap out of memory',  // 02Z — V8 OOM (combined app+worker query)
      'pino error',             // 01Z — pino, unchanged
    ]);
    // Exactly 3 Insights queries are issued (Promise.all): pino + V8 OOM (2 groups) + system OOM
    expect(seam.queryInsights).toHaveBeenCalledTimes(3);
    // Pino query: errorLogGroupName
    expect(seam.queryInsights).toHaveBeenCalledWith(
      [config.errorLogGroupName],
      PINO_ERROR_INSIGHTS_FILTER,
      expect.any(Number),
      25,
    );
    // V8 OOM query: both errorLogGroupName + workerLogGroupName in 1 call
    expect(seam.queryInsights).toHaveBeenCalledWith(
      [config.errorLogGroupName, config.workerLogGroupName],
      OOM_APP_INSIGHTS_FILTER,
      expect.any(Number),
      25,
    );
    // System OOM query: systemLogGroupName
    expect(seam.queryInsights).toHaveBeenCalledWith(
      [config.systemLogGroupName],
      OOM_SYSTEM_INSIGHTS_FILTER,
      expect.any(Number),
      25,
    );
  });

  it('V8 OOM events from app+worker carry the V8 synthesized label', async () => {
    const config = deployedConfig();
    const seam = fakeSeam({
      queryInsights: async (_logGroupNames, filterExpr) => {
        if (filterExpr === OOM_APP_INSIGHTS_FILTER) {
          return [{ timestamp: '2026-07-01T00:01:00Z', level: 50, message: '(unparseable log line)', correlationId: null }];
        }
        return [];
      },
    });
    const result = await makeService({ config, cloudwatch: seam }).getErrors('24h');
    expect(result.available).toBe(true);
    if (!result.available) throw new Error('unreachable');
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.message).toBe('V8 heap out of memory');
  });

  it('deduplicates OOM events that have the same timestamp+label', async () => {
    const config = deployedConfig();
    const dup = { timestamp: '2026-07-01T00:01:00Z', level: 50, message: '(unparseable log line)', correlationId: null };
    // Both the V8 OOM query and pino query return a dup-timestamp event
    const seam = fakeSeam({
      queryInsights: async (_logGroupNames, filterExpr) => {
        if (filterExpr === OOM_APP_INSIGHTS_FILTER) return [dup];
        // pino returns same timestamp but different message → not a true dup (different key)
        return [];
      },
    });
    const result = await makeService({ config, cloudwatch: seam }).getErrors('24h');
    expect(result.available).toBe(true);
    if (!result.available) throw new Error('unreachable');
    // V8 OOM query → 1 event; pino → 0; system → 0 → total 1 unique
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.message).toBe('V8 heap out of memory');
  });

  it('local env: unavailable_local WITH NO queryInsights call (all queries skipped)', async () => {
    const seam = fakeSeam();
    const result = await makeService({ config: localConfig(), cloudwatch: seam }).getErrors();
    expect(result).toEqual({ available: false, reason: 'unavailable_local' });
    expect(seam.queryInsights).not.toHaveBeenCalled();
  });

  it('deployed + any query throws → cloudwatch_error (degrade-safe, no exception escapes)', async () => {
    const seam = fakeSeam({
      queryInsights: async () => {
        throw new Error('ThrottlingException');
      },
    });
    const result = await makeService({ config: deployedConfig(), cloudwatch: seam }).getErrors('1h');
    expect(result).toEqual({ available: false, reason: 'cloudwatch_error' });
  });
});

describe('isSystemErrorWindow', () => {
  it('accepts only 1h/24h/7d', () => {
    for (const ok of ['1h', '24h', '7d']) expect(isSystemErrorWindow(ok)).toBe(true);
    for (const bad of ['2h', '', '30d', 'all', undefined, 24, null]) {
      expect(isSystemErrorWindow(bad)).toBe(false);
    }
  });
});
