// Timeline.module.css source pins (flyer-leads self-QA QA-1). The unit tests
// run with `css: false` (vite.config.ts), so no test can measure the pane;
// these pins keep the rules in place, and the e2e flyer-leads spec measures
// the contact page at 1280x720 in a real browser. Same mechanism as
// routes/public/FlyerPage.styles.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(testDir, 'Timeline.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// The TOP-LEVEL rule for `selector`, anchored on a line start, so `.pill`
// never matches `.pillText`, `a.pill:hover` or `.green .pill`.
function bodyOf(selector: string): string {
  const match = css.match(new RegExp(`(?:^|\\n)\\${selector}\\s*\\{([^}]*)\\}`));
  expect(match, `missing CSS rule for ${selector}`).not.toBeNull();
  return match![1]!;
}

describe('Timeline.module.css (flyer-leads self-QA QA-1)', () => {
  // The pane is a flex: 1 item of the two-pane shell's ROW (.left). With the
  // default min-width: auto a nowrap pin's min-content width became the
  // pane's minimum, so a long pin pushed the pane under the right column,
  // which painted over the reply box's Send button.
  it('the comms pane never grows past its column', () => {
    expect(bodyOf('.comms')).toMatch(/(?:^|[\s;])min-width:\s*0\s*;/);
  });

  // The same default on the pill (a flex item of .evt) kept it at its text's
  // width, so .pillText's ellipsis never engaged.
  it('a milestone pill shrinks to its row so the ellipsis engages', () => {
    const body = bodyOf('.pill');
    expect(body).toMatch(/(?:^|[\s;])min-width:\s*0\s*;/);
    expect(body).toMatch(/(?:^|[\s;])max-width:\s*100%\s*;/);
  });

  // PIN (not a failing-first lever): the one-line clip the two rules above
  // unlock, so a cleanup cannot drop half of it.
  it('the pill stays one line and its text clips with an ellipsis', () => {
    expect(bodyOf('.pill')).toMatch(/white-space:\s*nowrap\s*;/);
    const text = bodyOf('.pillText');
    expect(text).toMatch(/overflow:\s*hidden\s*;/);
    expect(text).toMatch(/text-overflow:\s*ellipsis\s*;/);
  });
});
