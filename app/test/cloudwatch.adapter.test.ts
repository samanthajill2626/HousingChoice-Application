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
  GetLogRecordCommand,
  GetQueryResultsCommand,
  StartQueryCommand,
  StopQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCloudWatchClient,
  OOM_APP_INSIGHTS_FILTER,
  OOM_SYSTEM_INSIGHTS_FILTER,
  PINO_ERROR_INSIGHTS_FILTER,
  PINO_WARN_INSIGHTS_FILTER,
  projectErrorEvent,
  RAW_TEXT_CAP,
  RESPONSE_BOUND_BYTES,
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
    // The widened projection needs the log-event pointer and its log group.
    expect(startCmd.input.queryString).toContain('@ptr');
    expect(startCmd.input.queryString).toContain('@log');

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
    // No errorCode field on this line → null (not undefined-noise).
    expect(events[0]!.errorCode).toBeNull();
  });

  it('projects a Twilio delivery-failure line — errorCode surfaced (string or number)', async () => {
    const sinceMs = Date.parse('2026-07-21T20:00:00.000Z');
    const send = vi
      .fn()
      .mockResolvedValueOnce({ queryId: 'q1' })
      .mockResolvedValueOnce({
        status: 'Complete',
        results: [
          [
            { field: '@timestamp', value: '2026-07-21 20:04:31.000' },
            {
              field: '@message',
              value:
                '{"level":40,"event":"delivery_failed","errorCode":"30034","msg":"twilio relay-recipient delivery failed (undelivered/failed)","correlationId":"c9"}',
            },
          ],
          [
            { field: '@timestamp', value: '2026-07-21 20:04:32.000' },
            // errorCode as a NUMBER — coerced to string.
            { field: '@message', value: '{"level":40,"errorCode":30007,"msg":"carrier filtered"}' },
          ],
        ],
      });
    const logs = { send };
    const seam = createCloudWatchClient({ config: CONFIG, cloudwatch: fakeCw({}) as never, logs: logs as never });

    const events = await seam.queryInsights(['/hc/dev/app'], PINO_WARN_INSIGHTS_FILTER, sinceMs, 25);
    expect(events).toHaveLength(2);
    expect(events[0]!.errorCode).toBe('30034');
    expect(events[0]!.level).toBe(40);
    expect(events[1]!.errorCode).toBe('30007'); // number → string
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

  it('rejects when StartQuery returns no queryId (degrade, not silent empty)', async () => {
    const sinceMs = Date.parse('2026-07-01T00:00:00.000Z');
    const send = vi.fn().mockResolvedValueOnce({}); // no queryId
    const logs = { send };
    const seam = createCloudWatchClient({ config: CONFIG, cloudwatch: fakeCw({}) as never, logs: logs as never });

    await expect(seam.queryInsights(['/hc/dev/app'], PINO_ERROR_INSIGHTS_FILTER, sinceMs, 25)).rejects.toThrow(
      'Insights StartQuery returned no queryId',
    );
  });

  it('rejects when GetQueryResults returns status Cancelled', async () => {
    const sinceMs = Date.parse('2026-07-01T00:00:00.000Z');
    const send = vi
      .fn()
      .mockResolvedValueOnce({ queryId: 'q-cancelled' })
      .mockResolvedValueOnce({ status: 'Cancelled', results: [] });
    const logs = { send };
    const seam = createCloudWatchClient({ config: CONFIG, cloudwatch: fakeCw({}) as never, logs: logs as never });

    await expect(seam.queryInsights(['/hc/dev/app'], PINO_ERROR_INSIGHTS_FILTER, sinceMs, 25)).rejects.toThrow(
      'status: Cancelled',
    );
  });

  it('rejects and sends StopQuery when poll budget is exhausted (always Running)', async () => {
    const sinceMs = Date.parse('2026-07-01T00:00:00.000Z');
    // StartQuery resolves; every GetQueryResults call returns Running forever.
    const send = vi
      .fn()
      .mockResolvedValueOnce({ queryId: 'q-running' })
      .mockResolvedValue({ status: 'Running', results: [] });
    const logs = { send };
    const seam = createCloudWatchClient({ config: CONFIG, cloudwatch: fakeCw({}) as never, logs: logs as never });

    vi.useFakeTimers();
    try {
      // Drive timers and await the rejection concurrently — avoids an unhandled
      // rejection if we advance timers before attaching the .rejects handler.
      const [rejection] = await Promise.all([
        expect(
          seam.queryInsights(['/hc/dev/app'], PINO_ERROR_INSIGHTS_FILTER, sinceMs, 25),
        ).rejects.toThrow('did not complete within'),
        vi.runAllTimersAsync(),
      ]);
      void rejection; // assertion already captured above

      // StopQuery should have been called exactly once (best-effort cleanup)
      const stopCalls = send.mock.calls.filter((c) => c[0] instanceof StopQueryCommand);
      expect(stopCalls).toHaveLength(1);
      expect((stopCalls[0]![0] as StopQueryCommand).input.queryId).toBe('q-running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('StartQuery endTime is in epoch SECONDS, not milliseconds', async () => {
    const sinceMs = Date.parse('2026-07-01T00:00:00.000Z');
    const send = vi
      .fn()
      .mockResolvedValueOnce({ queryId: 'q-secs' })
      .mockResolvedValueOnce({ status: 'Complete', results: [] });
    const logs = { send };
    const seam = createCloudWatchClient({ config: CONFIG, cloudwatch: fakeCw({}) as never, logs: logs as never });

    await seam.queryInsights(['/hc/dev/app'], PINO_ERROR_INSIGHTS_FILTER, sinceMs, 25);

    const startCmd = send.mock.calls[0]![0] as StartQueryCommand;
    const { startTime, endTime } = startCmd.input;
    // An ms timestamp would be ~1000× larger than Date.now()/1000 (~1.7B seconds).
    // If these were ms they'd be ~1.75 trillion — well above Date.now().
    expect(endTime).toBeLessThan(Date.now()); // seconds value << ms Date.now()
    expect(endTime).toBeGreaterThanOrEqual(startTime!); // endTime ≥ startTime
    // startTime should equal sinceMs converted to seconds
    expect(startTime).toBe(Math.floor(sinceMs / 1000));
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
    // PINO_WARN_INSIGHTS_FILTER widens to warn+ (level ≥ 40)
    expect(PINO_WARN_INSIGHTS_FILTER).toContain('level');
    expect(PINO_WARN_INSIGHTS_FILTER).toContain('40');
  });
});

describe('projectErrorEvent - widened projection', () => {
  const line = (o: Record<string, unknown>) => JSON.stringify(o);
  const row = (msg: string, ptr = 'PTR1', atLog = `9:${CONFIG.errorLogGroupName}`) => [
    { field: '@timestamp', value: '2026-08-24 10:00:00.000' },
    { field: '@message', value: msg },
    { field: '@ptr', value: ptr },
    { field: '@log', value: atLog },
  ];

  it('reads a NESTED err object, not a dotted key', () => {
    const ev = projectErrorEvent(
      row(line({ level: 50, msg: 'job failed: relay.warm', err: { message: 'boom', type: 'RestException' } })),
      CONFIG,
    );
    expect(ev.errMessage).toBe('boom');
    expect(ev.errType).toBe('RestException');
  });

  it('derives source from the CONFIGURED group names, not a suffix', () => {
    expect(projectErrorEvent(row(line({ level: 50, msg: 'x' }), 'P', `9:${CONFIG.workerLogGroupName}`), CONFIG).source).toBe('worker');
    expect(projectErrorEvent(row(line({ level: 50, msg: 'x' }), 'P', `9:${CONFIG.systemLogGroupName}`), CONFIG).source).toBe('system');
    // A DIFFERENT environment's app group must NOT read as 'app'.
    expect(projectErrorEvent(row(line({ level: 50, msg: 'x' }), 'P', '9:/hc/otherenv/app'), CONFIG).source).toBe('unknown');
  });

  it('caps message and errMessage independently, each with its own flag', () => {
    const ev = projectErrorEvent(row(line({ level: 50, msg: 'x'.repeat(400), err: { message: 'short' } })), CONFIG);
    expect(ev.message).toHaveLength(300);
    expect(ev.messageTruncated).toBe(true);
    expect(ev.errMessage).toBe('short');
    expect(ev.errMessageTruncated).toBe(false);
  });

  it('falls back msg -> event -> err.message -> placeholder', () => {
    expect(projectErrorEvent(row(line({ level: 50, event: 'relay_provisioning_failed' })), CONFIG).message).toBe('relay_provisioning_failed');
    expect(projectErrorEvent(row(line({ level: 50, err: { message: 'only this' } })), CONFIG).message).toBe('only this');
    expect(projectErrorEvent(row(line({ level: 50 })), CONFIG).message).toBe('(unparseable log line)');
  });

  it('does not duplicate the text when message came FROM err.message', () => {
    const ev = projectErrorEvent(row(line({ level: 50, err: { message: 'only this' } })), CONFIG);
    expect(ev.message).toBe('only this');
    expect(ev.errMessage).toBeNull();
  });

  it('carries ref, requestId and pollRunId', () => {
    const ev = projectErrorEvent(row(line({ level: 50, msg: 'x', requestId: 'r-1', pollRunId: 'p-1' })), CONFIG);
    expect(ev.ref).toBe('PTR1');
    expect(ev.requestId).toBe('r-1');
    expect(ev.pollRunId).toBe('p-1');
  });
});

describe('cloudwatch adapter - getLogRecord', () => {
  const seamFor = (logRecord: Record<string, string>) =>
    createCloudWatchClient({
      config: CONFIG,
      cloudwatch: fakeCw({}) as never,
      logs: fakeCw({ logRecord }) as never,
    });

  it('keeps the allowlisted err fields including response.status', async () => {
    const out = await seamFor({
      '@log': `9:${CONFIG.errorLogGroupName}`,
      'err.message': 'boom',
      'err.type': 'RestException',
      'err.response.status': '404',
      msg: 'job failed: relay.warm',
    }).getLogRecord('PTR');
    expect(out.fields['err.message']).toBe('boom');
    expect(out.fields['err.response.status']).toBe('404');
    expect(out.fields['msg']).toBe('job failed: relay.warm');
  });

  it('drops every other err nest AT ANY DEPTH, including err.cause', async () => {
    const out = await seamFor({
      '@log': `9:${CONFIG.errorLogGroupName}`,
      'err.message': 'boom',
      'err.config.params': 'To=%2B14045551234',
      'err.config.url': 'https://api.twilio.com/x',
      'err.cause.config.headers.Authorization': 'Basic c2lkOnNlY3JldA==',
    }).getLogRecord('PTR');
    expect(out.fields['err.config.params']).toBeUndefined();
    expect(out.fields['err.config.url']).toBeUndefined();
    expect(out.fields['err.cause.config.headers.Authorization']).toBeUndefined();
  });

  it('KEEPS a scalar string err - six call sites log err as a message', async () => {
    const out = await seamFor({
      '@log': `9:${CONFIG.errorLogGroupName}`,
      err: 'Insights query failed',
      msg: 'system status: Logs Insights query failed',
    }).getLogRecord('PTR');
    expect(out.fields['err']).toBe('Insights query failed');
  });

  it('never returns @message or AWS transport metadata for a PARSED record', async () => {
    const out = await seamFor({
      '@log': `9:${CONFIG.errorLogGroupName}`,
      '@message': '{"msg":"x","err":{"config":{"url":"secret"}}}',
      '@logGroupId': 'g',
      backwardToken: 'b/1',
      forwardToken: 'f/1',
      msg: 'x',
    }).getLogRecord('PTR');
    expect(out.fields['@message']).toBeUndefined();
    expect(out.fields['@logGroupId']).toBeUndefined();
    expect(out.fields['backwardToken']).toBeUndefined();
    expect(out.rawText).toBeUndefined();
  });

  it('does NOT hand back the raw line when a JSON record had all its err nests denied', async () => {
    // The record parses and has app fields, but EVERY err.* key was dropped.
    // Gating rawText on "no app fields" instead of "not parseable" would return
    // @message here - which still contains the nest the allowlist just removed.
    const out = await seamFor({
      '@log': `9:${CONFIG.errorLogGroupName}`,
      '@message': '{"err":{"config":{"url":"https://api.twilio.com/secret"}}}',
      'err.config.url': 'https://api.twilio.com/secret',
    }).getLogRecord('PTR');
    expect(out.rawText).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('returns capped rawText for a NON-JSON record', async () => {
    const out = await seamFor({
      '@log': `9:${CONFIG.systemLogGroupName}`,
      '@message': 'Out of memory: Killed process 123 (node)',
      '@timestamp': '1787000000000',
    }).getLogRecord('PTR');
    expect(out.rawText).toContain('Out of memory');
    expect(out.rawTextTruncated).toBe(false);
  });

  it('passes the ref through as the SDK logRecordPointer', async () => {
    const logs = fakeCw({ logRecord: { '@log': `9:${CONFIG.errorLogGroupName}`, msg: 'x' } });
    await createCloudWatchClient({
      config: CONFIG,
      cloudwatch: fakeCw({}) as never,
      logs: logs as never,
    }).getLogRecord('PTR-abc');
    const sent = logs.send.mock.calls[0]![0] as GetLogRecordCommand;
    expect(sent).toBeInstanceOf(GetLogRecordCommand);
    expect(sent.input.logRecordPointer).toBe('PTR-abc');
  });

  it('normalises @log to the bare group name and passes @logStream through', async () => {
    const out = await seamFor({
      '@log': `9:${CONFIG.errorLogGroupName}`,
      '@logStream': 'app/2026-08-24',
      '@ingestionTime': '1787000000000',
      msg: 'x',
    }).getLogRecord('PTR');
    expect(out.logGroup).toBe(CONFIG.errorLogGroupName);
    expect(out.fields['@logStream']).toBe('app/2026-08-24');
    expect(out.fields['@ingestionTime']).toBe('1787000000000');
    expect(out.responseTruncated).toBe(false);
  });

  it('trims the longest field first when the response exceeds the byte bound', async () => {
    const out = await seamFor({
      '@log': `9:${CONFIG.errorLogGroupName}`,
      'err.stack': 'S'.repeat(RESPONSE_BOUND_BYTES + 10),
      msg: 'small',
    }).getLogRecord('PTR');
    expect(out.responseTruncated).toBe(true);
    expect(out.fields['msg']).toBe('small');
    expect(out.fields['err.stack']!.length).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(JSON.stringify(out.fields), 'utf8')).toBeLessThanOrEqual(RESPONSE_BOUND_BYTES);
  });

  it('caps rawText at RAW_TEXT_CAP and flags it', async () => {
    const out = await seamFor({
      '@log': `9:${CONFIG.systemLogGroupName}`,
      '@message': 'x'.repeat(RAW_TEXT_CAP + 50),
    }).getLogRecord('PTR');
    expect(out.rawText).toHaveLength(RAW_TEXT_CAP);
    expect(out.rawTextTruncated).toBe(true);
  });
});
