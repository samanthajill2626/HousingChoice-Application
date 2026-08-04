import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlacementUpdatedEvent, EventStreamHandlers } from '../../api/index.js';

const getPlacements = vi.fn();
const getContacts = vi.fn();
const getUnits = vi.fn();
// Capture the handlers usePlacements registers so a test can fire a placement.updated event.
let streamHandlers: EventStreamHandlers | null = null;

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getPlacements: (...a: unknown[]) => getPlacements(...a),
    getContacts: (...a: unknown[]) => getContacts(...a),
    getUnits: (...a: unknown[]) => getUnits(...a),
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
  getPlacements.mockReset();
  getContacts.mockReset();
  getUnits.mockReset();
  streamHandlers = null;
  getContacts.mockResolvedValue({ contacts: [], nextCursor: null });
  getUnits.mockResolvedValue({ units: [], nextCursor: null });
});
afterEach(() => vi.restoreAllMocks());

describe('usePlacements', () => {
  it('loads placements into a ready state', async () => {
    getPlacements.mockResolvedValue({
      placements: [{ placementId: 'c1', tenantId: 't1', unitId: 'u1', stage: 'collect_rta' }],
      nextCursor: null,
    });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(screen.getByTestId('stage')).toHaveTextContent('collect_rta');
  });

  it('goes to error when the placements fetch fails', async () => {
    getPlacements.mockRejectedValue(new Error('boom'));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
  });

  it('repositions a card on a placement.updated SSE event (patches the stage in place)', async () => {
    getPlacements.mockResolvedValue({
      placements: [{ placementId: 'c1', tenantId: 't1', unitId: 'u1', stage: 'collect_rta' }],
      nextCursor: null,
    });
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
    getPlacements.mockResolvedValue({
      placements: [
        {
          placementId: 'c1',
          tenantId: 't1',
          unitId: 'u1',
          stage: 'collect_rta',
          next_deadline_type: 'rta_window',
          next_deadline_at: '2026-06-25T00:00:00Z',
        },
      ],
      nextCursor: null,
    });
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
    getPlacements.mockResolvedValue({
      placements: [{ placementId: 'c1', tenantId: 't-del', unitId: 'u-del', stage: 'moved_in' }],
      nextCursor: null,
    });
    getContacts.mockImplementation((params: { deleted?: boolean }) =>
      params.deleted === true
        ? Promise.resolve({
            contacts: [
              { contactId: 't-del', type: 'tenant', firstName: 'Dora', lastName: 'Departed' },
              // Defensive collision: a deleted record sharing a live id must LOSE.
              { contactId: 't1', type: 'tenant', firstName: 'Stale', lastName: 'Copy' },
            ],
            nextCursor: null,
          })
        : Promise.resolve({
            contacts: [{ contactId: 't1', type: 'tenant', firstName: 'Alice', lastName: 'Live' }],
            nextCursor: null,
          }),
    );
    getUnits.mockImplementation((params: { deleted?: boolean }) =>
      params?.deleted === true
        ? Promise.resolve({
            units: [{ unitId: 'u-del', address: { line1: '789 Gone St' } }],
            nextCursor: null,
          })
        : Promise.resolve({
            units: [{ unitId: 'u1', address: { line1: '123 Live Ave' } }],
            nextCursor: null,
          }),
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

  it('M3: pages through ALL placements (page-2 placements appear on the board)', async () => {
    getPlacements.mockImplementation((_signal: unknown, cursor?: string) =>
      cursor === undefined
        ? Promise.resolve({
            placements: [{ placementId: 'c1', tenantId: 't1', unitId: 'u1', stage: 'collect_rta' }],
            nextCursor: 'CUR2',
          })
        : Promise.resolve({
            placements: [{ placementId: 'c2', tenantId: 't2', unitId: 'u2', stage: 'determine_rent' }],
            nextCursor: null,
          }),
    );
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    // Both the page-1 AND the page-2 placement are present.
    expect(screen.getByTestId('count')).toHaveTextContent('2');
    expect(screen.getByTestId('ids')).toHaveTextContent('c1,c2');
    // The second call followed the cursor.
    expect(getPlacements).toHaveBeenCalledTimes(2);
    expect(getPlacements).toHaveBeenLastCalledWith(expect.anything(), 'CUR2');
  });
});
