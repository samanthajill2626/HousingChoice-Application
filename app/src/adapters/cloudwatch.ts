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
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { type AppConfig } from '../lib/config.js';

// A bounded request handler so a slow/blackholed CloudWatch connection degrades
// (caught → cloudwatch_error) instead of tying up the Express handler for
// minutes — the dashboard auto-refreshes every 60s, so hung handlers would
// stack server-side. Paired with maxAttempts: 2 to cap total retry time.
const CW_CONNECTION_TIMEOUT_MS = 2_000;
const CW_REQUEST_TIMEOUT_MS = 5_000;
const CW_MAX_ATTEMPTS = 2;

/** A region-configured SDK client config with bounded socket/connect timeouts. */
function boundedClientConfig(region: string): {
  region: string;
  maxAttempts: number;
  requestHandler: NodeHttpHandler;
} {
  return {
    region,
    maxAttempts: CW_MAX_ATTEMPTS,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: CW_CONNECTION_TIMEOUT_MS,
      requestTimeout: CW_REQUEST_TIMEOUT_MS,
    }),
  };
}

/**
 * Bounded wider scan budget for FilterLogEvents. We page WITHOUT the small
 * 25-cap (FilterLogEvents returns OLDEST-first per page, so a 25 SDK limit
 * would yield the 25 *oldest* in-window events and MISS the newest), then sort
 * descending + slice the newest 25 locally. The scan is capped so it stays
 * cheap: at most ERROR_SCAN_MAX_PAGES pages OR ERROR_SCAN_MAX_EVENTS events,
 * whichever comes first. Limitation: in an extreme burst beyond this budget the
 * absolute-newest events could still be missed — acceptable for a best-effort
 * observability panel.
 */
const ERROR_SCAN_MAX_PAGES = 5;
const ERROR_SCAN_MAX_EVENTS = 500;

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
   * ms). Pages a BOUNDED wider scan (oldest-first per page), then returns the
   * NEWEST `limit` PII-safe projections, NEWEST-FIRST.
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

/**
 * Classify a thrown CloudWatch/Logs SDK error into a coarse, PII-free kind so a
 * degraded System Status read is DIAGNOSABLE in the logs (credentials vs network
 * vs throttling vs IAM) instead of an opaque "cloudwatch_error". Inspects the SDK
 * error `name` and any node `code`/`errno`. The HTTP `reason` stays the stable
 * `cloudwatch_error` (the panel just shows "available in deployed envs"); this is
 * for the operator reading CloudWatch — never surfaced as PII.
 */
export type CloudWatchErrorKind =
  | 'credentials'
  | 'unauthorized'
  | 'throttled'
  | 'unreachable'
  | 'unknown';

export function classifyCloudWatchError(err: unknown): CloudWatchErrorKind {
  const e = (err ?? {}) as { name?: unknown; code?: unknown; errno?: unknown };
  const name = typeof e.name === 'string' ? e.name : '';
  const code = `${typeof e.code === 'string' ? e.code : ''} ${typeof e.errno === 'string' ? e.errno : ''}`;
  if (/Credentials|UnrecognizedClient|InvalidClientTokenId|InvalidSignature|ExpiredToken/i.test(name)) {
    return 'credentials';
  }
  if (/AccessDenied|Unauthorized|NotAuthorized|Forbidden/i.test(name)) return 'unauthorized';
  if (/Throttl|TooManyRequests|RequestLimitExceeded|Limitexceeded/i.test(name)) return 'throttled';
  if (/Timeout|Network|Abort|Connection/i.test(name) || /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET/.test(code)) {
    return 'unreachable';
  }
  return 'unknown';
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
  const cw = deps.cloudwatch ?? new CloudWatchClient(boundedClientConfig(config.awsRegion));
  const logs = deps.logs ?? new CloudWatchLogsClient(boundedClientConfig(config.awsRegion));

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
      // Bounded wider scan: page through FilterLogEvents WITHOUT a small SDK-side
      // `limit` (it returns oldest-first per page, so a 25-cap would surface the
      // 25 *oldest* in-window events and miss the newest). Accumulate up to the
      // scan budget, then sort descending + slice the newest `limit` locally.
      const projected: ErrorEventView[] = [];
      let nextToken: string | undefined;
      let pages = 0;
      do {
        const out = await logs.send(
          new FilterLogEventsCommand({
            logGroupName: logGroup,
            startTime: sinceMs,
            // pino stamps a numeric `level`; ≥ 50 is error/fatal.
            filterPattern: '{ $.level >= 50 }',
            nextToken,
          }),
        );
        for (const e of out.events ?? []) {
          projected.push(projectErrorEvent(e.message ?? '', e.timestamp ?? Date.now()));
        }
        nextToken = out.nextToken;
        pages += 1;
      } while (
        nextToken !== undefined &&
        pages < ERROR_SCAN_MAX_PAGES &&
        projected.length < ERROR_SCAN_MAX_EVENTS
      );
      // Newest-first, then the newest `limit`.
      projected.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
      return projected.slice(0, limit);
    },
  };
}
