// Timeline.module.css source pins (flyer-leads self-QA QA-1, code review R2
// F1). The unit tests run with `css: false` (vite.config.ts), so no test can
// measure the pane; these pins keep the rules in place, and the e2e
// flyer-leads spec measures the contact page at 1280x720 in a real browser.
// Same mechanism as routes/public/FlyerPage.styles.test.ts.
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

describe('Timeline.module.css (flyer-leads self-QA QA-1, code review R2 F1)', () => {
  // The pane is a flex: 1 item of the two-pane shell's ROW (.left). With the
  // default min-width: auto a long pin's width became the pane's minimum, so
  // the pane pushed under the right column, which painted over the reply
  // box's Send button (QA-1).
  it('the comms pane never grows past its column', () => {
    expect(bodyOf('.comms')).toMatch(/(?:^|[\s;])min-width:\s*0\s*;/);
  });

  // The same default on the pill (a flex item of .evt) kept it at its text's
  // width (QA-1). min-width: 0 lets it shrink to its row; max-width keeps it
  // inside the row.
  it('a milestone pill never grows past its row', () => {
    const body = bodyOf('.pill');
    expect(body).toMatch(/(?:^|[\s;])min-width:\s*0\s*;/);
    expect(body).toMatch(/(?:^|[\s;])max-width:\s*100%\s*;/);
  });

  // R2 F1: a pin that does not fit its row WRAPS, so the whole label - the
  // typed name at its end included (spec D6.2) - is always visible. The QA-1
  // ellipsis cut that name first, at every common width and on every phone.
  it('a long pin wraps - long words break anywhere - and nothing clips its text', () => {
    expect(bodyOf('.pill')).toMatch(/white-space:\s*normal\s*;/);
    expect(bodyOf('.pill')).not.toMatch(/white-space:\s*nowrap/);
    const text = bodyOf('.pillText');
    expect(text).toMatch(/overflow-wrap:\s*anywhere\s*;/);
    expect(text).not.toMatch(/text-overflow/);
    expect(text).not.toMatch(/(?:^|[\s;])overflow:\s*hidden/);
  });

  // A wrapped pin still reads as a pin: the radius is half a ONE-line pin's
  // height (12px text at line-height 1.5, 2px padding and a 1px border each
  // way: 24px tall), so a one-line pin keeps its round ends while a two- or
  // three-line pin is a rounded box whose corners never cut into its text -
  // --radius-pill (999px) would clamp to half the WRAPPED height. Its lines
  // are centered, like the one-line pin between its side rules, so a wrapped
  // pin never reads as a left-aligned inbound bubble.
  it('a wrapped pin keeps corners that never cut into its text, and centered lines', () => {
    const body = bodyOf('.pill');
    expect(body).toMatch(/border-radius:\s*var\(--radius-lg\)\s*;/);
    expect(body).toMatch(/text-align:\s*center\s*;/);
  });
});
