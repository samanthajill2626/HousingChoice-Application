// B1 spec D1: "Every reader iterates the list; no reader names the four." The
// extraction-side readers are pinned here TEXTUALLY (the
// autoRoutingEligibleSingleSource.test.ts idiom): none of these files may
// spell a tenant matching input key. A green run is evidence, not proof - a
// reader that re-derives the four some other way is the reviewer's to catch.
// The contacts parsers and the dashboard surfaces are S1's (its own tests).
//
// WP1 B2a (spec D2.1; plan WI8): the scan also reads EVERY .ts file in
// services/ranking/ - listed at run time, so a file a later slice adds is
// scanned the moment it exists - except examples.ts, whose synthetic cards use
// the labels (the ONE exemption). The ranking drivers live in adapters/ and
// are scanned once they exist (B2a S4 creates them); the fake driver finds its
// inputs through the list, never a spelled key.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TENANT_MATCHING_INPUTS } from '../src/lib/tenantMatchingInputs.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const READERS = [
  ['services', 'extraction', 'apply.ts'],
  ['services', 'extraction', 'schema.ts'],
  ['services', 'extraction', 'prompt.ts'],
  ['services', 'extraction', 'runTypes.ts'],
  ['services', 'extraction', 'decisions.ts'],
  ['services', 'suggestionResolution.ts'],
  ['jobs', 'extraction.ts'],
  ['jobs', 'journalSweep.ts'],
  ['adapters', 'extraction.ts'],
  ['adapters', 'extractionFake.ts'],
].map((parts) => path.join(SRC, ...parts));

const RANKING_DIR = path.join(SRC, 'services', 'ranking');
/** spec D2.1: the one exemption - synthetic worked examples that use the labels. */
const RANKING_EXEMPT = new Set(['examples.ts']);
const RANKING_READERS = readdirSync(RANKING_DIR)
  .filter((name) => name.endsWith('.ts') && !RANKING_EXEMPT.has(name))
  .sort()
  .map((name) => path.join(RANKING_DIR, name));
const RANKING_DRIVERS = [
  ['adapters', 'ranking.ts'],
  ['adapters', 'rankingFake.ts'],
]
  .map((parts) => path.join(SRC, ...parts))
  .filter((file) => existsSync(file));

describe('the extraction and ranking readers iterate the tenant matching inputs list (B1 spec D1; B2a WI8)', () => {
  it('no extraction or ranking reader spells a tenant matching input key', () => {
    const offenders: string[] = [];
    for (const file of [...READERS, ...RANKING_READERS, ...RANKING_DRIVERS]) {
      const source = readFileSync(file, 'utf8');
      for (const { key } of TENANT_MATCHING_INPUTS) {
        if (source.includes(key)) offenders.push(`${path.relative(SRC, file)}: ${key}`);
      }
    }
    expect(offenders, `iterate TENANT_MATCHING_INPUTS instead:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the list really is the four (the pin is not vacuous)', () => {
    expect(TENANT_MATCHING_INPUTS).toHaveLength(4);
  });

  it('the ranking directory is scanned, examples.ts alone exempt (WI8)', () => {
    const names = RANKING_READERS.map((file) => path.basename(file));
    expect(names).toEqual(expect.arrayContaining(['cardFields.ts', 'types.ts']));
    expect(names).not.toContain('examples.ts');
  });
});
