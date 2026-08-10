// parseExtractionOps: the RAW per-target op view of rawText, before any folding
// or downgrading. Design 7.1 - the parsed ExtractionResult is unusable for this
// because it folds address/type sentinels to absent and rewrites a value-less
// write/suggest into { op: 'none' }, so a decline and a failure look identical.
// It MUST be total: parseExtractionText throws by design, and this is called on
// exactly the text that made it throw.
import { describe, expect, it } from 'vitest';
import { EMPTY_OPS_VIEW, parseExtractionOps } from '../src/services/extraction/schema.js';
import { DECISION_TARGETS } from '../src/services/extraction/runTypes.js';

describe('parseExtractionOps - totality', () => {
  it('returns the empty view for undefined rawText, never throwing', () => {
    expect(parseExtractionOps(undefined)).toEqual(EMPTY_OPS_VIEW);
  });

  it('returns the empty view for unparseable text, never throwing', () => {
    expect(() => parseExtractionOps('{not valid json')).not.toThrow();
    expect(parseExtractionOps('{not valid json')).toEqual(EMPTY_OPS_VIEW);
  });

  it('returns the empty view for valid JSON that is not an object', () => {
    for (const raw of ['[1,2,3]', '"hello"', 'null', '7']) {
      expect(parseExtractionOps(raw)).toEqual(EMPTY_OPS_VIEW);
    }
  });

  it('the empty view marks all twelve targets absent - never none', () => {
    for (const target of DECISION_TARGETS) expect(EMPTY_OPS_VIEW[target]).toEqual({ op: 'absent' });
  });

  it('never leaks state between calls', () => {
    expect(parseExtractionOps('{"fields":{"pets":{"op":"write","value":"x"}}}').pets.op).toBe('write');
    expect(EMPTY_OPS_VIEW.pets).toEqual({ op: 'absent' });
    expect(parseExtractionOps(undefined).pets).toEqual({ op: 'absent' });
  });
});

describe('parseExtractionOps - the two cases a parsed-result reading gets wrong', () => {
  it('KEEPS an EMPTY value on a write that schema.ts:215-219 would downgrade to none', () => {
    // The model TRIED and supplied an unusable value. A parsed `none` here is
    // indistinguishable from a decline; the raw view is not. Task 17 turns this
    // into dropped/empty_value_at_parse.
    expect(parseExtractionOps('{"fields":{"pets":{"op":"write","value":"","reason":"unsure"}}}').pets)
      .toEqual({ op: 'write', value: '', reason: 'unsure' });
  });

  it('KEEPS an address/type decline that parseExtractionText folds to ABSENT', () => {
    const view = parseExtractionOps(
      '{"address":{"op":"none","line1":"","reason":""},"typeSuggestion":{"value":"none","reason":""}}',
    );
    expect(view.address).toEqual({ op: 'none' });
    expect(view.type).toEqual({ op: 'none' });
  });
});

describe('parseExtractionOps - per-target mapping', () => {
  it('maps the eight scalars off fields.<name>.op, dropping the sentinels on a none', () => {
    const view = parseExtractionOps(
      '{"fields":{"firstName":{"op":"write","value":"Ann","reason":"stated"},"pets":{"op":"none","value":"","reason":""}}}',
    );
    expect(view.firstName).toEqual({ op: 'write', value: 'Ann', reason: 'stated' });
    expect(view.pets).toEqual({ op: 'none' });
    expect(view.lastName).toEqual({ op: 'absent' });
  });

  it('maps statusAdvance.suggest to suggest/none', () => {
    expect(parseExtractionOps('{"statusAdvance":{"suggest":true,"reason":"RTA in hand"}}').status)
      .toEqual({ op: 'suggest', reason: 'RTA in hand' });
    expect(parseExtractionOps('{"statusAdvance":{"suggest":false,"reason":""}}').status).toEqual({ op: 'none' });
    expect(parseExtractionOps('{}').status).toEqual({ op: 'absent' });
  });

  it('maps typeSuggestion.value, treating an OFF-ENUM value as a failed attempt not a decline', () => {
    expect(parseExtractionOps('{"typeSuggestion":{"value":"tenant","reason":"r"}}').type)
      .toEqual({ op: 'suggest', value: 'tenant', reason: 'r' });
    expect(parseExtractionOps('{"typeSuggestion":{"value":"none","reason":""}}').type).toEqual({ op: 'none' });
    expect(parseExtractionOps('{"typeSuggestion":{"value":"caseworker","reason":""}}').type)
      .toEqual({ op: 'suggest', value: 'caseworker' });
  });

  it('maps phoneAddition.phone, treating the empty-string sentinel as a decline', () => {
    expect(parseExtractionOps('{"phoneAddition":{"phone":"404-555-1212","label":"cell","reason":"r"}}').phone)
      .toEqual({ op: 'suggest', value: '404-555-1212', reason: 'r' });
    expect(parseExtractionOps('{"phoneAddition":{"phone":"","label":"","reason":""}}').phone).toEqual({ op: 'none' });
  });

  it('reads the INTERNAL sparse shape the fake driver emits, not just the wire shape', () => {
    // The fake driver's EXTRACT: marker is a Partial<ExtractionResult>, so the
    // e2e exercises this path. `op` sits at the same place in both shapes.
    const view = parseExtractionOps('{"fields":{"pets":{"op":"write","value":"two cats"}}}');
    expect(view.pets).toEqual({ op: 'write', value: 'two cats' });
    expect(view.address).toEqual({ op: 'absent' });
  });
});
