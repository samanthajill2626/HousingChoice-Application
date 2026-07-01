// TourDetail component tests — verify:
//   - Tour details (status, scheduledAt) are rendered
//   - Reschedule / cancel controls appear in the right states
//   - The exit gate ("Moving forward? yes/no") is wired to PATCH { outcome, moveForward }
//   - The group-thread link renders when groupThreadId is set
//
// Pattern mirrors PlacementDetail.test.tsx + files.test.tsx: mock the api barrel,
// import the component after mocking, assert accessibility-first.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { Tour } from '../../api/index.js';

const getTour = vi.fn();
const patchTour = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getTour: (...a: unknown[]) => getTour(...a),
    patchTour: (...a: unknown[]) => patchTour(...a),
  };
});

import { TourDetail } from './TourDetail.js';

function makeTour(over: Partial<Tour> = {}): Tour {
  return {
    tourId: 'tour-abc',
    tenantId: 'tenant-1',
    unitId: 'unit-1',
    scheduledAt: '2026-07-10T14:00:00Z',
    tourType: 'self_guided',
    status: 'scheduled',
    ...over,
  };
}

function renderDetail(tourId = 'tour-abc') {
  return render(
    <MemoryRouter initialEntries={[`/tours/${tourId}`]}>
      <Routes>
        <Route path="/tours/:tourId" element={<TourDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TourDetail', () => {
  it('shows a loading state while the tour is fetching', () => {
    getTour.mockReturnValue(new Promise(() => {})); // never resolves
    renderDetail();
    expect(screen.getByText(/Loading tour/i)).toBeInTheDocument();
  });

  it('renders the tour status and scheduled date', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled' }));
    renderDetail();
    await waitFor(() => expect(screen.queryByText(/Loading tour/i)).not.toBeInTheDocument());
    // Status label "Scheduled" appears in the Status row's <dd>
    const statusDd = screen.getByLabelText(/Status: Scheduled/i);
    expect(statusDd).toBeInTheDocument();
    // The scheduledAt date is displayed (aria-label includes "Scheduled:")
    expect(screen.getByLabelText(/Scheduled:/i)).toBeInTheDocument();
  });

  it('shows an error message when the tour is not found', async () => {
    getTour.mockRejectedValue(new ApiError(404, 'tour_not_found', 'tour_not_found'));
    renderDetail();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/tour_not_found/i);
  });

  it('renders reschedule and cancel buttons for a scheduled tour', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled' }));
    renderDetail();
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Reschedule this tour/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel this tour/i })).toBeInTheDocument();
  });

  it('does NOT show reschedule/cancel for a closed tour', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'closed', outcome: 'not_a_fit', moveForward: false }));
    renderDetail();
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Reschedule this tour/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancel this tour/i })).not.toBeInTheDocument();
  });

  it('canceling a tour calls PATCH with status=canceled', async () => {
    const tour = makeTour({ status: 'scheduled' });
    const canceledTour = makeTour({ status: 'canceled' });
    getTour.mockResolvedValue(tour);
    patchTour.mockResolvedValue(canceledTour);

    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: /Cancel this tour/i })).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Cancel this tour/i }));

    expect(patchTour).toHaveBeenCalledWith('tour-abc', { status: 'canceled' });
    await waitFor(() => expect(screen.getByText('Canceled')).toBeInTheDocument());
  });

  it('the reschedule form calls PATCH with scheduledAt + status=scheduled', async () => {
    const tour = makeTour({ status: 'confirmed' });
    const rescheduledTour = makeTour({ status: 'scheduled', scheduledAt: '2026-07-20T10:00:00Z' });
    getTour.mockResolvedValue(tour);
    patchTour.mockResolvedValue(rescheduledTour);

    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: /Reschedule this tour/i })).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Reschedule this tour/i }));

    // Form appears
    expect(screen.getByRole('form', { name: /Reschedule tour form/i })).toBeInTheDocument();
    const dateInput = screen.getByLabelText(/New date and time/i);
    await user.type(dateInput, '2026-07-20T10:00');

    await user.click(screen.getByRole('button', { name: /Confirm reschedule/i }));
    expect(patchTour).toHaveBeenCalledWith('tour-abc', {
      scheduledAt: expect.stringContaining('2026-07-20'),
      status: 'scheduled',
    });
  });

  it('the exit gate shows for a toured tour without an outcome and calls PATCH on submit', async () => {
    const tour = makeTour({ status: 'toured' });
    const closedTour = makeTour({ status: 'toured', outcome: 'move_forward', moveForward: true, convertible: true });
    getTour.mockResolvedValue(tour);
    patchTour.mockResolvedValue(closedTour);

    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: /Record exit gate decision/i })).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Record exit gate decision/i }));

    // The exit gate form appears
    expect(screen.getByRole('form', { name: /Exit gate form/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /Moving forward with this property/i })).toBeInTheDocument();

    // Pick "Yes — move forward"
    await user.click(screen.getByRole('radio', { name: /Yes — move forward/i }));
    await user.click(screen.getByRole('button', { name: /Save decision/i }));

    expect(patchTour).toHaveBeenCalledWith('tour-abc', {
      outcome: 'move_forward',
      moveForward: true,
    });

    // After saving, convertible shows
    await waitFor(() => expect(screen.getByText(/ready for placement/i)).toBeInTheDocument());
  });

  it('exit gate "No — not a fit" calls PATCH with outcome=not_a_fit, moveForward=false', async () => {
    const tour = makeTour({ status: 'toured' });
    const closedTour = makeTour({ status: 'toured', outcome: 'not_a_fit', moveForward: false });
    getTour.mockResolvedValue(tour);
    patchTour.mockResolvedValue(closedTour);

    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: /Record exit gate decision/i })).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Record exit gate decision/i }));
    await user.click(screen.getByRole('radio', { name: /No — not a fit/i }));
    await user.click(screen.getByRole('button', { name: /Save decision/i }));

    expect(patchTour).toHaveBeenCalledWith('tour-abc', {
      outcome: 'not_a_fit',
      moveForward: false,
    });
  });

  it('shows a group thread link when groupThreadId is set', async () => {
    getTour.mockResolvedValue(makeTour({ groupThreadId: 'conv-123' }));
    renderDetail();
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    const link = screen.getByRole('link', { name: /Open group thread in inbox/i });
    expect(link).toBeInTheDocument();
  });

  it('does NOT show a group thread link when groupThreadId is absent', async () => {
    getTour.mockResolvedValue(makeTour({ groupThreadId: undefined }));
    renderDetail();
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /Open group thread in inbox/i })).not.toBeInTheDocument();
  });
});
