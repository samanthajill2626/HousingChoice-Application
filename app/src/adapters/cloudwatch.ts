// CloudWatchClient seam — the ONLY place the CloudWatch + CloudWatch Logs SDKs
// are imported (adapter rule, mirroring mediaStore). It exposes exactly the
// narrow reads the System Status service needs (M1.4):
//
//   describeAlarms(prefix)                           → DescribeAlarms (AlarmNamePrefix)
//   queryInsights(groups, filter, sinceMs, limit)    → Logs Insights (StartQuery → poll)
//   getLogRecord(ref)                                -> GetLogRecord (one @ptr)
//   queryTrace(groups, kind, id, atMs)               -> Logs Insights x2 (before + after)
//
// The seam is INJECTABLE into the service so tests pass a fake/throwing client
// and never resolve AWS credentials or hit the network. The clients are
// constructed with region: config.awsRegion (instance-role creds in AWS).
//
// PII (doc section 9; HUMAN DECISION 2026-08-24): these reads are ADMIN-ONLY,
// enforced SERVER-side (createSystemRouter puts requireRole('admin') on every
// /api/system route), and they MAY carry contact PII - phone numbers, names,
// message text - plus host operational data. That is deliberate: everyone who
// can reach this panel already has access to the underlying log data, so the
// projection is a DISPLAY control, not a storage control. CREDENTIALS are the
// one exclusion: the detail path admits only the keys its ERR_ALLOWLIST names
// (below), so a vendor SDK error nest cannot carry an auth header or a signed
// URL out through it.
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
 *
 * WHAT THIS CLOSES, EXACTLY. By construction it closes the whole `err.*`
 * subtree (any depth, including nests nobody has met) PLUS an object-valued
 * bare `err` - see isAllowedKey, which re-reads the value rather than trusting
 * the key. What it does NOT close is every OTHER key: non-`err` fields pass
 * through BY DESIGN, because app-authored fields are the point of the detail
 * view. A vendor error logged under a non-`err` key (`log.error({ response })`,
 * `log.error({ error: e })`) is therefore OUTSIDE this control and is owned by
 * write-time redaction plus call-site discipline; a sweep of every
 * log.error/warn/fatal in app/src on 2026-08-25 found zero live cases (the two
 * `error:` hits are refusal-code STRINGS). Do not read the allowlist as a
 * whole-record redaction boundary; it is the `err` boundary.
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

/**
 * AWS transport metadata - never returned to the client.
 *
 * `@log`, `@logStream` and `@ingestionTime` are DELIBERATELY not in here: they
 * are the host metadata that tells an operator which group and stream the
 * record came from, which is most of the value of the expanded row. `@log` is
 * `<accountId>:<logGroupName>`, so the AWS account id is visible to whoever can
 * read this panel - acceptable because the panel is admin-only and
 * server-enforced, and stated here so it stays a decision rather than a leak.
 */
const DROPPED_PREFIXES = ['@aws.', '@entity.', '@data_'];
const DROPPED_KEYS = new Set([
  '@message', '@timestamp', '@logGroupId', '@logStreamId', 'backwardToken', 'forwardToken',
]);

/**
 * Decide one record key/value pair. The VALUE matters for exactly one key:
 * bare `err`. Six call sites log `err` as a plain string message, which is why
 * it is admitted at all - but GetLogRecord only dot-flattens what it flattened,
 * and an `err` handed back UNFLATTENED (a nesting-depth or field-count limit on
 * discovery would do it) would carry the entire vendor object - `config.headers.
 * Authorization` included - past the allowlist that exists to stop exactly that.
 * So an `err` whose value parses to a JSON OBJECT is dropped; a scalar survives.
 */
function isAllowedKey(key: string, value: string): boolean {
  if (key === 'err') return !isJsonObject(value);        // scalar err: the message itself
  if (key.startsWith('err.')) return ERR_ALLOWLIST.includes(key);
  if (DROPPED_KEYS.has(key)) return false;
  if (DROPPED_PREFIXES.some((p) => key.startsWith(p))) return false;
  return true;                                           // app-authored field
}

/** Does this string parse to a JSON object (or array)? Non-JSON is `false`. */
function isJsonObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

