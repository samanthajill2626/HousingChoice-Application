// B1 spec D1: "Every reader iterates the list; no reader names the four." The
// extraction-side readers are pinned here TEXTUALLY (the
// autoRoutingEligibleSingleSource.test.ts idiom): none of these files may
// spell a tenant matching input key. A green run is evidence, not proof - a
// reader that re-derives the four some other way is the reviewer's to catch.
// The contacts parsers and the dashboard surfaces are S1's (its own tests).
import { readFileSync } from 'node:fs';
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

describe('the extraction readers iterate the tenant matching inputs list (B1 spec D1)', () => {
  it('no extraction reader spells a tenant matching input key', () => {
    const offenders: string[] = [];
    for (const file of READERS) {
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
});
