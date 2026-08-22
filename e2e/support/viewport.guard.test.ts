// Guard: the VACUOUS horizontal-overflow idiom must not come back.
//
// `document.documentElement.scrollWidth - document.documentElement.clientWidth`
// can never be non-zero in this dashboard, so any assertion built on it passes
// unconditionally. AppFrame clamps the document to the viewport and hands
// scrolling to an inner box:
//
//   dashboard/src/index.css            html, body, #root { height: 100% }
//   AppFrame.module.css .shell         display: flex; height: 100%
//   AppFrame.module.css .main          flex: 1; min-width: 0; height: 100%
//                                      (min-width: 0 is what stops a wide child
//                                       widening the flex row instead)
//   AppFrame.module.css .content       flex: 1; overflow-y: auto
//
// and per CSS Overflow L3 a `visible` other axis computes to `auto` once one
// axis is not visible/clip, so `.content` scrolls on BOTH axes. Route content
// that runs too wide therefore scrolls INSIDE <main> and the document never
// moves.
//
// `expectNoHorizontalOverflow` measures the document AND the routed <main> and
// asserts on the worse of the two, which is the honest check;
// `expectNoHorizontalOverflowIn` does the element-scoped version for a
// `position: fixed` dialog, which contributes to neither page-level box.
//
// This guard exists because the cleanup that removed the last hand-rolled copy
// would otherwise be a one-time event - the next person to write a
// narrow-viewport spec would reach for the obvious expression and get a green
// assertion that proves nothing. Making it enforceable rather than remembered
// is the same move as `DYNAMO_DISABLE_TTL` and the smoke gate's self-check.
//
// See docs/issues/e2e-documentelement-overflow-check-vacuous.md.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const e2eRoot = join(here, '..');
/** This file quotes the idiom to name it; viewport.ts is the ONE legal use. */
const ALLOWED = new Set(['support\\viewport.ts', 'support/viewport.ts']);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.artifacts') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('horizontal-overflow assertions go through support/viewport.ts', () => {
  it('no spec hand-rolls the documentElement scrollWidth check', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(e2eRoot)) {
      const rel = relative(e2eRoot, file);
      if (rel === relative(e2eRoot, fileURLToPath(import.meta.url))) continue;
      if (ALLOWED.has(rel)) continue;
      if (readFileSync(file, 'utf8').includes('documentElement.scrollWidth')) offenders.push(rel);
    }
    expect(
      offenders,
      'documentElement.scrollWidth is VACUOUS in this app shell - it cannot be ' +
        'non-zero, so the assertion always passes. Use expectNoHorizontalOverflow ' +
        '(page + routed <main>) or expectNoHorizontalOverflowIn (one element) from ' +
        'support/viewport.ts instead.',
    ).toEqual([]);
  });
});
