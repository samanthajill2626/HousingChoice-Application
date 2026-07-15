// PlacementNowCard component tests - the placement hub's Now card (spec 3.1),
// the single "what is happening with this placement right now" surface. Verifies
// the 5-part anatomy across the three shapes the spec calls out:
//   - a WAITING stage (someone else holds the ball): an amber "Waiting on: ..."
//     gate line with the relevant date under the vocabulary ("scheduled for ..."
//     when present, "no date recorded" when the expected date is missing);
//   - an OUR-MOVE stage (we hold the ball): a blue "Our move: ..." gate line with
//     the {tenant}/{landlord} tokens interpolated to names;
//   - a RECORDING stage: the absorbed StageData/Paperwork recorders (moved here
//     from PlacementDetail), including LIF gating on tenant.lifEligible;
//   - "Record: nothing at this stage" when the stage records nothing;
//   - the safety-net line (armed nudge / RTA window) only when the system chases;
//   - the Advance button (same action as the header CTA), ABSENT at the terminal
//     stages, which instead render a completed / lost summary.
//
// Accessibility-first selectors (getByRole/getByLabel); mockReset per the vitest
// footgun. The recorder callbacks are plain spies (the fetch/PATCH wiring lives
// in PlacementDetail), so no api mocking is needed here.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, PlacementItem, PlacementNudgeView, UnitItem } from '../../api/index.js';
import { PlacementNowCard } from './PlacementNowCard.js';

const UNIT: UnitItem = {
  unitId: 'u1',
  landlordId: 'l1',
  status: 'under_application',
  address: { line1: '12 Oak St' },
  final_rent: 1550,
};
const TENANT: Contact = { contactId: 't1', type: 'tenant', firstName: 'Tasha', lastName: 'Nguyen' };
const LANDLORD: Contact = { contactId: 'l1', type: 'landlord', firstName: 'Larry', lastName: 'Owens' };

function placement(over: Partial<PlacementItem> = {}): PlacementItem {
  return {
    placementId: 'p1',
    tenantId: 't1',
    unitId: 'u1',
    stage: 'awaiting_inspection',
    stage_entered_at: '2026-06-18T13:02:00Z',
    ...over,
  };
}

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

const onAdvance = vi.fn();
const onRecordPlacement = vi.fn();
const onRecordFinalRent = vi.fn();
const onTogglePaperwork = vi.fn();

function renderCard(props: Partial<React.ComponentProps<typeof PlacementNowCard>> = {}): void {
  render(
    <PlacementNowCard
      placement={placement()}
      unit={UNIT}
      tenant={TENANT}
      landlord={LANDLORD}
      nudges={[]}
      nextStageLabel="Determine rent"
      onAdvance={onAdvance}
      onRecordPlacement={onRecordPlacement}
      onRecordFinalRent={onRecordFinalRent}
      onTogglePaperwork={onTogglePaperwork}
      {...props}
    />,
  );
}

beforeEach(() => {
  onAdvance.mockReset();
  onRecordPlacement.mockReset().mockResolvedValue(undefined);
  onRecordFinalRent.mockReset().mockResolvedValue(undefined);
  onTogglePaperwork.mockReset();
});

/** The Now card's gate-line element (carries the amber/them, blue/us tone hook). */
function gateLine(): HTMLElement {
  return screen.getByTestId('now-gate');
}

describe('PlacementNowCard - stage + phase (always present)', () => {
  it('renders the stage label and its phase', () => {
    renderCard();
    expect(screen.getByText('Awaiting inspection')).toBeInTheDocument();
    expect(screen.getByText(/Inspection phase/)).toBeInTheDocument();
  });
});

