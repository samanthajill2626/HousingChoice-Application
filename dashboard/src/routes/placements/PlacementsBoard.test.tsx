import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { PlacementItem, Contact, UnitItem } from '../../api/index.js';
import type { PlacementsState } from './usePlacements.js';

// Mock the data hook so the board renders from a controlled state, and the
// transition endpoint so moves are observable. The per-card "Move to…" select
// drives requestMove (the accessible non-drag fallback — same handler the drop
// uses), which is reliable in jsdom (pointer/keyboard DnD is not).
const usePlacements = vi.fn<() => PlacementsState>();
vi.mock('./usePlacements.js', () => ({ usePlacements: () => usePlacements() }));

const transitionPlacement = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return { ...actual, transitionPlacement: (...a: unknown[]) => transitionPlacement(...a) };
});

// Capture the onDragEnd the board hands to DndContext so a test can drive the
// real DROP handler path directly (pointer/keyboard DnD is not reliable in
// jsdom). We pass synthetic active/over carrying the same `data.current` shape
// the real useDraggable (fromStage) / useDroppable (targetStage) set.
let capturedOnDragEnd: ((e: unknown) => void) | null = null;
vi.mock('@dnd-kit/core', async () => {
  const actual = await vi.importActual<typeof import('@dnd-kit/core')>('@dnd-kit/core');
  return {
    ...actual,
    DndContext: (props: { onDragEnd?: (e: unknown) => void; children?: React.ReactNode }) => {
      capturedOnDragEnd = props.onDragEnd ?? null;
      return props.children;
    },
  };
});

function fireDrop(placementId: string, fromStage: string, targetStage: string): void {
  capturedOnDragEnd?.({
    active: { id: placementId, data: { current: { fromStage } } },
    over: { id: `phase:x`, data: { current: { targetStage } } },
  });
}

import { PlacementsBoard } from './PlacementsBoard.js';

function mkPlacement(over: Partial<PlacementItem> & Pick<PlacementItem, 'placementId' | 'stage'>): PlacementItem {
  return { tenantId: 't1', unitId: 'u1', ...over } as PlacementItem;
}

function baseState(placements: PlacementItem[]): PlacementsState {
  const contacts = new Map<string, Contact>([
    ['t1', { contactId: 't1', type: 'tenant', firstName: 'Tasha', lastName: 'Nguyen', status: 'placing' }],
    ['t2', { contactId: 't2', type: 'tenant', firstName: 'Omar', lastName: 'Reyes', porting: true }],
  ]);
  const units = new Map<string, UnitItem>([
    ['u1', { unitId: 'u1', landlordId: 'l1', status: 'available', address: { line1: '12 Oak St' } }],
  ]);
  return { status: 'ready', placements, contacts, units, applyPlacement: vi.fn() };
}

function renderBoard(): void {
  render(
    <MemoryRouter>
      <PlacementsBoard />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  usePlacements.mockReset();
  transitionPlacement.mockReset();
  capturedOnDragEnd = null;
});
afterEach(() => vi.restoreAllMocks());

