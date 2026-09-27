import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(testDir, 'Inbox.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function bodyOf(selector: string): string {
  const match = css.match(new RegExp(`(?:^|\\n)\\${selector}\\s*\\{([^}]*)\\}`));
  expect(match, `missing CSS rule for ${selector}`).not.toBeNull();
  return match![1]!;
}

describe('Inbox.module.css', () => {
  it('the page root opts out of scroll anchoring (spec 5.2)', () => {
    expect(bodyOf('.page')).toMatch(/overflow-anchor:\s*none/);
  });
  it('the sentinel has a box to observe', () => {
    expect(bodyOf('.sentinel')).toMatch(/height:\s*1px/);
  });
});
