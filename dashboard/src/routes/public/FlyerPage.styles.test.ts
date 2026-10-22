// FlyerPage.module.css source pins (flyer-leads D3). The unit tests run with
// `css: false` (vite.config.ts), so no test can measure the page; these pins
// keep the rules in place, and the e2e flyer spec checks the 320px wrap in a
// real browser. Same mechanism as routes/inbox/InboxRow.styles.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(testDir, 'FlyerPage.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// The TOP-LEVEL rule for `selector`, anchored on a line start.
function bodyOf(selector: string): string {
  const match = css.match(new RegExp(`(?:^|\\n)\\${selector}\\s*\\{([^}]*)\\}`));
  expect(match, `missing CSS rule for ${selector}`).not.toBeNull();
  return match![1]!;
}

describe('FlyerPage.module.css (flyer-leads D3)', () => {
  it('the address heading link is one block: the whole heading is the tap target', () => {
    expect(bodyOf('.headingLink')).toMatch(/(?:^|\s)display:\s*block\s*;/);
  });

  it('the heading wraps instead of overflowing its card at 320px', () => {
    expect(bodyOf('.headingLink')).toMatch(/overflow-wrap:\s*anywhere\s*;/);
    // The plain-text fallback heading too (a long area name).
    expect(bodyOf('.title')).toMatch(/overflow-wrap:\s*anywhere\s*;/);
  });

  // Code review R2 N4: the area line under an address heading is new on this
  // branch; a long unbroken area token must wrap like the heading above it
  // rather than run past the card at 320px.
  it('the area line under the address heading wraps too', () => {
    expect(bodyOf('.area')).toMatch(/overflow-wrap:\s*anywhere\s*;/);
  });

  it('the housing authority line is bold, larger than body text (--fs-md) and full-contrast', () => {
    const body = bodyOf('.authorities');
    expect(body).toMatch(/font-weight:\s*var\(--fw-bold\)\s*;/);
    expect(body).toMatch(/font-size:\s*var\(--fs-(?:lg|xl|2xl)\)\s*;/);
    expect(body).toMatch(/(?:^|[\s;])color:\s*var\(--c-text\)\s*;/);
  });

  it('"Same-day tours available" is a highlighted line', () => {
    const body = bodyOf('.highlight');
    expect(body).toMatch(/background:\s*var\(--c-brand-soft\)\s*;/);
    expect(body).toMatch(/font-weight:\s*var\(--fw-semibold\)\s*;/);
    expect(body).toMatch(/(?:^|[\s;])color:\s*var\(--c-text\)\s*;/);
  });

  // Worklist OR-9: spec D3 item 2 - "a second, smaller line" under the street
  // line (the h1 is --fs-xl).
  it('the city line is smaller than the street line', () => {
    expect(bodyOf('.addressTitle')).toMatch(/font-size:\s*var\(--fs-xl\)\s*;/);
    expect(bodyOf('.subline')).toMatch(/font-size:\s*var\(--fs-(?:sm|md)\)\s*;/);
  });
});
