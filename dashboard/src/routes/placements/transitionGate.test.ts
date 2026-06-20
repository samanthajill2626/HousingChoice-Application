import { describe, expect, it } from 'vitest';
import { gateFor } from './transitionGate.js';

describe('gateFor', () => {
  it('returns none for a no-op move', () => {
    expect(gateFor('collect_rta', 'collect_rta')).toBe('none');
  });

  it('gates a move to lost', () => {
    expect(gateFor('collect_rta', 'lost')).toBe('lost');
    expect(gateFor('awaiting_inspection', 'lost')).toBe('lost'); // lost wins over the from-gate
  });

  it('gates the move OUT of awaiting_rent_acceptance for finalRent', () => {
    expect(gateFor('awaiting_rent_acceptance', 'awaiting_hap_contract')).toBe('finalRent');
  });

  it('gates the move OUT of awaiting_inspection for inspectionOutcome', () => {
    expect(gateFor('awaiting_inspection', 'determine_rent')).toBe('inspectionOutcome');
  });

  it('returns none for an unrestricted move', () => {
    expect(gateFor('send_application', 'collect_rta')).toBe('none');
  });
});
