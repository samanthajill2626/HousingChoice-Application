// Unlawful flags as property records (WP1 B2a spec D10; charter 7.2): the
// hash is of the TRIMMED text; a flag is OPEN only while its field is on the
// current card and its text still hashes to the stored hash (an edit closes
// it; a landlord default leaving the card closes a landlord: flag); a job
// merges raises across batches by property and field, the first raise wins.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { UnlawfulFlagInput } from '../src/repos/rankingRunsRepo.js';
import {
  DEFAULT_FLAG_REASON,
  isFlagOpen,
  mergeRaisedFlags,
  openFlagFields,
  openFlags,
  textHashOf,
} from '../src/services/ranking/flags.js';
import { flagRecord, parsed, T0 } from './helpers/rankingJobFixtures.js';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const record = (field: string, text: string, unitId = 'unit-1') =>
  flagRecord({ unitId, field, textHash: textHashOf(text), reason: 'r', runId: 'run-1', raisedAt: T0 });

describe('textHashOf', () => {
  it('hashes the trimmed text', () => {
    expect(textHashOf('  No kids under 12.  ')).toBe(sha('No kids under 12.'));
  });
});

describe('isFlagOpen / openFlags / openFlagFields', () => {
  const flag = record('qualifications', 'No kids under 12.');

  it('is open while the card text still hashes to the stored hash (outer spacing ignored)', () => {
    expect(isFlagOpen(flag, { qualifications: '  No kids under 12. ' })).toBe(true);
  });

  it('closes when the text is edited', () => {
    expect(isFlagOpen(flag, { qualifications: 'Two years of rental history.' })).toBe(false);
  });

  it('closes when the field is no longer on the card or holds no text', () => {
    expect(isFlagOpen(flag, {})).toBe(false);
    expect(isFlagOpen(flag, { qualifications: '   ' })).toBe(false);
  });

  it('a landlord: flag closes when that default leaves the card (switch off, or the property records its own value)', () => {
    const landlord = record('landlord:qualifications', 'No kids.');
    expect(isFlagOpen(landlord, { 'landlord:qualifications': 'No kids.' })).toBe(true);
    expect(isFlagOpen(landlord, { qualifications: 'No kids.' })).toBe(false);
  });

  it('a dismissal never closes a flag (display-only, charter 7.2)', () => {
    const dismissed = { ...flag, dismissedAt: '2026-10-29T00:00:00.000Z', dismissedBy: 'usr-1' };
    expect(isFlagOpen(dismissed, { qualifications: 'No kids under 12.' })).toBe(true);
  });

  it('openFlags keeps only the open records; openFlagFields de-duplicates', () => {
    const closed = record('notes', 'Old text.');
    const open = record('notes', 'Adults only.');
    const fields = { qualifications: 'No kids under 12.', notes: 'Adults only.' };
    expect(openFlags([flag, closed, open], fields).map((r) => r.field)).toEqual(['qualifications', 'notes']);
    expect(openFlagFields([flag, open, { ...open }], fields)).toEqual(['qualifications', 'notes']);
  });
});