/**
 * Trim `fields` until the serialized response is within the byte bound, and
 * report whether anything was trimmed or dropped.
 *
 * CONVERGES rather than trimming once: a single longest-first pass at 512 chars
 * fits one huge stack, but ~128 surviving fields of 512 bytes each still exceed
 * 64 KiB, which used to return `true` over a payload the bound had not actually
 * bounded (measured: 200 fields x 2000 chars -> 104,291 bytes). So the cap
 * halves and the pass repeats, and if even a one-char cap is not enough (the KEY
 * NAMES alone can overflow) the longest remaining fields are DROPPED.
 *
 * MUTATES ITS ARGUMENT on purpose: there is exactly ONE caller (getLogRecord,
 * which built the object and has not handed it out yet), so copying would buy
 * nothing. `rawText` rides OUTSIDE this budget by design - it carries its own
 * RAW_TEXT_CAP - so the true response ceiling is RESPONSE_BOUND_BYTES + 4000.
 */
function enforceBound(fields: Record<string, string>): boolean {
  const size = (): number => Buffer.byteLength(JSON.stringify(fields), 'utf8');
  if (size() <= RESPONSE_BOUND_BYTES) return false;
  // Longest-first, so one huge stack is trimmed before many small fields.
  const longestFirst = (): string[] =>
    Object.keys(fields).sort((a, b) => fields[b]!.length - fields[a]!.length);
  for (let cap = 512; cap >= 1; cap = Math.floor(cap / 2)) {
    for (const key of longestFirst()) {
      if (size() <= RESPONSE_BOUND_BYTES) return true;
      if (fields[key]!.length > cap) fields[key] = fields[key]!.slice(0, cap);
    }
  }
  // Every value is now at most one character and it STILL does not fit, so the
  // key names are the weight. Drop the longest-named fields until it does.
  for (const key of Object.keys(fields).sort((a, b) => b.length - a.length)) {
    if (size() <= RESPONSE_BOUND_BYTES) return true;
    delete fields[key];
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

/** Which correlation id a trace pivots on. All three are minted as randomUUID(). */
export type TraceIdKind = 'correlationId' | 'requestId' | 'pollRunId';

/**
 * One line of a correlation trace: an INTERLEAVED app+worker timeline around a
 * failure, so most of its lines are ordinary INFO context rather than errors.
 * That is why this is not an ErrorEventView - the list projection drops exactly
 * the fields a context line carries.
 *
 * ACCESSOR SHAPE: like the LIST path and UNLIKE the detail path, this parses the
 * raw `@message` JSON, where `err` is a NESTED object. Never conflate the two.
 */
export interface TraceLineView {
  /** ISO 8601 of the log event. */
  timestamp: string;
  /** pino numeric level; 30 (info) when the line carried none. */
  level: number;
  /** The log's short message. */
  message: string;
  /** Which configured log group emitted the line. REQUIRED, never null. */
  source: ErrorSource;
  /**
   * The raw Insights `@ptr` for this line. REQUIRED, never null - every listed
   * line has one. It is what makes the view's anchor marking EXACT: a
   * millisecond timestamp is not unique (an app line and a worker line under one
   * requestId is the normal interleaved case this view exists to show), so
   * comparing timestamps marks every line sharing the anchor's millisecond.
   */
  ref: string;
  /** Request-line context (pino `method`/`path`/`statusCode`/`durationMs`). */
  method?: string | null;
  path?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  /** Job context (pino `jobName`/`jobId`/`hopCount`) on the worker side. */
  jobName?: string | null;
  jobId?: string | null;
  hopCount?: number | null;
}

/** A merged trace: ascending lines plus a truncation flag for EACH side. */
export interface TraceResult {
  /** Ascending by timestamp, at most 2 x TRACE_SIDE_LIMIT lines. */
  lines: TraceLineView[];
  /** True when the BEFORE side filled its budget - earlier lines exist. */
  truncatedBefore: boolean;
  /** True when the AFTER side filled its budget - later lines exist. */
  truncatedAfter: boolean;
}

/** Trace row budget PER SIDE of the anchor (50 max merged). */
export const TRACE_SIDE_LIMIT = 25;
/** correlationId reach-back: one job run, local. */
const BRACKET_TIGHT_MS = 5 * 60_000;
/** requestId / pollRunId reach-back - the cross-hop ids (see queryTrace). */
const BRACKET_WIDE_MS = 30 * 60_000;
/** Look-ahead, the same for every kind: nothing wanted is 30 min AFTER a failure. */
const BRACKET_AHEAD_MS = 5 * 60_000;

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
  /**
   * The lines around ONE failure: every log line carrying `id` for the chosen
   * id kind, anchored on the failing row's own timestamp `atMs` (epoch ms) and
   * merged ASCENDING. Two Insights queries with OPPOSITE sorts run in parallel
   * over disjoint windows - see the implementation for why either half alone is
   * wrong. `id` is interpolated into the query string, so the CALLER must have
   * validated it (the service does, before this is ever reached).
   */
  queryTrace(groups: string[], kind: TraceIdKind, id: string, atMs: number): Promise<TraceResult>;
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
 * Project one Insights result ROW to a trace line.
 *
 * ACCESSOR SHAPE: like the LIST path and UNLIKE the detail path, this parses the
 * raw `@message` JSON, so `err` is a NESTED object here.
 *
 * The level default is 30 (info), NOT the list path's 50: a trace is mostly
 * context lines, and calling an unparseable one an error would misread the
 * timeline. Fields are shared with projectErrorEvent (`sourceOf`, `str`,
 * `parseInsightsTimestamp`) so the two paths cannot drift apart.
 */
function traceLine(row: { field?: string; value?: string }[], config: AppConfig): TraceLineView {
  let raw = '';
  let tsValue: string | undefined;
  let atLog: string | undefined;
  let ptr = '';
  for (const cell of row) {
    if (cell.field === '@message') raw = cell.value ?? '';
    else if (cell.field === '@timestamp') tsValue = cell.value ?? undefined;
    else if (cell.field === '@log') atLog = cell.value ?? undefined;
    else if (cell.field === '@ptr') ptr = cell.value ?? '';
  }
  const timestamp = new Date(parseInsightsTimestamp(tsValue)).toISOString();
  const source = sourceOf(atLog, config);
  let parsed: Record<string, unknown>;
  try {
    const p: unknown = JSON.parse(raw);
    if (typeof p !== 'object' || p === null) throw new Error('not an object');
    parsed = p as Record<string, unknown>;
  } catch {
    return { timestamp, level: 30, message: '(unparseable log line)', source, ref: ptr };
  }
  const err =
    typeof parsed['err'] === 'object' && parsed['err'] !== null
      ? (parsed['err'] as Record<string, unknown>)
      : undefined;
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  return {
    timestamp,
    level: typeof parsed['level'] === 'number' ? parsed['level'] : 30,
    message:
      str(parsed['msg']) ??
      str(parsed['message']) ??
      str(parsed['event']) ??
      (err !== undefined ? str(err['message']) : str(parsed['err'])) ??
      '(unparseable log line)',
    source,
    ref: ptr,
    method: str(parsed['method']),
    path: str(parsed['path']),
    statusCode: num(parsed['statusCode']),
    durationMs: num(parsed['durationMs']),
    jobName: str(parsed['jobName']),
    jobId: str(parsed['jobId']),
    hopCount: num(parsed['hopCount']),
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

  /**
   * StartQuery -> poll GetQueryResults -> RAW rows. Shared by every Insights
   * read here, unchanged from the single-caller original: at most
   * INSIGHTS_MAX_POLLS x INSIGHTS_POLL_INTERVAL_MS of waiting, then a
   * best-effort StopQuery and a throw so the service degrades.
   *
   * The CALLER owns the query string and BOTH bounds, which are epoch SECONDS -
   * the list and trace paths deliberately do not share a window convention
   * (the trace splits on an inclusive second boundary; the list does not).
   */
  async function runInsights(
    logGroupNames: string[],
    queryString: string,
    startTimeSec: number,
    endTimeSec: number,
    limit: number,
  ): Promise<{ field?: string; value?: string }[][]> {
    const startOut = await logs.send(
      new StartQueryCommand({
        logGroupNames,
        startTime: startTimeSec,
        endTime: endTimeSec,
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
        // Each row is an array of { field, value } objects; the projections read
        // @ptr and @log off it too, so WHOLE rows go back to the caller.
        return (result.results ?? []).slice(0, limit);
      }

      if (status === 'Failed' || status === 'Cancelled' || status === 'Timeout') {
        throw new Error(`Insights query ${queryId} ended with status: ${status}`);
      }

      // 'Scheduled' | 'Running' - keep polling
    }

    // Budget exhausted - best-effort cleanup then degrade.
    try {
      await logs.send(new StopQueryCommand({ queryId }));
    } catch {
      // Ignore StopQuery errors - we're already in a degraded path.
    }
    throw new Error(`Insights query ${queryId} did not complete within ${INSIGHTS_MAX_POLLS} polls`);
  }

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
      const rows = await runInsights(
        logGroupNames,
        queryString,
        Math.floor(sinceMs / 1000),
        Math.ceil(Date.now() / 1000),
        limit,
      );
      return rows.map((row) => projectErrorEvent(row, config));
    },

    async getLogRecord(ref) {
      const out = await logs.send(new GetLogRecordCommand({ logRecordPointer: ref }));
      const record = (out.logRecord ?? {}) as Record<string, string>;
      // MEASURED (planner spike, 2026-08-24, real AWS account): GetLogRecord
      // responses from BOTH /hc/dev/app and /hc/prod/system carried `@log`,
      // valued `<accountId>:<logGroupName>`. The service's env-scope check reads
      // the group this yields, so the whole boundary rests on that presence -
      // and it fails CLOSED: were AWS ever to omit `@log`, normalizeLogGroup('')
      // is '', no configured group matches, and every row degrades to
      // `out_of_scope` rather than escaping the scope check.
      const atLog = record['@log'] ?? '';
      // PARSEABILITY, not field count, decides rawText. A JSON record whose err
      // nests were ALL denied still has zero surviving err fields - returning
      // its raw line would hand back exactly what the allowlist just removed.
      const rawMessage = record['@message'] ?? '';
      const isJson = isJsonObject(rawMessage);

      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(record)) {
        const text = String(value);
        if (!isAllowedKey(key, text)) continue;
        fields[key] = text;
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

    async queryTrace(groups, kind, id, atMs) {
      // The cross-hop ids reach BACKWARDS by construction: a job's failure can
      // be ~8 min after its first attempt (SQS 120s visibility x 5 receives)
      // and ~20 min from its enqueue. A tight symmetric bracket reaches none of
      // that, which is the case pollRunId propagation exists to serve.
      const back = kind === 'correlationId' ? BRACKET_TIGHT_MS : BRACKET_WIDE_MS;
      const startSec = Math.floor((atMs - back) / 1000);
      const endSec = Math.ceil((atMs + BRACKET_AHEAD_MS) / 1000);
      // SECOND-GRANULARITY SPLIT. `at` is milliseconds; StartQuery is seconds,
      // so a split exactly at `at` is inexpressible.
      //
      // MEASURED, NOT ASSUMED (planner spike, 2026-08-24, real AWS account): an
      // Insights query with startTime == endTime == 1787022602 RETURNED a real
      // event whose epoch ms was 1787022602554 - i.e. `endTime: T` covers the
      // WHOLE second T.000-T.999, not the instant T*1000. So BEFORE's
      // endTime = floor(atMs / 1000) is inclusive AND gapless (the anchor's
      // own mid-second line is inside it), and AFTER's startTime = floor + 1
      // keeps the two windows DISJOINT - no row appears twice, so the merge
      // needs no dedup rule. Do NOT use ceil for BEFORE: that overlaps by a
      // second and returns the failure line itself from both queries.
      //
      // queryInsights' ceil'd endTime 60 lines up is NOT a contradiction: its
      // window ends at "now", where rounding UP merely includes the current
      // partial second. Both are correct under the same inclusive semantics.
      const anchorSec = Math.floor(atMs / 1000);
      // `@ptr` rides along so each line carries its own identity: the view marks
      // the anchor by ref, which a millisecond timestamp cannot do uniquely.
      const fields = 'fields @timestamp, @message, @log, @ptr';
      // `id` is validated UUID-shaped by the service before it reaches here.
      const filter = `filter ${kind} = "${id}"`;
      // OPPOSITE SORTS, because Insights applies `limit` INSIDE the sort: one
      // ascending query returns the EARLIEST 25 rows of the bracket and can
      // drop the failure out of its own trace (and one descending query drops
      // everything after it).
      //
      // Parallel: each Insights poll has a bounded ~8s budget, so sequential
      // would double the worst-case wait on a user-initiated click.
      const [beforeRows, afterRows] = await Promise.all([
        runInsights(groups, `${fields} | ${filter} | sort @timestamp desc | limit ${TRACE_SIDE_LIMIT}`, startSec, anchorSec, TRACE_SIDE_LIMIT),
        runInsights(groups, `${fields} | ${filter} | sort @timestamp asc | limit ${TRACE_SIDE_LIMIT}`, anchorSec + 1, endSec, TRACE_SIDE_LIMIT),
      ]);
      return {
        lines: [
          ...beforeRows.map((r) => traceLine(r, config)).reverse(),
          ...afterRows.map((r) => traceLine(r, config)),
        ],
        truncatedBefore: beforeRows.length >= TRACE_SIDE_LIMIT,
        truncatedAfter: afterRows.length >= TRACE_SIDE_LIMIT,
      };
    },
  };
}
