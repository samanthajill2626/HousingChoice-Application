// WP1 B2a spec D5: parsing the ranking output. Never throws; a candidate the
// model did not return, returned twice (every copy discarded), returned under
// an unknown handle or returned with no usable score gets NO parsed result -
// a default or guessed score is never written (charter 7.4).
import { describe, expect, it } from 'vitest';
import {
  MAX_REASON_CHARS,
  MAX_REASONS,
  MAX_UNKNOWNS,
  parseRankingText,
  type ParsedRanking,
  type RankingParseContext,
} from '../src/services/ranking/parse.js';

function ctx(over: Partial<RankingParseContext> = {}): RankingParseContext {
  return {
    handles: ['c1', 'c2', 'c3'],
    freeTextByHandle: new Map<string, Record<string, string>>([
      ['c1', { qualifications: 'No kids under 12.', notes: 'Quiet street.' }],
      ['c2', {}],
      ['c3', { 'landlord:notes': 'No kids.', qualifications: 'No kids.' }],
    ]),
    landlordCard: false,
    ...over,
  };
}

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { candidateId: 'c1', score: 70, for: [], against: [], unknowns: [], failedRequirements: [], fairHousingFlags: [], ...over };
}

function parse(candidates: unknown[], c: RankingParseContext = ctx()): ParsedRanking {
  const result = parseRankingText(JSON.stringify({ candidates }), c);
  if (!result.ok) throw new Error(`unexpected parse failure: ${result.message}`);
  return result.value;
}

describe('whole-output failures (the batch gets no match)', () => {
  it('text that is not JSON fails with a fixed message that carries none of the text', () => {
    const result = parseRankingText('{"candidates": [ Robin Example', ctx());
    expect(result).toEqual({ ok: false, message: 'ranking output is not valid JSON' });
  });

  it.each([
    ['an array root', '[]'],
    ['no candidates key', '{}'],
    ['candidates not a list', '{"candidates":{}}'],
  ])('%s fails', (_label, text) => {
    expect(parseRankingText(text, ctx())).toEqual({ ok: false, message: 'ranking output has no candidates list' });
  });

  it('an empty candidates list parses to nothing scored', () => {
    const value = parse([]);
    expect(value.byHandle.size).toBe(0);
    expect(value.droppedUnlawfulFlags).toBe(0);
  });
});

describe('a clean entry', () => {
  it('round-trips', () => {
    const value = parse([entry({
      score: 82,
      for: [{ text: 'in Decatur', source: 'area' }],
      against: [{ text: 'stairs', source: 'accessibility' }],
      unknowns: ['tour time unknown'],
      failedRequirements: ['deposit'],
      fairHousingFlags: [{ kind: 'accommodation', field: 'no_pets' }],
    })]);
    expect(value.byHandle.get('c1')).toEqual({
      score: 82,
      for: [{ text: 'in Decatur', source: 'area' }],
      against: [{ text: 'stairs', source: 'accessibility' }],
      unknowns: ['tour time unknown'],
      failedRequirements: ['deposit'],
      fairHousingFlags: [{ kind: 'accommodation', field: 'no_pets' }],
    });
    expect(value.duplicateHandles).toEqual([]);
    expect(value.unknownHandles).toEqual([]);
    expect(value.unscoredHandles).toEqual([]);
  });
});

describe('score', () => {
  it.each([
    [140, 100],
    [-3, 0],
    [71.6, 72],
    [71.4, 71],
    [-0.4, 0],
    [0, 0],
    [100, 100],
  ])('%d reads %d', (raw, expected) => {
    const score = parse([entry({ score: raw })]).byHandle.get('c1')!.score;
    expect(Object.is(score, expected)).toBe(true);
  });

  it.each([['a string', '80'], ['null', null], ['absent', undefined]])('%s score: no result, listed unscored', (_label, raw) => {
    const value = parse([entry({ score: raw }), entry({ candidateId: 'c2' })]);
    expect(value.byHandle.has('c1')).toBe(false);
    expect(value.unscoredHandles).toEqual(['c1']);
    expect(value.byHandle.has('c2')).toBe(true);
  });
});

describe('reasons', () => {
  it(`keep the first ${MAX_REASONS} VALID reasons, trimmed, each cut to ${MAX_REASON_CHARS} characters`, () => {
    const long = 'x'.repeat(120);
    const value = parse([entry({
      for: [
        { text: 'dropped: bad source', source: 'astrology' },
        { text: '   ', source: 'area' },
        'not an object',
        { text: 42, source: 'rent' },
        { text: '  near the bus  ', source: 'preferences' },
        { text: long, source: 'notes' },
        { text: 'third', source: 'rent' },
        { text: 'fourth - cut', source: 'rent' },
      ],
      against: 'not a list',
    })]);
    const parsed = value.byHandle.get('c1')!;
    expect(parsed.for).toEqual([
      { text: 'near the bus', source: 'preferences' },
      { text: 'x'.repeat(MAX_REASON_CHARS), source: 'notes' },
      { text: 'third', source: 'rent' },
    ]);
    expect(parsed.against).toEqual([]);
  });
});

