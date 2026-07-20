// Structured JSON logging core (pino → stdout).
//
// Every line emitted while a correlation context is active carries the full
// context plus a `correlationId` field (jobRunId ?? requestId ?? bootId).
// Lines without a correlationId are "orphan logs" — a CloudWatch metric filter
// mirrors isOrphanLogLine() below and alarms when any appear. Entrypoints wrap
// process lifecycle (boot/shutdown) in a bootId context so even those lines
// are correlated.
import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { getContext } from './context.js';

export type { Logger } from 'pino';

export interface CreateLoggerOptions {
  level?: string;
  /** Injectable destination so tests can capture output without touching stdout. */
  destination?: DestinationStream;
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
      ],
      censor: '[REDACTED]',
    },
    // Inject the active correlation context into every line.
    mixin() {
      const ctx = getContext();
      if (!ctx) return {};
      const correlationId = ctx.jobRunId ?? ctx.requestId ?? ctx.bootId;
      return correlationId !== undefined ? { ...ctx, correlationId } : { ...ctx };
    },
  };
  return opts.destination ? pino(options, opts.destination) : pino(options);
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
