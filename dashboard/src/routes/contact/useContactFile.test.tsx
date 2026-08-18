import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { PlacementsPage, UnitsPage } from '../../api/index.js';

const getPlacements = vi.fn();
const getUnits = vi.fn();
const getContactListingsSent = vi.fn();
const getContactMedia = vi.fn();
const getContactRelayGroups = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getPlacements: (...a: unknown[]) => getPlacements(...a),
    getUnits: (...a: unknown[]) => getUnits(...a),
    getContactListingsSent: (...a: unknown[]) => getContactListingsSent(...a),
    getContactMedia: (...a: unknown[]) => getContactMedia(...a),
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
      <span data-testid="media">{f.media.status}</span>
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

const CASES: PlacementsPage = {
  nextCursor: null,
  placements: [{ placementId: 'a', tenantId: 'k1', unitId: 'u1', stage: 'schedule_inspection' }],
};
const UNITS: UnitsPage = {
  nextCursor: null,
  units: [{ unitId: 'u1', landlordId: 'k1', status: 'available' }],
};

beforeEach(() => {
  getPlacements.mockReset();
  getUnits.mockReset();
  getContactListingsSent.mockReset();
  getContactMedia.mockReset();
  getContactRelayGroups.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('useContactFile', () => {
  it('loads placements + units and marks C4/C5 + relay-groups pending on a 404', async () => {
    getPlacements.mockResolvedValue(CASES);
    getUnits.mockResolvedValue(UNITS);
    getContactListingsSent.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getContactMedia.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getContactRelayGroups.mockRejectedValue(new ApiError(404, 'not_found', 'x'));

    render(<Probe contactId="k1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('placements').textContent).toBe('1');
    expect(screen.getByTestId('units').textContent).toBe('1');
    expect(screen.getByTestId('sent').textContent).toBe('pending');
    expect(screen.getByTestId('media').textContent).toBe('pending');
    expect(screen.getByTestId('groups').textContent).toBe('pending');
  });

  it('walks every unit page so a landlord past page one still gets their properties', async () => {
    // The server pages /api/units at 50. The contact file's units back the
    // landlord's "Properties" panel AND the per-unit tours fan-out, so a
    // first-page-only read dropped both for anyone whose properties sat later
    // in the scan.
    getPlacements.mockResolvedValue(CASES);
    getUnits.mockImplementation((params: { cursor?: string } = {}) =>
      Promise.resolve(
        params.cursor === undefined
          ? { units: [{ unitId: 'u1', landlordId: 'k1', status: 'available' }], nextCursor: 'page-2' }
          : { units: [{ unitId: 'u2', landlordId: 'k1', status: 'available' }], nextCursor: null },
      ),
    );
    getContactListingsSent.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getContactMedia.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getContactRelayGroups.mockRejectedValue(new ApiError(404, 'not_found', 'x'));

    render(<Probe contactId="k1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('units').textContent).toBe('2');
  });

  it('marks C4/C5 + relay-groups ready when those endpoints answer', async () => {
    getPlacements.mockResolvedValue(CASES);
    getUnits.mockResolvedValue(UNITS);
    getContactListingsSent.mockResolvedValue([]);
    getContactMedia.mockResolvedValue([]);
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
    expect(screen.getByTestId('media').textContent).toBe('ready');
    expect(screen.getByTestId('groups').textContent).toBe('ready');
    expect(screen.getByTestId('groupCount').textContent).toBe('1');
  });

  it('refetch() re-reads the slices for the SAME contact, without flashing loading', async () => {
    // The file fetched once, on mount. A write made elsewhere on the page (the
    // standalone relay-group create) has no SSE handler here, so the page needs
    // a way to ask for the rows again - and the panes must keep rendering the
    // rows they already have while it is in flight.
    getPlacements.mockResolvedValue(CASES);
    getUnits.mockResolvedValue(UNITS);
    getContactListingsSent.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getContactMedia.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
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
    getPlacements.mockResolvedValueOnce(CASES).mockRejectedValue(new ApiError(500, 'boom', 'x'));
    getUnits.mockResolvedValue(UNITS);
    getContactListingsSent.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getContactMedia.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
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
    await waitFor(() => expect(getPlacements).toHaveBeenCalledTimes(2));

    // The refetch failed and the file is merely STALE: same status, same rows.
    expect(screen.getByTestId('status').textContent).toBe('ready');
    expect(screen.getByTestId('placements').textContent).toBe('1');
    expect(screen.getByTestId('groups').textContent).toBe('ready');
    expect(screen.getByTestId('groupCount').textContent).toBe('1');
  });

  it('surfaces an error when placements fail', async () => {
    getPlacements.mockRejectedValue(new ApiError(500, 'boom', 'x'));
    getUnits.mockResolvedValue(UNITS);
    getContactListingsSent.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getContactMedia.mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    getContactRelayGroups.mockRejectedValue(new ApiError(404, 'not_found', 'x'));

    render(<Probe contactId="k1" />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('error'));
  });
});
