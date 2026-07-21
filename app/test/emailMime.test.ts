// B2 unit tests: lib/emailMime - parseInboundMime / sanitizeEmailHtml /
// visibleReplyText / extractReplyToken. Drives the REAL libraries (mailparser,
// sanitize-html, email-reply-parser) over hand-built raw MIME strings - no
// network, no fixtures on disk. The visibleReplyText tests double as the
// RUNTIME proof that the email-reply-parser default-import shape actually
// constructs and parses (the plan's `.default` interop footgun): a wrong import
// shape would throw right here, not just fail a type-check.
import { describe, expect, it } from 'vitest';
import {
  extractReplyToken,
  parseInboundMime,
  sanitizeEmailHtml,
  visibleReplyText,
} from '../src/lib/emailMime.js';

const CRLF = '\r\n';

function raw(lines: string[]): Buffer {
  return Buffer.from(lines.join(CRLF), 'utf8');
}

describe('parseInboundMime', () => {
  it('parses a multipart mail: id/from/to/cc/subject/text + a decoded attachment', async () => {
    const mail = raw([
      'From: Alice Sender <alice@example.com>',
      'To: Team <team@mail.test>, relay+TOK123@mail.test',
      'Cc: bob@other.test',
      'Subject: Lease documents',
      'Message-ID: <abc-123@example.com>',
      'In-Reply-To: <hc-1@mail.test>',
      'References: <hc-0@mail.test> <hc-1@mail.test>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary=BB',
      '',
      '--BB',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Here are the documents.',
      '--BB',
      'Content-Type: application/pdf',
      'Content-Disposition: attachment; filename="lease.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'JVBERg==',
      '--BB--',
      '',
    ]);
    const parsed = await parseInboundMime(mail);
    expect(parsed.rfcMessageId).toBe('<abc-123@example.com>');
    expect(parsed.from).toEqual({ name: 'Alice Sender', address: 'alice@example.com' });
    expect(parsed.to).toEqual(['team@mail.test', 'relay+TOK123@mail.test']);
    expect(parsed.cc).toEqual(['bob@other.test']);
    expect(parsed.subject).toBe('Lease documents');
    expect(parsed.inReplyTo).toBe('<hc-1@mail.test>');
    expect(parsed.references).toEqual(['<hc-0@mail.test>', '<hc-1@mail.test>']);
    expect(parsed.text).toContain('Here are the documents.');
    expect(parsed.attachments).toHaveLength(1);
    const att = parsed.attachments[0]!;
    expect(att.filename).toBe('lease.pdf');
    expect(att.contentType).toBe('application/pdf');
    expect(att.size).toBe(4); // decoded byte length of JVBERg==
    expect(att.content.equals(Buffer.from('JVBERg==', 'base64'))).toBe(true);
  });

  it('synthesizes a DETERMINISTIC sha256 Message-ID when the header is missing', async () => {
    const mail = raw(['From: a@b.co', 'To: t@x.yz', 'Subject: s', '', 'body', '']);
    const first = await parseInboundMime(mail);
    const again = await parseInboundMime(mail);
    expect(first.rfcMessageId).toMatch(/^<[0-9a-f]{64}@synthesized\.local>$/);
    // Same raw bytes -> same id (redeliveries of an id-less mail still dedupe).
    expect(again.rfcMessageId).toBe(first.rfcMessageId);
    // Different raw bytes -> different id.
    const other = await parseInboundMime(raw(['From: a@b.co', 'To: t@x.yz', 'Subject: s2', '', 'body2', '']));
    expect(other.rfcMessageId).not.toBe(first.rfcMessageId);
  });

  it('unfolds folded headers (RFC 5322 continuation lines) in To and Subject', async () => {
    const mail = raw([
      'From: a@b.co',
      'To: Team <team@mail.test>,',
      ' relay+TOK123@mail.test',
      'Subject: A very long',
      ' folded subject',
      'Message-ID: <fold@x.yz>',
      '',
      'body',
      '',
    ]);
    const parsed = await parseInboundMime(mail);
    expect(parsed.to).toEqual(['team@mail.test', 'relay+TOK123@mail.test']);
    expect(parsed.subject).toBe('A very long folded subject');
  });

  it('normalizes references: a single reference (string from mailparser) becomes a one-element array', async () => {
    const single = await parseInboundMime(
      raw(['From: a@b.co', 'To: t@x.yz', 'References: <one@x.yz>', 'Subject: s', '', 'body', '']),
    );
    expect(single.references).toEqual(['<one@x.yz>']);
    const none = await parseInboundMime(raw(['From: a@b.co', 'To: t@x.yz', 'Subject: s', '', 'body', '']));
    expect(none.references).toEqual([]);
    expect(none.inReplyTo).toBeUndefined();
  });

  it('falls back to mailparser text-from-html for an html-only mail, and surfaces the html', async () => {
    const mail = raw([
      'From: a@b.co',
      'To: t@x.yz',
      'Subject: html only',
      'Message-ID: <h@x.yz>',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><body><p>Hello <b>world</b></p></body></html>',
      '',
    ]);
    const parsed = await parseInboundMime(mail);
    expect(parsed.text).toContain('Hello world');
    expect(parsed.html).toContain('<p>Hello <b>world</b></p>');
  });

  it('defaults a missing subject to the empty string and a nameless attachment to attachment-<i>', async () => {
    const mail = raw([
      'From: a@b.co',
      'To: t@x.yz',
      'Message-ID: <noname@x.yz>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary=BB',
      '',
      '--BB',
      'Content-Type: text/plain',
      '',
      'hi',
      '--BB',
      'Content-Type: application/octet-stream',
      'Content-Disposition: attachment',
      'Content-Transfer-Encoding: base64',
      '',
      'AAAA',
      '--BB--',
      '',
    ]);
    const parsed = await parseInboundMime(mail);
    expect(parsed.subject).toBe('');
    expect(parsed.attachments[0]!.filename).toBe('attachment-0');
  });
});

