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
  GetLogRecordCommand,
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

/** Which configured log group an event came from. Never suffix-matched. */
export type ErrorSource = 'app' | 'worker' | 'system' | 'unknown';

/** Field cap for `message` and `errMessage`. Each carries its OWN flag. */
export const FIELD_CAP = 300;

/**
 * One error log event, projected to the fields the dashboard renders.
 *
 * PII POSTURE (changed 2026-08-24): this projection is a DISPLAY control, not a
 * storage control - every field here was already at rest in CloudWatch, and the
 * panel that renders it is admin-only and server-enforced. Credentials are a
 * separate concern, handled by the allowlist on the DETAIL path.
 */
export interface ErrorEventView {
  /** ISO 8601 of the log event. */
  timestamp: string;
  /** pino numeric level (>= 50 for error/fatal). */
  level: number;
  /** The log's short message, capped at FIELD_CAP characters. */
  message: string;
  /** True when `message` hit FIELD_CAP and was cut. */
  messageTruncated: boolean;
  /** The correlation id, when the event carried one; null otherwise. */
  correlationId: string | null;
  /**
   * The provider error code the event carried (pino `errorCode`), when present -
   * e.g. a Twilio "30034". Absent (undefined) on events that carried no code.
   */
  errorCode?: string | null;
  /** The job whose failure produced the line (pino `jobName`). */
  jobName?: string | null;
  /** The structured event name (pino `event`), when the line carried one. */
  event?: string | null;
  /** The error type (`err.type`, falling back to `err.name`). */
  errType?: string | null;
  /** `err.message`, capped at FIELD_CAP - null when `message` already IS it. */
  errMessage?: string | null;
  /** True when `errMessage` hit FIELD_CAP and was cut. */
  errMessageTruncated: boolean;
  /** The HTTP request id, when the line carried one - a trace pivot key. */
  requestId?: string | null;
  /** The worker poll-run id, when the line carried one - a trace pivot key. */
  pollRunId?: string | null;
  /** Which configured log group produced the event. REQUIRED, never null. */
  source: ErrorSource;
  /** The raw Insights `@ptr` for this event. REQUIRED, never null. */
  ref: string;
}

/**
 * The ONLY `err.*` paths that leave this adapter.
 *
 * AN ALLOWLIST, NOT A DENYLIST, and the distinction is load-bearing. Write-time
 * credential redaction (lib/logger.ts) is a BEST-EFFORT PATH LIST - it names
 * three literal `err.config` paths and no wildcard, so `err.config.url`,
 * `err.config.params`, `err.config.baseURL` and `err.config.auth` are NOT
 * redacted at rest. A denylist here would inherit that failure mode and
 * `err.cause.config.headers.Authorization` would walk straight through it.
 * An allowlist closes the class by construction, including nests nobody has met.
 *
 * `response.status` is kept deliberately: lib/errors.ts reads it as the vendor
 * discriminator and `status` is one of the three fields in the repo's
 * adjudicated ErrorSummary allowlist.
 */
export const ERR_ALLOWLIST: readonly string[] = [
  'err.message', 'err.stack', 'err.type', 'err.name', 'err.code', 'err.status', 'err.response.status',
];

/** Cap for a non-JSON record's raw text; carries its OWN flag. */
export const RAW_TEXT_CAP = 4000;
/** Detail response bound in BYTES (Buffer.byteLength, not string length). */
export const RESPONSE_BOUND_BYTES = 65536;

/** AWS transport metadata - never returned to the client. */
const DROPPED_PREFIXES = ['@aws.', '@entity.', '@data_'];
const DROPPED_KEYS = new Set([
  '@message', '@timestamp', '@logGroupId', '@logStreamId', 'backwardToken', 'forwardToken',
]);

function isAllowedKey(key: string): boolean {
  if (key === 'err') return true;                        // scalar err: the message itself
  if (key.startsWith('err.')) return ERR_ALLOWLIST.includes(key);
  if (DROPPED_KEYS.has(key)) return false;
  if (DROPPED_PREFIXES.some((p) => key.startsWith(p))) return false;
  return true;                                           // app-authored field
}

/** Trim `fields` until the serialized response is within the byte bound. */
function enforceBound(fields: Record<string, string>): boolean {
  if (Buffer.byteLength(JSON.stringify(fields), 'utf8') <= RESPONSE_BOUND_BYTES) return false;
  // Longest-first, so one huge stack is trimmed before many small fields.
  const keys = Object.keys(fields).sort((a, b) => fields[b]!.length - fields[a]!.length);
  for (const key of keys) {
    if (Buffer.byteLength(JSON.stringify(fields), 'utf8') <= RESPONSE_BOUND_BYTES) break;
    fields[key] = fields[key]!.slice(0, 512);
  }
  return true;
}

