// DeadlinesNudgesCard component tests - the placement hub's Deadlines and nudges
// card. Task 9 lifted the nudge FETCH out of this card into the shared
// usePlacementNudges hook (owned by PlacementDetail, so the Now card and this card
// share ONE fetch); the card is now presentational, driven by nudge PROPS. These
// tests pass the ladder + a Cancel/Restore spy in and assert the rendering +
// callback wiring, accessibility-first. The follow-up Clear still calls the api
// binding directly, so that one remains mocked. mockReset per the vitest footgun.
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PlacementNudgeView } from '../../api/index.js';

const clearPlacementFollowUp = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    clearPlacementFollowUp: (...a: unknown[]) => clearPlacementFollowUp(...a),
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
const onToggleCanceled = vi.fn();
const onSendNow = vi.fn();

function renderCard(
  props: Partial<React.ComponentProps<typeof DeadlinesNudgesCard>> = {},
): void {
  render(
    <DeadlinesNudgesCard
      placementId="p1"
      tenantName="Tasha"
      landlordName="Larry"
      onEditFollowUp={onEditFollowUp}
      nudges={[]}
      nudgesLoading={false}
      nudgesError={null}
      busyId={null}
      onToggleCanceled={onToggleCanceled}
      onSendNow={onSendNow}
      actionError={null}
      {...props}
    />,
  );
}

beforeEach(() => {
  clearPlacementFollowUp.mockReset().mockResolvedValue(undefined);
  onEditFollowUp.mockReset();
  onToggleCanceled.mockReset();
  onSendNow.mockReset();
});

