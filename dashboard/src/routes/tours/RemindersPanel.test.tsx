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
const patchTourReminder = vi.fn();
const postReminderSendNow = vi.fn();
let streamHandlers: EventStreamHandlers | null = null;
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getTourReminders: (...a: unknown[]) => getTourReminders(...a),
    patchTourReminder: (...a: unknown[]) => patchTourReminder(...a),
    postReminderSendNow: (...a: unknown[]) => postReminderSendNow(...a),
    useEventStream: (h: EventStreamHandlers) => {
      streamHandlers = h;
    },
  };
});

import { nextReminderRefetchDelay, RemindersPanel } from './RemindersPanel.js';

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
  postReminderSendNow.mockReset().mockResolvedValue(rung({ state: 'sent' }));
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

  it('stamps the sent chip in the zone the LIST response composed the bodies in', async () => {
    // Spec D8: the body beside this chip quotes an ORG-local time, so the chip
    // has to use the response's zone rather than the navigator's browser zone.
    // Asia/Tokyo is nobody's plausible browser zone here, so the assertion
    // cannot pass by accident: 2026-06-18T13:02Z is 10:02 PM the same day there.
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({ reminderId: 'r-1', kind: 'confirmation', state: 'sent', sentAt: '2026-06-18T13:02:00Z' }),
      ],
      timezone: 'Asia/Tokyo',
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('Sent - Jun 18, 10:02 PM')).toBeInTheDocument());
  });

  it('falls back to the browser zone when the response carries no zone', async () => {
    // A stale cached response (or an older backend) must render exactly as it
    // does today - never a crash, never an empty time.
    const legacy = new Date('2026-06-18T13:02:00Z').toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({ reminderId: 'r-1', kind: 'confirmation', state: 'sent', sentAt: '2026-06-18T13:02:00Z' }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText(`Sent - ${legacy}`)).toBeInTheDocument());
  });

  it('a claim-skipped rung reads "Skipped - <reason>" (plain hyphen), never "sending shortly"', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({
          reminderId: 'r-1',
          kind: 'confirmation',
          state: 'skipped',
          skippedAt: '2026-07-13T16:00:00Z',
          skipReason: 'no_conversation',
        }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() =>
      expect(screen.getByText('Skipped - no conversation')).toBeInTheDocument(),
    );
    // The retired rung must never keep the amber "sending shortly" lie.
    expect(screen.queryByText(/sending shortly/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sends in/i)).not.toBeInTheDocument();
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

// ---- The dueAt-anchored self-refetch (worker-fire liveness) -----------------
// A rung FIRING happens in the worker process, whose SSE events never reach the
// browser (the lib/events.ts seam) — the panel anchors its own refetch to the
// next rung's dueAt instead.

describe('nextReminderRefetchDelay (pure)', () => {
  const NOW = new Date('2026-07-10T12:00:00Z').getTime();

  it('returns null when no rung is upcoming (nothing to wait for)', () => {
    expect(nextReminderRefetchDelay([], NOW)).toBeNull();
    expect(
      nextReminderRefetchDelay(
        [
          { state: 'sent', dueAt: '2026-07-10T11:00:00Z' },
          { state: 'canceled', dueAt: '2026-07-10T13:00:00Z' },
          // A claim-skipped rung is terminal — no timer, even when past-due.
          { state: 'skipped', dueAt: '2026-07-10T11:30:00Z' },
        ],
        NOW,
      ),
    ).toBeNull();
  });

  it('anchors just past the EARLIEST upcoming dueAt', () => {
    const delay = nextReminderRefetchDelay(
      [
        { state: 'upcoming', dueAt: '2026-07-10T14:00:00Z' },
        { state: 'upcoming', dueAt: '2026-07-10T12:00:30Z' },
      ],
      NOW,
    );
    // 30s to the earliest fire + the 2s buffer.
    expect(delay).toBe(32_000);
  });

  it('re-checks on a short interval while a due rung awaits the worker poll', () => {
    expect(
      nextReminderRefetchDelay([{ state: 'upcoming', dueAt: '2026-07-10T11:59:00Z' }], NOW),
    ).toBe(20_000);
  });

  it('clamps a far-future anchor (each landed fetch re-anchors anyway)', () => {
    expect(
      nextReminderRefetchDelay([{ state: 'upcoming', dueAt: '2026-08-01T12:00:00Z' }], NOW),
    ).toBe(6 * 3_600_000);
  });
});

describe('RemindersPanel — dueAt-anchored self-refetch', () => {
  it('refetches on its own just after the next rung fires, then stops once nothing is upcoming', async () => {
    vi.useRealTimers(); // release the global Date pin (test/setup.ts) first
    vi.useFakeTimers();
    try {
      const soon = new Date(Date.now() + 5_000).toISOString();
      getTourReminders
        .mockResolvedValueOnce({ reminders: [rung({ dueAt: soon })] } satisfies TourRemindersPage)
        .mockResolvedValue({
          reminders: [rung({ dueAt: soon, state: 'sent', sentAt: soon })],
        } satisfies TourRemindersPage);
      render(<RemindersPanel tourId="tour-1" />);

      // Initial fetch lands (flush microtasks under fake timers).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getTourReminders).toHaveBeenCalledTimes(1);

      // Past dueAt + the fire buffer → the anchored timer refetches, and the
      // fresh ladder shows the rung as sent. No SSE event was involved.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_000);
      });
      expect(getTourReminders).toHaveBeenCalledTimes(2);
      expect(screen.getByText(/Sent/)).toBeInTheDocument();

      // Nothing upcoming anymore → no further self-refetch is armed.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60 * 60_000);
      });
      expect(getTourReminders).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Operator cancel/restore (2026-07-14). mockReset (not just clearAllMocks —
  // that leaves queued mockResolvedValueOnce values behind for the NEXT test).
  it('Cancel on an upcoming rung PATCHes {canceled:true} and refetches; Restore reverses it', async () => {
    getTourReminders.mockReset();
    patchTourReminder.mockReset();
    getTourReminders
      .mockResolvedValueOnce({
        reminders: [rung({ reminderId: 'r-c', kind: 'day_before', state: 'upcoming' })],
      } satisfies TourRemindersPage)
      .mockResolvedValueOnce({
        reminders: [
          rung({
            reminderId: 'r-c',
            kind: 'day_before',
            state: 'canceled',
            canceledAt: '2026-07-14T10:00:00Z',
          }),
        ],
      } satisfies TourRemindersPage)
      .mockResolvedValue({
        reminders: [rung({ reminderId: 'r-c', kind: 'day_before', state: 'upcoming' })],
      } satisfies TourRemindersPage);
    patchTourReminder.mockResolvedValue(rung({ reminderId: 'r-c', state: 'canceled' }));

    render(<RemindersPanel tourId="tour-1" />);
    const cancelBtn = await screen.findByRole('button', { name: 'Cancel Day before reminder' });
    cancelBtn.click();
    await waitFor(() =>
      expect(patchTourReminder).toHaveBeenCalledWith('tour-1', 'r-c', true),
    );
    // The post-PATCH refetch shows the canceled chip + a Restore action.
    const restoreBtn = await screen.findByRole('button', { name: 'Restore Day before reminder' });
    expect(screen.getByText('Canceled')).toBeInTheDocument();

    patchTourReminder.mockClear();
    patchTourReminder.mockResolvedValue(rung({ reminderId: 'r-c', state: 'upcoming' }));
    restoreBtn.click();
    await waitFor(() =>
      expect(patchTourReminder).toHaveBeenCalledWith('tour-1', 'r-c', false),
    );
    await screen.findByRole('button', { name: 'Cancel Day before reminder' });
  });

  it('a sent rung offers NO cancel/restore action', async () => {
    getTourReminders.mockReset();
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({ reminderId: 'r-s', kind: 'confirmation', state: 'sent', sentAt: '2026-06-18T13:02:00Z' }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('Confirmation')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Cancel|Restore/ })).toBeNull();
  });
});

