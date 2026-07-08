import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PlacementItem, Contact, UnitItem } from '../../api/index.js';
import type { PlacementsState } from './usePlacements.js';

const usePlacements = vi.fn<() => PlacementsState>();
vi.mock('./usePlacements.js', () => ({ usePlacements: () => usePlacements() }));

const transitionPlacement = vi.fn();
const getContacts = vi.fn();
const getUnits = vi.fn();
const getPlacementsBy = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    transitionPlacement: (...a: unknown[]) => transitionPlacement(...a),
    getContacts: (...a: unknown[]) => getContacts(...a),
    getUnits: (...a: unknown[]) => getUnits(...a),
    getPlacementsBy: (...a: unknown[]) => getPlacementsBy(...a),
  };
});

import { PlacementsPage } from './PlacementsPage.js';

function mk(over: Partial<PlacementItem> & Pick<PlacementItem, 'placementId' | 'stage'>): PlacementItem {
  return { tenantId: 't1', unitId: 'u1', ...over } as PlacementItem;
}

function baseState(placements: PlacementItem[]): PlacementsState {
  const contacts = new Map<string, Contact>([
    ['t1', { contactId: 't1', type: 'tenant', firstName: 'Tasha', lastName: 'Nguyen', status: 'placing' } as Contact],
    ['t2', { contactId: 't2', type: 'tenant', firstName: 'Omar', lastName: 'Reyes' } as Contact],
  ]);
  const units = new Map<string, UnitItem>([
    ['u1', { unitId: 'u1', landlordId: 'l1', status: 'available', address: { line1: '12 Oak St' } } as UnitItem],
  ]);
  return { status: 'ready', placements, contacts, units, applyPlacement: vi.fn() };
}

function renderPage(initialEntry = '/placements'): void {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/placements" element={<PlacementsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  usePlacements.mockReset();
  transitionPlacement.mockReset();
  getContacts.mockReset();
  getUnits.mockReset();
  getPlacementsBy.mockReset();
  getContacts.mockResolvedValue({ contacts: [], nextCursor: null });
  getUnits.mockResolvedValue({ units: [], nextCursor: null });
  getPlacementsBy.mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe('PlacementsPage', () => {
  it('all-view: groups under phase headings; closed rows excluded; counts in the filter', () => {
    usePlacements.mockReturnValue(
      baseState([
        mk({ placementId: 'a', stage: 'send_application' }),
        mk({ placementId: 'b', stage: 'collect_rta', tenantId: 't2' }),
        mk({ placementId: 'c', stage: 'lost' }),
      ]),
    );
    renderPage();
    expect(screen.getByRole('heading', { name: 'Placements' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Application/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /RTA/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tasha Nguyen - Send application' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Inspection/ })).not.toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Placement phases' });
    expect(within(nav).getByRole('link', { name: /All active.*2/ })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /Closed.*1/ })).toBeInTheDocument();
  });

  it('phase filter via URL shows only that slice, flat (no group heading)', () => {
    usePlacements.mockReturnValue(
      baseState([
        mk({ placementId: 'a', stage: 'send_application' }),
        mk({ placementId: 'b', stage: 'collect_rta', tenantId: 't2' }),
      ]),
    );
    renderPage('/placements?phase=rta');
    expect(screen.getByRole('link', { name: 'Omar Reyes - Collect RTA' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Tasha Nguyen/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^RTA/ })).not.toBeInTheDocument();
  });

  it('closed view lists terminal placements', () => {
    usePlacements.mockReturnValue(baseState([mk({ placementId: 'c', stage: 'lost' })]));
    renderPage('/placements?view=closed');
    expect(screen.getByRole('link', { name: 'Tasha Nguyen - Lost' })).toBeInTheDocument();
  });

  it('search narrows rows within the current filter', async () => {
    const user = userEvent.setup();
    usePlacements.mockReturnValue(
      baseState([
        mk({ placementId: 'a', stage: 'send_application' }),
        mk({ placementId: 'b', stage: 'collect_rta', tenantId: 't2' }),
      ]),
    );
    renderPage();
    await user.type(screen.getByRole('searchbox', { name: 'Search placements' }), 'omar');
    expect(screen.getByRole('link', { name: /Omar Reyes/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Tasha Nguyen/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Application/ })).not.toBeInTheDocument();
  });

  it('ungated menu move fires transitionPlacement with source manual', async () => {
    const user = userEvent.setup();
    transitionPlacement.mockResolvedValue(mk({ placementId: 'a', stage: 'review_rta' }));
    usePlacements.mockReturnValue(baseState([mk({ placementId: 'a', stage: 'collect_rta' })]));
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Actions for Tasha Nguyen' }));
    await user.click(screen.getByRole('menuitem', { name: 'Review RTA' }));
    await waitFor(() =>
      expect(transitionPlacement).toHaveBeenCalledWith('a', { toStage: 'review_rta', source: 'manual' }),
    );
  });

  it('gated move (out of awaiting_inspection) opens the outcome prompt first, then transitions', async () => {
    const user = userEvent.setup();
    transitionPlacement.mockResolvedValue(mk({ placementId: 'a', stage: 'determine_rent' }));
    usePlacements.mockReturnValue(baseState([mk({ placementId: 'a', stage: 'awaiting_inspection' })]));
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Actions for Tasha Nguyen' }));
    await user.click(screen.getByRole('menuitem', { name: 'Determine rent' }));
    expect(transitionPlacement).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Record inspection outcome' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Pass' }));
    await user.click(screen.getByRole('button', { name: 'Confirm move' }));
    await waitFor(() =>
      expect(transitionPlacement).toHaveBeenCalledWith('a', {
        toStage: 'determine_rent',
        source: 'manual',
        inspectionOutcome: 'pass',
      }),
    );
  });

  it('Mark lost opens the LostReasonModal (no transition until confirmed)', async () => {
    const user = userEvent.setup();
    usePlacements.mockReturnValue(baseState([mk({ placementId: 'a', stage: 'collect_rta' })]));
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Actions for Tasha Nguyen' }));
    await user.click(screen.getByRole('menuitem', { name: 'Mark lost...' }));
    expect(screen.getByRole('heading', { name: 'Mark placement lost' })).toBeInTheDocument();
    expect(transitionPlacement).not.toHaveBeenCalled();
  });

  it('a rejected move shows the inline error and rolls back', async () => {
    const user = userEvent.setup();
    transitionPlacement.mockRejectedValue(new Error('409'));
    usePlacements.mockReturnValue(baseState([mk({ placementId: 'a', stage: 'collect_rta' })]));
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Actions for Tasha Nguyen' }));
    await user.click(screen.getByRole('menuitem', { name: 'Review RTA' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Tasha Nguyen - Collect RTA' })).toBeInTheDocument();
  });

  it('empty states: all-active empty and searched-empty messages', async () => {
    const user = userEvent.setup();
    usePlacements.mockReturnValue(baseState([mk({ placementId: 'a', stage: 'collect_rta' })]));
    renderPage();
    await user.type(screen.getByRole('searchbox', { name: 'Search placements' }), 'zzz');
    expect(screen.getByText("No matches for 'zzz'.")).toBeInTheDocument();
  });
});
