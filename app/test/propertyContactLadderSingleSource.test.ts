// The property-contact ladder - "the roster row flagged primary, else the
// landlord of record" - has ONE implementation: lib/propertyContact.ts
// (primary-contact-integrity spec 4.1 / goal G2). Four inline copies of it
// (lib/tourContacts.ts, lib/rosterResolution.ts and both
// services/rosterProvision.ts diagnostics) never checked deleted_at, which is
// how a soft-deleted primary got named, listed and texted. This pin fails if
// a copy comes back.
//
// TEXTUAL, like tourCopyCallSites.test.ts: it matches the two shapes the
// copies were written in (`...primaryContact === true)?.contactId ??` and
// `primary?.contactId ??`), not every conceivable re-derivation. A green run
// is evidence, not proof.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const HOME = join('lib', 'propertyContact.ts');
const LADDER_SHAPES: readonly RegExp[] = [
  /primaryContact === true\)\?\.contactId\s*\?\?/,
  /\bprimary\?\.contactId\s*\?\?/,
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('the primary-then-landlord ladder has ONE implementation (spec 4.1)', () => {
  it('no module outside lib/propertyContact.ts re-derives it', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith(HOME)) continue;
      const text = readFileSync(file, 'utf8');
      for (const shape of LADDER_SHAPES) {
        if (shape.test(text)) offenders.push(`${path.relative(SRC, file)}: ${shape.source}`);
      }
    }
    expect(offenders, `read the property contact through lib/propertyContact.ts:\n${offenders.join('\n')}`).toEqual([]);
  });
});
