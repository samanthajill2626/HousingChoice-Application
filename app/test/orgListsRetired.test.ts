// The app's hand-kept organization lists are RETIRED (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// G1, D1): the alias map that lived in lib/housingAuthority.ts
// (CANONICAL_AUTHORITY, KNOWN_AUTHORITIES, housingAuthorityFor,
// isKnownAuthority) and the AI hint list HOUSING_AUTHORITY_VOCAB in
// services/extraction/schema.ts. Every writer and reader now uses the ONE
// stored organization list (repos/orgListRepo.ts; the matching rules in
// lib/orgNames.ts), so a reference to a retired list is dead code or a comment
// pointing a reader at something that no longer exists.
//
// KNOWN LIMIT: the match is TEXTUAL over app/src, app/scripts and app/test. It
// catches the retired identifiers and the module path, not a NEW hand-kept list
// under a new name.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as extractionSchema from '../src/services/extraction/schema.js';

// path.dirname(fileURLToPath(...)), NOT new URL(...).pathname - on win32 the
// latter yields "/W:/..." with a leading slash and readdirSync throws ENOENT
// (the idiom tourCopyCallSites.test.ts uses).
const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'orgListsRetired.test.ts';

const RETIRED: ReadonlyArray<readonly [string, RegExp]> = [
  ['the alias map', /\bCANONICAL_AUTHORITY\b/],
  ['its canonical set', /\bKNOWN_AUTHORITIES\b/],
  ['its normalizer', /\bhousingAuthorityFor\b/],
  ['its membership test', /\bisKnownAuthority\b/],
  ['the AI hint list', /\bHOUSING_AUTHORITY_VOCAB\b/],
  ['the alias-map module path', /\/housingAuthority\.(?:js|ts)\b/],
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(full) ? [full] : [];
  });
}

describe('the hand-kept organization lists are retired (one stored list)', () => {
  it('the alias-map module is gone', () => {
    expect(existsSync(join(APP, 'src', 'lib', 'housingAuthority.ts'))).toBe(false);
  });

  it('the extraction schema no longer exports the AI hint list', () => {
    expect(Object.keys(extractionSchema)).not.toContain('HOUSING_AUTHORITY_VOCAB');
  });

  it('nothing in app/src, app/scripts or app/test names a retired list', () => {
    const offenders: string[] = [];
    for (const root of ['src', 'scripts', 'test']) {
      for (const file of walk(join(APP, root))) {
        if (path.basename(file) === SELF) continue;
        const text = readFileSync(file, 'utf8');
        for (const [what, re] of RETIRED) {
          if (re.test(text)) offenders.push(`${path.relative(APP, file)}: ${what} (${re.source})`);
        }
      }
    }
    expect(offenders, `point each reference at the stored org list instead:\n${offenders.join('\n')}`).toEqual([]);
  });
});
