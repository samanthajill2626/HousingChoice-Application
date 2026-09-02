import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  LinkifiedText,
  tokenizeLinkifiedText,
  type LinkifiedToken,
} from './LinkifiedText.js';

vi.mock('../lib/safeUrl.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/safeUrl.js')>(
    '../lib/safeUrl.js',
  );
  return {
    ...actual,
    safeHttpUrl: (url: string | null | undefined) =>
      url === 'https://reject.com/path' ? null : actual.safeHttpUrl(url),
  };
});

const links = (text: string, displayEnd?: number) =>
  tokenizeLinkifiedText(text, displayEnd).filter(
    (token): token is Extract<LinkifiedToken, { kind: 'link' }> => token.kind === 'link',
  );

const textTokens = (text: string) =>
  tokenizeLinkifiedText(text).filter(
    (token): token is Extract<LinkifiedToken, { kind: 'text' }> => token.kind === 'text',
  );

describe('tokenizeLinkifiedText', () => {
  it.each([
    ['https://example.com/a?x=1#top', 'https://example.com/a?x=1#top'],
    ['http://example.com/a', 'http://example.com/a'],
    ['//example.com/a', 'https://example.com/a'],
    ['www.example.com/a', 'https://www.example.com/a'],
    ['example.com:8443/a?x=1#top', 'https://example.com:8443/a?x=1#top'],
  ])('normalizes %s to %s', (source, href) => {
    expect(links(source)).toEqual([
      expect.objectContaining({ kind: 'link', text: source, href }),
    ]);
  });

  it('retains link order and distinct offsets for repeated source URLs', () => {
    const source = 'one example.com/a then example.com/a and https://example.org/z';
    expect(links(source)).toEqual([
      expect.objectContaining({ start: 4, text: 'example.com/a', href: 'https://example.com/a' }),
      expect.objectContaining({ start: 23, text: 'example.com/a', href: 'https://example.com/a' }),
      expect.objectContaining({ start: 41, text: 'https://example.org/z', href: 'https://example.org/z' }),
    ]);
  });

  it('keeps parser-owned punctuation and bracket boundaries as text', () => {
    const source = '(example.com/a), [example.com/bracket/path] \uFF3Bexample.com/full-width-path\uFF3D example.com/a\u3002 example.com/a\uFF0C example.com/a\u3001';
    const expectedTexts = ['(', '), [', '] \uFF3B', '\uFF3D ', '\u3002 ', '\uFF0C ', '\u3001'];
    expect(links(source).map(({ text }) => text)).toEqual([
      'example.com/a',
      'example.com/bracket/path',
      'example.com/full-width-path',
      'example.com/a',
      'example.com/a',
      'example.com/a',
    ]);
    expect(textTokens(source).map(({ text }) => text)).toEqual(expectedTexts);
  });

  it('recognizes public current and international domains without a local suffix list', () => {
    const source = 'housing.zip/path example.dev/units \u4F8B\u5B50.\u516C\u53F8/path';
    expect(links(source).map(({ text, href }) => ({ text, href }))).toEqual([
      { text: 'housing.zip/path', href: 'https://housing.zip/path' },
      { text: 'example.dev/units', href: 'https://example.dev/units' },
      { text: '\u4F8B\u5B50.\u516C\u53F8/path', href: 'https://xn--fsqu00a.xn--55qx5d/path' },
    ]);
  });

  it('keeps non-web identifiers and local fuzzy forms as plain text', () => {
    const source = 'localhost server 192.0.2.1 renter@example.com +1-555-010-0001 //localhost/a';
    expect(links(source)).toEqual([]);
    expect(textTokens(source).map(({ text }) => text).join('')).toBe(source);
  });

  it('allows explicit HTTP localhost URLs but leaves protocol-relative localhost text', () => {
    const source = 'http://localhost:5174/a https://localhost/a //localhost/a';
    expect(links(source).map(({ text, href }) => ({ text, href }))).toEqual([
      { text: 'http://localhost:5174/a', href: 'http://localhost:5174/a' },
      { text: 'https://localhost/a', href: 'https://localhost/a' },
    ]);
    expect(textTokens(source).map(({ text }) => text).join('')).toContain('//localhost/a');
  });

  it('degrades parser-recognized unsupported schemes to exact text', () => {
    const source = 'javascript:example.com mailto:renter@example.com ftp://example.com data:text/html,example.com javascript://example.com/a data://example.com/a vbscript://example.com/a foo://example.com/a';
    expect(links(source)).toEqual([]);
    expect(textTokens(source).map(({ text }) => text).join('')).toBe(source);
  });

  it.each(['http:example.com/a', 'https:example.com/a', 'http:///example.com/a'])(
    'keeps malformed HTTP scheme source %s as exact text',
    (source) => {
      expect(links(source)).toEqual([]);
      expect(textTokens(source).map(({ text }) => text).join('')).toBe(source);
    },
  );

  it('preserves the exact source when the final safety boundary rejects a match', () => {
    expect(tokenizeLinkifiedText('before reject.com/path after')).toEqual([
      { kind: 'text', start: 0, end: 7, text: 'before ' },
      { kind: 'text', start: 7, end: 22, text: 'reject.com/path' },
      { kind: 'text', start: 22, end: 28, text: ' after' },
    ]);
  });

  it.each([
    ['<script>https://example.com/a</script>', 8],
    ['<a>https://example.com/a</a>', 3],
    ['<!-- https://example.com/a -->', 5],
  ])('links raw markup-shaped literals at source offset %i', (source, start) => {
    expect(links(source)).toEqual([
      expect.objectContaining({ start, text: 'https://example.com/a', href: 'https://example.com/a' }),
    ]);
    expect(textTokens(source).map(({ text }) => text).join('')).toBe(source.replace('https://example.com/a', ''));
  });

  it('keeps a literal amp entity in an explicit target and across a display boundary', () => {
    const url = 'https://example.com/?x=1&amp;y=2';
    const source = `${'x'.repeat(126)}${url}`;
    expect(links(source, 140)).toEqual([
      expect.objectContaining({ text: source.slice(126, 140), href: url }),
    ]);
  });

  it('keeps the complete href when the display boundary cuts through a URL', () => {
    const prefix = ' '.repeat(126);
    const url = 'example.com/a/complete/path?unit=2#photos';
    const source = `${prefix}${url} after`;
    expect(links(source, 140)).toEqual([
      expect.objectContaining({ text: source.slice(126, 140), href: `https://${url}` }),
    ]);
  });
});

