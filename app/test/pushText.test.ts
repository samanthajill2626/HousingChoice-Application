// pushText - the server-side code-point caps for push notification copy
// (spec D12). Pure function: table-free, no fakes, no I/O.
import { describe, expect, it } from 'vitest';
import { capPushText, PUSH_BODY_MAX, PUSH_TITLE_MAX } from '../src/lib/pushText.js';

describe('capPushText', () => {
  it('returns short text unchanged', () => {
    expect(capPushText('hello', 10)).toBe('hello');
  });

  it('returns text exactly at the cap unchanged', () => {
    expect(capPushText('a'.repeat(10), 10)).toBe('a'.repeat(10));
  });

  it('truncates over-cap text; result INCLUDING the suffix equals the cap', () => {
    const out = capPushText('a'.repeat(11), 10);
    expect(out).toBe('a'.repeat(7) + '...');
    expect(Array.from(out).length).toBe(10);
  });

  it('counts code points, never splitting a surrogate pair', () => {
    // 6 emoji (each one code point, two UTF-16 units) over a cap of 5
    const out = capPushText('\u{1F600}'.repeat(6), 5);
    expect(out).toBe('\u{1F600}'.repeat(2) + '...');
    expect(Array.from(out).length).toBe(5);
  });

  it('never exceeds a cap too small for the suffix', () => {
    expect(capPushText('abcdef', 2)).toBe('ab');
    expect(Array.from(capPushText('abcdef', 3)).length).toBe(3);
  });

  it('exports the spec caps', () => {
    expect(PUSH_TITLE_MAX).toBe(100);
    expect(PUSH_BODY_MAX).toBe(300);
  });
});
