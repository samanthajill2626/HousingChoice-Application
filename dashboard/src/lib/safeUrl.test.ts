import { describe, expect, it } from 'vitest';
import { safeHttpUrl } from './safeUrl.js';

describe('safeHttpUrl', () => {
  it('passes http(s) URLs through (normalized)', () => {
    expect(safeHttpUrl('https://video.example/tour')).toBe('https://video.example/tour');
    expect(safeHttpUrl('http://x.test/v')).toBe('http://x.test/v');
  });

  it('rejects script-bearing schemes (the XSS vector)', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('JavaScript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHttpUrl('vbscript:msgbox(1)')).toBeNull();
  });

  it('rejects empty / nullish / relative / unparseable', () => {
    expect(safeHttpUrl(undefined)).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl('')).toBeNull();
    expect(safeHttpUrl('/relative/path')).toBeNull();
    expect(safeHttpUrl('not a url')).toBeNull();
  });
});