describe('sanitizeEmailHtml', () => {
  it('strips script tags, event handlers, javascript: hrefs, and remote image sources', () => {
    const dirty =
      '<p>ok</p><script>alert(1)</script>' +
      '<img src="https://evil.test/t.gif">' +
      '<a href="javascript:alert(1)">x</a>' +
      '<div onerror="x" onclick="y">d</div>';
    const clean = sanitizeEmailHtml(dirty);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('alert(1)');
    expect(clean).not.toContain('evil.test');
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('onerror');
    expect(clean).not.toContain('onclick');
    expect(clean).toContain('<p>ok</p>');
  });

  it('keeps data: and cid: image sources (the two allowed schemes)', () => {
    const clean = sanitizeEmailHtml(
      '<img src="data:image/png;base64,AAAA"><img src="cid:part1@x.yz">',
    );
    expect(clean).toContain('data:image/png;base64,AAAA');
    expect(clean).toContain('cid:part1@x.yz');
  });

  it('strips PROTOCOL-RELATIVE image src and srcset (no remote tracker survives sanitize) - adv M1', () => {
    const clean = sanitizeEmailHtml(
      '<img src="//tracker.evil/pixel.png">' +
        '<img srcset="//tracker.evil/1x.png 1x, https://tracker.evil/2x.png 2x">',
    );
    expect(clean).not.toContain('tracker.evil');
    expect(clean).not.toContain('srcset');
  });
});

describe('visibleReplyText', () => {
  it('returns only the visible (unquoted) text of a real quoted reply - runtime import proof', () => {
    const text = [
      'Sounds good, see you then!',
      '',
      'On Mon, Jul 20, 2026 at 9:00 AM Team <team@mail.test> wrote:',
      '> Can you make the tour at 3pm?',
      '> The address is 12 Main St.',
      '',
    ].join('\n');
    expect(visibleReplyText(text)).toBe('Sounds good, see you then!');
  });

  it('falls back to the full (trimmed) text when the visible part is empty', () => {
    const allQuote = ['> only quoted lines', '> nothing new', ''].join('\n');
    expect(visibleReplyText(allQuote)).toBe(allQuote.trim());
  });

  it('returns the empty string for an empty body', () => {
    expect(visibleReplyText('')).toBe('');
  });
});

describe('extractReplyToken', () => {
  it('extracts the token from relay+<token>@<senderDomain> in any position', () => {
    expect(
      extractReplyToken(['team@mail.test', 'relay+AbC-123_x@mail.test'], 'mail.test'),
    ).toBe('AbC-123_x');
  });

  it('matches the relay prefix and domain case-insensitively but PRESERVES token case', () => {
    expect(extractReplyToken(['RELAY+TokenCase@MAIL.TEST'], 'mail.test')).toBe('TokenCase');
  });

  it('returns undefined for other domains, plain addresses, and malformed entries', () => {
    expect(extractReplyToken(['relay+tok@other.test'], 'mail.test')).toBeUndefined();
    expect(extractReplyToken(['team@mail.test'], 'mail.test')).toBeUndefined();
    expect(extractReplyToken(['relay+@mail.test'], 'mail.test')).toBeUndefined();
    expect(extractReplyToken(['not-an-address'], 'mail.test')).toBeUndefined();
    expect(extractReplyToken([], 'mail.test')).toBeUndefined();
  });
});
