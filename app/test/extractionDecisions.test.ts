// Decision assembly (design 7.1). Sourced from rawText via parseExtractionOps,
// NEVER from the parsed result - the parsed result cannot distinguish a decline
// from a failure at any of the twelve targets.
import { describe, expect, it, vi } from 'vitest';
import { buildDecisions } from '../src/services/extraction/decisions.js';
import { EMPTY_OPS_VIEW, parseExtractionOps } from '../src/services/extraction/schema.js';
import { DECISION_TARGETS } from '../src/services/extraction/runTypes.js';

describe('buildDecisions', () => {
  it('covers all twelve targets, so "never mentioned" is answerable from the record alone', () => {
    const out = buildDecisions({ ops: EMPTY_OPS_VIEW, rawTextPresent: true, applyDecisions: [] });
    expect(Object.keys(out).sort()).toEqual([...DECISION_TARGETS].sort());
  });

  it('distinguishes an explicit decline (no_finding) from a silence (not_addressed)', () => {
    const ops = parseExtractionOps('{"fields":{"pets":{"op":"none","value":"","reason":""}}}');
    const out = buildDecisions({ ops, rawTextPresent: true, applyDecisions: [] });
    expect(out.pets).toEqual({ proposedOp: 'none', outcome: 'no_finding', verdict: 'not_presented' });
    expect(out.tenure).toEqual({ proposedOp: 'absent', outcome: 'not_addressed', verdict: 'not_presented' });
  });

  it('NEVER infers a decline when rawText was absent - only not_addressed', () => {
    // The console driver, or a driver failure before a response arrived.
    const out = buildDecisions({ ops: EMPTY_OPS_VIEW, rawTextPresent: false, applyDecisions: [] });
    for (const target of DECISION_TARGETS) expect(out[target]!.outcome).toBe('not_addressed');
  });

  it('records a write as wrote / auto_applied, carrying previousValue', () => {
    const ops = parseExtractionOps('{"fields":{"pets":{"op":"write","value":"two cats","reason":"said so"}}}');
    const out = buildDecisions({
      ops, rawTextPresent: true,
      applyDecisions: [{
        target: 'pets', outcome: 'wrote',
        proposedValue: 'two cats', coercedValue: 'two cats',
        previousValue: 'a dog', reason: 'said so',
      }],
    });
    expect(out.pets).toEqual({
      proposedOp: 'write', proposedValue: 'two cats', coercedValue: 'two cats',
      previousValue: 'a dog', reason: 'said so',
      outcome: 'wrote', verdict: 'auto_applied',
    });
  });

  it('auto_applied does NOT imply the field was empty - previousValue tells them apart', () => {
    const ops = parseExtractionOps('{"fields":{"pets":{"op":"write","value":"two cats"}}}');
    const out = buildDecisions({
      ops, rawTextPresent: true,
      applyDecisions: [{ target: 'pets', outcome: 'wrote', coercedValue: 'two cats' }],
    });
    expect(out.pets!.verdict).toBe('auto_applied');
    expect(out.pets!.previousValue).toBeUndefined();
  });

  it('records a suggestion as suggested / pending, preserving demotedFrom', () => {
    const ops = parseExtractionOps('{"fields":{"pets":{"op":"write","value":"two cats"}}}');
    const out = buildDecisions({
      ops, rawTextPresent: true,
      applyDecisions: [{ target: 'pets', outcome: 'suggested', coercedValue: 'two cats', demotedFrom: 'write' }],
    });
    expect(out.pets).toMatchObject({
      proposedOp: 'write', outcome: 'suggested', demotedFrom: 'write', verdict: 'pending',
    });
  });

  it('carries every dropReason through as dropped / not_presented', () => {
    const ops = parseExtractionOps('{"phoneAddition":{"phone":"404-555-1212","label":"","reason":""}}');
    const out = buildDecisions({
      ops, rawTextPresent: true,
      applyDecisions: [{
        target: 'phone', outcome: 'dropped',
        dropReason: 'phone_owned_by_other', proposedValue: '404-555-1212',
      }],
    });
    expect(out.phone).toMatchObject({
      proposedOp: 'suggest', outcome: 'dropped',
      dropReason: 'phone_owned_by_other', verdict: 'not_presented',
    });
  });

  it('a scalar write with an EMPTY value reads as dropped/empty_value_at_parse, NEVER no_finding', () => {
    // schema.ts:215-219 rewrites a value-less write into { op: none } and drops
    // the reason, so apply never sees it and records nothing. The raw view still
    // says `write`, which is the model FAILING, not abstaining (7.1/7.2).
    const onUnexplained = vi.fn();
    const ops = parseExtractionOps('{"fields":{"pets":{"op":"write","value":"","reason":"unsure"}}}');
    const out = buildDecisions({ ops, rawTextPresent: true, applyDecisions: [], onUnexplained });
    expect(out.pets).toMatchObject({
      proposedOp: 'write', outcome: 'dropped',
      dropReason: 'empty_value_at_parse', verdict: 'not_presented',
    });
    expect(onUnexplained).not.toHaveBeenCalled();
  });

  it('empty_value_at_parse is DISTINCT from invalid_value', () => {
    // One is the model sending nothing usable; the other is apply's coerceField
    // rejecting something well-formed but wrong. QA needs to tell them apart.
    const ops = parseExtractionOps('{"fields":{"voucherSize":{"op":"write","value":"99"}}}');
    const out = buildDecisions({
      ops, rawTextPresent: true,
      applyDecisions: [{ target: 'voucherSize', outcome: 'dropped', dropReason: 'invalid_value', proposedValue: '99' }],
    });
    expect(out.voucherSize!.dropReason).toBe('invalid_value');
  });

  it('an address write the parse dropped for zero usable parts reads as empty_value_at_parse', () => {
    const onUnexplained = vi.fn();
    const ops = parseExtractionOps('{"address":{"op":"write","line1":"","city":"","reason":"heard one"}}');
    const out = buildDecisions({ ops, rawTextPresent: true, applyDecisions: [], onUnexplained });
    expect(out.address).toMatchObject({ outcome: 'dropped', dropReason: 'empty_value_at_parse' });
    expect(onUnexplained).not.toHaveBeenCalled();
  });

  it('an address DECLINE still reads as no_finding even though parseExtractionText folds it away', () => {
    const ops = parseExtractionOps('{"address":{"op":"none","line1":"","reason":""}}');
    expect(buildDecisions({ ops, rawTextPresent: true, applyDecisions: [] }).address)
      .toMatchObject({ proposedOp: 'none', outcome: 'no_finding' });
  });

  it('a type decline reads as no_finding even though parseExtractionText folds it away', () => {
    const ops = parseExtractionOps('{"typeSuggestion":{"value":"none","reason":""}}');
    expect(buildDecisions({ ops, rawTextPresent: true, applyDecisions: [] }).type)
      .toMatchObject({ proposedOp: 'none', outcome: 'no_finding' });
  });

  it('an UNEXPLAINED gap is LOUD: a reasonless drop plus onUnexplained, never a guessed reason', () => {
    // A non-empty proposed value that apply nonetheless never reported means a
    // branch is missing from apply's decision table, or a new schema.ts fold
    // site exists. Recording a plausible-looking dropReason would hide it.
    const onUnexplained = vi.fn();
    const ops = parseExtractionOps('{"fields":{"pets":{"op":"write","value":"two cats"}}}');
    const out = buildDecisions({ ops, rawTextPresent: true, applyDecisions: [], onUnexplained });
    expect(out.pets).toMatchObject({ outcome: 'dropped', verdict: 'not_presented' });
    expect(out.pets!.dropReason).toBeUndefined();
    expect(onUnexplained).toHaveBeenCalledWith('pets');
  });

  it('is safe without an onUnexplained hook', () => {
    const ops = parseExtractionOps('{"fields":{"pets":{"op":"write","value":"two cats"}}}');
    expect(() => buildDecisions({ ops, rawTextPresent: true, applyDecisions: [] })).not.toThrow();
  });
});
