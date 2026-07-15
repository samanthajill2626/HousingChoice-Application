import { describe, it, expect } from 'vitest';
import { PLACEMENT_STAGES } from '../../api/index.js';
import { STAGE_DESCRIPTORS, type StageRecordKind } from './stageDescriptors.js';

describe('STAGE_DESCRIPTORS', () => {
  it('covers exactly the full stage ladder (no missing or extra keys)', () => {
    const ladder = new Set<string>(PLACEMENT_STAGES);
    const keys = new Set<string>(Object.keys(STAGE_DESCRIPTORS));
    // set-EQUALITY: catches both missing AND extra keys
    expect(keys).toEqual(ladder);
  });

  it('gives every "them" gate a non-empty waitingOn', () => {
    for (const [stage, d] of Object.entries(STAGE_DESCRIPTORS)) {
      if (d.gate.kind === 'them') {
        expect(d.gate.waitingOn, `${stage} waitingOn`).toBeTruthy();
        expect(d.gate.waitingOn.trim().length, `${stage} waitingOn`).toBeGreaterThan(0);
      }
    }
  });

  it('gives every "us" gate a non-empty move', () => {
    for (const [stage, d] of Object.entries(STAGE_DESCRIPTORS)) {
      if (d.gate.kind === 'us') {
        expect(d.gate.move, `${stage} move`).toBeTruthy();
        expect(d.gate.move.trim().length, `${stage} move`).toBeGreaterThan(0);
      }
    }
  });

  it('marks exactly the five recording stages with their record kind', () => {
    const expected: Record<string, StageRecordKind> = {
      schedule_inspection: 'inspection_date',
      awaiting_inspection: 'inspection_review',
      determine_rent: 'rent_determined',
      awaiting_rent_acceptance: 'accepted_rent',
      complete_paperwork: 'paperwork',
    };
    const recording = Object.entries(STAGE_DESCRIPTORS)
      .filter(([, d]) => d.record !== 'none')
      .map(([stage]) => stage);
    expect(new Set(recording)).toEqual(new Set(Object.keys(expected)));
    for (const [stage, kind] of Object.entries(expected)) {
      expect(STAGE_DESCRIPTORS[stage as keyof typeof STAGE_DESCRIPTORS].record).toBe(kind);
    }
  });
});
