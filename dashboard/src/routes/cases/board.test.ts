import { describe, expect, it } from 'vitest';
import type { CaseItem, PlacementStage } from '../../api/index.js';
import {
  FIRST_STAGE_OF_PHASE,
  buildBoard,
  firstStageOfPhase,
  isNoOpMove,
  isTerminal,
  phaseOfCase,
} from './board.js';

function mkCase(caseId: string, stage: PlacementStage): CaseItem {
  return { caseId, tenantId: `t-${caseId}`, unitId: `u-${caseId}`, stage };
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

  it('groups active cases into their phase columns', () => {
    const cases = [
      mkCase('a', 'send_application'), // Application
      mkCase('b', 'review_rta'), // RTA
      mkCase('c', 'awaiting_inspection'), // Inspection
      mkCase('d', 'awaiting_move_in'), // Closure (active)
    ];
    const board = buildBoard(cases);
    expect(board.columns).toHaveLength(7);
    const byPhase = Object.fromEntries(board.columns.map((col) => [col.phase, col.cases.map((c) => c.caseId)]));
    expect(byPhase['Application']).toEqual(['a']);
    expect(byPhase['RTA']).toEqual(['b']);
    expect(byPhase['Inspection']).toEqual(['c']);
    expect(byPhase['Closure']).toEqual(['d']);
    expect(board.closed).toEqual([]);
  });

  it('routes terminal cases to the closed bucket, not the Closure column', () => {
    const cases = [
      mkCase('a', 'awaiting_move_in'), // active Closure
      mkCase('m', 'moved_in'), // terminal
      mkCase('l', 'lost'), // terminal
    ];
    const board = buildBoard(cases);
    const closure = board.columns.find((col) => col.phase === 'Closure');
    expect(closure?.cases.map((c) => c.caseId)).toEqual(['a']);
    expect(board.closed.map((c) => c.caseId)).toEqual(['m', 'l']);
  });

  it('exposes the drop-target (first) stage per column', () => {
    const board = buildBoard([]);
    const targets = Object.fromEntries(board.columns.map((col) => [col.phase, col.targetStage]));
    expect(targets['Application']).toBe('send_application');
    expect(targets['Closure']).toBe('awaiting_move_in');
  });

  it('phaseOfCase returns the phase for active cases and null for terminal', () => {
    expect(phaseOfCase(mkCase('a', 'collect_rta'))).toBe('RTA');
    expect(phaseOfCase(mkCase('m', 'moved_in'))).toBeNull();
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
    const cases = [
      mkCase('ok', 'collect_rta'),
      mkCase('legacy', 'a_removed_stage' as PlacementStage),
    ];
    const board = buildBoard(cases);
    // Not in any active column...
    const inColumns = board.columns.flatMap((col) => col.cases.map((c) => c.caseId));
    expect(inColumns).toContain('ok');
    expect(inColumns).not.toContain('legacy');
    // ...but still present in the Closed area (visible + openable), not dropped.
    expect(board.closed.map((c) => c.caseId)).toContain('legacy');
  });
});
