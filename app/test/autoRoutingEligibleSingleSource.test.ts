// The ONE automatic-routing eligibility rule (primary-contact-integrity spec
// 4.3). `main` shipped it as routes/units.ts `autoRoutingEligible`; the heir
// function needs the very same rule, so it moved to lib/propertyContact.ts
// (`isAutoRoutingEligible`). A second DEFINITION anywhere in app/src is how
// auto-primary and the handoffs would start disagreeing about who may be
// promoted.
//
// TEXTUAL, like tourCopyCallSites.test.ts: it catches a function or const
// definition under either name, not a re-implementation under a new name. A
// green run is evidence, not proof.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// path.dirname(fileURLToPath(...)), never new URL(...).pathname (a leading
// slash on win32) - the idiom every tree-walking test here uses.
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const HOME = join('lib', 'propertyContact.ts');
const DEFINITION =
  /\bfunction\s+(?:isAutoRoutingEligible|autoRoutingEligible)\s*\(|\b(?:const|let)\s+(?:isAutoRoutingEligible|autoRoutingEligible)\s*=/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('the automatic-routing eligibility rule has ONE definition (spec 4.3)', () => {
  it('no module outside lib/propertyContact.ts defines it', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith(HOME)) continue;
      if (DEFINITION.test(readFileSync(file, 'utf8'))) offenders.push(path.relative(SRC, file));
    }
    expect(offenders, `import isAutoRoutingEligible from lib/propertyContact.ts instead:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('lib/propertyContact.ts does define it (the pin is not vacuous)', () => {
    expect(readFileSync(join(SRC, HOME), 'utf8')).toMatch(/export function isAutoRoutingEligible\(/);
  });
});