/**
 * The complete log record behind ONE error row (the DETAIL path).
 *
 * ACCESSOR SHAPE: GetLogRecord hands back DOT-FLATTENED keys, so `err.message`
 * is a literal key here - the opposite of the LIST path, which parses raw
 * `@message` JSON where `err` is a NESTED object. Never conflate the two.
 *
 * `fields` is a STATED key set, not "everything the record had": the
 * ERR_ALLOWLIST decides the `err.*` subtree, AWS transport metadata is dropped,
 * and `@message` is never a key (returning it would hand back the very nest the
 * allowlist just removed).
 */
export interface LogRecordView {
  /** The surviving record keys, values coerced to strings. */
  fields: Record<string, string>;
  /** The raw line, present ONLY for a record whose `@message` is not JSON. */
  rawText?: string;
  /** True when `rawText` hit RAW_TEXT_CAP and was cut. */
  rawTextTruncated?: boolean;
  /** True when `fields` had to be trimmed to fit RESPONSE_BOUND_BYTES. */
  responseTruncated: boolean;
  /** The record's normalised log group name - the service's scope check reads it. */
  logGroup: string;
}

/** The narrow surface the systemStatus service depends on. */
export interface CloudWatchClientSeam {
  /** DescribeAlarms filtered by AlarmNamePrefix → mapped alarm views. */
  describeAlarms(prefix: string): Promise<AlarmView[]>;
  /**
   * Logs Insights query across one or more log groups with an arbitrary filter
   * expression, since `sinceMs` (epoch ms). Returns up to `limit` events,
   * NEWEST-FIRST (Insights natively supports `sort @timestamp desc | limit N`).
   * Each result ROW is projected through projectErrorEvent - an admin-only
   * display projection, not a redaction boundary (see ErrorEventView).
   */
  queryInsights(logGroupNames: string[], filterExpr: string, sinceMs: number, limit: number): Promise<ErrorEventView[]>;
  /**
   * GetLogRecord for one Insights `@ptr` - the complete record behind a single
   * error row, filtered through ERR_ALLOWLIST and bounded (see LogRecordView).
   * The pointer is ACCOUNT-scoped and bound to no log group, so the CALLER must
   * check `logGroup` against the configured groups before returning it.
   */
  getLogRecord(ref: string): Promise<LogRecordView>;
}

/** Map a CloudWatch StateValue to the three-value view enum. */
function mapAlarmState(state: StateValue | string | undefined): AlarmView['state'] {
  if (state === 'OK') return 'OK';
  if (state === 'ALARM') return 'ALARM';
  return 'INSUFFICIENT_DATA';
}

/** `@log` is `<accountId>:<logGroupName>` - take everything after the last ':'. */
export function normalizeLogGroup(atLog: string): string {
  const at = atLog.lastIndexOf(':');
  return at === -1 ? atLog : atLog.slice(at + 1);
}

function sourceOf(atLog: string | undefined, config: AppConfig): ErrorSource {
  if (atLog === undefined) return 'unknown';
  const name = normalizeLogGroup(atLog);
  // Compare against the CONFIGURED names, not suffixes: /hc/prod/app must not
  // read as 'app' when this process is dev.
  if (name === config.errorLogGroupName) return 'app';
  if (name === config.workerLogGroupName) return 'worker';
  if (name === config.systemLogGroupName) return 'system';
  return 'unknown';
}

