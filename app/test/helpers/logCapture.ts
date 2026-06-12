// Test helper: a pino destination stream that captures parsed JSON log lines
// in memory. Designed for lib/logger.ts's injectable destination — no
// stdout monkey-patching.
import { Writable } from 'node:stream';

export interface LogCapture {
  stream: Writable;
  /** Parsed JSON log lines, in emit order. */
  lines: Record<string, unknown>[];
  /** Lines at or above pino level n (warn = 40, error = 50, fatal = 60). */
  atLevel(level: number): Record<string, unknown>[];
}

export function createLogCapture(): LogCapture {
  const lines: Record<string, unknown>[] = [];
  let buffer = '';
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        }
        newline = buffer.indexOf('\n');
      }
      callback();
    },
  });
  return {
    stream,
    lines,
    atLevel(level: number) {
      return lines.filter((l) => l['level'] === level);
    },
  };
}
