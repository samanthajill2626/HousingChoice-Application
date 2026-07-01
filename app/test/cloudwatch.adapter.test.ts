// M1.4 System Status adapter (adapters/cloudwatch.ts) — the ONLY place the
// CloudWatch + CloudWatch Logs SDKs are imported. Exercises both narrow reads
// against INJECTED fake SDK clients (no AWS, no creds, no network):
//
//   describeAlarms(prefix)   DescribeAlarms → AlarmView mapping (state/name/ISO,
//                            AlarmNamePrefix passed straight through)
//   filterErrorEvents(...)   FilterLogEvents → PII-SAFE projection (timestamp,
//                            level, message, correlationId ONLY), level≥50 filter
//                            pattern, limit, NEWEST-FIRST
//
// The fakes implement `.send(command)` and inspect the command's `input` — so we
// assert the exact SDK request the adapter builds, and feed back canned SDK
// output to assert the projection.
import { DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { describe, expect, it, vi } from 'vitest';
import {
  createCloudWatchClient,
  OOM_APP_FILTER_PATTERN,
  OOM_SYSTEM_FILTER_PATTERN,
} from '../src/adapters/cloudwatch.js';
import { loadConfig, type AppConfig } from '../src/lib/config.js';

const CONFIG: AppConfig = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: 'x' });

/** A fake CloudWatch SDK client: records the command it was sent, returns canned. */
function fakeCw(output: unknown): { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn().mockResolvedValue(output) };
}

describe('cloudwatch adapter — describeAlarms', () => {
  it('passes AlarmNamePrefix through and maps StateValue/name/timestamp to the view', async () => {
    const updated = new Date('2026-06-29T12:00:00.000Z');
    const cw = fakeCw({
      MetricAlarms: [
        { AlarmName: 'hc-dev-cpu-high', StateValue: 'OK', StateUpdatedTimestamp: updated },
        { AlarmName: 'hc-dev-5xx', StateValue: 'ALARM', StateUpdatedTimestamp: updated },
        { AlarmName: 'hc-dev-pending', StateValue: 'INSUFFICIENT_DATA', StateUpdatedTimestamp: updated },
      ],
    });
    const seam = createCloudWatchClient({
      config: CONFIG,
      cloudwatch: cw as never,
      logs: fakeCw({}) as never,
    });

    const alarms = await seam.describeAlarms('hc-dev-');

    // The exact SDK request: a DescribeAlarmsCommand with our prefix.
    expect(cw.send).toHaveBeenCalledTimes(1);
    const command = cw.send.mock.calls[0]![0] as DescribeAlarmsCommand;
    expect(command).toBeInstanceOf(DescribeAlarmsCommand);
    expect(command.input).toEqual({ AlarmNamePrefix: 'hc-dev-' });

    expect(alarms).toEqual([
      { name: 'hc-dev-cpu-high', state: 'OK', stateUpdatedAt: '2026-06-29T12:00:00.000Z' },
      { name: 'hc-dev-5xx', state: 'ALARM', stateUpdatedAt: '2026-06-29T12:00:00.000Z' },
      { name: 'hc-dev-pending', state: 'INSUFFICIENT_DATA', stateUpdatedAt: '2026-06-29T12:00:00.000Z' },
    ]);
  });

  it('maps an unknown/absent StateValue to INSUFFICIENT_DATA, and absent name/timestamp to safe defaults', async () => {
    const cw = fakeCw({
      MetricAlarms: [
        { AlarmName: 'hc-dev-weird', StateValue: 'PENDING' }, // unknown → INSUFFICIENT_DATA, no ts → ''
        {}, // no name → '(unnamed)', no state → INSUFFICIENT_DATA
      ],
    });
    const seam = createCloudWatchClient({ config: CONFIG, cloudwatch: cw as never, logs: fakeCw({}) as never });

    const alarms = await seam.describeAlarms('hc-dev-');
    expect(alarms).toEqual([
      { name: 'hc-dev-weird', state: 'INSUFFICIENT_DATA', stateUpdatedAt: '' },
      { name: '(unnamed)', state: 'INSUFFICIENT_DATA', stateUpdatedAt: '' },
    ]);
  });

  it('returns [] when MetricAlarms is absent', async () => {
    const cw = fakeCw({});
    const seam = createCloudWatchClient({ config: CONFIG, cloudwatch: cw as never, logs: fakeCw({}) as never });
    expect(await seam.describeAlarms('hc-dev-')).toEqual([]);
  });
});