function capped(value: string): { value: string; truncated: boolean } {
  return value.length > FIELD_CAP
    ? { value: value.slice(0, FIELD_CAP), truncated: true }
    : { value, truncated: false };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Project one Insights result ROW to the view the dashboard renders.
 *
 * PII POSTURE (changed 2026-08-24): this is a DISPLAY control, not a storage
 * control - every field here was already at rest in CloudWatch. The panel is
 * admin-only and server-enforced. Credentials are handled separately, by the
 * allowlist on the DETAIL path (getLogRecord below).
 *
 * ACCESSOR SHAPE: this path parses the raw `@message` JSON, where `err` is a
 * NESTED object. `obj['err.message']` is undefined here; the dotted form
 * belongs to the GetLogRecord path only.
 */
export function projectErrorEvent(
  row: { field?: string; value?: string }[],
  config: AppConfig,
): ErrorEventView {
  let raw = '';
  let tsValue: string | undefined;
  let ptr = '';
  let atLog: string | undefined;
  for (const cell of row) {
    if (cell.field === '@message') raw = cell.value ?? '';
    else if (cell.field === '@timestamp') tsValue = cell.value ?? undefined;
    else if (cell.field === '@ptr') ptr = cell.value ?? '';
    else if (cell.field === '@log') atLog = cell.value ?? undefined;
  }

  const base = {
    timestamp: new Date(parseInsightsTimestamp(tsValue)).toISOString(),
    correlationId: null as string | null,
    errorCode: null as string | null,
    source: sourceOf(atLog, config),
    ref: ptr,
  };

  let parsed: Record<string, unknown>;
  try {
    const p: unknown = JSON.parse(raw);
    if (typeof p !== 'object' || p === null) throw new Error('not an object');
    parsed = p as Record<string, unknown>;
  } catch {
    // The LIST path deliberately does NOT surface raw text - that property is
    // preserved and pinned by an existing assertion. Raw text is reachable
    // through the detail path instead.
    return {
      ...base,
      level: 50,
      message: '(unparseable log line)',
      messageTruncated: false,
      errMessageTruncated: false,
    };
  }

  const err =
    typeof parsed['err'] === 'object' && parsed['err'] !== null
      ? (parsed['err'] as Record<string, unknown>)
      : undefined;
  // A SCALAR err is the message itself - six call sites log `err: e.message`.
  const errMessageRaw = err !== undefined ? str(err['message']) : str(parsed['err']);

  const chosen =
    str(parsed['msg']) ?? str(parsed['message']) ?? str(parsed['event']) ?? errMessageRaw ?? '(unparseable log line)';
  const msgCap = capped(chosen);
  // When `message` came FROM err.message they are the same string; leave
  // errMessage null so the row does not render the same text twice.
  const errCap = errMessageRaw !== null && errMessageRaw !== chosen ? capped(errMessageRaw) : null;

  const ec = parsed['errorCode'];
  return {
    ...base,
    level: typeof parsed['level'] === 'number' ? parsed['level'] : 50,
    message: msgCap.value,
    messageTruncated: msgCap.truncated,
    correlationId: str(parsed['correlationId']),
    errorCode: typeof ec === 'number' ? String(ec) : str(ec),
    jobName: str(parsed['jobName']),
    event: str(parsed['event']),
    errType: err !== undefined ? (str(err['type']) ?? str(err['name'])) : null,
    errMessage: errCap?.value ?? null,
    errMessageTruncated: errCap?.truncated ?? false,
    requestId: str(parsed['requestId']),
    pollRunId: str(parsed['pollRunId']),
  };
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
      const queryString = `fields @timestamp, @message, @ptr, @log | filter ${filterExpr} | sort @timestamp desc | limit ${limit}`;

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
          // Each row is an array of { field, value } objects; the projection
          // reads @ptr and @log off it too, so the WHOLE row is passed.
          return rows.map((row) => projectErrorEvent(row, config)).slice(0, limit);
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

    async getLogRecord(ref) {
      const out = await logs.send(new GetLogRecordCommand({ logRecordPointer: ref }));
      const record = (out.logRecord ?? {}) as Record<string, string>;
      const atLog = record['@log'] ?? '';
      // PARSEABILITY, not field count, decides rawText. A JSON record whose err
      // nests were ALL denied still has zero surviving err fields - returning
      // its raw line would hand back exactly what the allowlist just removed.
      const rawMessage = record['@message'] ?? '';
      let isJson = false;
      try {
        const p: unknown = JSON.parse(rawMessage);
        isJson = typeof p === 'object' && p !== null;
      } catch {
        isJson = false;
      }

      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(record)) {
        if (!isAllowedKey(key)) continue;
        fields[key] = String(value);
      }

      let rawText: string | undefined;
      let rawTextTruncated = false;
      if (!isJson && rawMessage.length > 0) {
        rawTextTruncated = rawMessage.length > RAW_TEXT_CAP;
        rawText = rawTextTruncated ? rawMessage.slice(0, RAW_TEXT_CAP) : rawMessage;
      }

      return {
        fields,
        ...(rawText !== undefined && { rawText, rawTextTruncated }),
        responseTruncated: enforceBound(fields),
        logGroup: normalizeLogGroup(atLog),
      };
    },
  };
}