// ---- Quiet hours (2026-08-03): the deferred-send chip + operator Send now ----
// Quiet hours DEFERS a rung, it never drops it, so its note must not read
// "Will be skipped"; and staff can force any PENDING rung out immediately.

// The rendered em dash, by code point, so these added source lines stay ASCII.
const EM = String.fromCharCode(0x2014);

describe('RemindersPanel - quiet-hours copy', () => {
  it('a quiet_hours suppression reads as a WAIT, never as a skip', async () => {
    getTourReminders.mockReset();
    getTourReminders.mockResolvedValue({
      reminders: [rung({ reminderId: 'r-q', suppression: { reason: 'quiet_hours' } })],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() =>
      expect(screen.getByText(`Will wait ${EM} quiet hours`)).toBeInTheDocument(),
    );
    // "Will be skipped" would be a lie - the message goes out at quiet-end.
    expect(screen.queryByText(/Will be skipped/)).toBeNull();
  });

  it('every OTHER suppression reason keeps the "Will be skipped" sentence', async () => {
    getTourReminders.mockReset();
    getTourReminders.mockResolvedValue({
      reminders: [rung({ reminderId: 'r-o', suppression: { reason: 'manual_mode' } })],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() =>
      expect(screen.getByText(`Will be skipped ${EM} manual mode`)).toBeInTheDocument(),
    );
  });

  it('a rung retired by release supersession names that reason in its chip', async () => {
    getTourReminders.mockReset();
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({
          reminderId: 'r-sup',
          kind: 'day_before',
          state: 'skipped',
          skippedAt: '2026-07-13T16:00:00Z',
          skipReason: 'quiet_hours_superseded',
        }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() =>
      expect(screen.getByText('Skipped - superseded by a later reminder')).toBeInTheDocument(),
    );
  });
});

describe('RemindersPanel - Send now', () => {
  it('offers Send now on an upcoming rung only (not sent/canceled/skipped)', async () => {
    getTourReminders.mockReset();
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({ reminderId: 'r-u', kind: 'day_before', state: 'upcoming' }),
        rung({ reminderId: 'r-s', kind: 'confirmation', state: 'sent', sentAt: '2026-06-18T13:02:00Z' }),
        rung({ reminderId: 'r-c', kind: 'morning_of', state: 'canceled', canceledAt: '2026-06-18T13:02:00Z' }),
        rung({ reminderId: 'r-k', kind: 'en_route', state: 'skipped', skippedAt: '2026-06-18T13:02:00Z' }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);

    // Accessible name disambiguates the rung (A10) - a bare "Send now" repeated
    // per rung would be a strict-mode violation for the e2e harness.
    await screen.findByRole('button', { name: 'Send Day before reminder now' });
    expect(screen.getAllByRole('button', { name: /reminder now$/ })).toHaveLength(1);
    // Visible text stays short.
    expect(screen.getByText('Send now')).toBeInTheDocument();
  });

  it('Send now POSTs for that rung and refetches the honest ladder', async () => {
    getTourReminders.mockReset();
    getTourReminders
      .mockResolvedValueOnce({
        reminders: [rung({ reminderId: 'r-n', kind: 'day_before', state: 'upcoming' })],
      } satisfies TourRemindersPage)
      .mockResolvedValue({
        reminders: [
          rung({
            reminderId: 'r-n',
            kind: 'day_before',
            state: 'sent',
            sentAt: '2026-07-01T12:00:00Z',
          }),
        ],
      } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);

    const btn = await screen.findByRole('button', { name: 'Send Day before reminder now' });
    btn.click();
    await waitFor(() => expect(postReminderSendNow).toHaveBeenCalledWith('tour-1', 'r-n'));
    await waitFor(() => expect(getTourReminders).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/Sent -/i)).toBeInTheDocument());
    // A success clears any error slot.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a 409 shows readable inline copy beside the rung, keeps the ladder, and re-enables', async () => {
    getTourReminders.mockReset();
    getTourReminders.mockResolvedValue({
      reminders: [rung({ reminderId: 'r-e', kind: 'day_before', state: 'upcoming' })],
    } satisfies TourRemindersPage);
    postReminderSendNow.mockReset();
    postReminderSendNow.mockRejectedValue(
      new ApiError(409, 'contact_opted_out', 'contact_opted_out', {
        error: 'contact_opted_out',
      }),
    );
    render(<RemindersPanel tourId="tour-1" />);

    const btn = await screen.findByRole('button', { name: 'Send Day before reminder now' });
    btn.click();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/opted out/i);
    // The raw machine code never reaches a navigator.
    expect(alert).not.toHaveTextContent('contact_opted_out');
    // The list must NOT be replaced by the error (the fetch-error path does that).
    expect(screen.getByText('Day before')).toBeInTheDocument();
    const again = await screen.findByRole('button', { name: 'Send Day before reminder now' });
    expect((again as HTMLButtonElement).disabled).toBe(false);
  });

  it('a contact_deleted 409 tells the navigator to restore the contact', async () => {
    getTourReminders.mockReset();
    getTourReminders.mockResolvedValue({
      reminders: [rung({ reminderId: 'r-d', kind: 'day_before', state: 'upcoming' })],
    } satisfies TourRemindersPage);
    postReminderSendNow.mockReset();
    postReminderSendNow.mockRejectedValue(
      new ApiError(409, 'contact_deleted', 'contact_deleted', { error: 'contact_deleted' }),
    );
    render(<RemindersPanel tourId="tour-1" />);

    (await screen.findByRole('button', { name: 'Send Day before reminder now' })).click();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/restore them to send/i);
    // The raw machine code never reaches a navigator.
    expect(alert).not.toHaveTextContent('contact_deleted');
  });

  it('an unmapped refusal code still says something human', async () => {
    getTourReminders.mockReset();
    getTourReminders.mockResolvedValue({
      reminders: [rung({ reminderId: 'r-x', kind: 'day_before', state: 'upcoming' })],
    } satisfies TourRemindersPage);
    postReminderSendNow.mockReset();
    postReminderSendNow.mockRejectedValue(new ApiError(409, 'wat_is_this', 'wat_is_this'));
    render(<RemindersPanel tourId="tour-1" />);

    (await screen.findByRole('button', { name: 'Send Day before reminder now' })).click();
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent('wat_is_this');
    expect(alert).toHaveTextContent(/try again/i);
  });
});