describe('cloudwatch adapter — filterErrorEvents', () => {
  it('builds the level≥50 filter pattern, log group + startTime on the SDK request — NO small limit (the wider scan slices newest-25 locally)', async () => {
    const logs = fakeCw({ events: [] });
    const seam = createCloudWatchClient({ config: CONFIG, cloudwatch: fakeCw({}) as never, logs: logs as never });

    await seam.filterErrorEvents('/hc/dev/app', 1_700_000_000_000, 25);

    expect(logs.send).toHaveBeenCalledTimes(1);
    const command = logs.send.mock.calls[0]![0] as FilterLogEventsCommand;
    expect(command).toBeInstanceOf(FilterLogEventsCommand);
    // No SDK-side `limit` — FilterLogEvents returns oldest-first per page, so a
    // 25-cap would surface the OLDEST 25 and miss the newest. nextToken starts
    // undefined (first page).
    expect(command.input).toEqual({
      logGroupName: '/hc/dev/app',
      startTime: 1_700_000_000_000,
      filterPattern: '{ $.level >= 50 }',
      nextToken: undefined,
    });
  });

  it('PII-SAFE projection: ONLY timestamp/level/message/correlationId — no phone/body/name/email leaks', async () => {
    const logs = fakeCw({
      events: [
        {
          timestamp: Date.parse('2026-06-29T10:00:00.000Z'),
          message: JSON.stringify({
            level: 50,
            msg: 'send failed',
            correlationId: 'corr-1',
            // PII fields that MUST NOT be projected through:
            phone: '+15555550123',
            body: 'tenant SSN 123-45-6789',
            name: 'Jane Tenant',
            email: 'jane@example.com',
            to: '+15555550999',
          }),
        },
      ],
    });
    const seam = createCloudWatchClient({ config: CONFIG, cloudwatch: fakeCw({}) as never, logs: logs as never });

    const events = await seam.filterErrorEvents('/hc/dev/app', 0, 25);

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    // Exactly the four PII-safe keys, nothing else.
    expect(Object.keys(ev).sort()).toEqual(['correlationId', 'level', 'message', 'timestamp']);
    expect(ev).toEqual({
      timestamp: '2026-06-29T10:00:00.000Z',
      level: 50,
      message: 'send failed',
      correlationId: 'corr-1',
    });
    // Belt-and-braces: no PII anywhere in the serialized projection.
    const serialized = JSON.stringify(events);
    for (const leak of ['+15555550123', '123-45-6789', 'Jane Tenant', 'jane@example.com', '+15555550999']) {
      expect(serialized).not.toContain(leak);
    }
  });

  it('returns events NEWEST-FIRST and capped at the limit (FilterLogEvents yields oldest-first)', async () => {
    const at = (iso: string): number => Date.parse(iso);
    const logs = fakeCw({
      events: [
        { timestamp: at('2026-06-29T01:00:00.000Z'), message: JSON.stringify({ level: 50, msg: 'oldest' }) },
        { timestamp: at('2026-06-29T02:00:00.000Z'), message: JSON.stringify({ level: 50, msg: 'middle' }) },
        { timestamp: at('2026-06-29T03:00:00.000Z'), message: JSON.stringify({ level: 60, msg: 'newest' }) },
      ],
    });
    const seam = createCloudWatchClient({ config: CONFIG, cloudwatch: fakeCw({}) as never, logs: logs as never });

    const events = await seam.filterErrorEvents('/hc/dev/app', 0, 2);
    // Capped at the limit (2), newest-first.
    expect(events.map((e) => e.message)).toEqual(['newest', 'middle']);
    expect(events[0]!.level).toBe(60);
  });

  it('follows nextToken across pages, then returns the NEWEST 25 — not the oldest 25 (FilterLogEvents is oldest-first)', async () => {
    const at = (iso: string): number => Date.parse(iso);
    // 30 in-window events spread across two pages, in oldest-first order (as the
    // SDK yields them): minutes 0..29 of the hour. The NEWEST 25 are minutes
    // 5..29; the 5 oldest (0..4) must be dropped.
    const evAt = (minute: number): { timestamp: number; message: string } => ({
      timestamp: at(`2026-06-29T10:${String(minute).padStart(2, '0')}:00.000Z`),
      message: JSON.stringify({ level: 50, msg: `m${minute}` }),
    });
    const page1 = Array.from({ length: 18 }, (_, i) => evAt(i)); // minutes 0..17
    const page2 = Array.from({ length: 12 }, (_, i) => evAt(18 + i)); // minutes 18..29
    const send = vi
      .fn()
      .mockResolvedValueOnce({ events: page1, nextToken: 'tok-1' })
      .mockResolvedValueOnce({ events: page2 }); // no nextToken → scan stops
    const logs = { send };
    const seam = createCloudWatchClient({ config: CONFIG, cloudwatch: fakeCw({}) as never, logs: logs as never });

    const events = await seam.filterErrorEvents('/hc/dev/app', 0, 25);

    // Pagination was followed (two sends), the second carrying the first's token.
    expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls[0]![0] as FilterLogEventsCommand).input.nextToken).toBeUndefined();
    expect((send.mock.calls[1]![0] as FilterLogEventsCommand).input.nextToken).toBe('tok-1');
    // Exactly the NEWEST 25, newest-first: m29, m28, …, m5. The oldest 5 dropped.
    expect(events).toHaveLength(25);
    expect(events[0]!.message).toBe('m29');
    expect(events[24]!.message).toBe('m5');
    expect(events.map((e) => e.message)).not.toContain('m0');
    expect(events.map((e) => e.message)).not.toContain('m4');
  });

  it('bounds the scan: stops paging after the max-pages budget even if nextToken keeps coming', async () => {
    // Every page returns one event and ALWAYS a nextToken — an unbounded stream.
    // The scan must stop after the 5-page budget rather than loop forever.
    const at = (iso: string): number => Date.parse(iso);
    let n = 0;
    const send = vi.fn().mockImplementation(async () => {
      n += 1;
      return {
        events: [{ timestamp: at(`2026-06-29T10:00:0${n}.000Z`), message: JSON.stringify({ level: 50, msg: `p${n}` }) }],
        nextToken: `tok-${n}`, // never runs out
      };
    });
    const logs = { send };
    const seam = createCloudWatchClient({ config: CONFIG, cloudwatch: fakeCw({}) as never, logs: logs as never });

    const events = await seam.filterErrorEvents('/hc/dev/app', 0, 25);

    // Bounded at 5 pages (ERROR_SCAN_MAX_PAGES), not infinite.
    expect(send).toHaveBeenCalledTimes(5);
    expect(events).toHaveLength(5);
  });

  it('degrades a non-JSON / off-shape log line WITHOUT surfacing its raw text', async () => {
    const logs = fakeCw({
      events: [
        { timestamp: Date.parse('2026-06-29T05:00:00.000Z'), message: 'a raw non-json secret line +15555550123' },
      ],
    });
    const seam = createCloudWatchClient({ config: CONFIG, cloudwatch: fakeCw({}) as never, logs: logs as never });

    const events = await seam.filterErrorEvents('/hc/dev/app', 0, 25);
    expect(events[0]!.message).toBe('(unparseable log line)');
    expect(events[0]!.level).toBe(50);
    expect(events[0]!.correlationId).toBeNull();
    // The raw text (which could carry PII) is never surfaced.
    expect(JSON.stringify(events)).not.toContain('+15555550123');
  });

  it('tolerates a `message` alias for pino `msg`, and a missing correlationId → null', async () => {
    const logs = fakeCw({
      events: [
        { timestamp: Date.parse('2026-06-29T06:00:00.000Z'), message: JSON.stringify({ level: 50, message: 'aliased' }) },
      ],
    });
    const seam = createCloudWatchClient({ config: CONFIG, cloudwatch: fakeCw({}) as never, logs: logs as never });

    const events = await seam.filterErrorEvents('/hc/dev/app', 0, 25);
    expect(events[0]!.message).toBe('aliased');
    expect(events[0]!.correlationId).toBeNull();
  });
});

