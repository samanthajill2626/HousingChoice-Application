import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlacementUpdatedEvent, EventStreamHandlers } from '../../api/index.js';

const getAllPlacements = vi.fn();
const getAllContacts = vi.fn();
const getAllUnits = vi.fn();
// Capture the handlers usePlacements registers so a test can fire a placement.updated event.
let streamHandlers: EventStreamHandlers | null = null;

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getAllPlacements: (...a: unknown[]) => getAllPlacements(...a),
    getAllContacts: (...a: unknown[]) => getAllContacts(...a),
    getAllUnits: (...a: unknown[]) => getAllUnits(...a),
    useEventStream: (h: EventStreamHandlers) => {
      streamHandlers = h;
    },
  };
});

import { usePlacements } from './usePlacements.js';

function Probe(): React.JSX.Element {
  const s = usePlacements();
  const c1 = s.placements.find((c) => c.placementId === 'c1');
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="count">{s.placements.length}</span>
      <span data-testid="stage">{s.placements[0]?.stage ?? '-'}</span>
      <span data-testid="ids">{s.placements.map((c) => c.placementId).join(',')}</span>
      <span data-testid="attention">{c1?.attention ? 'yes' : 'no'}</span>
      <span data-testid="deadline">{c1?.next_deadline_at ?? '-'}</span>
      <span data-testid="contact-names">
        {[...s.contacts.values()].map((c) => c.firstName).join(',')}
      </span>
      <span data-testid="unit-lines">
        {[...s.units.values()]
          .map((u) => (typeof u.address === 'object' ? u.address.line1 : (u.address ?? '')))
          .join(',')}
      </span>
    </div>
  );
}

beforeEach(() => {
  getAllPlacements.mockReset();
  getAllContacts.mockReset();
  getAllUnits.mockReset();
  streamHandlers = null;
  getAllContacts.mockResolvedValue([]);
  getAllUnits.mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe('usePlacements', () => {
  it('loads placements into a ready state', async () => {
    getAllPlacements.mockResolvedValue([{ placementId: 'c1', tenantId: 't1', unitId: 'u1', stage: 'collect_rta' }]);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(screen.getByTestId('stage')).toHaveTextContent('collect_rta');
  });

  it('goes to error when the placements fetch fails', async () => {
    getAllPlacements.mockRejectedValue(new Error('boom'));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
  });

  it('repositions a card on a placement.updated SSE event (patches the stage in place)', async () => {
    getAllPlacements.mockResolvedValue([{ placementId: 'c1', tenantId: 't1', unitId: 'u1', stage: 'collect_rta' }]);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('stage')).toHaveTextContent('collect_rta'));

    const ev: PlacementUpdatedEvent = {
      placementId: 'c1',
      tenantId: 't1',
      unitId: 'u1',
      stage: 'awaiting_inspection',
      tour_date: null,
      next_deadline_type: null,
      next_deadline_at: null,
      group_thread: null,
      attention: false,
      lost_reason: null,
      updated_at: '2026-06-19T00:00:00Z',
    };
    act(() => streamHandlers?.onPlacementUpdated?.(ev));
    await waitFor(() => expect(screen.getByTestId('stage')).toHaveTextContent('awaiting_inspection'));
  });

  it('M2: an SSE event flips attention on and clears a deadline (null)', async () => {
    getAllPlacements.mockResolvedValue([
        {
          placementId: 'c1',
          tenantId: 't1',
          unitId: 'u1',
          stage: 'collect_rta',
          next_deadline_type: 'rta_window',
          next_deadline_at: '2026-06-25T00:00:00Z',
        },
      ]);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    // Initially: not flagged, a deadline present.
    expect(screen.getByTestId('attention')).toHaveTextContent('no');
    expect(screen.getByTestId('deadline')).toHaveTextContent('2026-06-25T00:00:00Z');

    const ev: PlacementUpdatedEvent = {
      placementId: 'c1',
      tenantId: 't1',
      unitId: 'u1',
      stage: 'collect_rta',
      tour_date: null,
      next_deadline_type: null, // cleared
      next_deadline_at: null, // cleared
      group_thread: null,
      attention: true, // flipped on
      lost_reason: null,
      updated_at: '2026-06-19T00:00:00Z',
    };
    act(() => streamHandlers?.onPlacementUpdated?.(ev));

    // Attention dot lights up; the cleared deadline is removed (not kept).
    await waitFor(() => expect(screen.getByTestId('attention')).toHaveTextContent('yes'));
    expect(screen.getByTestId('deadline')).toHaveTextContent('-');
  });

  it('includes SOFT-DELETED tenants and units in the lookup maps (live wins an id collision)', async () => {
    // A closed placement outlives its tenant/unit: both were soft-deleted after
    // move-in/loss. The lookup maps must still carry them so the ledger shows
    // names, not raw ids. On a (defensive) id collision the LIVE record wins.
    getAllPlacements.mockResolvedValue([{ placementId: 'c1', tenantId: 't-del', unitId: 'u-del', stage: 'moved_in' }]);
    getAllContacts.mockImplementation((params: { deleted?: boolean }) =>
      params.deleted === true
        ? Promise.resolve([
              { contactId: 't-del', type: 'tenant', firstName: 'Dora', lastName: 'Departed' },
              // Defensive collision: a deleted record sharing a live id must LOSE.
              { contactId: 't1', type: 'tenant', firstName: 'Stale', lastName: 'Copy' },
            ])
        : Promise.resolve([{ contactId: 't1', type: 'tenant', firstName: 'Alice', lastName: 'Live' }]),
    );
    getAllUnits.mockImplementation((params: { deleted?: boolean }) =>
      params?.deleted === true
        ? Promise.resolve([{ unitId: 'u-del', address: { line1: '789 Gone St' } }])
        : Promise.resolve([{ unitId: 'u1', address: { line1: '123 Live Ave' } }]),
    );
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    const names = screen.getByTestId('contact-names').textContent ?? '';
    expect(names).toContain('Dora'); // deleted tenant present
    expect(names).toContain('Alice'); // live tenant present
    expect(names).not.toContain('Stale'); // live wins the collision
    const lines = screen.getByTestId('unit-lines').textContent ?? '';
    expect(lines).toContain('789 Gone St'); // deleted unit present
    expect(lines).toContain('123 Live Ave'); // live unit present
  });

  it('M3: shows the WHOLE pipeline the walk returns, not a first-page prefix', async () => {
    // The cursor walk itself lives in getAllPlacements (api/lists.test.ts). The
    // board's own job is to render everything it is handed - a board that shows
    // a prefix is worse than one that shows nothing, because it looks complete.
    getAllPlacements.mockResolvedValue([
        { placementId: 'c1', tenantId: 't1', unitId: 'u1', stage: 'collect_rta' },
        { placementId: 'c2', tenantId: 't2', unitId: 'u2', stage: 'determine_rent' },
      ]);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('count')).toHaveTextContent('2');
    expect(screen.getByTestId('ids')).toHaveTextContent('c1,c2');
  });
});
