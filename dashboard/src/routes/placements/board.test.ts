import { describe, expect, it } from 'vitest';
import type { PlacementItem, PlacementStage } from '../../api/index.js';
import {
  FIRST_STAGE_OF_PHASE,
  buildBoard,
  firstStageOfPhase,
  isNoOpMove,
  isTerminal,
  phaseOfPlacement,
} from './board.js';

function mkPlacement(placementId: string, stage: PlacementStage): PlacementItem {
  return { placementId, tenantId: `t-${placementId}`, unitId: `u-${placementId}`, stage };
}

describe('casesBoard helpers', () => {
  it('maps each phase to its first stage in the ladder', () => {
    expect(FIRST_STAGE_OF_PHASE).toEqual({
      Application: 'send_application',
      RTA: 'collect_rta',
      Inspection: 'schedule_inspection',
      'Rent Determination': 'determine_rent',
      Contract: 'awaiting_hap_contract',
      Administrative: 'complete_paperwork',
      Closure: 'awaiting_move_in',
    });
    expect(firstStageOfPhase('RTA')).toBe('collect_rta');
  });

  it('flags only the terminal stages', () => {
    expect(isTerminal('moved_in')).toBe(true);
    expect(isTerminal('lost')).toBe(true);
    expect(isTerminal('searching' as PlacementStage)).toBe(false);
    expect(isTerminal('awaiting_move_in')).toBe(false);
  });

  it('groups active placements into their phase columns', () => {
    const placements = [
      mkPlacement('a', 'send_application'), // Application
      mkPlacement('b', 'review_rta'), // RTA
      mkPlacement('c', 'awaiting_inspection'), // Inspection
      mkPlacement('d', 'awaiting_move_in'), // Closure (active)
    ];
    const board = buildBoard(placements);
    expect(board.columns).toHaveLength(7);
    const byPhase = Object.fromEntries(board.columns.map((col) => [col.phase, col.placements.map((c) => c.placementId)]));
    expect(byPhase['Application']).toEqual(['a']);
    expect(byPhase['RTA']).toEqual(['b']);
    expect(byPhase['Inspection']).toEqual(['c']);
    expect(byPhase['Closure']).toEqual(['d']);
    expect(board.closed).toEqual([]);
  });

  it('routes terminal placements to the closed bucket, not the Closure column', () => {
    const placements = [
      mkPlacement('a', 'awaiting_move_in'), // active Closure
      mkPlacement('m', 'moved_in'), // terminal
      mkPlacement('l', 'lost'), // terminal
    ];
    const board = buildBoard(placements);
    const closure = board.columns.find((col) => col.phase === 'Closure');
    expect(closure?.placements.map((c) => c.placementId)).toEqual(['a']);
    expect(board.closed.map((c) => c.placementId)).toEqual(['m', 'l']);
  });

  it('exposes the drop-target (first) stage per column', () => {
    const board = buildBoard([]);
    const targets = Object.fromEntries(board.columns.map((col) => [col.phase, col.targetStage]));
    expect(targets['Application']).toBe('send_application');
    expect(targets['Closure']).toBe('awaiting_move_in');
  });

  it('phaseOfPlacement returns the phase for active placements and null for terminal', () => {
    expect(phaseOfPlacement(mkPlacement('a', 'collect_rta'))).toBe('RTA');
    expect(phaseOfPlacement(mkPlacement('m', 'moved_in'))).toBeNull();
  });

  it('M1: isNoOpMove is true for same-stage and same-phase moves, false cross-phase', () => {
    // Same exact stage.
    expect(isNoOpMove('collect_rta', 'collect_rta')).toBe(true);
    // Same phase, different stage (the regression bug: dropping
    // awaiting_rent_acceptance back onto its own Rent Determination column, whose
    // first stage is determine_rent).
    expect(isNoOpMove('awaiting_rent_acceptance', 'determine_rent')).toBe(true);
    // Cross-phase → a real move.
    expect(isNoOpMove('collect_rta', 'schedule_inspection')).toBe(false);
  });

  it('m8: keeps an unknown/legacy stage visible (Closed bucket), never drops it', () => {
    const placements = [
      mkPlacement('ok', 'collect_rta'),
      mkPlacement('legacy', 'a_removed_stage' as PlacementStage),
    ];
    const board = buildBoard(placements);
    // Not in any active column...
    const inColumns = board.columns.flatMap((col) => col.placements.map((c) => c.placementId));
    expect(inColumns).toContain('ok');
    expect(inColumns).not.toContain('legacy');
    // ...but still present in the Closed area (visible + openable), not dropped.
    expect(board.closed.map((c) => c.placementId)).toContain('legacy');
  });
});