describe('cloudwatch adapter — filterEventsByPattern + OOM constants', () => {
  it('filterEventsByPattern passes the pattern through and projects raw (non-JSON) OOM lines to default level 50', async () => {
    const sent: unknown[] = [];
    const logs = {
      send: vi.fn(async (cmd: { input: unknown }) => {
        sent.push(cmd.input);
        return {
          events: [
            { message: 'Out of memory: Killed process 1234 (node)', timestamp: 1000 },
          ],
        };
      }),
    };
    const seam = createCloudWatchClient({
      config: CONFIG,
      logs: logs as never,
      cloudwatch: fakeCw({}) as never,
    });

    const events = await seam.filterEventsByPattern('/hc/dev/system', 0, 25, OOM_SYSTEM_FILTER_PATTERN);

    // The pattern was passed through to the SDK request.
    expect((sent[0] as { filterPattern: string }).filterPattern).toBe(OOM_SYSTEM_FILTER_PATTERN);
    expect(events).toHaveLength(1);
    // Non-JSON OOM lines degrade to the safe placeholder (PII-safety rule: raw text never surfaced).
    // The projector still assigns level 50 as the default for non-JSON lines.
    expect(events[0]!.message).toBe('(unparseable log line)');
    expect(events[0]!.level).toBe(50);
  });

  it('filterErrorEvents still uses the pino level>=50 JSON pattern', async () => {
    const sent: unknown[] = [];
    const logs = {
      send: vi.fn(async (cmd: { input: unknown }) => {
        sent.push(cmd.input);
        return { events: [] };
      }),
    };
    const seam = createCloudWatchClient({
      config: CONFIG,
      logs: logs as never,
      cloudwatch: fakeCw({}) as never,
    });
    await seam.filterErrorEvents('/hc/dev/app', 0, 25);
    expect((sent[0] as { filterPattern: string }).filterPattern).toBe('{ $.level >= 50 }');
  });

  it('OOM_APP_FILTER_PATTERN covers JS heap OOM terms', () => {
    expect(OOM_APP_FILTER_PATTERN).toContain('JavaScript heap out of memory');
    expect(OOM_APP_FILTER_PATTERN).toContain('Reached heap limit');
  });

  it('OOM_SYSTEM_FILTER_PATTERN covers kernel OOM-killer terms', () => {
    expect(OOM_SYSTEM_FILTER_PATTERN).toContain('Out of memory: Killed process');
    expect(OOM_SYSTEM_FILTER_PATTERN).toContain('oom-kill:');
    expect(OOM_SYSTEM_FILTER_PATTERN).toContain('oom_reaper');
  });
});
