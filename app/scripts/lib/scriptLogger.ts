// Plain-text output for operator scripts run by hand in a terminal.
//
// The app logger (src/lib/logger.ts) writes one pino JSON object per line -
// level, time, pid and hostname on every line - which suits CloudWatch but is
// hard to read at a prompt. This logger is the SAME pino logger (same
// serializers and redaction, so `{ err }` stays safe) with a destination that
// re-prints each line as text: the message, then each field on its own
// indented line, nested objects indented under their key. Ordinary lines
// carry no level; a warning or error starts with WARN or ERROR.
//
// Scripts opt in one at a time (today: backfill-last-reached-out.ts). Tests
// keep injecting their own capturing logger, so they still read JSON.
import type { DestinationStream } from 'pino';
import { createLogger, type Logger } from '../../src/lib/logger.js';

/** pino's own fields, and the correlation context the mixin adds - never shown. */
const HIDDEN_KEYS = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'correlationId']);

/** pino numeric levels: warn is 40, error 50, fatal 60. */
function levelPrefix(level: unknown): string {
  if (typeof level !== 'number') return '';
  if (level >= 50) return 'ERROR ';
  if (level >= 40) return 'WARN ';
  return '';
}

function isPlain(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function formatField(key: string, value: unknown, indent: string): string[] {
  if (typeof value === 'string' && value.includes('\n')) {
    return [`${indent}${key}:`, ...value.split('\n').map((line) => `${indent}  ${line}`)];
  }
  if (isPlain(value)) return [`${indent}${key}: ${String(value)}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}${key}: (none)`];
    if (value.every(isPlain)) return [`${indent}${key}: ${value.map(String).join(', ')}`];
    return [
      `${indent}${key}:`,
      ...value.flatMap((item, i) => formatField(`[${i}]`, item, `${indent}  `)),
    ];
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [`${indent}${key}: (none)`];
    return [`${indent}${key}:`, ...entries.flatMap(([k, v]) => formatField(k, v, `${indent}  `))];
  }
  return [`${indent}${key}: ${String(value)}`];
}

/**
 * One pino JSON line -> readable text (no trailing newline). A line that is
 * not a JSON object passes through unchanged.
 */
export function formatLogLine(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return line;
  const record = parsed as Record<string, unknown>;
  const head = `${levelPrefix(record.level)}${typeof record.msg === 'string' ? record.msg : ''}`;
  const fields = Object.entries(record)
    .filter(([key]) => !HIDDEN_KEYS.has(key))
    .flatMap(([key, value]) => formatField(key, value, '  '));
  return [head, ...fields].join('\n');
}

/** A pino destination that writes each line through formatLogLine. */
export function createTextDestination(out: { write(text: string): unknown } = process.stdout): DestinationStream {
  return {
    write(chunk: string) {
      for (const line of chunk.split('\n')) {
        if (line.length > 0) out.write(`${formatLogLine(line)}\n`);
      }
    },
  };
}

/** The script logger: the app logger's options, printed as plain text. */
export function createScriptLogger(out?: { write(text: string): unknown }): Logger {
  return createLogger({ destination: createTextDestination(out) });
}
