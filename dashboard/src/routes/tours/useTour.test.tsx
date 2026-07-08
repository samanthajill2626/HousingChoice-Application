// useTour tests - the tour bundle hook: required tour (404 -> notfound), best-
// effort unit/tenant/landlord joins, setTour-in-place, and a tour.updated refetch.
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { Contact, EventStreamHandlers, Tour, UnitItem } from '../../api/index.js';

const getTour = vi.fn();
const getUnit = vi.fn();
const getContact = vi.fn();
let streamHandlers: EventStreamHandlers | null = null;

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getTour: (...a: unknown[]) => getTour(...a),
    getUnit: (...a: unknown[]) => getUnit(...a),
    getContact: (...a: unknown[]) => getContact(...a),
    useEventStream: (h: EventStreamHandlers) => {
      streamHandlers = h;
    },
  };
});

import { useTour } from './useTour.js';

function makeTour(over: Partial<Tour> = {}): Tour {
  return { tourId: 't1', tenantId: 'ten-1', unitId: 'u1', tourType: 'self_guided', status: 'scheduled', ...over };
}
const unit: UnitItem = { unitId: 'u1', landlordId: 'lord-1', status: 'available' } as UnitItem;
const tenant: Contact = { contactId: 'ten-1', type: 'tenant', firstName: 'Ann' };
const landlord: Contact = { contactId: 'lord-1', type: 'landlord', firstName: 'Lon' };

function Probe({ tourId }: { tourId: string }): React.JSX.Element {
  const s = useTour(tourId);
  return (
    <div>
      <span data-testid="status">{s.status}</span>
      <span data-testid="tour">{s.tour?.status ?? '-'}</span>
      <span data-testid="unit">{s.unit?.unitId ?? '-'}</span>
      <span data-testid="tenant">{s.tenant?.firstName ?? '-'}</span>
      <span data-testid="landlord">{s.landlord?.firstName ?? '-'}</span>
      <button type="button" onClick={() => s.setTour(makeTour({ status: 'toured' }))}>
        set
      </button>
    </div>
  );
}

beforeEach(() => {
  getTour.mockReset();
  getUnit.mockReset();
  getContact.mockReset();
  streamHandlers = null;
  getTour.mockResolvedValue(makeTour());
  getUnit.mockResolvedValue(unit);
  getContact.mockImplementation((id: string) => Promise.resolve(id === 'lord-1' ? landlord : tenant));
});
afterEach(() => vi.restoreAllMocks());

describe('useTour', () => {
  it('loads the tour + best-effort joins (unit / tenant / landlord)', async () => {
    render(<Probe tourId="t1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('unit')).toHaveTextContent('u1');
    expect(screen.getByTestId('tenant')).toHaveTextContent('Ann');
    expect(screen.getByTestId('landlord')).toHaveTextContent('Lon');
    expect(getContact).toHaveBeenCalledWith('ten-1', expect.anything());
    expect(getContact).toHaveBeenCalledWith('lord-1', expect.anything());
  });

  it('a 404 on the tour -> status notfound', async () => {
    getTour.mockRejectedValue(new ApiError(404, 'tour_not_found', 'tour_not_found'));
    render(<Probe tourId="t1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('notfound'));
  });

  it('a non-404 failure on the tour -> status error', async () => {
    getTour.mockRejectedValue(new ApiError(500, 'boom', 'boom'));
    render(<Probe tourId="t1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
  });

  it('a failed join degrades to null but the page still readies', async () => {
    getUnit.mockRejectedValue(new ApiError(404, 'unit_not_found', 'unit_not_found'));
    render(<Probe tourId="t1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('unit')).toHaveTextContent('-');
    // No unit -> no landlord lookup.
    expect(screen.getByTestId('landlord')).toHaveTextContent('-');
  });

  it('setTour applies an updated tour in place (no refetch)', async () => {
    render(<Probe tourId="t1" />);
    await waitFor(() => expect(screen.getByTestId('tour')).toHaveTextContent('scheduled'));
    await userEvent.click(screen.getByRole('button', { name: 'set' }));
    expect(screen.getByTestId('tour')).toHaveTextContent('toured');
    expect(getTour).toHaveBeenCalledTimes(1);
  });

  it('refetches on a tour.updated for THIS tour, ignores others', async () => {
    render(<Probe tourId="t1" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(getTour).toHaveBeenCalledTimes(1);

    act(() => streamHandlers?.onTourUpdated?.({ tourId: 'other', status: 'toured' }));
    expect(getTour).toHaveBeenCalledTimes(1);

    getTour.mockResolvedValue(makeTour({ status: 'toured' }));
    act(() => streamHandlers?.onTourUpdated?.({ tourId: 't1', status: 'toured' }));
    await waitFor(() => expect(screen.getByTestId('tour')).toHaveTextContent('toured'));
    expect(getTour).toHaveBeenCalledTimes(2);
  });
});
