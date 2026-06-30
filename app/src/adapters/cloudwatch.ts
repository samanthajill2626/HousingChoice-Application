// CloudWatchClient seam — the ONLY place the CloudWatch + CloudWatch Logs SDKs
// are imported (adapter rule, mirroring mediaStore). It exposes exactly the two
// narrow reads the System Status service needs (M1.4):
//
//   describeAlarms(prefix)                 → DescribeAlarms (AlarmNamePrefix)
//   filterErrorEvents(group, sinceMs, lim) → FilterLogEvents (pino level ≥ 50)
//
// The seam is INJECTABLE into the service so tests pass a fake/throwing client
// and never resolve AWS credentials or hit the network. The clients are
// constructed with region: config.awsRegion (instance-role creds in AWS).
//
// PII (doc §9): the error projection is PII-SAFE — timestamp, level, the short
// message (`msg`), and correlationId ONLY. Bodies, phone numbers, names,
// emails, and any other log fields are NEVER projected out of a log event.
import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  type StateValue,
} from '@aws-sdk/client-cloudwatch';
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { type AppConfig } from '../lib/config.js';

/** One alarm, projected to the view the dashboard renders. */
export interface AlarmView {
  name: string;
  /** Mapped from the SDK StateValue; an unknown value falls back to INSUFFICIENT_DATA. */
  state: 'OK' | 'ALARM' | 'INSUFFICIENT_DATA';
  /** ISO 8601 of the last state transition (StateUpdatedTimestamp), or '' when absent. */
  stateUpdatedAt: string;
}

/** One error log event, projected to the PII-SAFE fields ONLY. */
export interface ErrorEventView {
  /** ISO 8601 of the log event. */
  timestamp: string;
  /** pino numeric level (≥ 50 for error/fatal). */
  level: number;
  /** The log's short message (pino `msg`) — never a body/PII payload. */
  message: string;
  /** The correlation id, when the event carried one; null otherwise. */
  correlationId: string | null;
}

/** The narrow surface the systemStatus service depends on. */
export interface CloudWatchClientSeam {
  /** DescribeAlarms filtered by AlarmNamePrefix → mapped alarm views. */
  describeAlarms(prefix: string): Promise<AlarmView[]>;
  /**
   * FilterLogEvents on `logGroup` for pino level ≥ 50, since `sinceMs` (epoch
   * ms), capped at `limit`. Returns PII-safe projections, NEWEST-FIRST.
   */
  filterErrorEvents(logGroup: string, sinceMs: number, limit: number): Promise<ErrorEventView[]>;
}

/** Map a CloudWatch StateValue to the three-value view enum. */
function mapAlarmState(state: StateValue | string | undefined): AlarmView['state'] {
  if (state === 'OK') return 'OK';
  if (state === 'ALARM') return 'ALARM';
  return 'INSUFFICIENT_DATA';
}

/**
 * Project a parsed pino log line to the PII-SAFE error view. Only `level`,
 * `msg`/`message`, and `correlationId` are read off the JSON — everything else
 * (bodies, phones, names, emails, arbitrary fields) is deliberately dropped.
 * A non-JSON / off-shape message degrades to a generic line rather than
 * leaking the raw text.
 */
function projectErrorEvent(rawMessage: string, eventTimestampMs: number): ErrorEventView {
  const timestamp = new Date(eventTimestampMs).toISOString();
  let level = 50;
  let message = '(unparseable log line)';
  let correlationId: string | null = null;
  try {
    const parsed: unknown = JSON.parse(rawMessage);
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj['level'] === 'number') level = obj['level'];
      // pino's short message is `msg`; tolerate a `message` alias too.
      const msg = obj['msg'] ?? obj['message'];
      if (typeof msg === 'string' && msg.length > 0) message = msg;
      const cid = obj['correlationId'];
      if (typeof cid === 'string' && cid.length > 0) correlationId = cid;
    }
  } catch {
    // Non-JSON line — keep the generic message; never surface the raw text.
  }
  return { timestamp, level, message, correlationId };
}

export interface CreateCloudWatchClientDeps {
  config: AppConfig;
  /** Test seams — fake SDK clients (default to real, region-configured ones). */
  cloudwatch?: CloudWatchClient;
  logs?: CloudWatchLogsClient;
}

/**
 * Construct the CloudWatch seam over the two SDK clients. The clients use
 * `region: config.awsRegion` and the ambient (instance-role) credentials when
 * deployed; tests inject fakes so neither AWS nor credential resolution is
 * ever touched.
 */
export function createCloudWatchClient(deps: CreateCloudWatchClientDeps): CloudWatchClientSeam {
  const { config } = deps;
  const cw = deps.cloudwatch ?? new CloudWatchClient({ region: config.awsRegion });
  const logs = deps.logs ?? new CloudWatchLogsClient({ region: config.awsRegion });

  return {
    async describeAlarms(prefix) {
      const out = await cw.send(new DescribeAlarmsCommand({ AlarmNamePrefix: prefix }));
      const metricAlarms = out.MetricAlarms ?? [];
      return metricAlarms.map((a) => ({
        name: a.AlarmName ?? '(unnamed)',
        state: mapAlarmState(a.StateValue),
        stateUpdatedAt:
          a.StateUpdatedTimestamp !== undefined ? a.StateUpdatedTimestamp.toISOString() : '',
      }));
    },

    async filterErrorEvents(logGroup, sinceMs, limit) {
      const out = await logs.send(
        new FilterLogEventsCommand({
          logGroupName: logGroup,
          startTime: sinceMs,
          // pino stamps a numeric `level`; ≥ 50 is error/fatal.
          filterPattern: '{ $.level >= 50 }',
          limit,
        }),
      );
      const events = out.events ?? [];
      const projected = events.map((e) =>
        projectErrorEvent(e.message ?? '', e.timestamp ?? Date.now()),
      );
      // Newest-first, capped at the limit (FilterLogEvents returns oldest-first).
      projected.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
      return projected.slice(0, limit);
    },
  };
}
