import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { FetchAllPagesResult, PlacementItem, PlacementsPage, UnitItem, UnitsPage } from '../../api/index.js';

const getAllPlacements = vi.fn();
const getAllUnits = vi.fn();
const getContactListingsSent = vi.fn();
const getContactRelayGroups = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getAllPlacements: (...a: unknown[]) => getAllPlacements(...a),
    getAllUnits: (...a: unknown[]) => getAllUnits(...a),
    getContactListingsSent: (...a: unknown[]) => getContactListingsSent(...a),
    getContactRelayGroups: (...a: unknown[]) => getContactRelayGroups(...a),
  };
});

import { useContactFile } from './useContactFile.js';

function Probe({ contactId }: { contactId: string }): React.JSX.Element {
  const f = useContactFile(contactId);
  return (
    <div>
      <span data-testid="status">{f.status}</span>
      <span data-testid="placements">{f.placements.length}</span>
      <span data-testid="units">{f.units.length}</span>
      <span data-testid="sent">{f.listingsSent.status}</span>
      <span data-testid="groups">{f.relayGroups.status}</span>
      <span data-testid="groupCount">
        {f.relayGroups.status === 'ready' ? f.relayGroups.rows.length : ''}
      </span>
      <button type="button" onClick={f.refetch}>
        refetch file
      </button>
    </div>
  );
}

const CASES: FetchAllPagesResult<PlacementItem> = {
  items: [{ placementId: 'a', tenantId: 'k1', unitId: 'u1', stage: 'schedule_inspection' }],
  truncated: false,
};
const UNITS: FetchAllPagesResult<UnitItem> = {
  items: [{ unitId: 'u1', landlordId: 'k1', status: 'available' }],
  truncated: false,
};

beforeEach(() => {
  getAllPlacements.mockReset();
  getAllUnits.mockReset();
  getContactListingsSent.mockReset();
  getContactRelayGroups.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('useContactFile', () => {
  it('loads placements + units and marks C4/C5 + relay-groups pending on a 404', async () => {
    getAllPlacements.mockResolvedValue(CASES);
    getAllUnits.mockResolvedValue(UNITS);
    getContactListingsSent.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getContactRelayGroups.mockRejectedValue(new ApiError(404, 'not_found', 'x'));

    render(<Probe contactId="k1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('placements').textContent).toBe('1');
    expect(screen.getByTestId('units').textContent).toBe('1');
    expect(screen.getByTestId('sent').textContent).toBe('pending');
    expect(screen.getByTestId('groups').textContent).toBe('pending');
  });

  it('keeps every property a landlord owns, not just the first server page', async () => {
    // The contact file's units back the landlord's "Properties" panel AND the
    // per-unit tours fan-out, so a first-page-only read dropped both for anyone
    // whose properties sat later in the scan. getAllUnits now hands over the
    // whole walked roster (api/lists.test.ts proves the walk).
    getAllPlacements.mockResolvedValue(CASES);
    getAllUnits.mockResolvedValue({
      items: [
        { unitId: 'u1', landlordId: 'k1', status: 'available' },
        { unitId: 'u2', landlordId: 'k1', status: 'available' },
      ],
      truncated: false,
    });
    getContactListingsSent.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getContactRelayGroups.mockRejectedValue(new ApiError(404, 'not_found', 'x'));

    render(<Probe contactId="k1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('units').textContent).toBe('2');
  });

  it('marks C4/C5 + relay-groups ready when those endpoints answer', async () => {
    getAllPlacements.mockResolvedValue(CASES);
    getAllUnits.mockResolvedValue(UNITS);
    getContactListingsSent.mockResolvedValue([]);
    getContactRelayGroups.mockResolvedValue([
      {
        conversationId: 'conv-g1',
        status: 'open',
        poolNumber: '+15550190001',
        memberCount: 2,
        lastActivityAt: '2026-07-01T10:00:00Z',
        owner: { type: null },
        otherMemberNames: [],
      },
    ]);

    render(<Probe contactId="k1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('sent').textContent).toBe('ready');
    expect(screen.getByTestId('groups').textContent).toBe('ready');
    expect(screen.getByTestId('groupCount').textContent).toBe('1');
  });

  it('refetch() re-reads the slices for the SAME contact, without flashing loading', async () => {
    // The file fetched once, on mount. A write made elsewhere on the page (the
    // standalone relay-group create) has no SSE handler here, so the page needs
    // a way to ask for the rows again - and the panes must keep rendering the
    // rows they already have while it is in flight.
    getAllPlacements.mockResolvedValue(CASES);
    getAllUnits.mockResolvedValue(UNITS);
    getContactListingsSent.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getContactRelayGroups.mockResolvedValueOnce([]).mockResolvedValue([
      {
        conversationId: 'conv-new',
        status: 'open',
        poolNumber: '+15550190002',
        memberCount: 2,
        lastActivityAt: '2026-08-17T10:00:00Z',
        owner: { type: null },
        otherMemberNames: ['Marcus Bell'],
      },
    ]);

    render(<Probe contactId="k1" />);
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('groupCount').textContent).toBe('0');

    fireEvent.click(screen.getByRole('button', { name: 'refetch file' }));

    await waitFor(() => expect(screen.getByTestId('groupCount').textContent).toBe('1'));
    expect(screen.getByTestId('status').textContent).toBe('ready');
    expect(getContactRelayGroups).toHaveBeenCalledTimes(2);
  });

  it('a FAILED refetch keeps the committed rows on screen instead of wiping the pane', async () => {
    // A reload is not a load. The pane's only error copy replaces EVERY card
    // (placements, tours, properties, relay groups, group threads, media) with
    // one sentence and no retry affordance - an honest answer on mount, and a
    // wipe of good rows when the refetch fired by a SUCCESSFUL create happens to
    // fail. Its failure surface is wide (placements + every /api/units page +,
    // on a landlord file, one getTours per owned unit), so this is not exotic.
    // A stale card is what the card was before the refetch existed.
    getAllPlacements.mockResolvedValueOnce(CASES).mockRejectedValue(new ApiError(500, 'boom', 'x'));
    getAllUnits.mockResolvedValue(UNITS);
    getContactListingsSent.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getContactRelayGroups.mockResolvedValue([
      {
        conversationId: 'conv-g1',
        status: 'open',
        poolNumber: '+15550190001',
        memberCount: 2,
        lastActivityAt: '2026-07-01T10:00:00Z',
        owner: { type: null },
        otherMemberNames: ['Marcus Bell'],
      },
    ]);

    render(<Probe contactId="k1" />);
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));

    fireEvent.click(screen.getByRole('button', { name: 'refetch file' }));
    await waitFor(() => expect(getAllPlacements).toHaveBeenCalledTimes(2));

    // The refetch failed and the file is merely STALE: same status, same rows.
    expect(screen.getByTestId('status').textContent).toBe('ready');
    expect(screen.getByTestId('placements').textContent).toBe('1');
    expect(screen.getByTestId('groups').textContent).toBe('ready');
    expect(screen.getByTestId('groupCount').textContent).toBe('1');
  });

  it('surfaces an error when placements fail', async () => {
    getAllPlacements.mockRejectedValue(new ApiError(500, 'boom', 'x'));
    getAllUnits.mockResolvedValue(UNITS);
    getContactListingsSent.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getContactRelayGroups.mockRejectedValue(new ApiError(404, 'not_found', 'x'));

    render(<Probe contactId="k1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('error'));
  });
});
