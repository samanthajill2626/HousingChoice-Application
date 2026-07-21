// CloudWatchClient seam — the ONLY place the CloudWatch + CloudWatch Logs SDKs
// are imported (adapter rule, mirroring mediaStore). It exposes exactly the two
// narrow reads the System Status service needs (M1.4):
//
//   describeAlarms(prefix)                           → DescribeAlarms (AlarmNamePrefix)
//   queryInsights(groups, filter, sinceMs, limit)    → Logs Insights (StartQuery → poll)
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
  GetQueryResultsCommand,
  StartQueryCommand,
  StopQueryCommand,
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

// Insights polling config: at most 20 polls × 400ms = 8s maximum wait.
const INSIGHTS_MAX_POLLS = 20;
const INSIGHTS_POLL_INTERVAL_MS = 400;

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

/** Insights filter for pino error/fatal lines. Insights parses JSON, so `level`
 *  is a field; non-JSON lines have no `level` and are excluded (as before). */
export const PINO_ERROR_INSIGHTS_FILTER = 'level >= 50';
/** Insights filter for pino warn+ lines (level ≥ 40) — the opt-in "include
 *  warnings" firehose. Off by default (warns are noisy: best-effort degradations,
 *  benign "…ignored" events); the operator toggles it on to widen the panel. */
export const PINO_WARN_INSIGHTS_FILTER = 'level >= 40';
/** Insights filter for Twilio send/delivery FAILURES — surfaced on the errors
 *  panel REGARDLESS of the warn toggle. These are logged at warn (level 40, e.g.
 *  a 30034 undelivered) so `level >= 50` alone misses them; this pins them in by
 *  their structured `event` marker so an operator always sees the failing code. */
export const DELIVERY_FAILURE_INSIGHTS_FILTER = 'event = "delivery_failed"';
/** Insights filter for V8 heap-OOM (Node stderr, non-JSON). */
export const OOM_APP_INSIGHTS_FILTER = '@message like /JavaScript heap out of memory/ or @message like /Reached heap limit/';
/** Insights filter for kernel OOM-killer lines (shipped from /var/log/messages). */
export const OOM_SYSTEM_INSIGHTS_FILTER = '@message like /Out of memory: Killed process/ or @message like /oom-kill:/ or @message like /oom_reaper/';

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
  /**
   * The provider error code the event carried (pino `errorCode`), when present —
   * e.g. a Twilio "30034". PII-SAFE (a numeric/short code, never a body). Absent
   * (undefined) on events that carried no code.
   */
  errorCode?: string | null;
}

/** The narrow surface the systemStatus service depends on. */
export interface CloudWatchClientSeam {
  /** DescribeAlarms filtered by AlarmNamePrefix → mapped alarm views. */
  describeAlarms(prefix: string): Promise<AlarmView[]>;
  /**
   * Logs Insights query across one or more log groups with an arbitrary filter
   * expression, since `sinceMs` (epoch ms). Returns up to `limit` events,
   * NEWEST-FIRST (Insights natively supports `sort @timestamp desc | limit N`).
   * PII-safe: each result row projected through projectErrorEvent.
   */
  queryInsights(logGroupNames: string[], filterExpr: string, sinceMs: number, limit: number): Promise<ErrorEventView[]>;
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
  let errorCode: string | null = null;
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
      // A provider error code (Twilio 30034 etc.) — PII-safe; string or number.
      const ec = obj['errorCode'];
      if (typeof ec === 'string' && ec.length > 0) errorCode = ec;
      else if (typeof ec === 'number') errorCode = String(ec);
    }
  } catch {
    // Non-JSON line — keep the generic message; never surface the raw text.
  }
  return { timestamp, level, message, correlationId, errorCode };
}

/**
 * Parse an Insights @timestamp value ("YYYY-MM-DD HH:MM:SS.mmm" UTC, no zone
 * marker) to epoch ms. Falls back to Date.now() if absent or unparseable.
 */
function parseInsightsTimestamp(value: string | undefined): number {
  if (!value) return Date.now();
  const ms = Date.parse(value.replace(' ', 'T') + 'Z');
  return isNaN(ms) ? Date.now() : ms;
}

/** Simple promise-based delay for polling. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

    async queryInsights(logGroupNames, filterExpr, sinceMs, limit) {
      // Build an Insights query string: filter + newest-first + limit.
      const queryString = `fields @timestamp, @message | filter ${filterExpr} | sort @timestamp desc | limit ${limit}`;

      // CRITICAL: Insights StartQuery uses epoch SECONDS, not milliseconds.
      const startOut = await logs.send(
        new StartQueryCommand({
          logGroupNames,
          startTime: Math.floor(sinceMs / 1000),
          endTime: Math.ceil(Date.now() / 1000),
          queryString,
          limit,
        }),
      );

      const queryId = startOut.queryId;
      if (!queryId) throw new Error('Insights StartQuery returned no queryId');

      // Poll until Complete, Failed/Cancelled/Timeout, or budget exhausted.
      for (let poll = 0; poll < INSIGHTS_MAX_POLLS; poll++) {
        if (poll > 0) {
          await delay(INSIGHTS_POLL_INTERVAL_MS);
        }
        const result = await logs.send(new GetQueryResultsCommand({ queryId }));
        const status = result.status;

        if (status === 'Complete') {
          const rows = result.results ?? [];
          return rows
            .map((row) => {
              // Each row is an array of { field, value } objects.
              let message = '';
              let tsValue: string | undefined;
              for (const cell of row) {
                if (cell.field === '@message') message = cell.value ?? '';
                if (cell.field === '@timestamp') tsValue = cell.value ?? undefined;
              }
              return projectErrorEvent(message, parseInsightsTimestamp(tsValue));
            })
            .slice(0, limit);
        }

        if (status === 'Failed' || status === 'Cancelled' || status === 'Timeout') {
          throw new Error(`Insights query ${queryId} ended with status: ${status}`);
        }

        // 'Scheduled' | 'Running' — keep polling
      }

      // Budget exhausted — best-effort cleanup then degrade.
      try {
        await logs.send(new StopQueryCommand({ queryId }));
      } catch {
        // Ignore StopQuery errors — we're already in a degraded path.
      }
      throw new Error(`Insights query ${queryId} did not complete within ${INSIGHTS_MAX_POLLS} polls`);
    },
  };
}
