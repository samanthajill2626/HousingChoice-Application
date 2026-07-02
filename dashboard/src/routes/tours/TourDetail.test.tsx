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
const createTourRelay = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getTour: (...a: unknown[]) => getTour(...a),
    patchTour: (...a: unknown[]) => patchTour(...a),
    createTourRelay: (...a: unknown[]) => createTourRelay(...a),
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
    expect(screen.queryByRole('button', { name: 'Book tour' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancel this tour/i })).not.toBeInTheDocument();
  });

  // Retargeted from ours' 'Book a time' overload onto main's dedicated 'Book tour'
  // control — preserving ours' unique assertion that Cancel is visible on a
  // requested tour (booking is a separate verb from Reschedule).
  it('a requested tour renders the Book control and Cancel controls', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'requested', scheduledAt: undefined }));
    renderDetail();
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    // 'Book tour' — not 'Reschedule' — for a tour never yet scheduled
    expect(screen.getByRole('button', { name: 'Book tour' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reschedule this tour/i })).not.toBeInTheDocument();
    // Cancel must also be present
    expect(screen.getByRole('button', { name: /Cancel this tour/i })).toBeInTheDocument();
  });

  // Retargeted from ours' 'Book a time' overload onto main's 'Book tour' form —
  // preserving ours' unique looser assertion: patchTour is called with an object
  // CONTAINING scheduledAt (status may also be present).
  it('booking a time on a requested tour PATCHes scheduledAt and the UI reflects scheduled', async () => {
    const requestedTour = makeTour({ status: 'requested', scheduledAt: undefined });
    const scheduledTour = makeTour({ status: 'scheduled', scheduledAt: '2026-07-20T10:00:00Z' });
    getTour.mockResolvedValue(requestedTour);
    patchTour.mockResolvedValue(scheduledTour);

    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Book tour' })).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Book tour' }));

    // Booking form must appear
    expect(screen.getByRole('form', { name: 'Book tour form' })).toBeInTheDocument();
    const dateInput = screen.getByLabelText(/Date and time/i);
    await user.type(dateInput, '2026-07-20T10:00');

    await user.click(screen.getByRole('button', { name: /Confirm booking/i }));

    // PATCH must include scheduledAt (status: 'scheduled' may also be included)
    expect(patchTour).toHaveBeenCalledWith(
      'tour-abc',
      expect.objectContaining({ scheduledAt: expect.stringContaining('2026-07-20') }),
    );
    // After PATCH the UI reflects the new status
    await waitFor(() => expect(screen.getByLabelText(/Status: Scheduled/i)).toBeInTheDocument());
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

  it('exit gate "No — not a fit" PATCHes outcome + moveForward AND closes the tour (diagram: not_a_fit closes)', async () => {
    const tour = makeTour({ status: 'toured' });
    const closedTour = makeTour({ status: 'closed', outcome: 'not_a_fit', moveForward: false });
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
      status: 'closed',
    });
    // The page reflects the closed tour.
    expect(screen.getByLabelText(/Status: Closed/i)).toBeInTheDocument();
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

  // ── The 'requested' (timeless) state — tours-sequence Task 4 ────────────────
  // A requested tour has NO scheduledAt: it renders 'Not yet booked', offers a
  // 'Book tour' control (NOT Reschedule — booking is its own verb), and can be
  // canceled.
  /** A timeless 'requested' tour: makeTour minus its scheduledAt. */
  function makeRequestedTour(over: Partial<Tour> = {}): Tour {
    const base = makeTour();
    delete base.scheduledAt; // timeless — the property is truly absent
    return { ...base, status: 'requested', ...over };
  }

  it("renders 'Requested' status and 'Not yet booked' for a timeless requested tour", async () => {
    getTour.mockResolvedValue(makeRequestedTour());
    renderDetail();
    await waitFor(() => expect(screen.queryByText(/Loading tour/i)).not.toBeInTheDocument());
    expect(screen.getByLabelText(/Status: Requested/i)).toBeInTheDocument();
    const scheduledDd = screen.getByLabelText('Scheduled: Not yet booked');
    expect(scheduledDd).toHaveTextContent('Not yet booked');
    expect(screen.queryByText(/Invalid Date/i)).not.toBeInTheDocument();
  });

  it('shows the Book control (not Reschedule) plus Cancel tour for a requested tour', async () => {
    getTour.mockResolvedValue(makeRequestedTour());
    renderDetail();
    await waitFor(() => expect(screen.queryByText(/Loading tour/i)).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Book tour' })).toHaveTextContent('Book tour');
    expect(screen.queryByRole('button', { name: /Reschedule this tour/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel this tour/i })).toBeInTheDocument();
  });

  it('does NOT show the Book control for a scheduled tour', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled' }));
    renderDetail();
    await waitFor(() => expect(screen.queryByText(/Loading tour/i)).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Book tour' })).not.toBeInTheDocument();
  });

  it('booking a requested tour PATCHes { scheduledAt, status: scheduled }', async () => {
    const tour = makeRequestedTour();
    const bookedTour = makeTour({ status: 'scheduled', scheduledAt: '2026-07-20T10:00:00Z' });
    getTour.mockResolvedValue(tour);
    patchTour.mockResolvedValue(bookedTour);

    renderDetail();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Book tour' })).toBeInTheDocument(),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Book tour' }));

    // The booking form appears — mirrors the Reschedule form structure.
    const form = screen.getByRole('form', { name: 'Book tour form' });
    expect(form).toBeInTheDocument();
    const dateInput = screen.getByLabelText('Date and time');
    expect(dateInput).toBeRequired();
    await user.type(dateInput, '2026-07-20T10:00');

    await user.click(screen.getByRole('button', { name: /Confirm booking/i }));
    expect(patchTour).toHaveBeenCalledWith('tour-abc', {
      scheduledAt: expect.stringContaining('2026-07-20'),
      status: 'scheduled',
    });
    // The page applies the returned tour: status flips to Scheduled.
    await waitFor(() => expect(screen.getByLabelText(/Status: Scheduled/i)).toBeInTheDocument());
  });

  it('the Book form Cancel dismisses without PATCHing', async () => {
    getTour.mockResolvedValue(makeRequestedTour());
    renderDetail();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Book tour' })).toBeInTheDocument(),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Book tour' }));
    expect(screen.getByRole('form', { name: 'Book tour form' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Cancel$/ }));

    expect(screen.queryByRole('form', { name: 'Book tour form' })).not.toBeInTheDocument();
    expect(patchTour).not.toHaveBeenCalled();
  });

  // ── Status controls + open-group affordance — tours-sequence Task 5 ─────────
  // Confirm tour (scheduled only), Mark toured / Mark no-show (scheduled or
  // confirmed — Mark toured is what makes the exit gate reachable), and the
  // 'Open group thread' button (no groupThreadId yet, tour not canceled/closed).

  it("a scheduled tour shows 'Confirm tour', 'Mark toured', and 'Mark no-show'", async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled' }));
    renderDetail();
    await waitFor(() => expect(screen.queryByText(/Loading tour/i)).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Confirm tour' })).toHaveTextContent('Confirm tour');
    expect(screen.getByRole('button', { name: 'Mark toured' })).toHaveTextContent('Mark toured');
    expect(screen.getByRole('button', { name: 'Mark no-show' })).toHaveTextContent('Mark no-show');
  });

  it("a confirmed tour shows 'Mark toured' + 'Mark no-show' but NOT 'Confirm tour'", async () => {
    getTour.mockResolvedValue(makeTour({ status: 'confirmed' }));
    renderDetail();
    await waitFor(() => expect(screen.queryByText(/Loading tour/i)).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Confirm tour' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark toured' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark no-show' })).toBeInTheDocument();
  });

  it('a requested tour shows NONE of the three status controls', async () => {
    getTour.mockResolvedValue(makeRequestedTour());
    renderDetail();
    await waitFor(() => expect(screen.queryByText(/Loading tour/i)).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Confirm tour' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark toured' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark no-show' })).not.toBeInTheDocument();
  });

  it("a toured tour shows none of the three; 'Record outcome' is present", async () => {
    getTour.mockResolvedValue(makeTour({ status: 'toured' }));
    renderDetail();
    await waitFor(() => expect(screen.queryByText(/Loading tour/i)).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Confirm tour' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark toured' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark no-show' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Record exit gate decision/i })).toBeInTheDocument();
  });

  it("'Confirm tour' PATCHes { status: confirmed } and disappears after success", async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled' }));
    patchTour.mockResolvedValue(makeTour({ status: 'confirmed' }));
    renderDetail();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Confirm tour' })).toBeInTheDocument(),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Confirm tour' }));

    expect(patchTour).toHaveBeenCalledWith('tour-abc', { status: 'confirmed' });
    await waitFor(() => expect(screen.getByLabelText(/Status: Confirmed/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Confirm tour' })).not.toBeInTheDocument();
    // Attendance controls remain available on a confirmed tour.
    expect(screen.getByRole('button', { name: 'Mark toured' })).toBeInTheDocument();
  });

  it("'Mark toured' PATCHes { status: toured }; controls swap to 'Record outcome'", async () => {
    getTour.mockResolvedValue(makeTour({ status: 'confirmed' }));
    patchTour.mockResolvedValue(makeTour({ status: 'toured' }));
    renderDetail();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Mark toured' })).toBeInTheDocument(),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Mark toured' }));

    expect(patchTour).toHaveBeenCalledWith('tour-abc', { status: 'toured' });
    await waitFor(() => expect(screen.getByLabelText(/Status: Toured/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Confirm tour' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark toured' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark no-show' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Record exit gate decision/i })).toBeInTheDocument();
  });

  it("'Mark no-show' PATCHes { status: no_show }", async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled' }));
    patchTour.mockResolvedValue(makeTour({ status: 'no_show' }));
    renderDetail();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Mark no-show' })).toBeInTheDocument(),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Mark no-show' }));

    expect(patchTour).toHaveBeenCalledWith('tour-abc', { status: 'no_show' });
    await waitFor(() => expect(screen.getByLabelText(/Status: No show/i)).toBeInTheDocument());
  });

  it("shows 'Open group thread' when the tour has no groupThreadId", async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled', groupThreadId: undefined }));
    renderDetail();
    await waitFor(() => expect(screen.queryByText(/Loading tour/i)).not.toBeInTheDocument());
    expect(
      screen.getByRole('button', { name: 'Open group thread' }),
    ).toHaveTextContent('Open group thread');
  });

  it("shows 'Open group thread' for a requested tour too (no group yet)", async () => {
    getTour.mockResolvedValue(makeRequestedTour());
    renderDetail();
    await waitFor(() => expect(screen.queryByText(/Loading tour/i)).not.toBeInTheDocument());
    expect(
      screen.getByRole('button', { name: 'Open group thread' }),
    ).toBeInTheDocument();
  });

  it("hides 'Open group thread' when groupThreadId is set; the view link shows instead", async () => {
    getTour.mockResolvedValue(makeTour({ groupThreadId: 'conv-123' }));
    renderDetail();
    await waitFor(() => expect(screen.queryByText(/Loading tour/i)).not.toBeInTheDocument());
    expect(
      screen.queryByRole('button', { name: 'Open group thread' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open group thread in inbox/i })).toBeInTheDocument();
  });

  it("hides 'Open group thread' for canceled and closed tours", async () => {
    getTour.mockResolvedValue(makeTour({ status: 'canceled', groupThreadId: undefined }));
    const first = renderDetail();
    await waitFor(() => expect(screen.queryByText(/Loading tour/i)).not.toBeInTheDocument());
    expect(
      screen.queryByRole('button', { name: 'Open group thread' }),
    ).not.toBeInTheDocument();
    first.unmount();

    getTour.mockResolvedValue(
      makeTour({ status: 'closed', outcome: 'not_a_fit', moveForward: false, groupThreadId: undefined }),
    );
    renderDetail();
    await waitFor(() => expect(screen.queryByText(/Loading tour/i)).not.toBeInTheDocument());
    expect(
      screen.queryByRole('button', { name: 'Open group thread' }),
    ).not.toBeInTheDocument();
  });

  it("'Open group thread' calls createTourRelay with ONLY the tourId; on success the link appears", async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled', groupThreadId: undefined }));
    createTourRelay.mockResolvedValue({
      tour: makeTour({ status: 'scheduled', groupThreadId: 'conv-999' }),
      conversation: {},
    });
    renderDetail();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Open group thread' }),
      ).toBeInTheDocument(),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open group thread' }));

    // Exactly one argument — members omitted so the server auto-resolves them.
    expect(createTourRelay).toHaveBeenCalledWith('tour-abc');
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /Open group thread in inbox/i })).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('button', { name: 'Open group thread' }),
    ).not.toBeInTheDocument();
  });

  it('relay_member_unresolvable renders the detail text inline', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled', groupThreadId: undefined }));
    createTourRelay.mockRejectedValue(
      new ApiError(
        400,
        'relay_member_unresolvable',
        'relay_member_unresolvable (Tenant has no phone number on file)',
        { error: 'relay_member_unresolvable', detail: 'Tenant has no phone number on file' },
      ),
    );
    renderDetail();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Open group thread' }),
      ).toBeInTheDocument(),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open group thread' }));

    // The detail text — and ONLY the detail text — is the inline error.
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert').textContent).toBe('Tenant has no phone number on file');
  });

  it('a generic relay failure renders the error message inline', async () => {
    getTour.mockResolvedValue(makeTour({ status: 'scheduled', groupThreadId: undefined }));
    createTourRelay.mockRejectedValue(
      new ApiError(409, 'relay_already_provisioned', 'relay_already_provisioned', {
        error: 'relay_already_provisioned',
      }),
    );
    renderDetail();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Open group thread' }),
      ).toBeInTheDocument(),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open group thread' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/relay_already_provisioned/i);
  });
});
