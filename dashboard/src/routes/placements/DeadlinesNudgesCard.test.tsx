// DeadlinesNudgesCard component tests - the placement hub's Deadlines and nudges
// card. Mirrors tours/RemindersPanel.test.tsx (nudges are the placement analogue
// of tour reminders): the nudge ladder fetches on mount and renders each rung
// with a kind label, recipient, a "sends ..." chip, and a Cancel/Restore action;
// a Cancel PATCHes {canceled:true} then refetches the honest state, Restore
// reverses it; a busy single-flight disables the actions; a scheduled.updated SSE
// refetches. The read-only deadlines (voucher / RTA window) render via the date
// vocabulary; the follow-up row's Set/Change opens the parent modal and Clear
// calls the clear binding. The re-arm caveat copy is asserted verbatim.
//
// Pattern mirrors RemindersPanel.test.tsx: mock the api barrel, import after
// mocking, assert accessibility-first. vitest footgun: mockReset (not just
// clearAllMocks) when reusing a mock's mockResolvedValueOnce queue across tests.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { EventStreamHandlers, PlacementNudgeView } from '../../api/index.js';

const getPlacementNudges = vi.fn();
const patchPlacementNudge = vi.fn();
const clearPlacementFollowUp = vi.fn();
let streamHandlers: EventStreamHandlers | null = null;
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getPlacementNudges: (...a: unknown[]) => getPlacementNudges(...a),
    patchPlacementNudge: (...a: unknown[]) => patchPlacementNudge(...a),
    clearPlacementFollowUp: (...a: unknown[]) => clearPlacementFollowUp(...a),
    useEventStream: (h: EventStreamHandlers) => {
      streamHandlers = h;
    },
  };
});

import { DeadlinesNudgesCard } from './DeadlinesNudgesCard.js';

function nudge(over: Partial<PlacementNudgeView> = {}): PlacementNudgeView {
  return {
    nudgeId: 'n-1',
    placementId: 'p1',
    kind: 'receipt_check',
    recipient: 'tenant',
    dueAt: '2999-01-01T12:00:00Z',
    state: 'upcoming',
    ...over,
  };
}

const onEditFollowUp = vi.fn();

function renderCard(
  props: Partial<React.ComponentProps<typeof DeadlinesNudgesCard>> = {},
): void {
  render(
    <DeadlinesNudgesCard
      placementId="p1"
      tenantName="Tasha"
      landlordName="Larry"
      onEditFollowUp={onEditFollowUp}
      {...props}
    />,
  );
}

beforeEach(() => {
  getPlacementNudges.mockReset().mockResolvedValue([]);
  patchPlacementNudge.mockReset();
  clearPlacementFollowUp.mockReset().mockResolvedValue(undefined);
  onEditFollowUp.mockReset();
  streamHandlers = null;
});

describe('DeadlinesNudgesCard - card + deadlines', () => {
  it('renders a "Deadlines and nudges" Card heading', async () => {
    renderCard();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Deadlines and nudges/i })).toBeInTheDocument(),
    );
    expect(getPlacementNudges).toHaveBeenCalledWith('p1', expect.anything());
  });

  it('renders voucher expiration and RTA window read-only via the date vocabulary', async () => {
    renderCard({ voucherExpiration: '2999-08-02', rtaWindowAt: '2999-08-05T17:00:00Z' });
    await waitFor(() => expect(screen.getByText(/expires Aug 2/)).toBeInTheDocument());
    expect(screen.getByText(/closes at Aug 5/)).toBeInTheDocument();
  });

  it('shows a "Set follow-up" control when no follow-up is armed (opens the parent modal)', async () => {
    renderCard();
    const btn = await screen.findByRole('button', { name: /Set follow-up/i });
    btn.click();
    expect(onEditFollowUp).toHaveBeenCalledTimes(1);
  });

  it('shows Change + Clear when a follow-up is armed; Clear calls clearPlacementFollowUp', async () => {
    renderCard({ followUpAt: '2999-07-20T15:00:00Z' });
    const clearBtn = await screen.findByRole('button', { name: /Clear follow-up/i });
    // Change opens the same parent modal.
    screen.getByRole('button', { name: /Change follow-up/i }).click();
    expect(onEditFollowUp).toHaveBeenCalledTimes(1);
    clearBtn.click();
    await waitFor(() => expect(clearPlacementFollowUp).toHaveBeenCalledWith('p1'));
  });

  it('states the re-arm caveat so a cancel is understood to hold only within the stage', async () => {
    renderCard();
    await waitFor(() =>
      expect(
        screen.getByText(/A stage move re-arms this stage's nudge\./i),
      ).toBeInTheDocument(),
    );
  });
});

