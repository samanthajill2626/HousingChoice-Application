import { describe, expect, it } from 'vitest';
import { analyzeSms } from '../src/lib/smsEncoding.js';

describe('analyzeSms', () => {
  it('plain ASCII is GSM-7, one septet per character', () => {
    const r = analyzeSms('Hello');
    expect(r.encoding).toBe('GSM-7');
    expect(r.units).toBe(5);
    expect(r.segments).toBe(1);
    expect(r.nonGsm7Chars).toEqual([]);
  });

  it('160 GSM-7 characters is one segment; 161 is two', () => {
    expect(analyzeSms('a'.repeat(160)).segments).toBe(1);
    expect(analyzeSms('a'.repeat(161)).segments).toBe(2);
  });

  it('multi-segment GSM-7 prices at 153 per part (concatenation header)', () => {
    expect(analyzeSms('a'.repeat(306)).segments).toBe(2);
    expect(analyzeSms('a'.repeat(307)).segments).toBe(3);
  });

  it('extension-table characters cost 2 septets each', () => {
    const r = analyzeSms('[]');
    expect(r.encoding).toBe('GSM-7');
    expect(r.units).toBe(4);
  });

  it('an em dash forces UCS-2 and its 70-character budget', () => {
    const r = analyzeSms('a\u2014b');
    expect(r.encoding).toBe('UCS-2');
    expect(r.nonGsm7Chars).toEqual(['\u2014']);
    expect(analyzeSms('\u2014' + 'a'.repeat(69)).segments).toBe(1);
    expect(analyzeSms('\u2014' + 'a'.repeat(70)).segments).toBe(2);
  });

  it('UCS-2 multi-segment prices at 67 per part', () => {
    expect(analyzeSms('\u2014' + 'a'.repeat(133)).segments).toBe(2);
    expect(analyzeSms('\u2014' + 'a'.repeat(134)).segments).toBe(3);
  });

  it('accented letters are GSM-7 basic, not UCS-2', () => {
    expect(analyzeSms('caf\u00E9').encoding).toBe('GSM-7');
  });
});
