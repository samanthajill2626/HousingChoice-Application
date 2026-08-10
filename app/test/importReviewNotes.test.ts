// reviewNotes.ts - translating the founder's notes-column answers into the
// columns the pipeline reads. Every pattern here is one she actually used in
// the 2026-08-09 review (84 edits, all in `notes`).
import { describe, expect, it } from 'vitest';
import type { CsvRow } from '../src/lib/import/csv.js';
import { interpretReviewNotes, stripUnchangedFromBaseline } from '../src/lib/import/reviewNotes.js';

const row = (over: Partial<CsvRow>): CsvRow => ({
  row_key: 'HC-0001',
  phone: '+15550100001',
  name: 'Test Person',
  type: 'tenant',
  voucher_beds: '',
  drop: '',
  notes: '',
  ...over,
});

const run = (r: CsvRow, sizes: ReadonlyMap<string, number> = new Map()) =>
  interpretReviewNotes([r], sizes);

describe('voucher-size notes', () => {
  it('writes a bare number into voucher_beds', () => {
    const r = row({ notes: '4' });
    const res = run(r);
    expect(r.voucher_beds).toBe('4');
    expect(res.interpreted).toHaveLength(1);
  });

  it('lets Airtable overrule her number (Cameron 2026-08-09)', () => {
    // Jasmine Maddox: her note said 2, Airtable says 3 - Airtable wins.
    const r = row({ notes: '2', phone: '+15550100002' });
    const res = run(r, new Map([['15550100002', 3]]));
    expect(r.voucher_beds).toBe('3');
    expect(res.interpreted[0]!.action).toContain('Airtable 3 overrules her 2');
  });

  it('accepts "2 bed" phrasing', () => {
    const r = row({ notes: '2 bed' });
    run(r);
    expect(r.voucher_beds).toBe('2');
  });
});

describe('drop and keep', () => {
  it.each(['You can delete', 'Delete', 'delete.'])('%j sets drop=Y', (note) => {
    const r = row({ notes: note });
    run(r);
    expect(r.drop).toBe('Y');
  });

  it.each(['Please add to system', "There are QUO messages, please don't delete"])(
    '%j keeps the row',
    (note) => {
      const r = row({ notes: note, drop: 'Y' });
      run(r);
      expect(r.drop).toBe('');
    },
  );
});

describe('type corrections', () => {
  it('"Caseworker" becomes partner', () => {
    const r = row({ notes: 'Caseworker' });
    run(r);
    expect(r.type).toBe('partner');
  });

  it('"Glitching- landlord Raj" becomes landlord', () => {
    const r = row({ notes: 'Glitching- landlord Raj', type: 'partner' });
    run(r);
    expect(r.type).toBe('landlord');
  });

  it('"Tenant Teresa" becomes tenant', () => {
    const r = row({ notes: 'Tenant Teresa', type: 'partner' });
    run(r);
    expect(r.type).toBe('tenant');
  });
});

describe('narrow additions from her actual notes', () => {
  it.each(['Tenent', 'Tennat'])('misspelling %j still reads as tenant', (note) => {
    const r = row({ notes: note, type: 'unknown' });
    run(r);
    expect(r.type).toBe('tenant');
  });

  it(`"N/a don't add" is a DROP, not a keep`, () => {
    const r = row({ notes: "N/a don't add" });
    run(r);
    expect(r.drop).toBe('Y');
  });

  it('"PM- Kym" is landlord-side', () => {
    const r = row({ notes: 'PM- Kym', type: 'unknown' });
    run(r);
    expect(r.type).toBe('landlord');
  });
});

describe('the rest', () => {
  it('"N/a" is acknowledged and cleared - the question was answered with nothing', () => {
    const r = row({ notes: 'N/a' });
    const res = run(r);
    expect(r.notes).toBe('');
    expect(res.acknowledged).toHaveLength(1);
    expect(res.interpreted).toHaveLength(0);
  });

  it('an unrecognised note is left VERBATIM and reported', () => {
    const r = row({ notes: 'Not showing on my end' });
    const res = run(r);
    expect(r.notes).toBe('Not showing on my end');
    expect(res.kept).toHaveLength(1);
  });

  it('a bare "yes" answering our "drop it?" question drops the row', () => {
    const r = row({
      notes: 'yes',
      why: 'Looks like a test or system contact rather than a real person - drop it?',
    });
    const res = run(r);
    expect(r.drop).toBe('Y');
    expect(res.interpreted).toHaveLength(1);
  });

  it('a bare "yes" against any OTHER question is not guessed at', () => {
    const r = row({ notes: 'yes', why: 'Could not tell tenant from landlord - which is it?' });
    const res = run(r);
    expect(res.kept).toHaveLength(1);
    expect(r.drop).toBe('');
    expect(r.type).toBe('tenant');
  });

  it('empty notes are skipped entirely', () => {
    const r = row({ notes: '' });
    const res = run(r);
    expect(res.interpreted.length + res.acknowledged.length + res.kept.length).toBe(0);
  });
});

describe('stripUnchangedFromBaseline', () => {
  it('clears pre-filled suggestions and keeps real edits', () => {
    // The workbook ships pre-filled, so "her file" = suggestions + edits. A
    // value equal to the baseline is a pre-fill (v1's stale 30-day status,
    // say); one that differs is a decision she made.
    const baseline = new Map([
      ['HC-0001', row({ row_key: 'HC-0001', name: 'Angela', status: 'on_hold' })],
    ]);
    const hers = row({ row_key: 'HC-0001', name: 'Angela Corrected', status: 'on_hold' });
    const res = stripUnchangedFromBaseline([hers], baseline, ['name', 'status']);
    expect(hers.name).toBe('Angela Corrected'); // real edit survives
    expect(hers.status).toBe(''); // pre-fill cleared - fresh derivation wins
    expect(res).toEqual({ edited: 1, stripped: 1 });
  });

  it('leaves rows absent from the baseline untouched', () => {
    const hers = row({ row_key: 'HC-9999', status: 'on_hold' });
    stripUnchangedFromBaseline([hers], new Map(), ['status']);
    expect(hers.status).toBe('on_hold');
  });
});
