// M1.4 System Status adapter (adapters/cloudwatch.ts) — the ONLY place the
// CloudWatch + CloudWatch Logs SDKs are imported. Exercises both narrow reads
// against INJECTED fake SDK clients (no AWS, no creds, no network):
//
//   describeAlarms(prefix)   DescribeAlarms → AlarmView mapping (state/name/ISO,
//                            AlarmNamePrefix passed straight through)
//   queryInsights(...)       StartQuery → poll GetQueryResults → PII-SAFE projection
//                            (timestamp, level, message, correlationId ONLY),
//                            newest-first (Insights yields newest-first natively)
//
// The fakes implement `.send(command)` and inspect the command's `input` — so we
// assert the exact SDK request the adapter builds, and feed back canned SDK
// output to assert the projection.
import { DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import {
  GetQueryResultsCommand,
  StartQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { describe, expect, it, vi } from 'vitest';
import {
  createCloudWatchClient,
  OOM_APP_INSIGHTS_FILTER,
  OOM_SYSTEM_INSIGHTS_FILTER,
  PINO_ERROR_INSIGHTS_FILTER,
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

describe('cloudwatch adapter — queryInsights', () => {
  it('starts a query, polls until Complete, and returns the projected event (non-JSON → placeholder)', async () => {
    const sinceMs = Date.parse('2026-07-01T17:46:41.000Z');
    const filterExpr = OOM_APP_INSIGHTS_FILTER;
    // Simulate: StartQuery → { queryId }; first GetQueryResults → Running; second → Complete + 1 result
    const send = vi
      .fn()
      .mockResolvedValueOnce({ queryId: 'q1' }) // StartQueryCommand
      .mockResolvedValueOnce({ status: 'Running', results: [] }) // first GetQueryResults poll
      .mockResolvedValueOnce({
        status: 'Complete',
        results: [
          [
            { field: '@timestamp', value: '2026-07-01 18:46:41.139' },
            { field: '@message', value: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory' },
          ],
        ],
      });
    const logs = { send };
    const seam = createCloudWatchClient({ config: CONFIG, cloudwatch: fakeCw({}) as never, logs: logs as never });

    const events = await seam.queryInsights(['/hc/dev/app'], filterExpr, sinceMs, 25);

    // StartQuery was issued with correct inputs
    expect(send).toHaveBeenCalledTimes(3);
    const startCmd = send.mock.calls[0]![0] as StartQueryCommand;
    expect(startCmd).toBeInstanceOf(StartQueryCommand);
    // logGroupNames passes through
    expect(startCmd.input.logGroupNames).toEqual(['/hc/dev/app']);
    // startTime is in SECONDS (not ms)
    expect(startCmd.input.startTime).toBe(Math.floor(sinceMs / 1000));
    // queryString includes the required clauses
    expect(startCmd.input.queryString).toContain('sort @timestamp desc');
    expect(startCmd.input.queryString).toContain('limit');
    expect(startCmd.input.queryString).toContain(filterExpr);

    // Result: 1 event returned
    expect(events).toHaveLength(1);
    // Non-JSON → placeholder message (PII-safety: raw text never surfaced)
    expect(events[0]!.message).toBe('(unparseable log line)');
    expect(events[0]!.level).toBe(50);
    // Timestamp parsed as UTC ISO from Insights "YYYY-MM-DD HH:MM:SS.mmm" format
    expect(events[0]!.timestamp).toBe('2026-07-01T18:46:41.139Z');
  });

  it('projects a pino JSON @message to level/message/correlationId correctly', async () => {
    const sinceMs = Date.parse('2026-07-01T00:00:00.000Z');
    const send = vi
      .fn()
      .mockResolvedValueOnce({ queryId: 'q1' })
      .mockResolvedValueOnce({
        status: 'Complete',
        results: [
          [
            { field: '@timestamp', value: '2026-07-01 12:00:00.000' },
            { field: '@message', value: '{"level":50,"msg":"boom","correlationId":"c1"}' },
          ],
        ],
      });
    const logs = { send };
    const seam = createCloudWatchClient({ config: CONFIG, cloudwatch: fakeCw({}) as never, logs: logs as never });

    const events = await seam.queryInsights(['/hc/dev/app'], PINO_ERROR_INSIGHTS_FILTER, sinceMs, 25);

    expect(events).toHaveLength(1);
    expect(events[0]!.level).toBe(50);
    expect(events[0]!.message).toBe('boom');
    expect(events[0]!.correlationId).toBe('c1');
    expect(events[0]!.timestamp).toBe('2026-07-01T12:00:00.000Z');
  });

  it('rejects when GetQueryResults returns status Failed', async () => {
    const sinceMs = Date.parse('2026-07-01T00:00:00.000Z');
    const send = vi
      .fn()
      .mockResolvedValueOnce({ queryId: 'q1' })
      .mockResolvedValueOnce({ status: 'Failed', results: [] });
    const logs = { send };
    const seam = createCloudWatchClient({ config: CONFIG, cloudwatch: fakeCw({}) as never, logs: logs as never });

    await expect(seam.queryInsights(['/hc/dev/app'], PINO_ERROR_INSIGHTS_FILTER, sinceMs, 25)).rejects.toThrow();
  });

  it('accepts multiple log group names (Insights multi-group query)', async () => {
    const sinceMs = Date.parse('2026-07-01T00:00:00.000Z');
    const send = vi
      .fn()
      .mockResolvedValueOnce({ queryId: 'q2' })
      .mockResolvedValueOnce({ status: 'Complete', results: [] });
    const logs = { send };
    const seam = createCloudWatchClient({ config: CONFIG, cloudwatch: fakeCw({}) as never, logs: logs as never });

    await seam.queryInsights(['/hc/dev/app', '/hc/dev/worker'], OOM_APP_INSIGHTS_FILTER, sinceMs, 25);

    const startCmd = send.mock.calls[0]![0] as StartQueryCommand;
    expect(startCmd.input.logGroupNames).toEqual(['/hc/dev/app', '/hc/dev/worker']);
  });

  it('returns [] when StartQuery returns no queryId', async () => {
    const sinceMs = Date.parse('2026-07-01T00:00:00.000Z');
    const send = vi.fn().mockResolvedValueOnce({}); // no queryId
    const logs = { send };
    const seam = createCloudWatchClient({ config: CONFIG, cloudwatch: fakeCw({}) as never, logs: logs as never });

    const events = await seam.queryInsights(['/hc/dev/app'], PINO_ERROR_INSIGHTS_FILTER, sinceMs, 25);
    expect(events).toEqual([]);
  });

  it('Insights filter constants contain the expected terms', () => {
    // PINO_ERROR_INSIGHTS_FILTER uses numeric level comparison (JSON field)
    expect(PINO_ERROR_INSIGHTS_FILTER).toContain('level');
    expect(PINO_ERROR_INSIGHTS_FILTER).toContain('50');
    // OOM_APP_INSIGHTS_FILTER covers V8 heap OOM terms
    expect(OOM_APP_INSIGHTS_FILTER).toContain('JavaScript heap out of memory');
    expect(OOM_APP_INSIGHTS_FILTER).toContain('Reached heap limit');
    // OOM_SYSTEM_INSIGHTS_FILTER covers kernel OOM-killer terms
    expect(OOM_SYSTEM_INSIGHTS_FILTER).toContain('Out of memory: Killed process');
    expect(OOM_SYSTEM_INSIGHTS_FILTER).toContain('oom-kill:');
    expect(OOM_SYSTEM_INSIGHTS_FILTER).toContain('oom_reaper');
  });
});
