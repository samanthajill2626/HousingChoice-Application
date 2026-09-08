import { describe, expect, it } from 'vitest';
import { readMaintenanceCopy, renderMaintenancePage } from './maintenancePage.js';

describe('maintenance page template', () => {
  it('renders the canonical copy with no executable or app asset dependency', () => {
    const copy = readMaintenanceCopy();
    expect(copy).toEqual({
      brand: 'HousingChoice',
      title: 'HousingChoice - Temporarily unavailable',
      heading: 'Temporarily unavailable',
      body: 'HousingChoice is temporarily unavailable. Please try again shortly.',
      action: 'Try again',
    });
    const html = renderMaintenancePage();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('data-hc-maintenance="1"');
    expect(html).toContain('<h1>Temporarily unavailable</h1>');
    expect(html).toContain(copy.body);
    expect(html).toContain('<p class="brand">' + copy.brand + '</p>');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('href="/"');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<(script|img|iframe|form|link)\b/i);
    expect(html).not.toMatch(/\b(src|srcset|on[a-z]+)\s*=/i);
    expect(html).not.toMatch(/http-equiv=["']refresh/i);
    expect(html).not.toContain('${');
  });

  it('escapes copy as text, including template-looking input', () => {
    const special = '& <script> "quote" \'apostrophe\' ${not_code} %{not_code}';
    const html = renderMaintenancePage({
      ...readMaintenanceCopy(),
      brand: special,
      action: special,
      heading: special,
      body: special,
      title: special,
    });
    expect(html).toContain('&amp; &lt;script&gt; &quot;quote&quot; &#39;apostrophe&#39;');
    expect(html).toContain('${not_code} %{not_code}');
    expect(html).not.toContain('<script>');
    const escaped = '&amp; &lt;script&gt; &quot;quote&quot; &#39;apostrophe&#39; ${not_code} %{not_code}';
    for (const [open, close] of [
      ['<title>', '</title>'], ['<p class="brand">', '</p>'], ['<h1>', '</h1>'],
      ['<p class="message">', '</p>'], ['<a class="action" href="/">', '</a>'],
    ]) {
      expect(html).toContain(open + escaped + close);
    }
  });

  it('rejects missing, additional, non-string, empty or non-ASCII copy', () => {
    const copy = readMaintenanceCopy();
    for (const malformed of [
      { ...copy, heading: '' },
      { ...copy, heading: '   ' },
      { ...copy, heading: 123 },
      { ...copy, heading: '\u00e9' },
      { ...copy, extra: 'not allowed' },
      { body: copy.body },
    ]) {
      expect(() => renderMaintenancePage(malformed as unknown as typeof copy))
        .toThrow(/maintenance copy/);
    }
  });
});
