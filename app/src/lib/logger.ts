// Structured JSON logging core (pino → stdout).
//
// Every line emitted while a correlation context is active carries the full
// context plus a `correlationId` field
// (jobRunId ?? pollRunId ?? requestId ?? bootId).
// Lines without a correlationId are "orphan logs" — a CloudWatch metric filter
// mirrors isOrphanLogLine() below and alarms when any appear. Entrypoints wrap
// process lifecycle (boot/shutdown) in a bootId context, and the worker wraps
// every poll-loop TICK in a pollRunId context, so neither is ever an orphan.
import { destination as pinoDestination, pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { getContext } from './context.js';

export type { Logger } from 'pino';

export interface CreateLoggerOptions {
  level?: string;
  /** Injectable destination so tests can capture output without touching stdout. */
  destination?: DestinationStream;
}

// ---------------------------------------------------------------------------
// Dev-only WARN+ERROR ring buffer (group-texting S8/T8.0)
// ---------------------------------------------------------------------------
//
// e2e specs need to assert on GUARDRAIL log lines (a tripwire WARN, a
// cross-check ERROR, the ABSENCE of an unknown-SID ERROR). Nothing in the
// harness could read an app log line before this: every child process is
// spawned with stdio:'inherit', so the lines go to the launcher's stdout and
// no test can see them.
//
// The hook is a DESTINATION WRAPPER, not a pino `hooks.logMethod`: a hook runs
// BEFORE level filtering and before the `mixin`, so it would capture lines the
// logger discarded and lose `correlationId`. Wrapping the destination puts the
// ring DOWNSTREAM of serialization, redaction and the mixin - the ring stores
// the exact JSON line CloudWatch would receive.
//
// DEV-ONLY, and inert otherwise: the same triple gate `lib/devRoutes.ts` uses
// for the `/__dev/*` router, read from raw env because createLogger runs before
// loadConfig() (importing config here would be a cycle). When the gate is
// closed `createLogger` returns `pino(options)` byte-for-byte as before.
//
// A16 (BINDING): this ring lives in ONE process. The hermetic lane ALSO spawns
// a real worker with its own handlers and pollers, whose WARN/ERROR lines never
// reach the APP's ring. Every guardrail line an e2e spec asserts must therefore
// be driven through an APP-side `/__dev/*/tick`, never by waiting on the worker.

/** Most lines retained. Old lines are dropped from the front. */
export const DEV_LOG_TAIL_CAPACITY = 500;
/** pino numeric levels: warn is 40, error 50, fatal 60. */
export const DEV_LOG_TAIL_MIN_LEVEL = 40;

/** One captured line: pino's own JSON object (level/time/msg + custom fields). */
export interface DevLogLine {
  level: number;
  time: number;
  msg?: string;
  [field: string]: unknown;
}

export interface DevLogTailFilter {
  /** Numeric pino level floor (default DEV_LOG_TAIL_MIN_LEVEL). */
  minLevel?: number;
  /** Epoch ms floor, inclusive. */
  sinceMs?: number;
  /** Substring match against `msg`. */
  contains?: string;
  /** Exact match against the house-style `event` field. */
  event?: string;
  /** Newest-last cap. */
  limit?: number;
}

const devLogRing: DevLogLine[] = [];

/**
 * The `/__dev/*` triple gate, read from raw env: DEV_AUTH_ENABLED truthy AND
 * NODE_ENV !== 'production' AND a DYNAMODB_ENDPOINT (local DynamoDB only).
 * Mirrors `loadConfig`'s truthy set for DEV_AUTH_ENABLED exactly.
 */
export function devLogTailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const devAuth = ['true', '1', 'yes'].includes((env['DEV_AUTH_ENABLED'] ?? '').toLowerCase());
  if (!devAuth) return false;
  if (env['NODE_ENV'] === 'production') return false;
  return typeof env['DYNAMODB_ENDPOINT'] === 'string' && env['DYNAMODB_ENDPOINT'].length > 0;
}

/**
 * Cheap pre-filter so the ring does NOT `JSON.parse` every log line (fix wave
 * 5, adversarial 37). The overwhelmingly common line is INFO or DEBUG, which
 * the ring discards - parsing it first made the whole logging hot path in local
 * dev and every e2e lane pay for a full parse it then threw away. pino
 * serializes `level` as the first field, so a string scan settles it. A line
 * that does not match the fast shape falls through to the parse, so nothing is
 * ever dropped by the optimization itself.
 */
function mayBeRetained(line: string): boolean {
  const at = line.indexOf('"level":');
  if (at === -1) return true; // unknown shape - let the parser decide
  const level = Number.parseInt(line.slice(at + 8, at + 12), 10);
  return !Number.isFinite(level) || level >= DEV_LOG_TAIL_MIN_LEVEL;
}

/** Parse one serialized pino line and retain it when it is WARN or worse. */
function captureDevLogLine(line: string): void {
  if (!mayBeRetained(line)) return;
  let parsed: DevLogLine;
  try {
    parsed = JSON.parse(line) as DevLogLine;
  } catch {
    // A non-JSON line (a transport wrapper, a stray write) is not assertable
    // and must never crash the log path.
    return;
  }
  if (typeof parsed.level !== 'number' || parsed.level < DEV_LOG_TAIL_MIN_LEVEL) return;
  devLogRing.push(parsed);
  if (devLogRing.length > DEV_LOG_TAIL_CAPACITY) devLogRing.shift();
}