describe('LinkifiedText', () => {
  it('renders non-link tokens as direct text nodes without span wrappers', () => {
    const { container } = render(
      <div>
        <LinkifiedText text="before example.com after" />
      </div>,
    );
    const host = container.firstElementChild!;

    expect(host.childNodes).toHaveLength(3);
    expect(host.childNodes[0]).toMatchObject({ nodeType: Node.TEXT_NODE, nodeValue: 'before ' });
    expect(host.childNodes[2]).toMatchObject({ nodeType: Node.TEXT_NODE, nodeValue: ' after' });
    expect(host.querySelector('span')).toBeNull();
  });

  it('renders escaped source text and accessible safe anchors without a visible wrapper', () => {
    const { container } = render(
      <div>
        <LinkifiedText text={'<img src=x onerror=alert(1)> example.com'} />
      </div>,
    );
    const link = screen.getByRole('link', { name: 'example.com' });
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('<img src=x onerror=alert(1)> example.com');
    expect(link).toHaveAttribute('href', 'https://example.com/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('stops an anchor click from propagating to its container', () => {
    const onClick = vi.fn();
    render(
      <div onClick={onClick}>
        <LinkifiedText text="example.com" />
      </div>,
    );
    screen.getByRole('link', { name: 'example.com' }).click();
    expect(onClick).not.toHaveBeenCalled();
  });
});
