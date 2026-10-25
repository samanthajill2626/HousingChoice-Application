import { describe, expect, it } from 'vitest';
import { createScriptLogger, formatLogLine } from '../scripts/lib/scriptLogger.js';

describe('scriptLogger', () => {
  it('drops level, time, pid, hostname and correlationId and prints the message first', () => {
    const line = JSON.stringify({
      level: 30,
      time: 1792947322110,
      pid: 123,
      hostname: 'box',
      correlationId: 'c-1',
      target: 'dev',
      msg: 'backfill - starting',
    });
    expect(formatLogLine(line)).toBe('backfill - starting\n  target: dev');
  });

  it('indents nested objects under their key and marks empty ones', () => {
    const line = JSON.stringify({
      level: 30,
      msg: 'done',
      counted: { text: 3, email: 0 },
      rowsSkipped: {},
      planned: 2,
    });
    expect(formatLogLine(line)).toBe(
      ['done', '  counted:', '    text: 3', '    email: 0', '  rowsSkipped: (none)', '  planned: 2'].join('\n'),
    );
  });

  it('prefixes warnings and errors only', () => {
    expect(formatLogLine(JSON.stringify({ level: 40, msg: 'careful' }))).toBe('WARN careful');
    expect(formatLogLine(JSON.stringify({ level: 50, msg: 'broke' }))).toBe('ERROR broke');
  });

  it('prints arrays inline, multi-line strings indented, and non-JSON unchanged', () => {
    const line = JSON.stringify({ level: 30, msg: 'm', ids: ['a', 'b'], none: [], stack: 'Error: x\n    at y' });
    expect(formatLogLine(line)).toBe(
      ['m', '  ids: a, b', '  none: (none)', '  stack:', '    Error: x', '        at y'].join('\n'),
    );
    expect(formatLogLine('plain text')).toBe('plain text');
  });

  it('writes through the app logger, keeping its error serializer', () => {
    const out: string[] = [];
    const log = createScriptLogger({ write: (text) => out.push(text) });
    log.error({ err: new Error('boom') }, 'failed');
    const text = out.join('');
    expect(text.startsWith('ERROR failed\n  err:\n')).toBe(true);
    expect(text).toContain('message: boom');
    expect(text).not.toMatch(/"level"|hostname|pid:/);
  });
});
