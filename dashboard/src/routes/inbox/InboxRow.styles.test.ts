import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Source-reading pins for the row's layout rules (spec 5.4). The unit tests
// run with `css: false`, so no test can measure the row; the live self-QA
// measures the geometry, and these pins keep the rules it measured in place.
const testDir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(testDir, 'InboxRow.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// The TOP-LEVEL rule for `selector`. Anchored on a line start, so `.tag` never
// matches `.placementTag` or `.deletedTag`, and the indented rules inside the
// narrow media query never match.
function bodyOf(selector: string): string {
  const match = css.match(new RegExp(`(?:^|\\n)\\${selector}\\s*\\{([^}]*)\\}`));
  expect(match, `missing CSS rule for ${selector}`).not.toBeNull();
  return match![1]!;
}

describe('InboxRow.module.css', () => {
  it('the one-line head is min(content, 45%) and never shrinks further (R2-1)', () => {
    const head = bodyOf('.head');
    expect(head).toMatch(/(?:^|\s)flex:\s*0 0 auto\s*;/);
    expect(head).toMatch(/max-width:\s*45%\s*;/);
  });

  it('the time column holds "Dec 18, 2025" (5rem)', () => {
    expect(bodyOf('.time')).toMatch(/min-width:\s*5rem\s*;/);
  });

  it('the two-line layout keys on the shell breakpoint', () => {
    expect(css).toContain('@media (max-width: 767.98px)');
  });

  // The chip rule (build review R3-1): two chips yield before the name, never
  // below 4em; a `min-width: 0` there collapses a short tag to one clipped
  // letter.
  it.each(['.placementTag', '.triage'])('%s yields before the name with a 4em floor', (selector) => {
    const body = bodyOf(selector);
    expect(body).toMatch(/min-width:\s*4em\s*;/);
    expect(body).toMatch(/flex-shrink:\s*100\s*;/);
    expect(body).toMatch(/overflow:\s*hidden\s*;/);
    expect(body).toMatch(/text-overflow:\s*ellipsis\s*;/);
    expect(body).not.toMatch(/min-width:\s*0/);
  });

  it.each(['.tag', '.deletedTag', '.channel'])('%s is a rigid state marker: no flex-shrink, no min-width: 0', (selector) => {
    const body = bodyOf(selector);
    expect(body).not.toMatch(/flex-shrink/);
    expect(body).not.toMatch(/min-width:\s*0/);
  });

  it('the actions box is an overlay that takes no layout width', () => {
    expect(bodyOf('.actions')).toMatch(/position:\s*absolute\s*;/);
    // ... positioned against the ROW. Without this the overlay would anchor
    // to the nearest positioned ancestor outside the row (planner review,
    // adversarial 11).
    expect(bodyOf('.row')).toMatch(/position:\s*relative\s*;/);
  });

  // Live self-QA 2026-09-26: with the yielding chips at flex-shrink 100 the
  // name still kept a ~1% share of the shortfall, overflowed by a sub-pixel,
  // and text-overflow swallowed the last digit of a phone-named row.
  it('a phone-named row never shrinks its number', () => {
    expect(bodyOf('.numberName')).toMatch(/flex-shrink:\s*0\s*;/);
  });
});