describe('DeadlinesNudgesCard - card + deadlines', () => {
  it('renders a "Deadlines and nudges" Card heading', () => {
    renderCard();
    expect(screen.getByRole('heading', { name: /Deadlines and nudges/i })).toBeInTheDocument();
  });

  it('renders voucher expiration and RTA window read-only via the date vocabulary', () => {
    renderCard({ voucherExpiration: '2999-08-02', rtaWindowAt: '2999-08-05T17:00:00Z' });
    expect(screen.getByText(/expires Aug 2/)).toBeInTheDocument();
    expect(screen.getByText(/closes at Aug 5/)).toBeInTheDocument();
  });

  it('shows a "Set follow-up" control when no follow-up is armed (opens the parent modal)', () => {
    renderCard();
    screen.getByRole('button', { name: /Set follow-up/i }).click();
    expect(onEditFollowUp).toHaveBeenCalledTimes(1);
  });

  it('shows Change + Clear when a follow-up is armed; Clear calls clearPlacementFollowUp', async () => {
    renderCard({ followUpAt: '2999-07-20T15:00:00Z' });
    const clearBtn = screen.getByRole('button', { name: /Clear follow-up/i });
    // Change opens the same parent modal.
    screen.getByRole('button', { name: /Change follow-up/i }).click();
    expect(onEditFollowUp).toHaveBeenCalledTimes(1);
    clearBtn.click();
    await waitFor(() => expect(clearPlacementFollowUp).toHaveBeenCalledWith('p1'));
  });

  it('states the re-arm caveat so a cancel is understood to hold only within the stage', () => {
    renderCard();
    expect(screen.getByText(/A stage move re-arms this stage's nudge\./i)).toBeInTheDocument();
  });
});

describe('DeadlinesNudgesCard - nudges', () => {
  it('renders each nudge with its kind label, recipient, and a "sends ..." chip', () => {
    renderCard({
      nudges: [
        nudge({ nudgeId: 'n-1', kind: 'receipt_check', recipient: 'tenant' }),
        nudge({ nudgeId: 'n-2', kind: 'approval_check', recipient: 'landlord' }),
      ],
    });
    expect(screen.getByText('Receipt check')).toBeInTheDocument();
    expect(screen.getByText('Approval check')).toBeInTheDocument();
    // Recipient names come from the tenantName/landlordName props.
    expect(screen.getByText(/Tasha/)).toBeInTheDocument();
    expect(screen.getByText(/Larry/)).toBeInTheDocument();
    // Far-future dueAt -> the shared sendRelative "sends in Nd" wording.
    expect(screen.getAllByText(/sends in/i).length).toBeGreaterThan(0);
  });

  it('shows a sent nudge with its sent-at time and a canceled nudge as Canceled', () => {
    renderCard({
      nudges: [
        nudge({ nudgeId: 'n-1', kind: 'receipt_check', state: 'sent', sentAt: '2026-06-18T13:02:00Z' }),
        nudge({ nudgeId: 'n-2', kind: 'completion_check', state: 'canceled', canceledAt: '2026-06-19T10:00:00Z' }),
      ],
    });
    expect(screen.getByText(/Sent -/i)).toBeInTheDocument();
    expect(screen.getByText('Canceled')).toBeInTheDocument();
  });

  it('shows "No nudges armed." for an empty ladder', () => {
    renderCard({ nudges: [] });
    expect(screen.getByText(/No nudges armed/i)).toBeInTheDocument();
  });

  it('shows "Loading nudges..." until the first fetch lands', () => {
    renderCard({ nudgesLoading: true });
    expect(screen.getByText(/Loading nudges/i)).toBeInTheDocument();
  });

  it('Cancel on an upcoming nudge routes through onToggleCanceled; Restore reverses it', () => {
    const upcoming = nudge({ nudgeId: 'n-c', kind: 'receipt_check', state: 'upcoming' });
    const { rerender } = render(
      <DeadlinesNudgesCard
        placementId="p1"
        tenantName="Tasha"
        landlordName="Larry"
        onEditFollowUp={onEditFollowUp}
        nudges={[upcoming]}
        nudgesLoading={false}
        nudgesError={null}
        busyId={null}
        onToggleCanceled={onToggleCanceled}
        onSendNow={onSendNow}
        actionError={null}
      />,
    );
    screen.getByRole('button', { name: 'Cancel Receipt check nudge' }).click();
    expect(onToggleCanceled).toHaveBeenCalledWith(upcoming);

    // The shared hook's refetch would flip the row to canceled -> re-render with it.
    const canceled = nudge({ nudgeId: 'n-c', kind: 'receipt_check', state: 'canceled', canceledAt: '2026-07-14T10:00:00Z' });
    rerender(
      <DeadlinesNudgesCard
        placementId="p1"
        tenantName="Tasha"
        landlordName="Larry"
        onEditFollowUp={onEditFollowUp}
        nudges={[canceled]}
        nudgesLoading={false}
        nudgesError={null}
        busyId={null}
        onToggleCanceled={onToggleCanceled}
        onSendNow={onSendNow}
        actionError={null}
      />,
    );
    expect(screen.getByText('Canceled')).toBeInTheDocument();
    screen.getByRole('button', { name: 'Restore Receipt check nudge' }).click();
    expect(onToggleCanceled).toHaveBeenCalledWith(canceled);
  });

  it('a busy single-flight disables the nudge actions (busyId set)', () => {
    renderCard({
      busyId: 'n-1',
      nudges: [
        nudge({ nudgeId: 'n-1', kind: 'receipt_check', state: 'upcoming' }),
        nudge({ nudgeId: 'n-2', kind: 'completion_check', state: 'upcoming' }),
      ],
    });
    const one = screen.getByRole('button', { name: 'Cancel Receipt check nudge' });
    const two = screen.getByRole('button', { name: 'Cancel Completion check nudge' });
    expect((one as HTMLButtonElement).disabled).toBe(true);
    expect((two as HTMLButtonElement).disabled).toBe(true);
  });

  it('a sent nudge offers NO cancel/restore action', () => {
    renderCard({
      nudges: [nudge({ nudgeId: 'n-s', kind: 'receipt_check', state: 'sent', sentAt: '2026-06-18T13:02:00Z' })],
    });
    expect(screen.getByText('Receipt check')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancel|Restore/ })).toBeNull();
  });

  it('a skipped nudge shows "Skipped - <reason>" (never Sent) and NO cancel/restore action', () => {
    renderCard({
      nudges: [
        nudge({
          nudgeId: 'n-sk',
          kind: 'approval_check',
          recipient: 'landlord',
          state: 'skipped',
          skippedAt: '2026-06-18T13:02:00Z',
          skipReason: 'no_landlord',
        }),
      ],
    });
    // The poll retired the rung UNSENT - the chip must say so with the reason,
    // and must NOT read as a delivered text.
    expect(screen.getByText('Skipped - no landlord on the property')).toBeInTheDocument();
    expect(screen.queryByText(/^Sent/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancel|Restore/ })).toBeNull();
  });

  it('a skipped nudge with no reason still shows a bare Skipped chip', () => {
    renderCard({
      nudges: [
        nudge({ nudgeId: 'n-sk2', kind: 'receipt_check', state: 'skipped', skippedAt: '2026-06-18T13:02:00Z' }),
      ],
    });
    expect(screen.getByText('Skipped')).toBeInTheDocument();
  });

  it('surfaces a fetch error via role="alert"', () => {
    renderCard({ nudgesError: 'boom' });
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

// ---- Quiet hours (2026-08-03): the suppression line + operator Send now -----
// The nudge view carries a suppression ESTIMATE for the first time (S3); quiet
// hours DEFERS a rung rather than dropping it, so its wording differs.
// Plain-hyphen, plain-ASCII copy per this card's house contract.

describe('DeadlinesNudgesCard - suppression', () => {
  it('reads a quiet_hours suppression as a WAIT, never as a skip', () => {
    renderCard({
      nudges: [nudge({ nudgeId: 'n-q', suppression: { reason: 'quiet_hours' } })],
    });
    expect(screen.getByText('Will wait - quiet hours')).toBeInTheDocument();
    expect(screen.queryByText(/Will be skipped/)).toBeNull();
  });

  it('reads every other suppression reason as a skip', () => {
    renderCard({
      nudges: [nudge({ nudgeId: 'n-s', suppression: { reason: 'stale_stage' } })],
    });
    expect(screen.getByText('Will be skipped - stage moved on')).toBeInTheDocument();
  });

  it('renders no suppression line when the rung carries none', () => {
    renderCard({ nudges: [nudge({ nudgeId: 'n-0' })] });
    expect(screen.queryByText(/Will (wait|be skipped)/)).toBeNull();
  });
});

describe('DeadlinesNudgesCard - Send now', () => {
  it('offers Send now on an upcoming nudge only, routed through onSendNow', () => {
    const upcoming = nudge({ nudgeId: 'n-u', kind: 'receipt_check', state: 'upcoming' });
    renderCard({
      nudges: [
        upcoming,
        nudge({ nudgeId: 'n-s', kind: 'completion_check', state: 'sent', sentAt: '2026-06-18T13:02:00Z' }),
        nudge({ nudgeId: 'n-c', kind: 'approval_check', state: 'canceled', canceledAt: '2026-06-18T13:02:00Z' }),
        nudge({ nudgeId: 'n-k', kind: 'rta_window_closing', state: 'skipped', skippedAt: '2026-06-18T13:02:00Z' }),
      ],
    });
    // A10: the accessible name names the rung; the visible text stays short.
    expect(screen.getAllByRole('button', { name: /nudge now$/ })).toHaveLength(1);
    screen.getByRole('button', { name: 'Send Receipt check nudge now' }).click();
    expect(onSendNow).toHaveBeenCalledWith(upcoming);
    expect(screen.getByText('Send now')).toBeInTheDocument();
  });

  it('disables Send now while another rung action is in flight', () => {
    renderCard({
      busyId: 'n-1',
      nudges: [nudge({ nudgeId: 'n-1', kind: 'receipt_check', state: 'upcoming' })],
    });
    const btn = screen.getByRole('button', { name: 'Send Receipt check nudge now' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a send-now refusal beside the rung it belongs to, keeping the ladder', () => {
    renderCard({
      nudges: [
        nudge({ nudgeId: 'n-1', kind: 'receipt_check', state: 'upcoming' }),
        nudge({ nudgeId: 'n-2', kind: 'completion_check', state: 'upcoming' }),
      ],
      actionError: { nudgeId: 'n-2', message: 'The placement moved on from this stage.' },
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/moved on from this stage/i);
    // Exactly one row carries it, and the ladder is still fully rendered.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByText('Receipt check')).toBeInTheDocument();
    expect(screen.getByText('Completion check')).toBeInTheDocument();
  });
});
