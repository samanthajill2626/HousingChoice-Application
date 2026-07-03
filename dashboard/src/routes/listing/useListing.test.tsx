import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { PlacementsPage, Contact, UnitItem, UnitsPage } from '../../api/index.js';

const getUnit = vi.fn();
const getUnits = vi.fn();
const getPlacements = vi.fn();
const getContact = vi.fn();
const getUnitRelated = vi.fn();
const getUnitRecipients = vi.fn();
const getUnitSimilar = vi.fn();
const getUnitActivity = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getUnit: (...a: unknown[]) => getUnit(...a),
    getUnits: (...a: unknown[]) => getUnits(...a),
    getPlacements: (...a: unknown[]) => getPlacements(...a),
    getContact: (...a: unknown[]) => getContact(...a),
    getUnitRelated: (...a: unknown[]) => getUnitRelated(...a),
    getUnitRecipients: (...a: unknown[]) => getUnitRecipients(...a),
    getUnitSimilar: (...a: unknown[]) => getUnitSimilar(...a),
    getUnitActivity: (...a: unknown[]) => getUnitActivity(...a),
  };
});

import { useListing } from './useListing.js';

function Probe({ unitId }: { unitId: string }): React.JSX.Element {
  const s = useListing(unitId);
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="roster">{s.roster.length}</span>
      <span data-testid="placements">{s.placementsOnUnit.length}</span>
      <span data-testid="related-status">{s.related.status}</span>
      <span data-testid="related-rows">
        {s.related.status === 'ready' ? s.related.rows.length : -1}
      </span>
      <span data-testid="recipients">{s.recipients.status}</span>
      <span data-testid="similar">{s.similar.status}</span>
      <span data-testid="activity">{s.activity.status}</span>
      <span data-testid="activity-rows">
        {s.activity.status === 'ready' ? s.activity.rows.length : -1}
      </span>
    </div>
  );
}

const UNIT: UnitItem = { unitId: 'u1', landlordId: 'll1', status: 'available' };
const UNITS: UnitsPage = {
  nextCursor: null,
  units: [UNIT, { unitId: 'u2', landlordId: 'll1', status: 'occupied' }],
};
const CASES: PlacementsPage = {
  nextCursor: null,
  placements: [{ placementId: 'c1', tenantId: 't1', unitId: 'u1', stage: 'awaiting_approval' }],
};
const LANDLORD: Contact = { contactId: 'll1', type: 'landlord', firstName: 'James' } as Contact;

beforeEach(() => {
  getUnit.mockReset();
  getUnits.mockReset();
  getPlacements.mockReset();
  getContact.mockReset();
  getUnitRelated.mockReset();
  getUnitRecipients.mockReset();
  getUnitSimilar.mockReset();
  getUnitActivity.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('useListing', () => {
  it('assembles real panels and degrades C4/C6 to pending; related falls back', async () => {
    getUnit.mockResolvedValue(UNIT);
    getUnits.mockResolvedValue(UNITS);
    getPlacements.mockResolvedValue(CASES);
    getContact.mockResolvedValue(LANDLORD);
    getUnitRelated.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getUnitRecipients.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getUnitSimilar.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getUnitActivity.mockRejectedValue(new ApiError(404, 'not_found', 'x'));

    render(<Probe unitId="u1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    // single landlord fallback row
    expect(screen.getByTestId('roster').textContent).toBe('1');
    expect(screen.getByTestId('placements').textContent).toBe('1');
    // related fell back to same-landlord (u2), ready not pending
    expect(screen.getByTestId('related-status').textContent).toBe('ready');
    expect(screen.getByTestId('related-rows').textContent).toBe('1');
    // C4/C6 stay pending
    expect(screen.getByTestId('recipients').textContent).toBe('pending');
    expect(screen.getByTestId('similar').textContent).toBe('pending');
    // activity degrades the same way on an older deployed backend
    expect(screen.getByTestId('activity').textContent).toBe('pending');
  });

  it('uses the live /related endpoint when it answers', async () => {
    getUnit.mockResolvedValue(UNIT);
    getUnits.mockResolvedValue(UNITS);
    getPlacements.mockResolvedValue(CASES);
    getContact.mockResolvedValue(LANDLORD);
    getUnitRelated.mockResolvedValue([
      { unitId: 'u9', status: 'available', relation: 'same_property', label: 'Duplex' },
    ]);
    getUnitRecipients.mockResolvedValue([]);
    getUnitSimilar.mockResolvedValue([]);
    getUnitActivity.mockResolvedValue([
      { id: '2026-07-01T09:00:00.000Z#000001', at: '2026-07-01T09:00:00.000Z', type: 'unit_created' },
    ]);

    render(<Probe unitId="u1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('related-status').textContent).toBe('ready');
    expect(screen.getByTestId('related-rows').textContent).toBe('1');
    expect(screen.getByTestId('recipients').textContent).toBe('ready');
    expect(screen.getByTestId('similar').textContent).toBe('ready');
    expect(screen.getByTestId('activity').textContent).toBe('ready');
    expect(screen.getByTestId('activity-rows').textContent).toBe('1');
  });

  it('errors when the unit itself fails to load', async () => {
    getUnit.mockRejectedValue(new ApiError(500, 'boom', 'x'));
    getUnits.mockResolvedValue(UNITS);
    getPlacements.mockResolvedValue(CASES);
    getContact.mockResolvedValue(LANDLORD);
    getUnitRelated.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitRecipients.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitSimilar.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitActivity.mockRejectedValue(new ApiError(404, 'x', 'x'));

    render(<Probe unitId="u1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('error'));
  });

  it('tolerates a 404 on the landlord contact (roster still falls back id-only)', async () => {
    getUnit.mockResolvedValue(UNIT);
    getUnits.mockResolvedValue(UNITS);
    getPlacements.mockResolvedValue(CASES);
    getContact.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getUnitRelated.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitRecipients.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitSimilar.mockRejectedValue(new ApiError(404, 'x', 'x'));
    getUnitActivity.mockRejectedValue(new ApiError(404, 'x', 'x'));

    render(<Probe unitId="u1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('roster').textContent).toBe('1');
  });
});
