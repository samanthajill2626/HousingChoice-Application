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
  flagReason,
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

describe('flagReason', () => {
  it('takes the first against text naming the field (underscores as spaces, case folded)', () => {
    const result = parsed({
      against: [
        { text: 'far from work', source: 'area' },
        { text: 'Lease Terms say adults only', source: 'requirements' },
      ],
    });
    expect(flagReason('lease_terms', result)).toBe('Lease Terms say adults only');
  });

  it('falls back to an unknown naming it, then to the default', () => {
    expect(flagReason('qualifications', parsed({ unknowns: ['qualifications may bar children'] }))).toBe(
      'qualifications may bar children',
    );
    expect(flagReason('qualifications', parsed())).toBe(DEFAULT_FLAG_REASON);
  });

  it('names a landlord: field by its plain key', () => {
    const result = parsed({ against: [{ text: 'qualifications: no kids', source: 'requirements' }] });
    expect(flagReason('landlord:qualifications', result)).toBe('qualifications: no kids');
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
