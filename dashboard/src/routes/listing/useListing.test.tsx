import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { CasesPage, Contact, UnitItem, UnitsPage } from '../../api/index.js';

const getUnit = vi.fn();
const getUnits = vi.fn();
const getCases = vi.fn();
const getContact = vi.fn();
const getUnitRelated = vi.fn();
const getUnitRecipients = vi.fn();
const getUnitSimilar = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getUnit: (...a: unknown[]) => getUnit(...a),
    getUnits: (...a: unknown[]) => getUnits(...a),
    getCases: (...a: unknown[]) => getCases(...a),
    getContact: (...a: unknown[]) => getContact(...a),
    getUnitRelated: (...a: unknown[]) => getUnitRelated(...a),
    getUnitRecipients: (...a: unknown[]) => getUnitRecipients(...a),
    getUnitSimilar: (...a: unknown[]) => getUnitSimilar(...a),
  };
});

import { useListing } from './useListing.js';

function Probe({ unitId }: { unitId: string }): React.JSX.Element {
  const s = useListing(unitId);
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="roster">{s.roster.length}</span>
      <span data-testid="cases">{s.casesOnUnit.length}</span>
      <span data-testid="related-status">{s.related.status}</span>
      <span data-testid="related-rows">
        {s.related.status === 'ready' ? s.related.rows.length : -1}
      </span>
      <span data-testid="recipients">{s.recipients.status}</span>
      <span data-testid="similar">{s.similar.status}</span>
    </div>
  );
}

const UNIT: UnitItem = { unitId: 'u1', landlordId: 'll1', status: 'available' };
const UNITS: UnitsPage = {
  nextCursor: null,
  units: [UNIT, { unitId: 'u2', landlordId: 'll1', status: 'placed' }],
};
const CASES: CasesPage = {
  nextCursor: null,
  cases: [{ caseId: 'c1', tenantId: 't1', unitId: 'u1', stage: 'applied' }],
};
const LANDLORD: Contact = { contactId: 'll1', type: 'landlord', firstName: 'James' } as Contact;

beforeEach(() => {
  getUnit.mockReset();
  getUnits.mockReset();
  getCases.mockReset();
  getContact.mockReset();
  getUnitRelated.mockReset();
  getUnitRecipients.mockReset();
  getUnitSimilar.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('useListing', () => {
  it('assembles real panels and degrades C4/C6 to pending; related falls back', async () => {
    getUnit.mockResolvedValue(UNIT);
    getUnits.mockResolvedValue(UNITS);
    getCases.mockResolvedValue(CASES);
    getContact.mockResolvedValue(LANDLORD);
    getUnitRelated.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getUnitRecipients.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getUnitSimilar.mockRejectedValue(new ApiError(404, 'not_found', 'x'));

    render(<Probe unitId="u1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    // single landlord fallback row
    expect(screen.getByTestId('roster').textContent).toBe('1');
    expect(screen.getByTestId('cases').textContent).toBe('1');
    // related fell back to same-landlord (u2), ready not pending
    expect(screen.getByTestId('related-status').textContent).toBe('ready');
    expect(screen.getByTestId('related-rows').textContent).toBe('1');
    // C4/C6 stay pending
    expect(screen.getByTestId('recipients').textContent).toBe('pending');
    expect(screen.getByTestId('similar').textContent).toBe('pending');
  });

  it('uses the live /related endpoint when it answers', async () => {
    getUnit.mockResolvedValue(UNIT);
    getUnits.mockResolvedValue(UNITS);
    getCases.mockResolvedValue(CASES);
    getContact.mockResolvedValue(LANDLORD);
    getUnitRelated.mockResolvedValue([
      { unitId: 'u9', status: 'available', relation: 'same_property', label: 'Duplex' },
    ]);
    getUnitRecipients.mockResolvedValue([]);
    getUnitSimilar.mockResolvedValue([]);

    render(<Probe unitId="u1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('related-status').textContent).toBe('ready');
    expect(screen.getByTestId('related-rows').textContent).toBe('1');
    expect(screen.getByTestId('recipients').textContent).toBe('ready');
    expect(screen.getByTestId('similar').textContent).toBe('ready');
  });

  it('errors when the unit itself fails to load', async () => {
    getUnit.mockRejectedValue(new ApiError(500, 'boom', 'x'));
    getUnits.mockResolvedValue(UNITS);
    getCases.mockResolvedValue(CASES);
    getContact.mockResolvedValue(LANDLORD);
    getUnitRelated.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitRecipients.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitSimilar.mockRejectedValue(new ApiError(404, 'x', 'x'));

    render(<Probe unitId="u1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('error'));
  });

  it('tolerates a 404 on the landlord contact (roster still falls back id-only)', async () => {
    getUnit.mockResolvedValue(UNIT);
    getUnits.mockResolvedValue(UNITS);
    getCases.mockResolvedValue(CASES);
    getContact.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getUnitRelated.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitRecipients.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitSimilar.mockRejectedValue(new ApiError(404, 'x', 'x'));

    render(<Probe unitId="u1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('roster').textContent).toBe('1');
  });
});