/**
 * A destination that forwards every line to `base` unchanged AND retains the
 * WARN+ ones in the ring. Exported so a unit test can build one over a capture
 * stream instead of stdout.
 *
 * PASSTHROUGH, WITH PINO'S OWN DESTINATION UNDERNEATH (fix wave 5, adversarial
 * 37). The default base is `pino.destination(1)` - the SAME sonic-boom writer
 * `pino(options)` installs when this wrapper is absent - rather than a raw
 * `process.stdout.write`, so enabling the tail no longer swaps out the buffered
 * fast path for every pre-existing log line in local dev and every e2e lane.
 * With the level pre-filter above, a discarded line now costs one `indexOf` and
 * one `parseInt`.
 *
 * DEV-ONLY RESIDENCY, STATED PLAINLY (doc 9): the ring holds up to
 * DEV_LOG_TAIL_CAPACITY serialized WARN+ lines in process memory, with whatever
 * fields those lines carried. It is gated by `devLogTailEnabled()` - the same
 * triple gate as the `/__dev/*` router - so it cannot exist in a deployed
 * process, and `/__dev/logtail/clear` empties it.
 */
export function createDevLogTailStream(base?: DestinationStream): DestinationStream {
  const sink = base ?? pinoDestination(1);
  return {
    write(line: string): void {
      sink.write(line);
      captureDevLogLine(line);
    },
  };
}

/** Retained WARN+ lines, oldest first, after filtering. */
export function readDevLogTail(filter: DevLogTailFilter = {}): DevLogLine[] {
  const minLevel = filter.minLevel ?? DEV_LOG_TAIL_MIN_LEVEL;
  let lines = devLogRing.filter((l) => l.level >= minLevel);
  if (filter.sinceMs !== undefined) {
    const since = filter.sinceMs;
    lines = lines.filter((l) => typeof l.time === 'number' && l.time >= since);
  }
  if (filter.contains !== undefined && filter.contains.length > 0) {
    const needle = filter.contains;
    lines = lines.filter((l) => typeof l.msg === 'string' && l.msg.includes(needle));
  }
  if (filter.event !== undefined && filter.event.length > 0) {
    const wanted = filter.event;
    lines = lines.filter((l) => l['event'] === wanted);
  }
  if (filter.limit !== undefined && filter.limit > 0 && lines.length > filter.limit) {
    lines = lines.slice(lines.length - filter.limit);
  }
  return lines;
}

/** Drop every retained line; returns how many went. */
export function clearDevLogTail(): number {
  const dropped = devLogRing.length;
  devLogRing.length = 0;
  return dropped;
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const options: LoggerOptions = {
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    // Defense-in-depth: even if a credential header sneaks into a log call,
    // redact it. The request logger additionally only logs a safe allowlist.
    redact: {
      paths: [
        'headers.authorization',
        'headers.cookie',
        'headers["x-origin-verify"]',
        'headers["x-bridge-token"]',
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-origin-verify"]',
        'req.headers["x-bridge-token"]',
        // VENDOR SDK ERRORS (fix wave 5, adversarial 4). pino's default `err`
        // serializer copies every enumerable key, and axios (which the Twilio
        // SDK uses) hangs the whole request `config` off the error - including
        // `headers.Authorization` (Basic base64 of the API key sid and secret)
        // and `data` (the form-encoded body: phone numbers, message text). Both
        // casings are listed because pino's redact is CASE-SENSITIVE and axios
        // writes the capitalized header name.
        //
        // This is defense in depth, not the fix: a call site that can receive a
        // vendor error must log `summarizeError(err)` (lib/errors.ts) rather
        // than the error object. Redaction only covers the paths it is told
        // about, and the next SDK will invent a new one.
        'err.config.headers.Authorization',
        'err.config.headers.authorization',
        'err.config.data',
        'err.response.config.headers.Authorization',
        'err.response.config.headers.authorization',
        'err.response.config.data',
        // THE REQUEST OBJECT CARRIES THE SAME CREDENTIAL (fix wave 2,
        // adversarial 5). axios also sets `this.request = request`, and Node's
        // `http.ClientRequest` has an OWN-ENUMERABLE `_header`: the entire
        // serialized request head, `Authorization: Basic <base64(sid:secret)>`
        // included. The wave-1 list covered `config` only, so every generic
        // `log.error({ err })` on a NETWORK-failed Twilio call - the Express
        // error handler among them - still wrote the credential. `response.data`
        // is listed for the same reason: it is the vendor's own echo of the
        // request on some failures.
        'err.request._header',
        'err.request._headers',
        'err.response.request._header',
        'err.response.request._headers',
        'err.response.data',
      ],
      censor: '[REDACTED]',
    },
    // Inject the active correlation context into every line.
    mixin() {
      const ctx = getContext();
      if (!ctx) return {};
      const correlationId = ctx.jobRunId ?? ctx.pollRunId ?? ctx.requestId ?? ctx.bootId;
      return correlationId !== undefined ? { ...ctx, correlationId } : { ...ctx };
    },
  };
  // The injected-destination branch is UNTOUCHED: unit tests that capture
  // output must keep seeing exactly what they wrote to.
  if (opts.destination) return pino(options, opts.destination);
  // Hermetic-local only (S8/T8.0). A deployed process takes the original path.
  if (devLogTailEnabled()) return pino(options, createDevLogTailStream());
  return pino(options);
}

/** Default process-wide logger (JSON to stdout). */
export const logger: Logger = createLogger();

/**
 * True when a parsed JSON log line has no correlationId — an "orphan log".
 * M0.4's CloudWatch metric filter counts lines matching this predicate
 * (pattern: JSON log lines missing `correlationId`).
 */
export function isOrphanLogLine(parsedLine: Record<string, unknown>): boolean {
  const id = parsedLine['correlationId'];
  return typeof id !== 'string' || id.length === 0;
}