describe('unknowns', () => {
  it(`keep the first ${MAX_UNKNOWNS} non-empty strings, trimmed`, () => {
    const parsed = parse([entry({ unknowns: [' a ', '', 7, 'b', 'c', '  ', 'd', 'e', 'f', 'g'] })]).byHandle.get('c1')!;
    expect(parsed.unknowns).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('failedRequirements', () => {
  it('keep the enum keys once each; credit, income, landlord: keys and unknown keys are dropped', () => {
    const parsed = parse([entry({
      failedRequirements: ['no_pets', 'credit_requirements', 'income_requirements', 'bogus', 'no_pets', 'landlord:no_pets', 'qualifications', 3],
    })]).byHandle.get('c1')!;
    expect(parsed.failedRequirements).toEqual(['no_pets', 'qualifications']);
  });
});

describe('fairHousingFlags', () => {
  it('keeps an accommodation flag on an enum field and an unlawful flag on a free-text field holding text', () => {
    const parsed = parse([entry({
      fairHousingFlags: [
        { kind: 'accommodation', field: 'no_pets' },
        { kind: 'unlawful', field: 'qualifications' },
        { kind: 'unlawful', field: 'qualifications' },
      ],
    })]).byHandle.get('c1')!;
    expect(parsed.fairHousingFlags).toEqual([
      { kind: 'accommodation', field: 'no_pets' },
      { kind: 'unlawful', field: 'qualifications' },
    ]);
  });

  it('drops AND COUNTS an unlawful flag on a checkbox, a money or enum field, an empty field or a field outside the enum', () => {
    const value = parse([
      entry({
        fairHousingFlags: [
          { kind: 'unlawful', field: 'no_pets' },
          { kind: 'unlawful', field: 'no_evictions_on_program' },
          { kind: 'unlawful', field: 'deposit' },
          { kind: 'unlawful', field: 'lease_terms' },
          { kind: 'unlawful', field: 'bogus' },
        ],
      }),
      entry({ candidateId: 'c2', fairHousingFlags: [{ kind: 'unlawful', field: 'qualifications' }] }),
    ]);
    expect(value.byHandle.get('c1')!.fairHousingFlags).toEqual([]);
    expect(value.byHandle.get('c2')!.fairHousingFlags).toEqual([]);
    expect(value.droppedUnlawfulFlags).toBe(6);
  });

  it('drops without counting an unknown kind and an accommodation flag on a field outside the enum', () => {
    const value = parse([entry({
      fairHousingFlags: [
        { kind: 'other', field: 'notes' },
        { kind: 'accommodation', field: 'bogus' },
        { kind: 'accommodation', field: 'landlord:no_pets' },
        'not an object',
      ],
    })]);
    expect(value.byHandle.get('c1')!.fairHousingFlags).toEqual([]);
    expect(value.droppedUnlawfulFlags).toBe(0);
  });

  it('PR44: keeps an accommodation flag on ANY field of the enum, a free-text one included', () => {
    const flags = [
      { kind: 'accommodation', field: 'accessibility' },
      { kind: 'accommodation', field: 'lease_terms' },
      { kind: 'accommodation', field: 'notes' },
      { kind: 'accommodation', field: 'qualifications' },
    ];
    expect(parse([entry({ fairHousingFlags: flags })]).byHandle.get('c1')!.fairHousingFlags).toEqual(flags);
    const on = parse([entry({ fairHousingFlags: [{ kind: 'accommodation', field: 'landlord:notes' }] })], ctx({ landlordCard: true }));
    expect(on.byHandle.get('c1')!.fairHousingFlags).toEqual([{ kind: 'accommodation', field: 'landlord:notes' }]);
  });

  it('landlord twins exist only with the switch on', () => {
    const flags = [
      { kind: 'unlawful', field: 'landlord:notes' },
      { kind: 'accommodation', field: 'landlord:no_pets' },
    ];
    const off = parse([entry({ candidateId: 'c3', fairHousingFlags: flags })]);
    expect(off.byHandle.get('c3')!.fairHousingFlags).toEqual([]);
    expect(off.droppedUnlawfulFlags).toBe(1);
    const on = parse([entry({ candidateId: 'c3', fairHousingFlags: flags })], ctx({ landlordCard: true }));
    expect(on.byHandle.get('c3')!.fairHousingFlags).toEqual(flags);
    expect(on.droppedUnlawfulFlags).toBe(0);
  });

  it('a non-list fairHousingFlags reads as none', () => {
    expect(parse([entry({ fairHousingFlags: null })]).byHandle.get('c1')!.fairHousingFlags).toEqual([]);
  });
});

describe('handles', () => {
  it('a handle returned twice gets no result at all (every copy discarded)', () => {
    const value = parse([entry({ score: 90 }), entry({ score: 10 }), entry({ candidateId: 'c2' })]);
    expect(value.byHandle.has('c1')).toBe(false);
    expect(value.duplicateHandles).toEqual(['c1']);
    expect(value.byHandle.has('c2')).toBe(true);
  });

  it('an unknown handle gets no result and is listed (case matters, surrounding spaces do not)', () => {
    const value = parse([entry({ candidateId: 'c9' }), entry({ candidateId: 'C2' }), entry({ candidateId: ' c3 ' })]);
    expect(value.unknownHandles).toEqual(['c9', 'C2']);
    expect([...value.byHandle.keys()]).toEqual(['c3']);
  });

  it('a candidate the model did not return is simply absent', () => {
    const value = parse([entry({ candidateId: 'c2' })]);
    expect([...value.byHandle.keys()]).toEqual(['c2']);
    expect(value.unscoredHandles).toEqual([]);
  });

  it('an entry that is not an object or has no string candidateId is ignored', () => {
    const value = parse(['c1', null, entry({ candidateId: 5 }), entry({ candidateId: 'c2' })]);
    expect([...value.byHandle.keys()]).toEqual(['c2']);
  });

  it('results come back in handle order, whatever order the model used', () => {
    const value = parse([entry({ candidateId: 'c3' }), entry({ candidateId: 'c1' })]);
    expect([...value.byHandle.keys()]).toEqual(['c1', 'c3']);
  });
});