// Spec D10 rev 7 (charter item 15, PFW1-1): the record's reason is ALWAYS
// the fixed sentence. A pair's against-reasons and unknowns describe THAT
// pair - often the tenant's own facts - and must never reach a property
// record with no TTL; they stay on the pair's match and run.
describe('the flag record reason is always the fixed sentence', () => {
  const raiseOne = (field: string, text: string, result: ReturnType<typeof parsed>): UnlawfulFlagInput | undefined =>
    mergeRaisedFlags(new Map(), [{ unitId: 'unit-1', freeTextByField: { [field]: text }, result }], {
      runId: 'run-a',
      raisedAt: T0,
    })[0];

  it('an against-reason and an unknown naming the field never reach the record (accessibility, a wheelchair user)', () => {
    const flag = raiseOne(
      'accessibility',
      'No wheelchairs. 3rd floor.',
      parsed({
        against: [{ text: 'accessibility: 3rd floor walkup, tenant uses a wheelchair', source: 'accessibility' }],
        unknowns: ['accessibility: tenant uses a wheelchair, rule not applied (fair housing)'],
        fairHousingFlags: [{ kind: 'unlawful', field: 'accessibility' }],
      }),
    );
    expect(flag?.reason).toBe(DEFAULT_FLAG_REASON);
    expect(JSON.stringify(flag)).not.toMatch(/wheelchair|walkup/);
  });

  it("a pets against-reason about this tenant is not the record's reason", () => {
    const flag = raiseOne(
      'pets',
      'No children. Cats OK.',
      parsed({
        against: [{ text: 'no pets rule, tenant has 2 cats', source: 'pets' }],
        unknowns: ['pets: whether the cats are assistance animals is unknown'],
        fairHousingFlags: [{ kind: 'unlawful', field: 'pets' }],
      }),
    );
    expect(flag?.reason).toBe(DEFAULT_FLAG_REASON);
    expect(JSON.stringify(flag)).not.toMatch(/cats|assistance/);
  });

  it('a landlord: flag records the fixed sentence too', () => {
    const flag = raiseOne(
      'landlord:qualifications',
      'No kids.',
      parsed({
        against: [{ text: 'qualifications: no kids, tenant has a son', source: 'qualifications' }],
        fairHousingFlags: [{ kind: 'unlawful', field: 'landlord:qualifications' }],
      }),
    );
    expect(flag?.reason).toBe(DEFAULT_FLAG_REASON);
  });
});

describe('mergeRaisedFlags (D10: merged across a job by property and field)', () => {
  const unlawful = (field: string) => parsed({ fairHousingFlags: [{ kind: 'unlawful', field }] });

  it('returns the flags this batch newly raised and records them in the job map', () => {
    const raised = new Map<string, UnlawfulFlagInput>();
    const added = mergeRaisedFlags(
      raised,
      [{ unitId: 'unit-1', freeTextByField: { qualifications: ' No kids. ' }, result: unlawful('qualifications') }],
      { runId: 'run-a', raisedAt: T0 },
    );
    expect(added).toEqual([
      { unitId: 'unit-1', field: 'qualifications', textHash: sha('No kids.'), reason: DEFAULT_FLAG_REASON, runId: 'run-a', raisedAt: T0 },
    ]);
    expect([...raised.keys()]).toEqual(['unit-1#qualifications']);
  });

  it('a later batch raising the same property and field adds nothing (the first raising run is kept)', () => {
    const raised = new Map<string, UnlawfulFlagInput>();
    const facts = { qualifications: 'No kids.' };
    mergeRaisedFlags(raised, [{ unitId: 'unit-1', freeTextByField: facts, result: unlawful('qualifications') }], { runId: 'run-a', raisedAt: 'a' });
    const second = mergeRaisedFlags(
      raised,
      [
        { unitId: 'unit-1', freeTextByField: facts, result: unlawful('qualifications') },
        { unitId: 'unit-2', freeTextByField: facts, result: unlawful('qualifications') },
      ],
      { runId: 'run-b', raisedAt: 'b' },
    );
    expect(second.map((f) => `${f.unitId}#${f.field}#${f.runId}`)).toEqual(['unit-2#qualifications#run-b']);
    expect(raised.get('unit-1#qualifications')?.runId).toBe('run-a');
  });

  it('ignores accommodation flags and a field that holds no text on the card', () => {
    const raised = new Map<string, UnlawfulFlagInput>();
    const added = mergeRaisedFlags(
      raised,
      [
        { unitId: 'unit-1', freeTextByField: {}, result: unlawful('notes') },
        {
          unitId: 'unit-1',
          freeTextByField: { pets: 'No dogs.' },
          result: parsed({ fairHousingFlags: [{ kind: 'accommodation', field: 'no_pets' }] }),
        },
      ],
      { runId: 'run-a', raisedAt: 'a' },
    );
    expect(added).toEqual([]);
    expect(raised.size).toBe(0);
  });
});
