import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmailHtmlFrame, buildFramedEmailHtml } from './EmailHtmlFrame.js';

// The exact CSP meta the plan (review F16) mandates - kept verbatim so a drift
// in the component's string fails this pin.
const CSP_META =
  '<meta http-equiv="Content-Security-Policy" ' +
  "content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'\">";

describe('buildFramedEmailHtml', () => {
  it('PREPENDS the exact CSP meta to the sanitized html (F16 guarantee)', () => {
    const framed = buildFramedEmailHtml('<p>hello</p>');
    // The CSP must be present AND first - it only governs the document when it
    // leads the srcDoc.
    expect(framed).toContain(CSP_META);
    expect(framed.startsWith(CSP_META)).toBe(true);
    expect(framed).toBe(`${CSP_META}<p>hello</p>`);
  });

  it('locks the frame to data: images only (no remote trackers) with no network origins', () => {
    const framed = buildFramedEmailHtml('<img src="https://tracker.example/pixel.gif">');
    // The remote <img> stays in the markup, but the CSP forbids its fetch.
    expect(framed).toContain("default-src 'none'");
    expect(framed).toContain('img-src data:');
    expect(framed).toContain("style-src 'unsafe-inline'");
  });

  it('does not swallow the (already-sanitized) body', () => {
    expect(buildFramedEmailHtml('')).toBe(CSP_META);
    expect(buildFramedEmailHtml('<b>x</b>')).toContain('<b>x</b>');
  });
});

describe('EmailHtmlFrame', () => {
  it('renders an iframe with an EMPTY sandbox (no scripts, no same-origin) and the framed srcDoc', () => {
    render(<EmailHtmlFrame html="<p>body</p>" />);
    const frame = screen.getByTitle('Email message');
    expect(frame.tagName).toBe('IFRAME');
    // Empty sandbox: NO allow-scripts, NO allow-same-origin -> maximum isolation.
    expect(frame).toHaveAttribute('sandbox', '');
    // The HTML is delivered via srcDoc (never dangerouslySetInnerHTML), CSP first.
    const srcdoc = frame.getAttribute('srcdoc') ?? '';
    expect(srcdoc.startsWith(CSP_META)).toBe(true);
    expect(srcdoc).toContain('<p>body</p>');
  });

  it('carries a script-bearing body inertly inside srcDoc (the sandbox + CSP make it safe)', () => {
    // The script text is present in the srcDoc string, but an empty sandbox means
    // it never executes (B8's e2e asserts no dialog fires end-to-end).
    render(<EmailHtmlFrame html={'<script>alert(1)</script><p>hi</p>'} />);
    const frame = screen.getByTitle('Email message');
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame.getAttribute('srcdoc') ?? '').toContain('<p>hi</p>');
  });
});
