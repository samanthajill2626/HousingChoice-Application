// RemindersPanel component tests — verify:
//   - the ladder fetches on mount and renders a titled "Reminders" region
//   - each rung shows its human kind label, state chip, and body
//   - the NEXT rung is highlighted (aria-current + "Next" tag)
//   - a suppression renders the "Will be skipped — <reason>" note
//   - an empty ladder → "No reminders armed."
//   - a scheduled.updated / same-tour tour.updated SSE event refetches the ladder
//
// Pattern mirrors TourDetail.test.tsx: mock the api barrel, import after mocking,
// assert accessibility-first. The SSE capture mirrors useTourActivity.test.tsx.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { EventStreamHandlers, TourReminderView, TourRemindersPage } from '../../api/index.js';

const getTourReminders = vi.fn();
let streamHandlers: EventStreamHandlers | null = null;
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getTourReminders: (...a: unknown[]) => getTourReminders(...a),
    useEventStream: (h: EventStreamHandlers) => {
      streamHandlers = h;
    },
  };
});

import { RemindersPanel } from './RemindersPanel.js';

function rung(over: Partial<TourReminderView> = {}): TourReminderView {
  return {
    reminderId: 'r-1',
    kind: 'day_before',
    dueAt: '2999-01-01T12:00:00Z',
    state: 'upcoming',
    body: 'Your tour is tomorrow at 2pm.',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  streamHandlers = null;
});

describe('RemindersPanel', () => {
  it('renders a "Reminders" Card heading', async () => {
    getTourReminders.mockResolvedValue({ reminders: [] } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    // Restyled INTO a <Card title="Reminders"> (an h3), not a named region.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Reminders/i })).toBeInTheDocument(),
    );
    expect(getTourReminders).toHaveBeenCalledWith('tour-1', expect.anything());
  });

  it('shows "No reminders armed." for an empty ladder', async () => {
    getTourReminders.mockResolvedValue({ reminders: [] } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText(/No reminders armed/i)).toBeInTheDocument());
  });

  it('renders each rung with its human kind label and body', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({ reminderId: 'r-1', kind: 'confirmation', body: 'Reply YES to confirm.' }),
        rung({ reminderId: 'r-2', kind: 'no_show_checkin', body: 'Everything OK?' }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('Confirmation')).toBeInTheDocument());
    expect(screen.getByText('No-show check-in')).toBeInTheDocument();
    expect(screen.getByText('Reply YES to confirm.')).toBeInTheDocument();
    expect(screen.getByText('Everything OK?')).toBeInTheDocument();
  });

  it('shows a sent rung with its sent-at time and an upcoming rung as amber', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({ reminderId: 'r-1', kind: 'confirmation', state: 'sent', sentAt: '2026-06-18T13:02:00Z' }),
        rung({ reminderId: 'r-2', kind: 'day_before', state: 'upcoming' }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('Confirmation')).toBeInTheDocument());
    expect(screen.getByText(/Sent -/i)).toBeInTheDocument();
  });

  it('an upcoming rung reads "sends in" (a reminder is sent, not "due")', async () => {
    getTourReminders.mockResolvedValue({
      // Far-future dueAt → sendRelative yields "sends in Nd".
      reminders: [rung({ reminderId: 'r-1', kind: 'day_before', state: 'upcoming' })],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText(/sends in/i)).toBeInTheDocument());
    // Reminders never use the deadline wording.
    expect(screen.queryByText(/due in/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/overdue/i)).not.toBeInTheDocument();
  });

  it('an upcoming rung whose fire time has passed reads "sending shortly"', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [rung({ reminderId: 'r-1', kind: 'morning_of', state: 'upcoming', dueAt: '2000-01-01T00:00:00Z' })],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText(/sending shortly/i)).toBeInTheDocument());
  });

  it('highlights the NEXT rung with aria-current and a "Next" tag', async () => {
    const next = rung({ reminderId: 'r-2', kind: 'morning_of' });
    getTourReminders.mockResolvedValue({
      reminders: [rung({ reminderId: 'r-1', kind: 'confirmation', state: 'sent', sentAt: '2026-06-18T13:02:00Z' }), next],
      next,
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('Morning of')).toBeInTheDocument());
    const nextRow = screen.getByText('Morning of').closest('li');
    expect(nextRow).not.toBeNull();
    expect(nextRow).toHaveAttribute('aria-current', 'step');
    expect(within(nextRow as HTMLElement).getByText('Next')).toBeInTheDocument();
  });

  it('renders a "Will be skipped — <reason>" note when a rung is suppressed', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [rung({ reminderId: 'r-1', suppression: { reason: 'contact_opted_out' } })],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() =>
      expect(screen.getByText(/Will be skipped — contact opted out/i)).toBeInTheDocument(),
    );
  });

  it('surfaces a fetch error via role="alert"', async () => {
    getTourReminders.mockRejectedValue(new ApiError(500, 'boom', 'boom'));
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });

  it('refetches on a scheduled.updated event (arm/reschedule/cancel goes live)', async () => {
    // Book-a-tour repro: mounts with no reminders, the ladder arms server-side,
    // scheduled.updated fires -> the panel refetches and shows the fresh rung.
    getTourReminders.mockResolvedValueOnce({ reminders: [] } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText(/No reminders armed/i)).toBeInTheDocument());
    expect(getTourReminders).toHaveBeenCalledTimes(1);

    getTourReminders.mockResolvedValueOnce({
      reminders: [rung({ reminderId: 'r-1', kind: 'day_before' })],
    } satisfies TourRemindersPage);
    // The payload carries no tourId (advisory contactId only) -> refetch on any.
    act(() => streamHandlers?.onScheduledUpdated?.({}));
    await waitFor(() => expect(getTourReminders).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('Day before')).toBeInTheDocument());
  });

  it('refetches on a tour.updated for THIS tour, ignores other tours', async () => {
    // Mark-toured repro: the pending rung must flip to Canceled without a reload.
    getTourReminders.mockResolvedValueOnce({
      reminders: [rung({ reminderId: 'r-1', kind: 'day_before', state: 'upcoming' })],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('Day before')).toBeInTheDocument());
    expect(getTourReminders).toHaveBeenCalledTimes(1);

    act(() => streamHandlers?.onTourUpdated?.({ tourId: 'other-tour', status: 'toured' }));
    expect(getTourReminders).toHaveBeenCalledTimes(1);

    getTourReminders.mockResolvedValueOnce({
      reminders: [rung({ reminderId: 'r-1', kind: 'day_before', state: 'canceled' })],
    } satisfies TourRemindersPage);
    act(() => streamHandlers?.onTourUpdated?.({ tourId: 'tour-1', status: 'toured' }));
    await waitFor(() => expect(getTourReminders).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('Canceled')).toBeInTheDocument());
  });
});