describe('PlacementNowCard - waiting stage (them)', () => {
  it('shows an amber "Waiting on: ..." gate line and "no date recorded" when the expected date is missing', () => {
    renderCard(); // awaiting_inspection, no inspection_date
    const gate = gateLine();
    expect(gate).toHaveAttribute('data-tone', 'them');
    expect(within(gate).getByText(/Waiting on: the housing authority inspection/)).toBeInTheDocument();
    expect(within(gate).getByText(/no date recorded/)).toBeInTheDocument();
  });

  it('shows the inspection date under the vocabulary ("scheduled for ...") when present', () => {
    renderCard({ placement: placement({ inspection_date: '2999-07-20' }) });
    const gate = gateLine();
    expect(within(gate).getByText(/scheduled for/)).toBeInTheDocument();
    expect(within(gate).queryByText(/no date recorded/)).not.toBeInTheDocument();
  });

  it('renders the inspection-outcome recorder (Record: inspection review) and an Advance button', () => {
    renderCard();
    expect(screen.getByRole('button', { name: /Record inspection outcome/ })).toBeInTheDocument();
    // Advance mirrors the header CTA; clicking it calls onAdvance.
    const advance = screen.getByRole('button', { name: 'Advance to Determine rent' });
    fireEvent.click(advance);
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });
});

describe('PlacementNowCard - our-move stage (us)', () => {
  it('shows a blue "Our move: ..." gate line with {tenant} interpolated, and no date sub-line', () => {
    renderCard({
      placement: placement({ stage: 'send_application' }),
      nextStageLabel: 'Awaiting receipt',
    });
    const gate = gateLine();
    expect(gate).toHaveAttribute('data-tone', 'us');
    expect(within(gate).getByText(/Our move: Send the application packet to Tasha Nguyen/)).toBeInTheDocument();
    expect(within(gate).queryByText(/no date recorded/)).not.toBeInTheDocument();
  });

  it('reads "Record: nothing at this stage" when the stage records nothing', () => {
    renderCard({ placement: placement({ stage: 'send_application' }), nextStageLabel: 'Awaiting receipt' });
    expect(screen.getByText(/Record: nothing at this stage/)).toBeInTheDocument();
  });
});

describe('PlacementNowCard - recording stage (complete_paperwork)', () => {
  it('renders the closing checklist with LIF when the tenant is LIF-eligible', () => {
    renderCard({
      placement: placement({ stage: 'complete_paperwork' }),
      tenant: { ...TENANT, lifEligible: true },
      nextStageLabel: 'Awaiting move-in',
    });
    expect(screen.getByRole('checkbox', { name: 'Lease signed' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Move-in details shared' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /LIF/ })).toBeInTheDocument();
    // A toggle routes through the parent's onTogglePaperwork callback.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lease signed' }));
    expect(onTogglePaperwork).toHaveBeenCalledWith('lease_signed', true);
  });

  it('omits the LIF checkbox when the tenant is not LIF-eligible', () => {
    renderCard({
      placement: placement({ stage: 'complete_paperwork' }),
      tenant: TENANT,
      nextStageLabel: 'Awaiting move-in',
    });
    expect(screen.getByRole('checkbox', { name: 'Lease signed' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /LIF/ })).not.toBeInTheDocument();
  });
});

describe('PlacementNowCard - safety-net line', () => {
  it('shows the armed nudge fire time when a nudge is upcoming', () => {
    renderCard({ nudges: [nudge({ state: 'upcoming', dueAt: '2999-01-01T12:00:00Z' })] });
    expect(screen.getByText(/sends in/i)).toBeInTheDocument();
  });

  it('shows the RTA window close when it is the placement next deadline', () => {
    renderCard({
      placement: placement({ next_deadline_type: 'rta_window', next_deadline_at: '2999-08-05T17:00:00Z' }),
    });
    expect(screen.getByText(/closes at Aug 5/)).toBeInTheDocument();
  });

  it('omits the safety-net line when nothing is armed', () => {
    renderCard();
    expect(screen.queryByTestId('now-safety')).not.toBeInTheDocument();
  });
});

describe('PlacementNowCard - terminal stages', () => {
  it('renders a completed summary and NO Advance button at moved_in', () => {
    renderCard({ placement: placement({ stage: 'moved_in' }), nextStageLabel: undefined, onAdvance: undefined });
    expect(screen.getByText(/the tenant has moved in/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Advance/ })).not.toBeInTheDocument();
  });

  it('renders a lost summary and NO Advance button at lost', () => {
    renderCard({ placement: placement({ stage: 'lost' }), nextStageLabel: undefined, onAdvance: undefined });
    expect(screen.getByText(/This placement was lost/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Advance/ })).not.toBeInTheDocument();
  });
});
