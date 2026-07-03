import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PlacementItem, PlacementUpdatedEvent, EventStreamHandlers, HistoryRow, UnitItem } from '../../api/index.js';

const getPlacement = vi.fn();
const getUnit = vi.fn();
const getContact = vi.fn();
const transitionPlacement = vi.fn();
const updatePlacement = vi.fn();
const getPlacementHistory = vi.fn();
// Capture the SSE handlers the page (and its History panel) register so a test
// can fire a placement.updated event.
let streamHandlers: EventStreamHandlers[] = [];

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getPlacement: (...a: unknown[]) => getPlacement(...a),
    getUnit: (...a: unknown[]) => getUnit(...a),
    getContact: (...a: unknown[]) => getContact(...a),
    transitionPlacement: (...a: unknown[]) => transitionPlacement(...a),
    updatePlacement: (...a: unknown[]) => updatePlacement(...a),
    getPlacementHistory: (...a: unknown[]) => getPlacementHistory(...a),
    useEventStream: (h: EventStreamHandlers) => {
      streamHandlers.push(h);
    },
  };
});

import { PlacementDetail } from './PlacementDetail.js';

const CASE: PlacementItem = {
  placementId: 'c1',
  tenantId: 't1',
  unitId: 'u1',
  stage: 'awaiting_inspection',
  stage_entered_at: '2026-06-18T13:02:00Z',
};

const UNIT: UnitItem = {
  unitId: 'u1',
  landlordId: 'l1',
  status: 'under_application',
  address: { line1: '12 Oak St' },
  final_rent: 1550,
};

function row(over: Partial<HistoryRow>): HistoryRow {
  return { entityKey: 'placement#c1', event_type: 'stage_changed', ts: '2026-06-18T13:02:00Z', ...over };
}