describe('PlacementsBoard', () => {
  it('renders a card in its phase column (tenant name + listing)', () => {
    usePlacements.mockReturnValue(baseState([mkPlacement({ placementId: 'c1', stage: 'collect_rta' })]));
    renderBoard();
    const rta = screen.getByRole('listitem', { name: 'RTA' });
    expect(within(rta).getByText('Tasha Nguyen')).toBeInTheDocument();
    expect(within(rta).getByText('12 Oak St')).toBeInTheDocument();
  });

  it('shows a porting chip when the tenant is porting', () => {
    usePlacements.mockReturnValue(
      baseState([mkPlacement({ placementId: 'c2', tenantId: 't2', stage: 'collect_rta' })]),
    );
    renderBoard();
    expect(screen.getByText('Porting')).toBeInTheDocument();
  });

  it('a move calls transitionPlacement with source:manual and the target phase first-stage', async () => {
    const user = userEvent.setup();
    transitionPlacement.mockResolvedValue(mkPlacement({ placementId: 'c1', stage: 'schedule_inspection' }));
    usePlacements.mockReturnValue(baseState([mkPlacement({ placementId: 'c1', stage: 'collect_rta' })]));
    renderBoard();

    // Move the card to the Inspection phase → its first stage is schedule_inspection.
    await user.selectOptions(screen.getByRole('combobox', { name: /Move Tasha Nguyen to phase/i }), 'Inspection');

    await waitFor(() =>
      expect(transitionPlacement).toHaveBeenCalledWith('c1', {
        toStage: 'schedule_inspection',
        source: 'manual',
      }),
    );
  });

  it('optimistically moves the card, then rolls back + shows an error on a rejected transition', async () => {
    const user = userEvent.setup();
    transitionPlacement.mockRejectedValue(new Error('rejected'));
    usePlacements.mockReturnValue(baseState([mkPlacement({ placementId: 'c1', stage: 'collect_rta' })]));
    renderBoard();

    await user.selectOptions(screen.getByRole('combobox', { name: /Move Tasha Nguyen to phase/i }), 'Inspection');

    // Error banner appears...
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/returned to its column/i));
    // ...and the card is back in the RTA column (rolled back).
    const rta = screen.getByRole('listitem', { name: 'RTA' });
    expect(within(rta).getByText('Tasha Nguyen')).toBeInTheDocument();
  });

  it('the Mark-lost action opens the Lost-reason modal (no immediate transition) and confirms with a reason', async () => {
    const user = userEvent.setup();
    transitionPlacement.mockResolvedValue(mkPlacement({ placementId: 'c1', stage: 'lost' }));
    usePlacements.mockReturnValue(baseState([mkPlacement({ placementId: 'c1', stage: 'collect_rta' })]));
    renderBoard();

    await user.click(screen.getByRole('button', { name: /Mark Tasha Nguyen's placement lost/i }));
    // The modal blocks the transition until a reason is given.
    expect(screen.getByRole('heading', { name: 'Mark placement lost' })).toBeInTheDocument();
    expect(transitionPlacement).not.toHaveBeenCalled();

    await user.click(screen.getByRole('radio', { name: 'Tenant withdrew' }));
    await user.click(screen.getByRole('button', { name: 'Mark lost' }));
    await waitFor(() =>
      expect(transitionPlacement).toHaveBeenCalledWith('c1', {
        toStage: 'lost',
        source: 'manual',
        lostReason: { category: 'tenant_withdrew' },
      }),
    );
  });

  it('a move OUT of awaiting_rent_acceptance prompts for finalRent before transitioning', async () => {
    const user = userEvent.setup();
    transitionPlacement.mockResolvedValue(mkPlacement({ placementId: 'c1', stage: 'awaiting_hap_contract' }));
    usePlacements.mockReturnValue(baseState([mkPlacement({ placementId: 'c1', stage: 'awaiting_rent_acceptance' })]));
    renderBoard();

    await user.selectOptions(screen.getByRole('combobox', { name: /Move Tasha Nguyen to phase/i }), 'Contract');
    // The prompt blocks the transition.
    expect(screen.getByRole('heading', { name: 'Confirm final rent' })).toBeInTheDocument();
    expect(transitionPlacement).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/Final contract rent/i), '1550');
    await user.click(screen.getByRole('button', { name: 'Confirm move' }));
    await waitFor(() =>
      expect(transitionPlacement).toHaveBeenCalledWith('c1', {
        toStage: 'awaiting_hap_contract',
        source: 'manual',
        finalRent: 1550,
      }),
    );
  });

  it('a move OUT of awaiting_inspection prompts for inspectionOutcome before transitioning', async () => {
    const user = userEvent.setup();
    transitionPlacement.mockResolvedValue(mkPlacement({ placementId: 'c1', stage: 'determine_rent' }));
    usePlacements.mockReturnValue(baseState([mkPlacement({ placementId: 'c1', stage: 'awaiting_inspection' })]));
    renderBoard();

    await user.selectOptions(
      screen.getByRole('combobox', { name: /Move Tasha Nguyen to phase/i }),
      'Rent Determination',
    );
    expect(screen.getByRole('heading', { name: 'Record inspection outcome' })).toBeInTheDocument();
    expect(transitionPlacement).not.toHaveBeenCalled();

    await user.click(screen.getByRole('radio', { name: 'Pass' }));
    await user.click(screen.getByRole('button', { name: 'Confirm move' }));
    await waitFor(() =>
      expect(transitionPlacement).toHaveBeenCalledWith('c1', {
        toStage: 'determine_rent',
        source: 'manual',
        inspectionOutcome: 'pass',
      }),
    );
  });

  it('M1 (DROP path): a SAME-PHASE drop is a no-op — no transition, no prompt', async () => {
    // awaiting_rent_acceptance lives in Rent Determination; dropping it onto its
    // OWN phase column (target first-stage determine_rent) must NOT transition or
    // open the finalRent prompt.
    usePlacements.mockReturnValue(baseState([mkPlacement({ placementId: 'c1', stage: 'awaiting_rent_acceptance' })]));
    renderBoard();
    act(() => fireDrop('c1', 'awaiting_rent_acceptance', 'determine_rent'));
    expect(transitionPlacement).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Confirm final rent' })).not.toBeInTheDocument();
  });

  it('M1 (DROP path): a CROSS-PHASE drop transitions to the target phase first stage', async () => {
    transitionPlacement.mockResolvedValue(mkPlacement({ placementId: 'c1', stage: 'schedule_inspection' }));
    usePlacements.mockReturnValue(baseState([mkPlacement({ placementId: 'c1', stage: 'collect_rta' })]));
    renderBoard();
    // Drop RTA card onto Inspection (first stage schedule_inspection).
    act(() => fireDrop('c1', 'collect_rta', 'schedule_inspection'));
    await waitFor(() =>
      expect(transitionPlacement).toHaveBeenCalledWith('c1', {
        toStage: 'schedule_inspection',
        source: 'manual',
      }),
    );
  });

  it('shows terminal placements in the collapsed Closed area', () => {
    usePlacements.mockReturnValue(
      baseState([
        mkPlacement({ placementId: 'c1', stage: 'collect_rta' }),
        mkPlacement({ placementId: 'cm', stage: 'moved_in' }),
      ]),
    );
    renderBoard();
    const closed = screen.getByRole('list', { name: /Closed placements/i });
    expect(within(closed).getByText(/Moved in/)).toBeInTheDocument();
  });
});
