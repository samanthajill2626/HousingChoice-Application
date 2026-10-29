// WP1 B2a spec D14.1 (plan PR10): the ONE rule that puts text on one line.
// The extraction transcript line (prompt.ts renderUtteranceLine) and the
// Notes lines extraction appends (apply.ts filterNoteLines) both call it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toOneLine } from '../src/lib/singleLine.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('toOneLine', () => {
  it('turns each run of CR and LF into " / " (CRLF and repeats are one run)', () => {
    expect(toOneLine('a\nb')).toBe('a / b');
    expect(toOneLine('a\r\nb')).toBe('a / b');
    expect(toOneLine('a\rb')).toBe('a / b');
    expect(toOneLine('a\n\n\r\nb')).toBe('a / b');
    expect(toOneLine('a\nb\nc')).toBe('a / b / c');
  });

  it('folds U+2028 and U+2029 the same way, alone or inside a run', () => {
    expect(toOneLine('a\u2028b')).toBe('a / b');
    expect(toOneLine('a\u2029b')).toBe('a / b');
    expect(toOneLine('a\r\n\u2028\u2029\nb')).toBe('a / b');
  });

  it('touches nothing else: spaces beside a break, tabs and the ends stay as given (callers trim)', () => {
    expect(toOneLine('a \n b')).toBe('a  /  b');
    expect(toOneLine('\na\n')).toBe(' / a / ');
    expect(toOneLine('a\tb')).toBe('a\tb');
    expect(toOneLine('')).toBe('');
    expect(toOneLine('no break at all')).toBe('no break at all');
  });
});

describe('lib/singleLine.ts is a leaf written in ASCII (plan PR10)', () => {
  const source = (): string => readFileSync(path.join(SRC, 'lib', 'singleLine.ts'), 'utf8');

  it('imports nothing', () => {
    expect(source()).not.toMatch(/^\s*import\s/m);
    expect(source()).not.toMatch(/\sfrom\s+['"]/);
  });

  it('writes the two separators as escapes, never as raw characters', () => {
    expect(source()).toContain('\\u2028');
    expect(source()).toContain('\\u2029');
    expect([...source()].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
  });
});

describe('both callers fold with the one helper (spec D14.1, PR10)', () => {
  it('prompt.ts and apply.ts import toOneLine, and prompt.ts keeps no private copy', () => {
    const prompt = readFileSync(path.join(SRC, 'services', 'extraction', 'prompt.ts'), 'utf8');
    const apply = readFileSync(path.join(SRC, 'services', 'extraction', 'apply.ts'), 'utf8');
    expect(prompt).toContain("import { toOneLine } from '../../lib/singleLine.js';");
    expect(apply).toContain("import { toOneLine } from '../../lib/singleLine.js';");
    expect(prompt).not.toMatch(/toSingleLine/);
  });
});