describe('DeadlinesNudgesCard - nudges', () => {
  it('renders each nudge with its kind label, recipient, and a "sends ..." chip', async () => {
    getPlacementNudges.mockResolvedValue([
      nudge({ nudgeId: 'n-1', kind: 'receipt_check', recipient: 'tenant' }),
      nudge({ nudgeId: 'n-2', kind: 'approval_check', recipient: 'landlord' }),
    ]);
    renderCard();
    await waitFor(() => expect(screen.getByText('Receipt check')).toBeInTheDocument());
    expect(screen.getByText('Approval check')).toBeInTheDocument();
    // Recipient names come from the tenantName/landlordName props.
    expect(screen.getByText(/Tasha/)).toBeInTheDocument();
    expect(screen.getByText(/Larry/)).toBeInTheDocument();
    // Far-future dueAt -> the shared sendRelative "sends in Nd" wording.
    expect(screen.getAllByText(/sends in/i).length).toBeGreaterThan(0);
  });

  it('shows a sent nudge with its sent-at time and a canceled nudge as Canceled', async () => {
    getPlacementNudges.mockResolvedValue([
      nudge({ nudgeId: 'n-1', kind: 'receipt_check', state: 'sent', sentAt: '2026-06-18T13:02:00Z' }),
      nudge({ nudgeId: 'n-2', kind: 'completion_check', state: 'canceled', canceledAt: '2026-06-19T10:00:00Z' }),
    ]);
    renderCard();
    await waitFor(() => expect(screen.getByText(/Sent -/i)).toBeInTheDocument());
    expect(screen.getByText('Canceled')).toBeInTheDocument();
  });

  it('shows "No nudges armed." for an empty ladder', async () => {
    getPlacementNudges.mockResolvedValue([]);
    renderCard();
    await waitFor(() => expect(screen.getByText(/No nudges armed/i)).toBeInTheDocument());
  });

  it('Cancel on an upcoming nudge PATCHes {canceled:true} and refetches; Restore reverses it', async () => {
    getPlacementNudges.mockReset();
    patchPlacementNudge.mockReset();
    getPlacementNudges
      .mockResolvedValueOnce([nudge({ nudgeId: 'n-c', kind: 'receipt_check', state: 'upcoming' })])
      .mockResolvedValueOnce([
        nudge({ nudgeId: 'n-c', kind: 'receipt_check', state: 'canceled', canceledAt: '2026-07-14T10:00:00Z' }),
      ])
      .mockResolvedValue([nudge({ nudgeId: 'n-c', kind: 'receipt_check', state: 'upcoming' })]);
    patchPlacementNudge.mockResolvedValue(nudge({ nudgeId: 'n-c', state: 'canceled' }));

    renderCard();
    const cancelBtn = await screen.findByRole('button', { name: 'Cancel Receipt check nudge' });
    cancelBtn.click();
    await waitFor(() => expect(patchPlacementNudge).toHaveBeenCalledWith('p1', 'n-c', true));
    // The post-PATCH refetch shows the canceled chip + a Restore action.
    const restoreBtn = await screen.findByRole('button', { name: 'Restore Receipt check nudge' });
    expect(screen.getByText('Canceled')).toBeInTheDocument();

    patchPlacementNudge.mockClear();
    patchPlacementNudge.mockResolvedValue(nudge({ nudgeId: 'n-c', state: 'upcoming' }));
    restoreBtn.click();
    await waitFor(() => expect(patchPlacementNudge).toHaveBeenCalledWith('p1', 'n-c', false));
    await screen.findByRole('button', { name: 'Cancel Receipt check nudge' });
  });

  it('a busy single-flight disables the nudge actions until the PATCH settles', async () => {
    getPlacementNudges.mockReset();
    patchPlacementNudge.mockReset();
    getPlacementNudges.mockResolvedValue([
      nudge({ nudgeId: 'n-1', kind: 'receipt_check', state: 'upcoming' }),
      nudge({ nudgeId: 'n-2', kind: 'completion_check', state: 'upcoming' }),
    ]);
    // A PATCH that never settles -> the busy state persists so we can observe it.
    let release: () => void = () => {};
    patchPlacementNudge.mockReturnValue(
      new Promise<PlacementNudgeView>((resolve) => {
        release = () => resolve(nudge({ nudgeId: 'n-1', state: 'canceled' }));
      }),
    );
    renderCard();
    const one = await screen.findByRole('button', { name: 'Cancel Receipt check nudge' });
    const two = screen.getByRole('button', { name: 'Cancel Completion check nudge' });
    one.click();
    await waitFor(() => expect((one as HTMLButtonElement).disabled).toBe(true));
    expect((two as HTMLButtonElement).disabled).toBe(true);
    release();
  });

  it('a sent nudge offers NO cancel/restore action', async () => {
    getPlacementNudges.mockResolvedValue([
      nudge({ nudgeId: 'n-s', kind: 'receipt_check', state: 'sent', sentAt: '2026-06-18T13:02:00Z' }),
    ]);
    renderCard();
    await waitFor(() => expect(screen.getByText('Receipt check')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Cancel|Restore/ })).toBeNull();
  });

  it('refetches on a scheduled.updated event (arm/cancel goes live)', async () => {
    getPlacementNudges.mockReset();
    getPlacementNudges.mockResolvedValueOnce([]);
    renderCard();
    await waitFor(() => expect(screen.getByText(/No nudges armed/i)).toBeInTheDocument());
    expect(getPlacementNudges).toHaveBeenCalledTimes(1);

    getPlacementNudges.mockResolvedValueOnce([nudge({ nudgeId: 'n-1', kind: 'receipt_check' })]);
    // The payload carries no placementId (advisory contactId only) -> refetch on any.
    act(() => streamHandlers?.onScheduledUpdated?.({}));
    await waitFor(() => expect(getPlacementNudges).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('Receipt check')).toBeInTheDocument());
  });

  it('surfaces a fetch error via role="alert"', async () => {
    getPlacementNudges.mockReset();
    getPlacementNudges.mockRejectedValue(new ApiError(500, 'boom', 'boom'));
    renderCard();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});