function renderAt(): void {
  render(
    <MemoryRouter initialEntries={['/placements/c1']}>
      <Routes>
        <Route path="/placements/:placementId" element={<PlacementDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getPlacement.mockReset().mockResolvedValue(CASE);
  getUnit.mockReset().mockResolvedValue(UNIT);
  getContact
    .mockReset()
    .mockResolvedValue({ contactId: 't1', type: 'tenant', firstName: 'Tasha', lastName: 'Nguyen' });
  transitionPlacement.mockReset();
  updatePlacement.mockReset();
  getPlacementHistory.mockReset().mockResolvedValue([]);
  streamHandlers = [];
});
afterEach(() => vi.restoreAllMocks());

/** Fire a placement.updated event at each DISTINCT subscriber the page registered.
 *  The mock collects a handlers object per render; onPlacementUpdated is a stable
 *  useCallback per consumer, so dedupe by its identity to fire each consumer
 *  (the page + its History panel) exactly once — as the real provider would. */
function emitCaseUpdated(over: Partial<PlacementUpdatedEvent> & { placementId: string }): void {
  const ev: PlacementUpdatedEvent = {
    tenantId: 't1',
    unitId: 'u1',
    stage: 'awaiting_inspection',
    tour_date: null,
    next_deadline_type: null,
    next_deadline_at: null,
    group_thread: null,
    attention: false,
    lost_reason: null,
    updated_at: null,
    ...over,
  };
  const seen = new Set<NonNullable<EventStreamHandlers['onPlacementUpdated']>>();
  for (const h of streamHandlers) {
    if (h.onPlacementUpdated && !seen.has(h.onPlacementUpdated)) {
      seen.add(h.onPlacementUpdated);
      h.onPlacementUpdated(ev);
    }
  }
}

describe('PlacementDetail', () => {
  it('renders the stage, phase, links, time-in-stage, inspection + final rent', async () => {
    getPlacement.mockResolvedValue({ ...CASE, inspection_outcome: 'pass' });
    renderAt();
    const heading = await screen.findByRole('heading', { name: /Awaiting inspection/ });
    // The phase chip "Inspection" lives inside the heading.
    expect(within(heading).getByText('Inspection')).toBeInTheDocument();
    // M4: the Tenant link shows the contact NAME, not the raw id.
    expect(screen.getByRole('link', { name: 'Tasha Nguyen' })).toHaveAttribute('href', '/contacts/t1');
    expect(screen.getByRole('link', { name: '12 Oak St' })).toHaveAttribute('href', '/listings/u1');
    expect(screen.getByText('Pass')).toBeInTheDocument();
    expect(screen.getByText('$1,550/mo')).toBeInTheDocument();
  });

  it('M4: degrades the Tenant link to the raw id when the contact cannot be loaded', async () => {
    getContact.mockRejectedValue(new Error('not found'));
    renderAt();
    await screen.findByRole('heading', { name: /Awaiting inspection/ });
    expect(screen.getByRole('link', { name: 't1' })).toHaveAttribute('href', '/contacts/t1');
  });

  it('renders history rows newest-first and loads more with the before cursor', async () => {
    const first = Array.from({ length: 20 }, (_, i) =>
      row({
        event_type: 'placement_stage_changed',
        ts: `2026-06-18T13:${String(20 - i).padStart(2, '0')}:00Z`,
        payload: { from: 'collect_rta', to: i === 0 ? 'review_rta' : `stage-${i}`, source: 'manual' },
      }),
    );
    getPlacementHistory.mockResolvedValueOnce(first);
    getPlacementHistory.mockResolvedValueOnce([
      row({
        event_type: 'placement_stage_changed',
        ts: '2026-06-10T00:00:00Z',
        payload: { from: 'send_application', to: 'collect_rta', source: 'import' },
      }),
    ]);
    renderAt();

    // Stages are LABELED via STAGE_LABELS, not shown as raw snake_case.
    await waitFor(() => expect(screen.getByText(/Collect RTA → Review RTA/)).toBeInTheDocument());
    const loadMore = screen.getByRole('button', { name: 'Load more' });
    const user = userEvent.setup();
    await user.click(loadMore);

    await waitFor(() => expect(screen.getByText(/Send application → Collect RTA/)).toBeInTheDocument());
    // The second call passed the before cursor = the oldest loaded row's ts.
    expect(getPlacementHistory).toHaveBeenLastCalledWith(
      'c1',
      expect.objectContaining({ before: first[first.length - 1]!.ts }),
      expect.anything(),
    );
  });

  it('a move out of awaiting_inspection prompts for the outcome before transitioning', async () => {
    const user = userEvent.setup();
    transitionPlacement.mockResolvedValue({ ...CASE, stage: 'determine_rent' });
    renderAt();
    await waitFor(() => expect(screen.getByRole('heading', { name: /Awaiting inspection/ })).toBeInTheDocument());

    await user.selectOptions(screen.getByRole('combobox', { name: 'Move to stage' }), 'determine_rent');
    expect(screen.getByRole('heading', { name: 'Record inspection outcome' })).toBeInTheDocument();
    expect(transitionPlacement).not.toHaveBeenCalled();

    await user.click(screen.getByRole('radio', { name: 'Fail' }));
    await user.click(screen.getByRole('button', { name: 'Confirm move' }));
    await waitFor(() =>
      expect(transitionPlacement).toHaveBeenCalledWith('c1', {
        toStage: 'determine_rent',
        source: 'manual',
        inspectionOutcome: 'fail',
      }),
    );
  });

  it('the finalRent prompt rejects ≤0', async () => {
    const user = userEvent.setup();
    getPlacement.mockResolvedValue({ ...CASE, stage: 'awaiting_rent_acceptance' });
    renderAt();
    await waitFor(() => expect(screen.getByRole('heading', { name: /Awaiting rent acceptance/ })).toBeInTheDocument());

    await user.selectOptions(screen.getByRole('combobox', { name: 'Move to stage' }), 'awaiting_hap_contract');
    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByLabelText(/Final contract rent/i);
    await user.type(input, '0');
    expect(within(dialog).getByRole('button', { name: 'Confirm move' })).toBeDisabled();
    expect(transitionPlacement).not.toHaveBeenCalled();
  });

  it('the move into awaiting_inspection prompts for the inspection date, forwarding it', async () => {
    const user = userEvent.setup();
    getPlacement.mockResolvedValue({ ...CASE, stage: 'schedule_inspection' });
    transitionPlacement.mockResolvedValue({ ...CASE, stage: 'awaiting_inspection' });
    renderAt();
    await waitFor(() => expect(screen.getByRole('heading', { name: /Schedule inspection/ })).toBeInTheDocument());

    await user.selectOptions(screen.getByRole('combobox', { name: 'Move to stage' }), 'awaiting_inspection');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Schedule inspection' })).toBeInTheDocument();
    expect(transitionPlacement).not.toHaveBeenCalled();

    const input = within(dialog).getByLabelText(/Inspection date/i);
    fireEvent.change(input, { target: { value: '2026-07-20' } });
    await user.click(within(dialog).getByRole('button', { name: 'Confirm move' }));
    await waitFor(() =>
      expect(transitionPlacement).toHaveBeenCalledWith('c1', {
        toStage: 'awaiting_inspection',
        source: 'manual',
        inspectionDate: '2026-07-20',
      }),
    );
  });

  it('the move into awaiting_rent_acceptance prompts for the determined rent, forwarding it', async () => {
    const user = userEvent.setup();
    getPlacement.mockResolvedValue({ ...CASE, stage: 'determine_rent' });
    transitionPlacement.mockResolvedValue({ ...CASE, stage: 'awaiting_rent_acceptance' });
    renderAt();
    await waitFor(() => expect(screen.getByRole('heading', { name: /Determine rent/ })).toBeInTheDocument());

    await user.selectOptions(screen.getByRole('combobox', { name: 'Move to stage' }), 'awaiting_rent_acceptance');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Confirm determined rent' })).toBeInTheDocument();
    expect(transitionPlacement).not.toHaveBeenCalled();

    const input = within(dialog).getByLabelText(/Determined rent/i);
    await user.type(input, '1850');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm move' }));
    await waitFor(() =>
      expect(transitionPlacement).toHaveBeenCalledWith('c1', {
        toStage: 'awaiting_rent_acceptance',
        source: 'manual',
        rentDetermined: 1850,
      }),
    );
  });

  it('live-updates the page fields when a placement.updated event for this placement arrives', async () => {
    renderAt();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Awaiting inspection/ })).toBeInTheDocument(),
    );
    expect(getPlacement).toHaveBeenCalledTimes(1);

    // Another tab/user (or our own transition) moved the placement → placement.updated.
    // The refetch returns the new stage; the page reflects it without a reload.
    getPlacement.mockResolvedValue({ ...CASE, stage: 'determine_rent' });
    await act(async () => {
      emitCaseUpdated({ placementId: 'c1', stage: 'determine_rent' });
    });

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Determine rent/ })).toBeInTheDocument(),
    );
    expect(getPlacement).toHaveBeenCalledTimes(2);
  });

  it('ignores a placement.updated event for a different placement', async () => {
    renderAt();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Awaiting inspection/ })).toBeInTheDocument(),
    );
    await act(async () => {
      emitCaseUpdated({ placementId: 'some-other-placement', stage: 'moved_in' });
    });
    // No refetch for an unrelated placement.
    expect(getPlacement).toHaveBeenCalledTimes(1);
  });

  it('renders the inspection date + determined rent rows when present', async () => {
    getPlacement.mockResolvedValue({
      ...CASE,
      inspection_date: '2026-06-20',
      rent_determined: 1450,
    });
    renderAt();
    await screen.findByRole('heading', { name: /Awaiting inspection/ });
    expect(screen.getByText('Inspection date')).toBeInTheDocument();
    expect(screen.getByText('Determined rent')).toBeInTheDocument();
    expect(screen.getByText('$1,450/mo')).toBeInTheDocument();
  });

  it('shows the paperwork checklist at complete_paperwork, with LIF only for a LIF-eligible tenant', async () => {
    getPlacement.mockResolvedValue({ ...CASE, stage: 'complete_paperwork' });
    getContact.mockResolvedValue({
      contactId: 't1',
      type: 'tenant',
      firstName: 'Tasha',
      lastName: 'Nguyen',
      lifEligible: true,
    });
    renderAt();
    await screen.findByRole('heading', { name: /Complete paperwork/ });
    expect(screen.getByRole('checkbox', { name: 'Lease signed' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Move-in details shared' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /LIF/ })).toBeInTheDocument();
  });

  it('omits the LIF checkbox when the tenant is not LIF-eligible', async () => {
    getPlacement.mockResolvedValue({ ...CASE, stage: 'complete_paperwork' });
    // tenant has no lifEligible flag (default beforeEach contact)
    renderAt();
    await screen.findByRole('heading', { name: /Complete paperwork/ });
    expect(screen.getByRole('checkbox', { name: 'Lease signed' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /LIF/ })).not.toBeInTheDocument();
  });

  it('does not render the paperwork checklist outside complete_paperwork', async () => {
    renderAt();
    await screen.findByRole('heading', { name: /Awaiting inspection/ });
    expect(screen.queryByRole('checkbox', { name: 'Lease signed' })).not.toBeInTheDocument();
  });

  it('toggling a paperwork checkbox PATCHes the placement with that field', async () => {
    const user = userEvent.setup();
    getPlacement.mockResolvedValue({ ...CASE, stage: 'complete_paperwork' });
    updatePlacement.mockResolvedValue({ ...CASE, stage: 'complete_paperwork', lease_signed: true });
    renderAt();
    await screen.findByRole('heading', { name: /Complete paperwork/ });

    await user.click(screen.getByRole('checkbox', { name: 'Lease signed' }));
    await waitFor(() => expect(updatePlacement).toHaveBeenCalledWith('c1', { lease_signed: true }));
  });

  it('the moveInReady gate confirms (with the LIF-pending note) then transitions to awaiting_move_in', async () => {
    const user = userEvent.setup();
    getPlacement.mockResolvedValue({ ...CASE, stage: 'complete_paperwork' });
    getContact.mockResolvedValue({
      contactId: 't1',
      type: 'tenant',
      firstName: 'Tasha',
      lastName: 'Nguyen',
      lifEligible: true,
    });
    transitionPlacement.mockResolvedValue({ ...CASE, stage: 'awaiting_move_in' });
    renderAt();
    await screen.findByRole('heading', { name: /Complete paperwork/ });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Move to stage' }), 'awaiting_move_in');
    expect(screen.getByRole('heading', { name: 'Confirm move-in ready' })).toBeInTheDocument();
    // LIF-eligible tenant with lif unset → the pending note shows.
    expect(screen.getByText(/LIF is not marked/i)).toBeInTheDocument();
    expect(transitionPlacement).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Confirm move' }));
    await waitFor(() =>
      expect(transitionPlacement).toHaveBeenCalledWith('c1', {
        toStage: 'awaiting_move_in',
        source: 'manual',
      }),
    );
  });
});
